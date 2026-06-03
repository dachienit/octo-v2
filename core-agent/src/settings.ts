import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { dirname, join } from "path";

export interface AgentCompactionSettings {
	enabled: boolean;
	reserveTokens: number;
	keepRecentTokens: number;
}

export interface AgentRetrySettings {
	enabled: boolean;
	maxRetries: number;
	baseDelayMs: number;
}

export interface AgentSettings {
	defaultProvider?: string;
	defaultModel?: string;
	defaultThinkingLevel?: "off" | "minimal" | "low" | "medium" | "high";
	compaction?: Partial<AgentCompactionSettings>;
	retry?: Partial<AgentRetrySettings>;
}

const DEFAULT_COMPACTION: AgentCompactionSettings = {
	enabled: true,
	reserveTokens: 16384,
	keepRecentTokens: 20000,
};

const DEFAULT_RETRY: AgentRetrySettings = {
	enabled: true,
	maxRetries: 3,
	baseDelayMs: 2000,
};

/**
 * Settings manager for the agent. Stores settings in the workspace root directory.
 */
export class AgentSettingsManager {
	private settingsPath: string;
	private settings: AgentSettings;

	constructor(workspaceDir: string) {
		this.settingsPath = join(workspaceDir, "settings.json");
		this.settings = this.load();
	}

	private load(): AgentSettings {
		if (!existsSync(this.settingsPath)) {
			return {};
		}
		try {
			const content = readFileSync(this.settingsPath, "utf-8");
			return JSON.parse(content);
		} catch {
			return {};
		}
	}

	private save(): void {
		try {
			const dir = dirname(this.settingsPath);
			if (!existsSync(dir)) {
				mkdirSync(dir, { recursive: true });
			}
			writeFileSync(this.settingsPath, JSON.stringify(this.settings, null, 2), "utf-8");
		} catch (error) {
			console.error(`Warning: Could not save settings file: ${error}`);
		}
	}

	getCompactionSettings(): AgentCompactionSettings {
		return { ...DEFAULT_COMPACTION, ...this.settings.compaction };
	}

	getCompactionEnabled(): boolean {
		return this.settings.compaction?.enabled ?? DEFAULT_COMPACTION.enabled;
	}

	setCompactionEnabled(enabled: boolean): void {
		this.settings.compaction = { ...this.settings.compaction, enabled };
		this.save();
	}

	getRetrySettings(): AgentRetrySettings {
		return { ...DEFAULT_RETRY, ...this.settings.retry };
	}

	getRetryEnabled(): boolean {
		return this.settings.retry?.enabled ?? DEFAULT_RETRY.enabled;
	}

	setRetryEnabled(enabled: boolean): void {
		this.settings.retry = { ...this.settings.retry, enabled };
		this.save();
	}

	getDefaultModel(): string | undefined {
		return this.settings.defaultModel;
	}

	getDefaultProvider(): string | undefined {
		return this.settings.defaultProvider;
	}

	setDefaultModelAndProvider(provider: string, modelId: string): void {
		this.settings.defaultProvider = provider;
		this.settings.defaultModel = modelId;
		this.save();
	}

	getDefaultThinkingLevel(): string {
		return this.settings.defaultThinkingLevel || "off";
	}

	setDefaultThinkingLevel(level: string): void {
		this.settings.defaultThinkingLevel = level as AgentSettings["defaultThinkingLevel"];
		this.save();
	}

	// Compatibility methods for AgentSession
	getSteeringMode(): "all" | "one-at-a-time" {
		return "one-at-a-time";
	}

	setSteeringMode(_mode: "all" | "one-at-a-time"): void {}

	getFollowUpMode(): "all" | "one-at-a-time" {
		return "one-at-a-time";
	}

	setFollowUpMode(_mode: "all" | "one-at-a-time"): void {}

	getThinkingBudgets(): undefined {
		return undefined;
	}

	getBlockImages(): boolean {
		return false;
	}

	setBlockImages(_blocked: boolean): void {}

	getImageAutoResize(): boolean {
		return true;
	}

	setImageAutoResize(_enabled: boolean): void {}

	getBranchSummarySettings(): { reserveTokens: number } {
		return { reserveTokens: 16384 };
	}

	getGlobalSettings(): object {
		return {};
	}

	getProjectSettings(): object {
		return {};
	}

	getTheme(): string | undefined {
		return undefined;
	}

	getShellCommandPrefix(): string | undefined {
		return undefined;
	}

	setShellCommandPrefix(_prefix: string | undefined): void {}

	getShellPath(): string | undefined {
		return undefined;
	}

	reload(): void {}

	getHookPaths(): string[] {
		return [];
	}

	getHookTimeout(): number {
		return 30000;
	}
}
