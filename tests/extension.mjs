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
		"echo \"$(sleep 30)\"", "cat <(sleep 30)",
		"sleep inf", "sleep infinity", "sleep INF", "sleep 'infinity'", "sleep -- inf", "sleep 1 inf",
		"sleep 30 & sleep 30",
		"PI_NOTIFY_BACKGROUND=1 sleep 900", "PI_NOTIFY_BACKGROUND=0 sleep 900",
		`echo '${shimDirectory}'; sleep 900`, `export PATH="${shimDirectory}:$PATH"\nsleep 900`,
	];
	for (const command of cases) {
		const { event, result } = await preflight(command);
		assert.equal(result?.block, true, command);
		assert.match(result.reason, /pi-command-policy: direct sleep refused/);
		assert.match(result.reason, /background/);
		assert.match(result.reason, /persistent session \(tmux or similar\), not `&`\/nohup/);
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
		"/bin/sleep 900", "PI_COMMAND_POLICY_CONFIRM=rm sleep .1", "PI_COMMAND_POLICY_CONFIRM=search sleep .1",
		"sleep 30 &", "(sleep 30; echo late) &", "true && sleep 30 &", "sleep 30 & wait",
		"while sleep 30; do :; done &", "sleep inf &", "sleep inf invalid", "sleep infinity $WAIT",
	];
	for (const command of cases) {
		const { result } = await preflight(command);
		assert.equal(result?.block, undefined, command);
	}
});

test("bare no-op commands block with guidance and no confirmation bypass", async () => {
	const cases = [
		"true", ":", "true;", "  true  ", "true # comment", "/bin/true", "/usr/bin/true",
		": ;", "true\ntrue", "FOO=bar true",
		// A no-op is never a deliberate policy decision, so its specific reason
		// outranks the confirmation vocabulary on the same command.
		"PI_COMMAND_POLICY_CONFIRM=1 true", "PI_SHIMS_CONFIRM=1 :", "PI_COMMAND_POLICY_CONFIRM=sleep:900 true",
	];
	for (const command of cases) {
		const { event, result } = await preflight(command);
		assert.equal(result?.block, true, command);
		assert.match(result.reason, /pi-command-policy: bare `true`\/`:` refused/);
		assert.match(result.reason, /background/);
		assert.match(result.reason, /watcher or completion notification/);
		assert.doesNotMatch(result.reason, /pi-notify/);
		assert.equal(event.input.command, command, "blocked no-op input is not mutated");
	}
});

test("empty while-true/until-false loops block", async () => {
	const cases = [
		"while true; do :; done", "while :; do true; done", "until false; do :; done",
		"while true; do true; done", "while /bin/true; do :; done", "until /usr/bin/false; do :; done",
		"while true; do :; done; echo after", "while true; do while :; do :; done; done",
	];
	for (const command of cases) {
		const { result } = await preflight(command);
		assert.equal(result?.block, true, command);
		assert.match(result.reason, /loop refused/);
		assert.match(result.reason, /watcher or completion notification/);
	}
});

