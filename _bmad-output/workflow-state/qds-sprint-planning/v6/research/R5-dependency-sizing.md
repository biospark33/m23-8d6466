# R5 — Dependency Graph + Wave/Sizing Analysis (v6 derivation research)

**Date:** 2026-10-01 · **Source of truth:** `_bmad-output/sprint-artifacts/dark-factory-v6/2026-10-01-v6-derivation-session-INPUT.md` (charter; line refs below are to that file) · **Scope:** read-only analysis; this report feeds the derivation session's DD-14 ratification, wave plan, and sprint-status reconciliation.

---

## 1. Dependency graph, rebuilt verbatim from the charter tables

### 1.1 v6a — Foundation (charter lines 71–83)

| ID | Pts | Deps (verbatim) | Live tier (verbatim) | Edge classification |
|---|---|---|---|---|
| Z1 | 3 | — | none | root |
| Z2 | 5 | Z1 | fake-CLI journal | in-table |
| Z4 | 3 | ops VPS G1–G7 | infra | **EXTERNAL-OPS** (operator-gated VPS runbook G1–G7; §2.1 cites the full runbook as G1–G9 — see F5) |
| Z5 | 2 | — | none | root |
| M1.1 | 3 | Z4 | infra | in-table (transitively external-ops) |
| M1.2 | 5 | M1.1 (mock-first dev before VPS) | **T2** | in-table; parenthetical = scheduling note (mock-tier dev unblocks early; live evidence gated on M1.1), not a separate dep |
| M1.3 | 3 | M1.2 | none | in-table |
| M2.1 | 5 | M1.1 | unit/mock | in-table — **but see F1 (wave conflict)** |
| J1 | 3 | — | mock + Jev-live probe | root |
| A6 | 2 | Z4 | infra | in-table (transitively external-ops) |
| G1 | 2 | — | none | root |

### 1.2 v6b — Autonomy (charter lines 91–104)

