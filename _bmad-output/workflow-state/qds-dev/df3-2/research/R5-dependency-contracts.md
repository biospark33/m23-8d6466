# R5 — Dependency Contracts (DF3.2 Fanout Best-of-N)

Verified against actual `main` working tree, 2026-08-23. Every signature below was read from source, not from story text.

Verdict legend: READY = contract exists exactly as the story assumes; GAP = story assumption differs from merged reality (severity ranked in the summary).

---

## 1. DF1.1 Engine journal / terminal marker — READY (one naming nit)

**File:** `/Users/steve/QDS-Factory/src/phase-engine/journal.ts`

- Marker root is a FUNCTION, not a constant — `runMarkerRoot(): string` at journal.ts:38-40:
  ```ts
  export function runMarkerRoot(): string {
    return process.env.QDS_RUN_ROOT ?? "/run";
  }
  ```
  Read at call time, "never frozen into a module constant" (comment journal.ts:36). There is **no exported identifier named `RUN_MARKER_ROOT`** anywhere in src/ (grep confirms; only `QDS_RUN_ROOT` env reads exist: journal.ts:39, trace/tracer.ts:292, phases/dispatch-task.ts:166,238).
- Marker path — `runMarkerPath(): string` at journal.ts:43-45 → `path.join(runMarkerRoot(), "journal", "final.json")`. Docstring: "The fixed in-box completion signal DF3.2's host-side poller keys on (AC7)."
- Exact marker JSON shape — `writeTerminalMarker(runId: string, outcome: RunOutcome): void` at journal.ts:171-194 writes exactly:
  ```json
  { "runId": "<string>", "ok": <boolean>, "completedAt": "<ISO or undefined>" }
  ```
  (journal.ts:187). Written via `${target}.tmp` + `renameSync`, fd opened `O_WRONLY|O_CREAT|O_EXCL|O_NOFOLLOW`, mode 0600, fsync before close (journal.ts:177-193).
- **When it fires:** on EVERY settled run, accepted or not — "Written on every settled run, accepted or not; a run that never reaches `finish` leaves it absent" (journal.ts:167-170). Sole production call site: `src/phase-engine/phase.ts:429`, inside the engine's finish path right after `journal.finish(runId, accepted && terminating === undefined)` (phase.ts:425-435); if the marker write throws, the engine re-finishes the journal as not-ok so journal and marker cannot disagree optimistically.
- `JournalFile` (the full journal file, distinct from the marker): `{version:"1.0.0", runId, ok, completedAt?, phases[], gateEvents[]}` (journal.ts:68-75, flush at 129-163).
- Re-exports deliberately withheld: `src/phase-engine/index.ts:19` comments that `runMarkerPath`, `runMarkerRoot`, `writeTerminalMarker` are NOT re-exported from the barrel ("deliberately…") — DF3.2 must import from `src/phase-engine/journal.ts` directly.

GAP-6 (minor): story line 191 cites "`RUN_MARKER_ROOT = process.env.QDS_RUN_ROOT ?? \"/run\"`". The mechanism exists but is the function pair `runMarkerRoot()`/`runMarkerPath()`. Import those; do not re-declare a constant.

## 2. DF2.1 Provider/driver/run-record layer — READY

### DriverPort = `ProviderDriver` (`src/providers/driver.ts:169-195`)
Full method list, exact:
```ts
export interface ProviderDriver {
  readonly name: string;
  create(name: string, tag?: string): Promise<ProviderVm>;
  list(name?: string): Promise<ProviderVm[]>;
  listWithAnomalies?(name?: string): Promise<ProviderVmListing>;   // optional
  destroy(vm: string): Promise<void>;                               // idempotent
  expose(vm: string, port: number): Promise<string>;
  setPublic(vm: string): Promise<void>;
  whoami(): Promise<string>;
  exec(vm: string, argv: string[], stdin?: string): Promise<ExecResult>;
  copyFile(vm: string, remotePath: string, localPath: string): Promise<void>;
}
```
- **No `observe` method on the port — CONFIRMED.** Story claim verified. Note the near-collision: there IS a host-side lifecycle verb `observeRun(driver, vm, remotePath, localPath)` at driver.ts:860-867 which simply wraps `copyFile`. DF3.2's poller should compose `driver.exec` (probe) + `driver.copyFile` (read) directly per the story; do not confuse with `observeRun`.
- `copyFile` is box→host ONLY (driver.ts:149-151) — exactly what the poller needs.
- `ExecResult = {stdout: string; stderr: string; exitCode: number}` (driver.ts:121-125).
- Termination contract: FakeDriver execs settle on destroy (group kill); ExeDevDriver execs settle only on their own transport timeout — "a caller awaiting an exec that can remain pending after destroy must bound that wait itself" (driver.ts:153-168). The story's 10,000 ms per-call deadline for probe/read is therefore required, not optional.

