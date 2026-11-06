#!/usr/bin/env bash
set -euo pipefail

# Exercise defaults regardless of bypass/override variables in the caller.
unset PI_COMMAND_POLICY_CONFIRM PI_COMMAND_POLICY_SEARCH_TIMEOUT PI_COMMAND_POLICY_SSH_REAL
unset PI_SHIMS_CONFIRM RM_GUARD_CONFIRM PI_SHIMS_SEARCH_TIMEOUT PI_SHIMS_SSH_REAL PI_NOTIFY_BACKGROUND

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

printf '1..34\n'

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

# A value that names this policy confirms it, directly and through a script.
named_dir="$WORK/named-confirmed"
mkdir -p -- "$named_dir"
PI_COMMAND_POLICY_CONFIRM=rm PATH="$GUARD_PATH" rm -rf -- "$named_dir"
assert_missing "$named_dir" 'PI_COMMAND_POLICY_CONFIRM=rm deletes through shim'
named_script_dir="$WORK/named-nested-confirmed"
mkdir -p -- "$named_script_dir"
printf 'rm -rf %q\n' "$named_script_dir" >"$WORK/named-confirm.sh"
run_guarded "$WORK/named.err" env PI_COMMAND_POLICY_CONFIRM=rm bash "$WORK/named-confirm.sh"
assert_equals "$guard_status" 0 'policy-named confirmation reaches nested rm'
assert_missing "$named_script_dir" 'policy-named confirmation deletes through child shim'
[[ ! -s $WORK/named.err ]] || fail 'policy-named rm confirmation is silent'
pass 'PI_COMMAND_POLICY_CONFIRM=rm confirms rm directly and in child scripts'

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

# The legacy blanket name and the old blanket value no longer confirm anything:
# the report says so instead of presenting a recipe that no longer works.
legacy_dir="$WORK/legacy-confirmed"
mkdir -p -- "$legacy_dir"
run_guarded "$WORK/legacy.err" env PI_SHIMS_CONFIRM=1 rm -rf -- "$legacy_dir"
assert_equals "$guard_status" 77 'PI_SHIMS_CONFIRM=1 no longer confirms rm'
assert_exists "$legacy_dir" 'legacy blanket leaves the target intact'
assert_contains "$WORK/legacy.err" 'PI_COMMAND_POLICY_CONFIRM=1 / PI_SHIMS_CONFIRM no longer confirm anything: name the policy (PI_COMMAND_POLICY_CONFIRM=rm) or use /bin/rm' 'legacy name reports the migration line'
# The legacy name counts as present even when empty: it is still the old habit.
run_guarded "$WORK/legacy-empty.err" env PI_SHIMS_CONFIRM= rm -rf -- "$legacy_dir"
assert_equals "$guard_status" 77 'an empty PI_SHIMS_CONFIRM still confirms nothing'
assert_contains "$WORK/legacy-empty.err" 'no longer confirm anything' 'empty legacy name reports the migration line'
blanket_dir="$WORK/blanket-refused"
mkdir -p -- "$blanket_dir"
run_guarded "$WORK/blanket.err" env PI_COMMAND_POLICY_CONFIRM=1 rm -rf -- "$blanket_dir"
assert_equals "$guard_status" 77 'PI_COMMAND_POLICY_CONFIRM=1 no longer confirms rm'
assert_exists "$blanket_dir" 'blanket value leaves the target intact'
assert_contains "$WORK/blanket.err" 'no longer confirm anything' 'blanket value reports the migration line'
pass 'the blanket value and the legacy name are refused with the migration line'

# A confirmation for another policy does not confirm rm, and says how to.
search_named_dir="$WORK/search-named"
mkdir -p -- "$search_named_dir"
for confirmation in search sleep:30 rm-only-nonsense; do
	run_guarded "$WORK/cross.err" env PI_COMMAND_POLICY_CONFIRM="$confirmation" rm -rf -- "$search_named_dir"
	assert_equals "$guard_status" 77 "PI_COMMAND_POLICY_CONFIRM=$confirmation does not confirm rm"
	assert_exists "$search_named_dir" "$confirmation leaves the rm target intact"
