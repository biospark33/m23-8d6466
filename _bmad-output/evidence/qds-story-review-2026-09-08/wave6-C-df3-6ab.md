# Wave 6 — round-3 independent verification: DF3.6a + DF3.6b

**Verifier:** w6-C (fresh eyes, no prior-round reports read)
**Branch:** `feature/qds-story-review-remaining-v5-stories` @ `c72064f6`
**Scope:** `df3-6a-resident-spend-iteration-bounds.md`, `df3-6b-resident-memory-bound-cgroup.md`
**Method:** every seam opened in this repo; every number re-derived from first principles against
shipped constants and shipped fixtures. Citations below are by symbol/anchor.

**Verdict: NOT CONVERGED.** 4 BLOCKER / 5 HIGH / 6 MEDIUM / 2 LOW, and the BLOCKER population is
predominantly **C3-structural** or **C2-semantic**, not another wrong number. The spend ceiling's
third derivation is **still wrong**, and wrong in the same category as the two it replaced.

---

## What was verified CORRECT (so a fourth round does not re-audit it)

Every one of these was opened and read; all hold:

- `steering.ts`: `PROMPT_CHAR_CEILING`/`MAX_OUTPUT_TOKENS`/`SOLICIT_TIMEOUT_MS` (`:21,:24,:26`);
  `ResidentTripwire` shape and the closed `cause` literal (`:196-202`, `:199`); `ResidentTelemetry`
  closed key set (`:204-219`); the one-way `"degraded"` latch (`:820-821`); the status gate and the
  `SEAM DF3.6` comment immediately after it (`:854-858`); the snapshot-only telemetry getter
  (`:961-967`); the zero-usage disposition docstring (`:435-436`) and `meter`/`clampTerm`
  (`:445-457`).
- **AC3's premise is true**: `telemetry.steeringIterations` increments only on an accepted `retry`
  at `post_gate_failure` (`steering.ts:944-951`) and stays at zero for a proceed-loop.
- **AC3's producible trigger really is producible.** `pipeline-run.ts:2044`
  (`attempt > spec.retries`), `manifest.ts:225` (`retries` default `MIN_RETRIES`=0, clamped to
  `MAX_RETRIES`=5, `types.ts:30-31`), `run_start`/`run_end` at `:3441`/`:3619` outside the phase
  loop and `post_gate_failure` at `:2059` inside it — all exactly as claimed. The shipped fixture's
  fixed `$TMPDIR/qds-resident-fixture-count` really does survive between runs
  (`tests/phase-engine/fixtures/pipeline.resident.json`), so the per-invocation counter warning is
  a real defect caught, not a decoration.
- **Wave-5b's B2 reversal is right**: `steering.ts:11-13` is engine↛**fleet**, and three shipped
  engine files import `../../providers/bounded-exec.ts` at exactly `gates/command-gate.ts:17`,
  `roster/validate.ts:34`, `phases/test-results.ts:37`. A blanket "no provider import" grep could
  never pass; the four-named-modules gate is the right one.
- **Wave-5b's B3 reversal is right**: `runContextFrom` (`pipeline-run.ts:797-837`) refuses on
  disagreement and on a stale witness but returns a ceiling-less context on absence **when no
  witness is present** — the story's qualifier is accurate.
- `fleet status`: `not-ok` for a settled non-ok marker (`status.ts:1300`), `engine-failed` only for
  a missing marker (`:91`, `:1311`), `InBoxState` at `:1119`. H2's fix holds.
- `"overflow"` is a real `EXIT_STATUSES` member (`cli-anything/src/types.ts:99-105`) — exact.
- `worktree.ts:293-299` is the F064 block, exact; `dispatch-task.ts:290-298` is the
  `QDS_TEAM_RUNNER=local` refusal, exact.
