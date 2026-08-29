# Sprint-status header history

Superseded header notes drained from `sprint-status.yaml` (F090, 2026-08-28). The yaml now
carries current state plus its newest note only; everything below is the record of how that
state was reached, oldest first.<br />
**Every tally stated below is superseded** — each later entry corrects the one before it, and
the current tally lives in `sprint-status.yaml`.<br />
No status value was changed by this drain; only comment lines moved. Entry text is verbatim,
so relative references ("the backlog is below", "the line below") point at `sprint-status.yaml`,
not at this file.

---

## 2026-08-11

Dark Factory v5 derivation: the phase-1 superstructure is SUPERSEDED per the F14 disposition audit (docs/superpowers/specs/2026-08-11-story-disposition-audit.md). The new DF backlog is below (epics df1-df6); derivation decisions live in docs/superpowers/specs/2026-08-11-v5-story-derivation-decisions.md.

## 2026-08-18

v5-S1 COMPLETE — all 12 S1-tagged stories / 48 pts merged (last two: DF2.5 PR #115, DF1.6 PR #116). DF backlog done-to-date at that point: 13/31 stories, 53/123 pts.

## 2026-08-22

DF4.1 (PR #124) and DF4.2 (PR #126) merged, and DF2.8's stale ready-for-dev corrected (PR #121 merged 2026-08-21) -> 19/31 stories, 76/123 pts.

## 2026-08-23

DF4.2 follow-up PR #127 (878b66c) merged — test-quality only, no scope or points change. It closes four CodeRabbit REVIEW-BODY findings from PR #126 that the PR monitor never dispositioned (it polled only inline + issue comments). Tally unchanged: 19/31 stories, 76/123 pts.

## 2026-08-24

DF5.1 (PR #130, merge commit 486a40a) merged — the first DF5 story and the lights-on head's re-verify gate. -> 20/31 stories, 80/123 pts. DF5.2 is now unblocked on the DF5.1 side (it still reads the ReverifyReport contract in src/reverify/report.ts).

## 2026-08-25

DF3 TIER-2 live e2e CLOSED GREEN on PR #128's branch at 4804765 (merge of main + F11 IFS root-cause + F14 gate-D image drift + commitSha stamping + F15 fan-out budget pre-flight). Dispatch→gate(A-E)→engine(seeded-fix, real model spend)→harvest→teardown proven end-to-end; both best-of-n arms ready through full gates; advisory rank proven over a real record. Session spend ≈ $0.05 against $0.66 worst-case approval. Fleet money path is demo-ready; race/reapRuns/many-stories remain unproven-live (T3). Report: _bmad-output/workflow-state/code-review/e2e-audit/e2e-run-report.md §TIER-2 FINAL.

## 2026-08-26

DF5.2 (PR #132, squash commit bf89d34) merged — the lights-on head's PR step. -> 21/31 stories, 84/123 pts. CI `check` was red at merge on the pre-existing stale-GitNexus-index job that reproduces on `main`; CodeRabbit was green. Unblocks DF5.3/DF5.4/DF5.5/DF6.1 on the DF5.2 edge only — all four still gate on DF3.4, which is NOT implemented. Cleanup owed: delete the demo repo biospark33/qds-df52-e2e (tracked as biospark33/QDS-Factory#133).

## 2026-08-26 (artifact audit)

cross-checked every DF line against git log + PR history and found two drifts, corrected here. (a) DF3.1 had stayed at `review` although PR #123 merged 2026-08-23 (f1aa4db) and its round-10 follow-up PR #131 merged 2026-08-25 (6caffdb) — neither merge was ever recorded on the DF3.1 line, whose note froze at "in review 2026-08-22 / round 9". DF3.1 is now done. (b) DF3.2 had stayed at `ready-for-dev` although PR #128 (feature/df3-2-fanout-best-of-n, 56 commits, opened 2026-08-24) is open and under active review; it is now in-progress. Corrected tally: 22/31 stories, 89/123 pts — every earlier header line above (2026-08-24, 2026-08-26) states a total that excluded DF3.1's 5 pts and is superseded by this one. Story-file status stamps were re-stamped in the same pass (df3-1, df3-2, df2-4, df2-6, df2-8, df5-1, df1-2, df1-6, df1-8) — those files had lagged the yaml, not the other way round.
