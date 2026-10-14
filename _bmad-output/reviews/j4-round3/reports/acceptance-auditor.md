# J4 Round 3: Acceptance Auditor (final pre-PR)

Branch `feature/j4-host-side-judgment-pack` at `4aa58295`, base origin/dev `5b03a7b7`. The change is `git diff origin/dev...HEAD` (36 files, +5242/−24). Spec: the story (now with a Dev Agent Record), plus `handoff.md` §3/§8. Prior rounds: `_bmad-output/reviews/j4-round{1,2}/`.

## Evidence runs

All runs used detached scratch worktrees of HEAD and origin/dev, with `node_modules` symlinked. Both were removed afterwards. Nothing tracked in `wt-j4` was edited, and `TYPESAFE_API_KEY` was unset throughout.

- **Focal suites (HEAD):** `bun test tests/autonomy tests/fleet/observe-ontick.test.ts tests/fleet/observe.test.ts tests/phase-engine/steering.test.ts tests/scripts/corpus tests/judgment tests/scripts/build-exedev-image.test.ts` gave **763 pass / 0 fail across 25 files** (`/tmp/j4-aa3.log`).
- **Static gates (HEAD):** `bunx tsc --noEmit` exited 0. `bun run lint` exited 0 (604 files).
- **buildId pin, measured in git worktrees** (the pin test is `skipIf(gitUnavailable)`, so a `git archive` copy silently SKIPs it):
  - On origin/dev, `build-exedev-image.test.ts` gives **249 pass / 1 fail**. The pin test expects `285156f…` and receives **`b34dc6bea782…`**. The claim that dev's own pin test is red is accurate.
  - On HEAD it gives **250 / 0**, with the pin at `4095eff3c2aa…`.
  - On HEAD with only `src/phase-engine/steering.ts` and `src/fleet/observe.ts` reverted to origin/dev, it receives exactly **`b34dc6b…`**. So J4's move is `b34dc6b → 4095eff` over those two walked inputs only.
  - `dac6e6c2` is the last origin/dev commit to touch `src/fleet/dispatch.ts`.
  - The DAR #7 provenance, the test comment and register 16(a) are all **verified true**.
