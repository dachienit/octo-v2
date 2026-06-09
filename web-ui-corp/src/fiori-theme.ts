import "@ui5/webcomponents/dist/Assets.js";
import "@ui5/webcomponents/dist/Button.js";
import "@ui5/webcomponents/dist/CheckBox.js";
import "@ui5/webcomponents/dist/Input.js";
import "@ui5/webcomponents/dist/Option.js";
import "@ui5/webcomponents/dist/Select.js";
import "@ui5/webcomponents/dist/Switch.js";
import "@ui5/webcomponents/dist/TextArea.js";
import "@ui5/webcomponents-fiori/dist/Assets.js";
import "@ui5/webcomponents-icons/dist/add.js";
import "@ui5/webcomponents-icons/dist/bell.js";
import "@ui5/webcomponents-icons/dist/dark-mode.js";
import "@ui5/webcomponents-icons/dist/decline.js";
import "@ui5/webcomponents-icons/dist/employee.js";
import "@ui5/webcomponents-icons/dist/folder-blank.js";
import "@ui5/webcomponents-icons/dist/Assets.js";
import "@ui5/webcomponents-icons/dist/light-mode.js";
import "@ui5/webcomponents-icons/dist/navigation-left-arrow.js";
import "@ui5/webcomponents-icons/dist/navigation-right-arrow.js";
import "@ui5/webcomponents-icons/dist/navigation-down-arrow.js";
import "@ui5/webcomponents-icons/dist/refresh.js";
import "@ui5/webcomponents-icons/dist/settings.js";
import { setTheme } from "@ui5/webcomponents-base/dist/config/Theme.js";

export const CORPORATE_FIORI_THEME = "sap_horizon";
export const CORPORATE_FIORI_DARK_THEME = "sap_horizon_dark";

let darkModeObserver: MutationObserver | undefined;
let activeTheme = "";

async function applyTheme(theme: string) {
	if (activeTheme === theme) return;
	activeTheme = theme;
	await setTheme(theme);
}

function getThemeForDocument() {
	return document.documentElement.classList.contains("dark") ? CORPORATE_FIORI_DARK_THEME : CORPORATE_FIORI_THEME;
}

export async function configureFioriTheme(theme?: string) {
	if (theme) {
		darkModeObserver?.disconnect();
		darkModeObserver = undefined;
		await applyTheme(theme);
		return;
	}

	await applyTheme(getThemeForDocument());

	darkModeObserver ??= new MutationObserver(() => {
		void applyTheme(getThemeForDocument());
	});
	darkModeObserver.observe(document.documentElement, {
		attributeFilter: ["class"],
		attributes: true,
	});
}
