# DF5.1: Host-Side Out-of-Box Re-Verify Before Any PR

**Story Points:** 4
**Sprint:** v5-S2 (lights-on head)

## Spec Reference

- `docs/superpowers/specs/2026-08-11-dark-factory-v5-architecture-design.md` §5.3 (data flow —
  "re-verifies out-of-box (F10): tests + gates re-run in a context that never trusted the box"),
  §6 item 6 (output integrity), §9 **R9**, §8 step 5
- Decision register: v5 §4 **D8** (host-side PR after out-of-box re-verify), D6 (TS phase engine)
- Contracts: v5 §5.2 — step output schema (CC-1 `exitStatus`, `changedFiles`, `testResults`);
  observability; per-check gate evidence (DF1.2)
- Derivation decisions: `.../2026-08-11-v5-story-derivation-decisions.md` **DD-8** — this story is
  **net-new**: no phase-1 ancestry, no surviving clause cited
- Binding facts: R5 §6 facts **15** (in-box evidence is claims, not proof), **16** (the trace DB
  carries client source code), **17** (host-side PR)

## User Story

As a factory operator,
I want the harvested commits re-tested and re-gated on the host, by code that read nothing the box
produced,
so that the decision to open a PR rests on evidence the box could not have written.

## Overview

`reverify(runId)` is the first host-side step after DF2.5 fetches a run's commits into
`refs/sandbox/<run-id>`. It creates a detached git worktree off that quarantine ref, resolves the
gate plan from the **host's** pinned pipeline manifest at the FILL base sha — never from the manifest
inside the harvested tree — and re-runs the tests and the DF1.2 gate library in a fresh process whose
inputs are the fetched git objects and nothing else. The result is a `ReverifyReport`: a
`green`/`red`/`error` verdict, the per-check evidence array, and a recorded comparison against the
box's claim. DF3.4 and DF5.2 read that verdict; DF5.3 links the report into the audit chain.

## E2E Slice

**Demonstrable behavior:** Given `refs/sandbox/<run-id>` carrying three commits whose in-box merged
output claimed `testResults: { passed: 12, failed: 0 }`, When the operator runs `bun
scripts/reverify.ts <run-id>`, it adds a detached worktree at `.sandbox/reverify/<run-id>` → installs
`--frozen-lockfile --ignore-scripts` → runs the host-pinned gate plan → appends
`.sandbox/reverify/<run-id>.jsonl` with `verdict: "green"`, `checks` naming every item examined,
`testResults: { passed: 12, failed: 0 }`, `flags: []`, `discrepancies: []` → prunes the worktree.
Seeding one failing test into those commits flips the run to `verdict: "red"` with
`discrepancies: ["testResults.failed: claimed 0, host 1"]`.

**Wiring closed:** On completion of this story, out-of-box re-verification is real for any harvested
run using only code merged by this story plus DF2.5's quarantine ref and DF1.2's gate library. No
stub, no `TODO: wire later`. Deciding the approval is DF3.4's and opening the PR is DF5.2's; this
story only *requests* the approval on a green verdict (AC6).

**Dependency edges (predecessors):** DF1.1, DF1.2, DF1.6, DF2.1, DF2.5, DF3.4.

## Acceptance Criteria

1. **(make-or-break)** Given a run harvested to `refs/sandbox/<run-id>`, When `reverify(runId)` runs,
   Then the verdict is computed **only** from the fetched git objects and the host toolchain, and a
   `ReverifyReport` is persisted carrying `verdict`, `headSha`, `baseSha`, `checks` (one `GateCheck`
   per item examined, `note` populated on passes as evidence — DF1.2 AC1), `testResults`, `flags`,
   `discrepancies`, `toolchain`, `durationMs`. *Negative control: an implementation that reads
   `testResults` from the harvested merged step output and reports it as its own result satisfies the
   happy path and MUST fail this story's authority test.*
2. Given the harvested tree contains a pipeline manifest, a `package.json` or a test-runner config
   differing from the host's copy at `baseSha`, When the gate plan is resolved, Then the plan comes
   from the **host's** pinned manifest and the divergence is recorded as a `flag`, never applied. The
   tree supplies code to run; it never supplies the command that judges it.
