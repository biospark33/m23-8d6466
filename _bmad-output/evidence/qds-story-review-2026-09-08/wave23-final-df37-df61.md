# Wave 23 — Final Confirming Verifier: DF3.7 · DF6.1a · DF6.1b

**Date:** 2026-09-15 · **Branch:** `dev` @ 4264f546 + uncommitted spec edits (reviewed as-is)
**Role:** clean-eyes final confirming round (Wave 23). No prior review material read.
**Lens:** internal consistency of the just-settled contracts, checked exhaustively:
(1) DF3.7's `ChainOutcome` union ↔ exit table ↔ AC5 ↔ Observability ↔ DoD ↔ negative controls;
(2) the DF6.1a/DF6.1b per-issue sizing formula; (3) DF6.1b's bounds; (4) cross-story seam claims.

---

## Method

- Read all three specs end to end. Reviewed the working tree as-is (branch `dev` @ 4264f546 plus uncommitted spec edits). Markdown specs awaiting dev — no implementation expected.
- Opened at source every named symbol, constant, flag, code, fixture, path and citation that bears on the four lens items. Traced call paths; did not trust citations.
- Every zero-match claim re-run with a positive control using identical machinery (see below). No bare greps.
- Citations in this report are by symbol or section anchor only.
- No test suite run (spec-only round; the stories' own named test files were existence-checked only: `tests/fleet/approval-gate.test.ts`, `tests/fleet/fanout-primitive.test.ts`, `tests/providers/exedev/read-box-file.test.ts` — all present). No `bun test`, no `gitnexus analyze`.

**Positive controls (identical machinery, known-match term):**

| Zero-match claim | Result | Control (same machinery) | Result |
| --- | --- | --- | --- |
| `approval` in `scripts/pipeline-run.ts` = 0 | 0 ✓ | `run` in same file | 580 ✓ |
| `allowedPath\|allowed-path\|allowlistPaths\|pathAllowlist` in `src/`+`scripts/` = 0 | 0 ✓ | `allowlist` same scope | 178 ✓ (incl. the `src/pr/push.ts` comment the story quotes) |
| `\.writes` in `src/` (production consumer) = 0 | 0 ✓ | `writes` same scope | 157 ✓ |
| `observeAndDriveChain` in `src/`+`scripts/` = 0 | 0 ✓ | `readMarkerVerdict` in `src/` | 14 ✓ |
| `walkAuditChain` in `src/` = 0 | 0 ✓ | — (pair below) | — |
| `recordAuditLink` in `src/` = 1, in a comment | 1, `src/providers/teardown.ts` (the DF5.3 comment) ✓ | `audit` in same file | matches ✓ |
| `runMarkerPath` in `src/fleet/fanout-primitive.ts` import specifiers = 0 | 0 — both occurrences are prose in `boxMarkerPath`'s docblock ✓ | `boxRunRoot` import | present ✓ |
| `observe` in `src/fleet/verbs.ts` = 0 | 0 ✓ (DF3.7 adds it) | `dispatch` verb descriptor | present ✓ |
| `src/audit/`, `src/fixloop/`, `tests/fixloop/`, `.factory/` absent | all absent ✓ | `src/fleet/` | present ✓ |

**Cross-story reads (named seam claims only, per scope):**

- **DF3.8's consumption contract** — Deviation 1 (reaper `record-claim-refused` guards destroy only; `stale-record` → `teardown`, three sites one per enumeration loop; `staleAfterMs` 4 h), AC2(a) candidate filter (`closedAt` unset, box live), AC3's `completion-unwitnessed` arm refusing unconditionally with no witnessed re-entry, the `run-lost-to-reboot` arm's `startedAt` dependency mirroring DF3.7's Technical Notes flag, the three sanctioned automatic callers, `maxTicks: 1`, and DF3.8's statement that DF3.7's AC5 extension refusal is evaluated after acquisition.
- **DF2.11's lock record** — "DF3.8's sweep is the eighth call site"; `RunLockHandle` branded, producible only by `scripts/lib/run-lock.ts`.
- **DF5.1's reverify surface** — 30-minute wall-clock cap, `green`/`red`/`error` verdicts, `nothing-to-verify`, `ApprovalPort`, single approval owner.
- **DF5.2's INV-PR clauses** — INV-PR-1 (credential containment / token out of environment), INV-PR-5 (no bypass; fix append needs its own approval), INV-PR-6 (append-only, `git merge-base --is-ancestor`), INV-PR-7 (purpose-built map, never `process.env`).
- **DF5.3's INV-AUDIT-6** — named broken hop; hop 1 from the PR; "Ten hops *per contributing runId*"; Files to Modify lists `src/audit/chain.ts`; "DF5.3 is an edge of DF6.1b only".
- **DF5.5's P1.18 disposition** — KEEP but UNSCHEDULED; two-limb severance citing both halves; `:50` handed to DF6.1a; lines 17/23/25 kept by DF5.5.
- **DF6.2's refusal vocabulary** — the refusal class list and `exitStatus: "logic"` verdict semantics.
- **Decision register** — DD-1, DD-2, DD-2a, DD-8, DD-10.
- **`p1-18-pr-comment-polling.md`** — not a cross-story dependency; it is DF6.1a's own Files-to-Modify edit target (`:50` repoint) and shape-citation source (`:36`), so opened to confirm the edit target and quoted text.

**Not verifiable in-repo (noted, not counted):** DF6.1b's measured `gh pr view --json statusCheckRollup` field list (PR #237, measured 2026-09-08) and the gh 2.93.0 floor — external-GitHub claims; the field list is consistent with the GraphQL check-run shape and the story derives its design from the measured surface, so nothing in-repo contradicts it.

---

## Findings

### DF3.7 — Approval-Gate Bridge

| ID | Class | Sev | Finding |
| --- | --- | --- | --- |
| DF3.7-W23-1 | C4 | LOW | **Exit-6's defining gloss is narrower than its own enumeration for pre-close `chain-failed`.** The exit-table entry reads "6 = the chain landed and what failed came after it: … a `chain-failed` throw at any chain step …", and the union's `chain-failed` arm explicitly includes `teardownSandbox`'s harvest and destroy steps aborting "with the record still open" — steps at which the chain has *not* landed. AC5's trailing negative-control gloss repeats the narrower "…`chain-failed` the post-close throw". The mapping itself (any chain step, pre- or post-close → exit 6) is stated identically in the union, the exit-table enumeration, the DoD leg ("a chain-step throw — at any chain step, pre- or post-close") and the Observability kind list, and no other exit's gloss could absorb a mid-chain throw (exit 5 is "refused before anything was mutated"), so no implementable ambiguity survives — but the two glosses should carry the union's "at any chain step" wording. |
| DF3.7-W23-2 | C4 | LOW | AC2(a)'s wall-clock parenthetical "(90 s on the AC5 defaults)" mislabels whose defaults these are: the constants are the fan-out INV-6 defaults (`DEFAULT_POLL_INTERVAL_MS`, `DEFAULT_PER_CALL_DEADLINE_MS`), a Technical Notes subject; AC5 is the pre-flight/lock AC and names no default. Arithmetic verified: 6 × (5 000 + 10 000) = 90 000 ms. No implementability risk — both constants are named in the same sentence. |

**What HELD (DF3.7)** — verified at source, not trusted from citation:

- **The union ↔ exit table ↔ AC5 ↔ Observability ↔ DoD state one mapping.** Seven kinds, each with a producer and an exit: `driven`/0, `unsettled` (exit derived per code: 1 for the transient pair `run-completion-unobserved`+`box-unreachable`, 5 for `run-engine-dead`), `refused`/5 (and exit 4's producer before the module), `vetoed`/6, `approval-failed`/6, `chain-failed`/6, `handed-off`/6. The three typed terminal fills stay distinct exactly as the negative controls demand: window expiry and the unusable streak both yield `run-completion-unobserved` (AC3's arm), the skip streak yields `box-unreachable`, `run-engine-dead` is its own code at exit 5 — matching AC2(a)'s "a distinct code from AC3's `run-completion-unobserved`".
- **AC5's pre-flight order is consistent at all three statements** (AC5 body, AC2(d)'s negative control, DoD): extension state → `pausing` routing → `closedAt`; `pausing` is not a refusal, does not enter the poll, and routes to `promoteStrandedPause`, which is one of exactly two exported entries and the only re-entry — DF3.8's collected-record arm refuses unconditionally (DF3.8 AC3 verified: "no witnessed re-entry", record re-read before the chain's only marker read — the same no-producer-of-`true` rationale DF3.7's union gives for omitting `markerWitnessed`).
- **The verdict mapping is the shipped classifier, verbatim.** `classifyMarkerRead` (`src/fleet/fanout-primitive.ts`): probe exit ≠ 1 → `skip` (`marker-probe-failed`; 255/137 named in its docblock); `unreadable` → `unusable` (`marker-read-failed`; exitCode −1 → `marker-read-budget-exhausted`); `oversized` → `marker-oversized`; unparseable / null / primitive / non-boolean `ok` → `marker-unreadable`; present-but-non-string `runId` → `marker-run-id-invalid`; mismatch → `marker-run-mismatch` only when `expectedRunId` passed. All three codes the Observability contract names for redaction exist. `readMarkerVerdict(driver, vm, boxMarkerPath(runId), deadlineMs, runId)` matches the shipped signature; `PROBE_SKIP_TICKS_LIMIT` = 6, `MARKER_UNUSABLE_TICKS_LIMIT` = 3, `markerUnusableGivesUp`, the same-tick corroboration rule ("the streak is only ACTed on with corroboration… nothing to corroborate against"), and the "INV-6 finite caps (imported constants — never mirrored literals)" section header all verified.
- **`unitActivity` liveness arm** matches the code exactly: `failed` terminal, `inactive`/`unknown` not, the default branch's own comment "Includes `unknown` (systemd's own word for a unit it has never loaded)", 137/255 → `unknown`.
- **Citations verified:** `status.ts` imports `expiredState` from `./approval-gate.ts` (the barrel-reach claim); `fleet/index.ts` star-exports exactly 8 modules incl. `status.ts` and none of the gate's symbols; `approval.ts` imports the gate and defines `ApprovalState` with the five members DF3.7/DF6.1b's ladder names (`pausing | awaiting-approval | approved | rejected | timed-out`); `ApprovalOutcome`'s non-null arms are exactly `pause-in-progress | already-decided | rebound`; `runner.ts` — non-green returns before the gate, the `recordApprovalPort` fallback with no `teardown` seam, the `pausing` reportId byte-compare, `requestApproval` as the sole production caller, the `approval-request-failed` flag flattening; `recordApprovalPort` builds `GateDeps` from opts only (no teardown injected); `hostRoot ?? process.cwd()` + `resolveRunsDir`; `scripts/reverify.ts`'s call; `pipeline-run.ts` zero `approval` (with control); `verbs.ts` dispatch summary and the registry-contract comment; `journal.ts` — `runMarkerRoot`/`assertRunIdPathComponent`/`runMarkerPath`/`unidentifiedMarkerPath` (`ENGINE_MARKER_FOREIGN` prose)/`writeTerminalMarker`, no production `QDS_RUN_ROOT` writer, and `src/phase-engine/index.ts` explicitly withholding `runMarkerPath` from the barrel; `RunOutcome.completedAt` is a required `string`; `boxMarkerPath`'s historical-defect docblock quotes verbatim; the service file `Type=simple`/`Restart=no`/`RuntimeDirectory=qds-run/%i/…`/`RuntimeDirectoryPreserve=yes` at the cited lines; reaper `aged()`/`stale-record`/`record-claim-refused` and `quota.ts` `staleAfterMs` = 14 400 000; `RunLockReentrantError`/`acquireRunLock` in `scripts/lib/run-lock.ts`; `stampCorrelation` in dispatch; `worktree.ts`'s F064 `withGuards` descendant sweep; test files exist.
- `awaitDecision` gains no production caller (all `src/`+`scripts/` occurrences are the gate module's own definition/comments — consistent with the "MUST NOT gain one here" rule).

### DF6.1a — PR Feedback → Bounded Fix Attempt → Verified Append

| ID | Class | Sev | Finding |
| --- | --- | --- | --- |
| DF6.1a-W23-1 | C4 | LOW | The brief's `botComments[]` shape is stated as "the shape P1.18 defines (`p1-18-pr-comment-polling.md:36`)", but P1.18's shape is `[{commentId, author, bodySnippet, timestamp}]` and the brief's is `[{commentId, author, bodySnippet}]` — the `timestamp` field is dropped without a note. Nothing breaks (the record carries IDs + digest only and `fixContext` never needs the stamp; the brief schema is this story's own adds-only key), but "the shape P1.18 defines" overstates fidelity by one field. |

