# DF3.1 Integration Specification

## Module Contracts

### brief-schema.ts
```typescript
import { z } from "zod";

export const BriefSchema = z.strictObject({
  repoSlug: z.string().regex(/^[A-Za-z0-9._-]{1,100}\/[A-Za-z0-9._-]{1,100}$/),
  issueId: z.number().int().positive().max(2**31 - 1),
  issueUrl: z.string().url().optional(),
  commitSha: z.string().regex(/^[0-9a-f]{40}$/),
  requestId: z.string().uuid().optional(),
  manifestPath: z.string(), // host path to pipeline manifest
  repoUrl: z.string().url(), // for pinned-SHA fill
});

export type Brief = z.infer<typeof BriefSchema>;
```
- Size cap: 64 KiB enforced at dispatch ingress
- Validation: schema check happens before any side effect (INV-2)
- requestId resolution: strict UUID v4 honoured, else fresh mint (AC2)

### dispatch.ts
```typescript
import { RunRecordStore, resolveDriver, mintRunKey, deliverRunKey, checkHeadroom, assertWithinBudget, HeadroomRefusedError, OverBudgetError } from "../providers/index.js";
import { fillRun } from "../providers/exedev/fill.ts";
import { setupGate, SetupGateResult } from "../providers/exedev/setup-gate.ts";
import { stampManifestLimit, serializeManifest } from "../phase-engine/manifest.ts";
import { resolveRunCorrelation, CorrelationError, RequestIdRepoMismatchError } from "../phase-engine/issue-correlation.ts";
import { log, newRequestId, setLogSink } from "../swarmclaw/log.ts";
import type { ProviderDriver } from "../providers/driver.ts";
import type { KeyApi } from "../providers/credentials.ts";
import type { IssueRef, ResolvedRunCorrelation } from "../phase-engine/types.ts";

export interface DispatchDeps {
  driver: ProviderDriver;
  keyApi: KeyApi;
  store: RunRecordStore;
  requestId?: string;
  admitted?: boolean; // DF3.2-only; default false suppresses AC8 headroom check only
}

export interface DispatchResult {
  runId: string;
  requestId: string;
  state: "ready";
  vmName: string;
  httpsUrl?: string;
}

/**
 * Dispatch: validate → resolve → admit → create → mint → fill → gate
 *
 * Ordering (AC7/AC8): admission gates run BEFORE store.create, before driver.create
 * - resolveRunCorrelation: pure validation (no fs/db)
 * - checkHeadroom(1): read-only driver.list()
 * - assertWithinBudget: calls ledger.admitIssue which writes reservation (idempotent via PK)
 * - createRun: repeats both checks internally; second calls are no-ops due to idempotency
 *
 * Admitted ceiling propagation (AC9):
 * - effectiveCeilingMicros = min(remainingMicroUsd, defaultKeyCapMicroUsd)
 *   where remainingMicroUsd comes from assertWithinBudget decision
 * - Stamped into manifest as limitMicroUsd before fill
 * - Carried in run context as effectiveCeilingMicros
 */
export async function dispatch(
  brief: IssueRef & { manifestPath: string; repoUrl: string },
  deps: DispatchDeps,
): Promise<DispatchResult> {
  // 1. Validate brief schema (INV-2) - before any side effect
  const validated = BriefSchema.parse(brief);
  
  // 2. Resolve correlation (CC-9, AC2)
  const correlation: ResolvedRunCorrelation;
  try {
    correlation = resolveRunCorrelation(validated);
  } catch (e) {
    if (e instanceof CorrelationError) {
      exitStatus(2, { code: e.code, message: e.message, remediation: "fix the brief field" });
    }
    throw e;
  }
  
  // 3. Admission gates (AC7/AC8) - before record creation
  let admitted: Extract<AdmissionDecision, { admitted: true }> | undefined;
  try {
    // Headroom check (AC8) - skipped only when {admitted:true} (DF3.2)
    if (!deps.admitted) {
      const headroom = await checkHeadroom(deps.driver, 1, loadQuotaLimits());
      if (!headroom.allowed) {
        exitStatus(5, { 
          code: "no-headroom", 
          reason: headroom.reason,
          message: `fleet ceiling: ${headroom.liveVms}/${headroom.ceiling}, headroom ${headroom.headroom}`,
          remediation: "wait for slots or increase quota" 
        });
      }
    }
    
    // Budget check (AC7) - when issue ref present
    if (validated.repoSlug && validated.issueId) {
      const ledger = new CostLedger({ /* deps */ });
      admitted = assertWithinBudget(ledger, {
        repoSlug: validated.repoSlug,
        issueId: String(validated.issueId),
        runId: correlation.runId,
        requestId: correlation.requestId,
      });
      // ledger closed in finally
    }
  } catch (e) {
    if (e instanceof HeadroomRefusedError) {
      exitStatus(5, { 
        code: "no-headroom",
        message: e.message,
        result: e.result 
      });
    }
    if (e instanceof OverBudgetError) {
      exitStatus(5, {
        code: "budget-exceeded", // story-mandated name
        payload: e.code, // DF2.8's literal "over-budget"
        capMicroUsd: e.capMicroUsd,
        spentMicroUsd: e.spentMicroUsd,
        remediation: e.remediation
      });
    }
    throw e;
  }
  
  // 4. Create run (INV-1 ordering: record → box)
  const runId = correlation.runId;
  const record = await createRun(deps.driver, deps.store, {
    runId,
    issue: admitted ? {
      repoSlug: validated.repoSlug!,
      issueId: String(validated.issueId!),
      requestId: correlation.requestId,
    } : undefined,
  });
  
  // 5. Mint key (INV-1 ordering: key last)
  // capMicroUsd = admittedCeilingMicros from decision, or default
  const capMicroUsd = admitted?.admittedCeilingMicroUsd ?? defaultKeyCapMicroUsd;
  const { key, hash } = await mintRunKey({
    keyApi: deps.keyApi,
    driver: deps.driver,
    store: deps.store,
    requestId: correlation.requestId,
    capMicroUsd,
  }, runId);
  
  // 6. Fill at pinned SHA (AC9a: stamp limit into manifest)
  const manifest = loadManifest(validated.manifestPath, undefined, process.cwd());
  const stamped = stampManifestLimit(manifest, capMicroUsd);
  const manifestYaml = serializeManifest(stamped);
  
  await fillRun(deps.driver, record.vmName!, [
    { path: "pipeline.yaml", content: manifestYaml },
    // brief files as BoxFiles...
  ]);
  
  // 7. Setup gate (AC3)
  let gateResult: SetupGateResult;
  try {
    gateResult = await setupGate(deps.driver as ExeDevDriver, record.vmName!, {
      runId,
      rosterPath: validated.rosterPath, // from brief or derived
      commitSha: validated.commitSha,
      requestId: correlation.requestId,
    });
  } catch (e) {
    if (e instanceof RequestIdRepoMismatchError) {
      exitStatus(2, { code: "request-id-mismatch", message: e.message, remediation: "use fresh requestId" });
    }
    throw e;
  }
  
  if (!gateResult.ready) {
    // Record stays open, box alive (INV-5)
    deps.store.set(runId, { 
      extensions: { 
        setupGate: { 
          failed: true, 
          assertionCode: gateResult.assertionCode,
          assertions: gateResult.assertions 
        } 
      } 
    });
    exitStatus(3, { 
      code: "gate-failed", 
      assertionCode: gateResult.assertionCode,
      message: `setup gate failed at item ${gateResult.failedItem}`,
      remediation: gateResult.debugCommands.join("; ")
    });
  }
  
  // 8. Return ack
  return {
    runId,
    requestId: correlation.requestId,
    state: "ready",
    vmName: record.vmName!,
    httpsUrl: record.httpsUrl,
  };
}
```

