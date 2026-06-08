import {
	CoreAgent,
	formatSkillsForPrompt,
	getMemory,
	loadSkills,
	type CoreAgentEventHandlers,
	type SandboxConfig,
} from "@octo/core-agent";
import { existsSync, readFileSync } from "fs";
import { join } from "path";
import * as log from "./log.js";
import type { BotContext, ChannelInfo, UserInfo } from "./types.js";
import type { ChannelStore } from "./store.js";

export interface PendingMessage {
	userName: string;
	text: string;
	attachments: { local: string }[];
	timestamp: number;
}

export interface AgentRunner {
	run(
		ctx: BotContext,
		store: ChannelStore,
		pendingMessages?: PendingMessage[],
	): Promise<{ stopReason: string; errorMessage?: string }>;
	abort(): void;
}

export interface RunnerOptions {
	authFilePath?: string;
	userId?: string;
	usersRoot?: string;
	agentWorkersEnabled?: boolean;
	remindersEnabled?: boolean;
}

function truncate(text: string, maxLen: number): string {
	if (text.length <= maxLen) return text;
	return `${text.substring(0, maxLen - 3)}...`;
}

function formatToolArgsForSlack(_toolName: string, args: Record<string, unknown>): string {
	const lines: string[] = [];

	for (const [key, value] of Object.entries(args)) {
		if (key === "label") continue;

		if (key === "path" && typeof value === "string") {
			const offset = args.offset as number | undefined;
			const limit = args.limit as number | undefined;
			if (offset !== undefined && limit !== undefined) {
				lines.push(`${value}:${offset}-${offset + limit}`);
			} else {
				lines.push(value);
			}
			continue;
		}

		if (key === "offset" || key === "limit") continue;

		if (typeof value === "string") {
			lines.push(value);
		} else {
			lines.push(JSON.stringify(value));
		}
	}

	return lines.join("\n");
}

// Slack's max message length
const SLACK_MAX_LENGTH = 40000;

function splitForSlack(text: string): string[] {
	if (text.length <= SLACK_MAX_LENGTH) return [text];
	const parts: string[] = [];
	let remaining = text;
	let partNum = 1;
	while (remaining.length > 0) {
		const chunk = remaining.substring(0, SLACK_MAX_LENGTH - 50);
		remaining = remaining.substring(SLACK_MAX_LENGTH - 50);
		const suffix = remaining.length > 0 ? `\n_(continued ${partNum}...)_` : "";
		parts.push(chunk + suffix);
		partNum++;
	}
	return parts;
}

