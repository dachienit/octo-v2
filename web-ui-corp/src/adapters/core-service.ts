//IYH1HC stream add: token/cost accounting shape shared by usage events and replay.
// Kept in manual sync with core-service/src/agent-events.ts (packages do not share types).
export type AgentUsage = {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
};

//IYH1HC stream add: structured replay block returned by GET /messages when available.
export type ReplayBlock =
	| { kind: "thinking"; content: string }
	| { kind: "text"; content: string }
	| {
		kind: "tool";
		toolCallId: string;
		toolName: string;
		label?: string;
		args: Record<string, unknown>;
		result?: string;
		resultTruncated?: boolean;
		isError?: boolean;
		durationMs?: number;
		skill?: { name: string; path: string };
	};

//IYH1HC stream add: chat history message shape (blocks/usage present for structured runs).
export type HistoryMessage = {
	role: "user" | "assistant";
	text: string;
	attachments?: string[];
	thread?: string;
	files?: Array<{ path: string; title?: string }>;
	blocks?: ReplayBlock[];
	usage?: AgentUsage;
	model?: string;
};

export type SseEvent =
	| { type: "status"; status: "thinking" | "working" | "idle" | "stopped" }
	| { type: "delta"; text: string }
	| { type: "replace"; text: string }
	| { type: "thread"; text: string }
	| { type: "file"; path: string; title?: string }
	| { type: "delete" }
	| { type: "done" }
	| { type: "error"; message: string }
	//IYH1HC stream add: structured agent-trail events (server sends them only when the
	// request body carried structured: true; legacy delta/thread are then suppressed).
	| { type: "turn"; seq: number; phase: "start" | "end"; turnIndex: number; ts: number }
	| { type: "block"; seq: number; phase: "start"; blockId: string; kind: "text" | "thinking"; ts: number }
	| { type: "block"; seq: number; phase: "delta"; blockId: string; kind: "text" | "thinking"; delta: string }
	| { type: "block"; seq: number; phase: "end"; blockId: string; kind: "text" | "thinking"; content: string }
	| { type: "tool"; seq: number; phase: "call"; toolCallId: string; toolName: string; args: Record<string, unknown>; ts: number }
	| { type: "tool"; seq: number; phase: "start"; toolCallId: string; toolName: string; label?: string; args: Record<string, unknown>; ts: number }
	| { type: "tool"; seq: number; phase: "update"; toolCallId: string; toolName: string; partialResult: string }
	| {
		type: "tool";
		seq: number;
		phase: "end";
		toolCallId: string;
		toolName: string;
		label?: string;
		args: Record<string, unknown>;
		durationMs: number;
		result: string;
		resultTruncated: boolean;
		isError: boolean;
		ts: number;
	}
	| { type: "skill"; seq: number; name: string; path: string; toolCallId: string; ts: number }
	| { type: "usage"; seq: number; scope: "message" | "run"; usage: AgentUsage; model?: { provider: string; id: string }; contextTokens?: number; contextWindow?: number }
	| { type: "compaction"; seq: number; phase: "start" | "end"; reason?: string; tokensBefore?: number; aborted?: boolean }
	| { type: "retry"; seq: number; attempt: number; maxAttempts: number; errorMessage?: string };

export type AuthUser = {
	id: string;
	email: string;
	displayName: string;
	avatarUrl?: string; // IYH1HC add: profile picture (GitHub avatar from SSO)
};

// IYH1HC add: external SSO (GHES) config exposed to the web app.
export type SsoConfig = {
	enabled: boolean;
	provider?: string;
	label?: string;
	loginUrl?: string;
	hideAuthUi?: boolean; //IYH1HC add: when true, hide the in-app login screen + logout (XSUAA edge auth)
};

export type ProviderAuthStatus = {
	provider: string;
	configured: boolean;
	source?: string;
	label?: string;
};

export type ProviderLoginStart = {
	loginId: string;
	provider: string;
	url: string;
	instructions?: string;
	statusUrl: string;
	codeUrl: string;
};

export type ProviderLoginStatus = {
	status: "pending" | "complete" | "error";
	provider: string;
	error?: string;
	createdAt: number;
};

// IYH1HC add: per-user LLM provider key + model selection.
export type LlmModelOption = {
	id: string;
	name: string;
	active: boolean;
};

export type LlmProviderConfig = {
	id: string;
	label: string;
	hasKey: boolean;
	models: LlmModelOption[];
};

export type LlmConfig = {
	providers: LlmProviderConfig[];
};

export type ActiveModel = {
	provider: string;
	modelId: string;
	label: string;
};

// IYH1HC add: a user-defined custom model (Bosch GenAI). Never carries the API key.
export type CustomModelConfig = {
	id: string;
	name: string;
	baseProvider: string;
	endpoint: string;
};

