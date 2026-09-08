# Scan D — DF6.1: PR Feedback → Bounded Fix Run → CI Green

**Reviewer:** agent D (solo), initial-scan wave, QDS story-review campaign 2026-09-08
**Target:** `_bmad-output/sprint-artifacts/dark-factory-v5/stories/df6-1-pr-feedback-fix-loop.md` (489 lines, 6 pts)
**Story last touched:** 2026-08-25 — six days before the tier-2 placement ADR, and before DF1.10, DF1.11, DF2.10, DF3.5 shipped.
**Method:** ADR + design doc + 8 sibling story files read; every named seam opened in the shipped code; `gh` behaviour measured against a live PR on this repo rather than recalled.

**Counts:** 5 BLOCKER · 7 HIGH · 8 MEDIUM · 6 LOW

---

## Verified-correct elements (SACRED — must not be regressed by any later fix wave)

Each of these was checked against shipped code or measured behaviour and found **right**. Several
are unusually sharp for a spec written six days before the substrate changed.

| # | Element | Evidence |
|---|---|---|
| V1 | **The credential architecture is structurally correct and the story states it correctly.** `fill` mode defaults to `bundle-push`: the HOST fetches the pinned SHA with the host's own git credential helpers, `git bundle`-packs it, and pushes the bundle into the box over exec stdin; the box clones from a local file. `src/providers/exedev/fill.ts:15-17,34-41,401-421`. `repoUrl` is refused if it carries userinfo (`fill.ts:158-165`). The box never needs, and never receives, a git credential — INV-3 and R5 fact 17 hold **by construction**, not by the story's probe. |
| V2 | **`pushVerifiedSha`'s non-default-`targetRef` path is exactly what AC2 describes and it already exists.** `src/pr/push.ts:432-468` (entry, `assertPublishableRef` before preflight so a bad ref never causes a token read), `:475-541` (`pushWithPreflight`: `remoteTip` → fetch tip → `git merge-base --is-ancestor tip headSha` → refuse `not-fast-forward` → non-force `git push <sha>:<targetRef>`). AC2's "append, fast-forward, no force-push, no second PR" is a faithful description of shipped behaviour. |
| V3 | **The PR branch ref survives `assertPublishableRef`.** DF5.2 publishes to `refs/heads/qds/<parentRunId>`; the guard's namespace is `refs/heads/qds/` (`push.ts:37,65-82`). A fix run whose own id differs makes `isDefault` false (`push.ts:484`), which is precisely the fast-forward arm. The story's Trigger-Surface refusal of "a PR whose head branch is not `qds/<run-id>`" is consistent with this and is load-bearing, not cosmetic. |
| V4 | **INV-PR-5 is genuinely un-bypassable and AC2's "up to two approvals across two attempts" is correct.** `preflight` (`push.ts:210-391`) runs on *both* exports; report must be green **at the sha about to be pushed** (`:288-294`), approval must be `approved`, bound to that `reportId` and `headSha`, and `decidedAt >= report.completedAt` (`:296-337`). An approval from a previous attempt provably cannot authorize a later one. |
| V5 | **Webhook-residue check: CLEAN.** Every webhook mention in the story is an explicit out-of-scope declaration (`:107-109`, `:143`, `:18-20` on `:53`'s dead signature clause). No receiver, no endpoint, no signature scheme, no `src/swarmclaw/` path is asked for. P1.18 is correctly declared a non-predecessor (`:65-67`). |
| V6 | **Every ancestry line citation is exact.** Verified by reading the source lines: `p1-19-pi-pair-fix-green.md:29` (fix core), `:30`/`:31` (CI green → terminal), `:32` (bounded attempts + diagnostics), `:39` (guards, incl. the literal "Max 2 fix attempts per PR / 15-minute timeout / same branch / required check"), `:52` (branch scoping), `:53` (webhook signature — correctly declared not carried), `:54` (retry budget). `p1-18-pr-comment-polling.md:36` really is the `botComments: [{ commentId, author, bodySnippet, timestamp }]` shape line. Zero drift. |
| V7 | **The 15-minute re-aim is right and well argued.** P1.19:39 says "each attempt has a 15-minute timeout" over the whole attempt. The story's Technical Note (`:224-236`) re-aims it to the CI-poll window and gives the correct reason: DF3.4 tears the box down at pause and the operator decides on human time, so a single 15-minute timer would abort every fix run at the approval gate. Excluding the approval wait from every budget is correct against `src/fleet/approval-gate.ts`'s pausing → teardown → awaiting-approval shape. |
| V8 | **`attemptSha` sourcing is right.** `pushVerifiedSha` returns `{ ok: true, sha, targetRef, pushed }` where `sha` is `pre.headSha` — the exact sha the preflight bound (`push.ts:453`). Taking it from the return rather than a local `git rev-parse` avoids a real race, as the story says (`:239-243`). |
| V9 | **Rejecting `gh pr checks` as the *SHA-binding* surface is correct.** Measured: `gh pr checks --json` offers only `bucket, completedAt, description, event, link, name, startedAt, state, workflow` — no commit sha. The story's reason for refusing it is factually right. (Its *replacement* is not sufficient either — see **DF6.1-B3**.) |
| V10 | **`src/audit/chain.ts` is the correct file and DF5.3 already anticipates this edit.** `df5-3-audit-chain-extended.md:140` — "DF6.1 (PR-feedback fix loop) extends `src/audit/chain.ts` **additively**" — and DF5.3's own Files-to-Modify lists it (`:168`). Writer and reader agree. |
| V11 | **Briefing item 3 (tokensRows = 0) is still true and the story's guidance is still right.** `ingestCostEvent` has zero non-test callers (`src/providers/cost-ledger.ts:961`; all other hits are tests, comments, or `scripts/qds-cost.ts:396`'s own note). "Budget against `spendMicroUsd`, not token rows" remains correct. |
| V12 | **The instruction-injection posture is right and unusually well reasoned.** The story explicitly says in-box scoping is advisory (a skip-permissions agent controls the box; F10/fact 15) and puts the *enforcing* check host-side on the harvested diff before `pushVerifiedSha` (`:210-215`). That is the correct trust boundary and it matches DF5.2's INV-PR-4 doctrine ("the changed-file list is the host's own `git diff`, not the box's claim", DF5.2 Dev Agent Record). |
| V13 | **`bodySnippet` normalization is correctly specified.** CRLF→LF, strict UTF-8, C0 control characters rejected **other than LF and TAB** (`:202-205`). A real bot review comment is multiline Markdown; a naive "no control characters" rule would reject every legitimate one. The second fixture (legitimate multiline Markdown with CRLF, a code fence and a bullet list) is exactly the right negative control. |
| V14 | **AC5's name-based negative control is a real mutation.** "a fixture whose read-only analyst is named `fixer-2`" kills the obvious wrong implementation. The *counting rule* it prescribes is wrong (**DF6.1-B2**), but the control itself must survive the fix. |
| V15 | **The empty-feedback boundary is right.** Zero bot comments, or comments only on a closed/merged PR → no run, no box, exit `0` (`:123-125`). An empty feedback set is not an error, and it costs nothing. |

---

## Findings

| ID | Sev | Location | One line |
|---|---|---|---|
| DF6.1-B1 | BLOCKER | `df6-1:44-54`, `:62-67`, `:316-321` | Undeclared hard dependency on DF3.7: nothing host-side learns an in-box run finished, so the loop's middle does not exist. |
| DF6.1-B2 | BLOCKER | `df6-1:116-123`, `:348-354` | Single-fixer guard is inverted against the shipped roster type: `writes: null` means **unrestricted**, and the prescribed `writes.length > 0` either throws or scores the most privileged role read-only. |
| DF6.1-B3 | BLOCKER | `df6-1:93-99`, `:142`, `:156`, `:322-326` | `gh pr view --json statusCheckRollup` carries neither requiredness nor `bucket`. Measured. AC3, three DOD items and two tables all name a query that cannot answer the question asked of it. |
| DF6.1-B4 | BLOCKER | `df6-1:185-197`, `:331-334` | `extensions.fixLoop` is *already registered* in shipped code as two `"string"` fields; `FieldKind` has no object kind; and `assertNoSecret`'s prefix scan will brick the record write on ordinary bot-comment content — after an irreversible push. |
| DF6.1-B5 | BLOCKER | `df6-1:110-115`, `:140`, `:248-256`, `:363-364` | The loop has no named driver. Nothing in the story says whether attempt 2 is fired by the same invocation or by the operator, and the two readings produce incompatible, differently-bounded implementations. |
| DF6.1-H1 | HIGH | `df6-1:429-448` | The inherited-seam briefing's central recommendation is now an instruction to violate the ADR: it tells dev to drive pi host-side because "no in-box consumer exists". DF1.10 shipped one. |
| DF6.1-H2 | HIGH | `df6-1:459-471` | The fix brief's `issueId` is a *required* BriefSchema field left unspecified; parent + 2 attempts share one per-issue ceiling and attempt 2 can be refused `budget-exceeded` while each attempt is individually under cap. |
| DF6.1-H3 | HIGH | `df6-1:382-388`, Trigger Surface | The mandatory e2e demo names no file, no tier, no `liveGate` argument, no spend estimate, and no branch-protection/bot-installation setup — against a repo whose live-e2e discipline requires all of them. |
| DF6.1-H4 | HIGH | `df6-1:62-67`, `:126-134`, `:281-282` | DF5.3 is a declared predecessor and is **not shipped**; `recordAuditLink`/`walkAuditChain`/`src/audit/` do not exist. AC6 and one Files-to-Modify entry are unbuildable today. |
| DF6.1-H5 | HIGH | `df6-1:295-301`, `:337-340` | INV-3's credential probe checks two env vars and one git-config namespace and calls that "mechanical". It misses every other credential sink on the box and names a lifecycle seam ("before the brief reaches tier 2") that no longer exists in that shape. |
| DF6.1-H6 | HIGH | `df6-1:110-115` | No classification separating "the fixer refused / failed to spawn" from "the fix was wrong". Post-DF6.2, a dispatch refusal settles the phase FAIL identically to a bad fix — and burns attempt 2 on a deterministic failure. |
| DF6.1-H7 | HIGH | `df6-1:239-247`, `:327-328`, `:368-370` | The story treats `pushVerifiedSha` as "pushes or refuses with nothing pushed". It returns a `PushOutcome` union and has a third arm — `{ ok: true, pushed: false }` when the remote tip already equals the sha — which the story never addresses. |
| DF6.1-M1 | MEDIUM | `df6-1:248-256` | The attempt-budget "atomic compare-and-set on the DF2.1 record" invents a second concurrency primitive beside the per-run invocation lock the rest of the fleet uses. |
| DF6.1-M2 | MEDIUM | `df6-1:188-192`, `:344-347` | A ≤40 000-byte `botComments` payload lands in a run-record extension field with no length bound, re-read in full by every `list()` sweep and `fleet status`. |
| DF6.1-M3 | MEDIUM | `df6-1:76-79` | AC1 asserts `changedFiles` non-empty on the `dispatch_task` envelope. That field is an agent-authored **claim**; DF5.2/INV-PR-4 doctrine is that the host uses its own `git diff`. |
| DF6.1-M4 | MEDIUM | `df6-1:100-104` | The poll window opens at `pushVerifiedSha`'s return, but GitHub does not necessarily have a check run registered at that instant. "Every required check has settled" is trivially true against an empty set for the first N seconds. |
| DF6.1-M5 | MEDIUM | `df6-1:220-223`, `:156`, `:158` | "A PR whose required-check set is empty is refused at attempt start" is stated three times and never given a source, an API call, or a credential scope. |
| DF6.1-M6 | MEDIUM | `df6-1:33-42` | The Overview's chain omits `fleet run` entirely — the verb that actually starts the engine post-DF1.10. |
| DF6.1-M7 | MEDIUM | `df6-1:473-480` | The DF13 fleet-ceiling TOCTOU note is carried forward verbatim from 2026-08-25 and is stale in its citations; `src/fleet/fleet-lock.ts` and `acquireRunLock` both exist now and the story does not say which (if either) covers a second fix attempt. |
| DF6.1-M8 | MEDIUM | `df6-1:404-427` | Briefing item 1's "nothing host-side captures `changedFiles`" is now false, and its OPEN QUESTION about `rank` is answerable and should be closed rather than deferred to dev. |
| DF6.1-L1 | LOW | `df6-1:183-184`, `:276-285` | "This story registers the `fixLoop` sub-key" — it is already registered (`src/providers/run-record.ts:216`), and `src/providers/run-record.ts` is absent from Files-to-Modify. |
| DF6.1-L2 | LOW | `df6-1:451-453` | Cites `src/providers/cost-ledger.ts:786`; `ingestCostEvent` is at `:961` on `dev`. |
| DF6.1-L3 | LOW | sprint-status P1.18 entry | The tracker says v5.0 "polls `gh pr checks` host-side"; the story (correctly) says `gh pr checks` is never the polling query. The tracker note is stale. |
| DF6.1-L4 | LOW | `df6-1:2`, headers | Title says "Bounded Fix Run" (singular) while the story ships a two-attempt loop; every other artefact calls it the fix *loop*. |
| DF6.1-L5 | LOW | `df6-1:269-274` | Observability contract promises `duration` and `exitStatus` per attempt but never names the sub-timings the sibling stories standardised on (`*_ms`, absent-not-zero). |
| DF6.1-L6 | LOW | `df6-1:394-399` | The briefing section is dated, cites a HEAD (`4804765`) many merges stale, and is not marked superseded — a reader has no signal that half of it is now wrong. |

