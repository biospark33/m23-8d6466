# DF5.2: Host-Side PR Creation from the Quarantine Ref

**Story Points:** 4
**Sprint:** v5-S2 (lights-on head)

## Spec Reference

- `docs/superpowers/specs/2026-08-11-dark-factory-v5-architecture-design.md` §5.3 (data flow —
  "opens PR (host-side token; runId in PR body)"), §6 items 2/4/6/7, §8 **step 5** ("The factory's
  P1.15 moment"), §9 R9/R10
- Decision register: v5 §4 **D8** (no push credential in any box; host-side PR creation), D2
- Contracts: v5 §5.2 observability (requestId propagation, per-phase sub-timings)
- Ancestry: **P1.15 RE-DERIVE** via the R2 §7 crosswalk **only** (real labels + line numbers)
- Derivation decisions: `.../2026-08-11-v5-story-derivation-decisions.md` **DD-10** (D8 reverses
  P1.15's in-box push; that clause is dead and is not cited as ancestry), **DD-8** (clauses R2 marks
  NET-NEW are authored fresh), **DD-9** (integer micro-dollars), **DD-1** (operator-CLI-only)
- Binding facts: R5 §6 facts **15**, **16**, **17**

## User Story

As the factory operator,
I want the pull request opened from my machine, with a credential that has never been inside a
sandbox, only after the host re-verified the work and I approved it,
so that the one irreversible, outward-facing action the factory takes is the one action a box can
neither perform nor forge.

## Overview

`openPullRequest(runId)` is the last step of a run. It refuses unless three host-side records agree:
DF5.1's `ReverifyReport` is `green` at the head sha it is about to publish, DF3.4's `ApprovalRecord`
is `approved` on a decision taken after that verdict, and the target repo is on the host allowlist.
It then pushes that verified sha to `refs/heads/qds/<run-id>` with a host-only token, opens the PR
through the GitHub API with a body carrying the runId, the P1.3 issue references, the DF2.8 cost
summary and the re-verify evidence, and writes `prUrl`/`prNumber` onto the run record's
`extensions.pr` namespace (DF2.1's sanctioned additive key) at the moment of creation. A red or
missing re-verify opens no PR and records the failure on the linked issue.

## E2E Slice

**Demonstrable behavior:** Given `refs/sandbox/<run-id>` at head sha `abc1234`, a `ReverifyReport`
`green` at `abc1234`, and an `ApprovalRecord`
`{ state: "approved", approverId: "steve", decidedAt, reportId, headSha: "abc1234" }` whose
`decidedAt` is later than that report's `completedAt` and whose `reportId` is that report's, When the operator runs `bun scripts/open-pr.ts <run-id>`, it
validates the remote against `.factory/repos.json` → pushes `abc1234:refs/heads/qds/<run-id>` with
no force → opens a PR whose body carries `Run: <run-id>`, `Issue: Closes #42`,
`Cost: $0.014912 (3 events, 0 unpriced)`,
`Re-verify: green — 7/7 checks`, `Approved by: steve` → writes `prUrl`/`prNumber`/`createdAt` to the run record's `extensions.pr` namespace.
Flipping the report to `red` produces no remote branch, no PR, and one comment on issue `#42` naming
the failing checks.

**Wiring closed:** On completion of this story, a real PR is produced host-side from harvested work
using only code merged by this story plus DF5.1's report and DF3.4's approval record. No stub, no
`TODO: wire later`. The audit chain is DF5.3's and PR feedback is DF6.1's; neither is required here.

**Dependency edges (predecessors):** DF5.1, DF3.4. *(P1.3 issue-mirror and P1.7 lsp-gate removed from
hard deps: P1.3's mirror index is non-blocking — an unresolved mapping renders `Issue: unresolved`
and the PR still opens (AC2/Infra Prerequisites); P1.7 is unused here — the publication gate is
DF5.1's host-side re-verify, not an LSP gate. Both remain KEEP and are repointed by DF5.5.)*

## Acceptance Criteria

1. **(make-or-break)** Given a run whose `ReverifyReport` `R` is `green` at head sha `H` and an
   `ApprovalRecord` whose `decidedAt` follows `R.completedAt` and whose bound `reportId`/`headSha`
   match `R`/`H` (both are required DF3.4 fields, written at `requestApproval`), When
   `openPullRequest(runId)` runs, Then the verified sha `H` itself — never the ref name, which could
   move between preflight and push — is pushed non-force to `refs/heads/qds/<run-id>` with a
   **host-side** token, a PR is opened against
   the registered base branch, and `prUrl` + `prNumber` + `createdAt` are written to the run record's
   `extensions.pr` namespace at creation time rather than retroactively. The branch name encodes the runId as `qds/{runId}` and the body
   references it (`p1-15-real-pr-produced.md:34`, surviving core; that clause's actor — Warren
   pushing from the burrow — is dead per DD-10 and is not carried).
2. Given the same run, When the body is rendered, Then it carries, each on its own labelled line: the
   `runId`; the issue references resolved through P1.3's mirror index (story sub-issue and parent) on
   a line labelled `Issue:` that is **always rendered** — an unresolved mapping renders
   `Issue: unresolved` rather than omitting the line, which is what makes DF5.4-C8 assertable on
   shape rather than on P1.3's availability;
   the DF2.8 cost summary as USD derived from integer micro-dollars with the event count and
   `unpriced` row count; the DF5.1 verdict with its check tally and any failing items; the DF3.4
   `approverId` and `decidedAt`; DF5.1's `flags`; and the changed-file list. *NET-NEW per R2 §7 —
   issue refs, cost summary, the reviewer-visible artifact list and the green-gate precondition
   appear nowhere in the source — authored against §5.3 and §6.4.*
3. Given a `ReverifyReport` `R` that is `red`, `error`, absent, or green at a sha other than the head
   sha `H` about to be pushed, or an `ApprovalRecord` that is absent, in a state other than
   `approved`, decided before that report completed (per its `completedAt`), or whose bound
   `reportId`/`headSha` do not match `R`/`H` — an approval of an earlier verdict never authorizes a later
   re-harvest — When `openPullRequest` runs, Then **no ref is pushed and no PR is opened**, the
   refusal is recorded **durably host-side** — one line appended to
   `.sandbox/pr/<run-id>.refusals.jsonl` naming the failing precondition, the failing checks and the
   report path — and the command exits non-zero without hanging or retrying indefinitely
   (`p1-15-real-pr-produced.md:37`, carried). The issue comment carrying the same content is a
   **best-effort** notification on top of that record: a run dispatched without an issue reference,
   or one whose issue comment API call fails, still refuses with the durable record written, because
   a fail-closed path whose only sink is an optional surface is not fail-closed.
   *NET-NEW per R2 §7: "no PR" and "recorded on the issue" are F10 requirements, not source clauses.*
4. Given a run that already has `prUrl` on its run record, When `openPullRequest` is invoked again,
   Then the existing PR is returned unchanged, no second PR is opened, and no ref is pushed.
   *Negative control: an implementation that re-pushes and re-opens satisfies AC1 on a fresh run and
   MUST fail this test.* Given the remote already carries `refs/heads/qds/<run-id>` at a **different**
   sha, Then the push is refused rather than forced. Given the push succeeded but the PR-open API
   call failed, Then no `prUrl` is written and re-invocation resumes at the PR-open step against the
   existing branch — every boundary is resumable and none is partially recorded.
5. Given the target remote is absent from `.factory/repos.json`, or the allowlist is missing,
   unreadable, or has a mode wider than `0600`, or the matching entry carries no `authorLogin`, or
   the host token's authenticated login does not equal that `authorLogin`, or no host token is
   available, When `openPullRequest` runs, Then nothing is pushed, nothing is opened, and the attempt
   is logged as a security event (`p1-15-real-pr-produced.md:58`, carried: only explicitly registered repos — no
   open-redirect to arbitrary repositories). *Boundary: an empty allowlist matches no repository; it
   never means "any repository".*

## Trigger Surface

| Trigger | Status | E2E Test | Follow-Up |
|---------|--------|----------|-----------|
| `bun scripts/open-pr.ts <run-id>` CLI | in-scope | `tests/pr/open-pr.test.ts` | — |
| `openPullRequest(runId)` called after a decision closes `approved` | in-scope | `tests/pr/open-pr.test.ts` | — |
| Issue comment on refusal (red / unapproved / unregistered) | in-scope | `tests/pr/open-pr.test.ts` | — |
| `fleet pr <run-id>` subcommand on the dispatcher CLI | out-of-scope | — | DF3.1 |
| Tier-1 Claude Code skill wrapping the CLI | out-of-scope | — | DF3.5 |
| Inbound `pull_request` / review webhooks and the fix loop | out-of-scope | — | DF6.1 |
| PR link joined into the audit chain | out-of-scope | — | DF5.3 |
| Chat/webhook approval intake | out-of-scope | — | none in v5.0 — **DD-1** decides operator-CLI-only |

## Infra Prerequisites

| Component | Service (compose/k8s/provider) | Lifecycle Hook Verified |
|-----------|-------------------------------|-------------------------|
| Quarantine ref `refs/sandbox/<run-id>` | DF2.5 harvest, host git | preflight resolves the ref and its head sha; absent ⇒ refuse before any credential is read |
| `ReverifyReport` | DF5.1, `.sandbox/reverify/<run-id>.jsonl` | last record read; its `headSha` is the sha this story pushes, and any other sha refuses (AC1, AC3). `ApprovalRecord.reportId` **is** that report's `reverifyId` and `ApprovalRecord.headSha` is that report's `headSha` — the two identities the AC1/AC3 match compares |
| `ApprovalRecord` | DF3.4, `.sandbox/approvals/<run-id>.json` | host-authored, never harvested; state read as `approved` with `approverId`, `decidedAt` later than the report's `completedAt`, and bound `reportId`/`headSha` matching that report and the sha about to be pushed — all before the token is read |
| Host GitHub token | host keychain or stdin, never a box, never argv | preflight asserts presence, that its scope covers the registered remote, and that its authenticated login equals the entry's `authorLogin`; absent, revoked, out-of-scope or wrong-identity ⇒ refuse, nothing pushed (INV-PR-5, AC5) |
| Registered-repo allowlist | host config `.factory/repos.json`, mode `0600` | read before push; each entry carries `authorLogin` — the GitHub account the repo's review automation is bound to — alongside remote and base branch; absent, loose, non-matching, or missing `authorLogin` ⇒ every attempt refused (AC5) |
| Issue mirror index | P1.3 `.seeds/mirror-index.jsonl` + `(repoSlug, issueId)` on the run record | issue refs resolved for the body; an unresolved mapping renders `Issue: unresolved` and does not block |
| Cost ledger | DF2.8 `cost_events` (host-side) | `SUM(cost_micro_usd)` read for the body; no rows ⇒ `Cost: unavailable`, PR still opens (AC boundary) — the label casing DF5.4-C8's cost-summary-line assertion reads |

## Technical Notes

- **DD-10, stated once and plainly.** P1.15 had Warren opening the PR from inside the burrow, which
  put a push credential in the box. D8 reverses that: the credential is host-only, the push happens
  after DF5.1's out-of-box re-verify, and the in-box push clause is dead. It is not ancestry for
  anything here and must not be re-derived from the source file.
- **Ordering, fixed (design §5.3, F10):** in-sandbox run → bundle harvest → bundle verification
  (DF2.5) → host-side re-verify (DF5.1) → approval gate (DF3.4) → host-side push → PR opened. The box
  is already destroyed when this story runs — DF3.4 tears it down at pause — so nothing here reads
  from or writes to a sandbox.
- **The push is a separate export from the PR open (DF6.1's entry point).** `pushVerifiedSha(runId,
  { targetRef })` is exported from `src/pr/push.ts` and carries every push-side invariant
  (INV-PR-1/2/5/6): it pushes the sha the last `ReverifyReport` was green at, non-force, with the
  host-only token, only after the same reverify + approval preflight `openPullRequest` runs.
  `targetRef` defaults to `refs/heads/qds/<run-id>`; a **non-default** `targetRef` — the PR branch a
  fix run appends to (DF6.1 AC2) — is additionally required to be a fast-forward, asserted with
  `git merge-base --is-ancestor <remote-tip> <sha>` before the push, and is refused otherwise.
  `openPullRequest(runId)` calls it with the default ref only and **never accepts a non-default
  `targetRef`** — opening a PR against an operator-supplied ref is not a path this story exposes.
- **Contracts/Schema:** no new store. This story registers the `pr` sub-key on DF2.1's versioned
  `extensions` namespace and writes exactly three fields there — `extensions.pr.prUrl`,
  `extensions.pr.prNumber` and `extensions.pr.createdAt` (`schemaVersion: 1`) — at creation time and
  never retroactively (the
  write-at-creation rule from `p1-16-audit-chain-pr.md:39`, which is what makes DF5.3's first hop
  resolvable). They are not top-level core fields: DF2.1's twelve-field core stays closed, and the
  extension sub-key is the sanctioned additive path. The branch name `qds/{runId}` is the
  correlation key that hop walks. `extensions.pr.createdAt` is an ISO-8601 timestamp taken from the
  **host** clock immediately before the `POST /pulls` call — never GitHub's `created_at`, whose server
  clock is not comparable with the host clocks that stamp `ReverifyReport.completedAt` and
  `ApprovalRecord.decidedAt`. It exists so DF5.4-C6 can prove re-verify-precedes-PR ordering by
  comparing host clocks only. This story is the owner of the `pr` sub-key's shape, and that shape is
  exactly `{ prUrl, prNumber, createdAt }` at `schemaVersion: 1`; DF2.1's registry line naming the
  namespace is **illustrative of the allow-list entry**, not a competing field list.
- **Refusals are durable, host-side and separate from the run record:** AC3's refusal appends one
  JSON line to `.sandbox/pr/<run-id>.refusals.jsonl` (mode `0600`, append-only, one line per refused
  attempt) carrying `{ runId, attemptedAt, failedPrecondition, failingChecks, reportPath }`. It is a
  host-side artifact, not an `extensions` field — the `pr` sub-key stays the three fields above — and
  it exists so the fail-closed path has a sink that does not depend on the run having an issue.
- **Cost rendering (DD-9).** The ledger is integer micro-dollars; the body renders
  `$<dollars>.<6 digits>` with no rounding, plus the event count and the `unpriced` row count so a
  reviewer sees when a total is incomplete. DF2.8 is **not** a predecessor edge (R5 §2): an
  unreachable or empty ledger renders `Cost: unavailable` and the PR still opens — a missing cost
  line is a reporting gap, not a reason to withhold a verified PR.
- **What is published, and what is never published.** The body carries the DF5.1 check tally, failing
  item names, the changed-file list and DF5.1's `flags` — enough for a reviewer to see what was
  verified and where to look. The trace DB, compiled prompts and full agent transcripts are **never**
  attached, uploaded or quoted: they are client source code (F11/R10; R5 §6 fact 16) and a PR is a
  publication surface. Access to that material stays host-side and tier-1-tunneled (DF4.1).
- **Webhook correlation is a write-side problem now.** P1.15 correlated an unknown PR back to a run
  from an inbound `pull_request.opened`; the host opens the PR and knows the runId, so correlation
  is recorded at creation. The fail-closed inbound rule (`p1-15-real-pr-produced.md:44`) is DF6.1's.
- **Guards/limits:** PR body capped at 60,000 characters **including** any
  `[truncated, N chars total]` suffix (GitHub's ceiling is 65,536); the check table at 50 rows with a
  `+N more` line; the changed-file list at 100 paths. Each GitHub API call has a 30 s timeout and at
  most one retry on a 5xx or a 429 honouring `retry-after` up to 60 s; a 4xx is never retried. Before retrying `POST /pulls`
  after a lost response, the implementation first searches for an existing open PR whose head branch
  is `refs/heads/qds/<run-id>` (and whose body carries the runId); if found it is reused and recorded
  rather than creating a duplicate — making the retry idempotent.
- **PR author identity is load-bearing, not cosmetic.** Repository review automation is bound to a
  specific GitHub account (this repo's CodeRabbit binding is one such rule), so a PR opened by the
  wrong identity gets no bot review, and DF6.1's fix loop — which triggers on a bot review comment —
  never fires. The allowlist entry names the required `authorLogin` and preflight refuses on
  mismatch rather than opening a silently unreviewable PR; the refusal is a security event because a
  token authenticating as an unexpected account is also the shape of a mis-provisioned credential.
- **Deviation/assumption:** the base branch and remote come from `.factory/repos.json`, never from
  the harvested tree's git config — the tree is agent-authored (INV-PR-3). If a repo's default branch
  has moved, the allowlist entry is wrong, and the refusal names it rather than guessing a target.

## Observability Contract

- Every step logs `{ requestId, runId, step, repoSlug, timestamp, durationMs, outcome }` for
  preflight, push, PR open, record write and issue comment. The token never appears in any field.
- `requestId` propagates from the dispatch that created the run through the run record onto the PR
  event, so DF5.3 joins PR → run without a second key; errors carry `{ code, message, remediation }`.
- Sub-timings: `preflight_ms`, `push_ms`, `pr_open_ms`, `record_write_ms`. A step that did not run
  reports `0` and `durationMs` stays authoritative.

## Files to Modify

- `src/pr/open-pr.ts`
- `src/pr/push.ts` (exports `pushVerifiedSha`)
- `src/pr/body.ts`
- `src/pr/repos.ts`
- `src/pr/index.ts`
- `scripts/open-pr.ts`
- `tests/pr/open-pr.test.ts`
- `tests/pr/push.test.ts`
- `tests/pr/body.test.ts`
- `tests/pr/fixtures/repos.json`

## Security Invariants

- **INV-PR-1 (credential containment — the load-bearing one):** the push credential is host-only. It is never written into a box's environment, filesystem, fill payload, `exec` argument or run record, and no provider-driver call in this story's code path receives it (D8; R5 §6 fact 17). *Negative control: the source story's in-box push satisfies "the commits arrived" and MUST fail this test, which asserts no `ProviderDriver` method is reachable from `src/pr/`.*
- **INV-PR-2 (token hygiene):** GitHub tokens are never logged and never written to outcome records (`p1-15-real-pr-produced.md:60`, carried; the source's env-var storage is superseded by D8). The token is read from the host keychain or stdin, never argv, so it never appears in `ps` (DF2.3 INV-CRED-3), and is redacted from every error surface. It is held only for the duration of the call and never cached to disk, so operator rotation or revocation takes effect on the next invocation — a revoked or out-of-scope token refuses at preflight (AC5) rather than failing mid-push.
- **INV-PR-3 (registered repositories only):** the factory acts only on repositories explicitly registered in host configuration — no open-redirect to arbitrary repositories (`p1-15-real-pr-produced.md:58`, carried). The remote and base branch resolve from the allowlist, never from the harvested tree's git config, and a mode wider than `0600` refuses the allowlist.
- **INV-PR-4 (evidence authority at the boundary):** the PR opens on DF5.1's host-side verdict alone. In-box gate results and trace evidence are rendered as reviewer-visible claims and are never a precondition (F10/R9; R5 §6 fact 15). *Negative control: an implementation gating on the harvested merged output's `testResults` MUST fail the test that ships a run whose in-box claim is green and whose host verdict is red.*
- **INV-PR-5 (fail-closed, no bypass):** a missing, red, `error` or sha-mismatched re-verify report; an approval record absent, in any state other than `approved`, or decided before the report it would authorize; an unregistered remote; an absent token — each independently blocks both the push and the PR. Both records are host-authored artifacts read from host paths; neither is ever reconstructed from harvested output, so a box cannot manufacture its own approval. No flag, environment variable or code path opens a PR without both records present and satisfied. This applies to **both** exported entry points: `pushVerifiedSha` runs the same preflight before any ref update, so a fix run's append (DF6.1 AC2) needs its own green report and its own matching approval exactly as a first PR does — there is no push path that skips the gate.
- **INV-PR-6 (append-only publication):** the push creates `qds/<run-id>` and never force-updates an existing remote ref; a divergent existing branch is a refusal, not an overwrite. A non-default `targetRef` (DF6.1's PR branch) is pushed only when the new sha is a descendant of the remote tip — `git merge-base --is-ancestor` — so an append is the only accepted update and a rewrite is a refusal. No operator branch or tag is read or written — the push source is the sha `refs/sandbox/<run-id>` was verified at, and nothing else (DF2.5 INV-2).
- **INV-PR-7 (confidentiality of published content):** the trace DB, compiled prompts and full agent transcripts are never attached to, uploaded with, or quoted in a PR body, comment or branch (F11/R10). Rendered fields pass through `redactSecrets` (`cli-anything/src/redact.ts:62`) at the body-construction boundary, once, before anything leaves the host. The redaction map is a **purpose-built map of this run's known-sensitive values** — the host GitHub token, the run's minted provider key and its hash, the approver token — assembled by the caller and **never** `process.env`: INV-PR-2 keeps the token out of the environment entirely, so an environment-derived map would redact nothing.

## Definition of Done

- [ ] **Impl:** `openPullRequest(runId)` — preflight in the fixed order (ref → re-verify → approval → allowlist → token identity), non-force push of the verified sha to `qds/<run-id>`, PR opened, record written; every boundary independently resumable (AC4).
- [ ] **Impl:** `pushVerifiedSha(runId, { targetRef })` exported from `src/pr/push.ts`, running the same preflight; non-default `targetRef` additionally asserted fast-forward via `git merge-base --is-ancestor`; `openPullRequest` never passes a non-default ref (INV-PR-5, INV-PR-6).
- [ ] **Impl:** refusal path appends one line to `.sandbox/pr/<run-id>.refusals.jsonl` naming the failing precondition, the failing checks and the report path, best-effort posts the same content as an issue comment, exits non-zero, and pushes nothing (AC3).
- [ ] **Test (issue-less refusal):** a run with no issue reference and a `red` report refuses with the durable refusal line written, nothing pushed, non-zero exit — an implementation whose only refusal sink is the issue comment MUST fail this test (AC3).
- [ ] **Contract:** PR body renders runId, P1.3 issue refs, DF2.8 cost summary in micro-dollar-derived USD, DF5.1 verdict + check tally + flags, the changed-file list, and DF3.4 approver attribution, capped at 60,000 characters including the truncation suffix.
- [ ] **Integration:** `prUrl`, `prNumber` and `createdAt` written under the DF2.1 run record's `extensions.pr` namespace at creation time, not retroactively — the correlation key DF5.3's first hop walks and the host timestamp DF5.4-C6 orders against.
- [ ] **Test (fast-forward-only append):** `pushVerifiedSha` with a non-default `targetRef` whose sha is **not** a descendant of the remote tip is refused with nothing pushed; a descendant sha appends; `openPullRequest` rejects a non-default `targetRef` outright (INV-PR-6).
- [ ] **Test (author identity):** a host token whose authenticated login differs from the entry's `authorLogin` refuses at preflight with a security event, nothing pushed, no PR (AC5).
- [ ] **Security:** token host-only, keychain-or-stdin, never argv, never logged, never recorded — asserted by a test that runs with a sentinel token and greps every log line, run-record field and error surface for it; allowlist enforced before push (INV-PR-1, INV-PR-2, INV-PR-3).
- [ ] **Security:** no trace DB, compiled prompt or transcript content reaches GitHub; body fields redacted at the construction boundary against a purpose-built map of the run's known-sensitive values — asserted by a test that plants a sentinel secret in a **body input** (a re-verify note) while keeping that sentinel out of `process.env` and greps the rendered body, comment and every log line for it; an implementation redacting against `process.env` MUST fail (INV-PR-7).
- [ ] **Test (evidence authority, negative control):** a run whose harvested merged output claims `exitStatus: "success"` with green in-box gates but whose `ReverifyReport` is `red` → no ref on the remote, no PR, issue comment written. An implementation gating on the in-box claim MUST fail this test (INV-PR-4).
- [ ] **Test (idempotency):** a second `openPullRequest` for a run with `prUrl` set returns the same PR and pushes nothing; a re-push-and-reopen implementation MUST fail (AC4).
- [ ] **Test (no-ledger boundary):** with zero `cost_events` rows for the run, the body renders `Cost: unavailable` and the PR still opens (AC2 boundary).
- [ ] **Test (e2e demo — MANDATORY):** against a disposable GitHub repository, one harvested and host-re-verified run produces a **real PR** whose branch is `qds/<run-id>` and whose body carries the runId, the issue reference, the cost summary and the green re-verify tally. The PR URL is captured in the Dev Agent Record — the factory's step-5 artifact.

## Dev Agent Record

<!-- Empty placeholder — filled during development. -->

## Handoff from df3-1 review round 10 — repoUrl host binding is OPEN above this story

**Source:** df3-1 BMAD review round 10, finding FF2 (HIGH, deferred to here by design).
Ledger: `_bmad-output/workflow-state/code-review/pr123/triage.md` · reviewer evidence:
`…/code-review/pr123/reports/blind-fleet-rest.md` (§ Brief can attribute attacker-controlled code).

**The seam you inherit:** `src/fleet/brief-schema.ts`, the object-level refine
(`repoSlugOfUrl`, ~line 395-423). It ties `repoUrl`'s PATH to `repoSlug` and nothing else.
Everything downstream trusts the slug after this gate: ledger identity (`canonicalRepoSlug`,
`issueScopeSql`), the run-context cap witness, dispatch-log attribution. The clone consumes
raw `repoUrl`. df3-1's doctrine is "validate once at the brief, trust the identity everywhere
after" — which means this refine is the ONLY thing standing between a brief and the code that
runs under an identity's budget.

**Foreseen problem:** `{repoSlug: "trusted/repo", repoUrl: "https://evil.example/trusted/repo"}`
validates today — path ties exactly, host untied. The box clones evil.example's code while cap,
run-context and every log row record `trusted/repo`: miss-attributed spend plus arbitrary code
execution under a trusted identity. The docstring on the refine says all of this; it defers to
THIS story's allowlist design.

**Recommendation for the allowlist:**
1. Host allowlist as an extension of the SAME zod refine (keep the one-gate doctrine — do not
   add a second check downstream). Deny-by-default; allowed hosts come from operator config
   (a sibling key in `cost-config.json` keeps the config surface at one file).
2. On mismatch: exit 2 `invalid-brief` naming BOTH hosts, before any provisioning side effect
   (AC1 posture — validation completes before the first mutation).
3. Consider requiring a pinned commit SHA in the brief as defense-in-depth: DF3-1's F4
   `bundle-push` fill fetches the pinned SHA with HOST credentials, so a pinned SHA makes code
   identity = reviewed SHA even when a host allowlist entry is broad.
4. Migration note: default-deny breaks self-hosted Git hosts until configured — ship the
   refusal message with the exact config key to set, same pattern cost-ledger-opts uses for
   `$QDS_COST_CONFIG_FILE`.

**Test guidance:** mutation-test the refine itself — an `evil.example` variant must refuse at
exit 2 pre-provisioning (assert NOTHING was created: no store dir, no ledger row), not merely
fail later. A test that only checks exit 2 passes even if the gate fires after `store.create`.