- **DF3.6b's mechanism is sound and its image ritual is real.** `qds-run@.service`'s `KillMode`
  paragraph (`:183-193`, cited `:185`) does document the unit cgroup holding the pi child, `code`
  phases and team-lead drivers. `Delegate=` carries no `QDS_`, so DF2.10's AC6 env scan
  (`Dockerfile:1024-1040`) is genuinely unaffected, and the `RuntimeDirectoryPreserve=yes` assertion
  at `Dockerfile:809` is the exact shape the new grep would copy. `deriveBuildId` does hash the unit
  (`driver.ts` docstring at `:391-430`), so the re-pin requirement is correct.
- **The delegated-subtree split is feasible**, which the ADR only assumed: `ExecStart` is
  `/usr/local/bin/qds-engine`, a two-line `#!/bin/sh` + `exec` wrapper (`Dockerfile:420`), so the
  unit cgroup holds exactly one process at arming and the `+memory` enable will not hit `EBUSY`.
- `liveGate("2")` at `tests/fleet/e2e/tier4-resident.live.test.ts:454`, and `liveGate` accepts only
  `"1"|"2"` (`tests/fleet/e2e/live-harness.ts:65-79`) — the tier-label-vs-env-value distinction is
  correct.
- **Security sweep clean, self-proved.** `grep -nE "sk-or-|sk-[A-Za-z0-9_-]{8,}"` returns zero on
  both stories; positive control `grep -c resident` returns 106 and 100 on the same files. One
  secret per box, no push credential in-box, env-borne key (`resident.ts:137-141`, `:424`, `:537`)
  and INV-MEM-3's positional argv are all preserved, not simplified away.

---

## BLOCKERs

### W6-C-B1 — the third derivation still equates *metered* spend with *projected* spend
**Severity:** BLOCKER **Category:** `C2-semantic`
**Story/anchor:** DF3.6a, Technical Notes → "The bounds this story owns", derivation steps 3–4.

**Evidence.** The engine meters **actual** provider usage: `meter(reply.usage)` is called after the
call and sums `Math.round(tokens × rate / 1e6)` (`src/phase-engine/steering.ts`, `meter`). The
refusal predicate the story specifies is `spent + projected > effectiveCeiling`, where `spent` is
that metered cumulative and `projected` is the fixed worst case. The derivation instead computes
cumulative spend as `N × 504` — i.e. it charges every call its **projection**.

**Failure scenario.** Take the story's own numbers plus the repo's own fixture. The shipped fake pi
defaults to `{input:1000, output:64}` (`tests/phase-engine/fixtures/fake-resident.ts`,
`scriptedUsage`), which at 0.08/0.18 USD/MTok meters `round(1000×80_000/1e6) +
round(64×180_000/1e6)` = **92 µ$**, against a 504 µ$ projection. The 8,000 µ$ ceiling then binds at
`92N + 504 > 8000` → **N = 82 calls**, not 16. Under this story's own iteration bound (`2 + 3P`)
that needs **P ≥ 27 phases, every one failing its gate three times** — the exact sentence the story
writes about the *previous* wrong default ("no such manifest exists"). Even assuming production
usage 4× the fixture's, the trip lands at N ≈ 21 → P ≥ 7. AC1's unit test still passes, because it
*seeds* `spent` at `ceiling − ε`; the bound is green in CI and dead in production.

**Fix direction.** Pick one and state it: (a) charge each call `max(projected, metered)` — then the
`N × 504` arithmetic is true by construction and the derivation stands as written; or (b) keep the
honest meter and re-derive the binding call count from a **measured** metered-per-call figure (the
live round DF3.6b already pays for can read it for free), and state the predicate's two operands
explicitly so no reader re-conflates them.

### W6-C-B2 — the mandatory e2e demo cannot reach its own asserted refusal
**Severity:** BLOCKER **Category:** `C2-semantic`
**Story/anchor:** DF3.6a, E2E Slice; DoD "Test (e2e demo — MANDATORY)".