function buildSystemPrompt(
	workspacePath: string,
	channelId: string,
	memory: string,
	sandboxConfig: SandboxConfig,
	channels: ChannelInfo[],
	users: UserInfo[],
	skills: ReturnType<typeof loadSkills>,
	workspaceInstructions: string,
	remindersEnabled: boolean,
): string {
	const workspacePathFwd = workspacePath.replace(/\\/g, "/");
	const channelPath = `${workspacePathFwd}/sessions/${channelId}`;
	const workingDirectory = `${workspacePathFwd}/artifacts`;
	const isContainer = sandboxConfig.type === "docker" || sandboxConfig.type === "podman";
	const containerRuntime = sandboxConfig.type === "podman" ? "Podman" : "Docker";

	const channelMappings =
		channels.length > 0 ? channels.map((c) => `${c.id}\t#${c.name}`).join("\n") : "(no channels loaded)";

	const userMappings =
		users.length > 0 ? users.map((u) => `${u.id}\t@${u.userName}\t${u.displayName}`).join("\n") : "(no users loaded)";

	const envDescription = isContainer
		? `You are running inside a ${containerRuntime} container (Alpine Linux).
- Bash working directory: ${workingDirectory}
- Install tools with: apk add <package>
- Your changes persist across sessions`
		: process.platform === "win32"
		? `You are running directly on a Windows host machine using PowerShell.
- Shell: PowerShell (not cmd, not bash)
- Working directory: ${workingDirectory}
- Use forward slashes or double-backslashes in paths: C:/Users/... or C:\\Users\\...
- Use PowerShell syntax: New-Item -ItemType Directory -Force -Path <dir> (or just mkdir <dir>)
- For multi-line or complex scripts, use PowerShell idioms
- Be careful with system modifications`
		: `You are running directly on the host machine.
- Bash working directory: ${workingDirectory}
- Be careful with system modifications`;

	const workspaceInstructionsSection = workspaceInstructions.trim()
		? `\n## Workspace Instructions\nThese workspace-specific instructions are loaded from AGENTS.md/agents.md/CLAUDE.md/claude.md in the workspace root and override general behavior when they conflict.\n\n${workspaceInstructions.trim()}\n`
		: "";

	const eventsSection = remindersEnabled
		? `
## Events
You can schedule events that wake you up at specific times or when external things happen. Events are JSON files in \`${workspacePathFwd}/events/\`.

### Event Types

**Immediate** - Triggers as soon as harness sees the file. Use in scripts/webhooks to signal external events.
\`\`\`json
{"type": "immediate", "channelId": "${channelId}", "text": "New GitHub issue opened"}
\`\`\`

**One-shot** - Triggers once at a specific time. Use for reminders.
\`\`\`json
{"type": "one-shot", "channelId": "${channelId}", "text": "Remind Mario about dentist", "at": "2025-12-15T09:00:00+01:00"}
\`\`\`

**Periodic** - Triggers on a cron schedule. Use for recurring tasks.
\`\`\`json
{"type": "periodic", "channelId": "${channelId}", "text": "Check inbox and summarize", "schedule": "0 9 * * 1-5", "timezone": "${Intl.DateTimeFormat().resolvedOptions().timeZone}"}
\`\`\`

### Cron Format
\`minute hour day-of-month month day-of-week\`
- \`0 9 * * *\` = daily at 9:00
- \`0 9 * * 1-5\` = weekdays at 9:00
- \`30 14 * * 1\` = Mondays at 14:30
- \`0 0 1 * *\` = first of each month at midnight

### Timezones
All \`at\` timestamps must include offset (e.g., \`+01:00\`). Periodic events use IANA timezone names. The harness runs in ${Intl.DateTimeFormat().resolvedOptions().timeZone}. When users mention times without timezone, assume ${Intl.DateTimeFormat().resolvedOptions().timeZone}.

### Creating Events
Use unique filenames to avoid overwriting existing events. Include a timestamp or random suffix:
\`\`\`bash
cat > ${workspacePathFwd}/events/dentist-reminder-$(date +%s).json << 'EOF'
{"type": "one-shot", "channelId": "${channelId}", "text": "Dentist tomorrow", "at": "2025-12-14T09:00:00+01:00"}
EOF
\`\`\`
Or check if file exists first before creating.

### Managing Events
- List: \`ls ${workspacePathFwd}/events/\`
- View: \`cat ${workspacePathFwd}/events/foo.json\`
- Delete/cancel: \`rm ${workspacePathFwd}/events/foo.json\`

### When Events Trigger
You receive a message like:
\`\`\`
[EVENT:dentist-reminder.json:one-shot:2025-12-14T09:00:00+01:00] Dentist tomorrow
\`\`\`
Immediate and one-shot events auto-delete after triggering. Periodic events persist until you delete them.

### Silent Completion
For periodic events where there's nothing to report, respond with just \`[SILENT]\` (no other text). This deletes the status message and posts nothing to Slack. Use this to avoid spamming the channel when periodic checks find nothing actionable.

### Debouncing
When writing programs that create immediate events (email watchers, webhooks, etc.), always debounce. If 50 emails arrive in a minute, don't create 50 immediate events. Instead collect events over a window and create ONE immediate event summarizing what happened, or just signal "new activity, check inbox" rather than per-item events. Or simpler: use a periodic event to check for new items every N minutes instead of immediate events.

### Limits
Maximum 5 events can be queued. Don't create excessive immediate or periodic events.
`
		: "";

	return `You are mom, a Slack bot assistant. Be concise. No emojis.

## Context
- For current date/time, use: date
- You have access to previous conversation context including tool results from prior turns.
- For older history beyond your context, search log.jsonl (contains user messages and your final responses, but not tool results).

## Slack Formatting (mrkdwn, NOT Markdown)
Bold: *text*, Italic: _text_, Code: \`code\`, Block: \`\`\`code\`\`\`, Links: <url|text>
Do NOT use **double asterisks** or [markdown](links).

## Slack IDs
Channels: ${channelMappings}

Users: ${userMappings}

When mentioning users, use <@username> format (e.g., <@mario>).

## Environment
${envDescription}

## Workspace Layout
${workspacePathFwd}/
├── MEMORY.md                    # Global memory (all channels)
├── SYSTEM.md                    # Environment config log
├── skills/                      # Global CLI tools you create
├── artifacts/                   # Durable user-requested outputs shared by all sessions
└── sessions/${channelId}/       # This channel
    ├── MEMORY.md                # Channel-specific memory
    ├── log.jsonl                # Message history (no tool results)
    ├── attachments/             # User-shared files
    └── skills/                  # Channel-specific tools

Relative file paths in tools resolve inside \`${workingDirectory}/\`.

## File Outputs
- Your working directory is the shared workspace artifacts folder: \`${workspacePathFwd}/artifacts/\`.
- When the user asks you to create, save, export, or share a file, write the final file in this directory.
- This applies to Markdown, text, JSON, HTML, SVG, reports, generated assets, and any other user-requested saved output.
- Use a subdirectory inside \`${workspacePathFwd}/artifacts/\` for temporary or intermediate work if needed.

## Structured Workspace Data
- For durable CRM-style records, tables, pipelines, inventory, contacts, or other shared structured data, prefer a \`.duckdb\` database file in \`${workspacePathFwd}/artifacts/\` when DuckDB is available.
- Use descriptive database filenames such as \`crm.duckdb\`, \`research.duckdb\`, or \`inventory.duckdb\` when multiple structured datasets are useful.
- Do not create ad hoc CSV files for persistent workspace records unless the user explicitly asks for an export. Use CSV/XLSX only as import/export formats.
- Generated reports, previews, and exported files still belong in \`${workspacePathFwd}/artifacts/\`.

## Artifacts (Interactive Canvas)
**Rule: Any time you create an HTML, SVG, or visualization file, you MUST:**
1. Write it to \`${workspacePathFwd}/artifacts/\`
2. Immediately call \`attach\` with that file path so the user sees it rendered inline as an interactive canvas

\`\`\`
mkdir -p ${workspacePathFwd}/artifacts
# On Windows PowerShell: mkdir ${workspacePathFwd}/artifacts -Force
\`\`\`

Then use the write tool to create the file there, then call attach:
- \`attach\` path: \`${workspacePathFwd}/artifacts/my-file.html\`
- \`attach\` title: a short descriptive name like "Poem" or "Dashboard"

Do NOT just tell the user the file path — always call \`attach\` so it renders in the chat.

## Workspace Skills
Workspace skills are instruction files that provide specialized domain guidance. They are not callable tools.

### Creating Skills
Store in \`${workspacePathFwd}/skills/<name>/\` (global) or \`${channelPath}/skills/<name>/\` (channel-specific).
Each skill directory needs a \`SKILL.md\` with YAML frontmatter:

\`\`\`markdown
---
name: skill-name
description: Short description of what this skill does
---

# Skill Name

Usage instructions, examples, etc.
Scripts are in: {baseDir}/
\`\`\`

\`name\` and \`description\` are required. Use \`{baseDir}\` as placeholder for the skill's directory path.

### Available Skills
${skills.length > 0 ? formatSkillsForPrompt(skills) : "(no skills installed yet)"}

If a skill is listed above, it is available in this workspace. Do not claim a listed skill is unavailable and do not look for it as a tool.
When the user asks to use a listed skill, or the request strongly matches a listed skill description, read that skill's \`SKILL.md\` from the listed location before answering unless the answer is only a trivial clarification.
Treat natural names as aliases for listed skill IDs. For example, "abap cds skill", "ABAP CDS", and "CDS skill" refer to \`sap-abap-cds\` when that skill is listed.

${eventsSection}

## Memory
Write to MEMORY.md files to persist context across conversations.
- Global (${workspacePathFwd}/MEMORY.md): skills, preferences, project info
- Channel (${channelPath}/MEMORY.md): channel-specific decisions, ongoing work
Update when you learn something important or when asked to remember something.

### Current Memory
${memory}

## System Configuration Log
Maintain ${workspacePathFwd}/SYSTEM.md to log all environment modifications:
- Installed packages (apk add, npm install, pip install)
- Environment variables set
- Config files modified (~/.gitconfig, cron jobs, etc.)
- Skill dependencies installed

Update this file whenever you modify the environment. On fresh container, read it first to restore your setup.
${workspaceInstructionsSection}

## Log Queries (for older history)
Format: \`{"date":"...","ts":"...","user":"...","userName":"...","text":"...","isBot":false}\`
The log contains user messages and your final responses (not tool calls/results).
${isContainer ? "Install jq: apk add jq" : ""}

\`\`\`bash
# Recent messages
tail -30 log.jsonl | jq -c '{date: .date[0:19], user: (.userName // .user), text}'

# Search for specific topic
grep -i "topic" log.jsonl | jq -c '{date: .date[0:19], user: (.userName // .user), text}'

# Messages from specific user
grep '"userName":"mario"' log.jsonl | tail -20 | jq -c '{date: .date[0:19], text}'
\`\`\`

## Tools
- bash: Run shell commands (primary tool). Install packages as needed.
- read: Read files
- write: Create/overwrite files
- edit: Surgical file edits
- attach: Share files to Web or Slack

Each tool requires a "label" parameter (shown to user).
`;
}

