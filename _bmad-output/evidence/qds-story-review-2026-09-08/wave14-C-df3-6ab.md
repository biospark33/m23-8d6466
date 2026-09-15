# Wave 14 — Verifier C — DF3.6a + DF3.6b (paired)

**Verifier:** W14-C (clean eyes, no prior review material read)
**Date:** 2026-09-14
**Branch:** dev @ 4264f546 + uncommitted spec edits (working tree as-is)
**Stories:** `df3-6a-resident-spend-iteration-bounds.md`, `df3-6b-resident-memory-bound-cgroup.md`

---

## Method

Both spec files were read end to end first, then every named symbol, constant, flag, event, fixture, path, and citation was opened at source. No evidence/, tracker, HANDOFF, seam-ownership, wave/verify/scan report, or fix-recipe file was read.

**Cross-story reads (named seam claims only):**
- `df3-3` — AC5 (the closed `resident` journal block, `exitStatus` declared by DF3.3 / `"overflow"` + `"stopped"` reserved for DF3.6), the "story that owns the journal contract" deferral record, the "DF3.6 owns widening the union" dismissal, and the INV-RES-3 second-mint exhibit note (both stories' `:625`/`:632`/`:237` claims).
- `df2-7` — the Guards/limits section (tier-3 harness kill, `BUDGET_KILL_FRACTION`, "~$0.45 fires first, killing the run").
- `df5-1` — the three "RSS is `ps`-sampled rather than cgroup-enforced" sites.
- tier-2 placement ADR — Appendix B (ACCEPTED 2026-09-08) including the same-day correction and the "Mechanism, decided 2026-09-08" block.
- `sprint-status.yaml` — the DF3.6 → DF3.6a+DF3.6b (3+3) split rows and the DF2.12 hard-predecessor note (both stories name it as authoritative).
- `df2-10`'s image-scan AC — via `tests/providers/exedev/image-assets.test.ts` and the Dockerfile AC6 scan block (the "Delegate= contains no QDS_" claim).

**Positive controls (every zero-match claim ran with identical machinery):**
- DoD gate: `grep -rn "providers/credentials\|providers/cost-ledger" src/phase-engine/` → **0 hits**; `grep -rn "\.sandbox/runs/" src/phase-engine/` → **0**; `\.sandbox/cost-config` → **0**. Positive control with the same machinery: `providers/bounded-exec` hits **exactly** `gates/command-gate.ts`, `roster/validate.ts`, `phases/test-results.ts` — the three files the DoD names. Bare tokens `credentials`/`cost-ledger` **do** appear in shipped comment prose (e.g. `steering.ts`, `dispatch-task.ts`), confirming the DoD's "the bare tokens are NOT the gate" warning.
- New-work absence: `pipeline.bounds.json`, `pi-catalog-bounds/`, `src/phase-engine/resident-bounds.ts` are absent; positive control in the same `ls`: `pipeline.resident.json`, `pi-catalog/`, `steering.ts` present.
- No pre-existing provisioner: `residentSpendCeilingMicros`/`residentRssBytes`/`PROVISIONAL_RESIDENT_RSS_BYTES`/`maxSteeringIterations` have **2 occurrences in src/+scripts/, both in the `credentials.ts` docstring comment** — no code provisioner exists. Control: `limitMicroUsd` is present in `dispatch.ts` (the shipped stamp).
- `Delegate=` absent from `oci/exedev/systemd/qds-run@.service` and the Dockerfile; positive control: `RuntimeDirectoryPreserve=yes` present in both (the Dockerfile unit-scan grep the story cites as its template).

**Re-derived arithmetic (all independent of the story's numbers):**
- Bounds-catalog projection: `(16000/4) × 180_000_000 + 1024 × 40_000_000 = 720_000_000_000 + 40_960_000_000 → /1e6 = 760,960 µ$` ✓. Demo walk: `0+760,960 ≤ 2M` → allowed; `760,960+760,960 = 1,521,920 ≤ 2M` → allowed; `1,521,920+760,960 = 2,282,880 > 2M` → refused at the second `post_gate_failure` ✓.
- Default-catalog projection: `4000×80,000 + 1024×180,000 = 504,320,000 → 504.32 µ$` ✓ ("~504"). Shipped fake usage metered: `1000×80,000 + 64×180,000 = 91.52 µ$` ✓ ("92").
- AC6 reachability, five phases, `maxSteeringIterations=3` → `maxSolicitations = 2+15 = 17`; `504.32×17 = 8,573.44`; `8,000` → `binding` ✓; `50,000 ≥ 8,573.44` → `unreachable` ✓.
- Frontier projection `4000×15M + 1024×75M = 136.8e9 → 136,800 µ$` ✓; `136,800/8,000 ≈ 17.1` ("seventeen times") ✓; fallback buys `8,000/504.32 ≈ 15.9` ("roughly sixteen") ✓; `50,000,000/8,000 = 6,250×` ✓; harness-kill inversion point `0.008/0.9 ≈ $0.0089` ✓ (kill threshold `budgetCapUsd × 0.9`, default 0.5 → $0.45 ✓).
- **New derivation the stories do not perform (finding W14C-6a-2):** `requiredBudgetMs` over a fixture adapted from `pipeline.resident.json` at `retries: 5` = plan `(0+1)×3×2,000 = 6,000` + build `(5+1)×3×5,000 = 90,000` = **96,000 ms > the fixture's `runBudgetMs` 50,000** → manifest-load refusal.
- DF3.6b memory falsifiers: fixture bound 64 MiB fails "≥2× baseline" when baseline ≥ 32 MiB ✓; 512 MiB loses one doubling at baseline ≥ 256 MiB ✓.
- `pipeline-run.test.ts` armed-leg audit: `armedWitness`-style legs write a non-empty brief witness beside a hand-authored manifest (see W14C-6a-1).

**Tests run (scoped, teed, ANSI/CR-stripped):**
- `bun test tests/phase-engine/steering.test.ts` → `/tmp/w14c-steering.log`: **exit 0, 91 tests** (the Infra Prerequisites "green before this story starts" claim holds).
- `bun test tests/fleet/resident.test.ts` → `/tmp/w14c-resident.log`: **exit 0, 39 tests**; `grep -c "startResident("` = **42**, matching INV-MEM-2's Scope figure exactly.

---

## Findings

### DF3.6a

| ID | Class | Severity | Finding |
|----|-------|----------|---------|
| W14C-6a-1 | C3 | **HIGH** | **The fail-closed missing-operand refusal breaks shipped armed-fixture tests no story owns.** AC2a scopes `loadResidentBounds` to "runs that arm a resident" and refuses any manifest missing the three stamped operands (plus `residentRssBytes`). The provisioner is dispatch's fill step only (`stampManifestLimit`'s call site is the anchor). But shipped tests arm residents on **hand-authored manifests that bypass fill**: `tests/phase-engine/resident-e2e.test.ts`'s `runLeg` copies `pipeline.resident.json` beside a written `run-context.json` whose brief carries `repoSlug`/`issueId` (the arming predicate's own anchor set in `pipeline-run.ts`'s resident arm) — armed, unstamped, no bound fields → refuses `bound-config-invalid` after this story lands. `tests/phase-engine/pipeline-run.test.ts` likewise builds "a green two-code-phase manifest plus a witness brief that ARMS the resident". Neither `tests/phase-engine/resident-e2e.test.ts`, `tests/phase-engine/pipeline-run.test.ts`, nor `pipeline.resident.json` appears in either half's Files to Modify. This is the mirror image of the story's own `ingestCostEvent` dead-writer warning and of W12C-6a-1: a required-field loader with an unowned collateral set. DF3.3's shipped e2e suite goes red under this diff with no file budget to fix it. Fix: add the armed fixtures/test manifests to Files to Modify (declare the four fields), or scope the loader to stamped manifests — the first is the honest option. |
| W14C-6a-2 | C2 | **MEDIUM** | **The mandatory e2e fixture does not load as specified — its budget arithmetic is underived.** AC3 says `pipeline.bounds.json` is "adapting the build phase of `pipeline.resident.json` to `test "$n" -ge 5`". `requiredBudgetMs` (`manifest.ts`, `.strict()` load path) sums `(retries+1) × (PARSE_FIX_ATTEMPTS+1) × maxDurationMs` per phase and refuses when it exceeds `runBudgetMs`. Inherited values give 96,000 ms > 50,000 ms (derivation in Method) → the demo run refuses at manifest load on an unrelated budget check before any bound can be demonstrated. The story's fixture-content list (ceiling, iterations, RSS, catalog, `FAKE_RESIDENT_USAGE`) never mentions `runBudgetMs`/`maxDurationMs`. A dev hits this in the first run and must silently raise a field the spec doesn't own — the exact "fixture that only passes after an undeclared edit" class this campaign kills. |
| W14C-6a-3 | C1 | LOW | **Three stale quoted ranges in the Split Records** (the in-body AC text is symbol-anchored and correct): the one-way-latch sentence actually lives in `solicitSerialized`'s SEAM DF3.4 comment (the story's Wave-5c-corrected range points ~120 lines early); the meter zero-usage sentence lives in `meter`'s docstring beside `clampTerm`/`rawTokens` (the corrected range points early); `runContextFrom` sits at its `export function runContextFrom` anchor ~17 lines below the Wave-5b-cited number. All three claims themselves verified true at source. |

