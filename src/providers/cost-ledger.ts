/**
 * The micro-dollar cost ledger (DF2.8).
 *
 * Host-side SQLite beside the run records, so it survives box destruction
 * (§6 item 4). One append-only row per DF2.7 `cost` event, keyed by a
 * deterministic digest: a redelivered line digests identically and lands on
 * `INSERT … ON CONFLICT DO NOTHING`, never an update. Money is integer
 * micro-dollars everywhere (DD-9); the one float→µ$ conversion happens here at
 * ingest and nowhere else. Per-issue spend is always `SUM(cost_micro_usd)`
 * over priced rows — derived on demand, never denormalized (INV-COST-2) — and
 * the gate reads that same SUM inside a BEGIN IMMEDIATE admission
 * transaction, because a bare read-and-compare is a TOCTOU two concurrent
 * dispatches can both win (R2 §6 serialized-admission mandate).
 *
 * The float accumulator this design exists to NOT be: inkwell's tracer keeps
 * `total_cost REAL` and does `total_cost = total_cost + ?` per turn (tracer.py
 * session_add_usage) — mutable, drift-prone, and unattributable. Every figure
 * here is recomputed from immutable rows instead.
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { dirname } from "node:path";

import { Database } from "bun:sqlite";

import type { CostEvent } from "../../cli-anything/src/types.ts";
import { log } from "../swarmclaw/log.ts";

// ─── units ───────────────────────────────────────────────────────────────────

const MICRO_PER_USD = 1_000_000;
const MS_PER_HOUR = 3_600_000;

/**
 * How long an admission counts toward `reservedMicroUsd` before a missing run
 * record is read as "never created" rather than "not created yet".
 *
 * Dispatch admits BEFORE `store.create` (INV-COST-3), so between the admission
 * COMMIT and the record appearing on disk there is a real interval in which
 * that reservation resolves to no record. Without a floor on the interval, two
 * concurrent dispatches for one issue each see the other's reservation as an
 * orphan, each skip it, and both are granted the full remaining headroom — the
 * cap exceeded by design gap, not by rounding.
 *
 * The path between the two is a `ledger.close()`, a handful of integer checks
 * and `store.create`'s couple of syscalls: single-digit milliseconds, low
 * hundreds on a loaded host. 60s is ~1000× that, because the two error
 * directions are not symmetric — too short double-allocates real money, too
 * long merely holds a genuinely orphaned reservation against the cap for one
 * minute. Over-reserving is the fail-safe direction INV-COST-6 takes
 * everywhere else. Deliberately not configurable: a deployment tuning this
 * number is tuning its own odds of overspending.
 *
 * Exported for tests ONLY so the grace-window assertions derive their ages from
 * the real value instead of mirroring the literal — a mirrored copy lets the
 * window be retuned to a value that under-protects against the dispatch race
 * with every test still green. Not a config knob: nothing reads it but this file.
 */
export const ADMISSION_GRACE_MS = 60_000;

/**
 * Clock-skew slack added to the grace window before an admission can expire.
 *
 * `decided_at` is a FOREIGN wall clock — whichever host dispatched wrote it —
 * compared against the reader's own. A reader running ahead of the writer (NTP
 * step, VM resume, container drift) sees a live in-flight reservation as aged,
 * skips it as an orphan, and hands the same headroom out a second time: the
 * exact double allocation the grace window exists to prevent, and the one
 * direction of skew that fails OPEN. The expiry therefore fires only once a row
 * is older than the grace window by more skew than a clock plausibly carries.
 * Skew the other way is already safe: a future-dated row is younger than any
 * cutoff, so it counts. The schema carries no local-origin timestamp to compare
 * against instead (gate_admissions is append-only, so it cannot acquire one for
 * rows already written), which is why this is a clamp and not a better clock.
 *
 * The price is only how long a genuinely orphaned reservation (store.create
 * failed, so no run can ever report spend) wedges its issue: ~6 minutes rather
 * than ~1. The price of the other mistake is spending the cap twice, so the
 * slack buys in the fail-safe direction (INV-COST-6).
 *
 * Exported for tests ONLY, on the same reasoning as ADMISSION_GRACE_MS.
 */
export const ADMISSION_SKEW_MARGIN_MS = 300_000;

/** DD-9: float USD exists only on DF2.7's wire; converted once, here, half-up. */
/** DD-9: float USD exists only on DF2.7's wire; converted once, here, half-up. */
function usdToMicros(usd: number): number {
  if (!Number.isFinite(usd)) {
    throw new CostLedgerError("cost-convert-invalid", `costUsd must be finite (got ${usd})`, "fix the producer's cost event");
  }
  const micros = usd * MICRO_PER_USD;
  if (!Number.isSafeInteger(micros)) {
    throw new CostLedgerError("cost-convert-invalid", `costUsd ${usd} × 1e6 exceeds safe integer range (${micros})`, "fix the producer's cost event");
  }
  return Math.round(micros);
}

// ─── schema ──────────────────────────────────────────────────────────────────

/**
 * `event_id` is a sha256 over the event's stable fields — stable across
 * redelivery, distinct from the ingest-time `created_at`. Two digests exist:
 * token rows digest `run_id, agent_id, kind, invocation_seq, turn_count,
 * cost_micro_usd, timestamp` (the WIRE event's emission time); box-hour rows
 * digest `run_id, kind='box_hours', closed_at` (the record's own close
 * timestamp, fixed once close runs). `invocation_seq` is what keeps two genuine
 * invocations of one agent in one run from ever digesting identically — DF2.7
 * emits one `cost` event per pi subprocess, and keying on
 * `(run_id, agent_id, kind)` would silently drop the second one.
 */
function tokenEventId(input: {
  runId: string;
  agentId: string;
  invocationSeq: number;
  turnCount: number;
  costMicroUsd: number;
  timestamp: string;
}): string {
  const h = new Bun.CryptoHasher("sha256");
  h.update(`${input.runId}|${input.agentId}|tokens|${input.invocationSeq}|${input.turnCount}|${input.costMicroUsd}|${input.timestamp}`);
  return h.digest("hex");
}

