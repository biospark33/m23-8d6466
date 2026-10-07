#!/usr/bin/env bun
/**
 * M1.3 priming-report — the interim join: side-channel cycles × retain
 * receipts × exact ledger micros, honestly labeled.
 *
 * Read-only posture (INV-PH-2): the cost ledger opens via openReadOnly, the
 * audit db via a readonly sqlite handle, and an absent source stays absent —
 * a section with no data is omitted, never zero-filled, and an absent ledger
 * file is never created by a reader. dataNotes name the PRESENT-but-unreadable
 * sources (E4 audit db, E5 side-channel rows); an ABSENT dispatch log is the
 * normal pre-first-dispatch state, so dispatchFailures omits silently — only a
 * present-but-unreadable log gets the note.
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
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeSync } from "node:fs";
import { dirname, join } from "node:path";
import { DEFAULT_RECALL_DIR } from "../../src/hindsight/kg-context.ts";
import { DISPATCH_FAILURE_LOG } from "../../src/fleet/dispatch.ts";
import { atomicReplaceFile } from "../../src/providers/fs-atomic.ts";
import { CostLedger, DEFAULT_COST_LEDGER_FILE } from "../../src/providers/cost-ledger.ts";
import { acquireRunLock, releaseRunLock, RunLockedError, type RunLockHandle } from "../lib/run-lock.ts";
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
  mergeMint,
  mintMembershipViolations,
  parseProbeSet,
  withCwd,
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

/**
 * Loosely shape-checked side-channel row. R2-14: exactly what the reader
 * VALIDATES is runId (string), primed (boolean), and latencyMs (finite,
 * non-negative). The remaining RecallRow keys — directive, banks, chars,
 * recalledDocumentIds — are NOT consulted by the validator; downstream
 * consumers read them defensively (growth credits row.banks[0] only when it
 * is a non-empty string, else SEED_PROBE_BANK).
 */
interface SideRow {
  runId: string;
  primed: boolean;
  latencyMs: number;
  banks?: string[];
  recalledDocumentIds?: string[];
}

/**
 * Read `<dir>/*.json` side-channel rows; malformed rows are skipped (data,
 * not code). Dedupe on runId — last write wins by file mtime.
 * R2-005: ENOENT stays absent (zero cycles, no note); any other readdir
 * failure (EACCES, ENOTDIR, …) surfaces as readError so the report can say
 * WHY it counted zero cycles instead of collapsing real data behind the
 * failure into a silent fresh-factory report.
 * E5: a row file that EXISTS but cannot be READ (EACCES mid-dir, a directory
 * where a row should be → EISDIR) is counted in unreadableRows — distinct
 * from a malformed-but-readable row, which still skips silently.
 */
