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
 * The canonical DD-20 key is **workKey + runId + botId** — botId is validated
 * non-empty and preserved per row (the third canonical component). Factory-side
 * `botId` is not tracked by any store today (verified: the run-record
 * extension registry, src/providers/run-record.ts:189-384, carries no
 * bot/agent identity), so the join MATCHES on the two components the factory
 * knows — (workKey, runId) — while the producer counterpart that lands bot
 * identity remains outstanding (recorded deviation (c), round-1 F-005: the
 * payload's `join_key` now certifies exactly what the code performs).
 *
 * Absence law (story decision (1)): a wholly absent import is `absent`, never
 * an error and never `0` — the *|null SpendJoin fields are null exactly then.
 * Also hosts the record-side joins the KPI layer consumes (charged fix
 * attempts; stableStringify/payloadHashHex) — kpis.ts re-exports them.
 */
import { readFileSync } from "node:fs";

import { z } from "zod";

import { CHARGED_CLASSES, parseFixOutcomeClass } from "../fixloop/escalation.ts";

// ─── typed error ─────────────────────────────────────────────────────────────

export type KpiErrorCode =
  | "gateway-import-invalid"
  | "dispatch-log-invalid"
  | "routing-log-invalid"
  | "kpi-window-invalid"
  | "aggregate-overflow";

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
  for (const [i, raw] of lines.entries()) {
    const line = raw.trim();
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
  for (const [i, raw] of lines.entries()) {
    const line = raw.trim();
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

// ─── charged fix attempts (AC3) ──────────────────────────────────────────────

const fixAttemptIds = (parent: RunRecordLike): string[] => {
  const ids = parent.extensions?.fixLoop?.fixAttemptRunIds;
  return Array.isArray(ids) ? ids.filter((id): id is string => typeof id === "string") : [];
};

/** Per-parent attempt counts — first-pass-accept needs the per-run charged split. */
export function attemptCountsByParent(
  records: RunRecordLike[],
): Map<string, { charged: number; uncharged: number; unattributed: number }> {
  const byRunId = new Map(records.map((r) => [r.runId, r]));
  const perParent = new Map<string, { charged: number; uncharged: number; unattributed: number }>();
  for (const parent of records) {
    let charged = 0;
    let uncharged = 0;
    let unattributed = 0;
    for (const id of fixAttemptIds(parent)) {
      const target = byRunId.get(id);
      if (target === undefined) {
        unattributed++; // orphan ledger id — no outcome linkage
        continue;
      }
      const raw = target.extensions?.fixLoop?.fixOutcomeClass;
      const cls = parseFixOutcomeClass(raw);
      if (cls !== undefined) {
        if (CHARGED_CLASSES.has(cls)) charged++;
        else uncharged++; // valid EscalationClass, charging nothing
      } else if (raw === undefined) {
        uncharged++; // no written class yet: attempt not terminal — neither charged nor a signal
      } else {
        // non-string carrier (F-016) or a written class outside the
        // EscalationClass union — both corruption signals, both unattributed
        unattributed++;
      }
    }
    perParent.set(parent.runId, { charged, uncharged, unattributed });
  }
  return perParent;
}

/**
 * Count fix attempts via the per-attempt `fixOutcomeClass` taxonomy: CHARGED =
 * {ci-red, ci-verdict-unavailable} (src/fixloop/escalation.ts:69). A class
 * string outside the EscalationClass union and a `fixAttemptRunIds` entry
 * resolving to no record are both UNATTRIBUTED — the TDI counter's signal
 * kind. A resolved attempt with no written class is uncharged (not terminal,
 * no defect signal yet).
 */
export function countChargedFixAttempts(
  records: RunRecordLike[],
): { charged: number; uncharged: number; unattributed: number } {
  const counts = { charged: 0, uncharged: 0, unattributed: 0 };
  for (const perParent of attemptCountsByParent(records).values()) {
    counts.charged += perParent.charged;
    counts.uncharged += perParent.uncharged;
    counts.unattributed += perParent.unattributed;
  }
  return counts;
}

// ─── deterministic bytes + hash ──────────────────────────────────────────────

/** Deterministic key-sorted JSON — same data, same bytes, whatever the key order. */
export function stableStringify(value: unknown): string {
  return JSON.stringify(sortForStable(value));
}

function sortForStable(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortForStable);
  if (v !== null && typeof v === "object") {
    return Object.fromEntries(
      Object.keys(v as Record<string, unknown>)
        .sort()
        .map((k) => [k, sortForStable((v as Record<string, unknown>)[k])]),
    );
  }
  return v;
}

/** sha256 over stableStringify, hex — the payload hash behind the retain documentId. */
export function payloadHashHex(payload: unknown): string {
  return new Bun.CryptoHasher("sha256").update(stableStringify(payload)).digest("hex");
}

// ─── the DD-20 spend join ────────────────────────────────────────────────────

export type FactorySpendRow = { runId: string; workKey: string | null; microUsd: number; eventCount: number };

export const SpendJoinSchema = z.strictObject({
  /** The components the match predicate actually compares (F-005; see module docblock). */
  join_key: z.literal("workKey+runId"),
  factory_micro_usd_total: z.number().int(),
  factory_event_count: z.number().int(),
  gateway_row_count: z.number().int().nullable(),
  gateway_micro_usd_total: z.number().int().nullable(),
  /** Exact-duplicate import rows coalesced (F-006); null exactly when the import is absent. */
  gateway_duplicate_rows: z.number().int().nullable(),
  /** MATCHED rows only (cost numerator); null exactly when the import is absent. */
  gateway_matched_micro_usd: z.number().int().nullable(),
  matched_gateway_rows: z.number().int(),
  unmatched_gateway_rows: z.number().int().nullable(),
  missing_gateway_rows: z.number().int().nullable(),
  spend_incomplete: z.boolean(),
});

export type SpendJoin = z.infer<typeof SpendJoinSchema>;

/** Aggregate µ$ guard (F-017): totals past 2^53 refuse typed — never round. */
function guardedMicroUsd(total: number, field: string): number {
  if (!Number.isSafeInteger(total)) {
    throw new KpiError(
      "aggregate-overflow",
      `spend join field ${field} = ${total} exceeds the safe-integer range across rows`,
      "narrow the KPI window — aggregate micro-USD is integer µ$ end-to-end and never rounds (INV-A5-2)",
    );
  }
  return total;
}

/**
 * Join both spend ledgers on the DD-20 canonical key. Match rule: an import
 * row with a `runId` joins the factory row with the same (workKey, runId); a
 * `runId`-null row joins via its issueId↔workKey correspondence (its workKey
 * against any factory row's workKey — AC2's parenthetical). Import rows whose
 * canonical stableStringify equals an earlier row are COALESCED (F-006: a
 * torn/retried producer append must not double-count matched µ$): counted
 * once in every sum, surfaced in `gateway_duplicate_rows`; different-content
 * rows are distinct events. Unmatched import rows and factory rows missing an
 * import row are COUNTED, never dropped. `gateway_matched_micro_usd` sums the
 * MATCHED rows only (the cost numerator — unmatched spend never enters a
 * ratio); `gateway_micro_usd_total` keeps the ALL-rows sum for provenance.
 * `spend_incomplete` is the both-ledgers-or-flagged contract: absent import,
 * missing rows, or unmatched rows all set it — the degraded factory-only
 * curve stays green underneath the flag.
 */
export function joinSpend(factoryRows: FactorySpendRow[], gatewayImport: GatewayImport): SpendJoin {
  let factory_micro_usd_total = 0;
  for (const r of factoryRows) factory_micro_usd_total += r.microUsd;
  factory_micro_usd_total = guardedMicroUsd(factory_micro_usd_total, "factory_micro_usd_total");
  const factory_event_count = factoryRows.reduce((s, r) => s + r.eventCount, 0);
  if (gatewayImport.status === "absent") {
    return {
      join_key: "workKey+runId",
      factory_micro_usd_total,
      factory_event_count,
      gateway_row_count: null,
      gateway_micro_usd_total: null,
      gateway_duplicate_rows: null,
      gateway_matched_micro_usd: null,
      matched_gateway_rows: 0,
      unmatched_gateway_rows: null,
      missing_gateway_rows: null,
      spend_incomplete: true,
    };
  }
  const seenCanonical = new Set<string>();
  const rows = gatewayImport.rows.filter((g) => {
    const canonical = stableStringify(g);
    if (seenCanonical.has(canonical)) return false; // exact duplicate — coalesced, counted once in every sum
    seenCanonical.add(canonical);
    return true;
  });
  const gateway_duplicate_rows = gatewayImport.rows.length - rows.length;
  // Factory rows indexed by workKey once (F-021): the import side matches via
  // the index, same semantics as the prior nested loop. A null-workKey factory
  // row can never join (import workKey is validated non-empty).
  const byWorkKey = new Map<string, FactorySpendRow[]>();
  for (const f of factoryRows) {
    if (f.workKey === null) continue;
    const bucket = byWorkKey.get(f.workKey);
    if (bucket === undefined) byWorkKey.set(f.workKey, [f]);
    else bucket.push(f);
  }
  const matchedRows = new Set<FactorySpendRow>();
  let matched = 0;
  let matchedMicro = 0;
  let unmatched = 0;
  for (const g of rows) {
    const candidates = byWorkKey.get(g.workKey) ?? [];
    const hits = g.runId !== null ? candidates.filter((f) => f.runId === g.runId) : candidates;
    if (hits.length > 0) {
      matched++;
      matchedMicro += g.cost_micro_usd; // once per import row, however many factory rows it joins
      for (const f of hits) matchedRows.add(f);
    } else unmatched++;
  }
  const missing = factoryRows.length - matchedRows.size;
  return {
    join_key: "workKey+runId",
    factory_micro_usd_total,
    factory_event_count,
    gateway_row_count: rows.length,
    gateway_micro_usd_total: guardedMicroUsd(
      rows.reduce((s, r) => s + r.cost_micro_usd, 0),
      "gateway_micro_usd_total",
    ),
    gateway_duplicate_rows,
    gateway_matched_micro_usd: guardedMicroUsd(matchedMicro, "gateway_matched_micro_usd"),
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

/** Read-side dimension join over a JSONL source: ENOENT → typed absent; present → line count. Used for J3's routing log. */
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

/**
 * Routing-decision dimension (AC4): joins each routing-log line by its OWNED
 * key — `runId` — against the in-window run ids, and reports JOINED decisions
 * only. A line whose runId is outside the window (stale) and a line with no
 * runId field each carry no joinable key and are not counted. A non-JSON line
 * that is NOT the final non-blank line is a typed `routing-log-invalid` fault
 * (F-011); the final non-blank line failing to parse is TOLERATED and not
 * counted — a concurrent appender's torn tail. ENOENT → typed absent.
 */
export function readRoutingLogDimension(
  source: string,
  path: string,
  inWindowRunIds: ReadonlySet<string>,
): Dimension {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return absentDimension(source);
    throw e;
  }
  const rawLines = text.split("\n");
  let lastNonBlank = -1;
  for (const [i, raw] of rawLines.entries()) {
    if (raw.trim() !== "") lastNonBlank = i;
  }
  let count = 0;
  for (const [i, raw] of rawLines.entries()) {
    const line = raw.trim();
    if (line === "") continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      if (i === lastNonBlank) continue; // torn tail — tolerated, not counted
      throw new KpiError(
        "routing-log-invalid",
        `routing log ${path} line ${i + 1} is not JSON`,
        "a corrupt non-tail routing line is a fault — inspect the log before recomputing KPIs (only a torn final line is tolerated)",
      );
    }
    const runId = parsed !== null && typeof parsed === "object" ? (parsed as Record<string, unknown>).runId : undefined;
    if (typeof runId === "string" && inWindowRunIds.has(runId)) count++;
  }
  return { source, status: "joined", count };
}
