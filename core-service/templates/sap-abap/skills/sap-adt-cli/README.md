# sap-adt-cli (Claude Agent Skill)

A Claude Agent Skill that lets an autonomous agent operate **`adt-cli`** — the CLI for SAP ABAP Development Tools (ADT) — to perform ABAP development tasks against an SAP system inside the OctoAgent project.

## What this skill does

It gives the agent a routed, on-demand reference for every `adt-cli` command group: creating/reading/editing/activating ABAP objects, mirroring packages, running ATC checks and offline abaplint analysis, building LLM context bundles, previewing SQL/DDIC data, managing transports (CTS), reading runtime traces, controlling the debugger, and making raw ADT HTTP calls.

The skill activates whenever a task involves ABAP development, SAP system interaction, or mentions ADT, ABAP, SAP objects, transports, ATC, abaplint, or adt-cli commands.

## Directory map

```
sap-adt-cli/
├── SKILL.md                 # Lean router: preconditions, connection check, lifecycle, routing table, safety rules
├── README.md                # This file
└── references/              # Detailed command docs, loaded on demand
    ├── objects.md           # adt object: create / read / edit / lifecycle / pull
    ├── quality.md           # adt atc, adt lint, adt context
    ├── data-system.md       # adt data, system, service, cts, trace, debug, http
    └── troubleshooting.md   # global flags, object-URL forms, exit codes, error→fix, safety rules
```

The agent reads `SKILL.md` first, then opens only the reference file relevant to the task (progressive disclosure).

## How the agent uses it

1. Verify the connection: `adt auth login test --name dev` (exit 0 = ok, 2 = failure).
2. Identify the task domain and read the matching `references/*.md`.
3. Run commands via the bash tool. Logs go to stderr, data to stdout.
4. Honor the safety rules on every run (see below).

## Assumed preconditions (out of scope)

- A profile named **`dev`** is already configured. Authentication/profile setup is handled separately.
- Default working package is **`ZADT_LOCAL`**.

## Safety rules

1. STOP AND ASK a human before any destructive SAP operation: `adt object delete`, overwriting source not just read, or any write to a package other than `ZADT_LOCAL`.
2. NEVER fabricate ADT endpoints — escalate instead of guessing raw `adt http request` paths.
3. NEVER print or log credentials/tokens.

## Full reference

The complete, authoritative command inventory (every command, flag, and example) lives in [../CLI_REFERENCE.md](../CLI_REFERENCE.md). The deeper internals (auth precedence, pull/lint/context implementation notes) are in [../CLAUDE.md](../CLAUDE.md). This skill never introduces commands or flags absent from those sources.
