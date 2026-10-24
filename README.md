# pi-command-policy

Command policies that shape how Pi agents work. The extension parses shell code
supplied directly to the Bash tool to discourage long waits. Separate Bash
scripts in `bin/` confirm deletion targets, bound searches, and remind about SSH
session reuse, including inside invoked child scripts.

## Install

```sh
pi install git:github.com/yiwenlu66/pi-command-policy
```

Use a published tag for a pinned install. Start a new session or `/reload` after
installation or upgrade: the sleep policy lives in the extension handler.
`/command-policy` reports the direct-input sleep policy and active `bin/` files.

## Mechanism

```text
Pi bash tool input
    │ command-policy tool_call handler parses the supplied Bash source
    ├─ literal sleep totaling >=10s → block tool call with workflow guidance
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
so it composes with extensions that own execution. Sleep is checked **before**
the existing PATH-injection idempotency check; mentioning the shim directory
never skips the sleep policy. PATH injection leaves commands already containing
the shim directory unchanged, retaining the previous injection behavior.

`PI_COMMAND_POLICY_CONFIRM=1` confirms all refusing policies. The legacy
`PI_SHIMS_CONFIRM=1` is also accepted, so existing cleanup scripts keep working.
Export either variable before starting Pi to confirm the direct-input sleep
policy globally, or use a per-command assignment. For the PATH shims, exporting
it or prefixing a script invocation also covers descendants:

```sh
PI_COMMAND_POLICY_CONFIRM=1 bash ./intentional-operation.sh
```

Shim logic never reads stdin or prompts interactively; delegated commands retain
their normal I/O. Sleep uses Pi's blocking event result rather than a shell exit
code; refusing PATH shims still exit **77**.

## rm — confirm expanded deletion targets

**Trigger:** `rm` with at least one target, including inside scripts.

**Action:** refuse before deletion and report post-expansion absolute paths,
target type, directory entry counts (capped at 10,000), and approximate `du -sh`
size. Symlinks are reported as links, not their referents. `rm -f` without targets
retains its successful no-op behavior.

**Bypass:** `/bin/rm`, `PI_COMMAND_POLICY_CONFIRM=1`, legacy `PI_SHIMS_CONFIRM=1`,
or rm-only `RM_GUARD_CONFIRM=1`. The global confirmation variables cover every
refusing shim.

```sh
/bin/rm -rf ./build
PI_COMMAND_POLICY_CONFIRM=1 rm -rf ./build
RM_GUARD_CONFIRM=1 bash ./cleanup.sh
```

## sleep — guide direct Bash waits

**Trigger:** a command named `sleep` in shell source supplied directly to Pi's
Bash tool, with statically known operands totaling at least **10 seconds**.
Decimal values and GNU suffixes `s`, `m`, `h`, and `d` are supported; `sleep 6 4`
is ten seconds. GNU's `--` option terminator is recognized (`sleep -- 900`).
Ordinary quoting and backslash escapes are decoded by the parser.

The parser sees command structure, so `make && sleep 900`, pipelines, groups,
subshells, loops such as `while sleep 30; do ...; done`, and function bodies in
the supplied source are checked. Command/process substitutions are executable
source and are checked too. Plain quoted text (`echo 'sleep 900'`), comments, and
heredoc contents never trigger, including expansions inside heredocs. This is a
syntactic check, not control-flow analysis: even an unreachable command or an
uncalled function body containing a known long sleep can block the whole call.
Direct background `sleep 30 &` is also checked; use a worker script for timers.

**Action:** block the entire tool call before execution with guidance to run
long work in the background, arrange a watcher/completion notification, and keep
advancing the task.

**Child scripts run normally.** There is **no `bin/sleep`**. `bash ./worker.sh`,
`./worker.sh`, sourced files, Makefile recipes, and other invoked programs resolve
sleep to the real timer, even when they inherit the policy's `bin/` PATH. Files
are never read or recursively inspected. `bash -c 'sleep 900'`, `eval`, SSH remote
command strings, and other opaque program arguments are not parsed as shell code.
`PI_NOTIFY_BACKGROUND` is neither required nor honored by this package.

**Deliberate waits:** `/bin/sleep 900`, `PI_COMMAND_POLICY_CONFIRM=1 sleep 900`,
or legacy `PI_SHIMS_CONFIRM=1 sleep 900`. Inherited Pi-process confirmation is
also honored. The parser recognizes per-command confirmation assignments only;
it does not emulate shell state from earlier `export`, assignment, alias, or
function commands. Wrappers such as `env sleep 900` or `command sleep 900` are
outside the named-command check.

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

## grep, rg, find, fd — bound filesystem searches

**Trigger:** a search runs longer than **60 seconds**. These shims run the real
binary under GNU `timeout 60s`. `grep`, `rg`, and generated `ag`/`ack` shims
**exempt pipe stdin**: `tail -f log | grep pattern` is a deliberate unbounded
streaming filter. The shim only checks `[ -p /dev/stdin ]`, without consuming it.
`find` and `fd` have no stdin mode and are always timed.

**Action:** timeout status 124 becomes exit 77. Partial output remains on stdout;
the stderr report says the run was killed and its output is incomplete. Narrow
the path, use `--include`/`--glob` or `-maxdepth`/`--max-depth` as appropriate,
exclude `.git`/`node_modules`, and prefer `rg`/`fd` over `grep -R`/`find`.
Normal exit codes and output are preserved.

**Bypass:** `PI_COMMAND_POLICY_CONFIRM=1` or the real binary's absolute path,
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

The sleep policy sees **only Bash tool input**, before execution. User `!`/`!!`
commands and Pi's non-Bash tools are not intercepted. Script bodies, runtime
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
without an alias. Both confirmation names are supported, along with rm-only
`RM_GUARD_CONFIRM=1`. The search timeout and SSH executable overrides also retain
their legacy `PI_SHIMS_*` names; the new names take precedence when set.

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
opaque code, confirmation compatibility and ignored notify markers. It loads
the extension through Pi's jiti loader and event runner, then executes allowed
commands through the real built-in Bash tool. A child script's `sleep 30` is
observed as a live system timer under inherited PATH **without** any exemption,
then cancelled; rm/search/ssh remain active in those children.

Existing shell regressions cover expanded deletion targets, inherited
confirmations, real grep/rg FIFO timeouts and retained partial output, pipe
filters, find/fd deadlines, generator reproducibility, all six search names
coexisting across legacy/renamed copies, and SSH argv/status/stdin behavior.
Timed tests use short overrides; the production 60s default is checked
separately. No remote connection or live notification broker is used.
