# R1: DF1 Implemented Architecture Report

**Generated:** 2026-08-20
**Repo:** QDS-Factory-df3
**Mission:** Extract ACTUAL DF1 architecture to correct pre-dev DF3 story specs

---

## S1. Module Inventory

### Exported Symbols (phase-engine + gate)

**From `src/phase-engine/`:**

- `manifest.ts`:
  - `ManifestError` (class)
  - `PhaseSpecSchema` (zod schema)
  - `PhaseAgentSchema` (zod schema)
  - `PipelineManifestSchema` (zod schema)
  - `readArtifactBeneathRoot()` (function)
  - `ManifestTestSeams` (interface)
  - `LoadedManifest` (interface)
  - `requiredBudgetMs()` (function)
  - `loadManifest()` (function)
  - `loadManifestWithSeams()` (function)

- `usage.ts`:
  - `SendUsage` (interface)
  - `UsageBreakdown` (interface)
  - `usdFromMicros()` (function)
  - `UsageIntegrityError` (class)
  - `UsageAccumulator` (class)
  - GateCheck (type export)

- `index.ts`: re-exports from all submodules

- `types.ts`:
  - `ExitStatus` (type)
  - `MANIFEST_VERSION` (const: "1.0.0")
  - `PARSE_FIX_ATTEMPTS` (const: 2)
  - `MIN_RETRIES` (const: 0)
  - `MAX_RETRIES` (const: 5)
  - `DEFAULT_MAX_DURATION_MS` (const: 600000)
  - `MAX_MAX_DURATION_MS` (const: 900000)
  - `ROUTING_MARGIN_MS` (const: 5000)
  - `CANCEL_GRACE_MS` (const: 5000)
  - `PIPELINE_ID_PATTERN` (regex)
  - `MANIFEST_MAX_BYTES` (const: 1048576)
  - `MANIFEST_MAX_DEPTH` (const: 64)
  - `MIN_PHASES` (const: 2)
  - `sanitizeForMessage()` (function)
  - `formatZodIssue()` (function)
  - `descriptionDefect()` (function)
  - `PhaseKind` (type: "engineer" | "agent" | "code" | "dispatch_task")
  - `PhaseStatus` (type: "fail" | "success")
  - `PhaseAgent` (interface)
  - `PhaseSpec` (interface)
  - `PhaseParams` (interface)
  - `PipelineManifest` (interface)
  - `RunContext` (interface)
  - `PhaseSubTimings` (interface)
  - `PhaseRecord` (interface)
  - `GateEvent` (interface)
  - `RunOutcome` (interface)
  - `GateAttemptReport` (interface)
  - `PhaseAttemptRecord` (interface)
  - `InvalidEnvelopeRecord` (interface)
  - `AgentEndEvent` (interface)
  - `TraceEventType` (type union)
  - `PromptEventPayload` (interface)
  - `TraceEventInput` (interface)
  - `TraceEventRow` (interface)
  - `EventPage` (interface)
  - `TraceSessionRow` (interface)
  - `IssueRef` (interface)
  - `ResolvedRunCorrelation` (interface)
  - `RequestIdRepoMismatchError` (class)
  - `TracePhaseRow` (interface)
  - `CorrelatedRunRow` (interface)
  - `CorrelatedRunPage` (interface)
  - `TracePhasePage` (interface)

- `phase.ts`:
  - `PhaseConstructionError` (class)
  - `RunHaltedError` (class)
  - `PhaseOverflowError` (class)
  - `RunTerminatedError` (class)
  - `PhaseBodyContext` (interface)
  - `PhaseBody<T>` (type)
  - `PhaseOutcome<T>` (interface)
  - `assertLegibleDescription()` (function)
  - `RunOptions` (interface)
  - `FinishResult` (interface)
  - `Run` (class)
  - `PhaseBodyFactory` (type)
  - `walkPhases()` (function)

