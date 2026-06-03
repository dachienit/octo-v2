# SAP AI Core custom provider extension

This project includes a Pi extension at `src/extensions/sap-ai-core-provider.ts` that registers two custom providers:

- `sap-openai` using `openai-completions`
- `sap-claude` using `anthropic-messages`

The Claude provider also installs the SAP orchestration fetch adapter from
`src/extensions/sap-orchestration-adapter.ts`. That adapter rewrites Anthropic
SDK `/v1/messages` calls to SAP AI Core deployment `/invoke` calls and keeps the
transport/auth behavior owned by `core-service` extensions instead of
`core-agent`.

## Authentication

SAP AI Core service keys use **OAuth2 client credentials** — they contain `clientid`, `clientsecret`, and `url` (token endpoint base), not a static API key. A bearer token is fetched automatically and cached until 5 minutes before expiry.

Typical service key shape:
```json
{
  "clientid": "sb-...",
  "clientsecret": "...",
  "url": "https://<subaccount>.authentication.<region>.hana.ondemand.com",
  "serviceurls": {
    "AI_API_URL": "https://api.ai.<region>.aws.ml.hana.ondemand.com/v2"
  }
}
```

Set `SAP_AI_CORE_API_KEY` to a static bearer token if you want to skip the OAuth2 flow.

## Environment variables

- `AICORE_SERVICE_KEY` or `SAP_AI_CORE_SERVICE_KEY` (**required**): full service key JSON string.
- `SAP_AI_RESOURCE_GROUP` (**required**): SAP AI Core resource group (default: `default`).
- `SAP_AI_CLAUDE_DEPLOYMENT_ID` (**required for Claude**): deployment ID from the SAP AI Core cockpit (e.g. `d1a2b3c4d5e6f7`). Find it under ML Operations → Deployments.
- `SAP_AI_OPENAI_DEPLOYMENT_ID` (**required for OpenAI**): deployment ID for the OpenAI model.
- `SAP_AI_CORE_API_KEY` (optional): static bearer token — bypasses OAuth2 if set.
- `SAP_AI_CORE_BASE_URL` (optional): overrides `AI_API_URL` from the service key.
- `SAP_AI_CORE_API_KEY_ENV` (optional, default `SAP_AI_CORE_API_KEY`): env var name Pi resolves as provider key.
- `SAP_AI_CLAUDE_MODEL` (optional, default `claude-sonnet-4-5`): display name in the model selector.
- `SAP_AI_OPENAI_MODEL` (optional, default `gpt-4.1`): display name for the OpenAI deployment.
- `SAP_AI_CONTEXT_WINDOW` (optional, default `200000`).
- `SAP_AI_MAX_TOKENS` (optional, default `8192`).

## Usage

### Server-side agent (`LLM_PROVIDER=sap-claude`)

```bash
LLM_PROVIDER=sap-claude
LLM_MODEL=claude-sonnet-4-5            # display name only

AICORE_SERVICE_KEY='{"clientid":"sb-...","clientsecret":"...","url":"https://...","serviceurls":{"AI_API_URL":"https://api.ai.eu10.aws.ml.hana.ondemand.com/v2"}}'
SAP_AI_RESOURCE_GROUP=default
SAP_AI_CLAUDE_DEPLOYMENT_ID=d1a2b3c4d5e6f7
```

The request URL will be:
`{AI_API_URL}/inference/deployments/{SAP_AI_CLAUDE_DEPLOYMENT_ID}/`

A token is fetched from `{url}/oauth/token` with `grant_type=client_credentials` before the first request.

### Web UI (model selector)

Set the same env vars on the core-service process. The `sap-claude / <model name>` entry will appear in the model selector. The token is fetched when the extension registers at startup.

## References

- SAP AI Core deployment API: [SAP Help Portal](https://help.sap.com/docs/sap-ai-core)
