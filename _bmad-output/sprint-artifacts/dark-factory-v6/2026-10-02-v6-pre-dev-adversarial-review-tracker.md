# Dark Factory v6 — Pre-Dev Adversarial Review Tracker

**Date:** 2026-10-02 · **Sprint:** v6a + v6b (23 stories) · **Skill:** qds-story-review (charter §9.4)
**Stories:** `_bmad-output/sprint-artifacts/dark-factory-v6/stories/` (11 v6a + 12 v6b gated)
**Register:** `docs/superpowers/specs/2026-10-02-v6-story-derivation-decisions.md` (DD-14…DD-28, §8a DD-28.26)

## STATUS: CONVERGED — campaign complete, all findings applied, regression-clean

Final state: consistency gate green (`check-story-consistency`: 65 stories / 250 pts agree;
story-consistency test 2/2). Every finding below is `✅ DONE` (fixed in place) or recorded as
a register adjudication (DD-28.26). No surviving BLOCKER/HIGH.

## Review history (three layers, all converged)

### Layer 1 — qds-sprint-planning Phase-3 adversarial pipeline (13 agents)

Per the skill's Phase 3 step 0 (SPL-024/026): 12 per-batch pipeline agents (review→fix→verify
in own context, ≤3 iterations, auth/secrets/migration checklists as also_consider,
shared_pattern_note) + 1 cross-story agent (7-item structured queue). Verdicts:
`_bmad-output/workflow-state/qds-sprint-planning/v6/verdicts/*.json` (13 files).

| Batch | Iters | Converged | Applied (H/M/L) |
|---|---|---|---|
| Z1+Z2 | 2 | ✓ | 3/1/2 |
| M1.1+M2.1 | 2 | ✓ | 3/2/0 |
| M1.2+M1.3 | 2 | ✓ | 2/3/2 |
| A2+Z3 | 2 | ✓ | 1/3/0 |
| A3+J4 | 2 | ✓ | 1/3/2 |
| A1+M3.1 | 1 | ✓ | 2/1/0 |
| J1+J2 | 2 | ✓ | 1/4/1 |
| J3+A5 | 2 | ✓ | 2/4/0 |
| M2.2+M2.3 | 3 | ✓ | 5/6/3 |
| M3.2+G1 | 2 | ✓ | 2/4/0 |
| Z4+A6 | 2 | ✓ | 1/3/3 |
| Z5 | 2 | ✓ | 1/2/2 |
| cross-story | 1 | ✓ | 2/4/0 (queue 7/7) |

Layer-1 totals: **26 HIGH / 40 MEDIUM / 15 LOW applied in place.** All converged.

### Layer 2 — Wave-5 fresh-eyes verification (13 uncoupled verifiers)

