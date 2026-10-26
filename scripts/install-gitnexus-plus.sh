#!/usr/bin/env bash
# P0.10 — Install pi-gitnexus-plus + build the QDS-Factory code graph.
#
# Idempotent: safe to re-run. Installs the extension (if missing), then runs
# `gitnexus analyze` so the three core query tools (query/context/impact) have
# a populated graph. Exits non-zero on any failure so CI can gate on it.
#
# Usage:  scripts/install-gitnexus-plus.sh            # install + analyze
#         GITNEXUS_SKIP_INSTALL=1 scripts/...         # analyze only (tests)
set -euo pipefail

# Env-overridable so CI/preview can pin a pre-release without editing the script.
EXT_VERSION="${EXT_VERSION:-0.7.0}"
EXT="npm:pi-gitnexus-plus@${EXT_VERSION}"

# Repo root = git toplevel. Resolving via BASH_SOURCE breaks when the script is
# invoked through a symlink or from elsewhere (dirname can collapse to `/`,
# which would hand `gitnexus analyze` the whole filesystem). `git rev-parse`
# always returns the real repo root regardless of how we were invoked.
REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null)" || {
  echo "FATAL: not running inside a git repo (git rev-parse failed)" >&2
  exit 1
}
[ -n "$REPO_ROOT" ] || { echo "FATAL: git rev-parse returned empty repo root" >&2; exit 1; }
cd "$REPO_ROOT"

# gitnexus ships at a non-standard path on this host (~/.local/node-arm64/bin,
# not /usr/local/bin the story assumed). Resolve it robustly.
GITNEXUS="$(command -v gitnexus || true)"
if [ -z "$GITNEXUS" ] && [ -n "${HOME:-}" ] && [ -x "$HOME/.local/node-arm64/bin/gitnexus" ]; then
  GITNEXUS="$HOME/.local/node-arm64/bin/gitnexus"
fi
if [ -z "$GITNEXUS" ]; then
  echo "FATAL: gitnexus CLI not found on PATH or ~/.local/node-arm64/bin" >&2
  exit 1
fi
# Guard the version capture: first-run interactive prompts, slow startup, or a
# lock-wait can hang `$GITNEXUS --version` with no stdin redirect, before any
# trap/guard applies. </dev/null + timeout/gtimeout (portable resolver: fall
# back to plain run with `|| true` if neither is present at this point — DO NOT
# introduce the perl alarm here, it's reserved for analyze/status). Tolerate
# failure/empty output → print `unknown`.
if command -v timeout >/dev/null 2>&1; then
  GN_VER="$(timeout --kill-after=5 10 "$GITNEXUS" --version </dev/null 2>/dev/null | head -1 || true)"
elif command -v gtimeout >/dev/null 2>&1; then
  GN_VER="$(gtimeout --kill-after=5 10 "$GITNEXUS" --version </dev/null 2>/dev/null | head -1 || true)"
else
  GN_VER="$("$GITNEXUS" --version </dev/null 2>/dev/null | head -1 || true)"
fi
echo "gitnexus: $GITNEXUS (${GN_VER:-unknown})"

