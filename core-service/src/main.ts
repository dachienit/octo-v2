#!/usr/bin/env node

import "dotenv/config";

//IYH1HC add: On Cloud Foundry the credentials of a user-provided service (e.g.
//IYH1HC add: `octo-secrets`) are injected into VCAP_SERVICES, NOT as plain env vars,
//IYH1HC add: while the code reads process.env directly. Hydrate process.env from every
//IYH1HC add: bound user-provided service's credentials (real env vars keep priority).
//IYH1HC add: No-op locally where VCAP_SERVICES is absent.
function loadUserProvidedCredentials(): void {
	const raw = process.env.VCAP_SERVICES;
	if (!raw) return;
	try {
		const services = JSON.parse(raw) as Record<string, Array<{ credentials?: Record<string, unknown> }>>;
		const userProvided = services["user-provided"] ?? [];
		for (const instance of userProvided) {
			const credentials = instance?.credentials ?? {};
			for (const [key, value] of Object.entries(credentials)) {
				if (process.env[key] === undefined && value !== null && value !== undefined) {
					process.env[key] = typeof value === "string" ? value : String(value);
				}
			}
		}
	} catch (err) {
		console.error("[vcap] failed to parse VCAP_SERVICES:", err instanceof Error ? err.message : err);
	}
}
loadUserProvidedCredentials();

// Wire proxy before any fetch calls (earendil, OAuth2, etc.).
// Node.js built-in fetch (undici) does not respect HTTP_PROXY/HTTPS_PROXY automatically.
const _proxyUrl =
	process.env.HTTPS_PROXY ||
	process.env.https_proxy ||
	process.env.HTTP_PROXY ||
	process.env.http_proxy;
if (_proxyUrl) {
	const { ProxyAgent, setGlobalDispatcher } = await import("undici");
	setGlobalDispatcher(new ProxyAgent(_proxyUrl));
}

import { appendFileSync, existsSync, mkdirSync } from "fs";
import { join, resolve } from "path";
import { type AgentRunner, getOrCreateRunner } from "./agent.js";
import { downloadChannel } from "./download.js";
import { createEventsWatcher, createWorkspaceEventsWatcher } from "./events.js";
import { createHttpContext, HttpServer } from "./http.js";
import * as log from "./log.js";
//IYH1HC add: object store mirror for durable sessions/artifacts (A3 part 2).
import { detectObjectStore, ObjectStoreMirror } from "./object-store.js";
import { parseSandboxArg, type SandboxConfig, validateSandbox } from "@octo/core-agent";
import { markWorkspaceSandboxActive, markWorkspaceSandboxIdle, resolveWorkspaceSandbox, startWorkspaceSandboxIdleCleanup } from "./sandbox-manager.js";
import { createSlackContext, SlackBot as SlackBotClass } from "./slack.js";
import { ChannelStore } from "./store.js";
import type { BotContext, BotEvent, BotHandler, EventRouter } from "./types.js";
import { WorkspaceStore } from "./workspaces.js";

// ============================================================================
// Config
// ============================================================================

const MOM_SLACK_APP_TOKEN = process.env.MOM_SLACK_APP_TOKEN;
const MOM_SLACK_BOT_TOKEN = process.env.MOM_SLACK_BOT_TOKEN;
const AGENT_WORKERS_ENABLED = !["0", "false", "off", "no"].includes((process.env.CORE_SERVICE_AGENT_WORKERS_ENABLED ?? "true").toLowerCase());
const REMINDERS_ENABLED = !["0", "false", "off", "no"].includes((process.env.CORE_SERVICE_REMINDERS_ENABLED ?? "true").toLowerCase());

interface ParsedArgs {
	workingDir?: string;
	sandbox: SandboxConfig;
	downloadChannel?: string;
	httpPort?: number;
}

