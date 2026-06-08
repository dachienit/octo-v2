import type { ChildProcessWithoutNullStreams } from "child_process";
import { existsSync, readFileSync } from "fs";
import { resolve } from "path";
import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { ensureConnectorHome, getAgentRuntimeConnector } from "../connectors.js";
import type { Executor } from "../sandbox.js";
import { createAcpJob, setAcpJobCancel, updateAcpJob } from "./acp-job-registry.js";

type JsonRpcMessage = {
	jsonrpc?: "2.0";
	id?: number | string;
	method?: string;
	params?: unknown;
	result?: unknown;
	error?: { code?: number; message?: string; data?: unknown };
};

type AcpAgentConfig = {
	command: string;
	args?: string[];
	env?: Record<string, string>;
	modelId?: string;
	modeId?: string;
};

type AcpUserContext = {
	userId?: string;
	usersRoot?: string;
	runtimeUsersRoot?: string;
};

type AcpTask = {
	agent: string;
	task: string;
	cwd?: string;
};

const DEFAULT_AGENTS: Record<string, AcpAgentConfig> = {
	codex: {
		command: "codex-acp",
		modelId: process.env.ACP_CODEX_MODEL ?? "gpt-5.4-mini[medium]",
		modeId: process.env.ACP_CODEX_MODE ?? "agent-full-access",
	},
	gemini: { command: "gemini", args: ["--acp"] },
	claude: { command: "npx", args: ["-y", "@agentclientprotocol/claude-agent-acp"] },
};

function parseAgentsConfig(): Record<string, AcpAgentConfig> {
	const fromEnv = process.env.ACP_AGENTS_JSON;
	if (!fromEnv) return DEFAULT_AGENTS;

	try {
		const parsed = JSON.parse(fromEnv) as Record<string, AcpAgentConfig>;
		const merged = { ...DEFAULT_AGENTS };
		for (const [agent, config] of Object.entries(parsed)) {
			merged[agent] = { ...(merged[agent] ?? {}), ...config };
		}
		return merged;
	} catch (err) {
		throw new Error(`ACP_AGENTS_JSON is invalid JSON: ${err instanceof Error ? err.message : String(err)}`);
	}
}

function contentText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!content || typeof content !== "object") return "";
	const c = content as Record<string, unknown>;
	if (c.type === "text" && typeof c.text === "string") return c.text;
	if (typeof c.text === "string") return c.text;
	return "";
}

function extractUpdateText(update: unknown): string {
	if (!update || typeof update !== "object") return "";
	const u = update as Record<string, unknown>;
	const kind = u.sessionUpdate;
	if (kind === "agent_message_chunk" || kind === "agent_thought_chunk" || kind === "user_message_chunk") {
		return contentText(u.content);
	}
	if (kind === "tool_call") {
		return typeof u.title === "string" ? `\n[tool] ${u.title}\n` : "";
	}
	if (kind === "tool_call_update") {
		const title = typeof u.title === "string" ? u.title : undefined;
		const status = typeof u.status === "string" ? u.status : undefined;
		return title || status ? `\n[tool] ${[title, status].filter(Boolean).join(" - ")}\n` : "";
	}
	if (kind === "plan" && Array.isArray(u.entries)) {
		const entries = u.entries
			.map((entry) => {
				if (!entry || typeof entry !== "object") return "";
				const e = entry as Record<string, unknown>;
				const label = typeof e.content === "string" ? e.content : typeof e.title === "string" ? e.title : "";
				const status = typeof e.status === "string" ? e.status : "";
				return label ? `- ${status ? `${status}: ` : ""}${label}` : "";
			})
			.filter(Boolean)
			.join("\n");
		return entries ? `\n[plan]\n${entries}\n` : "";
	}
	return "";
}

class AcpClient {
	private child: ChildProcessWithoutNullStreams | undefined;
	private nextId = 1;
	private buffer = "";
	private pending = new Map<number | string, {
		resolve: (value: unknown) => void;
		reject: (err: Error) => void;
	}>();
	private updates: string[] = [];
	private stderr = "";

	constructor(
		private readonly config: AcpAgentConfig,
		private readonly cwd: string,
		private readonly executor?: Executor,
	) {}

