# DF5.4: Lights-On Exit Gate on the P0.11 Chassis

**Story Points:** 5
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
sprint-3 exit gate for the whole DF backlog and is scheduled **last**, after DF3.7 and DF3.8, which
produce the run it asserts against.

**"Reconstructable" is defined once, for both halves of this contract — and the canonical definition
lives in `df5-3`'s Overview, binding here by reference, including its runId carve-out** (invoked with
a runId — the form C9 uses against the frozen fixture — hop 1 resolves locally from the record's
`extensions.pr` and the walk performs **no network access at all**): an operator on the host, given
only a merged PR URL and read access to `.sandbox/` and `refs/sandbox/`, can obtain a ten-hop chain per
contributing runId in which every hop is a typed non-null outcome, every emitted link row's
`evidence_digest` still matches its artefact, and the run satisfies
`reverify.completedAt < approval.decidedAt < pr.createdAt` (strict — equality is a violation). No network access beyond the single GitHub PR
read at hop 1; no in-box access; no re-execution of any underlying action. DF5.3 produces this; DF5.4-C9
asserts it field by field.

## E2E Slice

**Demonstrable behavior:** Given a completed lights-on run of record whose host-side evidence is on
disk, When the operator runs `bun scripts/df5-lights-on-gate.ts --report <path>`, it walks eleven
live clauses under the chassis worker pool → prints one row per clause with id, status and detail →
records `DF5.4-V1` as `void` with its OQ-4 reason → writes a versioned report → prints `DF_GATE:
PASS`, exit `0`. Deleting DF5.1's re-verify record and re-running strands three clauses, not one:
`DF5.4-C6 … skip` naming the missing `.sandbox/reverify/<run-id>.jsonl` path (unreadable evidence is
`skip`, not `fail` — AC4, INV-GATE-5, `gate-runner.ts:208-215`), `DF5.4-C7 … skip` (its ordering input,
the bound report's `completedAt`, is gone) and `DF5.4-C9 … fail` (DF5.3 hop 7 resolves broken and the
walker exits non-zero). The gate is **red**, stdout terminates `DF_GATE: FAIL`, exit `1`.
Replacing that record with one whose `verdict` is `red` prints `DF5.4-C6 … fail` — the distinction the
chassis exists to keep (`gate-runner.ts:8-13`).

**Wiring closed:** On completion of this story, the §8 step-5 exit condition is machine-checkable
using only code merged here plus the unchanged P0.11 chassis. No stub, no `TODO: wire later`; this
story adds assertion modules and a driver and never edits `gate-runner.ts`.

**Dependency edges (predecessors):** DF5.1, DF5.2, DF5.3, DF3.1, DF3.4, **DF1.10**, **DF2.5**,
**DF3.7**, **DF3.8**, **DF2.11**, P0.11. *(**P0.11 is a chassis-reuse edge, not a verdict edge:**
`PHASE_0_GATE` is currently FAIL on upstream Phase-0 evidence (sprint-status P0.11) and that verdict does
not gate this story, which reuses `runGate` and never P0.11's clause set (P1.1-R5-3 precedent).
**DF2.11** supplies `CostLedger.openReadOnly()`, which C10 needs to read the ledger without creating it.
DF1.2, DF1.4, DF1.6, DF2.1, DF2.2 and DF2.8 are reached
**transitively** — the clause map's Owner column, not this line, is the authority on which story owns
which evidence. DF1.10 and DF2.5 are **direct**: since the tier-2 restoration (ADR 2026-08-31, DF1.10
merged 2026-09-06) C3's and C4's evidence is written in-box and reaches the host only via DF2.5's
`pullArtifacts`. DF3.7/DF3.8 are direct because they produce the run of record. **DF6.1b is not a
predecessor but is a shape edge:** it widens `ChainReport` from one contributing-runId key to N, so C9
is written against the map and not against the single-key case, and DF6.1b lands without touching this
clause.)*

## Acceptance Criteria

