# P1.18: A Paperclip routine polls the PR and wakes the Dev manager on a bot review comment

**Story Points:** 3

## Spec Reference

- PRD §6.6 (Comms — inbound/outbound) + §6.2 (Managers); FR-CM-5 (emit/route status unified through Paperclip), FR-MG-4 (manager launches/consumes a run — here, the manager is woken with the comment context to re-enter the loop).
- §13 Phase 3–4 clause 2 ("The PR-bot fix loop resolves ≥1 review comment to closure") — **item 15** of the Phase-1 scope per R5: separable from the P1.17 make-or-break gate. This story is the **detect** half (poll → wake); P1.19 is the **fix** half.
- Routines/cron contract: Paperclip `routines.ts` (routines/revisions/triggers/runs), `routine_triggers.cron_expression` (`:99`), migration `0039` (R3 §D.4).

## User Story

As the Dev manager,
I want a Paperclip cron routine to poll the open PR and wake me whenever a CodeRabbit or Gemini bot posts a review comment,
so that external bot feedback re-enters the lights-out loop automatically without a human relaying it (G2 autonomy; G4 closed-loop on review), and the same comment is never processed twice.

## Overview

A vertical slice through the Paperclip **routines/cron** subsystem into the Dev manager wake path. It cuts: a `routine_triggers.cron_expression` schedule (`routines.ts`, migration `0039`) → a routine run that calls the GitHub PR reviews/comments API for the PR opened by P1.15 → a **bot-comment filter** (author is the CodeRabbit/Gemini bot, not a human) → an **idempotent seen-set** (comment id → already-processed) → on a new bot comment, **wake the Dev manager** (FR-MG-4) handing it the comment context. One atomic 3-pt unit: a scheduled poll that detects ≥1 new bot review comment and wakes the manager, with the same comment never re-processed. It does NOT fix the comment — that is P1.19 (dependency edge out). The GitHub token is read from env (secrets trigger); the routine and the manager-wake run as the bearer-authenticated registered agent (auth trigger).

## E2E Slice

**Demonstrable behavior:** With a real Paperclip routine scheduled (`routine_triggers.cron_expression`) against the PR opened by P1.15, the routine run polls the PR's review comments, finds ≥1 comment authored by a CodeRabbit/Gemini bot that is **not** in the seen-set, records it, and **wakes the Dev manager** (creates/updates a wake signal for the Dev-manager agent carrying `{ prRef, commentId, author, body }`). On a second run with no new comment, it wakes nobody and writes no duplicate signal (idempotent).

