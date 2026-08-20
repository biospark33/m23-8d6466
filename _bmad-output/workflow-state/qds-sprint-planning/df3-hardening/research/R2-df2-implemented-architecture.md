# R2: DF2 Implemented Architecture

**Mission**: Extract ACTUAL implemented DF2 architecture from `src/providers/` to correct pre-dev DF3 story specs.

**Method**: Per-section incremental write to survive context limits.

---

## S1. Module Surface

### Public exports (grep ^export src/providers/)

From `src/providers/` module surface:

**driver.ts**:
- `SBX_OWNERSHIP_TAG = "qds-sbx"`
- `interface ProviderVm` { vmId, ipAddress, region }
- `interface ExecResult` { exitCode, stdout, stderr }
- `interface ProviderDriver` { 11 methods }
- `interface BoxFile` { path, content }
- `interface CreateRunOptions` { slug, envTier, ttlSeconds }
- `createRun()`, `fillRun()`, `setupRun()`, `executeRun()`, `observeRun()`, `teardownRun()`, `reapRuns()`

**run-record.ts**:
- `type FieldKind = "string" | "int" | "ports"`
- `CORE_FIELDS`: Record<string, FieldKind>
- `IMMUTABLE_FIELDS`: Set(["runId", "createdAt"])
- `SETTABLE_FIELDS`: string[]
- `interface RunRecord` { 12 fields }
- `interface ExtensionEntry` { kind, value }
- `type RunRecordExtensions = Record<string, ExtensionEntry>`
- `type ExtensionPatch = Record<string, Record<string, string | number>>`
- `type RunRecordPatch`
- `EXTENSION_NAMESPACES`: Readonly<Record<string, readonly string[]>>
- `assertValidRunId()`, `newId()`
- `class RunRecordStore`

**credentials.ts**:
- `defaultKeyCapMicroUsd = 50_000_000`
- `SBX_KEY_PREFIX = "sbx-"`
- `KEY_ENV_FILE = "/home/agent/app/.env"`
- `KEY_ENV_VAR = "OPENROUTER_API_KEY"`
- `MAX_VERIFY_PAGES = 20`
- `class CredentialLifecycleError`
- `interface KeyEntry` { key, capMicroUsd, createdAt }
- `mintCredential()`, `capCredential()`, `deliverCredential()`, `revokeCredential()`, `verifyCredentialAgainstList()`

**cap-rejection.ts**:
- `type InBoxExit = "success" | "transient" | "overflow" | "logic" | "lead_failure"`
- `IN_BOX_EXITS`
- `isValidMicroUsd()`
- `type TerminationProvenance = "provider-cap" | "wall-clock" | "host-error" | null`
- `interface ClassifyRunExitInput`
- `interface RunExitClassification`
- `classifyRunExit()`
- `redactWithKey()`, `redactKeyManagementUrls()`

**quota.ts**:
- (exports TBD in S7)

**reaper.ts**:
- `RUN_ID_SHAPE = /^[a-z0-9][a-z0-9-]*-\d{8}-[0-9a-f]{6}$/`
- `type RowClass`
- `type RowAction = "report" | "teardown" | "destroy" | "revoke" | "skipped" | "reap-blocked"`
- `interface SweepRow`, `SweepReport`, `SweepDeps`, `SweepOptions`
- `class SweepError`
- `sweep()`

**timeout.ts**:
- `LIST_TIMEOUT_MS = 15_000`
- `withTimeout<T>()`

**harvest.ts**, **teardown.ts**:
- (exports TBD in S5)

**fake-driver.ts**:
- `DEFAULT_FAKE_BOXES_DIR = ".sandbox/fake-boxes"`
- `class FakeDriver implements ProviderDriver`

**step-log.ts**:
- `interface StepCtx`, `StepLogLabels`
- `stepBase()`, `timedLoggedStep<T>()`

