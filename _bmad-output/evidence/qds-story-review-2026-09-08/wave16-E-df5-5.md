# Wave 16 — Verifier E — DF5.5 KEEP-Repoint Chore

**Story:** `_bmad-output/sprint-artifacts/dark-factory-v5/stories/df5-5-keep-repoint-chore.md`
**Tree reviewed:** branch `dev` @ 4264f546 plus uncommitted spec edits, as found.
**Clean eyes:** no prior wave/tracker/handoff/seam-ownership/fix-recipe material read. Wave-ID
citations inside the story (W10E-2, W12E-1, W14E-1/2/3) were **not** opened — they are forbidden
inputs here; they are treated as provenance labels, not anchors.

## Method

Read the story end to end, then opened at source every anchor, symbol, path and citation it
names. Zero-match claims were each paired with a positive control run with identical machinery.
No bare greps; no line-number citations below (all claims cited by symbol, section anchor, or
story key).

**Anchors opened:**

- **Occurrence table (Amendment A), all 12 in-scope files** — ran AC1's retired-ID grep verbatim
  (pre-application) plus a per-file `grep -onE` occurrence dump with an H1 positive control per
  file. Every row of the occurrence table matches the live tree exactly: `p1-2` (one hit, dep-edge
  line), `p1-3` (19 `P1.1` occurrences across exactly 8 lines — `22`×3, `24`×5, `39`, `138`×3,
  `142`, `147`×3, `154`×2, `155` — plus one `P1.6` on its own line; `grep -oE 'P1\.1\b' | wc -l`
  → 19, control `P1.6` → 1), `p1-7`, `p1-9`, `p1-11`, `p1-12`, `p1-14`, `p1-18` (`17`/`23`/`25`
  carry `P1.15`; `50` carries `P1.19`, correctly excluded), `p0-9`, `p0-7`. The six-retired-ID
  claim (P1.1, P1.6, P1.8, P1.13, P1.15, P1.19 are the only retired IDs with hits) verified from
  the same dump. **The repoint set is complete.**
- **p0-5 / p1-5 zero-hit claims** — retired-ID grep → zero matches (exit 1), positive control H1
  match → 1 in each file.
- **Gloss/provenance quotes** — `p1-2` dep-edge line, `p1-3:142` JSON-RPC range provenance line,
  `p0-9:218` range line, `p0-7:55` snippet comment, `p0-7:136` downstream-contract paragraph (×3),
  and the four quoted `p1-3` glosses ("the A2A delegation layer (P1.1)", "P1.1's registration
  schema", "the local-only Transport Contract enforced by P1.1 INV-4", "P1.1's envelope helper")
  — all quoted verbatim-accurate against source.
- **Governed-block membership** — headers of all amended files: `p1-3:39` sits in its AC block
  (item 4), `p1-3:154`/`:155` in DoD, `p1-12:31` in AC (item 3) — the four in-block edits are
  exactly as INV-1 declares; `p1-11:48` sits in that file's Technical Notes (headers verified);
  `p1-18:50` sits inside its Security Invariants block (headers `47`/`53` verified);
  `p1-9`'s only hit at its dep-edge line, before its AC block; `p0-7`'s and `p0-9`'s hits all in
  Technical Notes; `p1-5`'s dependency line sits before its AC block (AC2's zero-character claim
  structurally sound).
- **Amendment B** — `exitStatus` zero in `p1-9`, `p1-11`, `p1-14` (controls: FailureClass=3,
  Hindsight=19, router=15); `p1-11`'s cited line is a Hindsight REST transport table row;
  `p1-14`'s cited line is blank; `costCents` at its AC1 make-or-break line and two later lines;
  `p0-4` carries the sole four-value `exit_class` enum (control: exit_class count 5).
- **Amendment C** — `p1-9:36` three-value `FailureClass` over `FailureSignal` exact; `p0-3:126`
  CC-1 five-value `exitStatus` exact; `df2-10` `Restart=no` at both cited anchors (also its
  Files-to-Modify and DoD lines); `df1-10` reclaim semantics at both cited anchors (Reclaim
  semantics item; Supervision-folded-in-two-halves note); register §4 carries both boundary pairs
  (DF1.3↔P1.9, DF1.5↔P1.5) and itself repeats the "keyed on the exitStatus enum" wording — the
  amendment-C erratum's second source, verified real.
