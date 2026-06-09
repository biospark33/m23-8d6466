# P0.8: Verify Telegram plugin behaviors against a live chat (OQ-3 + fallback)

**Story Points:** 3

## Spec Reference

- PRD §6.6 (Comms — `FR-CM`) + §6.1 (Control-plane); FR-CP-9, FR-CM-1
- PRD §13 Phase-0 item 5 exit-criterion (second clause): "OQ-3 answered against a live chat — the Telegram plugin's bidirectional `/approve`/`/status` + inline-button approval + per-type routing behaviors are each confirmed present or marked absent (gaps logged, not assumed)."
- PRD §12.2 OQ-3 (BLOCKED-on-creds → Hermes-driven Telegram gateway fallback); NFR-SEC-1, NFR-SEC-2

## User Story

As the Operator,
I want each claimed Telegram-plugin behavior probed against a live chat and recorded as present-or-absent with a concrete Hermes-gateway fallback path for every gap,
so that OQ-3 is answered with evidence (never assumption) and the Phase-1 HITL gate is never placed on an unverified plugin path (G1 accountability; R7 mitigation).

## Overview

A vertical slice that closes OQ-3 by producing a **decision record**, not by assuming a working plugin. It probes four behaviors against a live Telegram chat: bidirectional `/status`, bidirectional `/approve`, inline-button approval resuming a paused `executionPolicy` gate, and per-type routing to distinct chats. Each probe writes a row `{behavior, verdict: present|absent, evidence, fallback}`. Because the plugin SDK has **no first-class messaging/inline-button/approval-routing primitive** (R3/R4: generic webhooks/tools/launchers/jobs only) and Telegram is **BLOCKED-on-creds**, the slice's deliverable is the recorded OQ-3 outcome plus, for every `absent`, the **Hermes-driven Telegram gateway** fallback (Hermes owns the channel, sends/receives via the bot token, resumes the paused run through `issue_execution_decisions`). One atomic 3pt unit through the Paperclip-plugin / Hermes-gateway seam: the capability shipped is "every Telegram behavior decision-logged with a concrete fallback," and that is demonstrable end-to-end with only this story's probe harness + fallback wiring.

## E2E Slice

**Demonstrable behavior:** Run `scripts/oq3-verify.ts` against a live chat. For each of the four behaviors it executes the probe (send `/status`; send `/approve`; trigger an `executionPolicy` gate and tap an inline approve button; emit two message types and check routing), records `{behavior, verdict, evidence, fallback}`, and writes the OQ-3 decision log. For every `absent` verdict it asserts the **Hermes-gateway fallback** is wired and exercised (a Hermes-sent message reaches the chat and a Hermes-handled approval resumes the paused run via `issue_execution_decisions`). The run emits a complete 4-row decision log with no behavior left `unknown`.

**Wiring closed:** On completion of this story, running `scripts/oq3-verify.ts` produces a 4-row OQ-3 decision log where every behavior carries a `present`/`absent` verdict (never `unknown`) and every `absent` row carries an exercised Hermes-gateway fallback path, using only code merged by this story. No stub, no `TODO: wire later`, and no sibling story is required to make this behavior real. Predecessors, if any, are dependency edges (listed below), not unfinished wiring inside this story.

**Dependency edges (predecessors):** P0.7 (Paperclip live + Telegram + Hindsight plugins installed and listed; external Hermes registered + authenticating). This story verifies *behavior*; P0.7 delivered *install + auth*.

## Acceptance Criteria

> ≥3 scenarios, Given/When/Then. Exactly one tagged (make-or-break) and binary.

1. **(make-or-break)** Given the Telegram plugin installed (P0.7) and a live chat with a bot token supplied, When `scripts/oq3-verify.ts` runs all four probes, Then it writes an OQ-3 decision log containing exactly four rows — one per behavior (`/status`, `/approve`, inline-button approval, per-type routing) — each with a `verdict` of `present` OR `absent` and non-empty `evidence`, and **zero** rows left `unknown`/unprobed.
2. Given any behavior whose probe verdict is `absent` (or BLOCKED-on-creds), When the verifier records that row, Then the row's `fallback` field names the concrete Hermes-driven Telegram gateway path AND that fallback is exercised once (a Hermes-sent message lands in the chat; a Hermes-handled inline/`/approve` decision resumes the paused run via `issue_execution_decisions`).
3. Given the inline-button approval probe, When an approve tap (or its Hermes-gateway fallback) fires on a paused `executionPolicy` gate, Then the paused run resumes and an `approvals` row is persisted (`status`, `decidedByUserId`, `decidedAt`) — never a silent no-op.
4. Given creds are absent at run time, When the verifier cannot reach a live chat, Then it does NOT mark any behavior `present` by assumption — it records the behavior as BLOCKED with the Hermes-gateway fallback and exits non-zero (gap logged, not papered over).

## Technical Notes

