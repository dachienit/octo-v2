// Whole-tree durability for the data root via an S3-compatible Object Store
// (snapshot/restore mirror).
//
// On Cloud Foundry the container filesystem is ephemeral, so every file under the
// data root (auth.sqlite, users/, templates/, workspaces/**) is lost on
// restart/restage. There is no single chokepoint to intercept per-object writes
// (the sandbox executor writes files straight to the FS via bash/write tools, and
// the auth DB is a SQLite file touched by node:sqlite), so instead of an S3
// storage abstraction we mirror the whole data root:
//   - boot   → restore()  : download every object back onto the local FS
//   - run-end/interval/shutdown → snapshot() : upload changed files to the bucket
//
// Scope is the ENTIRE data root, not just sessions/artifacts. auth.sqlite is
// included so users/memberships/provider-keys survive a restart even before the
// durable PostgreSQL backend (A3 part 1) is provisioned. Excluded: SQLite
// sidecar/transient files (-wal/-shm), lock files, last_prompt debug snapshots,
// and the objectstore-tester's own octo/_tester/ keys.
//
// Selection mirrors auth-storage.ts detectPostgres(): a bound "objectstore"
// service in VCAP_SERVICES (CF), else OBJECT_STORE_* env (local/MinIO), else
// undefined → caller runs ephemeral. Single-writer only: do NOT scale octo-srv
// instances > 1 while the mirror is active (snapshots would overwrite each other,
// and delete-sync from one instance could wipe another instance's fresh writes).
//
// Trade-offs (accepted vs. the current "lose everything on restart" behavior):
//   - auth.sqlite is mirrored as a whole-file copy taken right after a
//     wal_checkpoint(TRUNCATE). A write landing between checkpoint and readFile
//     could yield a copy off by one transaction; PostgreSQL (A3 part 1) is the
//     correct long-term fix for the auth DB.
//   - A file created between two interval snapshots is lost if the app is
//     SIGKILLed (a normal SIGTERM flushes a final snapshot on shutdown).
//   - Delete-sync only runs once this process has successfully restored at boot,
//     so an ephemeral boot never deletes anything from the bucket.

import {
	DeleteObjectCommand,
	GetObjectCommand,
	HeadBucketCommand,
	ListObjectsV2Command,
	PutObjectCommand,
	S3Client,
} from "@aws-sdk/client-s3";
import { access, mkdir, readdir, readFile, stat, writeFile } from "fs/promises";
import { dirname, join, relative, sep } from "path";

export interface ObjectStoreConfig {
	bucket: string;
	region: string;
	/** Custom endpoint for S3-compatible stores (MinIO/SAP non-AWS); omit for real AWS. */
	endpoint?: string;
	accessKeyId: string;
	secretAccessKey: string;
}

// A snapshot of the mirror's runtime state, surfaced via GET /objectstore/status
// so operators can confirm the backend is live even after logs have rotated.
// Contains no secrets — only the bucket name and operation counters.
export interface ObjectStoreStatus {
	bucket: string;
	restoreCompleted: boolean;
	restoredCount: number;
	lastSnapshotAt?: string;
	lastSnapshotUploaded?: number;
	lastSnapshotDeleted?: number;
	lastError?: string;
}

// All mirrored keys live under this one bucket prefix so the dataset is easy to
// list and clean up. Keys are octo/<path-relative-to-dataRoot>, e.g.
// octo/auth.sqlite, octo/workspaces/<wsId>/sessions/<sid>/log.jsonl.
const KEY_PREFIX = "octo/";

// The objectstore-tester app writes its self-test keys under octo/_tester/. Never
// restore them onto our FS and never delete them during delete-sync.
const TESTER_PREFIX = "_tester/";

// Transient/working files that should never be mirrored (matched against the
// dataRoot-relative, forward-slash path).
const SKIP_FILE_PATTERNS = [/\.wal$/, /\.shm$/, /\.lock$/, /(^|[\\/])last_prompt\.jsonl$/];

// A relative path (e.g. "workspaces/ws_1/sessions/s_1/log.jsonl") that must not be
// mirrored — either a transient file or the tester's reserved subtree.
function shouldSkip(relPath: string): boolean {
	if (relPath.startsWith(TESTER_PREFIX)) return true;
	return SKIP_FILE_PATTERNS.some((re) => re.test(relPath));
}