3. Given the box claimed `exitStatus: "success"` with green in-box gates and the host run comes back
   red, When the report is written, Then the verdict is `red`, each mismatch is enumerated in
   `discrepancies`, and no code path lets an in-box claim raise a host verdict. Box red with host
   green is recorded the same way, and the host verdict still stands.
4. Given the host cannot complete the check at all (worktree creation fails, the toolchain is
   missing, install or a gate subprocess cannot be spawned, the wall-clock or RSS bound is hit), When
   `reverify` returns, Then the verdict is `error` with the cause named, the worktree is pruned, and
   the process exits non-zero without retrying indefinitely. `error` is never treated as `green`.
5. Given a run harvested as `harvested: none` (zero commits beyond base, DF2.5 AC4), or a gate plan
   resolving to zero checks, When `reverify` runs, Then the verdict is `red` with reason
   `nothing-to-verify`, no worktree is created, and the call succeeds as a normal typed outcome
   rather than crashing — an empty check set is never green.
6. Given the report is written, When the verdict is `green`, Then `reverify` calls
   `requestApproval(runId, { proposal, reportId, headSha })` (DF3.4) with the just-written report —
   `reportId` is that report's `reverifyId` and `headSha` is that report's `headSha` — and returns
   without opening a PR; a `red` or `error` verdict does not call it. This story is the **single
   owner** of the `requestApproval` caller — no other story invokes it, so a run that earns a green
   host verdict is the only run that ever pauses for a decision. Given the run already carries an
   `ApprovalRecord` in the **awaiting-approval** state when a later green verdict is written, Then
   that record is **rebound atomically** to the new `reportId`/`headSha`, recording the
   superseded `reportId`, rather than attempting a second `O_EXCL` create — so a re-run of `reverify`
   never bricks the run on a record bound to a stale report. Given the record is in the
   **`pausing`** state (created `O_EXCL` before teardown, not yet promoted — DF3.4), Then it is
   **neither rebound nor requested against**: no `requestApproval` call is made, the record is left
   exactly as written, and the report carries `flags: ["approval-pause-in-progress"]`; DF3.4's
   resume path is what clears that state by completing the promotion to awaiting-approval. Given the
   record is **terminal** (approved, rejected or timed-out), Then no request is made and the report
   carries `flags: ["approval-already-decided"]`. *Negative control: an implementation that calls
   `requestApproval` on a `red` verdict, that opens a PR from this code path, or that leaves an
   undecided record bound to a superseded `reportId`, MUST fail.*

## Trigger Surface

| Trigger | Status | E2E Test | Follow-Up |
|---------|--------|----------|-----------|
| `bun scripts/reverify.ts <run-id>` CLI | in-scope | `tests/reverify/runner.test.ts` | — |
| `reverify(runId)` called programmatically after DF2.5 harvest | in-scope | `tests/reverify/runner.test.ts` | — |
| `fleet reverify` subcommand on the dispatcher CLI | out-of-scope | — | DF3.1 |
| `requestApproval(runId, { proposal, reportId, headSha })` called on a green verdict (AC6) | in-scope | `tests/reverify/runner.test.ts` | — |
| Deciding the approval (approve/reject intake, record write, teardown-at-pause) | out-of-scope | — | DF3.4 |
| PR creation gated on the verdict | out-of-scope | — | DF5.2 |
| Re-verify evidence joined into the audit chain | out-of-scope | — | DF5.3 |
| Lights-on gate asserting a re-verify preceded the PR | out-of-scope | — | DF5.4 |

## Infra Prerequisites