### status.ts
```typescript
import { RunRecordStore, resolveDriver } from "../providers/index.js";
import { checkHeadroom, LIST_TIMEOUT_MS } from "../providers/quota.ts";
import type { ProviderDriver } from "../providers/driver.ts";

export interface StatusRow {
  runId: string;
  requestId?: string;
  state: "live" | "boxMissing" | "boxUnknown" | "closed";
  vmName?: string;
  httpsUrl?: string;
  createdAt: string;
  closedAt?: string;
}

/**
 * Status: store.list() ∪ driver.list() with 30s timeout
 *
 * Row states (AC4):
 * - live: record.open && driver.list() includes vmName
 * - boxMissing: record.open && driver.list() does not include vmName
 * - boxUnknown: record.open && driver.list() threw/timed out
 * - closed: record.closedAt exists
 *
 * Single-run status <runId> → typed error → exit 4 (AC4)
 */
export async function statusAll(
  deps: { driver: ProviderDriver; store: RunRecordStore },
  opts: { runId?: string },
): Promise<StatusRow[]> {
  if (opts.runId) {
    try {
      const rec = deps.store.get(opts.runId);
      return [serializeRow(rec, deps.driver)];
    } catch (e) {
      exitStatus(4, {
        code: "run-not-found",
        message: `no run record for ${opts.runId}`,
        remediation: "check run id or create the run first"
      });
    }
  }
  
  const records = deps.store.list();
  let vms: ProviderVm[] = [];
  try {
    vms = await checkHeadroom(deps.driver, 0, loadQuotaLimits(), LIST_TIMEOUT_MS)
      .then(() => deps.driver.list());
  } catch {
    // list timeout/throw → boxUnknown for all
  }
  
  const vmSet = new Set(vms.map(v => v.name));
  return records.map(rec => {
    if (rec.closedAt) return { ...rec, state: "closed" };
    if (!rec.vmName) return { ...rec, state: "boxMissing" };
    if (vmSet.size === 0) return { ...rec, state: "boxUnknown" };
    return { 
      ...rec, 
      state: vmSet.has(rec.vmName) ? "live" : "boxMissing" 
    };
  });
}

function serializeRow(rec: RunRecord, driver: ProviderDriver): StatusRow {
  // implementation
}
```

