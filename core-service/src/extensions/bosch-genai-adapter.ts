/**
 * Bosch GenAI / LLM Farm gateway adapter.
 *
 * User-configured custom models (Bosch LLM Farm) point at a complete gateway URL.
 * The farm exposes three flavours we bridge here (see "LLM Farm endpoint.txt"):
 *
 *   1. Azure OpenAI API (openai base provider):
 *        https://<host>/api/openai/deployments/<deployment>/chat/completions?api-version=<v>
 *   2. Vertex AI publisher endpoint, Google models (google base provider):
 *        https://<host>/api/google/v1/publishers/google/models/<model>:<method>
 *   3. Vertex AI publisher endpoint, Anthropic models (anthropic base provider):
 *        https://<host>/api/google/v1/publishers/anthropic/models/<model>:<method>
 *
 * All farm paths authenticate with `Authorization: Bearer <BMF_API_KEY>`.
 *
 * pi-ai's provider clients each speak their vendor's native protocol:
 *   - OpenAI client appends `/chat/completions`, drops the query string and sends
 *     `Authorization: Bearer`; Azure additionally requires the `api-version` query.
 *   - @google/genai builds `{baseUrl}/models/{model}:streamGenerateContent?alt=sse`
 *     (matching the farm path) but authenticates via the `x-goog-api-key` header.
 *   - The Anthropic SDK posts `{baseUrl}/v1/messages` with the model in the body and
 *     an `x-api-key` header, while Vertex expects
 *     `{base}/models/{model}:streamRawPredict` with `anthropic_version` in the body
 *     and no `model` field (same contract as @anthropic-ai/vertex-sdk).
 *
 * This module bridges the gaps with a single globalThis.fetch interceptor (the same
 * pattern as the SAP AI Core adapter): requests whose URL matches a registered base
 * get their URL/headers/body rewritten to the farm's expectations. SSE responses are
 * untouched — Vertex streams the same event format the SDKs already parse.
 */

//IYH1HC comment: interface BoschAzureTarget { apiVersion: string; }
//IYH1HC add: registry entries now cover all three LLM Farm flavours.
type BoschTarget =
	| { kind: "azure-openai"; apiVersion: string }
	| { kind: "vertex-google" }
	| { kind: "vertex-anthropic"; modelId?: string };

// Registered deployment bases (origin + path, without query and without the trailing
// route the SDK re-appends) → how the interceptor must rewrite matching requests.
const registry = new Map<string, BoschTarget>();
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
		registry.set(base, { kind: "azure-openai", apiVersion }); //IYH1HC comment: was { apiVersion }
		installBoschGenAIFetch();
	}
	return base;
}

//IYH1HC add: parse a Vertex publisher URL pasted from the farm docs. Tolerates an
// optional query, an optional ":method" suffix and an optional "/models/{id}" segment:
//   https://<host>/api/google/v1/publishers/{pub}/models/{model}:{method}
// Returns the base up to ".../publishers/{pub}" plus the extracted model id (if any).
function parseVertexPublisherEndpoint(endpoint: string): { base: string; modelId?: string } | undefined {
	let url: URL;
	try {
		url = new URL(endpoint);
	} catch {
		return undefined;
	}
	let path = url.pathname.replace(/\/+$/, "");
	// Strip the trailing ":method" (e.g. :generateContent, :streamRawPredict) if present.
	path = path.replace(/:[A-Za-z]+$/, "");
	const match = path.match(/^(.*\/publishers\/[^/]+)\/models\/([^/]+)$/);
	if (match) {
		return { base: `${url.origin}${match[1]}`, modelId: decodeURIComponent(match[2]!) };
	}
	return { base: `${url.origin}${path}` };
}

//IYH1HC add: Google models via the farm's Vertex publisher endpoint. @google/genai
// (with apiVersion "") already builds "{baseUrl}/models/{model}:streamGenerateContent"
// which matches the farm path — we only need to swap the auth header to Bearer.
export function prepareBoschGoogleEndpoint(endpoint: string): { baseUrl: string; modelId?: string } {
	const parsed = parseVertexPublisherEndpoint(endpoint);
	if (!parsed) return { baseUrl: endpoint };
	registry.set(parsed.base, { kind: "vertex-google" });
	installBoschGenAIFetch();
	return { baseUrl: parsed.base, modelId: parsed.modelId };
}

//IYH1HC add: Anthropic models via the farm's Vertex publisher endpoint. The Anthropic
// SDK posts to "{baseUrl}/v1/messages"; the interceptor rewrites that into the Vertex
// rawPredict form (URL method by stream flag, anthropic_version body field, Bearer auth).
export function prepareBoschAnthropicEndpoint(endpoint: string): { baseUrl: string; modelId?: string } {
	const parsed = parseVertexPublisherEndpoint(endpoint);
	if (!parsed) return { baseUrl: endpoint };
	registry.set(parsed.base, { kind: "vertex-anthropic", modelId: parsed.modelId });
	installBoschGenAIFetch();
	return { baseUrl: parsed.base, modelId: parsed.modelId };
}

function matchRegisteredBase(url: string): BoschTarget | undefined {
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

		const headers = new Headers((init?.headers as Record<string, string> | undefined) ?? {});

		if (target.kind === "azure-openai") {
			// 1. Ensure the mandatory api-version query parameter is present.
			let finalUrl = url;
			if (!/[?&]api-version=/.test(finalUrl)) {
				finalUrl += (finalUrl.includes("?") ? "&" : "?") + "api-version=" + encodeURIComponent(target.apiVersion);
			}

			// 2. Move the bearer token into the Azure `api-key` header.
			const auth = headers.get("authorization");
			if (auth) {
				headers.set("api-key", auth.replace(/^Bearer\s+/i, ""));
				headers.delete("authorization");
			}

			return origFetch(finalUrl, { ...init, headers });
		}

		//IYH1HC add: farm auth is a Bearer subscription key; @google/genai only sets x-goog-api-key.
		if (target.kind === "vertex-google") {
			const key = headers.get("x-goog-api-key");
			if (key && !headers.get("authorization")) {
				headers.set("authorization", `Bearer ${key}`);
			}
			console.log(`[bosch-genai] google → ${url}`); //IYH1HC add: wire-level proof of the model actually called
			return origFetch(url, { ...init, headers });
		}

		//IYH1HC add: rewrite the Anthropic Messages call into the Vertex rawPredict form.
		// target.kind === "vertex-anthropic"
		const key = headers.get("x-api-key");
		if (key) {
			headers.set("authorization", `Bearer ${key}`);
			headers.delete("x-api-key");
		}
		let finalUrl = url;
		let body = init?.body;
		const messagesIdx = url.indexOf("/v1/messages");
		if (messagesIdx >= 0 && typeof body === "string") {
			try {
				const payload = JSON.parse(body) as Record<string, unknown>;
				const model =
					typeof payload.model === "string" && payload.model ? payload.model : target.modelId;
				if (model) {
					delete payload.model; // Vertex routes by URL; a body model field is rejected.
					payload.anthropic_version = "vertex-2023-10-16";
					const method = payload.stream === true ? "streamRawPredict" : "rawPredict";
					finalUrl = `${url.slice(0, messagesIdx)}/models/${encodeURIComponent(model)}:${method}`;
					body = JSON.stringify(payload);
					console.log(`[bosch-genai] anthropic → ${finalUrl}`); //IYH1HC add: wire-level proof of the model actually called
				}
			} catch {
				// Leave the request untouched; the gateway error will surface to the caller.
			}
		}
		return origFetch(finalUrl, { ...init, body, headers });
	};
}
