import { html, LitElement } from "lit";
import { customElement, property, query, state } from "lit/decorators.js";
import { createRef, ref } from "lit/directives/ref.js";
import type { MessageEditor, QuickModelOption } from "./MessageEditor.js"; //IYH1HC add: QuickModelOption
import { CoreServiceClient, type ActiveModel, type AttachmentPayload, type SseEvent, type WorkspaceTableRows } from "../adapters/core-service.js";
import type { Attachment } from "../utils/attachment-utils.js";
import "./MessageEditor.js";
import "./SandboxedIframe.js";
import type { SandboxIframe } from "./SandboxedIframe.js";
import "@mariozechner/mini-lit/dist/MarkdownBlock.js";
import "../tools/artifacts/MarkdownArtifact.js";
import "../tools/artifacts/PdfArtifact.js";
import "../tools/artifacts/TextArtifact.js";
import "../tools/artifacts/CsvArtifact.js";
import "../tools/artifacts/DataTableArtifact.js";

const TEXT_PREVIEW_EXTENSIONS = new Set([
	"js", "mjs", "cjs", "ts", "tsx", "jsx",
	"py", "rb", "go", "rs", "java", "kt", "scala", "swift", "dart",
	"c", "cc", "cpp", "cxx", "h", "hpp", "cs", "php",
	"sh", "bash", "zsh", "fish", "ps1", "bat",
	"html", "htm", "css", "scss", "sass", "less",
	"json", "jsonl", "xml", "yaml", "yml", "toml", "ini", "env",
	"sql", "r", "lua", "pl", "pm", "jl",
	"txt", "csv", "tsv", "log",
	"abap", "cds", "csn"
]);

const BINARY_PREVIEW_UNSUPPORTED_EXTENSIONS = new Set([
	"doc", "docx", "ppt", "pptx", "xls", "xlsx",
	"zip", "gz", "tar", "tgz", "7z", "rar",
]);

// ============================================================================
// File viewer sub-component
// ============================================================================

@customElement("core-service-file-viewer")
class CoreServiceFileViewer extends LitElement {
	@property() declare path: string;
	@property() declare title: string;
	@property() declare baseUrl: string;
	@property() declare authToken: string | null;

	@state() private declare content: string | null;
	@state() private declare mimeType: string;
	@state() private declare loading: boolean;
	@state() private declare artifactUrl: string | null;

	private sandboxRef = createRef<SandboxIframe>();

	constructor() {
		super();
		this.path = "";
		this.title = "";
		this.baseUrl = "";
		this.authToken = null;
		this.content = null;
		this.mimeType = "text/plain";
		this.loading = true;
		this.artifactUrl = null;
	}

	protected override createRenderRoot() { return this; }

	override async connectedCallback() {
		super.connectedCallback();
		await this.loadFile();
	}

	override async willUpdate(changed: Map<string, unknown>) {
		if (changed.has("path") && changed.get("path") !== undefined) {
			this.content = null;
			this.mimeType = "text/plain";
			this.artifactUrl = null;
			this.loading = true;
			await this.loadFile();
		}
	}

	private async loadFile() {
		if (!this.path) return;
		const client = new CoreServiceClient(this.baseUrl, () => this.authToken);
		const [result, artifactUrl] = await Promise.all([
			client.getFileContent(this.path),
			client.getArtifactUrl(this.path),
		]);
		if (result) {
			this.content = result.content;
			this.mimeType = result.mimeType.split(";")[0].trim();
		} else {
			this.content = null;
		}
		this.artifactUrl = artifactUrl;
		this.loading = false;
	}

	override updated() {
		if (this.isHtml && !this.artifactUrl && this.content && this.sandboxRef.value) {
			const sandboxId = `file-${this.path}`;
			this.sandboxRef.value.loadContent(sandboxId, this.content);
		}
	}

	private get isHtml() {
		return this.mimeType === "text/html";
	}

	private get isImage() {
		return this.mimeType.startsWith("image/");
	}

	private get extension() {
		return (this.title || this.path).split(".").pop()?.toLowerCase() || "";
	}

	private get isPdf() {
		return this.mimeType === "application/pdf" || this.extension === "pdf";
	}

	private get isMarkdown() {
		return this.extension === "md" || this.extension === "markdown" || this.mimeType === "text/markdown";
	}

