import { existsSync, mkdirSync, readdirSync, writeFileSync } from "fs";
import { join } from "path";

export type ConnectorAuthMode = "cli" | "oauth" | "api-key" | "browser-sso";
export type ConnectorKind = "agent-runtime" | "business-connector";
export type ConnectorMountMode = "ro" | "rw";
export type ConnectorNetworkPolicy = "required" | "optional" | "blocked";

export type MountSpec = {
	host: string;
	container: string;
	mode: ConnectorMountMode;
};

export type ConnectorAccessPolicy = {
	connectorId: string;
	allowedInHost: boolean;
	allowedInDocker: boolean;
	mountMode: ConnectorMountMode;
	network: ConnectorNetworkPolicy;
};

export type ConnectorRuntimeContext = {
	userId: string;
	usersRoot: string;
	runtimeUsersRoot?: string;
};

export type ConnectorRuntime = {
	id: string;
	label: string;
	kind: ConnectorKind;
	authMode: ConnectorAuthMode;
	command?: string;
	statusCommand?: string[];
	loginCommand?: string[];
	logoutCommand?: string[];
	usedByAgents?: string[];
	accessPolicy: ConnectorAccessPolicy;
	env: (ctx: ConnectorRuntimeContext) => Record<string, string>;
	mounts: (ctx: ConnectorRuntimeContext) => MountSpec[];
};

const CONNECTOR_DEFINITIONS: Array<Omit<ConnectorRuntime, "env" | "mounts">> = [
	{
		id: "codex",
		label: "Codex",
		kind: "agent-runtime",
		authMode: "cli",
		command: "codex",
		loginCommand: ["login"],
		logoutCommand: ["logout"],
		usedByAgents: ["codex"],
		accessPolicy: { connectorId: "codex", allowedInHost: true, allowedInDocker: true, mountMode: "rw", network: "required" },
	},
	{
		id: "gemini",
		label: "Gemini",
		kind: "agent-runtime",
		authMode: "cli",
		command: "gemini",
		loginCommand: ["auth", "login"],
		logoutCommand: ["auth", "logout"],
		usedByAgents: ["gemini"],
		accessPolicy: { connectorId: "gemini", allowedInHost: true, allowedInDocker: true, mountMode: "rw", network: "required" },
	},
	{
		id: "claude",
		label: "Claude",
		kind: "agent-runtime",
		authMode: "cli",
		command: "claude",
		loginCommand: ["login"],
		logoutCommand: ["logout"],
		usedByAgents: ["claude"],
		accessPolicy: { connectorId: "claude", allowedInHost: true, allowedInDocker: true, mountMode: "rw", network: "required" },
	},
	{
		id: "github",
		label: "GitHub",
		kind: "business-connector",
		authMode: "cli",
		command: "gh",
		loginCommand: ["auth", "login"],
		logoutCommand: ["auth", "logout"],
		accessPolicy: { connectorId: "github", allowedInHost: true, allowedInDocker: false, mountMode: "rw", network: "required" },
	},
	{
		id: "sap-adt",
		label: "SAP ADT",
		kind: "business-connector",
		authMode: "cli",
		command: "adt-cli",
		loginCommand: ["login"],
		logoutCommand: ["logout"],
		accessPolicy: { connectorId: "sap-adt", allowedInHost: true, allowedInDocker: false, mountMode: "rw", network: "required" },
	},
];

export function safeConnectorUserId(userId: string): string {
	return userId.replace(/[^a-zA-Z0-9._-]/g, "_") || "web-user";
}

export function getConnectorRoot(usersRoot: string, userId: string, connectorId: string): string {
	return join(usersRoot, safeConnectorUserId(userId), "connectors", connectorId);
}

export function getConnectorHome(usersRoot: string, userId: string, connectorId: string): string {
	return join(getConnectorRoot(usersRoot, userId, connectorId), "home");
}

export function getConnectorMetadataPath(usersRoot: string, userId: string, connectorId: string): string {
	return join(getConnectorRoot(usersRoot, userId, connectorId), "metadata.json");
}

export function ensureConnectorHome(usersRoot: string, userId: string, connectorId: string): string {
	const root = getConnectorRoot(usersRoot, userId, connectorId);
	const home = join(root, "home");
	mkdirSync(home, { recursive: true });
	const metadataPath = join(root, "metadata.json");
	if (!existsSync(metadataPath)) {
		writeFileSync(metadataPath, `${JSON.stringify({ connectorId, createdAt: new Date().toISOString() }, null, 2)}\n`);
	}
	return home;
}

export function connectorHomeHasFiles(usersRoot: string, userId: string, connectorId: string): boolean {
	return directoryHasFiles(getConnectorHome(usersRoot, userId, connectorId));
}

export function directoryHasFiles(dir: string): boolean {
	if (!existsSync(dir)) return false;
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const path = join(dir, entry.name);
		if (entry.isDirectory()) {
			if (directoryHasFiles(path)) return true;
		} else {
			return true;
		}
	}
	return false;
}

function runtimeHome(ctx: ConnectorRuntimeContext, connectorId: string): string {
	return getConnectorHome(ctx.runtimeUsersRoot ?? ctx.usersRoot, ctx.userId, connectorId);
}

function connectorEnv(connectorId: string, home: string): Record<string, string> {
	const env: Record<string, string> = { HOME: home };
	if (connectorId === "codex") env.CODEX_HOME = home;
	if (connectorId === "gemini") env.GEMINI_CONFIG_DIR = home;
	if (connectorId === "claude") env.CLAUDE_CONFIG_DIR = home;
	if (connectorId === "github") env.GH_CONFIG_DIR = home;
	if (connectorId === "sap-adt") {
		env.ADT_CONFIG_DIR = home;
		env.SAP_ADT_HOME = home;
	}
	return env;
}

function buildRuntime(def: Omit<ConnectorRuntime, "env" | "mounts">): ConnectorRuntime {
	return {
		...def,
		env: (ctx) => connectorEnv(def.id, runtimeHome(ctx, def.id)),
		mounts: (ctx) => [{
			host: getConnectorHome(ctx.usersRoot, ctx.userId, def.id),
			container: runtimeHome(ctx, def.id),
			mode: def.accessPolicy.mountMode,
		}],
	};
}

export const CONNECTOR_RUNTIMES: ConnectorRuntime[] = CONNECTOR_DEFINITIONS.map(buildRuntime);

export function listConnectorRuntimes(kind?: ConnectorKind): ConnectorRuntime[] {
	return kind ? CONNECTOR_RUNTIMES.filter((connector) => connector.kind === kind) : CONNECTOR_RUNTIMES;
}

export function getConnectorRuntime(id: string): ConnectorRuntime | undefined {
	return CONNECTOR_RUNTIMES.find((connector) => connector.id === id);
}

export function getAgentRuntimeConnector(agentId: string): ConnectorRuntime | undefined {
	return CONNECTOR_RUNTIMES.find((connector) => connector.kind === "agent-runtime" && connector.usedByAgents?.includes(agentId));
}