function parseArgs(): ParsedArgs {
	const args = process.argv.slice(2);
	let sandbox: SandboxConfig = { type: "host" };
	let workingDir: string | undefined;
	let downloadChannelId: string | undefined;
	let httpPort: number | undefined;

	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		if (arg.startsWith("--sandbox=")) {
			sandbox = parseSandboxArg(arg.slice("--sandbox=".length));
		} else if (arg === "--sandbox") {
			sandbox = parseSandboxArg(args[++i] || "");
		} else if (arg.startsWith("--download=")) {
			downloadChannelId = arg.slice("--download=".length);
		} else if (arg === "--download") {
			downloadChannelId = args[++i];
		} else if (arg.startsWith("--http=")) {
			httpPort = parseInt(arg.slice("--http=".length), 10) || 3030;
		} else if (arg === "--http") {
			const next = args[i + 1];
			if (next && !next.startsWith("-") && /^\d+$/.test(next)) {
				httpPort = parseInt(next, 10);
				i++;
			//IYH1HC add: on Cloud Foundry the start command is `--http $PORT`; if $PORT is
			//IYH1HC add: unset/empty the flag arrives bare, so fall back to env PORT then 3030.
			} else {
				const envPort = parseInt(process.env.PORT ?? "", 10);
				httpPort = Number.isFinite(envPort) ? envPort : 3030;
			}
		} else if (!arg.startsWith("-")) {
			workingDir = arg;
		}
	}

	return {
		workingDir: workingDir ? resolve(workingDir) : undefined,
		sandbox,
		downloadChannel: downloadChannelId,
		httpPort,
	};
}

const parsedArgs = parseArgs();

// Handle --download mode
if (parsedArgs.downloadChannel) {
	if (!MOM_SLACK_BOT_TOKEN) {
		console.error("Missing env: MOM_SLACK_BOT_TOKEN");
		process.exit(1);
	}
	await downloadChannel(parsedArgs.downloadChannel, MOM_SLACK_BOT_TOKEN);
	process.exit(0);
}

// Normal bot mode - require working dir
if (!parsedArgs.workingDir) {
	console.error("Usage: mom [--sandbox=host|docker:<name>|podman:<name>] [--http[=port]] <data-directory>");
	console.error("       mom --download <channel-id>");
	process.exit(1);
}

const { workingDir, sandbox, httpPort } = {
	workingDir: parsedArgs.workingDir,
	sandbox: parsedArgs.sandbox,
	httpPort: parsedArgs.httpPort,
};

const hasSlack = !!(MOM_SLACK_APP_TOKEN && MOM_SLACK_BOT_TOKEN);
const hasHttp = httpPort !== undefined;

if (!hasSlack && !hasHttp) {
	console.error("Missing env: MOM_SLACK_APP_TOKEN, MOM_SLACK_BOT_TOKEN");
	console.error("Or start with --http[=port] to use the HTTP SSE channel instead.");
	process.exit(1);
}

await validateSandbox(sandbox);

//IYH1HC add: A3 part 2 — restore sessions/artifacts from the Object Store BEFORE
//IYH1HC add: WorkspaceStore reads workingDir. Gating mirrors createAuthStorage:
//IYH1HC add: bound + reachable → mirror runs regardless of the flag; missing/unreachable
//IYH1HC add: → CORE_SERVICE_OBJECTSTORE_ALLOW_EPHEMERAL=true warns + runs ephemeral,
//IYH1HC add: otherwise fail-fast in production (the CF FS is ephemeral; silent loss is worse).
const osConfig = detectObjectStore();
const allowObjectStoreEphemeral = process.env.CORE_SERVICE_OBJECTSTORE_ALLOW_EPHEMERAL === "true";
let objectStore: ObjectStoreMirror | undefined;
if (osConfig) {
	const mirror = new ObjectStoreMirror({ config: osConfig, dataRoot: workingDir });
	try {
		await mirror.verify();
		await mirror.restore();
		objectStore = mirror;
		console.log(`[object-store] backend enabled (bucket ${mirror.bucketName}), workspace tree restored`);
	} catch (err) {
		if (process.env.NODE_ENV === "production" && !allowObjectStoreEphemeral) throw err;
		console.warn(
			"[object-store] WARNING: object store unreachable, running with ephemeral sessions/artifacts:",
			err instanceof Error ? err.message : err,
		);
	}
} else if (process.env.NODE_ENV === "production" && !allowObjectStoreEphemeral) {
	throw new Error(
		"[object-store] No objectstore binding while NODE_ENV=production — bind taf-objectstore " +
			"or set CORE_SERVICE_OBJECTSTORE_ALLOW_EPHEMERAL=true to accept ephemeral sessions/artifacts.",
	);
} else {
	console.log("[object-store] no binding — workspace tree is ephemeral");
}

