// Whole-tree durability for the data root via the objectstore-service HTTP gateway.
//
// On Cloud Foundry the container filesystem is ephemeral, so every file under the
// data root (auth.sqlite, users/, workspaces/**) is lost on restart/restage
// (templates/ is excluded — regenerated from the bundled package on boot).
// We mirror the whole data root through the shared HTTP gateway
// (objectstore-service), which fronts the SAP Object Store bucket with its own binding:
//   - boot                → restore()  : download every object back onto the FS,
//                           before WorkspaceStore / auth.sqlite touch the data root
//   - SIGTERM / SIGINT    → snapshot() : full tree upload + delete-sync
//   - workspace refresh   → snapshot({ workspaceId }) : that workspace's subtree only
//
// octo holds no S3 credentials and binds no objectstore service; all object I/O is
// HTTP calls to the gateway with an x-api-key header.
//
// Keys are the fixed deployment prefix plus the dataRoot-relative path:
//   <CORE_SERVICE_OBJECTSTORE_PREFIX><rel>
//   e.g.  robert-bosch-gmbh-rb-bd-vn-hub-d-bt234d00/octo/auth.sqlite
// The prefix must match the scope bound to the gateway API key (403 otherwise).
//
// Single-writer: the whole prefix maps to one shared local data root. Do NOT scale
// octo-srv instances > 1 while the mirror is active — two instances would snapshot
// over each other. Delete-sync only runs once restore() has succeeded, so a failed
// restore never wipes the bucket.

import { access, mkdir, readdir, readFile, stat, writeFile } from "fs/promises";
import { dirname, join, relative, sep } from "path";

// A snapshot of the mirror's runtime state, surfaced via GET /objectstore/status
// so operators can confirm the backend is live even after logs have rotated.
// Contains no secrets — only the gateway/bucket label and operation counters.
export interface ObjectStoreStatus {
	bucket: string;
	prefix: string;
	restoreCompleted: boolean;
	restoredCount: number;
	lastSnapshotAt?: string;
	lastSnapshotUploaded?: number;
	lastSnapshotDeleted?: number;
	lastError?: string;
}

// The objectstore-tester app writes its self-test keys under <prefix>/_tester/. Never
// restore them onto our FS and never delete them during delete-sync.
const TESTER_PREFIX = "_tester/";

// Transient/working files that should never be mirrored (matched against the
// dataRoot-relative, forward-slash path).
const SKIP_FILE_PATTERNS = [/\.wal$/, /\.shm$/, /\.lock$/, /(^|[\\/])last_prompt\.jsonl$/];

//IYH1HC add: templates/ is regenerated from the bundled package templates on every
// boot (WorkspaceStore constructor) — never mirror it. Existing templates/** keys
// already in the bucket are intentionally left untouched (deleteSync also skips them).
const TEMPLATES_PREFIX = "templates/";

// A relative path (e.g. "workspaces/ws_1/sessions/s_1/log.jsonl") that must not be
// mirrored — either a transient file or the tester's reserved subtree.
function shouldSkip(relPath: string): boolean {
	if (relPath.startsWith(TESTER_PREFIX)) return true;
	if (relPath.startsWith(TEMPLATES_PREFIX)) return true; //IYH1HC add
	return SKIP_FILE_PATTERNS.some((re) => re.test(relPath));
}

// Normalize the fixed key prefix: strip surrounding whitespace and leading slashes,
// force exactly one trailing slash. Throws on empty — an empty prefix would mirror
// against the bucket root, which the prefix-scoped API key rejects anyway.
function normalizePrefix(raw: string): string {
	const clean = raw.trim().replace(/^\/+/, "").replace(/\/+$/, "");
	if (!clean) throw new Error("[object-store] CORE_SERVICE_OBJECTSTORE_PREFIX must not be empty");
	return `${clean}/`;
}

