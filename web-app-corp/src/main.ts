import { configureFioriTheme, CoreServiceChatPanel, CoreServiceClient, translations, type AcpJob, type AuthUser, type ConnectorStatus, type CoreServiceFeatures, type LlmConfig, type SessionInfo, type SsoConfig, type WorkspaceInfo, type WorkspaceNode, type WorkspaceSandboxStatus, type WorkspaceScheduledEvent, type WorkspaceSettings, type WorkspaceTableSummary, type WorkspaceTemplate, type WorkspaceTree } from "@octo/web-ui-corp";
import { setTranslations } from "@mariozechner/mini-lit";
import { html, render } from "lit";
import { icon } from "@mariozechner/mini-lit";
import { ChevronDown, ChevronRight, File, Folder, FolderOpen, KeyRound, LogOut, MessageSquare, Plus, Table2, Trash2, X } from "lucide";
import "./app.css";

applyAppTheme();
await configureFioriTheme();

// Register translations in the local mini-lit instance
setTranslations(translations);

// Read config from URL params
const urlParams = new URLSearchParams(window.location.search);
const baseUrl = urlParams.get("baseUrl") || "/api";
const initialRoute = getRouteFromPath();
const authTokenKey = `coreServiceAuthToken:${baseUrl}`;
const providerKey = `coreServiceProvider:${baseUrl}`;
let authToken = localStorage.getItem(authTokenKey);
let currentUser: AuthUser | null = null;
let userName = urlParams.get("userName") || "user";
let authMode: "login" | "register" = "login";
let authError = "";
let ssoConfig: SsoConfig = { enabled: false }; //IYH1HC add
let authDisplayName = "";
let authEmail = "";
let authPassword = "";
let userMenuOpen = false;
let providerDialogOpen = false;
let createWorkspaceDialogOpen = false;
let workspaceSettingsDialogOpen = false;
let workspaceSettingsTab: "agent" | "connection" | "workers" | "sandbox" = "agent";
let workspaceEventsDialogOpen = false;
let selectedProvider = localStorage.getItem(providerKey) || "openai-codex";
let codexConfigured = false;
let codexLoginId = "";
let codexLoginUrl = "";
let codexLoginCode = "";
let codexAuthError = "";
let codexAuthBusy = false;
let serviceFeatures: CoreServiceFeatures = { agentWorkers: true, reminders: true };
//IYH1HC add: per-user LLM key + model selection state for the provider dialog.
let llmConfig: LlmConfig = { providers: [] };
let llmConfigLoading = false;
let providerKeyInput = "";
let providerKeySaving = false;
let providerKeyError = "";
let providerSavedNotice = ""; //IYH1HC add: transient "Saved" confirmation
let modelFilter = ""; //IYH1HC add: model list search box
let apiKeysExpanded = false; //IYH1HC add: collapsible "API Keys" section state

// App state
let sidebarOpen = true;
let workspaces: WorkspaceInfo[] = [];
let workspaceTemplates: WorkspaceTemplate[] = [];
let workspaceId = initialRoute.workspaceId ?? localStorage.getItem("workspaceId") ?? "";
let channelId = initialRoute.sessionId ?? (workspaceId ? sessionStorage.getItem(`sessionId:${workspaceId}`) || "" : "");
let sessions: SessionInfo[] = [];
let workspaceOpen = true;
let workspaceTab: "artifacts" | "skills" = "artifacts";
let workspaceTree: WorkspaceTree = { artifacts: [], skills: [] };
let workspaceSettings: WorkspaceSettings = {};
let workspaceSandboxStatus: WorkspaceSandboxStatus | null = null;
let workspaceEvents: WorkspaceScheduledEvent[] = [];
let workspaceAgentPromptDraft = "";
let workspaceSettingsError = "";
let workspaceSettingsBusy = false;
let workspaceEventsBusy = false;
let workspaceEventsError = "";
let acpJobs: AcpJob[] = [];
let acpJobPollTimer: number | undefined;
let agentWorkers: ConnectorStatus[] = [];
let businessConnectors: ConnectorStatus[] = [];
let agentWorkerBusy = "";
let agentWorkerLoginOutput = "";
let businessConnectorBusy = "";
let businessConnectorLoginOutput = "";
let agentWorkersCollapsed = localStorage.getItem("agentWorkersCollapsed") === "true";
let newWorkspaceName = "New workspace";
let newWorkspaceTemplateId = "sap-cap";
let newWorkspaceBusy = false;
let newWorkspaceError = "";
const databaseTables = new Map<string, WorkspaceTableSummary[]>();
const expandedFolders = new Set<string>();
const client = new CoreServiceClient(baseUrl, () => authToken);

const chatPanel = new CoreServiceChatPanel();
chatPanel.baseUrl = baseUrl;
chatPanel.channelId = channelId;
chatPanel.userName = userName;
chatPanel.authToken = authToken;
chatPanel.addEventListener("file-preview-open", () => {
	if (workspaceOpen && sidebarOpen) {
		sidebarOpen = false;
		renderApp();
	}
});

const app = document.getElementById("app");
if (!app) throw new Error("App container not found");

type Ui5ButtonDesign = "Default" | "Emphasized" | "Transparent" | "Positive" | "Negative" | "Attention";

function getEffectiveAppTheme() {
	const theme = localStorage.getItem("theme") || "system";
	if (theme === "system") return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
	return theme === "dark" ? "dark" : "light";
}

function applyAppTheme() {
	document.documentElement.classList.toggle("dark", getEffectiveAppTheme() === "dark");
}

function cycleAppTheme() {
	const nextTheme = getEffectiveAppTheme() === "dark" ? "light" : "dark";
	localStorage.setItem("theme", nextTheme);
	applyAppTheme();
}

window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
	const theme = localStorage.getItem("theme");
	if (!theme || theme === "system") {
		applyAppTheme();
		renderApp();
	}
});

function Ui5Button(config: {
	children?: unknown;
	className?: string;
	design?: Ui5ButtonDesign;
	disabled?: boolean;
	ui5Icon?: string;
	onClick?: (event: Event) => void;
	title?: string;
}) {
	return html`
		<ui5-button
			class=${`corp-ui5-button ${config.className ?? ""}`}
			design=${config.design ?? "Transparent"}
			icon=${config.ui5Icon ?? ""}
			title=${config.title ?? ""}
			?disabled=${config.disabled ?? false}
			@click=${config.onClick}
		>
			${config.children ?? ""}
		</ui5-button>
	`;
}

function renderThemeButton() {
	const isDark = getEffectiveAppTheme() === "dark";
	return Ui5Button({
		className: "corp-icon-button",
		ui5Icon: isDark ? "light-mode" : "dark-mode",
		onClick: () => {
			cycleAppTheme();
			renderApp();
		},
		title: isDark ? "Switch to light mode" : "Switch to dark mode",
	});
}

function getUi5Value(event: Event) {
	return String((event.target as HTMLInputElement & { value?: string }).value ?? "");
}

function getUi5SelectValue(event: Event, fallback: string) {
	const target = event.target as HTMLElement & { selectedOption?: { value?: string }; value?: string };
	return String(target.selectedOption?.value ?? target.value ?? fallback);
}

function getRouteFromPath() {
	const workspaceSessionMatch = window.location.pathname.match(/\/(?:w|workspaces?)\/([^/]+)\/(?:s|sessions?)\/([^/]+)/);
	if (workspaceSessionMatch) {
		return {
			workspaceId: decodeURIComponent(workspaceSessionMatch[1]),
			sessionId: decodeURIComponent(workspaceSessionMatch[2]),
		};
	}
	const sessionMatch = window.location.pathname.match(/\/sessions?\/([^/]+)/);
	return {
		workspaceId: undefined,
		sessionId: sessionMatch ? decodeURIComponent(sessionMatch[1]) : undefined,
	};
}

function syncSessionUrl(id: string, replace = false, targetWorkspaceId = workspaceId) {
	if (!id || !targetWorkspaceId) return;
	const nextUrl = `/w/${encodeURIComponent(targetWorkspaceId)}/s/${encodeURIComponent(id)}${window.location.search}`;
	if (`${window.location.pathname}${window.location.search}` === nextUrl) return;
	const state = { workspaceId: targetWorkspaceId, sessionId: id };
	if (replace) window.history.replaceState(state, "", nextUrl);
	else window.history.pushState(state, "", nextUrl);
}

window.addEventListener("popstate", () => {
	const route = getRouteFromPath();
	if (route.workspaceId && route.workspaceId !== workspaceId && workspaces.some((w) => w.id === route.workspaceId)) {
		void switchWorkspace(route.workspaceId);
		return;
	}
	if (route.sessionId && route.sessionId !== channelId && sessions.some((s) => s.channelId === route.sessionId)) {
		channelId = route.sessionId;
		if (workspaceId) sessionStorage.setItem(`sessionId:${workspaceId}`, route.sessionId);
		chatPanel.channelId = route.sessionId;
		void loadWorkspace();
		renderApp();
	}
});

async function loadWorkspaces() {
	workspaceTemplates = await client.getWorkspaceTemplates();
	workspaces = await client.getWorkspaces();
	if (workspaces.length === 0) {
		const created = await client.createWorkspace("Default workspace", { templateId: "sap-cap" });
		if (created) workspaces = [created];
	}
	const route = getRouteFromPath();
	if (route.workspaceId && workspaces.some((w) => w.id === route.workspaceId)) {
		workspaceId = route.workspaceId;
		localStorage.setItem("workspaceId", workspaceId);
		if (route.sessionId) {
			channelId = route.sessionId;
			chatPanel.channelId = channelId;
			sessionStorage.setItem(`sessionId:${workspaceId}`, channelId);
		}
	} else if (!workspaceId || !workspaces.some((w) => w.id === workspaceId)) {
		workspaceId = workspaces[0]?.id || "";
		if (workspaceId) localStorage.setItem("workspaceId", workspaceId);
	}
	await loadSessions();
	startAcpJobPolling();
}