const workspaceStore = new WorkspaceStore(workingDir);

function sandboxLabel(config: SandboxConfig): string {
	if (config.type === "host") return "host";
	return config.container ? `${config.type}:${config.container}` : `${config.type}:managed-per-workspace`;
}

function parsePositiveIntEnv(name: string, fallback: number): number {
	const value = process.env[name];
	if (!value) return fallback;
	const parsed = Number.parseInt(value, 10);
	return Number.isFinite(parsed) ? parsed : fallback;
}

// ============================================================================
// State (per channel)
// ============================================================================

interface ChannelState {
	workspaceId: string;
	running: boolean;
	runner: AgentRunner;
	authFilePath?: string;
	agentWorkersEnabled: boolean;
	remindersEnabled: boolean;
	store: ChannelStore;
	stopRequested: boolean;
	queue: Promise<void>;
	/** Called once the aborted run finishes — set by handleStop, invoked by handleEvent */
	onStopComplete?: () => Promise<void>;
}

const channelStates = new Map<string, ChannelState>();

function getUserAuthFilePath(userId: string): string {
	const safeUserId = userId.replace(/[^a-zA-Z0-9._-]/g, "_") || "web-user";
	const dir = join(workingDir, "users", safeUserId);
	mkdirSync(dir, { recursive: true });
	return join(dir, "auth.json");
}

async function getState(sessionId: string, userId = "web-user", authFilePath?: string): Promise<ChannelState> {
	const session = workspaceStore.ensureSession({ sessionId, userId });
	let state = channelStates.get(sessionId);
	if (!state) {
		const workspaceRoot = workspaceStore.getWorkspaceRoot(session.workspaceId);
		const channelDir = join(workspaceRoot, "sessions", sessionId);
		const sessionSandbox = await resolveWorkspaceSandbox(sandbox, {
			workspaceId: session.workspaceId,
			workspaceRoot,
			usersRoot: join(workingDir, "users"),
			memberUserIds: workspaceStore.getWorkspaceMembers(session.workspaceId).map((member) => member.userId),
			image: workspaceStore.getWorkspaceSandboxImage(session.workspaceId),
		});
		state = {
			workspaceId: session.workspaceId,
			running: false,
			runner: getOrCreateRunner(sessionSandbox, sessionId, channelDir, { authFilePath, userId, usersRoot: join(workingDir, "users"), agentWorkersEnabled: AGENT_WORKERS_ENABLED, remindersEnabled: REMINDERS_ENABLED }),
			authFilePath,
			agentWorkersEnabled: AGENT_WORKERS_ENABLED,
			remindersEnabled: REMINDERS_ENABLED,
			store: new ChannelStore({ workingDir: join(workspaceRoot, "sessions"), botToken: MOM_SLACK_BOT_TOKEN || "" }),
			stopRequested: false,
			queue: Promise.resolve(),
		};
		channelStates.set(sessionId, state);
	} else if (!state.running) {
		const workspaceRoot = workspaceStore.getWorkspaceRoot(session.workspaceId);
		const channelDir = join(workspaceRoot, "sessions", sessionId);
		const sessionSandbox = await resolveWorkspaceSandbox(sandbox, {
			workspaceId: session.workspaceId,
			workspaceRoot,
			usersRoot: join(workingDir, "users"),
			memberUserIds: workspaceStore.getWorkspaceMembers(session.workspaceId).map((member) => member.userId),
			image: workspaceStore.getWorkspaceSandboxImage(session.workspaceId),
		});
		if (state.authFilePath !== authFilePath || state.agentWorkersEnabled !== AGENT_WORKERS_ENABLED || state.remindersEnabled !== REMINDERS_ENABLED) {
			state.runner = getOrCreateRunner(sessionSandbox, sessionId, channelDir, { authFilePath, userId, usersRoot: join(workingDir, "users"), agentWorkersEnabled: AGENT_WORKERS_ENABLED, remindersEnabled: REMINDERS_ENABLED });
			state.authFilePath = authFilePath;
			state.agentWorkersEnabled = AGENT_WORKERS_ENABLED;
			state.remindersEnabled = REMINDERS_ENABLED;
		}
		state.workspaceId = session.workspaceId;
	}
	return state;
}

// ============================================================================
// Handler
// ============================================================================

