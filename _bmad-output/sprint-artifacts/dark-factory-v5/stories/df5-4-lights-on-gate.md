# DF5.4: Lights-On Exit Gate on the P0.11 Chassis

**Story Points:** 3
**Sprint:** v5-S3 (observability, audit, and the loop)

## Spec Reference

- `docs/superpowers/specs/2026-08-11-dark-factory-v5-architecture-design.md` **§8 step 5** (channel →
  fleet → team → gates → bundle → host-side re-verify → PR with audit chain and cost ledger),
  §6 items 4/6, §5.3; decision register v5 §4 **D8**, **D3**, §10 **F10**
- Derivation decisions: `2026-08-11-v5-story-derivation-decisions.md` **DD-1** (operator-CLI-only —
  the operator *is* the channel), **DD-4** + **§4 row 3** (VOID retain link), **DD-8**, **DD-9**
- Chassis — **cite to the chassis, not to P1.17 prose** (R2 §9): `src/gate/gate-runner.ts`
  (`GateAssertion:45`, `GateCheckOutcome:39`, `runGate:144`, `RunGateOptions:130`, VOID `:167-178`,
  SKIP-is-not-a-pass `:211-212`, no-live-assertions-is-FAIL `:324-326`, `GateReport:88`,
  `GateReportSchema:117`, non-blocking-check `:66-68`); driver template `scripts/phase0-exit-gate.ts`;
  shared shell `src/gate/assertions/lib/verdict.ts`; evidence field `src/gate/verifier-child.ts:33`;
  coverage `tests/gate/phase0-exit-gate.test.ts` (45 cases)
- Surviving clauses: R2 §9 — `p1-17-phase1-exit-gate.md:30` (per-clause FAIL with evidence), `:31`
  (determinism), `:35` (G4 non-mutating pattern), `:38` (budgets, read-only), `:48-50` (INV-1..3).
  The §13 Phase-1 clause list dies; the clause set re-derives from §8 step 5. Facts: R5 §6 **15–18**.

## User Story

As the operator deciding whether the Dark Factory is actually finished,
I want one read-only command that asserts each clause of §8 step 5 against host-side evidence and
prints a per-clause verdict with its reason,
so that "the lights are on" is a green report I can re-run, not a demo I remember going well.

## Overview

`scripts/df5-lights-on-gate.ts` mirrors `scripts/phase0-exit-gate.ts`: a clause-map header, a
`buildAssertions()` assembling eleven live `GateAssertion`s plus one VOID clause, `runGate` from the
unchanged P0.11 chassis, a rendered table, exit `0`/`1`/`2`. Each clause asserts against a
**host-side** record from a completed lights-on run — fleet dispatch, box lifecycle, team envelope,
gate evidence, verified bundle, DF5.1's re-verify, DF3.4's approval, DF5.2's PR, DF5.3's chain,
DF2.8's ledger. Nothing is simulated or mutated; a red gate blocks §8 step 6 — this is the
sprint-3 exit gate for the whole DF backlog.

## E2E Slice

**Demonstrable behavior:** Given a completed lights-on run of record whose host-side evidence is on
disk, When the operator runs `bun scripts/df5-lights-on-gate.ts --report <path>`, it walks eleven
live clauses under the chassis worker pool → prints one row per clause with id, status and detail →
records `DF5.4-V1` as `void` with its OQ-4 reason → writes a versioned report → prints `DF_GATE:
PASS`, exit `0`. Deleting DF5.1's re-verify record and re-running prints `DF5.4-C6 … fail` naming the
missing evidence, then `DF_GATE: FAIL`, exit `1`.

**Wiring closed:** On completion of this story, the §8 step-5 exit condition is machine-checkable
using only code merged here plus the unchanged P0.11 chassis. No stub, no `TODO: wire later`; this
story adds assertion modules and a driver and never edits `gate-runner.ts`.

