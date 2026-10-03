#!/bin/sh
# fleet-wrapper.sh — the exec shim that SWARMCLAW_FACTORY_FLEET_CLI points at on the VPS.
#
# Z4 / DF5.5 Amendment D: this file is the SOLE holder of `--driver exedev`.
# The swarmclaw fork invokes this script via execFile(shell: false) with a
# stripped child env (PATH, HOME, TMPDIR, LANG only) and never learns QDS's
# driver grammar — the driver name is fixed HERE, in the verb table below,
# and is NOT a config surface: no environment knob may ever select it. This
# script reads no environment at all, and resolves the factory checkout from
# its own script location — an env-var fallback could never work under the
# fork's allowlist, so none exists. It uses shell builtins and parameter
# expansion ONLY for that resolution: no external command (not even dirname)
# may sit between this script and `exec bun` on a stripped PATH.
#
# Per invocation: exactly ONE provenance line to STDERR — `verb=<v>
# driver_injected=<bool>` — never stdout (stdout is the verb's JSON contract).
# stdin/stdout/stderr pass through untouched and `exec` hands the fork the
# CLI's own exit code.
#
# tests/deploy/fleet-wrapper.test.ts validates the two verb sets below against
# src/fleet/verbs.ts listVerbs() — registry drift fails CI, so edit both
# together or not at all.

set -u

# The wrapper lives at <checkout>/deploy/vps/, so the checkout is
# dirname(dirname($0)) — computed with parameter expansion and cd/pwd builtins
# only. The fork always passes an absolute path, so the strip below removes a
# real directory component; the no-slash fallback is for a bare relative name.
case $0 in
  */*) here=${0%/*} ;;
  *) here=. ;;
esac
here=$(CDPATH= cd "$here" && pwd) || exit 1
# Up two levels: <checkout>/deploy/vps → <checkout>/deploy → <checkout>.
repo_root=${here%/*}
repo_root=${repo_root%/*}
[ -n "$repo_root" ] || exit 1

# The ten verbs on which --driver is REQUIRED (assertDriverChosen refuses
# without it as exit 2): the wrapper satisfies the requirement on the fork's
# behalf, appending the flag exactly once, at the end of argv.
driver_verbs='dispatch status harvest teardown fanout attach run observe submit cancel'
# The six verbs that take NO --driver at all: passed through byte-untouched.
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

printf 'verb=%s driver_injected=%s\n' "$verb" "$inject" >&2

if [ "$known" = false ]; then
  printf 'fleet-wrapper: unknown or missing verb: %s\n' "${verb:-<missing>}" >&2
  printf 'usage: fleet-wrapper.sh <verb> [args...]\nverbs: %s %s\n' "$driver_verbs" "$no_driver_verbs" >&2
  exit 2
fi

[ "$inject" = true ] && set -- "$@" --driver exedev

exec bun "$repo_root/scripts/fleet.ts" "$@"