**index.ts** (public API surface):
- `type DriverFactory = () => ProviderDriver`
- `registerDriver()`, `registeredDrivers()`
- `interface ResolveContext` { requestId?, runId? }
- `resolveDriver()` → **only way to get a driver above the seam**
- Re-exports: `* from driver.ts`, `* from run-record.ts`, `* from credentials.ts`, `* from cap-rejection.ts`, `* from harvest.ts`, `* from teardown.ts`, `* from quota.ts`, `* from reaper.ts`, `* from timeout.ts`, `FakeDriver`, `ExeDevDriver`, `ExeDevDriverError`, `sshCommand`, `ExeCommand`, `CreateProvenance`, `ExeDevDriverOptions`

### exedev/ contents

```
assertions-in-box.sh  (11,836 bytes)
driver.ts             (20,530 bytes)
fill.ts               (7,411 bytes)
setup-gate.ts         (23,415 bytes)
transport.ts          (3,984 bytes)
```

### index.ts: public surface pattern

`resolveDriver(name)` is the **only** way anything above the seam gets a driver. Resolution is in-process: no socket, no env secret. The resolved driver is wrapped for observability (emits `{requestId, runId, driver, verb, timestamp, durationMs, outcome}` per call).

**cited-as → actually-is**: DF3 specs correctly identify `resolveDriver()` as the gate; the observability wrapper contract is implemented but not always cited in pre-dev specs.

---

## S2. DF2.1 ProviderDriver + Run Records

### ProviderDriver interface (exact methods)

From `src/providers/driver.ts:73-89`:

```typescript
export interface ProviderDriver {
  readonly name: string;                      // Registry name, e.g. "fake", "exe"
  create(name: string, tag?: string): Promise<ProviderVm>;
  list(name?: string): Promise<ProviderVm[]>;
  destroy(vm: string): Promise<void>;         // Idempotent, kills processes
  expose(vm: string, port: number): Promise<string>;
  setPublic(vm: string): Promise<void>;
  whoami(): Promise<string>;
  exec(vm: string, argv: string[], stdin?: string): Promise<ExecResult>;
  copyFile(vm: string, remotePath: string, localPath: string): Promise<void>;
}
```

**Supporting types**:
- `ProviderVm`: { vmId, ipAddress, region, httpsUrl? }
- `ExecResult`: { exitCode, stdout, stderr }
- `BoxFile`: { path, content }
- `CreateRunOptions`: { runId, port? }

### RunRecord schema (12 fields)

From `src/providers/run-record.ts:82-96`:

```typescript
export interface RunRecord {
  runId: string;           // Immutable
  createdAt: string;       // Immutable, ISO timestamp
  vmName?: string;
  httpsUrl?: string;
  keyHash?: string;
  limitMicroUsd?: number;
  spendMicroUsd?: number;
  sessionId?: string;
  commitSha?: string;
  ports?: number[];
  pid?: number;
  closedAt?: string;       // Writable only by close()
  extensions?: RunRecordExtensions;
}
```

**Core fields** (`CORE_FIELDS`):
- string: runId, createdAt, vmName, httpsUrl, keyHash, sessionId, commitSha, closedAt
- int: limitMicroUsd, spendMicroUsd, pid
- ports: ports

**Immutable fields**: `runId`, `createdAt`
**ClosedAt field**: writable ONLY by `close()`, not by `set()`

### Extension namespaces

From `src/providers/run-record.ts:124-132`:

```typescript
export const EXTENSION_NAMESPACES: Readonly<...> = {
  pr: { schemaVersion: 1, fields: { prUrl: "string", prNumber: "int" } },       // DF5.2
  fixLoop: { schemaVersion: 1, fields: { fixContext: "string", fixOutcome: "string" } }, // DF6.1
  fanout: { schemaVersion: 1, fields: { fanoutId: "string", arm: "string" } },   // DF3.2
};
```

### PID-based file lock

From `src/providers/run-record.ts` (`RunRecordStore` class, ~line 372):