### verbs.ts
```typescript
import type { FlagSpec, VerbRegistry } from "./types.ts";

export function listVerbs(): VerbRegistry {
  return {
    dispatch: {
      verb: "dispatch",
      summary: "Mint a run handle and provision a sandbox",
      flags: [
        { name: "--driver", required: false, valueType: "string", default: "fake" },
        { name: "--brief", required: false, valueType: "path", default: "stdin" },
        { name: "--dir", required: false, valueType: "path" },
      ],
      exitCodes: [0, 1, 2, 3, 5],
    },
    status: {
      verb: "status",
      summary: "List fleet state or single-run status",
      flags: [
        { name: "--driver", required: false, valueType: "string", default: "fake" },
      ],
      exitCodes: [0, 1, 4],
    },
    harvest: {
      verb: "harvest",
      summary: "Pull bundle + artifacts from a box",
      flags: [
        { name: "--driver", required: false, valueType: "string", default: "fake" },
        { name: "--dir", required: false, valueType: "path" },
      ],
      exitCodes: [0, 1, 4],
    },
    teardown: {
      verb: "teardown",
      summary: "Destroy a box and close its record",
      flags: [
        { name: "--driver", required: false, valueType: "string", default: "fake" },
        { name: "--dir", required: false, valueType: "path" },
        { name: "--no-harvest", required: false, valueType: "boolean" },
      ],
      exitCodes: [0, 1, 3, 4],
    },
  };
}
```

### index.ts
```typescript
export * from "./brief-schema.ts";
export * from "./dispatch.ts";
export * from "./status.ts";
export * from "./verbs.ts";
export * from "./harvest.ts";
export * from "./teardown.ts";
```

### scripts/fleet.ts
```typescript
#!/usr/bin/env bun
import { setLogSink } from "../src/swarmclaw/log.ts";
import { resolveDriver } from "../src/providers/index.js";
import { listVerbs } from "../src/fleet/verbs.ts";
import * as verbs from "../src/fleet/index.ts";

setLogSink((entry) => process.stderr.write(`${JSON.stringify(entry)}\n`));

const HELP = renderHelpFromRegistry(listVerbs());

// Main verb dispatch
const verb = process.argv[2];
switch (verb) {
  case "dispatch":
    await verbs.dispatch(parseBrief(), { driver: resolveDriver(), ... });
    break;
  case "status":
    await verbs.status({ runId: process.argv[3], driver: resolveDriver() });
    break;
  case "harvest":
    await verbs.harvest({ runId: process.argv[3], driver: resolveDriver() });
    break;
  case "teardown":
    await verbs.teardown({ runId: process.argv[3], driver: resolveDriver() });
    break;
  default:
    console.log(HELP);
    exit(1);
}
```

### manifest.ts (additive edit)
```typescript
// Add to PipelineManifestSchema (line 122-129):
export const PipelineManifestSchema = z
  .object({
    version: z.literal(MANIFEST_VERSION),
    pipelineId: z.string().regex(PIPELINE_ID_PATTERN, "pipelineId must match ^[a-z][a-z0-9-]{1,63}$"),
    runBudgetMs: z.number().int().positive(),
    limitMicroUsd: z.number().int().positive().optional(), // DF3.1 AC9: stamped by dispatch
    phases: z.array(PhaseSpecSchema).min(MIN_PHASES, `phaseCount < ${MIN_PHASES}`),
  })
  .strict();

/**
 * Stamp limitMicroUsd into a manifest for fill. Returns a frozen copy.
 */
export function stampManifestLimit(manifest: LoadedManifest, limitMicroUsd: number): LoadedManifest {
  const stamped = { ...manifest.manifest, limitMicroUsd };
  return { ...manifest, manifest: deepFreeze(stamped) };
}

/**
 * Serialize manifest to YAML for fill. LoadManifest reads JSON; this exports
 * YAML for the in-box copy.
 */
export function serializeManifest(manifest: LoadedManifest): string {
  // YAML dump of manifest.manifest
}
```

## Locked Decisions (D1-D10)

### D1. Admission Architecture — SUPERSEDED by C1 (see Corrections, below)

> **Overturned.** Dispatch does NOT call `createRun`; it composes the primitives directly. Read C1 before anything in this section.

**Verdict**: Option (b) - dispatch calls admission gates, then calls `createRun` accepting idempotent internal checks.

**Evidence**:
- `budget-gate.ts:69-86`: `assertWithinBudget` calls `ledger.admitIssue` which writes to `gate_admissions` table (cost-ledger.ts:112-119)
- `driver.ts:138-139`: `checkHeadroom` is read-only list enumeration
- `cost-ledger.ts:112-119`: `gate_admissions` has `PRIMARY KEY (request_id, run_id)` - second call is no-op via `ON CONFLICT`
- `driver.ts:184-199`: `createRun` already calls both gates internally; second calls are safe due to idempotency
- Calling gates before `createRun` satisfies AC7/AC8 "before record creation" while keeping implementation simple

