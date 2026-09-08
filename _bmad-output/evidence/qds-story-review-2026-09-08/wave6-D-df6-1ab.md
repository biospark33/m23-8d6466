# Wave 6 — D: DF6.1a + DF6.1b (third-round independent verification)

**Scope:** `df6-1a-pr-feedback-bounded-fix-attempt.md`, `df6-1b-fix-loop-verdict-attempt-budget.md`
**Branch:** `feature/qds-story-review-remaining-v5-stories` · **Date:** 2026-09-08
**Method:** every symbol, flag, exit code, return arm and file named by either story was opened in
this tree. No ruling below rests on a story's description of code, a docstring summary, or a symbol
name. Citations are by symbol/section anchor.

---

## 0. What I verified as CORRECT (so the lead knows where not to spend a fourth round)

Round 2's fixes largely hold. Each of these was opened and confirmed:

- **The two `redactSecrets` disambiguation is exactly right.** `grep -rn "export function redactSecrets"`
  over the whole tree returns exactly two: `src/providers/step-log.ts:225`
  `redactSecrets(text: unknown, keep?: string)` (pattern redactor — `redactKeyManagementUrls`,
  `PEM_BLOCK_RE`, `SECRET_PREFIX_RE` driven by the imported frozen `SECRET_PREFIXES`, `LONG_TOKEN_RE`)
  and `cli-anything/src/redact.ts:62` `redactSecrets(text: string, parentEnv: EnvMap)` (known-value,
  filtered by `SECRET_KEY_RE` on key name, no pattern arm at all). Both stories name the right one at
  the right path. `readHostToken`'s "never `process.env`" docstring is real and is exactly why the
  known-value redactor is blind here.
- **DF6.1b AC1's CI-verdict measurements are real, not assumed.** `gh pr checks --help` on the host
  (gh 2.93.0) documents `--required`, the JSON field set `bucket, completedAt, description, event,
  link, name, startedAt, state, workflow`, and verbatim *"Additional exit codes: 8: Checks pending"*.
  `gh pr view --json` exposes `headRefOid` and `statusCheckRollup`. The two-call composition and the
  branch-on-output-not-exit-code rule are correct.
- **`PushOutcome`'s three arms are correctly enumerated.** `src/pr/push.ts` `pushVerifiedSha` returns
  `{ok:true, sha: pre.headSha, targetRef, pushed}` on both push and resume, and `{ok:false, refusal}`
  from a `catch` that never rethrows. `pushWithPreflight` returns `false` when `tip === pre.headSha`,
  logging `outcome: "already-present"`. The story's claim that `sha` is `attemptSha` on the
  `pushed:false` arm is verified true.
- **The run-record facts.** `EXTENSION_NAMESPACES.fixLoop = { schemaVersion: 1, fields: { fixContext:
  "string", fixOutcome: "string" } }` is registered. `FieldKind = "string" | "int" | "ports" |
  "strings"` — no object kind; `assertKind` throws `schema-rejected: <key> must be a string`.
  `assertNoSecret`'s prefix scan is `(^|[^A-Za-z0-9])<prefix>` over `SECRET_PREFIXES`; the shape
  heuristic's charset is `/^[A-Za-z0-9+/=_.:-]+$/` anchored on the whole trimmed value, so it genuinely
  cannot fire on a JSON-encoded payload. `extensions` **stays writable after close** (`setLocked`'s
  `key === "extensions"` branch), which is what makes DF6.1b's write onto the closed parent record
  legal. No length bound exists on a `"string"` extension field — the story's premise is true.
- **`writes: string[] | null` with `null` = unrestricted** is real (`ResolvedRole.writes`,
  `src/phase-engine/roster/schema.ts`), including the header's explicit refusal to infer it from
  silence. The four negative controls in AC5 are all correct against that contract.
- **The lock facts DF6.1b corrected in wave 5b are true.** `scripts/fleet.ts` has exactly two
  `acquireRunLock` sites — `:1976` (`"fleet dispatch key-mint"`) and `:4257` (`"fleet invocation"`,
  inside `runDestructive`). `GATE_VERBS` (`:3005`) = `approve, reject, enrol, unlock, attach`, routed
  to `runGateVerbs` at `:1734` *before* `runDestructive`, so gate verbs take no run lock. The
  "not re-entrant" claim is real (`run-lock-reentrant` error class).
- **`liveGate(tier: "1" | "2")` is at `tests/fleet/e2e/live-harness.ts:65` exactly**, and
  `keyLeakProblems` is exported at `:1488`.
- **`fill.ts`'s structural containment is real** — `bundle-push` is the documented default, the host
  authenticates, and `repoUrl` carrying userinfo is refused before any command runs.
- **`p1-18:36` is the `botComments` shape line and `p1-18:50` is INV-2 carrying `(P1.19)`.** Both
  citations are exact; the repoint edit targets the right line.
- **`requestApproval`'s sole production caller is `src/reverify/runner.ts:461`** — ADR Appendix A's
  premise and DF6.1a's "DF5.1 requests the approval" both hold.
- **DF3.7's INV-IBOX-16 already names DF6.1a's fix run** as one of three sanctioned automatic callers,
  in the wording DF6.1a quotes.
- **`config/rosters/roster.yaml` passes AC5's guard**: `lead` inherits `writes: []`, `fixer` declares
  `["src/","tests/"]` — exactly one write-capable role.

**Self-proving-grep note.** `scripts/lib/run-lock.ts` contains 2 raw NUL bytes (60377 bytes raw,
60375 after `tr -d '\000'`). My positive control (`grep -c acquireRunLock` on that file) produced **no
output at all**, not `0`. Every assertion I make about that file was taken from the NUL-stripped copy.

---

## 1. BLOCKER

### W6-D-B1 — The post-push CI poll leg is owned by neither half, and the window it uses is vacuously expired in the ordinary operator workflow
**Category: `C3-structural`** · DF6.1a §Acceptance Criteria AC3 + §E2E Slice; DF6.1b §AC1,
§Technical Notes "The 15-minute budget is the CI-poll window", §Files to Modify.