**Dependency edges (predecessors):** DF5.1, DF5.2, DF5.3, DF3.1, DF3.4, P0.11. *(The clause map also
asserts against artifacts owned by DF1.2, DF1.4, DF1.6, DF2.1, DF2.2, DF2.5 and DF2.8 — see the Owner
column. Those are reached **transitively** through the six direct predecessors above and are not
repeated as edges; the clause map, not this line, is the authority on which story owns which
evidence.)*

## Acceptance Criteria

1. **(make-or-break)** Given the lights-on run of record, When the gate runs, Then all **eleven live
   clauses** (Technical Notes) return `pass`, `DF5.4-V1` is recorded with its `void_reason` and
   **excluded from the verdict** (`gate-runner.ts:167-178`), the report's `overall` is `"PASS"`,
   stdout terminates `DF_GATE: PASS`, the versioned report is written to `--report`, exit is `0`.
2. Given any clause failing, Then the gate returns FAIL carrying that clause's **assertion id,
   expected, actual and diagnostic** — named, never summarised (`p1-17:30`, reconciled to the
   chassis's four-value `pass|fail|skip|void` rather than the source's three-value enum) — stdout
   terminates `DF_GATE: FAIL`, exit is `1`, and §8 step-6 derivation does not begin.
3. Given the gate is run repeatedly against unchanged system state, Then it produces identical
   results — deterministic, no flakiness (`p1-17:31`); a non-deterministic gate turns red into retry.
4. Given a clause whose evidence cannot be read or evaluated, Then it returns `skip` with a named
   reason and the gate is **red** — a SKIP is not a pass (`gate-runner.ts:211-212`). Given a fatal
   error before any assertion runs, Then exit is `2` and no report claims a verdict.
5. Given a clause set in which every live clause has been voided or removed, Then the gate is FAIL,
   never a vacuous PASS (`:324-326`). Given a preflight clause fails, Then the main clauses are still
   **listed**, marked `skip` with `"not attempted — preflight assertion(s) did not pass (fail-fast)"`.

## Trigger Surface

| Trigger | Status | E2E Test | Follow-Up |
|---------|--------|----------|-----------|
| `bun scripts/df5-lights-on-gate.ts [--report <path>]` operator CLI | in-scope | `tests/gate/df5-lights-on-gate.test.ts` | — |
| Each assertion module's exported pure auditor, called directly | in-scope | `tests/gate/df5-assertions.test.ts` | — |
| CI job / scheduled health-check invocation; HTTP gate-report surface on the SwarmClaw chassis (DD-7) | out-of-scope | — | DF5.5 |
| A clause exercising the approval or credential path live | out-of-scope by design (read-only, G4) | — | — |

## Infra Prerequisites

| Component | Service (compose/k8s/provider) | Lifecycle Hook Verified |
|-----------|-------------------------------|-------------------------|
| P0.11 gate chassis (`src/gate/gate-runner.ts`, `src/gate/assertions/lib/verdict.ts`) | in-tree, `bun test` | `runGate` returns a `GateReport`; the VOID path (`:167-178`) and the all-void FAIL rule (`:324-326`) are already covered by `tests/gate/phase0-exit-gate.test.ts` (45 cases) — this story adds clauses, not chassis behavior |
| Run of record — one completed lights-on run's host-side evidence | `.sandbox/runs/<id>.json`, `.sandbox/reverify/<run-id>.jsonl`, `.sandbox/approvals/<id>.json`, `<host_data_dir>/cost-ledger.db`, `<host_data_dir>/audit.db`, `refs/sandbox/<run-id>` | every path resolved at gate start; a missing path is `skip` with the path named — red, never silently green |
| `qds audit` host-side CLI (C9); DF2.8's exported `readRunCost(runId)` (C10); GitHub PR read for the PR clause | DF5.3 script; DF2.8 module read-only against `<host_data_dir>/cost-ledger.db`; GitHub API with the host-side token | `qds audit` invoked non-blockingly (never `spawnSync`, `:66-68`) so the chassis timeout can preempt it, and its exit code asserted; `readRunCost` is an in-process read-only call, no subprocess; the PR fetch is read-only and the token never enters a diagnostic (INV-GATE-2) |

