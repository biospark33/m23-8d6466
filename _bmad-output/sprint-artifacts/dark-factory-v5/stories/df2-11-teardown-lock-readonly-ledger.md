# DF2.11: Teardown Run-Lock Capability + Read-Only Cost Ledger

**Story Points:** 3

**Status:** done

**Sprint:** v5-S3

## Spec Reference

- **Provenance — derived 2026-09-08 from the pre-dev adversarial review**
  (`_bmad-output/sprint-artifacts/dark-factory-v5/2026-09-08-remaining-stories-pre-dev-review-tracker.md`).
  Both defects are in **merged, shipped code**, not in a spec: this story fixes production, it does
  not add a feature. Findings: **DF3.8-B2** ("shipped-code gap — reaper takes no run lock; AC2's
  mutex excludes the wrong process"), **DF5.4-B3** ("C10 writes; INV-GATE-1's *the gate's only write
  is the report file* is false"), **DF5.3-H1** ("`readRunCost` is a class method, and constructing
  the ledger writes"). Tracker follow-up rows **F1** and **F3**, and cross-cutting theme **CC-5**.
- `docs/superpowers/specs/2026-08-11-dark-factory-v5-architecture-design.md` §3.4 (harvest across
  the credential-free gap), §5.3 (teardown ordering), §6 item 4 (host-side cost ledger that survives
  box destruction)
- Decision register: v5 §4 **D8** (no push credential in any box — which is *why* harvest is the
  only path work leaves a box), **F10/R9** (two independent evidence layers)
- Predecessor stories, cited not modified: `df2-5-bundle-harvest-teardown.md` (the six-step teardown
  and its abort semantics), `df2-8-cost-ledger-budget-cap.md` (INV-COST-1..6, the close-step
  `ingestBoxHours` hook), `df5-1-host-side-reverify.md` **Status line + change row 9** (the prior
  hardening of this repo's lock family: approval-lock pid reclamation via a liveness check, atomic
  claim via `renameSync`, fail-closed restore on a failed post-claim write — none of which this
  story contradicts)
- Downstream consumers whose specs already name this gap: `df3-8-host-completion-watcher.md`
  **AC2(e)** and **INV-IBOX-18** (which state, correctly, that the sweep's mutex cannot exclude
  `sandbox-reap --yes`, and that "the one-line reaper-side fix is filed as a code follow-up outside
  this story's scope"); `df3-7-approval-gate-bridge.md` **INV-IBOX-16** (the lock lives in the
  caller because `acquireRunLock` is not re-entrant); `df5-4-lights-on-gate.md` **C10 /
  INV-GATE-1**; `df5-3-audit-chain-extended.md` **hop 3**

## User Story

As the operator whose factory destroys boxes and audits its own spend,
I want the unsafe call to be the one the type checker rejects — teardown without the run lock, and
a "read" of the cost ledger that writes to it —
so that a concurrent reap can never eat a run's only copy of its work, and the gate that verifies
the ledger is not also the process that created it.

## Overview

Two trust-boundary defects in shared provider code, one story because they are the same defect
shape: **a shared function lets a caller do the unsafe thing by default**, and both are closed by
making the safe path the only callable path rather than by documenting the hazard.

`teardownSandbox` (`src/providers/teardown.ts:463`) takes `(deps, runId, opts)` and does not know
whether the caller holds `<runsDir>/<runId>.lock`. Two of its seven callers hold one; five do not,
and `src/providers/reaper.ts` contains **zero** references to any lock symbol while calling
`teardownSandbox(teardownDeps, unit.id)` bare at `:726`. This story makes the run lock a **required
parameter** of the shared function — a `RunLockHandle` only `scripts/lib/run-lock.ts` can produce —
so an unlocked teardown does not compile. Callers that already hold one pass it; the rest go through
a `withRunLock(...)` wrapper. There is no boolean, because a boolean lies and a handle cannot, and
no internal acquisition, because `acquireRunLock` is documented **not re-entrant**
(`RunLockReentrantError`, `run-lock.ts:72-78`, guard at `:951` — **these are the correct lines**;
DF3.8 `:79` and DF3.7 `:128` cite `:66-79`/`:952` for the same symbols, which are off by one, and
are not this story's to fix) and an acquisition inside the shared
function would deadlock the callers that already hold — which DF3.7's chain and DF3.8's sweep both
will.

`CostLedger`'s constructor (`src/providers/cost-ledger.ts:874-934`) `mkdirSync`s the directory 0700,
`chmodSync`s it, asserts the mode, opens `new Database(this.path)` — **which creates the file when
absent** (`:895` computes `isNew` for exactly that reason) — chmods 0600, asserts, then runs the WAL
pragma and `db.exec(SCHEMA)`. Every reader therefore mutates the artifact it reads, and a reader on
a host with no ledger **manufactures an empty one and reads zero spend as within budget**. INV-COST-6
guards the *unopenable* ledger (`:900-905`) and says nothing about the *absent* one. This story adds
a genuine read-only construction path that refuses an absent ledger instead of creating it, so
DF5.4's `INV-GATE-1` becomes **true** rather than being weakened to match the code.

## E2E Slice

**Demonstrable behavior — defect 1:** Given run `qds-demo-lockrace` with an open record, a live box
and three commits on `sbx/<run-id>`, When a `sandbox-reap --yes` sweep and a `bun
scripts/sandbox-teardown.ts <run-id>` are started concurrently against it, Then exactly **one** of
them harvests — the loser refuses with `RunLockedError` (`code: "run-locked"`), the reaper counting
it as a named skipped unit rather than a sweep failure — `git rev-list --count
<base>..refs/sandbox/<run-id>` prints `3`, `<runsDir>/<run-id>.bundle` exists exactly once and is a
complete bundle that `git bundle verify` accepts, and `driver.destroy` is recorded **once**.

**Demonstrable behavior — defect 2:** Given a host with **no** `.sandbox/cost-ledger.db`, When
`CostLedger.openReadOnly({ path })` is called, Then it throws `CostLedgerError` with
`code: "ledger-absent"`, `existsSync(path)` is still `false`, `.sandbox/` was **not** created, and
no caller can mistake the outcome for `totalMicroUsd: 0`. Given a ledger that *does* exist, a
read-only open plus `readRunCost(runId)` leaves the directory listing, every file mode and every
file mtime byte-identical to a snapshot taken before the call.

**Wiring closed:** On completion of this story every production `teardownSandbox` call site holds a
run lock, proven by the type checker rather than by review, and the cost ledger has a read path that
writes nothing. No stub, no `TODO: wire later`. DF3.7's chain and DF3.8's sweep consume the
capability; they do not rebuild it. DF5.4's gate calls `openReadOnly` and its INV-GATE-1 becomes
assertable.

**Dependency edges (predecessors):** **DF2.5** (owns `teardownSandbox`, its six-step order and its
abort semantics), **DF2.8** (owns `CostLedger`, INV-COST-1..6 and the close-step `ingestBoxHours`
hook). Both are `done`.

**Sequencing note (not an edge): DF2.12 edits the same four files.** DF2.12 (`v5-S3`,
`ready-for-dev`, same sprint) also modifies `src/providers/teardown.ts`,
`tests/providers/teardown.test.ts`, `src/providers/cost-ledger.ts` and
`tests/providers/cost-ledger.test.ts`, adding two ingest calls at `teardown.ts:608`/`:757` and
assertions in the same test file where **this story rewrites 53 `teardownSandbox(` call sites**.
**This story lands first** — its signature change is mechanical and total, DF2.12's is additive at
two points — and DF2.12 rebases onto the new signature. Recorded here and mirrored in DF2.12 so the
order is a decision made at planning, not a 53-site conflict discovered at merge.

**Downstream consumers (not predecessors):** **DF3.7** wires `GateDeps.teardown` in production and
passes the handle it already holds; **DF3.8**'s sweep is the eighth call site and inherits the
capability; **DF5.4** is the consumer of the read-only path (C10 / INV-GATE-1); **DF5.3** hop 3
reads through the same path. None of them is blocked *on* this story to start — each is made
correct by it, and each currently carries prose conceding a gap this story closes.

## Acceptance Criteria

1. **(make-or-break — the unlocked call does not compile)** Given `teardownSandbox`'s signature is
   `(deps: TeardownDeps, runId: string, lock: RunLockHandle, opts?: TeardownOptions)`, When a call
   omits the handle or passes a plain `string`, Then `tsc --noEmit` — an existing repo gate —
   **fails**. This is pinned, not merely asserted in prose: `tests/providers/teardown.test.ts`
   carries a `// @ts-expect-error` line immediately above an unlocked
   `teardownSandbox(deps, runId)` call, so if a later edit ever makes the parameter optional the
   directive becomes an unused-`@ts-expect-error` error and the typecheck gate goes red. A
   `RunLockHandle` is producible **only** by `scripts/lib/run-lock.ts`; nothing outside that module
   and the test fixtures may construct or cast one. *Negative controls, both MUST fail: a `lockHeld?:
   boolean` option (a caller can pass `true` while holding nothing); and a `RunLockHandle` declared
   as a plain `type RunLockHandle = string` alias — under which the **arity** check still catches a
   two-argument call (`TS2554`), so a test written against arity alone goes green while
   `teardownSandbox(deps, runId, "/tmp/anything")` still **compiles** and the capability degrades to
   a positional convention. The pinned assertion is therefore **two** directives, not one: a
   `// @ts-expect-error` on the two-argument call **and** a `// @ts-expect-error` on a call passing
   a bare string literal in the lock position. Branding is what the second one tests; arity is not.*
2. Given `teardownSandbox` is called with a handle for a **different** run, When it runs, Then it
   refuses before any mutation with `TeardownError { code: "teardown-lock-mismatch" }`, the box is
   untouched (`driver.destroy` recorded **zero** times) and the record is still open. The handle
   carries the run it was taken for, so this is a real check and not a type-level fiction. *Negative
   control: an implementation whose handle is an unqualified token satisfies AC1 and MUST fail this
   test — holding run A's lock is not permission to tear down run B.*
3. Given two `teardownSandbox` invocations against one runId in one process and across two
   processes, When both start, Then exactly one proceeds and the other receives `RunLockedError`;
   the harvest spy records exactly **one** `git bundle create` and exactly **one** `driver.destroy`
   for that run, and the surviving `<runsDir>/<runId>.bundle` passes `git bundle verify`. *Negative
   control: the shipped `main` behaviour — the reaper's bare call at `reaper.ts:726` racing
   `scripts/sandbox-teardown.ts` — records two of each and MUST fail this test.*
4. Given the reaper's sweep encounters a run whose lock is held, When the unit runs, Then the unit
   is recorded as a **named, counted skip** — `{ runId, code: "run-locked", message, remediation }`
   in `SweepReport.failures`, not an exception out of `sweep()` — the sweep continues to its
   remaining units, and a **stale** lock (`RunLockedError.remediation` already distinguishes it,
   `run-lock.ts:57-63`) is reported with its own wording and its `rm` line rather than folded into
   the benign skip. The `--yes` sweep's own destructive window is marked
   (`markRunLockDestructive`) and cleared only on the unit's success path, so an interrupted reap
   leaves the lock for an operator to judge — the posture `scripts/fleet.ts:4562` and
   `scripts/sandbox-teardown.ts:288` already take. *Negative controls: a lock refusal that aborts
   the whole sweep (one busy run stops the fleet's hygiene); and a reaper that releases its lock on
   an interrupted teardown, handing a half-torn-down run to the next sweep.*
5. **(defect 2 — the read path refuses an absent ledger and creates nothing)** Given a path at which
   no ledger file exists, When `CostLedger.openReadOnly({ path })` is called, Then it throws
   `CostLedgerError { code: "ledger-absent", message, remediation }`; `existsSync(path)` is `false`
   after the call, `dirname(path)` was **not** created if it did not exist, and no `-wal` or `-shm`
   sibling was written. *Negative control: today's constructor path — `mkdirSync` at `:885`,
   `new Database(this.path)` at `:898` — creates both the directory and the file, and a
   subsequent `readRunCost` returns `{ totalMicroUsd: 0, hasEvents: false }`, which a budget or gate
   reader is entitled to read as "within budget". That implementation MUST fail this test.*
6. Given a ledger that exists, When it is opened with `openReadOnly` and `readRunCost(runId)` /
   `readIssueCost(repoSlug, issueId)` / `readIssueRuns(...)` are called, Then a snapshot of the
   ledger — **the ledger file, its directory entry and the `-wal` sibling**, each by name,
   `mode & 0o777` and `mtimeMs` — is **identical** after it, and the returned view equals the view the
   read-write path returns over the same data. Any write method reached on a read-only handle
   (`ingestCostEvent`, `ingestBoxHours`, `admitIssue`) throws `CostLedgerError { code:
   "ledger-readonly" }` **before** touching the database, and the row count is unchanged.
   **`-shm` is excluded from the snapshot, and its exclusion is asserted as deliberate**: on a
   healthy WAL database a read-only connection may map the shared-memory index, so
   `assertQueryable()`'s `SELECT 1` can touch it. It carries no rows, so nothing observable is lost
   — the snapshot would only go flaky. (The story elsewhere addresses the *recovery-required* WAL
   case; this is the healthy one.)
   *Negative controls: an implementation that keeps the `chmodSync`/`statSync` mode assertions on
   the read path fails on mtime for a ledger whose mode is already correct only by luck, and fails
   outright for one that is not; an implementation that runs `db.exec(SCHEMA)` on the read path
   creates the tables in an empty file and MUST fail AC5 as well.*

## Trigger Surface

| Trigger | Status | E2E Test | Follow-Up |
|---------|--------|----------|-----------|
| `teardownSandbox` signature + handle assertion | in-scope | `tests/providers/teardown.test.ts` | — |
| `withRunLock(runsDir, runId, holder, fn, opts?)` wrapper in `scripts/lib/run-lock.ts` | in-scope | `tests/scripts/run-lock.test.ts` | — |
| `sandbox-reap --yes` sweep taking the per-run lock, skip/stale classification | in-scope | `tests/providers/reaper.test.ts` | — |
| fan-out loser disposal (`src/fleet/fanout-primitive.ts:1328`) under the per-run lock | in-scope | `tests/fleet/fanout-primitive.test.ts` | — |
| `scripts/cap-hit-demo.ts` three call sites (`:494`, `:539`, `:1174`) | in-scope | `tests/providers/cap-hit-demo.test.ts` | — |
| `GateDeps.teardown` docblock contract — the wired closure carries a handle | in-scope (docblock + type only) | `tests/fleet/approval-gate.test.ts` | DF3.7 wires it in production. **Round-3/4 note:** review rounds re-pinned additional approval-gate behaviors (inclusive expiry oracle B13, reportId/approverId door caps B6/B22, identical-reportId rebind refusal B1, promotion restamp B8, over-bound stored-reportId append-skip R4-12) — authorized by the round-3 record, not by an original AC row |
| `CostLedger.openReadOnly()` + read-only write refusals | in-scope | `tests/providers/cost-ledger.test.ts` | — |
| `qds cost` reading through `openReadOnly` | in-scope | `tests/scripts/qds-cost.test.ts` | — |
| DF3.8's `--all` sweep acquiring the lock and passing the handle | out-of-scope | — | DF3.8 |
| DF5.4's C10 calling `openReadOnly` and asserting INV-GATE-1 | out-of-scope | — | DF5.4 |
| DF5.3 hop 3 reading through the read-only path | out-of-scope | — | DF5.3 |
| A hand-run `scripts/reverify.ts` taking no run lock (F106) | out-of-scope — **narrowed, not retired**, exactly as DF3.7/DF3.8 state | — | none scheduled |
| Merging `approval-gate.ts`'s `<runId>.teardown.claim` into the run lock | out-of-scope — see Technical Notes | — | DF3.4-owned; filed, unscheduled |

## Infra Prerequisites

| Component | Service (compose/k8s/provider) | Lifecycle Hook Verified |
|-----------|-------------------------------|-------------------------|
| Per-run invocation lock `<runsDir>/<runId>.lock` | `scripts/lib/run-lock.ts` — host filesystem only, no service | `bun test tests/scripts/run-lock.test.ts` green before and after; the module's `claim`→`linkSync`→`writeLockDirect` fallback, its `hostTag()` pid-namespace qualification and its no-steal property are consumed **unmodified** |
| Run record store `<runsDir>/<runId>.json` | DF2.1 store, host filesystem | `assertValidRunId` already runs inside `acquireRunLock` (`run-lock.ts:937`) before the path join, so the wrapper introduces no new path-injection surface |
| Host-side ledger `.sandbox/cost-ledger.db` | `bun:sqlite`, bundled with the project's bun toolchain — **no new dependency** | a read-only open of an existing ledger succeeds and mutates nothing; a read-only open of an absent one refuses; a read-only open of a ledger with an un-checkpointed `-wal` is a **typed** refusal, never a silent read-write fallback (Technical Notes) |
| Provider box + `exec`/`copyFile` | exe.dev driver (DF2.2); `fake` driver in tests | unchanged — this story touches no driver call and no teardown step |

## Technical Notes

- **The handle: a branded token `acquireRunLock` already returns.** `acquireRunLock(runsDir, runId,
  holder)` returns the resolved lock path today (`run-lock.ts:965`) and six call sites feed that
  string straight into `releaseRunLock`, `markRunLockDestructive`, `clearRunLockDestructive` and
  error templates. So the handle is that same value under a **branded** type —
  `export type RunLockHandle = string & { readonly [RUN_LOCK_BRAND]: true }` with a module-private
  `unique symbol` — which means: (a) every existing consumer keeps compiling with **zero** edits,
  because a branded string *is* a string; (b) a bare `string` is **not** assignable to
  `RunLockHandle`, so AC1's typecheck failure is a language guarantee and not a lint convention;
  (c) forging one requires a written `as RunLockHandle`, which is greppable and is banned outside
  `run-lock.ts` and test fixtures by AC1's DoD grep. **This is the reuse rung, not a new
  abstraction:** no new class, no new lifetime, no new release path. The runtime half of AC2 is one
  comparison — `resolve(handle) === resolve(runsDir, \`${runId}.lock\`)` — using the same `resolve`
  the module already keys `held` on (`:950`), because a relative and an absolute spelling of one
  directory used to be two keys for one file.
- **Why a handle and not a `lockHeld` boolean, said once.** A boolean is a claim the callee cannot
  check; the handle *is* the proof, because the only way to obtain one is to have won the claim. It
  also gives AC2 for free: a boolean cannot say *which* run it is about.
- **Why the callee never acquires.** `acquireRunLock` is explicitly not re-entrant — a second
  acquire in one process throws `RunLockReentrantError` (`run-lock.ts:72-78`, guard at `:951`), a
  design DF3.7 **INV-IBOX-16** and DF3.8 **AC2(b)** both depend on and both state as the reason the
  lock lives in the caller. An acquisition pushed into `teardownSandbox` would refuse
  `scripts/fleet.ts`'s teardown verb (holds since `:4257`), `scripts/sandbox-teardown.ts` (holds
  since `:230`), and DF3.7's whole chain — the exact deadlock those two stories wrote their
  invariants to avoid.
- **`withRunLock` is nine lines and exists so five call sites do not each write them.**
  `withRunLock(runsDir, runId, holder, fn, opts?)`: acquire → `try { return await fn(handle) }` →
  `finally { releaseRunLock(handle) }`. The one option is `{ destructive?: true }`, which calls
  `markRunLockDestructive(handle)` before `fn` and `clearRunLockDestructive(handle)` **only** on
  `fn`'s success path. That option is not speculative: the reaper, the fan-out loser disposal and
  the cap-hit demo all reach a point of no return (box destroyed, key revoked) and the mark is what
  makes an interrupt into that window safe — `releaseHeldRunLocks` refuses to unlink a marked lock
  (`:441-446`) and leaves it for an operator, which is this module's stated posture. Marking is
  deliberately **not** moved inside `teardownSandbox`: `scripts/fleet.ts:4562` and
  `scripts/sandbox-teardown.ts:288` already mark around it and own their clear-on-success, and
  relocating the mark would change their behaviour in a story whose whole point is that teardown's
  semantics are untouched.
- **The seven call sites and how each migrates** (all verified at `fa7d0e26`; GitNexus `impact`
  reports `teardownSandbox` upstream as **CRITICAL**, 7 direct callers, 8 affected processes, 3
  modules):

  | # | Site | Holds a lock today? | Migration |
  |---|------|---------------------|-----------|
  | 1 | `scripts/fleet.ts:4578` (`runDestructive`) | **yes** — `acquireRunLock(store.dir, runIdArg, "fleet invocation")` at `:4257`, marked destructive at `:4562`, cleared at `:4595` | **re-type the existing `lock` declaration to `RunLockHandle \| undefined` and narrow before the call**, then pass the handle it already has. `:4257` is an assignment to a variable declared earlier and cleared at `:4595` inside a `try`/`catch`, so its declared type widens to include `undefined`; the narrowing is a real edit. No lifecycle change |
  | 2 | `scripts/sandbox-teardown.ts:290` | **yes** — `acquireRunLock(store.dir, parsed.runId, "sandbox-teardown")` at `:230`, marked at `:288`, cleared at `:294` | same: **re-type to `RunLockHandle \| undefined` and narrow**, then pass the handle. No lifecycle change |
  | 3 | `src/providers/reaper.ts:726` (`sweep`) | **no** — the module contains zero lock references | `withRunLock(deps.store.dir, unit.id, "sandbox-reap", h => teardownSandbox(teardownDeps, unit.id, h), { destructive: true })`, with `RunLockedError` classified per AC4 |
  | 4 | `src/fleet/fanout-primitive.ts:1328` (`disposeLosers`) | **no** — it holds DF3.2's fleet-wide `FleetLock`, a different granularity | `withRunLock(..., o.runId, "fanout loser teardown", …, { destructive: true })` **per loser**, inside the existing per-loser `try`, so a locked loser is one logged `loser-teardown-refused` arm and never aborts disposal |
  | 5 | `scripts/cap-hit-demo.ts:494` (`makeCleanup`) | **no** | `withRunLock`; the demo mints its own `runId` (`newId("df2-4-cap-hit", …)`) so contention is structurally impossible and the wrapper costs one line — but the cleanup thunk must keep its "never throws" contract, so a `RunLockedError` there is swallowed and logged exactly as the existing `catch {}` does |
  | 6 | `scripts/cap-hit-demo.ts:539` (`finishEarly`) | **no** | `withRunLock`; a refusal keeps the existing `teardownOk = false` arm |
  | 7 | `scripts/cap-hit-demo.ts:1174` (step 11, "Teardown (ALWAYS)") | **no** | `withRunLock`; same refusal arm |

  Plus the **injected seam** `GateDeps.teardown` (`src/fleet/approval-gate.ts`, the `GateDeps.teardown`
  docblock — `:840` is a line *inside* that docblock, not the property declaration; cite the symbol),
  whose only
  current caller is the live e2e at `tests/fleet/e2e/tier1-approval-gate.live.test.ts:352-354`. Its
  signature `(runId, opts) => Promise<void>` is **unchanged**; only its docblock gains the contract
  that the wired closure must already carry a handle, because DF3.7's production wiring runs inside
  a chain that holds the run lock and a `withRunLock` there would throw
  `RunLockReentrantError`. **The eighth call site is DF3.8's sweep,** which acquires the lock itself
  by its own AC2(b) and therefore lands on this signature already correct.
- **What this does NOT fence, stated as plainly as DF3.8 states it.** A hand-run
  `scripts/reverify.ts` still takes no run lock (F106 — narrowed, not retired); `fleet dispatch`'s
  own acquisition is deliberately non-fatal on refusal (`scripts/fleet.ts:1976`); and
  `approval-gate.ts`'s `withTeardownClaim` is a **second** per-run mutex on a different path
  (`<runId>.teardown.claim`). Two mutexes over one run is a lock-ordering hazard, and the order is
  stated rather than enforced here: **run lock first, teardown claim second, never the reverse** —
  which is what the shipped call graph already does, because the claim is taken inside a path the
  caller entered holding the run lock. Merging the two is DF3.4's file and DF3.4's call; it is
  filed, not done here, because doing it would change an approval-path timeout and this story's
  premise is that behaviour outside the lock parameter is untouched.
- **`openReadOnly` is a static factory on the same class, not a second class.** The consumers need
  `readRunCost`, `readIssueCost`, `readIssueRuns`, `emitTokenBridgeState` and `close` — all already
  methods of `CostLedger` and all already read-only in behaviour. So
  `static openReadOnly(deps: CostLedgerDeps): CostLedger` sets a private `#readOnly` flag and takes
  a constructor path that: (1) performs a **no-create open** — `openSync(path, "r")`, refusing
  `ledger-absent` on `ENOENT` — and **holds that fd open** until a post-construction
  `fstatSync(dbFd).ino === probedIno` verdict, refusing `ledger-identity-changed` on mismatch.
  **Never a bare `existsSync`.** `{ readonly: true }` closes the *creation* half of the C5 race
  (a missing file refuses instead of materialising) but not the *identity* half: between an
  existence check and the open, the ledger can be replaced, and `qds cost` would then report a
  different file's totals as the run's authoritative spend — on the same ledger the budget cap and
  DF5.4's C10 read. This is the guard `qds-cost.ts:276-281` already ships and documents as
  already-fixed; `openReadOnly` **inherits** it rather than replacing it.
  *Negative control: an implementation whose refusal is `existsSync(path)` followed by an open
  passes every absent-ledger test and MUST fail a test that swaps the file between the two calls.*
  Then (2) `new Database(path, { readonly: true })`; (3) runs **no** `mkdirSync`, **no**
  `chmodSync`, **no** mode assertion, **no** `PRAGMA journal_mode = WAL`, **no** `db.exec(SCHEMA)`.
  `assertQueryable()` (`cost-ledger.ts:1483`) is kept — it is a `SELECT 1 FROM cost_events LIMIT 1`
  that touches the btree and writes nothing, and it is what keeps INV-COST-6's fail-closed posture
  on the read path. The three write methods gain a one-line `#readOnly` guard that throws
  `ledger-readonly` before any statement.
- **Named ceiling — a read-only open of a WAL database.** SQLite cannot open a database read-only
  when an un-checkpointed `-wal` needs recovery and no writable `-shm` exists; the honest answer is
  a **typed** refusal, `CostLedgerError { code: "ledger-wal-recovery-required" }`, naming the
  remediation (any writer — a teardown, or `qds cost` on its read-write path — checkpoints it; the
  ledger's own `close()` and DF2.8's pragma posture make this the ordinary state after a clean
  teardown). It is **never** a fallback to a read-write open, because a gate that heals the artifact
  it audits is exactly the independence DF5.4 needs and does not have. DF5.4's C10 renders this as a
  named `skip`, exactly as it already renders the absent-ledger case. **Considered and rejected:**
  an `immutable=1` URI open, which bypasses WAL entirely and provably writes nothing — rejected as
  the default because it also ignores a live writer's uncommitted WAL and would read a *stale*
  total, and a stale spend figure read as authoritative is the same class of defect as a fabricated
  zero. Upgrade path if the WAL refusal ever proves noisy in practice: `immutable=1` **plus** a
  recorded `staleness: "wal-ignored"` field on the view, so the staleness is reported rather than
  hidden.
- **Guards/limits, unchanged and restated because this story is adjacent to both.** The ledger's
  0700 directory and 0600 file modes stay enforced on the **write** path (`cost-ledger.ts:885-916`)
  and are **not** touched on the read path — reading a ledger is not the moment to repair its
  permissions, and a read path that chmods is a write. The lock's no-steal property, its
  `IMPLAUSIBLE_HOLD_S` diagnosis-only widening (`run-lock.ts:475`) and its refusal to mark a foreign
  or unreadable lock stale are consumed unmodified; this story adds no TTL, no steal and no second
  lock protocol.
- **Deviation/assumption:** the concurrency arm of AC3 is proven against the `fake` driver and a
  real throwaway git repo, in the same shape DF2.5's suite already uses; the two-process arm spawns
  a second `bun` invocation so the `link(2)`-based claim is exercised across real process
  boundaries rather than through the in-process `held` map. exe.dev remains recorded `[VERIFY]`
  single-origin (R5 §6 fact 11) and no live box is required for either AC.
- **Estimate honesty.** 3 points covers the design (the brand, `withRunLock`, the required
  parameter) and the 7 production migrations. It does **not** independently cost the **53**
  `teardownSandbox(` call sites in `tests/` that the required parameter breaks by construction
  (`grep -rn 'teardownSandbox(' tests | wc -l` → 53, verified 2026-09-08), nor the read-only
  ledger's WAL-refusal path, nor the inode-probe relocation. The blast-radius paragraph below
  frames those 53 breaks as a virtue — they are, but a virtue still has to be typed. **If the test
  migration cannot be done with a mechanical codemod plus one shared `h.lock` fixture, this is a
  5.** Flagged here rather than discovered mid-sprint with 53 edits half-done.
- **Grep is not a trustworthy gate on `run-lock.ts` until PR #238 lands, and the guard outlives it.**
  A zero-match grep and a grep the tool refused to read produce the same output. `scripts/lib/run-lock.ts`
  currently holds **two raw NUL bytes** (the separator in a composite cache key,
  `` reapTtlCache.get(`${runsDir}\x00${runId}`) `` — NUL is *correct* there because it cannot occur
  in a path, so **do not strip it**; the defect is the raw byte where a `\x00` escape is
  runtime-identical and leaves the file ASCII-clean). While they are present `file` reports `data`
  and `grep -c RunLockReentrantError` exits 1 even though the symbol is at `:72` — verified
  2026-09-08 on `dev`, where **PR #238 is OPEN, not merged**. Consequence for this story: every
  lock-symbol grep it relies on (the "zero lock symbols in `reaper.ts`" evidence, and any DoD grep
  over `run-lock.ts`) **must pair its zero-match assertion with a positive control on the same
  file** — one pattern that MUST match. A failed control means *unproven*, never *clean*. Keep the
  pairing after #238 merges: it is what catches the next raw byte, and #238 only fixes today's.
- **`emitTokenBridgeState`:** DF2.12 reclassifies this method's **message**; this story depends
  only on its being **read-only**, which both readings preserve. No conflict, but see the
  sequencing note.

## Observability Contract

- Every lock acquisition taken by a **new** wrapper site logs
  `{ requestId, runId, operation: "run-lock.acquire", holder, outcome, durationMs }` where
  `outcome ∈ acquired | refused-busy | refused-stale`, and every refusal carries
  `{ code: "run-locked", message, remediation }` — the `remediation` verbatim from
  `RunLockedError`, which already prints the exact `rm` for a proven-dead holder and deliberately
  does **not** for an unreadable or foreign one.
- The reaper's per-unit skip rides `SweepReport.failures` with the same `{ runId, code, message,
  remediation }` shape its existing failures use, so `sandbox-reap`'s report needs no new field and
  no new renderer.
- `openReadOnly` logs `{ requestId, operation: "cost-ledger.open", mode: "read-only", ledgerPath,
  outcome, durationMs }` with `outcome ∈ opened | ledger-absent | ledger-wal-recovery-required |
  ledger-unqueryable | ledger-unopenable | ledger-identity-changed` (round-4 widening: the two
  added values are the open path's typed refusals — an uncheckpointed-WAL/errno surface and the C5
  replace-race fence; the mode-broad WARN from D5 rides the same `cost-ledger.open` operation with
  outcome `mode-broad-warn`, added round 2, re-parented to the contract operation in round 4). **No lock diagnostic and no ledger log line ever carries key material**: the
  lock body is `<pid> <host> <ISO> <nonce>` and carries none, and ledger rows carry `key_hash`, never
  the plaintext (INV-COST-5). Sub-timings: `lock_acquire_ms`, `ledger_open_ms`; where a sub-step is
  not separately measurable it reports `0` and the caller's `durationMs` is authoritative.

## Files to Modify

- `scripts/lib/run-lock.ts` — **adds only**: the `RunLockHandle` branded type + its module-private
  brand symbol, `acquireRunLock`'s return type narrowed from `string` to `RunLockHandle` (a
  source-compatible narrowing — every existing consumer takes `string`), and `withRunLock`. No
  change to `claim`, `refuse`, `releaseRunLock`, `restore`, the signal-release discipline or the
  destructive-mark semantics.
- `src/providers/teardown.ts` — DF2.5-owned; **adds only** the required `lock: RunLockHandle`
  parameter on `teardownSandbox` (`:463`) and the AC2 mismatch assertion at its head, before
  `teardownSteps`. **No change to the six steps, their order, or their abort semantics**, and no
  change to `teardownSteps`' own signature beyond threading nothing — the check lives entirely in
  the wrapper at `:463-470`. **Round-3/4 note:** the six-steps claim refers to the steps' own
  logic; review rounds added artifacts-record-failure nullish normalization (round 3) and the
  D3-class WAL-note leading on attach-failure refusals, both re-pinned in-branch.
- `src/providers/reaper.ts` — DF2.6-owned; the `withRunLock` wrap at `:726` and the AC4
  skip/stale classification. **Note for DF3.8:** that story's INV-IBOX-18 currently promises
  `reaper.ts` stays *byte-identical*; this story is the sanctioned edit its own AC2(e) filed as "the
  one-line reaper-side fix … filed as a code follow-up", and DF3.8's invariant text is amended by
  DF3.8, not by this story.
- `src/fleet/fanout-primitive.ts` — DF3.2-owned; the per-loser `withRunLock` wrap at `:1328` and
  the `loser-teardown-refused` arm.
- `scripts/cap-hit-demo.ts` — the three wraps at `:494`, `:539`, `:1174`.
- `src/fleet/approval-gate.ts` — DF3.4-owned; **docblock only** on `GateDeps.teardown` (`:840`)
  stating the wired closure must carry a handle. No signature change, no behaviour change.
- `src/providers/cost-ledger.ts` — DF2.8-owned; `static openReadOnly`, the `#readOnly` guard on the
  three write methods, and the `ledger-absent` / `ledger-readonly` /
  `ledger-wal-recovery-required` codes on `CostLedgerError`.
- `scripts/qds-cost.ts` — reads through `openReadOnly`. **Its existing pre-check is NOT an
  `existsSync` check and is NOT deleted.** Read `qds-cost.ts:275-290` before touching it: the guard
  is a **no-create `openSync(ledgerPath, "r")` + `fstatSync(fd).ino` inode probe whose fd is
  deliberately held open across the `CostLedger` construction** and compared afterwards. Its own
  comment says why, in the file, for exactly this reader: *"The pre-check is a NO-CREATE open, not
  existsSync(): both answer 'is it there', but the open also yields the inode that answer was about
  — which is what closes the C5 race"*, and *"With the fd closed early, a replace-and-restore
  across the CostLedger open window could forge that equality — the restored copy is a new inode
  wearing the old number"*. (Verified 2026-09-08: `grep -n existsSync scripts/qds-cost.ts` returns
  exactly one hit — line 276, inside that comment, saying it is *not* one.) The guard is
  **retained and moved inside `openReadOnly`**, so every reader inherits it rather than just this
  CLI.
