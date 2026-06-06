# P1.10: Gated issue pauses the run; a Telegram approve tap resumes it

**Story Points:** 4

## Spec Reference

- PRD §6.3 (Orchestration — Archon DAG) + §6.6 (Comms); FR-OR-6 (pause at approval node → resume on approval / halt-clean on reject, no partial/corrupt state), FR-CM-2 (surface approval gate as Telegram msg with inline approve/reject buttons, resume paused run on tap)
- Supporting: FR-CP-5 (`executionPolicy` defines when a human-approval gate is required), FR-CP-6 (persist every approval + execution-gate decision); NFR-SEC-1, NFR-SEC-2
- Phase exit gate: PRD §13 Phase-1 — human-in-the-loop gate drives the run (gate→ping→resume), with the §12.2 OQ-3 fallback honored

## User Story

As an external stakeholder approving high-risk work,
I want a gated issue to pause its Archon run, ping me on Telegram with inline approve/reject buttons, and resume (or halt-clean) when I tap,
so that a human decision genuinely drives the run and the outcome is persisted as an auditable approval (G1 accountability; G4 human-on-the-loop control).

## Overview

A vertical slice through the §6.6 comms front-door into the §6.3 pause/resume seam. It cuts: an issue carrying an `executionPolicy` gate (`issues.executionPolicy` jsonb `issues.ts:52`) → an Archon approval node that **pauses** the run (Archon `RESUMABLE={failed,paused}` `workflow-run.ts:29-32`) → a Telegram message with inline approve/reject buttons → the tap's callback → resume on approve OR clean halt/cancel on reject, with the decision persisted to `approvals` (`approvals.ts:5-28`) + `issue_execution_decisions`. Because OQ-3 is BLOCKED-on-creds and the Paperclip plugin SDK has **no first-class messaging/inline-button primitive** (R3/R4), the approval surface routes through the **Hermes-driven Telegram gateway** (Hermes owns the bot token, sends the inline buttons, handles the callback, and resumes the paused run as the bearer-authenticated agent) — this is an explicit AC/Technical-Note, not an assumed plugin path. One atomic 4-pt unit: a single gated run that pauses, pings, and resumes/halts on a real tap, with P0.8 (OQ-3 verified + gateway proven) and P1.8 (launcher substrate) as dependency edges.

## E2E Slice

**Demonstrable behavior:** An issue with an `executionPolicy` requiring approval launches an Archon run; the run reaches the approval node and **pauses** (run state `paused`). The Hermes-Telegram gateway sends the chat an inline approve/reject message. On an **approve** tap, the callback resumes the paused run (state leaves `paused`, run completes) and writes one `approvals` row (`status:"approved"`, `decidedByUserId`, `decidedAt`) + an `issue_execution_decisions` record. On a **reject** tap, the run **halts/cancels cleanly** (no partial/corrupt state) and writes `status:"rejected"`. The decision visibly drives the run — the run never advances past the gate without a recorded tap.

**Wiring closed:** On completion of this story, a gated issue's run **pauses at the approval node, pings Telegram with inline buttons, and an approve tap resumes it to completion (reject halts clean)** — with the decision written to `approvals` + `issue_execution_decisions` — using only code merged by this story (the approval-node pause hook, the gateway send/callback handler, and the resume/halt + decision-writer). No stub, no `TODO: wire later`, and no sibling story is required to make this behavior real. Predecessors, if any, are dependency edges (listed below), not unfinished wiring inside this story.

**Dependency edges (predecessors):** P0.8 (OQ-3 verified against a live chat; the Hermes-driven Telegram gateway send + inline-approve + paused-run-resume path is proven and the bot-token wiring exists — this story consumes that gateway). P1.8 (launcher substrate the gated run executes on).

## Acceptance Criteria

> ≥3 scenarios, Given/When/Then. Exactly one tagged (make-or-break) and binary.

1. **(make-or-break)** Given an issue whose `executionPolicy` requires approval and a launched Archon run, When the run reaches the approval node and a stakeholder **taps approve** on the Telegram inline message (or its Hermes-gateway equivalent), Then the run leaves `paused` and **resumes to completion**, AND exactly one `approvals` row exists with `status:"approved"` + non-empty `decidedByUserId`/`decidedAt` AND a matching `issue_execution_decisions` record — i.e. the human tap provably drove the run from pause to completion.
2. Given the same paused run, When the stakeholder **taps reject**, Then the run **halts/cancels cleanly** with no partial or corrupt working state (FR-OR-6), and an `approvals` row is written with `status:"rejected"` — never a silent continue or a stuck-paused run.
3. Given the gated run reaches the approval node, When no decision has been recorded yet, Then the run **stays paused** and does NOT advance past the gate — the gate cannot be skipped by absence of a tap.
4. Given Telegram is BLOCKED-on-creds (OQ-3, R4), When the gate fires, Then the approval surface is served by the **Hermes-driven Telegram gateway fallback** (Hermes sends the inline message and handles the callback as the registered bearer-authenticated agent), and the resume/halt + `approvals`/`issue_execution_decisions` write happens **identically** through that path — the gate is never bypassed or assumed-approved because the plugin is unavailable.

## Technical Notes