export type AcpJob = {
	id: string;
	sessionId: string;
	agent: string;
	task: string;
	cwd: string;
	status: "queued" | "running" | "completed" | "failed" | "cancelled";
	createdAt: string;
	updatedAt: string;
	startedAt?: string;
	finishedAt?: string;
	output?: string;
	error?: string;
	stopReason?: unknown;
};

export type AgentWorkerStatus = {
	id: string;
	label: string;
	connected: boolean;
	kind?: "agent-runtime" | "business-connector";
	authMode?: "cli" | "oauth" | "api-key" | "browser-sso";
	loginModes?: Array<{
		id: string;
		label: string;
		description?: string;
		authMode?: "cli" | "oauth" | "api-key" | "browser-sso";
	}>;
	usedByAgents?: string[];
};

export type ConnectorStatus = AgentWorkerStatus & {
	kind: "agent-runtime" | "business-connector";
	authMode: "cli" | "oauth" | "api-key" | "browser-sso";
	accessPolicy?: {
		connectorId: string;
		allowedInHost: boolean;
		allowedInDocker: boolean;
		mountMode: "ro" | "rw";
		network: "required" | "optional" | "blocked";
	};
};

export type CoreServiceFeatures = {
	agentWorkers: boolean;
	reminders: boolean;
	connection: boolean; //IYH1HC add
	llmProviders: string[] | null; //IYH1HC add: allowlist of provider ids shown in the UI picker; null → all
	appTitle: string | null; //IYH1HC add: configurable browser tab title; null → keep index.html default
};

export type AgentWorkerLoginStart = {
	loginId: string;
	loginMode?: string;
	agent: string;
	connector?: string;
	label: string;
	status: "pending" | "complete" | "error";
	url?: string;
	output?: string;
	statusUrl: string;
	inputUrl: string;
};

export type AgentWorkerLoginStatus = {
	status: "pending" | "complete" | "error";
	loginMode?: string;
	agent?: string;
	connector?: string;
	url?: string;
	output?: string;
	error?: string;
	createdAt: number;
};

export type WorkspaceNode = {
	name: string;
	path: string;
	type: "file" | "directory";
	children?: WorkspaceNode[];
};

export type WorkspaceTree = {
	artifacts: WorkspaceNode[];
	skills: WorkspaceNode[];
};

//IYH1HC add — SAP ADT connection model (multi-connection per workspace).
export type SapConnection = {
	name: string;
	destinationName: string;
	url?: string;
	authType?: string;
	client?: string;
	language?: string;
	status?: "connected" | "error" | "unknown";
	createdAt?: string;
};

export type SapDestination = {
	name: string;
	type?: string;
	url?: string;
	authentication?: string;
	proxyType?: string;
	description?: string;
};

//IYH1HC SSO add — On-prem system discovered from the developer's local SAP Logon landscape.
export type SapLocalSystem = {
	systemId: string;
	client?: string;
	adtUrl: string;
	spn: string;
	description?: string;
	type?: string;
	source?: string;
};

export type SapNode = {
	typeId: string;
	name: string;
	uri: string | null;
	description?: string;
};

//IYH1HC add — one entry of the materialized ADT tree manifest (per relative path).
export type SapTreeManifestEntry = {
	lazy: boolean; // an ADT folder that must be expanded via the backend
	loaded: boolean; // for lazy folders: have children been materialized yet
	hasUri: boolean; // an ADT-backed object file awaiting hydration
	typeId?: string; // ADT object type (for per-type icon)
	label?: string; // Eclipse-style display name (uppercase, no extension)
	description?: string; // short description (shown italic, like Eclipse)
};

export type WorkspaceSettings = {
	agent?: {
		prompt?: string;
		promptFile?: string;
	};
	sapConnection?: {
		enabled?: boolean;
		systemUrl?: string;
		client?: string;
		username?: string;
		authType?: "basic" | "destination" | "oauth";
		destinationName?: string;
	};
	sapConnections?: SapConnection[]; //IYH1HC add
	tools?: {
		enabled?: string[];
	};
	connectors?: {
		allowed?: string[];
	};
	mcp?: {
		servers?: Array<{ name: string; command: string; enabled?: boolean }>;
	};
};

export type WorkspaceTemplate = {
	id: "default" | "sap-cap" | "sap-abap"; //IYH1HC add: "default" generic workspace type
	label: string;
	description: string;
	sandboxImage: string;
	skills: Array<{
		name: string;
		label: string;
		description: string;
		content?: string;
	}>;
	settings: WorkspaceSettings;
	agentPrompt?: string;
};

