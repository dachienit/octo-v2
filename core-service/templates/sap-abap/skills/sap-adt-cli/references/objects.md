# Reference: `adt object` — repository objects

Create, read, edit, manage the lifecycle of, and mirror ABAP repository objects. Assume `PKG=ZADT_LOCAL` and profile `dev`.

> **Object URL forms** — every `<objectUrl>` accepts relative, absolute, or full URL:
> `programs/programs/zhello` · `/sap/bc/adt/programs/programs/zhello` · `https://abap:44300/sap/bc/adt/oo/classes/zcl_demo`

---

## Create objects

```bash
adt object create <kind> <name> [common options] [kind-specific options]
```

**Common options (every kind):**

| Flag | Effect |
|---|---|
| `--description <text>` | Short text (`adtcore:description`) |
| `--responsible <user>` | `adtcore:responsible` (default: profile user) |
| `--transport <id>` | Transport request (`corrNr`) |
| `--validate-only` | Validate name then stop |
| `--no-validate` | Skip validation |
| `--source-file <file>` | After create: lock + PUT source from file |
| `--source-stdin` | After create: read source from stdin + PUT |
| `--activate` | After create (+ optional source push): activate |

**Object kinds (`<kind>` → typeId, parent flag):**

| Kind | typeId | Parent flag | Max len |
|---|---|---|---|
| `program` | PROG/P | `--package` | 30 |
| `class` | CLAS/OC | `--package` | 30 |
| `interface` | INTF/OI | `--package` | 30 |
| `include` | PROG/I | `--package` | 30 |
| `fgroup` | FUGR/F | `--package` | 26 |
| `fmodule` | FUGR/FF | `--group <fgroup>` | — |
| `finclude` | FUGR/I | `--group <fgroup>` | — |
| `ddl` | DDLS/DF | `--package` | 30 |
| `dcl` | DCLS/DL | `--package` | 30 |
| `ddlx` | DDLX/EX | `--package` | 30 |
| `ddla` | DDLA/ADF | `--package` | 30 |
| `package` | DEVC/K | `--super-package` | 30 |
| `table` | TABL/DT | `--package` | 16 |
| `service-def` | SRVD/SRV | `--package` | 30 |
| `service-binding` | SRVB/SVB | `--package` + `--service` | 30 |
| `dtel` | DTEL/DE | `--package` | 30 |
| `msag` | MSAG/N | `--package` | 20 |
| `auth-field` | AUTH | `--package` | 10 |
| `auth-object` | SUSO/B | `--package` | 10 |

Run `adt object create-types` to list all aliases live (with typeId, parent, max length, creation path).

**Kind-specific options:**
- `package` (DEVC/K): `--super-package <pkg>`, `--swcomp <comp>`, `--transport-layer <layer>`, `--package-type development|structure|main` (default `development`)
- `fmodule`, `finclude`: `--group <fgroup>` (required)
- `service-binding` (SRVB/SVB): `--service <name>` (required), `--binding-type <type>` (default `ODATA`), `--category 0|1` (0 = Web API, 1 = UI; default 0)

**Examples:**

```bash
PKG=ZADT_LOCAL

# Program: full validate→create→source→activate in one command
adt object create program ZHELLO --package $PKG --description "Hello" \
  --source-file ./zhello.abap --activate

# Class from stdin
echo 'CLASS zcl_demo DEFINITION PUBLIC FINAL CREATE PUBLIC. ENDCLASS.
CLASS zcl_demo IMPLEMENTATION. ENDCLASS.' \
  | adt object create class ZCL_DEMO --package $PKG --source-stdin --activate

# Interface
adt object create interface ZIF_DEMO --package $PKG --description "Demo interface"

# Function group + function module
adt object create fgroup ZGRP_DEMO --package $PKG --description "Demo FG"
adt object create fmodule Z_FM_DEMO --group ZGRP_DEMO --description "Demo FM"

# CDS data definition + access control + metadata extension
adt object create ddl  ZI_DEMO     --package $PKG --source-file ./zi_demo.cds --activate
adt object create dcl  ZDCL_I_DEMO --package $PKG --source-file ./zdcl.dcl    --activate
adt object create ddlx ZE_DEMO_EXT --package $PKG --description "Metadata ext"

# Service definition + binding
adt object create service-def YMU_SRVD --package $PKG --source-file ./ymu.srvd --activate
adt object create service-binding YMU_SB --package $PKG \
  --service YMU_SRVD --binding-type ODATA --category 0

# Sub-package
adt object create package ZADT_SUB --super-package $PKG --swcomp HOME \
  --transport-layer SAP --package-type development

# Validate only (no create)
adt object create program ZHELLO --package $PKG --validate-only
adt object validate class ZCL_FOO --package $PKG
```