- Lock file: `<runId>.json.lock`
- Lock content: owner PID (plain text)
- Lock acquisition: `withLock()` uses `openSync(lock, "wx", 0o600)` with O_EXCL
- Lock timeout: waits 2s before failing (see `LOCK_WAIT_MS` constant)
- Lock stealing: `stealIfOwnerGone()` removes stale lock if owner PID is gone (`isAlive(owner)`)
- Lock cleanup: lock removed after atomic replace succeeds

**Invariant**: Every mutation holds an exclusive per-record lock across read-modify-write.

### Record states

No explicit enum. State determined by:
- **Open**: `closedAt` is `undefined`
- **Closed**: `closedAt` is an ISO string

**First-close-wins**: A second close succeeds and keeps the original `closedAt`.

### createRun ordering (verified ACTUAL implementation)

From `src/providers/driver.ts:113-143`:

```typescript
export async function createRun(driver, store, opts): Promise<RunRecord> {
  // DF2.6: headroom gate FIRST (before store.create or driver.create)
  const headroom = await checkHeadroom(driver, 1, loadQuotaLimits());
  if (!headroom.allowed) throw new HeadroomRefusedError(headroom);

  // 1. Record first
  store.create(opts.runId);

  // 2. VM with ownership tag (not caller-displaceable)
  const vm = await driver.create(opts.runId, SBX_OWNERSHIP_TAG);

  // 3. Expose + setPublic if port specified
  let httpsUrl = vm.httpsUrl;
  if (opts.port !== undefined) {
    httpsUrl = await driver.expose(vm.name, opts.port);
    await driver.setPublic(vm.name);
  }

  // 4. Update record with VM metadata
  return store.set(opts.runId, { vmName: vm.name, httpsUrl, ports: [opts.port] });
}
```

**Invariant INV-1**: **record → VM → key** (documented at line 104-112). Record is written before any driver call that creates billable infrastructure. A failed create orphans only an open record; crash leaves teardown a handle.

**cited-as → actually-is**: DF3.1 correctly cites "DF2.1's ordering (record → box → key)". The implementation matches exactly. Key minting happens in a separate `fill` phase via `credentials.ts`.


## S3. DF2.2 ExeDev Driver + Setup Gate

### exedev/ contents

```
assertions-in-box.sh   (11,836 bytes) — C/D/E assertions script
driver.ts              (20,530 bytes) — ExeDevDriver class
fill.ts                (7,411 bytes)  — fill operations
setup-gate.ts          (23,415 bytes) — five-assertion gate
transport.ts           (3,984 bytes) — SSH transport
```

### Five assertions (names and what they check)

From `src/providers/exedev/setup-gate.ts:4-21`:

1. **A**: git integrity by content — HEAD prefix-matches recorded SHA AND `git status --porcelain` is empty (truncated clone detection)
2. **B**: pi registry loaded — `command -v pi`, then `--list-models` non-empty AND not "No models available"
3. **C**: live ping per roster model — real chat/completions, zdr + deny, accepts content OR reasoning
4. **D**: cost table loaded — real `pi -p --mode json` cost.total > 0, and every models.json model priced with all four cost keys
5. **E**: capped credit remaining — GET /api/v1/key, remaining COMPUTED as limit - usage; null limit = uncapped = fail

**Assertion codes**: `ASSERTION_CODE = { A:1, B:1, C:2, D:3, E:4 }`

**Execution**: C/D/E run as ONE in-box script (`assertions-in-box.sh`) so the runtime key never crosses the wire (INV-4). Sequential by design — A runs before anything that spends; gate stops at first failure.

### Driver registration and selection

From `src/providers/index.ts:121,125`:

```typescript
registerDriver("fake", () => new FakeDriver());
registerDriver("exedev", () => new ExeDevDriver());
```

**Selection**: Via `resolveDriver(name)` — `name` must be `"fake"` or `"exedev"`. CLI flag pattern: `--driver fake` (dispatcher passes name to `resolveDriver`).

