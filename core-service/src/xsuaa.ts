// XSUAA edge-auth support for SAP BTP Cloud Foundry.
//
// On BTP the approuter authenticates the user against XSUAA/IAS and forwards the
// XSUAA-issued JWT to this service as `Authorization: Bearer <jwt>`. This module
// validates that JWT (signature/issuer/expiry) using @sap/xssec against the bound
// `xsuaa` service credentials, then extracts a stable identity that the auth layer
// maps onto a local Octo user via the existing federated-identity mechanism.
//
// It is only active when MIRATI_STUDIO_EDGE_AUTH=xsuaa, so local/dev runs are unaffected
// and do not need the XSUAA binding present.

export interface XsuaaIdentity {
	provider: "xsuaa";
	subject: string;
	email: string;
	displayName?: string;
}

let initialized = false;
// Loaded lazily so the dependency is only touched in the XSUAA deployment path.
// biome-ignore lint/suspicious/noExplicitAny: @sap/xssec ships loose runtime types.
let xsuaaService: any | undefined;
// biome-ignore lint/suspicious/noExplicitAny: see above.
let createSecurityContext: ((service: any, options: { token: string }) => Promise<unknown>) | undefined;

export function isXsuaaEnabled(): boolean {
	return process.env.MIRATI_STUDIO_EDGE_AUTH === "xsuaa";
}

async function ensureService(): Promise<boolean> {
	if (initialized) return !!xsuaaService;
	initialized = true;
	if (!isXsuaaEnabled()) return false;
	try {
		// Indirect specifiers: these SAP packages ship without (full) types, so we
		// keep the import dynamic + untyped and only resolve them in the BTP path.
		const xsenvName = "@sap/xsenv";
		const xssecName = "@sap/xssec";
		const xsenv = await import(xsenvName);
		const xssec = await import(xssecName);
		// Read the bound xsuaa credentials from VCAP_SERVICES.
		const services = xsenv.getServices({ uaa: { label: "xsuaa" } });
		xsuaaService = new xssec.XsuaaService(services.uaa);
		createSecurityContext = xssec.createSecurityContext;
	} catch (err) {
		console.error("[xsuaa] failed to initialize XSUAA verification:", err instanceof Error ? err.message : err);
		xsuaaService = undefined;
	}
	return !!xsuaaService;
}

function decodeClaims(token: string): Record<string, unknown> | undefined {
	const parts = token.split(".");
	if (parts.length < 2) return undefined;
	try {
		return JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
	} catch {
		return undefined;
	}
}

/**
 * Validate an XSUAA JWT and return its identity claims, or undefined if the token
 * is not a valid XSUAA token (bad signature/issuer/expiry, or XSUAA not bound).
 */
export async function verifyXsuaaToken(token: string): Promise<XsuaaIdentity | undefined> {
	if (!(await ensureService()) || !createSecurityContext || !xsuaaService) return undefined;
	try {
		await createSecurityContext(xsuaaService, { token });
	} catch {
		return undefined;
	}
	const claims = decodeClaims(token);
	if (!claims) return undefined;
	// Stable subject: user_uuid (global SAP user id) → user_name → sub.
	const subject = String(claims.user_uuid || claims.user_name || claims.sub || "");
	if (!subject) return undefined;
	const email = String(claims.email || claims.user_name || "").trim();
	const given = String(claims.given_name || "").trim();
	const family = String(claims.family_name || "").trim();
	const displayName = [given, family].filter(Boolean).join(" ") || email || subject;
	return { provider: "xsuaa", subject, email, displayName };
}