function boxHoursEventId(runId: string, closedAt: string): string {
  const h = new Bun.CryptoHasher("sha256");
  h.update(`${runId}|box_hours|box_hours|${closedAt}`);
  return h.digest("hex");
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS cost_events (
  event_id           TEXT PRIMARY KEY,
  run_id             TEXT NOT NULL,
  repo_slug          TEXT NOT NULL,
  issue_id           TEXT NOT NULL,
  request_id         TEXT NOT NULL,
  role               TEXT CHECK (role IN ('lead','worker','resident','tier1')),
  agent_id           TEXT,
  provider           TEXT,
  model              TEXT,
  kind               TEXT NOT NULL CHECK (kind IN ('tokens','box_hours')),
  invocation_seq     INTEGER NOT NULL,
  input_tokens       INTEGER,
  output_tokens      INTEGER,
  cache_read_tokens  INTEGER,
  cache_write_tokens INTEGER,
  turn_count         INTEGER,
  cost_micro_usd     INTEGER NOT NULL,
  unpriced           INTEGER NOT NULL DEFAULT 0,
  key_hash           TEXT,
  key_limit_micro_usd INTEGER,
  created_at         TEXT NOT NULL
) STRICT;
CREATE INDEX IF NOT EXISTS cost_events_issue ON cost_events (repo_slug, issue_id, unpriced);
CREATE INDEX IF NOT EXISTS cost_events_run ON cost_events (run_id);
CREATE TRIGGER IF NOT EXISTS cost_events_no_update
BEFORE UPDATE ON cost_events
BEGIN SELECT RAISE(ABORT, 'cost_events is append-only (INV-COST-1)'); END;
CREATE TRIGGER IF NOT EXISTS cost_events_no_delete
BEFORE DELETE ON cost_events
BEGIN SELECT RAISE(ABORT, 'cost_events is append-only (INV-COST-1)'); END;

CREATE TABLE IF NOT EXISTS gate_admissions (
  request_id        TEXT NOT NULL,
  run_id            TEXT NOT NULL,
  repo_slug         TEXT NOT NULL,
  issue_id          TEXT NOT NULL,
  ceiling_micro_usd INTEGER NOT NULL,
  decided_at        TEXT NOT NULL,
  PRIMARY KEY (request_id, run_id)
) STRICT;
CREATE INDEX IF NOT EXISTS gate_admissions_issue ON gate_admissions (repo_slug, issue_id);
CREATE TRIGGER IF NOT EXISTS gate_admissions_no_update
BEFORE UPDATE ON gate_admissions
BEGIN SELECT RAISE(ABORT, 'gate_admissions is append-only (INV-COST-1)'); END;
CREATE TRIGGER IF NOT EXISTS gate_admissions_no_delete
BEFORE DELETE ON gate_admissions
BEGIN SELECT RAISE(ABORT, 'gate_admissions is append-only (INV-COST-1)'); END;
`;

// ─── errors ──────────────────────────────────────────────────────────────────

export class CostLedgerError extends Error {
  /** Machine-readable failure class; also the `code` in every log line. */
  readonly code: string;
  /** The literal next command, secrets referenced by env-var NAME, never expanded. */
  readonly remediation: string;

  constructor(code: string, message: string, remediation: string) {
    super(message);
    this.name = "CostLedgerError";
    this.code = code;
    this.remediation = remediation;
  }
}

export class CostConfigError extends CostLedgerError {
  constructor(code: string, message: string, remediation: string) {
    super(code, message, remediation);
    this.name = "CostConfigError";
  }
}

// ─── config ──────────────────────────────────────────────────────────────────

export interface CostConfig {
  /** Default per-issue spend cap, µ$. 5,000,000 µ$ = $5.00 (DD-9 restatement). */
  defaultCapMicroUsd: number;
  /** Per-issue overrides keyed `owner/repo#N`. */
  perIssueOverrides?: Record<string, number>;
  /**
   * Box-hour rate, µ$/h. exe.dev pricing is vendor-single-origin [VERIFY]
   * (R5 §6 fact 11), so the rate is configuration, never a compiled constant.
   * Required before any box-hours row can be priced.
   */
  boxHourRateMicroUsd?: number;
}

export const DEFAULT_COST_CONFIG: Readonly<CostConfig> = Object.freeze({ defaultCapMicroUsd: 5_000_000 });
// Intentionally omits boxHourRateMicroUsd: box-hours are optional and configured per-deployment.

export const DEFAULT_COST_CONFIG_FILE = ".sandbox/cost-config.json";

/** The ledger's default path — shared with the reporting CLI's existence check. */
export const DEFAULT_COST_LEDGER_FILE = ".sandbox/cost-ledger.db";

const ISSUE_KEY_RE = /^[\w.-]+\/[\w.-]+#\d+$/;

const CONFIG_KEYS: readonly (keyof CostConfig)[] = ["defaultCapMicroUsd", "perIssueOverrides", "boxHourRateMicroUsd"];

function configInvalid(file: string, detail: string): CostConfigError {
  return new CostConfigError(
    "cost-config-invalid",
    `cost config ${file}: ${detail}`,
    `write a partial-or-full override object, e.g. {"defaultCapMicroUsd": 5000000, "boxHourRateMicroUsd": 3600000, "perIssueOverrides": {"owner/repo#1": 1000000}}`,
  );
}

function assertMicros(file: string, key: string, value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw configInvalid(file, `${key} must be a positive safe integer of micro-dollars (got ${JSON.stringify(value)})`);
  }
  return value;
}

export interface LoadedCostConfig {
  config: CostConfig;
  source: "default" | "file";
  file?: string;
}