// Resolve the gateway store from the environment. Returns undefined when no gateway
// URL is configured (→ caller runs ephemeral). A gateway URL without a prefix is a
// config bug and throws — even with ALLOW_EPHEMERAL — rather than mirroring under a
// wrong/empty scope.
export function resolveObjectStoreGateway(dataRoot: string): ObjectStoreGateway | undefined {
	const gatewayUrl = process.env.CORE_SERVICE_OBJECTSTORE_GATEWAY_URL;
	if (!gatewayUrl) return undefined;
	const rawPrefix = process.env.CORE_SERVICE_OBJECTSTORE_PREFIX;
	if (!rawPrefix || !rawPrefix.trim()) {
		throw new Error(
			"[object-store] CORE_SERVICE_OBJECTSTORE_GATEWAY_URL is set but CORE_SERVICE_OBJECTSTORE_PREFIX is missing — " +
				"set it to the full key prefix bound to the gateway API key (e.g. \"robert-bosch-gmbh-rb-bd-vn-hub-d-bt234d00/cortex_studio/\").",
		);
	}
	return new ObjectStoreGateway({
		gatewayUrl,
		dataRoot,
		prefix: normalizePrefix(rawPrefix),
		apiKey: process.env.CORE_SERVICE_OBJECTSTORE_GATEWAY_API_KEY || undefined,
	});
}

interface FileStamp {
	mtimeMs: number;
	size: number;
}

interface GatewayListPage {
	objects?: Array<{ key?: string }>;
	nextToken?: string;
}

export class ObjectStoreGateway {
	private readonly gatewayUrl: string;
	private readonly apiKey: string | undefined;
	private readonly dataRoot: string;
	// The fixed key prefix every object lives under (normalized, trailing slash).
	private readonly prefix: string;
	// Per-file stamp of the last successfully uploaded version — lets snapshot()
	// skip unchanged files. In-memory only (rebuilt over the process lifetime).
	private readonly uploaded = new Map<string, FileStamp>();
	// Serializes snapshots so a refresh and shutdown snapshot never overlap
	// (which would race on the same keys). Each call chains after the last.
	private snapshotChain: Promise<void> = Promise.resolve();
	// Becomes true once restore() finishes. Delete-sync is gated on this so an
	// ephemeral boot (restore skipped/failed) can never wipe the bucket.
	private restoreCompleted = false;
	private restoredCount = 0;
	private lastSnapshotAt: string | undefined;
	private lastSnapshotUploaded = 0;
	private lastSnapshotDeleted = 0;
	private lastError: string | undefined;

	constructor(opts: { gatewayUrl: string; dataRoot: string; prefix: string; apiKey?: string }) {
		this.gatewayUrl = opts.gatewayUrl.replace(/\/+$/, "");
		this.apiKey = opts.apiKey;
		this.dataRoot = opts.dataRoot;
		this.prefix = opts.prefix;
	}

	get bucketName(): string {
		try {
			return `gateway:${new URL(this.gatewayUrl).host}`;
		} catch {
			return `gateway:${this.gatewayUrl}`;
		}
	}

	status(): ObjectStoreStatus {
		return {
			bucket: this.bucketName,
			prefix: this.prefix,
			restoreCompleted: this.restoreCompleted,
			restoredCount: this.restoredCount,
			lastSnapshotAt: this.lastSnapshotAt,
			lastSnapshotUploaded: this.lastSnapshotUploaded,
			lastSnapshotDeleted: this.lastSnapshotDeleted,
			lastError: this.lastError,
		};
	}

	// Throws if the gateway is not reachable/ready — used to choose fail-fast vs
	// ephemeral.
	async verify(): Promise<void> {
		const res = await this.gwFetch("/health", { method: "GET" });
		if (!res.ok) throw new Error(`gateway /health returned ${res.status}`);
		const data = (await res.json().catch(() => ({}))) as { ok?: boolean };
		if (!data.ok) throw new Error("gateway reports object store not bound (ok=false)");
	}

