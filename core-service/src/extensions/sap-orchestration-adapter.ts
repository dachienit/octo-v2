/**
 * SAP AI Core adapter.
 *
 * Installs a globalThis.fetch interceptor that catches earendil's Anthropic SDK
 * requests and rewrites them for SAP AI Core:
 *
 *   Anthropic SDK sends:  POST {baseUrl}/v1/messages
 *   SAP AI Core expects:  POST {baseUrl}/invoke
 *
 * The body stays in Anthropic format but is sanitised:
 *   - tools[].custom is stripped (SAP rejects unknown fields like eager_input_streaming)
 *   - anthropic_version is injected if absent
 *   - model field is removed (model is encoded in the deployment URL)
 *
 * Auth is replaced: the Anthropic SDK's x-api-key header is removed and a proper
 * Bearer token (fetched via OAuth2 client credentials) is injected.
 *
 * The interceptor only fires for requests whose URL contains the SAP AI Core
 * hostname AND the /v1/messages path that the Anthropic SDK hardcodes.
 */

export interface SapOrchestrationAdapterConfig {
	/** Full SAP AI Core deployment base URL. */
	sapBaseUrl: string;
	/** Resource group, default "default". */
	resourceGroup: string;
}

// ---------------------------------------------------------------------------
// OAuth2 token cache (module-level, survives across requests)
// ---------------------------------------------------------------------------

interface ServiceKey {
	clientid?: string;
	clientsecret?: string;
	url?: string;
}

let tokenCache: { token: string; expiresAt: number } | undefined;

async function resolveToken(fetchFn: typeof fetch): Promise<string> {
	if (tokenCache && Date.now() < tokenCache.expiresAt - 300_000) {
		return tokenCache.token;
	}

	const serviceKeyRaw =
		process.env.AICORE_SERVICE_KEY || process.env.SAP_AI_CORE_SERVICE_KEY;
	if (!serviceKeyRaw) {
		throw new Error(
			"AICORE_SERVICE_KEY or SAP_AI_CORE_SERVICE_KEY environment variable must be set",
		);
	}

	const sk: ServiceKey = JSON.parse(serviceKeyRaw);
	if (!sk.clientid || !sk.clientsecret || !sk.url) {
		throw new Error("Service key must contain clientid, clientsecret, and url");
	}

	const tokenUrl = `${sk.url.replace(/\/$/, "")}/oauth/token`;
	const basicAuth = Buffer.from(`${sk.clientid}:${sk.clientsecret}`).toString("base64");

	// Prefer SAP AI SDK HTTP stack when available; fallback to fetch.
	const resp = await fetchFn(tokenUrl, {
		method: "POST",
		headers: {
			"Content-Type": "application/x-www-form-urlencoded",
			Authorization: `Basic ${basicAuth}`,
		},
		body: "grant_type=client_credentials",
	});


	if (!resp.ok) {
		throw new Error(`SAP OAuth2 token fetch failed: ${resp.status} ${resp.statusText}`);
	}

	const data = (await resp.json()) as { access_token: string; expires_in?: number };
	tokenCache = {
		token: data.access_token,
		expiresAt: Date.now() + (data.expires_in ?? 3600) * 1000,
	};
	return tokenCache.token;
}

// ---------------------------------------------------------------------------
// Body sanitisation
// ---------------------------------------------------------------------------

async function decodeBody(body: unknown): Promise<string | undefined> {
	// Use new Response(body).text() — the runtime normalises every valid fetch body type
	// (string, Uint8Array, ArrayBuffer, ReadableStream, Blob, FormData) for us.
	try {
		return await new Response(body as Parameters<typeof fetch>[1] extends { body?: infer B } ? B : never).text();
	} catch (e) {
		console.error("[SAP orch] decodeBody failed:", Object.prototype.toString.call(body), e);
		return undefined;
	}
}

/** Recursively remove every occurrence of a key from an arbitrary JSON value. */
function deepDelete(value: unknown, key: string): unknown {
	if (Array.isArray(value)) return value.map((item) => deepDelete(item, key));
	if (value !== null && typeof value === "object") {
		return Object.fromEntries(
			Object.entries(value as Record<string, unknown>)
				.filter(([k]) => k !== key)
				.map(([k, v]) => [k, deepDelete(v, key)]),
		);
	}
	return value;
}

