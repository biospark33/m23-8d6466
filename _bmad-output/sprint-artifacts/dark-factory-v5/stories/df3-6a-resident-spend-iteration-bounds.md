# DF3.6a: Resident Spend Ceiling + Per-Phase Iteration Bound, Enforced by the Engine

**Story Points:** 3
**Sprint:** v5-S3 (fleet band)

> **Split provenance.** This story is the first half of **DF3.6 "Resident-Agent Bounds —
> Iterations, RSS, and an Absolute Spend Ceiling Enforced by the Engine"** (3 pts, last authored
> 2026-08-20), split on **2026-09-08** by the QDS story-review campaign at the **provability seam**.
> Everything in this half is *engine policy over numbers the engine already holds* — a manifest
> read, a projection, a comparison, a counter — and every one of its assertions is falsifiable
> host-side with `bun test`. Everything in the other half is *kernel enforcement over a process the
> engine does not own* — a cgroup, a `memory.max` write, an OOM-kill — and none of it can be signed
> off anywhere but a real box; that is **DF3.6b**. Nothing crosses the seam except the manifest's
> `residentRssBytes` value, which this half validates and carries and the other half applies.
>
> The seam is not a line-count halving: the two halves differ in *what can prove them done*. This
> one needs no box, no image rebuild and no live spend beyond the existing e2e demo. See
> `docs/superpowers/specs/2026-08-31-tier2-placement-adr.md` Appendix B (ACCEPTED 2026-09-08) for
> the mechanism ruling that forced the re-sizing. The 3+3 re-point is deliberate: DF3.6 was
> under-pointed because it assumed a `ps` sampler where the ADR now requires kernel enforcement.

## Spec Reference

- `docs/superpowers/specs/2026-08-11-dark-factory-v5-architecture-design.md` §5.2 (the F12 invariant: "the resident agent is itself watched … enforced by the phase engine, not by the agent"), §5.1 tier 2, §6 item 5
- Decision register: v5 §4 **D4** (tripwires F7); findings **F12**, **F7**; risk **R3**
- Closed record (READ-ONLY, cited not modified): `docs/superpowers/specs/2026-08-11-pre-derivation-gates-report.md` §3.3 "D4 tripwire finding" and §4 finding 4 — the 15%-of-run-total tripwire is a **ratio trap** (on an all-cheap roster a v4-flash resident trips at N=2 steering turns while a frontier roster tolerates 65) and is re-specced as the absolute per-run spend ceiling F12 already mandates
- Derivation decisions: `docs/superpowers/specs/2026-08-11-v5-story-derivation-decisions.md` §5 row 4 (this story is the named encoding site), **DD-9** (integer µ$)
- Binding facts: R5 §6 fact **12** (never write the 15% ratio into an AC), fact **7** (final-turn-only cost events). Fact **5** (the RSS watchdog is *re-aimed*, not deleted) governs **DF3.6b**, not this half, and is superseded there by ADR Appendix B.
- Placement + mechanism: `docs/superpowers/specs/2026-08-31-tier2-placement-adr.md` Consequence 5 and **Appendix B** (ACCEPTED 2026-09-08)

## User Story

As the factory host paying for every sandbox,
I want the phase engine to cap the resident agent's steering iterations and absolute spend below the run key's own cap,
so that a resident agent that loops or burns money is stopped by the component it cannot influence, while the run still finishes deterministically.

## Overview

`loadResidentBounds(manifest)` validates the engine-owned bounds against the stamped configured
defaults and refuses the run if their ordering is wrong, then clamps the resident ceiling to this
run's minted key cap when the mint came in lower. During the run, `checkBounds(point)` runs
immediately before every DF3.3 solicitation: it rejects the call when the phase's solicitation
budget is spent, or when the projected worst-case cost would carry cumulative resident spend past
the effective ceiling. Every breach stops the **resident**, records the cause, and lets the
deterministic phase walk continue to completion. No bound is readable or writable from anything the
agent controls.

The manifest's third bound, `residentRssBytes`, is **validated and carried by this story and
applied by DF3.6b** — this half owns the schema field and the fail-closed refusal of a missing or
malformed value; it enforces nothing about memory.

## E2E Slice

**Demonstrable behavior:** Given `tests/phase-engine/fixtures/pipeline.bounds.json` declaring
`residentSpendCeilingMicros: 2_000_000`, `maxSteeringIterations: 3`, `residentRssBytes: 512 MiB`,
and a bounds-only pi catalog fixture
(`tests/phase-engine/fixtures/pi-catalog-bounds/openrouter.json`, addressed by
`QDS_PI_CATALOG_DIR`) pricing the resident slug at input **180.0** / output **40.0** USD-per-MTok —
chosen so the fixed projection `(16000/4 × 180_000_000 + 1024 × 40_000_000) / 1e6` is
**760,960 µ$** per call — **and `FAKE_RESIDENT_USAGE={"input":4000,"output":1024}` exported for the
run**: the fake pi's reported usage is the projection's own shape (`PROMPT_CHAR_CEILING/4`,
`MAX_OUTPUT_TOKENS`), so **metered per call equals projected per call by construction**, which is
what makes the demo's arithmetic checkable against the journal instead of assumed. The demo
inherits `spawnRunner`'s harness env — `QDS_PI_BIN` → the repo's fake resident
(`tests/phase-engine/fixtures/fake-resident.ts`), the resident env passthrough, and
`QDS_PI_MODELS_JSON` pointed at a nonexistent file — so it **never spawns real pi** against a
fabricated price table. When the run executes via `bun scripts/pipeline-run.ts --manifest
<fixture> --journal out.json`, the engine solicits at run start (spent 0 + projected 760,960 ≤
2,000,000 → allowed; **metered** 760,960) → solicits at the first `post_gate_failure` (760,960 +
760,960 ≤ 2,000,000 → allowed; **metered** 1,521,920) → reaches the second `post_gate_failure`,
projects `1,521,920 + 760,960 = 2,282,880 > 2,000,000`, and **does not call** → stops the resident
with `bound:"spend"` → the run completes deterministically. **The refusal is driven by the
projection** — the next call's worst case, checked before the call issues — **while the accumulator
it guards is metered actuals** (`meter(reply.usage)`, integer µ$): two different quantities with two
different jobs, and the story's earlier sentence conflating them ("driven by the projection, *never
by metered spend*") was the metering-basis defect Wave 6 caught (W6-C-B1); the operator ruling of
2026-09-13 resolves it. Observable artifact:
`out.json` with `resident.status:"stopped"`, `resident.spendMicros` strictly below 2,000,000 at
every point in the journal, a `residentTripwire` row `{runId, cause:"spend_ceiling_breach",
phase:"build", detail}` — the full shipped shape (`ResidentTripwire` in `src/phase-engine/steering.ts`; `runId`
and `detail` are required, `requestId` and `phase` optional) — and every remaining phase and gate
executed on the deterministic path.

*Why a fixture catalog and not the repo's default one:* both projection ceilings are fixed
constants (`PROMPT_CHAR_CEILING = 16_000`, `MAX_OUTPUT_TOKENS = 1_024`, in
`src/phase-engine/steering.ts`), so the projection is a function of the **rate alone**. At the
default catalog's resident-slug rates (`tests/phase-engine/fixtures/pi-catalog/openrouter.json`:
0.08 / 0.18 USD per MTok) the projection is `(4000 × 80_000 + 1024 × 180_000) / 1e6` = **504 µ$**.
The shipped fake-resident's default usage (`{input: 1000, output: 64}`) meters **92 µ$** per call at
those rates — **not** the projection — which is exactly why the
demo pins `FAKE_RESIDENT_USAGE` explicitly: the pin makes metered per call equal projected per call
**by construction**, because there is no coincidence of defaults to rely on. Under the ruled model (pre-call projection refusal + post-call metered
accumulator) a cheap fixture cannot silently pass: an implementation that only meters post-hoc —
no pre-call check — overshoots the ceiling without refusing and fails AC1's negative control, and
one that never meters (projection-bounded fake accounting) diverges from the ledger actuals DF5.3
hop 3 audits. The rate lives in
the catalog because there is no manifest or roster field for it: rates come from DF1.5's
models.json, never a `cost` key on the roster schema, which is closed and carries none.

**Wiring closed:** On completion of this story, the spend and iteration bounds are enforced by the
phase engine using only code merged by this story plus DF1.1's lifecycle, DF1.5's roster loading,
DF2.3's key cap, DF2.8's shipped per-**issue** cap `defaultCapMicroUsd`
(`src/providers/cost-ledger.ts`) — cited as **DF2.13's derivation source only** (it is host-side
and never a manifest operand; the per-run `capMicroUsd` DF2.13 derives from it is what this
story stamps), and DF3.3's
solicitation port. No stub, no `TODO: wire later`. DF3.3 records tripwire telemetry; this story
raises `spend_ceiling_breach` and widens the `cause` union that DF3.6b's `watchdog_kill` also needs.

