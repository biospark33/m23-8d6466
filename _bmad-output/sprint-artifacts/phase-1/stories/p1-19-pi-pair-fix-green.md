# P1.19: Dev manager dispatches a Pi Pair to address a bot review comment; the PR returns GREEN

**Story Points:** 4

## Spec Reference

- PRD §6.2 (Manager — Hermes), §6.6 (Comms), §6.7 (Accountability & yield); FR-CM-5 (outbound status/digest unified through Paperclip), FR-MG-4 (manager launches Warren run + consumes SSE), FR-OR-6 (pause/resume — re-dispatch is a clean resume, never partial state)
- Supporting: FR-EX-6 (lead merges to one JSON node output), FR-OR-7/NFR-OBS-1/OBS-3 (SSE run-log capture + issue-id correlation), NFR-COST-1 (≥1 `cost_events` per run), NFR-SEC-1/SEC-2 (no hardcoded secret; Paperclip bearer + run-scoped header)
- Phase exit gate: PRD §13 Phase-1 — the lights-out comment→fix→green loop closes on a real PR (the most compelling demo: an addressed bot comment + a green PR status)

## User Story

As a **Dev manager (Hermes)** running the lights-out factory,
I want **to dispatch a Pi Pair that reads a detected bot review comment, pushes a fix for it, and verifies the PR returns GREEN**,
so that **the operator's hands-off comment→fix→green loop closes on a real PR without human intervention (G2 autonomous correction; G1 accountability).**

## Overview

This slice cuts through Hermes → Warren (`POST /api/workflows/qds-piv-loop/run` re-dispatch + `GET /api/stream/__dashboard__` SSE) → the Pi-team implement node (Pair archetype) → GitHub PR. The Dev manager takes the bot review comment **already detected and persisted by P1.18** (comment id + body + file/line + PR/branch), re-dispatches the implement node with that comment text as the `--task` input against the PR's worktree branch, the Pi Pair reads+addresses it and pushes a commit, and the manager then **verifies the PR moved to GREEN**: the addressed comment is resolved/outdated AND the bot/CI combined status returns `success`. It is one atomic 4-pt unit because reusing the implement-node + SSE-drive substrate (P1.6) and the Pair archetype (P1.5), this story adds only the comment→task adapter, the push step, and the green-verification poll — the loop is not real until a pushed fix flips a live PR's status to green, so none of those parts can split off without leaving the loop open. Note: W0 resolved all 6 BLOCKERs as Archon/P1.8 terminology residuals (batch-replaced, not architectural rework) — the 4-pt estimate remains accurate.

## E2E Slice

**Demonstrable behavior:** Given a real PR carrying a detected bot review comment (from P1.18), the Dev manager re-dispatches the `qds-piv-loop` implement node (Pair) with the comment body as the task; the Pi Pair pushes a fix commit to the PR branch; the manager then polls GitHub and observes the PR is GREEN — the addressed review comment is `resolved`/`outdated` AND both the Status API (`GET /repos/{o}/{r}/commits/{sha}/status`) and the Checks API (`GET /repos/{o}/{r}/commits/{sha}/check-runs`) return passing (dual-source verification). A `cost_events` row is written for the fix run and the SSE run-log (correlated to the issue id) captures the loop.

**Wiring closed:** On completion of this story, dispatching a Pi Pair against a detected bot comment produces **a pushed fix commit on the PR branch, the addressed comment marked resolved/outdated, and the PR's combined status `success` (GREEN)** — all verified by the manager against the live GitHub API — using only code merged by this story (the comment→task adapter, the re-dispatch call, the push step, and the green-verification poll). No stub, no `TODO: wire later`, and no sibling story is required to make this behavior real. Predecessors, if any, are dependency edges (listed below), not unfinished wiring inside this story.

**Dependency edges (predecessors):** P1.18 (bot review comment detected + persisted). P1.6 (Pi-team implement bash node emits one structured JSON result + cost_events). P1.5 (qds-model-router selects the Pair archetype + per-role model tier).

