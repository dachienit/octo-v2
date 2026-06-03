import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "fs";
import { join } from "path";

export type WorkspaceRole = "owner" | "admin" | "editor" | "viewer";

export interface WorkspaceInfo {
	id: string;
	name: string;
	createdBy: string;
	createdAt: string;
	sandboxId?: string;
	defaultAgentProfileId?: string;
	settings?: WorkspaceSettings;
}

export interface WorkspaceSettings {
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
}

export interface WorkspaceMember {
	userId: string;
	role: WorkspaceRole;
}

export interface WorkspaceSummary extends WorkspaceInfo {
	role: WorkspaceRole;
}

export interface SessionRecord {
	id: string;
	workspaceId: string;
	title: string;
	createdBy: string;
	createdAt: string;
	lastModified: number;
}

export interface SessionInfo {
	channelId: string;
	id: string;
	workspaceId: string;
	title: string;
	preview: string;
	messageCount: number;
	lastModified: number;
}

function createId(prefix: string): string {
	return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function readJson<T>(path: string): T | undefined {
	if (!existsSync(path)) return undefined;
	try {
		return JSON.parse(readFileSync(path, "utf-8")) as T;
	} catch {
		return undefined;
	}
}

function writeJson(path: string, value: unknown): void {
	writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf-8");
}

const AGENT_PROMPT_FILES = ["AGENTS.md", "agents.md", "CLAUDE.md", "claude.md"];

export class WorkspaceStore {
	readonly dataRoot: string;
	readonly workspacesRoot: string;

	constructor(dataRoot: string) {
		this.dataRoot = dataRoot;
		this.workspacesRoot = join(dataRoot, "workspaces");
		mkdirSync(this.workspacesRoot, { recursive: true });
	}

	ensureDefaultWorkspace(userId: string): WorkspaceSummary {
		const existing = this.listWorkspaces(userId)[0];
		if (existing) return existing;
		return this.createWorkspace({ name: "Default workspace", userId });
	}

	createWorkspace(opts: { name: string; userId: string }): WorkspaceSummary {
		const id = createId("ws");
		const root = this.getWorkspaceRoot(id);
		mkdirSync(join(root, "sessions"), { recursive: true });
		mkdirSync(join(root, "artifacts"), { recursive: true });
		mkdirSync(join(root, "skills"), { recursive: true });
		mkdirSync(join(root, "events"), { recursive: true });

		const workspace: WorkspaceInfo = {
			id,
			name: opts.name.trim() || "Untitled workspace",
			createdBy: opts.userId,
			createdAt: new Date().toISOString(),
		};
		const members: WorkspaceMember[] = [{ userId: opts.userId, role: "owner" }];
		writeJson(join(root, "workspace.json"), workspace);
		writeJson(join(root, "members.json"), members);
		return { ...workspace, role: "owner" };
	}

	listWorkspaces(userId: string): WorkspaceSummary[] {
		if (!existsSync(this.workspacesRoot)) return [];
		const result: WorkspaceSummary[] = [];
		for (const entry of readdirSync(this.workspacesRoot, { withFileTypes: true })) {
			if (!entry.isDirectory()) continue;
			const root = this.getWorkspaceRoot(entry.name);
			const workspace = readJson<WorkspaceInfo>(join(root, "workspace.json"));
			const members = readJson<WorkspaceMember[]>(join(root, "members.json")) ?? [];
			const member = members.find((m) => m.userId === userId);
			if (workspace && member) result.push({ ...workspace, role: member.role });
		}
		return result.sort((a, b) => a.name.localeCompare(b.name));
	}

	getWorkspace(workspaceId: string): WorkspaceInfo | undefined {
		return readJson<WorkspaceInfo>(join(this.getWorkspaceRoot(workspaceId), "workspace.json"));
	}

	getWorkspaceSettings(userId: string, workspaceId: string): WorkspaceSettings {
		this.assertWorkspaceAccess(userId, workspaceId);
		const root = this.getWorkspaceRoot(workspaceId);
		const settings = this.getWorkspace(workspaceId)?.settings ?? {};
		const promptFile = this.getAgentPromptFile(workspaceId);
		return {
			...settings,
			agent: {
				...settings.agent,
				promptFile,
				prompt: existsSync(join(root, promptFile)) ? readFileSync(join(root, promptFile), "utf-8") : "",
			},
		};
	}

	updateWorkspaceSettings(userId: string, workspaceId: string, settings: WorkspaceSettings): WorkspaceSettings {
		const role = this.assertWorkspaceAccess(userId, workspaceId);
		if (role === "viewer") throw new Error("Workspace settings are read-only for viewers");
		const root = this.getWorkspaceRoot(workspaceId);
		const workspace = readJson<WorkspaceInfo>(join(root, "workspace.json"));
		if (!workspace) throw new Error("Workspace not found");
		const promptFile = this.getAgentPromptFile(workspaceId);
		if (settings.agent?.prompt !== undefined) {
			writeFileSync(join(root, promptFile), settings.agent.prompt, "utf-8");
		}
		const nextSettings: WorkspaceSettings = {
			agent: { promptFile },
			sapConnection: settings.sapConnection ?? {},
			tools: settings.tools ?? {},
			mcp: settings.mcp ?? {},
		};
		writeJson(join(root, "workspace.json"), { ...workspace, settings: nextSettings });
		return this.getWorkspaceSettings(userId, workspaceId);
	}

	getAgentPrompt(userId: string, workspaceId: string): string {
		this.assertWorkspaceAccess(userId, workspaceId);
		const root = this.getWorkspaceRoot(workspaceId);
		const promptFile = this.getAgentPromptFile(workspaceId);
		const path = join(root, promptFile);
		return existsSync(path) ? readFileSync(path, "utf-8") : "";
	}

	private getAgentPromptFile(workspaceId: string): string {
		const root = this.getWorkspaceRoot(workspaceId);
		const configured = this.getWorkspace(workspaceId)?.settings?.agent?.promptFile;
		if (configured && AGENT_PROMPT_FILES.includes(configured)) return configured;
		return AGENT_PROMPT_FILES.find((file) => existsSync(join(root, file))) ?? "AGENTS.md";
	}

	assertWorkspaceAccess(userId: string, workspaceId: string): WorkspaceRole {
		const members = readJson<WorkspaceMember[]>(join(this.getWorkspaceRoot(workspaceId), "members.json")) ?? [];
		const member = members.find((m) => m.userId === userId);
		if (!member) throw new Error("Workspace not found or access denied");
		return member.role;
	}

	createSession(opts: { workspaceId: string; userId: string; title?: string }): SessionRecord {
		this.assertWorkspaceAccess(opts.userId, opts.workspaceId);
		const id = createId("s");
		return this.createSessionWithId({ ...opts, sessionId: id });
	}

	createSessionWithId(opts: { workspaceId: string; sessionId: string; userId: string; title?: string }): SessionRecord {
		this.assertWorkspaceAccess(opts.userId, opts.workspaceId);
		const id = opts.sessionId;
		const root = this.getSessionRoot(opts.workspaceId, id);
		mkdirSync(join(root, "attachments"), { recursive: true });
		mkdirSync(join(root, "skills"), { recursive: true });
		const now = new Date().toISOString();
		const session: SessionRecord = {
			id,
			workspaceId: opts.workspaceId,
			title: opts.title?.trim() || "New session",
			createdBy: opts.userId,
			createdAt: now,
			lastModified: Date.now(),
		};
		writeJson(join(root, "session.json"), session);
		return session;
	}

	ensureSession(opts: { sessionId: string; workspaceId?: string; userId: string }): SessionRecord {
		const existing = this.findSession(opts.sessionId);
		if (existing) return existing;
		const workspaceId = opts.workspaceId ?? this.ensureDefaultWorkspace(opts.userId).id;
		return this.createSessionWithId({
			workspaceId,
			sessionId: opts.sessionId,
			userId: opts.userId,
			title: "New session",
		});
	}

	listSessions(userId: string, workspaceId: string): SessionInfo[] {
		this.assertWorkspaceAccess(userId, workspaceId);
		const sessionsRoot = join(this.getWorkspaceRoot(workspaceId), "sessions");
		if (!existsSync(sessionsRoot)) return [];
		const result: SessionInfo[] = [];
		for (const entry of readdirSync(sessionsRoot, { withFileTypes: true })) {
			if (!entry.isDirectory()) continue;
			const session = readJson<SessionRecord>(join(sessionsRoot, entry.name, "session.json")) ?? {
				id: entry.name,
				workspaceId,
				title: "Session",
				createdBy: userId,
				createdAt: new Date(0).toISOString(),
				lastModified: 0,
			};
			result.push(this.getSessionInfo(workspaceId, session));
		}
		return result.sort((a, b) => b.lastModified - a.lastModified);
	}

	findSession(sessionId: string): SessionRecord | undefined {
		for (const workspaceEntry of readdirSync(this.workspacesRoot, { withFileTypes: true })) {
			if (!workspaceEntry.isDirectory()) continue;
			const sessionRoot = this.getSessionRoot(workspaceEntry.name, sessionId);
			if (!existsSync(sessionRoot)) continue;
			const session = readJson<SessionRecord>(join(sessionRoot, "session.json"));
			return session ?? {
				id: sessionId,
				workspaceId: workspaceEntry.name,
				title: "Session",
				createdBy: "unknown",
				createdAt: new Date(0).toISOString(),
				lastModified: 0,
			};
		}
		return undefined;
	}

	getWorkspaceRoot(workspaceId: string): string {
		return join(this.workspacesRoot, workspaceId);
	}

	getSessionRoot(workspaceId: string, sessionId: string): string {
		return join(this.getWorkspaceRoot(workspaceId), "sessions", sessionId);
	}

	private getSessionInfo(workspaceId: string, session: SessionRecord): SessionInfo {
		const sessionRoot = this.getSessionRoot(workspaceId, session.id);
		const logFile = join(sessionRoot, "log.jsonl");
		let preview = "";
		let messageCount = 0;
		let lastModified = session.lastModified;

		if (existsSync(logFile)) {
			try {
				lastModified = statSync(logFile).mtimeMs;
				const lines = readFileSync(logFile, "utf-8").trim().split("\n").filter(Boolean);
				for (const line of lines) {
					try {
						const msg = JSON.parse(line) as { isBot?: boolean; text?: string };
						if (!msg.isBot && msg.text) {
							messageCount++;
							if (!preview) preview = msg.text;
						}
					} catch {
						// Skip malformed log lines.
					}
				}
			} catch {
				// Keep session metadata fallback.
			}
		}

		return {
			channelId: session.id,
			id: session.id,
			workspaceId,
			title: session.title,
			preview: preview.length > 80 ? `${preview.slice(0, 80)}...` : preview,
			messageCount,
			lastModified,
		};
	}
}
