#!/usr/bin/env bash
# A6 · FR-MEM-6 · NFR-OBS-5 · DD-28.26(11) — GitNexus graph-refresh cron
# wrapper (interface I2 of .unlazy/a6/PLAN.md; story:
# _bmad-output/sprint-artifacts/dark-factory-v6/stories/a6-gitnexus-refresh-cron.md).
#
# One host-cron cycle = pre-cycle staleness check on the INCOMING stamp
# (record-then-cure — the verdict NEVER aborts) → whole-cycle flock → the
# canonical reindex → the contract suite → exactly ONE structured NFR-OBS-5
# log line appended to the sink. The staleness check runs FIRST, on the
# incoming stamp, because DD-28.26(11): the reindex's own fresh stamp could
# never alarm — a post-cycle check would be structurally inert.
#
# Operator crontab entry (deploy/vps/crontab.factory, VERBATIM byte-match):
#   7 */5 * * * /opt/qds-factory/scripts/gitnexus-refresh.sh >> /var/log/qds/refresh-cron.log 2>&1
#
# Exit contract:
#   0 — cycle succeeded, or coalesced (skipped-overlapping: another cycle
#       holds the lock — no work ran, exit is still 0)
#   1 — cycle failed (the log line names the stage: reindex | contract |
#       crossCheck; a stale staleness verdict NEVER produces exit 1 — it is
#       recorded and cured in the same cycle)
#   3 — pre-cycle configuration failure, NO log line (no cycle ran): missing
#       flock, missing bun, unresolvable repo root, the I1 staleness reader
#       missing, the lock/sink locations uncreatable, no usable millisecond
#       clock leg, or a set-but-empty override command (the `:-` default
#       would otherwise silently substitute the PRODUCTION command for an
#       empty fixture override, and a no-op must never read as success) —
#       stderr FATAL
#
# Stage diagram (order is the contract):
#   [a] resolve repo root (cd to script-dir parent first — cron starts in
#       $HOME — then git rev-parse --show-toplevel, the canonical script's
#       idiom; git unavailable → script-dir fallback + WARN: a cron must
#       still attempt the cure), cycle id = tick-start UTC ISO, t0 for
#       durationMs
#   [b] staleness on the INCOMING stamp via scripts/gitnexus-staleness.ts
#       (I1) — verdict recorded, never aborts
#   [c] flock -n fd 9 on <graph-home>/.refresh.lock (mkdir -p first; fd 9
#       held for the whole cycle) — refusal → log skipped-overlapping,
#       exit 0
#   [d] reindex — QDS_REFRESH_REINDEX_CMD (default: the canonical script
#       from the repo root, never a bare `gitnexus analyze` — AC1); failure
#       → result failed stage reindex, contract skipped
#   [e] contract suite — QDS_REFRESH_CONTRACT_CMD (the drift ALARM, never
#       the adopter); failure → result failed stage contract
#   [f] crossCheck (full cycles only): post-cycle stamp indexedHead vs
#       `git rev-parse HEAD`; mismatch (or an unreadable post-cycle stamp —
#       fail-closed, never match-on-unknown) → result failed stage
#       crossCheck with a detail naming both shas
#   [g] ONE JSON log line appended to the sink; exit 0 (success or
#       skipped-overlapping) or 1 (failed)
#
# Log-line schema (story Observability Contract — 9 base fields, in order):
#   {ts, cycle, result: success|failed|skipped-overlapping, durationMs,
#    indexedHeadSha, stampAgeHours, cliInstalled, cliExpected,
#    crossCheck: match|mismatch|n/a}
#   plus, only where truthfully applicable:
#    stage            ("reindex"|"contract"|"crossCheck") on result=failed —
#                     "staleness" is documented-but-never-emitted: the
#                     verdict never aborts (record-then-cure)
#    stalenessAlarm   {fired:true, ageHours, ceilingHours, stampPath} when
#                     the INCOMING verdict was stale — the alarm survives
#                     the cure in the record
#    detail           string on crossCheck-mismatch failures naming both
#                     shas
#   stampAgeHours is null on absent/invalid stamps (never 0 — INV-A6-2).
#   durationMs is the real elapsed attempt time (never 0 on a failed
#   cycle). cliInstalled/cliExpected read the CURRENT stamp at log time
#   (post-reindex when it completed, incoming otherwise) with the writer's
#   own fallbacks "unknown"/"unpinned".
#
# Env-var table (NAMES only — values are never logged, never echoed):
#   QDS_REFRESH_LOG            log sink file; default <root>/.sandbox/refresh-cron.jsonl
#   QDS_REFRESH_REINDEX_CMD    reindex command string; default: the canonical
#                              script (fixture/testing override)
#   QDS_REFRESH_CONTRACT_CMD   contract-suite command string; default: the
#                              contract suite via bun test (fixture/testing
#                              override)
#   QDS_GITNEXUS_HOME          graph-home passthrough to the I1 staleness
#                              reader; also pins the lock dir; unset-or-empty
#                              → <root>/.gitnexus
#   PATH                       must carry bun + flock on the cron host (a
#                              default cron PATH may carry neither — the
#                              missing one is a named exit-3 FATAL)
set -euo pipefail