- **Byte-identity vs origin/dev:** `git diff --quiet origin/dev HEAD` is clean for all of these:
  - `src/phase-engine/roster/schema.ts` and `src/phase-engine/phases/roster-adapter.ts`
  - `src/gate/`, `src/providers/`, `src/audit/` and `src/judgment/` (which includes J3's `router.ts` and `index.ts`)
  - `tests/judgment/` and `scripts/judgment/`

  No added or removed line names `AUDIT_HOPS`, `classifyRunExit` or `classifyDiffScope`. `src/fleet/dispatch.ts` (J3) and `scripts/pipeline-run.ts` are not in the diff. In `scripts/corpus/schema.ts`, `observe.ts` and `fleet.ts` the diff removes no lines.

### Negative-control mutations (each applied in the scratch worktree, then reverted)

| # | Bad implementation | Result |
| --- | --- | --- |
| M1 | `run_end` allowlist gains `compact` | RED (1, the directiveAllowedAt test) |
| M1b | `run_start` loses `compact` | RED (1) |
| M2 | Remove the resident-origin refusal in `solicit()` | RED (5) |
| M3 | `PACK_SIGNALS_ARMED = true` | RED (14, including the executed-cut child) |
| M4 | L7 writes the directive while unarmed (drop `PACK_SIGNALS_ARMED &&`) | RED (5: AC5 zero-writes and the e2e) |
| M5 | Lazy `import("../autonomy/host-pack.ts")` in COPYed `src/lib/log.ts` | RED (AC1 fence) |
| M7 | L9 mock records go to the measured corpus | RED (2) |
| M8 | L8 declares `diff-hunk` | RED (4) |
| M9 | Env arming `process.env.QDS_JUDGMENT_PACK_ARMED === "1"` | RED (the literal-false / no-ambient-config test) |
| M10 | L7 `should_compact` becomes a `score` (severity-class) question | RED (6) |
| M12 | `fleet observe --all` drops `...observeTickHookFor(deps)` | RED (1) |
| M13 | An L9 string inside `host-pack.ts` | RED (cut-boundary test) |
| M14 | L9 declares `diff-hunk` | RED (11) |
| M15 | The sanity leg writes a corpus file | RED (the provenance-only test) |
| M16 | Delete the production arm (`deps === undefined → {}`) | **RED (1). This was GREEN in round 2, so AA2-005 is closed.** |
| M17 | The not-asked path logs `would_signal: false` | RED (2: absent-vs-false) |
| M18 | A miss line carries `would_signal: false` | RED (1) |
| M19 | The L7 record's `answer_mode` is hard-coded `"live"` | RED (5) |
| M20 | L8 accepts non-factory (bot) authors | RED (2: the INV-7 fence) |
| M21 | L8 mock records default to the measured corpus | RED (1) |
| M22 | Remove the R2-15 host-only strip from `rejectionDetail` | RED (1) |
| M24 | `assertMachineState` becomes a no-op (prose-bearing state egresses) | RED (2) |
| M25 | `observe.ts` never invokes the pending `onTick` | RED (7) |
| M26 | A fourth steering point is minted (`SteeringPoint` plus `POINT_ALLOWLIST` entry) | RED via `tsc` (TS2345 at `steering.ts:1181`, `BoundsCheckPoint`) and the executed-cut child's tsc. No runtime test catches it, but CI's `check` job does. |

**All 24 named or derived negative controls go red.**

## Per-criterion table

| Criterion | Verdict | Evidence |
| --- | --- | --- |
| AC1 host-side placement structural | MET | The fence BFS is in the `host-pack.test.ts` AC1 block (M5 red). `observe.ts` gains a seam (`:244` `onTick?`) and only a `../providers/timeout.ts` import. The injection is at `scripts/fleet.ts:431-434,2278`. |
| AC2 compact rides the schema only | MET (with DAR #1) | Fifth `.strict()` member at `steering.ts:144`. Allowlist at `:166-167`, with `run_end` proceed-only. `directiveAllowedAt` at `:174`. Origin refusal at `:1404`. Register `docs/superpowers/specs/2026-10-02-v6-story-derivation-decisions.md:363`. The raw-NDJSON, overloaded proceed/retry and run_end controls are in the `steering.test.ts` J4 block. M1, M1b, M2, M22 and M26 are red. |
| AC3 layer over self-compact | MET | The roster files are byte-identical. The hard-cap control is in the `host-pack.test.ts` AC3 block. The hook only reads the journal and asks. |
| AC4 priced honestly / re-pin | MET | Pin `4095eff` at `tests/scripts/build-exedev-image.test.ts:2120`. The provenance is measured correct (see Evidence). The publish/adopt step is named as operator-gated. |
| AC5 recording-only in code | MET | `host-pack.ts:115` (`false as const`). Consumers are gated at `:396`, `:603` and `:778`. L9 always returns `order` (`l9-...ts:278`). M3, M4 and M9 are red. |
| AC6 binary/choice, never-edit, provenance + record, ceiling per leg | MET | Questions are noul/choice (`host-pack.ts:292-330`; M10 red). There are per-leg ceilings (`:286`). The never-edit list is byte-identical. Sanity is provenance-only (M15 red). |
| AC7 per-leg egress, stage-1 bounded | MET | Classes at `host-pack.ts:122-124` and `l9-...ts:60`. M8, M14, M20 and M24 are red. |
| L9 Cut Boundary Contract | MET | `tests/autonomy/l9-cut-boundary.test.ts:61-101`: no edges across src/scripts/tests, no L9 string in the core, deterministic fallback. The executed cut is at `:103+` and runs under plain `bun test` (green in the focal run). M13 is red. |
| Trigger: L7 per observe tick | MET in mock / PARTIAL in production (honest, DAR #3) | The e2e drives the real `observeSweep` → hook → `readBoxFile` chain (`host-pack.e2e.test.ts:76-121`). Production makes zero asks today, which register 16(c) records. |
| Trigger: compact member + allowlist | MET | See AC2. |
| Trigger: L8 pre-filter | MET (library; A2 consumes later) | `host-pack.ts:704-778`. |
| Trigger: pre-dispatch sanity | MET (library, provenance-only; DAR #4) | `host-pack.ts:790-810`. |
| Trigger: L9 + opensrc consumer | MET | `l9-...ts:186-280` and `:376-450`. Lockfile-resolved, never `latest`. See AA3-002 for the cwd default. |
| Technical Notes guards | MET | One ask per `runId@tickKey`, plus a state-unchanged skip within the same `answer_mode`. `L7_ASK_STATE_MAX_CHARS = 2000`. The read deadline (10 s) plus the ask deadline (40 s) fit inside the 60 s `ON_TICK_DEADLINE_MS`. Writes go through `appendRecord` / `appendMachineStateRecord` (shared `appendValidated`, `merge.ts:154-184`) and J1's emit. |
| Region ownership | MET (steering.ts region exceeded, register-ratified) | `observe.ts` and `fleet.ts` are adds-only. `steering.ts` adds the origin guard, two exports and the R2-15 detail strip; register 16 now names the `solicit()` origin guard (AA2-007 closed in substance). `steering.test.ts` rewrites one existing comment (`:106-109`) to list five members. It is comment-only and immaterial. |
| Observability: line fields | MET | `packLine` (`host-pack.ts:452-478`) emits event, requestId, leg, egress_class, armed, `answer` (post-envelope only), latency_ms and answer_mode. L9 lines carry answer_mode too (`l9-...ts:193-208`; AA2-004 line half closed). |
| Observability: `would_signal` absent vs false | MET | Not-asked writes no line. Misses and skips omit `would_signal`. Answered asks carry a boolean. M17 and M18 are red. |
| Observability: record shapes | MET | L8 and L9 records are TriageRecords. L7 uses `MachineStateRecordSchema` (`scripts/corpus/schema.ts:88-106`: `state_ref`, closed `compact\|no-compact`, `answer_mode`). Sanity writes no record. |
| Observability: mock never in measured denominators | MET | ab-report reads top-level `*.jsonl` only. L7 writes per-run shards under `machine-state/<runId>/` (never top-level, in either mode). L8 mock goes to `mock/` (M21 red). L9 sends any non-`live` mode to `mock/` (M7 red). The production client is mock-only. |
| INV-J-HOSTSIDE / NOGATE / EGRESS / KEY / ARM | MET | No `TYPESAFE_API_KEY`, `process.env` or `QDS_LIVE_PROBE` is added in src or scripts. Sanity refuses nothing. The ambient-config scan is in the AC5 test (M9 red). |
| Files to Modify, listed | MET | All ten are touched. |
| Files to Modify, extras | MET (justified) | `scripts/corpus/merge.ts` and `index.ts` are DAR #2. These test files are needed by the seam, schema, DoD e2e and composition root: `fleet-observe-pack.test.ts`, `observe-ontick.test.ts`, `machine-state.test.ts`, `host-pack.e2e.test.ts`. `build-exedev-image.test.ts` is AC4 / DAR #7. The DD register entry is required by AC2. The story DAR and review artifacts are process files. The DAR names the source extras; the test extras are implied by the ACs. |
| DoD Impl | MET | |
| DoD Contract | MET | The A8 drift test lists 5 members. A fourth point fails tsc (M26). |
| DoD Security | MET | |
| DoD Test (recording-only) | MET | M3 and M4 are red. |
| DoD Test (egress) | MET | M8, M14, M20 and M24 are red. |
| DoD Test (cut boundary, in CI) | MET | The executed cut runs inside `bun test`. |
| DoD Test (schema) | MET | |
| DoD Ops | MET | Mock is the default. There is no live probe, and no key was set. |
| DoD e2e (mandatory) | MET as amended (DAR #1) | The L7 mock round is fully met. The steering limb is proven as schema-validation, plus the drain/ack inbox carrying it as context, plus refusal by origin (`steering.test.ts` "end-to-end through the drain/ack inbox"). The story now records this amendment honestly. |

## Round-2 findings: resolution check

| ID | Status | Evidence |
| --- | --- | --- |
| AA2-001 (pin provenance) | **RESOLVED** | Test comment `build-exedev-image.test.ts:2108-2119`, register 16(a) and DAR #7 all state `285156f` stale → dev real `b34dc6b` → J4 `4095eff`. Measured true. |
| AA2-002 (16(c) understated) | **RESOLVED** (the text; the code gap stays DEFER) | Register 16(c) and DAR #3 now say "in production L7 makes ZERO asks today". |
| AA2-003 (story untouched) | **RESOLVED** | The story status is `in-review`, and the DAR records deviations 1-7 and the round counts. |
| AA2-004 (L9 mock marker) | **MOSTLY RESOLVED** | Lines carry `answer_mode`. A missing mode is treated as mock (`resolveTriageCorpusDir`), and `Judge.mode` is required. The record rationale still has no mode (AA3-003). |
| AA2-005 (production arm untested) | **RESOLVED** | `observeTickHookFor` is tested. M16 is now red. |
| AA2-006 (L9 provenance cwd) | **RESOLVED** | `resolveProvenanceDir` anchors to FACTORY_ROOT (`l9-...ts:83-85`). |
| AA2-007 (steering region) | **RESOLVED in substance** (triaged DISMISS) | Register 16 explicitly names the `solicit()` origin enforcement and its detail. |

Triage counts match the DAR. R1 has 25 unified findings (3 HIGH / 13 MED / 9 LOW), with 20 PATCH, 4 DISMISS and 1 DEFER. R2 has 20 (7 MED / 13 LOW), with 17 PATCH, 2 DISMISS and 1 DEFER.

## DAR deviation judgments

1. **Resident-originated `compact` refused by origin: ACCEPTED.** AC2's letter holds: the member, the two entries, `run_end` proceed-only and no fourth point. The origin guard restores pre-J4 in-box behavior (parity test), which LOCKED #5 needs more than a runtime-live allowlist. Register 16 ratifies it. The DoD e2e steering limb is honestly re-scoped.
2. **`merge.ts` + `index.ts` touched: ACCEPTED.** It is unavoidable, because `appendRecord` hard-codes the triage schema. `appendRecord` stays triage-only with dev-identical behavior. The diff removes and re-adds lines in `merge.ts` (a refactor into `appendValidated`), so this is not strictly adds-only. That is acceptable because `merge.ts` is not a sibling-owned closed surface.
3. **Honest-unproven limb widened: ACCEPTED as DEFER.** The fix is box-side engine work, outside Files to Modify. It is recorded accurately in DAR #3 and register 16(c). The PR description must lead with it (see verdict).
4. **Sanity is provenance-only with a provisional `manifest_consistent` noul: ACCEPTED.** It names no disposition values, which matches "no invented values". Files to Modify lists no dispatch call site.
5. **Mock routing by directory: ACCEPTED.** M7 and M21 are red. One caveat: "Pack defaults anchor to the factory repo root, never cwd" is not true of L9's opensrc lockfile default (AA3-002).
6. **Observe seam additions (deadline, budget skip, post-lock hook): ACCEPTED.** These are bounded, fault-isolated and adds-only. The absent-hook path is unchanged (`observe.test.ts` untouched and green). M25 is red.
7. **buildId re-pin from dev's real digest: ACCEPTED and verified by measurement** (see Evidence). Flag the dev-red pin to the J3 owner. J4's merge incidentally restores it.

## Findings

### AA3-001 [LOW] The pin comment refers to "the literal above (285156f)", but that literal no longer exists
`tests/scripts/build-exedev-image.test.ts:2109-2110`.
- **Gap:** this commit replaced the `285156f` literal. The comment block above it is J3's adoption note, which has no hash. So "the literal above" points at nothing. The provenance itself is correct.
- **Fix:** change it to "the prior literal (285156f, J3's adopt)". It is optional and text-only. Note that editing the test file does not move the digest, because tests/ is not walked.

### AA3-002 [LOW] L9's opensrc lockfile default is cwd-relative, which contradicts DAR #5's "never cwd"
`src/autonomy/l9-repo-sweep-triage.ts:410` (`join(process.cwd(), "bun.lock")`).
- **Gap:** DAR #5 says pack defaults anchor to the factory root and never to cwd. The corpus and provenance defaults in L9 do anchor. The lockfile default does not. Run from another cwd, it either misses (`lockfile-unreadable` / `package-not-locked`, which is fail-safe) or resolves another repo's lock. Spec intent ("the repo's own lockfile") is arguably the swept repo, so cwd may be deliberate. There is no production caller.
- **Fix:** either anchor it to `FACTORY_ROOT`, or narrow DAR #5's wording to "corpus/provenance defaults" and document the lockfile default as the swept repo's.

### AA3-003 [LOW] L9 corpus records carry no in-record mode marker (the residual of AA2-004)
`src/autonomy/l9-repo-sweep-triage.ts:168-180` (`rationale` has no `answer_mode=`; L8's does, at `host-pack.ts:751`).
- **Gap:** only the directory (`mock/`) marks mode, so a record copied or merged out of `mock/` loses its provenance. Lines and routing are fixed, and `TriageRecordSchema` is intentionally untouched.
- **Fix:** append `; answer_mode=${answerMode}` to the L9 rationale, matching L8. It is optional, because it does not affect any denominator today.

## Counts

BLOCKER 0, HIGH 0, MED 0, LOW 3.

**Verdict: APPROVE.** All 7 ACs, the L9 cut contract, the in-scope trigger rows, the Technical Notes guards, the observability contract, the security invariants and all 9 DoD bullets are MET, and the DoD e2e is met as amended by the DAR. AA2-001 to AA2-007 are resolved (AA2-004 has a LOW residual). The 7 DAR deviations are each justified and accurately recorded. The pin provenance is verified by measurement. The never-edit, roster and J3 surfaces are byte-identical. Results: 763/0 focal tests, tsc and lint clean, and 24 of 24 negative-control mutations red.

**PR-ready: YES.** The three LOWs are optional, text-or-one-line fixes. The PR description must state, up front, that L7 makes zero production asks today (DAR #3, register 16(c)). It must also say the image publish/adopt is operator-gated (wave-0 ritual, with J3), and that origin/dev's pin test is currently red and this PR restores it. Per the repo rules, the PR targets `dev` and is created by `biospark33`.
