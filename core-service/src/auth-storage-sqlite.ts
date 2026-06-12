// SQLite implementation of AuthStorage (node:sqlite, synchronous under the hood).
//
// This is the zero-config local/scratch backend. The method bodies are the
// battle-tested logic previously inlined in CoreServiceAuth's AuthStore; they
// stay synchronous (DatabaseSync) but expose the async AuthStorage signatures so
// the PostgreSQL adapter can share one contract.

import { DatabaseSync } from "node:sqlite";
import { existsSync, mkdirSync } from "fs";
import { dirname, join } from "path";
import { randomBytes, timingSafeEqual } from "crypto";
import {
	type AuthStorage,
	type AuthUser,
	createId,
	DEFAULT_TOKEN_TTL_MS,
	hashPassword,
	hashToken,
	normalizeEmail,
	toAuthUser,
	type TokenUserRow,
	type UserRow,
} from "./auth-storage.js";

function sqlString(value: string): string {
	return `'${value.replace(/'/g, "''")}'`;
}

export class SqliteAuthStorage implements AuthStorage {
	readonly dbPath: string;
	private db: DatabaseSync;

	constructor(dataRoot: string) {
		this.dbPath = join(dataRoot, "auth.sqlite");
		mkdirSync(dirname(this.dbPath), { recursive: true });
		this.db = new DatabaseSync(this.dbPath);
	}

	private run(sql: string): void {
		this.db.exec(sql);
	}

	private all<T>(sql: string): T[] {
		const stmt = this.db.prepare(sql);
		return stmt.all() as T[];
	}

	async init(): Promise<void> {
		if (!existsSync(this.dbPath)) mkdirSync(dirname(this.dbPath), { recursive: true });
		this.run(`
			PRAGMA journal_mode = WAL;
			CREATE TABLE IF NOT EXISTS users (
				id TEXT PRIMARY KEY,
				email TEXT UNIQUE NOT NULL,
				display_name TEXT,
				password_hash TEXT NOT NULL,
				password_salt TEXT NOT NULL,
				created_at TEXT NOT NULL
			);
			CREATE TABLE IF NOT EXISTS auth_tokens (
				token_hash TEXT PRIMARY KEY,
				user_id TEXT NOT NULL,
				created_at TEXT NOT NULL,
				expires_at TEXT NOT NULL,
				FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
			);
			CREATE INDEX IF NOT EXISTS idx_auth_tokens_user_id ON auth_tokens(user_id);
			CREATE INDEX IF NOT EXISTS idx_auth_tokens_expires_at ON auth_tokens(expires_at);
			CREATE TABLE IF NOT EXISTS federated_identities (
				provider TEXT NOT NULL,
				subject TEXT NOT NULL,
				user_id TEXT NOT NULL,
				created_at TEXT NOT NULL,
				PRIMARY KEY (provider, subject),
				FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
			);
			CREATE INDEX IF NOT EXISTS idx_federated_identities_user_id ON federated_identities(user_id);
			CREATE TABLE IF NOT EXISTS provider_keys (
				user_id TEXT NOT NULL,
				provider TEXT NOT NULL,
				encrypted_key TEXT NOT NULL,
				updated_at TEXT NOT NULL,
				PRIMARY KEY (user_id, provider),
				FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
			);
			CREATE TABLE IF NOT EXISTS active_models (
				user_id TEXT NOT NULL,
				provider TEXT NOT NULL,
				model_id TEXT NOT NULL,
				PRIMARY KEY (user_id, provider, model_id),
				FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
			);
			CREATE TABLE IF NOT EXISTS custom_models (
				id TEXT NOT NULL,
				user_id TEXT NOT NULL,
				name TEXT NOT NULL,
				base_provider TEXT NOT NULL,
				endpoint TEXT NOT NULL,
				encrypted_key TEXT NOT NULL,
				created_at TEXT NOT NULL,
				PRIMARY KEY (user_id, id),
				FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
			);
		`);
		this.ensureColumn("users", "avatar_url", "TEXT");
	}

