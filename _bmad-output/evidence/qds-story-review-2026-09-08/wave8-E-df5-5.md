# Wave 8 / Round 3 — Independent convergence verifier E — DF5.5 (KEEP-repoint chore)

Branch `feature/wave7-seam-ownership-rework`, working tree as found (spec edits uncommitted; all
artifacts read from disk as they are). Fresh eyes: no prior wave/tracker input was read.
Method: every artifact, row, grep and count the story names was re-run/recomputed at source.
Read-only; no file modified. Every zero-match assertion below carries a positive control on the
same file; a failed control is reported as UNPROVEN, never clean.

---

## Verified CORRECT (recomputed at source, 2026-09-13)

1. **Amendment-A occurrence table — exact.** `grep -onE 'P1\.(1|4|6|8|10|13|15|16|17|19)\b'` over
   the 12 in-scope files reproduces every row: p1-2:26; p1-3 at 22(×3)/24(×5)/39/46(P1.6)/138(×3)/
   142/147(×3)/154(×2)/155; p1-7:26; p1-9:25 (only hit); p1-11:25/48/51; p1-12:25/31/39;
   p1-14:24/26; p1-18:17/23/25/50; p0-9:198/218; p0-7:55(×1)/136(×3). `grep -oE 'P1\.1\b' p1-3 |
   wc -l` → **19**, across 8 lines (22,24,39,138,142,147,154,155) — the story's 18-repointed +
   1-provenance (":142") split is arithmetically exact. Total occurrence **lines** = 28, matching
   the re-estimate note's "28 mechanical substitutions" (per-line, pre-recount).
2. **File-set arithmetic.** 12 in-scope files exist; 10 carry retired IDs; p1-5 boundary-only and
   p0-5 zero-hit — both zero-hit claims proven with positive controls (H1 present in each;
   `grep -cE 'P1\.(1|…)\b'` → 0, H1 control → 1). Python byte-scan: 0 NUL / 0 control bytes in all
   12 files. Union = 11 amended files = the Files-to-Modify list = the marker set.