- `tests/providers/teardown.test.ts`, `tests/providers/reaper.test.ts`,
  `tests/providers/cost-ledger.test.ts`, `tests/scripts/run-lock.test.ts`,
  `tests/fleet/fanout-primitive.test.ts`, `tests/scripts/qds-cost.test.ts`,
  `tests/providers/cap-hit-demo.test.ts`, `tests/fleet/e2e/tier1-approval-gate.live.test.ts` (the
  injected closure at `:352-354` takes a handle).

**Blast radius (GitNexus `impact`, upstream, `fa7d0e26`):** `teardownSandbox` — risk **CRITICAL**,
7 direct callers, 8 affected processes (`runCapHitDemo`, `runDestructive`, `fanout`, `runFanout`,
`scripts/sandbox-reap.ts run`, `reaper.sweep`, `scripts/sandbox-teardown.ts run`,
`cap-hit-demo main`), 3 modules (Scripts 10, Fleet 2, Providers 1), depth-3 reach 16 symbols. Every
one of those is a **compile-time** break by construction — which is the point: the story's safety
argument is that no caller can be missed, and the typechecker enumerates them rather than a reviewer.
`CostLedger`'s constructor is **not** modified, so the read-only path adds no upstream risk to the
existing write path.

## Security Invariants

- **INV-LOCK-1 (the capability is the proof, and it is unforgeable outside its module):** a
  `RunLockHandle` is produced only by `acquireRunLock`. `teardownSandbox` — the function that
  destroys a box, revokes a key and closes a record — cannot be reached without one, and a handle
  for another run is refused before any mutation. No boolean, no environment variable and no
  convention substitutes for it.
