import { readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { isToolCallEventType, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const shimDirectory = join(packageRoot, "bin");
const pathExport = `export PATH="${shimDirectory}:$PATH"\n`;

export default function (pi: ExtensionAPI) {
	pi.on("tool_call", (event) => {
		if (!isToolCallEventType("bash", event)) return;
		if (event.input.command.includes(shimDirectory)) return;

		event.input.command = `${pathExport}${event.input.command}`;
	});

	pi.registerCommand("shims", {
		description: "Show pi-shims PATH interception status and active shims",
		handler: async (_args, ctx) => {
			const entries = await readdir(shimDirectory, { withFileTypes: true });
			const shims = entries.filter((entry) => entry.isFile()).map((entry) => entry.name).sort();
			ctx.ui.notify(`pi-shims active\nshim directory: ${shimDirectory}\nshims: ${shims.join(", ") || "none"}`, "info");
		},
	});
}
