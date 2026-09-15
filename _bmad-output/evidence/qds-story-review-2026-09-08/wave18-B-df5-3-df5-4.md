# Wave 18 — Verifier B — DF5.3 + DF5.4

**Scope:** `_bmad-output/sprint-artifacts/dark-factory-v5/stories/df5-3-audit-chain-extended.md`,
`_bmad-output/sprint-artifacts/dark-factory-v5/stories/df5-4-lights-on-gate.md`. Working tree as-is
(branch `dev`, plus the current uncommitted spec text). Clean eyes: no prior review material read.

## Method

Read both stories end to end. Opened at source every named symbol, constant, flag, event, fixture,
path and citation; traced call paths with repo-wide greps (no bare greps — every zero-match claim ran
with a positive control in the same batch, e.g. `recordAuditLink` greps run alongside `refs/sandbox`,
`worker_output`, `parseValueFlags` controls that all returned hits). No tests were run: this is a
Markdown spec review against source; every claim checked was statically checkable.

Cross-story reads, all for named seam claims (list per brief): `df2-11-teardown-lock-readonly-ledger.md`
(cited spans `:169-170`, `:270-282`, `:291-305` for `openReadOnly`'s no-create probe, negative
control and hot-WAL ceiling), `df3-7-approval-gate-bridge.md` (`fleet observe` verb,
`--await-completion` out-of-scope), `df5-2-host-side-pr-creation.md` (INV-PR-5), plus the
phase-1 sources both stories inherit citations from (`p1-16-audit-chain-pr.md`, `p1-17-phase1-exit-gate.md`)
and `docs/superpowers/specs/2026-08-31-tier2-placement-adr.md` (`:61-64`, `:81-82`). Forbidden
inputs untouched; one claim in DF5.4 is thereby **unverified, not failed**: "both `ready-for-dev` as
of 2026-09-08" (df3-7/df3-8 story files carry no in-file Status field; that status lives in the
sprint-status tracker, which is a forbidden input for this wave). The substantive parts of that
sentence — `fleet observe <run-id>` is a fully-specced delivered verb and `--await-completion` is
out-of-scope per DF3.7's own Trigger Surface — verified from the story text.

## Positive controls run (summary)