async function loadSessions() {
	if (!workspaceId) {
		sessions = [];
		channelId = "";
		chatPanel.channelId = "";
		renderApp();
		return;
	}
	const route = getRouteFromPath();
	const routedSessionId = route.workspaceId === workspaceId ? route.sessionId : undefined;
	sessions = await client.getSessions(workspaceId);
	if (sessions.length === 0) {
		const created = await client.createSession(workspaceId, "New session");
		if (created) sessions = await client.getSessions(workspaceId);
	}
	const savedSessionId = sessionStorage.getItem(`sessionId:${workspaceId}`) || "";
	const nextSessionId =
		(routedSessionId && sessions.some((s) => s.channelId === routedSessionId) ? routedSessionId : "") ||
		(channelId && sessions.some((s) => s.channelId === channelId) ? channelId : "") ||
		(savedSessionId && sessions.some((s) => s.channelId === savedSessionId) ? savedSessionId : "") ||
		sessions[0]?.channelId ||
		"";
	if (nextSessionId !== channelId) {
		channelId = nextSessionId;
		chatPanel.channelId = channelId;
	}
	if (channelId) sessionStorage.setItem(`sessionId:${workspaceId}`, channelId);
	if (channelId) syncSessionUrl(channelId, true);
	await loadWorkspace();
	renderApp();
}

async function loadWorkspace() {
	if (!channelId) return;
	workspaceTree = (await client.getWorkspace(channelId!)) ?? { artifacts: [], skills: [] };
	await refreshAcpJobs(false);
	renderApp();
}

function normalizeWorkspaceArtifactFilename(path: string): string {
	const prefix = `workspaces/${workspaceId}/artifacts/`;
	return path.startsWith(prefix) ? path.slice(prefix.length) : path.split("/").pop() || path;
}

function switchSession(id: string) {
	channelId = id;
	if (workspaceId) sessionStorage.setItem(`sessionId:${workspaceId}`, id);
	chatPanel.channelId = id;
	syncSessionUrl(id);
	acpJobs = [];
	void loadWorkspace();
	renderApp();
}

async function switchWorkspace(id: string) {
	if (id === workspaceId) return;
	workspaceId = id;
	localStorage.setItem("workspaceId", id);
	channelId = sessionStorage.getItem(`sessionId:${workspaceId}`) || "";
	chatPanel.channelId = channelId;
	if (channelId) syncSessionUrl(channelId);
	workspaceTree = { artifacts: [], skills: [] };
	acpJobs = [];
	databaseTables.clear();
	expandedFolders.clear();
	await loadSessions();
}

async function newWorkspace() {
	if (workspaceTemplates.length === 0) {
		workspaceTemplates = await client.getWorkspaceTemplates();
	}
	newWorkspaceName = "New workspace";
	newWorkspaceTemplateId = workspaceTemplates[0]?.id ?? "sap-cap";
	newWorkspaceError = "";
	newWorkspaceBusy = false;
	createWorkspaceDialogOpen = true;
	renderApp();
}

function closeCreateWorkspaceDialog() {
	if (newWorkspaceBusy) return;
	createWorkspaceDialogOpen = false;
	renderApp();
}

async function submitCreateWorkspace(event?: Event) {
	event?.preventDefault();
	if (newWorkspaceBusy) return;
	const name = newWorkspaceName.trim();
	if (!name) {
		newWorkspaceError = "Workspace name is required";
		renderApp();
		return;
	}
	newWorkspaceBusy = true;
	newWorkspaceError = "";
	renderApp();
	const workspace = await client.createWorkspace(name, { templateId: newWorkspaceTemplateId });
	if (!workspace) {
		newWorkspaceBusy = false;
		newWorkspaceError = "Could not create workspace";
		renderApp();
		return;
	}
	createWorkspaceDialogOpen = false;
	newWorkspaceBusy = false;
	workspaces = await client.getWorkspaces();
	await switchWorkspace(workspace.id);
}

async function newSession() {
	if (!workspaceId) return;
	const session = await client.createSession(workspaceId, "New session");
	if (!session) return;
	await loadSessions();
	switchSession(session.id);
}

function toggleSidebar() {
	sidebarOpen = !sidebarOpen;
	renderApp();
}

//IYH1HC add: pick up the session token handed back by the SSO callback via the
// URL hash fragment (kept out of server logs), then strip it from the address bar.
function consumeSsoHash() {
	if (!window.location.hash) return;
	const params = new URLSearchParams(window.location.hash.slice(1));
	const token = params.get("sso_token");
	const error = params.get("sso_error");
	if (token) {
		authToken = token;
		localStorage.setItem(authTokenKey, token);
	}
	if (error) authError = error;
	if (token || error) {
		window.history.replaceState(null, "", window.location.pathname + window.location.search);
	}
}

//IYH1HC add: discover whether SSO is enabled so the login button can be shown.
async function refreshSsoConfig() {
	ssoConfig = await client.getSsoConfig();
	if (!currentUser) renderApp();
}

async function initializeAuth() {
	const user = await client.me();
	if (!user) {
		currentUser = null;
		renderApp();
		return;
	}
	currentUser = user;
	userName = user.displayName;
	chatPanel.userName = userName;
	chatPanel.authToken = authToken;
	serviceFeatures = await client.getFeatures();
	await loadWorkspaces();
}

async function submitAuth(event: Event) {
	event.preventDefault();
	authError = "";
	renderApp();
	try {
		const result = authMode === "register"
			? await client.register(authEmail, authPassword, authDisplayName)
			: await client.login(authEmail, authPassword);
		authToken = result.token;
		localStorage.setItem(authTokenKey, authToken);
		currentUser = result.user;
		userName = result.user.displayName;
		chatPanel.userName = userName;
		chatPanel.authToken = authToken;
		serviceFeatures = await client.getFeatures();
		await loadWorkspaces();
	} catch (err) {
		authError = err instanceof Error ? err.message : String(err);
		renderApp();
	}
}

async function logout() {
	await client.logout();
	stopAcpJobPolling();
	authToken = null;
	localStorage.removeItem(authTokenKey);
	authDisplayName = "";
	authEmail = "";
	authPassword = "";
	currentUser = null;
	userMenuOpen = false;
	providerDialogOpen = false;
	workspaces = [];
	sessions = [];
	workspaceId = "";
	channelId = "";
	chatPanel.channelId = "";
	chatPanel.authToken = null;
	renderApp();
}

async function refreshAcpJobs(shouldRender = true) {
	if (!serviceFeatures.agentWorkers) {
		acpJobs = [];
		if (shouldRender) renderApp();
		return;
	}
	if (!channelId) {
		acpJobs = [];
		if (shouldRender) renderApp();
		return;
	}
	acpJobs = await client.getAcpJobs(channelId);
	if (shouldRender) renderApp();
}

async function refreshAgentWorkers(shouldRender = true) {
	if (!serviceFeatures.agentWorkers) {
		agentWorkers = [];
		if (shouldRender) renderApp();
		return;
	}
	agentWorkers = await client.getConnectors("agent-runtime");
	if (shouldRender) renderApp();
}

async function refreshWorkspaceSandbox(shouldRender = true) {
	workspaceSandboxStatus = workspaceId ? await client.getWorkspaceSandbox(workspaceId) : null;
	if (shouldRender) renderApp();
}

async function refreshWorkspaceEvents(shouldRender = true) {
	if (!serviceFeatures.reminders) {
		workspaceEvents = [];
		if (shouldRender) renderApp();
		return;
	}
	if (!workspaceId) {
		workspaceEvents = [];
		if (shouldRender) renderApp();
		return;
	}
	workspaceEventsBusy = true;
	workspaceEventsError = "";
	if (shouldRender) renderApp();
	workspaceEvents = await client.getWorkspaceEvents(workspaceId);
	workspaceEventsBusy = false;
	if (shouldRender) renderApp();
}

async function openWorkspaceEventsDialog() {
	if (!serviceFeatures.reminders) return;
	workspaceEventsDialogOpen = true;
	await refreshWorkspaceEvents(false);
	renderApp();
}

function closeWorkspaceEventsDialog() {
	workspaceEventsDialogOpen = false;
	workspaceEventsError = "";
	renderApp();
}

async function deleteWorkspaceEvent(filename: string) {
	if (!serviceFeatures.reminders) return;
	if (!workspaceId) return;
	workspaceEventsBusy = true;
	workspaceEventsError = "";
	renderApp();
	const ok = await client.deleteWorkspaceEvent(workspaceId, filename);
	if (!ok) {
		workspaceEventsBusy = false;
		workspaceEventsError = "Could not cancel scheduled event";
		renderApp();
		return;
	}
	await refreshWorkspaceEvents(false);
	renderApp();
}

async function refreshBusinessConnectors(shouldRender = true) {
	businessConnectors = await client.getConnectors("business-connector");
	if (shouldRender) renderApp();
}

function startAcpJobPolling() {
	stopAcpJobPolling();
	acpJobPollTimer = window.setInterval(() => {
		if (serviceFeatures.agentWorkers) {
			void refreshAcpJobs();
			void refreshAgentWorkers();
		}
		void refreshBusinessConnectors();
	}, 2000);
	if (serviceFeatures.agentWorkers) {
		void refreshAcpJobs();
		void refreshAgentWorkers();
	}
	void refreshBusinessConnectors();
}

function stopAcpJobPolling() {
	if (acpJobPollTimer !== undefined) {
		window.clearInterval(acpJobPollTimer);
		acpJobPollTimer = undefined;
	}
}

async function cancelAcpJob(jobId: string) {
	if (!serviceFeatures.agentWorkers) return;
	if (!channelId) return;
	await client.cancelAcpJob(channelId, jobId);
	await refreshAcpJobs();
}

