# Dark Factory v5 — Epic & Story Index

> **Dark Factory v5 backlog — derived 2026-08-11** from the v5 design
> `docs/superpowers/specs/2026-08-11-dark-factory-v5-architecture-design.md` §8 build order.
> **Supersedes the retired 30-story superstructure** per the F14 disposition audit
> (`docs/superpowers/specs/2026-08-11-story-disposition-audit.md`); the 6 DONE-KEEP and
> 11 KEEP stories are **not** superseded — they carry forward with dependency-edge repoints
> (see the ancestry table at the foot of this file).
> Derivation decisions (epic codes, hole dispositions, DD-1…DD-12):
> `docs/superpowers/specs/2026-08-11-v5-story-derivation-decisions.md`.
> Sprint slicing + dependency graph:
> `_bmad-output/workflow-state/qds-sprint-planning/df-v5/research/R5-dependency-sizing.md`.

**Totals: 31 stories · 123 pts · 3 sprints** — v5-S1 **48** · v5-S2 **50** · v5-S3 **25**.

> **Epic bullets are summaries, non-normative; story files govern.** Where a bullet and its
> linked story file disagree, the story file is authoritative.

| Epic | Mission (§8 step) | Stories | Pts |
|---|---|---|---|
| DF1 | Phase engine | 8 | 32 |
| DF2 | Provider seam + credentials | 9 | 34 |
| DF3 | Fleet dispatcher | 6 | 24 |
| DF4 | Visualizer | 2 | 10 |
| DF5 | Lights-on | 5 | 17 |
| DF6 | Feedback loop | 1 | 6 |

> This index is the brief (dual-output Output-2). Per **SPL-009** it does **not** duplicate
> Definition of Done, Security Invariants, Observability Contracts, Trigger Surfaces or
> Files-to-Modify — those live in the individual story files and are authoritative there.

---

## Epic DF1 — Phase engine (§8 step 1)

**Mission:** port SSSF's phase abstraction to TypeScript test-first (D6/D10) so tier 2 runs an
ordered, budget-bounded, journaled phase walk whose success must be earned, whose gates carry
evidence, and whose every event lands in one queryable trace. — 8 stories · 32 pts

> **DF1.7 does not exist** — it was merged into DF1.1 as the versioned pipeline manifest
> (R5 §1.5); P1.4's surviving clauses land there. The numbering is preserved for traceability.

### Story DF1.1: Phase Lifecycle Primitive with Versioned Pipeline Manifest

**Story File:** [df1-1-phase-abstraction-lifecycle.md](../sprint-artifacts/dark-factory-v5/stories/df1-1-phase-abstraction-lifecycle.md)

As a factory engineer,
I want a phase primitive whose success must be earned and a pipeline manifest that is versioned and validated before anything runs,
so that a run can never be recorded green by omission and a pipeline cannot start against a shape nobody checked.

**Story Points:** 4 · **Sprint:** v5-S1 · **Depends on:** none

- **(make-or-break)** A phase record is written `fail` at construction and promoted to `success` only by the clean-exit branch — a death mid-phase (throw, rejection, SIGTERM, hard kill) reads `fail`; no path downgrades an optimistic `success`.
- `loadManifest` validates against a closed schema and returns a frozen manifest; unknown field, unsupported `version`, phase `kind` outside `engineer|agent|code`, `phases.length < 2`, or a bad `pipelineId` rejects the load with **no phase constructed**.
- An empty, whitespace-only, or name-echoing `PhaseParams.description` throws at construction before any journal row.
- A phase exceeding `maxDurationMs` is terminated by the engine's own timer: record `fail` with `exitStatus: "overflow"`, no hang, remaining phases skipped.
- Budgets plus routing margin exceeding `callerBudgetMs` — or a missing `callerBudgetMs` — refuses the load rather than assuming an upstream ceiling.

**Technical notes:** one lifecycle wrapper serves all three phase kinds (no per-kind subclass, no phase registry); `Run.finish(accepted)` computes `ok = allPhasesSucceeded && accepted`, keeping phase outcome and run outcome distinct; the journal writes through a narrow `PhaseJournal` port that DF1.4 swaps for SQLite without changing semantics.

**Full enterprise detail** is in the individual story file linked above.

### Story DF1.2: Gates with Evidence over a Unified Envelope Adapter

**Story File:** [df1-2-gates-evidence-envelope-adapter.md](../sprint-artifacts/dark-factory-v5/stories/df1-2-gates-evidence-envelope-adapter.md)

As a factory engineer,
I want every gate check to record its evidence on pass as well as on fail, and deterministic subprocess results wrapped as envelopes indistinguishable from agent reports,
so that a green gate says what it verified and a failing test run travels back to the builder through exactly the same door a reviewer agent's report uses.

**Story Points:** 4 · **Sprint:** v5-S1 · **Depends on:** DF1.1

- **(make-or-break)** A `GateReport` persists the full `checks` array (`{item, ok, note}`, `note` populated on passes too) **and** the derived `violations`; `passed` is computed as `checks.length > 0 && violations.length === 0` — a zero-check report is never green, and no API accepts an authored violations list.
- `asEnvelope(result, label)` wraps a deterministic subprocess result in the same `Envelope` an agent report produces, passed through the identical `previous:` slot — a consumer cannot tell them apart.
- `verdictConsistent` refutes a self-contradicting review envelope (approved-with-blocker, approved-with-unmet-finding, rejected naming neither) without reading a line of the diff.
- A failing `code` block is data (phase `success`, run not accepted); a failing **gate** throws out of the phase body and that phase reads `fail`.
- A gate whose subprocess cannot execute at all records the spawn error and reports `passed: false` — never pass, never skip.

