# DF6.1a live e2e handoff — the MANDATORY two-invocation fix-loop round (deferred by operator 2026-09-20)

Fresh-session prompt below. Everything except this round is DONE and verified on
`feature/df6-1a-fix-loop-append` (base `dev`, commit `1b653f04`, pushed; expect follow-up
integration commits from the node-1 branch gate — use the branch tip).
Governing procedure: the `qds-live-e2e` skill (`.claude/skills/qds-live-e2e/SKILL.md` —
read it FIRST: hard rules, spend protocol, gotchas). DF5.3's handoff
(`_bmad-output/plans/df5-3-live-e2e-handoff.md`) is the shape precedent.

## What exists (do not rebuild)

- `scripts/fix-run.ts` — the CLI under test: `--pr <n> [--dir <recordsDir>] [--repos-file
  <path>] [--cap-micro-usd <n>]`. Exit codes: 0 awaiting-approval/appended/no-op; 2 usage;
  5 refusals (incl. `fix-scope-missing`, `fix-ceiling-insufficient`,
  `fix-roster-not-single-fixer`, `credential-probe-hit`, `out-of-scope-diff`,
  `scope-requires-privilege`, `lock-refused`, `approval-binding-mismatch`, `push-refused`);
  1 provider/run failure; 6 work landed but reporting/cleanup failed.
