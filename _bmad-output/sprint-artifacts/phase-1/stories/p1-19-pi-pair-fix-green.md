# P1.19: Pi Pair Addresses Review Comment → Push Fix → PR Green

**Story Points:** 4

## Spec Reference

- PRD §8, §9; FR-CM-5, FR-MG-4

## User Story

As a QDS platform operator,
I want the system to automatically dispatch a Pi Pair team to address bot review comments, push fixes, and get the PR green,
so that the full automated development cycle closes without human intervention.

## Overview

This is the loop-closing story that proves the full automated cycle. After a bot review comment is detected (P1.18), the dev manager dispatches a Pi Pair — a 2-agent team (lead + implementer) — via A2A delegation. The Pi Pair reads the bot review comment, determines the required fix, implements the change, and pushes to the PR branch. The PR then moves to green (CI checks pass). This closes the lights-out loop: comment detected → fix dispatched → fix implemented → PR green. No human intervention required. This story validates that the entire QDS-Factory pipeline operates as a self-contained development cycle.

## E2E Slice

**Demonstrable behavior:** Given a PR with a bot review comment (from P1.18), SwarmClaw's dev manager dispatches a Pi Pair via A2A delegation to `/api/a2a`. The Pi Pair (lead agent analyzes the comment, implementer agent writes the fix) runs inside Warren. The fix is pushed to the PR branch. CI checks on the PR pass (green). The protocol advances to summarize.

**Wiring closed:** On completion of this story, a bot review comment on a SwarmClaw-produced PR triggers an automated fix cycle that results in the PR turning green, using only code merged by this story. No stub, no `TODO: wire later`, and no sibling story is required to make this behavior real. Predecessors (P1.18) are dependency edges, not unfinished wiring inside this story.

**Dependency edges (predecessors):** P1.18

## Acceptance Criteria

1. **(make-or-break)** Given a PR in "review_feedback_detected" state with ≥1 bot review comment, When the dev manager dispatches a Pi Pair via A2A delegation, Then the Pi Pair runs inside Warren, reads the comment, implements a fix, and pushes to the PR branch.
2. Given the Pi Pair has pushed the fix, When CI checks run on the PR, Then the PR reaches green status (all required checks pass).
3. Given the PR is green after the fix, When SwarmClaw receives the CI status webhook, Then the protocol advances to the summarize phase and the run reaches a terminal success state.
4. Given the Pi Pair fails to produce a passing fix within the retry limit (max 2 attempts), When the retry budget is exhausted, Then the protocol records a failure with diagnostic output (error log, diff attempted, CI failure messages).

## Technical Notes

- **Contracts/Schema:** A2A delegation request: `{ jsonrpc: "2.0", method: "a2a_delegate", params: { runId: string, task_type: "fix_review_comment", bot_comments: BotComment[], archetype: "pi-pair", agents: [{ role: "lead", model_tier: "sonnet" }, { role: "implementer", model_tier: "sonnet" }] }, id: string }`. Pi Pair lead reads comment, creates fix plan; implementer writes code. Push to branch `qds/{runId}` (same branch). CI webhook: standard GitHub `status` or `check_suite` event.
- **Integration points:** SwarmClaw dev manager → A2A delegation to `/api/a2a` → CLI-Anything → `warren run --team pi-pair` → Pi agents (lead + implementer) → git push to PR branch → GitHub CI → status webhook → SwarmClaw `/api/webhooks/[id]` → protocol summarize.
- **Files / functions touched:** `src/swarmclaw/phases/fix-dispatch.ts` (Pi Pair dispatch logic), `src/swarmclaw/routes/a2a.ts` (a2a_delegate handler), `src/cli-anything/runner.ts` (warren run with pi-pair archetype), `src/swarmclaw/routes/webhooks.ts` (CI status webhook handler), `src/swarmclaw/protocol.ts` (state transitions: review_feedback_detected → fixing → green → summarize).
- **Guards/limits:** Max 2 fix attempts per PR. Each attempt has a 15-minute timeout. Push to the same branch (not a new branch). CI check must be a required check (non-required checks ignored). Protocol state tracks attempt count and last error.

## Files to Modify

- `src/swarmclaw/phases/fix-dispatch.ts`
- `src/swarmclaw/routes/a2a.ts`
- `src/cli-anything/runner.ts`
- `src/swarmclaw/routes/webhooks.ts`
- `src/swarmclaw/protocol.ts`

## Security Invariants

- INV-1: Pi Pair agents run in isolated Warren burrows — no host filesystem access beyond the cloned repo.
- INV-2: Fix pushes are scoped to the PR branch only — never to the default branch.
- INV-3: CI status webhook signature is validated before protocol state transition.
- INV-4: Retry budget (max 2) prevents infinite fix loops on irrecoverable failures.

## Definition of Done

- [ ] **Impl:** Fix-dispatch phase that creates A2A delegation for Pi Pair (lead + implementer) with bot comment context.
- [ ] **Impl:** `a2a_delegate` handler in SwarmClaw routes for fix_review_comment task type.
- [ ] **Impl:** CLI-Anything invokes `warren run --team pi-pair` with fix-specific arguments.
- [ ] **Impl:** CI status webhook handler detects green status on PR branch and advances protocol.
- [ ] **Impl:** Retry budget enforcement (max 2 attempts) with failure diagnostics on exhaustion.
- [ ] **Contract:** A2A delegation schema for fix_review_comment validated with agent roles and model tiers.
- [ ] **Integration:** Full loop: bot comment detected → Pi Pair dispatched → fix pushed → CI green → protocol summarize confirmed.
- [ ] **Security:** Fix pushes scoped to PR branch only; CI webhook signature validated.
- [ ] **Test (unit):** Fix-dispatch creates correct A2A delegation payload given bot comment input.
- [ ] **Test (unit):** Retry budget: max 2 attempts, failure recorded with diagnostics on exhaustion.
- [ ] **Test (e2e demo — MANDATORY):** Bot comment on P1.15's PR → Pi Pair dispatched → fix pushed → PR turns green → protocol reaches summarize. Full loop closes with no human intervention.

## Dev Agent Record

<!-- Empty placeholder — filled during development. -->