### Run-record store (`src/providers/run-record.ts`)
Closed field set — `CORE_FIELDS` (run-record.ts:58-72), 13 fields: runId, vmName, httpsUrl, keyHash, limitMicroUsd, spendMicroUsd, sessionId, commitSha, requestId, ports, pid, createdAt, closedAt. `IMMUTABLE_FIELDS = {runId, createdAt}` (:75); `SETTABLE_FIELDS` derived (:85). Unknown core key ⇒ throw (:961).

Extensions namespace mechanism — **pre-registered allow-list**, closed:
- `EXTENSION_NAMESPACES` at run-record.ts:141-179. Registered namespaces: `pr` (DF5.2), `fixLoop` (DF6.1), **`fanout: { schemaVersion: 1, fields: { fanoutId: "string", arm: "string" } }` — ALREADY REGISTERED FOR DF3.2 at run-record.ts:148-149**, plus `budget` (DF2.8, :159-169) and `gate` (DF3.1 AC3, :175-178).
- Unregistered namespace is rejected like an unknown core key (:931-932 docstring; validateExtensions). `schemaVersion` is stamped by the store, never supplied by caller (:122-123, :139).
- Patch shape: `RunRecordPatch = Partial<Omit<RunRecord,"runId"|"createdAt"|"closedAt"|"extensions">> & {extensions?: ExtensionPatch}` (:132-134). Extensions stay writable after close (:949-953).
- `ExtensionEntry { schemaVersion: number; [field:string]: string|number }` (:115-118).

Store API (`class RunRecordStore`, run-record.ts:664+):
- `constructor(opts: RunRecordStoreOptions | string = {})` — opts `{dir?, requestId?, create?, beforeRename?, beforeStealTake?, afterLockTake?}` (:581-625). `create:false` = read-only store: no mkdir/chmod/probe/sweep, mutations refuse via `assertWritable` (:727-741).
- `create(runId, now?): RunRecord` — O_EXCL `"wx"` 0600, EEXIST refuses, fsync file + dir (:876-922).
- `get(runId): RunRecord` (:924), `set(runId, patch): RunRecord` (:934, lock-guarded read-modify-write, atomicReplace), `close(runId, now?)` first-close-wins (:973-983), `path(runId)` (:856), `lockPath(runId)` = `<runId>.json.lock` (:872-874), `list()` (INV-4: throws naming unreadable .json, :985+), `listWithAnomalies(): RunRecordListing` (`{records, skipped, skippedReasons}`, :646-662).
- Dir resolution: `DEFAULT_RUNS_DIR = ".sandbox/runs"` (:627); `resolveRunsDir(dir?): string` = `dir ?? $QDS_RUNS_DIR ?? ".sandbox/runs"` (:641-643).
- Modes: dir mkdir+chmod 0700 with verification (:685-692); files 0600 (:890, :764-767 probe asserts both); O_EXCL and link(2) probed before any run starts (:758-789).

mintRunId: lives in **`src/fleet/dispatch.ts:319-321`**, exported:
```ts
export function mintRunId(): MintedRunId { return newId("qds") as MintedRunId; }
```
`MintedRunId` is a branded type (dispatch.ts:117); grammar `MINTED_RUN_ID_RE = /^qds-\d{8}-[a-f0-9]{6}$/` (dispatch.ts:74). Underlying generator `newId(slug)` = `<slug>-<YYYYMMDD>-<6 hex>` (run-record.ts:305-312). Also surfaced as CLI `scripts/run-record.ts new-id <slug>` (:166-170) — note that mints ANY slug's id, unbranded; fanout must use dispatch's `mintRunId()` to get `qds-` ids that pass dispatch's `opts.runId` check.

