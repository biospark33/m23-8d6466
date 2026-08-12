# R5 — Dependency Analysis, Sizing & Wave Strategy (Dark Factory v5 derivation)

**Date:** 2026-08-11
**Agent:** Research Agent 5
**Inputs:** `docs/superpowers/specs/2026-08-11-dark-factory-v5-architecture-design.md` (r2) §5/§8/D1–D10 ·
`docs/superpowers/specs/2026-08-11-story-disposition-audit.md` (F14) §2/§3/§4/§6 ·
`docs/superpowers/specs/2026-08-11-pre-derivation-gates-report.md` (F6/F8/F13) §1–§4 ·
`_bmad-output/sprint-artifacts/sprint-status.yaml` (v4 calibration baseline)
**Code facts verified live:** `cli-anything/scripts/team-lead-driver.ts:124` (`runWorkerPi`),
`cli-anything/src/runner.ts:554` (`QDS_TEAM_RUNNER` ternary), `cli-anything/src/team-events.ts:32`,
`scripts/phase0-exit-gate.ts` + `src/gate/{gate-runner.ts,verifier-child.ts,assertions}` (P1.17 chassis exists).

---

## 0. Headline (read this if you read nothing else)

**The slate is 31 stories / 111 points. That is three sprints, not two.**

At the enterprise-rigor throughput baseline the design itself names (~45–50 pts / 4 weeks, 2 devs),
111 points is **~9–10 weeks**. Any plan that promises the lights-on PR inside two sprints is
promising a number the evidence does not support.

The strawman's *aggregate* sizing was sound — my refined slate lands at the same 111 points. What
changed is shape, not size: one merge (−3), one re-point (−1), three splits (+4). That coincidence
is itself a signal: the orchestrator's per-story instincts were well calibrated; the problem is
that the F14 audit's "another 30–45 points of net-new" was a **floor, not a range** (§1.4).

---

## 1. Final slate

Target 3–5 pts/story. **BLOCK at ≥6 → split.** Points calibrated against the v4 sprint-status
baseline (30 stories / 105 pts; phase-1 = 19 stories / 68 pts; cap was "3–4 pts, e2e slices" with
P1.6 the single 5-pt exception).

### 1.1 DF1 — TS phase engine (§8 step 1) — 8 stories, 29 pts