# ── helpers ──────────────────────────────────────────────────────────────────

# Millisecond wall clock, three measured legs — bash≥5 $EPOCHREALTIME → GNU
# `date +%s%3N` → perl -MTime::HiRes. macOS bash 3.2 has neither EPOCHREALTIME
# nor BSD %N (BSD date prints a literal "N"), so the perl leg serves there; the
# VPS hits the first or second. Each leg's output is VALIDATED as digits
# before use — a leg is measured, never assumed.
now_ms() {
  if [ -n "${EPOCHREALTIME:-}" ]; then
    local us="${EPOCHREALTIME/./}"
    case "$us" in
      '' | *[!0-9]*) : ;; # malformed — fall through to the date leg
      *) printf '%s\n' $((us / 1000)); return 0 ;;
    esac
  fi
  local d
  d="$(date +%s%3N 2>/dev/null || true)"
  case "$d" in
    '' | *[!0-9]*) : ;;
    *) printf '%s\n' "$d"; return 0 ;;
  esac
  if command -v perl >/dev/null 2>&1; then
    local p
    p="$(perl -MTime::HiRes=time -e 'printf "%.0f\n", time * 1000' 2>/dev/null || true)"
    case "$p" in
      '' | *[!0-9]*) : ;;
      *) printf '%s\n' "$p"; return 0 ;;
    esac
  fi
  # Last resort: whole seconds ×1000 — second-resolution elapsed, still honest
  # (measured, never fabricated). A missing `date` makes this leg FAIL — the
  # caller validates the result and refuses (exit 3), never fabricates.
  printf '%s\n' $(( $(date +%s) * 1000 ))
}

# ── [a] pre-cycle configuration — any failure here: FATAL, exit 3, NO log
# ── line (no cycle ran, so the sink must stay untouched)

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)" || {
  echo "FATAL: cannot resolve the wrapper's own directory" >&2
  exit 3
}

# Cron starts in $HOME: cd to the script-dir parent FIRST, then resolve git
# from there — an unpinned rev-parse could adopt a FOREIGN repo. Fallback when
# git is unavailable (stripped cron PATH): script-dir arithmetic + WARN — the
# cure attempt must survive even without git.
REPO_ROOT=""
if command -v git >/dev/null 2>&1; then
  REPO_ROOT="$(cd "$SCRIPT_DIR/.." 2>/dev/null && git rev-parse --show-toplevel 2>/dev/null || true)"
fi
if [ -z "$REPO_ROOT" ]; then
  REPO_ROOT="$SCRIPT_DIR/.."
  echo "WARN: git rev-parse unavailable or failed — falling back to the script-dir parent as repo root" >&2
fi
if ! cd "$REPO_ROOT" 2>/dev/null; then
  echo "FATAL: cannot resolve the repo root (git rev-parse failed and the script-dir parent is not a directory)" >&2
  exit 3
fi

