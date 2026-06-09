# P1.10: executionPolicy Approve/Resume via SwarmClaw Webhook

**Story Points:** 4

## Spec Reference

- PRD §3.3, §4.1; FR-OR-6, FR-CM-2

## User Story

As a dev manager,
I want to approve or reject a gated protocol step via a SwarmClaw webhook,
so that human judgment is enforced at decision points before the protocol proceeds.

## Overview

Certain protocol runs are gated at the `decide` phase by an `executionPolicy`. When a gated issue reaches the decide step, SwarmClaw pauses the run and sends a webhook notification to the registered agent endpoint. The agent (or human operator) reviews the proposal and sends an `approve` or `reject` decision via A2A JSON-RPC 2.0 call to SwarmClaw. On approve, the protocol resumes from the decide step and continues to summarize. On reject, the protocol halts with `status: 'rejected'`. All gate decisions are logged with full context (who, when, why) for audit.

## E2E Slice

**Demonstrable behavior:** A protocol run for a gated issue reaches the `decide` phase. SwarmClaw pauses the run and fires a webhook to the registered agent callback URL. The agent sends `approve` via A2A JSON-RPC 2.0 (`method: 'executionPolicy.approve'`). SwarmClaw resumes the run from decide → summarize. If the agent sends `reject`, the run halts with `status: 'rejected'`. All decisions logged with timestamp, agentId, and reason.

**Wiring closed:** On completion of this story, a human gate decision (approve/reject) at the decide step drives the protocol lifecycle using only code merged by this story. No stub, no `TODO: wire later`, and no sibling story is required to make this behavior real.

**Dependency edges (predecessors):** P0.8, P1.8

## Acceptance Criteria

1. **(make-or-break)** Given a gated issue reaches the `decide` phase during a protocol run, When SwarmClaw evaluates the executionPolicy, Then the run is paused at decide, a webhook notification is sent to the registered callback URL with `runId`, `issueId`, `phase: 'decide'`, and `proposal` payload, and no further phases execute until a decision is received.
2. Given a paused run at decide, When the agent sends `approve` via A2A JSON-RPC 2.0 (`method: 'executionPolicy.approve'`, `params: { runId, decision: 'approve', reason: string }`), Then SwarmClaw resumes the run from decide → summarize and logs the approval with `agentId`, `timestamp`, and `reason`.
3. Given a paused run at decide, When the agent sends `reject` via A2A JSON-RPC 2.0, Then SwarmClaw halts the run with `status: 'rejected'`, logs the rejection, and no further phases execute.
4. Given a run is paused at decide, When no decision is received within the policy timeout (default 24h), Then the run auto-halts with `status: 'timed-out'` and a timeout event is logged.
5. Given an approve/reject request arrives with an invalid `runId` or from an unauthorized agent, When SwarmClaw validates the request, Then the request is rejected with `error: { code: -32600, message: 'Invalid request' }` and no state change occurs.

## Technical Notes

- **Contracts/Schema:** `ExecutionPolicyDecision { runId: string, issueId: number, decision: 'approve' | 'reject', reason: string, agentId: string, timestamp: ISO8601 }`. A2A JSON-RPC 2.0: `method: 'executionPolicy.approve'`, `params: { runId, decision, reason }`. Webhook payload: `{ event: 'executionPolicy.gate', runId, issueId, phase: 'decide', proposal: DecidePhaseOutput }`.
- **Integration points:** SwarmClaw `/api/webhooks/[id]` for outbound notification; SwarmClaw `/api/a2a` JSON-RPC 2.0 for inbound approve/reject; executionPolicy config per issue type; GitHub issue metadata for policy lookup.
- **Files / functions touched:** `src/protocol/execution-policy.ts` (policy evaluation + gate logic), `src/protocol/phase-executor.ts` (decide-phase pause/resume), `src/api/routes/webhook-routes.ts` (outbound webhook dispatch), `src/api/routes/a2a-routes.ts` (inbound approve/reject handler), `src/models/execution-policy.ts` (schemas).
- **Guards/limits:** Policy timeout default: 24h. Webhook retry: 3 attempts with exponential backoff. Decision idempotency: duplicate approve/reject for the same `runId` returns the first decision without state change.

## Files to Modify

- `src/protocol/execution-policy.ts`
- `src/protocol/phase-executor.ts`
- `src/api/routes/webhook-routes.ts`
- `src/api/routes/a2a-routes.ts`
- `src/models/execution-policy.ts`

## Security Invariants

- INV-POLICY-1: Only authorized agents (validated by agentId against the run's assigned agent list) may submit approve/reject decisions.
- INV-POLICY-2: A run paused at decide cannot be resumed by any mechanism other than a valid approve decision — no bypass, no auto-resume.
- INV-POLICY-3: All gate decisions (approve, reject, timeout) are logged to audit trail with `agentId`, `timestamp`, `reason`, `runId`, and `issueId`.
- INV-POLICY-4: Decision requests with invalid `runId` or unauthorized `agentId` are rejected with no state change and the attempt is logged as a security event.
- INV-POLICY-5: Inbound webhook requests delivering approve/reject decisions are validated for authenticity — the `X-Hub-Signature-256` header is verified using HMAC-SHA256 with the shared webhook secret and `crypto.timingSafeEqual` for constant-time comparison. Requests with missing or invalid signatures are rejected with 401, logged as security events, and cause no state change.

## Definition of Done

- [ ] **Impl:** Gated issue pauses protocol at `decide` phase; no further phases execute
- [ ] **Impl:** Webhook notification sent to registered callback URL with run context and proposal payload
- [ ] **Impl:** A2A JSON-RPC 2.0 `executionPolicy.approve` handler resumes run from decide → summarize
- [ ] **Impl:** A2A JSON-RPC 2.0 reject handler halts run with `status: 'rejected'`
- [ ] **Contract:** `ExecutionPolicyDecision` schema defined; A2A JSON-RPC method contract documented; webhook payload schema defined
- [ ] **Integration:** SwarmClaw `/api/webhooks/[id]` dispatch; `/api/a2a` JSON-RPC 2.0 receive; policy timeout auto-halt
- [ ] **Security:** Agent authorization check on approve/reject; invalid request rejection; decision idempotency
- [ ] **Test (unit):** Policy gate pauses at decide; approve resumes; reject halts; timeout auto-halts; invalid runId rejected; unauthorized agent rejected; idempotent duplicate decisions
- [ ] **Test (e2e demo — MANDATORY):** Full protocol run for gated issue that pauses at decide, receives approve webhook → resumes to summarize; separate run with reject → halts; separate run with timeout → auto-halts. All decisions logged.
