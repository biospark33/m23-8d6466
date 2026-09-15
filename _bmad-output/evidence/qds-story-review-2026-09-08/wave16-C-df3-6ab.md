# Wave 16 — Verifier C — DF3.6a + DF3.6b (paired)

**Date:** 2026-09-14 · **Tree:** branch `dev` @ 4264f546 + uncommitted spec edits (reviewed as-is)
**Clean eyes:** no prior wave/scan/tracker/HANDOFF/seam-ownership/fix-recipe material read.

## Method

Read both story files end to end, then opened at source every named symbol, constant, flag,
event, fixture, path and citation: `src/phase-engine/steering.ts` (full), `src/phase-engine/
manifest.ts` (schema, `retries` clamp, `requiredBudgetMs`, `stampManifestLimit`),
`src/phase-engine/types.ts`, `src/phase-engine/journal.ts` (full), `scripts/pipeline-run.ts`
(`runContextFrom`/`admittedCeilingBeside`/`witnessPresent`/`witnessStaleBecause`,
`readResidentBriefSource`, arming try/catch, the `!("disabled" in spawned)` gate, the sole
`createSteering` call site, all three solicitation call sites, the run-down finally's
`exitStatus` refresh), `src/fleet/resident.ts` (full), `src/fleet/dispatch.ts`
(`mintAndDeliverKey`, fill step, `stampManifestLimit` call), `src/fleet/status.ts`,
`src/providers/credentials.ts`, `src/providers/cost-ledger.ts`, `src/reverify/worktree.ts`,
`scripts/cap-hit-demo.ts`, `scripts/build-exedev-image.ts`, `cli-anything/src/types.ts`,
`oci/exedev/systemd/qds-run@.service`, `oci/exedev/Dockerfile`, `src/providers/exedev/driver.ts`,
fixtures (`pipeline.resident.json`, `pi-catalog/openrouter.json`, `fake-resident.ts`),
`tests/phase-engine/resident-e2e.test.ts` (harness + witness), `tests/phase-engine/pipeline-run.test.ts`,
`tests/fleet/e2e/tier4-resident.live.test.ts` (header, `liveGate`, legs, cost figures),
`tests/providers/exedev/image-assets.test.ts`, `.claude/skills/qds-live-e2e/SKILL.md`.

**Cross-story reads (named seams only):** df3-3 (AC5 closed resident block, the `:625` deferral,
the `:632` union transfer, the `:237` INV-RES-3 exhibit, `exitStatus` field ownership, the two
reserved tripwire names); the tier-2 ADR (Appendix B, the same-day correction, the measured
2.17 s / $0.000025 solicitation); DF2.10's image-scan/buildId premise (via its story's recorded
finding + `image-assets.test.ts`). `sprint-status.yaml` read only for the two claims the stories
cite it for (deps rows, sequencing). df2-7/df5-1 cites and R5/gates-report facts **not** opened
(outside the allowed seam list); no finding rests on them.

**Positive controls (every zero-match claim run with identical machinery):**

| Claim | Control run | Result |
|---|---|---|
| No bound fields provisioned anywhere today | `grep residentSpendCeilingMicros\|residentRssBytes\|maxSteeringIterations` over dispatch.ts + manifest.ts + pipeline-run.ts | 0 hits |
| DoD gate satisfiable at start: no `.sandbox/runs/` / `.sandbox/cost-config` reads in-box | grep over `src/phase-engine/` | 0 hits |
| DoD gate satisfiable: no `providers/credentials`/`providers/cost-ledger` import specifiers | grep over `src/phase-engine/` | 0 hits |
| "Bare tokens appear in shipped prose — the bare tokens are NOT the gate" | grep `credentials` / `cost-ledger` over `src/phase-engine/` | hits in `roster/validate.ts`, `phase.ts`, `phases/test-results.ts`, `steering.ts` (comment) |
| "bounded-exec hits exactly the three shipped importer files" | `grep -rln providers/bounded-exec src/phase-engine/` | exactly 3, at the cited lines (`:17`/`:34`/`:37` exact) |
| "42 `startResident(` call sites" in `tests/fleet/resident.test.ts` | `grep -c` | exactly 42 |
| `Delegate=` absent from the unit today (new work) | grep | absent; `RuntimeDirectoryPreserve=yes` present at unit `:160`, Dockerfile scan `:822` in the claimed shape |
| `pipeline.bounds.json` / `pi-catalog-bounds/` absent | ls | absent — both are Files-to-Modify new files, consistent |
| Sole tripwire cause member today | read `ResidentTripwire` | `"gate_bypass_attempt"` alone; `spend_ceiling_breach`/`watchdog_kill` reserved in df3-3 (verified at its `:188`) |
| AC6 replay guard exists | grep tier2-in-box-engine live test | `ENGINE_MARKER_PRESENT` / `engine_refused_replay` present |
| "every shipped caller normalises to numbers" | grep `ResidentCaller` implementations | sole shipped impl returns numeric usage |
| Scoped suites green before start (Infra Prereq) | `bun test tests/phase-engine/steering.test.ts` → /tmp/w16c-steering.log; `bun test tests/phase-engine/resident-e2e.test.ts` → /tmp/w16c-e2e.log (ANSI/CR stripped) | 91 pass / 0 fail; 12 pass / 0 fail — **the armed DF3.3 e2e is green today**, which is what makes W16C-6a-1 land |