Verifiers were NOT briefed with Layer-1 fix recipes (beginner's mind); verdicts/ and the
tracker were off-limits. The skill's "expect 30–50% additional findings" prediction was
**exceeded**: 13 verifiers returned **1 BLOCKER / 14 HIGH / 39 MEDIUM / ~49 LOW** — the
fix-coupled pipeline had structurally missed these (it verified its own fixes).

| Verifier | Stories | Findings |
|---|---|---|
| V1 | Z1+Z2 | 2H/2M/2L — fork-rev manifest provenance contradiction; Z2 post-merge trigger had NO substrate mechanism |
| V2 | M1.1+M2.1 | 1H/3M/4L — cross-bank probe would present the TENANT env key; MCP-era refusal vocabulary; DD-28.22 port memo missed |
| V3 | M1.2+M1.3 | 1H/3M/5L — **P2.8 mechanism unverified against 0.10.0** (RetainPayloadSchema lacks documentId/updateMode; silent-ignore → duplicates → hit-rate 0 at T2) |
| V4 | A2+Z3 | 1H/5M/3L — A2's workKey edit moves the image pin (run-record.ts is COPY-set; "transitively satisfied" false); FLEET_EXEC_TIMEOUT_MS fork-side; scripted:true misattributed |
| V5 | A3+J4 | 4M/6L — L9 cut-contract contradiction; compact applier misattributed to M2.3/DF1.11; [x] DoD boxes at spec time |
| V6 | A1+M3.1 | **1 BLOCKER**/2H/3M/1L — **`refresh` ∉ M2.1's closed AGENT_TOKEN_VERBS** (M3.1's own grant refused by M2.1's own negative control); dedup semantics docs-derived; A1 fence under-enumerates |
| V7 | J1+J2 | 4M/4L — `--unarm` ungated; demo would merge an ARMED chain in the shipped tree; duplicate-outcome join unspecified; **Wilson milestone arithmetic understated (~94.5% point agreement at n=200, not "≥88%")** |
| V8 | J3+A5 | 1H/2M/4L — dispatch.ts import-closure trap (static judgment import silently tolerated until a closure growth reds the box build); windowId tamper-alarm trip; money-field unit unpinned |
| V9 | M2.2+M2.3 | 2H/3M/2L — probe battery unconstructible (MEMGATE_ADMIN_KEY in no env list); **memory-key lifecycle fleet wiring owned by no story** |
| V10 | M3.2+G1 | 3H/1M/2L — chain-authored `policy:adr-2` row unimplementable (run-approval hop is walk-observed-only, no emitter); refresh-verb break confirmed from M3.2's side; M3.2 re-fire trips M1.2's tamper alarm by design |
| V11 | Z4+A6 | 1H/5M/4L — `fleet status --json` invalid invocation (fails on VPS day); A6 staleness check ordered AFTER reindex = structurally inert |
| V12 | Z5 | 1M/4L — 5 intra-swarmclaw relative-import consumers invisible to the story's greps (broken build for a dev following the enumeration) |
| V13 | cross-cut | 3M/8L — README stale dev sha; DD-15 P2.3 successor mislabeled; M3.2 status header vs yaml; contract doc lacked the fork: convention the checker cites |

### Layer 3 — Wave 5b/5c re-fix (11 agents, all findings applied) + adjudications

Parent-owned adjudications landed first as **register §8a DD-28.26** (12 items): refresh-verb
resolution (bot-held = `{consolidate}`; closed set NOT widened); `policy:adr-2` label home
(run-record approval state, the `system:timeout` precedent); P2.8 [VERIFY] + echo leg +
fallback; re-pin tree = M1.2+J3+J4+**A2**; M2.2 owns the fleet-wiring integration regions;
Z2 post-merge = existing `type:'http'` watch job (no union member, no contract bump); Z3 cap
derived; `scripted: true` framed as new; Z1 manifest provenance = timeline-bracketed rows;
fork-citation convention written into contract §0; A6 staleness-first ordering; DD-18 census
erratum (74 files / 78 lines).

11 fix agents (f1–f11, disjoint file sets) then applied every story-level finding —
**~103 findings, 0 unapplicable** (one placement note: V2-H1's probe-credential rule landed
in M2.1 AC2 + mirrored to M1.1 AC4, the actual probe owner). The consistency gate caught 4
citation drifts the fix wave introduced (2 ambiguous basenames, 1 past-EOF, 1 dup) — fixed
immediately; gate green again.

### Wave-5 round 2 — regression verification (3 scoped verifiers)

vr1 (memory cluster) · vr2 (Z/A cluster) · vr3 (J/G/M3 cluster) — regression-focused over
the fix-touched files. Result: recorded in the session log below.

## Session log

- 2026-10-02 Layer 1 complete (13 verdicts converged; cross-story queue 7/7).
- 2026-10-02 Wave 5 dispatched (13 uncoupled verifiers).
- 2026-10-02 Wave 5 results: 1B/14H/39M/49L. DD-28.26 (12 adjudications) written parent-side.
- 2026-10-02 Wave 5b/5c: 11 fix agents applied ~103 findings; 4 citation drifts caught by the
  consistency gate and fixed; gate green (65 stories / 250 pts; test 2/2).
- 2026-10-02 Wave-5 round 2 dispatched (vr1/vr2/vr3, regression-scoped).
- 2026-10-02 Round-2 results: 14 regression findings (R1 1H/2M/2L + R2 2M/3L + R3 1M/3L =
  1 HIGH / 5 MEDIUM / 8 LOW), ALL applied same-session (orchestrator-direct for the small ones;
  register amend DD-28.6 two-union accounting, DD-28.19 supersession marker, DD-28.4 gains
  QDS_MEMGATE_SIGNING_KEY, A6/J4/M3.2/J3/A2/M2.3/M1.1 story edits). Gate caught + fixed 5
  citation drifts across the two fix rounds (ambiguous basenames ×3, past-EOF ×1, dup ×1).
- 2026-10-02 CAMPAIGN CONVERGED: gate green (65 stories / 250 pts; story-consistency test
  2/2); detect_changes 0 affected symbols / 0 processes / risk LOW (docs-only + the
  no-caller checker).
- Operator-visible items carried to the wrap-up report: V7-M4 (J2 milestone arithmetic —
  the DD-21 operator pin must see the ~94.5%-at-n=200 joint effect), V6-B1 (refresh-verb
  adjudication), DD-28.26 passim.
