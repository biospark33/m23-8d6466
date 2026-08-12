# DF2.6: Host-Side Quota Accounting + Orphan Reaper

**Story Points:** 3
**Sprint:** v5-S2 (provider closure)

## Spec Reference

- `docs/superpowers/specs/2026-08-11-dark-factory-v5-architecture-design.md` §8 step 2 (quota
  accounting: the 50-VM / 100GB-pooled-disk ceiling tracked host-side, failed teardowns feed a
  reaper queue, dispatch refuses when headroom < N), §9 risk **R8**, §10 finding **F9**
- Decision register: v5 §4 **D7** (provider seam), **D8**
- Contracts: DF2.1's closed twelve-field run record; DF2.3's revoke + verify-against-list verbs;
  DF2.5's six-step teardown. Binding facts: R5 §6 facts **11** (exe.dev figures
  vendor-single-origin `[VERIFY]`), **17** (one key per box)
- Source patterns (file:line): R4 §3.1 — `INK/just/sandbox/manage/reap.just:4-6, 8-9, 41-42, 45, 49,
  60-61, 69-73, 97-101, 106-110, 121-137`; §3.5 — `ssh exe.dev ls [<name>] --json`, `rm <vm>`

## User Story

As the factory host,
I want the live box and key population reconciled against the run records, ceilings tracked host-side,
so that a fan-out cannot exhaust the account's VM allowance and a teardown that never ran cannot
leave a key spending forever.

## Overview

