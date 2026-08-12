# DF2.3: Per-Run Credential Lifecycle — Mint, Cap, Deliver, Revoke, Verify-Against-List

**Story Points:** 4
**Sprint:** v5-S1 (track B, provider)

## Spec Reference

- `docs/superpowers/specs/2026-08-11-dark-factory-v5-architecture-design.md` §3.4, §5.3, §6 items 2/4
- Decision register: v5 §4 **D8** (credential architecture = inkwell lifecycle as code)
- Contracts: v5 §5.2 observability (requestId propagation); run-record schema owned by DF2.1
- Binding facts: R5 §6 facts **15, 16, 17** (nothing in a box is trusted; one secret per box; no push credential)
- Decision register (derivation): `docs/superpowers/specs/2026-08-11-v5-story-derivation-decisions.md` **DD-9** (µ$ cost unit)
- Source patterns (file:line): R4 §3.1 — `INK/just/sandbox/lifecycle/create.just:8-14, 22, 128-129, 133-136, 146-167`;
  `fill.just:147-155`; `teardown.just:8-11, 73-100, 142-196`; `reap.just:41-42, 60-61, 69-73, 106-137`

## User Story

As the factory host,
I want every run's LLM key minted with a spend cap, delivered without ever touching argv, and revoked with revocation proven against the provider's authoritative key list,
so that a run that dies anywhere cannot leave a live key spending money that nobody can find.

## Overview

`mintRunKey` calls the provider's key API with a `sbx-<run-id>` name and a cap, writes only
`keyHash` into the DF2.1 run record, and hands the plaintext to `deliverRunKey`, which pipes it
over the driver's stdin channel into a `0600` file inside the box. At teardown, `captureSpend`
reads usage **before** anything is destroyed, `revokeRunKey` issues the DELETE, and
`verifyRevoked` re-lists the provider's keys and asserts the hash is absent — because the
single-key endpoint returns `200` for a dead key. This story closes the credential half of the
provider lifecycle DF2.1 declares; DF2.2 consumes the delivered key from inside the box.

## E2E Slice

**Demonstrable behavior:** Given a run record created by DF2.1 and a provider key API, When
`runCredentialLifecycle(runId)` executes, it mints `sbx-<run-id>` capped at the configured
ceiling → records `keyHash` and `limitMicroUsd` → delivers the secret over stdin into `app/.env`
(mode `0600`, verified by `stat`, never echoed) → captures `spendMicroUsd` → revokes → re-lists
and asserts absence. Observable artifact: a run record left **open** (closure is DF2.5 teardown's
last step) carrying `keyHash`, `limitMicroUsd`, `spendMicroUsd`, and **zero** occurrences of the
plaintext key in the record, the audit log, or any captured argv.

**Wiring closed:** On completion of this story, a per-run key is minted, capped, delivered,
revoked and revocation-verified using only code merged by this story plus DF2.1's driver
interface and run record. No stub, no `TODO: wire later`, and no sibling story is required to
make this behavior real. DF2.2 and DF2.5 consume it; they do not complete it.

**Dependency edges (predecessors):** DF2.1.

## Acceptance Criteria

1. **(make-or-break)** Given a created run record and a provider double, When the full lifecycle
   runs, Then the record carries `keyHash`, `limitMicroUsd`, `spendMicroUsd` populated and is left
   open (closure is owned by DF2.5 teardown);
   `spend` is captured **before** the `DELETE` (a double that zeroes usage post-delete still yields
   a non-zero `spend`); the plaintext key appears in **no** record field, log line, or recorded
   argv; and the key hash is absent from `GET /keys` afterwards.
2. Given a provider whose **single-key endpoint returns `200` for an already-deleted key**
   (measured, `teardown.just:179-180`), When `verifyRevoked` runs, Then it passes because it
   gates on the key **list**. Given a provider whose `DELETE` returns `2xx` but the hash is still
   present in the list, Then verification **fails**, the VM is left alive, and the manual
   `curl -X DELETE` remediation line is printed. *Negative control: an implementation that gates
   on `GET /api/v1/key` passes the first half and MUST fail the second.*
