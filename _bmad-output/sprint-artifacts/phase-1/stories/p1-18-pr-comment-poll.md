# P1.18: A Paperclip routine polls the PR and wakes the Dev manager on a bot review comment

**Story Points:** 3

## Spec Reference

- PRD §6.6 (Comms — inbound/outbound) + §6.2 (Managers); FR-CM-5 (emit/route status unified through Paperclip), FR-MG-4 (manager launches/consumes a run — here, the manager is woken with the comment context to re-enter the loop).
- §13 Phase 3–4 clause 2 ("The PR-bot fix loop resolves ≥1 review comment to closure") — **item 15** of the Phase-1 scope per R5: separable from the P1.17 make-or-break gate. This story is the **detect** half (poll → wake); P1.19 is the **fix** half — this is a Phase-1 slice of the Phase-3 feature (detect half only; fix half is P1.19).
- Routines/cron contract: Paperclip `routines.ts` (routines/revisions/triggers/runs), `routine_triggers.cron_expression` (`:99`), migration `0039` (R3 §D.4).

## User Story

As the Dev manager,
I want a Paperclip cron routine to poll the open PR and wake me whenever a CodeRabbit or Gemini bot posts a review comment,
so that external bot feedback re-enters the lights-out loop automatically without a human relaying it (G2 autonomy; G4 closed-loop on review), and the same comment is never processed twice.

## Overview

A vertical slice through the Paperclip **routines/cron** subsystem into the Dev manager wake path. It cuts: a `routine_triggers.cron_expression` schedule (`routines.ts`, migration `0039`) → a routine run that calls the GitHub PR reviews/comments API for the PR opened by P1.15 → a **bot-comment filter** (author is the CodeRabbit/Gemini bot, not a human) → an **idempotent seen-set** (comment id → already-processed) → on a new bot comment, **wake the Dev manager** (FR-MG-4) handing it the comment context. One atomic 3-pt unit: a scheduled poll that detects ≥1 new bot review comment and wakes the manager, with the same comment never re-processed. It does NOT fix the comment — that is P1.19 (dependency edge out). The GitHub token is read from env (secrets trigger); the routine and the manager-wake run as the bearer-authenticated registered agent (auth trigger). Note: W2 resolved the wake mechanism (P1.18-H2) — the original 3-pt estimate accounts for the now-specified wake_signals table and polling SQL.

## E2E Slice

**Demonstrable behavior:** With a real Paperclip routine scheduled (`routine_triggers.cron_expression`) against the PR opened by P1.15, the routine run polls the PR's review comments, finds ≥1 comment authored by a CodeRabbit/Gemini bot that is **not** in the seen-set, records it, and **wakes the Dev manager** (creates/updates a wake signal for the Dev-manager agent carrying `{ prRef, prNumber, headBranch, headSha, commentId, author, body, path, line }`). On a second run with no new comment, it wakes nobody and writes no duplicate signal (idempotent).

