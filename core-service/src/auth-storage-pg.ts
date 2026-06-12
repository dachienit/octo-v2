// PostgreSQL implementation of AuthStorage.
//
// This is the durable backend used on SAP BTP Cloud Foundry (bound
// postgresql-db service) and for dev-prod parity on a local/Dockerized Postgres
// (DATABASE_URL). Unlike the SQLite adapter it uses parameterized queries ($1)
// rather than string interpolation. The schema mirrors the SQLite one; column
// types stay TEXT (timestamps are ISO strings compared in JS) so both adapters
// produce identically-shaped rows.

import { Pool } from "pg";
import type { PoolConfig } from "pg";
import { randomBytes, timingSafeEqual } from "crypto";
import {
	type AuthStorage,
	type AuthUser,
	createId,
	DEFAULT_TOKEN_TTL_MS,
	hashPassword,
	hashToken,
	normalizeEmail,
	type PgConnectionConfig,
	toAuthUser,
	type TokenUserRow,
	type UserRow,
} from "./auth-storage.js";

export class PostgresAuthStorage implements AuthStorage {
	private pool: Pool;

	constructor(config: PgConnectionConfig) {
		const poolConfig: PoolConfig = {
			ssl: config.ssl,
		};
		if (config.connectionString) {
			poolConfig.connectionString = config.connectionString;
		} else {
			poolConfig.host = config.host;
			poolConfig.port = config.port;
			poolConfig.database = config.database;
			poolConfig.user = config.user;
			poolConfig.password = config.password;
		}
		this.pool = new Pool(poolConfig);
	}

	private async query<T>(sql: string, params: unknown[] = []): Promise<T[]> {
		const result = await this.pool.query(sql, params);
		return result.rows as T[];
	}

	async init(): Promise<void> {
		// Single multi-statement DDL batch (no parameters). Idempotent.
		await this.pool.query(`
			CREATE TABLE IF NOT EXISTS users (
				id TEXT PRIMARY KEY,
				email TEXT UNIQUE NOT NULL,
				display_name TEXT,
				password_hash TEXT NOT NULL,
				password_salt TEXT NOT NULL,
				created_at TEXT NOT NULL,
				avatar_url TEXT
			);
			CREATE TABLE IF NOT EXISTS auth_tokens (
				token_hash TEXT PRIMARY KEY,
				user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
				created_at TEXT NOT NULL,
				expires_at TEXT NOT NULL
			);
			CREATE INDEX IF NOT EXISTS idx_auth_tokens_user_id ON auth_tokens(user_id);
			CREATE INDEX IF NOT EXISTS idx_auth_tokens_expires_at ON auth_tokens(expires_at);
			CREATE TABLE IF NOT EXISTS federated_identities (
				provider TEXT NOT NULL,
				subject TEXT NOT NULL,
				user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
				created_at TEXT NOT NULL,
				PRIMARY KEY (provider, subject)
			);
			CREATE INDEX IF NOT EXISTS idx_federated_identities_user_id ON federated_identities(user_id);
			CREATE TABLE IF NOT EXISTS provider_keys (
				user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
				provider TEXT NOT NULL,
				encrypted_key TEXT NOT NULL,
				updated_at TEXT NOT NULL,
				PRIMARY KEY (user_id, provider)
			);
			CREATE TABLE IF NOT EXISTS active_models (
				user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
				provider TEXT NOT NULL,
				model_id TEXT NOT NULL,
				PRIMARY KEY (user_id, provider, model_id)
			);
			CREATE TABLE IF NOT EXISTS custom_models (
				id TEXT NOT NULL,
				user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
				name TEXT NOT NULL,
				base_provider TEXT NOT NULL,
				endpoint TEXT NOT NULL,
				encrypted_key TEXT NOT NULL,
				created_at TEXT NOT NULL,
				PRIMARY KEY (user_id, id)
			);
		`);
	}

	async userCount(): Promise<number> {
		const rows = await this.query<{ count: string }>("SELECT count(*) AS count FROM users");
		return Number(rows[0]?.count ?? 0);
	}

	async createUser(opts: { email: string; password: string; displayName?: string }): Promise<AuthUser> {
		const email = normalizeEmail(opts.email);
		if (!email || !opts.password) throw new Error("Email and password are required");
		if (opts.password.length < 8) throw new Error("Password must be at least 8 characters");
		const existing = await this.findUserByEmail(email);
		if (existing) throw new Error("User already exists");

		const id = createId("u");
		const salt = randomBytes(16).toString("base64url");
		const passwordHash = hashPassword(opts.password, salt);
		const displayName = opts.displayName?.trim() || email;
		const createdAt = new Date().toISOString();

		await this.query(
			`INSERT INTO users (id, email, display_name, password_hash, password_salt, created_at)
			 VALUES ($1, $2, $3, $4, $5, $6)`,
			[id, email, displayName, passwordHash, salt, createdAt],
		);
		return { id, email, displayName };
	}

