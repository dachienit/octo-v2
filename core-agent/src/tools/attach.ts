import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import { basename, isAbsolute, join, resolve as resolvePath } from "path";

type UploadFn = (filePath: string, title?: string) => Promise<void>;

const attachSchema = Type.Object({
	label: Type.String({ description: "Brief description of what you're sharing (shown to user)" }),
	path: Type.String({ description: "Path to the file to attach" }),
	title: Type.Optional(Type.String({ description: "Title for the file (defaults to filename)" })),
});

export function createAttachTool(getUploadFn: () => UploadFn | null, cwd?: string): AgentTool<typeof attachSchema> {
	return {
		name: "attach",
		label: "attach",
		description: "Attach a file to your response. Use this to share files, images, or documents with the user.",
		parameters: attachSchema,
		execute: async (
			_toolCallId: string,
			{ path, title }: { label: string; path: string; title?: string },
			signal?: AbortSignal,
		) => {
			const uploadFn = getUploadFn();
			if (!uploadFn) {
				throw new Error("Upload function not configured");
			}

			if (signal?.aborted) {
				throw new Error("Operation aborted");
			}

			const absolutePath = isAbsolute(path) ? path : cwd ? join(cwd, path) : resolvePath(path);
			const fileName = title || basename(absolutePath);

			await uploadFn(absolutePath, fileName);

			return {
				content: [{ type: "text" as const, text: `Attached file: ${fileName}` }],
				details: undefined,
			};
		},
	};
}
