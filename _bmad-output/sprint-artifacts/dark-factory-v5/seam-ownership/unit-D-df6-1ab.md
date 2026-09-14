# Seam-ownership table — Unit D: DF6.1a (append attempt) + DF6.1b (loop control)

Wave 7 rework artifact. Worklist: `wave6-D-df6-1ab.md`. Seam: the `attemptSha` JSON payload on disk —
DF6.1a writes it (once, post-push), DF6.1b reads it. **The one previously unowned seam — the post-push
CI poll call site — is owned by DF6.1b's logic, invoked from DF6.1a's invocation 2** (W6-D-B1).

## Ownership

| # | Deliverable | Owner (exactly one) |
|---|---|---|
| O1 | `src/fixloop/{feedback-run,index}.ts` — brief build, single-fixer guard, dispatch, the pre-dispatch aggregate-ceiling check | DF6.1a |
| O2 | `src/fixloop/{ci-status,escalation}.ts` — the two-call SHA-bound poll, classification, escalation | DF6.1b |
| O3 | `scripts/fix-run.ts` invocation 1 (observe → `awaiting-approval`, exit 0) | DF6.1a |
| O4 | `scripts/fix-run.ts` invocation 2 up to and including the `fixContext` write | DF6.1a |
| O5 | **The post-push CI poll call site in invocation 2** (DF6.1b's logic, called before invocation 2 exits) | DF6.1b |
| O6 | The `attemptSha` placeholder pre-flight + post-push single-field diff test | DF6.1a |
| O7 | The AC6 diff base definition (`git diff --name-status <pinned commitSha>..<green headSha>`) | DF6.1a |
| O8 | `.factory/fix-scope.json` artifact + per-repoSlug resolution + the two refusal states | DF6.1a |
| O9 | `src/pr/github.ts` — **adds-only**: `listPrReviewComments` + `getPullRequest` on `GitHubApi`/`httpGitHubApi` (PR review comments are `/pulls/{n}/comments`, a different endpoint from issue comments); DF5.2's fakes gain the members in this story | DF6.1a |
| O10 | `src/fixloop/` import fence (symbol-level: `push.ts` only for `pushVerifiedSha`/`PushOutcome`; `run-record.ts` only for `RunRecordStore`/`RunRecord`; `approval-gate.ts`/`approvers.ts` banned) | DF6.1a |
| O11 | The `requestApproval` proposal variation for fix runs (adds-only `src/reverify/runner.ts` edit) | DF6.1a |
| O12 | INV-3 credential probe incl. the `EnvironmentFile` sink and the `sudo -n` mechanism | DF6.1a |
| O13 | The `p1-18` INV-2 `(P1.19)`→`(DF6.1a)` repoint edit | DF6.1a |
| O14 | The parent-run lock key resolution (`headRefName` → `parentRunId`, validated by `store.get`) | DF6.1b |
| O15 | The attempt bookkeeping (charged/uncharged ceilings, `out-of-scope-diff` cap), the **attempt-time `fixAttemptRunIds` ledger on the parent record** (strings-kind registration + dispatch-time append — W8-D-1), and the terminal `fixOutcome` write on the parent record | DF6.1b |
| O22 | The `fixAttemptRunIds` append call site in DF6.1a's invocation (DF6.1b's ledger logic, invoked from DF6.1a's dispatch flow — the O5 pattern) (W8-D-1) | DF6.1b (logic) via DF6.1a's invocation |
| O16 | The `gh` child-env token containment (`GH_TOKEN` on the `gh` child only, `gitEnv` pattern) + the `gh` version floor | DF6.1b |
| O17 | `src/audit/chain.ts` per-contributing-runId resolution (adds-only, post-DF5.3) | DF6.1b |
| O18 | `config/rosters/roster.yaml` — **not modified by either half**; both specs describe the two-role shape it ships | parent-held invariant |
| O19 | yaml DF6.1a/DF6.1b rows | parent (already match; no W6-D finding against them) |

## Reconciliations applied (Wave 6 → spec)

| Finding | Disposition |
|---|---|
| W6-D-B1 (C3, BLOCKER) | **Named the invocation.** Invocation 2 writes `fixContext`, then continues into DF6.1b's poll leg before exiting (O5); the 15-minute window is measured from `pushVerifiedSha`'s return, which happens inside invocation 2 — a third invocation would find it expired before its first poll. Invocation 2 holds the run lock through that bounded window (≤15 min, never a human decision); stated in DF6.1a AC3/E2E and DF6.1b AC1/Files-to-Modify. |
| W6-D-H1 (C2) | **Re-keyed the lookup mechanism.** `parentRunId = headRefName.slice("qds/".length)`, validated by `store.get(parentRunId)` — the head branch **is** `qds/<parentRunId>` (DF5.2's `defaultTargetRef`, already enforced by DF6.1a's Trigger Surface). The `extensions.pr.prNumber` "hop-1 join" retracted: the record store has no reverse index; DF5.3's hop 1 runs the other direction, over the network. Lock key now exists before any record scan. |
| W6-D-H2 (C3) | **Re-homed the refusal.** The declared-aggregate check runs host-side in `src/fixloop/feedback-run.ts` before dispatch (ledger snapshot for the pinned `issueId`), refusing with this story's own code — the shipped `issue-ceiling-insufficient` belongs to the fan-out primitive's n-arms message and cannot fire on a single dispatch. DoD rewritten to match. |
| W6-D-H3 (C3) | **Fence restated in DF6.1a's own terms** (O10): symbol-level permits, not a verbatim module ban that would forbid the story's central call or an ungreppable "block". |
| W6-D-H4 (C3) | **Pre-flight made falsifiable** (O6): 40-lowercase-hex placeholder, post-push value differs in exactly that field, test diffs the two encoded strings, residual stated (40-hex cannot trip the scanner). |
| W6-D-H5 (C3) | **Diff base named** (O7) + two-commit-history DoD leg whose wrong-base mutant refuses `scope-requires-privilege`. |
| W6-D-H6 (C3) | **Trigger given an owner** (O9): adds-only `src/pr/github.ts` edit with the `brief-schema` justification; DF5.2's `tests/pr` suite asserted green unchanged; review-vs-issue comment endpoints distinguished. |
| W6-D-H7 (C2) | **Probe widened** (O12): the `EnvironmentFile` sink added (the one env source a transient unit cannot inherit), `sudo -n` mechanism named with the polkit rationale, fourth DoD plant leg. |
| W6-D-H8 (C3) | **e2e prerequisite (iv) added** — the disposable repo's `fix-scope.json` entry, verified before the round; free `fix-scope-missing` negative control in the same round. |
| W6-D-M1 (C2) | **Premise narrowed in both halves**: `fleet status` reads the marker but composes nothing; `run-completion.ts` does not exist until DF3.7 delivers it. The conclusion (DF3.7 hard edge) survives unchanged. |
| W6-D-M2 (C2) | **`omittedCommentIds` capped at 20** with `omittedCount: number` for the remainder; brief-bound DoD updated. |
| W6-D-M3 (C2) | **Proposal text owned** (O11): adds-only `runner.ts` edit varying the `requestApproval` proposal when a `fixContext` brief key is present — the one human consent must describe the act. |
| W6-D-M4 (C3) | **`gh` auth named** (O16): `GH_TOKEN` set on the `gh` child's environment only, from `readHostToken`'s return, never on this process's env and never argv — the `gitEnv` containment pattern from `src/pr/push.ts`; infra row for the installed `gh` and its field floor. The verdict stays on `gh` (its `--required`/`bucket` are the measured surface; a `GitHubApi` port would need a GraphQL `isRequired` selection — choice recorded). |
| W6-D-M5 (C1) | **Analyst dropped from the described team shape** — the guard tests one write-capable worker, and the only e2e roster ships lead+fixer; adding an analyst would edit a shared TIER-2 fixture outside either Files to Modify. |
| W6-D-L1 (C1) | Run-lock citations by symbol. |
| W6-D-L2 (C1) | `resolveRepoEntry` cited to `src/pr/repos.ts` (the definition), `push.ts` named as the caller. |
| W6-D-L3 (C4) | INV-2's mechanism re-pointed to the shipped `assertPublishableRef` allow-list (`target-ref-outside-namespace`), not a weaker default-branch comparison. |
| W6-D-L4 (C4) | The preflight causal chain corrected: it reads `extensions.budget.repoSlug`; `issueId` rides the same admission path. |
| W6-D-L5 (C4) | `attempt` value at DF6.1a's merge point stated (always `1`; DF6.1b supplies it) and added to the Contract DoD. |
| W6-D-L6 (C1) | Roster schema cites by symbol (`ResolvedRole.writes`), line numbers stripped. |