	private get isCsv() {
		return this.extension === "csv" || this.mimeType === "text/csv";
	}

	private get isTextPreview() {
		return (
			!BINARY_PREVIEW_UNSUPPORTED_EXTENSIONS.has(this.extension) && (
			this.mimeType.startsWith("text/") ||
			this.mimeType.includes("json") ||
			this.mimeType.includes("xml") ||
			this.mimeType.includes("javascript") ||
			TEXT_PREVIEW_EXTENSIONS.has(this.extension)
			)
		);
	}

	private get fileUrl() {
		return this.artifactUrl ?? `${this.baseUrl}/file?path=${encodeURIComponent(this.path)}`;
	}

	private get downloadUrl() {
		const url = this.fileUrl;
		return `${url}${url.includes("?") ? "&" : "?"}download=1`;
	}

	override render() {
		const name = this.title || this.path.split("/").pop() || this.path;
		if (this.loading) {
			return html`<div class="text-xs text-muted-foreground italic">Loading ${name}…</div>`;
		}
		if (this.content === null) {
			return html`<div class="text-xs text-destructive">Could not load ${name}</div>`;
		}
		if (this.isHtml) {
			if (this.artifactUrl) {
				return html`<iframe src=${this.artifactUrl} style="display:block;width:100%;height:100%;min-height:400px;border:none"
					sandbox="allow-scripts allow-same-origin allow-modals allow-popups"></iframe>`;
			}
			return html`<sandbox-iframe ${ref(this.sandboxRef)} style="display:block;width:100%;height:400px"></sandbox-iframe>`;
		}
		if (this.isImage) {
			const src = `${this.baseUrl}/file?path=${encodeURIComponent(this.path)}`;
			return html`<img src=${src} class="max-w-full" alt=${name} />`;
		}
		const actualFilename = this.path.split("/").pop() || this.path;
		if (this.isPdf) {
			return html`<pdf-artifact class="block h-full" .filename=${actualFilename} .content=${this.content}></pdf-artifact>`;
		}
		if (this.isMarkdown) {
			return html`<markdown-artifact class="block h-full" .filename=${actualFilename} .content=${this.content}></markdown-artifact>`;
		}
		if (this.isCsv) {
			return html`<csv-artifact class="block h-full" .filename=${actualFilename} .content=${this.content}></csv-artifact>`;
		}
		if (this.isTextPreview) {
			return html`<text-artifact class="block h-full" .filename=${actualFilename} .content=${this.content}></text-artifact>`;
		}
		return html`
			<div class="flex h-full items-center justify-center p-6">
				<div class="flex max-w-sm flex-col items-center gap-3 text-center">
					<div class="text-sm font-medium text-foreground">${name}</div>
					<div class="text-xs text-muted-foreground">
						Preview is not available for this file type.
					</div>
					<a
						href=${this.downloadUrl}
						target="_blank"
						rel="noopener"
						download=${name}
						class="inline-flex h-9 items-center justify-center rounded-md border border-border bg-background px-4 text-sm font-medium text-foreground shadow-sm hover:bg-accent"
					>
						Download
					</a>
				</div>
			</div>
		`;
	}
}

type ChatMessage =
	| { role: "user"; text: string; attachments?: string[] }
	| { role: "assistant"; text: string; thread?: string; files?: FileRef[] }
	| { role: "error"; text: string };

type FileRef = { path: string; title?: string };
type TableRef = { databasePath: string; tableName: string; title?: string };

@customElement("core-service-table-viewer")
class CoreServiceTableViewer extends LitElement {
	@property() declare databasePath: string;
	@property() declare tableName: string;
	@property() declare baseUrl: string;
	@property() declare authToken: string | null;

	@state() private declare loading: boolean;
	@state() private declare table: WorkspaceTableRows | null;

	constructor() {
		super();
		this.databasePath = "";
		this.tableName = "";
		this.baseUrl = "";
		this.authToken = null;
		this.loading = true;
		this.table = null;
	}

	protected override createRenderRoot() { return this; }

	override async connectedCallback() {
		super.connectedCallback();
		await this.loadTable();
	}

