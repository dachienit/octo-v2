import { Agent, type AgentEvent } from "@earendil-works/pi-agent-core";
import { getModel, getModels, type ImageContent } from "@earendil-works/pi-ai";
import {
	AgentSession,
	AuthStorage,
	convertToLlm,
	DefaultResourceLoader,
	formatSkillsForPrompt,
	getAgentDir,
	loadSkillsFromDir,
	ModelRegistry,
	SessionManager,
	type Skill,
} from "@earendil-works/pi-coding-agent";
import { existsSync, mkdirSync, readFileSync } from "fs";
import { mkdir, writeFile } from "fs/promises";
import { homedir } from "os";
import { dirname, isAbsolute, join, relative } from "path";
import { createAcpOrchestratorExtension } from "./extensions/acp-orchestrator.js";
import { createExecutor, type Executor } from "./sandbox.js";
import { AgentSettingsManager } from "./settings.js";
import { createPrimitiveTools } from "./tools/index.js";
import type { CoreAgentEventHandlers, CoreAgentOptions, CoreAgentRunInput, CoreAgentRunResult } from "./types.js";

export { formatSkillsForPrompt };

// Model configuration via environment variables:
//   LLM_PROVIDER  — provider name (default: "openai"; use "openai-codex" for ChatGPT Codex OAuth)
//   LLM_MODEL     — model id     (default: "gpt-4o-mini"; for openai-codex, first built-in Codex model)
//   LLM_BASE_URL  — custom API base URL
//   LLM_API_KEY   — API key (alternative to ~/.pi/mom/auth.json)
//   LLM_API_TYPE  — API type override
//   LLM_AUTH_FILE — auth JSON path override (default: ~/.pi/agent/auth.json for openai-codex, else ~/.pi/mom/auth.json)
//
// SAP AI Core (when LLM_PROVIDER=sap-claude or sap-openai):
//   AICORE_SERVICE_KEY or SAP_AI_CORE_SERVICE_KEY  — SAP service key JSON (clientid/clientsecret/url)
//   SAP_AI_CORE_BASE_URL                           — base URL override (falls back to serviceurls.AI_API_URL)
//   SAP_AI_CLAUDE_DEPLOYMENT_ID                    — Claude deployment ID in SAP AI Core
//   SAP_AI_RESOURCE_GROUP                          — resource group (default: "default")
//
// SAP provider transport/auth is handled by the extension provider registration.
const llmProvider = process.env.LLM_PROVIDER || "openai";

function getDefaultModelId(provider: string): string {
	if (provider === "openai-codex") {
		return getModels(provider)[0]?.id ?? "gpt-5.4";
	}
	return "gpt-4o-mini";
}

function getDefaultApiType(provider: string): string {
	if (provider === "openai-codex") return "openai-codex-responses";
	if (provider === "openai") return "openai-responses"; //IYH1HC add
	if (provider === "google") return "google-generative-ai"; //IYH1HC add
	return "anthropic-messages";
}

function getDefaultAuthFilePath(): string {
	if (process.env.LLM_AUTH_FILE) return process.env.LLM_AUTH_FILE;
	if (llmProvider === "openai-codex") return join(homedir(), ".pi", "agent", "auth.json");
	return join(homedir(), ".pi", "mom", "auth.json");
}

const llmModelId = process.env.LLM_MODEL || getDefaultModelId(llmProvider);
const defaultAuthFilePath = getDefaultAuthFilePath();

// Keep sap-* as first-class custom providers from extension registry.
const baseProvider = llmProvider;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const _rawModel = (getModel as (p: string, m: string) => ReturnType<typeof getModel> | undefined)(baseProvider, llmModelId);
// getModel returns undefined for unrecognised model IDs; build a minimal stub.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const model: ReturnType<typeof getModel> = _rawModel ?? ({
	id: llmModelId,
	name: llmModelId,
	provider: baseProvider,
	baseUrl: "",
	api: getDefaultApiType(llmProvider),
	input: ["text", "image"],
	contextWindow: 200000,
	maxTokens: 8192,
} as any);
if (process.env.LLM_BASE_URL) {
	model.baseUrl = process.env.LLM_BASE_URL;
}
if (process.env.LLM_API_TYPE) {
	(model as any).api = process.env.LLM_API_TYPE;
}

