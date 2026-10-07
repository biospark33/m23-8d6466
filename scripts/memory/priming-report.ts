#!/usr/bin/env bun
/**
 * M1.3 priming-report — the interim join: side-channel cycles × retain
 * receipts × exact ledger micros, honestly labeled.
 *
 * Read-only posture (INV-PH-2): the cost ledger opens via openReadOnly, the
 * audit db via a readonly sqlite handle, and an absent source stays absent —
 * a section with no data is omitted with a dataNote, never zero-filled, and
 * an absent ledger file is never created by a reader.
 *
 * Every cross-group delta carries CORRELATION_NOTE; the report vocabulary is
 * restricted to observational labeling. The DD-22 checkpoint surfaces as
 * checkpointEligible only — no evaluation or migration code exists here
 * (INV-PH-3); the decision is the operator's at the dated checkpoint.
 *
 * CLI: bun scripts/memory/priming-report.ts
 *   exit 0 (cyclesToDate + checkpointEligible + artifact paths on stdout)
 */

import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeSync } from "node:fs";
import { dirname, join } from "node:path";
import { DEFAULT_RECALL_DIR } from "../../src/hindsight/kg-context.ts";
import { DISPATCH_FAILURE_LOG } from "../../src/fleet/dispatch.ts";
import { atomicReplaceFile } from "../../src/providers/fs-atomic.ts";
import { CostLedger, DEFAULT_COST_LEDGER_FILE } from "../../src/providers/cost-ledger.ts";
import { acquireRunLock, releaseRunLock, RunLockedError, RunLockReentrantError, type RunLockHandle } from "../lib/run-lock.ts";
import { CORRELATION_NOTE, renderReportMd, type CostGroup, type ReportMetrics } from "./report-render.ts";
import {
  DEFAULT_AUDIT_DB_FILE,
  DEFAULT_P09_EVIDENCE_DIR,
  DEFAULT_PROBE_SET_FILE,
  DEFAULT_REPORTS_DIR,
  PROBE_WRITER_LOCK_ID,
  SEED_PROBE_BANK,
  loadP09MintRecords,
  loadReceiptMintRecords,
  mintMembershipViolations,
  parseProbeSet,
  type Probe,
} from "./probe-schema.ts";

export interface PrimingReportDeps {
  recallDir?: string;
  ledgerPath?: string;
  auditPath?: string;
  dispatchLogPath?: string;
  reportsDir?: string;
  probeSetPath?: string;
  p09EvidenceDir?: string;
  now?: () => Date;
}

/** Loosely shape-checked side-channel row (the 7 RecallRow keys, read defensively). */
interface SideRow {
  runId: string;
  primed: boolean;
  latencyMs: number;
  recalledDocumentIds?: string[];
}

/**
 * Read `<dir>/*.json` side-channel rows; malformed rows are skipped (data,
 * not code). Dedupe on runId — last write wins by file mtime.
 */
function readSideChannel(recallDir: string): Map<string, SideRow> {
  let names: string[];
  try {
    names = readdirSync(recallDir).filter((n) => n.endsWith(".json"));
  } catch {
    return new Map(); // absent dir → zero cycles counted, never a crash
  }
  const stamped: { row: SideRow; mtimeMs: number; name: string }[] = [];
  for (const name of names) {
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(join(recallDir, name), "utf8"));
    } catch {
      continue;
    }
    const row = raw as Partial<SideRow> | null;
    if (
      typeof row !== "object" ||
      row === null ||
      typeof row.runId !== "string" ||
      typeof row.primed !== "boolean" ||
      // F-016: a latency is a finite non-negative number — Infinity/NaN/
      // negative values are malformed rows, skipped like any other bad shape.
      typeof row.latencyMs !== "number" ||
      !Number.isFinite(row.latencyMs) ||
      row.latencyMs < 0
    ) {
      continue;
    }
    let mtimeMs = 0;
    try {
      mtimeMs = statSync(join(recallDir, name)).mtimeMs;
    } catch {
      // We just read the file; a stat race keeps the row at mtime 0.
    }
    stamped.push({ row: row as SideRow, mtimeMs, name });
  }
  stamped.sort((a, b) => a.mtimeMs - b.mtimeMs || a.name.localeCompare(b.name));
  const winners = new Map<string, SideRow>();
  for (const s of stamped) winners.set(s.row.runId, s.row);
  return winners;
}

