# J4 Round 2: Acceptance Auditor

Branch `feature/j4-host-side-judgment-pack` at `3f1d7e23`, rebased onto origin/dev `5b03a7b7` (J3 merged). The change is `git diff origin/dev...HEAD`: 27 files, +4302/−22. Spec: `_bmad-output/sprint-artifacts/dark-factory-v6/stories/j4-host-side-judgment-pack.md` plus `handoff.md` §3/§8. Round-1 inputs: `_bmad-output/reviews/j4-round1/`.

## Evidence runs (read-only; mutations in a `/tmp/j4-mut` copy made with `git archive HEAD`)

- **Focal suites:** `bun test tests/autonomy tests/fleet/observe-ontick.test.ts tests/fleet/observe.test.ts tests/phase-engine/steering.test.ts tests/scripts/corpus tests/judgment tests/scripts/build-exedev-image.test.ts` gave **752 pass / 0 fail** across 25 files (`/tmp/j4-aa2.log`). TYPESAFE_API_KEY was unset.
- **Static gates (scratch copy):** `bunx tsc --noEmit` exit 0, and `bun run lint` exit 0 (604 files).
- **L9 cut (scratch copy):** with both L9 files deleted, `tsc --noEmit` exits 0. The in-suite executed-cut test (`l9-cut-boundary.test.ts:97-140`) passes.
- **Byte-identity vs origin/dev:** these are all identical: `src/phase-engine/roster/schema.ts`, `src/phase-engine/phases/roster-adapter.ts`, `src/gate/gate-runner.ts`, J3's `src/judgment/router.ts`, `src/judgment/index.ts` and `tests/judgment/fence.test.ts`. Nothing under `src/providers/`, `src/audit/` or `src/judgment/` is in the diff. No `classifyRunExit`, `classifyDiffScope` or `AUDIT_HOPS` site is touched.
- **buildId walk:** of all J4-touched files, only `src/fleet/observe.ts` and `src/phase-engine/steering.ts` are walked inputs (I enumerated them with `buildIdFileInputs`). `src/autonomy/`, `scripts/fleet.ts` and `scripts/corpus/` are absent from the walk, which confirms the COPY set excludes them.

### Mutation results (each named negative control)

| # | Mutation (bad implementation) | Result |
| --- | --- | --- |
| M1 | `run_end` allowlist gains `compact` | **RED**: 1 fail (directiveAllowedAt test) |
| M2 | Remove the resident-origin `compact` refusal in `solicit()` | **RED**: 5 fail (3 per-point, parity, inbox e2e) |
| M3 | `PACK_SIGNALS_ARMED = true` | **RED**: 13 fail, plus 14 in the executed-cut child |
| M4 | L7 writes the directive while unarmed (drop `PACK_SIGNALS_ARMED &&`) | **RED**: 5 fail (AC5 zero-writes, env-arm, e2e, hook) |
| M5 | Lazy `import("../autonomy/host-pack.ts")` inside COPYed `src/lib/log.ts` | **RED**: AC1 fence |
| M5b | Static import of the pack from `src/fleet/observe.ts` | **RED**: AC1 fence |
| M6 | `would_signal` = noul only (cross-type shortcut) | **RED**: R1-24 arithmetic control |
| M7 | L9 mock client writes to the top-level measured corpus | **RED**: R1-01 test |
| M8 | L8 declares `diff-hunk` | **RED**: 4 fail (AC7) |
| M9 | Env arming `PACK_SIGNALS_ARMED = process.env.QDS_JUDGMENT_PACK_ARMED === "1"` | **RED**: literal-false/no-ambient-config test |
| M10 / M10b | A `score` (severity-class) question in L7 / L9 | **RED**: 6 / 9 fail |
| M12 | `fleet observe --all` drops the injected `onTick` | **RED**: fleet-observe-pack test |
| M13 | An L9 string inside `host-pack.ts` | **RED**: cut-boundary test, plus the executed-cut child |
| M14 | L9 declares `diff-hunk` | **RED**: 10 fail |
| M15 | Sanity leg writes a corpus record | **RED**: 3 fail (provenance-only test) |
| M16 | Delete the **production** arm `deps === undefined ? { onTick: makeL7ObserveHook() }` | **GREEN**: 0 J4 fails; the only fail is the known dev-red EMFILE test. The gap is AA2-005. |

## Per-criterion table