if (llmProvider.startsWith("sap-")) {
	const serviceKeyRaw = process.env.SAP_AI_CORE_SERVICE_KEY || process.env.AICORE_SERVICE_KEY;
	let sapServiceKey: { serviceurls?: { AI_API_URL?: string } } | undefined;
	try {
		if (serviceKeyRaw) sapServiceKey = JSON.parse(serviceKeyRaw);
	} catch { /* ignore malformed JSON */ }

	const sapBaseUrl = process.env.SAP_AI_CORE_BASE_URL || sapServiceKey?.serviceurls?.AI_API_URL;

	if (sapBaseUrl && !process.env.LLM_BASE_URL) {
		const deploymentId = process.env.SAP_AI_CLAUDE_DEPLOYMENT_ID;
		const base = sapBaseUrl.replace(/\/$/, "");
		model.baseUrl = deploymentId
			? `${base}/v2/inference/deployments/${deploymentId}`
			: base;
	}
	if (!process.env.LLM_API_TYPE) {
		(model as any).api = "anthropic-messages";
	}
	const resourceGroup = process.env.SAP_AI_RESOURCE_GROUP || "default";
	const existingHeaders = ((model as any).headers ?? {}) as Record<string, string>;
	(model as any).headers = {
		...existingHeaders,
		"AI-Resource-Group": existingHeaders["AI-Resource-Group"] ?? resourceGroup,
		"ai-resource-group": existingHeaders["ai-resource-group"] ?? resourceGroup,
	};
}


const IMAGE_MIME_TYPES: Record<string, string> = {
	jpg: "image/jpeg",
	jpeg: "image/jpeg",
	png: "image/png",
	gif: "image/gif",
	webp: "image/webp",
};

function getImageMimeType(filename: string): string | undefined {
	return IMAGE_MIME_TYPES[filename.toLowerCase().split(".").pop() || ""];
}

/**
 * Load global and channel-specific memory from MEMORY.md files.
 */
export function getMemory(channelDir: string): string {
	const parts: string[] = [];

	const workspaceMemoryPath = join(channelDir, "..", "..", "MEMORY.md");
	if (existsSync(workspaceMemoryPath)) {
		try {
			const content = readFileSync(workspaceMemoryPath, "utf-8").trim();
			if (content) parts.push(`### Global Workspace Memory\n${content}`);
		} catch {
			// Ignore read errors
		}
	}

	const channelMemoryPath = join(channelDir, "MEMORY.md");
	if (existsSync(channelMemoryPath)) {
		try {
			const content = readFileSync(channelMemoryPath, "utf-8").trim();
			if (content) parts.push(`### Channel-Specific Memory\n${content}`);
		} catch {
			// Ignore read errors
		}
	}

	return parts.length === 0 ? "(no working memory yet)" : parts.join("\n\n");
}

/**
 * Load workspace-level and channel-specific skills, translating paths for the executor.
 * Channel skills override workspace skills on name collision.
 */
export function loadSkills(channelDir: string, workspacePath: string): Skill[] {
	const skillMap = new Map<string, Skill>();
	const hostWorkspacePath = join(channelDir, "..", "..");

	const translatePath = (hostPath: string): string => {
		if (hostPath.startsWith(hostWorkspacePath)) {
			return workspacePath + hostPath.slice(hostWorkspacePath.length);
		}
		return hostPath;
	};

	const workspaceSkillsDir = join(hostWorkspacePath, "skills");
	for (const skill of loadSkillsFromDir({ dir: workspaceSkillsDir, source: "workspace" }).skills) {
		skill.filePath = translatePath(skill.filePath);
		skill.baseDir = translatePath(skill.baseDir);
		skillMap.set(skill.name, skill);
	}

	const channelSkillsDir = join(channelDir, "skills");
	for (const skill of loadSkillsFromDir({ dir: channelSkillsDir, source: "channel" }).skills) {
		skill.filePath = translatePath(skill.filePath);
		skill.baseDir = translatePath(skill.baseDir);
		skillMap.set(skill.name, skill);
	}

	return Array.from(skillMap.values());
}

