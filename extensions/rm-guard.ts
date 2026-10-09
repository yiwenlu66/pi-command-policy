import { dirname, join, delimiter } from "node:path";
import { fileURLToPath } from "node:url";
import { createBashTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const shimDirectory = join(packageRoot, "bin");

export default function (pi: ExtensionAPI) {
	const bashTool = createBashTool(process.cwd(), {
		spawnHook: ({ command, cwd, env }) => ({
			command,
			cwd,
			env: {
				...env,
				PATH: `${shimDirectory}${delimiter}${env.PATH ?? ""}`,
			},
		}),
	});

	pi.registerTool({
		...bashTool,
		name: "bash",
		execute: async (id, params, signal, onUpdate, _ctx) => {
			return bashTool.execute(id, params, signal, onUpdate);
		},
	});

	pi.registerCommand("rm-guard", {
		description: "Show rm-guard PATH interception status",
		handler: async (_args, ctx) => {
			ctx.ui.notify(`rm-guard active\nshim directory: ${shimDirectory}`, "info");
		},
	});
}