	// Download every mirrored object under the fixed prefix back onto the local FS.
	// Runs once at boot, before WorkspaceStore / auth.sqlite touch the data root.
	// Only files are written; empty dirs are recreated by WorkspaceStore on demand.
	async restore(): Promise<void> {
		const prefix = this.prefix;
		let restored = 0;
		for await (const key of this.listKeys(prefix)) {
			const rel = key.startsWith(prefix) ? key.slice(prefix.length) : undefined;
			if (rel === undefined || rel === "" || shouldSkip(rel)) continue;
			const localPath = join(this.dataRoot, ...rel.split("/"));
			try {
				const res = await this.gwFetch(`/objects/${encodeURIComponent(key)}`, { method: "GET" });
				if (res.status === 404) continue;
				if (!res.ok) throw new Error(`GET object returned ${res.status}`);
				const bytes = new Uint8Array(await res.arrayBuffer());
				await mkdir(dirname(localPath), { recursive: true });
				await writeFile(localPath, bytes);
				// Seed the stamp so snapshot() doesn't immediately re-upload a file we
				// just downloaded.
				try {
					const st = await stat(localPath);
					this.uploaded.set(localPath, { mtimeMs: st.mtimeMs, size: st.size });
				} catch {
					// ignore stat failure
				}
				restored++;
			} catch (err) {
				console.warn(`[object-store] restore failed for ${key}:`, err instanceof Error ? err.message : err);
			}
		}
		this.restoredCount = restored;
		this.restoreCompleted = true;
		console.log(`[object-store] restored ${restored} file(s) from ${prefix} via ${this.bucketName}`);
	}

	// Upload changed files. Default (no workspaceId) = full data root, followed by
	// delete-sync. A workspaceId limits to that workspace's subtree, with no
	// delete-sync. Best-effort: a single file error is logged, not thrown.
	// Serialized via chain.
	snapshot(opts?: { workspaceId?: string; sessionId?: string }): Promise<void> {
		const prev = this.snapshotChain;
		this.snapshotChain = (async () => {
			await prev.catch(() => {});
			await this.doSnapshot(opts);
		})();
		return this.snapshotChain;
	}

	private async doSnapshot(opts?: { workspaceId?: string; sessionId?: string }): Promise<void> {
		const prefix = this.prefix;
		const isFull = !opts?.workspaceId;
		// A full snapshot may copy auth.sqlite; checkpoint it first so the WAL is
		// folded back into the main file and the copy is self-contained.
		if (isFull) await this.checkpointAuthDb();

		const roots = this.resolveSnapshotRoots(opts);
		let uploaded = 0;
		for (const root of roots) {
			const files = await this.walk(root);
			for (const filePath of files) {
				const rel = relative(this.dataRoot, filePath).split(sep).join("/");
				if (shouldSkip(rel)) continue;
				try {
					const st = await stat(filePath);
					const prevStamp = this.uploaded.get(filePath);
					if (prevStamp && prevStamp.mtimeMs === st.mtimeMs && prevStamp.size === st.size) continue;
					const bytes = await readFile(filePath);
					const res = await this.gwFetch(`/objects/${encodeURIComponent(`${prefix}${rel}`)}`, {
						method: "PUT",
						body: bytes,
						headers: { "content-type": "application/octet-stream" },
					});
					if (!res.ok) throw new Error(`PUT object returned ${res.status}`);
					this.uploaded.set(filePath, { mtimeMs: st.mtimeMs, size: st.size });
					uploaded++;
				} catch (err) {
					const message = err instanceof Error ? err.message : String(err);
					console.warn(`[object-store] snapshot failed for ${rel}:`, message);
					this.lastError = message;
				}
			}
		}

		let deleted = 0;
		// Delete-sync only on a full snapshot, and only once this process has
		// restored — an ephemeral boot must never wipe the bucket.
		if (isFull && this.restoreCompleted) deleted = await this.deleteSync(prefix);

		this.lastSnapshotAt = new Date().toISOString();
		this.lastSnapshotUploaded = uploaded;
		this.lastSnapshotDeleted = deleted;
		if (uploaded > 0 || deleted > 0) {
			const scope = opts?.workspaceId ? ` (${opts.workspaceId}${opts.sessionId ? `/${opts.sessionId}` : ""})` : "";
			console.log(`[object-store] snapshot uploaded ${uploaded}, deleted ${deleted} file(s)${scope}`);
		}
	}

