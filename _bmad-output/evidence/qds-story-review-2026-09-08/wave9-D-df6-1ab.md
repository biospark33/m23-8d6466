# Wave 9 — Verifier D — DF6.1a + DF6.1b

**Date:** 2026-09-14 · **Branch:** `feature/wave7-seam-ownership-rework` · **HEAD:** `6a7ae6c2` · **Tree:** clean
**Scope:**
- `_bmad-output/sprint-artifacts/dark-factory-v5/stories/df6-1a-pr-feedback-bounded-fix-attempt.md`
- `_bmad-output/sprint-artifacts/dark-factory-v5/stories/df6-1b-fix-loop-verdict-attempt-budget.md`

Clean protocol held: no wave8/wave6/verify/scan evidence, no tracker, no HANDOFF files, no
seam-ownership directory read. Inputs were the two specs, the codebase, the tests, and (for
cross-story seam claims only) two anchors each in DF3.7 / DF5.2 / DF5.3 / DF5.5 / DF6.2 story files
and the decision register.

## Method — what was opened at source

**Code (all claims traced to the shipped tree):**
`src/providers/run-record.ts` (`EXTENSION_NAMESPACES.fixLoop` at :219, `FieldKind` :54, `CORE_FIELDS`
:92, `assertNoSecret` :688–743 incl. prefix-boundary regex and `mixedClass` conjunct at :737–738,
`SECRET_PREFIXES` :572–610 incl. the `ghs_` clone-URL comment :578–583, `assertKind` message shapes,
`RunRecordStore` public surface :1468–1726, `RunRecord`/extensions schema — zero `exitStatus` on the
record) · `src/providers/step-log.ts` (:14 import, `PEM_BLOCK_RE` :108, `SECRET_PREFIX_RE` :113,
`LONG_TOKEN_RE` :117, `redactSecrets` :225) · `cli-anything/src/redact.ts:62` · `src/pr/push.ts`
(`PushOutcome` :120–123, `assertPublishableRef`/`REF_SEGMENT_RE`/`target-ref-outside-namespace`
:65–87, `defaultTargetRef` :40, `already-present` arm :486–489, `no-repo-slug` :342 reading
`extensions.budget.repoSlug`, `merge-base --is-ancestor` :513, `gitEnv` :176) · `src/pr/github.ts`
(`GitHubApi` exactly 4 members :32–48, `httpGitHubApi` :128, `readHostToken` :176 with the
out-of-`process.env` comment) · `src/pr/body.ts` (:14 import, :87 env-map validation comment, :135/
:160, 65,536 doc :17) · `src/pr/repos.ts` (`DEFAULT_REPOS_FILE` :16, `resolveRepoEntry` :107) ·
`src/fleet/brief-schema.ts:305` · `src/phase-engine/roster/schema.ts` (:22–23 header, :56–57
`writes: string[] | null`) · `scripts/lib/run-lock.ts` (`acquireRunLock` :991, reentrancy guard
:1008, `withRunLock` :1080) · `scripts/fleet.ts` (acquireRunLock call sites :2153/:4809, `GATE_VERBS`
:3367) · `src/fleet/verbs.ts` (harvest exit-5 note :129) · `src/fleet/run.ts` (:5–7, `sudo -n`
rationale :31–39) · `src/fleet/status.ts` (`readMarkerVerdict` imported; no `store.set`) ·
`src/providers/teardown.ts:12` · `src/providers/cost-ledger-bridge.ts` · `src/fleet/fanout-primitive.ts`
(`issue-ceiling-insufficient` :504–506 with the pluralized n-arms message; `FleetLock` single
instantiation :396) · `src/fleet/approval-gate.ts` (absent-not-zero convention; `expiredState`
:1003; approval binds `reportId` :1443–1444) · `src/reverify/runner.ts` (`requestApproval` proposal
:461–462; `claimed.changedFiles` read ~:148–161; zero occurrences of "brief") · `src/fleet/dispatch.ts`
(brief consumed in-memory; `extensions.budget` repoSlug/issueId :943–944/:1043–1044; no host-side
brief persistence) · `src/providers/cap-rejection.ts:18` (`InBoxExit` = success/transient/overflow/
logic/lead_failure) · `src/phase-engine/phases/dispatch-task.ts` (`QDS_TEAM_RUNNER` refusal :372–380,
`exitStatus: "logic"` :144) · `src/providers/exedev/fill.ts` (bundle-push default :15–17/:34–41,
userinfo refusal :161–165, host-side bundle half :401+) · `src/providers/credentials.ts:92`
(`KEY_ENV_FILE = "app/.env"`) · `tests/fleet/e2e/live-harness.ts:65` (`liveGate(tier: "1" | "2")`,
throw-not-skip) · `tests/fleet/dispatch.test.ts` concurrent-dispatch block :1660–1712 ·
`tests/pr/helpers.ts` (GitHubApi fake) · `config/rosters/roster.yaml` (two roles) · `package.json`
:25/:30 · all six verification-surface scripts (`ls`).

