# Reference: code quality — `adt atc`, `adt lint`, `adt context`

ATC (server-side checks), abaplint (offline static analysis), and LLM context bundles. Assume `PKG=ZADT_LOCAL`.

---

## `adt atc` — ABAP Test Cockpit

Server-side code checks. Use the exit code to gate CI: **`1` when findings include errors or warnings**.

```bash
# One-shot: activate variant + run + fetch worklist
adt atc check programs/programs/zhello --variant DEFAULT --max 50

# Step-by-step
WL=$(adt atc activate DEFAULT --raw)
RUN=$(adt atc run "$WL" programs/programs/zhello --max 50 --json | jq -r .id)
adt atc worklist "$RUN" --include-exempted

# Inspect environment
adt atc customizing      # available check variants / config
adt atc users            # system users (map findings to owners)
```

| Command | Purpose | Key options |
|---|---|---|
| `activate <variant>` | Activate a check variant, returns `worklistId` | — |
| `run <worklistId> <objectUrl...>` | Run worklist on object(s), prints `runId` | `--max <n>` (default 100) |
| `worklist <runId>` | Fetch findings; **exit 1 on error/warning** | `--include-exempted`, `--object-set <name>`, `--timestamp <epoch>` |
| `check <objectUrl...>` | End-to-end activate+run+worklist | `--variant <id>` (default DEFAULT), `--max <n>`, `--include-exempted` |
| `customizing` | ATC customizing | — |
| `users` | System users | — |

Common variants: `DEFAULT`, `STANDARD`, `ABAPLINT_DEFAULT`, `S4_CLOUD_PLATFORM_CHECKS`.

---

## `adt lint` — offline static analysis (abaplint)

Runs `@abaplint/core` locally. Supported types: `CLAS/OC`, `INTF/OI`, `PROG/P`, `PROG/I`.
**Exit codes: `0` clean, `1` errors, `2` warnings only.**

```bash
# Single object (pulled via ADT, then linted offline)
adt lint object oo/classes/zcl_foo [--include <name>] [--config ./abaplint.json]

# Local .abap file — NO SAP connection needed
adt lint file ./zcl_foo.clas.abap [--type class|interface|program|include] [--config <path>]

# Whole package as one Registry (enables cross-object analysis)
adt lint package $PKG [--max 200] [--skip-unsupported] [--fix]
```

| Command | Purpose | Key options |
|---|---|---|
| `object <objectUrl>` | Lint one object from ADT | `--include <name>`, `--config <path>` |
| `file <filePath>` | Lint a local `.abap` file offline | `--type`, `--config` |
| `package <package>` | Lint whole package as one Registry | `--max <n>` (200), `--skip-unsupported`, `--fix` |
| `skeleton --object\|--package` | JSON skeleton (classes/methods/interfaces); 5–10× cheaper than raw ABAP for LLM context | `--config`, `--max` |
| `metrics --object\|--package` | Cyclomatic complexity + method length; flags god classes (>30 methods) | `--top <n>` (0=all), `--config`, `--max` |
| `refs --object <url> --line <n> --char <n>` | Find references at a position via LSP | `--package` (cross-object), `--config`, `--max` |
| `format --object\|--package` | PrettyPrinter → JSON on stdout; **does NOT push to SAP** | `--config`, `--max` |

Notes:
- `--fix` (on `package`) applies all auto-fixable issues and prints the changed sources to stdout — **it does not write back to SAP**. Apply manually with `adt object set-source`.
- `--line`/`--char` for `refs` are **1-based** and both required. Add `--package` to load full context for cross-object resolution.
- `format` only prints formatted source; to apply, pipe and use `adt object set-source`.

```bash
# Examples
adt lint package $PKG --fix > fixes.json
adt lint skeleton --package $PKG
adt lint metrics  --package $PKG --top 10
adt lint refs --object oo/classes/zcl_foo --line 42 --char 12 --package $PKG
```

---

## `adt context` — LLM-ready context bundles

Walk a package and emit a multi-file bundle (skeleton + metadata + reading guide) per package, sized for an LLM.

```bash
adt context build --package $PKG --out ./adt-context \
  [--depth <n>] [--target-model <id>] [--max-tokens <n>] \
  [--include-source [glob]] [--strip light|medium|aggressive] \
  [--with-docs] [--with-where-used] [--max 500] \
  [--namespace-prefixes Z,Y,/RB] [--clean | --no-overwrite] \
  [--keep-going] [--dry-run] [--config <path>]

adt context inspect ./adt-context/ZADT_LOCAL --target-model claude-opus-4-7 [--max-tokens <n>]
adt context budget [--target-model <id>]
```

| Command | Purpose | Notable options |
|---|---|---|
| `build` | Emit context bundle per package | `--depth` (0=root, omit=unlimited), `--with-docs`, `--with-where-used`, `--dry-run`, `--clean` / `--no-overwrite`, `--max` (500); exit `1` if any package errored |
| `inspect <bundleDir>` | Recompute token estimates vs target model's soft cap | `--target-model` (default `claude-opus-4-7`), `--max-tokens`; exit `2` if over budget |
| `budget` | Print model context-window / soft-cap table | `--target-model` (highlight one) |

```bash
# Typical flow
adt context build --package $PKG --out ./adt-context --with-docs --with-where-used
adt context inspect ./adt-context/$PKG --target-model claude-opus-4-7
```
