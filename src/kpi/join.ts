/**
 * A5 — the DD-20 both-ledger spend join and the read-side store adapters.
 *
 * DD-20 artifact contract (the gateway-spend import file, produced by the
 * UNSCHEDULED solstice-side counterpart story per charter §5.5):
 * `.sandbox/imports/gateway-spend-<window>.jsonl`, one strict JSON object per
 * line — `{workKey, runId | null, issueId | null, botId, cost_micro_usd}`.
 * Unknown fields refuse; `cost_micro_usd` is integer micro-dollars AND
 * safe-integer-guarded (DD-9; `cost-convert-invalid` precedent,
 * src/providers/cost-ledger.ts:309-313) — a float or an out-of-range figure
 * fails the parse, never rounds; a row carrying NEITHER `runId` NOR `issueId`
 * refuses (the canonical join key would lose a component).
 *
 * The canonical DD-20 key is **workKey + runId + botId**, one key serving both
 * spend matching and missing-row accounting. Factory-side `botId` is not
 * tracked by any store today (verified: the run-record extension registry,
 * src/providers/run-record.ts:189-384, carries no bot/agent identity) — so the
 * join matches on (workKey, runId), preserves `botId` per import row, and
 * factory-side botId population lands with the solstice producer counterpart.
 *
 * Absence law (story decision (1)): a wholly absent import is `absent`, never
 * an error and never `0` — the *|null SpendJoin fields are null exactly then.
 */
import { readFileSync } from "node:fs";

import { z } from "zod";

// ─── typed error ─────────────────────────────────────────────────────────────

export type KpiErrorCode = "gateway-import-invalid" | "dispatch-log-invalid" | "kpi-window-invalid";

export class KpiError extends Error {
  readonly code: KpiErrorCode;
  readonly remediation: string;

  constructor(code: KpiErrorCode, message: string, remediation: string) {
    super(message);
    this.name = "KpiError";
    this.code = code;
    this.remediation = remediation;
  }
}

// ─── the minimal run-record shape every computation consumes ─────────────────

/**
 * Structural subset of `RunRecord` (src/providers/run-record.ts:124) — real
 * records are assignable, fixtures are cheap to build, and the KPI layer reads
 * only `runId`/`requestId`/`closedAt`/`extensions`.
 */
export interface RunRecordLike {
  runId: string;
  createdAt: string;
  requestId?: string;
  closedAt?: string;
  extensions?: Record<string, Record<string, unknown>>;
}

// ─── gateway-spend import (AC2) ──────────────────────────────────────────────

export const GatewaySpendRowSchema = z
  .strictObject({
    workKey: z.string().min(1),
    /** Null only when the row carries `issueId` — the correspondence fills the key. */
    runId: z.string().min(1).nullable(),
    issueId: z.string().min(1).nullable(),
    /** Validated non-empty at parse; preserved per row (DD-20 contract note above). */
    botId: z.string().min(1),
    cost_micro_usd: z
      .number()
      .int()
      .refine((n) => Number.isSafeInteger(n), {
        message: "cost_micro_usd outside the safe-integer range (DD-9; cost-convert-invalid precedent)",
      }),
  })
  .refine((r) => r.runId !== null || r.issueId !== null, {
    message: "gateway row carries neither runId nor issueId — the DD-20 join key would lose a component",
  });

export type GatewaySpendRow = z.infer<typeof GatewaySpendRowSchema>;

export type GatewayImport = { status: "present"; rows: GatewaySpendRow[] } | { status: "absent" };

