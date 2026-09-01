# Atomicity Audit — dark-factory-v5 v5-S3 in-box restoration arc — 2026-08-31

**Auditor:** qds-sprint-planning Phase 2.5 (in-box restoration arc run)
**Total stories audited:** 4 (DF2.10, DF1.10, DF1.11, DF3.7 — all newly written)
**Pass:** 3 / **Warn:** 1 / **Block:** 0

**Context:** First atomicity audit of the four v5-S3 stories produced by the
2026-08-31 planning run against `docs/superpowers/specs/2026-08-31-tier2-placement-adr.md`.
Counting method is identical to the 2026-08-11 and 2026-08-20 audits: normative
lines = total lines minus the `## Dev Agent Record` block and any trailing
appendix (all four stories end with an empty Dev Agent Record placeholder, so
normative = total − 3 in each case). Every number below is a mechanical
`grep`/`wc` count, not an estimate. In addition to the eight standing checks,
five run-specific checks were applied (header-field shape, mandatory e2e DoD
terminator, INV-IBOX range allocation, renumbering disambiguation, and DF1.11's
two required Files-to-Modify entries); those appear as extra rows in each
table and are summarised in their own section.

## Story-by-story findings

### DF2.10 — Factory-Owned Boot Image — a Digest-Pinned exe.dev Substrate We Own

| Check | Severity | Result | Notes |
|-------|----------|--------|-------|
| normative size (≤200) | BLOCK if >250 | pass | 185 normative (188 total) — 15 under |
| total size (≤400) | WARN | pass | 188 lines |
| SP budget (≤8) | BLOCK | pass | 5 SP |
| DOD count (≤10) | WARN | pass | 10 items, all story-specific (no CI invariants: zero hits for lint/tests-pass/mypy/ruff/format-check) |
| title AND connectors | WARN | pass | 0 (`and`/`&`/`+`, case-insensitive, word-boundary) |
| blocker markers (=0) | BLOCK | pass | 0 hits for `⛔` / `pending sign-off` / `TBD on` |
| Files-to-Modify section | BLOCK if absent | pass | present at `:146`; 8 bullets → **10 unique paths** (bullet 5 enumerates `driver.ts`, `setup-gate.ts`, `assertions-in-box.sh`) — exactly at the limit |
| Security Invariants | BLOCK if triggered+absent | pass | triggered (auth ×16, credential ×21, secret ×7, parse ×2, policy ×2); section present with three substantive named invariants (INV-IBOX-1 no credential in image, INV-IBOX-2 in-box identity assertion, INV-IBOX-3 registry credential class + argv hazard) |
| *run-specific:* header fields | — | pass | exactly two bold header fields: `**Story Points:** 5`, `**Sprint:** v5-S3 …` |
| *run-specific:* DoD e2e terminator | — | pass | last DoD item is `**Test (e2e demo — MANDATORY):**` |
| *run-specific:* INV-IBOX range | — | pass | defines 1–3; assigned range 1–3 |
| *run-specific:* renumbering line | — | n/a | not required for this story |

### DF1.10 — In-Box Phase Engine — the Deterministic Walk Runs Where the Design Put It

| Check | Severity | Result | Notes |
|-------|----------|--------|-------|
| normative size (≤200) | BLOCK if >250 | **warn** | **211 normative** (214 total) — 11 over the 200 target, 39 under the 250 BLOCK threshold |
| total size (≤400) | WARN | pass | 214 lines |
| SP budget (≤8) | BLOCK | pass | 8 SP — at the ceiling, not over |
| DOD count (≤10) | WARN | pass | 10 items, all story-specific |
| title AND connectors | WARN | pass | 0 |
| blocker markers (=0) | BLOCK | pass | 0 hits |
| Files-to-Modify section | BLOCK if absent | pass | present at `:163`; 10 bullets → 10 unique paths — exactly at the limit |
| Security Invariants | BLOCK if triggered+absent | pass | triggered (auth ×10, credential ×5, secret ×3, schema ×5, policy ×2); section present with six substantive named invariants (INV-IBOX-4 one secret/one machine, -5 no new authority, -6 default-fail journal discipline, -7 claims-not-proof, -8 durability boundary, -9 closed records) |
| *run-specific:* header fields | — | pass | exactly two: `**Story Points:** 8`, `**Sprint:** v5-S3 …` |
| *run-specific:* DoD e2e terminator | — | pass | last DoD item is `**Test (e2e demo — MANDATORY):**` |
| *run-specific:* INV-IBOX range | — | pass | defines 4–9; assigned range 4–9 |
| *run-specific:* renumbering line | — | pass | `:10` — "**Renumbering, stated once:** … mean **DF1.11** under the ADR's re-charter" |