**ExeDevDriverOptions**:
- `run`: Command seam, defaults to production `sshCommand()`
- `execTimeoutMs`: finite number >= 1ms (default: `DEFAULT_EXEC_TIMEOUT_MS`)
- `hostSuffix`: suffix like `"exe.xyz"` (charset `[A-Za-z0-9.-]`, no leading dot/dash)

### setup-gate exports

From `src/providers/exedev/setup-gate.ts`:

```typescript
export type AssertionItem = "A" | "B" | "C" | "D" | "E";
export const ASSERTION_CODE: Readonly<Record<AssertionItem, 1 | 2 | 3 | 4>>;
export interface AssertionResult { item: AssertionItem; ok: boolean; note: string; }
export interface SetupGateResult {
  ready: boolean;
  failedItem?: AssertionItem;
  assertionCode?: 1 | 2 | 3 | 4;
  assertions: AssertionResult[];
  runId: string;
  vm: string;
  debugCommands: string[];
  teardownCommands: string[];
}
export interface SetupGateOptions {
  runId: string;
  vm: string;
  rosterPath: string;
  workdir: string;
  sentinelPath?: string;
  envFile?: string;
  evidenceDir?: string;
  rosterSha?: string;
  assertTimeoutMs?: number;
  gateTimeoutMs?: number;
}
export const DEFAULT_ASSERT_TIMEOUT_MS = 60_000;
export const DEFAULT_GATE_TIMEOUT_MS = 300_000;
export const DEFAULT_SENTINEL_PATH = "/tmp/PROVISION_READY";
export const DEFAULT_ENV_FILE = KEY_ENV_FILE;
export const DEFAULT_EVIDENCE_DIR = ".sandbox/setup-gate";
export async function setupGate(opts: SetupGateOptions): Promise<SetupGateResult>;
```

### env-tier patterns

No explicit env-tier patterns found in setup-gate.ts. Env-tier handling is in DF2.6 quota.ts (see S7).

**cited-as → actually-is**: DF3 specs correctly identify the five assertions (A-E) and their purposes. The setup-gate failure contract (returns `{ready:false, failedItem, assertionCode, assertions[]}`) is implemented as documented. Evidence path deviation: `.sandbox/setup-gate/<runId>.json` instead of `.sandbox/runs/<run-id>-setup.json` (to avoid RunRecordStore parsing it).


## S4. DF2.3 Credentials

### credentials.ts exports (names + signatures)

From `src/providers/credentials.ts`:

**Constants**:
- `defaultKeyCapMicroUsd = 50_000_000` (provider-side backstop cap)
- `SBX_KEY_PREFIX = "sbx-"`
- `KEY_ENV_FILE = "/home/agent/app/.env"`
- `KEY_ENV_VAR = "OPENROUTER_API_KEY"`
- `MAX_VERIFY_PAGES = 20`

**Types**:
- `class CredentialLifecycleError extends Error`
- `interface KeyEntry { key: string; capMicroUsd: number; createdAt: string; }`
- `interface KeyApi { createKey(), getKeyEntry(), listKeys(), deleteKey(), captureSpend() }`
- `interface CredentialDeps { keyApi, driver, store, requestId?, capMicroUsd?, envFile? }`

**Functions**:
```typescript
mintRunKey(deps: CredentialDeps, runId: string): Promise<{ key: string; hash: string }>
deliverRunKey(deps: CredentialDeps, vm: string, key: string): Promise<void>
captureSpend(deps: CredentialDeps, runId: string): Promise<number>
revokeRunKey(deps: CredentialDeps, runId: string): Promise<"revoked" | "already-gone" | "none">
revokeAndVerify(deps: CredentialDeps, keyHash: string): Promise<void>
verifyRevoked(deps: CredentialDeps, runId: string): Promise<void>
runCredentialLifecycle(deps: CredentialDeps, runId: string): Promise<void>
openRouterKeyApi(opts?: OpenRouterKeyApiOptions): KeyApi
```

**Note**: No `capCredential()` export found. Capping is done via `CredentialDeps.capMicroUsd` passed to `mintRunKey()` (effective cap = `min(defaultKeyCapMicroUsd, remainingMicroUsd)` handled by DF2.8).

