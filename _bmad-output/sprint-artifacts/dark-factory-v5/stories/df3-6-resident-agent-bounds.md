# DF3.6: Resident-Agent Bounds — Iterations, RSS, and an Absolute Spend Ceiling Enforced by the Engine

**Story Points:** 3
**Sprint:** v5-S2 (fleet band)

## Spec Reference

- `docs/superpowers/specs/2026-08-11-dark-factory-v5-architecture-design.md` §5.2 (the F12 invariant: "the resident agent is itself watched … enforced by the phase engine, not by the agent"), §5.1 tier 2, §6 item 5
- Decision register: v5 §4 **D4** (tripwires F7); findings **F12** (no watchdog on the resident agent), **F7**; risk **R3**
- Closed record (READ-ONLY, cited not modified): `docs/superpowers/specs/2026-08-11-pre-derivation-gates-report.md` §3.3 "D4 tripwire finding" and §4 finding 4 — the 15%-of-run-total tripwire is a **ratio trap** (on an all-cheap roster a v4-flash resident trips at N=2 steering turns while a frontier roster tolerates 65) and is re-specced as the absolute per-run spend ceiling F12 already mandates
- Derivation decisions: `docs/superpowers/specs/2026-08-11-v5-story-derivation-decisions.md` §5 row 4 (this story is the named encoding site), **DD-9** (integer µ$)
- Binding facts: R5 §6 fact **12** (never write the 15% ratio into an AC), fact **5** (the RSS watchdog is *re-aimed*, not deleted — correct now because the runtime is a genuine local subprocess tree), fact **7** (final-turn-only cost events)

## User Story

As the factory host paying for every sandbox,
I want the phase engine to cap the resident agent's steering iterations, memory, and absolute spend below the run key's own cap,
so that a resident agent that loops, leaks, or burns money is stopped by the component it cannot influence, while the run still finishes deterministically.

## Overview

`loadResidentBounds(manifest)` validates three engine-owned bounds against the configured defaults
and refuses the run if their ordering is wrong, then clamps the resident ceiling to this run's
minted key cap when the mint came in lower. During the run, `checkBounds(point)` runs immediately before every DF3.3
solicitation: it rejects the call when the phase's iteration budget is spent, when the projected
worst-case cost would carry cumulative resident spend past the absolute ceiling, or when the RSS
watchdog has already killed the resident tree. Every breach stops the **resident**, records the
cause, and lets the deterministic phase walk continue to completion. No bound is readable or
writable from anything the agent controls.

## E2E Slice

**Demonstrable behavior:** Given `tests/phase-engine/fixtures/pipeline.bounds.json` declaring
`residentSpendCeilingMicros: 2_000_000`, `maxSteeringIterations: 3`, `residentRssBytes:
512 MiB`, and a fake resident whose replies each cost 900,000 µ$, When the run executes, the
engine solicits at run start (spend 0 → 900,000) → solicits after the first gate failure
(900,000 → 1,800,000) → reaches the next solicitation point, projects worst case
1,800,000 + 900,000 = 2,700,000 > 2,000,000, and **does not call** → stops the resident with
`bound:"spend"` → the run completes deterministically. Observable artifact: `out.json` with
`resident.status:"stopped"`, `resident.spendMicros: 1800000` (never above the ceiling), a
`residentTripwire` row `{cause:"spend_ceiling_breach", phase:"build"}`, and every remaining
phase and gate executed on the deterministic path.

**Wiring closed:** On completion of this story, all three bounds are enforced by the phase engine
using only code merged by this story plus DF1.1's lifecycle, DF1.5's exported `resolveRate(slug)`, DF2.3's
key cap, DF2.8's budget cap and DF3.3's solicitation port. No stub,
no `TODO: wire later`. DF3.3 records tripwire telemetry; this story raises the two breach causes.

**Dependency edges (predecessors):** DF1.1, DF1.5, DF2.3, DF2.8, DF3.3.

## Acceptance Criteria

1. **(make-or-break)** Given cumulative resident spend at `ceiling − ε` where ε is smaller
   than the projected worst-case cost of the next solicitation, When the engine reaches that
   solicitation point, Then it does **not** issue the call: the resident is stopped with
   `bound:"spend"`, the run continues deterministic to completion, and recorded resident
   spend never exceeds the ceiling at any point in the journal. *Negative control: an
   implementation that meters only after the call — the obvious one — overshoots the ceiling
   by one call, passes a naive "was it stopped?" test, and MUST fail this one.*
