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
	mcp?: {
		servers?: Array<{ name: string; command: string; enabled?: boolean }>;
	};
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

	async *chat(channelId: string, text: string, userName?: string, signal?: AbortSignal, attachments?: AttachmentPayload[]): AsyncGenerator<SseEvent> {
		const userQuery = userName ? `?userId=${encodeURIComponent(userName)}` : "";
		const response = await this.fetch(`/sessions/${encodeURIComponent(channelId)}/messages${userQuery}`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ text, userName, attachments }),
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

	async createWorkspace(name: string, userName?: string): Promise<WorkspaceInfo | null> {
		try {
			const response = await this.fetch("/workspaces", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ name, userName }),
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