command -v flock >/dev/null 2>&1 || {
  echo "FATAL: flock not found on PATH — the whole-cycle advisory lock (AC5) cannot be taken" >&2
  exit 3
}
command -v bun >/dev/null 2>&1 || {
  echo "FATAL: bun not found on PATH — the I1 staleness reader and the contract suite cannot run" >&2
  exit 3
}
# A SET-BUT-EMPTY override command must FATAL before the defaults resolve:
# `:-` would silently substitute the PRODUCTION command for an empty fixture
# override — aiming a fixture run at the live graph. (Measured, not assumed:
# this exact hole ran a real canonical reindex before the guard existed.)
# QDS_GITNEXUS_HOME and QDS_REFRESH_LOG keep the I1 reader's set-but-empty
# counts-as-unset semantics (F-017) — their defaults are locations, not
# actions, and an empty value cannot cause work to run.
if [ -n "${QDS_REFRESH_REINDEX_CMD+x}" ] && [ -z "$QDS_REFRESH_REINDEX_CMD" ]; then
  echo "FATAL: QDS_REFRESH_REINDEX_CMD is set but empty — refusing to substitute the production reindex command" >&2
  exit 3
fi
if [ -n "${QDS_REFRESH_CONTRACT_CMD+x}" ] && [ -z "$QDS_REFRESH_CONTRACT_CMD" ]; then
  echo "FATAL: QDS_REFRESH_CONTRACT_CMD is set but empty — refusing to substitute the production contract-suite command" >&2
  exit 3
fi

# Defaults are the production commands; overrides exist for fixture runs only.
LOG_FILE="${QDS_REFRESH_LOG:-$REPO_ROOT/.sandbox/refresh-cron.jsonl}"
REINDEX_CMD="${QDS_REFRESH_REINDEX_CMD:-bash scripts/install-gitnexus-plus.sh}"
CONTRACT_CMD="${QDS_REFRESH_CONTRACT_CMD:-bun test tests/gitnexus/contract.test.ts}"
GRAPH_HOME="${QDS_GITNEXUS_HOME:-$REPO_ROOT/.gitnexus}"

[ -f "scripts/gitnexus-staleness.ts" ] || {
  echo "FATAL: scripts/gitnexus-staleness.ts missing — the I1 staleness reader ships with this wrapper" >&2
  exit 3
}
mkdir -p "$(dirname "$LOG_FILE")" 2>/dev/null || {
  echo "FATAL: cannot create the log sink parent (QDS_REFRESH_LOG)" >&2
  exit 3
}

CYCLE="$(date -u +%Y-%m-%dT%H:%M:%SZ 2>/dev/null)" || {
  echo "FATAL: date unavailable on PATH — the cycle id cannot be stamped" >&2
  exit 3
}
# || true: a no-leg clock must FATAL (below), not tear the shell down under
# set -e before the FATAL is written.
T0_MS="$(now_ms || true)"
case "$T0_MS" in
  '' | *[!0-9]*)
    echo "FATAL: no honest millisecond clock leg available (need EPOCHREALTIME, GNU date, or perl)" >&2
    exit 3
    ;;
esac

# Stamp-file field reader: the writer (install-gitnexus-plus.sh) emits pretty
# JSON `"key": "value"`; the optional-space pattern reads both that and compact
# form. Missing file / missing key → empty output (callers apply the writer's
# fallback vocabulary). 2>/dev/null: an unreadable stamp reads as absent-empty,
# fail-closed downstream.
stamp_str() { # $1 = key, $2 = stamp file
  [ -f "$2" ] || return 0
  sed -n "s/.*\"$1\" *: *\"\([^\"]*\)\".*/\1/p" "$2" 2>/dev/null | head -n 1 || true
}

# JSON-string escape for material read from stamp files (external-ish): escape
# backslash and double-quote, drop control characters — version strings and
# 40-hex shas never legitimately carry them.
json_escape() {
  printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g' | tr -d '\000-\037' || true
}

# ── [b] pre-cycle staleness on the INCOMING stamp (record-then-cure) ─────────
# The verdict NEVER aborts the cycle: its fields feed stage [g]'s log line
# (stalenessAlarm on stale; null age on absent/invalid — never 0, INV-A6-2).
# stderr flows through to the cron log for diagnosability; stdout is the ONE
# JSON verdict line.
STALE_JSON="$(bun scripts/gitnexus-staleness.ts </dev/null)" || true

json_str_field() { # $1 = json text, $2 = key — I1's compact JSON string fields
  printf '%s\n' "$1" | sed -n "s/.*\"$2\":\"\([^\"]*\)\".*/\1/p" | head -n 1 || true
}
json_num_field() { # $1 = json text, $2 = key — I1's bare number-or-null fields
  printf '%s\n' "$1" | sed -n "s/.*\"$2\":\([^,}]*\).*/\1/p" | head -n 1 || true
}
# Number-or-null validation BEFORE any token reaches the log line: I1 emits
# JSON numbers/null; a foreign stdout must never inject raw bytes into the
# record. Negative ages (clock skew) are valid numbers and preserved.
num_or_null() {
  if [ "$1" = "null" ]; then printf 'null'; return 0; fi
  if printf '%s' "$1" | grep -Eq -- '^-?[0-9]+(\.[0-9]+)?$'; then printf '%s' "$1"; else printf 'null'; fi
}