**Arithmetic re-derived:**
- Bounds-catalog projection: `(16000/4 × 180_000_000 + 1024 × 40_000_000)/1e6` = **760,960 µ$** ✓; pinned usage meters `round(4000×180_000_000/1e6)+round(1024×40_000_000/1e6)` = 720,000+40,960 = **760,960** — equal by construction ✓. Crossover: 0→760,960 (allowed) → 1,521,920 (allowed) → 1,521,920+760,960 = 2,282,880 > 2,000,000 (refused) ✓.
- Default catalog: `(4000×80_000 + 1024×180_000)/1e6` = 504.32 → **504 µ$** ✓; fake default `{1000,64}` → 80+12 = **92 µ$** ✓. Frontier: 4_000×15e6+1_024×75e6 over 1e6 = **136,800 µ$** ✓, = 17.1× the 8,000 µ$ fallback ("seventeen times") ✓. Fallback buys 8,000/504 ≈ 15.9 → "roughly sixteen" ✓. Backstop ratio 50,000,000/8,000 = **6,250×** ✓. Harness-kill inversion at budgetCapUsd×0.9 < 8,000 µ$ → **$0.0089** ✓.
- Reachability AC6: `2 + 3×5 = 17`; 17×504 = 8,568; 8,000 → `binding` ✓, 50,000 → `unreachable` ✓.
- Tier-4 cost: header "ONE key … 50 000 µ$ … ≈ $0.05 model + ~1 box-hour" verbatim ✓; measured leg "4857 in / 68 out" at 0.08/0.18 → 388.6+12.2 ≈ **401 µ$** ✓; in-box figure $0.000025 = 25 µ$ ✓ (tier-2 file `:51`, ADR `:83`). Triple box count = 1+2 ✓.
- **`requiredBudgetMs` for the retries:5 fixture — see W16C-6a-2 (the one arithmetic that fails).**

## Findings — DF3.6a

