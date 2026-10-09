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

	pi.registerCommand("rm-guard", {
		description: "Show rm-guard PATH interception status",
		handler: async (_args, ctx) => {
			ctx.ui.notify(`rm-guard active\nshim directory: ${shimDirectory}`, "info");
		},
	});
}