**Evidence.** The slice asserts `spent + 760,960 = 1,521,920` after one call — i.e. metered spend
equals the projection exactly. That holds only if the fake pi reports usage `{4000, 1024}`
(= `PROMPT_CHAR_CEILING/4`, `MAX_OUTPUT_TOKENS`). `fake-resident.ts` defaults to `{1000, 64}` →
182,560 µ$ metered per call at the fixture's 180.0/40.0 rates. The refusal then falls at **call 8**,
while the demo manifest can produce at most **5** solicitation points (run_start + three bounded
`post_gate_failure` + run_end). The story also never names `QDS_PI_BIN` or
`QDS_RESIDENT_ENV_PASSTHROUGH`, which the existing demo harness requires
(`tests/phase-engine/resident-e2e.test.ts`, `spawnRunner`) — so as literally written the demo
spawns **real pi** against a fabricated $180/MTok price table.

**Failure scenario.** The dev runs the mandatory demo, it goes green with no refusal (or red on the
tripwire assertion), and the obvious repair is to compare *metered* spend after the call — which is
precisely the implementation AC1's negative control says MUST fail.

**Fix direction.** Name `FAKE_RESIDENT_USAGE={"input":4000,"output":1024}` in the slice, and state
that the demo inherits `spawnRunner`'s env (`QDS_PI_BIN` → `fake-resident.ts`, the passthrough
list, `QDS_PI_MODELS_JSON` pointed at a non-existent file).

### W6-C-B3 — the 504 µ$ per-call figure is a *test fixture* price, presented as "shipped rates"
**Severity:** BLOCKER **Category:** `C2-semantic`
**Story/anchor:** DF3.6a, Technical Notes derivation step 1; E2E Slice "Why a fixture catalog".

**Evidence.** The derivation anchors on
`tests/phase-engine/fixtures/pi-catalog/openrouter.json` (0.08 / 0.18 USD per MTok) and calls those
"the resident slug's **shipped** rates". They are not. In-box, `QDS_PI_CATALOG_DIR` points at the
image-staged **pi bundled catalog** — `/out/pi-catalog` copied from
`/tmp/package/dist/providers/data/*.json`, asserted at build time to hold **more than 10** provider
files (`oci/exedev/Dockerfile:163-170`, `:798-803`) — a completely different file set from the
one-model fixture. And `tests/fleet/e2e/tier4-resident.live.test.ts:480` states plainly that the
resident slug "**resolves only through that custom registry**" (the operator's
`~/.pi/agent/models.json`, `defaultCustomRegistryPath()`), which the live legs copy into an isolated
HOME. So the price the production in-box engine resolves is either an operator-private registry or
nothing at all — never the fixture.

**Failure scenario.** Two live ones, on the same absolute default: at a realistic flash price
(~$0.27 / $1.10 per MTok) the projection is ≈ **2,206 µ$**, and 8,000 µ$ binds at **call 4** — the
ceiling fires on a healthy five-call run and demotes tier 2 every time. Above roughly $1.3 / $2.9
per MTok the projection exceeds the ceiling outright, AC6 returns `below_one_call`, and the resident
is refused at `run_start` on **every** run. An absolute µ$ default calibrated to one un-shipped price
table is the mirror image of the ratio trap the gates report banned.

**Fix direction.** Derive against the rate the in-box engine actually resolves, or make the default
a multiple of `deps.rate`'s projection (`ceiling = k × projectedPerCall`, `k` derived from
`2 + 3P`). That is roster-independent, is *not* the forbidden 15%-of-run-total ratio (the
denominator is a per-call constant, not a moving run total), and makes AC6's `below_one_call` arm
structurally unreachable instead of a live production hazard.

### W6-C-B4 — DF3.6b's make-or-break AC has no producible trigger
**Severity:** BLOCKER **Category:** `C3-structural`
**Story/anchor:** DF3.6b, AC1 and DoD "Test (memory bound fires, AC1 — LIVE, roster tier 4)".

