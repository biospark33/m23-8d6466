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
- **INV-6 (redaction complement to INV-4):** Any URL containing management/deep-link parameters is redacted with regex `[0-9a-zA-Z%-]{16,}` before logging (R3 redaction doctrine).

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

<!-- Empty placeholder — filled during development. -->

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