| ID | Class | Sev | Finding |
|---|---|---|---|
| W16C-6a-1 | C3 | **HIGH** | **Armed-fixture bound-field coverage is under-owned: the loader's required-field design needs four fields on every hand-authored armed manifest; the Files row authorizes one.** AC2a (and INV-BND-2) require `residentSpendCeilingMicros`, `capMicroUsd`, `defaultKeyCapMicroUsd` — "a manifest missing any of the three refuses the run" — plus `residentRssBytes` (same load). The only provisioner is the dispatch fill stamp, which hand-authored fixtures bypass — the row for `tests/phase-engine/fixtures/pipeline.resident.json` says so itself (W14C-6a-1) and then adds **"gains `residentRssBytes` (one field)"** only. That fixture is loaded by `tests/phase-engine/resident-e2e.test.ts`'s `runLeg`, which copies it beside a witness carrying `requestId`/`repoSlug`/`issueId` — every non-`--no-resident` leg **arms**, so after this story lands every armed leg refuses `bound-config-invalid` at manifest load: the shipped DF3.3 e2e (12 tests, green today under my run) goes red, and the fix (adding three operands to a DF3.3-owned fixture) is an edit the "(one field)" row forbids. Corroborating gap: the E2E Slice enumerates `pipeline.bounds.json` with only three bound fields (`residentSpendCeilingMicros`, `maxSteeringIterations`, `residentRssBytes`) — an armed demo fixture needs the two chain operands too, unstated. **Fix:** state that every hand-authored armed fixture carries the full five-field bound set with ordering-valid values, owned in the `pipeline.resident.json` row, and enumerate all five in the E2E Slice's fixture description. Note the tier-4 legs are NOT affected (they consume a dispatch-stamped delivered pair, covered by the stamp edit) — the hole is exactly the host-side hand-authored armed set. Confidence: high. |
| W16C-6a-2 | C2 | MEDIUM | **The AC3 budget arithmetic does not re-derive.** Shipped formula (`requiredBudgetMs`, manifest.ts): `Σ (retries+1) × (PARSE_FIX_ATTEMPTS+1) × maxDurationMs + phases.length × ROUTING_MARGIN_MS`, with `PARSE_FIX_ATTEMPTS=2`, `ROUTING_MARGIN_MS=5_000`. For the adapted fixture (plan 2,000/retries 0; build 5,000/retries 5): plan 1×3×2,000 = 6,000; build 6×3×5,000 = 90,000; **+ margin 2×5,000 → 106,000 ms**. The story states **96,000 ms " (build 6,000 + 5 × 18,000)"** — the routing-margin term is dropped (96,000 is the attempts sum, not the function's return), "build 6,000" is actually the *plan* term, and "5 × 18,000" corresponds to no derivable unit (build's real term is 6 × 15,000). Both conclusions survive (106,000 > 50,000 refuses; 106,000 ≤ 120,000 funds), so the trigger stays producible — but the stated derivation is checkably false against source and the W14C-6a-2 note hangs on it. Confidence: high. |
| W16C-6a-3 | C1 | LOW | `runBudgetCapMicros` cites `scripts/cap-hit-demo.ts:97`,`:148`,`:1305`; the symbol is declared at `:99` with the "artifact field only" docstring at `:98`, and `:148`/`:1305` land on other lines (real occurrences: 99/164/246/283/501/713/1480/1519). The symbol-level claims (declared only there, behind a `--budget-cap` flag, enforces nothing) all verified true. |
| W16C-6a-4 | C1 | LOW | Provenance line-cites drifted (operative text cites by symbol and is unaffected): `runContextFrom` "`:797`" (now `:814`); the one-way-latch sentence "`:820-821`" (now ~`:944-946`; `:820-821` is a `reportInboxFault` call); the zero-usage disposition "`:435-436`" (now ~`:463-465`); `sprint-status.yaml:43` (the DF3.6 re-sequencing note now sits at `:68`); `steering.ts:11-13` for the fleet boundary (the comment is `:12-13`; `:11` blank). |
| W16C-6a-5 | C4 | LOW | "plus two non-fleet sidecars (`emitAttribution`, `inbox`)" undercounts the shipped `createSteering` deps — `onInboxError` and `onTripwire` also cross. The load-bearing claim ("no `ResidentSpawn` member crosses") is true as written. |
| W16C-6a-6 | C4 | LOW | Files edit (v) says the handler "calls `residentSpawn.stop()`"; df3-6b's (v), AC4/AC5 and the DoD all require it **awaited** (the latch must be real before the walk continues). One word, owned by the other half. |
| W16C-6a-7 | C4 | LOW | The Integration DoD requires the union widening + meter reversal "recorded in DF3.3's deviation ledger", and Files item 4 repeats it — but no Files row covers the df3-3 story file that ledger lives in. The "Mirrored in df3-3's Technical Notes…" sentence describes current spec state, not a dev edit. |

## Findings — DF3.6b

