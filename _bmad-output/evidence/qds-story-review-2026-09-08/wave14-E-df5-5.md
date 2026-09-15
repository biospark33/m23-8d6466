# Wave 14 — Verifier E — df5-5-keep-repoint-chore.md

**Reviewer:** Wave-14 Verifier E (clean eyes — no prior wave material read)
**Target:** `_bmad-output/sprint-artifacts/dark-factory-v5/stories/df5-5-keep-repoint-chore.md` (working tree, branch dev @ 4264f546 + uncommitted spec edits)
**Date:** 2026-09-14
**Verdict:** **NOT CONVERGED** — 0 BLOCKER, 0 HIGH, 3 MEDIUM, 3 LOW. Two convergence-blocking findings (one C2, one C3), both one-sentence fixes.

---

## Method

Read the story file end to end. Then opened at source every anchor, symbol, path and citation it names. Cross-story reads were confined to the named repoint anchors and cited rows (list below). All zero-match claims were re-run with a positive control using identical machinery.

### Anchors opened (cross-story reads)

- **The 12 in-scope files:** ran the story's own AC1 retired-ID grep (`grep -rnE 'P1\.(1|4|6|8|10|13|15|16|17|19)\b' … | grep -v 'DF[0-9]'`) over `phase-1/stories/p1-{2,3,5,7,9,11,12,14,18}-*.md` and `phase-0/stories/p0-{5,7,9}-*.md`, then read the specific lines each amendment-A row names; read section headers of p1-3, p1-5, p1-9, p1-11, p1-12, p1-14, p1-18, p0-7 to verify the in-block/out-of-block claims; read full `p1-18:36`, `p0-4:39`, `p0-3:126`, `p1-11:44`, `p1-14:29/30/37/40`, `p1-9:17/25/29/36`, `p1-5:26`.
- **Named repoint anchors in DF stories:** `df6-1a` (search anchors `P1.18 is not a predecessor`, `comment-read limb`, `botComments[]`, `:54-55`); `df6-1b` (same anchor, `verdict limb`, `out of scope for v5.0`, `Inbound webhooks`, Trigger Surface row, and the verdict-poll composition passage ~:140-190 and :323); `df2-10` (`:106`, `:173`); `df1-10` (`:91`, `:143`); `df2-3` (`residentSpendCeilingMicros` chain at `:123`/`:218`, quoted-history blockquote at `:128`); `df2-8` (`qds cost`, `5,000,000 µ$`); existence of `df1-3/df1-5/df1-6/df1-8/df2-8/df3-1/df5-2/df5-3/df1-10/df2-10/df6-1a/df6-1b/df2-3/df3-6a/df2-13/df2-11/df2-12/df1-11/df3-7/df3-8`; absence of `df6-1-*.md`.
- **Cited register/audit/ADR/R5 rows:** register `:23` (module roots), `:47` (DD-2 + strikethrough + AMENDED note), `:48` (DD-2a), §4 boundary contracts, DD-7, DD-8, DD-9; audit `:24` (KEEP amendment allowance, verbatim match), `:90` (P1.9 "keyed on the exitStatus *enum*"), `:92`/`:95` (the two line-44/line-29 enum-fix instructions), P0.1/P0.4/P0.8 RETIRE rows, P1.4/P1.10/P1.16/P1.17 RE-DERIVE rows; tier2 ADR status ACCEPTED + §Consequences; R5 `:89` (the stale §1.5 row, verbatim match incl. `| 2 |`), §2, §5.2, §5.4 (both boundary pairs incl. "(step 6)").
- **Code/config:** `sprint-status.yaml` (all seven repointed `deps:` arrays, the eight `KEEP per F14` comments, P1.3/P1.5 comment-only rows, P1.9 discharged clause, P1.18 UNSCHEDULED row + retraction note, DF6.1a row, meta-block comments); `src/protocol/` (absent), `src/phase-engine/` (present), `src/providers/credentials.ts` (`mintRunKey` :277, `deps.capMicroUsd ?? defaultKeyCapMicroUsd` :294), `scripts/cap-hit-demo.ts:98`, `tests/scripts/` (license-sweep + roster-check present; `keep-repoints.test.ts` absent); epics doc DF5.5 entry (:865) and KEEP row (:988).