---

### DF6.1-B1 — BLOCKER — undeclared hard dependency on DF3.7 (and, for the unattended claim, DF3.8)

**Location:** `df6-1-pr-feedback-fix-loop.md:44-54` (E2E Slice), `:62-67` (Dependency edges), `:316-321` (DOD).

**Defect.** The E2E Slice describes one uninterrupted chain: `fix-run.ts` → `fleet dispatch` mints and
provisions a box → `dispatch_task` runs the roster → **harvest** → host-side re-verify → `fleet approve`
→ push → CI poll. In the world this story was written for, the phase engine ran host-side, so the
dispatching process *was* the run and "then harvest" was a next statement. Post-ADR and post-DF1.10 that
is no longer true. `fleet dispatch` provisions, clones, fills and runs the setup gate, and stops.
`fleet run <run-id>` starts `qds-run@<runId>.service` and **returns without holding the run**
(`scripts/fleet.ts:2692`, `:2736`; `src/fleet/run.ts:6` — "It never walks a phase, never holds the
run"). Nothing on the host then learns the run finished: `src/fleet/run-completion.ts` does not exist,
`--await-completion` does not exist (grep across `src/` and `scripts/` returns zero hits), and DF3.7's
own Spec Reference states the gap in the same words — *"nothing on the host learns that an in-box run
finished, so nothing triggers harvest → teardown → reverify → gate"* (`df3-7:10`). DF3.7 is
`ready-for-dev` and unbuilt. DF6.1's declared predecessors are DF1.5, DF1.6, DF3.1, DF3.4, DF5.1, DF5.2,
DF5.3 — DF3.7 appears nowhere in the story.

**Failure scenario.** Dev starts DF6.1 against `dev` at `fa7d0e26`. `feedback-run.ts` builds the brief
and calls DF3.1's dispatcher. The dispatcher returns as soon as the box is provisioned and gated. There
is no host-side call that blocks until `/run/qds-run/<runId>/journal/final.json` appears, so
`fix-run.ts` reaches its next step — harvest — against a box whose engine has not been started, let
alone finished. `refs/sandbox/<runId>` resolves to the clone's own head with zero fix commits, `preflight`
refuses `reverify-missing`, and the whole loop dead-ends. The dev's only ways out are (a) implement a
completion observer inside DF6.1 — forking the one chain DF3.7 exists to own, which DF3.7 AC1's import
fence and DF3.8's INV-IBOX-17 both exist to prevent — or (b) stall the story. Either outcome is a
sprint-level failure caused by a missing dependency edge, not by the code.

**Fix recipe.**

1. Add DF3.7 to the dependency edges. Replace `:62-64`'s opening with:

   > **Dependency edges (predecessors):** DF1.5, DF1.6, DF3.1, **DF3.7**, DF3.4, DF5.1, DF5.2, DF5.3.
   > *(DF3.7 is a hard edge, not an inherited one: post-DF1.10 the engine runs in-box and `fleet run`
   > returns without holding the run, so the host learns a fix run has settled only through DF3.7's
   > `--await-completion` observer and its harvest → teardown → `reverify()` composition. This story
   > **calls** that composition and re-implements no step of it — DF3.7's AC1 static import fence is
   > extended verbatim to `src/fixloop/`.)*

2. Rewrite the E2E Slice's middle (`:48-51`) from `→ `dispatch_task` runs the single-fixer roster → harvest →` to:

   > → `fleet run <run-id>` starts `qds-run@<run-id>.service` and returns → `dispatch_task` runs the
   > single-fixer roster **in-box** → the engine writes `/run/qds-run/<run-id>/journal/final.json` →
   > DF3.7's observer reads that marker through `readBoxFile` and drives harvest → teardown → host-side
   > re-verify →

3. Add a DOD line: *"**Impl:** the fix run's completion is observed through DF3.7's composition — `src/fixloop/` imports none of `approval-gate.ts`, `approvers.ts`, `push.ts` or `run-record.ts`'s approval-extension block, asserted by the same grep test DF3.7 AC1 ships."*

4. Sequencing consequence for the tracker: **DF6.1 cannot be scheduled before DF3.7 merges.** DF3.8 is
   *not* a hard edge — the fix loop's trigger is an operator command that can stay attached for the
   dispatch — but note in Technical Notes that a fix run left unobserved lands in DF3.7 AC3's
   `run-completion-unobserved` arm and that DF3.8's sweep is what recovers it.

---

### DF6.1-B2 — BLOCKER — the single-fixer guard is inverted against DF1.5's shipped roster type

**Location:** `df6-1:116-123` (AC5), `:348-354` (DOD "Test (single-fixer guard)").

**Defect.** AC5 says *"a role is write-capable exactly when its `writes` is not the empty array"*, and the
DOD spells the implementation out: *"write-capable ⟺ `writes.length > 0`, evaluated after schema
validation — never `writes !== []`, which compares array references"*. The shipped type is
`writes: string[] | null` and the doc comment at `src/phase-engine/roster/schema.ts:56` reads:

```ts
/** Repo write scope; `null` = unrestricted, `[]` = no repo writes. */
writes: string[] | null;
```

`null` is not a missing value — the schema explicitly refuses to infer it from silence precisely because
it is the widest possible scope (`schema.ts:22-24`, `:272-276`: *"`writes` must be declared explicitly …
the story defines `null` as 'unrestricted repo writes'; inferring that from silence is the one default
here with a blast radius, so it is fail-closed"*). `WritesField = z.array(z.string().min(1)).nullable()`
(`:111`) admits it on every role.

So the prescribed rule is wrong twice over. `writes.length > 0` on `null` throws
`TypeError: Cannot read properties of null`. Written defensively as `(r.writes?.length ?? 0) > 0` — the
obvious repair a dev reaches for — it evaluates **false** for `writes: null`, scoring the *most*
privileged role in the schema as read-only. The guard that exists to keep the F6 caveat honest would
wave through exactly the roster it exists to refuse.

**Failure scenario.** A dev writes `roles.filter(r => (r.writes?.length ?? 0) > 0).length > 1`, ships it,
and every test in the DOD passes: the single-fixer fixture has one `writes: ["src/**"]` fixer and an
analyst with `writes: []`; the two-write-capable fixture has two `writes: [...]` workers and is refused;
the name-based negative control passes. Then an operator authors a fix roster as
`defaults: { writes: null }` with a lead and two workers — the natural way to write "let them work" —
and `feedback-run.ts` counts **zero** write-capable workers, provisions a box, and runs two concurrent
editing agents against one workspace. That is the exact scenario the MANDATORY scope caveat
(`df6-1:162-168`, R5 fact 2) forbids until a concurrent-editing proof exists, reached through the guard
that was supposed to prevent it.

**Second-order note (not a severity reducer, a scoping clarification).** `grep -rn '\.writes' --include=*.ts src/`
returns **no production consumer** — the field is declared and validated but nothing enforces it at
runtime. That is fine and does not change this finding: AC5 is an *admission* guard on the declared
roster, evaluated host-side before a box is billed, and the enforcing check is the host-side
harvested-diff scope comparison the story already specifies (`:210-215`). But the story should say so,
because a reviewer who greps for enforcement will otherwise conclude the guard is decorative.

**Fix recipe.** Replace `:118-123` (from "Write capability is read from") with:

> Write capability is read from **DF1.5's per-role `writes` list** (`src/phase-engine/roster/schema.ts:56`,
> `writes: string[] | null`), whose contract has **three** states, not two: `[]` is *no repo writes*,
> a non-empty array is *scoped writes*, and **`null` is *unrestricted* writes — the widest scope in the
> schema, not an absent value** (`schema.ts:22-24` refuses to infer it from silence for exactly this
> reason). A role is therefore write-capable exactly when `writes !== null ? writes.length > 0 : true` —
> equivalently, when it is **not** the empty array. The count is taken in `src/fixloop/feedback-run.ts`
> **before** the brief reaches DF3.1's dispatcher, so the refusal costs no box. *Negative controls, all
> three MUST fail: an implementation inferring write capability from the role's name or position passes
> the single-fixer fixture and MUST fail a fixture whose read-only analyst is named `fixer-2`; one
> written as `writes.length > 0` throws on a `writes: null` role rather than refusing it; and one
> written as `(writes?.length ?? 0) > 0` scores two `writes: null` workers as zero write-capable
> workers and admits the exact roster this guard exists to refuse.*

And in the DOD, replace the parenthetical `(write-capable ⟺ writes.length > 0, evaluated after schema
validation — never writes !== [], which compares array references and is true for every array)` with
`(write-capable ⟺ writes !== [] — i.e. null OR a non-empty array; null is UNRESTRICTED, not absent,
so neither writes.length > 0 nor writes?.length > 0 is a correct spelling)`, and add a fixture leg:
*"a roster whose two workers both declare `writes: null` → exits non-zero and provisions nothing."*

---

### DF6.1-B3 — BLOCKER — the CI-verdict query cannot answer the question AC3 asks of it

**Location:** `df6-1:93-99` (AC3), `:142` and `:156` (tables), `:322-326` and `:365-367` (DOD).

**Defect.** AC3 mandates `gh pr view <n> --json headRefOid,statusCheckRollup` as the polling query, and
requires two things from it: (a) **requiredness** — "evaluates **required** checks only from
`statusCheckRollup`", "refuses a PR with an empty required-check set"; and (b) a **`bucket`** field —
"`statusCheckRollup`'s per-check state/bucket is trusted for that poll". Measured on this repository
against PR #237:

```
gh pr view 237 --json headRefOid,statusCheckRollup
→ {"headRefOid":"2191578b…","statusCheckRollup":[
     {"__typename":"CheckRun","completedAt":…,"conclusion":"SUCCESS","detailsUrl":…,
      "name":"check","startedAt":…,"status":"COMPLETED","workflowName":"CI"}, …]}
```

There is **no `isRequired` field and no `bucket` field**. `bucket` is documented as a `gh pr checks`
field (`gh pr checks --help`: *"When the `--json` flag is used, it includes a `bucket` field…"`) — the
story imported it from the surface it spent a paragraph rejecting. And requiredness is only reachable
through `gh pr checks --required` (measured: on PR #237 it answers `no required checks reported on the
'fix/df1-11-code-review-round-2' branch`) or through a GraphQL `isRequired(pullRequestId:)` selection,
neither of which `gh pr view --json` exposes.

The story's rejection of `gh pr checks` is *correct* (V9: it carries no per-check sha). But the two
surfaces are individually insufficient in complementary ways, and the story picked one and claimed it
had both properties. Meanwhile the Infra Prerequisites table (`:158`) names a **third** source —
"GitHub required-check configuration | repository branch-protection settings | read at attempt start" —
which contradicts AC3's "only from `statusCheckRollup`" and carries a credential-scope consequence the
story never mentions: the classic branch-protection endpoint (`GET
/repos/{owner}/{repo}/branches/{branch}/protection/required_status_checks`) requires **admin** on the
repository. AC5/INV-PR-* scope the host token to what opening a PR needs; escalating it to repo-admin to
read a required-check list is a credential-boundary decision that must be made deliberately, not
discovered at dev time.

**Failure scenario.** A dev implements AC3 literally: poll `gh pr view --json headRefOid,statusCheckRollup`,
`if (rollup.every(c => c.bucket === "pass")) → green`. `bucket` is `undefined` on every entry, so
`every(...)` is false forever, and every fix attempt burns the full 15-minute window and escalates
`ci-verdict-unavailable` — a loop that can never report green. The equally natural repair — filter on
`conclusion === "SUCCESS"` over *all* checks — silently drops the requiredness distinction `:39` carries
verbatim from P1.19, so an advisory lint check going red now blocks a fix whose required checks are all
green, and a `SKIPPED` optional job is scored as non-green. Neither behaviour is caught by any DOD test,
because no DOD test exercises a PR with a mixed required/non-required check set.

**Fix recipe.** Split the two questions across the two surfaces and bind them with `headRefOid` read on
both sides of the window. Replace AC3's query sentences (`:93-99`) with:

> Then the host **polls every 30 seconds** until every required check has settled, reading two
> host-authenticated `gh` calls per poll because **neither surface alone carries both facts**:
> `gh pr view <n> --json headRefOid` supplies the PR's current head commit sha (`gh pr checks` exposes
> no per-check commit sha and so cannot prove a green belongs to this attempt), and
> `gh pr checks <n> --required --json name,state,bucket` supplies the required-check set with its
> settled `bucket` (`gh pr view --json statusCheckRollup` carries **no** requiredness marker and **no**
> `bucket` — measured 2026-09-08 against this repository: its per-entry fields are
> `__typename, completedAt, conclusion, detailsUrl, name, startedAt, status, workflowName`). The
> `headRefOid` read is taken **before and after** the checks read and both must equal the recorded
> **attempt SHA**; any inequality means a newer commit landed on the branch mid-poll and the whole poll
> result is discarded before any state transition (INV-4). `gh pr checks --required` answering
> "no required checks reported" is the empty-required-set refusal of the Guards note — never a green.

Then change the Infra Prerequisites row `:158` from "repository branch-protection settings" to
`gh pr checks <n> --required` **from the host, requiring no branch-protection read and therefore no
repo-admin token scope`, and update `:142`, `:156`, `:322-326` and `:365-367` to the two-call shape.
If the operator prefers one round trip, the alternative is a single `gh api graphql` query selecting
`headRefOid` and `statusCheckRollup { contexts { … isRequired(pullRequestId: $id) } }` — state that as
the sanctioned alternative rather than leaving the dev to discover it.

---

### DF6.1-B4 — BLOCKER — `extensions.fixLoop` is already registered, with a shape the story contradicts, in a validator that will brick on real comment text

**Location:** `df6-1:183-197` (Contracts/Schema), `:331-334` (DOD Contract), `:276-285` (Files to Modify).

**Defect, three parts.**

*(a) The namespace already exists and its declared shape contradicts the story.*
`src/providers/run-record.ts:215-216` ships:

```ts
/** DF6.1 */
fixLoop: { schemaVersion: 1, fields: { fixContext: "string", fixOutcome: "string" } },
```

The story specifies both as **objects** — `fixContext: { prNumber, prBranch, attemptSha, botComments: [{…}], omittedCommentIds: string[], attempt }` and
`fixOutcome: { prNumber, attempts, outcome, runIds: string[] }`. `FieldKind` is
`"string" | "int" | "ports" | "strings"` (`run-record.ts:54`) — **there is no object kind** — and
`assertKind` throws `schema-rejected: extensions.fixLoop.fixContext must be a string` on any object
(`run-record.ts:744-748`). Under the drift rule (shipped code wins where it is ADR-consistent, and this
is a DF2.1 contract with no ADR bearing), **the spec is wrong**: the two payloads must be stored as
JSON-encoded strings, or the story must own an explicit, argued extension of `FieldKind` — which is a
change to DF2.1's closed core validator, a file DF6.1's Files-to-Modify does not list at all.

*(b) The secret scan runs on the whole payload and will throw on ordinary bot-comment content.*
Every extension write routes through `assertNoSecret` (`run-record.ts:685-739`), whose prefix scan is
`(^|[^A-Za-z0-9])<prefix>` over the value, with `SECRET_PREFIXES` including `sk-`, `sk_live_`, `ghp_`,
`gho_`, `ghs_`, `ghu_`, `ghr_`, `github_pat_`, `xoxb-`, `xoxp-`, `xapp-`, `xoxa-`
(`run-record.ts:569-589`), and `-----BEGIN`. A JSON-encoded `fixContext` carrying up to 40 000 bytes of
bot review comment bodies is *exactly* the kind of value that trips it: a CodeRabbit security finding
routinely quotes the offending line, and the offending line is routinely a token literal or a PEM header.
`extensions.fixLoop.fixContext` is not in `SHAPE_EXEMPT_PATHS` (`:637-649`), and even the exemption only
suppresses the shape heuristic, never the prefix scan (`:713`).

*(c) The failure lands after an irreversible action.* The story is emphatic that `fixContext` is written
**once, after `pushVerifiedSha` returns** (`:243-247`) — "not before, and not in two steps". So the
sequence is: push lands on the reviewer's PR branch → `store.set` throws
`refusing to write key material into the run record: extensions.fixLoop.fixContext` → the attempt has no
record. This is the same class of defect DF5.2's own round 16 had to name and handle
(`record-write-after-publication`, DF5.2 Dev Agent Record) — and DF6.1 reproduces it without the handling.

**Failure scenario.** CodeRabbit comments on a factory PR: *"Hardcoded credential on line 42:
`const key = "sk-proj-abc123…"` — move this to an environment variable."* The operator runs
`bun scripts/fix-run.ts --pr 44`. The comment is normalized, passes the CRLF/UTF-8/C0 validation
(it is legitimate Markdown), enters `botComments`, and the fix run correctly removes the hardcoded key.
Re-verify is green, the operator approves, `pushVerifiedSha` appends the fix to the PR branch — the
outward-facing, irreversible act. Then the `fixContext` write throws on `sk-`. The attempt has no
`attemptSha` on disk, so AC3's SHA-bound poll has nothing to bind to, AC6's `runIds` aggregate never
lists this run, and AC4's escalation path — which the story says "does not depend on one" — is now the
only thing left, escalating a fix that actually **succeeded**.

**Fix recipe.** Rewrite `:183-197`'s opening and add a paragraph:

> **Contracts/Schema:** step output is unchanged from v5 §5.2. The `fixLoop` sub-key on DF2.1's
> versioned `extensions` namespace is **already registered** (`src/providers/run-record.ts:216`:
> `fixLoop: { schemaVersion: 1, fields: { fixContext: "string", fixOutcome: "string" } }`); this story
> does not register it and does not change its kinds. `FieldKind` has no object kind
> (`run-record.ts:54`), so **both payloads are stored JSON-encoded as `"string"` values** and this
> story owns their *encoded* shape (`schemaVersion: 1`), validated by `src/fixloop/`'s own parser on
> read and write. DF2.1's twelve-field core and its `FieldKind` set stay closed and unchanged.
>
> **The secret scan is a real failure mode on this field, not a theoretical one, and it is handled
> before the encode, never after the push.** Every extension write passes `assertNoSecret`
> (`run-record.ts:685-739`), whose prefix scan runs on the whole value against `SECRET_PREFIXES`
> (`sk-`, `ghp_`, `ghs_`, `github_pat_`, `-----BEGIN`, …). A bot review comment quoting a credential
> literal — the single most common shape of a security review comment — would throw out of
> `store.set`. So every `bodySnippet` is passed through the **same** `redactSecrets` boundary DF5.2
> uses (`cli-anything/src/redact.ts`) at normalization time, before it enters `botComments`, and the
> encoded `fixContext` is asserted secret-scan-clean by the writer before `store.set` is called. A
> snippet that still trips the scan is **dropped** and its `commentId` recorded in `omittedCommentIds`
> exactly like an over-ceiling comment — a dropped quote is a reporting gap; a throw after
> `pushVerifiedSha` returns is a published commit with no attempt record.

Add to Files to Modify: `src/providers/run-record.ts` — *no change expected; listed because the
`fixLoop` registry entry is read, and a change to it would be a DF2.1 core edit requiring its own
justification.* Add a DOD line: *"**Test (comment-content secret scan):** a fixture whose bot comment
body quotes `sk-proj-…` and one quoting `-----BEGIN RSA PRIVATE KEY-----` are redacted before encoding;
the `fixContext` write succeeds; the offending `commentId`s appear in `omittedCommentIds` if the
redacted form is unusable; an implementation that encodes the raw snippet MUST fail with
`refusing to write key material into the run record`."*

---

### DF6.1-B5 — BLOCKER — the loop has no named driver, and the two readings are incompatible

**Location:** `df6-1:110-115` (AC4), `:140` (Trigger Surface), `:248-256` (attempt bookkeeping), `:363-364` (DOD).

**Defect.** AC4 opens *"Given attempt 1 left a required check red, **When the run re-dispatches**, Then
attempt 2 increments `fixContext.attempt`…"* — an agentless passive that never says **who** re-dispatches.
The Trigger Surface (`:140`) says `bun scripts/fix-run.ts --pr <n>` is *"the **sole** trigger (DD-1: the
operator is the channel)"*. The attempt-bookkeeping note (`:248-256`) describes two *concurrent
invocations* CAS-ing the attempt counter, which only makes sense if each attempt is its own invocation.
The DOD says *"Two failed attempts → no third dispatch"*, which reads as one process counting to two.
These are not compatible, and the two implementations they license differ in every dimension the brief
asked me to bound:

*Reading A — one invocation drives both attempts.* `fix-run.ts` blocks across: dispatch → in-box run
(DF3.1's run budget) → harvest → re-verify (DF5.1, 30 min) → **approval wait, explicitly excluded from
every budget because "a human decides on human time"** (`:229-232`) → push → 15-min CI poll → and then
all of that again. A single CLI process is now expected to stay alive across two human decisions of
unbounded duration. It would hold `fleet dispatch`'s per-run invocation lock (`scripts/fleet.ts:1976`,
`:4257`) for the whole time. It contradicts DF3.7/DF3.8's entire design posture — *"a verb and not a
process: one bounded pass, a typed exit, no PID file, … nothing that stays resident"* (`df3-8:81`).

*Reading B — the operator re-invokes for attempt 2.* Then AC4's "When the run re-dispatches" is the
operator's second `--pr` invocation; the CAS note is coherent; the process shape matches DF3.8's. But the
story's own dedup rule then blocks it: *"Re-running `scripts/fix-run.ts --pr <n>` against comments
already recorded for a prior attempt starts no run; the dedup is atomic by comment ID before dispatch"*
(`:249-251`). If CI went red on the *same* bot comments, attempt 2 has no new comment IDs and the dedup
refuses it — the failure path AC4 requires is unreachable. And AC4's "carries attempt 1's CI failure
output" implies the second invocation reads attempt 1's diagnostics from somewhere the story never names.

**Failure scenario.** Two devs implement two different stories. Dev A ships Reading A; the first live
round hangs for 40 minutes at the approval gate holding the run lock, `fleet status` and every other
run-scoped verb refuse exit-5 against that run, and the operator SIGINTs the CLI — leaving a stale lock
file, a live billing box, and an unobserved run. Dev B ships Reading B; the budget-exhaustion DOD test
passes on a fixture with fresh comment IDs per attempt, and in production the second invocation against
a still-red PR exits `0` "no new comments" and the loop silently never reaches attempt 2 or the
escalation — the exact "stopping silently" AC4 forbids.

**Fix recipe.** Choose Reading B (it is the only one consistent with DD-1, with DF3.7/DF3.8's verb
discipline, and with an approval wait that is outside every budget) and say so in three places.

Trigger Surface `:140` — append: *"one invocation drives **at most one attempt**; the operator's next
invocation drives the next."*

AC4 `:110-115` — replace the opening with:

> **(failure path)** Given attempt 1 left a required check red **or ended in any non-green terminal
> state (`ci-verdict-unavailable`, `approval-timed-out`, a `dispatch_task` refusal per DF6.2, or an
> `out-of-scope-diff` refusal)**, When the operator re-invokes `bun scripts/fix-run.ts --pr <n>`, Then
> that invocation reads the PR's recorded attempt state from the DF2.1 run records keyed by PR number,
> observes `attempt = 1` with a non-green outcome, and dispatches attempt 2 with
> `fixContext.attempt = 2` carrying attempt 1's CI failure output and runId. **The comment-ID dedup does
> not apply to a re-attempt on an unchanged comment set**: dedup refuses a *fresh first attempt* on
> comments already fixed, never a *retry* of a recorded failed attempt — an unchanged comment set is
> precisely what a retry is for. And given two attempts have failed, When the retry budget is exhausted
> (`:32`, `:54`), Then a third invocation dispatches **nothing**, exits non-zero, records the failure
> with `(error log, diff attempted, CI failure messages)`, and **escalates to a human** — a comment on
> the PR carrying that diagnostic set plus the runIds — rather than stopping silently.

Technical Notes `:248-256` — add a first sentence: *"**One invocation, one attempt.** `fix-run.ts` is a
bounded, exiting invocation in the shape DF3.8 fixed for `fleet observe`: it drives a single attempt to a
terminal state and exits. It never blocks across an approval decision, never holds the per-run invocation
lock across a human wait, and ships no daemon, no PID file and no `--loop` flag. The loop is two
invocations, bounded by the attempt budget on the record."*

DOD `:363-364` — replace with: *"**Test (budget exhaustion):** two recorded failed attempts → a third
invocation dispatches nothing, provisions no box, exits non-zero, and posts the escalation with all four
diagnostic elements; a first invocation on a PR with no recorded attempt dispatches attempt 1; a second
invocation against an unchanged comment set with a recorded failed attempt 1 dispatches attempt 2 —
an implementation whose comment-ID dedup refuses the retry MUST fail this test."*

---

### DF6.1-H1 — HIGH — the inherited-seam briefing now recommends an ADR violation

**Location:** `df6-1:429-448` (briefing §2, "Manifest phase execution on a box has NEVER been proven live").

**Defect.** The section states as ground truth that *"NO in-box consumer executed its phases — the test
header records the gap verbatim ('no in-box consumer of the delivered pipeline.yaml exists today'…; box
image has no node/bun)"*, and concludes: *"This story MUST NOT assume a manifest-phase executor will run
the single-fixer team in-box. Two honest options: (a) build/prove an in-box manifest executor inside this
story's slice, or (b) drive pi the way TIER-2 did. **(b) is recommended**."*

Every premise is now false. The ADR's substrate probe measured bun installable and persistent and pi a
compiled ELF standalone in-image (ADR `:69-84`); DF2.10 shipped a digest-pinned image carrying bun and
the pi ELF; DF1.10 shipped the in-box phase engine with `fleet run` starting `qds-run@<runId>.service`
and `tests/fleet/e2e/tier2-in-box-engine.live.test.ts` proving it live. Option (a) is *done, by another
story*. Option (b) — the host driving the pi worker argv into the box — is the **shipped host-side
placement the ADR classifies as "a silent, unratified deviation"** and unwinds.

**Failure scenario.** A dev opens the story, reads the Dev Agent Record for bearings (the normal move —
and precisely the "bearings-check" behaviour that motivated this campaign), finds a **recommendation**
under a "Ground truth for everything below" header, and builds `feedback-run.ts` to exec pi from the host
into the box. It works; TIER-2 proved that path live. It also puts tier 2 back on the host for fix runs
only, re-forking the arc three landed stories just unwound, and no AC in the story tests locality — the
identical blind spot the ADR's forensics records for DF3.3 (*"seven review rounds (~260 findings) missed
it: e2e tests ran a fake pi on the host and no AC tested locality"*, ADR `:46-48`).

**Fix recipe.** Do not delete the section — it is a real record. Mark it superseded and invert the
recommendation. Replace `df6-1:441-448` (from "This story MUST NOT assume") with:

> **SUPERSEDED 2026-09-08 by the ADR arc.** Every premise above was true at `4804765` and is false now:
> the 2026-08-31 probe measured bun installable and persistent in-box and pi as a compiled ELF standalone
> (ADR §The substrate); **DF2.10** shipped the digest-pinned image carrying both; **DF1.10** shipped the
> in-box phase engine — `fleet run <run-id>` starts `qds-run@<runId>.service`, the engine walks the
> manifest in-box, and `tests/fleet/e2e/tier2-in-box-engine.live.test.ts` proves it on a real box.
> Option (a) is **done, by DF1.10**, and option (b) — the host exec'ing the pi worker argv into the box —
> is the host-side placement the tier-2 ADR classifies as a silent, unratified deviation and unwinds.
> **This story MUST drive the single-fixer team through DF1.10's in-box engine and MUST NOT exec pi from
> the host.** Two facts from the original briefing survive unchanged and still bind: harvest counts
> COMMITS on `sbx/<runId>`, so work products must be committed in-box pre-harvest or the bundle never
> materializes; and the engine's structured reply needs a host-side capture point — which DF1.10 supplied
> (the harvest tar carries trace.db + journal + resident artifacts), closing the third original gap too.

Add a header line at `:394`: `### 2026-08-25 — Inherited-seam briefing from DF3 TIER-2 e2e (PARTIALLY SUPERSEDED 2026-09-08 — read the per-item notes)`.

---

### DF6.1-H2 — HIGH — the fix brief's `issueId` is required and unspecified, and the budget arithmetic is left to dev

**Location:** `df6-1:459-471` (briefing §4, F15 budget rule).

**Defect.** The briefing states the arithmetic correctly and then leaves the decision open: *"OPEN
QUESTION: which issueId the fix brief pins — the parent PR-producing run's issueId (then parent + fixes
share one ceiling) or a fresh one? Unspecified in this story today; decide at dev time because it decides
whether the loop fits the default ceiling."* An open question that decides whether the story's main path
works is not a dev-time detail — it is an unwritten AC.

