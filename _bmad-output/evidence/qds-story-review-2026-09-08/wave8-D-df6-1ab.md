# Wave 8 — Round-3 convergence verification, Group D: DF6.1a + DF6.1b

Verifier: independent, fresh-eyes (no prior wave reports, trackers, or seam-ownership tables read).
Scope: exactly two story files, read in full from the working tree of `feature/wave7-seam-ownership-rework`:

- `_bmad-output/sprint-artifacts/dark-factory-v5/stories/df6-1a-pr-feedback-bounded-fix-attempt.md`
- `_bmad-output/sprint-artifacts/dark-factory-v5/stories/df6-1b-fix-loop-verdict-attempt-budget.md`

Method: every named symbol, path, flag, return arm, refusal code, and file was opened at source.
Every "grep returns zero" claim below carries a positive control run on the same file set.
Read-only: no repo file was modified.

---

## Verified CORRECT (spot list of load-bearing claims confirmed at source)

- **The DF3.7 hard edge is real and correctly declared.** `src/fleet/run-completion.ts` does not
  exist; `grep -rn observeAndDriveChain src/ scripts/` returns 0 hits (positive control: the same
  trees match `readMarkerVerdict` in `src/fleet/status.ts:30,1296`). `src/fleet/run.ts:6` carries the
  exact quoted header ("never walks a phase, never holds the run"). `src/fleet/status.ts` reads the
  marker through `readMarkerVerdict` and composes nothing. DF3.7's `INV-IBOX-16` carries the quoted
  wording verbatim and names this story ("DF6.1a's fix run") — the quote is at
  `df3-7-approval-gate-bridge.md:140` (pointer drift, see W8-D-6).
- **`pushVerifiedSha`'s three arms are exactly as specified.** `src/pr/push.ts:120-122` defines
  `PushOutcome = { ok: true; sha; targetRef; pushed: boolean } | { ok: false; refusal }`;
  `pushVerifiedSha(runId, { targetRef? })` at `push.ts:432`; `pushWithPreflight` resolves `false`
  with `outcome: "already-present"` at `push.ts:487-490` (the resume arm); `recordRefusal`
  (`:149`); `no-repo-slug` read from `extensions.budget.repoSlug` with `securityEvent: true`
  (`:339-345`); `assertPublishableRef`/`target-ref-outside-namespace`/`refs/heads/qds/` at
  `:65/:77/:37`; `defaultTargetRef` → `refs/heads/qds/<runId>` at `:40-41`; append proof via
  `git merge-base --is-ancestor` at `:513`.
- **The `fixLoop` registry claims are right.** `src/providers/run-record.ts:219` registers exactly
  `fixLoop: { schemaVersion: 1, fields: { fixContext: "string", fixOutcome: "string" } }`;
  `FieldKind = "string" | "int" | "ports" | "strings"` at `:54` (no object kind); `assertKind`
  throws `schema-rejected: <key> must be a string` (`:749`); `assertNoSecret`'s prefix scan uses
  `(^|[^A-Za-z0-9])<prefix>` (`:709`) over the frozen `SECRET_PREFIXES` (declared `:572`, exported,
  `ghs_` present with the clone-URL comment at `:579-583`, `AIza` present); `RunRecordStore`'s public
  surface is exactly the eight members DF6.1b lists (`path/lockPath/create/get/set/close/list/listWithAnomalies`,
  `:1468-1726`), records keyed by runId.