async function connectAgentWorker(agent: string) {
	if (!serviceFeatures.agentWorkers) return;
	agentWorkerBusy = agent;
	agentWorkerLoginOutput = "";
	renderApp();
	try {
		const login = await client.startConnectorLogin(agent);
		if (!login) throw new Error("Could not start worker login");
		if (login.url) window.open(login.url, "_blank", "noopener,noreferrer");
		const deadline = Date.now() + 180000;
		let lastOutput = login.output ?? "";
		while (Date.now() < deadline) {
			const status = await client.getConnectorLoginStatus(agent, login.loginId);
			if (!status) break;
			lastOutput = status.output ?? lastOutput;
			agentWorkerLoginOutput = lastOutput;
			const url = status.url;
			if (url) window.open(url, "_blank", "noopener,noreferrer");
			renderApp();
			if (status.status === "complete") break;
			if (status.status === "error") throw new Error(status.error || "Worker login failed");
			if (/paste|enter|code|verification/i.test(lastOutput)) {
				const input = prompt(`${login.label} login input:`);
				if (input) await client.sendConnectorLoginInput(agent, login.loginId, input);
			}
			await new Promise((resolve) => setTimeout(resolve, 1500));
		}
	} catch (err) {
		agentWorkerLoginOutput = err instanceof Error ? err.message : String(err);
	} finally {
		agentWorkerBusy = "";
		await refreshAgentWorkers(false);
		renderApp();
	}
}

async function disconnectAgentWorker(agent: string) {
	if (!serviceFeatures.agentWorkers) return;
	agentWorkerBusy = agent;
	renderApp();
	try {
		await client.logoutConnector(agent);
		await refreshAgentWorkers(false);
	} finally {
		agentWorkerBusy = "";
		renderApp();
	}
}

async function connectBusinessConnector(connectorId: string) {
	businessConnectorBusy = connectorId;
	businessConnectorLoginOutput = "";
	renderApp();
	try {
		const login = await client.startConnectorLogin(connectorId);
		if (!login) throw new Error("Could not start connector login");
		if (login.url) window.open(login.url, "_blank", "noopener,noreferrer");
		const deadline = Date.now() + 180000;
		let lastOutput = login.output ?? "";
		while (Date.now() < deadline) {
			const status = await client.getConnectorLoginStatus(connectorId, login.loginId);
			if (!status) break;
			lastOutput = status.output ?? lastOutput;
			businessConnectorLoginOutput = lastOutput;
			const url = status.url;
			if (url) window.open(url, "_blank", "noopener,noreferrer");
			renderApp();
			if (status.status === "complete") break;
			if (status.status === "error") throw new Error(status.error || "Connector login failed");
			if (/paste|enter|code|verification/i.test(lastOutput)) {
				const input = prompt(`${login.label} login input:`);
				if (input) await client.sendConnectorLoginInput(connectorId, login.loginId, input);
			}
			await new Promise((resolve) => setTimeout(resolve, 1500));
		}
	} catch (err) {
		businessConnectorLoginOutput = err instanceof Error ? err.message : String(err);
	} finally {
		businessConnectorBusy = "";
		await refreshBusinessConnectors(false);
		renderApp();
	}
}

async function disconnectBusinessConnector(connectorId: string) {
	businessConnectorBusy = connectorId;
	renderApp();
	try {
		await client.logoutConnector(connectorId);
		await refreshBusinessConnectors(false);
	} finally {
		businessConnectorBusy = "";
		renderApp();
	}
}

function openProviderDialog() {
	userMenuOpen = false;
	providerDialogOpen = true;
	codexAuthError = "";
	codexLoginCode = "";
	providerKeyInput = ""; //IYH1HC add
	providerKeyError = ""; //IYH1HC add
	providerSavedNotice = ""; //IYH1HC add
	modelFilter = ""; //IYH1HC add
	void refreshCodexStatus();
	void loadLlmConfig(); //IYH1HC add
	renderApp();
}

function closeProviderDialog() {
	providerDialogOpen = false;
	renderApp();
}

async function openWorkspaceSettingsDialog() {
	if (!workspaceId) return;
	workspaceSettingsDialogOpen = true;
	workspaceSettingsTab = "agent";
	workspaceSettingsError = "";
	workspaceSettingsBusy = true;
	renderApp();
	const [settings] = await Promise.all([
		client.getWorkspaceSettings(workspaceId),
		refreshBusinessConnectors(false),
		serviceFeatures.agentWorkers ? refreshAgentWorkers(false) : Promise.resolve(),
		refreshWorkspaceSandbox(false),
	]);
	workspaceSettings = settings;
	workspaceAgentPromptDraft = workspaceSettings.agent?.prompt ?? "";
	workspaceSettingsBusy = false;
	renderApp();
}

async function openAgentWorkerSettingsDialog() {
	if (!serviceFeatures.agentWorkers) return;
	if (!workspaceId) return;
	workspaceSettingsDialogOpen = true;
	workspaceSettingsTab = "workers";
	workspaceSettingsError = "";
	workspaceSettingsBusy = true;
	renderApp();
	const [settings] = await Promise.all([
		client.getWorkspaceSettings(workspaceId),
		refreshAgentWorkers(false),
		refreshWorkspaceSandbox(false),
	]);
	workspaceSettings = settings;
	workspaceAgentPromptDraft = workspaceSettings.agent?.prompt ?? "";
	workspaceSettingsBusy = false;
	renderApp();
}


function closeWorkspaceSettingsDialog() {
	workspaceSettingsDialogOpen = false;
	workspaceSettingsError = "";
	renderApp();
}

async function saveWorkspaceSettings(event: Event) {
	event.preventDefault();
	if (!workspaceId) return;
	const form = ((event.currentTarget as HTMLElement).closest?.("form") ?? event.currentTarget) as HTMLFormElement;
	const data = new FormData(form);

	workspaceSettingsBusy = true;
	workspaceSettingsError = "";
	renderApp();
	const next: WorkspaceSettings = {
		agent: {
			prompt: workspaceAgentPromptDraft,
			promptFile: workspaceSettings.agent?.promptFile,
		},
		sapConnection: workspaceSettingsTab === "connection"
			? {
				enabled: true,
				systemUrl: String(data.get("sapSystemUrl") || ""),
				client: String(data.get("sapClient") || ""),
				username: String(data.get("sapUsername") || ""),
				authType: String(data.get("sapAuthType") || "basic") as "basic" | "destination" | "oauth",
				destinationName: String(data.get("sapDestinationName") || ""),
			}
			: workspaceSettings.sapConnection,
		tools: workspaceSettings.tools,
		connectors: workspaceSettingsTab === "connection"
			? {
				allowed: data.getAll("allowedConnectors").map(String),
			}
			: workspaceSettings.connectors,
		mcp: workspaceSettings.mcp,
	};
	const saved = await client.updateWorkspaceSettings(workspaceId, next);
	workspaceSettingsBusy = false;
	if (!saved) {
		workspaceSettingsError = "Could not save workspace settings";
		renderApp();
		return;
	}
	workspaceSettings = saved;
	workspaceSettingsDialogOpen = false;
	renderApp();
}

function setProvider(provider: string) {
	selectedProvider = provider;
	localStorage.setItem(providerKey, provider);
	codexAuthError = "";
	providerKeyInput = ""; //IYH1HC add
	providerKeyError = ""; //IYH1HC add
	providerSavedNotice = ""; //IYH1HC add
	modelFilter = ""; //IYH1HC add
	apiKeysExpanded = !llmConfig.providers.find((p) => p.id === provider)?.hasKey; //IYH1HC add
	if (provider === "openai-codex") void refreshCodexStatus();
	renderApp();
}

async function refreshCodexStatus() {
	const status = await client.getCodexAuthStatus();
	codexConfigured = status?.configured === true;
	renderApp();
}

//IYH1HC add: providers that use the key + model-selection flow (mirrors the backend allowlist).
const LLM_KEY_PROVIDERS = new Set(["openai", "anthropic", "google"]);

//IYH1HC add: load per-provider key/model config for the dialog.
async function loadLlmConfig() {
	llmConfigLoading = true;
	providerKeyError = "";
	renderApp();
	llmConfig = await client.getLlmConfig();
	llmConfigLoading = false;
	//IYH1HC add: expand the API Keys section automatically when no key is stored yet.
	apiKeysExpanded = !currentProviderConfig()?.hasKey;
	renderApp();
}

function currentProviderConfig() {
	return llmConfig.providers.find((p) => p.id === selectedProvider);
}

//IYH1HC add: forget the stored API key for the selected provider.
async function deleteProviderKey() {
	if (!LLM_KEY_PROVIDERS.has(selectedProvider)) return;
	providerKeySaving = true;
	providerKeyError = "";
	providerSavedNotice = "";
	renderApp();
	try {
		await client.deleteProviderKey(selectedProvider);
		await loadLlmConfig();
	} catch (err) {
		providerKeyError = err instanceof Error ? err.message : String(err);
	} finally {
		providerKeySaving = false;
		renderApp();
	}
}

//IYH1HC add: models for the current provider matching the search box.
function filteredModels() {
	const provider = currentProviderConfig();
	if (!provider) return [];
	const q = modelFilter.trim().toLowerCase();
	if (!q) return provider.models;
	return provider.models.filter((m) => m.name.toLowerCase().includes(q) || m.id.toLowerCase().includes(q));
}

//IYH1HC add: toggle a model and auto-save immediately (no Save button). Optimistic
// local update, then persist the full active set and refresh the chatbox listbox.
async function toggleModelActive(modelId: string, active: boolean) {
	const provider = currentProviderConfig();
	if (!provider) return;
	const model = provider.models.find((m) => m.id === modelId);
	if (!model) return;
	model.active = active;
	providerKeyError = "";
	providerSavedNotice = "";
	renderApp();
	try {
		const activeIds = provider.models.filter((m) => m.active).map((m) => m.id);
		await client.setActiveModels(selectedProvider, activeIds);
		void chatPanel.refreshActiveModels();
	} catch (err) {
		model.active = !active; // revert on failure
		providerKeyError = err instanceof Error ? err.message : String(err);
		renderApp();
	}
}

//IYH1HC add: persist the typed API key on Enter/blur (no Save button). No-op when empty.
async function commitProviderKey() {
	if (!LLM_KEY_PROVIDERS.has(selectedProvider) || !providerKeyInput.trim()) return;
	providerKeySaving = true;
	providerKeyError = "";
	providerSavedNotice = "";
	renderApp();
	try {
		await client.saveProviderKey(selectedProvider, providerKeyInput.trim());
		providerKeyInput = "";
		await loadLlmConfig();
		providerSavedNotice = "Saved";
	} catch (err) {
		providerKeyError = err instanceof Error ? err.message : String(err);
	} finally {
		providerKeySaving = false;
		renderApp();
	}
}

