# Atomicity Audit — dark-factory-v6 — 2026-10-02

**Auditor:** qds-sprint-planning Phase 2.5
**Total stories audited:** 23 (11 v6a + 12 v6b)
**Pass:** 21 / **Warn:** 2 / **Block:** 0

> **Post-campaign recount (2026-10-02, after the pre-dev adversarial campaign's fix waves):**
> all 23 stories re-measured — totals 104–136 (≤200 cap ✓), SP 2–5 (≤8 ✓), blocker
> markers 0 ✓. Two accepted WARNs: **M2.2** (title AND-connectors, below) and **J3**
> (DOD = 12 — the campaign added the concurrency-integrity and import-closure-fence arms;
> both are high-signal story-specific tests, not CI invariants; accepted rather than merged
> because each guards a distinct make-or-break behavior).

Mechanical scan (all per `.claude/skills/qds-sprint-planning/steps/phase-2-5-atomicity-audit.md`):
total lines 103–130 (target ≤185, cap 200/400) · SP 2–5 (≤8) · DOD 7–12 (≤10; J3 at 12 = the
WARN below) · blocker
markers 0 · `## Files to Modify` present ×23, owned files 4–10 (≤10) · `## Security
Invariants` present ×23 (substantive — every story triggers security keywords).

## Story-by-story findings

| Story | total | SP | DOD | ANDs | blockers | FTM | SecInv | Verdict |
|---|---|---|---|---|---|---|---|---|
| A1 | 130 | 5 | 10 | 0 | 0 | 9 | ✓ | PASS |
| A2 | 109 | 5 | 8 | 0 | 0 | 8 | ✓ | PASS |
| A3 | 109 | 3 | 8 | 0 | 0 | 5 | ✓ | PASS |
| A5 | 130 | 3 | 9 | 1 | 0 | 5 | ✓ | PASS |
| A6 | 109 | 2 | 8 | 1 | 0 | 8 | ✓ | PASS |
| G1 | 124 | 2 | 9 | 1 | 0 | 7 | ✓ | PASS |
| J1 | 121 | 3 | 8 | 0 | 0 | 10 | ✓ | PASS |
| J2 | 120 | 3 | 9 | 0 | 0 | 9 | ✓ | PASS |
| J3 | 128 | 5 | **12** | 0 | 0 | 7 | ✓ | **WARN** |
| J4 | 113 | 5 | 8 | 0 | 0 | 8 | ✓ | PASS |
| M1.1 | 118 | 3 | 10 | 0 | 0 | 10 | ✓ | PASS |
| M1.2 | 130 | 5 | 8 | 0 | 0 | 10 | ✓ | PASS |
| M1.3 | 109 | 3 | 9 | 0 | 0 | 6 | ✓ | PASS |
| M2.1 | 115 | 5 | 10 | 0 | 0 | 8 | ✓ | PASS |
| M2.2 | 107 | 5 | 8 | **2** | 0 | 7 | ✓ | WARN |
| M2.3 | 103 | 2 | 9 | 0 | 0 | 4 | ✓ | PASS |
| M3.1 | 112 | 3 | 10 | 1 | 0 | 7 | ✓ | PASS |
| M3.2 | 120 | 3 | 9 | 0 | 0 | 7 | ✓ | PASS |
| Z1 | 103 | 3 | 7 | 1 | 0 | 6 | ✓ | PASS |
| Z2 | 119 | 5 | 9 | 0 | 0 | 10 | ✓ | PASS |
| Z3 | 107 | 3 | 10 | 0 | 0 | 5 | ✓ | PASS |
| Z4 | 112 | 3 | 7 | 0 | 0 | 9 | ✓ | PASS |
| Z5 | 112 | 2 | 9 | 0 | 0 | 7 | ✓ | PASS |

## Summary

- BLOCK-severity violations: none.
- WARN (check 5, title AND-connectors ≤1): **M2.2** "In-box `kg_recall` pi extension + roster
  grant + full image re-pin ritual" — two connectors, three concerns. **Accepted as-is with
  rationale**: the compound scope is the charter's own row (charter §3 v6b table) and the
  three legs share one subject — the same pi extension that gains the tool must gain the
  roster grant, and the box-image change those cause is what forces the re-pin ritual; a
  split would separate the pin trigger from the pin cause. If review surfaces the ritual as
  its own work unit, the split seam is "AC5 (re-pin) → own story".
- WARN (check 4, DOD ≤10 high-signal): **J3** DOD = 12 — the pre-dev campaign added the
  concurrency-integrity and import-closure-fence arms; both are high-signal story-specific
  tests, not CI invariants, and each guards a distinct make-or-break behavior (AC2's
  single-writer log posture; the no-judgment-import fence). **Accepted rather than merged.**

## Override log (operator)

(empty — no overrides needed)
