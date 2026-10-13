# A6 round-1 review — acceptance-auditor report

Reviewer: acceptance-auditor subagent (read-only, no authoring context).
Scope: story `_bmad-output/sprint-artifacts/dark-factory-v6/stories/a6-gitnexus-refresh-cron.md` (ACs, DoD, Observability Contract) audited against `git diff dev...HEAD` = a00f4958 + 9cb461e7 and the landed suite.
Method: acceptance-criteria trace — each AC/DoD bullet mapped to committed proof (test, gate evidence, or story text).

## Findings

- **AA-001 · MED · AC6 vs tests/gitnexus/refresh-cron.test.ts** — AC6 (no dispatch gating, output surface = stamp+alarm+log, zero src/ bytes) is the only AC with no committed test: its MUST-fail negative control rests on the driver's one-shot manual N4 git-diff scan and decays at merge.
  Fix: committed boundary test — walk `src/` and assert zero references to the refresh surface (`gitnexus-staleness` | `refresh-cron` | `INDEX_STALENESS` | `cli-version.json` | `refresh-cron.jsonl`); a future dispatch-path integration lands in src/ first and trips this. Verified zero hits today.

- **AA-002 · LOW · story Observability Contract vs AC2** — the story documents stage `'staleness'` but record-then-cure makes that value structurally unproducible; the wrapper header admits "documented-but-never-emitted"; story text and asserted behavior permanently disagree.
  Fix: story-text amendment at closure (driver-owned): AC2 mechanism clause + Observability Contract stage enum reconciled to the landed semantics (`stalenessAlarm {fired,ageHours,ceilingHours,stampPath}` on the cycle line; `result` stays success when the same cycle cures) with a dated amendment note. Behavior is correct per PLAN I2; this patches the story's truth, not the code.

- **AA-003 · LOW · story contract final sentence vs tests :563/:584/:675** — "missing or unparseable stamp reports stampAgeHours null with result failed" is contradicted by the cured-case tests (:563/:584 pin success + null) and matched only by the red-reindex arm (:675).
  Fix: same closure amendment: null age is recorded on any verdict; result reflects the cure outcome (failed only when a stage fails, e.g. red reindex).

- **AA-004 · LOW · DoD Security bullet vs .claude/skills/gitnexus-cli/SKILL.md** — the bullet enumerates paths that exclude the CLAUDE.md-mandated SKILL.md reindex-ritual refresh actually carried by the branch (+2 lines, chore 9cb461e7, PLAN C9a).
  Fix: closure amendment — DoD security bullet gains the disclosed exception (reindex-ritual skill refresh per repo CLAUDE.md upgrade ritual).

- **AA-005 · LOW · story Status header + .unlazy/a6/GATES.md** — story header still `ready-for-dev`; root GATES.md G1-G4 pending; branch fails its own C11/G3 closure contract at audit time (honestly tracked, not faked).
  Fix: already-planned closure work (C11/G3): story header to landed truth with review-round summary; root gates run after fixes land.

Verdict: all five are bookkeeping-vs-code splits; only AA-001 demands a committed artifact before the PR. No AC is left uncovered after the AA-001 test plus the closure amendments land.

## Round 2 (2026-10-13, scope: fix commit 91f171b2 + uncommitted story amendments)

AA2-001 · MED — the determinized coalesce fixture dropped AC5's holder-completes-under-contention proof (ordered [skip, success] assertion gone; a post-[d] fd release would pass every test); AA2-002/003 · LOW — story stage enum still omits crossCheck, amendment line refs stale; AA2-005 · LOW — triage.json invalid JSON; AA2-006/007 · LOW — tripwire regex token gaps, missing behavioral bun-probe test; AA2-004 · LOW — AA-005 Status-header gap (closure). The 6 round-1 tests otherwise pin their claims; story amendment sentences match landed tests. Full dispositions: round-2-triage.json.

## Round 3 (2026-10-13, scope: fix commit abe342c3 — round-2 diff)

Verdict: **CLEAN** — no findings. AC/DoD coverage re-traced against the round-2 diff: the two MED patches (EH2-001/BH2-003 split-brain coherence arm; AA2-001 holder-completes-under-contention fixture) land committed tests that strengthen, not weaken, AC3/AC5 pins; the story amendment blockquote now names rounds 1+2 with test-title-primary citations; the only open item remains AA-005/AA2-004 (Status header → landed truth), dispositioned CLOSURE and executed in the closure commit per plan.