function extractToolResultText(result: unknown): string {
	if (typeof result === "string") return result;
	if (result && typeof result === "object" && "content" in result) {
		const content = (result as { content: unknown }).content;
		if (Array.isArray(content)) {
			const textParts = content
				.filter((p: any) => p.type === "text" && p.text)
				.map((p: any) => p.text as string);
			if (textParts.length > 0) return textParts.join("\n");
		}
	}
	return JSON.stringify(result);
}

//IYH1HC comment: signature gained a `provider` param (defaults to env llmProvider)
// so per-run model overrides can resolve a key for a different provider.
async function getLlmApiKey(authStorage: AuthStorage, authFilePath: string, provider: string = llmProvider): Promise<string> {
	if (process.env.LLM_API_KEY) return process.env.LLM_API_KEY;
	// SAP providers use extension-level auth/token handling; use sentinel key for runtime checks.
	if (provider.startsWith("sap-")) return "sap-orchestration";
	const key = await authStorage.getApiKey(provider);
	if (!key) {
		if (provider === "openai-codex") {
			throw new Error(
				`No OAuth token found for provider "${provider}".\n\n` +
					`Log in with the pi coding agent so it writes ${authFilePath}, ` +
					`or set LLM_AUTH_FILE to an auth.json that contains openai-codex credentials.`,
			);
		}
		throw new Error(
			`No API key found for provider "${provider}".\n\n` +
				`Set LLM_API_KEY env var, or store the key in ` +
				authFilePath +
				` as { "${provider}": "your-key" }`,
		);
	}
	return key;
}

interface LogMessage {
	date?: string;
	ts?: string;
	user?: string;
	userName?: string;
	text?: string;
	isBot?: boolean;
}

