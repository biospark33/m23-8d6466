# DF2.1: Provider-Driver Interface + Run Records

**Story Points:** 4
**Sprint:** v5-S1 (track B, provider — R5 §3 opens the chain DF2.1 → DF2.3 → DF2.2 → DF2.5)

## Spec Reference

- `docs/superpowers/specs/2026-08-11-dark-factory-v5-architecture-design.md` §3.4, §5.1, §5.3, §6
- Decision register: v5 §4 D7 (two first-class drivers behind one seam), D8 (credential architecture)
- Contracts: v5 §5.2 observability (requestId propagation); this story introduces the
  `ProviderDriver` seam and the closed run-record schema
- Derivation decisions: `docs/superpowers/specs/2026-08-11-v5-story-derivation-decisions.md` DD-8, DD-9
- Evidence: R4 §3.1 (phase ordering), §3.2 (run-record discipline), §3.5 (the seam is 6 command
  shapes); R3 §7 (provider code confirmed absent — greenfield), §9.2 (`src/providers/` layout)
- Build order: v5 §8 step 2

## User Story

As a factory platform engineer,
I want one small provider-driver seam plus a hard-edged run record on the host,
so that exe.dev and OCI drivers plug in without reshaping anything above them, and no run can
leave behind a box or a key that nobody can account for.

## Overview

The fleet dispatcher never talks to a substrate directly: it resolves a named driver from
`src/providers/index.ts`, and every box operation crosses that one seam. R4 §3.5 measured inkwell's
entire exe.dev surface at six command shapes, so the seam is deliberately small — provider-specific
primitives only, with the lifecycle verbs (`create/fill/setup/execute/observe/teardown/reap`)
expressed over them host-side. Beside it sits the run record: one JSON file per run, created before
any billable infrastructure exists, so a crash anywhere afterwards leaves teardown a handle to work
from. This story ships the seam, the record store, its CLI, and a fake driver the contract test
drives end to end.

## E2E Slice

**Demonstrable behavior:** Given an empty `.sandbox/runs/`, When the operator runs
`bun scripts/run-record.ts new-id qds` and then walks the fake driver through create → fill → setup
→ execute → observe → teardown → reap, it writes `.sandbox/runs/qds-20260811-a3f19c.json` with mode
`0600` → records `vmName`/`httpsUrl` returned by `driver.create()` → closes the record with
`closedAt` set → `run-record list` returns exactly one closed record and a second `create` of the
same id fails with `EEXIST`.

**Wiring closed:** On completion of this story, the driver seam and run-record discipline are real
using only code merged by this story. The fake driver is a complete registered implementation over a
temp dir and child processes — not a stub, and not a `TODO: wire later`. No sibling story is required
to make record discipline real; DF2.2 registers the exe.dev driver against an unchanged seam, and the
OCI driver does the same later at v5 §8 step 7 (DF2.9 defines that image, not a driver).

**Dependency edges (predecessors):** none.

## Acceptance Criteria

1. **(make-or-break)** Given no record exists for `<run-id>`, When `create()` is called twice, Then
   the first opens the file with `O_WRONLY|O_CREAT|O_EXCL` at mode `0600` and the second rejects
   with `EEXIST` — the existing file's bytes and mtime are unchanged. A check-then-write
   implementation (`if (existsSync(p)) throw`) passes a naive "second create fails" test and MUST
   fail this one: the test interleaves two creates against the same path (R4 §3.2).
2. Given an open record, When `set()` receives a core key outside the twelve-field closed schema, or
   either immutable field (`runId`, `createdAt`), Then it rejects naming the offending key and the
   file is byte-identical afterwards — unknown keys are never written (a typo in `set` would
   otherwise be silent data loss). The twelve core fields are closed; the **single sanctioned
   additive key is `extensions`**, a versioned namespace a downstream story writes into under its own
   registered sub-key (`extensions.<ns>.<field>`), shape-validated per `ns` — an unregistered
   namespace, a malformed shape, or a new top-level key other than `extensions` is rejected like an
   unknown core key (see Technical Notes). Every accepted mutation is an **atomic replace**: `set()` and
   `close()` write a sibling temp file then `rename` it over the record, so a failure injected
   between write and rename leaves the prior record byte-identical (R4 §3.2); a stale `.tmp` left by an unclean process death (SIGKILL) is cleaned at store construction before any run starts.
