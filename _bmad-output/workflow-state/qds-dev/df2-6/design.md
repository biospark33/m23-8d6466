# DF2.6 Design Contract — quota accounting + orphan reaper

Binding interface contract for tests (TDD) and implementation. Both build against THIS file.
Story: `_bmad-output/sprint-artifacts/dark-factory-v5/stories/df2-6-quota-accounting-reaper.md`
Research provenance: 6-track research 2026-08-20 (tracks A–F), file:line verified.

## 0. Resolved design decisions (from research)

- **D1 — VM ownership tag**: `ProviderVm` gains `tag?: string`. `SBX_OWNERSHIP_TAG = "qds-sbx"` exported from `src/providers/driver.ts`. `createRun` defaults `opts.tag ?? SBX_OWNERSHIP_TAG` so every factory-provisioned VM carries provenance (story: DF2.2's create() is the producer). `FakeDriver.list()` exposes `BoxMeta.tag`. exedev `list()` does NOT (verified `ls --json` shape `{vms:[{vm_name,https_url,ssh_dest?}]}` has no tag — 3-origin verified; shape-matching exedev VMs classify `foreign`, fail-safe per INV-1; comment in code).
- **D2 — key age**: `KeyEntry` gains `createdAt?: string` (ISO). Production `openRouterKeyApi` parses it only if the upstream list supplies a string field (absent ⇒ undefined ⇒ `key-age-unavailable`, fail-safe). `FakeKeyApi.createKey` stamps `new Date().toISOString()`; fixture gains a back-date helper.
- **D3 — closed-record leaked key**: teardown on a closed record skips ALL steps (teardown.ts:214-218). Sweep still routes `teardown(runId)` per AC1 table, then records a failed attempt `code: "teardown-skipped-closed-record"` with operator remediation (revoke manually via DF2.3 verb or reopen record). Feeds reap-blocked counter. NO reaper-owned revoke (DOD: only record-less keys reach `revokeAndVerify`).
- **D4 — no import cycle**: `quota.ts` imports nothing from `driver.ts`; it takes structural types (`{ list(name?): Promise<{ name: string }[]> }`). `driver.ts` imports `quota.ts` (`createRun` calls `checkHeadroom`).
- **D5 — liveVms counts ALL provider VMs** (foreign included — they burn the same account ceiling).
- **D6 — clock**: no fake timers (repo convention). Injectable `now?: () => Date`. Records back-dated via `store.create(id, date)` / `store.close(id, date)`.
- **D7 — default per-VM disk reservation**: 2 GiB (100 GiB pooled / 50 VMs). All defaults `[VERIFY]` vendor-single-origin (R5 §6 fact 11).

## 1. `src/providers/quota.ts` (new)

```ts
export interface QuotaLimits {
  maxVms: number;                    // default 50
  maxPooledDiskGiB: number;          // default 100
  perVmDiskReservationGiB: number;   // default 2
  maxTransferGiB: number;            // default 200 (recorded in header only)
  staleAfterMs: number;              // default 14_400_000 (4h)
}
export const DEFAULT_QUOTA_LIMITS: QuotaLimits;

export type QuotaLimitsSource = "default" | "file";
export interface LoadedQuotaLimits { limits: QuotaLimits; source: QuotaLimitsSource; file?: string }

// File: .sandbox/quota-limits.json (path overridable). Absent ⇒ defaults + source "default".
// Present ⇒ PARTIAL per-key override over defaults, source "file". Malformed JSON, unknown
// keys, or non-positive numbers ⇒ QuotaLimitsError { code, message, remediation } naming the
// exact JSON body to write (exedev posture pattern, exedev/driver.ts:269-285).
export function loadQuotaLimits(file?: string): LoadedQuotaLimits;

export interface HeadroomInput { list(name?: string): Promise<{ name: string }[]> } // structural
export interface HeadroomResult {
  allowed: boolean;
  liveVms: number;          // 0 + verified:false when list-unverified
  ceiling: number;          // maxVms
  headroom: number;         // ceiling - liveVms; 0 when unverified
  requested: number;
  usedDiskGiB: number;      // liveVms × perVmDiskReservationGiB
  diskEstimated: true;      // constant — estimate is never shown as measured
  verified: boolean;        // false iff the VM list could not be enumerated
  limitsSource: QuotaLimitsSource;
  reason?: "list-unverified" | "vm-ceiling" | "pooled-disk";
}
// Read, not a lock. driver.list() throw ⇒ { allowed: false, reason: "list-unverified",
// headroom: 0, verified: false } — never full headroom from an uncounted population.
// Refuses on EITHER ceiling: liveVms + n > maxVms ⇒ "vm-ceiling";
// (liveVms + n) × reservation > maxPooledDiskGiB ⇒ "pooled-disk". Boundary inclusive:
// liveVms + n === maxVms is allowed.
export async function checkHeadroom(
  driver: HeadroomInput, requested: number, limits?: LoadedQuotaLimits
): Promise<HeadroomResult>;

export class QuotaLimitsError extends Error {
  constructor(public code: "quota-limits-unreadable" | "quota-limits-invalid", message: string, public remediation: string);
}

// Used by createRun (driver.ts) — thrown when checkHeadroom(1).allowed === false.
export class HeadroomRefusedError extends Error {
  constructor(public result: HeadroomResult);  // code "headroom-refused", message includes reason
  readonly code = "headroom-refused";
}
```

## 2. `src/providers/driver.ts` (modify — impact analyzed: ProviderVm MEDIUM additive, create LOW)

- `ProviderVm` += `tag?: string` (document: optional provenance marker; absent on exedev `ls`).
- `export const SBX_OWNERSHIP_TAG = "qds-sbx";` (create-time provenance; charset-safe for `--tag`).
- `createRun`: FIRST call `checkHeadroom(driverLike, 1, loadQuotaLimits())` — throw `HeadroomRefusedError` BEFORE `store.create` (zero boxes, zero records). Then `store.create`; then `driver.create(opts.runId, opts.tag ?? SBX_OWNERSHIP_TAG)`.

## 3. `src/providers/credentials.ts` (modify — impact LOW)

- `KeyEntry` += `createdAt?: string` (ISO; provider-supplied when it exists — `[VERIFY]` upstream; absence is a first-class state, see `key-age-unavailable`).
- `openRouterKeyApi` list mapping: pass through a string creation field if present, else undefined. NO other behavior change.

## 4. `src/providers/fake-driver.ts` (modify)

- `list()` includes `tag` from `.box.json` BoxMeta when present.

## 5. `src/providers/reaper.ts` (new)

```ts
export type RowClass =
  | "paired" | "leaked-vm" | "leaked-key" | "stale-record"
  | "paired-pending" | "key-age-unavailable" | "foreign";
export type RowAction =
  | "report" | "teardown" | "destroy" | "revoke" | "skipped" | "reap-blocked";

export interface SweepRow {
  kind: "vm" | "key" | "record";
  id: string;               // vm name | key name | runId
  runId?: string;           // derived join key when factory-owned
  class: RowClass;
  action: RowAction;
  keyHashPrefix?: string;   // first 12 hex of key hash — NEVER the full hash at rest
  sharedActionRunId?: string; // set when the row's action is executed per-run, not per-item
  keyHashMismatch?: true;   // record.keyHash present and ≠ joined key's hash ⇒ never reaped
  failure?: { code: string; message: string; remediation: string };
}

export interface SweepReport {
  requestId: string;
  mode: "dry-run" | "apply";
  limitsSource: QuotaLimitsSource;
  ceilings: QuotaLimits;
  liveVms: number; liveKeys: number; records: number;
  timings: { list_vms_ms: number; list_keys_ms: number; read_records_ms: number; reap_ms: number };
  rows: SweepRow[];
  executed: { teardown: string[]; destroy: string[]; revoke: string[] }; // runIds | vm names | keyHashPrefixes
  failures: { runId?: string; code: string; message: string; remediation: string }[];
  nothingToReap: boolean;   // zero rows with action ∈ {teardown,destroy,revoke,reap-blocked}
  reportFile: string;       // .sandbox/reap/<ISO-with-dashes>.json (written BOTH modes)
}

export interface SweepDeps {
  driver: ProviderDriver; store: RunRecordStore; keyApi: KeyApi;
  limits?: LoadedQuotaLimits;       // default loadQuotaLimits()
  reapDir?: string;                 // default ".sandbox/reap"
  requestId?: string;
  now?: () => Date;                 // default () => new Date()
}
export interface SweepOptions { yes?: boolean }
export async function sweep(deps: SweepDeps, opts: SweepOptions = {}): Promise<SweepReport>;
```

### Classification (three-way join on derived runId; AC1 table, exact)

Join keys: key `sbx-<runId>` → strip prefix; VM name = runId; record filename stem = runId.
`keyHashPrefix = entry.hash.slice(0, 12)`.

Phase A — enumerate (ANY failure here throws; nothing deleted, INV-2/AC3/AC4):
1. `store.list()` — throws on malformed record ⇒ propagate (typed, names the file). Hard exit.
2. `driver.list()` (15s timeout) — throw ⇒ `SweepError code "list-unverified"`.
3. `keyApi.listAllKeys(20)` (15s) — throw OR `truncated === true` ⇒ `"list-unverified"`.

Phase B — classify per item:
- KEY: `!name.startsWith("sbx-")` ⇒ `foreign`/report.
  - runId = name minus prefix. record = records.get(runId).
  - record CLOSED ⇒ `leaked-key`, action `teardown` (per-run; D3 failure follows).
  - record OPEN: `now − createdAt < staleAfterMs` ⇒ `paired`; else ⇒ `stale-record`, action `teardown` (per-run).
  - NO record: `createdAt` undefined ⇒ `key-age-unavailable`/report (any mode, never revoked);
    age < staleAfterMs ⇒ `paired-pending`/report; age ≥ staleAfterMs ⇒ `leaked-key`, action `revoke` (per-item `revokeAndVerify(keyHash)`).
- VM: `!RUN_ID_SHAPE.test(name)` ⇒ `foreign`. Shape but `tag !== SBX_OWNERSHIP_TAG` ⇒ `foreign` (reported for manual remediation — never destroyed). Owned:
  - no record OR record closed ⇒ `leaked-vm`, action `destroy` (`driver.destroy(vm)`).
  - record open + young ⇒ `paired`; open + aged ⇒ `stale-record`, action `teardown` (per-run).
- RECORD row: open + young ⇒ `paired`; open + aged ⇒ `stale-record`/`teardown`; closed ⇒ no row.
- `RUN_ID_SHAPE = /^[a-z0-9][a-z0-9-]*-\d{8}-[0-9a-f]{6}$/` (exported for tests).
- keyHash confirmation: where `record.keyHash` is present and the joined key exists, hashes must
  match; mismatch ⇒ every row of that runId gets `keyHashMismatch: true`, action forced
  `report`, and the runId is reap-suppressed (two credentials claiming one run).

Phase C — act (apply mode only), per-run collapse:
- One `teardownSandbox(deps-like, runId)` per reap-suppressed-free runId having teardown action.
  Closed-record case: call it (story routing), then record failure `teardown-skipped-closed-record`.
- `driver.destroy(vm)` per leaked-vm. `revokeAndVerify(keyDeps, keyHash)` per record-less leaked-key
  (full hash in memory only). `sbx-` prefix re-asserted at selection AND inside revokeAndVerify
  (credentials.ts:429-435 — already enforced; do not reimplement).
- Per-item/per-run failures: catch, record `{code, message, remediation}`, continue other items.
- **Cap: at most 25 executed reap actions per sweep**; remaining candidate rows ⇒ action `skipped`, reported.
- **reap-blocked**: read prior sweep files from `reapDir` (apply-mode only), count consecutive
  failed reap attempts per runId; ≥ 3 ⇒ rows report action `reap-blocked` with the last failure,
  zero calls issued for that runId, item still counted in `liveVms`/`liveKeys`.
- Dry-run: identical rows/actions, zero calls. `executed` lists predictions.
- Write report file (mode included) to `.sandbox/reap/<timestamp>.json`, dir 0700, file 0600.
- Logging: header `{requestId, limitsSource, ceilings, liveVms, liveKeys, records}` then one line
  per row `{requestId, class, vm?, keyHashPrefix?, runId?, action, durationMs}` via swarmclaw log.
  Use `timedLoggedStep`/`stepBase` (step-log.ts) style; sub-timings in report.
- `SweepError { code: "list-unverified" | "record-unreadable" | "quota-limits-error", message, remediation }`.

## 6. `scripts/sandbox-reap.ts` (new — mirror sandbox-teardown.ts)

- `parseArgs(argv)` via `scripts/lib/cli-args.ts`; BOOL flag `--yes`; unknown flag ⇒ usage error.
- `run(argv, out): Promise<number>` — exit 0: dry-run (always), apply with zero failures, empty
  fleet ("nothing to reap"); exit 1: hard SweepError (malformed record AC3, list-unverified AC4,
  config error) OR any apply-mode action failure; usage ⇒ 2.
- Logs → stderr under `import.meta.main` guard; stdout via injected `out` (report summary lines).
- Driver default `$QDS_PROVIDER_DRIVER` ?? `"fake"`; `whoami` preflight before any deletion
  (infra prereq: failed preflight reaps nothing — exit 1).

## 7. `src/providers/index.ts`

`export * from "./quota.ts";` + `export * from "./reaper.ts";` with story comments (style :127-138).

## 8. Test fixtures — `tests/providers/fixtures/fleet-state.ts` (new)

Declarative seeder over FakeDriver + FakeKeyApi + RunRecordStore in a tmpdir:
```ts
interface FleetVm { name: string; tag?: string | null }   // tag:null ⇒ explicitly untagged
interface FleetKey { runId?: string; name?: string; hash?: string; createdAt?: string; usageUsd?: number; prefix?: string /* default "sbx-" */ }
interface FleetRecord { runId: string; vmName?: string; keyHash?: string; ageMs?: number; closed?: boolean }
seedFleet(baseDir: string, state: { vms?: FleetVm[]; keys?: FleetKey[]; records?: FleetRecord[] }): Promise<{
  driver: FakeDriver; keyApi: FakeKeyApi; store: RunRecordStore; boxesDir: string; keysDir: string; runsDir: string;
}>
```
- Records: `store.create(runId, new Date(now − ageMs))`, optional `set({vmName,keyHash})`, `close` when `closed`.
- Keys: `createKey(name ?? sbx-<runId>, usage)`; back-date via FakeKeyApi helper (`backdateKey(name, iso)` — added to fake-key-api.ts); custom `hash` supported (mismatch fixture).
- FakeKeyApi: `KeyEntry.createdAt` stamped at create; `listAllKeys` returns it; opts knob for `createdAt` suppression (key-age-unavailable fixture).

## 9. Test matrix (DOD ↔ tests)

`tests/providers/quota.test.ts` — AC2 boundary (48/50: n=2 allowed, n=3 refused exact fields);
createRun refusal (seeded to ceiling ⇒ zero boxes zero records + HeadroomRefusedError);
createRun default tag; list-unverified on list throw; AC5 empty ⇒ full headroom; pooled-disk
refusal; config file override + limitsSource; malformed/invalid config fail-closed.

`tests/providers/reaper.test.ts` — E2E slice (3 VMs/4 keys/2 records): dry-run deletes nothing +
classes exact; `--yes` ⇒ 1 teardown + 1 destroy + 1 revoke, A + operator key untouched,
checkHeadroom(2) allowed with liveVms 1; foreign controls (`steve-devbox`; shape-match-no-tag
survives `--yes`); AC6 paired + mint-window untouched; AC7 young record-less key ⇒ paired-pending
zero revokes, no-createdAt key ⇒ key-age-unavailable never revoked; AC3 malformed record ⇒ throw +
zero deletions; AC4 truncated key list + VM list throw ⇒ list-unverified + zero reap; AC5 empty;
reap-blocked 3-failures ⇒ 4th sweep zero teardown calls + still in liveVms; keyHash mismatch ⇒
never reaped; 25-cap (30 leaked-vm ⇒ 25 destroy + 5 skipped); three-rows-one-action (stale record
with VM+key live ⇒ exactly one teardown call); closed-record leaked key ⇒ teardown called +
failure recorded; dry-run action values === apply action values; e2e demo via
`run()` from scripts/sandbox-reap.ts (MANDATORY DOD): dry-run then `--yes`, report file exists,
final fleet state, checkHeadroom(2) allowed.

`tests/providers/fixtures/fleet-state.ts` — validated by the above (fixture itself exercised;
invalid seeds throw with clear messages, matching repo fixture conventions).
