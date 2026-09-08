# verify-D — DF6.1a / DF6.1b adversarial pre-development review

**Reviewer:** verify-D (first-time review, beginner's mind)
**Date:** 2026-09-08
**Targets:**
- `_bmad-output/sprint-artifacts/dark-factory-v5/stories/df6-1a-pr-feedback-bounded-fix-attempt.md` (818 lines)
- `_bmad-output/sprint-artifacts/dark-factory-v5/stories/df6-1b-fix-loop-verdict-attempt-budget.md` (502 lines)

**Method:** every path, symbol and line number cited by either half was opened and read.
`gh pr checks`/`gh pr view` were executed live against this repository (PR #237) to verify the
query-correctness claims. Verdicts below are keyed to what the shipped code actually does.

**Counts:** 4 BLOCKER · 7 HIGH · 7 MEDIUM · 4 LOW

---

## 1. Summary of verdicts

| Question | Verdict |
| --- | --- |
| Split integrity | **FAIL** — three items are orphaned (owned by neither half) and four cross-half contradictions |
| Credential boundary (D8 / ADR §6.2) | **PASS inbound, FAIL outbound** — no push credential reaches a box, and the mechanism is structural, not asserted. But the *egress* control (`redactSecrets`) is misidentified, so a credential can reach a public PR comment |
| Boundedness | **FAIL** — the charged/uncharged classification leaves an unbounded, box-spending re-invocation path with no terminal state, and AC2 contradicts itself about which states charge |
| Locality proof | **FAIL** — no AC and no DoD item proves where the fixer executes; the only locality artifact appears in prose |
| Query correctness (`gh`) | **PASS** — verified live; see §6 |
| Artifact consistency | 1 stale header note in `sprint-status.yaml`; per-story rows, points, deps and sprint tags all reconcile |

---

## 2. BLOCKERs

### V-DF6.1a-B1 — AC5's enforced security boundary does not exist and no story creates it

**File/line:** `df6-1a…md:195-201` (AC5), `:88` (Wiring closed), `:317-318` (Technical Notes),
`:580-586` (DoD injection test), `:412-434` (Files to Modify).

**Defect.** AC5 is the *only* enforcement in the entire pair — the story says so itself
(`:198-200`: "In-box scoping is **advisory only**… a rule the box enforces on itself is a claim").
The control is "the host compares every path in [the harvested diff] against the **host-owned
allowed-path list and permitted action set**". That list is never defined: no file path, no format,
no schema, no default contents, no owner, no predecessor story that supplies it. It is not in Files
to Modify. It does not exist in the tree:

```
$ grep -rn "allowedPath\|allowed-path\|allowlistPaths\|pathAllowlist" --include=*.ts src/ scripts/
(no matches)
```

The nearest shipped allowlist is `resolveRepoEntry(hostRoot, repoSlug, deps.reposFile)`
(`src/pr/push.ts:347`), which allowlists *repositories and base branches*, not paths — the file's own
comment says so: `── 4. the allowlist — remote and base branch, never the harvested config ──`.

**Failure scenario.** A dev implements DF6.1a. AC5 has no artifact to compare against, so the
comparison is written against something plausible and local — most likely the brief's own
`writes` scope, or the roster's. That is precisely the in-box claim AC5 exists to distrust
(F10/fact 15). The `pr-feedback-injection.json` fixture then passes, because the in-box scope and
the host scope are the same object. The story's highest-severity control ships as a tautology, and
the review-comment injection path is live against a real repository with a real push credential.

**Fix recipe.** Add to DF6.1a's Files to Modify and to Technical Notes (literal text):

> - `.factory/fix-scope.json` — **new, host-owned, this story's artifact.** A JSON document
>   `{ schemaVersion: 1, allowedPathGlobs: string[], deniedPathGlobs: string[], permittedActions:
>   ("modify"|"add"|"delete")[] }`, read from `hostRoot` by the same `resolveRepoEntry` discipline
>   `src/pr/push.ts:347` uses for `.factory/repos.json` — **never** from the harvested tree, never
>   from the brief, never from the box. It is resolved **per repoSlug**, and a repoSlug with no entry
>   is a refusal (`fix-scope-missing`), not a permissive default. Shipped default for
>   `QDS-Factory`-shaped repos: `allowedPathGlobs: ["src/**","tests/**","scripts/**"]`,
>   `deniedPathGlobs: [".github/**",".factory/**","config/rosters/**","**/*.yml","**/*.yaml"]`,
>   `permittedActions: ["modify","add"]` — a fix may not delete, and may not touch CI config, the
>   allowlist itself, or a roster.

and add the corresponding DoD line:

> - [ ] **Security (host-owned scope artifact):** the allowed-path list is read from
>       `.factory/fix-scope.json` under `hostRoot`, resolved per repoSlug; a repoSlug with no entry
>       refuses `fix-scope-missing` with nothing pushed. *An implementation that derives the scope
>       from the brief, the roster, or any file inside the harvested bundle MUST fail — it is the
>       box grading its own homework (fact 15).*

---

### V-CC-B2 — the approval wait sits **inside** DF6.1a's single invocation; the halves contradict each other, and DF6.1a specifies no resume

**File/line:** DF6.1a `:74-82` (E2E Slice), `:53-65` (Overview), `:153-166` (AC3), `:498-501`,
`:600-603` (DoD). DF6.1b `:242-251` (Technical Notes, "One invocation, one attempt"), `:66`.

**Defect.** DF6.1a's chain, inside one `bun scripts/fix-run.ts --pr <n>` invocation, is:

> `observeAndDriveChain` … → host-side re-verify green → **`fleet approve <run-id>` records this
> attempt's `ApprovalRecord`** → the host compares the harvested diff … → `pushVerifiedSha(…)` …
> → `extensions.fixLoop.fixContext` is written … **The invocation exits.**

`fleet approve` is an *operator* act of unbounded duration. DF6.1a therefore has a CLI staying alive
across a human decision. DF6.1b states the opposite as a design constraint (`:242-251`):

> "It never blocks across an approval decision, never holds the per-run invocation lock across a
> human wait, and ships no daemon, no PID file and no `--loop` flag… The alternative reading — one
> process driving both attempts — … is rejected here explicitly so a dev does not re-derive it."

and cites DF3.7/DF3.8's verb discipline ("*a verb and not a process… nothing that stays resident*").

DF6.1a has **no second-invocation / resume path**. Its DoD `:498-501` says the invocation "calls
DF3.7's `observeAndDriveChain(runId, deps)` … **and exits**" — but AC3 requires the push and the
`fixContext` write, both of which are strictly *after* the approval. There is no specified way to
reach AC3 without residency.

Two ancillary facts, both verified, that the specs get wrong around this:

- DF6.1b `:304-305` claims the per-run invocation lock is "taken by `fleet dispatch` at
  `scripts/fleet.ts:1976` **and by every run-scoped verb**". False. There are exactly two
  `acquireRunLock` call sites in `scripts/fleet.ts`: `:1976` (dispatch key-mint) and `:4257`, which
  is inside `runDestructive` (`scripts/fleet.ts:4112`). `fleet approve` routes through
  `runGateVerbs` (`scripts/fleet.ts:3007`; `GATE_VERBS` at `:3005` = approve/reject/enrol/unlock/
  attach) and takes **no** lock. So the hard deadlock does not occur — but the concurrency claim
  DF6.1b rests on is wrong (see B3).
- `acquireRunLock` is non-re-entrant by design (`scripts/lib/run-lock.ts:951` —
  `if (moduleState().held.has(lock)) throw new RunLockReentrantError(lock)`), which DF3.7 `:118`
  correctly records.

**Failure scenario.** A dev builds DF6.1a literally: `fix-run.ts` polls the record for
`extensions.approval.state === "approved"` in a loop with no ceiling, holding
`<runsDir>/<runId>.lock`. Every run-scoped destructive verb against that run (harvest, teardown)
is refused exit 5 for as long as the operator is at lunch. DF6.1b then arrives, reads its own
Technical Note, and cannot implement "never blocks across an approval decision" without rewriting
DF6.1a's driver — an edit its Files-to-Modify says is "adds only… DF6.1a's single-attempt drive
path is unchanged".

**Fix recipe.** Split DF6.1a's invocation at the gate, in DF6.1a's Overview and E2E Slice:

> `bun scripts/fix-run.ts --pr <n>` drives the attempt to `awaiting-approval` and **exits 0 with
> `state: "awaiting-approval"`**, holding no lock. The operator decides with `fleet approve
> <run-id>`. A **second** `bun scripts/fix-run.ts --pr <n>` invocation observes the fix run's record
> already carrying an approved `ApprovalRecord` bound to this attempt's `ReverifyReport.reportId`
> and head sha, re-takes `<runsDir>/<runId>.lock`, performs AC5's scope check, calls
> `pushVerifiedSha`, and writes `fixContext`. **One attempt is therefore two bounded invocations,
> never one resident process** — the same shape DF6.1b states for the loop.

and add to DF6.1a's DoD:

> - [ ] **Test (no residency across the gate):** an invocation that reaches `awaiting-approval`
>       exits within its own bounded pass, releases `<runsDir>/<runId>.lock`, and leaves no child
>       process; a concurrent `fleet harvest`/`fleet teardown` against that run is **not** refused
>       exit 5. *An implementation that polls for the approval inside the invocation MUST fail.*

---

### V-DF6.1b-B3 — the concurrency AC is unimplementable with the primitive it names

**File/line:** `df6-1b…md:301-317` (Attempt bookkeeping), `:386-391` (DoD concurrent-invocations
test).

**Defect.** DF6.1b excludes two concurrent `--pr <n>` invocations "by the **per-run invocation lock
the fleet already uses** (`acquireRunLock`, `scripts/lib/run-lock.ts`)… taken by `scripts/fix-run.ts`
around the read-check-increment of the attempt counter on the canonical DF2.1 record", and asserts it
is "the **same** lock DF6.1a already holds… so the two halves take one lock, not two", with "no new
concurrency primitive" and "no second lock file".

`acquireRunLock(runsDir, runId, who)` locks `resolve(runsDir, "<runId>.lock")`
(`scripts/lib/run-lock.ts:950`). It is keyed on a **runId**. Two concurrent `fix-run --pr <n>`
invocations that have not yet dispatched have **no runId in common** — each is about to mint its
own. They will acquire two different lock files and both proceed. The DoD's "exactly one dispatches
and the loser **exits 5**" cannot happen.

The lock DF6.1a holds is the **fix run's** lock (`df6-1a…md:105-107`, `:498` — "it takes
`<runsDir>/<runId>.lock>`" for the run it just minted, per DF3.7's precondition at
`df3-7…md:118`). A PR-scoped mutual exclusion would have to be keyed on something else — the
**parent** run's id (the run DF5.2 opened the PR from, which the PR number resolves to). Those are
different runIds, so the "one lock, not two" claim is false in either reading.

**Failure scenario.** Operator, or two terminal tabs, or a shell `for` loop, fires
`fix-run --pr 412` twice within a second. Both read `attempt = 1`, both pass the budget check, both
dispatch. Two boxes, two capped keys, two model spends, two approval requests, and two pushes race
onto the PR branch — the second of which `pushWithPreflight` will refuse `remote-ref-diverged` or
accept as an append, non-deterministically. The DoD test that was supposed to catch this passes
trivially, because a test that spawns two invocations against a *fixture* record can be written to
share one runId and never exercise the mint race.

**Fix recipe.** Replace `df6-1b…md:303-306` with:

> Two concurrent `--pr <n>` invocations are excluded by taking the **parent run's** invocation lock —
> `acquireRunLock(runsDir, parentRunId, "fix-run --pr")`, where `parentRunId` is the run whose
> `extensions.pr.prNumber` equals `<n>` (DF5.2's correlation key, the same hop-1 join DF5.3 uses).
> It is the same primitive and the same lock file layout the fleet already ships, keyed on the one
> identity every attempt for this PR shares. It is **not** the fix run's own lock: that one is
> minted per attempt and cannot serialize two invocations that have not minted yet, and it is the
> lock DF6.1a takes separately for DF3.7's `observeAndDriveChain` precondition. **The loop therefore
> takes two locks with two different scopes — a PR-scoped one for the attempt counter and a run-scoped
> one for the chain — and never holds either across a human decision.**

and correct `:304-305`'s false claim:

> …(`acquireRunLock`, `scripts/lib/run-lock.ts`; taken by `fleet dispatch` at `scripts/fleet.ts:1976`
> and by the **destructive** verbs at `scripts/fleet.ts:4257` inside `runDestructive`. The gate verbs
> — `approve`, `reject`, `enrol`, `unlock`, `attach`, routed through `runGateVerbs`,
> `scripts/fleet.ts:3005-3007` — take **no** run lock, so an approval decision is never blocked by a
> held lock and must never be relied on to be serialized by one.)

---

### V-CC-B4 — `redactSecrets` is the wrong function; the egress control on untrusted prose is a no-op, and it is misattributed to DF5.2

**File/line:** DF6.1a `:299-300`, `:306-307`, `:543-550` (DoD). DF6.1b `:291-297`, `:392-395` (DoD).
Both cite `cli-anything/src/redact.ts:62`.

**Defect.** `cli-anything/src/redact.ts:62` is:

```ts
export function redactSecrets(text: string, parentEnv: EnvMap): string
```

It redacts **only literal values found in the supplied parent environment** under key names matching
`SECRET_KEY_RE`, with a `MIN_REDACTABLE_VALUE_LEN` floor of 8. Its own docblock says so: *"Redact
secret-looking PARENT env values from a string."* It has **no pattern knowledge whatsoever** — no
`sk-` prefix scan, no PEM detection, no long-token heuristic.

Consequences, both live:

1. **DF6.1a `:543-550`'s DoD test cannot pass as written.** The fixture bodies quote `sk-proj-…` and
   `-----BEGIN RSA PRIVATE KEY-----`. Neither string is a value of a host env var, so
   `redactSecrets(body, env)` returns the body **unchanged**. The bot-comment prose enters the brief,
   and therefore the box, with the key literal intact. The DoD item asserts the opposite.
2. **DF6.1b's escalation is a credential-egress path.** The escalation comment quotes CI failure
   output and is posted to a **public** PR. CI output routinely echoes tokens. The most likely
   credential to appear there is the host's own GitHub token — and `readHostToken`
   (`src/pr/github.ts:170-176`) deliberately keeps it out of `process.env` ("never `process.env` — an
   env-resident token is inherited by every child this process spawns"). So the one credential most
   at risk is *by construction* absent from `parentEnv`, and the cited redactor is guaranteed to miss
   it.
3. **"the same `redactSecrets` boundary DF5.2 uses" is false.** `grep -rn redactSecrets src/pr/`
   returns **zero** matches. DF5.2's code imports no redactor.

The function both halves actually want is `src/providers/step-log.ts:225`:

```ts
export function redactSecrets(text: unknown, keep?: string): string
```

which runs `redactKeyManagementUrls`, then `PEM_BLOCK_RE`, `SECRET_PREFIX_RE` (driven by
`SECRET_PREFIXES`, the same frozen list `assertNoSecret` uses — `src/providers/run-record.ts:569`)
and `LONG_TOKEN_RE`. This is the pattern-based redactor the whole `src/providers/` tree uses
(`driver.ts:403`, `credentials.ts:221`, `teardown.ts:273`, `index.ts:107`, `fake-gate.ts:208`) and
the one `scripts/fleet.ts:1982` calls with a single argument.

**Failure scenario.** A CI job prints `Error: authentication failed for
https://x-access-token:ghs_AbCd…@github.com/org/repo`. Attempt 2 fails. The escalation comment is
built, passed through `cli-anything`'s `redactSecrets(text, process.env)` — which finds no matching
env value — and posted verbatim to a public pull request. `ghs_` is in `SECRET_PREFIXES`
(`run-record.ts:580`, with a comment naming *exactly this* clone-URL shape), so the correct redactor
would have caught it. The story's own INV-3-adjacent discipline is bypassed by a citation error.

**Fix recipe.** In both halves, replace every occurrence of

> `redactSecrets` boundary DF5.2 uses (`cli-anything/src/redact.ts:62`)

with

> the repo's pattern-based redactor `redactSecrets(text)` (`src/providers/step-log.ts:225`) — the
> function `src/providers/{driver,credentials,teardown,index,fake-gate}.ts` and
> `scripts/fleet.ts:1982` all use, which runs `redactKeyManagementUrls`, `PEM_BLOCK_RE`,
> `SECRET_PREFIX_RE` (driven by the same frozen `SECRET_PREFIXES` list `assertNoSecret` enforces,
> `src/providers/run-record.ts:569`) and `LONG_TOKEN_RE`. **Not** `cli-anything/src/redact.ts:62`,
> whose `redactSecrets(text, parentEnv)` redacts only values present in the parent environment and
> is a guaranteed no-op on a credential literal quoted by a third party — including on the host
> GitHub token, which `readHostToken` (`src/pr/github.ts:170-176`) deliberately keeps out of
> `process.env`. DF5.2 imports no redactor at all (`grep -rn redactSecrets src/pr/` → no matches),
> so it is not the precedent.

Add to DF6.1b's DoD:

> - [ ] **Security (escalation egress):** an escalation fixture whose CI output contains
>       `https://x-access-token:ghs_…@github.com/org/repo`, a `sk-…` literal, and a PEM block posts a
>       comment containing none of the three. *An implementation calling
>       `cli-anything/src/redact.ts`'s `redactSecrets(text, env)` posts all three unchanged and MUST
>       fail this test.*

---

## 3. HIGH

### V-CC-H1 — `commentsDigest` is computed over redacted text, so it is not reproducible

**File/line:** DF6.1a `:265-269`, `:551-553` (DoD digest-stability test).

The digest input is *"the ordered `[{ commentId, bodySnippet }]` array **as it entered the brief**
(post-normalization, post-redaction)"*. Redaction output is not a function of the comment alone:

- With the currently cited redactor it depends on the **host's environment** at that instant — two
  hosts, or the same host after an env change, produce different digests for identical comments.
- With the correct redactor (`step-log.ts:225`) it depends on `SECRET_PREFIXES`, `LONG_TOKEN_RE` and
  `redactKeyManagementUrls`, all of which are living security lists that have already been edited
  more than once (see the `ghs_`/`AIza` additions at `run-record.ts:576-608`). Every future addition
  silently invalidates every historical digest.

The DoD test *"the same comment set yields the same digest across runs"* passes on one host on one
day and is not a property of the artifact.

**Fix.** Replace `:265-269` with:

> `commentsDigest` is a lowercase-hex SHA-256 over the canonical JSON of the ordered
> `[{ commentId, bodyHash }]` array, where `bodyHash` is a lowercase-hex SHA-256 of the
> **normalized, pre-redaction** comment body (CRLF→LF only) as GitHub returned it. Redaction is a
> transport concern on the brief path and its output is a moving target — `SECRET_PREFIXES` and
> `LONG_TOKEN_RE` are living lists — so digesting post-redaction text makes every historical digest
> unreproducible the next time either list gains an entry. Hashing before redaction keeps the digest
> a stable statement about *what the reviewer wrote*, which is what it is for, and hashing (rather
> than embedding) each body keeps the prose out of the record exactly as INV-7 requires.

and the DoD test:

> - [ ] **Test (digest stability):** `commentsDigest` is a lowercase-hex SHA-256 over the canonical
>       JSON of the ordered `[{ commentId, bodyHash }]` array, `bodyHash` taken over the normalized
>       **pre-redaction** body; the same comment set yields the same digest **on a host with a
>       different environment and after a `SECRET_PREFIXES` entry is added**, and reordering or
>       editing any body changes it. *An implementation digesting post-redaction text MUST fail the
>       differing-environment leg.*

### V-DF6.1a-H2 — DoD "botComments bound" test asserts prose in the record, contradicting AC3 and INV-7

**File/line:** `df6-1a…md:554-557` vs `:260-262` (the `fixContext` shape) and `:476-491` (INV-7).

The DoD reads: *"a fixture with 25 bot comments totaling over 40 000 encoded bytes →
**`fixContext.botComments`** retains at most 20 entries within the 40 000-byte sum"*. `fixContext`
has no `botComments` field — its shape is
`{ prNumber, prBranch, attemptSha, attempt, commentIds, omittedCommentIds, commentsDigest }` — and
the entire B4 ruling exists to keep prose out of it. An implementer following this DoD line writes
bodies into the run record, which is the exact defect DF6.1a says it fixed.

**Fix.** Rewrite `:554-557` as:

> - [ ] **Test (brief botComments bound):** a fixture with 25 bot comments totaling over 40 000
>       encoded bytes → **the brief's** `fixContext.botComments` retains at most 20 entries within the
>       40 000-byte sum, and every excluded comment's `commentId` appears in the **record's**
>       `fixContext.omittedCommentIds`; a fixture under both ceilings retains every comment in the
>       brief and leaves `omittedCommentIds` empty. *The record's `fixContext` carries no
>       `botComments` key at all — an implementation that writes one MUST fail (INV-7, AC3).*

### V-DF6.1b-H3 — the empty-required-set refusal is orphaned: described by b, owned by neither half

**File/line:** DF6.1b `:155-159` (AC1), `:406-408` (DoD), `:344-352` (Files to Modify) vs DF6.1a
`:323-325`, `:595-596`.

DF6.1b requires the refusal to be *"evaluated at **attempt start**, before the push"*. Attempt start
is DF6.1a's pre-dispatch path in `scripts/fix-run.ts`. DF6.1a explicitly disowns it: *"the required-
check rule and the empty-required-set refusal are **DF6.1b's** guards and are not restated here"*.
DF6.1b's `scripts/fix-run.ts` entry is **adds only**: *"the recorded-attempt read, the budget check,
the retry exception to DF6.1a's comment-ID dedup, and the escalation call"* — the pre-dispatch
required-set probe is not in that list.

Worse, DF6.1a already depends on it existing at DF6.1a's own merge time: its e2e-demo prerequisite
(`:595-596`) says the disposable repo needs a required check *"(without it AC1's empty-required-set
refusal fires in DF6.1b and the demo cannot reach green)"* — a forward reference to a guard that,
per the split, is not in the tree when DF6.1a's demo runs.

**Fix.** Add to DF6.1b's Files to Modify:

> - `scripts/fix-run.ts` — **adds only**: the recorded-attempt read, the budget check, the retry
>   exception to DF6.1a's comment-ID dedup, **the attempt-start empty-required-set probe (AC1 —
>   `gh pr checks <n> --required` before any dispatch, refusing with nothing provisioned)**, and the
>   escalation call.

and correct DF6.1a `:595-596` to `"(without it DF6.1b's attempt-start empty-required-set refusal
will fire once DF6.1b merges; at DF6.1a's own merge point no such refusal exists, and the required
check is needed so DF6.1b's demo can reuse this environment)"`.

### V-DF6.1b-H4 — AC2 contradicts itself about charging, and the resolution leaves an unbounded box-spending path

**File/line:** `df6-1b…md:171-177` (para 1) vs `:183-194` (para 3); INV-5 at `:366-369`.

Para 1: *"Given attempt 1 ended in any non-green terminal state — a required check red,
`ci-verdict-unavailable`, `approval-timed-out`, a `dispatch_task` refusal per DF6.2, or an
`out-of-scope-diff` refusal — When the operator re-invokes …, Then that invocation … observes
`attempt = 1` with a non-green outcome, and dispatches attempt 2 with `fixContext.attempt = 2`."*

Para 3: *"Only an attempt that produced a diff, passed re-verify, was approved, pushed, and then
failed **CI** charges the budget."*

`approval-timed-out` and `out-of-scope-diff` appear in **both** lists with opposite consequences.
Under para 1 they are attempt 1 and the next invocation is attempt 2; under para 3 they charge
nothing and `attempt` stays 0.

Taking para 3 as authoritative (it is the one with negative controls), the loop has **no bound on
uncharged attempts**. Each uncharged attempt costs one box, one capped key and one model spend
(≈50 000 µ$ by DF6.1a's own estimate). Nothing in either half caps re-invocation after a
`transient`, `lead_failure`, `approval-timed-out` or `out-of-scope-diff` outcome. The
`out-of-scope-diff` case is the worst: it is the *injection* outcome, so an adversarial review
comment can be re-attempted indefinitely, each attempt costing a box, and every attempt terminates
"correctly" in a named state.

DF6.1b's DoD `:443-446` ("Every leg reaches a **named** terminal state; no leg loops") is satisfied
by this — each *leg* terminates. What is unbounded is the *sequence* of legs, and no AC asserts a
bound on it.

**Fix.** Resolve the contradiction in favour of para 3 and add an uncharged-attempt bound. Replace
`:171-177`'s state list with `"— a required check red, or `ci-verdict-unavailable` after a
successful push —"` and add after para 3:

> **Uncharged attempts are bounded too, by a separate and smaller ceiling.** A terminal state that
> charges nothing still costs one box, one capped key and one model spend, so "uncharged" must not
> mean "unlimited". At most **3** uncharged attempts are recorded per PR across all classifications;
> the fourth invocation dispatches nothing, provisions no box, exits non-zero, and escalates with
> every recorded classification listed. An `out-of-scope-diff` is capped at **1**: the second
> occurrence on the same PR escalates immediately without dispatching, because a second identical
> out-of-scope diff on the same comment set is a signal about the comments, not about the fixer.

and the DoD:

> - [ ] **Test (uncharged-attempt ceiling):** three recorded uncharged attempts (any mix of
>       `transient`, `lead_failure`, `approval-timed-out`, `dispatch-refused`) → the fourth
>       invocation dispatches nothing, provisions no box, exits non-zero and escalates; **one**
>       recorded `out-of-scope-diff` → the next invocation escalates without dispatching. *An
>       implementation that bounds only charged attempts spends a box per invocation forever on the
>       injection path and MUST fail.*

### V-CC-H5 — self-retrigger on the loop's own commit is unaddressed

**File/line:** DF6.1a `:380-384` (comment-ID dedup); DF6.1b `:252-255` ("max 2 charged fix attempts
**per PR**"), `:179-181`, `:320-323`.

DF6.1b claims the loop *"is structurally unable to self-trigger — it cannot fire on its own commit,
its own CI run, or a bot's response to its own fix"*, justified by the operator being the trigger.
The trigger argument covers the first two. It does not cover the third: the appended fix commit is
new code on the PR and will draw **new** review comments from the same bot. Those comments have
**new IDs**, so DF6.1a's ID-based dedup does not stop them, and the next operator invocation reads
them as a fresh feedback set.

Whether that fresh set resets the attempt budget is unspecified and the two statements disagree in
spirit: DF6.1b's Technical Notes say "max 2 charged fix attempts **per PR**" (a lifetime cap), while
AC2 reasons per-recorded-attempt-state and the `attempt` field lives in per-attempt `fixContext`
records. If a fresh comment set resets, the loop and the review bot can alternate indefinitely with
the operator as an unwitting clock.

**Fix.** Add to DF6.1b's Technical Notes:

> - **The bot commenting on our own fix is the one self-trigger the operator-only channel does not
>   close, and it is closed here explicitly.** The appended commit draws new bot comments with new
>   IDs, which DF6.1a's ID dedup cannot stop. The attempt budget is therefore a **lifetime cap per
>   PR**, not per comment set: `fixOutcome.attempts` accumulates across every feedback set on that
>   PR, a fresh comment set never resets it, and a PR that has exhausted the budget escalates on
>   every subsequent invocation regardless of how new the comments are. A comment whose
>   `commentIds` are all newer than the recorded `attemptSha` is recorded as
>   `classification: "bot-response-to-fix"` in the escalation, so the operator can see the loop is
>   arguing with the reviewer rather than fixing the PR.

and the DoD:

> - [ ] **Test (no bot ping-pong):** a PR with two charged attempts recorded and a **new** bot
>       comment set posted after `attemptSha` → the invocation dispatches nothing and escalates with
>       `classification: "bot-response-to-fix"`. *An implementation that resets the budget on a fresh
>       comment set MUST fail.*

### V-CC-H6 — no AC or DoD item proves locality

**File/line:** DF6.1a `:130-141` (AC1), `:587-603` (e2e DoD), `:70-82` (E2E Slice).

AC1's two negative controls are statements about *implementation shape* — "an implementation that
shells `warren run --team`… MUST fail" and "an implementation that drives the pi worker argv from
the host into the box… MUST fail". Neither is a runtime observation. A grep-based test satisfies the
first; the second has no stated check at all.

The one artifact that could prove locality — `/run/qds-run/<run-id>/journal/final.json`, written by
the in-box engine and read through `readBoxFile` — appears only in the E2E Slice *prose*
(`:77-78`). It is in no AC and in no DoD item. The mandatory e2e DoD (`:600-603`) says "one fix run
**in-box**" and then describes the chain without naming a single in-box-only observable.

This is precisely the failure mode the tier-2 ADR unwound: the host-side placement *"survived seven
review rounds precisely because no AC tested locality"* (ADR §"The deviation was silent and never
ratified", `docs/superpowers/specs/2026-08-31-tier2-placement-adr.md:34`).

**Fix.** Add to DF6.1a's AC1 and to the DoD:

> - [ ] **Test (locality is proven, not asserted — e2e):** the demo asserts (a) the fix run's
>       terminal marker was read from `/run/qds-run/<run-id>/journal/final.json` **through
>       `readBoxFile`**, a path that exists only inside the box; (b) `systemctl show
>       qds-run@<run-id>.service -p ExecMainStartTimestamp` on the box reports a start, so the unit
>       — not an exec — ran the engine; and (c) **no `pi` process was spawned on the host for the
>       duration of the run**, asserted by snapshotting the host process table before and after and
>       diffing for any argv containing `pi ` or `--provider`. *An implementation that satisfies the
>       chain by exec'ing the worker argv from the host passes every other test in this story and
>       MUST fail this one — that is the tier-2 deviation the ADR unwound, and it survived seven
>       review rounds because no AC looked.*

### V-CC-H7 — DF6.1a deletes the e2e environment DF6.1b's mandatory demo reuses

**File/line:** DF6.1a `:611-612` vs DF6.1b `:454-456`.

DF6.1a: *"The disposable repository is deleted afterwards, tracked as its own issue the way DF5.2
tracked `qds-df52-e2e` (#133)."*
DF6.1b: *"The disposable repository and its required-check configuration are **DF6.1a's** demo
environment, **reused here** rather than provisioned twice."*

DF6.1b is sequenced strictly after DF6.1a and after DF5.3, so by the time DF6.1b's demo runs the
repository is gone. DF6.1b's MANDATORY e2e has no environment and no provisioning instructions of
its own.

**Fix.** In DF6.1a `:611-612`:

> The disposable repository is **retained until DF6.1b's demo has run**, then deleted — tracked as
> its own issue the way DF5.2 tracked `qds-df52-e2e` (#133), with DF6.1b named on the issue as the
> second and last consumer. If DF6.1b's demo runs on a fresh repository instead, it provisions it to
> the same three prerequisites (branch protection with one fast required check, the review bot bound
> to the allowlist entry's `authorLogin`, and a PR opened under that `authorLogin`) — DF6.1b must not
> assume an environment this story deletes.

---

## 4. MEDIUM

**V-DF6.1b-M1 — "run records keyed by PR number" names an index that does not exist.**
`df6-1b…md:174-175`, `:235`, `:301-302`, `:383-385`. No run-record field is keyed by PR number for a
*fix* run: `extensions.pr.prNumber` (`src/providers/run-record.ts:214`) is written only by DF5.2 on
the run that **opened** the PR. A fix run's PR number lives inside the JSON-encoded `fixContext`
**string**. Resolving "the attempt state for PR n" therefore requires a full `list()` sweep plus a
JSON parse of every record's `fixContext` — the exact cost DF6.1a's own Technical Notes
(`df6-1a…md:285-286`) cite as a reason not to store bulk in the record. *Fix:* state the lookup
explicitly — resolve the **parent** run by `extensions.pr.prNumber` (DF5.3's hop-1 join), then read
`extensions.fixLoop.fixOutcome.runIds` on that parent record for the attempt set. That is one
indexed lookup plus one record read, and it is the same join B3's lock needs.

**V-DF6.1b-M2 — "a flaky suite is rerun once, then FAIL" has no owner and contradicts the scope
claim.** `df6-1b…md:151-152`. Nothing is said about *who* reruns. A GitHub CI rerun (`gh run rerun`)
needs `actions: write`, which contradicts AC1's repeated "no repo-admin token scope" claim
(`:164-166`, `:231`, `:403-405`), and re-triggering CI is an act the loop otherwise disclaims.
*Fix:* either delete the clause and let a flaky required check be `ci-red` → escalation, or state:
*"the loop never reruns CI — it has no `actions: write` scope. §8.0's rerun-once rule is the
operator's, exercised outside this loop; a flaky required check settles red and escalates."*

**V-DF6.1a-M3 — INV-3's probe names sinks but no mechanism, and one check inverts.**
`df6-1a…md:463-469`, `:524-531`. "in the environment the run unit will inherit — not merely the
environment the probing exec sees, since a systemd unit gets its own" states the requirement and
stops. No mechanism is given for observing a unit's environment from an exec. Separately,
`git config --get-regexp` exits **1** when nothing matches, so "empty" must be spelled as an
outcome, not a stream. *Fix:* name the mechanism — *"the probe runs as `systemd-run --wait --pipe
--service-type=exec --uid=<the unit's User=> …` so it inherits the same environment
`qds-run@<runId>.service` will, and each `git config --get-regexp` check counts **exit 1 with empty
stdout** as clean and exit 0 as a hit."*

**V-DF6.1a-M4 — `fixContext.attempt` is a seam field with a split writer.** DF6.1a writes it
(`:260`) but has no attempt logic; DF6.1b increments it (`:176`) but its `scripts/fix-run.ts` entry
(`:350-352`) does not list writing `fixContext`. *Fix:* add `"and the `fixContext.attempt` value
handed to DF6.1a's write path"` to DF6.1b's `scripts/fix-run.ts` Files-to-Modify line.

**V-DF6.1a-M5 — spend protocol omits `keyLeakProblems`.** `df6-1a…md:605-612` names revoke/destroy/
`final-ls` but not `keyLeakProblems`, which `.claude/skills/qds-live-e2e/SKILL.md:332-334` says runs
in the `finally` of *every* tier3-prefixed file. *Fix:* append `"and `keyLeakProblems` runs in the
same `finally`, as it does in every other tier3 file (SKILL.md §Evidence)"`.

**V-DF6.1a-M6 — `flags: ["out-of-scope-diff"]` has no defined home.** `:198`, `:584-585`. `flags` is
not a run-record core field, not in the `fixLoop` registry (`run-record.ts:216` registers exactly
`fixContext` and `fixOutcome`), and is not defined in either story. *Fix:* fold it into the record's
`fixContext` as `refusal: "out-of-scope-diff"` plus `offendingPaths: string[]` inside the JSON-encoded
payload — but note this collides with AC3's "no `fixContext` when no sha was published", so the
cleanest fix is to make it a **log-only** field and say so: *"`flags` is an observability field on the
`fix-attempt-refused` log line, never a run-record field — AC3 forbids a record for a refused
attempt."*

**V-CC-M7 — `commentsDigest` has no reader.** DF6.1b never consumes it; dedup is by `commentIds`. A
field written on every attempt with no consumer will not be maintained. *Fix:* either name the
consumer (DF5.3's audit chain, as evidence of what the attempt acted on) in DF6.1a's Technical Notes,
or state explicitly that it is write-only forensic evidence with no runtime reader.

---

## 5. LOW

- **V-DF6.1a-L1** (`:109-110`) — *"DF3.7's INV-IBOX-16 clause is **being reworded** to 'no new
  *unlocked* automatic caller'"* is stale. `df3-7-approval-gate-bridge.md:128` already carries the
  reworded clause, already names "DF6.1a's fix run" as one of three sanctioned callers, and its
  actual wording is *"at most one automatic caller at a time, each holding the per-run invocation
  lock"*. Quote DF3.7's shipped text rather than describing an edit as pending.
- **V-CC-L2** — `_bmad-output/sprint-artifacts/sprint-status.yaml:18` still reads *"DF5.3 gates a
  separate 11-pt chain (DF6.1 6 -> DF5.4 3 / DF5.5 2)"*. DF6.1 no longer exists, DF5.4 is 5 and
  DF5.5 is 3, per the per-story rows and the 2026-09-08 re-estimate block at `:50-67`. **The
  per-story rows are authoritative**; the header note is a stale artifact of the pre-split slate.
- **V-DF6.1a-L3** (`:106-107`) — `scripts/fleet.ts:1976` is cited correctly, but that acquisition is
  the key-mint lock on the **just-minted** runId, which is exactly why it cannot serialize two
  pre-mint invocations. Worth stating, because the citation currently reads as support for B3's
  broken claim.
- **V-DF6.1b-L4** — the poll spec branches on `gh pr checks`'s **stdout text** only
  (`:156-157`, `:232`). Verified live: `gh pr checks` documents *"Additional exit codes: 8: Checks
  pending"* and returns non-zero on the empty-required-set message. Say so, or an implementation
  checking `exitCode === 0` treats every pending poll as a hard failure.

---

## 6. Query correctness — verified live

Executed against this repository on 2026-09-08 (PR #237, branch `fix/df1-11-code-review-round-2`):

```
$ gh pr view 237 --json headRefOid
{"headRefOid":"2191578b91ddea1c9ec3250f3eb601c62af8f043"}

$ gh pr checks 237 --required --json name,state,bucket
no required checks reported on the 'fix/df1-11-code-review-round-2' branch

$ gh pr checks --help  → JSON FIELDS: bucket, completedAt, description, event, link, name,
                          startedAt, state, workflow
                        FLAGS: --required   Only show checks that are required
                        "it includes a `bucket` field, which categorizes the `state` field into
                         pass, fail, pending, skipping, or cancel"
```

**DF6.1b AC1 is correct on every point I could test.** `--required` exists; `name`, `state` and
`bucket` are all real `gh pr checks` JSON fields; `bucket` is documented with exactly the five values
the story implies; the "no required checks reported on the '<branch>' branch" string is verbatim; and
`gh pr view --json headRefOid` returns the head sha. The two-call composition answers the question and
neither call alone does. The `statusCheckRollup` field list at `df6-1b…md:139` matches GitHub's
documented rollup shape and carries no requiredness marker. This is the best-verified claim in either
story and no finding is raised against it.

## 6b. Other citations verified true

`src/phase-engine/roster/schema.ts:56` (`writes: string[] | null`) and `:22-24` (the fail-closed
comment: *"The story defines `null` as 'unrestricted repo writes'; inferring that from silence is the
one default here with a blast radius"*) — **true**, and DF6.1a's `writes !== []` guard spelling and
all four negative controls are correct · `src/providers/run-record.ts:54` (`FieldKind` with no object
kind), `:216` (`fixLoop` registered with two `"string"` fields), `:685-738` (`assertNoSecret`),
`:569-614` (`SECRET_PREFIXES`), `:735` (the `/^[A-Za-z0-9+/=_.:-]+$/` charset that cannot fire on
JSON) — **all true**; the B4 "the code was right, the spec was wrong" conclusion holds ·
`src/pr/push.ts:120-122` (`PushOutcome` union), `:340-346` (`no-repo-slug` as `securityEvent: true`),
`:487-490` (`already-present` returning `false`) — **all true**, and `pushVerifiedSha` returns
`{ ok: true, sha: pre.headSha, … }` at `push.ts:453`, confirming DF6.1a's "`attemptSha` is the
re-verified head sha, read off the typed return" · `src/fleet/brief-schema.ts:289` (`z.strictObject`,
so the allow-listed-key edit really is required) and `:305` (`issueId` required, no `.optional()`) —
**true** · `src/fleet/run.ts:6` ("It never walks a phase, never holds the run") — **true** ·
`src/fleet/verbs.ts:117-124` (exit 5 = "the run lock refused, so the verb never ran") — **true** ·
`tests/fleet/e2e/live-harness.ts:65` (`liveGate(tier: "1" | "2")`, throws rather than skips) —
**true**, and the `tier3-` filename prefix with `liveGate("2")` is the repo's documented convention
(`.claude/skills/qds-live-e2e/SKILL.md:88-92`), not a defect · `src/fleet/approval-gate.ts:1131-1136`
(absent-not-zero sub-timings) — **true** · `src/providers/cost-ledger.ts:961`
(`ingestCostEvent`, zero non-test callers) — **true** · `src/fleet/fanout-primitive.ts:360` (the sole
`FleetLock` instantiation; `dispatch.ts` and `scripts/fleet.ts` reference it nowhere) — **true**, so
the DF13 ceiling-race residue is correctly re-verified · `src/reverify/runner.ts:151-160`
(`claimed.changedFiles` off the merged output) — **true** · `src/providers/exedev/fill.ts:12-20`,
`:32-44`, `:158-165` (bundle-push default; userinfo refused before any command) — **true** ·
`src/providers/teardown.ts:12` (the only `recordAuditLink` mention in `src/`) — **true**;
`src/audit/` does not exist · `df5-3-audit-chain-extended.md`'s hop table and the
`src/audit/chain.ts` Files-to-Modify entry — **true**, the writer↔reader contract is agreed in both
directions.

---

## 7. Split-integrity accounting

DF6.1's inventory, and where each item landed. Sources: DF6.1a `:618-625`, DF6.1b `:462-468`, and my
own read of both halves.

| DF6.1 item | Declared home | Actually present there | Verdict |
| --- | --- | --- | --- |
| AC1 (dispatch + in-box fix) | a | yes, `a:130-141` | OK (but see H6 — locality untested) |
| AC2 (approve + append push) | a | yes, `a:142-152` | OK |
| AC3 (CI verdict) | b | yes, `b:129-170` | OK |
| AC4 (failure path / budget) | b | yes, `b:171-205` | **contradicts itself** — H4 |
| AC5 (single-fixer guard) | a → now a's AC4 | yes, `a:172-194` | OK — the strongest AC in the pair |
| AC6 (audit chain) | b → now b's AC3 | yes, `b:206-214` | OK |
| INV-1 no force-push | a | yes, `a:438-440` | OK |
| INV-2 branch scoping | a | yes, `a:441-443` | OK |
| INV-3 no push credential in box | a | yes, `a:444-475` | OK — structural, see §8 |
| INV-4 verdict authenticity | b | yes, `b:360-365` | OK |
| INV-5 bounded loop | b | yes, `b:366-369` | **bound is incomplete** — H4 |
| INV-6 fail closed | b | yes, `b:370-372` | OK |
| INV-7 (NEW, 2026-09-08) | a, binds b | `a:476-491`, echoed `b:479-481` | OK |
| AC "the seam" (NEW) | a's AC3 | yes, `a:153-179` | OK |
| Scope enforcement (a AC5) | a | AC text present; **artifact absent** | **ORPHAN — B1** |
| Empty-required-set refusal | b's AC1, executed at attempt start | in no half's Files to Modify | **ORPHAN — H3** |
| The approval→push continuation | a | no invocation model supports it | **ORPHAN — B2** |
| 2026-08-25 inherited briefing | a (all 5 items) | yes, `a:683-818` | OK — item 2's SUPERSEDED note and item 5's DF13 re-verification are both correct |
| `p1-19:53` webhook signature | deleted, reason stated | `b:29-35` dispositions it into INV-4 | OK — deleted *with* a stated reason, correctly |
| `p1-18:50` repoint | a, exactly one writer | `a:423-431`; `b:496-502` explicitly disclaims | OK — the one-owner fencing is done properly |

**Cross-half contradictions found (4):**

1. Residency across the approval gate — a requires it, b forbids it (**B2**).
2. The lock — b claims "one lock, not two" and "every run-scoped verb"; both are false (**B3**).
3. `fixContext.botComments` — a's DoD asserts prose in the record, a's AC3/INV-7 forbid it (**H2**).
4. The disposable repository — a deletes it, b reuses it (**H7**).

**Orphans (3):** the allowed-path artifact (B1), the empty-required-set edit (H3), the
approval→push continuation (B2).

**Verdict: the split FAILS integrity review.** The `attemptSha` seam itself is clean and well
chosen — AC3 makes it falsifiable and DF6.1b's "reads it, never derives one" is exactly right. What
the split lost is the *invocation boundary*: DF6.1a assumed a process that spans the human decision,
DF6.1b assumed one that does not, and neither half noticed that the same `scripts/fix-run.ts` cannot
be both.

---

## 8. Credential boundary trace

Every credential the loop implies, where it lives, and what keeps it there.

| # | Credential | Lives | Used for | Mechanism keeping it out of a box | Verified |
| --- | --- | --- | --- | --- | --- |
| 1 | Host GitHub token | host keychain / piped stdin, **never `process.env`, never argv** | bot-comment read (a), `pushVerifiedSha` (a), CI poll (b), escalation comment (b) | `readHostToken` (`src/pr/github.ts:170-176`) reads it per call, never caches to disk, never exports to env — so no spawned child inherits it | **yes**, read in source |
| 2 | Git push credential | host git credential helpers | host-side push; host-side `git fetch` of the pinned SHA for the fill | `fill` defaults to `bundle-push`: host fetches + `git bundle`-packs + pushes the bundle over exec stdin; the box clones from a **local file** (`src/providers/exedev/fill.ts:12-20, 32-44`). `repoUrl` carrying userinfo is refused before any command runs on either side (`fill.ts:158-165`) | **yes**, read in source |
| 3 | Per-run LLM key | in-box, `$HOME/app/.env` 0600, spend-capped, revocation-verified at teardown | the fixer's model calls | This is the box's **one** secret — ADR §6.2's one-secret-per-box, preserved | consistent with ADR |
| 4 | Repo-admin scope | **not taken** | (would be needed to read branch protection) | b routes requiredness through `gh pr checks --required`, which needs no admin — verified live | **yes**, executed |

**Inbound verdict: PASS, and the mechanism is verified rather than asserted.** DF6.1a `:447-455`
does not merely claim containment — it names bundle-push as the structural reason and demotes the
probe to defence in depth, which is the honest ordering. The probe's sink list (`:463-469`) is
genuinely wide: `credential.*`, `~/.git-credentials`, `~/.netrc`, `~/.config/gh/hosts.yml`,
`GH_TOKEN`, `GITHUB_TOKEN`, `GH_ENTERPRISE_TOKEN`, `GITHUB_API_TOKEN`, `SSH_AUTH_SOCK`,
`url.*.insteadOf`. The inclusion of `~/.config/gh/hosts.yml` — gh's own token store, which unsetting
`GH_TOKEN` does nothing about — is the kind of detail that shows the list was derived rather than
guessed. **No D8 / §6.2 violation found.** The one gap is mechanism, not coverage (M3).

**Outbound verdict: FAIL.** The trace above is about credentials reaching a box. The loop also has
two *egress* surfaces neither half controls correctly, both because of B4:

- **host → box:** untrusted bot-comment prose enters the brief, and the brief enters the box. The
  named redactor is a no-op on a quoted credential literal.
- **host → public internet:** DF6.1b's escalation comment quotes CI failure output onto a public
  PR. The named redactor is a guaranteed no-op on the host GitHub token, because `readHostToken`
  deliberately keeps that token out of the environment the redactor consults.

Fixing B4 (swap to `src/providers/step-log.ts:225`) closes both.

---

## 9. Boundedness verdict

Bounded by: **charged attempts (max 2, INV-5)**, **CI-poll window (15 min from `pushVerifiedSha`'s
return)**, **DF3.1's run budget + per-phase caps** (inherited), **DF5.1's 30-min re-verify cap**
(inherited), **DF3.4's approval expiry** (separate, explicitly excluded from every wall clock —
correctly, and both halves say so identically, which is good split hygiene).

Terminal states named: `green`, `ci-red`, `ci-verdict-unavailable`, `approval-timed-out`,
`dispatch-refused`, `transient`, `lead_failure`, `out-of-scope-diff`, `issue-ceiling-insufficient`,
`budget-exhausted → escalated`. Every path has a name; DF6.1b's termination-matrix DoD
(`:443-446`) exercises eight of them against fixtures with no box and no spend, which is the single
best thing about this split.

**Does any AC assert the loop terminates? Partly.** DF6.1b AC2's final paragraph does: *"given two
**charged** attempts have failed… a third invocation dispatches **nothing**, provisions no box,
exits non-zero"*. That is a real, falsifiable termination assertion — but it terminates only the
*charged* sequence. Six of the ten terminal states above charge nothing, and no AC bounds how many
times they may recur (**H4**). The loop terminates on the path where the fixer works and CI
disagrees; it does not terminate on the path where the fixer is refused, which is the cheaper path to
reach adversarially and the more expensive one to repeat.

**Verdict: bounded on the charged path, unbounded on the uncharged path.** H4's fix closes it.

---

## 10. Artifact consistency sweep

| Field | Story | `sprint-status.yaml` | Verdict |
| --- | --- | --- | --- |
| DF6.1a points | 4 (`a:3`) | 4 (`:211`) | agree |
| DF6.1b points | 3 (`b:3`) | 3 (`:212`) | agree |
| DF6.1a sprint | v5-S3 (`a:4`) | v5-S3 (`:211`) | agree |
| DF6.1b sprint | v5-S3 (`b:4`) | v5-S3 (`:212`) | agree |
| DF6.1a deps | DF1.5, DF1.6, DF3.1, DF3.7, DF3.4, DF5.1, DF5.2 (`a:91`) | identical set (`:211`) | agree |
| DF6.1b deps | DF6.1a, DF5.3 (`b:91-92`) | identical (`:212`) | agree |
| Status | neither story carries a status line | `ready-for-dev` for both | agree — no story in this epic carries one (`df5-2…md:1-4` likewise) |
| Split arithmetic | 6 → 4+3 | `:54` "+1 story +1 pt DF6.1 (6) split -> DF6.1a (4) + DF6.1b (3)" | agree |
| Slate totals | — | `:65-67`: eleven not-done = 41 pts; per-epic 45+45+35+10+22+9 = 166; 10+12+9+2+5+3 = 41 stories | reconciles both ways |
| P1.18 non-predecessor + two-limbed severance | both halves | `:126` records both limbs and the `:50` single-writer handover | agree |
| DF5.5 deps include both halves | `a:423-431` | `:204` lists DF6.1a and DF6.1b | agree |

**One disagreement:** `sprint-status.yaml:18` — *"DF5.3 gates a separate 11-pt chain (DF6.1 6 ->
DF5.4 3 / DF5.5 2)"*. DF6.1 no longer exists as a story; DF5.4 is 5 points and DF5.5 is 3 per the
2026-09-08 re-estimates at `:57-59` and the per-story rows at `:203-204`. **The per-story rows are
authoritative** — they are what the reconciliation at `:64-67` sums, and that sum is correct. Line 18
is a stale pre-split narrative note in a header comment block. LOW; fix by rewriting it as
*"DF5.3 gates a separate 17-pt chain (DF6.1a 4 + DF6.1b 3 -> DF5.4 5 / DF5.5 3, DF6.1b also blocked
directly on DF5.3)"*.

No eight-day-style disagreement found. This pair's headers are in better shape than the prior
campaign's.

---

## 11. What a previous reviewer got wrong

The 2026-09-08 wave-1/wave-2 findings recorded in both Dev Agent Records are, on my re-verification,
substantially correct — DF6.1-B1 (the DF3.7 hard edge), B2 (the inverted `writes: null` guard), B3
(the two-call `gh` composition), B4 (the storage design, not the ordering), H2 (`issueId`), H5 (the
probe sink list), H7 (`PushOutcome`'s three arms) and M7 (the DF13 re-verification) all hold up
against source. The `writes: null` inversion in particular was a genuine catch and its four negative
controls are the best-specified test set in either file.

Two things a previous wave got wrong or left half-done:

1. **B4's fix named the wrong function.** The ruling ("the payload, not the scanner") is right and
   `assertNoSecret` is correctly left untouched. But the *replacement* boundary — "the same
   `redactSecrets` boundary DF5.2 uses (`cli-anything/src/redact.ts:62`)" — was written into **both**
   halves without opening the file. It is the wrong `redactSecrets` of the two in this tree, it is
   env-driven rather than pattern-driven, and DF5.2 does not use it or any other redactor. The
   finding closed the record-side hole and opened a comment-side one (**B4**).
2. **B5 ("the loop's driver — Reading B, one invocation one attempt") was applied to DF6.1b only.**
   The invocation model it fixed lives in DF6.1a's chain, which still spans `fleet approve` inside a
   single invocation. The finding is recorded as resolved in b's Dev Agent Record (`b:472`) while a's
   E2E Slice and DoD still describe the rejected reading (**B2**). This is the classic split
   failure: the fix landed in the half that *documented* the rule, not the half that *violates* it.

Additionally, DF6.1-M3's resolution ("the envelope's `changedFiles` is a schema assertion, not
evidence — the harvested diff is") is correct and well-stated, but it is the finding that makes B1
load-bearing: once the harvested diff is the evidence, the thing that grades it has to exist.
