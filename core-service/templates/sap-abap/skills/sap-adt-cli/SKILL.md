---
name: sap-adt-cli
description: Use this skill whenever an agent needs to interact with an SAP ABAP system via the ADT HTTP services using the adt-cli command-line tool. Covers the full ABAP development lifecycle — creating/reading/editing objects (programs, classes, interfaces, CDS, function modules, packages), managing transports (CTS), running ATC code checks, offline abaplint analysis, building LLM context bundles, reading runtime traces, and SQL/DDIC data preview. Trigger when the task involves any ABAP development operation, SAP system interaction, or when the user mentions ADT, ABAP, SAP objects, transport requests, ATC, abaplint, or adt-cli commands. Authentication and profile setup are handled separately — assume a profile named `dev` is already configured.
---

# sap-adt-cli

This skill drives **`adt-cli`**, a CLI for SAP ABAP Development Tools (ADT). Use the **bash tool** to run commands. The CLI logs every step on `stderr`; results land on `stdout` (safe to pipe). Exit codes are predictable (`0` ok, `1` failure/findings, `2` auth/warnings, `130` Ctrl-C).

**Assumed preconditions** (out of scope for this skill):
- A profile named `dev` is already configured. Set it as default with `-p dev` or `ADT_PROFILE=dev`.
- Default working package is `ZADT_LOCAL`. Examples below use `PKG=ZADT_LOCAL`.

## Step 1 — Verify connection first

Before any development command, confirm the system is reachable:

```bash
adt auth login test --name dev   # exit 0 = ok, exit 2 = auth/network failure
```

If this fails, STOP and report — do not attempt further commands.

## Step 2 — The canonical object lifecycle

`validate → create → lock → set-source → unlock → activate`.
The `--source-file ... --activate` flags on `adt object create` collapse the whole sequence into one command. `adt object set-source` manages lock/unlock automatically.

## Step 3 — Route to the right reference

Read the matching reference file **on demand** — do not load all at once.

| If the task involves… | Read |
|---|---|
| Creating, reading, editing, activating, deleting objects; mirroring a package (`pull`) | [references/objects.md](references/objects.md) |
| Code quality: ATC checks, abaplint (lint), LLM context bundles | [references/quality.md](references/quality.md) |
| SQL/DDIC data, system discovery, service bindings, CTS transports, traces, debugger, raw HTTP | [references/data-system.md](references/data-system.md) |
| Global flags, object-URL forms, exit codes, error→fix table | [references/troubleshooting.md](references/troubleshooting.md) |

The complete authoritative command inventory lives in [../CLI_REFERENCE.md](../CLI_REFERENCE.md). Every command in this skill exists there verbatim — never invent flags or endpoints.

## Safety rules (MANDATORY — apply on every run)

1. **STOP AND ASK a human before any destructive SAP operation**: `adt object delete`, overwriting existing source you did not just read, or any write (`create`/`set-source`/`activate`/`delete`) targeting a package **other than `ZADT_LOCAL`**.
2. **NEVER fabricate ADT endpoints.** If no documented `adt` command covers the need, escalate to a human — do not hand-craft raw `adt http request` calls to undocumented paths.
3. **NEVER print or log credentials/tokens.** Do not echo profile secrets, bearer tokens, or `--password` values to stdout/stderr.