**From `src/gate/`:**
- (No direct exports found - gate types exported via phase-engine/index.ts)

### Directory Structure

**phase-engine subdirectories:**
- `phases/`: dispatch-task.ts, roster-adapter.ts, team-event-adapter.ts, test-results.ts
- `agents/`: envelope-parse.ts, retry.ts, session.ts
- `gates/`: command-gate.ts, library.ts, report.ts
- `envelopes/`: adapter.ts, types.ts
- `roster/`: schema.ts, validate.ts
- `trace/`: journal-bridge.ts, migrations.ts, pragmas.ts, reader.ts, schema.ts, tracer.ts

**scripts directory (first 30):**
```
build-image.ts
cap-hit-demo.ts
coms-smoke-test.ts
dev
generate-notice.ts
import-mulch-expertise.ts
install-gitnexus-plus.sh
lib
lsp-verify.ts
phase0-exit-gate.ts
pi-lens-verify.ts
pipeline-run.ts
provision-hindsight-banks.ts
roster-check.ts
run-record.ts
sandbox-reap.ts
sandbox-teardown.ts
```

### Cited-as → Actually-is Notes

**S1 Finding:** No `residentSpendCeilingMicros`, `maxSteeringIterations`, or `residentRssBytes` fields found in manifest types. The `PipelineManifest` interface only contains: `version`, `pipelineId`, `runBudgetMs`, `phases`.

---


## S2. DF1.1 Phase Engine + Manifest

### How a Run is Driven

**From `src/phase-engine/phase.ts`:**
- `Run` class (line 142) orchestrates phase execution
- Key methods:
  - `async finish(): Promise<FinishResult>` - Settles the run outcome
  - `async walkPhases()` function (line 454) - Walks through phases in order

### Manifest Format (Actual Field Names)

**`PipelineManifest` interface (types.ts:184-193):**
```typescript
export interface PipelineManifest {
  version: typeof MANIFEST_VERSION;  // "1.0.0"
  pipelineId: string;
  runBudgetMs: number;
  phases: PhaseSpec[];
}
```

**`PhaseSpec` interface (types.ts:154-172):**
```typescript
export interface PhaseSpec {
  name: string;
  kind: PhaseKind;  // "engineer" | "agent" | "code" | "dispatch_task"
  description: string;
  maxDurationMs: number;
  retries: number;
  command?: string[];        // Required iff kind === "code"
  testCommand?: string[];    // Optional; testsExecuted: false if absent
  roster?: string;           // Required iff kind === "dispatch_task"
  task?: string;             // Required iff kind === "dispatch_task"
}
```

### Scripts Invocation (pipeline-run.ts)

**CLI flags (from scripts/pipeline-run.ts:77-80, 360-440):**
- `--manifest <path>` - manifest to load (required)
- `--budget-ms <n>` - budget in milliseconds
- `--journal <path>` - journal destination (required)
- `--run-root <path>` - root for manifest reads (default: cwd)
- `--run-id <id>` - explicit run identifier
- `--repo-slug <owner/name>` - opts into issue-correlated mode (DF1.8)
- `--issue <n>` - GitHub issue number (requires --repo-slug)
- `--issue-url <url>` - optional issue URL

### Cited-as → Actually-is Notes

**CRITICAL DRIFT:**
1. `--brief` flag: **DOES NOT EXIST**. DF3.3/DF3.6 assume `--brief` exists.
2. `--no-resident` flag: **DOES NOT EXIST**. DF3.6 assumes this flag exists.
3. `--journal` flag: **EXISTS** (correctly cited)
4. `--manifest` flag: **EXISTS** (correctly cited)
5. Manifest fields:
   - `residentSpendCeilingMicros`: **DOES NOT EXIST** in PipelineManifest
   - `maxSteeringIterations`: **DOES NOT EXIST** in PipelineManifest
   - `residentRssBytes`: **DOES NOT EXIST** in PipelineManifest
   - Actual fields: `version`, `pipelineId`, `runBudgetMs`, `phases`