| ID | Class | Sev | Finding |
|---|---|---|---|
| W16C-6b-1 | C1 | LOW | The Image+pin DoD cites `deriveBuildId`'s unit-hashing at "`src/providers/exedev/driver.ts:395,425`" — those lines are pin-movement prose; the symbol is exported from `scripts/build-exedev-image.ts:614`, and the claim itself is true (`BuildIdInputs.files` explicitly includes the `oci/exedev/systemd/` assets; DF2.10's story records the same fact). The stale cite is shared with `sprint-status.yaml`'s DF3.6b row, so the story is not its sole origin. |
| W16C-6b-2 | C1 | LOW | AC5 cites the runner's handle at "`scripts/pipeline-run.ts:3294`"; the `residentSpawn = spawned` assignment now sits at `:3328`. Symbol claim verified (`residentSpawn` is defined at `:3053`, assigned only there, and the finally at `:3733-3753` calls `stop()`/`exitStatus()`). |
| W16C-6b-3 | C4 | LOW | AC4's "the **fleet `warn` chokepoint**" names no shipped symbol — the shipped fleet-side warn channel is `resident.ts`'s single `warn` closure, while the runner-side structured line is a `writeAll(2, JSON.stringify(...))` emission (the `resident_disabled` precedent). Destination (fd-2, harvested) is real; the name is approximate. |

## What HELD (verified, not assumed)

- **The shared pipeline-run.ts edit list (paired contract):** seven edits, DF3.6a owns (i)–(ii), DF3.6b owns (iii)–(vii); disjoint, complete, counts match, and the mirrored texts of (v)–(vii) agree across both halves. Edit (vii)'s necessity is real: the shipped finally unconditionally overwrites `residentBlock.exitStatus` from the probe under the "the process's word is telemetry" comment, and the probe's `lastExit` vocabulary is exactly `success`/`transient`/`logic` — never `"overflow"`.
- **The provisional constant's home (paired contract):** exactly one file across both halves — `resident-bounds.ts`; DF3.6a declares + stamps it, DF3.6b re-sets it in place, `manifest.ts` carries no default (preserving the AC2a missing-value refusal). The two halves' W14C-PAIR-1 wording is consistent.
- **`residentRssBytes` end to end:** schema field (6a, `.strict()` at manifest.ts — an unadded field fails parse as claimed), fill-stamp resolution (manifest-declared → else the provisional constant, sitting beside the shipped `stampManifestLimit` call, with `effectiveCeilingMicros`/`defaultKeyCapMicroUsd` genuinely in scope there), re-set owner (6b), refusal observability (AC2a + DoD). The required/optional split (manifest required, `ResidentSpawnOpts` optional, INV-MEM-2 scoped to the caller-supplied case) is coherent and the 42-site count is exact.
- **Status vocabulary:** every writer named — `active` (init), `degraded` ×3 (render failure, call failure, malformed limit — the shipped one-way-latch comment's own count, verified), `disabled` (the runner's seed shape, which is also AC3's unenforceable-path writer via "the existing disabled-shape branch"), `stopped` (6a's internal writer + 6b's AC4/AC5 arms). Every gate-hold claim traces to the shipped status gate, and the shipped `SEAM DF3.6` comment really does sit immediately **after** that gate (AC5(a) is implementable as placed).
- **The cause union:** sole member today; widening in 6a carrying both members; the transfer is genuinely recorded at df3-3's `:632` and the deferral at `:625`; both reserved names pre-declared in df3-3.
- **The exitStatus chain:** `"overflow"` is a real `EXIT_STATUSES` member (`cli-anything/src/types.ts`); DF3.3 declares the field on its closed block; `stop()` latch at `resident.ts:681-705`; later calls throw at `:474`; `turnCount === 0` zero-usage path returns `{0,0}` exactly as AC4 says; the shipped `meter`/`rawTokens` zero-usage arm and `unpricedTurns` disposition match AC4's description to the letter.
- **Arming-path claims:** the arming try/catch really does rethrow everything that is not `RateError`; `createSteering` really is gated on `!("disabled" in spawned)`; the `resident_disabled` warn shape matches AC3's claimed shipped line; `startResident` spawns nothing at arming (spawn happens per call); `briefIsEmpty` → `{disabled:true}`; the brief travels in the witness via `readResidentBriefSource` (armed legs verified).
- **runContextFrom:** refuses disagreement and stale/unreadable witnesses, returns no `effectiveCeilingMicros` on plain absence, and carries the quoted "ABSENCE is still the only thing that leaves the field unset" comment. AC2b's absence-is-normal semantics match the shipped reader.
- **Cap chain:** `defaultKeyCapMicroUsd = 50_000_000` and the corrected `≤`-chain docstring with the "previously read" quote are in `credentials.ts` as claimed; the `deps.capMicroUsd ?? defaultKeyCapMicroUsd` defaulting expression is in `mintRunKey`; DF2.13's chain passes `capMicroUsd: effectiveCeilingMicros` at the mint and the fill step has it in scope; `CONFIG_KEYS` is exactly the three named keys; `defaultCapMicroUsd = 5_000_000`. `limitMicroUsd ≤ capMicroUsd` holds structurally (the stamp value is min'd downward from the mint request), so the chain-operand vs clamp-input distinction is real, not nominal.
- **Memory mechanism:** the `sh -c` positional wrapper's `|| exit 97` semantics are correct (a failed redirection falls to `exit 97`, never to `exec`; `exec` preserves the pid written to `cgroup.procs`); `memory.oom.group=1` and the EBUSY rationale are correct kernel semantics; `systemd-run --scope` refusal rationale matches the ADR; `EnvironmentFile=`/`AssertPathExists` verified in the unit for Leg A's `QDS_PI_BIN` staging; the no-internal-processes delegation split is correctly stated.
- **Live-round claims:** tier-4 header verbatim for gating/cost/one-key; every leg runs the delivered pair through host-side `pipeline-run.ts` (the W8-C-2 re-site premise); `liveGate("2")` verified in the file and SKILL.md ("accepts only \"1\"|\"2\"", "tier 4" is a roster label); isolated-HOME/auth.json gotcha verified; Leg A ≈zero-spend and the two-lifecycle argument (bin resolved once at arming; stop latch) verified against `resident.ts`.
- **Breach scope vs mechanisms:** spend/memory stop the resident (status latch → gate returns PROCEED → deterministic walk); iteration refuses the solicitation only and never stops the resident — AC3's four-point trigger, the counter semantics (`steeringIterations` increments only on accepted retries — proceed-loops stay at zero), and the per-invocation counter warning all check out against the shipped retry loop (`attempt > spec.retries` exit, `retries` clamped to `MAX_RETRIES = 5`, `MIN_RETRIES = 0`, `post_gate_failure` the only in-loop point).
- **DoD grep gates:** all four forbidden forms are at zero hits today and the bare-token/prose positive control is non-zero, so the gate is satisfiable and is not the blanket-import ban that wave 5b's B2 dismantled; the three-file `bounded-exec` positive control is exact.