# --- 1. Install the extension (idempotent) ------------------------------------
# The verify block lives INSIDE the install guard so GITNEXUS_SKIP_INSTALL=1
# (analyze-only mode, common in CI containers that have `gitnexus` but not
# `pi`) doesn't false-fail on a missing `pi` binary.
if [ "${GITNEXUS_SKIP_INSTALL:-0}" != "1" ]; then
  # Fail fast on a missing `pi` binary BEFORE `pi list` — otherwise the skip
  # branch below misreports "pi-gitnexus-plus already installed" (empty grep
  # input → no match → falls through to `pi install`, which then fails with a
  # confusing `pi: command not found` under `set -e`).
  if ! command -v pi >/dev/null 2>&1; then
    echo "FATAL: \`pi\` CLI not on PATH — set GITNEXUS_SKIP_INSTALL=1 (analyze-only) or install pi" >&2
    exit 1
  fi
  # Capture `pi list` once and separate its failure (infra) from a missing/wrong
  # version (real). Under `set -o pipefail`, `pi list | grep` aborts the pipeline
  # when `pi list` exits nonzero — capture first, grep the string, so a flaky `pi
  # list` doesn't false-fail a successful install or skip the install branch.
  PI_LIST="$(pi list 2>/dev/null || true)"
  # Same anchored pattern as the post-install verify below — a stale older
  # version (e.g. @0.6.0) satisfying the loose `pi-gitnexus-plus` substring
  # would skip install and then FATAL in verify.
  if printf '%s\n' "$PI_LIST" | grep -qE "pi-gitnexus-plus@${EXT_VERSION}([^[:alnum:]._+-]|\$)"; then
    echo "pi-gitnexus-plus already installed — skipping install."
  else
    echo "Installing $EXT ..."
    # </dev/null: never block on an interactive prompt in CI.
    pi install "$EXT" < /dev/null
    PI_LIST="$(pi list 2>/dev/null || true)"
  fi
  # Pin the exact version — anchor it so a prerelease (`@0.7.0-beta`) or newer
  # patch doesn't satisfy the bare `pi-gitnexus-plus@0.7.0` substring. Distinguish
  # "pi list returned nothing" (infra error) from "wrong version listed" (real).
  # One-shot retry: the pi registry cache can lag a just-completed `pi install`,
  # so if the anchored verify fails, re-capture `pi list` once before declaring
  # FATAL. Retry UNCONDITIONALLY (not gated on PI_LIST being non-empty): a
  # transient empty `pi list` (registry lock, blip) is itself recoverable by a
  # retry, and if it's a real infra break the re-capture stays empty and the
  # `[ -z "$PI_LIST" ]` branch below still reports the infra-error message —
  # so the retry costs one subprocess on the failure path and loses no
  # diagnostic distinction. Single retry, not a loop — bounds wall-clock.
  if ! printf '%s\n' "$PI_LIST" | grep -qE "pi-gitnexus-plus@${EXT_VERSION}([^[:alnum:]._+-]|\$)"; then
    PI_LIST="$(pi list 2>/dev/null || true)"
    printf '%s\n' "$PI_LIST" | grep -qE "pi-gitnexus-plus@${EXT_VERSION}([^[:alnum:]._+-]|\$)" || {
      if [ -z "$PI_LIST" ]; then
        echo "FATAL: \`pi list\` returned no output — cannot verify install (pi infra error?)" >&2
      else
        echo "FATAL: pi-gitnexus-plus@${EXT_VERSION} not listed after install" >&2
      fi
      exit 1
    }
  fi
fi

