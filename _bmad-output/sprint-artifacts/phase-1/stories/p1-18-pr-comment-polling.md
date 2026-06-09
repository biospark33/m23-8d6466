# P1.18: PR Comment Webhook Ingestion Detects ≥1 Bot Review Comment

**Story Points:** 3

## Spec Reference

- PRD §8; FR-CM-5, FR-MG-4

## User Story

As a SwarmClaw protocol controller,
I want to detect bot review comments on PRs produced by the system,
so that the protocol can re-enter the loop and dispatch agents to address review feedback.

## Overview

After a PR is produced (P1.15), external bot reviewers (e.g., CodeRabbit, Gemini) may post review comments. SwarmClaw must detect these comments to trigger the fix cycle. This story implements PR comment detection via GitHub webhook events. When a PR comment is posted, the webhook payload arrives at SwarmClaw's `/api/webhooks/[id]` endpoint. The system filters for bot-originated review comments using `comment.user.type === "Bot"` or `comment.user.login.endsWith("[bot]")`. Upon detecting ≥1 bot review comment, SwarmClaw updates the protocol state and signals readiness for the fix-dispatch phase.

## E2E Slice

**Demonstrable behavior:** A GitHub webhook delivers a PR comment event where the comment author has `user.type === "Bot"`. SwarmClaw receives the webhook, validates the signature, identifies the comment as a bot review comment, correlates it to the active protocol run, and updates the protocol state to indicate "bot review detected, ready for fix dispatch."

**Wiring closed:** On completion of this story, a bot review comment on any PR produced by the SwarmClaw protocol is detected and re-enters the protocol loop using only code merged by this story. No stub, no `TODO: wire later`, and no sibling story is required to make this behavior real. Predecessors (P1.15) are dependency edges, not unfinished wiring inside this story.

**Dependency edges (predecessors):** P1.15

## Acceptance Criteria

1. **(make-or-break)** Given a GitHub PR comment webhook where `comment.user.type === "Bot"`, When SwarmClaw's webhook endpoint receives it, Then the comment is identified as a bot review comment and the protocol state is updated to "review_feedback_detected".
2. Given a GitHub PR comment webhook where `comment.user.type === "User"` (human), When SwarmClaw's webhook endpoint receives it, Then the comment is ignored and no protocol state change occurs.
3. Given a webhook payload with an invalid GitHub signature, When the endpoint receives it, Then the request is rejected with 403 and no protocol state change occurs.
4. Given multiple bot review comments on the same PR, When each webhook arrives, Then the protocol state accumulates the comment references (no overwrites) and remains in "review_feedback_detected".

## Technical Notes

- **Contracts/Schema:** GitHub webhook payload for `issue_comment` or `pull_request_review_comment` events includes `comment.user.type` field. Bot detection: `user.type === "Bot"` OR `user.login.endsWith("[bot]")`. Protocol state update: `{ runId, status: "review_feedback_detected", bot_comments: [{ commentId, author, bodySnippet, timestamp }] }`.
- **Integration points:** GitHub webhook → SwarmClaw `/api/webhooks/[id]` → signature validation → bot detection filter → protocol state update → signal for fix-dispatch readiness.
- **Files / functions touched:** `src/swarmclaw/routes/webhooks.ts` (add comment event handler), `src/swarmclaw/bot-detection.ts` (bot user classifier), `src/swarmclaw/protocol.ts` (state transition: summarize → review_feedback_detected).
- **Guards/limits:** Only process comments on PRs that belong to an active protocol run (correlation check). Ignore comments on closed/merged PRs. Maximum 50 bot comments tracked per run (overflow truncates oldest). Webhook processing must be idempotent (same comment ID processed twice = no duplicate state entry).

## Files to Modify

- `src/swarmclaw/routes/webhooks.ts`
- `src/swarmclaw/bot-detection.ts`
- `src/swarmclaw/protocol.ts`

## Security Invariants

- INV-1: Webhook signature validation (HMAC-SHA256) is enforced on every comment webhook — no exceptions.
- INV-2: Bot comment body is stored as a truncated snippet (max 4000 chars) to prevent injection of excessive data into protocol state while preserving sufficient context for downstream fix dispatch (P1.19).
- INV-3: Only comments on PRs correlated to active protocol runs are processed — comments on unrelated repos are silently dropped.

## Definition of Done

- [ ] **Impl:** Webhook handler for `issue_comment` and `pull_request_review_comment` events in SwarmClaw.
- [ ] **Impl:** Bot detection classifier using `user.type === "Bot"` or `user.login.endsWith("[bot]")`.
- [ ] **Impl:** Protocol state transition to "review_feedback_detected" with accumulated bot comment references.
- [ ] **Impl:** Idempotent comment processing (same comment ID → no duplicate state entry).
- [ ] **Contract:** Protocol state schema includes `bot_comments` array with commentId, author, bodySnippet, timestamp.
- [ ] **Integration:** GitHub webhook → SwarmClaw webhook endpoint → bot detection → protocol state update confirmed.
- [ ] **Security:** Webhook signature validation enforced; comment body truncated to 4000 chars.
- [ ] **Test (unit):** Bot detection classifier: given user.type="Bot" → true; user.type="User" → false; login ending "[bot]" → true.
- [ ] **Test (e2e demo — MANDATORY):** Send simulated bot review comment webhook to SwarmClaw; confirm protocol state updates to "review_feedback_detected" with comment reference stored.

## Dev Agent Record

<!-- Empty placeholder — filled during development. -->
