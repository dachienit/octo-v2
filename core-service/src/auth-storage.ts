// Backend-neutral auth storage contract + shared helpers + adapter factory.
//
// auth.sqlite is fine for local/scratch development, but the Cloud Foundry
// container filesystem is ephemeral — so on BTP the user DB must live in a bound
// PostgreSQL service. This module defines a single async `AuthStorage` interface
// with two implementations (SQLite, PostgreSQL) and a factory that picks one at
// runtime from the environment. Selection order:
//   1. A bound PostgreSQL service in VCAP_SERVICES (CF / production)
//   2. DATABASE_URL env (Dockerized local on a Linux VM, dev-prod parity)
//   3. Fallback: SQLite at <dataRoot>/auth.sqlite (zero-config local)

import { createHash, pbkdf2Sync, randomBytes } from "crypto";

export interface AuthUser {
	id: string;
	email: string;
	displayName: string;
	avatarUrl?: string; // profile picture (e.g. GitHub avatar from SSO)
}

// Full user row (incl. password material) — used internally by verifyPassword
// and the federated-identity upsert. Column names are snake_case and identical
// across both adapters (each adapter SELECTs the same columns).
export type UserRow = {
	id: string;
	email: string;
	display_name: string | null;
	password_hash: string;
	password_salt: string;
	created_at: string;
	avatar_url?: string | null;
};

export type TokenUserRow = {
	id: string;
	email: string;
	display_name: string | null;
	expires_at: string;
	avatar_url?: string | null;
};

// Every method is async so a network-backed adapter (PostgreSQL) and a
// synchronous one (node:sqlite) share one contract.
export interface AuthStorage {
	init(): Promise<void>;

	userCount(): Promise<number>;
	createUser(opts: { email: string; password: string; displayName?: string }): Promise<AuthUser>;
	findUserByEmail(email: string): Promise<UserRow | undefined>;
	findUserById(id: string): Promise<AuthUser | undefined>;
	verifyPassword(email: string, password: string): Promise<AuthUser | undefined>;

	createToken(userId: string, ttlMs?: number): Promise<{ token: string; expiresAt: string }>;
	getUserByToken(token: string): Promise<AuthUser | undefined>;
	revokeToken(token: string): Promise<void>;

	findUserByFederated(provider: string, subject: string): Promise<AuthUser | undefined>;
	upsertFederatedUser(opts: {
		provider: string;
		subject: string;
		email: string;
		displayName?: string;
		avatarUrl?: string;
	}): Promise<AuthUser>;

	setProviderKey(userId: string, provider: string, encryptedKey: string): Promise<void>;
	hasProviderKey(userId: string, provider: string): Promise<boolean>;
	getProviderKey(userId: string, provider: string): Promise<string | undefined>;
	deleteProviderKey(userId: string, provider: string): Promise<void>;

	setActiveModels(userId: string, provider: string, modelIds: string[]): Promise<void>;
	getActiveModels(userId: string): Promise<Array<{ provider: string; modelId: string }>>;

	listCustomModels(userId: string): Promise<Array<{ id: string; name: string; baseProvider: string; endpoint: string }>>;
	getCustomModel(
		userId: string,
		id: string,
	): Promise<{ id: string; name: string; baseProvider: string; endpoint: string; encryptedKey: string } | undefined>;
	addCustomModel(
		userId: string,
		opts: { name: string; baseProvider: string; endpoint: string; encryptedKey: string },
	): Promise<string>;
	updateCustomModel(
		userId: string,
		id: string,
		opts: { name: string; baseProvider: string; endpoint: string; encryptedKey?: string },
	): Promise<void>;
	deleteCustomModel(userId: string, id: string): Promise<void>;
}

// ---------------------------------------------------------------------------
// Shared, dialect-independent helpers (used by both adapters).
// ---------------------------------------------------------------------------

export function createId(prefix: string): string {
	return `${prefix}_${Date.now().toString(36)}_${randomBytes(6).toString("hex")}`;
}

export function normalizeEmail(email: string): string {
	return email.trim().toLowerCase();
}

export function hashPassword(password: string, salt: string): string {
	return pbkdf2Sync(password, salt, 310_000, 32, "sha256").toString("base64url");
}

export function hashToken(token: string): string {
	return createHash("sha256").update(token).digest("base64url");
}

export function toAuthUser(
	row: Pick<UserRow, "id" | "email" | "display_name"> & { avatar_url?: string | null },
): AuthUser {
	return {
		id: row.id,
		email: row.email,
		displayName: row.display_name || row.email,
		avatarUrl: row.avatar_url || undefined,
	};
}

export const DEFAULT_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// Adapter selection.
// ---------------------------------------------------------------------------

export interface PgConnectionConfig {
	connectionString?: string;
	host?: string;
	port?: number;
	database?: string;
	user?: string;
	password?: string;
	ssl?: { ca?: string; rejectUnauthorized: boolean } | false;
}