IN_VERDICT="$(json_str_field "$STALE_JSON" verdict)"
IN_AGE_JSON="$(num_or_null "$(json_num_field "$STALE_JSON" ageHours)")"
IN_CEIL_JSON="$(num_or_null "$(json_num_field "$STALE_JSON" ceilingHours)")"
IN_STAMP_PATH_RAW="$(json_str_field "$STALE_JSON" stampPath)"
# A stdout that is not I1's line (bun crash, torn read) reads INVALID — the
# same fail-closed vocabulary the reader itself emits; never a fabricated age.
case "$IN_VERDICT" in
  fresh | stale | absent | invalid) : ;;
  *) IN_VERDICT=invalid; IN_AGE_JSON=null; IN_CEIL_JSON=8; IN_STAMP_PATH_RAW="" ;;
esac

# Incoming stamp sha + current-stamp versions read from the same file I1 read
# (graph-home per I1 resolution — the wrapper mirrors it via QDS_GITNEXUS_HOME
# / <root>/.gitnexus with its cwd pinned to the repo root).
STAMP_PATH="$GRAPH_HOME/cli-version.json"
IN_SHA_RAW="$(stamp_str indexedHead "$STAMP_PATH")"
IN_SHA="$(json_escape "${IN_SHA_RAW:-unknown}")"

# ── [g] the single log line (defined here, called from every exit path) ──────
# Exactly ONE append per cycle. Called as:
#   emit_and_exit <result> <stage|""> <crossCheck> <headSha> <detail|"">
emit_and_exit() {
  local result="$1" stage="$2" cross="$3" head_sha="$4" detail="$5"
  local t1 dur
  # The end clock cannot be allowed to abort the emit: a cycle that ran MUST
  # produce its line. If every leg somehow vanished mid-cycle, t1 degrades to
  # T0 — dur clamps to 1, the honest record of "elapsed below what we could
  # measure", never a fabricated number.
  t1="$(now_ms || true)"
  case "$t1" in
    '' | *[!0-9]*) t1="$T0_MS" ;;
  esac
  dur=$((t1 - T0_MS))
  # A real attempt always spans process spawns; a ≤0 diff is a clock-leg
  # artifact, never truth — and duration 0 on a failed cycle is exactly the
  # negative control the suite refuses.
  [ "$dur" -ge 1 ] || dur=1
  local now
  now="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  # cliInstalled/cliExpected: the CURRENT stamp at log time — post-reindex
  # when the reindex completed, the incoming stamp otherwise; the writer's
  # own fallback vocabulary when the stamp is missing or lacks the keys.
  local cur_installed cur_expected
  cur_installed="$(stamp_str installedCliVersion "$STAMP_PATH")"
  cur_expected="$(stamp_str expectedCliVersion "$STAMP_PATH")"
  local line
  line="{\"ts\":\"$now\",\"cycle\":\"$CYCLE\",\"result\":\"$result\",\"durationMs\":$dur,\"indexedHeadSha\":\"$head_sha\",\"stampAgeHours\":$IN_AGE_JSON,\"cliInstalled\":\"$(json_escape "${cur_installed:-unknown}")\",\"cliExpected\":\"$(json_escape "${cur_expected:-unpinned}")\",\"crossCheck\":\"$cross\""
  if [ -n "$stage" ]; then line="$line,\"stage\":\"$stage\""; fi
  if [ "$IN_VERDICT" = "stale" ]; then
    line="$line,\"stalenessAlarm\":{\"fired\":true,\"ageHours\":$IN_AGE_JSON,\"ceilingHours\":$IN_CEIL_JSON,\"stampPath\":\"$IN_STAMP_PATH_RAW\"}"
  fi
  if [ -n "$detail" ]; then line="$line,\"detail\":\"$(json_escape "$detail")\""; fi
  printf '%s\n' "$line}" >>"$LOG_FILE" || {
    echo "FATAL: cannot append to the log sink" >&2
    exit 3
  }
  if [ "$result" = "failed" ]; then exit 1; fi
  exit 0
}