**Wiring closed:** On completion of this story, a scheduled Paperclip routine run against the P1.15 PR **detects ≥1 bot review comment and wakes the Dev manager exactly once per comment**, using only code merged by this story (the routine definition + trigger, the bot-comment poller/filter, the seen-set, and the manager-wake call). No stub, no `TODO: wire later`, and no sibling story is required to make this detection real. Predecessors are dependency edges (listed below), not unfinished wiring inside this story. (The manager's *response* to the wake — dispatch a Pi Pair, push a fix — is P1.19, a separate slice.)

**Dependency edges (predecessors):** P1.15 (Telegram `/qds` → a real PR on the sample repo — this story polls that exact PR; without it there is no PR to poll). The Dev manager registration (P1.1) is assumed live as the wake target. P1.18 only writes a wake signal; P1.19 is the story that consumes the signal via the Dev manager run-driver. Note: P1.8 (killed by Warren cascade) is NOT a dependency of P1.18 — the routine uses Paperclip's cron subsystem directly, not the P1.8 SSE-drive. This story has no dependency on any killed story.

## Acceptance Criteria

> ≥3 scenarios, Given/When/Then. Exactly one tagged (make-or-break) and binary.

1. **(make-or-break)** Given the P1.15 PR with ≥1 review comment authored by a CodeRabbit/Gemini bot and an empty seen-set, When the scheduled routine run executes, Then it detects that comment and **wakes the Dev manager exactly once** — exactly one wake signal exists for the Dev-manager agent carrying `{ prRef, prNumber, headBranch, headSha, commentId, author, body, path, line }`, and the comment id is recorded in the seen-set.
2. Given the same PR and a seen-set that already contains that comment id, When the routine runs again with no new bot comment, Then it wakes **nobody** and writes **no** duplicate wake signal — the same comment is never re-processed (idempotent).
3. Given the PR has only **human** review comments (no CodeRabbit/Gemini bot author), When the routine runs, Then it wakes nobody — the bot-author filter excludes human comments so the loop is not woken on non-bot feedback.
4. Given the GitHub API call fails (rate-limit / network) or the PR is unreachable, When the routine runs, Then it logs the failure and **does not** advance the seen-set or wake the manager (no false wake, no comment silently marked seen) — the run reports an error state, never a silent success.
5. Given the routine is scheduled at `:99` (hourly at minute 39), When a bot comment is posted at minute 00, Then the comment is detected within ≤61 minutes (worst-case: posted just after the poll ran). The max-detection-latency is bounded by the cron interval — no comment goes undetected for more than one cron cycle. If sub-hour detection is needed, the cron interval is configurable via the routine trigger.

## Technical Notes

- **Contracts/Schema:** Routine definition via `routines.ts` (+ `routine_triggers.cron_expression` (`:99`), migration `0039`) — no new core table. `:99` is a Paperclip-internal cron shorthand meaning 'every hour at minute 99-mod-60 = 39' — i.e., `39 * * * *` in standard 5-field cron. The `:99` syntax is the Paperclip routines convention documented in `routines.ts` and migration `0039` (R3 §D.4). Maximum detection latency: ~1 hour between bot comment post and wake signal. This is acceptable for the lights-out loop (bot comments are not time-critical; sub-hour latency is fine). New **wake-signal contract** (Zod/JSON) handed to the manager:
  ```typescript
  prCommentWakeSchema = z.object({
    prRef: z.string().min(1).describe("Format: owner/repo#123"),  // e.g. "owner/repo#123"
    prNumber: z.number(),       // numeric PR number
    headBranch: z.string(),     // PR head ref
    headSha: z.string(),        // PR head commit SHA
    commentId: z.number(),      // numeric (NOT string — matches GitHub API + P1.19)
    commentType: z.enum(["inline", "review"]),  // discriminates inline comment vs review body
    author: z.string(),
    body: z.string(),
    path: z.string(),           // file path from review comment
    line: z.number().nullable(),// line number (nullable for general comments)
    source: z.enum(["coderabbit","gemini"]),
    detectedAt: z.string().datetime()
  })
  ```
  This schema is the contract seam consumed by P1.19's comment-to-task adapter input. **Seen-set** persisted as a small per-PR ledger row (`pr_comment_seen { prRef TEXT, commentId INTEGER, processedAt TEXT }`, unique on `(prRef, commentId)`) so idempotency survives across routine runs. Backward-compatible: additive; no existing routine behavior changes.
- **Integration points (each wired & exercised in this story):** (1) the cron **routine trigger** fires the poll on schedule (`routine_triggers.cron_expression` `:99`); (2) GitHub PR **reviews/comments** poll — the poll fetches TWO GitHub API endpoints: (a) `GET /repos/{o}/{r}/pulls/{n}/comments` — inline review comments (line-level, have `path`/`line`/`body`) and (b) `GET /repos/{o}/{r}/pulls/{n}/reviews` — review bodies (general, no file/line). Review body comments are mapped to `path: ""` and `line: null`. Inline comments are the primary target (they carry actionable file:line context for P1.19). Review bodies are included only if they have non-empty `body` and the author is on the allow-list. The wake-signal schema handles both via `line: z.number().nullable()`; For review-body entries, `commentId` in the wake signal is the review's `id` field (review ID, not inline comment ID). P1.19 must not confuse review IDs with inline comment IDs — they are from different ID spaces. The `commentType` discriminant disambiguates: `"inline"` entries carry `path: string` and `line: number|null`; `"review"` entries carry `path: ""` and `line: null`; (3) **bot-author filter** (author login matches the CodeRabbit/Gemini bot) + **seen-set** dedupe; (4) **wake the Dev manager** (FR-MG-4) by writing the wake signal for the Dev-manager agent — the manager re-enters its loop with the comment context.
- **Files / functions touched:** `src/routines/pr-comment-poll.ts:pollPrComments` (poll + filter + dedupe + wake), `src/routines/register-pr-comment-routine.ts` (create routine + `routine_triggers.cron_expression`), `src/db/pr-comment-seen.ts` (idempotent seen-set upsert), `src/manager/wake-dev-manager.ts:wakeWithComment`. References `routines.ts`, migration `0039`.
- **Bot-author allow-list:** the filter matches comment author login against an explicit allow-list, configurable via the `QDS_BOT_AUTHOR_LOGINS` env var (comma-separated). Defaults when unset:
  ```typescript
  BOT_AUTHOR_ALLOW_LIST = [
    "coderabbitai",
    "coderabbitai[bot]",
    "gemini-code-assist[bot]",
  ]
  ```
  A comment from any author not on this list (human or unknown bot) is ignored so the loop cannot be woken by an unverified actor. The exact bot login names are documented here and must be covered by test.
- **Wake API:** the wake mechanism uses a `wake_signals` table with columns: `{ id, target_agent TEXT, signal_type TEXT, payload JSONB, created_at TIMESTAMPTZ, consumed_at TIMESTAMPTZ NULL }`. Unique constraint: `(target_agent, signal_type, payload->>'commentId')`. The `wakeWithComment` function inserts a row with `target_agent='dev-manager'`, `signal_type='pr-comment'`, and the wake-signal payload. P1.19's Dev manager polls `SELECT * FROM wake_signals WHERE target_agent='dev-manager' AND consumed_at IS NULL ORDER BY created_at ASC LIMIT 1`, processes it, then sets `consumed_at=now()`. This is a lightweight signal mechanism requiring no new HTTP endpoints.
- **Seen-set storage (option C — runtime SQLite ledger):** the `pr_comment_seen` table is a lightweight SQLite runtime ledger, NOT a formal Drizzle migration. It is created with `CREATE TABLE IF NOT EXISTS` at first routine run. Columns: `{ prRef TEXT, commentId INTEGER, processedAt TEXT }`. Unique constraint: `(prRef, commentId)` enforced by the `CREATE TABLE` statement. This approach trades cross-process durability (SQLite file is local to the Paperclip runtime) for simplicity and zero migration overhead. If the Paperclip process restarts, the SQLite file persists on disk and idempotency is preserved. If the file is deleted (e.g., container restart without volume), idempotency resets — duplicate wake signals may fire once, but P1.19's wake-signal consumer is idempotent (it processes and marks consumed, so a duplicate wake for an already-consumed signal is a no-op). The uniqueness constraint is enforced by the SQLite `UNIQUE(prRef, commentId)` at the database level, not in application logic.
- **PR discovery:** the routine discovers the target PR by reading the most recent run-log for the QDS company's issues with status `pr_open`: `GET /companies/:companyId/issues?status=pr_open&limit=1`. The `pr_url` field from the run-log provides owner/repo/number. If no PR is found with status `pr_open`, the routine exits with `exit_class:"logic"` (nothing to poll).
- **Multi-comment semantics:** for each unseen bot comment, the routine creates one `pr_comment_seen` row and one `wake_signals` row (one wake per comment). P1.19 processes wake signals FIFO (oldest unconsumed first). If multiple wake signals exist, P1.19 processes them one at a time across sequential re-dispatches.
- **Guards/limits:** the bot-author allow-list is explicit (CodeRabbit + Gemini logins only) so a spoofed/human author cannot wake the loop; the seen-set is advanced **only after** a successful wake (so a failed wake is retried, not lost); the poll honors GitHub rate-limit headers and the routine's own timeout (a hung poll fails the run, never hangs the cron). The `pr_comment_seen` upsert and the `wake_signals` INSERT for a given `commentId` MUST be within a single database transaction. On commit failure, neither row is persisted — the next routine run retries the comment. On successful commit, both rows are durable.
- **Stale headSha handoff (P1.18-V-M-1):** If P1.19 reads a wake signal whose `headSha` is no longer the tip of `headBranch` (detected via `GET /repos/{o}/{r}/git/refs/heads/{headBranch}`), P1.19 should discard the wake signal (mark `consumed_at`) and log a warning — the comment may no longer apply to the current branch state. P1.18 captures `headSha` at poll time; P1.19 validates it at consumption time.
- **Deleted comment race (P1.18-V-M-2):** If P1.19's GitHub client gets a 404 when fetching the comment by `commentId`, P1.19 should treat the comment as gone, mark the wake signal consumed, and log it. P1.18 does not handle deletion at poll time because deleted comments don't appear in the API response.
- **Exit classification (P1.18-V-H-1):** the routine run emits `exit_class` in its result: `"logic"` for all no-op cases (no new comments, no PR found) AND for successful detection + wake (new bot comment found and wake signal written). To distinguish them, the result includes a structured `result` payload: `{ action: "wake", wokeCount: <number>, prRef: <string> }` for successful detection vs `{ action: "no-op", reason: "no_pr_open"|"no_new_comments" }` for idle runs. This lets observability distinguish productive wakes from idle no-ops. `"transient"` for GitHub API failures (rate-limit, network — retryable). `"overflow"` if the poll exceeds the routine's wall-clock timeout cap.

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
- [ ] **Impl:** a new (unseen) bot comment **wakes the Dev manager** with the comment context (`prRef`/`prNumber`/`headBranch`/`headSha`/`commentId`/`commentType`/`author`/`body`/`path`/`line`), re-entering the loop.
- [ ] **Contract:** `prCommentWakeSchema` (all fields: `prRef`, `prNumber`, `headBranch`, `headSha`, `commentId` as `z.number()`, `commentType` as `z.enum(["inline", "review"])`, `author`, `body`, `path`, `line` nullable, `source`, `detectedAt`) + the `pr_comment_seen` ledger (`commentId INTEGER`, unique `(prRef, commentId)`) are added with field validation; additive/backward-compatible.
- [ ] **Integration:** the cron trigger → GitHub poll → bot filter → seen-set → manager wake path is wired end-to-end and exercised (not stubbed), against the real PR opened by P1.15.
- [ ] **Observability:** each routine run records what it did (comments seen, comments newly woken, none) correlated to the `prRef`, so a missed/duplicate wake is diagnosable from the run record.
- [ ] **Security:** the GitHub token is env-sourced and never logged (INV-1); routine + wake run bearer-authenticated (INV-2); only allow-listed bot authors wake the loop (INV-3) — asserted by test.
- [ ] **Idempotency:** the seen-set is unique on `(prRef, commentId)` and advanced only after a successful wake; a re-run on the same comment wakes nobody and writes no duplicate (INV-4) — asserted by test.
- [ ] **Bot logins verified:** the exact bot login names (`coderabbitai`, `coderabbitai[bot]`, `gemini-code-assist[bot]`) are documented in code as defaults and covered by the bot-author-filter test; override via `QDS_BOT_AUTHOR_LOGINS` env var is tested.
- [ ] **Test (unit/integration):** the bot-author filter (human comment ignored), the dedupe (second run no-op), and the fail path (API error → no seen-set advance, no wake) are each covered. Test must also cover: a single poll returning 5 unseen bot comments from the same PR — the routine creates 5 seen-set rows and 5 wake signals (one per comment, FIFO-ordered by `created_at`). P1.19 processes them one at a time across sequential re-dispatches. Verify all 5 are captured (no loss) and all 5 have unique `commentId` values in the seen-set; PR-discovery early-exit: when no issue with status `pr_open` exists, the routine emits `exit_class:'logic'` with result `{action:'no-op', reason:'no_pr_open'}` and writes no seen-set rows or wake signals; source field: `coderabbitai`/`coderabbitai[bot]` → `source:"coderabbit"`, `gemini-code-assist[bot]` → `source:"gemini"`.
- [ ] **Test (e2e demo — MANDATORY):** with a real bot review comment on the P1.15 PR, run the routine and assert exactly one Dev-manager wake signal is created carrying the comment context and the comment id is recorded; run it again and assert zero new wakes/duplicates — proving detect + idempotent re-entry; wiring closed.

## Dev Agent Record

<!-- Empty placeholder — filled during development. -->
