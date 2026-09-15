# Wave 18 — Verifier E — DF5.5 KEEP-Repoint Chore (df5-5-keep-repoint-chore.md)

**Verdict: CONVERGED** (zero BLOCKER, zero HIGH, zero C2, zero C3; C1-LOW ×1 + C4-LOW ×7 residue) — confidence **high**.

## Method

Read the story end to end. Reviewed the working tree as-is (branch dev @ 4264f546 + uncommitted spec edits).
No prior review material, trackers, HANDOFFs, seam-ownership dir, wave/verify/scan reports, or fix recipes read.
Every anchor the story names was opened at source. Every zero-match claim was run with a positive control on
identical machinery (listed below). No file was edited except this report. No `bun test` run (the story's test
file does not exist yet — verified); all verification was grep/sed/byte-scan, captured to /tmp/w18e-*.txt.

### Repoint-anchor reads (cross-story, sanctioned)

- Occurrence table rows at source: `p1-2:26`, `p1-3:{22,24,39,46,138,142,147,154,155}`, `p1-7:26`,
  `p1-9:{17,25,29,36}`, `p1-11:{25,44,48,51}`, `p1-12:{25,31,39}`, `p1-14:{24,26,29,30,37,40}`,
  `p1-18:{17,23,25,36,50}`, `p0-9:{198,218}`, `p0-7:{55,136}`; section headers of p1-3, p1-12, p1-11,
  p1-18, p1-9, p1-14, p0-7, p0-9.
- Named citations: `sprint-status.yaml` (KEEP rows by story key; meta block; P1.18 row),
  `2026-08-11-v5-story-derivation-decisions.md` (§1 `:23`, §4 `:55–60`, DD-2 `:47`, DD-2a `:48`, DD-7 `:53`,
  DD-8 `:86`), `2026-08-11-story-disposition-audit.md` (`:24` allowance, P1.9/P1.11/P1.14 rows `:90/:92/:95`,
  P0.4 row `:53`, RETIRE summary `:133`), R5 `:89`, `p0-3-mixed-model-demo.md:126`, `p0-4-hard-guard-kill.md:39`,
  `df2-10:{106,173}`, `df1-10:{91,143}`, `df2-3-credential-lifecycle.md:{123,128,218}`,
  `df6-1a:{54,55,163,166}`, `df6-1b:{121,190,314,316,324}`, `df2-8` (`qds cost`, `5,000,000 µ$`),
  epics index (DF5.5 row, DF2.13/DF2.8 counts), `2026-08-31-tier2-placement-adr.md` (Status: ACCEPTED 2026-08-31).
- Symbols: `src/providers/credentials.ts:69` (corrected docstring) and `:294` (`deps.capMicroUsd ?? defaultKeyCapMicroUsd`),
  `scripts/cap-hit-demo.ts:98–99`, `scripts/lib/run-lock.ts` (NUL scan), `tests/scripts/` listing.

### Positive controls (machinery identical to each zero-claim)

- AC1 grep over the 12 files (pre-dev): 28 lines — proves the pattern matches; same pattern returned zero for
  `p0-5` and `p1-5` (exit 1).
- Retired-ID sweep: 6 distinct IDs (P1.1×26, P1.6×8, P1.8×1, P1.13×2, P1.15×3, P1.19×1) across exactly the
  table's 10 files; P1.4/P1.10/P1.16/P1.17 zero anywhere in the 12 files.