**Key fact**: `assertWithinBudget` DOES mutate ledger state via reservation, but is idempotent for the same `(requestId, runId)` tuple.

### D2. Brief Schema Fields
**Verdict**: Seven fields locked as specified

**Evidence**:
- `issue-correlation.ts:32-45`: `REPO_SLUG_PATTERN`, `UUID_V4_PATTERN`, `MAX_ISSUE_ID` validators
- `setup-gate.ts:90-103`: `SetupGateOptions` requires `runId`, `rosterPath`, `commitSha`
- `fill.ts:22-31`: `FillOptions` requires `runId`, `repoUrl`, `commitSha`
- `manifest.ts:587`: `loadManifest` signature requires `manifestPath`, `callerBudgetMs`, `runRoot`

**Locked fields**:
- `repoSlug`: validated owner/name (issue-correlation)
- `issueId`: int >0, MAX_ISSUE_ID capped (issue-correlation)
- `issueUrl?`: optional string URL
- `commitSha`: 40-hex regex (setup-gate, fill)
- `requestId?`: UUID v4, resolved at dispatch (issue-correlation)
- `manifestPath`: host path to pipeline manifest
- `repoUrl`: for pinned-SHA fill (fill.ts)
- `rosterPath`: NOT in brief - derived from convention or default

**Size cap**: 64 KiB enforced at dispatch ingress before validation

### D3. Fake-Driver Setup-Gate Path
**Verdict**: Use `fillRun` with BoxFiles + fake path logic

**Evidence**:
- `fake-driver.ts:42-104`: `FakeDriver` implements `ProviderDriver` interface with `create`, `exec`, `copyFile`
- `setup-gate.ts:187-224`: `setupGate` only uses `driver.exec` and `driver.execTimed` structurally
- `setup-gate.ts:254-255`: envFile delivery via `driver.exec` stdin (works for fake)
- `fill.ts:95-150`: `fillExeDev` is exe.dev-specific; fake path uses `fillRun` (driver.ts:222-248)

**Fake-path behavior**:
- For fake driver: "fill at pinned SHA" means `fillRun` with stamped manifest YAML as BoxFile
- CommitSHA recorded in run record, but no actual git clone (boxes are plain directories)
- `setupGate` runs via `driver.exec` against fake box, returning simulated ready result

### D4. Manifest Stamping Mechanism
**Verdict**: Add `limitMicroUsd` to schema; provide `stampManifestLimit` + `serializeManifest` helpers

**Evidence**:
- `manifest.ts:122-129`: `PipelineManifestSchema` is zod strict object
- `manifest.ts:571-577`: `deepFreeze` implementation already exists
- `manifest.ts:587-659`: `loadManifest` reads/parses JSON; no string/serialize helper exists

**Additive edit**:
- Add `limitMicroUsd: z.number().int().positive().optional()` to schema
- Export `stampManifestLimit(manifest, limitMicroUsd): LoadedManifest` - stamps, validates, freezes
- Export `serializeManifest(manifest): string` - YAML dump for fill

### D5. Key Mint + Delivery Seam
**Verdict**: Mint with `capMicroUsd = admitted?.admittedCeilingMicroUsd ?? defaultKeyCapMicroUsd`; deliver via `deliverRunKey`

**Evidence**:
- `budget-gate.ts:105-106`: `mintCapMicroUsd(decision)` returns `decision.admittedCeilingMicroUsd`
- `credentials.ts:188-305`: `mintRunKey` accepts `capMicroUsd` in `CredentialDeps`
- `credentials.ts:320-340`: `deliverRunKey` delivers to `KEY_ENV_FILE` via stdin
- `fake-driver.ts:162-209`: `exec` accepts stdin, works for fake boxes

**Expression**: `capMicroUsd = admitted?.admittedCeilingMicroUsd ?? defaultKeyCapMicroUsd`

**Delivery**: `deliverRunKey` works on fake driver via `exec` stdin; key material never logged (INV-4)

### D6. Status Join — SUPERSEDED in part by C6 (see Corrections, below)

> **Corrected.** The registry entry shape and per-verb exit codes are C6's, not this section's.

**Verdict**: `store.list() ∪ driver.list()` with 30s timeout; JSON lines output

**Evidence**:
- `quota.ts:192-250`: `checkHeadroom` with `LIST_TIMEOUT_MS = 15000` (15s default)
- `run-record.ts:390-500`: `RunRecordStore` list/create/get interface
- `run-record.ts` CLI precedent prints JSON lines (per sandbox-teardown.ts pattern)

**Output shape**: JSON one-per-line (matches run-record.ts precedent)
**Row states**: `live | boxMissing | boxUnknown | closed | orphan` (AC4 + amendment B6)

