# DF6.1b: Fix-Loop CI Verdict, Attempt Budget and Human Escalation

**Story Points:** 3
**Sprint:** v5-S3 (R5 §3; scheduled after DF6.1a and DF5.3)

> **Split provenance.** This story is the second half of **DF6.1 "PR Feedback → Bounded Fix Run → CI
> Green"** (6 pts, last authored 2026-08-25), split on **2026-09-08** by the QDS story-review campaign
> at the **`attemptSha` seam** — the durable contract DF6.1 had already named for itself: *"the fix
> run's `fixContext` record is written **once**, after `pushVerifiedSha` returns — not before, and not
> in two steps."* **DF6.1a** ends when a verified commit is appended and `attemptSha` is on disk; this
> story **begins by reading it**. Nothing crosses the seam except a JSON payload on disk. The split
> was made here because the two halves are different kinds of work with different dependency sets and
> different risk profiles: DF6.1a's risk is credential and scope containment; this half's risk is
> **termination and correctness of the verdict**. It also splits the live spend cleanly — DF6.1a's
> e2e needs a box and a key; **this half needs no box and no model spend at all**, so the termination
> matrix can be exercised exhaustively, which is exactly what a loop story needs. The 6→4+3 re-point
> is deliberate: DF6.1 was under-pointed because it silently assumed a completion chain DF3.7 has to
> build first.

## Spec Reference

- `docs/superpowers/specs/2026-08-11-dark-factory-v5-architecture-design.md` §8 step **"5+"**
  (unslotted — DD-2 names it epic DF6), §8.0 (the step-0 executable DoD whose green-suite assertion
  this story reuses), §5.2 (observability), **§6.4** (audit chain)
- Decision register: `docs/superpowers/specs/2026-08-11-v5-story-derivation-decisions.md`
  **DD-2** (this story is the "5+" slot; P1.18 repoints here), **DD-1** (operator-CLI-only — which is
  why the CI verdict is polled from the host rather than received, AC1), **DD-8** (audit §3 labels do
  not resolve — NET-NEW items authored fresh)
- Ancestry: **P1.19 RE-DERIVE.** Surviving clauses per `R2-surviving-clauses.md` **§10** —
  `_bmad-output/sprint-artifacts/phase-1/stories/p1-19-pi-pair-fix-green.md:30`/`:31` (CI green → terminal), `:32` (bounded attempts +
  diagnostics), `:39` (guards — the required-check limb), `:54` (retry budget → INV-5). `:53`'s
  webhook-signature clause is **not carried**: with no inbound webhook in v5.0 (AC1) there is no
  signature to validate; its intent — authenticate the verdict's source before any state transition —
  survives as INV-4's polled, SHA-bound form. `:29`'s fix core and `:52`'s branch scoping are
  **DF6.1a's**.
