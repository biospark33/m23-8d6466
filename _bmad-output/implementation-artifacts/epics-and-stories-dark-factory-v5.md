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

> **Epic bullets are summaries, non-normative; story files govern.** Where a bullet and its
> linked story file disagree, the story file is authoritative.

| Epic | Mission (§8 step) |
|---|---|
| DF1 | Phase engine |
| DF2 | Provider seam + credentials |
| DF3 | Fleet dispatcher |
| DF4 | Visualizer |
| DF5 | Lights-on |
| DF6 | Feedback loop |

> **Slate arithmetic is deliberately absent from this file.** Story count, points, per-epic and
> per-sprint subtotals, statuses and the dependency graph live in
> `_bmad-output/sprint-artifacts/sprint-status.yaml` and are read from there. This index carried a
> second copy of those numbers from 2026-08-11 until 2026-09-08 and it was wrong for most of that
> window — a duplicated count can only go stale.

> **The in-box restoration arc — DF2.10 → DF1.10 → DF1.11 → DF3.7 → DF3.8 — is five stories across
> three epics and reads as one sequence.** `docs/superpowers/specs/2026-08-31-tier2-placement-adr.md`
> (ACCEPTED) found that tier 2 had silently been built host-side against a design that put it in the
> box, and unwinds that: **DF2.10** ships a substrate we own and can prove from inside, **DF1.10**
> moves the deterministic phase walk onto it, **DF1.11** closes the steering round trip on the box,
> **DF3.7** gives the host a way to learn a run finished, and **DF3.8** makes that happen without an
> operator watching. Each story's section names its place in the arc; the ADR governs where any of
> them disagrees with this index, **including its Appendices A and B** (2026-09-08).

> This index is the brief (dual-output Output-2). Per **SPL-009** it does **not** duplicate
> Definition of Done, Security Invariants, Observability Contracts, Trigger Surfaces or
> Files-to-Modify — those live in the individual story files and are authoritative there.

---

## Epic DF1 — Phase engine (§8 step 1)

**Mission:** port SSSF's phase abstraction to TypeScript test-first (D6/D10) so tier 2 runs an
ordered, budget-bounded, journaled phase walk whose success must be earned, whose gates carry
evidence, and whose every event lands in one queryable trace.

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