function sanitiseBody(rawBody: string): string {
	let parsed: Record<string, unknown>;
	try {
		parsed = JSON.parse(rawBody);
	} catch {
		return rawBody;
	}

	// SAP /invoke rejects `stream` in request body. We remove it and, when the
	// client originally requested streaming, synthesize Anthropic-style SSE from
	// the JSON invoke response before returning to the SDK.
	const requestedStream = parsed.stream === true;
	delete parsed.stream;
	parsed.__sap_requested_stream = requestedStream;
	// Model is encoded in the deployment URL; remove it from the body to avoid conflicts.
	delete parsed.model;

	// SAP expects anthropic_version in the body (Bedrock-style); inject if missing.
	if (!parsed.anthropic_version) {
		parsed.anthropic_version = "bedrock-2023-05-31";
	}

	// Bedrock's schema only allows name/description/input_schema on tool objects.
	// The Anthropic SDK injects extra fields (eager_input_streaming, custom, cache_control,
	// type for built-in tools, etc.) that SAP rejects as "Extra inputs are not permitted".
	// Keep only the three fields Bedrock defines for each top-level tool.
	if (Array.isArray(parsed.tools)) {
		parsed.tools = (parsed.tools as Record<string, unknown>[]).map((tool) => ({
			name: tool.name,
			...(tool.description !== undefined && { description: tool.description }),
			input_schema: tool.input_schema,
		}));
	}

	// Belt-and-suspenders: recursively remove eager_input_streaming from the entire body
	// in case it appears inside message content blocks or other nested structures.
	parsed = deepDelete(parsed, "eager_input_streaming") as Record<string, unknown>;

	return JSON.stringify(parsed);
}



function mapAnthropicToBedrockConverse(parsed: Record<string, unknown>): Record<string, unknown> {
	const messages = Array.isArray(parsed.messages) ? parsed.messages as Array<Record<string, unknown>> : [];
	const outMessages = messages.map((m) => ({
		role: m.role === "assistant" ? "assistant" : "user",
		content: Array.isArray(m.content)
			? (m.content as Array<any>).map((c) => {
				if (c?.type === "text") return { text: String(c.text ?? "") };
				if (c?.type === "tool_use") return { toolUse: { toolUseId: String(c.id ?? ""), name: String(c.name ?? "tool"), input: c.input ?? {} } };
				if (c?.type === "tool_result") return { toolResult: { toolUseId: String(c.tool_use_id ?? ""), content: [{ text: typeof c.content === "string" ? c.content : JSON.stringify(c.content ?? {}) }] } };
				return typeof c?.text === "string" ? { text: c.text } : { text: String(c ?? "") };
			})
			: [{ text: String(m.content ?? "") }],
	}));
	return {
		messages: outMessages,
		inferenceConfig: { maxTokens: parsed.max_tokens ?? 4096, temperature: parsed.temperature ?? 0.7, topP: parsed.top_p ?? 1 },
	};
}

async function trySapOrchestrationWithBedrock(
	bodyObj: Record<string, unknown>,
	resourceGroup: string,
): Promise<Record<string, unknown> | undefined> {
	try {
		const aws = await import("@aws-sdk/client-bedrock-runtime");
		const client = new aws.BedrockRuntimeClient({ region: process.env.AWS_REGION || "us-east-1" });
		const modelId = (process.env.SAP_AI_BEDROCK_MODEL_ID || bodyObj.model || "").toString();
		if (!modelId) return undefined;
		const cmd = new aws.ConverseCommand({ modelId, ...mapAnthropicToBedrockConverse(bodyObj) });
		const result = await client.send(cmd);
		const txt = result.output?.message?.content?.map((c: any) => c.text).filter(Boolean).join("\n") || "";
		return { message: { role: "assistant", content: [{ type: "text", text: txt }], stop_reason: "end_turn", usage: result.usage || {} } };
	} catch {
		return undefined;
	}
}
interface BedrockMessageContentText { type: "text"; text: string }
interface BedrockMessageContentToolUse { type: "tool_use"; id?: string; name?: string; input?: unknown }

function sseEvent(type: string, obj: unknown): string {
	return `event: ${type}\ndata: ${JSON.stringify(obj)}\n\n`;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === "object" ? (value as Record<string, unknown>) : undefined;
}

