# fx5 — provisioning script cluster (F-014, F-016, F-017, F-020, F-027)

Branch: feature/m3-1-manager-meta-banks-l3-consolidate
Owned files touched: `scripts/provision-hindsight-banks.ts`, `tests/hindsight/meta-bank-provisioning.test.ts`

## Verdicts

### F-017 — fault-tolerant create-op poll — FIXED
`waitForCreateOperation` now wraps its `client.listOperations` call in try/catch (scripts/provision-hindsight-banks.ts:827-844): a transient fault emits a best-effort `manager-mental-model-poll-fault` log line (bankId, operationId, detail — no token material) and the loop CONTINUES polling to the deadline; deadline exhaustion still throws the existing typed `mental_model_create_timeout`. Mirrors the nightly evidence poll (`src/hindsight/nightly-consolidate.ts:358-368`: "a faulting read is retried until the budget — fail-loud lives in the deadline").

### F-027 — guarded emit — FIXED
`ensureManagerMentalModels` wraps the caller-provided `opts.log` sink in a try/catch (`const emit = (entry) => { try { log(entry) } catch {} }`, scripts/provision-hindsight-banks.ts:899-908). A throwing sink can no longer surface as a spurious `mental_model_provision_failed`. The same guarded `emit` is passed into `waitForCreateOperation`, so F-017's fault logging inherits the guard.

### F-020 — provision-window ceiling comments — FIXED (comment-only)
Named the deliberate ceiling at BOTH `withManagerMentalModels` call sites:
- Settled lane (scripts/provision-hindsight-banks.ts:1095-1100)
- Shared-fresh lane (scripts/provision-hindsight-banks.ts:1113-1120)

Both state: the MM leg holds the single-flight provision window by design (serial creates, pollTimeoutMs default 120s each); releasing earlier would race create-if-absent between concurrent runs; the window is bounded by pollTimeoutMs and the stale-lock backstop (LEG_LOCK_STALE_MS / heartbeat machinery); operators tuning throughput lower pollTimeoutMs. No behavior change.

### F-014 — export + direct wrapper tests — FIXED
`withManagerMentalModels` is now `export`ed (scripts/provision-hindsight-banks.ts:987), name/shape unchanged. Three direct tests added (`tests/hindsight/meta-bank-provisioning.test.ts`, describe "withManagerMentalModels (M3.1 envelope fold, F-014)"):
- (a) success fold: ok envelope gains `mentalModels` with 3 `created` rows and the right bank ids; fake records 3 creates.
- (b) failure fold: the existing failing fake (store ignores PATCHes → drift throw) converts to `{ok:false, banks:[], error:{code:"mental_model_provision_failed", message contains "remediation"}}`, `mentalModels` absent.
- (c) passthrough: a non-ok envelope AND an empty-banks envelope each return the SAME object (identity) with zero client calls — asserted via a counting spy over all four `ManagerModelClient` methods.

### F-016 — sequence fake off-by-one + tautology — FIXED
- Fake fixed to read-then-increment: `statusForPoll()` reads `pollStatuses.length` BEFORE the poll is recorded, so `createOpStatusSequence[0]` is served on the first poll (tests/hindsight/meta-bank-provisioning.test.ts:64-73, 105-110). The fake now returns `pollStatuses` (one entry per `listOperations` call, in order).
- The `expect(opIds).toBeDefined()` tautology is gone. The test now asserts: `pollStatuses.length >= 2`, `pollStatuses[0] === "processing"` (first poll saw processing), and `pollStatuses` contains `"completed"` — the comment's "two polls minimum: one that saw processing, one that saw completed" is now actually asserted.
- Test title re-checked: "create op polled through processing → completed (not a single-shot read)" still tells the truth — unchanged.

## Behavior-change flags
1. **Exported wrapper**: `withManagerMentalModels` is now exported (additive; name/shape unchanged).
2. **Fault-tolerant poll**: `waitForCreateOperation` no longer aborts the leg on a transient `listOperations` fault — it now logs and retries to the poll deadline (only a persistent fault reaches the typed timeout). Terminal-state handling (completed / failed / cancelled) is unchanged.

## Checks
- `bun test tests/hindsight/meta-bank-provisioning.test.ts` → **13 pass, 0 fail** (66 expect calls, 89ms) — 9 pre-existing + 3 new F-014 tests + hardened F-016 test.
- `bunx tsc --noEmit` → exit 0, no errors.
- `bunx @biomejs/biome check scripts/provision-hindsight-banks.ts tests/hindsight/meta-bank-provisioning.test.ts` → exit 0, "No fixes applied".

Scope discipline: no other files touched; no commit made; no full suite run (per instruction).

fx5 done