- **The two-`redactSecrets` disambiguation is exact.** `src/providers/step-log.ts:225` is
  `redactSecrets(text: unknown, keep?: string)` — pattern redactor; imports `SECRET_PREFIXES` at
  `step-log.ts:14`; `PEM_BLOCK_RE` `:108`, `SECRET_PREFIX_RE` `:113`, `LONG_TOKEN_RE` `:117`.
  `cli-anything/src/redact.ts:62` is `redactSecrets(text, parentEnv)` — known-value only
  (`SECRET_KEY_RE` on the key + length floor, no prefix/PEM/long-token arms). `src/pr/body.ts:14`
  imports the cli-anything one and calls it at `:135`/`:160`; the `:80-81` trap text ("an
  environment-derived map would redact nothing (INV-PR-7)") is verbatim.
- **P1.19 / P1.18 clause assignment is accurate.** `p1-19:29/30/31/32/39/52/53/54` and `p1-18:36/50`
  are each exactly the clause the split assigns to the named half; `p1-18:50` reads `(P1.19)` today,
  so DF6.1a's one-line repoint is a real, unbuilt edit owned by exactly one half.
- **AC5's three-state `writes` contract matches the schema.** `src/phase-engine/roster/schema.ts:57`
  `writes: string[] | null`, `null` = unrestricted documented at `:56` and the header refuses
  inference from silence (`:22-23`, required-declaration error at `:272-275`).
  `grep -rn '\.writes' --include=*.ts src/` = 0 (positive control: the same pattern matches
  `tests/phase-engine/roster/schema.test.ts:46,198`). `config/rosters/roster.yaml` ships lead
  (defaults `writes: []`) + one write-capable fixer — the single-fixer shape AC5 asserts.
- **The host-owned scope artifact genuinely does not exist yet.**
  `grep -rn "allowedPath\|allowed-path\|allowlistPaths\|pathAllowlist" --include=*.ts src/ scripts/`
  = 0 (positive control: `allowlist` spelling matches `src/swarmclaw/mcp/stdio-transport.ts`);
  `.factory/fix-scope.json` absent. The nearest shipped allowlist is repo/branch-scoped
  (`resolveRepoEntry`, `src/pr/repos.ts:107`, `DEFAULT_REPOS_FILE` `:16`).
- **The gh surface is measured correctly.** Host gh is 2.93.0. `gh pr checks --help` documents
  `bucket` (pass/fail/pending/skipping/cancel), `--required`, `--json name/state`, and
  "Additional exit codes: 8: Checks pending"; its JSON field list has no per-check commit sha.
  `gh pr view --json` exposes `headRefOid`, `headRefName`, `statusCheckRollup`.
- **The github seam and its policy exist as described.** `GitHubApi` has exactly four members
  (`src/pr/github.ts:32-51`), `httpGitHubApi` at `:128`, `readHostToken` at `:176` with the
  never-`process.env` docblock; `listPrReviewComments`/`getPullRequest` absent today (positive
  control: `findOpenPr` present). `tests/pr/` exists (`body.test.ts`, `github.test.ts`).
- **Brief/issue-ceiling machinery is buildable.** `src/fleet/brief-schema.ts:305` — `issueId:
  z.number().int().positive().max(MAX_ISSUE_ID)`, no `.optional()`; `BriefSchema` is
  `z.strictObject` (`:289`) and carries no `fixContext` key today, so the adds-only registration is
  genuinely additive. The fan-out refusal `issue-ceiling-insufficient` (`src/fleet/fanout-primitive.ts:504`)
  is fan-out-worded as claimed, and the fix path has its own read API:
  `CostLedger.issueBudgetSnapshot(repoSlug, issueId)` (`src/providers/cost-ledger.ts:2195`),
  `readIssueCost` (`:1903`), `perIssueOverrides` keys (`:499`).
- **Lock and verb discipline.** `scripts/lib/run-lock.ts` exports `acquireRunLock` (`:991`),
  `withRunLock` (`:1080`), and `RunLockReentrantError` thrown by a guard near the head of
  `acquireRunLock`. `scripts/fleet.ts` has exactly two `acquireRunLock` call sites — `:2153`
  (dispatch key-mint on the just-minted id) and `:4809` inside `runDestructive` (`:4659`, which
  handles `harvest`); `GATE_VERBS` at `:3367` is exactly `{approve, reject, enrol, unlock, attach}`
  and takes no run lock — DF6.1b's "two corrections of record" is substantively correct.
- **Credential containment.** `src/providers/exedev/fill.ts` — `bundle-push` is the DEFAULT mode
  (`:15-17`), host-side `hostBundle` (`:401-421`), `repoUrl` userinfo refused before any command
  (`:158-165`). `KEY_ENV_FILE = "app/.env"` (`src/providers/credentials.ts:92`) — the
  `/home/exedev/app/.env` EnvironmentFile sink is real. `sudo -n` precedent in `src/fleet/run.ts:31-39,582`.
- **Sibling contracts.** DF6.2's refusal taxonomy (`exitStatus: "logic"`, `QDS_TEAM_RUNNER`,
  dual-gate, manifest-schema) exists in `df6-2-*.md:25,30-31`; DF5.1's wall-clock cap 30 min +
  `error` verdict exist (`df5-1:72-73,153`); DF3.4's `expiresAt` → terminal `timed-out`
  (`src/fleet/approval-gate.ts:910,1010-1023`); DF5.3 anticipates DF6.1b's additive
  `src/audit/chain.ts` edit and lists it in its Files to Modify; the v5 arch §5.2 step-output schema
  names `changedFiles`; DD-1/DD-2/DD-8/DD-10 and D8 all read as cited; `liveGate(tier: "1" | "2")`
  is exactly `tests/fleet/e2e/live-harness.ts:65`; `package.json:25,30` are exactly
  `verify:pi-lens`/`verify:lsp`; all six verification-surface scripts exist; the qds-live-e2e
  SKILL.md hard rules, `keyLeakProblems`, and `final-ls` are as cited; the e2e file naming
  `tests/fleet/e2e/tier3-fix-loop-append.live.test.ts` is new and unused.
