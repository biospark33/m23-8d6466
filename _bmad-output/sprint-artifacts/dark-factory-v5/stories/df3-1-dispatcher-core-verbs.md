# DF3.1: Fleet Dispatcher Core Verbs (dispatch, status, harvest, teardown)

**Story Points:** 5
**Sprint:** v5-S2 (fleet band; R5 §3 sequences it **first of the fleet stories** — it unblocks four — but DF1.8 lands ahead of it inside the sprint, since DF3.1 calls DF1.8's `resolveRunCorrelation`)

## Spec Reference

- `docs/superpowers/specs/2026-08-11-dark-factory-v5-architecture-design.md` §5.1 tier 1, §5.3, §6 items 2/4/6, §8 step 3
- Decision register: v5 §4 **D2** (three-tier orchestration), **D3** (tier 1 = Claude Code driving a
  *code* dispatcher; tested TS, never prompt-glue), **D8** (credential architecture)
- Derivation decisions: `docs/superpowers/specs/2026-08-11-v5-story-derivation-decisions.md` **DD-1**
  (operator-CLI-only for v5.0 — this CLI *is* the channel), **DD-7** (SwarmClaw is a host-side service
  chassis, **not** the front door), **DD-8** (NET-NEW material authored fresh), **DD-9**
- Ancestry: **P1.1 RE-DERIVE.** Surviving clauses per `R2-surviving-clauses.md` §1 — correlation-ID
  propagation (**CC-9**, `p1-1-dev-manager-a2a.md:47`), boundary schema validation (`:67`, `:71`,
  `:178`, `:190`), retry ownership (`:126`), exitStatus CC-1 (`:52`)
- Binding facts: R5 §6 facts 15 (in-box evidence is a claim), 17 (one secret per box, no push token)

## User Story

As the factory operator at tier 1,
I want four tested dispatcher verbs that mint a run handle, report fleet state, pull work back, and
destroy a box,
so that every factory action is a deterministic command with guards I can read, rather than a shell
line an agent improvises differently each time.

## Overview

`scripts/fleet.ts` is the factory's front door (DD-1). `dispatch` validates a brief against a schema
at the boundary, mints the runId, then walks DF2.1's ordering — record, box, key — filling at a pinned
SHA and gating through DF2.2's five assertions before the brief reaches tier 2. It returns the runId
synchronously, so the handle exists before any long-running work does. `status` joins run records
against the driver's own box list; `harvest` and `teardown` are thin, guard-preserving front doors
onto DF2.5. Every verb carries a `requestId` end to end, and a rejected dispatch provisions nothing.

## E2E Slice

**Demonstrable behavior:** Given a valid brief on stdin and the `fake` driver registered, When the
operator runs `bun scripts/fleet.ts dispatch --driver fake < brief.json`, it validates the brief →
mints `qds-20260811-a3f19c` → creates the record, the box, then the capped key → fills at the pinned
SHA → runs the setup gate → prints `{ runId, requestId: "<uuid-v4>", state: "ready", vmName,
httpsUrl }` and exits `0`; `fleet status` then lists that run as live, and `fleet teardown <runId>`
closes the record with `spendMicroUsd` set.

**Wiring closed:** On completion of this story, dispatching a run to a real box and destroying it
afterwards is real using only code merged by this story plus its predecessors. No stub, no
`TODO: wire later`, no sibling story required. DF3.2 fans out over this same `dispatch`.

**Dependency edges (predecessors):** DF1.8, DF2.1, DF2.2, DF2.5, DF2.6. **DF2.8 (budget cap) — contract-cited; implementation pending (see R5 §2.5).**

**Sequencing note (DF2.6 is a same-sprint predecessor):** DF2.6 and DF3.1 are both v5-S2. DF2.6 lands
**before** DF3.1, or — if the sprint reorders — AC8's `checkHeadroom(1)` call ships in the commit that
lands DF2.6's import, never as a stub or a locally re-derived ceiling. DF2.8 likewise lands before
AC7's `assertWithinBudget` call site; the contract call cites the DF2.8 story spec (`df2-8-cost-ledger-budget-cap.md:27-30` for interface, `:69-73` for gate contract). **Precondition:** DF2.8's cost ledger and budget gate are implemented before AC7 executes in production.

## Acceptance Criteria

1. **(make-or-break)** Given a brief that fails schema validation (unknown field, missing `repoSlug`,
   or `commitSha` not a 40-hex sha), When `dispatch` runs, Then it exits `2` naming the offending
   field and **nothing is provisioned**: no run record, no `driver.create()` call, no key minted.
   Validation completes before the first side effect. A non-UUID-v4 `requestId` is **not** a
   validation failure — the resolved-value rule (AC2) mints a fresh one.
   *Amended, review round 5:* that carve-out is about **shape**, not **safety**. A `requestId` whose
   FORMAT is not UUID v4 is dropped and re-minted as written above; one that is unsafe as a
   correlation key is still refused at exit `2` — over `MAX_REQUEST_ID` (128), a non-string, the
   empty string, or carrying a control character / JS line terminator / bidi override. The value
   rides into the run record, the ledger key and every operator log line, so a 10 MB id or an
   embedded ` ` is a log-forging vector, not a format question. Decision recorded in
   "Decisions taken" below.
   *Negative control: an implementation that mints the runId first and validates after produces a
   record for a rejected brief and MUST fail this test.*
2. Given a valid brief, When `dispatch` runs, Then it mints the runId itself and returns it
   **synchronously** once the setup gate resolves — before the run's work completes — and the returned
   `requestId` is the **resolved** value: the caller's if it supplied a strict UUID v4, else the
   dispatcher's. The caller reads the handle back rather than assuming its own stuck (design §5.3;
   `p1-8-protocol-run-github.md:36-39`). The in-process (non-CLI) form of `dispatch` also accepts an
   optional, dispatcher-minted `runId` — see "runId minting stays dispatcher-owned under fan-out too"
   below — for DF3.2's pre-parallel-section reservation; a caller-invented `runId` (one never returned
   by `mintRunId()`) is rejected.
3. Given the setup gate fails an assertion, When `dispatch` runs, Then it exits `3` carrying that
   assertion's code (DF2.2 A/B=1, C=2, D=3, E=4) **in the payload** — never as the process exit
   code, which would collide with this CLI's own table — the record stays **open** with the failure
   recorded, the box is left **alive** with its debug and teardown commands printed, and no brief
   reaches tier 2 (DF2.2 INV-5).
4. Given an empty fleet, When `fleet status` runs, Then it exits `0` with an empty result set — no
   runs is a state, not an error. Given a run whose record exists but whose box the driver's `list`
   no longer returns, Then that row reports `boxMissing` rather than being silently omitted. Given a
   runId with no run record on disk, When `status <runId>`, `harvest <runId>` or `teardown <runId>`
   runs, Then each exits `4` with a structured `{ code: "run-not-found", message, remediation }`
   error and **mutates nothing** — no record written, no driver call issued.
   *Amended, review round 5* (the amendment round 3 made to the behaviour but not to this text):
   for `status <runId>` only, the recordless path first probes the driver and, if a box IS running
   under that id, returns an `orphan` row at exit `0` instead of refusing. Exit `4` remains for the
   case where no record AND no box exists. A driver `list` on this path is therefore expected; the
   "no driver call issued" clause continues to bind `harvest` and `teardown`, which still refuse at
   exit `4` and mutate nothing. Rationale: a live box with no record is unattributed spend, and a
   bare exit `4` hides it from the one verb whose job is to show the fleet. The orphan row's `runId`
   is rendered `(orphan <vmName>)` — parenthesised like `FLEET_ROW_ID`, so it can never be pasted
   into `fleet teardown`; the real name rides on `vmName`.
5. Given a runId, When `harvest` or `teardown` runs, Then it delegates to DF2.5 with every guard
   intact — verify-before-fetch, the `refs/sandbox/` refspec, the fixed six-step teardown order — and
   adds no second retry loop around them.
6. Given `src/fleet/verbs.ts`, When `listVerbs()` is called, Then it returns the closed verb registry
   — one entry per verb, `{ verb, summary, flags: [{ name, required, valueType }], exitCodes }` — and
   `fleet --help` renders **from that registry**, holding no second hard-coded list. Every verb
   `scripts/fleet.ts` dispatches on appears in `listVerbs()` and every `listVerbs()` entry is
   dispatchable: the coverage test asserts both directions, so a verb added to the CLI without a
   registry entry (or the reverse) fails the build. *Negative control: an implementation whose
   `--help` prints a literal usage string passes a "help mentions dispatch" check and MUST fail the
   bidirectional coverage test.*
7. **(budget admission — DF2.8's gate has exactly one production caller)** Given a validated brief,
   When `dispatch` runs, Then it calls DF2.8's `assertWithinBudget(brief.repoSlug, brief.issueRef)`
   **before the run record is created** (and therefore before `driver.create()`), and an over-cap
   answer refuses the dispatch with DF2.8's refusal payload (exit `5`, `{ code, message, remediation }`
   naming the cap and the spend to date), provisioning **nothing** — no record, no box, no key. A
   single dispatch is not exempt from the
   per-issue cap merely because it is not a fan-out. **DF2.8 contract-cited; implementation pending:** this call cites the DF2.8 story spec contract (`df2-8-cost-ledger-budget-cap.md:27-30` for interface, `:69-73` for gate contract). *Negative control: an implementation that
   provisions and lets DF2.8 refuse at mint time has already paid for a box and MUST fail this test.*