1. **(make-or-break)** Given the lights-on run of record, When the gate runs, Then all **eleven live
   clauses** (Technical Notes) return `pass`, `DF5.4-V1` is recorded `void` with `detail` equal to
   `` `VOID — ${OQ4_VOID_REASON}` `` — the chassis renders `void_reason` into `detail`
   (`gate-runner.ts:174`); `GateAssertionResult` (`:77-86`) and `GateReportSchema` (`:117-128`) have no
   `void_reason` key and this story does not add one (`gate-runner.ts` is never edited) — and
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
| Run of record — one completed lights-on run's host-side evidence | `<runsDir>/<runId>.json` (the DF2.1 run record — carries `extensions.approval`, `extensions.pr`, `extensions.budget`, and **no `extensions.gate`: a healthy run carries none, DF3.1 writes that namespace only on gate failure, and C2's gate-green assertion is the recorded negation of it**; `resolveRunsDir()` in `src/providers/run-record.ts`), `.sandbox/reverify/<run-id>.jsonl`, `.sandbox/cost-ledger.db`, `.sandbox/audit.db`, `<runsDir>/<runId>-artifacts/` (the harvested in-box evidence), `refs/sandbox/<run-id>`, **and `pr-body.txt` — the frozen PR body, captured at freeze time so C8 asserts shape without a live GitHub read** | every path resolved at gate start; a missing path is `skip` with the path named — red, never silently green. **There is no `.sandbox/approvals/` file and there never was**: approval lives in the DF2.1-registered `extensions.approval` namespace |
| **Producer of the run of record** | DF3.7 `fleet observe <run-id>` (the delivered single-run verb: bounded in-box marker poll → harvest → teardown → reverify — the `--await-completion` flag is out of scope per DF3.7's Trigger Surface) or DF3.8's host-side `fleet observe --all` sweep; both `ready-for-dev` as of 2026-09-08 | **This story cannot demonstrate AC1 until DF3.7 has merged.** The run of record is a real completed lights-on run captured once and frozen: run record, `.sandbox/reverify/<id>.jsonl`, `.sandbox/cost-ledger.db`, `.sandbox/audit.db`, `<runsDir>/<runId>-artifacts/` and `refs/sandbox/<run-id>` are copied into `tests/gate/fixtures/df5-run-of-record/` as a **directory**, not a single JSON file, by `scripts/dev/capture-run-of-record.ts`, which **checkpoints `cost-ledger.db` (`PRAGMA wal_checkpoint(TRUNCATE)`) before copying it and refuses to freeze a fixture with a non-empty `-wal`** — DF2.11's `openReadOnly()` refuses a hot-WAL ledger (`df2-11:291-305`), so a fixture captured mid-transaction would make C10 `skip` and the gate red forever. (`audit.db` needs no checkpoint: DF5.3 keeps it on the `DELETE` journal.) `--runs-dir`-style seams point the gate at it. Capturing it is a step of this story's e2e, recorded in the Dev Agent Record. **The harness copies the fixture directory into a `mkdtempSync` scratch dir and points the gate at the copy** through those seams, so the frozen fixture stays immutable across runs (Guards/limits) and the file-set snapshot has a clean baseline. It does **not** need to `chmod` the copy: git preserves only the executable bit, so committed DB files check out 0644 under 0755, but DF2.11's `openReadOnly()` carries **no `chmodSync`, no mode assertion, no pragma and no schema exec** — the read path early-returns on the preopened handle before any of the constructor's effects (`src/providers/cost-ledger.ts::openReadOnly`) — the 0700/0600 assertions stay on the **write** path where DF2.8 put them (the ordinary `CostLedger` constructor), and `df2-11:169-170`'s negative control fails an implementation that keeps them on the read path. A gate that only reads therefore reads a 0644 fixture fine. **C5's ref evidence is frozen too:** `refs/sandbox/<run-id>` is a ref in the host repo's `.git` and a bare ref file is a 40-hex line meaning nothing without its object store, so `scripts/dev/capture-run-of-record.ts` writes the ref and its objects into a bare repo at `tests/gate/fixtures/df5-run-of-record/refs.git` and the gate takes a `--git-dir` seam beside `--runs-dir`. **The gate never resolves a ref in the operator's working repo** — that is a live path Guards/limits forbids, and resolving one would make AC3's determinism machine-dependent |
| `bun scripts/qds-audit.ts` host-side CLI (C9); DF2.8's `CostLedger.readRunCost(runId)` (C10); GitHub PR read for the PR clause | DF5.3 script; DF2.8 module against `.sandbox/cost-ledger.db` (`DEFAULT_COST_LEDGER_FILE`); GitHub API with the host-side token | `bun scripts/qds-audit.ts --json` invoked non-blockingly (never `spawnSync`, `:66-68`) so the chassis timeout can preempt it, and **its parsed output asserted, not merely its exit code** (C9). `readRunCost` is a **method on `class CostLedger`**, not a module-level export, and the ordinary constructor is **not** read-only (the `CostLedger` constructor: `mkdirSync` 0700, `chmodSync` 0700, `new Database()` which CREATES the file when absent, `chmodSync` 0600, `PRAGMA journal_mode = WAL`, `db.exec(SCHEMA)`). C10 therefore reaches `readRunCost` through **DF2.11's `CostLedger.openReadOnly()`**, which opens SQLite read-only and performs no `mkdir`, `chmod`, mode assertion, pragma or schema exec (the read path's early return before any effect; `src/providers/cost-ledger.ts::openReadOnly`). It is **not an `existsSync` pre-check**: DF2.11 specifies a no-create `openSync(path, "r")` throwing `ledger-absent`, holding the fd and comparing `fstatSync(fd).ino` to the probed inode to throw `ledger-identity-changed` on a replace-and-restore across the open window (`df2-11:270-282`). C10 returns `skip` naming the path on either code, and on DF2.11's typed hot-WAL refusal (`df2-11:291-305`). It never constructs the ledger it is auditing. No subprocess either way. The PR fetch is read-only and the token never enters a diagnostic (INV-GATE-2) |

## Technical Notes

- **Clause map (NET-NEW per DD-8, re-derived from §8 step 5).** The gate *pattern* is the chassis's;
  the clause set is new. Each `GateAssertion` sets `story` = the Owner column and the chassis's
  **required** `prd_clause` (`:51`) = `"§8 step 5 — <stage>"`, since no PRD §13 clause covers these.
  `EVIDENCE` = assert a prior run's recorded outcome (G4 pattern, `p1-17:35`):

  | Clause | Group | Stage | Asserts | Owner |
  |---|---|---|---|---|
  | `DF5.4-P1` | preflight | — | the run of record exists, is readable, names a runId | DF5.4 |
  | `DF5.4-C1` | main | channel | the run record carries a `requestId` (`src/providers/run-record.ts`) and an `extensions.budget` block with `repoSlug`, `issueId` and a non-zero `admittedCeilingMicroUsd` (`extensions.budget`, `src/providers/run-record.ts`) — the durable evidence that dispatch went through DF3.1's operator CLI and DF2.8's admission gate rather than being hand-created. A record with a `runId` and no `extensions.budget` fails: a run nothing admitted is a run nothing capped. *(DF3.1 persists no brief digest, so the brief itself is not assertable here; asserting it is a DF3.1 change, recorded as a Deviation rather than invented as evidence.)* | DF3.1/DF2.8 |
  | `DF5.4-C2` | main | fleet | box `create`d, `fill`ed at a pinned SHA, **`setup` gate green — asserted as the negated field it is: `closedAt` present AND `commitSha` present AND `extensions.gate` absent. The carve-out from INV-GATE-5 is explicit and recorded here because absence is the only trace a green gate leaves: DF3.1 AC3's `extensions.gate` namespace is written only on gate failure (`dispatch.ts`'s failure branch), so there is no positive field to check — and the two positive companions (`closedAt`, `commitSha`) are what stop a truncated record from reading as a green gate** — record closed (`closedAt`) **with a terminal `extensions.approval.state` of `approved` — `pausing` and `awaiting-approval` are also closed records (DF3.4: teardown sets `closedAt` before the promote), so `closedAt` alone does not mean the run finished** — and a non-zero `spendMicroUsd` (`captureSpend` in `credentials.ts`) | DF3.1/DF2.2/DF2.5 |
  | `DF5.4-C3` | main | team | the team execution's NDJSON evidence in the **harvested** tracer log `<runsDir>/<runId>-artifacts/trace/events.jsonl` (a `BOX_RUN_SOURCES` member DF2.5's `pullArtifacts` lands) is present, parses as NDJSON, carries **at least one well-formed line**, and zero malformed lines — a **claim-integrity** assertion: it proves the box's claim *arrived intact*, never that its content is true. C6 is what earns the truth. The team's merged step output reaches this file as the tracer's `worker_output` rows (the dispatch-task `envelope` branch traces it; the `merged` branch is consumed in-process and traced by stream-health only), and this log is the **only** team-execution evidence the harvest carries — the clause asserts against it and never invents or adds a harvested source (mutating `BOX_RUN_SOURCES` is a DF2.5-owned change outside this story's Files to Modify). (The "at least one" conjunct is C3's sibling C4's own discipline applied at home: a zero-line log is present, parses, and carries zero malformed lines — it would pass without it, and C3 is the only clause covering team execution.) | DF1.6 |
  | `DF5.4-C4` | main | gates | the **harvested** trace DB (`<runsDir>/<runId>-artifacts/trace/trace.db`, read through the temp-dir copy DF5.3's Technical Notes mandate — a hot `-wal` with no `-shm` ships by design, `harvest.ts:184-212`, and an in-place read either refuses or silently reads a truncated DB) carries **at least one** `gate_results` row for the run, every row's `passed` column a literal `0` or `1` (never NULL — INV-GATE-5 positive assertion), joined on the run record's `requestId` (`trace/schema.ts:84-93` — `gate_results.request_id`, reached `runId → record.requestId`, since the trace store is keyed on `request_id` and never on `run_id`) — a **claim-integrity** assertion under INV-GATE-4: **in-box gate results are claims and can never be the proof that a gate passed.** The proof is C6's host-side re-verify. Pass/fail **diversity** is deliberately not asserted here: a run whose gates all pass first time produces only `passed = 1` rows, and the run of record is captured once and frozen, so demanding a fail row would make the clause permanently red with no remedy but fabricating a failure into the fixture. That discrimination is a unit test of the pure auditor against a synthetic two-row fixture in `tests/gate/df5-assertions.test.ts`, not a clause against the frozen run. | DF1.2/DF1.4 |
  | `DF5.4-C5` | main | bundle | bundle verified and fetched to `refs/sandbox/<run-id>`, resolved in the frozen fixture's bare repo through the `--git-dir` seam and never in the operator's working repo | DF2.5 |
  | `DF5.4-C6` | main | re-verify | tests **and** gates re-ran outside the box, green, **strictly before** the PR by host-recorded timestamp — `ReverifyReport.completedAt` < `extensions.pr.createdAt` (F10) | DF5.1 |
  | `DF5.4-C7` | main | approval | `extensions.approval` (`src/providers/run-record.ts`) carries a terminal `state: "approved"` with `approverId` and `decidedAt`, and `decidedAt` is **strictly after** the re-verify's `ReverifyReport.completedAt` and **strictly before** `extensions.pr.createdAt` — host clocks throughout, the same ordering discipline C6 applies on the other side of the decision. There is no `.sandbox/approvals/` file and there never was (DF5.2 merge record, 2026-08-26); a clause reading one can only ever `skip`. (EVIDENCE) | DF3.4 |
  | `DF5.4-C8` | main | PR | the **frozen** `pr-body.txt` (captured beside the fixture by `scripts/dev/capture-run-of-record.ts`) carrying the runId, a labelled `Issue:` line and a cost summary line — read through the gate's `--pr-body` seam, never live GitHub: a live read makes AC3's determinism machine- and network-dependent and lets a `gh repo delete` or a missing CI token turn C8 `skip` on a gate whose fixture is otherwise frozen. The live PR read stays available as an out-of-scope Trigger Surface row | DF5.2 |
  | `DF5.4-C9` | main | audit | `bun scripts/qds-audit.ts --json <runId> --runs-dir … --audit-db … --ledger … --reverify-dir …` — invoked **by runId**, so hop 1 resolves locally from the frozen record's `extensions.pr` and the walk performs **no network access at all** — with the four path seams threaded from the gate's own `--runs-dir`-style flags at the scratch copy, never the developer's real `.sandbox/` — exits `0` **and** its output, typed as DF5.3's exported `ChainReport` (`src/audit/index.ts` — imported, never re-declared here), satisfies: **at least one** contributing-runId key with the parent run reached at hop 1 among them (a PR with no fix attempts has exactly one; DF6.1b adds one key per fix runId — `df5-3` Technical Notes, "Ten hops *per contributing runId*"), **exactly ten hops under every key**, **zero** hops with status `broken` / `unlinked` / `hop-timeout` / `evidence-mismatch` / `evidence-not-harvested`, hop 10 `void`, and the credential (hop 4), box (hop 5) and bundle (hop 6) hops each carrying at least one emitted `audit_links` row id — the three hops DF5.3's `recordAuditLink` emitters own and the only ones no other clause covers. The exit code alone is not the assertion. | DF5.3 |
  | `DF5.4-C10` | main | cost | `CostLedger.openReadOnly({path}).readRunCost(runId)` (DF2.11's read-only seam; a **method on `class CostLedger`**) reports `hasEvents: true` and a non-zero µ$ total — `totalMicroUsd` sums **token rows (wired since DF2.12) and box-hours**, so the total is the run's whole ledger spend, never only its box-hours — and, **separately**, the record's `spendMicroUsd` (the *key's* spend, written by `captureSpend`, `credentials.ts`) is at or under `extensions.budget.admittedCeilingMicroUsd` (`src/providers/run-record.ts`, the ceiling actually handed to DF2.3's mint). The two are different meters and the clause never compares one against the other's ceiling. An absent ledger is a `skip` naming the path, never a created file | DF2.8/DF2.11 |
  | `DF5.4-V1` | main | memory | **VOID** — retain receipt, `void_reason` per DD-4 | DF5.4 *(step 6)* |

- **What C6, C8 and C10 may assert against (and what they must not).** These three clauses are the
  ones whose evidence has moved, so their contracts are pinned here:
  - **C6** compares **host** clocks only — the **bound** `ReverifyReport`'s `completedAt` against
    DF5.2's `extensions.pr.createdAt`, the ISO-8601 stamp DF5.2 takes on the host immediately before its
    `POST /pulls`. GitHub's `created_at` is a different clock and is never the ordering input. The bound
    report is the one whose `reverifyId` equals `extensions.approval.reportId` (the `extensions.approval` shape in `src/providers/run-record.ts`),
    selected from the append-only `.sandbox/reverify/<runId>.jsonl` (`src/reverify/report.ts`, which legitimately
    holds several lines — `appendReport` is called at each `runner.ts` verdict site, and `readReports`
    returns an array; the module header names the last line authoritative *for DF5.2*, and C6/C7 deliberately select the **bound** report instead, for the reason that follows). Its `completedAt`, **never the last line's**: reading the last line can fail a
    lawfully-approved run whose final report is red, or pass a run whose approval bound a superseded
    report — a truth layer nothing approved. A report listed in
    `extensions.approval.supersededReportIds` is never the ordering input, and a `reportId` resolving to
    no line in the file is a `skip` naming both the id and the path. C7 selects the same bound report.
  - **C8** asserts the PR body's **shape**, not P1.3's mapping quality: the body carries a line
    labelled `Issue:` whose value is either a resolved reference or the literal `unresolved`
    (DF5.2 AC2). P1.3's mirror index is out of the v5 slate and non-blocking for DF5.2, so a clause
    demanding a resolved issue number could never go green on a run dispatched without one.
  - **C10** calls DF2.8's **run-keyed** `readRunCost(runId)` in-process — a **method on
    `class CostLedger`**, not a module-level export. The ordinary constructor
    creates and schema-initialises the ledger when absent, so C10 opens
    through **DF2.11's `CostLedger.openReadOnly()`** (no-create `openSync` + held-fd inode probe, never
    a bare `existsSync`; no `chmod`, no mode assertion, no pragma, no schema exec); C10 `skip`s naming
    the path on `ledger-absent`, `ledger-identity-changed` or the hot-WAL refusal `ledger-wal-recovery-required`. The issue-scoped `qds cost <owner/repo>#<N>` path is not used: an issue-less
    run has no issue key, and the clause is about *this run's* spend against *this run's* cap.
    C10 asserts the µ$ total only; it never asserts a multi-role `perRole` split. Since DF2.12 wired
    the DF2.7→ledger token bridge, a healthy production run's ledger carries token rows as well as
    box-hours (`hasTokenRows: true`, real role buckets in `perRole`); the clause stays total-only so
    it reads identically whether the ledger it opens is a production run or the frozen fixture's
    pre-bridge single-key shape (`perRole`/`hasTokenRows`, on `readRunCost`'s return shape).
- **Two-layer evidence doctrine, stated once for both halves of this contract.** In-box evidence is a
  claim in both halves of this contract. DF5.3 hop 9 attaches it as `{ kind: "claim" }`; DF5.4-C3/C4
  assert its integrity, never its truth. The truth layer is DF5.1's host-side re-verify — DF5.3 hop 7,
  DF5.4-C6 (ADR `:61-64`).
- **Reciprocity with DF5.3.** DF5.3 owns the ten-hop table and the three emitted link families (hops 4, 5, 6);
  DF5.4-C9 is the **only** clause that reads `audit_links`, so C9 asserts link-row presence for those three
  hops by name, not merely the walker's exit code. DF5.4-C1 (channel) and C3 (team) assert stages with no hop
  in DF5.3's table **by design** — the hop table is the walk from a merged PR back through the records that
  *authorized* it, and dispatch/team execution are upstream of authorization. Neither story adds a hop or a
  clause without the other's row changing in the same PR. **The `--json` payload is a two-story wire
  format with one owner: DF5.3 exports `ChainReport` from `src/audit/index.ts` — beside
  `OQ4_VOID_REASON` — and C9 imports the type rather than parsing shape by hand. A second export point
  would re-create the drift. Neither story changes the shape without the other's row changing in the
  same PR.**
- **`DF5.4-V1` is VOID, not absent (BINDING — DD-4, register §4 row 3):** `void_reason: "OQ-4
  unresolved — Hindsight has never booted on this host (arm64 libpq/openssl@3; :8888 collides with a
  local Jupyter); step-6 memory wiring is outside the v5 horizon"`. Its check is **never invoked** and
  it is **excluded from the verdict** while staying in the report for traceability (`:167-178`) — as
  `detail: "VOID — <reason>"` (`:174`), which is the only place the chassis surfaces the reason. It
  states the same reason as DF5.3's VOID memory hop, **byte-identically and by construction**: the
  string is `OQ4_VOID_REASON`, exported once from `src/audit/index.ts` (DF5.3) and imported here — not
  retyped. A test asserts the imported constant equals the report's `void_reason`.
- **Budgets via the chassis's own option surface:** `RunGateOptions` (`:130`) = `{ assertionTimeoutMs:
  60_000, totalTimeoutMs: 300_000 }` — the surviving 60 s-per-assertion / 5-min-total discipline
  (`p1-17:38`), not the chassis defaults (30 s / 600 s). Concurrency stays at the default 4. The
  preflight clause is its own fail-fast barrier ahead of the main set, so the worst case is
  1 preflight wave + 3 main waves (10 live main clauses at concurrency 4) = 4 × 60 s = **240 s**,
  leaving 60 s of margin inside the 300 s total. C9's ≤30 s `bun scripts/qds-audit.ts` walk fits its 60 s slot.
- **Versioned report without touching the chassis:** the driver writes `{ gate: "df5-lights-on",
  gate_version: "1.0.0", clause_map_version: "1.0.0", report }`, `report` validating against the
  exported `GateReportSchema` (`:117`), to a default artifacts path overridable with `--report`.
- **Assertion-module shape follows `p0-3-mixed-model.ts`:** each exports a **pure auditor**
  (`auditX(evidence): XAudit`) separately from its check closure, so the clause contract is testable
  rather than buried in a check. Shared evidence logic extends `src/gate/assertions/lib/verdict.ts`
  **additively** (R3 §4.3) — P0.11's 45 existing cases stay green — never copied per module.
- **Guards/limits:** checks must not block the event loop (`:66-68`) — no `spawnSync`, no unbounded
  synchronous walk, or the per-assertion timeout cannot preempt them. Every clause asserts against the
  **frozen run of record** — and that claim is now true of all eleven clauses, C8's PR body included
  (frozen at capture time, read through `--pr-body`) and C9's walk included (invoked by runId, hop 1
  resolving locally, the four path seams pointed at the scratch copy): a gate must be safe to re-run,
  and a live path costs money, mutates, or depends on a third-party artifact outliving the fixture.
- **Deviation/assumption:** DF5.1/DF5.2 are authored concurrently; C6 and C8 assert their recorded
  outputs by path and identity only, a renamed path fixed in this story's resolver. Record any
  clause-versus-implementation discrepancy in the clause-map header, never reinterpret it silently.
- **Nothing is deferred out of this story.** Every review finding raised against it through wave 5c is
  resolved in the text above.

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
- `tests/gate/fixtures/df5-run-of-record/` (directory — run record, re-verify `.jsonl`, ledger, `audit.db`, harvested artifacts dir, and `refs.git/` — a bare repo carrying `refs/sandbox/<run-id>` **and its objects**, since a ref file alone is a 40-hex line that resolves to nothing)
- `scripts/dev/capture-run-of-record.ts` (the freeze tool)

## Security Invariants

- **INV-GATE-1 (read-only, with one named and bounded exception):** the gate never dispatches a run,
  provisions a box, mints or revokes a credential, opens a PR, or writes to a bank or the ledger
  (`p1-17:48`). **Its only writes are (i) the report file and (ii) the append-only first-observation
  digest rows DF5.3's walker inserts into `.sandbox/audit.db` when C9 invokes it** (`df5-3` Technical
  Notes, "Digest coverage is asymmetric"). That second write is **into the audit store itself, never
  into any store the gate asserts about**, is `INSERT … ON CONFLICT DO NOTHING` against a table whose
  `BEFORE UPDATE`/`BEFORE DELETE` triggers `RAISE(ABORT)` (INV-AUDIT-4), and **creates no file the gate
  merely intended to read** — which is the operative half of this invariant, and it holds by
  **mechanism, not assertion**: the walker's read-write open is preceded by DF5.3's no-create
  `openSync(path, "r")` probe (typed `audit-store-absent`) and **bound to the probed inode through
  to the opened database** — the post-open identity re-open on the same path, with the probe fd
  still held, refusing `audit-store-identity-changed` before any digest write (DF5.3's Infra
  Prerequisites: the identity-window sequence) — because
  `bun:sqlite`'s `new Database(path)` would otherwise materialise a zero-byte `audit.db` before any
  schema assertion — the identical defect DF2.11 chartered against, one store over, and the reason
  the DoD's file-set snapshot runs one gate pass with `audit.db` **absent**. `audit.db` runs on the
  default `DELETE` journal, so those rows land without a `-wal`/`-shm` and the file-set assertion below
  stays exact. Everything else is
  read-only: DF2.8's ordinary `CostLedger` constructor creates and schema-initialises its database when
  absent, so C10 reads through DF2.11's `openReadOnly()`, which refuses
  rather than creates; and the harvested trace DB is read through a temp-dir copy so recovering its hot
  WAL never writes a `-shm` into the artifacts directory (`df5-3` Technical Notes). Stateful
  capabilities are verified through **recorded evidence from prior runs**.
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
  **C3 and C4 are the two clauses whose subject is an in-box claim, and they are typed as such.** They
  assert that the claim was produced and harvested intact — never that it is true. No clause may be
  satisfied by an in-box artefact standing as proof of its own content (ADR `:61-64`: the two layers
  must not collapse into one trust domain). *An implementation in which a green
  `gate_results.passed = 1` row can carry C4 to `pass` without C6 independently green MUST fail C4's
  test.*
- **INV-GATE-5 (explicit positive assertions, fail closed):** every asserted field is checked
  positively (`!== 0`, `!== false`, a status literal) so an absent field fails rather than reading as
  satisfied. **One recorded carve-out: C2's gate-green leg asserts the *negated* field
  (`extensions.gate` absent) because DF3.1's registry leaves no positive trace of a green gate — and
  the clause carries two positive companions (`closedAt`, `commitSha` present) so a truncated record
  cannot ride the negation to green.** The carve-out lives in C2's row, not silently here. Unreadable evidence yields `skip` naming reason and path — red, never green.

## Definition of Done

- [ ] **Impl:** three assertion modules under `src/gate/assertions/`, each exporting a pure auditor
      plus its `GateAssertion` factory, assembled by the driver's `buildAssertions()`.
- [ ] **Impl:** `scripts/df5-lights-on-gate.ts` mirrors `phase0-exit-gate.ts` — clause-map header,
      `parseValueFlags` for `--report`/`--help`/`--runs-dir`/`--git-dir`/`--audit-db`/`--ledger`/`--reverify-dir`/`--pr-body` (the four store seams threaded through to C9's `qds-audit.ts` invocation, `--pr-body` feeding C8's frozen body), rendered table,
      `DF_GATE: PASS|FAIL`, exit 0/1/2.
- [ ] **Contract:** the versioned wrapper `{ gate, gate_version, clause_map_version, report }` is
      written, `report` validating against `GateReportSchema` (`gate-runner.ts:117`).
- [ ] **Integration:** budgets passed via `RunGateOptions` (60 s/assertion, 300 s total); no
      `spawnSync` in any check; `bun scripts/qds-audit.ts --json` invoked as an async subprocess and
      its output parsed; C10 reads through `CostLedger.openReadOnly({path}).readRunCost(runId)`
      (DF2.11's read-only seam), never the writing constructor and never a second SUM.
- [ ] **Security:** `DF5.4-V1` carries its reason in `detail` and is excluded from the verdict per DD-4
      (INV-GATE-3); the gate writes nothing outside the report path and `.sandbox/audit.db`
      (INV-GATE-1) — **asserted by snapshotting the full file list under `.sandbox/` and `<runsDir>`
      before and after a gate run and requiring the sets to differ by the report path and nothing
      else**, not by inspection. The assertion is **exact, with no sidecar exception list**, because
      DF5.3's `audit.db` stays on SQLite's default `DELETE` journal and never writes a `-wal`/`-shm`
      (`df5-3` Infra Prerequisites); an exception on a byte-identical assertion is where a real
      difference hides. The `audit_links` row count
      may only increase and no existing row may change (queried before and after). An implementation
      that uses the writing constructor against a missing ledger creates `.sandbox/cost-ledger.db`,
      `-wal` and `-shm` and MUST fail this test; so must one that mutates or deletes an existing
      `audit_links` row, or that leaves a `trace.db-shm` inside `<runId>-artifacts/trace/`. The
      snapshot exercise is run **twice**: once with the fixture's `audit.db` present (row count may
      only increase) and once with it **absent** — the absent-file pass must end with `audit.db` still
      absent (the no-create opener's proof) and the gate red on C9's `audit-store-absent`, never green
      on a store the run created. **A third pass covers the identity window:** with `audit.db`
      swapped for a different file after the no-create probe and before C9's SQLite open, the walk
      refuses `audit-store-identity-changed`, the gate is red on C9, no digest row lands in the
      replacement, and the swap file is byte-identical afterwards — the replace-and-remove window
      DF5.3's inode-bound opener exists to close, asserted at the gate, not assumed from DF5.3's
      suite. A redaction test asserts no token, key material or PII reaches any
      assertion detail or report field.
- [ ] **Test (unit):** each clause's pure auditor is green on the fixture and red on a mutant with the
      asserted field removed — proving a missing field fails rather than reading as satisfied.
- [ ] **Test (determinism):** two consecutive runs against unchanged state produce identical
      per-clause statuses and identical `overall`.
- [ ] **Test (non-vacuity negative control):** an all-voided clause set and an empty clause set both
      produce FAIL — an implementation summing only `pass` counts returns PASS and MUST fail.
- [ ] **Test (F10 ordering):** a fixture whose re-verify timestamp falls *after* the PR creation
      timestamp → `DF5.4-C6` fails; an implementation asserting only that both records exist MUST fail.
- [ ] **Test (two-layer doctrine negative control):** a fixture whose harvested `gate_results` rows are
      all green but whose DF5.1 `ReverifyReport` is `red` → the gate is FAIL, named on `DF5.4-C6`, and
      `C4`'s `pass` does not rescue it. An implementation that treats an in-box green as proof of a
      passed gate returns PASS and MUST fail this test.
- [ ] **Test (approval evidence location):** a fixture whose `extensions.approval.state` is `approved`
      passes C7; a fixture with an approval-shaped `.sandbox/approvals/<runId>.json` and **no**
      `extensions.approval` fails C7. An implementation reading the filesystem path MUST fail this test.
- [ ] **Test (approval-precedes-PR ordering):** a fixture whose `decidedAt` falls after
      `extensions.pr.createdAt` → C7 fails, even though C6 is green.
- [ ] **Test (C9 depth):** a chain whose hop-4 credential links were never emitted → C9 fails, even
      when the walker exits 0. An implementation asserting only the exit code passes and MUST fail
      this test. C9's parse target is the imported `ChainReport`; a locally re-declared shape MUST fail
      typecheck rather than drift.
- [ ] **Test (C9 tamper, two walks):** the gate is run **twice** against the same run of record —
      both walks against the **same scratch copy** (one `mkdtempSync`, both invocations pointed at
      it; a fresh copy per walk would hand the second walk a cold, tamper-free baseline and
      silently vacate this test). The
      first walk mints the hop-1/7/8 digest baseline and C9 passes; between the walks the bound
      `ReverifyReport`'s `verdict` is edited in place; the second walk yields `evidence-mismatch` on hop
      7 and C9 fails. `evidence-mismatch` is a second-and-later-walk guarantee (`df5-3` Technical
      Notes) — an implementation asserting it on a single cold walk MUST fail this test.
- [ ] **Test (C8 shape, not mapping):** a PR body whose `Issue:` line reads `unresolved` passes C8; a
      body with no `Issue:` line at all fails it — the clause never depends on P1.3 resolving. C8's
      input is the frozen `pr-body.txt` through `--pr-body`; a gate run with the network path reachable
      at all MUST fail this test (the fixture is frozen or it is not).
- [ ] **Test (C3 empty envelope):** a `trace/events.jsonl` with **zero** lines makes C3 red — the
      "at least one well-formed line" conjunct's mutant. *The generic removed-field mutant does not
      generate this case (there is no field to remove), so this leg is its own fixture.*
- [ ] **Test (fixture has no hot WAL):** the captured `tests/gate/fixtures/df5-run-of-record/` has no
      non-empty `cost-ledger.db-wal`, and `CostLedger.openReadOnly()` against it succeeds rather than
      hitting DF2.11's hot-WAL refusal. A capture tool that copies the ledger without checkpointing
      produces a fixture on which C10 `skip`s, and MUST fail this test.
- [ ] **Test (VOID reason parity):** `DF5.4-V1`'s report `detail` equals `` `VOID — ${OQ4_VOID_REASON}` ``
      with `OQ4_VOID_REASON` imported from `src/audit/index.ts` (DF5.3) — asserted equal, not retyped; a
      copied string literal MUST fail, and so must an assertion against a `void_reason` report field,
      which the chassis does not emit (`gate-runner.ts:77-86`, `:117-128`, `:174`).
- [ ] **Test (e2e demo — MANDATORY):** run the gate against the recorded lights-on run, capturing the
      report (eleven `pass`, `DF5.4-V1` `void` with reason, `DF_GATE: PASS`, exit `0`); then **twice**
      more — once with the re-verify record **deleted** (`DF5.4-C6` `skip` with the path named,
      `DF5.4-C7` `skip`, `DF5.4-C9` `fail`, `DF_GATE: FAIL`, exit `1`) and once with it **present but
      `red`** (`DF5.4-C6` `fail`, verdict named, `DF_GATE: FAIL`, exit `1`). An implementation
      collapsing `skip` and `fail` into one status, or reporting only C6 on the delete arm, MUST fail
      this item.

## Dev Agent Record

Implemented 2026-09-19 on `feature/df5-4-lights-on-gate` (unlazy scope `.unlazy/df5-4/`, 7 leaves + 2 nodes, PLAN rev 2).

**Run of record:** `qds-20260918-cc93a3` — the DF3.8 live e2e round-2 GREEN run (real boxes, real spend 2184 µ$, PR [#10](https://github.com/Quantum-Digital-Solutions/qds-audit-demo/pull/10)). Captured once via `scripts/dev/capture-run-of-record.ts` (live step: `PRAGMA wal_checkpoint(TRUNCATE)` on the real ledger, one `gh pr view 10` read for the frozen body, `refs.git` built by ref-limited `git bundle` + fetch with `cat-file -e` verification) into `tests/gate/fixtures/df5-run-of-record/`.

**Files (as specified):** `src/gate/assertions/{df5-execution,df5-boundary,df5-accounting}.ts`; `src/gate/assertions/lib/verdict.ts` (additive: `scanNdjson`, `strictBeforeMs`, `selectBoundReport`, `readJsonEvidence`); `scripts/df5-lights-on-gate.ts`; `scripts/dev/capture-run-of-record.ts`; `tests/gate/df5-assertions.test.ts` (125 tests: verdict-lib 20 + execution 48 + boundary 27 + accounting 30, consolidated from three dev-time private suites, executed-count equality asserted); `tests/gate/df5-lights-on-gate.test.ts` (16 tests); the fixture directory. Chassis (`gate-runner.ts`) untouched — `git diff dev` proves it.

**E2E demo (three arms, evidence in `_bmad-output/evidence/df5-4/`):**
- GREEN: 11 pass + `DF5.4-V1` void with the imported `OQ4_VOID_REASON`, `DF_GATE: PASS`, exit 0, schema-valid versioned wrapper.
- Reverify deleted: `DF5.4-C6` skip naming the jsonl path, `DF5.4-C7` skip, `DF5.4-C9` fail (walker refuses on the missing hop-7 artefact), `DF_GATE: FAIL`, exit 1 — three clauses strand, not one.
- Reverify red: `DF5.4-C6` fail naming `verdict=red`, `DF5.4-C9` fail on `evidence-mismatch` (second-walk digest), exit 1.

**Deviations and drift notes (recorded per the deviation clause, never silently reinterpreted):**
1. Story line-cite drift vs code: `src/gate/gate-runner.ts` (kebab-case), `src/fleet/dispatch.ts`, `src/phase-engine/trace/schema.ts:84-93`; `GateAssertionResult.duration_ms`; harvest WAL handling at `src/providers/harvest.ts:643-676`; `CostLedger.openReadOnly` carries a fourth refusal code `ledger-unopenable` (C10 skips name all four).
2. `strictBeforeMs` accepts the canonical instant with its necessarily-`.000` milliseconds elided (`…54Z` ≡ `…54.000Z`) — a literal `toISOString()` round-trip would reject the story's own example stamp; one notch looser than chain.ts `msOf`, documented in the helper's JSDoc.
3. Identity-window arm: interposing a swap inside the walker's probe→bind window is not deterministically constructible from outside the process (microsecond window; a race would flake). Asserted instead at the opener the gate invokes (`__auditStoreTestHooks.probeAndBind`, rename-based inode replacement, refusal + byte-identical replacement + zero-write proof) with the gate-level red consequence covered by the absent-store, swapped-store, tamper and depth arms.
4. Audit-links link check fires for every non-BAD hop status (story: unconditional on hops 4/5/6) but skips statuses already reporting a BAD-hop violation, so one defect is not double-counted as two violations.
5. Suite consolidation ran with executed-count equality (125 = 20+48+27+30) as the preservation oracle; raw `test(`-declaration grep was rejected (matches docblocks/paths).
6. Fixture layout: the freeze tool stores the reverify jsonl as `<runId>.reverify.jsonl`; harnesses rename it to `readReports`' `<runId>.jsonl` convention when copying to scratch — documented in the driver help and both suite headers.
7. Fixture ledger copy is converted to DELETE journal mode after the checkpoint (`selfContainLedgerCopy`): a WAL-mode db with no `-shm` beside it is exactly DF2.11's `ledger-unopenable` on readonly open (rehearsal-proven), and a copied `-shm` is nondeterministic — the ×3 file-set snapshot requires exact bytes.
8. W2 module subagents died to a provider 429 mid-flight; the driver session completed and verified the remaining leaves per the operator's finish directive (all leaf ledgers green under driver re-verification).
9. `--run-id` is a hard-required driver flag although the spec's Trigger Surface/E2E command and DoD flag list omit it — the gate asserts exactly one run of record, so the flag is load-bearing; help text documents it (review round 1, auditor).
10. C8 accepts any non-empty `Issue:` value, not only a resolved reference or the literal `unresolved` — the mirror index is out of the v5 slate, so demanding resolution could never go green on an issue-less run; the DoD's two C8 controls (unresolved passes, absent line fails) both hold (review round 1, auditor).
11. The versioned wrapper carries an additive `request_id` key beyond the pinned `{gate, gate_version, clause_map_version, report}` shape — the Observability Contract's "requestId … stamped on the report" wants it; `GateReportSchema` validation is unaffected (review round 1, auditor).
12. The frozen fixture ships one extra file beyond the story manifest: `<runId>.bundle` — C9's run-bundle hop digest-checks it against the audit link rows; without it C9 could never go green (review round 1, auditor).
13. `tests/scripts/build-exedev-image.test.ts` carries a `buildIdFileInputs` pin update (`99af1da0…` → `b3c30d0c…`) outside this story's Files to Modify — pairing-debt adoption, proven stale on clean `dev` before this branch (changed-files ∩ walk = ∅, digest recomputed byte-identical); documented in-code, listed here per the deviation clause (review round 2, auditor).
14. Off-story evidence regeneration reverted: running the DF1.4 e2e suite on the branch rewrote `_bmad-output/evidence/df1-4/{e2e-two-phase-trace.db,two-page-read.json}` in place; both restored to the `dev` versions in review round 2 (review round 2, auditor).

**Gates:** full `bun test` + `bun run typecheck` + `bunx biome check` green; `check-defensive-programming.sh --base origin/dev` clean (one real fix: the C6 `as unknown as` double cast replaced by an `every()`-guarded narrow; remaining sites annotated `dp:ok` with reasons); `check-pr-conflicts.sh --base origin/dev` no overlaps; `detect_changes` low risk, zero affected processes, zero chassis deltas.

---

**Status:** done (review round 2 complete — 35 verified findings patched across driver/capture/assertion modules and both test suites, 1 reviewer HIGH dismissed as false positive with chassis-source proof, 2 further dismissals verified; all gates green)

### Review Findings (round 2 — bmad adversarial review, 2026-09-19)

7 review agents (2 blind-hunter chunks, 4 edge-hunter chunks, 1 acceptance auditor) over the post-round-1 PR diff; 47 raw findings → triaged to 28 wave-1 source patches (3 disjoint fixer clusters: driver, capture tool, assertion modules), 9 wave-2 test items (2 fixers), 2 lead items (evidence revert + this deviation entry), 3 dismissals. 0 deferred, 0 decision-needed (conservative fail-safe applied: every ambiguous call resolved fail-closed).

Patched — driver (`scripts/df5-lights-on-gate.ts`):
- [x] Verdict lines (incl `overall:"PASS"` summary) hit stderr BEFORE the report write; a write fault exited 2 "usage" with PASS already claimed → report written atomically FIRST (tmp+`renameSync`, tmp unlinked on failure), then verdict emission; header contract now true in both directions (HIGH-adjacent, 3 reviewers converged)
- [x] Non-atomic `writeFileSync` could strand truncated JSON at the evidence path while exit 2 claimed "no report written" → tmp+rename
- [x] `existsSync` before `mkdirSync(recursive)` TOCTOU → guard dropped (mkdir is idempotent)
- [x] `--run-id` shape: `..` substring, leading `.`, leading `-` (`--run-id=--runs-dir` flag-mangled the C9 walker argv — verified live), trailing `.lock` all admitted → rejected with per-rule messages
- [x] No length bound (NAME_MAX blowup misreported as usage) → 128-char cap
- [x] Every post-flag fault printed "usage … try --help" → phase tracking: `usage` prefix for flag faults, `error` prefix + honest remediation after
- [x] Observability Contract: fail/skip stderr lines carried `remediation` but no `code`/`message` → both added (`code` = typed-code extracted from detail, else `evidence-unreadable`/`assertion-failed`)
- [x] Deviation-6 reverify rename absent from operator-facing `--help` → documented

Patched — capture tool (`scripts/dev/capture-run-of-record.ts`):
- [x] audit.db live-writer guard checked `-wal` but the store journals DELETE (`link-store.ts` asserts it) — the real signal is a non-empty `-journal`, and a mid-transaction copy shipped a torn db undetected → `-journal` refusal + post-copy recheck (HIGH)
- [x] Copy-phase faults (ENOSPC/EACCES) exited 2 "usage", printed no remediation, locked the partial fixture → typed `copy-failed` + cleanup + stale comment fixed
- [x] `freezeRefs` created `<out>/refs.git` before any verifiable step; every ref-class refusal left `<out>` locked → created-output cleanup on freeze failure (C7 invariant restored)
- [x] Dry-run probed `file:` PR-body with `existsSync` only (EISDIR/EACCES passed dry-run) → real read probe
- [x] 0-byte/table-less ledger & audit.db froze as success; bundle never verified → schema-presence assertions (`ledger-schema-absent`/`audit-schema-absent`) + `git bundle verify`
- [x] `cpSync(dereference:true)` hangs on symlink→FIFO, ELOOP on cycles → bounded lstat pre-walk refusing irregular entries
- [x] No `--out`-vs-source containment → `relative()`-segment overlap refusal
- [x] Pre-existing-empty `<out>` skipped the concurrency guard → exclusive `capture-in-progress` sentinel in both branches
- [x] Residue scan stat/read unguarded (dangling symlink → exit 2 "usage") → typed `residue-unreadable`
- [x] Empty PR body reported as gh failure ("failed (exit 0)") → distinct `pr-body-empty`
- [x] Only top-level files 0600; artifacts + refs.git world-readable → full-fixture 0600 chmod walk
- [x] Docblock dry-run exception sentence inverted → fixed
- [x] cwd- vs REPO_ROOT-anchored split-brain → HELP note (cwd anchoring matches the gate's own resolution)
- [x] (same class, found during arm testing) `out-unwritable` typed refusal for non-EEXIST create failures

Patched — assertion modules (`src/gate/assertions/*`):
- [x] `verdict()` router saw only `{failures}` and returned PASS for auditors' `{failures:[], skip}` arms — skip enforced by closure convention → router accepts `skip` and fails closed (shipped closures byte-identical)
- [x] INV-GATE-2 gap: `auditChainReport` interpolated raw runs keys into violations; C5 embedded raw git stderr — unscrubbed → scrub at each module's detail-composition choke point
- [x] P1 misdiagnosed a mid-gate read failure as "not valid JSON" (accessSync→read race) → atomic read+parse with distinct read-failure skip wording; `readJsonEvidenceDiagnosed` added additively
- [x] `describeWalkerExit` labeled every null exit "walker budget" → signal-aware (names SIGKILL source honestly)
- [x] `boundStderrTail` sliced before newline collapse (~3× ceiling escape) → collapse-then-slice
- [x] `emittedLinkCount` docblock contradicted resolved-gated code → comment fixed
- [x] C8 token boundary admitted hyphen-extension (`run-123-extra` satisfied `run-123`) → boundary class excludes `-` (intentional behavior change; suite re-pinned)

Patched — tests (`df5-assertions.test.ts` 143→147, `df5-lights-on-gate.test.ts` 17→20, `build-exedev-image.test.ts` comment):
- [x] Vacuous `detail.linkIds` arm (spread kept `linkId:3711`; second counting path never reachable) → hops rebuilt without `linkId` + non-array `linkIds` mutant proving the branch load-bearing
- [x] C9 depth arm's needle satisfied by walker stderr echo alone → checker-authored per-hop phrase asserted; walker-exit-0 variant proven non-constructible (chain.ts: resolved link-bearing hops always carry `linkId`; missing rows are `unlinked` → exit 1) and documented on the arm
- [x] `toContain("2")` vacuous needle → `toContain("exit code 2")`
- [x] P1 mode-000 arm lacked win32 guard its sibling comments claimed parity with → guard added, comments made truthful
- [x] C8 never-touches-network now TESTED (fetch spy asserted zero calls), not just by construction
- [x] Hygiene arm red on root lanes (rev-parse of the checked-in fixture under git dubious-ownership) → `skipIf(root)` (b5f71bd7 precedent)
- [x] Orphan driver could outlive test timeout and recreate deleted scratch → `afterAll` child sweep before rmSync
- [x] "50 changed files" audit-trail comment → 56 (count + intersection-empty re-verified)
- [x] Hot-WAL DoD arm asserted via raw readonly sqlite open, not the named seam → `CostLedger.openReadOnly().readRunCost()` asserting `hasEvents` + non-zero total (also pins the read path's own refusal classes)
- [x] New wave-1 behavior pinned: run-id shape arms (4), length boundary (129 rejects / 128 runs), post-flag `error`-prefix fatal, `code`/`message` on skip lines (default + typed `audit-store-absent`)
- [x] C7 inverted arm + hyphen-extension fails + punctuation-delimited passes

Lead items:
- [x] `_bmad-output/evidence/df1-4/*` regenerated in-PR by running the DF1.4 e2e suite on the branch (undeclared off-story mutation of another story's audit chain) → reverted to `dev` versions; recorded as deviation 14
- [x] buildId re-pin undeclared in this record → deviation 13 above

Dismissed (3, verified against source):
- [HIGH→FALSE POSITIVE] "Report can carry fewer assertion rows than submitted; verdict computed over a truncated set" — chassis-proven impossible: `gate-runner.ts:290-303` fills budget-expired AND unsettled holes with `fail` rows ("assertion never produced a result"); the chassis is already fail-closed, the driver receives all rows.
- Default `--report` path clobber across runs — round-1 dismissal stands (spec-pinned path, single-operator CLI, `request_id` correlates).
- C6/C7/P1/C1/C2 evaluate independent evidence snapshots — frozen-of-record is the contract; an active rewriter of host evidence is outside the threat model; snapshot caching would add staleness for no modeled adversary.

Gates after round 2: focal suites 401 pass / 0 fail (3 files); biome clean on all 9 touched files; `bunx tsc --noEmit` exit 0; `detect_changes` low risk, 0 changed symbols, 0 affected processes; capture-tool refusal arms 12/12 typed exit 1 with typed messages (fixer-verified).

### Review Findings (round 1 — bmad adversarial review, 2026-09-19)

7 review agents (3 blind-hunter chunks, 3 edge-hunter chunks, 1 acceptance auditor) over the PR 269 diff; 98 raw findings → triaged to 41 source patches (3 fixer waves, disjoint clusters), 20 test-side items (2 fixer waves), 4 story-doc declarations (deviations 9–12 above), 9 dismissals. All patches applied and verified; 0 deferred, 0 decision-needed (conservative fail-safe applied where ambiguous — C7 malformed-approval now FAILs per its own INV-GATE-5 doctrine).

Patched (checked off):

Source — driver (`scripts/df5-lights-on-gate.ts`):
- [x] `--run-id` unvalidated (traversal into `<runsDir>/<runId>.json`, refs, walker argv) → RUN_ID_RE + `.`/`..` reject (HIGH)
- [x] stderr verdict lines emitted before `GateReportSchema.parse` — exit-2 paths claimed PASS → emission moved after parse (contract: exit 2 = no verdict claimed)
- [x] clause failures carried no `{code, message, remediation}` (Observability Contract) → remediation on fail/skip log lines + Blocking list
- [x] dead `?? 0` after unconditional `exitCode` assignment; duplicated `dp:ok` comment

Source — capture tool (`scripts/dev/capture-run-of-record.ts`):
- [x] dry-run with missing `file:` body still exited 0 "ok" → NOT ok + exit 1
- [x] dry-run residue line printed for `gh` though gh ignores residue
- [x] residue scan `startsWith(runId)` prefix-matched sibling runs (`qds-1` vs `qds-12.json`)
- [x] `audit.db` copied with no `-wal` sidecar check → `audit-wal-live` refusal
- [x] hot `trace.db-wal` frozen verbatim → `artifacts-wal-live` refusal
- [x] `refuse()` inside `freezeRefs` try skipped the tmp-bundle `finally` (process.exit) → typed throw, cleanup before exit
- [x] plain copies preceded `freezeRefs` — ref-freeze refusal locked a partial fixture → refreeze-first order
- [x] concurrent captures both passed the idempotence guard → exclusive mkdir, `capture-in-progress`
- [x] ledger TOCTOU (writer resumes between checkpoint and copy) → post-copy `-wal` re-check refusal
- [x] sha256 refs (64-hex) misdiagnosed `sandbox-ref-absent` → 40|64 accepted
- [x] worktree `.git` file refused → `gitdir:` pointer followed
- [x] no subprocess timeout (hung gh hung capture) → 120 s SIGKILL
- [x] `mustExistFile` stat outside try / FIFO-blocking probe → stat-first, non-regular refused before open
- [x] symlinked artifacts entries escaped the frozen copy → `dereference: true`
- [x] frozen PR body lost whitespace to `trim()` → raw stdout carried
- [x] only pr-body.txt was 0600 → all frozen top-level files 0600
- [x] RUN_ID_RE admitted `.`/`..`

Source — assertion modules (`lib/verdict.ts`, `df5-{execution,boundary,accounting}.ts`):
- [x] C10 threw on JSON-`null` record (`=== undefined` guard) → object-shape guard, typed skip (HIGH, edge)
- [x] `auditChainReport` threw on `null` walker stdout → non-object = parse failure
- [x] `boundStderrTail` sliced BEFORE scrubbing — straddled token escaped every redaction shape → scrub-then-slice
- [x] `selectBoundReport` absent-check before superseded-check → superseded first
- [x] duplicate bound `reverifyId` lines: first-wins arbitrary → `bound-report-duplicate` reason
- [x] torn/invalid final jsonl line invisible (`readReports` drops + discards tail flag) → `readReportsWithTail`; C6/C7 skip naming the torn line, never green on partial evidence (HIGH, edge)
- [x] C7: approval present-but-malformed SKIPped, contradicting its own "absent/malformed FAILS" doctrine → now FAILs (behavior change; C6 unchanged)
- [x] C5 git spawn had no timeout → 15 s SIGKILL
- [x] C9 pass detail hardcoded "ten hops" → interpolated `AUDIT_HOPS.length`
- [x] dead NaN clamp on constant walker budget; `repoRoot` fallthrough + double call → typed `walker-script-missing`, single call; `describeWalkerExit` labeled every null exit SIGKILL-timeout → signal vs abnormal-exit split
- [x] `unreadableRecord` wording hid parse-invalid; `auditPrBody` substring runId match → token-boundary
- [x] SECRET_SHAPES lacked JWT shape → added; C10 accepted negative spend / non-positive ceiling → positive-assertion leg
- [x] `scanNdjson` counted bare scalars as well-formed (vacuous C3 green) → non-object = malformed; BOM malformated line 1 → stripped
- [x] `loadEvidence` catch comment claimed rethrow the code didn't do → comment states actual contract

Tests (`tests/gate/df5-assertions.test.ts` 125→143, `tests/gate/df5-lights-on-gate.test.ts` 16→17):
- [x] re-pinned 3 tests to wave-1 behavior (scanNdjson scalars, superseded-first, 10-hop oracle)
- [x] `@ts-expect-error` "inert directive" (blind HIGH) — FALSE POSITIVE, probe-proven: removing it produces TS2741 (directive honored despite continuation comment line); tsc green both ways
- [x] scrub test planted a token it never asserted → `sk_` underscore arm (8+ char floor as src defines)
- [x] "unreadable record" arm was a missing-file mutant → chmod-000 variant (root+win32 guarded)
- [x] C7 equality mutant hard-coded stamp → derived from bound report
- [x] hop-count oracles loose substrings → structural exact-match assertions
- [x] NaN-row multiplicity over-pin; dead `fixtureRecord` null guard; Windows chmod guard on mode-000 arm
- [x] new arms: torn final line (C6+C7), malformed-approval FAIL, `extensions.pr` absent, C10 null-record / negative-spend / string-spend, empty runs map, straddled-token redaction, prBody boundary (2), BOM, garbage trace.db, unjoinable requestId, mode-000 trace.db, strictBeforeMs NaN, duplicate bound id, `--run-id ..` usage fault
- [x] e2e INV-GATE-2 redaction now scans report + stdout + stderr; identity-window `probe.close()` in finally; preflight fail-fast asserts all 10 clauses; fatal-path arms get explicit timeouts

Dismissed (9, verified against source / declared records):
- Default `--report` concurrent collision — documented default is spec-pinned; single-operator CLI; `request_id` correlates on stderr.
- Unreachable pure-auditor branches — intentional: the spec mandates exported pure auditors; production closures guard first.
- Grep-parity test asserting source text — that IS the declared DoD control ("imported, never re-declared").
- buildId pin staleness race — ritual-owned; provenance re-verified (dev@7f4854fb, empty intersection); close-gate re-verifies at merge.
- Driver-suite runtime (~13 gate spawns) — spec-mandated arms; budgets documented.
- Boundary suite pointing `--git-dir` at the frozen refs.git — the git ops in play (rev-parse/cat-file) are read-only; fixture byte-checks would catch drift.
- Identity-window test is not a true race — declared deviation 3.
- stderr cosmetic pins (µ$ glyph, key order) — the log format is the contract.
- Reverify fixture layout mismatch (`<runId>.reverify.jsonl` vs `--reverify-dir` default) — declared deviation 6; harnesses rename on scratch copy; documented in driver help + suite headers.

False-positive pushback: none of the auditor's five findings were code defects — all four undeclared-deviation items (9–12 above) are now declared; the Observability-Contract remediation gap was real and is patched.

Gates after round 1: focal suites 394 pass / 0 fail (3 PR test files); biome clean on all 8 touched files; `bunx tsc --noEmit` clean; `detect_changes` low risk, 0 affected processes (changed symbols confined to the PR's own modules).
