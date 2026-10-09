# pi-rm-guard

`pi-rm-guard` is a Pi package that makes an agent confirm `rm` deletions after
shell expansion. It targets accidents such as a misset variable in a script:
when `rm -rf $TARGET` executes, the shim receives the expanded target and
reports that real path before anything is removed.

## Install

```sh
pi install git:github.com/yiwenlu66/pi-rm-guard@v0.1.0
```

Start a new Pi session after installation. Run `/rm-guard` to display the shim
directory and confirm that the extension is active.

## Mechanism

```text
Pi bash tool
    │ spawnHook prepends <package>/bin to PATH
    ▼
rm in a command, script, Makefile, or subshell
    ▼
<package>/bin/rm
    │ reports post-expansion absolute targets and exits 77
    ▼
agent reviews report and chooses an explicit confirmation route
```

The shim never reads stdin: Pi runs bash non-interactively, so an interactive
prompt would hang rather than create a confirmation loop.

For directory targets, the report includes an entry count (capped at 10,000)
and an approximate `du -sh` size. A symlink is reported as the link itself,
not its referent.

## Confirming an intended deletion

A blocked command makes no filesystem change. Re-issue an intentional direct
command with either route shown in the report:

```sh
/bin/rm -rf ./build             # direct, deliberate bypass
RM_GUARD_CONFIRM=1 rm -rf ./build  # also reaches rm invoked inside scripts
```

`RM_GUARD_CONFIRM=1` is inherited by child processes, which lets an agent
confirm an `rm` buried in a script without editing that script. `/bin/rm` is
the deliberate direct-bypass channel.

## Coverage boundary

This package intercepts commands that resolve `rm` through `PATH`, including
scripts, Makefiles, and subshells launched from Pi's bash tool. It does **not**
intercept deletion APIs such as `unlink`, `find -delete`, or
`shutil.rmtree`; explicit `/bin/rm` bypasses it by design. This is a guard
against accidental deletion, not a security boundary against adversarial code.
The agent retains normal filesystem access.

## Development

```sh
./tests/run.sh
```

The test suite covers normal and nested deletion attempts, direct and
environment-confirmed bypasses, empty `rm -f`, symlinks, and unusual filenames.