**What each half says.** DF6.1a's E2E slice ends: *"`extensions.fixLoop.fixContext` is written on the
fix run's own record carrying `attemptSha` … **Invocation 2 exits.**"* AC3's second limb is equally
terminal: invocation 2 *"re-takes the lock, performs AC6's scope check, calls `pushVerifiedSha`, and
writes `fixContext` (AC4)"* — and nothing after. DF6.1a's closing line is *"**That record is where this
story ends.**"*

DF6.1b's AC1 sets *"The polling ceiling is **15 minutes measured from `pushVerifiedSha`'s return**"*,
and its DoD repeats *"up to the 15-minute poll window opened by `pushVerifiedSha`'s return"*. But
DF6.1b's `scripts/fix-run.ts` Files-to-Modify entry enumerates its additions — the recorded-attempt
read, the budget check, the dedup retry exception, the attempt-start empty-required-set probe, the
`fixContext.attempt` value, and the escalation call — and then states *"DF6.1a's two-invocation drive
path is **otherwise unchanged**."* **The call site that invokes `ci-status.ts` after the push is not
in that list.** `src/fixloop/ci-status.ts` is listed as a module; nothing in either half says which
invocation calls it, or when.

**Failure scenario.** A dev reads both halves literally and puts the poll in a *third* invocation,
because DF6.1a says invocation 2 exits and DF6.1b says its edits leave that path unchanged. The
operator pushes at 14:00 and re-invokes at 15:30 (DD-1: there is no scheduler, no receiver, and the
operator decides when to come back). `ci-status.ts` reads the window opened at `pushVerifiedSha`'s
return, finds 90 minutes elapsed against a 15-minute ceiling, and returns `ci-verdict-unavailable`
without ever issuing a poll — on a PR whose required check turned green at 14:04. AC1's *"on all-green
the run advances to summarize and reaches a terminal success state"* is unreachable on the healthy
path; every attempt escalates; AC2 then classifies `ci-verdict-unavailable` as a **charged** failure
("a required check red, **or `ci-verdict-unavailable` after a successful push**"), so two green PRs
exhaust the budget and the loop terminates permanently in escalation. Both DoDs are green: DF6.1a's
because it stops at the write, DF6.1b's because its termination-matrix test drives fixture records and
a fake `gh` with a synthetic clock.

The alternative reading — invocation 2 continues into a 15-minute poll — is *not* stated by either
half, and it would need DF6.1a's AC3 and E2E Slice amended, because it changes invocation 2 from
"scope check → push → write → exit" into "… → write → poll up to 15 min → classify → maybe escalate."
That is not a small edit: it moves the escalation call, the charging decision and `fixOutcome`'s write
inside DF6.1a's invocation-2 boundary.

