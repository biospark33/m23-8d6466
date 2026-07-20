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

EXT_VERSION="0.7.0"
EXT="npm:pi-gitnexus-plus@${EXT_VERSION}"

# Repo root = git toplevel. Resolving via BASH_SOURCE breaks when the script is
# invoked through a symlink or from elsewhere (dirname can collapse to `/`,
# which would hand `gitnexus analyze` the whole filesystem). `git rev-parse`
# always returns the real repo root regardless of how we were invoked.
REPO_ROOT="$(git rev-parse --show-toplevel)"
cd "$REPO_ROOT"

# gitnexus ships at a non-standard path on this host (~/.local/node-arm64/bin,
# not /usr/local/bin the story assumed). Resolve it robustly.
GITNEXUS="$(command -v gitnexus || true)"
if [ -z "$GITNEXUS" ] && [ -x "$HOME/.local/node-arm64/bin/gitnexus" ]; then
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
  if pi list 2>/dev/null | grep -q "pi-gitnexus-plus"; then
    echo "pi-gitnexus-plus already installed — skipping install."
  else
    echo "Installing $EXT ..."
    # </dev/null: never block on an interactive prompt in CI.
    pi install "$EXT" < /dev/null
  fi
  # Pin the version too — a stale older listing shouldn't pass a pinned install.
  pi list 2>/dev/null | grep -q "pi-gitnexus-plus@${EXT_VERSION}" || {
    echo "FATAL: pi-gitnexus-plus@${EXT_VERSION} not listed after install" >&2
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
fi

# `gitnexus analyze` auto-writes repo skill files under .claude/skills/gitnexus/.
# The repo may already ship a tracked skills dir there, so we snapshot existence
# before the analyze and only remove what THIS run created — never clobber a
# pre-existing dir on every run.
SKILLS_DIR="$REPO_ROOT/.claude/skills/gitnexus"
CREATED_SKILLS=0
if [ ! -d "$SKILLS_DIR" ]; then CREATED_SKILLS=1; fi

cleanup() {
  rc=$?
  [ "$CREATED_IGNORE" = "1" ] && rm -f "$IGNORE_FILE"
  [ "$CREATED_SKILLS" = "1" ] && rm -rf "$SKILLS_DIR"
  exit "$rc"
}
trap cleanup EXIT INT TERM

# --embeddings: the semantic query path (gitnexus_query) needs vector search to
# return definitions for a small graph; pure BM25 misses symbol-name-only hits.
# --skip-agents-md: don't mutate AGENTS.md/CLAUDE.md (out of story scope).
# 300s timeout per story guard (large-repo cap). Prefer GNU `timeout` / macOS
# `gtimeout` when present (clean kill + exit code); fall back to the portable
# `perl` alarm when neither is on PATH.
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