Every absence claim re-ran with same-machinery controls that hit: `recordAuditLink` / `audit_links` /
`walkAuditChain` / `OQ4_VOID_REASON` / `ChainReport` / `QDS_AUDIT_DB` / `qds-audit` /
`df5-lights-on-gate` / `capture-run-of-record` → zero code matches (one comment hit in
`src/providers/teardown.ts`'s header naming the future emit — net-new confirmed); positive controls
`refs/sandbox`, `worker_output`, `parseValueFlags`, `emitPause`, `gateEvent` all returned hits.
`package.json` declares no `bin` (grep exit 1 on the `"bin"` pattern; same grep machinery hits
`"scripts"`). `.sandbox/approvals` and `briefDigest` → zero (concept-absence claims; consistent with
the `extensions.approval` registration being the only approval store).

## Paired-verifier contract check (DF5.3 ↔ DF5.4)

- **Threading mandate vs owned blast radius — HELD.** Enumerated every construction/annotation site
  of the four widened `*Deps` interfaces plus the driver options across `src/`, `scripts/`, `tests/`:
  `CredentialDeps` literals at reaper.ts (the named no-op sink — verified: `revokeAndVerify`'s step
  context carries `runId: null` inside `credentials.ts`, so the record-less revoke path has no hop to
  serve, and `audit_links.run_id` NOT NULL makes a no-op the only honest choice) and in teardown.ts's
  spend/revoke step; `TeardownDeps` literals in reaper.ts (collapsed-run teardown), sandbox-teardown.ts,
  fanout-primitive.ts, scripts/fleet.ts's `const tdeps: TeardownDeps` (verbatim as described), plus
  cap-hit-demo.ts's three unannotated `teardownSandbox({...})` literals; `SweepDeps`' full assembly is
  the literal at sandbox-reap.ts's `sweep(...)` call (its `run()` takes `Partial<SweepDeps>`, so the
  test file does not break — exactly the story's shape); `HarvestDeps` instances all flow through
  `TeardownDeps` (structurally confirmed: teardown already passes its deps into `harvestRun` today);
  the driver side holds (`createRun` → `provisionAdmittedRun` internal composition → W12B-1's
  `CreateRunOptions` widening; dispatch's create/fill steps are the composition root that imports
  `recordAuditLink` directly). Every breaking site sits in a file already on Files to Modify, so the
  row's stated completion criterion (the typecheck) owns each break. One enumeration gap — see W18B-1.
- **Named composition surfaces exist at source — HELD.** `provisionAdmittedRun`, `teardownSandbox`,
  `runCredentialLifecycle`, `harvestRun`, `CredentialDeps`, `HarvestDeps`, `TeardownDeps`,
  `SweepDeps`, `CreateRunOptions`, the dispatch fill step, `scripts/fleet.ts`'s `tdeps` literal,
  sandbox-teardown's `TeardownDeps` construction, teardown.ts's internal harvest step: all present,
  several at the exact line spans the stories cite (driver `:549` / `:905` / `:935` / `:1066` /
  `:1076` / `:1086`; harvest `:213-217`, `:245`, `:639`, `:1068`; teardown `:116`, `:145`, `:507`,
  `:550`, `:582`, `:832`).
- **Four qds-audit path seams vs C9's threads — HELD.** DF5.3's CLI surface
  (`--runs-dir --audit-db --ledger --reverify-dir`) and DF5.4-C9's invocation and DoD's
  `parseValueFlags` list (which also adds `--git-dir`, `--pr-body`, `--report`, `--help`) name the
  same four store seams; `parseValueFlags` exists in `scripts/lib/cli-args.ts` and is what
  `phase0-exit-gate.ts` imports.
- **OQ-4 byte-identity — HELD.** The reason string is byte-identical in both stories, and both pin
  the same mechanism: one `export const OQ4_VOID_REASON` in `src/audit/index.ts`, imported by
  `scripts/df5-lights-on-gate.ts`; the chassis renders `detail: \`VOID — ${a.void_reason}\`` exactly
  as AC1 quotes, and `GateAssertionResult` / `GateReportSchema` indeed carry no `void_reason` key.
- **Hop ownership — HELD.** Mirrored reciprocity paragraphs agree on both sides: DF5.3 owns the
  ten-hop table and the three emitted link families (hops 4/5/6); C9 asserts row ids for exactly
  those three; neither story adds a hop or clause unilaterally; C1/C3's hop-less stages are stated
  identically as by-design.
- **audit.db DELETE-journal vs the file-set assertion — HELD.** Both stories state the same
  mechanism (no `-wal`/`-shm`, exact snapshot, no sidecar exception list) and the absent-`audit.db`
  and identity-window passes in DF5.4's DoD correspond one-to-one to DF5.3's no-create
  `openSync(path, "r")` probe and post-open inode re-bind — which is mechanically grounded: the
  `CostLedger` constructor really does `mkdirSync` 0700 / `chmodSync` / `PRAGMA journal_mode = WAL` /
  `db.exec(SCHEMA)`, and `openReadOnly` really does open the preopened handle first and advertise "no
  mkdir, chmod, mode assert, schema or persistent pragma effect".
- **Frozen-fixture mechanics — HELD.** Capture tool + `PRAGMA wal_checkpoint(TRUNCATE)` before
  copying + non-empty-`-wal` refusal matches the shipped `openReadOnly` hot-WAL refusal
  (`ledger-wal-recovery-required` exists at source); the bare `refs.git` fixture is justified —
  `refs/sandbox/<run-id>` is a 40-hex ref created by harvest's
  `git fetch --force <bundle> refs/heads/<branch>:refs/sandbox/<runId>` and is meaningless without
  its object store; the `mkdtempSync` scratch copy, the twice-run tamper walk against one scratch
  copy, and the three-pass snapshot (present / absent / swapped) are all internally consistent.
- **Caller-enumeration prose vs my own caller grep — HELD, exactly.** `harvestRun` has exactly three
  call sites (scripts/fleet.ts `:5018` fed by the `tdeps` literal, sandbox-teardown.ts `:244`,
  teardown.ts `:832`). `setupRun` has zero production callers (only
  `tests/providers/driver-contract.test.ts`); `observeRun` has exactly one test call (same file);
  `createRun`'s callers are all inside files the blast-radius row names (cap-hit-demo, quota,
  driver-contract, approval-gate.test, tier1-provision-status.live, plus teardown/fake-driver/
  budget-gate/credentials/df2-11-teardown-race tests — all on the row). approval-gate's "inline
  `TeardownDeps` literal" is the test file's minimal `teardownSandbox({ driver, store: s.store }, …)`
  literal — production approval-gate.ts constructs none (the seam is wired by the fleet verb), which
  is what the row asserts.
- **Strict-ordering tightening — HELD.** `src/pr/push.ts`'s preflight really refuses only on
  `decided < completed` (equality passes), the refusal code is `approval-precedes-report`, and
  AC7's owned one-comparison widening to `decided <= completed` is a precise, minimal, single-line
  change in a file the story owns with a stated precedent. DF5.2's INV-PR-5 confirms no PR opens
  without a satisfied approval, so AC5's "hop 8 never not-applicable for a PR-bearing run" is sound.

