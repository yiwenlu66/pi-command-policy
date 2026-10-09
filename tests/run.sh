#!/usr/bin/env bash
set -euo pipefail

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd -P)
GUARD_PATH="$ROOT/bin:$PATH"
WORK="$ROOT/.test-tmp"

/bin/rm -rf -- "$WORK"
mkdir -p -- "$WORK"
trap '/bin/rm -rf -- "$WORK"' EXIT

pass_count=0

pass() {
	printf 'ok %d - %s\n' "$((++pass_count))" "$1"
}

fail() {
	printf 'not ok - %s\n' "$1" >&2
	exit 1
}

assert_exists() {
	[[ -e $1 || -L $1 ]] || fail "$2"
}

assert_missing() {
	[[ ! -e $1 && ! -L $1 ]] || fail "$2"
}

assert_equals() {
	[[ $1 == "$2" ]] || fail "$3 (expected $2, got $1)"
}

assert_contains() {
	grep -F -- "$2" "$1" >/dev/null || fail "$3 (missing: $2)"
}

run_guarded() {
	local stderr_file=$1
	shift
	set +e
	PATH="$GUARD_PATH" "$@" >"$WORK/stdout" 2>"$stderr_file"
	guard_status=$?
	set -e
}

printf '1..8\n'

# 1. A normal recursive deletion is blocked and describes the absolute directory.
protected_dir="$WORK/protected dir"
mkdir -p -- "$protected_dir/nested"
printf payload >"$protected_dir/nested/file"
run_guarded "$WORK/blocked.err" rm -rf -- "$protected_dir"
assert_equals "$guard_status" 77 'rm -rf is blocked with exit 77'
assert_exists "$protected_dir" 'blocked directory remains intact'
assert_contains "$WORK/blocked.err" "$protected_dir" 'report includes resolved absolute directory path'
assert_contains "$WORK/blocked.err" '[dir' 'report identifies a directory'
pass 'PATH rm -rf is blocked and leaves directory intact'

# 2. The shim observes shell-expanded argv inside a child script.
important="$WORK/important"
mkdir -p -- "$important"
printf crucial >"$important/data"
script="$WORK/misset-target.sh"
printf 'TARGET=%q\nrm -rf $TARGET\n' "$important" >"$script"
run_guarded "$WORK/script.err" bash "$script"
assert_equals "$guard_status" 77 'misset-variable script is blocked with exit 77'
assert_exists "$important" 'misset-variable target remains intact'
assert_contains "$WORK/script.err" "$important" 'script report includes expanded absolute target'
pass 'script expansion is intercepted after variable resolution'

# 3. A deliberate direct invocation bypasses the shim.
direct_dir="$WORK/direct"
mkdir -p -- "$direct_dir"
/bin/rm -rf -- "$direct_dir"
assert_missing "$direct_dir" '/bin/rm deletes directly'
pass '/bin/rm direct bypass deletes'

# 4. Explicit agent confirmation allows a one-shot rm invocation.
confirmed_dir="$WORK/confirmed"
mkdir -p -- "$confirmed_dir"
RM_GUARD_CONFIRM=1 PATH="$GUARD_PATH" rm -rf -- "$confirmed_dir"
assert_missing "$confirmed_dir" 'RM_GUARD_CONFIRM=1 deletes through shim'
pass 'RM_GUARD_CONFIRM=1 confirms direct rm'

# 5. The same confirmation reaches rm invoked by a script.
nested_dir="$WORK/nested-confirmed"
mkdir -p -- "$nested_dir"
nested_script="$WORK/nested-confirm.sh"
printf 'rm -rf %q\n' "$nested_dir" >"$nested_script"
RM_GUARD_CONFIRM=1 PATH="$GUARD_PATH" bash "$nested_script"
assert_missing "$nested_dir" 'confirmed nested script deletes through shim'
pass 'RM_GUARD_CONFIRM=1 confirms nested rm'

# 6. rm -f with no operands keeps coreutils no-op semantics.
run_guarded "$WORK/no-operands.err" rm -f
assert_equals "$guard_status" 0 'rm -f without operands succeeds'
pass 'rm -f without operands remains a no-op'

# 7. A symlink report names the link, not its referent.
link_target="$WORK/link-target"
link_path="$WORK/link-path"
printf target >"$link_target"
ln -s -- "$link_target" "$link_path"
run_guarded "$WORK/symlink.err" rm -- "$link_path"
assert_equals "$guard_status" 77 'symlink removal is blocked'
assert_exists "$link_path" 'blocked symlink remains intact'
assert_contains "$WORK/symlink.err" "$link_path [symlink]" 'report names symlink path itself'
pass 'symlink report preserves final link component'

# 8. Options, --, spaces, and a leading-dash filename remain unambiguous.
weird_dir="$WORK/weird names"
mkdir -p -- "$weird_dir"
leading_name='-leading-dash'
printf odd >"$weird_dir/$leading_name"
set +e
(
	cd -- "$weird_dir"
	PATH="$GUARD_PATH" rm -v -- "$leading_name"
) >"$WORK/weird.out" 2>"$WORK/weird.err"
guard_status=$?
set -e
assert_equals "$guard_status" 77 'rm -v -- leading-dash operand is blocked'
assert_exists "$weird_dir/$leading_name" 'weird filename remains intact'
assert_contains "$WORK/weird.err" "$weird_dir/$leading_name" 'report resolves spaced directory and leading-dash filename'
pass 'options and weird filenames are handled without mutation'

printf '# %d tests passed\n' "$pass_count"
