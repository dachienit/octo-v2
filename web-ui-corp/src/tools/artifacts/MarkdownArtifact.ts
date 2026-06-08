import hljs from "highlight.js";
import { html } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { unsafeHTML } from "lit/directives/unsafe-html.js";
import { marked } from "marked";
import { i18n } from "../../utils/i18n.js";
import "@mariozechner/mini-lit/dist/MarkdownBlock.js";
import { CopyButton } from "@mariozechner/mini-lit/dist/CopyButton.js";
import { DownloadButton } from "@mariozechner/mini-lit/dist/DownloadButton.js";
import { PreviewCodeToggle } from "@mariozechner/mini-lit/dist/PreviewCodeToggle.js";
import { ArtifactElement } from "./ArtifactElement.js";

@customElement("markdown-artifact")
export class MarkdownArtifact extends ArtifactElement {
	@property() override filename = "";

	private _content = "";
	override get content(): string {
		return this._content;
	}
	override set content(value: string) {
		this._content = value;
		this.requestUpdate();
	}

	@state() private viewMode: "preview" | "code" = "preview";
	private tiptapEditor: any | null = null;

	protected override createRenderRoot(): HTMLElement | DocumentFragment {
		return this; // light DOM
	}

	override disconnectedCallback(): void {
		super.disconnectedCallback();
		this.tiptapEditor?.destroy?.();
		this.tiptapEditor = null;
	}

	private setViewMode(mode: "preview" | "code") {
		if (mode !== "preview") {
			this.tiptapEditor?.destroy?.();
			this.tiptapEditor = null;
		}
		this.viewMode = mode;
	}

	private escapeHtmlPreservingMarkdown(content: string): string {
		const codeBlocks: string[] = [];
		let preserved = content.replace(/```[\s\S]*?```|`[^`\n]+`/g, (match) => {
			const index = codeBlocks.length;
			codeBlocks.push(match);
			return `__CODE_BLOCK_${index}__`;
		});
		preserved = preserved
			.replace(/<(\w+)([^>]*)>/g, "&lt;$1$2&gt;")
			.replace(/<\/(\w+)>/g, "&lt;/$1&gt;")
			.replace(/<(\w+)([^>]*)\s*\/>/g, "&lt;$1$2/&gt;")
			.replace(/<(?![^\s])/g, "&lt;");
		codeBlocks.forEach((block, index) => {
			preserved = preserved.replace(`__CODE_BLOCK_${index}__`, block);
		});
		return preserved;
	}

	private markdownToHtml(content: string): string {
		return marked.parse(this.escapeHtmlPreservingMarkdown(content), {
			async: false,
		}) as string;
	}

	public getHeaderButtons() {
		const toggle = new PreviewCodeToggle();
		toggle.mode = this.viewMode;
		toggle.addEventListener("mode-change", (e: Event) => {
			this.setViewMode((e as CustomEvent).detail);
		});

		const copyButton = new CopyButton();
		copyButton.text = this._content;
		copyButton.title = i18n("Copy Markdown");
		copyButton.showText = false;

		return html`
			<div class="flex items-center gap-2">
				${toggle}
				${copyButton}
				${DownloadButton({
					content: this._content,
					filename: this.filename,
					mimeType: "text/markdown",
					title: i18n("Download Markdown"),
				})}
			</div>
		`;
	}

	override render() {
		return html`
			<div class="h-full flex flex-col">
				<style>
					markdown-artifact .markdown-artifact-preview .ProseMirror {
						outline: none;
						color: var(--color-foreground);
						line-height: 1.65;
					}
					markdown-artifact .markdown-artifact-preview .ProseMirror h1 {
						font-size: 1.875rem;
						line-height: 2.25rem;
						font-weight: 700;
						margin: 0 0 1rem;
					}
					markdown-artifact .markdown-artifact-preview .ProseMirror h2 {
						font-size: 1.5rem;
						line-height: 2rem;
						font-weight: 650;
						margin: 1.25rem 0 0.75rem;
					}
					markdown-artifact .markdown-artifact-preview .ProseMirror h3 {
						font-size: 1.25rem;
						line-height: 1.75rem;
						font-weight: 650;
						margin: 1rem 0 0.5rem;
					}
					markdown-artifact .markdown-artifact-preview .ProseMirror p {
						margin: 0 0 0.85rem;
					}
					markdown-artifact .markdown-artifact-preview .ProseMirror ul,
					markdown-artifact .markdown-artifact-preview .ProseMirror ol {
						margin: 0.75rem 0 0.75rem 1.5rem;
					}
					markdown-artifact .markdown-artifact-preview .ProseMirror ul {
						list-style: disc;
					}
					markdown-artifact .markdown-artifact-preview .ProseMirror ol {
						list-style: decimal;
					}
					markdown-artifact .markdown-artifact-preview .ProseMirror blockquote {
						border-left: 3px solid var(--color-border);
						margin: 1rem 0;
						padding-left: 1rem;
						color: var(--color-muted-foreground);
					}
					markdown-artifact .markdown-artifact-preview .ProseMirror code {
						border-radius: 0.25rem;
						background: var(--color-muted);
						padding: 0.1rem 0.3rem;
						font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace;
						font-size: 0.9em;
					}
					markdown-artifact .markdown-artifact-preview .ProseMirror pre {
						border-radius: 0.5rem;
						background: var(--color-muted);
						margin: 1rem 0;
						padding: 1rem;
						overflow: auto;
					}
					markdown-artifact .markdown-artifact-preview .ProseMirror pre code {
						background: transparent;
						padding: 0;
					}
				</style>
				<div class="flex-1 overflow-auto">
					${
						this.viewMode === "preview"
							? html`<div id="markdown-editor" class="markdown-artifact-preview p-4 max-w-none"></div>`
							: html`<pre class="m-0 p-4 text-xs whitespace-pre-wrap break-words"><code class="hljs language-markdown">${unsafeHTML(
									hljs.highlight(this.content, { language: "markdown", ignoreIllegals: true }).value,
								)}</code></pre>`
					}
				</div>
			</div>
		`;
	}

	override async updated() {
		if (this.viewMode !== "preview") return;
		const host = this.querySelector("#markdown-editor");
		if (!host) return;
		const { Editor } = await import("@tiptap/core");
		const StarterKit = (await import("@tiptap/starter-kit")).default;
		if (!this.tiptapEditor) {
			this.tiptapEditor = new Editor({
				element: host,
				extensions: [StarterKit],
				editable: false,
				content: "",
			});
		}
		this.tiptapEditor.setEditable(false);
		this.tiptapEditor.commands.setContent(this.markdownToHtml(this.content || ""), false);
	}
}

declare global {
	interface HTMLElementTagNameMap {
		"markdown-artifact": MarkdownArtifact;
	}
}