	// Idempotent column migration for the already-created `users` table.
	private ensureColumn(table: string, column: string, type: string): void {
		const cols = this.all<{ name: string }>(`PRAGMA table_info(${table})`);
		if (!cols.some((c) => c.name === column)) {
			this.run(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
		}
	}

	async userCount(): Promise<number> {
		return Number(this.all<{ count: number }>("SELECT count(*) AS count FROM users")[0]?.count ?? 0);
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

		this.run(`
			INSERT INTO users (id, email, display_name, password_hash, password_salt, created_at)
			VALUES (${sqlString(id)}, ${sqlString(email)}, ${sqlString(displayName)}, ${sqlString(passwordHash)}, ${sqlString(salt)}, ${sqlString(createdAt)})
		`);
		return { id, email, displayName };
	}

	async findUserByEmail(email: string): Promise<UserRow | undefined> {
		return this.all<UserRow>(`
			SELECT id, email, display_name, password_hash, password_salt, created_at, avatar_url
			FROM users
			WHERE email = ${sqlString(normalizeEmail(email))}
			LIMIT 1
		`)[0];
	}

	async findUserById(id: string): Promise<AuthUser | undefined> {
		const row = this.all<UserRow>(`
			SELECT id, email, display_name, password_hash, password_salt, created_at, avatar_url
			FROM users
			WHERE id = ${sqlString(id)}
			LIMIT 1
		`)[0];
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
		this.run(`
			INSERT INTO auth_tokens (token_hash, user_id, created_at, expires_at)
			VALUES (${sqlString(tokenHash)}, ${sqlString(userId)}, ${sqlString(createdAt)}, ${sqlString(expiresAt)})
		`);
		return { token, expiresAt };
	}

	async getUserByToken(token: string): Promise<AuthUser | undefined> {
		const tokenHash = hashToken(token);
		const row = this.all<TokenUserRow>(`
			SELECT users.id, users.email, users.display_name, users.avatar_url, auth_tokens.expires_at
			FROM auth_tokens
			JOIN users ON users.id = auth_tokens.user_id
			WHERE auth_tokens.token_hash = ${sqlString(tokenHash)}
			LIMIT 1
		`)[0];
		if (!row) return undefined;
		if (new Date(row.expires_at).getTime() <= Date.now()) {
			await this.revokeToken(token);
			return undefined;
		}
		return toAuthUser(row);
	}

	async revokeToken(token: string): Promise<void> {
		this.run(`DELETE FROM auth_tokens WHERE token_hash = ${sqlString(hashToken(token))}`);
	}

	async findUserByFederated(provider: string, subject: string): Promise<AuthUser | undefined> {
		const row = this.all<{ user_id: string }>(`
			SELECT user_id FROM federated_identities
			WHERE provider = ${sqlString(provider)} AND subject = ${sqlString(subject)}
			LIMIT 1
		`)[0];
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
				this.run(`
					INSERT INTO users (id, email, display_name, password_hash, password_salt, created_at, avatar_url)
					VALUES (${sqlString(userId)}, ${sqlString(email || `${subject}@${provider}`)}, ${sqlString(displayName)}, '', '', ${sqlString(createdAt)}, ${avatarUrl ? sqlString(avatarUrl) : "NULL"})
				`);
			}
			this.run(`
				INSERT INTO federated_identities (provider, subject, user_id, created_at)
				VALUES (${sqlString(provider)}, ${sqlString(subject)}, ${sqlString(userId)}, ${sqlString(createdAt)})
			`);
		}

		// Refresh the avatar on every login so it stays current.
		if (avatarUrl) {
			this.run(`UPDATE users SET avatar_url = ${sqlString(avatarUrl)} WHERE id = ${sqlString(userId)}`);
		}

