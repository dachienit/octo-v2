import { spawn } from "child_process";
//IYH1HC add: Node fs/path APIs for cross-platform file I/O on the host
import { mkdir, readFile as fsReadFile, writeFile as fsWriteFile } from "node:fs/promises";
import { dirname, isAbsolute, posix, resolve } from "node:path";
import { spawn, type ChildProcessWithoutNullStreams } from "child_process";

export type ContainerRuntime = "docker" | "podman";
export type SandboxConfig = { type: "host" } | {
	type: ContainerRuntime;
	container?: string;
	workspacePath?: string;
	usersPath?: string;
};

export function parseSandboxArg(value: string): SandboxConfig {
	if (value === "host") {
		return { type: "host" };
	}
	for (const runtime of ["docker", "podman"] as const) {
		if (value === runtime) return { type: runtime };
		const prefix = `${runtime}:`;
		if (!value.startsWith(prefix)) continue;
		const container = value.slice(prefix.length);
		if (!container) {
			console.error(`Error: ${runtime} sandbox requires container name (e.g., ${runtime}:octo-sandbox)`);
			process.exit(1);
		}
		return { type: runtime, container };
	}
	console.error(`Error: Invalid sandbox type '${value}'. Use 'host', 'docker', 'podman', 'docker:<container-name>', or 'podman:<container-name>'`);
	process.exit(1);
}

export async function validateSandbox(config: SandboxConfig): Promise<void> {
	if (config.type === "host") {
		return;
	}

	try {
		await execSimple(config.type, ["--version"]);
	} catch {
		console.error(`Error: ${runtimeLabel(config.type)} is not installed or not in PATH`);
		process.exit(1);
	}

	if (!config.container) {
		console.log(`  ${runtimeLabel(config.type)} runtime is available; workspace containers will start on demand.`);
		return;
	}

	try {
		const result = await execSimple(config.type, ["inspect", "-f", "{{.State.Running}}", config.container]);
		if (result.trim() !== "true") {
			console.error(`Error: Container '${config.container}' is not running.`);
			console.error(`Start it with: ${config.type} start ${config.container}`);
			process.exit(1);
		}
	} catch {
		console.error(`Error: Container '${config.container}' does not exist.`);
		console.error(`Create it with: ./${config.type}.sh create <data-dir>`);
		process.exit(1);
	}

	console.log(`  ${runtimeLabel(config.type)} container '${config.container}' is running.`);
}

function execSimple(cmd: string, args: string[]): Promise<string> {
	return new Promise((resolve, reject) => {
		const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
		let stdout = "";
		let stderr = "";
		child.stdout?.on("data", (d) => {
			stdout += d;
		});
		child.stderr?.on("data", (d) => {
			stderr += d;
		});
		child.on("close", (code) => {
			if (code === 0) resolve(stdout);
			else reject(new Error(stderr || `Exit code ${code}`));
		});
	});
}

export function createExecutor(config: SandboxConfig, cwd?: string): Executor {
	if (config.type === "host") {
		return new HostExecutor(cwd);
	}
	if (!config.container) throw new Error(`${config.type} executor requires a resolved container name`);
	return new ContainerExecutor(config.type, config.container, cwd);
}

export interface Executor {
	exec(command: string, options?: ExecOptions): Promise<ExecResult>;
	spawn(command: string, args?: string[], options?: SpawnOptions): ChildProcessWithoutNullStreams;
	getWorkspacePath(hostPath: string): string;
	//IYH1HC add: sandbox-aware file I/O so tools never depend on a POSIX shell.
	// Host: Node fs (cross-platform). Docker: shell commands inside the container.
	readFile(path: string): Promise<Buffer>;
	writeFile(path: string, content: string): Promise<void>;
}

export interface ExecOptions {
	timeout?: number;
	signal?: AbortSignal;
}

export interface SpawnOptions {
	cwd?: string;
	env?: Record<string, string>;
	signal?: AbortSignal;
}

export interface ExecResult {
	stdout: string;
	stderr: string;
	code: number;
}

class HostExecutor implements Executor {
	constructor(private cwd?: string) {}

	async exec(command: string, options?: ExecOptions): Promise<ExecResult> {
		return new Promise((resolve, reject) => {
			const isWin = process.platform === "win32";
			const shell = isWin ? "powershell" : "sh";
			const shellArgs = isWin ? ["-NoProfile", "-NonInteractive", "-Command"] : ["-c"];

			const child = spawn(shell, [...shellArgs, command], {
				cwd: this.cwd,
				detached: !isWin,
				stdio: ["ignore", "pipe", "pipe"],
			});

			let stdout = "";
			let stderr = "";
			let timedOut = false;

			const timeoutHandle =
				options?.timeout && options.timeout > 0
					? setTimeout(() => {
							timedOut = true;
							killProcessTree(child.pid!);
						}, options.timeout * 1000)
					: undefined;

			const onAbort = () => {
				if (child.pid) killProcessTree(child.pid);
			};

			if (options?.signal) {
				if (options.signal.aborted) {
					onAbort();
				} else {
					options.signal.addEventListener("abort", onAbort, { once: true });
				}
			}

			child.stdout?.on("data", (data) => {
				stdout += data.toString();
				if (stdout.length > 10 * 1024 * 1024) {
					stdout = stdout.slice(0, 10 * 1024 * 1024);
				}
			});

			child.stderr?.on("data", (data) => {
				stderr += data.toString();
				if (stderr.length > 10 * 1024 * 1024) {
					stderr = stderr.slice(0, 10 * 1024 * 1024);
				}
			});

			child.on("close", (code) => {
				if (timeoutHandle) clearTimeout(timeoutHandle);
				if (options?.signal) {
					options.signal.removeEventListener("abort", onAbort);
				}

				if (options?.signal?.aborted) {
					reject(new Error(`${stdout}\n${stderr}\nCommand aborted`.trim()));
					return;
				}

				if (timedOut) {
					reject(new Error(`${stdout}\n${stderr}\nCommand timed out after ${options?.timeout} seconds`.trim()));
					return;
				}

				resolve({ stdout, stderr, code: code ?? 0 });
			});
		});
	}