Two things sharpen it against shipped code. First, `issueId` is a **required** field on DF3.1's brief
schema — `issueId: z.number().int().positive().max(MAX_ISSUE_ID)` with no `.optional()`
(`src/fleet/brief-schema.ts:305`) — so "leave it out" is not an available answer. Second, the choice has
a *push-path* consequence, not merely a budget one: `pushVerifiedSha`'s preflight reads
`record.extensions?.budget?.repoSlug` and refuses `no-repo-slug` as a **security event** if it is absent
(`src/pr/push.ts:340-346`), and `extensions.budget` is written by `createRun` from the dispatch's issue
ref (`src/providers/run-record.ts:220-238`). The issue ref is therefore load-bearing on the one
irreversible action in the loop.

**Failure scenario.** Dev pins the parent run's issueId, which is the natural reading of "the loop is one
unit of work". The parent PR-producing run already spent, say, 60% of the issue's ceiling. Attempt 1's
admission clamps to the remaining headroom and runs under-capped; attempt 2's `admitIssue` computes
`capMicroUsd − spentMicroUsd − reservedMicroUsd ≤ 0` and refuses — so the failure path AC4 exists to
exercise never fires as a *fix* failure, it fires as a budget refusal with a message about ceilings, and
the operator sees `budget-exceeded` on a PR whose fix was one prompt away. The DOD's budget-exhaustion
test uses a fixture ledger and passes either way.