	async findUserByEmail(email: string): Promise<UserRow | undefined> {
		return (
			await this.query<UserRow>(
				`SELECT id, email, display_name, password_hash, password_salt, created_at, avatar_url
				 FROM users WHERE email = $1 LIMIT 1`,
				[normalizeEmail(email)],
			)
		)[0];
	}

	async findUserById(id: string): Promise<AuthUser | undefined> {
		const row = (
			await this.query<UserRow>(
				`SELECT id, email, display_name, password_hash, password_salt, created_at, avatar_url
				 FROM users WHERE id = $1 LIMIT 1`,
				[id],
			)
		)[0];
		return row ? toAuthUser(row) : undefined;
	}

	async verifyPassword(email: string, password: string): Promise<AuthUser | undefined> {
		const user = await this.findUserByEmail(email);
		if (!user) return undefined;
		const expected = Buffer.from(user.password_hash);
		const actual = Buffer.from(hashPassword(password, user.password_salt));
		if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return undefined;
		return toAuthUser(user);
	}

	async createToken(userId: string, ttlMs = DEFAULT_TOKEN_TTL_MS): Promise<{ token: string; expiresAt: string }> {
		const token = randomBytes(32).toString("base64url");
		const tokenHash = hashToken(token);
		const createdAt = new Date().toISOString();
		const expiresAt = new Date(Date.now() + ttlMs).toISOString();
		await this.query(
			`INSERT INTO auth_tokens (token_hash, user_id, created_at, expires_at) VALUES ($1, $2, $3, $4)`,
			[tokenHash, userId, createdAt, expiresAt],
		);
		return { token, expiresAt };
	}

	async getUserByToken(token: string): Promise<AuthUser | undefined> {
		const tokenHash = hashToken(token);
		const row = (
			await this.query<TokenUserRow>(
				`SELECT users.id, users.email, users.display_name, users.avatar_url, auth_tokens.expires_at
				 FROM auth_tokens
				 JOIN users ON users.id = auth_tokens.user_id
				 WHERE auth_tokens.token_hash = $1 LIMIT 1`,
				[tokenHash],
			)
		)[0];
		if (!row) return undefined;
		if (new Date(row.expires_at).getTime() <= Date.now()) {
			await this.revokeToken(token);
			return undefined;
		}
		return toAuthUser(row);
	}

	async revokeToken(token: string): Promise<void> {
		await this.query(`DELETE FROM auth_tokens WHERE token_hash = $1`, [hashToken(token)]);
	}

	async findUserByFederated(provider: string, subject: string): Promise<AuthUser | undefined> {
		const row = (
			await this.query<{ user_id: string }>(
				`SELECT user_id FROM federated_identities WHERE provider = $1 AND subject = $2 LIMIT 1`,
				[provider, subject],
			)
		)[0];
		return row ? this.findUserById(row.user_id) : undefined;
	}

	async upsertFederatedUser(opts: {
		provider: string;
		subject: string;
		email: string;
		displayName?: string;
		avatarUrl?: string;
	}): Promise<AuthUser> {
		const provider = opts.provider;
		const subject = opts.subject;
		const email = normalizeEmail(opts.email || "");
		const avatarUrl = opts.avatarUrl;

		const createdAt = new Date().toISOString();
		let userId: string;
		const linked = await this.findUserByFederated(provider, subject);
		if (linked) {
			userId = linked.id;
		} else {
			const existing = email ? await this.findUserByEmail(email) : undefined;
			if (existing) {
				userId = existing.id;
			} else {
				userId = createId("u");
				const displayName = opts.displayName?.trim() || email || subject;
				await this.query(
					`INSERT INTO users (id, email, display_name, password_hash, password_salt, created_at, avatar_url)
					 VALUES ($1, $2, $3, '', '', $4, $5)`,
					[userId, email || `${subject}@${provider}`, displayName, createdAt, avatarUrl ?? null],
				);
			}
			await this.query(
				`INSERT INTO federated_identities (provider, subject, user_id, created_at) VALUES ($1, $2, $3, $4)`,
				[provider, subject, userId, createdAt],
			);
		}

		// Refresh the avatar on every login so it stays current.
		if (avatarUrl) {
			await this.query(`UPDATE users SET avatar_url = $1 WHERE id = $2`, [avatarUrl, userId]);
		}

		return (await this.findUserById(userId)) ?? { id: userId, email, displayName: opts.displayName || email, avatarUrl };
	}

