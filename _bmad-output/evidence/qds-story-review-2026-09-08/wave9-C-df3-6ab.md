# Wave 9 — Verifier C — DF3.6a + DF3.6b

**Date:** 2026-09-14 · **Branch:** `feature/wave7-seam-ownership-rework` (HEAD `6a7ae6c2`, tree clean)
**Scope:** `_bmad-output/sprint-artifacts/dark-factory-v5/stories/df3-6a-resident-spend-iteration-bounds.md` · `df3-6b-resident-memory-bound-cgroup.md`

## Method

Read both specs end to end, then opened at source every symbol, constant, event, fixture and
path the pair relies on, and traced the call paths rather than trusting citations:

- **`src/phase-engine/steering.ts` (full):** `PROMPT_CHAR_CEILING`/`MAX_OUTPUT_TOKENS`/`SOLICIT_TIMEOUT_MS`,
  `ResidentTripwire` shape and sole `cause` member, `ResidentTelemetry` (the closed journal block,
  `:204-219`), `POINT_ALLOWLIST`, the accepted-retry increment (`steeringIterations`), the
  one-way latch writes, the `SEAM DF3.6` comment position relative to the status gate, `meter`'s
  `clampTerm`/`rawTokens` zero-usage arms, `createSteering`'s additive deps object, the snapshot-only
  getter, and the `:11-13` engine↛fleet header.
- **`scripts/pipeline-run.ts` (targeted):** `runContextFrom` (full behaviour incl. the
  `ABSENCE is still the only thing that leaves the field unset` comment), `readResidentBriefSource`
  (reads `run-context.json` beside the manifest), `residentArmed` computation, the arming
  `try/catch` (`RateError` arm + everything-else rethrow, the `resident_disabled`/`rate_unresolved`
  warn shape), the `!("disabled" in spawned)` gate and the sole `createSteering` call site (passes
  `caller`/`rate`/`emitAttribution`/`inbox`/`onInboxError`/`onTripwire` — no `ResidentSpawn` member),
  the DF1.3 retry loop (`attempt > spec.retries` exit), the three solicitation-point call sites
  (`run_start` :3480 and `run_end` :3658 outside the phase loop; `post_gate_failure` :2088 in-loop),
  `residentTelemetryOf`, the seed/refresh `writeResident` sites, and the final finally-block
  refresh that overwrites `exitStatus` from the spawn probe.
- **`src/fleet/resident.ts` (full):** `ResidentSpawn` (no pid), `stop()` docstring `:125`, closure-local
  child handle `:451`, `briefIsEmpty` → `{disabled:true}` `:385`, `resolveRate` at `:410`, argv
  `--no-tools`, env-borne key `:137-141`, `assertRunKeyPresent`, signal-death → `lastExit = "transient"`
  `:606-627`, stopped-latch throw `:474`, `stop()` `:681-705`, `harvest.turnCount === 0` → returns anyway.
- **`src/phase-engine/manifest.ts` / `types.ts`:** `.strict()` at `:317`, `retries` default/clamp at
  `:225`, `MIN_RETRIES`/`MAX_RETRIES` at `types.ts:30-31`, `limitMicroUsd` `.optional()`,
  `stampManifestLimit`/`stripAuthoredLimit`.