Everything else checked in 6a held (see What HELD).

### DF3.6b

| ID | Class | Severity | Finding |
|----|-------|----------|---------|
| W14C-PAIR-1 | C3 | **HIGH** | **The seam constant has two contradictory homes across the pair.** DF3.6a's provisioner text (Technical Notes "production provisioner" paragraph and the `dispatch.ts` Files entry) twice says the provisional constant `PROVISIONAL_RESIDENT_RSS_BYTES` (512 MiB) is "**declared in this story's `resident-bounds.ts`**, re-set by DF3.6b's measurement". But DF3.6a's own provisional-pending note says "`src/phase-engine/manifest.ts` is in DF3.6b's Files to Modify, scoped to that one value", and DF3.6b says it twice more: its Files entry is "**the `residentRssBytes` default constant only** … re-setting that one constant" in `manifest.ts`, and its DoD says "re-set DF3.6a's 512 MiB default **in `src/phase-engine/manifest.ts`**". Three mentions point at `manifest.ts`, two at `resident-bounds.ts`; only one can hold the constant. `manifest.ts` today carries no RSS constant, and it **cannot**: AC2a makes the field required with a missing-value refusal and the B2 fix deleted schema defaults, so there is no `.default(512 MiB)` for 6b to re-set — the coherent home is `resident-bounds.ts`, where 6a declares it and where `dispatch.ts`'s stamp imports it from. A 6b dev following its own DoD item opens `manifest.ts`, finds nothing, and either invents a constant in a file whose entry says "No other field, no schema change" (recreating the default-as-false-green that B2 removed) or edits the file 6a declared. W6-C-H4 was supposed to close "the value lived in the merged half while the measurement lived here, with no file budget"; the residual is that the file budget names the wrong file in the majority of its mentions. Fix: one sentence — `manifest.ts`'s 6b entry should read `resident-bounds.ts` (or 6a must declare the constant in `manifest.ts` and say so in both provisioner paragraphs). |
| W14C-6b-1 | C1 | LOW | AC5 anchors "the runner, which holds the handle" to a quoted pipeline-run location that has since drifted ~34 lines below the anchor (`residentSpawn = spawned` is in the arming block after `startResident`'s try/catch). The claim itself is verified: the runner holds `residentSpawn` and the run-down `finally` calls `stop()` then probes `exitStatus()`. |
| W14C-6b-2 | C1 | LOW | "its measured real solicitation ~401 µ$ measured on the tier's host-side leg" — no such figure exists anywhere in `tier4-resident.live.test.ts`, the live harness, the ADR, or any in-tree test (searched `401`, `0.0004`, µ$ pricing across `tests/fleet/e2e/` and the ADR). The tier's header prices itself "≈ $0.05 model + ~1 box-hour"; the ADR's measured solicitation is the **in-box** $0.000025/2.17 s (which the story cites correctly as the tier-2 figure). The 401 number has no in-tree home; cite whatever live-round evidence produced it or drop it. Nothing mechanism-bearing rests on it (Leg B asserts `memory.peak`/`oom_kill`, not cost). |
| W14C-6b-3 | C1 | LOW | The Technical Notes' "evidence-artifact field" citations for `runBudgetCapMicros` in `cap-hit-demo.ts` are all stale (the symbol's actual anchors sit at different offsets; the story quotes three, of which the first is two lines off and the other two are materially off). The substantive claim is fully verified — the field is declared behind the `--budget-cap` flag, its own comment says "artifact field only", and it enforces nothing. |
| W14C-6b-4 | C4 | LOW | Both halves say the `createSteering` call site passes `spawned.caller`/`spawned.rate` "plus two non-fleet sidecars" (`emitAttribution`, `inbox`). The site actually passes four non-fleet deps (`emitAttribution`, `inbox`, `onInboxError`, `onTripwire`). The load-bearing claim — "no `ResidentSpawn` member crosses" — is verified true regardless; the count is decorative. |