### Positive controls (every zero-match claim)

| Zero-match claim | Positive control | Result |
|---|---|---|
| `p0-5` has zero retired-ID hits | `grep -c '^# '` on p0-5 | 0 hits / control 1 ✓ |
| P1.4/P1.10/P1.16/P1.17 absent from the 12 files | `grep -c 'P1\.16'` in R5 | 0 / 3 ✓ |
| `exitStatus` zero in p1-11, p1-14, p1-9 | `grep -rl exitStatus` over sprint-artifacts md | 0/0/0 / hits elsewhere ✓ |
| `loadResidentBounds` zero in df2-3 | same grep over DF stories + src | 0 / hits in df3-6a, df2-13, credentials.ts ✓ |
| Marker zero in epics doc, yaml, phase-{0,1}/stories today | `grep -c 'DF5\.5'` epics (6), `KEEP per F14` yaml (8), `Acceptance Criteria` in phase dirs (30 files) | 0/0/0 / controls ✓ |
| DF2.11/DF2.12/DF2.13/DF3.6 + ceiling-chain symbols absent from the 12 files (Slate sweep) | machinery proven by the 28-line retired-ID hit set on the same files | 0 / ✓ |
| `p1-14:29` blank; `p1-11:44` is a REST table row; `p0-4:39` carries the 4-value `exit_class` | read the lines directly | ✓ each |

---

## Findings

| ID | Class | Severity | Finding |
|---|---|---|---|
| W14E-1 | C2 | MEDIUM | **Assertion-1's sanctioned-forms enumeration cannot literally classify the story's own prescribed `p1-9:25` text.** The DoD Test item enumerates exactly three sanctioned provenance forms: a `(now DF…)` annotation, "a `was P1.1 …` gloss", or "the header blockquote whose `v5 amendment (DF5.5)` marker names the repoint". The story's own prescribed `p1-9:25` replacement reads `DF1.6 (was P1.6, per sprint-status), DF1.8 (was P1.8, per this file). <!-- v5 amendment (DF5.5) -->` — its two surviving retired-ID occurrences are `was P1.6`/`was P1.8` glosses (form 2 names P1.1 literally) and its marker is an inline HTML comment, not a header blockquote (form 3). A literal implementation of the enumeration flags the story's own prescribed artifact. (The W12E-1 justification names only the p1-2 gloss and the p1-3 blockquote as motivating cases — the p1-9 union text predates/postdates without updating the enumeration.) Fix: generalize form 2 to "a `was P1.x …` gloss" and/or admit the inline `<!-- v5 amendment (DF5.5) -->` marker as a classification form. |
| W14E-2 | C3 | MEDIUM | **Three of the 11 amended files have no marker-bearing prescribed text, so the as-prescribed edit set yields 8 marker paths, not the 11 AC1 asserts.** Marker-bearing verbatim text is prescribed for p1-2 (replacement line), p1-3 (header blockquote), p1-9 (line + C blockquote), p1-11/p1-12 (F blockquote), p1-18 (header blockquote), p0-7 (D blockquote), p1-5 (C blockquote) — but for `p1-7` (row prescribes only "P1.6 → DF1.6"; its `:26` carries no P1.6 gloss), `p1-14` (only "P1.13 → DF2.8"; `:24`/`:26` gloss-free), and `p0-9` (only "198 repointed; 218 annotated") no prescribed text carries the marker. The Contract DoD ("Every edit carries the literal marker") restates the obligation three times and test assertion 3 fails loudly, so a dev can recover — but the story's edit list and its own 11-path gate are inconsistent until the dev extrapolates the marker onto lines for which no text is given. Fix: one sentence ("append `<!-- v5 amendment (DF5.5) -->` to every line a bare substitution or annotation touches") or prescribe replacement lines for the three files. |
| W14E-3 | C1 | MEDIUM | **The DF6.1b composition description is wrong against the cited file's current text.** The P1.18 disposition says DF6.1b "specifies a two-call composition (`gh pr view --json statusCheckRollup` for SHA binding + `gh pr checks --required` for requiredness)". DF6.1b's live text specifies **three** host-authenticated `gh` invocations per poll — `gh pr view <n> --json headRefOid,headRefName` issued **twice** (SHA binding) + `gh pr checks <n> --required --json name,state,bucket` — and names `statusCheckRollup` only as the negative control that "carries no requiredness marker and no `bucket`". Both the call count and the SHA-binding query are misdescribed. The story's own hedge ("does not disturb the severance") bounds the damage — the severance itself is verified real at all named anchors — but this is the correction that supersedes the retracted yaml wording, so the amendment log would record an inaccurate correction, and the re-verification gate as written (filenames only) would not catch it. (The yaml P1.18 row shares the same framing — outside this story's diff, but worth flagging to the parent.) |
| W14E-4 | C1 | LOW | Marker self-count stale: the E2E Slice says "verified 2026-09-13: 12 occurrences here"; actual count is **16** (16 lines, 16 occurrences). The load-bearing inference ("an unscoped `grep -rl` returns strictly more than 11 paths") is unaffected. |
| W14E-5 | C4 | LOW | Amendment C's p1-5 blockquote inserts "(step 6)", inherited verbatim from register §4/R5 §5.4 ("the audit slots P1.5 at '1 + 6'"). Inside p1-5 the parenthetical resolves to nothing — p1-5 has no numbered step 6 (`grep 'step 6'` → 0; its ACs are 3 items). A developer reading the inserted line in p1-5 cannot resolve the citation from the file it lands in. |
| W14E-6 | C4 | LOW | AC4 explicitly excludes DF6.1a from the successor-precondition check ("a scheduling edge … AC4 does not check it"), yet the pre-authorised fallback **writes** DF6.1a into `p1-18:50` — on that path INV-4's blanket rule ("a successor ID is written only after its story file is confirmed present") has no enumerated mechanism. Practical risk nil (the file demonstrably exists and the gate re-reads filenames), but the two statements are in tension on the fallback branch only. |