## Findings

| ID | Story | Class | Severity | Finding |
|----|-------|-------|----------|---------|
| W18B-1 | DF5.3 | C4 | LOW | The blast-radius row's parenthetical enumerations are not exhaustive of the production constructions its own widening will break. Unnamed but breaking literals: reaper.ts's collapsed-run `teardownDeps: TeardownDeps` literal; teardown.ts's spend/revoke `const cred: CredentialDeps` literal; cap-hit-demo.ts's three `teardownSandbox({...})` literals and its `mintRunKey`/`captureSpend` deps literals. No unowned breakage — every one sits in a file already on Files to Modify, and the row declares the typecheck the completion criterion — but the row's framing ("the threading's blast radius, owned here"; the reaper's literal called "the one named no-op sink") reads as exhaustive. One small decision is left unspecified: whether cap-hit-demo's credential/teardown literals thread the real emitter (the demo mints real keys on a real run, so emitting is the semantically natural reading and keeps "one named no-op sink" true) or a second no-op. One clause in the row would settle it. |
| W18B-2 | DF5.3 | C4 | LOW | Trigger Surface parenthetical: "`src/reverify/runner.ts` resolves it from `hostRoot`/cwd only". The runner also honors an explicit `deps.reverifyDir` override in its deps interface. The load-bearing claim — no *environment* seam to inherit, hence the walker's own `--reverify-dir` flag — is verified true; the "only" is over-broad wording. |
| W18B-3 | DF5.4 | C1 | LOW | `df2-11:169-170` miscitation. That span is the `ledger-readonly` write-guard sentence ("Any write method reached on a read-only handle … throws … and the row count is unchanged"), not a negative control. The support for the claim it is cited for (the read path runs no `mkdirSync`/`chmodSync`/mode assertion/pragma/schema exec, and a negative control fails an implementation that keeps them) lives in the `:270-282` span — which the same story cites correctly elsewhere. Claim substance verified true; only the span is wrong. |

No shared findings: W18B-1 and W18B-2 are DF5.3-only; W18B-3 is DF5.4-only.

## What HELD (beyond the contract check)

- **Chassis citations are exact, every one.** `GateCheckOutcome`, `GateAssertion` (+ required
  `prd_clause`), the "Checks MUST NOT block the event loop (no `spawnSync`)" note, `void_reason`
  docblock, `GateAssertionResult` (`:77-86`, no `void_reason` key), `GateReport` (`:88`),
  `GateReportSchema` (`:117-128`), `RunGateOptions` (`:130`) with chassis defaults exactly 30 s / 600 s
  and `DEFAULT_CONCURRENCY = 4`, the VOID settle-upfront block rendering `VOID — ${a.void_reason}`,
  the skip-mapping `pass: !isSkip && outcome.pass`, the all-void/empty-is-FAIL rule, the header's
  SKIP/VOID doctrine, and AC5's fail-fast detail string — the chassis literally contains
  `"not attempted — preflight assertion(s) did not pass (fail-fast)"`, so DF5.4 needs no chassis edit
  to deliver AC5.
- **Driver template mirror is real.** `phase0-exit-gate.ts` has an exported `buildAssertions()`, calls
  `runGate(buildAssertions())`, writes the report, exits 0/1 and `process.exit(2)` on fatal; its test
  file has exactly 45 cases, as DF5.4 states twice. `p0-3-mixed-model.ts` exports the pure-auditor +
  factory shape the assertion modules are told to follow (`auditMixedModelRun` /
  `mixedModelAssertions`).
- **Ledger claims are exact.** `DEFAULT_COST_LEDGER_FILE`, `QDS_COST_LEDGER_FILE`, `openReadOnly` as a
  static factory, `ledger-absent` (no-create probe), `ledger-identity-changed` (held-fd inode),
  `ledger-wal-recovery-required` (hot-WAL), `readRunCost`/`readIssueCost` as methods,
  `CostView`'s `totalMicroUsd`/`perRole`/`hasEvents`/`hasTokenRows`, `ingestCostEvent` as the only
  writer of `kind='tokens'` rows, and the source's own comment naming "DF5.3 audit hop 3 / DF5.4 C10"
  as the run-keyed view's consumers.
- **Trace/reverify claims are exact.** `sessions` PK'd on `request_id` (`:34-35`),
  `gate_results.request_id` (`:84-93`), the `ALTER TABLE` additions `sessions.repo_slug`/`issue_id`
  (both nullable, with the DF1.8 NULL-correlation comment) in migrations, `BOX_RUN_SOURCES` shipping
  `trace.db` + `-wal` and deliberately no `-shm` with the collision comment explaining the `trace/`
  prefix, the guarded best-effort checkpoint, `pullArtifacts` landing `<runsDir>/<runId>-artifacts`,
  `appendReport` at report.ts `:317` with `<runId>.jsonl`, the module header's "last line
  authoritative for DF5.2", and the four `appendReport` call sites in runner.ts at exactly
  `:290/:418/:469/:481`.