> **AMENDED (review B6)** — the shipped `StatusRow` adds one state and one field
> beyond the four states AC4/D6 listed. Both are normative now; DF3.5's contract
> test must be written against this list, not the original four.
>
> - **`orphan`** — an OWNED box (per the ownership filter: an explicit foreign
>   tag excludes it, an absent tag does not) that no run record claims, by run id
>   or by `vmName`. This is unattributed spend: a box that is alive and billing
>   with nobody accountable for it, which is exactly what joining `store.list()`
>   with `driver.list()` exists to surface. An orphan row carries no `requestId`
>   and no `createdAt` — it has no record to take either from — so **`createdAt`
>   is OPTIONAL on `StatusRow`** and absent on precisely this one row class
>   (review B7: a placeholder `""` made every renderer's `Date.parse` return
>   `NaN` on the row the sort deliberately floats to the top). Orphan rows sort
>   first.
> - **`boxAlive?: boolean`** — set only on a `closed` row whose box the substrate
>   still reports. Teardown destroys BEFORE it closes, so a closed record over a
>   live box means the destroy never landed and the box is still billing. Absent
>   (not `false`) on every other row, including a closed row whose box is gone.

**Single-run**: `getRecord` typed error → exit 4 with `{code, message, remediation}`

> **AMENDED (review B1)** — exit 4 requires the absence of BOTH halves. The
> record and the box are separately losable (operator record cleanup, a `--dir`
> mismatch between dispatch and the query, the INV-1 crash window), and
> `statusAll` already classifies a recordless box as `orphan`. So on store
> ENOENT the single-run path runs the same owned-box lookup under the run id and
> returns an `orphan` row if one exists; it refuses with exit 4 only when neither
> a record nor an owned box is found. A list failure or timeout is NOT a hit — it
> still refuses 4 rather than inventing a box out of a timeout. "Mutates nothing"
> stands: the driver is read, never written.

### D7. Exit-Code Mapping
**Verdict**: Fixed mapping with story-mandated codes

| Error | Exit | Payload Code | Source |
|-------|------|--------------|--------|
| `CorrelationError` | 2 | INVALID_* | issue-correlation.ts |
| Zod fail | 2 | field named | brief-schema |
| `RequestIdRepoMismatchError` | 2 | request-id-mismatch | tracer.ts:974 |
| `OverBudgetError` | 5 | budget-exceeded (story) / over-budget (payload) | budget-gate.ts |
| `HeadroomRefusedError` | 5 | no-headroom | quota.ts |
| `SetupGateResult.ready=false` | 3 | assertionCode in payload | setup-gate.ts |
| Run not found | 4 | run-not-found | AC4 |

**EXIT_STATUSES**: Import from `cli-anything/src/types.ts` (used in LogEntry.exitStatus)

### D8. Verb Registry + CLI — SUPERSEDED by C6 and C8 (see Corrections, below)

> **Corrected.** C6 fixes the registry entry shape and the exit-code table; C8 fixes the fill-path discrimination. This section's sketch is stale where they disagree.

**Verdict**: Registry-driven `--help`; verb table in `verbs.ts`

**Evidence**:
- `sandbox-teardown.ts:65-67`: VALUE_FLAGS pattern
- `cli-args.ts:50-88`: `parseValueFlags` implementation

**Flags per verb**:
- `dispatch`: `--driver` (default fake), `--brief <path>` (else stdin), `--dir?`
- `status`: positional runId optional, `--driver`
- `harvest`: runId positional, `--driver`, `--dir?`
- `teardown`: runId positional, `--driver`, `--dir?`, `--no-harvest?`

**CLI**: `scripts/fleet.ts` imports `listVerbs` for `--help`; 600s wall clock; sub-timings; INV-6 redaction

### D9. Trace-Store Session
**Verdict**: Call `resolveRunCorrelation` only; emit log lines; no `initiateSession`

**Evidence**:
- `tracer.ts:974-1059`: `initiateSession` opens DB and writes sessions row
- `issue-correlation.ts:85-123`: `resolveRunCorrelation` is pure validation
- Story AC2: requestId appears in "every trace-store row" via DF1.8 wiring, not dispatch direct call

**Behavior**: Dispatch calls `resolveRunCorrelation` for validation; trace store opened by pipeline-run (engine-side)

### D10. Test Plan Mapping
**Verdict**: 4 FTM test files cover DoD checkboxes

| Test File | DoD Coverage |
|-----------|--------------|
| `tests/fleet/brief-schema.test.ts` | Malformed briefs → 2; zero provisioning call-order |
| `tests/fleet/dispatch.test.ts` | Admission refusals → 5; {admitted:true} suppression; requestId resolution; ack shape; cap hand-off |
| `tests/fleet/verbs.test.ts` | Registry bidirectional; flags coverage |
| `tests/fleet/cli.test.ts` | E2E dispatch→status→teardown with spendMicroUsd |

**Fixtures to reuse**: `FakeDriver`, `FakeKeyApi`, fleet-state setup patterns

## Executive Summary