/** Mirrors quota.ts's loader: absent file ⇒ defaults; a config that cannot be trusted never falls back silently. */
export function loadCostConfig(
  file: string = process.env.QDS_COST_CONFIG_FILE ?? DEFAULT_COST_CONFIG_FILE,
): LoadedCostConfig {
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    if (err.code === "ENOENT") return { config: { ...DEFAULT_COST_CONFIG }, source: "default" };
    throw new CostConfigError(
      "cost-config-unreadable",
      `cannot read the cost config file ${file} (${err.message ?? String(e)}) — refusing to guess caps`,
      `fix the permissions on ${file}, or remove it to fall back to the built-in defaults`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new CostConfigError(
      "cost-config-unreadable",
      `cost config file ${file} is not valid JSON: ${(e as Error).message} — refusing to guess caps`,
      `write a valid JSON object over it, e.g. {"defaultCapMicroUsd": 5000000}`,
    );
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw configInvalid(file, "the body is not a JSON object");
  }
  const over: CostConfig = { ...DEFAULT_COST_CONFIG };
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (!(CONFIG_KEYS as readonly string[]).includes(key)) {
      throw configInvalid(file, `unknown key ${JSON.stringify(key)}`);
    }
    if (key === "perIssueOverrides") {
      if (typeof value !== "object" || value === null || Array.isArray(value)) {
        throw configInvalid(file, "perIssueOverrides must be an object keyed owner/repo#N");
      }
      const overrides: Record<string, number> = {};
      for (const [issueKey, cap] of Object.entries(value as Record<string, unknown>)) {
        if (!ISSUE_KEY_RE.test(issueKey)) {
          throw configInvalid(file, `perIssueOverrides key ${JSON.stringify(issueKey)} is not of the form owner/repo#N`);
        }
        overrides[issueKey] = assertMicros(file, `perIssueOverrides.${issueKey}`, cap);
      }
      over.perIssueOverrides = overrides;
    } else {
      (over as unknown as Record<string, unknown>)[key] = assertMicros(file, key, value);
    }
  }
  return { config: over, source: "file", file };
}

/** The cap that governs one issue: its override when present, the default otherwise. */
export function capForIssue(config: CostConfig, repoSlug: string, issueId: string): number {
  return config.perIssueOverrides?.[`${repoSlug}#${issueId}`] ?? config.defaultCapMicroUsd;
}

// ─── ledger ──────────────────────────────────────────────────────────────────

/** The DF2.7 wire event as this module receives it — float USD on the wire, µ$ never. */
export type CostWireEvent = CostEvent;

export type CostRole = "lead" | "worker" | "resident" | "tier1";

/**
 * The attribution context only the spawning dispatcher knows: DF2.7's event
 * carries agent/model/tokens/cost and nothing else, so run/issue/request/role
 * and the invocation counter arrive here. `role` is read from the roster entry
 * the dispatcher spawned under — never inferred from the model slug, the agent
 * name, or emission order.
 */
export interface IngestCtx {
  runId: string;
  repoSlug: string;
  issueId: string;
  requestId: string;
  role: CostRole;
  /** Dispatcher's monotonic per-(run_id, agent_id) counter, fixed at spawn. */
  invocationSeq: number;
}

export interface BoxHoursCtx {
  runId: string;
  repoSlug: string;
  issueId: string;
  requestId: string;
}

/** What the ledger needs to resolve a run's DF2.3 credential linkage (INV-COST-5). */
export interface RunCostRecord {
  keyHash?: string;
  limitMicroUsd?: number;
  createdAt: string;
  closedAt?: string;
}

export interface CostLedgerDeps {
  /** Defaults to `.sandbox/cost-ledger.db` (cwd-relative, like every `.sandbox/` path). */
  path?: string;
  /** Resolves run_id → the DF2.1 record's credential/lifetime fields. */
  readRunRecord?: (runId: string) => RunCostRecord | undefined;
  /** Explicit config; otherwise `loadCostConfig()` (env tier → `.sandbox/cost-config.json` → defaults). */
  config?: CostConfig;
}

/** One shared schema for every view — `qds cost` and the audit chain read the same field names. */
export interface CostView {
  totalMicroUsd: number;
  /** Priced spend by role; box-hours surface under the literal `"box-hours"` key (explicit unattributed line). */
  perRole: Record<string, number>;
  tokenTotals: { inputTokens: number; outputTokens: number };
  cacheTotals: { cacheReadTokens: number; cacheWriteTokens: number };
  unpricedRows: number;
  /** `false` distinguishes a run/issue with no ledger rows from one that spent nothing. */
  hasEvents: boolean;
}

export interface IngestResult {
  eventId: string;
  inserted: boolean;
  unpriced: boolean;
}

export interface AdmissionInput {
  repoSlug: string;
  issueId: string;
  runId: string;
  requestId: string;
}

export type AdmissionDecision =
  | {
      admitted: true;
      status: "within-budget";
      capMicroUsd: number;
      spentMicroUsd: number;
      reservedMicroUsd: number;
      remainingMicroUsd: number;
      unpricedRows: number;
      /** min(keyCapMicroUsd, remainingMicroUsd) — the one number handed to DF2.3's mint. */
      admittedCeilingMicroUsd: number;
    }
  | {
      admitted: false;
      status: "over-budget";
      reason: "spend-cap-exceeded";
      capMicroUsd: number;
      spentMicroUsd: number;
      reservedMicroUsd: number;
      unpricedRows: number;
    };

export class CostLedger {
  private readonly db: Database;
  private readonly readRunRecord: (runId: string) => RunCostRecord | undefined;
  readonly config: CostConfig;
  readonly path: string;