	async setProviderKey(userId: string, provider: string, encryptedKey: string): Promise<void> {
		const updatedAt = new Date().toISOString();
		await this.query(
			`INSERT INTO provider_keys (user_id, provider, encrypted_key, updated_at)
			 VALUES ($1, $2, $3, $4)
			 ON CONFLICT (user_id, provider) DO UPDATE SET
				 encrypted_key = EXCLUDED.encrypted_key,
				 updated_at = EXCLUDED.updated_at`,
			[userId, provider, encryptedKey, updatedAt],
		);
	}

	async hasProviderKey(userId: string, provider: string): Promise<boolean> {
		const row = (
			await this.query<{ n: string }>(
				`SELECT count(*) AS n FROM provider_keys WHERE user_id = $1 AND provider = $2`,
				[userId, provider],
			)
		)[0];
		return Number(row?.n ?? 0) > 0;
	}

	async getProviderKey(userId: string, provider: string): Promise<string | undefined> {
		const row = (
			await this.query<{ encrypted_key: string }>(
				`SELECT encrypted_key FROM provider_keys WHERE user_id = $1 AND provider = $2 LIMIT 1`,
				[userId, provider],
			)
		)[0];
		return row?.encrypted_key;
	}

	async deleteProviderKey(userId: string, provider: string): Promise<void> {
		await this.query(`DELETE FROM provider_keys WHERE user_id = $1 AND provider = $2`, [userId, provider]);
	}

	async setActiveModels(userId: string, provider: string, modelIds: string[]): Promise<void> {
		await this.query(`DELETE FROM active_models WHERE user_id = $1 AND provider = $2`, [userId, provider]);
		const unique = Array.from(new Set(modelIds.filter((id) => id && id.trim())));
		for (const modelId of unique) {
			await this.query(
				`INSERT INTO active_models (user_id, provider, model_id) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
				[userId, provider, modelId],
			);
		}
	}

	async getActiveModels(userId: string): Promise<Array<{ provider: string; modelId: string }>> {
		const rows = await this.query<{ provider: string; model_id: string }>(
			`SELECT provider, model_id FROM active_models WHERE user_id = $1 ORDER BY provider, model_id`,
			[userId],
		);
		return rows.map((row) => ({ provider: row.provider, modelId: row.model_id }));
	}

	async listCustomModels(userId: string): Promise<Array<{ id: string; name: string; baseProvider: string; endpoint: string }>> {
		const rows = await this.query<{ id: string; name: string; base_provider: string; endpoint: string }>(
			`SELECT id, name, base_provider, endpoint FROM custom_models WHERE user_id = $1 ORDER BY created_at`,
			[userId],
		);
		return rows.map((row) => ({ id: row.id, name: row.name, baseProvider: row.base_provider, endpoint: row.endpoint }));
	}

	async getCustomModel(
		userId: string,
		id: string,
	): Promise<{ id: string; name: string; baseProvider: string; endpoint: string; encryptedKey: string } | undefined> {
		const row = (
			await this.query<{ id: string; name: string; base_provider: string; endpoint: string; encrypted_key: string }>(
				`SELECT id, name, base_provider, endpoint, encrypted_key FROM custom_models WHERE user_id = $1 AND id = $2 LIMIT 1`,
				[userId, id],
			)
		)[0];
		if (!row) return undefined;
		return { id: row.id, name: row.name, baseProvider: row.base_provider, endpoint: row.endpoint, encryptedKey: row.encrypted_key };
	}

	async addCustomModel(
		userId: string,
		opts: { name: string; baseProvider: string; endpoint: string; encryptedKey: string },
	): Promise<string> {
		const id = createId("cm");
		const createdAt = new Date().toISOString();
		await this.query(
			`INSERT INTO custom_models (id, user_id, name, base_provider, endpoint, encrypted_key, created_at)
			 VALUES ($1, $2, $3, $4, $5, $6, $7)`,
			[id, userId, opts.name, opts.baseProvider, opts.endpoint, opts.encryptedKey, createdAt],
		);
		return id;
	}

	async updateCustomModel(
		userId: string,
		id: string,
		opts: { name: string; baseProvider: string; endpoint: string; encryptedKey?: string },
	): Promise<void> {
		if (opts.encryptedKey) {
			await this.query(
				`UPDATE custom_models SET name = $1, base_provider = $2, endpoint = $3, encrypted_key = $4
				 WHERE user_id = $5 AND id = $6`,
				[opts.name, opts.baseProvider, opts.endpoint, opts.encryptedKey, userId, id],
			);
		} else {
			await this.query(
				`UPDATE custom_models SET name = $1, base_provider = $2, endpoint = $3 WHERE user_id = $4 AND id = $5`,
				[opts.name, opts.baseProvider, opts.endpoint, userId, id],
			);
		}
	}

	async deleteCustomModel(userId: string, id: string): Promise<void> {
		await this.query(`DELETE FROM custom_models WHERE user_id = $1 AND id = $2`, [userId, id]);
	}
}