- **Contracts/Schema:** OQ-3 decision-log record (JSON, written to the OQ-3 log): `{ behavior: "/status"|"/approve"|"inline_approve"|"per_type_routing", verdict: "present"|"absent"|"blocked", evidence: string, fallback: string, decidedAt: string }`. Approval resume reads/writes `approvals` (`approvals.ts:5-28`: `status`/`payload`/`decisionNote`/`decidedByUserId`/`decidedAt`) and `issue_execution_decisions` (gate decisions persisted; `issues.executionPolicy` jsonb `issues.ts:52`). No new DDL — consumes existing tables.
- **Integration points (each wired & exercised in this story):** (1) Telegram plugin probes via the live chat (`/status`, `/approve`, inline button) — per R3/R4 the SDK exposes **no native messaging primitive**, so probes that fail route to (2). (2) **Hermes-driven Telegram gateway fallback** — Hermes owns the bot token, sends/receives chat messages, and resumes the paused Archon run by writing an `issue_execution_decisions` + `approvals` record. (3) `executionPolicy` gate pause/resume on the issue (FR-OR-6 capability is a Phase-1 successor; here the gate is exercised only enough to prove approval resume).
- **Files / functions touched:** `scripts/oq3-verify.ts` (probe runner + decision-log writer); Hermes-gateway send/approve handler. Reference `approvals.ts:5-28`, `issues.ts:52`.
- **Guards/limits:** every chat call carries the bot token from env (never hardcoded); the verifier never blocks unbounded — each probe has a wall-clock timeout, on which it records `blocked` + fallback rather than hanging.

## Files to Modify

> ≤10 unique paths.

- `scripts/oq3-verify.ts`
- `scripts/hermes-telegram-gateway.ts`
- `config/telegram.env.example`
- `_bmad-output/sprint-artifacts/phase-0/oq3-decision-log.json`
- `tests/p0/oq3-telegram-verify.e2e.test.ts`
- `tests/p0/hermes-gateway-fallback.test.ts`

## Security Invariants

> REQUIRED & non-empty — auth and secrets/env triggers apply.

- **INV-1 (NFR-SEC-1 secrets hygiene):** the Telegram bot token and chat ids are read from env/secret refs only (`config/telegram.env.example` documents names, holds no real values); no token or chat id is hardcoded or written to stdout, logs, or the decision log's `evidence` field.
- **INV-2 (NFR-SEC-2 auth on resume):** the Hermes-gateway fallback resumes a paused run only as the registered, bearer-authenticated agent (the P0.7 `PAPERCLIP_API_KEY` + `PAPERCLIP_RUN_ID`); an approval decision written to `approvals`/`issue_execution_decisions` always carries an authenticated `decidedByUserId`/actor — never an anonymous resume.
- **INV-3 (no assumed-pass):** no behavior is recorded `present` without live `evidence`; a creds/chat-unreachable condition is recorded `blocked` with its fallback, never silently upgraded to `present` (anti-assumption invariant — the core OQ-3 guarantee).

## Definition of Done

> 8–12 high-signal, story-specific boxes.

- [ ] **Impl:** `scripts/oq3-verify.ts` probes all four behaviors (`/status`, `/approve`, inline approve, per-type routing) against the live chat and writes one decision-log row each.
- [ ] **Impl:** `scripts/hermes-telegram-gateway.ts` sends/receives chat messages via the bot token and resumes a paused run by writing `issue_execution_decisions` + `approvals`.
- [ ] **Impl:** the verifier exits non-zero when creds/chat are unreachable, recording `blocked` + fallback (never a silent pass).
- [ ] **Contract:** OQ-3 decision-log record schema enforced (`behavior`/`verdict`/`evidence`/`fallback`/`decidedAt`); `verdict` constrained to `present|absent|blocked`.
- [ ] **Integration:** for every `absent`/`blocked` behavior, the Hermes-gateway fallback is exercised once — a Hermes message reaches the chat and a Hermes-handled approval resumes the paused run.
- [ ] **Observability:** the OQ-3 decision log is written to `phase-0/oq3-decision-log.json` with per-behavior evidence, so the OQ-3 answer is reconstructable and auditable.
- [ ] **Security:** bot token/chat ids sourced from env only and never logged (NFR-SEC-1); fallback resume runs only as the bearer-authenticated registered agent (NFR-SEC-2) — both asserted by test.
- [ ] **Test (unit/integration):** decision-log schema, the `blocked`-on-no-creds path, and the authenticated-resume guard are covered.
- [ ] **Test (e2e demo — MANDATORY):** run `scripts/oq3-verify.ts` against a live chat; assert a complete 4-row decision log (no `unknown`) AND that each `absent`/`blocked` row's Hermes-gateway fallback is exercised (message lands + paused run resumes via `issue_execution_decisions`) — proving wiring closed.

## Dev Agent Record

<!-- Empty placeholder — filled during development. -->