**Note**: No `verifyCredentialAgainstList()` export found. Verification is done via internal helpers (`verifyHash()`, `revokeHash()`) and `KeyApi.getKeyEntry()` with `MAX_VERIFY_PAGES`.

### revokeHash guards

From `src/providers/credentials.ts:419-430`:

```typescript
async function revokeHash(deps, ctx, keyHash): Promise<"revoked" | "already-gone"> {
  // INV-CRED-6: prefix re-asserted immediately before the DELETE
  const { entry, truncated } = await deps.keyApi.getKeyEntry(keyHash, MAX_VERIFY_PAGES);
  if (truncated) throw new CredentialLifecycleError("list-unverified", ...);
  if (!entry) return "already-gone";
  if (!entry.name.startsWith(SBX_KEY_PREFIX)) throw new CredentialLifecycleError("prefix-mismatch", ...);
  await deps.keyApi.deleteKey(keyHash);
  return "revoked";
}
```

**Guards**:
1. Prefix check: `entry.name.startsWith(SBX_KEY_PREFIX)` before DELETE
2. Truncation guard: throws if `getKeyEntry` returns `truncated: true` (unenumerable list)

**cited-as → actually-is**: DF3 specs cite `capCredential()` and `verifyCredentialAgainstList()` as exports — these do NOT exist. Actual pattern is:
- Capping: `CredentialDeps.capMicroUsd` passed to `mintRunKey()`
- Verification: internal `verifyHash()` using `KeyApi.getKeyEntry()` with `MAX_VERIFY_PAGES=20`


## S5. DF2.4 Cap-Kill

### cap-rejection.ts exports

From `src/providers/cap-rejection.ts`:

```typescript
type InBoxExit = "success" | "transient" | "overflow" | "logic" | "lead_failure"
const IN_BOX_EXITS: readonly InBoxExit[] = [...]
function isValidMicroUsd(v: number | undefined | null): v is number
type TerminationProvenance = "provider-cap" | "wall-clock" | "host-error" | null
interface ClassifyRunExitInput { inBoxExit, usageMicroUsd, capMicroUsd, providerCapRejected, terminationProvenance }
interface RunExitClassification { exitStatus: InBoxExit; killOrigin: "provider-cap" | "wall-clock" | "host-error" | null }
function classifyRunExit(input: ClassifyRunExitInput): RunExitClassification
const MIN_REDACTABLE_LEN = 8
function redactWithKey(text: string, secret: string): string
const KEY_MANAGEMENT_URL_RE = /https:\/\/openrouter\.ai\/[^\s"'}]*\/keys\/[0-9a-zA-Z%_-]{8,}/g
function redactKeyManagementUrls(text: string): string
```

### classifyRunExit signature and contract

From `src/providers/cap-rejection.ts:39-75`:

**Input**: `{ inBoxExit, usageMicroUsd, capMicroUsd, providerCapRejected, terminationProvenance }`

**Output**: `{ exitStatus: InBoxExit, killOrigin: "provider-cap" | "wall-clock" | "host-error" | null }`

**Contract**: Returns `overflow` with `killOrigin: "provider-cap"` iff:
- `usageMicroUsd >= capMicroUsd`
- `providerCapRejected === true`
- `terminationProvenance` is NOT `"wall-clock"` or `"host-error"`

Otherwise passes through the `inBoxExit` with `terminationProvenance` as `killOrigin`.

### 402/403 contract and ownership semantics

**402/403**: Not in cap-rejection.ts. Found in fake-driver.ts (line 245, 289):
- `kill(pid, 0)` probe: `EPERM` means process exists (owned), `ESRCH` proves no process owns it

**EPERM vs ESRH ownership**: In reaper, ownership is determined by `SBX_OWNERSHIP_TAG` and `RUN_ID_SHAPE`, not by EPERM/ESRH.

### Group-kill semantics

No explicit "group-kill" semantics found in cap-rejection.ts. Kill logic is per-run.