const handler: BotHandler = {
	isRunning(channelId: string): boolean {
		return channelStates.get(channelId)?.running ?? false;
	},

	async handleStop(
		channelId: string,
		onStopping: () => Promise<void>,
		onStopped: () => Promise<void>,
	): Promise<void> {
		const state = channelStates.get(channelId);
		if (state?.running) {
			state.stopRequested = true;
			state.runner.abort();
			state.onStopComplete = onStopped;
			await onStopping();
		}
		// "Nothing running" case: the adapter already checked isRunning() before calling this
	},

	async handleEvent(channelId: string, ctx: BotContext, _isEvent?: boolean): Promise<void> {
		const state = await getState(channelId, ctx.message.user || "web-user", ctx.authFilePath);

		const run = state.queue.then(async () => {
			// Start run
			const workspaceImage = workspaceStore.getWorkspaceSandboxImage(state.workspaceId);
			markWorkspaceSandboxActive(sandbox, { workspaceId: state.workspaceId, image: workspaceImage });
			state.running = true;
			state.stopRequested = false;

			log.logInfo(`[${channelId}] Starting run: ${ctx.message.text.substring(0, 50)}`);

			try {
				await ctx.setTyping(true);
				await ctx.setWorking(true);
				const result = await state.runner.run(ctx, state.store);
				await ctx.setWorking(false);

				if (result.stopReason === "aborted" && state.stopRequested) {
					if (state.onStopComplete) {
						await state.onStopComplete();
						state.onStopComplete = undefined;
					}
				}
			} catch (err) {
				log.logWarning(`[${channelId}] Run error`, err instanceof Error ? err.message : String(err));
			} finally {
				state.running = false;
				markWorkspaceSandboxIdle(sandbox, { workspaceId: state.workspaceId, image: workspaceImage });
				//IYH1HC add: snapshot this run's sessions/artifacts to the Object Store.
				//IYH1HC add: Fire-and-forget so the session queue isn't blocked; the mirror
				//IYH1HC add: serializes overlapping snapshots internally.
				// void objectStore ?.snapshot({ workspaceId: state.workspaceId, sessionId: channelId })
				//	.catch((err) => log.logWarning("[object-store] run-end snapshot error", err instanceof Error ? err.message : String(err)));
				
			}
		});
		state.queue = run.catch(() => {});
		await run;
	},
};

class HttpEventRouter implements EventRouter {
	private pendingBySession = new Map<string, number>();

	constructor(
		private handler: BotHandler,
		private workspaceStore: WorkspaceStore,
	) {}

	enqueueEvent(event: BotEvent): boolean {
		const pending = this.pendingBySession.get(event.channel) ?? 0;
		if (pending >= 5) {
			log.logWarning(`HTTP event queue full for ${event.channel}, discarding: ${event.text.substring(0, 50)}`);
			return false;
		}

		const session = this.workspaceStore.findSession(event.channel);
		if (!session) {
			log.logWarning(`HTTP event session not found: ${event.channel}`);
			return false;
		}

		this.pendingBySession.set(event.channel, pending + 1);
		void this.runEvent(event, session).finally(() => {
			const next = (this.pendingBySession.get(event.channel) ?? 1) - 1;
			if (next > 0) this.pendingBySession.set(event.channel, next);
			else this.pendingBySession.delete(event.channel);
		});
		return true;
	}

	private async runEvent(event: BotEvent, session: { id: string; workspaceId: string; createdBy: string }): Promise<void> {
		const workspaceRoot = this.workspaceStore.getWorkspaceRoot(session.workspaceId);
		const channelDir = join(workspaceRoot, "sessions", session.id);
		if (!existsSync(channelDir)) mkdirSync(channelDir, { recursive: true });

		const userId = session.createdBy || "web-user";
		appendFileSync(
			join(channelDir, "log.jsonl"),
			`${JSON.stringify({ date: new Date().toISOString(), ts: event.ts, user: event.user, userName: "Event", text: event.text, attachments: [], isBot: false, isEvent: true })}\n`,
		);

		const ctx = createHttpContext({
			channelId: session.id,
			userName: "Event",
			text: event.text,
			ts: event.ts,
			send: () => {},
			workingDir: workspaceRoot,
			userId,
			authFilePath: getUserAuthFilePath(userId),
		});

		log.logInfo(`[${session.id}] HTTP: Starting scheduled event: ${event.text.substring(0, 50)}`);
		try {
			await this.handler.handleEvent(session.id, ctx, true);
		} catch (err) {
			log.logWarning(`[${session.id}] HTTP event run error`, err instanceof Error ? err.message : String(err));
		}
	}
}

