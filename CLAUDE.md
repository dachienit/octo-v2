# CLAUDE.md — Octo

Project: **Octo** — an enterprise AI Agent Core Service.
Repository: `octo-v2` (`octo-monorepo`, **npm workspaces**).
Maintainer persona: **Peter** (Solution Architect).

This file is the operating manual for AI assistants working on this repo. Read it top-to-bottom before making changes. It describes the repository **as it stands today**.

---

## 1. What Octo Is (and Is Not)

**Octo** is an internal platform that lets multiple departments configure, customize, and deploy their own specialized AI agents on top of a shared core.

Three architectural pillars:
1. **Extensibility & Reusability** — Adapter / Plugin pattern. LLM providers, tools, and connectors are swappable per consuming project.
2. **Enterprise Security & Isolation** — strict per-tenant (department/workspace) isolation. Departments must not see each other's data or credentials.
3. **Efficiency & Cost Governance** — built-in token/cost tracking, with rate limits and budget controls as the maturing goal.

**Octo Core does**: the agentic loop, LLM resolution/routing, session + memory + workspace management, primitive tools (file IO, bash), sandboxed tool execution (host/docker/podman), connector + skill loading, and extension hosting.

**Octo Core does NOT do**: RAG / vector retrieval (not part of the core), department-specific business tools, UI rendering, or SAP-specific logic — that all lives at the extension / skill / template / artifact boundary (see [§9](#9-connectors-tools-skills--extensions)).

The first flagship implementation, **OctoAgent**, is a web-based IDE for legacy SAP migration (ABAP modernization, code review, NL-to-ABAP). It is built **entirely out of extensions, connectors, skills, templates, and artifacts** — never by leaking SAP logic into `@octo/core-agent`.

---

## 2. Repository Layout

```
octo-v2/
├── package.json          # root: npm workspaces
├── core-agent/           # @octo/core-agent   — embeddable agent runtime
├── core-service/         # @octo/core-service — HTTP/SSE + Slack + events host (bin: octo)
├── web-app-corp/         # @octo/web-app-corp — Vite + Fiori app shell
├── web-ui-corp/          # @octo/web-ui-corp  — reusable Fiori chat/IDE UI library
└── workspace/            # runtime-managed data root (gitignored)
```

Root [package.json](package.json) declares the npm workspaces:

```json
{
  "name": "octo-monorepo",
  "private": true,
  "workspaces": ["core-agent", "core-service", "web-app-corp", "web-ui-corp"]
}
```

| Dir | Package | Purpose | Key entry |
|---|---|---|---|
| `core-agent` | `@octo/core-agent` | Host-neutral agent runtime: primitive tools, sessions, settings, sandbox executor, connectors, auth | [core-agent/src/index.ts](core-agent/src/index.ts) |
| `core-service` | `@octo/core-service` | Transport host (Express 5 HTTP/SSE + Slack Socket Mode + cron events) + multi-user auth + managed sandboxes. `bin: octo` | [core-service/src/main.ts](core-service/src/main.ts) |
| `web-app-corp` | `@octo/web-app-corp` | Reference web app shell (Vite + Lit + Fiori) | [web-app-corp/src/main.ts](web-app-corp/src/main.ts) |
| `web-ui-corp` | `@octo/web-ui-corp` | Reusable Fiori chat/IDE component library (consumed by `web-app-corp`) | [web-ui-corp/src/index.ts](web-ui-corp/src/index.ts) |

Cross-package references: `core-service` and `web-app-corp` consume `@octo/core-agent` via `"*"` (workspace resolution); `web-app-corp` consumes `@octo/web-ui-corp` via `file:../web-ui-corp`.

---

## 3. Architecture — Layered Model

```
┌─ UI/UX Layer ─────────────────────────────────────────────┐
│  @octo/web-app-corp (shell) ──consumes──▶ @octo/web-ui-corp│
│  SAP UI5 / Fiori components + Monaco editor (IDE seed)     │
│  CoreServiceClient (HTTP+SSE adapter) ── talks to :3030    │
├─ Service Layer (@octo/core-service) ──────────────────────┤
│  Transport: HTTP/SSE host | Slack bot | EventsWatcher(cron)│
│  Auth: passport-local (SQLite) + Codex OAuth + GHES SSO    │
│  Managed sandboxes (docker/podman per workspace)           │
│  Provider extensions: SAP AI Core (sap-claude / sap-openai)│
├─ Core Layer (@octo/core-agent) ───────────────────────────┤
│  CoreAgent  →  pi AgentSession  →  Agent (pi-agent-core)   │
│    LLM resolution (env + stub fallback + SAP providers)    │
│    Primitive tools (read/bash/edit/write/attach)           │
│    Executor (host | docker | podman)                       │
│    Connectors (agent-runtime + business-connector)         │
│    Settings + compaction + retry; Skill loading; ACP       │
└───────────────────────────────────────────────────────────┘
```

Foundation framework: `@earendil-works/pi-agent-core`, `pi-ai`, `pi-coding-agent`.
`@octo/core-agent` exports `CoreAgent`, `getMemory`, `loadSkills`, `formatSkillsForPrompt`, `createExecutor`, `parseSandboxArg`, `validateSandbox`, connector helpers, `AgentSettingsManager`, ACP job helpers, and re-exports `ExtensionAPI` from `pi-coding-agent` ([core-agent/src/index.ts](core-agent/src/index.ts)).

---

## 4. Build & Run

`tsgo` (TypeScript native preview) builds the Node packages; **Vite** builds/serves the web app. No turbo/nx.

```sh
# 1. Install everything (root — npm workspaces)
npm install

# 2. Build the core (service & web-app depend on it)
npm --workspace=core-agent run build

# 3. Run the service in HTTP/SSE dev mode (builds, then serves :3030)
npm --workspace=core-service run dev:http

# 4. Run the web app (Vite :5173, proxies /api → :3030)
npm --workspace=web-app-corp run dev
```

`core-service` dev-script matrix ([core-service/package.json](core-service/package.json)):

| Script | Sandbox mode |
|---|---|
| `dev:http` | host |
| `dev:http:docker` | fixed shared Docker container `octo-sandbox` |
| `dev:http:docker:managed` | managed per-workspace Docker containers |
| `dev:http:podman` | fixed shared Podman container `octo-sandbox` |
| `dev:http:podman:managed` | managed per-workspace Podman containers |

CLI flags, parsed in [core-service/src/main.ts:47](core-service/src/main.ts#L47):

| Flag | Meaning |
|---|---|
| `--sandbox=host` | run tools on host (default) |
| `--sandbox=docker[:name]` / `--sandbox=podman[:name]` | run tools in a container; bare `docker`/`podman` = managed per-workspace |
| `--http[=3030]` | start HTTP/SSE server (default port 3030) |
| `--download=<channelId>` | export Slack history and exit (needs `MOM_SLACK_BOT_TOKEN`) |
| `<dir>` | positional working/data directory (e.g. `../workspace`) |

Build each Node package standalone with `npm run build` (`tsgo -p tsconfig.build.json`); `web-ui-corp` additionally compiles Tailwind to `dist/app.css`.

---

## 5. LLM & Environment

Source of truth: [core-service/.env.example](core-service/.env.example).

```
LLM_PROVIDER=openai          # must match a provider known to @earendil-works/pi-ai
LLM_MODEL=gpt-4o-mini
# LLM_BASE_URL=http://localhost:11434/v1   # OpenAI-compatible endpoints (Ollama/LM Studio/vLLM/OpenRouter)
# LLM_API_KEY=sk-...                        # alternative to a per-user auth.json
# PORT=3030
# CORE_SERVICE_ALLOW_SIGNUP=false           # disable signup after first local user
# CORE_SERVICE_ENCRYPTION_KEY=...           # AES-256-GCM key for per-user provider keys at rest
```

**LLM resolution** ([core-agent/src/agent.ts](core-agent/src/agent.ts)): provider/model come from env; if `pi-ai` doesn't recognize the model, a **stub model** is synthesized so custom gateways still work. API key precedence: `LLM_API_KEY` → SAP (`sap-orchestration`) → per-user `AuthStorage`.

**Per-user key encryption**: provider API keys stored per user are encrypted at rest with **AES-256-GCM** ([core-service/src/crypto.ts](core-service/src/crypto.ts)). `CORE_SERVICE_ENCRYPTION_KEY` accepts 64 hex chars, 44 base64 chars, or any passphrase (stretched via scrypt).

**OAuth provider (`openai-codex`)**: sign in via the web app; each service user gets a separate auth file at `<dataRoot>/users/<userId>/auth.json`.

**GHES SSO** (Bosch GitHub Enterprise Server, [core-service/src/sso.ts](core-service/src/sso.ts)):
```
# SSO_GITHUB_ENABLED=true
# SSO_GITHUB_BASE_URL=https://github.boschdevcloud.com
# SSO_GITHUB_CLIENT_ID=<oauth-app-client-id>
# SSO_GITHUB_CLIENT_SECRET=<oauth-app-client-secret>
# SSO_GITHUB_REDIRECT_URI=http://localhost:3030/auth/sso/callback
# SSO_GITHUB_SCOPES=read:user user:email
# SSO_POST_LOGIN_REDIRECT=http://localhost:5173
# If a corporate proxy is set, keep github.boschdevcloud.com in NO_PROXY.
```

**SAP AI Core** (premium providers `sap-claude` / `sap-openai`):
```
# AICORE_SERVICE_KEY={"serviceurls":{"AI_API_URL":"https://..."},"clientid":"...","clientsecret":"...","url":"https://..."}
# SAP_AI_RESOURCE_GROUP=default
# SAP_AI_CORE_API_KEY=...
# SAP_AI_OPENAI_MODEL=gpt-4.1
# SAP_AI_CLAUDE_MODEL=claude-sonnet-4-5
```

**Managed sandbox cleanup** (only for managed `--sandbox=docker`/`podman`):
```
# CORE_SERVICE_SANDBOX_IDLE_MS=1800000          # idle timeout (default 30 min; <=0 disables)
# CORE_SERVICE_SANDBOX_CLEANUP_INTERVAL_MS=60000
```

**ACP agent workers** (delegated agent CLIs):
```
# CORE_SERVICE_AGENT_WORKERS_ENABLED=true
# CORE_SERVICE_REMINDERS_ENABLED=true
# ACP_CODEX_MODEL=gpt-5.4-mini[medium]
# ACP_AGENTS_JSON={"codex":{"command":"codex-acp"},"gemini":{"command":"gemini","args":["--acp"]},"claude":{"command":"npx","args":["-y","@agentclientprotocol/claude-agent-acp"]}}
```

**Proxy**: `HTTPS_PROXY`/`HTTP_PROXY` are wired into undici's global dispatcher before any fetch ([core-service/src/main.ts:7](core-service/src/main.ts#L7)).

**Slack** (optional transport): `MOM_SLACK_APP_TOKEN`, `MOM_SLACK_BOT_TOKEN` are read in [main.ts:35](core-service/src/main.ts#L35) but intentionally **not** listed in `.env.example`.

---

## 6. Auth & Identity

Three login paths feed one Octo session model:

1. **Local password** — `passport-local` over a SQLite user DB (`workspace/auth.sqlite`). Routes `POST /auth/register|login|logout`, `GET /auth/me`. Signup can be locked after the first user with `CORE_SERVICE_ALLOW_SIGNUP=false`.
2. **Codex OAuth** — device flow for the `openai-codex` provider, per-user auth file under `users/<id>/auth.json`.
3. **GHES SSO** — OAuth 2.0 Authorization Code against Bosch GitHub Enterprise ([sso.ts](core-service/src/sso.ts)). GHES is **not** an OIDC provider: identity comes from calling `/api/v3/user` + `/api/v3/user/emails` with the access token, which is then mapped to a federated identity and exchanged for an Octo session. The access token is read once for identity, then discarded.

Per-user provider keys are encrypted at rest (AES-256-GCM, [§5](#5-llm--environment)).

---

## 7. Runtime Workspace Layout

The data root (`workspace/`, gitignored) is multi-user and multi-workspace:

```
workspace/
├── auth.sqlite(+ -wal/-shm)        # core-service user DB (register/login)
├── users/<userId>/
│   ├── auth.json                   # per-user LLM/provider credentials (encrypted)
│   └── <connector homes>           # e.g. codex/gemini/claude/sap-adt credential dirs
├── templates/                      # workspace templates (sap-abap, sap-cap) — seed skills + settings
├── skills/<workspaceId>/           # workspace-scoped skill installs
└── workspaces/ws_<id>/
    ├── workspace.json              # { id, name, createdBy, createdAt }
    ├── members.json                # workspace membership (drives sandbox user mounts)
    ├── artifacts/                  # durable deliverables (e.g. *.abap)
    ├── events/                     # scheduled event files (cron/one-shot/immediate)
    ├── skills/                     # workspace-scoped skills
    └── sessions/s_<id>/
        ├── session.json            # { id, workspaceId, title, createdBy, ... }
        ├── log.jsonl               # append-only message log (source of truth)
        ├── context.jsonl           # LLM context (synced from log.jsonl)
        ├── last_prompt.jsonl       # debug snapshot of last LLM call
        ├── attachments/
        └── skills/                 # session-scoped skills (override workspace)
```

Skill scoping is hierarchical: **session overrides workspace overrides global**. Workspace templates (`sap-abap`, `sap-cap`) seed a new workspace's skills, tool/connector settings, and `sandboxImage`.

---

## 8. HTTP/SSE Transport

Routes registered in [core-service/src/http.ts](core-service/src/http.ts):

| Method + Path | Purpose |
|---|---|
| `POST /auth/register\|login\|logout`, `GET /auth/me` | passport-local auth (SQLite) |
| `GET /auth/sso/login\|callback` | GHES SSO OAuth flow |
| `GET/POST /auth/openai-codex/status\|login\|login/:id\|login/:id/code` | Codex OAuth device flow |
| `GET /auth/connectors`, `GET /auth/connectors/:c/status` | list connectors / status |
| `POST /auth/connectors/:c/login\|logout`, `GET /auth/connectors/:c/login/:id`, `POST …/input` | connector login lifecycle |
| `POST /connectors/:c/exec` | run a connector command |
| `GET/POST /workspaces` | list / create workspaces |
| `GET/PATCH /workspaces/:id/settings` | read / update workspace settings (incl. sandbox image) |
| `GET/POST /workspaces/:id/sessions` | list / create sessions |
| `POST /sessions/:id/messages` | start a run → **SSE stream** |
| `POST /chat` | run entrypoint (`channelId`/`sessionId`) → SSE |
| `POST /stop`, `GET /status/:id` | abort active run / `{ running }` |
| `GET /messages/:id`, `GET /sessions/:id/messages` | persisted chat history |
| `GET /file?path=...`, `GET /artifact-url?path=...` | raw workspace file / public artifact URL |
| `GET /workspace/:id`, `GET /sessions/:id/workspace` | workspace tree (artifacts/skills) |
| `GET /database/tables`, `GET /database/tables/:t/rows` | DuckDB browsing |

SSE event types: `status` (`thinking`/`working`/`idle`/`stopped`), `delta`, `replace`, `thread`, `file`, `delete`, `done`, `error`. The web client consumes these in [web-ui-corp/src/adapters/core-service.ts](web-ui-corp/src/adapters/core-service.ts).

---

## 9. Connectors, Tools, Skills & Extensions

**Primitive tools** ([core-agent/src/tools/index.ts](core-agent/src/tools/index.ts)): `read`, `bash`, `edit`, `write`, `attach` — schemas via TypeBox. Extra tools are merged in via `CoreAgentOptions.extraTools`.

**Connectors** ([core-agent/src/connectors.ts](core-agent/src/connectors.ts)) — a first-class runtime for external identities/tools. Each connector declares:
- `kind`: `agent-runtime` (codex / gemini / claude — delegated agent CLIs) or `business-connector` (e.g. `sap-adt`, `github`).
- `authMode`: `cli` | `oauth` | `api-key` | `browser-sso`.
- `accessPolicy`: `allowedInHost`, `allowedInDocker`, `mountMode` (ro/rw), `network` (required/optional/blocked).
- `env(ctx)` and `mounts(ctx)`: the per-user environment and mount specs injected into the sandbox (credential homes land under `/users/<id>`).

**Skills**: each skill is a directory with a `SKILL.md` (YAML frontmatter `name` + `description`). Loaded by `loadSkills(channelDir, workspacePath)` ([core-agent/src/agent.ts:164](core-agent/src/agent.ts#L164)) and rendered into the prompt by `formatSkillsForPrompt`.

**Workspace templates** ([core-service/templates/](core-service/templates/)) — `sap-abap` and `sap-cap`, each a `template.json` (label, `sandboxImage`, tool/connector settings) plus vendored skills (e.g. `sap-abap`, `sap-abap-cds`, `sap-cap-capire`). Templates seed a new workspace.

**Provider extensions** ([core-service/src/extensions/](core-service/src/extensions/)):
- `sap-ai-core-provider.ts` — registers `sap-openai` / `sap-claude` models.
- `sap-orchestration-adapter.ts` — OAuth2 client-credentials token lifecycle; rewrites Anthropic `/v1/messages` calls to SAP AI Core `/invoke`.

**ACP agent workers** ([core-agent/src/extensions/](core-agent/src/extensions/)) — delegation to external agent CLIs (`codex-acp`, `gemini-cli`, `claude-agent-acp`) via the Agent Client Protocol; job lifecycle through `listAcpJobs` / `cancelAcpJob`.

> **Boundary rule:** SAP-specific logic (OctoAgent — the legacy-migration web IDE) lives in **extensions + connectors + skills + templates + artifacts**, never in `@octo/core-agent`. Keep the core domain-agnostic so other departments can reuse it.

Further reading: [core-service/docs/](core-service/docs/) — `sandbox.md`, `sap-ai-core-extension.md`, `events.md`, `artifacts-server.md`, `slack-bot-minimal-guide.md`.

---

## 10. Container Runtime & Sandbox

This is the most important section for the upcoming deployment work, so read it carefully.

**Key distinction:** Docker / Podman today is the **tool-execution sandbox only** — it is *not* how the service itself is packaged or deployed. The `core-service` Node process always runs on the host; it shells out to the container runtime to execute the agent's `bash` / `read` / `write` / `edit` tools in isolation.

### 10.1 Three sandbox modes

Parsed by `parseSandboxArg` and realized by `createExecutor` ([core-agent/src/sandbox.ts:85](core-agent/src/sandbox.ts#L85)) and the managed manager ([core-service/src/sandbox-manager.ts](core-service/src/sandbox-manager.ts)):

| Mode | Flag | Behavior |
|---|---|---|
| **Host** | `--sandbox=host` (default) | `HostExecutor` runs tools directly on the host. Cross-platform: PowerShell on Windows, `sh` on POSIX. No isolation. |
| **Fixed shared** | `--sandbox=docker:<name>` / `podman:<name>` | One pre-created container; the whole data dir is mounted at `/workspace`. Workspaces separated only by path convention. Good for local debugging. |
| **Managed per-workspace** | `--sandbox=docker` / `podman` (no name) | One container `octo-ws-<id>` per workspace, started on demand. Mounts only that workspace at `/workspace` plus the member user homes at `/users/<id>`. Idle containers are stopped automatically. |

### 10.2 The sandbox image

`octo/sandbox:local` is built from [core-service/Dockerfile.sandbox](core-service/Dockerfile.sandbox): Alpine + `bash`, `bubblewrap`, `curl`, `git`, `jq`, `node`, `npm`, `python3`/`pip`, plus globally-installed `codex-acp` and `gemini`. It is built on demand by `ensureImage`. A workspace template may override it via `sandboxImage` in `template.json`.

### 10.3 Managed-container lifecycle

In [sandbox-manager.ts](core-service/src/sandbox-manager.ts):
- `resolveWorkspaceSandbox` ([:177](core-service/src/sandbox-manager.ts#L177)) returns a concrete container config for a workspace, creating it if needed.
- `ensureWorkspaceContainer` ([:198](core-service/src/sandbox-manager.ts#L198)) builds the image, computes mounts, and `docker/podman run -d` with labels `octo.workspaceId`, `octo.memberMountHash`, `octo.sandboxImage`.
- Containers are **recreated** when the member set or sandbox image changes (the `memberMountHash` label drifts).
- Idle cleanup stops containers with no active run after `CORE_SERVICE_SANDBOX_IDLE_MS` (default 30 min), polled every `CORE_SERVICE_SANDBOX_CLEANUP_INTERVAL_MS`.

### 10.4 Executor contract & isolation

The `Executor` interface ([sandbox.ts](core-agent/src/sandbox.ts)) exposes `exec`, `spawn`, `readFile`, `writeFile`, `getWorkspacePath`. `ContainerExecutor` runs everything via `docker/podman exec … sh -c`, maps all paths under `/workspace`, and tunnels file I/O through **base64** so binary content and shell metacharacters survive the shell boundary. Member-scoped mounts mean one workspace's container cannot see sibling workspaces or unrelated users' connector credentials.

### 10.5 Helper scripts

[core-service/docker.sh](core-service/docker.sh) and [core-service/podman.sh](core-service/podman.sh) wrap `build`/`create`/`start`/`stop`/`remove`/`status`/`shell` for the fixed-shared container. (They still print legacy `mom --sandbox=...` usage hints.)

---

## 11. SAP BTP Cloud Foundry — Deployment Notes

The next phase deploys `core-service` to **SAP BTP Cloud Foundry**. The repo does **not yet** contain a service image or CF descriptor — there is no app `Dockerfile`, `manifest.yml`, `mta.yaml`, or `.cfignore` for Octo itself. (The `mta.yaml` / `xs-security.json` files under `templates/sap-cap/.../sap-cap-capire/templates/` are *generated artifacts for the agent's SAP CAP skill*, not deployment descriptors for Octo.)

Open decisions to resolve in the deploy phase:

1. **Build a service image / descriptor.** Add an app `Dockerfile` (or buildpack `manifest.yml` / `mta.yaml`) that installs the npm-workspace monorepo, builds `core-agent` + `core-service` + `web-ui-corp` + `web-app-corp`, and starts `core-service` (`bin: octo`) with `node dist/main.js --http $PORT <data>`, honoring CF's injected `$PORT`.
2. **Sandbox model on CF — the #1 blocker.** Managed and fixed container modes shell out to a host Docker/Podman socket. CF buildpack apps and Docker-deployed apps **do not expose a container runtime / Docker-in-Docker** by default, so those modes will not work as-is. Decide between: running `--sandbox=host` *inside* the app's own CF container (the app container becomes the sandbox), or delegating tool execution to an external/remote runner. This must be settled before the first deploy.
3. **Persistent state.** `workspace/` (`auth.sqlite`, sessions, artifacts) lives on the local filesystem, but the CF container filesystem is **ephemeral** and lost on restart/restage. Back it with a CF service — e.g. PostgreSQL for the user DB, an object store / volume service for sessions and artifacts — or accept reset-on-restart.
4. **Identity & secrets.** Move `CORE_SERVICE_ENCRYPTION_KEY`, GHES SSO client secret, and SAP AI Core keys into CF environment / user-provided services, and update `SSO_GITHUB_REDIRECT_URI` + `SSO_POST_LOGIN_REDIRECT` to the deployed URLs.
5. **On-premise reach.** Cloud-to-on-prem ABAP access goes through the already-provisioned **BTP Destinations with Principal Propagation** (managed outside this repo); the agent reaches SAP backends via the `sap-adt` connector, not direct network calls.

---

## 12. Frontend

- **`web-app-corp`** ([web-app-corp/src/main.ts](web-app-corp/src/main.ts)) — the app shell: auth screen (local + SSO), workspace/session sidebar, chat panel, and an artifacts/skills file tree (with DuckDB table browsing). Talks to the backend via `CoreServiceClient`; base URL is `/api` (Vite proxies to `:3030`).
- **`web-ui-corp`** ([web-ui-corp/src/index.ts](web-ui-corp/src/index.ts)) — reusable component library built on **SAP UI5 / Fiori** web components (`@ui5/webcomponents*`). It exports `CoreServiceClient` and the chat/artifacts panels, with artifact viewers including a **Monaco editor** for code plus PDF/DOCX/XLSX/CSV/SVG/HTML renderers — the seed of the OctoAgent web IDE.

---

## 13. Conventions (project-specific, on top of global memory)

- **Languages**: all identifiers / source comments / string literals in **English**. Chat / plan / docs in Vietnamese is fine.
- **Editing existing files**: prefix new lines with `//IYH1HC add`, prefix superseded-but-kept lines with `//IYH1HC comment` (do not delete). New files do not need these prefixes.
- **No emojis** in generated artifacts or agent output unless the user explicitly asks.
- **Artifacts** go in `workspace/workspaces/<ws>/artifacts/`; never paste full file content in chat — write + attach.
- **ADT request shapes**: before guessing ADT XML, grep the battle-tested `abap-adt-api` client (see global memory).
- **CleanABAP**: all refactoring blueprints and generated ABAP must comply with CleanABAP standards.

---

## 14. Where to Look First

| Question | File (verified anchor) |
|---|---|
| How is the agent built / how does a run flow? | `CoreAgent` class — [core-agent/src/agent.ts:255](core-agent/src/agent.ts#L255) |
| How are skills loaded? | `loadSkills` — [core-agent/src/agent.ts:164](core-agent/src/agent.ts#L164) |
| How is the sandbox executor created? | `createExecutor` / `Executor` — [core-agent/src/sandbox.ts:85](core-agent/src/sandbox.ts#L85) |
| How are managed per-workspace containers handled? | [core-service/src/sandbox-manager.ts:177](core-service/src/sandbox-manager.ts#L177) (`resolveWorkspaceSandbox`), [:198](core-service/src/sandbox-manager.ts#L198) (`ensureWorkspaceContainer`) |
| How is the CLI / sandbox flag parsed? | `parseArgs` — [core-service/src/main.ts:47](core-service/src/main.ts#L47) |
| How is the system prompt built / runner created? | `buildSystemPrompt` [core-service/src/agent.ts:91](core-service/src/agent.ts#L91), `getOrCreateRunner` [core-service/src/agent.ts:350](core-service/src/agent.ts#L350) |
| How does HTTP/SSE expose the runtime? | routes [core-service/src/http.ts:261](core-service/src/http.ts#L261) (connectors) |
| How is GHES SSO implemented? | [core-service/src/sso.ts](core-service/src/sso.ts) |
| How are connectors defined? | [core-agent/src/connectors.ts](core-agent/src/connectors.ts) |
| How are SAP providers registered? | [core-service/src/extensions/sap-ai-core-provider.ts](core-service/src/extensions/sap-ai-core-provider.ts), [sap-orchestration-adapter.ts](core-service/src/extensions/sap-orchestration-adapter.ts) |
| What does the web UI consume? | [web-ui-corp/src/adapters/core-service.ts](web-ui-corp/src/adapters/core-service.ts) |

---

## 15. Known Debt / Open Questions

1. **Legacy `mom` naming** — `MOM_SLACK_*` env vars, `octo-sandbox` hints in `docker.sh`/`podman.sh`, and some auth-file paths still carry the `mom` name; a rename is pending.
2. **No first-class `TenantContext`** — isolation is filesystem/path + per-user auth + member-scoped sandbox mounts; there is no `tenantId`/department object propagated through the call graph yet (Pillar #2 gap).
3. **Cost governance is tracking, not enforcement** — token/cost usage is computed per run; no budget gate, rate limit, or cross-session aggregation.
4. **No service image / CF descriptor yet** — deployment to BTP CF needs the artifacts and decisions in [§11](#11-sap-btp-cloud-foundry--deployment-notes); the managed-sandbox-vs-CF-socket question is the main blocker.
5. **OctoAgent (SAP IDE) is still forming** inside extensions + connectors + skills + templates + artifacts. Keep watching the [§9](#9-connectors-tools-skills--extensions) boundary so SAP logic does not leak into `@octo/core-agent`.