test("real commands, redirects, assertions, background and terminating loops stay allowed", async () => {
	const cases = [
		"echo true", "printf '%s\\n' ':'", "true && echo ran", "true | cat",
		"true > file", ": > file", ": ${X:=set}", "if true; then echo yes; fi",
		"while true; do echo once; break; done", "while true; do sleep .01; break; done",
		"while false; do :; done", "until true; do :; done",
		"true &", "while true; do :; done &", "(while true; do :; done) &",
		"cat <<'EOF'\nwhile true; do :; done\nEOF",
		"bash -c 'while true; do :; done'", "sh -c 'true'",
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

test("sleep:<bound> confirms a wait only when the bound covers this command's total", async () => {
	const cases = [
		"PI_COMMAND_POLICY_CONFIRM=sleep:900 sleep 900",
		"PI_COMMAND_POLICY_CONFIRM=sleep:1.5m sleep 90",
		"PI_COMMAND_POLICY_CONFIRM=sleep:30 sleep 30",
		"PI_COMMAND_POLICY_CONFIRM=sleep:2m sleep 90",
		"PI_COMMAND_POLICY_CONFIRM=sleep:10 sleep 6 4",
		"PI_COMMAND_POLICY_CONFIRM=sleep:900 sleep -- 900",
		"PI_COMMAND_POLICY_CONFIRM='sleep:30' sleep 30",
		'PI_COMMAND_POLICY_CONFIRM="sleep:30" sleep 30',
	];
	for (const command of cases) {
		const { result } = await preflight(command);
		assert.equal(result?.block, undefined, command);
	}
	// A covered wait is still per command: the second timer has no bound.
	assert.match((await preflight("PI_COMMAND_POLICY_CONFIRM=sleep:30 sleep 30; sleep 900")).result.reason,
		/pi-command-policy: direct sleep refused/);
});

test("the blanket value and the legacy name are refused whatever follows them", async () => {
	const cases = [
		"PI_COMMAND_POLICY_CONFIRM=1 sleep 900",
		"PI_COMMAND_POLICY_CONFIRM=1 rm -rf x",
		"PI_COMMAND_POLICY_CONFIRM=1 ls",
		"PI_COMMAND_POLICY_CONFIRM=1",
		"PI_COMMAND_POLICY_CONFIRM=1 bash ./cleanup.sh",
		"PI_COMMAND_POLICY_CONFIRM= sleep 900",
		"PI_COMMAND_POLICY_CONFIRM= ls",
		"PI_COMMAND_POLICY_CONFIRM=yes ls",
		"PI_COMMAND_POLICY_CONFIRM=0 ls",
		"PI_COMMAND_POLICY_CONFIRM=RM ls",
		"PI_SHIMS_CONFIRM=1 sleep 900",
		"PI_SHIMS_CONFIRM=1 bash ./cleanup.sh",
		"PI_SHIMS_CONFIRM=0 rm -f x",
		"PI_SHIMS_CONFIRM= ls",
		// The same ritual written as an export, and non-plain assignments, are
		// equally unreadable as a policy decision.
		"export PI_COMMAND_POLICY_CONFIRM=1; rm -rf x",
		"export PI_SHIMS_CONFIRM=1",
		"export PI_SHIMS_CONFIRM=",
		// Quoting moves the assignment into an export argument word.
		'export "PI_COMMAND_POLICY_CONFIRM=1"; rm -rf x',
		"export 'PI_SHIMS_CONFIRM=1'",
		'export "PI_COMMAND_POLICY_CONFIRM+=1"',
		"PI_COMMAND_POLICY_CONFIRM+=1 ls",
		"export PI_COMMAND_POLICY_CONFIRM+=1",
		"PI_COMMAND_POLICY_CONFIRM[0]=1 ls",
		// The vocabulary check precedes the shim-directory early return.
		`echo '${shimDirectory}'; PI_COMMAND_POLICY_CONFIRM=1 ls`,
	];
	for (const command of cases) {
		const { event, result } = await preflight(command);
		assert.equal(result?.block, true, command);
		assert.match(result.reason, /PI_COMMAND_POLICY_CONFIRM=1 and PI_SHIMS_CONFIRM are refused/, command);
		assert.match(result.reason, /Name the policy you are confirming: PI_COMMAND_POLICY_CONFIRM=rm, PI_COMMAND_POLICY_CONFIRM=search, or PI_COMMAND_POLICY_CONFIRM=sleep:<bound> \(e\.g\. sleep:30s\)/);
		assert.match(result.reason, /The narrow escapes still work: \/bin\/sleep and \/bin\/rm\. Confirm only when the wait or the deletion is genuinely unavoidable/);
		assert.equal(event.input.command, command, "blocked blanket input is not mutated");
	}
});

test("a sleep confirmation without a usable bound is refused as unbound", async () => {
	const cases = [
		"PI_COMMAND_POLICY_CONFIRM=sleep sleep 900",
		"PI_COMMAND_POLICY_CONFIRM=sleep ls",
		"PI_COMMAND_POLICY_CONFIRM=sleep: sleep 900",
		"PI_COMMAND_POLICY_CONFIRM=sleep:x sleep 900",
		"PI_COMMAND_POLICY_CONFIRM=sleep:30x sleep 900",
		"PI_COMMAND_POLICY_CONFIRM=sleep:30. sleep 900",
		"PI_COMMAND_POLICY_CONFIRM=sleep:+30 sleep 900",
		"PI_COMMAND_POLICY_CONFIRM=sleep:-30 ls",
		"PI_COMMAND_POLICY_CONFIRM=sleep:1.5.5 sleep 900",
	];
	for (const command of cases) {
		const { result } = await preflight(command);
		assert.equal(result?.block, true, command);
		assert.match(result.reason, /PI_COMMAND_POLICY_CONFIRM=sleep needs the wait you are accepting, e\.g\. sleep:30s/, command);
		assert.match(result.reason, /A confirmation without a bound confirms nothing checkable: do not re-add it to get past this message/);
		assert.match(result.reason, /Run the work in the background instead; use \/bin\/sleep only when the wait is genuinely unavoidable/);
	}
});

test("a bound below the command's own total is refused quoting both numbers", async () => {
	const cases = [
		["PI_COMMAND_POLICY_CONFIRM=sleep:30 sleep 60", "sleep:30 is below this command's 60s of sleeping"],
		["PI_COMMAND_POLICY_CONFIRM=sleep:9 sleep 6 4", "sleep:9 is below this command's 10s of sleeping"],
		["PI_COMMAND_POLICY_CONFIRM=sleep:0.1m sleep 6 4", "sleep:6 is below this command's 10s of sleeping"],
		["PI_COMMAND_POLICY_CONFIRM=sleep:899 sleep 900", "sleep:899 is below this command's 900s of sleeping"],
	];
	for (const [command, quoted] of cases) {
		const { result } = await preflight(command);
		assert.equal(result?.block, true, command);
		assert.ok(result.reason.includes(`pi-command-policy: PI_COMMAND_POLICY_CONFIRM=${quoted}.`), result.reason);
		assert.match(result.reason, /Do not raise the bound to clear this message\. Drop the timer and run the work in the background; raise the bound only when the full wait is genuinely unavoidable/);
	}
});

test("a sleep confirmation on a command the policy cannot refuse is inert", async () => {
	const cases = [
		"PI_COMMAND_POLICY_CONFIRM=sleep:30 sleep 8",
		"PI_COMMAND_POLICY_CONFIRM=sleep:30 /bin/sleep 4",
		"PI_COMMAND_POLICY_CONFIRM=sleep:30 bash ./worker.sh",
		"PI_COMMAND_POLICY_CONFIRM=sleep:30 ls",
		"PI_COMMAND_POLICY_CONFIRM=sleep:900 echo ready",
		"PI_COMMAND_POLICY_CONFIRM=sleep:30 sleep 900 invalid",
		"PI_COMMAND_POLICY_CONFIRM=sleep:30 make && sleep 900",
	];
	for (const command of cases) {
		const { result } = await preflight(command);
		assert.equal(result?.block, true, command);
		assert.match(result.reason, /nothing on this assignment's command can trigger the sleep policy, so PI_COMMAND_POLICY_CONFIRM=sleep:<bound> confirms nothing/, command);
		assert.match(result.reason, /Drop the assignment: child scripts are never inspected, and \/bin\/sleep is already unconditional/);
	}
});

test("a sleep confirmation cannot be exported; the bound belongs on the waiting command", async () => {
	// The sleep policy reads the assignment on the command that waits, never the
	// environment, so the refusal must say that instead of claiming the script has
	// nothing to refuse: `export ...=sleep:900; sleep 900` does wait.
	const cases = [
		"export PI_COMMAND_POLICY_CONFIRM=sleep",
		"export PI_COMMAND_POLICY_CONFIRM=sleep:30",
		"export PI_COMMAND_POLICY_CONFIRM=sleep:900; sleep 900",
		"export PI_COMMAND_POLICY_CONFIRM=sleep:30 bash ./worker.sh",
		'export "PI_COMMAND_POLICY_CONFIRM=sleep:30"',
	];
	for (const command of cases) {
		const { result } = await preflight(command);
		assert.equal(result?.block, true, command);
		assert.match(result.reason, /PI_COMMAND_POLICY_CONFIRM=sleep:<bound> cannot be exported/, command);
		assert.match(result.reason, /Put it on the waiting command itself \(PI_COMMAND_POLICY_CONFIRM=sleep:900 sleep 900\), or drop it and background the work/);
	}
});

test("policy-named values pass the extension and never confirm another policy", async () => {
	// rm / search name their own shims: the extension leaves the input alone, so
	// the shim still decides, and a scoped export is the deliberate child-script form.
	for (const command of ["PI_COMMAND_POLICY_CONFIRM=rm rm -f x", "PI_COMMAND_POLICY_CONFIRM=search grep needle .", "export PI_COMMAND_POLICY_CONFIRM=rm", "export PI_COMMAND_POLICY_CONFIRM=search", 'export "PI_COMMAND_POLICY_CONFIRM=rm"', "PI_COMMAND_POLICY_CONFIRM=rm", "PI_COMMAND_POLICY_CONFIRM=search"]) {
		const { event, result } = await preflight(command);
		assert.equal(result?.block, undefined, command);
		assert.equal(event.input.command, `export PATH="${shimDirectory}:$PATH"\n${command}`, `${command} keeps its assignment intact`);
	}
	// rm does not confirm sleep.
	const { result } = await preflight("PI_COMMAND_POLICY_CONFIRM=rm sleep 900");
	assert.equal(result?.block, true);
	assert.match(result.reason, /pi-command-policy: direct sleep refused/);
});

test("inherited confirmation values no longer confirm; notify marker never bypasses", async () => {
	for (const name of ["PI_COMMAND_POLICY_CONFIRM", "PI_SHIMS_CONFIRM", "RM_GUARD_CONFIRM"]) {
		for (const value of ["1", "sleep:900", "rm", "search", ""]) {
			try {
				process.env[name] = value;
				const { result } = await preflight("sleep 900");
				assert.equal(result?.block, true, `${name}=${value} must not confirm sleep`);
				assert.match(result.reason, /pi-command-policy: direct sleep refused/);
				// A standing value that names a policy is not a refusal either.
				assert.equal((await preflight("sleep .1")).result?.block, undefined);
			} finally { delete process.env[name]; }
		}
	}
	try {
		process.env.PI_COMMAND_POLICY_CONFIRM = "sleep:900";
		assert.match((await preflight("PI_COMMAND_POLICY_CONFIRM=1 ls")).result.reason, /PI_COMMAND_POLICY_CONFIRM=1 and PI_SHIMS_CONFIRM are refused/);
	} finally { delete process.env.PI_COMMAND_POLICY_CONFIRM; }
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
	assert.match(notification, /confirm: PI_COMMAND_POLICY_CONFIRM=rm\|search\|sleep:<bound>; =1 and PI_SHIMS_CONFIRM refused/);
	assert.ok(notification.includes(`shim directory: ${shimDirectory}`));
	const files = (await readdir(shimDirectory)).sort();
	assert.equal(files.includes("sleep"), false);
	assert.ok(notification.includes(`shims: ${files.join(", ")}`));
});

test("allowed text, heredoc and opaque child code run through actual local Bash", async () => {
	const result = await execute("printf '%s\\n' 'sleep 900'; cat <<'EOF'\nsleep 900\nEOF\nbash -c 'sleep .02; echo opaque-done'");
	assert.match(output(result), /sleep 900\nsleep 900\nopaque-done/);
});

test("background statements return promptly through actual Bash and leave no live timer after cleanup", async () => {
	async function descendants(pid) {
		const children = (await readFile(`/proc/${pid}/task/${pid}/children`, "utf8")).trim();
		const nested = await Promise.all(children ? children.split(/\s+/).map((child) => descendants(Number(child))) : []);
		return [pid, ...nested.flat()];
	}
	for (const background of ["sleep 30 &", "(sleep 30; echo late) &", "true && sleep 30 &"]) {
		const pidFile = join(work, "background-pid");
		await rm(pidFile, { force: true });
		const abort = new AbortController();
		const timeout = setTimeout(() => abort.abort(), 1500);
		let pids = [];
		try {
			const started = performance.now();
			const result = await execute(`${background} printf '%s' "$!" > '${pidFile}'`, abort.signal);
			assert.ok(performance.now() - started < 1500, `${background} must not wait for the 30s timer`);
			assert.doesNotMatch(output(result), /late/);
			const pid = Number(await readFile(pidFile, "utf8"));
			pids = await descendants(pid);
			const commands = await Promise.all(pids.map((child) => readFile(`/proc/${child}/cmdline`, "utf8")));
			assert.ok(commands.includes("sleep\x0030\x00"), "a real long timer remains alive after Bash returns");
		} finally {
			clearTimeout(timeout);
			abort.abort();
			// On assertion/timeout failure, still collect any launched tree before
			// deleting its pid file. No background timer may escape this test.
			if (!pids.length) {
				try { pids = await descendants(Number(await readFile(pidFile, "utf8"))); } catch {}
			}
			for (const pid of pids) {
				try { process.kill(pid, "SIGKILL"); } catch (error) { if (error.code !== "ESRCH") throw error; }
			}
			for (const pid of pids) {
				const deadline = Date.now() + 1000;
				while (true) {
					try {
						const stat = await readFile(`/proc/${pid}/stat`, "utf8");
						if (/^[ZX]/.test(stat.slice(stat.lastIndexOf(")") + 2))) break;
					} catch (error) {
						if (error.code === "ENOENT" || error.code === "ESRCH") break;
						throw error;
					}
					assert.ok(Date.now() < deadline, "cleanup leaves no executing child");
					await new Promise((resolve) => setTimeout(resolve, 10));
				}
			}
		}
	}
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