**Absence claims (each with a positive control run with identical machinery):**
`src/fixloop/`, `src/audit/`, `src/fleet/run-completion.ts`, `.factory/fix-scope.json` absent (`ls`;
control: `ls` finds `src/fleet/fleet-lock.ts`, `scripts/reverify.ts` et al.) · `observeAndDriveChain`
0 in src/+scripts/, `walkAuditChain` 0 in src/, `allowedPath|allowed-path|allowlistPaths|
pathAllowlist` 0 in src/+scripts/, `\.writes` 0 production consumers in src/ (controls: same grep
finds `pushVerifiedSha` ×3 files, `recordAuditLink` exactly the teardown.ts:12 comment, `writes`
declarations in roster/schema.ts).

**Story/spec anchors read (seam claims only):** DF3.7 `INV-IBOX-16` (names DF6.1a as the third
sanctioned caller, verbatim including "the lock lives in the caller, never in this module"); DF5.2
`INV-PR-5/6/7`; DF5.3 `INV-AUDIT-6` + "Ten hops *per contributing runId* (DF6.1b reciprocal)" +
Files-to-Modify `src/audit/chain.ts`; DF5.5 P1.18 disposition (":232 — L50 handed to DF6.1a; 17/23/25
kept"); DF6.2 story exists (refusal-verdict integrity); decision register DD-1/DD-2/DD-2a/DD-8/DD-10;
`R2-surviving-clauses.md` §10; `p1-19` :29/:30/:31/:32/:39/:52/:53/:54; `p1-18` :36/:50; tier-2 ADR
:48; `qds-live-e2e` SKILL Hard rules + `keyLeakProblems`.

**Unverified-external (not findings):** the 2026-09-08 live measurement of
`gh pr view --json statusCheckRollup`'s per-entry fields against PR #237; `gh pr checks`' exit-8 and
empty-required-set message text; the gh 2.93.0 floor. No GitHub API calls were made.

## DF6.1a — findings (most severe first)

| ID | Severity | Class | Claim at issue | Evidence (symbol/anchor) |
| --- | --- | --- | --- | --- |
| DF6.1a-1 | **BLOCKER** | C3 | AC3 + Overview + "Wiring closed": invocation 2 "resolves this attempt's fix run through the parent-run join plus DF6.1b's attempt-time `fixAttemptRunIds` ledger", and the story claims to be buildable "using only code merged by this story plus its predecessors" | The ledger does not exist at this story's merge point and this story forbids itself from creating it: `EXTENSION_NAMESPACES.fixLoop` registers only `fixContext`/`fixOutcome` (`src/providers/run-record.ts:219`); DF6.1a Files-to-Modify says `run-record.ts` "**no change expected**"; the `fixAttemptRunIds: "strings"` registration is DF6.1b's "one adds-only registration", and DF6.1b is sequenced **after** DF6.1a. `RunRecordStore` exposes no query-by-extension (verified surface: `path`/`lockPath`/`create`/`get`/`set`/`close`/`list`/`listWithAnomalies`, keyed by runId); `fixOutcome` is write-once-at-terminal (absent pre-terminal by DF6.1b's own design); no parent→fix link exists anywhere (the brief's `issueId`/`repoSlug` ride `extensions.budget` but are not a link and not queryable); the only fallback — a `list()` sweep — is unsanctioned (DF6.1b's "Attempt bookkeeping" rejects sweeps; DF6.1a specifies no alternative). So the story's make-or-break invocation-2 leg (scope check → `pushVerifiedSha` → `fixContext`) cannot be built as written, and "Wiring closed" is false. Fix is cheap but crosses the seam: DF6.1a must own registration + dispatch-time append — which then collides with DF6.1b's "one adds-only registration" ownership claim |
| DF6.1a-2 | **HIGH** | C3 | AC2 + Files to Modify: `src/reverify/runner.ts` "adds only — the `requestApproval` proposal string varies **when the run carries a `fixContext` brief key**" | The trigger is unobservable in the mandated module. `src/reverify/runner.ts` contains zero references to any brief (grep); the run record carries no brief (13-field `CORE_FIELDS`, `run-record.ts:92`; extensions `approval/pr/fixLoop/fanout/budget` — no brief, no fix marker; no `exitStatus` anywhere on the record); the brief is consumed in-memory by `src/fleet/dispatch.ts` and delivered in-box, never persisted host-side; and the fix run's own `extensions.fixLoop.fixContext` is written only **after** `pushVerifiedSha` (DF6.1a AC4) — i.e. after `requestApproval` has already fired (`src/reverify/runner.ts:461-462`, hard-coded proposal `open a PR for run ${runId} at ${report.headSha}`). At approval time nothing distinguishes a fix run to `runner.ts`. Satisfying the AC requires plumbing a marker through DF3.7's chain or DF5.1's port — neither is in this story's closed edit list ("No other behavior changes") |
| DF6.1a-3 | MEDIUM | C2 | Inherited briefing, DF13 fleet-ceiling TOCTOU "Re-verified 2026-09-08 at `fa7d0e26` — the residue is substantively TRUE … plain `dispatch()` still holds no fleet lock and the ceiling race is still open … **Do not delete the red-by-design pin in `tests/fleet/dispatch.test.ts`**" | False at `fa7d0e26` and at HEAD. The race was closed 2026-08-25 by `99f591e3` ("close the in-process fleet-ceiling admission TOCTOU"), a verified ancestor of `fa7d0e26`. The current test (`tests/fleet/dispatch.test.ts` :1689–1712, two dispatches at `maxVms: 1`) asserts exactly ONE winner, loser exit 5 `no-headroom`/`vm-ceiling`, one record/one box, and its comment names "the overshoot precondition **the old pin** relied on". The `FleetLock`-single-instantiation half still holds (only `fanout-primitive.ts` instantiates it, :396); the invalid step was inferring "no `FleetLock` in dispatch ⇒ race open". A dev following the story hunts a pin that no longer exists and believes a fixed defect |
| DF6.1a-4 | LOW | C1 | Overview: the CLI "puts the run in `review_feedback_detected`" | That is P1.18's webhook-era protocol state (verified present only in `p1-18`, zero occurrences in `src/`/`scripts/`/`tests/`). At the comment-read moment no run exists (the fix run is minted at dispatch) and no state machine is in the closed edit list. The payload-shape citation (`p1-18:36`) itself is accurate |
| DF6.1a-5 | LOW | C1 | E2E Slice "Demonstrable behavior": "the single-fixer roster (lead + one write-capable fixer + read-only analyst)" | `config/rosters/roster.yaml` ships exactly two roles (defaults `writes: []`; `fixer` `writes: ["src/","tests/"]`). The story's own Technical Notes say the analyst "is required by none" and that adding one would edit a shared TIER-2 fixture outside the Files-to-Modify — the slice line contradicts the story's own notes and invites exactly that edit |
| DF6.1a-6 | LOW | C1 | Locality DoD: two quotes attributed "in the ADR's own words" | First quote ("Seven review rounds (~260 findings) missed it…") is verbatim at `2026-08-31-tier2-placement-adr.md:48`; the second ("*survived seven review rounds precisely because no AC tested locality*") appears nowhere in the ADR (grep "survived" = 0). Presented as a quotation, it is a paraphrase |

## DF6.1b — findings (most severe first)

| ID | Severity | Class | Claim at issue | Evidence (symbol/anchor) |
| --- | --- | --- | --- | --- |
| DF6.1b-1 | **HIGH** | C3 | AC2 uncharged ceiling + DoD "Test (uncharged-attempt ceiling)": "three **recorded** uncharged attempts (any mix of `transient`, `lead_failure`, `approval-timed-out`, `dispatch-refused`) → the fourth invocation … escalates with every **recorded classification** listed"; and "`out-of-scope-diff` is capped at 1" | The per-attempt classification record these clauses mandate has no home in any declared state. Verified: the record vocabulary is closed (`CORE_FIELDS` 13 fields; extensions `approval/pr/fixLoop/fanout/budget`; `fixLoop` = `fixContext`/`fixOutcome` only, `run-record.ts:219`; zero `exitStatus` on the record); DF6.1b's own edit is exactly one adds-only registration (`fixAttemptRunIds: "strings"` — runIds only, no classifications); `fixOutcome` is write-once-at-terminal, absent while the loop continues; DF6.1a forbids refusal-shaped record fields (its `flags`-is-log-only note, anchored to the same two-field registry); the ledger is appended only "at that attempt's dispatch", so a `dispatch-refused` attempt (which "provisions nothing") never reaches it; classifications otherwise live only in trace rows and log lines, unqueryable by the next invocation (no query-by-extension). The **charged** ceiling is derivable (fixContext present + loop continued ⇒ charged) — the uncharged ceiling, the classification list, and the out-of-scope-diff occurrence count are not. Compounding contradiction: AC2 says a deterministic refusal "escalates **immediately**" (terminal) while the DoD accumulates three of them — the two readings cannot both hold without the missing storage |
| DF6.1b-2 | MEDIUM | C2 | Observability Contract: "An escalation additionally logs its classification: `ci-red`, `ci-verdict-unavailable`, `approval-timed-out`, `dispatch-refused` (DF6.2 `logic`), `transient`, `lead_failure`, or `out-of-scope-diff`" | The enumerated escalation vocabulary omits two classifications the story itself mandates as escalations: `scope-requires-privilege` (AC2: "escalates on first occurrence naming the denied paths and the matched deny rule") and `bot-response-to-fix` (Technical Notes "closed here explicitly" + DoD "Test (no bot ping-pong)"). A log consumer keyed on this normative enumeration misses two mandated terminal states |
| DF6.1b-3 | MEDIUM | C3 | Attempt bookkeeping: the ledger is "appended with each attempt's fixRunId **at that attempt's dispatch**"; AC2's survival case: "a charged attempt-1 failure leaves the parent record carrying a **populated ledger** and no `fixOutcome`" | Attempt 1's dispatch is DF6.1a's code, and DF6.1b's Files-to-Modify for `scripts/fix-run.ts` names only "the recorded-attempt **read** … the budget check … the `fixContext.attempt` value … the post-push CI poll call … and the escalation call" — no append — while stating "Beyond that call site, DF6.1a's two-invocation drive path is **unchanged**." As written, no half owns the attempt-1 ledger append, so the populated-ledger state AC2 depends on is unreachable. Cross-ref DF6.1a-1 (same seam; resolves if DF6.1a takes registration + append) |
| DF6.1b-4 | LOW | C1 | Attempt bookkeeping: "one `gh pr view --json headRefName` (**a call this story already makes per poll**)" | The poll as specced in AC1/Infra Prerequisites requests only `headRefOid`; `headRefName` is not a field any named call fetches. Trivially repairable by widening one `--json` list — but the "already makes" claim is currently false |
| DF6.1b-5 | LOW | C1 | Evidence-bearing line cites in "Two corrections of record" and the DF5.3 anchor | `scripts/fleet.ts` `acquireRunLock` sites cited `:1976`/`:4257` are `:2153`/`:4809` at HEAD; `GATE_VERBS` cited `:3005-3007` is `:3367`; `fanout-primitive.ts` `FleetLock` cited `:360` is `:396`; DF5.3's Files-to-Modify cite `:168` is `:366`; `team-lead-driver.ts:365` is `:373`. All five substantively HOLD (exactly two lock call sites; exactly the five gate verbs; single `FleetLock` instantiation; DF5.3 lists `src/audit/chain.ts`; the changedFiles instruction exists) — only the line numbers moved |

## Verdicts

**DF6.1a — NOT CONVERGED** (confidence: **high**).
One BLOCKER: the story's own invocation-2 resolution mechanism (AC3, Overview, Wiring-closed) reads a
parent-record field its own closed edit list forbids creating and whose owner is sequenced after it —
the split seam, the story's load-bearing joint, is unbuildable as written at this half's merge point.

**DF6.1b — NOT CONVERGED** (confidence: **high**).
One HIGH: the uncharged-attempt ceiling, the classification vocabulary, and the `out-of-scope-diff`
cap of 1 mandate per-attempt classification persistence that no declared state can hold and no
story's edit list provides for — the termination matrix this half exists to bound is partially
unimplementable as specified.

## What HELD (positive verification)

- **Redactor disambiguation is exact.** `src/providers/step-log.ts:225` is the pattern redactor
  (`redactKeyManagementUrls` first, `PEM_BLOCK_RE` :108, `SECRET_PREFIX_RE` :113 driven by the same
  frozen `SECRET_PREFIXES` imported at :14, `LONG_TOKEN_RE` :117); `cli-anything/src/redact.ts:62` is
  the known-value one and provably returns text unchanged when the map is empty. `src/pr/body.ts:14/
  :135/:160` imports the known-value one for its own correct job; the :87 env-map comment says in its
  own words what the specs claim. Every line cite in this cluster is exact.
- **The record-schema claims are exact.** `FieldKind` = `"string"|"int"|"ports"|"strings"` at :54; no
  object kind; `assertKind` throws `schema-rejected: <key> must be a string` on objects;
  `fixLoop` pre-registered with exactly `fixContext`/`fixOutcome` "string" at :219; the prefix scan
  runs at token boundaries `(^|[^A-Za-z0-9])<prefix>` and the `mixedClass` conjunct
  (`lower && upper && digit`, :737) means an all-lowercase 40-hex sha passes — the specs' INV-7
  pre-flight reasoning is correct against the shipped scanner, and the DoD's quoted error message
  (`refusing to write key material into the run record: <key>`) is verbatim.
- **`SECRET_PREFIXES` claims hold**: `ghs_` present with the `x-access-token:ghs_…@github.com/org/repo`
  clone-URL comment at :578–583; `AIza` present with the 39-vs-40-floor rationale — matching both
  halves' egress fixtures and the "living list" digest argument.
- **Push machinery claims all hold**: `PushOutcome` is exactly the three-arm union (`{ok:true,sha,
  targetRef,pushed}` / `{ok:false,refusal}`), `pushWithPreflight` returns `false` on
  tip-equals-verified logged `outcome: "already-present"`, `RefusalRecord.failedPrecondition` exists,
  `assertPublishableRef` is the `refs/heads/qds/` allow-list with per-segment grammar refusing
  `target-ref-outside-namespace` as a security event, `defaultTargetRef` → `qds/<runId>`,
  `no-repo-slug` fires from `extensions.budget.repoSlug` at :342, `merge-base --is-ancestor` at :513,
  `gitEnv` keeps the token child-env-only (:176) — the exact precedent DF6.1b cites for its `gh`
  child-env token.
- **The lock story is true**: `acquireRunLock`/`withRunLock` in `scripts/lib/run-lock.ts`;
  `RunLockReentrantError` thrown by the guard at the head of `acquireRunLock` (:1008); `scripts/
  fleet.ts` has exactly two call sites (dispatch key-mint on the just-minted id :2153, `runDestructive`
  :4809); `GATE_VERBS` = exactly `approve/reject/enrol/unlock/attach` taking no lock; `verbs.ts`'s
  harvest descriptor carries the exit-5 "the run lock refused, so the verb never ran" note verbatim;
  DF3.7's `INV-IBOX-16` already names DF6.1a as the third sanctioned automatic caller with "the lock
  lives in the caller, never in this module" verbatim.
- **The DF3.7 hard-edge narrative is accurate**: `src/fleet/run.ts:5-7` says verbatim "It never walks
  a phase, never holds the run"; `observeAndDriveChain` has zero occurrences (positive-controlled);
  `run-completion.ts` absent; `fleet status` reads the marker through `readMarkerVerdict` and never
  `store.set`s; the `sudo -n` substrate precedent is documented inside `run.ts` itself.
- **AC5's guard rests on verified ground**: `ResolvedRole.writes` is `string[] | null` with the
  header refusing to infer `null` from silence (:22–23/:56–57); zero production `.writes` consumers
  (positive-controlled) — "AC5 is the guard, AC6 is the enforcement" is a fair description of the tree.
- **The verification-surface deny-list is pointed at real files**: all six (`scripts/reverify.ts`,
  `phase0-exit-gate.ts`, `roster-check.ts`, `pi-lens-verify.ts`, `lsp-verify.ts`, `fleet.ts`) exist;
  `package.json:25`/`:30` are exactly `verify:pi-lens`/`verify:lsp`; `resolveRepoEntry`/
  `DEFAULT_REPOS_FILE` sit where the spec says and allowlist repos+base, not paths; no
  path-allowlist artifact exists anywhere yet (positive-controlled), so `.factory/fix-scope.json` is
  genuinely net-new.
- **DF6.2/DF1.3 vocabulary is real**: `InBoxExit = "success" | "transient" | "overflow" | "logic" |
  "lead_failure"` (`src/providers/cap-rejection.ts:18`); the `QDS_TEAM_RUNNER` refusal and
  `exitStatus: "logic"` live in `dispatch-task.ts` as the specs say.
- **Cross-story seams agree**: DF5.2's `INV-PR-5` ("no push path that skips the gate"), `INV-PR-6`
  (merge-base append-only), `INV-PR-7` all as cited; DF5.3's `INV-AUDIT-6`, the "Ten hops *per
  contributing runId* (DF6.1b reciprocal)" note, and its Files-to-Modify `src/audit/chain.ts` all
  exist; DF5.5's disposition hands `p1-18:50` to DF6.1a while keeping :17/:23/:25; DD-2a assigns the
  `p1-18:50` edit to DF6.1a exactly as both halves claim; `p1-19` :29–:32/:39/:52/:53/:54 and
  `p1-18` :36/:50 all read as characterized; R2 §10 exists at the named heading; `liveGate` takes
  only `"1"|"2"` and throws on a half-configured env (`live-harness.ts:65`); the approval namespace
  binds `reportId` and has `expiredState` (`approval-gate.ts`), supporting the `approval-timed-out`
  terminal-state claim.
- **Cost wiring claims hold**: `cost-ledger-bridge.ts` drives `ingestCostEvent` per harvested
  `cost_attribution` line; `KEY_ENV_FILE = "app/.env"` matches INV-3's `/home/exedev/app/.env`;
  the absent-not-zero sub-timings convention lives in `approval-gate.ts` as cited.
- **Correctly stated absences**: `src/fixloop/`, `src/audit/`, `run-completion.ts`,
  `.factory/fix-scope.json`, and the `allowedPath*`/`fix-scope-missing` symbols do not exist;
  `walkAuditChain` appears nowhere in `src/` and `recordAuditLink` only in the `teardown.ts:12`
  comment — every such claim in both specs is true at HEAD.

## Summary counts

| Severity | C1 citation | C2 semantic | C3 structural | C4 marginal | Total |
| --- | --- | --- | --- | --- | --- |
| BLOCKER | 0 | 0 | 1 | 0 | **1** |
| HIGH | 0 | 0 | 2 | 0 | **2** |
| MEDIUM | 0 | 2 | 1 | 0 | **3** |
| LOW | 5 | 0 | 0 | 0 | **5** |
| **Total** | **5** | **2** | **4** | **0** | **11** |

DF6.1a: 1 BLOCKER (C3) · 1 HIGH (C3) · 1 MEDIUM (C2) · 3 LOW (C1) — NOT CONVERGED
DF6.1b: 1 HIGH (C3) · 2 MEDIUM (1 C2, 1 C3) · 2 LOW (C1) — NOT CONVERGED

Residue is C1-dominant at LOW, as the campaign target requires, but the two C3 mechanism gaps sit
directly on the pair's shared seam (parent↔attempt record lifecycles) and are not residue.