// Detect an Object Store target from the environment. Returns undefined when none
// is configured (→ caller runs ephemeral). No-op-safe off CF.
export function detectObjectStore(): ObjectStoreConfig | undefined {
	const vcap = process.env.VCAP_SERVICES;
	if (vcap) {
		try {
			const services = JSON.parse(vcap) as Record<
				string,
				Array<{ instance_name?: string; name?: string; credentials?: Record<string, unknown> }>
			>;
			// The service *offering* label is "objectstore" (not the instance name
			// "taf-objectstore"). Prefer the taf-objectstore instance if several bind.
			const bindings = services["objectstore"] ?? [];
			const chosen =
				bindings.find((b) => b.instance_name === "taf-objectstore" || b.name === "taf-objectstore") ?? bindings[0];
			const creds = chosen?.credentials;
			if (creds) {
				// SAP Object Store on AWS ships AWS S3 keys. Other hyperscalers
				// (Azure/GCP) use a different shape — verify `cf env octo-srv` and
				// extend this mapping if the landscape is not AWS.
				const bucket = (creds.bucket as string) || (creds.bucket_name as string);
				const accessKeyId = (creds.access_key_id as string) || (creds.accessKeyId as string);
				const secretAccessKey = (creds.secret_access_key as string) || (creds.secretAccessKey as string);
				const region = (creds.region as string) || "us-east-1";
				const host = (creds.host as string) || (creds.uri as string) || undefined;
				const endpoint = host ? (host.startsWith("http") ? host : `https://${host}`) : undefined;
				if (bucket && accessKeyId && secretAccessKey) {
					return { bucket, region, endpoint, accessKeyId, secretAccessKey };
				}
			}
		} catch {
			// Malformed VCAP — fall through to OBJECT_STORE_* / undefined.
		}
	}

	// Env fallback for local/MinIO testing.
	const bucket = process.env.OBJECT_STORE_BUCKET;
	const accessKeyId = process.env.OBJECT_STORE_ACCESS_KEY_ID;
	const secretAccessKey = process.env.OBJECT_STORE_SECRET_ACCESS_KEY;
	if (bucket && accessKeyId && secretAccessKey) {
		return {
			bucket,
			region: process.env.OBJECT_STORE_REGION || "us-east-1",
			endpoint: process.env.OBJECT_STORE_ENDPOINT || undefined,
			accessKeyId,
			secretAccessKey,
		};
	}

	return undefined;
}

interface FileStamp {
	mtimeMs: number;
	size: number;
}

export class ObjectStoreMirror {
	private readonly client: S3Client;
	private readonly bucket: string;
	private readonly dataRoot: string;
	// Per-file stamp of the last successfully uploaded version — lets snapshot()
	// skip unchanged files. In-memory only (rebuilt over the process lifetime).
	private readonly uploaded = new Map<string, FileStamp>();
	// Serializes snapshots so a run-end, interval, and shutdown snapshot never
	// overlap (which would race on the same keys). Each call chains after the last.
	private snapshotChain: Promise<void> = Promise.resolve();
	// Becomes true once restore() finishes. Delete-sync is gated on this so an
	// ephemeral boot (restore skipped/failed) can never wipe the bucket.
	private restoreCompleted = false;
	private restoredCount = 0;
	private lastSnapshotAt: string | undefined;
	private lastSnapshotUploaded = 0;
	private lastSnapshotDeleted = 0;
	private lastError: string | undefined;

	constructor(opts: { config: ObjectStoreConfig; dataRoot: string }) {
		this.bucket = opts.config.bucket;
		this.dataRoot = opts.dataRoot;
		this.client = new S3Client({
			region: opts.config.region,
			endpoint: opts.config.endpoint,
			// Path-style is the safe default for S3-compatible stores (MinIO, some
			// SAP endpoints). Real AWS accepts it too.
			forcePathStyle: true,
			credentials: {
				accessKeyId: opts.config.accessKeyId,
				secretAccessKey: opts.config.secretAccessKey,
			},
		});
	}

	get bucketName(): string {
		return this.bucket;
	}

	status(): ObjectStoreStatus {
		return {
			bucket: this.bucket,
			restoreCompleted: this.restoreCompleted,
			restoredCount: this.restoredCount,
			lastSnapshotAt: this.lastSnapshotAt,
			lastSnapshotUploaded: this.lastSnapshotUploaded,
			lastSnapshotDeleted: this.lastSnapshotDeleted,
			lastError: this.lastError,
		};
	}

	// Throws if the bucket is not reachable — used at boot to choose fail-fast vs
	// ephemeral.
	async verify(): Promise<void> {
		await this.client.send(new HeadBucketCommand({ Bucket: this.bucket }));
	}

