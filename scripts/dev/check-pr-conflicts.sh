#!/usr/bin/env bash
# check-pr-conflicts.sh — pre-PR advisory gate (qds-dev Phase 5).
#
# Detects file overlap between this branch's changes and every other OPEN PR,
# so stacked-PR merge conflicts surface before the push instead of at merge
# time (learning D018). Overlapping files are printed with the competing PR
# number; exit is nonzero on overlap unless --warn downgrades it to advisory.
# Tool failures (git diff, gh pr list, gh pr diff) stop the script — a silent
# empty scan would print OK without having checked anything (review round 6);
# --warn softens only confirmed overlap findings, never tool failures.
#
# Usage:
#   scripts/dev/check-pr-conflicts.sh [--base <ref>] [--warn]
#
# Requires: git, gh (authenticated). Exits OK when no other open PRs exist.

set -euo pipefail

BASE="origin/main"
WARN=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --base) BASE="$2"; shift 2 ;;
    --warn) WARN=1; shift ;;
    *) echo "unknown flag: $1" >&2; echo "usage: $0 [--base <ref>] [--warn]" >&2; exit 2 ;;
  esac
done

cd "$(git rev-parse --show-toplevel)"

BRANCH="$(git rev-parse --abbrev-ref HEAD)"
CHANGED="$(git diff --name-only "${BASE}" | sort -u)"
if [[ -n "$CHANGED" ]]; then
  mapfile -t MINE <<< "$CHANGED"
else
  MINE=()
fi

if [[ ${#MINE[@]} -eq 0 ]]; then
  echo "OK: no changed files vs ${BASE}; nothing to check."
  exit 0
fi

OVERLAPS=0

PR_LIST="$(gh pr list --state open --limit 1000 --json number,headRefName --jq '.[] | "\(.number)\t\(.headRefName)"')"
if [[ -n "$PR_LIST" ]]; then
  while IFS=$'\t' read -r number head; do
    [[ -z "${number:-}" ]] && continue
    [[ "$head" == "$BRANCH" ]] && continue  # this branch's own PR
    PR_FILES="$(gh pr diff "$number" --name-only)"
    while IFS= read -r file; do
      [[ -z "$file" ]] && continue
      for mine in "${MINE[@]}"; do
        if [[ "$file" == "$mine" ]]; then
          echo "CONFLICT RISK: ${file} also touched by PR #${number} (${head})"
          OVERLAPS=$((OVERLAPS + 1))
        fi
      done
    done <<< "$PR_FILES"
  done <<< "$PR_LIST"
fi

if [[ $OVERLAPS -gt 0 ]]; then
  echo "FAIL: ${OVERLAPS} overlapping file(s) with open PRs — coordinate or rebase first."
  [[ $WARN -eq 1 ]] && { echo "(--warn: advisory only)"; exit 0; }
  exit 1
fi
echo "OK: no open PR overlaps with ${BRANCH} (${#MINE[@]} changed file(s) vs ${BASE})."
