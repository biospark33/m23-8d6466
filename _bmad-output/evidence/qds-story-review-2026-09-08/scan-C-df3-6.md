# Scan C — DF3.6 "Resident-Agent Bounds" (initial adversarial scan, 2026-09-08)

**Target:** `_bmad-output/sprint-artifacts/dark-factory-v5/stories/df3-6-resident-agent-bounds.md`
(3 pts, 302 lines, last touched 2026-08-20 — eleven days before the tier-2 placement ADR and
weeks before DF1.10/DF1.11 shipped the in-box engine).
**Reviewer:** agent C (solo — all six contract partners are shipped).
**Drift rule applied:** shipped code wins unless the shipped code contradicts the ADR.
**Method:** full read of the ADR, architecture design §3.1/§4 D4/§5.1/§5.2, and the shipped
code — `src/fleet/resident.ts` (707 lines, in full), `src/phase-engine/steering.ts` (979 lines,
in full), `src/phase-engine/manifest.ts`, `src/reverify/worktree.ts`, `src/providers/cost-ledger.ts`,
`src/providers/credentials.ts`, `src/phase-engine/roster/validate.ts`, `src/phase-engine/types.ts`,
`scripts/pipeline-run.ts`, plus the DF1.10 / DF3.3 / DF2.8 / DF2.3 / DF3.4 story records and the
`tests/phase-engine/fixtures/` tree.

**Counts:** 6 BLOCKER · 6 HIGH · 7 MEDIUM · 4 LOW.

---

## 1. Verified-correct elements (SACRED — must not be regressed by any later fix wave)

These were checked against shipped code and confirmed right. A fix wave that "corrects" any of
them is introducing a regression.

| # | Claim in DF3.6 | Verified against | Verdict |
|---|---|---|---|
| V1 | The engine is the enforcement locus; bounds live in `src/phase-engine/`, not `src/fleet/` (`:144-146`, INV-BND-1) | ADR §"In-box placement is load-bearing" mechanism (2); design `:346-347` F12 | **CORRECT.** Post-DF1.10 the engine runs in-box under a systemd unit, so "engine-owned" and "in-box" are now the same locus. |
| V2 | The ceiling is an absolute integer µ$, never a ratio/percentage/share; the schema has no ratio field to populate (`:74`, `:172-176`, INV-BND-4) | `PipelineManifestSchema` is `.strict()` (`src/phase-engine/manifest.ts:317`); DF3.3 AC5 forbids a ratio field on the journal `resident` block | **CORRECT and binding.** R5 §6 fact 12. Do not soften this to "primary signal with a ratio secondary". |
| V3 | The engine reads `limitMicroUsd` **only** from the frozen manifest; `.sandbox/runs/<id>.json` does not exist inside the box (`:84-86`, `:166-171`, INV-BND-2) | `manifest.ts:303-314` (`limitMicroUsd`, stamped by DF3.1, deliberately not stripped on read); `df1-10…md:189` states the DoD grep over `src/phase-engine/` "stays valid — now for the designed reason rather than by accident" | **CORRECT-NOW.** This clause was *wrong* during the host-side interregnum and is right again. |
| V4 | `stampManifestLimit` is DF3.1's; DF3.6 never stamps or alters `limitMicroUsd` (`:133` CC-1) | `manifest.ts:934-985` — `stampManifestLimit` + `stripAuthoredLimit` are dispatch-side | **CORRECT.** |
| V5 | `resident.status` values `"stopped"` and `"disabled"` are inside DF3.3's closed set; DF3.6 adds no fourth (`:98`, `:112`) | `steering.ts:192` `ResidentStatus = "active" \| "degraded" \| "disabled" \| "stopped"`; `df3-3…md:93` "`stopped` is written **only** by DF3.6's bound enforcement" | **CORRECT.** |
| V6 | `resident.exitStatus: "overflow"` is DF3.3's declared field; DF3.6 writes the value and adds no field (`:96-99`) | `steering.ts:217` `exitStatus: ExitStatus \| null`; `df3-3…md:99` "DF3.6's watchdog is what writes `overflow` into it" | **CORRECT.** (Verify `"overflow"` is a member of CC-1 `ExitStatus` in `cli-anything/src/types.ts` before dev — not re-verified here.) |
| V7 | AC2b's clamp-never-refuse over the minted cap, because DF2.8 mints `min(default, remaining)` (`:75-84`, `:151-155`) | `df2-3…md:128` "the per-mint *effective* cap DF2.8 hands to `mintRunKey` is `min(defaultKeyCapMicroUsd, …)`"; `df2-4…md:143` restates the same rule | **CORRECT, and the sharpest reasoning in the story.** The negative control (an impl that feeds the minted value into the ordering assertion refuses exactly the runs DF2.8 admitted) is genuinely falsifying. Keep it verbatim. |
| V8 | Pre-flight projection, not post-hoc accounting; "an implementation that meters only after the call … MUST fail this one" (`:56-62`, `:177-190`) | `steering.ts:894` `meter(reply.usage)` runs strictly *after* `deps.caller.call(prompt)` — the shipped meter is exactly the post-hoc implementation AC1's negative control names | **CORRECT and load-bearing.** The negative control is not hypothetical; it describes shipped code. |
| V9 | Breach stops the resident only — never a gate, a phase, a budget, or the run's determinism (`:207-210`, INV-BND-5) | `steering.ts:854-857` degraded/disabled → `PROCEED`; `df3-3…md` INV-RES-5 | **CORRECT** and consistent with the shipped degradation doctrine. |
| V10 | The steering port is shared three ways and DF3.6 rebases last, adding no fourth solicitation point (`:231-235`) | `steering.ts:86-87` `SteeringPoint` is a closed three-member union; `steering.ts:858` carries the literal `SEAM DF3.6` comment DF3.3 left for this story | **CORRECT.** The seam exists and is named. |
| V11 | `requestId` propagates unchanged from DF3.3's solicitation record (`:224-225`) | `SolicitCtx.requestId` (`steering.ts:185`), threaded to every tripwire row (`steering.ts:463-467`) | **CORRECT.** |
| V12 | The meter is engine-side and independent of `team-lead-driver.ts`'s final-turn overwrite (`:191-194`) | `steering.ts:445-457` meters from `reply.usage` inside the engine; `resident.ts:647` harvests `message_end` totals only | **CORRECT.** |
| V13 | Sizing note "≤200 normative / ≤400 total / Files to Modify ≤5" is satisfied as written | 302 lines, 5 files | **CORRECT** as an arithmetic claim — but see DF3.6-M6: the ≤5 limit is what forced the omissions in B6. |

---

## 2. Findings

| ID | Sev | Location | One-line |
|---|---|---|---|
| DF3.6-B1 | BLOCKER | `df3-6:95-112`, `:136`, `:228-238` | The engine cannot obtain the resident's root pid — the RSS watchdog is unimplementable from any file in scope. |
| DF3.6-B2 | BLOCKER | `df3-6:66-74`, `:132-134`, `:246-255` | AC2a's ordering assertion compares two host-side values the in-box engine structurally cannot read. |
| DF3.6-B3 | BLOCKER | `df3-6:141-155`, `:171`, `:277` | `runBudgetCapMicros` does not exist; DF2.8 ships a **per-issue** cap. The chain is a category error. |
| DF3.6-B4 | BLOCKER | `df3-6:91-94`, `:141` | `maxSteeringIterations = 8 per phase` is structurally unreachable — `MAX_RETRIES = 5`. AC3 has no producible trigger. |
| DF3.6-B5 | BLOCKER | `df3-6:33-43`, `:281` | The MANDATORY e2e demo's arithmetic is impossible against the shipped projection formula and any real rate. |
| DF3.6-B6 | BLOCKER | `df3-6:231-238` | Files to Modify forbids four edits that AC1/AC4/AC5/INV-BND-3 require, and omits the only `createSteering` call site. |
| DF3.6-H1 | HIGH | `df3-6:104-111`, `:136`, `:200-206` | Reinvents a shipped, hardened RSS watchdog and gets the platform dispatch wrong. |
| DF3.6-H2 | HIGH | `df3-6:95-100`, `:109-111`, `:198` | 5 s sample interval vs ~2.2 s calls; and there is no persistent resident process to probe at "resident start". |
| DF3.6-H3 | HIGH | `df3-6:104-107` | No baseline/scoping rule — an unscoped descendant walk charges tier-3 worker RSS to the 512 MiB resident bound. |
| DF3.6-H4 | HIGH | `df3-6:141-143`, `:177-190` | At shipped rates the ceiling is ~3,968 calls deep. The "absolute spend ceiling" never fires in production. |
| DF3.6-H5 | HIGH | `df3-6:24-29`, `:56-62`, `:207-210` | No clause for a bound firing against an already-degraded resident; the seam sits *after* the status gate. |
| DF3.6-H6 | HIGH | `df3-6:91-94` | AC3 bounds *solicitations*; the only shipped per-phase counter counts *accepted retry directives*. |
| DF3.6-M1 | MEDIUM | `df3-6:135`, `:180-185`, `:294` | Hardening Revision item 1 is backwards — `resolveRate` is shipped, exported, and already threaded to the engine. |
| DF3.6-M2 | MEDIUM | `df3-6:211-215` | F7 tripwire (a) is left undecidable — the two fields that compute it are never named. |
| DF3.6-M3 | MEDIUM | `df3-6:213-215` | F7 tripwire (c) "twice for the same cause" has a cardinality-1 cause and cannot recur within a run. |
| DF3.6-M4 | MEDIUM | `df3-6:81-84` | The AC2b clamp journal row has no home — the journal `resident` block is a closed key set. |
| DF3.6-M5 | MEDIUM | `df3-6:42`, `:212` | The tripwire row shape shown in the E2E slice omits fields the shipped interface requires. |
| DF3.6-M6 | MEDIUM | `df3-6:3`, `:302` | 3 points and a ≤5-file budget are no longer honest for what this story must now enforce in-box. |
| DF3.6-M7 | MEDIUM | `df3-6:52` | Dependency edges omit DF1.10 and DF1.11. |
| DF3.6-L1 | LOW | `df3-6:96-99` | `"overflow"` is asserted to be a CC-1 `ExitStatus` value but never cited to a file. |
| DF3.6-L2 | LOW | `df3-6:107-111`, `:203-206` | The darwin justification ("DF3.3's e2e demo runs on the darwin operator host") is stale post-DF1.10. |
| DF3.6-L3 | LOW | `df3-6:236` | `manifest.ts` is correctly in scope but the story never notes the schema is `.strict()`. |
| DF3.6-L4 | LOW | `df3-6:87-90` | AC2b's second negative control is now a tautology guaranteed by construction. |