- **INV-LOCK-2 (harvest-before-destroy is not weakened by the lock change):** DF2.5's fixed order —
  spend → artifacts → commits → revoke → destroy → close — and its abort semantics (a harvest
  failure leaves the box alive and the record open, INV-5) are **byte-for-byte unchanged**. The
  handle is checked *before* step one and never inside the sequence, so no failure path acquires a
  new way to skip a step. Asserted by the existing subsequence/relative-order call-order tests,
  which this story does not rewrite.
- **INV-LOCK-3 (a refusal is never a silent skip):** every path that cannot obtain the lock records
  a typed, remediated outcome — `RunLockedError` out of a CLI, a named counted failure out of the
  sweep, a logged arm out of fan-out disposal. A destructive verb that could not run and said
  nothing is indistinguishable from one that ran, which is the failure mode this story exists to
  remove.
- **INV-LOCK-4 (no secret on argv, in a lock body, or in a diagnostic):** the lock body is
  `<pid> <host> <createdAt-ISO> <nonce>` and gains no field; no `sk-or-` material, no key hash and
  no run key enters a lock file, a lock diagnostic, a sweep failure record or a ledger log line.
  DF2.3's INV-CRED-3 (payload on stdin, never argv) is untouched — this story adds no process spawn.
- **INV-COST-7 (a read is a read):** the read-only path performs no `mkdirSync`, no `chmodSync`, no
  mode assertion, no pragma and no schema execution, and **refuses an absent ledger rather than
  creating one**. An absent ledger is never read as zero spend — the clause INV-COST-6 states for an
  *unopenable* ledger, now true for an *absent* one, which is what makes DF5.4's INV-GATE-1 ("the
  gate's only write is the report file") assertable instead of aspirational. The write path keeps
  the 0700 directory and 0600 file modes and their assertions exactly as DF2.8 left them.