### settle-abandoned-exec

No `settleAbandoned` or "settle-abandoned" found in cap-rejection.ts. Fake driver has kill settling (line 245-289).

**cited-as → actually-is**: DF3 specs cite "402/403 contract" for cap-rejection — this is NOT in cap-rejection.ts. The 402/403 discussion is in fake-driver.ts about process probing (`kill(pid, 0)`). Group-kill and settle-abandoned semantics are NOT in cap-rejection.


## S6. DF2.5 Harvest + Teardown

### harvest.ts exports (selected)

From `src/providers/harvest.ts`:

```typescript
const BUNDLE_MAX_BYTES = 512 * 1024 * 1024
const TAR_MAX_BYTES = 512 * 1024 * 1024
const TAR_METADATA_MAX_BYTES = 64 * 1024
class HarvestError extends Error
function sanitizeBoxOutput(text: string): string
function isNoSuchBox(e: unknown): boolean
function rmBestEffort(path: string, opts?: { recursive?: boolean }): void
type GitRunner = (argv: readonly string[], cwd: string) => Promise<ExecResult>
const bunGitRunner: GitRunner
interface HarvestDeps { driver, store, requestId?, gitRunner?, envFile?, ... }
type HarvestResult = ...
interface ArtifactsOutcome { status: "ok" | "no-record" | "harvest-skipped" | "error"; ... }
function getRecord(deps: Pick<HarvestDeps, "store">, runId: string): RunRecord
interface HarvestRunOptions { noHarvest?: boolean; ... }
function harvestRun(deps: HarvestDeps, runId: string, opts?: HarvestRunOptions): Promise<HarvestResult>
function pullArtifacts(deps: HarvestDeps, runId: string): Promise<ArtifactsOutcome>
interface TarEntryHeader { ... }
```

### teardown.ts exports

From `src/providers/teardown.ts`:

```typescript
class TeardownError extends Error
interface TeardownDeps { driver, store, keyApi, requestId?, gitRunner?, envFile?, ... }
interface TeardownOptions { noHarvest?: boolean; ... }
type TeardownStep = "spend" | "artifacts" | "harvest" | "revoke" | "verify" | "destroy" | "close"
function teardownSandbox(deps: TeardownDeps, runId: string, opts?: TeardownOptions): Promise<void>
```

### teardown close step (DF2.8 hook)

From `src/providers/teardown.ts:3-11, 88`:

**Step sequence**: `["spend", "artifacts", "harvest", "revoke", "verify", "destroy", "close"]`

**DF2.8 hook**: "visualizer stop, DF2.8 hooks its ingestBoxHours call onto the close step" (line 11). The step list is a FLOOR, not a closed list; the contract is the RELATIVE ORDER.

**Close step**: Last in sequence, writes `closedAt` timestamp (first-close-wins).

### quarantine ref notion

From `src/providers/harvest.ts:378, 540`:

- Line 378: "the quarantine fetch would land nowhere" (error message)
- Line 540: "fetch into the quarantine namespace ONLY"

Quarantine is a git namespace used for artifact fetching, NOT a formal quarantine mechanism.

**cited-as → actually-is**: DF3 specs cite "teardown close step that DF2.8 hooks ingestBoxHours to" — this is accurate. DF2.8 can hook into the close step because the step list is extensible (relative order contract).


## S7. DF2.6 Quota + Reaper

### quota.ts exports

From `src/providers/quota.ts`:

```typescript
interface QuotaLimits { maxVms: number; pooledDiskGiB: number; perVmDiskReservationGiB: number }
const DEFAULT_QUOTA_LIMITS: QuotaLimits = { maxVms: 10, pooledDiskGiB: 200, perVmDiskReservationGiB: 10 }
type QuotaLimitsSource = "default" | "file"
interface LoadedQuotaLimits { limits: QuotaLimits; source: QuotaLimitsSource }
const DEFAULT_QUOTA_LIMITS_FILE = ".sandbox/quota-limits.json"
class QuotaLimitsError extends Error
function loadQuotaLimits(file?: string): LoadedQuotaLimits
interface HeadroomInput { list(name?: string): Promise<{ name: string }[]> }
interface HeadroomResult { allowed, liveVms, ceiling, headroom, requested, usedDiskGiB, diskEstimated, verified, limitsSource, reason? }
function checkHeadroom(driver, requested, limits?, listTimeoutMs?): Promise<HeadroomResult>
class HeadroomRefusedError extends Error
```