//IYH1HC add: API-key toggle handler. On → save typed key (no-op if empty); off → forget key.
async function toggleProviderKey(enabled: boolean) {
	if (enabled) {
		await commitProviderKey();
	} else {
		await deleteProviderKey();
	}
}

async function startCodexLogin() {
	codexAuthBusy = true;
	codexAuthError = "";
	renderApp();
	try {
		const login = await client.startCodexLogin();
		codexLoginId = login.loginId;
		codexLoginUrl = login.url;
		window.open(login.url, "_blank", "noopener,noreferrer");
	} catch (err) {
		codexAuthError = err instanceof Error ? err.message : String(err);
	} finally {
		codexAuthBusy = false;
		renderApp();
	}
}

async function submitCodexCode() {
	if (!codexLoginId || !codexLoginCode.trim()) return;
	codexAuthBusy = true;
	codexAuthError = "";
	renderApp();
	try {
		await client.submitCodexLoginCode(codexLoginId, codexLoginCode.trim());
		const deadline = Date.now() + 15000;
		while (Date.now() < deadline) {
			const status = await client.getCodexLoginStatus(codexLoginId);
			if (status?.status === "complete") {
				codexConfigured = true;
				codexLoginId = "";
				codexLoginUrl = "";
				codexLoginCode = "";
				break;
			}
			if (status?.status === "error") {
				codexAuthError = status.error || "Codex login failed";
				break;
			}
			await new Promise((resolve) => setTimeout(resolve, 750));
		}
		await refreshCodexStatus();
	} catch (err) {
		codexAuthError = err instanceof Error ? err.message : String(err);
	} finally {
		codexAuthBusy = false;
		renderApp();
	}
}



function toggleWorkspace() {
	workspaceOpen = !workspaceOpen;
	renderApp();
}

function toggleFolder(path: string) {
	if (expandedFolders.has(path)) expandedFolders.delete(path);
	else expandedFolders.add(path);
	renderApp();
}

async function openWorkspaceFile(path: string) {
	const title = normalizeWorkspaceArtifactFilename(path);
	(chatPanel as any).openFilePreview?.(path, title);
}

function isDuckDbFile(path: string): boolean {
	return path.toLowerCase().endsWith(".duckdb");
}

async function toggleDatabase(path: string) {
	if (expandedFolders.has(path)) {
		expandedFolders.delete(path);
		renderApp();
		return;
	}
	expandedFolders.add(path);
	if (!databaseTables.has(path)) {
		databaseTables.set(path, await client.getDatabaseTables(path));
	}
	renderApp();
}

function openDatabaseTable(databasePath: string, tableName: string) {
	(chatPanel as any).openTablePreview?.(databasePath, tableName, tableName);
}

function renderDatabaseFile(node: WorkspaceNode, depth: number) {
	const open = expandedFolders.has(node.path);
	const tables = databaseTables.get(node.path);
	return html`<div>
		<button class="w-full text-left px-2 py-1 hover:bg-accent rounded flex items-center gap-1 text-xs" style="padding-left: ${depth * 12 + 2}px" @click=${() => void toggleDatabase(node.path)}>
			<span class="inline-flex h-4 w-4 shrink-0 items-center justify-center [&>svg]:h-4 [&>svg]:w-4">${icon(open ? ChevronDown : ChevronRight, "xs")}</span>
			<span class="inline-flex h-4 w-4 shrink-0 items-center justify-center [&>svg]:h-4 [&>svg]:w-4">${icon(open ? FolderOpen : Folder, "xs")}</span>
			<span class="truncate">${node.name}</span>
		</button>
		${open
			? html`<div>
				${tables
					? tables.length > 0
						? tables.map((table) => html`
							<button class="w-full text-left px-2 py-1 hover:bg-accent rounded flex items-center gap-1 text-xs" style="padding-left: ${(depth + 1) * 12 + 2}px" @click=${() => openDatabaseTable(node.path, table.name)}>
								<span class="inline-flex h-4 w-4 shrink-0 items-center justify-center [&>svg]:h-4 [&>svg]:w-4">${icon(Table2, "xs")}</span>
								<span class="truncate">${table.name}</span>
							</button>
						`)
						: html`<div class="px-2 py-1 text-xs text-muted-foreground" style="padding-left: ${(depth + 1) * 12 + 2}px">No records</div>`
					: html`<div class="px-2 py-1 text-xs text-muted-foreground" style="padding-left: ${(depth + 1) * 12 + 2}px">Loading...</div>`}
			</div>`
			: ""}
	</div>`;
}

function renderArtifacts() {
	const hasFiles = workspaceTree.artifacts.length > 0;
	if (!hasFiles) {
		return html`<div class="text-xs text-muted-foreground px-2 py-1">No artifacts</div>`;
	}
	return html`${renderTree(workspaceTree.artifacts)}`;
}

function renderAcpWorkersPanel() {
	if (!serviceFeatures.agentWorkers) return "";
	const recent = acpJobs.slice(0, 5);
	return html`
		<div class="shrink-0 border-t border-border p-2">
			<div class="mb-1 flex items-center justify-between gap-2">
				<div class="text-xs font-medium text-muted-foreground">Agent Workers</div>
				<div class="flex items-center gap-1">
					<ui5-button
						class="corp-ui5-button corp-tight-icon-button"
						design="Transparent"
						icon="refresh"
						title="Refresh agent workers"
						@click=${() => { void refreshAgentWorkers(false); void refreshAcpJobs(); }}
					></ui5-button>
					<ui5-button
						class="corp-ui5-button corp-tight-icon-button"
						design="Transparent"
						icon=${agentWorkersCollapsed ? "navigation-down-arrow" : "navigation-right-arrow"}
						title=${agentWorkersCollapsed ? "Expand agent workers" : "Collapse agent workers"}
						@click=${() => {
							agentWorkersCollapsed = !agentWorkersCollapsed;
							localStorage.setItem("agentWorkersCollapsed", String(agentWorkersCollapsed));
							renderApp();
						}}
					></ui5-button>
				</div>
			</div>
			${agentWorkersCollapsed ? "" : html`
			<div class="mb-2 flex flex-wrap gap-1.5">
				${agentWorkers.length === 0
					? html`<div class="px-1 py-1 text-xs text-muted-foreground">Loading workers...</div>`
						: agentWorkers.map((worker) => html`
							<ui5-button
								class="corp-ui5-button"
								design="Transparent"
								title=${`${worker.label}: ${worker.connected ? "connected" : "not connected"}`}
								@click=${() => void openAgentWorkerSettingsDialog()}
							>
								<span class="inline-flex items-center gap-1 text-xs">
									<span class="h-1.5 w-1.5 rounded-full ${worker.connected ? "bg-emerald-500" : "bg-red-500"}"></span>
									${worker.label}
								</span>
							</ui5-button>
						`)}
			</div>
			${recent.length === 0
				? html`<div class="px-1 py-1 text-xs text-muted-foreground">No worker jobs</div>`
				: html`
					<div class="flex max-h-32 flex-col gap-1 overflow-y-auto pr-1">
						${recent.map((job) => {
							const canCancel = job.status === "queued" || job.status === "running";
							return html`
								<div class="rounded border border-border/70 bg-muted/20 px-2 py-1.5">
									<div class="flex items-center gap-2">
										<span class="text-xs font-medium text-foreground">${job.agent}</span>
										<span class="rounded bg-background px-1.5 py-0.5 text-[10px] text-muted-foreground">${job.status}</span>
										${canCancel ? html`
											<ui5-button
												class="corp-ui5-button corp-tight-icon-button ml-auto"
												design="Negative"
												icon="decline"
												title="Cancel worker"
												@click=${() => void cancelAcpJob(job.id)}
											></ui5-button>
										` : ""}
									</div>
									<div class="mt-1 truncate text-xs text-muted-foreground" title=${job.task}>${job.task}</div>
								</div>
							`;
						})}
					</div>
				`}
			`}
		</div>
	`;
}

function renderAgentWorkerSettings() {
	return html`
		<section class="flex flex-col gap-3">
			<div>
				<div class="text-sm font-medium">Agent workers</div>
				<div class="text-xs text-muted-foreground">Connect each CLI agent with your own account. Worker auth is isolated per user.</div>
			</div>
			<div class="flex flex-col gap-2">
				${agentWorkers.length === 0
					? html`<div class="rounded border border-border p-3 text-xs text-muted-foreground">Loading workers...</div>`
					: agentWorkers.map((worker) => html`
						<div class="flex items-center gap-3 rounded border border-border p-3">
							<div class="min-w-0 flex-1">
								<div class="text-sm font-medium">${worker.label}</div>
								<div class="text-xs text-muted-foreground">
									${worker.connected ? "Connected" : "Not connected"}
									${worker.authMode ? html`<span> · ${worker.authMode}</span>` : ""}
									${worker.accessPolicy?.allowedInDocker ? html`<span> · sandbox enabled</span>` : ""}
								</div>
							</div>
							<ui5-button
								class="corp-ui5-button"
								design=${worker.connected ? "Transparent" : "Emphasized"}
								?disabled=${agentWorkerBusy === worker.id}
								@click=${() => worker.connected ? void disconnectAgentWorker(worker.id) : void connectAgentWorker(worker.id)}
							>
								${agentWorkerBusy === worker.id ? "Working..." : worker.connected ? "Disconnect" : "Connect"}
							</ui5-button>
						</div>
					`)}
			</div>
			${agentWorkerLoginOutput ? html`
				<details class="rounded border border-border bg-muted/20 px-3 py-2 text-xs" open>
					<summary class="cursor-pointer text-muted-foreground">Login output</summary>
					<pre class="mt-2 max-h-56 overflow-auto whitespace-pre-wrap rounded bg-background p-2 text-[11px]">${agentWorkerLoginOutput}</pre>
				</details>
			` : ""}
		</section>
	`;
}