One sweep does a three-way join of the provider's VM list, the provider's key list and the host's run
records. Every **factory-owned** item — `sbx-` keys, VMs matching the generated run-id shape,
`.sandbox/runs` records — lands in exactly one class (AC1's table): `paired` (a run in flight),
`leaked-vm`, `leaked-key`, `stale-record`, plus the two hold-off classes AC7 defines; anything else
is reported `foreign` and is never a reap candidate. Only the three leak classes are reap
candidates: one tied to a run id goes through DF2.5's teardown so spend is captured and revocation
verified, a VM with no record goes to the driver, a key with no record goes to DF2.3's
`revokeAndVerify`. The same enumeration feeds
`checkHeadroom(n)`, called before any box exists.

## E2E Slice

**Demonstrable behavior:** Given 3 provider VMs, 4 provider keys and 2 host run records — run **A**
open and in flight (VM + key live, `createdAt` younger than `staleAfterMs`), run **B** open and older
than it (its teardown died), one VM with no record, one orphan `sbx-` key the provider reports as
older than `staleAfterMs`, one operator key —
When `bun scripts/sandbox-reap.ts` runs, it prints a classified report and deletes nothing. When it
runs with `--yes`, B is torn down through DF2.5 (spend captured, key revoked, revocation verified,
box destroyed, record closed), the record-less VM is destroyed, the orphan key is revoked and
verified, **A and the operator key are untouched**, and `checkHeadroom(2)` returns `allowed: true`
with `liveVms: 1 / 50`.

**Wiring closed:** On completion of this story, the fleet's live population is reconcilable and the
create path refuses over-ceiling using only code merged here plus DF2.1/DF2.2/DF2.3/DF2.5. No stub,
no `TODO: wire later`. DF3.1 exposes these as fleet verbs and DF3.2 reserves over headroom before
fan-out; neither completes this story.

**Dependency edges (predecessors):** DF2.2, DF2.3, DF2.5 — DF2.3's `revokeAndVerify(keyHash)` is
called directly for record-less orphan keys, not only transitively through DF2.5.

## Acceptance Criteria

1. **(make-or-break)** Given provider VM list × provider key list × host run records, When a sweep
   runs, Then every **factory-owned** item lands in exactly one class from the table below and
   everything else is reported `foreign` and is never a candidate (INV-1); the default mode deletes
   nothing and exits 0 with the report; `--yes` reaps only the three leak classes, and the `sbx-`
   prefix is re-asserted immediately before each key DELETE, not merely at selection
   (`reap.just:106-110`).

   **Ownership test (what "factory-owned" means, per item kind):** a key is owned iff its name
   carries the `sbx-` prefix. A VM is owned iff it matches the **generated run-id shape**
   `^[a-z0-9][a-z0-9-]*-\d{8}-[0-9a-f]{6}$` — DF2.1's `newId()` output, `<slug>-<YYYYMMDD>-<6 hex>`
   — not merely DF2.1's permissive hostname grammar `^[a-z0-9][a-z0-9-]*$`, which matches nearly
   every VM an operator ever named. **Name shape alone is not ownership proof — it is necessary,
   not sufficient.** An operator can deliberately or accidentally create a VM whose name matches the
   generated shape (e.g. `steve-devbox-20260812-a1b2c3`); the ownership test therefore also requires
   a durable, create-time provenance marker the provider `list()` call can enumerate — the ownership
   tag DF2.2's `create()` sets on every factory-provisioned VM. A name-shape match with **no**
   matching ownership tag is classified `foreign`, never a reap candidate, and is reported for
   manual remediation rather than destroyed; a name-shape match **with** the tag is `owned` per the
   table below. *Negative controls: an operator VM named `steve-devbox` fails the shape test, is
   classified `foreign`, and survives `--yes` untouched (testing the permissive grammar destroys it
   and MUST fail this test); an operator VM whose name **also** matches the generated shape but
   carries no ownership tag is likewise classified `foreign` and survives `--yes` — an implementation
   that treats a shape match alone as sufficient destroys it and MUST fail this test.*

   | Class | Definition | `--yes` action |
   |---|---|---|
   | `paired` | An open record whose `now − createdAt` is under `staleAfterMs`, together with its live VM and its live `sbx-` key. A run in flight. | none |
   | `leaked-vm` | An owned VM with **no** run record at all, or whose record is closed. Nothing is spending against it but the box bills until killed. | `driver.destroy(vm)` |
   | `leaked-key` | A live `sbx-` key whose **derived runId** (the join key, below) resolves to a closed record, or to no record file at all — the run's teardown never revoked it. | `revokeAndVerify(keyHash)` when there is no record file; `teardown(runId)` when a record exists (AC7 gates the record-less case on key age) |
   | `stale-record` | An open record whose `now − createdAt` is at or beyond `staleAfterMs` — its teardown died. Its VM and key, if still live, are reaped with it rather than counted twice. | `teardown(runId)` |
   | `paired-pending` | An `sbx-` key with **no record file** for its derived runId, whose provider-reported creation time is younger than `staleAfterMs` — a mint whose record write has not landed yet (AC7). | none |
   | `key-age-unavailable` | An `sbx-` key with no record file for its derived runId that the provider reports no creation time for (AC7). | none — report only |
   | `foreign` | Anything failing the ownership test above: unprefixed keys, VMs outside the generated shape, files outside `.sandbox/runs`. | none |

   Items are classified per item but **acted on per run**: a stale record whose VM and key are both
   live yields three classified rows and exactly **one** `teardown(runId)` call, each row reporting
   its own class and the shared action.
2. Given a configured ceiling of 50 VMs and 48 live, When `checkHeadroom(3)` is called, Then it
   returns `allowed: false` with `{ liveVms: 48, ceiling: 50, requested: 3, headroom: 2 }` and the
   dispatch path creates **zero** boxes; `checkHeadroom(2)` at the same population is allowed —
   the boundary is inclusive.
3. Given any run record that cannot be read or parsed, When a sweep runs, Then it is a hard exit with
   a non-zero code and **no deletion occurs anywhere in that sweep** — an unreadable record is a key
   nobody can account for (`reap.just:69-73`). *Negative control: skipping it passes AC1 and MUST
   fail here.*
4. Given a VM or key list that cannot be enumerated to exhaustion — a transport failure, or a
   pagination envelope the enumerator does not follow (`reap.just:41-42`, UNVERIFIED upstream) — Then
   the sweep reaps nothing and `checkHeadroom` returns `allowed: false`, reason `list-unverified`:
   unknown population means zero headroom, never full headroom.
5. Given zero VMs, zero keys and zero records, When a sweep runs, Then it exits 0 reporting
   `nothing to reap` and `checkHeadroom(n)` returns the full configured ceiling as headroom — an
   empty fleet is a normal state, not an error.
6. Given a run in flight — record open, VM live, **`sbx-` key live**, `createdAt` younger than
   `staleAfterMs` — When a sweep runs with `--yes`, Then it is classified `paired` and nothing
   about it is touched: no teardown, no destroy, no revoke. **A record open, VM live, key *not
   yet* live, and `createdAt` younger than `staleAfterMs` is the mint-to-record ordering window
   (DF2.1: record → VM → key) and is also left untouched** — it converges to `paired` on the
   next sweep once the key lands, or ages into `stale-record` at `staleAfterMs` and is reaped by
   `teardown(runId)` if the key never appears, so it is never a permanently-suppressed
   candidate. *Negative control: an implementation reading "record open" as the
   failed-teardown signal reaps a running job mid-flight and MUST fail this test — DF2.5 leaves the
   record open during a run and after an aborted teardown alike, so age is the only discriminator.*
7. Given an `sbx-` key for whose derived runId **no record file exists at all**, When the sweep
   classifies it, Then it is a `leaked-key` reap candidate **only if** the provider's reported
   creation time for that key is older than `staleAfterMs`; a younger record-less key is
   `paired-pending` and is never revoked, and a key for which the provider reports no creation time
   is `key-age-unavailable` — reported, never revoked, on any mode. The hold-off exists because
   DF2.1's ordering is record → VM → key: a record file whose write has not landed (a crash or a
   slow filesystem between mint and `create`) leaves a live run's key looking record-less for a
   window, and age is the only signal that separates that window from an orphan. *Test: seed the
   fleet with a young `sbx-` key and **withhold its record file entirely**, then sweep with `--yes`
   → zero revocations and the key reported `paired-pending`; an age-blind implementation revokes a
   live run's key and MUST fail this test.*

