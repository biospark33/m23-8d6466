# P1.19: Dev manager dispatches a Pi Pair to address a bot review comment; the PR returns GREEN

**Story Points:** 4

## Spec Reference

- PRD §6.2 (Manager — Hermes), §6.6 (Comms), §6.7 (Accountability & yield); FR-CM-5 (outbound status/digest unified through Paperclip), FR-MG-4 (manager launches Archon run + consumes SSE), FR-OR-6 (pause/resume — re-dispatch is a clean resume, never partial state)
- Supporting: FR-EX-6 (lead merges to one JSON node output), FR-OR-7/NFR-OBS-1/OBS-3 (SSE run-log capture + issue-id correlation), NFR-COST-1 (≥1 `cost_events` per run), NFR-SEC-1/SEC-2 (no hardcoded secret; Paperclip bearer + run-scoped header)
- Phase exit gate: PRD §13 Phase-1 — the lights-out comment→fix→green loop closes on a real PR (the most compelling demo: an addressed bot comment + a green PR status)

## User Story

As a **Dev manager (Hermes)** running the lights-out factory,
I want **to dispatch a Pi Pair that reads a detected bot review comment, pushes a fix for it, and verifies the PR returns GREEN**,
so that **the operator's hands-off comment→fix→green loop closes on a real PR without human intervention (G2 autonomous correction; G1 accountability).**

## Overview

This slice cuts through Hermes → Archon (`POST /api/workflows/qds-piv-loop/run` re-dispatch + `GET /api/stream/__dashboard__` SSE) → the Pi-team implement node (Pair archetype) → GitHub PR. The Dev manager takes the bot review comment **already detected and persisted by P1.18** (comment id + body + file/line + PR/branch), re-dispatches the implement node with that comment text as the `--task` input against the PR's worktree branch, the Pi Pair reads+addresses it and pushes a commit, and the manager then **verifies the PR moved to GREEN**: the addressed comment is resolved/outdated AND the bot/CI combined status returns `success`. It is one atomic 4-pt unit because reusing the implement-node + SSE-drive substrate (P1.6/P1.8) and the Pair archetype (P1.5), this story adds only the comment→task adapter, the push step, and the green-verification poll — the loop is not real until a pushed fix flips a live PR's status to green, so none of those parts can split off without leaving the loop open.

## E2E Slice

**Demonstrable behavior:** Given a real PR carrying a detected bot review comment (from P1.18), the Dev manager re-dispatches the `qds-piv-loop` implement node (Pair) with the comment body as the task; the Pi Pair pushes a fix commit to the PR branch; the manager then polls GitHub and observes the PR is GREEN — the addressed review comment is `resolved`/`outdated` AND `GET /repos/{o}/{r}/commits/{sha}/status` (combined) returns `state:"success"`. A `cost_events` row is written for the fix run and the SSE run-log (correlated to the issue id) captures the loop.

**Wiring closed:** On completion of this story, dispatching a Pi Pair against a detected bot comment produces **a pushed fix commit on the PR branch, the addressed comment marked resolved/outdated, and the PR's combined status `success` (GREEN)** — all verified by the manager against the live GitHub API — using only code merged by this story (the comment→task adapter, the re-dispatch call, the push step, and the green-verification poll). No stub, no `TODO: wire later`, and no sibling story is required to make this behavior real. Predecessors, if any, are dependency edges (listed below), not unfinished wiring inside this story.

**Dependency edges (predecessors):** P1.18 (bot review comment detected + persisted: comment id/body/file-line/PR-number/head-branch available for re-dispatch). P1.6 (Pi-team implement bash node emits one structured JSON result + `cost_events`). P1.8 (Dev manager drives the Archon run and captures the issue-correlated SSE run-log). P1.5 (`qds-model-router` selects the Pair archetype + per-role model tier).

## Acceptance Criteria

> ≥3 scenarios, Given/When/Then. Exactly one tagged (make-or-break) and binary.