**Fix direction.** Name the invocation. Make invocation 2 the polling invocation and say so in
DF6.1a AC3 ("invocation 2 … writes `fixContext`, **then hands off to DF6.1b's poll leg before
exiting**"), and replace DF6.1b's "otherwise unchanged" with an explicit `scripts/fix-run.ts` addition:
*"the post-push poll call, invoked in the same invocation immediately after DF6.1a's `fixContext`
write."* If a third invocation is genuinely wanted, the window must be re-anchored on *invocation
start* with the recorded `attemptSha` as the binding, and AC2's charging rule must stop treating
`ci-verdict-unavailable` as charged.

---

## 2. HIGH

### W6-D-H1 — DF6.1b's parent-run lookup (and therefore its lock key) has no index; it requires the `list()` sweep the story disclaims
**Category: `C2-semantic`** · DF6.1b §Technical Notes "Attempt bookkeeping" and "Concurrency: the lock
is keyed on the PARENT run".

**Evidence.** `RunRecordStore`'s public surface is `path`, `lockPath`, `create`, `get`, `set`, `close`,
`list`, `listWithAnomalies` — there is no query-by-extension and no secondary index; records are files
keyed by runId (`path(runId)`). `extensions.pr.prNumber` is real (registered in
`EXTENSION_NAMESPACES.pr`) but it is a *field on a record you already have*, not a lookup key.

The story's own argument is: *"'scan every record for PR n' would mean a full `list()` sweep plus a
JSON parse per record… The lookup is therefore the join that already exists: **resolve the parent run
by `extensions.pr.prNumber` (DF5.3's hop-1 join)**… One indexed lookup plus one record read."*
DF5.3's hop 1 runs the **other direction**: `df5-3-audit-chain-extended.md` DoD — *"`walkAuditChain(ref)`
accepts a PR URL, branch name or runId"*, and its broken-hop test is *"a PR body with no runId → hop 1
named"*. Hop 1 resolves **PR → runId from the PR body/branch**, over the network. It provides no
runId ← prNumber index on the record store, and DF5.3 builds none.

**Failure scenario.** The dev implements exactly what the story says: iterate `store.list()`, JSON-parse
every record, find the one whose `extensions.pr.prNumber === n`. On a fleet with thousands of records
that is the fleet-wide read cost DF6.1a's own Technical Notes cite as the reason not to store bulk in
the record — reintroduced by the half that cited it. Worse, this sweep runs *before* the lock is
taken (you cannot lock `parentRunId` until you have resolved it), so two concurrent `--pr <n>`
invocations both sweep, both resolve the same parent, and the race the DoD test exists to close is
merely narrowed, not closed — and the DoD item ("two concurrent `--pr <n>` invocations that have not
yet dispatched … exactly one dispatches") is written against a lookup whose cost the story
mis-states.

**Fix direction.** The zero-lookup resolution already exists and DF6.1a already validates it: DF5.2's
`defaultTargetRef(runId)` is `refs/heads/qds/<runId>`, so **the PR's head branch name *is* the parent
runId**, and DF6.1a's Trigger Surface already refuses *"a PR whose head branch is not `qds/<run-id>`
with a matching run record."* Specify `parentRunId = headRefName.slice("qds/".length)`, validated by
`store.get(parentRunId)` — one `gh pr view --json headRefName` (which DF6.1b already calls per poll)
plus one record read, no sweep, and the lock key is available before any record is scanned.

### W6-D-H2 — DF6.1a's `issue-ceiling-insufficient` DoD asserts a refusal that exists only on the fan-out path this story explicitly is not on
**Category: `C3-structural`** · DF6.1a §Technical Notes "The fix brief pins the parent run's
`issueId`", §DoD "Test (issue-ceiling declaration)".

**Evidence.** `grep -rn "issue-ceiling-insufficient" --include=*.ts src/ scripts/` returns exactly one
hit: `src/fleet/fanout-primitive.ts:463`. Its message is hard-coded to the fan-out shape (*"fan-out of
${n} arms at ${cap} µ$ each needs …"*) and its remediation is *"declare the aggregate for this
**fan-out**"*. Positive control on the same sweep: `perIssueOverrides` appears once in
`src/fleet/dispatch.ts` and zero times in `scripts/fleet.ts`.

What the **plain** dispatch path has is a different, weaker refusal: `src/fleet/dispatch.ts` throws
`refuse(5, "no-ceiling", …)` only when `effectiveCeilingMicros <= 0` — i.e. when there is no headroom
*at all*, not when headroom is below `parentSpend + 2 × perAttemptCap`.

And DF6.1a itself states the fix run is not a fan-out: *"a fix attempt is an ordinary single dispatch,
so it carries exactly the same inherited ceiling race every other dispatch does"* (DF13 residue note),
and DF6.1-M8 answers *"a fix attempt is a single dispatch, never a fan-out arm."*

**Failure scenario.** The dev writes the DoD test, asserts exit 5 with reason
`issue-ceiling-insufficient`, and it never fires — the plain dispatch admits attempt 1 happily
(headroom is positive) and the test either fails or is quietly rewritten to assert `no-ceiling`, which
does not test the declared-aggregate rule at all. The real consequence the story predicted then
happens in the field: *"attempt 2 is refused `budget-exceeded` on a PR whose fix was one prompt away,
and DF6.1b's failure path never fires as a *fix* failure at all."* Making it fire requires the
declared-aggregate reconciliation on `src/fleet/dispatch.ts`'s admission path — **an edit that is not
in DF6.1a's Files to Modify**, and is arguably a DF3.1 core change owed its own justification.

**Fix direction.** Either (a) declare the `src/fleet/dispatch.ts` edit in Files to Modify with the
DF3.1-core justification the story's own `run-record.ts` line uses as its template, or (b) drop the
`issue-ceiling-insufficient` code from the DoD and assert the *pre-dispatch* check in
`src/fixloop/feedback-run.ts` instead — it already runs a host-side refusal there for AC5, and reading
the ledger snapshot for `${repoSlug}#${issueId}` before dispatch costs no box. (b) is the smaller
diff and keeps the refusal in the story's own module.

### W6-D-H3 — The import fence copied "verbatim" from DF3.7 AC1 forbids `src/fixloop/` from importing the module whose function is this story's whole point
**Category: `C3-structural`** · DF6.1a §"DF3.7 is a hard edge" blockquote, §DoD "Impl: `src/fixloop/`
imports none of …".

**Evidence.** DF3.7 AC1's fence, read in full, is symbol-level and scoped to one named file: it
requires that **`src/fleet/run-completion.ts`** import `approval-gate.ts`, `approvers.ts`,
`src/pr/push.ts` and the `src/fleet/index.ts` barrel *"not at all"*, and import
`src/providers/run-record.ts` **"only for `RunRecordStore`/`RunRecord`"**. Its rationale
(INV-IBOX-14) is that the bridge must not acquire *the ability* to push or to write the approval
namespace.

DF6.1a says *"DF3.7's AC1 static import fence is extended verbatim to `src/fixloop/`"* and its DoD
spells it as *"`src/fixloop/` imports none of `approval-gate.ts`, `approvers.ts`, `push.ts` or
`run-record.ts`'s approval-extension block, asserted by the same grep test DF3.7 AC1 ships."*

Two problems, both structural:

1. **`push.ts` is banned, and calling `pushVerifiedSha` is the story's central act** (AC2, AC3, AC4,
   and two DoD items). The rationale transfers with the words but not with the sense: DF3.7's bridge
   must not be able to push; DF6.1a *must* push. The only way to satisfy the fence as written is to
   put the entire push-and-record sequence — the scope check, `pushVerifiedSha`, the INV-7 pre-flight
   and the `fixContext` write, i.e. every security-critical line in the story — in `scripts/fix-run.ts`,
   a top-level script, while `src/fixloop/` holds only the brief builder. The story never says that,
   and its own AC4 puts the parser in `src/fixloop/` (*"validated by `src/fixloop/`'s own parser on
   read and write"*) while the write must then live outside it.
2. **"`run-record.ts`'s approval-extension block" is not greppable.** DF3.7's fence works because it
   allow-lists *symbols in the import specifier* (`RunRecordStore`/`RunRecord`). A "block" of a file
   is invisible to an import-specifier grep, so "the same grep test DF3.7 AC1 ships" cannot be reused;
   a fence that cannot be spelled is a DoD Security box checked by a test that asserts nothing — the
   exact failure DF3.7's own negative control names.

**Failure scenario.** The fence lands as a grep over `src/fixloop/**` for `push.ts`. The dev's natural
module layout puts `pushVerifiedSha` in `src/fixloop/push-attempt.ts`; the suite goes red; the fence
gets weakened to match nothing, and DF6.1a ships with no import discipline at all — or the logic gets
shoved into an untestable script.

**Fix direction.** State the fence in DF6.1a's own terms rather than inheriting DF3.7's: `src/fixloop/`
may import `src/pr/push.ts` **only for `pushVerifiedSha` and `PushOutcome`** (never `preflight`,
`pushWithPreflight` or `recordRefusal`), and `src/providers/run-record.ts` **only for
`RunRecordStore`/`RunRecord`** — the symbol-level form DF3.7 actually uses. Keep the ban on
`approval-gate.ts`/`approvers.ts` absolute; that one does transfer.

### W6-D-H4 — INV-7's pre-flight cannot validate the value it claims to, because `attemptSha` does not exist before the push
**Category: `C3-structural`** · DF6.1a §AC4 second paragraph, §Security Invariants INV-7(a).

**What is claimed.** *"The record write is **pre-flighted in validate-only mode before
`pushVerifiedSha` is called** (INV-7): the encoded payload is built and run through the same
validation the write will apply, so a payload that would be refused is refused **while nothing has
been published**. The post-push write is then **a write of an already-validated value**."*

**Why it cannot hold.** The `fixContext` payload's defining field is `attemptSha`, and AC4 is emphatic
that it is *"the sha the push export published… taken from the return"* and that *"there is no pending
or partial `fixContext` with a not-yet-known `attemptSha`."* The value validated before the push is
therefore necessarily a **different string** from the value written after it. "A write of an
already-validated value" is false by construction, and the negative control (*"an implementation that
defers all validation to the post-push write can still refuse after an irreversible push"*) has no
passing counterpart to compare against: any implementation that pre-flights *something* passes, no
matter what it pre-flighted.

**Failure scenario.** The dev pre-flights the payload with `attemptSha: ""`. The empty string changes
the JSON length and content; the test asserting "validated before the push" passes; nothing was
actually proven about the value that lands. Conversely a dev who tries to be rigorous discovers the
AC is unsatisfiable and either fakes it or deletes it. Either way the invariant that exists to stop a
refusal landing after an irreversible act ships as decoration.

**Fix direction.** Make the pre-flight statement precise and falsifiable: *the pre-flight validates the
payload with `attemptSha` set to a canonical 40-lowercase-hex placeholder, and the post-push write
differs from the pre-flighted value in exactly that one field, asserted by a test that diffs the two
encoded strings.* Then state the residual honestly — a 40-hex sha cannot trip `assertNoSecret`
(the prefix scan matches no hex, and the shape heuristic needs mixed case) — so the only
operator-uncontrollable input is provably incapable of failing. That is a claim a test can falsify.

### W6-D-H5 — AC6's scope check names no diff base, and the natural wrong choice produces systematic false `scope-requires-privilege`
**Category: `C3-structural`** · DF6.1a §AC6, §Technical Notes "The host-owned scope artifact".

**Evidence.** AC6 reads *"Given the harvested diff, When the host compares **every path in it** against
`.factory/fix-scope.json`…"*. A diff has two endpoints. Nothing in DF6.1a names the base. The DoD
items ("a fixture whose harvested diff touches `scripts/reverify.ts`") inherit the same silence, and
the shipped code offers two plausible answers with opposite consequences: `preflight` resolves
`refs/sandbox/<runId>` to `headSha`, and the fix run's brief pins `commitSha` = the PR head.

**Failure scenario.** The dev diffs against the repository's default branch, which is the reflexive
choice and is what `resolveRepoEntry`'s `baseBranch` makes available. The fix run's bundle descends
from the **PR head**, so the diff then contains every file the *parent* run changed as well as the
fixer's own edits. If the parent run touched anything under `scripts/**`, `**/*.yml` or `.github/**` —
which a factory PR routinely does — the fix attempt refuses `scope-requires-privilege`, charges zero,
and escalates on **every** attempt. DF6.1b then records it as a correct refusal and never retries. The
loop terminates in permanent escalation on the healthy path, and the failure looks like a policy
decision rather than a bug: the deny rule *did* match, with a real `reason`. Nothing in either DoD
catches this, because every scope fixture is a hand-authored diff, not one produced by a real harvest
over a real parent PR.

**Fix direction.** Name the base in AC6: *the diff is `git diff --name-status <the brief's pinned
`commitSha`>..<the green `ReverifyReport.headSha`>` — the PR head the attempt started from against the
sha the push will publish — so the comparison sees exactly this attempt's own changes and nothing the
parent run contributed.* Add a DoD leg whose fixture is a two-commit history (parent-run commit
touching `scripts/`, fix commit touching only `src/`) asserting `pushVerifiedSha` **is** called.

### W6-D-H6 — The bot-comment read — the story's sole trigger — has no owning module, and the obvious implementation breaks DF5.2's shipped fakes
**Category: `C3-structural`** · DF6.1a §Trigger Surface row 2, §Overview, §Files to Modify.

**Evidence.** The Trigger Surface says *"the CLI fetches the PR's review comments with `readHostToken`
(`src/pr/github.ts:176`) and filters to bot authors."* `readHostToken` reads a token and nothing else.
The `GitHubApi` interface in `src/pr/github.ts` has exactly **four** members —
`authenticatedLogin`, `findOpenPr`, `createPr`, `commentIssue` — and its module header states the
constraint deliberately: *"The GitHub surface DF5.2 touches, and nothing else… this story makes four
calls."* There is no method to list PR review comments, and no method to read a PR's state
(open/closed/merged) or head branch, both of which AC5 and the Trigger Surface require
(*"comments only on a closed/merged PR"*, *"a PR whose head branch is not `qds/<run-id>`"*). The
`request` helper carrying the module's whole policy (30 s timeout, one retry on 5xx/429 for safe
methods only, `authorization` header, no logging) is **module-private, not exported**.
`src/pr/github.ts` does **not** appear in DF6.1a's Files to Modify.

**Failure scenario, two branches, both bad.**
(a) The dev adds `listReviewComments` + `getPr` to `GitHubApi`. Adding required members to that
interface breaks every existing object-literal fake — `tests/pr/helpers.ts`, `tests/pr/github.test.ts`,
`tests/pr/open-pr.test.ts` all construct `GitHubApi` values — so DF5.2's 85-test suite goes red on a
story whose Files to Modify claims it touches no DF5.2 file. The dev then makes the members optional,
and the seam every DF5.2 test drives quietly stops being total.
(b) The dev writes a raw `fetch` inside `src/fixloop/feedback-run.ts` because `request` is not
exported. The 30 s timeout, the single-retry-on-safe-methods rule and the "nothing here logs, so
nothing here can log it" property (INV-PR-2) are all re-derived by hand on the one path that handles
**untrusted third-party content** and carries the host token. A logged error body on an authenticated
call is exactly what `request`'s own comment refuses to do.

**Fix direction.** Declare the edit and its shape: add `listPrReviewComments` and `getPullRequest` to
`GitHubApi` and `httpGitHubApi`, list `src/pr/github.ts` in Files to Modify as **adds-only** with the
same justification the `brief-schema.ts` line already uses, and add a DoD leg asserting DF5.2's
existing `tests/pr` suite is green unchanged (which forces the fakes to be updated in this story
rather than discovered by the next one). Note explicitly that PR *review* comments
(`/pulls/{n}/comments`) and PR *issue* comments (`/issues/{n}/comments`) are different endpoints —
the story says "review comments" but a review-bot summary lands on the issue surface.

### W6-D-H7 — INV-3's credential probe cannot observe the one environment source the run unit actually loads
**Category: `C2-semantic`** · DF6.1a §Security Invariants INV-3, "Mechanism, not just requirement (M3)".

**What is claimed.** *"The probe runs as `systemd-run --wait --pipe --service-type=exec --uid=<the
unit's User=> …` so it **inherits the same environment `qds-run@<runId>.service` will** — an ordinary
exec sees a different environment and would prove nothing about the unit."*

**Evidence from the shipped unit.** `oci/exedev/systemd/qds-run@.service` builds its environment from
three sources: the system manager's environment, **`EnvironmentFile=/home/exedev/app/.env`** (mandatory
form, no leading `-`), and two `Environment=` lines. A transient `systemd-run` unit inherits the
manager's environment — that part of the claim is right, and it is genuinely different from an ssh
exec — but it does **not** load `qds-run@.service`'s `EnvironmentFile=` or its `Environment=` lines.

**Why that is the gap that matters.** `/home/exedev/app/.env` is precisely where DF2.3 delivers the
box's one secret, and it is the only *run-specific* env source the unit has. INV-3's own text is *"the
box holds exactly **one** secret… at `$HOME/app/.env`"* — so the file that INV-3 is asserting a
property about is the file the probe cannot see. A `GH_TOKEN=` line appended to that file by any later
story, or by a mis-scoped DF2.3 mint, is inherited by the unit, invisible to the probe, and the DoD's
three negative controls (plant `~/.git-credentials`, write a `gh` `hosts.yml`, set
`GH_ENTERPRISE_TOKEN`) all still pass. That is the same "the test reads as *the box is credential-free*
while proving something narrower" false-green the story itself says H5 was fixed to remove.

Secondary, smaller: the probe must go through `sudo -n` the way `fleet run` does
(`src/fleet/run.ts` §"Why `sudo -n`" — passwordless sudo is an established substrate property), or an
unprivileged `systemd-run` against the **system** manager hits the polkit wall ADR Appendix B
identified for `systemd-run --scope`. The story names neither `sudo -n` nor the polkit hazard.

**Fix direction.** Add the file to the sink list: the probe additionally reads
`/home/exedev/app/.env` and asserts it contains **no** key matching
`^(GH|GITHUB)_[A-Z_]*TOKEN=|^GIT_ASKPASS=|^SSH_AUTH_SOCK=` — one line, and it covers the env source
`systemd-run` structurally cannot reproduce. State the mechanism as `sudo -n systemd-run --wait --pipe
--service-type=exec --uid=exedev …`, citing `fleet run`'s precedent.

### W6-D-H8 — The mandatory e2e demo runs against a disposable repo that has no `.factory/fix-scope.json` entry, so AC6 refuses it before the push
**Category: `C3-structural`** · DF6.1a §Technical Notes "The host-owned scope artifact", §DoD "Test
(e2e demo — MANDATORY)".

**Evidence.** The scope artifact *"resolves **per repoSlug**, and a repoSlug with no entry is a
refusal (`fix-scope-missing`), not a permissive default"*, and the DoD Security item asserts exactly
that. The e2e demo *"Run against a **disposable** repository — never `QDS-Factory` itself"* and lists
its three prerequisites: (i) branch protection with one required check, (ii) the review bot bound to
`authorLogin`, (iii) a DF5.2-produced PR. A `.factory/fix-scope.json` entry for the disposable repo's
slug is **not** among them, and the only default the story ships is *"for `QDS-Factory`-shaped repos."*

**Failure scenario.** The operator runs the round: box provisioned, key minted, model spend incurred,
approval given — and then the scope check refuses `fix-scope-missing` with nothing pushed. The MANDATORY
demo cannot pass, after the full ≈50 000 µ$ + box-hours has been spent, because the artifact that
gates the push has no row for the repo the demo uses. The equivalent prerequisite for
`.factory/repos.json` *is* listed (Infra Prerequisites row "PR author ↔ bot-reviewer binding"), which
is what makes the omission a real oversight rather than a stylistic one.

**Fix direction.** Add (iv) to the e2e prerequisite list: *a `.factory/fix-scope.json` entry for the
disposable repo's slug, carrying the same shipped default (allow `src/**`, `tests/**`, `scripts/**`;
deny the verification surface), verified present before the round starts* — and add a
`fix-scope-missing` negative control to the same round, which is free (it refuses before any box).

---

## 3. MEDIUM

### W6-D-M1 — "Nothing host-side learns a run finished today" is false; `fleet status` reads the marker
**Category: `C2-semantic`** · DF6.1a §"DF3.7 is a hard edge" blockquote; DF6.1b §"The real dependency
graph".

Both halves assert, as the load-bearing premise for the DF3.7 hard edge, *"Nothing host-side learns a
run finished today: `src/fleet/run-completion.ts` and `--await-completion` do not exist"* /
*"nothing host-side learns an in-box run finished."* Opened: `src/fleet/status.ts`'s `StatusRow.state`
docblock — *"the in-box states are facts about the RUN, **read off the in-box completion marker with
`readBoxFile`** and — when that marker is absent — off `systemctl is-active` on the run's unit"* — with
the full vocabulary `ok | not-ok | running | engine-failed | not-running | unknown`, exposed by the
exported `statusRun`/`statusAll`. `src/fleet/run.ts`'s own header says the same: *"The engine's
completion is observed by a DIFFERENT verb (`fleet status`, over the in-box marker)."*

The *conclusion* survives — no host-side **driver** composes completion → harvest → teardown →
reverify → gate, `observeAndDriveChain` returns zero hits in `src/` and `scripts/`, and DF3.7 remains a
hard edge. But the premise as written is false, and it is stated as evidence. Practical cost: a dev
reading it may build a second marker reader instead of consuming the shared
`readMarkerVerdict`/`unitActivity` seams DF3.7 AC2 requires be shared as code.

**Fix:** replace with the narrow true statement — *"nothing host-side **drives the chain** off that
observation: `fleet status` reads the marker (`src/fleet/status.ts`, `readMarkerVerdict`) but composes
nothing, and `src/fleet/run-completion.ts` does not exist."*

### W6-D-M2 — `fixContext.omittedCommentIds` is unbounded on a field with no length check, on the record every `list()` sweep re-reads
**Category: `C2-semantic`** · DF6.1a §Technical Notes, `fixContext` bullet and the "not a document
store" paragraph.

The story bounds the **brief** at 20 comments / 40 000 bytes and records every excluded comment's id in
`omittedCommentIds` **on the record**, then asserts *"the run record carries only IDs and a digest
(INV-7), so it is **bounded independently and by construction**."* It is not. `commentIds` is bounded
at 20 by the same rule; `omittedCommentIds` grows with *every comment past the ceiling*, without limit.
A PR that has accumulated 2 000 bot comments yields ~1 980 ids ≈ 24 KB of JSON in one `"string"`
extension field. Verified in source: `validateExtensions` applies `shedStrings` only to
kind `"strings"`, and `assertNoSecret` applies a length bound (`v.length > 201`) **only** to
`SHAPE_EXEMPT_PATHS` — a `"string"` extension field has no length check at all. The record is re-read
in full by `fleet status` and by every `list()` sweep, which is verbatim the cost the same story cites
as the reason not to store bulk (and which DF6.1b's `list()`-sweep argument leans on).

**Fix:** bound it the way the brief is bounded — cap `omittedCommentIds` at the same 20 and record an
`omittedCount: number` for the remainder, or store only the count. Add the ceiling to the "Test (brief
botComments bound)" DoD leg, which today asserts *"every excluded comment's `commentId` appears in the
record's `fixContext.omittedCommentIds`"* — i.e. it asserts the unbounded behaviour.

### W6-D-M3 — The operator approves the loop's one irreversible act under a prompt that describes a different act
**Category: `C2-semantic`** · DF6.1a §AC2, §Overview.

AC2 requires *"**this attempt** carries its own `ApprovalRecord` (DF3.4) — **requested by DF5.1** on
that green verdict."* Opened `src/reverify/runner.ts:461`: the proposal string is hard-coded

    proposal: `open a PR for run ${runId} at ${report.headSha}`

For a fix run there is no PR to open — the act being authorized is a fast-forward **append onto a
third party's existing PR branch**. The operator's `fleet approve <run-id>` therefore consents to a
prompt that names the wrong action, on the single human decision gate in an otherwise autonomous
loop, and neither half declares an edit to `src/reverify/runner.ts` (DF6.1a's Files to Modify lists
`run-completion.ts` as explicitly *not modified* but says nothing about `runner.ts`).

This is the story's own stated risk model — *"acting on review feedback without ever force-pushing over
a reviewer's history"* — resting on a human reading a sentence that does not describe what will happen.

**Fix:** either declare an adds-only `src/reverify/runner.ts` edit that varies the proposal when the
run carries `extensions.fixLoop.fixContext` (or a brief `fixContext` key), or state explicitly in
Technical Notes that the proposal text is inherited and inaccurate for fix runs, with the operator-facing
consequence recorded and an issue filed. Silence is the one option that leaves it undiscovered.

### W6-D-M4 — DF6.1b introduces `gh` as a new external CLI dependency and never names how it authenticates, while forbidding the only mechanism it has
**Category: `C3-structural`** · DF6.1b §AC1, §Infra Prerequisites rows 1 and 3.

**Evidence.** `grep -rn '"gh"|`gh |gh pr |gh api' --include=*.ts src/ scripts/` returns **zero**
matches. Positive control on the same sweep pattern: `grep -c '"git"' src/pr/push.ts` → 3. So `gh` is
used nowhere in this tree today; every GitHub call goes through `src/pr/github.ts`'s HTTP seam with the
token as a **call argument** (INV-PR-2: *"the token is a call ARGUMENT, never module state, never an
env var and never argv"*).

DF6.1b's Infra Prerequisites row 3 says the host token comes from *"`readHostToken`
(`src/pr/github.ts:176`), **never `process.env.GH_TOKEN`**, never argv, never a box."* But `gh`
authenticates from exactly three places: `GH_TOKEN`/`GITHUB_TOKEN` in its environment, `--with-token`
on stdin at `gh auth login`, or `~/.config/gh/hosts.yml`. Read literally, the row forbids the only
mechanism the specified verdict source has. The story never names a delivery mechanism, and never
states that `gh` must be installed on the host.

The shipped precedent for exactly this problem is one file away and is *not* cited: `push.ts`'s
`gitEnv(token)` puts `QDS_PR_TOKEN` in the **child's** environment only, behind a credential helper,
because a token in argv is readable by `ps`. The analogous statement for `gh` — `GH_TOKEN` set on the
`gh` child's env and on nothing else — is what makes the row's "never `process.env.GH_TOKEN`" true in
the sense the author means (never the *host process's* env) while remaining implementable.

**Fix:** state it. *"`GH_TOKEN` is set on the `gh` child's environment only, from `readHostToken`'s
return — never on this process's environment, never in argv — the same containment `gitEnv` uses in
`src/pr/push.ts`."* Add an Infra Prerequisites row for `gh` being installed and version-floored (the
`bucket` JSON field and `--required` must both be present). Consider whether the two calls belong on
the existing `GitHubApi` seam instead, which would remove the new dependency entirely and give the
tests the same fake-driven seam DF5.2 already ships — the story's own "no box, no spend, exhaustive
termination matrix" argument gets stronger, not weaker, from that.

### W6-D-M5 — The e2e roster named in the DoD has no read-only analyst, so the team shape the story describes cannot be dispatched with it
**Category: `C1-citation`** (with an ownership tail) · DF6.1a §E2E Slice, §Technical Notes "MANDATORY
scope caveat", §DoD e2e item.

The story describes the fix team three times as *"lead + one write-capable fixer + read-only analyst"*
/ *"one write-capable worker, plus a read-only analyst and a verifying lead."* The DoD names the
roster: *"Roster is `config/rosters/roster.yaml`, the only e2e roster."* Opened: that file declares
**two** roles — `lead` (inheriting `defaults.writes: []`) and `fixer` (`writes: ["src/","tests/"]`) —
and its header states *"two roles is the minimum the gate-beside contract exercises."*

AC5's guard passes either way (exactly one write-capable role), so this is not a blocker. But the e2e
demo cannot demonstrate the three-role shape the story asserts, and adding a third role to
`config/rosters/roster.yaml` is an edit to a **shared TIER-2 live fixture** that is not in Files to
Modify and would change what DF1.6/T2's own live tests dispatch.

**Fix:** either drop the analyst from the story's description (the F6 caveat only requires *one*
write-capable worker; the analyst is not load-bearing on any AC), or declare the roster edit and its
blast radius on the T2 live suite. The first is the smaller diff and is what the guard actually tests.

---

## 4. LOW

- **W6-D-L1 (`C1-citation`).** `acquireRunLock` is exported at `scripts/lib/run-lock.ts:934`
  (signature `acquireRunLock(runsDir: string, runId: string, holder = "invocation"): string` — which
  does match DF6.1b's three-argument call). DF3.7 cites `:951` for the not-re-entrant fact; DF6.1b
  quotes that citation as `:952`. The *fact* is real (`run-lock-reentrant`, remediation *"release the
  lock before acquiring it again"*). Separately, and worth carrying into the tracker: **that file
  contains 2 raw NUL bytes**, so every `grep` over it returns nothing for every pattern — a positive
  control on the same file is mandatory for any future assertion about it.
- **W6-D-L2 (`C1-citation`).** DF6.1a calls `resolveRepoEntry` *"(`src/pr/push.ts:347`)"*. `:347` is
  the **call site**; the function is `src/pr/repos.ts:107`, and `DEFAULT_REPOS_FILE = ".factory/repos.json"`
  is at `repos.ts:16`. The "allowlists repositories and base branches, not paths" claim is correct.
- **W6-D-L3 (`C4-marginal`).** INV-2 says branch scoping is *"Enforced by comparing the target ref
  against the repository's default branch before the push."* The shipped enforcement is stronger and
  different: `assertPublishableRef` allow-lists `refs/heads/qds/<name>` with a per-segment grammar, so
  a default-branch target is refused as `target-ref-outside-namespace` and never reaches a
  default-branch comparison. The DoD's *"one targeting the default branch → rejected"* leg passes
  through the shipped guard. Naming a weaker mechanism invites a dev to implement it instead.
- **W6-D-L4 (`C4-marginal`).** *"`issueId` … is also what `createRun` writes into `extensions.budget`,
  the namespace `pushVerifiedSha`'s preflight reads to resolve the repo, refusing `no-repo-slug` … The
  issue ref is therefore load-bearing on the one irreversible action."* The preflight reads
  `record.extensions?.budget?.repoSlug`, not `issueId`. The *practical* conclusion survives (both are
  written by the same admission path and `issueId` is a required BriefSchema field, so a brief without
  it never produces a run at all), but the stated causal chain is not the one in the code.
- **W6-D-L5 (`C4-marginal`).** `attempt` appears in DF6.1a's `fixContext` shape, but its value is
  supplied by DF6.1b (*"the `fixContext.attempt` value handed to DF6.1a's write path"*) and DF6.1a's
  Contract DoD lists only *"`attemptSha`, `commentIds`, `commentsDigest`"*. At DF6.1a's own merge point
  nothing says what `attempt` holds. One clause fixes it: *"at this story's merge point `attempt` is
  always `1`; DF6.1b supplies the value thereafter."*
- **W6-D-L6 (`C1-citation`).** `writes: string[] | null` is at `src/phase-engine/roster/schema.ts:57`
  (the doc comment is `:56`); the refuse-to-infer-from-silence rationale is `:22-25`, not `:22-24`.

---

## 5. Split integrity, orphaned edits, dependency truth, artifact consistency

**Split integrity at the `attemptSha` seam.** The seam itself is clean and well-drawn: DF6.1a owns
everything up to and including the `fixContext` write; DF6.1b begins by reading it; only a JSON payload
on disk crosses. The two-limbed P1.18 severance is genuinely non-redundant and both halves state it
consistently. The `p1-18:50` repoint has exactly one writer (DF6.1a), corroborated by DF5.5's row in
`sprint-status.yaml`. **One seam is unowned: the post-push CI poll call site (W6-D-B1).** That is the
only content I found described by one half and owned by neither.

**Orphaned/undeclared edits.** Four: the PR-comment read (`src/pr/github.ts` — W6-D-H6); the
declared-aggregate ceiling check (`src/fleet/dispatch.ts` — W6-D-H2); the approval proposal text
(`src/reverify/runner.ts` — W6-D-M3); and, conditionally, a third roster role
(`config/rosters/roster.yaml` — W6-D-M5). None appears in either Files to Modify.

**Dependency truth.** DF6.1a's declared edges (DF1.5, DF1.6, DF3.1, DF3.7, DF3.4, DF5.1, DF5.2) match
`sprint-status.yaml:215` exactly. DF6.1b's (DF6.1a, DF5.3) match `:216`. I re-verified the two the
campaign added: `observeAndDriveChain` has **zero** occurrences in `src/`/`scripts/` (DF3.7 unbuilt,
`src/fleet/run-completion.ts` absent), and `src/audit/` does not exist with
`recordAuditLink`/`walkAuditChain` appearing in `src/` only in a comment at
`src/providers/teardown.ts:12` (DF5.3 unbuilt). Both edges are correctly declared and correctly
sequenced. No undeclared *story* edge found; the undeclared edges are all to shipped **code**, listed
above. DF6.1b correctly declines a DF2.12 edge.

**Artifact consistency.** Headers match the tracker on every axis I checked: DF6.1a 4 pts /
`ready-for-dev` / v5-S3 / deps as above; DF6.1b 3 pts / `ready-for-dev` / v5-S3 / deps as above; the
6→4+3 re-point is recorded at `sprint-status.yaml:57` and the slate arithmetic at `:68-69` includes
both. No drift.

**Security invariants.** One-secret-per-box and no-push-credential-in-box are structurally held by
`fill.ts`'s `bundle-push` default and the userinfo refusal — verified, and the story is right that this,
not the probe, is what holds the invariant. `assertNoSecret` is untouched, un-exempted and correctly
analysed. No `sk-or-` appears in either story. The redaction chokepoint is named by exported symbol and
path in both halves and is the correct one. The two real weaknesses are W6-D-H7 (the probe's blind
spot) and W6-D-H4 (INV-7's unsatisfiable pre-flight).

**Ordering (irreversible acts).** I walked every refusal path against the push. AC6's scope check,
AC5's roster guard, the empty-feedback exit, the issue-ceiling check, `assertPublishableRef` and the
whole of `preflight` all run before `pushWithPreflight`'s `git push`. The only validation the stories
place after an irreversible act is the `fixContext` write itself, which is INV-7's subject and is
correctly *ordered* — its defect is that the pre-flight cannot validate the actual value (H4), not that
the order is wrong. DF6.1b's INV-7 application to the escalation comment (validate `fixOutcome` before
posting) is sound, and `GitHubApi.commentIssue` already exists to post it.

---

## 6. Convergence verdict

**NOT CONVERGED.** Confidence: **high**.

Counts — **1 BLOCKER, 8 HIGH, 5 MEDIUM, 6 LOW** (20 findings).
By category — **C1-citation 3, C2-semantic 5, C3-structural 9, C4-marginal 3.**

The distribution is the answer. Fourteen of the top fifteen findings are C2 or C3, and nine are C3:
an AC that cannot be made falsifiable (H4), an AC missing an operand (H5), a poll leg owned by nobody
(B1), a lookup specified in a direction with no index (H1), a refusal code asserted from machinery on
a different code path (H2), a fence that forbids the story's own central call (H3), a trigger with no
owning module (H6), and a mandatory demo blocked by its own gate artifact (H8). None of these is a
line number, and none would be caught by a fourth citation-checking pass — every citation I spot-checked
in these stories was **right**, which is precisely the round-2 pattern repeating one layer deeper.

That said, this is not a rethink-the-split verdict. **The split itself is good** and should not be
re-litigated: the `attemptSha` seam is the right seam, both halves state it identically, the live-spend
separation is real, and only one item (B1) genuinely straddles it. The C3 population is concentrated in
two recurring shapes rather than spread everywhere:

1. **Machinery asserted by name that exists somewhere else, or nowhere** — H2
   (`issue-ceiling-insufficient` is fan-out-only), H6 (`GitHubApi` has no comment reader), H1 (no
   prNumber index), M4 (`gh` used nowhere in the tree). Each is a bounded spec edit plus, in two cases,
   a declared Files-to-Modify entry.
2. **An AC whose proof mechanism cannot exist as written** — H4 (validating a value that does not yet
   exist), H5 (a diff with one endpoint), B1 (a window measured from an event in a different
   invocation). Each is a paragraph, not a redesign.

**Recommendation: one targeted fix pass, not a fourth full round.** Fix B1 and H1–H8 as specified
above — that is roughly fifteen paragraphs across two files plus four Files-to-Modify lines — and
re-verify only those nine seams. The MEDIUMs and LOWs can ride the same pass. I would not gate dev on
the LOWs.

**The three that matter most, if only three get fixed:** **W6-D-B1** (the loop's happy path is
unreachable and both DoDs are green), **W6-D-H6** (the sole trigger has no owner, and the obvious
implementation reds DF5.2's suite), and **W6-D-H5** (a missing diff base turns the correct-refusal
state into a permanent false positive that looks like policy).

**One prior-round fix I believe is wrong, stated plainly:** wave 5b's V-DF6.1b-B3 correctly withdrew
the "one lock, not two" claim and correctly re-keyed the lock onto the parent run — but it then
justified the new key with a lookup that does not exist (`extensions.pr.prNumber` as "DF5.3's hop-1
join", "one indexed lookup"). DF5.3's hop 1 runs PR → runId from the PR body/branch; the record store
has no reverse index and exposes only `list()`. The *conclusion* (key on the parent) is right; the
*mechanism* it rests on is not, and the zero-cost mechanism — the PR head branch **is**
`qds/<parentRunId>` — is already validated elsewhere in DF6.1a.
