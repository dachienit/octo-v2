import { Alert } from "@mariozechner/mini-lit/dist/Alert.js";
import type { Message } from "@octo/core-agent";
import type { AgentMessage, MessageRenderer } from "@octo/web-ui-corp";
import { defaultConvertToLlm, registerMessageRenderer } from "@octo/web-ui-corp";
import { html } from "lit";

// ============================================================================
// 1. DEFINE CUSTOM APP MESSAGE TYPE
// ============================================================================

// Define custom message types
export interface SystemNotificationMessage {
	role: "system-notification";
	message: string;
	variant: "default" | "destructive";
	timestamp: string;
}

type AppAgentMessage = AgentMessage | SystemNotificationMessage;

// ============================================================================
// 2. CREATE CUSTOM RENDERER (TYPED TO SystemNotificationMessage)
// ============================================================================

const systemNotificationRenderer: MessageRenderer<SystemNotificationMessage> = {
	render: (notification) => {
		// notification is fully typed as SystemNotificationMessage!
		return html`
			<div class="px-4">
				${Alert({
					variant: notification.variant,
					children: html`
						<div class="flex flex-col gap-1">
							<div>${notification.message}</div>
							<div class="text-xs opacity-70">${new Date(notification.timestamp).toLocaleTimeString()}</div>
						</div>
					`,
				})}
			</div>
		`;
	},
};

// ============================================================================
// 3. REGISTER RENDERER
// ============================================================================

export function registerCustomMessageRenderers() {
	registerMessageRenderer("system-notification", systemNotificationRenderer);
}

// ============================================================================
// 4. HELPER TO CREATE CUSTOM MESSAGES
// ============================================================================

export function createSystemNotification(
	message: string,
	variant: "default" | "destructive" = "default",
): SystemNotificationMessage {
	return {
		role: "system-notification",
		message,
		variant,
		timestamp: new Date().toISOString(),
	};
}

// ============================================================================
// 5. CUSTOM MESSAGE TRANSFORMER
// ============================================================================

/**
 * Custom message transformer that extends defaultConvertToLlm.
 * Handles system-notification messages by converting them to user messages.
 */
export function customConvertToLlm(messages: AppAgentMessage[]): Message[] {
	// First, handle our custom system-notification type
	const processed = messages.map((m): AgentMessage => {
		if (m.role === "system-notification") {
			// Convert to user message with <system> tags
			return {
				role: "user",
				content: `<system>${m.message}</system>`,
				timestamp: Date.now(),
			};
		}
		return m;
	});

	// Then use defaultConvertToLlm for standard handling
	return defaultConvertToLlm(processed);
}