## Technical Notes

- **Clause map (NET-NEW per DD-8, re-derived from §8 step 5).** The gate *pattern* is the chassis's;
  the clause set is new. Each `GateAssertion` sets `story` = the Owner column and the chassis's
  **required** `prd_clause` (`:51`) = `"§8 step 5 — <stage>"`, since no PRD §13 clause covers these.
  `EVIDENCE` = assert a prior run's recorded outcome (G4 pattern, `p1-17:35`):

  | Clause | Group | Stage | Asserts | Owner |
  |---|---|---|---|---|
  | `DF5.4-P1` | preflight | — | the run of record exists, is readable, names a runId | DF5.4 |
  | `DF5.4-C1` | main | channel | dispatch entered via the operator CLI with a schema-validated brief and a returned runId (DD-1) | DF3.1 |
  | `DF5.4-C2` | main | fleet | box `create`d, `fill`ed at a pinned SHA, `setup` gate green, record closed with `spendMicroUsd` (DF2.1 verbs) | DF3.1/DF2.2/DF2.5 |
  | `DF5.4-C3` | main | team | merged envelope validates, NDJSON parsed with zero malformed lines, cost events sum non-zero | DF1.6 |
  | `DF5.4-C4` | main | gates | phase-engine gate evidence recorded for a pass **and** a fail | DF1.2/DF1.4 |
  | `DF5.4-C5` | main | bundle | bundle verified and fetched to `refs/sandbox/<run-id>` | DF2.5 |
  | `DF5.4-C6` | main | re-verify | tests **and** gates re-ran outside the box, green, **strictly before** the PR by host-recorded timestamp — `ReverifyReport.completedAt` < `extensions.pr.createdAt` (F10) | DF5.1 |
  | `DF5.4-C7` | main | approval | a recorded approve decision with approver id and `decidedAt`, and `decidedAt` **strictly after** the re-verify's `ReverifyReport.completedAt` — host clocks both, the same ordering discipline C6 applies on the other side of the decision (EVIDENCE) | DF3.4 |
  | `DF5.4-C8` | main | PR | PR on `qds/{runId}`, body carrying the runId, a labelled `Issue:` line and a cost summary line, push host-side | DF5.2 |
  | `DF5.4-C9` | main | audit | `qds audit <pr>` returns a complete chain, exit 0 | DF5.3 |
  | `DF5.4-C10` | main | cost | DF2.8's run-keyed `readRunCost(runId)` reports a non-zero µ$ total at or under cap | DF2.8 |
  | `DF5.4-V1` | main | memory | **VOID** — retain receipt, `void_reason` per DD-4 | DF5.4 *(step 6)* |

- **What C6, C8 and C10 may assert against (and what they must not).** These three clauses are the
  ones whose evidence has moved, so their contracts are pinned here:
  - **C6** compares **host** clocks only — DF5.1's `ReverifyReport.completedAt` against DF5.2's
    `extensions.pr.createdAt`, the ISO-8601 stamp DF5.2 takes on the host immediately before its
    `POST /pulls`. GitHub's `created_at` is a different clock and is never the ordering input.
  - **C8** asserts the PR body's **shape**, not P1.3's mapping quality: the body carries a line
    labelled `Issue:` whose value is either a resolved reference or the literal `unresolved`
    (DF5.2 AC2). P1.3's mirror index is out of the v5 slate and non-blocking for DF5.2, so a clause
    demanding a resolved issue number could never go green on a run dispatched without one.
  - **C10** calls DF2.8's exported **run-keyed** `readRunCost(runId)` in-process, read-only. The
    issue-scoped `qds cost <owner/repo>#<N>` path is not used: an issue-less run has no issue key,
    and the clause is about *this run's* spend against *this run's* cap.