| ID | Pts | Deps (verbatim) | Edge classification |
|---|---|---|---|
| A1 | 5 | E21 S02b, S03b, Z2 | **EXTERNAL-E21** (zeropoint repo lanes: S02b in-flight, S03b backlog) + in-table Z2 |
| A2 | 5 | A1, M1.2, Z2 | in-table (inherits E21 gate via A1) |
| A3 | 3 | A1, A6, Z2 | in-table (inherits E21 gate via A1) |
| A5 | 3 | M1.2 | in-table |
| M2.2 | 5 | M2.1 | in-table |
| M2.3 | 2 | M2.2, M1.2 | in-table (M1.2 join omitted from the charter's "second path" line — F6, minor) |
| M3.1 | 3 | M2.1, A1 | in-table (inherits E21 gate via A1; charter carries the documented crontab fallback) |
| M3.2 | 3 | M3.1, A5 | in-table |
| Z3 | 3 | A2, Z2, M2.1 | in-table (inherits E21 gate via A2) |
| J2 | 3 | J1 + corpus milestones | in-table J1 + **EXTERNAL-MEASUREMENT** (calibration milestones: outcome-confirmed record count, agreement CI; DD-21/DD-22 define the gate — not a story) |
| J3 | 5 | J1, M1.2 | in-table |
| J4 | 5 | J1 | in-table |

External-edge inventory: exactly **three** external gate classes — (a) EXTERNAL-OPS: `Z4 ← ops VPS G1–G7` (also gates M1.1, A6 transitively; re-pin ritual separately gates every T2/infra round); (b) EXTERNAL-E21: `A1 ← S02b + S03b` (propagates to A2, A3, M3.1, Z3, M3.2-via-M3.1); (c) EXTERNAL-MEASUREMENT: `J2 ← corpus milestones`. Nothing references a story ID absent from either table.

### 1.3 Cycles

**None.** All edges point v6b→v6a or downward within a sprint; every story is reachable in a valid topological order, e.g.:
`Z1, J1, G1, Z5, M2.1 → Z4-authoring, A6 → (ops VPS day) M1.1 → M1.2-mock → M1.3, Z2 → [v6b] M2.2, A5, J4, J3 → M2.3 → (E21) A1 → A2, M3.1, A3 → Z3, M3.2, J2`.

---

## 2. FLAGS — charter deps vs waves (action: resolve in DD-14 / story specs)

- **F1 (MEDIUM — wave-vs-dep conflict, v6a):** M2.1 is assigned Wave 1 ("start now, no gates", line 85) but its declared dep is M1.1, which sits in Wave 2. Defensible reading: M2.1 is unit/mock tier — the credentials.ts-mirror + D8 amendment implementation needs no live instance, so its *dev* starts Wave 1 and only its *integration acceptance* waits on M1.1. The charter does not say this (the "mock-first" qualifier exists only on M1.2). **Recommended resolution:** story spec pins the dep as "M1.1 (integration acceptance only; dev starts Wave 1 against fixture)" — or the operator moves M2.1 to Wave 2. Do not leave it implicit.
- **F2 (MEDIUM — wave-vs-dep conflict, v6a):** M1.1 (Wave 2) depends on Z4, which is placed Wave 3 ("if VPS landed late"). Literal reading blocks M1.1. The charter's own intent is visible in §7.5 ("Z4 profile pre-built to fire"): Z4 *authoring* (compose/allowlist, no VPS needed) happens early; only *fire + verify* waits for the ops VPS day. **Recommended resolution:** split Z4's ACs into "authored" (no external dep, Wave 1–2) and "fired+verified on VPS" (dep ops G1–G7); "Wave 3 Z4" then means only the late-VPS fallback leg.
- **F3 (HIGH — arithmetic mismatch, epic table §3 lines 61–65):** Per-epic sums from the story tables: **Z = 16** ✓, **M = 29** (epic table says 26), **A = 18** (epic table says 16), **J = 16** ✓, **G = 2** ✓. Epic-table total = **76** vs story-table total = **81** (and vs §7.6 "81 pts honest"). Off by 5, entirely in M (−3) and A (−2) — the epic table is stale against its own story tables. §9.3 requires per-epic = per-sprint = total in sprint-status; the epic table as written would fail that reconciliation. **Fix the epic table in the derivation PR (M 26→29, A 16→18, total 76→81).**
- **F4 (LOW):** v6a has **no named flex-cut** — the charter names cuts only for v6b (J4-L9, then J3→v7). See §5 for the headroom math and a recommended v6a cut list.
- **F5 (LOW):** Z4's dep cites "ops VPS G1–G7" while §2.1/agenda item 13 cite the runbook as G1–G9 (G9 = GHCR publish ownership). Not a contradiction — the subset citation looks deliberate — but the ops dependency register should pin which G-items gate which story legs.
- **F6 (INFO):** The v6b "second path M2.1 → M2.2 → M2.3" line omits M2.3's M1.2 dep (the table carries it). Minor: M2.3 is not purely second-lane; it joins the M1.2 artifact.
- **F7 (INFO):** The v6b table has no "Live tier" column (v6a's does). v6b live needs live only in §5.6 prose. Sprint-status v6 section should carry a tier column for both sprints.
- **F8 (INFO):** A1's head gate includes Z2 (v6a Wave 3, BUILD-IN-FORK, pin bumps only at evidence rounds per §5.3) — the v6b critical path is gated at its head by **both** E21 lanes and a v6a fork-merge. Worth stating in the lane plan.

Sprint sums check (task 5): v6a rows sum to **36** ✓ (11 rows ✓); v6b rows sum to **45** ✓ (12 rows ✓); total **81** ✓ matches §7.6. The only arithmetic disagreement in the charter is F3 (epic table).

---

## 3. WRITING-wave allocation (this session) — 12 writer batches, ≤2 stories each

Pairing rule: shared substrate (same files/subsystem/DD agenda items) maximizes writer context quality.

| Batch | Stories | Shared substrate (writer loads these once) |
|---|---|---|
| B1 | Z1 + Z2 | Q1 contract discipline, `factory_observe` shape, SWARMCLAW_FORK_REV pinning, `normalizeStep` carry ACs; Z2 implements Z1's contract — one writer holds the whole contract text (DD-14 namespace context) |
| B2 | Z4 + A6 | vultr-deploy template (`deploy/control-plane/{Caddyfile,docker-compose.yml,backup.sh}`), firewall 22/80/443 never 18889, compose profile; A6 is one more service in Z4's stack |
| B3 | M1.1 + M2.1 | trusted server side: `src/hindsight/{client,bank-provisioner,round-trip-verifier}.ts`, `scripts/provision-hindsight-banks.ts`, `src/providers/credentials.ts` mint/revoke ordering, D8 amendment text (DD-16), P0.9 evidence legs |
| B4 | M1.2 + M1.3 | host-side cycle + its measurement: reactive-grounding/hindsight-context-adapter pattern (copy, skip Clerk/Presidio, keep directive/citation grammar), harvest-time idempotent retain (P2.8 fold), probe-set/hit-rate@k (DD-22) |
| B5 | Z5 + G1 | swarmclaw chassis (`src/swarmclaw/` utilities vs orphan server surface), DD-18 disposition, ADR-2 DRAFT scope (Z5's server-surface fate is explicitly deferred to ADR-2 = G1's artifact); Tier C vs ADR-1 reconciliation (DD-19) |
| B6 | J1 (solo) | `src/judgment/` full surface, Jev handoff §3/§4/§8, adapter-seam contract tests, drift alarm — the seam deserves an undivided writer |
| B7 | A1 + M3.1 | E21 Home bots + their meta banks: S02b/S03b seam fixtures (spec-seam §5.2), agent tokens, platform schedules, DD-20 spend join, crontab fallback |
| B8 | A2 + Z3 | `external_job` protocol + hunter-pack: A2 defines the QA protocol; Z3's exit round runs that exact protocol end-to-end — one writer holds the scenario shape (ADR-1, SC2.6/SC2.7 evidence, approval-park ACs) |
| B9 | M2.2 + M2.3 | in-box `kg_recall` pi extension + the combined live round that proves it: F10/INV-7 sanitization, char budget, roster grant, image re-pin ritual, revoke-verify teardown |
| B10 | A5 + M3.2 | ledgers + learning loop: `.sandbox` SQLite, cost-ledger, DD-20 join keys; M3.2 (reflect→PROPOSE) consumes A5's KPI snapshots — deps pair writes together (FR-LEARN-30/33) |
| B11 | A3 + J4 | sweeps + host-side judgment pack: §2.3 L8/L9 (QA pre-filter, pre-dispatch sanity, **repo-sweep triage**) is literally A3's substrate; A6 hotspots, audit chain, DF1.11 steering seam |
| B12 | J2 + J3 | calibration-gated vs uncalibrated dispatch judgment: J1 seam consumers, corpus milestones (DD-21), L3 composite scoring, model router, decision-log→M3.2 feed — specs must draw the calibrated/uncalibrated line together |

Coverage: 23/23 stories, 12 batches, max batch = 2. No writer needs both a v6a table's full memory chain and the fork-repo contract at once.

---

## 4. Dev-execution waves + two-lane view + E2E tier budget

### 4.1 v6a waves (charter line 85, restated) with lanes

| Wave | Lane 1 (contract/fork/gateway — green with zero ops) | Lane 2 (memory/infra critical path) |
|---|---|---|
| W1 | Z1, J1, G1, M2.1* (*dev-only per F1 resolution), Z4-authoring* (*per F2 resolution) | — |
| W2 | Z5, A6-authoring | M1.1 (needs ops VPS G1–G7 + Z4 fired), M1.2-mock |
| W3 | Z2 (BUILD-IN-FORK; fake-CLI keeps factory CI green) | M1.3, Z4 late-fallback leg |

Critical path: **ops-VPS → M1.1 → M1.2 (T2) → M1.3 cycles** (cycles continue into v6b; Graphiti checkpoint is DATED, not sprint-bound). The second lane is fully independent of wave-0 ops — that is the charter's "CI stays green regardless" property.

### 4.2 v6b waves (charter gives critical paths, line 106; two-lane view added)

| Track | Chain | Gates |
|---|---|---|
| Lane 1 — E21-gated | E21 S02b (in-flight) → S03b → **A1 → A2 → Z3**; side branches A3 (needs A1+A6+Z2), M3.1 (needs M2.1+A1, crontab fallback), M3.2 (needs M3.1+A5) | E21 lanes + Z2 fork-merge/pin-bump (F8) |
| Lane 2 — un-gated | M2.1 (v6a) → **M2.2 → M2.3**; plus A5, J4, J3 off v6a artifacts; J2 off corpus milestones | none (E21-independent — this is the physical cut line working as designed) |

The two lanes are genuinely parallel: lane 2 can complete before E21 lands anything. Joins: M2.3←M1.2 (v6a artifact), M3.1←A1.

### 4.3 E2E tier budget per story

**v6a** (from the Live tier column): `none` ×4 (Z1, Z5, M1.3, G1) · `fake-CLI journal` ×1 (Z2) · `infra` ×3 (Z4, M1.1, A6) · `unit/mock` ×1 (M2.1) · `mock + Jev-live probe` ×1 (J1) · **`T2` ×1 (M1.2)**. Only one T2-grade round in the whole sprint.

**v6b** (no column — from §5.6): live rounds = **Z3, A2, A3, M2.3**; everything else spec-seam/mock. M1.2's T2 carries over as the priming prerequisite.

### 4.4 Live-round list + qualitative cost framing (operator GO gates come later)

| Round | Boxes | E21 gate | Re-pin gate | Rough shape |
|---|---|---|---|---|
| M1.2 T2 (primed dispatch + retain) | 1 exedev box | none | **YES — wave-0 re-pin ritual blocks every T2** (CI verify-image-pin red, F-manifest) | 1–2 rounds, hours-scale; per-run micro-USD caps via DF2.3 |
| M2.3 combined (dispatch + in-box recall + revoke-verify) | 1 box + VPS stack | none | yes (T2-grade image) | 2+ rounds incl. an adversarial negative-control round (risk #2); caps + gateway TTLs |
| A2 QA protocol round | 1 box + factory Home bots | S02b+S03b | no (uses v6a image) | 1–2 rounds; spend = bot turns (zeropoint LLM-gateway ledger) + one fleet QA run |
| A3 sweep first-firing | 1 box + bots | S02b+S03b | no | cheapest autonomy round — single scheduled wake, briefs parked at approve gate |
| Z3 cross-repo exit (SC2.7 analog) | 1 box + fork daemon + schedules | effectively all lanes | no | most rounds of the set (2–4; SC2 precedent until invariants + approval park held); largest spend envelope |
| J1 Jev-live probe | 0 boxes | none | no | one pinned-model call; cents-class (~$0.002 S1 precedent) |

All rounds per §5.6: no-fakes, worst-case spend printed before fire, operator GO, keys/boxes cleaned in `finally`, evidence scrubbed.

---

## 5. Sprint slicing input — headroom math (+10–15% review growth; DD-13 realized +12/111 = +10.8%)

| Sprint | Base | Realized-rate growth (+10.8%) | Ceiling (+15%) | Named cuts | Cut coverage |
|---|---|---|---|---|---|
| v6a | 36 | ~40 | ~41–42 | **none named** (F4) → recommend: M1.3 interim-report slip (3, slip-safe by charter design — cycles continue into v6b), then A6→ops-ride (2), then G1-stays-DRAFT (2) | 5/36 = 13.9% (7/36 = 19.4% with G1) |
| v6b | 45 | ~50 | ~52 | **J4-L9 leg first (~1–2), then J3→v7 (5)** — charter line 106, "decided now, not mid-sprint" | 6–7/45 ≈ 13–16% |

Suggested pre-authorized triggers (encode in the DD register so cuts are not mid-sprint judgment calls):
- v6a: post-review total > 40 → M1.3 report slips (already structured to be slip-safe); > 42 → additionally A6 to ops ride.
- v6b: post-review total > 50 → pre-authorize L9 cut; > 52 → additionally J3 → v7.

Cuts neutralize worst-case growth in both sprints (v6b: 52 − 5 − ~1.5 ≈ 45.5 ≈ back to base).

---

## 6. Summary for the derivation session

1. Fix the §3 epic table before sprint-status reconciliation: **M 26→29, A 16→18, total 76→81** (F3). Everything else reconciles.
2. Pin F1 (M2.1 dep semantics) and F2 (Z4 authored-vs-fired split) in DD-14/story specs — both are charter-internal inconsistencies, both have obvious intended readings.
3. Adopt or amend the 12-batch writing allocation (§3) and the two-lane dev plan (§4).
4. Name v6a flex-cuts (F4) and encode the four cut triggers (§5) in the DD register.
5. Carry a Live-tier column for v6b in sprint-status (F7) and pin the G1–G7 vs G1–G9 subset in the ops dependency register (F5).
