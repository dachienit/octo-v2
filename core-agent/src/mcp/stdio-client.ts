import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface, type Interface } from "node:readline";
import type { McpServerConfig, McpToolCallResult, McpToolMetadata } from "./types.js";
import { createInitializeParams, normalizeToolCallResult, normalizeToolsResult, type JsonRpcRequest, type JsonRpcResponse, type McpClient } from "./protocol.js";

interface PendingRequest {
	resolve: (value: unknown) => void;
	reject: (error: Error) => void;
	timeout: NodeJS.Timeout;
}

export class McpStdioClient implements McpClient {
	private child?: ChildProcessWithoutNullStreams;
	private lines?: Interface;
	private nextId = 1;
	private pending = new Map<number, PendingRequest>();
	private stderrTail = "";
	private initialized = false;

	constructor(private readonly config: McpServerConfig) {}

	async connect(signal?: AbortSignal): Promise<void> {
		if (this.initialized) return;
		if (!this.config.command?.trim()) throw new Error(`MCP server ${this.config.name} has no command`);

		const child = spawn(this.config.command, this.config.args ?? [], {
			env: { ...process.env, ...(this.config.env ?? {}) },
			stdio: ["pipe", "pipe", "pipe"],
		});
		this.child = child;

		child.stderr.setEncoding("utf-8");
		child.stderr.on("data", (chunk: string) => {
			this.stderrTail = `${this.stderrTail}${chunk}`.slice(-4000);
		});

		child.once("error", (error) => {
			this.rejectAll(error instanceof Error ? error : new Error(String(error)));
		});
		child.once("exit", (code, sig) => {
			if (!this.initialized || this.pending.size > 0) {
				this.rejectAll(new Error(`MCP server ${this.config.name} exited (${sig ?? code ?? "unknown"})${this.stderrTail ? `: ${this.stderrTail.trim()}` : ""}`));
			}
		});

		this.lines = createInterface({ input: child.stdout });
		this.lines.on("line", (line) => this.handleLine(line));

		await this.request(
			"initialize",
			createInitializeParams(),
			signal,
		);
		this.notify("notifications/initialized", {});
		this.initialized = true;
	}

	async listTools(signal?: AbortSignal): Promise<McpToolMetadata[]> {
		await this.connect(signal);
		const result = await this.request("tools/list", {}, signal);
		return normalizeToolsResult(result);
	}

	async callTool(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<McpToolCallResult> {
		await this.connect(signal);
		const result = await this.request("tools/call", { name, arguments: args }, signal);
		return normalizeToolCallResult(result);
	}

	close(): void {
		this.lines?.close();
		this.child?.kill();
		this.rejectAll(new Error(`MCP server ${this.config.name} closed`));
	}

	private request(method: string, params?: unknown, signal?: AbortSignal): Promise<unknown> {
		const child = this.child;
		if (!child || child.killed) return Promise.reject(new Error(`MCP server ${this.config.name} is not running`));

		const id = this.nextId++;
		const message: JsonRpcRequest = { jsonrpc: "2.0", id, method, params };
		const timeoutMs = this.config.timeoutMs ?? 30000;

		return new Promise((resolve, reject) => {
			const timeout = setTimeout(() => {
				this.pending.delete(id);
				reject(new Error(`MCP request timed out: ${this.config.name}.${method}`));
			}, timeoutMs);

			const abort = (): void => {
				clearTimeout(timeout);
				this.pending.delete(id);
				reject(new Error(`MCP request aborted: ${this.config.name}.${method}`));
			};

			if (signal?.aborted) {
				abort();
				return;
			}

			signal?.addEventListener("abort", abort, { once: true });
			this.pending.set(id, {
				resolve: (value) => {
					signal?.removeEventListener("abort", abort);
					resolve(value);
				},
				reject: (error) => {
					signal?.removeEventListener("abort", abort);
					reject(error);
				},
				timeout,
			});

			child.stdin.write(`${JSON.stringify(message)}\n`, "utf-8");
		});
	}

	private notify(method: string, params?: unknown): void {
		this.child?.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`, "utf-8");
	}

	private handleLine(line: string): void {
		const trimmed = line.trim();
		if (!trimmed) return;

		let message: JsonRpcResponse;
		try {
			message = JSON.parse(trimmed) as JsonRpcResponse;
		} catch {
			this.stderrTail = `${this.stderrTail}\n${trimmed}`.slice(-4000);
			return;
		}

		const id = typeof message.id === "number" ? message.id : undefined;
		if (id === undefined) return;
		const pending = this.pending.get(id);
		if (!pending) return;
		this.pending.delete(id);
		clearTimeout(pending.timeout);

		if (message.error) {
			pending.reject(new Error(message.error.message ?? `MCP error ${message.error.code ?? ""}`.trim()));
			return;
		}
		pending.resolve(message.result);
	}

	private rejectAll(error: Error): void {
		for (const [id, pending] of this.pending) {
			this.pending.delete(id);
			clearTimeout(pending.timeout);
			pending.reject(error);
		}
	}
}