The `RunContext` interface does have an optional `effectiveCeilingMicros` field, but this is a **runtime context field** (set by DF3.1 dispatch), not a manifest field.

---


## S3. DF1.2 Gates/Envelopes

### Envelope Type (EnvelopeKind)

**From `src/phase-engine/envelopes/types.ts:34`:**
```typescript
export type EnvelopeKind = "generic" | "verify" | "review" | "changes";
```

**Envelope Interface (types.ts:40-54):**
```typescript
export interface Envelope {
  kind: EnvelopeKind;
  label: string;
  status: ExitStatus;  // "fail" | "success"
  summary: string;
  outputTail?: string;      // Tail of stdout+stderr, redacted (INV-2)
  artifacts?: string[];
  changedFiles?: string[];  // Claim of which files changed
  approved?: boolean;
}
```

### Gate Verdict Computation

**Gate Interface (gates/library.ts:33-39):**
```typescript
export interface Gate {
  name: string;
  run(envelope: Envelope | undefined, ctx: GateContext): GateReport | Promise<GateReport>;
}
```

**GateReport Class (gates/report.ts:21-56):**
- Constructor: private `#checks` array (no direct construction)
- `check(item, ok, note)`: Appends a GateCheck, returns this
- `passed` getter: `checks.length > 0 && violations.length === 0`
- `violations` getter: Derived from failed checks
- Each check is frozen at entry (INV-4 - immutable evidence)

**GateCheck Interface (report.ts:14-18):**
```typescript
export interface GateCheck {
  item: string;
  ok: boolean;
  note: string;
}
```

### What Would a DF3 Story Cite as "DF1.2 Gate Verdict"?

A DF3 story would cite the **`GateReport.passed`** property as the gate verdict.
- `passed === true`: All checks passed AND at least one check was performed
- `passed === false`: Either violations exist OR zero checks performed (INV-5)
- The verdict is DERIVED from checks, never directly set (INV-4)

**Cited-as → Actually-is:** The gate verdict is `report.passed` (boolean), computed from the checks array. Zero checks = failed gate (INV-5 hardening over SSSF original).

---


## S4. DF1.3 Retry Discipline

### Retry Bounds Location

**From `src/phase-engine/types.ts`:**
```typescript
export const PARSE_FIX_ATTEMPTS = 2;  // Line 27
export const MIN_RETRIES = 0;           // Line 30
export const MAX_RETRIES = 5;           // Line 31
```

**From `src/phase-engine/manifest.ts` (PhaseSpecSchema):**
- `retries` field: `z.number().int().min(MIN_RETRIES).max(MAX_RETRIES).default(MIN_RETRIES)`

### Dual Retry Loop (from `src/phase-engine/agents/retry.ts`)

**Loop Structure:**
- **Loop B (outer)** — gate retries, bounded by `PhaseParams.retries` (0..5)
- **Loop A (inner)** — parse fixes, bounded by `PARSE_FIX_ATTEMPTS` (constant = 2)
- Send ceiling: `(retries + 1) × (PARSE_FIX_ATTEMPTS + 1)`

**Error Classes:**
```typescript
export class EnvelopeParseExhausted extends Error {
  constructor(
    message: string,
    readonly invalidRecords: InvalidEnvelopeRecord[],
  )
}
```

**Exported Function:**
```typescript
export async function runAgentPhase(opts: AgentPhaseOptions): Promise<AgentPhaseResult>
```

**Exhaustion Behavior:**
- Loop A exhausted → raises `EnvelopeParseExhausted`
- Loop B exhausted → raises `GateFailureError` (DF1.2)
- Both result in phase status `fail` via default-fail branch (INV-5)

**Cited-as → Actually-is:** Parse retry bound is a constant (`PARSE_FIX_ATTEMPTS = 2`), NOT a manifest field. Gate retry bound is `PhaseParams.retries` (0-5), validated at construction.