### DF1.11 — In-Box Steering Executor + Channel Lifecycle

| Check | Severity | Result | Notes |
|-------|----------|--------|-------|
| normative size (≤200) | BLOCK if >250 | pass | 140 normative (143 total) — 60 under |
| total size (≤400) | WARN | pass | 143 lines |
| SP budget (≤8) | BLOCK | pass | 5 SP |
| DOD count (≤10) | WARN | pass | 10 items, all story-specific |
| title AND connectors | WARN | pass | 1 (`+` in "Steering Executor **+** Channel Lifecycle") — at the ≤1 limit |
| blocker markers (=0) | BLOCK | pass | 0 hits |
| Files-to-Modify section | BLOCK if absent | pass | present at `:107`; 10 bullets → 10 unique paths — exactly at the limit |
| Security Invariants | BLOCK if triggered+absent | pass | triggered (credential ×3, schema ×1); section present with four substantive named invariants (INV-IBOX-10 one channel/no second transport, -11 runId provenance, -12 channel shape + co-location, -13 one root in both environments) plus a restated DF3.3 INV-RES-4 |
| *run-specific:* header fields | — | pass | exactly two: `**Story Points:** 5`, `**Sprint:** v5-S3 …` |
| *run-specific:* DoD e2e terminator | — | pass | last DoD item is `**Test (e2e demo — MANDATORY):**` |
| *run-specific:* INV-IBOX range | — | pass | defines 10–13; assigned range 10–13 |
| *run-specific:* renumbering line | — | pass | `:13` — "**Disambiguation:** … mean **DF1.11** under the ADR's re-charter; DF1.10 is now the in-box phase engine" |
| *run-specific:* FTM `scripts/fleet.ts` remediation string | — | pass | `:110` — names the `no-ack` remediation string and the stale shipped text "no in-box executor exists yet (DF1.10)" |
| *run-specific:* FTM `tests/fleet/gate-verbs.test.ts` pinned assertion | — | pass | `:114` — names the pinned assertions at `:1392-1393` (`toContain("no in-box executor exists yet")`, `toContain("DF1.10")`); reinforced by the AC5 DoD item at `:138` |

### DF3.7 — Approval-Gate Bridge — Run-Completion Signal for In-Box Runs

| Check | Severity | Result | Notes |
|-------|----------|--------|-------|
| normative size (≤200) | BLOCK if >250 | pass | 131 normative (134 total) — 69 under; smallest story in the arc |
| total size (≤400) | WARN | pass | 134 lines |
| SP budget (≤8) | BLOCK | pass | 4 SP |
| DOD count (≤10) | WARN | pass | 10 items, all story-specific |
| title AND connectors | WARN | pass | 0 |
| blocker markers (=0) | BLOCK | pass | 0 hits |
| Files-to-Modify section | BLOCK if absent | pass | present at `:105`; 5 bullets → 5 unique paths |
| Security Invariants | BLOCK if triggered+absent | pass | triggered (auth ×2, credential ×1, parse ×4, schema ×1); section present with three substantive named invariants (INV-IBOX-14 gate ownership unchanged and provably so, -15 marker is signal not evidence, -16 one reverify entry / no daemon / no new state) |
| *run-specific:* header fields | — | pass | exactly two: `**Story Points:** 4`, `**Sprint:** v5-S3 …` |
| *run-specific:* DoD e2e terminator | — | pass | last DoD item is `**Test (e2e demo — MANDATORY):**` |
| *run-specific:* INV-IBOX range | — | pass | defines 14–16; assigned range 14–16. Two mentions of INV-IBOX-13 (AC4 `:65`, Technical Notes `:96`) are **attributed cross-references to DF1.11's** invariant, not re-definitions — no collision |
| *run-specific:* renumbering line | — | pass (not required) | `:13` carries the same disambiguation line as DF1.11; harmless and consistent |

## Cross-story run-specific checks