## 3. DF2.5 Harvest/teardown — READY (step-name mapping below)

**Entrypoints:**
- `teardownSandbox(deps: TeardownDeps, runId: string, opts: TeardownOptions = {}): Promise<void>` — teardown.ts:284-291. All failures wrapped as `TeardownError {code, remediation}` (:61-73).
- `TeardownDeps { driver, store, keyApi?, requestId?, gitCwd?, gitRunner?, runsDir?, workdir?, costLedger? }` (:75-91).
- `harvestRun(deps: HarvestDeps, runId: string, opts?: HarvestRunOptions): Promise<HarvestResult>` — harvest.ts:404-579; `HarvestResult = {outcome:"none"} | {outcome:"harvested", count, tip}` (:217-219); `HarvestRunOptions.artifactsOwnedByCaller?` (:394-402) makes teardown's step-2 pull the only artifact pass.
- `pullArtifacts(deps, runId): Promise<ArtifactsOutcome>` — harvest.ts:605.

**Fixed step order** — teardown.ts:100-111, literal array:
```
["stopVisualizer","spend","artifacts","harvest","revoke","verify","destroy","close"]
```
Story's "spend→artifacts→commits→revoke→destroy→close" maps onto this with two deltas: (a) `stopVisualizer` prepended (DF4.2, non-aborting, teardown.ts:150-212), (b) an explicit `verify` step between revoke and destroy, plus harvest's own internal verify-before-fetch. Semantics match the story; the name is `harvest`, not `commits`.

**Verify-before-fetch:** harvest Step C caps then `git bundle verify` STRICTLY BEFORE fetch (harvest.ts:509-538); Step D fetches into quarantine ONLY: `git fetch --force <bundle> refs/heads/<branch>:refs/sandbox/<runId>` (harvest.ts:542-554). Ref namespace confirmed: **`refs/sandbox/<run-id>`** (harvest.ts:15, :544, :550-551). Box branch is `sbx/<runId>` (:427).

**INV-5 protections (verified):**
- Harvest throw aborts BEFORE revoke/destroy — box alive, record open (teardown.ts:408-420). `--no-harvest` waives the harvest gate ONLY, logged, never recorded on the record (teardown.ts:365-377).
- Unconfirmed destroy aborts with record open (`destroy-unconfirmed`, teardown.ts:452-464).
- Destroy step never rides the noSuchBox skip classifier (teardown.ts:135-148).
- Record already closed ⇒ all steps skipped, idempotent (teardown.ts:333-350).
- Store-side INV-5: writable store proves 0700/O_EXCL/link(2)/0600 before any write and never degrades (:743-789); `create:false` read-only stores refuse mutation rather than skipping the proof (:586-605, :727-741).
- Dispatch-side INV-5: `refuse()` "nothing here destroys anything" (dispatch.ts:706-709); post-provision failure leaves record OPEN + box ALIVE.

## 4. DF2.6 Quota accounting — READY

**`src/providers/quota.ts`:**
```ts
export async function checkHeadroom(
  driver: HeadroomInput,            // structural: { list(name?): Promise<{name:string}[]> } (:159-161)
  requested: number,                // positive integer, else throws (:199-201)
  limits: LoadedQuotaLimits = loadQuotaLimits(),
  listTimeoutMs: number = LIST_TIMEOUT_MS,
): Promise<HeadroomResult>
```
(:192-197.) Return `HeadroomResult {allowed, liveVms, ceiling, headroom, requested, usedDiskGiB, diskEstimated:true, verified, limitsSource, reason?: "list-unverified"|"vm-ceiling"|"pooled-disk"}` (:163-180). Boundary inclusive (`liveVms + requested > maxVms` refuses, :243). `list-unverified` fail-closed on any list throw OR non-array (:209-234) — matches story AC1.