- **Cap chain:** `defaultKeyCapMicroUsd = 50_000_000` (`credentials.ts:80`), `deps.capMicroUsd ??
  defaultKeyCapMicroUsd` inside `mintRunKey` (`:294`), the corrected `≤`-chain docstring with the old
  text quoted, `DEFAULT_COST_CONFIG.defaultCapMicroUsd = 5_000_000` + `.sandbox/cost-config.json`
  (`cost-ledger.ts:508-511`), DF2.13's landed dispatch wiring (`dispatch.ts:1686
  capMicroUsd: effectiveCeilingMicros`), `stampManifestLimit(loaded, mintedCeilingMicros)` at `dispatch.ts:2985`.
- **Gate greps:** `providers/credentials`/`providers/cost-ledger`/`.sandbox/…` over `src/phase-engine/`
  → zero hits; positive control `providers/bounded-exec` → exactly `gates/command-gate.ts:17`,
  `roster/validate.ts:34`, `phases/test-results.ts:37`; bare tokens `credentials`/`cost-ledger` DO hit
  shipped comment prose (so the spec's path-form-not-bare-token ruling is correct).
- **E2E demo arithmetic re-derived:** bounds catalog projection `(16000/4 × 180_000_000 + 1024 ×
  40_000_000)/1e6 = 760,960 µ$` exact; metered-equals-projected with `FAKE_RESIDENT_USAGE={"input":4000,
  "output":1024}` exact (720,000 + 40,960); refusal at pgf#2 (1,521,920 + 760,960 = 2,282,880 > 2,000,000);
  default-catalog 504.32 µ$ and default fake usage 92 µ$ (80 + round(11.52)); AC6 frontier 136,800 µ$ =
  17.1× the 8,000 µ$ fallback; reachability examples (8,000 < 504×17 → `binding`; 50,000 ≥ 8,568 →
  `unreachable`); `budgetCapUsd` default 0.5 (`cli-anything/src/types.ts:77`) → kill at $0.45, inversion
  below $0.0089 — all correct.
- **Fixtures/harness:** `pipeline.resident.json` build gate (`qds-resident-fixture-count`,
  `test "$n" -ge 2`, `retries: 1`), `fake-resident.ts` (default usage 1000/64, `FAKE_RESIDENT_USAGE`),
  `resident-e2e.test.ts` harness env (`QDS_PI_BIN`, `QDS_PI_CATALOG_DIR`, fixture key), `spawnRunner`
  in `pipeline-run.test.ts`, `readCustomRegistry` ENOENT → empty table (so the nonexistent
  `QDS_PI_MODELS_JSON` pin works), `QDS_PI_CATALOG_DIR`/`QDS_PI_MODELS_JSON` consumers in `roster/validate.ts`.
- **Terminal marker / status:** `writeTerminalMarker` (`journal.ts:381`, payload hard-coded
  `{runId, ok, completedAt}`), `MARKER_MAX_BYTES = 4096` no-verdict arm, `fleet status` state table
  (`ok`/`not-ok` decisive, `engine-failed` = marker-absent + unit failed) — `status.ts` `:91,1311` region.
- **DF3.6b kernel path:** `oci/exedev/systemd/qds-run@.service` (no `Delegate=` today; the KillMode
  comment naming the pi child / code phases / team-lead driver sits at `:180-190`), Dockerfile
  `RuntimeDirectoryPreserve=yes` scan `:822` + AC6 whole-line QDS_ scan `:1029-1040` (unaffected by
  `Delegate=memory`), `src/reverify/worktree.ts` F064 block `:293-299` and sampler span, `dispatch-task.ts`
  `QDS_TEAM_RUNNER=local` anchors, `tests/fleet/resident.test.ts` = exactly **42** `startResident(`
  sites, `deriveBuildId`-hashes-the-unit statement (driver.ts `:444`), `tier4-resident.live.test.ts`
  header ("runLeg still spawns `bun scripts/pipeline-run.ts` ON THE HOST", L1/L2/L3, `liveGate("2")`,
  50,000 µ$ cap, ≈$0.05 + ~1 box-hour), SKILL.md (`liveGate` accepts only `"1"|"2"`; a `QDS_E2E_TIER=4`
  export throws), ADR Appendix B `:153` + same-day correction `:185-193` + measured probe `:83`
  (2.17 s, $0.000025 — wall time and cost only, never memory), `EXIT_STATUSES` contains `"overflow"`
  (`cli-anything/src/types.ts:99-105`), `BUDGET_KILL_FRACTION = 0.9` (`runner.ts:466,470`), seam cites
  into df3-3 (`:237` INV-RES-3 exhibit, `:625` journal-contract deferral, `:632` union-widening transfer) all check out.
- **Scoped test run:** `bun test tests/phase-engine/steering.test.ts` → tee'd to `/tmp/w9c-steering.log`:
  91 pass / 0 fail — the Infra-Prerequisites hook holds on this tree.

**Positive controls used for zero-match claims:** (1) `bounded-exec` import grep (3 exact hits) proves
the grep machinery before the 4-form zero-hit gate; (2) the specs themselves match
`residentRssBytes`/`maxSteeringIterations` before `src/`+`scripts/` report no production-code hits;
(3) `401` matches in `tier4-resident.live.test.ts` before concluding the ~401 µ$ figure is absent from
the ADR/tier file; (4) `KillMode`/`RuntimeDirectoryPreserve` match before concluding `Delegate=` is
absent from the unit today (which is the correct pre-story state).

## DF3.6a — findings (most severe first)

| ID | Sev | Class | Claim at issue | Evidence |
|----|-----|-------|----------------|----------|
| W9C-6a-1 | HIGH | C3 | AC2a: the refusal "writes the **terminal marker** with `{ ok:false, code:"bound-config-invalid", message, remediation }` … **through the existing marker writer**" (AC2a; DoD config-refusal item). | The only marker writer is `writeTerminalMarker` (`src/phase-engine/journal.ts:381`), hard-coded to `{ runId, ok, completedAt }` — `RunOutcome` carries no payload fields (`journal.ts:297`), and the shipped `code`/`message`/`remediation` triple lives on `ReplayRefusal` (`scripts/pipeline-run.ts:1373-1379`) and goes to stderr/trace, never the marker. `src/phase-engine/journal.ts` is absent from the story's Files-to-Modify, and the `pipeline-run.ts` six-edit list says nothing else changes. The mandated payload has no owner in the story's closed edit list. The `ok:false` → `fleet status: not-ok` chain survives (the reader needs only the boolean), but the DoD test as written ("writing the terminal marker with `{ ok:false, code:… }`") cannot pass. Adjacent constraint unacknowledged: a marker carrying a full `remediation` risks `MARKER_MAX_BYTES = 4096`'s "anything larger … is read as carrying no verdict" arm (`pipeline-run.ts:1359-1362`), which would surface `unknown`, not `not-ok`. |
| W9C-6a-2 | MEDIUM | C2 | AC3's DoD mirror: "a phase declaring `retries: 5` **whose gate fails every attempt** stops soliciting at the **fourth** `post_gate_failure` point, completes on the deterministic path, and the next phase solicits normally." | A gate failing every attempt exhausts `retries` and rethrows `GateFailureError` at the loop exit (`scripts/pipeline-run.ts:2073`) — the phase fails and there is no next phase; the Then-clause is unreachable from the DoD's own Given. This is exactly the Wave-5b H1 defect AC3's prose fixed (fails 1–4, passes 5 — and that prose is correct), but the DoD item regressed to the unreachable trigger and the DoD is the test-writer's contract. |
| W9C-6a-3 | MEDIUM | C3 | AC3's producible trigger sited on `tests/phase-engine/fixtures/pipeline.bounds.json`, the same fixture the mandatory E2E demo declares with `residentSpendCeilingMicros: 2_000_000` and prices against the bounds catalog (760,960 µ$/call). | On that fixture + that catalog, the spend bound stops the resident at the **second** `post_gate_failure` (1,521,920 + 760,960 > 2M); the status gate then returns PROCEED for the non-active resident before `checkBounds` (steering.ts `:977-982`), so the iteration counter never reaches 3 and the **fourth** point is never reached. The trigger is producible only under the default catalog (~504 µ$/call: points 1–4 all within 2M) or a raised ceiling — but the story never says which catalog or ceiling AC3's leg uses. One sentence fixes it; as written the two ACs share one fixture whose declared ceiling only supports one of them. |
| W9C-6a-4 | MEDIUM | C2 | AC4's meter reversal charges the **projected worst case** on a no-positive-usage reply, and Technical Notes stake soundness on "the accumulator is the same quantity DF2.12's landed `kind='tokens'` rows record: one spend truth, auditable at DF5.3 hop 3." | The same `meter` feeds both `telemetry.spendMicros` and the DF2.12 attribution row (`emitResidentAttribution` takes `metered.costMicroUsd`, steering.ts `:1017-1018`, `:553`). After AC4's fix, a zero-usage call's attribution row would carry a **projected** µ$ figure — and the story specifies no classification for it (`unpriced`? priced-at-projection?). The shipped meter deliberately separates priced-zero from unpriced (`cost-ledger.ts:19` / steering.ts `:485-488`), and the E2E Slice itself warns that projection-bounded accounting "diverges from the ledger actuals DF5.3 hop 3 audits." The reversal is right for the ceiling; its ledger side is unspecified and would poison the "one spend truth" framing unless the row is flagged unpriced/projected. |
| W9C-6a-5 | LOW | C2 | AC5(b): after a degradation latched, "a bound that fires … records the bound on the bounds-check log line alone"; DoD: "the bound is recorded on the log line only." | Unreachable by the story's own placement: the status gate (`steering.ts:977-980`) precedes the `SEAM DF3.6` position (`:981-982`), so a degraded/stopped resident produces **no further bounds evaluations at all** — no log line exists to record on. The clause is harmless belt-and-braces for an implementation that hoists the check (which AC5(a) forbids), but the DoD asserts a line the mechanism guarantees will never exist. |
| W9C-6a-6 | LOW | C1 | AC5: "DF3.3 degrades OPEN at **four** points." | Three, not four: `telemetry.status = "degraded"` is written at `steering.ts:990` (render fail), `:1012` (call failure), `:1030` (malformed limit) — and the file's own one-way-latch comment says "three paths write 'degraded'" (`:943-944`). Substance (one-way latch, degradation is routine) holds. |
| W9C-6a-7 | LOW | C1 | Files-to-Modify no-edit entry: the corrected credentials docstring "names `deps.capMicroUsd` at `:281`". | Actual: `:294` (`const capMicroUsd = deps.capMicroUsd ?? defaultKeyCapMicroUsd;`). The docstring itself carries the "cited by symbol, not by line" warning; the story's line cite is already stale. Every other 6a line cite checked held (`:11-13`, `manifest.ts:317`, `manifest.ts:225`, `types.ts:31`, `steering.ts:204-219`, `runner.ts:466,470`, `resident.ts:410`). |
| W9C-6a-8 | LOW | C4 | AC1 negative control: an implementation metering only post-call "overshoots **without bound**". | Imprecise: a post-call-only implementation with a tripwire overshoots by exactly one call — which AC1's margin admits — and is caught by the "does not issue the call" clause, not the margin. The control discriminates correctly; the rhetoric doesn't. |
| W9C-6a-9 | LOW | C4 | Trigger Surface follow-ups point out-of-scope rows at **done** stories (DF3.1, DF2.8). | Cosmetic drift in the follow-up column; the out-of-scope scoping itself is right. |

## DF3.6b — findings (most severe first)

| ID | Sev | Class | Claim at issue | Evidence |
|----|-----|-------|----------------|----------|
| W9C-6b-1 | BLOCKER | C3 | AC1 (make-or-break) and AC5/DoD: "the run journal's `resident.exitStatus` is written `"overflow"`"; "after a kernel OOM-kill the journal reads `status:"stopped"` **and** `exitStatus:"overflow"`." | The journal's exitStatus cannot become `"overflow"` through this story's closed edit list. The engine's internal writer sets `telemetry.exitStatus = "overflow"` (6b's steering.ts edit) — but the shipped final refresh in the runner **overwrites** it from the process probe: `const residentBlock = residentTelemetryOf(); … residentBlock.exitStatus = await residentSpawn.exitStatus();` (`scripts/pipeline-run.ts:3740-3744`, last `writeResident` at `:3753`). `residentSpawn.exitStatus()` returns fleet `lastExit`, which on a kernel OOM-kill (signal death) is set `"transient"` (`resident.ts:612`) — and `lastExit` is only ever assigned `"success"`/`"transient"`/`"logic"` in `resident.ts`, never `"overflow"`. The comment at `:3742` states the shipped policy: "keep null — the process's word is telemetry." So on a real OOM run the journal records `status:"stopped"` (telemetry status survives — only exitStatus is clobbered) beside `exitStatus:"transient"`. None of 6b's six enumerated `pipeline-run.ts` edits ("**Nothing else in the file changes**") touches the final refresh, and re-routing the value through fleet's `lastExit` is not in `resident.ts`'s enumerated scope either. The mandated observable is unreachable given the story's own closed edit list. |
| W9C-6b-2 | HIGH | C3 | AC4: the exit-97 placement failure is "classified `unenforceable`", "the solicitation is recorded failed by the runner's `onBoundBreach` arm — `{bound:"rss", allowed:false, cause:"unenforceable"}` … and that same arm calls `stop()`"; Files (v) widens the arm to fire "on the placement wrapper's exit-97 `unenforceable` classification". | No channel carries that classification to the engine. `onBoundBreach` is a `createSteering` dep, so the **engine** must fire it — but at the call-failure catch the engine's only inputs are the thrown `Error` (an opaque, redacted message from the `ResidentCaller` boundary, steering.ts `:1007-1016`) and `deps.lastMemory()`, whose contracted shape is `{ peakBytes, oomKilled }`. A placement failure yields no `oomKilled` reading and no typed error the engine may `instanceof` (engine↛fleet, `steering.ts:11-13`). The story's own seam enumeration — "Three facts cross, on two objects" — does not include an unenforceable signal, no message-sentinel contract is specified, and no file budget covers adding a fourth fact. Without it the engine's catch latches the one-way `"degraded"` and later solicitations keep issuing into the broken placement — the exact defect the clause names. AC3's arming-path classification, by contrast, is fully specified (typed error beside the `RateError` arm, `pipeline-run.ts:3298-3326`) — the per-solicitation half is the gap. |
| W9C-6b-3 | LOW | C2 | DoD Leg A: "a synthetic allocator binary is installed on the box as **that leg's `QDS_PI_BIN`**" on the in-box dispatch. | The delivery channel is unnamed and non-trivial: in-box, `QDS_PI_BIN` is read from the **engine's** process env (`resident.ts:411`), the unit is started by systemd, and DF2.10's AC6 build-time scan admits exactly two `QDS_` directives in the image (`Dockerfile:1029-1040`). The leg needs a named route (e.g. DF2.3's `EnvironmentFile` `$HOME/app/.env`, which does reach the engine's env) or the assertion has no mechanism. Test-mechanics gap, bounded. |
| W9C-6b-4 | LOW | C1 | AC5: "the runner, which holds the handle (`scripts/pipeline-run.ts:3294`)." | Actual assignment: `:3328` (`residentSpawn = spawned`). Also Files item: `deriveBuildId` inputs at `driver.ts:395,425` — the explicit unit-hash statement is at `:444`. Symbol anchors correct; line cites stale. (All other 6b line cites checked held exactly: `resident.ts:116-127, 125, 137-141, 410, 451, 474, 606-627, 681-705`, `types.ts:99-105`, `runner.ts:466,470`, `worktree.ts:293-299`, `steering.ts:199/204-219/26`, `qds-run@.service:185`, ADR `:185-193`, `df3-3…md:237/625/632`.) |
| W9C-6b-5 | LOW | C4 | E2E Slice: "its measured real solicitation ~401 µ$". | Not present in the ADR or the tier file (positive control: `401` matches the file's HTTP-401 comments). Provenance figure from a prior round; not load-bearing — the cost claim stands on the header's 50,000 µ$ cap and ≈$0.05 + ~1 box-hour, both verified. |
| W9C-6b-6 | LOW | C4 | AC5: the un-fixed baseline "reads `status:"degraded"` beside `exitStatus:"overflow"` — a combination no story owns." | The un-instrumented baseline reads degraded + `"transient"` (nothing writes `"overflow"` until this story does). The negative-control target (an implementation wiring exitStatus but not `stop()`) is still valid; the description of the baseline is off by one story-ordering step. |

## What HELD (positive verification)

- **DF3.6a's demo arithmetic is exact and fires on a real run:** 760,960 µ$ projection, metered-equals-
  projected by the `FAKE_RESIDENT_USAGE` pin (720,000 + 40,960, per-term rounding matches the shipped
  `meter`), refusal at pgf#2, spend strictly under ceiling, phase walk deterministic to attempt-5 pass —
  every number re-derived and correct against the shipped `meter` and fixtures.
- **The projection/metering basis is now consistent:** refusal compares projected worst case against
  remaining headroom pre-call; the accumulator is metered actuals; AC6 reachability examples (`binding`
  at 8,000 µ$ on 2+3×5=17 max solicitations; `unreachable` at 50,000 µ$) and the harness-kill
  precedence arithmetic ($0.45 / $0.0089 inversion) are all correct.
- **Every load-bearing code citation checked held by symbol and nearly all by line:** `steering.ts:11-13`
  boundary, three `bounded-exec` importers, `SEAM DF3.6` after the status gate, sole-cause union,
  closed `resident` block `:204-219`, accepted-retry-only `steeringIterations`, one-way latch,
  snapshot-only getter, `clampTerm` zero-usage arm (the AC4 negative control bites today),
  `briefIsEmpty` → `{disabled:true}`, `runContextFrom` refusing on disagreement/stale witness but not
  plain absence (quote verified), `stampManifestLimit` writing `limitMicroUsd` only, DF2.13's landed
  `capMicroUsd` dispatch wiring, `defaultKeyCapMicroUsd = 50_000_000`, `defaultCapMicroUsd = 5_000_000`
  over a host-side path, `retries` default/clamp, `MAX_RETRIES = 5`, retry-loop exit, three solicitation
  points with `post_gate_failure` uniquely in-loop, `resolveRate` once at arming handed over as
  `ResidentSpawn.rate`, the `RateError` arming arm and `resident_disabled`/`rate_unresolved` shape,
  `fleet status` `not-ok` vs marker-absent `engine-failed`, and the `residentRssBytes`-family symbols
  genuinely absent from production code (no landed provisioner — the stamp edit is correctly owned here).
- **DF3.6b's seam story is real end to end:** `ResidentSpawn` ships no pid and no `ResidentSpawn` member
  crosses at the sole `createSteering` site; `lastMemory()` as the third dep is landed-in-6a
  consistently in both files; the `sh -c` self-placement wrapper is fail-closed and argv-positional
  (same-pid `exec`, `|| exit 97` before pi); the supervisor-split design keeps `dispatch_task` workers
  out of the resident leaves by construction; `memory.oom.group=1` rationale is correct kernel
  semantics; `overflow` is a real `EXIT_STATUSES` member; the unit today has no `Delegate=` and its
  KillMode comment documents exactly the co-tenancy AC2's negative control names; the Dockerfile AC6
  scan is genuinely unaffected by `Delegate=memory`; the tier-4 file's header says in terms that it is
  host-side, `liveGate` takes only `"1"|"2"`, and the dedicated in-box dispatch + replay-guard reasoning
  checks out; INV-MEM-2's 42-site and INV-RES-3-exhibit scoping is exact; the DF5.1 stays-open ruling
  and the 512 MiB provisional flag are ADR-backed.
- **Cross-story seams are coherent:** `cause`-union widening owned once (6a) with 6b writing into it;
  `status:"stopped"` reserved-then-written consistently with 6a AC5's proximate-cause qualifier; the
  six-edit `pipeline-run.ts` count is mirrored in both halves; df3-3's deferral and transfer records
  exist where cited; the `credentials.ts` no-edit state matches the file.
- **Infra hook:** `bun test tests/phase-engine/steering.test.ts` → 91 pass / 0 fail on this tree.

## Verdicts

**DF3.6a — NOT CONVERGED** (confidence: high). One HIGH C3: AC2a's mandated marker payload cannot be
written "through the existing marker writer", and no file in the story's closed edit list owns the
writer that could. The remaining residue is bounded and mechanical.

**DF3.6b — NOT CONVERGED** (confidence: high). One BLOCKER C3 (the make-or-break journal observable
`exitStatus:"overflow"` is clobbered by the shipped final-refresh overwrite, outside the story's
enumerated edits) plus one HIGH C3 (no detection channel for the exit-97 `unenforceable`
classification). Both are structural and precise; the mechanism design itself (cgroup, fail-closed
placement, seam enumeration) verified sound everywhere else.

## Summary counts

| Story | BLOCKER | HIGH | MEDIUM | LOW |
|-------|---------|------|--------|-----|
| DF3.6a | 0 | 1 (C3) | 3 (C2, C3, C2) | 5 (C2, C1, C1, C4, C4) |
| DF3.6b | 1 (C3) | 1 (C3) | 0 | 4 (C2, C1, C4, C4) |
| **Pair** | **1** | **2** | **3** | **9** |

By class: C1 ×3 · C2 ×4 · C3 ×4 · C4 ×4 (pair total 15). Residue is not C4-dominant — two structural ownerless-writer
findings (one of them on the make-or-break AC) keep both stories out of convergence.