// Detect a PostgreSQL target from the environment. Returns undefined when none
// is configured (→ caller falls back to SQLite). No-op-safe off CF.
export function detectPostgres(): PgConnectionConfig | undefined {
	const vcap = process.env.VCAP_SERVICES;
	if (vcap) {
		try {
			const services = JSON.parse(vcap) as Record<string, Array<{ credentials?: Record<string, unknown> }>>;
			// SAP PostgreSQL hyperscaler binds under the "postgresql-db" label.
			const creds = services["postgresql-db"]?.[0]?.credentials;
			if (creds) {
				// SAP credentials may ship the CA chain under sslrootcert or sslcert.
				const ca = (creds.sslrootcert as string) || (creds.sslcert as string) || undefined;
				const ssl = ca ? { ca, rejectUnauthorized: true } : { rejectUnauthorized: false };
				if (typeof creds.uri === "string" && creds.uri) {
					return { connectionString: creds.uri, ssl };
				}
				return {
					host: creds.hostname as string,
					port: creds.port ? Number(creds.port) : undefined,
					database: creds.dbname as string,
					user: creds.username as string,
					password: creds.password as string,
					ssl,
				};
			}
		} catch {
			// Malformed VCAP — fall through to DATABASE_URL / SQLite.
		}
	}

	const url = process.env.DATABASE_URL;
	if (url && url.trim()) {
		// Disable TLS for a plain local Postgres (Docker on the dev VM); require it
		// (without pinning a CA we cannot verify) for everything else.
		const isLocal = /@(localhost|127\.0\.0\.1)(:\d+)?\//.test(url);
		return { connectionString: url.trim(), ssl: isLocal ? false : { rejectUnauthorized: false } };
	}

	return undefined;
}

// Construct + initialize the appropriate storage adapter. Adapters are loaded
// dynamically so the unused driver is never imported (e.g. the `pg` package is
// not loaded for a pure-SQLite local run).
export async function createAuthStorage(opts: { dataRoot: string }): Promise<AuthStorage> {
	const pg = detectPostgres();
	if (pg) {
		const { PostgresAuthStorage } = await import("./auth-storage-pg.js");
		const store = new PostgresAuthStorage(pg);
		await store.init();
		//IYH1HC add: log the resolved target (no credentials) so the selected
		//IYH1HC add: backend is visible in `cf logs` after deploy.
		const target = pg.host && pg.database ? `${pg.host}/${pg.database}` : "connection string";
		console.log(`[auth-storage] backend: postgresql (${target})`);
		return store;
	}

	//IYH1HC add: NODE_ENV=production is set for octo-srv in mta.yaml, which is only
	//IYH1HC add: true when running on BTP CF. The container filesystem there is
	//IYH1HC add: ephemeral, so silently falling back to SQLite would lose all
	//IYH1HC add: users/tokens/provider keys on the next restart without anyone
	//IYH1HC add: noticing. Fail fast at startup instead.
	//IYH1HC add: temporary opt-out while octo-postgresql is not yet provisioned
	//IYH1HC add: (unpaid service on this landscape). Set CORE_SERVICE_AUTH_ALLOW_EPHEMERAL=true
	//IYH1HC add: in mta.yaml to accept SQLite (lost on restart) until A3 Postgres lands.
	//IYH1HC add: Remove this branch + the mta.yaml property together with re-enabling
	//IYH1HC add: the octo-postgresql resource (see plan project-octo-v2-b-y-gi-adaptive-fern.md, A3).
	const allowEphemeral = process.env.CORE_SERVICE_AUTH_ALLOW_EPHEMERAL === "true";
	if (process.env.NODE_ENV === "production" && !allowEphemeral) {
		//IYH1HC comment: original fail-fast throw, kept for when the flag is unset
		throw new Error(
			"[auth-storage] No PostgreSQL configuration found (VCAP_SERVICES['postgresql-db'] " +
				"binding or DATABASE_URL) while NODE_ENV=production. Refusing to start with an " +
				"ephemeral SQLite store — bind the 'octo-postgresql' service (see mta.yaml) before deploying.",
		);
	}
	//IYH1HC add: explicit, loud warning so the ephemeral tradeoff is visible in `cf logs`
	if (process.env.NODE_ENV === "production" && allowEphemeral) {
		console.warn(
			"[auth-storage] WARNING: running production with ephemeral SQLite (CORE_SERVICE_AUTH_ALLOW_EPHEMERAL=true). " +
				"Users/tokens/provider keys will be lost on restart/restage until octo-postgresql is bound.",
		);
	}

	const { SqliteAuthStorage } = await import("./auth-storage-sqlite.js");
	const store = new SqliteAuthStorage(opts.dataRoot);
	await store.init();
	//IYH1HC add: log the selected backend for parity with the postgresql branch above.
	console.log(`[auth-storage] backend: sqlite (${opts.dataRoot}/auth.sqlite)`);
	return store;
}