**Evidence.** pi is spawned `--no-tools` (`src/fleet/resident.ts`, the `Bun.spawn` argv list), the
prompt is the engine's only lever on it, and the reply is bounded at 1,024 output tokens. Nothing in
the story, the ADR or the probe says how a real pi child is driven to allocate past a bound the same
story requires to be set at **≥ 2× a measured baseline**. The one alternative — a bound below
baseline — is explicitly rejected by the story's own falsifier ("proves the cgroup is *attached*
rather than that the allocation *crossed* it"). The spend line ("the marginal cost is one extra
solicitation, ~25 µ$") asserts the leg is a real pi solicitation, which rules out substituting a
synthetic allocator binary.

**Failure scenario.** The live round runs, no OOM occurs, `memory.events`' `oom_kill` reads 0, and
the DoD's own falsifier fires — with no way to distinguish "the bound was never crossed" from "the
bound is not attached". The story is then un-shippable by its own gate. This is exactly the class
DF3.6a's AC3 already fixed for the iteration bound ("Producible trigger — the bound must fire, not
merely exist"); DF3.6b never got one.

**Fix direction.** Name the lever. The honest one: install a synthetic allocator as the leg's
`QDS_PI_BIN` on the box — it proves precisely what AC1 claims (the kernel kills a cgroup the engine
never signals, with the engine's code not running) at **zero** marginal spend — and keep a second,
cheap real-pi leg that asserts only that a normal solicitation stays under the bound and that
`memory.peak`/`memory.events` are read and the leaf removed. Say which leg proves which clause.

---

## HIGHs

### W6-C-H1 — AC4 targets an input the shipped caller can never produce
**Severity:** HIGH **Category:** `C2-semantic` **Story/anchor:** DF3.6a AC4 / INV-BND-3.

`harvestPiStream` initialises totals to `{inputTokens: 0, outputTokens: 0}`
(`cli-anything/scripts/team-lead-driver.ts:209-210`) and skips any turn whose usage will not parse;
`src/fleet/resident.ts`'s `call` always returns `usage: { inputTokens, outputTokens }` as numbers.
Even the DF3.3 test harness normalises (`tests/phase-engine/steering.test.ts:64`,
`usage: step.usage ?? { inputTokens: 0, outputTokens: 0 }`). So "a reply carrying no usage field" is
**unreachable** through production. The reachable meter-zeroing path is `usage {0, 0}` — a pi reply
with no harvestable `message_end`, which `resident.ts` already detects
(`if (harvest.turnCount === 0) lastExit = "logic"`) and then returns anyway, metering **zero**.

**Failure scenario.** AC4 is implemented literally (`usage === undefined ? projected : metered`), the
test passes against an injected caller, and the actual "resident zeros its own meter" path stays
wide open — the credential-adjacent defect INV-BND-3 exists to close.
**Fix:** charge the projection whenever a reply yields **no positive usage** (or `turnCount === 0`),
not only when the object is absent; add a `{0,0}` negative control.

### W6-C-H2 — the fail-closed refusal is unscoped, and nobody provisions the fields it requires
**Severity:** HIGH **Category:** `C3-structural` **Story/anchor:** DF3.6a AC2a/AC2b, INV-BND-2,
Files to Modify (`scripts/pipeline-run.ts` edit (i)).

`loadResidentBounds(manifest)` is specified to run "at manifest load, before the `startResident`
call site (`:3255`)" and to **refuse the run** when any of `residentSpendCeilingMicros`,
`capMicroUsd`, `defaultKeyCapMicroUsd`, `residentRssBytes` or `limitMicroUsd` is missing. Manifest
load happens for **every** run, including `--no-resident` runs and runs with an empty brief
(`briefIsEmpty` → `{disabled:true}`, `resident.ts`). Nothing in either half says who writes the
three *bound* fields onto a production manifest: DF3.1's stamping is named only for `capMicroUsd`,
`defaultKeyCapMicroUsd` and `limitMicroUsd`. AC2b simultaneously justifies `limitMicroUsd` being
`.optional()` ("a hand-authored `pipeline.yaml` may legitimately omit it") **and** refuses the run
when it is omitted.

**Failure scenario.** After merge, every manifest in the repo refuses: `pipeline.qds-factory.json`,
`pipeline.resident.json`, `.sandbox/fake-boxes/qds-20260826-d9052a/pipeline.yaml`, every inline
manifest in the suite, and every DF3.3/DF1.10/DF1.11 live round — for runs that arm no resident at
all. A *resident* bound has failed the whole run, which INV-BND-5's own first clause forbids.
**Fix:** scope the refusal to runs that arm a resident, and name the provisioner (schema default vs
DF3.1 stamp) for each of the three bound fields.

### W6-C-H3 — the "worst-case projection" is not a worst case, so AC1's third clause is false
**Severity:** HIGH **Category:** `C2-semantic` **Story/anchor:** DF3.6a AC1 ("recorded resident
spend never exceeds the ceiling at any point in the journal"), Technical Notes "Pre-flight
projection".

Both projection terms are soft. `PROMPT_CHAR_CEILING/4` is a chars→tokens heuristic — dense JSON,
base64 or CJK context tokenises well above chars/4 — and `MAX_OUTPUT_TOKENS` is **not enforced**:
`steering.ts:22-23` says in terms, "pi 0.55.x has no CLI flag for this — enforced via the prompt
instruction". A model that ignores the instruction meters above its projection.

**Failure scenario.** One over-long reply carries metered spend past the ceiling, and the journal
assertion AC1 makes ("never exceeds ... at any point") is false on a run where the engine behaved
exactly as specified. The Deviation/assumption bullet records only the *rate* mismatch, not the two
soft token ceilings.
**Fix:** either weaken AC1's clause to "never exceeds `ceiling + one projected call`" and record the
soft ceilings in the deviation, or clamp each call's metered charge at its projection.

### W6-C-H4 — the 512 MiB default is owned by DF3.6a and re-derived by DF3.6b, which ships after it
**Severity:** HIGH **Category:** `C3-structural` (split integrity) **Story/anchor:** DF3.6a
Technical Notes ("`residentRssBytes` = **512 MiB**"); DF3.6b E2E Slice + DoD "Test (pi baseline RSS
measured)".

DF3.6a states 512 MiB flatly as a settled default and owns the schema surface it lives on
(`src/phase-engine/manifest.ts` — "all three bound fields"). DF3.6b flags the same number
provisional, makes the measurement that would move it a live DoD item, and says the default "must be
re-set before this story ships" — but `manifest.ts` is **not** in DF3.6b's Files to Modify, and
DF3.6b is sequenced *after* DF3.6a has merged.

**Failure scenario.** The live baseline comes back at ≥ 256 MiB. The value that must change lives in
the merged half; the half holding the measurement has no file budget to change it; the re-set lands
as an unowned drive-by, which is the pattern this campaign has already ruled against (code follow-ups
are planned stories).
**Fix:** either move the default and its fixture into DF3.6b's ownership, or mark DF3.6a's default
explicitly provisional-pending-DF3.6b and add `src/phase-engine/manifest.ts` to DF3.6b's Files to
Modify, scoped to that one constant.

### W6-C-H5 — AC3's arming refusal has no owned edit site and lands as an unclassified crash
**Severity:** HIGH **Category:** `C3-structural` **Story/anchor:** DF3.6b AC3; Files to Modify
`scripts/pipeline-run.ts` edit (v).

For "unenforceable ⇒ resident not started" to produce the shipped `resident_disabled` /
`rss_unenforceable` line, the new failure has to be classified in the runner's arming `try/catch`,
whose current arm rethrows everything that is not `RateError` (`scripts/pipeline-run.ts:3263-3271`) —
tracer closed, exception out, **no terminal marker**. DF3.6b instead bundles that emission into "the
`onBoundBreach` handler arm", a different code region reached only from inside a live steering
controller, which on this path is never constructed (`:3292` gates `createSteering` on
`!("disabled" in spawned)`).

**Failure scenario.** A box boots the previously pinned image (no `Delegate=`), the cgroup cannot be
created, and instead of a disabled resident and a deterministic run the operator gets an
unclassified throw and a marker-absent box — `fleet status: engine-failed` — which is the exact
outcome DF3.6a's own AC2b negative control names as forbidden.
**Fix:** enumerate the catch-arm edit (a new error class handled beside `RateError`), or specify that
`startResident` returns a disabled shape carrying `reason:"rss_unenforceable"` and that the runner
emits the line from the existing `{disabled:true}` branch.

---

## MEDIUMs

### W6-C-M1 — `boundsPolicy` is used once and never defined
**Category:** `C3-structural`. DF3.6a AC2a says "a manifest whose stamped `boundsPolicy`
violates …"; every other reference in both stories treats the five values as flat manifest fields.
`PipelineManifestSchema` is `.strict()` (`manifest.ts:317`), so the shape is load-bearing — it
decides whether existing manifests parse and it is the one thing crossing the split seam (DF3.6b
reads `residentRssBytes` "from the manifest"). Name the shape once, in DF3.6a, and have DF3.6b cite
it.

### W6-C-M2 — the two halves disagree about the shared `scripts/pipeline-run.ts` budget
**Category:** `C1-citation` / split integrity. DF3.6a says "**two** edits, both closed … No other
change", and its parenthetical says DF3.6b adds "a **third** edit … and rebases onto these two".
DF3.6b states **five** edits across the pair, three of them its own — (iii) `residentRssBytes` at
`:3255`, (iv) `lastMemory` at the `createSteering` call, (v) the `onBoundBreach`/arming-refusal arm.
Wave 5b's V-CC-C2 fix ("edit totals stated across the pair, not per-half") landed in DF3.6b only. A
reviewer holding DF3.6a's "No other change" rejects DF3.6b's (iv) and (v).

### W6-C-M3 — a stale number survived the third re-derivation
**Category:** `C1-citation`. DF3.6a's final Technical Notes bullet still reads "The run-key cap
(1,000× the 50,000 µ$ ceiling) is the backstop". The ceiling is 8,000 µ$ and the story states the
band as 6,250× three paragraphs earlier. 50,000 µ$ was the *second* wrong default.

### W6-C-M4 — `sprint-status.yaml` omits DF2.13 from DF3.6a's deps
**Category:** `C3-structural` (artifact consistency). The story's Dependency edges name **DF2.13**
("it supplies `capMicroUsd`, the **middle term** of the ordering invariant this story asserts;
before it, that term defaults to the 50,000,000 µ$ backstop and the chain proves nothing"). The yaml
row (`sprint-status.yaml:186`) reads `deps: [DF1.1, DF1.5, DF1.10, DF1.11, DF2.3, DF2.8, DF2.12,
DF3.3]` — **no DF2.13**. The yaml is what the sequencer reads, so DF3.6a can be scheduled first and
AC2a becomes a comparison of two constants — the false green B2 was raised to kill. DF3.6b's deps
row (`:187`) matches its story exactly.

### W6-C-M5 — DF3.6b cites the wrong yaml line for its own row
**Category:** `C1-citation`. "Matches `sprint-status.yaml:183`, which is authoritative" — the DF3.6b
row is at `:187`; `:183` is an unrelated story. The *content* of the claim (deps match) is true.

### W6-C-M6 — `--no-tools` cited one line off
**Category:** `C1-citation`. DF3.6b Overview cites `src/fleet/resident.ts:524`; `--no-tools` is at
`:525` (`:524` is `"json"`). Trivial in isolation, listed because it sits inside the paragraph that
carries the `memory.oom.group=1` argument, which is otherwise correct and load-bearing.

---

## LOWs

### W6-C-L1 — a cluster of line citations that no longer resolve
**Category:** `C1-citation`. All in DF3.6a unless noted:
- `src/providers/credentials.ts:47` for the `defaultKeyCapMicroUsd` **value** — the constant is at
  `:73`; `:47` is a docstring line. Cited four times (AC2a, Infra Prereqs, Technical Notes chain,
  Split Record). The docstring itself says "Cited by symbol, not by line".
- `src/providers/credentials.ts:281` for `deps.capMicroUsd ?? defaultKeyCapMicroUsd` — actual
  `:287`. Cited twice. The docstring at `:52-55` narrates this exact drift about itself; it has now
  drifted again.
- `src/providers/cost-ledger.ts:444` for the `.sandbox/cost-config.json` path — actual `:445`
  (`DEFAULT_COST_CONFIG_FILE`). `:442` for `DEFAULT_COST_CONFIG` is **correct**.
- `scripts/pipeline-run.ts:2054` for the retry-loop exit in Technical Notes — actual `:2044`, which
  AC3 cites correctly. Two citations of one fact, one wrong.
- `scripts/pipeline-run.ts:3294`/`:3295-3297` for `residentSpawn = spawned` / the `createSteering`
  args — actual `:3293`/`:3294-3296`. The *substance* (the engine receives only `spawned.caller` and
  `spawned.rate`) is **verified true** and is the load-bearing half.
- DF3.6b AC3's `scripts/pipeline-run.ts:3293` for the `!("disabled" in spawned)` gate — actual
  `:3292`.

### W6-C-L2 — `below_one_call` is an operational refusal, not only a misconfiguration guard
**Category:** `C4-marginal`. AC6's `below_one_call` verdict stops the resident with
`code:"bound-config-invalid"` on any roster whose rate exceeds ~16× the fixture's. With the shipped
8,000 µ$ default that is a large slice of real rosters (see B3). One sentence should say that a
`below_one_call` default disables tier 2 for the whole run, so an operator reading the row knows it
is a policy outcome and not a typo. (Subsumed if B3 is fixed by making the ceiling rate-relative.)

---

## Counts

| Severity | Count | | Category | Count |
|---|---|---|---|---|
| BLOCKER | 4 | | `C1-citation` | 4 |
| HIGH | 5 | | `C2-semantic` | 5 |
| MEDIUM | 6 | | `C3-structural` | 7 |
| LOW | 2 | | `C4-marginal` | 1 |
| **Total** | **17** | | | **17** |

---

## Convergence verdict — NOT CONVERGED (high confidence)

The C4 population is a single item. The BLOCKER/HIGH population is seven parts C2/C3, and three of
the four BLOCKERs are one root cause: **the story models resident spend as `N × projection` while
the engine it specifies meters actual usage, and it calibrates the resulting number against a price
table that exists only in `tests/`.** A fourth round that patches the *number* will reproduce the
defect a fourth time, because the number is not the error — the model is. The ceiling needs to be
re-expressed against the quantity it is actually compared to (metered spend), against a rate the
in-box engine can actually resolve, and ideally as a multiple of `deps.rate`'s per-call projection
rather than an absolute µ$ constant. That is a rethink, not a patch.

DF3.6b is closer: its mechanism, its ADR conformance, its image ritual, its gate and its deps are
all verified correct, and three of its five ACs are sound. But its **make-or-break AC cannot be
executed** (B4) and its refusal path has no owned edit site (H5), so it is not startable either.

**On the specific question asked — is the spend ceiling's third derivation correct?** No. It is
arithmetically self-consistent (504.32 µ$, 760,960 µ$, 136,800 µ$, the 16th-call trip and the
five-phase reachability all recompute exactly) and it correctly fixed the *previous* error of using
`2 + Σ retries` instead of `2 + 3P`. But it repeats the family error one level down: it charges the
projection where the code meters usage, and it sources the rate from a fixture. On the shipped meter
and any plausible in-box rate, 8,000 µ$ either cannot be reached (cheap roster: ~82 calls needed,
27+ phases) or fires on a healthy run / refuses at `run_start` (mid-tier and frontier rosters). It
cannot fire on a runaway *and* not fire on a healthy run for any single roster-independent constant —
which is the argument for making it rate-relative.
