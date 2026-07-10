import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

export type WorkspaceRole = "owner" | "admin" | "editor" | "viewer";

export interface WorkspaceInfo {
	id: string;
	name: string;
	createdBy: string;
	createdAt: string;
	type?: WorkspaceTemplateId;
	templateId?: WorkspaceTemplateId;
	sandboxId?: string;
	sandbox?: {
		image?: string;
	};
	defaultAgentProfileId?: string;
	settings?: WorkspaceSettings;
}

//IYH1HC add — one named SAP ADT connection inside a workspace. A workspace can hold
//IYH1HC add — several (one adt-cli destination profile + an on-disk folder per entry).
export interface SapConnection {
	name: string;
	//IYH1HC SSO comment — destinationName is BTP-only; optional now that local SSO
	//IYH1HC SSO comment — connections (authType "sso") identify the target by url + spn.
	destinationName?: string;
	url?: string;
	//IYH1HC SSO add — "destination" (BTP) | "sso" (local Kerberos/SPNEGO) | "basic".
	authType?: "destination" | "sso" | "basic" | string;
	//IYH1HC SSO add — local SSO fields.
	systemId?: string;
	spn?: string;
	client?: string;
	language?: string;
	status?: "connected" | "error" | "unknown";
	createdAt?: string;
}

