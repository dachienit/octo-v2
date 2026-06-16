# Reference: global flags, exit codes, conventions, troubleshooting

Cross-cutting reference for every `adt-cli` command.

---

## Global flags (apply to every command)

| Flag | Effect |
|---|---|
| `-p, --profile <name>` | Select a saved profile (or set `ADT_PROFILE`) |
| `-v, --verbose` | Log HTTP method / URL / status on stderr |
| `--debug` | Full headers (auth redacted) + body previews |
| `-q, --quiet` | Errors only |
| `--insecure` | Skip TLS verification |
| `--raw` | Skip XML→JSON parsing; print raw body |
| `--json` | Force JSON output |
| `--output <file>` | Write body to a file instead of stdout |
| `--accept <mime>` | Override Accept header |
| `--user-jwt <token>` | JWT to forward (destination profiles) |
| `--iss <url>` | Subscriber issuer URL (tenant-scoped destination lookup) |

`-V, --version` prints the CLI version and exits.

---

## Object-URL forms

Every `<objectUrl>` accepts any of:
- Relative: `programs/programs/zhello`, `oo/classes/zcl_demo`
- Absolute path: `/sap/bc/adt/programs/programs/zhello`
- Full URL: `https://abap:44300/sap/bc/adt/oo/classes/zcl_demo`

---

## Exit codes

| Code | Meaning |
|---|---|
| `0` | Success |
| `1` | Generic failure (HTTP non-2xx, parse error, missing profile, `activate` success=false, ATC/lint **errors** found, `context build` package error) |
| `2` | Auth/verify failure (`auth login test`, `auth destinations test`), ATC/lint **warnings only**, `context inspect` over token budget |
| `130` | Ctrl-C during a hidden password prompt |

For `adt atc check` and `adt lint *`: `1` = errors, `2` = warnings only — use this to gate CI.

---

## stderr vs stdout

- **stderr** = logs/status (step announcements, HTTP traces) — safe to ignore when scripting.
- **stdout** = data (the actual result) — safe to pipe into `jq`, `>`, etc.

```bash
adt object source programs/programs/zhello > zhello.abap     # only data is captured
adt atc check oo/classes/zcl_foo --json | jq '.summary'
```

---

## Conventions (this project)

- Profile `dev` is assumed pre-configured; default working package `ZADT_LOCAL`.
- All identifiers, comments, and string literals in generated code/examples are in **English**.
- ABAP refactoring/generation should follow **CleanABAP** standards (verify with `adt atc check` / `adt lint`).

---

## Troubleshooting

| Symptom | Fix |
|---|---|
| Any command fails to connect | Run `adt auth login test --name dev` first (exit 0 = ok, 2 = auth/network failure). If it fails, STOP and report. |
| HTTP 403 on a write | CSRF expired; the CLI auto-retries once. Inspect with `-v` or `--debug`. |
| HTTP 401 on a stateful flow (lock/set-source) | Session terminated; re-run (each process starts a fresh cookie jar). |
| TLS / certificate errors | Add `--insecure`. |
| Validation errors on create | Re-run with `--debug` to see the full validation response. |
| `adt object pull` stalls on a function group | Namespace filter caught SE54 includes; confirm `--namespace-prefixes` (default `Z,Y,/RB`). Use `--print-config` to inspect. |
| A needed endpoint has no `adt` command | **Escalate to a human.** Do NOT craft raw `adt http request` calls to undocumented paths. |

---

## Safety rules (mirrored from SKILL.md — always in force)

1. **STOP AND ASK a human** before `adt object delete`, overwriting source you did not just read, or any write to a package other than `ZADT_LOCAL`.
2. **NEVER fabricate ADT endpoints** — escalate instead of guessing raw HTTP paths.
3. **NEVER print or log credentials/tokens.**
