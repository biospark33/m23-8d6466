# Verify-E — Adversarial pre-dev review: DF5.5, DF2.11, DF2.12

**Reviewer:** verify-E (first-time review, beginner's mind — no prior editing assumed correct)
**Date:** 2026-09-08 · **Branch:** `dev` · **HEAD:** `fa7d0e26`
**Rule applied:** shipped code wins unless it contradicts the ACCEPTED ADR
(`docs/superpowers/specs/2026-08-31-tier2-placement-adr.md`, incl. Appendices A and B).
**No files were edited.** Every line citation below was executed against the tree at `fa7d0e26`.

---

## 0. Ground truth actually read

| Artifact | Read | Notes |
|---|---|---|
| `docs/superpowers/specs/2026-08-31-tier2-placement-adr.md` (+ Appendix A `:129`, Appendix B `:153`) | yes | A = completion-marker clarification; B = bounds rooted at component pid. Neither is contradicted by any of the three stories. |
| `docs/superpowers/specs/2026-08-11-story-disposition-audit.md` | yes | amendment allowance verbatim at `:24`; KEEP-11 roster at `:131`; P1.9 row at `:90` |
| `docs/superpowers/specs/2026-08-11-v5-story-derivation-decisions.md` | yes | §1 `:23`, §4 `:59-60`, DD-2 `:47`, **DD-2a `:48`**, DD-7 `:53`, DD-8 `:86`, DD-9 `:87` |
| `_bmad-output/sprint-artifacts/sprint-status.yaml` | yes, in full | slate 41/166, 30 done/125; phase-1 block `:100-127`; DF block `:128-` |
| all 12 in-scope `p0-*`/`p1-*` KEEP files | yes | full retired-ID enumeration below |
| shipped code for DF2.11/DF2.12 seams | yes | `teardown.ts`, `reaper.ts`, `cost-ledger.ts`, `run-lock.ts`, `fleet.ts`, `sandbox-teardown.ts`, `cap-hit-demo.ts`, `qds-cost.ts`, `fanout-primitive.ts`, `approval-gate.ts`, `dispatch-task.ts`, `team-event-adapter.ts`, `steering.ts`, `harvest.ts`, `pipeline-run.ts`, `tests/providers/cost-ledger.test.ts` |

---

# PART 1 — DF5.5 (KEEP-Repoint Chore)

File: `_bmad-output/sprint-artifacts/dark-factory-v5/stories/df5-5-keep-repoint-chore.md` (521 lines)

## 1.1 Counts

| Severity | Count | IDs |
|---|---|---|
| BLOCKER | 3 | V-DF5.5-B1, B2, B3 |
| HIGH | 4 | V-DF5.5-H1 … H4 |
| MEDIUM | 7 | V-DF5.5-M1 … M7 |
| LOW | 2 | V-DF5.5-L1, L2 |

## 1.2 Edit-by-edit verdict table

Ground truth: `grep -onE 'P1\.(1|4|6|8|10|13|15|16|17|19)\b'` over the 12 in-scope files, run at `fa7d0e26`.
**None of the story-file amendments (A, C, D, F) has been applied.** Amendment G **has**.

### Amendment A — dependency-edge repoints

| # | Target | Story claim | Verified | Verdict |
|---|---|---|---|---|
| A1 | `p1-2:26` | `P1.1` → `DF3.1`, replacement text; story quotes the line verbatim | line 26 is byte-identical to the quotation; 1 × `P1.1` | **VALID** |
| A2 | `p1-3:22,24,39,46,138,142,147,154,155` | "the **eight** P1.1 substitutions" + `P1.6`→`DF1.6` at `:46` | lines correct; but **19** `P1.1` occurrences, not 8 (22×3, 24×5, 39×1, 138×3, 142×1, 147×3, 154×2, 155×1). `:46` carries 1 × `P1.6` ✅ | **STALE-COUNT → see B3** |
| A3 | `p1-7:26` | `P1.6` → `DF1.6` | `**Dependency edges (predecessors):** P0.6, P1.6 — **P0.6 is DONE** …`; 1 × `P1.6` | **VALID** |
| A4 | `p1-9:25` | `P1.8` → `DF1.8`, resolve divergence first | `**Dependency edges (predecessors):** P1.8.`; 1 hit | **VALID** (but see B1 — the yaml half is already applied) |
| A5 | `p1-11:25,48,51` | `P1.6`→`DF1.6` (25,51); `P1.1`→`DF3.1` (48) | exact: 25 `P1.6`, 48 `P1.1`, 51 `P1.6` | **VALID** |
| A6 | `p1-12:25,31,39` | `P1.6` → `DF1.6` ×3 | exact | **VALID** |
| A7 | `p1-14:24,26` | `P1.13` → `DF2.8` ×2 | exact; `:24` = "Predecessors (P1.5, P1.13) are dependency edges…"; `:26` = the edge line | **VALID** |
| A8 | `p1-18:17,23,25` (**not 50**) | `P1.15` → `DF5.2` at `:25`; `:17`/`:23` annotated under blockquote | exact; `:50` carries `P1.19` | **VALID** for 17/23/25; `:50` → see B2 |
| A9 | `p0-9:198,218` | `:198` `P1.6`→`DF1.6`; `:218` `P1.1` kept + `(now DF3.1)` | exact | **VALID** (classification inconsistent — see M3) |
| A10 | `p0-7:55,136 (×3)` | `:136` three `P1.1`→`DF3.1`; `:55` kept + annotated | **×3 confirmed** at `:136`; `:55` is the illustrative-snippet comment | **VALID** |
| A11 | `p0-5` | zero hits, never opened | zero hits confirmed | **VALID** |

### Amendments B–G

| # | Instruction | Verified | Verdict |
|---|---|---|---|
| B | Two enum-citation fixes are NOT-FOUND | `grep -c exitStatus p1-11` → 0; `p1-14:29` blank; `p0-4:39` is the only 4-value listing and P0.4 is RETIRE (`audit:131` KEEP roster excludes it) | **VALID (record-only)** |
| C | Boundary blockquotes in `p1-9`, `p1-5` | `register:59-60` verbatim ("DF1.3 owns **in-phase** retry… P1.9 owns **cross-run** … keyed on the exitStatus enum"; "DF1.5 owns the roster **config schema + dual slug validation**"). `p1-5` has 0 retired-ID hits ✅ | **VALID** |
| C-erratum | `exitStatus` occurs 0× in `p1-9` | confirmed 0; `p1-9:17` three categories, `:29` AC1 three-valued, `:36` `FailureClass` over `FailureSignal`; `p0-3:126` CC-1 five-valued | **VALID — erratum is real** |
| D | DD-7 SwarmClaw role line in `p0-7` | `register:53` verbatim, incl. "It is NOT the factory front door… One-line role statement lands via DF5.5. P0.7 assets stay frozen KEEP." | **VALID** |
| E | DF2.3 ceiling chain ALREADY-SATISFIED | `df2-3:123` carries `residentSpendCeilingMicros < runBudgetCapMicros ≤ defaultKeyCapMicroUsd` and `:125` names `loadResidentBounds` | **VALID (already-satisfied)** |
| F | Engine-seam note in `p1-11`, `p1-12` | `src/protocol/phase-executor.ts` does not exist; `register:23` puts engine code under `src/phase-engine/*`; `df2-10:106,173` and `df1-10:91,143` all resolve | **VALID** — but writes `DF1.10` outside the canonical set (H3) |
| G | Six yaml `deps:` repoints + eight comment discharges | **Every one is already in the tree.** `:110` `[DF3.1]`, `:115` `[P0.6, DF1.6]`, `:117` `[DF1.6, DF1.8]`, `:119` `[P0.9, DF1.6]`, `:120` `[P0.9, DF1.6]`, `:122` `[P1.5, DF2.8]`, `:126` `[DF5.2]`; all eight comments read `deps repointed by DF5.5 2026-09-08`; P1.9's row already carries the exact prescribed replacement clause "P1.8 question resolved by DF5.5: both edges retained as DF1.6 + DF1.8". Cited line numbers `:92,93,95,97,99,101,102,104,105` are all wrong (actual `110,111,113,115,117,119,120,122,126`). | **ALREADY-APPLIED + WRONG-LINE → B1** |

**Aggregate:** 11 VALID · 1 STALE-COUNT (BLOCKER) · 1 ALREADY-APPLIED + WRONG-LINE (BLOCKER) · 0 WRONG-TARGET-ID · 0 OBSOLETE.
Every DF successor ID the amendments write resolves to a file on disk today (`DF1.3, DF1.5, DF1.6, DF1.8, DF2.8, DF3.1, DF5.2, DF5.3` + the uncovered `DF1.10, DF2.10`). No dangling IDs in the amendment text itself.

---

## 1.3 Findings

### V-DF5.5-B1 · BLOCKER · Amendment G is already applied; DF5.5 still owns it, and every line cite is wrong
**File:** `df5-5-keep-repoint-chore.md:350-374` (amendment G), `:428-431` (Files to Modify), `:480-481` (DoD)
**Defect.** Amendment G prescribes six `deps:` rewrites and eight comment discharges in `sprint-status.yaml`. All fourteen are already in the tree at `fa7d0e26`, including the P1.9 open-question replacement whose wording DF5.5 dictates verbatim. The story records only `P1.18` as "already-applied by another hand"; the other seven rows are presented as pending work. Separately, all nine cited line numbers are off by ~18 lines.
**Failure scenario.** A developer applies DF5.5 last, per its own schedule. They open `sprint-status.yaml:92` expecting `P1.2 … deps: [P1.1]` and find `P0.2 … done 2026-07-13` (a P0 row). Best case they stop and re-derive; worst case they follow the amendment table by story key rather than by line, "repoint" `[DF3.1]` to `[DF3.1]`, and re-write the P1.9 clause a second time — producing a duplicated or contradictory historical note in the file the machines read. The DoD item at `:480` ("Amendment G applied — six … arrays repointed, all eight comments discharged") is unfalsifiable: it is already true before the story starts, so it passes whether or not the developer did anything.
**Fix recipe.** Replace `:350-353` with:

> - **Amendment G — `sprint-status.yaml` KEEP-row `deps:` repoints — ALREADY-APPLIED 2026-09-08, do not re-apply.** Verified at `fa7d0e26`: all six retired-ID arrays are already repointed (`P1.2 :110 [DF3.1]`, `P1.7 :115 [P0.6, DF1.6]`, `P1.9 :117 [DF1.6, DF1.8]`, `P1.11 :119 [P0.9, DF1.6]`, `P1.12 :120 [P0.9, DF1.6]`, `P1.14 :122 [P1.5, DF2.8]`), `P1.18 :126` already reads `[DF5.2]`, `P1.3 :111` and `P1.5 :113` carry no retired ID, and all eight rows already read `# KEEP per F14; deps repointed by DF5.5 2026-09-08`. P1.9's 2026-07-28 open question is already discharged with the prescribed clause. **The yaml is not opened for edit.** Disposition, same shape as amendments B and E: record the verification command and its output in the amendment log. AC1's third grep is a standing regression check, not a work item.

Then change `:480-481` to a verification item ("Amendment G re-verified ALREADY-APPLIED; yaml unchanged in the diff") and delete the `sprint-status.yaml` bullet at `:428-431` from Files to Modify, replacing it with a one-line "verified, not modified" note.

---

### V-DF5.5-B2 · BLOCKER · The `p1-18:50` fallback is a no-op against the make-or-break AC, and the non-fallback edit is a rejection
**File:** `df5-5-keep-repoint-chore.md:251-274` (P1.18 disposition), `:269-272` (fallback), `:117-119` (AC1), `:452-454` (INV-1)
**Defect.** `p1-18:50` carries `P1.19`, is inside `## Security Invariants` (`p1-18` headers: `47:## Security Invariants`, `53:## Definition of Done`), and is handed to DF6.1a's wave. AC1's retired-ID grep covers `p1-18` including `:50`. The fallback — "if DF6.1a's wave declines it, DF5.5 extends the blockquote above" — adds text **below the H1**, not to `:50`. `:50` therefore still matches `/P1\.19\b/` with no `DF[0-9]` on the same line, so AC1 bullet 1 returns one line and test assertions (1) and (2) both fail. The only edit that *would* satisfy AC1 is an edit to `:50` itself — which is a **sixth in-block hunk**, and INV-1 at `:454` says "Any sixth in-block hunk is a rejection on sight". Both branches fail.
**Failure scenario.** DF6.1a's wave declines the annotation (or lands after DF5.5, which nothing enforces — DF5.5 is only *scheduled* last, not gated on DF6.1a's merge). DF5.5's developer takes the documented fallback, runs AC1's grep, gets one line, and cannot pass their own make-or-break AC without violating their own INV-1. The chore stalls with no in-story resolution.
**Fix recipe.** Make the fallback actually satisfy AC1 by pre-authorising the edit as a sixth admitted in-block hunk. Replace `:269-272` with:

> *Fallback if DF6.1a's wave declines it or has not landed at apply time:* DF5.5 annotates `p1-18:50` itself — `…sufficient context for **downstream fix dispatch** (P1.19 — now **DF6.1a**, which consumes this comment payload shape but **not** this story's receiver). <!-- v5 amendment (DF5.5) -->` — and records that it took the edge back. **This is a pre-authorised sixth in-block hunk** (`p1-18`'s `## Security Invariants` block, INV-2): it is an identifier annotation drawn verbatim from the successor map, the one class INV-1 permits, and it is admitted here so the fallback is executable rather than a rejection. INV-1's "sixth in-block hunk is a rejection" therefore reads **seventh** on the fallback path, and the amendment log must state which path was taken.

Mirror the same wording in INV-1 (`:452-454`) and in the DoD `Security` item (`:493-496`).

---

### V-DF5.5-B3 · BLOCKER · `p1-3` carries 19 `P1.1` occurrences, not eight — and every verification check is line-scoped, so the shortfall is undetectable
**File:** `df5-5-keep-repoint-chore.md:196` (occurrence table), `:226-229` (blockquote instruction), `:118` (AC1 grep), `:178` (test assertions)
**Defect.** The story says "the **eight** P1.1 substitutions" and "**All eight** `P1.1` mentions in `p1-3`". Executed count:

```
p1-3:22 ×3   p1-3:24 ×5   p1-3:39 ×1   p1-3:138 ×3
p1-3:142 ×1  p1-3:147 ×3  p1-3:154 ×2  p1-3:155 ×1   = 19
```