| Criterion | Verdict | Evidence |
| --- | --- | --- |
| AC1 host-side placement structural | MET | The fence BFS covers the real COPY set and catches static, re-export, `import()`, `require` and alias/`src/`-style specifiers: `tests/autonomy/host-pack.test.ts` AC1 block (M5/M5b red). `src/fleet/observe.ts:233-242` is a seam; it gains only a `../providers/timeout.ts` import, not a pack import. The injection is at `scripts/fleet.ts:2264-2271`. |
| AC2 compact rides the schema only | MET (with the R1-02 deviation, see below) | Fifth `.strict()` member at `src/phase-engine/steering.ts:137-145`. Allowlist entries at `:162-166`, with `run_end` proceed-only. `directiveAllowedAt` at `:171-173`. Resident-origin refusal at `:1393-1400`. The register line is `docs/superpowers/specs/2026-10-02-v6-story-derivation-decisions.md:363-385` (§8a item 16). Negative controls (raw NDJSON, overloaded proceed/retry, wrong discriminator, run_end): `tests/phase-engine/steering.test.ts` J4 block. M1 and M2 are red. |
| AC3 layer over self-compact | MET | The roster files are byte-identical. The hard-cap control at `host-pack.test.ts:838-860` pins `HARD_CAP_FRACTION = 0.9`, checks roster sha256 stability across an ask, and confirms no roster or self-compact import. The thresholds only ask earlier: `host-pack.ts:162-167`. |
| AC4 priced honestly / re-pin | MET; provenance PARTIAL | Pin `348e5d4` at `tests/scripts/build-exedev-image.test.ts:2107-2116` is correct for HEAD (green). It names both walked inputs, and the walk confirms only those two move. However, the "moved from 285156f" claim is wrong: see AA2-001. |
| AC5 recording-only in code | MET | `host-pack.ts:110` (`false as const`). Consumers are gated at `:391`, `:571` and `:735`. L9 always returns the deterministic order (`l9-repo-sweep-triage.ts:236`). M3, M4 and M9 are red. |
| AC6 binary/choice; never-edit; provenance + record; ceiling per leg | MET | Questions are noul/choice only (`host-pack.ts:287-326`, `l9-...ts:87-101`; M10/M10b red). Each leg has its own ceiling (`host-pack.ts:281`). L9 re-ask dedupe uses a brief digest (`l9-...ts:220-225`). There is an arithmetic control (M6 red). The never-edit list is byte-identical. |
| AC7 per-leg egress, stage-1 bounded | MET | Classes are declared at `host-pack.ts:117-119` and `l9-...ts:58`. `assertMachineState` checks keys and values (`host-pack.ts:340-356`). L8 refuses non-factory authors (`:686-688`). M8 and M14 are red. |
| L9 Cut Boundary Contract | MET | No edges (`l9-cut-boundary.test.ts:59-73`). No L9 string in core (`:75-79`). Deterministic fallback (`:81-95`). The executed cut on a materialised tree is `:97-140` (runs under `bun test`, so CI runs it). I re-verified tsc on the cut tree: exit 0. |
| Trigger: L7 ask per observe tick | PARTIAL (honest limb) | Wired and mock-proven (`host-pack.e2e.test.ts:76`, `fleet-observe-pack.test.ts:78`). In production it is structurally inert today (AA2-002). |
| Trigger: compact member + allowlist | MET | See AC2. |
| Trigger: L8 pre-filter | MET (library; A2 consumes later per the spec row) | `host-pack.ts:672-736`. Misses are never filtered (R1-07). |
| Trigger: pre-dispatch sanity | MET (library-only) | `host-pack.ts:747-767` is provenance-only. Files to Modify lists no dispatch edit, so the callable chain counts as wired. That it is unwired is not recorded in the story (AA2-003). |
| Trigger: L9 triage + opensrc consumer | MET | `l9-...ts:178-245` and `:376-412`. bun.lock is hoisted-only and never `latest`. The walk is bounded (R1-21). |
| Technical Notes guards | MET | One ask per `runId@tickKey` (`host-pack.ts:524,542`). State is capped at `L7_ASK_STATE_MAX_CHARS = 2000`. Ask deadline is 40 s < 60 s onTick (`:127`). The lock is released in `finally` (`:477-485`). Writes go through `appendRecord` / `appendMachineStateRecord` (one shared `appendValidated`, `scripts/corpus/merge.ts:154-184`) and J1's emit. |
| Region ownership | MET (steering.ts region exceeded, register-ratified) | observe.ts is adds-only, and the absent-hook path is unchanged (`observe-ontick.test.ts:220`). fleet.ts is adds-only. steering.ts adds more than member + two entries: an origin guard in `solicit()`, two exports and a tripwire detail suffix (AA2-007). |
| Observability: line fields | MET (L7/L8/sanity); PARTIAL (L9) | `packLine` (`host-pack.ts:430-457`) carries event, requestId, leg, egress_class, armed, answer (post-envelope only), latency_ms and answer_mode. L9 lines lack `answer_mode` (AA2-004). |
| Observability: `would_signal` absent vs false | MET | Not-asked writes no line (`host-pack.test.ts:403`). Misses and state-unchanged lines omit it (`:444,:522,:712`). Answered asks carry a boolean, and false is asserted at `:823`. |
| Observability: record shapes | MET | L8 records are TriageRecords. L7 uses `MachineStateRecordSchema` (`scripts/corpus/schema.ts:85-119`: `state_ref`, closed `compact\|no-compact`, `answer_mode`, strict). Sanity is provenance-only (M15 red). |
| Observability: mock never in measured denominators | MET | ab-report reads top-level `*.jsonl` only (`scripts/judgment/ab-report.ts:120`). L7 writes to `machine-state/<runId>/`, L8 mock to `mock/`, L9 mock to `mock/` (M7 red). The production client is always mock (`packContext` passes no `mode`; `src/judgment/client.ts:100-101`). |
| INV-J-HOSTSIDE / NOGATE / EGRESS / KEY / ARM | MET | No `TYPESAFE_API_KEY` or `process.env` read in src (only in test env controls). Sanity refuses nothing. The never-edit list is clean. |
| Files to Modify, listed | MET | All ten are touched. |
| Files to Modify, extras | MET (justified) | `scripts/corpus/merge.ts`: L7 records need a validated append path, and `appendRecord` is restored to triage-only (R1-17). `scripts/corpus/index.ts`: barrel. `tests/autonomy/fleet-observe-pack.test.ts`: composition-root wiring (R1-16). `tests/fleet/observe-ontick.test.ts`: the seam's own suite, keeping `observe.test.ts` untouched per Infra Prereqs. `tests/scripts/corpus/machine-state.test.ts`: the schema variant. `tests/autonomy/host-pack.e2e.test.ts`: DoD e2e. `build-exedev-image.test.ts`: AC4 re-pin. DD register: required by AC2. |
| DoD Impl | MET | |
| DoD Contract | MET | The A8 drift test lists 5 members. No fourth point. |
| DoD Security | MET | |
| DoD Test (recording-only) | MET | M3 and M4 red. |
| DoD Test (egress) | MET | |
| DoD Test (cut boundary, "in CI") | MET | The executed-cut test runs inside `bun test`. |
| DoD Test (schema) | MET | |
| DoD Ops | MET | Mock is the default, and there is no live probe. |
| DoD e2e (mandatory) | PARTIAL | The L7 mock round is fully met (`host-pack.e2e.test.ts`). The steering limb ("compact validates end-to-end through DF1.11's drain/ack") is now proven at schema level plus refusal-by-origin through drain/ack, because R1-02 removed the only runtime path. That is deliberate and register-recorded, but the story is not amended (AA2-003). |

