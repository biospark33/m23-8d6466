# Wave 9 Verifier E — df5-5-keep-repoint-chore.md

**Wave 9 Verifier E · 2026-09-14 · branch `feature/wave7-seam-ownership-rework` (HEAD 6a7ae6c2) · scope: `_bmad-output/sprint-artifacts/dark-factory-v5/stories/df5-5-keep-repoint-chore.md`**

## Method

Read the spec top to bottom, then opened at source every claim it rests on:

- **All 12 in-scope story files** (11 KEEP + `p0-7`): existence, headers, and every one of the 28
  occurrence lines in amendment A's table, re-derived with the spec's own grep machinery
  (`grep -oE 'P1\.(1|4|6|8|10|13|15|16|17|19)\b'` plus the `P1\.1\b`-only variant for the 19-count).
- **All successor targets**: `ls` of `dark-factory-v5/stories/` (df6-1 confirmed deleted;
  DF6.1a/DF6.1b present); df6-1a/df6-1b severance anchors, `botComments[]` citation, webhook
  exclusion and Trigger Surface row; df2-10 `Restart=no`; df1-10 reclaim; df2-3 chain +
  `loadResidentBounds` count; df2-8 `qds cost` and the 5,000,000 µ$ cap.
- **Register + audit**: register `:23` (Module roots), `:47`/`:48` (DD-2/DD-2a), `:53` (DD-7),
  `:87` (DD-9), §4 boundary rows; audit `:24` (KEEP amendment allowance), `:92`/`:95` (amendment B
  rows), `:53`/`:133` (P0.4 RETIRE), §2 row count (30).
- **`sprint-status.yaml`**: all nine KEEP rows, all eight `deps repointed by DF5.5 2026-09-08`
  comments, the P1.18 UNSCHEDULED row, the DF5.5/DF6.1a/DF6.1b rows, and a Python recount of the
  DF slate from the per-story rows.
- **Code**: `src/protocol/phase-executor.ts` absence, `src/phase-engine/` presence,
  `src/providers/credentials.ts:294` (`mintRunKey`), `scripts/cap-hit-demo.ts:98`,
  `scripts/lib/run-lock.ts` NUL byte scan (Python `bytes.count`), `tests/scripts/` inventory.
- **Epics doc + R5**: story-heading set vs yaml row set (set-diff), DF2.13/DF2.8 counts, the DF5.5
  entry's amendment coverage, R5 `:89`.

**Positive controls used** (every zero-match claim was paired with a same-machinery match):
`exitStatus`→0 in p1-9/p1-11/p1-14 vs 21 in p0-3; 4-value enum sweep → only p0-4:39 vs the 5-value
enum present in p0-3:126 (quote-style) and p0-4:39; `loadResidentBounds`→0 in df2-3 vs 13 in
df3-6a / 1 in `credentials.ts`; KEEP-story DF3.6/DF2.11-13 sweep → exit 1 vs df2-3 naming DF3.6;
`grep -v 'DF[0-9]'` machinery validated by the raw-vs-filtered occurrence delta; `NUL byte` scan
done in Python (bash `$'\x00'` silently degrades to an empty pattern — the naive grep form matches
every line and proves nothing).

## Findings

Ranked most-severe first.

