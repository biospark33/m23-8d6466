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
import { atomicReplaceFile } from "../../src/providers/fs-atomic.ts";
import { CostLedger, DEFAULT_COST_LEDGER_FILE } from "../../src/providers/cost-ledger.ts";
import { acquireRunLock, releaseRunLock, RunLockedError, RunLockReentrantError, type RunLockHandle } from "../lib/run-lock.ts";
import {
  DEFAULT_AUDIT_DB_FILE,
  DEFAULT_P09_EVIDENCE_DIR,
  DEFAULT_PROBE_SET_FILE,
  DEFAULT_REPORTS_DIR,
  PROBE_WRITER_LOCK_ID,
  SEED_PROBE_BANK,
  loadP09MintRecords,
  loadReceiptMintRecords,
  parseProbeSet,
  type MintRecords,
  type Probe,
} from "./probe-schema.ts";

export const CORRELATION_NOTE = "primed-vs-unprimed deltas are correlation (observational)";

export interface PrimingReportDeps {
  recallDir?: string;
  runsDir?: string;
  ledgerPath?: string;
  auditPath?: string;
  dispatchLogPath?: string;
  reportsDir?: string;
  probeSetPath?: string;
  p09EvidenceDir?: string;
  now?: () => Date;
}

interface CostGroup {
  runs: number;
  totalMicroUsd: number;
  meanMicroUsd: number;
}