| Component | Service (compose/k8s/provider) | Lifecycle Hook Verified |
|-----------|-------------------------------|-------------------------|
| Quarantine ref `refs/sandbox/<run-id>` | DF2.5 harvest, host git | preflight asserts the ref exists and `git bundle verify` already passed; absent ⇒ `error`, no worktree created |
| Host git `worktree add --detach`, test runner, package manager | host toolchain (`git`, `bun test`, `bun install`) | preflight probes each and records versions into `toolchain`; any missing ⇒ `error` verdict, never a pass (INV-RV-5) |
| DF1.2 gate library + `commandGate` | in-repo `src/phase-engine/gates/` | imported in-process; `bun test tests/phase-engine/gates.test.ts` green before this story starts |
| `baseSha` for the worktree and the manifest lookup | DF2.1 run record `commitSha` — the pinned SHA the box was filled at | read from the host-side run record, never from the harvested tree or the quarantine ref's parents; absent or unparseable ⇒ `error`, no worktree created |
| Host-pinned pipeline manifest at `baseSha` | DF1.1 manifest, resolved from the **operator's** `.factory/pipeline.json` entry keyed by the run record's `repoSlug` — never from the target repository's checkout and never from harvest output | the entry resolves and its manifest schema-validates at `baseSha` before any subprocess runs (AC2); no entry for the `repoSlug` ⇒ `error` with reason `no-host-plan`, no worktree created |
| Harvested artifacts tar + trace DB + merged step output | DF2.5 harvest output, host filesystem; the merged step output's schema is **DF1.6's** (`exitStatus`, `changedFiles`, `testResults`) — the one thing this story consumes from DF1.6, and the shape `claimed` is parsed against | read **only** to populate `claimed` for comparison; absent ⇒ `claimed: null`, which never blocks a verdict |

## Technical Notes

- **Contracts/Schema (new, owned here):** `ReverifyReport { reverifyId, runId, requestId, headSha,
  baseSha, verdict: "green"|"red"|"error", reason?, startedAt, completedAt, durationMs, checks: GateCheck[],
  testResults: { passed: number, failed: number }, flags: string[], discrepancies: string[],
  claimed: { exitStatus, testResults, changedFiles } | null, toolchain: Record<string,string> }`.
  `GateCheck` is DF1.2's type, imported not re-declared; `exitStatus` comes from
  `cli-anything/src/types.ts:79` (CC-1).
- **Approval binding, named once:** `ApprovalRecord.reportId` **is** `ReverifyReport.reverifyId`, and
  `ApprovalRecord.headSha` is that same report's `headSha`. Those are the two values AC6 passes into
  `requestApproval(runId, { proposal, reportId, headSha })`, and the two DF5.2 re-checks before it
  pushes — the approval is bound to one report, not to a run in general.
- **Why the plan is host-pinned (the point of the story):** a skip-permissions agent controls
  everything the box emits (§6 item 5), so it also controls any judge shipping inside the tree. Gate
  argv originates from the schema-validated manifest, never from run output — DF1.2 INV-1's rule
  applied at the boundary. Allowed inputs are the fetched git objects, the host manifest at
  `baseSha`, and the host toolchain; the trace DB, in-box `GateReport`s, `run.log` and merged step
  output feed `claimed`/`discrepancies` only.
- **`testsExecuted` disambiguation, host-side** (rule form from
  `p1-6-pi-team-protocol-step.md:62`): `testResults.passed + testResults.failed === 0` means "no
  tests ran" ⇒ `red`, reason `no-tests-executed` — never a vacuous green. A repository with no suite
  declares that in the host manifest, and the plan then carries the non-test checks.
- **Determinism over retries:** a red is never retried into a green. Re-running `reverify` writes a
  new report with its own `reverifyId`, both retained append-only, DF5.2 reads the latest, and two
  runs at the same sha that disagree set `flags: ["nondeterministic"]` and force `red`. This mirrors
  §8 step 0's discipline (flaky ⇒ rerun once, then FAIL): a rerun-until-green loop reproduces exactly
  the forgeability F10 exists to close.
- **Evidence flags, not blocks:** `flags` records `test-files-modified`,
  `dependency-manifest-modified` and `manifest-divergence` when the harvested diff touches those
  surfaces. Legitimate stories change tests, so these never fail the verdict; they are the
  reviewer-visible signal DF5.2 renders into the PR body.
- **Guards/limits:** wall-clock cap 30 min (configurable, floor 60 s) and RSS cap 4 GiB with SIGTERM
  then 5 s grace then SIGKILL, mapping to `error` — the in-box watchdog's shape
  (`p1-6-pi-team-protocol-step.md:114`) re-aimed at the host verify tree. `checks` caps at 500
  entries, each `note` at 1,000 characters **including** any `[truncated, N chars total]` suffix.