## Round-1 disposition re-judgment

- **R1-02 (PATCH, refusal by origin): UPHELD.** AC2's letter still holds. The allowlist gains `compact` at exactly `run_start` and `post_gate_failure`, and `run_end` stays proceed-only. The entries are still meaningful as the declared contract for the future host-originated path: they are read through the exported `directiveAllowedAt`, and M1 proves a `run_end` widening goes red. They are dead in today's runtime, though. Nothing outside tests calls `directiveAllowedAt`, and the runtime allowlist check (`steering.ts:1411`) never sees `compact` because the origin guard returns first. This trade-off is right: it restores pre-J4 in-box behavior (parity test), which AC5 needs more than a runtime-live allowlist. The cost is that the DoD e2e steering limb can no longer be met as written. Register item 16 records this, the story does not (AA2-003).
- **R1-03 (DEFER): UPHELD as a deferral; the record is inaccurate.** The limb is recorded only in register 16(c), not in the story, contrary to the triage rationale. 16(c) also understates the gap, see AA2-002. The production L7 leg cannot ask at all today.
- **R1-10 (DISMISS): UPHELD.** The spec pins "spend vs the 8_000 µ$ ceiling, steering iterations vs 3" verbatim, and thresholds-in-code is LOCKED. The ceiling is documented at `host-pack.ts:51-53`.
- **R1-11 (DISMISS): UPHELD.** Register 16(b) names both owed pieces: the host-to-engine directive path and the box-side applier. The unbound `writeSteering` makes an armed flip fail safe (`no-steering-writer` miss, `host-pack.ts:573-574`).
- **R1-18 (DISMISS): UPHELD, with a note.** Given AA2-002, those two box reads per unsettled run per pass currently buy zero asks. The cost is bounded and documented, so this is acceptable until the mid-run refresh lands.
- **R1-22 (DISMISS): UPHELD.** I verified that `packContext` never passes `mode`, and `JudgmentClient` is constructor-mode-only (`src/judgment/client.ts:100-101`). The CLI path cannot go live.
- **R1-12 (PATCH, question name): UPHELD.** Register 16(d) names `manifest_consistent` (noul) as provisional and names no disposition values. That matches the spec's "no invented values" (the ban covers the answer pair or disposition, and none is recorded). The triage's "recorded in Dev Agent Record" did not land (AA2-003).