---


## S5. DF1.4 Trace Store

### 7 Table Names (from `src/phase-engine/trace/schema.ts`)

```typescript
export const SCHEMA_DDL: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS sessions (...)`,
  `CREATE TABLE IF NOT EXISTS phases (...)`,
  `CREATE TABLE IF NOT EXISTS events (...)`,
  `CREATE TABLE IF NOT EXISTS envelopes (...)`,
  `CREATE TABLE IF NOT EXISTS gate_results (...)`,
  `CREATE TABLE IF NOT EXISTS processes (...)`,
  `CREATE TABLE IF NOT EXISTS agent_sessions (...)`,
]
```

### WAL Mode

**From `src/phase-engine/trace/reader.ts:4-5`:**
- Readonly reader opens with `readonly=true`
- Asserts WAL journal mode
- WAL crash recovery tests in reader.test.ts

### Rowid-Cursor Read API Names

**From `src/phase-engine/trace/reader.ts`:**
```typescript
interface TraceReader {
  // Event pagination
  readEvents(requestId: string, cursor?: number, limit?: number): EventPage;
  
  // Phase pagination
  readRunPhases(requestId: string, cursor?: number, limit?: number): TracePhasePage;
  
  // DF1.8 correlation
  readRunsByIssue(repoSlug: string, issueId: number, cursor?: number, limit?: number): CorrelatedRunPage;
}
```

**Cursor Rule (reader.ts:150-153, 228-229):**
- Must be non-negative integer
- Throw `Error("cursor must be a non-negative integer")` if invalid
- Capped at `MAX_LIMIT` (default 1000)

### DB Path Convention

**From `scripts/pipeline-run.ts`:**
- Trace store claims `<QDS_RUN_ROOT>/trace` (0700)
- Matches terminal marker's location: `/run` in container, `QDS_RUN_ROOT` on dev/CI

**Cited-as → Actually-is:** Trace store path is `<run-root>/trace`, not a separate configurable path.

---


## S6. DF1.5 Roster

### Config Shape (ResolvedRoster)

**From `src/phase-engine/roster/schema.ts:66-72`:**
```typescript
export interface ResolvedRoster {
  roles: ResolvedRole[];
  defaults: Partial<ResolvedRole>;
}

export interface ResolvedRole {
  name: string;
  model: string;        // Model id VERBATIM
  provider: string;     // Authoritative provider id
  thinking: ThinkingLevel;  // "off" | "minimal" | "low" | "medium" | "high" | "xhigh"
  tools: string[] | null;     // null = every tool usable
  writes: string[] | null;    // null = unrestricted, [] = no repo writes
  harness_engineering: string[];  // -e extension paths
  slug: string;         // `${provider}/${model}`
}
```

**Constants:**
- `ROSTER_MAX_BYTES = 256 * 1024` (schema.ts:44)
- `THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh"]` (schema.ts:40)

### Writes List

**From `src/phase-engine/roster/schema.ts:56-57`:**
- `writes: string[] | null`
- `null` = unrestricted repo writes
- `[]` = no repo writes
- Must be declared explicitly (in `defaults` or per role) - schema.ts:22-23

### Dual Slug Validation

**From `src/phase-engine/roster/validate.ts:4-11`:**
Every resolved slug goes through TWO independent gates:
1. pi's merged catalog (`pi --list-models`)
2. The provider's live model list (OpenRouter `GET /api/v1/models`)

**Exported Functions (validate.ts):**
```typescript
export function validateRoster(roster: ResolvedRoster, deps: ValidateDeps): Promise<RosterReport>
export function loadBundledCatalog(dir?: string): RateTable
export function loadRateSources(): RateSources
export function readCustomRegistry(path?: string): CustomRegistry
```

**Cited-as → Actually-is:** Dual slug validation is real - both pi catalog AND provider live list must pass. Exit codes: 0 (all pass), 1 (at least one rejected), 2 (gate error).