## Trigger Surface

| Trigger | Status | E2E Test | Follow-Up |
|---------|--------|----------|-----------|
| `bun scripts/sandbox-reap.ts [--yes]` (dry-run default) | in-scope | `tests/providers/reaper.test.ts` | — |
| `checkHeadroom(n)` on the host-side create path, before any box exists | in-scope | `tests/providers/quota.test.ts` | — |
| `fleet status` surfacing this accounting, and any scheduled sweep | out-of-scope | — | DF3.1 |
| A `fleet reap` CLI wrapper | out-of-scope — v5.0 ships none; `scripts/sandbox-reap.ts` above is the whole reaper surface, and DF3.1/DF3.2 record the same | — | none derived |
| Fan-out admission over `checkHeadroom(n)` — one call covering all N, before the first mint | out-of-scope | — | DF3.2 |
| Single-run dispatch admission — `checkHeadroom(1)` before `create` | out-of-scope | — | DF3.1 |
| Single-run teardown invoked directly by an operator | out-of-scope | — | DF2.5 |
| Audit-chain events for reap decisions and deletions | out-of-scope | — | DF5.3 |

## Infra Prerequisites

| Component | Service (compose/k8s/provider) | Lifecycle Hook Verified |
|-----------|-------------------------------|-------------------------|
| Provider `list()` / `destroy()` | exe.dev driver (DF2.2); `fake` driver in tests | `whoami` preflight passes before a sweep considers any deletion; a failed preflight reaps nothing |
| Provider key list + revoke/verify | OpenRouter via DF2.3's verbs | list enumerates to exhaustion or the sweep fails closed with `list-unverified` |
| Run record store | DF2.1 (`.sandbox/runs/*.json`, closed schema) | every record enumerable and parseable at sweep start; one unreadable record aborts before any delete |
| Single-run teardown | DF2.5 | reaper invokes `teardown(runId)` unchanged — its six-step order and abort semantics are not re-implemented here |
| Quota ceilings + `staleAfterMs` config | host file `.sandbox/quota-limits.json`, checked-in defaults in `src/providers/quota.ts` | absent file ⇒ defaults used and `limitsSource: "default"` recorded in the sweep header |