export type WorkspaceSandboxStatus = {
	mode: "host" | "managed" | "fixed";
	runtime: "host" | "docker" | "podman";
	container?: string;
	image?: string;
	status: "host" | "runtime-missing" | "not-created" | "running" | "stopped" | "error";
	running: boolean;
	workspacePath: string;
	usersPath?: string;
	mounts: Array<{ host: string; container: string; mode: "rw" }>;
	error?: string;
};

export type WorkspaceScheduledEvent = {
	filename: string;
	type: string;
	channelId: string;
	text: string;
	at?: string;
	schedule?: string;
	timezone?: string;
	modifiedAt: number;
	valid: boolean;
	error?: string;
};

export type WorkspaceTableSummary = {
	name: string;
	type: "table" | "view";
	rows: number;
	fields: number;
};

export type WorkspaceTableColumn = {
	name: string;
	type: string;
};

export type WorkspaceTableRows = {
	table: string;
	columns: WorkspaceTableColumn[];
	rows: unknown[][];
	totalRows: number;
	limit: number;
	offset: number;
};

export type AttachmentPayload = {
	fileName: string;
	mimeType: string;
	content: string; // base64
};

const TEXT_FILE_EXTENSIONS = new Set([
	"js", "mjs", "cjs", "ts", "tsx", "jsx",
	"py", "rb", "go", "rs", "java", "kt", "scala", "swift", "dart",
	"c", "cc", "cpp", "cxx", "h", "hpp", "cs", "php",
	"sh", "bash", "zsh", "fish", "ps1", "bat",
	"html", "htm", "css", "scss", "sass", "less",
	"json", "jsonl", "xml", "yaml", "yml", "toml", "ini", "env",
	"sql", "r", "lua", "pl", "pm", "jl",
	"md", "markdown", "txt", "csv", "tsv", "log",
	"abap", "cds", "csn"
]);

const BINARY_FILE_EXTENSIONS = new Set([
	"doc", "docx", "ppt", "pptx", "xls", "xlsx",
	"zip", "gz", "tar", "tgz", "7z", "rar",
]);

