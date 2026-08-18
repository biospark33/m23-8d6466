# DF1.8 Locked Implementation Contract

Single source of truth for DF1.8 test + impl agents. Any divergence = bug.
Story: `_bmad-output/sprint-artifacts/dark-factory-v5/stories/df1-8-run-capture-issue-correlation.md`

## File ownership (story "Files to Modify" — no other src file may change)

- `src/phase-engine/issue-correlation.ts` (NET-NEW)
- `src/phase-engine/trace/migrations.ts` (append 3 entries)
- `src/phase-engine/trace/schema.ts` (append 1 index DDL)
- `src/phase-engine/trace/reader.ts` (append 2 methods)
- `src/phase-engine/trace/tracer.ts` (append `initiateSession` method)
- `src/phase-engine/types.ts` (append DF1.8 region at end)
- `scripts/pipeline-run.ts` (flags + wiring)
- Tests: `tests/phase-engine/issue-correlation.test.ts` (net-new),
  `tests/phase-engine/trace/reader.test.ts` (extend),
  `tests/phase-engine/pipeline-run.test.ts` (extend)

NOT touched: `src/phase-engine/index.ts`, `trace/journal-bridge.ts`, `phases/dispatch-task.ts`,
`types.ts` sibling regions (DF1.1/1.2/1.3/1.4), existing MIGRATIONS/SCHEMA_INDEX_DDL entries.

## types.ts — DF1.8 region (append at file end, banner comment like DF1.4's)

```ts
// ---------------------------------------------------------------------------
// DF1.8 region: issue-correlation types. Append-only — adds the
// (repoSlug, issueId) correlation shape, the resolved-requestId result type,
// and the correlated reader row/page types. No sibling declaration is edited.
// ---------------------------------------------------------------------------

/** The dispatch brief's issue reference. `issueUrl` optional (derivable from slug+id). */
export interface IssueRef {
  repoSlug: string;
  issueId: number;
  issueUrl?: string;
}

/** Correlation settled once at dispatch: requestId resolved, pair validated. */
export interface ResolvedRunCorrelation {
  requestId: string;
  repoSlug: string;
  issueId: number;
  issueUrl: string | null;
}

/** A row of `phases` as returned by the correlated reader, with the phase's
 *  latest persisted envelope payload (its "persisted output") or null. */
export interface TracePhaseRow {
  rowid: number;
  phase_id: string;
  request_id: string;
  seq: number | null;
  name: string | null;
  kind: string | null;
  owner: string | null;
  description: string | null;
  status: string;
  attempt: number | null;
  retries: number | null;
  error: string | null;
  started_at: string | null;
  ended_at: string | null;
  output_payload_json: string | null;
}

/** One correlated run as returned by readRunsByIssue: session fields + phases. */
export interface CorrelatedRunRow {
  rowid: number;
  request_id: string;
  request: string | null;
  status: string | null;
  started_at: string | null;
  ended_at: string | null;
  duration_ms: number | null;
  total_tokens: number | null;
  total_cost: number | null;
  pipeline_name: string | null;
  repo_slug: string;
  issue_id: number;
  issue_url: string | null;
  phases: TracePhaseRow[];
}

export interface CorrelatedRunPage {
  rows: CorrelatedRunRow[];
  cursor: number;
  hasMore: boolean;
}

export interface TracePhasePage {
  rows: TracePhaseRow[];
  cursor: number;
  hasMore: boolean;
}
```

