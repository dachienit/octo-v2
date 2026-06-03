import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { SandboxConfig } from "./sandbox.js";

export interface CoreAgentOptions {
	sandboxConfig: SandboxConfig;
	/** Host path to the channel's session directory (contains context.jsonl, MEMORY.md, etc.) */
	channelDir: string;
	/** Auth JSON path used unless a run provides a user-specific path */
	authFilePath?: string;
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
	/** Called by the attach tool — path is already translated to host path */
	uploadFile?: (path: string, title?: string) => Promise<void>;
	/** Per-run event callbacks */
	events?: CoreAgentEventHandlers;
}

export interface CoreAgentEventHandlers {
	onToolStart?: (toolName: string, label: string, args: Record<string, unknown>) => void;
	onToolEnd?: (
		toolName: string,
		label: string | undefined,
		args: Record<string, unknown>,
		durationMs: number,
		resultText: string,
		isError: boolean,
	) => void;
	onMessage?: (text: string) => void;
	onThinking?: (text: string) => void;
	onCompactionStart?: (reason: string) => void;
	onCompactionEnd?: (result?: { tokensBefore: number }, aborted?: boolean) => void;
	onRetry?: (attempt: number, maxAttempts: number, errorMessage?: string) => void;
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