## Acceptance Criteria

> ≥3 scenarios, Given/When/Then. Exactly one tagged (make-or-break) and binary.

1. **(make-or-break)** Given a real PR with a detected bot review comment (from P1.18), When the Dev manager re-dispatches the implement node (Pi Pair) with that comment as the task, the Pi Pair pushes a fix commit to the PR branch, and the manager verifies the PR, Then the addressed review comment is `resolved` or `outdated` **AND** both the Status API (`GET /repos/{o}/{r}/commits/{headSha}/status`) and the Checks API (`GET /repos/{o}/{r}/commits/{headSha}/check-runs`) show passing — i.e. the comment→fix→green loop provably closed on a live PR. (Binary: comment not-open AND combined status `success` from dual-source verification.)
2. Given the fix run incurs LLM spend, When the implement node completes, Then ≥1 `cost_events` row exists for the re-dispatch run with `issueId` FK set + `costCents` a non-negative integer, and the SSE run-log (P1.6) captures the run correlated to that issue id (NFR-COST-1/OBS-1/OBS-3).
3. Given the Pi Pair pushes a commit but the PR status stays RED (combined status `failure`/`pending` after the verification timeout, or the comment stays `open`), When the manager verifies, Then it does NOT report the loop closed — it records the run as not-green (`exit_class:"logic"` / un-resolved) and surfaces the unresolved comment, never marking a still-red PR green (guard fires, never a silent green).

## Technical Notes