## Definition of Done

- [ ] **Impl:** `RunLockHandle` + `withRunLock` exported from `scripts/lib/run-lock.ts`;
      `acquireRunLock` returns the branded type; `releaseRunLock`, the destructive mark and the
      signal-release discipline are unchanged.
- [ ] **Image re-pin (INHERITED DEBT — this story owns it, and it is not optional).**
      `scripts/lib/run-lock.ts` is inside a directory COPY (`oci/exedev/Dockerfile`,
      `COPY scripts/lib/ scripts/lib/`), so **this story moves a tracked image input** and owes
      DF2.10's publish → adopt → re-pin ritual. It also inherits a **standing debt**: PR #238
      (merged `386e12d1`) escaped that file's two raw NUL bytes without re-publishing, and the
      2026-09-08 pin-adoption commit updated the file-input literal in
      `tests/scripts/build-exedev-image.test.ts` while deliberately deferring the republish to
      **this** story, precisely because this story moves the same file again — one republish
      settles both. **Done means:** the image is re-published, `DEFAULT_IMAGE_REF` is adopted to the
      new digest, and the file-input literal is updated **in the same commit**, per the ritual the
      test's own failure message states. *Shipping this story while the published image still
      contains the pre-#238 `run-lock.ts` leaves the boxes running source no commit on `dev`
      matches, and MUST fail review.*
- [ ] **Impl:** `teardownSandbox(deps, runId, lock, opts?)` with the handle/runId mismatch refusal;
      all seven call sites migrated per the Technical Notes table; `GateDeps.teardown`'s docblock
      carries the handle contract.
- [ ] **Impl:** `CostLedger.openReadOnly()` refusing an absent ledger, opening readonly, running no
      mkdir/chmod/pragma/schema — **"no pragma" means no disk-effecting pragma; the round-3 C6
      addition of a connection-local `PRAGMA busy_timeout` is the sanctioned exception** (it never
      reaches disk: the AC6 snapshot stays byte-identical and INV-COST-7 holds), with
      `ledger-readonly` guards on the three write methods.
- [ ] **Contract:** `qds cost` reads through `openReadOnly`, and its no-create inode probe is
      **preserved** — moved into `openReadOnly`, not deleted (a diff that removes the `openSync` +
      held-fd + post-construction `ino` comparison is a rejection: it re-opens the C5
      replace-and-restore race); `CostView`'s schema and every field name are unchanged, so DF5.3 and DF5.4 read the
      same shape from either path.
- [ ] **Integration:** `sandbox-reap --yes` takes the per-run lock, marks its destructive window and
      classifies refusals per AC4; fan-out loser disposal takes it per loser.
- [ ] **Security:** no `RunLockHandle` cast exists outside `scripts/lib/run-lock.ts` and the test
      fixtures — asserted by a repo grep for `as RunLockHandle` in the DoD, not by review;
      INV-LOCK-4 asserted by a grep of every new log line's key set.
