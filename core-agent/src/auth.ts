import { AuthStorage } from "@earendil-works/pi-coding-agent";

export interface CoreAgentAuthStatus {
	configured: boolean;
	source?: "stored" | "runtime" | "environment" | "fallback" | "models_json_key" | "models_json_command";
	label?: string;
}

export interface CoreAgentOAuthAuthInfo {
	url: string;
	instructions?: string;
}

export interface CoreAgentOAuthPrompt {
	message: string;
	placeholder?: string;
	allowEmpty?: boolean;
}

export interface CoreAgentOAuthDeviceCodeInfo {
	userCode: string;
	verificationUri: string;
	intervalSeconds?: number;
	expiresInSeconds?: number;
}

export interface CoreAgentOAuthSelectOption {
	id: string;
	label: string;
}

export interface CoreAgentOAuthSelectPrompt {
	message: string;
	options: CoreAgentOAuthSelectOption[];
}

export interface CoreAgentLoginCallbacks {
	onAuth: (info: CoreAgentOAuthAuthInfo) => void;
	onDeviceCode: (info: CoreAgentOAuthDeviceCodeInfo) => void;
	onPrompt: (prompt: CoreAgentOAuthPrompt) => Promise<string>;
	onProgress?: (message: string) => void;
	onManualCodeInput?: () => Promise<string>;
	onSelect: (prompt: CoreAgentOAuthSelectPrompt) => Promise<string | undefined>;
}

export function getProviderAuthStatus(authFilePath: string, providerId: string): CoreAgentAuthStatus {
	return AuthStorage.create(authFilePath).getAuthStatus(providerId);
}

export async function loginProvider(
	authFilePath: string,
	providerId: string,
	callbacks: CoreAgentLoginCallbacks,
): Promise<void> {
	await AuthStorage.create(authFilePath).login(providerId, callbacks);
}