# --- 2. Analyze the repo ------------------------------------------------------
# GitNexus's DEFAULT_IGNORE_LIST hard-filters any dir named `tests`, `__tests__`
# or `fixtures`. The test fixture (tests/gitnexus/fixtures/swarmclaw.ts) supplies
# the known symbols the ACs query (registerAgent, SwarmClaw routes), so we negate
# those defaults for the duration of the analyze via a transient root-level
# `.gitnexusignore` (gitnexus #771 negation semantics), then remove it. The file
# is transient because a root `.gitnexusignore` is not a story deliverable.
# NOTE: transient negation file, not committed — the fixture symbols are the
# only reason we override the safety-net ignore list.
#
# CONCURRENT-RUN HAZARD (F092): two invocations of this script in the same repo
# (parallel CI matrix, overlapping stories) race on the transient root
# `.gitnexusignore` — run A's EXIT trap can `rm` the file while run B is
# mid-analyze, dropping the negations and silently filtering the fixture.
# Worse, `gitnexus analyze --force` running concurrently can corrupt the graph
# DB (no file lock). CLAUDE.md names this script as THE canonical reindex
# command, so "declared unsupported" was not prevention. The lock below refuses
# the second run instead.
#
# `mkdir` and not `flock(1)`: flock is NOT installed on macOS by default (util-
# linux only), and this script runs on developer macs as well as CI. `mkdir` is
# atomic on every POSIX filesystem the repo can live on, needs no dependency,
# and the whole critical section (write .gitnexusignore -> analyze -> rm it) is
# what has to be serialized, so the lock is taken BEFORE the ignore file exists.
# Released by cleanup() via the EXIT trap, which is armed just above the
# acquire so no failure path between acquire and analyze can leak the lock.
#
# Stale reclaim is pid-based and therefore SAME-HOST ONLY: a lock left by a
# SIGKILLed run on this machine is reclaimed once its pid is gone; a lock on a
# shared network checkout written by another host is not (pid_alive would test a
# LOCAL pid of the same number). That is the conservative direction — a false
# "held" refuses, it does not corrupt.
cleanup() {
  # `|| true` on both rm's: under `set -e` a failed removal (permissions, read-
  # only fs, busy mount) would abort cleanup before `return 0`, masking the real
  # exit code $rc (set by the EXIT trap) with exit 1 — breaks the "safe to
  # re-run" contract. Suppress so cleanup always reaches `return 0`.
  [ "${CREATED_IGNORE:-0}" = "1" ] && { rm -f "${IGNORE_FILE:-}" 2>/dev/null || true; }
  # A failed analyze leaves the standard skills moved aside: put them back so
  # the tracked files are never lost. On success the backup is just deleted.
  if [ -n "${SKILLS_BACKUP:-}" ] && [ -d "$SKILLS_BACKUP" ]; then
    if [ "${ANALYZE_OK:-0}" != "1" ]; then
      for f in "$SKILLS_BACKUP"/*/SKILL.md; do
        [ -f "$f" ] || continue
        name="$(basename "$(dirname "$f")")"
        mkdir -p "$SKILLS_ROOT/$name" 2>/dev/null || true
        mv "$f" "$SKILLS_ROOT/$name/SKILL.md" 2>/dev/null || true
      done
    fi
    rm -rf "$SKILLS_BACKUP" 2>/dev/null || true
  fi
  # Dirs this run created are removed ONLY on a failed run (a partial template
  # in an untracked dir); on success the generated skills stay — a first
  # install must keep what it generated.
  if [ "${ANALYZE_OK:-0}" != "1" ]; then
    for d in ${CREATED_SKILL_DIRS:-}; do rm -rf "$d" 2>/dev/null || true; done
  fi
  [ "${CREATED_LOCK:-0}" = "1" ] && { rm -rf "${LOCK_DIR:-}" 2>/dev/null || true; }
  # Without this, a `set -e` exit while the reclaim guard is held (e.g. the pid
  # write at line ~211/268 fails) leaks $RECLAIM_LOCK_DIR forever — the next
  # run's acquire_reclaim_guard() waits 5s then lock_fatal()s permanently.
  # Ownership-gated (CREATED_RECLAIM_LOCK), not unconditional: this process
  # must never remove a guard another process currently holds.
  [ "${CREATED_RECLAIM_LOCK:-0}" = "1" ] && { rmdir "${RECLAIM_LOCK_DIR:-}" 2>/dev/null || true; }
  return 0
}
# Trap EXIT only so cleanup runs exactly once. Signal traps set the conventional
# exit code (130=INT, 143=TERM) then exit — the EXIT trap runs cleanup with that
# code preserved. Trapping the same fn on EXIT INT TERM double-runs cleanup and
# can mask the real exit code under `set -e`. `cleanup` returns 0 explicitly:
# when `CREATED_SKILLS=0` (dir pre-existed) the final `[ = 1 ]` test exits 1,
# which under `set -e` would abort the trap before `exit "$rc"` and mask the real
# exit code — breaking the "safe to re-run" contract (re-runs returned exit 1).
trap 'rc=$?; cleanup; exit "$rc"' EXIT
trap 'rc=130; exit "$rc"' INT
trap 'rc=143; exit "$rc"' TERM

LOCK_DIR="$REPO_ROOT/.gitnexus-analyze.lock"
CREATED_LOCK=0
lock_fatal() {
  echo "FATAL: another gitnexus analyze is running in this repo (lock: $LOCK_DIR)" >&2
  echo "       Concurrent same-repo analyze races the transient .gitnexusignore and can" >&2
  echo "       corrupt the graph DB — serialize across CI matrix shards / stories." >&2
  echo "       If no run is live, remove the lock: rm -rf \"$LOCK_DIR\"" >&2
  exit 1
}
# Liveness for the stale check. `kill -0` alone is NOT the test: it fails with
# EPERM — indistinguishable from ESRCH at the exit-status level — for a LIVE
# process owned by another user, which on a shared CI box or a multi-user host
# would report a running analyze as dead and reclaim its lock. `ps -p` sees
# processes it cannot signal, so it decides the EPERM case. Either says yes =>
# alive => refuse.
pid_alive() {
  kill -0 "$1" 2>/dev/null || ps -p "$1" >/dev/null 2>&1
}

# Reclaim guard: a second, smaller mkdir-based lock that serializes the
# "is the main lock actually stale" DECISION plus the reclaim ACTION across
# racing processes (closes the TOCTOU in the dead-pid reclaim below). It does not
# replace the atomic-rename + identity-check on the main lock — it closes the
# window in front of it, where two racers could both read the same dead pid
# and both start reclaiming before either's rename lands. Bounded wait: a
# leaked guard (should never happen, released in every path below) must not
# wedge every future run — same "safe to re-run" contract as the main lock.
RECLAIM_LOCK_DIR="$LOCK_DIR.reclaim"
STALE_GRACE_SECS=30
CREATED_RECLAIM_LOCK=0
acquire_reclaim_guard() {
  local waited=0
  while ! mkdir "$RECLAIM_LOCK_DIR" 2>/dev/null; do
    waited=$((waited + 1))
    [ "$waited" -ge 50 ] && lock_fatal
    sleep 0.1
  done
  CREATED_RECLAIM_LOCK=1
}
release_reclaim_guard() {
  rmdir "$RECLAIM_LOCK_DIR" 2>/dev/null || true
  CREATED_RECLAIM_LOCK=0
}
lock_dir_mtime() {
  stat -f %m "$1" 2>/dev/null || stat -c %Y "$1" 2>/dev/null || echo ""
}

if mkdir "$LOCK_DIR" 2>/dev/null; then
  CREATED_LOCK=1
  echo $$ > "$LOCK_DIR/pid"
else
  acquire_reclaim_guard
  if mkdir "$LOCK_DIR" 2>/dev/null; then
    # Free by the time we got the guard (holder released normally) — just
    # acquired it fresh.
    CREATED_LOCK=1
    echo $$ > "$LOCK_DIR/pid"
    release_reclaim_guard
  else
    # Re-read under the guard: this is the load-bearing read the reclaim
    # decision is made from, not the earlier unguarded one.
    LOCK_PID="$(cat "$LOCK_DIR/pid" 2>/dev/null || true)"
    RECLAIM=0
    if [ -n "$LOCK_PID" ]; then
      # Reclaim only a lock whose holder is provably gone.
      pid_alive "$LOCK_PID" || RECLAIM=1
    else
      # No pid file: either a holder mid-acquire (it writes pid right after
      # mkdir), or an acquire that was SIGKILLed/OOM-killed between `mkdir`
      # and the pid write and will NEVER complete — refusing forever would
      # wedge every future run since no pid write is ever coming. Bounded
      # stale check: only treat it as abandoned once the lock dir has sat
      # pid-less past a grace period comfortably longer than a normal
      # acquire-to-pid-write gap, short enough not to mask genuine
      # concurrent (still mid-acquire) holders.
      MTIME="$(lock_dir_mtime "$LOCK_DIR")"
      NOW="$(date +%s)"
      if [ -n "$MTIME" ] && [ $((NOW - MTIME)) -ge $STALE_GRACE_SECS ]; then
        RECLAIM=1
      fi
    fi
    if [ "$RECLAIM" != "1" ]; then
      release_reclaim_guard
      lock_fatal
    fi
    # RECLAIM = ATOMIC RENAME + IDENTITY CHECK. Both halves are required.
    #
    # The rename alone does NOT serialize two racers that read the same dead
    # pid (or the same pid-less stale lock) — that's what the reclaim guard
    # above is for. But the guard only serializes racers that both reach it;
    # after the rename we still check WHAT WE MOVED: the pid inside it (or
    # absence of one) must match what we decided to reclaim under the guard.
    # Anything else means we did not move the corpse we came for — put it
    # back and refuse. The put-back is best-effort by necessity: if it fails
    # the lock is gone and the next run acquires cleanly, the safe direction.
    echo "WARN: reclaiming stale analyze lock (pid ${LOCK_PID:-<none, pid-less past ${STALE_GRACE_SECS}s>})" >&2
    STALE_DIR="$LOCK_DIR.stale.$$"
    mv "$LOCK_DIR" "$STALE_DIR" 2>/dev/null || { release_reclaim_guard; lock_fatal; }
    MOVED_PID="$(cat "$STALE_DIR/pid" 2>/dev/null || true)"
    if [ "$MOVED_PID" != "$LOCK_PID" ]; then
      mv "$STALE_DIR" "$LOCK_DIR" 2>/dev/null || true
      release_reclaim_guard
      lock_fatal
    fi
    rm -rf "$STALE_DIR"
    mkdir "$LOCK_DIR" 2>/dev/null || { release_reclaim_guard; lock_fatal; }
    # CREATED_LOCK is set (and so the already-armed EXIT trap starts releasing
    # the lock) BEFORE the pid write: a failed write — full disk, read-only fs
    # — must not leave the directory behind to wedge every later run. Written
    # under the reclaim guard so a waiting racer sees either "still empty,
    # still within grace" or a live pid — never an empty file it could
    # mistake for an abandoned lock of its own.
    CREATED_LOCK=1
    echo $$ > "$LOCK_DIR/pid"
    release_reclaim_guard
  fi
fi

IGNORE_FILE="$REPO_ROOT/.gitnexusignore"
CREATED_IGNORE=0
# Guard before writing: `>` follows symlinks and could clobber the target of a
# symlink pointing elsewhere on the filesystem. FATAL if $IGNORE_FILE is a
# symlink (-L) or directory (-d). Do NOT prefix with `[ -e ] &&` — `-e` follows
# symlinks and returns FALSE for a BROKEN symlink, short-circuiting past `-L` so
# the check falls through to the write branch below (`[ ! -f ]` is also true for
# a broken symlink, so the elif would `>` through the dangling link, creating or
# overwriting its target — the exact footgun this guard exists to prevent).
# `-L` uses lstat, matching BOTH working and broken symlinks, so it alone is the
# correct symlink test. (Verified empirically: broken symlink → `[ -e ]`=false,
# `[ -L ]`=true, `[ ! -f ]`=true.)
if [ -L "$IGNORE_FILE" ] || [ -d "$IGNORE_FILE" ]; then
  echo "FATAL: $IGNORE_FILE exists as a symlink or directory — refusing to overwrite (remove it manually)" >&2
  exit 1
elif [ ! -f "$IGNORE_FILE" ]; then
  printf '!tests/\n!__tests__/\n!fixtures/\n' > "$IGNORE_FILE"
  CREATED_IGNORE=1
elif ! grep -qE '^!tests/?\*{0,2}\s*$' "$IGNORE_FILE" \
   || ! grep -qE '^!__tests__/?\*{0,2}\s*$' "$IGNORE_FILE" \
   || ! grep -qE '^!fixtures/?\*{0,2}\s*$' "$IGNORE_FILE"; then
  # A pre-existing root .gitnexusignore that doesn't negate tests/__tests__/fixtures
  # leaves gitnexus's DEFAULT_IGNORE_LIST filtering the fixture — AC-1 silently fails.
  # We don't mutate the user's file; warn so the failure mode is diagnosable. NOTE:
  # the three greps can't be one alternation — `grep -E 'a|b|c'` succeeds if ANY
  # pattern matches, so a file negating only `!tests/` (missing `!fixtures/`) would
  # skip the warning even though the fixture symbols still get filtered. The glob
  # suffix `/?\*{0,2}` also accepts `!tests/**` and `!tests/*` — valid gitignore-
  # style globs gitnexus honors alongside the bare `!tests/` form.
  echo "WARN: pre-existing $IGNORE_FILE does not negate tests/fixtures — fixture symbols may not index (AC-1 could fail)" >&2
fi

# `gitnexus analyze` (>= 1.6.10) writes its standard skills as direct children,
# `.claude/skills/gitnexus-<name>/SKILL.md`. The repo tracks them, localized by
# localize_gitnexus_skills below. Two consequences handled here:
#  - analyze PRESERVES any SKILL.md whose bytes differ from its bundled template
#    (upstream #3124), so a localized file would never pick up a CLI upgrade's
#    new template. Move the tracked copies aside first so analyze writes fresh
#    templates; cleanup() restores them if analyze fails.
#  - a run in a root that had no gitnexus-* skill dirs (tests' temp roots) must
#    touch only the dirs THIS run created — never a pre-existing one — and keep
#    the generated skills on success, removing them only on a failed run.
SKILLS_ROOT="$REPO_ROOT/.claude/skills"
GITNEXUS_SKILLS="gitnexus-cli gitnexus-debugging gitnexus-exploring gitnexus-guide gitnexus-impact-analysis gitnexus-refactoring"
CREATED_SKILL_DIRS=""
SKILLS_BACKUP="$LOCK_DIR/skills-backup"
for name in $GITNEXUS_SKILLS; do
  if [ -f "$SKILLS_ROOT/$name/SKILL.md" ]; then
    mkdir -p "$SKILLS_BACKUP/$name"
    mv "$SKILLS_ROOT/$name/SKILL.md" "$SKILLS_BACKUP/$name/SKILL.md"
  elif [ ! -d "$SKILLS_ROOT/$name" ]; then
    CREATED_SKILL_DIRS="$CREATED_SKILL_DIRS $SKILLS_ROOT/$name"
  fi
done

# The version the skill files' package-invocation fallbacks pin to: the index
# contract's expected CLI version — the same pin `contract.test.ts` alarms on —
# so a contract bump (the upgrade ritual's step 4/5) is the ONLY edit needed to
# move the skill pins. Falls back to a literal for the tests' temp roots, where
# tests/gitnexus/gitnexus-cli-contract.json does not exist.
# `|| true`: sed exits 1 on a missing file, and under `set -euo pipefail` the
# bare assignment would abort the script before the fallback below runs —
# exactly what happened in the tests' temp roots (6/6 red, exit 1 right after
# the version echo). Same guard style as the GN_VER capture at the top.
PINNED_CLI_VERSION="$(sed -n 's/.*"expectedCliVersion"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$REPO_ROOT/tests/gitnexus/gitnexus-cli-contract.json" 2>/dev/null | head -1 || true)"
: "${PINNED_CLI_VERSION:=1.6.12}"

# Repo-local edits to the bundled skills: upstream tells agents to run a bare
# `analyze` on a stale index, which skips this repo's transient .gitnexusignore
# negation (see section 2). Point them at this script instead. Idempotent.
localize_gitnexus_skills() {
  local f
  for f in "$SKILLS_ROOT"/gitnexus-*/SKILL.md; do
    [ -f "$f" ] || continue
    perl -pi -e 's{run `node \.gitnexus/run\.cjs analyze` in (the )?terminal( first)?}{run `bash scripts/install-gitnexus-plus.sh` from the project root (never a bare `analyze`)}g' "$f"
    # Same class of upstream instruction: the missing-runner recovery in the
    # gitnexus-cli skill says "(Re)generate it with `npx gitnexus analyze`" — a
    # bare analyze that drops the fixture negation. Rewrite it to this script,
    # keeping the npx forms only as the CLI-itself-missing fallback — pinned to
    # the contract version, never a floating latest (review round: unpinned
    # `npx gitnexus` / `gitnexus@latest` in recovery text invites a CLI newer
    # than the adopted contract into a recovery path). Guarded so the rewrite
    # runs once per file (grep for the replacement's marker).
    if ! grep -q 'Run the repo installer' "$f"; then
      # The pattern is split around \Q so the `@latest` sits outside the
      # quotemeta region (inside \Q..\E an escaped-at still fails to match —
      # measured, not assumed). The `\$VERSION`-spliced @ signs are escaped as
      # \@ in the replacement: unescaped, perl interpolates `@1` (of @1.6.12)
      # as an empty array slice and the pin comes out `.6.12` — measured, not
      # assumed, on the first localization pass with the splice in place.
      perl -0pi -e 's{\Q(Re)generate it with `npx gitnexus analyze` from the project root, or `bunx gitnexus\E\@latest analyze` on a bun-only machine.}{Run the repo installer: `bash scripts/install-gitnexus-plus.sh` from the project root (analyze-only: `GITNEXUS_SKIP_INSTALL=1 bash scripts/install-gitnexus-plus.sh`). It rebuilds the index AND the runner while keeping this repo'"'"'s transient `.gitnexusignore` negation. Only when the installer reports the `gitnexus` CLI itself missing: (Re)generate the runner with `npx gitnexus\@'"$PINNED_CLI_VERSION"' analyze` from the project root, or `bunx gitnexus\@'"$PINNED_CLI_VERSION"' analyze` on a bun-only machine — pinned to this repo'"'"'s index-contract version (`tests/gitnexus/gitnexus-cli-contract.json`), never a floating `latest`.}g' "$f"
    fi
    # Pin the REMAINING package invocations the rewrites above don't touch: the
    # npm-11.x fallback sentence's `@latest` tags, the `npm i -g gitnexus`
    # install (pinned at install time — `(then `gitnexus analyze`)` is the
    # installed binary and stays bare), and the impact-analysis missing-runner
    # note's bare `npx gitnexus`. Idempotent without a guard: after the rewrite
    # the patterns no longer match. Same \@ escaping as above.
    perl -pi -e 's{gitnexus\@latest}{gitnexus\@'"$PINNED_CLI_VERSION"'}g; s{`npx gitnexus`}{`npx gitnexus\@'"$PINNED_CLI_VERSION"'`}g; s{`npm i -g gitnexus`}{`npm i -g gitnexus\@'"$PINNED_CLI_VERSION"'`}g' "$f"
    # Review round: the impact-analysis workflow's step 0 gains the CLI
    # repository-binding fallback and step 2 the CLI impact-response path (use
    # affected_processes/affected_modules only on a RESOLVED target). Scoped to
    # this one skill by the loop's own per-file iteration + these lines being
    # absent from the other five templates. Idempotent: neither pattern matches
    # its own replacement (non-whitespace text now sits between `{}` / the
    # resource URI and the arrow).
    case "$f" in
      */gitnexus-impact-analysis/SKILL.md)
        perl -pi -e 's{^0\. list_repos \{\}\s+→ Bind repo \(and worktree\)$}{0. list_repos {} (CLI fallback: `node .gitnexus/run.cjs list`)  → Bind repo (and worktree)}m' "$f"
        perl -pi -e 's{^2\. READ gitnexus://repo/\{name\}/processes\s+→ Check affected execution flows$}{2. READ gitnexus://repo/\{name\}/processes — or, on the CLI impact payload, `affected_processes` / `affected_modules`, but ONLY once the target resolved: an ambiguous target prints ranked candidates instead of an impact result, so disambiguate (file_path/kind/uid) before trusting those fields}m' "$f"
        ;;
    esac
  done
  f="$SKILLS_ROOT/gitnexus-cli/SKILL.md"
  if [ -f "$f" ] && ! grep -q 'QDS-Factory reindex rule' "$f"; then
    perl -0pi -e 's{(# GitNexus CLI Commands\n)}{$1\n> **QDS-Factory reindex rule:** build or refresh this repo'"'"'s index only with `bash scripts/install-gitnexus-plus.sh` (analyze-only: `GITNEXUS_SKIP_INSTALL=1 bash scripts/install-gitnexus-plus.sh`). A bare `analyze` skips the transient `.gitnexusignore` negation and drops `tests/gitnexus/fixtures/` from the graph. The `analyze` commands below are upstream reference only.\n}' "$f"
  fi
}

