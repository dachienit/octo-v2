import type { McpToolCallResult, McpToolMetadata } from "./types.js";

export interface JsonRpcRequest {
	jsonrpc: "2.0";
	id: number;
	method: string;
	params?: unknown;
}

export interface JsonRpcNotification {
	jsonrpc: "2.0";
	method: string;
	params?: unknown;
}

export interface JsonRpcResponse {
	jsonrpc?: "2.0";
	id?: number | string;
	result?: unknown;
	error?: { code?: number; message?: string; data?: unknown };
	method?: string;
	params?: unknown;
}

export interface McpClient {
	listTools(signal?: AbortSignal): Promise<McpToolMetadata[]>;
	callTool(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<McpToolCallResult>;
	close(): void;
}

export function normalizeToolsResult(result: unknown): McpToolMetadata[] {
	const tools = typeof result === "object" && result && Array.isArray((result as { tools?: unknown[] }).tools)
		? (result as { tools: unknown[] }).tools
		: [];
	return tools
		.map((tool) => normalizeTool(tool))
		.filter((tool): tool is McpToolMetadata => tool !== undefined);
}

export function normalizeToolCallResult(result: unknown): McpToolCallResult {
	return typeof result === "object" && result ? result as McpToolCallResult : { content: [{ type: "text", text: String(result ?? "") }] };
}

export function normalizeTool(value: unknown): McpToolMetadata | undefined {
	if (!value || typeof value !== "object") return undefined;
	const raw = value as Record<string, unknown>;
	if (typeof raw.name !== "string" || !raw.name.trim()) return undefined;
	return {
		name: raw.name,
		description: typeof raw.description === "string" ? raw.description : undefined,
		inputSchema: raw.inputSchema && typeof raw.inputSchema === "object"
			? raw.inputSchema as Record<string, unknown>
			: undefined,
	};
}

export function createInitializeParams(): Record<string, unknown> {
	return {
		protocolVersion: "2024-11-05",
		capabilities: {},
		clientInfo: { name: "pi-boi", version: "0.0.1" },
	};
}

export function parseSseMessages(text: string): Array<{ event?: string; data: string }> {
	const messages: Array<{ event?: string; data: string }> = [];
	for (const rawEvent of text.split(/\r?\n\r?\n/)) {
		let event: string | undefined;
		const data: string[] = [];
		for (const line of rawEvent.split(/\r?\n/)) {
			if (line.startsWith("event:")) event = line.slice(6).trim();
			else if (line.startsWith("data:")) data.push(line.slice(5).trimStart());
		}
		if (data.length > 0) messages.push({ event, data: data.join("\n") });
	}
	return messages;
}

export function responseResult(response: JsonRpcResponse): unknown {
	if (response.error) throw new Error(response.error.message ?? `MCP error ${response.error.code ?? ""}`.trim());
	return response.result;
}