function parseToolInput(input: unknown): unknown {
	if (typeof input !== "string") return input ?? {};
	try {
		return JSON.parse(input);
	} catch {
		return { raw: input };
	}
}

function resolveInvokeMessage(payload: Record<string, unknown>): Record<string, unknown> {
	const message = asRecord(payload.message);
	if (message) return message;

	const output = asRecord(payload.output);
	const outputMessage = asRecord(output?.message);
	if (outputMessage) return outputMessage;

	const result = asRecord(payload.result);
	const resultMessage = asRecord(result?.message);
	if (resultMessage) return resultMessage;

	return payload;
}


function normalizeToAnthropicContentBlock(block: unknown): BedrockMessageContentText | BedrockMessageContentToolUse | undefined {
	if (!block || typeof block !== "object") return undefined;
	const b = block as Record<string, unknown>;
	if (typeof b.type === "string") {
		if (b.type === "text") return { type: "text", text: String((b as any).text ?? "") };
		if (b.type === "tool_use") return { type: "tool_use", id: typeof b.id === "string" ? b.id : undefined, name: typeof b.name === "string" ? b.name : undefined, input: (b as any).input ?? {} };
	}
	if (typeof b.text === "string") return { type: "text", text: b.text };
	const toolUse = asRecord((b as any).toolUse);
	if (toolUse) {
		return {
			type: "tool_use",
			id: typeof toolUse.toolUseId === "string" ? toolUse.toolUseId : undefined,
			name: typeof toolUse.name === "string" ? toolUse.name : undefined,
			input: toolUse.input ?? {},
		};
	}
	return undefined;
}
function synthesizeAnthropicSseFromInvoke(payload: Record<string, unknown>): string {
	const message = resolveInvokeMessage(payload);
	const model = typeof message.model === "string" ? message.model : (typeof payload.model === "string" ? payload.model : "");
	const role = "assistant";
	const rawContent = Array.isArray(message.content) ? message.content : [];
	const content = rawContent.map((b) => normalizeToAnthropicContentBlock(b)).filter(Boolean) as Array<BedrockMessageContentText | BedrockMessageContentToolUse>;
	const usage = asRecord(message.usage) ?? asRecord(payload.usage) ?? asRecord(asRecord(payload.output)?.usage) ?? {};
	const stopReason = typeof message.stop_reason === "string"
		? message.stop_reason
		: (typeof payload.stop_reason === "string" ? payload.stop_reason : "end_turn");

	const events: string[] = [];
	events.push(sseEvent("message_start", {
		type: "message_start",
		message: {
			id: `msg_sap_${Date.now()}`,
			type: "message",
			role,
			model,
			content: [],
			stop_reason: null,
			stop_sequence: null,
			usage: {
				input_tokens: Number(usage.input_tokens ?? usage.inputTokens ?? 0),
				output_tokens: Number(usage.output_tokens ?? usage.outputTokens ?? 0),
			},
		},
	}));

	let outIndex = 0;
	for (const block of content) {
		if (!block || typeof block !== "object" || !("type" in block)) continue;
		if (block.type === "text") {
			const txt = String(block.text ?? "");
			events.push(sseEvent("content_block_start", { type: "content_block_start", index: outIndex, content_block: { type: "text", text: "" } }));
			if (txt.length > 0) {
				events.push(sseEvent("content_block_delta", { type: "content_block_delta", index: outIndex, delta: { type: "text_delta", text: txt } }));
			}
			events.push(sseEvent("content_block_stop", { type: "content_block_stop", index: outIndex }));
			outIndex += 1;
		} else if (block.type === "tool_use") {
			const safeId = typeof block.id === "string" && block.id.length > 0 ? block.id : `toolu_sap_${Date.now()}_${outIndex}`;
			const safeName = typeof block.name === "string" && block.name.length > 0 ? block.name : "tool";
			const safeInput = parseToolInput(block.input ?? {});
			events.push(sseEvent("content_block_start", { type: "content_block_start", index: outIndex, content_block: { type: "tool_use", id: safeId, name: safeName, input: safeInput } }));
			events.push(sseEvent("content_block_stop", { type: "content_block_stop", index: outIndex }));
			outIndex += 1;
		}
	}

	events.push(sseEvent("message_delta", { type: "message_delta", delta: { stop_reason: stopReason, stop_sequence: null }, usage: { output_tokens: Number(usage.output_tokens ?? usage.outputTokens ?? 0) } }));
	events.push(sseEvent("message_stop", { type: "message_stop" }));
	events.push("data: [DONE]\n\n");

	return events.join("");
}