## Findings

### AA2-001 [MED] The buildId pin provenance misattributes the move: 285156f is not origin/dev's real digest
`tests/scripts/build-exedev-image.test.ts:2108-2116`; register `docs/superpowers/specs/2026-10-02-v6-story-derivation-decisions.md:372-374` (16(a)).
- **Gap:** I extracted origin/dev `5b03a7b7` with `git archive`, indexed it, and ran the pin test. It computes **`b34dc6b…`, not the pinned `285156f`**. J3's CodeRabbit round-3 commit `dac6e6c2` edited `src/fleet/dispatch.ts`, which is in the COPY set and walked, after J3 adopted `285156f`, and nobody re-pinned. So the pin test is red on dev itself. J4's actual move is `b34dc6b → 348e5d4`, by steering.ts + observe.ts (reverting both on HEAD reproduces exactly `b34dc6b`). The new pin value is correct. The comment "moved from 285156f by J4 — TWO walked inputs" and register 16(a) "`285156f` (J3's pin)→`348e5d4`" are false provenance. A future ritual reader would undercount J3's move.
- **Fix:** amend both texts. They should say: `285156f` (J3 adopt) → `b34dc6b` (J3 `dac6e6c2`, `src/fleet/dispatch.ts`, never re-pinned on dev) → `348e5d4` (J4: steering.ts + observe.ts). Optionally flag the dev-red pin to the J3 owner. No code change.

### AA2-002 [MED] Register 16(c) understates R1-03: on a live box the production L7 leg can never ask
`docs/.../v6-story-derivation-decisions.md:380-383`; `scripts/pipeline-run.ts:4585,4744-4752`; `src/fleet/fanout-primitive.ts:791-792`; `src/autonomy/host-pack.ts:645`.
- **Gap:** 16(c) says "L7 sees real spend/iterations only near run end". In fact the only post-seed refresh (`pipeline-run.ts:4752`) runs **after** `run.finish` wrote `journal/final.json`. That file is exactly `boxMarkerPath`, so from that moment observe treats the run as settled and never calls `onTick` for it. Before the marker, the block is the pre-walk seed: spend is roughly the run_start call only, far below 6,000 µ$, and `steeringIterations` is `{}`, giving max 0 against the threshold of 2. RSS and context are null. So `l7ShouldAsk` is false on every real tick, and the hook spends two box reads per pass for zero asks. The DEFER is right (the fix is box-side, outside Files to Modify), but the honest-unproven record must say how big the gap is.
- **Fix:** reword 16(c): "until an engine-side mid-run resident flush lands, the production L7 leg produces zero asks (the post-run_end refresh is written after the terminal marker, when observe no longer ticks the run); L7 is mock-proven end to end only." Mirror this in the story closure note (AA2-003).

