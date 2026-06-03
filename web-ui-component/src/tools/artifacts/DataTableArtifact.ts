import { html, LitElement } from "lit";
import { customElement, property, state } from "lit/decorators.js";

export type DataTableColumn = {
	name: string;
	type?: string;
};

@customElement("data-table-artifact")
export class DataTableArtifact extends LitElement {
	@property({ attribute: false }) declare columns: DataTableColumn[];
	@property({ attribute: false }) declare rows: unknown[][];
	@property({ type: Number }) declare totalRows: number;
	@property() declare searchPlaceholder: string;

	@state() private search = "";

	constructor() {
		super();
		this.columns = [];
		this.rows = [];
		this.totalRows = 0;
		this.searchPlaceholder = "Search rows...";
	}

	protected override createRenderRoot(): HTMLElement | DocumentFragment {
		return this;
	}

	private stringify(value: unknown): string {
		if (value === null || value === undefined) return "";
		if (value instanceof Date) return value.toISOString();
		if (typeof value === "object") return JSON.stringify(value);
		return String(value);
	}

	private get filteredRows() {
		const search = this.search.trim().toLowerCase();
		if (!search) return this.rows;
		return this.rows.filter((row) => row.some((cell) => this.stringify(cell).toLowerCase().includes(search)));
	}

	override render() {
		const rows = this.filteredRows;
		const fieldCount = this.columns.length || this.rows.reduce((max, row) => Math.max(max, row.length), 0);
		const totalRows = this.totalRows || this.rows.length;

		return html`<div class="flex h-full flex-col bg-background">
			<div class="flex shrink-0 flex-wrap items-center gap-2 border-b border-border p-3">
				<label class="flex h-8 min-w-48 max-w-72 flex-1 items-center rounded-md border border-border bg-muted/30 px-2 text-xs">
					<span class="mr-2 text-muted-foreground">Search</span>
					<input
						class="min-w-0 flex-1 bg-transparent outline-none placeholder:text-muted-foreground"
						.value=${this.search}
						@input=${(event: InputEvent) => { this.search = (event.target as HTMLInputElement).value; }}
						placeholder=${this.searchPlaceholder}
					/>
				</label>
				<span class="rounded-md bg-muted px-2 py-1 text-xs text-muted-foreground">${totalRows} entries</span>
				<span class="rounded-md bg-muted px-2 py-1 text-xs text-muted-foreground">${fieldCount} fields</span>
			</div>

			<div class="min-h-0 flex-1 overflow-auto">
				<table class="min-w-full border-separate border-spacing-0 text-sm">
					<thead>
						<tr>
							<th class="sticky left-0 top-0 z-20 w-12 border-b border-r border-border bg-background px-3 py-2 text-left text-xs font-medium text-muted-foreground"></th>
							${Array.from({ length: fieldCount }, (_, index) => {
								const column = this.columns[index];
								return html`
									<th class="sticky top-0 z-10 min-w-44 max-w-80 border-b border-r border-border bg-background px-3 py-2 text-left font-semibold text-muted-foreground">
										<div class="truncate">${column?.name || `Field ${index + 1}`}</div>
										${column?.type ? html`<div class="truncate text-[10px] font-normal opacity-70">${column.type}</div>` : ""}
									</th>
								`;
							})}
						</tr>
					</thead>
					<tbody>
						${rows.map((row, rowIndex) => html`
							<tr class="hover:bg-muted/40">
								<td class="sticky left-0 z-10 border-b border-r border-border bg-background px-3 py-2 text-xs text-muted-foreground">${rowIndex + 1}</td>
								${Array.from({ length: fieldCount }, (_, columnIndex) => {
									const value = this.stringify(row[columnIndex]);
									return html`
										<td class="max-w-80 border-b border-r border-border px-3 py-2 text-muted-foreground">
											<div class="truncate" title=${value}>${value}</div>
										</td>
									`;
								})}
							</tr>
						`)}
					</tbody>
				</table>
				${rows.length === 0
					? html`<div class="p-6 text-center text-sm text-muted-foreground">No rows</div>`
					: ""}
			</div>
		</div>`;
	}
}

declare global {
	interface HTMLElementTagNameMap {
		"data-table-artifact": DataTableArtifact;
	}
}
