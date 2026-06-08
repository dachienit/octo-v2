export { CoreAgent, getMemory, loadSkills, formatSkillsForPrompt } from "./agent.js";
//IYH1HC add: re-export pi-ai model registry so the service layer can list models
// without depending on @earendil-works/pi-ai directly.
export { getModels, getModel } from "@earendil-works/pi-ai";
export { getProviderAuthStatus, loginProvider } from "./auth.js";
export type {
	CoreAgentAuthStatus,
	CoreAgentLoginCallbacks,
	CoreAgentOAuthAuthInfo,
	CoreAgentOAuthPrompt,
} from "./auth.js";
export type { ExtensionAPI, ProviderModelConfig } from "@earendil-works/pi-coding-agent";
export { createExecutor, parseSandboxArg, validateSandbox } from "./sandbox.js";
export type { Executor, ExecOptions, ExecResult, SandboxConfig } from "./sandbox.js";
export { AgentSettingsManager } from "./settings.js";
export type { AgentCompactionSettings, AgentRetrySettings, AgentSettings } from "./settings.js";
export type {
	CoreAgentEventHandlers,
	CoreAgentOptions,
	CoreAgentRunInput,
	CoreAgentRunResult,
} from "./types.js";
export { calculateCost, createAssistantMessageEventStream } from "./ai-stream.js";
export type { AssistantMessage, Context, Model, SimpleStreamOptions, TextContent } from "./ai-stream.js";
