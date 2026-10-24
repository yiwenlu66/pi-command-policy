import { forEachChild, parse, type Command, type SyntaxNode, type Word, type WordPart } from "unbash";

const confirmationNames = ["PI_COMMAND_POLICY_CONFIRM", "PI_SHIMS_CONFIRM"];

function isStaticPart(part: WordPart): boolean {
	switch (part.type) {
		case "Literal":
		case "SingleQuoted":
		case "AnsiCQuoted":
			return true;
		case "DoubleQuoted":
			return part.parts.every(isStaticPart);
		default:
			return false;
	}
}

function literal(word: Word | undefined): string | undefined {
	if (!word || (word.parts && !word.parts.every(isStaticPart))) return undefined;
	return word.value;
}

function confirmed(command: Command): boolean {
	return confirmationNames.some((name) => {
		const assignment = command.prefix.findLast((node) => node.type === "Assignment" && node.name === name);
		if (assignment?.type === "Assignment") {
			return !assignment.append && !assignment.index && assignment.value.type === "Word" && literal(assignment.value) === "1";
		}
		return process.env[name] === "1";
	});
}

function longSleep(command: Command): boolean {
	if (literal(command.name) !== "sleep" || confirmed(command)) return false;
	let total = 0;
	let correction = 0;
	let long = false;
	let optionsEnded = false;
	for (const argument of command.args) {
		if (argument.type !== "Word") return false;
		const value = literal(argument);
		if (value === "--" && !optionsEnded) {
			optionsEnded = true;
			continue;
		}
		if (value && /^(?:inf|infinity)$/i.test(value)) {
			long = true;
			continue;
		}
		// This validates a parsed operand, never shell source. Unknown syntax is
		// left to the real sleep command, even after a known long operand.
		const match = value?.match(/^\+?(\d+(?:\.\d*)?|\.\d+)([smhd]?)$/);
		if (!match) return false;
		const factor = { s: 1, m: 60, h: 3600, d: 86400, "": 1 }[match[2]]!;
		if (!long) {
			const adjusted = Number(match[1]) * factor - correction;
			const sum = total + adjusted;
			correction = (sum - total) - adjusted;
			total = sum;
			long = total >= 10;
		}
	}
	return long;
}

/** Inspect supplied Bash syntax only; never read scripts or evaluate shell state. */
export function sleepPolicyReason(source: string): string | undefined {
	let found = false;
	let uncertain = false;
	function visit(node: SyntaxNode): void {
		// Background statements do not hold the Bash tool open. Prune the whole
		// statement, including compound commands, rather than individual sleeps.
		if (node.type === "Statement" && node.background) return;
		// Even expansions in a here-document are outside this policy's scope.
		if (node.type === "HereDoc") return;
		if (node.type === "Script" && node.errors?.length) uncertain = true;
		if (node.type === "Command" && longSleep(node)) found = true;
		forEachChild(node, visit);
	}
	try {
		visit(parse(source));
	} catch {
		// Tolerant parsing and lazy nested scripts can still fail. Workflow
		// guidance must not prevent unrelated Bash from running on uncertainty.
		return undefined;
	}
	if (!found || uncertain) return undefined;
	return "pi-command-policy: direct sleep refused (total >= 10s). Blocking the turn on a timer stalls the task.\n"
		+ "Run the long process in the background (tmux/nohup/&), arrange a watcher or completion notification, and keep advancing the task.\n"
		+ "To wait deliberately: /bin/sleep, or prefix sleep with PI_COMMAND_POLICY_CONFIRM=1 (legacy PI_SHIMS_CONFIRM=1 also works). Child scripts are never inspected; their sleeps run normally.";
}