- **The stale-docblock claim is verified verbatim.** `src/providers/run-record.ts`'s
  `extensions.approval` registration really closes with "`dispatchRequestId` is the cross-process
  join, and DF5.3 joins on it", and the contract's correction (it is a LOG key on
  approval-gate/fleet pause lines only; no store column; stores join on `request_id`) matches the
  schema and the emitters at source.
- **Inherited citations check out.** All eight `p1-16` line cites and all five `p1-17` line cites
  land on the claimed content (30 s budget, emit-at-creation, named broken hop, repo scoping, no
  tokens, aggregated cost, per-clause FAIL fields, determinism, G4 non-mutating, 5-min/60-s budgets,
  INV-1..3); the tier-2 ADR's `:61-64` two-layer doctrine and `:81-82` tmpfs measurement are
  verbatim; DF5.2's INV-PR-5 says what DF5.3 needs it to say; DF3.7's Trigger Surface carries the
  `--await-completion` out-of-scope row verbatim.
- **PR-body claims are exact.** `src/pr/body.ts` renders `Run: ${runId}` and
  `Issue: ${input.issueRef}` with "Rendered issue reference, or `unresolved`. ALWAYS a line — never
  omitted", so C8's shape assertion and its two mutant tests are grounded, and DF5.3 hop 1's
  "runId in PR body" is real. `refs/heads/qds/${runId}` (hop 1's branch join) is `push.ts`'s
  `PUBLISH_REF_PREFIX`.
- **Semantics hold under reading.** AC5's `not-applicable` for `reap` matches the reaper's header and
  the full seven-member `RowClass` union; AC6's reachable/unreachable split matches `runBoxStep`'s
  own comment ("Every OTHER harvest failure still aborts before revoke/destroy") and
  `runArtifactsStep`'s non-fatal arm; the teardown-order claims (`closedAt` before promote;
  `pausing`/`awaiting-approval` are closed records) match approval-gate.ts's header and
  `closedAt` guard; `extensions.gate` is written only on the gate-failure branch, so C2's negated
  field with two positive companions is the correct carve-out; `mintRunKey` carries
  `capMicroUsd` as an argument (no `cap` event) and the 8-char prefix vs the reaper's 12-hex
  `keyHashPrefix` divergence is as described.
- **Worker-output claim is exact.** `team-event-adapter.ts` maps `worker_output` → generic envelope
  and `merged` → an in-process terminal marker; `dispatch-task.ts` traces the `envelope` branch and
  carries the stream-health counters — so C3's "the merged branch is consumed in-process and traced
  by stream-health only" is the shipped behavior.
- **New-surface absences are real.** No `src/audit/`, `tests/audit/`, `scripts/qds-audit.ts`,
  `scripts/df5-lights-on-gate.ts`, `tests/gate/fixtures/`, `scripts/dev/capture-run-of-record.ts`;
  no `QDS_AUDIT_DB`; no `bin` in `package.json`. The two new DF5.4 test filenames collide with
  nothing in `tests/gate/`.

## Verdicts

| Story | Verdict | Confidence |
|-------|---------|------------|
| DF5.3 audit-chain-extended | **CONVERGED** — zero BLOCKER, zero HIGH, zero C2, zero C3; residue W18B-1 (C4-LOW), W18B-2 (C4-LOW) | High (~0.9) |
| DF5.4 lights-on-gate | **CONVERGED** — zero BLOCKER, zero HIGH, zero C2, zero C3; residue W18B-3 (C1-LOW) | High (~0.9) |

Residual risk, stated: the "ready-for-dev as of 2026-09-08" status claim on DF3.7/DF3.8 is
unverifiable inside this wave's input restrictions (see Method); it is process metadata, and the
substantive dependency (the specced `fleet observe` verb) verified. W18B-1 leaves one small
emitter-vs-no-op decision for cap-hit-demo's threading that the spec does not name; the typecheck
will surface every site, so the cost of deciding late is one compile pass, not a design error.

## Summary counts

- Findings: 3 total — 0 BLOCKER, 0 HIGH, 0 MEDIUM, 3 LOW (2×C4, 1×C1).
- DF5.3: 2 LOW (C4 ×2). DF5.4: 1 LOW (C1 ×1). Shared: none.
- Both stories **CONVERGED**; C1-LOW and C4 residue only, within the acceptance bar.