**Fix recipe.** Decide it in the spec. Add to Technical Notes, after the guards/limits block:

> - **The fix brief pins the parent run's `issueId`, and declares the loop's aggregate.** `issueId` is a
>   required BriefSchema field (`src/fleet/brief-schema.ts:305`) and it is what `createRun` writes into
>   `extensions.budget` — the namespace `pushVerifiedSha`'s preflight reads to resolve the repo, refusing
>   `no-repo-slug` as a security event when it is absent (`src/pr/push.ts:340-346`). A fix run pins the
>   **parent** run's `issueId` so the PR, the parent run and every fix attempt aggregate on one identity
>   and DF5.3's chain joins them on the key it already uses. The cost of that choice is stated rather
>   than discovered: parent + up to 2 attempts accumulate on **one** per-issue ceiling, so the fix run's
>   admission declares its aggregate the way F15 makes fan-out declare its own — `perIssueOverrides` for
>   that issue must cover `parentSpend + 2 × perAttemptCap` before attempt 1 is dispatched, and an
>   insufficient ceiling refuses at exit 5 `issue-ceiling-insufficient` **before any box is provisioned**,
>   naming the exact `perIssueOverrides` line. No silent raises.

Add a DOD line: *"**Test (issue-ceiling declaration):** a fix dispatch whose parent issue ceiling is
below `parentSpend + 2 × cap` refuses exit 5 `issue-ceiling-insufficient` naming the `perIssueOverrides`
line, with nothing provisioned and no ledger row written; a sufficient ceiling admits attempt 1 and
leaves headroom for attempt 2."*

---

### DF6.1-H3 — HIGH — the mandatory e2e demo has no path, no tier, no gate, no spend estimate and no environment

**Location:** `df6-1:382-388` (DOD e2e demo), Trigger Surface `:138-146`.