	override async willUpdate(changed: Map<string, unknown>) {
		if ((changed.has("databasePath") && changed.get("databasePath") !== undefined) || (changed.has("tableName") && changed.get("tableName") !== undefined)) {
			this.loading = true;
			this.table = null;
			await this.loadTable();
		}
	}

	private async loadTable() {
		if (!this.databasePath || !this.tableName) return;
		const client = new CoreServiceClient(this.baseUrl, () => this.authToken);
		this.table = await client.getDatabaseTableRows(this.databasePath, this.tableName, 100, 0);
		this.loading = false;
	}

	override render() {
		if (this.loading) {
			return html`<div class="p-4 text-xs italic text-muted-foreground">Loading ${this.tableName}...</div>`;
		}
		if (!this.table) {
			return html`<div class="p-4 text-xs text-destructive">Could not load ${this.tableName}</div>`;
		}
		return html`
			<data-table-artifact
				class="block h-full"
				.columns=${this.table.columns}
				.rows=${this.table.rows}
				.totalRows=${this.table.totalRows}
				searchPlaceholder="Table rows..."
			></data-table-artifact>
		`;
	}
}

@customElement("core-service-chat-panel")
export class CoreServiceChatPanel extends LitElement {
	@property() declare baseUrl: string;
	@property() declare channelId: string;
	@property() declare userName: string | undefined;
	@property() declare authToken: string | null;

	@state() private declare messages: ChatMessage[];
	@state() private declare streamingText: string;
	@state() private declare streamingThread: string;
	@state() private declare streamingStatus: string;
	@state() private declare streamingFiles: FileRef[];
	@state() private declare isStreaming: boolean;
	@state() private declare rightPanelFile: FileRef | null;
	@state() private declare rightPanelTable: TableRef | null;
	@state() private declare rightPanelArtifactUrl: string | null;
	@state() private declare rightPanelWidth: number;
	//IYH1HC add: active models for the listbox + the user's current selection.
	@state() private declare activeModels: ActiveModel[];
	@state() private declare selectedModel: string;
	@state() private declare selectedReasoning: string; //IYH1HC add: reasoning level (UI state)

	@query("message-editor") private declare _editor: MessageEditor;

	private client!: CoreServiceClient;
	private abortController?: AbortController;
	private scrollContainer?: HTMLElement;
	private autoScroll = true;
	private resizingRightPanel = false;

	constructor() {
		super();
		this.baseUrl = "http://localhost:3030";
		this.channelId = "default";
		this.userName = undefined;
		this.authToken = null;
		this.messages = [];
		this.streamingText = "";
		this.streamingThread = "";
		this.streamingStatus = "";
		this.streamingFiles = [];
		this.isStreaming = false;
		this.rightPanelFile = null;
		this.rightPanelTable = null;
		this.rightPanelArtifactUrl = null;
		this.rightPanelWidth = Number(sessionStorage.getItem("core-service-preview-width") || "") || 480;
		this.activeModels = []; //IYH1HC add
		this.selectedModel = localStorage.getItem("core-service-selected-model") || ""; //IYH1HC add
		this.selectedReasoning = localStorage.getItem("core-service-reasoning") || "off"; //IYH1HC add
	}

	protected override createRenderRoot(): HTMLElement | DocumentFragment {
		return this;
	}

	override connectedCallback() {
		super.connectedCallback();
		this.client = new CoreServiceClient(this.baseUrl, () => this.authToken);
		this.style.display = "flex";
		this.style.flexDirection = "column";
		this.style.flex = "1";
		this.style.width = "100%";
		this.style.height = "100%";
		this.style.minHeight = "0";
		this.loadHistory();
		this.loadActiveModels(); //IYH1HC add
	}

	//IYH1HC add: fetch the user's active models; drop a stale selection if it vanished.
	private async loadActiveModels() {
		if (!this.client) return;
		this.activeModels = await this.client.getActiveModels();
		if (this.selectedModel && !this.activeModels.some((m) => `${m.provider}:${m.modelId}` === this.selectedModel)) {
			this.selectedModel = "";
			localStorage.removeItem("core-service-selected-model");
		}
	}

	//IYH1HC add: public hook so the app shell can refresh the listbox right after the
	// user edits active models in the LLM provider dialog (no full page reload needed).
	async refreshActiveModels(): Promise<void> {
		await this.loadActiveModels();
		this.requestUpdate();
	}

