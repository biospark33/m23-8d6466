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

## 2026-08-27 (post-merge reconciliation)

DF3.2 PR #128 MERGED 2026-08-26 (307cc16) — the line below stayed at `review` past its own merge, the same drift the 2026-08-26 audit caught on DF3.1; now done. Also recorded: DF3.1's review round 11 (post-merge re-audit of PR #123 vs current main, 130 findings, branch fix/df3-1-review-round-11) merged as PR #134 (db271dc) after a CodeRabbit/Gemini round over the fix branch itself (24 findings, all fixed, commit 8fb156b). Corrected tally: 23/31 stories, 93/123 pts.

## 2026-08-29

# 2026-08-29 (tech-debt wave 0 merged): PR #141 MERGED into `dev` (squash cc9fd18) — the first of
# the ten stacked tech-debt remediation waves. It closes F016/F087/F085 (README module table and
# three stale claims; .qds-config.yml pointed at visualizer/), F012 (ten undocumented env vars
# added to .env.example, OPENROUTER_PROVISIONING_KEY first) and F090 — F090's fix being the drain
# that created sprint-status-history.md and reduced this header to current state plus one note.
# No DF story status or points change: the tech-debt waves are not DF backlog items. Tally
# unchanged at 23/31 stories, 93/123 pts.<br />
# Two consequences worth recording. (a) The whole stack was retargeted from `main` to `dev` per
# CLAUDE.md's integration-base rule; main and dev differed only in .github/workflows/ci.yml, so
# the retarget was content-neutral. (b) Squash-merging #141 orphaned the stack's shared history:
# PR #147 went CONFLICTING until its six commits were replayed onto dev (git rebase --onto,
# force-pushed as 4cd8e06). Every later wave will need the same replay as its parent merges.
# CI was red at merge for a GitHub Actions BILLING lapse — jobs never start — not for anything in
# the diff; CodeRabbit reviewed and verified both fix rounds green.

# 2026-08-31 (in-box restoration arc chartered): ADR docs/superpowers/specs/2026-08-31-tier2-placement-adr.md
# ACCEPTED (PR #182, squash 82346d0). Three forensic audits + a live box-environment probe established the
# host-side tier-2 placement shipped by DF3.3 as a silent, unratified deviation from design D4/§5.1, resting
# on unmeasured substrate premises (bun had NEVER been probed on a box — the "verified live" memory record was
# a fabricated citation; systemd IS PID 1 with units restarting at boot; /run/steering IS wiped by a real
# reboot, first actual measurement). Unwound via five new v5-S3 stories: DF2.10 factory-owned boot image,
# DF1.10 in-box phase engine, DF1.11 in-box steering executor (closes #180/#181), DF3.7 approval-gate bridge
# (run-completion marker — the engine never called the gate; R9 correction carried as its Deviation 1),
# DF3.8 host-side completion watcher (operator-chartered at the review gate to make "runs survive host
# disconnect" true). All five converged through per-story adversarial pipelines (0 HIGH) + a cross-story
# consistency pass. DF3.6 re-sequenced S2->S3; drift fixed in separate commits (DF3.4 done, DF6.2 line added).
# RENUMBERING: pre-2026-08-31 references to "DF1.10 owns the round trip" mean DF1.11 now.<br />
# CAPACITY WARNING: v5-S3 goes 25 -> 56 pts / 13 stories — the heaviest band in the plan, more than doubled
# by the arc. Stated here rather than discovered at standup.
