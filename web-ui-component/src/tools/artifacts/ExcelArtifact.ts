import { DownloadButton } from "@mariozechner/mini-lit/dist/DownloadButton.js";
import { html, type TemplateResult } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { i18n } from "../../utils/i18n.js";
import { ArtifactElement } from "./ArtifactElement.js";

@customElement("excel-artifact")
export class ExcelArtifact extends ArtifactElement {
	@property({ type: String }) private _content = "";
	@state() private error: string | null = null;

	get content(): string {
		return this._content;
	}

	set content(value: string) {
		this._content = value;
		this.error = null;
		this.requestUpdate();
	}

	protected override createRenderRoot(): HTMLElement | DocumentFragment {
		return this;
	}

	override connectedCallback(): void {
		super.connectedCallback();
		this.style.display = "block";
		this.style.height = "100%";
	}

	private base64ToArrayBuffer(base64: string): ArrayBuffer {
		// Remove data URL prefix if present
		let base64Data = base64;
		if (base64.startsWith("data:")) {
			const base64Match = base64.match(/base64,(.+)/);
			if (base64Match) {
				base64Data = base64Match[1];
			}
		}

		const binaryString = atob(base64Data);
		const bytes = new Uint8Array(binaryString.length);
		for (let i = 0; i < binaryString.length; i++) {
			bytes[i] = binaryString.charCodeAt(i);
		}
		return bytes.buffer;
	}

	private decodeBase64(): Uint8Array {
		let base64Data = this._content;
		if (this._content.startsWith("data:")) {
			const base64Match = this._content.match(/base64,(.+)/);
			if (base64Match) {
				base64Data = base64Match[1];
			}
		}

		const binaryString = atob(base64Data);
		const bytes = new Uint8Array(binaryString.length);
		for (let i = 0; i < binaryString.length; i++) {
			bytes[i] = binaryString.charCodeAt(i);
		}
		return bytes;
	}

	private getMimeType(): string {
		const ext = this.filename.split(".").pop()?.toLowerCase();
		if (ext === "xls") return "application/vnd.ms-excel";
		return "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
	}

	public getHeaderButtons() {
		return html`
			<div class="flex items-center gap-1">
				${DownloadButton({
					content: this.decodeBase64(),
					filename: this.filename,
					mimeType: this.getMimeType(),
					title: i18n("Download"),
				})}
			</div>
		`;
	}

	override render(): TemplateResult {
		return html`
			<div class="h-full flex items-center justify-center bg-background p-4">
				<div class="text-center">
					<div class="text-muted-foreground mb-4">${i18n("Preview not available for this file type.")}</div>
				</div>
			</div>
		`;
	}
}

declare global {
	interface HTMLElementTagNameMap {
		"excel-artifact": ExcelArtifact;
	}
}
