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

# Repo root = git toplevel of this script's location. gitnexus analyze needs
# the real repo root (not the fixtures subdir) so file paths stay repo-relative
# and the negated `.gitnexusignore` (see below) resolves ancestor segments.
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
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
if [ "${GITNEXUS_SKIP_INSTALL:-0}" != "1" ]; then
  if pi list 2>/dev/null | grep -q "pi-gitnexus-plus"; then
    echo "pi-gitnexus-plus already installed — skipping install."
  else
    echo "Installing $EXT ..."
    pi install "$EXT"
  fi
fi
pi list 2>/dev/null | grep -A1 "pi-gitnexus-plus" || {
  echo "FATAL: pi-gitnexus-plus not listed after install" >&2
  exit 1
}

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
cleanup() {
  [ "$CREATED_IGNORE" = "1" ] && rm -f "$IGNORE_FILE"
  # `gitnexus analyze` auto-writes repo skill files under .claude/skills/gitnexus/.
  # Those are a tool side-effect, not a story deliverable — drop them so the
  # working tree stays clean. (.gitnexus/ graph db is already gitignored.)
  rm -rf "$REPO_ROOT/.claude/skills/gitnexus"
}
trap cleanup EXIT

# --embeddings: the semantic query path (gitnexus_query) needs vector search to
# return definitions for a small graph; pure BM25 misses symbol-name-only hits.
# --skip-agents-md: don't mutate AGENTS.md/CLAUDE.md (out of story scope).
# 300s timeout per story guard (large-repo cap). `perl` alarm = portable timeout.
echo "Running gitnexus analyze (--embeddings, 300s cap) ..."
perl -e 'alarm 300; exec @ARGV' \
  "$GITNEXUS" analyze "$REPO_ROOT" --force --embeddings --skip-agents-md

# --- 3. Report graph stats ----------------------------------------------------
echo "--- graph status ---"
"$GITNEXUS" status
echo "install-gitnexus-plus: done."