3. Given `DELETE` returns `404`, Then it is treated as already-revoked **only after `verifyRevoked`
   confirms the hash is absent from the list** — a `404` from a moved or misspelled route must never
   be read as revocation — and the lifecycle proceeds (idempotent re-run, first-close-wins on the
   record). Given `DELETE` returns `5xx`, Then it is a hard failure: non-zero exit, VM untouched,
   record left open, next command printed.
   *(Record closure is not part of this lifecycle at all — on every path the record stays open for
   DF2.5 teardown to close as its final step.)*
4. Given a key list response that is empty, or that carries a pagination envelope, When
   `verifyRevoked` runs, Then absence is never inferred from a truncated page — it either follows
   pages to exhaustion or fails closed with `list-unverified` (pagination shape is UNVERIFIED
   upstream, `reap.just:41-42`).
5. Given secret delivery, When the driver `exec` is invoked, Then the recorded argv on both sides
   contains no substring of the secret of length ≥ 8, and the remote file reports mode `600` via
   `stat` — the value is never echoed back to assert it.
6. Given a cap of `50_000_000` µ$, When `mintRunKey` calls the provider, Then the request carries
   `50.00` **dollars** (DD-9 conversion at the HTTP boundary only) and the value read back into
   `limit` is `50_000_000` µ$; the same round-trip holds for `spend`. No µ$ integer is ever sent and
   no dollar float is ever stored — a 100× or 10_000× unit slip fails this AC.

## Trigger Surface

