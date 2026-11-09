import { forEachChild, parse, type Assignment, type Command, type SyntaxNode } from "unbash";
import { literal } from "./shell-words.ts";
import {
	blanketReason,
	boundTooSmallReason,
	confirmationName,
	exportSleepReason,
	inertReason,
	legacyConfirmationName,
	parseAssignmentWord,
	parseConfirmation,
	unboundReason,
} from "./confirmation.ts";

const longSleepSeconds = 10;

const sleepReason = "pi-command-policy: direct sleep refused (total >= 10s). Waiting is not progress, and polling a job you started is not a reason to hold the turn.\n"
	+ "Do not escape this unless the next action genuinely depends on the result and the work cannot be backgrounded. Run it in a persistent session (tmux or similar), not `&`/nohup, which leave nothing to return to; arm a watcher or completion notification, and take the next real step.\n"
	+ "If the wait is unavoidable, state the bound you accept on this command: PI_COMMAND_POLICY_CONFIRM=sleep:30s. /bin/sleep stays unconditional; child scripts are never inspected.";

/** A command's literal sleep total in seconds, `Infinity` for a GNU `inf`.
 * Undefined when the command is not a literal sleep invocation: a different name
 * or any operand that is not a statically known duration. */
function literalTotal(command: Command): number | undefined {
	if (literal(command.name) !== "sleep") return undefined;
	let total = 0;
	let correction = 0;
	let infinite = false;
	let optionsEnded = false;
	for (const argument of command.args) {
		if (argument.type !== "Word") return undefined;
		const value = literal(argument);
		if (value === "--" && !optionsEnded) {
			optionsEnded = true;
			continue;
		}
		if (value && /^(?:inf|infinity)$/i.test(value)) {
			infinite = true;
			continue;
		}
		// This validates a parsed operand, never shell source. Unknown syntax is
		// left to the real sleep command, even after a known long operand.
		const match = value?.match(/^\+?(\d+(?:\.\d*)?|\.\d+)([smhd]?)$/);
		if (!match) return undefined;
		const factor = { s: 1, m: 60, h: 3600, d: 86400, "": 1 }[match[2]]!;
		const adjusted = Number(match[1]) * factor - correction;
		const sum = total + adjusted;
		correction = (sum - total) - adjusted;
		total = sum;
	}
	return infinite ? Infinity : total;
}

/** Confirmation assignments on this command: its own prefix plus `export`
 * arguments, which set the same variables for the rest of the call. Appends and
 * indexed assignments name no policy and are reported invalid. */
function* confirmationAssignments(command: Command): Generator<{ name: string; value: string | undefined; invalid: boolean; exported: boolean }> {
	const inspect = (node: Assignment) => ({ name: node.name, value: literal(node.value), invalid: Boolean(node.append || node.index), exported: literal(command.name) === "export" });
	for (const node of command.prefix) {
		if (node.type === "Assignment") yield inspect(node);
	}
	if (literal(command.name) === "export") {
		for (const node of command.args) {
			if (node.type === "Assignment") {
				yield inspect(node);
				continue;
			}
			// `export "NAME=value"` reaches the parser as a word, not an assignment.
			const text = node.type === "Word" ? literal(node) : undefined;
			const word = text === undefined ? undefined : parseAssignmentWord(text);
			if (word) yield { ...word, exported: true };
		}
	}
}

/** Why this command's confirmation assignment is refused, or undefined when it
 * names a policy this command may use. A `sleep:<bound>` confirms only the wait
 * authored on the command that carries it, so it is inert on any command the
 * sleep policy cannot refuse. The environment is deliberately not consulted: a
 * standing value says nothing about input this policy never inspected. */
function commandReason(command: Command): string | undefined {
	const total = literalTotal(command);
	let value: string | undefined;
	let exported = false;
	for (const assignment of confirmationAssignments(command)) {
		// The legacy name and every non-plain assignment are refused wherever they
		// appear, whatever the command that follows.
		if (assignment.name === legacyConfirmationName || assignment.invalid) return blanketReason;
		if (assignment.name === confirmationName) {
			value = assignment.value;
			exported = assignment.exported;
		}
	}
	let confirmed = false;
	// An unreadable value (an expansion) confirms nothing; the sleep check below
	// then refuses a long wait, and a command the policy cannot refuse is left alone.
	if (value !== undefined) {
		const parsed = parseConfirmation(value);
		if (!parsed) return blanketReason;
		if (parsed.policy === "sleep") {
			if (exported) return exportSleepReason;
			if (parsed.bound === null) return unboundReason;
			if (total === undefined || total < longSleepSeconds) return inertReason;
			if (total > parsed.bound) return boundTooSmallReason(parsed.bound, total);
			confirmed = true;
		}
	}
	if (!confirmed && total !== undefined && total >= longSleepSeconds) return sleepReason;
	return undefined;
}

/** Inspect supplied Bash syntax only; never read scripts or evaluate shell state. */
export function sleepPolicyReason(source: string): string | undefined {
	let reason: string | undefined;
	let uncertain = false;
	function visit(node: SyntaxNode): void {
		// Background statements do not hold the Bash tool open. Prune the whole
		// statement, including compound commands, rather than individual sleeps.
		if (node.type === "Statement" && node.background) return;
		// Even expansions in a here-document are outside this policy's scope.
		if (node.type === "HereDoc") return;
		if (node.type === "Script" && node.errors?.length) uncertain = true;
		if (node.type === "Command") reason ??= commandReason(node);
		forEachChild(node, visit);
	}
	try {
		visit(parse(source));
	} catch {
		// Tolerant parsing and lazy nested scripts can still fail. Workflow
		// guidance must not prevent unrelated Bash from running on uncertainty.
		return undefined;
	}
	if (uncertain) return undefined;
	return reason;
}