function renderSandboxSettings() {
	const status = workspaceSandboxStatus;
	const statusClass = status?.running || status?.status === "host" ? "bg-emerald-500" : status?.status === "error" || status?.status === "runtime-missing" ? "bg-red-500" : "bg-amber-500";
	const statusText = status ? status.status.replaceAll("-", " ") : "unknown";
	return html`
		<section class="flex flex-col gap-4">
			<div class="flex items-start justify-between gap-3">
				<div>
					<div class="text-sm font-medium">Sandbox</div>
					<div class="text-xs text-muted-foreground">Runtime, container, workspace paths, and mounted host directories for this workspace.</div>
				</div>
				${Ui5Button({
					children: "Refresh",
					ui5Icon: "refresh",
					onClick: () => { void refreshWorkspaceSandbox(); },
					title: "Refresh sandbox status",
				})}
			</div>
			${!status
				? html`<div class="rounded border border-border p-3 text-xs text-muted-foreground">Sandbox status is unavailable.</div>`
				: html`
					<div class="grid grid-cols-2 gap-2">
						<div class="rounded border border-border p-3">
							<div class="text-[11px] uppercase text-muted-foreground">Status</div>
							<div class="mt-1 inline-flex items-center gap-2 text-sm font-medium">
								<span class="h-2 w-2 rounded-full ${statusClass}"></span>
								${statusText}
							</div>
						</div>
						<div class="rounded border border-border p-3">
							<div class="text-[11px] uppercase text-muted-foreground">Mode</div>
							<div class="mt-1 text-sm font-medium">${status.mode}</div>
						</div>
						<div class="rounded border border-border p-3">
							<div class="text-[11px] uppercase text-muted-foreground">Runtime</div>
							<div class="mt-1 text-sm font-medium">${status.runtime}</div>
						</div>
						<div class="rounded border border-border p-3">
							<div class="text-[11px] uppercase text-muted-foreground">Container</div>
							<div class="mt-1 truncate font-mono text-xs" title=${status.container ?? "none"}>${status.container ?? "none"}</div>
						</div>
					</div>
					<div class="rounded border border-border p-3">
						<div class="text-[11px] uppercase text-muted-foreground">Runtime paths</div>
						<div class="mt-2 grid gap-1 font-mono text-xs">
							<div><span class="text-muted-foreground">workspace:</span> ${status.workspacePath}</div>
							${status.usersPath ? html`<div><span class="text-muted-foreground">users:</span> ${status.usersPath}</div>` : ""}
							${status.image ? html`<div><span class="text-muted-foreground">image:</span> ${status.image}</div>` : ""}
						</div>
					</div>
					<div class="rounded border border-border p-3">
						<div class="text-[11px] uppercase text-muted-foreground">Mounts</div>
						${status.mounts.length === 0
							? html`<div class="mt-2 text-xs text-muted-foreground">No container mounts in host mode.</div>`
							: html`
								<div class="mt-2 flex flex-col gap-2">
									${status.mounts.map((mount) => html`
										<div class="rounded bg-muted/30 p-2 font-mono text-[11px]">
											<div class="truncate" title=${mount.host}>${mount.host}</div>
											<div class="text-muted-foreground">to ${mount.container} (${mount.mode})</div>
										</div>
									`)}
								</div>
							`}
					</div>
					${status.error ? html`
						<details class="rounded border border-destructive/40 bg-destructive/5 px-3 py-2 text-xs" open>
							<summary class="cursor-pointer text-destructive">Sandbox error</summary>
							<pre class="mt-2 max-h-40 overflow-auto whitespace-pre-wrap rounded bg-background p-2 text-[11px]">${status.error}</pre>
						</details>
					` : ""}
				`}
		</section>
	`;
}

function renderConnectorStatusBadge(connector: ConnectorStatus) {
	return html`
		<span class="inline-flex items-center gap-1 rounded-full border border-border bg-background px-2 py-0.5 text-xs text-muted-foreground">
			<span class="h-1.5 w-1.5 rounded-full ${connector.connected ? "bg-emerald-500" : "bg-red-500"}"></span>
			${connector.connected ? "Connected" : "Not connected"}
		</span>
	`;
}

function renderBusinessConnectorSettings(sap: WorkspaceSettings["sapConnection"]) {
	const allowedConnectors = new Set(workspaceSettings.connectors?.allowed ?? []);
	return html`
		<section class="flex flex-col gap-4">
			<div>
				<div class="text-sm font-medium">Business connectors</div>
				<div class="text-xs text-muted-foreground">Connect user-owned CLI profiles for tools such as SAP ADT and GitHub. These run through core-service, not directly inside agent sandboxes.</div>
			</div>
			<div class="grid grid-cols-1 gap-2">
				${businessConnectors.length === 0
					? html`<div class="rounded border border-border p-3 text-xs text-muted-foreground">Loading connectors...</div>`
					: businessConnectors.map((connector) => html`
						<div class="rounded border border-border p-3">
							<div class="flex items-center gap-3">
								<div class="min-w-0 flex-1">
									<div class="flex flex-wrap items-center gap-2">
										<div class="text-sm font-medium">${connector.label}</div>
										${renderConnectorStatusBadge(connector)}
									</div>
									<div class="mt-1 text-xs text-muted-foreground">
										${connector.authMode}
										<span> · host proxy</span>
										${connector.accessPolicy?.network ? html`<span> · network ${connector.accessPolicy.network}</span>` : ""}
									</div>
									</div>
									<ui5-checkbox
										class="corp-ui5-checkbox"
										text="Allow usage"
										name="allowedConnectors"
										value=${connector.id}
										?checked=${allowedConnectors.has(connector.id)}
									></ui5-checkbox>
									<ui5-button
										class="corp-ui5-button"
										design=${connector.connected ? "Transparent" : "Emphasized"}
										?disabled=${businessConnectorBusy === connector.id}
										@click=${() => connector.connected ? void disconnectBusinessConnector(connector.id) : void connectBusinessConnector(connector.id)}
									>
										${businessConnectorBusy === connector.id ? "Working..." : connector.connected ? "Disconnect" : "Connect"}
									</ui5-button>
								</div>
								${connector.id === "sap-adt" ? html`
									<details class="mt-3 rounded border border-border/70 bg-muted/20 px-3 py-2">
										<summary class="cursor-pointer text-xs font-medium text-muted-foreground">Connection parameters</summary>
										<div class="mt-3 flex flex-col gap-3">
											<div class="text-xs text-muted-foreground">Optional defaults passed to SAP ADT commands and profile setup.</div>
											<div class="grid grid-cols-2 gap-2">
												<ui5-input
													class="corp-ui5-input"
													placeholder="System URL"
													name="sapSystemUrl"
													value=${sap?.systemUrl ?? ""}
												></ui5-input>
												<ui5-input
													class="corp-ui5-input"
													placeholder="Client"
													name="sapClient"
													value=${sap?.client ?? ""}
												></ui5-input>
												<ui5-input
													class="corp-ui5-input"
													placeholder="Username"
													name="sapUsername"
													value=${sap?.username ?? ""}
												></ui5-input>
												<ui5-select class="corp-ui5-select" name="sapAuthType">
													<ui5-option value="basic" ?selected=${(sap?.authType ?? "basic") === "basic"}>Basic</ui5-option>
													<ui5-option value="destination" ?selected=${sap?.authType === "destination"}>Destination</ui5-option>
													<ui5-option value="oauth" ?selected=${sap?.authType === "oauth"}>OAuth</ui5-option>
												</ui5-select>
											</div>
											<ui5-input
												class="corp-ui5-input"
												placeholder="Profile or destination name"
												name="sapDestinationName"
												value=${sap?.destinationName ?? ""}
											></ui5-input>
										</div>
									</details>
								` : ""}
						</div>
					`)}
			</div>
			${businessConnectorLoginOutput ? html`
				<details class="rounded border border-border bg-muted/20 px-3 py-2 text-xs" open>
					<summary class="cursor-pointer text-muted-foreground">Connector login output</summary>
					<pre class="mt-2 max-h-56 overflow-auto whitespace-pre-wrap rounded bg-background p-2 text-[11px]">${businessConnectorLoginOutput}</pre>
				</details>
			` : ""}
		</section>
	`;
}

function renderTree(nodes: WorkspaceNode[], depth = 0) {
	return nodes.map((node) => {
		if (node.type === "directory") {
			const open = expandedFolders.has(node.path);
			return html`<div>
				<button class="w-full text-left px-2 py-1 hover:bg-accent rounded flex items-center gap-1 text-xs" style="padding-left: ${depth * 12 + 2}px" @click=${() => toggleFolder(node.path)}>
					<span class="inline-flex h-4 w-4 shrink-0 items-center justify-center [&>svg]:h-4 [&>svg]:w-4">${icon(open ? ChevronDown : ChevronRight, "xs")}</span>
					<span class="inline-flex h-4 w-4 shrink-0 items-center justify-center [&>svg]:h-4 [&>svg]:w-4">${icon(open ? FolderOpen : Folder, "xs")}</span>
					<span class="truncate">${node.name}</span>
				</button>
				${open && node.children ? html`<div>${renderTree(node.children, depth + 1)}</div>` : ""}
			</div>`;
		}
		if (isDuckDbFile(node.path)) {
			return renderDatabaseFile(node, depth);
		}
		return html`<button class="w-full text-left px-2 py-1 hover:bg-accent rounded flex items-center gap-1 text-xs" style="padding-left: ${depth * 12 + 2}px" @click=${() => openWorkspaceFile(node.path)}>
			<span class="inline-flex h-4 w-4 shrink-0 items-center justify-center [&>svg]:h-4 [&>svg]:w-4">${icon(File, "xs")}</span>
			<span class="truncate">${node.name}</span>
		</button>`;
	});
}
function formatTime(ms: number): string {
	const diff = Date.now() - ms;
	if (diff < 60_000) return "just now";
	if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
	if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
	return `${Math.floor(diff / 86_400_000)}d ago`;
}