**What HELD (DF6.1a):**

- **The sizing formula is character-identical at all three statements** (Technical Notes, the answered Open Question, the DoD leg) — `parentSpend + 2 × perAttemptCap + (unchargedCeiling + 3) × perDispatchSpendCap` (one statement line-wrapped, tokens identical). Both rate terms are defined in place: `perAttemptCap` ("the per-attempt budget DF6.1b's AC2 charges") and `perDispatchSpendCap` ("the uniform per-dispatch reservation the shipped gate computes (`admittedCeiling = min(keyCap, remaining)`)"), and `admitIssue`/`issueBudgetSnapshot`/`admittedCeilingMicroUsd`/`issue-ceiling-insufficient` (fan-out path) all verified in source. The constant `+3` counts all three zero-charge reserving boxes at **every** statement in both halves (dispatch-refused, out-of-scope-diff, scope-requires-privilege), and DF6.1b's AC2 and DoD legs repeat it identically. The box enumeration "2 charged + 3 uncharged + 1 dispatch-refused + 1 out-of-scope-diff + 1 scope-requires-privilege" sums to the stated eight, is consistent with DF6.1b's ceilings (2 charged, 3 uncharged, cap-1 / at-most-once per PR on the other three), and the "reachable maximum is five-to-six … stays conservative" remark is arithmetically sound.
- **Single-fixer guard vs the shipped three-state roster schema:** `src/phase-engine/roster/schema.ts` declares `writes: string[] | null` with the header refusing to infer from silence; the three-state contract (`[]` none / non-empty scoped / `null` unrestricted) and the `writes !== null ? writes.length > 0 : true` spelling match the code and the negative controls; the shipped `config/rosters/roster.yaml` is lead (`writes: []` via defaults) + one write-capable fixer, exactly the shape the DoD's reference-compare control cites.
- **`.factory/fix-scope.json` read via `readGuardedFile`** (`src/providers/allowlist-path.ts`) — the symbol exists and is the same discipline `src/pr/repos.ts` uses for `.factory/repos.json`; `resolveRepoEntry`/`DEFAULT_REPOS_FILE` verified; the "no shipped path-allowlist" zero-match claim holds with control.
- **Redaction mandates verified at the cited lines:** `redactSecrets(text, keep?)` pattern redactor at `src/providers/step-log.ts`; the known-value `redactSecrets(text, parentEnv)` at `cli-anything/src/redact.ts`; `src/pr/body.ts` imports the cli-anything one and calls it twice (DF5.2's correct-for-its-job precedent); `SECRET_PREFIXES` frozen with `ghs_` and the clone-URL comment; the shape heuristic's `mixedClass` conjunct requires lower **and** upper **and** digit (an all-lowercase 40-hex sha fails it) and its charset excludes JSON punctuation — both exactly as the story claims; `SHAPE_EXEMPT_PATHS` exists as a real mechanism, so "no entry added to it" is a meaningful constraint; `IMMUTABLE_FIELDS` stamps `createdAt` once.
- **Registration-exactness:** `src/providers/run-record.ts` pre-registers exactly `fixLoop: { schemaVersion: 1, fields: { fixContext: "string", fixOutcome: "string" } }`; `FieldKind = "string" | "int" | "ports" | "strings"`; DF6.1a's adds-only three (`fixAttemptRunIds: "strings"`, `fixRun: "string"`, `fixOutcomeClass: "string"`) are consistent with DF6.1b's reader-side disclosure and the forward-dependency note.
- **Push seam:** `pushVerifiedSha`/`PushOutcome`/`assertPublishableRef`/`defaultTargetRef`/`pushWithPreflight`/`recordRefusal` all in `src/pr/push.ts`; the `{ ok: true, pushed: false }` resume arm (`already-present` log + `false` return) verified; `GitHubApi` has exactly four members; `readHostToken` present; the `INV-PR-1/5/6/7` clauses as quoted exist in DF5.2 with the same meanings.
- **The proposal variation target verified:** the shipped hard-coded proposal is `open a PR for run <runId> at <headSha>`, and `runner.ts` reads the record's approval extension immediately before the call — the adds-only variation reads a value in hand, as claimed.
- **p1-18 edit target verified:** `:50` is INV-2 and reads verbatim as quoted (with ellipsis), naming `(P1.19)`; `:36` carries the `botComments[]` shape; DF5.5's disposition hands `:50` to DF6.1a and keeps `:17`/`:23`/`:25` — the three-way split (DF5.5 / DF6.1a / DF6.1b) is consistent across all four documents including DD-2a.
- DF3.7's INV-IBOX-16 already names DF6.1a's fix run among the three sanctioned automatic callers, with the caller-holds-the-lock wording, as claimed.
- `liveGate("1" | "2")` verified at `tests/fleet/e2e/live-harness.ts`; DF2.12's `ingestCostEvent` wiring (bridge + both teardown ingest points) verified; `fill.ts` bundle-push default and userinfo refusal verified; the six privileged scripts and `package.json` `verify:*` entries exist at the cited lines.

### DF6.1b — Fix-Loop CI Verdict, Attempt Budget and Human Escalation

| ID | Class | Sev | Finding |
| --- | --- | --- | --- |
| DF6.1b-W23-1 | C4 | LOW | The `bot-response-to-fix` predicate is stated as "a feedback set whose `commentIds` are all newer than the recorded `attemptSha`" — an ID-to-commit-sha comparison that is type-loose on its face — while the DoD leg states it time-wise ("a new bot comment set posted after `attemptSha`"). The two restate the same intent and the scoping **is** consistent (the all-newer reading fires only on re-invocations; the fresh-PR attempt-1 dispatch leg and the no-`attemptSha` clause align: a populated ledger vs none separates "already acted on" from "first comment set"), but the implementable comparison basis — new IDs outside the acted-on set vs created-after the commit vs ledger-populated parent — is left to inference. Pinning one basis would close it. |

**What HELD (DF6.1b):**

- **The bounds are consistent across enumeration, ladder, Observability and DoD.** Charged budget 2 (`ci-red`, `ci-verdict-unavailable`); uncharged ceiling 3 over exactly the five reproducing classifications (`transient`, `lead_failure`, `approval-timed-out`, `overflow`, `orphaned`); `dispatch-refused` at most once per PR (first-occurrence escalation = its bound, excluded from both ceilings); `out-of-scope-diff` cap 1; `scope-requires-privilege` never retried, at most once, zero-charge — all matching DF6.1a's sizing-union statement verbatim. The ladder names all five shipped `ApprovalState` readings (`awaiting-approval`/`pausing` continuations, `timed-out` → uncharged-terminal, `rejected` → `approval-rejected` zero-charge loop-stop, `approved` split by `fixContext` presence), and the "only one of the four states counts as orphaned" arithmetic holds. The Observability classification list covers every classification the ladder and AC2 can produce, with no extras. DF6.1a's `unchargedCeiling` symbol and DF6.1b's pinned 3 agree.
- **`fix-scope-missing` (deterministic repetition, no durability)** is stated identically in the Observability list and the DoD leg — escalates on every invocation until the artifact exists, no run record minted, no seen-it marker, no once-per-PR record — and is consistent with DF6.1a's attempt-start probe (same artifact, same refusal code, DF6.1a owns the read, DF6.1b the stop classification).
- **Lock claims verified against `scripts/fleet.ts`:** exactly two `acquireRunLock` call sites (dispatch key-mint on the just-minted runId; `runDestructive`), `GATE_VERBS` = the five gate verbs routed through `runGateVerbs` with no run lock — the two-corrections-of-record text matches the shipped code exactly, and the PR-scoped (parent) + run-scoped (fix) two-lock design is consistent with the non-re-entrant `acquireRunLock` both halves cite.
- **The parent-run join** (`parentRunId = headRefName.slice("qds/".length)` + `store.get` + `extensions.pr.prNumber === n`) is stated identically in AC2, the Attempt-bookkeeping note, the Infra Prerequisites and the DoD, is grounded in DF5.2's `defaultTargetRef` (`qds/<runId>`, verified in `src/pr/push.ts`), and the store's public surface (`path`/`lockPath`/`create`/`get`/`set`/`close`/`list`/`listWithAnomalies`) matches DF6.1a's INV-7 scratch-store route.
- **The three-invocation composition** (`gh pr view` before + `gh pr checks --required` + `gh pr view` after) is stated identically at four sites (E2E, AC1, Infra, DoD); the SHA-binding on both reads, exit-8-is-pending, attempt-start empty-set refusal vs in-window `pending`, and the four negative controls are mutually consistent.
- **DF6.2's refusal vocabulary matches item-for-item** (QDS_TEAM_RUNNER, missing provider key, empty `QDS_RUN_ROOT`, INV-5 roster/task, unreadable/under-provisioned roster, dual-gate, manifest-schema/dir) with `exitStatus: "logic"` — verified in both DF6.2's spec and `src/phase-engine/phases/dispatch-task.ts`; `overflow` is a shipped `InBoxExit` member (`src/providers/cap-rejection.ts`) as the ladder's disposition note claims.
- **DF5.3 seams verified:** INV-AUDIT-6 exists as the named-broken-hop invariant; hop 1 runs PR → runId; "Ten hops *per contributing runId*" is DF5.3's own Technical Notes heading anticipating the additive `src/audit/chain.ts` edit; DF5.3's Files to Modify lists `src/audit/chain.ts`; DF5.3 states DF5.3 is an edge of DF6.1b only — matching DF6.1a's "DF5.3 is NOT an edge of this half".
- **`fixContext` nine-field list is parity-identical** between DF6.1a's seam payload and DF6.1b's lookup description (same fields, same order); `fixOutcome`'s shape matches the E2E slice; the dispatch-time vs persisted `fixContext` vocabulary split is stated and does not collide; `pollWindowOpenedAt` rides the single post-push write in both halves.
- `observeAndDriveChain`/`walkAuditChain` zero-in-src claims hold with controls; `recordAuditLink` appears exactly once, in the `teardown.ts` DF5.3 comment, as claimed; `src/audit/` absent (sequencing claim sound); DF2.11's "eighth call site = DF3.8's sweep" verified, matching DF3.7's "claims no ordinal" positioning.
- DD-1 (operator-CLI-only), DD-2/DD-2a (the "5+" slot and the split), DD-8 (audit §3 labels do not resolve — NET-NEW fresh), DD-10 (host-side push, D8) all exist in the decision register with the meanings both halves cite.

---

## Verdicts

| Story | BLOCKER | HIGH | MEDIUM | LOW | C1 | C2 | C3 | C4 | Verdict | Confidence |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| DF3.7 | 0 | 0 | 0 | 2 | 0 | 0 | 0 | 2 | **CONVERGED** | High |
| DF6.1a | 0 | 0 | 0 | 1 | 0 | 0 | 0 | 1 | **CONVERGED** | High |
| DF6.1b | 0 | 0 | 0 | 1 | 0 | 0 | 0 | 1 | **CONVERGED** | High (the one LOW: medium-high) |

Convergence bar (zero BLOCKER, zero HIGH, zero C2, zero C3; C1-LOW and C4 residue acceptable) is met by all three stories. All findings are C4 wording residue; none changes a contract, an exit mapping, a bound, a registration, or a seam.

**Basis for confidence:** every load-bearing claim in the primary lens was opened at source and either verified or positively controlled — the `ChainOutcome` union/exit/Observability/DoD mapping against the shipped classifier and gate outcomes; the sizing formula character-compared across all statements; the lock and roster claims against `scripts/fleet.ts` and the roster schema; every zero-match claim re-run with a same-machinery control. The two residual unverifiables (the measured `gh` field list, the gh version floor) are external and do not touch any in-repo contract.

## Summary

**0 BLOCKER · 0 HIGH · 0 MEDIUM · 4 LOW** (DF3.7: 2 · DF6.1a: 1 · DF6.1b: 1) — all C4. **All three stories CONVERGED.** No blocking items. Ranked residue (all optional, none gating dev): DF3.7-W23-1 (exit-6 gloss vs pre-close chain-failed), DF6.1b-W23-1 (bot-response-to-fix comparison basis), DF6.1a-W23-1 (dropped `timestamp` in the shape citation), DF3.7-W23-2 ("AC5 defaults" mislabel).