- `grep -c 'exitStatus'` → 0 in p1-11, p1-14, p1-9; positive control: matches in p0-3, p1-8, df5-2, df6-1a, etc.
- 4-value enum sweep: exactly one hit (`p0-4:39`) across phase-0/phase-1/dark-factory-v5 story dirs (the only
  other matches are the story's own quotes).
- `loadResidentBounds` → 0 in df2-3; positive: df3-6a:39, credentials.ts:69, df2-13.
- DF3.6/DF2.11/DF2.12/DF2.13 → 0 in the 12 files; positive: hits across the DF corpus.
- yaml `deps:` retired-ID grep → 7 lines, **all** `superseded` rows (P1.6/P1.8/P1.10/P1.13/P1.15/P1.16/P1.17),
  zero KEEP rows; the match itself is the machinery positive control.
- Marker grep scoped to the two story dirs → 0 paths pre-dev (pattern positive: 17 in this story file).
- Epics doc: marker 0 (positive: DF2.13=1, DF2.8=16 by `grep -c`); `src/protocol/phase-executor.ts` absent
  (positive: `ls` of sibling paths); `df6-1-pr-feedback-fix-loop.md` deleted; `tests/scripts/keep-repoints.test.ts`
  absent (positive: license-sweep.test.ts, roster-check.test.ts present); run-lock.ts zero NUL bytes via
  `tr -d -c '\0' | wc -c` (positive control file with one NUL scanned → 1; note a naive
  `grep -c $'\x00'` false-positives on every line — the exact trap the story's guard note describes).

## Findings

| ID | Class | Sev | Anchor | Finding |
|---|---|---|---|---|
| W18E-1 | C1 | LOW | §E2E Slice self-count | "verified 2026-09-13: 12 occurrences here" — current text carries **17** (line- and occurrence-count agree). Stale dated claim; the conclusion it supports (unscoped grep > 11) is unaffected and strengthened, and "zero in the epics doc" verified. |
| W18E-2 | C4 | LOW | §E2E Slice final sentence | "Every marker this chore writes lands inside those two directories" is literally false in its own paragraph: the regression test this chore creates will carry the literal marker outside both dirs, and the amendment log lives in this story file, outside them. The operative clause ("no amendment edits a file outside them") is true, and the grep math two sentences earlier is correct. |
| W18E-3 | C4 | LOW | Amendment A table vs DoD Contract | The three provenance rows (`p0-9:218`, `p0-7:55`, `p1-3:142`) prescribe only `(now DF3.1)`; the marker duty on those same touched lines lives only in the DoD Contract/Test items. A dev editing from the table alone could produce three marker-less touched lines — caught at DoD review, no executable gate breaks (form (a) classifies them; marker set is file-level). |
| W18E-4 | C4 | LOW | P1.18 disposition vs A-table p1-18 row | The A-table says `:17`/`:23` are "repoint … never bare"; the blockquote's last clause says "the references are annotated for provenance, not revived as a contract". Two treatments named for the same lines; both branches pass every gate and classify ((d) with appended marker, or (a)). |
| W18E-5 | C4 | LOW | AC1 preamble | "Given amendments A–E" includes the retired E and omits F and G; AC4 correctly says "A, C, D and F". One stale set label. |
| W18E-6 | C4 | LOW | Re-estimate note | "five live amendment families plus one retired" — seven lettered families exist (A–G); partitions yield 4+3 (apply vs record/verify/retired) or 6+1, never 5+1. Rhetorical arithmetic; no gate depends on it. |
| W18E-7 | C4 | LOW | Amendment A closing paragraph | "p0-9 and p0-7 are the two phase-0 files carrying retired IDs" holds only scoped to the 12 in-scope files (the preceding sentence's scope); a whole-directory sweep also hits p0-3 and p0-4 (both RETIRE, correctly out of scope). |
| W18E-8 | C4 | LOW | DoD Test item (1) sanctioned forms; A-table p1-11/p1-12 rows | Form (c) ("the header blockquote whose marker names the repoint") is span-scoped: the p1-3 blockquote's continuation lines carry P1.1 with none of the four forms literally on their own line, so a strictly per-line implementation false-fails (safe direction; AC1's grep is unaffected since those lines carry DF3.1). Also "the path is also amended" (p1-11:51 / p1-12:39 rows) prescribes no replacement path — resolvable only as "amended by F's blockquote reading". |

## What HELD (load-bearing set, all verified at source)

- **Occurrence table complete and exact.** Independent `grep -rnE` over the 12 files reproduced all 26 cited
  lines with the stated per-line multipliers; p1-3 = 19 `P1.1` on 8 lines + 1 `P1.6` (L46); exactly 6 distinct
  retired IDs; P1.4/P1.10/P1.16/P1.17 absent; `p0-5` and `p1-5` zero hits. "Ten carry retired IDs, p1-5
  boundary-only, union eleven" holds.
- **Every repoint target resolves.** All canonical-set files exist under `dark-factory-v5/stories/`
  (DF1.3, DF1.5, DF1.6, DF1.8, DF2.8, DF3.1, DF5.2, DF5.3, DF1.10, DF2.10, DF6.1a, DF6.1b); `df6-1` deleted.
- **INV-1 geometry exact.** Headers confirm `p1-3:39` (AC block), `p1-3:154/:155` (DoD), `p1-12:31` (AC),
  `p1-11:48` (Technical Notes, headers 27/37/55 as quoted), `p1-18:50` inside `## Security Invariants`
  (headers 47/53 as quoted); `p1-9`'s only retired-ID hit is `:25`; p0-9:198/:218 and p0-7:55/:136 sit in
  non-governed blocks.
- **Amendment B/C-erratum verified.** `exitStatus` zero in p1-11/p1-14/p1-9 (positives elsewhere); p1-11:44 is
  the REST transport table row; p1-14:29 blank; exactly one 4-value listing corpus-wide (p0-4:39) and P0.4 is
  RETIRE (audit `:53`, RETIRE summary `:133` = exactly P0.1/P0.4/P0.8); `costCents` at p1-14:30/37/40 with
  DF2.8 restating 5,000,000 µ$ and `qds cost`; the three DD-8-class drifts are real (audit `:90/:92/:95`).
- **Amendment E re-verification exact.** Operator-corrected `≤` chain live at df2-3:123/:218; strict-`<` chain
  survives only as quoted blockquote history (:128); `loadResidentBounds` zero in df2-3, present in df3-6a and
  the corrected credentials.ts docstring; `mintRunKey` takes `deps.capMicroUsd ?? defaultKeyCapMicroUsd`
  (credentials.ts:294); cap-hit-demo.ts:98 "Inner control: run budget cap (artifact field only)".
- **Amendment G fully in place.** Six written arrays + P1.18's seventh exactly as tabulated; all eight
  discharged comments present; P1.9 union clause present; P1.18 row carries UNSCHEDULED + both severances +
  the retraction and the W14 three-invocation re-correction matching the story's description
  (`headRefOid` before/after, `gh pr checks --required`, statusCheckRollup negative-only).
- **P1.18 hand-off anchors real.** df6-1a:163 "P1.18 is not a predecessor — the *comment-read* limb";
  df6-1b:121 "the *verdict* limb"; df6-1b:190/:316 webhook exclusions; df6-1a:54–55/:166 `botComments[]`
  shape citing `p1-18:36`, whose Contracts/Schema line carries `botComments: [{ commentId, author,
  bodySnippet, timestamp }]` verbatim; DD-2 `:47` strikethrough; DD-2a `:48` DECIDED 2026-09-08.
- **Amendment F premises hold.** register §1 `:23` names `src/phase-engine/*`; `src/protocol/phase-executor.ts`
  does not exist; ADR Status: ACCEPTED 2026-08-31; its additions (DF2.10/DF1.10/DF1.11/DF3.7/DF3.8, DF3.6
  re-sequence per yaml) invalidate none of DF3.1/DF1.6/DF1.8/DF2.8/DF5.2.
- **Assertion machinery executable.** All four assertions specified with repo-root-from-`import.meta.dir`,
  count-based scan, table-driven per-pair, deep-equal marker set + yaml markerless negative, yaml scan; the
  slate-recompute DoD is executable (meta block carries DF totals 42/169, recounted 2026-09-14, with
  reconciliation arithmetic). Every negative control has a defined failure home (review-time for the
  provenance fixture; assertion 2 for wrong-successor; assertion 1 for multi-occurrence lines; AC4 halt for
  missing successor; "unproven, never clean" for unreadable files; stop-and-fix for meta mismatch).
  Every prescribed insert/replacement text carries the literal marker (p1-2 gloss, p1-3 and p1-18 blockquotes,
  p1-9:25 replacement, amendment C/D/F blockquotes, the `p1-18:50` fallback), and bare-repoint lines get
  markers via the W14E-2 append rule; every prescribed artifact classifies under at least one sanctioned form.
- **Trigger-surface verification claims reproduce**: epics DF2.13=1, DF2.8=16 (`grep -c`), epics marker 0,
  epics carries the DF5.5 KEEP row; test home exists (license-sweep/roster-check); run-lock.ts zero NULs.

## Summary counts

| | BLOCKER | HIGH | MEDIUM | LOW |
|---|---|---|---|---|
| C1 citation rot | 0 | 0 | 0 | 1 (W18E-1) |
| C2 semantic | 0 | 0 | 0 | 0 |
| C3 structural | 0 | 0 | 0 | 0 |
| C4 marginal wording | 0 | 0 | 0 | 7 (W18E-2 … W18E-8) |

**Verdict: CONVERGED. Confidence: high.** No BLOCKER, no HIGH, no C2, no C3. The story's repoint set is
complete against independent grep, every cited anchor opens, the marker machinery is coherent, and the DoD is
executable as written. Residue is C1-LOW ×1 (stale self-count, conclusion unaffected) and C4 wording polish.