## Verdicts

- **DF3.6a — NOT CONVERGED.** One C3-HIGH (W16C-6a-1: the armed-fixture Files row authorizes one field where the loader's own required-field design demands four; the shipped DF3.3 armed e2e, green today, refuses at load as written) and one C2-MEDIUM (W16C-6a-2: the `requiredBudgetMs` derivation states 96,000 ms where the shipped formula computes 106,000 ms). Residue: 2 C1-LOW, 3 C4. Confidence: high (~0.9) — the HIGH rests on an end-to-end trace (armed witness → `runLeg` → manifest load → AC2a refusal) with every link opened, not on an inference.
- **DF3.6b — CONVERGED.** Zero BLOCKER, zero HIGH, zero C2, zero C3. Residue: 2 C1-LOW (W16C-6b-1, W16C-6b-2), 1 C4 (W16C-6b-3) — all symbol-true, line/file-stale. Confidence: high (~0.9); the make-or-break chain (cgroup write → `PlacementRefusedError` → status write → `onBoundBreach` → awaited `stop()` → exitStatus precedence) was traced through shipped code at every hop.

## Summary counts

| Story | BLOCKER | HIGH | MEDIUM | LOW | C4 | Verdict |
|---|---|---|---|---|---|---|
| DF3.6a | 0 | **1** (C3) | **1** (C2) | 2 (C1) | 3 | NOT CONVERGED |
| DF3.6b | 0 | 0 | 0 | 2 (C1) | 1 | CONVERGED |

**Ranked blocking items:** (1) W16C-6a-1 — own the full five-field bound set on every hand-authored armed fixture (`pipeline.resident.json` row + the E2E Slice's fixture enumeration), or the DF3.6a landing turns the shipped armed e2e red with an unauthorized-edit trap; (2) W16C-6a-2 — restate the AC3 budget arithmetic from the shipped `requiredBudgetMs` formula (106,000 ms, margin term included) and correct the term labels; (3) the C1 cluster (cap-hit-demo, `deriveBuildId` file, `:3294`, provenance cites) — convert to symbol/anchor cites per house rule.