2. The ordering assertion is **two checks over two different quantities**, never one over the minted
   cap:
   <br />**(a) config-time, over static defaults.** Given configured defaults violating
   `residentSpendCeilingMicros < runBudgetCapMicros ≤ defaultKeyCapMicroUsd` (DF2.3's *configured
   default* key cap, not any run's minted value), or a ceiling expressed as a percentage, ratio, or
   share of any run total, When `loadResidentBounds` runs, Then the run is **refused**. The check
   runs where the engine and the manifest actually live — at **manifest load inside the box, before
   the resident is spawned and before the first solicitation** — because "before a box exists" is
   structurally unreachable for engine code. The refusal exits **non-zero numerically** and carries
   `{ code: "bound-config-invalid", message, remediation }` **in its payload** — the house rule of
   DF3.1 AC3: an error code is payload, never a process exit code — leaves the box **alive** with its
   evidence and its printed teardown command (DF2.2 INV-5), and spawns no resident. The ceiling type is an **absolute integer µ$**; the schema has no ratio field to
   populate (gates report §3.3, R5 §6 fact 12).
   <br />**(b) per-run, over the minted cap — clamp, never refuse.** Given this run's minted
   `limitMicroUsd` **as stamped into the frozen manifest by DF3.1's dispatch at fill time (DF3.1
   AC9a)** — DF2.8 mints `min(default, remaining)`, so a run near its issue cap legitimately
   carries a value below the configured default and even below the resident ceiling — When bounds
   load, Then an effective ceiling is computed as
   `min(residentSpendCeilingMicros, limitMicroUsd)` and used for every AC1 projection. When the
   clamp binds, Then a journal row `{ bound:"spend", action:"clamped", configuredMicros,
   limitMicroUsd, effectiveMicros }` is written and the run **proceeds** — a remainder-capped mint
   is a normal state, not a misconfiguration. The value is read **only** from the frozen manifest:
   the engine runs inside the box, where the host-side `.sandbox/runs/<id>.json` record does not
   exist, so a manifest **missing** `limitMicroUsd` **refuses the run** (fail-closed, INV-BND-2)
   rather than defaulting to the configured ceiling. *Negative controls: an implementation that
   applies check (a) to the minted `limitMicroUsd` refuses every run near its issue cap after DF2.8
   already admitted it, and MUST fail this test; so MUST an implementation that reads
   `.sandbox/runs/<id>.json` from inside the box, which finds nothing on every real run.*
3. Given a phase in which the resident has already been solicited `maxSteeringIterations`
   times, When the engine reaches a further solicitation point in that same phase, Then it
   stops soliciting for that phase, the phase completes on the deterministic path, and
   **subsequent phases solicit normally** — the iteration bound is per phase, not per run.
4. Given the resident's subprocess tree exceeds `residentRssBytes`, When the watchdog
   samples, Then the tree is killed, the run journal's `resident.exitStatus` is written
   `"overflow"` (CC-1) — the field DF3.3 declares on the `resident` block it owns (its AC5); this
   story writes the value and adds no field of its own, exactly as with `resident.status: "stopped"`
   — a `watchdog_kill` tripwire row records the cause, the run
   continues deterministic, and a post-run pid-tree check finds no orphaned child.