- **Seam call site has one owner, stated identically twice.** DF6.1a AC3 ("continues into DF6.1b's
  post-push poll leg in the same invocation before exiting") and DF6.1b Files-to-Modify ("the
  post-push CI poll call — invoked in the same invocation, immediately after DF6.1a's `fixContext`
  write") agree; the 15-minute window anchor (`pushVerifiedSha`'s return, inside invocation 2) is
  stated the same way in both halves.

---

## Findings

### W8-D-1 — HIGH — C3-structural
**Anchor:** DF6.1b AC2 ("reads the PR's recorded attempt state from the DF2.1 run records keyed by
PR number"), DF6.1b Infra Prerequisites row "attempt count and last error read from the records
keyed by PR number", DF6.1b DoD budget leg; cross-seam into DF6.1a AC3's second leg ("a later
invocation … a record already carrying an approved `ApprovalRecord`").

**Failure scenario.** Attempt 1 pushes, the CI poll (inside invocation 2) settles red. No escalation
fires (AC2 escalates only at budget exhaustion). The operator re-invokes `bun scripts/fix-run.ts
--pr <n>`. That invocation must find (a) the fix run's record, (b) its non-green outcome, (c) its CI
failure output, (d) its runId. It cannot. The record store is keyed by runId with no
query-by-extension and no secondary index (verified: the eight-member surface). The only declared
PR→fixRunId edge is `extensions.fixLoop.fixOutcome.runIds` on the parent record — reached via
`parentRunId = headRefName.slice("qds/")` — but `fixOutcome` is written once, at the loop's
terminal outcome only, with `outcome: "green" | "escalated"` (Overview, Contracts/Schema, and the
DoD green leg all say so), and it lives on the parent record while `fixContext` lives on each fix
run's own record and is "never aggregated". After a charged red attempt 1 the parent record carries
neither field, so the declared lookup returns a parent record with no attempt set. AC2's leg, the
uncharged-ceiling test, and the bot-ping-pong test are unbuildable through machinery the spec
declares; the same hole makes DF6.1a's invocation 2 (scope check → push → `fixContext` write — the
story's central act) unable to find the approved fix-run record from `--pr <n>`, since the only
join machinery (head branch → `qds/<parentRunId>`) yields the parent, not the fix run.

**Evidence.** `src/providers/run-record.ts:1468-1726` (store surface, keyed by runId; `extensions.pr.prNumber`
is a field, not a key); DF6.1b Technical Notes "Attempt bookkeeping" itself refutes the AC's "keyed
by PR number" wording ("There is no PR-number index … records keyed by runId"); DF6.1b fixes the
mechanism to `store.get(parentRunId)` → `fixOutcome.runIds`, which cannot exist pre-terminal;
DF5.3 (`:285-289`) even anticipates that DF6.1b "registers a `strings`-kind field in its own story"
if it needs a first-class array — neither half declares that registration or any dispatch-time
parent-record write. An implementer can only proceed by inventing an undeclared write site and an
undeclared index, or by sweeping `list()` — which this story's own bookkeeping note rejects
("no sweep, no fleet-wide read cost").

---

### W8-D-2 — MEDIUM — C3-structural
**Anchor:** DF6.1a AC6, bullet `out-of-scope-diff` ("**Charges an attempt**, capped at 1 by
DF6.1b"; DoD: "refuses `out-of-scope-diff` and **charges** an attempt") vs DF6.1b AC2
("**The attempt budget is charged only by attempts that reached CI**" and "Only an attempt that
produced a diff, passed re-verify, was approved, pushed, and then failed **CI** charges the budget",
restated in the DoD charging-classification leg).

**Failure scenario.** An `out-of-scope-diff` attempt never pushes (the scope check blocks
`pushVerifiedSha`), so it never reaches CI. Under DF6.1b's blanket rule it charges nothing; under
DF6.1a it charges one of the two charged slots. The difference is observable spend and termination:
a PR with 1×`out-of-scope-diff` then 1×CI-red escalates under DF6.1a's reading but dispatches a
third box under DF6.1b's. DF6.1b is also internally inconsistent: its uncharged-ceiling test's mix
list (`transient`, `lead_failure`, `approval-timed-out`, `dispatch-refused`) omits
`out-of-scope-diff`, so the classification falls outside both ceilings while owning a third cap
("capped at 1") — three budget vocabularies, no single owner of where this charge lands.

**Evidence.** Both sentences are normative AC text in their respective stories; DF6.1b's Wave-5c
record ("`scope-requires-privilege` … charges **zero** attempts") shows the operator ruling updated
the deny-glob half without updating the blanket charging sentence.

---

### W8-D-3 — MEDIUM — C2-semantic
**Anchor:** both halves, Observability Contract ("`CostLedger.ingestCostEvent`
(`src/providers/cost-ledger.ts:961`) has zero non-test callers, so `kind='tokens'` rows never reach
`cost_events` (issue #157)"; "Per-role attribution becomes obtainable only when **DF2.12** wires
it").

**Failure scenario.** The predicate is no longer true on this branch. DF2.12 shipped 2026-09-10
(`89282fe4 feat(df2.12): host leg — bridge the harvested engine log's token attribution into the
ledger`): `src/providers/cost-ledger-bridge.ts` calls `ledger.ingestCostEvent` for every harvested
`cost_attribution` line (`:406`), teardown wires it (`ingestHarvestedTokensIfWired`,
`src/providers/teardown.ts:590`), and `scripts/fleet.ts:1349` forwards it through the
loser-ledger handle (PR #253 review). The definition is now at `cost-ledger.ts:1459`, not `:961`.
A implementer relying on the stated fact — e.g. asserting DF6.1b's `hasTokenRows:false` audit-hop
shape, or treating token rows as unreachable — bakes a false invariant into the loop's audit story.
The stories' normative choice (budget against `spendMicroUsd` alone) survives; their factual
justification does not. DF6.1a's Dev Record even asserts the fact was "re-verified current" on
2026-09-08 — true then, overtaken two days later.

**Evidence.** `git log --diff-filter=A -- src/providers/cost-ledger-bridge.ts` → 2026-09-10;
call sites at `cost-ledger-bridge.ts:406`, `teardown.ts:590`, `scripts/fleet.ts:1349`.

---

### W8-D-4 — LOW — C3-structural
**Anchor:** DF6.1a AC6 (`scope-requires-privilege` "…charges zero attempts, **escalates
immediately**") and the DoD two-refusals leg ("…charges **zero**, and escalates immediately").

**Failure scenario.** Escalation is DF6.1b's module (`src/fixloop/escalation.ts`, DF6.1b
Files-to-Modify), sequenced after DF6.1a, and DF6.1a's own Trigger Surface rows "the attempt budget,
escalation, the audit chain" out to DF6.1b. At DF6.1a's merge point there is no escalation path to
take, so the AC as written cannot be satisfied by the story that owns it; the refusal's
escalation half is work described in one half and owned by the other without a seam note (contrast
the charging half of the same bullet, which does carry the "capped at 1 by DF6.1b" pointer).

**Evidence.** `src/fixloop/` does not exist; DF6.1a Files to Modify contains no escalation site;
DF6.1b Trigger Surface owns "Human escalation comment on the PR".

---

### W8-D-5 — LOW — C2-semantic
**Anchor:** DF6.1a AC4 residual paragraph ("a 40-hex sha cannot trip `assertNoSecret`'s prefix scan
and **cannot satisfy the shape heuristic's charset requirements**, so the one operator-uncontrollable
input is provably incapable of failing validation").

**Failure scenario.** The stated mechanism is wrong. The shape heuristic
(`src/providers/run-record.ts:738`) is `v.length >= 40 && mixedClass &&
/^[A-Za-z0-9+/=_.:-]+$/.test(v)`; a 40-hex sha *satisfies* that charset (hex chars are all inside
it). What excludes it is the `mixedClass` conjunct (requires lower + upper + digit) — the code's own
comment at `:682-684` says exactly this ("A 40-char git SHA is all-lowercase hex … a length-only
rule would reject `commitSha`"). The safety conclusion stands by the other conjunct, so the
INV-7-by-construction claim survives, but its "proof" names the wrong guard — and the guard the
story names is the one whose future loosening would not matter, while the one that does matter is
unnamed.

**Evidence.** `src/providers/run-record.ts:732-738`.

---

### W8-D-6 — LOW — C1-citation
**Anchor:** line-pointer cluster across both halves. Every pointer below resolves to the right
symbol and the substance is verified true, but the coordinates are stale:

| Story pointer | Actual |
| --- | --- |
| `src/providers/run-record.ts:216` (fixLoop registry, cited 4×) | `:219` |
| `run-record.ts:569-614` (SECRET_PREFIXES) | `:572+` |
| `run-record.ts:685-738` (assertNoSecret) | `:688-745` |
| `run-record.ts:735` (shape heuristic) | `:738` |
| `src/fleet/verbs.ts:117-124` (exit-5 mapping) | `:129-133` |
| `src/fleet/approval-gate.ts:1131-1136` (absent-not-zero sub-timings) | `:1274-1286` |
| `scripts/fleet.ts:1976` (key-mint lock) | `:2153` (`:1976` is `runDispatch`'s signature) |
| `scripts/fleet.ts:4257` / `:4112` (runDestructive + its lock) | `:4809` / `:4659` |
| `scripts/fleet.ts:3005-3007` (GATE_VERBS) | `:3367` |
| `df3-7-approval-gate-bridge.md:128` (INV-IBOX-16) | `:140` |
| `df5-3-audit-chain-extended.md:140` / `:168` (additive chain.ts / Files to Modify) | `:285` / `:351` |

**Failure scenario.** None behavioral — each citation still lands in the right file and (for the
code pointers) within the right module region, and DF6.1b's "corrections of record" paragraph's
substance verifies exactly (two lock call sites; gate verbs take none; the five gate verbs). But
the fleet.ts cluster is 180-550 lines off in a paragraph whose entire payload is precision, and the
df3-7/df5-3 pointers are the cross-story seam citations a later wave will re-follow.

---

### W8-D-7 — LOW — C2-semantic
**Anchor:** DF6.1a Technical Notes (MANDATORY scope caveat) and the e2e demo leg: "Roster is
`config/rosters/roster.yaml`, the only e2e roster".

**Failure scenario.** Since DF2.12 (2026-09-10), `config/rosters/df212-team.roster.yaml` — reached
via `config/rosters/df212-team.pipeline.json` — is driven by
`tests/fleet/e2e/tier2-df212-attribution.live.test.ts:107`. `roster.yaml` is no longer the only
e2e roster. The operative instruction (use `roster.yaml`, whose shape AC5 guards) is unaffected,
and `roster.yaml` still ships exactly lead + one write-capable fixer (verified), so nothing
behavioral moves; the supporting "only" claim is stale and slightly weakens the
"adding an analyst would edit a shared live fixture" argument's scope.

**Evidence.** `grep -rn "config/rosters/" tests/fleet/e2e/*.ts` → `roster.yaml` (2 files),
`df212-team.pipeline.json` (1 file); `config/rosters/df212-team.pipeline.json:10` names the roster.

---

### W8-D-8 — LOW — C4-marginal
Three wording items, none of which can change an implementation decision:
(a) DF6.1a calls the 4 000-char bound "the GitHub comment-body ceiling this surface mirrors" — it
is P1.18's own injection cap (`p1-18:50`: "truncated snippet … to prevent injection"), not a GitHub
ceiling; this repo's own `src/pr/body.ts:15` documents GitHub's ceiling as 65,536 for the adjacent
PR-body surface. The enforced cap is identical either way.
(b) DF6.1a's "quote" of the tier-2 ADR ("*survived seven review rounds precisely because no AC
tested locality*") is a paraphrase in quotation marks; the ADR's words at `:46-48` are "Seven
review rounds (~260 findings) missed it: e2e tests ran a fake pi on the host and no AC tested
locality."
(c) DF6.1a attributes the sentence "the allowlist — remote and base branch, never the harvested
config" to `resolveRepoEntry`'s "own section comment"; it is the caller's section comment
(`src/pr/push.ts:339`). `src/pr/repos.ts` carries its own allowlist header at `:2`.

---

## Category × severity counts

| | BLOCKER | HIGH | MEDIUM | LOW | total |
| --- | --- | --- | --- | --- | --- |
| C1-citation | 0 | 0 | 0 | 1 | 1 |
| C2-semantic | 0 | 0 | 1 | 2 | 3 |
| C3-structural | 0 | 1 | 1 | 1 | 3 |
| C4-marginal | 0 | 0 | 0 | 1 | 1 |
| **total** | **0** | **1** | **2** | **5** | **8** |

---

## Convergence verdicts

**DF6.1a — NOT CONVERGED** (confidence: high). One HIGH structural residue lands on this half's
core: AC3's second invocation must find "a record already carrying an approved `ApprovalRecord`"
from `--pr <n>`, and no declared lookup can reach a fix-run record before anything names it; the
remainder is AC6's unowned "escalates immediately", the stale cost-ledger fact, citation drift, and
the stale "only e2e roster" claim.

**DF6.1b — NOT CONVERGED** (confidence: high). AC2's driver reads "attempt state … keyed by PR
number" through `fixOutcome.runIds`, which by this story's own write-once/terminal-only contract
does not exist after a charged attempt-1 failure — the loop's attempt-2 leg, uncharged ceiling, and
ping-pong tests are unbuildable through declared machinery; the `out-of-scope-diff` charging rule
also contradicts DF6.1a across the seam, and the `ingestCostEvent` premise is stale.

Residue in one sentence: both halves converge on machinery and seam wording to an unusually high
standard (every arm, refusal code, fence, and gate verified live at source), and what remains is a
single undeclared artifact — a per-PR attempt ledger written at dispatch/attempt time, named by
neither half's Files-to-Modify — plus two cross-half semantic reconciliations (out-of-scope-diff
charging; the DF2.12-overtaken cost claim) and a low-severity citation-sweep.
