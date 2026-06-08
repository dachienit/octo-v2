# Mom Docker Sandbox

## Overview

Mom can run tools either directly on the host or inside a Docker/Podman container for isolation.

## Why Containers?

When mom runs on your machine and is accessible via Slack, anyone in your workspace could potentially:
- Execute arbitrary commands on your machine
- Access your files, credentials, etc.
- Cause damage via prompt injection

The container sandbox isolates mom's tools to a container where she can only access what you explicitly mount.

## Quick Start

```bash
# Managed per-workspace containers with Docker
cd core-service
npm run dev:http:docker:managed
```

Managed mode starts one container per workspace on demand. To use a fixed shared container instead:

```bash
cd core-service
./docker.sh build
./docker.sh create ../workspace

mom --sandbox=docker:octo-sandbox ./data
```

Podman uses the same image definition and mount layout. Managed mode:

```bash
cd core-service
npm run dev:http:podman:managed
```

Fixed shared container mode:

```bash
cd core-service
./podman.sh build
./podman.sh create ../workspace

mom --sandbox=podman:octo-sandbox ./data
```

## How It Works

```
┌─────────────────────────────────────────────────────┐
│  Host                                               │
│                                                     │
│  mom process (Node.js)                              │
│  ├── Slack connection                               │
│  ├── LLM API calls                                  │
│  └── Tool execution ──────┐                         │
│                           ▼                         │
│              ┌─────────────────────────┐            │
│              │  Container              │            │
│              │  ├── bash, git, gh, etc │            │
│              │  └── /workspace (mount) │            │
│              └─────────────────────────┘            │
└─────────────────────────────────────────────────────┘
```

- Mom process runs on host (handles Slack, LLM calls)
- All tool execution (`bash`, `read`, `write`, `edit`) happens inside the container.
- In managed per-workspace mode, only the selected workspace is mounted at `/workspace`, and user connector homes are mounted at `/users`.
- In fixed shared-container mode, the whole data directory is mounted at `/workspace`.

## Managed Per-Workspace Mode

Use `--sandbox=docker` or `--sandbox=podman` without a container name:

```bash
mom --sandbox=docker ./data
mom --sandbox=podman ./data
```

When a user starts a session, mom creates or starts a container named after that workspace:

```text
octo-ws-<workspace-id>
```

Mount layout:

```text
/host/data/workspaces/<workspace-id> -> /workspace
/host/data/users/<member-a>          -> /users/<member-a>
/host/data/users/<member-b>          -> /users/<member-b>
```

Each workspace gets its own container and cannot see sibling workspace directories through the normal mount layout. It also receives only the user homes for users listed in that workspace's `members.json`, so connector credentials for unrelated users are not mounted.

Managed containers are labeled with their member-mount signature. If workspace membership changes, the next run recreates the workspace container with the updated member mounts.

Managed containers are stopped automatically after they are idle. A container is considered idle when no run is active for that workspace and the idle timeout has elapsed.

```bash
# Defaults: 30 minutes idle, check every 60 seconds
CORE_SERVICE_SANDBOX_IDLE_MS=1800000
CORE_SERVICE_SANDBOX_CLEANUP_INTERVAL_MS=60000

# Disable idle cleanup
CORE_SERVICE_SANDBOX_IDLE_MS=0
```

## Fixed Shared Container Mode

Use `--sandbox=docker:<name>` or `--sandbox=podman:<name>`:

```bash
mom --sandbox=docker:octo-sandbox ./data
mom --sandbox=podman:octo-sandbox ./data
```

Mount layout:

```text
/host/data -> /workspace
```

This is useful for local debugging, but workspaces are separated only by path convention inside the shared container.

## Container Setup

Use the provided Docker script:

```bash
./docker.sh create <data-dir>   # Create and start container
./docker.sh start               # Start existing container
./docker.sh stop                # Stop container
./docker.sh remove              # Remove container
./docker.sh status              # Check if running
./docker.sh shell               # Open shell in container
```

Or the equivalent Podman script:

```bash
./podman.sh create <data-dir>   # Create and start container
./podman.sh start               # Start existing container
./podman.sh stop                # Stop container
./podman.sh remove              # Remove container
./podman.sh status              # Check if running
./podman.sh shell               # Open shell in container
```

Or manually with Docker:

```bash
docker run -d --name octo-sandbox \
  -v /path/to/mom-data:/workspace \
  octo/sandbox:local
```

Or manually with Podman:

```bash
podman run -d --name octo-sandbox \
  -v /path/to/mom-data:/workspace \
  octo/sandbox:local
```

## Mom Manages Her Own Computer

The container is treated as mom's personal computer. She can:

- Install tools: `apk add github-cli git curl`
- Configure credentials: `gh auth login`
- Create files and directories
- Persist state across restarts

When mom needs a tool, she installs it. When she needs credentials, she asks you.

### Example Flow

```
User: "@mom check the spine-runtimes repo"
Mom:  "I need gh CLI. Installing..."
      (runs: apk add github-cli)
Mom:  "I need a GitHub token. Please provide one."
User: "ghp_xxxx..."
Mom:  (runs: echo "ghp_xxxx" | gh auth login --with-token)
Mom:  "Done. Checking repo..."
```

## Persistence

The container persists across:
- `docker stop` / `docker start`
- `podman stop` / `podman start`
- Host reboots

Installed tools and configs remain until you remove the container.

To start fresh with Docker: `./docker.sh remove && ./docker.sh create ./data`

To start fresh with Podman: `./podman.sh remove && ./podman.sh create ./data`

## CLI Options

```bash
# Run on host (default, no isolation)
mom ./data

# Run with Docker sandbox
mom --sandbox=docker:octo-sandbox ./data

# Run with managed per-workspace Docker sandboxes
mom --sandbox=docker ./data

# Run with Podman sandbox
mom --sandbox=podman:octo-sandbox ./data

# Run with managed per-workspace Podman sandboxes
mom --sandbox=podman ./data

# Explicit host mode
mom --sandbox=host ./data
```

## Security Considerations

**What the container CAN do:**
- Read/write files in `/workspace` (your data dir)
- Make network requests (for git, gh, curl, etc.)
- Install packages
- Run any commands

**What the container CANNOT do:**
- Access files outside `/workspace`
- Access your host's credentials
- Affect your host system

**For maximum security:**
1. Create a dedicated GitHub bot account with limited repo access
2. Only share that bot's token with mom
3. Don't mount sensitive directories

## Troubleshooting

### Container not running
```bash
./docker.sh status  # Check status
./docker.sh start   # Start it
```

### Reset container
```bash
./docker.sh remove
./docker.sh create ./data
```

### Missing tools
Ask mom to install them, or manually:
```bash
docker exec octo-sandbox apk add <package>
```

With Podman:

```bash
podman exec octo-sandbox apk add <package>
```

The default local sandbox image already includes `bash`, `bubblewrap`, `curl`, `git`, `jq`, `node`, `npm`, `npx`, `python3`, `pip`, `codex-acp`, and `gemini`.
