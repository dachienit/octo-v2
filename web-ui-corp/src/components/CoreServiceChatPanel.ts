import { html, LitElement } from "lit";
import { customElement, property, query, state } from "lit/decorators.js";
import { createRef, ref } from "lit/directives/ref.js";
import { icon } from "@mariozechner/mini-lit"; //IYH1HC add
//IYH1HC stream comment import { Sparkles } from "lucide"; //IYH1HC add
//IYH1HC comment import { Check, Loader, Sparkles, X, Zap } from "lucide"; //IYH1HC stream add: tool status + token counter icons
import { Check, Download, Loader, Sparkles, X, Zap } from "lucide"; //IYH1HC add: Download icon for file chip download button
import type { MessageEditor, QuickModelOption } from "./MessageEditor.js"; //IYH1HC add: QuickModelOption
//IYH1HC stream comment import { CoreServiceClient, type ActiveModel, type AttachmentPayload, type SseEvent, type WorkspaceTableRows } from "../adapters/core-service.js";
import { CoreServiceClient, type ActiveModel, type AgentUsage, type AttachmentPayload, type ReplayBlock, type SseEvent, type WorkspaceTableRows } from "../adapters/core-service.js"; //IYH1HC stream add
import "./ThinkingBlock.js"; //IYH1HC stream add: reuse the collapsible thinking renderer
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

//IYH1HC stream add: ordered structured trail block — built live from SSE trail events
// and reconstructed from replay blocks on page reload.
type StreamBlock =
	//IYH1HC stream add(w2): `target` = full received text, `content` = revealed portion —
	// a rAF loop drains target→content a few chars per frame for a smooth typewriter feel.
	// `ended` marks that the authoritative block-end event arrived.
	| { kind: "text"; id: string; content: string; streaming: boolean; target?: string; ended?: boolean }
	| { kind: "thinking"; id: string; content: string; streaming: boolean; target?: string; ended?: boolean }
	| {
		kind: "tool";
		id: string; // toolCallId
		toolName: string;
		label?: string;
		args?: Record<string, unknown>;
		partialResult?: string;
		result?: string;
		resultTruncated?: boolean;
		isError?: boolean;
		durationMs?: number;
		status: "calling" | "running" | "done" | "error" | "aborted";
		skill?: { name: string; path: string };
	}
	| { kind: "event"; id: string; variant: "compaction" | "retry"; text: string }
	| { kind: "usage"; id: string; scope: "message" | "run"; usage: AgentUsage; model?: { provider: string; id: string }; contextTokens?: number; contextWindow?: number };