---

### DF3.6-B1 — BLOCKER — the engine cannot obtain the resident's root pid

**Location:** `df3-6-resident-agent-bounds.md:95-112` (AC4, AC5), `:136` (Infra Prereq "RSS
sampling"), `:228-238` (Files to Modify).
**Code:** `src/fleet/resident.ts:116-127` (`ResidentSpawn`), `src/phase-engine/steering.ts:143-147`
(`ResidentCaller`), `src/phase-engine/steering.ts:11-13` (module boundary).

**Defect.** AC5 requires the watchdog to enumerate "the resident's **complete subprocess tree** —
root plus every descendant, walked by parent-pid links". That requires a root pid. The shipped
`ResidentSpawn` exposes exactly four members — `caller`, `rate`, `exitStatus()`, `stop()` — and no
pid. The `ResidentCaller` interface the engine actually receives exposes one member, `call()`. The
pi child pid lives in a closure-local `current: Bun.Subprocess | null` (`resident.ts:451`) that
nothing outside the closure can read. Files to Modify does not include `src/fleet/resident.ts`, and
`steering.ts`'s own header forbids the engine importing fleet code ("this file never imports fleet
code (module boundary, story R3 §9.2)" — `steering.ts:11-13`, independently verified: a grep for
provider/fleet imports under `src/phase-engine/` returns nothing). So no file in scope can reach the
process the bound is about. This is the ADR's load-bearing mechanism (2) — "F12 engine-enforced
resident bounds (shared process tree)" — and the shipped port shape blocks it.

**Failure scenario.** Dev opens `src/phase-engine/resident-bounds.ts`, needs a pid, finds none, and
takes the only reachable root: `process.pid` (the engine). See DF3.6-H3 for why that trips
spuriously on every `dispatch_task` phase. The alternative — importing `src/fleet/resident.ts` from
the engine — inverts INV-RES-1's module boundary and would be caught in review after the work is
done.

**Fix recipe.** Add `src/fleet/resident.ts` to Files to Modify (making it 6 files — see DF3.6-M6)
and inject the pid the same way `caller` and `rate` already are.

In `resident.ts`, extend `ResidentSpawn`:

```ts
export interface ResidentSpawn {
  caller: ResidentCaller;
  rate: { inputPerMTok: number; outputPerMTok: number };
  exitStatus(): Promise<ExitStatus | null>;
  stop(): Promise<void>;
  /** DF3.6: pid of the in-flight pi child, or null between calls. The engine
   *  owns the RSS bound (F12) and cannot reach `current` across the module
   *  boundary; this is the ONE fact it needs. Never the whole handle — a
   *  handle would let the engine kill without going through stop(). */
  pid(): number | null;
}
```
returned as `pid: () => current?.pid ?? null`.

In `steering.ts`, add to `createSteering`'s deps object (which its own docstring already says is
"Additive, so DF3.6 can add its bounds deps to the same object" — `steering.ts:398`):

```ts
  /** DF3.6: the resident's root pid, or null when no call is in flight. */
  residentPid?: () => number | null;
```

Rewrite `df3-6:136`'s Infra Prereq row to: *"RSS sampling — over the pi child rooted at
`deps.residentPid()`, injected from `ResidentSpawn.pid()` (fleet-owned, engine-consumed, the same
injection idiom as `caller`/`rate`); the engine imports no fleet code."*

---

### DF3.6-B2 — BLOCKER — AC2a compares two values the in-box engine cannot read

**Location:** `df3-6:66-74` (AC2a), `:132-134` (Infra Prereqs), `:246-255` (INV-BND-2).
**Code:** `src/providers/credentials.ts:47` (`defaultKeyCapMicroUsd`),
`src/providers/cost-ledger.ts:442,445,515` (`DEFAULT_COST_CONFIG`, `.sandbox/cost-config.json`,
`QDS_COST_CONFIG_FILE`), `src/phase-engine/steering.ts:11-13` (module boundary).

**Defect.** AC2a asserts `residentSpendCeilingMicros < runBudgetCapMicros ≤ defaultKeyCapMicroUsd`
"at **manifest load inside the box**". The clause about *where* is now correct (see §3). The clause
about *what* is not. `defaultKeyCapMicroUsd` is a constant in `src/providers/credentials.ts` — a
provider module the engine is forbidden to import (verified: zero provider imports anywhere under
`src/phase-engine/`). DF2.8's cap is worse: `loadCostConfig` reads it from
`.sandbox/cost-config.json` (`cost-ledger.ts:445`), a host-side path, and explicitly refuses to
guess when the file is unreadable (`cost-ledger.ts:548` "refusing to guess caps"). Inside the box
neither file exists. The story identified exactly this failure mode for `limitMicroUsd` and fixed it
by routing through the frozen manifest (V3) — and then left the other two operands as host-side
reads.

**Failure scenario.** The in-box engine starts, `loadResidentBounds` tries to read the cost config,
gets ENOENT, and either (a) falls back to the documented default 5,000,000 — which `df3-6:134` in
fact instructs ("absent config falls back to the documented default"), making the "assertion" a
comparison of two hardcoded constants that can never disagree at run time, i.e. a test that always
passes; or (b) refuses every in-box run. Both are wrong. (a) is the false-green: a misconfigured
host cap is exactly what AC2a exists to catch, and the box never sees it.

**Fix recipe.** Two operands, one delivery mechanism — the frozen manifest, the same one V3 already
uses. DF3.1's dispatch already stamps `limitMicroUsd` at fill; stamp the other two the same way.

Replace `df3-6:66-74` AC2a's operand sentence with:

> Given a manifest whose stamped `boundsPolicy` violates
> `residentSpendCeilingMicros < runBudgetCapMicros ≤ defaultKeyCapMicroUsd`, or a ceiling expressed
> as a percentage, ratio, or share of any run total, When `loadResidentBounds` runs, Then the run is
> **refused**. All three operands are **carried by value on DF1.1's frozen manifest**, stamped by
> DF3.1's dispatch at fill from the host's own `defaultKeyCapMicroUsd`
> (`src/providers/credentials.ts:47`) and `loadCostConfig().defaultCapMicroUsd`
> (`src/providers/cost-ledger.ts:442`) — the engine reads no host path and imports no provider
> module (`steering.ts:11-13` module boundary). A manifest missing any of the three **refuses the
> run** (fail-closed, INV-BND-2): a defaulted operand turns the assertion into a comparison of two
> constants that can never disagree, which is the false-green this AC exists to prevent.

And amend `df3-6:134`: delete *"absent config falls back to the documented default, never to
unbounded"* — that fallback IS the false-green. Replace with *"absent from the manifest ⇒ refuse
(INV-BND-2)"*.

**Note for the operator:** this makes DF3.1's stamping surface wider than `limitMicroUsd` alone. If
that is unacceptable, the alternative is to move AC2a's assertion host-side into DF3.1's dispatch
(where all three values are natively readable) and leave only AC2b's clamp in-box. That is arguably
cleaner and is *not* an ADR violation — the ADR relocates the engine, not the dispatcher. Flagging
the choice rather than making it.

---

### DF3.6-B3 — BLOCKER — `runBudgetCapMicros` does not exist; DF2.8 ships a per-issue cap

**Location:** `df3-6:141-155` (Technical Notes ordering invariant), `:171`, `:134`, `:277` (DoD).
**Code:** `src/providers/cost-ledger.ts:430-442` — `CostConfig.defaultCapMicroUsd`, *"Default
per-issue spend cap, µ$. 5,000,000 µ$ = $5.00"*; `cost-ledger.ts:609` `capForIssue`;
`df2-8…md:72,281` "per-issue overrides keyed `owner/repo#N`".

