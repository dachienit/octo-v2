/**
 * Bosch GenAI / Azure OpenAI gateway adapter.
 *
 * User-configured custom models (Bosch LLM Farm) point at a complete Azure OpenAI URL:
 *
 *   https://<host>/api/openai/deployments/<deployment>/chat/completions?api-version=<v>
 *
 * pi-ai's OpenAI client only accepts a `baseUrl` and then *always* appends
 * `/chat/completions`, while dropping any query string and sending the key as
 * `Authorization: Bearer`. Azure OpenAI instead requires:
 *   - the mandatory `?api-version=<v>` query parameter, and
 *   - the key in an `api-key` header (Bearer is reserved for Entra ID tokens).
 *
 * Without these the gateway returns "404 Resource not found".
 *
 * This module bridges the gap with a single globalThis.fetch interceptor (the same
 * pattern as the SAP AI Core adapter): for any request whose URL matches a
 * registered deployment base it appends the api-version query and moves the bearer
 * token into the api-key header. The request body and SSE response are untouched, so
 * pi-ai's regular openai-completions streaming (including tool calls) keeps working.
 */

interface BoschAzureTarget {
	apiVersion: string;
}

// Registered deployment bases (origin + path, without query and without the trailing
// /chat/completions that the OpenAI SDK re-appends) → their required api-version.
const registry = new Map<string, BoschAzureTarget>();
let installed = false;

/**
 * Normalise a user-supplied Azure OpenAI endpoint into the `baseUrl` that pi-ai's
 * OpenAI client should use, and register its api-version so the interceptor can
 * re-attach it at request time. Returns the normalised base URL.
 *
 * Non-Azure (no api-version) endpoints are returned unchanged and not registered —
 * a plain OpenAI-compatible gateway works with the standard baseUrl + Bearer flow.
 */
export function prepareBoschOpenAIEndpoint(endpoint: string): string {
	let url: URL;
	try {
		url = new URL(endpoint);
	} catch {
		return endpoint;
	}
	const apiVersion = url.searchParams.get("api-version") ?? undefined;
	url.search = "";
	// Strip the route the OpenAI SDK will append again, plus any trailing slashes.
	url.pathname = url.pathname.replace(/\/+$/, "").replace(/\/chat\/completions$/i, "");
	const base = `${url.origin}${url.pathname}`;
	if (apiVersion) {
		registry.set(base, { apiVersion });
		installBoschGenAIFetch();
	}
	return base;
}

function matchRegisteredBase(url: string): BoschAzureTarget | undefined {
	for (const [base, target] of registry) {
		if (url.startsWith(base)) return target;
	}
	return undefined;
}

function installBoschGenAIFetch(): void {
	if (installed) return;
	installed = true;

	const origFetch = globalThis.fetch;

	(globalThis as any).fetch = async function (
		input: string | Request | URL,
		init?: RequestInit,
	): Promise<Response> {
		const url: string | undefined =
			typeof input === "string"
				? input
				: input instanceof URL
					? input.href
					: (input as any)?.url;

		const target = url ? matchRegisteredBase(url) : undefined;
		if (!url || !target) {
			return origFetch.call(globalThis, input as any, init);
		}

		// 1. Ensure the mandatory api-version query parameter is present.
		let finalUrl = url;
		if (!/[?&]api-version=/.test(finalUrl)) {
			finalUrl += (finalUrl.includes("?") ? "&" : "?") + "api-version=" + encodeURIComponent(target.apiVersion);
		}

		// 2. Move the bearer token into the Azure `api-key` header.
		const headers = new Headers((init?.headers as Record<string, string> | undefined) ?? {});
		const auth = headers.get("authorization");
		if (auth) {
			headers.set("api-key", auth.replace(/^Bearer\s+/i, ""));
			headers.delete("authorization");
		}

		return origFetch(finalUrl, { ...init, headers });
	};
}
