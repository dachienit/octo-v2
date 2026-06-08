import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { extname } from "path";
import type { Executor } from "../sandbox.js";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, formatSize, type TruncationResult, truncateHead } from "./truncate.js";

const IMAGE_MIME_TYPES: Record<string, string> = {
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".png": "image/png",
	".gif": "image/gif",
	".webp": "image/webp",
};

function isImageFile(filePath: string): string | null {
	const ext = extname(filePath).toLowerCase();
	return IMAGE_MIME_TYPES[ext] || null;
}

const readSchema = Type.Object({
	label: Type.String({ description: "Brief description of what you're reading and why (shown to user)" }),
	path: Type.String({ description: "Path to the file to read (relative or absolute)" }),
	offset: Type.Optional(Type.Number({ description: "Line number to start reading from (1-indexed)" })),
	limit: Type.Optional(Type.Number({ description: "Maximum number of lines to read" })),
});

interface ReadToolDetails {
	truncation?: TruncationResult;
}

export function createReadTool(executor: Executor): AgentTool<typeof readSchema> {
	return {
		name: "read",
		label: "read",
		description: `Read the contents of a file. Supports text files and images (jpg, png, gif, webp). Images are sent as attachments. For text files, output is truncated to ${DEFAULT_MAX_LINES} lines or ${DEFAULT_MAX_BYTES / 1024}KB (whichever is hit first). Use offset/limit for large files.`,
		parameters: readSchema,
		execute: async (
			_toolCallId: string,
			{ path, offset, limit }: { label: string; path: string; offset?: number; limit?: number },
			_signal?: AbortSignal,
		): Promise<{ content: (TextContent | ImageContent)[]; details: ReadToolDetails | undefined }> => {
			const mimeType = isImageFile(path);

			//IYH1HC add: read the file once via the executor (Node fs on host, shell inside Docker).
			// Replaces the POSIX-only base64/wc/cat/tail shell calls so this works on Windows host.
			const buffer = await executor.readFile(path);

			if (mimeType) {
				const base64 = buffer.toString("base64");
				return {
					content: [
						{ type: "text", text: `Read image file [${mimeType}]` },
						{ type: "image", data: base64, mimeType },
					],
					details: undefined,
				};
			}

			//IYH1HC add: line accounting and offset/limit done in JS (cross-platform).
			const fileContent = buffer.toString("utf-8");
			const allLines = fileContent.split("\n");
			const totalFileLines = allLines.length;

			const startLine = offset ? Math.max(1, offset) : 1;
			const startLineDisplay = startLine;

			if (startLine > totalFileLines) {
				throw new Error(`Offset ${offset} is beyond end of file (${totalFileLines} lines total)`);
			}

			let selectedLines = allLines.slice(startLine - 1);
			let userLimitedLines: number | undefined;

			if (limit !== undefined) {
				const endLine = Math.min(limit, selectedLines.length);
				selectedLines = selectedLines.slice(0, endLine);
				userLimitedLines = endLine;
			}

			const selectedContent = selectedLines.join("\n");

			const truncation = truncateHead(selectedContent);

			let outputText: string;
			let details: ReadToolDetails | undefined;

			if (truncation.firstLineExceedsLimit) {
				const firstLineSize = formatSize(Buffer.byteLength(selectedContent.split("\n")[0], "utf-8"));
				outputText = `[Line ${startLineDisplay} is ${firstLineSize}, exceeds ${formatSize(DEFAULT_MAX_BYTES)} limit. Use bash: sed -n '${startLineDisplay}p' ${path} | head -c ${DEFAULT_MAX_BYTES}]`;
				details = { truncation };
			} else if (truncation.truncated) {
				const endLineDisplay = startLineDisplay + truncation.outputLines - 1;
				const nextOffset = endLineDisplay + 1;

				outputText = truncation.content;

				if (truncation.truncatedBy === "lines") {
					outputText += `\n\n[Showing lines ${startLineDisplay}-${endLineDisplay} of ${totalFileLines}. Use offset=${nextOffset} to continue]`;
				} else {
					outputText += `\n\n[Showing lines ${startLineDisplay}-${endLineDisplay} of ${totalFileLines} (${formatSize(DEFAULT_MAX_BYTES)} limit). Use offset=${nextOffset} to continue]`;
				}
				details = { truncation };
			} else if (userLimitedLines !== undefined) {
				const linesFromStart = startLine - 1 + userLimitedLines;
				if (linesFromStart < totalFileLines) {
					const remaining = totalFileLines - linesFromStart;
					const nextOffset = startLine + userLimitedLines;
					outputText = truncation.content;
					outputText += `\n\n[${remaining} more lines in file. Use offset=${nextOffset} to continue]`;
				} else {
					outputText = truncation.content;
				}
			} else {
				outputText = truncation.content;
			}

			return { content: [{ type: "text", text: outputText }], details };
		},
	};
}
