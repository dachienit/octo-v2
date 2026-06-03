/**
 * Generic bot channel types — shared across Slack, HTTP, and future adapters.
 */

import type { Attachment } from "./store.js";

// ============================================================================
// Channel / User info
// ============================================================================

export interface ChannelInfo {
	id: string;
	name: string;
}

export interface UserInfo {
	id: string;
	userName: string;
	displayName: string;
}

// ============================================================================
// Bot event (adapter-agnostic incoming message)
// ============================================================================

export interface BotEvent {
	type: string; // "mention" | "dm" | "event" | adapter-specific
	channel: string;
	ts: string;
	user: string;
	text: string;
	/** Processed attachments with local paths (populated after logUserMessage) */
	attachments?: Attachment[];
}

// ============================================================================
// Bot context (what the agent runner uses to respond)
// ============================================================================

export interface BotContext {
	message: {
		text: string;
		rawText: string;
		user: string;
		userName?: string;
		channel: string;
		ts: string;
		attachments: Array<{ local: string }>;
	};
	/** Auth JSON path for the user who sent this message */
	authFilePath?: string;
	channelName?: string;
	channels: ChannelInfo[];
	users: UserInfo[];
	respond: (text: string, shouldLog?: boolean) => Promise<void>;
	replaceMessage: (text: string) => Promise<void>;
	respondInThread: (text: string) => Promise<void>;
	setTyping: (isTyping: boolean) => Promise<void>;
	uploadFile: (filePath: string, title?: string) => Promise<void>;
	setWorking: (working: boolean) => Promise<void>;
	deleteMessage: () => Promise<void>;
}

// ============================================================================
// Bot handler (channel-agnostic run coordinator in main.ts)
// ============================================================================

export interface BotHandler {
	isRunning(channelId: string): boolean;

	/**
	 * Run the agent for an incoming message.
	 * The ctx is pre-built by the adapter (Slack, HTTP, etc.).
	 */
	handleEvent(channelId: string, ctx: BotContext, isEvent?: boolean): Promise<void>;

	/**
	 * Abort the current run for a channel.
	 * @param onStopping — called immediately to notify the user (e.g. post "Stopping…")
	 * @param onStopped  — called once the run actually finishes (e.g. update to "Stopped")
	 */
	handleStop(
		channelId: string,
		onStopping: () => Promise<void>,
		onStopped: () => Promise<void>,
	): Promise<void>;
}

// ============================================================================
// Event router (minimal interface for EventsWatcher)
// ============================================================================

export interface EventRouter {
	/** Queue a synthetic event for processing. Returns false if the queue is full. */
	enqueueEvent(event: BotEvent): boolean;
}