/** DISTINCT receipt runIds (subject_id) — a LEFT-JOIN key set, never a filter. */
function readReceiptRunIds(auditPath?: string): Set<string> {
  const path = auditPath ?? process.env.QDS_AUDIT_DB ?? DEFAULT_AUDIT_DB_FILE;
  const ids = new Set<string>();
  if (!existsSync(path)) return ids; // absent db stays absent, never created
  // F-008: the existsSync check races the open, and a non-sqlite file at the
  // path throws — an unreadable audit db is absent data (empty set), never a
  // crash that kills the report.
  let rows: { subject_id: unknown }[];
  let db: Database | undefined;
  try {
    db = new Database(path, { readonly: true });
    rows = db
      .prepare(`SELECT DISTINCT subject_id FROM audit_links WHERE hop='memory-retain-receipt'`)
      .all() as { subject_id: unknown }[];
  } catch {
    return ids;
  } finally {
    db?.close();
  }
  for (const r of rows) if (typeof r.subject_id === "string") ids.add(r.subject_id);
  return ids;
}

/** Exact integer micro-usd per group; a run absent from the ledger reads 0. */
function costGroup(rows: SideRow[], ledger: CostLedger): CostGroup {
  let total = 0;
  for (const r of rows) total += ledger.readRunCost(r.runId).totalMicroUsd;
  return {
    runs: rows.length,
    totalMicroUsd: total,
    meanMicroUsd: rows.length === 0 ? 0 : total / rows.length,
  };
}

function latencyGroup(rows: SideRow[]): { runs: number; meanLatencyMs: number } {
  const total = rows.reduce((sum, r) => sum + r.latencyMs, 0);
  return { runs: rows.length, meanLatencyMs: rows.length === 0 ? 0 : total / rows.length };
}

/** Line count of an existing log; undefined when present-but-unreadable (F-010). */
function countDispatchFailures(path: string): number | undefined {
  try {
    return readFileSync(path, "utf8")
      .split("\n")
      .filter((l) => l.trim().length > 0).length;
  } catch {
    return undefined;
  }
}

function slugOf(docId: string): string {
  return (
    docId
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "doc"
  );
}

/**
 * Append-only probe growth: candidate ids from side-channel recalledDocumentIds
 * (banked as SEED_PROBE_BANK) plus P0.9 mint ids for banks already in the probe
 * set — each candidate labeled with the bank that actually minted it and
 * origin:"cycle" (F-012), minus ids the existing probes already reference.
 * Membership is gated through the SAME probe-schema integrity path as the
 * run-time label-integrity check (mintMembershipViolations, F-021) — one
 * shared definition of "this label is real". A candidate failing the gate
 * appends nothing; existing rows are never rewritten.
 */
async function growProbeSet(args: {
  probeSetPath: string;
  auditPath?: string;
  p09EvidenceDir: string;
  winners: Map<string, SideRow>;
}): Promise<number> {
  const probeSetPath = args.probeSetPath;
  if (!existsSync(probeSetPath)) return 0;
  let existing: Probe[];
  try {
    const parsed = parseProbeSet(JSON.parse(readFileSync(probeSetPath, "utf8")));
    if (!parsed.ok) return 0; // cannot append into an unreadable set; leave it untouched
    existing = parsed.value;
  } catch {
    return 0;
  }

  const coveredIds = new Set(existing.flatMap((p) => p.expectedDocumentIds));
  const coveredProbeIds = new Set(existing.map((p) => p.probeId));
  const existingBanks = new Set(existing.map((p) => p.bank));

  const candidates = new Map<string, Probe>(); // key `${bank}/${docId}` — a doc minted into two banks is two probes
  const add = (docId: string, bank: Probe["bank"]): void => {
    if (coveredIds.has(docId)) return;
    const key = `${bank}/${docId}`;
    if (candidates.has(key)) return;
    candidates.set(key, {
      probeId: `cycle-${slugOf(docId)}`,
      query: `recall probe for document ${docId}`,
      expectedDocumentIds: [docId],
      bank,
      origin: "cycle",
    });
  };
  for (const row of args.winners.values()) {
    for (const id of row.recalledDocumentIds ?? []) if (typeof id === "string") add(id, SEED_PROBE_BANK);
  }
  for (const [bank, ids] of loadP09MintRecords(args.p09EvidenceDir)) {
    if (!existingBanks.has(bank)) continue;
    for (const id of ids) add(id, bank);
  }

  const mint = mergeMint(loadP09MintRecords(args.p09EvidenceDir), loadReceiptMintRecords(args.auditPath));
  // Shared integrity path: any candidate whose (bank, docId) membership fails
  // the same check probe-recall's gate applies is excluded — growth must only
  // ever append probes that would PASS the run-time label gate.
  const violating = new Set(mintMembershipViolations([...candidates.values()], mint).map((v) => v.probeId));
  const seenProbeIds = new Set<string>(); // slugOf collisions dedupe first-wins
  const survivors = [...candidates.values()].filter((c) => {
    if (violating.has(c.probeId) || coveredProbeIds.has(c.probeId) || seenProbeIds.has(c.probeId)) return false;
    seenProbeIds.add(c.probeId);
    return true;
  });
  if (survivors.length === 0) return 0;

  // Single-writer discipline on the probes dir (the corpus-writer precedent).
  // Not re-entrant and contention-refusing, so poll with backoff until the
  // holder releases (bounded, ~5s).
  const lockDir = dirname(probeSetPath);
  const deadline = Date.now() + 5_000;
  let lock: RunLockHandle | undefined;
  for (;;) {
    try {
      lock = acquireRunLock(lockDir, PROBE_WRITER_LOCK_ID, "priming-report growth");
      break;
    } catch (e) {
      const retryable = e instanceof RunLockedError || e instanceof RunLockReentrantError;
      if (!retryable || Date.now() > deadline) throw e;
      await Bun.sleep(25);
    }
  }
  try {
    // Re-read under the lock: another writer may have appended while we waited.
    // F-005: same guard as the pre-lock read — an unreadable set appends nothing.
    let fresh: ReturnType<typeof parseProbeSet>;
    try {
      fresh = parseProbeSet(JSON.parse(readFileSync(probeSetPath, "utf8")));
    } catch {
      return 0;
    }
    if (!fresh.ok) return 0;
    const haveIds = new Set(fresh.value.flatMap((p) => p.expectedDocumentIds));
    const haveProbeIds = new Set(fresh.value.map((p) => p.probeId));
    // F-006: dedupe on probeId as well as docId — within-batch slugOf
    // collisions must not produce a set our own parser refuses.
    const seen = new Set<string>();
    const toAppend = survivors.filter((c) => {
      const id = c.expectedDocumentIds[0];
      if (id === undefined || haveIds.has(id) || haveProbeIds.has(c.probeId) || seen.has(c.probeId)) return false;
      seen.add(c.probeId);
      return true;
    });
    if (toAppend.length === 0) return 0;
    mkdirSync(lockDir, { recursive: true });
    atomicReplaceFile(probeSetPath, `${JSON.stringify([...fresh.value, ...toAppend], null, 2)}\n`);
    return toAppend.length;
  } finally {
    if (lock !== undefined) releaseRunLock(lock);
  }
}