**Technical notes:** the adapter invariant is stated once and gate sources (`pi-lens-verify.ts`, `lsp-verify.ts`, P1.7's post-edit diagnostics gate) plug in by **registration, not reimplementation**; `outputTail` is deliberately raw; the gate library is mechanical by design.

**Full enterprise detail** is in the individual story file linked above.

### Story DF1.3: Dual Retry Discipline — Separately Bounded Parse and Gate Retries

**Story File:** [df1-3-dual-retry-discipline.md](../sprint-artifacts/dark-factory-v5/stories/df1-3-dual-retry-discipline.md)

As a phase-engine maintainer,
I want a malformed envelope and a gate violation each retried under their own bound inside the same agent session,
so that a correctable response is corrected without paying for a fresh context and without any loop that can run away.

**Story Points:** 3 · **Sprint:** v5-S1 · **Depends on:** DF1.2, DF2.7

- **(make-or-break)** At most `(R + 1) × (P + 1)` sends per phase; each gate correction resets the parse budget and neither budget consumes the other; `retries` outside `0..5` is **rejected at construction**, never clamped.
- All sends in one phase carry the identical session id resolved for `(agent, model)`; a roster `model` change mints a new session rather than continuing the old context.
- `agent_end` sums tokens and cost over **every** send, while `contextTokens`/`contextWindow` come from the last send only and an `aborted|error` turn does not overwrite the last good occupancy reading.
- Budget exhaustion raises `EnvelopeParseExhausted` (Loop A) or `GateFailure` naming every unresolved violation (Loop B); the phase stays `fail` and the final invalid response is retained, not discarded.
- At the default `retries: 0` with a first-pass envelope: exactly one send, one gate evaluation at `attempt = 1`, no correction.

**Technical notes:** loop nesting and bounds are stated once; the boundary against **P1.9 (KEEP)** restart policy is BINDING per decision register §4 — DF1.3 owns in-phase retry, P1.9 owns run-level restart; usage-vs-occupancy asymmetry is deliberate.

**Full enterprise detail** is in the individual story file linked above.

### Story DF1.4: SQLite Trace Store (7-Table Schema, WAL, Rowid-Cursor Reads)

**Story File:** [df1-4-sqlite-trace-store.md](../sprint-artifacts/dark-factory-v5/stories/df1-4-sqlite-trace-store.md)

As an operator auditing a factory run,
I want every phase, event, envelope, gate result, process and agent session written to one queryable SQLite trace keyed by `requestId`,
so that a run can be replayed and audited after the fact — including the runs that hung and emitted nothing.

**Story Points:** 4 · **Sprint:** v5-S1 · **Depends on:** DF1.1, DF1.2

- **(make-or-break)** All seven tables exist with `phases.status DEFAULT 'fail'`, `gate_results` persisting both `violations_json` and `checks_json`, `envelopes.valid` retaining invalid parse attempts, and a populated `request_id` column on **every** table.
- The writer sets `journal_mode=WAL`, `synchronous=NORMAL`, `busy_timeout=5000` on autocommit; the reader opens `{readonly: true}` and **asserts rather than sets** `journal_mode`, warning when it is not WAL.
- Additive migrations apply missing columns via `PRAGMA table_info` + `ALTER TABLE`, preserving rows; the reader substitutes `NULL AS <column>` and re-probes until the column appears, then latches.
- Rowid-cursor paging returns `{rows, cursor, hasMore}` with `limit` clamped to `MAX_LIMIT = 1000` (default 500); an unknown or event-less `requestId` is an empty page, not an error.
- A SQLite write failure surfaces a structured error and the run continues (JSONL already written); a db path outside the run's data boundary **refuses to open**.

**Technical notes:** `request_id` replaces SSSF's `adw_id` throughout; `processes` and `agent_sessions` are separate tables because sessions carry context, not events; the schema is ported from R4 §2.1.

**Full enterprise detail** is in the individual story file linked above.

### Story DF1.5: Per-Role Roster Config + Dual Slug Validation

**Story File:** [df1-5-roster-config-slug-validation.md](../sprint-artifacts/dark-factory-v5/stories/df1-5-roster-config-slug-validation.md)

As a factory operator,
I want a per-role model roster whose every slug is proven live before a run starts,
so that a stale catalog entry or a half-registered custom model fails at config-load time instead of mid-run after money has been spent.

**Story Points:** 3 · **Sprint:** v5-S1 · **Depends on:** none

- **(make-or-break)** Every slug is checked against **both** pi's merged catalog and the provider's live model list; passing only one gate is a rejection naming the failing gate — pi's bundled catalog is stale in both directions, so neither gate alone suffices.
- Per-role values always win over `defaults`, and a per-role `tools` list **replaces** the defaults list — shallow `setdefault` semantics, no deep merge, no concatenation.
- A `~/.pi/agent/models.json` entry with a partial `cost` block is rejected naming the missing keys (pi drops the entire roster); a wholly absent block would silently report $0.0000 while spending.
- `pi --list-models` exiting 0 while printing `No models available`, or a non-200 provider API, marks every slug `unverified` and exits `2` — never a pass, never a silent empty-catalog success.
- A missing `~/.pi/agent/models.json` is an empty custom registry, not an error: exit `0`.

**Technical notes:** the DF1.5 ↔ **P1.5 (KEEP)** boundary is BINDING — DF1.5 owns the roster schema and slug validation, P1.5 owns router scoring; `provider` is authoritative in slug resolution and a model id may itself contain `/`; validation is fail-fast but collect-all.

**Full enterprise detail** is in the individual story file linked above.

### Story DF1.6: `dispatch_task` Phase Spawns a pi Team via `team-lead-driver.ts`

**Story File:** [df1-6-dispatch-task-team-runtime.md](../sprint-artifacts/dark-factory-v5/stories/df1-6-dispatch-task-team-runtime.md)

As a factory engineer,
I want the phase engine's `dispatch_task` phase to run a real pi team through the one proven runtime and return a schema-validated step output,
so that tier 2 gets a machine-checkable result from tier 3 instead of a transcript, and every PR #97 hardening clause is enforced where it can finally measure the right process.

**Story Points:** 8 · **Sprint:** v5-S1 (flagship — closes S1's engine chain) · **Depends on:** DF1.1, DF1.2, DF1.5, DF2.7, P0.2, P0.3

- **(make-or-break)** The team spawns through the `QDS_TEAM_RUNNER=local` seam and returns structured JSON over the nine `MergedOutput` fields (`types.ts:131`): `result`, `changedFiles`, `partial`, `exitStatus`, `durationMs`, `waivers`, `agentOutputs`, `comsLog`, and nullable `error`.
- Every driver stdout line goes through `parseTeamEventLine`; all five kinds (`cost|coms|worker_output|merged|coms_init_error`) map to a named envelope or trace event, and a rejected line increments `malformedLines` without failing the phase (proven path: 0).
- A lead that dies without a valid `merged` event is classified by the stated precedence rule — `coms_init_error` → `transient` ahead of all; signalled → by kill origin; self-controlled exit with no envelope → `lead_failure` **including exit code 0** — with `exitCode`, `partialOutput` and `durationMs` populated.
- An empty Hindsight bank is not an error: the team runs unprimed, `mulchPrimed: false`, `exitStatus: "success"`.
- `QDS_TEAM_RUNNER` unset or any value but `local` **refuses before spawning anything** with `exitStatus: "logic"` — never falling through to the demoted-optional `warren` branch (D9).

**Technical notes:** NDJSON adaptation is the integration surface; the RSS watchdog is re-aimed at the genuine local subprocess tree; cost is session-cumulative per DF2.7, which lands first.

**Full enterprise detail** is in the individual story file linked above.

### Story DF1.8: Run Capture Correlated to the GitHub Issue (Trace-Store-Backed)

**Story File:** [df1-8-run-capture-issue-correlation.md](../sprint-artifacts/dark-factory-v5/stories/df1-8-run-capture-issue-correlation.md)

As an operator answering "what did the factory do about issue #42 in this repo",
I want every phase, event, envelope and gate result of a run to be reachable from the `(repoSlug, issueId)` pair that started it, on one unbroken requestId chain,
so that a run is auditable from the issue that authorized it without a second record to reconcile.

**Story Points:** 3 · **Sprint:** v5-S2 (engine closure) · **Depends on:** DF1.4, DF1.6 *(P1.2 issue-intake removed from hard deps: this story consumes an issue reference supplied in the dispatch brief, which an operator can create manually; P1.2 automates that intake and remains KEEP, repointed by DF5.5.)*

- **(make-or-break)** The `sessions` row carries `repo_slug`, `issue_id`, `issue_url`; all seven trace tables carry the **same resolved** `request_id`; the chain-integrity query returns zero divergent rows; `readRunsByIssue` returns the run with each phase and its output. *Negative controls: a second capture table, or a fresh id per phase.*
- Issue identity is `(repoSlug, issueId)`: retrieval by issue number alone has no entry point, and a dispatch omitting `repoSlug` is rejected before any session row, box or key exists.
- A replayed `(repoSlug, requestId)` yields exactly one `sessions` row — first wins, the second initiation returns that run's `runId`, and uniqueness holds after completion so a late replay cannot re-open it.
- Initiation failing before a session row returns `runId: null` explicitly with the resolved `requestId` and a structured error, recorded in the host-side dispatch log rather than discarded.
- An unknown pair or an unstarted run pages empty with the cursor unchanged and `hasMore: false` — no synthesized partial row.

**Technical notes:** the resolved-requestId rule and the state-event field set are stated once here and consumed downstream; enum and exit-code discipline follows the CC-1 five-value contract.

**Full enterprise detail** is in the individual story file linked above.

### Story DF1.9: Lean Worker Profile — Measure the Extension/Skill Overhead

**Story File:** [df1-9-lean-worker-profile.md](../sprint-artifacts/dark-factory-v5/stories/df1-9-lean-worker-profile.md)

As a factory operator paying for every agent turn,
I want the extension/skill discovery overhead on tier-3 workers measured before and after it is disabled,
so that the factory's single largest cost lever is decided by a number from this repo rather than by an untested 5–6× hypothesis.

**Story Points:** 3 · **Sprint:** v5-S1 (early-safe; paired with DF2.7) · **Depends on:** P0.2, P0.3

- **(make-or-break)** `npm run bench:lean-worker` writes `artifacts/lean-worker-benchmark.json` with per-arm `n`, mean and per-run first-turn input tokens per worker, model slugs, `ratio`, `deltaTokens` and a `hypothesisVerdict`; a run that cannot compute both arms writes `inconclusive` with **no ratio** — refutation passes exactly as confirmation does.
- `lean: true` adds exactly `--no-extensions --no-skills` plus one `-e <path>` per allowlisted extension, all inserted **before** `-p`, which stays last with its schema instruction.
- With no `lean` key anywhere the argv is byte-identical to today's spawn — lean is opt-in and the default path does not change.
- An arm with a worker producing zero usage-bearing turns exits non-zero as `inconclusive` naming the arm and worker, reporting **no** saving — never hanging, retrying, or borrowing the other arm's data.
- `QDS_TEAM_RAW_WORKER_DIR` unset means no raw worker stream is written anywhere: capture is opt-in and off by default.

**Technical notes:** the 5–6× figure is a hypothesis, not a target; first-turn input tokens are the measurement, not run totals; today's workers load zero explicit extensions and coms is not one of them.

**Full enterprise detail** is in the individual story file linked above.

---

## Epic DF2 — Provider seam + credential lifecycle (§8 step 2)

**Mission:** encode the inkwell pattern as tested code — a small provider-driver seam, hard-edged
run records, an exe.dev driver whose setup gate proves the box is usable, per-run spend-capped
credentials, credential-free harvest and teardown, quota accounting, measured cost, and an image
contract that redistributes legally. — 9 stories · 34 pts

### Story DF2.1: Provider-Driver Interface + Run Records

**Story File:** [df2-1-provider-driver-run-records.md](../sprint-artifacts/dark-factory-v5/stories/df2-1-provider-driver-run-records.md)

As a factory platform engineer,
I want one small provider-driver seam plus a hard-edged run record on the host,
so that exe.dev and OCI drivers plug in without reshaping anything above them, and no run can leave behind a box or a key that nobody can account for.

**Story Points:** 4 · **Sprint:** v5-S1 · **Depends on:** none

- **(make-or-break)** `create()` opens `O_WRONLY|O_CREAT|O_EXCL` at mode `0600`; a concurrent second create rejects `EEXIST` with the first file's bytes and mtime unchanged. *A check-then-write implementation passes a naive test and MUST fail this one.*
- `set()` rejects any key outside the twelve-field closed schema and both immutable fields, leaving the file byte-identical; every accepted mutation is an atomic temp-file + `rename` with no `.tmp` residue on injected failure.
- `list()` throws naming a malformed record and returns nothing — it never skips a bad record, because a record quietly dropped is a key that quietly keeps spending.
- An unset `vmName` reads as exit `0` plus an empty line: emptiness is the "that phase never finished" signal, not an error.
- The seven-verb driver contract test runs unmodified against any registered driver and is exported for DF2.2 and DF2.9; every id from argv is validated against the hostname grammar in the single `path()` chokepoint before any path is built.

**Technical notes:** lifecycle verbs are host-side, not driver methods; phase ordering (INV-1) is record → VM → key so nothing exists unrecorded; costs are integer micro-dollars per DD-9, with per-field coercion at the CLI boundary rather than a speculative JSON parse.

**Full enterprise detail** is in the individual story file linked above.

### Story DF2.2: exe.dev Driver + Five-Assertion Setup Gate

**Story File:** [df2-2-exedev-driver-setup-gate.md](../sprint-artifacts/dark-factory-v5/stories/df2-2-exedev-driver-setup-gate.md)

As the factory host,
I want an exe.dev provider driver whose `setup` refuses to return ready until five assertions prove the box is genuinely usable,
so that a run never spends money inside a box whose clone is truncated, whose model registry is empty, or whose cost table silently reports $0.0000.

**Story Points:** 5 · **Sprint:** v5-S1 · **Depends on:** DF2.1, DF2.3

- **(make-or-break)** `setup` returns `ready` only when all five assertions pass, with one `{item, ok, note}` evidence entry per assertion on pass **and** fail; any failure **returns** `{ready: false, failedItem, assertionCode, assertions[]}` (A/B=1, C=2, D=3, E=4) rather than exiting — `setup` is a driver method returning a payload, and only `scripts/`-level callers map `assertionCode` to a process exit — **leaves the VM alive**, and prints the debug plus teardown commands.
- Assertion B fails on **content** when `pi --list-models` exits 0 printing `No models available`; `command -v pi` is checked first so "command not found" cannot satisfy it. *An implementation trusting `$?` MUST fail.*
- Assertion A fails on non-empty `git status --porcelain` even when `HEAD` prefix-matches the recorded `commitSha` — an unsynced clone measured upstream produced 5,641 zero-byte files and reported success.
- Assertion D fails on a partial `cost` block naming the whole-roster-drop consequence, and on `cost.input == 0`; its first half requires a real `pi -p --mode json` call reporting `cost.total > 0` — diffing `/api/v1/key` usage is the wrong instrument.
- An unrecognized `create` response shape falls back to the one verified `ls <name> --json` shape and derives `https_url` from `<name>.exe.xyz`; if both are unusable it fails closed **after** the name is recorded, so the VM is never orphaned invisibly. A stale `/tmp/PROVISION_READY` is cleared before provisioning; a `null` key `limit` fails E.

**Technical notes:** the provider surface is six shapes, and verified-vs-unverified is recorded rather than assumed; three structural rules carry verbatim from the source pattern; the two pi rate-table landmines (R4 §4.2) are what assertions D and E exist to catch.

**Full enterprise detail** is in the individual story file linked above.

### Story DF2.3: Per-Run Credential Lifecycle — Mint, Cap, Deliver, Revoke, Verify-Against-List

**Story File:** [df2-3-credential-lifecycle.md](../sprint-artifacts/dark-factory-v5/stories/df2-3-credential-lifecycle.md)

As the factory host,
I want every run's LLM key minted with a spend cap, delivered without ever touching argv, and revoked with revocation proven against the provider's authoritative key list,
so that a run that dies anywhere cannot leave a live key spending money that nobody can find.

**Story Points:** 4 · **Sprint:** v5-S1 · **Depends on:** DF2.1

- **(make-or-break)** The full lifecycle ends with the record carrying `keyHash`, `limitMicroUsd`, `spendMicroUsd` populated and **left open** — closure is DF2.5 teardown's last step, not this story's; `spend` is captured **before** the `DELETE`; the plaintext key appears in no record field, log line or recorded argv; the hash is absent from `GET /keys` afterwards.
- `verifyRevoked` gates on the key **list**, not the single-key endpoint (which measurably returns `200` for an already-deleted key); a `2xx` DELETE with the hash still listed **fails**, leaves the VM alive, and prints the manual remediation line.
- `DELETE 404` counts as already-revoked only after list-absence is confirmed; `DELETE 5xx` is a hard failure — non-zero exit, VM untouched, record open, next command printed.
- An empty or paginated key-list response never permits inferring absence: follow pages to exhaustion or fail closed with `list-unverified`.
- Secret delivery leaves no ≥8-char substring of the secret in argv on either side and the remote file reports mode `600` via `stat`; the µ$↔dollar conversion happens only at the HTTP boundary (DD-9), so a 100× or 10,000× unit slip fails.

**Technical notes:** ordering is the design (mint → cap → deliver → revoke → verify), the `sbx-` prefix is load-bearing for DF2.6's reaper, and server-side secret injection is carried as an explicit [VERIFY] item rather than assumed.

**Full enterprise detail** is in the individual story file linked above.

### Story DF2.4: Live Cap-Hit Kill Demonstration — Real Key, Real Spend, Recorded Evidence

**Story File:** [df2-4-live-cap-hit-kill.md](../sprint-artifacts/dark-factory-v5/stories/df2-4-live-cap-hit-kill.md)

As the person selling spend containment,
I want a recorded run in which a real capped key on a real box is spent to its ceiling and the run is killed and evidenced,
so that the enterprise pitch rests on a captured artifact instead of an assertion nothing has ever demonstrated.

**Story Points:** 3 · **Sprint:** v5-S2 (provider closure) · **Depends on:** DF2.2, DF2.3, DF2.5 (R5 §2) — DF2.5's teardown is invoked unchanged and re-implemented nowhere here; R5 §3 lands DF2.5 in S1, ahead of this S2 story.

- **(make-or-break)** The evidence artifact records `spendMicroUsd ≥ capMicroUsd`, `exitStatus: "overflow"`, `killOrigin: "provider-cap"`, `revocationVerified: true`, a closed run record and `verdict: "demonstrated"` — every number read host-side from the provider, never from the box.
- `classifyRunExit` overrides a box's self-reported `transient` to `overflow` when the host reads `usage ≥ limit`: how the run died outranks what it said about itself (CC-1 precedence). Both deciding inputs are produced **host-side** — `providerCapRejected` from the host's post-termination re-probe of the provider with the retained run key (before revoke), `terminationProvenance` from whichever host-side guard fired — never read out of the box.
- The 900,000 ms wall-clock ceiling elapsing, or a provider that never rejects, yields `inconclusive` naming the guard that fired — the containment claim is not recorded as proven, and teardown is still invoked.
- A turn-1 rejection with `turnsCompleted: 0` is `inconclusive` with reason `cap-below-first-turn`; the cap is a configured input so the demo re-runs higher with no code change.
- The artifact carries no key material: the provider's rejection body is redacted **with the run key itself as the redaction input**, and only `keyHash` identifies the credential.

**Technical notes:** this story adds one mechanism and no more — the cap under test is the outermost backstop, not a replacement for DF2.8's ledger gate; spend is the provider's number; bounded cap overshoot is carried as an explicit [VERIFY].

**Full enterprise detail** is in the individual story file linked above.

### Story DF2.5: Bundle Harvest + Tested Teardown

**Story File:** [df2-5-bundle-harvest-teardown.md](../sprint-artifacts/dark-factory-v5/stories/df2-5-bundle-harvest-teardown.md)

As a factory operator,
I want a run's commits, artifacts and trace pulled back across a credential-free gap and a teardown that has actually been run under test,
so that a finished box can be destroyed without ever losing work and without a push credential existing anywhere inside it.

**Story Points:** 4 · **Sprint:** v5-S1 (closes S1's provider chain) · **Depends on:** DF2.1, DF2.2, DF2.3 — teardown calls DF2.3's `captureSpend`, `revokeRunKey` and `verifyRevoked` directly, not only through DF2.2.

- **(make-or-break)** The bundle is created **ranged** (`<base>..refs/heads/sbx/<run-id>`), `git bundle verify` passes **before** any fetch, objects land only at `refs/sandbox/<run-id>`, and the host's working tree, index, `HEAD` and every operator-owned branch and tag are byte-identical before and after.
- A run branch not descending from the pinned base makes `git fetch` refuse the prerequisite: non-zero exit naming the missing sha, no ref created. *An implementation using `git bundle create --all` passes AC1 and MUST fail this.*
- A failed harvest aborts `teardown` **before** key revoke and box destroy, leaving the box alive, the record open, and the next command printed — destroying a box whose commits were never pulled is the one irreversible mistake available.
- Zero commits beyond base is a **successful no-op** (`harvested: none`), not an abort; a re-harvest after further commits updates `refs/sandbox/<run-id>` with `--force` and re-pulls artifacts and trace idempotently.
- An unavailable `git bundle verify`, or a destroy the driver cannot **confirm**, stops teardown with the box alive and the record open for DF2.6's reaper; `--no-harvest` waives the harvest gate only and is logged, never written to the record.

**Technical notes:** a bundle rather than a push is what keeps the gap credential-free; the six-step teardown order (spend → artifacts → commits → revoke → destroy → close) is fixed; the upstream reference has no tests, which is the point of this story.

**Full enterprise detail** is in the individual story file linked above.

### Story DF2.6: Host-Side Quota Accounting + Orphan Reaper

**Story File:** [df2-6-quota-accounting-reaper.md](../sprint-artifacts/dark-factory-v5/stories/df2-6-quota-accounting-reaper.md)

As the factory host,
I want the live box and key population reconciled against the run records, ceilings tracked host-side,
so that a fan-out cannot exhaust the account's VM allowance and a teardown that never ran cannot leave a key spending forever.

**Story Points:** 3 · **Sprint:** v5-S2 (provider closure) · **Depends on:** DF2.2, DF2.3, DF2.5 — DF2.3's `revokeAndVerify(keyHash)` is called directly for record-less orphan keys, not only transitively through DF2.5.

- **(make-or-break)** A sweep classifies every **factory-owned** item into exactly one of `paired` / `leaked-vm` / `leaked-key` / `stale-record`, reporting anything else as `foreign` and never a candidate; the default mode deletes nothing and exits 0, `--yes` reaps only the three leak classes, and the `sbx-` prefix is re-asserted immediately before each key DELETE.
- `checkHeadroom(3)` at 48 live VMs against a ceiling of 50 returns `allowed: false` with the full headroom breakdown and creates zero boxes; `checkHeadroom(2)` is allowed — the boundary is inclusive.
- An unreadable or unparseable run record is a hard non-zero exit with **no deletion anywhere in that sweep**. *Skipping it passes the classification AC and MUST fail here.*
- A VM or key list that cannot be enumerated to exhaustion reaps nothing and returns `allowed: false` with reason `list-unverified`: unknown population means zero headroom, never full headroom.
- An empty fleet exits 0 reporting `nothing to reap` with the full ceiling as headroom; a run in flight (record open, VM live, younger than `staleAfterMs`) is `paired` and untouched even under `--yes` — **age is the only discriminator**, because DF2.5 leaves records open during runs and after aborted teardowns alike.

**Technical notes:** the queue is derived, never stored; ceilings are config rather than constants; VM count is authoritative while disk is an estimate, and `checkHeadroom(n)` is a read, not a lock.

**Full enterprise detail** is in the individual story file linked above.

### Story DF2.7: Session-Cumulative Cost Instrumentation in the Team Lead Driver

**Story File:** [df2-7-session-cumulative-cost-instrumentation.md](../sprint-artifacts/dark-factory-v5/stories/df2-7-session-cumulative-cost-instrumentation.md)

As the operator pricing a hosted factory tier,
I want every pi agent's cost event to report its session-cumulative token and dollar usage with cache economics and a turn count,
so that every downstream cost claim — the DF2.8 ledger, the per-run floor, the budget kill threshold — is derived from measured truth instead of a last-turn sample.

**Story Points:** 2 · **Sprint:** v5-S1 (early-safe; paired with DF1.9) · **Depends on:** P0.3

- **(make-or-break)** Against the committed probe fixture, `PiRunOutcome` and the emitted `cost` event carry the **session total** for `inputTokens`, `outputTokens` and `costUsd`, per the accumulation mode the probe fixed for each field independently. *The current assignment implementation passes today's tests and MUST fail this one.*
- The `cost` event additionally carries `cacheReadTokens`, `cacheWriteTokens`, `turnCount` and `unpricedTurns`.
- A legacy `cost` line carrying none of the four new fields parses to a valid `TeamEvent` with the numerics defaulted to `0` — no consumer of `parseTeamEventLine` needs a change to keep compiling or passing.
- An absent, non-object, or non-finite `usage` block increments `turnCount` **and** `unpricedTurns`, leaves the priced accumulators unchanged, lets no `NaN` reach the wire, and completes the worker normally.
- Zero usage-bearing events emit all-zero numerics with `turnCount: 0`, accepted by the parser — `costUsd: 0` is valid, not a rejection.

**Technical notes:** accumulation mode is determined empirically per field by a pre-dev probe, never assumed; the cost-semantics blast radius is enumerated because DF2.8's ledger, the per-run floor and the kill threshold all read these fields.

**Full enterprise detail** is in the individual story file linked above.

### Story DF2.8: Micro-Dollar Cost Ledger with Budget Cap and Pre-Spawn Dispatch Refusal

**Story File:** [df2-8-cost-ledger-budget-cap.md](../sprint-artifacts/dark-factory-v5/stories/df2-8-cost-ledger-budget-cap.md)

As the operator running a factory that spends real money on someone else's behalf,
I want every run's token and box spend recorded once in integer micro-dollars against the issue that authorized it, with a cap that refuses a dispatch before a box or key exists,
so that the bill is derivable from an append-only record and containment costs a refusal, not a runaway.

**Story Points:** 4 · **Sprint:** v5-S2 (provider closure) · **Depends on:** DF2.7, DF2.3, DF2.5 — DF2.5 owns the teardown whose **close** step this story hooks `ingestBoxHours` to, so the box-hour row has a caller *(P1.2 issue-intake removed from hard deps: this story keys spend by an issue reference an operator can supply, e.g. `qds/demo#42`; P1.2 automates that intake and remains KEEP, repointed by DF5.5 — the same operator-supplied-issue-ref rationale DF1.8 uses.)*

- **(make-or-break)** Exactly one row per emitted event, keyed by a deterministic `event_id`, with `cost_micro_usd` an **integer** and every required column populated; re-ingesting the identical event set adds zero rows and mutates none. *Negative controls: cents, floats, redelivery rows, or collapsing two invocations of one agent into one row.*
- `qds cost <owner/repo>#<N>` derives the cumulative view as a `SUM` over priced rows with per-role and per-run breakdowns — **no denormalized cost column** is written or used, and a bare issue number is rejected rather than defaulted.
- Cumulative priced spend at or above the cap (default 5,000,000 µ$) refuses the dispatch with a structured payload **before** `create` runs — no VM, no key; under cap, the mint cap handed to DF2.3 is `min(defaultKeyCapMicroUsd, remainingMicroUsd)`.
- A malformed cost event persists with `unpriced = 1` and `cost_micro_usd = 0` and is **never dropped**; unpriced rows are excluded from the priced SUM and surfaced as an explicit count in every view and gate decision.
- Zero rows reports `0` µ$ with `hasEvents: false` and exit 0, treated as under cap; any `UPDATE` or `DELETE` against a persisted row aborts with an error, never a silent no-op.

**Technical notes:** integer micro-dollars everywhere per DD-9; rate provenance is binding per F8 condition 2 / R6; two layers of containment are stated explicitly — the ledger gate refuses before spawn, DF2.3's key cap is the backstop inside the box.

**Full enterprise detail** is in the individual story file linked above.

### Story DF2.9: OCI Image Contract + License-Compliance Build

**Story File:** [df2-9-oci-image-contract-licensing.md](../sprint-artifacts/dark-factory-v5/stories/df2-9-oci-image-contract-licensing.md)

As the enterprise-tier operator shipping pi plus the vendored coms substrate into a client VPC,
I want the image build to generate its NOTICE from a sweep of the actual post-build tree and to fail on any uncovered or forbidden package,
so that redistribution compliance is enforced by the build rather than by a hand-maintained list that goes stale the first time a dependency moves.

**Story Points:** 5 · **Sprint:** v5-S2 (moved from v5-S1, which was over capacity at 53 pts; this story has no dependency edges, so it schedules freely and re-sequences nothing — but the surface is a real build: a post-build tree sweep, a Dockerfile, a CI job and the NOTICE generator) · **Depends on:** none

- **(make-or-break)** The sweep runs against the actual post-build tree, emits every license-text-less package into NOTICE with identifier, copyright line and full license text, and **fails the build** on any uncovered package. *A static transcription of the twelve packages named in the gates report passes a spot check and MUST fail — the observed tree holds fifteen and the set shifts.*
- `@mariozechner/clipboard` and its platform binaries are absent from the tree (asserted by inspecting the tree, not by asserting the flag), and `@mariozechner/pi-coding-agent` resolves to exactly `0.55.0`; transitive `pi-{agent-core,ai,tui}` may float inside `0.55.x`, recorded in the summary and failing only outside that range.
- `@mariozechner/pi-proxy` or `@mariozechner/pi` at any depth aborts the build **before** NOTICE generation and before any tag, naming the offending dependency path — no artifact is produced.
- Packages shipping their own license text are covered and not duplicated, except that a covered package carrying an upstream NOTICE has it concatenated verbatim; an empty uncovered set passes only when the generated NOTICE is non-empty — a zero-byte NOTICE is a FAIL, never a vacuous pass.
- The vendored substrate's provenance is fixed: `coms.ts` attributes to `disler/pi-vs-claude-code` at commit `0ed11f44` matching `package.json` `_provenance`, with a DIVERGENCE row for the edit and `coms-net.ts` asserted byte-unchanged.

**Technical notes:** NOTICE is computed, never transcribed; Apache-2.0 §4(a) is the strictest obligation in the tree and drives the full-text requirement; the denylist is by name and unconditional.

**Full enterprise detail** is in the individual story file linked above.

---

## Epic DF3 — Fleet dispatcher + tier-1 skills (§8 step 3)

**Mission:** replace the improvised shell line with tested tier-1 verbs — dispatch, fan-out N,
best-of-N, race, status, attach, harvest, teardown — plus a tier-2 resident agent that steers a run
without ever holding gate authority, and a named human standing between a green bundle and a public
PR. — 6 stories · 24 pts

### Story DF3.1: Fleet Dispatcher Core Verbs (dispatch, status, harvest, teardown)

**Story File:** [df3-1-dispatcher-core-verbs.md](../sprint-artifacts/dark-factory-v5/stories/df3-1-dispatcher-core-verbs.md)

As the factory operator at tier 1,
I want four tested dispatcher verbs that mint a run handle, report fleet state, pull work back, and destroy a box,
so that every factory action is a deterministic command with guards I can read, rather than a shell line an agent improvises differently each time.

**Story Points:** 5 · **Sprint:** v5-S2 (sequenced first — unblocks four stories, but DF1.8 lands ahead of it inside the sprint) · **Depends on:** DF1.8, DF2.1, DF2.2, DF2.5, DF2.6, DF2.8 — dispatch calls DF2.6's `checkHeadroom(1)` and DF2.8's `assertWithinBudget` before any box or key is created

- **(make-or-break)** A brief failing schema validation exits `2` naming the field with **nothing provisioned** — no record, no `driver.create()`, no key. *An implementation that mints the runId first and validates after MUST fail.*
- `dispatch` mints the runId itself and returns it **synchronously** once the setup gate resolves, carrying the **resolved** `requestId` — the caller's strict UUID v4 if supplied, else the dispatcher's.
- A failed setup assertion exits `3` carrying DF2.2's assertion code **in the payload** (never as the process exit code), leaves the record open and the box alive with debug and teardown commands printed, and lets no brief reach tier 2.
- `fleet status` on an empty fleet exits `0` with an empty result set; a run whose box the driver's `list` no longer returns reports `boxMissing` rather than being silently omitted.
- `harvest` and `teardown` delegate to DF2.5 with every guard intact — verify-before-fetch, the `refs/sandbox/` refspec, the fixed six-step order — and add no second retry loop.

**Technical notes:** dispatch is the front door (D3, DD-1); retry has a single owner; this CLI has its own exit-code table and deliberately does not inherit P1.6's warren mapping (F3).

**Full enterprise detail** is in the individual story file linked above.

### Story DF3.2: Fleet Patterns as Code — fan-out N, best-of-N, race

**Story File:** [df3-2-fanout-best-of-n.md](../sprint-artifacts/dark-factory-v5/stories/df3-2-fanout-best-of-n.md)

As the factory operator,
I want the three fleet patterns as tested code with an admission check, not a cookbook I adapt by hand,
so that running N arms cannot quietly exhaust the account's box ceiling, collapse N isolated runs into one shared box, or lose an arm because a copy-paste dropped a guard.

**Story Points:** 4 · **Sprint:** v5-S2 (first cut if the sprint must compress) · **Depends on:** DF1.1, DF2.1, DF2.6, DF3.1

- **(make-or-break)** A refused `checkHeadroom` stops `fanout` **before minting anything**: exit `5`, zero records, zero boxes, zero keys, error naming headroom and request. The check is **one** call covering all N, never N checks of 1.
- Each arm holds its own box, runtime key and run record, sharing no working tree, key, port or git state. *An implementation running N agents inside one box satisfies "N results were produced" and MUST fail — spend attribution, blast radius, the commit graph and the setup gate all assume one arm per box.*
- All N run ids are minted **before** the parallel section opens and passed explicitly; recovering an id by reading the newest run record is forbidden as a race under concurrency.
- One arm's setup-gate failure stops that arm alone with its box left alive and evidence intact; siblings run to completion and `fanout` exits non-zero with per-arm outcomes.
- `--pattern race` tears every loser down through DF2.5 unmodified so no arm is destroyed with unharvested work; `many-stories --n 1` is the same code path, while `best-of-n` and `race` reject `N=1` at validation.
- `rank` emits `{scores, tie, rationale}`; top two within `0.1` sets `tie: true` with **no** automatic tie-break, an arm with no step output scores `null` rather than being dropped, and an all-failed fan-out yields empty scores with a rationale.
- A second concurrent `fanout` fails to take the advisory lock `.sandbox/fleet.lock` (`O_EXCL`, held across admission **and** all N mints as one critical section, stale after `3_600_000 ms`) and exits `5` with code `fleet-busy`, provisioning nothing — a lock-free implementation double-admits past the ceiling and MUST fail.
- Every admitted fan-out writes a record `O_EXCL` at `.sandbox/fanouts/<fanout-id>.json` (arms, pin, `winner`, `rankedAt`, `closedAt`) and each arm's run record carries `extensions.fanout = {schemaVersion: 1, fanoutId, arm}` in DF2.1's pre-registered namespace — `schemaVersion` is required of every namespace — with no core record field added; a refused fan-out writes no such file.

**Technical notes:** isolation is structural, not policed (R8); admission precedes mint; ranking is advisory and the diff is the artifact.

**Full enterprise detail** is in the individual story file linked above.

### Story DF3.3: Resident Orchestrator Agent — Interprets the Brief, Steers the Engine, Never Holds Gate Authority

**Story File:** [df3-3-resident-orchestrator-agent.md](../sprint-artifacts/dark-factory-v5/stories/df3-3-resident-orchestrator-agent.md)

As a factory operator dispatching a story to a sandbox,
I want a resident agent that reads the dispatch brief and steers the run at engine-chosen decision points,
so that a run adapts mid-flight without any agent ever being able to move a gate, reorder a phase, or promote a status.

**Story Points:** 4 · **Sprint:** v5-S2 · **Depends on:** DF1.1, DF1.5, DF1.6, DF2.2, DF3.1

- **(make-or-break)** No directive ever sets a phase status, re-orders `phases[]` or satisfies a gate — the resident appears in the journal only as recorded directives, guidance text and telemetry. The claim is proven in **two** shapes, never one: **proceed-only equivalence** — a run whose every solicitation returns `{action:"proceed"}` produces a journal byte-identical to the `--no-resident` control once `resident.*` and timing fields are excluded; and **steered-run invariants** — a run carrying real directives preserves phase order, computes every gate verdict from real evidence, and promotes no status the same evidence would not have promoted without a resident. Byte-identity is never asserted of a steered run, whose outcomes legitimately differ through the engine-owned verbs (`abort`, `select_roster`, `retry` guidance). *An implementation letting a directive set a status, reorder phases, or mark a gate satisfied MUST fail.*
- An action outside the closed union (`skip_gate`, `reorder_phases`, `set_status`, `extend_budget`, or any unknown field) is rejected by the `.strict()` schema; the engine proceeds deterministically and a `residentTripwire` row records `cause: "gate_bypass_attempt"`.
- An unreachable resident, a solicitation timeout, or unparseable JSON twice running degrades to fully deterministic with `resident.status: "degraded"` — no hang, no third reparse, no phase retry, no gate skipped.
- An absent or empty dispatch brief never spawns the resident: `resident.status: "disabled"` and a normal completion, an explicit non-error path.
- The journal carries `spendMicros` (engine-metered integer µ$), per-phase `steeringIterations`, `directivesRejected` and tripwire rows — sufficient for D4's month-1 evaluation — and **no ratio, percentage or share-of-total field**; DF2.1's twelve-field record is closed and gains nothing here.

**Technical notes:** the three solicitation points are stated once and carry the whole containment argument; the directive verbs are asymmetric by design; spend is metered engine-side in integer µ$ (DD-9).

**Full enterprise detail** is in the individual story file linked above.

### Story DF3.4: Tier-1 Pre-PR Approval Gate + `attach` Steering

**Story File:** [df3-4-approval-gate-attach-steering.md](../sprint-artifacts/dark-factory-v5/stories/df3-4-approval-gate-attach-steering.md)

As the factory operator,
I want a run to stop dead after its bundle is verified out-of-box and wait for my explicit, attributable approval before a PR is opened — and a way to steer a live run before it gets there,
so that the only thing standing between a green bundle and a public PR is a named human.

**Story Points:** 6 · **Sprint:** v5-S2 · **Depends on:** DF2.1, DF2.3, DF2.5, DF3.1, DF3.3

- **(make-or-break — intent record first, then teardown)** `requestApproval(runId, {proposal, reportId, headSha})` creates a durable `O_EXCL` record at `.sandbox/approvals/<run-id>.json` in state **`pausing`** carrying the bound `reportId` (DF5.1's `reverifyId`) and `headSha` — both required, both written before the irreversible step — **then** tears the box down, and only after teardown returns promotes the record by atomic replace to `awaiting-approval`, the state a decision may be submitted against. A crash between the two leaves a recoverable `pausing` record naming the run, its bundle and its bound report; a `pausing` record is never decidable. No further phases execute until a decision — no PR, no branch push, no ref outside `refs/sandbox/<run-id>`. *A teardown-first order loses the run entirely when killed mid-teardown and MUST fail.*
- An allowlisted approver's `fleet approve`/`reject` closes the record with `approverId`, `decidedAt` and `reason`; there is no path from `rejected` to a PR, and a duplicate or contradicting second decision returns the **first** with no state change. *Last-write-wins MUST fail.*
- A host process killed mid-pause reloads the record from disk with state unchanged and the run still decidable; no decision within the policy timeout (default 24h) closes `timed-out` and **auto-ABORTs** — nothing reaches `approved` without a decision record.
- A non-allowlisted approver or non-matching token hash is refused with no state change and logged as a security event; a missing, unreadable, or wider-than-`0600` allowlist refuses **every** decision, and an empty allowlist refuses all rather than allowing all.
- `fleet attach <run-id> --message -` reaches the tier-2 resident and is acked with the run's `requestId`; a run in `awaiting-approval` (box gone) refuses `run-not-attachable` with the record unmutated.

**Technical notes:** the gate relocates from P1.10's mid-run pre-push point to tier-1 pre-PR (D8/F10); pause is free because the box dies first; approver authentication is token-hash against a `0600` allowlist.

**Full enterprise detail** is in the individual story file linked above.

### Story DF3.5: Tier-1 Claude Code Factory Skills over the Tested Fleet CLI

**Story File:** [df3-5-tier1-factory-skills.md](../sprint-artifacts/dark-factory-v5/stories/df3-5-tier1-factory-skills.md)

As the factory operator working inside Claude Code,
I want skills that route me to the right tested `fleet` verb and help me read its result, rather than an assistant that composes fleet commands from memory,
so that the guards measured into the CLI cannot be dropped by a plausible-looking improvisation.

**Story Points:** 2 · **Sprint:** v5-S2 · **Depends on:** DF3.1, DF3.2, DF3.4

- **(make-or-break)** Every `fleet` invocation in every fenced block of the four skill files resolves to a verb **and** a flag set exported by `listVerbs()`; an unknown verb, unknown flag, or omitted required flag fails with `file:line` and the offending token. *A skill documenting a plausible-but-absent flag MUST fail.*
- Frontmatter `name` matches the directory and `description` names the routed verbs; no body instructs composing `ssh`, `curl`, key-mint, key-revoke, VM-destroy or `git push` directly.
- A failed verb means report-and-stop using the CLI's own `remediation` line — never a hand-rolled workaround, never an unoffered retry; an unknown verb means `fleet --help` and stop, never guessing the nearest.
- No file contains Max-subscription-derived rates or any claim that a personal subscription covers client work; `factory-guide` states once that client deployments run on an **org-owned API key under Commercial Terms §A.1**.
- Approving a run routes to `fleet approve` with the token supplied by the operator on stdin — no skill file contains, embeds, or offers to generate an approver token.

**Technical notes:** thin skill, fat recipes; the verb registry is the contract and is owned by DF3.1 (`src/fleet/verbs.ts`), with DF3.2 and DF3.4 registering their own verbs through it; commercial wording is bound by R5 §6 fact 10 and the F8 gates report.

**Full enterprise detail** is in the individual story file linked above.

### Story DF3.6: Resident-Agent Bounds — Iterations, RSS, and an Absolute Spend Ceiling Enforced by the Engine

**Story File:** [df3-6-resident-agent-bounds.md](../sprint-artifacts/dark-factory-v5/stories/df3-6-resident-agent-bounds.md)

As the factory host paying for every sandbox,
I want the phase engine to cap the resident agent's steering iterations, memory, and absolute spend below the run key's own cap,
so that a resident agent that loops, leaks, or burns money is stopped by the component it cannot influence, while the run still finishes deterministically.

**Story Points:** 3 · **Sprint:** v5-S2 · **Depends on:** DF1.1, DF1.5, DF2.3, DF2.8, DF3.3

- **(make-or-break)** At `ceiling − ε` where ε is below the projected worst-case next call, the engine does **not** issue the call: the resident stops with `bound:"spend"`, the run continues deterministic, and recorded spend never exceeds the ceiling at any journal point. *Metering only after the call — the obvious implementation — overshoots by one call and MUST fail.*
- The ordering assertion is **two checks over two different quantities, never one over the minted cap**: (a) at config time over static defaults, bounds violating `residentSpendCeilingMicros < runBudgetCapMicros ≤ defaultKeyCapMicroUsd` — DF2.3's *configured default* key cap — or a ceiling expressed as a percentage/ratio/share refuse the run at manifest load inside the box, before the resident spawns, exiting non-zero with `{code: "bound-config-invalid"}` in the payload; (b) per run, this run's minted `limitMicroUsd` only **clamps** — the effective ceiling is `min(residentSpendCeilingMicros, limitMicroUsd)`, journaled as `{bound:"spend", action:"clamped"}`, and the run proceeds, because a remainder-capped mint is a normal state, never a misconfiguration. The type is absolute integer µ$ and the schema has no ratio field.
- The iteration bound is **per phase**: exhausting `maxSteeringIterations` stops solicitation for that phase only, and subsequent phases solicit normally.
- Exceeding `residentRssBytes` kills the subprocess tree, records `exitStatus: "overflow"` and a `watchdog_kill` tripwire, continues the run deterministic, and leaves no orphaned child on a post-run pid-tree check.
- A reply with no usage field, or a platform where RSS is unreadable, fails closed: the call is charged the **projected worst case** (never zero), and an unwatchable resident is never started.

**Technical notes:** the ordering invariant between the three ceilings is the whole point of the number; an absolute ceiling replaces the 15% ratio per the gates report §3.3 (BINDING); metering is pre-flight projection, engine-side, never post-hoc.

**Full enterprise detail** is in the individual story file linked above.

---

## Epic DF4 — Visualizer adoption (§8 step 4)

**Mission:** put the SSSF visualizer over our own trace store behind a token gate on a
loopback-bound port, and bound the liability of ~4,656 lines of vendored TypeScript and Vue with a
real test suite, a machine-checked Bun-API inventory, and a per-box deploy path. — 2 stories · 10 pts

### Story DF4.1: Visualizer Port + Tunneled Auth Gate

**Story File:** [df4-1-visualizer-port-auth.md](../sprint-artifacts/dark-factory-v5/stories/df4-1-visualizer-port-auth.md)

As the tier-1 operator,
I want the SSSF visualizer running against our own trace store behind a token gate on a loopback-bound port I reach through a tunnel,
so that I can read a run's compiled prompts, gate evidence and cost breakdown without publishing client source code to anything that can route to the box.

**Story Points:** 6 · **Sprint:** v5-S3 · **Depends on:** DF1.4, DF2.9 (consumer of its NOTICE sweep — the vendored tree must keep that shipped gate green)

- **(make-or-break)** The server refuses to listen without `QDS_VIZ_TOKEN` ≥32 bytes, passes an explicit `hostname: "127.0.0.1"` to `Bun.serve`, and rejects every request on **every** route — including `GET /api/health` and the static branch — lacking a matching Bearer or Basic credential under a **constant-time** compare, with `401` and an empty body.
- The `#/` → `#/<requestId>` → `#/<requestId>/<phaseId>` walk serves L1 with phases and agents embedded (no per-card request), L2 in one response, and L3 rendering compiled prompts, `checks_json` **and** `violations_json`, and the derived read/write token split — all keyed on `request_id`, never `adw_id`.
- A **pre-migration** trace is a runtime degradation, not a fatal one: `/api/health` reports the degraded condition, data routes return `500` through the `safely()` wrapper rather than taking the server down mid-run, and the column probe substitutes `NULL AS <column>` and re-probes until the `ALTER` lands. A trace **absent or locked past `busy_timeout` at startup** is fatal instead — the reader cannot open it read-only and the process exits non-zero with a named error (INV-5), never starting degraded.
- A nonexistent or event-less `requestId` pages empty with the cursor unchanged and `hasMore:false` — `200`, not `404` — with `limit` clamped to `MAX_LIMIT = 1000` **before** binding.
- `assertNeverPublic(port)` throws for the visualizer's port, and no code merged here registers it with any exposure path — the visualizer is never the box's single anonymous port.

**Technical notes:** the prompts route reads the trace, not the disk; browser credential presentation was ratified as a derivation decision in cross-story review; what is carried over from upstream is enumerated deliberately rather than adopted wholesale.

**Full enterprise detail** is in the individual story file linked above.

### Story DF4.2: Visualizer Test Suite from Zero, Bun-API Inventory, Per-Box Deploy

**Story File:** [df4-2-visualizer-tests-deploy.md](../sprint-artifacts/dark-factory-v5/stories/df4-2-visualizer-tests-deploy.md)

As the engineer who has to maintain someone else's untested UI,
I want a bounded test suite over the visualizer's server and library layers, a machine-checked inventory of every Bun-only API it uses, and a per-box deploy path that starts it behind DF4.1's gate,
so that adopting ~4,656 lines of vendored TypeScript and Vue does not become an unbounded liability and does not become the enterprise tier's first regression.

**Story Points:** 4 · **Sprint:** v5-S3 · **Depends on:** DF4.1, DF2.2, DF1.4, DF1.6, DF2.3, DF2.5

- **(make-or-break)** `bun test visualizer/` covers all eight JSON routes and the static branch (authenticated, unauthenticated, malformed, plus a browser-shaped navigation with no header), the `optionalColumn` probe/latch, the rowid-cursor page and clamp, the read/write usage split, and all six client lib modules — with `visualizer/server/**` and `visualizer/src/lib/**` at ≥90% line coverage and the `.vue` exclusion **named** in `bunfig.toml` with its rationale.
- `bun-api-inventory.test.ts` greps the tree for `Bun.`, `bun:` and `import.meta.dir` and fails on any usage absent from `bun-apis.ts` **or** any inventory entry with no usage — so DF2.9's image contract gets a real runtime floor.
- The provider `observe` verb starts the visualizer inside the box bound to `127.0.0.1` with the token over **stdin, never argv**, returns the forward command and port, and is idempotent on a second call.
- A failed in-box start (port bound, trace missing, token unset) reports the named failure and **leaves the box alive**: never destroys it, never falls back to `0.0.0.0`, never reaches for `share port`/`set-public`.
- Fixtures exercise a zero-session trace (empty L1 list, `200`), a pre-migration schema (`NULL AS <column>` later returning real values), and an unopenable `bun:sqlite` handle (named startup failure).

**Technical notes:** bounded scope is the point and the boundary is stated explicitly; the sizing risk is recorded rather than hidden (R5 §7).

**Full enterprise detail** is in the individual story file linked above.

---

## Epic DF5 — Lights-on (§8 step 5)

**Mission:** the P1.15 moment, re-derived — harvested commits re-tested and re-gated on the host,
a PR opened by a credential that has never been inside a sandbox, an audit chain that walks the
merged PR back through every record that authorized it, and one re-runnable gate that says the
lights are on. — 5 stories · 17 pts

### Story DF5.1: Host-Side Out-of-Box Re-Verify Before Any PR

**Story File:** [df5-1-host-side-reverify.md](../sprint-artifacts/dark-factory-v5/stories/df5-1-host-side-reverify.md)

As a factory operator,
I want the harvested commits re-tested and re-gated on the host, by code that read nothing the box produced,
so that the decision to open a PR rests on evidence the box could not have written.

**Story Points:** 4 · **Sprint:** v5-S2 (lights-on head) · **Depends on:** DF1.1, DF1.2, DF1.6, DF2.1, DF2.5, DF3.4

- **(make-or-break)** The verdict is computed **only** from fetched git objects and the host toolchain, persisting a `ReverifyReport` with `verdict`, `headSha`, `baseSha`, `checks` (a `GateCheck` per item with `note` populated on passes), `testResults`, `flags`, `discrepancies`, `toolchain`, `durationMs`. *Reading `testResults` from the harvested step output and reporting it as its own result MUST fail the authority test.*
- The gate plan comes from the **host's** pinned manifest; a divergent manifest, `package.json` or runner config in the harvested tree is recorded as a `flag`, never applied — the tree supplies code to run, never the command that judges it.
- A green in-box claim against a red host run yields `red` with every mismatch enumerated in `discrepancies`; box-red/host-green is recorded the same way and the host verdict still stands.
- An incompletable check (worktree failure, missing toolchain, unspawnable gate, wall-clock or RSS bound) is `error` with the cause named, the worktree pruned, and a non-zero exit without indefinite retry — `error` is never `green`.
- `harvested: none` or a zero-check gate plan is `red` with reason `nothing-to-verify` as a normal typed outcome — an empty check set is never green.

**Technical notes:** host-pinned plan resolution is the point of the story; `testsExecuted` is disambiguated host-side; determinism is preferred over retries, and evidence flags never block.

**Full enterprise detail** is in the individual story file linked above.

### Story DF5.2: Host-Side PR Creation from the Quarantine Ref

**Story File:** [df5-2-host-side-pr-creation.md](../sprint-artifacts/dark-factory-v5/stories/df5-2-host-side-pr-creation.md)

As the factory operator,
I want the pull request opened from my machine, with a credential that has never been inside a sandbox, only after the host re-verified the work and I approved it,
so that the one irreversible, outward-facing action the factory takes is the one action a box can neither perform nor forge.

**Story Points:** 4 · **Sprint:** v5-S2 (lights-on head) · **Depends on:** DF5.1, DF3.4 *(P1.3 issue-mirror and P1.7 lsp-gate removed from hard deps: P1.3's mirror index is non-blocking — an unresolved mapping renders `Issue: unresolved` and the PR still opens; P1.7 is unused here — the publication gate is DF5.1's host-side re-verify, not an LSP gate. Both remain KEEP and are repointed by DF5.5.)*

- **(make-or-break)** Given a green `ReverifyReport` (identifier `R`, completed at `completedAt`) verifying `headSha` `H`, and an `ApprovalRecord` whose `decidedAt` follows `R.completedAt` (not `startedAt`) and whose bound `reportId`/`headSha` match `R`/`H`, the verified sha `H` itself — never the ref name — is pushed non-force to `refs/heads/qds/<run-id>` with a **host-side** token, a PR opens against the registered base, and `prUrl`/`prNumber` are written at creation time.
- The body carries, each on its own labelled line: `runId`; a line labelled `Issue:` that is **always rendered** — issue references resolved through P1.3's mirror index, e.g. `Issue: Closes #42`, with an unresolved mapping rendering `Issue: unresolved` rather than omitting the line, which is what makes DF5.4-C8 assertable; the DF2.8 cost summary in USD with event and `unpriced` counts; the DF5.1 verdict, check tally and failing items; the DF3.4 `approverId` and `decidedAt`; DF5.1's `flags`; and the changed-file list.
- A red, error, absent, or sha-mismatched report — or an absent, non-approved approval, or one whose `decidedAt` predates `R.completedAt` or whose `reportId`/`headSha` do not match the final report — pushes **no ref and opens no PR**, records the refusal as a comment on the linked issue naming the failing checks and report path, and exits non-zero without hanging.
- Re-invocation with an existing `prUrl` returns that PR unchanged with no second PR and no push; a remote branch at a **different** sha refuses rather than forces; a successful push with a failed PR-open resumes at the PR-open step — every boundary resumable, none partially recorded.
- A remote absent from `.factory/repos.json`, a missing/unreadable/wider-than-`0600` allowlist, or no host token pushes and opens nothing and logs a security event; an empty allowlist matches no repository, never "any".

**Technical notes:** DD-10 is stated once — the box never holds a push credential; the ordering (harvest → re-verify → approve → push → open) is fixed per design §5.3/F10; cost renders from integer µ$ per DD-9.

**Full enterprise detail** is in the individual story file linked above.

### Story DF5.3: Audit Chain Extended to Credential, Box, Bundle and Re-Verify Links

**Story File:** [df5-3-audit-chain-extended.md](../sprint-artifacts/dark-factory-v5/stories/df5-3-audit-chain-extended.md)

As an enterprise reviewer asked to trust an autonomous factory with a client's codebase,
I want one command that walks a merged PR back through every host-side record that authorized it — the re-verify that earned it, the approval that released it, the key that paid for it,
so that "the factory did this" is a walk over immutable records rather than an assertion.

**Story Points:** 4 · **Sprint:** v5-S3 · **Depends on:** DF1.4, DF1.8, DF2.1, DF2.3, DF2.5, DF2.8, DF3.4, DF5.1, DF5.2 (R5 §2) — the full set, because this story edits four DF2.x-owned files and resolves records those stories write. P1.11/P1.12's retain-receipt edge is **degraded to VOID**, not satisfied (DD-4)

- **(make-or-break)** Invoked with a PR URL, branch name or runId, **all ten hops** resolve to a non-null record with a stable ID, hop 10 (Hindsight's retain receipt) typed `{status: "void", reason}` per the P0.11 VOID convention pending §8 step 6. *Returning `null`, omitting the memory hop, or calling a chain complete with an absent hop MUST fail.*
- A broken correlation key names the **specific** broken hop with `{hop, expected, actual, diagnostic, evidencePath}` and exits non-zero — never a partial chain reported as complete, never a silent failure.
- Every link row is written **by its emitter at the moment of the event, never retroactively**; a run whose links were never emitted resolves those hops as `unlinked` naming the emitter, and no link is synthesized by inference from end state.
- The walk completes under **30 seconds** with a 3-second per-hop ceiling; a hop exceeding its ceiling fails closed as `hop-timeout` rather than being reported resolved.
- A legitimately absent hop resolves `{status: "not-applicable", reason}` rather than null and the chain is complete — but a chain resolving only `void`/`not-applicable` hops is **broken**, never vacuous.

**Technical notes:** the ten-hop table is NET-NEW per DD-8; hop 10's VOID status is BINDING per DD-4 / register §4; the 30-second budget is defended in the story rather than inherited from P1.16.

**Full enterprise detail** is in the individual story file linked above.

### Story DF5.4: Lights-On Exit Gate on the P0.11 Chassis

**Story File:** [df5-4-lights-on-gate.md](../sprint-artifacts/dark-factory-v5/stories/df5-4-lights-on-gate.md)

As the operator deciding whether the Dark Factory is actually finished,
I want one read-only command that asserts each clause of §8 step 5 against host-side evidence and prints a per-clause verdict with its reason,
so that "the lights are on" is a green report I can re-run, not a demo I remember going well.

**Story Points:** 3 · **Sprint:** v5-S3 · **Depends on:** DF5.1, DF5.2, DF5.3, DF3.1, DF3.4, P0.11 *(The clause map also asserts against artifacts owned by DF1.2, DF1.4, DF1.6, DF2.1, DF2.2, DF2.5 and DF2.8 — reached **transitively** through the six direct predecessors above and not repeated as edges.)*

- **(make-or-break)** On the lights-on run of record all **eleven live clauses** return `pass`, `DF5.4-V1` is recorded with its `void_reason` and **excluded from the verdict**, `overall` is `"PASS"`, stdout terminates `DF_GATE: PASS`, the versioned report is written, exit `0`.
- Any failing clause returns FAIL carrying that clause's **assertion id, expected, actual and diagnostic** — named, never summarised — stdout terminates `DF_GATE: FAIL`, exit `1`, and §8 step-6 derivation does not begin.
- Repeated runs against unchanged state produce identical results — a non-deterministic gate turns red into retry.
- An unreadable or unevaluable clause returns `skip` with a named reason and the gate is **red**; a fatal error before any assertion exits `2` with no report claiming a verdict.
- A clause set whose live clauses have all been voided or removed is FAIL, never a vacuous PASS; a failed preflight clause still **lists** the main clauses, marked `skip` with the fail-fast reason.

**Technical notes:** the clause map is re-derived from §8 step 5 (NET-NEW per DD-8); the gate runs on P0.11's existing chassis using its own option surface and four-value `pass|fail|skip|void` enum, with assertion modules shaped after `p0-3-mixed-model.ts`.

**Full enterprise detail** is in the individual story file linked above.

### Story DF5.5: KEEP-Repoint Chore — Dependency Edges, Boundary Amendments, SwarmClaw Role Line

**Story File:** [df5-5-keep-repoint-chore.md](../sprint-artifacts/dark-factory-v5/stories/df5-5-keep-repoint-chore.md)

As a developer picking up a KEEP story after the v5 re-derivation,
I want every retired story ID in that file replaced by its DF successor and every ownership boundary stated in the file itself,
so that I do not build against a dead premise or ship a second copy of something a DF story owns.

**Story Points:** 2 · **Sprint:** v5-S3 (applied last, after all repoint-target stories are merged and the DF slate IDs are frozen) · **Depends on:** DF1.3, DF1.5, DF1.6, DF1.8, DF2.8, DF3.1, DF5.2, DF5.3, DF6.1 — the successor IDs this chore actually writes into a file (amendments A, C and D; E is retired as already-satisfied and writes nothing); a frozen ID that appears in no amendment is not an edge

- **(make-or-break)** After amendments A–E, the specified grep across **all 11 KEEP files plus P0.7** (amendment D) — 12 files, phase-0 included — returns zero un-repointed `P1.x` references, and every one of the **11 amended** files matches `v5 amendment (DF5.5)`; `p0-5` has zero hits and is never amended. *A find-and-replace that rewrites historical provenance references ("shipped PR #40/#87") into DF IDs passes the grep, destroys the record, and MUST fail review.*
- P1.9 and P1.5 each name the DF story owning the adjacent scope (DF1.3 owns in-phase retry; DF1.5 owns the roster schema and dual slug validation) with **no character changed** in either file's Acceptance Criteria.
- `p0-7-swarmclaw-agent-mcp-hindsight.md` carries the one-line DD-7 role statement with no P0.7 asset, AC or DoD item modified — P0.7 stays frozen DONE-KEEP.
- **(failure path)** A repoint whose successor ID is absent from the DF stories directory stops the chore and records the missing ID in the amendment log rather than writing a dangling pointer.
- **(boundary)** RETIRE-disposition files (P0.1, P0.4, P0.8 and the audit §2 RETIRE rows) are not opened for edit — retired stories are historical record.

**Technical notes:** the successor map is binding (sourced from R5 §2 + audit §2, reproduced in this index's ancestry table); amendment B's two enum-citation fixes are recorded NOT-FOUND rather than invented; amendments C and D are additive and AC-untouched.

**Full enterprise detail** is in the individual story file linked above.

---

## Epic DF6 — Feedback loop (unslotted §8 hole #2, scheduled after step 5)

**Mission:** close the loop the §8 build order never slotted — a bot review comment on a
factory-produced PR triggers a bounded fix run that ends in a green PR or an escalation to a
human, never an unattended loop and never a force-push over a reviewer's history. — 1 story · 6 pts

### Story DF6.1: PR Feedback → Bounded Fix Run → CI Green

**Story File:** [df6-1-pr-feedback-fix-loop.md](../sprint-artifacts/dark-factory-v5/stories/df6-1-pr-feedback-fix-loop.md)

As the factory operator,
I want a bot review comment on a factory-produced PR to trigger a bounded fix run that ends in a green PR or a human handoff,
so that the factory maintains its own pull requests without ever looping unattended or force-pushing over a reviewer's history.

**Story Points:** 6 · **Sprint:** v5-S3 (after DF5.2 — the loop needs a PR of its own to fix) · **Depends on:** DF1.5, DF1.6, DF3.1, DF3.4, DF5.1, DF5.2, DF5.3 *(DF1.5 owns the roster schema whose per-role `writes` list the single-fixer guard reads; DF5.3 owns `recordAuditLink`/`walkAuditChain`, which this story extends so a fix run's own chain is reachable from the PR.)* *(P1.18 is **not** a predecessor: its webhook receiver is out of scope for v5.0, and `scripts/fix-run.ts --pr <n>` reads the PR's comments directly through the GitHub API.)*

- **(make-or-break)** A run in `review_feedback_detected` with ≥1 bot comment dispatches through DF3.1 as a normal factory run pinned to the PR branch head; the tier-3 team reads the comment and implements a fix, and the `dispatch_task` envelope validates against the step-output schema with `changedFiles` non-empty. *An implementation shelling `warren run --team` MUST fail — that flag exists in no examined Warren version.*
- With the fix-run bundle harvested and DF5.1's re-verify green, the host **appends** commits to the PR branch — no force-push, no rewrite, never the default branch — and no push credential was present in the box at any point.
- The **required** CI checks (non-required ignored) are **polled** host-side via `gh pr view --json headRefOid,statusCheckRollup` (per-check results carry the SHA, so every poll is bound to `attemptSha` — `gh pr checks` reports no per-check SHA) every 30 seconds, bounded by a 15-minute **CI-poll window measured from `pushVerifiedSha`'s return** — not a wall clock over the whole attempt: execution inherits DF3.1's caps, re-verify DF5.1's, and the approval wait is excluded from every budget, timing out separately as `approval-timed-out`. There is no webhook receiver in v5.0, and reaching the poll ceiling without a settled required-check set is a `ci-verdict-unavailable` escalation, never a green. A poll result counts as this fix's verdict only when it is bound to the attempt's sha; on green the run advances to summarize and a terminal success state, a red suite is a FAIL, and a flaky suite is rerun **once**, then FAIL.
- **(failure path)** Attempt 2 increments `fixContext.attempt` carrying attempt 1's CI failure output; after two failures no third run is dispatched — the run records `(error log, diff attempted, CI failure messages)` and **escalates to a human** via a PR comment carrying that diagnostic set plus the runIds.
- **(boundary)** A fix roster declaring ≥2 workers with workspace write access exits non-zero provisioning nothing, naming the unproven-capability guard; zero bot comments, or comments only on a closed/merged PR, dispatches nothing and exits `0`.

**Technical notes:** the MANDATORY scope caveat from R5 §6 fact 2 / gates report §1(b) is carried verbatim; the host-side push half is split out of P1.19's source clause per R2 §10 (INV-3/D8); attempt bookkeeping and the fresh-authored parts are marked NET-NEW per DD-8.

**Full enterprise detail** is in the individual story file linked above.

---

## Ancestry — the 30-story superstructure against the v5 slate

Source: `docs/superpowers/specs/2026-08-11-story-disposition-audit.md` §2 (dispositions),
§4 (holes), R5 §2 (successor map). **10 RE-DERIVE · 3 RETIRE · 6 DONE-KEEP · 11 KEEP.**

| Old ID | Disposition | v5 successor / note |
|---|---|---|
| P1.1 Dev manager registered | RE-DERIVE | **DF3.1** — front door becomes tier-1 Claude Code + the tested fleet dispatcher (D2/D3); SwarmClaw demoted to host-side chassis |
| P1.4 Protocol template | RE-DERIVE | **DF1.1** — the SwarmClaw protocol engine was never built; D6 adopts the SSSF-ported TS phase engine (graph intent also lands in DF3.2) |
| P1.6 Pi-team Warren run | RE-DERIVE | **DF1.6** (flagship) — triply dead premise; `QDS_TEAM_RUNNER=local` replaces `warren run`, RSS watchdog re-aimed at the real subprocess tree |
| P1.8 Drive run + capture | RE-DERIVE | **DF1.8** — capture subsumed by the adopted trace store; issue-correlation clauses survive |
| P1.10 Approve/resume via Telegram | RE-DERIVE | **DF3.4** — the pause relocates to tier-1 pre-PR (D8/F10); mid-run steering becomes DF3.3 + `attach` |
| P1.13 Cost ledger within budget | RE-DERIVE | **DF2.8** — enforcement layered: capped key at mint, tier-1 dispatch refusal, quota accounting (DF2.3/DF2.6) |
| P1.15 Real PR produced | RE-DERIVE | **DF5.2** — the warren push path dies; bundle harvest → host-side re-verify (DF5.1) precedes any PR |
| P1.16 Audit chain reconstructable | RE-DERIVE | **DF5.3** — chain extends with credential, box, bundle and re-verify links |
| P1.17 Phase-1 make-or-break gate | RE-DERIVE | **DF5.4** — gate pattern survives on the P0.11 chassis; clause set re-derived from §8 step 5 |
| P1.19 Pi Pair fix → PR green | RE-DERIVE | **DF6.1** — `warren run --team` exists in no version; intent survives as the bounded fix loop |
| P0.1 Archon env-patch productionize | **RETIRE** | No successor — v5 has no DAG (D2); per-agent env-override intent covered by DF1.5's roster config |
| P0.4 Hard-guard loopy-prompt kill | **RETIRE** | No successor story — caps landed in the cli-anything launcher; the live kill demo re-attaches to **DF2.4** + §5.2 watchdogs |
| P0.8 Telegram verify / OQ-3 | **RETIRE** | Deferred by Warren decision; the channel layer itself has no §8 step (hole #1) |
| P0.2, P0.3⚠, P0.6, P0.7⚠, P0.10, P0.11 | DONE-KEEP | Built and evidenced; consumed as assets (P0.2/P0.3 by DF1.6 and DF1.9, P0.11's chassis by DF5.4). ⚠ = flagged defect recorded in audit §5 |
| P0.5, P0.9, P1.2, P1.3, P1.5, P1.7, P1.9, P1.11, P1.12, P1.14, P1.18 | KEEP (11) | Valid as written. **Repointed by DF5.5**: dependency edges swapped to the successors above, plus additive ownership-boundary lines (DF1.3 ↔ P1.9 retry, DF1.5 ↔ P1.5 roster) and the DD-7 SwarmClaw role line on P0.7. ACs untouched |

> Historical provenance references ("shipped in PR #40/#87") are **annotated, never rewritten** —
> only forward-looking references are repointed (DF5.5 AC1 negative control).
