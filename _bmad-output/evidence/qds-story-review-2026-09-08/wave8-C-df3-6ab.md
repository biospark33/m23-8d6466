# Wave 8 — Round-3 Convergence Verification, Track C: DF3.6a + DF3.6b

Verifier: independent round-3 convergence pass, 2026-09-13. Branch `feature/wave7-seam-ownership-rework`,
uncommitted spec edits read from disk. No prior wave report, tracker, or seam table consulted.
Every named symbol, path, constant, fixture, and arithmetic claim below was opened at source in
this repo; every "returns nothing" grep carries a positive control.

---

## Verified CORRECT (spot-check of the load-bearing spine; not exhaustive)

**DF3.6a — spend model, meter, and demo arithmetic.**
- Projection arithmetic re-derived from first principles and confirmed exactly: bounds catalog
  (180.0/40.0 USD-per-MTok → 180,000/40,000 µ$/MTok) gives `(16000/4 × 180,000 + 1024 × 40,000)/1e6`
  = **760,960 µ$** per call; the demo's refusal ladder `0 → 760,960 → 1,521,920 → 2,282,880 > 2,000,000`
  is correct; default-catalog projection 504 µ$ (per-term meter rounding: 320 + 184) is correct.
  `PROMPT_CHAR_CEILING = 16_000` (steering.ts:21), `MAX_OUTPUT_TOKENS = 1_024` (:24),
  `SOLICIT_TIMEOUT_MS = 60_000` (:26, exact).
- The rate path the demo depends on is real: `loadBundledCatalog` reads `QDS_PI_CATALOG_DIR`
  (roster/validate.ts:276–310), models.json custom table wins only when it supplies the slug
  (:467), and pointing `QDS_PI_MODELS_JSON` at a nonexistent file empties it — so the bounds
  catalog's rates reach `resolveRate` → `ResidentSpawn.rate` → `deps.rate` → both projection and
  meter. `resolveRate` is called once at arming (resident.ts:410, exact) and handed to the engine;
  `QDS_PI_BIN` → `tests/phase-engine/fixtures/fake-resident.ts` and the `FAKE_RESIDENT_*` env
  passthrough exist in the shipped harness (resident-e2e.test.ts:111,125;
  pipeline-run.test.ts:1628 et al.).
- AC4's negative control is TRUE of shipped code: a reply carrying no usage object meters as zero
  (`rawTokens(undefined) → 0`, meter returns priced 0); a `{0,0}` reply also meters zero; "no
  usage field" is indeed unreachable in production (`ResidentCaller.call` is typed non-optional and
  resident.ts always returns a usage object). The `turnCount === 0` meter-zeroing path is real
  (resident.ts `if (harvest.turnCount === 0) lastExit = "logic";` — returns anyway, usage {0,0}).
- AC3's counter claim is TRUE: `telemetry.steeringIterations` increments only on an accepted
  `retry` at `post_gate_failure` (steering.ts:1073–1075), so a proceed-loop stays at zero. The
  producible trigger is producible: shipped build gate is `test "$n" -ge 2` over
  `$TMPDIR/qds-resident-fixture-count` (pipeline.resident.json:24, survives between runs — the
  false-green the per-invocation counter prevents is real); with `retries: 5`, failing attempts
  1–4 produce exactly four `post_gate_failure` points, the bound fires at the fourth, attempt 5
  passes, and the retry loop exits at `attempt > spec.retries` (pipeline-run.ts:2073).
  `post_gate_failure` is the only in-loop solicitation point (:2088); `run_start` (:3480) and
  `run_end` (:3658) are single sites outside it. `MIN_RETRIES = 0` default and `MAX_RETRIES = 5`
  clamp at manifest.ts:225 (exact); `MAX_RETRIES = 5` at types.ts:31 (exact).