**Dependency edges (predecessors):** DF1.1, DF1.5, **DF1.10** (in-box phase engine — every in-box
premise below is its: `QDS_TEAM_RUNNER=local`, `QDS_PI_CATALOG_DIR`, the single key at
`$HOME/app/.env`, `QDS_RUN_ROOT` unset so `runMarkerRoot()` returns `/run`, and the terminal marker
as the host's only observation channel), **DF1.11** (in-box steering executor — the solicitation
points this story wraps run inside its engine), DF2.3, DF2.8, **DF2.12** (per-role token cost
attribution wired at the dispatcher — without its `kind='tokens'` rows the run-total denominator
D4's tripwire (a) needs does not exist; see Technical Notes), **DF2.13** (per-run key cap wired from
the admission budget — it supplies `capMicroUsd`, the **middle term** of the ordering invariant this
story asserts; before it, that term defaults to the 50,000,000 µ$ backstop and the chain proves
nothing), DF3.3.
**Successor:** DF3.6b consumes this story's `cause`-union widening and its validated
`residentRssBytes`.

## Acceptance Criteria

1. **(make-or-break)** Given cumulative resident spend at `ceiling − ε` where ε is smaller
   than the projected worst-case cost of the next solicitation, When the engine reaches that
   solicitation point, Then it does **not** issue the call: the resident is stopped with
   `bound:"spend"`, the run continues deterministic to completion, and recorded resident
   spend never exceeds `effectiveCeiling + one call's metered cost` at any point in the journal.
   The one-call margin is honest, not slack: the projection is a worst-case *estimate* standing on
   two soft ceilings (the chars→tokens heuristic; `MAX_OUTPUT_TOKENS`, enforced via prompt
   instruction rather than a CLI flag — see the Deviation), so a single call can meter past the
   remaining headroom, and the pre-call refusal is what bounds that overshoot at one call.
   *Negative control: an
   implementation that meters only after the call — no pre-call refusal — overshoots without bound,
   passes a naive "was it stopped?" test, and MUST fail this one; so MUST an implementation whose
   journal shows spend above `ceiling + one call's metered cost`, which is a projection the
   deviation's soft ceilings cannot explain.*
