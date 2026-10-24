import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, test } from "node:test";
import { createBashTool, discoverAndLoadExtensions, ExtensionRunner, SessionManager } from "@earendil-works/pi-coding-agent";

for (const name of ["PI_COMMAND_POLICY_CONFIRM", "PI_SHIMS_CONFIRM", "RM_GUARD_CONFIRM", "PI_NOTIFY_BACKGROUND"]) delete process.env[name];
const root = fileURLToPath(new URL("../", import.meta.url));
const shimDirectory = join(root, "bin");
const work = await mkdtemp(join(tmpdir(), "pi-command-policy-test-"));
after(() => rm(work, { recursive: true, force: true }));

// Load through Pi's real jiti loader, not a helper-only or mocked API test.
// Isolated cwd/agentDir ensure no user settings or extensions are loaded.
const loaded = await discoverAndLoadExtensions([join(root, "extensions/command-policy.ts")], work, work);
assert.deepEqual(loaded.errors, []);
assert.equal(loaded.extensions.length, 1);
const runner = new ExtensionRunner(loaded.extensions, loaded.runtime, work, SessionManager.inMemory(work), {});
let sequence = 0;
async function preflight(command, toolName = "bash") {
	const event = { type: "tool_call", toolName, toolCallId: `policy-${++sequence}`, input: { command } };
	const result = await runner.emitToolCall(event);
	return { event, result };
}

// Use the real built-in local Bash tool. The test baseline excludes previously
// installed packages so an old bin/sleep cannot shadow the system timer.
const bash = createBashTool(work, {
	spawnHook: ({ command, cwd, env }) => ({ command, cwd, env: { ...env, PATH: "/usr/bin:/bin" } }),
});
async function execute(command, signal) {
	const { event, result } = await preflight(command);
	assert.equal(result?.block, undefined, result?.reason);
	return bash.execute(event.toolCallId, event.input, signal);
}
function output(result) {
	return result.content.filter((part) => part.type === "text").map((part) => part.text).join("\n");
}

test("direct and compound Bash sleeps block before execution", async () => {
	const cases = [
		"sleep 900", "make&&sleep 900", "true;sleep 900", "true || sleep 900", "echo x | sleep 900",
		"while sleep 30; do echo polling; done", "until sleep 30; do :; done", "for x in 1; do sleep 30; done",
		"if true; then sleep 30; fi", "(sleep 30)", "{ sleep 30; }", "f() { sleep 30; }; f",
		"sleep '30'", "'sleep' \"9\"'00'", String.raw`sle\ep 9\00`, "sleep $'1\\x30'",
		"sleep 6 4", "sleep -- 900", "sleep 6 -- 4", "sleep 9.99s .01s", "sleep 0.1m 4s", `sleep ${Array(100).fill(".1").join(" ")}`,
		"sleep .2m", "sleep .003h", "sleep .0002d", "sleep +10.0s", "sleep 30 >out",
		"echo \"$(sleep 30)\"", "cat <(sleep 30)", "sleep 30 &",
		"PI_NOTIFY_BACKGROUND=1 sleep 900", "PI_NOTIFY_BACKGROUND=0 sleep 900",
		`echo '${shimDirectory}'; sleep 900`, `export PATH="${shimDirectory}:$PATH"\nsleep 900`,
	];
	for (const command of cases) {
		const { event, result } = await preflight(command);
		assert.equal(result?.block, true, command);
		assert.match(result.reason, /pi-command-policy: direct sleep refused/);
		assert.match(result.reason, /background/);
		assert.match(result.reason, /watcher or completion notification/);
		assert.doesNotMatch(result.reason, /pi-notify/);
		assert.equal(event.input.command, command, "blocked tool input is not mutated");
	}
});

test("text, comments, heredocs, dynamic operands, opaque code and uncertainty allow", async () => {
	const cases = [
		"echo 'sleep 900'", 'printf "%s\\n" "sleep 900"', "# sleep 900\necho ready", "echo ready # sleep 900",
		"cat <<'EOF'\nsleep 900\nEOF", "cat <<EOF\nsleep 900\n$(sleep 30)\nEOF",
		"cat <<-EOF\n\tsleep 900\n\tEOF", "cat <<'A' <<'B'\nsleep 900\nA\nsleep 30\nB",
		"cat <<<'sleep 900'", "bash -c 'sleep 900'", "sh -c 'while sleep 30; do :; done'", "eval 'sleep 900'",
		"bash ./worker.sh", "./worker.sh", "source ./worker.sh", "sleep-script 900", "echo xsleep900",
		"sleep 9.999", "sleep .001s .00001m .0000001h .00000001d", "sleep --version", "sleep --", "sleep -- -- 900", "sleep 900 invalid",
		"sleep \"$WAIT\"", "sleep 900 $WAIT", "sleep ${WAIT:-900}", "sleep $((900))", "sleep {1,900}", "sleep 9*", "$COMMAND 900",
		"sleep 900; if", "echo 'unterminated; sleep 900", "echo $(sleep 900; if)",
		"/bin/sleep 900", "PI_COMMAND_POLICY_CONFIRM=1 sleep 900", "PI_SHIMS_CONFIRM=1 sleep 900",
	];
	for (const command of cases) {
		const { result } = await preflight(command);
		assert.equal(result?.block, undefined, command);
	}
});

