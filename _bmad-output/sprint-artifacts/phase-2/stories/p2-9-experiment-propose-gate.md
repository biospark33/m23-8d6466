# P2.9: Propose A/B Experiment and Enforce the One Human Approval Gate

**Story Points:** 3

## Spec Reference

- QDS-MEM-003 §8.1–8.2 (A/B Experiment Lifecycle; the single human gate), §4.1 (experiments CHECK constraint); §B.2 state machine
- QDS-MEM-003-IMPL §D.3 (optimizer propose path); §C D6 (experiment subsystem); §D.4 (sync `db.transaction`); §H R1/R10/R11

## User Story

As a QDS optimization steward,
I want the optimizer agent to propose skill A/B experiments into a durable `experiments` row and gate every proposal behind exactly one authenticated human approve/reject decision,
so that no variant is ever advanced toward execution without a recorded, accountable human owner (G6 — human-in-the-loop autonomy guardrail).

## Overview

This story wires the front of the A/B experiment lifecycle end-to-end: the optimizer agent scans recent operational runs (the P2.1 `runs`/`events` store), writes one `proposed` `experiments` row (§C DDL), and the single human gate flips that row to `approved` or `rejected` via CLI/UI. It touches four layers — the optimizer propose path, the `experiments` store with its `CHECK` status enum, the shared state machine, and the gate authorization boundary — which must close together because a proposal with no enforceable gate, or a gate with no audited actor, defeats the §8.2 "one human gate" mandate. The §8.2 second gate at deploy was considered and rejected, so this is THE gate for the whole lifecycle. This story AUTHORS `src/experiments/state-machine.ts` (R10) — the complete §B.2 legal-transition table with per-entrypoint guards — which P2.10/P2.11 reuse. Every transition is emitted as an `events` row (`event_type='outcome'`, audit trail), FK-bound to a synthetic experiment-lifecycle run (R1). The lifecycle `runs` row this story opens (`run_id="experiment:<id>"`, `status='running'`) is NOT left `running` forever: P2.11 CLOSES it to `runs.status='completed'` on the terminal verdict (confirmed | rolled_back), and the P2.10 `winner='none'` terminal no-op also closes it `completed`; this keeps lifecycle events eligible for P2.12 retention (which excludes only `status='running'` runs). The optimizer's per-experiment LLM scan is the only LLM work here (INV-OM1 carve-out); the gate and the writes are mechanical. Wiring closes with no stub and no `TODO: wire later`.

## E2E Slice

**Demonstrable behavior:** Run the optimizer propose command against a seeded set of recent runs; it creates a synthetic lifecycle run (`run_id="experiment:<experiment_id>"`, `dag_def_id="__experiment_lifecycle__"`) and writes one `experiments` row with `status='proposed'`, `skill`, `hypothesis`, `variant_a_ref`, `variant_b_ref`, `metric='success_rate'`, and `proposed_at`. Then call the gate CLI `experiment approve <id> --actor alice` (where `alice` is in the authorized-actor allowlist) and observe the row flip to `status='approved'` with `approved_at` set and `approved_by='alice'`, and a corresponding `outcome` event written to `events` (FK to the lifecycle run) recording the `proposed→approved` transition.

**Wiring closed:** On completion of this story, proposing an experiment and approving or rejecting it through the human gate produces a state-machine-correct, fully audited `experiments` row using only code merged by this story and predecessors P2.1 + P2.8. No stub, no `TODO: wire later`, and no sibling story is required to make this behavior real.

**Dependency edges (predecessors):** P2.1 (the `experiments` table + the `runs`/`events` operational store the optimizer scans — hard data dep); P2.8 (promotion/retain ordering).

## Acceptance Criteria

> ≥3 scenarios, Given/When/Then. Exactly one tagged (make-or-break) and binary.

1. **(make-or-break)** Given a `proposed` experiment row and an actor present in the authorized-actor source (`QDS_EXP_ACTORS` allowlist), When `experiment approve <id> --actor alice` is invoked, Then the row transitions to `status='approved'` with `approved_at` non-null, `approved_by='alice'`, and `decided_at` set, AND exactly one audit `outcome` event is written to `events` (FK to the `experiment:<id>` lifecycle run) recording the `proposed→approved` transition with `experiment_id=<id>`.
2. Given a set of recent runs with a measurable skill regression, When the optimizer propose command runs, Then a synthetic lifecycle run is created and exactly one `experiments` row is written with `status='proposed'`, `proposed_at` set, and `metric` ∈ {`success_rate`, `token_cost`, `duration`, `review_findings`}; any other `metric` value is rejected before write.
3. Given a `proposed` experiment, When `experiment reject <id> --actor bob --reason "underpowered"` is invoked by an authorized actor, Then the row transitions to `status='rejected'` with `decided_at` and `approved_by='bob'` recorded, `approved_at` left NULL, and a `proposed→rejected` audit event is written.
4. Given a well-formed but UNKNOWN actor (e.g. `--actor mallory`, NOT in `QDS_EXP_ACTORS`), When approve/reject is invoked, Then the request is rejected, `status='proposed'` is unchanged, and NO transition event is written — authorization keys on the allowlist, not on a hardcoded test name.
5. Given an experiment already in `approved` (or `rejected`), When approve/reject is invoked again via the GATE entrypoint, Then the transition is refused (illegal-transition guard for the gate entrypoint), the row is unchanged, and NO audit event is written — the gate is single-shot per proposal.
6. Given a `proposed`/`approved`/`running` (open) experiment exists for a skill+variant pair, When the optimizer proposes the same skill+variant pair again, Then propose is skipped (dedup guard, anti-pile-up) and no second `proposed` row is written.
7. Given a propose attempt, When the optimizer tries to write a row with `status` other than `proposed` or to set `approved_by`/`approved_at` itself, Then the write is rejected — there is NO auto-approve path; only the gate may set `approved_at`/`approved_by`.
8. Given a propose attempt with `variant_a_ref == variant_b_ref`, When the optimizer runs, Then the proposal is rejected before write (degenerate A/B contrast) — `variant_a_ref ≠ variant_b_ref` is enforced so the contrast and INV-EXP6 provenance are meaningful.

