import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { SandboxConfig } from "./sandbox.js";

export interface CoreAgentOptions {
	sandboxConfig: SandboxConfig;
	/** Host path to the channel's session directory (contains context.jsonl, MEMORY.md, etc.) */
	channelDir: string;
	/** Auth JSON path used unless a run provides a user-specific path */
	authFilePath?: string;
	/** User id owning this agent run and any delegated worker auth */
	userId?: string;
	/** Root directory containing per-user service data */
	usersRoot?: string;
	/** Enable ACP-compatible delegated worker agents */
	agentWorkersEnabled?: boolean;
	/** Additional tools beyond the primitive set */
	extraTools?: AgentTool<any>[];
}

export interface CoreAgentRunInput {
	/** Message text from the user */
	text: string;
	/** Slack/adapter timestamp of this message — used to exclude it from log sync */
	ts?: string;
	/** Display name of the user */
	userName?: string;
	/** Attachments with relative paths under the workspace */
	attachments?: Array<{ local: string }>;
	/** Full system prompt for this run */
	systemPrompt: string;
	/** User-specific auth JSON path for this run */
	authFilePath?: string;
	/**
	 * IYH1HC add: per-run model override. When present, the agent runs this model
	 * (resolved via pi-ai getModel, falling back to a stub) and uses `apiKey`
	 * instead of the env/auth-file key. Absent → legacy env-driven behavior.
	 */
	model?: { provider: string; modelId: string; apiKey?: string; baseUrl?: string; apiType?: string };
	/** Called by the attach tool — path is already translated to host path */
	uploadFile?: (path: string, title?: string) => Promise<void>;
	/** Per-run event callbacks */
	events?: CoreAgentEventHandlers;
}

export interface CoreAgentEventHandlers {
	//IYH1HC stream comment onToolStart?: (toolName: string, label: string, args: Record<string, unknown>) => void;
	//IYH1HC stream add: trailing toolCallId lets transports correlate tool lifecycle events
	onToolStart?: (toolName: string, label: string, args: Record<string, unknown>, toolCallId?: string) => void;
	onToolEnd?: (
		toolName: string,
		label: string | undefined,
		args: Record<string, unknown>,
		durationMs: number,
		resultText: string,
		isError: boolean,
		toolCallId?: string, //IYH1HC stream add
	) => void;
	onToolUpdate?: (
		toolName: string,
		label: string | undefined,
		args: Record<string, unknown>,
		resultText: string,
		toolCallId?: string, //IYH1HC stream add
	) => void;
	onMessage?: (text: string) => void;
	onThinking?: (text: string) => void;
	onCompactionStart?: (reason: string) => void;
	onCompactionEnd?: (result?: { tokensBefore: number }, aborted?: boolean) => void;
	onRetry?: (attempt: number, maxAttempts: number, errorMessage?: string) => void;
	//IYH1HC stream add: token-level streaming callbacks (fed from pi message_update events).
	// blockId = `${assistantMsgSeq}:${contentIndex}` — unique per content block within a run.
	onTurnStart?: () => void;
	onTurnEnd?: () => void;
	onBlockStart?: (blockId: string, kind: "text" | "thinking") => void;
	onBlockDelta?: (blockId: string, kind: "text" | "thinking", delta: string) => void;
	onBlockEnd?: (blockId: string, kind: "text" | "thinking", content: string) => void;
	/** Model finished composing a tool call (args complete, execution not started yet). */
	onToolCall?: (toolCallId: string, toolName: string, args: Record<string, unknown>) => void;
	/** Authoritative usage after each assistant message (one per LLM call). */
	onUsage?: (usage: CoreAgentRunResult["usage"], stopReason?: string, model?: { provider: string; id: string }) => void;
}

export interface CoreAgentRunResult {
	stopReason: string;
	errorMessage?: string;
	/** Text of the last assistant message, if any */
	lastAssistantText?: string;
	usage: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
		cost: {
			input: number;
			output: number;
			cacheRead: number;
			cacheWrite: number;
			total: number;
		};
	};
}
