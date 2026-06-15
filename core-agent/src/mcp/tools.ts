import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { Static, TSchema } from "typebox";
import { Type } from "typebox";
import { McpSseClient, McpStreamableHttpClient } from "./http-client.js";
import type { McpClient } from "./protocol.js";
import { McpStdioClient } from "./stdio-client.js";
import type { McpServerConfig, McpToolCallResult, McpToolMetadata } from "./types.js";

interface RuntimeTool {
	server: McpServerConfig;
	client: McpClient;
	metadata: McpToolMetadata;
	virtualName: string;
}

const mcpClientByTool = new WeakMap<AgentTool<any>, McpClient>();

export async function createMcpTools(servers: McpServerConfig[] | undefined, signal?: AbortSignal): Promise<AgentTool<any>[]> {
	const enabled = (servers ?? []).filter((server) => server.enabled !== false);
	const tools: AgentTool<any>[] = [];
	const usedNames = new Set<string>();

	for (const server of enabled) {
		try {
			const client = createClient(server);
			const metadata = filterTools(await client.listTools(signal), server);
			for (const tool of metadata) {
				const virtualName = uniqueToolName(createVirtualToolName(server, tool), usedNames);
				tools.push(createAgentTool({ server, client, metadata: tool, virtualName }));
			}
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			if (server.required) throw new Error(`Failed to load required MCP server ${server.name}: ${message}`);
			console.warn(`Failed to load MCP server ${server.name}: ${message}`);
		}
	}

	return tools;
}

export function closeMcpTools(tools: AgentTool<any>[] | undefined): void {
	const clients = new Set<McpClient>();
	for (const tool of tools ?? []) {
		const client = mcpClientByTool.get(tool);
		if (client) clients.add(client);
	}
	for (const client of clients) client.close();
}

function createClient(server: McpServerConfig): McpClient {
	const transport = server.transport ?? (server.url ? "streamable-http" : "stdio");
	if (transport === "stdio") return new McpStdioClient(server);
	if (transport === "streamable-http") return new McpStreamableHttpClient(server);
	if (transport === "sse") return new McpSseClient(server);
	const exhaustive: never = transport;
	throw new Error(`Unsupported MCP transport: ${exhaustive}`);
}

function createAgentTool(runtime: RuntimeTool): AgentTool<any> {
	const schema = normalizeInputSchema(runtime.metadata.inputSchema);
	const tool: AgentTool<any> = {
		name: runtime.virtualName,
		label: `${runtime.server.name}: ${runtime.metadata.name}`,
		description: runtime.metadata.description ?? `Tool ${runtime.metadata.name} from MCP server ${runtime.server.name}`,
		parameters: schema,
		executionMode: "sequential",
		execute: async (
			_toolCallId: string,
			params: Static<TSchema>,
			signal?: AbortSignal,
		) => {
			const result = await runtime.client.callTool(runtime.metadata.name, params as Record<string, unknown>, signal);
			if (result.isError) throw new Error(formatMcpResult(result));
			return {
				content: [{ type: "text", text: formatMcpResult(result) }],
				details: {
					mcpServer: runtime.server.name,
					mcpTool: runtime.metadata.name,
				},
			};
		},
	};
	mcpClientByTool.set(tool, runtime.client);
	return tool;
}

function filterTools(tools: McpToolMetadata[], server: McpServerConfig): McpToolMetadata[] {
	const allowed = new Set(server.allowedTools ?? []);
	const blocked = new Set(server.blockedTools ?? []);
	return tools.filter((tool) => {
		if (allowed.size > 0 && !allowed.has(tool.name)) return false;
		if (blocked.has(tool.name)) return false;
		return true;
	});
}

function normalizeInputSchema(schema: Record<string, unknown> | undefined): TSchema {
	if (!schema) return Type.Object({});
	const normalized = { ...schema };
	if (normalized.type === undefined) normalized.type = "object";
	if (normalized.properties === undefined && normalized.type === "object") normalized.properties = {};
	return normalized as unknown as TSchema;
}

function createVirtualToolName(server: McpServerConfig, tool: McpToolMetadata): string {
	const prefix = server.toolPrefix ?? server.name;
	return `mcp_${sanitizeName(prefix)}_${sanitizeName(tool.name)}`;
}

function uniqueToolName(name: string, usedNames: Set<string>): string {
	let candidate = name;
	let index = 2;
	while (usedNames.has(candidate)) {
		candidate = `${name}_${index}`;
		index++;
	}
	usedNames.add(candidate);
	return candidate;
}

function sanitizeName(name: string): string {
	const safe = name.toLowerCase().replace(/[^a-z0-9_-]+/g, "_").replace(/^_+|_+$/g, "");
	return safe || "tool";
}

function formatMcpResult(result: McpToolCallResult): string {
	const content = result.content ?? [];
	if (content.length === 0) return JSON.stringify(result);

	const parts = content.map((block) => {
		if (block.type === "text" && typeof block.text === "string") return block.text;
		if (block.type === "image") return `[image${block.mimeType ? ` ${block.mimeType}` : ""}${block.data ? `, ${block.data.length} base64 chars` : ""}]`;
		if (block.type === "resource") return JSON.stringify(block);
		return JSON.stringify(block);
	});

	return parts.join("\n\n") || "(empty MCP result)";
}