- `tests/fleet/e2e/tier3-fix-loop-append.live.test.ts` (1,574 lines) — the round, authored,
  `liveGate("2")` + `test.todoIf(liveTodoOff())` gated. Leg 0 verifies every prerequisite
  pre-spend and THROWS with setup instructions on any absence. It passes `--cap-micro-usd
  50000` so the round's minted key honors the skill's 50 000 µ$ cap convention (production
  default is `defaultKeyCapMicroUsd` = $50 — the header's SPEND block names both).
- `.factory/fix-scope.json` — host-owned scope artifact, mode 0600, UNTRACKED (`.gitignore`
  ignores all of `.factory/`, same discipline as `repos.json`; the story's "ships" resolves
  as operator-local — an operator decision is still open on whether to force-add it).
  Entries exist for both casings of `Quantum-Digital-Solutions/qds-audit-demo`.
- Org recon (2026-09-19): `coderabbitai` is installed org-wide with
  `repository_selection: all` — a fresh PR on qds-audit-demo gets a real bot review comment
  with no app installs.
- Unlazy scope `df6-1a` (`.unlazy/df6-1a/`): PLAN rev 1, all 7 leaves VERIFIED, node-1
  branch gate green (34/34 leaf gates re-executed + full suite + lint + statics at the
  branch gate). `gates/node-2.md` is THIS round's ledger — its 4 gates are what the new
  session works. Oracles are approved at `--timeout 900` binding; run gate-check with
  `--timeout 900` (or `--approve` fresh). node-2 G3's CHECK runs the live file — with
  `QDS_E2E_LIVE` exported it executes for real; without it, it todo-gates.

## Environment prep runbook (the story's four prerequisites + the repo's own needs)

Target repo: `Quantum-Digital-Solutions/qds-audit-demo` (private; `.factory/repos.json`
registers both casings, `authorLogin: biospark33`). Do NOT target QDS-Factory itself.

1. **(i) Branch protection with one fast REQUIRED check.** The repo currently has NO
   branch protection and NO workflows. Add `.github/workflows/ci.yml` on its default
   branch with one trivially fast job (e.g. `check: run: echo ok`), push, then:
   `gh api -X PUT repos/Quantum-Digital-Solutions/qds-audit-demo/branches/main/protection`
   with `required_status_checks` naming that check context. (This is environment prep by
   the operator — the fixer itself may never touch `.github/**`; the fix-scope deny-list
   refuses exactly that, which is the point.)
2. **(ii) Review bot comment.** Covered by the org-wide CodeRabbit install — verify on the
   fresh PR: `gh api repos/Quantum-Digital-Solutions/qds-audit-demo/pulls/<n>/comments
   --jq '.[] | {user: .user.login, type: .user.type}'` shows ≥1 `Bot`-type (or
   `[bot]`-suffixed) review comment. The test ALSO requires ≥1 comment surviving
   `fetchBotComments`' briefability filter (plain Markdown review text is fine).
3. **(iii) An OPEN DF5.2-produced PR** under `biospark33`, head branch `qds/<runId>`
   (minted grammar `qds-YYYYMMDD-xxxxxx`), carrying the bot comment from (ii). All four
   existing PRs on the repo are MERGED — produce a new one via the proven DF5.x path
   (small factory dispatch against qds-audit-demo + reverify + `fleet approve` +
   `fleet push`; see the DF5.3 handoff §Round shape 3-4) and DO NOT merge it. This prep
   costs its own box+key (~50 000 µ$ + box-hours) — include it in the estimate print and
   the operator go. **The PR branch must carry `config/rosters/roster.yaml`** (the
   shipped lead+fixer roster — the in-box `dispatch_task` loads its roster from the box
   checkout; commit it into the demo repo).
4. **(iv) fix-scope entry** — already shipped (`.factory/fix-scope.json`, both casings);
   verify presence + mode 0600 pre-round (the test's leg 0 re-verifies through
   `readFixScope` itself).
5. Export `QDS_E2E_FIX_PR=<pr number>` — the test's env pointer; absent ⇒ it THROWS with
   the setup recipe pre-spend.
6. Working tree: the round runs inv1/inv2 with cwd = the QDS-Factory checkout root
   (production hostRoot shape). Push the branch before the round (the test checks
   `config/rosters/fix-run.pipeline.json` exists inside `QDS_EXEDEV_SHA` when resolvable).

## The round

```
QDS_E2E_LIVE=1 QDS_E2E_TIER=2 QDS_E2E_FIX_PR=<n> \
  bun test tests/fleet/e2e/tier3-fix-loop-append.live.test.ts
```

Print the worst-case estimate first (1 box + 1 key capped 50 000 µ$ + box-hours ≈ $0.60
worst case, PLUS the prep box+key for the PR) and take the explicit operator "go"
(node-2 G2). The test self-executes: free `fix-scope-missing` negative control → inv1
(fix run in-box, locality legs: readBoxFile marker, `systemctl` unit start, host
process-table pi diff) → exit 0 `awaiting-approval` → in-harness `fleet approve` → inv2 →
`state:"appended"` → fast-forward + fixContext assertions → finally battery
(teardown/destroy, `keyLeakProblems`, final-ls zero `qds-*` boxes).

## After green (node-2 G4 + closeout)

1. External evidence review: the PR on GitHub shows the appended commit; the fix run's
   record carries fixContext (attemptSha, commentIds, commentsDigest, pollWindowOpenedAt;
   no prose); trace rows exist.
2. File the disposable-repo RETENTION issue (DF6.1b named as the second and last
   consumer; delete after DF6.1b's demo) — the way DF5.2 tracked qds-df52-e2e (#133).
3. Update the story DoD checkboxes + Dev Agent Record, sprint-status.yaml DF6.1a → done,
   finish the unlazy root ledger (`.unlazy/df6-1a/GATES.md` R1-R3; reverify node-2 first).
4. PR `feature/df6-1a-fix-loop-append` → `dev` (target=dev per branch convention).
5. GitNexus: reindex via `bash scripts/install-gitnexus-plus.sh` (never bare analyze),
   then `bun test tests/gitnexus/` must stay green.

## The prompt (paste into the new session)

```
/qds-live-e2e DF6.1a node-2 — run the MANDATORY fix-loop live e2e round.

Read first, in order: _bmad-output/plans/df6-1a-live-e2e-handoff.md (the runbook —
this file), .claude/skills/qds-live-e2e/SKILL.md (hard rules), then
tests/fleet/e2e/tier3-fix-loop-append.live.test.ts's header charter.

State: DF6.1a is fully implemented and verified on branch
feature/df6-1a-fix-loop-append (base dev; everything except this round is done —
7 unlazy leaves VERIFIED, branch gate green). Your job is ONLY the deferred live
round and its closeout, tracked by the unlazy ledger .unlazy/df6-1a/gates/node-2.md
(G1 env prep, G2 spend go, G3 the round, G4 evidence review).

Work the handoff runbook exactly: prep qds-audit-demo (branch protection with one
fast required check, CodeRabbit review comment on a fresh OPEN DF5.2-produced PR
under biospark33 whose branch carries config/rosters/roster.yaml, fix-scope entry
verified, QDS_E2E_FIX_PR exported), print the worst-case estimate (prep box+key
PLUS the round's 1 box + 1 key capped 50,000 µ$ + box-hours) and get my explicit
"go" BEFORE anything bills, then run the round with QDS_E2E_LIVE=1 QDS_E2E_TIER=2.
Every minted key revoked and every box destroyed in finally; keyLeakProblems and
final-ls zero qds-* boxes are part of the verdict, not cleanup niceties.

Closeout per the handoff: node-2 evidence gates, repo-retention issue naming
DF6.1b, story DoD + Dev Agent Record, sprint-status DF6.1a → done, unlazy root
ledger, PR to dev, gitnexus reindex via the canonical script.
```
