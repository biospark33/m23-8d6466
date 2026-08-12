# DF2.5: Bundle Harvest + Tested Teardown

**Story Points:** 4
**Sprint:** v5-S1 (track B, provider; closes S1's provider chain)

## Spec Reference

- `docs/superpowers/specs/2026-08-11-dark-factory-v5-architecture-design.md` §3.4, §5.3, §6 items 2/4/6
- Decision register: v5 §4 D7 (provider seam), D8 (no push credential in any box; host-side PR)
- Contracts: v5 §5.2 observability (requestId propagation, per-phase sub-timings); the closed
  run-record schema owned by DF2.1
- Derivation decisions: `docs/superpowers/specs/2026-08-11-v5-story-derivation-decisions.md` DD-8, DD-10
- Evidence: R4 §3.3 (ranged bundle), §3.1 (teardown ordering), **§3 flag 4 + §3.6 — inkwell's
  teardown/reap are untested code** (`teardown_and_reap.md:6`); R5 §6 facts 15, 17
- Build order: v5 §8 step 2

## User Story

As a factory operator,
I want a run's commits, artifacts and trace pulled back across a credential-free gap and a teardown
that has actually been run under test,
so that a finished box can be destroyed without ever losing work and without a push credential
existing anywhere inside it.

## Overview

A box is filled by an unauthenticated `git clone` and holds exactly one secret: the DF2.3 run key —
no PAT, no deploy key, no ssh identity for the code host, because it runs an autonomous agent under
`--dangerously-skip-permissions`. Harvest moves commits across that gap with no credential at all:
the box writes a **ranged** git bundle, the host copies it down, verifies it, and fetches it into
`refs/sandbox/<run-id>`, a quarantine namespace touching no branch, index or working tree. Teardown
then runs a fixed order (spend → artifacts → commits → revoke → destroy → close) in which a harvest
failure aborts before anything irreversible. The reference shipped both unrun — hence these tests.

## E2E Slice

**Demonstrable behavior:** Given a box whose branch `sbx/<run-id>` carries three commits on the sha
FILL pinned, When the operator runs `bun scripts/sandbox-teardown.ts <run-id>`, it captures spend →
pulls `artifacts.tar` (specs, app docs, `run.log`) and the trace DB → creates
`<base>..refs/heads/sbx/<run-id>` in-box, copies it to `.sandbox/runs/<run-id>.bundle`, verifies it,
and fetches to `refs/sandbox/<run-id>` → revokes the key, destroys the box, closes the record.
`git rev-list --count refs/sandbox/<run-id>` prints `3`, host `git status --porcelain` is empty, and
`git branch --list` is unchanged.

**Wiring closed:** On completion of this story, harvest and teardown are real for any registered
provider driver using only code merged by this story plus its predecessors. No stub, no
`TODO: wire later`; the tests drive real `git bundle`/`git fetch` against a real throwaway
repository rather than a mock.

**Dependency edges (predecessors):** DF2.1, DF2.2, DF2.3 — teardown calls DF2.3's `captureSpend`,
`revokeRunKey` and `verifyRevoked` directly, not only through DF2.2.

## Acceptance Criteria

1. **(make-or-break)** Given a run branch `sbx/<run-id>` with commits descending from the
   FILL-pinned `<base>`, When harvest runs, Then the bundle is created **ranged**
   (`<base>..refs/heads/sbx/<run-id>`), copied to `.sandbox/runs/<run-id>.bundle`,
   `git bundle verify` passes **before** any fetch, and the objects land only at
   `refs/sandbox/<run-id>` — the host's working tree, index, `HEAD` and every operator-owned branch
   and tag are byte-identical before and after (R4 §3.3).
2. Given a run branch that does **not** descend from the pinned base, When harvest runs, Then
   `git fetch` refuses the bundle's prerequisite, harvest exits non-zero naming the missing sha, and
   no ref under `refs/sandbox/` is created or updated. The range is the integrity check: an
   implementation using `git bundle create --all` passes AC1 and MUST fail this test.
3. Given harvest fails for any reason, When `teardown <run-id>` runs without `--no-harvest`, Then
   teardown aborts **before** key revoke and box destroy, the box is left alive, the record is left
   open, and the next command to run is printed. Destroying a box whose commits were never pulled is
   the one irreversible mistake available here (R4 §3.3).
4. Given a run whose branch has zero commits beyond base, When harvest runs, Then `git bundle
   create` refusing an empty bundle is classified as a **successful no-op** — no ref is created, no
   `.bundle` file is left behind, the outcome is logged as `harvested: none`, and teardown proceeds
   normally rather than aborting under AC3.
5. Given a run already harvested that then committed more, When harvest runs again, Then
   `git fetch --force` updates `refs/sandbox/<run-id>` in place rather than failing on a
   non-fast-forward, and the artifacts tar and trace DB are re-pulled to the same host paths —
   harvest is idempotent and re-runnable at any point.
6. Given `git bundle verify` is unavailable at preflight, or the driver cannot **confirm** the box
   was destroyed, When teardown runs, Then it stops at that step leaving the box alive and the
   record open with the failure recorded, so DF2.6's reaper finds it — a run is never marked torn
   down on an unconfirmed destroy. `--no-harvest` waives AC3's harvest gate only; it never waives
   these, and the waiver is written to the run log, never to the record (INV-5).

## Trigger Surface

| Trigger | Status | E2E Test | Follow-Up |
|---------|--------|----------|-----------|
| `bun scripts/sandbox-teardown.ts <run-id> [--no-harvest]` | in-scope | `tests/providers/teardown.test.ts` | — |
| `bun scripts/sandbox-teardown.ts harvest <run-id>` | in-scope | `tests/providers/harvest.test.ts` | — |
| `fleet harvest` / `fleet teardown` subcommands | out-of-scope | — | DF3.1 |
| Fleet-wide orphan sweep (reaper) + quota headroom refusal | out-of-scope | — | DF2.6 |
| Auto-teardown after a PR opens | out-of-scope | — | DF5.2 |
| Host-side re-verify of harvested commits before any PR | out-of-scope | — | DF5.1 |
| Audit-chain events for harvest/revoke/destroy | out-of-scope | — | DF5.3 |

## Infra Prerequisites

| Component | Service (compose/k8s/provider) | Lifecycle Hook Verified |
|-----------|-------------------------------|-------------------------|
| Provider box + `exec`/`copyFile` primitives | exe.dev driver (DF2.2); `fake` driver in tests | DF2.2's five-assertion setup gate returned ready before harvest is callable |
| Host `git` with `bundle verify` | host toolchain (no service) | teardown preflight asserts `git bundle verify` is available and exits non-zero leaving the box untouched if not (INV-5) |
| Run record `.sandbox/runs/<run-id>.json` | DF2.1 store, host filesystem | record exists and `closedAt` is empty before teardown proceeds; teardown closes it as its last step |
| Per-run LLM key + revoke/verify verbs | DF2.3 credential lifecycle | spend read from the live key before revoke; revocation verified against the authoritative key list by DF2.3's verb |
| Trace DB + artifacts inside the box | DF1.4 trace store, written in-box | both present in the single tar round trip; absence is logged and does not abort harvest |

## Technical Notes

- **Why a bundle and not a push:** a push credential would give a skip-permissions agent write
  access to the repo it was cloned from, so the box holds none and a bundle crosses that gap with
  no credential (R4 §3.3; D8). **DD-10:** P1.15's in-box push is reversed, dead, never cited here.
- **Why a range and not `--all`:** a ranged bundle records the prerequisite "you must already have
  `<base>`", and `git fetch` refuses it otherwise, so a branch that does not descend from the sha
  FILL pinned is caught on the return trip instead of importing disconnected history (R4 §3.3; AC2).
- **Harvest set (v5 §5.3):** ranged bundle + artifacts tar + trace DB, in one tar round trip plus
  one bundle copy. Harvest writes **nothing** to the run record: the bundle's presence at
  `.sandbox/runs/<run-id>.bundle` is the record, and DF2.1's schema stays closed.
- **Teardown order, fixed:** spend captured → artifacts out → commits harvested → key revoked → box
  destroyed → record closed + key file shredded. Spend must be read before revoke because the number
  is unrecoverable afterwards. A crash between revoke and destroy leaves a dead key and a live box
  (visible, cheap); the reverse leaves a live key nobody can find (invisible, spending) (R4 §3.1).
  **The six steps are a floor, not a closed list — the contract is their relative order.** A later
  story may insert or prepend a step (DF4.2 stops the visualizer ahead of spend capture; DF2.8 hooks
  its `ingestBoxHours` call to the close step; DF5.3 adds a single-line `recordAuditLink(...)` emit
  at the teardown/reap events) without amending this story, provided all six keep their
  relative order. Ordering assertions here are therefore written as **subsequence / relative-order**
  checks over the recorded call order, never equality against a fixed six-element array, so an
  inserted step does not fail a test that is really about ordering.
- **Boundaries (so nothing ships twice):** DF2.3 owns mint → cap → revoke → verify-against-the-key-list
  and the key file's shred; DF2.5 owns the ordering that calls them and the abort semantics. DF2.6
  owns the fleet sweep, failed-teardown queue and quota; DF2.5 tears down **one** run, nothing else.
  DF2.8 owns the cost ledger and hooks its `ingestBoxHours` call to this teardown's **close** step;
  DF2.5 neither computes nor writes a ledger row, and an aborted teardown that never reaches close
  writes none (df2-8 AC / DF2-P2-03). **`src/providers/teardown.ts` has four claimants and a fixed
  merge order:** DF2.5 writes it; DF4.2 prepends the visualizer stop; DF2.8 adds the
  `ingestBoxHours` call at close; DF5.3 lands last (sprint v5-S3), adding only its single-line
  `recordAuditLink(...)` emit at the already-existing teardown/reap events. Each later claim is
  additive — no signature change, no reordering of the six steps.
- **Guards/limits:** bundle ≤ 512 MiB and artifacts tar ≤ 512 MiB, enforced on the received bytes
  AND on the summed entry sizes before extraction — an uncompressed-total cap, so a compressed tar
  cannot fill the host disk. Over-cap fails harvest loudly, box left alive. Tar expansion rejects an
  absolute-path, `..` or escaping-symlink entry, **and rejects hard links and every non-regular
  entry type (device nodes, FIFOs, block/char special files)**, before writing a byte (INV-3) —
  the untrusted box can otherwise use a hard link or a special entry to affect paths outside the
  extraction directory depending on the extractor; every step idempotent.
- **Deviation/assumption — the reference has no tests.** Inkwell's `teardown.just` (197 lines) and
  `reap.just` (138 lines) shipped unrun by their own cookbook (R4 §3, §3.6), so every `MEASURED`
  comment in them is manual probing. Nothing is inherited as proven: the tests here are blocking,
  and provider paths run against `fake` with exe.dev recorded `[VERIFY]` single-origin (R5 §6 f.11).

## Observability Contract

- Every teardown step logs `{ requestId, runId, step, driver, timestamp, durationMs, outcome }` for
  each of the six fixed steps — whether it ran, was skipped as already-done, or failed.
- requestId propagates from the dispatcher (DF3.1) or is minted by the CLI; errors carry
  `{ code, message }` and never the run key.
- Sub-timings: `bundle_create_ms`, `transfer_ms`, `verify_ms`, `fetch_ms`, `artifacts_ms`. Where the
  driver cannot break a remote call down, it reports `0` and `durationMs` is authoritative.

## Files to Modify

- `src/providers/harvest.ts`
- `src/providers/teardown.ts`
- `src/providers/index.ts`
- `scripts/sandbox-teardown.ts`
- `tests/providers/harvest.test.ts`
- `tests/providers/teardown.test.ts`
- `tests/providers/fixtures/git-fixture.ts`

## Security Invariants

- **INV-1 (credential containment):** no push credential — PAT, deploy key, ssh identity or
  `.git-credentials` — exists inside a box at any point in this flow, and harvest introduces none.
  A test asserts the box's `git remote get-url origin` is the unauthenticated clone URL and that its
  credential-bearing paths are absent. Negative control: an implementation that pushes from the box
  satisfies "the commits arrived" and MUST fail this test (D8; R5 §6 fact 17).
- **INV-2 (trust boundary):** the bundle is untrusted input produced by a skip-permissions agent —
  in-box evidence is a claim, not proof (F10/R9; R5 §6 fact 15). Ordering is fixed and enforced:
  `git bundle verify` succeeds **before** `git fetch` runs, and the fetch refspec targets
  `refs/sandbox/<run-id>` only — never a branch, tag, remote-tracking ref, the index or the working
  tree. Nothing merges here and no PR opens on this evidence; host-side re-verification is DF5.1's.
- **INV-3 (input validation on unpack):** the artifacts tar is validated before extraction — any
  entry with an absolute path, a `..` segment, a symlink escaping the destination, a hard link, or
  a non-regular entry type (device node, FIFO, block/char special) aborts it with nothing written.
  Both caps are checked host-side against the received size, never a reported one.
- **INV-4 (credential lifecycle ordering):** spend is captured from the live key **before** DF2.3's
  revoke runs, and the key file is shredded only after revocation is verified. Harvest completing is
  a precondition of reaching revoke at all (AC3), so no key is destroyed while work is still only in
  the box.
- **INV-5 (fail-closed):** if `git bundle verify` is unavailable, the bundle fails verification, or
  the driver cannot **confirm** box destruction, teardown stops and leaves the record open with the
  failure recorded, so DF2.6's reaper finds it. A run is never marked torn down on an unconfirmed
  destroy, and no failure path silently proceeds to the next step.

## Definition of Done

- [ ] **Impl:** `harvest(runId)` — ranged bundle in-box, copy down, verify, fetch to
      `refs/sandbox/<run-id>` with `--force`; artifacts tar and trace DB in one round trip
- [ ] **Impl:** `teardown(runId, {noHarvest})` in the fixed six-step order, every step individually
      guarded and idempotent, printing the next command on any failure
- [ ] **Contract:** harvest writes nothing to the run record; DF2.1's twelve-field schema is
      unchanged by this story (asserted by a test that diffs the record's key set)
- [ ] **Integration:** both entry points go through `ProviderDriver.exec`/`copyFile` only — no
      substrate-specific command appears in `harvest.ts` or `teardown.ts`
- [ ] **Security:** fetch refspec restricted to `refs/sandbox/` and verify-before-fetch ordering
      enforced (INV-2); tar entries validated before extraction, including rejection of hard links
      and non-regular entry types (INV-3)
- [ ] **Test (unit + fail-closed):** step order by call-order capture (spend→revoke→destroy, record
      closed last); a bundle failing `verify` never reaches `git fetch`, and an unconfirmed destroy
      leaves the box alive and the record open with the failure recorded (AC6, INV-5)
- [ ] **Test (non-descendant branch):** a branch off an unrelated root → fetch refuses the
      prerequisite, no `refs/sandbox/` ref written; a `--all` bundle implementation MUST fail (AC2)
- [ ] **Test (harvest failure aborts teardown):** injected harvest failure → box still alive, key
      not revoked, record still open (AC3) — this is the path the reference implementation shipped
      unrun (R4 §3, `teardown_and_reap.md:6`)
- [ ] **Test (empty branch):** zero commits beyond base → `harvested: none`, no ref, no bundle file,
      teardown proceeds (AC4)
- [ ] **Test (rejected archive type, INV-3):** an artifacts tar containing a hard link, a device
      node, or a FIFO entry → extraction aborts before writing any byte and the destination
      directory is left empty; an implementation that only checks path traversal and symlinks
      MUST fail this test.
- [ ] **Test (e2e demo — MANDATORY):** against a real throwaway git repo and the `fake` driver, a
      three-commit run is harvested and torn down; `git rev-list --count refs/sandbox/<run-id>`
      prints `3`, host `git status --porcelain` is empty, and the closed record with `spendMicroUsd`
      set is captured in the Dev Agent Record

## Dev Agent Record

<!-- Empty placeholder — filled during development. -->
