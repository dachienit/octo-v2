import { Dirent, appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "fs";
import { basename, extname, isAbsolute, join, resolve } from "path";
import { getProviderAuthStatus, loginProvider } from "@octo/core";
import express from "express";
import { CoreServiceAuth } from "./auth.js";
import { GithubSsoProvider, loadSsoConfig } from "./sso.js"; //IYH1HC add
import * as log from "./log.js";
import type { BotContext, BotHandler } from "./types.js";
import { WorkspaceDatabase } from "./workspace-database.js";
import { WorkspaceStore } from "./workspaces.js";

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

const BINARY_MIME_TYPES: Record<string, string> = {
	doc: "application/msword",
	docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
	ppt: "application/vnd.ms-powerpoint",
	pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
	xls: "application/vnd.ms-excel",
	xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
	zip: "application/zip",
};

function createHttpContext(opts: {
	channelId: string;
	userName: string;
	text: string;
	ts: string;
	send: SseEmitter;
	workingDir: string;
	attachments?: Array<{ local: string }>;
	userId?: string;
	authFilePath?: string;
}): BotContext {
	const { channelId, userName, text, ts, send, workingDir, attachments = [], userId = "web-user", authFilePath } = opts;

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
	private auth: CoreServiceAuth;
	private pendingAuthLogins = new Map<string, PendingAuthLogin>();
	private sso: GithubSsoProvider | null; //IYH1HC add

	constructor(config: { port: number; workingDir: string; handler: BotHandler; workspaceStore: WorkspaceStore }) {
		this.port = config.port;
		this.workingDir = config.workingDir;
		this.handler = config.handler;
		this.workspaceStore = config.workspaceStore;
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
			res.setHeader("Access-Control-Allow-Methods", "POST, GET, PATCH, OPTIONS");
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
		app.get("/workspaces",      (req, res) => this.handleWorkspaces(req, res));
		app.post("/workspaces",     (req, res) => this.handleCreateWorkspace(req, res));
		app.get("/workspaces/:workspaceId/settings", (req, res) => this.handleWorkspaceSettings(req, res));
		app.patch("/workspaces/:workspaceId/settings", (req, res) => this.handleUpdateWorkspaceSettings(req, res));
		app.get("/database/tables", (req, res) => this.handleDatabaseTables(req, res));
		app.get("/database/tables/:tableName/rows", (req, res) => this.handleDatabaseRows(req, res));
		app.get("/auth/openai-codex/status", (req, res) => this.handleAuthStatus(req, res));
		app.post("/auth/openai-codex/login", (req, res) => { void this.handleCodexLogin(req, res); });
		app.get("/auth/openai-codex/login/:loginId", (req, res) => this.handleCodexLoginStatus(req, res));
		app.post("/auth/openai-codex/login/:loginId/code", (req, res) => this.handleCodexLoginCode(req, res));
		app.get("/workspaces/:workspaceId/sessions", (req, res) => this.handleWorkspaceSessions(req, res));
		app.post("/workspaces/:workspaceId/sessions", (req, res) => this.handleCreateSession(req, res));
		app.post("/sessions/:sessionId/messages", (req, res) => { void this.handleChat(req, res, req.params.sessionId); });
		app.post("/chat",           (req, res) => { void this.handleChat(req, res); });
		app.post("/stop",           (req, res) => { void this.handleStop(req, res); });
		app.get("/status/:id",      (req, res) => this.handleStatus(req, req.params.id, res));
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
			onPrompt: async () => manualCodePromise,
			onManualCodeInput: async () => manualCodePromise,
			onSelect: async () => undefined,
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

	private handleWorkspaces(req: express.Request, res: express.Response): void {
		const userId = this.getUserId(req);
		this.workspaceStore.ensureDefaultWorkspace(userId);
		res.json(this.workspaceStore.listWorkspaces(userId));
	}

	private handleCreateWorkspace(req: express.Request, res: express.Response): void {
		const { name, userName } = req.body as { name?: string; userName?: string };
		const userId = this.getUserId(req, userName);
		const workspace = this.workspaceStore.createWorkspace({ name: name || "New workspace", userId });
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
		const { channelId, sessionId: bodySessionId, workspaceId, text, userName = "user", attachments = [] } = req.body as {
			channelId?: string; sessionId?: string; workspaceId?: string; text?: string; userName?: string; attachments?: AttachmentPayload[];
		};
		const sessionId = routeSessionId || bodySessionId || channelId;
		const userId = this.getUserId(req, userName);

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
