# pi-command-policy

Command policies that shape how Pi agents work. The extension parses shell code
supplied directly to the Bash tool to discourage long waits and no-op busy loops.
Separate Bash scripts in `bin/` confirm deletion targets, bound searches, and
remind about SSH session reuse, including inside invoked child scripts.

## Install

```sh
pi install git:github.com/yiwenlu66/pi-command-policy@v0.6.0
```

Start a new session or `/reload` after installation or upgrade: the direct-input
policies live in the extension handler.
`/command-policy` reports the direct-input sleep and no-op policies, the
confirmation vocabulary, and active `bin/` files.

## Mechanism

```text
Pi bash tool input
    │ command-policy tool_call handler parses the supplied Bash source
    ├─ literal sleep totaling >=10s → block tool call with workflow guidance
    ├─ bare no-op (true/:/paths) or empty while-true/until-false loop → block tool call
    │
    │ otherwise prepend: export PATH="<package>/bin:$PATH"
    ▼
active bash implementation (built-in, ShellGate, or another extension)
    ▼
rm/search/ssh in direct code, scripts, Makefiles, or subshells
    ▼
<package>/bin/<command> receives shell-expanded argv
    ├─ normal case / explicit confirmation → run real binary
    └─ refusing intervention → stderr guidance and exit 77
```

The extension mutates Bash tool-call input instead of replacing the Bash tool,
so it composes with extensions that own execution. Both direct-input checks run
**before** the existing PATH-injection idempotency check; mentioning the shim
directory never skips a policy. PATH injection leaves commands already containing
the shim directory unchanged, retaining the previous injection behavior.

`PI_COMMAND_POLICY_CONFIRM` names the policy it confirms: `rm`, `search`, or
`sleep`. The value is a decision, not a switch. `=1`, an empty value, unknown text
— including a stated bound such as `sleep:30` — and the legacy name
`PI_SHIMS_CONFIRM` (any value) are refused wherever they appear in direct input,
because none of them names the guard the caller meant. `RM_GUARD_CONFIRM=1` still
confirms rm alone.

A prefix on a script invocation carries the confirmation to its children:

```sh
PI_COMMAND_POLICY_CONFIRM=rm bash ./intentional-operation.sh
```

Every refusal states the prohibition, not just the routes: confirm only when the
wait or the deletion is genuinely unavoidable and the work cannot be backgrounded.
A value offered to clear a message rather than to name a decision — the blanket
`=1`, a bound, or a sleep confirmation on a command the policy cannot refuse — is
refused on its own terms.

Shim logic never reads stdin or prompts interactively; delegated commands retain
their normal I/O. Sleep uses Pi's blocking event result rather than a shell exit
code; refusing PATH shims still exit **77**.

## rm — confirm expanded deletion targets

**Trigger:** `rm` with at least one target, including inside scripts.

**Action:** refuse before deletion and report post-expansion absolute paths,
target type, directory entry counts (capped at 10,000), and approximate `du -sh`
size. Symlinks are reported as links, not their referents. `rm -f` without targets
retains its successful no-op behavior.

**Bypass:** `/bin/rm`, `PI_COMMAND_POLICY_CONFIRM=rm`, or rm-only
`RM_GUARD_CONFIRM=1`. The policy-named value covers rm in child scripts, which
inherit it; the rm-only value covers rm wherever it runs. The report lists the
resolved targets first, and the recipe underneath is conditional on having read
them: confirm only when the deletion is genuinely intended. A confirmation for
another policy does not confirm rm: `PI_COMMAND_POLICY_CONFIRM=search` and
`=sleep` fall through to the report. The legacy `PI_SHIMS_CONFIRM` and
the blanket `PI_COMMAND_POLICY_CONFIRM=1` confirm nothing and replace the report's
recipe with a migration line naming `PI_COMMAND_POLICY_CONFIRM=rm`.