3. Given a malformed or unreadable `.json` in the runs directory, When `list()` is called, Then it
   throws naming that file and returns nothing — it never skips the bad record. Rationale, stated
   once: a record quietly dropped is a key that quietly keeps spending (R4 §3.2).
4. Given a record whose `vmName` was never set, When `run-record get <id> vmName` runs, Then it
   exits `0` and prints an empty line — emptiness is the "that phase never finished" signal callers
   branch on, not an error condition (R4 §3.2).
5. Given the fake driver registered as `fake`, When the driver contract test walks all seven
   lifecycle verbs, Then every provider-specific operation resolves through a `ProviderDriver`
   primitive and the identical suite runs unmodified against any driver registered later — the
   contract test is exported for DF2.2 and the later OCI driver story to import.
6. Given any id arriving from argv, When it reaches `path()` — the one function every verb routes
   through to turn an id into a filename — Then an id failing the hostname grammar
   `^[a-z0-9][a-z0-9-]*$` or exceeding 63 characters is rejected before a path is built and nothing
   is created or read: `../evil`, `A-b` and 64+ chars are refused at `create`, `get`, `set`, `close`
   and `path` alike. `newId()` generates ids; no verb acts on one it did not validate (R4 §3.2).

## Trigger Surface

| Trigger | Status | E2E Test | Follow-Up |
|---------|--------|----------|-----------|
| `bun scripts/run-record.ts create\|get\|set\|close\|list\|path\|new-id` | in-scope | `tests/providers/run-record.test.ts` | — |
| `ProviderDriver` contract via the `fake` driver | in-scope | `tests/providers/driver-contract.test.ts` | — |
| `fleet dispatch \| status \| harvest \| teardown` CLI | out-of-scope | — | DF3.1 |
| exe.dev driver registration + setup gate | out-of-scope | — | DF2.2 |
| OCI **image** contract (build + licensing, no driver) | out-of-scope | — | DF2.9 |
| OCI **driver** registration against this seam | out-of-scope | — | v5 §8 step 7 (not DF2.9) |
| Credential mint writing `keyHash`/`limitMicroUsd` into the record | out-of-scope | — | DF2.3 |
| Harvest + teardown reading and closing the record | out-of-scope | — | DF2.5 |
| Fleet-wide reaper walking `list()` | out-of-scope | — | DF2.6 |

## Infra Prerequisites

| Component | Service (compose/k8s/provider) | Lifecycle Hook Verified |
|-----------|-------------------------------|-------------------------|
| Host records directory `.sandbox/runs/` | host filesystem (no service) | store constructor creates it at mode `0700`; test asserts the mode on a fresh checkout |
| Driver registry | in-process, `src/providers/index.ts` | `resolveDriver("fake")` returns without opening a socket or reading an env secret |
| `O_EXCL` support on the running platform | Bun/Node `fs` on darwin + linux CI | test asserts the second `create` throws `EEXIST`; INV-5 covers a platform where it does not |
| Provider substrate (exe.dev VM / OCI box) | **none in this story** | the `fake` driver satisfies the seam entirely; DF2.2's five-assertion setup gate is the hook for the real one |

## Technical Notes

- **Driver seam (new contract, ~30 lines of types):** `ProviderDriver` carries only what differs
  between substrates — `create(name, tag)`, `list(name?)`, `destroy(vm)`, `expose(vm, port)`,
  `setPublic(vm)`, `whoami()`, `exec(vm, argv, stdin?)`, `copyFile(vm, remotePath, localPath)`
  (**box → host only** — nothing pushes a file into a box, which is why DF2.3's key arrives on
  `exec` stdin). R4 §3.5 measured exactly these six control-plane shapes plus generic ssh/scp.