5. Given a provider reply carrying no usage field, When the engine meters, Then the call is charged
   the **projected worst case**, never zero. Given RSS sampling, When the watchdog reads, Then it
   enumerates the resident's **complete subprocess tree** — root plus every descendant, walked by
   parent-pid links (`/proc/<ppid>/task/*/children` or a `pid,ppid` scan on Linux; `ps -axo
   pid,ppid,rss` filtered to descendants on darwin) — and **sums each process's RSS** into one value
   compared against `residentRssBytes`; a child that alone exceeds the bound trips the limit even
   while the root stays under it. The per-process read dispatches on platform —
   `/proc/<pid>/status` `VmRSS` on Linux (the in-box runtime), `ps -o rss= -p <pid>` on darwin (the
   operator host, where DF3.3's e2e demo runs) — and a resident is declared **unwatchable, and
   therefore never started**, only when **both** probes fail on the running platform for the root
   process. A platform-appropriate probe that succeeds is not a degradation. The run proceeds
   deterministic rather than running an agent nobody can bound.

## Trigger Surface

| Trigger | Status | E2E Test | Follow-Up |
|---------|--------|----------|-----------|
| `checkBounds()` before every DF3.3 solicitation | in-scope | `tests/phase-engine/resident-bounds.test.ts` | — |
| manifest load — bound ordering validation | in-scope | `tests/phase-engine/resident-bounds.test.ts` | — |
| RSS watchdog sampling timer | in-scope | `tests/phase-engine/resident-bounds.test.ts` | — |
| `bun scripts/pipeline-run.ts` end-to-end with bounds | in-scope | `tests/phase-engine/resident-bounds.test.ts` | — |
| fleet-wide default bound policy pushed at dispatch | out-of-scope | — | DF3.1 |
| operator raising a bound mid-run via `attach` | out-of-scope | — | DF3.4 |
| resident spend reconciled into the cost ledger | out-of-scope | — | DF2.8 |
| bound-breach events on the audit chain | out-of-scope | — | DF5.3 |

## Infra Prerequisites

| Component | Service (compose/k8s/provider) | Lifecycle Hook Verified |
|-----------|-------------------------------|-------------------------|
| DF3.3 solicitation port | in-repo `src/phase-engine/steering.ts` (the engine-owned port; the agent itself is `src/fleet/resident.ts`) | `bun test tests/phase-engine/steering.test.ts` green before this story starts |
| run-key cap **default** | DF2.3 credential lifecycle (`defaultKeyCapMicroUsd`, default 50,000,000 µ$) | config-time ordering assertion (AC2a) reads the **configured default**, never a minted value |
| run-key cap **minted** | DF2.8 mint (`min(default, remaining)`), **carried into the box as `limitMicroUsd` on DF1.1's frozen manifest, stamped there by DF3.1's dispatch at fill (DF3.1 AC9a)** | per-run clamp (AC2b) reads `limitMicroUsd` **from the frozen manifest only** — the host-side `.sandbox/runs/<id>.json` record is not reachable from inside the box and is never read here; a missing or unreadable value refuses the run. This story writes no run-record field and no manifest field |
| run budget cap value | DF2.8 budget cap (default **5,000,000 µ$ = $5.00**, DD-9) | config-time ordering assertion; absent config falls back to the documented default, never to unbounded |
| resident slug rate | DF1.5 `resolveRate(slug)` → `{ inputPerMTok, outputPerMTok, cacheReadPerMTok, cacheWritePerMTok }`, integer µ$ **per million tokens** (DD-9), from the models.json DF1.5 validates; **this story reads `inputPerMTok`/`outputPerMTok` only** | resolved once at bounds load for the resident slug; no rate ⇒ resident **not started** (never a defaulted rate). DF3.3 reads the same function — one source, DF1.5's key names |
| RSS sampling | platform-dispatched over the resident's genuine local subprocess tree (R5 §6 fact 5), enumerated and **summed** across root + descendants each sample: `/proc/<pid>/status` per-pid on Linux (in-box), `ps -o rss= -p <pid>` per-pid on darwin (operator host) | watchdog smoke test asserts a sample is readable at resident start on the running platform; **both** probes failing for the root process ⇒ resident not started (AC5); a child-only overflow trips the same kill as a root overflow |

## Technical Notes

- **The three bounds and their defaults, stated once:**
  `maxSteeringIterations` = **8 per phase**; `residentRssBytes` = **512 MiB**;
  `residentSpendCeilingMicros` = **2,000,000 µ$ ($2.00) per run**, absolute. All three live
  in the DF1.1 manifest, are frozen with it at load, and are carried by value for the run.
  This DF3 story therefore ships **engine** code (`src/phase-engine/`, not the `src/fleet/` root its
  siblings use): F12's enforcement locus is the whole point, and a bound owned by the fleet layer
  would be a bound owned by the agent's own tier.
- **The ordering invariant is the whole point of the number — and it is a statement about
  *defaults*:**
  `residentSpendCeilingMicros (2,000,000) < runBudgetCapMicros (5,000,000, DD-9) ≤ defaultKeyCapMicroUsd (50,000,000, DF2.3)`.
  The resident can never consume the run's budget, and the run can never consume the key's
  cap. Strict inequality on the first pair is validated at load over the **configured defaults**
  (AC2a), so a config that merely *equals* the run budget is a refusal, not a warning. It is
  **never** evaluated against a run's minted `limitMicroUsd`: DF2.8 mints `min(default, remaining)`,
  so the minted value is routinely lower by design and feeding it into this assertion would refuse
  exactly the runs DF2.8 just admitted. The minted value is handled by AC2b's clamp instead.
- **DF3.6 is the single owner of the cap chain (DF2.3 reconciliation — current state).** The chain
  `residentSpendCeilingMicros < runBudgetCapMicros ≤ defaultKeyCapMicroUsd` is owned here: strict
  `<` on the first pair, non-strict `≤` on the second. A resident ceiling merely *equal* to the run
  budget cap leaves the run zero headroom outside the resident and is refused at load (AC2a). DF2.3
  carries a **verbatim copy** of that chain rather than a variant wording, so the two texts do not
  differ and there is nothing to reconcile at read time; if a future edit makes them diverge, this
  story is authoritative and the copy is what gets corrected. No amendment to DF2.3 is pending from
  DF5.5 — the chore that once carried one was retired as already-satisfied.
- **Micro-USD field naming, one rule (shared with DF3.3):** `*MicroUsd` names are **persisted**
  fields on DF2.1's run record and DF2.3's key metadata; `*Micros` names are **in-memory / journal**
  values owned by the engine. Explicit mappings used here: `runKeyCapMicros := runRecord.limitMicroUsd`
  (read-only, per-run minted), `defaultKeyCapMicroUsd := ` DF2.3's configured default,
  `residentSpendCeilingMicros := ` manifest bound, `journal.resident.spendMicros := ` engine-metered
  subtotal. No code path renames one suffix into the other implicitly.
- **Why an absolute ceiling and not the 15% ratio (gates report §3.3, R5 §6 fact 12 — BINDING):** a
  ratio's denominator moves with every team-cost optimization, so improving the factory mechanically
  pushes the resident toward demotion; the same ratio fires at N=2 steering turns on an all-cheap
  roster and tolerates 65 on a frontier one. It is not re-derived, re-scoped, or offered here as a
  secondary signal.
- **Pre-flight projection, not post-hoc accounting:** worst-case cost of a call is
  `((promptCharCeiling/4) × inputPerMTok + maxOutputTokens × outputPerMTok) / 1e6` — the `/1e6` is
  what converts DF1.5's µ$-per-**million**-tokens unit into µ$ for this call, and it is applied
  once, at the projection, by the consumer. `inputPerMTok` and `outputPerMTok` are two of the four
  keys DF1.5's exported **`resolveRate(slug)`** returns
  (`{ inputPerMTok, outputPerMTok, cacheReadPerMTok, cacheWritePerMTok }`) for the resident's roster
  slug; **this story reads the first two only** — worst case assumes no cache hits, so the two cache
  rates are not consulted. They are DF1.5's own key names, read from the models.json it validates,
  never a rate table in this story and never a `cost` key on the roster schema, which is closed and
  carries none. They are
  priced separately, not as one combined rate, so output tokens are not underpriced at the input
  rate. Both ceilings are DF3.3's per-call guards (16,000 chars /
  1,024 tokens); a slug for which `resolveRate` yields no rate means the resident is **not started**
  (DF1.5's rule, consumed here), and the projection is never run against a defaulted or guessed rate. The engine refuses to solicit when `spent + projected >
  effectiveCeiling` (AC2b's `min(residentSpendCeilingMicros, limitMicroUsd)`): that is what makes
  AC1's ceiling a ceiling and not a report of a breach already paid for.
- **The meter is engine-side:** cumulative resident spend is summed by the engine from the provider's
  reported usage on each reply (DF3.3's meter, integer µ$ per DD-9). The agent never reports its own
  spend, and this meter is independent of `team-lead-driver.ts`'s final-turn overwrite (R5 §6 fact 7)
  — a bug in the tier-3 driver cannot move this number.
- **RSS watchdog is re-aimed, not new (R5 §6 fact 5):** P1.6's INV-3 watchdog was aimed at a process
  tree that was not genuinely local; inside the sandbox the resident *is* a local subprocess tree, so
  the mechanism is correct here. Sample interval 5,000 ms; kill is `SIGTERM` to the process group
  then `SIGKILL` after 5,000 ms; the sample reads and **sums the whole tree** — root plus every
  descendant, re-enumerated each sample since children can spawn and exit between samples — because
  a leaking child, not a bloated root, is the realistic failure (AC5). **Per-process sampling is
  platform-dispatched:** `/proc/<pid>/status` `VmRSS` on Linux, `ps -o rss= -p <pid>` on darwin.
  Linux is the in-box runtime, but DF3.3's e2e demo runs on the darwin operator host, so a
  `/proc`-only implementation would fail closed there and delete a sibling story's demo. Unwatchable
  — and therefore resident-not-started — means **both** probes failed for the root process on the
  running platform, not "this platform is not Linux"; the kill decision itself is always the
  tree-wide sum, never the root alone.
- **Breach behavior is uniform and narrow:** a breach stops the **resident** and nothing else — never
  fails the run, a phase, or a gate, and never shortens a budget. A run whose resident was stopped
  finished deterministically, which is exactly D4's fallback ("demote tier 2 to code-only dispatch")
  happening for one run.
- **Tripwire causes are emitted, not evaluated:** each breach emits a DF3.3 `residentTripwire` row
  `{ runId, requestId, cause, phase, detail }` with `cause` one of `spend_ceiling_breach` /
  `watchdog_kill`, and `detail` carrying the kill cause verbatim so D4 tripwire (c) — "any steering
  loop the watchdog kills **twice for the same cause**" — is computable from run data. This story
  counts nothing.
- **Deviation/assumption:** the projection uses the roster slug's published rate. If a provider bills
  a rate the roster does not carry, the projection errs cheap and the ceiling could be approached
  from below by one call's error margin. The run-key cap (25× the ceiling) is the backstop and
  recorded `spendMicros` is the authoritative post-run number — recorded, not engineered around.

## Observability Contract

- Every bounds check logs `{ requestId, runId, phase, bound, spendMicros, projectedMicros, iterations, rssBytes, allowed }`
- `requestId` propagates unchanged from DF3.3's solicitation record; a breach additionally
  emits `{ code, bound, cause, phase }` on the tripwire row
- Sub-timings: `projection_ms`, `rss_sample_ms`. A bound never evaluated reports `0`.

## Files to Modify

- `src/phase-engine/resident-bounds.ts`
- `src/phase-engine/steering.ts` (shared, three-way, all in v5-S2 — **DF3.3 authors** the port and its
  three solicitation points, **DF3.4** adds the `attach` inbox drain + ack append at those same
  points, and **DF3.6 rebases last** and **adds only** the `checkBounds(point)` wrapper around the
  existing call sites: no fourth point, no new point, and no edit to a DF3.3- or DF3.4-owned line.
  Mirrored in df3-3's Technical Notes and df3-4's Files list)
- `src/phase-engine/manifest.ts`
- `tests/phase-engine/resident-bounds.test.ts`
- `tests/phase-engine/fixtures/pipeline.bounds.json`

## Security Invariants

- **INV-BND-1 (enforcement locus — F12, verbatim intent):** all three bounds are enforced by
  the phase engine, never by the agent. No directive, prompt, env var, in-box file, or roster
  entry the resident can influence may raise, disable, or reset a bound. A bound value read
  from a path the resident can write is a defect regardless of the value it holds.
- **INV-BND-2 (strict cap ordering over defaults, validated before the resident exists):**
  `residentSpendCeilingMicros < runBudgetCapMicros ≤ defaultKeyCapMicroUsd`, asserted at manifest
  load — inside the box, before the resident is spawned and before the first solicitation (AC2a).
  The assertion is over **configured defaults**; this run's minted `limitMicroUsd` — read from
  DF1.1's **frozen manifest**, where DF3.1's dispatch stamped it at fill (DF3.1 AC9a) — instead
  clamps the effective ceiling to `min(ceiling, limitMicroUsd)` with a journal row and never refuses
  the run (AC2b). The frozen manifest is the **only** cap source the engine reads: it is carried by
  value into the box and is INV-BND-1-safe (frozen at load, unwritable by the resident), whereas the
  host-side run record does not exist inside the box at all. Fail-closed: a manifest carrying no
  `limitMicroUsd`, or an unreadable one, refuses the run rather than assuming a ceiling.
- **INV-BND-3 (meter integrity):** cumulative resident spend is engine-metered from provider
  usage. The agent never reports its own spend; a reply with no usage field is charged the
  projected worst case, never zero. A metering path that trusts an agent-supplied number is
  a credential-adjacent defect, not a rounding choice.
- **INV-BND-4 (the ceiling is absolute):** the ceiling is an integer µ$ value compared
  against cumulative spend. It is never a percentage, ratio, or share of the run total, and
  no such field exists in the schema to be populated later (gates report §3.3, R5 §6 fact 12).
- **INV-BND-5 (fail-closed, and closed toward determinism):** a breach stops the resident
  only — never a gate, a phase, or the run's determinism. Where RSS cannot be sampled by **either**
  platform probe (`/proc` on Linux, `ps -o rss=` on darwin) on the running platform, the resident is
  **not started**; the engine never runs an agent it cannot watch, and never silently degrades to an
  unbounded one.

## Definition of Done

- [ ] **Impl:** `loadResidentBounds` + `checkBounds` in `src/phase-engine/resident-bounds.ts`; every DF3.3 solicitation is gated by `checkBounds` with no unguarded call site in the diff.
- [ ] **Impl:** worst-case pre-flight projection from DF1.5's `resolveRate(slug)` — `inputPerMTok` and `outputPerMTok` of its four keys, divided by `1e6` at the projection — and the engine refuses to solicit when `spent + projected > ceiling` (AC1, INV-BND-3).
- [ ] **Contract:** bounds carried in DF1.1's frozen manifest with the strict ordering assertion over configured defaults; the schema exposes no ratio/percentage field (INV-BND-2, INV-BND-4).
- [ ] **Integration:** breaches emit DF3.3 `residentTripwire` rows with `cause` and a verbatim `detail`, so tripwire (c) is computable from run data.
- [ ] **Security:** no bound is readable or writable from any path the resident controls; unsamplable RSS prevents resident start (INV-BND-1, INV-BND-5).
- [ ] **Test (pre-flight ceiling, negative control):** spend at `ceiling − ε` → the next call is never issued and recorded spend stays under the ceiling; a post-hoc-metering implementation MUST fail this test.
- [ ] **Test (provider-rate-drift):** the projection is computed from the roster's validated rate, priced separately for input and output tokens (Technical Notes "Deviation/assumption"). When the provider's actual per-token rate **exceeds** the roster's validated rate, the projection **underestimates** true cost by that rate gap — this is documented exposure, not a containment claim — and the run-key cap (25× the ceiling) is the backstop; the test asserts the projection matches the roster-rate calculation exactly, not that it remains conservative against an unknown provider rate.
- [ ] **Test (config refusal, AC2a):** `ceiling == runBudgetCap` refuses at load; `ceiling > runBudgetCap` refuses; `runBudgetCap > defaultKeyCapMicroUsd` refuses; a config attempting a percentage value fails schema parse — each at manifest load, before the resident is spawned, exiting **non-zero** with `{ code: "bound-config-invalid" }` in the payload and the box left alive; an implementation that uses the string as the process exit status MUST fail this test.
- [ ] **Test (per-run clamp, AC2b):** a run whose minted `limitMicroUsd` (1,500,000) is below the configured ceiling (2,000,000) **runs**, its effective ceiling is 1,500,000, AC1's projection uses that value, and a `{bound:"spend", action:"clamped"}` journal row records both numbers; an implementation that refuses this run MUST fail the test.
- [ ] **Test (cap absent from the manifest, AC2b/INV-BND-2):** a frozen manifest carrying no
      `limitMicroUsd` **refuses the run** at bounds load with `{ code: "bound-config-invalid" }` in
      the payload, spawning no resident; and a grep of `src/phase-engine/` finds **no** read of
      `.sandbox/runs/` — an implementation that reaches for the host-side run record from inside the
      box, or that defaults the missing cap to the configured ceiling, MUST fail this test.
- [ ] **Test (per-phase iterations):** `maxSteeringIterations + 1` solicitations in one phase → soliciting stops for that phase only; the next phase solicits normally.
- [ ] **Test (RSS watchdog):** a resident child inflating past `residentRssBytes` → tree killed, journal `resident.exitStatus:"overflow"`, run completes, pid-tree check finds zero orphans. The sampler is exercised on the **running** platform (`/proc` on Linux, `ps -o rss=` on darwin), and resident-not-started is asserted only when both probes are stubbed to fail for the root process (AC5).
- [ ] **Test (child-only overflow, AC5):** the root process stays well under `residentRssBytes` while one descendant's RSS alone exceeds it — the tree-summed watchdog kills the tree; an implementation that samples only the root process MUST fail this test.
- [ ] **Test (e2e demo — MANDATORY):** the `pipeline.bounds.json` run writes `out.json` with `resident.status:"stopped"`, `resident.spendMicros` strictly below the ceiling, a `spend_ceiling_breach` tripwire row, and every remaining phase and gate executed deterministically — the journal file is the artifact.

## Dev Agent Record

<!-- Empty placeholder — filled during development. -->