	//IYH1HC add: parse the "provider:modelId" listbox value into a chat() model arg.
	private parseSelectedModel(): { provider: string; modelId: string } | undefined {
		if (!this.selectedModel) return undefined;
		const found = this.activeModels.find((m) => `${m.provider}:${m.modelId}` === this.selectedModel);
		return found ? { provider: found.provider, modelId: found.modelId } : undefined;
	}

	private onSelectModel(value: string) {
		this.selectedModel = value;
		if (value) localStorage.setItem("core-service-selected-model", value);
		else localStorage.removeItem("core-service-selected-model");
	}

	//IYH1HC add: reasoning level handler for the inline quick selector (UI state only for now).
	private onSelectReasoning(level: string) {
		this.selectedReasoning = level;
		localStorage.setItem("core-service-reasoning", level);
	}

	//IYH1HC add: active models shaped for the editor's inline model quick-pick popover.
	private quickModelOptions(): QuickModelOption[] {
		return this.activeModels.map((m) => ({ value: `${m.provider}:${m.modelId}`, label: m.label, provider: m.provider }));
	}

	override disconnectedCallback() {
		super.disconnectedCallback();
		this.stopRightPanelResize();
	}

	override willUpdate(changed: Map<string, unknown>) {
		if (changed.has("channelId") && changed.get("channelId") !== undefined) {
			// channelId changed after initial connect — reset and reload
			this.messages = [];
			this.streamingText = "";
			this.streamingThread = "";
			this.streamingStatus = "";
			this.streamingFiles = [];
			this.isStreaming = false;
			this.rightPanelFile = null;
			this.rightPanelArtifactUrl = null;
			this.scrollContainer = undefined;
			this.loadHistory();
		}
	}

	private async loadHistory() {
		const msgs = await this.client.getMessages(this.channelId);
		this.messages = msgs.map((m) => ({ role: m.role, text: m.text, thread: (m as any).thread, files: (m as any).files, attachments: (m as any).attachments }));
		this.autoScroll = true;
	}

	override updated() {
		if (!this.scrollContainer) {
			this.scrollContainer = this.querySelector(".overflow-y-auto") as HTMLElement;
			if (this.scrollContainer) {
				this.scrollContainer.addEventListener("scroll", this.handleScroll);
			}
		}
		if (this.autoScroll && this.scrollContainer) {
			this.scrollContainer.scrollTop = this.scrollContainer.scrollHeight;
		}
	}

	private handleScroll = () => {
		if (!this.scrollContainer) return;
		const { scrollTop, scrollHeight, clientHeight } = this.scrollContainer;
		this.autoScroll = scrollHeight - scrollTop - clientHeight < 50;
	};

	private async handleSend(text: string, attachments: Attachment[] = []) {
		if (!text.trim() && attachments.length === 0) return;
		if (this.isStreaming) return;

		const attachmentNames = attachments.map((a) => a.fileName);
	this.messages = [...this.messages, { role: "user", text, attachments: attachmentNames.length > 0 ? attachmentNames : undefined }];
		if (this._editor) {
			this._editor.value = "";
			this._editor.attachments = [];
		}
		this.streamingText = "";
		this.streamingThread = "";
		this.streamingStatus = "";
		this.streamingFiles = [];
		this.isStreaming = true;
		this.autoScroll = true;

		const attachmentPayloads: AttachmentPayload[] = attachments.map((a) => ({
			fileName: a.fileName,
			mimeType: a.mimeType,
			content: a.content,
		}));

		this.abortController = new AbortController();
		try {
			for await (const event of this.client.chat(this.channelId, text, this.userName, this.abortController.signal, attachmentPayloads, this.parseSelectedModel())) {
				this.handleSseEvent(event);
			}
		} catch (err: any) {
			if (err.name !== "AbortError") {
				this.messages = [...this.messages, { role: "error", text: String(err) }];
			}
		} finally {
			const hasContent = this.streamingText || this.streamingThread || this.streamingFiles.length > 0;
			if (hasContent) {
				this.messages = [
					...this.messages,
					{
						role: "assistant",
						text: this.streamingText,
						thread: this.streamingThread || undefined,
						files: this.streamingFiles.length > 0 ? [...this.streamingFiles] : undefined,
					},
				];
			}
			this.streamingText = "";
			this.streamingThread = "";
			this.streamingStatus = "";
			this.streamingFiles = [];
			this.isStreaming = false;
		}
	}

