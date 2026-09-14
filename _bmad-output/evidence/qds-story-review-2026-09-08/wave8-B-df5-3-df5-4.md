# Wave 8 — Round-3 Convergence Verification, Pair B: DF5.3 + DF5.4

Branch `feature/wave7-seam-ownership-rework`; story files read from the uncommitted working tree.
Method: every named symbol, path, flag, constant, exit code and table column opened at source in this
repo; every zero-hit grep carries a positive control; all arithmetic re-derived. No prior wave,
scan, verify or tracker file was read. Read-only — no file outside this report was touched.

Scope: `_bmad-output/sprint-artifacts/dark-factory-v5/stories/df5-3-audit-chain-extended.md`,
`_bmad-output/sprint-artifacts/dark-factory-v5/stories/df5-4-lights-on-gate.md`.

---

## Verified CORRECT (at source)

**Chassis citations (DF5.4, exhaustively checked — every one exact).** `GateAssertion`
(`gate-runner.ts`), `GateCheckOutcome`, `runGate`, `RunGateOptions`, `GateReport`,
`GateReportSchema`, `GateAssertionResult`, `prd_clause` (required field), the non-blocking /
no-`spawnSync` rule, the VOID block rendering `detail: \`VOID — ${a.void_reason}\`` at `:174`,
skip-is-not-a-pass, the no-live-assertions-is-FAIL rule (`live.length > 0 && live.every(pass)`),
and the preflight fail-fast detail string `"not attempted — preflight assertion(s) did not pass
(fail-fast)"` — all present, all at the cited lines. `GateAssertionResult` and
`GateReportSchema` carry **no** `void_reason` key (the story's claim that it must not add one
holds). `src/gate/verifier-child.ts:33` is the `evidence` field. Chassis defaults are
`DEFAULT_ASSERTION_TIMEOUT_MS = 30_000` / `DEFAULT_TOTAL_TIMEOUT_MS = 600_000` /
`DEFAULT_CONCURRENCY = 4` exactly as the budget paragraph states.
`tests/gate/phase0-exit-gate.test.ts` contains exactly **45** `test(` invocations (positive
control: the same grep finds 45, and `bun`'s runner would count the same set).
`scripts/phase0-exit-gate.ts` imports `parseValueFlags` from `scripts/lib/cli-args.ts` and uses
it for `--report`; `src/gate/assertions/lib/verdict.ts` and `src/gate/assertions/p0-3-mixed-model.ts`
(the module-shape precedent) exist.

**DF5.4 budget arithmetic re-derived.** Clause count: preflight P1 + C1…C10 = **11 live** + V1
void — matches "eleven live clauses". Waves: preflight barrier = 1, main ceil(10 / concurrency 4)
= 3 → 4 × 60 s = **240 s**, 60 s inside the 300 s total. C9's ≤30 s walk fits a 60 s slot.
DF5.3's 3 s × 10 hops = 30 s also holds.

**P0/P1 surviving-clause citations.** `p1-16-audit-chain-pr.md` `:29, :30, :31, :32, :36, :39,
:51-53, :63` and `p1-17-phase1-exit-gate.md` `:30, :31, :35, :38, :48-50` — every cited line says
what the stories claim (8-hop walker, non-null/stable-ID, named broken hop, 30 s, correlation
keys at creation not retroactively, INV-1/2/3, determinism, G4 recorded-evidence pattern, 60 s /
5 min budgets). `push.ts`'s enforcement on the approval boundary is verified **non-strict**
(`decided < completed` refuses; equality passes — `src/pr/push.ts`), which is exactly the
strengthening DF5.3 AC7 records.

**Emitter sites.** `provisionAdmittedRun` (`src/providers/driver.ts:549`), `createRun` (`:905`),
`fillRun` (`:935`), `setupRun` (`:1066`), `executeRun` (`:1076`), `observeRun` (`:1086`) — all
exact. Dispatch calls `provisionAdmittedRun` directly (its own `within("create", …)` thunk) and
`fillRun` at its own step, and runs the setup gate between them, writing `extensions.gate` only
on the `!gate.ready` failure branch — verifying DF5.4-C2's "absence is the only trace a green
gate leaves" and DF3.1's registry comment. `createRun` is production-called only by
`scripts/cap-hit-demo.ts`. Credential emitters `mintRunKey` / `deliverRunKey` / `revokeRunKey` /
`verifyRevoked` / `captureSpend` / `runCredentialLifecycle` all exist in `credentials.ts`, with
the cap validated at mint and `limitMicroUsd` persisted on the record.
`harvestRun` production callers today are exactly `scripts/fleet.ts` and
`scripts/sandbox-teardown.ts` (plus teardown's internal call), matching the Scope note's
counting. `teardownSandbox`'s `noHarvest` option is real and live-called from the approval-gate
pause path (`src/fleet/approval-gate.ts` → `teardown(runId, { noHarvest: true })`).
`runBoxStep`'s contract — every harvest failure except artifacts aborts before revoke/destroy;
artifacts failure is loud-but-non-fatal — verified, which is what makes DF5.3 AC6's
`evidence-not-harvested` case reachable on a walkable PR. `reaper.ts`'s module header says the
sweep reaps "what nobody owns" and `RowClass` is exactly the seven-value union DF5.3 lists.

**Cost ledger and DF2.11's read-only seam.** `readRunCost`/`readIssueCost` are **methods on
`class CostLedger`**; `hasEvents`/`hasTokenRows` are on the `CostView` return; the box-hours
bucket key is the literal `'box-hours'`; the issue-scoped path is separate. `DEFAULT_COST_LEDGER_FILE
= ".sandbox/cost-ledger.db"` with `QDS_COST_LEDGER_FILE` override. The ordinary constructor
performs `mkdirSync` 0700, `chmodSync`, file chmod 0600, `PRAGMA journal_mode = WAL`,
`PRAGMA synchronous`, `busy_timeout`, and `db.exec(SCHEMA)` — exactly the side-effect list both
stories describe. `CostLedger.openReadOnly` is a **static factory on the same class** with the
no-create probe ("O_CREAT is never set") and the three typed refusals `ledger-absent`,
`ledger-identity-changed`, `ledger-wal-recovery-required` — all present.

**Run record.** `requestId`, `commitSha`, `spendMicroUsd`, `limitMicroUsd`, `closedAt` core
fields; `extensions.budget` registered with `repoSlug`/`issueId`/`admittedCeilingMicroUsd` (+
cap/spent/reserved), written by dispatch with the admission decision; `extensions.approval`
registered with `state`, `reportId`, `approverId`, `decidedAt`, `supersededReportIds`, schema
version 2, with the states comment confirming `pausing`/`awaiting-approval` are closed records
(DF5.4-C2's carve-out verified); `extensions.pr` = `{prUrl, prNumber, createdAt}` written by
`src/pr/open-pr.ts` with the host clock taken immediately before `POST /pulls`;
`ExtensionValue = string | number | string[]` and `fixLoop.fixOutcome` a `"string"`-kind field
(DF6.1b's additive path is as described). `resolveRunsDir` exists.

**Trace substrate.** `sessions` PK'd on `request_id`; `gate_results.request_id TEXT NOT NULL`
with a **nullable** `passed INTEGER` (so C4's never-NULL positive assertion is meaningful); no
`run_id` column anywhere in the trace schema (positive control: `request_id` hits). The join
columns come from `src/phase-engine/trace/migrations.ts` exactly as DF5.3 says —
`["sessions","repo_slug","TEXT"]`, `["sessions","issue_id","INTEGER"]`, both nullable, beside
the DF1.8 bare-run/NULL comment — and the INTEGER-vs-registered-`"string"` coercion rule is
sound. `recordGateResult` writes `passed ? 1 : 0` — literal 0/1 on every healthy write, so C4
is evaluable. The tracer opens `<dataDir>/trace.db` with WAL; the ADR's `/run`-is-tmpfs
measurement and Consequence 2 (engine in-box) are exactly where DF5.3 cites them.
`harvest.ts` ships `trace/trace.db` **and** `trace/trace.db-wal`, deliberately omitting
`-shm`, with the prefix-collision rationale against the checkout's own `trace.db` in
`BOX_WORKDIR_SOURCES`, and the bounded best-effort `wal_checkpoint(TRUNCATE)` `|| true` in the
in-box script — all as the hot-WAL/temp-dir-copy technical note states. `pullArtifacts` lands
`<runsDir>/<runId>-artifacts`.

**DF5.2 contract (hop 1 / C8 inputs).** Branch `qds/<run-id>`, `Run: <run-id>` in the body, an
`Issue:` line that is **always rendered** (unresolved mapping renders `Issue: unresolved`), a
cost summary line, and INV-PR-5 (no push/PR without a green bound report and an `approved`
approval) — all present in the DF5.2 story and its DoD. `.sandbox/approvals/` appears in no
source file (positive control: `.sandbox/reverify` hits `src/reverify/report.ts:310`).

**Re-verify substrate.** `appendReport` at `src/reverify/report.ts:317`, called at exactly
`runner.ts` `:290, :418, :469, :481`; module header: "the last line authoritative **for
DF5.2**" — so the bound-report selection deviation is real and correctly stated;
`readReports` returns an array; `DEFAULT_REVERIFY_DIR = ".sandbox/reverify"`,
filename `<runId>.jsonl`. `src/reverify/runner.ts` resolves the dir as
`deps.reverifyDir ?? join(hostRoot, cwd)` with no environment variable — supporting (not
undermining) DF5.3's need for a `--reverify-dir` seam.

**Design/decision citations.** Design §6 item 4 (central append-only audit log, gate-evidence
trace, per-run cost ledger, PR bodies carrying run correlation ids), §6 item 6 (F10 output
integrity), §5.3, §8 step 5 ("Lights-on PR: channel → fleet → team → gates → bundle → host-side
re-verify"), decision register D8/D7/D3, derivation file DD-4 + §4 row 3 ("DF5.3's audit chain
records the Hindsight retain-receipt link VOID pending step 6"), DD-7 (SwarmClaw HTTP home),
DD-8, DD-9 (µ$ unit) — all present with the claimed content. `package.json` declares no `bin`
(positive control: `"name"` found). `src/providers/viz-guard.ts` exists (the DF4.2 direction
precedent). `src/audit/`, `scripts/qds-audit.ts`, `scripts/df5-lights-on-gate.ts`,
`tests/audit/`, `tests/gate/fixtures/df5-run-of-record/`, `scripts/dev/capture-run-of-record.ts`
do not exist — consistent with both stories being the stories that create them.

**Emitter↔asserter contract between the pair.** Single ownership verified and mutually
consistent: DF5.3 exports `ChainReport` **and** `OQ4_VOID_REASON` from `src/audit/index.ts`;
DF5.4-C9 imports the type ("imported, never re-declared") and both stories state the
"neither changes the shape without the other's row" rule in identical words. The OQ-4 VOID
reason string is quoted identically in both and made byte-identical by construction (one export,
one import; DF5.4's DoD asserts equality against the imported constant). C9 is the only clause
reading `audit_links`, and it asserts more than an exit code: ≥1 contributing-runId key,
exactly ten hops per key, zero `broken`/`unlinked`/`hop-timeout`/`evidence-mismatch`/
`evidence-not-harvested`, hop 10 `void`, and **emitted link-row ids present on hops 4/5/6** —
which DF5.3's DoD puts in the `--json` payload ("for hops 4/5/6, the emitted `audit_links` row
ids"). The four path seams DF5.4 threads (`--runs-dir/--audit-db/--ledger/--reverify-dir`) are
exactly the four flags DF5.3's CLI declares; `--git-dir` and `--pr-body` are DF5.4-local C5/C8
seams and are declared as such. The INV-GATE-1 write exception (first-observation digest rows
into `audit_links`) is named by both stories in matching terms, and the DELETE-journal /
no-sidecar decision that makes DF5.4's file-set snapshot exact is stated identically in both.
DF5.3's negative claim "no store the walker opens has a `dispatch_request_id` column" is
verified: the identifier exists only as a log key in `approval-gate.ts` and `scripts/fleet.ts`
(positive control: `cost_events.request_id` found; `dispatch_request_id` zero hits in `src/`).

---

## Findings

### W8-B-1 — MEDIUM — C3-structural — **both stories** (DF5.3 AC5 + Technical Notes hop-3 row + DoD unit test; DF5.4 clause C10)

**Anchor:** the "declared, not wired (F001, issue #157)" premise, cited to `cost-ledger.ts:941-949`.

**Failure scenario:** DF2.12 has **merged and wired** the token bridge on this branch. The
ledger's own docblock for `ingestCostEvent` now reads "the ONLY writer of `kind='tokens'` rows,
and **since DF2.12 a wired one** … at teardown's two ingest points", and both
`teardownSandbox` ingest points call `ingestHarvestedTokensIfWired` immediately before the
box-hours ingest (`cost-ledger-bridge.ts` → `ingestCostEvent`). Consequently, on the run of
record DF5.4 will freeze, `perRole` carries real role buckets (`cost_events.role` CHECK:
lead/worker/resident/tier1) and `hasTokenRows` is `true` — the exact state DF5.3 describes as
"when it lands". Three clauses now assert a dead state as current fact:

- DF5.3 AC5's healthy-run shape ("the DF2.7→ledger bridge is **declared, not wired** … so hop 3's
  `perRole` holds the single literal `"box-hours"` key and `hasTokenRows` is `false`");
- DF5.3's DoD unit test ("`{"box-hours": N}` with `hasTokenRows: false` until the F001/#157
  bridge is wired") — the justification is now inverted, so a reviewer cannot tell whether the
  fixture is meant to be production-shaped;
- DF5.4-C10's gloss ("a non-zero µ$ total — the run's **box-hours** spend, which is all the
  ledger holds until the F001/#157 bridge lands"): post-DF2.12, `readRunCost`'s
  `totalMicroUsd` sums **tokens + box_hours**, so the µ$ total C10 asserts is no longer "the
  box-hours spend".

The operative contracts survive — DF5.3's hop explicitly "reports `perRole` verbatim … never
asserts a multi-role split", and C10's assertions (`hasEvents: true`, non-zero total,
`spendMicroUsd` ≤ ceiling) remain evaluable — but the premise text and the fixture/test
justification describe a state no healthy run on this branch produces. Secondary: the same
sentence predicts "DF2.12 … closes #157", and issue #157 is still **OPEN** (deferred
money-loop residuals), so the closure prediction is also unmet.

**Evidence:** `src/providers/cost-ledger.ts` `ingestCostEvent` docblock ("since DF2.12 a wired
one"); `src/providers/teardown.ts` — `ingestHarvestedTokensIfWired` at both ingest points;
`src/providers/cost-ledger-bridge.ts`; `git log --grep df2.12` (feat + done commits);
`gh issue view 157` → OPEN. Positive control for the staleness: grep `F001` hits only
`docs/superpowers/plans/2026-08-28-tech-debt-remediation.md` and this story — no
"declared, not wired" marker exists anywhere in `src/`, and the ledger header now says
"**Both kinds** … reach this ledger".

### W8-B-2 — MEDIUM — C1-citation — **DF5.4** clause C3 ("team")

**Anchor:** "the **harvested** merged envelope under `<runsDir>/<runId>-artifacts/`".

**Failure scenario:** no harvested artefact matches that description. The artifacts manifest
(`BOX_RUN_SOURCES` = `journal/final.json`, `trace/trace.db`, `trace/trace.db-wal`,
`trace/events.jsonl`; `BOX_WORKDIR_SOURCES` = specs, app_docs, ssmf.db, `trace.db`, `run.log`)
contains no envelope or merged source. The only harvested NDJSON is the tracer's
`trace/events.jsonl`, whose rows are prompt / coms / cost / coms_init_error / **worker_output**
/ test_result / log — DF1.6's `merged` marker is consumed by `dispatch-task` with **no**
`tracer?.trace` call (the `case "merged":` branch only records `mergedResult` and continues for
stream-health counting), so the merged step output itself lands in no harvested file, and the
raw team NDJSON stream is not a harvest source. C3's *operation* (present, parses, ≥1
well-formed line, zero malformed) is evaluable against `trace/events.jsonl`, but the clause
names its evidence by a description nothing harvested carries and, unlike C4, names no path. An
implementer searching the manifest for the envelope source finds nothing, and the two visible
remedies are both bad: invent a source (mutating `BOX_RUN_SOURCES` — a DF2.5-owned file outside
DF5.4's declared Files to Modify) or leave C3 permanently `skip` (red, but vacuous).

**Evidence:** `src/providers/harvest.ts` `BOX_RUN_SOURCES` / `BOX_WORKDIR_SOURCES`;
`src/phase-engine/phases/dispatch-task.ts` `case "merged"` branch (no trace write) vs
`case "envelope"` (traced as `worker_output`); `src/phase-engine/trace/tracer.ts`
(`events.jsonl` = raw trace record). Positive control: grep `envelope` in `harvest.ts` → only
code identifiers, no file name.

### W8-B-3 — MEDIUM — C1-citation — **DF5.3** (Infra Prerequisites, Trigger Surface, Technical Notes hop 3/5) and **DF5.4** (Infra Prerequisites, C10 note)

**Anchor:** the `cost-ledger.ts:<line>` citation family, plus drifted dispatch/reaper/teardown/
approval-gate/fleet cites.

**Failure scenario:** the cost-ledger citations are systematically wrong and several point at
unrelated content: `:941-949` is the F042 reservation docblock, not a bridge note (see W8-B-1);
`:1335` is the WAL-attach region, while `readRunCost` sits at `:1893`; `:722-723` and `:729-730`
are the per-issue-cap docblock, while `hasEvents`/`hasTokenRows` are computed at `:1973-1974`;
`:448` → `DEFAULT_COST_LEDGER_FILE` is at `:514`; `:875` → the override resolution is at
`:1053`; `:885-921` → the constructor begins at `:1050`. Every *symbol* exists and every
*semantic* claim about it is verified correct (see Verified CORRECT), so no implementer is
misled about behaviour — but a verifier or implementer spot-checking the story against source
finds unrelated text at six of seven cited regions. The same drift hits other files:
`reaper.ts:391` (`sweep` is at `:441`), `teardown.ts:463` (`teardownSandbox` at `:507`),
`teardown.ts:488-494` (`ingestBoxHoursIfAttributed` at `:550`), `dispatch.ts:2683 / :2986 /
:3023` (actual `:2797 / :3100 / ~:3148`), `approval-gate.ts:1209,1225` (actual `~:1332-1380`),
`scripts/fleet.ts:1805,1911` (actual `~:1982-2088` / `:3140`), `credentials.ts:286` (the
`createKey` call is at `:333`). DF5.4 inherits four of the cost-ledger cites (`:448`,
`:885-921`, `:1335`, `:941-949`). Contrast proving this is rot, not sloppiness: the
`gate-runner.ts`, `reverify/report.ts`+`runner.ts`, `p1-16`/`p1-17`, `harvest.ts`,
`trace/schema.ts`, `trace/migrations.ts` and tier-2-ADR citations are exact to the line.

**Evidence:** the diffs above; positive control on the same files —
`grep -n "DEFAULT_COST_LEDGER_FILE" src/providers/cost-ledger.ts` → `:514`,
`grep -n "readRunCost" src/providers/cost-ledger.ts` → `:1893`,
`grep -n "export async function sweep" src/providers/reaper.ts` → `:441`.

### W8-B-4 — LOW — C1-citation — **DF5.3** Technical Notes hop 5

**Anchor:** "`setupRun` … which has zero callers repo-wide" and "`executeRun`/`observeRun` …
demo-only and zero-caller respectively".

**Failure scenario:** both "zero callers" claims are false as stated: `setupRun` is called twice
in `tests/providers/driver-contract.test.ts` and `observeRun` once in the same file. The
**conclusion drawn is unaffected** — both are test-only, neither is on a production path, and
the rule drawn from them (no emit at these sites; `execute`/`observe` are in-box post-DF1.10)
is correct. But the story uses a checkable zero-count as load-bearing justification, and a
reviewer who runs the grep finds hits and must re-derive the argument. "Zero production
callers" is what is true.

**Evidence:** `tests/providers/driver-contract.test.ts` `setupRun(...)` ×2, `observeRun(...)`
×1; positive control: the same grep finds `provisionAdmittedRun`/`fillRun` production callers in
`src/fleet/dispatch.ts`.

### W8-B-5 — LOW — C3-structural — **DF5.3** Overview Scope note vs DoD Integration

**Anchor:** "plus one seam field per deps interface — `recordAuditLink?:` on `CredentialDeps`,
`HarvestDeps`, `TeardownDeps` and `SweepDeps`" + "The `driver.ts` threading … only
`provisionAdmittedRun` and `fillRun` are live sites".

**Failure scenario:** the seam enumeration has no home for the driver emits it then requires.
`provisionAdmittedRun` takes a named options type (`driver.ts` "provisionAdmittedRun's inputs"),
and **`fillRun(driver, vm, files)` takes no deps/options bag at all** — threading a required
(non-optional) `recordAuditLink` into it means changing `fillRun`'s signature, rippling to its
production callers (`src/fleet/dispatch.ts` fill step, `scripts/cap-hit-demo.ts`) and the
`tests/providers/` fakes the story says it threads. The four-interface list also sits beside the
claim "No logic or control flow in those files changes and no existing field is touched", which
scoped to the four DF2.x files is fine, but nothing in the story says which type carries the
driver-side seam — and a module-level import inside `driver.ts` would violate the very rule the
story states ("`src/providers/*` takes no ambient dependencies"). `driver.ts` is in Files to
Modify, so nothing is *forbidden* — this is an under-specified seam, not a scope conflict.

**Evidence:** `src/providers/driver.ts` signatures for `provisionAdmittedRun` and `fillRun`;
the four `*Deps` interfaces exist exactly where the story says (`credentials.ts:177`,
`harvest.ts:372`, `teardown.ts:116`, `reaper.ts:153`) — positive control that the enumeration is
complete for everything *except* the driver emits.

### W8-B-6 — LOW — C3-structural — **DF5.3** Observability Contract (`dispatchRequestId` paragraph)

**Anchor:** "`dispatchRequestId` is a LOG key, not a column, and the walker never uses it",
cited to the `extensions.approval` registration docblock in `src/providers/run-record.ts`.

**Failure scenario:** the cited region's own final sentence states the opposite contract:
"`dispatchRequestId` is the cross-process join, and **DF5.3 joins on it**." The story is right
and the comment is stale (verified: no `dispatch_request_id` column exists anywhere in `src/` —
positive control: `cost_events.request_id` at `cost-ledger.ts:359`; the identifier appears only
on approval-gate / fleet log lines). But the story cites the region approvingly, does not flag
the contradiction, and `src/providers/run-record.ts` is not in DF5.3's Files to Modify — so the
in-tree sentence that names DF5.3 and prescribes the wrong join survives this story. An
implementer who trusts the comment over the story resolves zero rows at hops 8/9.

**Evidence:** `src/providers/run-record.ts` approval docblock closing sentence; zero-hit grep
for `dispatch_request_id` in `src/` with the `request_id` positive control.

### W8-B-7 — C4-marginal — **DF5.4** Overview ("Reconstructable is defined once, for both halves")

**Anchor:** the duplicated definition paragraph.

**Failure scenario:** DF5.4's copy omits the runId carve-out DF5.3's carries ("invoked with a
runId — the form DF5.4-C9 uses against the frozen fixture — hop 1 resolves locally … the walk
performs no network access at all"), so the paragraph that claims to be "defined once" differs
between the pair. The binding text is not misled: C9's own row says "invoked **by runId** … the
walk performs **no network access at all**", and DF5.3's hop-1 row agrees. Wording only.

### W8-B-8 — C4-marginal — **DF5.3** Technical Notes hop 5

**Anchor:** "each run's trace DB is created at `/run/trace/trace.db` (`tracer.ts:369`)".

**Failure scenario:** the tracer opens `<dataDir>/trace.db` (`openWriter`, a few lines below the
cited number), and the in-box data dir is the per-run run root's `trace/` directory, not a
shared `/run/trace/`. The point the sentence exists to make — per-run tmpfs DB, harvested into
that run's own `<runId>-artifacts/` — is verified and unaffected; only the literal path
shorthand is off. Also `tracer.ts:369` is the boundary-check region; the open is at
`openWriter`. No implementer is misled about isolation.

---

## Counts

| Category | BLOCKER | HIGH | MEDIUM | LOW | C4-marginal | Total |
|---|---|---|---|---|---|---|
| C1-citation | 0 | 0 | 2 (W8-B-2, W8-B-3) | 1 (W8-B-4) | 0 | 3 |
| C2-semantic | 0 | 0 | 0 | 0 | 0 | 0 |
| C3-structural | 0 | 0 | 1 (W8-B-1) | 2 (W8-B-5, W8-B-6) | 0 | 3 |
| C4-marginal | 0 | 0 | 0 | 0 | 2 (W8-B-7, W8-B-8) | 2 |
| **Total** | **0** | **0** | **3** | **3** | **2** | **8** |

Severity totals: 3 MEDIUM · 3 LOW · 2 marginal. No BLOCKER, no HIGH, no C2.

---

## Convergence verdicts

### DF5.3 — Audit Chain Extended: **NOT CONVERGED** (confidence: medium-high)

The load-bearing spine verified clean at source — hop table, emitter sites, seam discipline,
VOID convention, fail-closed rules, digest-subject (not file) rule, ChainReport/`OQ4_VOID_REASON`
ownership, and every surviving-clause citation — but the residue is real: the F001/#157
"declared, not wired" premise is inverted by a merged dependency (DF2.12) that the story's own
"dated, not permanent" hedge anticipated but its AC/fixture text does not, and a third of the
cost-ledger line citations point at unrelated regions.

### DF5.4 — Lights-On Gate: **NOT CONVERGED** (confidence: medium)

The chassis contract is exact to the line (all gate-runner cites, the VOID detail rendering, the
skip/fail/void semantics, budgets, determinism, non-vacuity), the C9↔hop-table reciprocity and
the single-export `ChainReport`/`OQ4_VOID_REASON` wire format hold in both directions, and ten
of eleven clauses are evaluable against evidence a healthy run actually produces — the residue
is C3's evidence named by a description no harvested file carries (`trace/events.jsonl` is the
only candidate), C10's stale "box-hours is all the ledger holds" gloss, and the inherited
cost-ledger citation drift.