// ============================================================================
// Start
// ============================================================================

log.logStartup(workingDir, sandboxLabel(sandbox));

const stopSandboxIdleCleanup = startWorkspaceSandboxIdleCleanup(sandbox, {
	idleMs: parsePositiveIntEnv("CORE_SERVICE_SANDBOX_IDLE_MS", 30 * 60_000),
	intervalMs: parsePositiveIntEnv("CORE_SERVICE_SANDBOX_CLEANUP_INTERVAL_MS", 60_000),
	onLog: (message) => log.logInfo(message),
	onError: (message) => log.logWarning(message),
});
if (stopSandboxIdleCleanup) {
	log.logInfo("Managed sandbox idle cleanup enabled");
}

// Start HTTP SSE server if requested
if (hasHttp) {
	const httpServer = new HttpServer({
		port: httpPort!,
		workingDir,
		workspaceStore,
		sandboxConfig: sandbox,
		features: { agentWorkers: AGENT_WORKERS_ENABLED, reminders: REMINDERS_ENABLED },
		handler,
		//IYH1HC add: expose mirror state at GET /objectstore/status (undefined → ephemeral).
		getObjectStoreStatus: () => objectStore?.status(),
	});
	await httpServer.start(); //IYH1HC comment: await — start() is now async (auth storage bootstrap)
}

// Start event watchers for each adapter.
let eventsWatcher: ReturnType<typeof createEventsWatcher> | undefined;
let workspaceEventsWatcher: ReturnType<typeof createWorkspaceEventsWatcher> | undefined;

if (hasHttp && REMINDERS_ENABLED) {
	workspaceEventsWatcher = createWorkspaceEventsWatcher(workingDir, new HttpEventRouter(handler, workspaceStore));
	workspaceEventsWatcher.start();
}

if (hasSlack) {
	const sharedStore = new ChannelStore({ workingDir, botToken: MOM_SLACK_BOT_TOKEN! });

	const bot = new SlackBotClass(handler, {
		appToken: MOM_SLACK_APP_TOKEN,
		botToken: MOM_SLACK_BOT_TOKEN,
		workingDir,
		store: sharedStore,
	});

	if (REMINDERS_ENABLED) {
		eventsWatcher = createEventsWatcher(workingDir, bot);
		eventsWatcher.start();
	}

	bot.start();
}

//IYH1HC add: periodic full snapshot so changes between run-end snapshots (and any
//IYH1HC add: file written outside a run) reach the bucket. <=0 disables. The mirror
//IYH1HC add: serializes against run-end snapshots, so overlaps are safe.
//const snapshotIntervalMs = parsePositiveIntEnv("CORE_SERVICE_OBJECTSTORE_SNAPSHOT_INTERVAL_MS", 300_000);
let snapshotTimer: NodeJS.Timeout | undefined;
/* if (objectStore && snapshotIntervalMs > 0) {
	snapshotTimer = setInterval(() => {
		void objectStore ?.snapshot()
			.catch((err) => log.logWarning("[object-store] interval snapshot error", err instanceof Error ? err.message : String(err)));
	}, snapshotIntervalMs);
	snapshotTimer.unref?.();
	log.logInfo(`Object store snapshot interval enabled (${snapshotIntervalMs}ms)`);
} */

// Handle shutdown
//IYH1HC add: shared async shutdown so SIGINT/SIGTERM both flush a final snapshot
//IYH1HC add: (best-effort within CF's ~10s grace) before exiting.
async function shutdown(): Promise<void> {
	log.logInfo("Shutting down...");
	stopSandboxIdleCleanup?.();
	eventsWatcher?.stop();
	workspaceEventsWatcher?.stop();
	if (snapshotTimer) clearInterval(snapshotTimer);
	try {
		await objectStore?.snapshot();
	} catch (err) {
		log.logWarning("[object-store] shutdown snapshot error", err instanceof Error ? err.message : String(err));
	}
	process.exit(0);
}

process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