8. **(headroom admission — DF2.6's ceiling binds serial dispatches too)** Given a validated brief,
   When `dispatch` runs, Then it calls DF2.6's `checkHeadroom(1)` **before the run record is created**
   (and therefore before `driver.create()`), and
   `allowed: false` — including the `reason: "list-unverified"` case, where headroom could not be
   determined — refuses the dispatch with the refusal payload (exit `5`, reason echoed), provisioning
   nothing. Serial single dispatches cannot walk past the fleet ceiling one box at a time (F9). The
   call is made unless the caller passes `{ admitted: true }` — DF3.2 alone sets it, having already
   made the one `checkHeadroom(N)` covering all its arms, so a fan-out of N never makes N checks of 1
   (DF3.2 AC1). *Negative control: an implementation that consults headroom only in `fanout` lets N
   sequential dispatches exceed the ceiling and MUST fail this test.*
9. **(the cap crosses the boundary exactly once — dispatch is the only producer)** Given a run whose
   key has been minted, When `dispatch` fills the box at the pinned SHA, Then it performs both halves
   of the cap hand-off, **before tier 2 is invoked**:
   <br />**(a)** the minted `limitMicroUsd` is **stamped into DF1.1's frozen manifest at fill time**,
   so the value travels into the box with the manifest that is frozen at load — this story declares `limitMicroUsd` in the manifest's zod schema (Files to Modify; DF3.6's three bound fields join it there under DF3.6's own FTM entry). That stamped field is
   the engine's **only** source for the run's cap: DF3.6's AC2b clamp reads it from the frozen
   manifest and never from the host-side `.sandbox/runs/<id>.json` record, which is unreachable from
   inside the box. A fill that omits it produces a manifest DF3.6 refuses (its refuse-if-absent
   rule), so the value can never be silently defaulted.
   <br />**(b)** the run context handed to the box carries
   `effectiveCeilingMicros = min(remainingMicroUsd, defaultKeyCapMicroUsd)` — **the same value
   dispatch hands DF2.3's mint**, computed once here and propagated, never re-derived downstream.
   `remainingMicroUsd` is DF2.8's `assertWithinBudget` return (AC7); `defaultKeyCapMicroUsd` is
   DF2.3's configured default. DF1.6 raises the spawn harness cap from this field, so a dispatch that
   leaves it unset silently spawns every run at the $0.50 harness default.
   *Negative control: an implementation that mints the capped key and moves on — leaving the manifest
   without `limitMicroUsd` and the run context without `effectiveCeilingMicros` — passes every
   admission test above, and MUST fail this one.*

## Trigger Surface

| Trigger | Status | E2E Test | Follow-Up |
|---------|--------|----------|-----------|
| `bun scripts/fleet.ts dispatch` | in-scope | `tests/fleet/cli.test.ts` | — |
| `bun scripts/fleet.ts status [runId]` | in-scope | `tests/fleet/cli.test.ts` | — |
| `bun scripts/fleet.ts harvest\|teardown <runId>` | in-scope | `tests/fleet/cli.test.ts` | — |
| `fleet fanout N` / best-of-N / race | out-of-scope | — | DF3.2 |
| `fleet attach` mid-run steering | out-of-scope | — | DF3.4 |
| Fleet-wide orphan sweep | out-of-scope — DF2.6's `scripts/sandbox-reap.ts` is the whole surface; v5.0 ships **no** `fleet reap` wrapper | — | DF2.6 |
| Tier-1 Claude Code skills wrapping these verbs | out-of-scope | — | DF3.5 |
| SwarmClaw HTTP route | out-of-scope — **not the front door (DD-7)** | — | DF5.5 records the role |
| Telegram / channel intake | out-of-scope — **no channel in v5.0 (DD-1)** | — | none derived |

## Infra Prerequisites

| Component | Service (compose/k8s/provider) | Lifecycle Hook Verified |
|-----------|-------------------------------|-------------------------|
| Provider driver registry | in-process, `src/providers/index.ts` (DF2.1) | `resolveDriver(name)` returns before `dispatch` performs any side effect |
| Run-record store | host filesystem `.sandbox/runs/` at mode `0700` (DF2.1) | record `O_EXCL`-created before `driver.create()` — asserted by call-order capture |
| Per-issue budget cap | DF2.8 `assertWithinBudget(repoSlug, issueRef)`, host-side against the cost ledger | returns before the first side effect; over-cap refuses with DF2.8's payload and zero provisioning (AC7) |
| Fleet headroom | DF2.6 `checkHeadroom(1)`, host-side against the provider's own box list | returns `{ allowed, liveVms, ceiling, headroom, reason? }` before the first side effect (record creation, then `driver.create()`); `allowed: false` — `reason: "list-unverified"` included — refuses (AC8) |
| Sandbox box | exe.dev driver (DF2.2); `fake` driver for CI | setup gate returns `ready` with five `{item, ok, note}` entries |
| Run key | DF2.3 credential lifecycle | mint returns a verified capped key; only `keyHash` reaches the record |
| Harvest / teardown | DF2.5 | `git bundle verify` precedes fetch; teardown's six steps in fixed order |

## Technical Notes

- **Dispatch is the front door (D3, DD-1).** The dispatcher is tested TypeScript with a schema at its
  ingress. A tier-1 agent invokes these verbs; it never composes the underlying provider commands
  itself, because that is how the measured guards get dropped silently. SwarmClaw has no role (DD-7).
- **runId ack semantics (NET-NEW — authored fresh per DD-8; cite design §5.3, not P1.1).** R2 §1
  records that P1.1 contains no `runId` at all, so there is no ancestral clause to inherit. The rule:
  the **dispatcher** mints the runId (never the caller), writes the record under it before any
  billable call, and returns it synchronously as the ack. The ack asserts *"this run exists and is
  provisioned"* — never *"this run succeeded"*; completion is observed through `status` and the trace
  store. A client that dies after dispatch can still find, harvest and tear down its run from the
  printed handle alone.
- **Correlation ID propagation (CC-9, surviving from `p1-1-dev-manager-a2a.md:47`, re-aimed).** Every
  dispatch carries a `requestId` (UUID v4) that propagates through all layers — **tier-1 dispatch →
  fleet dispatcher → in-sandbox subprocess tree → phase-engine step** — appearing in exactly four
  places: (1) the brief's `requestId`, (2) the ack's `requestId`, (3) every run-record mutation and
  driver-call log line, (4) every trace-store row (DF1.4's schema — fed here, joined end-to-end by
  DF1.8, a declared predecessor). *The requestId is the join key for cross-layer tracing.* P1.1's
  layer chain is dead; the four sites and the join-key rule carry intact.
- **Boundary against DF1.8 — one resolver, not two (XC).** DF1.8 owns `resolveRunCorrelation`: the
  requestId↔runId↔repoSlug resolution and its pre-provision rejection semantics. DF3.1 **calls** it
  at the front door and owns only the mapping of its outcomes onto this CLI's exit-code table
  (`RequestIdRepoMismatch` → `2`, unresolvable runId → `4`). This story implements no second
  resolver and re-derives none of DF1.8's rules.
- **"Closed brief schema" means closed to *callers*, not frozen against later stories.** The closure
  INV-2 states is an **ingress** rule: a brief arriving at `dispatch` carrying a key the schema does
  not declare is rejected, never ignored, and no caller may smuggle a field through by convention. It
  is **not** a claim that `src/fleet/brief-schema.ts` never gains a key again. A later story may add
  a top-level key to the schema file itself — declaring it, its type and its validation — at which
  point briefs carrying that key are accepted and briefs carrying anything still undeclared are
  rejected exactly as before. **DF6.1 does this**, registering its allow-listed `fixContext` key
  ("adds only" against this file). The two statements are consistent: ingress stays closed at every
  point in time; the set of declared keys is what a later story may extend.
- **Resolved-value rule (`p1-8-protocol-run-github.md:36-39`).** A caller-supplied `requestId` is
  honoured **only if** it is a strict UUID v4, else the dispatcher mints one and every downstream
  event carries the **resolved** value. It is optional on ingress — no upstream envelope to echo.
- **Retry ownership — a single owner (`p1-1-dev-manager-a2a.md:126`).** The dispatcher owns at most
  one retry loop, around provider calls only. Callers MUST NOT add a second; DF1.3 owns in-phase
  retry and P1.9 owns cross-run restart classification. Three bounded layers, never nested.
- **Boundary against DF2.6/DF2.8 — DF3.1 calls, it does not own.** DF2.6 owns the fleet ceiling and
  the accounting behind `checkHeadroom`; DF2.8 owns the per-issue budget cap behind
  `assertWithinBudget`. DF3.1 owns only the two call sites (AC7, AC8), placed before
  `driver.create()`, and the mapping of a refusal onto exit `5`. It re-derives neither ceiling, keeps
  no local copy of either limit, and adds no second accounting path.
- **Boundary against DF3.2:** DF3.1 admits **one** run — `checkHeadroom(1)`. The `N`-wide admission,
  the `< N` refusal, the `.sandbox/fleet.lock` critical section and the reaper queue stay DF3.2's and
  DF2.6's; a fan-out arm reaching `dispatch` is admitted under DF3.2's single `checkHeadroom(N)`, and
  AC8's per-dispatch check is the guard for the **serial** path DF3.2 never sees. The two are kept
  from colliding by one explicit parameter, not by convention: `dispatch(brief, { admitted: true })`
  — set **only** by DF3.2 inside its `.sandbox/fleet.lock` critical section, after its single
  `checkHeadroom(N)` — skips AC8's own call, so a fan-out still makes exactly one headroom call for
  all N (DF3.2 AC1) while every other caller is checked. The default is `admitted: false`. This
  parameter is **not** part of `scripts/fleet.ts`'s CLI surface — no flag maps to it — so it is
  reachable only by an in-process caller importing `src/fleet/dispatch.ts` directly; DF3.2's
  `fanout.ts` is the sole such caller in this codebase, and a coverage test (DoD) asserts no CLI flag
  or argv path can set it.
- **runId minting stays dispatcher-owned under fan-out too.** `dispatch()`'s exported (in-process)
  signature is `dispatch(brief, { admitted?, runId? })`: the optional `runId` is never a caller-chosen
  string — it is only ever a value the dispatcher itself already minted through the same
  `mintRunId()` helper `dispatch()` calls internally when `runId` is omitted. DF3.2's fan-out calls
  `mintRunId()` synchronously, once per arm, **before** its parallel section opens (its own AC3),
  then passes each pre-minted id into that arm's `dispatch(brief, { admitted: true, runId })` call.
  The dispatcher remains the only minter — no arm's id is ever invented by a caller — while still
  letting DF3.2 hold all N ids before dispatching any arm. A single (non-fan-out) `dispatch()` call
  never supplies `runId`; that path continues to mint at call time exactly as AC2 describes.
- **Exit codes (this CLI's own table — do not inherit P1.6's warren mapping, F3):** `0` success ·
  `1` run/provider failure · `2` usage/schema error · `3` setup-gate failure (assertion code in the
  payload) · `4` run not found · `5` **refused before provisioning — admission or lock (payload code
  distinguishes)**: DF3.2's fan-out headroom refusal and its `fleet-busy` lock refusal, and this
  story's own single-dispatch admission refusals (AC7 `budget-exceeded`, AC8 `no-headroom`). One
  code, one meaning — nothing was provisioned — and the payload `code` says which guard fired. Imports the 5-value exitStatus enum (CC-1, `cli-anything/src/types.ts:94-108`).
  *Amended, review round 5:* `6` **cleanup failed on an otherwise-successful path** — the verb's own
  work completed, but a ledger close or a lock release did not, so the spend may not be durably
  committed. Classified `logic`, never `transient`: retrying re-runs a destructive verb that already
  succeeded, which is the loop exit `6` exists to prevent. It is a direct CLI exit and deliberately
  NOT constructible through `FleetError.exitCode` (typed `1|2|3|4|5`), because nothing below the CLI
  may raise it. `harvest` and `teardown` declare it in `listVerbs()`; DF3.5 generates from that
  registry, so it needed a table entry rather than only a code comment.
  Also `status` exit `2` when any run-record file could not be read: the rows printed are not the
  whole fleet, a retry cannot complete the listing, and exit `1` (`transient`) would create the same
  retry loop. The `records-skipped` stderr envelope names the files.
- **Guards/limits:** brief ≤ 64 KiB from stdin or `--brief <path>`; dispatch wall-clock ceiling
  600_000 ms covering mint through setup-gate resolution; `status` driver `list` timeout 30_000 ms,
  after which rows report `boxUnknown` rather than blocking. Flags parse through `parseValueFlags`
  (`scripts/lib/cli-args.ts`).
- **Deviation/assumption:** every exe.dev behaviour reached through DF2.2 is vendor-single-origin and
  carries `[VERIFY]` (R5 §6 fact 11). This story asserts nothing about exe.dev directly, tests against
  the `fake` driver, and no AC assumes a SOC 2 report, DPA or SLA exists.

## Observability Contract

- Every verb logs `{ requestId, runId, verb, phase, timestamp, durationMs, exitStatus }`; a rejected
  dispatch logs `runId: null` because no run was minted. requestId propagates per CC-9 above.
- Errors include `{ code, message, remediation }` naming the literal next command; never key material.
- Sub-timings: `validate_ms`, `mint_ms`, `create_ms`, `fill_ms`, `setup_gate_ms`. Where a driver
  cannot break a remote call down it reports `0` and `durationMs` is authoritative.

## Files to Modify

- `src/phase-engine/manifest.ts`
- `src/fleet/dispatch.ts`
- `src/fleet/status.ts`
- `src/fleet/brief-schema.ts`
- `src/fleet/verbs.ts` (the verb/flag registry — `listVerbs()`; sole source for `--help` and for
  DF3.5's skill-contract test)
- `src/fleet/index.ts`
- `scripts/fleet.ts`
- `tests/fleet/dispatch.test.ts`
- `tests/fleet/brief-schema.test.ts`
- `tests/fleet/verbs.test.ts`
- `tests/fleet/cli.test.ts`

### Declared FTM deviations (2026-08-21, review round 2)

The list above was written pre-implementation and is **not** what shipped. Every path below is
outside it; each is recorded here rather than left as silent drift. Decisions 1 and 4 in the Dev
Agent Record described the opposite of the shipped design and have been corrected in place.

| Path | Why it had to change | Kind |
|------|---------------------|------|
| `src/phase-engine/types.ts` | `limitMicroUsd?: number` on `PipelineManifest` — the interface lives here, not in manifest.ts | additive (already declared) |
| `src/providers/driver.ts` | `provisionAdmittedRun` — the post-admission body dispatch composes (see corrected Decision 1) | additive export + hardening |
| `scripts/lib/run-lock.ts` | **net-new.** DF2.5's per-run lock extracted to one shared module (see corrected Decision 4) | net-new |
| `scripts/sandbox-teardown.ts` | loses its private lock copy to the shared module; run-id guard now delegates to the store's validator | refactor + corrective |
| `src/providers/run-record.ts` | `gate` extension namespace (AC3); `RUN_ID_RE`/`RUN_ID_MAX` exported to end a 4-way duplication; `requestId` core field (INV-4-bis); **`withLock` lost-update race fixed**; `RUN_ID_RE` tightened to the RFC 1123 grammar it documents | corrective — see Review round 2 |
| `src/providers/cost-ledger.ts` | `ADMISSION_GRACE_MS` closes an admission double-grant race; `admitIssue` doc states the reservation invariant | corrective |
| `src/providers/fake-driver.ts` | private run-id regex → canonical import (its copy had become *looser* than the validator, risking a reaper stall) | corrective |
| `src/providers/budget-gate.ts` | lint only (`useTemplate`) | corrective |
| `scripts/qds-cost.ts` | same `noUnsafeFinally` money-path defect fixed under F4-2, in DF2.8's ledger CLI | corrective, out-of-PR |
| `tests/fleet/helpers.ts` | net-new shared fixtures | net-new |
| `tests/providers/run-record.test.ts`, `tests/providers/cost-ledger.test.ts` | permanent coverage for the two races above | additive |
| `tests/scripts/sandbox-teardown-cli.test.ts` | lock extraction + validator delegation | additive |

Four of these (`run-record.ts`, `cost-ledger.ts`, `fake-driver.ts`, `qds-cost.ts`) are **pre-existing
defects outside this story's scope**, fixed here because they are the same defect classes this
story's review surfaced and leaving them would have meant shipping a fix beside its unfixed twin.

## Security Invariants

- **INV-1 (isolation):** one dispatch mints one run, one box, one key, one record (R8). The dispatcher
  owns no shared working tree, no shared key and no cross-run state — isolation is structural.
- **INV-2 (input validation at the trust boundary — fail-closed):** the brief is schema-validated **before** the
  first side effect, and rejection is total — no record, no box, no key, nothing spawned. This is the
  v5 form of P1.1's ingress rule (`:67`, `:71`, `:178`), and it strengthens under D8 because a spawn
  now mints a credential that spends money. Unknown fields are rejected, never ignored. A rejected dispatch provisions nothing (R3 fail-closed doctrine).
- **INV-3 (ordering, so nothing leaks):** record → box → key, enforced by construction (DF2.1 INV-1).
  A failed mint orphans a box — cheap, and visible in the driver's own `list`; the reverse would
  orphan a key that spends invisibly.
- **INV-4 (credential containment):** the dispatcher never prints, logs, echoes or passes key material
  on argv — only `keyHash`. The provisioning key is host-only. No GitHub token, PAT, deploy key or ssh
  identity ever enters a box; PR creation stays host-side (D8; R5 §6 fact 17).
- **INV-4-bis (requestId propagation end-to-end):** requestId propagates through all layers per CC-9 — tier-1 dispatch → fleet dispatcher → in-sandbox subprocess tree → phase-engine step — appearing in brief, ack, every run-record mutation/driver-call log line, and trace-store rows (DF1.4). The requestId is the join key for cross-layer tracing (R3 doctrine).
- **INV-5 (fail-closed):** if the setup gate does not return `ready`, the driver registry cannot
  resolve, or the record cannot be created with `O_EXCL` at mode `0600`, dispatch refuses and exits
  non-zero. It never proceeds on a degraded box, never destroys a failed box (that discards the
  evidence), and never treats an unverified vendor claim as an implicit pass. (R3 fail-closed doctrine: degraded inputs fail loudly rather than proceed with best-effort interpretation.)
- **INV-6 (redaction complement to INV-4):** Any URL containing management/deep-link parameters is redacted before logging (R3 redaction doctrine). *Amended, review round 5:* the shipped rule is whole-segment, not the `[0-9a-zA-Z%-]{16,}` token regex this invariant originally named — every path segment, the entire query and fragment, any userinfo, and any host label ≥16 chars are replaced. That is strictly broader than the token regex (which a short but sensitive segment would slip past), so no coverage was lost; the text is corrected because a reviewer grepping for the named regex finds nothing. Secrets with no URL scheme are a separate layer: `redact()` composes `redactSecrets`, which also swallows whole PEM blocks and exempts filesystem paths and stack frames so ordinary diagnostics survive.

## Definition of Done

- [ ] **Impl:** `dispatch` validates, mints, then walks record → box → key → fill → setup gate, and
      returns the runId ack synchronously
- [ ] **Impl:** `status` joins run records against `driver.list()`, reporting `boxMissing` and
      `boxUnknown` as first-class states; `harvest`/`teardown` delegate to DF2.5 unmodified
- [ ] **Contract:** brief schema closed and enforced at ingress; ack shape
      `{ runId, requestId, state, vmName, httpsUrl }` asserted by test
- [ ] **Contract (verb registry, AC6):** `listVerbs()` in `src/fleet/verbs.ts` is the **sole** source
      of verb and flag names; `fleet --help` renders from it with no second list in the diff, and a
      bidirectional coverage test asserts registry ⇄ dispatchable-verb parity. **Every later story
      adding a `fleet` verb registers it here** — DF3.2's `fanout`/`rank`, DF3.4's
      `approve`/`reject`/`attach` — and DF3.5's skill-contract test is a second *consumer*, never a
      second source
- [ ] **Integration:** every provider touch goes through DF2.1's `ProviderDriver` — no substrate
      command string appears anywhere under `src/fleet/`
- [ ] **Security:** rejection-provisions-nothing proven by call-order capture (INV-2); requestId propagates end-to-end (INV-4-bis); no code path writes key material to a log, argv or the record (INV-4/INV-6); redaction of management URLs in logs (INV-6)
- [ ] **Test (unit):** `requestId` resolution — supplied strict UUID v4 is honoured, malformed and
      absent both mint a fresh one, and the ack always carries the resolved value
- [ ] **Test (malformed dispatch, INV-2):** each of three invalid briefs → exit `2`, zero files in
      `.sandbox/runs/`, `driver.create()` call count `0`, mint call count `0`; a validate-after-mint
      implementation MUST fail this test
- [ ] **Test (admission, AC7/AC8):** an over-cap `assertWithinBudget` answer and an
      `allowed: false` `checkHeadroom(1)` answer (including `reason: "list-unverified"`) each exit `5`
      with the distinguishing payload `code`, zero files in `.sandbox/runs/`, `driver.create()` call
      count `0`; both calls are asserted to occur **before** the first side effect by the same
      call-order capture, and `{ admitted: true }` suppresses the headroom call only
- [ ] **Test (cap hand-off, AC9):** one dispatch's frozen manifest carries the minted
      `limitMicroUsd` and its run context carries `effectiveCeilingMicros`, both asserted equal to
      the values dispatch computed (the mint's cap and `min(remainingMicroUsd,
      defaultKeyCapMicroUsd)` respectively) and both present **before** the first tier-2 invocation;
      a fill that omits either fails, and the manifest is asserted to be the sole carrier — no test
      path reads `.sandbox/runs/<id>.json` from inside the box
- [ ] **Test (e2e demo — MANDATORY):** `dispatch → status → teardown` against the `fake` driver
      produces the printed ack, a `status` row showing the run live, and a closed record with
      `spendMicroUsd` set — the three outputs captured in the Dev Agent Record

## Dev Agent Record

**Implemented:** 2026-08-21, branch `feature/df3-1-fleet-dispatcher-core-verbs`, waves of parallel subagents (research ×7 → architect → 3 TDD implementation agents → orchestrator finish).

**Files (11 at implementation; 23 after review round 2 — see "Declared FTM deviations" above. The
claim "exactly FTM + 1 declared type completion" was already false when written: `src/providers/driver.ts`,
`scripts/lib/run-lock.ts` and `scripts/sandbox-teardown.ts` were all outside FTM.):**
- `src/fleet/brief-schema.ts` (net-new): zod v3 `.strictObject` — repoSlug/issueId/issueUrl?/commitSha(40-hex)/requestId?/manifestPath/repoUrl; `extractZodErrorField` names the offending field for exit 2.
- `src/fleet/dispatch.ts` (net-new): `dispatch()` composes DF2.1 primitives directly (C1 — see Decision 1), `FleetError`, `mintRunId()` = `newId("qds")`, `fakeGate` (five real dir-box probes), 600s wall-clock seam, sub-timings, INV-6 URL redaction, `run-context.json` + stamped `pipeline.yaml` fill.
- `src/fleet/status.ts` (net-new): `statusAll`/`statusRun` — live/boxMissing/boxUnknown/closed join, 30s list timeout, listOk tracked separately from empty list (unknown ≠ gone doctrine, lifted from indydevdan inkwell `runs_table.py`).
- `src/fleet/verbs.ts` (net-new): `listVerbs()` exact story shape + `renderHelp` — sole source for `--help`.
- `src/fleet/index.ts` (net-new): barrel per C5 (no harvest/teardown modules).
- `scripts/fleet.ts` (net-new): verb CLI per repo idiom (tokenizeArgs/parseValueFlags, run(argv,out,deps) DI, writeSync entry, stderr log sink); harvest/teardown delegate to DF2.5 with the per-run lock replicated verbatim; exit table 0/1/2/3/4/5.
- `src/phase-engine/manifest.ts` (additive): `limitMicroUsd` optional top-level + `stampManifestLimit` + `serializeManifest` (emits **JSON** under the `.yaml` filename — `loadManifest` is the authoritative reader and it `JSON.parse`s; JSON is a YAML subset, so a YAML reader accepts it too, while `YAML.stringify` output no JSON parser will take. See the function's own rationale).
- `src/phase-engine/types.ts` (additive, **FTM deviation — 1 line**): `limitMicroUsd?: number` on `PipelineManifest` — the interface lives here, not manifest.ts; the schema edit is incomplete without the matching declaration. Justification: AC9a's "declares limitMicroUsd in the manifest's zod schema" spans schema+type; strictly additive, no consumer changes.
- `tests/fleet/{brief-schema,dispatch,verbs,cli}.test.ts` (net-new): 84 tests.

**Decision 1 (D1 overturned, verified against source — CORRECTED 2026-08-21, review round 2):** `createRun` (driver.ts:134) calls `checkHeadroom(driver, 1, ...)` unconditionally with no skip option — routing `{admitted:true}` through it would make an N-arm fan-out do N headroom checks of 1, violating AC8/DF3.2-AC1. Dispatch therefore mirrors createRun's post-admission body itself (store.create O_EXCL → budget-ext write → driver.create(TAG) → expose/setPublic → store.set) with the two admission call sites dispatch-owned exactly as the story's boundary note specifies. No ceiling or limit is re-derived: the mint cap, manifest stamp and run-context value are all `decision.admittedCeilingMicroUsd` — DF2.8's `min(keyCap, remaining)`, computed once.

> **Correction:** the original text justified this by "and driver.ts is not in FTM", which the shipped
> code contradicts — `provisionAdmittedRun` was **added to** `src/providers/driver.ts` and is imported
> by `dispatch.ts:27`. The headroom argument stands on its own and is the real reason; the FTM clause
> was wrong and is withdrawn. `src/providers/driver.ts` is now a declared FTM deviation (see the table
> above). Review round 2 additionally hardened `provisionAdmittedRun`: it persists `vmName` before
> expose/setPublic so a failure cannot orphan a billable box with no teardown handle, validates
> `runId` and `port` at entry, and its doc comment no longer claims a key-minting step it never had.

**Decision 2:** requestId is loose at the schema layer (a non-UUID string is not a schema failure, AC1); dispatch drops a non-v4 requestId to `undefined` before `resolveRunCorrelation`, which then mints — DF1.8's INVALID_REQUEST_ID path stays intact for direct callers. `initiateSession` is NOT called by dispatch (engine-side owns the trace store; D9); requestId reaches DF1.4 rows via the in-box run context and every log line (INV-4-bis).

**Decision 3 (fake gate honesty):** the real `setupGate` requires ExeDevDriver's `execTimed`/`boxHost`. The fake path runs `fakeGate` — five REAL `driver.exec` probes of the box's on-disk state (reachable / manifest carries limitMicroUsd / env file mode 600 / manifest non-empty / phases declared), one per DF2.2 assertion item, A/B sharing code 1. No simulated ready verdicts; a probe that fails reports its note.

**Decision 4 (CLI teardown lock) — SUPERSEDED 2026-08-21, review round 2.** The original text read:
*"DF2.5's per-run `acquireRunLock` lives in `scripts/sandbox-teardown.ts` (not importable, not in FTM).
It is replicated verbatim in `scripts/fleet.ts` (no-steal, holder reporting) so AC5's 'every guard
intact' holds; both copies must stay in sync."*

That is not what shipped, and "both copies must stay in sync" was the defect: a lock guarding
irreversible operations (box destroy, key revoke, spend write) cannot depend on two hand-maintained
copies. `acquireRunLock` was extracted to a net-new **`scripts/lib/run-lock.ts`** that both CLIs
import. Review round 2 then found the extraction had taken only *acquire*, leaving each CLI to
hand-roll release — so release now lives there too, and the module owns the full lifecycle:

- acquire is atomic and the lock is never observable with an empty body (temp file + `linkSync`), so
  a contender can no longer parse a half-written lock as unowned and steal it;
- release **proves ownership** before unlinking — the previous `rmSync(lock, {force:true})` would
  delete a *different* live invocation's lock, causing the exact double-teardown the lock exists to prevent;
- stale detection checks whether the holder pid is actually **alive**, so PID reuse no longer produces
  a remediation the operator cannot follow;
- SIGINT/SIGTERM release the lock — previously one Ctrl-C left a run permanently un-teardownable while
  its box and key stayed live and billing;
- a release failure now affects the exit code, where the CLI previously printed success and exited 0
  on a wedged run.

The identical defect class was found in the canonical `RunRecordStore.withLock` and fixed there too
(see Review round 2). `sandbox-teardown`'s user-facing holder wording is preserved by parameterising
the holder name rather than letting a refactor change a shipped CLI's output.

**Tests:** `tests/fleet/` 84/84 green · full `tests/providers/ + tests/phase-engine/` 1106 green (one first-run usage.test.ts env flake did not reproduce on rerun; passes solo) · `bunx tsc --noEmit` clean · `bunx biome check` clean (12 files) · advisory gates OK (`check-defensive-programming.sh` 0 findings on 2 changed .ts; `check-pr-conflicts.sh` 0 open-PR overlaps).

**E2E demo (DoD, fake driver, captured verbatim):**
```console
$ bun scripts/fleet.ts dispatch --driver fake < brief.json   → exit 0
{"runId":"qds-20260821-12a82a","requestId":"d578c4b0-042a-4952-81b5-124c5f8e5e21","state":"ready","vmName":"qds-20260821-12a82a"}
$ bun scripts/fleet.ts status --driver fake                  → exit 0
{"runId":"qds-20260821-12a82a","state":"live","vmName":"qds-20260821-12a82a","createdAt":"2026-08-21T12:32:21.517Z","limitMicroUsd":50000000}
$ bun scripts/fleet.ts teardown --driver fake qds-20260821-12a82a → exit 0
torn down: qds-20260821-12a82a
# record: closedAt=2026-08-21T12:32:21.887Z spendMicroUsd=0 (captureSpend wrote it; fake key usage 0); box_hours 3600000 µ$ ingested by DF2.8's close hook
```
Teardown log shows the full seven-step order (spend→artifacts→harvest→revoke→verify→destroy→close) and dispatch's log carries `validate_ms/mint_ms/create_ms/fill_ms/setup_gate_ms` with requestId propagated onto every line.

**Research provenance:** integration spec + 6-track research cached at `_bmad-output/workflow-state/qds-dev/df3-1/` (indydevdan mining verdict: both repos Python/MIT; our DF2.1 run-record.ts is the hardened TS descendant of inkwell's `run_record.py` — doctrine lifted (three-state status), no Python re-ported).

---

## Hardening Revision — 2026-08-20

**Changes from original 2026-08-11 spec:**
- **DF2.8 disposition:** Marked DF2.8 (budget cap) as "contract-cited; DF2.8 implementation pending" per R5 §2.5 recommendation. Cites DF2.8 story spec contract (`df2-8-cost-ledger-budget-cap.md:27-30` for interface, `:69-73` for gate contract). Added precondition that DF2.8 implementation lands before AC7 executes in production.
- **Security INV-4-bis added:** RequestId propagation end-to-end per CC-9 (R3 doctrine). Explicitly names four propagation sites.
- **Security INV-6 added:** Credential redaction and management URL redaction per R3 doctrine (regex `[0-9a-zA-Z%-]{16,}` broad enough for encoding drift).
- **INV-2 strengthened:** Added "fail-closed" language and explicit "rejected dispatch provisions nothing" per R3 doctrine.
- **DOD trimmed:** Reduced from 14 to 10 checkboxes by merging unit test items and removing "admitted-flag containment" as subsumed under integration coverage.
- **Files to Modify:** Kept at ≤10 unique paths (no change needed — was already compliant).
- **Campaign fixes 2026-08-20:** DF3.1-H1, DF3.1-M1, DF3.1-L1.

---

## Review round 2 — BMAD adversarial code review, 2026-08-21

**Method.** 9 parallel review agents over a chunked PR diff (3 blind-adversarial, 3 edge-case with
repo access, 2 test-quality auditors, 1 acceptance auditor against this spec). 197 raw findings →
after dedupe and triage: **138 patched (every LOW included), 4 deferred, 5 dismissed.** Fixes ran in
three waves over disjoint file clusters (source → hardening → tests), each wave verified before the
next began.

### The five defects the review found that the findings ledger had NOT flagged

These came out of fixing root causes rather than the symptoms as written. All five were real, and
none would have been caught by patching the original findings.

1. **Lost update in `RunRecordStore.withLock`** (`src/providers/run-record.ts`) — pre-existing at
   HEAD, in the canonical run-record store. `openSync(…,"wx")` then a separate write left a window
   where the lock existed with an empty body; a contender parsed `Number("") === 0`, failed the
   `owner > 0` liveness guard, and **stole a live holder's lock**. Two concurrent read-modify-writes
   then dropped a field with every process exiting 0. Proven with a 3-process stress harness against
   a pristine `git archive HEAD` checkout: **HEAD 5 lost updates / 200 iterations** (`sessionId` ×2,
   `keyHash` ×2, `vmName` ×1); **fixed 0 / 200**. At 40 iterations neither version failed — the
   earlier short runs proved nothing.
2. **Admission double-grant** (`src/providers/cost-ledger.ts`) — the reservation orphan guard could
   not distinguish *never created* from *not created yet*, so two concurrent dispatches for one issue
   could each win the full remaining headroom. Closed with `ADMISSION_GRACE_MS`, scoped to the read
   where the existing expiry already lives — INV-COST-1 and INV-COST-3 both intact, and DF3.2's
   N-arm fan-out is not serialized.
3. **`fake-driver` run-id filter became looser than the validator.** `list` filters names so it only
   reports ids `destroy` will accept; after the `RUN_ID_RE` tightening its private copy would have
   listed a `trailing-` box that then threw on destroy, **aborting the reaper mid-sweep**. A
   "harmless duplicate" that was a live fleet-wide reap-outage vector.
4. **`within()` abandoned an in-flight promise** (`src/fleet/dispatch.ts`) — on the deadline
   early-throw nothing subscribed to the already-running provider call, so a later rejection was an
   **unhandled rejection**. Found by the test wave, which reproduced it hanging the test runner and
   misattributing an ENOENT to the following test.
5. **Six `DispatchDeps` seams silently dropped by the CLI** — `repoRoot`, `quotaLimits`, `clock`,
   `timeoutMs`, `dispatchLogPath`, `setupGate`. Fixed structurally (`FleetDeps` inherits via `Omit` +
   rest-spread) so seam number seven forwards with no edit.

### Themes across the patched findings

- **Lock discipline (the largest cluster).** The extraction had taken only *acquire*, leaving each
  CLI to hand-roll release. Release now proves ownership before unlinking (it previously deleted a
  *different* live invocation's lock), stale detection checks pid liveness, SIGINT/SIGTERM release,
  and a release failure affects the exit code. See the superseded Decision 4 above.
- **Money-invisible states.** `fleet status` was a left join, so a still-billing box with no record
  was invisible; it is now a real union with an `orphan` state. A `closed` record no longer
  short-circuits the driver join, so a live box behind a closed record surfaces via `boxAlive`.
- **Ambient `process.cwd()` as a trust anchor.** Three separate "test pollution" findings traced to
  one root cause: security-relevant configuration inherited from the process cwd instead of injected.
  The manifest containment root and the teardown cost-ledger path are now explicit seams; the PR's
  test suite contains **no `process.chdir`**.
- **`--driver` no longer defaults to `fake` on any verb.** `fleet teardown <id>` with no `--driver`
  used to "destroy" a fake box, print `torn down`, close the record and exit 0 while the real box
  kept billing.
- **One run-id grammar.** Four copies collapsed to the canonical export, and `RUN_ID_RE` was
  tightened to the RFC 1123 hostname grammar its own doc comment claims (it accepted a trailing
  hyphen, which becomes an invalid box hostname). Verified against every id-shaped literal in the
  tree: no real id shape is newly rejected.
- **Test quality.** ~60 audit findings fixed: tautological assertions, self-referential `--help`
  comparisons, substring assertions that passed a 10× unit error, mocks that ignored their
  arguments, missing negative controls. `tests/fleet/` went 59 → **176 pass**, `expect()` calls
  roughly tripled.

### Deferred (filed, not fixed here)

| Item | Why |
|------|-----|
| Engine-side mandatory `limitMicroUsd` | Needs an engine change outside this story's FTM; the in-scope guard (assert the stamp landed) is applied |
| `driver.list()` `AbortSignal` | Requires a DF2.x driver-interface change |
| Cross-process dispatch serialization | Would defeat DF3.2's fan-out; `ADMISSION_GRACE_MS` closes the actual race |
| AC2 run-id provenance | Now enforced at **compile** time via a branded `MintedRunId`; a runtime mint registry remains out of scope |

### Verification

- `bun test` — **2444 pass, 0 fail** (81 files; 17 skip, 2 todo, all pre-existing)
- `bunx tsc --noEmit` — clean
- `bunx @biomejs/biome check src scripts tests` — clean, **187 files** (including two pre-existing
  errors in `qds-cost.ts` and one in `budget-gate.ts` that were fixed rather than left)
- `detect_changes` — CRITICAL, expected and accepted: driven by `assertValidRunId` (48 dependents,
  12 flows) and `withLock`, both deliberately touched. Every affected process is in
  `providers`/`phase-engine`/`scripts`; no fallout in `hindsight/`, `swarmclaw/` or `cli-anything/`.

## Review round 3 — BMAD adversarial code review, 2026-08-22

**10 review layers** against the PR #123 diff, chunked by file cluster (≤1331 diff lines each) so no
reviewer read the 8652-line whole: 5 Blind Hunters (diff only, zero repo access), 4 Edge Case
Hunters (diff + targeted repo reads), 1 Acceptance Auditor (story + integration spec).
**146 raw findings → 129 unique** after cross-layer dedupe → **117 patched, 6 false-positives,
5 deferred, 1 dismissed**. Fixes applied in two waves — four source clusters in parallel, then four
test-hardening agents once source behaviour had settled, so every test-expectation update saw final
behaviour.

### The defects that mattered

- [x] **A live foreign lock could be deleted outright.** `releaseRunLock` (and `run-record.ts`'s
      `releaseLock`/`stealIfOwnerGone`) ran `rmSync(claimed)` unconditionally after a failed
      `linkSync` put-back. Any non-EEXIST errno — ENOSPC, EPERM, EIO, EMLINK — destroyed the only
      remaining link to a body a *live* holder still owned, so two invocations then both entered
      `teardownSandbox`: double revoke, double destroy, interleaved bundle writes. The comment
      claiming "any other errno is swept by `cleanStaleTemps`" was false — nothing swept it. Now the
      body is only removed when the put-back landed or the path was legitimately re-claimed.
- [x] **A SIGINT could strand a run's lock forever.** `installSignalRelease()` ran *after*
      `linkSync`, with `held.set` after `rmSync`+`fsyncDir` — a real `fsync(2)` wide. A signal in that
      window (or a throw from `rmSync`) left `<runId>.lock` on disk with no `held` entry and, on a
      process's first acquire, no handler at all. Every later harvest/teardown of that run refused
      permanently while the box and the OpenRouter key kept billing. Handler now installs first,
      `held.set` immediately follows the link.
- [x] **`--help` anywhere in argv made destructive commands exit 0 doing nothing.**
      `argv.includes("--help")` ran before tokenization, so `fleet teardown <id> --dir --help`
      (a `--dir` fat-fingered with no value) printed usage to stdout and exited **0** with no
      CC-9 log line. `fleet teardown … || alert` recorded success while the box stayed live.
      Help is now resolved from the parsed bool set after tokenization; that argv exits 2.
- [x] **A wedged lock was reported as retryable.** A teardown that succeeded and then failed to
      release its lock was downgraded to exit 1, which `logVerb` classifies `transient` — so
      automation retried forever, hitting `run-locked` every time. New exit **6** (cleanup failed on
      an otherwise-successful path), classified `logic`. It also no longer clobbers an already-reported
      exit 4/2. Declared in the registry and demonstrated by a test, which nothing did before.
- [x] **Minted key plaintext reached the logs.** Two sinks. `src/providers/step-log.ts` logged
      `err.message` verbatim; `src/providers/credentials.ts` had its *own* private `timed` that did
      the same and did not route through step-log at all — so hardening step-log alone did not close
      it. `deliverRunKey` puts the key on **stdin**, and an exec wrapper reporting a failed invocation
      echoes it. Both now redact through one chokepoint (`redactSecrets`, built from
      `SECRET_PREFIXES` exported from `run-record.ts`). The regression test was **verified
      non-vacuous in both directions** — red with redaction stubbed, green restored.
- [x] **A tightened `RUN_ID_RE` could take `list()` down fleet-wide.** The stricter grammar was
      applied to read paths too, and `listUnlogged` turns a filename that fails validation into a
      throw for the *whole directory*. One legacy trailing-hyphen record — creatable by any pre-diff
      build — made `fleet status` and the DF2.6 reaper's sweep return nothing at all, and made that
      record permanently unteardownable while its box billed. Strict for creation only; read/list
      paths accept the legacy grammar and report an unparseable name as a non-fatal anomaly.
- [x] **`admitIssue` could grant an uncounted second ceiling.** `INSERT … ON CONFLICT DO NOTHING`
      discarded the reservation while still returning `admitted: true` with a fresh
      `admittedCeilingMicroUsd` — a ceiling handed to DF2.3's mint that appeared in no
      `gate_admissions` row, so the next dispatch granted the same headroom again. Now checked on
      `changes === 0`; a repeated `(requestId, runId)` is idempotent.
- [x] **`fleet status <runId>` denied a live, billing, unattributed box.** `statusRun`'s ENOENT
      branch threw exit 4 before ever consulting the driver, while `statusAll` classified the same
      box `orphan`. The one query an operator types when they know the run id could not return the
      state the verb exists to surface. It now probes the driver and returns `orphan`; exit 4 only
      when neither record nor box exists.
- [x] **`link(2)` became a hard runtime dependency with no fail-closed proof.** The constructor
      probed O_EXCL, which the lock no longer uses. On a filesystem refusing hard links the store
      constructed cleanly and every run started, then the first `set()`/`close()` died with a bare
      `EPERM` — mid-lifecycle, after billable infrastructure existed. The probe now covers `link(2)`.
- [x] **Untyped throws escaped `refuse`.** Bare `throw e` on the ledger and correlation paths, and an
      unguarded `checkHeadroom` whose default `loadQuotaLimits()` throws on a malformed
      `quota-limits.json`, produced exit 1 with **no dispatch-log entry and no structured line** —
      the AC4 evidence the module's own comments say every exit owes the operator. All routed through
      `refuse` with fleet-literal codes; provider errnos moved to `payload.providerCode` so grepping
      the log for `provision-failed` no longer misses every real infrastructure failure.
- [x] **INV-6 redaction covered only `message`.** `remediation` and payload string leaves went out
      raw, and `redactUrls` skipped path segments under 16 chars. Redaction moved to the `refuse`
      chokepoint and now takes every path segment after the host.

### Themes across the patched findings

- **Comments that had drifted from the code.** A recurring shape: a comment asserting an invariant
  the code no longer delivered — `cleanStaleTemps` "sweeps" a file that was already deleted, `young &&`
  short-circuiting the corrupt-record refusal the comment still promised, `fakeGate` item D "owning"
  an assertion item B had taken over and which could no longer fail, `isOwnedVm` promising the
  opposite of what it did for untagged VMs. Each was either fixed or the comment corrected; none was
  left contradicting itself.
- **Tests that could not fail.** ~51 test findings: assertions against `join(dir,"runs")` rather than
  `store.dir` (16 sites, one store-layout change from going vacuous), `toBeDefined()` where the
  fixture always populates the field, exact-array-equality over a globally patched `setTimeout` that
  recorded every unrelated timer, a schema suite where only `repoSlug`'s required-ness was tested —
  making `commitSha` optional broke nothing. `harvest` had **no functional test at all**; the
  `invalid-run-id` refusal — the only thing between an operator positional and path construction —
  was never exercised. Test agents mutation-verified the new assertions actually go red.
- **Constants mirrored instead of imported.** `ADMISSION_GRACE_MS` and `LOCK_TIMEOUT_MS` are now
  exported and imported by their tests, *plus* a literal value-lock: deriving fixtures from the
  import alone made the tests self-consistent at any window value, which would have let a silent
  retune through. Both properties are pinned.

### False positives (reported, refuted with evidence, no code change)

| Finding | Why it was wrong |
|---------|------------------|
| `Date.parse(row.decidedAt)` is timezone-dependent | `decided_at` has exactly one writer, `cost-ledger.ts:891`, using `new Date().toISOString()` — always Z-suffixed. No `CURRENT_TIMESTAMP` writer exists. |
| Brief `repoUrl`/`commitSha` flow unvalidated into the clone | Already pinned in `brief-schema.ts`: `commitSha` to `/^[0-9a-f]{40}$/`, `repoUrl` to `.url()` + `startsWith("https://")`. Every named vector is refused at ingress. |
| `provisionAdmittedRun` writes `httpsUrl: undefined` into the record | `setLocked`'s merge starts `if (value === undefined) continue`, so the key is skipped — it can neither throw nor clobber. The conditional spread was restored anyway for shape-consistency. |
| `cleanStaleTemps` mis-parses the new six-part lock name | The parser already reads `split(".").at(-3)` — correct for both the five- and six-part shapes, and already guarded by `Number.isInteger(owner) && owner > 0`. A regression test was added regardless. |
| `LoadedManifest.resolvedPath` optional breaks consumers | Refuted against the real consumer set. |
| Bare `.toThrow()` is the only ENOENT guard | Two lines below already catch and assert `err.code === "ENOENT"`. Tightened anyway. |

### One finding that was wrong in the *fix*, caught before it shipped

`limitMicroUsd` being accepted on the manifest read path was a real gap, and the first fix stripped
it inside `loadManifest`. That is the delivery path: `scripts/pipeline-run.ts:413` reads the
delivered, **stamped** `pipeline.yaml` back through the same loader, so the strip deleted the
dispatcher's own ceiling and the engine would have run uncapped — strictly worse than the finding.
Caught by a red round-trip test and by two agents independently. The loader is neutral; the rule now
lives at the dispatch-side read, where `stampManifestLimit` follows immediately.

### Deferred (filed, not fixed here)

| Item | Why |
|------|-----|
| Releasing a *losing* admission's reservation | Two racing dispatches use different request ids, so the loser writes a real row. It is not leaked permanently — retirement keys on `run_id`, so the winner's first priced row retires both — but it double-counts one ceiling until then. Fixing properly means keying the orphan rule on the admitting request; a ledger redesign, not a review-round change. |
| `beforeRename` / `beforeStealTake` are production constructor options | Test-only hooks running inside the lock-critical section. Gating them behind a non-exported symbol changes the `RunRecordStore` constructor surface — too wide for this round. Mitigated: `expect(fired).toBe(true)` means a refactor that stops invoking them fails loudly and attributably. |
| `help` as an unregistered dispatchable verb (AC6 parity) | Both resolutions cost more than the finding: dropping the alias breaks a documented green path, registering it breaks three tests pinned to a 4-entry registry. Mitigated — `help` is now the only pre-tokenization argv read and is anchored to `argv[0]`, so it cannot fire from a stray token inside a destructive invocation. |
| Ledger-path mismatch as a library-consumer footgun | Both in-repo constructors already bind `readRunRecord` to the store whose `dir` feeds `costLedgerOpts`. The unwired default over-reserves, which is the fail-safe direction. Closing it properly needs a `gate_admissions` schema column. |
| Dropping dispatch's `as CostLedger` cast | `BudgetLedger` is now exported from `budget-gate.ts` for it; the call-site cleanup is a one-line follow-up. |

### Decisions taken (conservative/fail-safe, per standing authorization)

- **expose/setPublic stays after the setup gate**, against the integration spec's step 8. A box made
  public before the gate proves it is reachable while unproven (INV-5). Spec amended, with the
  consequence recorded: on a gate failure the record carries no `httpsUrl` and no `ports`.
- **`pipeline.yaml` is JSON-encoded by contract.** Renaming the in-box artifact is a consumer-visible
  break for an unshipped benefit; recorded rather than changed.
- **`CostLedgerError` keeps exit 5.** Nothing was provisioned on that path, so 5 is the honest
  "nothing was created" signal; re-mapping to 1 would tell automation to retry a broken ledger.
- **AC5's "six-step" and AC7's `brief.issueRef`** are stale prose — the shipped seven-step order and
  `issueId` are correct. Spec amended, code untouched.

### Verification

- `bun test` — **2507 pass, 0 fail** (81 files; 17 skip, 2 todo, all pre-existing). Up from 2444;
  `expect()` calls 9155.
- `bunx tsc --noEmit` — clean, project-wide.
- `bunx biome check` — clean across all 33 touched files.
- `detect_changes` — **CRITICAL, expected and accepted**, as in round 2: 56 changed symbols, 38
  affected processes, driven by the deliberately-touched `withLock`, `setLocked`, `assertValidRunId`,
  `timedLoggedStep` and `timed`. Every affected process is in `providers`/`phase-engine`/`scripts`/
  `fleet`; no fallout in `hindsight/`, `swarmclaw/` or `cli-anything/`.
- Pre-existing nit left alone: a duplicated `DD-9` doc comment at `cost-ledger.ts:61-62` is present
  in `main` and is not part of this PR's diff.

## Review round 4 — BMAD adversarial code review, 2026-08-22

**13 review layers** against the PR #123 diff, chunked by file cluster (≤1547 diff lines each) so no
reviewer read the 12,095-line whole: 5 Blind Hunters (diff only, zero repo access), 4 Edge Case
Hunters (diff + targeted repo reads), 3 test-quality reviewers (vacuity + coverage hunting), 1
Acceptance Auditor (story + integration spec, grepped not read whole).
**~96 raw findings → 58 unique** after cross-layer dedupe → **46 patched, 5 false-positives,
7 deferred**. Fixes applied in two waves — eight source clusters in parallel, then four
test-hardening agents once source behaviour had settled, so every test-expectation update saw final
behaviour. Suite went 1579 → **1660 pass / 0 fail** (81 net new tests).

### The defects that mattered

- [x] **A legitimate repo slug permanently burned the issue's budget cap.** `assertNoSecret`'s
  key-shape heuristic (`length >= 40 && mixedClass && /^[A-Za-z0-9+\/=_.:-]+$/`) fires on any repo
  slug ≥40 chars with mixed case and a digit — every character a slug may legally contain is inside
  that charset. Reproduced with `BiosparkHealth/QDS-Factory-Pipeline-Engine2` (43 chars). It threw
  on the `extensions.budget` write, which happens *after* `store.create`, so the record existed and
  **resolved** — and a resolving record is never expired by the ledger's orphan guard, while only a
  priced `cost_event` retires a reservation. Every retry burned another reservation until the cap
  was exhausted with no box ever created. Fixed with a path-keyed exemption
  (`extensions.budget.repoSlug`, `.issueId`, `keyHash`); the heuristic stays fully active elsewhere.
  [src/providers/run-record.ts:275]
- [x] **A dispatch retry was refused by its own reservation.** `admitIssue`'s reserved-rows query
  summed *every* `gate_admissions` row for the issue including the caller's own, so on a retry the
  over-budget check fired before the `ON CONFLICT DO NOTHING` replay branch could run. With the
  default config (cap 5M < keyCap 50M) the first admission always reserves the whole cap, making the
  idempotency branch **dead code**; when it was reachable it returned
  `admittedCeilingMicroUsd > remainingMicroUsd`. Now excludes the caller's own `(request_id, run_id)`
  — exactly the PRIMARY KEY, so a different correlation id still sees the reservation.
  [src/providers/cost-ledger.ts:854]
- [x] **`sandbox-teardown` settled money into a different ledger file than `dispatch` reserved it
  from.** It constructed `new CostLedger({readRunRecord})` with no path, falling back to the
  cwd-relative `.sandbox/cost-ledger.db`, while `fleet.ts` resolves `dirname(store.dir)/cost-ledger.db`.
  For any non-default `--dir`, box-hours landed in one ledger while the reservation stayed open
  forever in the other. Both CLIs now share one `costLedgerOpts` helper.
  [scripts/lib/cost-ledger-opts.ts, scripts/sandbox-teardown.ts:200]
- [x] **A failed lock write wedged the run permanently.** `writeLockDirect`'s O_EXCL create succeeds,
  then an ENOSPC/EIO on `writeFileSync`/`fsyncSync` left a 0-byte lock nothing removes. `refuse()`
  parses `""` as "holder unknown", which is never marked stale, so every later harvest/teardown
  refused forever while the box and key kept billing — a straight regression from the cleanup this
  PR deleted from `sandbox-teardown.ts`. Cleanup restored, original errno preserved.
  [scripts/lib/run-lock.ts:330]
- [x] **Lock refusals told automation to retry forever.** `RunLockedError` is not a `FleetError`, so
  `report()` returned 1 — which `logVerb` stamps `transient`. Both the live-holder and the *stale*
  case (dead holder, nothing will ever clear it) said "retry me". Now exit 5, declared on `harvest`
  and `teardown`. [scripts/fleet.ts:723, src/fleet/verbs.ts:83]
- [x] **`fleet status` reported a clean fleet during a substrate outage.** `listOwnedBoxes` swallows
  every throw to `null`, and the `boxUnknown` signal only ever attached to *open* records — so with
  zero records, or only closed ones, a failed `driver.list()` produced exit 0 with clean stdout,
  byte-identical to a healthy empty fleet. Now emits a `{runId:"(fleet)", state:"listUnavailable"}`
  row and exits 1. [src/fleet/status.ts:247]
- [x] **`manifestPath` accepted absolute paths.** Only `..` was refused, but
  `resolve(repoRoot, "/etc/shadow")` discards the root entirely — an absolute path escapes with no
  `..` segment at all, and the test suite actively *pinned* the acceptance. A schema with no repo
  root cannot do resolve-then-contain, so relative-only **is** the containment check. NUL bytes and
  backslash-parent segments now refused too. INV-2's dispatch-side realpath gate keeps its coverage
  via a symlink escape (relative + no-`..` passes the schema; `readBeneathRoot` still refuses it).
  [src/fleet/brief-schema.ts:50]
- [x] **`repoSlug` and `repoUrl` were attacker-separable.** `repoSlug` keys the ledger, the per-issue
  cap, the dispatch log and `run-context.json`; `repoUrl` is what gets cloned and executed. Nothing
  required them to describe the same repository. Now cross-checked (URL path, `.git` stripped, must
  equal the slug) with **no host allow-list** — self-hosted forges stay legitimate. *This is the one
  change in the round that can reject a brief which previously validated.*
  [src/fleet/brief-schema.ts:238]
- [x] **Plaintext key could reach the log via the abandoned-step handler.** When `within("deliver")`
  exceeds the wall-clock budget, the race has already rejected with the timeout, so the fixed-message
  catch never sees the provider error — the abandoned handler does, and `redactUrls` only matches
  `https?://`, so a bare token passed through. Now runs through `redactSecrets`.
  [src/fleet/dispatch.ts:730]
- [x] **Redaction erased the one identifier an operator needs to revoke a live key.** `LONG_TOKEN_RE`
  swallowed the whole `…/keys/<44-char keyHash>` URL in `revoke-failed`'s message *and* its
  `curl -X DELETE` remediation, leaving only an 8-char prefix — while the key was still live and
  billing. A key hash is not key material; it now survives via a `keep` parameter.
  [src/providers/credentials.ts:460, src/providers/step-log.ts:65]
- [x] **The logger threw from inside its own catch.** `redactSecrets(err.message ?? String(e))`
  assumed a string; a rejection carrying a structured `message` produced
  `TypeError: text.replace is not a function`, which escaped the catch — so the log line was never
  written and the original failure was *replaced*. Coerced at the redactor, fixing all four sinks at
  once. [src/providers/step-log.ts:56]
- [x] **AC9b was implemented write-side only.** Dispatch wrote `effectiveCeilingMicros` into
  `run-context.json`, which has **zero consumers** repo-wide — the in-box entrypoint built its
  context from three literals — so `dispatch-task.ts` forwarded `undefined` and every real run
  spawned at the $0.50 harness default. Closed by reading the ceiling from `manifest.limitMicroUsd`
  (already validated, already gate-checked) rather than adding a second parse of the same number.
  [scripts/pipeline-run.ts]
- [x] **`reapRuns` went fail-open.** `list()` degrading from throw to log-and-skip dropped a
  bad-filename record out of the reaper's `claimed` set, so a live box belonging to an open record
  could be destroyed. `list()` now exposes `listWithAnomalies()`; the reaper refuses to treat an
  incomplete listing as authoritative. [src/providers/run-record.ts:508, src/providers/driver.ts:656]
- [x] **Permanent cap erosion on a failed budget write** (`store.create` succeeds, `store.set` throws):
  the record now resolves with no `extensions.budget`, so nothing ever retires the reservation. The
  just-created record is now removed so the orphan guard can expire it — safe, since `driver.create`
  has not run and nothing billable exists. [src/providers/driver.ts]
- [x] Provider calls had **no timeouts** — a hung `create`/`expose`/`setPublic` meant dispatch never
  returned and the reservation counted against the cap indefinitely. Bounded with the existing
  `withTimeout` helper. [src/providers/driver.ts:305]
- [x] **Refusals advertised `teardown` for runs that were never provisioned** — and on the
  mint-collision path, for a *different live run's* id. Gated on actual provisioning.
  [src/fleet/dispatch.ts:648]
- [x] `ADMISSION_GRACE_MS` compared a **foreign wall clock** to the local one; a reader >60s ahead
  classified live reservations as orphans and granted the headroom twice. Clamped with a skew margin,
  fail-closed. [src/providers/cost-ledger.ts:83]
- [x] Locks were stranded on **SIGHUP/SIGQUIT/uncaught throw/`process.exit()`** (only SIGINT and
  SIGTERM were handled), and the release rescue temp shared the `.tmp` shape **two** independent
  reapers sweep — including `RunRecordStore`'s constructor, which runs *before* the lock is taken.
  [scripts/lib/run-lock.ts:137, :499]
- [x] `putBack` could not deliver the protection its comment claimed: whenever the lock path was
  vacated and `putBack` failed for any non-EEXIST errno, mutual exclusion was already lost — silently,
  from inside a `finally`. Release now reads-and-returns without vacating; the steal path is loud.
  [src/providers/run-record.ts:990]
- [x] A successful `teardown` piped to `head -1` reported **failure** (EPIPE → exit 1 → `transient`),
  so automation retried a destructive verb that had already succeeded. [scripts/fleet.ts:428]
- [x] `stripAuthoredLimit` was a **dead export** with dispatch keeping a hand-rolled copy that had
  already diverged (the export `deepFreeze`s, dispatch's did not). Deleting dispatch's two lines
  would have removed the AC9a money guard while the manifest test stayed green. One rule, one
  implementation now. [src/fleet/dispatch.ts]
- [x] `SetupGateOptions.requestId` **exists** and is emitted on every gate log line, but dispatch did
  not forward it — on the stated grounds that the field did not exist. INV-4-bis was failing on gate
  lines. One-line fix. [src/fleet/dispatch.ts:1374]
- [x] Also patched: swallowed `ledger.close()` failure (money, now surfaced); unguarded success-path
  and `refuse`-catch writes that could kill the process from inside a timer callback; `redactUrls`
  mangling the host it claims to preserve while short userinfo survived; `httpsUrl` written after
  `setPublic` (and a box made public with no URL); `createRun`'s second live admission call site;
  untyped port refusal; `httpsUrl` return/record divergence; `withLock` busy-spin; per-entry
  `newRequestId` churn in `fake-driver.list()`; unbounded string fields and control characters at
  the trust boundary (log injection via `requestId`); case-sensitive `https://` over-rejecting valid
  input; `statusRun` rethrowing corrupt-record errors raw while its siblings typed them; closed rows
  conflating "confirmed destroyed" with "could not ask"; `RunRecordStore` construction not wrapped in
  `asUsage`; the key client built before brief validation (AC1 named the wrong field); empty-string
  and duplicate boolean flags; the CC-9 log line recording a flag *value* as the verb.

### Test-quality repairs

The three test-quality reviewers found the suite was green in places it should not have been:

- [x] A **tautological assertion** — `expect(err.payload?.runId).toBe(err.payload?.runId)` — passed
  on `undefined === undefined`, i.e. it held even with no `runId` at all, which is the bug its own
  comment said it pinned. [tests/fleet/dispatch.test.ts]
- [x] The **idempotency test could not fail for the bug it named**: the fixture made the recomputed
  ceiling equal the recorded one, and `reservedMicroUsd` is read *before* the INSERT, so neither a
  missing replay nor a double-insert was detectable. [tests/providers/cost-ledger.test.ts]
- [x] The `store.create` **EEXIST arbiter** (the authoritative `run-id-in-use` path) had no test —
  deleting it left the suite green while a fan-out loser got exit 1 after committing a reservation.
- [x] **`vmName ≠ runId` was never constructed**, leaving three real `status.ts` branches dead in
  test; the fleet-list filter, the name join, and the orphan-claim guard were all freely mutable.
- [x] **Harvest's lock acquisition was never proven**, only its absence afterwards — the obvious
  "harvest is read-only, why lock it" refactor would have shipped green.
- [x] **Repeat teardown** was never exercised, so the CLI telling an operator it destroyed a box that
  was gone hours ago was unpinned; likewise zero-ceiling admission, post-box failure paths, the
  dispatch log's *contents* (only its non-contents were asserted), and four refusal codes.
- [x] The registry-parity scan's regex could not see `teardown` at all (it is the `else` arm), so it
  ran over 3 of 4 shipped verbs while promising to cover all of them.
- [x] `renderHelp`'s required/optional rendering passed with the ternary **inverted** (the only
  fixture flag was `required: true`), and `--help`-eats-the-next-token was satisfied by both
  hypotheses.
- Every added or repaired test was **mutation-checked**: the targeted source behaviour was reverted
  in an isolated copy and the test confirmed RED, then restored (verified byte-identical).

### False positives — pushed back, no change made

- [x] **`SETTABLE_FIELDS` / `requestId`** — alleged to be a hand-listed set missing the new field.
  It is derived: `Object.keys(CORE_FIELDS).filter(f => !IMMUTABLE_FIELDS.has(f) && f !== "closedAt")`,
  and an existing test already loops every entry through `store.set`. The flagged hunk was
  comment-only.
- [x] **`AKIA…`-style keys pass redaction verbatim** — wrong. The `SECRET_PREFIX_RE` arm is
  unconditional and class-independent; executed:
  `redactSecrets("creds AKIAIOSFODNN7EXAMPLE here") → "creds «redacted» here"`. Only the *unprefixed
  all-lowercase-hex* case is real, and it is now documented with its escape hatch rather than fixed
  by loosening the predicate (which would redact every git SHA in the logs).
- [x] **Empty-string and `--`-prefixed flag values slip through** — both refused by `tokenizeArgs`
  before the named check is reached: `--dir ""`, `--dir=` and `--driver --no-harvest` all throw
  `requires a non-empty value`.
- [x] **AC9b needs a `phase-lifecycle.test.ts` change** — that test's ctx comes from a local object
  literal, never from `pipeline-run.ts`; it asserts the *engine* never defaults the field, which
  stays true.
- [x] **Unpriced spend should count against the cap** — deliberate, rationale recorded in-file and in
  commit `e0fbdf4` ("Sift's refuse-on-unpricedRows suggestion rejected: AC4 pins surfacing, not
  blocking"). Left as-is.

### Deferred — real, out of scope for this round

- [x] **Mid-flight expiry at the `create` step can still materialise a billable box after the
  operator has torn the run down.** `within` abandons rather than cancels; a proper fix needs an
  AbortSignal at the driver seam (DF3.2 scope). This round only fixed the remediation wording, and
  gated it on `ctxProvisionAttempted` so it is not shown for the pre-check arm where nothing ran.
- [x] Roster-existence TOCTOU between step 3 and step 9 — needs gate-side handling.
- [x] `restore()` has no O_EXCL fallback, and the `onDisk !== body` branch has no coverage: it needs
  the lock re-claimed between two adjacent synchronous `fs` calls in one tick. Documented honestly in
  the test rather than shipping a flaky or clever one.
- [x] The `is mode 0755, not 0700` store branch is unreachable from a test — the constructor
  `chmodSync`es *before* it verifies, so a loose directory is repaired, not refused. The ELOOP and
  ENOTDIR shapes share the same classifier and pin it.
- [x] `acquireRunLock`'s retry-that-*succeeds* branch — needs a real microsecond race; the dangling
  symlink fixture covers the ENOENT hand-off and the terminal refusal, but cannot distinguish one
  attempt from two.
- [x] No dry-run/confirmation on `teardown`, and `fleet not-a-verb --help` exiting 0 — both
  deliberate design points.
- [x] Two `run-record` tests burn the 5s lock timeout in real wall clock (~10s of suite time). Flake
  surface, not a defect.

### Gates

- `bun test tests/fleet tests/providers tests/phase-engine tests/scripts` → **1660 pass, 2 skip,
  2 todo, 0 fail** across 49 files (baseline before this round: 1579 pass).
- `bunx tsc --noEmit` → clean, exit 0, repo-wide.
- `bunx biome check` → clean across 161 files, no fixes applied.
- `gitnexus detect_changes` → 67 changed symbols / 49 affected processes. Every affected process is
  in `providers`/`fleet`/`phase-engine`/`scripts` — `CreateRun`, `TeardownRun`, `ReapRuns`,
  `RunCredentialLifecycle`, `HarvestRun`, the CLI `Run`, pipeline `Main`. No fallout in `hindsight/`,
  `swarmclaw/` or `cli-anything/`. **Note:** the index is stale for this branch — it returns
  `Target not found` for every DF3.1 symbol and surfaces story-file headings as `driver.ts` symbols,
  so the `critical` risk label reflects breadth, not a verified regression. Reindex with
  `bash scripts/install-gitnexus-plus.sh` before the next round's `impact` calls are meaningful —
  or `GITNEXUS_SKIP_INSTALL=1 bash scripts/install-gitnexus-plus.sh` to re-analyze against the
  already-installed GitNexus without reinstalling it. Never a bare `gitnexus analyze`: it skips the
  transient `.gitnexusignore` negation and drops the test fixtures from the graph (CLAUDE.md, #46/#47).

## Review round 5 — BMAD adversarial code review, 2026-08-22

12 reviewers over a 10-chunk split of the branch diff (blind adversarial ×4, edge-case hunter ×5,
acceptance auditor ×1, test-quality ×3; no chunk over 2022 lines). ~150 raw findings → 96 after
dedupe. 88 patched, 5 dismissed with evidence, 1 deferred, 3 decision-needed resolved
conservatively. Fixes landed as 7 parallel source clusters, then 7 parallel test clusters once
source behaviour had settled.

### The defects that mattered

- [x] **`usdToMicros` threw on ordinary float USD, and the cost row was then never written.**
  `Number.isSafeInteger(usd * 1e6)` ran BEFORE `Math.round`, so `1.005` → `1004999.9999999999` →
  throw. The throw escaped `ingestCostEvent` (whose `costInvalid` covers only non-finite/negative),
  so **no row was persisted at all** — unrecorded spend against a cap that could no longer see it,
  which AC4 and the function's own docstring both claim is impossible. Now rounds first, validates
  the rounded value, and a conversion failure persists at `0 µ$` / `unpriced = 1` with the reason on
  the ingest log line rather than losing the event.
- [x] **Replay handed back a ceiling larger than the headroom that remained.** The reservation query
  excludes the replaying run's own row, so with cap 100 / keyCap 10: A admits at 10, B reports 95
  priced, replaying A returned `admittedCeilingMicroUsd = 10` against `remainingMicroUsd = 5` —
  breaking the invariant its own comment asserts, and handing 10 straight to the key mint. Now
  clamped to the lower of the two.
- [x] **A NULL correlation bind voided the entire reservation predicate.** `NOT (a.request_id = ?
  AND a.run_id = ?)` evaluates to NULL under SQL three-valued logic when either bind is NULL, and a
  NULL `WHERE` term drops the row — so *every* outstanding reservation vanished and the admission
  was granted the whole remaining cap on top of every live one. Fixed at both layers: a non-string
  or empty correlation key is refused up front (`admission-input-invalid`), and the SQL is now
  NULL-safe (`IS`, not `=`) so the predicate cannot be re-opened by a future caller.
- [x] **`issueId` was never canonicalized while `repoSlug` now is** — the same cap-bypass class the
  repo-slug work closed, left half-done on the other half of the composite key. `42`, `#42`, `042`
  and `42 ` each drew an independent full cap. Proven end-to-end in test: cap 5 µ$ / keyCap 2 µ$,
  four spellings now draw `2, 2, 1` and the fourth is refused; unfolded, all four took 2.
- [x] **An ungrammatical `runId` in `gate_admissions` wedged an issue's cap permanently.** The budget
  gate runs before `assertValidRunId`, so the row lands; every later `admitIssue` then threw out of
  `readRunRecord`, and `gate_admissions_no_delete` blocked the manual remedy. A throw for a row past
  the grace cutoff now expires that reservation (named on a structured line); a throw for a young
  row still fails closed.
- [x] **`list()` kept its fail-open signature after `listUnlogged` changed to skip-and-continue**, so
  every caller silently inherited it — including `reapRuns`, which builds its destroy-claim set from
  it. A `Run-1.json` holding a valid OPEN record with a `vmName` meant the reaper destroyed a live
  box. `list()` now refuses when anything was skipped; the anomaly channel is the opt-in, not the
  safety.
- [x] **The same fail-open existed driver-side and on the real substrate.** `driver.list()` had no
  anomaly channel at all, and `exedev`'s `list()` silently dropped any entry whose `vm_name` was not
  a string. Both now report skipped identifiers; `reapRuns` and `sweep()` refuse on them.
- [x] **`writeAll` lacked both guards its own sibling `writeStderr` already had.** On a non-blocking
  fd (ordinary in CI), `writeSync` returns 0 → infinite loop while the run lock is held and the box
  bills; or raises EAGAIN → a *completed* destructive teardown reported as exit 1 `transient`, which
  automation retries.
- [x] **Output failures could rewrite a completed verb's exit code.** The final `return logVerb(...)`
  sat outside every `try`, and both cleanup `finally` blocks wrote through the raw writer rather
  than the EPIPE-tolerant `emit` — so a broken pipe discarded an exit `6` ("wedged, do not retry")
  and produced exit 1. Conversely `emit` was swallowing EPIPE for the **dispatch ack**, whose runId
  is the only stdout handle on a live billing box: `fleet dispatch | head -0` exited 0 and orphaned
  it. Now exit `6` with an `ack-unwritable` envelope.
- [x] **The cross-process lock could wedge a run against itself, or free a lock a live process
  held.** A spurious `EEXIST` from `link(2)` (NFS retransmit) left `held` unpopulated, so `refuse`
  found our own pid and threw "wait for that invocation to finish" — forever. Any *other* errno fell
  through to `writeLockDirect`, which then collided with the lock it had just created. `restore()`
  had no fallback on the no-hard-link filesystems `claim()` exists to support, and told the operator
  to `mv` a rescue copy over a live third holder's lock on EEXIST. Liveness now fails closed
  throughout: unknown-host and pre-host bodies are never classified stale, `reapStaleTemps` applies
  the host check `refuse` already did, and an out-of-range pid is not read as "dead".
- [x] **Secrets could reach the operator stream through three unguarded paths.** `redact()` did not
  compose `redactSecrets`, so a schemeless `sk-or-v1-…` in a zod issue message, a `CorrelationError`,
  or a box-controlled gate assertion `note` landed verbatim in `.sandbox/dispatch-log.jsonl` and the
  structured line. Neither the `credentials.ts` nor the `step-log.ts` sink composed
  `redactKeyManagementUrls`, and `redactSecrets` structurally could not catch the URL `http()`
  builds (`encodeURIComponent` turns the hash's `+/=` into `%2B%2F%3D`, whose `%` is outside the
  token charset). Composed once at the shared redactor so all three sinks — plus dispatch's — are
  covered by one edit.
- [x] **`redactSecrets` was destroying ordinary diagnostics.** Its long-token arm swallowed any
  `/Users/...`-rooted or CamelCase path containing a digit, because `/`, `.` and `-` are all inside
  its charset. Paths and stack frames are now exempt, with each `/`-delimited segment re-tested so a
  secret sitting *inside* a path still redacts.
- [x] **A brief that the schema owned was only refused after a box was billed.** URL fields skipped
  the control-character guard (WHATWG `URL` strips tab/LF/CR *before* parsing, so
  `https://git\nhub.com/o/r` satisfied `.url()`, the scheme regex AND the slug cross-check) and
  accepted userinfo, so `https://x-access-token:ghs_…@github.com/o/r` passed every check. The roster
  path's charset and the roster's own readability were likewise enforced by the gate, at step 9,
  with the record OPEN and the box alive — INV-5 forbids tearing that box down. All now refuse at
  exit `2` before an admission is spent.
- [x] **`provisionAdmittedRun` could publish a box nobody could address.** With a driver reporting no
  `httpsUrl` and an `expose` resolving `undefined`, the conditional spread wrote nothing and
  `setPublic` still ran — and `setLocked` has no way to record it later. Now refuses `expose-no-url`
  before publishing. Its three `withTimeout` refusals also threw bare `Error`s — the exact
  unclassified shape `ProvisionRefusedError` was added to prevent — and are now typed.
- [x] **The authored manifest was a host-readable cap source.** `manifest.ts` guaranteed "nothing
  HOST-side reads this field", but `runContextFrom` forwarded `limitMicroUsd` into
  `effectiveCeilingMicros` unvalidated. Stripping was not an option — a stamped and an authored value
  are byte-identical — so the runner now reconciles the manifest's declared cap against the
  `run-context.json` dispatch wrote beside it, read through `readArtifactBeneathRoot` and anchored on
  `loadManifest`'s verified `resolvedPath`.
- [x] **AC9's stamp was the requested cap, not the minted one.** `mintRunKey` never asserted the
  provider honoured the request, so the record carried the real key ceiling while `pipeline.yaml`
  and `run-context.json` carried the ask. Now stamped from the record, with a `mint-cap-differs`
  line when they diverge.
- [x] Relocating the records directory silently relocated — and could silently share — the money.
  `dirname(storeDir)` put the ledger in a directory the operator never named, made a relative
  `--dir` cwd-dependent, and gave `/srv/runs-prod` and `/srv/runs-staging` **one** ledger. An absent
  cost config also substituted built-in caps with nothing said; it now says so.

### Defects found by the test wave, in code the review wave had cleared

- [x] The offending field name is attacker-chosen, and `dispatch.ts` escaped it in the message
  (`JSON.stringify(field)`) but interpolated it **raw** in the very next line's remediation — and
  zod's own `Unrecognized key(s) in object: '<raw>'` rode into `payload.issues` unescaped too. A key
  like `a\nFLEET dispatch ok runId=fake` forged a whole log line. All three now escaped.
- [x] `requestId: ""` parsed. It is the one value that is neither absent nor usable: falsy, so a
  downstream `requestId || mint()` reads it as absent while `!== undefined` reads it as present —
  collapsing concurrent runs onto one empty correlation key. Now `.min(1)`.
- [x] `\p{Cc}` reaches C0/DEL/C1 and stops, missing U+2028/U+2029 (JS line terminators — the exact
  log-forging threat the guard's docblock names) and U+202E (bidi override, which reorders what a
  terminal renders without changing a byte). Widened to `\p{Cc}\p{Zl}\p{Zp}\p{Cf}`.
- [x] `holdRunLock`, the fixture used to simulate a *foreign* live holder, wrote `process.pid` — but
  `claimedByUs` now refuses our own pid+host as `run-lock-reentrant` before contention is ever
  classified. The fixture had been probing re-entrancy while claiming to probe contention.

### Test-quality repairs

The suite was green throughout and proved less than it appeared to. Notable:

- [x] The live-holder and stale-lock tests could not tell the two apart — `RunLockedError.message` is
  **identical** on both branches and only `remediation` differs, which nothing asserted. Gutting
  `isAlive()` to `return false` — telling an operator to `rm` a lock a running teardown holds —
  passed both. Now pinned on both branches, in both files, and mutation-verified.
- [x] No test raced two real lock acquirers; every "held lock" was a file the test wrote first, so
  replacing the atomic `linkSync`/O_EXCL with `existsSync` + `writeFileSync` passed everything. The
  replacement runs four processes for 60 rounds and checks mutual exclusion from *inside* the
  critical section — the first version, which counted winners of one simultaneous round, passed the
  mutation because start jitter serializes them.
- [x] Signal lock-release was entirely uncovered — the only signal in the file was an uncatchable
  `SIGKILL`. `claim`'s `writeLockDirect` fallback was untested despite being the live path on
  FUSE/overlay/exFAT/SMB and several macOS Docker bind-mounts. Every lock fixture used the legacy
  3-field body, so the modern same-host classification was never exercised at all.
- [x] The second-teardown test **asserted the bug its own comment condemns**, pinning
  `torn down: <id>` for a box gone for hours — a ratchet that would have failed any implementation
  distinguishing the idempotent re-run. It now asserts what must hold regardless (exit 0, `closedAt`
  unchanged, billed exactly once, lock released) and the message is deliberately not pinned.
- [x] `roster-missing` had zero coverage and was unreachable under every fixture; the exported
  `closeThrowsLedger` and `admitThrowsLedger` were imported nowhere; `perIssueOverrides` was `{}` in
  every fixture so the override branch never ran; `mintRunKey` was never asserted to be called with
  the right key *name*, only the right limit.
- [x] The INV-1 ordering assertion used `indexOf` on a repeated `sh-exec` label, so moving the
  manifest fill *after* the gate still satisfied the subsequence the test exists to prove.
- [x] Two genuinely concurrent dispatches on one runId now run with a real store: exactly one
  fulfilled, one exit `2` `run-id-in-use`, one record, one box — and on a shared ledger,
  `admitCalls === 2`, which pins the double-admission window as a live tripwire.
- [x] Gate probe B's unreadable-manifest arm was `if (process.getuid?.() !== 0)`, so it vanished
  green under root Docker CI instead of reporting skipped.

### False positives — pushed back, no change made

- **`dispatch`'s `CostLedger` is never closed.** It is, in a `finally` in `dispatch.ts`, and a test
  pins `closeCalls === 1`. The "fix" was built, found to double-close, and removed — a second
  `close()` on a `bun:sqlite` handle throws unconditionally, so the patch would have been the
  regression.
- **SQL `lower()` vs JS `toLowerCase()` diverge on Unicode.** `canonicalRepoSlug` is
  `replace(/[A-Z]/g, …)` — ASCII-only *by construction*, deliberately, to match SQLite. Probed both
  against SQLite `lower()` on the exact characters named: 0/7 divergences, where a naive
  `toLowerCase()` would have diverged on 4/7.
- **`no-ceiling` refusals pile up reservations.** Unreachable: `admitIssue` refuses a non-positive
  cap before writing and returns `admitted: false` unless headroom remains, and dispatch never passes
  `keyCapMicroUsd`, so it is a positive literal. The check also cannot move earlier — it tests the
  commit's own output.
- **`httpsUrl`/`vmName` outside `redactDeep`**, and **`ports:[port]` written before `expose`** — both
  documented-deliberate, and the second is the correct direction: under-reporting a live public box
  hides it from port-keyed reapers, which is worse than over-reporting one.
- **Provider `code` becoming `FleetError.code`.** `providerCodePayload`'s docstring targets
  infrastructure errno codes leaking from generic catches; `CorrelationError` and `CostLedgerError`
  are first-party closed tables.
- **3-arity `dispatch(brief, deps, opts)` vs the spec's 2-arg shorthand** — the shorthand elides the
  DI surface; there is no other way to inject `driver`/`store`/`keyApi`/`ledgerFactory`. Spec text
  corrected instead.

### Decisions taken (conservative / fail-safe, per standing authorization)

1. **AC1 vs the `requestId` guard — kept the guard**, amended AC1. A 128-char cap and a
   control-character refusal are a log-injection defence at a trust boundary, not a format rule.
2. **AC4 vs the orphan probe — kept the code**, amended AC4 (the amendment round 3 made to behaviour
   but not to text). A live box with no record is unattributed spend; hiding it behind exit `4` is
   worse than a driver call on that path.
3. **Exit `6` — kept it**, added it to the table. Collapsing it into exit `1` `transient` recreates
   the retry-a-destructive-verb loop it exists to prevent.
4. **Duplicate per-issue override keys — refuse at load**, rather than taking the lower. Taking the
   lower silently ignores a line an operator added to *raise*, exactly as insertion order ignored one
   added to lower.
5. **A12 (concurrent same-`runId` double admission) — accepted as a residual, not patched.** The
   earlier read that the loser's reservation is burned permanently was wrong: the query excludes
   every row whose `run_id` has priced spend, and the loser shares a `run_id` with the winner, so
   both clear as soon as the winning run reports. The interim state over-reserves, which
   *under*-grants the cap — the fail-safe direction the module explicitly chose. An expiry keyed on
   `closedAt` was built and discarded: `teardown.ts` closes the record ten lines before it writes
   `box_hours`, so it would trade a safe failure for an unsafe one. The genuinely permanent case —
   a winning run that closes without ever reporting priced spend — is now watched by the
   `admitCalls === 2` tripwire in `dispatch.test.ts`.

### Deferred — real, out of scope for this round

- `store.create` takes only an id, so a record exists with no `requestId` for the duration of
  `driver.create()`. The real fix widens the signature to `(runId, requestId)`.
- No object- or array-shaped brief field exists, so there is no target for depth/element-count
  bounds. Revisit when the first one lands.
- The exit-code excuse list binds to a test *title*, so a hollowed-out body stays green (rename and
  `test.skip` both go red, which is the failure mode that actually shipped).
- The NULL-safe reservation SQL has no reachable runtime path (`NOT NULL` columns plus the up-front
  guard), so it is pinned as a source-text drift lock rather than a behavioural test. If a caller
  that can bind NULL is ever added, that assertion should be replaced with a real one.

### Gates

- `bun test tests/fleet tests/providers tests/phase-engine tests/scripts` → **1768 pass, 2 skip,
  2 todo, 0 fail** across 49 files (baseline before this round: 1684 pass). Two known wall-clock
  flake surfaces observed under full-suite load and green in isolation on every rerun:
  `setup-gate.test.ts`'s sub-second timing case, and `usage.test.ts`'s repo-scanning cases hitting
  Bun's 5 s default.
- `bunx tsc --noEmit` → clean, exit 0, repo-wide.
- `bunx biome check` → clean across 304 files, no fixes applied.
- `gitnexus detect_changes` (index reindexed at HEAD first, so this round's `impact` calls were
  meaningful — round 4's were not) → 496 changed symbols / 89 affected, labelled `critical`. The
  label is breadth: 65 of the "changed symbols" are markdown headings from `_bmad-output` docs.
  Every affected process roots in `fleet`/`providers`/`phase-engine`/`scripts` — `Run`,
  `ProvisionAdmittedRun`, `RunCapHitDemo`, `RunCredentialLifecycle`, `ReapRuns`, `TeardownRun`,
  `HarvestRun`, `Dispatch`, `StatusRun`, `SetupGate`. **Zero** affected symbols outside
  `src/{fleet,providers,phase-engine}`, `scripts/` and `tests/` — no fallout in `hindsight/`,
  `swarmclaw/` or `cli-anything/`.

## Review round 6 — BMAD adversarial code review, 2026-08-22

15 chunked review agents over a 19-chunk split (no chunk >1896 lines): 4 blind, 4 edge,
1 acceptance auditor, 6 test-quality. ~110 raw findings → 78 unique after cross-layer
dedupe. 8 source fixers + 3 test fixers on disjoint file clusters. Nine bot findings
(Sift) folded into the same triage.

**Gates:** fleet 350 / providers 640 / phase-engine+scripts 873 = **1,863 pass, 0 fail**
(was 1,768). `tsc --noEmit` exit 0; biome clean across 39 changed files.
`detect_changes`: 224 changed symbols, 77 affected processes, every entry point inside
DF3.1's own surface (`Dispatch`, `StatusAll`, `StatusRun`, `HarvestRun`, `ReapRuns`,
`Sweep`, `ProvisionAdmittedRun`, `SetupGate`, `DriverListing`, `WithLock`, `Within`).
Zero symbols outside `src/{fleet,providers,phase-engine}`, `scripts/`, `tests/`.

### Money-path defects (the round's centre of gravity)

- [x] **A zero-cost PRICED row retired the whole reservation.** The `NOT EXISTS` guard
  tested for the existence of a priced row, not for spend. A first turn reporting
  `{costUsd: 0, unpricedTurns: 0}` — a cached or free turn — dropped the run's entire
  ceiling out of `reservedMicroUsd` while it still held a live key at that ceiling, so
  the next dispatch was granted the full cap again. ~2× overspend, N× for N dispatches.
  Now requires `ce.cost_micro_usd > 0`.
- [x] **Closed-record retirement** added alongside it. Without it the fix wedges any run
  that genuinely costs 0 µ$ forever, because `gate_admissions_no_delete` leaves no manual
  exit. Beyond the literal brief and deliberately kept: strictly more conservative than
  the old "any priced row retires".
- [x] **`issue_id` was canonicalised on the BIND side only.** The slug folded on both
  sides (`lower()` column + `canonicalRepoSlug` bind); the issue id folded only on the
  bind. Every row already on disk spelled `#42` / `042` / `42 ` became permanently
  unmatchable — spend vanished from `spentMicroUsd`, `readIssueCost`, `readIssueRuns`,
  silently UNDER-counting the cap. No migration is possible: `cost_events` and
  `gate_admissions` both carry `BEFORE UPDATE`/`BEFORE DELETE` triggers that `RAISE(ABORT)`
  under INV-COST-1. Fixed with a shared `issueScopeSql()`/`issueScopeKeys()` pair used by
  all five predicates, raw equality first so canonical rows still hit the index.
  Documented residual: SQLite `trim()` is ASCII-only, so a `U+00A0`-padded legacy id
  stays unmatched.
- [x] **The provider-minted cap was adopted with no upper clamp.** `mintRunKey` requests
  `effectiveCeilingMicros` but persisted the provider's own answer, checked only for
  null/finite/positive, then stamped it into `pipeline.yaml` and `run-context.json`. A key
  API returning MORE than requested authorised the box to spend above what the ledger
  reserved — and it logged as `status:"ok"`, invisible to alerting. Now
  `Math.min(...)`, and an over-mint logs `status:"error"` / `mint-cap-over-request`.
- [x] **AC9b was fail-open in the direction the bug actually shipped.** `runContextFrom`
  consulted the witness only when the manifest DECLARED a limit, so a witness carrying
  `effectiveCeilingMicros: 250_000` beside an unstamped manifest was never read and the
  run spawned at DF1.6's $0.50 default — twice what the ledger reserved. Now consulted
  whenever a witness is present. Uses `lstatSync`, not `existsSync`: `existsSync` follows
  symlinks and reports a DANGLING one as absent, which would let an author hide a
  ceiling-lowering witness behind a broken link.
- [x] **The ledger path depended on the caller's CWD.** `dir === resolve(DEFAULT_RUNS_DIR)`
  compared against a relative default, so the same records dir reached from two cwds used
  two ledgers — the reservation stayed open forever and the box hours landed in a file
  nobody read.
- [x] **`qds-cost` read a different ledger than the money was written to** — the one CLI
  that REPORTS spend was the one left out of `costLedgerOpts`. Worst case it reported a
  confident zero for an issue that had burned budget.
- [x] Two admission rows for one `run_id` (retry with a fresh requestId — what the
  remediation itself advised) double-booked the cap. Reservation query now groups by
  `run_id` with `MAX(ceiling)`; both remediations corrected.
- [x] Non-empty validation ran BEFORE canonicalisation, so `"#"`, `" "`, `"#  "` all
  canonicalised to `""` and shared one unnameable budget identity that no override key
  could ever name. Validation moved to the canonical values.
- [x] `capForIssue` returned the FIRST matching override; now the LOWEST. The duplicate-key
  refusal existed only on the file-parse path, so a config assembled in code could silently
  ignore the line meant to LOWER a cap.
- [x] Sub-micro costs (`0.0000004` → 0 µ$) recorded as real, fully-priced, free spend.
  Now flagged `unpriced` under `cost-sub-micro-unpriced`.
- [x] File I/O and a log sink ran inside `BEGIN IMMEDIATE`; hoisted out (availability, not
  correctness — the SUM→INSERT serialization was already right).

### Provisioning, records, reaping

- [x] **`expose()` returning `""` defeated the "no address recorded" guard and the box
  still went public.** `??` catches only nullish, so `""` overwrote the create-time URL,
  `=== undefined` was false, and `setPublic` ran — producing exactly the state the guard's
  own comment forbids. Also reported by Sift.
- [x] **A zero-byte record from an interrupted `create()` wedged every sweep, fleet-wide.**
  Not `.tmp`, not `.probe-`, stem a valid run id, so no channel saw it; `JSON.parse("")`
  killed `list()` AND `listWithAnomalies()`, so nothing reaped and every live box kept
  billing, and the id was a permanent `EEXIST` tombstone. Now cleared on size PLUS a 5s
  mtime grace — size alone would race a concurrent create, which is zero-byte for the
  microseconds between its open and its write.
- [x] **Body-level rejections took down the whole listing.** This PR added a core field
  (`requestId`) and a namespace (`gate`) that older builds reject, so a rollback stopped
  the reaper entirely — the outage the file's own docstring names. Body errors now
  quarantine per-file into `skipped` + a new `skippedReasons`; `get()` stays strict.
- [x] `create()`'s `fsync` persisted data but not the directory entry, so a power loss
  could lose the record while the box survived — the orphan the comment claimed to prevent.
- [x] `vm.name` from `driver.create` was persisted unvalidated — the one value the whole
  record-before-VM invariant hangs on.
- [x] The budget-write rollback deleted the record on a LOCK TIMEOUT, which cannot prove
  the writer is dead; the in-flight write then recreated it OPEN and budgetless, with the
  id mintable again.
- [x] `driverListing`'s fallback asserted a complete population for any driver lacking
  `listWithAnomalies`, making the destructive reap fail-OPEN.
- [x] **`reapRuns` destroyed any unclaimed box in an account-wide listing.** Pre-existing,
  closed this round because #5b made it reachable: exe.dev listings include strangers'
  boxes. Now gated on `isFactoryOwnedVm` (name grammar AND ownership tag), the same
  predicate `sweep` uses, extracted so the two cannot drift.
- [x] exe.dev anomalies were unactionable (`vms[3]`), so one malformed provider row wedged
  reaping until the provider stopped emitting it.

### Secrets and operator-facing text

- [x] `redactSecrets` was unguarded and is called from catch blocks — a throw masked the
  original failure. Now fails safe to the REDACTED marker, never raw text.
- [x] Parking `keep` FIRST defeated the deep-link arm it is documented to run before, so
  the key-management URL in the revoke remediation was never redacted.
- [x] `SECRET_PREFIXES` gaps: `ghs_` (the token an App-authenticated clone URL carries),
  `ghu_`, `ghr_`, `xapp-`, `xoxa-`, `xoxr-`, `rk_live_`, `rk_test_`, `AIza`. A Google key
  is 39 chars against a 40-char floor that is load-bearing (git SHAs sit there), so the
  prefix is the only thing that can catch it — verified end-to-end on three delimited
  shapes. `GOOGLE_API_KEY=AIza…` redacts today for the WRONG reason (`=` is in the token
  charset and glues the name on past the floor) and is false comfort.
- [x] `isLongMixedToken` required all three character classes, so any single-class token
  passed at any length. Rule replaced with a hex-digest exemption.
- [x] An unterminated `-----BEGIN` swallowed the rest of the message (3 bytes of a 1 MB
  diagnostic survived; now 507 KB). The claimed quadratic backtracking did NOT reproduce
  (0–5 ms, the old arm was O(n)) — and the naive bounded fix measured a 3.7 s REGRESSION,
  because a bounded arm that can fail is retried at every `-----BEGIN`. Final shape is one
  always-matching regex: 1 ms.
- [x] `assertFleetRunId` was the only refusal building its `FleetError` directly rather
  than through `refuse`, so INV-6 never ran over it — a management URL in the run-id
  position reached stderr with path and query intact. The argv echo is now bounded and
  redacted, and the CLI's duplicate 96-char pre-cap was removed (it truncated without
  redacting, and could split a secret across the cut so neither half matched a rule).
- [x] The dispatch ack spread `httpsUrl` verbatim while every log line redacted it.
- [x] Gate-supplied `debugCommands`/`teardownCommand` bypassed `redactDeep` in the payload
  while the operator-facing remediation WAS redacted into unusability — each sink had the
  wrong half.
- [x] Control characters from `CorrelationError.message` and box-controlled gate notes
  reached the operator stream unescaped; `extractZodErrorField` echoed an attacker-chosen
  key NAME verbatim. Both now sanitised (`sanitizeLabel`, 128-char cap, `(root)` fallback).
  The RAW name still rides into `payload.issues` (zod builds it from the brief's key), so
  that string is ESCAPED there rather than stripped.
- [x] `detailOf` and `errorMessage` pre-coerced with `String(e)` OUTSIDE the guard, so a
  throwing `toString` escaped the catch that exists to preserve the evidence. A third twin
  (`escapeText(String(a.note))`) was found while verifying and fixed at the helper.

### CLI, locks, lifecycle

- [x] **A throw mid-teardown released the lock `markRunLockDestructive` exists to hold.**
  The mark was consulted only on the signal path; `releaseRunLock` ignored it, so the
  `finally` handed a half-torn-down run to the next retry with a clean lock. New contract:
  `releaseRunLock` refuses while marked, `clearRunLockDestructive` on clean completion,
  `{force:true}` as the deliberate override. `sandbox-teardown.ts` never marked at all.
- [x] `key-unattributable` teardown printed `torn down:` and exited 0, so
  `teardown … || alert` recorded success while a key may still bill. Now 6. Reachable
  exactly one way — dispatch died between `create` and the mint's keyHash write; NOT
  shared with a gate refusal (gate runs after mint) or a budget refusal (before create).
- [x] **`--brief` + a SOCKET on stdin silently provisioned from the wrong brief.** The
  guard enumerated `isFIFO() || isFile()`, and a socket is what any Node/Bun parent's
  `stdio: "pipe"` produces — the commonest programmatic path. Replaced with an allow-list:
  `st.isCharacterDevice()` (a TTY is one, and `/dev/null` is what cron/systemd/containers
  hand every process) plus the EBADF catch. Found by the test wave, whose first attempt
  used a Buffer, believed it was a pipe, and was a socket the guard never looked at.
- [x] An empty lock body was classified `stale = true`, printing "rm the lock" against a
  live holder mid-`writeLockDirect` — on exactly the filesystems that fallback exists for.
- [x] Pid reuse reported a stale lock as re-entrancy with an unfollowable remediation; the
  nonce already distinguished the two cases and is now used.
- [x] `AC1/AC4 — side effects before validation.` `RunRecordStore`'s constructor `mkdir`s
  and `chmod`s 0700, and was built before `BriefSchema.safeParse`, so an invalid brief
  created directories and re-permissioned an operator's existing one. New `{create:false}`
  read mode; `status` uses it. `FakeDriver` likewise now creates its box dir lazily.
- [x] `FleetError(0)` reported success (the clamp caught 256 and −1 but not 0); an
  out-of-table code fell back to 1, the one classification the file argues must never mean
  non-retryable.
- [x] A tolerated EAGAIN left truncated JSON on stdout at exit 0.
- [x] The dispatch interrupt handler warned about a box that could not exist yet, before
  `--driver` was even resolved.
- [x] The CLI ran no redaction on its error paths at all — `asUsage` copied `.message`
  verbatim and `report` attached raw `.stack`.
- [x] `dispatch.exitCodes` omitted 6, the one code meaning "a box is live and you have no
  handle on it". `status`'s declared 4 was unreachable. Help paths emitted no CC-9 line.
- [x] The `post-gate` deadline refused a run that had fully succeeded and told the operator
  to tear it down — re-spending the issue's cap on a run that had already worked, the exact
  hazard the ack-log guard 60 lines below names.
- [x] An abandoned `mint` left a live key at the full ceiling with nothing recording it:
  the handler duck-typed only `value.vm`, and the "go look for it" remediation was gated on
  `step === "create"`. Now step-aware.
- [x] The roster read was a `statSync`/`readFileSync` TOCTOU that a planted FIFO turned into
  an unbounded hang no timer could break — a vector the file already documents avoiding two
  blocks earlier. Now `openSync(O_RDONLY|O_NONBLOCK)` → `fstatSync(fd)` → `readFileSync(fd)`.
- [x] A create-timeout left a record with no `requestId`, joinable to nothing, forever.
- [x] `providerCodePayload`'s "one code, one meaning" rule was violated at two call sites,
  putting a producer's code into `FleetError.code` and coupling the exit table to renames.
- [x] `statusRun` conflated "no box by that name" with "list failed", so the commonest
  torn-down run reported `boxUnknown` from one entry point and `boxMissing` from the other.
- [x] `statusRun` reported "run not found" (exit 4) when the record store was entirely
  unreadable — inviting an operator to re-create a run whose box may be live.
- [x] Substrate-supplied `vm.name`/`httpsUrl` reached rows unvalidated, and the store's
  shape was trusted outside the guard while the driver's was defended.
- [x] Whitespace-only `requestId`/`manifestPath` passed `.min(1)` (`NO_CONTROL_CHARS`
  excludes `\p{Zs}`), collapsing concurrent runs onto one ledger key.
- [x] `repoSlugOfUrl` documented an `undefined` return it could not produce.
- [x] `process.removeAllListeners(sig)` stripped every other signal handler process-wide
  from a module used as a library; `claim`'s unguarded `closeSync` in a `finally` replaced
  the original errno and leaked the temp; `restore()` could throw out of the error message
  it was interpolated into.
- [x] The tracer leaked an open SQLite/WAL handle when `runContextFrom` threw (Sift).
- [x] `resolvedPath ?? manifestPath` performed the symlink substitution its own comment
  two lines above forbids.

### Test wave

~40 test-quality findings fixed. Additions are mutation-verified — each was confirmed to
go RED against the pre-fix source. Highlights: legacy non-canonical ledger rows inserted
raw (never through `ingestCostEvent`, which canonicalises on write and is exactly how the
gap survived five rounds); serialized admission driven through the one caller seam that
executes inside `decide.immediate()`, discriminating all three transaction shapes; the
AC9a drop-before-stamp guard given an authored-limit fixture it never had; `leakScan` used
in place of prefix-fragment absence checks that a tail-leaking regression would pass.

`rejection` moved from `tests/fleet/helpers.ts` to `tests/helpers.ts` — the provider suite
was reaching up into the fleet suite's internals, and paying a VALUE import of
`credentials.ts` → `swarmclaw/log.ts` → `step-log.ts` for a 6-line promise combinator. It
now FAILS on a non-Error rejection instead of wrapping one, which had made
`expect(err).toBeInstanceOf(Error)` unfailable at every call site.

### False positives refuted with executed evidence

- `markRunLockDestructive` "exported and never called" — `scripts/fleet.ts:67` imports it,
  `:1034` calls it. Re-scoped to the real defect (`releaseRunLock` ignored the mark).
- `extensions.gate` "may be an unregistered namespace" — registered at `run-record.ts:167`
  with exactly the four fields dispatch writes.
- `readMeta` failure "drops a live box" — it pushes `{name, status:"unknown"}`; reported,
  not dropped.
- `list()` "duplicated across two drivers" — each is a 2-line delegation to its OWN
  `listWithAnomalies`.
- "Hardcoded PEM private key" — `PEM_BLOCK_RE`, a redaction pattern with no key bytes.
- `canonicalIssueId` leading-zero regex — the reporting bot's own text concludes it is
  correct.
- `reaper.ts` "left on the throwing accessor" — `reapOrphans` already uses
  `listWithAnomalies` and refuses identically; both refuse, neither reaps. The fixer that
  raised it verified the counter-evidence and reverted its own edit.
- Quadratic PEM backtracking — measured 0–5 ms on three adversarial shapes.
- `run-record.test.ts` "no real concurrent lost-update test" — `:913` spawns three real
  subprocesses before the `Promise.all`.
- A signal landing mid-`releaseRunLock` — impossible: the function is fully synchronous and
  Node/Bun deliver signals as event-loop callbacks, never preemptive interrupts.

### Deferred by design (no code change)

- **`repoUrl` binds the path but not the host**, so `https://evil.example/trusted/repo`
  passes against a trusted slug. Binding the host needs an allowlist that would refuse
  legitimate self-hosted forges; already marked SUPERSEDED BY DESIGN by DF5.2's
  `.factory/repos.json`. Residual risk stated in-code.
- **`checkHeadroom` is a bare read with no reservation** — two dispatches inside one
  `driver.list()` round trip at `liveVms === ceiling - 1` both admit. The comment no longer
  claims a closure it does not cover, and names what would close it.
- **Per-`--dir` ledger split is a per-`--dir` cap.** The cwd fix removed the accident, not
  the design; `cost-config.json` remains a shared sibling read by both fleets.
- **The cap witness is author-writable** (resolves beside the manifest). Assumption now
  stated where the code claims two-copies-must-agree.
- **`reapRuns` is inert against exe.dev** — its `ls --json` carries no ownership tag, so
  the strict gate destroys nothing there. Not a production change: `sweep` is the reaper
  that ships and already classified every exe.dev box `foreign`. Unblocked by a tag channel.
- **A repository literally named `repo.git` is falsely refused** — `repoSlugOfUrl` strips
  `/\.git$/i` from the URL path, `canonicalRepoSlug` does not strip it from the slug.
  KNOWN-DEFECT test pins it. Both naive fixes are worse: stripping on the slug side too
  collapses `owner/repo.git` and `owner/repo` into ONE budget identity; not stripping on
  the URL side breaks every ordinary clone URL.
- **`StatusRow.state` ships 7 values against `integration-spec.md:491`'s normative 5.**
  Spec amendment needed — the two extra states are precisely the ones that stop an operator
  reading a substrate outage as an empty fleet.
- **`fleet help` is dispatchable but absent from `listVerbs()`** — knowingly deferred.
- Read-mode for harvest/teardown: costs a second construction to save a chmod on a
  directory the run legitimately owns.

## Review round 8 — BMAD adversarial code review, 2026-08-22

Method: 25-agent parallel wave over hunked diff chunks (≤1,940 lines each): 21 blind hunters
(diff-only), 3 edge hunters (diff + repo verification), 1 acceptance auditor (spec grep).
62 raw findings → triage ledger (`/tmp/pr-123-review/triage.md`) → 24 source patches across 7
disjoint clusters, then test hardening across 6 clusters after source settled. Every fixer ran
GitNexus impact before editing symbols; every claim verified against real source before patching.

### Money and locks

- **Same-pid foreign lock body wedged the run record forever** (HIGH) — a dead worker thread
  sharing our pid held `<runId>.json.lock`; `isAlive` stayed true so `stealIfOwnerGone` refused
  to take it for the process lifetime, burning LOCK_TIMEOUT_MS on every later write while the
  box billed. Locks now get the same age-based recovery temps always had: own-pid foreign bodies
  older than `OWN_LOCK_GRACE_MS` (60 s) are stolen, with the re-entrant check hoisted ABOVE the
  grace so a long enclosing write can never steal its own outer claim.
- **Tombstone stat→rm race let two creates own one runId** — creator A passed the stat, B rm'd
  the tombstone and wrote a live record, A's unconditional rmSync deleted it and minted its own.
  Removal is now rename-claim take-then-compare: single winner by rename, mismatches restored or
  parked, never deleted blind.
- **putBack-on-EEXIST destroyed a live holder's lock body** — stealer renames aside, operator
  clears, writer W claims, third writer X claims before put-back → the held-aside body W was
  inside got rm'd. EEXIST now parks `.orphan.<pid>.<hex>.tmp` + stderr note instead of deleting;
  callers dropped their unconditional rmSync.
- **Closed-record retirement front-ran box-hours pricing** — teardown closes the record before
  the box_hours row lands; a concurrent admitIssue saw `closedAt`, retired the reservation, and
  granted headroom the imminent charge consumed past cap. Retirement now requires the close to
  be absent, unparseable, or older than the existing admission-grace cutoff (zero new constants);
  freshly-closed records keep consuming their ceiling until the priced row must have landed.
  Crash residual narrowed from unbounded to one grace window.
- **Throwing log sink surfaced a COMMITTED admission as failure** — pendingLogs flushed outside
  any guard post-COMMIT. Both post-commit emission points now swallow sink throws to stderr; the
  ledger outcome stands.
- **Lock wait budgets moved to monotonic `performance.now()`** — NTP jumps could extend a
  fail-closed wait indefinitely or time out a healthy contention spuriously.

### Provisioning, reaping, ownership evidence

- **Legacy-named factory boxes were invisible to every listing** (HIGH) — exedev's strict grammar
  classified them "provably not ours", dropping them from vms AND skipped: spend no verb could
  reach. Readable names are now classified against the legacy grammar too and ride in `vms`;
  only names failing EVERY factory grammar stay excluded (co-tenant protection preserved).
- **Destroy decisions rested on rows carrying no ownership evidence** (HIGH) — exedev's ls has
  no tag field, so the gate reduced to name-shape: destroy-on-guess for a co-tenant within the
  grammar, or silent stop. Fail-safe direction taken: `reapRuns` partitions unclaimed boxes
  BEFORE destroying anything and refuses wholesale via new `unownedVmReapRefusal`
  (`reap-vms-unowned`, naming each spared box) rather than guessing either way. Three pins that
  encoded silent-spare were re-pinned to assert the refusal.
- **Provider row payloads reached operator output unredacted** — skipped entries and the
  refusal message now pass through `redactSecrets` like every other sink this PR adds.
- **fake-gate's substrate probe could never fail** (`|| echo none` forced exit 0), classifying
  an EIO-broken box do-not-retry; explicit absent/mode/unreadable arms replace it, unreadable
  carrying the substrate mark (retryable).
- Control characters in directory names are escaped (`\uXXXX`) at all four fake-driver
  free-text sinks; stale `closed ⇒ nothing to claim` rationale comments rewritten to the current
  invariant (driver.ts ×3, reaper.ts).

### Dispatch, status, CLI front door

- Injected-gate array fields (`assertions`, `debugCommands`) guarded for type, not just absence
  — a hostile/stub gate can no longer downgrade the exit-3 refusal to exit-1 via TypeError.
- Never-started expose no longer leaves a phantom `ports:[port]` on a live billable box: the
  claim is written INSIDE the expose thunk, so a pre-start timeout writes nothing while the
  abandoned-but-started path keeps round 7's behavior.
- Refusal payload `httpsUrl` now runs through `redact()`; pathless-EEXIST arm accepts
  `path:null`; `failedItem` escaped like its sibling gate text; the split-correlation warning no
  longer logs success markers (`status:"error"`, dedicated phase, no false exitStatus).
- Single-run status gained the arm statusAll already had: when the substrate could not be asked,
  remediation names the outage and withholds create-the-run advice (exit code unchanged).
- **CC-9 secret-splitting closed at the choke point** — `bounded()` redacts BEFORE slicing, and
  strictly stronger than the finding assumed: nothing downstream of `logVerb` redacted at all,
  so the old code leaked the head of any credential-shaped argv verbatim, not merely split it.
- Lossy-decode stdin briefs no longer double-refuse: the raw-byte streaming cap governs (U+FFFD
  expansion skips the redundant byteLength recheck); exact decodes still bind.
- **Stale or author-planted dispatch witness no longer sets the spend ceiling** — witness
  freshness binding (±30 min, symmetric against future mtimes): stale witness-only → ceiling
  left absent + structured warn; declared-limit path refuses even a number-agreeing stale pair.
  Temporal binding chosen over runId match: the dispatcher writes two distinct ids into
  run-context.json and the runner carries one, so id-match would break the real handoff.

### Test wave

- Live-mint hazard removed: out-of-process CLI tests strip `$OPENROUTER_PROVISIONING_KEY` from
  child env and assert the deterministic provisioning-key refusal; the teardown spawn strips
  `keyHash` like its siblings. A regression can no longer spend real network quota from `bun test`.
- All 8 `within()`-vs-outer timeout ties re-budgeted (outer > cumulative inner) with a scripted
  re-scan proving zero remaining violations; abandoned-line helper settles ≤50 ms before
  counting; three abandonment tests' real-clock margins widened −200/−250 → −1000 (residual
  >1 s inter-step stall documented); vacuous undefined===undefined vmName pairs pinned with
  `/^qds-/` shape checks both sides; INV-4 sink tests now read the echoed `limitUsd` (arg-swap
  detectable); UTC-midnight mint window accepts either bound; all 48 try/catch sites convert to
  an `UnexpectedSuccessError` sentinel that survives the catch under test; collision stub seeded
  from a real record instead of a two-field cast; mkfifo tests skipIf binary absent; failedAt
  discriminator strict `>` with justification.
- Regression coverage added for every wave-1 behavior change: lock-grace steal (young/aged/
  re-entrant), orphan parking, tombstone single-winner, retirement grace retention + expiry,
  throwing-sink success, legacy-listing, redacted skipped entries, control-char sanitization,
  witness staleness arms (stale/future/refusal/fresh-honoured), S26 redact-then-cap pin.
- driver-contract INV-1 arm tolerates both S15 outcomes (clean sweep excludes the live box;
  account-wide refusal accepted if it doesn't name the claimed box) — kills cascade-red when a
  sibling test leaks a box mid-suite.
- Pre-existing per-test-timeout red on the ~40-probe sweep (fixture-bound 8.7 s vs bun's 5 s)
  given an explicit 60 s budget; verified pre-existing on the checked-out pre-edit file first.
- Reprioritized, not churned: cost-ledger's SQL-literal regex brittleness and ±1 s expiry-margin
  notes were superseded by behavioral grace-window tests pinning the same invariant without the
  fragility.

### False positives — pushed back with executed evidence

- **Record `httpsUrl` written verbatim on the sync path** (reviewer: contradicts the redacted
  abandoned path). Reverted after sink analysis: the record IS the persistence layer — the pinned
  AC keeps a live PUBLIC box's address findable, `redact()` is lossy on exactly this shape (host
  labels ≥16 chars; every minted id produces one), and `fleet status` re-sanitizes at its own
  display boundary. Redacting the write would trade a cosmetic inconsistency for losing the only
  full-fidelity copy. Site documents why verbatim is correct.
- **FakeDriver half-built boxes bypassing the anomaly channel** — already listed on HEAD (catch
  pushes `{name, status:"unknown"}` into vms, pinned); the residual silent-spare concern is
  closed by the new reap refusal surfacing.
- **Slug canonicalization orphaning historical ledger rows** (HIGH) — dismissed on evidence:
  canonicalization is introduced BY this PR (no hits in main), the ledger is per-checkout
  `.sandbox/` storage, and `issueScopeSql` keeps the legacy-safe disjunct plus replay identity
  canonicalizes BOTH sides — mixed-case rows still count toward caps.
- **foreignLock pid=1 CI failure mechanism** — the claimed RunLockReentrantError path is not
  reachable (legacy-body refuse branch precedes any pid probe); the magic-number fix stands on
  hygiene grounds, but the finding's failure mode is not credited.
- **qds-cost env deletion leak** — outer afterEach already restored the variable; explicit
  save/restore added anyway.

### Decisions taken (conservative / fail-safe, per standing authorization)

- **Dispatch declares exit 6 in its registry though the round-5 amendment reserves 6 for
  harvest/teardown** (auditor MED). Changing an exit-code contract at review round 8 risks every
  consumer for a mapping (`ack-unwritable`) no other declared value fits. Decision: keep runtime
  behavior, register the deviation here as the round-8 amendment to C6/B8 — dispatch's 6 means
  "output-write failure after provisioning (ack-unwritable)". DF3.5's generator consumes the
  registry as-is, so generated skills stay truthful. Flagged for the next spec touch.
- **Status emits `listUnavailable`/`recordsSkipped` beyond C4's five states** — already carried
  above as a spec-amendment-needed item; round 8 confirms additive-diagnostics intent and adopts
  it into this story's standing amendment rather than deleting diagnostics.
- **Success-path dispatch emits no durable dispatch-log entry** vs C9's "once per outcome"
  wording — interpreted as failures-only (the constant is DISPATCH_FAILURE_LOG); success keeps
  its structured line. Recorded so C9's wording gets aligned at the next spec touch instead of
  adding per-dispatch noise now.
- **Fleet-ceiling TOCTOU stays deferred** — checkHeadroom remains a bare read; the in-code
  comments own it as DF2.6 quota-layer work. Unchanged this round.
- **fake-gate substrate-probe coverage** wanted for setup-gate.test.ts (unreadable→retryable
  arm) — source fix shipped and manually probed; the test addition is filed as follow-up rather
  than rushed at round 8.

### Gates

- Full suite: **2808 pass / 0 fail / 17 skip / 2 todo** across 81 files (post-final-edit rerun).
- biome check clean on all 22 touched files; `tsc --noEmit -p tsconfig.json` exit 0 repo-wide.
- GitNexus `detect_changes` (unstaged): 64 changed symbols / 28 files, blast radius confined to
  the PR's own modules and processes (Dispatch, StatusRun, ReapRuns, WithLock,
  ProvisionAdmittedRun, TeardownRun, DriverListing, Sweep, Run CLI) — zero out-of-scope symbols.
