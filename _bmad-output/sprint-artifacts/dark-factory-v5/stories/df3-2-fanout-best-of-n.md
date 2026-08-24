# DF3.2: Fleet Patterns as Code — fan-out N, best-of-N, race

**Story Points:** 4
**Sprint:** v5-S2 (fleet band, after DF3.1; R5 §3 names it the first cut if the sprint must compress)

## Spec Reference

- `docs/superpowers/specs/2026-08-11-dark-factory-v5-architecture-design.md` §5.1 tier 2 (fleet
  patterns: best-of-N, many-stories, race), §5.3, §6 items 1/2/5, §8 step 3, §9 risk **R8**
- Decision register: v5 §4 **D3** (dispatcher is tested TS, not prompt-glue — "disler's fleet layer
  is an un-coded bash cookbook, a gap we close with real code"), **D7**, **D8**
- Derivation decisions: `docs/superpowers/specs/2026-08-11-v5-story-derivation-decisions.md` DD-8, DD-9
- Contracts: DF3.1's dispatch ack + `requestId` propagation (CC-9); DF2.1's closed run-record schema;
  DF2.6's quota accounting. Binding facts: R5 §6 facts 11, 15, 17
- Source pattern (file:line): `INK/.claude/skills/sssf-sandbox-orchestrator/cookbooks/fan_out_n.md`
  — 214 lines of prose around an 18-line bash loop (`:33-50`), with `:3-22` the isolation argument,
  `:26-32` and `:53-55` the id-minting race, `:39/:45/:132` the commit-pin control, `:136-140` ranking
- **`INK/` alias expansion:** `INK/` is the operator's alias for the upstream `sssf` skill checkout,
  which is **not present on this host** — the `:line` anchors above are unopenable until it is cloned
  (`git clone <sssf-upstream> INK/`, upstream URL recorded in the derivation research bundle). The
  excerpts quoted in `R4-external-patterns.md` are the **binding** text for this story; the `INK/`
  anchors are provenance. A missing checkout is never grounds for re-deriving a clause from memory.

## User Story

As the factory operator,
I want the three fleet patterns as tested code with an admission check, not a cookbook I adapt by hand,
so that running N arms cannot quietly exhaust the account's box ceiling, collapse N isolated runs into
one shared box, or lose an arm because a copy-paste dropped a guard.

## Overview

Disler's fleet layer is 214 lines of prose around an 18-line bash loop an agent adapts per invocation,
every guard in it a comment rather than a check — exactly the improvisation D3 rules out. This story
turns it into `fleet fanout`: one admission check, then N independent `dispatch` calls through DF3.1,
each producing its own box, key and record (R8). Three patterns compose over that primitive —
**best-of-N** (identical brief and pin, roster is the varied axis, arms ranked at the end),
**many-stories** (N distinct briefs, unranked), **race** (identical brief, first arm past the
completion predicate wins and the rest are torn down). Admission is load-bearing: DF2.6's
`checkHeadroom(N)` is consulted once for all N, and fan-out refuses when it returns
`allowed: false` rather than minting until the ceiling bites.

## E2E Slice

**Demonstrable behavior:** Given DF2.6's `checkHeadroom(3)` returns `{ allowed: true, headroom: 4 }`
and a best-of-N request for `N=3` with a pinned SHA and three roster paths, When the operator runs
`bun scripts/fleet.ts fanout --pattern best-of-n --n 3 --pin <sha> --roster a,b,c < brief.json`, it
admits once → mints three run ids **before** any parallel work → dispatches three arms concurrently,
each with its own record, box, key and per-arm cap → prints one ack line per arm → emits a ranking
table with a recorded rationale. `run-record list` shows three distinct records with three distinct
`keyHash` values, and `.sandbox/runs/` holds three bundles.

**Wiring closed:** all three patterns run end to end on only this story plus DF3.1's dispatch, DF2.6's
headroom accounting, DF2.1's record store and extension namespace, and DF1.1's engine journal. No stub,
no `TODO: wire later`, no bash cookbook at runtime. DF3.5's skills call these verbs, never reimplement.

**Dependency edges (predecessors):** DF1.1, DF2.1, DF2.6, DF3.1.

**Sequencing note (DF2.6 is a same-sprint predecessor, mirroring df3-1's):** DF2.6 and DF3.2 are both
v5-S2. DF2.6 lands **before** DF3.2, or — if the sprint reorders — AC1's `checkHeadroom(N)` call ships
in the commit that lands DF2.6's import, never as a stub or a locally re-derived ceiling. The
ordering is transitively safe (DF3.1 already holds the same edge), but it is stated rather than
assumed. Driver registration cites `src/providers/index.ts`'s `resolveDriver(name)` per R2 S3.

## Acceptance Criteria

1. **(make-or-break)** Given `checkHeadroom(3)` returns `{ allowed: false, liveVms: 48, ceiling: 50,
   requested: 3, headroom: 2 }`, When `fanout` runs, Then it refuses **before minting anything**:
   exit `5` (DF3.1's table), zero records, zero boxes, zero keys, and an error naming headroom and
   request. The check is **one** call covering all N before the first mint, never N checks of 1.
   *Negative control: an implementation that dispatches until a provider error appears MUST fail.*
2. Given `N` arms, When they run, Then each holds its own box, runtime key and run record, and no two
   arms share a working tree, a key, a port or a git state (R8). *Negative control: an implementation
   that runs N agents inside one box satisfies "N results were produced" and MUST fail this test —
   spend attribution, blast radius, the commit graph and the setup gate all assume one arm per box
   (`fan_out_n.md:3-22`).*
3. Given a fan-out, When run ids are generated, Then all N are minted **before** the parallel section
   opens, through N synchronous calls to DF3.1's own `mintRunId()` (the same minter `dispatch()` uses
   internally) — never a caller-invented id — and each pre-minted id is passed explicitly to its arm's
   `dispatch(brief, { admitted: true, runId })` call. DF3.1 remains the sole `runId` minter; DF3.2
   only sequences *when* the mint happens relative to the parallel section. Recovering an id by
   reading the newest run record is forbidden — correct for one run, a race under concurrency
   (`fan_out_n.md:26-32`, `:53-55`).
4. Given one arm's setup gate fails, When the remaining arms are in flight, Then that arm alone stops,
   its box is left **alive** with its evidence, its exit code is collected, and every other arm runs to
   completion. `fanout` exits non-zero with per-arm outcomes, never aborting siblings and never
   auto-destroying a failed arm (`fan_out_n.md:57-58`; DF2.2 INV-5). **Precedence (reciprocal of
   AC5's `race` teardown):** this rule governs an arm that fails **before it ever enters the
   completion race** — its setup gate never returned `ready`, so DF2.2 INV-5 forbids destroying a
   degraded box, and the arm is reported `setupFailed`, never `armFailed` or torn down. It is
   orthogonal to AC5, which governs only arms that **did** enter the race (setup gate returned
   `ready`) and subsequently lost, `armFailed`, or hit the all-fail path — every one of those goes
   through DF2.5 teardown. A setup-gate failure is never retroactively treated as a race loss, and a
   race loss is never left alive under this AC's rule.
5. Given `--pattern race`, When the arms run, Then the host detects completion by **polling for the
   engine's in-box `/run/journal/final.json` marker** — the file DF1.1 writes at `finish(accepted)`
   — every `5_000` ms, because `finish(accepted)` itself is inside-box and the host receives no
   completion callback from DF3.1 or DF2.6. There is no `driver.observe` method on DF2.1's port:
   observation is a **host-side composition** over the two port verbs DF2.1 does define — a
   `driver.exec(vm, …)` existence probe on the marker path, then `driver.copyFile(vm, "/run/journal/final.json", <host tmp>)` to read it — and this story owns that composition inside
   `src/fleet/fanout.ts`, adding no method to the driver port. The **completion predicate** is "a
   readable `final.json` whose `ok` is `true`" (DF1.1 writes `{ runId, ok, completedAt }`); the first
   arm whose marker satisfies it wins by an atomic first-writer transition on the fan-out record's
   `winner` field (AC9). Every remaining arm is then treated as a loser and goes through DF2.5's
   `teardown` unmodified — its fixed order (spend → artifacts → commits → revoke → destroy → close)
   harvests before it destroys, so no arm is destroyed with unharvested work and no second harvest
   call is issued. A marker whose `ok` is `false` is **not** a win and not an unknown: that arm is
   recorded `armFailed` — a run that completed and reported failure, distinct from AC4's setup-gate
   failure — and the race continues with the remaining arms. When **every** arm reaches `armFailed`,
   the race has no winner: `fanout` exits non-zero, the fan-out record closes with `winner: null`,
   and every arm is torn down through DF2.5, whose fixed order harvests the bundle before it
   destroys, so the failed work is preserved as an artifact rather than in a live box. The all-fail
   case is a terminal outcome, never a wait for a winner that cannot arrive. An arm
   still without a readable marker at the fan-out ceiling (3_600_000 ms) is reported `armUnknown` —
   never assumed a loser, never auto-destroyed. Each `driver.exec` probe and `driver.copyFile` read
   carries its own **per-call deadline of 10_000 ms**, so a provider call that never returns cannot block the polling loop indefinitely: a call that overruns a poll tick causes that tick's poll to be skipped and logged (not fatal), the loop retries on the next 5_000 ms tick, and the whole loop stays bounded by the overall 3_600_000 ms fan-out ceiling.
6. Given `--pattern many-stories --n 1`, When `fanout` runs, Then it dispatches exactly one arm
   through DF3.1 with no ranking step and no special-casing — the degenerate case is the same code
   path, not an error. `best-of-n` and `race` reject `N=1` at validation (exit `2`): a comparison
   needs two arms.
7. Given a completed best-of-N fan-out, When `rank` runs, Then it emits
   `{ scores[{arm, runId, score, breakdown}], tie, rationale }` joining each arm's record with its
   step output, where **`score = testPassRate × 0.6 + uniqueFileCoverage × 0.4`**, both terms in
   `[0,1]` per `p1-4-protocol-template.md:92`:
   <br />— `testPassRate = testsExecuted ? testResults.passed / (testResults.passed +
   testResults.failed) : 0`, reading DF1.6's merged-output `testResults` and its `testsExecuted`
   flag. The divisor is guarded: `testsExecuted: false`, an absent `testResults`, or
   `passed + failed === 0` all yield `0`. There is no `testsPassed` field anywhere — DF1.6's counts
   are `passed`/`failed` — and `testsExecuted` is a **boolean**, never a divisor.
   <br />— `uniqueFileCoverage = |arm.changedFiles| / |⋃ arms changedFiles|`, P1.4's **cross-arm
   union** denominator: the share of the file surface any arm touched that this arm touched. It needs
   no target-file list, so DF3.1's closed brief schema gains no field for it. An empty union (no arm
   changed a file) ⇒ term is `0` for every arm.
   <br />`breakdown` carries **exactly** those two keys with those names. P1.4's third term
   `summaryQuality` is **dropped** — it scored a `compare` phase that exists in no v5 manifest — and
   the remaining two weights are **re-weighted** to `0.6`/`0.4`: a deliberate choice of round numbers
   summing to `1.0`, not an arithmetic renormalization of P1.4's `0.5`/`0.3` (which would give
   `0.625`/`0.375`). No other term may be added without changing this AC. Top two within `0.1` sets `tie: true`
   with **no** automatic tie-break (`:94-97`). An arm with no step output is listed with
   `score: null`, never dropped, and an all-arms-failed fan-out yields empty `scores` with a
   rationale saying so.
8. **(single-operator enforcement)** Given a second `fanout` invocation while a first is between its
   admission check and its last mint, When it starts, Then it fails to take the advisory lock
   `.sandbox/fleet.lock` (created `O_EXCL`, mode `0600`, holding `{ pid, pidStartTime, createdAt,
   requestId }` — `pidStartTime` is the owner process's own start time, read at lock creation from
   `ps -o lstart= -p <pid>` on darwin / `/proc/<pid>/stat` field 22 on Linux) and
   exits `5` with code `fleet-busy`, provisioning nothing. The lock is held across **admission and
   all N mints** as one critical section and released in a `finally`. Reclaiming a lock is a **two-part
   test, both required**: the lock's age exceeds `3_600_000 ms`, **and** the recorded owner is no
   longer that process — either signal `0` to the recorded `pid` fails (dead), or the live process's
   start time does not equal the recorded `pidStartTime` (the `pid` was reused by an unrelated
   process; identity, not liveness, is what the check verifies — signal `0` alone cannot distinguish
   the two). Age past the threshold with a still-live, identity-matching owner is **not** reclaimed — the
   second invocation exits `5` `fleet-busy` instead, so a first fan-out still inside teardown or
   cleanup at the threshold is never preempted mid-critical-section. Only a lock that is both stale by
   age and ownerless is logged and reclaimed. *Negative control: a lock-free implementation lets two
   concurrent fan-outs both read the same headroom and double-admit past the ceiling, and MUST fail
   this test; an implementation that reclaims by age alone, with no liveness check, MUST also fail —
   see the reclamation test below.*
9. Given any fan-out that passes admission, When the first id is minted, Then a fan-out record is
   created `O_EXCL` at `.sandbox/fanouts/<fanout-id>.json` with
   `{ fanoutId, requestId, pattern, n, pin, createdAt, arms: [{ arm, runId, rosterId?, briefHash }],
   winner: null, rankedAt: null, closedAt: null }`, and each arm's DF2.1 run record carries
   `extensions.fanout = { schemaVersion: 1, fanoutId, arm }` in DF2.1's pre-registered extension
   namespace — `schemaVersion` is required of every namespace by DF2.1, not optional here — and no
   core run-record field is added. `rank <fanout-id>` and AC5's `winner` transition both read and write
   **this** record and no other store. A fan-out refused at AC1 or AC8 writes **no** such file.

## Trigger Surface

| Trigger | Status | E2E Test | Follow-Up |
|---------|--------|----------|-----------|
| `fleet fanout --pattern best-of-n\|many-stories\|race --n N` (one E2E per pattern) | in-scope | `tests/fleet/patterns.test.ts` | — |
| `fleet rank <fanout-id>` | in-scope | `tests/fleet/rank.test.ts` | — |
| `fleet dispatch \| status \| harvest \| teardown` (single run) | out-of-scope | — | DF3.1 |
| Fleet-wide orphan sweep + failed-teardown queue | out-of-scope — DF2.6's `scripts/sandbox-reap.ts` is the whole surface; no `fleet reap` wrapper in v5.0 | — | DF2.6 |
| `fleet attach` steering into a running arm | out-of-scope | — | DF3.4 |
| Tier-1 Claude Code skill wrapping `fanout` | out-of-scope | — | DF3.5 |
| Golden-VM `cp` fast path for N ≥ 3 | out-of-scope — unexercised upstream (`fan_out_n.md:205-207`) | — | none derived |

## Infra Prerequisites

| Component | Service (compose/k8s/provider) | Lifecycle Hook Verified |
|-----------|-------------------------------|-------------------------|
| Quota accounting | DF2.6, host-side against the provider's own box list | `checkHeadroom(N)` returns `{ allowed, liveVms, ceiling, headroom, reason? }` before the first mint; `allowed: false` — reason `list-unverified` included — refuses |
| Dispatcher | DF3.1 `dispatch()` in-process | each arm's ack returns a distinct runId; requestId resolves per CC-9 |
| N sandboxes | exe.dev driver (DF2.2); `fake` driver for CI | every arm's setup gate returns `ready` independently, or that arm alone stops |
| N run keys | DF2.3 credential lifecycle | N distinct `keyHash` values, one per record; per-arm cap applied at mint |
| Harvest / teardown per arm | DF2.5 | verify-before-fetch per arm; `refs/sandbox/<run-id>` namespaces cannot collide |
| Fan-out record + fleet lock | host filesystem `.sandbox/fanouts/` and `.sandbox/fleet.lock` at mode `0700`/`0600` (DF2.1 discipline) | record `O_EXCL`-created before the first mint; lock taken before admission and released in a `finally` — asserted by the concurrent-fanout test |
| Arm completion signal | host-side polling composed from DF2.1's `driver.exec` (probe) + `driver.copyFile` (read) over DF1.1's `/run/journal/final.json` — no `observe` method is added to the port | marker readable within one 5,000 ms poll of `finish(accepted)`; each probe/read call bounded by a 10,000 ms per-call deadline so a hung remote call cannot block the loop; `ok: true` ⇒ win, `ok: false` ⇒ `armFailed`, absent at ceiling ⇒ `armUnknown`. The path resolves through DF1.1's `RUN_MARKER_ROOT = process.env.QDS_RUN_ROOT ?? "/run"`: `QDS_RUN_ROOT` is a **host-test-only** override so this story's poller tests can point at a temp dir, and it is unset in the box, where production stays exactly `/run/journal/final.json` |

## Technical Notes

- **Isolation is structural, not policed (R8).** N arms are N boxes because the collision this system
  exists to prevent is N agents fighting over one working directory, one dev-server port and one git
  state; running them in one box reintroduces it exactly and buys nothing (`fan_out_n.md:8-10`).
- **Admission before mint.** DF2.6 owns the ceiling (50 VMs / 100 GB pooled disk, host-side), the
  failed-teardown queue and `checkHeadroom`; DF3.2 owns only the call — **one** `checkHeadroom(N)`
  covering all N, never N calls of 1, before the first mint. It reserves **no slot** in the provider,
  so single-operator exclusion is what makes read-then-mint safe (**DD-1**); AC8 turns that stated
  assumption into a mechanism — the `.sandbox/fleet.lock` advisory lock spans admission plus all N
  mints, so a second concurrent fan-out is refused `fleet-busy` rather than double-admitting against
  the same headroom reading. A refusal mutates nothing. Because DF3.1 AC8 also checks headroom on
  every single dispatch, each arm is dispatched as `dispatch(brief, { admitted: true })` from inside
  the lock — that flag exists so a fan-out of N still makes exactly **one** `checkHeadroom(N)` and
  never N checks of 1 (AC1). DF3.1's per-issue budget gate (its AC7 `assertWithinBudget`) is **not**
  suppressed: each arm consults it independently, and each consult **reserves** — DF2.8's serialized
  admission (BEGIN IMMEDIATE over the append-only `gate_admissions` reservations, per its dev
  deviation note) takes one reservation per arm, so N arms place N reservations against the
  per-issue cap and aggregate exposure stays bounded by it.
- **The fan-out record is a real artifact (AC9), not a notion.** `.sandbox/fanouts/<fanout-id>.json`
  is the store `rank <fanout-id>` reads and the race winner transition writes; it lives beside
  DF2.1's `.sandbox/runs/` under the same `0700`/`0600` discipline and the same `O_EXCL`-then-
  atomic-replace rule. The run↔fan-out join goes the other way through DF2.1's **extension**
  namespace (`extensions.fanout`), never by adding a field to the twelve-field closed run record.
- **Pattern axes** (everything else is shared): best-of-N = identical brief + one pinned SHA, roster
  is the varied axis, ranked; many-stories = N distinct briefs, per-arm pins, unranked; race =
  best-of-N's inputs, first arm past the predicate wins, losers torn down.
- **The pin is the control variable (`fan_out_n.md:39, :45, :132`).** best-of-N and race pin every arm
  to one SHA, recorded from what actually got checked out, never from what was asked for. Two varying
  axes means the comparison measures nothing, so the CLI rejects arms carrying differing pins.
- **Ranking is advisory; the diff is the artifact (`fan_out_n.md:136-140`).** `rank` joins the per-arm
  record (`spendMicroUsd`, `commitSha`) with its step output (`exitStatus`, `testResults`,
  `changedFiles`); it authorizes nothing. AC7 fixes the shape and carries P1.4's tie rule (R2 §2).
- **Per-arm spend cap (DD-9).** Each arm mints its own capped key at a **fan-out per-arm cap** distinct
  from the single-run default, in integer micro-dollars, so aggregate exposure is `N × perArmCap` and
  a runaway arm can only spend its own cap (`fan_out_n.md:14-17`).
- **Guards/limits:** `N` is an integer in `2..8` for best-of-N and race, `1..8` for many-stories;
  concurrency capped at `min(N, headroom, 8)`; per-arm dispatch ceiling is DF3.1's 600_000 ms,
  fan-out ceiling 3_600_000 ms, after which unfinished arms are reported, never killed silently. The
  race pattern's `driver.exec` probe and `driver.copyFile` read (AC5) each carry a 10_000 ms per-call
  deadline so one hung remote call cannot itself exceed the fan-out ceiling.
- **Deviation/assumption:** the golden-VM `cp` fast path is designed and measured upstream but
  **unexercised** — an unsynced `cp` produced 5,641 zero-byte files and reported success
  (`fan_out_n.md:174-207`). This story uses cold mounts only; DF2.2's assertion A catches that failure
  mode. All exe.dev allowances reached through DF2.6 are `[VERIFY]` single-origin (R5 §6 fact 11).

## Observability Contract

- Every fan-out logs `{ requestId, fanoutId, pattern, n, headroom, timestamp, durationMs, outcome }`;
  every arm logs `{ requestId, fanoutId, runId, arm, exitStatus, durationMs }`.
- The fan-out's `requestId` propagates into each arm's dispatch per CC-9 and is the join key across all
  N traces; `fanoutId` groups them. Errors carry `{ code, message, remediation }`, never key material.
- Sub-timings: `admission_ms`, `mint_all_ms`, `arm_dispatch_ms` (per arm), `rank_ms`; an arm that
  cannot be broken down reports `0` and its `durationMs` is authoritative.

## Files to Modify

- `src/fleet/fanout.ts` (the primitive; the three patterns are thin compositions in the same module)
- `src/fleet/rank.ts`
- `src/fleet/index.ts`
- `src/fleet/verbs.ts` (authored by DF3.1 under its AC6; this story **adds only** its own
  `fanout`/`rank` registry entries and edits no DF3.1- or DF3.4-owned entry)
- `scripts/fleet.ts`
- `tests/fleet/fanout.test.ts`
- `tests/fleet/patterns.test.ts`
- `tests/fleet/rank.test.ts`

## Security Invariants

- **INV-1 (isolation by construction):** N arms means N boxes, N keys, N records, N
  `refs/sandbox/<run-id>` namespaces (R8) — no arm can read another's tree, key, ports or git state
  because no shared object exists. Enforced by AC2's negative control, not by policy.
- **INV-2 (admission validation — fail-closed):** `N`, the pattern, the pin and the roster list are validated, and
  `checkHeadroom(N)` consulted, **before** the first side effect. A refused fan-out provisions
  nothing and mutates nothing (DF3.1 INV-2, N times over). If DF2.6 cannot determine headroom (including `reason: "list-unverified"`), `fanout` refuses entirely rather than dispatching optimistically (R3 fail-closed doctrine).
- **INV-3 (bounded aggregate spend):** every arm mints its own capped key; aggregate exposure is
  `N × perArmCap`, stated in the fan-out's log line before dispatch. A shared key is forbidden — it
  lets one runaway arm spend the whole budget and makes per-arm spend undecomposable (`:14-17`).
- **INV-4 (credential containment, per arm):** each arm's key exists only inside its own box and its
  own host-side `0600` file; only `keyHash` reaches the record. Race losers pass DF2.3's
  revoke-then-verify-against-the-key-list before destroy, so a cancelled arm never leaves a live key.
  No box in any pattern holds a push credential (D8; R5 §6 fact 17). Any management URLs are redacted with regex `[0-9a-zA-Z%-]{16,}` before logging (R3 redaction doctrine).
- **INV-5 (fail-closed teardown):** A failed arm is never auto-destroyed and never aborts siblings. If an arm fails before the race (setup gate failure), its box is left alive with evidence; if it loses the race, it goes through DF2.5's teardown order (harvest before destroy) so no work is lost. Per-arm guards are preserved — no sibling failure aborts the fan-out (R3 fail-closed doctrine).
- **INV-6 (finite caps):** N is bounded `2..8` for best-of-N/race, `1..8` for many-stories; fan-out ceiling is 3_600_000 ms; per-arm dispatch ceiling is 600_000 ms. Unbounded concurrency or wall-clock time is forbidden (R3 finite-cap doctrine).

## Definition of Done

- [ ] **Impl:** `fanout(pattern, n, brief, opts)` — one `checkHeadroom(n)` admission, all ids minted
      before the parallel section, N independent `dispatch` calls, per-arm outcomes collected
- [ ] **Impl:** three patterns over one primitive: best-of-N (constant pin, varied roster, ranked),
      many-stories (N briefs, unranked), race (first winner, losers torn down via DF2.5's order)
- [ ] **Contract (AC7):** `rank` emits `{ scores[{arm, runId, score, breakdown}], tie, rationale }`;
      with the `0.1` tie threshold, a top-two delta of `0.05` asserts `tie: true` and **no** winner
      auto-picked, `0.2` asserts false, and `0.1` (the boundary) asserts `tie: true`
- [ ] **Contract (AC7 formula):** a fixture of three arms with known `testResults{passed,failed}`,
      `testsExecuted` and `changedFiles` asserts `score == testPassRate*0.6 + uniqueFileCoverage*0.4`
      to 6 decimal places against the `0.6`/`0.4` weights (not `0.625`/`0.375`), with
      `uniqueFileCoverage` measured against the **cross-arm union** of `changedFiles`, and that
      `breakdown` has exactly the keys `testPassRate`, `uniqueFileCoverage` — a `summaryQuality` key
      present anywhere fails the test
- [ ] **Contract (AC9, fan-out record):** a successful fan-out leaves exactly one
      `.sandbox/fanouts/<id>.json` matching the schema with `arms.length === n`, and each arm's run
      record carries `extensions.fanout` with `{ schemaVersion: 1, fanoutId, arm }` — a namespace
      written without `schemaVersion` is rejected by DF2.1's record layer and fails this test
- [ ] **Contract (verb registration):** `fanout` and `rank` — with their flags and exit codes — are
      registered in DF3.1's `src/fleet/verbs.ts` registry, so `fleet --help` and DF3.5's
      skill-contract test see them without a second list (DF3.1 AC6)
- [ ] **Integration:** every arm goes through DF3.1's `dispatch` and DF2.5's harvest/teardown — no
      provider command, no second lifecycle implementation, under `src/fleet/`
- [ ] **Security:** fail-closed admission (INV-2); distinct `keyHash` per arm (INV-3/INV-4); per-arm guards preserved on failure (INV-5); finite caps enforced (INV-6)
- [ ] **Test (concurrent fan-out, AC8):** two `fanout` invocations race the lock → exactly one
      admits, the other exits `5` `fleet-busy` with zero records and zero mints; lock reclamation liveness+identity asserted per R3 doctrine
- [ ] **Test (race predicate, AC5):** a fake driver whose `exec` probe + `copyFile` read expose an
      `ok: true` `final.json` for arm 2 first → arm 2 wins the `winner` transition, arms 1 and 3 tear
      down through DF2.5's six steps (harvest before destroy), and an arm whose marker never appears is reported `armUnknown`
- [ ] **Test (e2e demo — MANDATORY):** best-of-N `N=3` against the `fake` driver produces three closed
      records with three distinct `keyHash` values, three bundles under `.sandbox/runs/`, and one
      ranking table with rationale — captured in the Dev Agent Record.
      **PARTIAL as demonstrated:** the records, distinct keyHashes and ranking table are all shown;
      the three bundles are NOT (the fake driver's boxes carry no git history or artifacts, so
      DF2.5's harvest step reports `"harvested":"none"` — see Honest deltas #1). Bundle production
      itself is DF2.5's mechanism and is exercised there; a real exe.dev arm rerun is what would
      close this criterion fully.

## Dev Agent Record

### Wave 2, agent D — CLI wiring + verb registration + e2e demo (2026-08-23)

**Landed (this wave):**

| File | Change |
|---|---|
| `src/fleet/verbs.ts` | Two additive registry entries (`fanout` [0,1,2,5,6], `rank` [0,1,2,4] with `--steps-json` per ruling C2); `:39` docstring "Exactly 4" → six verbs; the "`--driver` required on every verb" header paragraph now names its one exception. No DF3.1-owned entry edited. |
| `src/fleet/index.ts` | Three export lines: `./fanout.ts`, `./fanout-primitive.ts`, `./rank.ts`. `fleet-lock.ts` deliberately stays off the barrel (consumers import it directly). |
| `scripts/fleet.ts` | `fanout` and `rank` verb blocks per D12. Shared helpers extracted when fanout became the second caller: `ingestBriefJson` (brief seam/cap/parse), `makeLedgerFactory` (budget-gate handle), `readFanoutForRank` (ENOENT→null mapping). `FleetDeps` gains `fanoutsDir?`/`lockPath?` seams (tests/embedders point them at a tmpdir). Dispatch block rewired onto the two shared helpers — behavior-identical, one implementation of each discipline. |
| `tests/fleet/verbs.test.ts` | Pinned sites updated additively: EXPECTED_FLAGS/EXPECTED_EXIT_CODES + verb loop (:314), synthetic-render no-leak list (:366), probe-order pin (:875), plus three sites K4's register under-counted ("exactly 4 entries", renderHelp polarity, "--driver required on EVERY verb") — each updated with rank's documented exemption. NEW probes: fanout 7 (codes 2×5, 5, 1, 0), rank 5 (2×2, 4, 1, 0) — every declared code probed for both verbs except fanout 6, excused to its cli.test.ts case via the existing binding check. Env redirects QDS_RUNS_DIR/QDS_FANOUTS_DIR added to the exit-codes describe. |
| `tests/fleet/cli.test.ts` | EXPECTED_VERBS → six (+BARE_VERB_EXIT entries). New tests: best-of-n e2e (acks + auto-rank line + extension joins + lock released), many-stories wrapper e2e, six validation refusals (exit 2, nothing provisioned), no-headroom exit 5, **exit-6 EAGAIN test** (the allowlist's binding target), rank scored via `--steps-json` (asserts score to 6 dp, exactly-two-key breakdown, rankedAt stamped), rank unscored exit 0, rank unknown-id exit 4. |
| `tests/fleet/patterns.test.ts` | ONE new block (AC8): two full `fanout()` invocations race with a seam barrier parked in the winner's admission await — loser refuses exit 5 having written zero records/mints/boxes; totals prove it under the shared driver/store. |

**Gate evidence:** scoped files 175 pass / 0 fail; full suite **3308 pass / 8 skip / 1 fail** (= 3317
collected; this is agent B's wave snapshot, NOT the same run as the close-gate line at the bottom of this
record — see "Story-evidence reconciliation" for the one-run addendum) —
the one fail is `tests/gitnexus/graph-queries.test.ts` ("gitnexus_impact — 'registerSwarmClawAgent'
…"), proven pre-existing by `git stash push -- <six owned files>` + rerun on the clean tree: same
1 fail / 15 pass. It reads the GitNexus index, not our code. B's other candidates (setup-gate ×6,
readRunsByIssue, usage.test.ts, cli-anything watchdog) all passed this run. `bunx tsc --noEmit`
clean; `biome check` clean on all six files; GitNexus impact run before editing (`listVerbs`,
`run` — both LOW); detect_changes before commit.

### MANDATORY e2e demo (DOD) — captured verbatim

Driven through the real CLI front door (`scripts/fleet.ts run()` — the exact function
`import.meta.main` binds to argv) in a temp cwd, fake driver + FakeKeyApi injected via the CLI's
own DI seams. Chain: `fanout` → `teardown` ×3 (DF2.5 harvest-before-destroy closes each arm's
record) → `rank --steps-json` keyed by the ACTUAL minted run ids.

```
===== COMMAND: bun scripts/fleet.ts fanout --driver fake --pattern best-of-n --n 3 \
           --pin fff…fe2e(40 hex) --roster alpha,beta,gamma --brief brief.json   (stdout verbatim)
{"fanoutId":"fan-20260823-09bd5a","arm":0,"runId":"qds-20260823-b4d8fe","outcome":"ready","vmName":"qds-20260823-b4d8fe"}
{"fanoutId":"fan-20260823-09bd5a","arm":1,"runId":"qds-20260823-679d1c","outcome":"ready","vmName":"qds-20260823-679d1c"}
{"fanoutId":"fan-20260823-09bd5a","arm":2,"runId":"qds-20260823-b9b4a7","outcome":"ready","vmName":"qds-20260823-b9b4a7"}
{"fanoutId":"fan-20260823-09bd5a","scores":[{"arm":0,"runId":"qds-20260823-b4d8fe","score":null,…},{"arm":1,…},{"arm":2,…}],"tie":false,
 "rationale":"no step-output source provided — every arm listed unscored; supply --steps-json to rank","timings":{"rankMs":0.98}}

===== COMMAND: bun scripts/fleet.ts teardown qds-20260823-b4d8fe --driver fake --dir .sandbox/runs
torn down: qds-20260823-b4d8fe
===== COMMAND: bun scripts/fleet.ts teardown qds-20260823-679d1c --driver fake --dir .sandbox/runs
torn down: qds-20260823-679d1c
===== COMMAND: bun scripts/fleet.ts teardown qds-20260823-b9b4a7 --driver fake --dir .sandbox/runs
torn down: qds-20260823-b9b4a7

===== COMMAND: bun scripts/fleet.ts rank fan-20260823-09bd5a --dir .sandbox/fanouts --steps-json steps.json   (stdout verbatim)
{"fanoutId":"fan-20260823-09bd5a","scores":[
  {"arm":1,"runId":"qds-20260823-679d1c","score":0.9, "breakdown":{"testPassRate":1,  "uniqueFileCoverage":0.75}},
  {"arm":0,"runId":"qds-20260823-b4d8fe","score":0.74,"breakdown":{"testPassRate":0.9, "uniqueFileCoverage":0.5}},
  {"arm":2,"runId":"qds-20260823-b9b4a7","score":0.4, "breakdown":{"testPassRate":0.5, "uniqueFileCoverage":0.25}}],
 "tie":false,"rationale":"top arm 1 (run qds-20260823-679d1c, score 0.9) leads by more than 0.1","timings":{"rankMs":0.94}}

===== .sandbox/runs — three CLOSED records with three DISTINCT keyHash values =====
qds-20260823-679d1c  state=closed  keyHash=09fd612b7812…  box=qds-20260823-679d1c   (roster beta)
qds-20260823-b4d8fe  state=closed  keyHash=1dd0a409d75a…  box=qds-20260823-b4d8fe   (roster alpha)
qds-20260823-b9b4a7  state=closed  keyHash=41d1e83e200f…  box=qds-20260823-b9b4a7   (roster gamma)
distinct keyHash count: 3

===== .sandbox/fanouts/fan-20260823-09bd5a.json (the AC9 record; rankedAt stamped by rank) =====
{ "fanoutId": "fan-20260823-09bd5a", "pattern": "best-of-n", "n": 3,
  "pin": "fffffffffffffffffffffffffffffffffffffe2e",
  "arms": [
    {"arm":0,"runId":"qds-20260823-b4d8fe","rosterId":"alpha","briefHash":"7a3faf39…"},
    {"arm":1,"runId":"qds-20260823-679d1c","rosterId":"beta", "briefHash":"7a3faf39…"},
    {"arm":2,"runId":"qds-20260823-b9b4a7","rosterId":"gamma","briefHash":"7a3faf39…"}],
  "winner": null, "rankedAt": "2026-08-23T19:27:57.073Z", "closedAt": "2026-08-23T19:27:56.232Z" }
```

Score arithmetic check against AC7: cross-arm union = {dispatcher.ts, verbs.ts, rank.ts, rank.test.ts}
(4 files). Arm 1: passRate 20/20 = 1.0, coverage 3/4 = 0.75 ⇒ 0.9. Arm 0: 18/20 = 0.9, 2/4 = 0.5
⇒ 0.74. Arm 2: 10/20 = 0.5, 1/4 = 0.25 ⇒ 0.4. Top-two delta 0.16 > 0.1 ⇒ tie false. ✓

**Honest deltas (not fabricated):**
1. **Bundles:** the fake driver's boxes carry no git history or artifacts, so DF2.5's harvest step
   reports `"harvested":"none"` and no bundle directories appear under `.sandbox/runs/<run-id>/`.
   The three record FILES are what `.sandbox/runs/` holds. Real exe.dev arms would produce real
   bundles at the same lifecycle point.
2. **Invocation route:** pure-shell `bun scripts/fleet.ts …` would need a live OpenRouter
   provisioning key for the per-arm key mints (no env escape for the key client exists), so the
   demo drives the CLI's exported `run()` with FakeKeyApi/FakeDriver/goodLedger injected — the same
   seams cli.test.ts's mandatory e2e uses. Argv, flag parsing, output shaping and exit codes are
   the production paths.
3. **Ranking is two-phase:** run ids do not exist before `fanout` runs, so `--steps-json` cannot be
   supplied to the in-fanout auto-rank; it lists arms unscored with the rationale above (by design),
   and the scored table comes from `fleet rank <id> --steps-json …`.

### Deviations / corrections proposed (SOURCE WINS)

- **K12 (proposed): in-process lock-refusal code is `fleet-lock-reentrant`, not `fleet-busy`.**
  The AC8 patterns test races two FULL `fanout()` invocations inside one process (seam barrier at
  the admission await, per D14). fleet-lock.ts hoists the own-pid re-entrancy guard ABOVE every
  contention branch (r8 HIGH), so the same-process loser gets exit 5 `fleet-lock-reentrant`; the
  cross-process refusal AC8's prose describes (`fleet-busy`) is proven separately by
  fanout.test.ts's subprocess race. Both codes are exit 5 and both write nothing. The spec sketch
  said "fleet-busy" for this test; source wins, test pins reality.
- **Exit-code refinement for `race`:** the shorthand "exit 1 from any non-ready arm outcome"
  would make every SUCCESSFUL race exit 1 (losers are the expected disposition). Implemented rule:
  exit 1 iff any arm is setupFailed/armFailed/armUnknown; `lostRace` alone does not fail the
  invocation. Identical behavior for best-of-n/many-stories.
- **rank's `--dir` means the FAN-OUT records directory** (`.sandbox/fanouts`), not the runs dir —
  rank reads no run record (K11 dropped that dep). Documented on the registry entry; discovered
  operationally during this demo (passing `.sandbox/runs` yields a correct exit-4 refusal).
  Proposed follow-up: teach rank.ts's `fanout-not-found` remediation to mention `--dir` explicitly.
- **No interrupt handlers on the fanout verb** (dispatch installs them because IT can orphan a box
  mid-flight with no record): fanout's fleet-lock module already releases its lock on SIGINT/SIGTERM;
  orphaned-arm recovery rides the story's own admission/record evidence. Residual noted, not
  silently dropped.


---

## Hardening Revision — 2026-08-20

**Changes from original 2026-08-11 spec:**
- **Driver registration citation:** Added explicit citation of `src/providers/index.ts`'s `resolveDriver(name)` mechanism per R2 S3 (actual implementation).
- **Security INV-2 strengthened:** Added "fail-closed" language and explicit `reason: "list-unverified"` refusal case per R3 doctrine.
- **Security INV-4 extended:** Added management URL redaction with regex `[0-9a-zA-Z%-]{16,}` per R3 redaction doctrine.
- **Security INV-5 renamed and strengthened:** Renamed from "fail-closed" to "fail-closed teardown" with explicit per-arm guard preservation language per R3 doctrine.
- **Security INV-6 added:** Finite caps doctrine (N bounds, wall-clock ceilings) per R3 finite-cap pattern.
- **AC5 clarified:** Made host-side polling composition explicit (no `driver.observe` method added to port) per R2 S3 findings.
- **DOD trimmed:** Reduced from 20 to 10 checkboxes by merging redundant test items and removing duplicate integration/security entries.
- **Files to Modify:** Kept at ≤10 unique paths (no change needed — was already compliant).
- **Campaign fixes 2026-08-20:** DF3.2-M1, DF3.2-L1.

---

## Review Findings — BMAD adversarial review, 2026-08-23 (PR #128)

Seven parallel reviewers (3 blind chunk reviewers, 3 edge hunters with repo access, 1 spec auditor) over a
5-chunk split of the full branch diff, plus the Sift bot's 7 inline findings folded into triage.
Full ledger: `_bmad-output/evidence/df3-2/pr128-triage.md` (committed; formerly `/tmp/pr128-review/triage.md`).

### Patched (source)

- [x] **Race poller adopted persisted winner** (`fanout-primitive.ts`) — mutate refuse branch left `claimed`
  null, so a cross-process loser re-probed to the 1h ceiling holding the fleet lock; at ceiling healthy arms
  flipped `armUnknown` and escaped loser teardown entirely (N−1 paid VMs leaked). Losers now adopt and return
  the persisted winner immediately.
- [x] **Reclaim TOCTOU** (`fleet-lock.ts`) — classify→`rmSync` was blind; two contenders judging the same
  stale lock could each delete the other's fresh claim (two holders, AC8 void). Reclaim now re-reads and
  byte-compares the judged body before unlink; mismatch re-classifies.
- [x] **Darwin start-time TZ bug** (`fleet-lock.ts`) — `ps lstart` wall-clock parsed in reader-local time;
  writer under TZ=UTC vs operator shell could see a live owner as "recycled pid" and reclaim it. Lock body
  gains optional `lstartRaw`/`lstartUtcMs` (TZ-free compare via `Date.UTC`, legacy numeric fallback).
- [x] **Semaphore permit handoff** (`fanout-primitive.ts`) — release decremented AND woke a waiter that never
  re-incremented; drift would defeat the width cap for any future multi-phase acquire caller. Transfer semantics.
- [x] **Advisory auto-rank exit flip** (`scripts/fleet.ts`) — rank/store failure after all-ready arms reported
  N provisioned boxes as refused. Rank block isolated: stderr warn, arm-derived exit preserved.
- [x] **CostLedger built before admission** (`scripts/fleet.ts`) — race pattern with schema-failing brief still
  created its SQLite db off the default dir. Gated on brief validity, wired to resolved dir.
- [x] **Rank input guards** (`rank.ts`) — non-negative integer counts, changedFiles array-of-strings,
  composite clamped to [0,1], single-arm rationale no longer claims a margin over nothing.
- [x] **Record validation** (`fanout.ts`) — winner must be null or in `[0, arms.length)`, enforced write+read;
  atomicReplace fsyncs the dir (crash can't resurrect pre-mutate records).
- [x] **Smalls**: markDestructive inside try · width floor 1 · capMicroUsd validated exit 2 pre-lock ·
  explicit concurrency clamped to MAX · lock-dir chmod verified 0700 · ps failure wrapped FleetError ·
  force-release effective after signal-interrupted destructive phase · roster ""→absent · ledger.close guarded ·
  costLedger stripped from DispatchDeps · steps-json parsed before mkdir/chmod · arm lines gain fanoutId.

### Patched (tests)

- [x] `/malformed|n/i` regex tightened (matched nearly every message); sibling weak-shape sweep clean.
- [x] All six `--steps-json` refusal branches probed through the CLI front door (block was deletable while green).
- [x] Unknown-id rank test made hermetic (was mkdir-ing `.sandbox/fanouts` into the repo tree).
- [x] New pin: one loser's failing destroy never wedges disposal (harvest-before-destroy preserved, destructive
  mark cleared); mandated-lock-body assertion updated for optional identity keys.

### False positives / dismissals (verified against source)

- Sift "lock.acquire() not awaited" — `acquire()` is synchronous.
- Sift "isAlive may throw" — fails closed internally (try/catch, non-ESRCH ⇒ alive).
- Sift shellQuote test mirror — intentional isolation (prod loosening must not loosen the probe).
- fsyncDir/rmQuiet duplication — established module-private idiom; bodies byte-identical (verified).
- rmQuiet "already exported" premise — it isn't exported; no fleet.ts import exists.
- `--dir` producer/consumer split-brain — b916396 already fixed the live path (constructor resolves);
  symmetry made explicit.

### Deferred / documented

Orphan temp sweeper (two accumulation paths, inert to list()) · fleetUnwinding permanent latch ·
polymorphic stdout rows undocumented · metric names durationMs/rankMs vs spec arm_dispatch_ms/rank_ms ·
AC7 letter (empty scores) unreachable for real all-failed records under K11 · record pin stamps requested
SHA (verification delegated to DF3.1 fill gate).

Gates at close: fleet focal suites 472 pass / 0 fail (7 files) · full suite 3338 tests, 1 fail = documented
pre-existing gitnexus AC-1 index-reader · tsc --noEmit clean · biome clean · detect_changes blast radius
confined to this PR's modules.

## Review round 2 — Sift/Gemini/CodeRabbit comments on PR #128 (2026-08-24)

Triage of the post-round-1 review batch against HEAD `6a54683`. Several findings were STALE — posted
against pre-`6a54683` revisions and already fixed by that commit; each is listed with its disposition.

### Patched (source)

- [x] **Reclaim verify+rm serialized** (`fleet-lock.ts`) — the r10 byte-compare narrowed but did not close
  the reclaim TOCTOU: between compare and `rmSync`, a SECOND reclaimer can remove the judged stale body and
  a contender claim fresh bytes, which our pending unlink then destroys → two holders. Contenders cannot
  interleave there (claim's link refuses while any body occupies the path); only fellow reclaimers can.
  Verify-and-rm now runs under a dedicated `<path>.reap` mutex: bounded wait (250 ms), dead-pid/mtime steal
  proofs for an abandoned holder, signal-release registered. Deterministic tests: foreign LIVE mutex blocks
  the unlink (stale body survives both attempts → fleet-busy); ABANDONED mutex (dead pid) stolen without
  waiting out the budget.
- [x] **Corrupt final.json no longer spins to the ceiling** (`fanout-primitive.ts`) — journal.ts publishes
  the marker by temp+rename, so persistent parse failure is corruption, not latency. After 3 consecutive
  unusable reads (`MARKER_UNUSABLE_TICKS_LIMIT`) an arm is reclassified armUnknown and dropped from polling;
  record still closes and the lock releases through the existing finally. Was listed as a deferred design gap.
- [x] **Null arms element refused through the malformed taxonomy** (`fanout.ts`) — `(null as Record<…>).arm`
  escaped validateFanoutRecord as a bare TypeError instead of naming record + field.
- [x] **rank refuses testResults:null** (`rank.ts`) — same named invalid-step-output refusal the CLI's
  --steps-json gate gives; previously died as "Cannot read properties of null" at the library boundary.
- [x] **rank declares exit 6** (`verbs.ts`) — the shared `finish` folds EAGAIN-refused stdout into 6 for
  every verb that emits one; rank's omission was a registry-contract gap. Pinned by a new cli.test.ts e2e
  ("a rank whose scored table cannot print exits 6 with rankedAt stamped") + allowlist entry in verbs.test.ts.
- [x] **loserLedger.close() follows the ONE cleanup policy** (`scripts/fleet.ts`) — was guarded-but-silent;
  now prints `ledger-close-failed` and downgrades an otherwise-clean fanout to exit 6, matching teardown's/
  harvest's stated policy verbatim.
- [x] **rmQuiet deduplicated** — exported from `fanout.ts` and imported by `fanout-primitive.ts` (already
  downstream of it). `fsyncDir` stays module-private per file DELIBERATELY: sharing it would couple
  fleet-lock.ts to the store module it must sit beneath.

### Dispositions of stale/wrong findings (no change)

- "Race poller continues after other process wins" — already fixed in round 1 (mutate callback adopts the
  persisted winner); reviewer saw a pre-`6a54683` revision.
- "`/malformed|n/i` overly broad" — already tightened to `/malformed/i` in round 1's test patches.
- "Auto-rank must be isolated" — already isolated in round 1 (own catch → stderr warn).
- "`lock.acquire()` not awaited" — acquire is synchronous by signature and body; awaiting sync void is a no-op.
- "`isAlive()` may throw" — fails closed internally (try/catch around kill, non-ESRCH ⇒ alive) and the pid
  is range-guarded before the call; the suggested `catch { return "reclaim" }` would convert unobservable
  holders into steals, violating the module's doctrine.
- shellQuote mirrored into patterns.test.ts — intentional isolation (a loosened production quoter must not
  loosen the test's own probe rewriting).

### Story-evidence reconciliation

- Gate evidence above mixes two runs (wave-1b snapshot vs close gate). Both retained as historical record;
  see the dated addendum below for one internally consistent run.
- DoD e2e-demo criterion labeled PARTIAL (bundles) — see the annotation on the DoD item.
- Review ledger committed to `_bmad-output/evidence/df3-2/pr128-triage.md`; `/tmp` reference replaced.

**One-run addendum (2026-08-24, post-round-2 patches, HEAD = round-2 commit):** full suite in ONE run —
3332 pass + 8 skip + 2 todo + 1 fail = **3343 collected** across 99 files; the 1 fail is
`tests/gitnexus/graph-queries.test.ts` ("gitnexus_impact — 'registerSwarmClawAgent'…"), re-verified
pre-existing by direct rerun (same AC-1 index-reader failure round 1 documented). Fleet focal suites green:
fanout+rank 56 · verbs 74 · cli 110 · patterns 30 — 0 fail. `bunx tsc --noEmit` clean; biome clean on all
touched files; `detect_changes` blast radius confined to this PR's modules.

### Round-2 gates

Fleet focal suites (fanout/patterns/rank/verbs/cli): all green post-change · `bunx tsc --noEmit` clean ·
biome clean on all touched files · detect_changes run before commit. Full-suite numbers recorded in the
addendum below.

## Review round 3 — bmad-code-review on full branch diff (2026-08-24, HEAD `6af62af`)

Seven parallel reviewers (5 blind chunk reviewers incl. two test-chunk specialists, edge-src with repo
access, spec auditor) over a 5-chunk split of the 6,958-line diff, plus the Sift bot's post-round-2
inline batch folded into triage. ~100 raw findings → 21 patch items, rest dismissed against source
(full ledger: `_bmad-output/evidence/df3-2/pr128-triage.md`, round-3 addendum; working notes
`/tmp/pr128-r3/triage.md`). Fix waves: 2 source-cluster fixers + 1 cli/rank fixer, then 2 standalone
test-hardening agents after sources settled.

### Patched (source — fleet-lock.ts)

- [x] **Cross-TZ identity compare could steal a LIVE holder's lock** — round-2's r10 "TZ-stable UTC
  arithmetic" premise was inverted: `ps` renders digits in the READING shell's TZ, so
  `Date.UTC(reader-local-digits)` ≠ writer value for the same instant. Identity comparison now uses
  the observer-self-consistent `localMs === pidStartTime` unconditionally; `lstartRaw`/`lstartUtcMs`
  remain recorded as operator evidence only. Regression pin: live holder with off-by-half-day
  `lstartUtcMs` must refuse, never reclaim.
- [x] **Reap-mutex litter sweep no longer age-judges judgeable-ish bodies** — object-with-pid bytes
  (missing pidStartTime / out-of-range pid) wait out the budget instead of being swept after 1 s;
  sweep strictly for unparseable/no-pid bytes.
- [x] **acquireReapMutex loop bounded** — deadline re-checked after a successful steal; steal treats
  only ENOENT as vanish evidence (EACCES/EIO ⇒ wait, not spin).
- [x] **release() non-ENOENT read failure keeps the lock releasable** — registration (and destructive
  mark) restored before rethrow so signal/exit handlers retry instead of stranding until death+1h.
- [x] **Zombie holders reclaimed** — `pidIsZombie()` probe (linux `/proc` state Z, darwin `ps -o stat=`);
  a SIGKILLed fan-out whose CI parent never reaps no longer wedges the fleet forever.
- [x] Dir-mode failure typed as FleetError(5,"fleet-lock-dir-mode") · fleet-busy remediation mentions
  mid-reclaim hand-off · steal-mutex race tests moved to new dedicated tests/fleet/fleet-lock.test.ts.

### Patched (source — fanout-primitive.ts)

- [x] **Bounded loser teardown** — disposeLosers wraps each teardownSandbox in a deadline
  (LOSER_TEARDOWN_TIMEOUT_MS, default 5 min): one hung exec can no longer park between
  markDestructive/clearDestructive and wedge every future fleet operation behind the lock.
- [x] Marker-unusable counter reset on any usable read (doc always said "consecutive"; code now
  matches) · consecutive transport-skip bound (MARKER_TRANSPORT_SKIP_LIMIT=60) so persistent
  EACCES/timeouts can't poll the full ceiling under the lock · marker size cap (1 MiB ⇒ unusable,
  no unbounded JSON.parse of a runaway final.json) · race tmp staging via mkdtemp 0700 dir (kills the
  predictable-/tmp symlink class) · roster entries refused when empty/duplicated ·
  pollIntervalMs/perCallDeadlineMs/ceilingMs validated ≥1 at the public seam.

### Patched (source — scripts/fleet.ts + rank.ts)

- [x] **Structural refusals hoisted pre-construction (INV-2)** — unknown pattern, pattern min-N,
  roster-forbidden/required/count refuse before keyApi/store/loserLedger constructors run. Precedence
  preserved exactly (pinned by verbs.test.ts's declared-exit-codes probes): flag-syntax gates
  (`--n`, `--cap-micro-usd`) first, then brief parse errors, then roster-forbidden, then
  pattern/min-N/roster shape. Pin check runs after the known-pattern guard.
- [x] --steps-json capped at 1 MiB (named refusal; MAX_BRIEF_BYTES parity) · --n regex ceiling
  decoupled from FANOUT_MAX_N · rank's assertStepOutputShape refuses non-object outputs and counts
  past Number.MAX_SAFE_INTEGER under the same invalid-step-output code.

### Patched (tests — wave 2)

- [x] **Fanout arm-failure exit rule e2e (was entirely untested)** — setupFailed⇒1, armUnknown-at-
  ceiling⇒1, lostRace-only⇒0 through the CLI front door.
- [x] Race gateFail precedence (ready:false AND thrown variants) · per-arm capMicroUsd enforcement
  path (RecordingLedger pins what assertWithinBudget receives) · harvest-stage loser-teardown failure
  (commitSha-stamped fixture so harvest really execs) · 2-of-3 mass-failure batch · FANOUT_MAX_N
  accepted edge · exact STALE_MS boundary pin (`>` semantics) · dead-pid re-verified at plant sites ·
  refusal-matrix err.code/message assertions · stdout JSON-lines keyed contract pinned · oversize
  steps-json + unknown-pattern CLI refusals · rank non-object/MAX_SAFE_INTEGER/duplicate-runId
  characterization.

### False positives / dismissals this round (verified against source)

best-of-n leaves arms alive + closedAt stamped (INV-5 + advisory human-closes-loop design) · failed/
armUnknown boxes never auto-destroyed (INV-5 verbatim) · store.set is patch/merge semantics
(RunRecordPatch) · auto-rank null stamp does not brick re-rank (rank has no rankedAt guard; winner set
only by race poller by design) · empty-briefs zero-arm record impossible (pre-lock validation) ·
best-of-n --n 1 enforced downstream with the advertised message · unmatched steps keys named in
rationale · hostTag/writeLockDirect exports + src→scripts/lib inversion documented deliberate ·
loser-ledger SQLite file created pre-admission — REAL; initially deferred to #129, then FIXED in
round 4 via lazy first-use construction in the CLI (no factory seam was required — see the triage
ledger's round-4 addendum) ·
CWD-relative library defaults = CLI-owned resolution discipline (prior rounds' disposition).

Gates at close: fleet focal suites 501 tests green modulo the documented K8/AC5 load flakes (pass
solo) · bunx tsc --noEmit clean · biome clean on all touched files · detect_changes blast radius
confined to this PR's modules (run + fanout flows only).

Round 4 (+3 pins ⇒ 501): hung-loser-teardown deadline pin (patterns), --steps-json directory
refusal probe and fleet-busy-no-money-file pin (cli) — all pass solo; full-file runs during a host
load spike (LA 200-300 from unrelated VM/Chrome/tsserver processes) reproduce ONLY the documented
5s-timeout flakes with a mutating failure set, including at HEAD via stash A/B.

## Review round 5 — bmad-code-review on full branch diff (2026-08-24, HEAD `07deeef`)

Nine reviewers over a 6-chunk split of the 8,212-line diff (3 blind source, 3 edge test-suite with
repo cross-check, 1 acceptance auditor; two agents died on context and were respawned as half-chunk
tests-patterns-A/B + a slim auditor retry — chunk budget held ≤1,623 lines). 24 raw findings →
12 patch (2 source, 10 test), 1 decision-needed resolved conservatively, 11 dismissed with source
evidence (full ledger: `_bmad-output/workflow-state/code-review/pr128-r5/triage.md`).

### Patched (source — wave 1)

- [x] **Reap-mutex steal-success path sleeps before retrying the claim** (fleet-lock.ts
  acquireReapMutex) — steal→failed-claim→steal cycles previously retried with zero tick sleep,
  burning CPU until the deadline; the retry now pays one REAP_MUTEX_TICK_MS, tightening the bound the
  round-3 budget check established. Impact: LOW, 1 caller, behavior-preserving.
- [x] **runRace hoists `undecided()` to one call per poll iteration** (fanout-primitive.ts) — was
  computed twice (while-condition + for-loop). Impact: LOW, behavior-preserving.

### Patched (tests — wave 2)

- [x] cli.test.ts: retitled the misleading "scored table" case (it has no --steps-json — all scores
  null); verbs.test.ts coveredBy binding updated to match; new `--n 0` explicit boundary refusal;
  new empty `{}` --steps-json happy-path case (exit 0, all scores null, tie:false); 1 MiB cap comment
  arithmetic corrected (JSON wrapper is 9 bytes, not ~12).
- [x] fanout.test.ts: readOwnPidStartTime sanity windows loosened to 10-year clock-skew tolerance
  (stability across calls is the source's real guarantee); new pid boundary refusals (0 and
  0x8000_0000 — one past pidmax); create:false store now proves list() reads work.
- [x] rank.test.ts: null-scored arm's breakdown pinned ({testPassRate: 0, uniqueFileCoverage: 0});
  new identical-scores tie case (different runIds) pins tie:true, exactly-equal scores, stable
  arm-0-first ordering, "tie flagged" rationale, and the no-automatic-tie-break contract.
- [x] patterns.test.ts: validation section gains the many-stories n=1 POSITIVE case (min-N asymmetry
  previously asserted only via rejections).

### Decision-needed → resolved conservatively

- [x] **AC9 schemaVersion explicit-vs-implicit** (auditor, LOW): spec quotes
  `extensions.fanout = { schemaVersion: 1, … }`; the stamp site writes `{ fanoutId, arm }` and the
  store layer auto-injects schemaVersion for EVERY extension namespace (run-record.ts
  validateExtensions). On-disk shape matches the spec exactly. Resolved: no code change — making one
  call site literal would diverge from the cross-namespace injection contract every other extension
  write follows. Auditor's own assessment: "No action required unless explicit literal compliance is
  demanded."

### False positives / dismissals this round (each verified against source before dropping)

Two HIGH "signal-handler race" findings are impossible as described: `onSignal` is fully synchronous
and Node delivers signals serialized through the single-threaded event loop, so the fleetUnwinding
check-then-set cannot interleave; `process.listeners(sig)` returns same-signal listeners only, so the
borrow-strip-reraise loop cannot remove another signal's handler · cross-process stale-winner HIGH
re-describes the exact failure mode round 3's adopt-persisted-winner mutate already fixes (per-record
run-lock; loser learns HERE and tears down) · disposeLosers "stale entrants" MED concedes its own
filter reads current outcomes — correct exclusion, single-threaded · semaphore "active drifts above
width" MED misreads the handoff: the woken waiter resumes after `await` without re-calling acquire,
and only the fast path increments (gated `active < width`) · lstartUtcMs "dead code" is deliberate
round-3 forensic evidence ("RECORDED ONLY", TZ-unsafe to compare — removing it deletes the
cross-TZ-identity debugging trail) · CLK_TCK hardcode carries its ponytail ceiling annotation ·
rmQuiet leak is the function's named best-effort contract · cross-process lock-coverage gap MED:
real Bun.spawn two-process lock races already exist (fanout.test.ts req-race-a/b) · onProbe timing
and first-writer-atomicity LOWs: reviewer-self-assessed acceptable/covered · auditor AC table:
17/18 PASS, 1 PARTIAL (the AC9 note above).

Gates at close: full fleet focal suite 506/506 green (K8 flaked once under host load 13.5, passed on
re-run and at close — the documented load-flake set) · verbs↔cli exit-code title binding regression
from the P3 retitle caught by the suite and fixed in the same round · bunx tsc --noEmit clean ·
biome clean on all 7 touched files · detect_changes: 1 symbol touched (runRace), 0 affected
processes, LOW risk — blast radius confined to this PR's modules.