/** Read the import file. ENOENT → absent (decision (1)); any malformed line throws. */
export function readGatewaySpendImport(path: string): GatewayImport {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return { status: "absent" };
    throw e;
  }
  const rows: GatewaySpendRow[] = [];
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = (lines[i] ?? "").trim();
    if (line === "") continue; // blank + trailing-newline lines tolerated
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch (e) {
      throw new KpiError(
        "gateway-import-invalid",
        `gateway import ${path} line ${i + 1} is not JSON: ${(e as Error).message}`,
        "regenerate the import file from the zeropoint-side producer; a malformed import is a fault, never skipped",
      );
    }
    const row = GatewaySpendRowSchema.safeParse(parsed);
    if (!row.success) {
      throw new KpiError(
        "gateway-import-invalid",
        `gateway import ${path} line ${i + 1} refuses the strict schema: ${row.error.issues
          .map((iss) => `${iss.path.join(".")}: ${iss.message}`)
          .join("; ")}`,
        "fix the producer export — unknown fields, float money, and unsafe integers all fail the strict parse",
      );
    }
    rows.push(row.data);
  }
  return { status: "present", rows };
}

// ─── dispatch log (retry-rate source) ────────────────────────────────────────

export const DispatchEntrySchema = z.strictObject({
  timestamp: z.string(),
  repoSlug: z.string().nullable(),
  /** The identity half the brief named: issueId (number) or workId (string) — Q1.7. */
  issueId: z.union([z.string(), z.number(), z.null()]),
  requestId: z.string().nullable(),
  code: z.string(),
  message: z.string(),
});

export type DispatchEntry = z.infer<typeof DispatchEntrySchema>;

export type DispatchLog = { status: "present"; entries: DispatchEntry[] } | { status: "absent" };

/**
 * Read `.sandbox/dispatch-log.jsonl` (src/fleet/dispatch.ts:126). This store
 * EXISTS — its writer landed — so a malformed line is a typed fault, not an
 * absence. Blank lines tolerated.
 */
export function readDispatchLog(path: string): DispatchLog {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return { status: "absent" };
    throw e;
  }
  const entries: DispatchEntry[] = [];
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = (lines[i] ?? "").trim();
    if (line === "") continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch (e) {
      throw new KpiError(
        "dispatch-log-invalid",
        `dispatch log ${path} line ${i + 1} is not JSON: ${(e as Error).message}`,
        "the dispatch log is a live store — inspect the corrupt line before recomputing KPIs",
      );
    }
    const entry = DispatchEntrySchema.safeParse(parsed);
    if (!entry.success) {
      throw new KpiError(
        "dispatch-log-invalid",
        `dispatch log ${path} line ${i + 1} refuses the strict schema: ${entry.error.issues
          .map((iss) => `${iss.path.join(".")}: ${iss.message}`)
          .join("; ")}`,
        "the dispatch log writer pins this shape (src/phase-engine/issue-correlation.ts:290) — a drift is a fault",
      );
    }
    entries.push(entry.data);
  }
  return { status: "present", entries };
}

// ─── run identities (requestId join) ─────────────────────────────────────────

export type RunIdentity = { runId: string; workKey: string | null; repoSlug: string | null; requestId: string | null };

/**
 * requestId join: a dispatch entry's (repoSlug, issueId → `w:<issueId>`
 * workKey) fills the record whose `requestId` matches. Records without a
 * dispatch match carry `workKey: null` — unattributed, counted later, never
 * dropped. First entry wins on a repeated requestId (append-only log,
 * re-dispatch under one id is one correlation).
 */
export function buildRunIdentities(records: RunRecordLike[], dispatch: DispatchEntry[]): RunIdentity[] {
  const byRequestId = new Map<string, DispatchEntry>();
  for (const e of dispatch) {
    if (e.requestId !== null && !byRequestId.has(e.requestId)) byRequestId.set(e.requestId, e);
  }
  return records.map((r): RunIdentity => {
    const e = r.requestId !== undefined ? byRequestId.get(r.requestId) : undefined;
    return {
      runId: r.runId,
      workKey: e !== undefined && e.issueId !== null ? `w:${e.issueId}` : null,
      repoSlug: e?.repoSlug ?? null,
      requestId: r.requestId ?? null,
    };
  });
}

// ─── the DD-20 spend join ────────────────────────────────────────────────────

export type FactorySpendRow = { runId: string; workKey: string | null; microUsd: number; eventCount: number };