The DF3.1 dispatcher integrates DF2.x provider layer with admission gates (DF2.6 headroom, DF2.8 budget) executing **before** record creation. `assertWithinBudget` mutates ledger state via reservation but is idempotent via primary key constraints, allowing dispatch to call admission gates then `createRun` safely. The brief schema carries seven validated fields (repoSlug, issueId, issueUrl, commitSha, requestId, manifestPath, repoUrl) capped at 64 KiB. Fake-path execution uses `fillRun` with BoxFiles; `setupGate` works structurally over `ProviderDriver.exec`. Manifest stamping adds `limitMicroUsd` via additive schema edit with `stampManifestLimit`/`serializeManifest` helpers. Key minting uses `capMicroUsd = admittedCeilingMicroUsd ?? defaultKeyCapMicroUsd` delivered via `deliverRunKey`. Status joins store/driver lists with 30s timeout outputting JSON lines. Exit codes map `OverBudgetError` → 5 code `budget-exceeded`, `HeadroomRefusedError` → 5 code `no-headroom`, `SetupGateResult.ready=false` → 3, `RunNotFound` → 4. The verb registry drives `--help`; trace-store session is not opened by dispatch (resolved via correlation only). Four test files cover all DoD requirements reusing existing fixtures.

---

# CORRECTIONS — orchestrator-verified 2026-08-21 (supersede conflicting sketch code above)

These corrections were verified by direct source reads after the architect agent died post-write. Where the sketch above conflicts, THESE WIN.

## C1. D1 OVERTURNED → Option (c): dispatch composes primitives; NEVER calls createRun.
Evidence: driver.ts:134 `checkHeadroom(driver, 1, loadQuotaLimits())` is UNCONDITIONAL inside createRun — no skip option, and driver.ts is not editable (FTM). Routing {admitted:true} through createRun makes N fan-out arms do N headroom checks of 1 — violates DF3.1 AC8 + DF3.2 AC1 ("a fan-out still makes exactly one headroom call for all N").
Dispatch's own sequence (mirrors createRun body minus admission, admission dispatch-owned per story: "DF3.1 owns only the two call sites (AC7, AC8), placed before driver.create()"):
1. validate (zod strict) → 2. requestId drop-rule: if brief.requestId present && !isValidUuidV4(brief.requestId) → set undefined (AC1: malformed mints fresh, NEVER exit 2) → resolveRunCorrelation (throws CorrelationError → CLI exit 2) → 3. if (!admitted) checkHeadroom(driver,1) — allowed:false (any reason incl "list-unverified") → FleetError exit 5 code no-headroom → 4. assertWithinBudget(ledger, {repoSlug, issueId: String(int), runId, requestId}) — ledger constructed EXACTLY like createRun's (readRunRecord: store.get w/ ENOENT→undefined passthrough, other errors rethrow), closed in finally; OverBudgetError → FleetError exit 5 code budget-exceeded carrying DF2.8's literal payload fields (capMicroUsd, spentMicroUsd, reservedMicroUsd, unpricedRows, remediation) → 5. store.create(runId) O_EXCL → 6. store.set budget extension (mirror createRun: repoSlug, issueId, capMicroUsd, spentMicroUsd, reservedMicroUsd, admittedCeilingMicroUsd) → 7. driver.create(runId, SBX_OWNERSHIP_TAG) → 8. **[AMENDED — see DN1 below; expose/setPublic MOVED to after the setup gate]** → 9. store.set({vmName, httpsUrl?}) → 10. mintRunKey({...deps, capMicroUsd: mintCapMicroUsd(decision)}, runId) — decision.admittedCeilingMicroUsd IS effectiveCeilingMicros (AC9b), computed by DF2.8, never re-derived → 11. deliverRunKey → 12. stamp manifest limitMicroUsd = SAME ceiling (AC9a) → 13. fill → 14. setup gate → 15. ack {runId, requestId, state:"ready", vmName, httpsUrl}.
> **AMENDED (review DN1) — step 8 moves; the SHIPPED order is normative.**
> The spec put `expose/setPublic` immediately after `driver.create` (step 8).
> The code deliberately moved it to AFTER the setup gate, and the security
> ordering is correct and stays. Making a box PUBLIC before the gate has run
> proves it reachable while it is still unproven — INV-5's whole point is that
> nothing is exposed until the gate says the box is what we think it is. The
> normative sequence is therefore:
>
> `… → 7. driver.create → 8. store.set({vmName, httpsUrl?}) — vmName lands
> BEFORE anything that can throw against a live, already-billing box → 9.
> mintRunKey → 10. deliverRunKey → 11. stamp manifest limitMicroUsd → 12. fill
> at the pinned SHA → 13. setup gate → 14. expose/setPublic, only if the port
> option is set AND gate.ready → 15. store.set({httpsUrl, ports}) → 16. ack.`
> (`vm.httpsUrl` may still exist straight from `create` on substrates that
> report one; that is not an exposure this step performed.)
>
> **Consequence DF3.2 and DF3.4 must build against**: on a gate failure (exit 3)
> the run record carries **no `httpsUrl` and no `ports`** — the record stays open
> and the box stays alive (INV-5), but it was never exposed and never made
> public. Do not treat a missing `httpsUrl` on an open record as a dispatch bug;
> for a `--port` run it is the signature of a gate refusal.