- **Lifecycle verbs are host-side, not driver methods.** `create`, `teardown` and `reap` call
  provider primitives; `fill`, `setup`, `execute` and `observe` compose `exec`/`copyFile` and are
  substrate-independent by construction. Adding a driver never means writing four more verbs.
- **Phase ordering (INV-1) — record → VM → key.** A failed mint orphans a VM: cheap, and visible in
  the provider's own `list`. A failed VM after a mint orphans a key that spends money invisibly
  (R4 §3.1). The reverse ordering is the defect this invariant exists to prevent.
- **Closed record schema, twelve core fields:** `runId`, `vmName`, `httpsUrl`, `keyHash`,
  `limitMicroUsd`, `spendMicroUsd`, `sessionId`, `commitSha`, `ports`, `pid`, `createdAt`,
  `closedAt`. Immutable: `runId`, `createdAt`. The record stores `keyHash` and never key material.
  **These camelCase spellings are the only ones any consumer writes or asserts against.** The
  snake_case forms (`commit_sha`, `key_hash`, `closed_at`, …) appear nowhere in this record — they
  exist only as DF2.8's SQLite ledger **column** names, a different store with its own schema.
- **Versioned extension namespace (additive, the one sanctioned hole in the closed schema).** The
  record carries one optional top-level key, `extensions: { [ns]: { schemaVersion, ...fields } }`,
  so downstream stories can hang cross-cutting state off the run record without reopening the twelve
  core fields or coupling the provider layer to their concerns. Registered sub-keys (each owning
  story validates its own shape and records its `schemaVersion`): `pr` — DF5.2 writes
  `prUrl`/`prNumber`; `fixLoop` — DF6.1 writes `fixContext`/`fixOutcome`; `fanout` — DF3.2 writes
  `fanoutId`/`arm`. A `set()` addressing any
  other namespace, or a top-level key other than these twelve plus `extensions`, is rejected with
  the offending key named — the namespace is allow-listed, not an open map. The no-key-material rule
  (INV-2) covers `extensions` contents: every registered sub-key's validation rejects credential
  values, because the record is a greppable public artifact. (DF1.8 sets the precedent — it amends
  DF1.4's INV-5 to admit additive columns rather than open a second store.) **`extensions` remains
  writable after `closedAt` is set; the twelve core fields do not.** Closure freezes the run's own
  lifecycle facts, not the cross-cutting state hung off them — DF5.2's `extensions.pr` write and
  DF5.3's audit link land on a closed record by design (DF3.4 pauses close the record before either
  runs), and `close()` stays first-close-wins on `closedAt` itself.