---

## What HELD (verified at source, not assumed)

**DF3.6a — verified true:**
- `PROMPT_CHAR_CEILING = 16_000`, `MAX_OUTPUT_TOKENS = 1_024`, `SOLICIT_TIMEOUT_MS = 60_000` — all present with the exact quoted values; `MAX_RETRIES = 5` at `types.ts`, `retries` schema-clamped with `MIN_RETRIES = 0` default — the "default ≥ 5 can never fire" argument holds.
- The engine↛fleet boundary comment says exactly "never imports fleet code" — the Wave-5b B2 correction (engine↛fleet, not engine↛provider) is faithful to source; the three `bounded-exec` importer files are exactly as named, at the quoted import lines.
- `createSteering`'s deps docstring explicitly marks the deps object additive "so DF3.6 can add its bounds deps to the same object"; the snapshot-only getter exists and there is no setter; the `SEAM DF3.6` comment sits **after** the `status !== "active"` gate, exactly where AC5(a) requires `checkBounds`.
- The one-way latch: exactly three degrade writes (render failure, call failure, malformed limit), nothing writes `"active"` back — AC5's premise is the shipped code's own count.
- `meter`/`rawTokens`/`clampTerm`: absent usage meters as zero; `emitResidentAttribution` sets `unpricedTurns = 1` for absent usage and priced-zero only for the literal `{0,0}` — AC4's disposition split is the shipped behavior, and the `resident.ts` `turnCount === 0` path (`harvest` returns anyway) is the reachable zero-meting route as claimed.
- `ResidentTripwire["cause"]` is sole-member `gate_bypass_attempt`, with a beside-the-union comment naming both new members as DF3.6's — the transfer from DF3.3 is real on both ends (df3-3's dismissal record and the code comment).
- `runContextFrom` behaves exactly as AC2b claims: refuses on declared-vs-admitted disagreement and on stale/unreadable witnesses, and on plain absence returns a context with no `effectiveCeilingMicros` ("ABSENCE is still the only thing that leaves the field unset" is a verbatim shipped comment). The Wave-5b B3 reversal is correct at source.
- `mintRunKey` contains the exact defaulting expression `deps.capMicroUsd ?? defaultKeyCapMicroUsd`; `defaultKeyCapMicroUsd = 50_000_000`; `mintRunKey` refuses caps above the backstop (`cap-invalid`). `CONFIG_KEYS` is exactly the triple claimed; `DEFAULT_COST_CONFIG` is `{defaultCapMicroUsd: 5_000_000}` over `.sandbox/cost-config.json`. `credentials.ts`'s docstring carries the corrected `≤` chain with the old text inside an explicit historical quote — the "no-edit" Files entry is right.
- `stampManifestLimit` writes `limitMicroUsd` only — "DF3.1's shipped stamp writes limitMicroUsd only" is exact, so the fill-side stamp edit is genuinely new work in a done story's file (the W8-C-1 ownership note is needed and present).
- `fleet status`: settled marker → `ok`/`not-ok`; `engine-failed` is the marker-absent+unit-failed state — AC2a's observable choice (`ok:false` in the marker, code on fd-2) is right, and the oversized-marker arm reads "a verdict this one cannot read" → `unknown`, so keeping `remediation` out of the marker is justified by `MARKER_MAX_BYTES = 4096`'s real refuse path.
- The `writeTerminalMarker` payload is closed `{runId, ok, completedAt}`; `runMarkerRoot` returns `/run` when `QDS_RUN_ROOT` is unset.
- E2E harness: `spawnRunner` pins `QDS_PI_BIN` → the fake resident, `QDS_RESIDENT_ENV_PASSTHROUGH`, `QDS_PI_MODELS_JSON` → a nonexistent file, `QDS_PI_CATALOG_DIR` → the catalog — every "inherits spawnRunner's harness env" clause is verbatim true. Default fake usage `{input:1000, output:64}`; catalog rates 0.08/0.18 — the "no coincidence of defaults" argument holds.
- AC3's producible trigger is sound against the shipped fixture: the fixed `$TMPDIR/qds-resident-fixture-count` survives runs (no cleanup in the fixture), the retry loop exits at `attempt > spec.retries` and rethrows `GateFailureError`, the `post_gate_failure` solicitation sits strictly after authorization inside the loop, and `run_start`/`run_end` have one call site each outside it — the fourth-point refusal with attempt 5 passing is reachable exactly as specified.
- Cap-chain precedence: `BUDGET_KILL_FRACTION = 0.9` and `budgetKillThresholdUsd = budgetCapUsd × 0.9` at the quoted anchors; `budgetCapUsd` defaults 0.5 in the team schema; DF2.7's story confirms the harness kill fires first at ~$0.45 and kills the run — precedence item 0's warning is cross-verified.

