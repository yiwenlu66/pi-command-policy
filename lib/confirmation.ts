// One confirmation assignment names one policy. A value that names all of them
// (the old `PI_COMMAND_POLICY_CONFIRM=1`, empty, or unknown text) is refused
// wherever it appears: it is the habit of blanket confirmation, not a decision.

export const confirmationName = "PI_COMMAND_POLICY_CONFIRM";
export const legacyConfirmationName = "PI_SHIMS_CONFIRM";

/** A confirmation value that names a policy. `bound: null` is a sleep
 * confirmation written without a usable `\d+(\.\d+)?[smhd]?` bound. */
export type Confirmation = { policy: "rm" | "search" } | { policy: "sleep"; bound: number | null };

const factors: Record<string, number> = { "": 1, s: 1, m: 60, h: 3600, d: 86400 };

/** Parse one PI_COMMAND_POLICY_CONFIRM value. Undefined means the value names no
 * policy at all, so it confirms nothing checkable and is refused. */
export function parseConfirmation(value: string): Confirmation | undefined {
	if (value === "rm" || value === "search") return { policy: value };
	if (value !== "sleep" && !value.startsWith("sleep:")) return undefined;
	const match = /^sleep:(\d+(?:\.\d+)?)([smhd]?)$/.exec(value);
	return { policy: "sleep", bound: match ? Number(match[1]) * factors[match[2]] : null };
}

function seconds(value: number): string {
	return Number.isFinite(value) ? String(value) : "inf";
}

const assignmentWord = new RegExp(`^(${confirmationName}|${legacyConfirmationName})(\\+?)=`);

/** An `export` argument whose text carries the assignment itself, instead of an
 * assignment node: `export "PI_COMMAND_POLICY_CONFIRM=rm"` exports the same
 * variable the unquoted spelling does. */
export function parseAssignmentWord(text: string): { name: string; value: string; invalid: boolean } | undefined {
	const match = assignmentWord.exec(text);
	if (!match) return undefined;
	return { name: match[1], value: text.slice(match[0].length), invalid: match[2] === "+" };
}

export const blanketReason = "pi-command-policy: PI_COMMAND_POLICY_CONFIRM=1 and PI_SHIMS_CONFIRM are refused — a blanket confirmation switches off every guard at once.\n"
	+ "Name the policy you are confirming: PI_COMMAND_POLICY_CONFIRM=rm, PI_COMMAND_POLICY_CONFIRM=search, or PI_COMMAND_POLICY_CONFIRM=sleep:<bound> (e.g. sleep:30s).\n"
	+ "The narrow escapes still work: /bin/sleep and /bin/rm. Confirm only when the wait or the deletion is genuinely unavoidable.";

export const unboundReason = "pi-command-policy: PI_COMMAND_POLICY_CONFIRM=sleep needs the wait you are accepting, e.g. sleep:30s.\n"
	+ "A confirmation without a bound confirms nothing checkable: do not re-add it to get past this message.\n"
	+ "Run the work in the background instead; use /bin/sleep only when the wait is genuinely unavoidable.";

export function boundTooSmallReason(bound: number, total: number): string {
	return `pi-command-policy: PI_COMMAND_POLICY_CONFIRM=sleep:${seconds(bound)} is below this command's ${seconds(total)}s of sleeping.\n`
		+ "Do not raise the bound to clear this message. Drop the timer and run the work in the background; raise the bound only when the full wait is genuinely unavoidable.";
}

export const inertReason = "pi-command-policy: nothing on this assignment's command can trigger the sleep policy, so PI_COMMAND_POLICY_CONFIRM=sleep:<bound> confirms nothing.\n"
	+ "Drop the assignment: child scripts are never inspected, and /bin/sleep is already unconditional.";

export const exportSleepReason = "pi-command-policy: PI_COMMAND_POLICY_CONFIRM=sleep:<bound> cannot be exported — the sleep policy reads the assignment on the command that waits, never the environment.\n"
	+ "Put it on the waiting command itself (PI_COMMAND_POLICY_CONFIRM=sleep:900 sleep 900), or drop it and background the work.";