function getWorkspaceEventSchedule(event: WorkspaceScheduledEvent): string {
	if (!event.valid) return "Invalid event file";
	if (event.type === "periodic") return `${event.schedule ?? "No schedule"}${event.timezone ? ` · ${event.timezone}` : ""}`;
	if (event.type === "one-shot") return event.at ?? "No trigger time";
	if (event.type === "immediate") return "Immediate";
	return event.type || "Unknown";
}

function getWorkspaceEventTypeLabel(event: WorkspaceScheduledEvent): string {
	if (!event.valid) return "invalid";
	if (event.type === "periodic") return "recurring";
	if (event.type === "one-shot") return "one-time";
	if (event.type === "immediate") return "immediate";
	return event.type || "unknown";
}

function renderWorkspaceEventsDialog() {
	if (!serviceFeatures.reminders) return "";
	if (!workspaceEventsDialogOpen) return "";
	return html`
		<div class="fixed inset-0 z-50 flex items-center justify-center bg-black/30 px-4" @click=${closeWorkspaceEventsDialog}>
			<div class="w-full max-w-2xl rounded border border-border bg-background shadow-xl" @click=${(e: Event) => e.stopPropagation()}>
				<div class="flex items-center justify-between border-b border-border px-4 py-3">
					<div>
						<div class="text-sm font-semibold">Scheduled events</div>
						<div class="text-xs text-muted-foreground">Workspace reminders and recurring wakeups</div>
					</div>
					<div class="flex items-center gap-2">
						${Ui5Button({
							className: "corp-tight-icon-button",
							ui5Icon: "refresh",
							onClick: () => void refreshWorkspaceEvents(),
							title: "Refresh scheduled events",
						})}
						${Ui5Button({ className: "corp-tight-icon-button", ui5Icon: "decline", onClick: closeWorkspaceEventsDialog, title: "Close" })}
					</div>
				</div>
				<div class="max-h-[65vh] overflow-y-auto p-4">
					${workspaceEventsBusy
						? html`<div class="text-sm text-muted-foreground">Loading scheduled events...</div>`
						: workspaceEvents.length === 0
							? html`<div class="rounded border border-border bg-muted/20 px-3 py-4 text-sm text-muted-foreground">No scheduled events in this workspace.</div>`
							: html`
								<div class="flex flex-col gap-2">
									${workspaceEvents.map((event) => html`
										<div class="rounded border border-border bg-background p-3">
											<div class="flex items-start justify-between gap-3">
												<div class="min-w-0 flex-1">
													<div class="flex flex-wrap items-center gap-2">
														<span class="text-sm font-medium">${event.text || event.filename}</span>
														<span class="rounded bg-muted px-2 py-0.5 text-[11px] text-muted-foreground">${getWorkspaceEventTypeLabel(event)}</span>
													</div>
													<div class="mt-1 text-xs text-muted-foreground">${getWorkspaceEventSchedule(event)}</div>
													<div class="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
														<span class="font-mono">${event.filename}</span>
														${event.channelId ? html`<span>Session: <span class="font-mono">${event.channelId}</span></span>` : ""}
														${event.modifiedAt ? html`<span>Updated ${formatTime(event.modifiedAt)}</span>` : ""}
													</div>
													${event.error ? html`<div class="mt-2 text-xs text-destructive">${event.error}</div>` : ""}
												</div>
												<button
													class="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded border border-border text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-50"
													title="Cancel scheduled event"
													?disabled=${workspaceEventsBusy}
													@click=${() => void deleteWorkspaceEvent(event.filename)}
												>
													${icon(Trash2, "xs")}
												</button>
											</div>
										</div>
									`)}
								</div>
							`}
					${workspaceEventsError ? html`<div class="mt-3 text-xs text-destructive">${workspaceEventsError}</div>` : ""}
				</div>
				<div class="flex justify-end border-t border-border px-4 py-3">
					${Ui5Button({ children: "Close", onClick: closeWorkspaceEventsDialog })}
				</div>
			</div>
		</div>
	`;
}

function renderUserMenu() {
	if (!currentUser) return "";
	return html`
		<div class="relative">
			${Ui5Button({
				className: "corp-icon-button",
				ui5Icon: "employee",
				onClick: () => { userMenuOpen = !userMenuOpen; renderApp(); },
				title: "User menu",
			})}
			${userMenuOpen
				? html`
					<div class="absolute right-0 top-10 z-50 w-56 rounded border border-border bg-background shadow-lg">
						<div class="border-b border-border px-3 py-2">
							<div class="truncate text-sm font-medium">${currentUser.displayName}</div>
							<div class="truncate text-xs text-muted-foreground">${currentUser.email}</div>
						</div>
						<ui5-button class="corp-ui5-button corp-menu-button" design="Transparent" @click=${openProviderDialog}>
							${icon(KeyRound, "xs")}
							<span>LLM provider</span>
						</ui5-button>
						<ui5-button class="corp-ui5-button corp-menu-button" design="Transparent" @click=${() => void logout()}>
							${icon(LogOut, "xs")}
							<span>Logout</span>
						</ui5-button>
					</div>
				`
				: ""}
		</div>
	`;
}

function renderCreateWorkspaceDialog() {
	if (!createWorkspaceDialogOpen) return "";
	const templates = workspaceTemplates;
	const selectedTemplate = templates.find((template) => template.id === newWorkspaceTemplateId) ?? templates[0];
	return html`
		<div class="fixed inset-0 z-50 flex items-center justify-center bg-black/30 px-4" @click=${closeCreateWorkspaceDialog}>
			<form class="w-full max-w-xl rounded border border-border bg-background shadow-xl" @submit=${submitCreateWorkspace} @click=${(e: Event) => e.stopPropagation()}>
				<div class="flex items-center justify-between border-b border-border px-4 py-3">
					<div>
						<div class="text-sm font-semibold">New workspace</div>
						<div class="text-xs text-muted-foreground">Choose a type to preconfigure skills, connector policy, and sandbox image.</div>
					</div>
					${Ui5Button({ className: "corp-tight-icon-button", ui5Icon: "decline", onClick: closeCreateWorkspaceDialog, title: "Close" })}
				</div>
				<div class="flex flex-col gap-4 p-4">
					<label class="flex flex-col gap-1">
						<span class="text-xs font-medium text-muted-foreground">Name</span>
						<ui5-input
							class="corp-ui5-input"
							value=${newWorkspaceName}
							placeholder="Workspace name"
							?disabled=${newWorkspaceBusy}
							@input=${(e: Event) => { newWorkspaceName = getUi5Value(e); }}
						></ui5-input>
					</label>
					<label class="flex flex-col gap-1">
						<span class="text-xs font-medium text-muted-foreground">Type</span>
						<ui5-select
							class="corp-ui5-select"
							?disabled=${newWorkspaceBusy || templates.length === 0}
							@change=${(e: Event) => { newWorkspaceTemplateId = getUi5SelectValue(e, newWorkspaceTemplateId); renderApp(); }}
						>
							${templates.map((template) => html`
								<ui5-option value=${template.id} ?selected=${template.id === newWorkspaceTemplateId}>${template.label}</ui5-option>
							`)}
						</ui5-select>
					</label>
					${selectedTemplate ? html`
						<div class="rounded border border-border p-3">
							<div class="text-sm font-medium">${selectedTemplate.label}</div>
							<div class="mt-1 text-xs text-muted-foreground">${selectedTemplate.description}</div>
							<div class="mt-3 grid gap-2 text-xs">
								<div><span class="text-muted-foreground">Sandbox image:</span> <span class="font-mono">${selectedTemplate.sandboxImage}</span></div>
								<div>
									<span class="text-muted-foreground">Skills:</span>
									${selectedTemplate.skills.length === 0
										? html`<span> none</span>`
										: html`
											<div class="mt-1 flex flex-wrap gap-1">
												${selectedTemplate.skills.map((skill) => html`
													<span class="rounded-full border border-border px-2 py-0.5">${skill.label}</span>
												`)}
											</div>
										`}
								</div>
							</div>
						</div>
					` : html`<div class="rounded border border-border p-3 text-xs text-muted-foreground">Workspace types are unavailable.</div>`}
					${newWorkspaceError ? html`<div class="text-xs text-destructive">${newWorkspaceError}</div>` : ""}
				</div>
				<div class="flex justify-end gap-2 border-t border-border px-4 py-3">
					${Ui5Button({ children: "Cancel", onClick: closeCreateWorkspaceDialog, disabled: newWorkspaceBusy })}
					<ui5-button
						class="corp-ui5-button"
						design="Emphasized"
						?disabled=${newWorkspaceBusy || templates.length === 0}
						@click=${submitCreateWorkspace}
					>
						${newWorkspaceBusy ? "Creating..." : "Create"}
					</ui5-button>
				</div>
			</form>
		</div>
	`;
}