test("policy covers executable syntax after a heredoc without scanning its body", async () => {
	const command = "cat <<'EOF'\nsleep 900\nEOF\nsleep 30";
	assert.equal((await preflight(command)).result?.block, true);
});

test("inherited new and legacy confirmation work; notify marker never bypasses", async () => {
	for (const name of ["PI_COMMAND_POLICY_CONFIRM", "PI_SHIMS_CONFIRM"]) {
		try {
			process.env[name] = "1";
			assert.equal((await preflight("sleep 900")).result?.block, undefined);
			assert.equal((await preflight(`${name}=0 sleep 900`)).result?.block, true);
		} finally { delete process.env[name]; }
	}
	try {
		process.env.PI_NOTIFY_BACKGROUND = "1";
		assert.equal((await preflight("sleep 900")).result?.block, true);
	} finally { delete process.env.PI_NOTIFY_BACKGROUND; }
});

test("PATH injection remains idempotent; other tools unchanged; renamed status lists no sleep", async () => {
	const { event } = await preflight("rm -f build");
	assert.equal(event.input.command, `export PATH="${shimDirectory}:$PATH"\nrm -f build`);
	const injected = event.input.command;
	await runner.emitToolCall(event);
	assert.equal(event.input.command, injected);
	const other = { type: "tool_call", toolName: "read", toolCallId: "read-1", input: { path: "file" } };
	await runner.emitToolCall(other);
	assert.deepEqual(other.input, { path: "file" });
	assert.deepEqual(runner.getRegisteredCommands().map((command) => command.name), ["command-policy"]);
	let notification;
	runner.setUIContext({ notify: (message) => { notification = message; } }, "tui");
	await runner.getCommand("command-policy").handler("", runner.createCommandContext());
	assert.match(notification, /sleep: direct Bash input only/);
	assert.ok(notification.includes(`shim directory: ${shimDirectory}`));
	const files = (await readdir(shimDirectory)).sort();
	assert.equal(files.includes("sleep"), false);
	assert.ok(notification.includes(`shims: ${files.join(", ")}`));
});

test("allowed text, heredoc and opaque child code run through actual local Bash", async () => {
	const result = await execute("printf '%s\\n' 'sleep 900'; cat <<'EOF'\nsleep 900\nEOF\nbash -c 'sleep .02; echo opaque-done'");
	assert.match(output(result), /sleep 900\nsleep 900\nopaque-done/);
});

test("child script really runs a long system sleep with inherited PATH and no exemptions", async () => {
	const script = join(work, "worker.sh");
	await writeFile(script, `#!/usr/bin/env bash\nset -eu\ncommand -v sleep > timer-path\nprintf '%s' "$PATH" > inherited-path\nsleep 30 &\nprintf '%s' "$!" > timer-pid\nwait "$!"\n`, { mode: 0o755 });
	for (const invocation of ["bash ./worker.sh", "./worker.sh", "source ./worker.sh"]) {
		await rm(join(work, "timer-pid"), { force: true });
		const abort = new AbortController();
		// Catch immediately: cancellation/error is an expected tool result.
		const running = execute(invocation, abort.signal).catch((error) => error);
		let pid;
		try {
			const deadline = Date.now() + 3000;
			while (Date.now() < deadline) {
				try { pid = Number(await readFile(join(work, "timer-pid"), "utf8")); } catch {}
				if (pid) break;
				await new Promise((resolve) => setTimeout(resolve, 10));
			}
			assert.ok(pid, "child reached the actual timer");
			assert.equal((await readFile(join(work, "timer-path"), "utf8")).trim(), "/usr/bin/sleep");
			assert.ok((await readFile(join(work, "inherited-path"), "utf8")).startsWith(`${shimDirectory}:`));
			assert.equal(await readFile(`/proc/${pid}/cmdline`, "utf8"), "sleep\x0030\x00");
			const environment = await readFile(`/proc/${pid}/environ`, "utf8");
			assert.doesNotMatch(environment, /(?:PI_COMMAND_POLICY_CONFIRM|PI_SHIMS_CONFIRM|PI_NOTIFY_BACKGROUND)=1/);
		} finally {
			abort.abort();
			await running;
		}
	}
});

test("rm/search/ssh still intervene in child scripts through actual extension and Bash", async () => {
	await writeFile(join(work, "protected"), "retain");
	await writeFile(join(work, "guards.sh"), "rm -f protected\nprintf 'rm-status=%s\\n' \"$?\"\nfind . -maxdepth 0 -exec /bin/sleep 1 \\;\nprintf 'find-status=%s\\n' \"$?\"\nssh host uptime\nprintf 'ssh-status=%s\\n' \"$?\"\n");
	const fakeSsh = join(work, "fake-ssh");
	await writeFile(fakeSsh, "#!/bin/sh\nprintf 'fake ssh ran\\n'\nexit 23\n", { mode: 0o755 });
	const result = await execute(`PI_COMMAND_POLICY_SEARCH_TIMEOUT=.03s PI_COMMAND_POLICY_SSH_REAL='${fakeSsh}' bash ./guards.sh`);
	const text = output(result);
	assert.match(text, /rm-status=77/);
	assert.equal(await readFile(join(work, "protected"), "utf8"), "retain");
	assert.match(text, /find-status=77/);
	assert.match(text, /was killed; partial output/);
	assert.match(text, /one-shot ssh/);
	assert.match(text, /fake ssh ran/);
	assert.match(text, /ssh-status=23/);
});