- **Amendment C erratum** — audit §2's P1.9 row does say "keyed on the exitStatus *enum*";
  `p1-9`'s Overview says three categories and its AC1 says `transient | overflow | logic`; the
  zero-count above holds. Third DD-8-class drift confirmed as real.
- **Amendment D** — register DD-7 verbatim-consistent; DF2.8 `done 2026-08-21` per its
  sprint-status.yaml row; `qds cost` exists in source (`cost-ledger-bridge.ts`,
  `cost-ledger.ts`) with `tests/scripts/qds-cost.test.ts` as control.
- **Amendment E** — `df2-3` live chain `residentSpendCeilingMicros ≤ capMicroUsd (mint-time, per
  run) ≤ defaultKeyCapMicroUsd` present verbatim (twice); the old strict-`<` chain survives only
  inside a correction blockquote; `loadResidentBounds` zero in `df2-3` (control
  `defaultKeyCapMicroUsd`=6), present in `df3-6a` (12) and `src/providers/credentials.ts` (1);
  `scripts/cap-hit-demo.ts` carries the exact "Inner control: run budget cap (artifact field
  only)" gloss beside `runBudgetCapMicros`; `mintRunKey` (credentials.ts) contains `deps.capMicroUsd
  ?? defaultKeyCapMicroUsd`.
- **Amendment F** — `p1-11:51` and `p1-12:39` both name `src/protocol/phase-executor.ts`;
  `src/protocol/` does not exist at all (control: `src/phase-engine` exists); register §1 module
  roots row names `src/phase-engine/*`; M-PairB-1 note matches both files' live text.
- **Amendment G** — sprint-status.yaml: all seven `deps:` arrays exactly as tabulated (P1.2
  `[DF3.1]`, P1.7 `[P0.6, DF1.6]`, P1.9 `[DF1.6, DF1.8]`, P1.11/P1.12 `[P0.9, DF1.6]`, P1.14
  `[P1.5, DF2.8]`, P1.18 `[DF5.2]`); P1.3/P1.5 arrays carry no retired ID and carry the comment;
  eight discharged comments counted; P1.9's discharged clause verbatim; the yaml retired-ID grep
  hits only `superseded` rows; the yaml carries zero literal markers (control: 19 rows mention
  DF5.5 in other forms); DF5.5's own row lists `DF6.1a` as the scheduling edge, exactly as the
  story's E2E Slice distinguishes it; yaml `meta:` block exists (the recompute-DoD is executable).
- **P1.18 disposition** — "P1.18 is not a predecessor" search anchor present once in each of
  DF6.1a and DF6.1b; DF6.1a's comment-read limb quote, "out of scope for v5.0", `botComments[]`
  and the `df6-1a` payload-shape quote (`p1-18-pr-comment-polling.md:36`, without its receiver)
  all verbatim; DF6.1b's verdict limb ("the verdict is **polled**, and a poll needs no
  receiver"), webhook exclusion, and Inbound-webhooks Trigger Surface row all present; DF6.1b's
  three-invocation composition described accurately; `p1-18:36` shape
  `botComments: [{ commentId, author, bodySnippet, timestamp }]` exact; `df6-1` file deleted;
  DD-2 (`register`) carries the struck-through "P1.18 (KEEP) repoints to DF6.1" superseded by
  DD-2a (DECIDED 2026-09-08, landed).
- **Spec-reference citations** — audit §2 disposition table exists; audit's amendment-allowance
  row quote accurate; audit KEEP-11 roster matches the story's 11+P0.7 framing; R5 §1.5 carries
  the stale DF5.5 row text verbatim (2 pts, "2 enum citation fixes + 3 boundary amendments");
  R5 §2/§5.2/§5.4 exist (§5.4 = the boundary contracts, matching register §4's parenthetical);
  tier-2 ADR is ACCEPTED 2026-08-31 with a Consequences section re-chartering DF1.10 and
  re-sequencing DF3.6; DD-9 settles µ$ and restates 5,000,000 µ$ in DF2.8; successor map agrees
  with every `superseded-by` comment in the yaml for all ten retired IDs.
- **Epics index** — zero literal markers (control: `DF2.8`=16, `DF2.13`=1, both exact); its DF5.5
  section carries "After amendments A–F, three greps pass" and the third grep; its dependency
  line lists the eight edges + `DF6.1a`.
- **Mechanics** — `tests/scripts/` contains `license-sweep.test.ts` and `roster-check.test.ts`
  (the claimed hygiene-test home); no file in either story directory already carries the marker
  (the 11-count is achievable); `scripts/lib/run-lock.ts` has zero NUL bytes now (perl scan;
  positive control `.git/index` = 421 NUL-lines — my first attempt via bash `$'\x00'` was itself
  invalid and re-run properly); DF5.3 is `ready-for-dev`, DF1.10 `done` 2026-09-06, DF2.10
  `done` — all as the re-verification gate assumes.
- **Marker-presence check on prescribed inserts** — all nine prescribed texts carry the literal
  marker `v5 amendment (DF5.5)`: the `p1-2` replacement, the `p1-3` header blockquote, the P1.18
  header blockquote, the `p1-18:50` fallback, the `p1-9:25` replacement, both amendment-C
  blockquotes, the amendment-D blockquote, and the amendment-F blockquote.
- **Classification check (mandate)** — checked each prescribed artifact against the four
  sanctioned provenance forms literally: `p1-2` → form 2 (`was P1.1` gloss) + form 4 (inline
  marker); `p1-3` substitutions → form 2 per line (`was P1.1's <gloss>` first occurrence) plus
  the appended marker; `p1-3:142`, `p0-9:218`, `p0-7:55` → form 1 (`(now DF3.1)`); `p1-9:25`
  replacement → form 2 + 4; the `p1-18:50` fallback → form 4 (inline marker; note its
  `P1.19 — now **DF6.1a**` is *not* a literal `(now DF…)` match, so form 4 is what classifies
  it — the enumeration still classifies it); header blockquotes → form 3. AC1's own grep was
  simulated over every surviving-P1.1 artifact the story prescribes (the `p1-3` header
  blockquote's meta-references, the three provenance lines, the `p1-2`/`p1-9` replacements): all
  carry a DF ID on the same line, so the post-application zero-line target is internally
  consistent. AC1's regex was checked for the P1.1-vs-P1.10/P1.19 alternation hazard — the `\b`
  makes it match correctly.

**Positive controls run:** H1 per in-scope file; `P1.6` in `p1-3`; `FailureClass` in `p1-9`;
`Hindsight` in `p1-11`; `router` in `p1-14`; `exit_class` in `p0-4`; `defaultKeyCapMicroUsd` in
`df2-3`; `DF1.6`/`P1.6` in `p1-7`; `DF2.8`/`DF2.13` in the epics index; `deps: [` arrays in the
yaml; DF5.5 mentions in the yaml; `export` in `run-lock.ts`; `.git/index` for the NUL scanner;
`ls src/protocol/` and `src/phase-engine` for the dead-path claim.

**Scoped test runs:** none required — the story's test file does not exist yet by design; no
suite was run (nothing to gate). No `bun test` invocation at all.

## Findings

| ID | Class | Severity | Finding |
|---|---|---|---|
| W16E-1 | C1 | LOW | The E2E Slice's scoping note asserts "verified 2026-09-13: 12 occurrences here" of the marker in this story file. Actual: 17. The story was amended after that verification (the marker-sanctioned-forms passages added marker mentions). The load-bearing direction — an unscoped `grep -rl` returns strictly more than 11 paths — is unaffected (17 > 11), but the self-count is a false drift alarm for the next verifier who runs it. Refresh the count or drop the numeral. |
| W16E-2 | C1 | LOW | Out-of-scope observation: sprint-status.yaml's `P1.19` row still reads "superseded-by: DF6.1" — a dangling pointer to the deleted `df6-1` file. The chore's own rules (superseded rows are historical record; the yaml appears in no hunk) put this outside DF5.5's edit scope, and DD-2a records the split, so this is recorded, not actionable here — but a reader landing on that row from the yaml finds no live target. |
| W16E-3 | C4 | LOW | Directive-verb inconsistency for `p1-18` lines 17/23: the occurrence table says "repoint … never bare", the P1.18 disposition says "annotate `:17`/`:23` beneath it", and Files to Modify says "annotated under the P1.18 blockquote". Both readings pass every gate (P1.15's mapped successor DF5.2 lands on the line either way), so nothing is unexecutable — but a dev applying this by hand gets two verbs for the same two lines. Pick one word. |
| W16E-4 | C4 | LOW | AC2 says the two-file zero-character rule "is asserted as such" without naming a mechanism in the four-assertion enumeration (which has no AC-byte-identity arm). The enforcement home does exist — the DoD Security item's per-file diff review, plus the structural fact that no prescribed edit touches either AC block — so the gate is executable; the word "asserted" just points at review, not at a test. Say "reviewed as such" or add it to the Security DoD's citation. |

## What HELD (the load-bearing set, verified at source)

- **Every repoint anchor is real and exact.** The occurrence table matches a live per-file
  occurrence dump line-for-line and count-for-count, including the 19-on-8-lines `p1-3` claim,
  the ×3/×5/×2 multiplicities, and the excluded `p1-18:50`.
- **The repoint set is complete**, and both negative membership claims (`p0-5` zero hits,
  `p1-5` boundary-only) hold with positive controls.
- **Every prescribed insert text carries the literal marker**, and the as-prescribed artifact
  set is fully classifiable by the four sanctioned forms — including the `p1-18:50` fallback,
  which classifies via the inline-marker form (its parenthetical is not a literal `(now DF…)`
  match; the enumeration still catches it).
- **Every zero-match claim held under positive control**: `exitStatus` in three files, NUL bytes
  in `run-lock.ts`, `loadResidentBounds` in `df2-3`, `src/protocol/`, `DF6.1`, markers in the
  yaml and in the two story directories.
- **Amendment B, C, C-erratum, D, E, F, G are all factually grounded**: the audit/register do
  carry the drift the errata correct; `df2-3` carries the operator-corrected chain and the
  retired old chain survives only inside a blockquote; the yaml matches the G table and its
  fourteen-change arithmetic (14 unique changes: 6 written arrays + 8 comments — the one
  other-hand array excluded from the count, per the story's own P1.18 note).
- **The P1.18 hand-off is real and executable**: both DF6.1 halves carry the severance at the
  named search anchors, for the two different reasons the story claims; `p1-18:36` carries the
  payload shape; the fallback text is pre-authored, markered, and sanctioned inside INV-1's
  tripwire with the log duty attached.
- **The gates are executable**: the yaml `meta:` block exists for the recompute DoD; the test
  home exists with the named sibling files; the 11-path marker count is currently achievable
  (no pre-existing marker in either directory); AC1's regex and its DF-filter are sound against
  the artifacts the story itself prescribes; negative controls all name a failure home
  (test failure for wrong-successor and missing-successor, review for the provenance rewrite —
  explicitly declared not an assertion sub-part, unproven-not-clean for unreadable files).
- **INV-1's four in-block edits are exactly four**: `p1-3` AC item 4, `p1-3` DoD ×2, `p1-12` AC
  item 3 — verified against each file's header geometry; `p1-11:48` is in Technical Notes as
  claimed; `p1-18:50` is inside Security Invariants, which is why the fallback needed
  pre-authorisation.
- **Cross-artifact coherence**: the yaml's `superseded-by` comments independently confirm all
  ten successor-map rows; the epics index carries the current make-or-break statement (A–F +
  three greps); DF2.8's done-date matches amendment D's prose; DF5.3/DF1.10/DF2.10 statuses match
  the re-verification gate's assumptions; the yaml DF5.5 row lists DF6.1a as a scheduling edge
  exactly as the E2E Slice distinguishes it.

## Verdict

**CONVERGED — confidence: HIGH.**

Zero BLOCKER, zero HIGH, zero C2, zero C3. The residue is two C1-LOW counts (one stale
self-referential numeral in the story, one out-of-scope dangling `superseded-by` in a
historical yaml row) and two C4-LOW wording nits, none of which touches a gate, an anchor, a
repoint target, or the classification machinery. This is the rare chore spec where every
line-number claim, every quote, every zero-count and every status claim survived a fresh
source check — the dev can apply the occurrence table as written, with the deviation rule
still covering any drift between now and apply time.

## Summary counts

| | C1 | C2 | C3 | C4 | Total |
|---|---|---|---|---|---|
| BLOCKER | 0 | 0 | 0 | 0 | **0** |
| HIGH | 0 | 0 | 0 | 0 | **0** |
| MEDIUM | 0 | 0 | 0 | 0 | **0** |
| LOW | 2 | 0 | 0 | 2 | **4** |