`loadQuotaLimits(file? = $QDS_QUOTA_LIMITS_FILE ?? ".sandbox/quota-limits.json"): LoadedQuotaLimits` (:104-106); absent file ⇒ defaults `{maxVms:50, maxPooledDiskGiB:100, perVmDiskReservationGiB:2, maxTransferGiB:200, staleAfterMs:14_400_000}` (:42-48); malformed ⇒ `QuotaLimitsError {code:"quota-limits-unreadable"|"quota-limits-invalid", remediation}` (:79-95).

`HeadroomRefusedError { code:"headroom-refused", result: HeadroomResult }` (:253-264).

**checkHeadroom is a READ, reserves nothing** (:5-8) — the race dispatch.ts:1727-1740 documents openly (two concurrent creates can overshoot the ceiling by one within one `driver.list()` round trip; deliberate, providers-layer fix deferred). DF3.2's single checkHeadroom(N) inside its exclusion lock sidesteps this only while it holds the lock through provisioning.

**`scripts/sandbox-reap.ts` surface:** `parseArgs(argv): ParsedArgs` (:64), `async run(argv, out, deps?: Partial<SweepDeps>): Promise<number>` (:105-185) — preflight `whoami` before any deletion, wraps `sweep(deps, {yes})` from `src/providers/reaper.ts:273`; exit 2 usage / 1 sweep failure / 0 ok. Reaper exports: `sweep(deps, opts): Promise<SweepReport>`, `RowClass/RowAction/SweepRow/SweepReport/SweepDeps/SweepOptions/SweepError`, re-exported `RUN_ID_SHAPE` (reaper.ts:59-132).

## 5. DF2.3 Credentials — READY

**`src/providers/credentials.ts`:**
- Per-run mint: `mintRunKey(deps: CredentialDeps, runId: string): Promise<{key: string; hash: string}>` (:213-333). Integer micro-dollar cap param: `CredentialDeps.capMicroUsd?: number` (:132) — validated positive integer (:230-237), default `defaultKeyCapMicroUsd = 50_000_000` (:45). Key name `sbx-<runId>` (:238, prefix `SBX_KEY_PREFIX="sbx-"` :48). One-live-key-per-run guard refuses `already-minted` (:222-229). Mint timeout compensation revokes orphans (:243-301). Writes ONLY `keyHash` (:308) and `limitMicroUsd` (:331) into the record; uncapped-key refusal (:324-330).
- **keyHash computation: it is the PROVIDER's hash** returned by `KeyApi.createKey(name, limitUsd)` (:102-108) — computed nowhere locally. Charset-validated `[A-Za-z0-9_-]+` before use in shell strings (:314-320). `KeyApi` seam: `createKey/getKeyEntry/listAllKeys/deleteKey` (:102-119).
- Revoke-then-verify: `revokeRunKey(deps, runId): Promise<"revoked"|"already-gone"|"none">` (:429) and `verifyRevoked(deps, runId): Promise<void>` (:486), composed as `revokeAndVerify(deps, keyHash): Promise<void>` (:441); teardown runs them as separate steps 4 and 5 (list-authoritative verify, teardown.ts:430-446).
- **Key file location: IN-BOX, not host-side.** `KEY_ENV_FILE = "/home/agent/app/.env"` (:51), `KEY_ENV_VAR = "OPENROUTER_API_KEY"` (:52). Delivered over `driver.exec` stdin (`deliverScript`, :341-352: `umask 077 && cat > envFile && chmod 600`), confirmation by stat mode, plaintext never on argv. Host-side persistence is keyHash-only (record field). Teardown notes "no host-side key file exists to shred — the in-box .env dies with the box" (teardown.ts:441-444, recorded deviation).

## 6. DF2.8 Budget gate — READY

**`src/providers/budget-gate.ts`:**
```ts
export function assertWithinBudget(
  ledger: BudgetLedger,             // Pick<CostLedger,"config"|"admitIssue">
  input: BudgetGateInput,           // {repoSlug, issueId, runId, requestId} (:61-66)
  keyCapMicroUsd: number = defaultKeyCapMicroUsd,
): Extract<AdmissionDecision, {admitted: true}>
```
(:79-96.) Throws `OverBudgetError` (fields: status, reason="spend-cap-exceeded", capMicroUsd, spentMicroUsd, reservedMicroUsd, unpricedRows, code, remediation — :20-48). `mintCapMicroUsd(decision)` returns `admittedCeilingMicroUsd` (:115-117).