function loadWorkspaceInstructions(workspacePath: string): string {
	for (const filename of ["AGENTS.md", "agents.md", "CLAUDE.md", "claude.md"]) {
		const path = join(workspacePath, filename);
		if (existsSync(path)) return readFileSync(path, "utf-8");
	}
	return "";
}

// Cache one CoreAgent per channel/auth file. AgentSession owns a ModelRegistry
// bound to its AuthStorage, so recreate the agent when a web user auth path changes.
const channelAgents = new Map<string, { agent: CoreAgent; authFilePath?: string; agentWorkersEnabled?: boolean; remindersEnabled?: boolean }>();

export function getOrCreateRunner(
	sandboxConfig: SandboxConfig,
	channelId: string,
	channelDir: string,
	options: RunnerOptions = {},
): AgentRunner {
	const existing = channelAgents.get(channelId);
	if (
		existing &&
		existing.authFilePath === options.authFilePath &&
		existing.agentWorkersEnabled === options.agentWorkersEnabled &&
		existing.remindersEnabled === options.remindersEnabled
	) {
		return createRunner(existing.agent, sandboxConfig, channelId, channelDir, options.remindersEnabled !== false);
	}

	const agent = new CoreAgent(channelId, {
		sandboxConfig,
		channelDir,
		authFilePath: options.authFilePath,
		userId: options.userId,
		usersRoot: options.usersRoot,
		agentWorkersEnabled: options.agentWorkersEnabled,
	});
	channelAgents.set(channelId, { agent, authFilePath: options.authFilePath, agentWorkersEnabled: options.agentWorkersEnabled, remindersEnabled: options.remindersEnabled });
	return createRunner(agent, sandboxConfig, channelId, channelDir, options.remindersEnabled !== false);
}

