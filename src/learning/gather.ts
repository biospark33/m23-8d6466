/**
 * M3.2 — the AC4 read-side evidence gatherers for the L4 weekly reflect.
 *
 * One synchronous pass over the consumed stores, typed as
 * `{source, status: "absent"}` whenever a source is wholly missing — a
 * reflect never throws on absence and never fabricates a 0-as-measured (the
 * A5 dimension law, src/kpi/dimensions.ts). READ-ONLY by construction: only
 * `readFileSync`/`readdirSync` touch disk — no mkdir, no write, no append;
 * C4's consumed-stores-byte-identical guarantee is the suite's hash proof.
 *
 * Sources (all defaults under `.sandbox/`, all overridable per call):
 * - routing log `routing-log.jsonl` — J3's owned contract (story :39 field
 *   set), strict-parsed per line. Torn-TAIL tolerated (a concurrent
 *   appender's half-written final line is dropped, never counted); a corrupt
 *   MID-FILE line is a typed `routing-log-invalid` fault (F-011/R2-06
 *   symmetry — the readRoutingLogDimension idiom, reused verbatim). A
 *   well-formed-JSON line refusing the strict schema faults wherever it sits:
 *   the writer pins the shape, so a drift is never a torn tail.
 * - KPI snapshots `kpi-snapshots/*.json` — writer-managed ISO-stamp names only
 *   (kpi-snapshot-write.ts:52), bounded to the most recent MAX_KPI_SNAPSHOTS by
 *   name; parsed with JSON.parse only and kept as `unknown`: closed-schema
 *   validation is A5's surface, not the gather's (this module cites, it does
 *   not adjudicate).
 * - run records `runs/<runId>.json` — the DF2.1 store layout
 *   (src/providers/run-record.ts: `readdirSync(dir).sort()` over
 *   `qds-*.json`; the `.bundle`/`-artifacts`/`.tmp` spellings and foreign
 *   names all fall to the name filter). Bounded: the most recent
 *   MAX_RUN_RECORDS by name — record names embed `qds-YYYYMMDD-hhmmss`, so
 *   name order IS recency order and mtime statSync would buy nothing.
 *
 * Validation discipline mirrors src/kpi/join.ts: ENOENT/ENOTDIR → typed
 * absence; anything else (EACCES, EISDIR) propagates — a present-but-unreadable
 * store is not an absence.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { z } from "zod";

// ─── constants ───────────────────────────────────────────────────────────────

export const DEFAULT_ROUTING_LOG_PATH = ".sandbox/routing-log.jsonl";
export const DEFAULT_KPI_SNAPSHOTS_DIR = ".sandbox/kpi-snapshots";
export const DEFAULT_RUNS_DIR = ".sandbox/runs";
/** Bound on the runs-dir read — the most recent 50 records by name, never the whole store. */
export const MAX_RUN_RECORDS = 50;
/** Bound on the kpi-snapshots read — mirrors MAX_RUN_RECORDS: the most recent 50 snapshots by name. */
export const MAX_KPI_SNAPSHOTS = 50;

/** The skip taxonomy J3's router writes — a non-calibrated ask's recorded reason. */
export const JEV_SKIPPED_REASONS = [
  "timeout",
  "vendor-error",
  "ceiling-exceeded",
  "egress-refused",
  "provider-unavailable",
] as const;

// ─── typed fault ─────────────────────────────────────────────────────────────

export type GatherErrorCode = "routing-log-invalid" | "kpi-snapshot-invalid" | "run-record-invalid";

export class GatherFault extends Error {
  readonly code: GatherErrorCode;
  readonly remediation: string;

  constructor(code: GatherErrorCode, message: string, remediation: string) {
    super(message);
    this.name = "GatherFault";
    this.code = code;
    this.remediation = remediation;
  }
}

// ─── the routing-log line (J3 story :39, verbatim field set) ─────────────────

export const RoutingLogLineSchema = z
  .strictObject({
    /** One of the two identity spellings the dispatch named — `workKey | issueId`. */
    workKey: z.string().min(1).optional(),
    issueId: z.union([z.string(), z.number()]).optional(),
    runId: z.string().min(1),
    shape: z.string().min(1),
    risk_tier: z.string().min(1),
    applied_tier: z.string().min(1),
    /** Named-weight composite components — every logged feature a re-derivation consumes. */
    score: z.record(z.string(), z.number()),
    /** The seam's L5 recommendation, recorded-only; null exactly when the ask was skipped/failed. */
    jev_recommendation: z.string().nullable(),
    jev_requestId: z.string().min(1).optional(),
    jev_skipped: z.strictObject({ reason: z.enum(JEV_SKIPPED_REASONS) }).optional(),
    created_at: z.string().min(1),
  })
  .refine((line) => line.workKey !== undefined || line.issueId !== undefined, {
    message: "routing line carries neither workKey nor issueId — the identity half is lost",
  });

export type RoutingLogLine = z.infer<typeof RoutingLogLineSchema>;

// ─── the gathered evidence envelope ──────────────────────────────────────────

export type KpiSnapshotRef = { ref: string; snapshot: unknown };
export type RunRecordRef = { ref: string; record: unknown };

/** Structurally the proposal-schema `absent_sources` entry — defined here, not imported (no one-way-up import). */
export type AbsentSource = { source: "routing-log" | "kpi-snapshots" | "run-records"; status: "absent" };

export type GatheredEvidence = {
  routingLines: RoutingLogLine[];
  kpiSnapshots: KpiSnapshotRef[];
  runRecords: RunRecordRef[];
  absentSources: AbsentSource[];
};

export type GatherEvidenceOpts = {
  routingLogPath?: string;
  kpiSnapshotsDir?: string;
  runsDir?: string;
};