**Ledger side (`src/providers/cost-ledger.ts`):** `admitIssue(input: AdmissionInput, capMicroUsd: number, keyCapMicroUsd: number): AdmissionDecision` (:1152). Admission decision runs inside ONE `BEGIN IMMEDIATE` transaction (`decide.immediate()` :1553; typed `ledger-busy` refusal translates SQLITE_BUSY :330-345) over priced SUM + outstanding reservations, then INSERTs the gate_admissions row (:1466). `AdmissionDecision` admitted variant: `{admitted:true, status:"within-budget", capMicroUsd, spentMicroUsd, reservedMicroUsd, remainingMicroUsd, unpricedRows, admittedCeilingMicroUsd}` (:648-658); refused variant `{admitted:false, status:"over-budget", reason:"spend-cap-exceeded", …}` (:659+).

**N arms ⇒ N reservations — CONFIRMED structurally:** reservations are grouped PER RUN: `GROUP BY a.run_id` with comment "ONE reservation per run, whatever the request id. gate_admissions' PRIMARY KEY is (request_id, run_id)" (cost-ledger.ts:1301-1307). Idempotent replay is keyed on the exact `(requestId, runId)` pair (:1144-1150, excluded from the sum via `NOT (a.request_id IS ? AND a.run_id IS ?)` :1289-1290). So N fanout arms with N distinct `mintRunId()` values each insert their own row and hold their own reservation even under one shared requestId. Reservation retires on first positive priced spend rows or aged close (cost-ledger.ts:1099-1137).

**Dispatch consults the gate per-issue, always:** dispatch step 5 runs headroom only when `opts.admitted !== true`, then ALWAYS calls `assertWithinBudget(ledger, {repoSlug, issueId, runId, requestId})` (dispatch.ts:1571-1584) — "AC7: budget admission always runs (a single dispatch is not exempt)". Ceiling handed to the mint: `effectiveCeilingMicros = decision.admittedCeilingMicroUsd` (dispatch.ts:1662) → `capMicroUsd` of mintRunKey (dispatch.ts:1984).

Note: the story's "dev deviation note" about BEGIN IMMEDIATE serialization matches code as-built (story df2-8:341 vs cost-ledger.ts:1079, :1553). No gap.

## 7. DF3.1 Dispatcher — READY

**`src/fleet/dispatch.ts`:**
```ts
export async function dispatch(
  brief: unknown,
  deps: DispatchDeps,
  opts: { admitted?: boolean; runId?: MintedRunId } = {},
): Promise<DispatchResult>
```
(:633-637.)

`DispatchDeps` (:261-302): `driver, keyApi, store` required; `repoRoot?, ledgerFactory (() => LedgerLike), quotaLimits?, port?, requestId?, clock?, timeoutMs?, dispatchLogPath?, setupGate?`. `LedgerLike = Pick<CostLedger,"config"|"admitIssue"|"close">` (:259).

`DispatchResult` ack (:310-316): `{runId: string, requestId: string, state: "ready", vmName: string, httpsUrl?: string}` — step 11 "ack (AC2: synchronous, 'provisioned', never 'succeeded')" (:2475-2516).

`{admitted:true}` skip — dispatch.ts:1529-1570: skips ONLY the `checkHeadroom(1)` call; comment names DF3.2 explicitly: "skipped only under `{ admitted: true }` (DF3.2's single checkHeadroom(N))". Budget gate still runs (below). `opts.runId` accepted only if it matches `MINTED_RUN_ID_RE` AND `assertValidRunId` (dispatch.ts:1443-1470); collision loop re-mints up to MINT_RETRIES=4 (:100, :1486-1527).

Exit-code table — `FleetError.exitCode: 1|2|3|4|5` (dispatch.ts:133, :742) rendered by scripts/fleet.ts:9-16:
- 0 success · 1 run/provider failure (incl. `record-read-failed`, `run-id-unmintable`) · 2 usage/schema (brief, roster, `run-id-not-minted`, `invalid-request-id`) · 3 setup-gate failure (assertion code in payload; substrate-failure override flips retry class, dispatch.ts:747-754) · 4 run-not-found · 5 refused BEFORE provisioning (`no-headroom`, `headroom-failed`, `budget-exceeded`, `ledger-*` — payload code says which guard) · 6 verb landed but couldn't finish/report.