- AC2's `runContextFrom` claims verify verbatim: refuses on declared-vs-admitted disagreement and
  on a stale/unreadable witness; with neither present returns a context with no
  `effectiveCeilingMicros`; the quoted sentence "ABSENCE is still the only thing that leaves the
  field unset" is in the file. `limitMicroUsd` is `.optional()` (manifest.ts:314);
  `PipelineManifestSchema` is `.strict()` at manifest.ts:317 (exact), so a ratio key or an
  un-added bound field is an `unrecognized_keys` rejection.
- AC2a/AC2b mechanics named by the story all exist: the arming try/catch rethrows everything that
  is not the `RateError` arm; the shipped `resident_disabled` warn shape is exactly
  `{level, event, runId, requestId, model, reason, detail}`; `createSteering` is gated on
  `!("disabled" in spawned)` (:3327), so the `onBoundBreach` region is genuinely not constructed
  on the arming path (DF3.6a W6-C-H5 / DF3.6b AC3's premise). `briefIsEmpty → {disabled:true}`
  ships at resident.ts:385.
- Constants and provisioning facts: `defaultKeyCapMicroUsd = 50_000_000` (credentials.ts:80);
  `mintRunKey`'s `deps.capMicroUsd ?? defaultKeyCapMicroUsd` (:294) and the mint refusing caps
  above the backstop (INV-CAP-1, DF2.13 landed — PR #254 in sprint-status); DF2.8 mints
  `min(defaultKeyCapMicroUsd, remainingMicroUsd)`; `DEFAULT_COST_CONFIG.defaultCapMicroUsd =
  5_000_000` over `.sandbox/cost-config.json` (cost-ledger.ts:508/511); DF2.12's `kind='tokens'`
  rows landed and the `ingestCostEvent` zero-caller dead-writer record exists in sprint-status.
- The DoD grep gate is satisfiable with a positive control: no `providers/credentials` import, no
  `providers/cost-ledger` import, no `.sandbox/runs/`, no `.sandbox/cost-config.json` under
  `src/phase-engine/` (control: `bounded-exec` hits exactly the three shipped files at
  command-gate.ts:17, roster/validate.ts:34, phases/test-results.ts:37 — all exact).
- Marker plumbing: terminal marker carries `{ok:false, code, message, remediation}`
  (pipeline-run.ts:1377ff); `fleet status` reports `not-ok` for a settled marker (status.ts:1300,
  exact) and `engine-failed` is the marker-absent state (:91, :1311, exact).
- AC6 arithmetic: frontier projection 4,000×15,000,000 + 1,024×75,000,000 over 1e6 = **136,800 µ$**
  = 17.1× the 8,000 µ$ fallback; on a five-phase `retries: 3` manifest
  `maxSolicitations = 2 + 3×5 = 17`, so `binding` at 8,000 (504×17 = 8,568 > 8,000) and
  `unreachable` at 50,000. The ~16-call and 6,250×-band derivations check out.
- Binding-fact citations: R5 §6 facts 5/7/12 all resolve exactly
  (`_bmad-output/workflow-state/qds-sprint-planning/df-v5/research/R5-dependency-sizing.md` §6 —
  re-aimed :428–429, final-turn-only :436, ratio trap/"Never write the 15% ratio into an AC"
  :462–464); gates report §3.3 + §4 finding 4 (:191, :212–214, :244); derivation decisions §5
  row 4 is the DF3.6 encoding site, DD-9 integer µ$; ADR Appendix B ACCEPTED 2026-09-08 with the
  same-day correction at :185–193; F12 at design §5.2/:533; df2-7's innermost-kill prose (~$0.45)
  at df2-7:132–136 and its `:134` no-edit exemption.

**DF3.6b — kernel seam, fail-closed shape, and tier facts.**
- `"overflow"` is a real `EXIT_STATUSES` member (cli-anything/src/types.ts:99–105) ✓.
- `ResidentSpawn` ships `caller`/`rate`/`exitStatus()`/`stop()` and no pid (resident.ts:116–127,
  exact); child handle closure-local; later calls throw at :474 (exact); signal death sets
  `lastExit = "transient"` and throws in :606–627 (so an unhandled OOM reads `status:"degraded"`
  via the engine call-failure path — AC5's "combination no story owns" is real); `stop()` at
  :681–705; `--no-tools` in the pi spawn argv (:525); key env-borne (:137–141 region).
- The arming-refusal mechanism AC3 names is real and correctly reasoned: the arming catch
  rethrows non-RateError throws; the shipped `resident_disabled` shape exists; `createSteering`
  is never constructed on that path (`!("disabled" in spawned)`); `status:"disabled"` is a member
  of DF3.3's closed `ResidentStatus` set; `qds-run@.service:185` documents the unit cgroup as
  containing the pi child, code phases and team-lead drivers, and the unit carries no `Delegate=`
  today.
- Dockerfile claims: the `RuntimeDirectoryPreserve=yes` positive grep exists (shape match for the
  proposed `Delegate=memory` scan — at :822, not :809); the AC6 env scan (:1024–1040) greps
  `Environment=…QDS_` lines and expects exactly two, which a `Delegate=` line cannot disturb;
  the `systemd-analyze verify` stage exists (:838–863). `deriveBuildId`'s five inputs include the
  systemd unit bytes (driver.ts:395–425 region; definition at scripts/build-exedev-image.ts:614),
  so the rebuild/re-pin requirement is real.
- AC2's scoping exhibit: `dispatch_task` workers are parented in-box under
  `QDS_TEAM_RUNNER=local` (dispatch-task.ts:4, :372–380); the F064 block is at
  worktree.ts:293–299 (exact); DF5.1's ps-sampled ceiling is quoted correctly at
  df5-1:229/:268–269/:352–354 and ADR :185–193 rules the mechanism out for a darwin host.
- Live-tier mechanics: `tier4-resident.live.test.ts` exists, calls `liveGate("2")`, and
  `liveGate` accepts only `"1" | "2"` and throws on `QDS_E2E_TIER=4` (live-harness.ts:65–71);
  L1/L2/L3 legs and the finally teardown discipline exist; the isolated-HOME and
  fixture-catalog setup are real; the `$0.000025 / 2.17 s` in-box solicitation measurement is
  real (tier2-attach-transport/tier5-gate-steering headers, matching the ADR's 2.17 s);
  `tests/fleet/resident.test.ts` has exactly **42** `startResident(` sites.
- Cross-half consistency: the six pipeline-run edits (i)–(vi) are mirrored identically in both
  halves; `lastMemory` lands in DF3.6a's Files item 5 and DF3.6b cites it as such; the
  `residentRssBytes` default constant is DF3.6b's manifest.ts budget in both halves; the
  `exitStatus` writer is delegated by DF3.6a item 3's parenthetical and claimed by DF3.6b inside
  the carve-out; the union widening is single-story; DF3.6a AC5 and DF3.6b AC5 state one
  consistent `"stopped"`-only-when-proximate rule, and the OOM→degraded orphan AC5 closes is
  real (see above). `memory.oom.group=1`, the `|| exit 97` fail-closed wrapper, and the
  no-internal-processes subtree split are internally consistent with the shipped `ResidentSpawnOpts`
  surface (no `residentRssBytes`, no pid today — both to be added, nothing pre-empted).

---

## Findings

### W8-C-1 — DF3.6a — HIGH — C3-structural
**Anchor:** AC2a / Infra Prerequisites ("stamped onto the frozen manifest by DF3.1's dispatch at
fill") / Files to Modify — the three stamped operands have no owned fill-side provisioner.

The story requires `residentSpendCeilingMicros`, `capMicroUsd` and `defaultKeyCapMicroUsd` to be
"carried by value on DF1.1's frozen manifest, each with a named provisioner", refuses the run
(fail-closed) when any is missing, and forbids every in-box default ("the engine reads no host
path"). The provisioners it names are: the ceiling ladder "evaluated once at fill", "DF2.13's
shipped chain", and "stamped from the provider constant" — all attributed to "DF3.1's dispatch at
fill". But DF3.1 is DONE (merged 2026-08-23) and its shipped stamp is `limitMicroUsd` only
(`stampManifestLimit`); nothing in `scripts/fleet.ts` or `src/fleet/dispatch.ts` stamps any of the
three (dispatch uses `capMicroUsd` solely as the mint argument at :1686/:1705; DF2.13's chain is
mint-time, not a manifest stamp), and **DF3.6a's own Files to Modify contains no host-side
dispatch/fill edit** — only engine files, `manifest.ts` schema fields, the in-box runner, tests
and fixtures.

Failure scenario: implement exactly the listed edits. The schema gains the fields, nothing ever
writes them, and every production run that arms a resident — which is every normal dispatch, per
the witness-identity arming test — refuses at manifest load with `bound-config-invalid`. The
mandatory e2e demo still passes because its fixture is hand-authored with the fields, so the
suite is green while the product is un-shippable: precisely the `ingestCostEvent` dead-writer
shape the story itself cites (and Wave 5b H4 fixed once already, for the call site). Fix is small
but must be owned: add the fill-side stamp edit (dispatch, host-side, importing the provider
constant and reading the cost-config ladder) to Files to Modify, or re-home the stamping to a
named open story.

### W8-C-2 — DF3.6b — HIGH — C3-structural
**Anchor:** E2E Slice + DoD "Test (memory bound fires, AC1 — LIVE …)" + DoD "pi baseline RSS
measured" — the make-or-break proof is sited on host-side legs.

The story mandates an **in-box** kernel OOM-kill ("When a run executes in-box and the resident's
pi child allocates past the bound…") and itself rules that "A host-side unit test cannot
substitute — the enforcer is the kernel, and darwin has no cgroups at all." It then places the
proof in `tests/fleet/e2e/tier4-resident.live.test.ts` "as fourth legs beside L1/L2/L3" with
"Setup inherited from the tier: isolated HOME …, `QDS_PI_CATALOG_DIR` at
`tests/phase-engine/fixtures/pi-catalog`". Every existing leg in that file runs
`bun scripts/pipeline-run.ts` **on the operator host** — the file is titled "three HOST-SIDE
pipeline-run legs", its header explains it cannot express in-box execution and that the in-box
front door takes only a runId, and its recorded L2 solicitation measured $0.0004008 on the host.
A fourth leg beside them inherits `runLeg`: `startResident` spawns the (allocator or real) pi
child on darwin, `residentRssBytes` is present, so INV-MEM-2 disables the resident and Leg A
cannot fire; Leg B's "the existing L2 armed leg's first call" has no cgroup and no `memory.peak`
to read. An in-box leg needs the tier2-in-box front door (`fleet run` under `qds-run@`) and,
per the file's own header, a **second dispatch** (the AC6 replay guard refuses a second run on
the settled box) — which contradicts the story's "1 box" cost line and inherited setup. The
sampler note's claim "the e2e demo runs in-box on Linux" is likewise false of every shipped
resident demo file. Fix: re-site the two legs on an in-box dispatch (the tier2-in-box-engine
pattern), name the second dispatch and its cost, and source the baseline `memory.peak` from that
round's control solicitation.

### W8-C-3 — DF3.6b — HIGH — C3-structural
**Anchor:** AC4 + DoD "Test (fail-closed placement, AC4)" vs Files to Modify (the enumerated
six-edit budget, "Nothing else in the file changes") — AC4's typed outcome has no owned edit site.

AC4 requires: wrapper exits 97, "the solicitation is recorded failed with `bound:"rss",
allowed:false, cause:"unenforceable"`", and **"the resident is stopped"**. Under the pair's own
enumerated edits none of that can happen: (a) the record shape matches nothing contracted — the
bounds-check line has no `cause` field and cannot observe a mid-call failure (`checkBounds` runs
before the call; the failure is inside `caller.call`), AC3 explicitly excludes the
`resident_disabled` line to the arming path, and the tripwire union has no member for it; the
story never says who writes the row or where it lands; (b) the stop path is owned by pipeline-run
edit (v), which fires **only on `cause:"watchdog_kill"`**, and by the steering writer, which fires
only when `deps.lastMemory?.()` reports `oomKilled: true` — an exit-97 placement failure is
neither, so the engine's call-failure catch writes the one-way `"degraded"` latch, `stopped`
stays false, and later solicitations keep issuing into the same broken placement. The DoD test
then fails its own story: the journal reads `status:"degraded"`, never "stopped".
Fix: widen edit (v) (or the steering writer's condition) to the unenforceable classification, and
name the record's emitter and destination (e.g. the fleet `warn` chokepoint, harvested via fd-2).

### W8-C-4 — DF3.6a — MEDIUM — C2-semantic
**Anchor:** E2E Slice, "Why a fixture catalog…" — the default-usage equality is false.

"the projection is `(4000 × 80_000 + 1024 × 180_000)/1e6` = **504 µ$** — the same figure the
shipped fixture's default fake-resident usage meters per call". The shipped default is
`{input: 1000, output: 64}` (fake-resident.ts:103), which meters 80 + 12 = **92 µ$** at the
default catalog rates — not 504. The sentence contradicts its own next sentence ("the arithmetic
must hold by construction, not by coincidence of defaults"): there is no coincidence of defaults
to avoid, because the defaults do not match; as written it tells a reader the pin is redundant.
The demo itself is unaffected (it pins `FAKE_RESIDENT_USAGE={"input":4000,"output":1024}` and the
760,960 µ$ arithmetic is exact). Fix: replace the equality with the true one (92 µ$ default vs
504 µ$ pinned — the pin is what makes metered equal projected).

### W8-C-5 — DF3.6a — MEDIUM — C3-structural
**Anchor:** Technical Notes, "DF3.6a is the single owner of the cap chain" (the divergent-copy
list) vs Files to Modify (`credentials.ts — no edit; already corrected by the parent`) and the
Wave 5c record — the story contradicts itself about whether the copies are still live.

The Technical Notes assert, present tense: "the copies **still carrying** the middle term as
`runBudgetCapMicros` are DF2.3 `:123` and `:211`, DF2.4 `:138` and `:145` …, DF2.8 `:201`, DF5.5
`:360`, and the docstring at `src/providers/credentials.ts:46`." Files to Modify says the
opposite of the last item ("no edit; already corrected"), and Wave 5c says a third thing ("no
longer deferred — it is in Files to Modify, scoped to one comment line, with its replacement text
written out"). At source, **every listed site is already corrected**: credentials.ts:63 carries
the corrected `≤` chain and mentions `runBudgetCapMicros` only inside an explicitly-labelled
historical quote ("This docstring previously read …"); df2-3:123 carries the corrected `≤` chain
with the old one inside a "Correction, 2026-09-08" blockquote (:128, :220); df2-4 (:145–161),
df2-8 (:206–207) and df5-5 (:396–402) likewise carry the old chain only as quoted history — and
df5-5 expressly forbids rewriting its quote ("re-applying E would rewrite that copy"). A fixer
following the Technical Notes rewrites four sibling stories' correction notes and a corrected
docstring — churn that destroys the audit trail the quotes exist to keep. Fix: replace the
"still carrying" list with a "corrected on 2026-09-08 at …" record, and reconcile the three
in-story statements.

### W8-C-6 — both — MEDIUM — C1-citation
**Anchor:** many — bulk stale line anchors in the two files that landed dependencies after the
stories were written (steering.ts last touched 2026-09-11 DF2.12; pipeline-run.ts 2026-09-12).

Anchors verified exact elsewhere (status.ts :91/:1300/:1311, resident.ts
:116-127/:410/:474/:681-705, types.ts:31, manifest.ts :225/:317, runner.ts :466/:470,
cli-anything types :99-105, ADR :185-193, df3-3 :237/:625/:632, df5-1, R5 facts) prove the drift
is file-local, not sloppy. Stale at source: steering.ts — createSteering cited `:395` (actual
:404), additive-deps `:398` (:409), zero-usage disposition `:435-436` (:463-465), meter/
clampTerm `:445-457` (:473/:491-508), one-way latch `:820-821` (:943-945), status gate
`:854-857/858` (:977/:981-982, i.e. both halves' SEAM DF3.6 position), steeringIterations
`:944-951` (:1073-1075), snapshot getter `:961-967` (:1085-1091); pipeline-run.ts —
runContextFrom `:797-836` (:814ff), retry exit/GateFailureError `:2044` (:2073),
post_gate_failure `:2059` (:2088), run_start `:3441` (:3480), run_end `:3619` (:3658),
startResident `:3255` (:3290), handle/call site `:3294`/`:3295-3297` (:3328/:3330-3331);
cost-ledger.ts `defaultCapMicroUsd` cited `:442` (actual :497/:508); credentials.ts `deps.capMicroUsd`
cited `:281` (:294); Dockerfile `RuntimeDirectoryPreserve` cited `:809` (:822, both citations in
DF3.6b); dispatch-task.ts cited `:290-298` (actual env anchors :4, :372-380 — the cited range is
the factory docstring). The `+124`-line drift lands readers of `:820-821`/`:854-858` in unrelated
drainInbox code. The repo's own credentials.ts docstring records that stale line citations were
the most common defect of the 2026-09-08 review; this pair now carries ~20 of them. Fix: re-pin
the anchors to the post-DF2.12 files (or convert the hot-file citations to symbol-only, as
credentials.ts:50-54 now recommends of itself).

### W8-C-7 — DF3.6b — LOW — C1-citation
**Anchor:** E2E Slice roster line — "tier4-resident: 1 dispatch key + 1 resident key + 1 box,
≈ $0.10 worst case" and Leg B's "The tier's existing real solicitation (~25 µ$ measured)".

Stale against the tier it builds on: the file mints **one** key (header: "ONE key — the run's
own, cap 50 000 µ$"; the second-mint exhibit was removed, per its L19a/C16 narrative) and prices
itself "≈ $0.05 model + ~1 box-hour"; its own measured L2 solicitation is ~401 µ$, while the
~25 µ$/$0.000025 figure is the **in-box** solicitation measurement recorded in
tier2-attach-transport/tier5-gate-steering. None of this changes an assertion, but an operator
sizing the round from the story undercounts the key story and misattributes the measured cost —
and with W8-C-2's second dispatch the real round is roughly double the box count too.

### W8-C-8 — both — LOW — C2-semantic
**Anchor:** DF3.6a Files item 5 ("the sole `createSteering` call site … passes **only**
`spawned.caller` and `spawned.rate`") and DF3.6b Technical Notes ("passes **exactly**
`spawned.caller` and `spawned.rate` (`scripts/pipeline-run.ts:3295-3297`)").

The call site also passes `emitAttribution: moneyLineTee()` (DF2.12) and `inbox: …` (DF3.4).
The load-bearing conclusion — the engine never receives `ResidentSpawn`, so `lastMemory` had to
become a dep and no pid can cross — survives untouched, but the stated fact is false at source
and a verifier re-deriving the seam from the cited lines finds four deps, not two. Fix: "passes
`spawned.caller`/`spawned.rate` plus two non-fleet sidecars (`emitAttribution`, `inbox`); no
`ResidentSpawn` member crosses."

### W8-C-9 — DF3.6a — LOW — C1-citation
**Anchor:** AC5 — "DF1.10's live rounds measured one degradation in five runs".

Untraceable: no such measurement exists in the df1-10 story, the sprint-status DF1.10 row, or
the v5 specs. The claim only motivates that degradation is routine — which the one-way-latch fact
(shipped, verified) already establishes — but a citation to a measurement that cannot be found is
a citation defect by this campaign's own standard. Fix: cite the actual round artifact or drop the
number.

### W8-C-10 — DF3.6a — LOW — C4-marginal
**Anchor:** AC2 — "a `--no-resident` invocation and **a manifest whose brief is empty** … never
reach `loadResidentBounds`".

The brief is not on the manifest: it is dispatch's in-box carrier in the `run-context.json`
witness beside it (`readResidentBriefSource(resolvedPath, …)`; the arming comment says so in the
same file). The scoping is implementable exactly as intended from `residentArmed`/`noResident` at
the call site, and the story names the right mechanism (`briefIsEmpty`), so no competent
implementer is misled — but the possessive "a manifest whose brief" misstates where the brief
lives, in the same paragraph that correctly insists the manifest is the *only* bound carrier.

### W8-C-11 — DF3.6a — LOW — C4-marginal
**Anchor:** DoD Security — "`grep` over `src/phase-engine/` returns nothing for those four."

Grepping the bare tokens fails on shipped prose: `credentials` hits comment mentions
(roster/validate.ts:620, phase.ts:127, test-results.ts:28) and `cost-ledger` hits
steering.ts:466 and dispatch-task.ts:473; only the import-specifier/path forms
(`providers/credentials`, `providers/cost-ledger`, `.sandbox/runs/`, `.sandbox/cost-config.json`)
return clean, with `bounded-exec` as the positive control. The gate is satisfiable and its intent
obvious; spelling the four patterns would spare the first fixer a false red and a comment rewrite.

### W8-C-12 — DF3.6a — LOW — C4-marginal
**Anchor:** Split Record, HIGHs — "H4 (… default lowered to a **derived** 50,000 µ$,
~99 solicitations, with the derivation written down)".

Superseded in place: Wave 5b B1 re-derived the fallback to **8,000 µ$** and the Technical Notes
ladder now ships 8,000 with the ~16-call derivation, but the Split Record still presents 50,000 /
~99 solicitations as the resolved state. Operative text is correct; the provenance narrative two
screens earlier contradicts it. Fix: one clause noting B1's later re-derivation, as the L3 entry
already models.

---

## Category × severity counts

| Category | HIGH | MEDIUM | LOW | Total |
|----------|------|--------|-----|-------|
| C1-citation   | 0 | 1 (W8-C-6) | 2 (W8-C-7, W8-C-9) | 3 |
| C2-semantic   | 0 | 1 (W8-C-4) | 1 (W8-C-8) | 2 |
| C3-structural | 3 (W8-C-1, W8-C-2, W8-C-3) | 1 (W8-C-5) | 0 | 4 |
| C4-marginal   | 0 | 0 | 3 (W8-C-10, -11, -12) | 3 |
| **Total**     | **3** | **3** | **6** | **12** |

By story: DF3.6a — 7 (1 HIGH, 3 MEDIUM, 3 LOW); DF3.6b — 5 (2 HIGH, 1 MEDIUM, 2 LOW); W8-C-6 and
W8-C-8 are shared.

---

## Convergence verdicts

### DF3.6a — NOT CONVERGED (confidence: high)
The spend model, meter, demo arithmetic, refusal shape, and cross-half edit budget are sound and
verified at source, but W8-C-1 means the fail-closed config chain the story mandates has no
provisioner in its own Files list — landed as written, every real resident-armed run refuses at
load while the hand-authored-fixture suite stays green, the exact false-green class this story
exists to kill; W8-C-4's false figure sits inside its make-or-break slice.

### DF3.6b — NOT CONVERGED (confidence: high)
The kernel seam, fail-closed shapes, and cross-half ownership are correct and verified, but the
make-or-break AC's only named proof site runs on the host the story itself declares incapable of
enforcing the bound (W8-C-2), and AC4's typed outcome cannot be produced by the pair's own closed
edit list (W8-C-3) — the story cannot currently prove itself done by its own gate.
