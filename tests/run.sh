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

printf '1..27\n'

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

# Global confirmation also reaches rm inside scripts.
global_dir="$WORK/global-confirmed"
mkdir -p -- "$global_dir"
printf 'rm -rf %q\n' "$global_dir" >"$WORK/global-confirm.sh"
run_guarded "$WORK/global.err" env PI_SHIMS_CONFIRM=1 bash "$WORK/global-confirm.sh"
assert_equals "$guard_status" 0 'global bypass allows nested rm'
assert_missing "$global_dir" 'global bypass deletes through child shim'
[[ ! -s $WORK/global.err ]] || fail 'global rm bypass is silent'
pass 'PI_SHIMS_CONFIRM=1 confirms nested rm'

node "$ROOT/tests/extension.mjs"
pass 'extension prepends PATH and exposes only /shims with active files'

run_guarded "$WORK/sleep-short.err" sleep .001s .00001m .0000001h .00000001d
assert_equals "$guard_status" 0 'small decimal durations with all suffixes pass'
[[ ! -s $WORK/sleep-short.err ]] || fail 'short sleep is silent'
pass 'sleep sums small decimal and suffixed operands silently'

for duration in 10 10s .2m .003h .0002d +10.0s; do
	run_guarded "$WORK/sleep-long.err" sleep "$duration"
	assert_equals "$guard_status" 77 "sleep $duration is refused"
done
assert_contains "$WORK/sleep-long.err" 'background' 'long sleep suggests background work'
assert_contains "$WORK/sleep-long.err" 'pi-notify' 'long sleep mentions completion notification'
pass 'sleep refuses the threshold and all GNU unit suffixes'

run_guarded "$WORK/sleep-sum.err" sleep 9.99s .01s
assert_equals "$guard_status" 77 'decimal operands sum to the threshold'
run_guarded "$WORK/sleep-sum.err" sleep 0.1m 4s
assert_equals "$guard_status" 77 'mixed suffix operands sum to the threshold'
small_operands=()
for ((i = 0; i < 100; i++)); do small_operands+=(.1); done
run_guarded "$WORK/sleep-sum.err" sleep "${small_operands[@]}"
assert_equals "$guard_status" 77 'many decimal operands sum to the threshold'
pass 'sleep sums multiple operands, including decimal rounding cases'

run_guarded "$WORK/sleep-invalid.err" sleep 10 invalid
assert_equals "$guard_status" 1 'an invalid operand delegates validation even after a long operand'
assert_contains "$WORK/sleep-invalid.err" 'invalid time interval' 'real sleep validates operands'
run_guarded "$WORK/sleep-version.err" sleep --version
assert_equals "$guard_status" 0 'unknown option passes through to real sleep'
assert_contains "$WORK/stdout" 'GNU coreutils' 'sleep passthrough preserves normal output'
pass 'unparseable sleep operands pass through unchanged'

run_guarded "$WORK/sleep-bypass.err" timeout .1s env PI_SHIMS_CONFIRM=1 sleep 10
assert_equals "$guard_status" 124 'global bypass actually waits until external timeout'
[[ ! -s $WORK/sleep-bypass.err ]] || fail 'sleep global bypass is silent'
pass 'PI_SHIMS_CONFIRM=1 bypasses long sleep refusal'

run_guarded "$WORK/sleep-direct.err" timeout .1s /bin/sleep 10
assert_equals "$guard_status" 124 'absolute sleep actually waits until external timeout'
[[ ! -s $WORK/sleep-direct.err ]] || fail 'absolute sleep is silent'
pass '/bin/sleep bypasses the shim'

printf 'stdin untouched\n' | run_guarded "$WORK/sleep-stdin.err" bash -c 'sleep 10; status=$?; cat; exit "$status"'
assert_contains "$WORK/stdout" 'stdin untouched' 'sleep refusal leaves stdin available to the caller'
pass 'sleep shim never consumes caller stdin'

# A named FIFO blocks the real grep/rg file scan without making stdin a pipe.
run_fifo_search() {
	local command=$1 confirmation=${2:-0}
	local fifo="$WORK/search.fifo"
	/bin/rm -f -- "$fifo"
	mkfifo -- "$fifo"
	(printf 'needle before timeout\n'; exec /bin/sleep .3) >"$fifo" &
	local writer=$!
	run_guarded "$WORK/search-timeout.err" env PI_SHIMS_SEARCH_TIMEOUT=.05s PI_SHIMS_CONFIRM="$confirmation" "$command" --line-buffered needle "$fifo" </dev/null
	kill "$writer" 2>/dev/null || true
	wait "$writer" 2>/dev/null || true
}

for search in grep rg; do
	run_fifo_search "$search"
	assert_equals "$guard_status" 77 "$search timeout becomes exit 77"
	assert_contains "$WORK/stdout" 'needle before timeout' "$search preserves partial output"
	assert_contains "$WORK/search-timeout.err" 'exceeded .05s and was killed' "$search reports the killed scan"
	assert_contains "$WORK/search-timeout.err" 'partial output' "$search marks output incomplete"
	assert_contains "$WORK/search-timeout.err" 'PI_SHIMS_CONFIRM=1' "$search explains the bypass"
	pass "$search times out a filesystem search and preserves partial output"