  constructor(deps: CostLedgerDeps = {}) {
    this.path = deps.path ?? process.env.QDS_COST_LEDGER_FILE ?? DEFAULT_COST_LEDGER_FILE;
    // Fail-safe default (INV-COST-6): an unwired seam must not expire
    // reservations — a truthy stub keeps every outstanding admission counted
    // (over-reserving, never under-counting). The ingest paths stay fail-closed
    // on the stub: it carries no keyHash/closedAt, so token ingest and
    // box-hours pricing still refuse rather than persist under guessed keys.
    this.readRunRecord = deps.readRunRecord ?? (() => ({ createdAt: "" }));
    this.config = deps.config ?? loadCostConfig().config;
    const dir = dirname(this.path);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    chmodSync(dir, 0o700);
    const dirMode = statSync(dir).mode & 0o777;
    if (dirMode !== 0o700) {
      throw new CostLedgerError(
        "ledger-dir-mode",
        `cost ledger dir ${dir} is mode 0${dirMode.toString(8)}, not 0700`,
        `chmod 0700 ${dir}`,
      );
    }
    const isNew = !existsSync(this.path);
    let db: Database;
    try {
      db = new Database(this.path);
    } catch (e) {
      // INV-COST-6: an unopenable ledger is never read as zero spend.
      throw new CostLedgerError(
        "ledger-unopenable",
        `cannot open the cost ledger ${this.path} (${(e as Error).message}) — refusing to treat spend as zero`,
        `fix the permissions on ${this.path} or remove the file if it is not a ledger, then re-run`,
      );
    }
    try {
      if (isNew) chmodSync(this.path, 0o600); // SQLite propagates the main file's mode to -wal/-shm
      const fileMode = statSync(this.path).mode & 0o777;
      if (fileMode !== 0o600) {
        throw new CostLedgerError(
          "ledger-file-mode",
          `cost ledger ${this.path} is mode 0${fileMode.toString(8)}, not 0600`,
          `chmod 0600 ${this.path}`,
        );
      }
      // Lifted pragma posture from inkwell's tracer.py:108-113 / visualizer db.ts:77-93.
      db.exec("PRAGMA journal_mode = WAL;");
      db.exec("PRAGMA synchronous = NORMAL;");
      db.exec("PRAGMA busy_timeout = 5000;");
      db.exec(SCHEMA);
      this.db = db;
    } catch (e) {
      // chmod/stat/db.exec can all throw after the handle exists but before
      // this.db is assigned — close the handle here so no failure path leaks
      // the fd and SQLite memory (the file-mode throw above rides this too).
      try {
        db.close();
      } catch {
        // The handle dies with the process; the original error is the diagnosis.
      }
      throw e;
    }
  }

  close(): void {
    this.db.close();
  }

  // ─── ingest ────────────────────────────────────────────────────────────────

  /**
   * One row per emitted event. A malformed event — non-finite or negative
   * `costUsd` — persists with `unpriced = 1` and `cost_micro_usd = 0`, never
   * dropped: an unrecorded cost is an unenforceable cap (AC4). An event with
   * `unpricedTurns > 0` (how DF2.7 marks absent/malformed usage upstream) is
   * flagged `unpriced = 1` — excluded from the priced SUM, because partial
   * usage undercounts — but its finite, non-negative `costUsd` still converts
   * and persists, so the recorded partial figure stays visible instead of
   * being zeroed.
   */
  ingestCostEvent(event: CostWireEvent, ctx: IngestCtx): IngestResult {
    const started = Date.now();
    assertIngestCtx(ctx);
    const record = this.readRunRecord(ctx.runId);
    // INV-COST-5: every token-kind row carries the DF2.3 key's hash and cap —
    // spend is attributable to the one credential that could have produced it.
    const keyHash = record?.keyHash;
    const keyLimit = record?.limitMicroUsd;
    if (keyHash === undefined || keyLimit === undefined) {
      const missing = keyHash === undefined ? "keyHash" : "limitMicroUsd";
      throw new CostLedgerError(
        "key-hash-missing",
        `run ${ctx.runId} has no resolvable ${missing} — token spend is unattributable, refusing to persist under a guessed key`,
        `re-run the ingest after mintRunKey records the run's key (see scripts/run-record.ts ${ctx.runId}), or pass the record through readRunRecord`,
      );
    }
    const costInvalid = !Number.isFinite(event.costUsd) || event.costUsd < 0;
    const unpriced = costInvalid || (event.unpricedTurns ?? 0) > 0;
    const costMicroUsd = costInvalid ? 0 : usdToMicros(event.costUsd);
    if (!Number.isSafeInteger(costMicroUsd) || costMicroUsd < 0) {
      throw new CostLedgerError(
        "cost-convert-invalid",
        `costUsd ${event.costUsd} did not convert to a non-negative safe integer of µ$ (got ${costMicroUsd})`,
        "fix the producer's cost event, or the row persists as unpriced only for the known-partial cases (non-finite/negative cost, unpricedTurns>0)",
      );
    }
    const eventId = tokenEventId({
      runId: ctx.runId,
      agentId: event.agentId,
      invocationSeq: ctx.invocationSeq,
      turnCount: event.turnCount ?? 0,
      costMicroUsd,
      timestamp: event.timestamp,
    });
    const { changes } = this.db
      .prepare(
        `INSERT INTO cost_events (
           event_id, run_id, repo_slug, issue_id, request_id, role, agent_id,
           kind, invocation_seq, input_tokens, output_tokens, cache_read_tokens,
           cache_write_tokens, turn_count, cost_micro_usd, unpriced,
           key_hash, key_limit_micro_usd, created_at
         ) VALUES (?,?,?,?,?,?,?, 'tokens', ?,?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(event_id) DO NOTHING`,
      )
      .run(
        eventId,
        ctx.runId,
        ctx.repoSlug,
        ctx.issueId,
        ctx.requestId,
        ctx.role,
        event.agentId,
        ctx.invocationSeq,
        event.inputTokens ?? 0,
        event.outputTokens ?? 0,
        event.cacheReadTokens ?? 0,
        event.cacheWriteTokens ?? 0,
        event.turnCount ?? 0,
        costMicroUsd,
        unpriced ? 1 : 0,
        keyHash,
        keyLimit,
        new Date().toISOString(),
      );
    const durationMs = Date.now() - started;
    const inserted = changes === 1;
    log({
      requestId: ctx.requestId,
      operation: "cost-ledger.ingest",
      agentId: event.agentId,
      timestamp: new Date().toISOString(),
      duration: durationMs,
      status: "ok",
      runId: ctx.runId,
      repoSlug: ctx.repoSlug,
      issueId: ctx.issueId,
      role: ctx.role,
      kind: "tokens",
      costMicroUsd,
      unpriced: unpriced ? 1 : 0,
      durationMs,
      outcome: inserted ? "inserted" : "duplicate",
      ingest_ms: durationMs,
    });
    return { eventId, inserted, unpriced };
  }