function renderProviderDialog() {
	if (!providerDialogOpen) return "";
	const providers = [
		{ id: "openai-codex", label: "Codex" },
		{ id: "openai", label: "OpenAI" },
		{ id: "google", label: "Google Gemini" }, //IYH1HC add
		{ id: "anthropic", label: "Anthropic" },
		{ id: "sap-openai", label: "SAP OpenAI" },
		{ id: "sap-claude", label: "SAP Claude" },
	];
	return html`
		<div class="fixed inset-0 z-50 flex items-center justify-center bg-black/30 px-4" @click=${closeProviderDialog}>
			<div class="w-full max-w-md rounded border border-border bg-background shadow-xl" @click=${(e: Event) => e.stopPropagation()}>
				<div class="flex items-center justify-between border-b border-border px-4 py-3">
					<div class="text-sm font-semibold">LLM provider</div>
					${Ui5Button({ className: "corp-tight-icon-button", ui5Icon: "decline", onClick: closeProviderDialog, title: "Close" })}
				</div>
				<div class="flex flex-col gap-4 p-4">
					<label class="flex flex-col gap-1">
						<span class="text-xs font-medium text-muted-foreground">Provider</span>
						<ui5-select
							class="corp-ui5-select"
							@change=${(e: Event) => setProvider(getUi5SelectValue(e, selectedProvider))}
						>
							${providers.map((provider) => html`<ui5-option value=${provider.id} ?selected=${provider.id === selectedProvider}>${provider.label}</ui5-option>`)}
						</ui5-select>
					</label>

					${selectedProvider === "openai-codex"
						? html`
							<div class="rounded border border-border p-3">
								<div class="mb-3 flex items-center justify-between gap-2">
									<div>
										<div class="text-sm font-medium">Codex OAuth</div>
										<div class="text-xs text-muted-foreground">${codexConfigured ? "Authenticated" : "Not authenticated"}</div>
									</div>
									<ui5-button
										class="corp-ui5-button"
										design="Transparent"
										?disabled=${codexAuthBusy}
										@click=${() => void startCodexLogin()}
									>
										${codexConfigured ? "Re-auth" : "Auth"}
									</ui5-button>
								</div>
								${codexLoginUrl
									? html`
										<div class="flex flex-col gap-2">
											<a class="truncate text-xs text-primary underline" href=${codexLoginUrl} target="_blank" rel="noopener noreferrer">${codexLoginUrl}</a>
											<ui5-input
												class="corp-ui5-input"
												placeholder="Paste code or redirect URL"
												value=${codexLoginCode}
												@input=${(e: Event) => { codexLoginCode = getUi5Value(e); }}
											></ui5-input>
											<ui5-button
												class="corp-ui5-button corp-wide-button"
												design="Emphasized"
												?disabled=${codexAuthBusy || !codexLoginCode.trim()}
												@click=${() => void submitCodexCode()}
											>
												${codexAuthBusy ? "Checking..." : "Finish login"}
											</ui5-button>
										</div>
									`
									: ""}
								${codexAuthError ? html`<div class="mt-2 text-xs text-destructive">${codexAuthError}</div>` : ""}
							</div>
						`
						: ""}

					${LLM_KEY_PROVIDERS.has(selectedProvider) ? renderLlmKeyAndModels() : ""}
				</div>
			</div>
		</div>
	`;
}

//IYH1HC add: provider setup — toggle-switch model list (search) + collapsible
// API Keys section. Everything auto-saves: flipping a model toggle persists the
// active set; typing a key + Enter/blur (or flipping the key toggle on) stores it.
function renderLlmKeyAndModels() {
	const provider = currentProviderConfig();
	const hasKey = provider?.hasKey === true;
	const label = provider?.label ?? selectedProvider;
	const allModels = provider?.models ?? [];
	const visible = filteredModels();
	const enabledCount = allModels.filter((m) => m.active).length;

	const keyDocsUrl = selectedProvider === "google"
		? "https://aistudio.google.com/apikey"
		: selectedProvider === "openai"
			? "https://platform.openai.com/api-keys"
			: "https://console.anthropic.com/settings/keys";

	return html`
		<div class="flex flex-col gap-3">
			<!-- Models -->
			<div class="rounded-lg border border-border bg-card">
				<div class="flex items-center gap-2 px-3 py-2">
					<span class="text-sm font-semibold">Models</span>
					<span class="text-xs text-muted-foreground">${enabledCount} enabled</span>
					<span class="ml-auto"></span>
					${Ui5Button({
						className: "corp-tight-icon-button",
						ui5Icon: "refresh",
						onClick: () => void loadLlmConfig(),
						disabled: llmConfigLoading,
						title: "Refresh models",
					})}
				</div>
				<div class="px-3 pb-2">
					<ui5-input
						class="corp-ui5-input"
						placeholder="Add or search model"
						show-clear-icon
						value=${modelFilter}
						@input=${(e: Event) => { modelFilter = getUi5Value(e); renderApp(); }}
					></ui5-input>
				</div>
				${llmConfigLoading
					? html`<div class="px-3 py-4 text-center text-xs italic text-muted-foreground">Loading models...</div>`
					: allModels.length === 0
						? html`<div class="px-3 py-4 text-center text-xs italic text-muted-foreground">No models available for this provider.</div>`
						: html`
							<div class="max-h-64 overflow-y-auto">
								${visible.length === 0
									? html`<div class="px-3 py-3 text-center text-xs italic text-muted-foreground">No match.</div>`
									: visible.map((model) => html`
										<div class="flex items-center gap-3 border-t border-border px-3 py-2">
											<div class="min-w-0 flex-1">
												<div class="truncate text-sm">${model.name}</div>
												<div class="corp-mono truncate text-xs text-muted-foreground">${model.id}</div>
											</div>
											<ui5-switch
												class="corp-ui5-switch"
												?checked=${model.active}
												?disabled=${providerKeySaving}
												@change=${(e: Event) => void toggleModelActive(model.id, (e.target as HTMLInputElement & { checked: boolean }).checked)}
											></ui5-switch>
										</div>
									`)}
							</div>
						`}
			</div>

			<!-- API Keys (collapsible) -->
			<div class="rounded-lg border border-border bg-card">
				<button
					type="button"
					class="flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-accent"
					@click=${() => { apiKeysExpanded = !apiKeysExpanded; renderApp(); }}
				>
					${icon(apiKeysExpanded ? ChevronDown : ChevronRight, "xs")}
					<span class="text-sm font-semibold">API Keys</span>
					${hasKey
						? html`<span class="ml-auto inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium" style="color: var(--sapPositiveColor, #256f3a); background: var(--sapSuccessBackgroundColor, rgba(37,111,58,0.1));">Stored</span>`
						: html`<span class="ml-auto text-xs text-muted-foreground">Required</span>`}
				</button>
				${apiKeysExpanded
					? html`
						<div class="flex flex-col gap-2 border-t border-border px-3 py-3">
							<div class="flex items-center gap-2">
								<div class="min-w-0 flex-1">
									<div class="text-sm font-medium">${label} API Key</div>
									<div class="text-xs text-muted-foreground">
										${hasKey ? "A key is stored (encrypted)." : "You can put in your own key to use these models at cost."}
									</div>
								</div>
								<ui5-switch
									class="corp-ui5-switch"
									?checked=${hasKey}
									?disabled=${providerKeySaving}
									@change=${(e: Event) => void toggleProviderKey((e.target as HTMLInputElement & { checked: boolean }).checked)}
								></ui5-switch>
							</div>
							<ui5-input
								class="corp-ui5-input"
								type="Password"
								placeholder=${hasKey ? `Replace your ${label} API Key` : `Enter your ${label} API Key`}
								value=${providerKeyInput}
								?disabled=${providerKeySaving}
								@input=${(e: Event) => { providerKeyInput = getUi5Value(e); providerSavedNotice = ""; }}
								@change=${() => void commitProviderKey()}
							></ui5-input>
							<div class="flex items-center gap-2">
								<span class="text-xs text-muted-foreground">
									Get a key at <a class="text-primary underline" href=${keyDocsUrl} target="_blank" rel="noopener noreferrer">${new URL(keyDocsUrl).host}</a>.
								</span>
								${providerSavedNotice ? html`<span class="ml-auto text-xs font-medium" style="color: var(--sapPositiveColor, #256f3a);">${providerSavedNotice}</span>` : ""}
							</div>
						</div>
					`
					: ""}
			</div>

			${providerKeyError ? html`<div class="text-xs text-destructive">${providerKeyError}</div>` : ""}
		</div>
	`;
}

function renderWorkspaceSettingsDialog() {
	if (!workspaceSettingsDialogOpen) return "";
	if (!serviceFeatures.agentWorkers && workspaceSettingsTab === "workers") {
		workspaceSettingsTab = "agent";
	}
	const sap = workspaceSettings.sapConnection ?? {};
	const promptFile = workspaceSettings.agent?.promptFile ?? "AGENTS.md";
	const tabColumns = serviceFeatures.agentWorkers ? "grid-cols-4" : "grid-cols-3";
	return html`
		<div class="fixed inset-0 z-50 flex items-center justify-center bg-black/30 px-4" @click=${closeWorkspaceSettingsDialog}>
			<form class="w-full max-w-2xl rounded border border-border bg-background shadow-xl" @submit=${saveWorkspaceSettings} @click=${(e: Event) => e.stopPropagation()}>
				<div class="flex items-center justify-between border-b border-border px-4 py-3">
					<div class="text-sm font-semibold">Workspace settings</div>
					${Ui5Button({ className: "corp-tight-icon-button", ui5Icon: "decline", onClick: closeWorkspaceSettingsDialog, title: "Close" })}
				</div>
				<div class="border-b border-border px-4 pt-3">
					<div class=${`grid w-full max-w-xl ${tabColumns} gap-1`}>
						<ui5-button
							class="corp-ui5-button corp-tab-button"
							design=${workspaceSettingsTab === "agent" ? "Emphasized" : "Transparent"}
							@click=${() => { workspaceSettingsTab = "agent"; renderApp(); }}
						>
							Agent
						</ui5-button>
						<ui5-button
							class="corp-ui5-button corp-tab-button"
							design=${workspaceSettingsTab === "connection" ? "Emphasized" : "Transparent"}
							@click=${() => { workspaceSettingsTab = "connection"; renderApp(); }}
						>
							Connection
						</ui5-button>
						${serviceFeatures.agentWorkers ? html`
							<ui5-button
								class="corp-ui5-button corp-tab-button"
								design=${workspaceSettingsTab === "workers" ? "Emphasized" : "Transparent"}
								@click=${() => { workspaceSettingsTab = "workers"; void refreshAgentWorkers(false); renderApp(); }}
							>
								Workers
							</ui5-button>
						` : ""}
						<ui5-button
							class="corp-ui5-button corp-tab-button"
							design=${workspaceSettingsTab === "sandbox" ? "Emphasized" : "Transparent"}
							@click=${() => { workspaceSettingsTab = "sandbox"; void refreshWorkspaceSandbox(false); renderApp(); }}
						>
							Sandbox
						</ui5-button>
					</div>
				</div>
				<div class="max-h-[70vh] min-h-[58vh] overflow-y-auto p-4">
					${workspaceSettingsBusy
						? html`<div class="text-xs italic text-muted-foreground">Loading...</div>`
						: html`
							<div class="flex flex-col gap-5">
								${workspaceSettingsTab === "agent"
									? html`
										<section class="flex min-h-[52vh] flex-col gap-3">
											<div>
												<div class="text-sm font-medium">Agent instructions</div>
												<div class="text-xs text-muted-foreground">Workspace-level instructions loaded from ${promptFile}.</div>
											</div>
											<ui5-textarea
												class="corp-ui5-textarea corp-agent-instructions-editor flex-1"
												placeholder="Add workspace-specific behavior, rules, preferred tools, and project context."
												rows="18"
												value=${workspaceAgentPromptDraft}
												@input=${(e: Event) => { workspaceAgentPromptDraft = getUi5Value(e); }}
											></ui5-textarea>
										</section>
									`
									: workspaceSettingsTab === "connection"
										? renderBusinessConnectorSettings(sap)
										: workspaceSettingsTab === "workers"
											? renderAgentWorkerSettings()
											: renderSandboxSettings()}
							</div>
						`}
					${workspaceSettingsError ? html`<div class="mt-3 text-xs text-destructive">${workspaceSettingsError}</div>` : ""}
				</div>
				<div class="flex justify-end gap-2 border-t border-border px-4 py-3">
					${Ui5Button({ children: workspaceSettingsTab === "workers" || workspaceSettingsTab === "sandbox" ? "Close" : "Cancel", onClick: closeWorkspaceSettingsDialog })}
					${workspaceSettingsTab === "workers" || workspaceSettingsTab === "sandbox"
						? ""
						: html`
							<ui5-button
								class="corp-ui5-button"
								design="Emphasized"
								?disabled=${workspaceSettingsBusy}
								@click=${saveWorkspaceSettings}
							>
								${workspaceSettingsBusy ? "Loading..." : "Save"}
							</ui5-button>
						`}
				</div>
			</form>
		</div>
	`;
}