runId = mintRunId() = newId("qds") re-export from src/fleet/dispatch.ts (DF3.2 imports mintRunId from there). Optional opts.runId only via in-process dispatch(brief,{runId}) — must satisfy assertValidRunId AND be a dispatcher-minted value; caller-invented → reject (AC2).

## C2. dispatch() NEVER process.exit()s — src throws, CLI maps.
Define in dispatch.ts: `export class FleetError extends Error { constructor(public readonly exitCode: 1|2|3|4|5, public readonly code: string, message: string, public readonly remediation: string, public readonly payload?: Record<string, unknown>) }`. All refusal paths throw FleetError; scripts/fleet.ts catches and maps exitCode. (Sketch's exitStatus() calls inside dispatch are wrong.)

> **AMENDED (review B9)** — the exitCode union was specified `2|3|4|5`; the code
> ships `1|2|3|4|5` and the widening is the improvement, not a drift. Exit 1 is a
> real refusal class (`dispatch-timeout`, an unreadable run-record store), and
> admitting it into `FleetError` is what makes EVERY exit — 1 included — carry a
> structured `{code, message, remediation, payload?}` envelope and a
> dispatch-log entry, instead of escaping as an untyped stack trace that the one
> renderer in `scripts/fleet.ts` never sees. Keep `1` in the union.

## C3. Brief schema — requestId is LOOSE at schema layer.
`requestId: z.string().optional()` — NOT .uuid() (a non-UUID string is not a schema failure per AC1; a v1-UUID-shaped string passes schema then gets dropped by the isValidUuidV4 pre-resolver rule). issueId stays z.number().int().positive().max(2**31-1); assertWithinBudget receives String(issueId). Fields: repoSlug, issueId, issueUrl?, commitSha(/^[0-9a-f]{40}$/), requestId?, manifestPath, repoUrl. 64KiB cap enforced by CLI reader BEFORE parse (exit 2 code brief-too-large).

## C4. status.ts — boxUnknown only on list failure; empty list is boxMissing.
The sketch's `vmSet.size === 0 → boxUnknown` is WRONG (violates inkwell doctrine "a failed lookup must never render as every VM destroyed" and AC4). Track `listOk: boolean` + `vmSet`. closedAt → state "closed" (skip driver join). open + vmName unset → boxMissing. open + listOk && vm in set → live; vm not in set → boxMissing. open + !listOk (throw OR 30s timeout) → boxUnknown. 30s timeout = dispatch-owned Promise.race wrapper around driver.list() (story mandates 30_000; quota's LIST_TIMEOUT_MS=15000 is a different surface — do not reuse). Output: one JSON per line per run-record.ts CLI precedent. StatusRow carries spendMicroUsd?/limitMicroUsd?. Single-run path: store.get typed ENOENT → FleetError exit 4 {code:"run-not-found", message, remediation} mutating nothing. Empty fleet: exit 0, empty output (a state, not an error).

> **AMENDED (reviews B6/B7/B1)** — three additions to the above, all shipped and
> all normative (see the fuller notes under D6):
> 1. A fifth row state, **`orphan`**: an owned box (explicit foreign tag excludes
>    it; absent tag does not) claimed by no record, by run id or by `vmName`.
>    Unattributed spend, which is the reason the union is a join at all. Plus
>    **`boxAlive?`** on a `closed` row whose box the substrate still reports.
> 2. **`createdAt` is optional on `StatusRow`** and absent exactly on `orphan`
>    rows, which have no record to take it from. Orphan rows sort first.
> 3. The single-run ENOENT path is **not** unconditional exit 4: it runs the same
>    owned-box lookup under the run id and returns an `orphan` row when a box
>    exists, refusing 4 only when NEITHER a record nor an owned box is found. A
>    list failure/timeout is not a hit (still 4). "Mutating nothing" holds — the
>    driver is read, never written.

## C5. index.ts — NO harvest.ts/teardown.ts modules (not in FTM).
Harvest/teardown verbs are thin front doors implemented INSIDE scripts/fleet.ts directly over providers' harvestRun/teardownSandbox (delegate unmodified, guards intact, no second retry loop). index.ts exports only: brief-schema, dispatch, status, verbs.

