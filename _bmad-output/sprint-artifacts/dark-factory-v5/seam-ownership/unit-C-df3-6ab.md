# Seam-ownership table — Unit C: DF3.6a (spend/iteration policy) + DF3.6b (kernel memory bound)

Wave 7 rework artifact. Worklist: `wave6-C-df3-6ab.md`. Seam: the manifest's `residentRssBytes`
value (DF3.6a validates + carries, DF3.6b applies) and the `cause`-union widening (owned by DF3.6a,
written into by both).

## Operator rulings recorded (tracker Wave-7 section carries the full text)

- **Metering basis (W6-C-B1, operator 2026-09-13): honest metered operand.** The engine accumulates
  `meter(reply.usage)` actuals; the pre-call refusal compares the **projected** next-call worst case
  (`spent + projected > effectiveCeiling`) — which makes the story's "refusal is driven by the
  projection" sentence true unambiguously; the post-call tripwire catches the one-call overshoot a
  soft projection allows; AC1's journal assertion weakened to `ceiling + one call's metered cost`.
  The accumulator is the same quantity DF2.12's landed token rows record — one spend truth,
  auditable at DF5.3 hop 3. No binding call count is derived (three derivations died deriving one).
- **Ceiling basis (W6-C-B3, operator 2026-09-13): user policy, not a derivation.** The ceiling is a
  spend amount the user sets — a **global default applying to all repos/projects/tasks** plus a
  **per-task custom override**. Ladder at fill: `perIssueOverrides` entry (the factory substrate's
  per-task seam, the one DF2.13's `--cap` uses; a factory UI is a future product story) → user-set
  config default → shipped **fallback** 8,000 µ$ (documented as fallback for cheap rosters, never
  as a derivation). `below_one_call` stays as the typed refusal when the configured amount cannot
  buy one projected call — a policy outcome, named as such (subsumes W6-C-L2).

## Ownership

| # | Deliverable | Owner (exactly one) |
|---|---|---|
| O1 | `src/phase-engine/resident-bounds.ts` — `loadResidentBounds` (scoped to resident-arming runs), `checkBounds` (pre-call projection refusal + post-call metered tripwire), the projection, the per-phase solicitation counter | DF3.6a |
| O2 | The ceiling-resolution ladder + its stamp onto the frozen manifest | DF3.6a |
| O3 | The `meter` zero/`{0,0}` charging arm | DF3.6a |
| O4 | The `cause`-union widening + `telemetry.status="stopped"` internal writer | DF3.6a |
| O5 | `scripts/pipeline-run.ts` pair edits (i)–(ii) | DF3.6a |
| O6 | `scripts/pipeline-run.ts` pair edits (iii)–(vii) — `residentRssBytes` pass, `lastMemory` wiring, `onBoundBreach`→`stop()` handler, **the arming try/catch classification beside the rate-refusal arm**, **the run-down refresh precedence (engine's `exitStatus:"overflow"` survives the final refresh)** | DF3.6b |
| O7 | The cgroup mechanism (`resident.ts`, unit, Dockerfile scan) | DF3.6b |
| O8 | The AC1 live proof — **two legs**: synthetic allocator as the leg's `QDS_PI_BIN` (zero spend; proves kernel-kill-without-signal) + the tier's real solicitation (proves real-pi-under-bound, attachment, telemetry, removal) | DF3.6b |
| O9 | `src/phase-engine/manifest.ts` — the three bound fields + AC2a operands (DF3.6a); **the 512 MiB constant re-set from DF3.6b's measured baseline** (DF3.6b, scoped to that one value) | split per constant |
| O10 | The e2e demo's env contract (`FAKE_RESIDENT_USAGE`, `spawnRunner` inheritance) | DF3.6a |
| O11 | yaml DF3.6a row (`DF2.13` dep edge) | parent (W6-C-M4) |
| O20 | The fill-side stamp provisioner — the dispatch fill-step edit stamping `residentSpendCeilingMicros`/`capMicroUsd`/`defaultKeyCapMicroUsd`**/`residentRssBytes`** onto the frozen manifest, beside DF3.1's shipped `stampManifestLimit` (adds-only in the DF3.1-owned file; DF5.3 setup-gate precedent). The fourth operand resolves manifest-declared → `PROVISIONAL_RESIDENT_RSS_BYTES` (512 MiB, re-set by DF3.6b per W6-C-H4) — the production provisioner W12C-6a-1 demanded. `limitMicroUsd` stays DF3.1's stamp's field alone (CC-1) and `defaultCapMicroUsd` is DF2.8's host-side derivation source — neither is a DF3.6a operand (W8-C-1; W9-review correction) | DF3.6a |
| O21 | `src/fleet/dispatch.ts` — the fill-side stamp edit's only permitted scope (no other dispatch change) | DF3.6a |

## Reconciliations applied (Wave 6 → spec)

| Finding | Disposition |
|---|---|
| W6-C-B1 (BLOCKER, C2) | **Ruled, then rewritten**: honest metered operand (ruling above); the N×504/"binds at call 16" derivation deleted — the number the code does not accumulate; AC1 carries the one-call margin. |
| W6-C-B2 (BLOCKER, C2) | **Demo made executable**: `FAKE_RESIDENT_USAGE` named (metered per call ≡ projection by construction), `spawnRunner` env inheritance stated (`QDS_PI_BIN` → fake resident, passthrough, `QDS_PI_MODELS_JSON` → nonexistent) — the demo never spawns real pi against a fabricated price table. |
| W6-C-B3 (BLOCKER, C2) | **Ruled, then rewritten**: user-policy ladder; the fixture-price "shipped rates" claim gone; the fallback labeled as fallback; `below_one_call` named a policy outcome. |
| W6-C-B4 (BLOCKER, C3) | **Trigger made producible** (O8): synthetic allocator leg (zero spend, proves the kernel kills a cgroup the engine never signals) + real-pi leg (proves attachment/under-bound/telemetry/removal); falsifier split per leg. |
| W6-C-H1 (C2) | AC4 targets **no positive usage / `turnCount === 0`** (the reachable meter-zeroing path), not "no usage field"; `{0,0}` negative control added. |
| W6-C-H2 (C3) | **Refusal scoped to runs that arm a resident** (`--no-resident` / empty-brief never reach it); `boundsPolicy` defined as the flat stamped triple (W6-C-M1); **`limitMicroUsd` dropped from the required set** — it bounds the provider key, not the resident bound; absence → unclamped ceiling, never a refusal. The `.optional()`-vs-refused contradiction resolved. |
| W6-C-H3 (C2) | AC1's margin + the two soft ceilings recorded as a deviation. |
| W6-C-H4 (C3) | 512 MiB marked provisional-pending-DF3.6b; `manifest.ts` in DF3.6b's Files to Modify scoped to that constant. |
| W6-C-H5 (C3) | **Arming refusal classified**: typed error handled in the arming try/catch beside the rate arm, emitting the shipped `resident_disabled` shape — never an unclassified rethrow, never the `onBoundBreach` region (which is not constructed on the arming path). |
| W6-C-M2 (C1) | **Pair-total edit count stated once: seven** on `scripts/pipeline-run.ts` — no half's "no other change" can reject the other's. (Six through Wave 9; edit (vii), the run-down refresh precedence, added by the Wave-9 fix — W9-C-1's clobbered `exitStatus:"overflow"` observable.) |
| W6-C-M3 (C1) | The stale "1,000× the 50,000 µ$ ceiling" bullet corrected (backstop named, 6,250× the fallback). |
| W6-C-M4 (C3) | `DF2.13` added to the yaml DF3.6a deps (parent). |
| W6-C-M5 (C1) | Citations by symbol/row key; line numbers stripped in touched text. |
| W6-C-M6 (C1) | `--no-tools` cited by symbol (the pi spawn argv in `src/fleet/resident.ts`). |
| W6-C-L1 (C1) | The dead line-cite cluster (`credentials.ts` `:47`/`:281` family, `cost-ledger.ts` `:444`, `pipeline-run.ts` `:2054`/`:3294-3297`) re-anchored to symbols in the sections this rework touched; the Split Record's historical citations left as history. |
| W6-C-L2 (C4) | Subsumed by the B3 ruling (policy-outcome sentence). |
| W6-E-M7's `df3-6a` tail | Verified at source: the three "at the dispatcher" framings are accurate post-DF2.12 (dispatcher wiring landed); owned here, no edit owed. |
