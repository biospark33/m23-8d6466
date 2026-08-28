# DF6.2: dispatch_task Verdict Integrity — Refusals and Non-Success Classifications Settle the Phase FAIL

**Story Points:** 2
**Sprint:** v5-S3 (unslotted fix; surfaced by PR #135 review round 5, `fix-tests-b` report "found-but-not-fixed" #1)

## Spec Reference

- DF1.1 lifecycle contract: `src/phase-engine/phase.ts` header ("Success is earned") — the fix closes
  a hole in that guarantee: a *clean return carrying a non-success verdict* was promoted to success.
- DF1.6 dispatch design: `src/phase-engine/phases/dispatch-task.ts` — refusals and classified
  failures RETURN schema-validated `MergedOutput` values by deliberate design ("the adapter's
  ZodError never escapes the body"); the body contract is unchanged by this story.
- Reviewer evidence: `_bmad-output/workflow-state/code-review/pr135/reports/fix-tests-b.md`
  (bottom, "Source bugs found but NOT fixed").

## User Story

As the factory operator reading a run journal,
I want a refused or failed dispatch to settle its phase `fail` with the real reason,
so that a green journal row never covers a dispatch that refused to spawn or classified non-success.

## Root Cause

`dispatchTask`'s refusal/verdict paths return a `DispatchTaskValue` (a `MergedOutput`) whose
`exitStatus` carries the real verdict (`logic` for refusals; `transient`/`lead_failure`/`logic` for
classified runs). `Run.phase` derived the phase verdict purely from throw/abort/overflow and
promoted every clean (non-throwing, non-aborted) return to `success` — it never read the value's own
verdict. Consequences, both now closed:

1. Every refusal (AC5 `QDS_TEAM_RUNNER`, missing provider keys, INV-5 roster/task, empty
   `QDS_RUN_ROOT`, unreadable/under-provisioned roster, dual-gate rejection, manifest-schema
   refusal, manifest-dir failure) journaled the phase `success`; the run settled `ok:true`, exit 0.
2. An EXECUTED dispatch whose precedence classification came back non-success (DF1.6's D2/D3
   machinery computed the right verdict into the value) was likewise promoted to phase `success`.

## Fix

`Run.phase` (`src/phase-engine/phase.ts`) now honors a clean body value's declared verdict: when the
value carries an `exitStatus` that is a valid member of the `EXIT_STATUSES` taxonomy and is not
`"success"`, the phase settles `fail` with that status, the record's error carries the value's
`MergedError.message` (or a legible synthesized message when absent), and the run halts — the same
settle path as a thrown body. `dispatch-task.ts` is intentionally UNCHANGED: all ten refusal sites
were classified individually and every one is a legitimate value-return under DF1.6's design; the
defect was in the engine's settle, not the body's return. Garbage/forged `exitStatus` strings are
membership-validated away (fail-safe: cannot steer the verdict). Phase values that declare no
`exitStatus` (`runCommand`'s `{exitCode, stdoutTail}`, DF1.3's `AgentPhaseResult`) are untouched.
Stream-health counters and dispatch sub-timings now merge onto the record regardless of verdict
(previously success-gated), so a failed dispatch keeps its truthful observability fields.

## Acceptance Evidence

- Regression tests per refusal path (13 legs) plus classified-failure, exit-code, and
  positive-control legs: `tests/phase-engine/dispatch-task.test.ts` describes "refusals settle the
  phase FAIL through Run.phase" and "non-success RUN classifications settle the phase fail".
- Engine-level verdict-contract pins (declared fail/success/garbage/missing-error):
  `tests/phase-engine/phase-lifecycle.test.ts`.
- Gates: `bun test tests/phase-engine/` 625/625, `bunx tsc --noEmit` clean, `bunx biome check` clean.
- gitnexus impact (pre-edit): `dispatchTask` upstream LOW (3 impacted: makeBody → makeBodyFactory →
  main, scripts/pipeline-run.ts); `Run.phase` upstream LOW (5 impacted, walkPhases + both
  pipeline-run mains). Neither HIGH/CRITICAL.

## Behavior-Change Flag

Runs whose dispatch phase refused (or classified non-success) previously settled `ok:true`/exit 0
and now settle `ok:false`/exit 1 with the phase row `fail`. This is the intended correction. The
PR #135 branch carries a characterization pin asserting the OLD behavior (the accepted
`select_roster` leg in `tests/phase-engine/pipeline-run.test.ts`); that pin must flip to the fixed
behavior when #135 rebases onto this fix.
