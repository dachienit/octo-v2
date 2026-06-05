import { DatabaseSync } from "node:sqlite";
import { existsSync, mkdirSync } from "fs";
import { dirname, join } from "path";
import { pbkdf2Sync, randomBytes, timingSafeEqual, createHash } from "crypto";
import passport from "passport";
import { Strategy as LocalStrategy } from "passport-local";
import type express from "express";

export interface AuthUser {
	id: string;
	email: string;
	displayName: string;
	avatarUrl?: string; //IYH1HC add: profile picture (e.g. GitHub avatar from SSO)
}

declare global {
	namespace Express {
		interface User extends AuthUser {}
	}
}

type UserRow = {
	id: string;
	email: string;
	display_name: string | null;
	password_hash: string;
	password_salt: string;
	created_at: string;
	avatar_url?: string | null; //IYH1HC add
};

type TokenUserRow = {
	id: string;
	email: string;
	display_name: string | null;
	expires_at: string;
	avatar_url?: string | null; //IYH1HC add
};

function createId(prefix: string): string {
	return `${prefix}_${Date.now().toString(36)}_${randomBytes(6).toString("hex")}`;
}

function sqlString(value: string): string {
	return `'${value.replace(/'/g, "''")}'`;
}

function normalizeEmail(email: string): string {
	return email.trim().toLowerCase();
}

function hashPassword(password: string, salt: string): string {
	return pbkdf2Sync(password, salt, 310_000, 32, "sha256").toString("base64url");
}

function hashToken(token: string): string {
	return createHash("sha256").update(token).digest("base64url");
}

function toAuthUser(row: Pick<UserRow, "id" | "email" | "display_name"> & { avatar_url?: string | null }): AuthUser {
	return {
		id: row.id,
		email: row.email,
		displayName: row.display_name || row.email,
		avatarUrl: row.avatar_url || undefined, //IYH1HC add
	};
}

export class AuthStore {
	readonly dbPath: string;
	private db: DatabaseSync;

	constructor(dataRoot: string) {
		this.dbPath = join(dataRoot, "auth.sqlite");
		mkdirSync(dirname(this.dbPath), { recursive: true });
		this.db = new DatabaseSync(this.dbPath);
		this.init();
	}

	private run(sql: string): void {
		this.db.exec(sql);
	}

	private all<T>(sql: string): T[] {
		const stmt = this.db.prepare(sql);
		return stmt.all() as T[];
	}

