import { spawn, type ChildProcessWithoutNullStreams } from "child_process";
import { Dirent, appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "fs";
import { basename, extname, isAbsolute, join, resolve } from "path";
import {
	getModel,
	getModels,
	cancelAcpJob,
	connectorHomeHasFiles,
	ensureConnectorHome,
	getConnectorHome,
	getConnectorRuntime,
	getProviderAuthStatus,
	listAcpJobs,
	listConnectorRuntimes,
	loginProvider,
	safeConnectorUserId,
	type ConnectorRuntime,
} from "@octo/core-agent";
import express from "express";
import { CoreServiceAuth } from "./auth.js";
import { decryptSecret, encryptSecret } from "./crypto.js"; //IYH1HC add
import { prepareBoschOpenAIEndpoint } from "./extensions/bosch-genai-adapter.js"; //IYH1HC add
import { GithubSsoProvider, loadSsoConfig } from "./sso.js"; //IYH1HC add
import * as log from "./log.js";
import { getWorkspaceSandboxStatus } from "./sandbox-manager.js";
import type { BotContext, BotHandler } from "./types.js";
import { WorkspaceDatabase } from "./workspace-database.js";
import { WorkspaceStore } from "./workspaces.js";
import type { SandboxConfig } from "@octo/core-agent";

// ============================================================================
// HTTP context adapter
// ============================================================================

type SseEmitter = (event: object) => void;

interface PendingAuthLogin {
	userId: string;
	status: "pending" | "complete" | "error";
	createdAt: number;
	url?: string;
	instructions?: string;
	userCode?: string;
	verificationUri?: string;
	error?: string;
	resolveManualCode?: (value: string) => void;
	rejectManualCode?: (err: Error) => void;
}

//IYH1HC add: providers that use the per-user key + model-selection flow.
// (openai-codex keeps OAuth; sap-* keep service-key-from-env.)
const LLM_KEY_PROVIDERS: ReadonlyArray<{ id: string; label: string }> = [
	{ id: "openai", label: "OpenAI" },
	{ id: "google", label: "Google Gemini" },
	{ id: "anthropic", label: "Anthropic" },
];
interface PendingAgentWorkerLogin {
	userId: string;
	connectorId: string;
	status: "pending" | "complete" | "error";
	createdAt: number;
	output: string;
	url?: string;
	error?: string;
	child?: ChildProcessWithoutNullStreams;
}

const BINARY_MIME_TYPES: Record<string, string> = {
	doc: "application/msword",
	docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
	ppt: "application/vnd.ms-powerpoint",
	pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
	xls: "application/vnd.ms-excel",
	xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
	zip: "application/zip",
};

export function createHttpContext(opts: {
	channelId: string;
	userName: string;
	text: string;
	ts: string;
	send: SseEmitter;
	workingDir: string;
	attachments?: Array<{ local: string }>;
	userId?: string;
	authFilePath?: string;
	model?: { provider: string; modelId: string; apiKey?: string; baseUrl?: string; apiType?: string }; //IYH1HC add
}): BotContext {
	const { channelId, userName, text, ts, send, workingDir, attachments = [], userId = "web-user", authFilePath, model } = opts; //IYH1HC comment: added `model`

	const logToFile = (entry: object) => {
		const dir = join(workingDir, "sessions", channelId);
		if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
		appendFileSync(join(dir, "log.jsonl"), `${JSON.stringify(entry)}\n`);
	};

	return {
		message: {
			text,
			rawText: text,
			user: userId,
			userName,
			channel: channelId,
			ts,
			attachments,
		},
		authFilePath,
		model, //IYH1HC add
		channelName: channelId,
		channels: [{ id: channelId, name: channelId }],
		users: [{ id: userId, userName, displayName: userName }],

		respond: async (responseText: string, shouldLog = true) => {
			send({ type: "delta", text: responseText });
			if (shouldLog) {
				const responseTs = (Date.now() / 1000).toFixed(6);
				logToFile({ date: new Date().toISOString(), ts: responseTs, user: "bot", text: responseText, attachments: [], isBot: true });
			}
		},

		replaceMessage: async (responseText: string) => {
			send({ type: "replace", text: responseText });
			const responseTs = (Date.now() / 1000).toFixed(6);
			logToFile({ date: new Date().toISOString(), ts: responseTs, user: "bot", text: responseText, attachments: [], isBot: true, isFinal: true });
		},

		respondInThread: async (responseText: string) => {
			send({ type: "thread", text: responseText });
			const responseTs = (Date.now() / 1000).toFixed(6);
			logToFile({ date: new Date().toISOString(), ts: responseTs, user: "bot", text: responseText, attachments: [], isBot: true, isThread: true });
		},

		setTyping: async (isTyping: boolean) => {
			send({ type: "status", status: isTyping ? "thinking" : "idle" });
		},

		uploadFile: async (filePath: string, title?: string) => {
			send({ type: "file", path: filePath, title });
		},

		setWorking: async (working: boolean) => {
			send({ type: "status", status: working ? "working" : "idle" });
		},

		deleteMessage: async () => {
			send({ type: "delete" });
		},
	};
}

// ============================================================================
// HTTP SSE Server
// ============================================================================

/**
 * HTTP server that exposes the bot via Server-Sent Events.
 *
 * Endpoints:
 *   POST /chat              – { channelId, text, userName? }  → SSE stream
 *   POST /stop              – { channelId }                   → { ok, message }
 *   GET  /status/:channelId                                   → { running }
 *   GET  /sessions                                            → SessionInfo[]
 *   GET  /messages/:channelId                                 → ChatMessage[]
 *   GET  /file?path=...                                       → raw file
 *   GET  /artifact-url?path=...                               → { url }
 *   GET  /artifacts/*                                         → static files from {workingDir}/artifacts/
 *
 * SSE event shapes:
 *   { type: "status",  status: "thinking"|"working"|"idle"|"stopped" }
 *   { type: "delta",   text: string }
 *   { type: "replace", text: string }
 *   { type: "thread",  text: string }
 *   { type: "file",    path: string, title?: string }
 *   { type: "delete" }
 *   { type: "done",    stopReason: string }
 *   { type: "error",   message: string }
 */
export class HttpServer {
	private port: number;
	private workingDir: string;
	private handler: BotHandler;
	private workspaceStore: WorkspaceStore;
	private sandboxConfig: SandboxConfig;
	private features: { agentWorkers: boolean; reminders: boolean };
	private auth: CoreServiceAuth;
	private pendingAuthLogins = new Map<string, PendingAuthLogin>();
	private sso: GithubSsoProvider | null; //IYH1HC add
	private pendingAgentWorkerLogins = new Map<string, PendingAgentWorkerLogin>();

	constructor(config: { port: number; workingDir: string; handler: BotHandler; workspaceStore: WorkspaceStore; sandboxConfig: SandboxConfig; features?: { agentWorkers?: boolean; reminders?: boolean } }) {
		this.port = config.port;
		this.workingDir = config.workingDir;
		this.handler = config.handler;
		this.workspaceStore = config.workspaceStore;
		this.sandboxConfig = config.sandboxConfig;
		this.features = {
			agentWorkers: config.features?.agentWorkers !== false,
			reminders: config.features?.reminders !== false,
		};
		this.auth = new CoreServiceAuth(config.workingDir);
		//IYH1HC add: build the SSO provider from env (null when SSO is disabled).
		const ssoConfig = loadSsoConfig();
		this.sso = ssoConfig ? new GithubSsoProvider(ssoConfig) : null;
		if (this.sso) log.logInfo(`SSO enabled: ${ssoConfig?.provider} (${ssoConfig?.label})`);
	}

	start(): void {
		const app = express();
		app.use(express.json({ limit: "50mb" }));

		// CORS
		app.use((_req, res, next) => {
			const origin = _req.header("Origin");
			res.setHeader("Access-Control-Allow-Origin", origin || "*");
			res.setHeader("Access-Control-Allow-Methods", "POST, GET, PATCH, PUT, DELETE, OPTIONS"); //IYH1HC comment: added PUT/DELETE for LLM key endpoints
			res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-User-Id, Authorization");
			res.setHeader("Access-Control-Allow-Credentials", "true");
			next();
		});
		app.options("/{*path}", (_req, res) => { res.sendStatus(204); });
		app.use(this.auth.initialize());

		// Static artifact files — serves {workingDir}/artifacts/ at /artifacts/
		const artifactsDir = join(this.workingDir, "artifacts");

		app.post("/auth/register", (req, res) => this.auth.register(req, res));
		app.post("/auth/login", (req, res, next) => this.auth.login(req, res, next));
		app.get("/auth/me", (req, res, next) => this.auth.requireAuth(req, res, next), (req, res) => this.auth.me(req, res));
		app.post("/auth/logout", (req, res, next) => this.auth.requireAuth(req, res, next), (req, res) => this.auth.logout(req, res));

		//IYH1HC add: external SSO (GHES) — public endpoints, must be before requireAuth.
		app.get("/auth/sso/config", (req, res) => this.handleSsoConfig(req, res));
		app.get("/auth/sso/login", (req, res) => this.handleSsoLogin(req, res));
		app.get("/auth/sso/callback", (req, res) => { void this.handleSsoCallback(req, res); });

		app.use((req, res, next) => this.auth.requireAuth(req, res, next));
		app.use("/artifacts", express.static(artifactsDir, { fallthrough: false }));

		// API routes
		app.get("/features", (_req, res) => this.handleFeatures(res));
		app.get("/workspaces",      (req, res) => this.handleWorkspaces(req, res));
		app.get("/workspace-templates", (_req, res) => res.json(this.workspaceStore.listWorkspaceTemplates()));
		app.post("/workspaces",     (req, res) => this.handleCreateWorkspace(req, res));
		app.get("/workspaces/:workspaceId/settings", (req, res) => this.handleWorkspaceSettings(req, res));
		app.patch("/workspaces/:workspaceId/settings", (req, res) => this.handleUpdateWorkspaceSettings(req, res));
		app.get("/workspaces/:workspaceId/sandbox", (req, res) => { void this.handleWorkspaceSandbox(req, res); });
		app.get("/workspaces/:workspaceId/events", (req, res) => this.handleWorkspaceEvents(req, res));
		app.delete("/workspaces/:workspaceId/events/:filename", (req, res) => this.handleDeleteWorkspaceEvent(req, res));
		app.get("/database/tables", (req, res) => this.handleDatabaseTables(req, res));
		app.get("/database/tables/:tableName/rows", (req, res) => this.handleDatabaseRows(req, res));
		app.get("/auth/openai-codex/status", (req, res) => this.handleAuthStatus(req, res));
		app.post("/auth/openai-codex/login", (req, res) => { void this.handleCodexLogin(req, res); });
		app.get("/auth/openai-codex/login/:loginId", (req, res) => this.handleCodexLoginStatus(req, res));
		app.post("/auth/openai-codex/login/:loginId/code", (req, res) => this.handleCodexLoginCode(req, res));
		//IYH1HC add: per-user LLM provider key + active-model management.
		app.get("/llm/config", (req, res) => this.handleLlmConfig(req, res));
		app.get("/llm/active-models", (req, res) => this.handleLlmActiveModels(req, res));
		app.put("/llm/providers/:provider/key", (req, res) => this.handleSetProviderKey(req, res));
		app.delete("/llm/providers/:provider/key", (req, res) => this.handleDeleteProviderKey(req, res));
		app.put("/llm/providers/:provider/models", (req, res) => this.handleSetActiveModels(req, res));
		//IYH1HC add: user-defined custom models (Bosch GenAI / LLM Farm).
		app.get("/llm/custom-models", (req, res) => this.handleListCustomModels(req, res));
		app.post("/llm/custom-models", (req, res) => this.handleCreateCustomModel(req, res));
		app.put("/llm/custom-models/:id", (req, res) => this.handleUpdateCustomModel(req, res));
		app.delete("/llm/custom-models/:id", (req, res) => this.handleDeleteCustomModel(req, res));
		app.get("/auth/connectors", (req, res) => this.handleConnectors(req, res));
		app.get("/auth/connectors/:connector/status", (req, res) => this.handleConnectorStatus(req, res));
		app.post("/auth/connectors/:connector/login", (req, res) => this.handleConnectorLogin(req, res));
		app.get("/auth/connectors/:connector/login/:loginId", (req, res) => this.handleConnectorLoginStatus(req, res));
		app.post("/auth/connectors/:connector/login/:loginId/input", (req, res) => this.handleConnectorLoginInput(req, res));
		app.post("/auth/connectors/:connector/logout", (req, res) => this.handleConnectorLogout(req, res));
		app.post("/connectors/:connector/exec", (req, res) => this.handleConnectorExec(req, res));
		app.get("/auth/agent-workers", (req, res) => this.handleAgentWorkers(req, res));
		app.get("/auth/agent-workers/:agent/status", (req, res) => this.handleAgentWorkerStatus(req, res));
		app.post("/auth/agent-workers/:agent/login", (req, res) => this.handleAgentWorkerLogin(req, res));
		app.get("/auth/agent-workers/:agent/login/:loginId", (req, res) => this.handleAgentWorkerLoginStatus(req, res));
		app.post("/auth/agent-workers/:agent/login/:loginId/input", (req, res) => this.handleAgentWorkerLoginInput(req, res));
		app.post("/auth/agent-workers/:agent/logout", (req, res) => this.handleAgentWorkerLogout(req, res));
		app.get("/workspaces/:workspaceId/sessions", (req, res) => this.handleWorkspaceSessions(req, res));
		app.post("/workspaces/:workspaceId/sessions", (req, res) => this.handleCreateSession(req, res));
		app.post("/sessions/:sessionId/messages", (req, res) => { void this.handleChat(req, res, req.params.sessionId); });
		app.post("/chat",           (req, res) => { void this.handleChat(req, res); });
		app.post("/stop",           (req, res) => { void this.handleStop(req, res); });
		app.get("/status/:id",      (req, res) => this.handleStatus(req, req.params.id, res));
		app.get("/sessions/:id/acp-jobs", (req, res) => this.handleAcpJobs(req, decodeURIComponent(req.params.id), res));
		app.post("/sessions/:id/acp-jobs/:jobId/cancel", (req, res) => this.handleCancelAcpJob(req, decodeURIComponent(req.params.id), decodeURIComponent(req.params.jobId), res));
		app.get("/sessions",        (req, res) => this.handleSessions(req, res));
		app.get("/messages/:id",    (req, res) => this.handleMessages(req, decodeURIComponent(req.params.id), res));
		app.get("/sessions/:id/messages", (req, res) => this.handleMessages(req, decodeURIComponent(req.params.id), res));
		app.get("/file",            (req, res) => this.handleFile(req, String(req.query.path ?? ""), res));
		app.get("/artifact-url",    (req, res) => this.handleArtifactUrl(req, String(req.query.path ?? ""), res));
		app.get("/workspace/:id",   (req, res) => this.handleWorkspace(req, decodeURIComponent(req.params.id), res));
		app.get("/sessions/:id/workspace", (req, res) => this.handleWorkspace(req, decodeURIComponent(req.params.id), res));

		app.listen(this.port, () => {
			log.logInfo(`HTTP SSE server listening on port ${this.port}`);
			log.logInfo(`Artifacts served from: ${artifactsDir}`);
		});
	}

	// ==========================================================================
	// Handlers
	// ==========================================================================

	private getUserId(req: express.Request, fallback?: string): string {
		return String(req.user?.id || req.header("x-user-id") || req.query.userId || fallback || "web-user");
	}

	private getUserAuthFilePath(userId: string): string {
		const safeUserId = userId.replace(/[^a-zA-Z0-9._-]/g, "_") || "web-user";
		const dir = join(this.workingDir, "users", safeUserId);
		mkdirSync(dir, { recursive: true });
		return join(dir, "auth.json");
	}

	private resolveReadableWorkspaceFile(req: express.Request, filePath: string, res: express.Response): string | undefined {
		if (!filePath) {
			res.status(400).json({ error: "Missing path" });
			return undefined;
		}

		const root = resolve(this.workingDir);
		const resolved = resolve(filePath.startsWith("/") ? filePath : join(this.workingDir, filePath));
		if (resolved !== root && !resolved.startsWith(`${root}/`)) {
			res.status(403).json({ error: "Forbidden" });
			return undefined;
		}

		const workspaceRoot = resolve(join(this.workingDir, "workspaces"));
		if (resolved === workspaceRoot || !resolved.startsWith(`${workspaceRoot}/`)) {
			res.status(403).json({ error: "Forbidden" });
			return undefined;
		}

		const workspaceId = resolved.slice(workspaceRoot.length + 1).split(/[\\/]/)[0];
		try {
			this.workspaceStore.assertWorkspaceAccess(this.getUserId(req), workspaceId);
		} catch (err) {
			res.status(403).json({ error: err instanceof Error ? err.message : String(err) });
			return undefined;
		}
		return resolved;
	}

	private createLoginId(): string {
		return `login_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
	}

	private handleAuthStatus(req: express.Request, res: express.Response): void {
		const userId = this.getUserId(req);
		const status = getProviderAuthStatus(this.getUserAuthFilePath(userId), "openai-codex");
		res.json({ provider: "openai-codex", configured: status.configured, source: status.source, label: status.label });
	}

	//IYH1HC add: public SSO config so the web app knows whether to show the button.
	private handleSsoConfig(_req: express.Request, res: express.Response): void {
		if (!this.sso) {
			res.json({ enabled: false });
			return;
		}
		res.json({ enabled: true, provider: this.sso.config.provider, label: this.sso.config.label, loginUrl: "/auth/sso/login" });
	}

	//IYH1HC add: start the SSO flow — redirect the browser to the GHES authorize URL.
	private handleSsoLogin(_req: express.Request, res: express.Response): void {
		if (!this.sso) {
			res.status(404).json({ error: "SSO is not enabled" });
			return;
		}
		res.redirect(this.sso.createAuthorizeUrl());
	}

	//IYH1HC add: SSO callback — validate state, exchange code, upsert the federated
	// user, issue the standard session token, and hand it to the web app via the URL
	// hash fragment (not logged server-side) alongside the HttpOnly cookie.
	private async handleSsoCallback(req: express.Request, res: express.Response): Promise<void> {
		if (!this.sso) {
			res.status(404).json({ error: "SSO is not enabled" });
			return;
		}
		const redirectBase = this.sso.config.postLoginRedirect;
		try {
			const code = String(req.query.code ?? "");
			const state = req.query.state ? String(req.query.state) : undefined;
			if (req.query.error) throw new Error(String(req.query.error_description || req.query.error));
			if (!code) throw new Error("Missing authorization code");
			if (!this.sso.consumeState(state)) throw new Error("Invalid or expired state");

			const identity = await this.sso.resolveIdentity(code);
			const session = this.auth.completeFederatedLogin(res, identity);
			res.redirect(`${redirectBase}/#sso_token=${encodeURIComponent(session.token)}`);
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			log.logWarning("[sso] callback failed", message);
			res.redirect(`${redirectBase}/#sso_error=${encodeURIComponent(message)}`);
		}
	}

	private async handleCodexLogin(req: express.Request, res: express.Response): Promise<void> {
		const { userName } = req.body as { userName?: string };
		const userId = this.getUserId(req, userName);
		const loginId = this.createLoginId();
		const entry: PendingAuthLogin = {
			userId,
			status: "pending",
			createdAt: Date.now(),
		};
		this.pendingAuthLogins.set(loginId, entry);

		const manualCodePromise = new Promise<string>((resolve, reject) => {
			entry.resolveManualCode = resolve;
			entry.rejectManualCode = reject;
		});

		void loginProvider(this.getUserAuthFilePath(userId), "openai-codex", {
			onAuth: (info) => {
				entry.url = info.url;
				entry.instructions = info.instructions;
			},
			onDeviceCode: (info) => {
				entry.userCode = info.userCode;
				entry.verificationUri = info.verificationUri;
			},
			onSelect: async () => undefined,
			onPrompt: async () => manualCodePromise,
			onManualCodeInput: async () => manualCodePromise,
			onProgress: (message) => {
				log.logInfo(`[auth:${loginId}] ${message}`);
			},
		}).then(() => {
			entry.status = "complete";
			entry.resolveManualCode = undefined;
			entry.rejectManualCode = undefined;
		}).catch((err) => {
			entry.status = "error";
			entry.error = err instanceof Error ? err.message : String(err);
			entry.resolveManualCode = undefined;
			entry.rejectManualCode = undefined;
			log.logWarning(`[auth:${loginId}] Codex login failed`, entry.error);
		});

		const started = Date.now();
		while (!entry.url && entry.status === "pending" && Date.now() - started < 5000) {
			await new Promise((resolve) => setTimeout(resolve, 25));
		}

		if (!entry.url) {
			res.status(500).json({ error: entry.error || "Codex login did not produce an auth URL" });
			return;
		}

		res.status(201).json({
			loginId,
			provider: "openai-codex",
			url: entry.url,
			instructions: entry.instructions,
			userCode: entry.userCode,
			verificationUri: entry.verificationUri,
			statusUrl: `/auth/openai-codex/login/${encodeURIComponent(loginId)}`,
			codeUrl: `/auth/openai-codex/login/${encodeURIComponent(loginId)}/code`,
		});
	}

	private handleCodexLoginStatus(req: express.Request, res: express.Response): void {
		const entry = this.pendingAuthLogins.get(String(req.params.loginId));
		if (!entry) {
			res.status(404).json({ error: "Login not found" });
			return;
		}
		res.json({
			status: entry.status,
			provider: "openai-codex",
			url: entry.url,
			instructions: entry.instructions,
			userCode: entry.userCode,
			verificationUri: entry.verificationUri,
			error: entry.error,
			createdAt: entry.createdAt,
		});
	}

	private handleCodexLoginCode(req: express.Request, res: express.Response): void {
		const entry = this.pendingAuthLogins.get(String(req.params.loginId));
		if (!entry) {
			res.status(404).json({ error: "Login not found" });
			return;
		}
		if (entry.status !== "pending" || !entry.resolveManualCode) {
			res.status(409).json({ error: `Login is ${entry.status}` });
			return;
		}
		const { code } = req.body as { code?: string };
		if (!code?.trim()) {
			res.status(400).json({ error: "Missing code or redirect URL" });
			return;
		}
		entry.resolveManualCode(code.trim());
		res.json({ ok: true, status: "pending" });
	}

	// ==========================================================================
	// IYH1HC add: per-user LLM provider key + model selection
	// ==========================================================================

	private isAllowedLlmProvider(provider: string): boolean {
		return LLM_KEY_PROVIDERS.some((p) => p.id === provider);
	}

	private modelLabel(provider: string, modelId: string): string {
		try {
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			const m = getModel(provider as any, modelId) as any;
			if (m?.name) return String(m.name);
		} catch { /* unknown model — fall back to id */ }
		return modelId;
	}

	// GET /llm/config → per-provider { id, label, hasKey, models:[{id,name,active}] }. Never returns keys.
	private handleLlmConfig(req: express.Request, res: express.Response): void {
		const userId = this.getUserId(req);
		const store = this.auth.getStore();
		const active = new Set(store.getActiveModels(userId).map((m) => `${m.provider}:${m.modelId}`));
		const providers = LLM_KEY_PROVIDERS.map((p) => {
			let models: Array<{ id: string; name: string; active: boolean }> = [];
			try {
				// eslint-disable-next-line @typescript-eslint/no-explicit-any
				models = (getModels(p.id as any) as any[]).map((m) => ({
					id: String(m.id),
					name: String(m.name ?? m.id),
					active: active.has(`${p.id}:${m.id}`),
				}));
			} catch { models = []; }
			return { id: p.id, label: p.label, hasKey: store.hasProviderKey(userId, p.id), models };
		});
		res.json({ providers });
	}

	// GET /llm/active-models → flat [{ provider, modelId, label }] for the chatbox listbox.
	private handleLlmActiveModels(req: express.Request, res: express.Response): void {
		const userId = this.getUserId(req);
		const store = this.auth.getStore();
		const models = store.getActiveModels(userId).map((m) => ({
			provider: m.provider,
			modelId: m.modelId,
			label: this.modelLabel(m.provider, m.modelId),
		}));
		//IYH1HC add: surface custom models (Bosch GenAI) into the same listbox. They are
		// always active once configured, addressed by provider "custom" + modelId = custom-model id.
		for (const cm of store.listCustomModels(userId)) {
			models.push({ provider: "custom", modelId: cm.id, label: cm.name });
		}
		res.json({ models });
	}

	// PUT /llm/providers/:provider/key  body { apiKey } → encrypt + store.
	private handleSetProviderKey(req: express.Request, res: express.Response): void {
		const provider = String(req.params.provider);
		if (!this.isAllowedLlmProvider(provider)) {
			res.status(400).json({ error: "Unsupported provider" });
			return;
		}
		const { apiKey } = req.body as { apiKey?: string };
		if (!apiKey || !apiKey.trim()) {
			res.status(400).json({ error: "Missing apiKey" });
			return;
		}
		try {
			const encrypted = encryptSecret(apiKey.trim());
			this.auth.getStore().setProviderKey(this.getUserId(req), provider, encrypted);
			res.json({ ok: true, hasKey: true });
		} catch (err) {
			res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
		}
	}

	// DELETE /llm/providers/:provider/key → forget the stored key.
	private handleDeleteProviderKey(req: express.Request, res: express.Response): void {
		const provider = String(req.params.provider);
		if (!this.isAllowedLlmProvider(provider)) {
			res.status(400).json({ error: "Unsupported provider" });
			return;
		}
		this.auth.getStore().deleteProviderKey(this.getUserId(req), provider);
		res.json({ ok: true, hasKey: false });
	}

	// PUT /llm/providers/:provider/models  body { modelIds: string[] } → replace active set.
	private handleSetActiveModels(req: express.Request, res: express.Response): void {
		const provider = String(req.params.provider);
		if (!this.isAllowedLlmProvider(provider)) {
			res.status(400).json({ error: "Unsupported provider" });
			return;
		}
		const { modelIds } = req.body as { modelIds?: unknown };
		if (!Array.isArray(modelIds) || modelIds.some((id) => typeof id !== "string")) {
			res.status(400).json({ error: "modelIds must be a string array" });
			return;
		}
		this.auth.getStore().setActiveModels(this.getUserId(req), provider, modelIds as string[]);
		res.json({ ok: true });
	}

	//IYH1HC add: whether a base provider is valid for a custom model (reuse the key-provider allowlist).
	private isAllowedBaseProvider(provider: string): boolean {
		return LLM_KEY_PROVIDERS.some((p) => p.id === provider);
	}

	//IYH1HC add: parse + validate a custom-model payload. apiKey is required only on create.
	private parseCustomModelBody(
		req: express.Request,
		requireKey: boolean,
	): { name: string; baseProvider: string; endpoint: string; apiKey?: string } | { error: string } {
		const { name, baseProvider, endpoint, apiKey } = req.body as {
			name?: string; baseProvider?: string; endpoint?: string; apiKey?: string;
		};
		if (!name || !name.trim()) return { error: "Missing name" };
		if (!baseProvider || !this.isAllowedBaseProvider(baseProvider)) return { error: "Unsupported baseProvider" };
		if (!endpoint || !endpoint.trim()) return { error: "Missing endpoint" };
		if (requireKey && (!apiKey || !apiKey.trim())) return { error: "Missing apiKey" };
		return {
			name: name.trim(),
			baseProvider,
			endpoint: endpoint.trim(),
			apiKey: apiKey && apiKey.trim() ? apiKey.trim() : undefined,
		};
	}

	// GET /llm/custom-models → { customModels: [{ id, name, baseProvider, endpoint }] }. Never returns keys.
	private handleListCustomModels(req: express.Request, res: express.Response): void {
		const customModels = this.auth.getStore().listCustomModels(this.getUserId(req));
		res.json({ customModels });
	}

	// POST /llm/custom-models  body { name, baseProvider, endpoint, apiKey } → encrypt + store.
	private handleCreateCustomModel(req: express.Request, res: express.Response): void {
		const parsed = this.parseCustomModelBody(req, true);
		if ("error" in parsed) {
			res.status(400).json({ error: parsed.error });
			return;
		}
		try {
			const encryptedKey = encryptSecret(parsed.apiKey as string);
			const id = this.auth.getStore().addCustomModel(this.getUserId(req), {
				name: parsed.name,
				baseProvider: parsed.baseProvider,
				endpoint: parsed.endpoint,
				encryptedKey,
			});
			res.json({ ok: true, id });
		} catch (err) {
			res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
		}
	}

	// PUT /llm/custom-models/:id  body { name, baseProvider, endpoint, apiKey? } → update (key optional).
	private handleUpdateCustomModel(req: express.Request, res: express.Response): void {
		const id = String(req.params.id);
		const userId = this.getUserId(req);
		if (!this.auth.getStore().getCustomModel(userId, id)) {
			res.status(404).json({ error: "Custom model not found" });
			return;
		}
		const parsed = this.parseCustomModelBody(req, false);
		if ("error" in parsed) {
			res.status(400).json({ error: parsed.error });
			return;
		}
		try {
			const encryptedKey = parsed.apiKey ? encryptSecret(parsed.apiKey) : undefined;
			this.auth.getStore().updateCustomModel(userId, id, {
				name: parsed.name,
				baseProvider: parsed.baseProvider,
				endpoint: parsed.endpoint,
				encryptedKey,
			});
			res.json({ ok: true });
		} catch (err) {
			res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
		}
	}

	// DELETE /llm/custom-models/:id → forget the custom model.
	private handleDeleteCustomModel(req: express.Request, res: express.Response): void {
		this.auth.getStore().deleteCustomModel(this.getUserId(req), String(req.params.id));
		res.json({ ok: true });
	}

	private safeUserId(userId: string): string {
		return safeConnectorUserId(userId);
	}

	private getUsersRoot(): string {
		return join(this.workingDir, "users");
	}

	private getConnectorEnv(userId: string, connector: ConnectorRuntime): NodeJS.ProcessEnv {
		const usersRoot = this.getUsersRoot();
		ensureConnectorHome(usersRoot, userId, connector.id);
		return {
			...process.env,
			...connector.env({ userId, usersRoot }),
		};
	}

	private resolveConnector(connectorId: string, kind?: "agent-runtime" | "business-connector"): ConnectorRuntime | undefined {
		const connector = getConnectorRuntime(connectorId);
		if (!connector) return undefined;
		if (kind && connector.kind !== kind) return undefined;
		if (!this.features.agentWorkers && connector.kind === "agent-runtime") return undefined;
		return connector;
	}

	private extractUrl(text: string): string | undefined {
		return text.match(/https?:\/\/[^\s)]+/)?.[0];
	}

	private serializeConnector(req: express.Request, connector: ConnectorRuntime) {
		const userId = this.getUserId(req);
		const usersRoot = this.getUsersRoot();
		return {
			id: connector.id,
			label: connector.label,
			kind: connector.kind,
			authMode: connector.authMode,
			connected: connectorHomeHasFiles(usersRoot, userId, connector.id),
			usedByAgents: connector.usedByAgents ?? [],
			accessPolicy: connector.accessPolicy,
		};
	}

	private handleFeatures(res: express.Response): void {
		res.json({ features: { agentWorkers: this.features.agentWorkers, reminders: this.features.reminders } });
	}

	private handleConnectors(req: express.Request, res: express.Response): void {
		const kind = typeof req.query.kind === "string" ? req.query.kind : undefined;
		if (kind === "agent-runtime" && !this.features.agentWorkers) {
			res.json({ connectors: [] });
			return;
		}
		const connectors = listConnectorRuntimes(kind === "agent-runtime" || kind === "business-connector" ? kind : undefined)
			.filter((connector) => this.features.agentWorkers || connector.kind !== "agent-runtime")
			.map((connector) => this.serializeConnector(req, connector));
		res.json({ connectors });
	}

	private handleConnectorStatus(req: express.Request, res: express.Response): void {
		const connector = this.resolveConnector(String(req.params.connector));
		if (!connector) {
			res.status(404).json({ error: "Unknown connector" });
			return;
		}
		res.json(this.serializeConnector(req, connector));
	}

	private handleConnectorLogin(req: express.Request, res: express.Response): void {
		const connector = this.resolveConnector(String(req.params.connector));
		if (!connector?.command || !connector.loginCommand) {
			res.status(404).json({ error: "Connector login is not configured" });
			return;
		}
		this.startConnectorLogin(req, res, connector);
	}

	private handleConnectorLoginStatus(req: express.Request, res: express.Response): void {
		this.writeConnectorLoginStatus(req, res, String(req.params.connector), "connector");
	}

	private handleConnectorLoginInput(req: express.Request, res: express.Response): void {
		this.writeConnectorLoginInput(req, res, String(req.params.connector));
	}

	private handleConnectorLogout(req: express.Request, res: express.Response): void {
		const connector = this.resolveConnector(String(req.params.connector));
		if (!connector?.command || !connector.logoutCommand) {
			res.status(404).json({ error: "Connector logout is not configured" });
			return;
		}
		this.logoutConnector(req, res, connector);
	}

	private handleConnectorExec(req: express.Request, res: express.Response): void {
		const connector = this.resolveConnector(String(req.params.connector), "business-connector");
		if (!connector?.command || !connector.accessPolicy.allowedInHost) {
			res.status(404).json({ error: "Connector command proxy is not configured" });
			return;
		}
		const body = req.body as { argv?: unknown; cwd?: unknown; timeoutMs?: unknown };
		const argv = Array.isArray(body.argv) ? body.argv.map(String) : [];
		const timeoutMs = Math.min(Math.max(Number(body.timeoutMs ?? 120000) || 120000, 1000), 300000);
		const cwd = this.resolveConnectorExecCwd(typeof body.cwd === "string" ? body.cwd : undefined);
		if (!cwd) {
			res.status(403).json({ error: "Connector cwd is outside the workspace root" });
			return;
		}
		const userId = this.getUserId(req);
		const child = spawn(connector.command, argv, {
			env: this.getConnectorEnv(userId, connector),
			cwd,
			stdio: ["ignore", "pipe", "pipe"],
		});
		let stdout = "";
		let stderr = "";
		let responded = false;
		const trim = (text: string) => text.length > 10 * 1024 * 1024 ? text.slice(-10 * 1024 * 1024) : text;
		const timeout = setTimeout(() => child.kill("SIGTERM"), timeoutMs);
		child.stdout.on("data", (chunk: Buffer) => { stdout = trim(stdout + chunk.toString("utf-8")); });
		child.stderr.on("data", (chunk: Buffer) => { stderr = trim(stderr + chunk.toString("utf-8")); });
		child.on("error", (err) => {
			clearTimeout(timeout);
			responded = true;
			res.status(500).json({ stdout, stderr: stderr || err.message, exitCode: 1, error: err.message });
		});
		child.on("close", (code) => {
			clearTimeout(timeout);
			if (responded) return;
			res.json({ stdout, stderr, exitCode: code ?? 0 });
		});
	}

	private resolveConnectorExecCwd(cwd?: string): string | undefined {
		const root = resolve(this.workingDir);
		const resolved = cwd
			? resolve(cwd.startsWith("/") ? cwd : join(this.workingDir, cwd))
			: root;
		if (resolved !== root && !resolved.startsWith(`${root}/`)) return undefined;
		return resolved;
	}

	private handleAgentWorkers(req: express.Request, res: express.Response): void {
		if (!this.features.agentWorkers) {
			res.json({ agents: [] });
			return;
		}
		res.json({
			agents: listConnectorRuntimes("agent-runtime").map((connector) => this.serializeConnector(req, connector)),
		});
	}

	private handleAgentWorkerStatus(req: express.Request, res: express.Response): void {
		if (!this.features.agentWorkers) {
			res.status(404).json({ error: "Agent workers are disabled" });
			return;
		}
		const agent = String(req.params.agent);
		const connector = this.resolveConnector(agent, "agent-runtime");
		if (!connector) {
			res.status(404).json({ error: "Unknown agent worker" });
			return;
		}
		const userId = this.getUserId(req);
		const usersRoot = this.getUsersRoot();
		res.json({
			id: agent,
			label: connector.label,
			connected: connectorHomeHasFiles(usersRoot, userId, agent),
			authMode: connector.authMode,
			kind: connector.kind,
			usedByAgents: connector.usedByAgents ?? [],
		});
	}

	private startConnectorLogin(req: express.Request, res: express.Response, connector: ConnectorRuntime): void {
		const userId = this.getUserId(req);
		const loginId = this.createLoginId();
		const entry: PendingAgentWorkerLogin = {
			userId,
			connectorId: connector.id,
			status: "pending",
			createdAt: Date.now(),
			output: "",
		};
		this.pendingAgentWorkerLogins.set(loginId, entry);
		const home = ensureConnectorHome(this.getUsersRoot(), userId, connector.id);

		const child = spawn(connector.command!, connector.loginCommand!, {
			env: this.getConnectorEnv(userId, connector),
			cwd: home,
			stdio: ["pipe", "pipe", "pipe"],
		});
		entry.child = child;
		const onData = (chunk: Buffer) => {
			entry.output += chunk.toString("utf-8");
			if (entry.output.length > 20000) entry.output = entry.output.slice(-20000);
			entry.url = entry.url ?? this.extractUrl(entry.output);
		};
		child.stdout.on("data", onData);
		child.stderr.on("data", onData);
		child.on("error", (err) => {
			entry.status = "error";
			entry.error = err.message;
		});
		child.on("exit", (code) => {
			entry.status = code === 0 ? "complete" : "error";
			if (code !== 0) entry.error = `Login exited with code ${code}`;
			entry.child = undefined;
		});

		res.status(201).json({
			loginId,
			agent: connector.id,
			connector: connector.id,
			label: connector.label,
			status: entry.status,
			url: entry.url,
			output: entry.output,
			statusUrl: `/auth/connectors/${encodeURIComponent(connector.id)}/login/${encodeURIComponent(loginId)}`,
			inputUrl: `/auth/connectors/${encodeURIComponent(connector.id)}/login/${encodeURIComponent(loginId)}/input`,
		});
	}

	private handleAgentWorkerLogin(req: express.Request, res: express.Response): void {
		if (!this.features.agentWorkers) {
			res.status(404).json({ error: "Agent workers are disabled" });
			return;
		}
		const agent = String(req.params.agent);
		const connector = this.resolveConnector(agent, "agent-runtime");
		if (!connector?.command || !connector.loginCommand) {
			res.status(404).json({ error: "Unknown agent worker" });
			return;
		}
		this.startConnectorLogin(req, res, connector);
	}

	private writeConnectorLoginStatus(req: express.Request, res: express.Response, connectorId: string, fieldName: "agent" | "connector"): void {
		const entry = this.pendingAgentWorkerLogins.get(String(req.params.loginId));
		if (!entry || entry.connectorId !== connectorId) {
			res.status(404).json({ error: "Login not found" });
			return;
		}
		res.json({
			status: entry.status,
			[fieldName]: entry.connectorId,
			url: entry.url,
			output: entry.output,
			error: entry.error,
			createdAt: entry.createdAt,
		});
	}

	private handleAgentWorkerLoginStatus(req: express.Request, res: express.Response): void {
		if (!this.features.agentWorkers) {
			res.status(404).json({ error: "Agent workers are disabled" });
			return;
		}
		this.writeConnectorLoginStatus(req, res, String(req.params.agent), "agent");
	}

	private writeConnectorLoginInput(req: express.Request, res: express.Response, connectorId: string): void {
		const entry = this.pendingAgentWorkerLogins.get(String(req.params.loginId));
		if (!entry || entry.connectorId !== connectorId) {
			res.status(404).json({ error: "Login not found" });
			return;
		}
		const { input } = req.body as { input?: string };
		if (entry.status !== "pending" || !entry.child || input === undefined) {
			res.status(409).json({ error: `Login is ${entry.status}` });
			return;
		}
		entry.child.stdin.write(`${input}\n`);
		res.json({ ok: true, status: entry.status });
	}

	private handleAgentWorkerLoginInput(req: express.Request, res: express.Response): void {
		if (!this.features.agentWorkers) {
			res.status(404).json({ error: "Agent workers are disabled" });
			return;
		}
		this.writeConnectorLoginInput(req, res, String(req.params.agent));
	}

	private logoutConnector(req: express.Request, res: express.Response, connector: ConnectorRuntime): void {
		const userId = this.getUserId(req);
		const home = getConnectorHome(this.getUsersRoot(), userId, connector.id);
		const child = spawn(connector.command!, connector.logoutCommand!, {
			env: this.getConnectorEnv(userId, connector),
			cwd: home,
			stdio: ["ignore", "ignore", "ignore"],
		});
		child.once("exit", () => {
			try { rmSync(home, { recursive: true, force: true }); } catch { /* ignore */ }
		});
		res.json({ ok: true });
	}

	private handleAgentWorkerLogout(req: express.Request, res: express.Response): void {
		if (!this.features.agentWorkers) {
			res.status(404).json({ error: "Agent workers are disabled" });
			return;
		}
		const agent = String(req.params.agent);
		const connector = this.resolveConnector(agent, "agent-runtime");
		if (!connector?.command || !connector.logoutCommand) {
			res.status(404).json({ error: "Unknown agent worker" });
			return;
		}
		this.logoutConnector(req, res, connector);
	}

	private handleWorkspaces(req: express.Request, res: express.Response): void {
		const userId = this.getUserId(req);
		this.workspaceStore.ensureDefaultWorkspace(userId);
		res.json(this.workspaceStore.listWorkspaces(userId));
	}

	private handleCreateWorkspace(req: express.Request, res: express.Response): void {
		const { name, userName, templateId, type } = req.body as { name?: string; userName?: string; templateId?: string; type?: string };
		const userId = this.getUserId(req, userName);
		const workspace = this.workspaceStore.createWorkspace({ name: name || "New workspace", userId, templateId: templateId ?? type });
		res.status(201).json(workspace);
	}

	private handleWorkspaceSettings(req: express.Request, res: express.Response): void {
		try {
			res.json(this.workspaceStore.getWorkspaceSettings(this.getUserId(req), String(req.params.workspaceId)));
		} catch (err) {
			res.status(403).json({ error: err instanceof Error ? err.message : String(err) });
		}
	}

	private handleUpdateWorkspaceSettings(req: express.Request, res: express.Response): void {
		try {
			res.json(this.workspaceStore.updateWorkspaceSettings(this.getUserId(req), String(req.params.workspaceId), req.body ?? {}));
		} catch (err) {
			res.status(403).json({ error: err instanceof Error ? err.message : String(err) });
		}
	}

	private async handleWorkspaceSandbox(req: express.Request, res: express.Response): Promise<void> {
		try {
			const userId = this.getUserId(req);
			const workspaceId = String(req.params.workspaceId);
			this.workspaceStore.assertWorkspaceAccess(userId, workspaceId);
			const workspaceRoot = this.workspaceStore.getWorkspaceRoot(workspaceId);
			res.json(await getWorkspaceSandboxStatus(this.sandboxConfig, {
				workspaceId,
				workspaceRoot,
				dataRoot: this.workingDir,
				usersRoot: join(this.workingDir, "users"),
				memberUserIds: this.workspaceStore.getWorkspaceMembers(workspaceId).map((member) => member.userId),
				image: this.workspaceStore.getWorkspaceSandboxImage(workspaceId),
			}));
		} catch (err) {
			res.status(403).json({ error: err instanceof Error ? err.message : String(err) });
		}
	}

	private handleWorkspaceEvents(req: express.Request, res: express.Response): void {
		if (!this.features.reminders) {
			res.json({ events: [] });
			return;
		}
		try {
			const userId = this.getUserId(req);
			const workspaceId = String(req.params.workspaceId);
			this.workspaceStore.assertWorkspaceAccess(userId, workspaceId);
			const eventsDir = join(this.workspaceStore.getWorkspaceRoot(workspaceId), "events");
			if (!existsSync(eventsDir)) {
				res.json({ events: [] });
				return;
			}

			const events = readdirSync(eventsDir, { withFileTypes: true })
				.filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
				.map((entry) => {
					const filePath = join(eventsDir, entry.name);
					const content = existsSync(filePath) ? readFileSync(filePath, "utf-8") : "";
					let data: Record<string, unknown> = {};
					let valid = true;
					let error: string | undefined;
					try {
						data = JSON.parse(content) as Record<string, unknown>;
					} catch (err) {
						valid = false;
						error = err instanceof Error ? err.message : String(err);
					}
					return {
						filename: entry.name,
						type: typeof data.type === "string" ? data.type : "unknown",
						channelId: typeof data.channelId === "string" ? data.channelId : "",
						text: typeof data.text === "string" ? data.text : "",
						at: typeof data.at === "string" ? data.at : undefined,
						schedule: typeof data.schedule === "string" ? data.schedule : undefined,
						timezone: typeof data.timezone === "string" ? data.timezone : undefined,
						modifiedAt: existsSync(filePath) ? Math.round(statSync(filePath).mtimeMs) : 0,
						valid,
						error,
					};
				})
				.sort((a, b) => a.filename.localeCompare(b.filename));
			res.json({ events });
		} catch (err) {
			res.status(403).json({ error: err instanceof Error ? err.message : String(err) });
		}
	}

	private handleDeleteWorkspaceEvent(req: express.Request, res: express.Response): void {
		if (!this.features.reminders) {
			res.status(403).json({ error: "Reminders are disabled" });
			return;
		}
		try {
			const userId = this.getUserId(req);
			const workspaceId = String(req.params.workspaceId);
			const filename = basename(decodeURIComponent(String(req.params.filename)));
			if (!filename || filename !== decodeURIComponent(String(req.params.filename)) || !filename.endsWith(".json")) {
				res.status(400).json({ error: "Invalid event filename" });
				return;
			}
			this.workspaceStore.assertWorkspaceAccess(userId, workspaceId);
			const filePath = join(this.workspaceStore.getWorkspaceRoot(workspaceId), "events", filename);
			if (existsSync(filePath)) rmSync(filePath, { force: true });
			res.json({ ok: true });
		} catch (err) {
			res.status(403).json({ error: err instanceof Error ? err.message : String(err) });
		}
	}

	private getDatabaseFromFile(req: express.Request, res: express.Response): WorkspaceDatabase | undefined {
		const dbPath = String(req.query.path ?? "");
		const resolved = this.resolveReadableWorkspaceFile(req, dbPath, res);
		if (!resolved) return undefined;
		if (!resolved.toLowerCase().endsWith(".duckdb")) {
			res.status(400).json({ error: "Not a DuckDB file" });
			return undefined;
		}
		return new WorkspaceDatabase(resolved);
	}

	private handleDatabaseTables(req: express.Request, res: express.Response): void {
		const db = this.getDatabaseFromFile(req, res);
		if (!db) return;
		res.json({
			database: db.filename,
			available: db.exists,
			tables: db.listTables(),
		});
	}

	private handleDatabaseRows(req: express.Request, res: express.Response): void {
		const db = this.getDatabaseFromFile(req, res);
		if (!db) return;
		const tableName = decodeURIComponent(String(req.params.tableName));
		const table = db.getTableRows(tableName, {
			limit: Number(req.query.limit ?? 100),
			offset: Number(req.query.offset ?? 0),
		});
		if (!table) {
			res.status(404).json({ error: "Table not found" });
			return;
		}
		res.json(table);
	}

	private handleWorkspaceSessions(req: express.Request, res: express.Response): void {
		const userId = this.getUserId(req);
		const workspaceId = String(req.params.workspaceId);
		try {
			res.json(this.workspaceStore.listSessions(userId, workspaceId));
		} catch (err) {
			res.status(403).json({ error: err instanceof Error ? err.message : String(err) });
		}
	}

	private handleCreateSession(req: express.Request, res: express.Response): void {
		const { title, userName } = req.body as { title?: string; userName?: string };
		const userId = this.getUserId(req, userName);
		const workspaceId = String(req.params.workspaceId);
		try {
			const session = this.workspaceStore.createSession({ workspaceId, userId, title });
			res.status(201).json(session);
		} catch (err) {
			res.status(403).json({ error: err instanceof Error ? err.message : String(err) });
		}
	}

	private async handleChat(req: express.Request, res: express.Response, routeSessionId?: string): Promise<void> {
		type AttachmentPayload = { fileName: string; mimeType: string; content: string };
		const { channelId, sessionId: bodySessionId, workspaceId, text, userName = "user", attachments = [], model: modelSel } = req.body as {
			channelId?: string; sessionId?: string; workspaceId?: string; text?: string; userName?: string; attachments?: AttachmentPayload[];
			model?: { provider?: string; modelId?: string }; //IYH1HC add
		};
		const sessionId = routeSessionId || bodySessionId || channelId;
		const userId = this.getUserId(req, userName);

		//IYH1HC add: resolve the per-run model override (decrypt the user's key here).
		let resolvedModel: BotContext["model"];
		if (modelSel?.provider && modelSel?.modelId && this.isAllowedLlmProvider(modelSel.provider)) {
			const encrypted = this.auth.getStore().getProviderKey(userId, modelSel.provider);
			let apiKey: string | undefined;
			if (encrypted) {
				try {
					apiKey = decryptSecret(encrypted);
				} catch (err) {
					log.logWarning("[llm] failed to decrypt provider key", err instanceof Error ? err.message : String(err));
				}
			}
			resolvedModel = { provider: modelSel.provider, modelId: modelSel.modelId, apiKey };
		} else if (modelSel?.provider === "custom" && modelSel?.modelId) {
			//IYH1HC add: custom model (Bosch GenAI) — resolve to its base provider's request
			// format but fetch through the user-configured gateway endpoint (baseUrl override).
			const cm = this.auth.getStore().getCustomModel(userId, modelSel.modelId);
			if (cm) {
				let apiKey: string | undefined;
				try {
					apiKey = decryptSecret(cm.encryptedKey);
				} catch (err) {
					log.logWarning("[llm] failed to decrypt custom model key", err instanceof Error ? err.message : String(err));
				}
				// For an OpenAI base provider, use the classic Chat Completions API and normalise
				// the endpoint. The OpenAI client appends /chat/completions and drops any query, so
				// the user's full Azure URL (…/deployments/<dep>/chat/completions?api-version=…) is
				// reduced to its deployment base here; the bosch-genai fetch adapter re-attaches the
				// api-version query + api-key header at request time. The Responses API default
				// ({endpoint}/responses) is not exposed by these gateways → 404. google/anthropic keep
				// their defaults (generateContent / v1/messages).
				const isOpenAiBase = cm.baseProvider === "openai";
				resolvedModel = {
					provider: cm.baseProvider,   // openai|google|anthropic → drives header/body format
					modelId: cm.name,            // placeholder; the gateway routes by endpoint
					apiKey,
					baseUrl: isOpenAiBase ? prepareBoschOpenAIEndpoint(cm.endpoint) : cm.endpoint,
					apiType: isOpenAiBase ? "openai-completions" : undefined,
				};
			}
		}

		if (!sessionId || !text) {
			res.status(400).json({ error: "Missing sessionId or text" });
			return;
		}

		const session = this.workspaceStore.ensureSession({ sessionId, workspaceId, userId });
		try {
			this.workspaceStore.assertWorkspaceAccess(userId, session.workspaceId);
		} catch (err) {
			res.status(403).json({ error: err instanceof Error ? err.message : String(err) });
			return;
		}
		const workspaceRoot = this.workspaceStore.getWorkspaceRoot(session.workspaceId);

		res.writeHead(200, {
			"Content-Type": "text/event-stream",
			"Cache-Control": "no-cache",
			Connection: "keep-alive",
		});

		const send: SseEmitter = (event) => {
			if (!res.writableEnded) res.write(`data: ${JSON.stringify(event)}\n\n`);
		};

		const ts = (Date.now() / 1000).toFixed(6);
		const channelDir = join(workspaceRoot, "sessions", sessionId);
		if (!existsSync(channelDir)) mkdirSync(channelDir, { recursive: true });

		const savedAttachments: Array<{ local: string }> = [];
		if (attachments.length > 0) {
			const attachDir = join(channelDir, "attachments");
			if (!existsSync(attachDir)) mkdirSync(attachDir, { recursive: true });
			for (const att of attachments) {
				const safeName = `${Date.now()}_${att.fileName.replace(/[^a-zA-Z0-9._-]/g, "_")}`;
				const filePath = join(attachDir, safeName);
				writeFileSync(filePath, Buffer.from(att.content, "base64"));
				savedAttachments.push({ local: `sessions/${sessionId}/attachments/${safeName}` });
			}
		}

		const ctx = createHttpContext({
			channelId: sessionId,
			userName,
			text,
			ts,
			send,
			workingDir: workspaceRoot,
			attachments: savedAttachments,
			userId,
			authFilePath: this.getUserAuthFilePath(userId),
			model: resolvedModel, //IYH1HC add
		});

		appendFileSync(
			join(channelDir, "log.jsonl"),
			`${JSON.stringify({ date: new Date().toISOString(), ts, user: userId, userName, text, attachments: savedAttachments, isBot: false })}\n`,
		);

		log.logInfo(`[${sessionId}] HTTP: Starting run: ${text.substring(0, 50)}`);

		try {
			await this.handler.handleEvent(sessionId, ctx);
			send({ type: "done" });
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			log.logWarning(`[${sessionId}] HTTP run error`, msg);
			send({ type: "error", message: msg });
		} finally {
			res.end();
		}
	}

	private async handleStop(req: express.Request, res: express.Response): Promise<void> {
		const { channelId } = req.body as { channelId?: string };
		if (!channelId) {
			res.status(400).json({ error: "Missing channelId" });
			return;
		}
		const session = this.workspaceStore.findSession(channelId);
		if (!session) {
			res.status(404).json({ error: "Session not found" });
			return;
		}
		try {
			this.workspaceStore.assertWorkspaceAccess(this.getUserId(req), session.workspaceId);
		} catch (err) {
			res.status(403).json({ error: err instanceof Error ? err.message : String(err) });
			return;
		}

		if (this.handler.isRunning(channelId)) {
			await this.handler.handleStop(channelId, async () => {}, async () => {});
			res.json({ ok: true, message: "Stopping..." });
		} else {
			res.json({ ok: false, message: "Nothing running" });
		}
	}

	private handleStatus(req: express.Request, channelId: string, res: express.Response): void {
		const session = this.workspaceStore.findSession(channelId);
		if (!session) {
			res.status(404).json({ error: "Session not found" });
			return;
		}
		try {
			this.workspaceStore.assertWorkspaceAccess(this.getUserId(req), session.workspaceId);
		} catch (err) {
			res.status(403).json({ error: err instanceof Error ? err.message : String(err) });
			return;
		}
		res.json({ running: this.handler.isRunning(channelId) });
	}

	private getAuthorizedSession(req: express.Request, channelId: string, res: express.Response) {
		const session = this.workspaceStore.findSession(channelId);
		if (!session) {
			res.status(404).json({ error: "Session not found" });
			return undefined;
		}
		try {
			this.workspaceStore.assertWorkspaceAccess(this.getUserId(req), session.workspaceId);
		} catch (err) {
			res.status(403).json({ error: err instanceof Error ? err.message : String(err) });
			return undefined;
		}
		return session;
	}

	private handleAcpJobs(req: express.Request, channelId: string, res: express.Response): void {
		const session = this.getAuthorizedSession(req, channelId, res);
		if (!session) return;
		if (!this.features.agentWorkers) {
			res.json({ jobs: [] });
			return;
		}
		const workspaceRoot = this.workspaceStore.getWorkspaceRoot(session.workspaceId);
		res.json({ jobs: listAcpJobs(workspaceRoot, channelId) });
	}

	private handleCancelAcpJob(req: express.Request, channelId: string, jobId: string, res: express.Response): void {
		const session = this.getAuthorizedSession(req, channelId, res);
		if (!session) return;
		if (!this.features.agentWorkers) {
			res.status(403).json({ ok: false, error: "Agent workers are disabled" });
			return;
		}
		const workspaceRoot = this.workspaceStore.getWorkspaceRoot(session.workspaceId);
		const ok = cancelAcpJob(workspaceRoot, jobId);
		res.json({ ok });
	}

	private handleArtifactUrl(req: express.Request, filePath: string, res: express.Response): void {
		const resolved = this.resolveReadableWorkspaceFile(req, filePath, res);
		if (!resolved) {
			return;
		}
		let url = `http://localhost:${this.port}/file?path=${encodeURIComponent(resolved)}`;

		const tunnelUrlFile = "/tmp/artifacts-url.txt";
		if (existsSync(tunnelUrlFile)) {
			try {
				const tunnelUrl = readFileSync(tunnelUrlFile, "utf-8").trim();
				if (tunnelUrl && !tunnelUrl.includes("localhost") && !tunnelUrl.includes("127.0.0.1")) {
					url = `${tunnelUrl}/file?path=${encodeURIComponent(resolved)}`;
				}
			} catch { /* use local fallback */ }
		}

		res.json({ url });
	}

	private handleWorkspace(req: express.Request, channelId: string, res: express.Response): void {
		type WorkspaceNode = { name: string; path: string; type: "file" | "directory"; children?: WorkspaceNode[] };

		const makeTree = (rootPath: string, relativeBase: string): WorkspaceNode[] => {
			if (!existsSync(rootPath)) return [];
			const walk = (absDir: string, relDir: string): WorkspaceNode[] => {
				const entries = readdirSync(absDir, { withFileTypes: true }).sort((a: Dirent, b: Dirent) => {
					if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
					return a.name.localeCompare(b.name);
				});
				return entries.map((entry) => {
					const relPath = relDir ? `${relDir}/${entry.name}` : entry.name;
					const normalizedPath = relativeBase ? `${relativeBase}/${relPath}` : relPath;
					if (entry.isDirectory()) {
						return {
							name: entry.name,
							path: normalizedPath,
							type: "directory" as const,
							children: walk(join(absDir, entry.name), relPath),
						};
					}
					return { name: entry.name, path: normalizedPath, type: "file" as const };
				});
			};
			return walk(rootPath, "");
		};

		const userId = this.getUserId(req);
		const session = this.workspaceStore.findSession(channelId) ?? this.workspaceStore.ensureSession({ sessionId: channelId, userId });
		try {
			this.workspaceStore.assertWorkspaceAccess(userId, session.workspaceId);
		} catch (err) {
			res.status(403).json({ error: err instanceof Error ? err.message : String(err) });
			return;
		}
		const workspaceRoot = this.workspaceStore.getWorkspaceRoot(session.workspaceId);
		const artifactsRoot = join(workspaceRoot, "artifacts");
		const workspaceSkillsRoot = join(workspaceRoot, "skills");

		res.json({
			artifacts: makeTree(artifactsRoot, `workspaces/${session.workspaceId}/artifacts`),
			skills: makeTree(workspaceSkillsRoot, `workspaces/${session.workspaceId}/skills`),
		});
	}

	private handleFile(req: express.Request, filePath: string, res: express.Response): void {
		const resolved = this.resolveReadableWorkspaceFile(req, filePath, res);
		if (!resolved) {
			return;
		}

		if (!existsSync(resolved)) {
			res.status(404).json({ error: "Not found" });
			return;
		}

		const ext = extname(resolved).slice(1).toLowerCase();
		const mimeType = BINARY_MIME_TYPES[ext];
		if (mimeType) {
			res.type(mimeType);
		}
		if (req.query.download === "1") {
			res.attachment(basename(resolved));
		}

		res.sendFile(resolved);
	}

	private handleMessages(req: express.Request, channelId: string, res: express.Response): void {
		type ContextEntry = { type: string; timestamp?: string; message?: Record<string, any> };
		type ChatMessage = { role: "user" | "assistant"; text: string; attachments?: string[]; thread?: string; files?: Array<{ path: string; title?: string }> };

		const formatArgs = (args: Record<string, any>): string => {
			const lines: string[] = [];
			for (const [key, value] of Object.entries(args)) {
				if (key === "label") continue;
				if (key === "path" && typeof value === "string") {
					const range = args.offset !== undefined && args.limit !== undefined
						? `:${args.offset}-${args.offset + args.limit}` : "";
					lines.push(value + range);
					continue;
				}
				if (key === "offset" || key === "limit") continue;
				const str = typeof value === "string" ? value : JSON.stringify(value);
				lines.push(str.length > 300 ? str.slice(0, 300) + "…" : str);
			}
			return lines.join("\n");
		};

		const userId = this.getUserId(req);
		const session = this.workspaceStore.findSession(channelId) ?? this.workspaceStore.ensureSession({ sessionId: channelId, userId });
		try {
			this.workspaceStore.assertWorkspaceAccess(userId, session.workspaceId);
		} catch (err) {
			res.status(403).json({ error: err instanceof Error ? err.message : String(err) });
			return;
		}
		const workspaceRoot = this.workspaceStore.getWorkspaceRoot(session.workspaceId);
		const contextFile = join(workspaceRoot, "sessions", channelId, "context.jsonl");
		const messages: ChatMessage[] = [];

		if (existsSync(contextFile)) {
			try {
				const lines = readFileSync(contextFile, "utf-8").trim().split("\n").filter(Boolean);
				const entries: ContextEntry[] = [];
				for (const line of lines) {
					try { entries.push(JSON.parse(line)); } catch { /* skip */ }
				}

				type ToolCall = { id: string; name: string; label?: string; args: Record<string, any> };
				type ToolResult = { toolCallId: string; toolName: string; text: string; isError: boolean };
				type Turn = { userText: string; attachments: string[]; toolCalls: ToolCall[]; toolResults: ToolResult[]; assistantTexts: string[] };
				const normalizeAttachedFilePath = (rawPath: string): string => {
					const dockerWorkspacePrefix = `/workspace/workspaces/${session.workspaceId}/`;
					if (rawPath === `/workspace/workspaces/${session.workspaceId}`) return workspaceRoot;
					if (rawPath.startsWith(dockerWorkspacePrefix)) return join(workspaceRoot, rawPath.slice(dockerWorkspacePrefix.length));
					if (rawPath === "/workspace") return workspaceRoot;
					if (rawPath.startsWith("/workspace/")) return join(workspaceRoot, rawPath.slice("/workspace/".length));
					if (isAbsolute(rawPath)) return rawPath;
					if (rawPath.startsWith("workspaces/")) return rawPath;
					if (rawPath.startsWith("artifacts/") || rawPath.startsWith("sessions/") || rawPath.startsWith("skills/")) {
						return join(workspaceRoot, rawPath);
					}
					return join(workspaceRoot, "artifacts", rawPath);
				};

				const stripPrefix = (text: string) =>
					text.replace(/^(?:\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}\] )?\[[^\]]+\]: /, "");

				const extractAttachments = (text: string): { text: string; attachments: string[] } => {
					const match = text.match(/<attachments>\n([\s\S]*?)\n<\/attachments>/);
					if (!match) return { text, attachments: [] };
					const names = match[1].split("\n").filter(Boolean).map((p) => p.split(/[/\\]/).pop() ?? p);
					return { text: text.replace(/\n\n<attachments>[\s\S]*?<\/attachments>/, "").trim(), attachments: names };
				};

				const turns: Turn[] = [];

				for (const entry of entries) {
					if (entry.type !== "message" || !entry.message) continue;
					const msg = entry.message;

					if (msg.role === "user") {
						const textPart = (msg.content as any[])?.find((c: any) => c.type === "text");
						if (!textPart?.text) continue;
						const { text: cleanText, attachments } = extractAttachments(stripPrefix(textPart.text));
						turns.push({ userText: cleanText, attachments, toolCalls: [], toolResults: [], assistantTexts: [] });
					} else if (msg.role === "assistant") {
						if (turns.length === 0) continue;
						const turn = turns[turns.length - 1];
						for (const part of (msg.content as any[]) || []) {
							if (part.type === "toolCall") {
								turn.toolCalls.push({ id: part.id, name: part.name, label: part.arguments?.label, args: part.arguments ?? {} });
							} else if (part.type === "text" && part.text?.trim()) {
								turn.assistantTexts.push(part.text.trim());
							}
						}
					} else if (msg.role === "toolResult") {
						if (turns.length === 0) continue;
						const turn = turns[turns.length - 1];
						const text = (msg.content as any[])?.find((c: any) => c.type === "text")?.text ?? "";
						turn.toolResults.push({ toolCallId: msg.toolCallId, toolName: msg.toolName, text, isError: msg.isError });
					}
				}

				for (const turn of turns) {
					messages.push({ role: "user", text: turn.userText, attachments: turn.attachments.length > 0 ? turn.attachments : undefined });

					const mainText = turn.assistantTexts[turn.assistantTexts.length - 1] ?? "";
					const threadParts: string[] = [];
					const files: Array<{ path: string; title?: string }> = [];

					for (const tc of turn.toolCalls) {
						const result = turn.toolResults.find((r) => r.toolCallId === tc.id);
						let block = `**${result?.isError ? "✗" : "✓"} ${tc.name}**`;
						if (tc.label) block += `: ${tc.label}`;
						const argsStr = formatArgs(tc.args);
						if (argsStr) block += `\n\`\`\`\n${argsStr}\n\`\`\``;
						if (result) {
							const resultStr = result.text;
							block += `\n**Result:**\n\`\`\`\n${resultStr.slice(0, 500)}${resultStr.length > 500 ? "\n…" : ""}\n\`\`\``;
						}
						threadParts.push(block);
						if (tc.name === "attach" && tc.args.path) {
							files.push({
								path: normalizeAttachedFilePath(tc.args.path as string),
								title: tc.args.title as string | undefined,
							});
						}
					}

					const thread = threadParts.length > 0 ? threadParts.join("\n\n") : undefined;
					if (mainText || thread) {
						messages.push({ role: "assistant", text: mainText, thread, files: files.length > 0 ? files : undefined });
					}
				}
			} catch { /* unreadable file */ }
		}

		res.json(messages);
	}

	private handleSessions(req: express.Request, res: express.Response): void {
		const userId = this.getUserId(req);
		const workspaceId = String(req.query.workspaceId || this.workspaceStore.ensureDefaultWorkspace(userId).id);
		try {
			res.json(this.workspaceStore.listSessions(userId, workspaceId));
		} catch (err) {
			res.status(403).json({ error: err instanceof Error ? err.message : String(err) });
		}
	}
}