/** Union of mint records per bank — neither source alone is the truth. */
function mergeMint(a: Map<string, Set<string>>, b: Map<string, Set<string>>): Map<string, Set<string>> {
  const merged: Map<string, Set<string>> = new Map();
  for (const source of [a, b]) {
    for (const [bank, ids] of source) {
      const into = merged.get(bank) ?? new Set<string>();
      for (const id of ids) into.add(id);
      merged.set(bank, into);
    }
  }
  return merged;
}

export { renderReportMd };
export type { ReportMetrics };

export async function runPrimingReport(deps: PrimingReportDeps = {}): Promise<{
  metrics: ReportMetrics;
  jsonPath: string;
  mdPath: string;
  appendedProbes: number;
}> {
  const now = deps.now ?? (() => new Date());
  const generatedAt = now().toISOString();
  const recallDir = deps.recallDir ?? DEFAULT_RECALL_DIR;
  const reportsDir = deps.reportsDir ?? DEFAULT_REPORTS_DIR;
  const probeSetPath = deps.probeSetPath ?? DEFAULT_PROBE_SET_FILE;
  const ledgerPath = deps.ledgerPath ?? process.env.QDS_COST_LEDGER_FILE ?? DEFAULT_COST_LEDGER_FILE;
  // F-010: the dispatch failure log is reachable from the CLI by default —
  // no env/deps required to surface it.
  const dispatchLogPath = deps.dispatchLogPath ?? DISPATCH_FAILURE_LOG;

  const winners = readSideChannel(recallDir);
  const cyclesToDate = winners.size;
  const rows = [...winners.values()];
  const primedCount = rows.filter((r) => r.primed).length;
  const unprimedCount = cyclesToDate - primedCount;

  // Receipt LEFT-JOIN: presence is a per-cycle data-quality field — a
  // receipt-less cycle still counts.
  const receiptRunIds = readReceiptRunIds(deps.auditPath);
  let withReceipt = 0;
  for (const r of rows) if (receiptRunIds.has(r.runId)) withReceipt += 1;

  const dataNotes: string[] = [];
  const primedRows = rows.filter((r) => r.primed);
  const unprimedRows = rows.filter((r) => !r.primed);

  // Cost join — exact integer micro-usd. F-004: a PRESENT-but-unreadable
  // ledger is absent data too (costTable undefined + note), never fatal.
  let costTable: ReportMetrics["costTable"];
  if (existsSync(ledgerPath)) {
    try {
      const ledger = CostLedger.openReadOnly({ path: ledgerPath });
      try {
        costTable = { primed: costGroup(primedRows, ledger), unprimed: costGroup(unprimedRows, ledger) };
      } finally {
        ledger.close();
      }
    } catch (e) {
      dataNotes.push(`cost ledger unreadable at ${ledgerPath} (${(e as Error).message}); costTable omitted`);
    }
  } else {
    dataNotes.push(
      `cost ledger not found at ${ledgerPath}; costTable omitted — an absent source stays absent, never zero-filled`,
    );
  }
  // F-009: a ledger that exists but carries no events for any observed cycle
  // would print as all-zeros — omit it with a note instead (absent, not 0).
  if (
    costTable !== undefined &&
    costTable.primed.runs === 0 &&
    costTable.unprimed.runs === 0 &&
    costTable.primed.totalMicroUsd === 0 &&
    costTable.unprimed.totalMicroUsd === 0
  ) {
    costTable = undefined;
    dataNotes.push("cost ledger has no events for the observed cycles; costTable omitted — absent, not 0");
  }

  dataNotes.push(
    "exitClassification is not available offline: it lives in the memory-retain retained payload, not in run records — absent section, not 0",
  );
  // F-009: zero observed cycles would print two all-zero outcome rows — the
  // table is omitted below with a note instead (absent, not 0).
  if (cyclesToDate === 0) {
    dataNotes.push("no observed cycles: outcomeTable and per-cycle rows omitted — absent, not 0");
  }

  // F-007: growth is auxiliary — a lock deadline or any other throw degrades
  // to appendedProbes 0 + a dataNote; the report itself always completes.
  let appendedProbes = 0;
  try {
    appendedProbes = await growProbeSet({
      probeSetPath,
      auditPath: deps.auditPath,
      p09EvidenceDir: deps.p09EvidenceDir ?? DEFAULT_P09_EVIDENCE_DIR,
      winners,
    });
  } catch (e) {
    dataNotes.push(`probe growth skipped: ${(e as Error).message}`);
  }

  const metrics: ReportMetrics = {
    generatedAt,
    cyclesToDate,
    primedCount,
    unprimedCount,
    receiptCoverage: { withReceipt, withoutReceipt: cyclesToDate - withReceipt },
    ...(costTable !== undefined ? { costTable } : {}),
    // F-009: zero observed cycles would print two all-zero rows — the table
    // is omitted with a note instead (absent, not 0).
    ...(cyclesToDate > 0
      ? { outcomeTable: { primed: latencyGroup(primedRows), unprimed: latencyGroup(unprimedRows) } }
      : {}),
    // F-020: the per-cycle rows behind every aggregate (deduped winners, in
    // mtime order); absent entirely at zero cycles.
    ...(cyclesToDate > 0
      ? {
          cycles: rows.map((r) => ({
            runId: r.runId,
            primed: r.primed,
            receiptPresent: receiptRunIds.has(r.runId),
            latencyMs: r.latencyMs,
          })),
        }
      : {}),
    checkpointEligible: cyclesToDate >= 30,
    correlationNote: CORRELATION_NOTE,
    dataNotes,
    appendedProbes,
  };
  // F-010: counted only when the log exists; a present-but-unreadable log is
  // a dataNote, never a comforting silent 0.
  if (existsSync(dispatchLogPath)) {
    const dispatchFailures = countDispatchFailures(dispatchLogPath);
    if (dispatchFailures === undefined) {
      dataNotes.push(`dispatch failure log unreadable at ${dispatchLogPath}; dispatchFailures omitted`);
    } else {
      metrics.dispatchFailures = dispatchFailures;
    }
  }

  const day = generatedAt.slice(0, 10);
  mkdirSync(reportsDir, { recursive: true });
  const jsonPath = join(reportsDir, `${day}-interim.json`);
  const mdPath = join(reportsDir, `${day}-interim.md`);
  atomicReplaceFile(jsonPath, `${JSON.stringify(metrics, null, 2)}\n`);
  atomicReplaceFile(mdPath, renderReportMd(metrics));
  return { metrics, jsonPath, mdPath, appendedProbes };
}

/**
 * Pure renderer (AC5): reads ONLY its parameter, so the md is always
 * re-derivable from the metrics JSON — the JSON alone is the deliverable.
 */
if (import.meta.main) {
  try {
    const res = await runPrimingReport();
    writeSync(1, `cyclesToDate=${res.metrics.cyclesToDate} checkpointEligible=${res.metrics.checkpointEligible}\njson=${res.jsonPath}\nmd=${res.mdPath}\n`);
    process.exit(0);
  } catch (e) {
    writeSync(2, `priming-report failed: ${(e as Error).message}\n`);
    process.exit(1);
  }
}
