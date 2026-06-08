import { calculateCost, createAssistantMessageEventStream, type AssistantMessage, type Context, type ExtensionAPI, type Model, type ProviderModelConfig, type SimpleStreamOptions, type TextContent } from "@octo/core-agent";
import { installSapOrchestrationFetch } from "./sap-orchestration-adapter.js";

type SAPServiceKey = {
	serviceurls?: { AI_API_URL?: string };
	url?: string;
	clientid?: string;
	clientsecret?: string;
	apiKey?: string;
	token?: string;
};

function num(v: string | undefined, fallback: number): number {
	const n = Number(v);
	return Number.isFinite(n) ? n : fallback;
}

function mkModel(id: string, name: string): ProviderModelConfig {
	return {
		id,
		name,
		reasoning: false,
		input: ["text", "image"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: num(process.env.SAP_AI_CONTEXT_WINDOW, 200000),
		maxTokens: num(process.env.SAP_AI_MAX_TOKENS, 8192),
	};
}

function parseServiceKey(raw: string | undefined): SAPServiceKey | undefined {
	if (!raw) return undefined;
	try {
		return JSON.parse(raw) as SAPServiceKey;
	} catch {
		return undefined;
	}
}

// OAuth2 token cache for service-key-based auth (clientid/clientsecret/url).
let tokenCache: { token: string; expiresAt: number } | undefined;

type DeploymentRef = { id: string; modelName: string; modelBaseName: string };

async function fetchDeployments(baseUrl: string, token: string, resourceGroup: string): Promise<DeploymentRef[]> {
	const url = `${baseUrl.replace(/\/$/, "")}/v2/lm/deployments?$top=10000&$skip=0`;
	const resp = await fetch(url, {
		method: "GET",
		headers: {
			Authorization: `Bearer ${token}`,
			"AI-Resource-Group": resourceGroup,
			"Content-Type": "application/json",
		},
	});
	if (!resp.ok) return [];
	const data = (await resp.json()) as {
		resources?: Array<{
			id?: string;
			targetStatus?: string;
			details?: { resources?: { backend_details?: { model?: { name?: string; version?: string } } } };
		}>;
	};

	return (data.resources ?? [])
		.filter((deployment) => deployment.targetStatus?.toUpperCase() === "RUNNING" && deployment.id)
		.map((deployment) => {
			const model = deployment.details?.resources?.backend_details?.model;
			const modelName = [model?.name, model?.version].filter(Boolean).join(":").toLowerCase();
			return deployment.id && modelName
				? { id: deployment.id, modelName, modelBaseName: modelBaseName(modelName) }
				: undefined;
		})
		.filter((d): d is DeploymentRef => Boolean(d));
}

function modelBaseName(modelId: string): string {
	return modelId.split(":")[0]?.trim().toLowerCase();
}

async function resolveClaudeDeploymentId(params: {
	baseUrl: string;
	resourceGroup: string;
	serviceKey: SAPServiceKey | undefined;
	apiKeyEnv: string;
	claudeModel: string;
}): Promise<string> {
	const fromEnv = process.env.SAP_AI_CLAUDE_DEPLOYMENT_ID;
	if (fromEnv) return fromEnv;

	const token = await resolveApiKey(params.serviceKey, params.apiKeyEnv);
	if (!token) return params.claudeModel;

	const deployments = await fetchDeployments(params.baseUrl, token, params.resourceGroup);
	const wanted = modelBaseName(params.claudeModel);
	const match = deployments.find((d) => d.modelBaseName === wanted)
		?? deployments.find((d) => d.modelName.includes(wanted));
	return match?.id ?? params.claudeModel;
}

async function resolveApiKey(serviceKey: SAPServiceKey | undefined, apiKeyEnv: string): Promise<string | undefined> {
	// 1. Explicit env var or legacy static fields in service key
	const staticKey =
		process.env[apiKeyEnv] ||
		serviceKey?.apiKey ||
		serviceKey?.token;
	if (staticKey) return staticKey;

	// 2. OAuth2 client credentials flow
	if (!serviceKey?.clientid || !serviceKey.clientsecret || !serviceKey.url) return undefined;
	if (tokenCache && Date.now() < tokenCache.expiresAt - 300_000) return tokenCache.token;

	const tokenUrl = `${serviceKey.url.replace(/\/$/, "")}/oauth/token`;
	try {
		const basicAuth = Buffer.from(`${serviceKey.clientid}:${serviceKey.clientsecret}`).toString("base64");
		const fetchOptions: RequestInit = {
			method: "POST",
			headers: {
				"Content-Type": "application/x-www-form-urlencoded",
				"Authorization": `Basic ${basicAuth}`,
			},
			body: "grant_type=client_credentials",
		};
		const resp = await fetch(tokenUrl, fetchOptions);
		if (!resp.ok) return undefined;
		const data = (await resp.json()) as { access_token: string; expires_in?: number };
		tokenCache = { token: data.access_token, expiresAt: Date.now() + (data.expires_in ?? 3600) * 1000 };
		process.env[apiKeyEnv] = data.access_token;
		return data.access_token;
	} catch {
		return undefined;
	}
}




function toAnthropicMessageContent(content: unknown): unknown {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return String(content ?? "");
	return content.flatMap((block): unknown[] => {
		if (!block || typeof block !== "object") return [];
		const b = block as Record<string, unknown>;
		if (b.type === "text") return [{ type: "text", text: String(b.text ?? "") }];
		if (b.type === "image") {
			return [{
				type: "image",
				source: {
					type: "base64",
					media_type: String(b.mimeType ?? "image/jpeg"),
					data: String(b.data ?? ""),
				},
			}];
		}
		return [];
	});
}

function toSapAnthropicMessages(context: Context): Array<{ role: "user" | "assistant"; content: unknown }> {
	const messages: Array<{ role: "user" | "assistant"; content: unknown }> = [];
	for (const message of context.messages) {
		if (message.role === "user" || message.role === "assistant") {
			messages.push({ role: message.role, content: toAnthropicMessageContent(message.content) });
		}
		if (message.role === "toolResult") {
			messages.push({
				role: "user",
				content: [{
					type: "tool_result",
					tool_use_id: message.toolCallId,
					content: toAnthropicMessageContent(message.content),
					is_error: message.isError,
				}],
			});
		}
	}
	return messages;
}

function parseSapSseEvents(buffer: string): { events: unknown[]; rest: string } {
	const events: unknown[] = [];
	let rest = buffer;
	let boundary = rest.indexOf("\n\n");
	while (boundary >= 0) {
		const frame = rest.slice(0, boundary);
		rest = rest.slice(boundary + 2);
		const data = frame
			.split(/\r?\n/)
			.filter((line) => line.startsWith("data: "))
			.map((line) => line.slice(6))
			.join("\n")
			.trim();
		if (data && data !== "[DONE]") {
			try {
				events.push(JSON.parse(data));
			} catch {
				// Ignore malformed partial frames; the next complete event will continue parsing.
			}
		}
		boundary = rest.indexOf("\n\n");
	}
	return { events, rest };
}

function createSapAnthropicStream(baseUrl: string, headers: Record<string, string>, apiKeyEnv: string) {
	return ((model: Model<any>, context: Context, options?: SimpleStreamOptions) => {
		const stream = createAssistantMessageEventStream();
		void (async () => {
			const output: AssistantMessage = {
				role: "assistant",
				content: [],
				api: model.api,
				provider: model.provider,
				model: model.id,
				usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
				stopReason: "stop",
				timestamp: Date.now(),
			};
			try {
				stream.push({ type: "start", partial: output });
				const apiKey = process.env[apiKeyEnv] || "";
				const reqHeaders: Record<string, string> = { ...headers, "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` };
				const payload = {
					anthropic_version: "bedrock-2023-05-31",
					max_tokens: options?.maxTokens ?? model.maxTokens,
					messages: toSapAnthropicMessages(context),
					system: context.systemPrompt,
					tools: context.tools?.map((tool: any) => ({ name: tool.name, description: tool.description, input_schema: tool.parameters })),
					stream: true,
				};
				const resp = await fetch(`${baseUrl}/invoke-with-response-stream`, { method: "POST", headers: reqHeaders, body: JSON.stringify(payload), signal: options?.signal });
				if (!resp.ok || !resp.body) throw new Error(`SAP stream failed: ${resp.status} ${await resp.text()}`);
				const reader = resp.body.getReader();
				const decoder = new TextDecoder();
				let buffer = "";
				let textIndex = -1;
				while (true) {
					const { done, value } = await reader.read();
					if (done) break;
					buffer += decoder.decode(value, { stream: true });
					const parsed = parseSapSseEvents(buffer);
					buffer = parsed.rest;
					for (const ev of parsed.events as Array<Record<string, any>>) {
						if (ev.type === "message_start") {
							output.responseId = ev.message?.id;
							output.usage.input = ev.message?.usage?.input_tokens || 0;
							output.usage.output = ev.message?.usage?.output_tokens || 0;
						}
						if (ev.type === "content_block_start" && ev.content_block?.type === "text") {
							output.content.push({ type: "text", text: "" });
							textIndex = output.content.length - 1;
							stream.push({ type: "text_start", contentIndex: textIndex, partial: output });
						}
						if (ev.type === "content_block_delta" && ev.delta?.type === "text_delta" && textIndex >= 0) {
							const block = output.content[textIndex] as TextContent;
							const delta = ev.delta.text || "";
							block.text += delta;
							stream.push({ type: "text_delta", contentIndex: textIndex, delta, partial: output });
						}
						if (ev.type === "content_block_stop" && textIndex >= 0) {
							const block = output.content[textIndex] as TextContent;
							stream.push({ type: "text_end", contentIndex: textIndex, content: block.text, partial: output });
						}
						if (ev.type === "message_delta") {
							output.usage.output = ev.usage?.output_tokens || output.usage.output;
							output.stopReason = ev.delta?.stop_reason === "tool_use" ? "toolUse" : "stop";
						}
					}
				}
				output.usage.totalTokens = output.usage.input + output.usage.output + output.usage.cacheRead + output.usage.cacheWrite;
				calculateCost(model, output.usage);
				stream.push({ type: "done", reason: output.stopReason === "toolUse" ? "toolUse" : output.stopReason === "length" ? "length" : "stop", message: output });
				stream.end(output);
			} catch (error: any) {
				output.stopReason = options?.signal?.aborted ? "aborted" : "error";
				output.errorMessage = error?.message || String(error);
				stream.push({ type: "error", reason: output.stopReason, error: output });
				stream.end(output);
			}
		})();
		return stream;
	}) as any;
}

export default async function registerSAPAICoreProviders(pi: ExtensionAPI): Promise<void> {
	const serviceKey = parseServiceKey(process.env.SAP_AI_CORE_SERVICE_KEY || process.env.AICORE_SERVICE_KEY);
	const baseUrl = process.env.SAP_AI_CORE_BASE_URL || serviceKey?.serviceurls?.AI_API_URL;
	if (!baseUrl) return;

	const resourceGroup = process.env.SAP_AI_RESOURCE_GROUP || "default";
	const headers: Record<string, string> = { "AI-Resource-Group": resourceGroup };


	const apiKeyEnv = process.env.SAP_AI_CORE_API_KEY_ENV || "SAP_AI_CORE_API_KEY";
	// Resolve and cache token before registering providers (sets process.env[apiKeyEnv]).
	await resolveApiKey(serviceKey, apiKeyEnv);

	const openAIModel = process.env.SAP_AI_OPENAI_MODEL || "gpt-4.1";
	pi.registerProvider("sap-openai", {
		baseUrl,
		headers,
		apiKey: apiKeyEnv,
		api: "openai-completions",
		models: [mkModel(openAIModel, `SAP AI Core OpenAI (${openAIModel})`)],
	});

	const claudeModel = process.env.SAP_AI_CLAUDE_MODEL || "claude-sonnet-4-5";
	const claudeDeploymentId = await resolveClaudeDeploymentId({
		baseUrl,
		resourceGroup,
		serviceKey,
		apiKeyEnv,
		claudeModel,
	});
	const claudeBaseUrl = `${baseUrl.replace(/\/$/, "")}/v2/inference/deployments/${claudeDeploymentId}`;
	installSapOrchestrationFetch({
		sapBaseUrl: claudeBaseUrl,
		resourceGroup,
	});
	pi.registerProvider("sap-claude", {
		baseUrl: claudeBaseUrl,
		headers,
		apiKey: apiKeyEnv,
		api: "anthropic-messages",
		authHeader: true,
		models: [mkModel(claudeModel, `SAP AI Core Claude (${claudeModel})`)],
		streamSimple: createSapAnthropicStream(claudeBaseUrl, headers, apiKeyEnv),
	});
}