	start(signal?: AbortSignal): void {
		this.child = this.executor
			? this.executor.spawn(this.config.command, this.config.args ?? [], {
				cwd: this.cwd,
				env: this.config.env,
				signal,
			})
			: undefined;

		if (!this.child) throw new Error("ACP executor is not configured");

		this.child.stdout.on("data", (chunk: Buffer) => this.onStdout(chunk));
		this.child.stderr.on("data", (chunk: Buffer) => {
			this.stderr += chunk.toString("utf-8");
			if (this.stderr.length > 12000) this.stderr = this.stderr.slice(-12000);
		});
		this.child.on("error", (err) => this.rejectAll(err));
		this.child.on("exit", (code, sig) => {
			if (this.pending.size > 0) {
				this.rejectAll(new Error(`ACP agent exited before response (code ${code ?? "null"}, signal ${sig ?? "null"})`));
			}
		});

		signal?.addEventListener("abort", () => {
			void this.cancel();
			this.child?.kill("SIGTERM");
		});
	}

	async initialize(): Promise<unknown> {
		return this.request("initialize", {
			protocolVersion: 1,
			clientInfo: { name: "pi-boi-acp-orchestrator", version: "0.0.1" },
			clientCapabilities: {
				fs: { readTextFile: false, writeTextFile: false },
				terminal: false,
			},
		});
	}

	async newSession(cwd: string): Promise<string> {
		const result = await this.request("session/new", {
			cwd,
			mcpServers: [],
			additionalDirectories: [],
		});
		const sessionId = (result as { sessionId?: unknown } | undefined)?.sessionId;
		if (typeof sessionId !== "string") throw new Error("ACP session/new did not return a sessionId");
		return sessionId;
	}

	async setSessionModel(sessionId: string, modelId: string): Promise<unknown> {
		return this.request("session/set_model", { sessionId, modelId });
	}

	async setSessionMode(sessionId: string, modeId: string): Promise<unknown> {
		return this.request("session/set_mode", { sessionId, modeId });
	}

	async prompt(sessionId: string, task: string): Promise<unknown> {
		return this.request("session/prompt", {
			sessionId,
			prompt: [{ type: "text", text: task }],
		});
	}

	async cancel(sessionId?: string): Promise<void> {
		if (!sessionId) return;
		this.notify("session/cancel", { sessionId });
	}

	close(): void {
		this.child?.kill("SIGTERM");
	}

	output(): string {
		return this.updates.join("").trim();
	}

	private request(method: string, params: unknown): Promise<unknown> {
		const id = this.nextId++;
		const message: JsonRpcMessage = { jsonrpc: "2.0", id, method, params };
		return new Promise((resolve, reject) => {
			this.pending.set(id, { resolve, reject });
			this.write(message);
		});
	}

	private notify(method: string, params: unknown): void {
		this.write({ jsonrpc: "2.0", method, params });
	}

	private write(message: JsonRpcMessage): void {
		if (!this.child || this.child.killed) throw new Error("ACP process is not running");
		this.child.stdin.write(`${JSON.stringify(message)}\n`);
	}

	private onStdout(chunk: Buffer): void {
		this.buffer += chunk.toString("utf-8");
		let idx = this.buffer.indexOf("\n");
		while (idx >= 0) {
			const line = this.buffer.slice(0, idx).trim();
			this.buffer = this.buffer.slice(idx + 1);
			if (line) this.handleLine(line);
			idx = this.buffer.indexOf("\n");
		}
	}

	private handleLine(line: string): void {
		let message: JsonRpcMessage;
		try {
			message = JSON.parse(line) as JsonRpcMessage;
		} catch {
			this.updates.push(`${line}\n`);
			return;
		}

		if (message.id !== undefined && (message.result !== undefined || message.error !== undefined)) {
			const pending = this.pending.get(message.id);
			if (!pending) return;
			this.pending.delete(message.id);
			if (message.error) {
				pending.reject(new Error(message.error.message || `ACP JSON-RPC error ${message.error.code ?? ""}`));
			} else {
				pending.resolve(message.result);
			}
			return;
		}

		if (message.method === "session/update") {
			const params = message.params as { update?: unknown } | undefined;
			const text = extractUpdateText(params?.update);
			if (text) this.updates.push(text);
			return;
		}

		if (message.id !== undefined && message.method) {
			this.handleClientRequest(message);
		}
	}

	private handleClientRequest(message: JsonRpcMessage): void {
		if (message.id === undefined || !message.method) return;
		let result: unknown = null;
		if (message.method === "session/request_permission") {
			result = { outcome: { outcome: "allowed" } };
		} else if (message.method.startsWith("fs/") || message.method.startsWith("terminal/")) {
			this.write({
				jsonrpc: "2.0",
				id: message.id,
				error: { code: -32601, message: `${message.method} is not supported by pi-boi ACP client` },
			});
			return;
		}
		this.write({ jsonrpc: "2.0", id: message.id, result });
	}

	private rejectAll(err: Error): void {
		if (this.stderr.trim()) {
			err = new Error(`${err.message}\n${this.stderr.trim()}`);
		}
		for (const pending of this.pending.values()) pending.reject(err);
		this.pending.clear();
	}
}

