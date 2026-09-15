# Wave 12 — Verifier C — DF3.6a + DF3.6b (paired)

Clean-eyes adversarial pre-dev verification. Scope: the two story specs as they stand in the
working tree (branch dev, current uncommitted spec text), verified against source at HEAD.
No prior wave material read.

---

## Method

**Story reads.** Both halves read end to end before any source was opened.

**Source opened at symbol level.** `src/phase-engine/steering.ts` (whole file: constants,
`ResidentTripwire`, `ResidentTelemetry`, `createSteering` deps literal, `meter`/`clampTerm`/
`rawTokens`, `emitResidentAttribution`, the status gate, the `SEAM DF3.6` and `SEAM DF3.4`
comments, the accepted-retry increment, the snapshot getter, the one-way-latch comment);
`src/phase-engine/manifest.ts` (`PipelineManifestSchema`, `PhaseSpecSchema`'s `retries` field,
`stampManifestLimit`, `stripAuthoredLimit`); `src/phase-engine/journal.ts` (`writeTerminalMarker`
payload, `JournalFile.resident`, `writeResident`, `runMarkerRoot`); `src/phase-engine/types.ts`
(`MIN_RETRIES`, `MAX_RETRIES`); `scripts/pipeline-run.ts` (`runContextFrom` and its reconciliation
comment, `witnessPresent`, `admittedCeilingBeside`, `witnessStaleBecause`, `readResidentBriefSource`,
`MARKER_MAX_BYTES` and the marker reader's oversized arm, `solicitResident` and its three call
sites, the gated retry loop's exit condition, the resident arming region (arming predicate,
credential scan, the arming `try/catch` and its `RateError` arm emitting the `resident_disabled`
warn shape, the sole `createSteering` call site and what crosses it, `residentSpawn = spawned`),
the run-down `finally` (stop-then-probe ordering, the process-probe exitStatus overwrite, the last
`writeResident`)); `src/fleet/resident.ts` (whole file: `ResidentSpawn`, `ResidentSpawnOpts`,
`briefIsEmpty`, `startResident`'s rate resolution, the bin read, `call()`'s pre-spawn guards, the
signal-death classification, `stop()`, the stopped-latch throw, `--no-tools` in the spawn argv,
key-env-borne docstring, `lastExit` writers); `src/fleet/dispatch.ts` (the shipped
`stampManifestLimit` call, the `capMicroUsd` mint wiring); `src/fleet/status.ts` (`not-ok` /
`engine-failed` vocabulary and the settled-marker branch); `src/providers/credentials.ts`
(`defaultKeyCapMicroUsd`, `mintRunKey`'s defaulting expression, the corrected docstring);
`src/providers/cost-ledger.ts` (`CONFIG_KEYS`, `DEFAULT_COST_CONFIG`, `DEFAULT_COST_CONFIG_FILE`,
`loadCostConfig`, `perIssueOverrides` type); `src/phase-engine/roster/validate.ts` (`resolveRate`,
`loadBundledCatalog`'s file-basename provider rule, `QDS_PI_CATALOG_DIR`, the µ$/MTok conversion);
`src/phase-engine/phases/dispatch-task.ts` (`QDS_TEAM_RUNNER=local` anchor); `src/reverify/worktree.ts`
(F064 block, sampler extent); `src/providers/exedev/driver.ts` (`deriveBuildId` inputs);
`cli-anything/src/types.ts` (`EXIT_STATUSES`, `budgetCapUsd` default); `cli-anything/src/runner.ts`
(`BUDGET_KILL_FRACTION`, `budgetKillThresholdUsd`, the DF1.6 effective-ceiling clamp on
`budgetCapUsd`); `cli-anything/scripts/team-lead-driver.ts` (`harvestPiStream`, `ZERO_USAGE`);
fixtures `tests/phase-engine/fixtures/pipeline.resident.json`, `pi-catalog/openrouter.json`,
`fake-resident.ts`; tests `tests/fleet/e2e/tier4-resident.live.test.ts`,
`tests/phase-engine/resident-e2e.test.ts`, `tests/providers/exedev/image-assets.test.ts`,
`tests/fleet/resident.test.ts` (armed-site count); `oci/exedev/systemd/qds-run@.service`
(whole file: `Delegate=` absence, `RuntimeDirectoryPreserve=yes`, the KillMode paragraph,
`AssertPathExists`/`EnvironmentFile`, the QDS_ environment directives);
`oci/exedev/Dockerfile` (unit scan, AC6 env scan, `systemd-analyze verify` stage);
`.claude/skills/qds-live-e2e/SKILL.md` (`liveGate` contract); `_bmad-output/sprint-artifacts/sprint-status.yaml`
(DF3.6a/DF3.6b rows).

**Cross-story reads (named seam claims only).** `df3-3-resident-orchestrator-agent.md`
(AC5 closed key set, the deferral record, the cause-union transfer dismissal, the INV-RES-3
section); `df2-7-session-cumulative-cost-instrumentation.md` (the harness-kill precedence
passage); `docs/superpowers/specs/2026-08-31-tier2-placement-adr.md` (Appendix B and its
same-day correction); `docs/superpowers/specs/2026-08-11-pre-derivation-gates-report.md`
(the D4 ratio-trap finding); `docs/superpowers/specs/2026-08-11-v5-story-derivation-decisions.md`
(§5 conditions-register encoding map, DD-9); `docs/superpowers/specs/2026-08-11-dark-factory-v5-architecture-design.md`
(§5.2 F12 wording). No evidence/, tracker/, HANDOFF/, seam-ownership/, wave/verify/scan or
fix-recipe file was opened.

**Arithmetic re-derived independently.** All projections recomputed from the shipped constants:
default-catalog projection (4000 × 80,000 + 1024 × 180,000)/1e6 = 504.32 µ$; frontier projection
(4000 × 15,000,000 + 1024 × 75,000,000)/1e6 = 136,800 µ$ = 17.1× the 8,000 µ$ fallback; bounds-catalog
projection (4000 × 180,000,000 + 1024 × 40,000,000)/1e6 = 760,960 µ$; the demo's three-point
sequence 760,960 → 1,521,920 → refusal at 2,282,880 > 2,000,000; fake-resident default usage at
fixture rates 80 + 12 = 92 µ$; reachability on a five-phase manifest at `2 + 3 × 5` = 17 calls →
8,000 < 8,568 = "binding", 50,000 ≥ 8,568 = "unreachable"; harness-kill crossover 8,000/0.9 ≈
$0.0089; `budgetCapUsd` 0.5 × 0.9 = $0.45 = 450,000 µ$. Rate-unit chain verified end to end
(catalog USD-per-MTok → ×1e6 µ$/MTok in the resolver → ÷1e6 at both the projection and the meter).

**Positive controls (identical machinery, scoped, teed, ANSI/CR-stripped).**
- `bun test tests/phase-engine/steering.test.ts` → exit 0, 91 pass / 0 fail (`/tmp/w12c-steering.log`).
- `bun test tests/fleet/resident.test.ts` → exit 0, 39 pass / 0 fail (`/tmp/w12c-resident.log`).
- Catalog-resolution control: `tests/phase-engine/fixtures/pi-catalog/openrouter.json` carries an
  `openai-completions` inner key under an `openrouter.json` basename, and the bundled-catalog
  reader keys entries by file basename + inner id — which is exactly how the resident's
  provider-qualified slug resolves today. The story's `pi-catalog-bounds/openrouter.json` plan
  therefore resolves under the same machinery; the naming is not a guess.
- Zero-usage control: `harvestPiStream` seeds from a zero-usage total and always returns numeric
  token counts, confirming the story's claim that a reply with no usage *object* is test-only and
  the `{0,0}` shape is the production path.
- Armed-site count control: `grep -c "startResident("` over `tests/fleet/resident.test.ts` = 42,
  matching the story's number exactly.

---

## Findings — DF3.6a

| ID | Class | Severity | Finding |
|----|-------|----------|---------|
| W12C-6a-1 | C3 | **HIGH** | **`residentRssBytes` has no production provisioner, yet both halves assert it is never absent in production.** The fill-side stamp edit enumerates exactly three stamped operands (`residentSpendCeilingMicros` via the ladder, `capMicroUsd`, `defaultKeyCapMicroUsd`) and closes with "and nothing else" (naming `limitMicroUsd` and `defaultCapMicroUsd` as the excluded fields) — `residentRssBytes` appears in neither the stamp list nor the exclusion list. AC2a refuses a manifest missing it; DF3.6b's spawn-option docstring and INV-MEM-2 Scope both rest on "in production it is never absent, because DF3.6a refuses the run at manifest load on a missing value". Under the closed enumeration that refusal fires for **every dispatched resident-arming run** (dispatch stamps three operands, not four), which breaks DF3.6b's own AC1 proof leg and the tier-4 steered leg both stories reuse — or, if a dev resolves it with a schema `.default()`, AC2a's missing-value refusal becomes unobservable and its DoD test unbuildable. The story's own dead-writer warning ("the schema gains fields nothing writes") is the exact shape. The repair is one line in a file the story already owns (stamp the provisional constant from `manifest.ts`, which is already in both Files lists), but the spec's own words forbid it. |
| W12C-6a-2 | C2 | **MEDIUM** | **The DoD's iteration-bound test item is unreachable from its own Given.** The DoD AC3 item reads "a phase declaring `retries: 5` whose gate **fails every attempt** … completes on the deterministic path, and the next phase solicits normally". AC3's own argument proves a gate failing every attempt exhausts `retries`, rethrows `GateFailureError` from the retry loop, and fails the phase — "there would be no next phase to solicit". The working fixture is AC3's producible trigger (fails attempts 1–4, passes attempt 5, refusal at the fourth point, attempt 5 passes). The DoD item is the pre-fix wording left un-mirrored; a dev authoring the test from the DoD line builds an assertion whose Then-clause cannot fire. |
| W12C-6a-3 | C2 | **MEDIUM** | **"Every breach stops the resident" (Overview, and the Breach-behavior Technical Note) is contradicted by AC3.** The iteration bound refuses the solicitation and explicitly does **not** stop the resident — "subsequent phases solicit normally", stated twice in AC3 and pinned by its DoD test — and no tripwire `cause` member exists for it, so it "records the cause" nowhere either. The generalization is true only of the spend bound (and, in the pair, the memory bound). Resolution is forced by AC3's own test, but a dev building from the Overview sentence implements stop-on-iteration-breach and fails the story's own AC3 control. |
| W12C-6a-4 | C3 | **MEDIUM** | **AC2a's fail-closed refusal, as wired, breaks shipped resident-arming suites with no fixture budget.** `loadResidentBounds` runs wherever `pipeline-run.ts` runs — there is no in-box/host fork in the script — and is scoped to runs that arm a resident. `tests/phase-engine/resident-e2e.test.ts`'s steered legs arm a resident against `pipeline.resident.json`, which declares none of the bound fields and never passes through dispatch's stamp; post-6a those legs refuse `bound-config-invalid`. The Files list updates only the new fixtures (`pipeline.bounds.json`, `pi-catalog-bounds/openrouter.json`); `pipeline.resident.json` is a DF3.3-owned artifact and no edit to it is owned by anyone. A dev must either widen the Files list or contradict AC2a's own fail-closed rule. |
| W12C-6a-5 | C1 | LOW | Citation-rot cluster, none load-bearing: (a) the paired story's numeric anchor for "the runner holds the handle" lands inside the `startResident(...)` argument list; the assignment `residentSpawn = spawned` sits roughly thirty lines later; (b) the `credentials.ts` no-edit entry's cited docstring range covers the BACKSTOP opening line but not the corrected chain or the "previously read" quote, which sit lower in the same docstring; (c) both halves' split records anchor the v5-S3 re-sequencing at a `sprint-status.yaml` line that has since moved (the record now sits at the yaml's re-sequencing comment further down; the DF3.6a/DF3.6b rows are at their own keys and match the stories' dependency edges exactly). |
| W12C-6a-6 | C4 | LOW | AC4's negative control names "the `clampTerm` arms in `steering.ts`'s `meter`" as the zero-usage arm; the usage metering path is the `rawTokens` helper's undefined-value arm (returning 0 for absent usage), while `clampTerm` clamps the rates and the attribution line's token counts. The behavioral claim (no-usage meters zero, never throws) is correct; the mechanism name is not. Same imprecision repeats in Files-to-Modify item 4. |
| W12C-6a-7 | C4 | LOW | AC6's `below_one_call` stop has no named record: the cause union admits no member for it and no tripwire row is specified, so `code:"bound-config-invalid"`'s destination (presumably the trace/log reachability row) is implied, never stated; and the same `code` is shared between a run-refusing load failure (AC2a) and a resident-only stop (AC6) with no discriminator beyond prose. |
| W12C-6a-8 | C4 | LOW | Precedence item 0's numbers describe the un-raised `budgetCapUsd` default ($0.45 kill), but in a dispatched run the harness cap is raised to the run's effective ceiling at spawn (per the very `df2-7` passage the item cites, and `runner.ts`'s min-with-ceiling clamp) — the operative threshold is 0.9 × effectiveCeiling, not 450,000 µ$. The stated invariant (`residentSpendCeilingMicros < budgetCapUsd × 0.9`) and the $0.0089 crossover arithmetic both survive; the worked number invites misreading. |
| W12C-6a-9 | C4 | LOW | The AC3 rationale's compressed phrasing "two calls at 760,960 µ$ cross its 2M ceiling at the **second** point" reads as a crossing at the second point; the actual refusal is the **third** solicitation point's projection (2,282,880 > 2,000,000), exactly as the E2E Slice's own step sequence states. Compression, not error. |

---

## Findings — DF3.6b

| ID | Class | Severity | Finding |
|----|-------|----------|---------|
| W12C-6b-1 | C3 | **HIGH** (pair-inherited; owned by DF3.6a's Files text — see W12C-6a-1) | INV-MEM-2's Scope clause and the spawn-option docstring both assert "in production the field is always present and INV-MEM-2 always applies", with the runner named as the writer ("`scripts/pipeline-run.ts` passes the bound DF3.6a validated"). No edit in the pair's seven-item `pipeline-run.ts` list writes `residentRssBytes` onto the stamped manifest; edit (iii) only forwards it to `startResident` at the call. The premise has no writer behind it — the same "every path where a gate is claimed to hold actually has a writer behind it" test the pairing contract applies to status. 6b's AC1 proof leg (a dispatched run) is the first thing to hit the refusal. |
| W12C-6b-2 | C4 | LOW | The Observability Contract's Destination sentence enumerates "the only journal `resident` values this story writes" as `exitStatus:"overflow"` and `status:"disabled"` — omitting `status:"stopped"`, which the story's own AC4 and AC5 write through the internal writer. DF3.6a's mirror sentence names `stopped` correctly. Enumeration slip; AC5 governs. |
| W12C-6b-3 | C4 | LOW | "a fourth value would violate its AC5" — the shipped `ResidentStatus` set already has four members (`active`/`degraded`/`disabled`/`stopped`); a new one would be a fifth. Wording only; the closed-set claim itself is correct and verified against `df3-3` AC5. |
| W12C-6b-4 | C1 | LOW | The Leg B cost figure "~401 µ$ measured on the tier's host-side leg" is not verifiable from any in-scope source (the tier-4 file asserts bounds, not a measured per-call figure; the ADR carries the in-box 25 µ$ measurement, which verifies exactly). Possibly sourced from out-of-scope evidence. Informational — nothing in an AC depends on it. |
| W12C-6b-5 | C4 | LOW | Both halves say of the `createSteering` call site that "no `ResidentSpawn` member crosses" immediately after stating it passes `spawned.caller`/`spawned.rate` — which are members. The intended claim (no further member; the engine never receives the handle) is clear from context and from the enumerated two-sidecars list, but the sentence contradicts itself as written. |

---

## What HELD (verified positive, abridged)

- **Arithmetic.** Every number in both halves re-derives exactly: 760,960 / 1,521,920 / 2,282,880;
  504 (504.32) µ$ and "roughly sixteen" calls at the fallback; 92 µ$ for the fake's default usage;
  136,800 µ$ = 17× fallback; `2 + 3P` = 17 on five phases → `binding` at 8,000 and `unreachable`
  at 50,000; $0.0089 crossover; 450,000 µ$ at the 0.5 default. Rate units close end to end
  (USD/MTok → µ$/MTok ×1e6 → ÷1e6 at both consumers). Metered-equals-projected **by construction**
  holds: the FAKE_RESIDENT_USAGE pin (4000/1024) is the projection's own shape and both paths
  round identically.
- **AC3's trigger is producible.** `pipeline.resident.json`'s build gate is exactly the
  `$TMPDIR/qds-resident-fixture-count` counter with `test "$n" -ge 2`; adapting to `-ge 5` with
  `retries: 5` yields failure points at attempts 1–4 and a pass at 5, with the bound refusing at
  the fourth point; the retry loop exits at `attempt > spec.retries`; `retries` defaults to
  `MIN_RETRIES = 0` and clamps at `MAX_RETRIES = 5`, so 3 sits strictly below the structural
  ceiling. `post_gate_failure` is the only in-phase solicitation point (three `solicitResident`
  call sites: one in-loop, one at run start, one at run end).
- **Metering basis.** The shipped meter meters absent usage as zero without throwing;
  `emitResidentAttribution` records `unpricedTurns = 1` for absent usage and priced-zero only for
  the literal `{0,0}` shape — exactly AC4's stated disposition, and exactly what edit 4 reverses
  ceiling-side. The "no usage field is unreachable in production" claim verifies
  (`harvestPiStream` normalises to numbers).
- **The steering seam.** `SEAM DF3.6` sits after the status gate; the status gate is a real
  one-way latch with exactly three degrade writers (render, call failure, malformed limit) and no
  "active" write-back; `steeringIterations` increments only on an accepted retry at
  `post_gate_failure`, so the proceed-loop claim and AC3's own-counter requirement both hold; the
  deps literal is marked additive for DF3.6; the controller's telemetry accessor is a snapshot
  getter with no setter; `ResidentTripwire.cause` is the single-member closed union with DF3.3's
  transfer recorded both beside the union and at `df3-3`'s dismissal record (that anchor
  verifies exactly); `ResidentTelemetry` is the closed journal block; `runId`/`detail` required,
  `requestId`/`phase` optional — the E2E tripwire shape is exact.
- **`runContextFrom`.** At manifest-load's consumer in `pipeline-run.ts`; refuses on disagreement
  and on stale/unreadable witness; the "ABSENCE is still the only thing that leaves the field
  unset" comment is verbatim; plain absence returns a context without the ceiling. AC2b's
  resolution of the former contradiction is implementable as written.
- **Cap chain operands.** `defaultKeyCapMicroUsd = 50_000_000` exported from `credentials.ts`,
  docstring already carrying the corrected `≤` chain and the "previously read" quote (the no-edit
  entry is right); `mintRunKey` takes `deps.capMicroUsd ?? defaultKeyCapMicroUsd` and refuses above
  the backstop; DF2.13 landed (dispatch passes the admitted ceiling as the mint cap; the yaml row
  is `done` and names the hard-predecessor grant); `CONFIG_KEYS` is exactly the three keys with
  `perIssueOverrides: Record<string, number>`; `defaultCapMicroUsd` = 5,000,000 µ$ over
  `.sandbox/cost-config.json`. `PipelineManifestSchema` is `.strict()`; `limitMicroUsd` is
  `.optional()`; `stampManifestLimit` writes `limitMicroUsd` only — the stamp-edit premise is true.
- **Marker and refusal shape.** `writeTerminalMarker`'s payload is closed to
  `{runId, ok, completedAt}` over `RunOutcome`; `MARKER_MAX_BYTES = 4096` with a real oversized
  arm that reads an over-large marker as verdict-less; `fleet status` reports `not-ok` for a
  settled false marker and `engine-failed` only for the marker-absent/failed-unit state; the
  `{code, message, remediation}` fd-2 triple has a shipped precedent (`ReplayRefusal`).
- **Engine↛fleet boundary and the DoD grep.** `steering.ts`'s header forbids fleet imports only;
  exactly three engine files import `providers/bounded-exec` (the positive control's exact count,
  one of them `resolveRate`'s home); `providers/credentials` / `providers/cost-ledger` /
  `.sandbox/runs/` / `.sandbox/cost-config.json` have zero import/path hits under
  `src/phase-engine/`, while the bare tokens do appear in shipped prose — the four-form gate is
  the only one that can pass.
- **Memory half mechanics.** `ResidentSpawn` ships caller/rate/exitStatus/stop and no pid; the
  child handle is closure-local; `stop()` SIGKILLs, awaits exit, releases the claim; a post-`stop()`
  call throws at the latch line; signal death classifies `transient` and throws; `lastExit`'s
  vocabulary is exactly `success`/`transient`/`logic`; the shipped run-down `finally` stops the
  resident first, then overwrites `exitStatus` from the probe ("the process's word is telemetry")
  and writes the final block — so refresh-precedence edit (vii) is genuinely required and correctly
  targeted (an OOM-kill would otherwise read `transient` beside `stopped`); `"overflow"` is a real
  `EXIT_STATUSES` member at the cited range; the arming `try/catch` rethrows everything that is not
  the rate refusal and the `rate_unresolved` warn shape is exactly as quoted; `createSteering` is
  never constructed on that path (gated on `!("disabled" in spawned)`), so W6-C-H5's
  arming-vs-`onBoundBreach` separation is structurally real; the fleet→engine import direction is
  already exercised (`resident.ts` imports the steering port); the `sh -c` wrapper's `|| exit 97`
  fail-closed semantics and positional argv are correct; `memory.oom.group=1` / the no-internal-
  process rule / delegation chown semantics are correct kernel and systemd behavior; the unit
  carries no `Delegate=` today, carries `RuntimeDirectoryPreserve=yes` with the exact
  `grep -qE '^…$'` Dockerfile assertion to mirror, sets the two allow-listed `QDS_` environment
  directives (so `Delegate=memory` is invisible to the AC6 scan), carries mandatory
  `EnvironmentFile` + `AssertPathExists` (Leg A's `.env` staging route is real), and its
  kill-policy paragraph documents the cgroup as containing the pi child, `code` phases and
  team-lead drivers (AC2's anchor is exact); `deriveBuildId`'s inputs include the unit bytes;
  `worktree.ts`'s F064 block and sampler extent are as cited and untouched by the design.
- **Live-round plumbing.** The tier-4 file's header confirms host-side `pipeline-run.ts` legs,
  the L1/L2/L3 leg set, the 50,000 µ$ cap and the ≈$0.05 + ~1 box-hour self-pricing, the AC6
  replay guard refusing a second run on a settled box, and `liveGate("2")`; the SKILL confirms
  `liveGate` accepts only "1"/"2" so a tier-4 export throws; the ADR carries the 2.17 s /
  $0.000025 in-box measurement and Appendix B with its same-day DF5.1 correction, including the
  rooted-at-X's-pid wording both halves quote; `QDS_TEAM_RUNNER=local` anchors in
  `dispatch-task.ts`; the fake-resident default usage and the fixed counter file are as cited;
  `spawnRunner` is a real harness helper.
- **Positive controls.** `tests/phase-engine/steering.test.ts` 91/0 and
  `tests/fleet/resident.test.ts` 39/0 — the infra prerequisite ("DF3.3's suite green before this
  story starts") holds today. The 42 armed-site count verifies exactly.

---

## Verdicts

**DF3.6a — NOT CONVERGED.** 1 HIGH (W12C-6a-1), 2 MEDIUM C2 (W12C-6a-2, W12C-6a-3), 1 MEDIUM C3
(W12C-6a-4), 5 LOW. Confidence: HIGH on the verdict — the HIGH is verified against the shipped
stamp enumeration, both halves' own never-absent invariants, and the fixture reality; the C2s are
verbatim self-contradictions inside one file. The story's mechanism design, arithmetic and wiring
map are otherwise sound: after one stamp-list line, one DoD re-wording, two generalization
sentences, and a fixture-ownership decision, this converges.

**DF3.6b — NOT CONVERGED.** 1 HIGH, all pair-inherited (W12C-6b-1 = W12C-6a-1's 6b face: the
never-absent premise and the AC1 proof leg depend on a writer the pair's edit list does not
contain); 0 local C2/C3; 4 LOW. Confidence: HIGH that 6b's own text contains no local blocking
defect — its mechanism, kernel semantics, fail-closed ladders, live-round siting and refresh
precedence all verified against source — and MEDIUM-HIGH that the pair-inherited item is the only
thing standing between 6b and convergence, since the fix lands in DF3.6a's owned stamp edit.

---

## Summary counts

| Story | BLOCKER | HIGH | MEDIUM | LOW | C1 | C2 | C3 | C4 | Verdict |
|-------|---------|------|--------|-----|----|----|----|----|---------|
| DF3.6a | 0 | 1 | 3 | 5 | 1 | 2 | 2 | 4 | NOT CONVERGED |
| DF3.6b | 0 | 1 (pair-inherited) | 0 | 4 | 1 | 0 | 1 | 3 | NOT CONVERGED |

(MEDIUM columns: 6a = two C2 + one C3; 6b's HIGH is the same physical defect as 6a's, counted on
both stories because the pairing contract makes the seam bidirectional.)

**Ranked blocking items.**
1. W12C-6a-1 / W12C-6b-1 (HIGH, C3): give `residentRssBytes` a production writer — stamp the
   provisional constant at fill beside the three chain operands, or state the schema default and
   rewrite AC2a's missing-value clause to match; until then every dispatched arming run refuses
   and 6b's make-or-break leg cannot arm.
2. W12C-6a-2 (MEDIUM, C2): re-word the DoD's iteration-bound test item to AC3's fixture
   (fails 1–4, passes 5).
3. W12C-6a-3 (MEDIUM, C2): scope "every breach stops the resident" to the spend bound (and the
   pair's memory bound), excluding the iteration bound.
4. W12C-6a-4 (MEDIUM, C3): decide ownership of the legacy armed-run fixtures
   (`pipeline.resident.json` and its steered e2e legs) before AC2a's fail-closed refusal lands.
