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

DF5.2 (PR #132, squash commit bf89d34) merged — the lights-on head's PR step. -> 21/31 stories, 84/123 pts. CI `check` was red at merge on the pre-existing stale-GitNexus-index job that reproduces on `main`; CodeRabbit was green. Unblocks DF5.3/DF5.4/DF5.5/DF6.1 on the DF5.2 edge only — all four still gate on DF3.4, which is NOT implemented. Cleanup owed: delete the demo repo biospark33/qds-df52-e2e (tracked as Quantum-Digital-Solutions/QDS-Factory#133).

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

# 2026-09-03 (DF2.10 DONE — the in-box arc's first story lands, and DF1.10 is now the keystone):
# (drained 2026-09-18 — this note had sat undrained in the yaml header past the 2026-09-10 and
# 2026-09-12 entries below; inserted at its chronological position. Text verbatim.)
# PR #207 merged to dev (34316dd) closing DF2.10 after review round 6 and a full live round — all 19 live
# e2e files green on f5290f, full suite 4995 pass / 0 fail, $0.0201 spend, zero box/key leaks. The pin did
# NOT move (sha256:92447929, buildId 3cf094fb6990ed66) and the image was deliberately not rebuilt, so
# tier2-image-contract's gate B stood as a clean control. THIS UNBLOCKS DF1.10: its deps were
# [DF1.1, DF1.4, DF1.6, DF2.5, DF2.10, DF3.1] and DF2.10 was the last one outstanding.
# DEPENDENCY STATE as of this note — only THREE stories are unblocked: DF1.10 (8pt), DF3.5 (2pt, already
# in review as PR #185) and DF5.3. DF1.10 alone gates the rest of the in-box restoration arc.
# SUPERSEDED 2026-09-08 — the point figures in this 2026-09-03 note are pre-review: DF5.3 is now 6
# (not 4), DF5.4 5 (not 3), DF5.5 3 (not 2), DF3.6 split into DF3.6a+DF3.6b (3+3), and DF6.1 split
# into DF6.1a (4) + DF6.1b (3) — DF6.1 no longer exists as an ID. The authoritative slate figures
# are the 2026-09-08 block below and the per-story rows; this note is retained as the 2026-09-03
# dependency-state record only. Sequencing DF1.10 next is what kept the arc moving, and it did.
# DF1.10 also owns four open issues that nothing else can close: #186 (re-pin bundle blocked on the
# deriveBuildId seam — the 508-line patch is banked at workflow-state/code-review/df2-10-r6/), #181 (in-box
# ack round trip), and #187/#188 which both need a real build. Note the ADR renumbering still applies:
# pre-2026-08-31 references to "DF1.10 owns the round trip" mean DF1.11.
# STALENESS FIXED IN THIS COMMIT: DF2.10 read in-review (merged 2026-09-03) and DF3.5 read ready-for-dev
# (PR #185 has been open since 2026-09-02, and is 35 commits behind dev). Both corrected against git
# history rather than against the story docs' own prose.

# 2026-09-10 (DF2.11 post-merge live round 6): the story's merged surface (PR #241 + #246 → dev f1683745)
# proven on real substrate in five legs, zero model spend — teardown lock busy/stale wording + destructive
# mark across a real exit (T1.6b/c), readonly ledger with a REAL crashed-WAL refusal then fresh-writer heal
# (T1.8; ledger-identity-changed documented not live-provable without an fs seam), A28 at-most-once timeout
# across REAL concurrent gate invocations (T1.7b), sweep continuation past a run-locked refusal with the
# deliberate exit-1 contract + 200-report prune ceiling (T3.4c/d/e), and BTP-5 (the round-5 deferred item)
# CLOSED per fixture. Enterprise-tenancy question settled empirically: the reaper's prefix defense held under
# real --yes sweeps (7 named non-factory account keys untouched; one orphaned sbx- key collected — by
# contract). Sixth image-pin adoption rode the round (gate B 50360fbb…/5561b2caeb34b2f0, healing green,
# mirror re-pushed). Findings filed: #247 (exeuntu base drift), #248 (bun sqlite same-process artifact).
# Full record: story §"Live E2E — round 6"; evidence _bmad-output/evidence/df3-e2e/2026-09-10-*.

# 2026-09-12 (DF2.13 IN-REVIEW — INV-CAP-1 enforced, DF3.6a UNBLOCKED from treating the chain as fact):
# mintRunKey now refuses capMicroUsd > defaultKeyCapMicroUsd with cap-invalid in the pre-mint ladder
# (src/providers/credentials.ts, before keyApi.createKey — every caller inherits it: dispatch,
# scripts/cap-hit-demo.ts, runCredentialLifecycle). The chain's TOP term
# residentSpendCeilingMicros <= capMicroUsd <= defaultKeyCapMicroUsd has an enforcement point that
# runs. DF3.6a MAY NOW IMPLEMENT against the chain: its loadResidentBounds can assert
# capMicroUsd <= defaultKeyCapMicroUsd as a property of the SYSTEM, not of the configuration. The
# lower term remains DF3.6a's own clamp (min(residentSpendCeilingMicros, limitMicroUsd)) — no test
# asserts an unconditional resident <= cap (legal near-exhaustion remainder mints below it).
# Negative-control evidence (red-on-unguarded-src): the AC4 tests failed exactly as the story's
# make-or-break demanded before the guard landed (ledger .unlazy/df2-13/GATES.md G8).
# Deviations recorded (story deviations 1-2 + review round 1): the story asked dispatch.ts's
# no-ceiling arm "recorded as reachable" — ground truth (verified in cost-ledger.ts admitIssue) is
# UNREACHABLE from dispatch on all paths (B1 bound + remainingMicroUsd > 0 gates + replay clamp);
# the DF2.13 comment addition instead documents the NEW downstream mint-time cap-invalid refusal,
# and that refusal is NOT a no-ceiling equivalent. no-ceiling fires before store.create (absent
# record; the orphan guard retires it after ADMISSION_GRACE_MS + ADMISSION_SKEW_MARGIN_MS ~6 min).
# The mint-time cap-invalid fires AFTER provisionAdmittedRun wrote an OPEN run record and created a
# LIVE BILLABLE box, and classifyReservation counts unclosed records (cost-ledger.ts closedAt ===
# undefined -> "count"), so the orphan guard never retires it — headroom returns only at teardown
# close (+ grace), the box bills until an operator tears the run down. Reachability: the knob is
# --cap-micro-usd (DispatchDeps.capMicroUsd) AND the config issue cap minus committed spend must
# also clear the backstop (the shipped 5_000_000 default binds below it: --cap-micro-usd
# 900_000_000 alone admits at 5M and mints fine). Observable: the refusal surfaces as the
# fleet.dispatch error line with payload.providerCode "cap-invalid" (exit 1, generic
# key-delivery-failed text; CredentialLifecycleError's message/remediation do not survive the
# catch) — not a no-ceiling exit-5 line. Details in the story's Dev Agent Record.

# 2026-09-13 (DF2.13 DONE — INV-CAP-1 lands with its entry points; the accepted stranded-box cost retired):
# (drained 2026-09-18. Text verbatim.)
# PR #254 merged to dev (8494999e) after PR review round 1 (7-reviewer adversarial pass, 14 patched,
# f96e7b53) and round 2 (3 coderabbit findings verified and applied, de552d7). INV-CAP-1 itself is
# unchanged: mintRunKey refuses capMicroUsd > defaultKeyCapMicroUsd pre-mint. Round 1's two deferred
# findings landed as unslotted follow-up DF2.14 (df2-14-cap-followups.md; eb802a6 + f6afc79):
# D1 — the keyCap bound is now enforced at EVERY entry (CLI --cap-micro-usd parse, fanout
# validatePatternInput's shared seam, dispatch B1 pre-admission; exit-2 invalid-cap with zero
# boxes/records/admissions), all derived from the imported constant, no numeric copy; the $1M CLI
# literal is gone and the AC4 stranding test was rewritten to the pre-admission refusal. D2 — the
# step-7 catch discriminates by CAPABILITY (structuredErrorParts: string .remediation AND .code), so
# a CredentialLifecycleError's message survives run-suffixed and its remediation is COMPOSED with the
# INV-5 line instead of being flattened to generic text. Issue caps stay unbounded — the gate's
# min(keyCap, remaining) absorbs them — and the mint guard remains the caller-agnostic last line.
# DF3.6a's standing grant is unchanged: it may implement against
# capMicroUsd <= defaultKeyCapMicroUsd as a property of the system (the lower chain term stays
# DF3.6a's own clamp, exactly as the drained 2026-09-12 note recorded — see sprint-status-history.md).
# Tenth image-pin adoption rode the merge: gate B run 34762465643 printed
# 31061f54…/a095d2629d5bcc09, walk digest 72d8d83b -> 0c5509f3, adoption commit d63f603 is the
# healing run (mirror re-push + verify-image-pin follow it).

# 2026-10-15 (G1 DONE — ADR-2 verdict recorded, decided shape merged to dev):
# Operator verdict ACCEPTED recorded in the ADR (clauses 1-4 as written; clause 5 verbatim, the
# veto-window queue named the blocking build item; DD-18 re-opened, DD-19 unchanged). Decided shape
# shipped: fail-closed src/fleet/auto-merge-policy.ts + adds-only run-completion consult (labeled
# policy:adr-2 mint), approval-gate.ts byte-identical; suites 79 policy / 12 chain arms / 71
# covering. 3 bmad-code-review rounds (88 findings triaged, 68 patched incl. every LOW in rounds
# 1-2), then CodeRabbit round 4 on PR #430: 2 findings verified and fixed (2e333746) — the atomic
# policy-mint guard (RunRecordStore.setApprovalIfAwaiting rechecks under the store's record lock,
# so a human decision landing across the reverify await wins the race by construction) and mint
# fault isolation (a store fault emits one auto-merge-approval-error line; the driven outcome and
# the gate's parked awaiting-approval stand). PR #430 merged to dev (merge 20e3a452).
