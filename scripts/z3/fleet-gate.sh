#!/bin/bash
# Z3 crash-window gate — the fork container's SWARMCLAW_FACTORY_FLEET_CLI for
# the live exit round (the SC2.6 window-(a) mechanism, sc2-harness.ts
# wrapperScript, made a committed file). MUST be committed 100755: the fork
# execFile()s it with shell:false, and a non-executable file fails EVERY verb.
#
# Every verb other than `submit` is `exec`'d straight into the REAL fleet CLI:
# argv, stdin and signals untouched (the wrapper process becomes the CLI).
# A `submit` has its brief (stdin) buffered BYTE-EXACT to a temp file, read
# for the workId, then exec'd the same way. The exceptions apply only to a
# submit whose brief carries a `w:z3-<stamp>-code` workId:
#   - `abort` present (the round's cleanup): exit 99 at once, exec nothing, journal `aborted` —
#     whatever `armed` or `release` say, so a failed round never releases spend;
#   - `armed` present: HOLD before the exec. The fork has already persisted
#     `submitting` + the requestId (SC2.1); the driver sees the open window,
#     SIGKILLs the container (this hold dies with it, nothing exec'd), RELEASES
#     the gate and restarts — the replay of the SAME requestId passes through;
#   - armed but no requestId parses: exit 99 (an unjournaled hold would read as
#     "not held" and the driver must never kill blind).
# The hold limit is WALL-CLOCK (240 s via $SECONDS, not a loop count) and sits
# BELOW the fork's 300 s execFile timeout (FLEET_EXEC_TIMEOUT_MS), so a dead
# driver ends the hold here, journaled `expired`, exit 99 (not a replay exit) —
# the step fails, nothing spent. A TERM/INT during the hold (the fork's own
# timeout) is trapped the same way: journaled `expired`, exit 99, no exec. The
# driver only needs the hold to span its poll latency: it kills the container
# as soon as the journal shows `held`.
#
# Config rides FILES, not env — the fork's SC2.5 env allowlist strips anything
# the operator would set (protocol-factory-exec.ts buildFleetEnv):
#   <gate>/real-cli       absolute path of the real fleet CLI (the shim the
#                         container used before this wrapper). Required.
#   <gate>/armed          present = hold z3 code submits (written by the driver).
#   <gate>/release        present = the held submit may proceed.
#   <gate>/abort          present = a z3 code submit exits 99, exec'ing nothing.
#   <gate>/journal.jsonl  one line per code-submit phase (held|released|expired|
#                         aborted|unparsed|exec), each with `at` (epoch ms, 1 s
#                         resolution) — the driver's witness that the kill landed
#                         inside a still-open hold and that exactly one exec ran.
# <gate> defaults to <repo>/.sandbox/z3-gate (the clone is mounted read-write at
# /factory, so host and container see one directory); Z3_GATE_DIR overrides it
# for tests (the fork's env allowlist strips it in the container).
set -u
PATH="${PATH:-/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin}"
here="$(cd "$(dirname "$0")" && pwd)"
GATE="${Z3_GATE_DIR:-$here/../../.sandbox/z3-gate}"
HOLD_LIMIT_S="${Z3_GATE_HOLD_LIMIT_S:-240}"
J="$GATE/journal.jsonl"

# The memory-lane env never crosses the SC2.5 fence (buildFleetEnv allowlists
# PATH/HOME/TMPDIR/LANG), so the code run's dispatch could never prime — the
# recall row is then absent and the priming-recall leg reds ("dispatch recall
# directive absent"), measured live in round 18 AND all four round-19
# attempts. Matching the wrapper's own philosophy — config rides FILES, not
# env — the operator's gate-dir hindsight.env (0600, untracked) is sourced
# here, before EVERY exec path (non-submit verbs exec'd straight through,
# held submits released here, plain submits): one block, all crossings.
# Absent file = the old behavior, unchanged.
if [ -f "$GATE/hindsight.env" ]; then
  set -a
  # shellcheck disable=SC1091
  . "$GATE/hindsight.env"
  set +a
fi

if [ ! -f "$GATE/real-cli" ]; then
  echo "z3 fleet gate: $GATE/real-cli missing — write the real fleet CLI's absolute path there" >&2
  exit 98
fi
REAL="$(head -n 1 "$GATE/real-cli")"
verb="${1:-}"

[ "$verb" = "submit" ] || exec "$REAL" "$@"

tmp="$(mktemp)"
cat > "$tmp"
wid="$(grep -o '"workId":"[^"]*"' "$tmp" | head -n 1 | sed 's/^"workId":"//; s/"$//')"
rid=""
prev=""
for a in "$@"; do
  case "$a" in --request-id=*) rid="${a#--request-id=}" ;; esac
  if [ "$prev" = "--request-id" ]; then rid="$a"; fi
  prev="$a"
done
if [ -z "$rid" ]; then
  rid="$(grep -o '"requestId":"[^"]*"' "$tmp" | head -n 1 | sed 's/^"requestId":"//; s/"$//')"
fi
jline() { printf '{"verb":"submit","requestId":"%s","workId":"%s","phase":"%s","at":%s000}\n' "$rid" "$wid" "$1" "$(date +%s)" >> "$J"; }

if [[ "$wid" =~ ^w:z3-.+-code$ ]]; then
  if [ -f "$GATE/abort" ]; then
    jline aborted
    rm -f "$tmp"
    exit 99
  fi
  if [ -f "$GATE/armed" ]; then
    if [ -z "$rid" ]; then
      jline unparsed
      rm -f "$tmp"
      exit 99
    fi
    trap 'jline expired; rm -f "$tmp"; exit 99' TERM INT
    jline held
    deadline=$((SECONDS + HOLD_LIMIT_S))
    while [ ! -f "$GATE/release" ] || [ -f "$GATE/abort" ]; do
      if [ -f "$GATE/abort" ]; then
        jline aborted
        rm -f "$tmp"
        exit 99
      fi
      if [ "$SECONDS" -ge "$deadline" ]; then
        jline expired
        rm -f "$tmp"
        exit 99
      fi
      sleep 0.1
    done
    trap - TERM INT
    jline released
  fi
  jline exec
fi

# Byte-exact stdin, the real CLI in THIS process (signals reach it), temp file unlinked first.
exec 3<"$tmp"
rm -f "$tmp"
exec "$REAL" "$@" <&3 3<&-
