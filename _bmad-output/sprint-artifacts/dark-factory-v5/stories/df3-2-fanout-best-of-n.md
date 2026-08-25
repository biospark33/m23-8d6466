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
      ranking table with rationale — captured in the Dev Agent Record

## Dev Agent Record

<!-- Empty placeholder — filled during development. -->

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

## Handoff from df3-1 review round 10 — the fleet-ceiling TOCTOU goes LIVE the moment fan-out ships (DF13)

**Source:** df3-1 BMAD review round 10, finding DF13 (MED, deferred to the providers/quota
layer). Ledger: `_bmad-output/workflow-state/code-review/pr123/triage.md` · evidence:
`…/code-review/pr123/reports/edge-dispatch-src.md`.

**The seam:** `src/providers/quota.ts` — `checkHeadroom` is a READ, not a lock (its own
docstring says so), and `src/fleet/dispatch.ts` step-5 admission samples it locklessly. The
design note in dispatch.ts (~lines 1728-1753) declares the FLEET-CEILING half "NOT closed":
two dispatches entering admission within one `driver.list()` round trip while
`liveVms === ceiling - 1` BOTH pass and both create. The ledger's orphan window closes the
MONEY half of this race; the BOX half is what stays open.

**Why it becomes yours:** a single `dispatch` races only other invocations — and the FAN-OUT
half of that race is closed by AC8 as built: the `.sandbox/fleet.lock` spans admission plus
all N mints, a second concurrent fan-out is refused `fleet-busy`, arms enter through
`{ admitted: true }`, and there is exactly ONE `checkHeadroom(N)` inside the lock. What
stays OPEN is plain `dispatch()`: it holds no fleet lock, so two concurrent single
dispatches — or a single dispatch racing a fan-out's admission window — can still both
sample `liveVms === ceiling - 1` and both create. Round 10 pinned today's behavior
deliberately: `tests/fleet/dispatch.test.ts`, the two-DISTINCT-id concurrency test (barrier
parked inside checkHeadroom's driver.list against maxVms=1 ⇒ both admitted). That pin now
DOCUMENTS the residual seam: keep it red-by-design until the quota layer closes the
cross-invocation half — do not delete it, and do not promise to flip it. The acceptance
signal for the shipped half is AC8's own: a second concurrent fan-out refused
`fleet-busy` with nothing created.

**Remaining direction (only if cross-invocation closure for SINGLE dispatches is wanted):**
a quota-layer intent record mirroring cost-ledger's `admitIssue` — BEGIN IMMEDIATE
write-ahead row (reserve slot → create → settle/release on failure), reusing that
transaction's conventions rather than inventing new ones. THAT is what flips the pinned
two-distinct-dispatch test red-to-green. Routing every single dispatch through the fleet
lock is the wrong tool — it would serialize unrelated issues behind one operator-wide lock.

**Adjacent graces to keep in mind at N>1** (deferred FP8/FP10, deliberate): run-record's
own-pid lock steal and temp sweep fire after 60 s stalls. Concurrent arms sharing one pid
that pause >60 s mid-critical-section (debugger, SIGSTOP) can have locks stolen / temps
swept by a sibling arm. Fine at current scale; worth a comment where fanout parks arms.