function resolveTaskCwd(baseCwd: string, cwd?: string): string {
	if (!cwd) return baseCwd;
	return resolve(baseCwd, cwd);
}

async function runAcpTask(task: AcpTask, baseCwd: string, executor: Executor, signal?: AbortSignal): Promise<{ agent: string; output: string; stopReason?: unknown }> {
	const agents = parseAgentsConfig();
	const config = agents[task.agent];
	if (!config) {
		throw new Error(`Unknown ACP agent "${task.agent}". Available agents: ${Object.keys(agents).join(", ") || "none"}`);
	}
	const cwd = resolveTaskCwd(baseCwd, task.cwd);

	const client = new AcpClient(config, cwd, executor);
	let sessionId: string | undefined;
	try {
		client.start(signal);
		await client.initialize();
		sessionId = await client.newSession(cwd);
		const result = await client.prompt(sessionId, task.task);
		const output = client.output();
		return {
			agent: task.agent,
			output: output || JSON.stringify(result),
			stopReason: (result as { stopReason?: unknown } | undefined)?.stopReason,
		};
	} finally {
		await client.cancel(sessionId);
		client.close();
	}
}

function safeUserId(userId: string): string {
	return userId.replace(/[^a-zA-Z0-9._-]/g, "_") || "web-user";
}

function buildUserAgentEnv(agentName: string, userContext?: AcpUserContext): Record<string, string> {
	if (!userContext?.usersRoot || !userContext.userId) return {};
	const connector = getAgentRuntimeConnector(agentName);
	if (!connector) return {};
	ensureConnectorHome(userContext.usersRoot, safeUserId(userContext.userId), connector.id);
	return connector.env({
		userId: safeUserId(userContext.userId),
		usersRoot: userContext.usersRoot,
		runtimeUsersRoot: userContext.runtimeUsersRoot ?? userContext.usersRoot,
	});
}

async function runTrackedAcpTask(
	task: AcpTask,
	baseCwd: string,
	workspaceRoot: string,
	sessionId: string,
	executor: Executor,
	signal?: AbortSignal,
	userContext?: AcpUserContext,
): Promise<{ agent: string; output: string; stopReason?: unknown; jobId: string }> {
	const agents = parseAgentsConfig();
	const config = agents[task.agent];
	if (!config) {
		throw new Error(`Unknown ACP agent "${task.agent}". Available agents: ${Object.keys(agents).join(", ") || "none"}`);
	}
	const cwd = resolveTaskCwd(baseCwd, task.cwd);

	const controller = new AbortController();
	const abort = () => controller.abort();
	const onParentAbort = () => abort();
	signal?.addEventListener("abort", onParentAbort, { once: true });

	const job = createAcpJob({
		workspaceRoot,
		sessionId,
		agent: task.agent,
		task: task.task,
		cwd,
		cancel: abort,
	});

	const client = new AcpClient({
		...config,
		env: { ...buildUserAgentEnv(task.agent, userContext), ...(config.env ?? {}) },
	}, cwd, executor);
	let acpSessionId: string | undefined;
	try {
		setAcpJobCancel(job.id, () => {
			void client.cancel(acpSessionId);
			controller.abort();
			client.close();
		});
		updateAcpJob(job.id, { status: "running", startedAt: new Date().toISOString() });
		client.start(controller.signal);
		await client.initialize();
		acpSessionId = await client.newSession(cwd);
		if (config.modelId) await client.setSessionModel(acpSessionId, config.modelId);
		if (config.modeId) await client.setSessionMode(acpSessionId, config.modeId);
		const result = await client.prompt(acpSessionId, task.task);
		const output = client.output();
		const stopReason = (result as { stopReason?: unknown } | undefined)?.stopReason;
		updateAcpJob(job.id, {
			status: "completed",
			output: output || JSON.stringify(result),
			stopReason,
			finishedAt: new Date().toISOString(),
		});
		return { agent: task.agent, output: output || JSON.stringify(result), stopReason, jobId: job.id };
	} catch (err) {
		const isCancelled = controller.signal.aborted || signal?.aborted;
		updateAcpJob(job.id, {
			status: isCancelled ? "cancelled" : "failed",
			error: err instanceof Error ? err.message : String(err),
			finishedAt: new Date().toISOString(),
		});
		throw err;
	} finally {
		signal?.removeEventListener("abort", onParentAbort);
		await client.cancel(acpSessionId);
		client.close();
	}
}