- [ ] **Test (typecheck gate, AC1):** the `// @ts-expect-error` unlocked call in
      `tests/providers/teardown.test.ts` keeps `bunx tsc --noEmit` green **only while the parameter
      is required**; a fixture branch making it optional turns the directive into an unused-directive
      error and reds the gate. An implementation using `lockHeld?: boolean` or a bare `string` alias
      MUST fail this item.
- [ ] **Test (handle mismatch, AC2):** `teardownSandbox(deps, "run-b", handleForRunA)` →
      `teardown-lock-mismatch`, zero `driver.destroy` calls, record still open.
- [ ] **Test (concurrency, AC3):** two teardowns against one runId — in-process and across two
      spawned `bun` processes — yield exactly one `git bundle create`, exactly one
      `driver.destroy`, one `<runsDir>/<runId>.bundle` that `git bundle verify` accepts, and one
      `RunLockedError`. Reverting the reaper's wrap reproduces two of each and MUST fail.
- [ ] **Test (sweep hygiene, AC4):** a sweep over three units where the middle run's lock is held →
      two units executed, one `{ code: "run-locked" }` failure recorded, `sweep()` returns normally;
      a **stale** lock produces its own wording and its `rm` line; an interrupted destructive unit
      leaves the lock in place (`releaseHeldRunLocks` refuses it) and prints the operator line.
- [ ] **Test (absent ledger refuses, AC5 — MANDATORY):** `openReadOnly` against a path under a
      **non-existent** directory → `ledger-absent`; `existsSync(path) === false` and
      `existsSync(dirname(path)) === false` after the call. A test that constructs the ledger the
      old way first and then asserts the refusal is a false green and MUST NOT be the evidence.
- [ ] **Test (read path mutates nothing, AC6):** directory snapshot (names + `mode & 0o777` +
      `mtimeMs`) identical across `openReadOnly` + all three views; `ingestCostEvent` /
      `ingestBoxHours` / `admitIssue` on a read-only handle → `ledger-readonly` with the row count
      unchanged; the read-only view equals the read-write view over the same data.
- [ ] **Test (WAL ceiling is typed, Technical Notes):** a ledger with a non-empty `-wal` and no
      `-shm` → `ledger-wal-recovery-required`, and the file set on disk is unchanged. An
      implementation that falls back to a read-write open passes a naive "the read worked" test and
      MUST fail this one.
- [ ] **Test (e2e demo — MANDATORY):** against a real throwaway git repo and the `fake` driver, a
      three-commit run is torn down while a second teardown races it; capture as an artifact the
      winner's `git rev-list --count <base>..refs/sandbox/<run-id>` = `3`, the loser's
      `RunLockedError` payload, the single `driver.destroy` call record, and — from the same run —
      a before/after ledger-directory snapshot proving `openReadOnly` wrote nothing.

## Dev Agent Record

**Implemented 2026-09-08** — branch `feature/df2-11-teardown-lock-readonly-ledger`, orchestrated build (unlazy scope `df2-11`, 8 leaves / 3 branches, 4 dispatch waves). All ACs met; evidence in `.unlazy/df2-11/gates/*.md`.

### What shipped
- **RunLockHandle** — branded `string & { readonly [RUN_LOCK_BRAND]: true }`, module-private `declare const` symbol, exported only from `scripts/lib/run-lock.ts`; `acquireRunLock` narrowed (source-compatible); sole internal cast is the brand's only mint in `scripts/` (root gate greps it, positive control paired). `withRunLock(runsDir, runId, holder, fn, {destructive?})`: success → clear+release; throw non-destructive → release; throw destructive → neither (lock left for the operator — the arm deliberately never calls releaseRunLock). `tests/scripts/run-lock.test.ts` created **new** (W6-E-M4 acknowledged): 7 tests incl. cross-process refusal via `Bun.spawn`.
- **teardownSandbox(deps, runId, lock, opts?)** — head check first statement: `typeof lock !== "string" || resolve(lock) !== resolve(deps.runsDir ?? deps.store.dir, \`${runId}.lock\`)` → `TeardownError "teardown-lock-mismatch"` before any mutation. AC1 pinned twice in `tests/providers/teardown.test.ts` (`@ts-expect-error` on the 2-arg call AND on a bare-string-in-lock-position call — the pin dies loudly if the param ever becomes optional or de-brands). All 52 in-file call sites migrated via a memoized `lockFor(runId)` fixture; `:770` keeps `{noHarvest:true}` as 4th arg. AC2 test: wrong-run handle → refusal, `driver.destroy` 0, record open. Order/subsequence assertions untouched (INV-LOCK-2: the diff touches import + signature + head check only).
- **Seven call sites**: `scripts/fleet.ts` + `scripts/sandbox-teardown.ts` re-typed `let lock: RunLockHandle | undefined` and pass the handle (control-flow narrowed, no lifecycle change); `src/providers/reaper.ts` sweep wraps the teardown unit in `withRunLock(deps.store.dir, unit.id, "sandbox-reap", …, { destructive: true })` under the existing `withTimeout`, classifying `RunLockedError` into `SweepReport.failures` `{runId, code:"run-locked", message, remediation}` (splice-out of `executed.teardown`; stale wording distinct w/ rm line; sweep continues); `src/fleet/fanout-primitive.ts` wraps per-loser inside the existing try → `loser-teardown-refused` arm, disposal loop continues; `scripts/cap-hit-demo.ts` three sites wrapped destructive, makeCleanup keeps never-throws, `:574`/`:1222` keep `teardownOk=false`. `GateDeps.teardown` docblock now states the wired closure must ALREADY hold the run lock (withRunLock there would throw RunLockReentrantError) — signature unchanged. Live e2e closure acquires its own lock.
- **CostLedger.openReadOnly** — no-create `openSync(path,"r")` probe → ENOENT `ledger-absent`; non-empty `-wal` w/o `-shm` → `ledger-wal-recovery-required` (never a read-write fallback); probe fd held across `new Database(path,{readonly:true})` → post-attach ino compare → `ledger-identity-changed`; `ledger-readonly` guard first-statement on ingestCostEvent/ingestBoxHours/admitIssue; read path performs no mkdir/chmod/mode-assert/pragma/schema. AC5 test uses a path under a non-existent dir; AC6 snapshot [db, dir, -wal] name+mode+mtime identical, `-shm` exclusion asserted deliberate; WAL refusal built from real committed frames.
- **qds cost** reads through openReadOnly; the CLI-local probe is moved (not deleted) — rationale preserved in comments, `reportLedgerOpenFailure` maps codes onto the untouched exit taxonomy (`ledger-absent`→`ledger-missing`, `ledger-identity-changed`→`ledger-replaced`); 27 existing qds-cost tests pass unedited.
- **E2E demo** (`tests/providers/df2-11-teardown-race.test.ts`): real `git init` repo, 3 commits, `sbx/` ref; winner in-process + loser as a real spawned `bun` child → `revCount=3`, `destroyCount=1`, `git bundle verify` exit 0, loser payload `code=run-locked` + remediation; same-file ledger no-write proof.
- **Image re-pin**: buildId literal adopted `c315c8b9…` → `f03c118b…` (only three walked inputs moved: run-lock.ts, approval-gate.ts, fanout-primitive.ts). **Post-merge owed:** publish-exedev-image.yml fires on merge to dev; adopt gate B's `DEFAULT_IMAGE_REF` + `DEFAULT_IMAGE_BUILD_ID` (src/providers/exedev/driver.ts) in one commit (DoD image item completes then).

### Negative controls executed
- AC1: both pins live (unused-directive would red tsc); a `string`-alias or `lockHeld:boolean` impl fails by construction.
- AC3/AC4: driver-executed spot-check — reaper wrap replaced by a resolve()-cast forged handle → both run-locked tests FAIL (unlocked teardown executed through a held lock); restored → 42 pass. W6-E's category shift respected: call paths traced, not citations.

### Self-review round (qds-dev Phase 5, pre-PR)
Independent adversarial diff review found 4 non-blocking defects; **all four applied and re-verified** (tsc clean, 306 affected tests + 229 image tests + e2e green): (1) cap-hit-demo's cleanup thunk now probes the record before acquiring — a signal in the pre-createRun window no longer strands a phantom lock; (2) openReadOnly closes the attached db if the constructor throws; (3) the probe fd's close is guarded so an EIO cannot replace a typed refusal; (4) withRunLock never lets a failing releaseRunLock mask fn's error (held entry left for releaseHeldRunLocks). BuildId literal re-adopted to `f03c118b…`.

### Verification
- `bunx tsc --noEmit` clean; biome clean on all owned files; full `bun test` 5500 pass / 0 fail on the final tree (the only 2 reds during the run were the story-consistency checker catching DF2.12's now-stale past-EOF citation of the old qds-cost probe line — fixed in this PR per the checker's own remedy, cite-by-symbol).
- Story-to-code cite corrections absorbed (W6-E-L6/L7): cap-hit test path is `tests/providers/`, INV-LOCK-2's step enumeration is the file header's eight (code wins).

### Sequencing note honored
DF2.12/DF2.13 rebase onto this signature (recorded in the PR body). Issues #499/#500: do not exist in any reachable repo (QDS-Factory max #240) — operator directed proceed-without on 2026-09-08; close-out note carries the same.

### Post-merge completion (2026-09-09)
- PR #241 merged to dev (`039d88fd`); CI green (13m9s).
- **Image re-pin retired**: publish run 34307353550 printed gate B's pair (digest `sha256:719884cc…`, buildId `86cce65c128fd56d`); adoption commit `1164d85d` landed both constants on dev; the adoption-push verify run **34309042051 completed success — publish + attest + attested**. The published image now ships the post-#238 `run-lock.ts` plus this story's lock capability. Tracked-inputs literal (`f03c118b…`) moved in the same merge commit per the same-commit ritual.
- [corrected 2026-09-09: earlier drafts of this record cited buildId digests `9508086e…` and `3486a3b6…`, which resolve nowhere — they appear in no commit and no file; the verifiable values are the tracked-inputs literal `f03c118b…` (moved with merge `85c79e32`) and the adoption pair in the item above.]
- Citations in this story resolved to symbols where code moved (checker: OK — 42 stories, 169 pts).
- Issues #499/#500: do not exist in any reachable repo (QDS-Factory max #240). Operator directed proceed-without 2026-09-08; close-out is this note plus the PR body section — **where**: PR #241 body + this record; **when**: 2026-09-08/09; **how**: searched QDS-Factory, biospark33/QDS-Factory, qds-skills, safeship-ai, QDS-hermes, both disler reference repos; max issue number found was #240.