| ID | Severity | Class | Claim at issue | Evidence (symbol-or-anchor citation) |
|---|---|---|---|---|
| W9E-1 | MEDIUM | C1 | Amendment A's gloss section: three phrasings ("P1.1's registration schema", "the local-only Transport Contract enforced by P1.1 INV-4", "P1.1's envelope helper") "appear **nowhere in p1-3** and are retracted", and "The one verbatim quoted gloss is 'the A2A delegation layer (P1.1)' (`p1-3:24`)". | All three phrasings **do** appear in p1-3: `:24` carries "the local-only Transport Contract enforced by P1.1 INV-4" verbatim; `:147` carries "both populated by P1.1's envelope helper"; `:154` carries "registration conforms to P1.1's registration schema". And `p1-3:24` alone carries five P1.1 mentions with distinct glosses (A2A delegation layer, enum extension, the INV-4 Transport Contract, P1.1's A2A delegation, P1.1's Transport Contract), not one. The retraction misdescribes the heaviest file's edit inputs. Mitigation: the operative gloss rule ("write each line's replacement text from the line's own words (checking for a parenthetical or appositive gloss)") is unconditional and per-line, so it still catches all of them, and the per-occurrence protocol (19 = 18 repointed + `:142` provenance) is verified exact — but no acceptance assertion checks gloss quality, so an under-treatment that trusted the retraction would pass AC1 and the test suite silently. |
| W9E-2 | LOW | C1 | Spec Reference renumbering bullet: "This story writes no DF1.10 or DF1.11 reference and is not affected by the renumbering." | Contradicted by the spec's own text: the canonical-set paragraph says "plus **DF1.10** and **DF2.10** … amendment C's `p1-9` blockquote names … DF1.10's reclaim; amendment F's blockquote names DF1.10", and amendment C's prescribed blockquote writes "DF1.10 owns reclaim semantics (`df1-10:91,143`)". The reference the story writes is post-ADR and **correct** (df1-10:91 "Reclaim semantics (this story's half of supervision)", :143 supervision folded in two halves — both verified), so substance holds; the sentence is stale and would tell a renumbering auditor there is nothing to check when there is. |
| W9E-3 | LOW | C4 | E2E Slice: "Every marker this chore writes lands inside those two directories: no amendment edits a file outside them." | The chore also edits its own story file — `dark-factory-v5/stories/df5-5-keep-repoint-chore.md — amendment log` is in Files to Modify and sits outside both story dirs, and the log's before/after rows will quote marker-bearing replacement text. The 11-count is unaffected (the grep is directory-scoped and the spec itself counts 12 literal occurrences in df5-5), so this is imprecision, not a counting defect. |
| W9E-4 | LOW | C4 | Amendment F's prescribed blockquote text: "…**runs inside the sandbox box** (DF1.10)." | Redundant phrasing ("in-box" is the term of art; "sandbox box" reads as a typo) in text the dev must insert verbatim. Cosmetic; no behavioral effect. |

### Observation (not a finding — the spec's own tripwire firing)

**The yaml meta block's DF totals are stale on today's tree.** The comment block claims
"DF totals: 37 stories / 151 points (DF1 10/45, DF2 10/39, DF3 8/32, DF4 2/10, DF5 5/17,
DF6 2/8)". A recount from the per-story rows gives **DF1 10/45 ✓ · DF2 13/48 · DF3 9/35 ·
DF4 2/10 ✓ · DF5 5/22 · DF6 3/9 → 42 stories / 169 pts (33 done)**. The DoD's
"Verify (not impl — the slate count is recomputed, never trusted)" item mandates a recompute,
assert-equality, and "A mismatch stops the chore: fix the meta block first (parent-owned, outside
this story's diff), then re-run" — so the halt will fire at pre-flight on the current tree. That is
the gate working as designed (the spec explicitly distrusts the meta block, "it lagged the DF2.13
row by a whole story"), but the parent should fix the meta block before DF5.5 is scheduled to
apply. Nothing the spec *asserts* about the meta block is false.

## What checked out (positive verification)

1. **File inventory exact.** All 12 in-scope files exist; `p0-5` has zero retired-ID hits; `p1-5`
   has zero; the amended-file set (11) and the 10-file occurrence table are exact.
2. **Amendment A table line-for-line exact** — all 28 occurrence lines re-verified with content
   matches including multiplicities: p1-2:26 (with the "Dev Manager registered as A2A agent" gloss
   the gloss rule quotes), p1-3 22×3/24×5/39/46(P1.6)/138×3/142/147×3/154×2/155, p1-7:26, p1-9:25
   (names `P1.8` only, confirming the divergence note's premise), p1-11 25/48/51, p1-12 25/31/39,
   p1-14 24/26, p1-18 17/23/25/50, p0-9 198/218, p0-7 55 + 136×3.
3. **The 19-count is real**: `grep -oE 'P1\.1\b' p1-3 | wc -l` → 19, on exactly 8 lines
   (3+5+1+3+1+3+2+1); 18 repointed + `:142` provenance = 19; "leaves eleven live references"
   arithmetic holds.
4. **Quoted text verbatim**: `p1-3:22` "does not exist in source today"; `p1-3:142` and `p0-9:218`
   both carry the `-32010..-32013` allocation exactly as the spec quotes — the "one fact, one
   treatment" provenance pairing is correct.
5. **P1.18 hand-off coherent at every hop**: `p1-18:36` carries
   `botComments: [{ commentId, author, bodySnippet, timestamp }]` verbatim (first-hand verified);
   `p1-18:50` is the P1.19 line inside `## Security Invariants` (headers :47/:53 exactly as cited);
   the fallback tripwire arithmetic (4 admitted → 5th rejected → 6th on the fallback path) is
   consistent between INV-1 and the P1.18 disposition; DD-2a (`register:48`, DECIDED 2026-09-08)
   records the split, the dangling ID and the DF6.1a-wave ownership — "no register edit is owed"
   is correct; the yaml DF6.1a row carries the hand-off and the INTAKE-channel denial, DF6.1b's
   row the VERDICT-channel denial and the two-call composition; df6-1a:158 / df6-1b:116 carry the
   two severance limbs under the "P1.18 is not a predecessor" anchor; df6-1a:55 carries the
   `botComments[]` + `p1-18-pr-comment-polling.md:36` citation verbatim; df6-1b's webhook
   exclusion sits inside its AC block (:181, AC :129–:262) and its Trigger Surface row (:269)
   matches; the yaml P1.18 row's "polls `gh pr checks`" retraction and the two-call correction are
   present verbatim as described.
6. **Amendment G fully verified as already-applied**: all seven `deps:` arrays exactly as tabled —
   P1.2 `[DF3.1]`, P1.7 `[P0.6, DF1.6]`, P1.9 `[DF1.6, DF1.8]` (the union), P1.11 `[P0.9, DF1.6]`,
   P1.12 `[P0.9, DF1.6]`, P1.14 `[P1.5, DF2.8]`, P1.18 `[DF5.2]`; P1.3 `[P1.2, P0.9]` and P1.5
   `[P0.9, P0.10]` carry the comment with no retired ID; exactly **8** "deps repointed by DF5.5
   2026-09-08" comments; the P1.9 row carries the prescribed discharge clause verbatim; the
   AC1-bullet-3 yaml grep returns only superseded rows today (P1.6/P1.8/P1.10/P1.13/P1.15/P1.16/
   P1.17) — zero KEEP-story keys.
7. **Amendment B verified**: `exitStatus` occurs 0 times in p1-9, p1-11 and p1-14 (positive
   control: 21 in p0-3); audit `:92`/`:95` read exactly as quoted; p1-11:44 is a Hindsight REST
   transport table row; p1-14:29 is blank; the corpus sweep finds exactly one 4-value listing
   (`p0-4:39` `exit_class: success | transient | overflow | logic`) and P0.4 is RETIRE (audit
   `:53`/`:133`); DD-9 (register `:87`) settles integer µ$ and DF2.8 restates 5,000,000 µ$
   (df2-8 :39/:72/:190); `costCents` occurs at exactly p1-14 :30/:37/:40.
8. **Amendment C verified**: p1-9:17 Overview three categories, :29 AC1 `transient|overflow|
   logic`, :36 three-value `FailureClass` over a `FailureSignal`; `p0-3:126` is the five-value
   enum; DF2.10 `Restart=no` at df2-10:106 and :173; DF1.10 reclaim at df1-10:91 and :143. Both
   insert anchors (:25 p1-9, :26 p1-5) sit in the **E2E Slice** — the AC blocks start at :27 and
   :28 respectively — so AC2's zero-character rule on both files is structurally satisfiable, and
   neither file currently names DF1.3 or DF1.5, so the blockquotes are genuinely additive.
9. **Amendment D verified**: DD-7 (register `:53`) assigns the one-line role statement to DF5.5
   ("One-line role statement lands via DF5.5"); `qds cost` is DF2.8's shipped CLI surface
   (df2-8 :33/:43/:66; PR #121 merged **2026-08-21** in both the story and the yaml row).
10. **Amendment E verified**: `loadResidentBounds` occurs 0 times in df2-3, 13 in df3-6a, 1 in
    `src/providers/credentials.ts`; df2-3:123/:218 carry the operator-corrected
    `residentSpendCeilingMicros ≤ capMicroUsd (mint-time, per run) ≤ defaultKeyCapMicroUsd` chain;
    `mintRunKey` takes `deps.capMicroUsd ?? defaultKeyCapMicroUsd`
    (`src/providers/credentials.ts:294`); `scripts/cap-hit-demo.ts:98` carries "Inner control: run
    budget cap (artifact field only)". The retirement rationale holds — re-applying E would
    regress the corrected `≤` chain.
11. **In-block-edit audit exact**: p1-3 headers (AC :34, DoD :152) put `:39` in AC4 and
    `:154`/`:155` in DoD; p1-12 headers (AC :27) put `:31` in AC3; p1-11 headers (:27 AC, :37
    Technical Notes, :55 Files to Modify — cited exactly) put `:48` in Technical Notes. The four
    admitted in-block edits are exactly where INV-1 says, and `p1-11:48`'s separate treatment is
    justified.
12. **Marker machinery sound**: 12 literal occurrences in df5-5 (verified), zero in the epics doc
    (verified); repo-wide the literal appears only in df5-5 plus four prior review evidence files
    — so the directory-scoped 11-count argument holds, and an unscoped grep indeed cannot equal 11.
13. **Epics doc current**: 42 story headings, **set-identical** to the yaml's 42 DF rows
    (stronger than the spec's DF2.13 spot-check: `DF2.13`→1 and `DF2.8`→16 both exact); the DF5.5
    entry carries "amendments A–F", the three greps, DF6.1a-as-scheduling-edge, the canonical set
    and the provenance negative control — the Wave-6 divergence is closed as claimed.
14. **Register citations exact**: `:23` Module roots (`src/phase-engine/*` first),
    `:47` DD-2 (with the struck "P1.18 (KEEP) repoints to DF6.1" and "AMENDED 2026-09-08 — see
    DD-2a"), `:48` DD-2a, `:53` DD-7, `:87` DD-9, §4 both boundary rows (DF1.3↔P1.9 carries the
    "keyed on the exitStatus enum" wording the erratum corrects; DF1.5↔P1.5 matches amendment C).
    Audit `:24` is the KEEP amendment-allowance row; §2 is 30 rows.
15. **Amendment F premises exact**: `src/protocol/phase-executor.ts` does not exist; no DF story
    creates it (only df5-5 itself mentions the path); `src/phase-engine/` exists; `p1-11:51` and
    `p1-12:39` both name the path glossed as a P1.6 artifact (p1-12:39 even says "does not exist
    yet").
16. **R5 `:89`** verbatim as quoted (stale row, correctly left unedited under INV-3).
17. **Test prerequisites real**: `tests/scripts/` is the existing home for repo-hygiene checks
    (`license-sweep.test.ts`, `roster-check.test.ts` both present); `keep-repoints.test.ts` does
    not exist yet; `scripts/lib/run-lock.ts` contains **zero** NUL bytes (matching the spec's
    "no longer reproduces" evidence note).
18. **Slate-sweep negatives hold**: the six retired IDs in scope are exactly P1.1/P1.6/P1.8/
    P1.13/P1.15/P1.19; P1.4/P1.10/P1.16/P1.17 appear in no KEEP story; zero KEEP-story mentions of
    DF3.6/DF2.11/DF2.12/DF2.13 (positive control: df2-3 names DF3.6).
19. **AC4's per-ID precondition is satisfiable**: every successor ID the amendments write
    (DF3.1, DF1.6, DF1.8, DF2.8, DF5.2, DF5.3, DF1.10, DF2.10) resolves to a story file on disk;
    DF6.1a is correctly a scheduling edge listed in the yaml row but excluded from AC4.

## Verdict

**CONVERGED** — zero BLOCKER, zero HIGH, zero C2, zero C3.

**Confidence: high.** Every citation in the spec was re-derived at source — all seven yaml arrays,
all 28 occurrence lines with multiplicities, every line-anchored story/code claim, both register
erratum rows, the DF6.1a/b severance anchors and the code symbols behind amendments E and F — and
all but four marginal items matched exactly; the one substantive residue (W9E-1) misdescribes
p1-3's gloss inventory but the operative per-line gloss rule still covers the real text.

## Summary counts

| | BLOCKER | HIGH | MEDIUM | LOW | Total |
|---|---|---|---|---|---|
| C1 citation | 0 | 0 | 1 (W9E-1) | 1 (W9E-2) | 2 |
| C2 semantic | 0 | 0 | 0 | 0 | 0 |
| C3 structural | 0 | 0 | 0 | 0 | 0 |
| C4 marginal | 0 | 0 | 0 | 2 (W9E-3, W9E-4) | 2 |
| **Total** | **0** | **0** | **1** | **3** | **4** |

Residue is C1/C4-dominant as the convergence target requires.