600 s ceiling: `const timeoutMs = deps.timeoutMs ?? 600_000` (dispatch.ts:643); `MAX_TIMEOUT_MS = 2_147_483_647` (:91); invalid timeoutMs refuses exit 2 (:1086).

requestId CC-9 propagation: structured JSONL sink is `src/swarmclaw/log.ts` ("CC-9"). Mechanics: brief's `requestId` honoured iff strict UUID v4 else dropped and fresh minted (`resolveBriefRequestId(parsedBrief): string|undefined`, dispatch.ts:335-338; step 2 at :1130-1206). `deps.requestId` wins and gets the SAME shape check — malformed ⇒ exit 2 `invalid-request-id` (:1141-1153); brief/deps mismatch logs a warn line (:1155+). CLI pre-resolves via `resolveBriefRequestId` so record, driver and ack share one id (INV-4-bis, :329-334). The resolved id stamps: every refusal log line + dispatch-log entry, the run record's `requestId` core field (run-record.ts:100-108), the ledger admission, and the ack.

Provisioning composition: step 6 `provisionAdmittedRun` (dispatch.ts:1708+, defined driver.ts:434-659 — budget extension written BEFORE driver.create, rollback semantics at driver.ts:496-527); step 7 mint+deliver at admitted ceiling (dispatch.ts:1959-2010); step 8 fill at pinned SHA (:2110); step 9 setup gate, failure leaves record OPEN + box ALIVE (:2174); step 10 expose last (:2324); step 11 ack (:2475).

## 8. Leftover fanout/rank hooks in src/fleet/

**None.** `grep -rn "fanout|\brank\b" src/fleet/` returns zero hits. The only `fanout` token in src/ is the pre-registered extension namespace `fanout` in `EXTENSION_NAMESPACES` (run-record.ts:148-149) and the `{admitted:true}` doc comments referencing DF3.2 (dispatch.ts:17-19, :1530, :1733 "would serialise DF3.2's N-arm fan-out"). No partial implementation, no rank scoring, no winner-transition scaffolding exists.

---

## Gap register (all severities)

| # | Severity | Story assumption | Reality | Action |
|---|----------|------------------|---------|--------|
| G1 | INFO | `extensions.fanout` needs registering | Already registered verbatim `{schemaVersion:1, fields:{fanoutId:"string", arm:"string"}}` at run-record.ts:149 | None — do not re-register |
| G2 | LOW | Story shorthand `dispatch(brief, {admitted:true, runId})` | Real signature is `dispatch(brief, deps, opts)` — DispatchDeps is mandatory 2nd arg; opts.runId must be `qds-` branded/mint-shaped | Spec the call with full deps |
| G3 | LOW | "`RUN_MARKER_ROOT = process.env…`" | Function `runMarkerRoot()`/`runMarkerPath()`; no such constant; NOT re-exported from phase-engine barrel | Import from `src/phase-engine/journal.ts` |
| G4 | LOW | Teardown order "spend→artifacts→commits→revoke→destroy→close" | Actual: stopVisualizer→spend→artifacts→harvest→revoke→verify→destroy→close (teardown.ts:102-111) | Use real step names; expect stopVisualizer + verify steps in logs |
| G5 | NOTE | "no observe method added to the port" | Confirmed — but `observeRun()` host verb exists wrapping copyFile (driver.ts:860) | Compose exec+copyFile directly; don't grab observeRun blindly |
| G6 | NOTE | Marker "written at finish(accepted)" | Written on EVERY settled run, ok true or false; absence means never finished (journal.ts:167-171) | Poller must branch on ok value, not presence |
| G7 | WATCH | Single-operator lock makes read-then-mint safe | checkHeadroom reserves NOTHING (quota.ts:5-8); ceiling race documented at dispatch.ts:1727-1740 | Fanout must hold its lock from checkHeadroom(N) THROUGH the last provisionAdmittedRun, else N boxes can overshoot maxVms |