### `adt object create-generic`

Create by explicit typeId instead of a `<kind>` alias.

```bash
adt object create-generic --type PROG/P --name ZHELLO --package $PKG --description "..."
```
Accepts the same parent/source/activate options as `create`.

---

## Read objects

```bash
adt object structure  oo/classes/zcl_demo                 # metadata + include list
adt object structure  oo/classes/zcl_demo --version inactive
adt object properties /sap/bc/adt/programs/programs/zhello/source/main
adt object source     programs/programs/zhello            # source → stdout
adt object source     oo/classes/zcl_demo --include definitions
adt object source     programs/programs/zhello --version inactive --output ./zhello.abap
adt object versions   programs/programs/zhello            # revision history (atom feed)
```

| Command | Purpose | Key options |
|---|---|---|
| `structure <objectUrl>` | Read object metadata | `--version active\|inactive\|workingArea` |
| `properties <uri>` | Property values for a source URI | — |
| `source <objectUrl>` | Read source text | `--include <name>` (default `main`), `--version`, honors global `--output` |
| `versions <objectUrl>` | Version history | `--include <name>` |

---

## Edit source

Recommended pattern: **read → edit locally → push → activate**.

```bash
adt object source     programs/programs/zhello > ./zhello.abap
# ...edit ./zhello.abap...
adt object set-source programs/programs/zhello --file ./zhello.abap --transport $TR
adt object activate   programs/programs/zhello
```

`set-source` does lock + PUT + unlock in one stateful session.

| Flag | Effect |
|---|---|
| `--file <file>` | Source file (omit to read stdin) |
| `--source-stdin` | Force stdin even on a TTY |
| `--include <name>` | Include name (default `main`) |
| `--transport <id>` | Transport request |
| `--keep-locked` | Hold the lock across commands |
| `--lock-handle <handle>` | Reuse an existing lock |

Manual lock control (rarely needed):
```bash
adt object lock   programs/programs/zhello [--mode MODIFY]   # returns LOCK_HANDLE
adt object unlock programs/programs/zhello --handle <LOCK_HANDLE>
```

---

## Lifecycle: activate / inactive / delete

```bash
adt object activate programs/programs/zhello            # exit 1 if success=false
adt object activate programs/programs/zhello --no-preaudit
adt object inactive                                     # list inactive objects awaiting activation
adt object delete   programs/programs/zhello --transport $TR
```

- `activate` returns `{ success, messages, inactive }`; exit code `1` when `success=false`.
- **`delete` is destructive → STOP AND ASK a human first** (see SKILL.md safety rule 1). Auto-acquires a lock unless `--handle <h>` is given.

---

## `adt object pull` — mirror a package to local disk

Offline-first: pull a whole package once, then analyse many times (input for `adt lint package` and `adt context build`). Files are written in abapGit naming (e.g. `zcl_foo.clas.abap`).

```bash
adt object pull --package ZADT_LOCAL
adt object pull --package ZPK_X --print-config        # show resolved config, no SAP call
```

| Flag | Effect |
|---|---|
| `--package <pkg>` (required) | Package to mirror |
| `--out <dir>` | Output dir (default `./<package-lowercase>`) |
| `--depth <n>` | Recurse sub-packages: `0` = root only, omit = unlimited |
| `--max <n>` | Max objects (default 500) |
| `--include-only <ids>` | CSV typeIds — full override of pull-config |
| `--skip-types <ids>` | CSV typeIds to subtract |
| `--no-dependencies` | Skip the where-used graph |
| `--no-docs` | Skip long-text docs (reserved) |
| `--keep-going` | Continue on per-object failure (default true) |
| `--skip-unsupported` | Suppress warnings for unknown typeIds |
| `--namespace-prefixes <csv>` | Name prefixes to keep, e.g. `Z,Y,/RB`. Empty `""` = pull nothing |
| `--print-config` | Print effective config as JSON and exit |

**Output** (root of `--out`): source files + `.abap-package.json` (manifest v3 `inventory[]` with per-object `status`: `pulled` / `not-in-config` / `not-in-namespace` / `unknown-type` / `fetch-failed`) + `.dependencies.json` (inbound where-used edges).
