import type { McpServerConfig, McpToolCallResult, McpToolMetadata } from "./types.js";
import {
	createInitializeParams,
	normalizeToolCallResult,
	normalizeToolsResult,
	parseSseMessages,
	responseResult,
	type JsonRpcNotification,
	type JsonRpcRequest,
	type JsonRpcResponse,
	type McpClient,
} from "./protocol.js";

export class McpStreamableHttpClient implements McpClient {
	private nextId = 1;
	private initialized = false;
	private sessionId: string | undefined;

	constructor(private readonly config: McpServerConfig) {}

	async connect(signal?: AbortSignal): Promise<void> {
		if (this.initialized) return;
		await this.request("initialize", createInitializeParams(), signal);
		await this.notify("notifications/initialized", {}, signal);
		this.initialized = true;
	}

	async listTools(signal?: AbortSignal): Promise<McpToolMetadata[]> {
		await this.connect(signal);
		return normalizeToolsResult(await this.request("tools/list", {}, signal));
	}

	async callTool(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<McpToolCallResult> {
		await this.connect(signal);
		return normalizeToolCallResult(await this.request("tools/call", { name, arguments: args }, signal));
	}

	close(): void {}

	private async request(method: string, params?: unknown, signal?: AbortSignal): Promise<unknown> {
		const id = this.nextId++;
		const response = await this.post({ jsonrpc: "2.0", id, method, params }, signal);
		return responseResult(response);
	}

	private async notify(method: string, params?: unknown, signal?: AbortSignal): Promise<void> {
		await this.post({ jsonrpc: "2.0", method, params }, signal, true);
	}

	private async post(payload: JsonRpcRequest | JsonRpcNotification, signal?: AbortSignal, notification = false): Promise<JsonRpcResponse> {
		const url = getServerUrl(this.config);
		const res = await fetch(url, {
			method: "POST",
			headers: this.headers(),
			body: JSON.stringify(payload),
			signal,
		});
		const sessionId = res.headers.get("mcp-session-id");
		if (sessionId) this.sessionId = sessionId;
		if (!res.ok) throw new Error(`MCP HTTP ${res.status} from ${this.config.name}: ${await safeResponseText(res)}`);
		if (notification || res.status === 202 || res.status === 204) return {};

		const contentType = res.headers.get("content-type") ?? "";
		const text = await res.text();
		if (contentType.includes("text/event-stream")) {
			const responses = parseSseMessages(text)
				.map((message) => parseJson(message.data))
				.filter((message): message is JsonRpcResponse => Boolean(message));
			const id = (payload as JsonRpcRequest).id;
			const matched = responses.find((message) => message.id === id) ?? responses[0];
			if (!matched) throw new Error(`MCP HTTP response from ${this.config.name} did not include JSON-RPC data`);
			return matched;
		}
		const parsed = parseJson(text);
		if (!parsed) throw new Error(`MCP HTTP response from ${this.config.name} was not JSON`);
		if (Array.isArray(parsed)) {
			const id = (payload as JsonRpcRequest).id;
			const matched = parsed.find((message) => message?.id === id);
			if (!matched) throw new Error(`MCP HTTP batch response from ${this.config.name} did not include request ${id}`);
			return matched as JsonRpcResponse;
		}
		return parsed as JsonRpcResponse;
	}

	private headers(): Record<string, string> {
		return {
			Accept: "application/json, text/event-stream",
			"Content-Type": "application/json",
			...(this.sessionId ? { "Mcp-Session-Id": this.sessionId } : {}),
			...(this.config.headers ?? {}),
		};
	}
}

export class McpSseClient implements McpClient {
	private nextId = 1;
	private initialized = false;
	private endpoint: string | undefined;
	private abortController: AbortController | undefined;
	private pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void; timeout: NodeJS.Timeout }>();

	constructor(private readonly config: McpServerConfig) {}

	async connect(signal?: AbortSignal): Promise<void> {
		if (this.initialized) return;
		await this.openEventStream(signal);
		await this.request("initialize", createInitializeParams(), signal);
		await this.notify("notifications/initialized", {}, signal);
		this.initialized = true;
	}

	async listTools(signal?: AbortSignal): Promise<McpToolMetadata[]> {
		await this.connect(signal);
		return normalizeToolsResult(await this.request("tools/list", {}, signal));
	}

