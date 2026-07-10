/**
 * Append-only audit trail per session: trail.jsonl next to log.jsonl / context.jsonl.
 *
 * Unlike context.jsonl (rewritten on compaction) this file is never mutated, so it is
 * the source of truth for audit replay: exact tool durations, full un-truncated results,
 * skill invocations, usage and retry/compaction events all survive.
 *
 * `block/delta` events are NOT recorded — `block/end` carries the full content, which
 * keeps the file bounded while losing no data.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentTrailEvent } from "./agent-events.js";

export interface TrailRecord {
	ts: number;
	runId: string;
	event: AgentTrailEvent;
}

export class TrailStore {
	private readonly filePath: string;
	private readonly runId: string;

	constructor(sessionDir: string, runId: string) {
		if (!existsSync(sessionDir)) mkdirSync(sessionDir, { recursive: true });
		this.filePath = join(sessionDir, "trail.jsonl");
		this.runId = runId;
	}

	append(event: AgentTrailEvent): void {
		if (event.type === "block" && event.phase === "delta") return;
		const record: TrailRecord = { ts: Date.now(), runId: this.runId, event };
		try {
			appendFileSync(this.filePath, `${JSON.stringify(record)}\n`);
		} catch {
			// Audit writes must never break the live run.
		}
	}
}

/** Read all trail records for a session; returns [] when no trail exists. */
export function readTrail(sessionDir: string): TrailRecord[] {
	const filePath = join(sessionDir, "trail.jsonl");
	if (!existsSync(filePath)) return [];
	const records: TrailRecord[] = [];
	try {
		for (const line of readFileSync(filePath, "utf8").split("\n")) {
			const trimmed = line.trim();
			if (!trimmed) continue;
			try {
				records.push(JSON.parse(trimmed) as TrailRecord);
			} catch {
				// Skip malformed lines rather than failing the whole replay.
			}
		}
	} catch {
		return [];
	}
	return records;
}
