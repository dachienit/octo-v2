import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { Executor } from "../sandbox.js";
import { createAttachTool } from "./attach.js";
import { createBashTool } from "./bash.js";
import { createEditTool } from "./edit.js";
import { createReadTool } from "./read.js";
import { createWriteTool } from "./write.js";

type UploadFn = (filePath: string, title?: string) => Promise<void>;

//IYH1HC add: `attachCwd` must be a HOST path — attach's uploadFn reads from the host
// filesystem. read/edit/write resolve paths via the executor's own cwd internally.
export function createPrimitiveTools(
	executor: Executor,
	getUploadFn: () => UploadFn | null,
	attachCwd?: string,
): AgentTool<any>[] {
	return [
		createReadTool(executor),
		createBashTool(executor),
		createEditTool(executor),
		createWriteTool(executor),
		createAttachTool(getUploadFn, attachCwd),
	];
}