| ID | Title | Pts | Ancestry |
|---|---|---|---|
| DF1.1 | Phase abstraction + lifecycle + **versioned pipeline manifest** (status defaults to `fail` and must be earned; phase descriptions validated at construction; per-phase timeout ≤ upstream budget with routing margin) | 4 | net-new core + **P1.4 surviving AC3/AC5 (MERGED IN)** |
| DF1.2 | Gates-with-evidence + envelope adapter (every check records pass *and* fail; deterministic subprocess results wrapped as envelopes indistinguishable from agent reports → one repair-loop path) | 4 | net-new (SSSF's sharpest idea) |
| DF1.3 | Dual retry discipline (JSON-parse retries and gate-violation retries separately bounded, both re-entering the same agent session; usage accumulated across retries, context occupancy from last send only) | 3 | net-new; **boundary contract with P1.9 (KEEP)** |
| DF1.4 | SQLite trace store (7-table SSSF schema, WAL, additive migrations, rowid-cursor polling; every row carries `requestId`) | 4 | net-new |
| DF1.5 | Roster config + **dual slug validation** (against pi's bundled catalog AND the provider API) + `~/.pi/agent/models.json` custom-entry mechanism | 3 | net-new; **boundary contract with P1.5 (KEEP)** |
| DF1.6 | **FLAGSHIP** — `dispatch_task` phase → `team-lead-driver.ts`; NDJSON→envelope adaptation; merged-JSON schema validation; PR #97 invariants re-asserted in-sandbox (INV-3 RSS watchdog **re-aimed** at the genuine local subprocess tree) | 5 | **P1.6 RE-DERIVE** |
| DF1.8 | Run capture correlated to the GitHub issue (trace-store-backed; **no second capture layer**) | 3 | **P1.8 RE-DERIVE** |
| DF1.9 | Lean worker profile — tier-3 workers run without extensions/skills; benchmark AC proves or refutes the 5–6× payoff hypothesis | 3 | net-new (gates-report finding 1) |

### 1.2 DF2 — Provider seam, credentials, cost (§8 step 2) — 9 stories, 31 pts

| ID | Title | Pts | Ancestry |
|---|---|---|---|
| DF2.1 | Provider-driver interface (create/fill/setup/execute/observe/teardown/reap) + run records (O_EXCL create, atomic replace, closed schema, unreadable-record-is-a-hard-error) | 3 | net-new |
| DF2.2 | exe.dev driver + five-assertion setup gate (git integrity by content, live model ping, cost table loaded, credit remaining) | 5 | net-new |
| DF2.3 | Credential lifecycle: mint → cap → use → **revoke → verify revocation against the authoritative key list**; secrets via stdin, never argv | 4 | net-new |
| DF2.4 | **LIVE cap-hit kill demo** — a real run hits its spend cap and dies, evidenced | 3 | net-new; discharges **P0.4's never-run AC3** (audit hole #6) |
| DF2.5 | Bundle harvest (`refs/sandbox/<run-id>`, ranged bundle, verified host-side) + **tested** teardown | 4 | net-new |
| DF2.6 | Quota accounting + reaper (50-VM / 100GB-pooled-disk ceiling tracked host-side; failed teardowns queue; dispatch refuses when headroom < N) | 3 | net-new (F9) |
| DF2.7 | **Session-cumulative cost instrumentation** in `team-lead-driver.ts` — accumulate usage across turns, emit `cacheRead`/`cacheWrite`/turn-count | 2 | net-new (**F8 condition 1**) |
| DF2.8 | Cost ledger + budget cap + dispatch refusal (`qds cost <issue>`, micro-dollars, per-role split, append-only, `unpriced` flag) | 4 | **P1.13 RE-DERIVE** |
| DF2.9 | OCI image contract + license compliance build (F13 conditions) | 3 | net-new |

### 1.3 DF3 — Fleet dispatcher + tier-1/tier-2 control (§8 step 3) — 6 stories, 22 pts

| ID | Title | Pts | Ancestry |
|---|---|---|---|
| DF3.1 | Dispatcher core verbs: dispatch / status / harvest / teardown (+ runId ack semantics, requestId propagation, malformed dispatch → 4xx and **no spawn**) | 5 | **P1.1 RE-DERIVE** |
| DF3.2 | Fan-out N + best-of-N + race **as code** (disler's is a 214-line cookbook + an 18-line bash loop) | 4 | net-new |
| DF3.3 | Resident orchestrator agent (receives dispatch brief, steers the phase engine, reports; cheap-model default) | 4 | net-new (D4) |
| DF3.6 | **Resident-agent bounds** — max steering iterations per phase, RSS cap, **absolute per-run spend ceiling below the run key's cap**, enforced by the phase engine not the agent | 3 | net-new (F12 + gates-report finding 4) |
| DF3.4 | Tier-1 approval gate pre-PR + `attach` steering | 4 | **P1.10 RE-DERIVE** |
| DF3.5 | Tier-1 Claude Code factory skills (thin, tested-CLI-backed; never prompt-improvised commands) | 2 | net-new (D3) |

### 1.4 DF4 — Visualizer (§8 step 4) — 2 stories, 8 pts

| ID | Title | Pts | Ancestry |
|---|---|---|---|
| DF4.1 | Visualizer port + auth (F11: tier-1-tunneled, **never** the box's one shared public port) | 4 | net-new — zero ancestry |
| DF4.2 | Visualizer tests from zero + Bun-API audit (~4,656 lines TS/Vue) + per-box deploy | 4 | net-new — zero ancestry |

### 1.5 DF5 — Lights-on PR (§8 step 5) — 5 stories, 17 pts

| ID | Title | Pts | Ancestry |
|---|---|---|---|
| DF5.1 | Host-side out-of-box re-verify — tests + gates re-run in a context that never trusted the box, **before** any PR | 4 | net-new (F10/R9) |
| DF5.2 | Host-side PR creation (push credential never enters a box; PR body carries runId + issue refs + cost summary; red gates → no PR) | 4 | **P1.15 RE-DERIVE** |
| DF5.3 | Audit chain extended (key mint/cap/revoke/verify events, bundle verification, re-verify evidence, box lifecycle) | 4 | **P1.16 RE-DERIVE** |
| DF5.4 | Lights-on gate on the P0.11 chassis (per-clause evidence, VOID recording, versioned report, exit 0/1/2) | 3 | **P1.17 RE-DERIVE** |
| DF5.5 | KEEP-repoint chore (dep edges + 2 enum citation fixes + 3 boundary amendments) | 2 | chore |

### 1.6 DF6 — PR-feedback fix loop (§8 "5+", unslotted) — 1 story, 4 pts

| ID | Title | Pts | Ancestry |
|---|---|---|---|
| DF6.1 | PR-feedback → bounded fix run → CI green (≤2 attempts then human escalation; no force-push, append-only commits). **MUST carry the F6 scope caveat: multi-worker concurrent editing is UNPROVEN — single-fixer proven only.** | 4 | **P1.19 RE-DERIVE** |

### 1.7 Totals and deltas from the strawman

| Epic | Stories | Points |
|---|---|---|
| DF1 | 8 | 29 |
| DF2 | 9 | 31 |
| DF3 | 6 | 22 |
| DF4 | 2 | 8 |
| DF5 | 5 | 17 |
| DF6 | 1 | 4 |
| **Total** | **31** | **111** |

**Changes I made to the strawman, and why:**

| Change | Delta | Reasoning |
|---|---|---|
| **MERGE** DF1.7 (step-graph/template schema, 3) into DF1.1 | −3, −1 story | D6 adopts SSSF's **code-defined** phases; there is no declarative step-graph engine in §5.1. P1.4's surviving clauses (AC3 versioned+validated schema, AC5 per-step timeout ≤ upstream budget with margin) survive intact as a *versioned pipeline manifest* inside the phase lifecycle — which is where phase ordering and per-phase budget already live. A separate story would have invented a template registry the architecture deleted. **Surviving clauses are named verbatim in DF1.1 — F14's requirement is satisfied.** |
| **RE-POINT** DF2.1 provider interface 4 → 3 | −1 | Both §3.4 and D7 measure the provider surface at **~30 lines / ~6 command shapes across 5 just files**. The meat of this story is the run-record discipline, not the interface. |
| **SPLIT** DF2.7 (5) → DF2.7 instrumentation (2) + DF2.8 ledger (4) | +1, +1 story | F8 condition 1 is a sharply-bounded change to `runWorkerPi` (`team-lead-driver.ts:124`) — stop overwriting usage per message event. It is a **prerequisite for every cost claim in the system** and is early-safe with near-zero dependencies. Fusing it into the ledger story buries the one thing that unblocks the hosted-tier price sheet behind a 5-pt story that needs the credential lifecycle first. |
| **SPLIT** DF3.3 (5) → DF3.3 resident agent (4) + DF3.6 bounds (3) | +2, +1 story | D4 is the **only decision in the register carrying live demotion tripwires**. The bounds are enforced by the phase engine, not the agent — a different component, a different test surface, and separately verifiable. Bundling them means the tripwire re-spec (the gates report's finding 4) ships as a sub-clause of a story about something else. |
| **RE-POINT** DF4.2 3 → 4 | +1 | Writing a test suite from zero plus a Bun-API audit across ~4,656 lines of vendored TS/Vue is not a 3. Disler shipped it with **zero tests**. |
| **NET** | **0 pts, +2 stories** | |

### 1.8 Sanity-check against the F14 estimate — the audit's number was a floor

The audit projected: old 68 phase-1 points' *contracts* survive, plus "**another 30–45 points**"
of net-new for steps 1–4.

| Band | This slate | F14 expectation |
|---|---|---|
| RE-DERIVE content (DF1.6, DF1.8, DF2.8, DF3.1, DF3.4, DF5.2, DF5.3, DF5.4, DF6.1 + P1.4 clauses in DF1.1) | **~39 pts** | 10 RE-DERIVE stories were worth **38 pts** at v4 sizing — **matches to within one point** |
| Net-new | **~70 pts** | 30–45 |
| Chore | 2 | — |

**The re-derivation band validates cleanly. The net-new band is 1.6–2.3× the audit's estimate.**
Four reasons, all defensible:

1. **The audit predates the gates report** and could not count five obligations it created:
   DF1.9 lean worker (3), DF2.4 live cap kill (3), DF2.7 cost instrumentation (2), DF2.9 OCI
   contract (3), DF3.6 tripwire re-spec (3) = **14 pts**.
2. **The audit collapsed step 2 into one table cell** — "credential lifecycle, provider-driver
   interface, run records, bundle harvest, quota/reaper" is five subsystems (17 pts before the
   cost layer and OCI are added).
3. **Same for step 1** — "the engine port itself" is phases + gates + envelopes + retries + trace
   store + roster = 21 pts.
4. **F10's host-side re-verify** was counted by the audit as a requirement *inside* P1.15's
   re-derivation; it is a 4-pt story in its own right (DF5.1), because "re-run the suite in a
   context that never trusted the box" is a separate execution environment, not a clause.

**Recommendation to the orchestrator:** state 111/31 as the slate and **three sprints** as the
horizon. Do not compress the estimate to defend the audit's 30–45; the audit said "eyeballed" and
it was right to hedge.

---

## 2. Dependency graph

Old story IDs appear where the dependency is real (not ceremonial). `DONE-KEEP` deps are satisfied
today; `KEEP` deps are draft stories that must be repointed by DF5.5.

```text
                    ┌─ P0.2 (DONE-KEEP: vendored coms) ─┐
                    └─ P0.3 (DONE-KEEP: mixed-model)  ──┴─┬─► DF1.6, DF1.9, DF2.7
                                                          │
DF1.1 ──┬─► DF1.2 ──► DF1.3                               │
        ├─► DF1.4 ──────────────────────────► DF4.1 ──► DF4.2
        └─► DF1.6 ◄── DF1.5, DF2.2 (QDS_TEAM_RUNNER handoff — 2026-08-12 addendum) │
              │                                           │
              ├─► DF1.8 ◄── DF1.4, P1.2 (KEEP)            │
              ├─► DF3.3 ──► DF3.6 ◄── DF2.3               │
              └─► DF5.1 ◄── DF2.5, DF1.2, DF1.6           │
                                                          │
DF2.1 ──┬─► DF2.3 ──┬─► DF2.2 ──┬─► DF2.4                 │
        │           │           ├─► DF2.5 ──► DF2.6       │
        │           │           └─► DF4.2 ◄───────────────┘
        └─► DF3.1 ◄─┴───────────┘
              │
              ├─► DF3.2 ◄── DF2.6
              ├─► DF3.4 ◄── DF3.3 ──► DF5.2
              └─► DF3.5 ◄── DF3.2, DF3.4

DF2.7 ──► DF2.8 ◄── DF2.3, ~~P1.2 (KEEP)~~ [ADDENDUM: P1.2 dependency removed — unscheduled, see below]

DF5.1 ──► DF5.2 ◄── DF3.4, P1.3 (KEEP), P1.7 (KEEP)
            │
            ├─► DF5.3 ◄── DF2.8, DF2.3, DF1.4   [+ P1.11/P1.12 retain-receipt link — see §5.3]
            │     └─► DF5.4 ◄── DF5.1, DF3.*, P0.11 (DONE-KEEP: gate chassis)
            └─► DF6.1 ◄── P1.18 (KEEP), DF1.6, DF3.1

DF2.9 — no deps (F13 research complete; doc + build script + license-sweep test)
DF5.5 — deps on the final slate's IDs (write last)
```

**Per-story dependency table** *(HISTORICAL as of 2026-08-12 — this table records the graph as
derived; the fix-wave campaign later added/removed edges (e.g. DF2.2 → DF1.6 added; DF1.8 → P1.2,
DF5.2 → P1.3/P1.7, DF6.1 → P1.18 removed). The authoritative dependency source is now
`_bmad-output/sprint-artifacts/sprint-status.yaml` and each story file's "Dependency edges" line —
use those, not this table or the ASCII art)*:

| Story | Depends on |
|---|---|
| DF1.1 | — |
| DF1.2 | DF1.1; gate *sources*: P0.5 (KEEP, in-review), P0.6 (DONE-KEEP), P1.7 (KEEP) plug in here |
| DF1.3 | DF1.2 |
| DF1.4 | DF1.1 |
| DF1.5 | — |
| DF1.6 | DF1.1, DF1.2, DF1.5, P0.2, P0.3 |
| DF1.8 | DF1.4, DF1.6, P1.2 |
| DF1.9 | P0.2, P0.3 (measures against `team-lead-driver.ts` directly — **does not** need DF1.6) |
| DF2.1 | — |
| DF2.2 | DF2.1, DF2.3 |
| DF2.3 | DF2.1 |
| DF2.4 | DF2.3, DF2.2 |
| DF2.5 | DF2.1, DF2.2 |
| DF2.6 | DF2.2, DF2.5 |
| DF2.7 | P0.3 |
| DF2.8 | DF2.7, DF2.3 (**ADDENDUM:** the P1.2 dependency recorded here was removed post-audit — P1.2 was never scheduled and cannot gate DF2.8) |
| DF2.9 | — |
| DF3.1 | DF2.1, DF2.2, DF2.5 |
| DF3.2 | DF3.1, DF2.6 |
| DF3.3 | DF1.1, DF1.6, DF2.2, DF3.1 |
| DF3.6 | DF3.3, DF1.1, DF2.3 |
| DF3.4 | DF3.1, DF3.3 |
| DF3.5 | DF3.1, DF3.2, DF3.4 |
| DF4.1 | DF1.4 |
| DF4.2 | DF4.1, DF2.2 |
| DF5.1 | DF2.5, DF1.2, DF1.6 |
| DF5.2 | DF5.1, DF3.4, P1.3, P1.7 |
| DF5.3 | DF5.2, DF2.8, DF2.3, DF1.4 (+ P1.11/P1.12 — **degraded, §5.3**) |
| DF5.4 | DF5.1, DF5.2, DF5.3, DF3.1, DF3.4, P0.11 |
| DF5.5 | final slate IDs |
| DF6.1 | DF5.2, P1.18, DF1.6, DF3.1 |

**Critical path** (longest chain, corrected): `DF2.1 → DF2.3 → DF2.2 → DF2.5 → DF3.1 → DF3.3 → DF3.4 → DF5.2 → DF5.3 → DF5.4`
= 10 stories / 40 pts. (An earlier version routed DF2.5 → DF5.1 → DF5.2 for 8 stories / 30 pts, but
DF5.2's deepest predecessor is DF3.4 at 29 pts, not DF5.1 at 20 — DF5.1 is a sibling predecessor of
DF5.2, not the long leg. Cumulative chain: DF2.1 3 → DF2.3 7 → DF2.2 12 → DF2.5 16 → DF3.1 21 →
DF3.3 25 → DF3.4 29 → DF5.2 33 → DF5.3 37 → DF5.4 40.) The path starts on the **provider track**
(DF2.x) and continues through fleet integration (DF3.1/3.3/3.4) before the lights-on chain, so it
spans all three sprints — which reinforces the "three sprints, not two" headline and makes S2 (where
DF3.1/3.3/3.4/5.2 all land) the risk sprint. The engine track's longest chain is
`DF1.1 → DF1.2 → DF1.6 → DF1.8` = 16 pts — shorter than the provider→fleet long pole. **Staff the
provider track first if you staff unevenly**, and do not let DF3.1 slip in S2: it unblocks four
stories and sits on the critical path.

---

## 3. Sprint slicing (~45–50 pts / 4 weeks, 2 devs)

Track A = phase engine (Dev A). Track B = provider/credentials (Dev B). They are genuinely
parallel through S1 — zero cross-edges until DF3.

### v5-S1 — "engine and box exist independently" (13 stories, **47 pts**)

| Track | Stories | Pts |
|---|---|---|
| A (engine) | DF1.1(4) → DF1.2(4) → DF1.3(3); DF1.4(4); DF1.5(3); DF1.6(5) | 23 |
| B (provider) | DF2.1(3) → DF2.3(4) → DF2.2(5) → DF2.5(4) | 16 |
| Either (independent, early-safe) | DF1.9(3), DF2.7(2), DF2.9(3) | 8 |

**One cross-track dependency inside S1** *(2026-08-12 addendum — originally recorded as zero)*:
DF2.2 → DF1.6, the provider-to-engine handoff — DF2.2's setup gate writes `QDS_TEAM_RUNNER=local`
into the box run environment, which DF1.6's AC5 refuses without. Track B's DF2.2 must land before
track A's DF1.6 closes. DF1.9 + DF2.7 both touch `team-lead-driver.ts` and
should go to the same dev in the same week. DF2.9 was re-pointed to v5-S2 at re-baseline.

**S1 exit condition:** the phase engine walks a pipeline with gates and a trace DB; a box can be
created, credentialed, filled, harvested and torn down. Nothing is wired together yet — that is
correct and intentional.

### v5-S2 — "the wire-up sprint" (13 stories, **45 pts**)

| Band | Stories | Pts |
|---|---|---|
| Provider closure | DF2.4(3), DF2.6(3), DF2.8(4) | 10 |
| Engine closure | DF1.8(3) | 3 |
| Fleet | DF3.1(5), DF3.2(4), DF3.3(4), DF3.6(3), DF3.4(4), DF3.5(2) | 22 |
| Lights-on head | DF5.1(4), DF5.2(4) | 8 |
| Chore | DF5.5(2) | 2 |

**ADDENDUM:** DF5.5 was subsequently moved to v5-S3 and the sprint point totals were
re-baselined; `atomicity-audit-2026-08-11.md` and `sprint-status.yaml` are authoritative for the
current allocation (123 pts total, 48/50/25 across v5-S1/S2/S3) — do not treat this section's
13-story/45-pt S2 figure as current.

**This is the risk sprint.** Every cross-track edge in the graph lands here, DF3.1 and DF3.3 are
the two 4–5 pt integration stories, and DF5.2 (the first real PR) sits at the end of a 4-story
chain. Sequence within the sprint: DF3.1 first (it unblocks four stories), DF5.2 last.

### v5-S3 — "observability, audit, and the loop" (5 stories, **19 pts**)

DF4.1(4), DF4.2(4), DF5.3(4), DF5.4(3), DF6.1(4). **ADDENDUM:** DF5.5 moved here from v5-S2 —
see the S2 addendum above; current authoritative totals live in `atomicity-audit-2026-08-11.md`
and `sprint-status.yaml`.

S3 is deliberately light. It is the **schedule slack for S1/S2 overrun** and the natural window to
start §8 step-6 (memory) derivation. If S2 slips — and the dependency density says it will —
DF4.1/DF4.2 are the first things to push, because **nothing in step 5 depends on the visualizer**
(only DF1.4's trace store, which is S1). The design orders step 4 before step 5; the dependency
graph does not require it.

**If you must ship in two sprints:** cut DF4 entirely (−8) and DF3.2 fan-out/best-of-N (−4) and
DF6.1 (−4) = 95 pts across S1+S2. That is still ~5 pts over two sprints' capacity, and you ship a
factory that runs one story at a time with no visualizer. State that trade explicitly rather than
absorbing it silently.

---

## 4. Writing-wave plan

**Hard rule SPL-001/SPL-013: max 2 stories per writing agent.** 31 stories → **ceil(31/2) = 16
agents**, in **3 waves**. Pairing is by shared research context so each agent loads one body of
evidence, not two.

Write **all 31 now**, not just S1+S2 — deferring S3's writing means re-loading the entire v5
evidence base in a later session for 5 stories.

### Wave 1 — foundations (12 stories, 6 agents)
Nothing in this wave needs to cite another DF story's contents.

| Agent | Stories | Shared research context |
|---|---|---|
| W1-A | DF1.1 + DF1.2 | SSSF phase/gate/envelope design (§3.3 adopt list) + P1.4's surviving AC3/AC5 |
| W1-B | DF1.3 + DF1.4 | SSSF trace schema + usage/retry accumulation semantics (they are the same data model) |
| W1-C | DF1.5 + DF1.9 | pi model surface: bundled catalog staleness, `~/.pi/agent/models.json`, 37K extension/skill overhead |
| W1-D | DF2.1 + DF2.5 | inkwell run-record discipline + bundle harvest + the unrun-teardown finding |
| W1-E | DF2.2 + DF2.3 | inkwell credential recipes + exe.dev primary docs + five-assertion setup gate |
| W1-F | DF2.7 + DF2.9 | F-gate condition discharge: F8 condition 1 (cost instrumentation) + F13's three binding conditions |

### Wave 2 — spine (11 stories, 6 agents)
May cite wave-1 story IDs as dependencies.

| Agent | Stories | Shared research context |
|---|---|---|
| W2-A | DF1.6 **(alone)** | Flagship. Carries P1.6's entire surviving clause set + F6 evidence + the INV-3 re-aim. Do not pair. |
| W2-B | DF1.8 + DF2.8 | "record keyed to runId, linked to the issue" — P1.8 and P1.13 surviving clauses are the same shape |
| W2-C | DF2.4 + DF2.6 | Containment fires for real: P0.4's never-run AC3 + F9 quota/reaper |
| W2-D | DF3.1 + DF3.2 | Dispatcher CLI surface + P1.1 surviving clauses + disler's fleet cookbook |
| W2-E | DF3.3 + DF3.6 | D4 + F12 + the gates-report tripwire re-spec — one indivisible research body |
| W2-F | DF3.4 + DF3.5 | Tier-1 operator surface: P1.10 surviving clauses + D3's "never prompt-improvise commands" |

### Wave 3 — closure (8 stories, 4 agents)
May cite waves 1–2.

| Agent | Stories | Shared research context |
|---|---|---|
| W3-A | DF4.1 + DF4.2 | SSSF visualizer + F11/R10 confidentiality — the only pair with *zero* story ancestry |
| W3-B | DF5.1 + DF5.2 | F10 ordering (re-verify strictly before PR) + P1.15 surviving clauses |
| W3-C | DF5.3 + DF5.4 | P1.16 chain extension + P1.17 on the P0.11 chassis (`src/gate/*`, 45 tests) |
| W3-D | DF5.5 + DF6.1 | Both need the final slate's IDs: the repoint chore and P1.19's re-derivation |

**Pre-flight check (SPL-013):** 31 stories ÷ max 2 = 16 agents minimum. Allocated: 6 + 6 + 4 = 16.
Maximum per agent = 2 (W2-A carries 1). ✅

---

## 5. Open decisions the orchestrator must make (not stories)

These are the F14 coverage holes that the strawman leaves unaddressed. Each needs a decision
recorded before writing starts, or writers will invent an answer.

### 5.1 Hole #1 — the channel layer has no build-order step
§5.3's data flow opens with "channel/operator →" but no §8 step builds the channel↔factory bridge.
P0.8 is RETIRED, OQ-3 is BLOCKED-on-creds with the Hermes fallback only *recorded, never
exercised*, and P1.10's Telegram half re-derives into tier-1 steering.

**Recommendation: decide "operator-CLI-only for v5.0" and write no story.** Tier 1 *is* Claude Code
plus a tested CLI; the operator is the channel. This closes the hole at zero cost and stops writers
from assuming a Telegram intake that has never had working credentials. Record it as a decision
(D11 candidate), not a deferral note.

### 5.2 Hole #7 — SwarmClaw's residual role is undefined
§7 keeps SwarmClaw as "host-side service chassis" but no surviving or re-derived story says what it
*does*. P0.7's DONE-KEEP assets (registry, 4 routes, 175 tests) will drift.

**Recommendation:** one line in DF5.5 stating SwarmClaw's v5 role. My read of the graph: it is the
natural host-side HTTP surface for the audit log and cost ledger (DF5.3 / DF2.8). If that is not
wanted, say "dormant, retained for step 6" — but say something.

### 5.3 DF5.3's retain-receipt link is blocked by OQ-4
P1.16's AC2 requires the chain to include a **retain receipt** — which means Hindsight — and
Hindsight **has never booted** (arm64 libpq/openssl@3; port 8888 collides with a local Jupyter).
OQ-4 has no owner and survives the redesign untouched (audit hole #4).

**Recommendation:** DF5.3 ships with the retain link recorded **VOID** using P0.11's existing VOID
convention, pending step 6. Write that into the AC explicitly so it is not discovered at
implementation time. Separately: OQ-4 needs an owner before step-6 derivation begins.

### 5.4 Two boundary contracts that will be double-implemented if unstated

| Pair | Boundary |
|---|---|
| **DF1.3 vs P1.9** (KEEP) | DF1.3 owns *in-phase* retry (JSON-parse + gate-violation, re-entering the same agent session). P1.9 owns *cross-run* restart classification keyed on the exitStatus enum. Different layers. Both stories must name the boundary or two retry policies ship. |
| **DF1.5 vs P1.5** (KEEP) | DF1.5 owns the roster **config schema + slug validation**. P1.5 keeps the **router scoring against outcome records** (step 6). The audit slots P1.5 at "1 + 6" — this is where the split falls. |

Both amendments belong in DF5.5's scope alongside the enum citation fixes.

---

## 6. Known facts writers must NOT contradict

Every item below is evidenced in the three input documents or verified live in this repo. A story
AC that contradicts one of these is a defect.

**Runtime and proof**

1. **`QDS_TEAM_RUNNER=local` → `team-lead-driver.ts` subprocess teams is the ONLY proven execution
   path.** Verified live at `cli-anything/src/runner.ts:554`. Versions of record: **pi 0.55.0**
   (`@mariozechner/pi-coding-agent`), bun 1.2.22, vendored coms pinned to disler `0ed11f44`. The F6
   DoD run executed 2026-08-12T00:51:09Z, **N=1 clean**, 4/4 clauses verifier-confirmed.
2. **F6 scope honesty.** Proven = **one** fixer worker editing code and running tests, with a
   read-only analyst and a verifying lead, through the full NDJSON/merge/schema pipeline.
   **Multi-worker concurrent editing is UNPROVEN.** Worker-b partly read the answer key from git
   history — F6 is **not** proof of blind diagnostic capability. DF6.1 must carry this caveat.
3. **Warren is demoted-optional (D9).** Never write `warren run --team` — the flag exists in no
   version examined. `CreateRunInput` has **no env field**, so `QDS_AGENT_TEAM_CONFIG_JSON` never
   crosses the CLI→server wire. The published v0.14.1 exit table is
   `0/1/2/3/4/130 = success/run-failed/usage-error/server-unreachable/auth-rejected/sigint-detach` —
   **not** the assumed success/logic/transient/overflow. **Do not cite `SPEC.md:2729`** (deleted
   upstream, warren #741).
4. **Anthropic OAuth on this host is expired (~2026-02-25).** All-Anthropic-direct rosters are
   blocked until interactive `/login anthropic`. **OpenRouter is the working path today.** No AC may
   require direct-Anthropic routing without an explicit unblock step.

**Contracts that survive verbatim (cite, never re-derive or weaken)**

5. **PR #97 hardening is runtime-agnostic and survives verbatim:** the **5-value** exitStatus enum
   (`success | transient | overflow | logic | lead_failure`, CC-1); the step-output schema
   (`changedFiles`, `testResults`, `durationMs`, `mulchPrimed`/`mulchPrimeError`, `artifacts`);
   two-stage decode-then-check + `O_NOFOLLOW` path-traversal defense; the observability contract
   (requestId propagation, per-phase sub-timings, every prompt persisted **pre-execution**);
   `maxDurationMs` ≤ upstream timeout minus routing margin. INV-3's RSS watchdog is
   **re-aimed**, not deleted — it is correct now because the runtime is a genuine local subprocess
   tree inside the sandbox.
6. **`parseTeamEventLine` is the whole runtime interface.** Event kinds:
   `cost | coms | worker_output | merged | coms_init_error`.

**Cost, pricing, and terms**

7. **Cost events are final-turn-only today.** `runWorkerPi` (`team-lead-driver.ts:124`) overwrites
   usage per message event; emitted tokens are the last turn's and `costUsd` is the last turn's
   `cost.total`. The F6 event sum **$0.04912262** is therefore a last-turn sum — attempt 2's true
   cost is only **bracketed [$0.049, ~$0.91]**. Any story claiming session-cumulative cost depends
   on DF2.7. **ADDENDUM:** R3 notes `usage.cost.total`'s per-turn-vs-cumulative semantics require
   empirical verification via a captured `pi --mode json` stream — treat this bracket as
   unverified, not established, until that capture exists.
8. **pi fixed overhead ≈ 37,279 input tokens/turn (measured)** = **78–88% of every agent's bill**.
   The **5–6× lean-worker payoff is a HYPOTHESIS** — elimination via `--no-extensions`/`--no-skills`
   is **UNTESTED**. DF1.9's AC must measure, not assume.
9. **sonnet-5 = $2/$10 per MTok, standard and PERMANENT** — the scheduled $3/$15 increase "will not
   occur" (verbatim from the pricing page; a contrary cached 2026-06-24 reference was formally
   REFUTED). Cache write 1.25×/2× (5m/1h), read 0.1×, batch 50%. haiku-4.5 $1/$5; opus-5 $5/$25;
   fable-5 $10/$50; sonnet-4.6 $3/$15. OpenRouter deepseek-v4-flash-0731 $0.08/$0.18 with **cache
   read 0.2×, not Anthropic's 0.1×**.
10. **Commercial Terms §A.1 is the load-bearing pricing argument.** There is **no blanket "no
    commercial use" clause** in the Consumer Terms — the argument is the **absence of grant**: the
    permission to "power products and services Customer makes available to its own customers and end
    users" exists only in §A.1. §13 stipulates injunctive relief, making it commercially forced.
    Client-deployed tier-1 = **org-owned API key under Commercial Terms**, always. **No Max-derived
    rate may appear in any commercial floor.**
11. **exe.dev figures are vendor-single-origin [VERIFY].** Personal $20/mo (50 VMs, 100GB pooled
    disk, 200GB transfer, 2vCPU/8GB); Team $25/user/mo; Reserved Cloud Pool $35.84/hr; disk overage
    $0.08/GB/mo; transfer $0.05/GB. **No SOC 2, no customer-facing DPA, no SLA**, liability cap
    max(paid, $100), US-only control plane, no audit logs/SAML/SCIM. Never write an AC that assumes
    a compliance artifact exists.
12. **D4's 15%-of-run-total tripwire is a RATIO TRAP** and is **re-specced as an absolute per-run
    spend ceiling** (per F12). On an all-cheap roster even a v4-flash resident trips at N=2 steering
    turns while a frontier roster tolerates 65. **Never write the 15% ratio into an AC.**

**Configuration and licensing**

13. **pi's bundled model catalog is stale in both directions** (rejects live slugs, lists delisted
    ones). Roster slugs must validate against **BOTH** pi's catalog **AND** the provider API; custom
    models require `~/.pi/agent/models.json`.
14. **F13 conditions bind the OCI image contract only** (they do not block derivation): NOTICE
    re-swept **post-build** covering **fifteen** license-text-less packages *plus the full Apache-2.0
    text* for `@aws-sdk/credential-provider-http`, `@aws-sdk/credential-provider-login`,
    `@aws-sdk/nested-clients`; build with **`--omit=optional`** (drops `@mariozechner/clipboard`,
    which has no license text anywhere in its chain); fix the false pi-mono-origin header at
    **`pi-vs-claude-code-vendor/coms.ts:14-15`**; **NEVER ship `@mariozechner/pi-proxy`** (no
    license, all 132 versions) or **`@mariozechner/pi`** (wrong package — vLLM pods CLI). The local
    tree runs pi libs at **0.55.4** while the vendor dir peer-pins **0.55.0** — pin before building.

**Trust boundaries**

15. **Nothing produced inside a box is trusted at the boundary (F10/R9).** In-box trace and gate
    evidence are **claims, not proof** — a skip-permissions agent controls everything it emits. No
    story may open a PR on in-box evidence alone.
16. **The trace DB carries full compiled prompts = client source code (F11/R10).** The visualizer is
    **never** the box's one shared public port; access is tier-1-tunneled and auth-gated.
17. **No push credential in any box; PR creation is host-side** (D8). Exactly one secret per box: a
    spend-capped, per-run, revocation-verified LLM key.

**Repo state**

18. **Phase-0 gate verdict is FAIL** (7 pass / 2 fail / 1 skip / 2 void) — "PHASE-0 IS NOT
    EXITABLE". **P0.5 and P0.9 are `in-review`, not `done`** (downgraded per issue #51 / PR #98).
    **OQ-4 is unowned** — Hindsight has never booted.
19. **P0.3's dev record claim** "warren 0.10.0 installed and CLI-verified on this host" was **FALSE**
    and has been corrected. **P0.7's AC2 premise is broken:** `hindsight-local-mcp` is an HTTP server
    on `:8888/mcp/`, not the stdio JSON-RPC binary the AC specifies.
20. **SSSF's Python engine, the inkwell orchestration system, and Orgo are REFERENCE ONLY (D10).**
    No story may vendor the SSSF Python engine or the inkwell system. **The visualizer is the single
    code adoption** (D6); everything else from those repos is pattern harvest.

---

## 7. Confidence and gaps in this analysis

- **Points are calibrated, not measured.** The v4 baseline (105 pts / 30 stories, "3–4 pts, e2e
  slices") is the only calibration available and none of those 30 stories reached `done` on the
  phase-1 side, so the baseline's *accuracy* is unvalidated. The 111-pt total should be read as
  "consistent with how this team has sized before," not as a duration forecast.
- **DF4's 8 points are the weakest estimate in the slate** — adopting ~4,656 lines of someone
  else's untested TS/Vue, adding auth and a test suite from zero, is the kind of work that
  routinely doubles. It is also the easiest cut, which is why it sits in S3.
- **The 2-dev parallelism assumption is only clean in S1.** S2 has every cross-track edge in the
  graph; a 45-pt sprint with that dependency density will not parallelize at 2× and should be
  planned as if it were closer to 1.5×.