## Technical Notes

- **Ownership tag provenance:** DF2.2's `create()` is the producer of the ownership tag every
  factory-provisioned VM carries (the same call this story already depends on to populate live
  VMs); this story only reads the tag through the provider's `list()` output and treats its
  absence on a shape-matching VM as `foreign`, never as `owned`. No new dependency edge is added —
  DF2.2 is already a listed predecessor — but the reap classification now relies on that call's
  tag, not only on the name it assigns.
- **One join key for the whole three-way join: the derived runId.** A key's runId is its name with
  the `sbx-` prefix stripped; a VM's runId is its name (the generated run-id shape, AC1); a record's
  runId is its filename stem under `.sandbox/runs/`. Every class in AC1's table is decided by that
  one key, so no two ACs join on different things. The record's `keyHash` is a **confirmation, not
  the join**: where it is present it must equal the hash of the joined key, and a mismatch is
  reported and never reaped (two credentials claiming one run is not a state this sweep resolves).
  Where it is absent — the mint-to-record write window — the join still holds by name, which is what
  keeps `paired-pending` reachable at all (AC7).
- **The queue is derived, never stored.** A failed teardown's queue entry *is* its open run record
  (DF2.5 INV-5 leaves the record open on an unconfirmed destroy). A stored queue can disagree with
  the provider and an orphan it forgot spends forever, so every sweep recomputes from live state.