	// Download every mirrored object back onto the local FS. Only files are
	// written; empty dirs are recreated by WorkspaceStore on demand.
	async restore(): Promise<void> {
		let continuationToken: string | undefined;
		let restored = 0;
		do {
			const res = await this.client.send(
				new ListObjectsV2Command({
					Bucket: this.bucket,
					Prefix: KEY_PREFIX,
					ContinuationToken: continuationToken,
				}),
			);
			for (const obj of res.Contents ?? []) {
				if (!obj.Key || obj.Key.endsWith("/")) continue;
				const rel = this.keyToRel(obj.Key);
				if (rel === undefined || shouldSkip(rel)) continue;
				const localPath = join(this.dataRoot, ...rel.split("/"));
				try {
					const got = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: obj.Key }));
					const body = got.Body as { transformToByteArray?: () => Promise<Uint8Array> } | undefined;
					if (!body?.transformToByteArray) continue;
					const bytes = await body.transformToByteArray();
					await mkdir(dirname(localPath), { recursive: true });
					await writeFile(localPath, bytes);
					// Seed the stamp so snapshot() doesn't immediately re-upload a file
					// we just downloaded.
					try {
						const st = await stat(localPath);
						this.uploaded.set(localPath, { mtimeMs: st.mtimeMs, size: st.size });
					} catch {
						// ignore stat failure
					}
					restored++;
				} catch (err) {
					console.warn(`[object-store] restore failed for ${obj.Key}:`, err instanceof Error ? err.message : err);
				}
			}
			continuationToken = res.IsTruncated ? res.NextContinuationToken : undefined;
		} while (continuationToken);
		this.restoredCount = restored;
		this.restoreCompleted = true;
		console.log(`[object-store] restored ${restored} file(s) from bucket ${this.bucket}`);
	}

	// Upload changed files. Default (no workspaceId) = full data root, followed by
	// delete-sync. A workspaceId limits to that workspace's subtree (run-end), with
	// no delete-sync. Best-effort: a single file error is logged, not thrown.
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
					const prev = this.uploaded.get(filePath);
					if (prev && prev.mtimeMs === st.mtimeMs && prev.size === st.size) continue;
					const bytes = await readFile(filePath);
					await this.client.send(
						new PutObjectCommand({ Bucket: this.bucket, Key: `${KEY_PREFIX}${rel}`, Body: bytes }),
					);
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
		if (isFull && this.restoreCompleted) deleted = await this.deleteSync();

		this.lastSnapshotAt = new Date().toISOString();
		this.lastSnapshotUploaded = uploaded;
		this.lastSnapshotDeleted = deleted;
		if (uploaded > 0 || deleted > 0) {
			const scope = opts?.workspaceId ? ` (${opts.workspaceId}${opts.sessionId ? `/${opts.sessionId}` : ""})` : "";
			console.log(`[object-store] snapshot uploaded ${uploaded}, deleted ${deleted} file(s)${scope}`);
		}
	}

	// Remove bucket keys whose local file no longer exists (file deleted locally).
	// Scoped to KEY_PREFIX, skips excluded/tester keys. Returns the count deleted.
	private async deleteSync(): Promise<number> {
		let continuationToken: string | undefined;
		let deleted = 0;
		do {
			const res = await this.client.send(
				new ListObjectsV2Command({
					Bucket: this.bucket,
					Prefix: KEY_PREFIX,
					ContinuationToken: continuationToken,
				}),
			);
			for (const obj of res.Contents ?? []) {
				if (!obj.Key || obj.Key.endsWith("/")) continue;
				const rel = this.keyToRel(obj.Key);
				if (rel === undefined || shouldSkip(rel)) continue;
				const localPath = join(this.dataRoot, ...rel.split("/"));
				if (await this.exists(localPath)) continue;
				try {
					await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: obj.Key }));
					this.uploaded.delete(localPath);
					deleted++;
				} catch (err) {
					const message = err instanceof Error ? err.message : String(err);
					console.warn(`[object-store] delete-sync failed for ${obj.Key}:`, message);
					this.lastError = message;
				}
			}
			continuationToken = res.IsTruncated ? res.NextContinuationToken : undefined;
		} while (continuationToken);
		return deleted;
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
			// Run-end: mirror the whole workspace subtree (workspace.json, members.json,
			// sessions/, artifacts/, events/, skills/) so membership and metadata stay
			// in sync, not just the session that just ran.
			return [join(this.dataRoot, "workspaces", opts.workspaceId)];
		}
		// Full snapshot: the entire data root (auth.sqlite, users/, templates/,
		// workspaces/**). walk() filters files; shouldSkip() filters transients.
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

	// octo/<rel> → <rel> (forward-slash, relative to dataRoot), or undefined if the
	// key is outside the mirrored prefix.
	private keyToRel(key: string): string | undefined {
		if (!key.startsWith(KEY_PREFIX)) return undefined;
		return key.slice(KEY_PREFIX.length);
	}
}
