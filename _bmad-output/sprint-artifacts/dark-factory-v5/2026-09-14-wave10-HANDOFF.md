# HANDOFF — QDS story-review campaign → Wave 9 fix → Wave 10 verify → dev phase
(written 2026-09-14, end of the Wave-9 verification session)

**Written for a fresh session.** The campaign's one rule outranks this file too: **open the file
before ratifying anything** — including this handoff. Cite by symbol or section anchor, never by
line number.

---

## 1. Where the campaign stands

- **Wave 9** (fresh verify, post-fix-wave): DONE — **NOT CONVERGED, 48 findings** (B2 / H4 /
  M10 / L32; by class C1×15 · C2×6 · C3×11 · C4×16) in
  `_bmad-output/evidence/qds-story-review-2026-09-08/wave9-{A,B,C,D,E}-*.md`. **DF3.8 and DF5.5
  CONVERGED** (zero B/H/C2/C3). 7 of 9 stories remain. Rollup with per-unit table and
  parent-verification notes: tracker §"Wave 9 result"
  (`2026-09-08-remaining-stories-pre-dev-review-tracker.md`).
- **Convergence target unchanged: C4-dominant residue** (zero BLOCKER/HIGH, zero C2/C3 per
  story; C1-cite-rot and C4 wording residue acceptable). C4 is now the largest single class, but
  BLOCKERs went 0→2 — **both on seams the Wave-8 fix wave itself opened or touched**.
- Likely-first convergers after the next fix wave: unit A (one MEDIUM C3 — the "eighth
  `teardownSandbox` call site" ordinal, contradicted by DF2.11's own record) and unit B (two C3
  MEDIUMs, both rated one-sentence fixes by the verifier). Units C and D need real work.

## 2. Working-tree state (verify before acting)

- Branch `feature/wave7-seam-ownership-rework`, PR **#255** → `dev` (open, awaiting operator
  merge). HEAD at verification time: `6a7ae6c2`.
