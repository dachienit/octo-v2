import "@mariozechner/mini-lit/dist/ThemeToggle.js";
import { CoreServiceChatPanel, CoreServiceClient, translations, type AuthUser, type LlmConfig, type SessionInfo, type SsoConfig, type WorkspaceInfo, type WorkspaceNode, type WorkspaceSettings, type WorkspaceTableSummary, type WorkspaceTree } from "@octo/web-ui";
import { setTranslations } from "@mariozechner/mini-lit";
import { html, render } from "lit";
import { icon } from "@mariozechner/mini-lit";
import { Button } from "@mariozechner/mini-lit/dist/Button.js";
import { ChevronDown, ChevronLeft, ChevronRight, CircleUser, File, Folder, FolderOpen, KeyRound, LogOut, MessageSquare, Plus, RefreshCw, Settings, Table2, X } from "lucide";
import "./app.css";

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
let userMenuOpen = false;
let providerDialogOpen = false;
let workspaceSettingsDialogOpen = false;
let workspaceSettingsTab: "agent" | "connection" = "agent";
let selectedProvider = localStorage.getItem(providerKey) || "openai-codex";
let codexConfigured = false;
let codexLoginId = "";
let codexLoginUrl = "";
let codexLoginCode = "";
let codexAuthError = "";
let codexAuthBusy = false;
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
let workspaceId = initialRoute.workspaceId ?? localStorage.getItem("workspaceId") ?? "";
let channelId = initialRoute.sessionId ?? (workspaceId ? sessionStorage.getItem(`sessionId:${workspaceId}`) || "" : "");
let sessions: SessionInfo[] = [];
let workspaceOpen = true;
let workspaceTab: "artifacts" | "skills" = "artifacts";
let workspaceTree: WorkspaceTree = { artifacts: [], skills: [] };
let workspaceSettings: WorkspaceSettings = {};
let workspaceAgentPromptDraft = "";
let workspaceSettingsError = "";
let workspaceSettingsBusy = false;
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
	workspaces = await client.getWorkspaces();
	if (workspaces.length === 0) {
		const created = await client.createWorkspace("Default workspace");
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
	databaseTables.clear();
	expandedFolders.clear();
	await loadSessions();
}

async function newWorkspace() {
	const name = prompt("Workspace name:", "New workspace");
	if (!name?.trim()) return;
	const workspace = await client.createWorkspace(name.trim());
	if (!workspace) return;
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
	await loadWorkspaces();
}

async function submitAuth(event: Event) {
	event.preventDefault();
	authError = "";
	renderApp();
	const form = event.currentTarget as HTMLFormElement;
	const data = new FormData(form);
	const email = String(data.get("email") || "");
	const password = String(data.get("password") || "");
	const displayName = String(data.get("displayName") || "");
	try {
		const result = authMode === "register"
			? await client.register(email, password, displayName)
			: await client.login(email, password);
		authToken = result.token;
		localStorage.setItem(authTokenKey, authToken);
		currentUser = result.user;
		userName = result.user.displayName;
		chatPanel.userName = userName;
		chatPanel.authToken = authToken;
		await loadWorkspaces();
	} catch (err) {
		authError = err instanceof Error ? err.message : String(err);
		renderApp();
	}
}

async function logout() {
	await client.logout();
	authToken = null;
	localStorage.removeItem(authTokenKey);
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
	workspaceSettings = await client.getWorkspaceSettings(workspaceId);
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
	const form = event.currentTarget as HTMLFormElement;
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
				enabled: data.get("sapEnabled") === "on",
				systemUrl: String(data.get("sapSystemUrl") || ""),
				client: String(data.get("sapClient") || ""),
				username: String(data.get("sapUsername") || ""),
				authType: String(data.get("sapAuthType") || "basic") as "basic" | "destination" | "oauth",
				destinationName: String(data.get("sapDestinationName") || ""),
			}
			: workspaceSettings.sapConnection,
		tools: workspaceSettings.tools,
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

//IYH1HC add: render the user's avatar (GitHub SSO) with graceful fallback to the
// default icon if there is no avatar or the image fails to load (e.g. off-network).
function renderUserAvatar(sizeClass: string) {
	if (currentUser?.avatarUrl) {
		return html`<img
			src=${currentUser.avatarUrl}
			alt=${currentUser.displayName}
			class="${sizeClass} rounded-full object-cover"
			@error=${() => { if (currentUser) { currentUser = { ...currentUser, avatarUrl: undefined }; renderApp(); } }}
		/>`;
	}
	return icon(CircleUser, "sm");
}

