import { randomBytes } from "crypto";

// ============================================================================
// GitHub Enterprise Server (GHES) SSO — OAuth 2.0 Authorization Code flow.
//
// GHES is NOT an OIDC provider: there is no id_token. Identity is obtained by
// calling the REST API (/api/v3/user, /api/v3/user/emails) with the access
// token, then mapped to a federated identity and exchanged for an Octo session
// token. The access token is used only to read identity once, then discarded.
//
// Configure via env (see .env.example). Leave SSO_GITHUB_ENABLED unset/false to
// disable; loadSsoConfig() returns null and the SSO endpoints become inert.
// ============================================================================

export interface SsoConfig {
	provider: "github-ghes";
	label: string;
	clientId: string;
	clientSecret: string;
	baseUrl: string; // e.g. https://github.boschdevcloud.com
	apiBaseUrl: string; // e.g. https://github.boschdevcloud.com/api/v3
	redirectUri: string; // must match the OAuth App callback URL registered on GHES
	scopes: string; // space-separated; "read:user user:email" is enough for login
	postLoginRedirect: string; // where the browser lands after a successful login
}

export interface SsoIdentity {
	provider: string;
	subject: string; // stable per-user id (GitHub numeric user id)
	email: string;
	displayName: string;
	avatarUrl?: string; //IYH1HC add: GitHub user avatar (from /api/v3/user)
}

function trimTrailingSlash(value: string): string {
	return value.replace(/\/+$/, "");
}

/** Build the SSO config from env, or return null if disabled / incomplete. */
export function loadSsoConfig(): SsoConfig | null {
	if (process.env.SSO_GITHUB_ENABLED !== "true") return null;

	const baseUrl = trimTrailingSlash(process.env.SSO_GITHUB_BASE_URL || "https://github.boschdevcloud.com");
	const clientId = process.env.SSO_GITHUB_CLIENT_ID || "";
	const clientSecret = process.env.SSO_GITHUB_CLIENT_SECRET || "";
	const redirectUri = process.env.SSO_GITHUB_REDIRECT_URI || "http://localhost:3030/auth/sso/callback";

	if (!clientId || !clientSecret) {
		console.warn("[sso] SSO_GITHUB_ENABLED=true but SSO_GITHUB_CLIENT_ID/SECRET missing — SSO disabled");
		return null;
	}

	return {
		provider: "github-ghes",
		label: process.env.SSO_GITHUB_LABEL || "Bosch GitHub",
		clientId,
		clientSecret,
		baseUrl,
		apiBaseUrl: process.env.SSO_GITHUB_API_BASE_URL || `${baseUrl}/api/v3`,
		redirectUri,
		scopes: process.env.SSO_GITHUB_SCOPES || "read:user user:email",
		postLoginRedirect: trimTrailingSlash(process.env.SSO_POST_LOGIN_REDIRECT || "http://localhost:5173"),
	};
}

const STATE_TTL_MS = 10 * 60 * 1000;

type GithubUser = { id: number; login: string; name?: string | null; email?: string | null; avatar_url?: string | null };
type GithubEmail = { email: string; primary: boolean; verified: boolean };

/**
 * Stateful helper that owns the short-lived `state` values and performs the
 * code->token->identity exchange against a GHES instance.
 */
export class GithubSsoProvider {
	private readonly states = new Map<string, number>(); // state -> createdAt

	constructor(public readonly config: SsoConfig) {}

	/** Create a one-time state and the authorize URL to redirect the browser to. */
	createAuthorizeUrl(): string {
		this.pruneStates();
		const state = randomBytes(24).toString("base64url");
		this.states.set(state, Date.now());

		const params = new URLSearchParams({
			client_id: this.config.clientId,
			redirect_uri: this.config.redirectUri,
			scope: this.config.scopes,
			state,
			allow_signup: "false",
		});
		return `${this.config.baseUrl}/login/oauth/authorize?${params.toString()}`;
	}

	/** Validate and consume a state value returned on the callback. */
	consumeState(state: string | undefined): boolean {
		if (!state) return false;
		const createdAt = this.states.get(state);
		if (createdAt === undefined) return false;
		this.states.delete(state);
		return Date.now() - createdAt <= STATE_TTL_MS;
	}

	/** Exchange the authorization code for an access token, then read identity. */
	async resolveIdentity(code: string): Promise<SsoIdentity> {
		const accessToken = await this.exchangeCode(code);
		return this.fetchIdentity(accessToken);
	}

	private pruneStates(): void {
		const now = Date.now();
		for (const [state, createdAt] of this.states) {
			if (now - createdAt > STATE_TTL_MS) this.states.delete(state);
		}
	}

	private async exchangeCode(code: string): Promise<string> {
		const res = await fetch(`${this.config.baseUrl}/login/oauth/access_token`, {
			method: "POST",
			headers: { "Content-Type": "application/json", Accept: "application/json", "User-Agent": "octo-service" },
			body: JSON.stringify({
				client_id: this.config.clientId,
				client_secret: this.config.clientSecret,
				code,
				redirect_uri: this.config.redirectUri,
			}),
		});
		if (!res.ok) throw new Error(`GHES token exchange failed: HTTP ${res.status}`);
		const data = (await res.json()) as { access_token?: string; error?: string; error_description?: string };
		if (data.error || !data.access_token) {
			throw new Error(`GHES token exchange error: ${data.error_description || data.error || "no access_token"}`);
		}
		return data.access_token;
	}

	private async fetchIdentity(accessToken: string): Promise<SsoIdentity> {
		const headers = {
			Authorization: `Bearer ${accessToken}`,
			Accept: "application/vnd.github+json",
			"User-Agent": "octo-service",
		};

		const userRes = await fetch(`${this.config.apiBaseUrl}/user`, { headers });
		if (!userRes.ok) throw new Error(`GHES /user failed: HTTP ${userRes.status}`);
		const user = (await userRes.json()) as GithubUser;

		let email = user.email || "";
		if (!email) {
			// Primary email may not be public on the profile; read it explicitly.
			const emailRes = await fetch(`${this.config.apiBaseUrl}/user/emails`, { headers });
			if (emailRes.ok) {
				const emails = (await emailRes.json()) as GithubEmail[];
				email = emails.find((e) => e.primary && e.verified)?.email || emails.find((e) => e.verified)?.email || "";
			}
		}
		if (!email) email = `${user.login}@users.noreply.${new URL(this.config.baseUrl).hostname}`;

		return {
			provider: this.config.provider,
			subject: String(user.id),
			email: email.toLowerCase(),
			displayName: user.name || user.login,
			avatarUrl: user.avatar_url || undefined, //IYH1HC add
		};
	}
}