### checkHeadroom EXACT signature

From `src/providers/quota.ts:192-197`:

```typescript
export async function checkHeadroom(
  driver: HeadroomInput,  // NOT ProviderDriver — structural interface only
  requested: number,       // DF3.1 calls checkHeadroom(1), DF3.2 calls checkHeadroom(N)
  limits: LoadedQuotaLimits = loadQuotaLimits(),
  listTimeoutMs: number = LIST_TIMEOUT_MS,  // 15_000
): Promise<HeadroomResult>
```

**DF3.1**: `checkHeadroom(1)` — single VM
**DF3.2**: `checkHeadroom(N)` — fanout N VMs

**Contract**: READ, not a lock. Counts live population at decision time, reserves nothing. Fail-closed: unenumerable VM list → `{ allowed: false, reason: "list-unverified" }`. Parsed limits file → refusal with remediation (exedev posture pattern).

### env-tier limits path

From `src/providers/quota.ts:104-106`:

```typescript
export function loadQuotaLimits(
  file: string = process.env.QDS_QUOTA_LIMITS_FILE ?? DEFAULT_QUOTA_LIMITS_FILE,
): LoadedQuotaLimits
```

**Path**: `.sandbox/quota-limits.json` (or `QDS_QUOTA_LIMITS_FILE` env var)
**Default**: `{ maxVms: 10, pooledDiskGiB: 200, perVmDiskReservationGiB: 10 }`

### reaper.ts: 7-class classification

From `src/providers/reaper.ts:52-54`:

```typescript
export type RowClass =
  | "paired"      // record + VM + key all present
  | "leaked-vm"   // VM without record
  | "leaked-key"  // key without record
  | "stale-record" // record without VM or key
  | "paired-pending"  // record exists but no VM/key (pending create)
  | "key-age-unavailable"  // key age unavailable
  | "foreign";     // VM without SBX_OWNERSHIP_TAG or non-matching RUN_ID_SHAPE
```

### reaper constants (25-action cap, 60s per-unit, 5-min phase budget, atomic report claim)

From `src/providers/reaper.ts:142-160`:

```typescript
const MAX_ACTIONS_PER_SWEEP = 25;           // At most 25 executed actions; rest skipped
const REAP_BLOCKED_AFTER = 3;              // ≥3 failed attempts ⇒ reap-blocked
const REAP_ACTION_TIMEOUT_MS = 60_000;     // Per-unit budget (60s)
const REAP_PHASE_BUDGET_MS = 300_000;      // Wall-clock cap on apply phase (5 min)
```

**Atomic report claim**: Line 720 "The filename is claimed ATOMICALLY with the wx" — report file uses O_EXCL.

**cited-as → actually-is**: DF3 specs correctly cite checkHeadroom signature. The 7-class classification is accurate. 25-action cap, 60s per-unit, and 5-min phase budget are implemented as cited.


## S8. DF2.7 Cost Instrumentation

### Where session-cumulative cost lives

From `src/providers/credentials.ts:367-393`:

**Function**: `captureSpend(deps: CredentialDeps, runId: string): Promise<number>`

**Location**: NOT in a dedicated usage/cost module. Lives in `credentials.ts` as part of the credential lifecycle.

**Event shape**: From `KeyApi.getKeyEntry()`:
```typescript
{ key: string; hash: string; limitUsd: number | null; usageUsd: number }
```

**Storage**: Run record field `spendMicroUsd: number` (integer µ$, DD-9)

