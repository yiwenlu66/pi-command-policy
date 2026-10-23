# pi-shims

PATH-level shims that shape how Pi agents work. Each command has its own Bash
script in `bin/`; the extension prepends that directory to every Pi bash tool
call. Refusing interventions print to stderr and exit **77**. Shim logic never
reads stdin or prompts interactively; delegated commands retain their normal I/O.

## Install

```sh
pi install git:github.com/yiwenlu66/pi-shims@v0.2.0
```

Start a new Pi session after installation. `/shims` reports the shim directory
and lists the files currently present in `bin/`.

## Mechanism

```text
Pi bash tool call
    │ shims tool_call handler prepends: export PATH="<package>/bin:$PATH"
    ▼
active local bash implementation (built-in, ShellGate, or another extension)
    ▼
command in a script, Makefile, subshell, or direct invocation
    ▼
<package>/bin/<command> receives shell-expanded argv
    ├─ normal case / explicit bypass → exec real binary
    └─ intervention → stderr guidance and exit 77
```

The extension mutates bash tool-call input instead of registering a bash tool,
so it composes with extensions that own bash. Injection is idempotent: commands
already containing the shim directory are left unchanged.

`PI_SHIMS_CONFIRM=1` is the global bypass for all refusing shims. Export it or
prefix a script invocation to also cover child processes:

```sh
PI_SHIMS_CONFIRM=1 bash ./intentional-operation.sh
```

## rm — confirm expanded deletion targets

**Trigger:** `rm` with at least one target, including inside scripts.

**Action:** refuse before deletion and report post-expansion absolute paths,
target type, directory entry counts (capped at 10,000), and approximate `du -sh`
size. Symlinks are reported as links, not their referents. `rm -f` without targets
retains its successful no-op behavior.

**Bypass:** `/bin/rm`, `PI_SHIMS_CONFIRM=1`, or the legacy `RM_GUARD_CONFIRM=1`.
The legacy variable confirms only rm, while the global variable covers every
refusing shim.

```sh
/bin/rm -rf ./build
PI_SHIMS_CONFIRM=1 rm -rf ./build
RM_GUARD_CONFIRM=1 bash ./cleanup.sh
```

## Coverage boundary

Only commands resolved through **PATH** are intercepted, including child scripts,
Makefiles, and subshells that inherit it. Explicit absolute paths bypass shims;
other binaries and APIs (such as `unlink`, `find -delete`, `shutil.rmtree`, and
Pi's non-bash tools) are not intercepted. These are working-style nudges, not
an access-control boundary; the agent retains normal filesystem access.

The injected directory is **local-machine only**. It does not exist on a remote
host: when ShellGate routes bash over SSH, these shims are inactive there.

## Migration from pi-rm-guard

The package and slash command have a clean rename; there is no `/rm-guard` alias.
Uninstall the old source and install the new pinned release:

```sh
pi remove git:github.com/yiwenlu66/pi-rm-guard@v0.1.1
pi install git:github.com/yiwenlu66/pi-shims@v0.2.0
```

Use the exact old source shown by `pi list` if its ref differs. Start a new Pi
session and use `/shims`. Existing `RM_GUARD_CONFIRM=1` cleanup scripts continue
to work. For a live migration, verify the new install before deleting an old
working clone.

## Development

Requires Bash, GNU coreutils (`timeout`, `realpath`, `sleep`, `rm`), `du`, and
Node.js with TypeScript stripping (22.18+), plus Pi's peer dependency installed.

```sh
./tests/run.sh
```
