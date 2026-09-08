# Verify-C — DF3.6a / DF3.6b (split pair): adversarial pre-development review

**Reviewer:** verify-C (first-time review, beginner's mind)
**Date:** 2026-09-08
**Targets:**
- `_bmad-output/sprint-artifacts/dark-factory-v5/stories/df3-6a-resident-spend-iteration-bounds.md` (502 lines)
- `_bmad-output/sprint-artifacts/dark-factory-v5/stories/df3-6b-resident-memory-bound-cgroup.md` (364 lines)

**Pre-split original recovered from git** (`git show HEAD:…/df3-6-resident-agent-bounds.md`, 302 lines, staged `D`) and read in full before either half.

**Ground truth read:** ADR `2026-08-31-tier2-placement-adr.md` in full including Appendices A and B; design doc §3.1/§4 D4/§5.1/§5.2/§6.2; `df3-3`, `df1-10`, `df1-11`, `df2-3`, `df2-4`, `df2-7`, `df2-8`, `df2-10`, `df5-1`; `sprint-status.yaml`. **Shipped code opened and line-verified:** `src/fleet/resident.ts` (707 lines, full), `src/phase-engine/{steering,manifest,types,journal}.ts`, `src/phase-engine/roster/validate.ts`, `src/phase-engine/phases/dispatch-task.ts`, `src/providers/{cost-ledger,credentials}.ts`, `src/providers/exedev/driver.ts`, `src/reverify/worktree.ts`, `src/fleet/status.ts`, `scripts/pipeline-run.ts`, `oci/exedev/Dockerfile`, `oci/exedev/systemd/qds-run@.service`, `cli-anything/src/{types,runner}.ts`, the pi-catalog and resident pipeline fixtures.

**Drift rule applied:** shipped code wins unless it contradicts the ADR. One ADR contradiction found (V-DF3.6b-H1) — raised, not resolved here.

---

## Counts

| Severity | DF3.6a | DF3.6b | Cross-cutting | Total |
|---|---|---|---|---|
| BLOCKER | 3 | 3 | 0 | **6** |
| HIGH | 4 | 5 | 1 | **10** |
| MEDIUM | 3 | 4 | 2 | **9** |
| LOW | 2 | 4 | 1 | **7** |
| | | | | **32** |

---

## BLOCKERs (one line each)

- **V-DF3.6a-B1** — the re-derived 50,000 µ$ ceiling still cannot fire: AC3's own 3-per-phase bound caps a run at `2 + 3P` solicitations (32 calls = 16,128 µ$ for a ten-phase manifest), and `retries` is schema-defaulted to **0**, so a default manifest reaches 2 calls = 1,008 µ$.
- **V-DF3.6a-B2** — the DoD's "engine imports no fleet or provider module (`grep` returns nothing)" is falsified by three shipped imports of `../../providers/bounded-exec.ts`, one of them in the very module this story depends on for `resolveRate`.
- **V-DF3.6a-B3** — INV-BND-2's fail-closed discharge cites `runContextFrom` at the wrong file *and* the function does not refuse on absence: it returns a ceiling-less context and the story's own AC2a refusal shape is bypassed by a bare throw.
- **V-DF3.6b-B1** — `lastMemory()` is declared on `ResidentSpawn`, which the engine never receives (`createSteering` takes only `spawned.caller` and `spawned.rate`), so the OOM fact cannot reach the one internal writer AC1 depends on — and the fix needs a third `createSteering` dep that DF3.6a's carve-out declares closed.
- **V-DF3.6b-B2** — the `sh -c` placement wrapper fails **open**: a failed `echo $$ > cgroup.procs` does not stop the script, and `exec "$@"` runs pi unbounded, which is exactly what INV-MEM-2 forbids.
- **V-DF3.6b-B3** — INV-MEM-2 plus "no darwin/Linux probe split" plus a non-optional `residentRssBytes: number` disables the resident on every non-cgroup host, breaking the 42 `startResident(` sites in `tests/fleet/resident.test.ts` and three more shipped host-side suites.

---

## Split-integrity accounting

Original DF3.6 (302 lines) → DF3.6a (502) + DF3.6b (364). Item-by-item.

### Acceptance criteria

| Original | Landed | Verdict |
|---|---|---|
| AC1 pre-flight spend refusal | DF3.6a AC1, verbatim + negative control preserved | ✔ exactly one half |
| AC2(a) config-time ordering | DF3.6a AC2(a), materially expanded (three stamped operands) | ✔ |
| AC2(b) per-run clamp | DF3.6a AC2(b) | ✔ |
| AC3 per-phase iteration bound | DF3.6a AC3, re-aimed at *solicitations issued* | ✔ (but see V-DF3.6a-H1) |
| AC4 RSS kill + `exitStatus:"overflow"` | DF3.6b AC1, re-mechanised kernel-side | ✔ |
| AC5 sentence 1 — zero-usage metering | DF3.6a AC4 | ✔ |
| AC5 sentences 2–4 — tree enumeration, per-process platform dispatch, sum-across-descendants | **deleted with a stated reason** (DF3.6b :205-219: a cgroup makes the walk moot) | ✔ deletion is reasoned and ADR-backed |
| AC5 final clause — unwatchable ⇒ not started | DF3.6b AC3, re-worded "unenforceable" | ✔ |
| — | DF3.6a AC5 (degraded precedence) — **net-new**, from scan-C H5 | ✔ additive |
| — | DF3.6b AC2 (cgroup scoping) — **net-new**, from ADR Appendix B | ✔ additive |

### Invariants

| Original | Landed | Verdict |
|---|---|---|
| INV-BND-1 | DF3.6a, verbatim + a pointer to INV-MEM-1 | ✔ |
| INV-BND-2 | DF3.6a, expanded | ✔ text, ✘ substance (V-DF3.6a-B3) |
| INV-BND-3 | DF3.6a, verbatim | ✔ |
| INV-BND-4 | DF3.6a, verbatim | ✔ |
| INV-BND-5 sentence 1 (breach narrowness) | DF3.6a | ✔ |
| INV-BND-5 sentence 2 (unsamplable ⇒ not started) | DF3.6b INV-MEM-2, with a cross-pointer in DF3.6a | ✔ |
| — | INV-MEM-1 / INV-MEM-3 — net-new | ✔ additive |

### Technical Notes and DoD

Every original Technical Note is accounted for. Three original notes were re-written rather than moved and the re-write is stated in the split record (`runBudgetCapMicros` → `defaultCapMicroUsd`; the `resolveRate` drift; the RSS watchdog → cgroup). The DoD grew 10 → 12 + 10 = 22 items; every original item maps forward.

### ORPHANS — described by one half, owned by neither (**V-CC-C1, HIGH**)

1. **The post-kill solicitation guard.** The original `checkBounds` rejected a call "when … the RSS watchdog has already killed the resident tree" (orig `:24-27`). DF3.6a's Overview (`:41-45`) drops that third clause; DF3.6b never re-homes it. Traced against shipped code, this is not cosmetic: an OOM-killed pi child is a signal death (`src/fleet/resident.ts:606-627`), which sets `lastExit = "transient"` and throws; the engine's call-failure path degrades the resident. **Nothing calls `stop()`, nothing latches, and the next solicitation point is reachable.** See V-DF3.6b-H2 — DF3.6b's own tripwire-(c) reasoning depends on the latch it never arranges.
2. **DF2.4's group-kill doctrine / risk R3.** The original bound the kill path to it (orig `:197-198`, DoD `:274`). DF3.6b deletes the kill path with a stated reason ("no SIGTERM→grace→SIGKILL sweep to write", `:210-211`) — good — but still cites **risk R3** in its Spec Reference (`:28`) with nothing left in the story that discharges it. Either drop the R3 citation or say in one line that the kernel discharges it.
3. **`residentRssBytes` = 512 MiB.** The one value that crosses the seam is the one value neither half re-derived. Every *other* default was re-derived at the split (`maxSteeringIterations` 8→3 with a structural argument; `residentSpendCeilingMicros` 2,000,000→50,000 with an arithmetic argument). 512 MiB survives verbatim from the 2026-08-20 text with no measurement, no pi baseline-RSS figure, and no citation — carried by DF3.6a (`:250-251`) as a value it "validates", applied by DF3.6b as a value it "applies". See V-DF3.6b-M2.

### Contradictions between the halves

- **DF3.6a's carve-out is closed at two new `createSteering` deps; DF3.6b needs a third.** DF3.6a `:386-387` enumerates `bounds` and `onBoundBreach` and states the list is "enumerated and closed — … nothing outside this list". DF3.6b `:260-264` claims its single `steering.ts` edit is "inside DF3.6a's already-enumerated carve-out" — but the internal `exitStatus` writer needs the OOM fact, which only a new dep can carry (V-DF3.6b-B1).
- **`residentRssBytes` absence has three incompatible answers** across the pair (V-DF3.6b-M3).
- **Both halves claim `scripts/pipeline-run.ts` gets "No other change"** for two different changes (V-CC-C2).

### Verdict

**Split integrity: PASS on content, FAIL on seam mechanics.** Nothing from the original was lost silently; every deletion carries a reason and the reasons are sound and ADR-backed. But the seam itself is not closed: the one value that crosses it (`residentRssBytes`) is unre-derived, the one fact that must cross back (`oomKilled`) has no channel, and the two halves disagree about whether DF3.6a's edit list is open.

---

## DF3.6a — findings

### V-DF3.6a-B1 · BLOCKER · `df3-6a…md:240-249` (Technical Notes), `:104-110` (AC1), `:451` (DoD)

**Defect.** The derived default `residentSpendCeilingMicros = 50,000 µ$` cannot fire on any realistic manifest, and the derivation that produced it double-counts a runaway its own AC3 forbids.

The story's arithmetic is correct as far as it goes — I re-verified it end to end. The pi catalog fixture (`tests/phase-engine/fixtures/pi-catalog/openrouter.json`) prices `deepseek/deepseek-v4-flash-0731` at 0.08/0.18 USD per MTok; `resolveRate` converts through `toMicrosPerMTok(value, "usd-per-mtok")` (`src/phase-engine/roster/validate.ts:221-227,333`) to 80,000/180,000 µ$/MTok; the projection `(16_000/4 × 80_000 + 1_024 × 180_000)/1e6 = 504.32 → 504 µ$` ✔. `50,000 / 504 ≈ 99.2` ✔.

What is wrong is the denominator on the other side. The story writes:

> 50,000 µ$ therefore binds at ~99 solicitations, comfortably above a healthy run's maximum (`1 run_start + 1 run_end + Σ_phases retries`, with `retries ≤ MAX_RETRIES = 5` — at most 52 for a ten-phase manifest) and far below a runaway's.

Two independent errors:

1. **AC3's own bound removes the runaway.** `maxSteeringIterations = 3` caps *solicitations issued* per phase. `run_start` and `run_end` are once per run (`scripts/pipeline-run.ts:3441`, `:3619` — one call site each, outside the phase loop), and `post_gate_failure` is the only per-phase point. So the structural maximum for a run **with this story's own bounds in force** is `2 + 3P`, not `2 + 5P`. Ten phases → 32 calls → **16,128 µ$**, one third of the ceiling. There is no runaway above `2 + 3P`, because AC3 is what stops it.
2. **`retries` is schema-defaulted to zero.** `src/phase-engine/manifest.ts:225`: `retries: z.number().int().min(MIN_RETRIES).max(MAX_RETRIES).default(MIN_RETRIES)` with `MIN_RETRIES = 0` (`src/phase-engine/types.ts:30`). A phase that does not declare `retries` produces **zero** `post_gate_failure` solicitations — the retry loop at `scripts/pipeline-run.ts:2028-2044` throws at `attempt > spec.retries` before ever reaching the solicitation at `:2059`. So a default manifest reaches **2** solicitations = 1,008 µ$. `MIN_PHASES = 2` (`src/phase-engine/types.ts:57`), and the repo's own resident fixture declares `retries: 0` and `retries: 1`.

Solving `504 × (2 + 3P) > 50,000` gives **P ≥ 33 phases, every one declaring `retries ≥ 3`**. No such manifest exists or is plausible.

**Concrete failure scenario.** A ten-phase pipeline with `retries: 5` on every phase, a resident that replies `proceed` on all 32 solicitations, and a leaking prompt context: total resident spend 16,128 µ$ at worst-case projection, real metered spend far below that (the ADR's own live measurement is $0.000025 = 25 µ$ per solicitation, `adr:83`). The ceiling never evaluates true. AC1's make-or-break is demonstrable *only* against `pi-catalog-bounds/openrouter.json`, a fixture priced at 180 USD/MTok — 2.4× the most expensive real frontier model — chosen precisely so a three-call demo can breach 2,000,000 µ$. The ceiling is a number in a manifest, not a control.

**The mirror-image edge, also unaddressed.** At frontier rates ($15 in / $75 out per MTok) the projection is `4_000 × 15 + 1_024 × 75 = 136,800 µ$` — **the ceiling is breached before the first solicitation**. `checkBounds` at `run_start` computes `0 + 136,800 > 50,000`, refuses, and stops the resident with `bound:"spend"` and `cause:"spend_ceiling_breach"`. A misconfigured slug is reported as a runaway. Nothing validates ceiling against rate, and nothing can at `loadResidentBounds` time: the rate arrives as `spawned.rate` at `createSteering` (`scripts/pipeline-run.ts:~3295`), *after* `startResident` at `:3255`.

**Fix recipe.** Replace the Technical Notes bullet at `:240-249` with:

> `residentSpendCeilingMicros` = **8,000 µ$ ($0.008) per run**, absolute. **Derived, not chosen, against this story's own iteration bound.** The projection is fixed at `(PROMPT_CHAR_CEILING/4 × inputPerMTok + MAX_OUTPUT_TOKENS × outputPerMTok)/1e6` — both ceilings are constants (`src/phase-engine/steering.ts:21,24`) — which is **504 µ$** at the resident slug's shipped rates (`tests/phase-engine/fixtures/pi-catalog/openrouter.json`: 0.08 / 0.18 USD per MTok, converted by `toMicrosPerMTok` at `src/phase-engine/roster/validate.ts:221`). The structural maximum number of solicitations in one run is **`2 + maxSteeringIterations × phaseCount`** — `run_start` and `run_end` once each (`scripts/pipeline-run.ts:3441`, `:3619`), and AC3 caps `post_gate_failure` at `maxSteeringIterations` per phase, *below* the `retries` ceiling. For the ten-phase worst case that is 32 calls ≈ **16,128 µ$**; for the common case it is far less, because `retries` is schema-defaulted to `MIN_RETRIES = 0` (`src/phase-engine/manifest.ts:225`) and an undeclared `retries` yields **zero** `post_gate_failure` points. 8,000 µ$ therefore binds at ~16 calls — roughly half the ten-phase structural maximum, and reachable on a five-phase manifest with retries. **The previous defaults were both unreachable: 2,000,000 µ$ bound at ~3,968 calls, and the 50,000 µ$ that replaced it still bound at ~99, above the 32-call structural maximum the iteration bound itself imposes.** Recompute at authoring time — the 504 µ$ figure moves with the roster, and the ceiling must be re-derived against `2 + maxSteeringIterations × phaseCount`, never against `Σ retries`.

And add to Acceptance Criteria:

> 6. **The ceiling is checked against the rate it will be compared to, once, where the rate exists.** Given `deps.rate` is resolved at `createSteering` (`src/phase-engine/steering.ts:395`), When bounds are attached, Then the engine computes `projectedPerCall` and `maxSolicitations = 2 + maxSteeringIterations × phaseCount` and writes one **trace/log** row: `{ bound:"spend", check:"reachability", projectedMicros, effectiveMicros, maxSolicitations, verdict }` where `verdict` is `"unreachable"` when `effectiveMicros ≥ projectedMicros × maxSolicitations`, `"below_one_call"` when `effectiveMicros < projectedMicros`, and `"binding"` otherwise. A `"below_one_call"` verdict additionally stops the resident with `cause:"bound-config-invalid"` **rather than** `spend_ceiling_breach`, because a ceiling under one call's projection is a misconfiguration and must not be reported as a runaway. The run proceeds deterministic in every case. *Negative control: an implementation that reports `spend_ceiling_breach` at `run_start` for a ceiling below one call's projection makes a misconfiguration indistinguishable from a loop, and MUST fail this test.*

### V-DF3.6a-B2 · BLOCKER · `df3-6a…md:443` (DoD Security); also `:120`, `:225`, `:414`

**Defect.** The DoD gate is falsified by shipped code and the citation behind it says something else.

DoD `:443`: "the engine imports no fleet or provider module (`grep` over `src/phase-engine/` returns nothing)". Measured:

```
src/phase-engine/gates/command-gate.ts:17:import { EXEC_MAX_OUTPUT_BYTES, readBounded } from "../../providers/bounded-exec.ts";
src/phase-engine/roster/validate.ts:34:import { EXEC_MAX_OUTPUT_BYTES, readBounded } from "../../providers/bounded-exec.ts";
src/phase-engine/phases/test-results.ts:37:import { EXEC_MAX_OUTPUT_BYTES, readBounded } from "../../providers/bounded-exec.ts";
```

Three hits, one of them in `roster/validate.ts` — the module that exports `resolveRate`, on which this story's entire projection depends (`:228`, `:440`). The DoD item can never pass; the story is undeliverable as written.

The citation used to justify it is also wrong. `src/phase-engine/steering.ts:11-13` reads verbatim:

> `Fleet imports this through the engine barrel; this file never imports fleet code (module boundary, story R3 §9.2).`

That is an engine↛**fleet** boundary. The story cites it four times (`:120`, `:225`, `:414`, `:443`) as the authority for an engine↛**provider** boundary that does not exist.

**Concrete failure scenario.** The story's central design decision — stamping `defaultKeyCapMicroUsd` and `defaultCapMicroUsd` onto the frozen manifest rather than importing them — is justified by a boundary that is not there. A reviewer who checks the boundary and finds it fictitious has a live argument for importing `src/providers/credentials.ts` directly, which would reintroduce the exact host-path read INV-BND-2 exists to prevent.

**Fix recipe.** Replace the DoD Security bullet at `:443` with:

> - [ ] **Security:** no bound is readable or writable from any path the resident controls; no public setter for `telemetry.status` is added — the controller keeps its snapshot-only getter (`steering.ts:961-967`); the engine imports **no fleet module** (`steering.ts:11-13`, the shipped boundary) and imports **neither `src/providers/credentials.ts` nor `src/providers/cost-ledger.ts`** and reads **neither `.sandbox/runs/` nor `.sandbox/cost-config.json`** (`grep` over `src/phase-engine/` returns nothing for those four). *(A blanket "no provider import" grep is NOT the gate and would fail on shipped code: `gates/command-gate.ts:17`, `roster/validate.ts:34` and `phases/test-results.ts:37` already import `../../providers/bounded-exec.ts`, and `roster/validate.ts` is this story's own `resolveRate` source.)*

And in AC2(a) `:119-121` and INV-BND-2 `:413-415`, replace "the engine reads no host path and imports no provider module (`src/phase-engine/steering.ts:11-13`, module boundary)" with:

> the engine reads no host path: `defaultKeyCapMicroUsd` is a constant in `src/providers/credentials.ts`, and `defaultCapMicroUsd` is read from `.sandbox/cost-config.json` (`src/providers/cost-ledger.ts:444`), a **host-side** path that does not exist inside the box. The in-box engine therefore cannot obtain either value at run time, whatever its import graph permits.

### V-DF3.6a-B3 · BLOCKER · `df3-6a…md:150-153`, `:226`, `:421-423`, `:447`

**Defect.** INV-BND-2's fail-closed requirement for `limitMicroUsd` is discharged by a refusal that does not exist, cited to the wrong file, and the story deleted the only refusal that would have covered it.

Cited five times: "`runContextFrom` already refuses on absence or disagreement against `run-context.json`'s `effectiveCeilingMicros` (`src/phase-engine/manifest.ts:303-314`, which is why the schema field is `.optional()`: the reconciliation, not the loader, is the gate)".

Two problems.

**(i) Wrong file.** `runContextFrom` is at **`scripts/pipeline-run.ts:797`**. `src/phase-engine/manifest.ts:303-314` is a *comment block* whose own text says so: `":306: // pre-stamp read, and \`runContextFrom\` in \`scripts/pipeline-run.ts\` — which"`. The function is not in `src/phase-engine/` at all.

**(ii) It does not refuse on absence.** `scripts/pipeline-run.ts:804-825`:

```ts
if (manifest.limitMicroUsd === undefined) {
  …
  if (!witnessPresent(witness.manifestPath)) return ctx;      // ← no throw
  …
  return { ...ctx, effectiveCeilingMicros: admittedCeilingBeside(…) };
}
const admitted = admittedCeilingBeside(witness.manifestPath, witness.runRoot, true);
if (admitted !== manifest.limitMicroUsd) throw new Error(…);   // ← disagreement only
```

The function's own comment is explicit: **"ABSENCE is still the only thing that leaves the field unset."** It refuses on *disagreement* and on a stale/unreadable witness. On plain absence with no witness it returns a `RunContext` with `effectiveCeilingMicros` undefined and the run proceeds.

**Concrete failure scenario.** A manifest reaches the box without `limitMicroUsd` and without a witness beside it — the shipped code explicitly contemplates this and admits it. `runContextFrom` returns. `loadResidentBounds` then hits the arm the story specified at `:155-157`: "asserts the value is present and treats absence as an engine invariant violation (**throw**), never as a policy decision it re-makes". That throw carries no terminal marker, no `code:"bound-config-invalid"`, no `remediation` — it escapes to the top-level catch, which stderr-and-exits. The operator sees an unclassified crash instead of AC2a's designed refusal, and `fleet status` sees a **marker-absent** box. The story deleted the duplicate refusal on purpose (`:155-157`: "a second independent refusal would be either dead code or a second source of truth") on a premise that is false.

**Fix recipe.** Correct every citation from `src/phase-engine/manifest.ts:303-314` to `scripts/pipeline-run.ts:797-836`, and replace the AC2(b) clause at `:150-157` with:

> The value is read **only** from the frozen manifest: the engine runs inside the box, where the host-side `.sandbox/runs/<id>.json` record does not exist. `runContextFrom` (`scripts/pipeline-run.ts:797-836`) refuses on **disagreement** — a declared `limitMicroUsd` that does not equal the ceiling dispatch recorded beside the manifest — and on a stale or unreadable witness, but it does **not** refuse on plain absence: its own comment states "ABSENCE is still the only thing that leaves the field unset", and it returns a context with no `effectiveCeilingMicros`. INV-BND-2's fail-closed rule is therefore **owned here, not one layer up**: a manifest reaching `loadResidentBounds` without `limitMicroUsd` **refuses the run** through the same AC2a path — terminal marker, `{ ok:false, code:"bound-config-invalid", message, remediation }`, no resident spawned. This is not a duplicate of the reconciliation; the reconciliation covers a different predicate. *Negative control: an implementation that treats absence as an engine invariant violation and bare-throws — on the belief that `runContextFrom` already refused it — produces an unclassified crash and a marker-absent box on a manifest dispatch legitimately admitted, and MUST fail this test.*

Update the DoD item at `:447` correspondingly, and drop the "which is why the schema field is `.optional()`" rationale — the field is `.optional()` (`src/phase-engine/manifest.ts:314`) because a hand-authored `pipeline.yaml` may legitimately omit it, not because the reconciliation gates it.

### V-DF3.6a-H1 · HIGH · `df3-6a…md:177-186` (AC3 producible trigger), `:448` (DoD)

**Defect.** AC3's producible trigger contradicts itself, contradicts the fixture it says it copies, and omits the one number that makes it buildable.

The AC says: "given a phase declaring `retries: 5` **whose gate fails on every attempt** … When the **fourth** `post_gate_failure` solicitation point in that phase is reached, Then the engine does not solicit, **the remaining retry attempts run on the deterministic path, and the next phase solicits normally**."

Verified against `scripts/pipeline-run.ts:2028-2059`:

```ts
for (let attempt = 1; ; attempt += 1) {
  try { return await gatedBody(…)(base)(bodyCtx); }
  catch (err) {
    if (bodyCtx.signal.aborted) throw err;
    if (!(err instanceof GateFailureError) || attempt > spec.retries) throw err;   // :2044
    …
    const directive = await solicitResident(resident.steering, "post_gate_failure", { … });  // :2059
```

A gate that fails on **every** attempt exhausts `retries` and rethrows `GateFailureError` at attempt `retries + 1`. The phase **fails**. There is no "next phase" to solicit. The AC's own Then-clause is unreachable from its own Given-clause.

The fixture it cites is the opposite shape: `tests/phase-engine/fixtures/pipeline.resident.json`'s `build` phase declares `retries: 1` and a `testCommand` that **passes** at attempt 2 (`test "$n" -ge 2`). To observe a *refused fourth* point with `maxSteeringIterations = 3` and still see the phase complete, the gate must fail on attempts 1–4 and pass at attempt 5 — i.e. `test "$n" -ge 5` with `retries: 5`. The AC never states N.

**Second defect, same AC.** The copied `$TMPDIR/qds-resident-fixture-count` counter is never reset. A second run in the same `TMPDIR` starts at `n ≥ 5` and the gate passes on attempt 1, producing **zero** solicitations. AC3's make-or-break test is order-dependent on a file shared across runs — a green that means nothing on the second invocation.

**Third defect, minor.** `scripts/pipeline-run.ts:2054` is cited for "the retry loop exits at `attempt > spec.retries`". `:2054` is a comment line inside the `HISTORICAL DRIFT NOTE`; the predicate is at **`:2044`**.

**Fix recipe.** Replace `:177-186` with:

> **Producible trigger (the bound must fire, not merely exist):** given a phase declaring `retries: 5` whose gate **fails on attempts 1–4 and passes on attempt 5** — `tests/phase-engine/fixtures/pipeline.bounds.json` declares it, adapting the `build` phase of `tests/phase-engine/fixtures/pipeline.resident.json` to `test "$n" -ge 5` — When the **fourth** `post_gate_failure` solicitation point in that phase is reached, Then the engine does not solicit, attempt 5 runs and passes on the deterministic path, the phase completes, and the next phase solicits normally. The counter file MUST be per-invocation (`"$TMPDIR/qds-bounds-count-$$"` or a path the test seeds and removes in a `finally`): the shipped resident fixture's fixed `$TMPDIR/qds-resident-fixture-count` survives between runs, and a second run against a stale counter passes at attempt 1 and produces zero solicitations — a green that proves nothing. `post_gate_failure` is the only per-phase solicitation point (`run_start`/`run_end` are once per **run** — one call site each, `scripts/pipeline-run.ts:3441` and `:3619`), and the retry loop exits at `attempt > spec.retries` (`scripts/pipeline-run.ts:2044`), which is what makes `retries` the structural ceiling on this bound. Note `retries` is schema-defaulted to `MIN_RETRIES = 0` (`src/phase-engine/manifest.ts:225`), so the fixture must declare it explicitly; see the default's derivation in Technical Notes.

Mirror the same correction into the DoD item at `:448`.

### V-DF3.6a-H2 · HIGH · `df3-6a…md:126-131` (AC2a)

**Defect.** AC2a asserts a `fleet status` outcome the shipped mapping contradicts.

The AC says the refusal "writes the **terminal marker** with `{ ok:false, code:"bound-config-invalid", message, remediation }` … which `fleet status` surfaces as `engine-failed`".

`src/fleet/status.ts:91`: "`engine-failed` — **the marker is absent** and the unit is `failed`." `src/fleet/status.ts:1311`: `if (activity === "failed") return "engine-failed";`. The `InBoxState` union is `"running" | "ok" | "not-ok" | "unknown" | "engine-failed" | "not-running"` (`:1119`). A **present** marker carrying `ok:false` resolves to `not-ok`, not `engine-failed`; `engine-failed` is the marker-absent-and-unit-failed case.

**Concrete failure scenario.** A dev writes the AC2a test, asserts `fleet status` reports `engine-failed`, and it reports `not-ok`. Either the test is rewritten to the truth (fine, one wasted hour) or — worse — the implementer "fixes" it by *not* writing the marker, which restores the exact exit-code-as-error-code pattern DF3.1 AC3 forbids and the split record `:486-488` says it deliberately replaced.

**Fix recipe.** In `:128`, replace "which `fleet status` surfaces as `engine-failed`" with:

> which `fleet status` surfaces as `not-ok` (`src/fleet/status.ts:91,1119` — `engine-failed` is the **marker-absent** state and must not be the observable here: writing the marker is the whole point)

### V-DF3.6a-H3 · HIGH · `df3-6a…md:271-286` (Technical Notes, spend-ceiling authority)

**Defect.** A section that opens "three mechanisms, one number, explicit precedence … They are not redundant copies of one budget and the story must not reason as if they were" omits a fourth ceiling that shipped code applies and that a sibling story records as the one that fires **first**.

`cli-anything/src/runner.ts:466,470`:

```ts
export const BUDGET_KILL_FRACTION = 0.9;
…  return budgetCapUsd * BUDGET_KILL_FRACTION;
```

`df2-7-session-cumulative-cost-instrumentation.md:132-136` states the consequence plainly:

> `BUDGET_KILL_FRACTION` = 0.9 of `budgetCapUsd` (default 0.5, max 10) … Left at its `0.5` default it is the *innermost* ceiling and **fires first, killing every run at ~$0.45** while the advertised run budget is $5.00 — the outer caps would then never bind and the containment story [collapses].

**Concrete failure scenario.** DF3.6a's precedence table tells an implementer there are exactly three mechanisms and that "on disagreement, `min()` wins". In fact a fourth control kills the **run** at ~$0.45 — the one outcome INV-BND-5 says a breach must never cause ("never fails the run, a phase, or a gate"). The ordering happens to hold today ($0.05 resident ceiling < $0.45 harness kill < $5.00 issue cap < $50.00 key cap), but nothing states it, nothing asserts it, and a `budgetCapUsd` set below $0.056 would put the harness kill *inside* the resident ceiling — the resident would still be soliciting while the run died. That is a composition failure the section exists to prevent and does not.

**Fix recipe.** Insert as item 0 in the numbered list at `:272`:

> 0. **The tier-3 harness kill** (`budgetCapUsd × BUDGET_KILL_FRACTION`, `cli-anything/src/runner.ts:466,470`; `BUDGET_KILL_FRACTION = 0.9`) is the **innermost** ceiling and, at its `0.5` default, fires first — at ~$0.45, killing the **run** (`df2-7…md:132-136`). It is not this story's to change, and this story never reads it. It is listed because a precedence section that omits the control that binds first is worse than none: the resident ceiling is inside it only as long as `residentSpendCeilingMicros < budgetCapUsd × 0.9`, which is true at the shipped defaults (8,000 µ$ ≪ 450,000 µ$) and is the one relation in this list that a `budgetCapUsd` change can invert.

### V-DF3.6a-H4 · HIGH · `df3-6a…md:394-395` (Files to Modify)

**Defect.** The Files-to-Modify list — deliberately made "enumerated and closed" by scan-C's B6 fix — omits the call site of the story's own primary entry point and the writer of its own refusal.

`:394-395` reads: "`scripts/pipeline-run.ts` — the sole `createSteering` call site (`:3294`); passes `bounds`/`onBoundBreach`. **No other change.**"

But:
- `loadResidentBounds(manifest)` must be **invoked** somewhere, and per AC2a "at manifest load inside the box, before the resident is spawned" — i.e. before `startResident` at `scripts/pipeline-run.ts:3255`, because DF3.6b needs the validated `residentRssBytes` at that call. No file in the list invokes it. `src/phase-engine/manifest.ts` is scoped to "all three bound fields … plus AC2a's two stamped operands" — schema only.
- AC2a's terminal-marker refusal (`{ok:false, code:"bound-config-invalid", message, remediation}`) must be **written** by something. No file in the list writes a marker.

**Concrete failure scenario.** An implementer honouring the closed list ships `loadResidentBounds` as an exported-but-uncalled function and `checkBounds` wired at the seam. Every DF3.6a test that exercises `loadResidentBounds` directly goes green; AC2a never runs in a real pipeline; the config refusal is dead code. This is the same shape as the `ingestCostEvent` hole DF2.12 exists to close (`sprint-status.yaml:169`: "the only writer of `kind='tokens'` rows and has ZERO non-test callers").

**Also:** `createSteering(` is at `scripts/pipeline-run.ts:3295`; `:3294` is `residentSpawn = spawned;`.

**Fix recipe.** Replace `:394-395` with:

> - `scripts/pipeline-run.ts` — **two** edits, both closed: (i) call `loadResidentBounds(manifest)` at manifest load, **before** the `startResident` call site (`:3255`), and on refusal write the terminal marker `{ ok:false, code:"bound-config-invalid", message, remediation }` through the existing marker writer and return without arming a resident (AC2a); (ii) pass `bounds`/`onBoundBreach` at the sole `createSteering` call site (`:3295`). No other change. *(DF3.6b adds a third edit to this same file — `residentRssBytes` on the `startResident` call at `:3255` — and rebases onto these two.)*

### V-DF3.6a-M1 · MEDIUM · `df3-6a…md:190`, `:383`

**Defect.** AC4's negative control quotes shipped code and cites the wrong lines, twice.

The quoted text — "a reply carrying no usage object meters as zero rather than throwing" — is at `src/phase-engine/steering.ts:435-436`:

```
435:   *  for the run. A reply carrying no usage object meters as zero rather than
436:   *  throwing (the never-throws contract covers metering too).
```

`:441-442` is the MAX_SAFE_INTEGER paragraph ("`MAX_SAFE_INTEGER — a finite-but-unsafe term or sum would silently lose` / `micro-dollars on every later addition.`"). The implementation cite `:445-457` (`clampTerm` through `telemetry.spendMicros = next`) is **correct**.

This matters because AC4 is one of only two ACs in the pair that reverses a documented DF3.3 disposition and must be recorded in DF3.3's deviation ledger (`:384`, DoD `:442`) — a ledger entry citing lines that do not say what it claims is a ledger entry a future reviewer discards.

**Fix.** `:441-442` → `:435-436` in both places.

### V-DF3.6a-M2 · MEDIUM · `df3-6a…md:183-185` (AC3)

**Defect.** "`post_gate_failure` is the only per-phase solicitation point (`run_start`/`run_end` are once per **run** — `src/phase-engine/steering.ts:86-87`, `POINT_ALLOWLIST`)".

`POINT_ALLOWLIST` is at **`src/phase-engine/steering.ts:136`**. `:86-87` is the `SteeringPoint` type alias plus its comment ("The three engine-owned solicitation points — there is no fourth."). Neither location says anything about once-per-run — that is a property of the **caller**: `scripts/pipeline-run.ts:3441` (`run_start`) and `:3619` (`run_end`), one call site each, outside the phase loop; `:2059` (`post_gate_failure`) inside it. AC3's structural argument — that `retries` is the ceiling on this bound — is cited to a type alias that cannot support it.

**Fix.** Cite `scripts/pipeline-run.ts:3441`, `:3619` and `:2059`.

### V-DF3.6a-M3 · MEDIUM · `df3-6a…md:291-295` (Technical Notes)

**Defect.** The story claims authority over the cap chain ("**That authority is being exercised now**") and enumerates the divergent copies wrongly in both directions.

Claimed: "DF2.3 `:123-128`, DF2.4 `:138-143` and DF2.7 `:134` still carry the middle term as `runBudgetCapMicros`".

Measured (`grep -n runBudgetCapMicros` across the story set):
- `df2-3-credential-lifecycle.md:123` ✔ **and `:211`** — not listed.
- `df2-4-live-cap-hit-kill.md:138` ✔ **and `:145`** — the second is a worked example (`runBudgetCapMicros 40_000`), not listed.
- `df2-7-session-cumulative-cost-instrumentation.md:134` — **no occurrence.** That line names the cap in prose ("DD-9's 5,000,000 µ$ ($5.00) run budget cap (DF2.8/DF3.6)") and never uses the symbol.
- Shipped code: `src/providers/credentials.ts:46` carries the dead name in a docstring. The "Deferred" note at `:492-495` covers the *staleness* of that docstring's claim but not the dead symbol name in it.

**Fix.** Replace `:292-294` with: "DF2.3 `:123`,`:211`, DF2.4 `:138`,`:145` and the docstring at `src/providers/credentials.ts:46` still carry the middle term as `runBudgetCapMicros`, a name no code declares (DF2.7 `:134` names the cap in prose only and needs no edit); correcting them to `defaultCapMicroUsd` is downstream of this story, not a divergence from it."

### V-DF3.6a-L1 · LOW · `df3-6a…md:195`

`steering.ts:822-827` is cited for "`telemetry.status` is a **one-way latch** — nothing writes `"active"` back". The latch sentence is at `:820-821` ("`telemetry.status` is a one-way latch — three paths write "degraded" and nothing anywhere writes "active" back"); `:822-827` is the inbox-drain rationale. Correct to `:820-821`.

### V-DF3.6a-L2 · LOW · record of verified-correct citations

Recorded so a later round does not re-litigate them. All checked by reading:

`steering.ts:21,24` (`PROMPT_CHAR_CEILING = 16_000`, `MAX_OUTPUT_TOKENS = 1_024`) ✔ · `:196-202` (`ResidentTripwire`; `runId`/`detail` required, `requestId`/`phase` optional) ✔ · `:199` (cause union, single member `"gate_bypass_attempt"`) ✔ · `:194-195` (the DF3.3 comment transferring the widening) ✔ · `:204-219` (`ResidentTelemetry` — and it **is** the journal's `resident` block: `journal.ts:221` `resident?: ResidentTelemetry`, set wholesale at `:286`) ✔ · `:395` (`rate` on the deps object) ✔ · `:398` (the "Additive, so DF3.6 can add its bounds deps" comment) ✔ · `:445-457` (`clampTerm`/`meter`) ✔ · `:854-858` (the status gate) ✔ · `:858` (`// SEAM DF3.6`) ✔ · `:944-951` (`steeringIterations` increments only on an accepted `retry` at `post_gate_failure`) ✔ · `:961-967` (the snapshot-only getter) ✔ · `types.ts:31` (`MAX_RETRIES = 5`) ✔ · `manifest.ts:225` (`retries` clamped) ✔ · `manifest.ts:317` (`.strict()`) ✔ · `cost-ledger.ts:442` (`defaultCapMicroUsd: 5_000_000`) ✔ · `credentials.ts:47` (`defaultKeyCapMicroUsd = 50_000_000`) ✔ · `df3-3…md:625` (the deferral to "the story that owns the journal contract") ✔ · `df3-3…md:632` ("DF3.6 owns widening the union") ✔.

**Arithmetic, re-derived independently:** 504 µ$ at the shipped fixture rates ✔; 760,960 µ$ at the proposed 180/40 fixture rates ✔. The proposed fixture is **admissible** — 180 USD/MTok → 180,000,000 µ$/MTok, inside the plausibility band `MAX_MICROS_PER_MTOK = 10_000_000_000` (`src/phase-engine/roster/validate.ts:211`), so `resolveRate` will not throw `RateError` on it. The pi-catalog unit is `usd-per-mtok` (`validate.ts:333`), which is what makes the `/1e6` correct.

---

## DF3.6b — findings

### V-DF3.6b-B1 · BLOCKER · `df3-6b…md:140-158` (Technical Notes), `:78-89` (AC1), `:260-264` (Files to Modify)

**Defect.** The seam the story says is already open is not open. The OOM fact cannot reach the engine, and the fix requires an edit DF3.6a's carve-out declares closed.

The story's argument (`:143-145`): "Two facts cross, both on the handle that already exists" — `residentRssBytes` down on `ResidentSpawnOpts`, `lastMemory()` up on `ResidentSpawn`.

`lastMemory()` is on `ResidentSpawn`. The engine never receives `ResidentSpawn`. `scripts/pipeline-run.ts:3295-3297`:

```ts
steering = createSteering({
  caller: spawned.caller,
  rate: spawned.rate,
  …
```

Exactly two fields. And `createSteering` cannot reach for more: `src/phase-engine/steering.ts:11-13` — "this file never imports fleet code (module boundary, story R3 §9.2)" — the one boundary claim in this pair that **is** real.

So AC1's requirement that "the run journal's `resident.exitStatus` is written `"overflow"`" cannot be satisfied by the story's own scoped edit: `:260-264` says "`src/phase-engine/steering.ts` — **one** edit … an internal writer for `telemetry.exitStatus = "overflow"`, reachable only from inside `createSteering`". A writer with no input is not a mechanism.

**And the fix collides with the other half.** DF3.6a `:368-387` states the `steering.ts` edits are "**enumerated and closed** — no fourth solicitation point, no new point, and nothing outside this list", item 5 being "the two new `createSteering` deps (`bounds`, `onBoundBreach`)". A third dep carrying `lastMemory` is outside that list. DF3.6b `:260` asserts its edit is "inside DF3.6a's already-enumerated carve-out". Both cannot be true.

**Concrete failure scenario.** DF3.6a merges with a two-dep `createSteering`. DF3.6b is developed, discovers at implementation time that `oomKilled` has no route, and either (a) widens `createSteering` outside the closed list — a silent scope breach of the kind the ADR's forensic section (`adr:19-23`) identifies as how the original tier-2 deviation happened — or (b) reaches for `spawned` inside `pipeline-run.ts` and writes `exitStatus` from the runner, putting a second writer on a field DF3.3 declared engine-owned.

**Fix recipe.** Add a fourth item to DF3.6a's enumerated carve-out at `:386-387`:

> 5. the **three** new `createSteering` deps on the deps object DF3.3 already marked additive for exactly this (`steering.ts:398`): `bounds` and `onBoundBreach` (this story), and `lastMemory?: () => { peakBytes: number; oomKilled: boolean } | null` — a **structural** callback, not a fleet import, added here because the deps object is one literal and DF3.6b must not re-open it (see DF3.6b's `exitStatus` writer).

and correct DF3.6b `:260-264` to:

> - `src/phase-engine/steering.ts` — **one** edit, inside DF3.6a's already-enumerated carve-out: an internal writer setting `telemetry.exitStatus = "overflow"` when the solicitation's call rejects **and** `deps.lastMemory?.()` reports `oomKilled: true` — the `lastMemory` dep itself lands in DF3.6a's diff (its Files list item 5), because the deps object is one literal and two stories must not edit it. The controller keeps its snapshot-only getter (`steering.ts:961-967`); **no public setter is added**.

and to DF3.6b's Files list for `scripts/pipeline-run.ts` (`:265-266`), add: "and passes `lastMemory: spawned.lastMemory` at the `createSteering` call site (`:3295`) — the second of this story's two edits to this file."

### V-DF3.6b-B2 · BLOCKER · `df3-6b…md:196-204` (Technical Notes), `:287-292` (INV-MEM-2)

**Defect.** The placement wrapper fails **open**. If the cgroup write fails, pi executes unbounded.

The wrapper as literally specified (`:199`):

```sh
sh -c 'echo $$ > "$1"/cgroup.procs; shift; exec "$@"' _ <cgroupDir> <pi argv…>
```

`;` is unconditional sequencing. If `echo $$ > "$1"/cgroup.procs` fails — the leaf was removed by a concurrent teardown, `+memory` was not enabled in `cgroup.subtree_control`, the write returns `EPERM`/`ENOENT`/`EBUSY`, or `$1` is empty — `sh` prints a redirection error to stderr and **continues to `shift; exec "$@"`**. pi runs with no `memory.max`.

INV-MEM-2 (`:290-291`): "the engine never runs an agent whose memory it cannot bound, and never silently degrades to an unbounded one." This is precisely a silent degradation to an unbounded one — and AC3's check is at **arming**, once (`:111-113`), so nothing re-checks per solicitation.

**Concrete failure scenario.** A run arms successfully (the delegated subtree split worked, `memory.max` was writable at arming). At solicitation 7 the leaf create races a `rmdir` from solicitation 6's teardown, or the cgroup hierarchy is momentarily unwritable. `echo` fails, `exec` runs, pi solicits with the full box memory available, leaks, and OOMs the **box** — killing the engine, the run, and any in-flight `dispatch_task` worker. `memory.events` is then read from a leaf pi was never in, reporting `oom_kill: 0`, so the journal records a clean solicitation. The exact failure the kernel enforcement was chosen to prevent, arriving through the placement step.

**Fix recipe.** Replace `:198-204` with:

> The spawn race is closed by the child, not by a retry, **and the placement is fail-closed**. Writing pi's pid to `cgroup.procs` *after* `Bun.spawn` leaves a window in which pi runs unbounded. Instead the child places itself before it becomes pi, and **refuses to become pi if the placement fails**:
> `sh -c 'echo $$ > "$1"/cgroup.procs || exit 97; shift; exec "$@"' _ <cgroupDir> <pi argv…>` — positional passing, so the rendered prompt stays its own argv element and is never interpolated into a shell string. `|| exit 97` is load-bearing, not defensive: `;` would let a failed redirection fall through to `exec` and run pi with no `memory.max`, which is exactly the silent unbounded degradation INV-MEM-2 forbids. Exit 97 is classified `unenforceable` by the caller — the solicitation is failed, the resident is stopped, and no unbounded call is ever issued. The key remains env-borne, never argv (`src/fleet/resident.ts:137-141`), unchanged by this wrapper.
> `ponytail:` the `sh -c` wrapper exists only to close the placement race; if Bun ever exposes `CLONE_INTO_CGROUP`, delete the wrapper and pass the cgroup fd.

and add to the Acceptance Criteria:

> 4. **A failed placement never yields an unbounded call.** Given the per-solicitation cgroup exists at arming but the `cgroup.procs` write fails at solicitation time — the leaf was removed, `+memory` was disabled, or the write returns an error — When the wrapper runs, Then it exits **97** without `exec`ing pi, the solicitation is recorded failed with `bound:"rss", allowed:false, cause:"unenforceable"`, the resident is stopped, and the run continues deterministic. *Negative control: a wrapper joining the two commands with `;` execs pi with no `memory.max`, produces a journal indistinguishable from a bounded solicitation (`memory.events` reads `oom_kill: 0` from a leaf pi was never in), and MUST fail this test.*

Add the matching DoD item.

### V-DF3.6b-B3 · BLOCKER · `df3-6b…md:215-219`, `:287-292` (INV-MEM-2), `:153` (the `ResidentSpawnOpts` field)

**Defect.** "No platform probe at all" plus "unenforceable ⇒ not started" plus a required `residentRssBytes` disables the resident in every shipped host-side test.

The three clauses together:
- `:215-219`: "**In particular there is no darwin/Linux probe split**: the enforcement path exists only in-box on Linux … darwin now matters only for host-side unit tests, **which do not exercise this bound at all**."
- INV-MEM-2 `:287-292`: "where the memory bound cannot be **enforced** — the delegated cgroup cannot be created, `memory.max` cannot be written, the `memory` controller is unavailable, or the box is not on cgroup v2 — the resident is **not started**".
- `:153`: `residentRssBytes: number;` — non-optional on `ResidentSpawnOpts`.

On the darwin operator host, and on any CI runner whose container lacks `Delegate=memory`, none of those preconditions hold. INV-MEM-2 therefore returns `{ disabled: true }` from `startResident` on every host-side invocation.

Measured blast radius: `tests/fleet/resident.test.ts` contains **42** `startResident(` call sites. `tests/phase-engine/in-box-engine.test.ts`, `tests/phase-engine/pipeline-run.test.ts` and `tests/phase-engine/resident-e2e.test.ts` also arm residents. Every one exercises the arming path INV-MEM-2 now gates — including DF3.3's INV-RES-3 second-mint exhibit (`df3-3…md:237`), which is the credential-containment proof for the whole resident.

**Concrete failure scenario.** DF3.6b merges. `bun test tests/fleet/resident.test.ts` on the darwin dev host: every arming assertion gets `{disabled: true}` instead of a `ResidentSpawn`. The INV-RES-3 exhibit — "the child receives EXACTLY the run's one key while planted ambient operator credentials never arrive" — no longer spawns a child and asserts nothing. That is a shipped security control silently disarmed by a memory story.

**Fix recipe.** Add to INV-MEM-2 at `:292`:

> **Scope.** INV-MEM-2 governs the **in-box enforcement context** — the path reached when the caller supplies a bound. `residentRssBytes` is therefore `residentRssBytes?: number` on `ResidentSpawnOpts`: **absent means no cgroup machinery runs at all**, which is the host-side unit-test context (darwin has no cgroups), and **present-but-unenforceable means the resident is not started**, which is the in-box context. The two are distinguished by the caller, not by a platform probe: `scripts/pipeline-run.ts` passes the validated bound (DF3.6a refuses the run if it is missing from the manifest), so in production the field is always present and INV-MEM-2 always applies. `tests/fleet/resident.test.ts`'s 42 arming sites and DF3.3's INV-RES-3 second-mint exhibit omit it and are unaffected — that is the seam, and it is asserted: one host-side test proves that omitting `residentRssBytes` arms a resident with no cgroup calls, and one proves that supplying it on a host without cgroup v2 refuses to start.

and correct the code sketch at `:153` to `residentRssBytes?: number;` with the docstring amended accordingly. Add the two named tests to the DoD.

### V-DF3.6b-H1 · HIGH · `df3-6b…md:168-173`, `:124`, `:353-356` — **contradicts binding ADR text**

**Defect.** The story reproduces, three times, wording that ADR Appendix B explicitly retracted the same day, and then prescribes for DF5.1 the generalisation the ADR names as the error.

Story `:168-170`: "**This re-opens and supersedes DF5.1's standing accepted ceiling** ("RSS is `ps`-sampled rather than cgroup-enforced", `df5-1…md:229,268-269,352-354`) rather than inheriting it. **DF5.1's own ceiling should close on this same mechanism** — that is a follow-up filed against DF5.1."
Trigger Surface `:124`: "DF5.1 (its ceiling is **re-opened by this story's mechanism**)".
Split Record `:353`: "DF5.1's `ps`-sampled RSS ceiling is **re-opened**, not closed here."

ADR `docs/superpowers/specs/2026-08-31-tier2-placement-adr.md:185-193`, ACCEPTED, binding:

> **Correction, same day:** an earlier draft of this appendix said the ruling "re-opens and supersedes DF5.1's standing accepted ceiling." **That was wrong**, and DF3.6's author caught it. DF5.1's re-verify runs **host-side**, on the operator's machine, which may be darwin — where cgroup v2 does not exist. The mechanism ruled on here is available in-box precisely *because* the box is Linux with systemd as PID 1; **it does not generalise to the host.** DF5.1's ceiling … therefore **stays open and unclosed by this appendix**, and closing it needs **a different answer** for a possibly-darwin host.

`sprint-status.yaml:183` records the corrected reading verbatim ("DF5.1's host-side ps-sampled ceiling is NOT closed by this (host may be darwin; cgroups are Linux-only) — see ADR Appendix B's same-day correction"). The story is the only artifact still carrying the retracted text.

**Consequence.** "Re-opened" implies the ceiling was closed and this story unclosed it; it was never closed. "DF5.1's own ceiling should close on this same mechanism" tells whoever picks up the DF5.1 follow-up to apply cgroups on a host the ADR says may be darwin — a follow-up ticket pointed at a mechanism its own ADR rules out. The story's *next sentence* (`:172-173`) actually gets the substance right, which makes the contradiction internal as well as external.

**Fix recipe.** Replace `:168-173` with:

> **This does not touch DF5.1's standing accepted ceiling** ("RSS is `ps`-sampled rather than cgroup-enforced", `df5-1…md:229,268-269,352-354`), and it does not inherit it either — the two are different problems on different kernels. Per ADR Appendix B's same-day correction (`2026-08-31-tier2-placement-adr.md:185-193`): the mechanism ruled on here is available in-box precisely *because* the box is Linux with systemd as PID 1, and **it does not generalise to the host**; DF5.1's verify box is host-side and may be darwin, where cgroups do not exist. DF5.1's ceiling therefore **stays open, unclosed and unre-opened by this story**, and closing it needs a different answer — filed against DF5.1 so there is one ticket for the one exposure, explicitly **not** on this mechanism.

`:124` → "DF5.1 (its host-side ceiling is untouched by this story; ADR Appendix B's correction rules this mechanism out for a possibly-darwin host)". `:353-356` → the same correction.

### V-DF3.6b-H2 · HIGH · `df3-6b…md:220-224`, `:226-235`, `:249-251`

**Defect.** After a kernel OOM-kill, the resident's `status`, and the latch that DF3.6b's own tripwire-(c) argument depends on, are owned by neither half.

Traced end to end against shipped code:

1. The kernel OOM-kills the pi child. `Bun.spawn`'s handle reports a signal death.
2. `src/fleet/resident.ts:606-627`: `proc.exitCode === null || proc.signalCode !== null || proc.exitCode === 137` → `lastExit = "transient"`, session quarantined, **throw**.
3. The throw returns to `createSteering`'s call guard, which degrades: `telemetry.status = "degraded"`.
4. DF3.6b writes `telemetry.exitStatus = "overflow"` (`:249-251` — "the only journal `resident` values this story writes are `exitStatus:"overflow"` and … `status:"disabled"`").
5. **Nothing calls `stop()`.** `stopped` stays `false`. `resident.ts:474`'s `if (stopped) throw` never fires.

So the journal reads `status:"degraded"`, `exitStatus:"overflow"` — a combination neither half specifies. DF3.6a AC5 (`:193-205`) rules precedence only "when **this story's** enforcement is the proximate cause" and scopes `"stopped"` to DF3.6a's own bounds. DF3.6b never states what `status` should be after an OOM.

Worse, DF3.6b's own tripwire-(c) reasoning **depends on the latch it never arranges** (`:229-231`): "`stop()` latches (`src/fleet/resident.ts:681-705`) and every later `call` throws (`resident.ts:474`), so **a second kill in the same run is structurally impossible**." It is not impossible, because nothing calls `stop()`. In fact the `"degraded"` status gate at `steering.ts:854-857` *does* short-circuit later solicitations — so the practical outcome is closer to the claim — but the argument as written names the wrong mechanism, and a future change to the degrade path silently re-opens a second in-run kill.

**Concrete failure scenario.** A resident OOMs at solicitation 3. The status gate returns `PROCEED` for the rest of the run, so no second kill occurs *today*. A later story that adds a re-arm path, or that widens `status` back to `"active"` after a recovery, produces two `watchdog_kill` rows with the same `runId` — which, under the story's own tripwire-(c) key (`runId + cause`, `:228`), is D4's demotion condition met **inside one run**, on a bug rather than a policy signal.

**Fix recipe.** Add to DF3.6b's Acceptance Criteria:

> 5. **An OOM-kill stops the resident, and the resident's status says so.** Given the kernel OOM-kills a solicitation's cgroup, When the failed call returns to the engine, Then `stop()` is invoked on the `ResidentSpawn` handle (`src/fleet/resident.ts:681-705`) so the latch is real rather than incidental, `telemetry.status` is written `"stopped"` — this story's enforcement is the proximate cause, which is exactly the condition DF3.6a AC5 reserves `"stopped"` for — `telemetry.exitStatus` is written `"overflow"`, and no further solicitation is issued. *Negative controls: (a) an implementation relying on the `"degraded"` status gate (`steering.ts:854-857`) rather than on `stop()` leaves `stopped === false`, so a later re-arm path re-opens a second in-run kill, and MUST fail this test; (b) an implementation that leaves `status` at whatever the call-failure degrade path wrote (`"degraded"`) produces `status:"degraded"` beside `exitStatus:"overflow"` — a combination no story owns — and MUST fail.*

and correct `:229-231` to say the latch is **established by this AC**, not inherited.

### V-DF3.6b-H3 · HIGH · `df3-6b…md:78-89` (AC1), `:41-43` (Overview), `:52-53` (E2E Slice), `:301` (DoD)

**Defect.** `memory.oom.group` is never set, so "the kernel OOM-kills that cgroup" is not what the kernel does.

The story asserts a cgroup-scoped kill in four places: "crossing the bound OOM-kills that cgroup and nothing else" (`:41-42`); "**the kernel OOM-kills that cgroup**" (`:52`, `:80`); "a post-run check finds the solicitation cgroup removed and **no orphaned child**" (`:86`); DoD "leaf removal after the call" (`:301`, `:310`).

cgroup v2 defaults `memory.oom.group = 0`. On that setting the OOM killer selects and kills **one task** in the cgroup — typically the largest — not the cgroup. A cgroup-wide kill requires writing `1` to `memory.oom.group`. The story's Files-to-Modify (`:255-259`) lists the `memory.max` write, the `memory.peak`/`memory.events` read and the leaf removal; `memory.oom.group` appears nowhere in the story.

**Concrete failure scenario.** pi is spawned `--no-tools` (`src/fleet/resident.ts:524`), so today it normally has no children and the single-task kill happens to equal the cgroup kill — the test passes for the wrong reason. Remove `--no-tools`, or let pi fork a helper, and the OOM kills one task while siblings survive: the `rmdir` in the leaf-removal step returns `EBUSY`, the DoD's "a leaf is removed after every call including the OOM path" fails, and the survivors are exactly the "orphaned child" AC1 asserts cannot exist. The AC is written as a guarantee of kernel scoping; the kernel is not configured to provide it.

**Fix recipe.** In the Overview `:40-43`, replace "Every pi solicitation runs inside its own cgroup v2 leaf with `memory.max` set from the manifest's `residentRssBytes`" with:

> Every pi solicitation runs inside its own cgroup v2 leaf with `memory.max` set from the manifest's `residentRssBytes` **and `memory.oom.group` set to `1`**. The `oom.group` write is what makes "OOM-kills that cgroup" true rather than approximately true: at the kernel default (`0`) the OOM killer kills a single task and leaves siblings running, which would leave the leaf un-`rmdir`-able (`EBUSY`) and produce exactly the orphaned child AC1 asserts cannot exist.

Add `memory.oom.group` to the Files-to-Modify entry at `:255-259` and to the DoD Impl item at `:301`, and add to the leaf-lifecycle DoD test at `:310`: "an implementation that writes `memory.max` without `memory.oom.group=1` leaves a surviving sibling on a multi-process pi tree and MUST fail leaf removal."

### V-DF3.6b-H4 · HIGH · `df3-6b…md:226-235` (Technical Notes)

**Defect.** D4 tripwire (c) is silently re-scoped from "a steering loop" to "any two OOM kills, ever" — a governance control made an order of magnitude more trigger-happy inside a Technical Note.

Design doc §4 D4: "any **steering loop** the §5.2 watchdog kills **twice for the same cause**". The subject is a loop.

Story `:227-231`: "**D4's tripwire (c) … is computable across runs, keyed on the row's `runId` + `cause`, and never within one run:** `stop()` latches … so a second kill in the same run is structurally impossible. The *cause* discriminator has **cardinality one** today."

A `runId` is unique per run. Keying on `runId + cause` and evaluating "across runs" therefore yields exactly one row per run, and "twice for the same cause" collapses to: **two runs, anywhere in the fleet, each with one `watchdog_kill` row**. With cause cardinality one, that is "two OOM kills ever". Under D4, meeting tripwire (c) **demotes tier 2 entirely** — deleting the resident agent from the architecture.

**Concrete failure scenario.** Month 1. Run A's resident OOMs because a large repo produced an oversized prompt context. Three weeks later, unrelated Run Q's resident OOMs because the 512 MiB default was never re-derived against pi's real baseline (V-DF3.6b-M2). The month-1 evaluator applies the key this Technical Note specifies and demotes tier 2 — a decision the design doc reserves for a *steering loop* that keeps being killed for the same reason. Two unrelated leaks are not a loop.

**Fix recipe.** Replace `:226-233` with:

> - **Tripwire causes are emitted, not evaluated.** The kill emits a DF3.3 `residentTripwire` row `{ runId, requestId, cause: "watchdog_kill", phase, detail }`, with `detail` carrying the measured `memory.peak`, the bound it crossed, and the cgroup leaf name. **D4's tripwire (c) — "any steering loop the watchdog kills twice for the same cause" — is a statement about a repeating *loop*, not about a fleet-wide count, and this story does not decide its key.** Within one run a second kill is prevented by AC5's `stop()` latch (`src/fleet/resident.ts:681-705`, every later `call` throws at `resident.ts:474`). Across runs, the rows this story emits carry `runId`, `phase` and `detail`, which is the evidence an evaluator needs; **choosing the key that makes "the same steering loop" identifiable — `phase` plus the manifest's `pipelineId`, not `runId`, which is unique per run and would make any two kills anywhere count as "twice" — is the month-1 evaluator's decision and, if it changes what D4 means, an ADR amendment rather than a story-local note.** The *cause* discriminator has cardinality one today (an OOM-kill is the only kill this story raises); a second kill cause would be a new tripwire `cause` member, not a new `detail` string. This story counts nothing and defines no key.

### V-DF3.6b-H5 · HIGH · `df3-6b…md:104-113` (AC3)

**Defect.** AC3 requires a log line from a component that, by AC3's own construction, does not exist on that path.

AC3: "When the resident arms, Then it is **not started**: the journal records `resident.status: "disabled"` … **and the bounds-check log line carries `bound: "rss", allowed: false, cause: "unenforceable"`**".

The bounds-check line is emitted by `checkBounds`, which DF3.6a places in `src/phase-engine/resident-bounds.ts` and calls from inside `createSteering` (DF3.6a `:211`, `:354`, `:365-366`). When the resident is not started, `createSteering` is never called — `scripts/pipeline-run.ts:3293`: `if (spawned !== undefined && !("disabled" in spawned)) { … steering = createSteering({…}) }`. No controller, no `checkBounds`, no bounds-check line. The AC is unsatisfiable as scoped.

The shipped precedent for exactly this case is one line above it. `scripts/pipeline-run.ts:3280-3291`, the `rate_unresolved` arming refusal:

```js
{ level: "warn", event: "resident_disabled", runId, requestId, model: residentModel,
  reason: "rate_unresolved", detail: err.message }
```

**Concrete failure scenario.** A dev writes the AC3 test against a box with no `Delegate=memory`, asserts a bounds-check line with `cause:"unenforceable"`, finds none, and either invents a bounds-check emitter outside the controller (a second source of bounds telemetry) or drops the assertion and ships an unenforceable-path refusal with no observable at all — which is the fail-closed path with no evidence that it fired.

**Fix recipe.** Replace `:107-110` with:

> When the resident arms, Then it is **not started**: the journal records `resident.status: "disabled"` (DF3.3's closed set — a fourth value would violate its AC5) and the runner emits the **shipped arming-refusal shape** on stderr — `{ level:"warn", event:"resident_disabled", runId, requestId, model, reason:"rss_unenforceable", detail }`, the same line the `rate_unresolved` refusal already uses (`scripts/pipeline-run.ts:3280-3291`). It is **not** a bounds-check log line: `checkBounds` lives inside `createSteering` (DF3.6a `:365-366`), and on this path `createSteering` is never called (`scripts/pipeline-run.ts:3293`), so a bounds-check line is structurally unavailable and asserting one would force a second bounds-telemetry emitter into existence. No `residentTripwire` row is emitted, leaving DF3.3's closed three-cause set unchanged.

Update the DoD item at `:308` to assert the `resident_disabled` / `rss_unenforceable` shape.

### V-DF3.6b-M1 · MEDIUM · `df3-6b…md:163-167`

**Defect.** "cgroup v2 `memory.max` is kernel-enforced, **fires deterministically**" over-states the mechanism for one real class of pressure.

A cgroup reaching `memory.max` first attempts reclaim; the OOM killer runs only when reclaim fails to make progress. Anonymous memory (the synthetic allocator in the E2E slice) cannot be reclaimed, so it OOMs — deterministically, as claimed. **File-backed** pressure — pi streaming a large session jsonl, or a big model response buffered through the page cache — is reclaimable: the cgroup thrashes at the limit indefinitely rather than being killed. The bound then manifests as a latency cliff, not a kill, and the only thing that ends the solicitation is `SOLICIT_TIMEOUT_MS = 60_000` (`src/phase-engine/steering.ts:26`) — a *time* bound, not the memory bound AC1 claims fired.

**Fix.** Add one sentence at `:167`: "The determinism claim is exact for **unreclaimable** (anonymous) growth, which is the leak this bound exists for. Reclaimable file-backed pressure at the limit thrashes rather than OOMs; the backstop there is the existing per-call wall clock (`SOLICIT_TIMEOUT_MS = 60_000`, `src/phase-engine/steering.ts:26`), which classifies as a timeout, not a `watchdog_kill`. Stated so nobody reads a missing `oom_kill` count as a missing bound."

### V-DF3.6b-M2 · MEDIUM · `df3-6b…md:50-51` (E2E Slice); with DF3.6a `:250-251`

**Defect.** Both memory figures are asserted rather than derived, and the E2E one may make the live test pass for the wrong reason.

- E2E slice: `residentRssBytes: 64 MiB`, "small enough that a single allocation crosses it deterministically". No measurement of pi's own baseline RSS is cited anywhere in either half, in the ADR, or in the 2026-08-31 probe (which measured wall time — 2.17 s — and cost, `adr:83`, but not memory). pi is a **compiled ELF standalone binary** (`adr:79`). If its resident set at startup already exceeds 64 MiB, the OOM fires at `exec` and the live TIER-4 test — real box, real spend — proves the cgroup is attached, not that "the resident's pi child allocates past the bound", which is what AC1 states.
- Default: `residentRssBytes = 512 MiB` survives **verbatim** from the pre-split 2026-08-20 text (orig `:141`) into DF3.6a `:250-251`, with no derivation, while every other default at this split was re-derived. It is the one value that crosses the seam, and it is the one nobody re-checked.

**Fix.** Add to DF3.6b's E2E Slice at `:51`: "The 64 MiB figure is **provisional and must be re-derived at authoring time against a measured pi baseline** — read `memory.peak` from a control solicitation that allocates nothing, and set the fixture bound to ≥ 2× that. A bound below pi's own startup RSS OOMs at `exec` and proves the cgroup is attached rather than that the allocation crossed it, which is not what AC1 asserts. The same measurement fixes DF3.6a's 512 MiB default, which is carried forward from the pre-split story unre-derived."

### V-DF3.6b-M3 · MEDIUM · `df3-6b…md:151-153`; with DF3.6a `:135-136`

**Defect.** Three artifacts give three incompatible answers for a missing `residentRssBytes`.

- DF3.6a AC2(a) `:135-136`: "The same load also **rejects** a missing or non-positive-integer `residentRssBytes`" — refuses the **whole run** at manifest load.
- DF3.6b's code comment `:151-152`: "Absent ⇒ **resident not started** (INV-MEM-2)."
- The field it annotates, `:153`: `residentRssBytes: number;` — non-optional, so "absent" is not representable in the type.

Under DF3.6a's refusal the DF3.6b path is dead code; under DF3.6b's type it is unreachable; the two prose statements disagree about blast radius (run vs resident).

**Fix.** Resolve in favour of DF3.6a (refuse the run — it is the stronger and earlier gate) and make the field optional per V-DF3.6b-B3, with the comment reading: "Absent means **no cgroup machinery runs** — the host-side unit-test context. In production it is never absent: DF3.6a refuses the run at manifest load on a missing or non-positive value, so by the time `startResident` is called the bound is present and validated. Present-but-unenforceable ⇒ resident not started (INV-MEM-2)."

### V-DF3.6b-M4 · MEDIUM · `df3-6b…md:70-74` — artifact disagreement

**Defect.** Dependency edges disagree with `sprint-status.yaml`.

Story `:70-74` predecessors: **DF3.6a, DF1.10, DF2.10, DF3.3**.
`sprint-status.yaml:183`: `deps: [DF3.6a, DF1.10, **DF1.11**, DF2.10, DF3.3]`.

**DF1.11 is missing from the story.** It is not decorative: DF1.11 is the in-box steering executor, and the solicitation points this story instruments run inside it — DF3.6a's own dependency line (`:95-96`) names DF1.11 for exactly that reason ("the solicitation points this story wraps run inside its engine"). DF3.6b instruments the same points from the fleet side.

**Authoritative:** the yaml. The split record in both halves establishes the precedent explicitly ("`sprint-status.yaml:43` recorded it; the story file was never updated … **The yaml was authoritative throughout**").

**Fix.** `:70-74` → "**Dependency edges (predecessors):** **DF3.6a** (validates `residentRssBytes`; widens `ResidentTripwire["cause"]` to include `watchdog_kill`; carries the `lastMemory` dep), **DF1.10** (the in-box engine and the `startResident` spawn path this story instruments), **DF1.11** (the in-box steering executor — the solicitation points this story wraps the cgroup around run inside it), **DF2.10** (the boot image and the `qds-run@.service` unit that must carry `Delegate=memory`, and whose digest pin must move), DF3.3 (the `resident` journal block and its `exitStatus` field)."

### V-DF3.6b-L1 · LOW · `:98`

`src/reverify/worktree.ts:293-311` cited for F064. The `F064:` comment block is `:293-299`; `:300-311` is `withGuards`'s opening lines. ADR Appendix B cites `:293-299` for the same fact (`adr:165`, `:172`). Align on the ADR's range so the two artifacts read as one citation.

### V-DF3.6b-L2 · LOW · `:201`

"The key remains env-borne, never argv (`src/fleet/resident.ts:141-145`)". The docstring saying that is `:137-140` ("Key delivery — env-borne, never argv…"); `:141-145` is the `env?` declaration through `persistDir?`. Correct to `:137-141`.

### V-DF3.6b-L3 · LOW · `:140`

`ResidentSpawn` is `src/fleet/resident.ts:116-127`, cited as `:115-127` (`:115` is blank).

### V-DF3.6b-L4 · LOW · record of verified-correct citations

`src/fleet/resident.ts:384-448` (`startResident` spawns nothing — the arming path ends at `LIVE_SESSION_PATHS.add` on `:448`) ✔ · `:451` (`current` is closure-local) ✔ · `:474` (every later `call` throws) ✔ · `:681-705` (`stop()` latches) ✔ · `:125` ("DF3.6 decides when; this supplies how") ✔ · `oci/exedev/systemd/qds-run@.service:185` — verbatim "this engine's cgroup contains processes it spawned … a pi child …, a `code` phase mid-`git push`, a team-lead driver" ✔ · `User=exedev` at `:59` ✔ · **`Delegate=` is genuinely absent from the shipped unit** ✔ · `oci/exedev/Dockerfile:809` (the `RuntimeDirectoryPreserve=yes` grep, exactly the shape the new assertion should copy) ✔ · `:1024-1040` (the AC6 `QDS_*` scan; `Delegate=` contains no `QDS_`, so the claim that AC6 is unaffected holds) ✔ · `cli-anything/src/types.ts:99-105` — `EXIT_STATUSES = ["success","transient","overflow","logic","lead_failure"]`, **`"overflow"` is a real member** ✔ (the L1 that would have been a BLOCKER, correctly verified) · `src/phase-engine/phases/dispatch-task.ts:290-298` (`QDS_TEAM_RUNNER` must be `"local"`) ✔ · `df5-1…md:229`, `:268-269`, `:352-354` (all three carry the `ps`-sampled ceiling) ✔ · `src/providers/exedev/driver.ts:395,425` (the systemd unit is a `deriveBuildId` input; `:425` records the precedent — a one-line unit change that forced a re-pin) ✔ · `src/phase-engine/steering.ts:11-13` (the engine↛fleet boundary — real, and correctly used here, unlike in DF3.6a) ✔ · `:961-967` (snapshot-only getter) ✔.

**Image-pin ritual:** correctly identified, correctly made a DoD item, and `deriveBuildId`'s input set is right — `driver.ts:425` documents the exact precedent ("The fix is `RuntimeDirectory=` on `oci/exedev/systemd/qds-run@.service`, and that unit is a `deriveBuildId` input — so the pin above described an image whose engine had never completed a run"). The DoD item at `:304` is falsifiable as written. **No finding.** This is the strongest section of either story.

**INV-MEM-3 / argv:** verified sound. `sh -c 'script' _ arg1 arg2 …` sets `$0 = _`, `$1 = cgroupDir`, `$2… = pi argv`; after `shift`, `exec "$@"` execs pi with its argv intact and its pid preserved (so `Bun.spawn`'s native timeout and `killSignal: "SIGKILL"` still reach pi — `src/fleet/resident.ts:535-536`). No prompt is interpolated into a shell string. The key stays env-borne: `env: childEnv` is inherited across `exec` (`resident.ts:537`). The prompt was already an accepted argv exposure (`resident.ts:50-58`) and the wrapper adds none. **No finding** beyond V-DF3.6b-B2's fail-open.

---

## Cross-cutting findings

### V-CC-C1 · HIGH — three orphans

Detailed in the split-integrity accounting above: (1) the post-kill solicitation guard, (2) DF2.4's group-kill doctrine / risk R3, (3) the unre-derived 512 MiB. Fixes are in V-DF3.6b-H2, the R3 citation drop, and V-DF3.6b-M2 respectively.

### V-CC-C2 · MEDIUM — both halves claim "No other change" to `scripts/pipeline-run.ts`

DF3.6a `:395` and DF3.6b `:266`. Individually true, jointly ambiguous: DF3.6b rebases onto DF3.6a and neither says so for this file. With V-DF3.6a-H4 and V-DF3.6b-B1 applied the file takes three edits (`loadResidentBounds` + marker refusal; `bounds`/`onBoundBreach`/`lastMemory` at `:3295`; `residentRssBytes` at `:3255`). **Fix:** state the total in DF3.6b's Files entry — "DF3.6a lands (i) and (ii); this story adds (iii) and (iv) and touches nothing else in the file."

### V-CC-C3 · MEDIUM — artifact-consistency sweep, every item checked

| Item | DF3.6a story | DF3.6b story | `sprint-status.yaml` | Verdict |
|---|---|---|---|---|
| Sprint tag | `v5-S3` (`:4`) | `v5-S3` (`:4`) | `v5-S3` (`:43`, `:182`, `:183`) | ✔ **agree** — the eight-day `v5-S2` drift the split records is genuinely fixed in both halves |
| Points | 3 (`:3`) | 3 (`:3`) | 3 + 3 (`:53`, `:65`) | ✔ agree |
| Slate arithmetic | — | — | `:53` "+1 story +3 pts DF3.6 (3) split -> DF3.6a (3) + DF3.6b (3)"; slate 41/166 | ✔ internally consistent |
| Status | (no header field) | (no header field) | `ready-for-dev` both | ✔ consistent with the other v5 stories' convention — not a defect |
| DF3.6a deps | DF1.1, DF1.5, DF1.10, DF1.11, DF2.3, DF2.8, DF2.12, DF3.3 (`:92-98`) | — | identical (`:182`) | ✔ **exact match** |
| DF3.6b deps | — | DF3.6a, DF1.10, DF2.10, DF3.3 (`:70-74`) | DF3.6a, DF1.10, **DF1.11**, DF2.10, DF3.3 (`:183`) | ✘ **MISMATCH** — V-DF3.6b-M4. **yaml authoritative** |
| DF2.12 status/role | "new and unbuilt", hard predecessor (`:96-97`, `:229`) | — | `ready-for-dev`, "HARD PREDECESSOR OF DF3.6a" (`:169`) | ✔ agree |
| DF5.1 ceiling disposition | — | "re-opened and superseded"; "should close on this same mechanism" (`:168-173`, `:124`, `:353`) | "NOT closed by this (host may be darwin) — see ADR Appendix B's same-day correction" (`:183`) | ✘ **MISMATCH** — V-DF3.6b-H1. **ADR Appendix B `:185-193` authoritative**; the yaml already matches it; the story is the only artifact carrying the retracted text |
| Split provenance | `:6-20` | `:8-23` | `:53`, `:182`, `:183` | ✔ agree; both name the same seam and the same 3+3 rationale |

### V-CC-C4 · LOW — F7 tripwire (b) is unaddressed and unlabelled

Both Spec References cite "Decision register: v5 §4 **D4** (tripwires F7)". Tripwire (a) is addressed in depth by DF3.6a (`:310-318`, with DF2.12 named as what makes the denominator honest — this is good, and correctly avoids writing the 15% ratio into an AC per R5 §6 fact 12, which I verified is respected: no ratio field, no p50, `.strict()` schema, INV-BND-4). Tripwire (c) is addressed by DF3.6b (`:226-235`, with the re-scoping defect at V-DF3.6b-H4). **Tripwire (b)** — "any audit finding where the agent bypassed or reordered a phase-engine gate" — appears in neither half, and in neither Trigger Surface as out-of-scope. It is genuinely already shipped as DF3.3's `gate_bypass_attempt` cause (`src/phase-engine/steering.ts:199`, the sole member of the union before this pair widens it), so nothing is missing — but a reader has to re-derive that. **Fix:** one line in DF3.6a's Technical Notes: "D4's tripwire (b) — a gate bypassed or reordered — is DF3.3's `gate_bypass_attempt` cause, already shipped (`src/phase-engine/steering.ts:199`) and untouched by this pair except for the union widening. Stated so the D4 citation reads as complete."

---

## What a previous reviewer got wrong

Read against `scan-C-df3-6.md`'s dispositions as reproduced in both split records:

1. **scan-C H4 ("the ceiling bound at ~3,968 calls and could not fire in production") was fixed with the wrong arithmetic.** The default moved 2,000,000 → 50,000 µ$ and the split record calls the new figure "**derived**". It is derived against `1 run_start + 1 run_end + Σ_phases retries` — a denominator that ignores the story's *own* AC3 bound (which caps solicitations at `2 + 3P`, not `2 + 5P`) and ignores that `retries` is schema-defaulted to **0** (`src/phase-engine/manifest.ts:225`). The ceiling is still ~3× out of reach on a ten-phase manifest and ~50× on a default two-phase one. The finding was correctly identified and incorrectly closed. **V-DF3.6a-B1.**

2. **scan-C's `steering.ts:11-13` module-boundary reading is wrong and was propagated four times.** That comment declares an engine↛**fleet** boundary; the story uses it as an engine↛**provider** boundary, and three shipped `src/phase-engine/` files import `../../providers/bounded-exec.ts` — including `roster/validate.ts`, the story's own `resolveRate` source. The resulting DoD grep can never pass. **V-DF3.6a-B2.**

3. **The reconciliation clause credited to scan-C ("the missing `limitMicroUsd` refusal defers to `runContextFrom`'s existing reconciliation instead of duplicating it", split record `:487-489`) rests on reading a comment instead of the function.** `runContextFrom` is at `scripts/pipeline-run.ts:797`, not `src/phase-engine/manifest.ts:303-314`, and it does not refuse on absence — its own comment says "ABSENCE is still the only thing that leaves the field unset." A refusal was deleted on a false premise. **V-DF3.6a-B3.**

4. **scan-C B1's re-derivation ("the seam got smaller under the better mechanism", DF3.6b split record `:323-328`) stops one step short.** `lastMemory()` on `ResidentSpawn` is only useful if the engine holds `ResidentSpawn`. It holds `spawned.caller` and `spawned.rate` (`scripts/pipeline-run.ts:3295-3297`) and is forbidden to import fleet. The seam did get smaller — it did not get *closed*, and the closing edit is outside DF3.6a's own enumerated carve-out. **V-DF3.6b-B1.**

5. **scan-C H3 ("structural instead of conventional — an engine-rooted bound is not merely forbidden but unrepresentable") over-claims by one kernel setting.** With `memory.oom.group` at its default of `0`, the OOM killer kills one task, not the cgroup, so "the cgroup contains only pi and its descendants (AC2), [therefore] 'nothing else' is a property of the kernel's scoping" (`:223-224`) is true for *scoping* and not for *killing*. **V-DF3.6b-H3.**

6. **scan-C's B5 e2e re-derivation is correct and should be recorded as such.** I re-derived 504 µ$ and 760,960 µ$ independently from `toMicrosPerMTok` (`src/phase-engine/roster/validate.ts:221-227`) and the shipped fixture; both are right, the `usd-per-mtok` unit is right (`:333`), and 180 USD/MTok clears the plausibility ceiling (`MAX_MICROS_PER_MTOK = 10_000_000_000`, `:211`) so `resolveRate` will not reject the fixture. The projection-driven framing is the correct fix and the negative control is well-formed.

7. **scan-C L1's disposition is exemplary and worth naming.** "`"overflow"` is a real member of `EXIT_STATUSES`, `cli-anything/src/types.ts:99-105`, cited to file and line — it was never checked in the original scan and would have been a BLOCKER had it been absent." Verified: `:99-105`, `"overflow"` at `:102`. Correct.

---

## Note on scope

No file was edited. This document is the only artifact produced.
