import { forEachChild, parse, type Command, type CompoundList, type ParsedScript, type SyntaxNode } from "unbash";
import { literal } from "./shell-words.ts";

// Commands that produce no output and change nothing. `:` is the POSIX synonym
// for `true`. Bash runs the builtin for a bare `true`, so a PATH shim could
// never intercept it; the coreutils paths are matched too.
const trueNames = new Set(["true", ":", "/bin/true", "/usr/bin/true"]);
const falseNames = new Set(["false", "/bin/false", "/usr/bin/false"]);

/** A named command with no arguments and no redirections. `: >file` truncates a
 * file, so a redirection is a real side effect and disqualifies the no-op. */
function bareCommand(command: Command, names: Set<string>): boolean {
	const name = literal(command.name);
	return name !== undefined && names.has(name) && command.args.length === 0 && command.redirects.length === 0;
}

/** The list's only statement as a plain command, when it is exactly that. */
function soleCommand(list: CompoundList): Command | undefined {
	if (list.commands.length !== 1) return undefined;
	const statement = list.commands[0];
	if (statement.background || statement.command.type !== "Command") return undefined;
	return statement.command;
}

function isNoop(command: Command): boolean {
	return bareCommand(command, trueNames);
}

/** A list whose every statement is a bare no-op; `break`/`exit` are not no-ops,
 * so a loop that can terminate is never mistaken for a busy-wait. */
function onlyNoops(list: CompoundList): boolean {
	return list.commands.length > 0 && list.commands.every((statement) =>
		!statement.background && statement.command.type === "Command" && isNoop(statement.command));
}

/** An `until false`/`while true` whose condition can never change and whose body
 * does nothing: a loop that only spins a CPU core. */
function busyLoop(node: SyntaxNode): boolean {
	if (node.type !== "While") return false;
	const condition = soleCommand(node.clause);
	if (!condition) return false;
	const spins = node.kind === "until" ? bareCommand(condition, falseNames) : isNoop(condition);
	return spins && onlyNoops(node.body);
}

const noopReason = "pi-command-policy: bare `true`/`:` refused — a built-in no-op that prints nothing and changes nothing.\n"
	+ "Repeating it does not wait for a background job or make progress; it only spins tool calls.\n"
	+ "Run long work in the background and arm a watcher or completion notification, or take the next real step now.";

const loopReason = "pi-command-policy: empty `while true`/`until false` loop refused — its body does nothing, so it spins a CPU core and holds the turn indefinitely.\n"
	+ "Run the work in the background and arm a watcher or completion notification instead of busy-waiting.";

/** Inspect supplied Bash syntax only; never read scripts or evaluate shell state. */
export function noopPolicyReason(source: string): string | undefined {
	let script: ParsedScript;
	try {
		script = parse(source);
	} catch {
		// Tolerant parsing can still fail outright; guidance must fail open.
		return undefined;
	}
	// Recovery can leave a partial tree, so an uncertain parse is not evidence.
	if (script.errors?.length) return undefined;

	// The whole call is nothing but bare no-ops, e.g. a lone `true`.
	const entireNoop = script.commands.length > 0 && script.commands.every((statement) =>
		!statement.background && statement.command.type === "Command" && isNoop(statement.command));

	let loop = false;
	function visit(node: SyntaxNode): void {
		// Background statements return the Bash tool promptly; a backgrounded
		// loop or no-op is harmless and out of scope, like a background sleep.
		if (node.type === "Statement" && node.background) return;
		if (node.type === "HereDoc") return;
		if (busyLoop(node)) loop = true;
		forEachChild(node, visit);
	}
	visit(script);

	if (loop) return loopReason;
	if (entireNoop) return noopReason;
	return undefined;
}