```sh
/bin/rm -rf ./build
PI_COMMAND_POLICY_CONFIRM=rm rm -rf ./build
RM_GUARD_CONFIRM=1 bash ./cleanup.sh
```

## sleep — guide direct Bash waits

**Trigger:** a command named `sleep` in shell source supplied directly to Pi's
Bash tool, with statically known operands totaling at least **10 seconds**.
Decimal values and GNU suffixes `s`, `m`, `h`, and `d` are supported; `sleep 6 4`
is ten seconds. Literal GNU `inf` and `infinity` operands (case-insensitive) also
count as long waits. GNU's `--` option terminator is recognized (`sleep -- 900`).
Ordinary quoting and backslash escapes are decoded by the parser.

The parser sees command structure, so `make && sleep 900`, pipelines, groups,
subshells, loops such as `while sleep 30; do ...; done`, and function bodies in
the supplied source are checked. Command/process substitutions are executable
source and are checked too. Plain quoted text (`echo 'sleep 900'`), comments, and
heredoc contents never trigger, including expansions inside heredocs. This is a
syntactic check, not control-flow analysis: even an unreachable command or an
uncalled function body containing a known long sleep can block the whole call.
Background statements are exempt: `sleep 30 &`, `(sleep 30; echo done) &`, and
`make && sleep 30 &` do not hold the Bash tool open. The entire background
statement is skipped. Later `wait` commands are not inferred, so `sleep 30 & wait`
is also allowed even though it waits for completion.

**Action:** block the entire tool call before execution with guidance to run long
work in a persistent session — tmux or similar — rather than `&`/nohup, which
leave no session to return to and no readable output once the call ends; arrange
a watcher/completion notification and keep advancing the task.

**Child scripts run normally.** There is **no `bin/sleep`**. `bash ./worker.sh`,
`./worker.sh`, sourced files, Makefile recipes, and other invoked programs resolve
sleep to the real timer, even when they inherit the policy's `bin/` PATH. Files
are never read or recursively inspected. `bash -c 'sleep 900'`, `eval`, SSH remote
command strings, and other opaque program arguments are not parsed as shell code.
`PI_NOTIFY_BACKGROUND` is neither required nor honored by this package.

**Deliberate waits:** `/bin/sleep 900`, or
`PI_COMMAND_POLICY_CONFIRM=sleep sleep 900`. The confirmation is read from the
prefix of the command that waits and from nowhere else, so `sleep 30 ;
PI_COMMAND_POLICY_CONFIRM=sleep sleep 900` still refuses the first timer — the
policy stays per command. `PI_COMMAND_POLICY_CONFIRM=sleep` on a command the
sleep policy cannot refuse — `sleep 8`, `/bin/sleep 4`, `bash ./worker.sh` — is
refused as inert: it confirms nothing, and the habit is the thing being
interrupted. Background statements are pruned before inspection, so a
confirmation on one is never read; the timer returns promptly either way. A stated bound is
refused too; nothing would check the number, so it is a wait nobody verified.

Inherited confirmation is not honored. The policy inspects the source of this one
call, so a value exported before Pi started would accept a timer nobody named
here; `process.env` is ignored rather than refused, and a long sleep under an
exported value is refused by the generic rule. The extension reads prefixes only:
it does not emulate shell state from an earlier `export`, assignment, alias or
function, which is why an export is neither confirmed nor refused there. The PATH
shims do read their value from the environment of the process they run in, so
`export PI_COMMAND_POLICY_CONFIRM=rm` still reaches the rm calls of a script.

Wrappers such as `env sleep 900` or `command sleep 900` are outside the
named-command check. A confirmation that names `rm` or `search` confirms no
sleep: `PI_COMMAND_POLICY_CONFIRM=rm sleep 900` is refused.

