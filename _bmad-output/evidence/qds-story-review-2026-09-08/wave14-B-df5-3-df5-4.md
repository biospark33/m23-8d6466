# Wave 14 — Verifier B: DF5.3 (audit chain extended) + DF5.4 (lights-on gate)

Clean-eyes adversarial pre-dev review. Branch `dev` @ 4264f546 plus uncommitted spec edits; both
stories are Markdown SPEC files awaiting dev — reviewed as text against the working tree.

## Method + positive controls

**Reads.** Both story files end to end. Every named symbol, constant, flag, event, config key,
fixture, path and citation opened at source. No evidence/, tracker, HANDOFF, seam-ownership,
wave-report or fix-recipe input touched.

**Cross-story reads (permitted, named-seam only).** `p1-16-audit-chain-pr.md` and
`p1-17-phase1-exit-gate.md` (phase-1 archive) for the surviving-clause line cites, and
`docs/superpowers/specs/2026-08-31-tier2-placement-adr.md` for the tmpfs / two-layer cites. The
`df2-11:*` line cites inside both stories were **not** checked against the DF2.11 story text;
their substance was verified directly against `src/providers/cost-ledger.ts`.

**Enumeration (pairing mandate).** Grepped every construct/reference site in `src/`, `scripts/`,
`tests/` of: `ProvisionAdmittedRunOptions`, `CreateRunOptions`, `fillRun`, `createRun`,
`CredentialDeps`, `HarvestDeps`, `TeardownDeps`, `SweepDeps`, `harvestRun`, `teardownSandbox`,
`mintRunKey`/`deliverRunKey`/`revokeAndVerify`/`verifyRevoked`/`captureSpend`,
`runCredentialLifecycle`, `setupRun`, `executeRun`, `observeRun`. Compared every construct site
row by row against the Files-to-Modify lists.

**Zero-match claims, each with a positive control on identical machinery:**

| Claim | Control run | Result |
|---|---|---|
| "a `fetchBundle` symbol that exists nowhere in the tree" | `grep -rn fetchBundle src scripts tests` = 0; control `grep -c fetch src/providers/harvest.ts` = 13 | claim HOLDS |
| "No `dispatch_request_id` column exists in any store the walker opens" | `grep -rn dispatch_request_id src scripts tests` = 0; control `dispatchRequestId` = 20+ hits | claim HOLDS |
| "There is no `.sandbox/approvals/` file and there never was" | `grep -rn sandbox/approvals src scripts tests` = 0; control `.sandbox/` = 30 files | claim HOLDS (code surface) |
| "`package.json` declares no `bin`" | no `bin` key; control `"scripts"` key present | claim HOLDS |
| "`setupRun` … zero production callers; only callers in `tests/providers/driver-contract.test.ts`" | grep: only that test file calls it | claim HOLDS |
| "one `observeRun` call in `tests/providers/driver-contract.test.ts`" | grep: exactly one call site there | claim HOLDS |
| `GateAssertionResult` / `GateReportSchema` "have no `void_reason` key" | interface + zod schema read; control: `void_reason` exists on `GateAssertion` | claim HOLDS |

**OQ-4 byte-identity (mechanical).** Both stories' reason strings extracted, whitespace-flattened,
diffed: `OQ-4 unresolved — Hindsight has never booted on this host (arm64 libpq/openssl@3; :8888
collides with a local Jupyter); step-6 memory wiring is outside the v5 horizon` — IDENTICAL in
both stories. Both define it once as `OQ4_VOID_REASON` in `src/audit/index.ts`, imported by the
DF5.4 driver; the chassis renders it as `` detail: `VOID — ${a.void_reason}` `` (verified at the
VOID settlement block of `runGate`), and the result interface and report schema carry no
`void_reason` key. Parity is by construction. HELD.