## Technical Notes

- **Contracts/Schema:** Uses the §C `experiments` DDL verbatim (do not redefine the table). Fields written by propose: `experiment_id`, `skill`, `hypothesis`, `variant_a_ref`, `variant_b_ref`, `metric`, `status='proposed'`, `proposed_at`, `created_at`; plus the synthetic `runs` row (`run_id="experiment:<id>"`, `dag_def_id="__experiment_lifecycle__"`, `status='running'`, `started_at`). Fields written by the gate: `status`, `approved_at` (approve only), `approved_by`, `decided_at`. Note: `approved_by` is overloaded as "the deciding actor" for BOTH approve and reject; the two are disambiguated by `status` (the row's `approved_at` is NULL on reject).
  ```typescript
  const MetricEnum = z.enum(["success_rate", "token_cost", "duration", "review_findings"]);
  const ProposeExperimentSchema = z.object({
    skill: z.string().min(1),
    hypothesis: z.string().min(1),
    variant_a_ref: z.string().min(1),
    variant_b_ref: z.string().min(1),
    metric: MetricEnum,
  }).refine((p) => p.variant_a_ref !== p.variant_b_ref, {
    message: "variant_a_ref must differ from variant_b_ref (non-degenerate A/B contrast)",
  }); // status/approved_* are NOT accepted from propose input — server sets status='proposed'
  const GateDecisionSchema = z.object({
    experiment_id: z.string().min(1),
    decision: z.enum(["approve", "reject"]),
    actor: z.string().min(1),      // must be in QDS_EXP_ACTORS → recorded as approved_by
    reason: z.string().optional(),
  });
  // R10: state-machine.ts authored here. Per-entrypoint legal edges:
  //   gate:    proposed→approved | proposed→rejected
  //   execute: approved→running, running→analyzed         (owned/used by P2.10)
  //   deploy:  analyzed→deployed                          (owned/used by P2.10)
  //   confirm: deployed→confirming→confirmed|rolled_back  (owned/used by P2.11)
  ```
- **AuthZ trust root:** authorized actors come from the `QDS_EXP_ACTORS` env allowlist (comma-separated), surfaced via `experiments.authorized_actors` config; provenance of this allowlist is owned by THIS story. The gate resolves the actor against the allowlist before any flip; a well-formed unknown actor is rejected (so a test cannot pass via a hardcoded literal name).
- **Integration points (each wired & exercised in this story):**
  - Optimizer propose entrypoint → synthetic lifecycle `runs` INSERT + `experiments` INSERT (status `proposed`), with skill+variant dedup guard against open experiments
  - Gate CLI/UI `approve`/`reject` → authZ allowlist check → `experiments` UPDATE (status `approved`|`rejected`)
  - Transition emitter → `events` INSERT (`event_type='outcome'`, carries `experiment_id`, FK to `experiment:<id>` run) per transition (P2.1 store)
  - State machine (`state-machine.ts`) gates every flip via the per-entrypoint legal-transition table
- **Files / functions touched:** `src/experiments/propose.ts` (optimizer scan→lifecycle-run+row, dedup), `src/experiments/gate.ts` (authZ allowlist + transition), `src/experiments/state-machine.ts` (AUTHOR: complete §B.2 table + per-entrypoint guards + atomic transition emitter — owns the `db.transaction` flip+event), `src/cli/experiment.ts` (approve/reject commands).
- **Guards/limits:** legal-transition table is the single source of truth (illegal transition for the entrypoint throws, no row mutation); gate is single-shot (only `proposed` is gateable); transition event write + status flip happen in ONE `db.transaction(fn)` (sync per §D.4) owned by `state-machine.ts` (no flip without audit, no audit without flip); propose never sets `approved_*`; metric constrained to the four-value enum; propose dedup skips when an open (proposed/approved/running) experiment exists for the same skill+variant; propose runs single-instance (cron, no concurrent invocation) so the check-then-insert race cannot occur, and the skip is additionally backed by a partial UNIQUE index on `(skill, variant_a_ref, variant_b_ref) WHERE status IN ('proposed','approved','running')` so a duplicate open row is rejected at the DB even under a hypothetical race.

## Files to Modify

> ≤10 unique paths, one per line.
- `src/experiments/propose.ts`
- `src/experiments/gate.ts`
- `src/experiments/state-machine.ts`
- `src/cli/experiment.ts`
- `tests/experiments/propose.test.ts`
- `tests/experiments/gate-authz.test.ts`
- `tests/experiments/state-machine.test.ts`

## Security Invariants

> Concrete named invariants only — N/A NOT permitted when triggered.

- **INV-OM1:** No per-event LLM/HTTP. The optimizer's propose-time LLM scan is the only sanctioned LLM work here (§B.1 per-experiment optimization carve-out); the gate decision and all status flips are mechanical with zero network egress.
- **INV-OM2:** Every audit transition `events` row is written with non-null `run_id` referencing a real `runs` row; lifecycle events use the synthetic `experiment:<id>` run (`dag_def_id="__experiment_lifecycle__"`, created at propose time, opened `status='running'` and later CLOSED to `status='completed'` by P2.11 on terminal verdict or by the P2.10 `winner='none'` terminal no-op — never left `running` forever, so lifecycle events remain P2.12-retention-eligible) — never NULL, never a silent drop.
- **INV-EXP1 (human authZ on the gate):** Only an actor present in the `QDS_EXP_ACTORS` allowlist may flip `proposed→approved|rejected`; the flipping actor is recorded in `approved_by`. A well-formed unknown actor mutates no row and emits no event.
- **INV-EXP2 (audit event per transition):** Every legal status transition writes exactly one `events` row in the SAME `db.transaction` as the flip; a crash between flip and event leaves NEITHER (atomicity owned by `state-machine.ts`) — no flip-without-audit, no audit-without-flip.
- **INV-EXP3 (no auto-approve path):** The optimizer/propose path can only write `status='proposed'` and can never set `approved_at`/`approved_by`; advancement past `proposed` is reachable only through the human gate.

## Definition of Done

> 8–12 high-signal, story-specific boxes.

- [ ] **Impl:** Optimizer propose creates the synthetic `experiment:<id>` lifecycle run then writes exactly one `experiments` row with `status='proposed'`, `proposed_at`, and the five proposal fields; never sets `approved_*`; skips on the skill+variant open-experiment dedup guard.
- [ ] **Impl:** Gate `approve` flips `proposed→approved` (sets `approved_at`+`approved_by`+`decided_at`); `reject` flips `proposed→rejected` (sets `approved_by`+`decided_at`, leaves `approved_at` NULL); both single-shot (refuse non-`proposed` rows).
- [ ] **Impl (R10):** `state-machine.ts` authored with the COMPLETE §B.2 legal-transition table and PER-ENTRYPOINT guards (gate/execute/deploy/confirm); P2.10/P2.11 reuse it (no reimplementation).
- [ ] **Contract:** `ProposeExperimentSchema` and `GateDecisionSchema` validated on all inputs; `metric` constrained to the four-value enum; status enum matches §C `CHECK`.
- [ ] **Integration (atomicity):** Transition flip + audit `outcome` event (carrying `experiment_id`, FK to the lifecycle run) execute in ONE `db.transaction(fn)` owned by `state-machine.ts`, exercised against the P2.1 store.
- [ ] **Security:** INV-EXP1 enforced — actor resolved against `QDS_EXP_ACTORS`; a well-formed unknown actor mutates no row and emits no event; `approved_by` recorded for every flip.
- [ ] **Security:** INV-EXP3 enforced — no code path lets propose or any non-gate caller set `approved_at`/`approved_by` (no auto-approve).
- [ ] **Security:** INV-EXP2 + INV-OM1/OM2 enforced — one `outcome` audit event per transition, FK to the synthetic `experiment:<id>` run (non-null `run_id`); propose LLM scan is the only LLM work, gate has zero network egress.
- [ ] **Test (unit):** GATE-entrypoint legal-transition test accepts only `proposed→approved` and `proposed→rejected`; refusals are scoped to the gate entrypoint (does NOT assert global illegality of later edges like `approved→running`).
- [ ] **Test (unit):** Propose rejects a payload with `metric` outside the four-value enum, rejects any attempt to supply `status`/`approved_by` in input, rejects `variant_a_ref == variant_b_ref` (degenerate contrast), and skips a duplicate open skill+variant proposal.
- [ ] **Test (authZ + atomicity):** A well-formed unknown actor (not a literal test name) leaves `status='proposed'` and writes zero events; an authorized actor flips state and records `approved_by`; a simulated crash between flip and event write leaves NEITHER applied.
- [ ] **Test (e2e demo — MANDATORY):** Seed recent runs → run optimizer propose → assert one `proposed` row + synthetic `experiment:<id>` run → `experiment approve <id> --actor alice` → assert `status='approved'`, `approved_by='alice'`, `approved_at` set, AND one `proposed→approved` `outcome` audit event present in `events` (FK to the lifecycle run) with matching `experiment_id`.

## Dev Agent Record

<!-- Empty placeholder — filled during development. -->