	private handleSseEvent(event: SseEvent) {
		switch (event.type) {
			case "delta":
				this.streamingText += event.text;
				break;
			case "replace":
				this.streamingText = event.text;
				break;
			case "thread":
				this.streamingThread += event.text;
				break;
			case "status":
				this.streamingStatus = event.status;
				break;
			case "file":
				this.streamingFiles = [...this.streamingFiles, { path: event.path, title: event.title }];
				break;
			case "delete":
				// Bot deleted its current response — clear accumulated text
				this.streamingText = "";
				break;
			case "error":
				this.messages = [...this.messages, { role: "error", text: event.message }];
				break;
			case "done":
				// Stream ends naturally; finally block commits the message
				break;
		}
	}

	private handleAbort() {
		this.abortController?.abort();
		this.client.stop(this.channelId);
	}

	override render() {
		const isEmpty = this.messages.length === 0 && !this.isStreaming;

		return html`
			<div class="flex flex-row h-full bg-background text-foreground overflow-hidden">
				<!-- Chat Column -->
				<div class="relative flex flex-col flex-1 min-w-0 min-h-0 h-full">
					${
						isEmpty
							? html`
								<div class="absolute inset-0 flex items-center justify-center px-6">
									<div class="w-full max-w-3xl -translate-y-12">
										<div class="text-center text-2xl md:text-3xl font-medium mb-8">What's can I help?</div>
										<message-editor
											.isStreaming=${this.isStreaming}
											.showAttachmentButton=${true}
											.showModelSelector=${false}
											.showThinkingSelector=${false}
											.useQuickSelector=${true}
											.quickModels=${this.quickModelOptions()}
											.selectedModelValue=${this.selectedModel}
											.onModelChange=${(v: string) => { this.onSelectModel(v); this.requestUpdate(); }}
											.thinkingLevel=${this.selectedReasoning}
											.onThinkingChange=${(level: string) => { this.onSelectReasoning(level); this.requestUpdate(); }}
											.onSend=${(text: string, attachments: Attachment[]) => this.handleSend(text, attachments)}
											.onAbort=${() => this.handleAbort()}
										></message-editor>
									</div>
								</div>
							`
							: html`
								<!-- Messages Area -->
								<div class="flex-1 min-h-0 overflow-y-auto">
									<div class="max-w-3xl mx-auto p-4 pb-6 flex flex-col gap-3">
										${this.messages.map((msg) => this.renderMessage(msg))}
										${this.isStreaming ? this.renderStreaming() : ""}
									</div>
								</div>

								<!-- Input Area -->
								<div class="mt-auto shrink-0">
									<div class="max-w-3xl mx-auto px-2 pb-4">
										<message-editor
											.isStreaming=${this.isStreaming}
											.showAttachmentButton=${true}
											.showModelSelector=${false}
											.showThinkingSelector=${false}
											.useQuickSelector=${true}
											.quickModels=${this.quickModelOptions()}
											.selectedModelValue=${this.selectedModel}
											.onModelChange=${(v: string) => { this.onSelectModel(v); this.requestUpdate(); }}
											.thinkingLevel=${this.selectedReasoning}
											.onThinkingChange=${(level: string) => { this.onSelectReasoning(level); this.requestUpdate(); }}
											.onSend=${(text: string, attachments: Attachment[]) => this.handleSend(text, attachments)}
											.onAbort=${() => this.handleAbort()}
										></message-editor>
									</div>
								</div>
							`
					}
						</div>

				<!-- Right Panel -->
				${this.rightPanelFile ? this.renderFileRightPanel(this.rightPanelFile) : ""}
				${this.rightPanelTable ? this.renderTableRightPanel(this.rightPanelTable) : ""}
			</div>
		`;
	}

	private openRightPanel(f: FileRef) {
		this.rightPanelFile = f;
		this.rightPanelTable = null;
		this.rightPanelArtifactUrl = null;
		this.dispatchEvent(new CustomEvent("file-preview-open", {
			bubbles: true,
			composed: true,
			detail: f,
		}));
		this.client.getArtifactUrl(f.path).then((url) => { this.rightPanelArtifactUrl = url; });
	}

