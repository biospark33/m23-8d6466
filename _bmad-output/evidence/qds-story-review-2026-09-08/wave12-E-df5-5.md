# Wave 12 — Verifier E — DF5.5 KEEP-Repoint Chore (df5-5-keep-repoint-chore.md)

**Reviewer:** Wave-12 Verifier E (clean eyes — no prior wave/fix/tracker material read)
**Scope file:** `_bmad-output/sprint-artifacts/dark-factory-v5/stories/df5-5-keep-repoint-chore.md` (working tree, branch dev, reviewed as-is)
**Date:** 2026-09-14
**Story type:** Markdown chore spec awaiting dev (12-file repoint set, 11-file marker set, new 4-assertion regression test)

---

## Method

Read the story end to end, then opened at source every anchor, symbol, path and citation the story names. All greps run from the repo root; every zero-match claim below was re-run with a positive control on identical machinery. No file was edited except this report.

### Anchors opened (cross-story reads, all named repoint/verification anchors)

**The 12 in-scope files** (occurrence table + block membership + content):
`p1-2-qds-intake-issue.md`, `p1-3-seeds-decompose-mirror.md`, `p1-5-model-router-hindsight.md`, `p1-7-lsp-diagnostics-gate.md`, `p1-9-restart-policy.md`, `p1-11-hindsight-prime-retain.md`, `p1-12-mulch-prime-record.md`, `p1-14-outcome-record-router.md`, `p1-18-pr-comment-polling.md`, `p0-5-pi-lens-headless-tdi.md`, `p0-7-swarmclaw-agent-mcp-hindsight.md`, `p0-9-hindsight-banks-mulch.md`.

**Successor/amendment anchor files:** `df6-1a-pr-feedback-bounded-fix-attempt.md`, `df6-1b-fix-loop-verdict-attempt-budget.md`, `df2-10-factory-owned-boot-image.md`, `df1-10-in-box-phase-engine.md`, `df2-3-credential-lifecycle.md`, `df2-8-cost-ledger-budget-cap.md`, `df5-3-audit-chain-extended.md` (existence of all ten canonical-set files confirmed by directory listing), `p0-3-mixed-model-demo.md`, `p0-4-hard-guard-kill.md` (audit-row anchors).

**Closed records / registers (cited, not edited):** decision register (§1 Module-roots row, §4 boundary-contract rows, DD-1, DD-2, DD-2a, DD-7, DD-8, DD-9), disposition audit (§2 KEEP-row amendment allowance, P1.9/P1.11/P1.14 rows, phase-0 RETIRE rows and RETIRE summary row, disposition-row count), R5-dependency-sizing.md (§1.5 slate row, §2, §5.2, §5.4, SwarmClaw-role recommendation), tier-2 placement ADR (Status header, §Consequences, Appendix A), epics index (DF5.5 entry, KEEP disposition table, provenance footnote), `sprint-status.yaml` (DF5.5 row, all KEEP-per-F14 rows, P1.9 and P1.18 rows, superseded rows).

**Code/filesystem claims:** `src/providers/credentials.ts` (`mintRunKey`, cap expression, docstring chain), `scripts/cap-hit-demo.ts` (run-budget-cap field comment), `scripts/lib/run-lock.ts` (byte scan), `src/phase-engine/` tree, absence of `src/protocol/phase-executor.ts`, absence of `tests/scripts/keep-repoints.test.ts`, presence of `license-sweep.test.ts` / `roster-check.test.ts` / `qds-cost.test.ts` in `tests/scripts/`.

### Verification runs (with positive controls)