**Defect.** The DOD's MANDATORY e2e demo describes a full live round — a real factory PR, a real bot
comment, a real box, a real approval, a real push, real CI — and names **no test file**. The Trigger
Surface's E2E Test column lists only `tests/fixloop/{cli,feedback-run,ci-status}.test.ts`, which are
fake-driver unit suites by their paths. Every sibling story in this campaign names its live file and its
tier (`df3-7:113` → `tests/fleet/e2e/tier3-run-completion.live.test.ts`; `df3-8:130` →
`tests/fleet/e2e/tier3-observe-detached.live.test.ts`).

The repo's live-e2e discipline (`.claude/skills/qds-live-e2e/SKILL.md`) requires, for any tier ≥ 2 run:
a `liveGate("2")` call (the filename prefix is explicitly *not* the gate — "read the call, not the
name"), `test.todoIf(!process.env.QDS_E2E_LIVE)`, a printed worst-case estimate (keys × cap + box-hours)
and an explicit operator "go" **before** the run, every minted key revoked in `finally`, every box
destroyed in `finally`, and a `final-ls` assertion of zero `qds-*` boxes. None of this appears in DF6.1.

The unestimated cost is not small. The demo as written needs: 1 box + 1 capped key for attempt 1 (~50 000
µ$/key + box-hours, per the tier-2 row); a disposable GitHub repository with **branch protection
configured to make at least one check required** (without it, AC3's empty-required-set refusal fires and
the demo cannot reach green); the repository's review bot installed and bound to the allowlist entry's
`authorLogin` (`:155` names this correctly but never says who provisions it); a real CI workflow that
actually goes red and then green; and — if the AC4 failure-path leg is also to be demonstrated live —
a **second** box, a second key, and a second operator approval. The story's own Infra Prerequisites row
`:155` requires the PR under test to carry a real comment from the bound bot, which means waiting on a
third-party service inside a paid round.

**Failure scenario.** Dev reaches the DOD's last line with a green unit suite and no idea where the live
test goes, what gate it calls, what it costs, or how to make a required check exist on a throwaway repo.
The likely outcome is the failure mode the skill file was written to prevent: a `tier1-`-prefixed file
calling `liveGate("2")` that runs under a tier-1 glob, or a "live" demo run against
`Quantum-Digital-Solutions/QDS-Factory` itself — an autonomous fix loop pushing to the factory's own PRs.

**Fix recipe.** Replace `:382-388` with:

> - [ ] **Test (e2e demo — MANDATORY):** `tests/fleet/e2e/tier3-fix-loop.live.test.ts` (new), calling
>       `liveGate("2")` under `test.todoIf(!process.env.QDS_E2E_LIVE)` like every other live file, against
>       a **disposable** repository — never `QDS-Factory` itself — provisioned with (i) branch protection
>       marking one fast CI check **required**, (ii) the review bot installed and bound to the allowlist
>       entry's `authorLogin`, and (iii) a PR produced by DF5.2 under that `authorLogin` carrying a real
>       comment from that bot. `bun scripts/fix-run.ts --pr <n>` → one fix run → host-side re-verify green
>       → `fleet approve <run-id>` records this attempt's `ApprovalRecord` → appended commit on the PR
>       branch → the two-call SHA-bound poll (AC3) observes the required check turn green → terminal
>       success with `attempts: 1`, evidenced by the PR on GitHub and the run's trace rows. **Spend
>       protocol (non-negotiable, `.claude/skills/qds-live-e2e/SKILL.md` §Hard rules 2):** worst case is
>       **1 box + 1 capped key ≈ 50 000 µ$ + box-hours** for the green leg; the AC4 two-attempt failure
>       leg costs a **second** box, a second key and a second operator approval and is therefore
>       **unit-tested against a fake driver, not run live** — the live demo proves the green path once.
>       The estimate is printed and an explicit operator "go" taken before the round; every key is revoked
>       and every box destroyed in `finally`, and the round asserts `final-ls` shows zero `qds-*` boxes.
>       The disposable repository is deleted afterwards, tracked as its own issue the way DF5.2 tracked
>       `qds-df52-e2e` (#133).

Add a Trigger Surface row: `| the real fix loop end to end on a real box against a disposable repo (DOD e2e) | in-scope | tests/fleet/e2e/tier3-fix-loop.live.test.ts | — |`.

---

### DF6.1-H4 — HIGH — DF5.3 is a declared predecessor and is not shipped; AC6 is unbuildable today

**Location:** `df6-1:62-67`, `:126-134` (AC6), `:281-282` (Files to Modify), `:355-360` (DOD).

**Defect.** AC6 extends `recordAuditLink` and `walkAuditChain`, and Files-to-Modify edits
`src/audit/chain.ts` "adds only". Verified: `src/audit/` does not exist, and `recordAuditLink` /
`walkAuditChain` appear in `src/` exactly once — in a **comment** (`src/providers/teardown.ts:12`,
"DF5.3 adds a `recordAuditLink` emit at the already-existing teardown/reap"). DF5.3 is one of the seven
`ready-for-dev` stories in *this same campaign*.

The story's dependency edge is correct (DF5.3 is declared). The problem is a sequencing one that the
campaign's own dependency-pairing plan mis-states: the tracker's Agent-D row reads *"Deps all shipped
(DF5.2). Solo."* — which is not true. DF6.1 has **two** unbuilt hard dependencies once DF3.7 is added
(DF6.1-B1), and DF5.3 is owned by agent B in the same wave, so both stories are moving under each other.

**Failure scenario.** DF6.1 is scheduled first because "its dep is shipped". Dev cannot satisfy AC6 or
the audit-chain DOD test, writes a stub, and the story ships with a `TODO: wire later` in an audit path —
violating campaign ground rule 4 and the story's own "no stub, no `TODO: wire later`" wiring claim
(`:56-58`).

**Fix recipe.** No story text change is needed for the edge itself (it is already declared). Add one
sentence to the dependency-edges paragraph at `:65` making the sequencing explicit, and flag it to the
parent for the tracker:

> *(DF5.3 is **not yet built** as of 2026-09-08 — `src/audit/` does not exist and `recordAuditLink` /
> `walkAuditChain` appear nowhere in `src/`. AC6 and the `src/audit/chain.ts` edit are unbuildable until
> DF5.3 merges, so DF6.1 is sequenced strictly after it. DF5.3's own Technical Notes already anticipate
> this edit — `df5-3:140`, "DF6.1 … extends `src/audit/chain.ts` **additively**" — so the writer↔reader
> contract is agreed; only the ordering is at issue.)*

**Tracker correction owed to the parent:** the Agent-D pairing row's *"Deps all shipped (DF5.2)"* is
wrong on two counts (DF3.7 undeclared-and-unbuilt, DF5.3 declared-and-unbuilt). DF6.1 is the **most
dependency-blocked** story in the campaign, not the least.

---

### DF6.1-H5 — HIGH — INV-3's credential probe is a narrow check sold as a mechanical guarantee

**Location:** `df6-1:295-301` (INV-3), `:337-340` (DOD Security).

**Defect.** INV-3 says the abort is *"mechanical, not decorative"* and specifies exactly two checks:
`git config --get-regexp '^credential\.'` must return empty, and `GH_TOKEN`/`GITHUB_TOKEN` must be unset.
Against the real box surface that is a small fraction of the credential sinks a git or `gh` push would
read: `~/.git-credentials` (the store helper's file — reachable *without* a `credential.*` config entry
if a global config outside the probed scope names it), `~/.netrc` / `~/.config/git/credentials`,
`~/.config/gh/hosts.yml` (`gh`'s own token store, which `GH_TOKEN` being unset does nothing about),
`GH_ENTERPRISE_TOKEN`, `GITHUB_API_TOKEN`, an `insteadOf` rewrite pointing at an authenticated remote,
and a forwarded ssh agent socket (`SSH_AUTH_SOCK`). It also probes the box environment as the *probing
exec* sees it, which is not necessarily the environment `qds-run@<runId>.service` runs under — systemd
units get their own environment.

Separately, the seam is named against the old lifecycle: *"after DF2.2's setup gate returns ready and
**before the brief reaches tier 2**"*. Post-DF1.10 tier 2 is *in* the box, and the seam that exists is
between `fleet dispatch` (provision → clone → fill → setup gate) and `fleet run <run-id>` (start the
unit). The story never names it, so a dev has to guess where the probe hooks.

**Severity reasoning — why HIGH and not BLOCKER.** The actual containment is structural and already
holds (V1): `bundle-push` means the host authenticates and the box receives a bundle file, so no
credential is ever delivered. The probe is defence-in-depth. But the DOD ships a **test** for it
(`:337-340`), and a passing test on two checks reads as "the box is credential-free" when it proves only
"these two sinks are empty" — a false-green about the story's highest-severity invariant.

**Fix recipe.** Rewrite INV-3's second half (`:297-301`) as:

> The abort is mechanical, not decorative, and its scope is stated rather than implied. This story's
> dispatch preflight runs one credential probe on the provisioned box **between DF2.2's setup gate
> returning ready and `fleet run <run-id>` starting `qds-run@<run-id>.service`** — the seam the in-box
> engine placement creates, and the last point at which no agent-authored code has run. The probe asserts,
> in the environment the run unit will inherit: `git config --show-origin --get-regexp '^credential\.'`
> empty; no readable `~/.git-credentials`, `~/.netrc` or `~/.config/gh/hosts.yml`; `GH_TOKEN`,
> `GITHUB_TOKEN`, `GH_ENTERPRISE_TOKEN`, `GITHUB_API_TOKEN` and `SSH_AUTH_SOCK` all unset; and
> `git config --get-regexp '^url\..*\.insteadof'` empty. A hit on **any** of them aborts the run and
> tears the box down, so no agent-authored code ever runs in a box that could push. **What the probe is
> and is not:** it is defence in depth on top of the structural containment, which is what actually
> holds the invariant — `fill` defaults to `bundle-push`, where the HOST fetches the pinned SHA with the
> host's own credential helpers and pushes a `git bundle` into the box over exec stdin
> (`src/providers/exedev/fill.ts:15-17,34-41`), and `repoUrl` carrying userinfo is refused before any
> command runs on either side (`fill.ts:158-165`). The box holds exactly one secret — the spend-capped,
> per-run, revocation-verified LLM key at `$HOME/app/.env` (0600).

Update the DOD security line to enumerate the same sinks and add: *"a test that plants
`~/.git-credentials`, one that writes a `gh` hosts.yml, and one that sets `GH_ENTERPRISE_TOKEN` each
abort the run before the unit starts — an implementation probing only `GH_TOKEN`/`GITHUB_TOKEN` and
`credential.*` MUST fail all three."*

---

### DF6.1-H6 — HIGH — refusals and non-success classifications are not distinguished from "the fix was wrong"

**Location:** `df6-1:110-115` (AC4). DF6.2 and DF1.3 are cited nowhere in the story.

**Defect.** DF6.2 shipped: a `dispatch_task` phase whose body returns a non-success `exitStatus` — every
refusal (AC5 `QDS_TEAM_RUNNER`, missing provider keys, INV-5 roster/task, empty `QDS_RUN_ROOT`,
unreadable/under-provisioned roster, dual-gate rejection, manifest-schema refusal, manifest-dir failure)
plus every classified `transient`/`lead_failure`/`logic` run — now settles the phase **fail** and the run
`ok:false`/exit 1 (`df6-2:37-48`). DF6.1's AC4 has exactly one failure input — *"attempt 1 left a
required check red"* — and one response: burn an attempt. It never mentions DF6.2, DF1.3, or the
five-value `exitStatus` enum.

That collapses three genuinely different things into one budget:

1. **The fix was wrong** — the run executed, produced a diff, pushed, CI went red. Retrying is rational.
2. **The fixer refused to spawn** — a `logic` refusal. Deterministic. Retrying spends a second box on a
   guaranteed identical failure and then escalates having proven nothing.
3. **A transient failure** — `transient` per DF1.6's classification, and DF1.3 already owns separately
   bounded parse and gate retries *inside* the run. Retrying at the loop level double-counts against a
   budget DF1.3 already spent.

**Failure scenario.** The fix roster references a provider key that was never minted for this issue.
Attempt 1's `dispatch_task` refuses; DF6.2 settles the phase fail; the run ends `ok:false`. DF6.1 reads
"not green" and dispatches attempt 2 — a second billable box, a second capped key, a second identical
refusal. The budget is now exhausted, and the escalation comment carries *"CI failure messages"* that do
not exist (CI never ran on either attempt, because nothing was ever pushed), leaving the operator an
escalation whose four mandated diagnostic elements are two-thirds empty and whose actual cause —
a missing provider key — appears nowhere.

**Fix recipe.** Add to AC4 (and see the AC4 replacement text in DF6.1-B5, which already widens the
trigger set; this finding adds the classification):

> The attempt budget is charged only by attempts that **reached CI**. An attempt whose `dispatch_task`
> phase settled `fail` with `exitStatus: "logic"` — DF6.2's refusal class: `QDS_TEAM_RUNNER` refusal,
> missing provider key, INV-5 roster/task refusal, unreadable or under-provisioned roster, dual-gate
> rejection, manifest-schema or manifest-dir refusal — is a **deterministic** failure that a second
> identical dispatch cannot fix. It does **not** increment `attempt`; it escalates immediately with the
> refusal's own message as the diagnostic, naming the refused precondition, and provisions nothing
> further. An attempt classified `transient` or `lead_failure` is likewise not a fix failure: DF1.3
> already spent its own separately-bounded parse and gate retries inside the run, and this story adds no
> third retry vocabulary — such an attempt escalates with the classification named, and the operator
> decides whether to re-invoke. Only an attempt that produced a diff, passed re-verify, was approved,
> pushed, and then failed **CI** charges the budget. *Negative control: an implementation that treats
> every non-green run as a fix failure spends a second box on a deterministic refusal and posts an
> escalation whose "CI failure messages" element is empty because CI never ran — it MUST fail this AC.*

Add to the Spec Reference block: `- Sibling contracts consumed: **DF6.2** (dispatch_task refusals and non-success classifications settle the phase FAIL — this story reads that verdict rather than inferring failure from "not green"), **DF1.3** (separately bounded parse and gate retries live inside the run; this story's attempt budget is a third, outer bound and introduces no new retry vocabulary).`

---

### DF6.1-H7 — HIGH — `pushVerifiedSha` has a third return arm the story never handles

**Location:** `df6-1:239-247`, `:327-328`, `:368-370`.

**Defect.** The story treats the push as binary: it either pushes (and `attemptSha` is its return) or "is
refused with nothing pushed". The shipped signature is
`Promise<PushOutcome>` where `PushOutcome = { ok: true; sha; targetRef; pushed: boolean } | { ok: false; refusal: RefusalRecord }`
(`src/pr/push.ts:120-122`), and it **does not throw on refusal** — it records the refusal durably and
returns `{ ok: false }` (`:454-467`). There is a third state: `{ ok: true, pushed: false }`, returned when
the remote tip already equals the verified sha — *"a remote already at this sha is a RESUME, not a second
push (AC4)"* (`push.ts:474`, `:487-490`).

**Failure scenario one (the union).** A dev writes `const { sha } = await pushVerifiedSha(...)` inside a
`try`. On a refusal the promise **resolves**, `sha` is `undefined`, and `attemptSha` is recorded as
`undefined` — the SHA-bound poll of AC3/INV-4 then compares `headRefOid` against `undefined` on every
tick, discards every poll, and the attempt escalates `ci-verdict-unavailable` after 15 minutes for a fix
that was never pushed. Nothing in the DOD catches this: the "Test (fast-forward append via DF5.2)" leg
asserts "refused with nothing pushed", which is true of the refusal *record*, not of the caller's
handling.

**Failure scenario two (the resume arm).** The operator re-invokes after a crash between push and record
write. The push already landed; `pushVerifiedSha` returns `{ ok: true, pushed: false }`. This is the
*correct* resume, and the story's own "no pending/partial `fixContext`" design depends on it — but the
story never says so, so a dev may reasonably treat `pushed: false` as "nothing happened" and refuse the
attempt, stranding a run whose fix is already on the PR branch.

**Fix recipe.** Replace the first sentence of `:239` and add a paragraph:

> - **`attemptSha` is the sha `pushVerifiedSha` published, and only that — read off its typed return,
>   not off an exception.** `pushVerifiedSha` returns a `PushOutcome` discriminated union
>   (`src/pr/push.ts:120-122`) and **does not throw on refusal**: it records the refusal durably to
>   `.sandbox/pr/<run-id>.refusals.jsonl` and resolves `{ ok: false, refusal }`. The caller branches on
>   `ok`, never on a `catch`. Its three arms are all live in this loop:
>   `{ ok: false, refusal }` — nothing was pushed; the attempt records the `failedPrecondition` and
>   escalates per AC4 with no `fixContext` written (there is no `attemptSha` to write).
>   `{ ok: true, pushed: true, sha }` — the ordinary append; `sha` is `attemptSha`.
>   `{ ok: true, pushed: false, sha }` — the **resume** arm: the remote tip already equals the verified
>   sha because a prior invocation pushed it and died before recording. This is a success, not a
>   no-op — `sha` is still this attempt's `attemptSha`, the `fixContext` write proceeds, and the CI poll
>   opens against it. An implementation that treats `pushed: false` as "nothing happened" strands a run
>   whose fix is already on the PR branch.

Add a DOD line: *"**Test (push outcome arms):** a refused `pushVerifiedSha` resolves `{ ok: false }`
(never rejects) and the attempt escalates with the `failedPrecondition` named and no `fixContext`
written; an `{ ok: true, pushed: false }` resume records `fixContext` and opens the poll; an
implementation that reads `sha` off the union without discriminating on `ok` records
`attemptSha: undefined` and MUST fail."*

---

### DF6.1-M1 — MEDIUM — the attempt-budget CAS invents a second concurrency primitive

**Location:** `df6-1:248-256`.

The story specifies *"the attempt-budget check-and-increment on the canonical DF2.1 run record is itself
a single atomic compare-and-set (the record's existing write path — no new lock primitive)"*. `RunRecordStore.set`
merges and re-persists; the story asserts a CAS semantic the store does not document, and the parenthetical
"no new lock primitive" is doing work the code has not been shown to do. Meanwhile the repo already has the
right primitive for exactly this: the per-run invocation lock (`acquireRunLock`, `scripts/lib/run-lock.ts`),
which `fleet dispatch` takes at `scripts/fleet.ts:1976` and every run-scoped verb takes at `:4257`, with
DF3.1's exit-5 "the run lock refused, so the verb never ran" mapping. DF3.8 chose that primitive for the
same problem and argued the choice at length (`df3-8:78`, AC2b/c/d).

**Fix.** Replace the CAS paragraph with: *"Two concurrent `--pr` invocations are excluded by the per-run
invocation lock the fleet already uses (`acquireRunLock`, `scripts/lib/run-lock.ts`; DF3.1's exit-5
mapping in `src/fleet/verbs.ts:117-124`), taken by `scripts/fix-run.ts` around the read-check-increment
of the attempt counter on the canonical DF2.1 record — not a new CAS semantic asserted of
`RunRecordStore.set`, and not a new lock file. The loser exits 5, a counted refusal and not a failure,
and the operator re-invokes. A **stale** lock is a distinct, remediated outcome carrying the `rm` line,
never folded into the benign refusal count (`run-lock.ts:57-64`)."*

---

### DF6.1-M2 — MEDIUM — a 40 KB payload on a run record with no length bound, re-read by every sweep

**Location:** `df6-1:188-192`, `:344-347`.

`botComments`' encoded `bodySnippet` text may sum to 40 000 bytes. That lands in an `extensions.fixLoop`
field of kind `"string"`, which has **no length check at all** — `run-record.ts:68-77` states this
explicitly of the `"string"` kind while explaining why `strings` needed one — and the record "is re-read
in full by `fleet status` and by every `list()` sweep, so unbounded growth is a fleet-wide read cost
discovered long after the writes that caused it" (same comment). The DF2.1 authors put a 256-element /
200-char bound on `strings` for precisely this reason; DF6.1 writes 40 KB into the unbounded kind beside it.

**Fix.** Lower the ceiling and say where it lands. Replace *"their encoded `bodySnippet` text sums to at
most **40 000** bytes"* with *"their encoded `bodySnippet` text sums to at most **8 000** bytes — the
payload is JSON-encoded into a `"string"`-kind extension field, a kind with no length bound of its own
(`src/providers/run-record.ts:68-77`), on a record `fleet status` and every `list()` sweep re-read in
full; 8 000 bytes across ≤20 comments is ~400 bytes of quoted context each, which is what a fix brief
actually needs, and the full comment bodies stay reachable on GitHub through the `commentId`s the record
does carry"*, and update the DOD's 40 000-byte fixture accordingly.

---

### DF6.1-M3 — MEDIUM — AC1 asserts an agent-authored claim as if it were evidence

**Location:** `df6-1:76-79`.

AC1 requires *"the `dispatch_task` envelope validates against the step-output schema (v5 §5.2) with
`changedFiles` non-empty"*. `changedFiles` is parsed from the worker's own reply
(`src/phase-engine/agents/envelope-parse.ts:42`, `z.array(z.string()).optional()`) and reaches the host
as `claimed.changedFiles` on the harvested merged output (`src/reverify/runner.ts:151-160`). It is
agent-authored. DF5.2's INV-PR-4 and its shipped implementation are explicit that the host uses its own
`git diff --name-only base..head` and not the box's claim.

Asserting the *envelope* carries a non-empty `changedFiles` is a legitimate **schema** assertion and
should stay. But the story reads as though it were the proof that a fix happened, and it is not — a box
can emit `changedFiles: ["src/x.ts"]` having changed nothing.

**Fix.** Append to AC1: *"— `changedFiles` non-empty is a **schema** assertion about the envelope, not
evidence that a fix happened: the field is agent-authored (`src/phase-engine/agents/envelope-parse.ts:42`)
and reaches the host as `claimed.changedFiles`. The evidence a fix happened is the harvested diff the
host computes itself, which is also the artifact the host-side allowed-path scope check runs against
(Contracts/Schema) and the list DF5.2 renders (INV-PR-4). An empty harvested diff refuses the attempt
regardless of what the envelope claimed."*

---

### DF6.1-M4 — MEDIUM — the poll window can open before any check exists, making "all settled" vacuously true

**Location:** `df6-1:100-104`, `:322-326`.

*"The polling ceiling is 15 minutes measured from `pushVerifiedSha`'s return"* and green is
*"every required check has settled"*. GitHub registers check runs asynchronously after a push; for the
first seconds-to-a-minute after the ref update, `gh pr checks --required` can legitimately report an
empty or partial set. AC3 already has a rule for an empty required set — refuse — and the Guards note
repeats it (`:222-223`), which means the *first* poll after a successful push may fire the
"required-check set is empty ⇒ refuse, because nothing ran" arm against a PR whose checks are simply not
registered yet.

**Fix.** Add to AC3, after the empty-set sentence: *"The empty-required-set refusal is evaluated at
**attempt start**, against the PR's configured required checks **before** the push — not against the
first post-push poll, where an empty set means GitHub has not registered the run yet. Within the poll
window an empty or partial required set is `pending`, resets nothing, and is retried; only the window's
expiry converts it to `ci-verdict-unavailable`."*

---

### DF6.1-M5 — MEDIUM — "refuses a PR with no required checks" is asserted three times with no mechanism

**Location:** `df6-1:220-223`, `:156`, `:158`.

Stated in Guards, in two Infra Prerequisites rows, and in a DOD line — with three different implied
sources (`statusCheckRollup`, "repository branch-protection settings", and `gh pr view`) and no API call,
no credential scope, and no test. Resolved together with DF6.1-B3's fix recipe (`gh pr checks --required`
answering "no required checks reported" is the mechanism, and it needs no admin scope) — but the three
sites must be made to agree, and a DOD leg added: *"**Test (empty required set):** a PR whose branch
carries no required checks is refused at attempt start, provisions nothing, and is never counted green."*

---

### DF6.1-M6 — MEDIUM — the Overview's chain omits `fleet run`

**Location:** `df6-1:33-42`.

*"dispatches it through the **DF3.1 dispatcher** … Inside the box, DF1.6's `dispatch_task` phase runs a
single-fixer pi team; the bundle is harvested (DF2.5)"* — the verb that starts the engine
(`fleet run <run-id>` → `qds-run@<runId>.service`) is absent, and so is the completion observation
between "runs" and "is harvested". Same root as DF6.1-B1; called out separately because the Overview is
what a dev reads first. **Fix:** apply DF6.1-B1's E2E-slice replacement text to the Overview's middle too.

---

### DF6.1-M7 — MEDIUM — the DF13 fleet-ceiling TOCTOU note is carried forward without re-verification

**Location:** `df6-1:474-480`.

The note says plain `dispatch()` holds no fleet lock and that a fix loop firing attempt 2 concurrently
inherits the race. `src/fleet/fleet-lock.ts` exists and `acquireRunLock` is taken by `fleet dispatch`
(`scripts/fleet.ts:1976`) — so at minimum the citation set is stale, and the story does not say whether
either lock covers a second fix attempt. I did not fully trace the fan-out-vs-plain-dispatch split, so
this is flagged rather than resolved. **Fix:** the fix wave should re-read `src/fleet/dispatch.ts` and
`scripts/fleet.ts`'s dispatch block and either restate the residue accurately with current line numbers
or strike it. Under DF6.1-B5's Reading B (one invocation, one attempt) plus DF6.1-M1's run lock, the
concurrent-attempt half of the concern largely dissolves — say so explicitly rather than leaving a stale
warning in the record.

---

### DF6.1-M8 — MEDIUM — briefing item 1's premise is stale and its OPEN QUESTION is now answerable

**Location:** `df6-1:404-427`.

*"`changedFiles` half-exists: the worker reply contract carries it … but in T2.1 that reply landed in
`/tmp/t2-pi-out.txt` **in the box** and only the harness parsed it — nothing host-side captures it as an
artifact."* DF1.10's harvest tar now carries trace.db + journal + resident artifacts, and
`src/reverify/runner.ts:151-160` reads `claimed.changedFiles` host-side. The item's conclusion —
*"THIS story's fix-run path must emit it"* — is discharged.

The OPEN QUESTION (*"whether fix attempts are ever scored via `rank` machinery"*) has an obvious answer
the story should just state: **no**. A fix run is a single dispatch, not a fan-out arm; `rank` scores arms
of a race. Leaving it open invites a dev to build a `stepOutputFor` producer nothing consumes.

**Fix.** Append to item 1: *"**Resolved 2026-09-08.** DF1.10's harvest carries the journal and the
engine's artifacts host-side, and `src/reverify/runner.ts:151-160` reads `claimed.changedFiles` from the
merged output — so no runId-keyed producer is owed by this story. And the OPEN QUESTION is answered
**no**: a fix attempt is a single dispatch, never a fan-out arm, so it is never scored through `rank`.
Attempt diagnostics are AC4's escalation payload and nothing else; this story builds no step-output
producer, and every fan-out score stays null by design."*

---

### LOW findings

- **DF6.1-L1** (`:183-184`, `:276-285`) — "This story registers the `fixLoop` sub-key" is false; it is
  already registered at `src/providers/run-record.ts:216`. Reword to "reads the already-registered
  `fixLoop` sub-key" and add `src/providers/run-record.ts` to Files-to-Modify as a **read-only** entry
  (see DF6.1-B4's recipe).
- **DF6.1-L2** (`:451-453`) — `CostLedger.ingestCostEvent` cited at `cost-ledger.ts:786`; it is at
  `:961` on `dev`. The story already flags the earlier drift ("the run report cites :753 from an earlier
  sha") — update to `:961` and note that the zero-non-test-callers fact is re-verified at `fa7d0e26`.
- **DF6.1-L3** (sprint-status P1.18 entry) — the tracker records "v5.0 polls `gh pr checks` host-side";
  DF6.1 (correctly) never uses `gh pr checks` as the SHA-binding query, and after DF6.1-B3's fix uses it
  only for requiredness. Parent should correct the tracker note to "polls host-side (`gh pr view` for the
  head sha + `gh pr checks --required` for the required-check set) instead of standing up P1.18's webhook
  receiver".
- **DF6.1-L4** (title, `:2`) — "Bounded Fix **Run**" singular vs a two-attempt loop everywhere else.
  Retitle "PR Feedback → Bounded Fix Loop → CI Green" (or accept the split titles in the re-split
  proposal below, which resolves it).
- **DF6.1-L5** (`:269-274`) — the Observability Contract names `duration` and `exitStatus` but not the
  `*_ms` sub-timing convention the sibling stories standardised, nor the absent-not-zero rule
  (`src/fleet/approval-gate.ts:1131-1136`). Add: `fix_run_ms`, `poll_ms`, `ci_settle_ms`, each **absent,
  not `0`**, on a leg that did not run.
- **DF6.1-L6** (`:394-399`) — the briefing header presents itself as "Ground truth for everything below"
  and is dated 2026-08-25 against HEAD `4804765`. Retitle per DF6.1-H1's recipe so a reader is warned
  before the first paragraph.

---

## Credential boundary trace

Every credential the loop implies, where it lives, and the verdict. **No BLOCKER on this axis** — the
architecture is right and the story states it right; the findings here are about a probe that oversells
itself (H5) and a permission scope discovered late (B3).

| # | Credential | Where the loop needs it | Where it actually lives | Verdict |
|---|---|---|---|---|
| C1 | **Host GitHub token** (read PR comments) | `scripts/fix-run.ts` fetching the PR's review comments through the GitHub API | Host only. Same keychain-or-stdin reader DF5.2 uses (`src/pr/github.ts` `readHostToken`), never argv, never env, never a box. | ✅ **PASS** — but the story never says *which* reader `fix-run.ts` uses. **Owed:** name `readHostToken` explicitly so a dev does not reach for `process.env.GH_TOKEN`. |
| C2 | **Host GitHub token** (CI verdict poll) | `gh pr view` / `gh pr checks` every 30 s | Host only; `gh`'s own auth on the operator machine. | ✅ **PASS**, with a scope caveat: AC3's *original* wording implied reading branch-protection settings, whose classic endpoint needs **repo-admin**. DF6.1-B3's fix moves requiredness to `gh pr checks --required`, which does **not**. Adopt that fix and the scope stays at what opening a PR already needs. |
| C3 | **Host push credential** (append the fix) | `pushVerifiedSha(runId, { targetRef })` | Host only, by shipped construction: read last in `preflight` (`push.ts:349-372`), handed to git through a credential helper reading a variable set **on that child only** (`push.ts:176-202`), never argv, never a remote URL, never a `-c http.extraheader=`. The inherited helper chain is reset first so an operator's global helper cannot answer as a different identity. | ✅ **PASS** — nothing for DF6.1 to build. Story is correct at `:154` and `:295-301`. |
| C4 | **Repo clone credential** (get the PR head into the box) | The box must have the repo at the PR head sha | **Never in the box.** `fill` defaults to `bundle-push`: the *host* runs `git fetch origin <sha>` with the host's own credential helpers into a scratch clone, `git bundle`s it, and pushes the bundle into the box over exec stdin as base64; the box clones from the local file (`src/providers/exedev/fill.ts:15-17,34-41,401-421`). `repoUrl` carrying userinfo is refused before any command runs on either side (`:158-165`). | ✅ **PASS, and structurally so.** This is also what makes DF6.1 implementable at all: GitHub allows fetching reachable SHAs, so a PR-branch head reaches the box without the box ever seeing a credential or a branch name. |
| C5 | **Per-run LLM key** (the fixer's spend) | The single-fixer team's model calls | In-box, and only this one: spend-capped, per-run, revocation-verified, at `$HOME/app/.env` 0600 (ADR "Secrets"; DF2.3). This is §6.2's one-secret-per-box, restored by the ADR. | ✅ **PASS** — story states it correctly at `:153` and `:295-296`. |
| C6 | **Bot-reviewer / `authorLogin` binding** | The loop's only trigger is a bot comment, which only appears on a PR opened by the bound identity | `.factory/repos.json` `authorLogin`, enforced at `preflight` step 5 (`push.ts:366-372`) with a security-event refusal on mismatch. | ✅ **PASS** — and `:155` is one of the sharpest lines in the story. |
| C7 | **Anything the in-box probe is supposed to catch** | INV-3's dispatch preflight probe | Two checks only: `git config --get-regexp '^credential\.'` and `GH_TOKEN`/`GITHUB_TOKEN`. | ⚠️ **HIGH (DF6.1-H5)** — not a breach (C4 makes the real containment structural) but a **false-green**: a DOD test on two sinks reads as "the box is credential-free". Widen to the sink list in H5's recipe, or downgrade the claim from "mechanical" to "defence in depth on top of `bundle-push`". |

**Overall credential verdict: PASS with one HIGH.** No credential the loop implies ends up in a box under
the shipped substrate, and no ADR §6.2 / design D8 / R5-fact-17 violation is present in the spec or in
the code it consumes. The one candidate breach a reader might fear — "the box must clone a private PR
branch, so it needs a token" — is closed by `bundle-push` and closed *well*.

---

## Boundedness and termination

**Verdict: bounded on every dimension the spec names, but the loop has no named driver, and one
dimension (attempt-charging) is charged by the wrong events.**

| Dimension | Bound as specified | Terminal state at the bound | Verdict |
|---|---|---|---|
| **Iterations** | max **2** attempts per PR, enforced at dispatch from the DF2.1 records keyed by PR number (`:220`, INV-5) | no third dispatch; failure recorded; escalation comment on the PR with `(error log, diff attempted, CI failure messages)` + runIds | ✅ concrete and testable — **but** see DF6.1-H6: attempts are charged by "not green", which spends attempt 2 on deterministic refusals |
| **Execution wall clock** | inherited from **DF3.1**'s run budget + per-phase caps; this story adds no second timer (`:227-228`) | DF3.1's own | ✅ correct composition — no third vocabulary invented |
| **Re-verify wall clock** | inherited from **DF5.1**'s 30-minute cap and its `error` verdict on overrun (`:229`) | DF5.1's `error` → escalation | ✅ |
| **Approval wait** | **excluded from every budget** — "a human decides on human time" — with DF3.4's own separate expiry (`:229-232`) | `approval-timed-out` → escalates per AC4, explicitly *not* counted as a failed fix | ✅ and correctly argued: the box is already torn down at pause, so a wall clock here would abort every fix run |
| **CI verdict wait** | **15 minutes**, opening at `pushVerifiedSha`'s return, closing when every required check settles (`:100-104`) | `ci-verdict-unavailable` → escalates per AC4 and INV-6, **never** a green | ✅ well-scoped; ⚠️ see DF6.1-M4 (the window can open before checks register) |
| **Spend** | per-run capped LLM key (DF2.3) × ≤2 boxes, all on **one** issueId's ceiling (F15 arithmetic) | `budget-exceeded` / exit-5 `issue-ceiling-insufficient` | ⚠️ **HIGH (DF6.1-H2)** — the issueId is unspecified, so the ceiling that bounds the loop is undecided |
| **Brief size / token spend** | ≤20 comments, ≤40 000 encoded snippet bytes, overflow recorded in `omittedCommentIds` (`:188-192`) | comments dropped, ids recorded — never truncated silently | ✅ genuinely bounded; ⚠️ see DF6.1-M2 (40 KB is too large for the store it lands in) |
| **Loop re-entry / runaway** | the operator command is the **sole** trigger; no webhook, no scheduler, no sweeper (`:140`, `:143`, `:145`) | n/a | ✅ **the strongest part of the story.** The loop structurally cannot self-trigger: it cannot fire on its own commit, its own CI run, or CodeRabbit's response to its own fix, because there is no ingress at all. DD-1 is doing real safety work here, not just process work. |
| **Re-entry detectability** | comment-ID dedup before dispatch; `fixContext.attempt` per attempt; `fixOutcome.runIds` in attempt order on the parent record | — | ⚠️ the dedup as written *blocks* the legitimate retry (DF6.1-B5); the generation counter (`attempt`) is right |

**Does any AC assert the loop terminates?** Yes — AC4 asserts *"no third run is dispatched"* on budget
exhaustion, and the DOD carries `Test (budget exhaustion)` and `Test (poll ceiling)`. Both are
falsifiable. That is better than most loop specs manage.

**What is missing is not a bound — it is the loop's driver.** Because the story never says who fires
attempt 2 (DF6.1-B5), it is impossible to say from the text whether the bound is enforced *within* one
process or *across* invocations, and the two implementations differ in whether a CLI stays alive across a
human approval decision while holding a per-run lock. Fix DF6.1-B5 and the boundedness story is complete
and defensible. Fix DF6.1-H6 and it is charged correctly as well.

**Interaction with DF1.3 and DF6.2: no third retry vocabulary is introduced** — the attempt budget is an
outer bound over whole runs, while DF1.3's parse and gate retries are inner bounds within one run. That
composition is correct. What is missing is the *reading* of DF6.2's verdict (DF6.1-H6): the story bounds
the loop correctly and then feeds it the wrong events.

---

## Re-split proposal

**Recommendation: split into two stories at the `attemptSha` seam. 6 pts → 4 + 3 = 7 pts.**
(The re-point up is deliberate: the story is under-pointed today because it silently assumed a completion
chain that DF3.7 has to build first.)

### Why a split, and why *this* seam

489 lines and 6 points are symptoms, not the argument. The argument is that the story contains **two
different kinds of work with two different dependency sets, two different risk profiles, and one durable
artifact between them**:

1. Everything up to and including the push is *factory mechanics*: read a surface, build a brief, guard
   the roster, dispatch, observe, harvest, re-verify, approve, append. Its risk is credential and scope
   containment. Its dependencies are DF3.7 (completion) and DF5.2 (push).
2. Everything after the push is *loop control*: read a third-party verdict, bind it to a sha, decide
   whether to retry, decide when to stop, tell a human, and leave an audit trail. Its risk is termination
   and correctness of the verdict. Its dependencies are `gh` and DF5.3 (audit chain).

Between them sits a contract the story has **already named and made durable on its own**: *"the fix run's
`fixContext` record is written **once**, after `pushVerifiedSha` returns — not before, and not in two
steps: there is no pending/partial `fixContext` with a not-yet-known `attemptSha` on disk"* (`:243-247`).
That is a writer↔reader seam of exactly the kind the campaign's own pairing plan uses to justify its
splits: story 1 ends when `fixContext` with a real `attemptSha` is on the fix run's record; story 2 begins
by reading it. Nothing crosses the seam except a JSON payload on disk.

It also splits the **live spend** cleanly: story 1's e2e needs a box and a key; story 2's e2e needs a PR
with a required check and no box at all (it can run against a branch pushed by story 1's demo, or by hand).
That halves the cost of the most expensive DOD item in the story and lets story 2's termination logic be
tested exhaustively without paying for a box per case — which matters, because termination is the thing
you most want many cases of.

Three-way (intake / fix-run / verdict) was considered and rejected: the intake guards (AC5, the
`botComments` bound, the single-fixer count) have no independent artifact — they exist only to produce
the brief, and a story whose entire output is an unvalidated brief has no demonstrable behaviour and no
e2e slice. Two is the number of real seams.

### DF6.1a — PR Feedback → Bounded Fix Attempt → Verified Append

**4 pts.** *"A bot comment on a factory PR produces one verified, approved, appended commit on that PR's
branch — or a refusal that costs nothing."*

- **deps:** DF1.5, DF1.6, DF3.1, **DF3.7**, DF3.4, DF5.1, DF5.2
- **ACs:** AC1 (dispatch through DF3.1, in-box single-fixer, envelope validates), AC2 (per-attempt
  approval, `pushVerifiedSha` append, fast-forward, no force-push, no push credential in the box),
  AC5 (single-fixer guard + empty-feedback boundary)
- **owns:** `scripts/fix-run.ts`, `src/fixloop/{feedback-run,index}.ts`, `src/fleet/brief-schema.ts`'s
  additive `fixContext` key, the bot-comment read and filter, the `botComments` bound and
  `omittedCommentIds`, the `bodySnippet` normalization + redaction, the injection fixture, the
  host-side allowed-path scope check on the harvested diff, INV-3's credential probe, and the
  `fixContext` write (incl. `attemptSha`) on the fix run's own record
- **invariants:** INV-1 (append-only), INV-2 (branch scoping), INV-3 (no push credential in a box)
- **e2e:** `tests/fleet/e2e/tier3-fix-loop-append.live.test.ts`, `liveGate("2")` — one box, one key,
  one approval, one appended commit. **This is where the live spend lives.**
- **terminal states:** appended (`attemptSha` recorded) · refused pre-dispatch (roster/feedback/PR guards,
  no box) · refused at push (`out-of-scope-diff`, `not-fast-forward`, gate refusal) · `approval-timed-out`

### DF6.1b — Fix-Loop CI Verdict, Attempt Budget and Human Escalation

**3 pts.** *"The loop reads its own verdict, stops at two, and hands a human everything they need."*

- **deps:** **DF6.1a**, **DF5.3**
- **ACs:** AC3 (SHA-bound required-check polling, the 15-minute window, `ci-verdict-unavailable`),
  AC4 (attempt 2, the budget, the escalation), AC6 (per-runId audit chain)
- **owns:** `src/fixloop/{ci-status,escalation}.ts`, the attempt read-check-increment under the run lock,
  the DF6.2 verdict classification (H6), the `fixOutcome` write on the **parent** record, and the
  additive `src/audit/chain.ts` per-contributing-runId resolution
- **invariants:** INV-4 (verdict authenticity + freshness), INV-5 (bounded loop), INV-6 (fail closed)
- **e2e:** `tests/fixloop/` against a PR with a required check — **no box, no model spend.** The
  termination matrix (green / red-then-green / red-then-red / never-settles / stale-sha / intermediate-sha
  / empty-required-set) is cheap to exercise exhaustively, which is exactly what a loop story needs.
- **terminal states:** `outcome: "green"` · `outcome: "escalated"` (budget exhausted ·
  `ci-verdict-unavailable` · deterministic refusal per H6)

### Edges this creates, and the sequencing consequence

```
DF3.7 ──┐
DF5.2 ──┼──> DF6.1a ──> DF6.1b
DF5.1 ──┤              ↑
DF3.4 ──┤     DF5.3 ───┘
DF1.5/1.6/3.1 ┘
```

DF6.1a is blocked on **DF3.7**, which is unbuilt and in this campaign. DF6.1b is additionally blocked on
**DF5.3**, also unbuilt and in this campaign (agent B). So the honest scheduling statement — which
contradicts the campaign's own pairing-plan note that DF6.1's "deps [are] all shipped" — is: **DF6.1 is
the most dependency-blocked story in the seven, and neither half can start until at least one other
in-campaign story merges.** If the operator wants any DF6.1 work to start early, DF6.1a's *guard and
intake* half (AC5, the comment read, the bounds, the brief schema key) is the only genuinely unblocked
slice — but it is not a shippable story on its own, for the reason given above.

### If the operator declines the split

The story is still salvageable as one 8-pt story, provided all five BLOCKERs are fixed and the dependency
edges are corrected. It is not salvageable as a 6-pt story: two of the BLOCKERs (B1, B5) change what the
story builds, not how it is worded.

---

## Candidate PROPOSED ADR amendments

**None.** No shipped code encountered in this scan contradicts
`docs/superpowers/specs/2026-08-31-tier2-placement-adr.md`. Every drift found runs the other way — the
*spec* is stale against ADR-consistent shipped code — and is therefore resolved by rewriting the spec
(the recipes above), not by amending the ADR.

Two things are worth the parent's attention as *non*-amendments, because they look like candidates:

- **DF6.1-H1** (the briefing recommending host-side pi) would produce an ADR violation **if implemented**,
  but it is stale story prose, not shipped code. It is a spec fix, and the fix is to invert the
  recommendation. Flagged here only so the parent can confirm it is not silently spec'd around — this is
  precisely the shape of the original silent deviation (a wiring-mechanics argument recorded in a
  narrow place and never surfaced to a gate).
- **DF3.7's INV-IBOX-16** already carries an openly-recorded one-clause amendment owed by DF3.8
  ("the only automatic caller" → "no new *unlocked* automatic caller"). DF6.1a becomes a **third**
  automatic caller of DF3.7's chain. That is a DF3.7 story-text amendment, not an ADR amendment — but
  agent A (DF3.7/DF3.8) should be told, because the clause they are about to reword has one more caller
  than they know about.

---

## Method notes / limits of this scan

- Everything asserted about shipped behaviour was read in the file, not recalled: `src/pr/push.ts` in
  full, `src/providers/run-record.ts` (extension registry, `FieldKind`, `assertKind`, `assertNoSecret`,
  `SECRET_PREFIXES`, `SHAPE_EXEMPT_PATHS`), `src/phase-engine/roster/schema.ts`,
  `src/providers/exedev/fill.ts`, `src/fleet/brief-schema.ts`, `src/fleet/verbs.ts`, `src/fleet/run.ts`,
  `scripts/fleet.ts`'s verb table. The `gh` behaviour in DF6.1-B3 was **measured** against PR #237 on
  this repository on 2026-09-08, not recalled from documentation.
- **Not verified, flagged as such:** DF6.1-M7 (the current fleet-lock/TOCTOU state for plain
  `dispatch()` vs fan-out) — I read enough to know the 2026-08-25 citations are stale but did not trace
  the full split. The fix wave should close it rather than carry it.
- The GitNexus MCP tools were unavailable this session (`claude-flow`, `ruv-swarm` failed to connect;
  the `mcp__gitnexus__*` tools were present as deferred names). Navigation was done by targeted reads
  and greps against named symbols rather than by `impact`/`context`. No edit was made, so the
  impact-before-edit rule was not engaged.
- **Nothing was edited.** The story file, the tracker and `sprint-status.yaml` are untouched.