- Sibling contracts consumed: **DF6.1a** (the `attemptSha` seam), **DF5.3**
  (`recordAuditLink`/`walkAuditChain`), **DF6.2** (a `dispatch_task` refusal or a non-success
  classification settles the phase FAIL — this story **reads that verdict** rather than inferring
  failure from "not green"), **DF1.3** (separately bounded parse and gate retries live *inside* the
  run; this story's attempt budget is a third, **outer** bound and introduces no new retry vocabulary)

## User Story

As the factory operator,
I want the fix loop to read its own CI verdict, stop at two attempts, and hand me everything I need
when it stops,
so that the factory maintains its own pull requests without ever looping unattended, misreading
another commit's green as its own, or stopping silently.

## Overview

DF6.1a leaves `extensions.fixLoop.fixContext` — with a real `attemptSha` — on the fix run's own
record. This story reads it. `src/fixloop/ci-status.ts` polls the PR's **required** checks every 30
seconds, binding every poll to that `attemptSha` with `headRefOid` read on both sides of the checks
read, until the required set settles or a 15-minute window expires. Green ends the loop in terminal
success. Anything else is classified before it is charged: only an attempt that **reached CI** and
failed there charges the attempt budget; a DF6.2 deterministic refusal does not, and escalates
immediately. On the second charged failure, or on any terminal state the budget cannot absorb,
`src/fixloop/escalation.ts` posts a human handoff on the PR carrying the error log, the diff
attempted, the CI failure messages and every contributing runId. `fixOutcome` is written once on the
**parent** run's record — the record DF5.3's chain reaches from the PR at hop 1 — and
`src/audit/chain.ts` gains per-contributing-runId hop resolution so `walkAuditChain` on a PR resolves
the parent's chain **and** each fix run's.

**One invocation drives at most one attempt.** The loop is two invocations, bounded by the attempt
budget on the record — not one process staying alive across two human approval decisions.

## E2E Slice

**Demonstrable behavior:** Given a PR whose fix run (DF6.1a) has appended a commit and recorded
`fixContext` with `attemptSha`, When the CI poll runs, Then two host-authenticated `gh` calls per
poll — `gh pr view <n> --json headRefOid` for the head sha and
`gh pr checks <n> --required --json name,state,bucket` for the required-check set — settle the
verdict SHA-bound to `attemptSha`; on all-green the run advances to summarize, reaches
`exitStatus: "success"`, and `extensions.fixLoop.fixOutcome` is written on the **parent** run's record
as `{ prNumber, attempts: 1, outcome: "green", runIds: [<parentRunId>, <fixRunId>] }`. And given
attempt 1 ended a **charged** failure, When the operator re-invokes `bun scripts/fix-run.ts --pr <n>`,
Then that invocation reads `attempt = 1` with a non-green outcome, dispatches attempt 2 carrying
attempt 1's CI failure output and runId, and — given two charged failures — a third invocation
dispatches **nothing**, provisions no box, exits non-zero, and posts the escalation comment carrying
all four diagnostic elements plus the runIds. `walkAuditChain` on that PR resolves the hop set for the
parent run **and** each fix runId.

**Wiring closed:** On completion of this story, a bot comment on a factory PR produces a fix that
turns the PR green — or a human handoff with the diagnostics attached — using only code merged by
this story plus DF6.1a and its predecessors. No stub, no `TODO: wire later`. The push mechanics,
the approval decision, the completion chain and the `attemptSha` write are DF6.1a's and its
predecessors'; this story owns the attempt budget, the CI verdict, the escalation and the fix-run
audit chain.

**Dependency edges (predecessors):** **DF6.1a**, **DF5.3**. (DF6.1a transitively carries DF1.5,
DF1.6, DF3.1, DF3.7, DF3.4, DF5.1, DF5.2.)

> **The real dependency graph, stated because the tracker had it wrong.** As of 2026-09-08 DF6.1 was
> recorded as having its dependencies "all shipped (DF5.2)". It does not. **DF3.7 is an undeclared
> hard edge** on DF6.1a — post-DF1.10 `fleet run` returns without holding the run
> (`src/fleet/run.ts:6`), and nothing host-side **drives the chain** off the completion observation:
> `fleet status` reads the marker but composes nothing, and `src/fleet/run-completion.ts` does not
> exist until DF3.7 delivers it (`observeAndDriveChain` has zero occurrences in `src/` and
> `scripts/` until then). And **DF5.3 is declared but unbuilt**: `src/audit/`
> does not exist, and `recordAuditLink`/`walkAuditChain` appear in `src/` exactly once, in a comment
> at `src/providers/teardown.ts:12`. AC3 and the `src/audit/chain.ts` edit are **unbuildable until
> DF5.3 merges**, so this story is sequenced strictly after it. DF5.3's own Technical Notes already
> anticipate the edit (DF5.3's Technical Notes, "Ten hops *per contributing runId*": "DF6.1 … extends `src/audit/chain.ts`
> **additively**"; its Files-to-Modify lists it at `:168`) — the writer↔reader contract is agreed,
> only the ordering was at issue.
>
> ```
> DF3.7 ──┐
> DF5.2 ──┼──> DF6.1a ──> DF6.1b
> DF5.1 ──┤                 ↑
> DF3.4 ──┤       DF5.3 ────┘
> DF1.5/1.6/3.1 ┘
> ```
>
> **P1.18 is not a predecessor — the *verdict* limb.** Its webhook receiver is out of scope for v5.0
> (AC1 and the Trigger Surface); the verdict is **polled**, and a poll needs no receiver, no public
> endpoint and no signature scheme. P1.18 is KEEP but **UNSCHEDULED** (DF5.5), and its receiver is
> neither built nor depended on here. `p1-19:53`'s webhook-signature clause is not carried; its intent
> survives as INV-4's polled, SHA-bound form.
>
> *(The severance has two limbs because P1.18 had two relevances, and the split separated them: this
> half denies the receiver as a **verdict** channel; **DF6.1a** denies it as an **intake** channel,
> where the alternative is the direct comment read. Both statements are load-bearing and neither is
> redundant — DF5.5's P1.18 disposition note cites both. The `p1-18:50` repoint itself is **DF6.1a's
> edit, not this half's**: `:50` is INV-2, a statement about the 4 000-char snippet *shape* naming its
> consumer, and DF6.1a is the half that reads that shape. This story edits no P1.18 line.)*

## Acceptance Criteria

1. **(the verdict — was DF6.1 AC3)** Given the fix is pushed and `fixContext.attemptSha` is on the
   fix run's record, When the **required** CI checks run (non-required checks are ignored — `:39`),
   Then the host **polls every 30 seconds** until every required check has settled, reading **two**
   host-authenticated `gh` calls per poll because **neither surface alone carries both facts**:

   - `gh pr view <n> --json headRefOid,headRefName` supplies the PR's current head commit sha — and
     `headRefName`, which AC2's parent-run join reads off the same response. `gh pr checks`
     exposes no per-check commit sha and so cannot prove a green belongs to this attempt.
   - `gh pr checks <n> --required --json name,state,bucket` supplies the required-check set with its
     settled `bucket`. **`gh pr view --json statusCheckRollup` carries no requiredness marker and no
     `bucket`** — measured 2026-09-08 against this repository (PR #237): its per-entry fields are
     `__typename, completedAt, conclusion, detailsUrl, name, startedAt, status, workflowName`.
     `bucket` is a `gh pr checks` field, and requiredness is reachable only through
     `gh pr checks --required` or a GraphQL `isRequired(pullRequestId:)` selection.

   The `headRefOid` read is taken **before and after** the checks read and both must equal the
   recorded `attemptSha`; any inequality means a newer commit landed on the branch mid-poll and the
   whole poll result is discarded before any state transition (INV-4). On all-green (`:30`) the run
   advances to summarize and reaches a terminal success state (`:31`).

   The polling ceiling is **15 minutes measured from `pushVerifiedSha`'s return** — the CI-poll
   window, not a wall clock over the whole attempt (see Technical Notes). That return happens
   **inside DF6.1a's invocation 2**, which continues into this poll leg before exiting (DF6.1a AC3):
   the poll is this story's logic, driven from the invocation that owns the window's anchor. Reaching the ceiling without
   a settled required-check set is a `ci-verdict-unavailable` failure that escalates per AC2 and
   INV-6, never a green. Green means the suite is green: per design §8.0, edits landing with the suite
   still red is a FAIL. **The loop never reruns CI.** Design §8.0's "rerun a flaky suite once, then
   FAIL" is the **operator's** rule, exercised outside this loop: `gh run rerun` needs
   `actions: write`, which contradicts this story's no-repo-admin-scope posture, and re-triggering CI
   is an act the loop otherwise disclaims. A flaky required check settles red and escalates as
   `ci-red`, and the operator decides whether to rerun and re-invoke.

   **The empty-required-set refusal is evaluated at *attempt start*, before the push** — against the
   PR's required checks as `gh pr checks <n> --required` reports them, whose "no required checks
   reported on the '<branch>' branch" answer *is* the refusal mechanism. It is **not** evaluated
   against the first post-push poll, where an empty set means GitHub has not registered the check runs
   yet: within the poll window an empty or partial required set is `pending`, resets nothing, and is
   retried; only the window's expiry converts it to `ci-verdict-unavailable`.

   **Branch on the output, never on the exit code.** `gh pr checks` documents *"Additional exit
   codes: 8: Checks pending"* and also exits non-zero when it prints the empty-required-set message.
   Exit 8 is a normal `pending` tick inside the window, not a verdict.

   *Negative controls, all four MUST fail:* an implementation reading `bucket` off
   `statusCheckRollup` finds `undefined` on every entry and can never report green; one treating
   `exitCode !== 0` as a hard failure converts every pending poll into one; one filtering on
   `conclusion === "SUCCESS"` over **all** rollup entries drops the requiredness distinction, so an
   advisory lint going red blocks a fix whose required checks are green; one reading requiredness
   from the repository's branch-protection settings needs a **repo-admin** token scope this loop
   deliberately does not take.

   *Inbound webhooks (`status` / `check_suite` / `pull_request`) are **out of scope for v5.0**: DD-1
   makes the operator the channel, no webhook ingress exists in the v5 slate, and a poll needs no
   receiver, no public endpoint and no signature scheme.*
2. **(failure path — was DF6.1 AC4; the loop's driver is named)** Given attempt 1 ended in a
   **charged** non-green terminal state — a required check red, or `ci-verdict-unavailable` after a
   successful push — When **the operator re-invokes `bun scripts/fix-run.ts --pr <n>`**, Then that invocation resolves the PR's recorded
   attempt state through the parent-run join and the **attempt-time `fixAttemptRunIds` ledger**
   (Technical Notes, "Attempt bookkeeping" — there is no PR-number index, and `fixOutcome` does not
   exist pre-terminal). The join is concrete and runs before any record read beyond the validation
   itself: `parentRunId = headRefName.slice("qds/".length)` off the same `gh pr view` response AC1
   already specifies (`headRefName` rides beside `headRefOid`), **validated by
   `store.get(parentRunId)`** — a PR whose head branch is not `qds/<existing-runId>` refuses here,
   before the parent record is read any further. The invocation then observes `attempt = 1` with a
   non-green outcome, and dispatches attempt 2 with `fixContext.attempt = 2` carrying attempt 1's CI
   failure output and runId.

   **The comment-ID dedup does not apply to a re-attempt on an unchanged comment set.** DF6.1a's
   dedup refuses a *fresh first attempt* on comments already fixed; it never refuses a *retry* of a
   recorded failed attempt — an unchanged comment set is precisely what a retry is for.

   **The attempt budget is charged only by attempts that reached CI.** An attempt whose
   `dispatch_task` phase settled `fail` with `exitStatus: "logic"` — DF6.2's refusal class:
   `QDS_TEAM_RUNNER` refusal, missing provider key, INV-5 roster/task refusal, unreadable or
   under-provisioned roster, dual-gate rejection, manifest-schema or manifest-dir refusal — is a
   **deterministic** failure that a second identical dispatch cannot fix. It does **not** increment
   `attempt`; it escalates immediately with the refusal's own message as the diagnostic, naming the
   refused precondition, and provisions nothing further. An attempt classified `transient` or
   `lead_failure` is likewise not a fix failure: DF1.3 already spent its own separately-bounded parse
   and gate retries inside the run, and this story adds no third retry vocabulary — such an attempt
   escalates with the classification named, and the operator decides whether to re-invoke. Only an
   attempt that produced a diff, passed re-verify, was approved, pushed, and then failed **CI**
   charges the budget.

   **Uncharged attempts are bounded too, by a separate and smaller ceiling.** A terminal state that
   charges nothing still costs one box, one capped key and one model spend (≈50 000 µ$ by DF6.1a's
   own estimate), so "uncharged" must not mean "unlimited" — otherwise the loop terminates on the path
   where the fixer works and CI disagrees, and runs forever on the cheaper-to-reach path where the
   fixer is refused. At most **3** uncharged attempts are recorded per PR across all classifications;
   the fourth invocation dispatches nothing, provisions no box, exits non-zero, and escalates with
   every recorded classification listed. **`out-of-scope-diff` is capped at 1**: it is the *injection*
   outcome, so a second occurrence on the same PR escalates immediately without dispatching — a second
   identical out-of-scope diff on the same comment set is a signal about the comments, not about the
   fixer.

   **`scope-requires-privilege` charges nothing and is never retried.** DF6.1a AC6 distinguishes a
   diff that *wandered* (`out-of-scope-diff` — agent error, retry may help, charges zero, capped at
   1 here) from
   one that matched a **deny** glob (`scope-requires-privilege` — the fix necessarily needs a
   privileged path: a CI-config bug, a roster change, or the verification surface). The second is a
   **correct refusal**: the agent behaved properly and no retry can ever succeed, so it charges zero
   attempts, does **not** count against the uncharged ceiling either, and escalates on first
   occurrence naming the denied paths and the matched deny rule with its `reason`. DF6.1a AC6
   distinguishes a diff that *wandered* (`out-of-scope-diff` — agent error, retry may help, charges
   zero, capped at 1 here) from *Negative control:
   an implementation that charges an attempt for it, or retries it, burns budget on something no retry
   can fix and MUST fail.* `out-of-scope-diff` — the *wandered* diff DF6.1a refuses — sits in the
   same zero-charge family: the budget is charged **only by attempts that reached CI** (the opening
   rule of this AC), so an `out-of-scope-diff` refusal charges **zero** and is bounded by its own
   cap of 1 (above) rather than by either ceiling — the third vocabulary is deliberate and owned
   here (the attempt bookkeeping is this story's), not an inconsistency.

   *Negative control: an implementation that bounds only charged attempts lets an adversarial review
   comment be re-attempted indefinitely, one box per invocation, with every attempt terminating
   "correctly" in a named state — it MUST fail this AC.*

   And given two **charged** attempts have failed, When the retry budget is exhausted (`:32`, `:54`),
   Then a third invocation dispatches **nothing**, provisions no box, exits non-zero, records the
   failure with `(error log, diff attempted, CI failure messages)`, and **escalates to a human** — a
   comment on the PR carrying that diagnostic set plus the runIds — rather than stopping silently.

   *Negative controls, both MUST fail:* an implementation whose comment-ID dedup refuses the retry
   makes the failure path unreachable and exits `0` "no new comments" against a still-red PR; and an
   implementation that treats every non-green run as a fix failure spends a second box on a
   deterministic refusal and posts an escalation whose "CI failure messages" element is empty because
   CI never ran.
3. **(audit chain — was DF6.1 AC6)** Given a fix attempt, When it reaches each of DF5.3's link-worthy
   event sites, Then that attempt emits its **own** `recordAuditLink` rows at those sites under its
   own runId, exactly as the parent run does, and `extensions.fixLoop.fixOutcome.runIds` **on the
   parent run's record** — the record DF5.3 reaches from the PR at hop 1 — records every contributing
   runId in attempt order. When `walkAuditChain` is invoked on that PR, Then it resolves the hop set
   **per contributing runId** — the parent run plus every fix runId — and a contributing runId whose
   chain is missing or incomplete is a **broken hop**, not an ignored one (INV-AUDIT-6).
   *Negative control: a walker that resolves only the parent run's chain reports a complete chain for
   a PR whose fix run left no links, and MUST fail this AC.*

## Trigger Surface

| Trigger | Status | E2E Test | Follow-Up |
| --- | --- | --- | --- |
| `bun scripts/fix-run.ts --pr <n>` — the **sole** trigger (DD-1: the operator is the channel). One invocation drives **at most one attempt**; the operator's next invocation drives the next | in-scope — extends DF6.1a's verb additively | `tests/fixloop/cli.test.ts` | — |
| Required-check verdict by the two-call composition (`gh pr view <n> --json headRefOid,headRefName` + `gh pr checks <n> --required --json name,state,bucket`), SHA-bound to the attempt | in-scope | `tests/fixloop/ci-status.test.ts` | — |
| Human escalation comment on the PR at budget exhaustion or a non-recoverable terminal state | in-scope | `tests/fixloop/escalation.test.ts` | — |
| Inbound webhooks (`status` / `check_suite` / `pull_request`) and any host-side receiver | out-of-scope — no webhook ingress in the v5 slate (AC1); P1.18's receiver is not built or depended on here | — | none in v5.0 |
| Scheduled sweeper that re-polls stale PRs | out-of-scope — no scheduler in v5.0 | — | none derived; the operator re-invokes |
| A resident process, daemon, PID file or `--loop` flag driving attempt 2 | out-of-scope — the loop is two invocations, never one process across two human approvals | — | — |

## Infra Prerequisites

| Component | Service (compose/k8s/provider) | Lifecycle Hook Verified |
| --- | --- | --- |
| Required-check verdict source | GitHub API via **two** host-authenticated `gh` calls: `gh pr view <n> --json headRefOid,headRefName` (the head sha taken before and after; the head branch name feeding AC2's parent-run join) and `gh pr checks <n> --required --json name,state,bucket` (the required-check set and its settled bucket) — **from the host, requiring no branch-protection read and therefore no repo-admin token scope** | polled at attempt start and every 30 s; no inbound webhook, no receiver, no public endpoint (AC1) |
| GitHub required-check configuration | the PR's own required-check set as `gh pr checks <n> --required` reports it — **not** the classic branch-protection endpoint (`GET /repos/{owner}/{repo}/branches/{branch}/protection/required_status_checks`), which requires **admin** on the repository | read at attempt start; a PR whose required set is empty ("no required checks reported on the '<branch>' branch") is refused, never counted green (AC1) |
| Host GitHub token | host operator environment — `readHostToken` (`src/pr/github.ts`), handed to `gh` **as the `gh` child's environment only** (`GH_TOKEN` set on the spawned child, never on this process's environment, never argv) — the same containment `gitEnv` uses for git credentials in `src/pr/push.ts` | the same scope opening a PR already needs; no escalation to repo-admin |
| `gh` CLI | installed on the host, version-floored to one exposing `gh pr checks --required --json` with the `bucket` field and `gh pr view --json headRefOid` (both verified against gh 2.93.0; the floor exists so a host without them fails loudly, not green) | the two-call composition shells out to `gh`; this story introduces it as this repo's first `gh` dependency deliberately — its `--required`/`bucket` fields are the measured surface, and a `GitHubApi` port would need a GraphQL `isRequired(pullRequestId:)` selection, a bigger seam change than one child-env token |
| Audit chain store | DF5.3's `src/audit/chain.ts` | **unbuilt as of 2026-09-08** — this story is sequenced after DF5.3 merges |
| DF2.1 run records | host `<runsDir>` | attempt count and last error resolved through the parent-run join plus the **attempt-time `fixAttemptRunIds` ledger** on the parent record — no second state store, no PR-number index (none exists) |

> No box, no LLM key and no model spend are prerequisites of this story. That is a property of the
> split, and it is what makes the termination matrix cheap to exercise exhaustively.

## Technical Notes

- **One invocation, one attempt.** `scripts/fix-run.ts` is a bounded, exiting invocation in the shape
  DF3.8 fixed for `fleet observe`: it drives a single attempt to a terminal state and exits. It never
  blocks across an approval decision, never holds the per-run invocation lock across a human wait, and
  ships no daemon, no PID file and no `--loop` flag. The loop is **two invocations**, bounded by the
  attempt budget on the record. The alternative reading — one process driving both attempts — would
  have a CLI stay alive across two human decisions of unbounded duration while holding
  `<runsDir>/<runId>.lock`, refusing every other run-scoped verb exit-5 against that run, and would
  contradict DF3.7/DF3.8's verb discipline (*"a verb and not a process: one bounded pass, a typed
  exit, no PID file, … nothing that stays resident"*). It is rejected here explicitly so a dev does
  not re-derive it.
- **The bot commenting on our own fix is the one self-trigger the operator-only channel does not
  close, and it is closed here explicitly.** The appended fix commit is new code on the PR and will
  draw **new** review comments from the same bot. Those comments have **new IDs**, so DF6.1a's
  ID-based dedup cannot stop them, and the next operator invocation would otherwise read them as a
  fresh feedback set. The attempt budget is therefore a **lifetime cap per PR**, not per comment set:
  `fixOutcome.attempts` accumulates across every feedback set on that PR, a fresh comment set **never
  resets it**, and a PR that has exhausted the budget escalates on every subsequent invocation
  regardless of how new the comments are. A feedback set whose `commentIds` are all newer than the
  recorded `attemptSha` is escalated as `classification: "bot-response-to-fix"`, so the operator can
  see the loop is arguing with the reviewer rather than fixing the PR. Without this, the loop and the
  review bot alternate indefinitely with the operator as an unwitting clock — the trigger argument
  covers the loop's own commit and its own CI run, but not a third party's reaction to them.
- **Guards/limits (`_bmad-output/sprint-artifacts/phase-1/stories/p1-19-pi-pair-fix-green.md:39`, the limbs this half carries):** max **2** charged
  fix attempts per PR; the CI check must be a **required** check — non-required checks are ignored; a
  PR whose required-check set is empty is refused at attempt start rather than counted green, because
  nothing ran. (The same-branch limb is DF6.1a's INV-2.)
- **The 15-minute budget is the CI-poll window, not the attempt's wall clock.** An attempt spans four
  differently-bounded stretches and one unbounded one, so a single 15-minute timer over all of them
  would abort every fix run at the approval gate:
  - **Execution** (dispatch → completion → harvest) inherits **DF3.1's** run budget and per-phase
    caps; neither half adds a second timer over it.
  - **Re-verify** inherits **DF5.1's** 30-minute wall-clock cap and its `error` verdict on overrun.
  - **Approval wait** is **excluded from every budget** — a human decides on human time, and DF3.4
    tears the box down at pause. It has its own separate expiry (DF3.4's), and an approval that
    expires undecided ends the attempt as `approval-timed-out`, escalating per AC2 rather than
    counting as a failed fix.
  - **CI poll** is the 15 minutes: the window opens when `pushVerifiedSha` returns — i.e. at DF6.1a's
    last write, inside invocation 2, which continues into this poll leg — and closes when every
    required check has settled or the window expires
    (`ci-verdict-unavailable`, AC1).

  Max-2-attempts (INV-5) is what bounds the loop overall; the 15 minutes bounds only the wait for a
  verdict on a sha that is already pushed.
- **This story reads `attemptSha`; it never derives one.** DF6.1a guarantees exactly one shape on
  disk: a `fixContext` carrying the sha `pushVerifiedSha` published, or no `fixContext` at all. There
  is no pending or partial record. A fix run with no `fixContext` never had a published sha, so it
  never enters the poll — it goes straight to AC2's classification. Intermediate commit SHAs from the
  same push are **not** attempt SHAs, and a poll result carrying one is discarded exactly like a stale
  sha (INV-4).
- **Contracts/Schema — `fixOutcome` and the attempt-time ledger.** The `fixLoop` sub-key on DF2.1's versioned `extensions`
  namespace is **already registered** (`src/providers/run-record.ts`:
  `fixLoop: { schemaVersion: 1, fields: { fixContext: "string", fixOutcome: "string" } }`); this
  story makes **one adds-only registration** — `fixAttemptRunIds: "strings"`, the attempt-time
  ledger the AC2 lookup reads (the first-class array DF5.3's Technical Notes anticipated; the
  `strings` kind already exists, no existing kind changes, and `assertNoSecret` applies to its
  members, which are hex run ids). `FieldKind` is
  `"string" | "int" | "ports" | "strings"` (`src/providers/run-record.ts:54`) — **there is no object kind** — so
  `fixOutcome: { prNumber, attempts, outcome: "green" | "escalated", runIds: string[] }` is stored
  **JSON-encoded as a `"string"` value** (`schemaVersion: 1`), validated by `src/fixloop/`'s own
  parser on read and write. It is written **once, on the parent run's record**: the run that produced
  the PR (DF5.2's `extensions.pr` carries that PR), which is exactly the record DF5.3's chain reaches
  from the PR at **hop 1**. `runIds` is the aggregate the parent holds — the parent's own runId
  followed by every fix runId in attempt order — so one lookup from a PR yields the whole attempt set.
  DF2.1's twelve-field core stays closed and unchanged, so DF5.3's audit chain and DF5.2's
  `extensions.pr` correlation key are unaffected.
- **No third-party prose enters the run record from this half either (DF6.1a INV-7).** `fixOutcome`
  is identifiers and counts, so `assertNoSecret`'s prefix scan (`src/providers/run-record.ts`) has nothing
  to false-positive on. What the record keeps is the escalation's classification and the runIds; the
  failure text stays reachable in the run's own trace rows and on the PR, and **none of it is
  persisted into the record as prose**.
- **The escalation comment is this pair's only egress to the public internet, and it is redacted with
  the PATTERN redactor — named by path.** The comment quotes CI failure output onto a **public** PR,
  and CI output routinely echoes tokens: the canonical shape is a clone URL,
  `https://x-access-token:ghs_…@github.com/org/repo`. It is passed through `redactSecrets(text)`
  (`src/providers/step-log.ts:225`), which runs `redactKeyManagementUrls`, `PEM_BLOCK_RE`,
  `SECRET_PREFIX_RE` — driven by the same frozen `SECRET_PREFIXES` list `assertNoSecret` enforces, and
  `ghs_` is in it (`src/providers/run-record.ts:580`, whose comment names exactly this clone-URL shape) — and
  `LONG_TOKEN_RE`.

  **Not `cli-anything/src/redact.ts:62`.** That `redactSecrets(text, parentEnv)` redacts only literal
  values already present in the supplied map; it has no pattern knowledge at all. On this surface it
  is worse than useless, because the credential most at risk here is the host's **own** GitHub token
  — and `readHostToken` (`src/pr/github.ts:170-176`) deliberately keeps it out of `process.env`
  ("an env-resident token is inherited by every child this process spawns, which is the containment
  INV-PR-1 exists to keep"). The invariant protecting the token is exactly what blinds a
  known-value redactor to it. Two correct decisions composing into a hole; see DF6.1a's Technical
  Notes for the full two-function disambiguation.
- **INV-7 applies to this half's one outward-facing act too.** Posting the escalation comment is
  irreversible. `fixOutcome`'s encoded payload is built and validated **before** the comment is
  posted, so a record write cannot refuse after a human has already been paged.
- **Attempt bookkeeping — how the attempt state for a PR is *found*.** There is no PR-number index,
  and the record store exposes no query-by-extension and no secondary index — its public surface is
  `path`/`lockPath`/`create`/`get`/`set`/`close`/`list`/`listWithAnomalies`, records keyed by runId.
  `extensions.pr.prNumber` is a field on a record you already hold, not a lookup key; the earlier
  draft's "resolve the parent run by `extensions.pr.prNumber` (DF5.3's hop-1 join)" named a lookup in
  a direction with no index — DF5.3's hop 1 runs PR → runId **from the PR body/branch over the
  network**, not runId ← prNumber on the store. The zero-cost resolution already exists and DF6.1a
  validates it: DF5.2's `defaultTargetRef(runId)` makes the PR's head branch **`qds/<parentRunId>`**,
  and DF6.1a's Trigger Surface already refuses a PR whose head branch is not `qds/<run-id>` with a
  matching run record. So **`parentRunId = headRefName.slice("qds/".length)`, validated by
  `store.get(parentRunId)`** — one `gh pr view --json headRefOid,headRefName` (the call
  AC1 specifies — both facts, one request) plus one record read; no sweep, no fleet-wide read cost, and the lock key exists before
  any record is scanned. **The attempt-time ledger is `extensions.fixLoop.fixAttemptRunIds` — a
  `strings`-kind field this story registers (adds-only) on the already-registered `fixLoop`
  namespace, appended with each attempt's fixRunId at that attempt's dispatch** — and therefore
  present **before any terminal outcome**, which is exactly what `fixOutcome` is not: `fixOutcome`
  stays write-once-at-terminal. The attempt-2 driver reads `fixAttemptRunIds` (dispatch-time),
  takes its last entry as the latest fix runId, and reads **that fix run's own record** for
  `fixContext`, its approval state and its non-green outcome — a charged attempt-1 failure leaves
  the parent record carrying a populated ledger and no `fixOutcome`, which is precisely the state
  this lookup must survive. `fixOutcome.runIds` remains the terminal aggregate the audit chain reads
  (AC3); the ledger is what AC2's driver reads. No second state store; no sweep — the ledger rides
  the parent record the join already resolves.

  **The append is pinned to the dispatch path's first record write, not to its last.** The
  `fixAttemptRunIds` append happens under the parent lock **immediately after the fix runId is minted
  and before the box is provisioned** — so an invocation that exits early after provisioning (a
  crash, a kill, a torn-down terminal) still leaves the attempt recorded, and the next `--pr`
  invocation sees it. An entry with no terminal outcome on its own record is an **orphaned attempt**:
  it counts toward AC2's uncharged ceiling — a dead attempt never reached CI, so it never increments
  `attempt` — is named on the invocation's log line, and is what stops a crash-retry loop from
  spending unboundedly: three orphaned attempts stop the loop exactly as three observed uncharged
  attempts do. The terminal transition — the fix run's own outcome classification and, when terminal,
  the parent's `fixOutcome` — is written under the **same parent lock** the dispatch was taken under.
  Pending retention lives in the ledger alone; **`fixOutcome` is not extended to carry pending
  attempts** — it stays write-once-at-terminal, which is the shape DF5.3's audit chain (hop 1, AC3)
  reads.
- **Concurrency: the lock is keyed on the PARENT run, not the fix run.** Two concurrent `--pr <n>`
  invocations are excluded by `acquireRunLock(runsDir, parentRunId, "fix-run --pr")`, where
  `parentRunId` is resolved by the head-branch join above — **before any lock is taken**, since the
  lock key is the parent runId — the one identity every attempt for this PR
  shares.

  **Why not the fix run's own lock.** `acquireRunLock(runsDir, runId, who)` locks
  `<runsDir>/<runId>.lock`, keyed on a **runId**. Two concurrent invocations that have not yet
  dispatched have **no runId in common** — each is about to mint its own — so they would take two
  different lock files and both proceed: two boxes, two capped keys, two model spends, two approval
  requests, and two pushes racing onto the PR branch. `scripts/fleet.ts`'s dispatch key-mint acquisition is the
  key-mint lock on the **just-minted** runId, which is precisely why it cannot serialize two pre-mint
  invocations, and DF6.1a's lock is the **fix run's**, taken for DF3.7's `observeAndDriveChain`
  precondition.

  **So the loop takes two locks with two different scopes** — a **PR-scoped** one (parent runId) for
  the attempt counter, and a **run-scoped** one (fix runId) for the chain — and holds neither across a
  human decision. `acquireRunLock` is not re-entrant (`RunLockReentrantError`, thrown by the guard at
  the head of `acquireRunLock` in `scripts/lib/run-lock.ts`), which is another reason the two must be different keys rather than
  one lock taken twice.

  The loser exits **5** with DF3.1's existing mapping — "the run lock refused, so the verb never ran"
  (`src/fleet/verbs.ts`'s exit table) — a **counted refusal, not a failure**, and the operator re-invokes.
  A **stale** lock is a distinct, remediated outcome carrying the `rm` line, never folded into the
  benign refusal count.

  **Two corrections of record.** (a) DF6.1 originally specified this as "a single atomic
  compare-and-set (the record's existing write path — no new lock primitive)", asserting a CAS
  semantic `RunRecordStore.set` does not document — it merges and re-persists. (b) A prior fix wave
  then wrote that the lock is "taken by `fleet dispatch` … **and by every run-scoped verb**". That is
  false: `scripts/fleet.ts` has exactly two `acquireRunLock` call sites — the dispatch key-mint
  acquisition (on the just-minted runId) and the one inside `runDestructive`. The **gate** verbs — `approve`, `reject`, `enrol`,
  `unlock`, `attach`, routed through `runGateVerbs` (the `GATE_VERBS` set in `scripts/fleet.ts`) —
  take **no** run lock. That is why an approval decision is never blocked by a held lock, and why an
  approval must never be relied on to be serialized by one.
- **Authored fresh (DD-8 — NET-NEW, not ancestry):** human escalation with context — the source
  (`p1-19:32`) stops at "records a failure". This gets full review like any new material.
- **Deviation/assumption:** because the trigger is an operator command rather than a receiver, an
  unattended PR whose fix went red simply sits until someone re-invokes; that is the DD-1 cost of
  having no ingress in v5.0, and it is also what makes the loop structurally unable to self-trigger —
  it cannot fire on its own commit, its own CI run, or a bot's response to its own fix.

## Observability Contract

- CI verdicts record the required-check names evaluated, the poll count, and the `headRefOid` each
  poll carried on **both** reads (before and after the checks read).
- Terminal outcomes log `outcome: "green" | "escalated"` with `attempts` and every `runId`, so the
  audit chain (DF5.3) can reconstruct the loop from the PR alone. An escalation additionally logs its
  classification: `ci-red`, `ci-verdict-unavailable`, `approval-timed-out`, `dispatch-refused`
  (DF6.2 `logic`), `transient`, `lead_failure`, or `out-of-scope-diff` — and whether it charged the
  budget.
- Sub-timings follow the sibling convention: `poll_ms`, `ci_settle_ms`, `escalation_ms`, each
  **absent, not `0`**, on a leg that did not run.
- Cost is reported from the run record's `spendMicroUsd`, never from token rows — the normative
  choice, unchanged. The factual note beneath an earlier draft is updated to the post-DF2.12 state:
  `CostLedger.ingestCostEvent` is **wired since DF2.12** (2026-09-10 — `src/providers/cost-ledger-bridge.ts`
  calls it for every harvested `cost_attribution` line, `teardown.ts`'s
  `ingestHarvestedTokensIfWired` wires it at both teardown ingest points, and `scripts/fleet.ts`
  forwards it through the loser-ledger handle), so `kind='tokens'` rows **do** reach `cost_events`
  and `hasTokenRows` is `true` on a healthy run. This story still specs no budget arithmetic
  and **no per-role cost attribution**, and consumes DF5.3's hop 3 exactly as
  DF5.3 now states it — `perRole` verbatim as the ledger holds it, real role buckets beside
  `"box-hours"`. (Issue #157's deferred money-loop residuals remain open and are no predecessor
  here.)

## Files to Modify

- `src/fixloop/{ci-status,escalation}.ts` — new modules in the flat `src/` domain DF6.1a creates
- `src/audit/chain.ts` — **adds only**: DF5.3's walker gains the per-contributing-runId resolution
  AC3 requires. No hop definition, join key or existing signature changes. *(DF5.3 must merge first —
  `src/audit/` does not exist as of 2026-09-08.)*
- `scripts/fix-run.ts` — **adds only**: the recorded-attempt read (the parent-run join), the budget
  check (charged **and** uncharged ceilings), the retry exception to DF6.1a's comment-ID dedup, **the
  attempt-start empty-required-set probe (AC1 — `gh pr checks <n> --required` before any dispatch,
  refusing with nothing provisioned)**, the `fixContext.attempt` value handed to DF6.1a's write path,
  **the post-push CI poll call — invoked in the same invocation, immediately after DF6.1a's
  `fixContext` write, because the 15-minute window is measured from `pushVerifiedSha`'s return and a
  third invocation would find it expired before its first poll (Wave 6 W6-D-B1: this call site was
  owned by neither half)** — and the escalation call. Beyond that call site, DF6.1a's two-invocation
  drive path is unchanged.
- `src/providers/run-record.ts` — **one adds-only registration**: `fixAttemptRunIds: "strings"`
  joins the already-registered `fixLoop` fields (the attempt-time ledger — see Technical Notes,
  "Attempt bookkeeping"). No existing field or kind changes, and beyond that registration the
  already-registered entry is *read* only.
- `tests/fixloop/{ci-status,escalation,cli}.test.ts`

## Security Invariants

- INV-4: **Verdict authenticity + freshness precede state** (`p1-19:53`'s intent, re-aimed at
  polling) — the CI verdict is read from the host's own authenticated `gh` calls, not accepted from
  an inbound request, so there is no unauthenticated path into a state transition at all. A poll
  result counts as this fix's verdict only when the `headRefOid` read **before and after** the checks
  read both equal the `attemptSha` recorded for this push; any other sha is discarded before any
  transition, so an earlier or later commit's green cannot close the loop.
- INV-5: **Bounded loop** (`p1-19:54`) — the retry budget (max 2 **charged** attempts) is enforced at
  dispatch time from the DF2.1 record, so an irrecoverable failure cannot spend indefinitely. A
  deterministic refusal charges nothing and escalates immediately rather than buying a second
  identical box.
- INV-6: **Fail closed.** If required-check status, the re-verify result, or the revocation
  confirmation cannot be obtained, the run escalates to a human — it never pushes, never marks the
  PR green, and never silently retries past the budget.

## Definition of Done

- [ ] **Impl:** `ci-status.ts` polls the **two-call** composition every 30 s up to the 15-minute poll
      window opened by `pushVerifiedSha`'s return: `gh pr view <n> --json headRefOid` for the head sha
      (read before **and** after) and `gh pr checks <n> --required --json name,state,bucket` for the
      required-check set; it counts a result only when both `headRefOid` reads equal the recorded
      `attemptSha` — mismatched/stale SHAs are discarded before any state transition (AC1, INV-4).
      *An implementation reading `bucket` or requiredness off `gh pr view --json statusCheckRollup`
      MUST fail: neither field exists there.*
- [ ] **Impl:** attempt budget (max 2 **charged** attempts) enforced from the parent record's
      attempt-time `fixAttemptRunIds` ledger, resolved via the parent-run join, before any dispatch; one invocation drives at most one attempt, holds no lock
      across a human approval, and ships no daemon, PID file or `--loop` flag.
- [ ] **Test (concurrent invocations, PR-scoped):** two concurrent `--pr <n>` invocations **that have
      not yet dispatched** — the read-check-increment runs under
      `acquireRunLock(runsDir, parentRunId, …)`; exactly one dispatches and the loser **exits 5**,
      counted as a refusal and not a failure, provisioning nothing; a **stale** lock reports the
      distinct remediated outcome carrying the `rm` line. *An implementation keyed on the **fix**
      run's id takes two different lock files and lets both invocations dispatch — two boxes, two
      keys, two pushes racing — and MUST fail. A test whose two invocations share a pre-existing
      fixture runId does not exercise the mint race and does not satisfy this item. An implementation
      asserting a CAS semantic of `RunRecordStore.set` MUST also fail.*
- [ ] **Test (uncharged-attempt ceiling):** three recorded uncharged attempts (any mix of
      `transient`, `lead_failure`, `approval-timed-out`, `dispatch-refused`) → the fourth invocation
      dispatches nothing, provisions no box, exits non-zero and escalates listing every recorded
      classification; **one** recorded `out-of-scope-diff` → the next invocation escalates without
      dispatching. *An implementation that bounds only charged attempts spends a box per invocation
      forever on the injection path and MUST fail.*
- [ ] **Test (no bot ping-pong):** a PR with two charged attempts recorded and a **new** bot comment
      set posted after `attemptSha` → the invocation dispatches nothing and escalates with
      `classification: "bot-response-to-fix"`. *An implementation that resets the budget on a fresh
      comment set MUST fail.*
- [ ] **Security (escalation egress):** an escalation fixture whose CI output contains
      `https://x-access-token:ghs_…@github.com/org/repo`, an `sk-…` literal, and a PEM block posts a
      comment containing **none** of the three. *An implementation calling
      `cli-anything/src/redact.ts`'s `redactSecrets(text, env)` posts all three unchanged and MUST
      fail this test — the host GitHub token is deliberately absent from `process.env`, so a
      known-value redactor cannot see the one credential most at risk here.*
- [ ] **Test (empty-required-set probe placement):** the probe runs at **attempt start, before any
      dispatch**; a PR with no required checks provisions nothing. *An implementation that first
      learns this after a box exists MUST fail.*
- [ ] **Impl:** `escalation.ts` posts the human handoff carrying error log, diff attempted, CI
      failure messages, and the runIds, passed through `redactSecrets` before posting. **No part of
      that prose is persisted into the run record** (DF6.1a INV-7); `fixOutcome` keeps the
      classification and the runIds only.
- [ ] **Security (INV-7):** `fixOutcome`'s encoded payload is validated **before** the escalation
      comment is posted. *An implementation that validates only at `store.set` can page a human and
      then throw, and MUST fail.*
- [ ] **Contract:** `fixOutcome` validated as the **already-registered** `fixLoop` sub-key on the
      **parent run's** record, JSON-encoded into the `"string"` field (`schemaVersion: 1`).
      *An implementation that assigns an object MUST fail with
      `schema-rejected: … must be a string`.*
- [ ] **Security:** the CI verdict comes from the host's own authenticated poll with `readHostToken`
      and is SHA-bound on both reads before any transition (INV-4); no branch-protection read and no
      repo-admin token scope is taken anywhere in this story.
- [ ] **Test (empty required set):** a PR whose branch carries no required checks — `gh pr checks
      --required` answering "no required checks reported" — is refused **at attempt start**,
      provisions nothing, and is never counted green.
- [ ] **Test (poll-window registration lag):** an empty or partial required set observed **within**
      the poll window is `pending` and is retried, resets nothing, and is **not** the empty-set
      refusal; only the window's expiry converts it to `ci-verdict-unavailable`. *An implementation
      that fires the empty-set refusal on the first post-push poll MUST fail.*
- [ ] **Test (SHA binding):** a poll whose `headRefOid` equals the recorded `attemptSha` on both
      reads advances the run; a poll reporting an earlier commit — including an intermediate commit
      from the same push — is discarded before any transition and changes no state; a poll whose
      `headRefOid` changes **between** the two reads is discarded whole (AC1, INV-4).
- [ ] **Test (required vs non-required):** a PR with a mixed check set — an advisory lint red and
      every required check green — reaches terminal success; a `SKIPPED` optional job does not make
      the attempt non-green. *An implementation filtering on `conclusion === "SUCCESS"` over all
      rollup entries MUST fail this test.*
- [ ] **Test (poll ceiling):** required checks that never settle within the 15-minute poll window
      produce `ci-verdict-unavailable` → escalation, never a green; and an approval that sits
      undecided past that same 15 minutes does **not** abort the attempt — it ends only on DF3.4's
      own expiry, as `approval-timed-out` (AC1, AC2, INV-6).
- [ ] **Test (budget exhaustion and the retry exception):** two recorded **charged** failed attempts
      → a third invocation dispatches nothing, provisions no box, exits non-zero, and posts the
      escalation with all four diagnostic elements plus the runIds; a first invocation on a PR with no
      recorded attempt dispatches attempt 1; **a second invocation against an unchanged comment set
      with a recorded failed attempt 1 dispatches attempt 2** — an implementation whose comment-ID
      dedup refuses the retry MUST fail this test (AC2).
- [ ] **Test (charging classification, DF6.2/DF1.3):** an attempt whose `dispatch_task` settled
      `fail` with `exitStatus: "logic"` does **not** increment `attempt`, provisions nothing further,
      and escalates immediately naming the refused precondition; an attempt classified `transient` or
      `lead_failure` likewise charges nothing and escalates with the classification named; only an
      attempt that pushed and then failed CI charges the budget. *An implementation that treats every
      non-green run as a fix failure spends a second box on a deterministic refusal and posts an
      escalation whose "CI failure messages" element is empty — it MUST fail this test (AC2).*
- [ ] **Test (fix-run audit chain):** each attempt emits its own `recordAuditLink` rows at DF5.3's
      event sites under its own runId, the parent record's `extensions.fixLoop.fixOutcome.runIds`
      lists every contributing runId in attempt order, and `walkAuditChain` on the PR resolves the
      hops for the parent run **and** each fix runId; deleting one fix run's links yields a named
      broken hop, and a walker resolving only the parent chain MUST fail (AC3, INV-AUDIT-6).
- [ ] **Test (termination matrix — no box, no model spend):** green · red-then-green ·
      red-then-red-then-escalate · never-settles · stale-sha · intermediate-sha · empty-required-set ·
      deterministic-refusal, all exercised against fixture records and a fake `gh` driver. Every leg
      reaches a **named** terminal state; no leg loops.
- [ ] **Test (e2e demo — MANDATORY):** against a real PR carrying a real required check and a commit
      appended by DF6.1a's demo (or pushed by hand to the same branch), the two-call SHA-bound poll
      observes the required check turn green and the run reaches terminal success with `attempts: 1`,
      `outcome: "green"`, and `fixOutcome.runIds` on the parent record — evidenced by the PR on GitHub
      and the run's trace rows. **No box and no LLM key are provisioned by this demo.**
      Gating is `liveGate("2")` under `test.todoIf(!process.env.QDS_E2E_LIVE)` — the gate takes only
      `"1" | "2"` (`tests/fleet/e2e/live-harness.ts:65`), and the filename prefix is not the gate.
      The disposable repository and its required-check configuration are **DF6.1a's** demo
      environment, reused here rather than provisioned twice; this demo mints no key and creates no
      box, so no spend estimate or `finally` teardown protocol applies to it.

## Dev Agent Record

<!-- Empty placeholder — filled during development. -->

### 2026-09-08 — Split from DF6.1

This story carries DF6.1's ACs 3, 4 and 6, its INV-4/5/6, and the loop-control half of its Technical
Notes, Observability Contract, Trigger Surface, Infra Prerequisites and Definition of Done. DF6.1's
2026-08-25 inherited-seam briefing lives with **DF6.1a**, which owns the dispatch, spend and in-box
execution surfaces it discusses; item 4's open `issueId` question (DF6.1-H2) spans both halves,
because this half dispatches attempt 2 against the same per-issue ceiling attempt 1 drew from.

Findings resolved here by the 2026-09-08 review campaign: **DF6.1-B3** (the CI-verdict query — the
two-call composition, measured, with the credential-scope consequence stated), **DF6.1-B5** (the
loop's driver — Reading B, one invocation one attempt, with the dedup retry exception), **DF6.1-H6**
(refusals classified before they are charged), **DF6.1-M4** (the empty-set refusal is evaluated at
attempt start, not on the first post-push poll), **DF6.1-M5** (the three disagreeing empty-required-set
sources reconciled onto one mechanism), and the `fixOutcome` half of **DF6.1-B4** (JSON-encoded into
the already-registered `"string"` field — which was already the right shape; DF6.1's demand for an
object `FieldKind` was the spec being wrong about the code, and no DF2.1 core edit is owed).

Per the operator's 2026-09-08 B4 ruling, **DF6.1a INV-7 binds this half too**: no third-party prose is
persisted into the run record, and `fixOutcome` is validated before the escalation comment is posted —
posting a comment is this half's one irreversible act. `assertNoSecret` is untouched.

### 2026-09-08 — Wave 2 findings closed in this half

**DF6.1-M1** — the attempt-budget check-and-increment now takes the per-run invocation lock the fleet
already ships (`acquireRunLock`) with DF3.1's exit-5 mapping, instead of asserting a CAS semantic
`RunRecordStore.set` does not document. It is the **same** lock DF6.1a holds for DF3.7's
`observeAndDriveChain` precondition, so the loop takes one lock, not two, and introduces no new
primitive and no second lock file.

**Cost-attribution honesty (DF5.3 alignment).** This half consumes DF5.3's hop 3 exactly as DF5.3 now
states it — `perRole={"box-hours":N}`, `hasTokenRows:false` — and asserts no per-role token
attribution anywhere. **DF2.12** is the story that makes the per-role split obtainable (closes #157);
it is deliberately **not** a dependency edge of either half, because neither half needs it.

### 2026-09-08 — Wave 5b (independent cold verification) closed in this half

**V-CC-B4 (credential egress).** The escalation comment is this pair's only egress to the public
internet, and my wave-1 fix pointed it at a **known-value** redactor
(`cli-anything/src/redact.ts:62`) that cannot see a credential the host has never held. The most
likely credential in CI output is the host's own GitHub token, which `readHostToken` deliberately
keeps out of `process.env` — so the invariant protecting the token is exactly what blinded the cited
redactor to it. Corrected to the pattern redactor `src/providers/step-log.ts:225`, with a DoD leg
whose fixture carries all three shapes (`ghs_` clone URL, `sk-` literal, PEM block).

**V-DF6.1b-B3 (the lock was keyed wrong and the concurrency claim was false).** Two pre-dispatch
invocations share **no** runId, so the fix run's own lock could never serialize them — both would
dispatch, two boxes, two keys, two pushes. Now keyed on the **parent** run (`extensions.pr.prNumber`,
DF5.3's hop-1 join). The loop takes **two** locks with two scopes, not one; my "one lock, not two"
claim is withdrawn. Also corrected: the lock is **not** taken "by every run-scoped verb" — there are
exactly two `acquireRunLock` sites in `scripts/fleet.ts` (`:1976` key-mint, `:4257` in
`runDestructive`), and the gate verbs (`GATE_VERBS`, `:3005-3007`) take none. That is *why* an
approval is never blocked by a held lock — and why it must never be relied on to be serialized by one.
This also resolves **V-DF6.1b-M1**: the parent-run join is the lookup, so no `list()` sweep is needed.

**V-DF6.1b-H4** (AC2 listed `approval-timed-out` and `out-of-scope-diff` in *both* the charging and
non-charging sets; resolved in favour of the negative-controlled paragraph, plus an **uncharged**
ceiling of 3 and an `out-of-scope-diff` cap of 1 — the injection path was the unbounded one) ·
**V-CC-H5** (bot-response-to-fix ping-pong: the budget is a lifetime cap per PR, a fresh comment set
never resets it) · **V-DF6.1b-H3** (the attempt-start empty-required-set probe was orphaned — now in
this half's `scripts/fix-run.ts` Files-to-Modify line, with DF6.1a's forward reference corrected) ·
**V-DF6.1b-L4** (`gh pr checks` exit 8 = pending; branch on output, never on exit code).

### 2026-09-08 — Wave 5c

**Operator ruling on `fix-scope.json` — `scope-requires-privilege` added.** DF6.1a now distinguishes
agent error from correct refusal. A deny-glob match charges **zero** attempts, is excluded from the
uncharged ceiling, and escalates on first occurrence naming the matched rule and its `reason`. The
indistinguishability was the defect, not the narrowness of the deny-list.

**V-DF6.1b-M2 resolved (not deferred).** *"A flaky suite is rerun once, then FAIL"* now names its
actor: **the operator, outside this loop**. `gh run rerun` needs `actions: write`, which contradicts
this half's no-repo-admin-scope posture, and re-triggering CI is an act the loop otherwise disclaims.
A flaky required check settles `ci-red` and escalates.

**Not carried here — the P1.18 severance is two-limbed by design, and the `:50` repoint is DF6.1a's.**
DF5.5's disposition note cites both halves; collapsing the severance into one would break the other
half's citation. But the *edit* DF5.5 handed to this wave belongs to DF6.1a alone: `p1-18:50` is
INV-2, about the 4 000-char snippet **shape** and naming its downstream consumer, and DF6.1a is the
half that consumes that shape. This story edits no P1.18 line and adds no P1.18 edge. P1.19's
RE-DERIVE does split across both halves — this half carries `:30`/`:31`/`:32`/`:54` and dispositions
`:53` — but being a successor of P1.19 is not what `:50` names.