	async callTool(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<McpToolCallResult> {
		await this.connect(signal);
		return normalizeToolCallResult(await this.request("tools/call", { name, arguments: args }, signal));
	}

	close(): void {
		this.abortController?.abort();
		this.rejectAll(new Error(`MCP SSE server ${this.config.name} closed`));
	}

	private async openEventStream(signal?: AbortSignal): Promise<void> {
		const url = getServerUrl(this.config);
		this.abortController = new AbortController();
		const abort = (): void => this.abortController?.abort();
		signal?.addEventListener("abort", abort, { once: true });
		const res = await fetch(url, {
			headers: { Accept: "text/event-stream", ...(this.config.headers ?? {}) },
			signal: this.abortController.signal,
		});
		signal?.removeEventListener("abort", abort);
		if (!res.ok || !res.body) throw new Error(`MCP SSE ${res.status} from ${this.config.name}: ${await safeResponseText(res)}`);

		const reader = res.body.getReader();
		const decoder = new TextDecoder();
		let buffer = "";
		const endpointReady = new Promise<void>((resolve, reject) => {
			const timeout = setTimeout(() => reject(new Error(`MCP SSE endpoint timed out for ${this.config.name}`)), this.config.timeoutMs ?? 30000);
			const pump = async (): Promise<void> => {
				try {
					for (;;) {
						const { done, value } = await reader.read();
						if (done) break;
						buffer += decoder.decode(value, { stream: true });
						const events = drainSseBuffer(buffer);
						buffer = events.remainder;
						for (const event of events.messages) {
							this.handleSseEvent(event);
							if (this.endpoint) {
								clearTimeout(timeout);
								resolve();
							}
						}
					}
					this.rejectAll(new Error(`MCP SSE stream ended for ${this.config.name}`));
				} catch (err) {
					const error = err instanceof Error ? err : new Error(String(err));
					this.rejectAll(error);
					reject(error);
				}
			};
			void pump();
		});
		await endpointReady;
	}

	private async request(method: string, params?: unknown, signal?: AbortSignal): Promise<unknown> {
		if (!this.endpoint) throw new Error(`MCP SSE server ${this.config.name} did not provide an endpoint`);
		const id = this.nextId++;
		const timeoutMs = this.config.timeoutMs ?? 30000;
		const result = new Promise<unknown>((resolve, reject) => {
			const timeout = setTimeout(() => {
				this.pending.delete(id);
				reject(new Error(`MCP SSE request timed out: ${this.config.name}.${method}`));
			}, timeoutMs);
			this.pending.set(id, { resolve, reject, timeout });
		});
		await this.postToEndpoint({ jsonrpc: "2.0", id, method, params }, signal);
		return result;
	}

	private async notify(method: string, params?: unknown, signal?: AbortSignal): Promise<void> {
		if (!this.endpoint) throw new Error(`MCP SSE server ${this.config.name} did not provide an endpoint`);
		await this.postToEndpoint({ jsonrpc: "2.0", method, params }, signal);
	}

	private async postToEndpoint(payload: JsonRpcRequest | JsonRpcNotification, signal?: AbortSignal): Promise<void> {
		const res = await fetch(this.endpoint!, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Accept: "application/json",
				...(this.config.headers ?? {}),
			},
			body: JSON.stringify(payload),
			signal,
		});
		if (!res.ok) throw new Error(`MCP SSE POST ${res.status} to ${this.config.name}: ${await safeResponseText(res)}`);
	}

	private handleSseEvent(message: { event?: string; data: string }): void {
		if (message.event === "endpoint") {
			this.endpoint = new URL(message.data, getServerUrl(this.config)).toString();
			return;
		}
		const parsed = parseJson(message.data) as JsonRpcResponse | undefined;
		if (!parsed || parsed.id === undefined) return;
		const id = typeof parsed.id === "number" ? parsed.id : Number(parsed.id);
		if (!Number.isFinite(id)) return;
		const pending = this.pending.get(id);
		if (!pending) return;
		this.pending.delete(id);
		clearTimeout(pending.timeout);
		try {
			pending.resolve(responseResult(parsed));
		} catch (err) {
			pending.reject(err instanceof Error ? err : new Error(String(err)));
		}
	}

	private rejectAll(error: Error): void {
		for (const [id, pending] of this.pending) {
			this.pending.delete(id);
			clearTimeout(pending.timeout);
			pending.reject(error);
		}
	}
}

function getServerUrl(config: McpServerConfig): string {
	if (!config.url?.trim()) throw new Error(`MCP server ${config.name} has no URL`);
	return config.url;
}

function parseJson(text: string): unknown | undefined {
	try {
		return JSON.parse(text);
	} catch {
		return undefined;
	}
}

function drainSseBuffer(buffer: string): { messages: Array<{ event?: string; data: string }>; remainder: string } {
	const messages: Array<{ event?: string; data: string }> = [];
	let remainder = buffer;
	for (;;) {
		const match = remainder.match(/\r?\n\r?\n/);
		if (!match || match.index === undefined) break;
		const end = match.index + match[0].length;
		messages.push(...parseSseMessages(remainder.slice(0, end)));
		remainder = remainder.slice(end);
	}
	return { messages, remainder };
}

async function safeResponseText(res: Response): Promise<string> {
	try {
		return (await res.text()).slice(0, 1000);
	} catch {
		return "";
	}
}