3. **Marker literals.** `grep -c 'v5 amendment (DF5.5)'` on this story file → **12** (matches the
   story's "12 occurrences here"); on the epics index → **0** (matches "zero in the epics doc");
   on `sprint-status.yaml` → 0 (the assertion the marker count depends on).
4. **sprint-status.yaml KEEP rows (amendment G) — all present, by story key.** P1.2 `[DF3.1]`,
   P1.7 `[P0.6, DF1.6]`, P1.9 `[DF1.6, DF1.8]` + the exact discharge clause "P1.8 question resolved
   by DF5.5: both edges retained as DF1.6 + DF1.8", P1.11 `[P0.9, DF1.6]`, P1.12 `[P0.9, DF1.6]`,
   P1.14 `[P1.5, DF2.8]`, P1.18 `[DF5.2]` (its row records the another-hand application and the
   p1-18:50 hand-off to DF6.1a's wave). P1.3 `[P1.2, P0.9]` and P1.5 `[P0.9, P0.10]` carry the
   comment with no retired ID. Comment rows carrying the literal `deps repointed by DF5.5` → 8
   (P1.18's row is not one of them — consistent with its "applied by another hand" table note).
   DoD's "seven `deps:` arrays and all eight discharged comments" verifies exactly.
5. **AC1 bullet 3 (yaml scan) — currently clean.** `grep -nE 'deps: \[[^]]*P1\.(1|4|6|8|10|13|15|
   16|17|19)\b'` returns 7 rows, every one a `superseded` row (P1.6/P1.8/P1.10/P1.13/P1.15/P1.16/
   P1.17) — zero KEEP-story rows, exactly the story's invariant. Positive control: the same pattern
   family matches (the 7 returned rows are the proof the file is greppable).
6. **Slate arithmetic (meta block) — reconciles against per-story rows.** Recompute: 42 stories /
   169 pts; per-epic df1 45 / df2 48 / df3 35 / df4 10 / df5 22 / df6 9; done 33/42 = 134 pts;
   nine not-done (DF3.6a 3, DF3.6b 3, DF3.7 4, DF3.8 4, DF5.3 6, DF5.4 5, DF5.5 3, DF6.1a 4,
   DF6.1b 3) = 35 pts, 169−35 = 134. The meta block's 2026-09-08 block states exactly these
   figures. DF5.5 row: 3 pts, v5-S3, `deps: [DF1.3, DF1.5, DF1.6, DF1.8, DF2.8, DF3.1, DF5.2,
   DF5.3, DF6.1a]` — DF6.1a present as the story asserts ("scheduling edge, not successor-set
   member"). DF1.10 and DF2.10 both `done`. DF5.3 `ready-for-dev` as the gate says.
7. **Canonical successor set resolves (AC4).** All ten IDs the amendments write (DF1.3, DF1.5,
   DF1.6, DF1.8, DF2.8, DF3.1, DF5.2, DF5.3, DF1.10, DF2.10) resolve to existing files under
   `dark-factory-v5/stories/`; DF6.1a/DF6.1b files exist; `df6-1-pr-feedback-fix-loop.md` is gone.
8. **Spec/register citations.** Audit `:24` KEEP-amendment allowance verbatim (with ellipses);
   audit §2 heading is "The 30-row disposition table" and the table has exactly 30 story rows;
   audit rows 92/95 are the two 4-value-enum instructions (p1-11:44, p1-14:29); audit P0.4 row
   RETIRE and summary "RETIRE | 3 | P0.1, P0.4, P0.8"; P0.5/P0.9 rows KEEP; P0.7 DONE-KEEP.
   Register `:23` module roots (`src/phase-engine/*`), `:47` DD-2 with struck-through "P1.18
   (KEEP) repoints to DF6.1", `:48` DD-2a (DECIDED 2026-09-08; DF6.1 split, dangling ID, p1-18:50
   owned by DF6.1a's wave), §4 boundary contracts DF1.3↔P1.9 and DF1.5↔P1.5 (both ending "DF5.5
   amends …'s text"), DD-7 (role line lands via DF5.5; P0.7 frozen), DD-9 (µ$; DF2.8 restates
   5,000,000 µ$). Register §4's "keyed on the exitStatus enum" wording is present, exactly as the
   amendment-C erratum says. R5 §1.5 `:89` row matches the quoted stale text verbatim
   (`… 2 enum citation fixes + 3 boundary amendments | 2 |`); R5 §5.2 and §5.4 exist and match
   their roles.
9. **Amendment B — reproduced.** `exitStatus` count = 0 in p1-11, p1-14 and p1-9 (H1 positive
   control = 1 in each). p1-11:44 is a Hindsight REST recall transport table row; p1-14:29 is
   blank. Corpus `exit_class` 4-value listing: exactly one, at p0-4:39
   (`success | transient | overflow | logic`), P0.4 RETIRE. `costCents` at p1-14:30 (AC1)/37/40.
10. **Amendment C — reproduced.** p1-9:17 "three categories", AC1 `:29` `transient | overflow |
    logic`, contract `:36` `FailureClass = 'transient' | 'overflow' | 'logic'` over a
    `FailureSignal`; p0-3:126 CC-1 five-value enum; DF2.10 `Restart=no` at df2-10:106/173 (with
    `qds-run@.service`); DF1.10 reclaim semantics at df1-10:91/143. Insertion points verified
    outside governed blocks: p1-9 dependency-edges `:25`, AC starts `:27`; p1-5 dependency-edges
    `:26`, AC starts `:28`.
11. **Amendment D / DD-7.** DF2.8 shipped `qds cost` as a CLI surface, done 2026-08-21 (yaml row +
    df2-8 story Trigger Surface). p0-7:55 is a `//` comment in an illustrative snippet; p0-7:136
    carries exactly three `P1.1` mentions in the downstream-contract paragraph; both sit in
    Technical Notes (`:40–:162`), outside AC (28–39) / INV (176–194) / DoD (222–259).
12. **Amendment F — reproduced.** p1-11:51 and p1-12:39 both name `src/protocol/phase-executor.ts`
    and gloss it as a P1.6 artifact; that path does not exist (`ls` → No such file);
    `src/phase-engine/` exists; register §1 `:23` puts new engine code there. Both files are in the
    11-path marker set.
13. **P1.18 disposition.** p1-18 headers `47:## Security Invariants`, `53:## Definition of Done`;
    `:50` is INV-2 and still reads "(P1.19)" unannotated (correct pre-apply state — the hand-off
    belongs to DF6.1a's wave); `:36` carries `botComments: [{ commentId, author, bodySnippet,
    timestamp }]`. The search anchors resolve: DF6.1a "P1.18 is not a predecessor — the
    *comment-read* limb" and DF6.1b "…the *verdict* limb" (both verbatim; see W8-E-6 for the line
    numbers), plus DF6.1b's webhook exclusion ("Inbound webhooks … out of scope for v5.0") and
    Trigger Surface row. The yaml P1.18 row carries the two-half denial and the retraction note;
    the retracted "polls gh pr checks" string survives only inside the correction text.
14. **INV-1 block geometry.** p1-3:39 = AC4 (AC block `:34–:43`); p1-3:154/155 in DoD (`:152+`);
    p1-12:31 = AC3 (AC `:27–:34`); p1-11:48 in Technical Notes (`:37–:54`), headers exactly
    `27:## Acceptance Criteria`, `37:## Technical Notes`, `55:## Files to Modify` as the story
    states.
15. **Slate-sweep negatives — both hold, with controls.** Zero hits for `DF3.6|residentSpend-
    CeilingMicros|runBudgetCapMicros` and for `DF2.1[123]` across the 12 files; positive control
    (`Hindsight`) hits 4 of them, so the files are provably greppable. The six retired IDs present
    are exactly P1.1/P1.6/P1.8/P1.13/P1.15/P1.19; P1.4/P1.10/P1.16/P1.17 appear nowhere in the 12.
16. **Epics index — current as the Trigger Surface claims.** `DF2.13` → 1, `DF2.8` → 16 (both as
    stated); the DF5.5 entry mirrors this story: Depends-on row identical to the yaml, make-or-break
    carries "After amendments A–F" and all three greps including the yaml scan; the index's KEEP(11)
    row lists exactly the story's 11 KEEP files plus P0.7 separately as DONE-KEEP.
17. **Infra prerequisites.** `tests/scripts/license-sweep.test.ts` and `roster-check.test.ts` exist;
    `tests/scripts/` is the existing home for repo-hygiene checks as claimed. AC1's raw grep
    currently returns 28 lines (pre-apply state), none annotated — consistent with the story's
    before/after model.
18. **p1-3 anchors.** `:22` contains "/api/a2a does not exist in source today"; "the A2A delegation
    layer (P1.1)" appears verbatim at `:24`; `p1-3:142` and `p0-9:218` provenance quotes match the
    story's quotations character-for-character; `p1-2:26` matches the quoted gloss line exactly.
19. **AC4-vs-DoD slate wording examined:** AC4 "read from the meta block rather than hardcoded" and
    the DoD "recomputed, never trusted" are complementary (the count's source is the yaml; the meta
    block is cross-checked against the recompute, stop on mismatch). No contradiction.

---

## Findings

### W8-E-1 — INV-1's in-block-edit count is contradicted by AC2 and the re-estimate note
- **Severity:** MEDIUM · **Category:** C3-structural
- **Anchor:** DF5.5 §Acceptance Criteria AC2 ("The five in-block edits INV-1 admits are all in
  *other* files (`p1-3`, `p1-11`, `p1-12`)") and §Story header re-estimate note ("the five in-block
  edits INV-1 now admits") vs §Security Invariants INV-1 ("The **four** known in-block edits are
  `p1-3:39` … `p1-3:154` … `p1-3:155` … `p1-12:31` … **Any fifth in-block hunk is a rejection on
  sight**") and §Definition of Done Security item ("The **four** admitted in-block edits").
- **Failure scenario:** INV-1 was corrected on 2026-09-08 to move `p1-11:48` out of the governed
  count ("not a governed-block edit; counted separately, verified 2026-09-08") — INV-1 and DoD now
  say four — but AC2 and the re-estimate note still say "five" and still list `p1-11` among the
  files holding in-block edits. A dev reviewing the diff under AC2's number admits a fifth hunk
  that INV-1's tripwire rejects on sight; a reviewer counting to four reads AC2 and cannot tell
  which of the two enumerations is binding. Both numbers sit in the same file with no pointer
  between them.
- **Evidence:** AC2/§Story lines 12 and 158 vs INV-1 line 538-545 and DoD line 595-600 (as read in
  this session); p1-11 headers put `:48` in `## Technical Notes` (37–54), so four is correct and
  "five … (`p1-3`, `p1-11`, `p1-12`)" is the pre-correction text.

### W8-E-2 — Amendment E's "already-satisfied" verification no longer matches `df2-3`
- **Severity:** MEDIUM · **Category:** C2-semantic
- **Anchor:** DF5.5 §Technical Notes, Amendment E — "Verified 2026-08-12: **df2-3 already carries
  DF3.6's strict chain verbatim** — `residentSpendCeilingMicros < runBudgetCapMicros ≤
  defaultKeyCapMicroUsd`, with DF3.6's `loadResidentBounds` named in the same paragraph as its
  single owner".
- **Failure scenario:** a later commit (the DF2.13/DF3.6a operator-ruling correction, cited inside
  df2-3 itself) rewrote that paragraph. Today df2-3's live chain is the corrected
  `residentSpendCeilingMicros ≤ capMicroUsd (mint-time, per run) ≤ defaultKeyCapMicroUsd`; the old
  chain survives only inside the correction blockquote as a quotation of what the bullet
  "previously read"; `loadResidentBounds` occurs **zero** times in df2-3 (positive control:
  `residentSpendCeilingMicros` hits the file repeatedly; the symbol itself lives in df3-6a and a
  corrected credentials.ts docstring). The story's own DoD requires recording amendment E's
  "already-satisfied verification … with the commands that produced them": the command's current
  output contradicts the story text, and a reviewer who re-runs it can conclude E needs
  re-opening — re-applying E against today's text would rewrite the operator-corrected `≤` chain
  back to a strict `<`, the exact regression E's retirement exists to prevent. (E's disposition —
  retired, `df2-3` unopened — remains correct and is what saves this from HIGH.)
- **Evidence:** `grep -n loadResidentBounds _bmad-output/sprint-artifacts/dark-factory-v5/stories/
  df2-3-credential-lifecycle.md` → 0 hits; df2-3 `:123` carries the corrected chain, `:128` the
  old chain only as quoted history; df2-3 correction blockquote credits DF3.6a + DF2.13.

### W8-E-3 — The run-lock.ts raw-NUL observation no longer reproduces
- **Severity:** LOW · **Category:** C2-semantic
- **Anchor:** DF5.5 §Infra Prerequisites, note under the table — "observed 2026-09-08 in
  `scripts/lib/run-lock.ts` (two raw NULs; `grep -c` exited 1 while `sed` printed the symbol)".
- **Failure scenario:** the file was rewritten by the DF2.11/DF2.13 review rounds after the
  observation; a byte scan now finds **zero** NUL bytes. A dev who tries to reproduce the cited
  failure before trusting the positive-control design finds nothing and may discount the guard.
  The guard itself (a positive control per zero-match assertion) is independently sound and stays
  mandatory — the story even says "This is the durable guard; fixing any one file's bytes is not" —
  so this is evidence drift, not a design defect.
- **Evidence:** python byte scan of `scripts/lib/run-lock.ts` → `NUL count: 0` (71,608 bytes);
  `git log` shows the file last touched by df2-11 round-5 and df2-13 commits.

### W8-E-4 — Three of the four quoted `p1-3` glosses are not in the file
- **Severity:** LOW · **Category:** C2-semantic
- **Anchor:** DF5.5 §Technical Notes, `p1-3` header blockquote rationale — "p1-3's glosses are
  heavier than `p1-2:26`'s ("the A2A delegation layer (P1.1)", "P1.1's registration schema", "the
  local-only Transport Contract enforced by P1.1 INV-4", "P1.1's envelope helper")".
- **Failure scenario:** only "the A2A delegation layer (P1.1)" (`:24`) exists verbatim;
  `registration schema`, `Transport Contract`, `envelope helper` return zero hits anywhere in
  p1-3 (positive control: the file's H1 and the `:24` gloss both match). p1-3 is unmodified in the
  working tree and its last commits predate the story, so these were never there. A dev who treats
  the quotations as the gloss inventory when writing the per-line replacement text ("was P1.1's
  `<gloss>`…") writes gloss content the file never had, and the amendment log's before/after rows
  then quote text that does not match the file. The governing rule ("check the line for a
  parenthetical or appositive gloss") is stated abstractly and unaffected, hence LOW.
- **Evidence:** `grep -n 'registration schema\|Transport Contract\|envelope helper'` on p1-3 → 0;
  actual P1.1 glosses are at `:22` (route introducer), `:24` (delegation layer), `:39` (routing),
  `:138` (body-cap), `:147` (requestId carrier), `:154`/`:155` (A2A layer / `a2a.delegate`).

### W8-E-5 — `cap-hit-demo.ts:97,148` line citation is stale
- **Severity:** LOW · **Category:** C4-marginal
- **Anchor:** DF5.5 §Technical Notes, Amendment E — "`scripts/cap-hit-demo.ts:97,148` declare it
  'Inner control: run budget cap (artifact field only)'".
- **Failure scenario:** the annotation now sits at `:98` and the second declaration at `:164`;
  `:97` is `wallClockMs?: number;` and `:148` is `terminationProvenance: TerminationProvenance;`
  (at HEAD and in the working tree — the lines moved in DF2.13's round-1 patch). The quoted string
  itself is intact and the substantive point (the term is an artifact field that enforces nothing)
  still holds, and the story's own deviation rule ("line numbers above are a snapshot") covers it —
  marginal.
- **Evidence:** `grep -n 'Inner control' scripts/cap-hit-demo.ts` → `:98`, `:100`; `sed -n '97p;
  148p'` shows the unrelated fields; `:164` is `runBudgetCapMicros: number;`.

### W8-E-6 — DF6.1a/DF6.1b severance line citations are stale
- **Severity:** LOW · **Category:** C4-marginal
- **Anchor:** DF5.5 §Technical Notes, P1.18 disposition — "(`df6-1a-pr-feedback-bounded-fix-
  attempt.md:117`, verified 2026-09-08)" and "(`df6-1b-fix-loop-verdict-attempt-budget.md:114`)".
- **Failure scenario:** today the anchors sit at df6-1a`:155` and df6-1b`:116` (df6-1b`:114` was
  correct at HEAD before the wave's own uncommitted edits moved it; df6-1a was already `:138` at
  HEAD, so `:117` matches no current or committed state). Nothing breaks: the story mandates
  "search anchors first, line numbers second", both search anchors (`P1.18 is not a predecessor`)
  resolve, and both verbatim quotes match. Marginal.
- **Evidence:** `grep -n 'P1.18 is not a predecessor'` → df6-1a:155 (worktree) / :138 (HEAD);
  df6-1b:116 (worktree) / :114 (HEAD).

### W8-E-7 — The quoted comment literal "`deps repoint via DF5.5`" greps zero
- **Severity:** LOW · **Category:** C4-marginal
- **Anchor:** DF5.5 §Trigger Surface (yaml row) and §Infra Prerequisites (yaml row) — "their `deps
  repoint via DF5.5` comments".
- **Failure scenario:** the actual comment literal is `# KEEP per F14; deps repointed by DF5.5
  2026-09-08`; a dev greping the story's back-ticked string gets zero rows and could conclude the
  yaml lacks the comments. Amendment G states the exact literal ("All eight commented rows now
  read …") and rows are cited by story key throughout, so the misdirection is short-lived.
- **Evidence:** `grep -c 'deps repoint via DF5.5' sprint-status.yaml` → 0; `grep -c 'deps
  repointed by DF5.5'` → 8 (positive control).

### W8-E-8 — "All fourteen changes" in amendment G has no single reconstruction
- **Severity:** LOW · **Category:** C4-marginal
- **Anchor:** DF5.5 §Technical Notes, Amendment G — "all fourteen changes are in place".
- **Failure scenario:** the table enumerates seven array rows (incl. P1.18) plus the eight
  comments = 15; excluding P1.18's array as "applied by another hand" gives 14; seven arrays plus
  seven comments also gives 14. The number is unreconstructible from the table alone. The DoD's
  separate, verifiable items ("the seven `deps:` arrays and all eight discharged comments") are
  exact and correct, so no verification is blocked — but a dev logging "fourteen changes verified"
  cannot say which fourteen without guessing.
- **Evidence:** amendment G table (7 rows) + the same section's "eight commented rows" + P1.18's
  row note; yaml grep counts in W8-E-7.

---

## Category × severity counts

|           | C1-citation | C2-semantic | C3-structural | C4-marginal | total |
|-----------|------------|-------------|---------------|-------------|-------|
| HIGH      | 0 | 0 | 0 | 0 | 0 |
| MEDIUM    | 0 | 1 (W8-E-2) | 1 (W8-E-1) | 0 | 2 |
| LOW       | 0 | 2 (W8-E-3, W8-E-4) | 0 | 4 (W8-E-5…8) | 6 |
| **total** | **0** | **3** | **1** | **4** | **8** |

## Convergence verdict — DF5.5

**NOT CONVERGED** (confidence: high). The chore's load-bearing contract verifies clean at source —
occurrence table exact to the occurrence, marker/yaml/file-set arithmetic exact, slate meta block
reconciling against per-story rows, every successor ID resolving, epics index current — but one
internal governance-count contradiction (AC2's "five in-block edits" vs INV-1/DoD's four) and one
stale verification record (amendment E's df2-3 evidence, which the story's own DoD requires
re-recording and which no longer matches the artifact) each need one more targeted spec edit
before the story is safe to apply.