done

for search in grep rg; do
	run_guarded "$WORK/search-pipe.err" env PI_SHIMS_SEARCH_TIMEOUT=.01s bash -c '{ printf "needle first\n"; /bin/sleep .1; printf "needle last\n"; } | "$1" --line-buffered needle' _ "$search"
	assert_equals "$guard_status" 0 "$search streaming filter runs longer than the timeout"
	assert_contains "$WORK/stdout" 'needle first' "$search streams the first match"
	assert_contains "$WORK/stdout" 'needle last' "$search streams after the deadline"
	[[ ! -s $WORK/search-pipe.err ]] || fail "$search pipe exemption is silent"
	pass "$search exempts pipe stdin from timing"
done

search_dir="$WORK/search-tree"
mkdir -p -- "$search_dir"
printf 'needle\n' >"$search_dir/one.txt"
run_guarded "$WORK/find-timeout.err" env PI_SHIMS_SEARCH_TIMEOUT=.05s bash -c 'printf unused | find "$1" -print -exec /bin/sleep 1 \;' _ "$search_dir"
assert_equals "$guard_status" 77 'find is timed even with pipe stdin'
assert_contains "$WORK/stdout" "$search_dir" 'find retains partial paths'
assert_contains "$WORK/find-timeout.err" 'was killed' 'find timeout is reported'
pass 'find always times filesystem scans, including with pipe stdin'

run_guarded "$WORK/fd-timeout.err" env PI_SHIMS_SEARCH_TIMEOUT=.05s bash -c 'printf unused | fd . "$1" --exec bash -c "exec /bin/sleep 1"' _ "$search_dir"
assert_equals "$guard_status" 77 'fd is timed even with pipe stdin'
assert_contains "$WORK/fd-timeout.err" 'was killed' 'fd timeout is reported'
pass 'fd always times filesystem scans, including with pipe stdin'

for search in grep rg; do
	run_fifo_search "$search" 1
	assert_equals "$guard_status" 0 "global bypass lets slow $search complete"
	[[ ! -s $WORK/search-timeout.err ]] || fail "$search bypass is silent"
done
pass 'global confirmation runs slow searches untimed'

run_guarded "$WORK/search-direct.err" env PI_SHIMS_SEARCH_TIMEOUT=.001s /bin/grep needle "$search_dir/one.txt"
assert_equals "$guard_status" 0 'absolute grep bypass works'
for search in grep rg; do
	run_guarded "$WORK/search-normal.err" "$search" needle "$search_dir/one.txt" </dev/null
	assert_equals "$guard_status" 0 "$search normal match succeeds"
	assert_contains "$WORK/stdout" needle "$search preserves ordinary output"
	[[ ! -s $WORK/search-normal.err ]] || fail "$search ordinary match is silent"
	run_guarded "$WORK/search-no-match.err" "$search" absent "$search_dir/one.txt" </dev/null
	assert_equals "$guard_status" 1 "$search no-match status is preserved"
	run_guarded "$WORK/search-error.err" "$search" needle "$WORK/nonexistent" </dev/null
	assert_equals "$guard_status" 2 "$search real errors are preserved"
done
pass 'searches preserve normal output, match/no-match/errors, and absolute bypass'

# fd is user-local on this machine; exercise PATH fallback and same-file aliases.
if [[ ! -x /usr/bin/fd ]]; then
	ln -s -- "$ROOT/bin" "$WORK/shim-alias"
	run_guarded "$WORK/fd-resolve.err" env PATH="$ROOT/bin:$WORK/shim-alias:$PATH" fd --version </dev/null
	assert_equals "$guard_status" 0 'fd resolves past both shim directory spellings'
	assert_contains "$WORK/stdout" 'fd ' 'resolved fd is the real executable'
	run_guarded "$WORK/fd-missing.err" env PATH="$ROOT/bin:/usr/bin:/bin" fd --version </dev/null
	assert_equals "$guard_status" 127 'a missing real fd fails without recursion'
	assert_contains "$WORK/fd-missing.err" 'not found outside the shim directory' 'missing tool is explicit'
fi
pass 'user-local fd lookup skips shim aliases and reports a missing binary'

mkdir -p -- "$WORK/generator/scripts" "$WORK/generator/bin"
cp -- "$ROOT/scripts/generate-search-shims.sh" "$WORK/generator/scripts/"
"$WORK/generator/scripts/generate-search-shims.sh" >"$WORK/generator.out"
for search in grep rg find fd; do
	cmp -- "$ROOT/bin/$search" "$WORK/generator/bin/$search" || fail "$search generation is reproducible"
done
for search in ag ack; do
	if ! type -P "$search" >/dev/null; then
		[[ ! -e $WORK/generator/bin/$search ]] || fail "uninstalled $search should not get a shim"
	fi
done
pass 'search generator is reproducible and skips uninstalled tools'

printf '# %d tests passed\n' "$pass_count"
