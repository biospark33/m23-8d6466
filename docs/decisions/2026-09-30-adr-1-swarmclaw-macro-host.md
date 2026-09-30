# ADR-1: SwarmClaw hosts macro processes via `external_job`; the fleet stays the only way code changes enter

- **Status:** PROPOSED — awaits operator signature (the reversal is a human decision, not a PR merge)
- **Date:** 2026-09-30
- **Reverses:** [DD-7](../../docs/superpowers/specs/2026-08-11-v5-story-derivation-decisions.md) ("SwarmClaw = host-side service chassis for factory query surfaces … NOT the factory front door")
- **Scope of reversal:** exactly as far as the research memo's row — *"SwarmClaw hosts macro processes via `external_job`; the fleet stays the only way code changes enter"* (`docs/planning/2026-09-23-openrig-swarm-integration-research.md:403`). No further.

## Context

DD-7 assigned SwarmClaw a dormant role: HTTP chassis for factory query surfaces, never the front door. Since then the dark-factory integration (SC1–SC2, swarmclaw PR #644, QDS PRs #374–#381) landed the `external_job` step: a swarmclaw protocol step that persists a request id, submits work to the QDS fleet through `$SWARMCLAW_FACTORY_FLEET_CLI`, parks, and is woken by the daemon poller with a `factory_result` verdict. The SC2.6/SC2.7 live rounds proved the whole path on the real substrate — including the crash-window idempotency (exactly one box through a mid-submit kill) and the approve gate (a live protocol ran factory_run end-to-end, parked at `awaiting-approval`, and was decided by the scrypt-gated approve seam (exercised by a scripted approver in the SC2.7 live round; the human-actor protocol is ADR-2's subject)).

Macro processes — the long-running, multi-step, stateful workflows swarmclaw already orchestrates (protocols, DAGs, schedules, agents) — are exactly the shape the factory's one-shot DAG does not want to become. Hosting them in swarmclaw keeps one orchestrator for process state and one substrate (the fleet) for consequential work.

## Decision

1. **SwarmClaw hosts macro processes via `external_job`.** A macro process is a swarmclaw protocol whose consequential step(s) are `external_job` steps. Swarmclaw owns process state, scheduling, branching, and notification; the QDS fleet owns provisioning, spend, execution, and the verdict.
2. **The fleet stays the only way code changes enter.** Every code-affecting run is a fleet run: brief-validated, budget-gated, box-isolated, harvested, and (until ADR-2) human-approved (the accepted #382 poller-race gap noted in Consequences applies until its fix lands). Nothing in swarmclaw executes code changes on the operator's host or merges anything by itself.
3. **The approve gate is the ONE seam this ADR relaxes.** DD-7's "front door is the tier-1 CLI" is amended: the door now also opens through a swarmclaw protocol that ends at the gate. The gate itself does not move — `fleet approve` stays scrypt-gated, allowlisted, token-on-stdin, human-only.
4. **Auto-approve is out of scope here.** Relaxing the gate to a policy (factory-run PRs auto-merged by default, QA owned by 24/7 Hermes agents in swarmclaw/zeropoint, consuming `fleet result`'s payload as the QA verdict carrier) is its own future ADR and is explicitly NOT decided by this document.

## Consequences

- The `ProtocolExternalJobConfig` shape (repoSlug/repoUrl/commitSha/manifestPath, exactly one of issueId|workId, groupCapUsd, pollTimeoutMs) is the macro-process → factory contract; grammar changes go through both sides' reviews (#380's identity-grammar finding is the live example).
- Two known gaps are accepted until fixed: the observe-chain poller race (#382 — a poller can complete a step pre-gate) and headless `workId` briefs not booking spend (#380 — macro work carries a numeric issueId for now).
- DD-7's query-surface chassis role stands unchanged; this ADR only adds the `external_job` hosting role on top of it.

## Signature

| | |
|---|---|
| **Operator (Steve)** | ______________________  _(sign to move this ADR PROPOSED → ACCEPTED; the program closes on the signature)_ |
| **Date** | ______________________ |