**Uncertainty allows execution:** unresolved parameters, arithmetic, globs, or
other dynamic operands, unrecognized sleep options/durations, and parse errors
pass through. No expansion or shell execution is performed by the policy.
Examples: `sleep "$WAIT"`, `sleep $((900))`, and `sleep 900 invalid` are left to
Bash/the real sleep command. This is workflow guidance, not a security boundary.

### Parser choice

[unbash](https://github.com/webpro-nl/unbash) **6.0.1** provides a synchronous,
typed Bash AST with source positions and quote/expansion nodes. It is a single
runtime dependency (~362 KB unpacked) with no transitive dependencies, native
builds, WASM initialization, or external binaries. It replaces the ambiguity of
text matching without adding a bespoke shell lexer. The exact version is pinned
in `package.json`; tolerant parse errors fail open. Other shell dialects are
outside scope. The extension tests run through Pi's real loader and event runner,
not only the parsing helper.

## true, `:` and empty loops — refuse no-op busy-waits

**Trigger:** a Bash tool call whose supplied source is either one or more bare
no-op commands — `true`, `:`, `/bin/true`, `/usr/bin/true` — with no arguments
and no redirections, or an `until false`/`while true` loop whose condition can
never change and whose body is only such no-ops.

**Why here and not `bin/`:** `true` and `:` are Bash **built-ins**. A `bin/true`
PATH shim would never run, because Bash resolves a built-in before consulting
`PATH`. Detection therefore lives in the same AST check as sleep, before
execution.

**Action:** block the whole tool call with guidance. A lone `true` prints
nothing, so repeating it only spins tool calls; it does not wait for a background
job or advance the task. An empty `while true` loop spins a CPU core and holds
the turn. The guidance points to running the work in the background and arming a
watcher/completion notification.

**No bypass.** Unlike sleep, this policy has no `PI_COMMAND_POLICY_CONFIRM`
escape and no `bin/` equivalent: `PI_COMMAND_POLICY_CONFIRM=1 true` and
`/bin/true` are refused too, as is an assignment-prefixed `FOO=1 true`. A bare
no-op is never a deliberate action.

**Left alone:** a `true`/`:` with a redirection (`: >file` truncates a file) or
an argument (`: ${X:=set}` asserts); `true` as a condition or condition part
(`if true; then ...; fi`, `true && ...`); a normal loop body or terminating loop
(`while true; do work; break; done`); a loop with a real condition (`while
false`, `until true`); any background statement (`true &`, `while true; do :;
done &`); heredoc bodies; and opaque `bash -c '...'` strings. Text (`echo
true`) and pipelines (`true | cat`) never trigger. Shell wrappers such as
`command true`/`env true` are outside the named-command check, matching the sleep
policy's treatment of `env sleep`. Like sleep, this is workflow guidance rather
than a sandbox: an uncalled function body containing a busy loop can still block
the whole call.

## grep, rg, find, fd — bound filesystem searches

**Trigger:** a search runs longer than **60 seconds**. These shims run the real
binary under GNU `timeout 60s`. `grep`, `rg`, and generated `ag`/`ack` shims
**exempt pipe stdin**: `tail -f log | grep pattern` is a deliberate unbounded
streaming filter. The shim only checks `[ -p /dev/stdin ]`, without consuming it.
`find` and `fd` have no stdin mode and are always timed.

**Action:** timeout status 124 becomes exit 77. Partial output remains on stdout;
the stderr report says the run was killed and its output is incomplete, then says
to narrow the path instead of confirming it: `--include`/`--glob` or
`-maxdepth`/`--max-depth` as appropriate, excluding `.git`/`node_modules`, and
`rg`/`fd` in preference to `grep -R`/`find`. Normal exit codes and output are
preserved.

**Bypass:** `PI_COMMAND_POLICY_CONFIRM=search` or the real binary's absolute path,
which is included in the timeout report. `PI_COMMAND_POLICY_SEARCH_TIMEOUT`
(legacy `PI_SHIMS_SEARCH_TIMEOUT`) overrides the duration
for fast tests or a deliberate alternative limit (GNU timeout syntax, e.g.
`.05s` or `2m`); the default remains `60s`.

The shipped shims match tools installed on the development machine: `grep`,
`rg`, `find`, and `fd`; `ag`/`ack` were absent. They prefer `/bin/grep` and
`/usr/bin/<name>`. If missing there, lookup walks PATH, skips the shim and
same-file aliases, and resolves the real executable to an absolute path. This
also supports a user-local `fd` without hardcoding a home directory. A missing
real binary reports an error and exits 127. Symlinks are canonicalized before
comparison; same-file aliases, identical generated copies (`cmp`), and binaries
inside another `pi-command-policy` or legacy `pi-shims` package's `bin/` are
skipped. This handles old and new installations coexisting during migration
without shims executing each other.

Regenerate for the installed tools with:

```sh
./scripts/generate-search-shims.sh
```

Each name is one `generate` line at the bottom of the generator; `ag` and `ack`
are already listed and are emitted only when installed. Generated scripts are
standalone; edit the generator and regenerate rather than editing each copy.

## ssh — remind and run one-shot commands

**Trigger:** after stripping SSH options and their operands, at least two
positional arguments remain: a host plus a remote command. Host-only session
forms are silent. Separate, attached, and clustered short options are supported,
including `-p 22`, `-p22`, `-vp 22`, and `-oBatchMode=yes`; `--` ends option parsing.
Unknown short flags are treated as operand-less.

**Action:** print one stderr line explaining that one-shot SSH pays full
connection setup and loses shell state; for repeated remote work, drive one
persistent SSH session inside tmux (see the tmux skill). **Always run SSH**,
including one-shots that bootstrap persistent sessions. Original arguments,
stdin, stdout, and exit status are preserved.

**Bypass:** `/usr/bin/ssh` skips the reminder. `PI_COMMAND_POLICY_CONFIRM` affects
refusing shims, so it does not suppress this non-blocking reminder. The real
command normally is `/usr/bin/ssh`; `PI_COMMAND_POLICY_SSH_REAL=/absolute/path/to/ssh`
(legacy `PI_SHIMS_SSH_REAL`) overrides it for testing or an alternate executable. Tests use a fake binary and never
connect to a remote host.

## Coverage boundary

The direct-input syntax policies (sleep and no-op) see **only Bash tool input**,
before execution. User `!`/`!!` commands and Pi's non-Bash tools are not intercepted. Script bodies, runtime
expansions, and opaque strings are outside that check. It is independent of
PATH, so direct-input sleep guidance applies even when another Bash backend
routes execution remotely; no remote files are inspected.

rm/search/ssh shims intercept only commands resolved through **PATH**, including
child scripts, Makefiles, and subshells that inherit it. Explicit absolute paths
bypass these shims; other binaries and APIs (`unlink`, `find -delete`,
`shutil.rmtree`, and Pi's non-Bash tools) are not intercepted. These are
working-style nudges; the agent retains normal filesystem access.

The injected directory is **local-machine only**. It does not exist on a remote
host: when ShellGate routes Bash over SSH, the PATH shims are inactive there.

## Migration from pi-shims / pi-rm-guard

The package is now `pi-command-policy`; `/command-policy` replaces `/shims`
without an alias. `RM_GUARD_CONFIRM=1` remains. The search timeout and SSH
executable overrides also retain their legacy `PI_SHIMS_*` names; the new names
take precedence when set. Confirmation is the exception: the legacy confirmation
name is refused, because it named no policy (see below).

### v0.5.0 — confirmation names one policy

This is a breaking change for callers, not for the API. `PI_COMMAND_POLICY_CONFIRM=1`
and `PI_SHIMS_CONFIRM` no longer confirm anything; both are refused in direct
input and reported as a migration error by `bin/rm`. Replace them by policy:

| was | becomes |
|---|---|
| `PI_COMMAND_POLICY_CONFIRM=1 rm -rf build` | `PI_COMMAND_POLICY_CONFIRM=rm rm -rf build` |
| `PI_COMMAND_POLICY_CONFIRM=1 grep ...` | `PI_COMMAND_POLICY_CONFIRM=search grep ...` |
| `PI_COMMAND_POLICY_CONFIRM=1 sleep 900` | `PI_COMMAND_POLICY_CONFIRM=sleep sleep 900` |
| `PI_SHIMS_CONFIRM=1` wrapping a cleanup script | `PI_COMMAND_POLICY_CONFIRM=rm` wrapping it, or `/bin/rm` |

`RM_GUARD_CONFIRM=1` still confirms rm alone and needs no change. Child-script
coverage now requires the policy-named value: `PI_COMMAND_POLICY_CONFIRM=rm bash
./cleanup.sh` is inherited by the `rm` calls inside the script, and the same holds
for `=search`. A sleep confirmation is never inherited, because the extension
reads only the source of the call that carries it.

### v0.6.0 — no bounds

`sleep:<bound>` is gone. Nothing checked the number, so a bound stated to clear a
message was indistinguishable from one that described a real wait, and it cost
three refusal variants to police. `PI_COMMAND_POLICY_CONFIRM=sleep` confirms the
wait on its own command, and the wording of the refusal carries the decision
instead: do not escape unless the next action depends on the result and the work
cannot be backgrounded. Earlier `sleep:<bound>` values are now refused as unknown
text; replace them with `sleep`.

The extension also stops reading `export` lines. It parses prefixes only, matching
what it has always documented about not emulating shell state; the shims still
read their value from the environment, so `export PI_COMMAND_POLICY_CONFIRM=rm`
keeps working for child scripts, and an exported blanket value still refuses at
the shim.

Exported values no longer confirm the sleep policy: a long sleep under one is
refused. Remove any standing export from the shell or service that starts Pi; a
sleep confirmation belongs on the command that waits. Exported rm and search
values keep working where they always did — the shims read them from the
environment of the process that runs them.

Select the new repository source in Pi settings and install the desired published
tag. Start a new session or `/reload` to replace the old handler. The `bin/`
relative path is retained, and search resolution recognizes both package names
while old and new installs coexist.

An already-loaded old extension still points to its original `bin/` directory.
That checkout must also be updated to the new release (removing its old
`bin/sleep`) or old wrappers may continue imposing sleep refusal on child
scripts. Preserve local files and linked worktrees before changing an installed
checkout. Do not remove a checkout owning development worktrees. Verify the new
install and reload before retiring any retained paths. Existing release tags
remain unchanged.

## Development

Requires Node.js **22.18+** with TypeScript stripping, Pi's peer dependency, Bash,
`cmp` (diffutils), GNU coreutils (`timeout`, `realpath`, `sleep`, `rm`), `du`, and
the installed search tools (`grep`, `rg`, `find`, `fd`). Linux `/proc` is used to
observe real child timers in the integration test.

```sh
npm install
npm test
```

The suite covers direct-input syntax, quotations/comments/heredocs, dynamic and
opaque code, the confirmation vocabulary and ignored notify markers. It loads
the extension through Pi's jiti loader and event runner, then executes allowed
commands through the real built-in Bash tool. A child script's `sleep 30` is
observed as a live system timer under inherited PATH **without** any exemption,
then cancelled; rm/search/ssh remain active in those children.

Existing shell regressions cover expanded deletion targets, policy-named and
legacy confirmation values, real grep/rg FIFO timeouts and retained partial
output, pipe filters, find/fd deadlines, generator reproducibility, all six
search names coexisting across legacy/renamed copies, and SSH argv/status/stdin
behavior. Timed tests use short overrides; the production 60s default is checked
separately. No remote connection or live notification broker is used.