function createRunner(
	coreAgent: CoreAgent,
	sandboxConfig: SandboxConfig,
	channelId: string,
	channelDir: string,
	remindersEnabled: boolean,
): AgentRunner {
	return {
		async run(
			ctx: BotContext,
			_store: ChannelStore,
			_pendingMessages?: PendingMessage[],
		): Promise<{ stopReason: string; errorMessage?: string }> {
			const logCtx = {
				channelId: ctx.message.channel,
				userName: ctx.message.userName,
				channelName: ctx.channelName,
			};

			// Sequential message queue for Slack delivery
			let queueChain = Promise.resolve();
			const enqueue = (fn: () => Promise<void>, errorContext: string): void => {
				queueChain = queueChain.then(async () => {
					try {
						await fn();
					} catch (err) {
						const errMsg = err instanceof Error ? err.message : String(err);
						log.logWarning(`Slack API error (${errorContext})`, errMsg);
						try {
							await ctx.respondInThread(`_Error: ${errMsg}_`);
						} catch {
							// Ignore
						}
					}
				});
			};

			const enqueueMessage = (text: string, target: "main" | "thread", errorContext: string, doLog = true): void => {
				for (const part of splitForSlack(text)) {
					enqueue(
						() => (target === "main" ? ctx.respond(part, doLog) : ctx.respondInThread(part)),
						errorContext,
					);
				}
			};

			const events: CoreAgentEventHandlers = {
				onToolStart(toolName, label, args) {
					log.logToolStart(logCtx, toolName, label, args);
					enqueue(() => ctx.respond(`_→ ${label}_`, false), "tool label");
				},

				onToolEnd(toolName, label, args, durationMs, resultText, isError) {
					if (isError) {
						log.logToolError(logCtx, toolName, durationMs, resultText);
					} else {
						log.logToolSuccess(logCtx, toolName, durationMs, resultText);
					}

					const argsFormatted = formatToolArgsForSlack(toolName, args);
					const duration = (durationMs / 1000).toFixed(1);
					let threadMessage = `*${isError ? "✗" : "✓"} ${toolName}*`;
					if (label) threadMessage += `: ${label}`;
					threadMessage += ` (${duration}s)\n`;
					if (argsFormatted) threadMessage += `\`\`\`\n${argsFormatted}\n\`\`\`\n`;
					threadMessage += `*Result:*\n\`\`\`\n${resultText}\n\`\`\``;

					enqueueMessage(threadMessage, "thread", "tool result thread", false);

					if (isError) {
						enqueue(() => ctx.respond(`_Error: ${truncate(resultText, 200)}_`, false), "tool error");
					}
				},

				onToolUpdate(toolName, label, args, resultText) {
					if (!resultText.trim()) return;
					log.logInfo(`[${channelId}] ${toolName} update: ${truncate(resultText, 200)}`);
					const argsFormatted = formatToolArgsForSlack(toolName, args);
					let threadMessage = `*… ${toolName}*`;
					if (label) threadMessage += `: ${label}`;
					threadMessage += "\n";
					if (argsFormatted) threadMessage += `\`\`\`\n${argsFormatted}\n\`\`\`\n`;
					threadMessage += `*Progress:*\n\`\`\`\n${resultText}\n\`\`\``;
					enqueueMessage(threadMessage, "thread", "tool progress thread", false);
				},

				onMessage(text) {
					log.logResponse(logCtx, text);
					enqueueMessage(text, "main", "response main");
					enqueueMessage(text, "thread", "response thread", false);
				},

				onThinking(thinking) {
					log.logThinking(logCtx, thinking);
					enqueueMessage(`_${thinking}_`, "main", "thinking main");
					enqueueMessage(`_${thinking}_`, "thread", "thinking thread", false);
				},

				onCompactionStart(reason) {
					log.logInfo(`Auto-compaction started (reason: ${reason})`);
					enqueue(() => ctx.respond("_Compacting context..._", false), "compaction start");
				},

				onCompactionEnd(result, aborted) {
					if (result) {
						log.logInfo(`Auto-compaction complete: ${result.tokensBefore} tokens compacted`);
					} else if (aborted) {
						log.logInfo("Auto-compaction aborted");
					}
				},

				onRetry(attempt, maxAttempts, errorMessage) {
					log.logWarning(`Retrying (${attempt}/${maxAttempts})`, errorMessage);
					enqueue(
						() => ctx.respond(`_Retrying (${attempt}/${maxAttempts})..._`, false),
						"retry",
					);
				},
			};

			// Build system prompt with fresh memory/skills/channels/users
			const memory = getMemory(channelDir);
			const skills = loadSkills(channelDir, coreAgent.workspacePath);
			const hostWorkspacePath = join(channelDir, "..", "..");
			const workspaceInstructions = loadWorkspaceInstructions(hostWorkspacePath);
			const systemPrompt = buildSystemPrompt(
				coreAgent.workspacePath,
				channelId,
				memory,
				sandboxConfig,
				ctx.channels,
				ctx.users,
				skills,
				workspaceInstructions,
				remindersEnabled,
			);

			log.logInfo(`Context sizes - system: ${systemPrompt.length} chars, memory: ${memory.length} chars`);
			log.logInfo(`Channels: ${ctx.channels.length}, Users: ${ctx.users.length}`);
			log.logResponseStart(logCtx);

			const result = await coreAgent.run({
				text: ctx.message.text,
				ts: ctx.message.ts,
				userName: ctx.message.userName,
				attachments: ctx.message.attachments,
				systemPrompt,
				authFilePath: ctx.authFilePath,
				uploadFile: async (hostPath, title) => {
					await ctx.uploadFile(hostPath, title);
				},
				events,
			});

			// Drain Slack message queue before final state handling
			await queueChain;

			// Handle final state
			if (result.stopReason === "error" && result.errorMessage) {
				try {
					await ctx.replaceMessage("_Sorry, something went wrong_");
					await ctx.respondInThread(`_Error: ${result.errorMessage}_`);
				} catch (err) {
					log.logWarning("Failed to post error message", err instanceof Error ? err.message : String(err));
				}
			} else {
				const finalText = result.lastAssistantText ?? "";

				if (finalText.trim() === "[SILENT]" || finalText.trim().startsWith("[SILENT]")) {
					try {
						await ctx.deleteMessage();
						log.logInfo("Silent response - deleted message and thread");
					} catch (err) {
						log.logWarning("Failed to delete message for silent response", err instanceof Error ? err.message : String(err));
					}
				} else if (finalText.trim()) {
					try {
						const mainText =
							finalText.length > SLACK_MAX_LENGTH
								? `${finalText.substring(0, SLACK_MAX_LENGTH - 50)}\n\n_(see thread for full response)_`
								: finalText;
						await ctx.replaceMessage(mainText);
					} catch (err) {
						log.logWarning("Failed to replace message with final text", err instanceof Error ? err.message : String(err));
					}
				}
			}

			// Post usage summary
			if (result.usage.cost.total > 0) {
				// Derive context size from last assistant message
				const messages = coreAgent.messages;
				const lastAssistantMsg = messages
					.slice()
					.reverse()
					.find((m) => m.role === "assistant" && (m as any).stopReason !== "aborted") as any;

				const contextTokens = lastAssistantMsg
					? lastAssistantMsg.usage.input +
						lastAssistantMsg.usage.output +
						lastAssistantMsg.usage.cacheRead +
						lastAssistantMsg.usage.cacheWrite
					: 0;
				const contextWindow = coreAgent.modelContextWindow;

				const summary = log.logUsageSummary(logCtx, result.usage, contextTokens, contextWindow);
				enqueue(() => ctx.respondInThread(summary), "usage summary");
				await queueChain;
			}

			return { stopReason: result.stopReason, errorMessage: result.errorMessage };
		},

		abort() {
			coreAgent.abort();
		},
	};
}