const AcpTaskSchema = Type.Object({
	agent: Type.String({ description: "Worker agent name, for example codex, gemini, or claude" }),
	task: Type.String({ description: "Task to delegate to this agent" }),
	cwd: Type.Optional(Type.String({ description: "Optional cwd relative to mom's shared workspace, or an absolute path" })),
});

const AcpDelegateParams = Type.Object({
	agent: Type.Optional(Type.String({ description: "Agent for single-task mode" })),
	task: Type.Optional(Type.String({ description: "Task for single-task mode" })),
	tasks: Type.Optional(Type.Array(AcpTaskSchema, { description: "Parallel delegated tasks" })),
	chain: Type.Optional(Type.Array(AcpTaskSchema, { description: "Sequential delegated tasks. {previous} is replaced with prior output." })),
	cwd: Type.Optional(Type.String({ description: "Default cwd relative to mom's shared workspace" })),
});

export function createAcpOrchestratorExtension(baseCwd: string, workspaceRoot = baseCwd, sessionId = "default", userContext?: AcpUserContext, executor?: Executor) {
	return function acpOrchestratorExtension(pi: ExtensionAPI) {
		if (!executor) throw new Error("Agent worker executor is not configured");
		pi.registerTool(defineTool({
			name: "acp_delegate",
			label: "Agent Delegate",
			description: [
				"Delegate work to worker agents that share mom's workspace.",
				"Use single mode with agent/task, parallel mode with tasks, or chain mode with chain.",
				"Configured worker agents come from ACP_AGENTS_JSON, with default names codex, gemini, and claude.",
			].join(" "),
			parameters: AcpDelegateParams,
			async execute(_toolCallId, params, signal, onUpdate, ctx) {
				const sharedCwd = resolveTaskCwd(baseCwd || ctx.cwd, params.cwd);
				const hasSingle = Boolean(params.agent && params.task);
				const hasTasks = Boolean(params.tasks?.length);
				const hasChain = Boolean(params.chain?.length);
				const modeCount = Number(hasSingle) + Number(hasTasks) + Number(hasChain);

				if (modeCount !== 1) {
					return {
						content: [{ type: "text", text: "Provide exactly one agent delegation mode: agent/task, tasks, or chain." }],
						details: { error: "invalid_mode" },
					};
				}

				const runOne = async (task: AcpTask) => {
					onUpdate?.({
						content: [{ type: "text", text: `Starting ${task.agent}: ${task.task.slice(0, 120)}` }],
						details: { agent: task.agent, status: "running" },
					});
					const result = await runTrackedAcpTask(
						{ ...task, cwd: task.cwd ?? params.cwd },
						sharedCwd,
						workspaceRoot,
						sessionId,
						executor,
						signal,
						userContext,
					);
					onUpdate?.({
						content: [{ type: "text", text: `Finished ${task.agent} job ${result.jobId}` }],
						details: { agent: task.agent, jobId: result.jobId, status: "completed" },
					});
					return result;
				};

				const results: Array<{ agent: string; output: string; stopReason?: unknown; jobId?: string }> = [];
				if (hasSingle) {
					results.push(await runOne({ agent: params.agent!, task: params.task!, cwd: params.cwd }));
				} else if (hasTasks) {
					results.push(...await Promise.all(params.tasks!.map(runOne)));
				} else if (hasChain) {
					let previous = "";
					for (const item of params.chain!) {
						const delegatedTask = item.task.replaceAll("{previous}", previous);
						const result = await runOne({ ...item, task: delegatedTask });
						results.push(result);
						previous = result.output;
					}
				}

				const text = results
					.map((result, index) => `## ${index + 1}. ${result.agent}\nStop reason: ${String(result.stopReason ?? "unknown")}\n\n${result.output || "(no output)"}`)
					.join("\n\n");

				return {
					content: [{ type: "text", text }],
					details: { cwd: sharedCwd, results },
				};
			},
		}));

		pi.registerTool(defineTool({
			name: "acp_agents",
			label: "Agent Workers",
			description: "List configured worker agents available to the agent delegate tool.",
			parameters: Type.Object({}),
			async execute() {
				const agents = parseAgentsConfig();
				const text = Object.entries(agents)
					.map(([name, cfg]) => `- ${name}: ${[cfg.command, ...(cfg.args ?? [])].join(" ")}`)
					.join("\n");
				return {
					content: [{ type: "text", text: text || "(no worker agents configured)" }],
					details: { agents },
				};
			},
		}));
	};
}

export function loadAcpAgentsFile(path: string): Record<string, AcpAgentConfig> | undefined {
	if (!existsSync(path)) return undefined;
	return JSON.parse(readFileSync(path, "utf-8")) as Record<string, AcpAgentConfig>;
}