function renderApp() {
	if (!currentUser) {
		render(
			html`
				<div class="w-full h-screen flex items-center justify-center bg-background text-foreground">
					<form class="w-full max-w-sm px-6 flex flex-col gap-3" @submit=${submitAuth}>
						<div>
							<div class="text-xl font-semibold">Core Service</div>
							<div class="text-sm text-muted-foreground">${authMode === "login" ? "Sign in to continue" : "Create your account"}</div>
						</div>
						${authMode === "register"
							? html`
								<ui5-input
									class="corp-ui5-input"
									placeholder="Display name"
									value=${authDisplayName}
									@input=${(e: Event) => { authDisplayName = getUi5Value(e); }}
								></ui5-input>
							`
							: ""}
						<ui5-input
							class="corp-ui5-input"
							type="Email"
							placeholder="Email"
							value=${authEmail}
							required
							@input=${(e: Event) => { authEmail = getUi5Value(e); }}
						></ui5-input>
						<ui5-input
							class="corp-ui5-input"
							type="Password"
							placeholder="Password"
							value=${authPassword}
							required
							@input=${(e: Event) => { authPassword = getUi5Value(e); }}
						></ui5-input>
						${authError ? html`<div class="text-xs text-destructive">${authError}</div>` : ""}
						<ui5-button class="corp-ui5-button corp-wide-button" design="Emphasized" @click=${submitAuth}>
							${authMode === "login" ? "Sign in" : "Create account"}
						</ui5-button>
						<ui5-button
							class="corp-ui5-button corp-wide-button"
							design="Transparent"
							@click=${() => { authMode = authMode === "login" ? "register" : "login"; authError = ""; renderApp(); }}
						>
							${authMode === "login" ? "Create an account" : "Use an existing account"}
						</ui5-button>
						${ssoConfig.enabled
							? html`
								<div class="flex items-center gap-2 my-1">
									<div class="h-px flex-1 bg-border"></div>
									<span class="text-xs text-muted-foreground">or</span>
									<div class="h-px flex-1 bg-border"></div>
								</div>
								${Ui5Button({
									className: "corp-wide-button",
									design: "Transparent",
									children: html`${icon(KeyRound, "xs")}<span>${`Sign in with ${ssoConfig.label ?? "SSO"}`}</span>`,
									onClick: () => { window.location.href = client.ssoLoginHref(); },
									title: "Sign in with SSO",
								})}
							`
							: ""}
					</form>
				</div>
			`,
			app,
		);
		return;
	}

	render(
		html`
			<div class="w-full h-screen flex flex-col bg-background text-foreground overflow-hidden">
				<!-- Header -->
				<div class="flex items-center justify-between border-b border-border shrink-0 px-4 py-1">
					<div class="flex items-center gap-2">
						${Ui5Button({
							className: "corp-icon-button",
							ui5Icon: sidebarOpen ? "navigation-left-arrow" : "navigation-right-arrow",
							onClick: toggleSidebar,
							title: sidebarOpen ? "Collapse sessions" : "Expand sessions",
						})}
						<span class="text-base font-semibold text-foreground">Bot Chat</span>
					</div>
					<div class="flex items-center gap-2">
						${Ui5Button({
							className: workspaceOpen ? "" : "corp-icon-button",
							ui5Icon: "add",
							children: workspaceOpen ? "Workspace" : "",
							onClick: () => void newWorkspace(),
							title: "New workspace",
						})}
						${!workspaceOpen
							? Ui5Button({
								ui5Icon: "folder-blank",
								children: "Workspace",
								onClick: toggleWorkspace,
								title: "Expand workspace",
							})
							: ""}
						${renderThemeButton()}
						${renderUserMenu()}
					</div>
				</div>

				<!-- Body -->
				<div class="flex flex-1 overflow-hidden">
					<!-- Sidebar -->
					${sidebarOpen
						? html`
							<div class="w-60 shrink-0 border-r border-border flex flex-col overflow-hidden bg-background">
								<div class="p-2 shrink-0">
									${Ui5Button({
										className: "corp-wide-button",
										ui5Icon: "add",
										children: "New session",
										onClick: newSession,
										title: "New session",
									})}
								</div>
								<div class="flex-1 overflow-y-auto">
									${sessions.length === 0
										? html`<div class="px-3 py-4 text-xs text-muted-foreground italic">No sessions yet</div>`
										: sessions.map(
											(s) => html`
												<button
													class="w-full text-left px-3 py-2 hover:bg-accent transition-colors flex flex-col gap-0.5 ${s.channelId === channelId ? "bg-accent" : ""}"
													@click=${() => switchSession(s.channelId)}
												>
													<div class="flex items-center gap-1.5 min-w-0">
														${icon(MessageSquare, "xs")}
														<span class="text-xs font-medium truncate flex-1">${s.preview || "Empty session"}</span>
													</div>
													<div class="text-xs text-muted-foreground flex gap-2 pl-4">
														<span>${s.messageCount} msg${s.messageCount !== 1 ? "s" : ""}</span>
														<span>${formatTime(s.lastModified)}</span>
													</div>
												</button>
											`,
										)}
								</div>
							</div>
						`
						: ""}

					<!-- Chat Panel -->
					<div class="flex-1 min-w-0 overflow-hidden flex flex-col">
						${channelId ? chatPanel : html`<div class="flex h-full items-center justify-center text-sm text-muted-foreground">Select or create a session</div>`}
					</div>

					<!-- Workspace -->
					${workspaceOpen
						? html`
							<div class="w-72 border-l border-border bg-background flex flex-col overflow-hidden">
								<div class="shrink-0 border-b border-border p-2">
									<div class="flex items-center gap-2">
										<ui5-select
											class="corp-ui5-select min-w-0 flex-1"
											@change=${(e: Event) => void switchWorkspace(getUi5SelectValue(e, workspaceId))}
										>
											${workspaces.map((w) => html`<ui5-option value=${w.id} ?selected=${w.id === workspaceId}>${w.name}</ui5-option>`)}
										</ui5-select>
										<ui5-button
											class="corp-ui5-button corp-tight-icon-button"
											design="Transparent"
											icon="refresh"
											title="Reload workspace"
											@click=${() => void loadWorkspace()}
										></ui5-button>
										${serviceFeatures.reminders
											? Ui5Button({
												className: "corp-tight-icon-button",
												ui5Icon: "bell",
												onClick: () => void openWorkspaceEventsDialog(),
												title: "Scheduled events",
											})
											: ""}
										${Ui5Button({ className: "corp-tight-icon-button", ui5Icon: "navigation-right-arrow", onClick: toggleWorkspace, title: "Collapse workspace" })}
									</div>
								</div>
								<div class="flex-1 min-h-0 flex flex-col overflow-hidden">
									<div class="shrink-0 border-b border-border p-2">
										<div class="grid grid-cols-2 gap-1">
											<ui5-button
												class="corp-ui5-button corp-tab-button"
												design=${workspaceTab === "artifacts" ? "Emphasized" : "Transparent"}
												@click=${() => { workspaceTab = "artifacts"; renderApp(); }}
											>
												Artifacts
											</ui5-button>
											<ui5-button
												class="corp-ui5-button corp-tab-button"
												design=${workspaceTab === "skills" ? "Emphasized" : "Transparent"}
												@click=${() => { workspaceTab = "skills"; renderApp(); }}
											>
												Skills
											</ui5-button>
										</div>
									</div>
									<div class="flex-1 overflow-y-auto p-2">
										${workspaceTab === "artifacts"
											? renderArtifacts()
											: html`${workspaceTree.skills.length > 0 ? renderTree(workspaceTree.skills) : html`<div class="text-xs text-muted-foreground px-2 py-1">No skills</div>`}`}
									</div>
								</div>
								${renderAcpWorkersPanel()}
								<div class="shrink-0 border-t border-border p-2">
									${Ui5Button({
										className: "corp-wide-button",
										ui5Icon: "settings",
										children: "Settings",
										onClick: () => void openWorkspaceSettingsDialog(),
										title: "Workspace settings",
									})}
								</div>
							</div>
						`
						: ""}
				</div>
				${renderCreateWorkspaceDialog()}
				${renderProviderDialog()}
				${renderWorkspaceEventsDialog()}
				${renderWorkspaceSettingsDialog()}
			</div>
		`,
		app,
	);
}

// Initial render then load workspaces/sessions
consumeSsoHash();        //IYH1HC add
void refreshSsoConfig(); //IYH1HC add
renderApp();
void initializeAuth();