## Review Findings — round 1 (2026-09-09, post-merge adversarial review of PR #241)

Seven-layer parallel review (blind/edge × src, tests-providers, tests-scripts + acceptance auditor; chunked diffs). 41 raw findings → triage (`/tmp/pr241-review/triage.md`): **21 patched, 8 deferred, 12 dismissed**. All severities incl. LOW handled.

### Patched (all applied and re-verified)
- [x] **P1** withRunLock now emits the story-Observability-Contract `run-lock.acquire` line (`requestId/runId/operation/holder/outcome/durationMs`; outcome `acquired|refused-busy|refused-stale` via a new additive `RunLockedError.stale` field).
- [x] **P2** destructive leave-for-operator arm attaches a stranded-lock remediation to a thrown error that lacks one (same instance; no instanceof break) — "re-run the sweep" no longer dead-ends.
- [x] **P3** WAL-size stat failure no longer conflates unreadable with absent: ENOENT → absent; anything else → typed fail-closed `ledger-unopenable` naming the -wal.
- [x] **P4** `preopenedDb` ctor param branded (module-private `PREOPENED` symbol) — the unhardened write-handle bypass is unconstructible from outside.
- [x] **P5** `assertSameInode` renders NaN as "unknown — the path no longer stats".
- [x] **P6** `openReadOnly` logging aligned to contract (operation `cost-ledger.open`, mode `read-only`, outcome `opened`, `ledgerOpenMs`) + every refusal outcome now emits before rethrow.
- [x] **P7** reaper run-locked arm scrubs `remediation` like every sibling; comment corrected.
- [x] **P8** fanout `loser-teardown-timeout` arm carries remediation naming the process-lifetime stranded lock; ceiling commented.
- [x] **P10** teardown.ts type-only-import comment now states the true rationale (embedder/compilation-unit choice, ADR Q6 accepts the inversion others take).
- [x] **P11** fleet.ts comment states brand = compile gate, head check = resolve-equality, possession = having won acquireRunLock.
- [x] **P12** `reportLedgerOpenFailure` maps `ledger-unopenable` → legacy `ledger-unreadable` + legacy remediation (exit taxonomy restored; no more "remove the file" advice for a possibly-live ledger).
- [x] **P13–P23** test hardening: TRUE simultaneous-claim contention test added to `df2-11-teardown-race.test.ts` (child racer vs in-process racer off overlapping pre-lock timers; winner verified to vary across 12+ runs — no serialized precursor existed anywhere, `run-lock.test.ts`'s is also serialized), marquee test retitled to say it proves serialized refusal; lock-still-exists assertion after successful teardown (read-only-handle half of AC1); write-method refusal completeness over the class surface; WAL-ceiling refusal byte+mtime snapshot; `ledger-unopenable` arms unit-covered (chmod-000 probe arm + ELOOP symlink for the -wal-stat arm — stat(2) needs no file permission, so chmod cannot reach it); zero-byte-WAL rebuilt honestly via real `wal_checkpoint(TRUNCATE)` with non-tautological readback; pid-reuse window comment; fanout undefined-runId guard + honest retitle; AC6 raw-db finally; cap-hit refusal path test added via a store-observing seam (RunRecordStore subclass plants the contended lock at mint time — no source change needed).
- [x] **P24–P30, P34** scripts-tests hardening: bare `toBe` + true comments replacing the fabricated bun:test rationale, destructive-success finally, success-arm release-failure test, withRunLock-reentrancy test, `process.execPath` spawn, qds-cost healer guard + spawnSync timeout, named seam-throw pin, AC1-pin comment sharpened, new `run-lock.acquire` line-shape tests.
- [x] **P31–P33** story-record drift: unresolvable buildId digests corrected with a bracketed note; cite-drift swept (df2-12 + sprint-status rows, cite-by-symbol); cap-hit test path + destructive-arm mechanism wording fixed.
- [x] **Pre-existing reds surfaced by the gate, fixed here:** (a) `image-contract.test.ts` still expected `6f847d4e…` after adoption commit `1164d85d` set driver.ts to `86cce65c…` — pairing literal updated (red on `origin/dev` before this branch); (b) buildId tracked-inputs literal re-pinned `f03c118b… → f322908c…` in the same commit as the input moves (run-lock.ts, fanout-primitive.ts), per the same-commit ritual. Post-merge: publish workflow fires; adoption commit re-pins the driver pair + marker literals.

### Deferred (real, operator-facing design decisions — not this PR)
- D1 reap exit-1 on transient lock refusals (cron noise); D2 sweep revoke unit bypasses the run lock (DF3.8 territory); D3 unwritable-shm WAL reader remediation copy; D4 cap-hit probe TOCTOU window; D5 read path no longer surfaces a mis-moded ledger (INV-COST-7 chose this); D6 live-e2e-only coverage of the gate-seam wrap; D7 snapshot-helper duplication (deliberate copy-ownership); D8 superseded buildId narrative lines kept as historical record.

### Dismissed (verified false/by-design — 12)
Incl.: `RunLockReentrantError` DOES exist (`run-lock.ts:72` — blind layer had no repo access); **P9's premise was false**: `String(Symbol("x"))` returns `"Symbol(x)"` (verified in bun — only implicit `+` conversion throws), so the original mismatch-message builder could never throw; destructive lock-stranding on any throw is AC4's mandated posture; `resolve`-equality identity is the spec's stated mechanism; afterEach double-release is an idempotent no-op; `@ts-expect-error` pins are backed by the tsc repo gate; per-open read logging is the Observability Contract's own requirement.

### Gates (round 1)
`bun test tests/providers/ tests/fleet/ tests/scripts/` → **3014 pass / 0 fail**; `bunx tsc --noEmit` clean; `bunx biome check` clean on all 18 touched files; GitNexus `detect_changes` → 43 changed symbols / 22 files, blast radius contained to this story's own modules (run-lock, cost-ledger, reaper, teardown, fanout, fleet, qds-cost + tests + docs), no out-of-scope symbols.

## Review Findings — round 2 (2026-09-09, deferreds closed)

Round 1 (recorded in PR #242 on `fix/df2-11-review-round1` — this section is written on `fix/df2-11-review-deferreds`, branched off `origin/dev`@`bfd6699e` so the two PRs do not stack) deferred eight findings. Five are closed here; the other three stay where round 1 left them.

### Patched this round
- [x] **D1 (cron noise)** — `scripts/sandbox-reap.ts` `run()`: when `SweepReport.failures` carries `run-locked` rows, one distinct summary line — `N unit(s) refused run-locked — refusals are not failures; the sweep executed M unit(s)` — lets cron/CI tell refusal-noise from real failure. Exit-code contract untouched (non-empty failures on apply still exits 1); `reaper.ts` `SweepReport.failures` docstring now names `run-locked` as a refusal, not a failed unit. Test: `tests/scripts/sandbox-reap.test.ts` ("D1: … prints the distinct summary line and still exits 1") asserts the exact line, the unchanged exit 1, and that the per-unit `!! run-locked:` frames survive.
- [x] **D3 (dangerous remediation copy)** — `cost-ledger.ts`: a new module-private `unCheckpointedWalNote(path)` returns the checkpoint warning when a non-empty `-wal` sibling exists; it LEADS the remediation on both `ledger-unopenable` arms of `openReadOnlyHandle` and on `assertQueryable`'s `ledger-unqueryable` — "the ledger has an un-checkpointed -wal; have any writer checkpoint it (a teardown close, or qds cost on its write path) before touching the file — never remove it" — before any "remove the file" sentence. Absent/empty/unreadable `-wal` ⇒ no note. Four tests in `tests/providers/cost-ledger.test.ts` cover leading-note and quiet-side for both refusal codes (probe-arm EACCES; `assertQueryable` via a real `DROP TABLE` through a raw side handle).
- [x] **D4 (cap-hit TOCTOU)** — `scripts/cap-hit-demo.ts` cleanup thunk: inside `withRunLock`'s fn the record is re-checked under the lock; vanished between probe and acquire ⇒ release-and-return early (fn returns, non-destructive finish clears the mark and releases — nothing thrown past the never-throws contract). A THROWING re-check is not absence: it falls through to teardown, AC3's read-fallback posture unchanged. Test: `tests/providers/cap-hit-demo.test.ts` §4g drives the window deterministically through a `VanishAfterProbeStore` (first armed `get` = the probe, later = gone) and asserts no teardown ran and no lock stranded.
- [x] **D5 (mis-moded ledger invisible on read path)** — `cost-ledger.ts` `openReadOnly()`: WARN-ONLY `statSync` after the open — file broader than 0600 or dir broader than 0700 (bits BEYOND the expected set; narrower is fine) ⇒ one `ledger-mode-broad` warn line per offending target naming path and actual mode. No chmod, no assertion, no throw — a log line is not a write (INV-COST-7 intact; the AC6 no-touch posture is covered by the existing snapshot test, still green). Three tests pin warn-on-broad-file, quiet-on-0600, and warn-on-broad-dir with the mode left unrepaired.
- [x] **D6 (gate-seam wrap only live-tested)** — `tests/fleet/approval-gate.test.ts` pins the `GateDeps.teardown` closure PATTERN documented at `src/fleet/approval-gate.ts` (the `teardown` docstring): a harness closure that acquires its own lock via `acquireRunLock` and passes the real handle to `teardownSandbox` completes teardown and releases; wrapping that same closure in `withRunLock` throws `RunLockReentrantError` (the held-map refusal, not contention), and the failed wrap strands no outer lock. Pattern only — production wiring stays DF3.7's seam.

### Still deferred / dismissed — tracked as issues (2026-09-09)
- **D2** (sweep revoke-unit locking) → **issue #244**, owned by **DF3.8** (`df3-8-host-completion-watcher.md`). The seam was not touched here (AC4/INV-LOCK-3 posture intact). **Close #244 formally when:** DF3.8 is implemented with the revoke unit inside its sweep lock discipline, its PR is merged to `dev` referencing "Closes #244", and this section is updated with that PR number.
- **D6 production half** (GateDeps.teardown production wiring must carry the chain-held handle) → **issue #245**, owned by **DF3.7** (`df3-7-approval-gate-bridge.md`). Only the closure PATTERN is unit-pinned (above); production wiring is DF3.7's. **Close #245 formally when:** DF3.7 wires the production closure passing the chain's `RunLockHandle`, a gated unit test covers the production closure itself, its PR is merged to `dev` referencing "Closes #245", and this section is updated with that PR number.
- **D7 / D8** — stay dismissed per round 1 (deliberate copy-ownership; historical record), re-litigating is churn. No issues: there is no work to track.
- **Closure ritual:** the owning story's PR must reference its issue ("Closes #244" / "Closes #245"); the closer appends the merging PR number to this section in the same change, so this story remains the single index of what happened to every round-1/2 finding.

### Gates (round 2)
`bun test tests/providers/ tests/fleet/ tests/scripts/` → **3016 run, 3015 pass / 1 fail**, the one fail being `tests/providers/exedev/image-contract.test.ts` "a well-formed marker parses to the six keys" — proven red on a clean `origin/dev` checkout (stash-verified) and fixed inside PR #242's pairing-literal commit (merged to dev), not by this branch (per the do-not-stack constraint). Focal suites all green: `cost-ledger.test.ts` 132/0, `cap-hit-demo.test.ts` 34/0, `sandbox-reap.test.ts` 2/0, `approval-gate.test.ts` 144/0, `reaper.test.ts` 42/0. `bunx tsc --noEmit` clean; `bunx biome check` clean on all 8 touched files. GitNexus: `impact()` run before every edit (`run` LOW/1 caller; `assertQueryable` MEDIUM — 5 direct callers, remediation-text-only change, throw behavior untouched; `openReadOnlyHandle` LOW; `runCapHitDemo` LOW); `detect_changes` → 25 symbols / 8 files, risk HIGH by process count, every changed step inside this story's own modules, nothing out of scope. `run-lock.ts` and `fanout-primitive.ts` NOT modified — tracked-inputs literal needs no re-pin on this base (`f03c118b…`, moved to `f322908c…` in #242).

## Review Findings — round 3 (2026-09-09, full-surface re-review of PR #241 + #242 + #243)

Post-merge adversarial re-review of the cumulative DF2-11 surface (`origin/main...dev`, 25.6k diff lines over the 30-file union of PRs #241/#242/#243), on `fix/df2-11-review-round3` off `origin/dev`@`76d59217`. 25 parallel reviewers (16 blind, 8 edge, 1 acceptance auditor) → 25 report files → triage ledger (105 findings after dedupe) → 11 fixer agents in two waves (5 source clusters, then 6 test clusters).

### Outcome
- **Patched: 88** (9 source files, 14 test files). Highlights — cap-hit cleanup pre-check now treats a throwing record read as "unreadable ≠ absent" and proceeds to teardown (D1-class, both review layers flagged HIGH); darwin `stdinHasQueuedByte` wedge eliminated (non-blocking probe moved to a 250ms-bounded Worker thread — reproduced and fixed on this machine); approval-gate rebind refuses a changed headSha under the same reportId; teardown-claim steal-fault paths poison instead of leaving a vacant claim; `openReadOnlyHandle`'s attach-failure arm now LEADS with the WAL note (closing the D3 gap round 2 left on that one arm — confirmed independently by three review layers); readonly ledger opens set `busy_timeout` and re-verify WAL state post-attach; sweep timeout failures carry the stranded-lock remediation; `withRunLock` call sites thread `requestId`; harvest/teardown destructive verbs fold `outputIncomplete()` (truncated completion line ⇒ exit 6).
- **False positives verified against source and rejected: 12** — notably C2 (run-locked refusals do NOT feed the reap-blocked streak: refusal ids are absent from the executed lists `countReapBlocked` iterates — the streak neither advances nor resets) and A17 (`transientRefusal` is live: fanout's `invalid()` attaches `exitStatus` via `Object.assign`). Each rejection documented in-code where the reviewer's evidence sat.
- **Dismissed (verified): 11** — in-code-documented tradeoffs (stdout token on enrol, 404-as-absence fail-closed pin, golden build-id constant, sink-bypassing acquire log) and scope notes.
- **Deferred: 2** (A22 status-exit-2/usage-code collision — needs a status-scoped exit-vocabulary decision; A28 expiry-boundary µs race on the `event:"timeout"` line). Both LOW, recorded here. **Both closed in the same round** — see "Deferred closed (same round)" below.
- **Test hardening: 30** — vacuous/tautological pins rewritten (D4 re-check stub made load-bearing, streak-reset fixtures designed to fail when the reset branch is removed via mutation check, `${lock}.claim.` dead-string replaced with a readdir filter, `toContain("0")` → `"0600"`, EACCES tests given root guards), plus 8 new pins for the round-3 behavior changes.

### Intentional behavior changes (re-pinned in the same branch)
approval-window restamped at promotion (B8); inclusive expiry oracle `now >= expiresAt` (B13); identical-reportId/new-headSha rebind refused (B1); reportId/approverId >200 refused at the door, never truncated (B6/B22); empty approval `state` refuses instead of resetting supersession history (B4); `cost-ledger.open` refusal lines `status:"error"` (C12); `closedAt == graceCutoff` keeps counting (C14); dry-run sweeps never prune reap history and prune only stamp-shaped reports (C7); `sandbox-reap --yes` exits 1 on success-path ledger-close failure (D6); thrown `exitCode:6` maps to 2 (A2); harvest/teardown EAGAIN-truncated completion lines exit 6 (A12); single-run `fleet status` surfaces `list-unavailable` (A23); race give-up events emit `race-…` codes with the raw code in `detail` (E4/E5); claim anomalies land on the `claim-failed` streak, never as fake cross-process losses (E1/E2).

### Gates (round 3)
`bunx tsc --noEmit` clean (whole repo); `bunx biome check` clean on all 24 touched files. Final focal gate: `bun test tests/providers/ tests/fleet/ tests/scripts/` → **3036 run, 3006 pass / 0 fail, exit 0** (one C14 boundary pin in `cost-ledger-reservation.test.ts` — a file outside every fixer's mandate — flipped to the new exclusive-cutoff semantics during the gate). GitNexus: `impact()` run per symbol before every edit (`stdinHasQueuedByte`/`report`/`warnSinkRaising`/`expiredState`/`readMarkerVerdict`/`runArtifactsStep` flagged HIGH/CRITICAL, proceeded under pre-authorization with contract-preserving changes); final `detect_changes` → 107 symbols / 24 files, risk CRITICAL by process count (known pattern artifact), every changed symbol inside this story's own modules, nothing out of scope. The tracked-inputs digest was re-measured after the source edits settled (per the same-commit ritual) and the pin suite is green. Review evidence: 25 reviewer + 11 fixer reports under `/tmp/pr-review/reports/` (ephemeral).

### Deferred closed (same round) — A22 + A28 (2026-09-09)

Both round-3 deferrals were authorized and landed as follow-up commits on this same branch (PR #246).

- **A22 — status exit-code collision with usage (2)** → records data unreadable/corrupt now exits **5**, the file's existing "a guard fired, nothing mutated, no retry heals it" code — the same code harvest/teardown already pin for their own corrupt-record refusals (`record-read-failed`) and `run`'s re-read classification. Not 6 (nothing landed), not 3 (dispatch-only setup gate), not 4 (the run may exist — the file is just unreadable). Applied at two sites: `runStatus`'s `skippedRecords` exit, and `makeReadOnlyStore`'s ENOENT arm (now `FleetError(5, "records-dir-absent", …)` — a substrate-state guard a dashboard must see, so the gate verbs' `isUsageRefusal` (2-only, untouched) correctly stops suppressing its `refused` gate event; every verb reaching that constructor already declared 5). Registry: `status` widened `[0,1,2,4]` → `[0,1,2,4,5]`; exit-table doc updated in `scripts/fleet.ts`'s header and its verbs.test.ts mirror copy; the `report()` clamp (0–6, verbs.test.ts-scraped) untouched. Re-pinned: 3 cli.test.ts corrupt-record pins (2→5), gate-verbs attach missing-dir pin (2→5), verbs.test.ts `EXPECTED_EXIT_CODES.status`, plus a new probe-level status exit-5 probe (records-skipped) so the declared/observed set-equality test stays honest.
- **A28 — expiry-boundary µs race drops `event:"timeout"`** → the approve/reject success arm now emits the timeout gate event when it DETECTS the race: `already-decided` over a `timed-out` record with no pre-sweep emission (a `timeoutEmitted` flag set by the `sweepExpired` producer). Same event, same fields (`outcome`/`state`/`expiry_sweep_ms`; on this arm the sweep rode inside `submitDecision`, so `decision_wait_ms`'s window is the bound it carries). Exit code (0) and the already-decided envelope unchanged; the normal path stays a single emit (flag guards the double).
- Tests: new gate-verbs pin drives the race deterministically (phase-flipping store wrapper + two-reading PinnedDate — pre-sweep reads T−1, submitDecision's sweep reads T+1) and asserts exactly one `event:"timeout"` line beside the already-decided envelope; the existing boundary and own-event pins (both with a firing pre-sweep) confirm no double-emit.
- Gates: focal suites 0 fail; `bunx tsc --noEmit` clean; `bunx biome check` clean on touched files; GitNexus `impact()` LOW for both symbols pre-edit; `detect_changes` confined to `scripts/fleet.ts`, `src/fleet/verbs.ts`, and their test/story files.
## Review Findings — round 4 (2026-09-09, full-surface adversarial re-review of PR-241 + round-3 delta)

Fresh 8-reviewer wave (3 blind over PR-#241's own 2,986-line diff, 4 edge over the round-3 delta incl. A22/A28 code, 1 acceptance auditor) → 55 raw findings → 47 after dedupe → triage (`/tmp/pr241-review/triage-r4.md`) → 5 disjoint-cluster fixers in one wave (source + own tests together; no standalone wave needed — all test hardening shipped with its cluster).

### Outcome
- **Patched: 40** (10 source files, 13 test files). Highlights — the A28 µs-race DETECT arm is now actually covered (its own test flipped on the first store read, so the pre-sweep always emitted first; verified by a disable-the-arm mutation check, now red-then-green); the detect arm stopped stuffing the decision wait into `expiry_sweep_ms` (new `expiry_detect_wait_ms`) and stopped re-emitting the timeout event on a second approve of an already-timed-out record; C13's `unqueryable` wrap extended from one COUNT to the whole `view()`/`readIssueRuns()` bodies (a pre-`kind` ledger leaked raw "no such column: kind" from roleRows); the reaper's lock dir now derives from the same `runsDir ?? store.dir` expression the teardown head check resolves (was asymmetric — a lexically-different runsDir stranded destructive-marked locks on every sweep teardown); both stat-then-rm lock cleanups gained a post-unlink inode anomaly fence; a stored over-bound reportId no longer bricks every later rebind (fourth skip arm); the D5 mode-broad warn rides the contract operation `cost-ledger.open`; openReadOnly's audit line/docblocks admit busy_timeout (round-3 C6) instead of claiming "no pragma"; the probe fstatSync and the full write-path (`writeAll`/`writeBestEffort`) got the fleet.ts treatment in cost-ledger/qds-cost; status's corrupt-record single-run classification aligned to exit 5 (A22-consistent) and status declares exit 6 (output truncation); single-run status during a list outage exits 1 `list-unavailable` like the fleet form; `--steps-json` opens O_NONBLOCK before the fstat proof (no FIFO wedge); run-lock's markMoved-inside-try, release-time `reapTtlCache` eviction, rollbackReleasedClaims coverage, loserTeardownTimeoutMs validation, empty-runId marker refusal, both-dispositions stranded-lock wording in reaper; cap-hit's finishEarly lock wrap now has mutation-proven coverage, honest teardown notes, refusal-specific step-11 labels; `test.skipIf` root guards; sha256 content hash in the race test's snapshot copy; empty-remediation guards; scratch-dir snapshot/restore in the digest witness.
- **False positives verified against source and rejected: 4** — R4-2 (withRunLock's opts DO declare `requestId?: string`, run-lock.ts:1055 — blind layer had no repo access), R4-47 (`join` is imported, reaper.ts:23), R4-11 (an absent headSha never reaches the rebind compare: the 40-hex door at approval-gate.ts:1434 refuses first, and that door contract is pinned by approval-gate.test.ts:316), R4-28 (the -shm tautology was already removed by round-3's 18ee4109). Plus 2 verified-absent-on-branch (R4-29 forged-handle pin is already behavioral, R4-31 named guard already exists) and 1 documented-unreachable (R4-15: exit 3 cannot reach runRun's catch — its only producer is dispatch's setup-gate).
- **Intentional behavior changes (all re-pinned in-branch):** status corrupt-record 1→5; status declares/exits 6 on stdout truncation; single-run status during a list outage exits 1 `list-unavailable` (was 0 with a settled-looking row); A28 detect arm emits `expiry_detect_wait_ms` and suppresses the second-invocation re-emit; empty-string runId markers → `marker-run-id-invalid`; cap-hit vanished-record note reworded; step-11 lock-refusal labels corrected.

### Story-doc reconciliation (this round)
- Observability Contract outcome set widened to the open path's actual refusals (`ledger-unopenable`, `ledger-identity-changed`; mode-broad warn re-parented to `cost-ledger.open`).
- DoD "no pragma" wording updated: busy_timeout is the sanctioned connection-local exception (round-3 C6).
- Trigger Surface / Files-to-Modify rows carry round-3/4 cross-references for the behaviors review re-pinned beyond the original AC rows (approval-gate door caps/expiry oracle/rebind refusal; teardown artifacts nullish normalization).

### Gates (round 4)
`bunx tsc --noEmit` clean (whole repo); `bunx biome check` clean on all 23 touched files. Final focal gate: `bun test tests/providers/ tests/fleet/ tests/scripts/` → **3050 run / 0 fail / exit 0** (87 files, 612.9s). GitNexus: `impact()` run per symbol before every fixer edit (markRunLockDestructive and reapStaleTemps flagged CRITICAL transitively — both changes contract-preserving, proceeded under pre-authorization); final `detect_changes` → 44 symbols / 24 files, risk CRITICAL by process count (known pattern artifact), every changed file inside this story's own modules, nothing out of scope. Tracked-inputs digest re-measured on the settled tree (pin suite 232/0, literal updated 334c7cc1…). Review evidence under `/tmp/pr241-review/reports-r4/` (ephemeral).

## Review Findings — round 5 (2026-09-10, full-surface adversarial re-review of PR-241+#246 via origin/dev...HEAD)

Context-limited wave: 8 reviewers (5 blind over 5 chunked diffs of the 7.8k-line PR diff — scripts, engine src, tests/providers, tests/scripts, tests/fleet; 2 edge with repo access; 1 acceptance auditor over the spec + src chunks) → 78 raw findings → 73 unique after cross-layer dedupe → triage ledger (`/tmp/pr246-review/triage.md`) → fix waves: 2 disjoint source clusters, then 3 standalone test clusters (5 fixer agents).

### Outcome
- **Patched: 59** (10 source files, 13 test files) + 5 new pins for round-5 behavior changes. Highlights — A28's timeout event is now at-most-once across CONCURRENT invocations (src `DecisionOutcome.already-decided` carries a `sweptHere` discriminator; the CLI DETECT arm emits only when this invocation's own sweep persisted the timeout); cap-hit's cleanup latch no longer skipped on the no-record early return (second signal no longer lies "teardown in progress"); NaN `turnsCompleted` no longer reads as a `no-live-account` claim; reporter bugs (`report()` throwing) emit a `reporter-failed` stderr envelope and exit **2** instead of a silent retryable exit 1; `printError` treats null/empty/whitespace remediation uniformly (key omitted, stack/cause kept); `--steps-json` EAGAIN falls back to a plain read and EINTR retries (a regular file can no longer become a usage exit 2); enrol refuses an unprovable allowlist stat (`approver-out-unverifiable`, exit 6) and its failure-unlink only fires on a matching inode; `reapTtlCache` entries evicted on each sweep; single-run `fleet status` on a list outage now carries the computed row in the refusal envelope (`{ row }`) with closed-aware remediation; `countReapBlocked` reads only stamp-shaped report names (filter shared into `sortedReapReports` — a foreign `.json` can no longer blind the ≥3-failure breaker); dry-run sweeps prune their own report history (mode gate removed, name scope kept); teardown's C1 catch uses the throw-safe `redactSecrets(recErr.message ?? recordErr)` coercion; the K1 box-hours-late warn boundary moved to strict `<` matching `classifyReservation`'s C14 operator; rebind over a stored empty headSha refuses `approval-record-damaged` instead of mislabeling a code move; the bundle presence probe requires a regular file; claim-poison EEXIST gets the distinct "HELD — do NOT unlock" wording; `MAX_REPORT_ID_CHARS` now aliases run-record's exported `STRINGS_MAX_ELEMENT_LEN` (compile-time link, value unchanged); the over-bound superseded-id shed emits a named `superseded-id-shed` audit line (docblock + log, no silent loss); readonly-mode guard docblocks state compile-time-only honestly; `cappedApproverId` renamed `approverIdValue`; zero-lifetime box-hours rows price at a **1 µ$ floor** (`Math.max(1, ceil(…))` — the F8 "never 0" doctrine now holds at the 0-length edge); stale status-comment and verbs-probe ordering comment corrected. Test hardening: SOURCE_PATHS parser rewritten as a paren-depth scan (CRLF-safe, comment-text-stripping) with pins for both resurrecting shapes; sort invariant pinned comparator-free; FIFO writer `exec`-ed (no orphan); $HOME sentinel moved out of the real home; scratch snapshot moved inside try with commit-after-copy; rollback arms split into three tests; root-level script list derived via readdir; §4h test given its sibling's 20 s timeout; C13 fixture cleans -wal/-shm siblings; racer barrier deadline enforced on the read itself; WAL healer no longer masks the original assertion; F043 seeds a real reapable unit; report-name drift alarm (writer output vs name regex) added; digest re-pin and forged-handle test comments state their actual guarantees; wait-zero/40 ms comments state their real thresholds; B22 interpolates the approver bound; exit-6 refused counter exact; tautological qds-cost assert replaced with a seam-hit spy count.
- **False positives verified against source and rejected: 5** — BE-4 (stranded-lock remediation is correctly teardown-only: destroy/revoke take no per-run lock, reaper.ts:792/886/892); BTF-3 (the give-up `find` is already discriminating — per-tick lines carry `error.code`, only `giveUp` passes `event`, and `giveUps(...)).toBe(1)` two lines up makes it unambiguous); BTF-5 (both tier1 finallys already render `finalBoxes === undefined` as a FAILING problem via live-harness.ts:1222); BTP-7 (RunRecordStore.get is non-nullable and throws on absence — no null-deref is reachable); BTP-9 (per-test tmpdir teardown + self-closing `openReadOnly` constructor path leave nothing to leak).
- **Dismissed (verified, in-code/posture tradeoffs): 8** — sandbox-reap exit-1 on refusal-only sweeps (exit contract deliberately untouched since round 2); the post-unlink fence's stderr-only diagnostics (POSIX-unacknowledged-race, claim discipline is the safety); the 250 ms stdin-peek threshold (documented fail-open, needs live measurement); A28 test's exact-read-count coupling (both mis-time directions fail loudly); the four auditor spec-drift notes (run-lock "adds only" superseded by rounds 3–5 authorized edits with semantics verified preserved-and-stronger; reaper's `runsDir ?? store.dir` lock-path expression = drift-proofing form of the same value; cap-hit `teardownOk` landed-arm is round-3 D4's documented intent — spec text amended by this paragraph; `sandbox-reap --yes` exit contract unchanged).
- **Deferred: 1** — image-contract spend-tripwire positive control is per-fixture, not per-suite (LOW; each refusal fixture could carry its own `chat/completions` presence check).
- **Story amendments (this round):** round-3 C7's "dry-run sweeps never prune reap history" clause superseded — dry-runs now prune own-name history (the name scope, not the mode gate, is the non-destructive guarantee); round-4 R4-27's observed 0 µ$ zero-lifetime pin superseded by the 1 µ$ floor.

### Gates (round 5)
`bunx tsc --noEmit` clean (whole repo); `bunx biome check` clean (237 files across src/scripts/tests). Final focal gate: `bun test tests/fleet/ tests/providers/ tests/scripts/` → **3061 run, 3031 pass / 2 skip / 28 todo / 0 fail, exit 0** (87 files, 652.9s). GitNexus: `impact()` per symbol before fixer edits; final `detect_changes` → 39 symbols / 23 files, risk CRITICAL by hub centrality (known pattern artifact), every changed symbol and affected process inside this story's own modules, nothing out of scope. Tracked-inputs digest re-pinned on the settled tree (`895257a2…`, comment chain amended to name the wave's inputs). Review evidence under `/tmp/pr246-review/` (ephemeral).