**DF3.6b — verified true:**
- `ResidentSpawn` ships `caller`/`rate`/`exitStatus()`/`stop()` and no pid, at the quoted range; the child handle is closure-local; `stop()` SIGKILLs and latches (`stopped` guard makes every later `call` throw at the quoted line); the `lastExit` vocabulary is exactly `success`/`transient`/`logic` — never `"overflow"` — so edit (vii)'s premise (the run-down `finally`'s `residentBlock.exitStatus = await residentSpawn.exitStatus()` under the shipped "the process's word is telemetry" comment would overwrite an OOM-kill's journal value) is verified true and the fix is genuinely required for AC1's observable.
- The arming `try/catch` rethrows everything that is not `RateError` — W6-C-H5's mechanism claim (an unclassified rethrow there yields a tracer-closed, marker-absent box) matches the shipped code; the `resident_disabled` warn shape and the `!("disabled" in spawned)` gate both exist as quoted.
- `"overflow"` is a real `EXIT_STATUSES` member (CC-1, quoted range exact); the journal `resident.status` closed set is DF3.3's four-value union with `"stopped"`/`"disabled"` reserved exactly as both halves claim; DF3.3's AC5 declares `exitStatus` and assigns `"overflow"`/`"stopped"` writes to DF3.6 — the cross-story contract is clean on both ends.
- The `sh -c` wrapper, exit-97 classification, `PlacementRefusedError` on the `ResidentCaller` contract (fleet→engine import direction is real: `resident.ts` imports `steering.ts`, never the reverse), `memory.oom.group=1`, and the delegated-subtree split are all internally consistent with the ADR's "Mechanism, decided 2026-09-08" block and the same-day correction (DF5.1's ceiling stays open; all three df5-1 quoted sites say "ps-sampled rather than cgroup-enforced").
- Unit/Dockerfile: `Delegate=` absent (new work), `RuntimeDirectoryPreserve=yes` grep is the shipped scan shape to mirror, `User=exedev`, mandatory `EnvironmentFile=` + `AssertPathExists=/home/exedev/app/.env` (Leg A's staging route), the unit's own comment at the quoted line says the cgroup contains the pi child (AC2's negative-control premise), the AC6 env scan greps only `QDS_`-prefixed `Environment=` directives expecting exactly two — `Delegate=memory` is invisible to it, and the `systemd-analyze verify` stage exists.
- Live-gate machinery: `liveGate` accepts only `"1"|"2"` and throws on any other `QDS_E2E_TIER`; SKILL.md says "`liveGate` takes only \"1\"|\"2\"" and "tier 3/4/5 is a roster label, never an env value"; gotcha #2's isolated HOME is real; `tier4-resident.live.test.ts` gates on `QDS_E2E_LIVE=1 AND QDS_E2E_TIER=2`, its `runLeg` spawns `pipeline-run.ts` on the host (its own header says so), it has exactly L1/L2/L3 — the "not a fourth leg / dedicated in-box dispatch" re-site is correct, and the two-lifecycle argument (bin resolved once per `startResident`; AC5's stop latch ends the resident at its first kill; the replay guard refuses a settled box) checks out at source.
- `startResident` resolves `QDS_PI_BIN` once per resident; `dispatch_task`'s `QDS_TEAM_RUNNER=local` anchors exist; `worktree.ts`'s F064 block is at the quoted range and the file stays untouched by the story.
- The seven-edit `pipeline-run.ts` contract: disjoint by item ((i)(ii) 6a; (iii)–(vii) 6b), jointly complete, count matches the items in both files, mirrored both directions, with the two deliberate cross-story transfers (`lastMemory` dep in 6a's item 5, the placement channel in item 6 / 6b's edit 2) explicitly declared rather than double-claimed.
- Status vocabulary: every claimed writer exists or is named as new — `degraded` ×3 shipped, `"stopped"` via 6a's internal writer (no public setter; the controller keeps the snapshot getter), `"disabled"` via the runner's disabled-shape block on never-constructed steering, `"overflow"` via 6b's writer; the `stopped`-beats-`degraded` rule is mechanically enforced by the gate-before-check placement (a degraded resident produces no further bounds evaluations), and 6b's AC4 arm writes `stopped` before firing `onBoundBreach` so the status gate holds afterward.
- Breach-scope sentences match their mechanisms everywhere: spend breach → engine stops the resident (status writer) and the walk continues; iteration breach → solicitation refused, resident not stopped (the one non-stopping bound, stated in INV-BND-5 and in 6a's Overview); memory breach → fleet `stop()` via the runner's `onBoundBreach` arm; config refusal → whole run refused before a resident exists; `below_one_call` → stop with `bound-config-invalid`, never `spend_ceiling_breach`. No sentence claims a stopping behavior its AC's mechanism doesn't provide.

---

## Verdicts

**DF3.6a — NOT CONVERGED** (confidence 0.85). One C3-HIGH (W14C-6a-1: unowned collateral breakage of shipped armed-fixture suites) and one C2-MEDIUM (W14C-6a-2: the mandatory e2e fixture refuses at load on underived budget arithmetic). Both are spec-level fixable in minutes — add the armed fixtures/test manifests to Files to Modify, and specify the fixture's `runBudgetMs`/`maxDurationMs` — but as written the story cannot pass its own DoD without editing files it does not own.

**DF3.6b — NOT CONVERGED** (confidence 0.8). One shared C3-HIGH (W14C-PAIR-1: the 512 MiB provisional constant's home is named as `manifest.ts` three times and `resident-bounds.ts` twice; the `manifest.ts` home is empty by 6a's own required-field design). C1/C4 residue (W14C-6b-1/2/3/4) does not block convergence but the 401 µ$ figure should be sourced or dropped.

Per-story residue: 6a — C1-LOW ×1. 6b — C1-LOW ×3, C4-LOW ×1.

## Summary counts

| | BLOCKER | HIGH | MEDIUM | LOW | C1 | C2 | C3 | C4 |
|---|---|---|---|---|---|---|---|---|
| DF3.6a | 0 | 1 | 1 | 1 | 1 | 1 | 1 | 0 |
| DF3.6b | 0 | 1 | 0 | 4 | 3 | 0 | 1 | 1 |

Ranked blocking items: **1)** W14C-6a-1 (shipped armed fixtures refuse under the new loader; unowned files). **2)** W14C-PAIR-1 (constant-home contradiction across the pair). **3)** W14C-6a-2 (e2e fixture budget arithmetic). No BLOCKERs found; the seam architecture, the seven-edit pipeline-run contract, the metering-basis split, the status vocabulary, and the breach-scope mechanisms all verified sound at source.