| Trigger | Status | E2E Test | Follow-Up |
|---------|--------|----------|-----------|
| `create` phase of the DF2.1 driver lifecycle (mint + deliver) | in-scope | `tests/providers/credentials.test.ts` | — |
| `teardown` phase (capture spend → revoke → verify; record closure is DF2.5's) | in-scope | `tests/providers/credentials.test.ts` | — |
| Fleet-wide orphan sweep re-using the same revoke+verify gate | out-of-scope | — | DF2.6 |
| Cost ledger reading `spend` off closed records (`qds cost <issue>`) | out-of-scope | — | DF2.8 |
| `fleet teardown` CLI verb (v5.0 ships no `fleet reap` wrapper — the reaper is DF2.6's `scripts/sandbox-reap.ts`) | out-of-scope | — | DF3.1, DF2.6 |
| Audit-chain events for mint/cap/revoke/verify | out-of-scope | — | DF5.3 |

## Infra Prerequisites

| Component | Service (compose/k8s/provider) | Lifecycle Hook Verified |
|-----------|-------------------------------|-------------------------|
| Provisioning key `OPENROUTER_PROVISIONING_KEY` | host environment only — never a box, never over ssh | preflight asserts presence **by name only**; absent ⇒ hard exit before any VM or record exists |
| Provider key API (`POST/GET/DELETE /keys`) | OpenRouter (the working path today, R5 §6 fact 4) | mint returns `2xx` with a hash; the same hash is readable from `GET /keys` |
| Run record store | DF2.1 run-record module (`.sandbox/runs/<id>.json`, O_EXCL, closed schema) | record exists **before** mint — ordering is record → VM → key |
| Driver `exec(vm, cmd, stdin)` | DF2.1 provider-driver interface | stdin channel proven by the delivery test's argv assertion |

## Technical Notes

- **Contracts/Schema:** no new wire contract. This story writes only fields DF2.1's closed
  run-record schema already declares (`keyHash`, `limitMicroUsd`, `spendMicroUsd`); `closedAt` is
  NOT written here — closure is DF2.5 teardown's last step. An unknown key is rejected, not written.
- **Ordering is the design** (`create.just:8-14`, `teardown.just:8-11`): create is **record → VM →
  key** (a failed mint orphans a cheap, visible VM; a failed VM after a mint orphans a key that
  spends invisibly). Teardown is **spend captured → artifacts out → commits harvested → key
  revoked → VM destroyed**. Spend must be read before the DELETE — after it the number is
  unrecoverable (`teardown.just:73-100`).
- **Units (DD-9):** caps and spend are stored as integer micro-dollars; the provider API speaks
  decimal dollars, so conversion happens **only** at the HTTP boundary (AC6). Default run-key cap
  **50_000_000 µ$ ($50.00)**, configurable, derived from `create.just:22`. This is the provider-side
  **backstop** and is deliberately a different number from DD-9's **5,000,000 µ$ ($5.00)** default
  *budget* cap in DF2.8: the invariant is
  `residentSpendCeilingMicros < runBudgetCapMicros ≤ defaultKeyCapMicroUsd` — DF3.6's strict chain,
  copied verbatim — so the factory's own limit always bites first. **This story does not re-implement
  that assertion.** DF3.6's manifest loader (`loadResidentBounds`, df3-6 AC2a / INV-BND-2) is its
  single owner: it is asserted once at manifest load, over the configured defaults only, and DF2.3
  and DF2.8 reference it rather than each running their own. The
  per-mint *effective* cap DF2.8 hands to `mintRunKey` is `min(defaultKeyCapMicroUsd,
  remainingMicroUsd)` and is **exempt** from it — a run near its issue cap legitimately mints below
  every configured ceiling, and re-asserting the ordering against that clamped value would refuse
  every remainder-capped mint (the same note carries in DF2.8's Technical Notes).
- **Delivery target is fixed, not negotiated per consumer:** `deliverRunKey` writes
  `/home/agent/app/.env` inside the box at mode `0600`, containing the single line
  `OPENROUTER_API_KEY=<key>` and nothing else. That path and that variable name are the contract
  DF2.2's setup gate asserts against (assertion E reads the key from this file) and the pi runtime
  reads at execute time — neither side may pick its own spelling.
- **`revokeAndVerify(keyHash)` — the record-free variant:** every other verb here is keyed by
  `runId` and reads the run record. An orphan `sbx-` key found by DF2.6's sweep has no record, so
  this story also exports `revokeAndVerify(keyHash)`, which performs the same DELETE →
  re-list → assert-absent sequence (INV-CRED-4, INV-CRED-6) against a hash alone, writes no record
  and captures no spend. DF2.6 routes record-less keys here; keys that still have a record go
  through DF2.5's `teardown(runId)` so spend is captured first.
- **The `sbx-` prefix is load-bearing** (`create.just:128-129`, `reap.just:60-61`, `:106-110`):
  it is the only thing distinguishing managed keys from the operator's personal ones, and it is
  re-asserted at the point of deletion, not merely at selection.
- **Guards/limits:** provider HTTP calls time out at 15_000 ms and retry at most twice on
  transport errors only — never on a `4xx`. Verification lists at most 20 pages before failing
  closed. Response bodies land in a `0600` temp file shredded on every exit path.
- **Server-side secret injection [VERIFY]:** exe.dev advertises injection where the VM can use a
  secret it cannot read (design §3.5) — **vendor-single-origin, unconfirmed**. The capability is
  an optional driver flag defaulting to `false`, used only when a driver reports `true` **and** an
  injection round-trip test passes. Otherwise delivery falls back to the proven stdin path (on-disk
  `0600` plaintext in-box is therefore a recorded deviation). No AC assumes the capability exists.
- **Deviation/assumption:** inkwell's `teardown.just` and `reap.just` are shipped **unrun** by
  their own cookbook (R4 §3.6), so every `MEASURED` comment in them is manual-probe evidence, not
  a test result. This story therefore carries executable tests as blocking ACs; the reference
  implementation has none to inherit.
- **No compliance artifact is assumed.** exe.dev has no SOC 2, no customer-facing DPA and no SLA
  (R5 §6 fact 11). Nothing here treats a vendor attestation as a control.

## Observability Contract

- Every lifecycle step logs `{ requestId, runId, step, keyHashPrefix, durationMs, outcome }` —
  `keyHashPrefix` is the first 8 chars of the **hash**, never the key.
- requestId propagates from the dispatch that created the run record; errors include
  `{ code, message, remediation }` — the literal next command, with secrets referenced by **env-var
  name** (`$OPENROUTER_PROVISIONING_KEY`), never expanded, so AC2's `curl -X DELETE` line is safe.
- Sub-timings: `mint_ms`, `deliver_ms`, `capture_spend_ms`, `revoke_ms`, `verify_ms`.

## Files to Modify

- `src/providers/credentials.ts`
- `src/providers/index.ts`
- `tests/providers/credentials.test.ts`
- `tests/providers/fixtures/fake-key-api.ts`
- `tests/providers/fixtures/recording-driver.ts`

## Security Invariants

- **INV-CRED-1 (scoping + rotation):** exactly one secret per box — the per-run, spend-capped,
  revocation-verified LLM key (R5 §6 fact 17). No push credential, no cloud credential, no
  second LLM key ever reaches a box. **Rotation cadence:** the run key's lifetime *is* its rotation
  — minted per run, revoked at teardown, never reused across runs. The provisioning key is
  long-lived and operator-rotated in host env; this story never rotates it. No signing keys exist.
- **INV-CRED-2 (provisioning key containment):** the provisioning key is host-only. It is never
  printed, never written to a box, never passed over ssh, and never enters a run record. Only its
  presence, by variable name, is logged.
- **INV-CRED-3 (delivery):** secrets travel over **stdin, never argv**, so they never appear in
  `ps` on either side. The receiving file is created under `umask 077` and confirmed `0600` by
  `stat` — confirmation never echoes the value. Response bodies and key files are `0600` and
  shredded (`shred -u`, else `rm -Pf`, else `rm -f`) on every exit path.
- **INV-CRED-4 (revocation proof):** revocation is verified against the **authoritative key
  list**. The single-key endpoint returns `200` for deleted keys and must never gate revocation.
  Absence is never inferred from a truncated page; an unenumerable list fails closed.
- **INV-CRED-5 (fail-closed ordering):** a failure anywhere leaves the **visible-and-cheap**
  residue, never the invisible-and-spending one: record before VM, VM before key, spend captured
  before revoke, revoke before destroy. Every failure path leaves the VM alive and prints the
  next command; nothing silently degrades.
- **INV-CRED-6 (prefix defense-in-depth):** no key lacking the `sbx-` prefix is ever considered
  for deletion, and the prefix is re-asserted immediately before the DELETE — a bug upstream must
  not be able to reach a personal key.

## Definition of Done

- [ ] **Impl:** `mintRunKey` / `deliverRunKey` / `captureSpend` / `revokeRunKey` / `verifyRevoked`
      exported from `src/providers/credentials.ts` and composed into one ordered lifecycle, plus
      the record-free `revokeAndVerify(keyHash)` variant DF2.6's orphan sweep calls (same DELETE →
      re-list → assert-absent gate, no record read, no spend capture).
- [ ] **Impl:** micro-dollar storage with dollar conversion confined to the HTTP boundary; default
      cap 50_000_000 µ$ exported as `defaultKeyCapMicroUsd` for DF3.6's `loadResidentBounds` to
      assert `residentSpendCeilingMicros < runBudgetCapMicros ≤ defaultKeyCapMicroUsd` against —
      this story exposes the value and re-implements no ordering check of its own.
- [ ] **Contract:** only DF2.1 run-record fields are written; a write of an undeclared field is
      rejected by the record layer and surfaces as a test failure, not a silent drop.
- [ ] **Integration:** delivery goes through DF2.1's `exec(vm, cmd, stdin)` seam; the fake driver
      records both sides' argv for assertion.
- [ ] **Security:** revocation gated on the key list, never the single-key endpoint (INV-CRED-4);
      plaintext never in argv, record, or log (INV-CRED-2, INV-CRED-3).
- [ ] **Test (unit):** `DELETE` → `404` classifies as already-revoked; `DELETE` → `500` leaves the
      record open and the VM alive with a non-zero exit.
- [ ] **Test (200-for-dead-key):** provider double returns `200` from the single-key endpoint for a
      revoked hash → `verifyRevoked` still passes via the list; a `/key`-gated implementation
      passes this and MUST fail the stale-list case.
- [ ] **Test (pagination boundary):** truncated list page not containing the hash → `list-unverified`
      failure, never a false "revoked".
- [ ] **Test (secret hygiene):** recorded argv and every emitted log line are scanned for any ≥8-char
      substring of the secret → zero hits; remote file mode asserted `600` via `stat`.
- [ ] **Test (e2e demo — MANDATORY):** one scripted lifecycle against the provider double produces
      an **open** run record on disk — `keyHash`, `limitMicroUsd` and `spendMicroUsd` populated,
      `closedAt` unset, because closure is DF2.5 teardown's last step — and a key list from which
      the hash is absent; the record file is the artifact.

## Dev Agent Record

<!-- Empty placeholder — filled during development. -->
