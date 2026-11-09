// One confirmation assignment names one policy, and nothing else counts. A value
// that names all of them (the old `PI_COMMAND_POLICY_CONFIRM=1`), an empty value,
// unknown text, or a bound such as `sleep:30` is refused wherever it appears: it
// is the habit of blanket confirmation, not a decision.

export const confirmationName = "PI_COMMAND_POLICY_CONFIRM";
export const legacyConfirmationName = "PI_SHIMS_CONFIRM";

export type Confirmation = { policy: "rm" | "search" | "sleep" };

/** Parse one PI_COMMAND_POLICY_CONFIRM value. Undefined means the value names no
 * policy, so it confirms nothing and is refused. */
export function parseConfirmation(value: string): Confirmation | undefined {
	if (value === "rm" || value === "search" || value === "sleep") return { policy: value };
	return undefined;
}

export const valueReason = "pi-command-policy: PI_COMMAND_POLICY_CONFIRM must be exactly rm, search, or sleep; any other value names no policy and is refused.\n"
	+ "PI_COMMAND_POLICY_CONFIRM=1 and PI_SHIMS_CONFIRM switched off every guard at once, and a bound such as sleep:30 states a wait nothing checks.\n"
	+ "The narrow escapes still work: /bin/sleep and /bin/rm. Confirm only when the wait or the deletion is genuinely unavoidable.";

export const inertReason = "pi-command-policy: nothing on this assignment's command can trigger the sleep policy, so PI_COMMAND_POLICY_CONFIRM=sleep confirms nothing.\n"
	+ "Drop the assignment: child scripts are never inspected, and /bin/sleep is already unconditional.";