- **Contracts/Schema (JSON/TS):** Comment→task adapter input (consumes the P1.18-persisted record): `{ prNumber: number, headBranch: string, headSha: string, commentId: number, commentBody: string, path: string, line: number|null }`. Verification result: `{ commentState: "resolved"|"outdated"|"open", combinedStatus: "success"|"failure"|"pending", green: boolean }` where `green === (commentState !== "open" && combinedStatus === "success")`. Backward-compatible: re-dispatch is a normal `qds-piv-loop` run — no schema change to the implement node's merged output (FR-EX-6 shape reused verbatim). `costCents` is a non-negative integer (never float). The cost is computed using P1.13's ceiling formula: `Math.ceil(Number((usd * 100).toFixed(10)))` — always rounds up to the nearest cent. Example: $0.00123 → 1 cent. This matches P1.13's verified-correct rounding convention. The Zod schema is `z.number().int().nonnegative()`.
- **Integration points (each wired & exercised in this story):** (1) read the P1.18-persisted bot comment → build the `--task` from `commentBody` + `path:line`; (2) re-dispatch via `POST /api/workflows/qds-piv-loop/run` consumed through the Warren SSE-drive (P1.6) (issue-id correlated run-log, FR-MG-4); (3) the Pi Pair pushes a fix commit to `headBranch` (git push from the run's worktree, FR-OR-5); (4) green-verification against GitHub REST: `PATCH`/GraphQL `resolveReviewThread` (mark thread resolved) or detect `outdated`, plus dual-source status verification — `GET /repos/{o}/{r}/commits/{headSha}/status` (Status API) AND `GET /repos/{o}/{r}/commits/{headSha}/check-runs` (Checks API) — combined with AND logic per H8; (5) ≥1 `cost_events` row for the run (P1.6 emitter reused).
- **Files / functions touched:** `src/hermes/comment-fix-dispatcher.ts` (comment→task adapter + re-dispatch), `src/hermes/pr-green-verifier.ts` (resolve-thread + combined-status poll → `green` boolean), `src/hermes/github-client.ts` (authed GitHub REST/GraphQL calls), reuses `src/hermes/run-driver.ts` + `warren-workflows/qds-piv-loop/implement-node.sh` (P1.6).
- **Guards/limits:** the green-verification poll is bounded (wall-clock cap, then reports not-green per AC-3 — never an unbounded wait, NFR-SAF-3); re-dispatch counts toward the issue's ≤8-retry / ≤1h cap (NFR-SAF-2); `--wall-clock-cap-ms ≤` the bash node `timeout` (reused P1.6 guard).
- **Post-push headSha (P1.19-H1):** After the Pi Pair pushes a fix commit, the branch head advances (new SHA). The green-verification MUST poll against the NEW head SHA, not the original `headSha` from the wake signal. The re-dispatch captures the new SHA from the push output or by querying `GET /repos/{o}/{r}/git/refs/heads/{headBranch}` after push. The `headSha` in the verification is always the post-push SHA.
- **Resolved/outdated disjunction (P1.19-H2):** A review comment is considered 'addressed' when its state is either `resolved` (explicitly resolved by a human or bot) or `outdated` (the line it commented on was changed by the push). Both are success conditions. The green-verifier checks: `commentState in ['resolved', 'outdated']`. The AC assertion uses `commentState !== 'open'` which covers both cases.
- **Re-dispatch lifecycle (P1.19-H3):** Re-dispatch creates a NEW run (new runId) with the same workflow name `qds-piv-loop`. The new run checks out the PR's `headBranch` in a fresh worktree (not reusing the previous run's worktree). The implement node's `--task` is set to the comment body + path:line. The previous run's worktree is NOT affected.
- **Comment→task string format (P1.19-H4):** The comment-to-task adapter builds the --task payload as: `Address this review comment on ${path}:${line ?? 'general'}:\n\n${commentBody}`. The path:line prefix gives the Pi Pair spatial context. For general comments (no file/line), the prefix is `Address this general PR review comment:\n\n${commentBody}`.
- **Green-verification poll interval and timeout (P1.19-H5):** The green-verification poll interval is 10 seconds (configurable via `QDS_GREEN_POLL_INTERVAL_SECONDS`). Maximum poll duration: 120 seconds (configurable via `QDS_GREEN_POLL_TIMEOUT_SECONDS`). After timeout, reports not-green per AC-3. The poll queries `GET /repos/{o}/{r}/commits/{newSha}/status` (Status API) and `GET /repos/{o}/{r}/commits/{newSha}/check-runs` (Checks API) for dual-source combined status, and the review thread state.
- **resolveReviewThread requires thread_id (P1.19-H6):** GitHub's `resolveReviewThread` mutation requires a `thread_id` (not `comment_id`). The adapter maps: `GET /repos/{o}/{r}/pulls/{n}/comments/{commentId}` returns `pull_request_review_id` and `in_reply_to_id` → use these to find the thread via `GET /repos/{o}/{r}/pulls/{n}/threads` → match thread containing the comment → `resolveReviewThread(thread_id)`. Alternatively, detect `outdated` state if the push changed the commented line — no explicit resolve needed.
- **Wake-signal to input mapping (P1.19-H7):** P1.19's input record is derived from P1.18's wake signal by renaming `body → commentBody` and dropping `prRef`/`commentType`/`author`/`source`/`detectedAt` (metadata fields not needed by the fix dispatcher). The `commentBody` field in the input record is sourced from the wake signal's `body` field — no other transformation. All other fields (`prNumber`, `headBranch`, `headSha`, `commentId`, `path`, `line`) are passed through as-is. The `commentType` discriminator from P1.18 is logged for observability but not forwarded — P1.19 does not need to distinguish inline vs review at the task-dispatch level (both produce the same fix flow; `path` and `line` already carry the spatial context).
- **Combined status resolution (P1.19-H8):** GitHub has TWO independent status systems: (1) Status API (`GET /repos/{o}/{r}/commits/{sha}/status`) for legacy commit statuses, and (2) Checks API (`GET /repos/{o}/{r}/commits/{sha}/check-runs`) for GitHub Actions / Check Runs. The green-verifier queries BOTH endpoints and combines with AND logic: `green = (all statuses pass OR no statuses) AND (all check runs pass OR no check runs)`. A pending check run means `combinedStatus !== "success"`. The Pi Pair does NOT report GREEN until both systems show passing. Using only the Status API would miss Check Run failures — producing false GREEN (violating INV-5). Update AC-1 and the verification result contract to reflect dual-source verification.
- **Push rejection recovery (P1.19-H9):** If `git push` is rejected (non-fast-forward), the Pi Pair runs `git pull --rebase origin {headBranch}` and retries the push once. If the rebase succeeds and the push succeeds, green-verification proceeds normally. If the rebase fails (merge conflict), the run reports `exit_class:'logic'` immediately without entering the green-poll loop. If the push is rejected a second time after rebase, report `exit_class:'logic'`. The green-poll timeout is never entered when the push itself fails.
- **PR state guard (P1.19-H10):** On each green-verification poll iteration, the verifier queries `GET /repos/{o}/{r}/pulls/{n}` and checks `state === 'open'`. If the PR is `closed` or `merged`, the verifier immediately reports not-green with `exit_class:'logic'` and logs 'PR no longer open: state={state}'. No further polling. This prevents reporting GREEN on a PR that was merged with failing checks or manually closed.
- **Sequential wake-signal processing (P1.19-V-M-1):** The Dev manager processes wake signals one at a time — it does NOT consume the next wake signal until the current re-dispatch + green-verification completes. If multiple bot comments are detected, they are addressed one at a time in FIFO order. This prevents two Pi Pairs pushing to the same branch concurrently.

