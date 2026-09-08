# DF2.11: Teardown Run-Lock Capability + Read-Only Cost Ledger

**Story Points:** 3

**Status:** ready-for-dev

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
| `scripts/cap-hit-demo.ts` three call sites (`:494`, `:539`, `:1174`) | in-scope | `tests/scripts/cap-hit-demo.test.ts` | — |
| `GateDeps.teardown` docblock contract — the wired closure carries a handle | in-scope (docblock + type only) | `tests/fleet/approval-gate.test.ts` | DF3.7 wires it in production |
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
  ledger-unqueryable`. **No lock diagnostic and no ledger log line ever carries key material**: the
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
  the wrapper at `:463-470`.
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
  `tests/scripts/cap-hit-demo.test.ts`, `tests/fleet/e2e/tier1-approval-gate.live.test.ts` (the
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
      mkdir/chmod/pragma/schema, with `ledger-readonly` guards on the three write methods.
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

*(empty — story not yet started)*
