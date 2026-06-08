import { spawn } from "child_process";
import { createHash } from "crypto";
import { mkdirSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import type { SandboxConfig } from "@octo/core-agent";

type ContainerRuntime = "docker" | "podman";

const IMAGE = "octo/sandbox:local";
const CONTAINER_PREFIX = "octo-ws-";
const __dirname = dirname(fileURLToPath(import.meta.url));
const packageRoot = join(__dirname, "..");

const pending = new Map<string, Promise<SandboxConfig>>();
const usage = new Map<string, {
	runtime: ContainerRuntime;
	workspaceId: string;
	container: string;
	image: string;
	active: number;
	lastUsedAt: number;
}>();

export type WorkspaceSandboxStatus = {
	mode: "host" | "managed" | "fixed";
	runtime: "host" | ContainerRuntime;
	container?: string;
	image?: string;
	status: "host" | "runtime-missing" | "not-created" | "running" | "stopped" | "error";
	running: boolean;
	workspacePath: string;
	usersPath?: string;
	mounts: Array<{ host: string; container: string; mode: "rw" }>;
	error?: string;
};

export function isManagedSandbox(config: SandboxConfig): config is { type: ContainerRuntime } {
	return (config.type === "docker" || config.type === "podman") && !config.container;
}

export function markWorkspaceSandboxActive(config: SandboxConfig, opts: {
	workspaceId: string;
	image?: string;
}): void {
	if (!isManagedSandbox(config)) return;
	const entry = touchManagedWorkspace(config.type, opts.workspaceId, opts.image ?? IMAGE);
	entry.active += 1;
	entry.lastUsedAt = Date.now();
}

export function markWorkspaceSandboxIdle(config: SandboxConfig, opts: {
	workspaceId: string;
	image?: string;
}): void {
	if (!isManagedSandbox(config)) return;
	const entry = touchManagedWorkspace(config.type, opts.workspaceId, opts.image ?? IMAGE);
	entry.active = Math.max(0, entry.active - 1);
	entry.lastUsedAt = Date.now();
}

export function startWorkspaceSandboxIdleCleanup(config: SandboxConfig, opts?: {
	idleMs?: number;
	intervalMs?: number;
	onLog?: (message: string) => void;
	onError?: (message: string) => void;
}): (() => void) | undefined {
	if (!isManagedSandbox(config)) return undefined;
	const idleMs = opts?.idleMs ?? 30 * 60_000;
	const intervalMs = opts?.intervalMs ?? 60_000;
	if (idleMs <= 0 || intervalMs <= 0) return undefined;

	const cleanup = () => {
		void cleanupIdleWorkspaceSandboxes(config.type, idleMs, opts);
	};
	const timer = setInterval(cleanup, intervalMs);
	timer.unref?.();
	cleanup();
	return () => clearInterval(timer);
}

export async function getWorkspaceSandboxStatus(config: SandboxConfig, opts: {
	workspaceId: string;
	workspaceRoot: string;
	dataRoot: string;
	usersRoot: string;
	memberUserIds?: string[];
	image?: string;
}): Promise<WorkspaceSandboxStatus> {
	const image = opts.image ?? IMAGE;
	if (config.type === "host") {
		return {
			mode: "host",
			runtime: "host",
			status: "host",
			running: true,
			workspacePath: opts.workspaceRoot,
			mounts: [],
		};
	}

	const managed = !("container" in config) || !config.container;
	const runtime = config.type;
	const fixedContainer = "container" in config ? config.container : undefined;
	const container = managed ? workspaceContainerName(opts.workspaceId) : fixedContainer;
	if (!container) throw new Error(`${runtime} sandbox status requires a container name`);
	const workspacePath = managed ? "/workspace" : `/workspace/workspaces/${opts.workspaceId}`;
	const usersPath = managed ? "/users" : "/workspace/users";
	const mounts = managed
		? managedMounts({
			workspaceRoot: opts.workspaceRoot,
			usersRoot: opts.usersRoot,
			memberUserIds: opts.memberUserIds ?? [],
		})
		: [{ host: opts.dataRoot, container: "/workspace", mode: "rw" as const }];

	try {
		await run(runtime, ["--version"]);
	} catch (err) {
		return {
			mode: managed ? "managed" : "fixed",
			runtime,
			container,
			image,
			status: "runtime-missing",
			running: false,
			workspacePath,
			usersPath,
			mounts,
			error: err instanceof Error ? err.message : String(err),
		};
	}

	try {
		const exists = await commandSucceeds(runtime, ["container", "inspect", container]);
		if (!exists) {
			return {
				mode: managed ? "managed" : "fixed",
				runtime,
				container,
				image,
				status: "not-created",
				running: false,
				workspacePath,
				usersPath,
				mounts,
			};
		}
		const running = await inspectRunning(runtime, container);
		return {
			mode: managed ? "managed" : "fixed",
			runtime,
			container,
			image,
			status: running ? "running" : "stopped",
			running,
			workspacePath,
			usersPath,
			mounts,
		};
	} catch (err) {
		return {
			mode: managed ? "managed" : "fixed",
			runtime,
			container,
			image,
			status: "error",
			running: false,
			workspacePath,
			usersPath,
			mounts,
			error: err instanceof Error ? err.message : String(err),
		};
	}
}

export async function resolveWorkspaceSandbox(config: SandboxConfig, opts: {
	workspaceId: string;
	workspaceRoot: string;
	usersRoot: string;
	memberUserIds?: string[];
	image?: string;
}): Promise<SandboxConfig> {
	if (!isManagedSandbox(config)) return config;

	const image = opts.image ?? IMAGE;
	const memberHash = memberMountHash(opts.memberUserIds ?? []);
	const key = `${config.type}:${opts.workspaceId}:${image}:${memberHash}`;
	const existing = pending.get(key);
	if (existing) return existing;

	const promise = ensureWorkspaceContainer(config.type, { ...opts, image, memberUserIds: opts.memberUserIds ?? [] })
		.finally(() => pending.delete(key));
	pending.set(key, promise);
	return promise;
}

async function ensureWorkspaceContainer(runtime: ContainerRuntime, opts: {
	workspaceId: string;
	workspaceRoot: string;
	usersRoot: string;
	memberUserIds: string[];
	image: string;
}): Promise<SandboxConfig> {
	mkdirSync(opts.workspaceRoot, { recursive: true });
	mkdirSync(opts.usersRoot, { recursive: true });
	const container = workspaceContainerName(opts.workspaceId);
	const mounts = managedMounts(opts);
	for (const mount of mounts) mkdirSync(mount.host, { recursive: true });
	const memberHash = memberMountHash(opts.memberUserIds);
	await ensureImage(runtime, opts.image);

	let exists = await commandSucceeds(runtime, ["container", "inspect", container]);
	if (exists && await containerNeedsRecreate(runtime, container, memberHash, opts.image)) {
		const active = touchManagedWorkspace(runtime, opts.workspaceId, opts.image).active;
		if (active === 0) {
			await run(runtime, ["rm", "-f", container]);
			exists = false;
		}
	}
	if (!exists) {
		await run(runtime, [
			"run",
			"-d",
			"--name",
			container,
			"--label",
			`octo.workspaceId=${opts.workspaceId}`,
			"--label",
			`octo.memberMountHash=${memberHash}`,
			"--label",
			`octo.sandboxImage=${opts.image}`,
			...mounts.flatMap((mount) => ["-v", `${mount.host}:${mount.container}`]),
			opts.image,
		]);
	} else {
		const running = await inspectRunning(runtime, container);
		if (!running) await run(runtime, ["start", container]);
	}
	touchManagedWorkspace(runtime, opts.workspaceId, opts.image).lastUsedAt = Date.now();

	return {
		type: runtime,
		container,
		workspacePath: "/workspace",
		usersPath: "/users",
	};
}

function workspaceContainerName(workspaceId: string): string {
	const safeId = workspaceId.toLowerCase().replace(/[^a-z0-9_.-]/g, "-");
	return `${CONTAINER_PREFIX}${safeId}`.slice(0, 63);
}

function safeUserPathSegment(userId: string): string {
	return userId.replace(/[^a-zA-Z0-9._-]/g, "_") || "web-user";
}

function uniqueSafeMemberUserIds(memberUserIds: string[]): string[] {
	return Array.from(new Set(memberUserIds.map(safeUserPathSegment))).sort();
}

function memberMountHash(memberUserIds: string[]): string {
	return createHash("sha256")
		.update(uniqueSafeMemberUserIds(memberUserIds).join("\n"))
		.digest("hex")
		.slice(0, 16);
}

function managedMounts(opts: {
	workspaceRoot: string;
	usersRoot: string;
	memberUserIds: string[];
}): Array<{ host: string; container: string; mode: "rw" }> {
	const mounts: Array<{ host: string; container: string; mode: "rw" }> = [
		{ host: opts.workspaceRoot, container: "/workspace", mode: "rw" },
	];
	for (const userId of uniqueSafeMemberUserIds(opts.memberUserIds)) {
		mounts.push({
			host: join(opts.usersRoot, userId),
			container: `/users/${userId}`,
			mode: "rw",
		});
	}
	return mounts;
}

async function containerNeedsRecreate(runtime: ContainerRuntime, container: string, memberHash: string, image: string): Promise<boolean> {
	const currentMemberHash = (await inspectLabel(runtime, container, "octo.memberMountHash")).trim();
	const currentImage = (await inspectLabel(runtime, container, "octo.sandboxImage")).trim();
	return currentMemberHash !== memberHash || currentImage !== image;
}

async function inspectLabel(runtime: ContainerRuntime, container: string, label: string): Promise<string> {
	const result = await run(runtime, ["inspect", "-f", `{{ index .Config.Labels "${label}" }}`, container]);
	return result.stdout.trim() === "<no value>" ? "" : result.stdout.trim();
}

function usageKey(runtime: ContainerRuntime, workspaceId: string, image: string): string {
	return `${runtime}:${workspaceId}:${image}`;
}

function touchManagedWorkspace(runtime: ContainerRuntime, workspaceId: string, image: string) {
	const key = usageKey(runtime, workspaceId, image);
	let entry = usage.get(key);
	if (!entry) {
		entry = {
			runtime,
			workspaceId,
			container: workspaceContainerName(workspaceId),
			image,
			active: 0,
			lastUsedAt: Date.now(),
		};
		usage.set(key, entry);
	}
	return entry;
}

async function cleanupIdleWorkspaceSandboxes(runtime: ContainerRuntime, idleMs: number, opts?: {
	onLog?: (message: string) => void;
	onError?: (message: string) => void;
}): Promise<void> {
	const now = Date.now();
	for (const [key, entry] of usage) {
		if (entry.runtime !== runtime) continue;
		if (entry.active > 0) continue;
		if (now - entry.lastUsedAt < idleMs) continue;
		try {
			const exists = await commandSucceeds(runtime, ["container", "inspect", entry.container]);
			if (!exists) {
				usage.delete(key);
				continue;
			}
			const running = await inspectRunning(runtime, entry.container);
			if (running) {
				await run(runtime, ["stop", entry.container]);
				opts?.onLog?.(`Stopped idle ${runtime} sandbox ${entry.container}`);
			}
			usage.delete(key);
		} catch (err) {
			opts?.onError?.(`Idle cleanup failed for ${entry.container}: ${err instanceof Error ? err.message : String(err)}`);
		}
	}
}

async function ensureImage(runtime: ContainerRuntime, image: string): Promise<void> {
	const hasImage = await commandSucceeds(runtime, ["image", "inspect", image]);
	if (hasImage) return;
	if (image !== IMAGE) throw new Error(`Sandbox image ${image} is not available. Build or pull it before starting this workspace.`);
	await run(runtime, [
		"build",
		"-f",
		join(packageRoot, "Dockerfile.sandbox"),
		"-t",
		image,
		packageRoot,
	]);
}

async function inspectRunning(runtime: ContainerRuntime, container: string): Promise<boolean> {
	const result = await run(runtime, ["inspect", "-f", "{{.State.Running}}", container]);
	return result.stdout.trim() === "true";
}

async function commandSucceeds(command: string, args: string[]): Promise<boolean> {
	try {
		await run(command, args);
		return true;
	} catch {
		return false;
	}
}

function run(command: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
	return new Promise((resolve, reject) => {
		const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
		let stdout = "";
		let stderr = "";

		child.stdout?.on("data", (chunk) => {
			stdout += chunk.toString();
		});
		child.stderr?.on("data", (chunk) => {
			stderr += chunk.toString();
		});
		child.on("error", reject);
		child.on("close", (code) => {
			if (code === 0) resolve({ stdout, stderr });
			else reject(new Error(stderr || `${command} ${args.join(" ")} exited with code ${code}`));
		});
	});
}