	public openFilePreview(path: string, title?: string) {
		this.openRightPanel({ path, title });
	}

	public openTablePreview(databasePath: string, tableName: string, title?: string) {
		this.rightPanelFile = null;
		this.rightPanelTable = { databasePath, tableName, title };
		this.rightPanelArtifactUrl = null;
		this.dispatchEvent(new CustomEvent("file-preview-open", {
			bubbles: true,
			composed: true,
			detail: this.rightPanelTable,
		}));
	}

	private startRightPanelResize(event: PointerEvent) {
		event.preventDefault();
		this.resizingRightPanel = true;
		document.body.style.cursor = "col-resize";
		document.body.style.userSelect = "none";
		window.addEventListener("pointermove", this.handleRightPanelResize);
		window.addEventListener("pointerup", this.stopRightPanelResize);
		window.addEventListener("pointercancel", this.stopRightPanelResize);
	}

	private handleRightPanelResize = (event: PointerEvent) => {
		if (!this.resizingRightPanel) return;
		const bounds = this.getBoundingClientRect();
		const minWidth = 320;
		const maxWidth = Math.max(minWidth, bounds.width - 360);
		const nextWidth = Math.round(Math.min(maxWidth, Math.max(minWidth, bounds.right - event.clientX)));
		this.rightPanelWidth = nextWidth;
		sessionStorage.setItem("core-service-preview-width", String(nextWidth));
	};

	private stopRightPanelResize = () => {
		if (!this.resizingRightPanel) return;
		this.resizingRightPanel = false;
		document.body.style.cursor = "";
		document.body.style.userSelect = "";
		window.removeEventListener("pointermove", this.handleRightPanelResize);
		window.removeEventListener("pointerup", this.stopRightPanelResize);
		window.removeEventListener("pointercancel", this.stopRightPanelResize);
	};

	private renderFileRightPanel(f: FileRef) {
		const name = f.title || f.path.split("/").pop() || f.path;
		return html`
			<div
				class="w-1.5 shrink-0 cursor-col-resize border-l border-border bg-background hover:bg-accent"
				title="Resize preview"
				@pointerdown=${this.startRightPanelResize}
			></div>
			<div class="flex flex-col shrink-0 h-full" style="width: ${this.rightPanelWidth}px">
				<div class="flex items-center justify-between px-3 py-2 border-b border-border bg-muted/30 shrink-0">
					<span class="text-sm font-medium truncate">${name}</span>
					<div class="flex items-center gap-3 ml-2 shrink-0">
						${this.rightPanelArtifactUrl ? html`
							<a href=${this.rightPanelArtifactUrl} target="_blank" rel="noopener"
								class="text-xs text-muted-foreground hover:text-foreground">open ↗</a>
						` : ""}
						<button class="text-muted-foreground hover:text-foreground"
							@click=${() => { this.rightPanelFile = null; }}>✕</button>
					</div>
				</div>
				<div class="flex-1 overflow-auto">
					<core-service-file-viewer
						.path=${f.path}
						.title=${f.title || ""}
						.baseUrl=${this.baseUrl}
						.authToken=${this.authToken}
					></core-service-file-viewer>
				</div>
			</div>
		`;
	}

	private renderTableRightPanel(table: TableRef) {
		const name = table.title || table.tableName;
		return html`
			<div
				class="w-1.5 shrink-0 cursor-col-resize border-l border-border bg-background hover:bg-accent"
				title="Resize preview"
				@pointerdown=${this.startRightPanelResize}
			></div>
			<div class="flex flex-col shrink-0 h-full" style="width: ${this.rightPanelWidth}px">
				<div class="flex items-center justify-between px-3 py-2 border-b border-border bg-muted/30 shrink-0">
					<span class="text-sm font-medium truncate">${name}</span>
					<button class="text-muted-foreground hover:text-foreground"
						@click=${() => { this.rightPanelTable = null; }}>✕</button>
				</div>
				<div class="flex-1 overflow-hidden">
					<core-service-table-viewer
						.databasePath=${table.databasePath}
						.tableName=${table.tableName}
						.baseUrl=${this.baseUrl}
						.authToken=${this.authToken}
					></core-service-table-viewer>
				</div>
			</div>
		`;
	}

