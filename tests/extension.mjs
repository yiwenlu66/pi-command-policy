import assert from "node:assert/strict";
import { readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import register from "../extensions/shims.ts";

const handlers = new Map();
const commands = new Map();
register({
	on: (name, handler) => handlers.set(name, handler),
	registerCommand: (name, command) => commands.set(name, command),
});
assert.deepEqual([...commands.keys()], ["shims"]);
const shimDirectory = fileURLToPath(new URL("../bin", import.meta.url));
const event = { toolName: "bash", input: { command: "rm -f build" } };
handlers.get("tool_call")(event);
assert.equal(event.input.command, `export PATH="${shimDirectory}:$PATH"\nrm -f build`);
const injected = event.input.command;
handlers.get("tool_call")(event);
assert.equal(event.input.command, injected);
const other = { toolName: "read", input: { path: "file" } };
handlers.get("tool_call")(other);
assert.deepEqual(other.input, { path: "file" });
let notification;
await commands.get("shims").handler("", {
	ui: { notify: (message) => { notification = message; } },
});
assert.ok(notification.includes(`shim directory: ${shimDirectory}`));
const files = (await readdir(new URL("../bin", import.meta.url))).sort();
assert.ok(notification.includes(`shims: ${files.join(", ")}`));
console.log("extension: bash PATH injection, idempotency, /shims listing, clean command rename");