done
assert_contains "$WORK/cross.err" 'Check the targets above before confirming. To confirm: /bin/rm (direct), PI_COMMAND_POLICY_CONFIRM=rm when a script must delete (covers child scripts), or RM_GUARD_CONFIRM=1 (rm only)' 'rm report names the current values'
# The migration line replaces, never accompanies, the normal recipe.
if grep -F 'Check the targets above before confirming.' "$WORK/legacy.err" >/dev/null; then fail 'legacy report must not also print the normal recipe'; fi
if grep -F 'Check the targets above before confirming.' "$WORK/blanket.err" >/dev/null; then fail 'blanket report must not also print the normal recipe'; fi
pass 'cross-policy values do not confirm rm and get the current recipe'

node "$ROOT/tests/extension.mjs"
pass 'real Pi extension boundary, parsed sleep policy, unrestricted child timers, and inherited guards'

# A named FIFO blocks the real grep/rg file scan without making stdin a pipe.
run_fifo_search() {
	local command=$1 confirmation=${2-}
	local fifo="$WORK/search.fifo"
	/bin/rm -f -- "$fifo"
	mkfifo -- "$fifo"
	(printf 'needle before timeout\n'; exec /bin/sleep .3) >"$fifo" &
	local writer=$!
	run_guarded "$WORK/search-timeout.err" env PI_SHIMS_SEARCH_TIMEOUT=.05s PI_COMMAND_POLICY_CONFIRM="$confirmation" "$command" --line-buffered needle "$fifo" </dev/null
	kill "$writer" 2>/dev/null || true
	wait "$writer" 2>/dev/null || true
}

for search in grep rg; do
	run_fifo_search "$search"
	assert_equals "$guard_status" 77 "$search timeout becomes exit 77"
	assert_contains "$WORK/stdout" 'needle before timeout' "$search preserves partial output"
	assert_contains "$WORK/search-timeout.err" 'exceeded .05s and was killed' "$search reports the killed scan"
	assert_contains "$WORK/search-timeout.err" 'partial output' "$search marks output incomplete"
	assert_contains "$WORK/search-timeout.err" 'To run untimed: PI_COMMAND_POLICY_CONFIRM=search, or the real binary: ' "$search explains the bypass"
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
	run_fifo_search "$search" search
	assert_equals "$guard_status" 0 "policy-named confirmation lets slow $search complete"
	[[ ! -s $WORK/search-timeout.err ]] || fail "$search bypass is silent"
done
pass 'PI_COMMAND_POLICY_CONFIRM=search runs slow searches untimed'

# Any other confirmation leaves the search timed, including the old blanket.
for confirmation in rm sleep:30 1; do
	for search in grep rg; do
		run_fifo_search "$search" "$confirmation"
		assert_equals "$guard_status" 77 "$search stays timed under PI_COMMAND_POLICY_CONFIRM=$confirmation"
	done
done
pass 'rm, sleep and blanket confirmations do not lift the search timeout'

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

fake_ssh="$WORK/fake-ssh"
cat >"$fake_ssh" <<'SSH'
#!/usr/bin/env bash
printf '%s\0' "$@" >"$FAKE_SSH_LOG"
printf 'fake ssh ran\n'
if [[ ${FAKE_SSH_READ:-} == 1 ]]; then cat; fi
exit 23
SSH
chmod +x "$fake_ssh"

check_ssh() {
	local expected=$1
	shift
	run_guarded "$WORK/ssh.err" env PI_SHIMS_SSH_REAL="$fake_ssh" FAKE_SSH_LOG="$WORK/ssh.argv" ssh "$@"
	assert_equals "$guard_status" 23 'ssh preserves the real command status'
	printf '%s\0' "$@" >"$WORK/ssh.expected"
	cmp -- "$WORK/ssh.expected" "$WORK/ssh.argv" || fail 'ssh forwards argv unchanged'
	assert_contains "$WORK/stdout" 'fake ssh ran' 'ssh always runs the real command'
	if [[ $expected == reminder ]]; then
		assert_contains "$WORK/ssh.err" 'one-shot ssh' 'one-shot form prints a reminder'
		assert_contains "$WORK/ssh.err" 'persistent SSH session inside tmux' 'reminder points to a persistent tmux session'
		assert_equals "$(wc -l <"$WORK/ssh.err")" 1 'ssh reminder is one line'
	else
		[[ ! -s $WORK/ssh.err ]] || fail 'session/options form must be silent'
	fi
}