// ---------------------------------------------------------------------------
// Install interceptor
// ---------------------------------------------------------------------------

const installedHosts = new Set<string>();

export function installSapOrchestrationFetch(cfg: SapOrchestrationAdapterConfig): void {
	const sapHost = new URL(cfg.sapBaseUrl).host;
	if (installedHosts.has(sapHost)) return;
	installedHosts.add(sapHost);

	const origFetch = globalThis.fetch;

	(globalThis as any).fetch = async function (
		input: string | Request | URL,
		init?: RequestInit,
	): Promise<Response> {
		const url: string | undefined =
			typeof input === "string"
				? input
				: input instanceof URL
					? input.href
					: (input as any)?.url;

		if (!url?.includes(sapHost) || !url?.includes("/v1/messages")) {
			return origFetch.call(globalThis, input as any, init);
		}

		try {
			const token = await resolveToken(origFetch);

			// Rewrite /v1/messages → /invoke
			const sapUrl = url.replace("/v1/messages", "/invoke");
			console.error("[SAP orch] intercepted →", sapUrl);

			// Build headers: drop x-api-key / Authorization sentinel, inject real auth
			const incomingHeaders = new Headers((init?.headers as Record<string, string> | undefined) ?? {});
			incomingHeaders.delete("x-api-key");
			incomingHeaders.set("Authorization", `Bearer ${token}`);
			incomingHeaders.set("AI-Resource-Group", cfg.resourceGroup);

			const rawBody = init?.body != null ? await decodeBody(init.body) : undefined;
			console.error("[SAP orch] body decoded:", rawBody != null ? `${rawBody.length} chars, hasEIS=${rawBody.includes('"eager_input_streaming"')}` : "null");
			const sanitised = rawBody != null ? sanitiseBody(rawBody) : undefined;
			console.error("[SAP orch] body sanitised:", sanitised != null ? `${sanitised.length} chars, hasEIS=${sanitised.includes('"eager_input_streaming"')}` : "skipped");
			const body = sanitised ?? init?.body;
			const bodyObj = sanitised ? JSON.parse(sanitised) as Record<string, unknown> : undefined;
			const headerWantsSse = (incomingHeaders.get("accept") || "").toLowerCase().includes("text/event-stream");
			const requestedStream = (bodyObj?.__sap_requested_stream === true) || headerWantsSse;
			console.error("[SAP orch] stream requested:", requestedStream, `(body=${bodyObj?.__sap_requested_stream === true}, acceptSSE=${headerWantsSse})`);
			if (bodyObj && "__sap_requested_stream" in bodyObj) {
				delete bodyObj.__sap_requested_stream;
			}

			const bedrockPayload = bodyObj ? await trySapOrchestrationWithBedrock(bodyObj, cfg.resourceGroup) : undefined;
			if (bedrockPayload) {
				if (requestedStream) {
					const sse = synthesizeAnthropicSseFromInvoke(bedrockPayload);
					return new Response(sse, { status: 200, headers: { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" } });
				}
				return new Response(JSON.stringify(bedrockPayload), { status: 200, headers: { "content-type": "application/json" } });
			}

			const resp = await origFetch(sapUrl, {
				method: init?.method ?? "POST",
				headers: incomingHeaders,
				body: bodyObj ? JSON.stringify(bodyObj) : body,
				signal: init?.signal,
			});
			console.error("[SAP orch] response:", resp.status, resp.statusText);
			
			if (requestedStream && resp.ok) {
				const payload = await resp.clone().json() as Record<string, unknown>;
				const sse = synthesizeAnthropicSseFromInvoke(payload);
				return new Response(sse, {
					status: resp.status,
					statusText: resp.statusText,
					headers: {
						"content-type": "text/event-stream",
						"cache-control": "no-cache",
						connection: "keep-alive",
					},
				});
			}

			if (!resp.ok) {
				const errText = await resp.clone().text();
				console.error("[SAP orch] response body:", errText.slice(0, 500));
			}
			return resp;
		} catch (err) {
			console.error("[SAP orch] Error:", err instanceof Error ? err.message : String(err));
			throw err;
		}
	};
}