function renderUserMenu() {
	if (!currentUser) return "";
	return html`
		<div class="relative">
			${Button({
				variant: "ghost",
				size: "icon",
				children: renderUserAvatar("h-6 w-6"), //IYH1HC add
				onClick: () => { userMenuOpen = !userMenuOpen; renderApp(); },
				title: "User menu",
			})}
			${userMenuOpen
				? html`
					<div class="absolute right-0 top-10 z-50 w-56 rounded border border-border bg-background shadow-lg">
						<div class="flex items-center gap-2 border-b border-border px-3 py-2">
							${renderUserAvatar("h-8 w-8")}
							<div class="min-w-0">
								<div class="truncate text-sm font-medium">${currentUser.displayName}</div>
								<div class="truncate text-xs text-muted-foreground">${currentUser.email}</div>
							</div>
						</div>
						<button class="flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-accent" @click=${openProviderDialog}>
							${icon(KeyRound, "xs")}
							<span>LLM provider</span>
						</button>
						<button class="flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-accent" @click=${() => void logout()}>
							${icon(LogOut, "xs")}
							<span>Logout</span>
						</button>
					</div>
				`
				: ""}
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
			<div class="w-full max-w-[34rem] rounded border border-border bg-background shadow-xl" @click=${(e: Event) => e.stopPropagation()}>
				<div class="flex items-center justify-between border-b border-border px-4 py-3">
					<div class="text-sm font-semibold">LLM provider</div>
					${Button({ variant: "ghost", size: "icon", children: icon(X, "xs"), onClick: closeProviderDialog, title: "Close" })}
				</div>
				<div class="flex flex-col gap-4 p-4">
					<label class="flex flex-col gap-1">
						<span class="text-xs font-medium text-muted-foreground">Provider</span>
						<select
							class="h-9 rounded border border-border bg-background px-2 text-sm"
							@change=${(e: Event) => setProvider((e.target as HTMLSelectElement).value)}
						>
							${providers.map((provider) => html`<option value=${provider.id} ?selected=${provider.id === selectedProvider}>${provider.label}</option>`)}
						</select>
					</label>

					${selectedProvider === "openai-codex"
						? html`
							<div class="rounded border border-border p-3">
								<div class="mb-3 flex items-center justify-between gap-2">
									<div>
										<div class="text-sm font-medium">Codex OAuth</div>
										<div class="text-xs text-muted-foreground">${codexConfigured ? "Authenticated" : "Not authenticated"}</div>
									</div>
									<button
										class="h-8 rounded border border-border px-3 text-sm font-medium hover:bg-accent disabled:cursor-not-allowed disabled:opacity-50"
										?disabled=${codexAuthBusy}
										@click=${() => void startCodexLogin()}
									>
										${codexConfigured ? "Re-auth" : "Auth"}
									</button>
								</div>
								${codexLoginUrl
									? html`
										<div class="flex flex-col gap-2">
											<a class="truncate text-xs text-primary underline" href=${codexLoginUrl} target="_blank" rel="noopener noreferrer">${codexLoginUrl}</a>
											<input
												class="h-9 rounded border border-border bg-background px-2 text-sm"
												placeholder="Paste code or redirect URL"
												.value=${codexLoginCode}
												@input=${(e: Event) => { codexLoginCode = (e.target as HTMLInputElement).value; }}
											/>
											${Button({
												variant: "default",
												size: "sm",
												disabled: codexAuthBusy || !codexLoginCode.trim(),
												children: codexAuthBusy ? "Checking..." : "Finish login",
												onClick: () => void submitCodexCode(),
											})}
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

//IYH1HC add: local pill toggle. mini-lit's Switch uses `data-[state=checked]:bg-primary`
// classes that live in node_modules and aren't scanned by the web-app Tailwind build,
// so they never get the color. We render the toggle inline with first-party classes.
function pillToggle(checked: boolean, onChange: (checked: boolean) => void, disabled = false) {
	return html`
		<button
			type="button"
			role="switch"
			aria-checked=${checked ? "true" : "false"}
			?disabled=${disabled}
			class="relative inline-flex h-6 w-11 shrink-0 items-center rounded-full border-2 border-transparent transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${checked ? "bg-green-600" : "bg-gray-300 dark:bg-gray-600"}"
			@click=${() => { if (!disabled) onChange(!checked); }}
		>
			<span class="inline-block h-5 w-5 transform rounded-full bg-white shadow transition-transform ${checked ? "translate-x-5" : "translate-x-0"}"></span>
		</button>
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
			<div class="rounded-lg border border-border">
				<div class="flex items-center gap-2 px-3 py-2">
					<span class="text-sm font-semibold">Models</span>
					<span class="text-xs text-muted-foreground">${enabledCount} enabled</span>
					<button
						type="button"
						class="ml-auto flex h-7 w-7 items-center justify-center rounded hover:bg-accent disabled:opacity-50"
						title="Refresh models"
						?disabled=${llmConfigLoading}
						@click=${() => void loadLlmConfig()}
					>${icon(RefreshCw, "xs")}</button>
				</div>
				<div class="px-3 pb-2">
					<input
						class="h-8 w-full rounded border border-border bg-background px-2 text-sm"
						type="search"
						placeholder="Add or search model"
						.value=${modelFilter}
						@input=${(e: Event) => { modelFilter = (e.target as HTMLInputElement).value; renderApp(); }}
					/>
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
												<div class="truncate font-mono text-xs text-muted-foreground">${model.id}</div>
											</div>
											${pillToggle(model.active, (checked) => void toggleModelActive(model.id, checked), providerKeySaving)}
										</div>
									`)}
							</div>
						`}
			</div>

			<!-- API Keys (collapsible) -->
			<div class="rounded-lg border border-border">
				<button
					type="button"
					class="flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-accent"
					@click=${() => { apiKeysExpanded = !apiKeysExpanded; renderApp(); }}
				>
					${icon(apiKeysExpanded ? ChevronDown : ChevronRight, "xs")}
					<span class="text-sm font-semibold">API Keys</span>
					${hasKey
						? html`<span class="ml-auto inline-flex items-center rounded-full bg-green-600/10 px-2 py-0.5 text-xs font-medium text-green-700">Stored</span>`
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
								${pillToggle(hasKey, (checked) => void toggleProviderKey(checked), providerKeySaving)}
							</div>
							<input
								class="h-9 w-full rounded border border-border bg-background px-2 text-sm"
								type="password"
								placeholder=${hasKey ? `Replace your ${label} API Key` : `Enter your ${label} API Key`}
								.value=${providerKeyInput}
								?disabled=${providerKeySaving}
								@input=${(e: Event) => { providerKeyInput = (e.target as HTMLInputElement).value; providerSavedNotice = ""; }}
								@keydown=${(e: KeyboardEvent) => { if (e.key === "Enter") { e.preventDefault(); void commitProviderKey(); } }}
								@blur=${() => void commitProviderKey()}
							/>
							<div class="flex items-center gap-2">
								<span class="text-xs text-muted-foreground">
									Get a key at <a class="text-primary underline" href=${keyDocsUrl} target="_blank" rel="noopener noreferrer">${new URL(keyDocsUrl).host}</a>.
								</span>
								${providerSavedNotice ? html`<span class="ml-auto text-xs font-medium text-green-700">${providerSavedNotice}</span>` : ""}
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
	const sap = workspaceSettings.sapConnection ?? {};
	const promptFile = workspaceSettings.agent?.promptFile ?? "AGENTS.md";
	return html`
		<div class="fixed inset-0 z-50 flex items-center justify-center bg-black/30 px-4" @click=${closeWorkspaceSettingsDialog}>
			<form class="w-full max-w-2xl rounded border border-border bg-background shadow-xl" @submit=${saveWorkspaceSettings} @click=${(e: Event) => e.stopPropagation()}>
				<div class="flex items-center justify-between border-b border-border px-4 py-3">
					<div class="text-sm font-semibold">Workspace settings</div>
					${Button({ variant: "ghost", size: "icon", children: icon(X, "xs"), onClick: closeWorkspaceSettingsDialog, title: "Close", type: "button" })}
				</div>
				<div class="border-b border-border px-4 pt-3">
					<div class="grid w-full max-w-sm grid-cols-2 rounded border border-border p-0.5">
						<button
							type="button"
							class="h-8 rounded text-xs font-medium ${workspaceSettingsTab === "agent" ? "bg-accent text-foreground" : "text-muted-foreground hover:text-foreground"}"
							@click=${() => { workspaceSettingsTab = "agent"; renderApp(); }}
						>
							Agent
						</button>
						<button
							type="button"
							class="h-8 rounded text-xs font-medium ${workspaceSettingsTab === "connection" ? "bg-accent text-foreground" : "text-muted-foreground hover:text-foreground"}"
							@click=${() => { workspaceSettingsTab = "connection"; renderApp(); }}
						>
							Connection
						</button>
					</div>
				</div>
				<div class="max-h-[70vh] overflow-y-auto p-4">
					${workspaceSettingsBusy
						? html`<div class="text-xs italic text-muted-foreground">Loading...</div>`
						: html`
							<div class="flex flex-col gap-5">
								${workspaceSettingsTab === "agent"
									? html`
										<section class="flex flex-col gap-3">
											<div>
												<div class="text-sm font-medium">Agent instructions</div>
												<div class="text-xs text-muted-foreground">Workspace-level instructions loaded from ${promptFile}.</div>
											</div>
											<textarea
												class="min-h-72 rounded border border-border bg-background p-3 font-mono text-xs leading-relaxed"
												placeholder="Add workspace-specific behavior, rules, preferred tools, and project context."
												.value=${workspaceAgentPromptDraft}
												@input=${(e: Event) => { workspaceAgentPromptDraft = (e.target as HTMLTextAreaElement).value; }}
											></textarea>
										</section>
									`
									: html`
										<section class="flex flex-col gap-3">
											<div>
												<div class="text-sm font-medium">ABAP system connection</div>
												<div class="text-xs text-muted-foreground">Workspace-level SAP ABAP system details for tools and automation.</div>
											</div>
											<label class="flex items-center gap-2 text-sm">
												<input type="checkbox" name="sapEnabled" ?checked=${sap.enabled === true} />
												<span>Enable ABAP connection</span>
											</label>
											<div class="grid grid-cols-2 gap-2">
												<input class="h-9 rounded border border-border bg-background px-2 text-sm" name="sapSystemUrl" placeholder="System URL" .value=${sap.systemUrl ?? ""} />
												<input class="h-9 rounded border border-border bg-background px-2 text-sm" name="sapClient" placeholder="Client" .value=${sap.client ?? ""} />
												<input class="h-9 rounded border border-border bg-background px-2 text-sm" name="sapUsername" placeholder="Username" .value=${sap.username ?? ""} />
												<select class="h-9 rounded border border-border bg-background px-2 text-sm" name="sapAuthType" .value=${sap.authType ?? "basic"}>
													<option value="basic">Basic</option>
													<option value="destination">Destination</option>
													<option value="oauth">OAuth</option>
												</select>
											</div>
											<input class="h-9 rounded border border-border bg-background px-2 text-sm" name="sapDestinationName" placeholder="Destination name" .value=${sap.destinationName ?? ""} />
										</section>
									`}
							</div>
						`}
					${workspaceSettingsError ? html`<div class="mt-3 text-xs text-destructive">${workspaceSettingsError}</div>` : ""}
				</div>
				<div class="flex justify-end gap-2 border-t border-border px-4 py-3">
					${Button({ variant: "ghost", size: "sm", children: "Cancel", onClick: closeWorkspaceSettingsDialog, type: "button" })}
					<button
						type="submit"
						class="inline-flex h-8 min-w-16 items-center justify-center rounded-md bg-foreground px-3 text-xs font-medium text-background shadow-xs hover:opacity-90 disabled:cursor-not-allowed disabled:bg-muted disabled:text-foreground disabled:opacity-100"
						?disabled=${workspaceSettingsBusy}
					>
						${workspaceSettingsBusy ? "Loading..." : "Save"}
					</button>
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
							? html`<input class="h-10 rounded border border-border bg-background px-3 text-sm" name="displayName" placeholder="Display name" autocomplete="name" />`
							: ""}
						<input class="h-10 rounded border border-border bg-background px-3 text-sm" name="email" placeholder="Email" autocomplete="email" required />
						<input class="h-10 rounded border border-border bg-background px-3 text-sm" name="password" type="password" placeholder="Password" autocomplete=${authMode === "login" ? "current-password" : "new-password"} required />
						${authError ? html`<div class="text-xs text-destructive">${authError}</div>` : ""}
						${Button({
							variant: "default",
							size: "sm",
							type: "submit",
							className: "w-full justify-center",
							children: authMode === "login" ? "Sign in" : "Create account",
						})}
						<button
							type="button"
							class="text-xs text-muted-foreground hover:text-foreground"
							@click=${() => { authMode = authMode === "login" ? "register" : "login"; authError = ""; renderApp(); }}
						>
							${authMode === "login" ? "Create an account" : "Use an existing account"}
						</button>
						${ssoConfig.enabled
							? html`
								<div class="flex items-center gap-2 my-1">
									<div class="h-px flex-1 bg-border"></div>
									<span class="text-xs text-muted-foreground">or</span>
									<div class="h-px flex-1 bg-border"></div>
								</div>
								${Button({
									variant: "outline",
									size: "sm",
									type: "button",
									className: "w-full justify-center",
									children: html`${icon(KeyRound, "xs")}<span>${`Sign in with ${ssoConfig.label ?? "SSO"}`}</span>`,
									onClick: () => { window.location.href = client.ssoLoginHref(); },
								})}`
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
						${Button({
							variant: "ghost",
							size: "icon",
							children: sidebarOpen ? icon(ChevronLeft, "sm") : icon(ChevronRight, "sm"),
							onClick: toggleSidebar,
							title: sidebarOpen ? "Collapse sessions" : "Expand sessions",
						})}
						<span class="text-base font-semibold text-foreground">Daisy Chat</span>
					</div>
					<div class="flex items-center gap-2">
						${Button({
							variant: "ghost",
							size: workspaceOpen ? "sm" : "icon",
							className: workspaceOpen ? "gap-2" : "",
							children: workspaceOpen ? html`${icon(Plus, "sm")}<span>Workspace</span>` : icon(Plus, "sm"),
							onClick: () => void newWorkspace(),
							title: "New workspace",
						})}
						${!workspaceOpen
							? Button({
								variant: "ghost",
								size: "sm",
								className: "gap-2",
								children: html`${icon(FolderOpen, "sm")}<span>Workspace</span>`,
								onClick: toggleWorkspace,
								title: "Expand workspace",
							})
							: ""}
						<theme-toggle></theme-toggle>
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
									${Button({
										variant: "outline",
										size: "sm",
										className: "w-full justify-start gap-2",
										children: html`${icon(Plus, "sm")}<span>New session</span>`,
										onClick: newSession,
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
										<select
											class="h-9 min-w-0 flex-1 rounded border border-border bg-background px-2 text-xs"
											.value=${workspaceId}
											@change=${(e: Event) => void switchWorkspace((e.target as HTMLSelectElement).value)}
										>
											${workspaces.map((w) => html`<option value=${w.id} ?selected=${w.id === workspaceId}>${w.name}</option>`)}
										</select>
										<button
											class="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded hover:bg-accent [&>svg]:h-3.5 [&>svg]:w-3.5"
											title="Reload workspace"
											@click=${() => void loadWorkspace()}
										>
											${icon(RefreshCw, "xs")}
										</button>
										${Button({ variant: "ghost", size: "icon", children: icon(ChevronRight, "xs"), onClick: toggleWorkspace, title: "Collapse workspace" })}
									</div>
								</div>
								<div class="flex-1 min-h-0 flex flex-col overflow-hidden">
									<div class="shrink-0 border-b border-border p-2">
										<div class="grid grid-cols-2 rounded border border-border p-0.5">
											<button
												class="h-7 rounded text-xs font-medium ${workspaceTab === "artifacts" ? "bg-accent text-foreground" : "text-muted-foreground hover:text-foreground"}"
												@click=${() => { workspaceTab = "artifacts"; renderApp(); }}
											>
												Artifacts
											</button>
											<button
												class="h-7 rounded text-xs font-medium ${workspaceTab === "skills" ? "bg-accent text-foreground" : "text-muted-foreground hover:text-foreground"}"
												@click=${() => { workspaceTab = "skills"; renderApp(); }}
											>
												Skills
											</button>
										</div>
									</div>
									<div class="flex-1 overflow-y-auto p-2">
										${workspaceTab === "artifacts"
											? renderArtifacts()
											: html`${workspaceTree.skills.length > 0 ? renderTree(workspaceTree.skills) : html`<div class="text-xs text-muted-foreground px-2 py-1">No skills</div>`}`}
									</div>
								</div>
								<div class="shrink-0 border-t border-border p-2">
									${Button({
										variant: "ghost",
										size: "sm",
										className: "w-full justify-start gap-2",
										children: html`${icon(Settings, "xs")}<span>Settings</span>`,
										onClick: () => void openWorkspaceSettingsDialog(),
									})}
								</div>
							</div>
						`
						: ""}
				</div>
				${renderProviderDialog()}
				${renderWorkspaceSettingsDialog()}
			</div>
		`,
		app,
	);
}

// Initial render then load workspaces/sessions
consumeSsoHash(); //IYH1HC add
void refreshSsoConfig(); //IYH1HC add
renderApp();
void initializeAuth();