# --embeddings: the semantic query path (gitnexus_query) needs vector search to
# return definitions for a small graph; pure BM25 misses symbol-name-only hits.
# --skip-agents-md: don't mutate AGENTS.md/CLAUDE.md (out of story scope).
# 600s timeout per story guard (large-repo cap). Prefer GNU `timeout` / macOS
# `gtimeout` when present (clean kill + exit code); fall back to the portable
# `perl` alarm when neither is on PATH. `--kill-after=15` force-sends SIGKILL if
# the analyze hasn't exited 15s after the SIGTERM at the 600s mark — bounds a
# SIGTERM-trapping/ignoring `gitnexus analyze` instead of hanging CI forever.
#
# Was 300s, raised 2026-09-08. That cap was measured on the no-embeddings path,
# which is the ONLY path this repo had ever taken — the arch guard below was
# misreading a Rosetta'd bash and dropping --embeddings on every run. With the
# vector path restored, a full `--force --embeddings` analyze of this repo
# (17,680 nodes / 35,734 edges) measures ~390s, so 300s aborted mid-write every
# time. The cap exists to stop a hung analyze, not to bound a working one.
# Fail loudly if NO timeout provider is available instead of letting the perl
# fallback expand to `perl: command not found` (exit 127) under `set -e`.
if ! command -v timeout >/dev/null 2>&1 \
   && ! command -v gtimeout >/dev/null 2>&1 \
   && ! command -v perl >/dev/null 2>&1; then
  echo "FATAL: no timeout provider found (need timeout, gtimeout, or perl on PATH)" >&2
  exit 1
