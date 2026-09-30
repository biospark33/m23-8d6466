#!/usr/bin/env bash
# Recreate the SC2 live-round swarmclaw worktree.
#
# tests/fleet/e2e/sc2-harness.ts spawns the round's daemon through
# `<worktree>/node_modules/.bin/tsx` with `cwd: worktree` (SWARM_WORKTREE,
# SC2_SWARM_WORKTREE-overridable). That worktree is a build artifact of the
# ROUND, not of the repo: PR cleanup legitimately deletes worktrees, so every
# live round bootstraps from this script instead of assuming the tree exists.
# The harness's spawnDaemon guard names this script when the tree is missing.
#
# usage: scripts/bootstrap-sc2-live-worktree.sh
#
# Idempotent: an existing worktree is left exactly as found (never clobber a
# tree a round may be mid-flight in); only a MISSING tree is created, and
# `npm ci` runs only when the tsx binary is absent.
set -euo pipefail

CLONE="${SC2_SWARM_CLONE:-/Users/steve/swarmclaw}"
WORKTREE="${SC2_SWARM_WORKTREE:-/Users/steve/swarmclaw-worktrees/sc2-live}"
REMOTE="${SC2_SWARM_REMOTE:-biospark33}"
BRANCH="${SC2_SWARM_BRANCH:-dev}" # the fork's integration branch (PR #682 = cb2e1ca3 landed here)

if [ ! -d "$CLONE/.git" ]; then
  echo "swarmclaw clone missing: $CLONE" >&2
  exit 1
fi

echo "fetching $REMOTE/$BRANCH in $CLONE …"
git -C "$CLONE" fetch "$REMOTE" "$BRANCH" >/dev/null
TIP="$(git -C "$CLONE" rev-parse "$REMOTE/$BRANCH")"

if [ -d "$WORKTREE/.git" ] || [ -f "$WORKTREE/.git" ]; then
  echo "worktree already exists at $WORKTREE — leaving it untouched (HEAD $(git -C "$WORKTREE" rev-parse --short HEAD))"
else
  echo "creating worktree $WORKTREE at $REMOTE/$BRANCH ($TIP) …"
  git -C "$CLONE" worktree add --detach "$WORKTREE" "$TIP" >/dev/null
fi

if [ -x "$WORKTREE/node_modules/.bin/tsx" ]; then
  echo "tsx already installed in $WORKTREE"
else
  echo "installing dependencies in $WORKTREE (npm ci — a few minutes, once per bootstrap) …"
  (cd "$WORKTREE" && npm ci --no-audit --no-fund >/dev/null)
fi

"$WORKTREE/node_modules/.bin/tsx" --version >/dev/null
echo "OK: $WORKTREE at $(git -C "$WORKTREE" rev-parse --short HEAD), tsx present"