`TraceSessionRow` (DF1.4's) is NOT edited — DF1.8's reader returns `CorrelatedRunRow`.

## migrations.ts — append AFTER the `["sessions", "archived", "INTEGER DEFAULT 0"]` entry

```ts
["sessions", "repo_slug", "TEXT"],
["sessions", "issue_id", "INTEGER"],
["sessions", "issue_url", "TEXT"],
```

## schema.ts — SCHEMA_INDEX_DDL append (after idx_events_request_event)

```sql
CREATE UNIQUE INDEX IF NOT EXISTS idx_sessions_repo_request
ON sessions (repo_slug, request_id)
```

## issue-correlation.ts (NET-NEW)

```ts
export const REPO_SLUG_PATTERN = /^[A-Za-z0-9._-]{1,100}\/[A-Za-z0-9._-]{1,100}$/;
export const UUID_V4_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{4}-[0-9a-f]{12}$/i;
export const MAX_ISSUE_ID = 2 ** 31 - 1;

export class CorrelationError extends Error {
  name = "CorrelationError";
  code: string;  // "INVALID_REPO_SLUG" | "INVALID_ISSUE_ID" | "INVALID_REQUEST_ID"
  constructor(code: string, message: string) { super(message); this.code = code; }
}

export class RequestIdRepoMismatchError extends Error {
  name = "RequestIdRepoMismatchError";
  code = "REQUEST_ID_REPO_MISMATCH";
  requestId: string;
  existingRepoSlug: string;
  attemptedRepoSlug: string;
  // message MUST name both slugs
}

export function isValidUuidV4(value: string): boolean;
export function resolveRunCorrelation(brief: IssueRef & { requestId?: string }): ResolvedRunCorrelation;
```

`resolveRunCorrelation` semantics:
- `repoSlug`: trim-nonempty + must match `REPO_SLUG_PATTERN`, else throw `CorrelationError("INVALID_REPO_SLUG", ...)`.
- `issueId`: `Number.isInteger` && `> 0` && `<= MAX_ISSUE_ID`, else `CorrelationError("INVALID_ISSUE_ID", ...)`.
- `requestId` present: must match `UUID_V4_PATTERN` (strict v4), else `CorrelationError("INVALID_REQUEST_ID", ...)`. Absent/undefined → `crypto.randomUUID()`.
- Returns `{ requestId, repoSlug, issueId, issueUrl: brief.issueUrl ?? null }`.
- PURE: no fs, no db, no network. Refusal happens before any session row, box or key.

```ts
export function appendDispatchFailure(
  logPath: string,
  entry: { repoSlug: string; issueId: number; requestId: string | null; code: string; message: string },
): void;
```
- Appends one JSON line `{ timestamp: <iso>, repoSlug, issueId, requestId, code, message }`.
- Never prompt content. File mode 0600 (open "a" 0o600; chmod+verify), parent dir mkdir 0700 if missing.
- Must succeed when the trace store could not even open (AC4). Throws on hard fs failure (caller logs to stderr then exits 2).

## tracer.ts — append method (keep every existing method byte-identical)

```ts
/**
 * DF1.8 correlated session initiation. UNLIKE the sidecar write methods (AC5),
 * this is an initiation GATE and throws by design: a RequestIdRepoMismatch
 * refusal must stop the run before a box or key is minted, not be swallowed
 * as a trace error. Documented deviation from the per-write AC5 contract.
 */
initiateSession(e: {
  correlation: ResolvedRunCorrelation;
  request: string;
  engineer?: string;
  pipelineName?: string;
}): { requestId: string; runId: string; replayed: boolean };
```

Semantics (single `db.transaction(...).immediate()` round):
1. `SELECT repo_slug FROM sessions WHERE request_id = ?` (bound).
2. Row found:
   - `repo_slug === correlation.repoSlug` → return `{ requestId, runId: requestId, replayed: true }` (no writes).
   - `repo_slug === null` (bare DF1.4 row) → `UPDATE sessions SET repo_slug=?, issue_id=?, issue_url=? WHERE request_id=?` (the one and only write of these columns — INV-RUN-2 fill-once) → `{..., replayed: true}`.
   - else → throw `RequestIdRepoMismatchError` naming both slugs (existing first). Transaction rolls back; no row written, no second row.
3. No row → `INSERT INTO sessions (request_id, request, status, engineer, started_at, pipeline_name, repo_slug, issue_id, issue_url) VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?) ON CONFLICT(request_id) DO NOTHING` (all bound).
   - `changes === 1` → `{ requestId, runId: requestId, replayed: false }`.
   - `changes === 0` (racing writer won) → re-SELECT and apply step-2 logic once.
4. `runId` is ALWAYS the resolved requestId — no second identifier. Idempotency = `request_id` PK; the composite unique index only backs the AC2 query path.

## reader.ts — TraceReader interface + impl additions

```ts
readRunsByIssue(repoSlug: string, issueId: number, cursor?: number, limit?: number): CorrelatedRunPage;
readRunPhases(requestId: string, cursor?: number, limit?: number): TracePhasePage;
```

- Cursor validation + limit capping IDENTICAL to `readEvents` (non-negative-integer cursor else throw; trunc → min MAX_LIMIT, non-positive/non-finite → DEFAULT_LIMIT).
- `readRunsByIssue`: `SELECT rowid, request_id, request, status, started_at, ended_at, duration_ms, total_tokens, <optionalColumn probes: total_cost, pipeline_name, repo_slug, issue_id, issue_url> FROM sessions WHERE repo_slug = ? AND issue_id = ? AND rowid > ? ORDER BY rowid LIMIT ?`. Then one second query fetches `readRunPhases`-shaped rows for the page's request_ids (`WHERE request_id IN (...) AND rowid > 0` — same join) and groups them onto rows. Page shape: `cursor` = last rowid or prior cursor; `hasMore = rows.length === cappedLimit`. Empty page → `{ rows: [], cursor: Math.max(0, cursor), hasMore: false }` — NOT an error.
- `readRunPhases`: phases rows + `output_payload_json` = the phase's LATEST-attempt envelope payload:
  `LEFT JOIN envelopes en ON en.request_id = phases.request_id AND en.phase_id = phases.phase_id AND en.attempt = (SELECT MAX(e2.attempt) FROM envelopes e2 WHERE e2.request_id = en.request_id AND e2.phase_id = en.phase_id)` selecting `en.payload_json AS output_payload_json`. rowid-cursor paging on `phases.rowid`, same page shape.
- There is deliberately NO reader method taking `issueId` alone (INV-RUN-3). All values bound parameters.

## pipeline-run.ts wiring

- New flags: `--repo-slug`, `--issue`, `--issue-url` — explicit `case` entries BEFORE the existing `default:` (which catches `--request-id`). Add to `flags` array + HELP text.
- Correlated mode (`--repo-slug` parsed):
  - `--issue` required; strict parse `/^\d+$/` then int bounds (1..MAX_ISSUE_ID) — refuse otherwise.
  - `--issue` without `--repo-slug` (or vice versa): refusal — correlation is a pair, never defaulted. (Bare mode = NO flags at all, unchanged.)
  - explicit `--run-id` together with `--repo-slug`: refusal — "no second identifier".
  - `resolveRunCorrelation({...})` timed → `correlation_resolve_ms`.
  - `runId = requestId = resolved.requestId`.
- Order in `main`: flags → manifest load → (correlated? resolve) → trace dir claim → `new Tracer(...)` → (correlated? `tracer.initiateSession(...)` timed → `session_upsert_ms`, replacing the old `tracer.startSession` call) → rest unchanged. Bare mode keeps `tracer.startSession` exactly as today.
- Failure ladder (correlated mode only), each BEFORE any box/key (none exist yet in this script) and each ending `exit 2`:
  1. `resolveRunCorrelation` throws → `appendDispatchFailure(<markerRoot>/dispatch-failures.log, ...)` + stderr JSON `{ level: "error", event: "dispatch_failed", runId: null, requestId: <resolved-or-null>, repoSlug, issueId, error: { code, message } }`.
  2. Trace open throws (Tracer constructor / dir claim) → same sink. Log survives (parent dir exists).
  3. `initiateSession` throws `RequestIdRepoMismatchError` → same sink (code `REQUEST_ID_REPO_MISMATCH`).
  - `appendDispatchFailure` itself failing → stderr line, still exit 2. Never a fabricated runId.
- Success (correlated): stderr JSON `{ level: "info", event: "run_initiated", runId, requestId, repoSlug, issueId, replayed, correlation_resolve_ms, session_upsert_ms }`.
- Phase-transition state events (correlated path only): the body factory wraps each phase body — on start `tracer.trace({ type: "log", name: "phase_state", ... payloadJson: { runId, repoSlug, issueId, requestId, phase: spec.name, status: "start", timestamp, durationMs: 0, exitStatus: null } })`; on settle same with `status: "end"`, measured `durationMs`, `exitStatus: <value.exitStatus if present else null>`. (Observability contract + p1-8:34 surviving field set; lives entirely in pipeline-run.ts — no engine edits.)
- `ExitStatus` import discipline: import from `../src/phase-engine/types.ts` re-export; a grep for literal `'success' | 'transient'` in DF1.8 files must be empty.

## Conventions (from DF1.4/DF1.6 review rounds — non-negotiable)

- bun:test; temp dirs `fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "df1-8-<name>-")))`, cleaned in afterAll; QDS_RUN_ROOT set per-test where Tracer is used (tracer boundary check honours it).
- Fail-closed on invalid input; no `as any` (typed row generics on db.query); deterministic tests (no sleeps, bounded polls); integer guards (Number.isInteger / safe bounds); negative controls that FAIL against a plausible wrong impl (fresh-id-in-one-phase fixture MUST fail the chain check).
- All SQL parameterized except inlined identifiers (existing migrations.ts pattern).
- Tests import straight from src files (`../../src/phase-engine/...`), not the engine barrel.
- pipeline-run tests spawn: `Bun.spawn({ cmd: [process.execPath, RUNNER, ...args], env: { ...process.env, QDS_RUN_ROOT: markerRoot } })` — existing pattern in tests/phase-engine/pipeline-run.test.ts.