fi

if command -v timeout >/dev/null 2>&1; then
  TIMEOUT=(timeout --kill-after=15 600)
elif command -v gtimeout >/dev/null 2>&1; then
  TIMEOUT=(gtimeout --kill-after=15 600)
else
  # ponytail: perl alarm fires SIGALRM at 600s but no SIGKILL follow-up, and it
  # kills only the wrapper — `gitnexus` re-execs node as a CHILD, so an aborted
  # run leaves that child still writing the graph (observed 2026-09-08: wrapper
  # died at the cap, child ran on ~90s and finished a clean index anyway).
  # Install timeout/gtimeout for a SIGTERM-trapping gitnexus; they kill the
  # process group. Upgrade path if this branch ever matters: `perl -e 'setpgrp;
  # alarm N; ...'` plus a `kill -- -$$` trap.
  TIMEOUT=(perl -e 'alarm 600; exec @ARGV')
fi
# --embeddings aborts the whole analyze on macOS Intel: onnxruntime-node ships no
# darwin/x64 native binding, and the failure is at native-import time, so neither
# ONNX_WEB_BACKEND=wasm nor GITNEXUS_EMBEDDING_DEVICE avoids it (#74). Dropping
# the flag there degrades gitnexus_query to BM25-only — worse for symbol-name-only
# hits, but a degraded index beats no reindex path at all. tests/gitnexus passes
# either way (16/16 verified without embeddings), so nothing this repo asserts
# depends on the vector path.
#
# Deliberately a plain string, not an array: stock macOS bash is 3.2, where
# `"${EMPTY[@]}"` under `set -u` aborts with "unbound variable" — which would
# break the exact platform this branch exists to unbreak. The value never
# contains whitespace, so unquoted word-splitting to zero args is safe here.
# `uname -m` reports the PROCESS arch, not the MACHINE arch, and under Rosetta the two
# differ. An x86_64-only bash earlier on PATH (a /usr/local Homebrew bash on an Apple
# Silicon Mac is the common case) makes `uname -m` answer x86_64 inside this script while
# the machine is arm64 and node/onnxruntime are arm64 native — so the guard fired on
# hardware it was never meant to cover and silently degraded every index to BM25-only.
# `hw.optional.arm64` is the machine fact and is Rosetta-proof: it reads 1 on Apple
# Silicon whether or not the calling process is translated. Require BOTH — a translated
# process on real Apple Silicon is not an Intel Mac.
EMBEDDINGS_FLAG="--embeddings"
if [ "$(uname -s)" = "Darwin" ] &&
   [ "$(uname -m)" = "x86_64" ] &&
   [ "$(sysctl -n hw.optional.arm64 2>/dev/null || echo 0)" != "1" ]; then
  EMBEDDINGS_FLAG=""
  echo "WARN: macOS Intel (darwin/x64) detected — running analyze WITHOUT --embeddings." >&2
  echo "      onnxruntime-node has no darwin/x64 binding, so --embeddings aborts the analyze (#74)." >&2
  echo "      The graph will be BM25-only: gitnexus_query may miss symbol-name-only hits." >&2