Eight is the number of *lines*, not mentions. A developer following the instruction literally performs eight substitutions and leaves **eleven** live `P1.1` references. AC1's grep (`| grep -v 'DF[0-9]'`), test assertion (1) ("must also carry its mapped successor **on the same line**") and assertion (2) (per-pair, also same-line) are **all line-scoped**: a line reading `… (DF3.1) … P1.1's Transport Contract … P1.1 INV-4` passes every one of them. The chore's entire mechanical acceptance signal is blind to its single most likely failure mode.
**Failure scenario.** `p1-3:24` gets its first `P1.1` swapped and its remaining four left. AC1 returns zero lines, the four-assertion test is green, the DoD is signed off, and `p1-3` still tells a developer to conform to "P1.1's registration schema" and "P1.1's Transport Contract" — dead premises the audit retired. This is exactly the "unverifiable *all edges repointed*" defect the chore exists to avoid.
**Fix recipe.** Two edits.

1. Occurrence table row (`:196`), replace `Lines` and `Repoint` cells with:
   `22 (×3), 24 (×5), 39, 46, 138 (×3), 142, 147 (×3), 154 (×2), 155` /
   `**19 `P1.1` occurrences across 8 lines** → DF3.1 (per-occurrence, not per-line); P1.6 → DF1.6 (L46, ×1). Precede with the `p1-3` header blockquote. L39/L154/L155 are in-block edits (INV-1).`
2. Infra Prerequisites assertion (1) (`:178`) and DoD test item (`:499-501`), replace the same-line rule with an occurrence-count rule:
   `(1) **retired-ID occurrence scan** — across the 12 in-scope story files, `grep -oE` the retired-ID pattern per file and assert the **count of surviving occurrences is zero** for every forward-looking ID, and that each surviving *provenance* occurrence (the enumerated `p0-7:55`, `p0-9:218` pair) is immediately followed by its `(now DF<n>.<m>)` annotation **within 20 characters on the same line**. A count-based assertion, never a line-membership one: a line carrying one repointed and four surviving IDs passes a line-scoped check and MUST fail this one.`

---

### V-DF5.5-H1 · HIGH · The `sprint-status.yaml:105` corroboration quotes a string the yaml explicitly retracted
**File:** `df5-5-keep-repoint-chore.md:258-259`
**Defect.** The story writes: "`sprint-status.yaml:105` agrees (\"DF6.1 no longer depends on it: v5.0 polls `gh pr checks` host-side instead\")". The P1.18 row is at **`:126`**, not `:105`, and it reads: *"CORRECTED 2026-09-08: this line previously said v5.0 'polls `gh pr checks`', **which is wrong** — `gh pr view --json statusCheckRollup` is the SHA-binding query and carries NO `isRequired`/`bucket`… Neither alone answers the verdict question."* The story's load-bearing corroboration for the hand-off is a verbatim quotation of text that was deleted for being incorrect.
**Failure scenario.** A reviewer checking DF5.5's hand-off argument opens `:105` (a P0.11 row about the phase-0 exit gate), finds nothing, searches for the quoted string, finds only its retraction, and cannot tell whether the hand-off reasoning survives the correction. It does — but on `df6-1b`'s two-call composition, not on `gh pr checks`.
**Fix recipe.** Replace `:258-259` with:
`` `sprint-status.yaml:126` agrees ("DF6.1a/DF6.1b do not depend on it, and each denies it for a DIFFERENT reason … DF6.1a denies the receiver as an INTAKE channel (it reads PR comments directly through the GitHub API), DF6.1b denies it as a VERDICT channel"). Note that row's own 2026-09-08 correction: the earlier "v5.0 polls `gh pr checks`" wording is retracted — DF6.1b specifies a two-call composition — which does not disturb the severance. ``

---

### V-DF5.5-H2 · HIGH · Four of five DF6.1a/DF6.1b line citations point at the wrong lines
**File:** `df5-5-keep-repoint-chore.md:251-257`

| Citation | Story's claim | Actual content at that line | Verdict |
|---|---|---|---|
| `df6-1a:52` | "takes 'a `botComments[]` payload (the shape P1.18 defines, `p1-18:36`, without its receiver)'" | **blank line** | WRONG |
| `df6-1a:114-115` | the P1.18 intake-channel denial + `scripts/fix-run.ts --pr <n>` | a blockquote about `recordAuditLink`/`walkAuditChain` and DF5.3 | WRONG |
| `df6-1b:114-115` | "the same denial keyed on the verdict poll" | *"**P1.18 is not a predecessor — the *verdict* limb.** Its webhook receiver is out of scope for v5.0 … the verdict is **polled**, and a poll needs no receiver"* | **CORRECT** |
| `df6-1b:158-159` | "the AC1 webhook exclusion" | poll-window / `ci-verdict-unavailable` semantics | WRONG |
| `df6-1b:213` | "the Trigger Surface row" | a negative control about an audit-chain walker | WRONG |

**Defect.** The re-verification gate at `:99-111` claims it "fired once, on 2026-09-08" and that "every DF6.1 citation below has been re-pointed accordingly". The gate ran and produced four dangling citations. The hand-off argument — DF5.5's justification for *not* satisfying part of its own make-or-break AC — rests on quotations a reader cannot locate.
**Failure scenario.** A reviewer verifying the hand-off before letting DF5.5 skip `p1-18:50` opens `df6-1a:52`, finds a blank line, and must either re-derive the whole argument or reject the hand-off. Both cost the exact review time the citations exist to save.
**Fix recipe.** Re-derive each citation by symbol, then pin it. Concretely: cite `df6-1b:114-115` as-is (verified), and replace the other four with `grep`-derived anchors rather than line numbers — e.g. `` df6-1a (search `botComments[]`) `` and `` df6-1b (search `P1.18 is not a predecessor`) ``. Add to the re-verification gate at `:107`: "**and re-run every cross-story line citation in §Technical Notes** — a citation that does not resolve to the quoted text is drift and is recorded before the first edit."

---

### V-DF5.5-H3 · HIGH · AC4's no-dangling-pointer precondition does not cover two IDs the amendments write
**File:** `df5-5-keep-repoint-chore.md:91-97` (canonical set), `:150-156` (AC4), `:464` (INV-4)
**Defect.** AC4 says "**every successor ID written by any amendment** — the canonical successor set declared in §E2E Slice". The canonical set is `DF1.3, DF1.5, DF1.6, DF1.8, DF2.8, DF3.1, DF5.2, DF5.3`. But amendment C's `p1-9` blockquote writes **`DF2.10`** and **`DF1.10`** into a KEEP file (`:307-308`: "DF2.10 ships `qds-run@.service` with **`Restart=no`** … and DF1.10 owns reclaim semantics"), and amendment F's blockquote writes **`DF1.10`** into `p1-11` and `p1-12` (`:344`). Neither is in the set, so INV-4's "a successor ID is written only after its story file is confirmed present on disk" is not enforced for them.
**Failure scenario.** Both are `done` today, so nothing dangles now. But the ADR arc already renamed DF1.10↔DF1.11 once (the story itself warns about this at `:29-31`), and DF5.5 is scheduled *last*. A future renumber of a done story leaves DF5.5 writing an unchecked pointer, and the story's stated guarantee — "the chore stops and records the missing ID rather than writing a dangling pointer" — is silently false for exactly the two IDs the renumbering warning is about.
**Fix recipe.** Change `:92-93` to:
`DF1.3, DF1.5, DF1.6, DF1.8, DF2.8, DF3.1, DF5.2, DF5.3 — plus **DF1.10** and **DF2.10**, written as *cited context* by amendments C and F rather than as edges (both `done`; included because AC4's precondition is over IDs the amendments write, and INV-4 does not distinguish an edge from a citation). — the successor IDs this chore actually writes into a file…`
and in AC4 (`:151`) change "(amendments A, C, D and F; cited, not restated here)" to "(amendments A, C, D and F, **including the two context IDs DF1.10 / DF2.10**; cited, not restated here)".

---

### V-DF5.5-H4 · HIGH · `sprint-status.yaml`'s DF5.5 `deps:` contradicts the story's canonical set
**File:** `sprint-status.yaml` DF5.5 row vs `df5-5-keep-repoint-chore.md:91-97`
**Defect.** yaml: `deps: [DF1.3, DF1.5, DF1.6, DF1.8, DF2.8, DF3.1, DF5.2, DF5.3, **DF6.1a, DF6.1b**]`, with the trailing comment "the edges are the successor IDs amendments A, C and D actually write (E retired as already-satisfied)". The story says the opposite twice: "**DF6.1 is no longer in this set** — `p1-18:50` is handed off" (`:94`), and Files to Modify "L50 is not edited by this story" (`:417`). The yaml comment also omits amendment **F** (which writes DF1.6/DF1.10) and amendment **G**.
**Failure scenario.** The two artifacts disagree about whether DF5.5 is blocked on DF6.1b. If the yaml wins, DF5.5 waits on a story that writes none of its successor IDs. If the story wins, the yaml's dependency graph is wrong for anyone doing sequencing off the machine-readable file — which is what it is for.
**Resolution and authority.** The **yaml is right about DF6.1a and wrong about DF6.1b.** DF5.5's AC1 grep covers `p1-18:50`, which DF6.1a's wave must annotate first, so DF6.1a *is* a genuine scheduling edge even though DF5.5 writes no DF6.1a ID itself. DF6.1b writes nothing DF5.5 depends on. The **story** is authoritative for the canonical *successor* set (it is the list AC4 checks); the **yaml** is authoritative for scheduling.
**Fix recipe.** In the yaml, set `deps: [DF1.3, DF1.5, DF1.6, DF1.8, DF2.8, DF3.1, DF5.2, DF5.3, DF6.1a]` and change the comment to `# v5-S3 — applied last. Edges = the successor IDs amendments A, C, D and F write, plus DF6.1a, whose wave owns the p1-18:50 annotation DF5.5's AC1 grep asserts. E retired as already-satisfied; G already-applied.` In the story, add to `:94` after "DF6.1 is no longer in this set": `DF6.1a is a **scheduling** edge (its wave must annotate `p1-18:50` before AC1's grep can pass) but not a successor-set member, and DF6.1b is neither.`

---

### V-DF5.5-M1 · MEDIUM · INV-1's "five in-block edits" is four
**File:** `:452-454`, `:493-496`
`p1-11:48` is in `## Technical Notes` (`p1-11` headers: `27:## Acceptance Criteria`, `37:## Technical Notes`, `55:## Files to Modify`). It *discusses* AC1/INV-MEM-2 but is not inside an AC, DoD or Security-Invariant block. The real in-block set is `p1-3:39` (AC4, block 34-43), `p1-3:154`/`:155` (DoD, 152-188), `p1-12:31` (AC3, block 27-34) — four. "Any sixth in-block hunk is a rejection on sight" therefore counts against a baseline one too high, so a genuine fifth in-block hunk slips past the tripwire.
**Fix:** change "The five known in-block edits are" to "The **four** known in-block edits are **`p1-3:39`** (AC4), **`p1-3:154`** and **`p1-3:155`** (DoD), and **`p1-12:31`** (AC3). (`p1-11:48` sits in that file's `## Technical Notes`, not in a governed block, and is counted separately.) **Any fifth in-block hunk is a rejection on sight.**" Mirror in the DoD item.

### V-DF5.5-M2 · MEDIUM · The gloss rule and the `p1-3` blockquote contradict each other
**File:** `:216-222` (gloss rule, "applies to every repointed line, not just `p1-2`") vs `:229` ("Insert once, then substitute").
`p1-3`'s lines carry heavier glosses than `p1-2:26` ever did — "the A2A delegation layer (P1.1)", "per the P1.1 enum extension", "the local-only Transport Contract enforced by P1.1 INV-4", "P1.1's registration schema", "P1.1's envelope helper". Bare substitution produces exactly the lie the gloss rule was written to prevent, on eight lines instead of one. The blockquote mitigates the *reading* but not the *text*.
**Fix:** append to `:235`: "Because the gloss rule applies to every repointed line, the substitutions in `p1-3` are **not** bare: each becomes `DF3.1` followed by `(was P1.1's <gloss>; that A2A surface is historical — see the amendment above)` on first occurrence per line, and bare `DF3.1` thereafter. Record before/after for all 19 occurrences in the amendment log."

### V-DF5.5-M3 · MEDIUM · The same JSON-RPC error-code allocation is classified two ways
**File:** `:203` (`p0-9:218` = PROVENANCE, keep + annotate) vs `:196`/`:231-235` (`p1-3:142` = forward-looking, substitute).
Both lines allocate the identical range: `p0-9:218` "The P0.9 range is distinct from P1.1 (`-32010..-32013`)"; `p1-3:142` "A2A-level errors (`-32010` through `-32013`) from P1.1 may propagate". One fact, two treatments. Under the story's own rule ("a shipped … requirement quoted in a snippet keeps the old ID"), `p1-3:142` is provenance.
**Fix:** carve `:142` out of the p1-3 substitution set in the occurrence table row and add: "`:142` is a **provenance** line — the same `-32010..-32013` allocation `p0-9:218` records — so it keeps `P1.1` and gains `(now DF3.1)`, identical treatment. The other 18 occurrences are forward-looking and repointed."

### V-DF5.5-M4 · MEDIUM · Spec Reference points at the superseded DD-2 and never names DD-2a, which already exists
**File:** `:22-24`, `:272-274`, `:484-485`.
`register:48` is **DD-2a**, an ACCEPTED amendment that already records the DF6.1 split, the dangling ID, and the `p1-18:50` ownership assignment to DF6.1a. DF5.5 cites only DD-2 (`:47`) and presents the register addendum as pending work routed to "the campaign's register-amendment output". It is already landed.
**Fix:** `:22-24` → "**DD-2** (`:47`, superseded) and **DD-2a** (`:48`, the 2026-09-08 amendment that supersedes it — DF6.1 split, `p1-18:50` re-pointed to DF6.1a and assigned to DF6.1a's wave)". DoD `:484-485` → "The DD-2 supersession is recorded in the amendment log; **DD-2a is already landed at `register:48`** — verified, no register edit is owed."

### V-DF5.5-M5 · MEDIUM · The cited sizing row is stale in two ways and carries no erratum
**File:** `:32-33` cites `R5 §1.5`; `R5-dependency-sizing.md:89` reads "`| DF5.5 | KEEP-repoint chore (dep edges + 2 enum citation fixes + 3 boundary amendments) | 2 | chore |`". The enum fixes are NOT-FOUND (amendment B), there are now five amendment families plus a retired one, and the points are 3.
**Fix:** append to `:33`: "(R5 §1.5's row still reads `2 | dep edges + 2 enum citation fixes + 3 boundary amendments`; both the estimate and the enum-fix scope are superseded — see the re-estimate note above and amendment B. R5 is a closed research record and is not edited (INV-3).)"

### V-DF5.5-M6 · MEDIUM · The epics index carries a second, divergent statement of the make-or-break AC
**File:** `_bmad-output/implementation-artifacts/epics-and-stories-dark-factory-v5.md:671` — "**(make-or-break)** After amendments **A–E**, the specified grep across **all 11 KEEP files plus P0.7** (amendment D) — 12 files". No F, no G, and it frames the amended set as "11 KEEP + P0.7 = 12" where the story's marker count is 11 amended (P0.5 excluded). Two sources of truth for the same AC.
**Fix:** add to the story's Trigger Surface as an out-of-scope row with a named owner — `| epics-and-stories-dark-factory-v5.md:671 (stale A–E framing, no F/G) | out-of-scope | — | Phase 3 wrap-up, with DF2.11/DF2.12/DF3.6a/DF6.1a/DF6.1b, all of which are also absent from that file |` — so the divergence is owned rather than merely surviving.

### V-DF5.5-M7 · MEDIUM · No `**Status:**` header
**File:** `df5-5-keep-repoint-chore.md:1-13`. DF2.11 and DF2.12 both carry `**Status:** ready-for-dev`; DF5.5 has Points and Sprint only. The yaml says `ready-for-dev`.
**Fix:** insert after `:3`: `\n**Status:** ready-for-dev\n`.

### V-DF5.5-L1 · LOW · "13+ paths" is an illustration that can only rot
`:83` — today the unscoped `grep -rl` returns 3 paths (this story, the epics doc, `scan-E-df5-5.md`); after the chore it returns 15. "13+" is true but arbitrary. Prefer "strictly more than 11".

### V-DF5.5-L2 · LOW · `p1-18:36` cited as "the shape P1.18 defines"
`:36` is the webhook payload / bot-detection contract (`comment.user.type`, `user.type === "Bot"`). Defensible as "the shape", but the citation is DF6.1a's, quoted second-hand, and inherits H2's unverified status.

---

# PART 2 — DF2.11 (Teardown Run-Lock Capability + Read-Only Cost Ledger)

File: `_bmad-output/sprint-artifacts/dark-factory-v5/stories/df2-11-teardown-lock-readonly-ledger.md` (438 lines)

## 2.1 Counts

| Severity | Count | IDs |
|---|---|---|
| BLOCKER | 1 | V-DF2.11-B1 |
| HIGH | 3 | V-DF2.11-H1, H2, H3 |
| MEDIUM | 4 | V-DF2.11-M1 … M4 |
| LOW | 2 | V-DF2.11-L1, L2 |

## 2.2 Independent verdict on the claimed defects: **BOTH REAL**

**Defect 1 — unlocked teardown. CONFIRMED.**
- `src/providers/teardown.ts:463` — `export async function teardownSandbox(deps: TeardownDeps, runId: string, opts: TeardownOptions = {}): Promise<void>` — exactly as claimed, no lock parameter, no internal acquisition.
- Seven production callers, exactly the seven tabulated: `reaper.ts:726`, `cap-hit-demo.ts:494/:539/:1174`, `sandbox-teardown.ts:290`, `fanout-primitive.ts:1328`, `fleet.ts:4578`.
- `src/providers/reaper.ts` — `grep -nE 'acquireRunLock|releaseRunLock|RunLock|run-lock|\.lock'` returns **nothing**. Zero lock symbols confirmed.
- Lock-holding callers verified: `fleet.ts:4257` acquire / `:4562` mark / `:4595` clear; `sandbox-teardown.ts:230` / `:288` / `:294`.
- Non-re-entrancy verified: `RunLockReentrantError` at `run-lock.ts:72-78`, guard `if (moduleState().held.has(lock)) throw new RunLockReentrantError(lock)` at `:951`, `resolve(runsDir, \`${runId}.lock\`)` at `:950`, `assertValidRunId` at `:937`, `return lock` at `:965`. Every single citation is exact.
- The consequence the story claims is real: teardown's order is harvest → destroy, and D8 makes harvest the only path work leaves a box, so a lost race is an irreversible loss of a run's only copy of its work. `df3-8-host-completion-watcher.md:79` (AC2e) and `:136` (INV-IBOX-18) independently document the same gap and already name DF2.11 as its owner.

**Defect 2 — the constructor mutates. CONFIRMED.**
`src/providers/cost-ledger.ts:874-934`: `mkdirSync(dir, {recursive:true, mode:0o700})` `:885` → `chmodSync(dir, 0o700)` → `statSync` mode assertion → `const isNew = !existsSync(this.path)` `:895` → `new Database(this.path)` `:898` (creates when absent) → `chmodSync(this.path, 0o600)` → mode assertion → `PRAGMA journal_mode = WAL` → `db.exec(SCHEMA)`. INV-COST-6's guard at `:900-905` covers only `ledger-unopenable`; nothing covers `ledger-absent`. `readRunCost` is a method at `:1335`, confirming DF5.3-H1. `df5-4-lights-on-gate.md:111` and `:144-146` independently document the same and already route C10 through DF2.11's `openReadOnly`.

**No ADR contradiction.** Nothing in the ADR or Appendices A/B bears on the lock parameter or the read-only path.

## 2.3 Findings

### V-DF2.11-B1 · BLOCKER · The prescribed `qds-cost.ts` deletion replaces a TOCTOU-hardened probe with the check-then-act it was built to remove
**File:** `df2-11-teardown-lock-readonly-ledger.md:338-340` (Files to Modify), `:395-396` (DoD Contract), `:262` (AC5's refusal mechanic)
**Defect.** The story says: *"`scripts/qds-cost.ts` — reads through `openReadOnly`; its existing **`existsSync` pre-check** (added in DF2.8's review round as a workaround for exactly this defect) is **deleted**."* There is no `existsSync` pre-check. `grep -n existsSync scripts/qds-cost.ts` returns exactly one hit — `:276`, inside a comment that says the opposite:

```
scripts/qds-cost.ts:276   // The pre-check is a NO-CREATE open, not existsSync(): both answer "is it
                    277   // there", but the open also yields the inode that answer was about — which
                    278   // is what closes the C5 race. CostLedger CREATES a missing db (and migrates
                    279   // its schema), so a ledger removed between an existence check and the open
                    280   // came back as a brand-new empty database and read as a confident ZERO
                    281   // SPEND, exit 0.
```

The shipped guard is `openSync(ledgerPath, "r")` → `fstatSync(fd).ino` → **the fd is deliberately held open across the `CostLedger` construction** (`:283-290`: *"With the fd closed early, a replace-and-restore across the CostLedger open window could forge that equality — the restored copy is a new inode wearing the old number"*) → post-construction inode identity verdict. Meanwhile DF2.11's own `openReadOnly` spec at `:262` is `(1) existsSync(path) → refuse ledger-absent when false … (2) new Database(path, { readonly: true })` — a bare existence check followed by an open, which is precisely the check-then-act the shipped comment records as the bug that was fixed.
**Failure scenario.** DF2.11 lands. `qds-cost` now calls `openReadOnly`. `{ readonly: true }` does close the *creation* half (a missing file refuses instead of materialising). But the *identity* half is gone: between `existsSync(path)` returning true and `new Database(path, {readonly:true})` opening, an attacker or a careless operator script replaces `.sandbox/cost-ledger.db` with a different file. `qds cost` reports that file's totals as the run's authoritative spend, with no inode check to catch it — on the same ledger the budget cap and DF5.4's C10 read. The story deletes a security control while describing it as a workaround.
**Fix recipe.** Two changes.

1. Replace `:338-340` with:
   `- \`scripts/qds-cost.ts\` — reads through \`openReadOnly\`. Its existing pre-check is **NOT** an \`existsSync\` check and is **not deleted**: it is a no-create \`openSync\`+\`fstatSync\` inode probe whose fd is held open across construction and compared afterwards (\`:276-300\`), which closes the C5 replace-and-restore race that a bare existence check cannot. It is **retained and moved inside \`openReadOnly\`** so every reader inherits it, not just this CLI.`
2. Replace AC5's step (1) at `:262` with:
   `(1) a **no-create open** — \`openSync(path, "r")\`, refusing \`ledger-absent\` on \`ENOENT\` — whose fd is **held open** until the post-construction \`fstatSync(db-fd).ino === probedIno\` verdict, refusing \`ledger-identity-changed\` on mismatch; **never a bare \`existsSync\`**, which is the check-then-act \`qds-cost.ts:276-281\` records as already-fixed;`
   and add an AC5 negative control: `*Negative control: an implementation whose refusal is \`existsSync(path)\` followed by an open passes every absent-ledger test and MUST fail a test that swaps the file between the two calls.*`

---

### V-DF2.11-H1 · HIGH · AC1's second negative control describes a failure mode that cannot occur
**File:** `:114-117`
**Defect.** *"a `RunLockHandle` declared as a bare `string` alias, under which **every existing unlocked call keeps compiling** and the gate is decorative."* False. With `lock: RunLockHandle` as a **required** third parameter, `teardownSandbox(deps, runId)` fails on **arity** — `TS2554: Expected 3-4 arguments, but got 2` — regardless of whether `RunLockHandle` is branded or a plain alias. What a plain alias actually loses is the *value* guarantee: `teardownSandbox(deps, runId, "not-a-lock")` compiles. The negative control names the wrong symptom.
**Failure scenario.** A developer writes the negative-control test to the description: assert that a 2-argument call fails under a plain alias. It does fail, the test is green, and the branding is never actually exercised. The typecheck gate then permits `teardownSandbox(deps, runId, someRandomPath)` — a "lock" nobody holds — while AC1 reads as satisfied.
**Fix recipe.** Replace `:114-117` with:
`*Negative controls, both MUST fail: a \`lockHeld?: boolean\` option (a caller can pass \`true\` while holding nothing); and a \`RunLockHandle\` declared as a plain \`type RunLockHandle = string\` alias — under which the arity check still catches a 2-argument call, but \`teardownSandbox(deps, runId, "/tmp/anything")\` **compiles**, so the capability degrades to a positional convention. The pinned assertion is therefore two directives, not one: a \`// @ts-expect-error\` on the 2-arg call **and** a \`// @ts-expect-error\` on a call passing a bare string literal in the lock position.*`

---

### V-DF2.11-H2 · HIGH · Undeclared collision with DF2.12 on the same two files
**File:** `:320-345` (Files to Modify) vs `df2-12:336-348`
**Defect.** DF2.11 and DF2.12 are both `v5-S3`, both `ready-for-dev`, and both modify `src/providers/teardown.ts` and `tests/providers/teardown.test.ts`. DF2.11 also modifies `src/providers/cost-ledger.ts` and `tests/providers/cost-ledger.test.ts`; so does DF2.12. Neither story names the other anywhere. Neither `sprint-status.yaml` row carries an edge to the other (`DF2.11 deps: [DF2.5, DF2.8]`, `DF2.12 deps: [DF1.6, DF2.5, DF2.7, DF2.8]`). DF2.11 changes `teardownSandbox`'s signature and rewrites **53** call sites in `tests/providers/teardown.test.ts`; DF2.12 adds ingest calls at `teardown.ts:608` and `:757` plus new assertions in the same test file.
**Failure scenario.** Both are picked up in the same sprint, as their identical tag invites. Whichever merges second rebases onto a `teardown.test.ts` where every `teardownSandbox(...)` call gained a third argument, producing a 53-site conflict in a test file, plus a conflicting edit to `emitTokenBridgeState`'s contract (DF2.11 requires it read-only on the `openReadOnly` path at `:258`; DF2.12 AC6 inverts its meaning). The conflict is discovered at merge, not at planning.
**Fix recipe.** Add to DF2.11's `**Dependency edges (predecessors):**` block at `:94-96`:
`**Sequencing note (not an edge): DF2.12 edits the same two files.** DF2.12 adds two ingest calls at \`teardown.ts:608\`/\`:757\` and assertions in \`tests/providers/teardown.test.ts\`, where this story rewrites 53 call sites. **This story lands first** — its signature change is mechanical and total, DF2.12's is additive at two points — and DF2.12 rebases onto the new signature. Recorded here and in DF2.12 so the order is a decision, not a merge accident.`
Add the mirrored note to DF2.12 and record the ordering in both yaml row comments.

---

### V-DF2.11-H3 · HIGH · 3 points is not honest against 53 test-call-site migrations, and the story has no estimate-honesty paragraph
**File:** `:3` (Story Points), `:347-354` (blast radius), `:341-345` (test files)
**Defect.** `grep -rn 'teardownSandbox(' tests | wc -l` → **53**. The story's blast-radius paragraph frames these as a virtue ("Every one of those is a **compile-time** break by construction — which is the point") without costing them. The 3 points must cover: a branded type + module-private symbol; `withRunLock`; a required parameter and a mismatch assertion on `teardownSandbox`; 7 production migrations across 5 files, three of which need bespoke refusal arms (reaper skip/stale classification, fan-out per-loser arm, cap-hit's never-throws cleanup contract); 53 test call-site migrations; a `GateDeps.teardown` docblock; `static openReadOnly` with a WAL-recovery refusal path; `#readOnly` guards on three methods; three new error codes; and changes across **eight** test files. DF2.12, a strictly smaller change, carries an explicit "Estimate honesty" paragraph; DF2.11 carries none.
**Failure scenario.** The story is pulled as a 3 and discovered mid-sprint to be a 5–6, at the point where 53 mechanical test edits are half-done and the branch cannot be abandoned cleanly.
**Fix recipe.** Add after `:293`:
`- **Estimate honesty.** 3 points covers the design (the brand, the wrapper, the required parameter) and the 7 production migrations. It does **not** independently cost the **53** \`teardownSandbox(\` call sites in \`tests/\` that the required parameter breaks by construction (\`grep -rn 'teardownSandbox(' tests | wc -l\` → 53 at \`fa7d0e26\`), nor the read-only ledger's WAL-refusal path. If the test migration cannot be done with a mechanical codemod plus one shared \`h.lock\` fixture, this is a **5**. Flagged here rather than discovered mid-sprint.`

---

### V-DF2.11-M1 · MEDIUM · The story silently inverts a shipped `ponytail:` design decision it never cites
`scripts/lib/run-lock.ts`, in `acquireRunLock`'s own docblock: *"ponytail: library callers bypass the lock — the CLIs are the operator surface. **Upgrade trigger: an embedder (not a CLI) becomes a supported caller.**"* DF2.11 makes the lock mandatory for every caller including library ones — which is that upgrade trigger firing — but never mentions the marker. Left in place, the comment contradicts the code it sits on.
**Fix:** add to Technical Notes after `:213`: `- **This fires \`run-lock.ts\`'s own documented upgrade trigger.** \`acquireRunLock\`'s docblock carries \`ponytail: library callers bypass the lock — the CLIs are the operator surface. Upgrade trigger: an embedder (not a CLI) becomes a supported caller.\` \`src/providers/reaper.ts\` and \`src/fleet/fanout-primitive.ts\` are exactly that embedder, reached from \`sandbox-reap\` and \`fleet fanout\` without a CLI-level lock. The marker is **replaced**, not deleted, with: \`// the lock is now a required capability of teardownSandbox (DF2.11) — library callers cannot bypass it\`.` Add the replacement to Files to Modify and to the DoD.

### V-DF2.11-M2 · MEDIUM · "Pass the handle it already has; no other change" is not true for sites 1 and 2
Migration rows 1 and 2 (`:232-233`). At `scripts/fleet.ts:4257` and `scripts/sandbox-teardown.ts:230`, `lock` is assigned to a variable declared earlier (both sites clear it in a later block — `fleet.ts:4595`, `sandbox-teardown.ts:294` — and both wrap the acquire in `try`/`catch`), so its declared type is `string | undefined` or `string`. Under the narrowing of `acquireRunLock`'s return type, both declarations must be re-typed to `RunLockHandle | undefined`, and both call sites need a definite-assignment narrowing before the handle can be passed. That is a real edit at both sites, contradicting "no other change".
**Fix:** change both `Migration` cells to `re-type the existing \`lock\` declaration to \`RunLockHandle | undefined\` and narrow before the call; then pass the handle it already has. No lifecycle change.`

### V-DF2.11-M3 · MEDIUM · AC6's mtime-identity snapshot is under-specified against a live `-shm`
AC6 (`:149-155`) snapshots "the sorted entry names, each entry's `mode & 0o777` and each entry's `mtimeMs`" of the whole ledger *directory*. `assertQueryable()` (`cost-ledger.ts:1483`, kept on the read path per `:264`) executes `SELECT 1 FROM cost_events LIMIT 1`. On a healthy WAL database with an existing `-shm`, a read-only connection maps the shm; the story only addresses the *recovery-required* case. The assertion as written can go flaky on the `-shm` entry.
**Fix:** narrow the snapshot in AC6 to `path` and `dirname(path)` plus the `-wal` sibling, and state the `-shm` carve-out explicitly: `the snapshot covers the ledger file, its directory entry and the \`-wal\` sibling; \`-shm\` is excluded and its exclusion is asserted as deliberate, because a read-only connection may map it and it carries no rows (harvest.ts:195's reasoning, restated).`

### V-DF2.11-M4 · MEDIUM · `emitTokenBridgeState` is re-specified by two stories with no edge between them
`:258` requires `openReadOnly` to serve `emitTokenBridgeState`. DF2.12 AC6 (`:155-165`) inverts that method's meaning and changes its message. Both are v5-S3 with no mutual edge. See H2 for the sequencing fix; additionally, DF2.11 should state that it consumes the method's *behaviour* (read-only) and takes no position on its *message*.
**Fix:** append to `:258`: `(DF2.12 reclassifies this method's **message**; this story depends only on its being read-only, which both readings preserve.)`

### V-DF2.11-L1 · LOW · `approval-gate.ts:840` is a docblock line
`:840` is inside the `GateDeps.teardown` docblock (`* \`(runId, opts) => teardownSandbox(tdeps, runId, opts)\`. Optional because…`), not the property declaration. Harmless, resolvable, but cite the symbol.

### V-DF2.11-L2 · LOW · Neighbouring stories now cite different line numbers for the same symbols
DF3.8 (`:79`) and DF3.7 (`:128`) cite `run-lock.ts:66-79` / `:952` for `RunLockReentrantError` and its guard; DF2.11 cites `:72-78` / `:951`. **DF2.11 is correct.** Not DF2.11's defect, but worth a one-line note so the next reader does not "fix" the right one.

---

# PART 3 — DF2.12 (Per-Role Token Cost Attribution)

File: `_bmad-output/sprint-artifacts/dark-factory-v5/stories/df2-12-token-cost-attribution-wiring.md` (435 lines)

## 3.1 Counts

| Severity | Count | IDs |
|---|---|---|
| BLOCKER | 1 | V-DF2.12-B1 |
| HIGH | 3 | V-DF2.12-H1, H2, H3 |
| MEDIUM | 4 | V-DF2.12-M1 … M4 |
| LOW | 2 | V-DF2.12-L1, L2 |

## 3.2 Independent verdict on the claimed defect: **REAL**

**What actually writes token rows today: nothing.** `grep -rn 'ingestCostEvent' src scripts tests` returns, outside `cost-ledger.ts` itself, only: five prose/comment mentions in `cost-ledger.ts` (`:18`, `:313`, `:1144`, `:1438`, `:1458`), one comment in `scripts/qds-cost.ts:396`, and test callers. **Zero production callers.** Confirmed.

Every citation verified exact:

| Claim | Verified |
|---|---|
| `ingestCostEvent` at `cost-ledger.ts:961` | ✅ `ingestCostEvent(event: CostWireEvent, ctx: IngestCtx): IngestResult` |
| `qds-cost.ts:396` comment | ✅ verbatim: `// nothing calls \`ingestCostEvent\`, so a ledger with no \`kind='tokens'\` row` |
| `cost-ledger.ts:1438` docblock | ✅ `* \`ingestCostEvent\` is the only writer of those rows, and nothing in the` |
| ponytail marker `:1456-1460` | ✅ verbatim, incl. "Upgrade path: one `ingestCostEvent` call at the dispatcher site" |
| `tests/providers/cost-ledger.test.ts:11-13` | ✅ "while F001 stands, nothing outside these tests calls ingestCostEvent" |
| `teardown.ts` `reportSpendDivergence:545`, `unwired:567`, ingest points `:608`/`:757`, divergence calls `:619`/`:771`, `ingestBoxHoursIfAttributed:482-502` | ✅ all six exact |
| `harvest.ts` `BOX_HOME_SOURCES:166-172`, `"$home/$runId".engine.log` at `:169`, no-collision doc `:174-195`, `pullArtifacts` dest `:1068` | ✅ all exact |
| `pipeline-run.ts:121` imports `dispatchTask`; `engineLogFd:289`, fd-2 tee `:591-600`, path `:2306-2310` | ✅ all exact |
| `dispatch-task.ts` `defaultLog:55-57`, `case "cost":469` | ✅ |
| `team-event-adapter.ts` `CostTraceEvent:45-50`, `case "cost":159` | ✅ |
| `steering.ts` `spendMicros:212-213`, `meter:448-456`, `meter(reply.usage):894` | ✅ |
| `CostRole:665`, `usdToMicros:270`/`:274-277`, `key-hash-missing:969-976`, `hasTokenRows:1407`, `SCHEMA:323-345` | ✅ all exact |

**Placement under the ADR: correct.** The ledger is host-side (design §6 item 4), the dispatcher runs in-box (`pipeline-run.ts:121` imports `dispatchTask`; the unit is `qds-run@<runId>.service`), and D8 forbids a credential in the box. The two-leg split is the only reading the ADR permits, and the story correctly identifies the shipped ponytail marker's "one call at the dispatcher" as pre-ADR. **No ADR contradiction.**

**Evidence path survives reboot and teardown: yes, with the stated ceiling.** `$HOME/<runId>.engine.log` is ext4 and is already in `BOX_HOME_SOURCES:169`, so harvest pulls it with no manifest change and no new collision argument. A destroy that precedes a harvest loses it — the story names that ceiling and gives it AC4's `tokens-not-harvested` treatment.

**Idempotency and abort semantics preserved: yes.** The two calls go at the two *existing* ingest points (`:608` early path, `:757` close step), immediately before `ingestBoxHoursIfAttributed`, so DF2.8 AC6's semantics extend unchanged and a teardown that aborts before close writes neither.

**The 15%-ratio constraint: honoured.** `R5-dependency-sizing.md:462-464` verbatim: *"D4's 15%-of-run-total tripwire is a RATIO TRAP … **Never write the 15% ratio into an AC.**"* DF2.12 writes no threshold, no ratio constant and no refusal path; AC3 is written as *computability*. Compliant.

## 3.3 Findings

### V-DF2.12-B1 · BLOCKER · The MANDATORY e2e demo cannot exercise the in-box leg at all
**File:** `:427-431` (DoD e2e), `:112-122` (AC1), `:388-390` (DoD Impl)
**Defect.** The e2e demo says: *"drive one real lead + 2-worker + armed-resident run through dispatch → completion → teardown **against the `fake` driver** and a fresh ledger."* The attribution line reaches `$HOME/<runId>.engine.log` **only** because `scripts/pipeline-run.ts` tees fd 2 into it (`engineLogFd` declared `:289`, written `:591-600`, path derived `:2306-2310`). `pipeline-run.ts` is the in-box systemd unit. Under the `fake` driver there is no box, no systemd unit, no `pipeline-run.ts`, no fd-2 tee, and no `$HOME/<runId>.engine.log` for `pullArtifacts` to pull. The only way to produce the harvested log under a fake driver is to write it by hand.
**Failure scenario.** The demo is run, a fixture `<runId>.engine.log` is hand-placed in the fake box's harvest source, the host leg reads it, rows land, `qds cost` prints a multi-role split, and the artifact is captured. Every AC passes. Meanwhile the emission side — the one line in `dispatch-task.ts` that must actually reach fd 2 and survive the tee — has never run in the shape production uses it. AC1's own negative control ("today's box-hours-only ledger MUST fail") passes against a hand-placed log, so the false green is invisible. This is the exact failure the story's Overview says it exists to end: a control that is "written down, declared in the code, and never armed".
**Fix recipe.** Split the demo into two arms, one of which must be live. Replace `:427-431` with:

`- [ ] **Test (e2e demo — MANDATORY, two arms, both required):** **(a) Host-leg arm, \`fake\` driver:** given a hand-authored \`<runId>.engine.log\` fixture placed on the fake box's \`$HOME\` harvest source, drive teardown to its close step and capture the \`qds cost qds/demo#42\` multi-role µ$ split, the run's resident-share figure, and the ledger row set (one row per line plus exactly one \`box_hours\` row); re-run teardown and capture the zero-row delta. **(b) In-box-leg arm, REAL box (TIER-2, \`qds-live-e2e\`):** drive one real lead + 2-worker + armed-resident run on an exe.dev box through \`qds-run@<runId>.service\`, then \`bun scripts/sandbox-teardown.ts <run-id>\`, and capture **the harvested \`<runsDir>/<runId>-artifacts/<runId>.engine.log\` itself** showing one \`cost_attribution\` line per cost event, plus the resulting ledger rows. **Arm (a) alone is a false green** and MUST NOT be the evidence for AC1: the fd-2 tee that carries the line to a durable surface lives in \`pipeline-run.ts:591-600\`, which the fake driver never runs.`

Add the matching live-round cost note to Infra Prerequisites and re-check the estimate (see H3's neighbour, DF2.11-H3, for the pattern).

---

### V-DF2.12-H1 · HIGH · The attribution line's durability is a property of `pipeline-run.ts`, not of the code the story edits
**File:** `:205-210` (in-box surface), `:388-390` (DoD Impl), `:359-364` (INV-COST-8)
**Defect.** `src/phase-engine/phases/dispatch-task.ts:90` declares `log?: (line: Record<string, unknown>) => void` — **optional** — and `:261` reads `const log = deps.log ?? defaultLog`. Production is durable only because `scripts/pipeline-run.ts:2144` calls `dispatchTask(spec, { tracer, requestId, rootDir: cwd })` without injecting `log`, so `defaultLog` (`:55-57`, `process.stderr.write`) is used and the fd-2 tee catches it. But `dispatchTask` is exported from the public barrel at `src/phase-engine/index.ts:96`. Any caller — a test, a future host-side path, a tool — that injects a logger writes the attribution nowhere and the run silently reports `tokens-not-harvested`. No AC and no invariant pins this.
**Failure scenario.** A later story adds a second `dispatchTask` caller with a structured logger (the obvious thing to do with an injectable logger). Every `tests/phase-engine/dispatch-task.test.ts` assertion still passes — those tests inject a spy logger by construction, which is exactly the configuration that loses the row. Production quietly returns to box-hours-only, `emitTokenBridgeState` fires its now-inverted "broken bridge" alarm, and nobody can tell it from an unharvested box.
**Fix recipe.** Add an invariant and an AC clause.

INV, after `:364`:
`- **INV-COST-10 (the attribution line's durability is asserted, not inherited):** the emission is durable only when \`dispatchTask\`'s logger is the default stderr writer that \`scripts/pipeline-run.ts\` tees into \`$HOME/<runId>.engine.log\` (\`dispatch-task.ts:90\` makes \`log\` **optional**, \`:261\` falls back to \`defaultLog\`, and \`dispatchTask\` is exported from \`src/phase-engine/index.ts:96\`). The attribution emission therefore does **not** go through the injectable \`log\` seam: it goes through a dedicated \`emitCostAttribution\` writer that targets fd 2 directly and is **not** overridable by \`deps\`. A caller that injects a logger loses trace lines; it must not be able to lose money rows.`

AC1, append: `*Negative control: an implementation that emits the attribution line through \`deps.log\` passes every \`dispatch-task.test.ts\` assertion (which inject a spy logger) while writing nothing to the harvested log in production, and MUST fail a test that calls \`dispatchTask\` with an injected logger and asserts the line still reaches fd 2.*`

---

### V-DF2.12-H2 · HIGH · Undeclared collision with DF2.11 (mirror of V-DF2.11-H2)
**File:** `:336-348` vs `df2-11:320-345`
Same defect, other side. DF2.12 edits `src/providers/teardown.ts`, `tests/providers/teardown.test.ts`, `src/providers/cost-ledger.ts` and `tests/providers/cost-ledger.test.ts` — all four also edited by DF2.11 — and additionally re-specifies `emitTokenBridgeState`, which DF2.11 lists as a method `openReadOnly` must serve (`df2-11:258`). Neither story names the other; neither yaml row carries the edge. **Fix:** add the mirrored sequencing note (see V-DF2.11-H2's recipe) stating that DF2.11 lands first and DF2.12 rebases onto the new `teardownSandbox` signature, and that DF2.12's `emitTokenBridgeState` reclassification changes the message only, not the read-only behaviour DF2.11 depends on.

---

### V-DF2.12-H3 · HIGH · Three artifacts still title this story with the placement the ADR forbids
**File:** `sprint-status.yaml` DF2.12 row; `df3-6a-resident-spend-iteration-bounds.md:229` and `:313`; story title `:1`
**Defect.**
- `sprint-status.yaml` DF2.12 title: *"Per-Role Token Cost Attribution Wired **at the Dispatcher**"*.
- `df3-6a:229`: *"**DF2.12** — `kind='tokens'` cost rows written **at the dispatcher**"*.
- `df3-6a:313`: *"only once **DF2.12** writes per-role `kind='tokens'` cost rows **at the dispatcher**"*.
- Story title `:1`: *"Wired **End to End**"*.

"At the dispatcher" is precisely the pre-ADR framing the story's own Technical Notes spends a full paragraph refuting (`:195-204`: *"Why the marker's 'one call at the dispatcher' is stale… no in-box call can write it"*). Three artifacts now name a write location D8 forbids.
**Failure scenario.** A developer picks the story off the yaml or off DF3.6a's Infra table, reads "written at the dispatcher", opens `dispatch-task.ts:469`, and writes `ledger.ingestCostEvent(...)` there — an in-box call to a host-side SQLite file that D8 says cannot be reached, which either fails at runtime or (worse, on a single-host dev setup where `.sandbox/` happens to be visible) appears to work and ships a design that breaks the moment the box is real.
**Resolution and authority.** The **story file is authoritative** here, because the yaml/DF3.6a title encodes a placement the ACCEPTED ADR forbids, and the ADR outranks both.
**Fix recipe.**
- yaml: `DF2.12: { title: "Per-Role Token Cost Attribution Wired End to End (in-box stamp → harvest → host-side ingest)", … }` and, in the row comment, replace "written at the dispatcher" with "stamped in-box at the dispatcher, ingested host-side at teardown's close step (the ADR splits the two)".
- `df3-6a:229`: `| per-role token attribution | **DF2.12** — \`kind='tokens'\` cost rows stamped in-box and ingested host-side at teardown | …`
- `df3-6a:313`: same substitution.
- Add a one-line note to DF2.12's Spec Reference recording that these three artifacts carried the stale framing and were corrected, so the next reader does not "restore" it.

---

### V-DF2.12-M1 · MEDIUM · `hasTokenRows` cannot distinguish "not harvested" from "genuinely emitted nothing"
AC4 (`:140-147`) and AC1 (`:118-119`) both key on `readRunCost(runId).hasTokenRows`, which is `anyTokenRow.n > 0` (`cost-ledger.ts:1407`). The story asserts "no schema change is needed to report it". But a run that legitimately emitted zero cost events — a dispatch refused before any spawn, a run killed in setup — also reads `hasTokenRows: false` with a `box_hours` row present, and `qds cost` will render `tokens-not-harvested` for a run that harvested perfectly and spent nothing on tokens. That is a false alarm in the opposite direction from the one AC4 guards, and it will fire on every cheap/aborted run.
**Fix:** have the host leg's summary line be the discriminator, not `hasTokenRows`. Add to AC4: `The renderer distinguishes the two using the teardown's own \`{ rowsRead, outcome }\` summary (Observability Contract): \`outcome: "ingested"\` with \`rowsRead: 0\` renders \`no-token-spend\`, and \`outcome: "tokens-not-harvested"\` renders \`tokens-not-harvested\` naming the path it looked for. *Negative control: a renderer keyed on \`hasTokenRows\` alone reports every refused-before-spawn run as unharvested and MUST fail.*`

### V-DF2.12-M2 · MEDIUM · Nothing forbids the host leg from re-deriving `invocationSeq`
`:217-230` defines `invocationSeq` as the in-box emission ordinal and says "`role` and `invocationSeq` ride the line" — correct, and it makes AC2's `event_id` digest stable across replays. But no AC or invariant *forbids* the host reader from re-deriving the ordinal from line order, which is the obvious implementation and which renumbers on a partial re-harvest, breaking `ON CONFLICT DO NOTHING` idempotency.
**Fix:** append to INV-COST-8 (`:359-364`): `\`invocationSeq\` is **read off the line**, never re-derived from the reader's iteration order: a partial re-harvest re-numbers a derived ordinal, changes the \`event_id\` digest, and turns AC2's \`ON CONFLICT DO NOTHING\` into duplicate spend. *Negative control: a reader that enumerates lines and assigns \`invocationSeq\` by position passes AC2's full-replay test and MUST fail a partial-replay test (ingest lines 1-2, then ingest lines 1-4).*`

### V-DF2.12-M3 · MEDIUM · The µ$ round-trip test is pinned at the wrong place
`:244-255` claims the µ$→USD→µ$ round trip is "exact for every integer µ$ value the ledger accepts", and the DoD (`:421-423`) pins it "at the safe-integer boundary `usdToMicros` refuses past". The boundary is where the guard fires (`cost-ledger.ts:274-277`), not where the float is interesting. `usdToMicros` is `Math.round(usd * 1e6)`; the round trip is exact below 2^53 because `Math.round` recovers the tie, but the values that would expose an error are mid-range ones whose `/1e6` lands on a representation tie, not the boundary.
**Fix:** DoD `:421-423` → `- [ ] **Test (µ$ round trip, Technical Notes):** a **property test** over ≥10,000 pseudo-random integer µ$ values spanning 1 … the safe-integer ceiling asserts \`usdToMicros(micros / 1e6) === micros\`, **plus** the boundary case \`usdToMicros\` refuses past. A boundary-only test asserts nothing about the range the resident actually spends in.`

### V-DF2.12-M4 · MEDIUM · AC6's "no shipped string still describes the bridge as unbuilt" enumerates four; there are at least nine
AC6 (`:155-165`) names `qds-cost.ts:396`, `cost-ledger.ts:1438`, the `:1456-1460` marker and `tests/providers/cost-ledger.test.ts:11-13`. Also present at `fa7d0e26`:

| Location | String |
|---|---|
| `src/providers/cost-ledger.ts:18` | "`teardown.ts` writes those; `ingestCostEvent`, the only writer of…" |
| `src/providers/cost-ledger.ts:25-28` | "out loud on every degraded ledger (`emitTokenBridgeState`, code `tokens-ledger-unwired`)… ready for **the one dispatcher call site** that would make the prose above complete" |
| `src/providers/cost-ledger.ts:1144` | "`ingestCostEvent` is still the one writer, and `captureSpend` is still not." |
| `tests/scripts/qds-cost.test.ts:711` | "`ingestCostEvent` is the only writer of `kind='tokens'` rows and nothing…" |
| `tests/fleet/e2e/tier2-fanout-bestofn.live.test.ts:275`, `tier3-manystories.live.test.ts:383`, `tier2-dispatch-engine.live.test.ts:406` | `tokensRowsGap: "ingestCostEvent has no production caller — see run report"` |
| `tests/fleet/e2e/tier2-dispatch-engine.live.test.ts:397` | "production writer — `CostLedger.ingestCostEvent` (**cost-ledger.ts:753**)" — also a stale line number (actual `:961`) |

The DoD grep at `:424-426` ("a repo grep finds no shipped string claiming the bridge is unbuilt") would fail against an implementation that corrected only the enumerated four. Note also `cost-ledger.ts:25-28` cites `docs/decisions/2026-08-tech-debt-answers.md` Q1, which will also read stale.
**Fix:** replace AC6's enumeration with the grep itself plus the full list: `…are all corrected — the full set at \`fa7d0e26\` is \`cost-ledger.ts:18\`, \`:25-28\`, \`:1144\`, \`:1438\`, \`:1456-1460\`; \`qds-cost.ts:396\`; \`tests/providers/cost-ledger.test.ts:11-13\`; \`tests/scripts/qds-cost.test.ts:711\`; and the three live-e2e \`tokensRowsGap\` strings (\`tier2-fanout-bestofn.live.test.ts:275\`, \`tier3-manystories.live.test.ts:383\`, \`tier2-dispatch-engine.live.test.ts:406\`, the last of which also carries a stale \`cost-ledger.ts:753\` citation). The DoD's authority is the **grep**, not this list: \`grep -rn 'no production caller\\|nothing calls .ingestCostEvent\\|F001' src scripts tests\` must return only lines that describe the bridge as **live**.`

### V-DF2.12-L1 · LOW · The epics index has no DF2.12 entry at all
`grep -Fn 'DF2.12' _bmad-output/implementation-artifacts/epics-and-stories-dark-factory-v5.md` → nothing. Same for `DF2.11`, `DF3.6a`, `DF6.1a`. The entire 2026-09-08 slate change is absent from the epics index. Not this story's defect; owned by the Phase 3 wrap-up (see V-DF5.5-M6).

### V-DF2.12-L2 · LOW · Stale line citation inherited from a live test
`tests/fleet/e2e/tier2-dispatch-engine.live.test.ts:397` cites `cost-ledger.ts:753` for `ingestCostEvent`, now `:961`. Fix it in the same pass as M4.

---

# PART 4 — Artifact-consistency sweep

| Field | DF5.5 | DF2.11 | DF2.12 |
|---|---|---|---|
| Sprint tag (story vs yaml) | `v5-S3` / `v5-S3` ✅ | `v5-S3` / `v5-S3` ✅ | `v5-S3` / `v5-S3` ✅ |
| Points | 3 / 3 ✅ | 3 / 3 ✅ | 3 / 3 ✅ |
| Status | **no `**Status:**` line** / `ready-for-dev` — **M7** | `ready-for-dev` / `ready-for-dev` ✅ | `ready-for-dev` / `ready-for-dev` ✅ |
| Dependency edges | canonical set excludes DF6.1a/b; **yaml deps include both** — **H4** | `DF2.5, DF2.8` both sides ✅ | story `DF2.8, DF1.6, DF2.7` (+`DF2.5` de-facto) / yaml `[DF1.6, DF2.5, DF2.7, DF2.8]` ✅ |
| Title | ✅ | ✅ | **✗ yaml + `df3-6a:229`/`:313` say "at the Dispatcher" — H3** |
| Undeclared sibling edge | — | **✗ DF2.12 (H2)** | **✗ DF2.11 (H2)** |
| Epics index entry | present but stale (A–E framing, **M6**) | **absent** | **absent (L1)** |

**Which artifact is authoritative, and why.**
- **`sprint-status.yaml` for scheduling fields** (points, status, sprint tag, `deps`). Its 2026-09-08 audit note states the totals are "recomputed from the per-story entries below, not incremented by hand", and DF5.5's own AC4 reads the slate count from its meta block rather than hardcoding it. Fix DF5.5's missing Status line and DF5.5's yaml `deps` per H4.
- **The story file for title and scope**, because the yaml's DF2.12 title asserts a write location the **ACCEPTED ADR** forbids. The ADR outranks both artifacts; the story is the only one of the three that agrees with it.
- **Shipped code over every story's prose** — which is how V-DF2.11-B1 was found: DF2.11 describes `qds-cost.ts`'s guard as an `existsSync` check, and the code says, in a comment written for exactly this reader, that it deliberately is not one.

---

# PART 5 — What a previous reviewer / author got wrong

1. **The DF5.5 re-verification gate ran and produced dangling citations.** `:99-111` claims the gate "fired once, on 2026-09-08" and that "every DF6.1 citation below has been re-pointed accordingly". Four of the five resulting citations point at wrong lines (V-DF5.5-H2), and one of them (`df6-1a:52`) points at a blank line. The gate caught the *ID* drift and missed the *line* drift it exists to catch.
2. **Amendment G was applied to `sprint-status.yaml` without the story being updated.** Someone did the work — including the exact P1.9 clause DF5.5 dictates — and recorded only `P1.18` as already-applied. The remaining seven rows are still presented as pending, and the DoD item that would catch it is unfalsifiable (V-DF5.5-B1).
3. **`p1-3`'s occurrence count was taken from `grep -n` (lines) and written as mentions.** Eight lines, nineteen occurrences (V-DF5.5-B3). Every downstream check inherited the line-scoping and is therefore blind to the shortfall.
4. **DF2.11's author read `qds-cost.ts`'s pre-check as `existsSync` without opening it.** The comment at `:276` exists specifically to prevent that reading, and the story prescribes deleting the guard it describes (V-DF2.11-B1). This is the one finding in this review where a story would, if implemented as written, make shipped security *worse*.
5. **DF2.12's "one call at the dispatcher" correction was applied to the story body but not to the artifacts that index it.** The Technical Notes refute the framing in a full paragraph; the yaml title and two DF3.6a rows still assert it (V-DF2.12-H3).
6. **Both new stories were authored without noticing they edit the same four files.** DF2.11 rewrites 53 test call sites in a file DF2.12 also edits; neither names the other, in the story or in the yaml (V-DF2.11-H2 / V-DF2.12-H2).

---

*End of report. No files were modified by this review.*