  /**
   * The box-hours row: ceil(VM lifetime) × boxHourRateMicroUsd, from the DF2.1
   * record's own timestamps, written at teardown's close step — the one point
   * at which the destroy is confirmed and the lifetime is final. Never from
   * `captureSpend`: that reads the same token money DF2.7 already priced, and
   * ingesting it would double-count inside the SUM the gate reads.
   */
  ingestBoxHours(ctx: BoxHoursCtx): IngestResult {
    const started = Date.now();
    for (const field of ["runId", "repoSlug", "issueId", "requestId"] as const) {
      const v = (ctx as unknown as Record<string, unknown>)[field];
      if (typeof v !== "string" || v.length === 0) {
        throw new CostLedgerError(
          "ingest-ctx-invalid",
          `box-hours ctx is missing ${field}`,
          "supply { runId, repoSlug, issueId, requestId } from the dispatch that owns the run",
        );
      }
    }
    const record = this.readRunRecord(ctx.runId);
    if (record === undefined) {
      throw new CostLedgerError(
        "record-missing",
        `no run record resolves for ${ctx.runId} — the box-hours lifetime has no source`,
        `re-run teardown with readRunRecord wired to the DF2.1 store (see .sandbox/runs/${ctx.runId}.json)`,
      );
    }
    if (record.closedAt === undefined) {
      // A teardown that aborts before close never reaches this call by design;
      // reaching it with an open record means the caller jumped the gun — a
      // billed box may still be alive (AC6 negative control).
      throw new CostLedgerError(
        "box-hours-record-open",
        `run ${ctx.runId} is not closed — the VM lifetime is not final and the destroy is unconfirmed`,
        're-run teardown to completion; qds cost reports this run as box-hours-pending until then',
      );
    }
    const created = Date.parse(record.createdAt);
    const closed = Date.parse(record.closedAt);
    if (!Number.isFinite(created) || !Number.isFinite(closed) || closed < created || created <= 0) {
      throw new CostLedgerError(
        "box-hours-lifetime-invalid",
        `run ${ctx.runId} lifetime is not computable (createdAt ${record.createdAt}, closedAt ${record.closedAt})`,
        `repair the run record's timestamps, then re-run teardown — the row is pending until then`,
      );
    }
    const rate = this.config.boxHourRateMicroUsd;
    if (rate === undefined) {
      throw new CostConfigError(
        "box-hour-rate-unconfigured",
        "boxHourRateMicroUsd is not configured — an unpriced box hour must surface, not silently cost 0",
        `write {"boxHourRateMicroUsd": <integer µ$/h>} to .sandbox/cost-config.json (exe.dev figures are vendor-single-origin [VERIFY] — R5 §6 fact 11), then re-run teardown`,
      );
    }
    const hours = Math.ceil((closed - created) / MS_PER_HOUR);
    const costMicroUsd = hours * rate;
    if (!Number.isSafeInteger(costMicroUsd)) {
      throw new CostLedgerError(
        "box-hours-cost-invalid",
        `run ${ctx.runId} box-hours cost is not a safe integer (lifetime ${hours}h × rate ${rate} µ$/h = ${costMicroUsd}) — refusing to store a silently wrong figure`,
        "repair the run record's createdAt/closedAt or lower boxHourRateMicroUsd in .sandbox/cost-config.json, then re-run teardown",
      );
    }
    const eventId = boxHoursEventId(ctx.runId, record.closedAt);
    const { changes } = this.db
      .prepare(
        `INSERT INTO cost_events (
           event_id, run_id, repo_slug, issue_id, request_id, role, agent_id,
           kind, invocation_seq, cost_micro_usd, unpriced, created_at
         ) VALUES (?,?,?,?,?, NULL, NULL, 'box_hours', 0, ?, 0, ?)
         ON CONFLICT(event_id) DO NOTHING`,
      )
      .run(eventId, ctx.runId, ctx.repoSlug, ctx.issueId, ctx.requestId, costMicroUsd, new Date().toISOString());
    const durationMs = Date.now() - started;
    const inserted = changes === 1;
    log({
      requestId: ctx.requestId,
      operation: "cost-ledger.ingest",
      agentId: null,
      timestamp: new Date().toISOString(),
      duration: durationMs,
      status: "ok",
      runId: ctx.runId,
      repoSlug: ctx.repoSlug,
      issueId: ctx.issueId,
      role: null,
      kind: "box_hours",
      costMicroUsd,
      unpriced: 0,
      durationMs,
      outcome: inserted ? "inserted" : "duplicate",
      ingest_ms: durationMs,
    });
    return { eventId, inserted, unpriced: false };
  }

  // ─── views ─────────────────────────────────────────────────────────────────

  /** The run-keyed view (DF5.3 audit hop 3 / DF5.4 C10) — same schema as the issue view. */
  readRunCost(runId: string): CostView {
    return this.view("run_id = ?", [runId], "run_id = ? AND unpriced = 0", [runId], "run_id = ? AND unpriced = 1", [runId]);
  }

  /** The issue-keyed view — the same SUM the gate reads (INV-COST-2). */
  readIssueCost(repoSlug: string, issueId: string): CostView {
    const all = "repo_slug = ? AND issue_id = ?";
    const priced = `${all} AND unpriced = 0`;
    const unpricedQ = `${all} AND unpriced = 1`;
    const keys = [repoSlug, issueId];
    return this.view(all, keys, priced, keys, unpricedQ, keys);
  }