check_ssh reminder remote-host 'printf "%s\n" "space in arg"'
check_ssh reminder remote-host printf '%s\n' 'space in arg'
pass 'ssh reminds on one-shots, runs anyway, and preserves argv/status/output'

check_ssh silent remote-host
check_ssh silent -q -t -N -vvv -Z remote-host
check_ssh silent -V
check_ssh silent
pass 'ssh host-only sessions and operand-less flags are silent'

for option in l p i F o J L R D W b c m O B E e S w Q P; do
	check_ssh silent "-$option" 'value with spaces' remote-host
	check_ssh reminder "-$option" 'value with spaces' remote-host uptime
done
pass 'ssh skips all supported option operands in session and one-shot forms'

check_ssh silent -vvvp2222 -oBatchMode=yes -i/path/key remote-host
check_ssh silent -vp 2222 -o BatchMode=yes remote-host
check_ssh silent remote-host -p 2222
check_ssh reminder -vvvp2222 -oBatchMode=yes remote-host uptime
check_ssh reminder remote-host -p 2222 uptime
pass 'ssh handles attached/clustered values and options after the host'

check_ssh silent -- remote-host
check_ssh reminder -- remote-host -command
check_ssh reminder -o BatchMode=yes -- remote-host uptime
pass 'ssh honors the option terminator without changing delegated arguments'

printf 'ssh stdin untouched\n' | run_guarded "$WORK/ssh-stdin.err" env PI_SHIMS_SSH_REAL="$fake_ssh" FAKE_SSH_LOG="$WORK/ssh.argv" FAKE_SSH_READ=1 ssh remote-host uptime
assert_contains "$WORK/stdout" 'ssh stdin untouched' 'ssh shim leaves stdin for the real command'
pass 'ssh reminder never consumes stdin'

run_guarded "$WORK/ssh-real.err" ssh -V
assert_equals "$guard_status" 0 'default ssh executable runs without a connection'
assert_contains "$WORK/ssh-real.err" 'OpenSSH' 'default ssh resolves the real system binary'
if grep -F pi-command-policy "$WORK/ssh-real.err" >/dev/null; then fail 'ssh -V must not get a reminder'; fi
pass 'default ssh path delegates silently to the real binary'

notify_dir="$WORK/notify-marker-rm"
mkdir -p -- "$notify_dir"
run_guarded "$WORK/notify-rm.err" env PI_NOTIFY_BACKGROUND=1 rm -rf -- "$notify_dir"
assert_equals "$guard_status" 77 'notify marker does not confirm rm'
assert_exists "$notify_dir" 'notify marker leaves the rm target intact'
run_guarded "$WORK/notify-find.err" env PI_NOTIFY_BACKGROUND=1 PI_SHIMS_SEARCH_TIMEOUT=.05s bash -c 'printf unused | find "$1" -print -exec /bin/sleep 1 \;' _ "$search_dir"
assert_equals "$guard_status" 77 'notify marker does not lift the search timeout'
run_guarded "$WORK/notify-ssh.err" env PI_NOTIFY_BACKGROUND=1 PI_SHIMS_SSH_REAL="$fake_ssh" FAKE_SSH_LOG="$WORK/ssh.argv" ssh remote-host uptime
assert_equals "$guard_status" 23 'notify marker keeps ssh delegation and status'
assert_contains "$WORK/notify-ssh.err" 'one-shot ssh' 'notify marker keeps the ssh reminder'
pass 'PI_NOTIFY_BACKGROUND=1 leaves rm, search, and ssh guards unchanged'