function readSideChannel(recallDir: string): {
  winners: Map<string, SideRow>;
  readError?: string;
  unreadableRows: number;
} {
  let names: string[];
  try {
    names = readdirSync(recallDir).filter((n) => n.endsWith(".json"));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return { winners: new Map(), unreadableRows: 0 };
    return {
      winners: new Map(),
      readError: (e as NodeJS.ErrnoException).code ?? (e as Error).message,
      unreadableRows: 0,
    };
  }
  const stamped: { row: SideRow; mtimeMs: number; name: string }[] = [];
  let unreadableRows = 0;
  for (const name of names) {
    let text: string;
    try {
      text = readFileSync(join(recallDir, name), "utf8");
    } catch (e) {
      // ENOENT is a read/delete race on a file we listed — not a hidden row.
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") unreadableRows += 1;
      continue;
    }
    let raw: unknown;
    try {
      raw = JSON.parse(text);
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
  return { winners, unreadableRows };
}

/**
 * DISTINCT receipt runIds (run_id) — a LEFT-JOIN key set, never a filter. The
 * join is on the RUN (AC4: cycles are deduped on runId), so the receipt row's
 * run_id column is the key — NOT subject_id, which is the retain's documentId
 * (probe-schema's loadReceiptMintRecords keys on it for mint membership, a
 * different join). The two happen to be equal on every row M1.2 writes today
 * (deriveDocumentId returns the runId verbatim), but this reader keys on
 * run_id by name, not by that upstream alias.
 * E4: a PRESENT-but-unreadable db (SQLITE_BUSY, corruption, non-sqlite) is
 * reported via `unreadable` so receiptCoverage 0 is labeled as hidden data,
 * not silently indistinguishable from an absent db.
 */
function readReceiptRunIds(auditPath: string): { ids: Set<string>; unreadable?: string } {
  const ids = new Set<string>();
  if (!existsSync(auditPath)) return { ids }; // absent db stays absent, never created
  // F-008: the existsSync check races the open, and a non-sqlite file at the
  // path throws — an unreadable audit db is absent data (empty set), never a
  // crash that kills the report.
  let rows: { run_id: unknown }[];
  let db: Database | undefined;
  try {
    db = new Database(auditPath, { readonly: true });
    rows = db
      .prepare(`SELECT DISTINCT run_id FROM audit_links WHERE hop='memory-retain-receipt'`)
      .all() as { run_id: unknown }[];
  } catch (e) {
    return { ids, unreadable: (e as NodeJS.ErrnoException).code ?? (e as Error).message };
  } finally {
    db?.close();
  }
  for (const r of rows) if (typeof r.run_id === "string") ids.add(r.run_id);
  return { ids };
}

/** Exact integer micro-usd per group (R2-001: emitted only when every counted cycle is fully priced — see joinCost). */
function costGroup(rows: SideRow[], ledger: CostLedger): CostGroup {
  let total = 0;
  for (const r of rows) total += ledger.readRunCost(r.runId).totalMicroUsd;
  return {
    runs: rows.length,
    totalMicroUsd: total,
    meanMicroUsd: rows.length === 0 ? 0 : total / rows.length,
  };
}

/**
 * R2-001: the cost join branches on the CostView fields the ledger already
 * provides, per run — hasEvents === false → that cycle's cost is ABSENT
 * (excluded from any printed total, counted for the note); hasTokenRows ===
 * false || unpricedRows > 0 → PARTIAL (total included, flagged); otherwise
 * the cycle is fully priced and its figure may print as a number.
 */
function joinCost(
  primedRows: SideRow[],
  unprimedRows: SideRow[],
  ledger: CostLedger,
): {
  primed: CostGroup;
  unprimed: CostGroup;
  pricedCycles: number;
  absentCycles: number;
  partialCycles: number;
} {
  let pricedCycles = 0;
  let absentCycles = 0;
  let partialCycles = 0;
  for (const r of [...primedRows, ...unprimedRows]) {
    const view = ledger.readRunCost(r.runId);
    if (!view.hasEvents) absentCycles += 1;
    else if (!view.hasTokenRows || view.unpricedRows > 0) partialCycles += 1;
    else pricedCycles += 1;
  }
  return {
    primed: costGroup(primedRows, ledger),
    unprimed: costGroup(unprimedRows, ledger),
    pricedCycles,
    absentCycles,
    partialCycles,
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
 * (R2-014: credited to row.banks[0] when it is a non-empty string, else
 * SEED_PROBE_BANK) plus P0.9 mint ids for banks already in the probe set —
 * each candidate labeled with the bank that actually minted it and
 * origin:"cycle" (F-012), minus ids the existing probes already reference.
 * Membership is gated through the SAME probe-schema integrity path as the
 * run-time label-integrity check (mintMembershipViolations, F-021) — one
 * shared definition of "this label is real", so a mislabeled candidate is
 * refused, never appended. A candidate failing the gate appends nothing;
 * existing rows are never rewritten.
 *
 * R2-011: the three silent skip paths (pre-lock parse fail, pre-lock read
 * throw, under-lock re-read fail) return a note so the report can carry a
 * dataNote instead of an unexplained appendedProbes 0. An ABSENT probe set is
 * a fresh factory, not a failure — silent 0, no note.
 */
async function growProbeSet(args: {
  probeSetPath: string;
  auditPath?: string;
  p09EvidenceDir: string;
  winners: Map<string, SideRow>;
}): Promise<{ count: number; note?: string; byOrigin?: { seed: number; cycle: number } }> {
  const probeSetPath = args.probeSetPath;
  const unreadableNote = (): { count: 0; note: string } => ({
    count: 0,
    note: `probe growth skipped: probe set unreadable at ${withCwd(probeSetPath)}`,
  });
  if (!existsSync(probeSetPath)) return { count: 0 };
  let existing: Probe[];
  try {
    const parsed = parseProbeSet(JSON.parse(readFileSync(probeSetPath, "utf8")));
    if (!parsed.ok) return unreadableNote(); // cannot append into an unreadable set; leave it untouched
    existing = parsed.value;
  } catch {
    return unreadableNote();
  }

  const byOrigin = {
    seed: existing.filter((p) => p.origin === "seed").length,
    cycle: existing.filter((p) => p.origin === "cycle").length,
  };
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
    // R2-014: banks is NOT a validated field (see SideRow) — credit the first
    // entry only when it reads as a non-empty string, else the seed bank. The
    // mint gate below still validates membership, so a mislabeled candidate
    // refuses rather than appending.
    const rowBank = row.banks?.[0];
    const bank: Probe["bank"] =
      typeof rowBank === "string" && rowBank.length > 0 ? (rowBank as Probe["bank"]) : SEED_PROBE_BANK;
    for (const id of row.recalledDocumentIds ?? []) if (typeof id === "string") add(id, bank);
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
  if (survivors.length === 0) return { count: 0, byOrigin };

  // Single-writer discipline on the probes dir (the corpus-writer precedent).
  // Not re-entrant and contention-refusing, so poll until the holder releases
  // (bounded, ~5s). R2-015: only RunLockedError is retryable — a
  // RunLockReentrantError is a nesting bug in THIS process, and spinning on it
  // forever would hide exactly the bug it exists to surface.
  const lockDir = dirname(probeSetPath);
  const deadline = Date.now() + 5_000;
  let lock: RunLockHandle | undefined;
  for (;;) {
    try {
      lock = acquireRunLock(lockDir, PROBE_WRITER_LOCK_ID, "priming-report growth");
      break;
    } catch (e) {
      if (!(e instanceof RunLockedError) || Date.now() > deadline) throw e;
      await Bun.sleep(25);
    }
  }
  try {
    // Re-read under the lock: another writer may have appended while we waited.
    // F-005/R2-011: same guard as the pre-lock read — an unreadable set appends
    // nothing, and says so.
    let fresh: ReturnType<typeof parseProbeSet>;
    try {
      fresh = parseProbeSet(JSON.parse(readFileSync(probeSetPath, "utf8")));
    } catch {
      return { ...unreadableNote(), byOrigin };
    }
    if (!fresh.ok) return { ...unreadableNote(), byOrigin };
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
    if (toAppend.length === 0) return { count: 0, byOrigin };
    mkdirSync(lockDir, { recursive: true });
    atomicReplaceFile(probeSetPath, `${JSON.stringify([...fresh.value, ...toAppend], null, 2)}\n`);
    return { count: toAppend.length, byOrigin };
  } finally {
    if (lock !== undefined) releaseRunLock(lock);
  }
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

  const side = readSideChannel(recallDir);
  const winners = side.winners;
  const cyclesToDate = winners.size;
  const rows = [...winners.values()];
  const primedCount = rows.filter((r) => r.primed).length;
  const unprimedCount = cyclesToDate - primedCount;

  const dataNotes: string[] = [];
  // R2-005: a recallDir that exists but cannot be read (EACCES, a file where
  // the dir should be, …) collapses to zero cycles — say so instead of
  // printing a fresh-factory report over real data hidden behind the failure.
  if (side.readError !== undefined) {
    dataNotes.push(`side-channel dir unreadable at ${withCwd(recallDir)} (${side.readError}); cycles counted as 0`);
  }
  // E5: rows the dir listing SAW but the read could not return (EACCES,
  // dir-as-row) — data hidden behind the failure, named at row granularity.
  if (side.unreadableRows > 0) {
    dataNotes.push(`${side.unreadableRows} side-channel row(s) unreadable and skipped`);
  }

  // Receipt LEFT-JOIN: presence is a per-cycle data-quality field — a
  // receipt-less cycle still counts. E4: a present-but-unreadable audit db
  // gets a note so coverage 0 is not mistaken for absent data.
  const receiptPath = deps.auditPath ?? process.env.QDS_AUDIT_DB ?? DEFAULT_AUDIT_DB_FILE;
  const receipts = readReceiptRunIds(receiptPath);
  const receiptRunIds = receipts.ids;
  if (receipts.unreadable !== undefined) {
    dataNotes.push(`audit db unreadable at ${withCwd(receiptPath)} (${receipts.unreadable}); receiptCoverage reported 0`);
  }
  let withReceipt = 0;
  for (const r of rows) if (receiptRunIds.has(r.runId)) withReceipt += 1;

  const primedRows = rows.filter((r) => r.primed);
  const unprimedRows = rows.filter((r) => !r.primed);

  // Cost join — R2-001: per-run branch on the CostView fields; only a
  // fully-priced figure may print as a number. costTable emits ONLY when at
  // least one observed cycle is fully priced AND none is absent; absent and
  // partial cycles carry aggregate dataNotes instead.
  // F-004: a PRESENT-but-unreadable ledger is absent data too (costTable
  // undefined + note), never fatal.
  // E2: if the ledger was READ successfully but close() then threw, the table
  // above is read-complete — the note says so instead of claiming an omitted
  // table beside a serialized one.
  let costTable: ReportMetrics["costTable"];
  if (existsSync(ledgerPath)) {
    try {
      const ledger = CostLedger.openReadOnly({ path: ledgerPath });
      try {
        const join = joinCost(primedRows, unprimedRows, ledger);
        if (join.absentCycles > 0) {
          dataNotes.push(`cost absent for ${join.absentCycles} of ${cyclesToDate} observed cycles (no ledger events)`);
        }
        if (join.partialCycles > 0) {
          dataNotes.push(`cost partial for ${join.partialCycles} cycles (unpriced rows present — tokens-not-harvested)`);
        }
        if (join.pricedCycles > 0 && join.absentCycles === 0) {
          costTable = { primed: join.primed, unprimed: join.unprimed };
        }
      } finally {
        ledger.close();
      }
    } catch (e) {
      if (costTable !== undefined) {
        dataNotes.push(`cost ledger close failed (${(e as Error).message}) — costTable above is read-complete`);
      } else {
        dataNotes.push(`cost ledger unreadable at ${withCwd(ledgerPath)} (${(e as Error).message}); costTable omitted`);
      }
    }
  } else {
    dataNotes.push(
      `cost ledger not found at ${withCwd(ledgerPath)}; costTable omitted — an absent source stays absent, never zero-filled`,
    );
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
  // R2-011: an unreadable probe set degrades the same way, with its own note.
  let appendedProbes = 0;
  let byOrigin: ReportMetrics["byOrigin"];
  try {
    const growth = await growProbeSet({
      probeSetPath,
      auditPath: deps.auditPath,
      p09EvidenceDir: deps.p09EvidenceDir ?? DEFAULT_P09_EVIDENCE_DIR,
      winners,
    });
    appendedProbes = growth.count;
    if (growth.note !== undefined) dataNotes.push(growth.note);
    // R2-004: the md surfaces the probe-set origin split so the id-anchored
    // caveat can be printed beside it whenever cycle probes exist.
    if (growth.byOrigin !== undefined) {
      byOrigin = { seed: { probes: growth.byOrigin.seed }, cycle: { probes: growth.byOrigin.cycle } };
    }
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
    ...(byOrigin !== undefined ? { byOrigin } : {}),
  };
  // F-010: counted only when the log exists; a present-but-unreadable log is
  // a dataNote, never a comforting silent 0.
  if (existsSync(dispatchLogPath)) {
    const dispatchFailures = countDispatchFailures(dispatchLogPath);
    if (dispatchFailures === undefined) {
      dataNotes.push(`dispatch failure log unreadable at ${withCwd(dispatchLogPath)}; dispatchFailures omitted`);
    } else {
      metrics.dispatchFailures = dispatchFailures;
    }
  }

  const day = generatedAt.slice(0, 10);
  mkdirSync(reportsDir, { recursive: true });
  const jsonPath = join(reportsDir, `${day}-interim.json`);
  const mdPath = join(reportsDir, `${day}-interim.md`);
  // R2-010: the json+md pair is the publication unit — a reader must never
  // observe run A's json beside run B's md (AC5's "the md is re-derivable from
  // the metrics JSON" holds at the pair level). Each file is still
  // individually atomic-replaced; the lock only serializes the pair.
  const pairDeadline = Date.now() + 5_000;
  let pairLock: RunLockHandle | undefined;
  for (;;) {
    try {
      pairLock = acquireRunLock(reportsDir, PROBE_WRITER_LOCK_ID, "interim report pair");
      break;
    } catch (e) {
      // R2-015: RunLockReentrantError is fatal — only contention retries.
      if (!(e instanceof RunLockedError) || Date.now() > pairDeadline) throw e;
      await Bun.sleep(25);
    }
  }
  try {
    // E3: the pair must not TEAR on disk — if the md replace throws after the
    // json replace landed, roll the json back to its previous bytes (or absent
    // state) before rethrowing. R2-010's lock serializes writers only; this
    // keeps AC5's re-derivability true for the lockless reader at rest too.
    const previousJson = existsSync(jsonPath) ? readFileSync(jsonPath, "utf8") : undefined;
    atomicReplaceFile(jsonPath, `${JSON.stringify(metrics, null, 2)}\n`);
    try {
      atomicReplaceFile(mdPath, renderReportMd(metrics));
    } catch (e) {
      if (previousJson !== undefined) atomicReplaceFile(jsonPath, previousJson);
      else rmSync(jsonPath, { force: true });
      throw e;
    }
  } finally {
    releaseRunLock(pairLock);
  }
  return { metrics, jsonPath, mdPath, appendedProbes };
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