	private init(): void {
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
			-- IYH1HC add: external identity providers (e.g. GHES SSO) mapped to local users.
			-- SSO users live in the users table with empty password hash/salt (never password-loginnable).
			CREATE TABLE IF NOT EXISTS federated_identities (
				provider TEXT NOT NULL,
				subject TEXT NOT NULL,
				user_id TEXT NOT NULL,
				created_at TEXT NOT NULL,
				PRIMARY KEY (provider, subject),
				FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
			);
			CREATE INDEX IF NOT EXISTS idx_federated_identities_user_id ON federated_identities(user_id);
		`);
		this.ensureColumn("users", "avatar_url", "TEXT"); //IYH1HC add
	}

	//IYH1HC add: idempotent column migration for the already-created `users` table.
	private ensureColumn(table: string, column: string, type: string): void {
		const cols = this.all<{ name: string }>(`PRAGMA table_info(${table})`);
		if (!cols.some((c) => c.name === column)) {
			this.run(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
		}
	}

	userCount(): number {
		return Number(this.all<{ count: number }>("SELECT count(*) AS count FROM users")[0]?.count ?? 0);
	}

	createUser(opts: { email: string; password: string; displayName?: string }): AuthUser {
		const email = normalizeEmail(opts.email);
		if (!email || !opts.password) throw new Error("Email and password are required");
		if (opts.password.length < 8) throw new Error("Password must be at least 8 characters");
		const existing = this.findUserByEmail(email);
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

	findUserByEmail(email: string): UserRow | undefined {
		return this.all<UserRow>(`
			SELECT id, email, display_name, password_hash, password_salt, created_at, avatar_url
			FROM users
			WHERE email = ${sqlString(normalizeEmail(email))}
			LIMIT 1
		`)[0];
	}

	findUserById(id: string): AuthUser | undefined {
		const row = this.all<UserRow>(`
			SELECT id, email, display_name, password_hash, password_salt, created_at, avatar_url
			FROM users
			WHERE id = ${sqlString(id)}
			LIMIT 1
		`)[0];
		return row ? toAuthUser(row) : undefined;
	}

	verifyPassword(email: string, password: string): AuthUser | undefined {
		const user = this.findUserByEmail(email);
		if (!user) return undefined;
		const expected = Buffer.from(user.password_hash);
		const actual = Buffer.from(hashPassword(password, user.password_salt));
		if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return undefined;
		return toAuthUser(user);
	}

	createToken(userId: string, ttlMs = 30 * 24 * 60 * 60 * 1000): { token: string; expiresAt: string } {
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

	getUserByToken(token: string): AuthUser | undefined {
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
			this.revokeToken(token);
			return undefined;
		}
		return toAuthUser(row);
	}

	revokeToken(token: string): void {
		this.run(`DELETE FROM auth_tokens WHERE token_hash = ${sqlString(hashToken(token))}`);
	}

	//IYH1HC add: find a user previously linked to an external identity.
	findUserByFederated(provider: string, subject: string): AuthUser | undefined {
		const row = this.all<{ user_id: string }>(`
			SELECT user_id FROM federated_identities
			WHERE provider = ${sqlString(provider)} AND subject = ${sqlString(subject)}
			LIMIT 1
		`)[0];
		return row ? this.findUserById(row.user_id) : undefined;
	}

	//IYH1HC add: resolve (or provision) the local user for an external SSO identity.
	// Resolution order: (1) existing federated link, (2) link to an existing user
	// with the same email (corporate email is trusted/verified), (3) create a new
	// SSO-only user (empty password hash/salt → cannot password-login).
	upsertFederatedUser(opts: { provider: string; subject: string; email: string; displayName?: string; avatarUrl?: string }): AuthUser {
		const provider = opts.provider;
		const subject = opts.subject;
		const email = normalizeEmail(opts.email || "");
		const avatarUrl = opts.avatarUrl; //IYH1HC add

		const createdAt = new Date().toISOString();
		let userId: string;
		const linked = this.findUserByFederated(provider, subject);
		if (linked) {
			userId = linked.id;
		} else {
			const existing = email ? this.findUserByEmail(email) : undefined;
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

		//IYH1HC add: refresh the avatar on every login so it stays current.
		if (avatarUrl) {
			this.run(`UPDATE users SET avatar_url = ${sqlString(avatarUrl)} WHERE id = ${sqlString(userId)}`);
		}

		return this.findUserById(userId) ?? { id: userId, email, displayName: opts.displayName || email, avatarUrl };
	}
}

export class CoreServiceAuth {
	private readonly store: AuthStore;

	constructor(dataRoot: string) {
		this.store = new AuthStore(dataRoot);
		passport.use(new LocalStrategy({ usernameField: "email", passwordField: "password", session: false }, (email, password, done) => {
			try {
				const user = this.store.verifyPassword(email, password);
				return done(null, user || false, user ? undefined : { message: "Invalid email or password" });
			} catch (err) {
				return done(err);
			}
		}));
	}

	initialize(): express.Handler {
		return passport.initialize();
	}

	register(req: express.Request, res: express.Response): void {
		const allowSignup = process.env.CORE_SERVICE_ALLOW_SIGNUP !== "false" || this.store.userCount() === 0;
		if (!allowSignup) {
			res.status(403).json({ error: "Signup is disabled" });
			return;
		}
		const { email, password, displayName } = req.body as { email?: string; password?: string; displayName?: string };
		try {
			const user = this.store.createUser({ email: email || "", password: password || "", displayName });
			const session = this.store.createToken(user.id);
			this.setAuthCookie(res, session.token, session.expiresAt);
			res.status(201).json({ user, token: session.token, expiresAt: session.expiresAt });
		} catch (err) {
			res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
		}
	}

	login(req: express.Request, res: express.Response, next: express.NextFunction): void {
		passport.authenticate("local", { session: false }, (err: unknown, user?: AuthUser | false, info?: { message?: string }) => {
			if (err) return next(err);
			if (!user) {
				res.status(401).json({ error: info?.message || "Invalid email or password" });
				return;
			}
			const session = this.store.createToken(user.id);
			this.setAuthCookie(res, session.token, session.expiresAt);
			res.json({ user, token: session.token, expiresAt: session.expiresAt });
		})(req, res, next);
	}

	//IYH1HC add: complete an external SSO login — upsert the user, issue the
	// standard opaque session token, and set the auth cookie. Used by the SSO
	// callback so the rest of the app keeps using bearer/cookie auth unchanged.
	completeFederatedLogin(
		res: express.Response,
		identity: { provider: string; subject: string; email: string; displayName?: string; avatarUrl?: string },
	): { user: AuthUser; token: string; expiresAt: string } {
		const user = this.store.upsertFederatedUser(identity);
		const session = this.store.createToken(user.id);
		this.setAuthCookie(res, session.token, session.expiresAt);
		return { user, token: session.token, expiresAt: session.expiresAt };
	}

	logout(req: express.Request, res: express.Response): void {
		const token = this.extractBearerToken(req);
		if (token) this.store.revokeToken(token);
		res.setHeader("Set-Cookie", "pi_auth_token=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0");
		res.json({ ok: true });
	}

	me(req: express.Request, res: express.Response): void {
		res.json({ user: req.user });
	}

	requireAuth(req: express.Request, res: express.Response, next: express.NextFunction): void {
		const token = this.extractBearerToken(req);
		if (!token) {
			res.status(401).json({ error: "Authentication required" });
			return;
		}
		const user = this.store.getUserByToken(token);
		if (!user) {
			res.status(401).json({ error: "Invalid or expired token" });
			return;
		}
		req.user = user;
		next();
	}

	private extractBearerToken(req: express.Request): string | undefined {
		const header = req.header("Authorization");
		const match = header?.match(/^Bearer\s+(.+)$/i);
		if (match?.[1]) return match[1].trim();
		const cookie = req.header("Cookie") || "";
		const tokenCookie = cookie
			.split(";")
			.map((part) => part.trim())
			.find((part) => part.startsWith("pi_auth_token="));
		return tokenCookie ? decodeURIComponent(tokenCookie.slice("pi_auth_token=".length)) : undefined;
	}

	private setAuthCookie(res: express.Response, token: string, expiresAt: string): void {
		const maxAge = Math.max(0, Math.floor((new Date(expiresAt).getTime() - Date.now()) / 1000));
		res.setHeader(
			"Set-Cookie",
			`pi_auth_token=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}`,
		);
	}
}