- **An open record is not evidence of a leak.** DF2.5 leaves the record open both *during* a run and
  *after* an aborted teardown, so the only honest discriminator is age — and since DF2.1's closed
  schema has no heartbeat field (and this story adds none), age is `now − createdAt`. A record under
  `staleAfterMs` is a job in flight, never a candidate (AC6); configure it above the longest expected
  run, since too low reaps live work while too high only delays a sweep. **Default
  `staleAfterMs: 14_400_000` (4 h)** in `src/providers/quota.ts`, comfortably above the longest
  budgeted run (DF3.2's 3_600_000 ms arm ceiling) and recorded with `limitsSource` like every other
  limit.
- **A leak that will not reap is escalated, not retried forever.** DF2.5's teardown aborts on a
  harvest failure and leaves the record open, which re-presents the same item as `stale-record` on
  every subsequent sweep. The sweep therefore counts consecutive failed reap attempts per runId in
  its own output (`.sandbox/reap/<timestamp>.json`, read back from the most recent sweep files):
  after **K = 3** consecutive failures the item is reported `reap-blocked` with the last failure's
  `{ code, message, remediation }` and is **not** retried on further sweeps until an operator clears
  it, so an unreapable box is a visible line rather than an unbounded retry loop. `reap-blocked`
  items still count against `checkHeadroom` — they are live population. This does not reintroduce a
  stored queue: classification is still recomputed from live state on every sweep, and the counter
  is only a record of *how the last three attempts went*. Losing the sweep files loses the counter,
  which costs three more attempts, not correctness.
- **Ceilings are config, not constants.** Defaults 50 VMs / 100 GB pooled disk / 200 GB transfer are
  **vendor-single-origin `[VERIFY]`** (R5 §6 fact 11), Personal plan only; a plan change is a config
  edit. The sweep header records `limitsSource` and each limit's value.
- **VM count is authoritative; disk is an estimate.** Per-VM disk is not in the one verified
  `ls --json` shape, so `usedDiskGiB` is `liveVms × configured per-VM reservation`, emitted with
  `estimated: true`. Headroom refuses on either ceiling; the estimate is never shown as measured.
- **`checkHeadroom(n)` is a read, not a lock.** It counts live population at a point in time and
  reserves nothing; it is the sole headroom entry point and its `headroom` integer is what callers
  read. **DF3.2 owns fan-out admission for all N** — one `checkHeadroom(N)` call under `src/fleet/`
  before the first mint — and **DF3.1 owns the single-run call, `checkHeadroom(1)` on the dispatch
  path before `create`**, so a serial stream of single dispatches is held to the same ceiling a
  fan-out is. Neither reserves anything: no slot is held between the read and the mints. That gap is safe only because v5.0 is a
  single-operator CLI (DD-1): one process reads and then mints, so concurrent dispatchers are out of
  scope for both stories.
- **Reap routing, and the destroy boundary:** a leak tied to a run id goes through DF2.5's
  `teardown(runId)` so spend is captured before revoke; a VM with no record has no spend and no key,
  so it goes to `driver.destroy(vm)`. Those two are the only box-destroying paths in the system.
  A **record-less** orphan key has no third path either: every DF2.5/DF2.3 verb above is keyed by
  `runId` and reads a record that does not exist, so it goes to DF2.3's record-free
  `revokeAndVerify(keyHash)` — the same DELETE → re-list → assert-absent gate (INV-CRED-4), no
  record read, no spend capture (there is no key to read usage against once it is unmatched). The
  reaper still owns no revoke logic of its own.
- **Guards/limits:** at most 20 list pages before failing closed; provider calls time out at
  15_000 ms; a sweep reaps at most 25 items per invocation and reports the remainder, so a runaway
  classification cannot delete a fleet in one command.
- **Deviation/assumption:** inkwell's `reap.just` shipped unrun (R4 §3.6), so nothing in it is
  inherited as proven — tests here are blocking, provider paths run on `fake`, exe.dev is `[VERIFY]`.

## Observability Contract

- Every sweep logs a header `{ requestId, limitsSource, ceilings, liveVms, liveKeys, records }`
  then one line per item: `{ requestId, class, vm?, keyHashPrefix?, runId?, action, durationMs }`.
- `action` is one of `report` / `teardown` / `destroy` / `revoke` / `skipped` / `reap-blocked`,
  recorded in dry run exactly as it would be with `--yes`, so the report predicts the deletion.
- Sub-timings: `list_vms_ms`, `list_keys_ms`, `read_records_ms`, `reap_ms`; errors carry
  `{ code, message, remediation }`. The reaper reads only key **hashes** from the provider list — no
  key value reaches a log line, a report or an error payload.

## Files to Modify

- `src/providers/quota.ts`
- `src/providers/reaper.ts`
- `src/providers/index.ts`
- `scripts/sandbox-reap.ts`
- `tests/providers/quota.test.ts`
- `tests/providers/reaper.test.ts`
- `tests/providers/fixtures/fleet-state.ts`

## Security Invariants

- **INV-1 (prefix + provenance defense-in-depth):** no key lacking the `sbx-` prefix, and no VM
  outside the **generated run-id shape** `^[a-z0-9][a-z0-9-]*-\d{8}-[0-9a-f]{6}$` **carrying a
  matching create-time ownership tag** (AC1's ownership test — not DF2.1's permissive hostname
  grammar, which matches nearly any VM name an operator would pick, and not name shape alone, which
  an operator can coincidentally or deliberately match), is ever a reap candidate; the prefix and
  the ownership tag are both re-asserted immediately before the DELETE, not only at selection. A
  name-shape match with no ownership tag is `foreign`, reported for manual remediation, never
  destroyed. Operator keys carry no prefix and deleting one is unrecoverable
  (DF2.3 INV-CRED-6, `reap.just:8-9, 60-61, 106-110`).
- **INV-2 (unreadable input is a hard error, never a skip):** a malformed or unreadable run record
  aborts the whole sweep with a non-zero exit before any deletion. Loud, not skipped — a record
  quietly dropped is a key that quietly keeps spending.
- **INV-3 (resource ceiling):** the configured VM and pooled-disk ceilings are the control; the
  create path calls `checkHeadroom(n)` and refuses below it, so fan-out cannot exhaust the account.
  Ceilings and their source are recorded on every decision; a disk estimate is labelled as one.
- **INV-4 (credential):** the reaper never mints and never delivers a key. It revokes only through
  DF2.3's verbs — `teardown(runId)` where a record exists, `revokeAndVerify(keyHash)` where none
  does — so revocation is verified against the authoritative key **list** and never the single-key
  endpoint, and spend is captured before revoke for every orphan that still has a record. A key
  whose age the provider will not report is never revoked at all (AC7).
- **INV-5 (fail-closed, dry-run default):** destructive mode is opt-in via `--yes`; the default is a
  report. An unenumerable VM or key list means zero headroom and zero reaping — the sweep never
  infers absence from a truncated page, never infers headroom from a population it could not count,
  and never infers abandonment from an open record alone: inside `staleAfterMs` it is a live run.

## Definition of Done

- [ ] **Impl:** `sweep()` performs the three-way join and classifies every item into exactly one of
      AC1's classes — `paired` / `leaked-vm` / `leaked-key` / `stale-record` / `paired-pending` /
      `key-age-unavailable` / `foreign` — with `staleAfterMs` the sole in-flight test, the generated
      run-id shape **plus a matching create-time ownership tag** the VM-ownership test (shape alone
      is never sufficient), and items sharing a runId collapsing to one action.
- [ ] **Impl:** `checkHeadroom(n)` reads ceilings from config with checked-in defaults, records
      `limitsSource`, returns `{ allowed, liveVms, ceiling, headroom, reason? }` — no lock, no state.
- [ ] **Contract:** DF2.1's twelve-field record is unchanged by this story (asserted by a key-set
      diff); sweep output lands at `.sandbox/reap/<timestamp>.json`.