fi

echo "Running gitnexus analyze (${EMBEDDINGS_FLAG:-no embeddings}, 300s cap) ..."
# shellcheck disable=SC2086  # intentional split: empty EMBEDDINGS_FLAG must vanish
"${TIMEOUT[@]}" \
  "$GITNEXUS" analyze "$REPO_ROOT" --force $EMBEDDINGS_FLAG --skip-agents-md
# ANALYZE_OK gates cleanup's restore-vs-keep decision for the skill backups, so
# it is set only AFTER localize succeeds: a localize failure under `set -e`
# must restore the tracked SKILL.md files, not delete their backups.
localize_gitnexus_skills
# 1.6.12 does not always emit the bundled skills on a successful analyze
# (observed 2026-10-26: analyze green, skill dirs left empty, and the
# success-path cleanup then deleted the only copies with the lock dir). Any
# backup file whose destination is still missing comes back from the backup;
# its bytes are the pre-analyze localized versions.
for name in $GITNEXUS_SKILLS; do
  if [ -f "$SKILLS_BACKUP/$name/SKILL.md" ] && [ ! -f "$SKILLS_ROOT/$name/SKILL.md" ]; then
    mv "$SKILLS_BACKUP/$name/SKILL.md" "$SKILLS_ROOT/$name/SKILL.md"
  fi
