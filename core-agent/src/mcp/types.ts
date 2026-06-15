export type McpTransport = "stdio" | "streamable-http" | "sse";

export interface McpServerConfig {
	name: string;
	enabled?: boolean;
	transport?: McpTransport;
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
}

export interface McpToolMetadata {
	name: string;
	description?: string;
	inputSchema?: Record<string, unknown>;
}

export interface McpContentBlock {
	type: string;
	text?: string;
	data?: string;
	mimeType?: string;
	[key: string]: unknown;
}

export interface McpToolCallResult {
	content?: McpContentBlock[];
	isError?: boolean;
	[key: string]: unknown;
}