export interface ReportMetrics {
  generatedAt: string;
  cyclesToDate: number;
  primedCount: number;
  unprimedCount: number;
  receiptCoverage: { withReceipt: number; withoutReceipt: number };
  costTable?: { primed: CostGroup; unprimed: CostGroup };
  outcomeTable: { primed: { runs: number; meanLatencyMs: number }; unprimed: { runs: number; meanLatencyMs: number } };
  checkpointEligible: boolean;
  correlationNote: string;
  dataNotes: string[];
  appendedProbes: number;
  dispatchFailures?: number;
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
      typeof row.latencyMs !== "number"
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
  const db = new Database(path, { readonly: true });
  try {
    const rows = db
      .prepare(`SELECT DISTINCT subject_id FROM audit_links WHERE hop='memory-retain-receipt'`)
      .all() as { subject_id: unknown }[];
    for (const r of rows) if (typeof r.subject_id === "string") ids.add(r.subject_id);
  } finally {
    db.close();
  }
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

function countDispatchFailures(path: string): number {
  if (!existsSync(path)) return 0;
  try {
    return readFileSync(path, "utf8")
      .split("\n")
      .filter((l) => l.trim().length > 0).length;
  } catch {
    return 0;
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
 * plus P0.9 mint ids for banks already in the probe set, minus ids the existing
 * probes already reference. Integrity is checked per-bank against the merged
 * mint records ONLY — no listBanks call here (this deps shape carries no
 * client; the seed bank's existence is already proven by the seeds). A
 * candidate failing the gate appends nothing; existing rows are never rewritten.
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

  const candidates = new Map<string, Probe>();
  const add = (docId: string): void => {
    if (coveredIds.has(docId) || candidates.has(docId)) return;
    candidates.set(docId, {
      probeId: `cycle-${slugOf(docId)}`,
      query: `recall probe for document ${docId}`,
      expectedDocumentIds: [docId],
      bank: SEED_PROBE_BANK,
    });
  };
  for (const row of args.winners.values()) {
    for (const id of row.recalledDocumentIds ?? []) if (typeof id === "string") add(id);
  }
  for (const [bank, ids] of loadP09MintRecords(args.p09EvidenceDir)) {
    if (!existingBanks.has(bank)) continue;
    for (const id of ids) add(id);
  }

  const mint: MintRecords = new Map(loadP09MintRecords(args.p09EvidenceDir));
  for (const [bank, ids] of loadReceiptMintRecords(args.auditPath)) {
    const into = new Set(mint.get(bank));
    for (const id of ids) into.add(id);
    mint.set(bank, into);
  }

  const survivors = [...candidates.values()].filter((c) => {
    const id = c.expectedDocumentIds[0];
    return id !== undefined && (mint.get(c.bank)?.has(id) ?? false) && !coveredProbeIds.has(c.probeId);
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
    const fresh = parseProbeSet(JSON.parse(readFileSync(probeSetPath, "utf8")));
    if (!fresh.ok) return 0;
    const haveIds = new Set(fresh.value.flatMap((p) => p.expectedDocumentIds));
    const haveProbeIds = new Set(fresh.value.map((p) => p.probeId));
    const toAppend = survivors.filter((c) => {
      const id = c.expectedDocumentIds[0];
      return id !== undefined && !haveIds.has(id) && !haveProbeIds.has(c.probeId);
    });
    if (toAppend.length === 0) return 0;
    mkdirSync(lockDir, { recursive: true });
    atomicReplaceFile(probeSetPath, `${JSON.stringify([...fresh.value, ...toAppend], null, 2)}\n`);
    return toAppend.length;
  } finally {
    if (lock !== undefined) releaseRunLock(lock);
  }
}

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

  // Cost join — exact integer micro-usd. Absent ledger = absent section + note.
  let costTable: ReportMetrics["costTable"];
  if (existsSync(ledgerPath)) {
    const ledger = CostLedger.openReadOnly({ path: ledgerPath });
    try {
      costTable = { primed: costGroup(primedRows, ledger), unprimed: costGroup(unprimedRows, ledger) };
    } finally {
      ledger.close();
    }
  } else {
    dataNotes.push(
      `cost ledger not found at ${ledgerPath}; costTable omitted — an absent source stays absent, never zero-filled`,
    );
  }

  dataNotes.push(
    "exitClassification is not available offline: it lives in the memory-retain retained payload, not in run records — absent section, not 0",
  );

  const appendedProbes = await growProbeSet({
    probeSetPath,
    auditPath: deps.auditPath,
    p09EvidenceDir: deps.p09EvidenceDir ?? DEFAULT_P09_EVIDENCE_DIR,
    winners,
  });

  const metrics: ReportMetrics = {
    generatedAt,
    cyclesToDate,
    primedCount,
    unprimedCount,
    receiptCoverage: { withReceipt, withoutReceipt: cyclesToDate - withReceipt },
    ...(costTable !== undefined ? { costTable } : {}),
    outcomeTable: { primed: latencyGroup(primedRows), unprimed: latencyGroup(unprimedRows) },
    checkpointEligible: cyclesToDate >= 30,
    correlationNote: CORRELATION_NOTE,
    dataNotes,
    appendedProbes,
    ...(deps.dispatchLogPath !== undefined ? { dispatchFailures: countDispatchFailures(deps.dispatchLogPath) } : {}),
  };

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
export function renderReportMd(m: ReportMetrics): string {
  const lines: string[] = [
    "# M1.3 priming interim report",
    "",
    `generatedAt: ${m.generatedAt}`,
    `cyclesToDate: ${m.cyclesToDate}`,
    `primedCount: ${m.primedCount}`,
    `unprimedCount: ${m.unprimedCount}`,
    "",
    `receiptCoverage: withReceipt=${m.receiptCoverage.withReceipt} withoutReceipt=${m.receiptCoverage.withoutReceipt} (LEFT-JOIN — receipt presence is a data-quality field, never a filter)`,
    "",
  ];
  if (m.costTable !== undefined) {
    lines.push(
      "costTable (exact integer micro-usd, read-only ledger join):",
      `  primed: runs=${m.costTable.primed.runs} totalMicroUsd=${m.costTable.primed.totalMicroUsd} meanMicroUsd=${m.costTable.primed.meanMicroUsd}`,
      `  unprimed: runs=${m.costTable.unprimed.runs} totalMicroUsd=${m.costTable.unprimed.totalMicroUsd} meanMicroUsd=${m.costTable.unprimed.meanMicroUsd}`,
      "",
    );
  } else {
    lines.push("costTable: absent (cost ledger not found — an absent source stays absent, never zero-filled)", "");
  }
  lines.push(
    "outcomeTable (mean recall latencyMs):",
    `  primed: runs=${m.outcomeTable.primed.runs} meanLatencyMs=${m.outcomeTable.primed.meanLatencyMs}`,
    `  unprimed: runs=${m.outcomeTable.unprimed.runs} meanLatencyMs=${m.outcomeTable.unprimed.meanLatencyMs}`,
    "",
    `checkpointEligible: ${m.checkpointEligible} (cyclesToDate=${m.cyclesToDate}, threshold 30)`,
    "",
    m.correlationNote,
    "",
    "dataNotes:",
    ...m.dataNotes.map((n) => `- ${n}`),
    "",
    `appendedProbes: ${m.appendedProbes}`,
  );
  if (m.dispatchFailures !== undefined) {
    lines.push(`dispatchFailures: ${m.dispatchFailures}`);
  }
  return `${lines.join("\n")}\n`;
}

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