## Files to Modify

> ≤10 unique paths.

- `src/hermes/comment-fix-dispatcher.ts`
- `src/hermes/pr-green-verifier.ts`
- `src/hermes/github-client.ts`
- `warren-workflows/qds-piv-loop/implement-node.sh`
- `tests/hermes/comment-fix-dispatcher.test.ts`
- `tests/hermes/pr-green-verifier.test.ts`
- `tests/hermes/pi-pair-fix-green.e2e.test.ts`

Note: `WarrenClient` (P1.6) and `src/hermes/run-driver.ts` are reused without modification — not listed above because they require no changes in this story.

## Security Invariants

> Triggers: input/file (untrusted bot-comment body becomes task input + the fix touches files), auth (GitHub token + Paperclip bearer).

- **INV-1 (input — untrusted comment body):** the detected bot-comment `commentBody` is treated as **untrusted data**, not as a privileged instruction — it is passed only as the implement node's `--task` payload (data), never interpolated into a shell command, the launcher flag list, or an env value; a comment containing shell metacharacters/prompt-injection text cannot escape the task slot to alter caps, role-model, or the worktree path. The comment body is truncated to 4000 characters before being passed as --task (GitHub review comment body limit is ~64K but Pi Pair context window is bounded). Truncation is logged. Comments exceeding 4000 chars are truncated with '...[truncated]' suffix. Truncation uses JavaScript string `.slice(0, 4000)` (UTF-16 code units). If the code unit at index 3999 is a high surrogate (`0xD800–0xDBFF`), truncation uses `.slice(0, 3999)` instead to avoid producing a lone surrogate — the result ends on a code point boundary. If the code unit is a low surrogate or non-surrogate, `.slice(0, 4000)` is used as-is. The resulting string is always valid UTF-16 with no unpaired surrogates.
- **INV-2 (file — fix scope):** the Pi Pair's fix is committed only onto the detected PR's `headBranch` within the run's isolated worktree (FR-OR-5); the push targets that branch and SHA — it cannot push to `main`/a default branch or to a branch outside the run's worktree (no cross-branch write).
- **INV-3 (auth — GitHub):** all GitHub REST/GraphQL calls (resolve-thread, combined-status, push) send `Authorization: Bearer <GITHUB_TOKEN>` read from env/secret refs only (NFR-SEC-1); the token is never written to the task payload, the merged JSON node output, `cost_events`, the SSE run-log, or stdout.
- **INV-4 (auth — Paperclip):** the re-dispatch run-start and `cost_events` write use the per-agent `PAPERCLIP_API_KEY` + `PAPERCLIP_RUN_ID` run-scoped header (NFR-SEC-2, `adapters/registry.ts:468-469`); an agent reports only its OWN `agentId` (`costs.ts:77-80`) — no off-ledger or impersonated spend.
- **INV-5 (no false green):** the PR is reported GREEN only when the live GitHub combined status is `success` AND the addressed comment is `resolved`/`outdated`; there is no code path that marks the loop closed on a stale/cached status or on push-success alone (the lights-out trust guarantee).