# Capture the timeout invocation without waiting for the production 60s limit.
mkdir -p -- "$WORK/timeout-bin"
cat >"$WORK/timeout-bin/timeout" <<'TIMEOUT'
#!/usr/bin/env bash
printf '%s\n' "$1" "$2" >"$FAKE_TIMEOUT_LOG"
shift 2
exec "$@"
TIMEOUT
chmod +x "$WORK/timeout-bin/timeout"
run_guarded "$WORK/search-default.err" env PATH="$ROOT/bin:$WORK/timeout-bin:$PATH" FAKE_TIMEOUT_LOG="$WORK/timeout.argv" grep needle "$search_dir/one.txt" </dev/null
assert_equals "$guard_status" 0 'default timed search delegates to the real grep'
printf '%s\n' -- 60s >"$WORK/timeout.expected"
cmp -- "$WORK/timeout.expected" "$WORK/timeout.argv" || fail 'search must use timeout -- 60s by default'
[[ ! -s $WORK/search-default.err ]] || fail 'normal search with default timeout is silent'
pass 'filesystem search uses a 60s timeout by default'

# Model package migration: identical copies, symlink aliases, and a different
# pi-shims version all coexist before the real user-local binary in PATH.
mkdir -p -- "$WORK/real-search-bin" "$WORK/copied/bin" "$WORK/older/bin" "$WORK/renamed/bin"
for search in ag ack; do
	printf '#!/usr/bin/env bash\nprintf "fake %s version\\n"\n' "$search" >"$WORK/real-search-bin/$search"
	chmod +x "$WORK/real-search-bin/$search"
done
PATH="$WORK/real-search-bin:$PATH" "$WORK/generator/scripts/generate-search-shims.sh" >"$WORK/generator-all.out"
cp -- "$WORK/generator/bin/"* "$WORK/copied/bin/"
cp -- "$WORK/generator/bin/"* "$WORK/older/bin/"
cp -- "$WORK/generator/bin/"* "$WORK/renamed/bin/"
printf '{"name":"pi-shims","version":"0.2.0"}\n' >"$WORK/older/package.json"
printf '{"name":"pi-command-policy","version":"0.3.0"}\n' >"$WORK/renamed/package.json"
for search in grep rg find fd ag ack; do
	printf '\n# Different generated package version.\n' >>"$WORK/older/bin/$search"
	printf '\n# Renamed package version.\n' >>"$WORK/renamed/bin/$search"
done
ln -s -- "$WORK/copied/bin" "$WORK/copied-alias"
for search in grep rg find fd ag ack; do
	run_guarded "$WORK/search-copies.err" /usr/bin/timeout 1s env PATH="$WORK/generator/bin:$WORK/copied-alias:$WORK/copied/bin:$WORK/older/bin:$WORK/renamed/bin:$ROOT/bin:$WORK/real-search-bin:$PATH" "$WORK/generator/bin/$search" --version </dev/null
	assert_equals "$guard_status" 0 "$search skips other installed shim copies and reaches the real binary"
	[[ ! -s $WORK/search-copies.err ]] || fail "$search version probe with duplicate shims is silent"
done
pass 'all six search shims skip identical copies, symlink aliases, and old and renamed package versions'

canonical_dir="$WORK/canonical-confirmed"
mkdir -p -- "$canonical_dir"
run_guarded "$WORK/canonical-rm.err" env PI_COMMAND_POLICY_CONFIRM=rm rm -rf -- "$canonical_dir"
assert_equals "$guard_status" 0 'policy-named confirmation allows rm'
assert_missing "$canonical_dir" 'policy-named confirmation deletes target'
run_guarded "$WORK/canonical-search.err" env PI_COMMAND_POLICY_CONFIRM=search PI_COMMAND_POLICY_SEARCH_TIMEOUT=.01s find "$search_dir" -maxdepth 0 -exec /bin/sleep .03 \;
assert_equals "$guard_status" 0 'policy-named confirmation allows slow search'
[[ ! -s $WORK/canonical-search.err ]] || fail 'policy-named search confirmation is silent'
pass 'PI_COMMAND_POLICY_CONFIRM names rm or search and changes nothing else'

printf '# %d tests passed\n' "$pass_count"