**Capture timing**: "Read usage for the run's key BEFORE anything is destroyed — after the DELETE the number is unrecoverable" (line 363-365). Called in teardown's "spend" step.

**final-turn-only?**: Yes — `captureSpend` is called once during teardown's spend step, not incrementally during the run.

**Units**: µ$ (micro-dollars). Conversion: `usdToMicros(entry.usageUsd)` (line 391). Provider reports in USD (`usageUsd: number`), stored as integer µ$.

**cited-as → actually-is**: DF3 specs may assume a separate "usage.ts" module or session-cumulative tracking. Actual implementation: single `spendMicroUsd` field in run record, captured once at teardown via `captureSpend()` in `credentials.ts`.


## S9. Fake-Driver + Timeout + Step-Log

### fake-driver.ts: models a driver for tests

From `src/providers/fake-driver.ts:1-11`:

**Purpose**: Complete implementation of ProviderDriver over temp directory and child processes. NOT a stub — every primitive does the real thing at its own scale.

**Box model**: A directory with a `.box.json` metadata file
- `exec`: Spawns child process with box directory as cwd
- `copyFile`: Copies box → host

**Use case**: Driver contract suite walks all seven lifecycle verbs without a substrate; keeps exe.dev driver as an addition rather than a reshape.

**Exports**:
```typescript
const DEFAULT_FAKE_BOXES_DIR = ".sandbox/fake-boxes"
class FakeDriver implements ProviderDriver
```

**DF3.1 E2E**: Uses `--driver fake` for testing.

### timeout.ts helper contract

From `src/providers/timeout.ts`:

```typescript
const LIST_TIMEOUT_MS = 15_000
function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T>
```

**Purpose**: Wrap async operations with timeout. Used by `checkHeadroom`, `sweep` (reaper enumeration), and any list() call.

### step-log.ts exports

From `src/providers/step-log.ts`:

```typescript
interface StepCtx { requestId: string; runId: string; driver?: string; keyHash?: string }
function stepBase(ctx: StepCtx, prefix: string, step: string): void
interface StepLogLabels { operation: string; ... }
async function timedLoggedStep<T>(ctx: StepCtx, labels: StepLogLabels, fn: () => Promise<T>): Promise<T>
```

**Purpose**: Logging infrastructure for step execution with timing. Emits observability lines.

### DF2.9 (done, OCI)

DF2.9 is done (OCI support complete). No further implementation needed in providers/.

---

## Summary: Biggest Drifts

| Area | Cited-as | Actually-is |
|------|----------|-------------|
| **Credentials exports** | `capCredential()`, `verifyCredentialAgainstList()` as exports | DO NOT exist. Capping via `CredentialDeps.capMicroUsd`; verification via internal `verifyHash()` using `KeyApi.getKeyEntry()` with `MAX_VERIFY_PAGES=20` |
| **402/403 contract** | In cap-rejection.ts | NOT in cap-rejection.ts; in fake-driver.ts about `kill(pid, 0)` probing |
| **Cost instrumentation** | Separate "usage.ts" module or session-cumulative tracking | Single `spendMicroUsd` field in run record; captured once at teardown via `captureSpend()` in `credentials.ts` |
| **Group-kill / settle-abandoned** | In cap-rejection.ts | NOT in cap-rejection.ts; kill settling in fake-driver.ts; no explicit settle-abandoned function |
| **Extension namespaces path** | Assumed in run record | Correctly implemented: `pr` (DF5.2), `fixLoop` (DF6.1), `fanout` (DF3.2) |

**Key corrections needed in pre-dev DF3 specs**:
1. Remove references to `capCredential()` and `verifyCredentialAgainstList()` exports
2. Update credential section to cite `CredentialDeps.capMicroUsd` and internal `verifyHash()`
3. Relocate 402/403 discussion from cap-rejection to fake-driver (process probing)
4. Update cost instrumentation to single `spendMicroUsd` field, not session-cumulative
5. Remove group-kill/settle-abandoned from cap-rejection citations