## C6. verbs.ts registry entry shape EXACTLY per story AC6: {verb, summary, flags:[{name,required,valueType}], exitCodes} — no extra keys (default/summary variants in sketch removed; DF3.5's contract test consumes this shape).
flags list = dashed flags only (positionals like runId are per-verb CLI grammar, not registry flags). exitCodes: dispatch [0,1,2,3,5]; status [0,1,2,4]; harvest [0,1,2,4]; teardown [0,1,2,4] (sketch's 3 on teardown wrong — 3 is setup-gate-only).

> **AMENDED (review B8)** — status/harvest/teardown were specified `[0,1,4]`; the
> shipped registry declares `[0,1,2,4]` and the shipped registry is the accurate
> one. All three verbs really do refuse with **2**: a run id that fails the
> canonical grammar or the length cap (`assertFleetRunId`), an extra positional,
> a missing required `<run-id>`, a flag the verb does not take, or a repeated
> value flag — every one of those is a usage refusal raised by `parseArgv` before
> the verb runs, and `tests/fleet/verbs.test.ts` demonstrates each. DF3.5's
> contract test must be written against `[0,1,2,4]`; the code is correct here.
>
> **AMENDED (review B2)** — `--driver` is `required: true` on all four entries
> (it was declared `required: false`). `assertDriverChosen` in `scripts/fleet.ts`
> refuses every verb with exit 2 when the flag is absent and no driver is
> injected, because no verb may ever silently default to the fake driver. A
> generated DF3.5 skill built from a registry that called `--driver` optional
> would exit 2 on every call. The injected-driver escape hatch (tests, embedders)
> is not an argv shape, so it does not make the flag optional in the contract. Registry is a MAP or array — pick array of entries; listVerbs() returns it fresh; --help renders from it; bidirectional coverage test asserts CLI dispatch table ⇄ registry parity both directions.

## C7. Setup gate honesty rule — no simulated results.
setupGate(driver, vm, opts) uses driver.exec/execTimed structurally (setup-gate.ts evidence). Dispatch calls the REAL setupGate for every driver (cast the structural surface, not the type). For fake boxes to genuinely pass assertions A–E, dispatch's fake-path fill must place the real files the gate probes (stamped manifest, delivered env file) — read tests/providers/exedev/setup-gate.test.ts BEFORE implementing to mirror exactly how DF2.2's own tests drive the gate, and read setup-gate.ts's assertion internals for what each item probes. If an assertion genuinely cannot be satisfied on fake hardware, surface that to the orchestrator — do NOT stub a ready verdict. Gate result.ready=false → FleetError exit 3 {code:"setup-gate-failed", assertionCode, failedItem, debugCommands, teardownCommand} — record stays OPEN with failure recorded in extensions (namespace: fanout is wrong — use a plain extensions write consistent with store's allow-listed namespaces; check run-record.ts EXTENSION_NAMESPACES and pick/add per its rules — if no namespace fits, record via store.set on existing fields + dispatch log line, and flag to orchestrator).

## C8. Fill paths — structural discrimination.
if driver has `.fill` method (ExeDevDriver extra) → fillExeDev(driver, vm, {runId, repoUrl, commitSha, ...FillOptions}) pinned-SHA clone path, manifest stamped BEFOREhand if it travels via fill files (read fill.ts to see whether manifest is among FillOptions files or placed separately). else (fake) → fillRun(driver, vm, BoxFile[]) with stamped manifest serialized + any files the gate probes. commitSha recorded via store.set in both paths if not already present.

## C9. Observability + guards (sketch omitted).
- Every verb logs via src/swarmclaw/log.ts log(): {requestId, runId (null when no run minted), verb, phase, timestamp, durationMs, exitStatus} — exitStatus ∈ EXIT_STATUSES imported from cli-anything/src/types.ts (first scripts/ consumer; import type only, no runtime dep).
- Sub-timings on dispatch: validate_ms, mint_ms, create_ms, fill_ms, setup_gate_ms in the log payload.
- 600_000ms wall clock around mint→gate; expiry → FleetError exit 1 {code:"dispatch-timeout"} — box left alive, record open (same posture as gate failure; remediation prints teardown command).
- INV-6 redaction: /(https?:\/\/[^\s]*[0-9a-zA-Z%-]{16,})/ applied to any URL-bearing string before logging; also never log key material (INV-4 — keyHash only).
- DF1.8 dispatch log: call the appendDispatchLog-style helper from issue-correlation.ts (read its exact export name) once per dispatch outcome.
- D9 confirmed: dispatch does NOT open the trace store / initiateSession (engine-side owns it).

## C10. Wave plan (locks who writes what — FTM-bound).
- Agent A: src/fleet/brief-schema.ts + tests/fleet/brief-schema.test.ts + additive src/phase-engine/manifest.ts edit (limitMicroUsd optional top-level + stampManifestLimit + serializeManifest) + manifest-stamp tests inside brief-schema.test.ts. MUST run gitnexus impact({target:"PipelineManifestSchema" or loadManifest, direction:"upstream"}) BEFORE the manifest.ts edit and include the blast-radius result in its report (repo CLAUDE.md mandate). Manifest.ts edit strictly additive — no existing export changes.
- Agent B: src/fleet/dispatch.ts + tests/fleet/dispatch.test.ts. Imports A's exports per spec (C1 sequence, C2 FleetError, C3 schema, C7 gate honesty, C8 fill discrimination, C9 observability).
- Agent C: src/fleet/verbs.ts + src/fleet/status.ts + tests/fleet/verbs.test.ts.
- Agent D (after A+B+C merge): src/fleet/index.ts + scripts/fleet.ts + tests/fleet/cli.test.ts + green-up + e2e demo dispatch→status→teardown (fake) capturing the three outputs for the Dev Agent Record.