### AA2-003 [MED] The story is untouched even though the round-1 dispositions say they would amend it
`_bmad-output/sprint-artifacts/dark-factory-v6/stories/j4-host-side-judgment-pack.md` (not in the diff); `_bmad-output/reviews/j4-round1/triage.json` R1-03 ("recorded in story + DD register") and R1-12 ("recorded in Dev Agent Record").
- **Gap:** the story has no Dev Agent Record and is still `ready-for-dev`. Three things that change how a reader judges acceptance are recorded nowhere in the story: (1) the DoD e2e steering limb is now satisfied as schema validation plus refusal-by-origin, not end-to-end acceptance (R1-02); (2) L7 is inert on live boxes (R1-03 and AA2-002); (3) the sanity leg is library-only with no dispatch caller (R1-12). The register carries (1) and (3) and a weaker form of (2), so the evidence exists, but the triage promised story records that did not land.
- **Fix:** add a Dev Agent Record or closure section to the story. It should point to register 16(a)-(d), state the DoD e2e amendment, and state the L7 and sanity limbs. This can ride the story-closure commit if that is the house pattern (as with Z5 and J1), but it must happen before merge to honor the triage.

### AA2-004 [LOW] L9 lines and records still carry no mock marker (the second half of AA1-002 was not done)
`src/autonomy/l9-repo-sweep-triage.ts:110-113,163-176,184-201`.
- **Gap:** R1-01 fixed the routing: mock writes to `mock/` (M7 red). But the `l9-triage` lines have no `answer_mode`, the record rationale does not name the mode (unlike L8, `host-pack.ts:708`), and the L9 `Judge` has no `mode`. An injected client without `mode` therefore resolves to the measured corpus (`resolveTriageCorpusDir`, `:79-82`). The Observability Contract says "Mock-mode envelopes are marked as such".
- **Fix:** add `mode` to L9's `Judge`. Emit `answer_mode` on every L9 line, and append `answer_mode=<mode>` to the rationale. Treat a missing mode as mock (fail safe) when choosing the corpus dir.

### AA2-005 [LOW] The production composition arm is untested
`scripts/fleet.ts:2267-2268`.
- **Gap:** deleting `deps === undefined ? { onTick: makeL7ObserveHook() }` (M16) leaves every test green. The real `fleet observe --all` would silently lose the L7 leg. R1-16 covered only the injected-deps arm, and FX-C noted the production arm is unexercised.
- **Fix:** add one cheap guard, for example a source assertion in `fleet-observe-pack.test.ts` that the `deps === undefined` arm supplies `makeL7ObserveHook()`. Alternatively, extract a 3-line `observeHookFor(deps)` and unit-test its three arms.

### AA2-006 [LOW] L9's default provenance dir is cwd-relative, while its corpus dir is anchored to the factory root
`src/autonomy/l9-repo-sweep-triage.ts:180` (`new JudgmentClient({ provenanceDir: deps.provenanceDir })` gives J1's relative default, `src/judgment/client.ts:124`).
- **Gap:** the module comment at `:76` claims "Defaults anchor to the factory repo … same rule as the pack core". The pack core anchors provenance (`host-pack.ts:137`); L9 does not. There is no production caller today, so the impact is latent.
- **Fix:** `provenanceDir: deps.provenanceDir ?? join(FACTORY_ROOT, DEFAULT_PROVENANCE_DIR)`.

### AA2-007 [LOW] The steering.ts edit goes beyond the Technical Notes region; ratified, recorded for the reader
`src/phase-engine/steering.ts:168-179,1393-1400`.
- **Gap:** the Technical Notes allow "adds only the union member + two allowlist entries". The branch also inserts a guard into DF1.11's `solicit()` body, two exports, and a tripwire detail with a host-only suffix, which changes the journal row text compared with pre-J4 (the parity test confines the delta to `detail`). Register 16 ratifies the origin enforcement, so this is not a silent amendment.
- **Fix:** none required. Optionally name "solicit() origin guard" explicitly as part of the ratified amendment surface in 16, next to the member and the entries.

## Counts

BLOCKER 0, HIGH 0, MED 3, LOW 4.

**Verdict: APPROVE WITH CHANGES.** All 7 ACs, the cut contract, the observability contract and the security invariants are met. 752/0 focal, tsc and lint are clean. 16 of 17 named negative-control mutations go red. Before merge, fix the three MEDs, which are text-only: the corrected pin provenance (AA2-001), the accurate R1-03 limb (AA2-002) and the story closure record (AA2-003). No code blocker remains.