- **Deviation/assumption — run-authored code executes on the host.** Re-verification runs
  agent-authored code on the operator machine. Controls: `--frozen-lockfile --ignore-scripts`, a
  process environment with no provider key, GitHub token or approver token, the caps above, and a
  worktree confined to `.sandbox/reverify/`. A bounded, named exposure rather than a solved one; the
  upgrade path is a disposable host-side verify box under DF2.1's driver interface, as a follow-up.

## Observability Contract

- Every re-verify logs `{ requestId, runId, reverifyId, step, timestamp, durationMs, verdict }` per
  step — worktree, install, gate plan resolution, each gate, teardown.
- `requestId` propagates from the dispatch that created the run (DF3.1) via the run record, so DF5.3
  joins report to run without a second key; errors carry `{ code, message, remediation }`.
- Sub-timings: `worktree_ms`, `install_ms`, `tests_ms`, `gates_ms`, `cleanup_ms`. A step that did not
  run reports `0`; `durationMs` stays authoritative.

## Files to Modify

- `src/reverify/runner.ts`
- `src/reverify/worktree.ts`
- `src/reverify/report.ts`
- `src/reverify/index.ts`
- `scripts/reverify.ts`
- `tests/reverify/runner.test.ts`
- `tests/reverify/worktree.test.ts`
- `tests/reverify/fixtures/harvested-repo.ts`

## Security Invariants

- **INV-RV-1 (trust boundary — evidence authority):** the verdict is a function of the fetched git
  objects, the host-pinned manifest and the host toolchain only. No artifact produced inside a box —
  trace DB, gate report, `run.log`, merged step output — is an input to it (F10/R9; R5 §6 fact 15).
  *Negative control: an implementation that short-circuits to the box's claimed `testResults` MUST
  fail the authority test, which deletes every harvested artifact and asserts an identical verdict.*