## Definition of Done

> 8–12 high-signal, story-specific boxes.

- [ ] **Impl:** the comment→task adapter reads the P1.18-persisted bot comment and builds the implement-node `--task` from `commentBody` + `path:line`.
- [ ] **Impl:** the Dev manager re-dispatches `qds-piv-loop` (Pair archetype, P1.5) via `POST /api/workflows/qds-piv-loop/run`, consumed through the Warren SSE-drive (P1.6) (issue-id correlated run-log).
- [ ] **Impl:** the Pi Pair pushes a fix commit to the detected PR `headBranch` from the run's isolated worktree (FR-OR-5).
- [ ] **Impl:** the green-verifier marks the review thread resolved (or detects `outdated`) and polls both the Status API (`GET /repos/{o}/{r}/commits/{headSha}/status`) and the Checks API (`GET /repos/{o}/{r}/commits/{headSha}/check-runs`) for combined `state` (dual-source per H8).
- [ ] **Contract:** the comment→task input record and the verification result (`commentState`/`combinedStatus`/`green`) are field-validated; `green === (commentState!=="open" && combinedStatus==="success")`.
- [ ] **Integration:** the loop is wired end-to-end — detected comment → re-dispatch → push → green-verify — exercised on a live PR, not stubbed; reuses P1.6 implement node + Warren run-driver unchanged.
- [ ] **Observability/Audit:** ≥1 `cost_events` row for the re-dispatch run (`issueId` FK + non-negative `costCents`); the SSE run-log captures the run correlated to the issue id (NFR-COST-1/OBS-1/OBS-3).
- [ ] **Security:** INV-1 (comment body is data-only, no shell/flag escape), INV-3 (GitHub token env-sourced, never emitted), and INV-5 (no false green) each enforced and tested.
- [ ] **Test (unit/integration):** covers the comment→task adapter, the push-to-headBranch scoping (INV-2), and the still-RED not-green path (AC-3) including the bounded-poll timeout. Test must also cover INV-2 branch-scoping: the Pi Pair's push targets ONLY the detected PR's `headBranch` — verify the git push command includes `refs/heads/{headBranch}` explicitly (not `HEAD` or a bare `git push`). If the worktree's current branch has drifted from `headBranch` (e.g., detached HEAD), the push is rejected and the run reports `exit_class:"logic"` with the branch mismatch logged. No push to `main` or any non-`headBranch` ref is possible. Test must also cover: the addressed review thread is already `resolved` or `outdated` before the green-verify runs (e.g., from a prior fix attempt). The green-verifier detects the already-resolved state and reports `green: true` without attempting to resolve again (idempotent). The `resolveReviewThread` mutation is skipped if the thread is already resolved — no error, no redundant API call.
- [ ] **Test (e2e demo — MANDATORY):** fires AC-1 on a real PR with a detected bot comment — re-dispatch the Pi Pair, push a fix, then assert the addressed comment is `resolved`/`outdated` AND both Status API and Checks API show passing (the loop closed GREEN via dual-source verification per H8); proves the lights-out comment→fix→green workflow with wiring closed.

## Dev Agent Record

<!-- Empty placeholder — filled during development. -->