| Zero-match / claim | Machinery | Positive control | Result |
|---|---|---|---|
| Occurrence table complete & current | AC1 retired-ID pattern, `-o`, over the 12 files | every table row reproduced (10 files, exact lines and multiplicities) | HELD exactly |
| p1-3 P1.1 count | `grep -oE 'P1\.1\b' \| wc -l` and per-line counts | per-line content read of all nine table lines | 19 across 8 P1.1-bearing lines — table and prose agree |
| Marker grep scoped to the two story dirs | `grep -rl … \| sort` | story file itself greps the literal 14× | currently zero paths (awaiting dev — expected) |
| Story self-count of the literal | `grep -o … \| wc -l` | — | **14, story claims 12** → W12E-3 |
| `exitStatus` zero in p1-11 / p1-14 / p1-9 | `grep -c` | Hindsight×19 / router×11 / restart×7 | HELD (all three zero) |
| Marker zero in epics doc and yaml | `grep -c` | epics DF2.8 = 16, DF2.13 = 1; yaml KEEP-rows grep = 9 | HELD |
| `loadResidentBounds` zero in df2-3 | `grep -c` | `capMicroUsd` ×3 in the same file | HELD; live sites are df3-6a, df2-13, `credentials.ts` |
| p0-5 zero retired-ID hits | AC1 pattern | H1 grep = 1; the file's one `P1.` mention is P1.7 (KEEP) | HELD |
| DF3.6 / DF2.11 / DF2.12 / DF2.13 absent from the 12 files | `grep -rn` | "Dependency edges" present in 19 phase-1 files | HELD (both slate negatives) |
| `keep-repoints.test.ts` does not exist | `ls` | 16 sibling test files listed, `license-sweep` / `roster-check` present | HELD |
| `src/protocol/phase-executor.ts` does not exist | `ls` | `src/phase-engine/` populated | HELD |
| `df6-1-pr-feedback-fix-loop.md` deleted | `ls` glob | `df6-1a` / `df6-1b` listed | HELD |
| `run-lock.ts` carries no NUL bytes | byte scan | 71,608 bytes read (file fully readable) | HELD ("no longer reproduces" is accurate) |
| 4-value enum: exactly one corpus listing | sweep over sprint-artifacts | 5-value listing present elsewhere | HELD (p0-4 only; the second hit is df5-5 quoting it) |
| Yaml retired-ID grep zero on KEEP rows | AC1 bullet-3 pattern | 7 matching rows, all `status: superseded` | HELD |
| Eight discharged comments / seven deps arrays | exact-literal grep + story-key rows | nine KEEP-per-F14 rows, eight carrying the repoint clause | HELD (P1.18's row carries a different, correctly-described clause) |

### Cross-story anchor spot-verifications (all landed)

- **Successor map:** every P1.x→DF mapping matches the yaml's `superseded-by` notes row for row, including P1.19→DF6.1a (register DD-2a) and the four never-in-KEEP IDs (zero hits in the 12 files).
- **Amendment C anchors:** p1-9 Overview "three categories", AC1, and the `FailureClass` contract; p0-3's CC-1 five-value taxonomy; DF2.10's `Restart=no` (unit-file description clause and Files-to-Modify bullet — both cited anchors exact); DF1.10's reclaim-semantics clause and supervision-halves bullet (both cited anchors exact); register §4 rows match the blockquote text verbatim; DF1.3/DF1.5 files exist, `done`.
- **Amendment D anchors:** register DD-7 row; DF2.8 ships `qds cost` (story + `qds-cost.test.ts`) and the 5,000,000 µ$ cap; DF5.3's Trigger Surface explicitly defers the HTTP query surface to DF5.5.
- **Amendment E claims:** df2-3 carries the operator-corrected `≤` chain as live text; the old strict-`<` chain survives only inside the quoted-history blockquote; `mintRunKey` takes `deps.capMicroUsd ?? defaultKeyCapMicroUsd`; the docstring chain line is present; cap-hit-demo declares the middle term "Inner control: run budget cap (artifact field only)".
- **P1.18 hand-off:** DF6.1a's severance blockquote (comment-read limb) and `botComments[]` payload sentence land verbatim at the cited anchor, citing p1-18's Contracts/Schema `botComments` shape, which matches character for character; DF6.1b's severance blockquote (verdict limb, "polled"), webhook-exclusion AC note and Trigger Surface row all land; the yaml P1.18 row records UNSCHEDULED + the two-half denial + the retracted-polling correction as the story describes.
- **INV-1 block membership:** p1-3's `:39` sits inside that file's Acceptance Criteria (AC item 4) and its two DoD Impl checkboxes sit inside Definition of Done; p1-12's `:31` is AC item 3; p1-11's `:48` sits in that file's Technical Notes (headers 27/37/55 exactly as the story states); p1-18's `:50` is the INV-2 line inside Security Invariants (headers 47/53 exactly as stated). The four-admitted / one-separate enumeration is arithmetically and structurally exact.
- **Gloss quotes:** `p1-2`'s dependency-edges gloss, p1-3's "A2A delegation layer (P1.1)", "registration schema", "Transport Contract enforced by P1.1 INV-4", "envelope helper", and the two provenance range sentences (p1-3 error-taxonomy note, p0-9 range note) all match verbatim.
- **Epics index:** DF5.5 entry carries amendments A–F and the three-grep make-or-break; DF2.13/DF2.8 counts match the story's figures; the divergence the story says closed is closed.

---

## Findings

| ID | Class | Sev | Location (section anchor) | Finding |
|---|---|---|---|---|
| W12E-1 | C3 | **MEDIUM** | §Infra Prerequisites assertion (1) vs the prescribed insert texts (§Technical Notes amendment A; §E2E Slice P1.18 disposition) | Assertion (1) specifies a count-based scan in which the only sanctioned surviving occurrences are "the three enumerated" provenance sites (`p0-7`, `p0-9`, `p1-3`), each followed by its `(now DF<n>.<m>)` annotation within 20 characters on the same line. The story's own prescribed texts cannot pass that mechanism: the `p1-2` replacement text keeps `was P1.1 "Dev Manager registered as A2A agent"` with no DF ID of any form near that occurrence (the nearest is the `DF5.5` marker, ~110 chars later); the `p1-3` header blockquote adds three meta-references to P1.1, none in the `(now …)` form; and the pre-authorised `p1-18` fallback creates a fourth surviving annotated occurrence beyond the enumerated three. Implemented per its own words, the test fails on the story's own edits; implemented tolerantly (mapped successor anywhere on the line), it contradicts the "count-based, never line-membership" + 20-char-window specification. AC1's plain grep passes the same final state, so the story's AC and its test disagree about one end state. A dev must pick between the spec's own sentences; several bounded resolutions exist (classify amendment-text occurrences; widen the provenance set by the inserts and the conditional fallback site; drop the 20-char window in favour of same-line successor presence). No AC is unbuildable, no forbidden boundary is crossed. |
| W12E-2 | C3 | **MEDIUM** | §Technical Notes Amendment C, first bullet (p1-9 boundary statement) vs DoD Contract item | The p1-9 boundary blockquote — the *corrected three-value `FailureClass`* text the DoD specifically requires — carries no `v5 amendment (DF5.5)` marker, while the Contract DoD says "Every edit carries the literal marker". Pasted verbatim alone, it would not land `p1-9` in the marker grep's result set; the file still lands because amendment A's dependency-edges edit on the adjacent line does carry the marker, so AC1 is unaffected either way. The sibling p1-5 bullet in the same amendment *does* carry the marker — an asymmetry inside one amendment that proves the omission is not a style choice. Resolution is one sentence (append the marker to the p1-9 bullet) or a file-level reading of the Contract; the dev must pick. |
| W12E-3 | C1 | LOW | §E2E Slice self-count sentence | "verified 2026-09-13: 12 occurrences here" — the literal now occurs **14** times in the story file (two marker-string mentions added since that verification, consistent with the standing uncommitted-edit state). The load-bearing conclusion (an unscoped `grep -rl` returns strictly more than 11 paths) is unaffected and in fact strengthened. Refresh the count or drop the numeral. |
| W12E-4 | C1 | LOW | Spec Reference → tier-2 ADR bullet | "§Consequences added DF2.10/DF1.10/DF1.11/DF3.7/DF3.8" — only DF1.10 and DF3.6 appear as literal IDs inside the ADR's §Consequences list (items 2 and 5); DF2.10/DF1.11/DF3.7/DF3.8 are named there by description (image ownership, steering executor, approval-gate bridge) and by ID elsewhere in the ADR (forensic section, Appendix A, re-opening text). The substantive claims the bullet exists to establish — ACCEPTED status, in-box engine, DF3.6 re-sequenced, post-ADR slate — all verify at source. Loose paraphrase only. |
| W12E-5 | C4 | LOW | AC1 / §Infra Prerequisites assertion (2) | The negative control's phrasing "a line naming a *different* DF ID MUST fail" collides with the marker's own `DF5.5`, which sits on nearly every annotated line the chore writes. The Infra Prerequisites wording ("annotated with a DF ID that is *not* the mapped successor") states the true intent — a wrong-successor tripwire — and any sane implementation asserts mapped-successor presence or excludes the marker string, but the AC1 phrasing read literally fails every annotated line. Tighten the wording to "different *successor* annotation, excluding the amendment marker". |

---

## What HELD

- **The occurrence table is exactly current.** All ten rows reproduce under the AC1 machinery with identical line numbers and multiplicities, including the p1-3 row's 19-across-8 arithmetic (the prose count, the table, and the `wc -l` figure are mutually consistent; the apparent ninth line is the P1.6 row, correctly excluded from the P1.1 count). The "substitute once per line leaves eleven live references" arithmetic checks (19 − 8 = 11).
- **Every successor mapping is real and every named file exists.** All ten canonical-set IDs resolve under `dark-factory-v5/stories/`; DF1.10/DF2.10 are `done` as claimed; DF5.3/DF6.1a/DF6.1b are `ready-for-dev` as claimed, so the re-verification gate's live-drift premise is correct.
- **INV-1's geometry is exact.** The four admitted in-block edits are in-block; the one separately-counted Technical-Notes edit is not in a governed block; the `p1-18` fallback target is inside Security Invariants; the header positions quoted in the story match the files.
- **The amendment set's cross-story citations all land at source** — DF2.10's `Restart=no` at both cited clauses, DF1.10's reclaim ownership at both, DF6.1a/DF6.1b's dual severance (distinct limbs, both load-bearing), the `botComments[]` shape sentence including its p1-18 citation, p0-3's five-value CC-1 enum, p0-4's four-value `exit_class`, DF2.8's `qds cost` and 5,000,000 µ$ cap, DF5.3's explicit deferral of the query surface to DF5.5.
- **Amendment E and G's already-applied/retired dispositions verify at source**, including the operator-corrected chain, the quoted-history survival of the old strict chain, the zero `loadResidentBounds` in df2-3, the wired `mintRunKey` expression, the seven rewritten deps arrays by story key, the eight discharged comment clauses, the P1.9 union clause, and the P1.18 hand-off row.
- **The yaml scan, epics-entry closure, NUL-history note, absent test file, absent pre-v5 path and present test-home claims are all true today**, each with a positive control.
- **The gloss rule's quoted glosses match the files verbatim**, and the p1-3/p1-9 provenance treatments are internally consistent with p0-9's range note ("one fact, one treatment").

---

## Verdict

**NOT CONVERGED** (convergence bar requires zero C3).

- **BLOCKER: 0 · HIGH: 0 · MEDIUM: 2 · LOW: 3**
- **C1: 2 (both LOW) · C2: 0 · C3: 2 (both MEDIUM) · C4: 1 (LOW)**

Both MEDIUMs are internal contradictions between the story's own normative sentences and its own prescribed artifacts — one between the test-assertion mechanism and the insert texts it must accept, one between the Contract DoD and amendment C's p1-9 insert. Neither touches the repo's actual state, and neither makes an AC unbuildable or unobservable; both close with one or two sentence-level edits to the story text (widen assertion (1)'s provenance classification and/or the 20-char window; append the marker to amendment C's p1-9 bullet). Everything load-bearing — anchors, mappings, completeness, marker mechanics, block geometry, closed-record dispositions — verified clean at source.

**Confidence: high.**

| Sev × Class | C1 | C2 | C3 | C4 | Total |
|---|---|---|---|---|---|
| BLOCKER | 0 | 0 | 0 | 0 | 0 |
| HIGH | 0 | 0 | 0 | 0 | 0 |
| MEDIUM | 0 | 0 | 2 | 0 | 2 |
| LOW | 2 | 0 | 0 | 1 | 3 |
| **Total** | **2** | **0** | **2** | **1** | **5** |
