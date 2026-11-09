import { readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { isToolCallEventType, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { sleepPolicyReason } from "../lib/sleep-policy.ts";
import { noopPolicyReason } from "../lib/noop-policy.ts";

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const shimDirectory = join(packageRoot, "bin");
const pathExport = `export PATH="${shimDirectory}:$PATH"\n`;

export default function (pi: ExtensionAPI) {
	pi.on("tool_call", (event) => {
		if (!isToolCallEventType("bash", event)) return;
		// The no-op policy is checked first so its more specific message wins: a
		// bare no-op has no confirmation bypass at all. Sleep comes next and owns
		// the confirmation vocabulary, which must be read before the shim-directory
		// early return so it cannot be skipped by mentioning that directory.
		const reason = noopPolicyReason(event.input.command) ?? sleepPolicyReason(event.input.command);
		if (reason) return { block: true, reason };
		if (event.input.command.includes(shimDirectory)) return;

		event.input.command = `${pathExport}${event.input.command}`;
	});

	pi.registerCommand("command-policy", {
		description: "Show direct Bash sleep policy and active PATH shims",
		handler: async (_args, ctx) => {
			const entries = await readdir(shimDirectory, { withFileTypes: true });
			const shims = entries.filter((entry) => entry.isFile()).map((entry) => entry.name).sort();
			ctx.ui.notify(`pi-command-policy active\nsleep: direct Bash input only (>= 10s); child scripts unrestricted\nno-op: bare true/: and empty while-true/until-false loops refused (no bypass)\nconfirm: PI_COMMAND_POLICY_CONFIRM=rm|search|sleep; =1, PI_SHIMS_CONFIRM and bounds refused\nshim directory: ${shimDirectory}\nshims: ${shims.join(", ") || "none"}`, "info");
		},
	});
}
