# HANDOFF — QDS story-review campaign → Wave 8 fix wave + Wave 9 (written 2026-09-13, Wave-7 session)

**Written for a fresh session.** Everything below verified against the tree today. The prior
handoffs each contained wrong claims — expect this one to be wrong somewhere too. Verify before
acting. The campaign's one rule outranks everything: **open the file before ratifying anything**;
cite by symbol or section anchor, never by line.

---

## 1. Where the campaign stands

Wave 7 (seam-ownership rework) is **DONE and gated**: five seam-ownership tables under
`_bmad-output/sprint-artifacts/dark-factory-v5/seam-ownership/unit-{A..E}-*.md`, all 90 Wave-6
findings dispositioned, the two DF3.6a operator rulings implemented (honest-metered operand;
user-policy ceiling ladder), and the session's unlazy ledger `.unlazy/wave7-rework/GATES.md` is
**ALL 8 GATES MET** (tables, dispositions, archetypes dead, metering basis resolved, consistency
gate green, no new line-cites — 328 vs 407 baseline — zero pin inputs touched, Wave-8 filed).

Wave 8 (fresh verification of the reworked specs) is **DONE, verdict recorded**: NOT CONVERGED.
Full analysis + per-unit verdict table: tracker §"Wave 8 result". Reports:
`_bmad-output/evidence/qds-story-review-2026-09-08/wave8-{A,B,C,D,E}-*.md`.

**The numbers:** 90 → 48 findings; BLOCKERs 5→0; HIGHs 20→5; C2 18→5; C3 31→13.
**DF3.7 is CONVERGED (high confidence)** — the first story to converge in the campaign.
Zero C2 in units A and B: the mechanism claims all held; the residue is addresses and seams.

## 2. Working-tree state (verified 2026-09-13)

- Branch `feature/wave7-seam-ownership-rework` cut from `dev` @ `581539a4`. **All Wave-7+8 work is
  UNCOMMITTED** — 9 story files, the tracker, `sprint-status.yaml`, 5 new seam-ownership tables,
  5 new wave8 evidence reports, `.unlazy/wave7-rework/` (untracked).
- GitNexus reindexed fresh at `581539a4` (stamp in `.gitnexus/cli-version.json`); the store was
  wiped and rebuilt once this session after a duplicate-PK LanceDB failure (known family — if
  reindex dies with "duplicated primary key", delete `.gitnexus/lbug/` and re-run
  `GITNEXUS_SKIP_INSTALL=1 bash scripts/install-gitnexus-plus.sh`; the script exits 0 even when
  analyze fails — check the stamp).
- Consistency checker green throughout: `bun scripts/check-story-consistency.ts` (no npm alias —
  package.json is a COPY input).

## 3. The job, in order

1. **Commit + PR the Wave-7/8 work** (operator-gated — ask first). Branch convention: prefix
   `feature/`, base `dev`, target `dev`. One commit or a few logical ones; the diff is
   markdown + yaml only (G7 proves no pin input moved — re-verify `git status` before claiming).
   After merge, the tenth-pin ritual does NOT trigger (no walked inputs touched).
2. **Fix wave on the 48 Wave-8 findings.** Work from the five reports
   (`wave8-{A,B,C,D,E}-*.md`) — **point fixers at the report sections, never relay findings**.
   The load-bearing core (tracker §Wave 8 lists them; the reports carry the fix directions):
   - W8-C-… (3 HIGH): DF3.6a stamped operands have no fill-side provisioner; DF3.6b's live legs
     sited on a darwin host-side file; DF3.6b AC4's stop/record unreachable under the closed edit
     list.
   - W8-D-… (1 HIGH): attempt-state lookup reads a record no one writes pre-terminal — needs an
     owned dispatch-time parent-record write (or re-keying the attempt state).
   - W8-A-… (1 HIGH): DF3.8 AC4(d) retirement vs no-persistence self-contradiction.
   - W8-B: F001/#157 "declared, not wired" premise inverted by landed DF2.12 (DF5.3, DF5.4,
     DF6.1a's observability bullet) — token rows exist now; per the session-2 notes, DF5.3/DF5.4
     may now assert them.
   - Everything else is MEDIUM/LOW per the reports; MEDIUMs and LOWs are not optional (ground rule 6).
3. **Wave 9: fresh verifiers**, same protocol as Wave 8 (no recipes, no prior reports, category
   classification, per-story verdict). Convergence target unchanged: **C4-dominant residue**.
   Unit A suggests the protocol converges: DF3.7 crossed on the first pass.

## 4. Settled rulings — do not re-litigate

Charter §5 (`2026-09-10-wave7-HANDOFF.md`) all stand, **plus the two 2026-09-13 DF3.6a rulings**:
honest-metered operand (accumulator = `meter(reply.usage)` actuals; refusal = pre-call projection
check; AC1 margin = ceiling + one call); ceiling = user policy (per-issue `perIssueOverrides`
override → global default → 8,000 µ$ shipped fallback; `below_one_call` = named policy outcome).
W6-A-H1's deletion ruling stands (no `markerWitnessed`; collected ⇒ `completion-unwitnessed`).
W6-D-B1's invocation ruling stands (invocation 2 continues into DF6.1b's poll leg).

## 5. What NOT to do

- No prose-patch round past the fix wave; the protocol is fix → fresh verify → converge.
- No editing done stories' dev records; no new stories without a named owner per deliverable.
- No line-number citations in anything written; symbol or section anchor only.
- Never a bare `bun test` (tee to a log you own); never a bare `gitnexus analyze`; never loosen the
  gitnexus contract schema; never exclude `tests/gitnexus/`.
- Don't brief verifiers with fix recipes or author self-doubts — Wave 8's zero-C2 units are
  evidence the clean protocol works.
- Self-proving greps mandatory for any zero-match claim.

## 6. Read order

1. This file. 2. Tracker §"Wave 8 result" + §"Wave 7" (this session's record). 3. The five
`wave8-*.md` reports (the fix wave's worklists). 4. The five `seam-ownership/unit-*.md` tables
(ownership law for the nine specs). 5. `sprint-status.yaml` (authoritative on status). 6. Charter
`2026-09-10-wave7-HANDOFF.md` §5 rulings table.