- **Contracts/Schema:** No new tables — consumes existing `issues.executionPolicy` jsonb (`issues.ts:52`), `approvals` (`approvals.ts:5-28`: `status`/`payload`/`decisionNote`/`decidedByUserId`/`decidedAt`), and `issue_execution_decisions`. Telegram callback contract (JSON): `{ runId: string, issueId: string, decision: "approve"|"reject", decidedByUserId: string, decidedAt: string (datetime), via: "telegram_plugin"|"hermes_gateway" }`; `via` records which path served the gate (auditability of the fallback). Backward-compatible: an issue with no `executionPolicy` gate runs unchanged (no pause).
- **Integration points (each wired & exercised in this story):** (1) approval-node **pause** on the Archon run (`RESUMABLE={failed,paused}` `workflow-run.ts:29-32`); (2) **Hermes-driven Telegram gateway** sends the inline approve/reject message and handles the callback — per R3/R4 the Paperclip plugin SDK has no native inline-button primitive, so this is the load-bearing surface (BLOCKED-on-creds → gateway fallback, explicit per AC 4); (3) **resume** the paused run on approve / **clean halt-cancel** on reject; (4) persist the decision to `approvals` + `issue_execution_decisions`, rolled to `issues.status`. Resume runs only as the registered agent (`PAPERCLIP_API_KEY` + `PAPERCLIP_RUN_ID`, `adapters/registry.ts:468-469`).
- **Files / functions touched:** `src/orchestration/approval-node.ts` (pause hook + resume/halt), `src/hermes/telegram-gateway-approval.ts` (inline send + callback → decision), `src/db/approvals.ts:recordApprovalDecision` (write `approvals` + `issue_execution_decisions`). References `issues.ts:52`, `approvals.ts:5-28`, `workflow-run.ts:29-32`.
- **Guards/limits:** the run cannot advance past the approval node without a recorded decision (no timeout auto-approve); the Telegram callback carries the bot token from env only; resume/halt are authenticated and idempotent on `runId` (a duplicate tap does not double-resume or write a second conflicting `approvals` row).

## Files to Modify

> ≤10 unique paths.

- `src/orchestration/approval-node.ts`
- `src/hermes/telegram-gateway-approval.ts`
- `src/db/approvals.ts`
- `config/telegram.env.example`
- `tests/orchestration/approval-pause-resume.test.ts`
- `tests/orchestration/approval-resume.e2e.test.ts`

## Security Invariants

> Triggers: auth, secrets/env. Concrete named invariants only.

- **INV-1 (NFR-SEC-2 authenticated resume):** the paused run is resumed (or halted) only by the registered, bearer-authenticated agent (`PAPERCLIP_API_KEY` + `PAPERCLIP_RUN_ID`, `adapters/registry.ts:468-469`); every `approvals`/`issue_execution_decisions` write carries an authenticated `decidedByUserId` — never an anonymous or unauthenticated resume.
- **INV-2 (NFR-SEC-1 secrets hygiene):** the Telegram bot token and chat ids are read from env/secret refs only (`config/telegram.env.example` documents names, holds no real values); no token, chat id, or callback secret is hardcoded or written to stdout, logs, or the `approvals.payload`/`decisionNote` fields.
- **INV-3 (gate cannot be bypassed):** the run cannot advance past the approval node without a persisted decision — there is no timeout-auto-approve and no code path that resumes on absence of a tap; an unavailable Telegram plugin routes to the Hermes-gateway fallback, never to an assumed-approved continue (the core HITL guarantee).
- **INV-4 (idempotent decision):** resume/halt is idempotent on `runId` — a replayed or duplicate inline-button callback does not double-resume the run nor write a second conflicting `approvals` row.

## Definition of Done

> 8–12 high-signal, story-specific boxes.

- [ ] **Impl:** the approval node **pauses** the Archon run (state `paused`) when the issue's `executionPolicy` requires approval, and does not advance without a recorded decision.
- [ ] **Impl:** the Hermes-Telegram gateway sends an inline approve/reject message to the chat and handles the tap callback into a decision.
- [ ] **Impl:** an approve tap **resumes** the paused run to completion; a reject tap **halts/cancels cleanly** (no partial/corrupt state, FR-OR-6).
- [ ] **Contract:** the Telegram callback contract (`runId`/`issueId`/`decision`/`decidedByUserId`/`decidedAt`/`via`) is field-validated; an issue with no `executionPolicy` runs unchanged (backward-compatible).
- [ ] **Integration:** the decision is persisted to `approvals` (`status`/`decidedByUserId`/`decidedAt`) + `issue_execution_decisions`, and the resume/halt is wired to the run state — exercised end-to-end, not stubbed.
- [ ] **Observability:** the served path is recorded via the callback `via` field (`telegram_plugin`|`hermes_gateway`) so the OQ-3 fallback usage is auditable, and the gate decision correlates to the issue id (NFR-OBS-3).
- [ ] **Security:** resume runs only as the bearer-authenticated registered agent (NFR-SEC-2); bot token/chat ids are env-sourced and never logged (NFR-SEC-1); the gate cannot be bypassed by tap-absence — all asserted by test.
- [ ] **Technical-Note honored (OQ-3, R4):** the Telegram BLOCKED-on-creds path is served by the **Hermes-gateway fallback** (explicit AC 4) — the gate is never assumed-approved because the plugin is unavailable; a duplicate callback is idempotent on `runId`.
- [ ] **Test (unit/integration):** the pause-without-decision hold, the reject clean-halt, and the duplicate-callback idempotency are each covered.
- [ ] **Test (e2e demo — MANDATORY):** launch a gated issue's run; assert it pauses at the approval node and pings Telegram (or the Hermes-gateway), then an approve tap resumes it to completion with one `approvals(status:approved)` + `issue_execution_decisions` row (and a reject variant halts clean) — proving the human gate drives the run; wiring closed.

## Dev Agent Record

<!-- Empty placeholder — filled during development. -->
