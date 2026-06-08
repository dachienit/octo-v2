import { getProviders } from "@octo/core-agent/web";
import { html, type TemplateResult } from "lit";
import { customElement } from "lit/decorators.js";
import "../components/ProviderKeyInput.js";
import { SettingsTab } from "./SettingsDialog.js";

@customElement("providers-models-tab")
export class ProvidersModelsTab extends SettingsTab {
	getTabName(): string {
		return "Providers & Models";
	}

	render(): TemplateResult {
		const providers = getProviders();

		return html`
			<div class="flex flex-col gap-6">
				<div>
					<h3 class="text-sm font-semibold text-foreground mb-2">Cloud Providers</h3>
					<p class="text-sm text-muted-foreground mb-4">
						Cloud LLM providers with predefined models. API keys are stored locally in your browser.
					</p>
				</div>
				<div class="flex flex-col gap-6">
					${providers.map((provider) => html` <provider-key-input .provider=${provider}></provider-key-input> `)}
				</div>
			</div>
		`;
	}
}
