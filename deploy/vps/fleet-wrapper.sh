#!/bin/sh
# fleet-wrapper.sh — the exec shim that SWARMCLAW_FACTORY_FLEET_CLI points at on the VPS.
#
# Z4 / DF5.5 Amendment D: this file is the SOLE holder of `--driver exedev`.
# The swarmclaw fork invokes this script via execFile(shell: false) with a
# stripped child env (PATH, HOME, TMPDIR, LANG only) and never learns QDS's
# driver grammar — the driver name is fixed HERE, in the verb table below,
# and is NOT a config surface: no environment knob may ever select it. This
# script reads no config environment — its only env touch is the implicit
# `command -v bun` PATH probe exec requires — and resolves the factory
# checkout from its own script location — an env-var fallback could never
# work under the fork's allowlist, so none exists. It uses shell builtins
# and parameter expansion ONLY for that resolution: no external command (not
# even dirname) may sit between this script and `exec bun` on a stripped PATH.
#
# Per invocation: exactly ONE provenance line to STDERR — `verb=<v>
# driver_injected=<bool>` — never stdout (stdout is the verb's JSON contract).
# The line precedes every exit path below, so even an early refusal (unknown
# verb, unresolvable checkout) logs it — the sole exceptions are the two
# malformed-verb guards, which refuse before printing rather than log a
# corrupt line. stdin/stdout/stderr pass through
# untouched and `exec` hands the fork the CLI's own exit code.
#
# Install discipline: the HOST copy is diff-verified against this repo copy on
# every deploy (the same compose discipline); the registry drift alarms guard
# the repo copy only.
#
# tests/deploy/fleet-wrapper.test.ts validates the two verb sets below against
# src/fleet/verbs.ts listVerbs() — registry drift fails CI, so edit both
# together or not at all.

set -u

# The ten verbs on which --driver is REQUIRED (assertDriverChosen refuses
# without it as exit 2): the wrapper satisfies the requirement on the fork's
# behalf, appending the flag exactly once, at the end of argv.
driver_verbs='dispatch status harvest teardown fanout attach run observe submit cancel'
# The six verbs that take NO --driver at all: passed through byte-untouched
# (an argv that already carries --driver is refused by the guard below — the
# wrapper never forwards the flag either).
no_driver_verbs='rank approve reject enrol unlock result'

verb=${1:-}
inject=false
known=false
for v in $driver_verbs; do
  [ "$v" = "$verb" ] && { inject=true; known=true; }
done
for v in $no_driver_verbs; do
  [ "$v" = "$verb" ] && known=true
done

# A newline inside $verb would split the provenance line across several
# stderr lines — refuse BEFORE the provenance printf so the one-line
# contract holds on every path that logs (round-2 F-011).
case $verb in
*"
"*) printf 'fleet-wrapper: verb must not contain a newline\n' >&2; exit 2 ;;
esac

# Same for a carriage return: a CR in $verb would embed a CR in the provenance
# line, and CR-sensitive log consumers would read that one line as two
# (round-3 F-13). Refuse BEFORE the printf — printing the line "once" would
# still embed the very CR this guard keeps out. The CR is built via printf (a
# builtin, safe on the stripped PATH) to stay POSIX-portable.
cr=$(printf '\r')
case $verb in
*"$cr"*) printf 'fleet-wrapper: verb must not contain a carriage return\n' >&2; exit 2 ;;
esac

printf 'verb=%s driver_injected=%s\n' "$verb" "$inject" >&2

if [ "$known" = false ]; then
  printf 'fleet-wrapper: unknown or missing verb: %s\n' "${verb:-<missing>}" >&2
  printf 'usage: fleet-wrapper.sh <verb> [args...]\nverbs: %s %s\n' "$driver_verbs" "$no_driver_verbs" >&2
  exit 2
fi

# The CLI's flag map is last-wins (scripts/lib/cli-args.ts), so a silent
# append would OVERRIDE an operator's explicit `--driver fake` dry run
# (scripts/fleet.ts:393) with real exedev action — spend where a dry run
# was requested. Refuse loudly instead (round-3 F-03); the provenance line
# above already logged this exit, so the F-007 ordering property holds.
case " $* " in
*" --driver "*)
  printf 'fleet-wrapper: argv already carries --driver — the wrapper injects it; drop the flag (dry-run spell: run scripts/fleet.ts directly for --driver fake)\n' >&2
  exit 2 ;;
esac

# The wrapper lives at <checkout>/deploy/vps/, so the checkout is
# dirname(dirname($0)) — computed with parameter expansion and cd/pwd builtins
# only. $0 must be ABSOLUTE — the fork's execFile contract always passes one —
# and a relative name is refused (exit 2) rather than resolved against the
# caller's cwd, where a bare-name invocation would silently adopt a wrong
# checkout; pwd -P keeps a symlinked install from doing the same.
case $0 in
  /*) here=${0%/*} ;;
  *) printf 'fleet-wrapper: $0 must be an absolute path (the fork execFile contract passes one); got: %s\n' "$0" >&2
     exit 2 ;;
esac
# A root-level install ($0=/fleet-wrapper.sh) leaves ${0%/*} empty; refuse
# with a diagnostic BEFORE `cd ""` — that call's success/failure is
# implementation-defined (bash-as-sh and dash succeed and adopt the caller's
# cwd, busybox fails bare), so the guard must precede it (round-2 F-010).
[ -n "$here" ] || { printf 'fleet-wrapper: cannot resolve the checkout directory from $0=%s\n' "$0" >&2; exit 1; }
here=$(CDPATH= cd "$here" && pwd -P) || exit 1
# Up two levels: <checkout>/deploy/vps → <checkout>/deploy → <checkout>.
repo_root=${here%/*}
repo_root=${repo_root%/*}
[ -n "$repo_root" ] || exit 1
# Diagnose the expected entrypoint before exec — bun's bare module-not-found
# says nothing about where the wrapper looked.
[ -f "$repo_root/scripts/fleet.ts" ] ||
  { printf 'fleet-wrapper: resolved checkout %s has no scripts/fleet.ts — the install is wrong or the host copy diverged from the repo copy\n' "$repo_root" >&2; exit 1; }

[ "$inject" = true ] && set -- "$@" --driver exedev

# `command` is a POSIX builtin — safe to probe a stripped PATH where no
# external tool resolves.
command -v bun >/dev/null 2>&1 || {
  printf 'fleet-wrapper: bun not on PATH (fork env allowlist passes PATH; install bun and ensure the fork child PATH includes it, runbook §2/§6)\n' >&2
  exit 127
}

exec bun "$repo_root/scripts/fleet.ts" "$@"