**Defect.** A repo-wide grep for `runBudgetCapMicros` returns exactly two kinds of hit: this story
and the sibling stories that copy it (DF2.3 `:123`, DF2.4 `:138`, DF2.7 `:134`). No code declares
it. The shipped value is `defaultCapMicroUsd` and it is a **per-issue** cap, keyed
`owner/repo#N`, enforced host-side at dispatch by `assertWithinBudget` — one issue routinely hosts
many runs, and the cap is consumed across all of them. `df3-6:171` compounds this by inventing a
naming rationale for a name that has no referent ("DF2.8's configured default `runBudgetCapMicros`
is a config-family constant — `Micros` by DD-9 lineage"). The chain as written compares a **per-run
resident ceiling** against a **per-issue budget** against a **per-key cap** — three different
denominators presented as one ordering.

**Failure scenario.** An issue with a 5,000,000 µ$ cap that has already spent 4,600,000 µ$ dispatches
a run. DF2.8 admits it (400,000 µ$ headroom) and DF2.3 mints `limitMicroUsd = 400,000`. AC2b's
clamp then correctly yields an effective resident ceiling of 400,000. Meanwhile AC2a has "validated"
2,000,000 < 5,000,000 ≤ 50,000,000 and reported the config sound. The ordering invariant told the
operator the resident can never consume the run's budget — but the run's *actual* budget was
400,000, four fifths of which the resident may spend. The invariant's stated meaning ("the resident
can never consume the run's budget", `:150-151`) is false in exactly the case it is supposed to
govern.

**Fix recipe.** Rename to the shipped symbol and state the denominator honestly. Replace
`df3-6:147-155` with:

> **The ordering invariant is a statement about *defaults*, and its three terms have three different
> denominators — stated once, because the chain is meaningless without them:**
> `residentSpendCeilingMicros` (per **run**, resident only, engine-enforced, this story) `<`
> `defaultCapMicroUsd` (per **issue**, host-side, DF2.8, `src/providers/cost-ledger.ts:442`; the
> story text formerly called this `runBudgetCapMicros`, a name no code declares) `≤`
> `defaultKeyCapMicroUsd` (per **key**, provider-enforced, DF2.3,
> `src/providers/credentials.ts:47`). The chain is a **configuration sanity check** — it proves the
> three defaults were not set in a nonsensical order — and is **not** a per-run headroom guarantee:
> an issue near its cap mints a `limitMicroUsd` far below `defaultCapMicroUsd`, and AC2b's clamp,
> not this chain, is what bounds the resident on that run. Strict `<` on the first pair, non-strict
> `≤` on the second.

Then delete `df3-6:171`'s invented-name rationale, and delete `df3-6:150-151` ("The resident can
never consume the run's budget, and the run can never consume the key's cap") — it is the false
claim. Also correct the DoD line `:277` (`runBudgetCap` → `defaultCapMicroUsd`).

**Cascade:** DF2.3 `:123-128,:210-211`, DF2.4 `:138-143` and DF2.7 `:134` carry the same invented
name. `df3-6:156-163` asserts DF2.3 holds a "**verbatim copy** … so the two texts do not differ and
there is nothing to reconcile at read time" and that "if a future edit makes them diverge, this
story is authoritative". That authority clause is correct and should be kept — it means fixing this
story fixes the family. Flag the three siblings to the campaign lead.

---

### DF3.6-B4 — BLOCKER — the iteration bound is structurally unreachable

**Location:** `df3-6:91-94` (AC3), `:141` (defaults).
**Code:** `src/phase-engine/types.ts:31` `export const MAX_RETRIES = 5;`;
`src/phase-engine/manifest.ts:225` `retries: z.number().int().min(MIN_RETRIES).max(MAX_RETRIES)`;
`scripts/pipeline-run.ts:2026-2071` (the retry loop and the sole `post_gate_failure` call site);
`src/phase-engine/steering.ts:86-87` (the closed three-point union).

**Defect.** `maxSteeringIterations` defaults to **8 per phase**. Count the solicitations a single
phase can produce in shipped code: `run_start` and `run_end` are once **per run**, not per phase
(`steering.ts:136-140`, `POINT_ALLOWLIST`). `post_gate_failure` fires once per gate failure inside
the DF1.3 retry loop, which exits at `attempt > spec.retries` (`pipeline-run.ts:2054`). `retries` is
schema-clamped to `MAX_RETRIES = 5`. So the maximum solicitations attributable to one phase is
**5 < 8**. The bound cannot fire on any schema-valid manifest.

**Failure scenario.** Dev implements the counter faithfully, writes the AC3 test, and discovers the
only way to reach 8 is a manifest that fails `PipelineManifestSchema` parse. Two bad outcomes
follow: either the test is written against a hand-constructed bounds object that bypasses the
manifest loader (asserting the bound *exists*, never that it *fires* — exactly the failure mode this
campaign is hunting), or `MAX_RETRIES` gets quietly raised to satisfy a bounds story, changing
DF1.3's retry discipline and `requiredBudgetMs`'s admission arithmetic (`manifest.ts:788-790`) as a
side effect.

**Fix recipe.** Set the default below the structural ceiling and say why. Replace `df3-6:141`'s
first bound with:

> `maxSteeringIterations` = **3 per phase** — deliberately below `MAX_RETRIES`
> (`src/phase-engine/types.ts:31` = 5), which is the structural ceiling on `post_gate_failure`
> solicitations in one phase (`scripts/pipeline-run.ts:2054`: the retry loop exits at
> `attempt > spec.retries`, and `retries` is schema-clamped to `MAX_RETRIES`). A default at or above
> 5 is a bound that can never fire and a test that can only assert the bound *exists*.

And add to AC3 a falsifiable trigger: *"Given a phase declaring `retries: 5` whose gate fails every
attempt, When the fourth `post_gate_failure` solicitation point is reached, Then …"* — with
`tests/phase-engine/fixtures/pipeline.bounds.json` declaring that phase. `pipeline.resident.json`'s
`build` phase (a `testCommand` that fails until the Nth attempt, using a `$TMPDIR` counter file) is
the working precedent to copy.

---

### DF3.6-B5 — BLOCKER — the MANDATORY e2e demo's arithmetic is impossible

**Location:** `df3-6:33-43` (E2E slice), `:281` (DoD, "Test (e2e demo — MANDATORY)"),
`:177-190` (the projection formula).
**Code:** `src/phase-engine/steering.ts:21,24` (`PROMPT_CHAR_CEILING = 16_000`,
`MAX_OUTPUT_TOKENS = 1_024`); `tests/phase-engine/fixtures/pi-catalog/openrouter.json`.

**Defect.** The story's projection is `((promptCharCeiling/4) × inputPerMTok + maxOutputTokens ×
outputPerMTok) / 1e6`. Both ceilings are **fixed constants** (`:186` says so: "Both ceilings are
DF3.3's per-call guards (16,000 chars / 1,024 tokens)"), so the projection is a function of the rate
alone: `(4000·in + 1024·out) / 1e6`. Against this repo's own resident-slug rates
(`tests/phase-engine/fixtures/pi-catalog/openrouter.json`: input 0.08, output 0.18 USD/MTok →
80,000 / 180,000 µ$ per MTok) the projection is:

```
(4000 × 80_000 + 1024 × 180_000) / 1e6 = (320_000_000 + 184_320_000) / 1e6 = 504 µ$
```

**504 µ$, not 900,000 µ$.** The E2E slice narrates "a fake resident whose replies each cost 900,000
µ$" — that is *metered* spend, which a fake resident can fabricate by reporting huge token counts.
But the refusal at the third point is driven by the **projection**, not the metered value. With
spend at 1,800,000 and a 504 µ$ projection, `1,800,000 + 504 = 1,800,504 < 2,000,000` → the call
**is** issued. The demo as specified cannot produce its own asserted outcome. There is no manifest
field to fix this from the fixture: `df3-6:183-185` states correctly that rates come from DF1.5's
models.json and "never a `cost` key on the roster schema, which is closed and carries none".

**Failure scenario.** Dev writes `pipeline.bounds.json`, runs the demo, watches the third
solicitation go through, and then "fixes" it — most likely by switching the refusal to compare
against *metered* spend after the fact, which is precisely the post-hoc implementation AC1's
negative control says MUST fail. The story's own make-or-break AC gets inverted to make its own
mandatory demo pass.

**Fix recipe.** Pin the projection, not the metered value, and pin it where rates actually live —
the fixture catalog. Replace `df3-6:33-43` with:

> **Demonstrable behavior:** Given `tests/phase-engine/fixtures/pipeline.bounds.json` declaring
> `residentSpendCeilingMicros: 2_000_000`, `maxSteeringIterations: 3`, `residentRssBytes: 512 MiB`,
> and a bounds-only pi catalog fixture
> (`tests/phase-engine/fixtures/pi-catalog-bounds/openrouter.json`, addressed by
> `QDS_PI_CATALOG_DIR`) pricing the resident slug at input 180.0 / output 40.0 USD-per-MTok — chosen
> so the fixed projection `(16000/4 × 180_000_000 + 1024 × 40_000_000) / 1e6` is **760,960 µ$** per
> call — When the run executes via `bun scripts/pipeline-run.ts --manifest <fixture> --journal
> out.json`, the engine solicits at run start (projected 760,960 ≤ 2,000,000 → allowed) → solicits
> at the first `post_gate_failure` (spent + 760,960 ≤ 2,000,000 → allowed) → reaches the second
> `post_gate_failure`, projects `spent + 760,960 > 2,000,000`, and **does not call** → stops the
> resident with `bound:"spend"` → the run completes deterministically. **The refusal is driven by
> the projection, never by metered spend** — that is what makes it a ceiling rather than a report of
> a breach already paid for. Observable artifact: `out.json` with `resident.status:"stopped"`,
> `resident.spendMicros` strictly below 2,000,000 at every point in the journal, a `residentTripwire`
> row `{runId, cause:"spend_ceiling_breach", phase:"build", detail}`, and every remaining phase and
> gate executed on the deterministic path.

Add `tests/phase-engine/fixtures/pi-catalog-bounds/openrouter.json` to Files to Modify (see
DF3.6-M6 on the file budget). Recompute the exact rate figures at authoring time — the ones above
are illustrative and MUST be re-derived so the arithmetic closes.

---

### DF3.6-B6 — BLOCKER — Files to Modify forbids the edits the ACs require

**Location:** `df3-6:231-235` — *"DF3.6 rebases last and **adds only** the `checkBounds(point)`
wrapper around the existing call sites: no fourth point, no new point, and **no edit to a DF3.3- or
DF3.4-owned line**"*; `:228-238` (the file list).

**Defect.** Four separate AC/invariant requirements each demand an edit inside DF3.3-owned code:

1. **AC4 / `:212` — tripwire causes.** `ResidentTripwire.cause` is a closed literal type:
   `cause: "gate_bypass_attempt"` (`steering.ts:199`), with a comment stating
   *"`spend_ceiling_breach` + `watchdog_kill` are DF3.6's to raise — the cause union stays closed to
   `gate_bypass_attempt` in DF3.3"*. DF3.6 must widen that union. `df3-3…md:632` confirms:
   *"DF3.6 owns widening the union."* That is a DF3.3-owned line.
2. **AC1 / AC4 — writing `status: "stopped"` and `exitStatus: "overflow"`.** `telemetry` is a
   module-private object inside `createSteering` (`steering.ts:420-428`) and the controller exposes
   only a **snapshot** getter that deep-copies on every read (`steering.ts:961-967`, "callers get a
   copy they can neither mutate through nor observe mid-flight mutation on"). There is no writer on
   the `SteeringController` interface. DF3.6 cannot write either field without adding one.
3. **INV-BND-3 — zero-usage charging.** The shipped `meter` explicitly does the opposite of what
   INV-BND-3 requires: *"A reply carrying no usage object meters as zero rather than throwing"*
   (`steering.ts:441-442`), implemented at `steering.ts:445-457` via `clampTerm`, which maps
   `undefined` to 0. INV-BND-3 mandates "charged the projected worst case, never zero". That is a
   behavioural change to a DF3.3-owned function.
4. **The wiring itself.** `createSteering` is called in `scripts/pipeline-run.ts` — the only call
   site. Passing bounds deps (`residentPid`, the loaded bounds, the tripwire sink) requires editing
   it. `scripts/pipeline-run.ts` is **not** in Files to Modify.

**Failure scenario.** Dev reads `:231-235` as binding, refuses to touch `steering.ts` beyond the
wrapper, and ships a `checkBounds` that computes the right verdicts and then has nowhere to record
them: no tripwire row (union closed), no `"stopped"` status (no writer), and a meter that still
charges zero for a usage-less reply. Every one of AC1's journal assertions fails, and the natural
"fix" is to add a parallel bounds-owned telemetry structure — a second resident record contradicting
the first.

**Fix recipe.** Replace `df3-6:231-235` with a precise, enumerated ownership carve-out:

> - `src/phase-engine/steering.ts` (shared, three-way, all in v5-S2 — **DF3.3 authors** the port and
>   its three solicitation points, **DF3.4** adds the `attach` inbox drain + ack append at those same
>   points, and **DF3.6 rebases last**). DF3.6's edits are **enumerated and closed** — no fourth
>   solicitation point, no new point, and nothing outside this list:
>   1. the `checkBounds(point)` call at the existing `SEAM DF3.6` comment (`steering.ts:858`);
>   2. widening `ResidentTripwire["cause"]` to
>      `"gate_bypass_attempt" | "spend_ceiling_breach" | "watchdog_kill"` (`steering.ts:199`) —
>      explicitly transferred to this story by DF3.3 (`df3-3…md:632`, and the comment at
>      `steering.ts:194-195`);
>   3. two internal writers so this story can set the fields DF3.3 declared for it —
>      `telemetry.status = "stopped"` and `telemetry.exitStatus = "overflow"` — reachable only from
>      inside `createSteering` (the controller keeps its snapshot-only getter, `steering.ts:961-967`;
>      no public setter is added, because a public setter is a path the resident's own tier could
>      reach and INV-BND-1 forbids it);
>   4. `meter`'s zero-usage arm (`steering.ts:445-457`): a reply with no usage object is charged the
>      projected worst case, never zero (INV-BND-3). **This reverses a documented DF3.3 disposition**
>      (`steering.ts:441-442`) and must be recorded in DF3.3's deviation ledger, not merely done;
>   5. the three new `createSteering` deps (`residentPid`, `bounds`, `onBoundBreach`) on the deps
>     object DF3.3 already marked additive for exactly this (`steering.ts:398`).
> - `scripts/pipeline-run.ts` — the sole `createSteering` call site; wires the new deps and the
>   watchdog's lifecycle to the resident's. No other change.

---

### DF3.6-H1 — HIGH — reinvents a shipped RSS watchdog, and gets the platform dispatch wrong

**Location:** `df3-6:104-111` (AC5), `:136` (Infra Prereq), `:200-206` (Technical Notes).
**Code:** `src/reverify/worktree.ts:210-380` — `withGuards`, `PS_ARGV`, `parsePsTable`,
`descendants`, the SIGTERM→grace→SIGKILL sweep.

**Defect.** The story specifies a **new** two-probe, platform-dispatched per-pid sampler:
`/proc/<pid>/status` `VmRSS` on Linux, `ps -o rss= -p <pid>` on darwin, with "unwatchable" defined
as *both* probes failing. This repo already ships a complete, hardened, review-scarred RSS watchdog
that does the same job with none of that machinery:

- One probe, both platforms: `PS_ARGV = ["ps", "-Ao", "pid=,ppid=,rss="]` (`worktree.ts:224`), with
  the explicit note *"ps reports RSS in KiB on both darwin and linux"* (`worktree.ts:231`). The
  Linux/darwin split the story builds a dispatcher for **does not exist**.
- Whole-tree enumeration by ppid links, re-read each sample: `descendants()` (`worktree.ts:267-283`).
- Sum-and-compare: `worktree.ts:351-359`.
- SIGTERM (via abort) then SIGKILL after a 5 s grace: `worktree.ts:322-346`, `KILL_GRACE_MS`.
- Baseline subtraction so pre-existing siblings are neither charged nor killed (F064,
  `worktree.ts:293-299`) — the defect DF3.6-H3 is about.
- A one-process-per-`ps` cost model, with the sync-baseline race already found and closed
  (`worktree.ts:242-249`).

The story's two-probe rule also produces a wrong "unwatchable" definition: `/proc` failing on Linux
while `ps` succeeds is a healthy, watchable resident under the shipped mechanism, but under
`df3-6:109-111` it is merely "not a degradation" — the story reaches the right answer through a rule
that exists only because it assumed two probes.

**Failure scenario.** Dev writes ~120 lines of platform dispatch, a `/proc` parser, and a
both-probes-failed predicate, then discovers `ps -Ao pid=,ppid=,rss=` already works on the in-box
Linux runtime and could have been three lines of reuse. The new parser is untested against real
`/proc/<pid>/status` output on the box image (the story's smoke test only asserts *a sample is
readable*, not that both parsers agree), and the two implementations drift.

**Fix recipe.** Replace `df3-6:104-111`'s sampling sentence and `:200-206` with:

> **RSS sampling reuses the shipped mechanism, it does not re-derive one.**
> `src/reverify/worktree.ts:210-380` already samples a descendant process tree from
> `ps -Ao pid=,ppid=,rss=` — one probe, identical output on darwin and Linux (`worktree.ts:231`) —
> sums it, and fires SIGTERM-then-SIGKILL-after-grace (`KILL_GRACE_MS`, DF2.4 group-kill doctrine,
> R3). This story extracts `parsePsTable` / `descendants` / the sample-and-sum loop into a shared
> helper and parameterises the root pid and the bound; it introduces **no** `/proc` parser and **no**
> platform dispatch. "Unwatchable — and therefore resident-not-started" means the `ps` probe fails
> or returns no row for the root pid on the running platform (INV-BND-5 fail-closed).
> `ponytail:` RSS stays `ps`-sampled rather than cgroup-enforced — the same standing ceiling DF5.1
> carries and names (`worktree.ts:288-292`); it catches a runaway allocator, not a sub-interval
> spike. **The upgrade path, now that the engine runs in-box under systemd** (ADR: "systemd is PID 1
> and `running`"), is a transient scope per solicitation
> (`systemd-run --scope --property=MemoryMax=…`), which makes the bound kernel-enforced instead of
> poll-enforced. Named here, not built here.

**Recommendation (the enterprise-grade answer, since the brief asks for a decision):** ship
`ps`-sampling now, with the cgroup path named. Two reasons, not one: (a) the ADR's whole argument is
that in-box placement makes the *existing* watchdog correct — "re-aimed, not deleted" — and building
a second mechanism throws that away; (b) `MemoryMax=` is genuinely better (kernel-enforced, no poll
interval, no pid race) but it changes how the resident is spawned, which is `src/fleet/resident.ts`
and DF2.10's image, and folding that into a 3-point bounds story is how a story becomes an epic.
Ship the reuse; file the cgroup upgrade as a follow-up against DF5.1's existing ceiling so there is
**one** ticket for the one exposure rather than two.

---

### DF3.6-H2 — HIGH — the sampler has no process to sample for most of the run

**Location:** `df3-6:95-100` (AC4), `:109-111` (AC5 "never started"), `:136`, `:198`
("Sample interval 5,000 ms").
**Code:** `src/fleet/resident.ts:384-448` (`startResident` spawns nothing), `:473-551`
(`Bun.spawn` inside `call`), `:451` (`current` null between calls); ADR `:83-84` (measured in-box
solicitation: **2.17 s**).

**Defect.** The story reads as though the resident is a long-lived process tree the watchdog polls.
It is not. `startResident` arms a closure and spawns nothing; every solicitation spawns a fresh pi
via `Bun.spawn` and the handle is nulled at `resident.ts:592`. Two consequences:

- **The 5,000 ms interval is longer than a call.** The ADR's own measurement of a real in-box pi
  solicitation is **2.17 s**. A 5 s sampler will, on most solicitations, take zero samples of a live
  resident. A pi that balloons and exits inside one call window is never observed. Worse, samples
  taken *between* calls find no pid at all and — under a naive read of AC5 — could be classified
  "unwatchable" and stop a healthy resident.
- **"A resident is declared unwatchable, and therefore never started" has no referent.** At
  `startResident` time there is no process to probe. The probe can only run *after* the first
  `Bun.spawn`, by which point the resident has already started and already spent.

**Failure scenario.** Run with a leaking pi child that grows to 900 MiB over a 3 s call and exits.
The 5 s timer fires before the call and after it, sees no pid both times, and the bound never
evaluates. `resident.exitStatus` reads `"success"`. The 512 MiB bound is documented, tested for
existence, and has never once been evaluated against a live process. AC4's "post-run pid-tree check
finds no orphaned child" passes trivially — pi already exited.

**Fix recipe.** Bind the sampler's lifecycle to the call, not to the run. Replace `df3-6:198`'s
interval sentence:

> **The sampler runs only while a call is in flight, and fast enough to see one.** The resident is
> not a long-lived process: `startResident` spawns nothing (`src/fleet/resident.ts:384-448`) and
> every solicitation spawns a fresh pi whose handle is released at
> `src/fleet/resident.ts:592` — a measured in-box solicitation takes **2.17 s** (ADR
> `2026-08-31-tier2-placement-adr.md:83-84`). Sample interval **500 ms**, started when
> `deps.residentPid()` first returns non-null for a call and stopped when it returns null; a null
> pid between calls is **not** an unwatchable resident and raises nothing.

And replace AC5's start-gate clause (`df3-6:109-112`) with:

> …and a resident is declared **unwatchable, and therefore stopped before its next solicitation**
> (never mid-call), when the `ps` probe fails or returns no row for a root pid that
> `deps.residentPid()` reports as live. The check runs at the **first** solicitation's spawn — the
> earliest moment a process exists to probe — not at `startResident`, which spawns nothing. When it
> fires before any call has been metered, the journal records `resident.status: "disabled"` (DF3.3's
> closed set); when it fires after, `"stopped"`. The bounds-check log line carries
> `bound: "rss", allowed: false, cause: "unwatchable"`; no `residentTripwire` row is emitted, leaving
> DF3.3's closed three-cause set unchanged for this path.

---

### DF3.6-H3 — HIGH — no baseline/scoping rule; the bound will trip on tier-3 workers

**Location:** `df3-6:104-107` (AC5's tree definition).
**Code:** `src/reverify/worktree.ts:293-311` (F064 baseline subtraction and its rationale);
`src/phase-engine/phases/dispatch-task.ts:290-298` (`QDS_TEAM_RUNNER=local`);
`df1-10…md:34,128` (in-box `dispatch_task` resolves `file:"bun"` on PATH, `QDS_TEAM_RUNNER=local`).

**Defect.** AC5 defines the watched set as "the resident's complete subprocess tree — root plus
every descendant". Correct in principle — but with no root pid available (DF3.6-B1) the only
reachable root is the engine process, and in-box the engine also parents every tier-3
`dispatch_task` worker (`QDS_TEAM_RUNNER=local`). Charging a bun team-lead and its workers to a
512 MiB **resident** bound trips it on the first `dispatch_task` phase of every real run. This is
verbatim the F064 defect already found and fixed once in `worktree.ts:293-299`: *"In a long-lived
host … `descendants(process.pid)` is full of children that have nothing to do with this run;
charging their RSS to this bound tripped it spuriously, and the sweep then SIGKILLed them."* The
story shows no awareness that the mistake exists or that it has already been paid for.

**Failure scenario.** A `dispatch_task` phase spawns a bun team-lead. Combined RSS crosses 512 MiB.
The watchdog fires, SIGKILLs "the resident tree" — which under an engine-rooted walk includes the
team-lead and its workers — and writes `resident.exitStatus: "overflow"`. The run loses its tier-3
workers, the phase fails for a reason no journal row explains, and the resident (which used ~40 MiB)
is blamed.

**Fix recipe.** With B1's fix in place, root the walk at the pi pid, and say so explicitly so no dev
reaches for `process.pid`. Append to AC5 after "…walked by parent-pid links":

> The walk is rooted at **`deps.residentPid()`** — the in-flight pi child — and **never** at the
> engine process. In-box the engine also parents every tier-3 `dispatch_task` worker
> (`QDS_TEAM_RUNNER=local`, `src/phase-engine/phases/dispatch-task.ts:290-298`), so an
> engine-rooted walk charges a bun team-lead's memory to a 512 MiB **resident** bound and trips on
> the first dispatch phase of every real run. This is F064, already found and fixed once
> (`src/reverify/worktree.ts:293-299`); it is not to be rediscovered. *Negative control: an
> implementation rooting the walk at `process.pid` passes a naive "does the watchdog fire?" test on
> a synthetic allocator and MUST fail a test in which a `dispatch_task` phase runs beside a small
> resident.*

Add the matching DoD test line.

---

### DF3.6-H4 — HIGH — at shipped rates the "absolute spend ceiling" cannot fire

**Location:** `df3-6:141-143` (defaults), `:177-190` (the projection), `:56-62` (AC1, make-or-break).
**Code:** `steering.ts:21,24`; `tests/phase-engine/fixtures/pi-catalog/openrouter.json`.

**Defect.** Same arithmetic as B5, aimed at the default rather than at the demo. The projection is
`(4000·in + 1024·out)/1e6` = **504 µ$** at the resident slug's real rates. The default ceiling is
2,000,000 µ$. The ceiling therefore binds at ~**3,968 solicitations**. A run's maximum solicitation
count is `1 (run_start) + 1 (run_end) + Σ_phases retries` — with `MAX_RETRIES = 5` and a manifest of,
say, ten phases, that is at most 52. The ceiling is three orders of magnitude out of reach. AC1's
"make-or-break" behaviour is unreachable outside a fixture with a fabricated rate.

This is not fatal on its own — a catastrophic backstop is a legitimate design — but the story
presents it as the operational control that replaced the 15% ratio, and D4's F7 tripwire (a) is
about *operational* resident cost. As written, the resident could consume its entire realistic
budget and the "absolute spend ceiling" would never notice.

**Failure scenario.** A pathological run: a phase whose gate fails 5 times, ×10 phases, 52
solicitations, ~26,000 µ$ of resident spend on a run whose `limitMicroUsd` is 400,000 µ$ — 6.5% of
the run key, plausibly well over 15% of the *team* total on a cheap roster. The ceiling never fires.
The story's stated purpose — "a resident agent that … burns money is stopped by the component it
cannot influence" — is not achieved by the number it ships.

**Fix recipe.** Two honest options; recommend the first.

1. **Lower the default and state the derivation.** Replace `df3-6:141-143`'s third bound with:
   > `residentSpendCeilingMicros` = **50,000 µ$ ($0.05) per run**, absolute. Derived, not chosen:
   > the projection is fixed at `(PROMPT_CHAR_CEILING/4 × inputPerMTok + MAX_OUTPUT_TOKENS ×
   > outputPerMTok)/1e6` (both ceilings are constants — `steering.ts:21,24`), which is **504 µ$** at
   > the resident slug's shipped rates
   > (`tests/phase-engine/fixtures/pi-catalog/openrouter.json`: 0.08/0.18 USD per MTok). 50,000 µ$
   > therefore binds at ~99 solicitations, comfortably above a healthy run's maximum
   > (`1 + 1 + Σ retries`, with `retries ≤ MAX_RETRIES = 5`) and far below a runaway's. A ceiling
   > that binds only after thousands of calls is a number, not a bound.
2. Keep 2,000,000 and add one sentence to `:207-210` stating plainly that the ceiling is a
   catastrophic backstop against a rate misconfiguration or a frontier-model resident slug, that it
   is **not** expected to fire on a normally-priced roster, and that operational resident cost is
   governed by the iteration bound and D4's F7 tripwire (a) instead.

Either way, recompute at authoring time — the 504 µ$ figure moves with the roster.

---

### DF3.6-H5 — HIGH — a bound firing against an already-degraded resident is undefined

**Location:** `df3-6:24-29` (Overview), `:56-62` (AC1), `:207-210` (breach behaviour).
**Code:** `steering.ts:854-858` (the status gate sits immediately **before** the `SEAM DF3.6`
comment); `steering.ts:822-827` (`telemetry.status` is a one-way latch — "three paths write
`degraded` and nothing anywhere writes `active` back"); `df1-10…md:567-568` ("DF3.3 degrades OPEN at
four points"); `df1-10…md:586-587` (a live round measured a real degradation: first solicit took
32,579 ms against the ceiling, resident degraded, later points returned PROCEED).

**Defect.** DF3.3's resident degrades OPEN at four points (call failure, prompt-render failure, two
consecutive malformed replies, and the `disabled` arm on `RateError`), and DF1.10's live rounds
measured one degradation in five runs — this is a routine state, not an edge. The `SEAM DF3.6`
comment sits at `steering.ts:858`, **after** the `telemetry.status !== "active"` early return at
`:854-857`. So:

- Once the resident is degraded, `checkBounds` never runs again. The spend and iteration bounds stop
  being evaluated for the rest of the run. Harmless in isolation (no calls are being made), but
  nothing in the story says so, and a dev may "fix" it by hoisting `checkBounds` above the status
  gate — which would then evaluate bounds against a resident that cannot spend.
- **AC1's journal assertion becomes unsatisfiable on a degraded run.** `status` is a one-way latch
  with no writer back to `active`. A resident that degraded at solicitation 2 and would have
  breached the ceiling at solicitation 4 ends the run `"degraded"`, never `"stopped"`. AC1 asserts
  `resident.status:"stopped"`; there is no stated precedence between the two terminal values.
- The RSS watchdog is a **timer**, not gated by `solicit` — it can fire against a resident already
  degraded, writing `exitStatus: "overflow"` over whatever the degradation left, and calling
  `stop()` on a resident with no live process.

**Failure scenario.** A run whose first solicitation times out (`degraded`) and whose pi child from
that timed-out call is still resident in memory when the 500 ms sampler fires. The watchdog kills a
process the timeout's SIGKILL already reaped, emits `watchdog_kill`, sets `status = "stopped"` over
`"degraded"`, and the journal now says the resident was stopped for RSS when it actually timed out.
The degradation reason — the only record of what really happened — lives on
`lastDegradationReason`, which `df1-10…md:571` confirms is not journaled.

**Fix recipe.** Add a fourth clause to the "Breach behavior is uniform and narrow" note
(`df3-6:207-210`):

> **Precedence against an already-degraded resident, stated once.** DF3.3 degrades OPEN at four
> points and `telemetry.status` is a **one-way latch** — nothing writes `"active"` back
> (`src/phase-engine/steering.ts:822-827`). Therefore: (a) `checkBounds` is called at the
> `SEAM DF3.6` position **after** the status gate (`steering.ts:854-858`) and is deliberately
> **not** evaluated for a non-`active` resident — a resident that cannot call cannot spend, and
> hoisting the check above the gate would evaluate a bound against a resident with no future calls;
> (b) the RSS sampler stops when `deps.residentPid()` returns null, so it cannot kill a process the
> resident's own timeout already reaped; (c) `"degraded"` and `"stopped"` are both terminal and
> **`"stopped"` wins only when this story's enforcement is the proximate cause** — a bound that
> fires after a degradation already latched leaves `"degraded"` standing and records the bound on
> the bounds-check log line alone. AC1's `resident.status:"stopped"` assertion is therefore scoped
> to a run whose resident was `active` at the breach.

Add the matching negative control to the AC1 DoD test line: *an implementation that overwrites
`"degraded"` with `"stopped"` MUST fail.*

---

### DF3.6-H6 — HIGH — AC3 bounds a quantity the code does not count

**Location:** `df3-6:91-94` (AC3), `:223` (Observability, `iterations`).
**Code:** `steering.ts:209-211` (`steeringIterations: Record<string, number>`),
`steering.ts:944-951` (the increment), `df3-3…md:625` (S1-8: "degradation routes leave no countable
telemetry field — the resident journal block is AC5's closed key set; adding a counter is spec
drift. Recorded here for the story that owns the journal contract").

**Defect.** AC3's trigger is "the resident has already been **solicited** `maxSteeringIterations`
times". The only shipped per-phase counter increments on a **narrower** event: an *accepted* `retry`
directive at `post_gate_failure` (`steering.ts:949-951`), with the explicit rationale *"the
per-phase counter is steering proof, so it must not be inflated by a retry that cannot run"*. Three
different quantities are in play — solicitations issued, directives accepted, retries accepted — and
the story names one while the code counts another. A resident that is solicited 5 times and replies
`{"action":"proceed"}` every time increments `steeringIterations` **zero** times and is never
bounded, even though it spent five calls' worth of tokens.

DF3.3 explicitly deferred the new-counter question to "the story that owns the journal contract".
DF3.6 is that story, and it does not answer.

**Failure scenario.** A resident stuck in a proceed-loop: 5 gate failures, 5 solicitations, 5
`proceed` replies, 5 × 504 µ$ spent, `steeringIterations["build"] === 0`. The iteration bound never
evaluates. AC3's test — if written against `steeringIterations` — passes by asserting the *retry*
path, and the loop the bound exists to stop runs unbounded.

**Fix recipe.** Decide, and say which. Replace AC3 (`df3-6:91-94`) with:

> 3. **The iteration bound counts solicitations issued, not directives accepted.** Given a phase in
>    which the engine has already **issued** `maxSteeringIterations` solicitations, When it reaches a
>    further solicitation point in that same phase, Then it does not solicit, the phase completes on
>    the deterministic path, and **subsequent phases solicit normally** — the bound is per phase, not
>    per run. The counter is **not** DF3.3's `telemetry.steeringIterations`, which increments only on
>    an *accepted `retry` directive at `post_gate_failure`* (`src/phase-engine/steering.ts:949-951`)
>    and stays at zero for a resident that replies `proceed` on every call — a proceed-loop is
>    exactly the loop this bound exists to stop. This story therefore keeps its own per-phase
>    solicitation counter **inside `resident-bounds.ts`**, surfaced on the bounds-check log line's
>    `iterations` field (Observability Contract) and **not** on the journal's `resident` block, whose
>    key set DF3.3 closed (`df3-3…md` AC5; the deferral is recorded at `df3-3…md:625`). *Negative
>    control: an implementation bounding `telemetry.steeringIterations` lets a resident that replies
>    `proceed` on every solicitation run unbounded and MUST fail this test.*

---

### DF3.6-M1 — MEDIUM — the Hardening Revision "fixed" a citation that was correct

**Location:** `df3-6:294` (Hardening Revision item 1), `:135` (Infra Prereq), `:180-185`.
**Code:** `src/phase-engine/roster/validate.ts` (`resolveRate`, `RateSources`);
`src/fleet/resident.ts:27,410` (imports and calls it); `resident.ts:677` (`ResidentSpawn.rate`);
`steering.ts:395` (`createSteering({rate})`); `steering.ts:446-447` (`rateInput`/`rateOutput`).

**Defect.** The 2026-08-20 revision records: *"Fixed DRIFTED DF1.5 rate citation: removed
unverifiable `resolveRate(slug)` export claim; now cites direct models.json load."* `resolveRate` is
shipped, exported, imported by `resident.ts:27`, and called at `resident.ts:410` with a
`_injectRateSources` test seam beside it. Better: the resolved rate is **already threaded into the
engine** — `startResident` returns it on `ResidentSpawn.rate`, and `createSteering` takes it as
`deps.rate`. DF3.6 needs no models.json loader at all; it needs `deps.rate`. The revision removed
the correct citation and replaced it with a mechanism the story would have to build.

**Failure scenario.** Dev writes a models.json reader in `resident-bounds.ts`, a second rate
resolution path beside `resolveRate`'s. The two disagree the first time a catalog is staged
differently in-box (`QDS_PI_CATALOG_DIR`, `df1-10…md:120`), and the projection prices against a rate
the resident is not actually billed at — silently, in the direction of under-projecting.

**Fix recipe.** Replace `df3-6:135`'s Infra Prereq row with:

> | resident slug rate | already resolved: `resolveRate` (`src/phase-engine/roster/validate.ts`) is called once at arming by `startResident` (`src/fleet/resident.ts:410`) and the result is handed to the engine as `ResidentSpawn.rate` → `createSteering({ rate })` (`src/phase-engine/steering.ts:395`) | **this story reads `deps.rate.inputPerMTok` / `deps.rate.outputPerMTok` and loads nothing.** One resolution per run, one source. A second models.json reader in `resident-bounds.ts` would be a second rate path that can disagree with the one the resident is billed at. |

And correct `:294`: item 1's fix is itself DRIFTED; the `resolveRate` citation was right.

---

### DF3.6-M2 — MEDIUM — F7 tripwire (a) is left undecidable

**Location:** `df3-6:211-215`.
**Code:** `steering.ts:212` (`spendMicros`); `df3-3…md:102` (DF2.1's run record `spendMicroUsd` is
the run total).

**Defect.** The story is right to refuse the 15% ratio as a *field* (V2, binding). But D4's tripwire
(a) — "resident-agent token spend > 15% of run total at p50" — is still a live demotion criterion
that someone must evaluate after month 1, and the story says only "This story counts nothing"
without naming the two numbers that make it computable. As written, an evaluator has to rediscover
that the numerator is the journal's `resident.spendMicros` and the denominator is DF2.1's run record
`spendMicroUsd`, and that the p50 is taken across runs. Undecidable-in-practice tripwires are the
F7 failure mode.

**Fix recipe.** Append to `df3-6:211-215`:

> **D4's tripwire (a) is computable from run data without a ratio field ever existing.** Numerator:
> the journal's `resident.spendMicros` (engine-metered, this story's meter, integer µ$). Denominator:
> DF2.1's run record `spendMicroUsd` — the run total (`df3-3…md:102`, that record is closed and this
> story adds no field to it). The p50 is taken **across runs** by the month-1 evaluator, never by
> the engine, and neither number is a ratio at rest. This is what makes the ratio's re-spec as an
> absolute ceiling (gates report §3.3, R5 §6 fact 12) a *re-spec* and not a deletion of D4's
> evidence.

---

### DF3.6-M3 — MEDIUM — F7 tripwire (c) has a cardinality-1 cause and cannot recur in a run

**Location:** `df3-6:211-215`.
**Code:** `resident.ts:681-705` (`stop()` latches `stopped = true`; every later `call` throws at
`resident.ts:474`).

**Defect.** The story wires tripwire (c) — "any steering loop the watchdog kills **twice for the
same cause**" — by carrying "the kill cause verbatim" in `detail`. Two problems: (1) the watchdog's
only kill cause is RSS overflow, so "the same cause" has cardinality 1 and the qualifier
discriminates nothing; (2) `stop()` sets `stopped = true` permanently and every subsequent `call`
throws, so a second watchdog kill **within one run** is impossible. Tripwire (c) is only evaluable
*across* runs — which is fine and is what `runId` on the row is for — but the story never says so,
and a reader will look for an in-run counter that cannot exist.

**Fix recipe.** Replace the tripwire-(c) sentence at `df3-6:213-215` with:

> …and `detail` carrying the kill cause verbatim. D4's tripwire (c) — "any steering loop the
> watchdog kills **twice for the same cause**" — is computable **across runs**, keyed on the row's
> `runId` + `cause`, never within one: `stop()` latches (`src/fleet/resident.ts:681-705`) and a
> second kill in the same run is structurally impossible. The `detail` field carries the measured
> RSS and the root pid so two kills are comparable; the *cause* discriminator has cardinality one
> today (RSS overflow is the watchdog's only kill), and a second kill cause would be a new tripwire
> `cause` member, not a new `detail` string. This story counts nothing.

---

### DF3.6-M4 — MEDIUM — the AC2b clamp journal row has no home

**Location:** `df3-6:81-84`.
**Code:** `steering.ts:204-219` (`ResidentTelemetry` is a closed shape); `journal.ts:211-221`
(`resident?: ResidentTelemetry`); `df3-3…md` AC5 (closed key set, no ratio field);
`df1-10…md:571` ("the journal's resident block is a closed key set and cannot carry one").

**Defect.** AC2b requires "a journal row `{ bound:"spend", action:"clamped", configuredMicros,
limitMicroUsd, effectiveMicros }`". The journal's `resident` block is a **closed key set** DF3.3
owns, and the story elsewhere is scrupulous about this (`:96-99`, `:112` — "adds no field of its
own"). This row has no declared destination. The same gap applies to the Observability Contract's
bounds-check line (`:223`).

**Fix recipe.** Route both to the trace/log stream, not the journal block. Amend `df3-6:81-84`:

> …Then a row `{ bound:"spend", action:"clamped", configuredMicros, limitMicroUsd, effectiveMicros }`
> is written to the **engine's trace/log stream** — not to the journal's `resident` block, whose key
> set DF3.3 closed (`df3-3…md` AC5; `src/phase-engine/steering.ts:204-219`) and which this story
> widens only for the two values DF3.3 reserved for it (`status:"stopped"`, `exitStatus:"overflow"`)
> — and the run **proceeds**.

Add the same clause to the Observability Contract (`:223-226`).

---

### DF3.6-M5 — MEDIUM — the tripwire row shape omits required fields

**Location:** `df3-6:42` (E2E slice: `{cause:"spend_ceiling_breach", phase:"build"}`), `:212`.
**Code:** `steering.ts:196-202` — `ResidentTripwire` requires `runId` and `detail`; `requestId` and
`phase` are optional.

**Defect.** The E2E slice's asserted row omits `runId` and `detail`, both non-optional on the
shipped interface. `:212` gets the full shape right (`{ runId, requestId, cause, phase, detail }`),
so this is an internal inconsistency, but the E2E slice is what the mandatory demo test will be
written from.

**Fix recipe.** In `df3-6:42`, replace `` a `residentTripwire` row `{cause:"spend_ceiling_breach",
phase:"build"}` `` with `` a `residentTripwire` row `{runId, cause:"spend_ceiling_breach",
phase:"build", detail}` — the full shipped shape (`src/phase-engine/steering.ts:196-202`; `runId`
and `detail` are required, `requestId` and `phase` optional) ``.

---

### DF3.6-M6 — MEDIUM — 3 points and a 5-file budget are no longer honest

**Location:** `df3-6:3` (Story Points: 3), `:302` ("Files to Modify ≤5"), `:228-238`.

**Defect.** The ADR says "re-sequence after the engine story" — sequencing was addressed, sizing was
not. What the story must now deliver: a pid accessor on the fleet port and its test seam (B1); a
manifest schema extension plus DF3.1 stamping for two more operands (B2); a reused-and-parameterised
RSS sampler with call-scoped lifecycle and F064 scoping (H1/H2/H3); four enumerated edits inside
DF3.3-owned `steering.ts` including a reversal of a documented disposition (B6); wiring in
`scripts/pipeline-run.ts`; and a bounds pi-catalog fixture so the mandatory demo's arithmetic closes
(B5). The ≤5-file budget is itself load-bearing on the defect: it is what pushed
`src/fleet/resident.ts` and `scripts/pipeline-run.ts` out of scope, which is how B1 and B6 came to
exist.

**Structural proposal — re-size and re-split.** Recommend **5 points**, or a split into two stories
that can land independently:

- **DF3.6a — Spend & iteration bounds (3 pts).** `loadResidentBounds` + `checkBounds`, the
  pre-flight projection off `deps.rate`, the manifest fields, AC1/AC2a/AC2b/AC3, the tripwire union
  widening, the `meter` zero-usage reversal, and the e2e demo. Touches `resident-bounds.ts`,
  `manifest.ts`, `steering.ts`, `pipeline-run.ts`, tests, fixtures. No fleet-layer change.
- **DF3.6b — RSS watchdog (2 pts).** The `pid()` accessor on `ResidentSpawn`, extraction of
  `worktree.ts`'s sampler into a shared helper, call-scoped lifecycle, F064 root scoping, AC4/AC5,
  `exitStatus:"overflow"`. Touches `src/fleet/resident.ts` and `src/reverify/worktree.ts` — a
  different blast radius, a different reviewer, and the only half that needs a live in-box round.

The split is not cosmetic: 3.6a is pure engine and testable host-side; 3.6b crosses the fleet
boundary and needs the box. Bundling them means neither lands until both are right.

Update `:302`'s size-compliance line to whatever the split yields.

---

### DF3.6-M7 — MEDIUM — dependency edges omit DF1.10 and DF1.11

**Location:** `df3-6:52` — "Dependency edges (predecessors): DF1.1, DF1.5, DF2.3, DF2.8, DF3.3."

**Defect.** Every in-box premise this story now relies on — the engine running in-box, `/run` being
tmpfs, `QDS_TEAM_RUNNER=local`, `QDS_PI_CATALOG_DIR`, the single key at `$HOME/app/.env`, the
terminal marker as the host's observation channel — is DF1.10's. The steering channel the DF3.4 acks
ride is DF1.11's. The ADR's Consequence 5 says exactly this ("re-sequence after the engine story")
and the edge list was never updated. DF3.4 `:446` already records that "DF3.4 and DF3.6 both assume
an **in-box engine**."

**Fix recipe.** Replace `:52` with:

> **Dependency edges (predecessors):** DF1.1, DF1.5, **DF1.10** (in-box phase engine — every in-box
> premise below is its: `QDS_TEAM_RUNNER=local`, `QDS_PI_CATALOG_DIR`, the single key at
> `$HOME/app/.env`, `QDS_RUN_ROOT` unset so `runMarkerRoot()` returns `/run`, and the terminal
> marker as the host's only observation channel), **DF1.11** (in-box steering executor — the
> solicitation points this story wraps run inside its engine), DF2.3, DF2.8, DF3.3. Sequenced after
> the engine story per `docs/superpowers/specs/2026-08-31-tier2-placement-adr.md` Consequence 5.

---

### DF3.6-L1 — LOW — `"overflow"` is never cited to a file

`df3-6:96-99` asserts `resident.exitStatus` takes `"overflow"` as a CC-1 `ExitStatus` value.
`ExitStatus` is imported from `cli-anything/src/types.ts` (`steering.ts:18`, `resident.ts:25`). The
values observed in shipped code are `"success" | "transient" | "logic"` (`resident.ts:589,612,637,
640,653`). Whether `"overflow"` is a member was **not** verified in this scan. Fix: cite the file and
line for the enum, and add a DoD line asserting `"overflow"` is a member — if it is not, widening it
is a cross-repo change and a BLOCKER in its own right.

### DF3.6-L2 — LOW — the darwin justification is stale

`df3-6:107-111` and `:203-206` justify the darwin probe with "DF3.3's e2e demo runs on the darwin
operator host". Post-DF1.10 the e2e demo runs **in-box on Linux** (`df1-10…md:202`). Darwin remains
relevant only for host-side unit tests. With H1's fix (one `ps` probe on both platforms) the whole
justification becomes moot; if any of it survives, restate it as "host-side unit tests run on
darwin", not "the e2e demo does".

### DF3.6-L3 — LOW — `.strict()` schema not noted

`df3-6:236` correctly scopes `src/phase-engine/manifest.ts`, but never notes that
`PipelineManifestSchema` is `.strict()` (`manifest.ts:317`) — so the three bound fields **must** be
added to the schema or `pipeline.bounds.json` fails parse with `unrecognized_keys`. One sentence in
Technical Notes saves a dev a confusing first run.

### DF3.6-L4 — LOW — AC2b's second negative control is now a tautology

`df3-6:88-90`'s second negative control ("an implementation that reads `.sandbox/runs/<id>.json`
from inside the box, which finds nothing on every real run") is now guaranteed by construction:
`df1-10…md:189` records that the engine reads no `.sandbox/runs/` path in-box "for the designed
reason rather than by accident", and the DoD grep at `:279` enforces it. Keep the grep (it is a real
fence), but downgrade the prose from a live negative control to a statement of the fence, so nobody
spends a test proving something the grep already proves.

---

## 3. In-box clause reconciliation — `df3-6…md:69-90`, clause by clause

This is the passage the ADR cites as evidence the deviation was silent
(`2026-08-31-tier2-placement-adr.md:53-54`: "Unimplemented DF3.6 still charters in-box
(`df3-6…md:69-90`)"). Verdicts: **CORRECT-NOW** / **CORRECT-INTENT-WRONG-MECHANISM** / **STALE**.

| Lines | Clause | Verdict | Evidence |
|---|---|---|---|
| `:68-70` | "The check runs where the engine and the manifest actually live — at **manifest load inside the box, before the resident is spawned and before the first solicitation**" | **CORRECT-NOW** | DF1.10 shipped the engine in-box under a systemd unit (`df1-10…md:128`). The manifest is fill'd into the box and read by the in-box loader (`manifest.ts:303-313`, "the read path IS the delivery path"). `startResident` spawns nothing at arming (`resident.ts:384-448`), so "before the resident is spawned" is a real, reachable moment. This clause was *wrong* during the host-side interregnum and is right again — exactly as the ADR predicted. |
| `:70-71` | "because 'before a box exists' is structurally unreachable for engine code" | **CORRECT-NOW** | And now correct for the *designed* reason rather than by accident. Independently confirmed by `df1-10…md:189`. |
| `:71-73` | "The refusal exits **non-zero numerically** and carries `{ code, message, remediation }` **in its payload** — the house rule of DF3.1 AC3" | **CORRECT-NOW** (the payload half) | The code-is-payload-never-exit-code rule is a repo-wide idiom; `df1-10…md:572-574` records the same lesson learned the hard way (`teardownQuietly` losing the code to a 300-char tail). |
| `:73-74` | "leaves the box **alive** with its evidence and its printed teardown command (DF2.2 INV-5), and spawns no resident" | **CORRECT-INTENT-WRONG-MECHANISM** | The intent — a refusal must not destroy its own evidence — is right and now *more* important, since the evidence is in-box. But the mechanism is host-side: the in-box engine cannot leave itself alive, cannot print an operator-facing teardown command to a terminal nobody is attached to, and its non-zero exit is not observed by a parent process. Post-DF1.10 the host learns of an in-box refusal through the **terminal marker** (`/run/journal/final.json`) and `fleet status` settling on `engine-failed` (`df1-10…md:36`, `:560-562`). **Fix:** restate as *"the refusal writes the terminal marker with `{ok:false, code:"bound-config-invalid", message, remediation}`, which `fleet status` surfaces as `engine-failed` and `fleet harvest` carries out before teardown; the box is not torn down by the engine (it cannot tear itself down), and the host's existing teardown path (DF2.2 INV-5) is unchanged."* |
| `:74` | "The ceiling type is an **absolute integer µ$**; the schema has no ratio field to populate" | **CORRECT-NOW** | `PipelineManifestSchema` is `.strict()` (`manifest.ts:317`) — an unknown key is `unrecognized_keys`, a rejection. The claim is structurally enforced, not merely asserted. **Sacred (V2).** |
| `:75-77` | "this run's minted `limitMicroUsd` **as stamped into the frozen manifest by DF3.1's dispatch at fill time (DF3.1 AC9a)**" | **CORRECT-NOW** | `manifest.ts:314` declares the field; `manifest.ts:934-985` `stampManifestLimit` is the stamper, with `stripAuthoredLimit` (`:906-926`) closing the author-supplied path. Exactly as described. |
| `:77-79` | "DF2.8 mints `min(default, remaining)`, so a run near its issue cap legitimately carries a value below the configured default and even below the resident ceiling" | **CORRECT-NOW** | Corroborated by `df2-3…md:128` and `df2-4…md:143`. This is the story's best reasoning. **Sacred (V7).** |
| `:79-81` | "an effective ceiling is computed as `min(residentSpendCeilingMicros, limitMicroUsd)` and used for every AC1 projection" | **CORRECT-NOW** | No shipped code contradicts it; the clamp is the right shape. |
| `:81-84` | "a journal row `{ bound:"spend", action:"clamped", … }` is written and the run **proceeds**" | **CORRECT-INTENT-WRONG-MECHANISM** | Proceeding is right. The *row's destination* is wrong: the journal's `resident` block is a closed key set (`steering.ts:204-219`; `df1-10…md:571`) and has no slot for it. See **DF3.6-M4** for the replacement text (route to the trace/log stream). |
| `:84-86` | "The value is read **only** from the frozen manifest: the engine runs inside the box, where the host-side `.sandbox/runs/<id>.json` record does not exist" | **CORRECT-NOW — and this is the single clause the ADR's Consequence 5 most directly vindicates.** | `df1-10…md:189` states it as a *design* property post-relocation, and the DoD grep at `df3-6:279` fences it. Written 2026-08-20 for a world that did not yet exist; true today. |
| `:86-87` | "a manifest **missing** `limitMicroUsd` **refuses the run** (fail-closed, INV-BND-2) rather than defaulting to the configured ceiling" | **CORRECT-INTENT-WRONG-MECHANISM** | The intent is right and fail-closed. The mechanism duplicates a refusal that already exists one layer up: `limitMicroUsd` is `.optional()` in the schema (`manifest.ts:314`) precisely because the *reconciliation*, not the loader, is the gate — `runContextFrom` in `scripts/pipeline-run.ts` "reconciles it against the `effectiveCeilingMicros` dispatch wrote to `run-context.json` beside the manifest, **refusing on absence or disagreement**" (`manifest.ts:303-313`). A second independent refusal in `loadResidentBounds` is either dead code or a second source of truth. **Fix:** restate as *"a manifest missing `limitMicroUsd` never reaches `loadResidentBounds` — `runContextFrom` already refuses on absence or disagreement against `run-context.json`'s `effectiveCeilingMicros` (`src/phase-engine/manifest.ts:303-313`). INV-BND-2's fail-closed requirement is **satisfied by that gate, not duplicated here**; `loadResidentBounds` asserts the value is present and treats absence as an engine invariant violation (throw), not as a policy decision it re-makes."* |
| `:87-90` | Negative control 1: "an implementation that applies check (a) to the minted `limitMicroUsd` refuses every run near its issue cap after DF2.8 already admitted it" | **CORRECT-NOW** | Genuinely falsifying, non-obvious, and grounded in DF2.8's real `min()` semantics. Keep verbatim. |
| `:88-90` | Negative control 2: "so MUST an implementation that reads `.sandbox/runs/<id>.json` from inside the box, which finds nothing on every real run" | **STALE (as a control; the fence it names is live)** | Now guaranteed by construction post-DF1.10 (`df1-10…md:189`) and mechanically enforced by the DoD grep (`df3-6:279`). It is no longer a control that could fail; it is a restatement of a fence. See **DF3.6-L4**. |

**Aggregate verdict on the ADR-cited passage.** Of thirteen clauses: **eight CORRECT-NOW**, **four
CORRECT-INTENT-WRONG-MECHANISM**, **one STALE**. The ADR's Consequence 5 — "its in-box clauses become
correct again" — is **substantially vindicated for this passage**: the *placement* reasoning
(`:68-71`, `:84-86`) is the strongest and most prescient text in the story, written eleven days
before the ADR ratified it. What is wrong is not placement but **mechanism**: three of the four
CORRECT-INTENT clauses fail because the story describes a *host-side* way of doing an *in-box*
thing (exit codes and printed teardown commands instead of terminal markers; a journal block that is
closed; a refusal that already exists a layer up).

**The reconciliation's important negative result:** the ADR-cited passage is the *healthy* part of
the story. The BLOCKERs (B1, B3, B4, B5) live **outside** `:69-90` — in AC4/AC5's RSS mechanism, in
the invented `runBudgetCapMicros`, in the unreachable iteration bound, and in the mandatory demo's
arithmetic. Reading only the passage the ADR names would have surfaced one of six BLOCKERs. The
things that were *never* checked against shipped code are worse than the things the ADR flagged.

---

## 4. Candidate PROPOSED ADR amendment (operator decision — not resolved here)

**One.** `docs/superpowers/specs/2026-08-31-tier2-placement-adr.md:57-59`, load-bearing mechanism
(2): *"F12 engine-enforced resident bounds (**shared process tree**)"*.

The parenthetical is the ADR's stated reason in-box placement makes F12 enforceable. Post-DF1.10 the
engine and the resident *do* share a process tree — and so do the engine and every tier-3
`dispatch_task` worker (`QDS_TEAM_RUNNER=local`, `src/phase-engine/phases/dispatch-task.ts:290-298`;
`df1-10…md:34`). "Shared process tree" as written is satisfied by an implementation that charges the
whole engine subtree to the resident's 512 MiB bound, which trips on the first dispatch phase of
every real run — the F064 defect already found and fixed once in `src/reverify/worktree.ts:293-299`.

**This is not a code-contradicts-ADR BLOCKER** — no shipped code violates the ADR; the ADR's phrasing
is under-specified in a way that admits a wrong implementation. Proposed amendment text:

> (2) F12 engine-enforced resident bounds — the engine can **enumerate the resident's own subtree**
> by parent-pid links, because pi is a local child of the engine process rather than a remote
> server. Note the scoping obligation this creates: the engine also parents tier-3 `dispatch_task`
> workers, so a bound on the resident must be rooted at the resident's pid and never at the engine's
> (cf. F064, `src/reverify/worktree.ts:293-299`).

Operator call. The scan proceeds on the assumption the amendment is accepted; DF3.6-H3's fix recipe
is written to satisfy the amended wording and is a no-op against the current wording plus common
sense.

---

## 5. Recommendations asked for by the brief

**Spend-ceiling authority — the recommendation.** Three mechanisms, three *different* denominators,
and the story treats them as one number. State the precedence explicitly in Technical Notes:

1. **DF2.3's provider-side key cap** (`limitMicroUsd`, minted `min(defaultKeyCapMicroUsd,
   remaining)`) is the **outermost and authoritative** ceiling. It is enforced by OpenRouter, covers
   the resident *and* every tier-3 worker on the same key (§6.2 one-secret-per-box), and cannot be
   bypassed by an engine bug. It is the only one of the three an adversary inside the box cannot
   reach.
2. **DF3.6's engine-enforced ceiling** is **authoritative for the resident, and only for the
   resident**. It is an inner control whose job is to stop *one component* before the run key
   notices, so the run still finishes deterministically instead of dying provider-side mid-phase.
3. **DF2.8's `defaultCapMicroUsd`** is **per-issue and host-side** — it governs *admission* (the
   pre-spawn dispatch refusal), not in-run enforcement, and it is **not** a per-run budget. It must
   be removed from the in-run reasoning entirely and appear only in the config-time sanity chain
   (DF3.6-B3).

**On disagreement: `min()` wins and the clamp is recorded.** AC2b already gets this exactly right
and needs no change — that is the story's best clause. The addition needed is one sentence saying
the three are *not* redundant copies of one number and which one is authoritative for what.

**RSS mechanism — the recommendation.** **Reuse `ps`-sampling; do not build a `/proc` dispatcher; name
the cgroup upgrade.** Concretely: extract `parsePsTable` / `descendants` / the sample-and-sum loop
from `src/reverify/worktree.ts:224-283` into a shared helper, parameterise root pid and bound, root
it at `deps.residentPid()`, run it at 500 ms **only while a call is in flight**, and carry the
`ponytail:` ceiling comment across unchanged. Reasons: the ADR's own argument is that the *existing*
watchdog becomes correct in-box ("re-aimed, not deleted") and building a second mechanism discards
that; `ps -Ao pid=,ppid=,rss=` demonstrably works on both platforms (`worktree.ts:231`), so the
two-probe dispatch solves a problem that does not exist; and the shipped code already carries three
review-scarred fixes (F064 baseline, sync-baseline race, sweep-cancel-on-dispose) that a fresh
implementation would rediscover one incident at a time.

DF5.1's standing ceiling — "RSS is `ps`-sampled rather than cgroup-enforced" — is **inherited, not
fixed**, and the story should say so plainly rather than imply a new sampler resolves it. The real
fix is now *available* for the first time (systemd is PID 1 in-box, measured by the ADR probe): a
`systemd-run --scope --property=MemoryMax=…` per solicitation makes the bound kernel-enforced with
no poll interval and no pid race. That is the right eventual answer and the wrong thing to fold into
this story — it changes how pi is spawned (`src/fleet/resident.ts`) and the box image (DF2.10). File
it against DF5.1's existing ceiling so there is one ticket for one exposure.

**Structural proposal.** Re-size to **5 points**, or split into **DF3.6a (spend + iteration, 3 pts,
engine-only, host-testable)** and **DF3.6b (RSS watchdog, 2 pts, crosses the fleet boundary, needs a
live in-box round)** — see DF3.6-M6. Re-point the dependency edges to include DF1.10 and DF1.11
(DF3.6-M7). Sequencing after the engine story, per ADR Consequence 5, is already satisfied by the
campaign's ordering; only the edge list is stale.