function freshUsage() {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

/**
 * CoreAgent wraps a single agent instance for one channel/session.
 * Manages session persistence, the agentic loop, and primitive tool execution.
 * One instance per channel — create once, call run() for each message.
 */
export class CoreAgent {
	private readonly channelId: string;
	private readonly channelDir: string;
	private readonly hostDataRoot: string;
	private readonly hostWorkspacePath: string;
	/** Container path (or host path for host-mode sandboxes) */
	readonly workspacePath: string;
	private readonly executor: Executor;
	private readonly agentInstance: Agent;
	private readonly session: AgentSession;
	private readonly sessionManager: SessionManager;
	private resourcesLoaded = false;
	private authStorage: AuthStorage;
	private authFilePath: string;

	// Upload fn updated before each run; accessed by the attach tool
	private currentUploadFn: ((path: string, title?: string) => Promise<void>) | null = null;

	// Event callbacks for the active run
	private currentEvents: CoreAgentEventHandlers | null = null;
	private pendingTools = new Map<string, { toolName: string; args: unknown; startTime: number }>();

	//IYH1HC add: per-run model override state (set in run() when input.model present)
	private runProvider: string | undefined;
	private runApiKey: string | undefined;

	// Per-run result state
	private runStopReason = "stop";
	private runErrorMessage: string | undefined;
	private runTotalUsage = freshUsage();
	private runLastAssistantText: string | undefined;

	constructor(channelId: string, options: CoreAgentOptions) {
		this.channelId = channelId;
		this.channelDir = options.channelDir;
		const hostWorkspacePath = dirname(dirname(options.channelDir));
		const hostDataRoot = options.usersRoot ? dirname(options.usersRoot) : dirname(dirname(hostWorkspacePath));
		this.hostDataRoot = hostDataRoot;
		this.hostWorkspacePath = hostWorkspacePath;
		const hostArtifactsDir = join(hostWorkspacePath, "artifacts");
		mkdirSync(hostArtifactsDir, { recursive: true });
		const sandboxConfig = options.sandboxConfig;
		const isContainerSandbox = isContainerSandboxConfig(sandboxConfig);
		const containerWorkspacePath = isContainerSandbox
			? sandboxConfig.workspacePath ?? getContainerWorkspacePath(hostDataRoot, hostWorkspacePath)
			: hostWorkspacePath;
		const executorCwd = isContainerSandbox
			? `${containerWorkspacePath}/artifacts`
			: hostArtifactsDir;
		this.executor = createExecutor(sandboxConfig, executorCwd);
		this.workspacePath = isContainerSandbox
			? containerWorkspacePath
			: this.executor.getWorkspacePath(hostWorkspacePath);

		//IYH1HC add: attach uploads from the HOST fs, so it must use the host artifacts dir
		//IYH1HC add: (executorCwd is a container path like /workspace/artifacts in Docker mode).
		const primitiveTools = createPrimitiveTools(this.executor, () => this.currentUploadFn, hostArtifactsDir);
		//IYH1HC comment const primitiveTools = createPrimitiveTools(this.executor, () => this.currentUploadFn, executorCwd);
		const tools = options.extraTools ? [...primitiveTools, ...options.extraTools] : primitiveTools;

		const contextFile = join(options.channelDir, "context.jsonl");
		this.sessionManager = SessionManager.open(contextFile);
		const settingsManager = new AgentSettingsManager(join(options.channelDir, ".."));

		this.authFilePath = options.authFilePath ?? defaultAuthFilePath;
		this.authStorage = this.createAuthStorage(this.authFilePath);
		const modelRegistry = ModelRegistry.create(this.authStorage);

		this.agentInstance = new Agent({
			initialState: { systemPrompt: "", model, thinkingLevel: "off", tools },
			convertToLlm,
			//IYH1HC comment: use the per-run override key when one is set; otherwise
			// fall back to env/auth-file resolution for the active provider.
			getApiKey: async () =>
				this.runApiKey ?? getLlmApiKey(this.authStorage, this.authFilePath, this.runProvider ?? llmProvider),
		});

		const loadedSession = this.sessionManager.buildSessionContext();
		if (loadedSession.messages.length > 0) {
			(this.agentInstance.state as any).messages = loadedSession.messages;
		}

		const runtimeUsersRoot = isContainerSandbox ? sandboxConfig.usersPath ?? "/workspace/users" : options.usersRoot;

		const extensionFactories = options.agentWorkersEnabled === false
			? []
			: [createAcpOrchestratorExtension(executorCwd, hostWorkspacePath, channelId, {
				userId: options.userId ?? "web-user",
				usersRoot: options.usersRoot,
				runtimeUsersRoot,
			}, this.executor)];

		const resourceLoader = new DefaultResourceLoader({
			cwd: executorCwd,
			agentDir: getAgentDir(),
			settingsManager: settingsManager as any,
			extensionFactories,
			noSkills: true,
			noPromptTemplates: true,
			noThemes: true,
			noContextFiles: true,
			systemPrompt: "",
		});

		const baseToolsOverride = Object.fromEntries(tools.map((t) => [t.name, t]));

		this.session = new AgentSession({
			agent: this.agentInstance,
			sessionManager: this.sessionManager,
			settingsManager: settingsManager as any,
			cwd: executorCwd,
			modelRegistry,
			resourceLoader,
			baseToolsOverride,
		});

		// Subscribe to session events once; route to per-run callbacks
		this.session.subscribe(async (event) => {
			if (!this.currentEvents) return;
			const events = this.currentEvents;

			if (event.type === "tool_execution_start") {
				const e = event as AgentEvent & { type: "tool_execution_start" };
				const args = e.args as { label?: string };
				this.pendingTools.set(e.toolCallId, { toolName: e.toolName, args: e.args, startTime: Date.now() });
				events.onToolStart?.(e.toolName, args.label || e.toolName, e.args as Record<string, unknown>);
			} else if (event.type === "tool_execution_end") {
				const e = event as AgentEvent & { type: "tool_execution_end" };
				const resultStr = extractToolResultText(e.result);
				const pending = this.pendingTools.get(e.toolCallId);
				this.pendingTools.delete(e.toolCallId);
				const durationMs = pending ? Date.now() - pending.startTime : 0;
				const label = pending?.args ? (pending.args as { label?: string }).label : undefined;
				events.onToolEnd?.(
					e.toolName,
					label,
					(pending?.args as Record<string, unknown>) ?? {},
					durationMs,
					resultStr,
					e.isError,
				);
			} else if (event.type === "tool_execution_update") {
				const e = event as AgentEvent & { type: "tool_execution_update" };
				const resultStr = extractToolResultText((e as any).partialResult);
				const pending = this.pendingTools.get(e.toolCallId);
				const label = pending?.args ? (pending.args as { label?: string }).label : undefined;
				events.onToolUpdate?.(
					e.toolName,
					label,
					(pending?.args as Record<string, unknown>) ?? {},
					resultStr,
				);
			} else if (event.type === "message_end") {
				const e = event as AgentEvent & { type: "message_end" };
				if (e.message.role === "assistant") {
					const msg = e.message as any;
					if (msg.stopReason) this.runStopReason = msg.stopReason;
					if (msg.errorMessage) this.runErrorMessage = msg.errorMessage;
					if (msg.usage) {
						this.runTotalUsage.input += msg.usage.input;
						this.runTotalUsage.output += msg.usage.output;
						this.runTotalUsage.cacheRead += msg.usage.cacheRead;
						this.runTotalUsage.cacheWrite += msg.usage.cacheWrite;
						this.runTotalUsage.cost.input += msg.usage.cost.input;
						this.runTotalUsage.cost.output += msg.usage.cost.output;
						this.runTotalUsage.cost.cacheRead += msg.usage.cost.cacheRead;
						this.runTotalUsage.cost.cacheWrite += msg.usage.cost.cacheWrite;
						this.runTotalUsage.cost.total += msg.usage.cost.total;
					}
					const content = e.message.content as any[];
					const thinkingParts = content.filter((p) => p.type === "thinking").map((p) => p.thinking as string);
					const textParts = content.filter((p) => p.type === "text").map((p) => p.text as string);
					const text = textParts.join("\n");
					for (const t of thinkingParts) events.onThinking?.(t);
					if (text.trim()) {
						this.runLastAssistantText = text;
						events.onMessage?.(text);
					}
				}
			} else if (event.type === "compaction_start") {
				events.onCompactionStart?.((event as any).reason);
			} else if (event.type === "compaction_end") {
				const e = event as any;
				events.onCompactionEnd?.(e.result, e.aborted);
			} else if (event.type === "auto_retry_start") {
				const e = event as any;
				events.onRetry?.(e.attempt, e.maxAttempts, e.errorMessage);
			}
		});
	}

	private createAuthStorage(path: string): AuthStorage {
		const storage = AuthStorage.create(path);
		if (process.env.LLM_API_KEY) {
			storage.setRuntimeApiKey(llmProvider, process.env.LLM_API_KEY);
		}
		if (llmProvider.startsWith("sap-")) {
			// SAP auth/token handling is extension-owned; register a sentinel key so
			// runtime API-key checks for this provider can proceed.
			storage.setRuntimeApiKey(baseProvider, "sap-orchestration");
		}
		return storage;
	}

	private useAuthFilePath(path: string): void {
		if (path === this.authFilePath) return;
		this.authFilePath = path;
		this.authStorage = this.createAuthStorage(path);
	}

	/**
	 * Sync user messages from log.jsonl that arrived while the agent was offline.
	 * Safe to call when log.jsonl does not exist — returns 0.
	 *
	 * @param excludeTs - Timestamp of the current message to exclude (will be added via run())
	 */
	syncFromLog(excludeTs?: string): number {
		const logFile = join(this.channelDir, "log.jsonl");
		if (!existsSync(logFile)) return 0;

		const existingMessages = new Set<string>();
		for (const entry of this.sessionManager.getEntries()) {
			if (entry.type === "message") {
				const msg = (entry as any).message as { role: string; content?: unknown };
				if (msg.role === "user" && msg.content !== undefined) {
					const normalize = (text: string) => {
						let n = text.replace(/^\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}\] /, "");
						const idx = n.indexOf("\n\n<attachments>\n");
						if (idx !== -1) n = n.substring(0, idx);
						return n;
					};
					if (typeof msg.content === "string") {
						existingMessages.add(normalize(msg.content));
					} else if (Array.isArray(msg.content)) {
						for (const part of msg.content) {
							if (part && typeof part === "object" && part.type === "text" && "text" in part) {
								existingMessages.add(normalize(part.text as string));
							}
						}
					}
				}
			}
		}

		const logContent = readFileSync(logFile, "utf-8");
		const logLines = logContent.trim().split("\n").filter(Boolean);

		const newMessages: Array<{ timestamp: number; message: any }> = [];

		for (const line of logLines) {
			try {
				const logMsg: LogMessage = JSON.parse(line);
				const slackTs = logMsg.ts;
				const date = logMsg.date;
				if (!slackTs || !date) continue;
				if (excludeTs && slackTs === excludeTs) continue;
				if (logMsg.isBot) continue;

				const messageText = `[${logMsg.userName || logMsg.user || "unknown"}]: ${logMsg.text || ""}`;
				if (existingMessages.has(messageText)) continue;

				const msgTime = new Date(date).getTime() || Date.now();
				newMessages.push({
					timestamp: msgTime,
					message: {
						role: "user",
						content: [{ type: "text", text: messageText }],
						timestamp: msgTime,
					},
				});
				existingMessages.add(messageText);
			} catch {
				// Skip malformed lines
			}
		}

		if (newMessages.length === 0) return 0;

		newMessages.sort((a, b) => a.timestamp - b.timestamp);
		for (const { message } of newMessages) {
			this.sessionManager.appendMessage(message);
		}

		return newMessages.length;
	}

	/**
	 * Run the agent for one message. Builds the user message, calls the agentic loop,
	 * and returns the result. Event callbacks fire synchronously during the loop.
	 */
	async run(input: CoreAgentRunInput): Promise<CoreAgentRunResult> {
		await mkdir(this.channelDir, { recursive: true });
		if (input.authFilePath) this.useAuthFilePath(input.authFilePath);
		if (!this.resourcesLoaded) {
			await this.session.reload();
			this.resourcesLoaded = true;
		}

		//IYH1HC add: apply a per-run model override coming from the web UI. When absent,
		// restore the env-driven default so reused instances (Slack/cron) stay backward-compatible.
		if (input.model) {
			const provider = input.model.provider;
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			const rawModel = (getModel as (p: string, m: string) => any)(provider, input.model.modelId);
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			const runModel: any = rawModel ?? {
				id: input.model.modelId,
				name: input.model.modelId,
				provider,
				baseUrl: "",
				api: getDefaultApiType(provider),
				input: ["text", "image"],
				contextWindow: 200000,
				maxTokens: 8192,
			};
			if (input.model.baseUrl) runModel.baseUrl = input.model.baseUrl;
			if (input.model.apiType) runModel.api = input.model.apiType;
			(this.session.agent.state as any).model = runModel;
			this.runProvider = provider;
			this.runApiKey = input.model.apiKey;
			// pi's AgentSession/ModelRegistry resolves the key via AuthStorage (not the
			// Agent.getApiKey callback), so inject the per-user key as a runtime override.
			if (input.model.apiKey) {
				this.authStorage.setRuntimeApiKey(provider, input.model.apiKey);
			}
		} else {
			(this.session.agent.state as any).model = model;
			this.runProvider = undefined;
			this.runApiKey = undefined;
		}

		// Sync any offline messages from log.jsonl
		this.syncFromLog(input.ts);

		// Reload messages from context.jsonl to pick up synced messages
		const reloadedSession = this.sessionManager.buildSessionContext();
		if (reloadedSession.messages.length > 0) {
			(this.agentInstance.state as any).messages = reloadedSession.messages;
		}

		// AgentSession.prompt() resets agent.state.systemPrompt from its private base prompt.
		// Keep both in sync so service-built workspace prompts survive that reset.
		(this.session.agent.state as any).systemPrompt = input.systemPrompt;
		(this.session as any)._baseSystemPrompt = input.systemPrompt;

		// Wire upload function — CoreAgent translates container→host paths before calling it
		this.currentUploadFn = input.uploadFile
			? (path, title) => input.uploadFile!(this.translateToHostPath(path), title)
			: null;

		// Reset per-run state
		this.currentEvents = input.events ?? null;
		this.pendingTools.clear();
		this.runStopReason = "stop";
		this.runErrorMessage = undefined;
		this.runTotalUsage = freshUsage();
		this.runLastAssistantText = undefined;

		// Build timestamped user message
		const now = new Date();
		const pad = (n: number) => n.toString().padStart(2, "0");
		const offset = -now.getTimezoneOffset();
		const offsetSign = offset >= 0 ? "+" : "-";
		const offsetHours = pad(Math.floor(Math.abs(offset) / 60));
		const offsetMins = pad(Math.abs(offset) % 60);
		const timestamp = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}${offsetSign}${offsetHours}:${offsetMins}`;
		let userMessage = `[${timestamp}] [${input.userName || "unknown"}]: ${input.text}`;

		// Process attachments
		const imageAttachments: ImageContent[] = [];
		const nonImagePaths: string[] = [];

		for (const a of input.attachments || []) {
			const fullPath = `${this.workspacePath}/${a.local}`;
			const mimeType = getImageMimeType(a.local);
			if (mimeType && existsSync(fullPath)) {
				try {
					imageAttachments.push({
						type: "image",
						mimeType,
						data: readFileSync(fullPath).toString("base64"),
					});
				} catch {
					nonImagePaths.push(fullPath);
				}
			} else {
				nonImagePaths.push(fullPath);
			}
		}

		if (nonImagePaths.length > 0) {
			userMessage += `\n\n<attachments>\n${nonImagePaths.join("\n")}\n</attachments>`;
		}

		// Debug snapshot
		await writeFile(
			join(this.channelDir, "last_prompt.jsonl"),
			JSON.stringify(
				{
					systemPrompt: input.systemPrompt,
					messages: this.session.messages,
					newUserMessage: userMessage,
					imageAttachmentCount: imageAttachments.length,
				},
				null,
				2,
			),
		);

		// For SAP OAuth2: refresh token before every call.
		await this.session.prompt(userMessage, imageAttachments.length > 0 ? { images: imageAttachments } : undefined);

		// Clear run-scoped state
		this.currentEvents = null;
		this.currentUploadFn = null;

		return {
			stopReason: this.runStopReason,
			errorMessage: this.runErrorMessage,
			lastAssistantText: this.runLastAssistantText,
			usage: { ...this.runTotalUsage, cost: { ...this.runTotalUsage.cost } },
		};
	}

	abort(): void {
		this.session.abort();
	}

	get messages() {
		return this.session.messages;
	}

	get modelContextWindow(): number {
		return (model as any).contextWindow || 200000;
	}

	/** Translate a container path back to a host path for file operations (Docker mode only). */
	private translateToHostPath(containerPath: string): string {
		if (containerPath === this.workspacePath) {
			return this.hostWorkspacePath;
		}
		if (containerPath.startsWith(`${this.workspacePath}/`)) {
			return join(this.hostWorkspacePath, containerPath.slice(this.workspacePath.length + 1));
		}
		if (containerPath === "/workspace") {
			return this.hostDataRoot;
		}
		if (containerPath.startsWith("/workspace/")) {
			return join(this.hostDataRoot, containerPath.slice("/workspace/".length));
		}
		return containerPath;
	}
}

function getContainerWorkspacePath(hostDataRoot: string, hostWorkspacePath: string): string {
	const rel = relative(hostDataRoot, hostWorkspacePath);
	if (!rel || rel.startsWith("..") || isAbsolute(rel)) return "/workspace";
	return `/workspace/${rel.replace(/\\/g, "/")}`;
}

function isContainerSandboxConfig(config: CoreAgentOptions["sandboxConfig"]): config is Extract<CoreAgentOptions["sandboxConfig"], { type: "docker" | "podman" }> {
	return config.type === "docker" || config.type === "podman";
}