export interface WorkspaceSettings {
	agent?: {
		prompt?: string;
		promptFile?: string;
	};
	//IYH1HC comment — legacy single free-text SAP connection. Kept for backward
	//IYH1HC comment — compatibility; superseded by `sapConnections` (the multi-connection model).
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
		servers?: Array<{
			name: string;
			enabled?: boolean;
			transport?: "stdio" | "streamable-http" | "sse";
			command?: string;
			args?: string[];
			url?: string;
			headers?: Record<string, string>;
			env?: Record<string, string>;
			toolPrefix?: string;
			allowedTools?: string[];
			blockedTools?: string[];
			timeoutMs?: number;
			required?: boolean;
		}>;	
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

export type WorkspaceTemplateId = "default" | "sap-cap" | "sap-abap"; //IYH1HC add: "default" generic workspace type

export interface WorkspaceTemplate {
	id: WorkspaceTemplateId;
	label: string;
	description: string;
	sandboxImage: string;
	skills: Array<{
		name: string;
		label: string;
		description: string;
		content: string;
	}>;
	settings: WorkspaceSettings;
	agentPrompt: string;
}

const DEFAULT_SANDBOX_IMAGE = "octo/sandbox:local";
const __dirname = dirname(fileURLToPath(import.meta.url));
const packageRoot = join(__dirname, "..");

export const WORKSPACE_TEMPLATES: WorkspaceTemplate[] = [
	//IYH1HC add: generic, SAP-agnostic workspace with no preconfigured skills.
	{
		id: "default",
		label: "Default",
		description: "General-purpose workspace with no preconfigured SAP skills.",
		sandboxImage: DEFAULT_SANDBOX_IMAGE,
		skills: [
			{
				name: "default-skill",
				label: "Default Skill",
				description: "Starter skill scaffold — edit it to create your department's own skill.",
				content: "",
			},
		],
		settings: { tools: { enabled: ["shell", "code", "tests"] }, connectors: { allowed: ["github", "codex", "claude", "gemini"] } },
		agentPrompt: "This is a general-purpose workspace.",
	},
	{
		id: "sap-cap",
		label: "SAP CAP",
		description: "SAP Cloud Application Programming Model workspace with CAP development skills.",
		sandboxImage: DEFAULT_SANDBOX_IMAGE,
		skills: [
			{
				name: "sap-cap-capire",
				label: "SAP CAP",
				description: "SAP CAP development guidance, CDS modeling, services, Fiori annotations, and deployment references.",
				content: "",
			},
		],
		settings: { tools: { enabled: ["shell", "code", "tests"] }, connectors: { allowed: ["github", "sap-adt", "codex", "claude", "gemini"] } },
		agentPrompt: "This is an SAP CAP workspace. Use the vendored SAP CAP skills under skills/sap-cap-capire for CAP modeling, services, handlers, Fiori annotations, deployment, and troubleshooting.",
	},
	{
		id: "sap-abap",
		label: "SAP ABAP",
		description: "SAP ABAP and ABAP CDS workspace with ABAP development skills.",
		sandboxImage: DEFAULT_SANDBOX_IMAGE,
		skills: [
			{
				name: "sap-abap",
				label: "SAP ABAP",
				description: "ABAP development guidance covering syntax, SQL, RAP, ABAP Cloud, testing, performance, and integration topics.",
				content: "",
			},
			{
				name: "sap-abap-cds",
				label: "SAP ABAP CDS",
				description: "ABAP CDS view, association, annotation, access control, expression, and troubleshooting guidance.",
				content: "",
			},
		],
		settings: { tools: { enabled: ["shell", "code", "tests"] }, connectors: { allowed: ["sap-adt", "github", "codex", "claude", "gemini"] } },
		agentPrompt: "This is an SAP ABAP workspace. Use the vendored SAP ABAP skills under skills/sap-abap and skills/sap-abap-cds for ABAP development, ABAP Cloud, RAP, CDS views, SQL, testing, and performance work.",
	},
];

function getWorkspaceTemplate(templateId?: string): WorkspaceTemplate {
	return WORKSPACE_TEMPLATES.find((template) => template.id === templateId) ?? WORKSPACE_TEMPLATES[0]!;
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
	readonly templatesRoot: string;

	constructor(dataRoot: string) {
		this.dataRoot = dataRoot;
		this.workspacesRoot = join(dataRoot, "workspaces");
		this.templatesRoot = join(dataRoot, "templates");
		mkdirSync(this.workspacesRoot, { recursive: true });
		mkdirSync(this.templatesRoot, { recursive: true });
		this.ensureDefaultTemplates();
	}

	ensureDefaultWorkspace(userId: string): WorkspaceSummary {
		const existing = this.listWorkspaces(userId)[0];
		if (existing) return existing;
		//IYH1HC add: auto-created first workspace now uses the generic "default" template (was "sap-cap")
		return this.createWorkspace({ name: "Default workspace", userId, templateId: "default" });
	}

	listWorkspaceTemplates(): WorkspaceTemplate[] {
		return WORKSPACE_TEMPLATES.map((template) => this.getWorkspaceTemplate(template.id));
	}

	createWorkspace(opts: { name: string; userId: string; templateId?: string }): WorkspaceSummary {
		const template = this.getWorkspaceTemplate(opts.templateId);
		const id = createId("ws");
		const root = this.getWorkspaceRoot(id);
		mkdirSync(join(root, "sessions"), { recursive: true });
		mkdirSync(join(root, "artifacts"), { recursive: true });
		mkdirSync(join(root, "skills"), { recursive: true });
		mkdirSync(join(root, "events"), { recursive: true });
		this.copyTemplateContent(template.id, root);

		const workspace: WorkspaceInfo = {
			id,
			name: opts.name.trim() || "Untitled workspace",
			createdBy: opts.userId,
			createdAt: new Date().toISOString(),
			type: template.id,
			templateId: template.id,
			sandboxId: template.id,
			sandbox: {
				image: template.sandboxImage,
			},
			settings: {
				...template.settings,
				agent: {
					...template.settings.agent,
					promptFile: "AGENTS.md",
				},
			},
		};
		const members: WorkspaceMember[] = [{ userId: opts.userId, role: "owner" }];
		writeJson(join(root, "workspace.json"), workspace);
		writeJson(join(root, "members.json"), members);
		return { ...workspace, role: "owner" };
	}

	private ensureDefaultTemplates(): void {
		for (const template of WORKSPACE_TEMPLATES) {
			const root = this.getTemplateRoot(template.id);
			const bundledRoot = join(packageRoot, "templates", template.id);
			if (!existsSync(root) && existsSync(bundledRoot)) {
				cpSync(bundledRoot, root, { recursive: true });
			}
			mkdirSync(join(root, "skills"), { recursive: true });
			const metadataPath = join(root, "template.json");
			if (!existsSync(metadataPath)) {
				writeJson(metadataPath, {
					id: template.id,
					label: template.label,
					description: template.description,
					sandboxImage: template.sandboxImage,
					settings: template.settings,
					skills: template.skills.map(({ name, label, description }) => ({ name, label, description })),
				});
			}
			const promptPath = join(root, "AGENTS.md");
			if (!existsSync(promptPath)) {
				writeFileSync(promptPath, `${template.agentPrompt.trim()}\n`, "utf-8");
			}
			for (const skill of template.skills) {
				const skillRoot = join(root, "skills", skill.name);
				mkdirSync(skillRoot, { recursive: true });
				const skillPath = join(skillRoot, "SKILL.md");
				if (!existsSync(skillPath)) {
					writeFileSync(skillPath, `${skill.content.trim()}\n`, "utf-8");
				}
			}
		}
	}

	private getWorkspaceTemplate(templateId?: string): WorkspaceTemplate {
		const fallback = getWorkspaceTemplate(templateId);
		const metadata = readJson<Partial<WorkspaceTemplate>>(join(this.getTemplateRoot(fallback.id), "template.json")) ?? {};
		return {
			...fallback,
			...metadata,
			id: fallback.id,
			sandboxImage: metadata.sandboxImage ?? fallback.sandboxImage,
			settings: metadata.settings ?? fallback.settings,
			skills: metadata.skills?.map((skill) => ({
				name: skill.name,
				label: skill.label,
				description: skill.description,
				content: "content" in skill ? String(skill.content ?? "") : "",
			})) ?? fallback.skills,
			agentPrompt: metadata.agentPrompt ?? fallback.agentPrompt,
		};
	}

	private copyTemplateContent(templateId: WorkspaceTemplateId, workspaceRoot: string): void {
		const templateRoot = this.getTemplateRoot(templateId);
		if (!existsSync(templateRoot)) return;
		cpSync(templateRoot, workspaceRoot, {
			recursive: true,
			force: true,
			filter: (source) => {
				const name = source.split(/[\\/]/).pop();
				return name !== "template.json" && name !== "workspace.json" && name !== "members.json";
			},
		});
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

	getWorkspaceSandboxImage(workspaceId: string): string | undefined {
		return this.getWorkspace(workspaceId)?.sandbox?.image;
	}

	getWorkspaceMembers(workspaceId: string): WorkspaceMember[] {
		return readJson<WorkspaceMember[]>(join(this.getWorkspaceRoot(workspaceId), "members.json")) ?? [];
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
			//IYH1HC add — preserve managed SAP connections when the client omits them
			//IYH1HC add — (they are maintained by the dedicated sap-adt routes, not this PATCH).
			sapConnections: settings.sapConnections ?? workspace.settings?.sapConnections ?? [],
			tools: settings.tools ?? {},
			connectors: settings.connectors ?? {},
			mcp: settings.mcp ?? {},
		};
		writeJson(join(root, "workspace.json"), { ...workspace, settings: nextSettings });
		return this.getWorkspaceSettings(userId, workspaceId);
	}

	//IYH1HC add — Read the managed SAP ADT connections for a workspace.
	getSapConnections(userId: string, workspaceId: string): SapConnection[] {
		this.assertWorkspaceAccess(userId, workspaceId);
		return this.getWorkspace(workspaceId)?.settings?.sapConnections ?? [];
	}

	//IYH1HC add — Persist the managed SAP ADT connections, leaving all other settings intact.
	setSapConnections(userId: string, workspaceId: string, connections: SapConnection[]): SapConnection[] {
		const role = this.assertWorkspaceAccess(userId, workspaceId);
		if (role === "viewer") throw new Error("Workspace settings are read-only for viewers");
		const root = this.getWorkspaceRoot(workspaceId);
		const workspace = readJson<WorkspaceInfo>(join(root, "workspace.json"));
		if (!workspace) throw new Error("Workspace not found");
		const nextSettings: WorkspaceSettings = { ...(workspace.settings ?? {}), sapConnections: connections };
		writeJson(join(root, "workspace.json"), { ...workspace, settings: nextSettings });
		return connections;
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
		const members = this.getWorkspaceMembers(workspaceId);
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

	getTemplateRoot(templateId: WorkspaceTemplateId): string {
		return join(this.templatesRoot, templateId);
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
