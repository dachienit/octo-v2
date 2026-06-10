export type SseEvent =
	| { type: "status"; status: "thinking" | "working" | "idle" | "stopped" }
	| { type: "delta"; text: string }
	| { type: "replace"; text: string }
	| { type: "thread"; text: string }
	| { type: "file"; path: string; title?: string }
	| { type: "delete" }
	| { type: "done" }
	| { type: "error"; message: string };

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
};

export type AgentWorkerLoginStart = {
	loginId: string;
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
	id: "sap-cap" | "sap-abap";
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
			body: JSON.stringify({ text, userName, attachments, model }), //IYH1HC comment: forward selected model
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
			if (!response.ok) return { agentWorkers: true, reminders: true };
			const data = await response.json() as { features?: Partial<CoreServiceFeatures> };
			return {
				agentWorkers: data.features?.agentWorkers !== false,
				reminders: data.features?.reminders !== false,
			};
		} catch {
			return { agentWorkers: true, reminders: true };
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

	async startConnectorLogin(connector: string): Promise<AgentWorkerLoginStart | null> {
		const response = await this.fetch(`/auth/connectors/${encodeURIComponent(connector)}/login`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({}),
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

	async getMessages(channelId: string): Promise<Array<{ role: "user" | "assistant"; text: string }>> {
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
