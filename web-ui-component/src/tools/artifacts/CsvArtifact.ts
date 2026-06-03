import { DownloadButton } from "@mariozechner/mini-lit/dist/DownloadButton.js";
import { html } from "lit";
import { customElement, property } from "lit/decorators.js";
import { i18n } from "../../utils/i18n.js";
import { ArtifactElement } from "./ArtifactElement.js";
import "./DataTableArtifact.js";

@customElement("csv-artifact")
export class CsvArtifact extends ArtifactElement {
	@property() override filename = "";

	private _content = "";
	override get content(): string {
		return this._content;
	}
	override set content(value: string) {
		this._content = value;
		this.requestUpdate();
	}

	protected override createRenderRoot(): HTMLElement | DocumentFragment {
		return this;
	}

	private parseCsv(text: string): string[][] {
		const rows: string[][] = [];
		let currentRow: string[] = [];
		let currentCell = "";
		let inQuotes = false;
		const normalized = text.replace(/\r\n/g, "\n");
		for (let i = 0; i < normalized.length; i++) {
			const ch = normalized[i];
			const next = normalized[i + 1];
			if (ch === "\"") {
				if (inQuotes && next === "\"") {
					currentCell += "\"";
					i++;
				} else {
					inQuotes = !inQuotes;
				}
				continue;
			}
			if (ch === "," && !inQuotes) {
				currentRow.push(currentCell);
				currentCell = "";
				continue;
			}
			if (ch === "\n" && !inQuotes) {
				currentRow.push(currentCell);
				rows.push(currentRow);
				currentRow = [];
				currentCell = "";
				continue;
			}
			currentCell += ch;
		}
		if (currentCell.length > 0 || currentRow.length > 0) {
			currentRow.push(currentCell);
			rows.push(currentRow);
		}
		return rows;
	}

	private getTable() {
		const rows = this.parseCsv(this.content);
		const headers = rows[0] ?? [];
		const bodyRows = rows.slice(1);
		return {
			columns: headers.map((name, index) => ({ name: name || `Field ${index + 1}` })),
			rows: bodyRows,
			totalRows: bodyRows.length,
		};
	}

	public getHeaderButtons() {
		return html`${DownloadButton({ content: this.content, filename: this.filename, mimeType: "text/csv", title: i18n("Download CSV") })}`;
	}

	override render() {
		const table = this.getTable();
		return html`
			<data-table-artifact
				class="block h-full"
				.columns=${table.columns}
				.rows=${table.rows}
				.totalRows=${table.totalRows}
				searchPlaceholder="CSV rows..."
			></data-table-artifact>
		`;
	}
}

declare global {
	interface HTMLElementTagNameMap {
		"csv-artifact": CsvArtifact;
	}
}
