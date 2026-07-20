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
echo "gitnexus: $GITNEXUS ($("$GITNEXUS" --version))"

# --- 1. Install the extension (idempotent) ------------------------------------
# The verify block lives INSIDE the install guard so GITNEXUS_SKIP_INSTALL=1
# (analyze-only mode, common in CI containers that have `gitnexus` but not
# `pi`) doesn't false-fail on a missing `pi` binary.
if [ "${GITNEXUS_SKIP_INSTALL:-0}" != "1" ]; then
  # Capture `pi list` once and separate its failure (infra) from a missing/wrong
  # version (real). Under `set -o pipefail`, `pi list | grep` aborts the pipeline
  # when `pi list` exits nonzero — capture first, grep the string, so a flaky `pi
  # list` doesn't false-fail a successful install or skip the install branch.
  PI_LIST="$(pi list 2>/dev/null || true)"
  if printf '%s\n' "$PI_LIST" | grep -q "pi-gitnexus-plus"; then
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
  printf '%s\n' "$PI_LIST" | grep -qE "pi-gitnexus-plus@${EXT_VERSION}([^[:alnum:]._+-]|\$)" || {
    if [ -z "$PI_LIST" ]; then
      echo "FATAL: \`pi list\` returned no output — cannot verify install (pi infra error?)" >&2
    else
      echo "FATAL: pi-gitnexus-plus@${EXT_VERSION} not listed after install" >&2
    fi
    exit 1
  }
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
IGNORE_FILE="$REPO_ROOT/.gitnexusignore"
CREATED_IGNORE=0
if [ ! -f "$IGNORE_FILE" ]; then
  printf '!tests/\n!__tests__/\n!fixtures/\n' > "$IGNORE_FILE"
  CREATED_IGNORE=1
elif ! grep -qE '^!(tests/?|__tests__/?|fixtures/?)\s*$' "$IGNORE_FILE"; then
  # A pre-existing root .gitnexusignore that doesn't negate tests//fixtures/ leaves
  # gitnexus's DEFAULT_IGNORE_LIST filtering the fixture — AC-1 silently fails. We
  # don't mutate the user's file; warn so the failure mode is diagnosable.
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
  [ "$CREATED_IGNORE" = "1" ] && rm -f "$IGNORE_FILE"
  [ "$CREATED_SKILLS" = "1" ] && rm -rf "$SKILLS_DIR"
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
# `perl` alarm when neither is on PATH.
# Fail loudly if NO timeout provider is available instead of letting the perl
# fallback expand to `perl: command not found` (exit 127) under `set -e`.
if ! command -v timeout >/dev/null 2>&1 \
   && ! command -v gtimeout >/dev/null 2>&1 \
   && ! command -v perl >/dev/null 2>&1; then
  echo "FATAL: no timeout provider found (need timeout, gtimeout, or perl on PATH)" >&2
  exit 1
fi

if command -v timeout >/dev/null 2>&1; then
  TIMEOUT=(timeout 300)
elif command -v gtimeout >/dev/null 2>&1; then
  TIMEOUT=(gtimeout 300)
else
  TIMEOUT=(perl -e 'alarm 300; exec @ARGV')
fi
echo "Running gitnexus analyze (--embeddings, 300s cap) ..."
"${TIMEOUT[@]}" \
  "$GITNEXUS" analyze "$REPO_ROOT" --force --embeddings --skip-agents-md

# --- 3. Report graph stats ----------------------------------------------------
echo "--- graph status ---"
# Status is just reporting — a locked graph DB or slow read shouldn't fail CI.
# 30s cap with the same portable resolver; non-fatal on timeout/error.
if command -v timeout >/dev/null 2>&1; then
  STATUS_TO=(timeout 30)
elif command -v gtimeout >/dev/null 2>&1; then
  STATUS_TO=(gtimeout 30)
else
  STATUS_TO=(perl -e 'alarm 30; exec @ARGV')
fi
"${STATUS_TO[@]}" "$GITNEXUS" status || echo "WARN: gitnexus status timed out or failed (non-fatal)" >&2
echo "install-gitnexus-plus: done."
