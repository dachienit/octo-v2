# Reference: data, system, services, transports, traces, debug, HTTP

`adt data`, `adt system`, `adt service`, `adt cts`, `adt trace`, `adt debug`, `adt http`. Assume profile `dev`.

---

## `adt data` — SQL & DDIC preview

```bash
adt data sql 'SELECT carrier_id, customer_id FROM /DMO/BOOKING WHERE booking_id = 0005' --rows 5
adt data ddic /DMO/TRAVEL --rows 20 --where "status = 'O'"
adt data ddic-meta /DMO/TRAVEL
```

| Command | Purpose | Options |
|---|---|---|
| `sql <query...>` | Free-style ABAP SQL preview | `--rows <n>` (default 100) |
| `ddic <entity>` | Data preview of a DDIC table/CDS view | `--rows <n>`, `--where <sql>` |
| `ddic-meta <entity>` | Column metadata of a DDIC entity | — |

---

## `adt system` — discovery & metadata

```bash
adt system discovery                            # ADT service document
adt system core-discovery                        # also primes the CSRF token
adt system graph                                 # server compatibility info
adt system feeds                                 # atom feed of feeds
adt system object-types --name 'Z*' --max 50     # object type catalog
adt system type-structure                        # POST typestructure
adt system users                                 # system users
adt system dumps --user DEVELOPER --top 20       # short dumps
```

| Command | Purpose | Options |
|---|---|---|
| `discovery` | Root service document | — |
| `core-discovery` | Core discovery + prime CSRF | — |
| `graph` | Compatibility graph | — |
| `feeds` | Available feeds | — |
| `object-types` | Object type catalog | `--name` (default `*`), `--max` (999), `--data` (usedByProvider) |
| `type-structure` | Type structure (POST) | — |
| `users` | System users | — |
| `dumps` | Short dumps | `--user <user>`, `--top <n>` (50) |

---

## `adt service` — business service bindings

```bash
adt service binding   ymu_rap_ui_travel_o2
adt service odata-v2  YMU_SB --service ZUI_TRAVEL --service-def YMU_SRVD --version 0001
```

| Command | Purpose | Options |
|---|---|---|
| `binding <name>` | Read a service binding | — |
| `odata-v2 <binding>` | OData v2 service details | `--service <name>` (req), `--service-def <def>` (req), `--version` (0001) |

---

## `adt cts` — Change & Transport System

```bash
adt cts configurations                  # list saved search configs
adt cts configuration <id>              # read one (note the etag)
adt cts config-metadata                 # search configuration metadata
adt cts list --config <id>              # list transport requests for a config
adt cts save-configuration <id> --etag <e> --file ./config.xml
```

| Command | Purpose | Options |
|---|---|---|
| `config-metadata` | Search configuration metadata | — |
| `configurations` | List saved search configs | — |
| `configuration <configId>` | Read one config (returns etag) | — |
| `save-configuration <configId>` | Update config (PUT, If-Match) | `--etag <e>` (req), `--file <xml>` (req) |
| `list` | List transports for a config | `--config <configId>` (req), `--no-targets` |

Assign any object to a transport by passing `--transport <TR_ID>` to `create`/`set-source`/`delete`.

---

## `adt trace` — ABAP runtime traces

```bash
adt trace list --user DEVELOPER
adt trace requests --user DEVELOPER
adt trace hitlist    <traceId>
adt trace db         <traceId>
adt trace statements <traceId> --id 1 --with-details
```

| Command | Purpose | Options |
|---|---|---|
| `list` | List traces | `--user <user>` |
| `requests` | List traced requests | `--user <user>` |
| `hitlist <traceId>` | Hitlist for a trace | `--system-events` |
| `db <traceId>` | DB accesses | `--system-events` (default true) |
| `statements <traceId>` | Aggregated call tree | `--id <n>`, `--with-details`, `--auto <pct>` (80), `--system-events` |
| `parameters` | POST trace params XML → parametersId | `--file <xml>` (req) |
| `create` | Create a trace configuration | `--description`, `--user`, `--client`, `--process-type`, `--object-type`, `--expires`, `--parameters-id` (all req); `--max-exec` (3), `--server` (*) |
| `delete <traceConfigId>` | Delete a trace config | — |

---

## `adt debug` — debugger control

```bash
adt debug discovery
adt debug status --user DEVELOPER
adt debug listen --user DEVELOPER                       # long-poll; runs until an event
adt debug settings --default
adt debug breakpoint set /sap/bc/adt/programs/programs/zroman/source/main --line 25
adt debug breakpoint delete <breakpointId>
```

| Command | Purpose | Options |
|---|---|---|
| `discovery` | Debugger discovery feed | — |
| `status` | List listeners | `--mode <m>` (user), `--user <user>` |
| `listen` | Start listening (long-poll) | `--mode`, `--user` |
| `settings` | POST debugger settings | `--file <file>` \| `--default` |
| `breakpoint set <objectUri>` | Set a line breakpoint | `--line <n>` (req), `--program`, `--include`, `--user`, `--mode` |
| `breakpoint delete <breakpointId>` | Delete a breakpoint | `--user`, `--mode` |

---

## `adt http` — generic request & `.http` runner

Escape hatch for ADT calls without a dedicated command. Auth, cookies, and CSRF are handled automatically.

> **Safety:** Use `adt http request` only for **documented** ADT paths. If no documented command or path covers the need, escalate to a human — do NOT guess endpoints (SKILL.md safety rule 2).

```bash
adt http request GET /sap/bc/adt/discovery
adt http req     POST /sap/bc/adt/some/path -H 'If-Match: 123' \
  --content-type application/xml --data-file ./body.xml
adt http list ./calls.http                 # list named requests, no execution
adt http run  ./calls.http --var rows=5 --only myRequest --print-each
```

| Command | Purpose | Options |
|---|---|---|
| `request <METHOD> <path>` (alias `req`) | Generic HTTP call | `-H/--header <h...>`, `--content-type <mime>`, `--data <text>`, `--data-file <path>`, `--no-fail` |
| `list <file>` | List requests in a `.http` file | — |
| `run <file>` | Execute a `.http` file | `--var <kv...>`, `--only <name>`, `--continue-on-error`, `--print-each` |