function isTextFilePath(path: string): boolean {
	const ext = path.split(/[?#]/)[0].split(".").pop()?.toLowerCase() || "";
	return TEXT_FILE_EXTENSIONS.has(ext);
}

function isBinaryFilePath(path: string): boolean {
	const ext = path.split(/[?#]/)[0].split(".").pop()?.toLowerCase() || "";
	return BINARY_FILE_EXTENSIONS.has(ext);
}

export class CoreServiceClient {
	constructor(private baseUrl: string, private getAuthToken: () => string | null = () => null) {}

	private headers(extra?: HeadersInit): HeadersInit {
		const token = this.getAuthToken();
		return {
			...(extra ?? {}),
			...(token ? { Authorization: `Bearer ${token}` } : {}),
		};
	}

	private async fetch(path: string, init: RequestInit = {}): Promise<Response> {
		return fetch(`${this.baseUrl}${path}`, {
			...init,
			credentials: "include",
			headers: this.headers(init.headers),
		});
	}

	async register(email: string, password: string, displayName?: string): Promise<{ user: AuthUser; token: string; expiresAt: string }> {
		const response = await this.fetch("/auth/register", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ email, password, displayName }),
		});
		if (!response.ok) throw new Error(`HTTP ${response.status}: ${await response.text()}`);
		return response.json();
	}

	async login(email: string, password: string): Promise<{ user: AuthUser; token: string; expiresAt: string }> {
		const response = await this.fetch("/auth/login", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ email, password }),
		});
		if (!response.ok) throw new Error(`HTTP ${response.status}: ${await response.text()}`);
		return response.json();
	}

	async logout(): Promise<void> {
		await this.fetch("/auth/logout", { method: "POST" });
	}

	async me(): Promise<AuthUser | null> {
		try {
			const response = await this.fetch("/auth/me");
			if (!response.ok) return null;
			const data = await response.json() as { user?: AuthUser };
			return data.user ?? null;
		} catch {
			return null;
		}
	}

	// IYH1HC add: read SSO availability (public endpoint).
	async getSsoConfig(): Promise<SsoConfig> {
		try {
			const response = await this.fetch("/auth/sso/config");
			if (!response.ok) return { enabled: false };
			return await response.json() as SsoConfig;
		} catch {
			return { enabled: false };
		}
	}

	// IYH1HC add: full-page navigation target that starts the SSO flow.
	ssoLoginHref(): string {
		return `${this.baseUrl}/auth/sso/login`;
	}

	async getCodexAuthStatus(): Promise<ProviderAuthStatus | null> {
		try {
			const response = await this.fetch("/auth/openai-codex/status");
			if (!response.ok) return null;
			return response.json();
		} catch {
			return null;
		}
	}

	async startCodexLogin(): Promise<ProviderLoginStart> {
		const response = await this.fetch("/auth/openai-codex/login", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({}),
		});
		if (!response.ok) throw new Error(`HTTP ${response.status}: ${await response.text()}`);
		return response.json();
	}

	async getCodexLoginStatus(loginId: string): Promise<ProviderLoginStatus | null> {
		try {
			const response = await this.fetch(`/auth/openai-codex/login/${encodeURIComponent(loginId)}`);
			if (!response.ok) return null;
			return response.json();
		} catch {
			return null;
		}
	}

	async submitCodexLoginCode(loginId: string, code: string): Promise<void> {
		const response = await this.fetch(`/auth/openai-codex/login/${encodeURIComponent(loginId)}/code`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ code }),
		});
		if (!response.ok) throw new Error(`HTTP ${response.status}: ${await response.text()}`);
	}

	// IYH1HC add: read per-provider config (key presence + model list with active flags).
	async getLlmConfig(): Promise<LlmConfig> {
		try {
			const response = await this.fetch("/llm/config");
			if (!response.ok) return { providers: [] };
			return await response.json() as LlmConfig;
		} catch {
			return { providers: [] };
		}
	}

	// IYH1HC add: flat list of active models across providers (for the chatbox listbox).
	async getActiveModels(): Promise<ActiveModel[]> {
		try {
			const response = await this.fetch("/llm/active-models");
			if (!response.ok) return [];
			const data = await response.json() as { models?: ActiveModel[] };
			return data.models ?? [];
		} catch {
			return [];
		}
	}

	// IYH1HC add: store (encrypt server-side) the API key for a provider.
	async saveProviderKey(provider: string, apiKey: string): Promise<boolean> {
		const response = await this.fetch(`/llm/providers/${encodeURIComponent(provider)}/key`, {
			method: "PUT",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ apiKey }),
		});
		if (!response.ok) throw new Error(`HTTP ${response.status}: ${await response.text()}`);
		return true;
	}

	// IYH1HC add: forget the stored API key for a provider.
	async deleteProviderKey(provider: string): Promise<boolean> {
		const response = await this.fetch(`/llm/providers/${encodeURIComponent(provider)}/key`, { method: "DELETE" });
		if (!response.ok) throw new Error(`HTTP ${response.status}: ${await response.text()}`);
		return true;
	}

	// IYH1HC add: replace the active-model set for a provider.
	async setActiveModels(provider: string, modelIds: string[]): Promise<boolean> {
		const response = await this.fetch(`/llm/providers/${encodeURIComponent(provider)}/models`, {
			method: "PUT",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ modelIds }),
		});
		if (!response.ok) throw new Error(`HTTP ${response.status}: ${await response.text()}`);
		return true;
	}

	// IYH1HC add: list the user's custom models (Bosch GenAI). Keys are never returned.
	async getCustomModels(): Promise<CustomModelConfig[]> {
		try {
			const response = await this.fetch("/llm/custom-models");
			if (!response.ok) return [];
			const data = await response.json() as { customModels?: CustomModelConfig[] };
			return data.customModels ?? [];
		} catch {
			return [];
		}
	}

	// IYH1HC add: create a custom model (key encrypted server-side); returns the new id.
	async addCustomModel(body: { name: string; baseProvider: string; endpoint: string; apiKey: string }): Promise<string> {
		const response = await this.fetch("/llm/custom-models", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(body),
		});
		if (!response.ok) throw new Error(`HTTP ${response.status}: ${await response.text()}`);
		const data = await response.json() as { id?: string };
		return data.id ?? "";
	}

	// IYH1HC add: update a custom model. Omit apiKey to keep the stored key unchanged.
	async updateCustomModel(
		id: string,
		body: { name: string; baseProvider: string; endpoint: string; apiKey?: string },
	): Promise<boolean> {
		const response = await this.fetch(`/llm/custom-models/${encodeURIComponent(id)}`, {
			method: "PUT",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(body),
		});
		if (!response.ok) throw new Error(`HTTP ${response.status}: ${await response.text()}`);
		return true;
	}

	// IYH1HC add: delete a custom model.
	async deleteCustomModel(id: string): Promise<boolean> {
		const response = await this.fetch(`/llm/custom-models/${encodeURIComponent(id)}`, { method: "DELETE" });
		if (!response.ok) throw new Error(`HTTP ${response.status}: ${await response.text()}`);
		return true;
	}

	async *chat(
		channelId: string,
		text: string,
		userName?: string,
		signal?: AbortSignal,
		attachments?: AttachmentPayload[],
		model?: { provider: string; modelId: string }, //IYH1HC add: per-run model override
	): AsyncGenerator<SseEvent> {
		const userQuery = userName ? `?userId=${encodeURIComponent(userName)}` : "";
		const response = await this.fetch(`/sessions/${encodeURIComponent(channelId)}/messages${userQuery}`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			//IYH1HC stream comment body: JSON.stringify({ text, userName, attachments, model }), //IYH1HC comment: forward selected model
			body: JSON.stringify({ text, userName, attachments, model, structured: true }), //IYH1HC stream add: opt in to the structured trail protocol
			signal,
		});

		if (!response.ok) {
			throw new Error(`HTTP ${response.status}: ${await response.text()}`);
		}

		const reader = response.body!.getReader();
		const decoder = new TextDecoder();
		let buffer = "";

		try {
			while (true) {
				const { done, value } = await reader.read();
				if (done) break;

				buffer += decoder.decode(value, { stream: true });
				const lines = buffer.split("\n");
				buffer = lines.pop() ?? "";

				for (const line of lines) {
					if (line.startsWith("data: ")) {
						const data = line.slice(6).trim();
						try {
							yield JSON.parse(data) as SseEvent;
						} catch {
							// ignore malformed lines
						}
					}
				}
			}
		} finally {
			reader.releaseLock();
		}
	}

	async stop(channelId: string): Promise<void> {
		await this.fetch("/stop", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ channelId }),
		});
	}

	async isRunning(channelId: string): Promise<boolean> {
		const response = await this.fetch(`/status/${encodeURIComponent(channelId)}`);
		if (!response.ok) return false;
		const data = await response.json();
		return data.running === true;
	}

	async getAcpJobs(channelId: string): Promise<AcpJob[]> {
		try {
			const response = await this.fetch(`/sessions/${encodeURIComponent(channelId)}/acp-jobs`);
			if (!response.ok) return [];
			const data = await response.json() as { jobs?: AcpJob[] };
			return data.jobs ?? [];
		} catch {
			return [];
		}
	}

	async cancelAcpJob(channelId: string, jobId: string): Promise<boolean> {
		const response = await this.fetch(`/sessions/${encodeURIComponent(channelId)}/acp-jobs/${encodeURIComponent(jobId)}/cancel`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({}),
		});
		if (!response.ok) return false;
		const data = await response.json() as { ok?: boolean };
		return data.ok === true;
	}

	async getFeatures(): Promise<CoreServiceFeatures> {
		try {
			const response = await this.fetch("/features");
			if (!response.ok) return { agentWorkers: true, reminders: true, connection: true, llmProviders: null, appTitle: null }; //IYH1HC add connection + llmProviders + appTitle
			const data = await response.json() as { features?: Partial<CoreServiceFeatures> };
			return {
				agentWorkers: data.features?.agentWorkers !== false,
				reminders: data.features?.reminders !== false,
				connection: data.features?.connection !== false, //IYH1HC add
				llmProviders: Array.isArray(data.features?.llmProviders) ? data.features.llmProviders : null, //IYH1HC add
				appTitle: typeof data.features?.appTitle === "string" ? data.features.appTitle : null, //IYH1HC add
			};
		} catch {
			return { agentWorkers: true, reminders: true, connection: true, llmProviders: null, appTitle: null }; //IYH1HC add connection + llmProviders + appTitle
		}
	}

	async getAgentWorkers(): Promise<AgentWorkerStatus[]> {
		try {
			const response = await this.fetch("/auth/agent-workers");
			if (!response.ok) return [];
			const data = await response.json() as { agents?: AgentWorkerStatus[] };
			return data.agents ?? [];
		} catch {
			return [];
		}
	}

	async getConnectors(kind?: "agent-runtime" | "business-connector"): Promise<ConnectorStatus[]> {
		try {
			const query = kind ? `?kind=${encodeURIComponent(kind)}` : "";
			const response = await this.fetch(`/auth/connectors${query}`);
			if (!response.ok) return [];
			const data = await response.json() as { connectors?: ConnectorStatus[] };
			return data.connectors ?? [];
		} catch {
			return [];
		}
	}

	async startConnectorLogin(
		connector: string,
		options?: { loginMode?: string },
	): Promise<AgentWorkerLoginStart | null> {
		const response = await this.fetch(`/auth/connectors/${encodeURIComponent(connector)}/login`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(options ?? {}),
		});
		if (!response.ok) return null;
		return response.json();
	}

	async getConnectorLoginStatus(connector: string, loginId: string): Promise<AgentWorkerLoginStatus | null> {
		try {
			const response = await this.fetch(`/auth/connectors/${encodeURIComponent(connector)}/login/${encodeURIComponent(loginId)}`);
			if (!response.ok) return null;
			return response.json();
		} catch {
			return null;
		}
	}

	async sendConnectorLoginInput(connector: string, loginId: string, input: string): Promise<void> {
		await this.fetch(`/auth/connectors/${encodeURIComponent(connector)}/login/${encodeURIComponent(loginId)}/input`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ input }),
		});
	}

	async logoutConnector(connector: string): Promise<void> {
		await this.fetch(`/auth/connectors/${encodeURIComponent(connector)}/logout`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({}),
		});
	}

	async startAgentWorkerLogin(agent: string): Promise<AgentWorkerLoginStart | null> {
		const response = await this.fetch(`/auth/agent-workers/${encodeURIComponent(agent)}/login`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({}),
		});
		if (!response.ok) return null;
		return response.json();
	}

	async getAgentWorkerLoginStatus(agent: string, loginId: string): Promise<AgentWorkerLoginStatus | null> {
		try {
			const response = await this.fetch(`/auth/agent-workers/${encodeURIComponent(agent)}/login/${encodeURIComponent(loginId)}`);
			if (!response.ok) return null;
			return response.json();
		} catch {
			return null;
		}
	}

	async sendAgentWorkerLoginInput(agent: string, loginId: string, input: string): Promise<void> {
		await this.fetch(`/auth/agent-workers/${encodeURIComponent(agent)}/login/${encodeURIComponent(loginId)}/input`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ input }),
		});
	}

	async logoutAgentWorker(agent: string): Promise<void> {
		await this.fetch(`/auth/agent-workers/${encodeURIComponent(agent)}/logout`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({}),
		});
	}

	//IYH1HC stream comment async getMessages(channelId: string): Promise<Array<{ role: "user" | "assistant"; text: string }>> {
	async getMessages(channelId: string): Promise<HistoryMessage[]> { //IYH1HC stream add
		try {
			const response = await this.fetch(`/messages/${encodeURIComponent(channelId)}`);
			if (!response.ok) return [];
			return response.json();
		} catch {
			return [];
		}
	}

	async getArtifactUrl(path: string): Promise<string | null> {
		try {
			const response = await this.fetch(`/artifact-url?path=${encodeURIComponent(path)}`);
			if (!response.ok) return null;
			const data = await response.json();
			return data.url ?? null;
		} catch {
			return null;
		}
	}

	async getFileContent(path: string): Promise<{ content: string; mimeType: string } | null> {
		try {
			const response = await this.fetch(`/file?path=${encodeURIComponent(path)}`);
			if (!response.ok) return null;
			const mimeType = response.headers.get("content-type") ?? "text/plain";
			const isTextLike =
				!isBinaryFilePath(path) && (
				mimeType.startsWith("text/") ||
				mimeType.includes("json") ||
				mimeType.includes("xml") ||
				mimeType.includes("javascript") ||
				isTextFilePath(path)
				);

			if (isTextLike) {
				const content = await response.text();
				return { content, mimeType };
			}

			const bytes = new Uint8Array(await response.arrayBuffer());
			let binary = "";
			for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
			const base64 = btoa(binary);
			return { content: `data:${mimeType};base64,${base64}`, mimeType };
		} catch {
			return null;
		}
	}

	async getWorkspace(channelId: string): Promise<WorkspaceTree | null> {
		try {
			const response = await this.fetch(`/sessions/${encodeURIComponent(channelId)}/workspace`);
			if (!response.ok) return null;
			return response.json();
		} catch {
			return null;
		}
	}

	async getDatabaseTables(path: string): Promise<WorkspaceTableSummary[]> {
		try {
			const response = await this.fetch(`/database/tables?path=${encodeURIComponent(path)}`);
			if (!response.ok) return [];
			const data = await response.json() as { tables?: WorkspaceTableSummary[] };
			return data.tables ?? [];
		} catch {
			return [];
		}
	}

	async getDatabaseTableRows(path: string, tableName: string, limit = 100, offset = 0): Promise<WorkspaceTableRows | null> {
		try {
			const query = new URLSearchParams({ path, limit: String(limit), offset: String(offset) });
			const response = await this.fetch(`/database/tables/${encodeURIComponent(tableName)}/rows?${query.toString()}`);
			if (!response.ok) return null;
			return response.json();
		} catch {
			return null;
		}
	}

	async getSessions(workspaceId?: string, userName?: string): Promise<SessionInfo[]> {
		try {
			const query = userName ? `?userId=${encodeURIComponent(userName)}` : "";
			const path = workspaceId
				? `/workspaces/${encodeURIComponent(workspaceId)}/sessions${query}`
				: `/sessions${query}`;
			const response = await this.fetch(path);
			if (!response.ok) return [];
			return response.json();
		} catch {
			return [];
		}
	}

	async getWorkspaces(userName?: string): Promise<WorkspaceInfo[]> {
		try {
			const query = userName ? `?userId=${encodeURIComponent(userName)}` : "";
			const response = await this.fetch(`/workspaces${query}`);
			if (!response.ok) return [];
			return response.json();
		} catch {
			return [];
		}
	}

	async getWorkspaceTemplates(): Promise<WorkspaceTemplate[]> {
		try {
			const response = await this.fetch("/workspace-templates");
			if (!response.ok) return [];
			return response.json();
		} catch {
			return [];
		}
	}

	async createWorkspace(name: string, userNameOrOptions?: string | { userName?: string; templateId?: string; type?: string }): Promise<WorkspaceInfo | null> {
		try {
			const options = typeof userNameOrOptions === "string" ? { userName: userNameOrOptions } : userNameOrOptions ?? {};
			const response = await this.fetch("/workspaces", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ name, ...options }),
			});
			if (!response.ok) return null;
			return response.json();
		} catch {
			return null;
		}
	}

	async getWorkspaceSettings(workspaceId: string): Promise<WorkspaceSettings> {
		try {
			const response = await this.fetch(`/workspaces/${encodeURIComponent(workspaceId)}/settings`);
			if (!response.ok) return {};
			return response.json();
		} catch {
			return {};
		}
	}

	async updateWorkspaceSettings(workspaceId: string, settings: WorkspaceSettings): Promise<WorkspaceSettings | null> {
		try {
			const response = await this.fetch(`/workspaces/${encodeURIComponent(workspaceId)}/settings`, {
				method: "PATCH",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(settings),
			});
			if (!response.ok) return null;
			return response.json();
		} catch {
			return null;
		}
	}

	//IYH1HC add — SAP ADT connection management.
	async listSapDestinations(workspaceId: string): Promise<SapDestination[]> {
		try {
			const response = await this.fetch(`/workspaces/${encodeURIComponent(workspaceId)}/sap-adt/destinations`);
			if (!response.ok) return [];
			const data = await response.json() as { destinations?: SapDestination[] };
			return data.destinations ?? [];
		} catch {
			return [];
		}
	}

	async createSapConnection(
		workspaceId: string,
		input: { destination: string; name: string; client?: string; language?: string },
	): Promise<{ connection: SapConnection | null; error?: string }> {
		try {
			const response = await this.fetch(`/workspaces/${encodeURIComponent(workspaceId)}/sap-adt/connections`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(input),
			});
			const data = await response.json().catch(() => ({})) as { connection?: SapConnection; error?: string };
			return { connection: data.connection ?? null, error: response.ok ? undefined : (data.error ?? `HTTP ${response.status}`) };
		} catch (err) {
			return { connection: null, error: err instanceof Error ? err.message : String(err) };
		}
	}

	//IYH1HC SSO add — list on-prem systems from the developer's SAP Logon landscape.
	async listLocalSapSystems(workspaceId: string): Promise<SapLocalSystem[]> {
		try {
			const response = await this.fetch(`/workspaces/${encodeURIComponent(workspaceId)}/sap-adt/local-systems`);
			if (!response.ok) return [];
			const data = await response.json() as { systems?: SapLocalSystem[] };
			return data.systems ?? [];
		} catch {
			return [];
		}
	}

	//IYH1HC SSO add — create a local on-prem connection authenticated by Kerberos/SPNEGO (no password).
	async createLocalSapConnection(
		workspaceId: string,
		input: { url: string; spn: string; systemId?: string; name: string; client?: string; language?: string },
	): Promise<{ connection: SapConnection | null; error?: string }> {
		try {
			const response = await this.fetch(`/workspaces/${encodeURIComponent(workspaceId)}/sap-adt/connections`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ mode: "sso", ...input }),
			});
			const data = await response.json().catch(() => ({})) as { connection?: SapConnection; error?: string };
			return { connection: data.connection ?? null, error: response.ok ? undefined : (data.error ?? `HTTP ${response.status}`) };
		} catch (err) {
			return { connection: null, error: err instanceof Error ? err.message : String(err) };
		}
	}

	async deleteSapConnection(workspaceId: string, name: string): Promise<boolean> {
		try {
			const response = await this.fetch(
				`/workspaces/${encodeURIComponent(workspaceId)}/sap-adt/connections/${encodeURIComponent(name)}`,
				{ method: "DELETE" },
			);
			return response.ok;
		} catch {
			return false;
		}
	}

	async testSapConnection(workspaceId: string, name: string): Promise<{ ok: boolean; error?: string }> {
		try {
			const response = await this.fetch(
				`/workspaces/${encodeURIComponent(workspaceId)}/sap-adt/connections/${encodeURIComponent(name)}/test`,
				{ method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({}) },
			);
			const data = await response.json().catch(() => ({})) as { ok?: boolean; error?: string };
			return { ok: !!data.ok, error: data.error };
		} catch (err) {
			return { ok: false, error: err instanceof Error ? err.message : String(err) };
		}
	}

	//IYH1HC add — ADT object tree materialized into the workspace Artifacts panel.
	// Returns a map of manifest-relative path -> entry so the UI knows which folders
	// to lazily expand, which empty files to hydrate, and how to label object files.
	async getSapTreeManifest(workspaceId: string, name: string): Promise<Record<string, SapTreeManifestEntry>> {
		try {
			const response = await this.fetch(
				`/workspaces/${encodeURIComponent(workspaceId)}/sap-adt/connections/${encodeURIComponent(name)}/tree/manifest`,
			);
			if (!response.ok) return {};
			const data = await response.json() as { manifest?: Record<string, SapTreeManifestEntry> };
			return data.manifest ?? {};
		} catch {
			return {};
		}
	}

	//IYH1HC add — Materialize the children of an ADT folder node on disk (lazy expand).
	async expandSapTree(workspaceId: string, name: string, path: string): Promise<{ ok: boolean; error?: string }> {
		try {
			const response = await this.fetch(
				`/workspaces/${encodeURIComponent(workspaceId)}/sap-adt/connections/${encodeURIComponent(name)}/tree/expand`,
				{ method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ path }) },
			);
			const data = await response.json().catch(() => ({})) as { ok?: boolean; error?: string };
			return { ok: response.ok && !!data.ok, error: response.ok ? undefined : (data.error ?? `HTTP ${response.status}`) };
		} catch (err) {
			return { ok: false, error: err instanceof Error ? err.message : String(err) };
		}
	}

	//IYH1HC add — Fetch and persist the source of an empty ADT-backed file before opening it.
	async hydrateSapFile(workspaceId: string, name: string, path: string): Promise<{ source: string | null; error?: string }> {
		try {
			const response = await this.fetch(
				`/workspaces/${encodeURIComponent(workspaceId)}/sap-adt/connections/${encodeURIComponent(name)}/tree/hydrate`,
				{ method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ path }) },
			);
			const data = await response.json().catch(() => ({})) as { source?: string; error?: string };
			return { source: data.source ?? null, error: response.ok ? undefined : (data.error ?? `HTTP ${response.status}`) };
		} catch (err) {
			return { source: null, error: err instanceof Error ? err.message : String(err) };
		}
	}

	async getWorkspaceSandbox(workspaceId: string): Promise<WorkspaceSandboxStatus | null> {
		try {
			const response = await this.fetch(`/workspaces/${encodeURIComponent(workspaceId)}/sandbox`);
			if (!response.ok) return null;
			return response.json();
		} catch {
			return null;
		}
	}

	async getWorkspaceEvents(workspaceId: string): Promise<WorkspaceScheduledEvent[]> {
		try {
			const response = await this.fetch(`/workspaces/${encodeURIComponent(workspaceId)}/events`);
			if (!response.ok) return [];
			const data = await response.json() as { events?: WorkspaceScheduledEvent[] };
			return data.events ?? [];
		} catch {
			return [];
		}
	}

	async deleteWorkspaceEvent(workspaceId: string, filename: string): Promise<boolean> {
		try {
			const response = await this.fetch(`/workspaces/${encodeURIComponent(workspaceId)}/events/${encodeURIComponent(filename)}`, {
				method: "DELETE",
			});
			return response.ok;
		} catch {
			return false;
		}
	}

	async createSession(workspaceId: string, title?: string, userName?: string): Promise<SessionRecord | null> {
		try {
			const response = await this.fetch(`/workspaces/${encodeURIComponent(workspaceId)}/sessions`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ title, userName }),
			});
			if (!response.ok) return null;
			return response.json();
		} catch {
			return null;
		}
	}
}

export type WorkspaceInfo = {
	id: string;
	name: string;
	createdBy: string;
	createdAt: string;
	type?: WorkspaceTemplate["id"];
	templateId?: WorkspaceTemplate["id"];
	sandboxId?: string;
	sandbox?: {
		image?: string;
	};
	role: "owner" | "admin" | "editor" | "viewer";
};

export type SessionRecord = {
	id: string;
	workspaceId: string;
	title: string;
	createdBy: string;
	createdAt: string;
	lastModified: number;
};

export type SessionInfo = {
	channelId: string;
	id?: string;
	workspaceId?: string;
	title?: string;
	preview: string;
	messageCount: number;
	lastModified: number;
};
