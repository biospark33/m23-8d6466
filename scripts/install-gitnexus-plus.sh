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
# ponytail: transient negation file, not committed — the fixture symbols are the
# only reason we override the safety-net ignore list.
#
# CONCURRENT-RUN HAZARD: two invocations of this script in the same repo
# (parallel CI matrix, overlapping stories) race on the transient root
# `.gitnexusignore` — run A's EXIT trap can `rm` the file while run B is
# mid-analyze, dropping the negations and silently filtering the fixture.
# Worse, `gitnexus analyze --force` running concurrently can corrupt the graph
# DB (no file lock). Concurrent same-repo runs are UNSUPPORTED; no locking is
# added here (out of scope) — serialize across CI matrix shards / stories.
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

# `gitnexus analyze` auto-writes repo skill files under .claude/skills/gitnexus/.
# The repo may already ship a tracked skills dir there, so we snapshot existence
# before the analyze and only remove what THIS run created — never clobber a
# pre-existing dir on every run.
SKILLS_DIR="$REPO_ROOT/.claude/skills/gitnexus"
CREATED_SKILLS=0
if [ ! -d "$SKILLS_DIR" ]; then CREATED_SKILLS=1; fi

cleanup() {
  # `|| true` on both rm's: under `set -e` a failed removal (permissions, read-
  # only fs, busy mount) would abort cleanup before `return 0`, masking the real
  # exit code $rc (set by the EXIT trap) with exit 1 — breaks the "safe to
  # re-run" contract. Suppress so cleanup always reaches `return 0`.
  [ "${CREATED_IGNORE:-0}" = "1" ] && { rm -f "${IGNORE_FILE:-}" 2>/dev/null || true; }
  [ "${CREATED_SKILLS:-0}" = "1" ] && { rm -rf "${SKILLS_DIR:-}" 2>/dev/null || true; }
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

# --embeddings: the semantic query path (gitnexus_query) needs vector search to
# return definitions for a small graph; pure BM25 misses symbol-name-only hits.
# --skip-agents-md: don't mutate AGENTS.md/CLAUDE.md (out of story scope).
# 300s timeout per story guard (large-repo cap). Prefer GNU `timeout` / macOS
# `gtimeout` when present (clean kill + exit code); fall back to the portable
# `perl` alarm when neither is on PATH. `--kill-after=15` force-sends SIGKILL if
# the analyze hasn't exited 15s after the SIGTERM at the 300s mark — bounds a
# SIGTERM-trapping/ignoring `gitnexus analyze` instead of hanging CI forever.
# Fail loudly if NO timeout provider is available instead of letting the perl
# fallback expand to `perl: command not found` (exit 127) under `set -e`.
if ! command -v timeout >/dev/null 2>&1 \
   && ! command -v gtimeout >/dev/null 2>&1 \
   && ! command -v perl >/dev/null 2>&1; then
  echo "FATAL: no timeout provider found (need timeout, gtimeout, or perl on PATH)" >&2
  exit 1
fi

if command -v timeout >/dev/null 2>&1; then
  TIMEOUT=(timeout --kill-after=15 300)
elif command -v gtimeout >/dev/null 2>&1; then
  TIMEOUT=(gtimeout --kill-after=15 300)
else
  # ponytail: perl alarm fires SIGALRM at 300s but no SIGKILL follow-up — install
  # timeout/gtimeout for a SIGTERM-trapping gitnexus (alarm survives execve per
  # POSIX, but a gitnexus that ignores SIGALRM would hang this branch).
  TIMEOUT=(perl -e 'alarm 300; exec @ARGV')
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
EMBEDDINGS_FLAG="--embeddings"
if [ "$(uname -s)" = "Darwin" ] && [ "$(uname -m)" = "x86_64" ]; then
  EMBEDDINGS_FLAG=""
  echo "WARN: macOS Intel (darwin/x64) detected — running analyze WITHOUT --embeddings." >&2
  echo "      onnxruntime-node has no darwin/x64 binding, so --embeddings aborts the analyze (#74)." >&2
  echo "      The graph will be BM25-only: gitnexus_query may miss symbol-name-only hits." >&2
fi

echo "Running gitnexus analyze (${EMBEDDINGS_FLAG:-no embeddings}, 300s cap) ..."
# shellcheck disable=SC2086  # intentional split: empty EMBEDDINGS_FLAG must vanish
"${TIMEOUT[@]}" \
  "$GITNEXUS" analyze "$REPO_ROOT" --force $EMBEDDINGS_FLAG --skip-agents-md

# --- 3. Report graph stats ----------------------------------------------------
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