**Scoped tests** (tee'd, ANSI/CR-stripped): `bun test tests/gate/phase0-exit-gate.test.ts` → exit
0, 45 tests (`/tmp/w14b-phase0.log`); `bun test tests/providers/reaper.test.ts` → exit 0, 43
tests (`/tmp/w14b-reaper.log`). The "45 cases" claim and the chassis-untouched premise both hold.

**Not verifiable under my constraints (noted, not scored):** "PHASE_0_GATE is currently FAIL on
upstream Phase-0 evidence (sprint-status P0.11)" — its source is a sprint-status tracker, a
forbidden input. "R5 §6 facts 15–18" — no R5 facts document located; the load-bearing fact
(in-box evidence is a claim) is independently verified in the tier-2 ADR. "DF1.10 merged
2026-09-06" corroborated only loosely by git history.

---

## DF5.3 — findings

| ID | Class | Sev | Finding |
|---|---|---|---|
| W14B-1 | C1 | LOW | The threading row lists `patterns` under the `tests/providers/` group. No `tests/providers/patterns.test.ts` exists; the file is `tests/fleet/patterns.test.ts`. Misfiled Files-list path. (That file mentions `TeardownDeps` only in a comment and constructs nothing widened, so it may not need threading at all.) Confidence: high. |
| W14B-2 | C2 | LOW | The hop-5 cell says `createRun` "is exercised by `scripts/cap-hit-demo.ts`'s create arm and by `tests/fleet/approval-gate.test.ts`" — a third caller exists: `tests/fleet/e2e/tier1-provision-status.live.test.ts` calls `createRun` directly. The Files list DOES name `tier1-provision-status.live`, so the typecheck criterion is unaffected; the prose enumeration is simply incomplete. Confidence: high. |
| W14B-3 | C2 | MEDIUM | Widening `CredentialDeps` with a required `recordAuditLink` forces the reaper's internal `credDeps` literal (built beside its internal `TeardownDeps` and passed to `revokeAndVerify(credDeps, …)` for leaked-key revoke+verify) to supply the field — but that path's step context carries **no runId** (`revokeAndVerify` builds its context with `runId: null`), while `audit_links.run_id` is NOT NULL. The spec never says what the reaper path threads: an emit is impossible without a runId, a sink contradicts the story's own "no no-op sink" precedent set for `createRun`, and the reaper appears in the emitter list only for `reap` (orphan path). A dev will hit this at typecheck and must invent semantics the spec doesn't state; one sentence ("the reaper's `revokeAndVerify` path threads a sink — it has no runId to emit against") closes it. Confidence: medium-high. |
| W14B-4 | C4 | LOW | Two wording inaccuracies whose conclusions hold: (a) the story says the `extensions.approval` registration docblock "closes with" the `dispatchRequestId`-join sentence — the sentence exists **verbatim** as quoted but is followed by a "See `emitPause`…" pointer and the States paragraph, so it does not close the docblock; (b) the reverify-dir parenthetical says `runner.ts` "resolves it from `hostRoot`/cwd only" — `deps.reverifyDir` is a first-class option; the accurate half of the claim (no *environment* seam — no env var feeds the reverify dir, unlike `QDS_RUNS_DIR`/`QDS_COST_LEDGER_FILE`) is correct and sufficient for the four-seam argument. Confidence: high. |
| W14B-5 | C4 | LOW | "`scripts/fleet.ts` and `scripts/sandbox-teardown.ts` (threading the now-required `HarvestDeps.recordAuditLink` at their existing `harvestRun` call sites)" — the threading lands at the `TeardownDeps` **construction** sites (the call sites pass whole deps objects); likewise the Scope note's "every `tests/providers/` fake" understates the row's own `tests/fleet/` and `tests/fleet/e2e/` scope. Harmless wording. Confidence: high. |
| W14B-6 | C4 | LOW | `src/audit/link-store.ts`, `src/audit/chain.ts`, `src/audit/index.ts` and `scripts/qds-audit.ts` do not exist yet (no `src/audit/` directory) — "Files to Modify" is strictly "Files to Create" for these. Conventional for pre-dev stories; noted only. Confidence: high. |

### DF5.3 — what HELD (verified at source)

- **Hop table line-anchors all exact:** `provisionAdmittedRun`, `createRun`, `fillRun`,
  `setupRun`, `executeRun`/`observeRun` sit at the cited positions in `driver.ts`;
  `trace/schema.ts` `sessions` PK and `gate_results.request_id` exact; `harvest.ts`
  `BOX_RUN_SOURCES` members `trace/trace.db` + `trace/trace.db-wal` (and the deliberate
  `trace.db-shm` omission) exact; the in-box best-effort checkpoint with `|| true` sits where
  cited; the bundle-record sentence is the harvest module header.
- **The threading enumeration is EXHAUSTIVE against my own grep** — this is the pairing mandate's
  core check and it passes. Every construct site of all five widened types lives in a named
  Files-list row: `dispatch.ts` and `createRun` for `ProvisionAdmittedRunOptions`;
  `cap-hit-demo`, `approval-gate.test`, `tier1-provision-status.live` for `CreateRunOptions`;
  `dispatch`, `cap-hit-demo`, `driver-contract`, `exedev/fill`, `fake-driver` for `fillRun`;
  reaper/teardown/dispatch/cap-hit-demo/credentials.test for `CredentialDeps`;
  harvest/teardown tests + named production files for `HarvestDeps`; fleet,
  sandbox-teardown, fanout-primitive, reaper, df2-11-teardown-race, teardown.test,
  approval-gate.test (inline untyped literal) for `TeardownDeps`; sandbox-reap + reaper +
  reaper.test for `SweepDeps`. The two files outside the list that *reference* the types are
  safe by mechanism: `src/providers/fake-gate.ts` mentions `HarvestDeps` in prose only, and
  `tests/scripts/sandbox-reap.test.ts` builds `Partial<SweepDeps>` (new required field stays
  optional under Partial — no typecheck break). The structural engine of the mandate holds:
  `TeardownDeps` is *structurally* assignable to `HarvestDeps` (not `extends`), and both
  interfaces would gain the identically-shaped required field, so every `TeardownDeps`
  construction is forced to carry it and stays assignable to `harvestRun`'s parameter — the
  "all three flow `TeardownDeps`" loudness claim is mechanically true.
- **Cost hop:** `CostLedger` exists as a class; `readRunCost(runId)` is a method whose docblock
  itself names "DF5.3 audit hop 3 / DF5.4 C10"; `readIssueCost` exists and is correctly
  distinguished; `CostView` carries `totalMicroUsd`/`perRole`/`hasEvents`/`hasTokenRows` exactly
  as AC5 needs; `ingestCostEvent` is documented as the only `kind='tokens'` writer and both
  `teardownSandbox` ingest points (close and close-recovery) call it through
  `ingestHarvestedTokensIfWired`; `ingestBoxHoursIfAttributed` requires a string
  `repoSlug`/`issueId`, matching the issue-less-run-is-broken-hop rule. `openReadOnly` is a
  static factory with the no-create probe (`ledger-absent`), inode-identity check
  (`ledger-identity-changed`) and hot-WAL refusal (`ledger-wal-recovery-required`), and its own
  log line states "no mkdir, chmod, mode assert, schema or persistent pragma effect" — matching
  every claim both stories make about it.
- **Reverify hop:** `report.ts` header verbatim ("the last line authoritative for DF5.2");
  `appendReport` called at exactly the four `runner.ts` verdict sites the story names;
  `reverifyId`/`completedAt`/`verdict` fields and the `.sandbox/reverify/<run-id>.jsonl` path all
  exact; `extensions.approval.reportId`/`supersededReportIds` registered (`strings`-kind,
  matching the DF6.1b note).
- **push.ts tightening:** the preflight refusal is exactly `decided < completed` with code
  `approval-precedes-report`; widening to `decided <= completed` matches AC7's strict chain and
  C7's ordering, refusal code and message unchanged. Coherent end to end across all three
  consumers (chain, gate, admission).
- **Trace WAL doctrine:** the header comment of `BOX_RUN_SOURCES` states the
  checkpoint-does-not-imply-checkpointed argument and the shm-omission rationale verbatim as the
  story summarizes; `trace/events.jsonl` is a member (C3's evidence); the checkout's own
  `trace.db` sits in `BOX_WORKDIR_SOURCES` (the collision the `trace/` prefix prevents);
  `openWriter` exists and `pipeline-run` points `dataDir` at the per-run run root's `trace/`
  directory.
- **Reaper:** `RowClass` union matches AC5's list exactly; `keyHashPrefix` is 12-hex as
  INV-AUDIT-2's divergence note says; `sweep`'s internal `TeardownDeps` construction is inside a
  Files-list row.
- **Record fields:** `extensions.budget` (`repoSlug`/`issueId` string-kind,
  `admittedCeilingMicroUsd` int), `extensions.approval` (`state`, `approverId`, `decidedAt`,
  `reportId`, `supersededReportIds`), `extensions.pr` (`prUrl`, `prNumber`, `createdAt`),
  `extensions.gate` ("written by the fleet dispatcher when the gate fails" — supporting C2's
  negation carve-out), `ExtensionValue = string | number | string[]`,
  `fixLoop.fixOutcome` string-kind, `resolveRunsDir()`, `requestId` — all exact.
- **Branch grammar:** `PUBLISH_REF_PREFIX = "refs/heads/qds/"` and `refs/heads/qds/${runId}` —
  hop 1's `qds/{runId}` join key exact.
- **Citations:** every p1-16 cite (hop count AC, non-null AC, broken-hop AC, 30 s AC, the 8-hop
  contract list, correlation-keys-at-creation guard, INV-1/2/3, integration DoD) and every
  p1-17 cite (four-value FAIL evidence, determinism, G4 non-mutating, 60 s / 5-min budgets,
  INV-1/2/3) verified at the cited anchors. Tier-2 ADR: "`/run` is tmpfs … a reboot wipes
  `/run`" and the two-layer "one trust domain" passage both present.
- **Env seams:** `QDS_COST_LEDGER_FILE` and `QDS_RUNS_DIR` exist; `DEFAULT_REVERIFY_DIR` has no
  env var (supporting the four-seam trigger-surface argument); `QDS_AUDIT_DB` is new in this
  story — no conflict.

---

## DF5.4 — findings

| ID | Class | Sev | Finding |
|---|---|---|---|
| W14B-7 | C4 | LOW | The Infra Prerequisites row calls DF3.7's `fleet observe <run-id>` "the delivered single-run verb" while the same sentence marks DF3.7/DF3.8 "`ready-for-dev` as of 2026-09-08" — and no `observe` verb exists anywhere in `scripts/fleet.ts` today (zero matches). Tense-confused wording; the dependency is honestly declared ("This story cannot demonstrate AC1 until DF3.7 has merged"), so impact is wording only. Confidence: high. |
| W14B-8 | C1 | LOW | "R5 §6 facts 15–18" — no R5 facts document located among the research files present (several `R5-*` research docs exist under workflow-state; none inspected matches a §6 facts list). The load-bearing fact (in-box evidence is a claim, F10) is independently verified in the tier-2 ADR, so nothing rests on the missing anchor. Confidence: medium. |

### DF5.4 — what HELD (verified at source)

- **Chassis anchors all exact:** `GateCheckOutcome`, `GateAssertion` (required `prd_clause`),
  the "Checks MUST NOT block the event loop (no `spawnSync`)" rule, `GateAssertionResult`
  (no `void_reason` key), `GateReport`, `GateReportSchema`, `RunGateOptions`, `runGate`, the
  VOID settlement block rendering `` detail: `VOID — ${a.void_reason}` ``, the skip-mapping
  region (`isSkip ? "skip" : pass/fail`), the all-void/empty-is-FAIL rule, the "A SKIP is NOT a
  pass" header, `verifier-child`'s `evidence` field, defaults 30 s / 600 s / concurrency 4 —
  every cite resolves. `parseValueFlags` exists in `scripts/lib/cli-args.ts` and is what
  `phase0-exit-gate.ts` uses. The "45 cases" count verified by running the suite: 45 tests, exit
  0.
- **Budget arithmetic:** 1 preflight + 10 live main clauses at concurrency 4 = 4 waves × 60 s =
  240 s inside the 300 s total, with V1 settled up front (never invoked) — consistent with the
  chassis's VOID-up-front behavior and `RunGateOptions`.
- **C9↔DF5.3 seam completeness:** the four path seams (`--runs-dir/--audit-db/--ledger/--reverify-dir`)
  match DF5.3's CLI surface exactly; the driver's flag list adds `--git-dir`/`--pr-body`, which
  DF5.3's walker deliberately lacks (hop 6 carries no git-dir seam — consistent both ways).
  C9's banned-status list (`broken`/`unlinked`/`hop-timeout`/`evidence-mismatch`/
  `evidence-not-harvested`) is exactly DF5.3's broken vocabulary, with `void` (hop 10) and
  `not-applicable` (hop 5's ordinary `reap` resolution) correctly outside it. `ChainReport`
  single-owner export reciprocity is stated identically in both stories. The C9 "fails even when
  the walker exits 0" test is coherent, not contradictory: it hardens the parsed-output
  assertion against a nonconforming walker, matching "the exit code alone is not the contract."
- **INV-GATE-1 write discipline:** internally consistent and mechanically sound — the walker's
  no-create probe + inode binding prevents materializing `audit.db`; the DELETE-journal choice
  makes the file-set snapshot exact (no `-wal`/`-shm` sidecars); the walker's temp-dir trace
  copy lives outside `.sandbox/` and `<runsDir>` so the snapshot needs no exception list; the
  absent-file pass, the swap pass and the remove pass are all testable as specced, and the
  swap/remove controls genuinely cannot fire against an opener that compares a held fd to
  itself (the post-open re-open compares a *fresh* stat of the path against the recorded probe
  inode).
- **Frozen-fixture mechanics:** checkpoint-before-copy (`PRAGMA wal_checkpoint(TRUNCATE)`) is the
  right move for a WAL-mode ledger; `audit.db` needs none on the DELETE journal — consistent
  with DF5.3's store spec; the bare `refs.git` + `--git-dir` seam and frozen `pr-body.txt` make
  C5 and C8 machine-independent; "git preserves only the executable bit" is a correct statement
  of checkout modes; `openReadOnly`'s purity (verified) makes the 0644-checkout claim true.
- **Clause-map evidence anchors:** `extensions.gate` is documented as failure-only (the C2
  negation carve-out, with `closedAt`/`commitSha` positive companions); `pausing`/
  `awaiting-approval` are real registered states, so "closedAt alone does not mean the run
  finished" is grounded; `trace/events.jsonl` is a `BOX_RUN_SOURCES` member and the tracer
  writes events to both `<dataDir>/events.jsonl` and the DB (the `worker_output` event type
  exists in `dispatch-task.ts`; stream-health exists); `gate_results.passed` is a nullable
  INTEGER, so C4's "literal 0 or 1, never NULL" is a meaningful positive assertion; C6/C7's
  bound-report selection matches `extensions.approval.reportId` and `supersededReportIds`
  exactly; C1's fields exist as registered; C10's two-meters rule matches `readRunCost` vs
  `captureSpend`'s `spendMicroUsd` and the registered `admittedCeilingMicroUsd`.
- **DF3.7/DF3.8 dependency honesty:** the "cannot demonstrate AC1 until DF3.7 has merged"
  caveat is explicit and repeated in the e2e DoD.

---

## Verdicts

**DF5.3 — NOT CONVERGED (close).** Zero BLOCKER, zero HIGH, zero C3. Residual: one C2-MEDIUM
(W14B-3, the reaper's `revokeAndVerify` path is forced to thread the new required field with no
runId to emit against — semantics unspecified) and one C2-LOW (W14B-2, under-enumerated
`createRun` callers in hop-table prose), plus C1-LOW/C4 residue. The threading enumeration —
the story's load-bearing completion criterion — verified exhaustive against my own grep, and
every line-anchor and zero-match claim I tested held. Confidence: **high** on the verdict; high
on W14B-1/2/4/5/6, medium-high on W14B-3.

**DF5.4 — CONVERGED.** Zero BLOCKER, zero HIGH, zero C2, zero C3. Residue is C1-LOW (W14B-8,
unlocatable R5 anchor) + C4 (W14B-7, "delivered" tense) — within the acceptable bar. All eleven
chassis anchors, the OQ-4 parity mechanism, the C9 seam threading, the write-discipline
mechanism and the fixture mechanics verified. Confidence: **high**. One caveat carried in
Method, not scored: the PHASE_0_GATE-current-verdict claim is sourced in a tracker I was
forbidden to read.

## Summary counts

- Findings total: 8 (shared findings: 0 — OQ-4 parity and the reciprocity paragraphs are
  consistent across both stories and counted nowhere).
- DF5.3: 6 — BLOCKER 0, HIGH 0, MEDIUM 1 (W14B-3), LOW 5 (W14B-1 C1, W14B-2 C2, W14B-4/5/6 C4).
- DF5.4: 2 — BLOCKER 0, HIGH 0, MEDIUM 0, LOW 2 (W14B-8 C1, W14B-7 C4).
- Convergence: DF5.4 CONVERGED; DF5.3 not converged solely on the C2 bar (one MEDIUM + one LOW).

## Ranked blocking items

1. **W14B-3 (DF5.3, C2-MEDIUM):** specify the reaper's `revokeAndVerify` seam — it must thread
   the required `CredentialDeps.recordAuditLink` but has no `runId` to emit against; one
   sentence ("sink on that path; `reap` remains the reaper's only emit") resolves it.
2. **W14B-2 (DF5.3, C2-LOW):** add `tests/fleet/e2e/tier1-provision-status.live.test.ts` to the
   hop-5 `createRun` caller enumeration (Files list already covers it).
3. **W14B-1 (DF5.3, C1-LOW):** move `patterns` from the `tests/providers/` group to
   `tests/fleet/` (or drop it — the file constructs nothing widened).