# ── [c] whole-cycle advisory lock (AC5) ──────────────────────────────────────
mkdir -p "$GRAPH_HOME" 2>/dev/null || {
  echo "FATAL: cannot create the graph home for the refresh lock" >&2
  exit 3
}
LOCK_FILE="$GRAPH_HOME/.refresh.lock"
# Probe-then-exec: under `set -e` a failing `exec 9>` redirection would tear
# the shell down with neither a log line nor a FATAL; `: >>` proves the lock
# path creatable BEFORE the fd is pinned. The lock file carries no content —
# only its flock state matters.
# No signal traps, deliberately: the wrapper owns no transient filesystem
# state for a cleanup() to restore (the canonical script's EXIT-trap hygiene
# exists for its .gitnexusignore and skills backups — none here). The lock is
# an fd flock the kernel releases on ANY exit, signal-killed included; a
# killed cycle leaves no log line, and the next tick's staleness verdict
# describes reality.
: >>"$LOCK_FILE" 2>/dev/null || {
  echo "FATAL: cannot create the refresh lock file" >&2
  exit 3
}
exec 9>>"$LOCK_FILE"
if ! flock -n 9; then
  # Coalesce, never collide: this tick did NO work — record the INCOMING stamp
  # sha with crossCheck n/a and exit 0 (AC3/AC5). A stale incoming verdict is
  # still truthfully reported via stalenessAlarm: the NEXT successful cycle
  # cures it.
  emit_and_exit "skipped-overlapping" "" "n/a" "$IN_SHA" ""
fi

# ── [d] reindex: the canonical script from the repo root (AC1/INV-A6-1) ──────
# A bare `gitnexus analyze` would silently filter tests/ via the transient
# .gitnexusignore negation — never invoked here, and the suite's scan refuses
# the bare form by name.
RC=0
bash -c "$REINDEX_CMD" </dev/null || RC=$?
if [ "$RC" -ne 0 ]; then
  # No completed reindex: the incoming stamp remains current; no cross-check
  # can run; the contract stage is skipped (the graph was not rebuilt).
  emit_and_exit "failed" "reindex" "n/a" "$IN_SHA" ""
fi


# ── [e] contract suite: the drift ALARM, never the adopter (AC4) ─────────────
# The reindex COMPLETED — the post-cycle stamp is now the current one; its sha
# is recorded even though a contract-red cycle never reaches the crossCheck.
RC=0
bash -c "$CONTRACT_CMD" </dev/null || RC=$?
if [ "$RC" -ne 0 ]; then
  POST_SHA="$(json_escape "$(stamp_str indexedHead "$STAMP_PATH")")"
  emit_and_exit "failed" "contract" "n/a" "${POST_SHA:-unknown}" ""
fi

# ── [f] crossCheck: post-cycle stamp vs git HEAD (full cycles only, AC3) ─────
POST_SHA_RAW="$(stamp_str indexedHead "$STAMP_PATH")"
GIT_SHA="$(git rev-parse HEAD 2>/dev/null || true)"
if [ -z "$POST_SHA_RAW" ]; then
  # A completed reindex whose stamp cannot be read cannot be verified —
  # fail-closed (INV-A6-2 spirit): never report match on an unknown sha.
  emit_and_exit "failed" "crossCheck" "mismatch" "unknown" \
    "crossCheck could not verify: post-cycle stamp has no readable indexedHead; git HEAD: ${GIT_SHA:-unavailable}"
fi
if [ -z "$GIT_SHA" ]; then
  emit_and_exit "failed" "crossCheck" "mismatch" "$(json_escape "$POST_SHA_RAW")" \
    "crossCheck could not verify: git rev-parse HEAD failed; stamp sha: $POST_SHA_RAW"
fi
if [ "$POST_SHA_RAW" = "$GIT_SHA" ]; then
  emit_and_exit "success" "" "match" "$(json_escape "$POST_SHA_RAW")" ""
fi
emit_and_exit "failed" "crossCheck" "mismatch" "$(json_escape "$POST_SHA_RAW")" \
  "post-cycle stamp indexedHead $POST_SHA_RAW != git rev-parse HEAD $GIT_SHA"
