import { appendFileSync, existsSync, mkdirSync, readFileSync } from "fs";
import { join } from "path";

export type AcpJobStatus = "queued" | "running" | "completed" | "failed" | "cancelled";

export interface AcpJobSnapshot {
	id: string;
	workspaceRoot: string;
	sessionId: string;
	agent: string;
	task: string;
	cwd: string;
	status: AcpJobStatus;
	createdAt: string;
	updatedAt: string;
	startedAt?: string;
	finishedAt?: string;
	output?: string;
	error?: string;
	stopReason?: unknown;
}

interface AcpJobRecord extends AcpJobSnapshot {
	cancel?: () => void;
}

const jobs = new Map<string, AcpJobRecord>();

function createId(): string {
	return `acp_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function persist(job: AcpJobRecord): void {
	try {
		const dir = join(job.workspaceRoot, "orchestration");
		mkdirSync(dir, { recursive: true });
		const { cancel: _cancel, ...snapshot } = job;
		appendFileSync(join(dir, "acp-jobs.jsonl"), `${JSON.stringify(snapshot)}\n`, "utf-8");
	} catch {
		// Job registry must not fail tool execution because persistence failed.
	}
}

function snapshot(job: AcpJobRecord): AcpJobSnapshot {
	const { cancel: _cancel, ...rest } = job;
	return { ...rest };
}

export function createAcpJob(opts: {
	workspaceRoot: string;
	sessionId: string;
	agent: string;
	task: string;
	cwd: string;
	cancel?: () => void;
}): AcpJobSnapshot {
	const now = new Date().toISOString();
	const job: AcpJobRecord = {
		id: createId(),
		workspaceRoot: opts.workspaceRoot,
		sessionId: opts.sessionId,
		agent: opts.agent,
		task: opts.task,
		cwd: opts.cwd,
		status: "queued",
		createdAt: now,
		updatedAt: now,
		cancel: opts.cancel,
	};
	jobs.set(job.id, job);
	persist(job);
	return snapshot(job);
}

export function setAcpJobCancel(jobId: string, cancel: () => void): void {
	const job = jobs.get(jobId);
	if (!job) return;
	job.cancel = cancel;
}

export function updateAcpJob(jobId: string, patch: Partial<Omit<AcpJobSnapshot, "id" | "workspaceRoot" | "createdAt">>): AcpJobSnapshot | undefined {
	const job = jobs.get(jobId);
	if (!job) return undefined;
	Object.assign(job, patch, { updatedAt: new Date().toISOString() });
	persist(job);
	return snapshot(job);
}

export function listAcpJobs(workspaceRoot: string, sessionId?: string): AcpJobSnapshot[] {
	const fromMemory = [...jobs.values()]
		.filter((job) => job.workspaceRoot === workspaceRoot && (!sessionId || job.sessionId === sessionId))
		.map(snapshot);

	const byId = new Map(fromMemory.map((job) => [job.id, job]));
	const logPath = join(workspaceRoot, "orchestration", "acp-jobs.jsonl");
	if (existsSync(logPath)) {
		for (const line of readFileSync(logPath, "utf-8").split("\n")) {
			if (!line.trim()) continue;
			try {
				const job = JSON.parse(line) as AcpJobSnapshot;
				if (job.workspaceRoot === workspaceRoot && (!sessionId || job.sessionId === sessionId)) {
					byId.set(job.id, job);
				}
			} catch {
				// Ignore malformed history lines.
			}
		}
	}
	return [...byId.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export function cancelAcpJob(workspaceRoot: string, jobId: string): boolean {
	const job = jobs.get(jobId);
	if (!job || job.workspaceRoot !== workspaceRoot) return false;
	if (job.status !== "queued" && job.status !== "running") return false;
	job.cancel?.();
	updateAcpJob(jobId, { status: "cancelled", finishedAt: new Date().toISOString() });
	return true;
}