---


## S7. DF1.6 + DF2.7 Session & Cost Instrumentation

### Session Naming

**From `src/phase-engine/agents/session.ts`:**
- `SessionCache` class manages session caching
- Session IDs generated via `idFactory()` callback
- Key format: `${requestId}:${agent}` (see `key` computation in get/set methods)
- `sessionId` returned from cache (line 54-56)

### Session-Cumulative Cost Instrumentation

**Location:** `src/phase-engine/usage.ts`

**SendUsage Interface (line 31-38):**
```typescript
export interface SendUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  reasoningTokens?: number;
  costMicros: number;  // Integer µ$ (DD-9)
}
```

**UsageBreakdown Interface (line 40-48):**
```typescript
export interface UsageBreakdown {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  reasoningTokens: number;
  costMicros: number;  // Integer µ$ — phase-engine's only cost unit (DD-9)
  sends: number;
}
```

**UsageAccumulator Class:**
- Monotonic across all sends of a phase (INV-3)
- Retried phase reports full multi-send spend
- `costMicros` accumulated via `this.#spent.costMicros += usage.costMicros`

**Cost Event Shape/Units:**
- Unit: **integer µ$** (microdollars) - DD-9, INV-3
- Only conversion: `usdFromMicros(micros / 1_000_000)` at phase-engine → runner boundary
- `reasoningTokens` is thinking share of OUTPUT, never a fifth component

**Cited-as → Actually-is:** Cost unit is integer µ$ throughout phase-engine. USD conversion happens only at runner boundary via `usdFromMicros()`.

---


## S8. DF1.8 Issue Correlation

### resolveRunCorrelation Real Signature + Semantics

**From `src/phase-engine/issue-correlation.ts:85-133`:**
```typescript
export function resolveRunCorrelation(
  brief: IssueRef & { requestId?: string },
): ResolvedRunCorrelation
```

**Parameters (IssueRef + optional requestId):**
- `repoSlug`: string (validated against `REPO_SLUG_PATTERN`)
- `issueId`: number (validated: positive integer ≤ `MAX_ISSUE_ID = 2^31 - 1`)
- `issueUrl`: string | null (optional, defaults to null)
- `requestId`: string | undefined (optional, must be strict UUID v4 if provided)

**Returns (ResolvedRunCorrelation):**
```typescript
{
  requestId: string,      // Supplied UUID v4 or randomUUID()
  repoSlug: string,       // Trimmed and validated
  issueId: number,        // Validated
  issueUrl: string | null // Provided or null
}
```

**Semantics:**
- **PURE function**: no fs, no db, no network
- Refusal happens before any session row/box/key exists (AC2/INV-RUN-4)
- Generates requestId via `randomUUID()` if not provided
- Validates supplied requestId against strict UUID v4 pattern

**Error Classes:**
```typescript
export class CorrelationError extends Error {
  name = "CorrelationError";
  code: "INVALID_REPO_SLUG" | "INVALID_ISSUE_ID" | "INVALID_REQUEST_ID";
}
```

### readRunsByIssue

**From `src/phase-engine/trace/reader.ts`:**
```typescript
readRunsByIssue(
  repoSlug: string,
  issueId: number,
  cursor?: number,
  limit?: number,
): CorrelatedRunPage
```

**Pagination:** Uses same cursor pattern as `readEvents` (rowid-based)

### (repoSlug, issueId) Replay Contract

**Validation Patterns:**
- `REPO_SLUG_PATTERN = /^[A-Za-z0-9._-]{1,100}\/[A-Za-z0-9._-]{1,100}$/`
- `UUID_V4_PATTERN` for requestId validation
- Issue ID range: 1 to `2^31 - 1` (GitHub issue number constraint)