- **Pending namespace request — teardown artifacts outcome ([#221](https://github.com/Quantum-Digital-Solutions/QDS-Factory/issues/221), from DF1.10's review round 1).** DF1.10 made an artifacts failure **non-fatal** so `destroy` always runs: a workload planting a symlink under its reply paths could otherwise make tar store a link entry, the host validator refuse the whole archive, and teardown abort *before* `destroy` — pinning a billing box open forever, with the aged-record reaper re-aborting through the same path every sweep. The residual is that the failure is now **log-only** (`teardown.artifacts_failed`, `status:"error"`, `outcome:"continued"`), so no record reader can distinguish a run whose artifacts were harvested from one whose artifacts were lost. Recording it wants a new registered sub-key here — an ordinary allow-list addition, not a schema change, but INV-IBOX-9 makes it **this** story's to write, not DF1.10's. Marked in place as `TODO (cross-cluster)` at `src/providers/teardown.ts:209`.
- **Cost unit deviation from the reference (DD-9):** inkwell stores `limit`/`spend` as float
  dollars. This record stores **integer micro-dollars**, because sub-cent per-role splits are not
  representable otherwise and floats are not a money type. No numeric literal crosses the unit
  change; the cap value itself is DF2.3's to mint and DF2.8's to police — DF2.1 only stores it.
- **Per-field coercion at the CLI boundary, never "try JSON first."** argv is the only place a value
  arrives as a string; the map is `{ports: json, pid: int, limitMicroUsd: int, spendMicroUsd: int}`.
  Everything else stays a string — a `commitSha` of `5734129` is a string that happens to parse as a
  number (R4 §3.2).
- **Guards/limits:** file mode `0600`, directory mode `0700`; run id is `<slug>-<YYYYMMDD>-<6 hex>`,
  **generated, never supplied**, and validated against the hostname grammar `^[a-z0-9][a-z0-9-]*$`
  with a 63-character ceiling (the id becomes the box name and the box name becomes a public
  hostname, so a collision is two runs fighting over one URL). Writes are atomic: temp file then
  `rename`, so a crash mid-write leaves the old record rather than half of one.
- **Deviation/assumption:** every exe.dev behavioural claim in R4 §3.5 is vendor-single-origin and
  carries `[VERIFY]` (R5 §6 fact 11). This story makes no exe.dev call and depends on none of them;
  the verified-vs-unverified response-shape split is DF2.2's obligation. No AC here assumes any
  compliance artifact (SOC 2 / DPA / SLA) exists.

## Observability Contract

- Every driver call and every record mutation logs
  `{ requestId, runId, driver, verb, timestamp, durationMs, outcome }`.
- requestId propagates from the caller (the dispatcher in DF3.1, the CLI's own minted id otherwise);
  errors include `{ code, message }` and never the record's `keyHash` value.
- Sub-timings: `driver_call_ms`, `record_write_ms`. Where a driver cannot break a call down, it
  reports `0` and `durationMs` is authoritative.

## Files to Modify

- `src/providers/driver.ts`
- `src/providers/run-record.ts`
- `src/providers/fake-driver.ts`
- `src/providers/index.ts`
- `scripts/run-record.ts`
- `tests/providers/run-record.test.ts`
- `tests/providers/driver-contract.test.ts`

## Security Invariants

- **INV-1 (ordering):** the run record file exists on the host before any driver call that can
  create billable infrastructure. Enforced by the create path itself — `driver.create()` is
  unreachable without an open record id — so a crash at any later point leaves teardown a handle
  (R4 §3.1; v5 §3.4).
- **INV-2 (secret containment):** no key material is ever written to the record. `keyHash` is the
  only credential-derived field, the twelve core fields are closed so no caller can add one, and the
  record is mode `0600`. The `extensions` namespace is the one additive surface, and it is
  allow-listed per sub-key with shape validation that rejects credential values — not an open map a
  caller can stuff a secret into. The record is greppable and appears in reports — it is treated as
  a public artifact (D8; R5 §6 fact 17: exactly one secret per box, and it is not this file).
- **INV-3 (no-overwrite):** creation uses `O_EXCL`, not an existence check. Overwriting a live
  record orphans that run's key, and the check-then-write window is exactly where a retrying phase
  lands (R4 §3.2). Updates use write-temp-then-`rename`; there is no in-place partial write path.
- **INV-4 (accountability):** an unreadable or schema-invalid record is a hard error at `list()`,
  never a skipped entry. The reaper (DF2.6) walks this list to find keys nobody revoked, so a
  silently dropped record is an unbounded spend with no owner.
- **INV-5 (fail-closed):** if `O_EXCL` creation or `0600` mode cannot be honoured on the running
  platform, the store throws at construction and no run starts. It never degrades to a
  check-then-write or a default-mode file, and it never continues with a warning.

## Definition of Done

- [x] **Impl:** `ProviderDriver` defined with the eight primitives; the seven lifecycle verbs
      composed over them host-side, with only `create`/`teardown`/`reap` provider-specific
- [x] **Impl:** run-record store with `create`/`get`/`set`/`close`/`list`/`path`/`newId`, plus the
      CLI at `scripts/run-record.ts` using `parseValueFlags` from `scripts/lib/cli-args.ts`
- [x] **Contract:** twelve-field closed core schema enforced on write — unknown-key and
      immutable-field writes both rejected with the key named; the one sanctioned additive key
      `extensions` accepted only under a registered, shape-validated sub-key (AC2). A test writes
      `extensions.telemetry.foo` — an unregistered namespace — and asserts the write is rejected
      with the key named, then writes `extensions.pr.prUrl` and `extensions.fanout.fanoutId` and
      asserts both are accepted: the rejected/accepted pair is the allow-list proof, and `pr`,
      `fixLoop` and `fanout` are registered by this story
- [x] **Integration:** `fake` driver registered in `src/providers/index.ts` and resolvable by name;
      the exported contract suite is importable by DF2.2 and by the future OCI driver story
      (v5 §8 step 7 — DF2.9 defines the image, not a driver)
- [x] **Security:** record-before-VM ordering unreachable in the wrong order by construction (INV-1);
      no code path writes key material into the record (INV-2)
- [x] **Test (atomic replace + idempotent close):** a failure injected between temp-write and
      `rename` leaves the prior record byte-identical (AC2); a SIGKILL between temp-write and
      `rename` leaves the prior record byte-identical and the stale `.tmp` is cleaned at next
      construction; `close()` twice is first-close-wins — `closedAt` keeps its original value and
      the second call succeeds
- [x] **Test (create path):** two interleaved `create()` calls on one id → exactly one file, one
      `EEXIST`, and a check-then-write implementation MUST fail (AC1); ids `../evil`, `A-b` and
      64+ chars are refused by every verb routing through `path()`, nothing written (AC6)
- [x] **Test (malformed record):** a truncated JSON file in `.sandbox/runs/` → `list()` throws
      naming the file; a `try/catch`-and-skip implementation MUST fail this test (AC3)
- [x] **Test (unset field):** `get <id> vmName` on a record without it → exit `0`, empty line (AC4)
- [x] **Test (e2e demo — MANDATORY):** the fake driver walked through all seven verbs produces
      `.sandbox/runs/<run-id>.json` on disk at mode `0600` with `vmName`, `httpsUrl` and `closedAt`
      populated, and `run-record list` returns it — captured in the Dev Agent Record

## Dev Agent Record

**Status:** done — PR [#102](https://github.com/Quantum-Digital-Solutions/QDS-Factory/pull/102) squash-merged to
`main` 2026-08-14 (`5b66f84`). Branch `feature/df2-1-provider-driver-run-records` (deleted on merge).

**Post-PR review — five rounds.** CodeRabbit's merge-readiness verdict: *"Yes. Excluding CI/CD
status, this PR is ready to merge. The previously blocking `fillRun()` parent-directory symlink
race is resolved and covered by a deterministic regression test."*

- **Round 1 (`733b1e7`)** — path traversal in `fillRun` (absolute / `..` paths now rejected); reap
  race (the `store.list()` claim snapshot moved after `driver.list()`, closing a window where reap
  could destroy a box for an in-flight `createRun`); metadata rebind in `readMeta` (`meta.name !==
  vm` now rejected, so a workload cannot redirect `expose`/`setPublic` into another box);
  `schemaVersion` downgrade guard; `owner > 0` required before `isAlive` (`process.kill(0,0)`
  always succeeds, which made pid-0 owners immortal); test log-sink restore ordering; a placeholder
  E2E command replaced with a real seven-verb transcript.
- **Rounds 2 and 4** — no code change. Three findings rejected with recorded reasoning:
  `fake-driver.ts:58` "imports orchestration verbs" (false positive — the module imports only types
  plus `assertValidRunId`; the verbs are imported by the *test* file, which CodeRabbit independently
  confirmed), `index.ts:83` `target.name` possibly undefined (`ProviderDriver.name` is a required
  interface member), and a bogus duplicate-anonymous-function match. Round 4 also disproved a
  finding predicting `fake-driver.test.ts:169` would fail — it passes (19/19), because `FILL_SCRIPT`
  already carried an explicit `-L` check on the final target. Confirmed `FakeDriver.exec` spawns
  real `sh` via `Bun.spawn`, so the passing test genuinely exercises the boundary rather than a mock.
- **Round 3 (`d5be460`)** — static symlink escape: the round-1 guard was textual only, so a symlink
  already inside the box passed every string check and redirected the write. Added per-component
  symlink checks and `set -C` on the final open.
- **Round 5 (`fff9270`) — the real one.** Round 3's fix was still racy, and its "zero-width race"
  claim was wrong. The component check and the `cat > "$p"` open are separate operations; a
  concurrent process can swap an already-checked component for a symlink in between, and `set -C`
  only makes the *last* component's open atomic — it never protected the parent path the kernel
  re-resolves. Reproduced with a scheduler-preemption stand-in at that exact gap. **POSIX `sh`
  cannot express the fix** (no `openat`/`O_NOFOLLOW`), so traversal moved to Python
  `os.open`/`os.mkdir` with `dir_fd=` (single `openat`/`mkdirat` syscalls): each component is opened
  `O_NOFOLLOW` relative to the previously *held* directory fd, so check and use are one atomic
  kernel operation and a held fd references the inode, immune to its parent being renamed. Final
  target opens `O_CREAT|O_EXCL|O_NOFOLLOW` against the held parent fd. `sh` now only probes for
  `python3` and passes the source and path as separate argv elements — no shell interpolation of the
  payload.

> **Regression test is deterministic, not timing-based.** A test-only sync hook
> (`QDS_FILL_TEST_SYNC`, inert unless set) pauses traversal while holding a directory fd; the test
> renames that directory away and plants a symlink, then releases — asserting the write lands in the
> original inode. Required a real side fix: `FakeDriver.exec` now passes `env: process.env` to
> `Bun.spawn`, whose default silently snapshots env at Bun startup and dropped runtime mutations.
>
> **Security-boundary lesson:** three rounds each believed they had closed this write path
> (textual → static symlink → TOCTOU). A path-safety guard written in shell should be treated as
> unfinished until it is descriptor-based.

> **CI note:** the `check` workflow shows FAILURE, but the job never started — GitHub Actions
> billing ("recent account payments have failed or your spending limit needs to be increased").
> Wave-wide, not a code signal. Local gates at merge: 72 pass / 0 fail focal, `tsc --noEmit` clean,
> biome clean.

> **Deferred, non-blocking (carried forward as follow-ups):** `scripts/run-record.ts:22` couples the
> providers CLI to the MCP transport for logging, and `:223` duplicates the field schema between CLI
> and store. Both are valid cross-cutting refactors, deliberately not folded into a review-fix pass.


### Delivered

| File | What |
|------|------|
| `src/providers/driver.ts` | `ProviderDriver` (8 primitives) + the 7 host-side lifecycle verbs |
| `src/providers/run-record.ts` | `RunRecordStore` (`create/get/set/close/list/path`) + `newId`/`assertValidRunId` + `EXTENSION_NAMESPACES` |
| `src/providers/fake-driver.ts` | `FakeDriver` — real implementation over a temp dir + child processes |
| `src/providers/index.ts` | registry (`registerDriver`/`resolveDriver`) + observability wrapper; registers `fake` |
| `scripts/run-record.ts` | CLI `new-id\|create\|path\|get\|set\|close\|list`, built on `parseValueFlags` |
| `tests/providers/run-record.test.ts` | 52 tests (AC1–AC4, AC6, INV-2/3/4/5, observability, concurrency) |
| `tests/providers/driver-contract.test.ts` | the exported `runDriverContract()` suite, side-effect-free on import (AC5) |
| `tests/providers/fake-driver.test.ts` | runs that suite against `fake`, plus the registry and driver-side observability tests |

### Exported surface DF2.2 / DF2.3 build on (unchanged by later drivers)

`ProviderDriver`, `ProviderVm`, `ExecResult`, `BoxFile`, `createRun`, `fillRun`, `setupRun`,
`executeRun`, `observeRun`, `teardownRun`, `reapRuns`, `registerDriver`, `resolveDriver`,
`RunRecordStore`, `RunRecord`, `RunRecordPatch`, `EXTENSION_NAMESPACES`, `newId`,
`assertValidRunId`, and `runDriverContract()` from the contract test.

### Decisions taken autonomously (--yolo)

1. **Lifecycle verb names carry a `Run` suffix** (`createRun`, `fillRun`, …) because `create`/`list`
   collide with the driver primitives of the same name in a single import scope. The verb set and
   their composition over primitives are exactly as specified.
2. **Lifecycle verbs live in `driver.ts`**, not a new file — the story's Files-to-Modify list is
   the contract and the verbs are the seam's other half.
3. **`extensions.<ns>.schemaVersion` is stamped by the store**, not supplied by the caller. A caller
   may pass it, but a mismatch is rejected. This makes the version an invariant of the registry
   rather than a value each writer has to remember.
4. **Fault-injection seam:** `RunRecordStore({ beforeRename })` is a documented hook so AC2's
   "failure injected between temp-write and rename" is a real test, not a mock of the store.
5. **INV-2 detector** is a credential-prefix list plus a bare-long-token heuristic (marked
   `ponytail:` in the source), applied to every core field except `keyHash` and to every extension
   field. It is a guard, not a proof; upgrade if a real leak gets past it.
6. **`destroy()` is idempotent** in the seam's contract (asserted by the suite): teardown and reap
   both retry, and an absent box is the goal state.
7. **Store construction probes O_EXCL + mode 0600 and throws (INV-5)**, tightens the records dir to
   `0700` via explicit `chmod` (mkdir's mode is ignored for an existing dir and masked by umask),
   and sweeps stale `.tmp` files before any run starts.
8. **`.sandbox/` added to `.gitignore`** — run records and fake boxes are per-run host scratch.
9. **CLI arg split:** positionals are collected in a pre-pass and only flag tokens reach
   `parseValueFlags`, so the shared grammar stays the single owner of flag validation.

### E2E demo (MANDATORY DoD item) — captured live 2026-08-14

Ad-hoc script exercising all seven lifecycle verbs against `createRun`/`fillRun`/
`setupRun`/`executeRun`/`observeRun`/`teardownRun`/`reapRuns` over a `FakeDriver`
and a fresh `RunRecordStore`; not a checked-in file, transcript captured verbatim
(structured log lines from `setLogSink` interleave with the demo's own `console.log`
output, both left in place):

```text
$ bun run-record-e2e-demo.ts
new-id: e2e-demo-20260814-e7770d
{"requestId":"6d3a2d4c-ce31-462b-a6e1-fc6624386afc","operation":"run-record.create","agentId":null,"timestamp":"2026-08-14T01:00:02.663Z","duration":1,"status":"ok","runId":"e2e-demo-20260814-e7770d","driver":null,"verb":"create","durationMs":1,"outcome":"ok","record_write_ms":1}
{"requestId":"6d3a2d4c-ce31-462b-a6e1-fc6624386afc","operation":"run-record.set","agentId":null,"timestamp":"2026-08-14T01:00:02.677Z","duration":4,"status":"ok","runId":"e2e-demo-20260814-e7770d","driver":null,"verb":"set","durationMs":4,"outcome":"ok","record_write_ms":4}
create → vmName: e2e-demo-20260814-e7770d httpsUrl: https://e2e-demo-20260814-e7770d-8080.fake.local
fill: payload.txt written
setup: test -f payload.txt ok
execute: payload
observe: /var/folders/b1/3xqsp60176l3n0f7rxfv6q2h0000gn/T/qds-e2e-runs-nHdOl3/observed.txt
{"requestId":"6d3a2d4c-ce31-462b-a6e1-fc6624386afc","operation":"run-record.close","agentId":null,"timestamp":"2026-08-14T01:00:02.766Z","duration":2,"status":"ok","runId":"e2e-demo-20260814-e7770d","driver":null,"verb":"close","durationMs":2,"outcome":"ok","record_write_ms":2}
teardown closedAt: 2026-08-14T01:00:02.764Z
{"requestId":"6d3a2d4c-ce31-462b-a6e1-fc6624386afc","operation":"run-record.list","agentId":null,"timestamp":"2026-08-14T01:00:02.767Z","duration":1,"status":"ok","runId":null,"driver":null,"verb":"list","durationMs":1,"outcome":"ok","record_write_ms":1}
reap: []
mode: 600
record: {
  "runId": "e2e-demo-20260814-e7770d",
  "createdAt": "2026-08-14T01:00:02.662Z",
  "vmName": "e2e-demo-20260814-e7770d",
  "httpsUrl": "https://e2e-demo-20260814-e7770d-8080.fake.local",
  "ports": [8080],
  "closedAt": "2026-08-14T01:00:02.764Z"
}
{"requestId":"6d3a2d4c-ce31-462b-a6e1-fc6624386afc","operation":"run-record.list","agentId":null,"timestamp":"2026-08-14T01:00:02.767Z","duration":0,"status":"ok","runId":null,"driver":null,"verb":"list","durationMs":0,"outcome":"ok","record_write_ms":0}
list: [{"runId":"e2e-demo-20260814-e7770d","createdAt":"2026-08-14T01:00:02.662Z","vmName":"e2e-demo-20260814-e7770d","httpsUrl":"https://e2e-demo-20260814-e7770d-8080.fake.local","ports":[8080],"closedAt":"2026-08-14T01:00:02.764Z"}]
{"requestId":"6d3a2d4c-ce31-462b-a6e1-fc6624386afc","operation":"run-record.create","agentId":null,"timestamp":"2026-08-14T01:00:02.768Z","duration":1,"status":"error","error":{"code":"EEXIST","message":"EEXIST: file already exists, open '/var/folders/b1/3xqsp60176l3n0f7rxfv6q2h0000gn/T/qds-e2e-runs-nHdOl3/e2e-demo-20260814-e7770d.json'"},"runId":"e2e-demo-20260814-e7770d","driver":null,"verb":"create","durationMs":1,"outcome":"error","record_write_ms":1}
second create: EEXIST EEXIST: file already exists, open '/var/folders/b1/3xqsp60176l3n0f7rxfv6q2h0000gn/T/qds-e2e-runs-nHdOl3/e2e-demo-20260814-e7770d.json'
```

### Review rounds (3 mandatory in-depth rounds before the PR)

| Round | Found | Headline findings, all fixed |
|-------|-------|------------------------------|
| 1 | 7 | INV-2 heuristic rejected a 40-char git SHA and any 40–63 char run id (so `commitSha`/`vmName` were unwritable and `createRun` failed *after* the box existed); `reapRuns` destroyed the live box of an open run in the pre-`vmName` window; the stale-`.tmp` sweep ate concurrent writers' temps and the INV-5 probe; `set()` accepted `closedAt`, bypassing first-close-wins; failed mutations logged nothing; the contract module had import-time side effects |
| 2 | 11 | The secret charset excluded every credential that matters (an AWS secret key and a JWT were accepted); `copyFile` followed symlinks out of the box; a newer `extensions.schemaVersion` made `list()` throw fleet-wide; `teardownRun` destroyed nothing when the crash beat the `vmName` write; `instrument()` wrapped every callable; `RunRecordPatch`'s index signature let a typo compile |
| 3 | 4 (+docs) | Concurrent `set()` lost the other writer's field — a dropped `keyHash` is INV-4's failure mode exactly, now fixed with a stealable per-record O_EXCL lock; `keyHash` was exempt from the whole secret scan, not just the length heuristic; the read path still threw on extension *values*, reopening the `list()` outage; a stray directory in the boxes root aborted `reapRuns` |

### Known ceilings (deliberate, marked `ponytail:` in the source)

- The INV-2 detector is a prefix list plus a mixed-class length heuristic, not an
  entropy model or a scanner.
- The per-record lock is a file lock with a 5s timeout, stolen when its owner pid
  is gone. Pid reuse could spare a stale lock or temp; both are inert.
- `assertExclusiveCreateSupported` (INV-5) has no failure-branch test — inducing a
  platform without `O_EXCL` needs a seam the story does not ask for.

### Gates

`bun test tests/providers` → 69 pass / 0 fail across 3 files. `bunx tsc --noEmit` clean.
`bunx @biomejs/biome check src scripts tests cli-anything pi-vs-claude-code-vendor` clean.
Docker CI-parity tests skipped (`--skip-docker-tests`).