//IYH1HC stream comment type ChatMessage =
//IYH1HC stream comment 	| { role: "user"; text: string; attachments?: string[] }
//IYH1HC stream comment 	| { role: "assistant"; text: string; thread?: string; files?: FileRef[] }
//IYH1HC stream comment 	| { role: "error"; text: string };
type ChatMessage =
	| { role: "user"; text: string; attachments?: string[] }
	| { role: "assistant"; text: string; thread?: string; files?: FileRef[]; blocks?: StreamBlock[]; usage?: AgentUsage; model?: string } //IYH1HC stream add: blocks + usage + model
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
	@property() declare agentName: string; //IYH1HC add: display name for the assistant (host sets the brand)
	@property() declare authToken: string | null;

	@state() private declare messages: ChatMessage[];
	@state() private declare streamingText: string;
	@state() private declare streamingThread: string;
	@state() private declare streamingStatus: string;
	@state() private declare streamingFiles: FileRef[];
	@state() private declare isStreaming: boolean;
	//IYH1HC stream add: ordered structured trail committed once per animation frame
	@state() private declare streamingBlocks: StreamBlock[];
	//IYH1HC stream add: live token counter display (ticking estimate + authoritative snaps)
	@state() private declare liveTokenLabel: string;
	@state() private declare elapsedSec: number;
	//IYH1HC stream add(w2): model currently serving the run (from usage events)
	@state() private declare currentModel: string;
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
	//IYH1HC stream add(w2): last observed scrollTop — used to tell an upward USER scroll
	// (stop auto-follow) apart from a downward programmatic scroll (keep following).
	private lastScrollTop = 0;
	//IYH1HC stream add(w2): watches the message list height and pins to the bottom whenever it
	// grows (typewriter reveal, tool blocks, images) — independent of Lit's update timing, so
	// auto-follow never gets "stuck" the way an updated()-only approach did.
	private contentResizeObserver?: ResizeObserver;
	private observedContent?: Element;
	private resizingRightPanel = false;

	//IYH1HC stream add: non-reactive streaming buffers — mutated per SSE event, committed to
	// reactive state once per requestAnimationFrame (pattern from StreamingMessageContainer).
	private blockOrder: StreamBlock[] = [];
	private blockIndex = new Map<string, StreamBlock>();
	private structuredSeen = false;
	private rafPending = false;
	//IYH1HC stream add(w2): typewriter reveal loop — persistent rAF while a run streams
	private revealRafId: number | null = null;
	private pendingCommit = false;
	private runUsage: AgentUsage | null = null;
	// Live token counter: authoritative output tokens accumulate on each usage event;
	// between snaps the count ticks from received delta chars (~4 chars/token, "~" prefix).
	private authOutputTokens = 0;
	private estCharsSinceUsage = 0;
	private hasAuthUsage = false;
	private streamStartMs = 0;
	private elapsedTimer: ReturnType<typeof setInterval> | null = null;

	constructor() {
		super();
		this.baseUrl = "http://localhost:3030";
		this.channelId = "default";
		this.userName = undefined;
		this.agentName = "Assistant"; //IYH1HC add: brand-neutral default; host (web-app-corp) overrides
		this.authToken = null;
		this.messages = [];
		this.streamingText = "";
		this.streamingThread = "";
		this.streamingStatus = "";
		this.streamingFiles = [];
		this.isStreaming = false;
		this.streamingBlocks = []; //IYH1HC stream add
		this.liveTokenLabel = ""; //IYH1HC stream add
		this.elapsedSec = 0; //IYH1HC stream add
		this.currentModel = ""; //IYH1HC stream add(w2)
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
		//IYH1HC stream add: never leak the elapsed-time ticker
		if (this.elapsedTimer) {
			clearInterval(this.elapsedTimer);
			this.elapsedTimer = null;
		}
		//IYH1HC stream add(w2): tear down the auto-follow watcher + reveal loop
		this.contentResizeObserver?.disconnect();
		this.contentResizeObserver = undefined;
		this.observedContent = undefined;
		this.stopRevealLoop();
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
			this.resetStreamBuffers(); //IYH1HC stream add
			this.rightPanelFile = null;
			this.rightPanelArtifactUrl = null;
			this.scrollContainer = undefined;
			this.autoScroll = true; //IYH1HC stream add(w2): fresh channel starts pinned to bottom
			this.lastScrollTop = 0; //IYH1HC stream add(w2)
			//IYH1HC stream add(w2): drop the old observer so updated() re-attaches to the new list
			this.observedContent = undefined;
			this.loadHistory();
		}
	}

	private async loadHistory() {
		const msgs = await this.client.getMessages(this.channelId);
		//IYH1HC stream comment this.messages = msgs.map((m) => ({ role: m.role, text: m.text, thread: (m as any).thread, files: (m as any).files, attachments: (m as any).attachments }));
		//IYH1HC stream add: map structured replay blocks so a reload shows the same trail
		this.messages = msgs.map((m) => ({
			role: m.role,
			text: m.text,
			thread: m.thread,
			files: m.files,
			attachments: m.attachments,
			blocks: m.role === "assistant" && m.blocks ? m.blocks.map((b, i) => this.replayBlockToStreamBlock(b, i)) : undefined,
			usage: m.role === "assistant" ? m.usage : undefined,
			model: m.role === "assistant" ? m.model : undefined, //IYH1HC stream add(w2)
		}));
		this.autoScroll = true;
	}

	//IYH1HC stream add: convert a server ReplayBlock into the shared StreamBlock render model.
	private replayBlockToStreamBlock(b: ReplayBlock, index: number): StreamBlock {
		if (b.kind === "text") return { kind: "text", id: `replay-${index}`, content: b.content, streaming: false };
		if (b.kind === "thinking") return { kind: "thinking", id: `replay-${index}`, content: b.content, streaming: false };
		return {
			kind: "tool",
			id: b.toolCallId || `replay-${index}`,
			toolName: b.toolName,
			label: b.label,
			args: b.args,
			result: b.result,
			resultTruncated: b.resultTruncated,
			isError: b.isError,
			durationMs: b.durationMs,
			status: b.isError ? "error" : b.result !== undefined ? "done" : "aborted",
			skill: b.skill,
		};
	}

	override updated() {
		//IYH1HC stream comment: re-resolve the scroll container and (re)wire the resize watcher.
		const container = this.querySelector(".overflow-y-auto") as HTMLElement | null;
		if (container && container !== this.scrollContainer) {
			// Container was (re)created — e.g. empty-state → messages-view switch.
			this.scrollContainer?.removeEventListener("scroll", this.handleScroll);
			this.scrollContainer = container;
			this.scrollContainer.addEventListener("scroll", this.handleScroll);
			this.observeContent(); //IYH1HC stream add(w2)
		} else if (container) {
			this.observeContent(); //IYH1HC stream add(w2): content child may have been replaced
		}
		if (this.autoScroll && this.scrollContainer) {
			this.scrollContainer.scrollTop = this.scrollContainer.scrollHeight;
		}
	}

	//IYH1HC stream add(w2): (re)attach the ResizeObserver to the current message-list wrapper.
	private observeContent() {
		const content = this.scrollContainer?.firstElementChild ?? undefined;
		if (!content || content === this.observedContent) return;
		if (!this.contentResizeObserver) {
			this.contentResizeObserver = new ResizeObserver(() => {
				if (this.autoScroll && this.scrollContainer) {
					this.scrollContainer.scrollTop = this.scrollContainer.scrollHeight;
				}
			});
		}
		if (this.observedContent) this.contentResizeObserver.unobserve(this.observedContent);
		this.contentResizeObserver.observe(content);
		this.observedContent = content;
	}

	//IYH1HC stream comment private handleScroll = () => { this.autoScroll = distanceFromBottom < 50; };
	//IYH1HC stream add(w2): direction-aware follow control. The old version toggled autoScroll
	// purely by distance-from-bottom, so a programmatic smooth-scroll passing through
	// mid-positions (still far from a growing bottom) wrongly disabled auto-follow and the
	// view got "stuck" needing manual scrolling. Now: reaching the bottom re-enables follow;
	// only an actual upward scroll (scrollTop decreasing) while away from the bottom disables
	// it — programmatic scrolls always move toward the bottom, so they never disable it.
	private handleScroll = () => {
		if (!this.scrollContainer) return;
		const { scrollTop, scrollHeight, clientHeight } = this.scrollContainer;
		const atBottom = scrollHeight - scrollTop - clientHeight < 50;
		if (atBottom) {
			this.autoScroll = true;
		} else if (scrollTop < this.lastScrollTop - 1) {
			this.autoScroll = false;
		}
		this.lastScrollTop = scrollTop;
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
		//IYH1HC stream add: reset the structured trail + token counter for this run
		this.resetStreamBuffers();
		this.streamStartMs = Date.now();
		this.elapsedTimer = setInterval(() => {
			this.elapsedSec = Math.floor((Date.now() - this.streamStartMs) / 1000);
		}, 1000);
		//IYH1HC stream add(w2): smooth typewriter reveal + smooth jump to the new user message
		this.startRevealLoop();
		this.scrollToBottom(true);

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
			//IYH1HC stream add: finalize any block still open (abort mid-stream) and commit
			// the structured trail into the persisted message list.
			if (this.elapsedTimer) {
				clearInterval(this.elapsedTimer);
				this.elapsedTimer = null;
			}
			this.stopRevealLoop(); //IYH1HC stream add(w2): before finalize so no frame races the snap
			this.finalizeOpenBlocks();
			this.commitStreamBlocks();
			//IYH1HC stream comment const hasContent = this.streamingText || this.streamingThread || this.streamingFiles.length > 0;
			const hasContent = this.streamingText || this.streamingThread || this.streamingFiles.length > 0 || this.blockOrder.length > 0; //IYH1HC stream add
			if (hasContent) {
				this.messages = [
					...this.messages,
					{
						role: "assistant",
						//IYH1HC stream comment text: this.streamingText,
						text: this.structuredSeen ? this.lastTextBlockContent() : this.streamingText, //IYH1HC stream add
						thread: this.streamingThread || undefined,
						files: this.streamingFiles.length > 0 ? [...this.streamingFiles] : undefined,
						blocks: this.blockOrder.length > 0 ? [...this.blockOrder] : undefined, //IYH1HC stream add
						usage: this.runUsage ?? undefined, //IYH1HC stream add
					},
				];
			}
			this.streamingText = "";
			this.streamingThread = "";
			this.streamingStatus = "";
			this.streamingFiles = [];
			this.isStreaming = false;
			this.resetStreamBuffers(); //IYH1HC stream add
			//IYH1HC stream add(w2): settle the view and hand focus back to the editor
			this.scrollToBottom(true);
			this.focusEditor();
		}
	}

	//IYH1HC stream add(w2): smooth-scroll helper for discrete jumps (send / done / history);
	// per-frame streaming follow stays instant in updated() — small increments look smooth
	// and a smooth-behavior chase would lag behind the reveal loop.
	private scrollToBottom(smooth = false) {
		requestAnimationFrame(() => {
			const container = this.scrollContainer ?? (this.querySelector(".overflow-y-auto") as HTMLElement | null);
			if (!container) return;
			container.scrollTo({ top: container.scrollHeight, behavior: smooth ? "smooth" : "auto" });
		});
	}

	//IYH1HC stream add(w2): keep the user's caret in the editor after a run finishes
	private focusEditor() {
		const textarea = (this._editor as unknown as HTMLElement | undefined)?.querySelector?.("textarea");
		(textarea as HTMLTextAreaElement | null)?.focus({ preventScroll: true });
	}

	//IYH1HC stream add: streaming buffer lifecycle helpers -------------------------------

	private resetStreamBuffers() {
		this.blockOrder = [];
		this.blockIndex = new Map();
		this.structuredSeen = false;
		this.rafPending = false;
		this.runUsage = null;
		this.authOutputTokens = 0;
		this.estCharsSinceUsage = 0;
		this.hasAuthUsage = false;
		this.streamingBlocks = [];
		this.liveTokenLabel = "";
		this.elapsedSec = 0;
		this.currentModel = ""; //IYH1HC stream add(w2)
		this.stopRevealLoop(); //IYH1HC stream add(w2)
		if (this.elapsedTimer) {
			clearInterval(this.elapsedTimer);
			this.elapsedTimer = null;
		}
	}

	/** Batch reactive updates: mutate buffers freely, commit once per animation frame. */
	private scheduleCommit() {
		//IYH1HC stream add(w2): while the reveal loop runs it owns the commits — just flag.
		this.pendingCommit = true;
		if (this.revealRafId !== null) return;
		if (this.rafPending) return;
		this.rafPending = true;
		requestAnimationFrame(() => {
			this.rafPending = false;
			//IYH1HC stream comment this.commitStreamBlocks();
			if (this.pendingCommit) { //IYH1HC stream add(w2)
				this.pendingCommit = false;
				this.commitStreamBlocks();
			}
		});
	}

	//IYH1HC stream add(w2): typewriter reveal — one persistent rAF loop per run. Each frame
	// drains a proportional slice of every content block's pending text (older blocks snap
	// instantly, only the newest unfinished block animates), then commits once if dirty.
	private startRevealLoop() {
		if (this.revealRafId !== null) return;
		const tick = () => {
			let dirty = this.pendingCommit;
			this.pendingCommit = false;

			// Index of the last content block that still has text to reveal.
			let lastPendingIdx = -1;
			for (let i = 0; i < this.blockOrder.length; i++) {
				const b = this.blockOrder[i];
				if ((b.kind === "text" || b.kind === "thinking") && b.target !== undefined && b.content.length < b.target.length) {
					lastPendingIdx = i;
				}
			}

			for (let i = 0; i < this.blockOrder.length; i++) {
				const b = this.blockOrder[i];
				if (b.kind !== "text" && b.kind !== "thinking") continue;
				const target = b.target ?? b.content;
				if (b.content.length < target.length) {
					if (i < lastPendingIdx) {
						b.content = target; // older block — snap, only the newest one animates
					} else {
						const pending = target.length - b.content.length;
						const step = Math.max(2, Math.ceil(pending / 10));
						b.content = target.slice(0, b.content.length + step);
					}
					dirty = true;
				}
				if (b.ended && b.streaming && b.content.length >= target.length) {
					b.streaming = false;
					dirty = true;
				}
			}

			if (dirty) this.commitStreamBlocks();
			this.revealRafId = requestAnimationFrame(tick);
		};
		this.revealRafId = requestAnimationFrame(tick);
	}

	private stopRevealLoop() {
		if (this.revealRafId !== null) {
			cancelAnimationFrame(this.revealRafId);
			this.revealRafId = null;
		}
	}

	private commitStreamBlocks() {
		this.streamingBlocks = [...this.blockOrder];
		this.liveTokenLabel = this.formatLiveTokens();
	}

	private lastTextBlockContent(): string {
		for (let i = this.blockOrder.length - 1; i >= 0; i--) {
			const b = this.blockOrder[i];
			if (b.kind === "text" && b.content.trim()) return b.content;
		}
		return "";
	}

	/** Mark blocks left open by an abort: stop shimmer, flag running tools as aborted. */
	private finalizeOpenBlocks() {
		for (const b of this.blockOrder) {
			//IYH1HC stream add(w2): snap any un-revealed text to the full received target
			if ((b.kind === "text" || b.kind === "thinking") && b.target !== undefined && b.content.length < b.target.length) {
				b.content = b.target;
			}
			if ((b.kind === "text" || b.kind === "thinking") && b.streaming) b.streaming = false;
			if (b.kind === "tool" && (b.status === "calling" || b.status === "running")) b.status = "aborted";
		}
	}

	private upsertContentBlock(blockId: string, kind: "text" | "thinking"): Extract<StreamBlock, { kind: "text" | "thinking" }> {
		const key = `block:${blockId}`;
		const existing = this.blockIndex.get(key);
		if (existing && (existing.kind === "text" || existing.kind === "thinking")) return existing;
		const block: Extract<StreamBlock, { kind: "text" | "thinking" }> =
			kind === "text"
				? { kind: "text", id: blockId, content: "", streaming: true }
				: { kind: "thinking", id: blockId, content: "", streaming: true };
		this.blockIndex.set(key, block);
		this.blockOrder.push(block);
		return block;
	}

	private upsertToolBlock(toolCallId: string, toolName: string): Extract<StreamBlock, { kind: "tool" }> {
		const key = `tool:${toolCallId}`;
		let block = this.blockIndex.get(key) as Extract<StreamBlock, { kind: "tool" }> | undefined;
		if (!block) {
			block = { kind: "tool", id: toolCallId, toolName, status: "calling" };
			this.blockIndex.set(key, block);
			this.blockOrder.push(block);
		}
		return block;
	}

	private formatTokenCount(n: number): string {
		if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
		if (n >= 10_000) return `${Math.round(n / 1000)}k`;
		if (n >= 1_000) return `${(n / 1000).toFixed(1)}k`;
		return String(n);
	}

	private formatLiveTokens(): string {
		const estimated = Math.ceil(this.estCharsSinceUsage / 4);
		const total = this.authOutputTokens + estimated;
		if (total <= 0) return "";
		const approx = estimated > 0 || !this.hasAuthUsage ? "~" : "";
		return `${approx}${this.formatTokenCount(total)} tokens`;
	}

	private handleSseEvent(event: SseEvent) {
		switch (event.type) {
			case "delta":
				//IYH1HC stream comment this.streamingText += event.text;
				if (!this.structuredSeen) this.streamingText += event.text; //IYH1HC stream add: blocks already carry the content
				break;
			case "replace":
				//IYH1HC stream comment this.streamingText = event.text;
				if (!this.structuredSeen) this.streamingText = event.text; //IYH1HC stream add
				break;
			case "thread":
				//IYH1HC stream comment this.streamingThread += event.text;
				if (!this.structuredSeen) this.streamingThread += event.text; //IYH1HC stream add
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
				//IYH1HC stream add: silent response — drop the structured trail as well
				this.blockOrder = [];
				this.blockIndex = new Map();
				this.scheduleCommit();
				break;
			case "error":
				this.messages = [...this.messages, { role: "error", text: event.message }];
				break;
			case "done":
				// Stream ends naturally; finally block commits the message
				break;

			//IYH1HC stream add: structured trail events ---------------------------------
			case "turn":
				this.structuredSeen = true;
				break;
			case "block": {
				this.structuredSeen = true;
				// Coalescing may deliver the first delta before a start event — upsert always.
				const block = this.upsertContentBlock(event.blockId, event.kind);
				//IYH1HC stream comment if (event.phase === "delta") { block.content += event.delta; ... }
				//IYH1HC stream add(w2): write into `target`; the reveal loop drains it into
				// `content` smoothly. `streaming` stays true until reveal catches up.
				if (event.phase === "delta") {
					block.target = (block.target ?? block.content) + event.delta;
					this.estCharsSinceUsage += event.delta.length;
				} else if (event.phase === "end") {
					block.target = event.content; // authoritative full content
					block.ended = true;
				}
				this.scheduleCommit();
				break;
			}
			case "tool": {
				this.structuredSeen = true;
				const block = this.upsertToolBlock(event.toolCallId, event.toolName);
				if (event.phase === "call") {
					block.status = "calling";
					block.args = event.args;
				} else if (event.phase === "start") {
					block.status = "running";
					block.toolName = event.toolName;
					block.label = event.label;
					block.args = event.args;
				} else if (event.phase === "update") {
					block.partialResult = event.partialResult;
				} else {
					block.status = event.isError ? "error" : "done";
					block.label = event.label ?? block.label;
					block.args = event.args;
					block.result = event.result;
					block.resultTruncated = event.resultTruncated;
					block.isError = event.isError;
					block.durationMs = event.durationMs;
					block.partialResult = undefined;
				}
				this.scheduleCommit();
				break;
			}
			case "skill": {
				this.structuredSeen = true;
				const block = this.blockIndex.get(`tool:${event.toolCallId}`) as Extract<StreamBlock, { kind: "tool" }> | undefined;
				if (block) block.skill = { name: event.name, path: event.path };
				this.scheduleCommit();
				break;
			}
			case "usage": {
				this.structuredSeen = true;
				//IYH1HC stream add(w2): surface which model served this step
				if (event.model?.id) {
					this.currentModel = event.model.provider ? `${event.model.provider}/${event.model.id}` : event.model.id;
				}
				if (event.scope === "message") {
					// Snap the live counter to authoritative numbers, chip rendered inline.
					this.authOutputTokens += event.usage.output;
					this.estCharsSinceUsage = 0;
					this.hasAuthUsage = true;
					this.blockOrder.push({ kind: "usage", id: `usage-${event.seq}`, scope: "message", usage: event.usage, model: event.model });
				} else {
					this.runUsage = event.usage;
					this.blockOrder.push({
						kind: "usage",
						id: `usage-${event.seq}`,
						scope: "run",
						usage: event.usage,
						model: event.model, //IYH1HC stream add(w2)
						contextTokens: event.contextTokens,
						contextWindow: event.contextWindow,
					});
				}
				this.scheduleCommit();
				break;
			}
			case "compaction": {
				this.structuredSeen = true;
				if (event.phase === "start") {
					this.blockOrder.push({
						kind: "event",
						id: `compaction-${event.seq}`,
						variant: "compaction",
						text: `Compacting context${event.reason ? ` (${event.reason})` : ""}...`,
					});
				} else {
					this.blockOrder.push({
						kind: "event",
						id: `compaction-${event.seq}`,
						variant: "compaction",
						text: event.aborted
							? "Compaction aborted"
							: `Compaction complete${event.tokensBefore ? ` (${this.formatTokenCount(event.tokensBefore)} tokens before)` : ""}`,
					});
				}
				this.scheduleCommit();
				break;
			}
			case "retry": {
				this.structuredSeen = true;
				this.blockOrder.push({
					kind: "event",
					id: `retry-${event.seq}`,
					variant: "retry",
					text: `Retrying (${event.attempt}/${event.maxAttempts})${event.errorMessage ? `: ${event.errorMessage}` : ""}`,
				});
				this.scheduleCommit();
				break;
			}
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
										${this.renderPoweredBy()}
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
										${this.renderPoweredBy()}
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
		//IYH1HC add: the header now also carries a download anchor (icon) next to "open ↗"
		// so the previewed file can be saved locally without leaving the panel.
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
						<a
							href=${this.fileDownloadUrl(f)}
							download=${name}
							title="Download"
							class="inline-flex text-muted-foreground hover:text-foreground"
						>${icon(Download, "sm")}</a>
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

	//IYH1HC add: 1–2 letter initials from a display name (e.g. "Dat Chien" -> "DC", "Hien" -> "HI").
	private senderInitials(name: string): string {
		const parts = name.trim().split(/\s+/).filter(Boolean);
		if (parts.length === 0) return "U";
		if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
		return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
	}

	//IYH1HC add: round avatar with the user's initials.
	private renderUserAvatar() {
		return html`
			<div class="h-8 w-8 shrink-0 rounded-full bg-primary/15 text-primary text-xs font-semibold flex items-center justify-center">
				${this.senderInitials(this.userName || "You")}
			</div>
		`;
	}

	//IYH1HC add: round avatar marking the assistant.
	private renderAgentAvatar() {
		return html`
			<div class="h-8 w-8 shrink-0 rounded-full bg-primary text-primary-foreground flex items-center justify-center">
				${icon(Sparkles, "sm")}
			</div>
		`;
	}

	private renderMessage(msg: ChatMessage) {
		//IYH1HC comment: user/assistant messages now lead with an avatar + sender name for clarity.
		if (msg.role === "user") {
			//IYH1HC comment: user messages align to the RIGHT (avatar on the right), agent stays on the left.
			return html`
				<div class="flex flex-row-reverse gap-3 mx-4">
					${this.renderUserAvatar()}
					<div class="flex flex-col gap-1 min-w-0 items-end">
						<span class="text-xs font-semibold text-foreground">${this.userName || "You"}</span>
						<div class="user-message-container self-end py-2 px-4 rounded-xl flex flex-col gap-2">
							${msg.attachments?.map((name) => html`
								<div class="flex items-center gap-1.5 text-xs opacity-70">
									<span>📎</span><span class="truncate max-w-xs">${name}</span>
								</div>
							`)}
							<markdown-block .content=${msg.text}></markdown-block>
						</div>
					</div>
				</div>
			`;
		}
		if (msg.role === "assistant") {
			//IYH1HC stream add: structured trail rendering takes precedence — blocks already
			// contain text/thinking/tool detail in order; legacy text/thread is the fallback.
			if (msg.blocks && msg.blocks.length > 0) {
				//IYH1HC stream add(w2): replay carries usage/model on the message (live runs
				// already have usage chips inside blocks — don't double-render).
				const hasUsageBlock = msg.blocks.some((b) => b.kind === "usage");
				return html`
					<div class="flex gap-3 px-4">
						${this.renderAgentAvatar()}
						<div class="flex flex-col gap-2 flex-1 min-w-0">
							<span class="text-xs font-semibold text-foreground">${this.agentName}</span>
							${this.renderBlocks(msg.blocks)}
							${!hasUsageBlock && msg.usage ? this.renderUsageChip(msg.usage, msg.model) : ""}
							${msg.files?.map((f) => this.renderFile(f))}
						</div>
					</div>
				`;
			}
			return html`
				<div class="flex gap-3 px-4">
					${this.renderAgentAvatar()}
					<div class="flex flex-col gap-2 flex-1 min-w-0">
						<span class="text-xs font-semibold text-foreground">${this.agentName}</span>
						${msg.text ? html`<markdown-block .content=${msg.text}></markdown-block>` : ""}
						${msg.thread ? this.renderThread(msg.thread) : ""}
						${msg.files?.map((f) => this.renderFile(f))}
					</div>
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

	//IYH1HC add: build a direct download URL for a chat file chip — the /file endpoint
	// already supports ?download=1 (Content-Disposition: attachment); auth rides on the
	// session cookie, same as the file viewer's existing Download anchor.
	private fileDownloadUrl(f: FileRef): string {
		return `${this.baseUrl}/file?path=${encodeURIComponent(f.path)}&download=1`;
	}

	private renderFile(f: FileRef) {
		const name = f.title || f.path.split("/").pop() || f.path;
		const isActive = this.rightPanelFile?.path === f.path;
		//IYH1HC comment: the chip was a single <button>; an anchor cannot legally nest inside
		// a button, so the outer element becomes a clickable <div> to host the download link.
		//IYH1HC comment return html`
		//IYH1HC comment 	<button
		//IYH1HC comment 		class="flex items-center gap-2 px-3 py-2 rounded-lg border text-sm text-left transition-colors
		//IYH1HC comment 			${isActive
		//IYH1HC comment 				? "border-primary bg-primary/10 text-primary"
		//IYH1HC comment 				: "border-border bg-muted/30 hover:bg-muted/60 text-foreground"}"
		//IYH1HC comment 		@click=${() => this.openRightPanel(f)}
		//IYH1HC comment 	>
		//IYH1HC comment 		<span>📄</span>
		//IYH1HC comment 		<span class="truncate">${name}</span>
		//IYH1HC comment 		<span class="ml-auto text-xs text-muted-foreground shrink-0">open ↗</span>
		//IYH1HC comment 	</button>
		//IYH1HC comment `;
		//IYH1HC add: outer div keeps the old chip look; the download anchor stops propagation
		// so clicking it saves the file without opening the preview panel.
		return html`
			<div
				class="flex items-center gap-2 px-3 py-2 rounded-lg border text-sm text-left cursor-pointer transition-colors
					${isActive
						? "border-primary bg-primary/10 text-primary"
						: "border-border bg-muted/30 hover:bg-muted/60 text-foreground"}"
				@click=${() => this.openRightPanel(f)}
			>
				<span>📄</span>
				<span class="truncate">${name}</span>
				<span class="ml-auto text-xs text-muted-foreground shrink-0">open ↗</span>
				<a
					href=${this.fileDownloadUrl(f)}
					download=${name}
					title="Download"
					class="inline-flex text-muted-foreground hover:text-foreground shrink-0"
					@click=${(e: Event) => e.stopPropagation()}
				>${icon(Download, "sm")}</a>
			</div>
		`;
	}

	private renderStreaming() {
		//IYH1HC stream comment const hasContent = this.streamingText || this.streamingThread || this.streamingFiles.length > 0;
		const hasContent = this.streamingText || this.streamingThread || this.streamingFiles.length > 0 || this.streamingBlocks.length > 0; //IYH1HC stream add

		//IYH1HC comment: streaming output now shares the assistant avatar + name layout for consistency.
		if (!hasContent) {
			const label = this.streamingStatus || "thinking";
			return html`
				<div class="flex gap-3 px-4">
					${this.renderAgentAvatar()}
					<div class="flex flex-col gap-1 min-w-0">
						<span class="text-xs font-semibold text-foreground">${this.agentName}</span>
						<div class="text-sm text-muted-foreground italic animate-pulse">${label}...</div>
					</div>
				</div>
			`;
		}
		return html`
			<div class="flex gap-3 px-4">
				${this.renderAgentAvatar()}
				<div class="flex flex-col gap-2 flex-1 min-w-0">
					<span class="text-xs font-semibold text-foreground">${this.agentName}</span>
					${this.streamingBlocks.length > 0 ? this.renderBlocks(this.streamingBlocks, true) : ""}
					${this.streamingText ? html`<markdown-block .content=${this.streamingText}></markdown-block>` : ""}
					${this.streamingThread ? this.renderThread(this.streamingThread) : ""}
					${this.streamingFiles.map((f) => this.renderFile(f))}
					${this.renderStreamingStatusBar()}
				</div>
			</div>
		`;
	}

	//IYH1HC stream add(w2): centered branding footer under the message editor
	private renderPoweredBy() {
		return html`
			<div class="text-center text-[11px] text-muted-foreground pt-1.5">
				<a
					href="https://inside-docupedia.bosch.com/confluence2/spaces/octo/pages/1130492559/Octo+-+AI+Agent+Framework"
					target="_blank"
					rel="noopener"
					class="hover:text-foreground hover:underline"
				>Powered by Octo AI</a>
			</div>
		`;
	}

	//IYH1HC stream add: structured trail rendering ---------------------------------------

	/** Live status bar: spinner + status label + elapsed time + ticking token counter. */
	private renderStreamingStatusBar() {
		const label = this.streamingStatus || "working";
		return html`
			<div class="flex items-center gap-2 text-xs text-muted-foreground pt-1">
				<span class="animate-spin inline-flex">${icon(Loader, "sm")}</span>
				<span class="italic">${label}...</span>
				${this.currentModel ? html`<span class="px-1.5 py-0.5 rounded bg-muted/60 text-[10px]">${this.currentModel}</span>` : ""}
				${this.elapsedSec > 0 ? html`<span>${this.elapsedSec}s</span>` : ""}
				${this.liveTokenLabel
					? html`<span class="inline-flex items-center gap-0.5">${icon(Zap, "sm")}${this.liveTokenLabel}</span>`
					: ""}
			</div>
		`;
	}

	private renderBlocks(blocks: StreamBlock[], streaming = false) {
		return html`
			<div class="flex flex-col gap-1.5">
				${blocks.map((b) => this.renderBlock(b, streaming))}
			</div>
		`;
	}

	private renderBlock(block: StreamBlock, streaming: boolean) {
		switch (block.kind) {
			case "thinking":
				return html`<thinking-block .content=${block.content} .isStreaming=${streaming && block.streaming}></thinking-block>`;
			case "text":
				return html`<markdown-block .content=${block.content}></markdown-block>`;
			case "tool":
				return this.renderToolBlock(block);
			case "event":
				return html`<div class="py-0.5 text-xs italic text-muted-foreground">${block.text}</div>`;
			case "usage":
				//IYH1HC stream comment return block.scope === "run" ? this.renderRunUsageSummary(block) : this.renderUsageChip(block.usage);
				return block.scope === "run" ? this.renderRunUsageSummary(block) : this.renderUsageChip(block.usage, block.model); //IYH1HC stream add(w2)
		}
	}

	private renderToolStatusIcon(status: Extract<StreamBlock, { kind: "tool" }>["status"]) {
		switch (status) {
			case "calling":
			case "running":
				return html`<span class="animate-spin inline-flex text-muted-foreground">${icon(Loader, "sm")}</span>`;
			case "done":
				return html`<span class="inline-flex text-green-600">${icon(Check, "sm")}</span>`;
			case "error":
				return html`<span class="inline-flex text-destructive">${icon(X, "sm")}</span>`;
			case "aborted":
				return html`<span class="inline-flex text-muted-foreground">⊘</span>`;
		}
	}

	private renderToolBlock(block: Extract<StreamBlock, { kind: "tool" }>) {
		const duration = block.durationMs !== undefined ? ` (${(block.durationMs / 1000).toFixed(1)}s)` : "";
		const statusText = block.status === "calling" ? " — preparing" : block.status === "running" ? " — running" : block.status === "aborted" ? " — aborted" : "";
		const argsJson = block.args && Object.keys(block.args).length > 0 ? JSON.stringify(block.args, null, 2) : "";
		const bodyResult = block.result ?? block.partialResult ?? "";
		const hasBody = argsJson || bodyResult;

		const header = html`
			<span class="inline-flex items-center gap-1.5 min-w-0">
				${this.renderToolStatusIcon(block.status)}
				<span class="font-medium">${block.toolName}</span>
				${block.label ? html`<span class="truncate text-muted-foreground">: ${block.label}</span>` : ""}
				<span class="text-muted-foreground shrink-0">${duration}${statusText}</span>
				${block.skill
					? html`<span class="shrink-0 px-1.5 py-0.5 rounded bg-primary/10 text-primary text-[10px] font-medium" title=${block.skill.path}>skill: ${block.skill.name}</span>`
					: ""}
			</span>
		`;

		if (!hasBody) {
			return html`<div class="py-0.5 text-sm border-l-2 border-border pl-3">${header}</div>`;
		}
		return html`
			<details class="group border-l-2 border-border pl-3 text-sm">
				<summary class="cursor-pointer flex items-center gap-1.5 py-0.5 text-foreground/90 hover:text-foreground select-none [&::-webkit-details-marker]:hidden [&::marker]:hidden">
					<span class="text-[10px] transition-transform duration-150 group-open:rotate-90">▶</span>
					${header}
				</summary>
				<div class="mt-1 ml-3.5 flex flex-col gap-1.5">
					${argsJson
						? html`
							<div class="text-[11px] uppercase tracking-wide text-muted-foreground">Arguments</div>
							<pre class="text-xs bg-muted/40 rounded p-2 overflow-x-auto whitespace-pre-wrap break-all">${argsJson}</pre>`
						: ""}
					${bodyResult
						? html`
							<div class="text-[11px] uppercase tracking-wide text-muted-foreground">${block.result !== undefined ? "Result" : "Progress"}</div>
							<pre class="text-xs bg-muted/40 rounded p-2 overflow-x-auto whitespace-pre-wrap break-all">${bodyResult}</pre>
							${block.resultTruncated
								? html`<div class="text-xs italic text-muted-foreground">Result truncated — full text is kept in the session audit trail (trail.jsonl).</div>`
								: ""}`
						: ""}
				</div>
			</details>
		`;
	}

	/** Per-step authoritative usage chip: model / in / out / cache / cost. */
	//IYH1HC stream comment private renderUsageChip(usage: AgentUsage) {
	private renderUsageChip(usage: AgentUsage, model?: { provider: string; id: string } | string) { //IYH1HC stream add(w2)
		const cost = usage.cost?.total ? ` · $${usage.cost.total.toFixed(4)}` : "";
		const cache = usage.cacheRead || usage.cacheWrite
			? ` · cache ${this.formatTokenCount(usage.cacheRead)}R/${this.formatTokenCount(usage.cacheWrite)}W`
			: "";
		//IYH1HC stream add(w2): which model served this step, shown ahead of the numbers
		const modelLabel = typeof model === "string" ? model : model?.id ? model.id : "";
		const modelTitle = typeof model === "object" && model?.provider ? `${model.provider}/${model.id}` : modelLabel;
		return html`
			<div class="inline-flex items-center gap-1 self-start px-2 py-0.5 rounded-full bg-muted/50 text-[11px] text-muted-foreground">
				${icon(Zap, "sm")}
				${modelLabel ? html`<span class="font-medium text-foreground/70" title=${modelTitle}>${modelLabel}</span><span>·</span>` : ""}
				<span>↑ ${this.formatTokenCount(usage.input)} · ↓ ${this.formatTokenCount(usage.output)}${cache}${cost}</span>
			</div>
		`;
	}

	/** Final run summary: token + cost breakdown table, context window fill. */
	private renderRunUsageSummary(block: Extract<StreamBlock, { kind: "usage" }>) {
		const u = block.usage;
		const rows: Array<[string, number, number]> = [
			["Input", u.input, u.cost?.input ?? 0],
			["Output", u.output, u.cost?.output ?? 0],
			["Cache read", u.cacheRead, u.cost?.cacheRead ?? 0],
			["Cache write", u.cacheWrite, u.cost?.cacheWrite ?? 0],
		];
		const totalTokens = u.input + u.output + u.cacheRead + u.cacheWrite;
		const context = block.contextTokens && block.contextWindow
			? `${this.formatTokenCount(block.contextTokens)} / ${this.formatTokenCount(block.contextWindow)} context`
			: block.contextTokens
				? `${this.formatTokenCount(block.contextTokens)} context`
				: "";
		return html`
			<details class="group border border-border rounded-lg px-3 py-1.5 text-xs self-start min-w-64">
				<summary class="cursor-pointer flex items-center gap-1.5 select-none text-muted-foreground hover:text-foreground [&::-webkit-details-marker]:hidden [&::marker]:hidden">
					<span class="text-[10px] transition-transform duration-150 group-open:rotate-90">▶</span>
					${icon(Zap, "sm")}
					<span class="font-medium text-foreground">Run summary</span>
					${block.model?.id ? html`<span class="px-1.5 py-0.5 rounded bg-muted/60 text-[10px]" title=${`${block.model.provider}/${block.model.id}`}>${block.model.id}</span>` : ""}
					<span>${this.formatTokenCount(totalTokens)} tokens · $${(u.cost?.total ?? 0).toFixed(4)}</span>
					${context ? html`<span class="text-muted-foreground">· ${context}</span>` : ""}
				</summary>
				<table class="mt-1.5 w-full">
					<thead>
						<tr class="text-muted-foreground text-left">
							<th class="font-normal pr-4"></th>
							<th class="font-normal pr-4 text-right">Tokens</th>
							<th class="font-normal text-right">Cost</th>
						</tr>
					</thead>
					<tbody>
						${rows.map(
							([name, tokens, cost]) => html`
								<tr>
									<td class="pr-4">${name}</td>
									<td class="pr-4 text-right">${tokens.toLocaleString()}</td>
									<td class="text-right">$${cost.toFixed(4)}</td>
								</tr>`,
						)}
						<tr class="border-t border-border font-medium">
							<td class="pr-4">Total</td>
							<td class="pr-4 text-right">${totalTokens.toLocaleString()}</td>
							<td class="text-right">$${(u.cost?.total ?? 0).toFixed(4)}</td>
						</tr>
					</tbody>
				</table>
			</details>
		`;
	}
}
