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

- [ ] **Impl:** `ProviderDriver` defined with the eight primitives; the seven lifecycle verbs
      composed over them host-side, with only `create`/`teardown`/`reap` provider-specific
- [ ] **Impl:** run-record store with `create`/`get`/`set`/`close`/`list`/`path`/`newId`, plus the
      CLI at `scripts/run-record.ts` using `parseValueFlags` from `scripts/lib/cli-args.ts`
- [ ] **Contract:** twelve-field closed core schema enforced on write — unknown-key and
      immutable-field writes both rejected with the key named; the one sanctioned additive key
      `extensions` accepted only under a registered, shape-validated sub-key (AC2). A test writes
      `extensions.telemetry.foo` — an unregistered namespace — and asserts the write is rejected
      with the key named, then writes `extensions.pr.prUrl` and `extensions.fanout.fanoutId` and
      asserts both are accepted: the rejected/accepted pair is the allow-list proof, and `pr`,
      `fixLoop` and `fanout` are registered by this story
- [ ] **Integration:** `fake` driver registered in `src/providers/index.ts` and resolvable by name;
      the exported contract suite is importable by DF2.2 and by the future OCI driver story
      (v5 §8 step 7 — DF2.9 defines the image, not a driver)
- [ ] **Security:** record-before-VM ordering unreachable in the wrong order by construction (INV-1);
      no code path writes key material into the record (INV-2)
- [ ] **Test (atomic replace + idempotent close):** a failure injected between temp-write and
      `rename` leaves the prior record byte-identical (AC2); a SIGKILL between temp-write and
      `rename` leaves the prior record byte-identical and the stale `.tmp` is cleaned at next
      construction; `close()` twice is first-close-wins — `closedAt` keeps its original value and
      the second call succeeds
- [ ] **Test (create path):** two interleaved `create()` calls on one id → exactly one file, one
      `EEXIST`, and a check-then-write implementation MUST fail (AC1); ids `../evil`, `A-b` and
      64+ chars are refused by every verb routing through `path()`, nothing written (AC6)
- [ ] **Test (malformed record):** a truncated JSON file in `.sandbox/runs/` → `list()` throws
      naming the file; a `try/catch`-and-skip implementation MUST fail this test (AC3)
- [ ] **Test (unset field):** `get <id> vmName` on a record without it → exit `0`, empty line (AC4)
- [ ] **Test (e2e demo — MANDATORY):** the fake driver walked through all seven verbs produces
      `.sandbox/runs/<run-id>.json` on disk at mode `0600` with `vmName`, `httpsUrl` and `closedAt`
      populated, and `run-record list` returns it — captured in the Dev Agent Record

## Dev Agent Record

<!-- Empty placeholder — filled during development. -->