  private view(
    allWhere: string,
    allKeys: string[],
    pricedWhere: string,
    pricedKeys: string[],
    unpricedWhere: string,
    unpricedKeys: string[],
  ): CostView {
    this.assertQueryable();
    const totalRow = this.db
      .prepare(`SELECT COALESCE(SUM(cost_micro_usd), 0) AS total FROM cost_events WHERE ${pricedWhere}`)
      .get(...pricedKeys) as { total: number };
    const roleRows = this.db
      .prepare(
        `SELECT CASE WHEN kind = 'box_hours' THEN 'box-hours' ELSE role END AS bucket,
                SUM(cost_micro_usd) AS sum
         FROM cost_events WHERE ${pricedWhere} GROUP BY bucket`,
      )
      .all(...pricedKeys) as { bucket: string | null; sum: number }[];
    const tokenRow = this.db
      .prepare(
        `SELECT COALESCE(SUM(input_tokens), 0) AS inputTokens,
                COALESCE(SUM(output_tokens), 0) AS outputTokens,
                COALESCE(SUM(cache_read_tokens), 0) AS cacheReadTokens,
                COALESCE(SUM(cache_write_tokens), 0) AS cacheWriteTokens
         FROM cost_events WHERE ${pricedWhere} AND kind = 'tokens'`,
      )
      .get(...pricedKeys) as {
      inputTokens: number;
      outputTokens: number;
      cacheReadTokens: number;
      cacheWriteTokens: number;
    };
    const unpricedRow = this.db
      .prepare(`SELECT COUNT(*) AS n FROM cost_events WHERE ${unpricedWhere}`)
      .get(...unpricedKeys) as { n: number };
    const anyRow = this.db
      .prepare(`SELECT COUNT(*) AS n FROM cost_events WHERE ${allWhere}`)
      .get(...allKeys) as { n: number };
    const perRole: Record<string, number> = {};
    for (const row of roleRows) perRole[row.bucket ?? "unknown"] = row.sum;
    return {
      totalMicroUsd: totalRow.total,
      perRole,
      tokenTotals: { inputTokens: tokenRow.inputTokens, outputTokens: tokenRow.outputTokens },
      cacheTotals: { cacheReadTokens: tokenRow.cacheReadTokens, cacheWriteTokens: tokenRow.cacheWriteTokens },
      unpricedRows: unpricedRow.n,
      hasEvents: anyRow.n > 0,
    };
  }

  /**
   * Per-run breakdown rows for the CLI: every run with priced token spend plus
   * its box-hours state — `boxHoursPending` when no box_hours row exists yet
   * (an aborted teardown is pending, never zero).
   */
  readIssueRuns(repoSlug: string, issueId: string): {
    runId: string;
    totalMicroUsd: number;
    hasBoxHours: boolean;
  }[] {
    this.assertQueryable();
    const rows = this.db
      .prepare(
        `SELECT run_id,
                COALESCE(SUM(CASE WHEN unpriced = 0 THEN cost_micro_usd ELSE 0 END), 0) AS total,
                MAX(CASE WHEN kind = 'box_hours' THEN 1 ELSE 0 END) AS hasBox
         FROM cost_events WHERE repo_slug = ? AND issue_id = ?
         GROUP BY run_id ORDER BY MIN(created_at)`,
      )
      .all(repoSlug, issueId) as { run_id: string; total: number; hasBox: number }[];
    return rows.map((r) => ({ runId: r.run_id, totalMicroUsd: r.total, hasBoxHours: r.hasBox === 1 }));
  }

  private assertQueryable(): void {
    try {
      // Probe must touch the btree — a bare SELECT 1 never opens cost_events, so page-level corruption would pass.
      this.db.prepare("SELECT 1 FROM cost_events LIMIT 1").get();
    } catch (e) {
      throw new CostLedgerError(
        "ledger-unqueryable",
        `the cost ledger cannot be queried (${(e as Error).message}) — refusing to treat spend as zero`,
        `repair or remove ${this.path} (it is append-only state; a fresh file under-counts), then re-run`,
      );
    }
  }

  // ─── serialized admission (R2 §6) ──────────────────────────────────────────