	private renderThreadBlock(block: string) {
		const nlIdx = block.indexOf("\n");
		const header = nlIdx === -1 ? block : block.slice(0, nlIdx);
		const body = nlIdx === -1 ? "" : block.slice(nlIdx + 1).trim();
		// Strip bold/italic markers: **✓ write** or *✓ write* → ✓ write
		const cleanHeader = header.replace(/\*+/g, "");

		if (!body) {
			return html`<div class="py-0.5 text-muted-foreground">${cleanHeader}</div>`;
		}
		return html`
			<details class="group">
				<summary class="cursor-pointer flex items-center gap-1.5 py-0.5 text-muted-foreground hover:text-foreground select-none [&::-webkit-details-marker]:hidden [&::marker]:hidden">
					<span class="text-[10px] transition-transform duration-150 group-open:rotate-90">▶</span>
					<span>${cleanHeader}</span>
				</summary>
				<div class="mt-1 ml-3.5">
					<markdown-block .content=${body}></markdown-block>
				</div>
			</details>
		`;
	}

	private renderThread(thread: string) {
		// Split into per-tool blocks: starts with success/error/progress markers.
		const blocks = thread.split(/\n(?=\*{1,2}[✓✗…])/).filter(Boolean);
		return html`
			<div class="flex flex-col border-l-2 border-border pl-3 text-sm">
				${blocks.map((b) => this.renderThreadBlock(b))}
			</div>
		`;
	}

	private renderMessage(msg: ChatMessage) {
		if (msg.role === "user") {
			return html`
				<div class="flex justify-start mx-4">
					<div class="user-message-container py-2 px-4 rounded-xl flex flex-col gap-2">
						${msg.attachments?.map((name) => html`
							<div class="flex items-center gap-1.5 text-xs opacity-70">
								<span>📎</span><span class="truncate max-w-xs">${name}</span>
							</div>
						`)}
						<markdown-block .content=${msg.text}></markdown-block>
					</div>
				</div>
			`;
		}
		if (msg.role === "assistant") {
			return html`
				<div class="px-4 flex flex-col gap-3">
					${msg.text ? html`<markdown-block .content=${msg.text}></markdown-block>` : ""}
					${msg.thread ? this.renderThread(msg.thread) : ""}
					${msg.files?.map((f) => this.renderFile(f))}
				</div>
			`;
		}
		if (msg.role === "error") {
			return html`
				<div class="mx-4 p-3 bg-destructive/10 text-destructive rounded-lg text-sm">
					<strong>Error:</strong> ${msg.text}
				</div>
			`;
		}
		return "";
	}

	private renderFile(f: FileRef) {
		const name = f.title || f.path.split("/").pop() || f.path;
		const isActive = this.rightPanelFile?.path === f.path;
		return html`
			<button
				class="flex items-center gap-2 px-3 py-2 rounded-lg border text-sm text-left transition-colors
					${isActive
						? "border-primary bg-primary/10 text-primary"
						: "border-border bg-muted/30 hover:bg-muted/60 text-foreground"}"
				@click=${() => this.openRightPanel(f)}
			>
				<span>📄</span>
				<span class="truncate">${name}</span>
				<span class="ml-auto text-xs text-muted-foreground shrink-0">open ↗</span>
			</button>
		`;
	}

	private renderStreaming() {
		const hasContent = this.streamingText || this.streamingThread || this.streamingFiles.length > 0;

		if (!hasContent) {
			const label = this.streamingStatus || "thinking";
			return html`<div class="px-4 text-sm text-muted-foreground italic animate-pulse">${label}...</div>`;
		}
		return html`
			<div class="px-4 flex flex-col gap-3">
				${this.streamingStatus
					? html`<div class="text-xs text-muted-foreground italic">${this.streamingStatus}...</div>`
					: ""}
				${this.streamingText ? html`<markdown-block .content=${this.streamingText}></markdown-block>` : ""}
				${this.streamingThread ? this.renderThread(this.streamingThread) : ""}
				${this.streamingFiles.map((f) => this.renderFile(f))}
			</div>
		`;
	}
}
