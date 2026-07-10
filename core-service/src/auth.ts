//IYH1HC comment: the synchronous SQLite `AuthStore` previously defined here has been
//IYH1HC comment: relocated to ./auth-storage-sqlite.ts (SqliteAuthStorage) as part of the
//IYH1HC comment: auth.sqlite -> PostgreSQL refactor. CoreServiceAuth now talks to the
//IYH1HC comment: backend-neutral AuthStorage interface, selected at runtime by createAuthStorage
//IYH1HC comment: (PostgreSQL on BTP / via DATABASE_URL, SQLite locally). See ./auth-storage.ts.
import passport from "passport";
import { Strategy as LocalStrategy } from "passport-local";
import type express from "express";
import { isXsuaaEnabled, verifyXsuaaToken } from "./xsuaa.js"; //IYH1HC add: XSUAA edge auth on BTP
import { type AuthStorage, type AuthUser, createAuthStorage } from "./auth-storage.js"; //IYH1HC add

//IYH1HC add: AuthUser now lives in auth-storage.ts; re-export so existing importers of
//IYH1HC add: "./auth.js" keep working unchanged.
export type { AuthUser } from "./auth-storage.js";

declare global {
	namespace Express {
		interface User extends AuthUser {}
	}
}

export class CoreServiceAuth {
	//IYH1HC comment: private readonly store: AuthStore; — store is now an AuthStorage created asynchronously in init().
	private store!: AuthStorage; //IYH1HC add
	private readonly dataRoot: string; //IYH1HC add

	//IYH1HC add: expose the underlying store so the HTTP layer can read/write
	// per-user provider keys and active models.
	getStore(): AuthStorage {
		return this.store;
	}

	//IYH1HC comment: the constructor used to synchronously open SQLite and register the
	//IYH1HC comment: passport strategy; both now happen in the async init() below, because the
	//IYH1HC comment: PostgreSQL backend needs an awaited connection + schema bootstrap.
	constructor(dataRoot: string) {
		this.dataRoot = dataRoot; //IYH1HC add
	}

	//IYH1HC add: async bootstrap — must be awaited before serving requests. Selects the
	//IYH1HC add: storage backend (PostgreSQL/SQLite) and registers the passport strategy.
	async init(): Promise<void> {
		this.store = await createAuthStorage({ dataRoot: this.dataRoot });
		passport.use(
			new LocalStrategy(
				{ usernameField: "email", passwordField: "password", session: false },
				async (email, password, done) => {
					try {
						const user = await this.store.verifyPassword(email, password);
						return done(null, user || false, user ? undefined : { message: "Invalid email or password" });
					} catch (err) {
						return done(err);
					}
				},
			),
		);
	}

	initialize(): express.Handler {
		return passport.initialize();
	}

	//IYH1HC comment: register/login/completeFederatedLogin/logout are now async because the
	//IYH1HC comment: AuthStorage calls they make (createUser, createToken, ...) return promises.
	async register(req: express.Request, res: express.Response): Promise<void> {
		const allowSignup = process.env.CORE_SERVICE_ALLOW_SIGNUP !== "false" || (await this.store.userCount()) === 0; //IYH1HC comment: userCount() is now async
		if (!allowSignup) {
			res.status(403).json({ error: "Signup is disabled" });
			return;
		}
		const { email, password, displayName } = req.body as { email?: string; password?: string; displayName?: string };
		try {
			const user = await this.store.createUser({ email: email || "", password: password || "", displayName }); //IYH1HC comment: await
			const session = await this.store.createToken(user.id); //IYH1HC comment: await
			this.setAuthCookie(res, session.token, session.expiresAt);
			res.status(201).json({ user, token: session.token, expiresAt: session.expiresAt });
		} catch (err) {
			res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
		}
	}

	login(req: express.Request, res: express.Response, next: express.NextFunction): void {
		passport.authenticate("local", { session: false }, async (err: unknown, user?: AuthUser | false, info?: { message?: string }) => {
			if (err) return next(err);
			if (!user) {
				res.status(401).json({ error: info?.message || "Invalid email or password" });
				return;
			}
			const session = await this.store.createToken(user.id); //IYH1HC comment: await
			this.setAuthCookie(res, session.token, session.expiresAt);
			res.json({ user, token: session.token, expiresAt: session.expiresAt });
		})(req, res, next);
	}

	//IYH1HC add: complete an external SSO login — upsert the user, issue the
	// standard opaque session token, and set the auth cookie. Used by the SSO
	// callback so the rest of the app keeps using bearer/cookie auth unchanged.
	async completeFederatedLogin(
		res: express.Response,
		identity: { provider: string; subject: string; email: string; displayName?: string; avatarUrl?: string },
	): Promise<{ user: AuthUser; token: string; expiresAt: string }> {
		const user = await this.store.upsertFederatedUser(identity); //IYH1HC comment: await
		const session = await this.store.createToken(user.id); //IYH1HC comment: await
		this.setAuthCookie(res, session.token, session.expiresAt);
		return { user, token: session.token, expiresAt: session.expiresAt };
	}

	async logout(req: express.Request, res: express.Response): Promise<void> {
		const token = this.extractBearerToken(req);
		if (token) await this.store.revokeToken(token); //IYH1HC comment: await
		res.setHeader("Set-Cookie", "pi_auth_token=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0");
		res.json({ ok: true });
	}

	me(req: express.Request, res: express.Response): void {
		res.json({ user: req.user });
	}

	//IYH1HC add: cache (subject -> {user, expiry}) so a forwarded XSUAA JWT does not
	// re-validate + re-touch the DB on every single request.
	private xsuaaUserCache = new Map<string, { user: AuthUser; exp: number }>();

	//IYH1HC add: resolve (and cache) the local Octo user for a forwarded XSUAA JWT,
	// reusing the existing federated-identity upsert (provider = "xsuaa").
	private async resolveXsuaaUser(token: string): Promise<AuthUser | undefined> {
		const identity = await verifyXsuaaToken(token);
		if (!identity) return undefined;
		const cached = this.xsuaaUserCache.get(identity.subject);
		if (cached && cached.exp > Date.now()) return cached.user;
		const user = await this.store.upsertFederatedUser(identity); //IYH1HC comment: await
		this.xsuaaUserCache.set(identity.subject, { user, exp: Date.now() + 5 * 60_000 });
		return user;
	}

	//IYH1HC comment: requireAuth was synchronous (opaque token only); it is now async to
	//IYH1HC comment: validate a forwarded XSUAA JWT first when MIRATI_STUDIO_EDGE_AUTH=xsuaa.
	async requireAuth(req: express.Request, res: express.Response, next: express.NextFunction): Promise<void> {
		const token = this.extractBearerToken(req);
		if (!token) {
			res.status(401).json({ error: "Authentication required" });
			return;
		}
		//IYH1HC add: XSUAA edge auth — on BTP the bearer is the JWT forwarded by the approuter.
		if (isXsuaaEnabled()) {
			try {
				const xsuaaUser = await this.resolveXsuaaUser(token);
				if (xsuaaUser) {
					req.user = xsuaaUser;
					next();
					return;
				}
			} catch {
				// Not a valid XSUAA token — fall through to the opaque-token path below.
			}
		}
		const user = await this.store.getUserByToken(token); //IYH1HC comment: await
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