  /**
   * The cap decision, inside one BEGIN IMMEDIATE transaction: read the priced
   * SUM, add the ceilings of outstanding admissions (runs admitted but not yet
   * reporting spend), and if committed ≥ cap refuse — otherwise insert this
   * dispatch's admission and return `min(keyCapMicroUsd, remainingMicroUsd)`,
   * the one ceiling handed to DF2.3's mint (AC3). `remainingMicroUsd` is the
   * headroom AFTER spend and reservations (the same `committed` the refusal
   * check uses), so an admitted ceiling can never over-commit the issue past
   * its cap.
   *
   * **What a reservation means.** It is OUTSTANDING UNSPENT EXPOSURE: money the
   * issue's cap has already committed to a run that has not yet reported
   * spending it. It is not a bookkeeping artefact and it is not a leak, so no
   * caller should ever "release" one on a failure path. In particular, a
   * dispatch that fails AFTER provisioning still holds its reservation
   * correctly: INV-5 deliberately leaves the box alive and — past the mint —
   * the key live at the FULL admitted ceiling so an operator can diagnose the
   * failure, so the exposure the reservation represents is entirely real. A
   * compensating release there would under-report live risk and let the next
   * dispatch overcommit the same cap.
   *
   * **How it retires.** By itself, once the run's first **priced** ledger row
   * lands — so a finished run's admission never blocks the next dispatch. An
   * unpriced row is not observable spend: a run reporting only unpriced rows
   * keeps its full ceiling counted, so unpriced traffic never silently restores
   * headroom the cap was holding. A run that never reports ANY row keeps its
   * reservation, by design: that run is still open, and teardown's box-hours
   * ingest (or the DF2.6 reaper, which routes through teardownSandbox) is what
   * writes the priced `box_hours` row that retires it. A reservation's lifetime
   * is therefore bounded by the same fleet hygiene that bounds an open record
   * with a live box — that is the retirement path for a failed dispatch too.
   *
   * The one expiry: an admission older than `ADMISSION_GRACE_MS +
   * ADMISSION_SKEW_MARGIN_MS` whose run record does not resolve through
   * readRunRecord (createRun's store.create failed, so no run can ever exist)
   * stops counting — see the orphan guard.
   *
   * A retry reusing the same `(requestId, runId)` is idempotent: it is judged
   * against the headroom its original saw (its own reservation is excluded from
   * the sum) and hands back the ceiling already ON the row, never a second one.
   */
  admitIssue(input: AdmissionInput, capMicroUsd: number, keyCapMicroUsd: number): AdmissionDecision {
    const started = Date.now();
    this.assertQueryable();
    if (!Number.isInteger(capMicroUsd) || capMicroUsd <= 0) {
      throw new CostConfigError(
        "cost-config-invalid",
        `capMicroUsd must be a positive integer of micro-dollars, got ${capMicroUsd}`,
        "fix defaultCapMicroUsd / perIssueOverrides in .sandbox/cost-config.json",
      );
    }
    const decide = this.db.transaction((): AdmissionDecision => {
      const spentRow = this.db
        .prepare(
          "SELECT COALESCE(SUM(cost_micro_usd), 0) AS total, COUNT(*) AS n FROM cost_events WHERE repo_slug = ? AND issue_id = ? AND unpriced = 0",
        )
        .get(input.repoSlug, input.issueId) as { total: number; n: number };
      // The caller's OWN row is excluded from the reservations below: this
      // admission is either fresh (no such row exists, so the exclusion matches
      // nothing) or a retry of the same (request_id, run_id), which must be
      // judged against the headroom its original saw — not against its own
      // reservation. Counting itself charged the cap twice for one run: with the
      // default cap below the key cap the first admission reserves the WHOLE
      // cap, so `committed >= cap` refused every retry with `spend-cap-exceeded`
      // and the replay branch below never ran. It also left `remainingMicroUsd`
      // net of a reservation the returned `admittedCeilingMicroUsd` (the
      // recorded one) is not net of, breaking the `admittedCeilingMicroUsd <=
      // remainingMicroUsd` invariant consumers rely on. Not a hole: the
      // exclusion is the PRIMARY KEY, so it can only ever drop the caller's own
      // row, and a DIFFERENT correlation id still sees the reservation. Every
      // admitted ceiling is <= the headroom left after the reservations
      // outstanding at ITS admission, so the recorded ceiling a replay hands
      // back still fits the headroom recomputed here.
      const reservedRows = this.db
        .prepare(
          `SELECT a.ceiling_micro_usd AS ceiling, a.run_id AS runId, a.decided_at AS decidedAt
           FROM gate_admissions a
           WHERE a.repo_slug = ? AND a.issue_id = ?
             AND NOT (a.request_id = ? AND a.run_id = ?)
             AND NOT EXISTS (
               SELECT 1 FROM cost_events ce
               WHERE ce.run_id = a.run_id AND ce.unpriced = 0
             )`,
        )
        .all(input.repoSlug, input.issueId, input.requestId, input.runId) as {
        ceiling: number;
        runId: string;
        decidedAt: string;
      }[];
      const graceCutoff = Date.now() - ADMISSION_GRACE_MS - ADMISSION_SKEW_MARGIN_MS;
      let reservedMicroUsd = 0;
      for (const row of reservedRows) {
        // Orphan guard: a reservation counts while its run record resolves —
        // and, for the first ADMISSION_GRACE_MS, whether it resolves or not.
        // createRun admits BEFORE store.create (INV-COST-3), so a missing
        // record means one of two things the record alone cannot tell apart:
        // NEVER created (store.create failed with EEXIST or an invalid run id —
        // that run can never report spend) or NOT created YET (the admitting
        // dispatch is still in flight). Only the older one is an orphan; a
        // young one still counts, which is what stops two concurrent dispatches
        // from each skipping the other's reservation and both winning the full
        // remaining headroom. gate_admissions is append-only (INV-COST-1), so
        // the expiry lives here in the read, not in a row mutation.
        // readRunRecord's contract does the classifying: undefined ⇒ no record
        // (expired reservation); a throw — e.g. a corrupt record — propagates
        // and refuses this dispatch rather than undercount.
        const decidedAt = Date.parse(row.decidedAt);
        // An unparseable decided_at counts as young for the same fail-safe
        // reason the whole guard is conservative: over-reserve, never expire.
        // So does a future-dated one, and one within ADMISSION_SKEW_MARGIN_MS
        // of the window on either host's reading of the clock — `graceCutoff`
        // carries that margin, because `decided_at` is the WRITER's clock and
        // ours may run ahead of it (see ADMISSION_SKEW_MARGIN_MS).
        const young = !Number.isFinite(decidedAt) || decidedAt > graceCutoff;
        // Read UNCONDITIONALLY, then let `young` decide how to read the answer.
        // Short-circuiting on `young` meant a corrupt record was never touched
        // at admission time for the first ADMISSION_GRACE_MS, so the refusal
        // the comment above promises did not happen — the corruption surfaced
        // 60s later, on somebody else's dispatch.
        const record = this.readRunRecord(row.runId);
        if (!young && record === undefined) continue;
        reservedMicroUsd += row.ceiling;
        // Overflow guard: sum of reservation ceilings can exceed MAX_SAFE_INTEGER
        if (reservedMicroUsd > Number.MAX_SAFE_INTEGER) {
          throw new CostLedgerError(
            "ledger-overflow",
            `sum of reservation ceilings (${reservedMicroUsd} µ$) exceeds safe integer range`,
            "wait for existing reservations to retire, or raise the issue cap",
          );
        }
      }
      const unpricedRow = this.db
        .prepare(
          "SELECT COUNT(*) AS n FROM cost_events WHERE repo_slug = ? AND issue_id = ? AND unpriced = 1",
        )
        .get(input.repoSlug, input.issueId) as { n: number };
      const spentMicroUsd = spentRow.total;
      const unpricedRows = unpricedRow.n;
      const cap = capMicroUsd;
      const committed = spentMicroUsd + reservedMicroUsd;
      if (committed >= cap) {
        return {
          admitted: false,
          status: "over-budget",
          reason: "spend-cap-exceeded",
          capMicroUsd: cap,
          spentMicroUsd,
          reservedMicroUsd,
          unpricedRows,
        };
      }
      // Headroom after spend AND outstanding reservations — the same
      // `committed` the refusal check uses, so an admitted ceiling can never
      // over-commit the issue past its cap.
      const remainingMicroUsd = cap - committed;
      // Guard against cap being lowered after spend: remaining <= 0 means over-cap
      if (remainingMicroUsd <= 0) {
        return {
          admitted: false,
          status: "over-budget",
          reason: "spend-cap-exceeded",
          capMicroUsd: cap,
          spentMicroUsd,
          reservedMicroUsd,
          unpricedRows,
        };
      }
      let ceiling = Math.min(keyCapMicroUsd, remainingMicroUsd);
      const { changes } = this.db
        .prepare(
          `INSERT INTO gate_admissions (request_id, run_id, repo_slug, issue_id, ceiling_micro_usd, decided_at)
           VALUES (?,?,?,?,?,?)
           ON CONFLICT(request_id, run_id) DO NOTHING`,
        )
        .run(input.requestId, input.runId, input.repoSlug, input.issueId, ceiling, new Date().toISOString());
      if (changes === 0) {
        // `DO NOTHING` fired: this (request_id, run_id) already holds a
        // reservation — a retried dispatch reusing its correlation id after a
        // `store.create` EEXIST, or any caller-level retry. Returning the
        // freshly-computed `ceiling` handed DF2.3's mint a ceiling that appears
        // in NO row and therefore holds NO reservation, and the next dispatch
        // granted the same headroom again (c1 + c2 + c2 against a cap of
        // c1 + c2). Hand back the ceiling that IS on the row instead: it is
        // already inside `reservedMicroUsd` above, so it is the one number this
        // admission actually reserved. gate_admissions is append-only
        // (INV-COST-1), so re-reading is the whole remedy.
        const prior = this.db
          .prepare("SELECT ceiling_micro_usd AS ceiling FROM gate_admissions WHERE request_id = ? AND run_id = ?")
          .get(input.requestId, input.runId) as { ceiling: number } | undefined;
        if (prior === undefined) {
          throw new CostLedgerError(
            "ledger-admission-lost",
            `the admission for request ${input.requestId} / run ${input.runId} neither inserted nor resolved — refusing to mint an unreserved ceiling`,
            "inspect gate_admissions for that (request_id, run_id) and re-run the dispatch with a fresh request id",
          );
        }
        ceiling = prior.ceiling;
      }
      return {
        admitted: true,
        status: "within-budget",
        capMicroUsd: cap,
        spentMicroUsd,
        reservedMicroUsd,
        remainingMicroUsd,
        unpricedRows,
        admittedCeilingMicroUsd: ceiling,
      };
    });
    let decision: AdmissionDecision;
    try {
      decision = decide.immediate();
    } catch (e) {
      const msg = (e as Error).message ?? String(e);
      if (/database is (locked|busy)|database table is locked/i.test(msg)) {
        throw new CostLedgerError(
          "ledger-busy",
          `the cost ledger stayed write-locked past the 5s busy timeout (${msg}) — transient contention, not corruption`,
          "retry the dispatch; if it persists, check for a process holding .sandbox/cost-ledger.db open",
        );
      }
      throw e;
    }
    const durationMs = Date.now() - started;
    log({
      requestId: input.requestId,
      operation: "cost-ledger.gate",
      agentId: null,
      timestamp: new Date().toISOString(),
      duration: durationMs,
      status: "ok",
      runId: input.runId,
      repoSlug: input.repoSlug,
      issueId: input.issueId,
      decision: decision.status,
      capMicroUsd: decision.capMicroUsd,
      spentMicroUsd: decision.spentMicroUsd,
      reservedMicroUsd: decision.reservedMicroUsd,
      unpricedRows: decision.unpricedRows,
      ...(decision.admitted ? { remainingMicroUsd: decision.remainingMicroUsd, admittedCeilingMicroUsd: decision.admittedCeilingMicroUsd } : {}),
      durationMs,
      outcome: decision.status,
      sum_query_ms: durationMs,
    });
    return decision;
  }
}