2. The ordering assertion is **two checks over two different quantities**, never one over the minted
   cap, and **it runs only for runs that arm a resident**: a `--no-resident` invocation and an
   invocation whose brief is empty — the brief travels in the `run-context.json` witness beside the
   manifest, not on the manifest itself (`readResidentBriefSource`; the shipped `briefIsEmpty` →
   `{disabled:true}` early-out in the
   resident arm path) — never reach `loadResidentBounds`, so a *resident* bound can never fail a run
   that arms no resident — INV-BND-5's own first clause (W6-C-H2). `boundsPolicy` is this story's
   shorthand for the manifest's stamped bound set
   `{residentSpendCeilingMicros, capMicroUsd, defaultKeyCapMicroUsd}` — flat `.strict()` schema
   fields, no nested policy object; DF3.6b cites this definition (W6-C-M1).
   <br />**(a) config-time, over static defaults.** Given a manifest whose stamped bound set
   violates `residentSpendCeilingMicros ≤ capMicroUsd ≤ defaultKeyCapMicroUsd`, or a ceiling
   expressed as a percentage, ratio, or share of any run total, When `loadResidentBounds` runs, Then
   the run is **refused**. All three operands are **carried by value on DF1.1's frozen manifest**,
   each with a named provisioner: `residentSpendCeilingMicros` resolved at fill through the ceiling
   ladder (Technical Notes, "The ceiling is user policy"), `capMicroUsd` derived from the admission
   budget by DF2.13's shipped chain, `defaultKeyCapMicroUsd` stamped from the provider constant —
   and the fill-side stamp that writes all three is **this story's own edit** to the dispatch fill
   step (Files to Modify: `src/fleet/dispatch.ts` — DF3.1 is done and its shipped stamp writes
   `limitMicroUsd` only; no landed story owns a provisioner for these) —
   **the engine reads no host path**: `defaultKeyCapMicroUsd`
   is a constant in `src/providers/credentials.ts` and the per-issue default `defaultCapMicroUsd`
   comes from `loadCostConfig()` over `DEFAULT_COST_CONFIG` (`.sandbox/cost-config.json`), a
   **host-side** path that does
   not exist inside the box, so the in-box engine cannot obtain either value at run time whatever
   its import graph permits. (The argument is the *absent path*, not an import ban:
   `src/phase-engine/steering.ts:11-13` declares an engine↛**fleet** boundary, not an
   engine↛**provider** one, and three shipped engine files already import
   `../../providers/bounded-exec.ts` — see the DoD's precise gate.) A manifest missing any of the
   three **refuses the run** (fail-closed, INV-BND-2): a defaulted operand turns the assertion into
   a comparison of two constants that can never disagree, which is the false-green this AC exists to
   prevent. The check runs where the engine and the manifest actually live — at **manifest load
   inside the box, before the resident is spawned and before the first solicitation** — because
   "before a box exists" is structurally unreachable for engine code. The refusal writes the
   **terminal marker** with `{ ok:false, code:"bound-config-invalid", message, remediation }` —
   the house rule of DF3.1 AC3: an error code is payload, never a process exit code — which
   `fleet status` surfaces as **`not-ok`** (`src/fleet/status.ts`, the settled-marker reading; `engine-failed` is the
   **marker-absent** state, `:91,1311`, and must not be the observable here — writing the marker is
   the whole point) and `fleet harvest` carries out before teardown; the
   box is **not** torn down by the engine (in-box it cannot tear itself down, cannot print an
   operator-facing teardown command to a terminal nobody is attached to, and its exit code is
   observed by no parent process), and the host's existing teardown path (DF2.2 INV-5) is unchanged.
   No resident is spawned. The ceiling type is an **absolute integer µ$**; the schema has no ratio
   field to populate (gates report §3.3, R5 §6 fact 12) — `PipelineManifestSchema` is `.strict()`
   (`src/phase-engine/manifest.ts:317`), so an unknown ratio key is a parse rejection, not a
   tolerated extra. The same load also rejects a missing or non-positive-integer `residentRssBytes`,
   which **DF3.6b** applies but does not validate.
   <br />**(b) per-run, over the minted cap — clamp when present, never refuse.** Given this run's minted
   `limitMicroUsd` **as stamped into the frozen manifest by DF3.1's dispatch at fill time (DF3.1
   AC9a)** — DF2.8 mints `min(default, remaining)`, so a run near its issue cap legitimately
   carries a value below the configured default and even below the resident ceiling — When bounds
   load and the field is present, Then an effective ceiling is computed as
   `min(residentSpendCeilingMicros, limitMicroUsd)` and used for every AC1 projection; when it is
   absent the effective ceiling is the resident ceiling unclamped (see the close of this clause).
   When the
   clamp binds, Then a row `{ bound:"spend", action:"clamped", configuredMicros, limitMicroUsd,
   effectiveMicros }` is written to the **engine's trace/log stream** — not to the journal's
   `resident` block, whose key set DF3.3 closed (`df3-3…md` AC5;
   `src/phase-engine/steering.ts:204-219`) and which this story widens only for the one value it
   writes (`status:"stopped"`; `exitStatus:"overflow"` is DF3.6b's) — and the run **proceeds**:
   a remainder-capped mint is a normal state, not a misconfiguration. The value is read **only**
   from the frozen manifest: the engine runs inside the box, where the host-side
   `.sandbox/runs/<id>.json` record does not exist. `runContextFrom`
   (`runContextFrom` in `scripts/pipeline-run.ts`) refuses on **disagreement** — a declared `limitMicroUsd` that
   does not equal the ceiling dispatch recorded beside the manifest — and on a stale or unreadable
   witness, but it does **not** refuse on plain absence: its own comment states *"ABSENCE is still
   the only thing that leaves the field unset"*, and with no witness present it returns a context
   with no `effectiveCeilingMicros`. **`limitMicroUsd` is deliberately NOT in the required set**
   (W6-C-H2): it bounds the *provider key's* external ceiling, not the resident bound, and INV-BND-2's
   required set is the three chain operands of AC2a — each with a named provisioner — of which
   `limitMicroUsd` is not one. When it is present, the effective ceiling is
   `min(residentSpendCeilingMicros, limitMicroUsd)` and the clamp row is written (below); when it is
   **absent, the effective ceiling is `residentSpendCeilingMicros` unclamped and nothing is
   written** — absence is a normal state, never a refusal. This resolves the contradiction Wave 6
   caught: the field cannot be simultaneously `.optional()` in the schema — because a hand-authored
   `pipeline.yaml` may legitimately omit it — and refused by this story when omitted.
   *Negative controls: an implementation that
   applies check (a) to the minted `limitMicroUsd` refuses every run near its issue cap after DF2.8
   already admitted it, and MUST fail this test; so MUST an implementation that refuses the run on a
   missing `limitMicroUsd` — it re-creates the exact contradiction this clause resolves.* (The former second control — "an implementation
   that reads `.sandbox/runs/<id>.json` from inside the box" — is **no longer a control**: it is
   guaranteed by construction post-DF1.10 and mechanically fenced by the DoD grep. Stated as the
   fence it is, so nobody spends a test proving what the grep already proves.)
3. **The iteration bound counts solicitations issued, not directives accepted.** Given a phase in
   which the engine has already **issued** `maxSteeringIterations` solicitations, When it reaches a
   further solicitation point in that same phase, Then it does not solicit, the phase completes on
   the deterministic path, and **subsequent phases solicit normally** — the bound is per phase, not
   per run. The counter is **not** DF3.3's `telemetry.steeringIterations`, which increments only on
   an *accepted `retry` directive at `post_gate_failure`* (`src/phase-engine/steering.ts`, the accepted-retry increment)
   and stays at zero for a resident that replies `proceed` on every call — a proceed-loop is exactly
   the loop this bound exists to stop. This story therefore keeps its own per-phase solicitation
   counter **inside `resident-bounds.ts`**, surfaced on the bounds-check log line's `iterations`
   field and **not** on the journal's `resident` block, whose key set DF3.3 closed (`df3-3…md` AC5;
   the deferral to "the story that owns the journal contract" is recorded at `df3-3…md:625`, and
   this story is that story). *Negative control: an implementation bounding
   `telemetry.steeringIterations` lets a resident that replies `proceed` on every solicitation run
   unbounded and MUST fail this test.*
   **Producible trigger (the bound must fire, not merely exist):** given a phase declaring
   `retries: 5` whose gate **fails on attempts 1–4 and passes on attempt 5** —
   `tests/phase-engine/fixtures/pipeline.bounds.json` declares it, adapting the `build` phase of
   `tests/phase-engine/fixtures/pipeline.resident.json` to `test "$n" -ge 5` — When the **fourth**
   `post_gate_failure` solicitation point in that phase is reached, Then the engine does not
   solicit, attempt 5 runs and passes on the deterministic path, the phase completes, and the next
   phase solicits normally. A gate that failed on *every* attempt would exhaust `retries` and
   rethrow `GateFailureError` (the retry loop's exit in `scripts/pipeline-run.ts`), failing the phase — there would be
   no next phase to solicit, and the Then-clause would be unreachable from its own Given.
   The counter file MUST be **per-invocation** (`"$TMPDIR/qds-bounds-count-$$"`, or a path the test
   seeds and removes in a `finally`): the shipped resident fixture's fixed
   `$TMPDIR/qds-resident-fixture-count` survives between runs, so a second run starts at `n ≥ 5`,
   passes at attempt 1, produces zero solicitations, and goes green having proved nothing.
   `post_gate_failure` is the only per-phase solicitation point — `run_start` and `run_end` have one
   call site each, outside the phase loop (`scripts/pipeline-run.ts`, one call site each), and
   `post_gate_failure` is the in-loop point, inside it. The retry loop exits at `attempt > spec.retries`
   (the same retry loop), and `retries` is schema-defaulted to `MIN_RETRIES = 0`
   (`src/phase-engine/manifest.ts:225`), so the fixture must declare it explicitly. See the
   default's derivation in Technical Notes.
4. Given a provider reply yielding **no positive usage** — the usage object absent, or
   `{inputTokens: 0, outputTokens: 0}` (the reachable meter-zeroing path: a pi reply with no
   harvestable `message_end`, which `resident.ts` detects via `turnCount === 0` and returns anyway,
   metering zero) — When the engine meters, Then the call is charged
   the **projected worst case**, never zero (INV-BND-3). *Negative control: the shipped `meter`
   does the opposite — a reply carrying no usage object meters as zero rather than throwing (the
   `clampTerm` arms in `steering.ts`'s `meter`) — so an
   implementation that leaves that arm untouched lets a resident zero its own meter by returning a
   reply with no usage, and MUST fail this test; and a `{0,0}` reply fixture MUST fail an
   implementation that only guards the absent-object shape — "no usage field" is unreachable in
   production (every shipped caller normalises to numbers), and the zero-shape reply is the path
   INV-BND-3 exists to close.*
5. **Precedence against an already-degraded resident, stated once because it is otherwise
   undefined.** DF3.3 degrades OPEN at four points and `telemetry.status` is a **one-way latch** —
   nothing writes `"active"` back (the one-way latch in `src/phase-engine/steering.ts`), and
   degradation is therefore routine rather than an edge: any single transient degradation is
   permanent for the run — the fact this precedence rule exists for. Therefore: (a)
   `checkBounds` is called at the `SEAM DF3.6` position **after** the status gate
   (the status gate in `src/phase-engine/steering.ts`) and is deliberately **not** evaluated for a non-`active` resident — a
   resident that cannot call cannot spend, and hoisting the check above the gate would evaluate a
   bound against a resident with no future calls; (b) `"degraded"` and `"stopped"` are both terminal
   and **`"stopped"` wins only when this story's enforcement is the proximate cause** — a bound that
   fires after a degradation already latched leaves `"degraded"` standing and records the bound on
   the bounds-check log line alone. AC1's `resident.status:"stopped"` assertion is therefore scoped
   to a run whose resident was `active` at the breach. *Negative control: an implementation that
   overwrites `"degraded"` with `"stopped"` MUST fail.*
6. **The ceiling is checked against the rate it will be compared to, once, where the rate exists.**
   The ceiling is a manifest constant and the rate is a roster fact; nothing today validates one
   against the other, and they meet for the first time at `createSteering`
   (`src/phase-engine/steering.ts`) — *after* `startResident` (`scripts/pipeline-run.ts`),
   so `loadResidentBounds` structurally cannot do this check. Given `deps.rate` is resolved, When
   bounds are attached, Then the engine computes `projectedPerCall` and
   `maxSolicitations = 2 + maxSteeringIterations × phaseCount` and writes one **trace/log** row
   `{ bound:"spend", check:"reachability", projectedMicros, effectiveMicros, maxSolicitations,
   verdict }`, where `verdict` is `"unreachable"` when
   `effectiveMicros ≥ projectedMicros × maxSolicitations`, `"below_one_call"` when
   `effectiveMicros < projectedMicros`, and `"binding"` otherwise. A `"below_one_call"` verdict
   additionally stops the resident with `code:"bound-config-invalid"` **rather than**
   `cause:"spend_ceiling_breach"`: at frontier rates ($15 in / $75 out per MTok) the projection is
   `4_000 × 15_000_000 + 1_024 × 75_000_000` over `1e6` = **136,800 µ$**, seventeen times the
   shipped **fallback** ceiling, so `checkBounds` refuses at `run_start` before a single call — and
   under the user-policy ceiling this verdict is a **policy outcome an operator must recognise as
   intentional-looking**: it means "the amount configured for this task is too small for this
   roster's prices — set the per-issue override or raise the default", never "the resident ran
   away". An operator reading the row knows it disabled tier 2 for the whole run by configuration.
   The run proceeds deterministic in every case.
   *Negative control: an implementation that reports `spend_ceiling_breach` at `run_start` for a
   ceiling below one call's projection makes a misconfiguration indistinguishable from a loop, and
   MUST fail this test.*

## Trigger Surface

| Trigger | Status | E2E Test | Follow-Up |
|---------|--------|----------|-----------|
| `checkBounds()` before every DF3.3 solicitation | in-scope | `tests/phase-engine/resident-bounds.test.ts` | — |
| manifest load — bound ordering validation | in-scope | `tests/phase-engine/resident-bounds.test.ts` | — |
| `bun scripts/pipeline-run.ts` end-to-end with bounds | in-scope | `tests/phase-engine/resident-bounds.test.ts` | — |
| per-solicitation cgroup + `memory.max` enforcement | out-of-scope | — | **DF3.6b** |
| fleet-wide default bound policy pushed at dispatch | out-of-scope | — | DF3.1 |
| operator raising a bound mid-run via `attach` | out-of-scope | — | DF3.4 |
| resident spend reconciled into the cost ledger | out-of-scope | — | DF2.8 |
| bound-breach events on the audit chain | out-of-scope | — | DF5.3 |

## Infra Prerequisites

| Component | Service (compose/k8s/provider) | Lifecycle Hook Verified |
|-----------|-------------------------------|-------------------------|
| DF3.3 solicitation port | in-repo `src/phase-engine/steering.ts` (the engine-owned port; the agent itself is `src/fleet/resident.ts`) | `bun test tests/phase-engine/steering.test.ts` green before this story starts |
| run-key cap **default** | DF2.3 credential lifecycle (`defaultKeyCapMicroUsd` = 50,000,000 µ$, the provider constant in `src/providers/credentials.ts`) — **stamped onto the frozen manifest at fill by this story's own stamp edit** (Files to Modify: `src/fleet/dispatch.ts`; DF3.1's shipped stamp writes `limitMicroUsd` only), because `credentials.ts` is a provider module the in-box engine is forbidden to import (`src/phase-engine/steering.ts:11-13`) | config-time ordering assertion (AC2a) reads the **stamped configured default**, never a minted value and never the provider module |
| run-key cap **minted** | DF2.8 mint (`min(default, remaining)`), **carried into the box as `limitMicroUsd` on DF1.1's frozen manifest** — stamped at fill by DF3.1's shipped `stampManifestLimit`, which this story's own stamp edit sits beside in the same fill step — this story reads from the **frozen manifest only**; the host-side `.sandbox/runs/<id>.json` record does not exist inside the box | per-run clamp (AC2b) reads `limitMicroUsd` from the frozen manifest **when present and clamps; when absent the effective ceiling is the resident ceiling unclamped and nothing is written — absence is a normal state, never a refusal (AC2b; the field is deliberately NOT in INV-BND-2's required set)**. `runContextFrom` (`runContextFrom` in `scripts/pipeline-run.ts`) refuses on **disagreement** and on a stale witness but **not on plain absence** ("ABSENCE is still the only thing that leaves the field unset"). This story adds all three bound fields to the manifest schema but writes no bound *value* at run time beyond the clamp's **trace/log** row; it never stamps or alters `limitMicroUsd` (DF3.1's field — CC-1) |
| per-**issue** budget cap value | DF2.8 `loadCostConfig().defaultCapMicroUsd` (default **5,000,000 µ$ = $5.00**, DD-9, `src/providers/cost-ledger.ts`) — read from `.sandbox/cost-config.json`, a **host-side** path that does not exist inside the box. **It is not a manifest operand**: DF2.13's shipped chain derives the per-run `capMicroUsd` from it host-side, and the **derived** `capMicroUsd` is what this story's fill-side stamp writes onto the frozen manifest (Technical Notes: "not a term in this chain") | config-time ordering assertion over the **stamped derived `capMicroUsd`** only (the per-issue default governs *admission*, not in-run enforcement — see the spend-ceiling precedence in Technical Notes). INV-BND-2's absent-⇒-refuse rule applies to AC2a's **three** stamped operands — `residentSpendCeilingMicros`, `capMicroUsd`, `defaultKeyCapMicroUsd` — never to `defaultCapMicroUsd`, whose host-side absence is DF2.13's wiring concern, not a manifest-load refusal |
| resident slug rate | **already resolved**: `resolveRate` (`src/phase-engine/roster/validate.ts`) is called once at arming by `startResident` (`src/fleet/resident.ts:410`) and the result is handed to the engine as `ResidentSpawn.rate` → `createSteering({ rate })` (`createSteering` in `src/phase-engine/steering.ts`) | **this story reads `deps.rate.inputPerMTok` / `deps.rate.outputPerMTok` and loads nothing.** One resolution per run, one source. A second models.json reader in `resident-bounds.ts` would be a second rate path that can disagree with the one the resident is billed at — and would disagree first the moment a catalog is staged differently in-box (`QDS_PI_CATALOG_DIR`) |
| per-role token attribution | **DF2.12** — `kind='tokens'` cost rows written at the dispatcher | the run-total denominator D4's tripwire (a) needs. Without it the numerator (`resident.spendMicros`) has nothing honest to divide by; see Technical Notes |

