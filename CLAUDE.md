# CLAUDE.md — Octo v2

Project: **Octo** — enterprise AI Agent Core Service (version 2).
Repository: `octo-v2` (`octo-monorepo`, **npm workspaces**).
Maintainer alias: **Peter** (Solution Architect persona).

This file is the operating manual for AI assistants working on this repo. Read top-to-bottom before making changes. The previous generation lives at `../octo-web-agent` (v1) — see [§13](#13-v1--v2-what-changed) for the diff. **We work in v2 from now on.**

---

## 1. What Octo Is (and Is Not)

**Octo** is an internal platform that lets multiple departments configure, customize, and deploy their own specialized AI agents on top of a shared core.

Three architectural pillars:
1. **Extensibility & Reusability** — Adapter / Plugin pattern. LLM providers and tools are swappable per consuming project.
2. **Enterprise Security & Isolation** — strict per-tenant (department) isolation. Departments must not see each other's data.
3. **Efficiency & Cost Governance** — built-in token tracking, with rate limits / budget controls as the maturing goal.

**Octo Core does**: agentic loop, LLM resolution/routing, session + memory + workspace management, primitive tools (file IO, bash), sandbox execution, skill loading, extension hosting.

**Octo Core does NOT do**: RAG/vector retrieval (removed from core in v2), department-specific business tools, UI rendering, SAP-specific logic (lives in the extension/skill boundary — see [§8](#8-tools-skills--extensions)).

---

## 2. Repository Layout

```
octo-v2/
├── package.json          # root: npm workspaces, overrides, shared deps
├── core-agent/           # @octo/core    — embeddable agent runtime
├── core-service/         # @octo/service  — HTTP/SSE + Slack + events host
├── web-app/              # @octo/web-app  — Vite+Lit app shell
├── web-ui-component/     # @octo/web-ui   — reusable Lit chat-UI library
└── workspace/            # runtime-managed data root (gitignored)
```

Root [package.json](package.json) declares real npm workspaces (v1 had none):

```json
{
  "name": "octo-monorepo",
  "private": true,
  "workspaces": ["core-agent", "core-service", "web-app", "web-ui-component"],
  "overrides": { "xlsx": "^0.18.5" },
  "dependencies": { "undici": "^8.3.0" }
}
```

| Dir | Package | Ver | Purpose | Key entry |
|---|---|---|---|---|
| `core-agent` | `@octo/core` | 0.0.1 | Host-neutral agent runtime, primitive tools, sessions, settings, sandbox, auth | [core-agent/src/index.ts](core-agent/src/index.ts) |
| `core-service` | `@octo/service` | 0.0.1 | Transport host (Express 5 HTTP/SSE + Slack Socket Mode + cron events) + multi-user auth. `bin: octo` | [core-service/src/main.ts](core-service/src/main.ts) |
| `web-app` | `@octo/web-app` | 1.39.6 | Reference web app shell (Vite + Lit) | [web-app/src/main.ts](web-app/src/main.ts) |
| `web-ui-component` | `@octo/web-ui` | 0.51.6 | Reusable chat-UI component library (consumed by `web-app`) | [web-ui-component/src/index.ts](web-ui-component/src/index.ts) |

Cross-package references: `core-service` and `web-app` consume `@octo/core` via `"*"` (workspace resolution); `web-app` consumes `@octo/web-ui` via `file:../web-ui-component`.

---

## 3. Architecture — Layered Model

```
┌─ UI/UX Layer ─────────────────────────────────────────────┐
│  @octo/web-app  (shell)  ──consumes──▶  @octo/web-ui (lib) │
│  CoreServiceClient (HTTP+SSE adapter) ── talks to :3030    │
├─ Service Layer (@octo/service) ───────────────────────────┤
│  Transport: HTTP/SSE host | Slack bot | EventsWatcher(cron)│
│  Multi-user auth (SQLite + passport-local)                 │
│  Provider extensions: SAP AI Core (sap-claude / sap-openai)│
├─ Core Layer (@octo/core) ─────────────────────────────────┤
│  CoreAgent  →  pi AgentSession  →  Agent (pi-agent-core)   │
│    LLM resolution (env + stub fallback + SAP providers)    │
│    Primitive tools (read/bash/edit/write/attach)           │
│    Sandbox Executor (host | docker)                        │
│    Settings + compaction + retry; Skill loading            │
└───────────────────────────────────────────────────────────┘
```

Foundation framework: `@earendil-works/pi-agent-core`, `pi-ai`, `pi-coding-agent` — all `^0.75.3`.
`@octo/core` exports `CoreAgent`, `getMemory`, `loadSkills`, `formatSkillsForPrompt`, `createExecutor`, `AgentSettingsManager`, auth helpers, and re-exports `ExtensionAPI` from `pi-coding-agent` ([core-agent/src/index.ts](core-agent/src/index.ts)).

---

## 4. Build & Run

`tsgo` (TypeScript native preview) builds the Node packages; **Vite** builds/serves the web app. No turbo/nx.

```sh
# 1. Install everything (root — npm workspaces)
npm install

# 2. Build the core (service & web-app depend on it)
npm --workspace=core-agent run build

# 3. Run the service in HTTP/SSE dev mode
#    (builds, then: node dist/main.js --http ../workspace  → serves :3030)
npm --workspace=core-service run dev:http

# 4. Run the web app (Vite :5173, proxies /api → :3030)
npm --workspace=web-app run dev
```

`@octo/service` CLI flags ([core-service/src/main.ts](core-service/src/main.ts#L43)):

| Flag | Meaning |
|---|---|
| `--sandbox=host` | run tools on host (default) |
| `--sandbox=docker:<name>` | run tools inside a Docker container |
| `--http[=3030]` | start HTTP/SSE server (default port 3030) |
| `--download=<channelId>` | export Slack history and exit (needs `MOM_SLACK_BOT_TOKEN`) |
| `<dir>` | positional working/data directory (e.g. `../workspace`) |

Helper scripts: `core-service/dev.sh`, `core-service/docker.sh`. Build each Node package standalone with `npm run build` (`tsgo -p tsconfig.build.json`); `web-ui-component` additionally compiles Tailwind to `dist/app.css`.

---

## 5. LLM & Environment

Source of truth: [core-service/.env.example](core-service/.env.example).

```
LLM_PROVIDER=openai          # must match a provider known to @earendil-works/pi-ai
LLM_MODEL=gpt-4o-mini
# LLM_BASE_URL=http://localhost:11434/v1   # OpenAI-compatible endpoints (Ollama/LM Studio/vLLM/OpenRouter)
# LLM_API_KEY=sk-...                        # alternative to ~/.pi/mom/auth.json
# PORT=3030
# CORE_SERVICE_ALLOW_SIGNUP=false           # disable signup after first local user
```

**LLM resolution** ([core-agent/src/agent.ts](core-agent/src/agent.ts)): provider/model come from env; if `pi-ai` doesn't recognize the model, a **stub model** is synthesized (200k ctx / 8k out) so custom gateways still work. API key precedence: `LLM_API_KEY` → SAP (`sap-orchestration`) → `AuthStorage` per provider. Default auth file paths: `~/.pi/agent/auth.json` (openai-codex) else `~/.pi/mom/auth.json`.

**OAuth provider (`openai-codex`)**: sign in via the web app; each service user gets a separate auth file at `<dataRoot>/users/<userId>/auth.json`.

**SAP AI Core** (premium providers `sap-claude` / `sap-openai`):
```
# AICORE_SERVICE_KEY={"serviceurls":{"AI_API_URL":"https://..."},"clientid":"...","clientsecret":"...","url":"https://..."}
# SAP_AI_RESOURCE_GROUP=default
# SAP_AI_CORE_API_KEY=...
# SAP_AI_OPENAI_MODEL=gpt-4.1
# SAP_AI_CLAUDE_MODEL=claude-sonnet-4-5
```

**Proxy**: `HTTPS_PROXY`/`HTTP_PROXY` are wired into undici's global dispatcher before any fetch ([core-service/src/main.ts:7-15](core-service/src/main.ts#L7)).

**Slack** (optional transport): `MOM_SLACK_APP_TOKEN`, `MOM_SLACK_BOT_TOKEN` are read in [main.ts:33-34](core-service/src/main.ts#L33) (legacy `MOM_*` names kept from v1) but are intentionally **not** listed in `.env.example`.

---

## 6. Runtime Workspace Layout

The data root (`workspace/`, gitignored) is multi-user and multi-workspace in v2:

```
workspace/
├── auth.sqlite(+ -wal/-shm)        # core-service user DB (register/login)
├── users/<userId>/
│   └── auth.json                   # per-user LLM/provider credentials
├── skills/                         # globally available skills (SKILL.md per dir)
│   ├── sap-adt-cli/SKILL.md
│   └── design-architecture/SKILL.md
└── workspaces/ws_<id>/
    ├── workspace.json              # { id, name, createdBy, createdAt }
    ├── members.json                # workspace membership
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

Evidence of the SAP/ABAP flagship already working: `workspaces/ws_*/artifacts/zcl_simple_calculator.abap` (an agent-generated ABAP class). Skill scoping is hierarchical: **session overrides workspace overrides global**.

---

## 7. HTTP/SSE Transport

Routes registered in [core-service/src/http.ts](core-service/src/http.ts#L174):

| Method + Path | Purpose |
|---|---|
| `POST /auth/register`, `POST /auth/login`, `GET /auth/me`, `POST /auth/logout` | passport-local auth (SQLite) |
| `GET/POST /auth/openai-codex/status\|login\|login/:id\|login/:id/code` | Codex OAuth device flow |
| `GET/POST /workspaces` | list / create workspaces |
| `GET/PATCH /workspaces/:workspaceId/settings` | read / update workspace settings |
| `GET/POST /workspaces/:workspaceId/sessions` | list / create sessions |
| `POST /sessions/:sessionId/messages` | start a run → **SSE stream** |
| `POST /chat` | legacy run entrypoint (`channelId`/`sessionId`) → SSE |
| `POST /stop` | abort active run |
| `GET /status/:id` | `{ running: boolean }` |
| `GET /sessions` | list sessions |
| `GET /messages/:id`, `GET /sessions/:id/messages` | persisted chat history |
| `GET /file?path=...` | raw workspace file (sandboxed) |
| `GET /artifact-url?path=...` | public URL for an artifact |
| `GET /workspace/:id`, `GET /sessions/:id/workspace` | workspace tree (artifacts/skills) |
| `GET /database/tables`, `GET /database/tables/:tableName/rows` | DuckDB browsing |

SSE event types: `status` (`thinking`/`working`/`idle`/`stopped`), `delta`, `replace`, `thread`, `file`, `delete`, `done`, `error`. The web client consumes these in [web-ui-component/src/adapters/core-service.ts](web-ui-component/src/adapters/core-service.ts).

---

## 8. Tools, Skills & Extensions

**Primitive tools** ([core-agent/src/tools/index.ts](core-agent/src/tools/index.ts)): `read`, `bash`, `edit`, `write`, `attach` — schemas via TypeBox. Extra tools are merged in via `CoreAgentOptions.extraTools`.

**Skills**: each skill is a directory with a `SKILL.md` (YAML frontmatter `name` + `description`). Loaded by `loadSkills(channelDir, workspacePath)` ([core-agent/src/agent.ts:160](core-agent/src/agent.ts#L160)) and rendered into the prompt by `formatSkillsForPrompt`. Two SAP-domain skills already ship in `workspace/skills/`:
- **`sap-adt-cli`** — ABAP lifecycle via SAP ADT HTTP services (object CRUD, CTS, ATC checks, traces).
- **`design-architecture`** — SAP solution architecture (arc42/ARC artifacts).

**Provider extensions** ([core-service/src/extensions/](core-service/src/extensions/)):
- `sap-ai-core-provider.ts` — registers `sap-openai` / `sap-claude` models.
- `sap-orchestration-adapter.ts` — OAuth2 client-credentials token lifecycle; rewrites Anthropic `/v1/messages` calls to SAP AI Core `/invoke`.

> **Boundary rule:** SAP-specific logic (OctoAgent — the legacy-migration web IDE) lives in **extensions + skills + artifacts**, never in `@octo/core`. Keep the core domain-agnostic so other departments can reuse it.

Further reading: [core-service/docs/](core-service/docs/) — `sap-ai-core-extension.md`, `sandbox.md`, `events.md`, `artifacts-server.md`, `slack-bot-minimal-guide.md`.

---

## 9. Frontend

- **`web-app`** ([web-app/src/main.ts](web-app/src/main.ts)) — the app shell: auth screen, workspace/session sidebar, chat panel, and an artifacts/skills file tree (with DuckDB table browsing). Talks to the backend via `CoreServiceClient`; base URL is `/api` (Vite proxies to `:3030`).
- **`web-ui-component`** ([web-ui-component/src/index.ts](web-ui-component/src/index.ts)) — reusable Lit library exporting `CoreServiceClient`, `CoreServiceChatPanel`, `ChatPanel`, `AgentInterface`, dialogs, IndexedDB storage, and `ArtifactsPanel`. The artifact viewers include a **Monaco editor** for code (`tools/artifacts/TextArtifact.ts`) plus PDF/DOCX/XLSX/CSV/SVG/HTML renderers — this is the seed of the web-based IDE.

---

## 10. Conventions (project-specific, on top of global memory)

- **Languages**: all identifiers / source comments / string literals in **English**. Chat / plan / docs in Vietnamese is fine (global memory `feedback_code_in_english`).
- **Editing existing files**: prefix new lines with `//IYH1HC add`, prefix superseded-but-kept lines with `//IYH1HC comment` (do not delete). New files do not need these prefixes (global memory `feedback_iyh1hc_comment_convention`).
- **No emojis** in generated artifacts or agent output unless the user explicitly asks.
- **Artifacts** go in `workspace/workspaces/<ws>/artifacts/`; never paste full file content in chat — write + attach.
- **ADT request shapes**: before guessing ADT XML, grep the battle-tested `abap-adt-api` client (global memory `reference_abap_adt_api`).

---

## 11. Where to Look First

| Question | File (verified anchor) |
|---|---|
| How does a run flow / how is the agent built? | `CoreAgent` class — [core-agent/src/agent.ts:249](core-agent/src/agent.ts#L249) |
| How is the LLM/model resolved? | model defaults [agent.ts:42-54](core-agent/src/agent.ts#L42), API key [agent.ts:202](core-agent/src/agent.ts#L202) |
| How are tools wired? | [core-agent/src/tools/index.ts](core-agent/src/tools/index.ts) |
| How is the system prompt built / runner created? | `buildSystemPrompt` [core-service/src/agent.ts:87](core-service/src/agent.ts#L87), `getOrCreateRunner` [agent.ts:334](core-service/src/agent.ts#L334) |
| How does HTTP/SSE expose the runtime? | routes [core-service/src/http.ts:174-205](core-service/src/http.ts#L174), `handleChat` |
| How are SAP providers registered? | [core-service/src/extensions/sap-ai-core-provider.ts](core-service/src/extensions/sap-ai-core-provider.ts), [sap-orchestration-adapter.ts](core-service/src/extensions/sap-orchestration-adapter.ts) |
| What does the web UI consume? | [web-ui-component/src/adapters/core-service.ts](web-ui-component/src/adapters/core-service.ts) |

---

## 12. Known Debt / Open Questions

1. **Legacy `mom` naming** — `MOM_SLACK_*` env vars and `~/.pi/mom/auth.json` carry over from v1; rename pending.
2. **No `TenantContext`** — isolation is filesystem/path + per-user auth only; no first-class `tenantId`/department object yet (Pillar #2 gap).
3. **Cost governance is tracking, not enforcement** — token/cost usage is computed per run; no budget gate, rate limit, or cross-session aggregation.
4. **OctoAgent (SAP IDE) is still forming** inside extensions + skills + artifacts. Keep watching the [§8](#8-tools-skills--extensions) boundary so SAP logic does not leak into `@octo/core`.
5. **Open architecture questions** (carried from Peter's design notes): LLM routing authority (caller vs. tier vs. gateway), formal plugin manifest + sandboxing model for untrusted department plugins, `TenantContext` propagation design.

---

## 13. v1 → v2: What Changed

Reference v1: `../octo-web-agent` (packages `octo-core` / `core-service` / `web-ui`).

| Aspect | v1 (`octo-web-agent`) | v2 (`octo-v2`) |
|---|---|---|
| Monorepo | no root file; packages installed standalone | root `package.json` with **npm workspaces** |
| Core package | `octo-core` (`OctoAgentRuntime` + `OctoSession`) | `core-agent` (`@octo/core`, single `CoreAgent` class) |
| Web layer | one package `@octo/web` | split: `@octo/web-app` (shell) + `@octo/web-ui` (reusable lib) |
| Runtime layout | `.octo/` + `sessions/<channelId>` | `auth.sqlite` + `users/<id>` + `workspaces/ws_*/sessions/s_*` (multi-tenant) |
| Auth | none / Slack-single-user | SQLite + passport-local multi-user; per-user `auth.json`; Codex OAuth |
| LLM | env-only, Bosch GenAI gateway | env + stub fallback + OAuth + **SAP AI Core** providers |
| SAP | absent | present (provider extensions + `sap-adt-cli` / `design-architecture` skills + ABAP artifacts) |
| RAG/DIA | legacy code commented-out in core | **fully removed** from core |

---

*Manual generated 2026-06-04 from a verified read of the v2 tree. When code moves, fix the anchors in [§11](#11-where-to-look-first).*
