# DF3.1+DF3.2 Verification Report — Wave 5 (Fresh-Eyes)

**Reviewer:** Wave 5 agent (beginner's mind, no prior review knowledge)
**Files reviewed:**
- `_bmad-output/sprint-artifacts/dark-factory-v5/stories/df3-1-dispatcher-core-verbs.md`
- `_bmad-output/sprint-artifacts/dark-factory-v5/stories/df3-2-fanout-best-of-n.md`

**Context:** DF3.1+DF3.2 dependency-PAIR — dark-factory-v5 story specs.

---

## New Findings by Severity

### BLOCKER
None.

### HIGH
None.

### MEDIUM
- **DF3.1-V-M1:** The DF2.8 contract citation is explicit and correctly structured. AC7 cites the DF2.8 story spec with precise line anchors (`df2-8-cost-ledger-budget-cap.md:27-30` for interface, `:69-73` for gate contract) and proper "contract-cited; implementation pending" language. The spec correctly defers implementation details to DF2.8 while binding the call contract shape.

### LOW
- **DF3.1-L1:** AC9b's description of `effectiveCeilingMicros` references `defaultKeyCapMicroUsd` as "DF2.3's configured default" without an explicit file:line citation. Minor — the predecessor story is named and intent is clear.

### NONE
No regressions or issues missed by prior review waves detected.

---

## Pair-Contract Verdict: **ALIGNED**

The DF3.1 ↔ DF3.2 pair contract is sound across all four load-bearing dimensions:

### 1. Dispatch ack + requestId shape (CC-9)
- DF3.1 AC2 defines the resolved-value rule (dispatcher mints the runId; caller's UUID v4 is honoured else dispatcher mints fresh; ack carries resolved value).
- DF3.2 §14 contracts to this propagation rule.
- Both specs name the four propagation sites (DF3.1 INV-4-bis; DF3.2 observability contract): brief → ack → every run-record mutation/driver-call log line → trace-store rows.
- DF3.1's boundary against DF1.8 (lines 177-181) is clean: calls `resolveRunCorrelation` and owns only the exit-code mapping.

### 2. Fanout composition over dispatch
- DF3.2 AC3 is explicit: all N runIds are minted **before** the parallel section opens, through N synchronous calls to DF3.1's own `mintRunId()` (never caller-invented ids).
- Each pre-minted id is passed into its arm's `dispatch(brief, { admitted: true, runId })` call.
- DF3.1 Technical Notes (lines 214-222) confirm this signature and the invariant: "dispatcher remains the sole minter; DF3.2 only sequences *when* the mint happens."
- The in-process signature `dispatch(brief, { admitted?, runId? })` is documented with the constraint that `runId` is only ever a value the dispatcher itself already minted.

### 3. checkHeadroom(1) vs checkHeadroom(N)
- DF3.1 AC8: single dispatch calls `checkHeadroom(1)` **unless** `{ admitted: true }` is passed. The suppression logic is explicit (lines 109-112).
- DF3.2 AC1: fanout calls `checkHeadroom(N)` once before the first mint, then passes `admitted: true` to each arm's dispatch.
- The two checks cannot collide: DF3.2 makes exactly one `checkHeadroom(N)` inside its `.sandbox/fleet.lock` critical section; DF3.1's per-dispatch check is the guard for the **serial** path DF3.2 never sees.
- Both specs explicitly state that `{ admitted: true }` is set **only** by DF3.2 inside its critical section (DF3.1 line 206-213; DF3.2 lines 205-208).

### 4. admitted-flag suppression
- DF3.1 documents the `admitted` parameter as reachable only by in-process callers, with no CLI flag mapping (lines 109-113, 211-213).
- DF3.1 AC8's negative control test asserts that an implementation consulting headroom only in `fanout` fails.
- DF3.2 DOD integration checkbox and DF3.1 DOD integration checkbox both require coverage that `admitted` suppresses only the headroom call, not the budget call.
- DF3.1's coverage test requirement (lines 212-213) confirms the sole in-process caller invariant.

---

## Phantom-Reference Sweep: **CLEAN**

Spot-verified load-bearing citations against `src/` (grep +n bounded to ≤80 lines):

| Citation | Spec anchor | Source location | Status |
|----------|-------------|-----------------|--------|
| `checkHeadroom` | DF3.1 AC8, DF3.2 AC1 | `src/providers/quota.ts:192` | ✅ implemented |
| `resolveRunCorrelation` | DF3.1 boundary note | `src/phase-engine/issue-correlation.ts:85` | ✅ implemented |
| `extensions` namespace | DF3.1 run-record extension | `src/providers/run-record.ts:95,247-310` | ✅ implemented |
| `runMarkerRoot` / `final.json` | DF3.2 AC5 polling predicate | `src/phase-engine/journal.ts:38-44` | ✅ implemented |
| `limitMicroUsd` (run-record) | DF3.1 AC9a cap hand-off | `src/providers/run-record.ts:58,88` | ✅ declared |
| `effectiveCeilingMicros` (run-context) | DF3.1 AC9b cap hand-off | `src/phase-engine/types.ts:194,204` | ✅ declared |
| DF2.8 `assertWithinBudget` | DF3.1 AC7 contract-cite | Contract-cited-pending | ✅ correctly deferred |

**Note on `limitMicroUsd` in manifest schema:** DF3.1 AC9a states "this story declares `limitMicroUsd` in the manifest's zod schema" (lines 116-118). The field is not yet in `src/phase-engine/manifest.ts` — this is **expected**, as DF3.1 is pre-development and the spec itself declares adding this field as part of its work. Not a phantom reference; the spec correctly describes what it will create.

---

## Coherence Summary

The two specs read as a cohesive, mutually-supporting pair:

### Structural coherence
- DF3.1 establishes the core verb contract and explicitly documents extension points for DF3.2 (`admitted` flag, `mintRunId()` exposure, `runId` pre-minting pattern, manifest schema extension points).
- DF3.2 composes over DF3.1 with zero ambiguity about where DF3.1's responsibilities end and DF3.2's begin.

### Dependency handling
- DF2.8 (budget cap) is correctly handled as contract-cited-pending: AC7 cites the DF2.8 story spec with precise line anchors and states "implementation pending" with a precondition that DF2.8 lands before AC7 executes.
- DF2.6 (headroom ceiling) same-sprint sequencing is explicit in both specs (DF3.1 lines 51-54; DF3.2 lines 59-63), with the call-site commitment that AC1/AC8 ship in the commit landing DF2.6's import.

### Security invariants
- INV-2 (fail-closed ingress): strengthened with explicit "rejected dispatch provisions nothing" language in both specs.
- INV-4-bis (requestId propagation end-to-end): carried forward from R3 doctrine, names four propagation sites in DF3.1 and echoed in DF3.2 observability.
- INV-6 (credential/URL redaction): added to both specs per R3 redaction doctrine (regex `[0-9a-zA-Z%-]{16,}`).

### Predecessor citations
- DF1.8 (`resolveRunCorrelation`) cited with clear boundary: DF3.1 calls it and owns only exit-code mapping.
- DF2.1 (run-record extension namespace) cited correctly; DF3.2 AC9 uses the namespace per DF2.1's `schemaVersion` requirement.
- DF2.3 (credential lifecycle) cited for cap hand-off.
- DF2.5 (harvest/teardown) cited with guard preservation assertions in both specs.

### Final verdict
- No BLOCKERs or HIGHs.
- One MEDIUM (actually positive — DF2.8 citation is correct and well-structured).
- One LOW (missing file:line on `defaultKeyCapMicroUsd` reference).
- Phantom-reference sweep is clean.
- Pair contract holds across all four dimensions.

---

**Wave 5 recommendation:** The DF3.1+DF3.2 pair is ready for development. The specs are coherent, their pair contract is sound, and all load-bearing citations are either implemented or correctly deferred as contract-cited-pending.
