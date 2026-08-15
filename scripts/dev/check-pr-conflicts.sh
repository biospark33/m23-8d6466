#!/usr/bin/env bash
# check-pr-conflicts.sh — pre-PR advisory gate (qds-dev Phase 5).
#
# Detects file overlap between this branch's changes and every other OPEN PR,
# so stacked-PR merge conflicts surface before the push instead of at merge
# time (learning D018). Overlapping files are printed with the competing PR
# number; exit is nonzero on overlap unless --warn downgrades it to advisory.
#
# Usage:
#   scripts/dev/check-pr-conflicts.sh [--base <ref>] [--warn]
#
# Requires: git, gh (authenticated). Skips itself when no open PRs exist.

set -euo pipefail

BASE="origin/main"
WARN=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --base) BASE="$2"; shift 2 ;;
    --warn) WARN=1; shift ;;
    *) echo "unknown flag: $1" >&2; exit 2 ;;
  esac
done

cd "$(git rev-parse --show-toplevel)"

BRANCH="$(git rev-parse --abbrev-ref HEAD)"
mapfile -t MINE < <(git diff --name-only "${BASE}" | sort -u || true)

if [[ ${#MINE[@]} -eq 0 ]]; then
  echo "OK: no changed files vs ${BASE}; nothing to check."
  exit 0
fi

declare -A OWNERS
OVERLAPS=0

while IFS=$'\t' read -r number head; do
  [[ "$head" == "$BRANCH" ]] && continue  # this branch's own PR
  while IFS= read -r file; do
    [[ -z "$file" ]] && continue
    for mine in "${MINE[@]}"; do
      if [[ "$file" == "$mine" ]]; then
        echo "CONFLICT RISK: ${file} also touched by PR #${number} (${head})"
        OVERLAPS=$((OVERLAPS + 1))
      fi
    done
  done < <(gh pr diff "$number" --name-only 2>/dev/null || true)
done < <(gh pr list --state open --json number,headRefName --jq '.[] | "\(.number)\t\(.headRefName)"' 2>/dev/null || true)

if [[ $OVERLAPS -gt 0 ]]; then
  echo "FAIL: ${OVERLAPS} overlapping file(s) with open PRs — coordinate or rebase first."
  [[ $WARN -eq 1 ]] && { echo "(--warn: advisory only)"; exit 0; }
  exit 1
fi
echo "OK: no open PR overlaps with ${BRANCH} (${#MINE[@]} changed file(s) vs ${BASE})."