---

## What HELD

Nearly everything, and it held at the strongest reading — every load-bearing anchor traced at source:

- **Occurrence table exact.** The AC1 grep over the 12 in-scope files returns exactly the story's table — 28 lines across 10 files, per-line counts included: p1-3 is 19 `P1.1` occurrences across 8 lines (22×3, 24×5, 39, 138×3, 142, 147×3, 154×2, 155) + P1.6 at `:46`, precisely as the story states; `p1-18` is `:17/:23/:25` plus `:50`, "not 50" handled; `p0-5` and `p1-5` zero-hit with controls. Every line survives the `DF[0-9]` filter today (premise of the zero-after-edit signal). The quoted glosses are verbatim: p1-2:26's "Dev Manager registered as A2A agent", p1-3:24's "the A2A delegation layer (P1.1)", ":154 registration schema", ":24 Transport Contract INV-4", ":147 envelope helper", ":22 'does not exist in source today'", ":142 may-propagate" vs p0-9:218 range text, p0-7:55 and :136 (exactly three P1.1 mentions).
- **Marker bookkeeping.** Marker zero in the epics doc and yaml; zero in the two story dirs today (pre-dev, as expected); epics DF2.13 → 1 and DF2.8 → 16 exactly as the Trigger Surface records; the epics DF5.5 make-or-break entry carries amendments A–F and the third grep — the claimed divergence-closure is real.
- **Every amendment's external anchor verified:** register `:23/:47/:48` + §4 + DD-7/DD-8/DD-9 (amendment C/D wording faithful; the "keyed on the exitStatus enum" erratum target verbatim in audit :90 and register §4); audit `:24` allowance quote verbatim, rows `:92/:95`; R5 `:89` stale row verbatim; ADR ACCEPTED with in-box engine + DF3.6 re-sequence; df2-10:106/173 `Restart=no` + `qds-run@.service`; df1-10:91/143 reclaim; df6-1a :163 comment-read limb + :54-55 `botComments[]` payload citing p1-18:36; df6-1b :120 verdict limb + :189 AC1 webhook exclusion + :315 Trigger Surface row; p1-18:36 carries `botComments: [{ commentId, author, bodySnippet, timestamp }]` verbatim; p1-18:50 quote verbatim; p1-18 headers 47/53 and p1-11 headers 27/37/55 exact (:48 and :51 both inside Technical Notes).
- **Amendment G verified already-applied, exactly as claimed:** all seven arrays (`[DF3.1]`, `[P0.6, DF1.6]`, `[DF1.6, DF1.8]` union + discharged clause, `[P0.9, DF1.6]`×2, `[P1.5, DF2.8]`, `[DF5.2]`), eight comments, P1.3/P1.5 comment-only with no-rewrite note, yaml marker zero, and the third grep's remaining hits are all `superseded` rows (7/7).
- **Amendment E verified:** df2-3's live chain is the operator-corrected `≤` form (:123/:218) with the old strict-`<` chain surviving only as quoted blockquote history (:128); `loadResidentBounds` zero in df2-3, present in df3-6a/df2-13/credentials.ts; `mintRunKey` takes `deps.capMicroUsd ?? defaultKeyCapMicroUsd` (:294, symbol cited); cap-hit-demo.ts:98 carries the "artifact field only" gloss verbatim.
- **Amendment B verified:** `exitStatus` zero in all three named files (controls pass); p1-11:44 is the REST table row; p1-14:29 blank with `costCents` at :30/:37/:40; p0-4:39 is the corpus's 4-value `exit_class`; DF2.8 restates 5,000,000 µ$ and ships `qds cost`.
- **Amendment F verified:** `src/protocol/` absent, `src/phase-engine/` present with real modules, no DF story creates `phase-executor.ts`, both :51/:39 carry the dead path with the P1.6 gloss.
- **Structure/executability:** in-block edit claims check out against every file's headers (the four admitted in-block lines are exactly where INV-1 says; p1-9:25 and both C-insertion points sit outside AC blocks; p0-7's :55/:136 are in Technical Notes); the tripwire arithmetic (four admitted → fifth rejection → sixth on the sanctioned fallback path) is internally consistent; the four-assertion enumeration, the yaml KEEP-row join, the synthetic DF9.9 halt, the meta-block recompute, and the no-window provenance forms are all implementable as written; the negative controls' failure homes are defined by the story's own text (provenance catch = review-time, no assertion arm — stated).
- **Environment claims:** all 17 DF files present, `df6-1` deleted, `keep-repoints.test.ts` absent (as the re-estimate note says), `license-sweep.test.ts`/`roster-check.test.ts` present, `DF5.3` `ready-for-dev`, DD-2a landed with the DF6.1a hand-off (matching the yaml DF6.1a row's ownership note).

---

## Verdict

**NOT CONVERGED** — confidence **HIGH**.

Blocking residue is three MEDIUMs: W14E-1 (C2 — the sanctioned-forms enumeration misses its own p1-9:25 artifact), W14E-2 (C3 — 3 of 11 files have no prescribed marker-bearing text, so the as-prescribed edit set cannot produce the asserted 11-path marker grep), W14E-3 (C1 — the DF6.1b composition correction is factually wrong against df6-1b's live text). Each is a one-sentence fix; nothing structural survives beyond them.

## Summary counts

| | C1 | C2 | C3 | C4 | Total |
|---|---|---|---|---|---|
| BLOCKER | 0 | 0 | 0 | 0 | **0** |
| HIGH | 0 | 0 | 0 | 0 | **0** |
| MEDIUM | 1 (W14E-3) | 1 (W14E-1) | 1 (W14E-2) | 0 | **3** |
| LOW | 1 (W14E-4) | 0 | 0 | 2 (W14E-5, W14E-6) | **3** |