- **UNCOMMITTED at handoff time** (Wave-9 evidence, awaiting operator confirmation):
  - `_bmad-output/evidence/qds-story-review-2026-09-08/wave9-{A,B,C,D,E}-*.md` (5 new files)
  - tracker edit: §"Wave 9 result" + four new Wave-progress table rows.
  First act of the next session: get operator confirmation, commit these on this branch (they
  ride PR #255), re-run `bun scripts/check-story-consistency.ts` (expect "OK — 42 stories,
  169 pts").
- Known parent-owned operational debt (not a spec defect): `sprint-status.yaml`'s meta block DF
  totals are stale (claims 37 stories/151 pts; live rows recount **42 stories/169 pts**). DF5.5's
  DoD recompute-and-halt gate WILL fire at pre-flight — fix the meta block before DF5.5 enters
  dev. One parent-owned edit, outside any story's diff.
- GitNexus: indexed at `581539a4`, stale for md-only work (irrelevant to spec edits; grep
  suffices for symbol checks). Reindex via `bash scripts/install-gitnexus-plus.sh` only when code
  work starts (dev phase); if "duplicated primary key", wipe `.gitnexus/lbug/` and re-run; check
  the stamp — the script exits 0 on failure.

## 3. The job, in order

### 3a. Wave 9 fix wave (in-session sequential is the precedent)
The Wave-8 fix precedent: parallel fix agents died pre-edit on provider 429 weekly-limits — run
the units **sequentially in-session** (A → B → C → D → E), same protocol: read the wave9 report
section for the unit, verify every claim at source before editing, cite-by-symbol, positive
controls on zero-match greps, `bun scripts/check-story-consistency.ts` green after every unit.
**Scope: the 2 BLOCKERs + 4 HIGHs + 6 C2s + 11 C3s.** LOWs and C4s are optional; fix C1 cite-rot
in-pass where the touched line is already open. Do NOT touch converged stories DF3.8 and DF5.5.

Fix directions live in the wave9 reports (point the fixer at the report section, never relay).
The load-bearing ones, with the parent's verification notes:

- **W9-D-1 (BLOCKER, DF6.1a AC3) — APPLIED 2026-09-14 (CodeRabbit round, this branch):**
  invocation-2 resolves the fix run through
  `extensions.fixLoop.fixAttemptRunIds`, which only DF6.1b registered
  (`run-record.ts` `EXTENSION_NAMESPACES.fixLoop` = `fixContext`/`fixOutcome` only), DF6.1b is
  sequenced after, and DF6.1a's own Files list said `run-record.ts` "no change expected" while
  claiming buildability "using only code merged by this story plus its predecessors". Read-path
  tolerance (unfamiliar field in a registered namespace) means no runtime crash — it is an
  ordering/testability seam. Resolution applied: **DF6.1a owns the
  adds-only registration + the dispatch-time append** (it owns the dispatch code path), DF6.1b's
  O15/O22 rows re-homed accordingly (`seam-ownership/unit-D-df6-1ab.md`), both halves'
  same-file postures reconciled with the forward-dependency note in DF6.1a's Files list, and the
  attempt-1 append owner is that same DF6.1a row (W9-D-3 closed in the same stroke).
- **W9-D-2 (HIGH, DF6.1b AC2/DoD) — APPLIED 2026-09-14 (CodeRabbit round, this branch):** the uncharged-attempt ceiling of 3, the per-attempt
  classification list, and `out-of-scope-diff`'s cap of 1 need **storage** no declared state can
  hold (record vocab closed; ledger = runIds only; `fixOutcome` write-once-at-terminal;
  `dispatch-refused` provisions nothing). Resolution applied: the per-attempt lifecycle states
  (awaiting-approval / charged-terminal / poll-interrupted-recovery / orphaned) are **derived on
  the driver's read from the fix run's own record** — approval extension ⇒ awaiting-approval
  (uncharged, uncounted, continuation), `fixContext` without approval or terminal ⇒ poll
  recovery within the window, neither ⇒ orphaned (counts toward the uncharged ceiling) — no new
  registration, no second ledger field, and a crash cannot strand a half-written state.
  AC2's "escalates immediately" reconciled: `dispatch-refused` escalates on first occurrence and
  never accumulates (it provisions nothing and spends nothing); the accumulate-to-3 ceiling
  covers the spend-bearing uncharged classifications only.
- **W9-D-4 (HIGH, DF6.1a AC2):** the proposal-variation trigger ("run carries a `fixContext`
  brief key") is unobservable in `src/reverify/runner.ts` (zero brief refs; brief consumed
  in-memory in `dispatch.ts`, never persisted host-side; `fixContext` written only after the
  push, after `requestApproval` fires). The fix must plumb a marker through an owned surface or
  re-site the trigger; "No other behavior changes" must not be violated silently.
- **W9-C-1 (BLOCKER, DF3.6b AC1/AC5):** the make-or-break `resident.exitStatus:"overflow"` is
  clobbered by the shipped final refresh in `scripts/pipeline-run.ts`
  (`residentBlock.exitStatus = await residentSpawn.exitStatus()` — "the process's word is
  telemetry"); `resident.ts`'s `lastExit` is only ever `"success"`/`"transient"`/`"logic"`.
  Fix: enumerate the final refresh in the pair's six-edit list (a seventh edit or a re-scoped
  (v)) and specify the precedence (telemetry's word vs the process's word) explicitly.
- **W9-C-2 (HIGH, DF3.6a AC2a):** the refusal payload `{ok:false, code, message, remediation}`
  cannot pass through `writeTerminalMarker` (hard-codes `{runId, ok, completedAt}`) and
  `journal.ts` is unowned; the ≥4096-byte `unknown`-verdict arm is an adjacent unacknowledged
  risk. Fix: own the writer change or re-site the payload (e.g. `fleet warn` chokepoint + boolean
  marker), and state the 4096 interaction.
- **W9-C-3 (HIGH, DF3.6b AC4) — APPLIED 2026-09-14 (CodeRabbit round, this branch):** the
  exit-97 `unenforceable` classification now crosses as an engine-owned typed rejection on the
  `ResidentCaller.call` contract (thrown by fleet's caller, caught by an `instanceof` arm beside
  the degrade arm), firing `onBoundBreach` with the classification; the runner's edit-(v) arm
  records the payload on the fleet `warn` chokepoint and awaits `stop()`. Note for the record:
  the report's clause "later solicitations keep issuing into the
  broken placement" is WRONG (the status gate treats a degraded resident as absent — no further
  calls); the finding's substance (no `onBoundBreach` channel ⇒ no stop, no record) is what the
  fix closes.
- **W9-B (2 C3 MEDIUM):** state `recordAuditLink` requiredness once (optional signatures cannot
  deliver the typecheck-loudness guarantee); give the hop-6 refs/sandbox leg a seam (declare the
  ref corroborating-only, or add the git-dir seam) — shared with DF5.4-C9, fix once, mirrored.
- **W9-A (1 C3 MEDIUM):** DF3.7's "eighth `teardownSandbox` call site" vs DF2.11's record, which
  assigns the eighth to DF3.8's sweep (parent-verified). Reconcile the ordinal or drop it.