export const SpendJoinSchema = z.strictObject({
  join_key: z.literal("workKey+runId+botId"),
  factory_micro_usd_total: z.number().int(),
  factory_event_count: z.number().int(),
  gateway_row_count: z.number().int().nullable(),
  gateway_micro_usd_total: z.number().int().nullable(),
  matched_gateway_rows: z.number().int(),
  unmatched_gateway_rows: z.number().int().nullable(),
  missing_gateway_rows: z.number().int().nullable(),
  spend_incomplete: z.boolean(),
});

export type SpendJoin = z.infer<typeof SpendJoinSchema>;

/**
 * Join both spend ledgers on the DD-20 canonical key. Match rule: an import
 * row with a `runId` joins the factory row with the same (workKey, runId); a
 * `runId`-null row joins via its issueId↔workKey correspondence (its workKey
 * against any factory row's workKey — AC2's parenthetical). Unmatched import
 * rows and factory rows missing an import row are COUNTED, never sampled, and
 * never silently dropped. `spend_incomplete` is the both-ledgers-or-flagged
 * contract: absent import, missing rows, or unmatched rows all set it — the
 * degraded factory-only curve stays green underneath the flag.
 */
export function joinSpend(factoryRows: FactorySpendRow[], gatewayImport: GatewayImport): SpendJoin {
  const factory_micro_usd_total = factoryRows.reduce((s, r) => s + r.microUsd, 0);
  const factory_event_count = factoryRows.reduce((s, r) => s + r.eventCount, 0);
  if (gatewayImport.status === "absent") {
    return {
      join_key: "workKey+runId+botId",
      factory_micro_usd_total,
      factory_event_count,
      gateway_row_count: null,
      gateway_micro_usd_total: null,
      matched_gateway_rows: 0,
      unmatched_gateway_rows: null,
      missing_gateway_rows: null,
      spend_incomplete: true,
    };
  }
  const rows = gatewayImport.rows;
  const factoryMatched = new Array<boolean>(factoryRows.length).fill(false);
  let matched = 0;
  let unmatched = 0;
  for (const g of rows) {
    let hit = false;
    for (let i = 0; i < factoryRows.length; i++) {
      const f = factoryRows[i] as FactorySpendRow;
      const joins =
        g.runId !== null ? f.workKey === g.workKey && f.runId === g.runId : f.workKey === g.workKey;
      if (joins) {
        hit = true;
        factoryMatched[i] = true;
      }
    }
    if (hit) matched++;
    else unmatched++;
  }
  const missing = factoryMatched.filter((m) => !m).length;
  return {
    join_key: "workKey+runId+botId",
    factory_micro_usd_total,
    factory_event_count,
    gateway_row_count: rows.length,
    gateway_micro_usd_total: rows.reduce((s, r) => s + r.cost_micro_usd, 0),
    matched_gateway_rows: matched,
    unmatched_gateway_rows: unmatched,
    missing_gateway_rows: missing,
    spend_incomplete: missing > 0 || unmatched > 0,
  };
}

// ─── dimensions (AC4) ────────────────────────────────────────────────────────

export const DimensionSchema = z.union([
  z.strictObject({ source: z.string(), status: z.literal("absent") }),
  z.strictObject({ source: z.string(), status: z.literal("joined"), count: z.number().int() }),
]);

export type Dimension = z.infer<typeof DimensionSchema>;

/** Type a named source absent — a dimension column is never `0`, never omitted. */
export function absentDimension(source: string): Dimension {
  return { source, status: "absent" };
}

/**
 * Read-side dimension join over a JSONL source: ENOENT → typed absent; present
 * → line count. Used for J3's routing log; the QA-findings path arrives with
 * A2. The Z2 observe-artifacts dir is NOT a dimension file (a dir of run
 * artifacts, fork-side only) — it is typed absent via `absentDimension`.
 */
export function readJsonlDimension(source: string, path: string): Dimension {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return absentDimension(source);
    throw e;
  }
  const count = text.split("\n").filter((l) => l.trim() !== "").length;
  return { source, status: "joined", count };
}
