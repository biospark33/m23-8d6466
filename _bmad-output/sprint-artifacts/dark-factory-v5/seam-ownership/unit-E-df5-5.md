# Seam-ownership table — Unit E: DF5.5 (the repoint chore)

Wave 7 rework artifact. Worklist: `wave6-E-df5-5-df2-11-12-13.md`. DF5.5's own contract is with
*every other artifact* — its C3 class is self-referential drift: the story describing artifact states
that later same-day commits changed. Wave 7's fix is structural, per verifier E's recommendation:
**`sprint-status.yaml` and the epics index are cited by story key or search anchor, never by line
number, anywhere in this story.**

## Ownership

| # | Deliverable | Owner (exactly one) |
|---|---|---|
| O1 | The 11-file KEEP amendment set (amendments A, C, D, F + the `p1-18:50` hand-off) | DF5.5 |
| O2 | `tests/scripts/keep-repoints.test.ts` (four assertions) | DF5.5 |
| O3 | The amendment log (Dev Agent Record) | DF5.5 |
| O4 | `sprint-status.yaml` meta-block arithmetic — recomputed from rows at every slate change | parent, per done-flip (already the standing discipline; E-H1's meta-block defect was fixed by the DF2.13 done-flip) |
| O5 | The epics index (DF2.13 entry) | parent — **landed and verified at source 2026-09-13** (grep `DF2.13` → 1; control `DF2.8` → 16) |
| O6 | DF2.11/DF2.12/DF2.13 findings (E-M4..M8, L6..L13) | out of scope — done stories, charter §8 bars editing their dev records beyond factual nits |
| O7 | `df3-6a`'s three "at the dispatcher" framings | **Unit C** (DF3.6a is in Wave-7 scope; E-M7's ownership tail lands there) |

## Reconciliations applied (Wave 6 → spec)

| Finding | Disposition |
|---|---|
| W6-E-H1 (C3) | **Meta block already corrected** by the standing done-flip discipline (O4; the DF2.13 flip recomputed it — yaml comments record the recompute chain). DF5.5's remaining leg landed: a DoD "Verify" item asserting the **recompute-from-rows** check at apply time — never a hardcoded count, so it survives future slate changes. |
| W6-E-M1 (C1) | **Amendment G's line column deleted** — the table is keyed by story key alone, exactly as its own closing sentence instructs. |
| W6-E-M2 (C3) | **`p1-9` divergence note rewritten in past tense** — the union was resolved and applied 2026-09-08 (amendment G's record); DF5.5's remaining obligation is the `p1-9:25` edit only; the `sprint-status.yaml:99` instruction and the imperative present tense are gone. |
| W6-E-M3 (C3) | **Verified closed at source 2026-09-13** (O5): every slate story has an epics-index entry, DF2.13 included. Trigger Surface row rewritten to record the verification with its positive control — no follow-up owed, no owner named. |
| W6-E-L1 (C1) | P1.18 disposition's yaml citations by story key (the P1.18 row), line numbers gone. |
| W6-E-L2 (C1) | `mintRunKey` cited by symbol; the `credentials.ts` line numbers gone. |
| W6-E-L3 (C1) | Marker enumeration corrected and verified at source: the literal occurs **12× in this story file** and **0× in the epics doc**; at apply time the test file carries it too. The scoping argument survives on the story file alone. |
| W6-E-L4 (C4) | Negative (3) extended to DF2.13: not the successor of any retired ID, referenced by no KEEP story. |
| W6-E-L5 (C4) | "DF3.6" references name the split (DF3.6a/DF3.6b). |
| W6-E-M4..M8, L6..L13 (DF2.11/12/13 findings) | Out of scope (O6) — done stories; their citations describe shipped history and the checker reports them as info, not gated. E-M7's `df3-6a` ownership tail is O7 → Unit C. |