**Story Points:** 8 · **Sprint:** v5-S1 (flagship — closes S1's engine chain) · **Depends on:** DF1.1, DF1.2, DF1.5, DF2.2, DF2.7, P0.2, P0.3

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

### Story DF1.10: In-Box Phase Engine — the Deterministic Walk Runs Where the Design Put It

**Story File:** [df1-10-in-box-phase-engine.md](../sprint-artifacts/dark-factory-v5/stories/df1-10-in-box-phase-engine.md)

As the factory operator,
I want the deterministic phase walk and its resident to run inside the sandbox they are spending and committing in,
so that a run survives my laptop closing, and the watchdog, the bounds and the one capped key watch a process tree that is actually local.

**Story Points:** 8 · **Sprint:** v5-S3 (in-box restoration arc, story 2 of 5 — unblocked by DF2.10, unblocks DF1.11 and DF3.7) · **Depends on:** DF1.1, DF1.4, DF1.6, DF2.5, DF2.10, DF3.1 *(Not edges: DF3.3, because the resident relocates when **its caller** relocates and needs no code change to run in-box; and DF3.7, because the engine has never called the approval gate, so there is no gate seam here to move.)*

- **(make-or-break)** `fleet run <run-id>` starts the per-run systemd instance and **returns**; every phase — `code`, `dispatch_task` and gate kinds alike — executes in-box, and the terminal marker is written by the in-box engine and read by the host rather than by any host-side journal. *Negative control: the shipped shim shape — host walks the phases, `driver.exec`s only `code` kinds and throws for every other kind — satisfies a naive "the run finished ok" assertion and MUST fail.*
- Engine delivery is **net-new, not a reuse of an existing checkout**: it arrives by image (its build stage changes the digest, so the box boots a re-pinned rebuild through DF2.10's own pin ritual), never by `fill` and never from `$HOME/src`, which in production is the **customer's** repo. `pipeline.yaml` and `run-context.json` move into a `.qds/` dir inside the checkout, silenced by one `.git/info/exclude` line, so manifest load, witness read, code-phase `cwd` and roster resolution finally agree on one run-root while setup-gate assertion A's `git status --porcelain` stays **honestly clean** rather than taught to tolerate dirt.
- The resident runs in-box on **one** key — the run's own capped key at `$HOME/app/.env` — no second key is minted anywhere, and the RSS watchdog samples a genuine local subprocess tree at last. `QDS_PI_CATALOG_DIR` must be set in-box and the catalog directory ships in this story's image stage: pi is a compiled ELF with no sibling `node_modules`, so without it every solicitation and every `dispatch_task` phase is refused. *Negative control: an image carrying pi but no catalog passes DF2.10's own e2e demo, then disables the resident on the first solicitation.*
- The durability split is explicit and harvest carries all of it out: the marker and trace stay on tmpfs `/run` (polled live, harvested before teardown, **measured** wiped by a reboot), while the journal, the resident session, the redacted prompt/reply artifacts and the engine log go to ext4 `$HOME` as audit evidence that must survive. The artifacts pull stays teardown's step 2, ahead of revoke and destroy, and `assertPathSafe` is not relaxed.
- **Reclaim semantics:** `Restart=no` is a **correctness requirement, not missing hardening** — `writePhase` always persists `fail` and `promotePhase` is the only path to success, so a crash between them is deliberately recorded as failure. An engine invoked against a run that already carries a marker **refuses and exits without re-walking**. *Negative control: an auto-restarting engine re-walks phases whose `sbx/<runId>` commits and spend already happened, passes a naive "the run recovered" test, and MUST fail.*

**Technical notes:** `fleet status` now reads the marker off the box, so a live in-box run stops reporting `ready` forever, reusing the fan-out poller's verdicts and its unusable-tick ceiling verbatim (INV-IBOX-7); every load-bearing stopgap self-labelled as owed to this story is retired **here** rather than left lying — the remote-shim honest label, its throw for non-`code` kinds, and the tier-4 host-side phase bodies. Renumbering, stated once: pre-2026-08-31 references to "DF1.10 owns the round trip" mean **DF1.11**.

**Full enterprise detail** is in the individual story file linked above.

### Story DF1.11: In-Box Steering Executor + Channel Lifecycle

**Story File:** [df1-11-in-box-steering-executor.md](../sprint-artifacts/dark-factory-v5/stories/df1-11-in-box-steering-executor.md)

As the factory operator steering a live run,
I want my guidance drained and acknowledged by the engine on the box that is actually running my work, and the channel still there after that box reboots,
so that `attach-acked` means a real process consumed my message and `no-ack` becomes a fault worth investigating instead of the permanent shape of the system.

**Story Points:** 5 · **Sprint:** v5-S3 (in-box restoration arc, story 3 of 5 — the first arc story whose value is a closed round trip, not a relocation) · **Depends on:** DF1.10, DF3.3, DF3.4 *(Not an edge: DF2.10 — the tmpfiles drop-in is written at box birth inside the existing provisioning script, so this story is verifiable on a stock image and convergence with the baked copy is asserted by an idempotency arm rather than by a dependency.)*

- **(make-or-break)** The ack that produces `attach-acked` is written **by the in-box engine** into the box's own `acks.ndjson`, and the engine's inbox port holds no driver or vm reference — local `node:fs` only. No production process outside the box opens a steering file. *Negative control: an ack produced host-side, or proven solely against a FakeDriver suite where both legs coincidentally share one filesystem, passes a naive "was it acked?" test and MUST fail.*
- Channel persistence is **declarative, not reactive**: provisioning also writes `/etc/tmpfiles.d/qds-steering.conf` in the name form with the user and group expanded by the box's shell **at write time** — tmpfiles.d expands nothing, so a literal `$(id -un)` left in the file is an unparseable user field, not a late binding. After a real reboot `/run/steering` exists again at 0700, recreated by `systemd-tmpfiles-setup` with **no code of ours running**. *A re-provision triggered by the first channel-attributable send failure — the rescinded design — passes a "channel came back" test and MUST fail.*
- The engine is launched with the record's **minted** fleet run id from the box-local `run-context.json`, never a bare-uuid default: a non-minted id fails the id-space check, the `ownRunId` filter then rejects **every** attach line, and the run steers silently to nothing. The mismatch warning rides the trace sidecar, because in-box stderr is where nobody is looking.
- The reboot-loss contract is honest: inbox, acks and lock die **together** on the same tmpfs and **the run dies with them** — nothing resumes it, so queued-but-unfolded messages are lost and the operator-facing prose says so. The recreated channel serves the **next** run on that box, on an empty queue and an empty dedupe set. Exactly one engine-startup row carries the box's `boot_id` and uptime, on a surface that survives the event it records.
- The live-e2e PASS shape **inverts** and the old shape becomes a false green: `attach-acked`/exit 0 with no `reason` field, the at-ceiling attach folded truncated **and** acked, and a retry proving double delivery with two acks. Every shipped string promising a future executor is retired in the same diff. *A test still passing on `no-ack`/exit 6 after this story is a false green and MUST fail.*

**Technical notes:** the bytes do not change, only the machine boundary — same inbox and ack line shapes, same `messageId` dedupe key, every ceiling inherited; `acks.lock` stays near-vestigial with a single in-box writer but costs zero diff and its staleness oracle is finally same-namespace; **double delivery is inherited deliberately** (a retry mints a fresh `messageId`, so dedupe cannot see it), with the `--message-id` flag named as the upgrade path and not claimed. Moving the channel to persistent `$HOME` was considered and rejected: the pinned image asserts `/run/steering`, so relocating it is a re-pin, and the reboot ends the run anyway, leaving a surviving queue with no consumer.

**Full enterprise detail** is in the individual story file linked above.

---

## Epic DF2 — Provider seam + credential lifecycle (§8 step 2)

**Mission:** encode the inkwell pattern as tested code — a small provider-driver seam, hard-edged
run records, an exe.dev driver whose setup gate proves the box is usable, per-run spend-capped
credentials, credential-free harvest and teardown, quota accounting, measured cost, and an image
contract that redistributes legally, plus the two 2026-09-08 defect stories that arm the spend
record the rest of the slate reads.

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

### Story DF2.10: Factory-Owned Boot Image — a Digest-Pinned exe.dev Substrate We Own

**Story File:** [df2-10-factory-owned-boot-image.md](../sprint-artifacts/dark-factory-v5/stories/df2-10-factory-owned-boot-image.md)

As the factory operator,
I want every sandbox to boot an image we built, pinned, and can prove from inside the box,
so that the runtime under a run is a reviewed artifact in git rather than whatever the vendor shipped this week.

**Story Points:** 5 · **Sprint:** v5-S3 (in-box restoration arc, story 1 of 5 — strict predecessor of DF1.10) · **Depends on:** DF2.2, DF2.9 *(Not an edge: DF2.3 — the registry pull credential is a host operator credential, never a per-run mint on DF2.3's cap-and-revoke lifecycle.)*

- **(make-or-break)** A box created at the pinned reference boots to `multi-user.target`, answers ssh as the login user, passes every `setupGate` gate, and its baked `/etc/qds-image.json` `buildId` **equals** the one the repo pin pairs with the digest that was pulled — a box that cannot state what it booted is not a factory box. The assertion extends **gate B** and adds no assertion letter, and it fails closed on an absent, oversized, unparseable or mismatched marker with the code in the **payload**. *Negative control: a test asserting only that `docker build` and `docker push` exited 0 proves the image exists and nothing about whether exe.dev can boot it, and MUST fail.*
- Runtimes are pinned by build arg and the drift behind them is closed: bun is pinned to the repo's own `packageManager` version so the in-box engine runs the runtime the tests ran on, and the setup gate's "requires pi 0.55.0" line is corrected to the owned version. The F14 arm that was **weakened** to tolerate an absent `~/.pi/agent/models.json` is **re-aimed, not re-tightened** — pi 0.84.x never writes that file, so owning the version makes the arm version-conditional and an unrevisited version bump is itself the refusal.
- `create()` threads two argv spreads through the existing literal — `--image` unconditionally, `--registry-auth` conditionally — each validated **in the constructor** at the same trust boundary that already refuses a bad `tag`, with the default reference as a module-level constant because the registry constructs the driver with **zero** options. *Negative control: an implementation reading `process.env` inside `create()` passes every unit test that constructs the driver directly and MUST fail.*
- The image is **public by default** and the private path ships validated, redacted and off: with a public image no credential reaches the ssh argv at all, and selecting a private one requires a recorded operator attestation naming the token's scope, expiry and rotation owner. *Negative control: an implementation that redacts the auth in logs and calls the argv conflict closed passes a grep-the-logs test — a process table is not a log — and MUST fail.*
- The licence obligation is discharged for a **binary** image: DF2.9's sweep runs over the built image's **exported filesystem**, so swept is shipped by construction, and the coverage set is **computed** by diffing the built image's binaries against the base rather than hand-listed. The 2026-09-05 amendment narrows the original "no npm tree" absolute to exactly two packages — the engine closure's `yaml` and `zod`, copied by name and guarded by an in-Dockerfile probe that fails the build if a third appears. *A table asserted to cover a list the table itself supplies is tautological and MUST fail.*

**Technical notes:** this is a different tier from `oci/Dockerfile`, D7's enterprise client-VPC image, and deliberately does not extend it; nothing here runs a phase — the story ships the substrate DF1.10 runs on, plus the `qds-run@.service` template and the baked `tmpfiles.d` channel entry DF1.11 converges with; the evidence JSON records built size and cold-boot time because those are the two falsifiers the ADR's own re-opening criteria name.

**Full enterprise detail** is in the individual story file linked above.

### Story DF2.11: Teardown Run-Lock Capability + Read-Only Cost Ledger

**Story File:** [df2-11-teardown-lock-readonly-ledger.md](../sprint-artifacts/dark-factory-v5/stories/df2-11-teardown-lock-readonly-ledger.md)

As the operator whose factory destroys boxes and audits its own spend,
I want the unsafe call to be the one the type checker rejects — teardown without the run lock, and a "read" of the cost ledger that writes to it —
so that a concurrent reap can never eat a run's only copy of its work, and the gate that verifies the ledger is not also the process that created it.

**Story Points:** 3 · **Sprint:** v5-S3 · **Depends on:** DF2.5, DF2.8 — **derived 2026-09-08** by the pre-dev adversarial review from two defects in **merged** code (DF3.8-B2, DF5.4-B3, DF5.3-H1); this story fixes production and adds no feature. DF2.12 edits the same four files and rebases onto this signature.

- **(make-or-break)** With `teardownSandbox(deps, runId, lock: RunLockHandle, opts?)`, a call omitting the handle or passing a plain `string` **fails `tsc --noEmit`** — an existing repo gate — pinned by **two** `// @ts-expect-error` directives, one on the two-argument call and one on a bare string literal in the lock position, so the brand is tested and not merely the arity; a `RunLockHandle` is producible only by `scripts/lib/run-lock.ts`. *Negative controls: a `lockHeld?: boolean` option (a caller can pass `true` holding nothing); and a plain `type RunLockHandle = string` alias, under which the arity check alone still goes green while a positional convention compiles.*
- A handle taken for a **different** run refuses before any mutation with `teardown-lock-mismatch`, `driver.destroy` recorded **zero** times and the record still open — the handle carries the run it was taken for, so this is a real check and not a type-level fiction.
- Two `teardownSandbox` invocations against one runId, in one process and across two, leave exactly one proceeding and the other holding `RunLockedError`: one `git bundle create`, one `driver.destroy`, and the surviving bundle passes `git bundle verify`. *Shipped `main` — the reaper's bare call racing `scripts/sandbox-teardown.ts` — records two of each and MUST fail.*
- A locked run in the reaper's sweep is a **named, counted skip** in `SweepReport.failures`, never an exception out of `sweep()`; a **stale** lock is reported with its own wording and its `rm` line rather than folded into the benign skip; the `--yes` sweep's destructive window clears only on the unit's success path, so an interrupted reap leaves the lock for an operator to judge.
- `CostLedger.openReadOnly({path})` against an absent ledger throws `ledger-absent` and creates **nothing** — no file, no directory, no `-wal`/`-shm` sibling; against an existing one every read leaves the directory's entry names, modes and mtimes identical, and every write method throws `ledger-readonly` before touching the database. *Today's constructor manufactures an empty ledger and reads `0 µ$` as within budget, and MUST fail.*

**Technical notes:** the handle is `acquireRunLock`'s existing return value under a branded type, so every current consumer compiles with zero edits and forging one costs a greppable `as RunLockHandle`; the callee never acquires, because `acquireRunLock` is documented not re-entrant and DF3.7 and DF3.8 both hold the lock in the caller for that reason; `withRunLock` is nine lines so five call sites do not each write them.

**Full enterprise detail** is in the individual story file linked above.

### Story DF2.13: Per-Run Key Cap Wired from the Admission Budget

**Story File:** [df2-13-per-run-key-cap-from-admission-budget.md](../sprint-artifacts/dark-factory-v5/stories/df2-13-per-run-key-cap-from-admission-budget.md)

As the operator who funds every token a box spends,
I want the ceiling on a run's key to be derived from the budget that admitted it and bounded by a backstop the code actually enforces,
so that no dispatch can mint a key for more money than the factory has a provider-side limit for, and the one number that survives to the provider is the one the ledger reserved against.

**Story Points:** 3 · **Sprint:** v5-S3 · **Depends on:** DF2.3, DF2.8 — **derived 2026-09-08** by the pre-dev adversarial review from operator ruling (c): *re-home the middle term, do not invent a control*. Six story files and one production docstring asserted `residentSpendCeilingMicros < runBudgetCapMicros ≤ defaultKeyCapMicroUsd`, but `runBudgetCapMicros` is declared only in `scripts/cap-hit-demo.ts`, annotated there as an **artifact field only**, and enforces nothing. The corrected chain is `residentSpendCeilingMicros ≤ capMicroUsd (mint-time) ≤ defaultKeyCapMicroUsd`. **DF3.6a is a hard successor** — without this term its chain proves nothing.

- **(make-or-break)** `mintRunKey` refuses a `capMicroUsd` greater than `defaultKeyCapMicroUsd` **at the shared function**, so every call site inherits the bound rather than each one remembering it. Today **nothing anywhere compares anything to `defaultKeyCapMicroUsd`** — the "provider-side backstop" is a docstring, and a caller passing any value mints at that value. *Negative controls: a check added at the dispatch call site instead of the mint, which leaves every other caller unbounded; and a non-strict comparison, which admits a cap exactly at the backstop as if the backstop were a target.*
- The **shipped** derivation is pinned against regression, not rebuilt: `min(remaining issue budget, per-run policy ceiling)` already flows admission → `admittedCeilingMicroUsd` → `mintRunKey`, and this story introduces **no second budget authority** — a second one could disagree with the admission that reserved the money.
- The lower bound (`residentSpendCeilingMicros ≤ capMicroUsd`) is deliberately **not** asserted at the mint: the resident ceiling is an in-box engine claim under R9, the mint is host-side and outside that trust boundary, and a host asserting against an in-box claim collapses both evidence layers.
- `src/providers/credentials.ts`'s backstop docstring stops promising an assertion nobody could write. *A docstring that describes a control the code does not perform is the defect this story closes, not a comment-style question.*

**Technical notes:** two of the three terms are enforced outside the trust boundary and the inner one bounds a component the outer caps cannot see, so the chain is not redundant. Cites by symbol throughout: line pointers into `credentials.ts` drifted twice inside one commit during authoring — once by +26 (never updated) and once by +6 (updated from an eyeballed hunk size) — which is why `scripts/check-story-consistency.ts` now gates citations for every not-yet-done story.

**Full enterprise detail** is in the individual story file linked above.

### Story DF2.12: Per-Role Token Cost Attribution Wired End to End

**Story File:** [df2-12-token-cost-attribution-wiring.md](../sprint-artifacts/dark-factory-v5/stories/df2-12-token-cost-attribution-wiring.md)

As the operator who ratified a resident agent on the explicit condition that it could be demoted on evidence,
I want every token a run spends recorded against the role and the agent that spent it, in the same host-side ledger the budget cap reads,
so that "the resident is costing too much" becomes a number I can query instead of a control that was written down, declared in the code, and never armed.

**Story Points:** 3 · **Sprint:** v5-S3 · **Depends on:** DF1.6, DF2.5, DF2.7, DF2.8 — **derived 2026-09-08** by the pre-dev adversarial review from a defect in **merged** code (DF5.3-B2, DF3.6-B3, DF3.6-H4): `ingestCostEvent` has zero non-test callers, so production runs record box hours as if they were the whole bill. **DF3.6a is a hard successor**; DF2.11 lands first and this story rebases onto its `teardownSandbox` signature.

- **(make-or-break)** After teardown's close step the ledger holds exactly one `kind='tokens'` row per emitted cost event — `role`, `agent_id`, `model`, input/output/cache tokens, `turn_count`, `key_hash`, `key_limit_micro_usd` and an **integer** `cost_micro_usd` — `readRunCost(runId).hasTokenRows` is `true`, and the priced SUM equals the sum of the rows exactly. **`role` is never inferred** from the model slug, the agent name or emission order. *Negative controls: a `role` derived from `model`; and today's shipped behaviour, whose only row is `box_hours`.*
- Re-ingesting the same events — a teardown re-run after a crash, a re-harvest — adds **zero** rows and mutates none, on the deterministic `event_id` digest and `ON CONFLICT DO NOTHING`; two genuine invocations of one agent remain **two** rows distinguished by `invocation_seq`. *A key of `(run_id, agent_id, kind)` collapses the second and MUST fail — unrecorded spend is an unenforceable cap.*
- A run with an armed DF3.3 resident carries at least one `role='resident'` row, and `perRole.resident / (totalMicroUsd − perRole["box-hours"])` is computable **per run from the ledger alone** — the quantity D4's tripwire (a) takes the p50 of, and the reason the month-one demotion evaluation becomes decidable. *A resident that solicited and spent, reported as a `0` share, is a false green on a governance control.*
- A run whose box died before harvest, or whose artifacts pull failed, is reported **`tokens-not-harvested`** — `hasTokenRows: false` beside a `box_hours` row, rendered in the same idiom as `box-hours-pending` — never as zero token spend. *Rendering a missing token set as `0 µ$` reports a run that certainly spent money as free and MUST fail.*
- An unusable figure — non-finite or negative `costUsd`, or `unpricedTurns > 0` — keeps DF2.8's taxonomy unchanged: the row persists with `unpriced = 1`, is excluded from the priced SUM and is counted in every view and gate decision. **Zero events are dropped**, no new unpriced class is added. *Filtering malformed rows out at the new host-side reader silently drops spend and MUST fail.*

**Technical notes:** the wiring is **two legs, not one call** — the `ponytail:` marker's "one `ingestCostEvent` call at the dispatcher" predates the 2026-08-31 tier-2 placement ADR, under which the dispatcher runs **in-box** while the ledger stays host-side (D8), so the in-box leg stamps an attribution row onto a surface harvest already pulls and the host leg ingests it at teardown's close step beside `ingestBoxHours`; `emitTokenBridgeState` keeps its place and inverts meaning, from reporting a known-permanent state to being a live tripwire for a broken bridge; the 15% ratio is never written into an AC (R5 §6 fact 12). Closes issue #157 bullet 1 only — its four other bullets stay open.

**Full enterprise detail** is in the individual story file linked above.

---

## Epic DF3 — Fleet dispatcher + tier-1 skills (§8 step 3)

**Mission:** replace the improvised shell line with tested tier-1 verbs — dispatch, fan-out N,
best-of-N, race, status, attach, harvest, teardown — plus a tier-2 resident agent that steers a run
without ever holding gate authority, and a named human standing between a green bundle and a public
PR.

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

> **DF3.6 was split on 2026-09-08** by the pre-dev adversarial review, at the **provability seam**:
> DF3.6a is engine policy over numbers the engine already holds — a manifest read, a projection, a
> comparison, a counter — and every assertion in it is falsifiable host-side with `bun test`; DF3.6b
> is kernel enforcement over a process the engine does not own, and its make-or-break **cannot be
> signed off anywhere but a real box**. The seam is not a line-count halving; it is a difference in
> what can prove each half done. Nothing crosses it except the manifest's `residentRssBytes`, which
> DF3.6a validates and carries and DF3.6b applies. The 3 → 3+3 re-point is deliberate: DF3.6 was
> under-pointed because it assumed a `ps` sampler where
> `docs/superpowers/specs/2026-08-31-tier2-placement-adr.md` Appendix B now requires kernel
> enforcement.

### Story DF3.6a: Resident Spend Ceiling + Per-Phase Iteration Bound, Enforced by the Engine

**Story File:** [df3-6a-resident-spend-iteration-bounds.md](../sprint-artifacts/dark-factory-v5/stories/df3-6a-resident-spend-iteration-bounds.md)

As the factory host paying for every sandbox,
I want the phase engine to cap the resident agent's steering iterations and absolute spend below the run key's own cap,
so that a resident agent that loops or burns money is stopped by the component it cannot influence, while the run still finishes deterministically.

**Story Points:** 3 · **Sprint:** v5-S3 (fleet band) · **Depends on:** DF1.1, DF1.5, DF1.10, DF1.11, DF2.3, DF2.8, DF2.12, DF3.3 — DF2.12 is a hard edge: without its `kind='tokens'` rows the run-total denominator D4's tripwire (a) needs does not exist.

- **(make-or-break)** At `ceiling − ε` where ε is below the projected worst-case next call, the engine does **not** issue the call: the resident stops with `bound:"spend"`, the run continues deterministic, and recorded spend never exceeds the ceiling at any journal point. *Metering only after the call — the obvious implementation — overshoots by one call and MUST fail.*
- The ordering assertion is **two checks over two different quantities, never one over the minted cap**: (a) at config time over the static defaults **stamped onto DF1.1's frozen manifest by dispatch**, bounds violating `residentSpendCeilingMicros < defaultCapMicroUsd ≤ defaultKeyCapMicroUsd`, a ceiling expressed as a percentage/ratio/share, or any of the three operands missing **refuse the run** at manifest load **inside the box** before the resident spawns — writing the terminal marker `{ok:false, code:"bound-config-invalid", message, remediation}` that `fleet status` surfaces as `not-ok`, because an error code is payload and never a process exit code, and because an in-box engine cannot tear its own box down; (b) per run, this run's minted `limitMicroUsd` only **clamps** — the effective ceiling is `min(residentSpendCeilingMicros, limitMicroUsd)`, logged as `{bound:"spend", action:"clamped"}`, and the run proceeds, because a remainder-capped mint is a normal state, never a misconfiguration. The type is absolute integer µ$ and the `.strict()` manifest schema has no ratio field to populate. *Applying check (a) to the minted cap refuses every run near its issue cap that DF2.8 already admitted, and MUST fail.*
- **The iteration bound counts solicitations issued, not directives accepted**, and it is **per phase**: exhausting `maxSteeringIterations` stops solicitation for that phase only, and subsequent phases solicit normally. The counter is **not** DF3.3's `telemetry.steeringIterations`, which increments only on an accepted `retry` and stays at zero for a resident that replies `proceed` on every call — the proceed-loop this bound exists to stop.
- A reply carrying no usage field is charged the **projected worst case**, never zero. *The shipped `meter` does the opposite, and an implementation inheriting it MUST fail.*
- The manifest's `residentRssBytes` is **validated and carried here, applied by DF3.6b**: a missing or non-positive-integer value refuses the run on the same fail-closed path. This half enforces nothing about memory.

**Technical notes:** the ordering invariant between the three ceilings is the whole point of the number; an absolute ceiling replaces the 15% ratio per the gates report §3.3 (BINDING); metering is pre-flight projection, engine-side, never post-hoc; the e2e prices its resident slug from a **fixture catalog** because both projection ceilings are compiled constants, so the projection is a function of the rate alone and the default catalog's rates cannot reach the fixture's own asserted refusal.

**Full enterprise detail** is in the individual story file linked above.

### Story DF3.6b: Resident Memory Bound — Kernel-Enforced via cgroup v2 `memory.max`

**Story File:** [df3-6b-resident-memory-bound-cgroup.md](../sprint-artifacts/dark-factory-v5/stories/df3-6b-resident-memory-bound-cgroup.md)

As the factory host paying for every sandbox,
I want the resident agent's memory bounded by the kernel rather than watched by a poller,
so that a resident that leaks is killed the moment it crosses the line — not reported after it has already OOM'd the box — while the run still finishes deterministically.

**Story Points:** 3 · **Sprint:** v5-S3 (fleet band) · **Depends on:** DF3.6a, DF1.10, DF1.11, DF2.10, DF3.3 — sequenced after DF3.6a, which widens the `cause` union this story writes into, and after a DF2.10 image re-pin, because this story changes the `qds-run@.service` unit baked into the image.

- **(make-or-break)** A solicitation whose process tree allocates past `residentRssBytes` is **OOM-killed by the kernel** on that solicitation's own cgroup v2 leaf — the engine issues no signal, runs no timer and takes no sample: `resident.exitStatus` reads `"overflow"`, a `watchdog_kill` tripwire carries the measured `memory.peak` and the bound it crossed, the run continues deterministic, and a post-run check finds the leaf removed and no orphaned child. `memory.oom.group` is set to `1`, so the kill takes the cgroup rather than one task. *An implementation that polls RSS on a timer and then signals the tree reports a breach it has already paid for — a process can balloon and OOM the box inside one sample interval — and MUST fail.*
- **The bound is rooted at the resident by construction, not by convention**: the leaf contains only pi and its descendants — never the engine, and never the tier-3 `dispatch_task` workers the engine also parents in-box. *Setting `MemoryMax=` on the `qds-run@<runId>.service` unit bounds the engine's whole cgroup, charges a bun team-lead's memory to a resident bound, passes a naive synthetic-allocator test and MUST fail a test in which a dispatch phase runs beside a small resident.*
- **Unenforceable means not started**: absent `Delegate=memory`, an unavailable `memory` controller, or a box not on cgroup v2 leaves the resident **unspawned** with `resident.status: "disabled"` — DF3.3's closed set, unwidened — and the shipped `resident_disabled` warn line carrying `reason: "rss_unenforceable"`; no tripwire row is emitted and the run proceeds deterministic rather than running an agent whose memory nobody can bound.
- A failed **per-solicitation** placement never yields an unbounded call: a `cgroup.procs` write that fails at solicitation time exits **97 without `exec`ing pi**, records `bound:"rss", allowed:false, cause:"unenforceable"`, and stops the resident. *A wrapper joining the two commands with `;` execs pi with no `memory.max`, and its journal is indistinguishable from a bounded call — MUST fail.*
- An OOM-kill **stops** the resident and the status says so: the engine fires `onBoundBreach` and the runner, which holds the `ResidentSpawn` handle, calls `stop()`, so `telemetry.status` reads `"stopped"` beside `exitStatus: "overflow"` and no further solicitation is issued. *Relying on the `"degraded"` status gate instead leaves `stopped === false` and pairs `status:"degraded"` with `exitStatus:"overflow"` — a combination no story owns.*

**Technical notes:** ADR Appendix B (ACCEPTED 2026-09-08) is the load-bearing citation — F12 means **enforce**, not observe, and *a bound on component X is rooted at X's pid, never at an ancestor's*; R5 §6 fact 5's RSS-watchdog mechanism is superseded there while its intent (the resident is a genuinely local subprocess tree in-box) is what makes a cgroup possible at all; risk R3's group-kill doctrine is discharged by the kernel here rather than by this story. The make-or-break runs live as a `qds-live-e2e` **TIER-4** round against a real box (≈ $0.10) because the enforcer is the kernel and darwin has no cgroups; DF3.6a's 512 MiB default is provisional pending a measured pi baseline, and is the one value crossing the split seam.

**Full enterprise detail** is in the individual story file linked above.

### Story DF3.7: Approval-Gate Bridge — Run-Completion Signal for In-Box Runs

**Story File:** [df3-7-approval-gate-bridge.md](../sprint-artifacts/dark-factory-v5/stories/df3-7-approval-gate-bridge.md)

As the factory operator who dispatched an unattended run,
I want the host to notice by itself that the in-box run has finished and to walk the harvest, teardown, re-verify and approval chain that already exists,
so that an autonomous run ends at a pause I can approve rather than at a live box nobody is watching.

**Story Points:** 4 · **Sprint:** v5-S3 (in-box restoration arc, story 4 of 5 — the last seam the relocation opens, and the smallest) · **Depends on:** DF1.10, DF3.4, DF5.1 *(the story file additionally names DF2.2 for `readBoxFile`, DF2.10 for the unit and its per-run `RuntimeDirectory`, DF2.11 for the required `RunLockHandle` — this is its eighth `teardownSandbox` call site — and DF3.1 for the verb registry; `sprint-status.yaml` carries the shorter set. Not an edge: DF1.11, which owns the steering files this story never touches.)*

- **(make-or-break — the host learns the run finished; the gate learns nothing new)** The chain that reaches `awaiting-approval` is the **existing** harvest → teardown → `reverify()` → the gate's own `requestApproval`, with **zero changed lines** in `approval-gate.ts`, `approvers.ts`, `push.ts` and the run record's approval-extension block — enforced at test time by a static import fence over the new module's **direct** specifiers, the barrel included, because it reaches the gate transitively. *Negative controls, both MUST fail: an implementation that reads Consequence 4's pre-Appendix-A "awaiting marker" phrasing as an approval state and writes `extensions.approval` from the bridge, bypassing the gate's own guards; and a fence written to match **transitively**, which fails on the correct implementation and will be weakened until it catches nothing — the worse failure, because the security box is then checked by a test that asserts nothing.*
- **The observation contract is the shipped classifier, consumed as code rather than restated** — the same function `fleet status` and the fan-out race already use, with four verdicts (`absent | skip | unusable | settled`) and two streaks. A probe exit of 255 is `skip`, not a clean absence, and resets nothing; an `unreadable` `cat` is `unusable` and never a free tick, because the box answered twice on that tick; `expectedRunId` is passed on every read, so a marker naming another run is `unusable`, never `settled`. `ok:false` still harvests and tears down, but `ok` is **never fed to reverify** — DF5.1 re-judges the tree independently, which is the two-layer doctrine this placement restores.
- **An absent marker is disambiguated by the unit's own liveness, never by absence alone.** Only `failed` is terminal: the unit is `Type=simple` with `Restart=no`, so no marker will ever follow, and the observer stops with a typed `run-engine-dead`. **`inactive` and `unknown` are explicitly not terminal** — a box dispatched but not yet started reads exactly those — and are counted on the skip streak instead. *Issuing a death certificate for them refuses every run in the ordinary dispatch→run window.*
- An unobserved run — host disconnect, window expiry — exits with a typed `run-completion-unobserved` payload, leaves the box **alive and listable** with its evidence, mutates **no** record field, and is idempotently re-observable, because the marker is the state. The story states plainly that no existing timer covers that run and that an operator's later reap yields not a spared box but a **witness-less collection** — harvested and closed, never reaching a pause. Ending that is why DF3.8 exists.
- The marker path is derived **once, host-side**, from the box-side mirror and never from the host's own run-root, which is correct only for code running in the box — an ambient redirect there is a shipped, measured defect that once reported a whole fleet as `running` regardless of what the runs had done. A record already `awaiting-approval` or terminal refuses; **`pausing` is explicitly not a refusal** — it is post-teardown by construction, so its box and tmpfs marker are already gone and the observer skips the poll and teardown legs entirely to promote it through the same `reverify()` leg DF3.8 re-enters. *Refusing `pausing` strands the run forever; polling a destroyed box for it strands it too.*

**Technical notes:** ADR **Appendix A** (ACCEPTED 2026-09-08) is why the marker is a run-**completion** signal and not an approval state, and why neither this story nor DF3.8 carries a story-local deviation on the point — two stories standing in deviation against the very ADR that unwinds a deviation is self-defeating, so the record moved where an operator gate applies. The marker carries `{runId, ok, completedAt?}` and deliberately no verdict and no evidence, which keeps it out of the trust path; the observation window is this story's only new number and is operator-settable, because an unattended run routinely outlives fan-out's race-shaped ceiling; the module acquires **no lock** — every caller holds it, since `acquireRunLock` is not re-entrant. The end-to-end proof is a real box whose marker DF1.10's real in-box engine wrote, never planted by a test.

**Full enterprise detail** is in the individual story file linked above.

### Story DF3.8: Host-Side Completion Watcher — Unattended Runs Reach the Gate

**Story File:** [df3-8-host-completion-watcher.md](../sprint-artifacts/dark-factory-v5/stories/df3-8-host-completion-watcher.md)

As the factory operator who dispatched an unattended run and then closed the laptop,
I want the *next* host invocation — whenever that is — to pick the finished run up after the fact and walk it to the same approvable pause it would have reached had I stayed connected,
so that reaching the pause depends on the host coming **back**, not on the host staying **up** for the whole run.

**Story Points:** 4 · **Sprint:** v5-S3 (in-box restoration arc, story 5 of 5 — the one that makes the arc's product claim true rather than merely reachable) · **Depends on:** DF1.10, DF2.6, DF3.1, DF3.7 *(the story file additionally names DF2.2 for `readBoxFile`, which it uses for both the marker and `/proc/uptime`; `sprint-status.yaml` carries the shorter set. DF1.10 is direct, not inherited through DF3.7: its `fleet run` is the only shape in the arc where the dispatching process can exit before the marker exists. Not an edge: DF3.2's fleet lock, a single-**operator** mutex where this sweep needs per-**run** granularity.)*

- **(make-or-break)** A settled marker on a box whose dispatch invocation is long gone reaches `awaiting-approval` by **calling** DF3.7's chain composition: this story re-implements no step of harvest → teardown → `reverify()` and adds no second automatic **entry point** — it is a second *caller* of the one entry point, which is a different and openly paid-for thing. DF3.7's import fence extends verbatim to the new module. *Negative control: an implementation that inlines its own sequence reaches the same state, passes a naive "did it reach awaiting-approval?" test, forks the one chain the arc has, and MUST fail.*
- The sweep is serialized per run, takes the per-run invocation lock **itself and never inside DF3.7's module** — pushing the acquisition down would refuse whichever sibling caller already holds it — re-reads the approval extension **inside** that lock, and passes one marker read per candidate, because a sweep is not a wait. A **stale** lock is a named, remediated outcome and never folded into the benign skip count. **What the mutex does not exclude is stated rather than claimed**: `sandbox-reap --yes` calls `teardownSandbox` bare and takes no run lock, so **DF2.11 owns that fix** structurally, and this story keeps the reaper byte-identical rather than adding one more per-caller acquisition — per-caller discipline is exactly how the next call site forgets.
- Against DF2.6's `stale-record` → teardown arm, which collects an open record past `staleAfterMs` with harvest, destroy, revoke and `closedAt` but **no `reverify()` and so no gate**, this story changes **not one reaper input**: no threshold edit, no suppression file, no reprieve, and the reaper is byte-identical after. **The guarantee is the refusal, not the interval.** A record that was a candidate at enumeration and reads `closedAt` set at the in-lock re-read was collected between the two, and is re-entered at the `reverify()` leg **only if this invocation had already witnessed the marker itself** — otherwise it is refused `completion-unwitnessed`. *Routing any closed record carrying a bundle into the gate promotes a run killed mid-flight on evidence no marker ever witnessed, and MUST fail.*
- **(the revisit trigger this story takes ownership of)** Each live candidate's `/proc/uptime` is read through the same `readBoxFile`, and a reboot is a **duration** comparison against a named margin, not a timestamp one: the record is stamped **before** the VM boots, so "derived boot time is later than `createdAt`" would count every box as rebooted, and `hostNow` is sampled per candidate rather than per pass because a serial pass spans minutes. A confirmed reboot with an absent marker is terminal for that candidate — `/run` is tmpfs, the unit is `Restart=no` and carries no `[Install]` section, so no engine will restart — and refuses `run-lost-to-reboot` once per pass with the box left alive. It does **not** retire the candidate, because a liveness reading cannot separate "started, then rebooted" from "never started"; **`run-engine-dead` is the arm that retires**, because `failed` is unambiguous.
- It is a **verb and not a process**: one bounded pass, a typed exit, no PID file, no plist, no user unit, no `--daemon` flag, nothing resident. A per-run refusal is counted and reported on its own line, never as the sweep's exit code, and a sweep that drove **zero** runs exits `0` — a cron line that mails the operator on every quiet tick is a line the operator disables. The documented cron line names its working directory and the verb resolves and asserts the host root **before any candidate is driven**. *A verb that discovers an unusable host root inside `reverify()` has already harvested, destroyed the box and set `closedAt` — every scheduled run then ends closed with no pause and no path back, while the sweep reads as healthy.*

**Technical notes:** the **schedule is out of scope by construction** and stays the operator's — a scheduled *invocation* is not a watcher process, which is the only shape that keeps DF3.7's no-daemon limb literally true; the honest claim is bounded twice and the story says so before an AC can imply otherwise (a finished run reaches the pause on the first host invocation after it settles, and only while its box is alive and its tmpfs marker still there), and nothing here bounds the bill. Detachment is produced by DF1.10's `fleet run`, never by backgrounding a host process, which would leave a host process to fail and prove nothing.

**Full enterprise detail** is in the individual story file linked above.

---

## Epic DF4 — Visualizer adoption (§8 step 4)

**Mission:** put the SSSF visualizer over our own trace store behind a token gate on a
loopback-bound port, and bound the liability of ~4,656 lines of vendored TypeScript and Vue with a
real test suite, a machine-checked Bun-API inventory, and a per-box deploy path.

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
lights are on.

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

**Story Points:** 6 · **Sprint:** v5-S3 · **Depends on:** DF1.4, DF1.8, DF1.10, DF2.1, DF2.3, DF2.5, DF2.6, DF2.8, DF3.4, DF5.1, DF5.2 (R5 §2) — the full set, because this story edits four DF2.x-owned files and resolves records those stories write. **DF1.10 is a direct edge** since it merged: the trace DB hops 2 and 9 resolve against is now written inside the box and reaches the host only through DF2.5's artifacts pull. **DF2.6 is a direct edge**: hop 5's box-lifecycle emitter lives in the reaper. P1.11/P1.12's retain-receipt edge is **degraded to VOID**, not satisfied (DD-4). *(Re-estimated 4 → 6 on 2026-09-08: "no exported signature changes" was false — four `*Deps` seams move.)*

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

**Story Points:** 5 · **Sprint:** v5-S3 · **Depends on:** DF1.10, DF2.5, DF2.11, DF3.1, DF3.4, DF3.7, DF3.8, DF5.1, DF5.2, DF5.3, P0.11 — DF3.7 and DF3.8 because the lights-on **run of record has no producer until they exist**, and DF2.11 because C10 needs `CostLedger.openReadOnly()` to read the ledger without creating it (which is what makes INV-GATE-1 true rather than weakened to match the code). *(P0.11 is a **chassis-reuse** edge, not a verdict edge: `PHASE_0_GATE` is FAIL on upstream Phase-0 evidence and that verdict does not gate this story. The clause map also asserts against artifacts owned by DF1.2, DF1.4, DF1.6, DF2.1, DF2.2 and DF2.8 — reached **transitively** and not repeated as edges; the clause map's Owner column, not this line, is the authority on which story owns which evidence. Re-estimated 3 → 5 on 2026-09-08.)*

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

**Story Points:** 3 · **Sprint:** v5-S3 (applied last, after all repoint-target stories are merged and the DF slate IDs are frozen) · **Depends on:** DF1.3, DF1.5, DF1.6, DF1.8, DF2.8, DF3.1, DF5.2, DF5.3, DF6.1a — the canonical successor set is the IDs this chore actually writes into a file (amendments A, C, D and F; E is retired as already-satisfied and writes nothing), plus DF1.10 and DF2.10 as *cited context*. **DF6.1a is a scheduling edge rather than a successor-set member**: its wave annotates `p1-18:50`, which AC1's grep then has to pass over. A frozen ID that appears in no amendment is not an edge. *(Re-estimated 2 → 3 on 2026-09-08: ~50% more edit volume from the ADR arc, plus amendment F.)*

- **(make-or-break)** After amendments A–F, **three** greps pass: the retired-ID grep across **all 11 KEEP files plus P0.7** (amendment D) — 12 files, phase-0 included — returns zero un-repointed `P1.x` references; the marker grep returns exactly the **11 amended** paths (`p0-5` has zero hits and is never amended); and a retired-ID grep over `sprint-status.yaml`'s KEEP-story `deps:` lists — the artifact machines actually read — returns zero, while `superseded` rows keep their retired-ID deps as historical record. The plain grep only proves an annotation exists, so it is backed by a table-driven per-pair assertion that the *right* successor appears on the same line. *A find-and-replace that rewrites historical provenance references ("shipped PR #40/#87") into DF IDs passes the grep, destroys the record, and MUST fail review.*
- P1.9 and P1.5 each name the DF story owning the adjacent scope (DF1.3 owns in-phase retry; DF1.5 owns the roster schema and dual slug validation) with **no character changed** in either file's Acceptance Criteria.
- `p0-7-swarmclaw-agent-mcp-hindsight.md` carries the one-line DD-7 role statement with no P0.7 asset, AC or DoD item modified — P0.7 stays frozen DONE-KEEP.
- **(failure path)** A repoint whose successor ID is absent from the DF stories directory stops the chore and records the missing ID in the amendment log rather than writing a dangling pointer.
- **(boundary)** RETIRE-disposition files (P0.1, P0.4, P0.8 and the audit §2 RETIRE rows) are not opened for edit — retired stories are historical record.

**Technical notes:** the successor map is binding (sourced from R5 §2 + audit §2, reproduced in this index's ancestry table); amendment B's only real hit is a RETIRE-disposition file, which is not opened; amendments C, D and F are additive and AC-untouched, F carrying the ADR-derived engine-seam path and placement note into P1.11 and P1.12. The slate count is read from `sprint-status.yaml`'s meta block rather than hardcoded.

**Full enterprise detail** is in the individual story file linked above.

---

## Epic DF6 — Feedback loop (unslotted §8 hole #2, scheduled after step 5)

**Mission:** close the loop the §8 build order never slotted — a bot review comment on a
factory-produced PR triggers a bounded fix run that ends in a green PR or an escalation to a
human, never an unattended loop and never a force-push over a reviewer's history — plus the one
unslotted engine fix the epic absorbed, without which a refused dispatch journals green and the
loop's own failure classification is unreadable.

> **DF6.1 was split on 2026-09-08** by the pre-dev adversarial review, at the **`attemptSha` seam** —
> the durable contract DF6.1 had already named for itself: *the fix run's `fixContext` record is
> written once, after `pushVerifiedSha` returns.* Everything up to and including that write is
> factory mechanics whose risk is credential and scope containment (**DF6.1a**); everything after it
> is loop control whose risk is termination and the correctness of a third-party verdict
> (**DF6.1b**). Nothing crosses the seam but a JSON payload on disk. The split also separates the
> live spend: the box, the key and the model spend all live in DF6.1a, so DF6.1b's termination
> matrix can be exercised exhaustively for nothing. The 6 → 4+3 re-point is deliberate: DF6.1 was
> under-pointed because it silently assumed a completion chain **DF3.7** has to build first.

### Story DF6.1a: PR Feedback → Bounded Fix Attempt → Verified Append

**Story File:** [df6-1a-pr-feedback-bounded-fix-attempt.md](../sprint-artifacts/dark-factory-v5/stories/df6-1a-pr-feedback-bounded-fix-attempt.md)

As the factory operator,
I want a bot review comment on a factory-produced PR to produce **one** verified, approved, appended commit on that PR's branch — or a refusal that costs nothing,
so that the factory can act on review feedback without ever force-pushing over a reviewer's history or putting a push credential in a box.

**Story Points:** 4 · **Sprint:** v5-S3 (after DF5.2 — the loop needs a PR of its own to fix — and after DF3.7) · **Depends on:** DF1.5, DF1.6, DF3.1, DF3.4, DF3.7, DF5.1, DF5.2 *(DF1.5 owns the roster schema whose per-role `writes` list the single-fixer guard reads. **DF3.7 is a hard edge, not an inherited one**: post-DF1.10 `fleet run` returns without holding the run and nothing host-side learns a run finished except through DF3.7's `observeAndDriveChain`, which this story calls and re-implements no step of.)* *(**DF5.3 is not an edge of this half** — the audit-chain extension is DF6.1b's. P1.18 is not a predecessor either: this half denies its receiver as an **intake** channel, and `scripts/fix-run.ts --pr <n>` reads the PR's comments directly through the GitHub API, taking only the `botComments[]` shape.)*

- **(make-or-break)** A run in `review_feedback_detected` with ≥1 bot comment dispatches through DF3.1 as a normal factory run pinned to the PR branch head; the single-fixer team reads the comment and implements a fix **in-box through DF1.10's engine**, and the `dispatch_task` envelope validates against the step-output schema with `changedFiles` non-empty. *Negative controls, both MUST fail: an implementation shelling `warren run --team`, a flag that exists in no examined Warren version; and one driving the pi worker argv from the host into the box, the placement the tier-2 ADR classifies as a silent, unratified deviation.*
- With the fix-run bundle harvested and DF5.1's re-verify green, **this attempt** carries its own `ApprovalRecord` bound to that attempt's `reportId` and head sha — an approval from a previous attempt never authorizes this one — and `pushVerifiedSha` **appends** one fast-forward commit to the PR branch: no force-push, no rewrite, no second PR, never the default branch, and no push credential present in the box at any point.
- **(the invocation boundary)** Reaching `awaiting-approval` **exits 0** holding no lock and leaving no child, so a concurrent `fleet harvest` or `fleet teardown` against that run is not refused exit `5`; a later invocation finding an approved record bound to this attempt re-takes the lock, runs the scope check, pushes, and writes `fixContext`. *An implementation that polls for the approval inside the first invocation holds the run lock across a human decision and MUST fail — one attempt is two bounded invocations, never one resident process.*
- **(the seam)** `extensions.fixLoop.fixContext` is written **once**, after `pushVerifiedSha` returns, carrying `attemptSha`, the comment **IDs** and a content digest of those comments — and no comment prose. An attempt that reached no published sha leaves **no `fixContext` for that attempt on disk at all**: there is no pending or partial record with a not-yet-known `attemptSha`. The write is pre-flighted in validate-only mode **before** the push, so a payload that would be refused is refused while nothing has been published.
- **(boundary/guard)** A fix roster declaring ≥2 write-capable workers exits non-zero provisioning nothing — capability read from DF1.5's **three-state** `writes` list, where `null` means *unrestricted*, the widest scope in the schema, and never *absent*; zero bot comments, or comments only on a closed/merged PR, dispatches nothing and exits `0`. Scope enforcement is **host-side**: a harvested diff touching anything outside the host-owned allowed-path list blocks the push and records `flags: ["out-of-scope-diff"]`, because a rule a skip-permissions box enforces on itself is a claim.

**Technical notes:** the MANDATORY scope caveat from R5 §6 fact 2 / gates report §1(b) is carried verbatim; the host-side push half is split out of P1.19's source clause per R2 §10 (INV-3/D8); the caller holds `<runsDir>/<runId>.lock` for the duration of the chain call, because `acquireRunLock` is not re-entrant and DF3.7's INV-IBOX-16 already names this story as one of three sanctioned automatic callers.

**Full enterprise detail** is in the individual story file linked above.

### Story DF6.1b: Fix-Loop CI Verdict, Attempt Budget and Human Escalation

**Story File:** [df6-1b-fix-loop-verdict-attempt-budget.md](../sprint-artifacts/dark-factory-v5/stories/df6-1b-fix-loop-verdict-attempt-budget.md)

As the factory operator,
I want the fix loop to read its own CI verdict, stop at two attempts, and hand me everything I need when it stops,
so that the factory maintains its own pull requests without ever looping unattended, misreading another commit's green as its own, or stopping silently.

**Story Points:** 3 · **Sprint:** v5-S3 (after DF6.1a and DF5.3) · **Depends on:** DF6.1a, DF5.3 *(DF6.1a transitively carries DF1.5, DF1.6, DF3.1, DF3.4, DF3.7, DF5.1 and DF5.2. **DF5.3 is declared but unbuilt** — `src/audit/` does not exist as of 2026-09-08 — so the `src/audit/chain.ts` edit is unbuildable until it merges and this story is sequenced strictly after it. This half denies P1.18's receiver as a **verdict** channel, where the alternative is the poll.)*

- **(make-or-break — the verdict is SHA-bound)** The **required** checks (non-required ignored) are polled every 30 seconds with **two** host-authenticated `gh` calls per poll, because neither surface carries both facts: `gh pr view <n> --json headRefOid` supplies the head sha (`gh pr checks` exposes no per-check sha), and `gh pr checks <n> --required --json name,state,bucket` supplies the required set with its settled bucket (`statusCheckRollup` carries neither a requiredness marker nor a `bucket` — measured 2026-09-08 against PR #237). The `headRefOid` read is taken **before and after** the checks read and both must equal the recorded `attemptSha`; any inequality means a newer commit landed mid-poll and the whole poll is discarded before any state transition. On all-green the run advances to summarize and a terminal success state.
- The ceiling is a **15-minute CI-poll window measured from `pushVerifiedSha`'s return** — not a wall clock over the whole attempt — and reaching it without a settled required set is a `ci-verdict-unavailable` escalation, never a green. The empty-required-set refusal is evaluated at **attempt start, before the push**; inside the window an empty or partial set is `pending` and resets nothing. **Branch on the output, never the exit code**: `gh pr checks` exit `8` is a normal pending tick. A red suite is a FAIL and a flaky suite is rerun **once**, then FAIL. There is no webhook receiver in v5.0.
- **The attempt budget is charged only by attempts that reached CI.** A DF6.2 deterministic refusal — `dispatch_task` settled `fail` with `exitStatus: "logic"` — escalates immediately with the refused precondition named and does **not** increment `attempt`, because a second identical dispatch cannot fix it; a `transient` or `lead_failure` classification likewise escalates named rather than retrying, since DF1.3 already spent its own separately-bounded in-run retries and this story adds no third retry vocabulary.
- **Uncharged attempts are bounded too, by a separate and smaller ceiling**: at most **3** per PR across all classifications, with `out-of-scope-diff` capped at **1** because it is the injection outcome. A state that charges nothing still costs a box, a capped key and model spend. *An implementation bounding only charged attempts lets an adversarial review comment be re-attempted indefinitely, one box per invocation, every attempt terminating "correctly" in a named state — and MUST fail.*
- **(failure path + audit)** After two **charged** failures a third invocation dispatches nothing, provisions no box, exits non-zero and **escalates to a human** — a PR comment carrying the error log, the diff attempted, the CI failure messages and every contributing runId. Each attempt emits its **own** `recordAuditLink` rows under its own runId, `fixOutcome.runIds` is written on the **parent** run's record, and `walkAuditChain` on the PR resolves the hop set per contributing runId — a contributing runId whose chain is missing or incomplete is a **broken hop**, never an ignored one.

**Technical notes:** the split's live-spend consequence is the point — this half needs no box, no key and no model spend, which is what makes the termination matrix cheap to exercise exhaustively; P1.19's `:53` webhook-signature clause is **not carried**, its intent surviving as the polled, SHA-bound verdict, since with no ingress there is no signature to validate; requiredness is read from `gh pr checks --required` and never from branch protection, which would need a repo-admin scope this loop deliberately does not take; attempt bookkeeping and the fresh-authored parts are NET-NEW per DD-8.

**Full enterprise detail** is in the individual story file linked above.

### Story DF6.2: `dispatch_task` Verdict Integrity — Refusals and Non-Success Classifications Settle the Phase FAIL

**Story File:** [df6-2-dispatch-refusal-verdict-integrity.md](../sprint-artifacts/dark-factory-v5/stories/df6-2-dispatch-refusal-verdict-integrity.md)

As the factory operator reading a run journal,
I want a refused or failed dispatch to settle its phase `fail` with the real reason,
so that a green journal row never covers a dispatch that refused to spawn or classified non-success.

**Story Points:** 2 · **Sprint:** v5-S3 (unslotted fix — surfaced by a cross-story review as a source bug found but not fixed, not derived from the §8 build order) · **Depends on:** DF1.1, DF1.6

- **(make-or-break)** `Run.phase` honours a clean body value's **declared** verdict: a returned value whose `exitStatus` is a valid member of the taxonomy and is not `"success"` settles the phase `fail` with that status, the record's error carries the value's own message, and the run halts — the same settle path a thrown body takes. *Negative control: the shipped behaviour, deriving the phase verdict purely from throw/abort/overflow and promoting every clean, non-aborted return to `success`, journals every refusal green and the run settles `ok:true`, exit 0.*
- The ten `dispatchTask` refusal paths — the runner-mode refusal, missing provider keys, the roster/task refusal, an empty run-root, an unreadable or under-provisioned roster, dual-gate rejection, manifest-schema and manifest-dir failures — are **unchanged**. Each was classified individually and every one is a legitimate value-return under DF1.6's design, in which the adapter's parse error never escapes the body: the defect was in the engine's settle, not the body's return.
- An **executed** dispatch whose precedence classification came back non-success was likewise promoted to `success` even though DF1.6's machinery had already computed the right verdict into the value; it now settles `fail` with that classification.
- Garbage or forged `exitStatus` strings are membership-validated away and cannot steer the verdict, and phase values that declare no `exitStatus` at all — the plain command result, DF1.3's agent phase result — are untouched.
- Stream-health counters and dispatch sub-timings now merge onto the record **regardless of verdict**, where they were previously success-gated, so a failed dispatch keeps its truthful observability fields.

**Technical notes:** this closes a hole in DF1.1's "success is earned" guarantee that neither story could see on its own — a *clean return carrying a non-success verdict* was the one shape the lifecycle never inspected. **Behaviour change, flagged rather than absorbed:** runs whose dispatch phase refused or classified non-success previously settled `ok:true`/exit 0 and now settle `ok:false`/exit 1 with the phase row `fail`; that is the intended correction, and any characterization pin asserting the old behaviour flips with it.

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
| P1.19 Pi Pair fix → PR green | RE-DERIVE | **DF6.1a** — `warren run --team` exists in no version; intent survives as the bounded fix loop. DF6.1a is named because `p1-18:50`'s `(P1.19)` is INV-2, about the bot-comment payload *shape* and the downstream fix dispatch that consumes it, and DF6.1a is the half that reads `botComments[]`. **The RE-DERIVE scope splits across both halves** (DF6.1 split 2026-09-08): DF6.1a carries `p1-19:29` (fix core), `:39`'s same-branch limb and `:52`'s branch scoping; **DF6.1b** carries `:30`/`:31` (CI green → terminal), `:32` (bounded attempts + diagnostics), `:39`'s required-check limb and `:54` (retry budget), and dispositions `:53`'s webhook-signature clause as **not carried** — its intent surviving as the polled, SHA-bound verdict. A single-successor row is a pointer, not a claim that DF6.1b is unrelated |
| P0.1 Archon env-patch productionize | **RETIRE** | No successor — v5 has no DAG (D2); per-agent env-override intent covered by DF1.5's roster config |
| P0.4 Hard-guard loopy-prompt kill | **RETIRE** | No successor story — caps landed in the cli-anything launcher; the live kill demo re-attaches to **DF2.4** + §5.2 watchdogs |
| P0.8 Telegram verify / OQ-3 | **RETIRE** | Deferred by Warren decision; the channel layer itself has no §8 step (hole #1) |
| P0.2, P0.3⚠, P0.6, P0.7⚠, P0.10, P0.11 | DONE-KEEP | Built and evidenced; consumed as assets (P0.2/P0.3 by DF1.6 and DF1.9, P0.11's chassis by DF5.4). ⚠ = flagged defect recorded in audit §5 |
| P0.5, P0.9, P1.2, P1.3, P1.5, P1.7, P1.9, P1.11, P1.12, P1.14, P1.18 | KEEP (11) | Valid as written. **Repointed by DF5.5**: dependency edges swapped to the successors above, plus additive ownership-boundary lines (DF1.3 ↔ P1.9 retry, DF1.5 ↔ P1.5 roster) and the DD-7 SwarmClaw role line on P0.7. ACs untouched. **P1.18 is KEEP but unscheduled** in the v5 window: DF6.1a denies its receiver as an intake channel and DF6.1b denies it as a verdict channel, so nothing in the slate builds or depends on it |

> Historical provenance references ("shipped in PR #40/#87") are **annotated, never rewritten** —
> only forward-looking references are repointed (DF5.5 AC1 negative control).