- **INV-RV-2 (isolation of the host repository):** work happens in a detached worktree off
  `refs/sandbox/<run-id>`. No branch, tag, remote-tracking ref, index, `HEAD` or working tree of the
  operator repository is read for the verdict or written at any point, and the worktree is pruned on
  **every** exit path including `error` (DF2.5 INV-2's quarantine discipline, one step further on).
- **INV-RV-3 (untrusted-code execution controls):** dependencies install `--frozen-lockfile
  --ignore-scripts`; the verify process environment holds no provider key, GitHub token or approver
  token; the wall-clock and RSS caps are enforced by the host, not by the code under test. A lockfile
  or dependency-manifest change in the harvested diff is flagged into the report.
- **INV-RV-4 (confidentiality of harvested evidence):** the report embeds gate notes and test counts,
  never compiled prompts or trace-DB rows — that content is client source code (F11/R10; R5 §6 fact
  16). Notes pass through `redactSecrets` (`cli-anything/src/redact.ts:62`) at the report boundary,
  once, and the redaction map handed to it is a **purpose-built map of this run's known-sensitive
  values** — the minted provider key and its hash, the host GitHub token, the approver token, the run
  record's key material — assembled by the caller and **never** `process.env`. INV-RV-3 already
  strips those values from the verify process environment, so an implementation that redacts against
  the environment redacts nothing at all.
- **INV-RV-5 (fail-closed):** anything preventing completion yields `error`, which is not green; a
  zero-check plan is `red`; two runs at the same sha that disagree are `red`. No code path assigns
  `green` without both a completed test result and a gate report carrying at least one check, and
  `verdict` has no setter reachable from outside `report.ts`.

## Definition of Done

- [ ] **Impl:** `reverify(runId)` — detached worktree, scripts-free install, host-pinned gate plan, tests plus DF1.2 gates, report written, worktree pruned on every exit path.
- [ ] **Impl:** `claimed` populated from harvested artifacts when present, `discrepancies` enumerated in both directions; absence yields `claimed: null` and changes no verdict.
- [ ] **Contract:** `ReverifyReport` persisted append-only at `.sandbox/reverify/<run-id>.jsonl`, one record per line, last line authoritative for DF5.2; an undeclared field is rejected by the report layer rather than silently written.
- [ ] **Integration:** gates run through DF1.2's `commandGate` and gate library with no second implementation; the argv comes from DF1.1's manifest at `baseSha` (INV-RV-1, AC2).
- [ ] **Security:** verify process carries no credential; install runs `--ignore-scripts`; notes redacted at the report boundary against a purpose-built map of the run's known-sensitive values, asserted by a test that plants a sentinel secret in the **gate output** while keeping that sentinel out of `process.env`, then greps every log line and report field for it — an implementation redacting against `process.env` finds nothing to redact and MUST fail this test (INV-RV-3, INV-RV-4).
- [ ] **Test (authority, negative control):** delete the harvested trace DB, in-box gate reports and merged output, re-run → identical verdict and `checks`. An implementation reading the box's `testResults` MUST fail this test (INV-RV-1).
- [ ] **Test (manifest divergence):** a harvested tree whose manifest replaces the test command with `true` → the host plan is used unchanged, the divergence lands in `flags`, and a seeded failing test still produces `red` (AC2).
- [ ] **Test (error is not green):** remove the test runner from the resolved toolchain → `verdict: "error"`, non-zero exit, worktree pruned, `verdict === "green"` false (AC4, INV-RV-5).
- [ ] **Test (approval request, single owner):** a `green` verdict calls DF3.4's `requestApproval(runId, { proposal, reportId, headSha })` exactly once with the just-written report's `reverifyId` and `headSha`, and opens no PR; `red` and `error` verdicts call it zero times (AC6).
- [ ] **Test (rebind on re-verify):** a second `green` verdict on a run whose `ApprovalRecord` is still awaiting approval rebinds that record atomically to the new `reportId`/`headSha` with the superseded id recorded, creating no second record; the same second verdict against a `pausing` record leaves that record byte-identical, makes no request and sets `flags: ["approval-pause-in-progress"]`; against a terminal record it makes no request and sets `flags: ["approval-already-decided"]` (AC6).
- [ ] **Test (empty harvest boundary):** a run harvested as `harvested: none` → `red` with reason `nothing-to-verify`, no worktree created, no throw (AC5).
- [ ] **Test (e2e demo — MANDATORY):** against a real throwaway repository, a three-commit harvested run re-verifies `green`; seeding one failing test into those commits flips it to `red` with the populated `discrepancies` entry. Both reports land in the Dev Agent Record — the artifacts DF5.2 gates on and DF5.3 links.

## Dev Agent Record

**Branch:** `feature/df5-1-host-side-reverify` (from `main`)<br />
**Status:** implemented, all DOD items covered by tests

### Shipped

| File | Role |
|------|------|
| `src/reverify/report.ts` | `ReverifyReport` contract. `sealReport` is the ONLY place a verdict exists — derived, frozen, no setter (INV-RV-5). Append-only `.jsonl` persistence, zod `.strict()` undeclared-field rejection, `redactSecrets` at the boundary. |
| `src/reverify/worktree.ts` | `ReverifyError`, detached quarantine worktree with prune-on-every-exit-path (INV-RV-2), `probeToolchain`, and `withGuards` (wall-clock + RSS, SIGTERM then 5 s then SIGKILL sweep). |
| `src/reverify/plan.ts` | Host-pinned gate plan from the operator's `.factory/pipeline.json` keyed by `repoSlug` + the DF1.1 manifest it names (AC2), plus `divergenceFlags`. |
| `src/reverify/approval.ts` | The `ApprovalPort` seam and its RunRecord-backed adapter over `extensions.approval`. |
| `src/reverify/runner.ts` | `reverify(runId)` orchestration. |
| `src/reverify/index.ts` | Public surface. |
| `scripts/reverify.ts` | CLI. Exit 0 green / 1 red / 2 error. |
| `src/providers/run-record.ts` | **One addition**: registered the `approval` extension namespace (see Deviation 1). |
| `tests/reverify/{report,worktree,plan,approval,runner}.test.ts` + `fixtures/harvested-repo.ts` | 44 tests. The runner suite drives a REAL throwaway git repo, a real `refs/sandbox/<run-id>` and real `bun test` subprocesses. |

### Deviations and assumptions

1. **DF3.4 is not implemented.** No `requestApproval` / `ApprovalRecord` existed in `src/` when this
   story ran. Per operator decision, DF5.1 ships the **caller** (which it owns per AC6) behind an
   `ApprovalPort` interface, plus a RunRecord-backed adapter so AC6 is exercised end to end. DF3.4
   replaces the **adapter**, not the caller. Registering the `approval` namespace in
   `EXTENSION_NAMESPACES` was required for that adapter; gitnexus impact on that symbol: **LOW, 0
   upstream dependents** (additive entry). DF3.4 may extend the field set.
2. **AC6 wording vs DF3.4's hardened design.** AC6 describes a separate `ApprovalRecord` created
   `O_EXCL`; DF3.4's 2026-08-20 hardening moved approval state into `runRecord.extensions.approval`
   (namespace registration, PID lock, writable-after-close). Built against the **predecessor's**
   shape per operator decision. AC6's prose should be amended to match; the state machine it
   specifies (`pausing` untouched, `awaiting-approval` rebound atomically with the superseded id
   recorded, terminal left alone) is implemented verbatim.
3. **`noTestSuite` is host-declared.** The story's "a repository with no suite declares that in the
   host manifest" is implemented as a `noTestSuite: true` flag on the **`.factory/pipeline.json`
   entry**, not inside the DF1.1 manifest — `PipelineManifestSchema` is `.strict()` and this is
   operator config, never tree-supplied. It is the only thing that suppresses `no-tests-executed`,
   and it still cannot make an empty check set green.
4. **Read-then-write atomicity.** `RunRecordStore.set` is atomic but its lock is private, so the AC6
   read-decide-write is serialized by a separate `O_EXCL` lock at
   `<runsDir>/<run-id>.approval.lock` (5 s ceiling, 10 ms poll). Taking the store's own lock would
   deadlock inside `set`. Covered by a concurrency test.
5. **RSS enforcement ceiling** (`ponytail:` comment in `worktree.ts`): sampled every 2 s from `ps`
   over this process's descendant tree, not cgroups. Catches a runaway allocator, not a sub-2 s
   spike. Upgrade path is the disposable host-side verify box the story already names.
6. **`reverifyId` grammar.** Lowercase and hyphenated because it is written into the run record as
   `extensions.approval.reportId` and DF2.1's `assertNoSecret` refuses long mixed-case alphanumerics
   there as suspected key material.
7. **`claimed` is matched by SHAPE, not filename** — any `*.json` under
   `.sandbox/runs/<run-id>-artifacts/` carrying DF1.6's `{exitStatus, changedFiles, testResults}`.
   Absent, unreadable or unrecognisable all yield `claimed: null`, which never blocks a verdict.
8. **No `.factory/` shipped.** The host plan index is per-operator config naming per-repo manifests;
   creating one in this repo would point reverify at this repo's own pipeline. Operators author it.

### Operator setup

```json
// .factory/pipeline.json
{ "version": 1, "repos": { "acme/widget": { "manifest": ".factory/manifests/acme-widget.json" } } }
```

The named manifest is a normal DF1.1 pipeline manifest (`version: "1.0.0"`, **≥2 phases**). The first
phase declaring a `testCommand` is the host test run and its counts are the evidence; every other
phase carrying a `command` becomes a `commandGate`. The test phase's own `command` is not re-run.

### E2E demo artifacts (`tests/reverify/runner.test.ts`, "the e2e slice")

Three harvested commits against a real throwaway repo:

```
green: verdict "green", headSha=<3rd commit>, testResults {passed:1, failed:0},
       discrepancies [], approval {outcome:"requested"}, worktree pruned
red:   one seeded failing test at the same shape →
       verdict "red", testResults {passed:0, failed:1},
       discrepancies ["testResults.failed: claimed 0, host 1",
                      "exitStatus: claimed \"success\", host verdict red"],
       approval null
```

### DOD coverage

| DOD item | Test |
|---|---|
| Impl: worktree, scripts-free install, host plan, tests + gates, report, prune | `runner.test.ts` e2e slice |
| Impl: `claimed` both directions, absence changes no verdict | `runner.test.ts` INV-RV-1 block |
| Contract: append-only jsonl, undeclared field rejected | `report.test.ts` persistence + boundary |
| Integration: DF1.2 `commandGate`, argv from DF1.1 manifest | `runner.test.ts` AC2 block |
| Security: no credential, `--ignore-scripts`, sentinel in **gate output** not `process.env` | `runner.test.ts` INV-RV-3/4 block |
| Test (authority, negative control) | `runner.test.ts` "deleting every harvested artifact…" |
| Test (manifest divergence) | `runner.test.ts` "in-tree manifest replacing the test command with `true`" |
| Test (error is not green) | `runner.test.ts` "removing the test runner from the resolved toolchain" |
| Test (approval request, single owner) | `runner.test.ts` AC6 block (green once / red zero / error zero) |
| Test (rebind on re-verify) | `runner.test.ts` "the default adapter rebinds…" + `approval.test.ts` full state machine |
| Test (empty harvest boundary) | `runner.test.ts` AC5 block |
| Test (e2e demo — MANDATORY) | `runner.test.ts` "the e2e slice" |

### Follow-ups

- **DF3.4** replaces `recordApprovalPort` with its own adapter and owns the decide side. The caller
  contract in `approval.ts` is what it must satisfy.
- **DF5.2** reads the LAST line of `.sandbox/reverify/<run-id>.jsonl` and re-checks `reverifyId` +
  `headSha` against `extensions.approval` before pushing.
- AC6 prose amendment per Deviation 2.

### Post-implementation adversarial review

Three review passes over the implementation (verdict integrity / secret exposure, resource and
cleanup correctness, contract and failure paths). Nine findings, all fixed on this branch with a
test each where the logic is non-trivial:

| # | Finding | Fix |
|---|---|---|
| 1 | `claimed.changedFiles` — agent-controlled strings from the box's own artifacts — were copied into the report unredacted and uncapped, and DF5.2 renders the report into a PR body (INV-RV-4 leak). | Scrubbed through `scrub()` and capped at `CLAIMED_FILES_MAX` (500), with a `claimed-files-truncated` flag. |
| 2 | `readReports` threw on a torn jsonl line, and `reverify` calls it OUTSIDE its own try/catch — one half-written append turned a completed re-verify into an uncaught throw. | Unparseable lines are skipped. |
| 3 | `timings.cleanup_ms` was computed as `elapsed − gates_ms`, i.e. everything that was not gates. | Stamped at the worktree body's return; now measures the prune. |
| 4 | The guards' SIGKILL sweep re-read the process table 5 s AFTER firing and killed every current descendant of the host process — in a long-lived dispatcher, that is the next, unrelated subprocess. | The doomed pid set is snapshotted at fire time. |
| 5 | `scripts/reverify.ts` had no catch: a throw exited 1, which is the `red` code, not the `error` code. | Wrapped; a throw is exit 2. |
| 6 | `assertRedactable` re-spelled `SECRET_KEY_RE` and the length floor as literals, so a widened pattern in `redact.ts` would silently stop being enforced here. | Both imported from `redact.ts`. |
| 7 | An `error` verdict compared against a prior green branded the run `nondeterministic` — a flaky host probe read as flaky code. | Only two non-error verdicts at one sha can disagree. |
| 8 | `withQuarantineWorktree` is exported and `rmSync`s `resolve(root, runId)` recursively without validating `runId`. | `assertExistingRunId` before any path is derived. |
| 9 | A `noTestSuite` entry whose manifest had no non-test phase command produced a green resting on the `install` check alone; and a crashed holder's approval lock bricked every later approval for the run. | `resolveHostPlan` refuses that entry; the lock is stolen once older than `LOCK_STALE_MS` (2× the wait timeout, so a live holder is never robbed). |

Also: the approval request is now caught — a failing DF3.4 intake leaves a green report flagged
`approval-request-failed` and `approval: null` rather than throwing past `reverify`'s typed outcome.

Known ceilings left in place (documented, not fixed here): the verify process inherits `HOME`, so
`~/.npmrc` / `~/.gitconfig` credentials remain reachable during install, and RSS is sampled from
`ps` rather than enforced by a cgroup. Both are the disposable host-side verify box the story
already names as the follow-up.