// ─── source readers (null = wholly absent) ───────────────────────────────────

/** ENOTDIR counts as absence alongside ENOENT: when the `.sandbox` parent was
 *  misprovisioned as a file, every store path beneath it is wholly absent, not
 *  present-but-unreadable. */
const isAbsentErr = (e: unknown): boolean => {
  const code = (e as NodeJS.ErrnoException).code;
  return code === "ENOENT" || code === "ENOTDIR";
};

function readRoutingLogLines(path: string): RoutingLogLine[] | null {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (e) {
    if (isAbsentErr(e)) return null;
    throw e;
  }
  // A BOM-prefixed log (editor/shell artifact) would otherwise fault as a corrupt
  // first line (multi-line) or vanish as a fake "torn tail" (single-line).
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  if (text.trim() === "") return []; // file exists = source present with zero rows
  const lines: RoutingLogLine[] = [];
  const rawLines = text.split("\n");
  let lastNonBlank = -1;
  for (const [i, raw] of rawLines.entries()) {
    if (raw.trim() !== "") lastNonBlank = i;
  }
  for (const [i, raw] of rawLines.entries()) {
    const line = raw.trim();
    if (line === "") continue; // blank + trailing-newline lines tolerated
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch (e) {
      if (i === lastNonBlank) continue; // torn tail — a concurrent appender's half-line, dropped not counted
      throw new GatherFault(
        "routing-log-invalid",
        `routing log ${path} line ${i + 1} is not JSON: ${(e as Error).message}`,
        "a corrupt non-tail routing line is a fault — inspect the log before reflecting (only a torn final line is tolerated)",
      );
    }
    const row = RoutingLogLineSchema.safeParse(parsed);
    if (!row.success) {
      throw new GatherFault(
        "routing-log-invalid",
        `routing log ${path} line ${i + 1} refuses the strict schema: ${row.error.issues
          .map((iss) => `${iss.path.join(".")}: ${iss.message}`)
          .join("; ")}`,
        "the routing-log writer (J3's router) pins this shape — a schema drift is a fault, never skipped",
      );
    }
    lines.push(row.data);
  }
  return lines;
}

const listJsonNames = (dir: string): string[] => readdirSync(dir).sort().filter((n) => n.endsWith(".json"));

/** Snapshot names are writer-managed ISO stamps (kpi-snapshot-write.ts:52 layout,
 *  `YYYY-MM-DDTHH-MM-SS-sssZ.json`) — the filter keeps stray files out of the evidence set. */
const KPI_SNAPSHOT_NAME_RE = /^\d{4}-\d{2}-\d{2}T.*\.json$/;

function readKpiSnapshots(dir: string): KpiSnapshotRef[] | null {
  let names: string[];
  try {
    names = listJsonNames(dir)
      .filter((n) => KPI_SNAPSHOT_NAME_RE.test(n))
      .slice(-MAX_KPI_SNAPSHOTS);
  } catch (e) {
    if (isAbsentErr(e)) return null;
    throw e;
  }
  return names.map((name) => {
    const path = join(dir, name);
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(path, "utf8"));
    } catch (e) {
      throw new GatherFault(
        "kpi-snapshot-invalid",
        `KPI snapshot ${path} is not valid JSON: ${(e as Error).message}`,
        "snapshots are written whole by A5's store — a partial file is a fault; re-derive or repair the snapshot before reflecting",
      );
    }
    // Unknown here on purpose: closed-schema validation is A5's surface; the gather only cites.
    return { ref: name, snapshot: parsed };
  });
}

function readRunRecords(dir: string): RunRecordRef[] | null {
  let names: string[];
  try {
    // Record names follow the DF2.1 store layout (`qds-YYYYMMDD-hhmmss.json`,
    // src/providers/run-record.ts) — foreign *.json must not crowd the recency window.
    names = listJsonNames(dir).filter((n) => n.startsWith("qds-"));
  } catch (e) {
    if (isAbsentErr(e)) return null;
    throw e;
  }
  // ponytail: recency-by-name (record ids embed qds-YYYYMMDD-hhmmss); mtime statSync buys nothing until names stop encoding time
  const recent = names.slice(-MAX_RUN_RECORDS);
  return recent.map((name) => {
    const path = join(dir, name);
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(path, "utf8"));
    } catch (e) {
      throw new GatherFault(
        "run-record-invalid",
        `run record ${path} is not valid JSON: ${(e as Error).message}`,
        "a run record may hold a live box behind it — repair it in place (src/providers/run-record.ts discipline); never re-create the run",
      );
    }
    return { ref: name, record: parsed };
  });
}

// ─── the gather ──────────────────────────────────────────────────────────────

/** Read-only pass over the three consumed stores. Absent source ⇒ typed absence entry, never a throw, never a dir/file created. */
export function gatherEvidence(opts: GatherEvidenceOpts): GatheredEvidence {
  const lines = readRoutingLogLines(opts.routingLogPath ?? DEFAULT_ROUTING_LOG_PATH);
  const kpiSnapshots = readKpiSnapshots(opts.kpiSnapshotsDir ?? DEFAULT_KPI_SNAPSHOTS_DIR);
  const runRecords = readRunRecords(opts.runsDir ?? DEFAULT_RUNS_DIR);
  const absentSources: AbsentSource[] = [];
  if (lines === null) absentSources.push({ source: "routing-log", status: "absent" });
  if (kpiSnapshots === null) absentSources.push({ source: "kpi-snapshots", status: "absent" });
  if (runRecords === null) absentSources.push({ source: "run-records", status: "absent" });
  return {
    routingLines: lines ?? [],
    kpiSnapshots: kpiSnapshots ?? [],
    runRecords: runRecords ?? [],
    absentSources,
  };
}