**Cited-as → Actually-is:** Issue correlation uses strict UUID v4 for requestId, not just any UUID. Issue ID is bounded to int32 max (GitHub constraint). Repo slug pattern is owner/name with 1-100 char segments.

---


## S9. Cross-Cutting

### src/index.ts Exports

**From `src/index.ts`:**
```typescript
export { createServer } from "./swarmclaw/index.ts";
export type { SwarmClawServer } from "./swarmclaw/index.ts";
```

**Note:** Main index is minimal - exports only swarmclaw server. Phase-engine exports from its own index.ts.

### CLI Arg Helpers

**Finding:** No `tokenizeArgs` or `rejectStraySingleDash` functions found in codebase.
- Pipeline CLI uses direct `switch` statement on flags in `pipeline-run.ts`
- No generalized CLI arg parsing library found

**Cited-as → Actually-is:** CLI parsing is manual per-script, not via shared helpers.

### Test Fixture Conventions

**From `tests/phase-engine/fixtures/`:**
- `dispatch-roster.yaml` - YAML roster files
- `dispatch-task-ndjson.jsonl` - NDJSON task data
- `pipeline.qds-factory.json` - JSON manifest
- `review-envelopes.json` - JSON envelope test data
- `test-command-output.ts` - TypeScript test fixtures

### Naming Conventions

**URL-safe Base64 IDs:**
- `randomBytes(12).toString("base64url")` in `tracer.ts:84, 140`
- Used for event_id, phase_id, envelope_id generation

**µ$ (Microdollar) Integer Conventions:**
- `costMicros` - integer µ$ throughout (usage.ts, types.ts)
- `usdFromMicros(micros / 1_000_000)` - only conversion at boundary
- `MIN_NONZERO_MICROS_PER_MTOK` - rate validation floor
- `MAX_MICROS_PER_MTOK` - rate validation ceiling
- Comments use "µ$" notation (e.g., `µ$/MTok`)

**Cited-as → Actually-is:** Microdollar convention is real (`costMicros`), IDs use base64url encoding (12 bytes → 16 chars).

---

## Summary: Biggest Drifts from DF3 Pre-Dev Assumptions

### Critical Drifts (BLOCK DF3.3/DF3.6):

1. **`--brief` flag: DOES NOT EXIST**
   - DF3.3/DF3.6 assume `--brief` CLI flag exists
   - Actual: No such flag in `pipeline-run.ts`
   - DF1.8 uses `--repo-slug`/`--issue`/`--issue-url` instead

2. **`--no-resident` flag: DOES NOT EXIST**
   - DF3.6 assumes this flag exists
   - Actual: No resident mode flag found

3. **Manifest Field Drifts:**
   - `residentSpendCeilingMicros`: NOT in PipelineManifest
   - `maxSteeringIterations`: NOT in PipelineManifest
   - `residentRssBytes`: NOT in PipelineManifest
   - Actual fields: `version`, `pipelineId`, `runBudgetMs`, `phases`
   - `effectiveCeilingMicros` exists in RunContext (runtime, not manifest)

4. **Parse Retry Bound:**
   - Assumed: Manifest field
   - Actual: Constant `PARSE_FIX_ATTEMPTS = 2` in types.ts

5. **CLI Helpers:**
   - Assumed: Shared `tokenizeArgs`/`rejectStraySingleDash` functions
   - Actual: Manual per-script switch statements

### Minor Drifts:

6. **Cost Unit Throughout:**
   - Assumed: May have USD in engine
   - Actual: Integer µ$ everywhere, USD only at runner boundary

7. **UUID Validation:**
   - Assumed: Any UUID format
   - Actual: Strict UUID v4 pattern enforced

8. **Gate Verdict Computation:**
   - INV-5 hardening: Zero checks = failed gate (SSCF original passed vacuously)

**Report Path:** /Users/steve/QDS-Factory-df3/_bmad-output/workflow-state/qds-sprint-planning/df3-hardening/research/R1-df1-implemented-architecture.md
