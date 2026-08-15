# DF1.4 trace-store API contract (authoritative for test + impl waves)

All modules live in `src/phase-engine/trace/`. Types already landed in
`src/phase-engine/types.ts` (DF1.4 region): `TraceEventType`, `PromptEventPayload`,
`TraceEventInput`, `TraceEventRow`, `EventPage`, `TraceSessionRow`.

## schema.ts

```ts
export const SCHEMA_DDL: readonly string[];        // 7x CREATE TABLE IF NOT EXISTS, in order:
                                                    // sessions, phases, events, envelopes,
                                                    // gate_results, processes, agent_sessions
export const SCHEMA_INDEX_DDL: readonly string[];  // additive CREATE [UNIQUE] INDEX IF NOT EXISTS
```

Column authority = story Technical Notes. Key points: every table has `request_id`;
`sessions` pk `request_id` (+ `total_cost` integer µ$ DD-9, `pipeline_name`, `archived INTEGER`);
`phases` pk `phase_id`, `status TEXT NOT NULL DEFAULT 'fail'`; `events` pk `event_id`,
`parent_id`, `payload_json`, `tokens`, `started_at`, `ended_at`; `envelopes` pk `envelope_id`,
`agent`, `output_type`, `payload_json`, `valid INTEGER`, `attempt`; `gate_results` autoinc pk,
`attempt`, `gate`, `passed INTEGER`, `violations_json`, `checks_json`; `processes` autoinc pk,
`kind`, `pid INTEGER`, `command`, `ended_at` (NULL = believed alive); `agent_sessions` pk
`(request_id, agent)`, `coding_agent`, `model`, `color`, `session_id`, `context_tokens`,
`context_window`.

## migrations.ts

```ts
export type Migration = readonly [table: string, column: string, decl: string];
export const MIGRATIONS: readonly Migration[]; // append-only, order-stable; every decl nullable/defaulted
export function applyMigrations(db: Database): void; // PRAGMA table_info + ALTER TABLE ADD COLUMN; throws on failure (INV-5 fail-closed)
```

## tracer.ts

```ts
export class TracerError extends Error; // name "TracerError"; carries { code, message, table?, statement? }

export interface TracerOptions {
  dataDir: string;      // run data dir; trace.db + events.jsonl live here
  requestId: string;
  pipelineName?: string;
  onTraceError?: (err: TracerError) => void; // failure-only structured log sink (success silent)
}

export class Tracer {
  constructor(options: TracerOptions); // creates dir 0700 (mkdir→chmod→verify), refuses path outside
                                       // data boundary (realpath containment, INV-1) by throwing;
                                       // opens writer: journal_mode=WAL, synchronous=NORMAL,
                                       // busy_timeout=5000, autocommit; applies SCHEMA_DDL +
                                       // SCHEMA_INDEX_DDL + MIGRATIONS before first write
  trace(event: TraceEventInput): void; // JSONL append+flush FIRST, then SQLite insert; SQLite
                                       // failure surfaces structured error via onTraceError and
                                       // NEVER throws to the run (AC5); sets events.jsonl mode 0600
  recordGateResult(e: { requestId: string; phaseId: string; attempt: number; gate: string;
    passed: boolean; violations: string[]; checks: { item: string; ok: boolean; note: string }[] }): void;
  recordEnvelope(e: { requestId: string; phaseId?: string; agent: string; outputType: string;
    payloadJson: string; valid: boolean; attempt: number }): void; // invalid attempts retained (valid=0)
  recordProcess(e: { requestId: string; kind: string; pid: number; command: string }): void;
  endProcess(e: { requestId: string; pid: number; endedAt: string }): void;
  processesEndAll(requestId: string): void; // ended_at = now for all NULL rows of that request
  startSession(e: { requestId: string; request: string; engineer?: string; pipelineName?: string }): void;
  finishSession(e: { requestId: string; status: string; durationMs?: number;
    totalTokens?: number; totalCostMicros?: number }): void;
  close(): void; // checkpoint WAL sidecars, chmod 0600 on db/-wal/-shm/events.jsonl, close
}
```

Constructor/open behavior: any configured db path that resolves outside the data boundary →
hard `TracerError` throw, no file created (INV-1).

## reader.ts

```ts
import type { Database } from "bun:sqlite";

export interface TraceReader {
  readEvents(requestId: string, cursor?: number, limit?: number): EventPage;
  readSession(requestId: string): TraceSessionRow | null;
  close(): void;
}

export function openTraceReader(dbPath: string): TraceReader;
// opens { readonly: true, create: false }; sets busy_timeout=5000, synchronous=NORMAL;
// ASSERTS journal_mode (reads it, warns when not WAL — never sets it);
// limit default 500, clamped to MAX_LIMIT=1000 before binding; non-integer or negative
// cursor throws; unknown/event-less requestId → { rows: [], cursor: <unchanged>, hasMore: false };
// optionalColumn probe: for a schema column not yet present, substitutes `NULL AS <column>`
// in SELECTs, re-probes per call until it appears, latches once seen.

export const MAX_LIMIT = 1000;
export const DEFAULT_LIMIT = 500;
```

## House conventions (from research)

- bun:test; temp dirs: `fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "df1-4-<x>-")))`,
  `afterAll(() => fs.rmSync(tmpRoot, { recursive: true, force: true }))`, per-test seq subdirs,
  `QDS_RUN_ROOT` env set in beforeEach / `delete` in afterEach.
- Error shape: `{ code, message, stack? }`; custom errors set `this.name`.
- Persisted strings route through existing redaction where they transit engine paths; tracer
  persists payload JSON as given (producers redact upstream — DF1.2 already redacts outputTail).
- Imports use explicit `.ts` extensions; tsconfig strict + noUncheckedIndexedAccess.