- **`DF5.4-V1` is VOID, not absent (BINDING — DD-4, register §4 row 3):** `void_reason: "OQ-4
  unresolved — Hindsight has never booted on this host; step-6 memory wiring is outside the v5
  horizon"`. Its check is **never invoked** and it is **excluded from the verdict** while staying in
  the report for traceability (`:167-178`). It states the same reason as DF5.3's VOID memory hop.
- **Budgets via the chassis's own option surface:** `RunGateOptions` (`:130`) = `{ assertionTimeoutMs:
  60_000, totalTimeoutMs: 300_000 }` — the surviving 60 s-per-assertion / 5-min-total discipline
  (`p1-17:38`), not the chassis defaults (30 s / 600 s). Concurrency stays at the default 4. The
  preflight clause is its own fail-fast barrier ahead of the main set, so the worst case is
  1 preflight wave + 3 main waves (10 live main clauses at concurrency 4) = 4 × 60 s = **240 s**,
  leaving 60 s of margin inside the 300 s total. C9's ≤30 s `qds audit` walk fits its 60 s slot.
- **Versioned report without touching the chassis:** the driver writes `{ gate: "df5-lights-on",
  gate_version: "1.0.0", clause_map_version: "1.0.0", report }`, `report` validating against the
  exported `GateReportSchema` (`:117`), to a default artifacts path overridable with `--report`.
- **Assertion-module shape follows `p0-3-mixed-model.ts`:** each exports a **pure auditor**
  (`auditX(evidence): XAudit`) separately from its check closure, so the clause contract is testable
  rather than buried in a check. Shared evidence logic extends `src/gate/assertions/lib/verdict.ts`
  **additively** (R3 §4.3) — P0.11's 45 existing cases stay green — never copied per module.
- **Guards/limits:** checks must not block the event loop (`:66-68`) — no `spawnSync`, no unbounded
  synchronous walk, or the per-assertion timeout cannot preempt them. Every clause asserts against the
  **frozen run of record**: a gate must be safe to re-run, and a live path costs money and mutates.
- **Deviation/assumption:** DF5.1/DF5.2 are authored concurrently; C6 and C8 assert their recorded
  outputs by path and identity only, a renamed path fixed in this story's resolver. Record any
  clause-versus-implementation discrepancy in the clause-map header, never reinterpret it silently.

## Observability Contract

- The gate logs one line per assertion — `{ requestId, gate, assertionId, story, status, durationMs }`
  — plus a summary `{ overall, pass, fail, skip, void, total_duration_ms }`.
- `requestId` is minted by the driver at gate start and stamped on the report; failures include
  `{ code, message, remediation }`, the last being the literal next command.
- Sub-timings: per-assertion `duration_ms` comes from `GateAssertionResult` (`:77`); the driver adds
  `report_write_ms`, and a clause that never ran reports 0.

## Files to Modify

- `src/gate/assertions/df5-execution.ts`
- `src/gate/assertions/df5-boundary.ts`
- `src/gate/assertions/df5-accounting.ts`
- `src/gate/assertions/lib/verdict.ts`
- `scripts/df5-lights-on-gate.ts`
- `tests/gate/df5-assertions.test.ts`
- `tests/gate/df5-lights-on-gate.test.ts`
- `tests/gate/fixtures/df5-run-of-record.json`

## Security Invariants

- **INV-GATE-1 (read-only):** the gate never dispatches a run, provisions a box, mints or revokes a
  credential, opens a PR, or writes to a bank or the ledger (`p1-17:48`); its only write is the
  report file. Stateful capabilities are verified through **recorded evidence from prior runs**.
- **INV-GATE-2 (no secrets in the report):** no assertion detail, diagnostic or report field exposes a
  token, the provisioning key, minted key material, or PII. `C10` reports the aggregate µ$ total
  against the cap, never individual token costs that could leak pricing tiers (`p1-17:50`, restated
  in µ$ per DD-9); `C1`/`C2` report key hashes only.
- **INV-GATE-3 (non-vacuity):** a SKIP is not a pass (`:211-212`); a VOID clause is excluded from the
  verdict and its check never invoked (`:167-178`); a gate with no live assertions is FAIL, never a
  vacuous PASS (`:324-326`). No clause may be converted to VOID to turn a red gate green — VOID is
  for a subject outside the horizon, and `DF5.4-V1` is the only one in this set.
- **INV-GATE-4 (trust boundary — host-side evidence only):** every clause asserts against host-side
  records; in-box trace and gate results are claims, not proof (F10, §6 item 6, R5 §6 fact 15). `C6`
  also asserts the **ordering** — the re-verify's host completion timestamp precedes the PR's
  host-recorded `extensions.pr.createdAt`; an implementation asserting only that both records exist,
  or one ordering against GitHub's server-side `created_at`, MUST fail C6's test.
- **INV-GATE-5 (explicit positive assertions, fail closed):** every asserted field is checked
  positively (`!== 0`, `!== false`, a status literal) so an absent field fails rather than reading as
  satisfied. Unreadable evidence yields `skip` naming reason and path — red, never green.

## Definition of Done

- [ ] **Impl:** three assertion modules under `src/gate/assertions/`, each exporting a pure auditor
      plus its `GateAssertion` factory, assembled by the driver's `buildAssertions()`.
- [ ] **Impl:** `scripts/df5-lights-on-gate.ts` mirrors `phase0-exit-gate.ts` — clause-map header,
      `parseValueFlags` for `--report`/`--help`, rendered table, `DF_GATE: PASS|FAIL`, exit 0/1/2.
- [ ] **Contract:** the versioned wrapper `{ gate, gate_version, clause_map_version, report }` is
      written, `report` validating against `GateReportSchema` (`gate-runner.ts:117`).
- [ ] **Integration:** budgets passed via `RunGateOptions` (60 s/assertion, 300 s total); no
      `spawnSync` in any check; `qds audit` invoked as an async subprocess; C10 reads through DF2.8's
      exported `readRunCost(runId)`, never a second SUM.
- [ ] **Security:** `DF5.4-V1` carries its `void_reason` and is excluded from the verdict per DD-4
      (INV-GATE-3); the gate writes nothing outside the report path (INV-GATE-1); a redaction test
      asserts no token, key material or PII reaches any assertion detail or report field.
- [ ] **Test (unit):** each clause's pure auditor is green on the fixture and red on a mutant with the
      asserted field removed — proving a missing field fails rather than reading as satisfied.
- [ ] **Test (determinism):** two consecutive runs against unchanged state produce identical
      per-clause statuses and identical `overall`.
- [ ] **Test (non-vacuity negative control):** an all-voided clause set and an empty clause set both
      produce FAIL — an implementation summing only `pass` counts returns PASS and MUST fail.
- [ ] **Test (F10 ordering):** a fixture whose re-verify timestamp falls *after* the PR creation
      timestamp → `DF5.4-C6` fails; an implementation asserting only that both records exist MUST fail.
- [ ] **Test (C8 shape, not mapping):** a PR body whose `Issue:` line reads `unresolved` passes C8; a
      body with no `Issue:` line at all fails it — the clause never depends on P1.3 resolving.
- [ ] **Test (e2e demo — MANDATORY):** run the gate against the recorded lights-on run, capturing the
      report (eleven `pass`, `DF5.4-V1` `void` with reason, `DF_GATE: PASS`, exit `0`), then delete
      one evidence file and capture the FAIL report naming that clause, exit `1`.

## Dev Agent Record

<!-- Empty placeholder — filled during development. -->