- **INV-IBOX numbering is collision-free.** 16 invariants defined across four
  stories, each exactly once, each inside its assigned range:
  DF2.10 → 1, 2, 3; DF1.10 → 4, 5, 6, 7, 8, 9; DF1.11 → 10, 11, 12, 13;
  DF3.7 → 14, 15, 16. No number is defined twice and no gaps exist in 1–16.
  The only re-use of a number outside its owning story is DF3.7's two
  read-only references to DF1.11's INV-IBOX-13, both explicitly attributed.
- **Header shape is uniform.** Every story carries exactly two bold header
  fields before the first `##` heading, in the order `**Story Points:**` then
  `**Sprint:** v5-S3 …`, with no extra fields (no Status, Priority, Owner).
- **Every DoD ends with the mandatory e2e demo item.** All four terminate on
  `- [ ] **Test (e2e demo — MANDATORY):**`.
- **Both relocation stories carry the renumbering disambiguation.** DF1.10
  `:10` and DF1.11 `:13`; DF3.7 `:13` carries it too (not required, no harm).
- **DF1.11's two required Files-to-Modify entries are present** and both name
  the specific artefact, not just the file: the `scripts/fleet.ts` `no-ack`
  remediation string, and the `tests/fleet/gate-verbs.test.ts` pinned
  assertions at `:1392-1393`.

## Summary

- **BLOCK-severity violations:** none. Phase 3 may proceed without an operator
  override.
- **WARN:** DF1.10 at 211 normative lines (11 over the 200 target, 39 under
  the 250 BLOCK threshold). No other WARN fired in the arc.
- **Recommendation on the single WARN:** no distillator run. DF1.10 is the 8 SP
  keystone of the arc and its overage is concentrated in the Spec Reference and
  Technical Notes blocks that record measured probe evidence and corrected
  premises — the material that exists specifically to stop the implementer
  re-deriving folklore. Trimming it would remove the citations, not the scope.
  Revisit only if the Phase-3 adversarial loop pushes it past 250, which is the
  documented failure mode from the 2026-08-20 audit (DF3.1 grew 204 → 326 total
  through review). The arc starts with real headroom: 185 / 211 / 140 / 131
  normative against a 200 target and a 250 ceiling.
- **Notable margins to watch during Phase 3:** three stories sit exactly at a
  limit — DF2.10, DF1.10 and DF1.11 each list exactly 10 unique files
  (Files-to-Modify limit), all four have exactly 10 DoD items (DoD limit), and
  DF1.10 is exactly 8 SP (SP ceiling). Any review-driven addition to those
  three counts crosses a gate line.

## Override log (operator)

<!-- Empty — no BLOCK-severity violation was raised, so no override is required. -->

---

## Addendum (2026-08-31, post-adversarial-pipeline + DF3.8 charter)

**Context:** after this audit's first pass, (a) all four stories went through
per-story adversarial pipelines (0 HIGH each) + a cross-story consistency pass,
and (b) the operator chartered a fifth story at the review gate — DF3.8
Host-Side Completion Watcher (4 SP) — closing the host-disconnect gap DF3.7's
pipeline surfaced. Post-edit mechanical recount (normative = total − 3, same
method as above):

| Story | Normative | Total | SP | Verdict |
|-------|-----------|-------|----|---------|
| DF2.10 | 198 | 201 | 5 | pass (was 185 pre-pipeline; review fixes added probe ACs) |
| DF1.10 | 191 | 194 | 8 | pass (was 211 WARN pre-pipeline; review TRIMMED it under target) |
| DF1.11 | 139 | 142 | 5 | pass |
| DF3.7 | 132 | 135 | 4 | pass (incl. the two one-clause DF3.8 amendments) |
| DF3.8 | 150 | 153 | 4 | pass — all 8 standing checks pass; INV-IBOX-17..19 in range; DoD 10 boxes ending e2e-MANDATORY; Files to Modify present (≤10); Security Invariants present (auth/credential triggers fire); 0 blocker markers; title 0 AND-connectors |

The first-pass WARN (DF1.10 at 211) is RESOLVED — the adversarial pipeline
trimmed it to 191. No BLOCK, no WARN outstanding. Sprint headers read
"story N of 5" (ordinals updated when DF3.8 was chartered). Arc totals:
5 stories / 26 SP, all v5-S3.

**Override log:** (empty — nothing to override)