		return (await this.findUserById(userId)) ?? { id: userId, email, displayName: opts.displayName || email, avatarUrl };
	}

	async setProviderKey(userId: string, provider: string, encryptedKey: string): Promise<void> {
		const updatedAt = new Date().toISOString();
		this.run(`
			INSERT INTO provider_keys (user_id, provider, encrypted_key, updated_at)
			VALUES (${sqlString(userId)}, ${sqlString(provider)}, ${sqlString(encryptedKey)}, ${sqlString(updatedAt)})
			ON CONFLICT(user_id, provider) DO UPDATE SET
				encrypted_key = excluded.encrypted_key,
				updated_at = excluded.updated_at
		`);
	}

	async hasProviderKey(userId: string, provider: string): Promise<boolean> {
		const row = this.all<{ n: number }>(`
			SELECT count(*) AS n FROM provider_keys
			WHERE user_id = ${sqlString(userId)} AND provider = ${sqlString(provider)}
		`)[0];
		return Number(row?.n ?? 0) > 0;
	}

	async getProviderKey(userId: string, provider: string): Promise<string | undefined> {
		const row = this.all<{ encrypted_key: string }>(`
			SELECT encrypted_key FROM provider_keys
			WHERE user_id = ${sqlString(userId)} AND provider = ${sqlString(provider)}
			LIMIT 1
		`)[0];
		return row?.encrypted_key;
	}

	async deleteProviderKey(userId: string, provider: string): Promise<void> {
		this.run(`
			DELETE FROM provider_keys
			WHERE user_id = ${sqlString(userId)} AND provider = ${sqlString(provider)}
		`);
	}

	async setActiveModels(userId: string, provider: string, modelIds: string[]): Promise<void> {
		this.run(`
			DELETE FROM active_models
			WHERE user_id = ${sqlString(userId)} AND provider = ${sqlString(provider)}
		`);
		const unique = Array.from(new Set(modelIds.filter((id) => id && id.trim())));
		for (const modelId of unique) {
			this.run(`
				INSERT OR IGNORE INTO active_models (user_id, provider, model_id)
				VALUES (${sqlString(userId)}, ${sqlString(provider)}, ${sqlString(modelId)})
			`);
		}
	}

	async getActiveModels(userId: string): Promise<Array<{ provider: string; modelId: string }>> {
		return this.all<{ provider: string; model_id: string }>(`
			SELECT provider, model_id FROM active_models
			WHERE user_id = ${sqlString(userId)}
			ORDER BY provider, model_id
		`).map((row) => ({ provider: row.provider, modelId: row.model_id }));
	}

	async listCustomModels(userId: string): Promise<Array<{ id: string; name: string; baseProvider: string; endpoint: string }>> {
		return this.all<{ id: string; name: string; base_provider: string; endpoint: string }>(`
			SELECT id, name, base_provider, endpoint FROM custom_models
			WHERE user_id = ${sqlString(userId)}
			ORDER BY created_at
		`).map((row) => ({ id: row.id, name: row.name, baseProvider: row.base_provider, endpoint: row.endpoint }));
	}

	async getCustomModel(
		userId: string,
		id: string,
	): Promise<{ id: string; name: string; baseProvider: string; endpoint: string; encryptedKey: string } | undefined> {
		const row = this.all<{ id: string; name: string; base_provider: string; endpoint: string; encrypted_key: string }>(`
			SELECT id, name, base_provider, endpoint, encrypted_key FROM custom_models
			WHERE user_id = ${sqlString(userId)} AND id = ${sqlString(id)}
			LIMIT 1
		`)[0];
		if (!row) return undefined;
		return { id: row.id, name: row.name, baseProvider: row.base_provider, endpoint: row.endpoint, encryptedKey: row.encrypted_key };
	}

	async addCustomModel(
		userId: string,
		opts: { name: string; baseProvider: string; endpoint: string; encryptedKey: string },
	): Promise<string> {
		const id = createId("cm");
		const createdAt = new Date().toISOString();
		this.run(`
			INSERT INTO custom_models (id, user_id, name, base_provider, endpoint, encrypted_key, created_at)
			VALUES (${sqlString(id)}, ${sqlString(userId)}, ${sqlString(opts.name)}, ${sqlString(opts.baseProvider)}, ${sqlString(opts.endpoint)}, ${sqlString(opts.encryptedKey)}, ${sqlString(createdAt)})
		`);
		return id;
	}

	async updateCustomModel(
		userId: string,
		id: string,
		opts: { name: string; baseProvider: string; endpoint: string; encryptedKey?: string },
	): Promise<void> {
		const keyClause = opts.encryptedKey ? `, encrypted_key = ${sqlString(opts.encryptedKey)}` : "";
		this.run(`
			UPDATE custom_models SET
				name = ${sqlString(opts.name)},
				base_provider = ${sqlString(opts.baseProvider)},
				endpoint = ${sqlString(opts.endpoint)}${keyClause}
			WHERE user_id = ${sqlString(userId)} AND id = ${sqlString(id)}
		`);
	}

	async deleteCustomModel(userId: string, id: string): Promise<void> {
		this.run(`
			DELETE FROM custom_models
			WHERE user_id = ${sqlString(userId)} AND id = ${sqlString(id)}
		`);
	}
}