## Technical Notes

- **The bounds this story owns and their defaults, stated once:**
  `maxSteeringIterations` = **3 per phase** — deliberately below `MAX_RETRIES`
  (`src/phase-engine/types.ts:31` = 5), which is the structural ceiling on `post_gate_failure`
  solicitations in one phase (the retry loop in `scripts/pipeline-run.ts` exits at
  `attempt > spec.retries`, and `retries` is schema-clamped to `MAX_RETRIES` —
  `src/phase-engine/manifest.ts:225`). A default at or above 5 is a bound that can never fire on any
  schema-valid manifest, and a test that can only assert the bound *exists*.
  `residentSpendCeilingMicros` — **user policy, not a derivation. Operator ruling, 2026-09-13
  (Wave 7, recorded in the tracker): the ceiling is a spend amount the user sets — a global default
  applying to all repos/projects/tasks, plus a per-task custom amount — and the counter it guards is
  the honest meter.** Resolution ladder, evaluated once at fill and stamped onto the frozen manifest
  as the single resolved value:
  1. **Per-task override** — a `perIssueOverrides` entry for the pinned issue carrying
     `residentSpendCeilingMicros`: the same config surface DF2.13's `--cap` flows through, and the
     factory substrate's realization of "a custom amount per task". (A factory UI would be a
     separate product story; the config seam exists and is the one this story specs — no new surface
     is invented here.)
  2. **Global default** — the user-set default in the cost config, applying to every
     repo/project/task that declares no override.
  3. **Shipped fallback** — **8,000 µ$ ($0.008) per run**, documented as a *fallback for cheap
     rosters*, never as a derivation: at the shipped fixture-catalog rates the projection is ~504
     µ$/call, so the fallback buys roughly sixteen projected calls; at frontier rates it cannot buy
     one, AC6's `below_one_call` refuses, and that is the ladder working as designed — a task priced
     above the fallback needs its override set.

  **The metering basis — stated once because three derivations died conflating it (W6-C-B1).**
  The engine meters **actual** usage: `meter(reply.usage)` sums integer µ$ per call. The pre-call
  refusal compares the **projected** worst case of the next call against the remaining headroom
  (`spent + projected > effectiveCeiling`) — the refusal is projection-driven, and that sentence is
  now unambiguously true instead of contradicted by its own predicate. The post-call tripwire
  catches the one-call overshoot a soft projection can allow (AC1's margin). **No binding call
  count is derivable in advance** — it depends on the roster's *metered* per-call cost, not on the
  projection — and this story derives none, which is the correction: every earlier derivation
  charged the projection where the running code meters usage and landed on a trip point ("the 16th
  call") the code cannot reach that way. What *is* pre-checked is **reachability** (AC6:
  `binding` / `unreachable` / `below_one_call` over the projected rate and the structural maximum
  `2 + maxSteeringIterations × phaseCount`), and what *is* enforced is the pre-call refusal itself.
  The accumulator is the same quantity DF2.12's landed `kind='tokens'` rows record: one spend
  truth, auditable at DF5.3 hop 3.
  `residentRssBytes` = **512 MiB** is declared on the same manifest and validated by this story's
  loader, but **enforced by DF3.6b**; nothing here reads or acts on it. **The default is
  provisional-pending-DF3.6b** (W6-C-H4): DF3.6b's live round measures pi's baseline RSS and owns
  re-setting the constant — `src/phase-engine/manifest.ts` is in DF3.6b's Files to Modify, scoped to
  that one value. It survives verbatim from the 2026-08-20 text and is the one default nobody has
  re-derived.
  All bounds live in the DF1.1 manifest, are frozen with it at load, and are carried by value for
  the run. This DF3 story therefore ships **engine** code (`src/phase-engine/`, not the `src/fleet/`
  root its siblings use): F12's enforcement locus is the whole point, and a bound owned by the fleet
  layer would be a bound owned by the agent's own tier.
- **The ordering invariant's three terms sit at three different enforcement points — stated once,
  because the chain is meaningless without them:**
  `residentSpendCeilingMicros` (per **run**, **resident only**, engine-enforced in-box, this story —
  a *claim* under R9, inside the trust boundary) `≤`
  `capMicroUsd` (per **run**, the mint-time cap `mintRunKey` applies — the `deps.capMicroUsd ??
  defaultKeyCapMicroUsd` defaulting expression inside `mintRunKey`, cited by symbol; **provider-enforced, outside the trust boundary**; wired from
  the admission budget by **DF2.13**) `≤`
  `defaultKeyCapMicroUsd` (the provider-side **backstop** ceiling on what may be requested, DF2.3's
  constant in `src/providers/credentials.ts` — not an operating budget). `≤` on both pairs, validated at load
  over the stamped values (AC2a), so a ceiling merely *equal* to the mint-time cap is admitted.
  **Two of the three are enforced outside the trust boundary; the one inside is this story's, and
  that asymmetry is the point:** the outer caps bound the *run key* and cannot see which component
  is spending it, so they cannot stop a runaway resident without killing the run mid-phase. This
  story's ceiling bounds a *component*, which is why it is not redundant with them. DF2.8's
  per-**issue** `defaultCapMicroUsd` (`src/providers/cost-ledger.ts`) is **not** a term in this
  chain: it governs admission, and it is what DF2.13 derives `capMicroUsd` from. The chain is
  **never** evaluated against a run's minted `limitMicroUsd`, which is routinely lower by design;
  that is AC2b's clamp.
- **Spend-ceiling authority — four mechanisms, one number, explicit precedence.** They are not
  redundant copies of one budget and the story must not reason as if they were:
  0. **The tier-3 harness kill** (`budgetCapUsd × BUDGET_KILL_FRACTION`,
     `cli-anything/src/runner.ts:466,470`; `BUDGET_KILL_FRACTION = 0.9`) is the **innermost**
     ceiling and, at `budgetCapUsd`'s `0.5` default, fires first — at ~$0.45, killing the **run**
     (`df2-7…md:132-136`). It is not this story's to change and this story never reads it. It is
     listed because a precedence section that omits the control that binds first is worse than
     none: the resident ceiling sits inside it only while
     `residentSpendCeilingMicros < budgetCapUsd × 0.9`, true at the shipped defaults
     (8,000 µ$ ≪ 450,000 µ$) and the one relation in this list a `budgetCapUsd` change can invert.
     Below `budgetCapUsd = $0.0089` the harness kill lands *inside* the resident ceiling and the run
     dies while the resident is still soliciting — the one outcome INV-BND-5 says a breach must
     never cause.
  1. **DF2.3's provider-side key cap** (`limitMicroUsd`, minted `min(defaultKeyCapMicroUsd,
     remaining)`) is the **outermost and authoritative** ceiling. OpenRouter enforces it, it covers
     the resident *and* every tier-3 worker on the same key (§6.2 one-secret-per-box), it cannot be
     bypassed by an engine bug, and it is the only one on this list an adversary inside the box
     cannot reach. **DF2.13** is what makes its per-run value (`capMicroUsd`) derived from the
     admission budget rather than defaulting to the backstop.
  2. **This story's engine-enforced ceiling** is authoritative **for the resident, and only for the
     resident**. It is an inner control whose job is to stop *one component* before the run key
     notices, so the run still finishes deterministically instead of dying provider-side mid-phase.
  3. **DF2.8's `defaultCapMicroUsd`** is **per-issue and host-side**. It governs *admission* — the
     pre-spawn dispatch refusal — never in-run enforcement, and it is **not a term in the ordering
     chain**: DF2.13 derives `capMicroUsd` from it, and `capMicroUsd` is what the chain asserts
     against. It is not a per-run budget and must not enter the in-run reasoning.

  On disagreement, `min()` wins and the clamp is recorded (AC2b).
- **DF3.6a is the single owner of the cap chain (DF2.3 reconciliation — current state).** The chain
  `residentSpendCeilingMicros ≤ capMicroUsd ≤ defaultKeyCapMicroUsd` is owned here: `≤` on both
  pairs (the operator ruling below replaced the former strict `<`). DF2.3 carries a **verbatim copy** of that
  chain rather than a variant wording; if a future edit makes them diverge, this story is
  authoritative and the copy is what gets corrected. **That authority was exercised on 2026-09-08,
  and the correction is complete:** every listed copy — DF2.3, DF2.4 (both sites), DF2.8, DF5.5 and
  the `src/providers/credentials.ts` docstring — **already carries the corrected `≤` chain**; the
  old `runBudgetCapMicros` wording survives only inside explicitly-labelled historical quotes (each
  site's "Correction, 2026-09-08" blockquote; `credentials.ts` labels its old text "This docstring
  previously read…"), and `df5-5` expressly forbids rewriting its quote — re-applying E would
  destroy the audit trail the quotes exist to keep. **No edit is owed**; this story changes nothing
  in any of them, and Files to Modify carries `credentials.ts` as a no-edit entry for exactly that
  reason. (DF2.7's prose mention and DF2.12's quoted finding title were never copies.) This record
  supersedes the Wave 5c note below that still listed the docstring as pending.

  **RESOLVED (operator ruling, 2026-09-08) — the middle term is re-homed, not invented.** The
  chain's middle term was never vapor: `mintRunKey` already takes a per-run cap
  (`deps.capMicroUsd ?? defaultKeyCapMicroUsd` — the defaulting expression inside `mintRunKey`,
  cited by symbol), and
  `defaultKeyCapMicroUsd = 50_000_000` is a **backstop**, not an operating budget. What was missing
  was the wiring, not the control. The invariant this story asserts is therefore:

  ```
  residentSpendCeilingMicros  ≤  capMicroUsd (mint-time, per run)  ≤  defaultKeyCapMicroUsd
     DF3.6a, engine-enforced,        provider-enforced, per run,        provider ceiling
     in-box, a CLAIM under R9        OUTSIDE the trust boundary         on the above
  ```

  `≤` throughout, not strict `<`. `loadResidentBounds` asserts against **the mint-time cap carried
  on the frozen manifest**, never against a name of its own; the earlier `runBudgetCapMicros` is an
  evidence-artifact field (`scripts/cap-hit-demo.ts:97`,`:148`,`:1305` — a `--budget-cap` flag,
  *"artifact field only"*) and enforces nothing. **DF2.13** wires `capMicroUsd` from DF2.8's
  remaining issue budget as `min(remaining, policy ceiling)` — derived, so admission and in-run
  enforcement cannot disagree — and is a predecessor of this story.

  **Two of the three terms are enforced outside the trust boundary; the one inside is this
  story's, and it is why DF3.6a exists.** The outer caps are provider-enforced and un-bypassable,
  but they bound the *run key* and cannot see which component is spending it. This story's ceiling
  bounds a *component*, in-box, which makes it a **claim under R9** rather than a boundary — and
  therefore not redundant with the outer cap.

  **The gap this closes.** DF3.6a holds the resident at 8,000 µ$ while a run may spend to the
  50,000,000 µ$ backstop: a **6,250× band in which tier-3 workers have no in-run bound**, where the
  only thing that stops a runaway today is a blunt mid-phase key death. No amendment to DF2.3 is pending from DF5.5 —
  the chore that once carried one was retired as already-satisfied.
- **Micro-USD field naming, one rule (shared with DF3.3):** `*MicroUsd` names are **persisted**
  fields on DF2.1's run record and DF2.3's key metadata; `*Micros` names are **in-memory / journal**
  values owned by the engine. Explicit mappings used here: `runKeyCapMicros` reads the
  **frozen manifest's `limitMicroUsd`**, `defaultKeyCapMicroUsd` is DF2.3's configured default,
  `residentSpendCeilingMicros` is the manifest bound, and `journal.resident.spendMicros` is the
  engine-metered subtotal. No code path renames one suffix into the other implicitly, and this story
  never reads the host-side run record. DF2.8's configured per-issue default keeps its shipped name
  `defaultCapMicroUsd` — this story renames nothing to fit the rule; where a shipped symbol and the
  naming rule disagree, the shipped symbol wins.
- **Why an absolute ceiling and not the 15% ratio (gates report §3.3, R5 §6 fact 12 — BINDING):** a
  ratio's denominator moves with every team-cost optimization, so improving the factory mechanically
  pushes the resident toward demotion; the same ratio fires at N=2 steering turns on an all-cheap
  roster and tolerates 65 on a frontier one. It is not re-derived, re-scoped, or offered here as a
  secondary signal.
- **D4's tripwire (a) stays computable from run data without a ratio field ever existing, and
  DF2.12 is what makes its denominator honest.** Numerator: the journal's `resident.spendMicros`
  (engine-metered, this story's meter, integer µ$). Denominator: the run total, which becomes real
  only once **DF2.12** writes per-role `kind='tokens'` cost rows at the dispatcher — before DF2.12
  there is no attributed run total to divide by, and any "15% of run total" evaluated against a
  partial denominator is a demotion decision made on a number nobody can defend. The p50 is taken
  **across runs** by the month-1 evaluator, never by the engine, and neither number is a ratio at
  rest. This is what makes the ratio's re-spec as an absolute ceiling a *re-spec* and not a deletion
  of D4's evidence. *This story ships no ratio and computes no p50.*
  **D4's tripwire (b)** — "any audit finding where the agent bypassed or reordered a phase-engine
  gate" — needs nothing from this pair: it is already shipped as DF3.3's `gate_bypass_attempt`
  cause (the `ResidentTripwire["cause"]` union in `src/phase-engine/steering.ts`, its sole member before this story widens
  it) and is untouched here except by that widening. Stated so the D4 citation reads as complete
  rather than leaving a reader to re-derive which of the three tripwires this pair owns:
  (a) DF3.6a, (b) already shipped, (c) DF3.6b.
- **Pre-flight projection, not post-hoc accounting:** worst-case cost of a call is
  `((promptCharCeiling/4) × inputPerMTok + maxOutputTokens × outputPerMTok) / 1e6` — the `/1e6` is
  what converts DF1.5's µ$-per-**million**-tokens unit into µ$ for this call, and it is applied
  once, at the projection, by the consumer. `inputPerMTok` and `outputPerMTok` come from
  `deps.rate`, already resolved once per run by `resolveRate` (Infra Prerequisites) — worst case
  assumes no cache hits, so the two cache rates are not consulted. They are priced separately, not
  as one combined rate, so output tokens are not underpriced at the input rate. Both ceilings are
  DF3.3's per-call guards (16,000 chars / 1,024 tokens). **Projection is fail-safe:** when a
  provider reply lacks usage, the engine charges the projected worst case, never zero (INV-BND-3,
  AC4). The engine refuses to solicit when `spent + projected > effectiveCeiling` (AC2b's
  `min(residentSpendCeilingMicros, limitMicroUsd)`): that is what makes AC1's ceiling a ceiling and
  not a report of a breach already paid for.
- **The meter is engine-side:** cumulative resident spend is summed by the engine from the
  provider's reported usage on each reply (DF3.3's meter, integer µ$ per DD-9). The agent never
  reports its own spend, and this meter is independent of `team-lead-driver.ts`'s final-turn
  overwrite (R5 §6 fact 7) — a bug in the tier-3 driver cannot move this number.
- **Breach behavior is uniform and narrow:** a breach stops the **resident** and nothing else —
  never fails the run, a phase, or a gate, and never shortens a budget. A run whose resident was
  stopped finished deterministically, which is exactly D4's fallback ("demote tier 2 to code-only
  dispatch") happening for one run.
- **Tripwire causes are emitted, not evaluated:** a spend breach emits a DF3.3 `residentTripwire`
  row `{ runId, requestId, cause: "spend_ceiling_breach", phase, detail }` with `detail` carrying
  the projected and cumulative figures that crossed the ceiling. This story counts nothing. It also
  performs the **union widening** to
  `"gate_bypass_attempt" | "spend_ceiling_breach" | "watchdog_kill"` — including DF3.6b's member,
  because the union is one closed type on one line and splitting the edit across two stories would
  put two PRs on the same literal.
- **Deviation/assumption:** the projection uses the roster slug's published rate. If a provider
  bills a rate the roster does not carry, the projection errs cheap and the ceiling could be
  approached from below by one call's error margin. **Two soft ceilings sit inside the projection
  itself, recorded rather than assumed hard (W6-C-H3):** `PROMPT_CHAR_CEILING/4` is a chars→tokens
  heuristic — dense JSON, base64 or CJK context tokenises well above chars/4 — and
  `MAX_OUTPUT_TOKENS` is enforced via the prompt instruction, not a CLI flag, so a model that
  ignores the instruction meters above its projection. AC1's journal assertion therefore carries the
  one-call margin, and this deviation is where that margin is justified. The provider backstop
  `defaultKeyCapMicroUsd` sits far above this component bound — 6,250× the shipped fallback — and
  recorded `spendMicros` is the authoritative post-run number — recorded, not
  engineered around.

## Observability Contract

- Every bounds check logs `{ requestId, runId, phase, bound, spendMicros, projectedMicros, iterations, allowed }`
- `requestId` propagates unchanged from DF3.3's solicitation record; a breach additionally
  emits `{ code, bound, cause, phase }` on the tripwire row
- Sub-timings: `projection_ms`. A bound never evaluated reports `0`.
- **Destination:** the bounds-check line and AC2b's clamp row go to the engine's **trace/log
  stream**, never to the journal's `resident` block, whose key set DF3.3 closed
  (`src/phase-engine/steering.ts:204-219`). The only journal `resident` value this story writes is
  `status:"stopped"`, which DF3.3 reserved for it.

## Files to Modify

- `src/phase-engine/resident-bounds.ts` — `loadResidentBounds`, `checkBounds`, the projection, and
  this story's own per-phase solicitation counter (AC3).
- `src/fleet/dispatch.ts` (DF3.1-owned file; **adds only** the fill-side stamp provisioner this
  story owns — W8-C-1) — at the dispatch fill step, beside the shipped `stampManifestLimit` call,
  stamp the bound operands onto the frozen manifest: `residentSpendCeilingMicros` resolved through
  the ceiling ladder (perIssueOverrides → global default → shipped fallback), `capMicroUsd` from
  DF2.13's shipped mint chain, `defaultKeyCapMicroUsd` imported from the provider constant — and
  nothing else: `limitMicroUsd` stays DF3.1's shipped stamp's field alone (CC-1), and
  `defaultCapMicroUsd` is DF2.8's host-side derivation source, never stamped. **Without this edit the schema gains fields nothing writes and
  every resident-arming run refuses `bound-config-invalid` at manifest load while hand-authored
  fixture suites stay green — the `ingestCostEvent` dead-writer shape.** DF3.1 is done and its
  shipped stamp writes `limitMicroUsd` only; the stamp edit is new work in the done story's file,
  owned here on the DF5.3 setup-gate-emit precedent.
- `src/phase-engine/steering.ts` (shared, three-way — **DF3.3 authors** the port and
  its three solicitation points, **DF3.4** adds the `attach` inbox drain + ack append at those same
  points, and **DF3.6 rebases last**. The edits are **enumerated and closed** — no fourth
  solicitation point, no new point, and nothing outside this list:
  1. the `checkBounds(point)` call at the existing `SEAM DF3.6` comment in
     `src/phase-engine/steering.ts`, which
     sits **after** the status gate and stays there (AC5);
  2. widening `ResidentTripwire["cause"]` to
     `"gate_bypass_attempt" | "spend_ceiling_breach" | "watchdog_kill"` (the union declaration in
     `src/phase-engine/steering.ts`) —
     explicitly transferred to this story by DF3.3 (`df3-3…md:632`, and the transfer comment beside
     the union). Both new members land here, including DF3.6b's;
  3. one **internal** writer so this story can set the field DF3.3 declared for it —
     `telemetry.status = "stopped"` — reachable only from inside `createSteering`. The controller
     keeps its snapshot-only getter (cited by symbol in `src/phase-engine/steering.ts`); **no public setter is added**, because
     a public setter is a path the resident's own tier could reach and INV-BND-1 forbids it.
     (`telemetry.exitStatus = "overflow"` is the same shape and is **DF3.6b's** writer.);
  4. `meter`'s zero-usage arm (the `clampTerm` arms in `steering.ts`'s `meter`): a reply with no usage object is charged the
     projected worst case, never zero (INV-BND-3, AC4). **This reverses a documented DF3.3
     disposition** (the shipped zero-usage disposition in `src/phase-engine/steering.ts`) and must be recorded in DF3.3's deviation ledger, not
     merely done;
  5. the **three** new `createSteering` deps on the deps object DF3.3 already marked additive for
     exactly this (the additive-deps object in `src/phase-engine/steering.ts`): `bounds` and `onBoundBreach` (this story), and
     `lastMemory?: () => { peakBytes: number; oomKilled: boolean } | null` — **DF3.6b's**, landed
     here deliberately. The deps object is one literal; two stories must not edit it, and DF3.6b's
     `exitStatus:"overflow"` writer has no input without this callback. It is a **structural
     callback, not a fleet import**: the engine never receives `ResidentSpawn` (the sole
     `createSteering` call site in `scripts/pipeline-run.ts` passes
     `spawned.caller`/`spawned.rate` plus two non-fleet sidecars — `emitAttribution` (DF2.12) and
     `inbox` (DF3.4); **no `ResidentSpawn` member crosses**) and is forbidden
     to import fleet code (`steering.ts:11-13` — the one boundary claim in this pair that is real).
     There is still **no `residentPid`**: the engine learns whether the kernel killed, never how to
     kill.
  6. **DF3.6b's typed placement-failure channel** (W9C-6b-2, AC4 of df3-6b): the
     `ResidentCaller` contract (the interface in `src/phase-engine/steering.ts`) gains the
     engine-owned `PlacementRefusedError` rejection — exit 97, thrown by fleet's caller
     implementation (fleet→engine is the allowed import direction) — and the call-failure catch
     gains its `instanceof` arm beside the degrade arm. Same cross-story amendment shape as
     item 5's `lastMemory`.

  Mirrored in df3-3's Technical Notes and df3-4's Files list.)
- `src/phase-engine/manifest.ts` — all three bound fields (including `residentRssBytes`, which
  DF3.6b applies) plus AC2a's two stamped operands. `PipelineManifestSchema` is `.strict()`
  (`src/phase-engine/manifest.ts:317`), so a field not added to the schema makes `pipeline.bounds.json` fail parse
  with `unrecognized_keys`.
- `scripts/pipeline-run.ts` — **the pair takes six edits on this file, stated once here so neither
  half's "no other change" can reject the other's** (W6-C-M2): **DF3.6a lands (i)** the
  `loadResidentBounds(manifest)` call at manifest load, scoped to runs that arm a resident (AC2a),
  **before** the `startResident` call site — AC2a requires it "before the resident is spawned", and
  DF3.6b needs the validated `residentRssBytes` at that call — and on refusal writes the terminal
  marker `{ ok:false, code:"bound-config-invalid", message, remediation }` through the existing
  marker writer and returns without arming a resident; **(ii)** passing
  `bounds`/`onBoundBreach`/`lastMemory` at the sole `createSteering` call site. **DF3.6b lands
  (iii)** `residentRssBytes` on the `startResident` call, **(iv)** `lastMemory:
  spawned.lastMemory` at the `createSteering` call, **(v)** the `onBoundBreach` handler arm that
  calls `residentSpawn.stop()` on `cause:"watchdog_kill"` **and on the placement wrapper's exit-97
  `unenforceable` classification** (DF3.6b's AC5 latch and AC4 stop — the record goes on the fleet
  `warn` chokepoint, harvested via fd-2), and **(vi)** the
  **arming-refusal classification**: a typed error thrown by the resident arm when the cgroup
  cannot be created or `memory.max` written, handled in the arming `try/catch` beside the existing
  rate-refusal arm, emitting the shipped `{ level:"warn", event:"resident_disabled", …,
  reason:"rss_unenforceable" }` line through the existing disabled-shape branch — **never an
  unclassified rethrow** (which produces a tracer-closed, marker-absent box and
  `fleet status: engine-failed`, the outcome AC2a's negative control forbids) and **never emitted
  from the `onBoundBreach` region**, which on the arming path is not constructed (W6-C-H5).
  Without (i) `loadResidentBounds` is an exported function with no caller and AC2a never
  runs in a real pipeline — the same dead-writer shape `sprint-status.yaml` records for
  `ingestCostEvent`.
- `src/providers/credentials.ts` — **no edit; already corrected by the parent (2026-09-08).** The
  docstring at `:46-55` now reads "Provider-side BACKSTOP cap — the ceiling on what `mintRunKey` may
  request, not the run's operating budget", names `deps.capMicroUsd` at `:281` as the per-run
  budget, points at DF2.13 for the wiring, and carries the corrected `≤` chain verbatim. Listed here
  only so a reader does not re-derive that it was once wrong; this story changes nothing in it.
- `tests/phase-engine/resident-bounds.test.ts`
- `tests/phase-engine/fixtures/pipeline.bounds.json`
- `tests/phase-engine/fixtures/pi-catalog-bounds/openrouter.json` — the priced catalog the mandatory
  e2e demo's arithmetic closes against (E2E Slice).

## Security Invariants

- **INV-BND-1 (enforcement locus — F12, verbatim intent):** all bounds are enforced by
  the phase engine, never by the agent. No directive, prompt, env var, in-box file, or roster
  entry the resident can influence may raise, disable, or reset a bound. A bound value read
  from a path the resident can write is a defect regardless of the value it holds. *(DF3.6b carries
  the memory-specific corollary, INV-MEM-1, which is strictly stronger for that one bound: the
  kernel enforces it outside the resident's address space.)*
- **INV-BND-2 (strict cap ordering over defaults, validated before the resident exists):**
  `residentSpendCeilingMicros ≤ capMicroUsd ≤ defaultKeyCapMicroUsd`, asserted at manifest
  load — inside the box, before the resident is spawned and before the first solicitation (AC2a).
  The assertion is over **configured defaults**, and **all three operands are stamped onto the
  frozen manifest by DF3.1's dispatch**: the in-box engine reads no host path and imports no
  provider module (`src/phase-engine/steering.ts:11-13`), so an operand it had to default to a
  documented constant would make the assertion compare two constants that can never disagree — a
  permanent false green. A manifest missing any of the three refuses the run. This run's minted
  `limitMicroUsd` instead clamps the effective ceiling to `min(ceiling, limitMicroUsd)` with a
  trace/log row and never refuses the run (AC2b). The frozen manifest is the **only** cap source the
  engine reads: it is carried by value into the box and is INV-BND-1-safe (frozen at load,
  unwritable by the resident), whereas the host-side run record does not exist inside the box at
  all. **`limitMicroUsd` is a clamp input, not a chain operand**: when present it narrows the
  effective ceiling with a trace/log row; when absent the effective ceiling is unclamped and
  nothing is refused (AC2b). `runContextFrom`
  (`runContextFrom` in `scripts/pipeline-run.ts`) refuses on disagreement and on a stale or unreadable witness,
  and this story never bare-throws on its plain-absence return — the clamp is simply not applied.
- **INV-BND-3 (meter integrity):** cumulative resident spend is engine-metered from provider
  usage. The agent never reports its own spend; a reply with no usage field is charged the
  projected worst case, never zero. A metering path that trusts an agent-supplied number is
  a credential-adjacent defect, not a rounding choice.
- **INV-BND-4 (the ceiling is absolute):** the ceiling is an integer µ$ value compared
  against cumulative spend. It is never a percentage, ratio, or share of the run total, and
  no such field exists in the schema to be populated later (gates report §3.3, R5 §6 fact 12).
- **INV-BND-5 (fail-closed, and closed toward determinism):** a spend or iteration breach stops the
  resident only — never a gate, a phase, or the run's determinism. A refusal at bounds load refuses
  the whole run before a resident exists (AC2a); a breach mid-run stops one component and the phase
  walk continues. *(DF3.6b carries the memory path's own fail-closed rule, INV-MEM-2, because a
  bound that cannot be enforced is a different condition from a bound that fired.)*

## Definition of Done

- [ ] **Impl:** `loadResidentBounds` + `checkBounds` in `src/phase-engine/resident-bounds.ts`; every DF3.3 solicitation is gated by `checkBounds` with no unguarded call site in the diff.
- [ ] **Impl:** worst-case pre-flight projection from `deps.rate` (`inputPerMTok`/`outputPerMTok` divided by `1e6`) — **no models.json reader in this story**; engine refuses to solicit when `spent + projected > effectiveCeiling` (AC1, INV-BND-3).
- [ ] **Contract:** all three bounds carried in DF1.1's frozen manifest (`residentRssBytes` validated here, applied by DF3.6b); strict ordering assertion over the **three stamped configured defaults**; schema exposes no ratio/percentage field and is `.strict()` (INV-BND-2, INV-BND-4). DF2.8's per-issue cap is the shipped `defaultCapMicroUsd` (`src/providers/cost-ledger.ts`) — cited by its real name and stamped, never read from `.sandbox/cost-config.json` in-box.
- [ ] **Integration:** a spend breach emits a DF3.3 `residentTripwire` row with `cause:"spend_ceiling_breach"` and a `detail` carrying the projected and cumulative figures; the `cause` union widening (both new members) and the `meter` zero-usage reversal are recorded in DF3.3's deviation ledger (Files to Modify).
- [ ] **Security:** no bound is readable or writable from any path the resident controls; no public setter for `telemetry.status` is added — the controller keeps its snapshot-only getter (cited by symbol in `src/phase-engine/steering.ts`); the engine imports **no fleet module** (`steering.ts:11-13`, the shipped boundary) and imports **neither `src/providers/credentials.ts` nor `src/providers/cost-ledger.ts`** and reads **neither `.sandbox/runs/` nor `.sandbox/cost-config.json`** — the gate greps the four **import-specifier/path forms** `providers/credentials`, `providers/cost-ledger`, `.sandbox/runs/`, `.sandbox/cost-config.json` over `src/phase-engine/` and requires zero hits; the bare tokens are NOT the gate (`credentials` and `cost-ledger` appear in shipped comment prose). Positive control: `bounded-exec` hits exactly the three shipped importer files. *(A blanket "no provider import" grep is NOT the gate and would fail on shipped code: `gates/command-gate.ts:17`, `roster/validate.ts:34` and `phases/test-results.ts:37` already import `../../providers/bounded-exec.ts`, and `roster/validate.ts` is this story's own `resolveRate` source.)*
- [ ] **Test (pre-flight ceiling, AC1):** spend at `ceiling − ε` → next call never issued; recorded spend stays under ceiling; post-hoc-metering implementation MUST fail.
- [ ] **Test (config refusal, AC2a):** `ceiling > capMicroUsd` refuses (`ceiling == capMicroUsd` is **admitted** — the chain is `≤`); `capMicroUsd > defaultKeyCapMicroUsd` refuses; percentage value fails schema parse; a missing or non-positive `residentRssBytes` refuses; **a manifest missing any of the three stamped operands refuses** — no operand ever defaults to a documented constant. Each at manifest load, writing the terminal marker with `{ ok:false, code:"bound-config-invalid" }` — the code is payload, never a process exit code.
- [ ] **Test (per-run clamp, AC2b):** run whose manifest declares ceiling 2,000,000 with minted `limitMicroUsd` 1,500,000 runs with effective ceiling 1,500,000 and a `{bound:"spend", action:"clamped"}` **trace/log** row — not a journal `resident` key, whose set DF3.3 closed.
- [ ] **Test (no host-side cap read, INV-BND-2):** grep of `src/phase-engine/` finds **no** read of `.sandbox/runs/` and no read of `.sandbox/cost-config.json`. A manifest reaching `loadResidentBounds` with no `limitMicroUsd` runs **unclamped** — no clamp row, no refusal: the field bounds the provider key, not the resident bound, and an implementation that refuses on its absence (or bare-throws, producing an unclassified crash and a marker-absent box) MUST fail.
- [ ] **Test (per-phase iteration bound fires, AC3):** a phase declaring `retries: 5` whose gate fails every attempt stops soliciting at the **fourth** `post_gate_failure` point, completes on the deterministic path, and the next phase solicits normally. Counter is this story's own, not `telemetry.steeringIterations`: a resident replying `proceed` on every solicitation is still bounded, and an implementation bounding `steeringIterations` MUST fail.
- [ ] **Test (zero-usage charging, AC4/INV-BND-3):** a reply with no usage object is charged the projected worst case; an implementation leaving `meter`'s `clampTerm`-to-zero arm untouched MUST fail.
- [ ] **Test (degraded precedence, AC5):** a resident that degrades at solicitation 2 and would have breached at solicitation 4 ends the run `"degraded"`, not `"stopped"`; the bound is recorded on the log line only. An implementation overwriting `"degraded"` with `"stopped"` MUST fail.
- [ ] **Test (ceiling reachability, AC6):** at the shipped fixture rate the reachability row reports `binding` for the default 8,000 µ$ ceiling on a five-phase `retries: 3` manifest and `unreachable` for 50,000 µ$ on the same manifest; at a frontier-priced fixture slug it reports `below_one_call` and the resident is stopped with `code:"bound-config-invalid"`. An implementation reporting `spend_ceiling_breach` at `run_start` for a ceiling below one call's projection MUST fail.
- [ ] **Test (`loadResidentBounds` is actually called, AC2a):** a pipeline run with an ordering-invalid manifest refuses **through `scripts/pipeline-run.ts`**, not only through a direct unit call — the marker is written and no resident is armed. An implementation that exports `loadResidentBounds` without wiring it passes every direct unit test and MUST fail this one.
- [ ] **Test (e2e demo — MANDATORY):** `pipeline.bounds.json` + `pi-catalog-bounds/openrouter.json` run writes `out.json` with `resident.status:"stopped"`, `resident.spendMicros` strictly below the ceiling at every point, a full-shape `{runId, cause:"spend_ceiling_breach", phase:"build", detail}` tripwire row, and all remaining phases/gates executed deterministically. The refusal must be **projection-driven**: an implementation comparing metered spend after the call reproduces the outcome and MUST fail AC1's control.

## Dev Agent Record

<!-- Empty placeholder — filled during development. -->

---

## Split Record — 2026-09-08 (QDS story-review campaign)

Split from `df3-6-resident-agent-bounds.md` (deleted at the split; both halves carry its content).
Findings resolved in this half, from `_bmad-output/evidence/qds-story-review-2026-09-08/scan-C-df3-6.md`:

**BLOCKERs:** B2 (three operands stamped onto the frozen manifest; the "absent config falls back to
the documented default" fallback deleted — it was the false green), B3 (`runBudgetCapMicros` → the
shipped `defaultCapMicroUsd`, three denominators stated, the false "the resident can never consume
the run's budget" claim deleted), B4 (`maxSteeringIterations` 8 → **3**, below `MAX_RETRIES = 5`,
plus a producible AC3 trigger), B5 (the mandatory e2e demo re-derived against a priced catalog
fixture: 760,960 µ$ per call, projection-driven), B6 (the blanket "no edit to a DF3.3-owned line"
replaced by an enumerated, closed carve-out; `scripts/pipeline-run.ts` added).

**HIGHs:** H4 (the ceiling bound at ~3,968 calls and could not fire in production; default lowered
to a **derived** 50,000 µ$, ~99 solicitations, with the derivation written down — later re-derived
again by Wave 5b B1 to the shipped **8,000 µ$ fallback** with the ~16-call derivation; the
Technical Notes ladder is the operative text and this entry is provenance), H5 (precedence
against an already-degraded resident — previously undefined — now AC5 with a negative control),
H6 (AC3 bounded a quantity the code does not count; this story keeps its own per-phase
*solicitation* counter, because `telemetry.steeringIterations` stays at zero for a proceed-loop).

**MEDIUMs / LOWs:** M1 (the 2026-08-20 revision's "fix" was itself drifted — `resolveRate` is
shipped and already threaded to the engine as `deps.rate`; this story loads no models.json),
M2 (D4 tripwire (a) made computable, with DF2.12 named as what makes its denominator honest),
M4 (the clamp row and the bounds-check line routed to the trace/log stream, not the closed journal
block), M6 (sizing — resolved by this split), L3 (`.strict()` noted), L4 (AC2b's second negative
control downgraded from a live control to the fence it actually is).

**Also carried:** the three in-box *correct-intent-wrong-mechanism* clauses from the scan's
reconciliation — the AC2a refusal writes the terminal marker instead of relying on an exit code and
a printed teardown command; and AC2b's clamp row goes to the trace/log stream. The third — "the
missing `limitMicroUsd` refusal defers to `runContextFrom`'s existing reconciliation instead of
duplicating it" — was **reversed in wave 5b (V-DF3.6a-B3)**: `runContextFrom` does not refuse on
plain absence, so the refusal is owned here after all. Recorded rather than deleted, because it is
the one scan-C disposition that read as a simplification and was in fact a deleted guard. The
`:68-71` / `:84-86` placement reasoning is preserved verbatim in AC2 — it is the story's strongest
text and is now ADR Appendix B's direction.

**Wave 5c (2026-09-08) — MEDIUMs and LOWs closed in this half.** **M1** (`steering.ts:441-442` →
`:435-436`, the lines that actually carry the zero-usage disposition, corrected in both the AC4
negative control and the DoD ledger item), **M2** (the once-per-run argument is a property of the
*callers* — `scripts/pipeline-run.ts:3441`/`:3619`/`:2059` — not of the `SteeringPoint` type alias
at `steering.ts:86-87`; `POINT_ALLOWLIST` is at `:136` and says nothing about run scope), **M3**
(the divergent-copy list was wrong in both directions, and **the verifier's own correction was
itself incomplete** — it missed DF2.8 `:201` and DF5.5 `:360`; the list is now DF2.3 `:123`/`:211`,
DF2.4 `:138`/`:145`, DF2.8 `:201`, DF5.5 `:360` and `credentials.ts:46`, with DF2.7 `:134` and
DF2.12 `:25` excluded as prose rather than copies. **M3 also turned out to be bigger than a naming
defect and is now an open question, not a closed finding:** `runBudgetCapMicros` *is* declared
(`scripts/cap-hit-demo.ts:97`,`:148`) but only as an evidence-artifact field behind a
`--budget-cap` flag — it enforces nothing, so the chain's middle term has no production home and a
production docstring claims this story asserts against it. Stated in Technical Notes with both
options and **awaiting an operator ruling; owner: campaign lead — RULED 2026-09-08/09-13:
`mintRunKey`'s per-run cap IS the middle term (`capMicroUsd`), wired from the admission budget by
DF2.13 (landed); see the RESOLVED block in Technical Notes**), **L1** (`steering.ts:822-827` →
`:820-821` for the one-way-latch sentence), **V-CC-C4** (D4 tripwire (b) named as already shipped in
DF3.3's `gate_bypass_attempt`, so the D4 citation reads as complete: (a) here, (b) shipped,
(c) DF3.6b). The `src/providers/credentials.ts:46` docstring was **no longer deferred** in Wave 5c —
it was scoped to one comment line with its replacement text written out — and is **superseded
2026-09-13**: the docstring is already corrected at source (it carries the `≤` chain with the old
text inside an explicit "This docstring previously read…" quote), so `credentials.ts` stays a
no-edit Files entry (see Technical Notes "single owner of the cap chain").

**Nothing is deferred out of this half.**

**Wave 5b (2026-09-08) — verifier findings resolved in this half.** From
`_bmad-output/evidence/qds-story-review-2026-09-08/verify-C-df3-6ab.md`: **B1** (the ceiling was
derived wrongly twice; now 8,000 µ$ with the full derivation shown against `2 + 3P`, plus AC6 so a
misconfigured rate is reported as a misconfiguration and not a runaway), **B2** (the
`steering.ts:11-13` boundary is engine↛**fleet**, not engine↛**provider** — three shipped engine
files already import `../../providers/bounded-exec.ts`, one of them this story's own `resolveRate`
source, so the DoD grep could never pass; the gate is now the four named modules/paths and the
argument is the absent host path, not an import ban), **B3** (`runContextFrom` is at
`scripts/pipeline-run.ts:797`, not in `manifest.ts`, and does **not** refuse on plain absence — the
absence refusal was deleted on a false premise and is now owned here with AC2a's marker shape),
**H1** (AC3's trigger was unreachable from its own Given — a gate failing on *every* attempt fails
the phase; now fails 1–4 / passes 5, with a per-invocation counter file), **H2** (`fleet status`
reports `not-ok` for a present marker; `engine-failed` is the marker-absent state), **H3** (the
precedence list omitted the tier-3 harness kill, which binds *first* at ~$0.45 and kills the **run**
— the one outcome INV-BND-5 forbids), **H4** (Files to Modify omitted the `loadResidentBounds` call
site and the marker writer, so AC2a would have been dead code — the `ingestCostEvent` shape).

**Sprint tag corrected 2026-09-08.** DF3.6 was re-sequenced **v5-S2 → v5-S3 on 2026-08-31** as part
of the ADR arc (it cannot precede the engine relocation it depends on). `sprint-status.yaml:43`
recorded it; the story file was never updated and carried the stale `v5-S2` tag for eight days,
which both halves inherited at the split. The yaml was authoritative throughout.

**Not in this half:** DF3.6-M3 and DF3.6-L1/L2 are memory-path findings and are resolved in DF3.6b.