- [ ] **Integration:** identified leaks are reaped through DF2.5's `teardown(runId)`; only a
      record-less VM reaches `driver.destroy` directly and only a record-less key reaches DF2.3's
      `revokeAndVerify(keyHash)` — no third destroy path and no reaper-owned revoke logic exists.
- [ ] **Security:** `sbx-` prefix re-asserted immediately before every key DELETE, and dry run is the
      default mode (INV-1, INV-5).
- [ ] **Test (unit):** each class in AC1's table is produced from a fixture fleet state — including
      an in-flight run classified `paired` and untouched under `--yes` (AC6), an operator VM
      `steve-devbox` classified `foreign` and untouched, and an operator VM whose name matches the
      generated run-id shape but carries no ownership tag also classified `foreign` and untouched
      under `--yes` — and dry run emits the same `action` values that `--yes` executes.
- [ ] **Test (mint race):** a young `sbx-` key whose record file the fixture withholds entirely →
      sweep with `--yes` performs zero revocations and reports it `paired-pending`; a provider key
      with no creation timestamp reports `key-age-unavailable` and is never revoked (AC7).
- [ ] **Test (reap-blocked escalation):** the same `stale-record` failing teardown on three
      consecutive sweeps → the fourth sweep reports it `reap-blocked` with the last failure's
      remediation and issues **zero** further teardown calls for it, while still counting it in
      `liveVms`; an implementation that retries indefinitely MUST fail this test.
- [ ] **Test (malformed record):** one unreadable record → non-zero exit with zero deletions
      anywhere in the sweep; a skip-and-continue implementation MUST fail this test (AC3).
- [ ] **Test (headroom boundary):** 48 live against a ceiling of 50 → `checkHeadroom(2)` allowed,
      `checkHeadroom(3)` refused with zero boxes created (AC2).
- [ ] **Test (unenumerable list):** truncated key page and a `list()` transport failure each yield
      `list-unverified`, zero reaping, and zero headroom — never a false "nothing is leaking" (AC4).
- [ ] **Test (e2e demo — MANDATORY):** against the `fake` driver seeded with 3 VMs / 4 keys / 2
      records, `sandbox-reap.ts --yes` produces `.sandbox/reap/<timestamp>.json` showing one teardown,
      one destroy, one revoke; the fleet then holds only in-flight run A and the operator's
      unprefixed key, and `checkHeadroom(2)` is allowed.

## Dev Agent Record

<!-- Empty placeholder — filled during development. -->