// ─── ctx validation ──────────────────────────────────────────────────────────

const COST_ROLES: ReadonlySet<string> = new Set(["lead", "worker", "resident", "tier1"]);

function assertIngestCtx(ctx: IngestCtx): void {
  const strings = ["runId", "repoSlug", "issueId", "requestId", "role"] as const;
  for (const field of strings) {
    const v = (ctx as unknown as Record<string, unknown>)[field];
    if (typeof v !== "string" || v.length === 0) {
      throw new CostLedgerError(
        "ingest-ctx-invalid",
        `ingest ctx is missing ${field} — an unattributable cost is not persisted under a guessed key (INV-COST-6)`,
        "supply { runId, repoSlug, issueId, requestId, role, invocationSeq } from the dispatch that spawned the agent",
      );
    }
  }
  if (!COST_ROLES.has(ctx.role)) {
    // The schema's CHECK is the backstop; this is the error surface — a raw
    // SQLITE_CONSTRAINT would name no field and suggest no next command.
    throw new CostLedgerError(
      "ingest-ctx-invalid",
      `ingest ctx role must be one of lead|worker|resident|tier1 (got ${JSON.stringify(ctx.role)})`,
      "pass the roster entry's role verbatim — it is never inferred from the model slug or agent name",
    );
  }
  if (
    typeof ctx.invocationSeq !== "number" ||
    !Number.isInteger(ctx.invocationSeq) ||
    ctx.invocationSeq < 0
  ) {
    throw new CostLedgerError(
      "ingest-ctx-invalid",
      "ingest ctx invocationSeq must be a non-negative integer (the dispatcher's per-(run, agent) spawn counter)",
      "pass the invocationSeq fixed at spawn — it is what keeps two invocations of one agent from digesting identically",
    );
  }
}
