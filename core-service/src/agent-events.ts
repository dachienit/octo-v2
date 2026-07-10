/**
 * Structured agent activity trail — wire protocol shared by the SSE transport,
 * the trail.jsonl audit store, and history replay.
 *
 * Every event carries a monotonic per-run `seq` (assigned by the HTTP context)
 * so the audit trail has a total order even if the client re-buffers.
 *
 * Correlation IDs:
 *   blockId    = `${assistantMsgSeq}:${contentIndex}` — unique per content block within a run
 *   toolCallId = pi ToolCall.id — stable from model tool-call composition through execution end
 */

export interface AgentUsage {
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
}

export type AgentTrailEvent =
	| { type: "turn"; seq: number; phase: "start" | "end"; turnIndex: number; ts: number }
	| { type: "block"; seq: number; phase: "start"; blockId: string; kind: "text" | "thinking"; ts: number }
	| { type: "block"; seq: number; phase: "delta"; blockId: string; kind: "text" | "thinking"; delta: string }
	| { type: "block"; seq: number; phase: "end"; blockId: string; kind: "text" | "thinking"; content: string }
	/** Model finished composing a tool call (args complete, execution not started yet). */
	| { type: "tool"; seq: number; phase: "call"; toolCallId: string; toolName: string; args: Record<string, unknown>; ts: number }
	| { type: "tool"; seq: number; phase: "start"; toolCallId: string; toolName: string; label?: string; args: Record<string, unknown>; ts: number }
	| { type: "tool"; seq: number; phase: "update"; toolCallId: string; toolName: string; partialResult: string }
	| {
		type: "tool";
		seq: number;
		phase: "end";
		toolCallId: string;
		toolName: string;
		label?: string;
		args: Record<string, unknown>;
		durationMs: number;
		result: string;
		resultTruncated: boolean;
		isError: boolean;
		ts: number;
	}
	/** A skill was invoked (detected as a read of a SKILL.md file). */
	| { type: "skill"; seq: number; name: string; path: string; toolCallId: string; ts: number }
	| {
		type: "usage";
		seq: number;
		scope: "message" | "run";
		usage: AgentUsage;
		/** Which model served this step (per-message) or the last model of the run. */
		model?: { provider: string; id: string };
		contextTokens?: number;
		contextWindow?: number;
	}
	| { type: "compaction"; seq: number; phase: "start" | "end"; reason?: string; tokensBefore?: number; aborted?: boolean }
	| { type: "retry"; seq: number; attempt: number; maxAttempts: number; errorMessage?: string };

/** Max tool-result bytes forwarded over SSE / stored in replay responses. */
export const TOOL_RESULT_MAX_CHARS = 16 * 1024;

export function truncateToolResult(text: string): { text: string; truncated: boolean } {
	if (text.length <= TOOL_RESULT_MAX_CHARS) return { text, truncated: false };
	return { text: text.slice(0, TOOL_RESULT_MAX_CHARS), truncated: true };
}

/**
 * Skills are SKILL.md instruction files, not first-class tools — invoking one is
 * observable only as a `read` tool call whose path ends in SKILL.md.
 * Skill name = basename of the parent directory.
 */
export function detectSkillFromToolCall(
	toolName: string,
	args: Record<string, unknown>,
): { name: string; path: string } | null {
	if (toolName !== "read") return null;
	const rawPath = typeof args.path === "string" ? args.path : typeof args.file_path === "string" ? args.file_path : "";
	if (!rawPath) return null;
	const normalized = rawPath.replace(/\\/g, "/");
	if (!/\/skill\.md$/i.test(normalized) && !/^skill\.md$/i.test(normalized)) return null;
	const parts = normalized.split("/");
	const name = parts.length >= 2 ? parts[parts.length - 2] : normalized;
	return { name, path: rawPath };
}