	// Remove bucket keys whose local file no longer exists (file deleted locally).
	// Scoped to the fixed prefix, skips excluded/tester keys. Returns the count deleted.
	private async deleteSync(prefix: string): Promise<number> {
		let deleted = 0;
		for await (const key of this.listKeys(prefix)) {
			const rel = key.startsWith(prefix) ? key.slice(prefix.length) : undefined;
			if (rel === undefined || rel === "" || shouldSkip(rel)) continue;
			const localPath = join(this.dataRoot, ...rel.split("/"));
			if (await this.exists(localPath)) continue;
			try {
				const res = await this.gwFetch(`/objects/${encodeURIComponent(key)}`, { method: "DELETE" });
				if (!res.ok && res.status !== 404) throw new Error(`DELETE object returned ${res.status}`);
				this.uploaded.delete(localPath);
				deleted++;
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				console.warn(`[object-store] delete-sync failed for ${key}:`, message);
				this.lastError = message;
			}
		}
		return deleted;
	}

	// Async-iterate every object key under a prefix, paging through the gateway's
	// nextToken. Skips folder-marker keys (ending in "/").
	private async *listKeys(prefix: string): AsyncGenerator<string> {
		let token: string | undefined;
		do {
			const params = new URLSearchParams({ prefix });
			if (token) params.set("token", token);
			const res = await this.gwFetch(`/objects?${params.toString()}`, { method: "GET" });
			if (!res.ok) throw new Error(`list objects returned ${res.status}`);
			const page = (await res.json()) as GatewayListPage;
			for (const obj of page.objects ?? []) {
				if (obj.key && !obj.key.endsWith("/")) yield obj.key;
			}
			token = page.nextToken;
		} while (token);
	}

	private gwFetch(path: string, init: RequestInit): Promise<Response> {
		const headers: Record<string, string> = { ...(init.headers as Record<string, string> | undefined) };
		if (this.apiKey) headers["x-api-key"] = this.apiKey;
		return fetch(`${this.gatewayUrl}${path}`, { ...init, headers });
	}

	// Fold the SQLite WAL back into auth.sqlite so a whole-file copy is consistent.
	// Best-effort: a missing DB or checkpoint error is logged, not thrown. Opens a
	// short-lived second connection (WAL mode permits this) and closes immediately.
	private async checkpointAuthDb(): Promise<void> {
		const dbPath = join(this.dataRoot, "auth.sqlite");
		if (!(await this.exists(dbPath))) return;
		try {
			// node:sqlite is experimental; import it lazily so its warning is only
			// emitted when an auth DB is actually present.
			const { DatabaseSync } = await import("node:sqlite");
			const db = new DatabaseSync(dbPath);
			try {
				db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
			} finally {
				db.close();
			}
		} catch (err) {
			console.warn("[object-store] auth.sqlite checkpoint failed:", err instanceof Error ? err.message : err);
		}
	}

	// Build the list of local directories to scan for a snapshot.
	private resolveSnapshotRoots(opts?: { workspaceId?: string; sessionId?: string }): string[] {
		if (opts?.workspaceId) {
			// Workspace refresh: mirror the whole workspace subtree (workspace.json,
			// members.json, sessions/, artifacts/, events/, skills/) so membership and
			// metadata stay in sync, not just the session being viewed.
			return [join(this.dataRoot, "workspaces", opts.workspaceId)];
		}
		// Full snapshot: the entire data root (auth.sqlite, users/, workspaces/**).
		// walk() filters files; shouldSkip() filters transients and templates/.
		return [this.dataRoot];
	}

	// Recursively list all file paths under dir. Missing dirs yield [].
	private async walk(dir: string): Promise<string[]> {
		let dirents;
		try {
			dirents = await readdir(dir, { withFileTypes: true });
		} catch {
			return [];
		}
		const out: string[] = [];
		for (const ent of dirents) {
			const full = join(dir, ent.name);
			if (ent.isDirectory()) {
				out.push(...(await this.walk(full)));
			} else if (ent.isFile()) {
				out.push(full);
			}
		}
		return out;
	}

	private async exists(path: string): Promise<boolean> {
		try {
			await access(path);
			return true;
		} catch {
			return false;
		}
	}
}