**Wiring closed:** On completion of this story, a scheduled Paperclip routine run against the P1.15 PR **detects ≥1 bot review comment and wakes the Dev manager exactly once per comment**, using only code merged by this story (the routine definition + trigger, the bot-comment poller/filter, the seen-set, and the manager-wake call). No stub, no `TODO: wire later`, and no sibling story is required to make this detection real. Predecessors are dependency edges (listed below), not unfinished wiring inside this story. (The manager's *response* to the wake — dispatch a Pi Pair, push a fix — is P1.19, a separate slice.)

**Dependency edges (predecessors):** P1.15 (Telegram `/qds` → a real PR on the sample repo — this story polls that exact PR; without it there is no PR to poll). The Dev manager registration (P1.1) is assumed live as the wake target.

## Acceptance Criteria

> ≥3 scenarios, Given/When/Then. Exactly one tagged (make-or-break) and binary.

1. **(make-or-break)** Given the P1.15 PR with ≥1 review comment authored by a CodeRabbit/Gemini bot and an empty seen-set, When the scheduled routine run executes, Then it detects that comment and **wakes the Dev manager exactly once** — exactly one wake signal exists for the Dev-manager agent carrying `{ prRef, commentId, author, body }`, and the comment id is recorded in the seen-set.
2. Given the same PR and a seen-set that already contains that comment id, When the routine runs again with no new bot comment, Then it wakes **nobody** and writes **no** duplicate wake signal — the same comment is never re-processed (idempotent).
3. Given the PR has only **human** review comments (no CodeRabbit/Gemini bot author), When the routine runs, Then it wakes nobody — the bot-author filter excludes human comments so the loop is not woken on non-bot feedback.
4. Given the GitHub API call fails (rate-limit / network) or the PR is unreachable, When the routine runs, Then it logs the failure and **does not** advance the seen-set or wake the manager (no false wake, no comment silently marked seen) — the run reports an error state, never a silent success.

## Technical Notes

- **Contracts/Schema:** Routine definition via `routines.ts` (+ `routine_triggers.cron_expression`, migration `0039`) — no new core table. New **wake-signal contract** (Zod/JSON) handed to the manager: `prCommentWakeSchema = { prRef: z.string(), commentId: z.string(), author: z.string(), body: z.string(), source: z.enum(["coderabbit","gemini"]), detectedAt: z.string().datetime() }`. **Seen-set** persisted as a small per-PR ledger row (`pr_comment_seen { prRef, commentId, processedAt }`, unique on `(prRef, commentId)`) so idempotency survives across routine runs. Backward-compatible: additive; no existing routine behavior changes.
- **Integration points (each wired & exercised in this story):** (1) the cron **routine trigger** fires the poll on schedule (`routine_triggers.cron_expression` `:99`); (2) GitHub PR **reviews/comments** poll (`GET /repos/{owner}/{repo}/pulls/{n}/comments` + `/reviews`) against the P1.15 PR, token from env; (3) **bot-author filter** (author login matches the CodeRabbit/Gemini bot) + **seen-set** dedupe; (4) **wake the Dev manager** (FR-MG-4) by writing the wake signal for the Dev-manager agent — the manager re-enters its loop with the comment context.
- **Files / functions touched:** `src/routines/pr-comment-poll.ts:pollPrComments` (poll + filter + dedupe + wake), `src/routines/register-pr-comment-routine.ts` (create routine + `routine_triggers.cron_expression`), `src/db/pr-comment-seen.ts` (idempotent seen-set upsert), `src/manager/wake-dev-manager.ts:wakeWithComment`. References `routines.ts`, migration `0039`.
- **Guards/limits:** the bot-author allow-list is explicit (CodeRabbit + Gemini logins only) so a spoofed/human author cannot wake the loop; the seen-set is advanced **only after** a successful wake (so a failed wake is retried, not lost); the poll honors GitHub rate-limit headers and the routine's own timeout (a hung poll fails the run, never hangs the cron).

## Files to Modify

> ≤10 unique paths.

- `src/routines/register-pr-comment-routine.ts`
- `src/routines/pr-comment-poll.ts`
- `src/db/pr-comment-seen.ts`
- `src/manager/wake-dev-manager.ts`
- `src/contracts/pr-comment-wake.schema.ts`
- `config/github.env.example`
- `tests/routines/pr-comment-poll.test.ts`
- `tests/routines/pr-comment-poll.e2e.test.ts`

## Security Invariants

> Triggers: auth, secrets/env. Concrete named invariants only.

- **INV-1 (secrets/env — token hygiene):** the GitHub token is read from env/secret ref only (`config/github.env.example` documents the var name, holds no real value); the token is never hardcoded, never written to stdout, routine-run logs, the wake signal, or the seen-set row.
- **INV-2 (auth — authenticated wake):** the routine run and the Dev-manager wake execute as the bearer-authenticated registered agent (`PAPERCLIP_API_KEY` + `PAPERCLIP_RUN_ID`, `adapters/registry.ts:468-469`); an unauthenticated caller cannot wake the manager or write a wake signal.
- **INV-3 (author trust — no spoofed wake):** only comments whose author login is on the explicit CodeRabbit/Gemini bot allow-list produce a wake; a comment from any other author (human or unknown bot) is ignored, so the loop cannot be woken by an unverified actor.
- **INV-4 (idempotent + fail-safe seen-set):** the seen-set is unique on `(prRef, commentId)` and advanced only after a successful wake — a duplicate poll never double-wakes, and a failed wake never marks the comment seen (no comment is silently dropped).

## Definition of Done

> 8–12 high-signal, story-specific boxes.

- [ ] **Impl:** a real Paperclip routine + `routine_triggers.cron_expression` is registered to poll the P1.15 PR on schedule.
- [ ] **Impl:** the poller filters PR review comments to the CodeRabbit/Gemini bot allow-list and dedupes against the seen-set before acting.
- [ ] **Impl:** a new (unseen) bot comment **wakes the Dev manager** with the comment context (`prRef`/`commentId`/`author`/`body`), re-entering the loop.
- [ ] **Contract:** `prCommentWakeSchema` + the `pr_comment_seen` ledger (unique `(prRef, commentId)`) are added with field validation; additive/backward-compatible.
- [ ] **Integration:** the cron trigger → GitHub poll → bot filter → seen-set → manager wake path is wired end-to-end and exercised (not stubbed), against the real PR opened by P1.15.
- [ ] **Observability:** each routine run records what it did (comments seen, comments newly woken, none) correlated to the `prRef`, so a missed/duplicate wake is diagnosable from the run record.
- [ ] **Security:** the GitHub token is env-sourced and never logged (INV-1); routine + wake run bearer-authenticated (INV-2); only allow-listed bot authors wake the loop (INV-3) — asserted by test.
- [ ] **Idempotency:** the seen-set is unique on `(prRef, commentId)` and advanced only after a successful wake; a re-run on the same comment wakes nobody and writes no duplicate (INV-4) — asserted by test.
- [ ] **Test (unit/integration):** the bot-author filter (human comment ignored), the dedupe (second run no-op), and the fail path (API error → no seen-set advance, no wake) are each covered.
- [ ] **Test (e2e demo — MANDATORY):** with a real bot review comment on the P1.15 PR, run the routine and assert exactly one Dev-manager wake signal is created carrying the comment context and the comment id is recorded; run it again and assert zero new wakes/duplicates — proving detect + idempotent re-entry; wiring closed.

## Dev Agent Record

<!-- Empty placeholder — filled during development. -->