	getWorkspacePath(hostPath: string): string {
		return hostPath;
	}

	//IYH1HC add: cross-platform file I/O via Node fs (works on Windows + Linux host).
	private resolvePath(path: string): string {
		return isAbsolute(path) ? path : resolve(this.cwd ?? process.cwd(), path);
	}

	async readFile(path: string): Promise<Buffer> {
		return fsReadFile(this.resolvePath(path));
	}

	async writeFile(path: string, content: string): Promise<void> {
		const resolved = this.resolvePath(path);
		await mkdir(dirname(resolved), { recursive: true });
		await fsWriteFile(resolved, content, "utf-8");
	}
	spawn(command: string, args: string[] = [], options?: SpawnOptions): ChildProcessWithoutNullStreams {
		const child = spawn(command, args, {
			cwd: options?.cwd ?? this.cwd,
			env: { ...process.env, ...(options?.env ?? {}) },
			stdio: ["pipe", "pipe", "pipe"],
		});
		options?.signal?.addEventListener("abort", () => child.kill("SIGTERM"), { once: true });
		return child;
	}
}

class ContainerExecutor implements Executor {
	constructor(private runtime: ContainerRuntime, private container: string, private cwd?: string) {}

	async exec(command: string, options?: ExecOptions): Promise<ExecResult> {
		const wrappedCommand = this.cwd
			? `mkdir -p ${shellEscape(this.cwd)} && cd ${shellEscape(this.cwd)} && ${command}`
			: command;
		const containerCmd = `${this.runtime} exec ${this.container} sh -c ${shellEscape(wrappedCommand)}`;
		const hostExecutor = new HostExecutor();
		return hostExecutor.exec(containerCmd, options);
	}

	getWorkspacePath(_hostPath: string): string {
		return "/workspace";
	}

	//IYH1HC add: file I/O that runs *inside* the container so Docker isolation is preserved.
	// Relative paths resolve as POSIX against the container cwd (e.g. /workspace/artifacts).
	private resolvePath(path: string): string {
		return path.startsWith("/") ? path : posix.join(this.cwd ?? "/workspace", path);
	}

	async readFile(path: string): Promise<Buffer> {
		const resolved = this.resolvePath(path);
		// base64 keeps binary (e.g. images) intact across the shell boundary.
		const result = await this.exec(`base64 < ${shellEscape(resolved)}`);
		if (result.code !== 0) {
			throw new Error(result.stderr || `Failed to read file: ${path}`);
		}
		return Buffer.from(result.stdout.replace(/\s/g, ""), "base64");
	}

	async writeFile(path: string, content: string): Promise<void> {
		const resolved = this.resolvePath(path);
		const dir = posix.dirname(resolved);
		// Base64-encode on the host and decode in the container: avoids all shell
		// escaping/binary pitfalls (the b64 payload contains no shell metacharacters).
		const b64 = Buffer.from(content, "utf-8").toString("base64");
		const cmd = `mkdir -p ${shellEscape(dir)} && printf '%s' ${shellEscape(b64)} | base64 -d > ${shellEscape(resolved)}`;
		const result = await this.exec(cmd);
		if (result.code !== 0) {
			throw new Error(result.stderr || `Failed to write file: ${path}`);
		}
	}
	spawn(command: string, args: string[] = [], options?: SpawnOptions): ChildProcessWithoutNullStreams {
		const cwd = options?.cwd ?? this.cwd;
		const commandLine = [command, ...args].map(shellEscape).join(" ");
		const wrappedCommand = cwd
			? `mkdir -p ${shellEscape(cwd)} && cd ${shellEscape(cwd)} && exec ${commandLine}`
			: `exec ${commandLine}`;
		const containerArgs = ["exec", "-i"];
		for (const [key, value] of Object.entries(options?.env ?? {})) {
			containerArgs.push("--env", `${key}=${value}`);
		}
		containerArgs.push(this.container, "sh", "-c", wrappedCommand);
		const child = spawn(this.runtime, containerArgs, {
			stdio: ["pipe", "pipe", "pipe"],
		});
		options?.signal?.addEventListener("abort", () => child.kill("SIGTERM"), { once: true });
		return child;
	}
}

function runtimeLabel(runtime: ContainerRuntime): string {
	return runtime === "docker" ? "Docker" : "Podman";
}

function killProcessTree(pid: number): void {
	if (process.platform === "win32") {
		try {
			spawn("taskkill", ["/F", "/T", "/PID", String(pid)], {
				stdio: "ignore",
				detached: true,
			});
		} catch {
			// Ignore errors
		}
	} else {
		try {
			process.kill(-pid, "SIGKILL");
		} catch {
			try {
				process.kill(pid, "SIGKILL");
			} catch {
				// Process already dead
			}
		}
	}
}

function shellEscape(s: string): string {
	return `'${s.replace(/'/g, "'\\''")}'`;
}