1. **(make-or-break)** Given a real PR with a detected bot review comment (from P1.18), When the Dev manager re-dispatches the implement node (Pair) with that comment as the task, the Pair pushes a fix commit to the PR branch, and the manager verifies the PR, Then the addressed review comment is `resolved` or `outdated` **AND** `GET /repos/{o}/{r}/commits/{headSha}/status` returns `state === "success"` — i.e. the comment→fix→green loop provably closed on a live PR. (Binary: comment not-open AND combined status `success`.)
2. Given the fix run incurs LLM spend, When the implement node completes, Then ≥1 `cost_events` row exists for the re-dispatch run with `issueId` FK set + `costCents` a non-negative integer, and the SSE run-log (P1.8) captures the run correlated to that issue id (NFR-COST-1/OBS-1/OBS-3).
3. Given the Pair pushes a commit but the PR status stays RED (combined status `failure`/`pending` after the verification timeout, or the comment stays `open`), When the manager verifies, Then it does NOT report the loop closed — it records the run as not-green (`exit_class:"logic"` / un-resolved) and surfaces the unresolved comment, never marking a still-red PR green (guard fires, never a silent green).

## Technical Notes

- **Contracts/Schema (JSON/TS):** Comment→task adapter input (consumes the P1.18-persisted record): `{ prNumber: number, headBranch: string, headSha: string, commentId: number, commentBody: string, path: string, line: number|null }`. Verification result: `{ commentState: "resolved"|"outdated"|"open", combinedStatus: "success"|"failure"|"pending", green: boolean }` where `green === (commentState !== "open" && combinedStatus === "success")`. Backward-compatible: re-dispatch is a normal `qds-piv-loop` run — no schema change to the implement node's merged output (FR-EX-6 shape reused verbatim).
- **Integration points (each wired & exercised in this story):** (1) read the P1.18-persisted bot comment → build the `--task` from `commentBody` + `path:line`; (2) re-dispatch via `POST /api/workflows/qds-piv-loop/run` consumed through the P1.8 SSE-drive (issue-id correlated run-log, FR-MG-4); (3) the Pi Pair pushes a fix commit to `headBranch` (git push from the run's worktree, FR-OR-5); (4) green-verification against GitHub REST: `PATCH`/GraphQL `resolveReviewThread` (mark thread resolved) or detect `outdated`, plus `GET /repos/{o}/{r}/commits/{headSha}/status` (combined CI/bot status); (5) ≥1 `cost_events` row for the run (P1.6 emitter reused).
- **Files / functions touched:** `src/hermes/comment-fix-dispatcher.ts` (comment→task adapter + re-dispatch), `src/hermes/pr-green-verifier.ts` (resolve-thread + combined-status poll → `green` boolean), `src/hermes/github-client.ts` (authed GitHub REST/GraphQL calls), reuses `src/hermes/run-driver.ts` (P1.8) + `archon-workflows/qds-piv-loop/implement-node.sh` (P1.6).
- **Guards/limits:** the green-verification poll is bounded (wall-clock cap, then reports not-green per AC-3 — never an unbounded wait, NFR-SAF-3); re-dispatch counts toward the issue's ≤8-retry / ≤1h cap (NFR-SAF-2); `--wall-clock-cap-ms ≤` the bash node `timeout` (reused P1.6 guard).

## Files to Modify

> ≤10 unique paths.

- `src/hermes/comment-fix-dispatcher.ts`
- `src/hermes/pr-green-verifier.ts`
- `src/hermes/github-client.ts`
- `archon-workflows/qds-piv-loop/implement-node.sh`
- `tests/hermes/comment-fix-dispatcher.test.ts`
- `tests/hermes/pr-green-verifier.test.ts`
- `tests/hermes/pi-pair-fix-green.e2e.test.ts`

## Security Invariants

> Triggers: input/file (untrusted bot-comment body becomes task input + the fix touches files), auth (GitHub token + Paperclip bearer).

- **INV-1 (input — untrusted comment body):** the detected bot-comment `commentBody` is treated as **untrusted data**, not as a privileged instruction — it is passed only as the implement node's `--task` payload (data), never interpolated into a shell command, the launcher flag list, or an env value; a comment containing shell metacharacters/prompt-injection text cannot escape the task slot to alter caps, role-model, or the worktree path.
- **INV-2 (file — fix scope):** the Pi Pair's fix is committed only onto the detected PR's `headBranch` within the run's isolated worktree (FR-OR-5); the push targets that branch and SHA — it cannot push to `main`/a default branch or to a branch outside the run's worktree (no cross-branch write).
- **INV-3 (auth — GitHub):** all GitHub REST/GraphQL calls (resolve-thread, combined-status, push) send `Authorization: Bearer <GITHUB_TOKEN>` read from env/secret refs only (NFR-SEC-1); the token is never written to the task payload, the merged JSON node output, `cost_events`, the SSE run-log, or stdout.
- **INV-4 (auth — Paperclip):** the re-dispatch run-start and `cost_events` write use the per-agent `PAPERCLIP_API_KEY` + `PAPERCLIP_RUN_ID` run-scoped header (NFR-SEC-2, `adapters/registry.ts:468-469`); an agent reports only its OWN `agentId` (`costs.ts:77-80`) — no off-ledger or impersonated spend.
- **INV-5 (no false green):** the PR is reported GREEN only when the live GitHub combined status is `success` AND the addressed comment is `resolved`/`outdated`; there is no code path that marks the loop closed on a stale/cached status or on push-success alone (the lights-out trust guarantee).

## Definition of Done

> 8–12 high-signal, story-specific boxes.

- [ ] **Impl:** the comment→task adapter reads the P1.18-persisted bot comment and builds the implement-node `--task` from `commentBody` + `path:line`.
- [ ] **Impl:** the Dev manager re-dispatches `qds-piv-loop` (Pair archetype, P1.5) via `POST /api/workflows/qds-piv-loop/run`, consumed through the P1.8 SSE-drive (issue-id correlated run-log).
- [ ] **Impl:** the Pi Pair pushes a fix commit to the detected PR `headBranch` from the run's isolated worktree (FR-OR-5).
- [ ] **Impl:** the green-verifier marks the review thread resolved (or detects `outdated`) and polls `GET /repos/{o}/{r}/commits/{headSha}/status` for combined `state`.
- [ ] **Contract:** the comment→task input record and the verification result (`commentState`/`combinedStatus`/`green`) are field-validated; `green === (commentState!=="open" && combinedStatus==="success")`.
- [ ] **Integration:** the loop is wired end-to-end — detected comment → re-dispatch → push → green-verify — exercised on a live PR, not stubbed; reuses P1.6 implement node + P1.8 run-driver unchanged.
- [ ] **Observability/Audit:** ≥1 `cost_events` row for the re-dispatch run (`issueId` FK + non-negative `costCents`); the SSE run-log captures the run correlated to the issue id (NFR-COST-1/OBS-1/OBS-3).
- [ ] **Security:** INV-1 (comment body is data-only, no shell/flag escape), INV-3 (GitHub token env-sourced, never emitted), and INV-5 (no false green) each enforced and tested.
- [ ] **Test (unit/integration):** covers the comment→task adapter, the push-to-headBranch scoping (INV-2), and the still-RED not-green path (AC-3) including the bounded-poll timeout.
- [ ] **Test (e2e demo — MANDATORY):** fires AC-1 on a real PR with a detected bot comment — re-dispatch the Pair, push a fix, then assert the addressed comment is `resolved`/`outdated` AND `commits/{headSha}/status` is `state:"success"` (the loop closed GREEN); proves the lights-out comment→fix→green workflow with wiring closed.

## Dev Agent Record

<!-- Empty placeholder — filled during development. -->