done
ANALYZE_OK=1

# --- 3. Version stamp + contract pin check ----------------------------------
# Version visibility: every reindex records which CLI built the index and
# whether it matches the version the contract suite pins. .gitnexus/ is
# gitignored — this stamp is runtime evidence, not a committed record. The
# committed pin is tests/gitnexus/gitnexus-cli-contract.json; bump it only via
# the AGENTS.md upgrade ritual (bump -> reindex -> contract suite -> review).
EXPECTED_GN_VER=""
CONTRACT_JSON="$REPO_ROOT/tests/gitnexus/gitnexus-cli-contract.json"
if [ -f "$CONTRACT_JSON" ]; then
  EXPECTED_GN_VER="$(sed -n 's/.*"expectedCliVersion": *"\([^"]*\)".*/\1/p' "$CONTRACT_JSON" | head -1)"
fi
if [ -d "$REPO_ROOT/.gitnexus" ]; then
  # Write-then-rename: a killed run never leaves a torn stamp behind.
  STAMP_TMP="$REPO_ROOT/.gitnexus/.cli-version.json.tmp"
  if printf '{\n  "installedCliVersion": "%s",\n  "expectedCliVersion": "%s",\n  "indexedAt": "%s",\n  "indexedHead": "%s"\n}\n' \
      "${GN_VER:-unknown}" "${EXPECTED_GN_VER:-unpinned}" \
      "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$(git rev-parse HEAD 2>/dev/null || echo unknown)" \
      > "$STAMP_TMP"; then
    mv "$STAMP_TMP" "$REPO_ROOT/.gitnexus/cli-version.json"
    echo "version stamp: .gitnexus/cli-version.json (installed ${GN_VER:-unknown}, pinned ${EXPECTED_GN_VER:-unpinned})"
  else
    echo "WARN: could not write .gitnexus/cli-version.json (non-fatal)" >&2
  fi
fi
if [ -n "$EXPECTED_GN_VER" ] && [ -n "${GN_VER:-}" ] && [ "$GN_VER" != "$EXPECTED_GN_VER" ]; then
  echo "WARN: installed gitnexus ($GN_VER) != pinned contract version ($EXPECTED_GN_VER)." >&2
  echo "      tests/gitnexus/contract.test.ts will FAIL until the pin is bumped deliberately" >&2
  echo "      (AGENTS.md upgrade ritual: bump -> reindex -> contract suite -> review diff)." >&2
fi

# --- 4. Report graph stats ----------------------------------------------------
echo "--- graph status ---"
# Status is just reporting — a locked graph DB or slow read shouldn't fail CI.
# 30s cap with the same portable resolver; non-fatal on timeout/error.
if command -v timeout >/dev/null 2>&1; then
  STATUS_TO=(timeout --kill-after=10 30)
elif command -v gtimeout >/dev/null 2>&1; then
  STATUS_TO=(gtimeout --kill-after=10 30)
else
  STATUS_TO=(perl -e 'alarm 30; exec @ARGV')
fi
"${STATUS_TO[@]}" "$GITNEXUS" status || echo "WARN: gitnexus status timed out or failed (non-fatal)" >&2
echo "install-gitnexus-plus: done."