- **C2 residue (6):** DF6.1a's inherited DF13 briefing still says the fleet-ceiling race was
  "Re-verified TRUE at `fa7d0e26`" — false; closed by `99f591e3`, a verified ancestor
  (`git merge-base --is-ancestor`). C's DoD-mirror "gate fails every attempt" trigger is
  unreachable (`attempt > spec.retries` rethrows — AC3's own prose is correct, the DoD regressed);
  C's AC4 projection-charging needs a classification on the DF2.12 attribution row;
  C's AC5(b) log-line clause is unreachable (status gate precedes the bounds check);
  D's escalation vocabulary omits `scope-requires-privilege` and `bot-response-to-fix`.

### 3b. Wave 10 — fresh verify
Same protocol as Wave 9: five verifiers (A: DF3.7+DF3.8 · B: DF5.3+DF5.4 · C: DF3.6a+DF3.6b ·
D: DF6.1a+DF6.1b · E: DF5.5), launched in ONE message, **scope files only** — no fix recipes, no
prior-wave reports, no tracker sections, no seam-ownership tables. Symbol-or-anchor citations,
positive controls on every zero-match, C1–C4 × B/H/M/L, per-story CONVERGED/NOT CONVERGED with
confidence. Reports to
`_bmad-output/evidence/qds-story-review-2026-09-08/wave10-{A,B,C,D,E}-*.md`. Roll up tracker
§"Wave 10 result". Repeat fix→verify until C4-dominant. **No prose-patch round past a converged
verdict.**

### 3c. Dev phase — build the nine stories
Once the unit's stories converge, implement via the `qds-dev` skill (branch `feature/`, base and
target `dev`; ALL PRs merge into `dev`). Dependency order per the yaml edges; DF3.6a ≺ DF3.6b and
DF6.1a ≺ DF6.1b inside their pairs; DF5.5 LAST (it repoints merged specs and its DoD
recompute-and-halt gate needs the yaml meta block fixed first). Live E2E rounds (DF3.6b's AC1
legs etc.) use the `qds-live-e2e` skill — real boxes, real spend, no fakes.

**Out of scope for the finish line:** any SwarmClaw-DAG / UI overlay over the factory. No story
owns it; it is not in the nine-story slate. The only UI in the recorded design is `visualizer/`
(Vue 3, read-only over the trace). Cost ceilings are config-level by design
(`perIssueOverrides` → global default → fallback ladder, DF3.6a) — a future UI could author
`perIssueOverrides`, but no story builds that layer. Do not scope-creep.

## 4. Settled rulings — do not re-litigate
Charter §5 (`2026-09-10-wave7-HANDOFF.md`) all stand, plus the Wave-8 fix rulings (tracker
§"Wave 8 fix"): DF3.6a honest metered operand + ceiling ladder; `below_one_call` named outcome;
no `markerWitnessed`; DF6.1a invocation 2 continues into DF6.1b's poll leg; head-branch parent
join; `fix-ceiling-insufficient` in `feedback-run.ts`; fill-side stamp = DF3.6a's O20/O21;
in-pass retirement in DF3.8 AC4(d); `out-of-scope-diff` charges zero, cap 1, owned by DF6.1b;
sweep event `sweep-box-unreachable`. The W9 seam findings above are fix-wave DECISIONS to make,
not rulings to re-argue.

## 5. What NOT to do
- No editing done stories' dev records; no new deliverable without an owner row in a unit table
  (`seam-ownership/unit-*.md` — update the table when the fix wave re-homes ownership).
- No line-number citations in anything written. Self-proving greps mandatory for zero-match.
- Never a bare `bun test` (tee to a log, strip ANSI/CR before grepping). Never a bare
  `gitnexus analyze`. Never loosen the gitnexus contract schema; never exclude `tests/gitnexus/`.
- `bun scripts/check-story-consistency.ts` after every unit of edits; green or fix.
- Commit + PR only with operator confirmation. Branch convention: prefix `feature/`, base `dev`.
- Verifiers never read tracker/prior reports/ownership tables/handoffs. Fixers DO read the
  current wave's report for their unit (that is the fix-wave exception).
- If spawned subagents die with 429s: fall back to in-session sequential work; do not stall.

## 6. Read order
1. This file. 2. Tracker §"Wave 9 result" + §"Wave 8 fix" + §"Wave 8 result" + §"Wave 7".
3. `sprint-status.yaml` (authoritative on status; fix the meta block before DF5.5). 4. The five
`seam-ownership/unit-*.md` tables. 5. Charter `2026-09-10-wave7-HANDOFF.md` §5. 6. The five
`wave9-*.md` reports (fix-wave input; Wave-10 verifiers must NOT read them).
