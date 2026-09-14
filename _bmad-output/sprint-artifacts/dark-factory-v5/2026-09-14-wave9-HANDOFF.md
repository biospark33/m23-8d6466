# HANDOFF — QDS story-review campaign → Wave 9 fresh verify (written 2026-09-14, fix-wave session)

**Written for a fresh session.** Written AFTER the fix wave landed. Everything below was true when
written; the campaign's one rule outranks this file too: **open the file before ratifying
anything** — including this handoff. Cite by symbol or section anchor, never by line.

---

## 1. Where the campaign stands

- **Wave 7** (seam-ownership rework): DONE, merged via PR #255 (2 commits: `0378b070` edits,
  `3cda27c2` record+evidence). Five tables under `seam-ownership/unit-{A..E}-*.md` are the
  ownership law for the nine specs.
- **Wave 8** (fresh verify): DONE — NOT CONVERGED, 48 findings in
  `_bmad-output/evidence/qds-story-review-2026-09-08/wave8-{A,B,C,D,E}-*.md`. DF3.7 CONVERGED.
- **Wave 8 fix wave**: DONE this session (2026-09-14), executed in-session by the parent (five
  parallel fix agents died pre-edit on provider 429 weekly-limit — resets 2026-09-17). **All 48
  findings dispositioned**, protocol intact: every claim verified at source before editing,
  cite-by-symbol law, self-proving greps with positive controls, `bun
  scripts/check-story-consistency.ts` green after every unit and at the end. Full disposition
  record: tracker §"Wave 8 fix — all 48 findings applied in-session (2026-09-14)".
- **Ownership law updated for the fix wave's new deliverables**: unit-C rows O20/O21 (fill-side
  stamp provisioner — DF3.6a, adds-only in dispatch.ts), unit-D O15 extended + O22 (the
  attempt-time `fixAttemptRunIds` ledger — DF6.1b, invoked from DF6.1a's invocation, the O5
  pattern), unit-A O15 renamed (`sweep-box-unreachable`).

## 2. Working-tree state (verify before acting)

- Branch `feature/wave7-seam-ownership-rework`, PR **#255** → `dev`. The fix wave is committed on
  top of `3cda27c2` (specs+tables commit, then tracker+handoff commit). G7 still holds: the whole
  branch diff is `_bmad-output/**` markdown + YAML — zero image-pin inputs, tenth-pin ritual does
  not trigger. Re-verify `git status` before claiming anything.
- Gate: `bun scripts/check-story-consistency.ts` (no npm alias) — expected: "OK — 42 stories,
  169 pts, all gated artifacts agree".
- GitNexus: reindexed at `581539a4` (stale for this branch's md-only work — irrelevant to specs;
  only needed if Wave 9 verifiers check code symbols, and grep suffices for that).

## 3. The job: Wave 9 — five fresh verifiers

Same protocol as Wave 8, no deviations:

1. **Five verifiers, one per unit** (A: DF3.7+DF3.8 · B: DF5.3+DF5.4 · C: DF3.6a+DF3.6b ·
   D: DF6.1a+DF6.1b · E: DF5.5), launched in ONE message, parallel.
2. **Brief each with: scope files only.** NO fix recipes, NO prior-wave reports, NO tracker
   sections, NO seam-ownership tables, NO author self-doubts. Wave 8's zero-C2 units are the
   proof the clean protocol works.
3. Each verifier: read the specs fully; open every named symbol/path/flag/constant at source;
   every zero-match claim carries a positive control; classify findings C1-citation /
   C2-semantic / C3-structural / C4-marginal × BLOCKER/HIGH/MEDIUM/LOW; per-story verdict
   CONVERGED / NOT CONVERGED with confidence.
4. Reports to `_bmad-output/evidence/qds-story-review-2026-09-08/wave9-{A,B,C,D,E}-*.md`.
   Verifier reads files fresh from the working tree (post-fix-wave). Read-only.
5. Roll up into tracker §"Wave 9 result" (per-unit table like Wave 8's). **Convergence target
   unchanged: C4-dominant residue.** DF3.7 and DF3.8 are the stories most likely to cross.

## 4. Settled rulings — do not re-litigate (fix wave worked within all of them)

Charter §5 (`2026-09-10-wave7-HANDOFF.md`) all stand, plus:
- **DF3.6a honest metered operand** (accumulator = `meter(reply.usage)` actuals; refusal =
  pre-call projection; AC1 margin = ceiling + one call).
- **DF3.6a ceiling ladder** = user policy: `perIssueOverrides` → global default → 8,000 µ$
  fallback; `below_one_call` = named policy outcome.
- **W6-A-H1 deletion**: no `markerWitnessed`; collected ⇒ `completion-unwitnessed` unconditionally.
- **W6-D-B1 invocation**: invocation 2 continues into DF6.1b's poll leg.
- **W6-D-H1/H2**: head-branch parent join; `fix-ceiling-insufficient` in `feedback-run.ts`.
- **New from the fix wave (Wave-9 verifiers verify, not re-argue)**: DF3.6a owns the fill-side
  stamp edit in dispatch.ts (O20/O21); DF6.1b owns the `fixAttemptRunIds` dispatch-time ledger
  and its invocation call site (O15/O22); DF3.8's retirement is in-pass (AC4(d)); `out-of-scope-diff`
  charges zero, capped at 1, owned by DF6.1b; sweep event is `sweep-box-unreachable`.

## 5. What NOT to do

- No prose-patch round past Wave 9's verdict; protocol is fix → fresh verify → converge.
- No editing done stories' dev records; no new deliverable without an owner row in a unit table.
- No line-number citations in anything written; symbol/section anchor only. Self-proving greps
  mandatory for zero-match claims.
- Never a bare `bun test` (tee to a log); never a bare `gitnexus analyze` (use
  `bash scripts/install-gitnexus-plus.sh`; if "duplicated primary key", wipe `.gitnexus/lbug/`
  and re-run; check the stamp — the script exits 0 on failure). Never loosen the gitnexus
  contract schema; never exclude `tests/gitnexus/`.
- Run `bun scripts/check-story-consistency.ts` after every unit of edits; green or fix.
- Commit + PR only with operator confirmation. Branch convention: prefix `feature/`, base `dev`.
- If spawning subagents and they die with 429s: the weekly limit is shared — fall back to
  in-session sequential work (the fix wave is the precedent) rather than stalling.

## 6. Read order

1. This file. 2. Tracker §"Wave 8 fix" + §"Wave 8 result" + §"Wave 7". 3. `sprint-status.yaml`
(authoritative on status). 4. The five `seam-ownership/unit-*.md` tables. 5. Charter
`2026-09-10-wave7-HANDOFF.md` §5. 6. The five `wave8-*.md` reports (context only — Wave 9
verifiers themselves must NOT read them).
