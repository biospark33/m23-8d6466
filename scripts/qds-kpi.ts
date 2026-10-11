#!/usr/bin/env bun
/**
 * CLI: qds-kpi — A5 yield-KPI snapshot (AC5 + e2e slice).
 *
 * Usage:
 *   qds-kpi --window <Nd|Nw> [--runs-dir <dir>] [--ledger <path>]
 *           [--audit-db <path>] [--dispatch-log <path>] [--imports-file <path>]
 *           [--snapshots-dir <dir>] [--repo <slug>]
 *
 * Operator-invoked, strictly read-only over the truth stores, no daemon — the
 * script exits on every path (INV-A5-5). Scheduling is the operator's cron line
 * (DF3.8 idiom), documented in --help and shipped nowhere:
 *   # m3.2/a5 yield snapshot — cron: 17 6 * * * bun scripts/qds-kpi.ts --window 7d
 *
 * Every computation is leaf-1.1's locked module API (src/kpi/{join,kpis}.ts);
 * this script only READS stores and WRITES the snapshot + best-effort retain.
 *
 * Pinned readings (the semantics this script adds on top of the module):
 * - Window membership: a record is in-window when its effective timestamp —
 *   `closedAt` once terminal, else `createdAt` — falls in [start, end); the
 *   window bounds are parseWindow's UTC day-truncated bounds (end excludes the
 *   current, incomplete day). Dispatch-log entries filter by their `timestamp`
 *   the same way; an entry whose timestamp is unparseable is KEPT (its window
 *   position cannot be proven either way).
 * - Ledger absent (ENOENT → `ledger-absent`): a truth store that may not exist
 *   in a fresh clone. Factory spend becomes an EMPTY row set — the SUM over no
 *   ledger is an empty sum — and the observability line types the factory
 *   component absent via `factory_ledger_absent: true`; the snapshot stays
 *   green (exit 0). With an import present, factory-known keys = 0, so EVERY
 *   import row counts `unmatched_gateway_rows` and `missing_gateway_rows` = 0;
 *   `spend_incomplete: true` either way. A cost_per_story KPI computed in that
 *   state is gateway-only and must be read only beside that flag (AC2's
 *   both-ledgers-or-flagged contract; the symmetric case of the sanctioned
 *   factory-only default).
 * - Audit walk: SKIPPED entirely when the audit-db file is absent — the walker
 *   is never constructed. When present, each terminal run in-window is walked
 *   best-effort (walkAuditChain, per-hop ceiling 500ms), capped at
 *   AUDIT_WALK_CAP terminal runs; a walk failure (ChainWalkError or otherwise)
 *   drops that run's report and is counted, never crashing the snapshot. Note
 *   the walker is the audit chain's own reader: its designed first-observation
 *   appends apply exactly as they do under `qds-audit`.
 * - Retain seam: env-gated best-effort (HINDSIGHT_BASE_URL + bearer/api key —
 *   the same pair retain-best-effort gates on). Env absent → one skip line, no
 *   call, exit unchanged. `QDS_KPI_RETAIN_CAPTURE=<jsonl>` swaps the network
 *   client for a capture client with the same {listBanks, retain} surface that
 *   resolves the provisioned bank family offline and RECORDS each retain call
 *   to the file — the test seam, because a `mode:"mock"` client short-circuits
 *   with canned bodies and records nothing the idempotency asserts need.
 *   `QDS_KPI_NOW=<iso>` freezes the clock (window bounds + snapshot filename)
 *   for deterministic tests; unset in production.
 *
 * Exit codes: 0 success INCLUDING every absent/degraded arm (absence is never
 * an error); 1 store-verdict failure (same-ms snapshot collision, unreadable/
 * corrupt stores, malformed import); 2 usage.
 */

import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, statSync, writeSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

import { walkAuditChain } from "../src/audit/chain.ts";
import { CostLedger } from "../src/providers/cost-ledger.ts";
import { RunRecordStore } from "../src/providers/run-record.ts";
import { log, newRequestId, setLogSink } from "../src/swarmclaw/log.ts";
import {
  assembleSnapshot,
  parseWindow,
  stableStringify,
  type AuditReportLike,
  type KpiSnapshotPayload,
} from "../src/kpi/kpis.ts";
import {
  KpiError,
  absentDimension,
  buildRunIdentities,
  readDispatchLog,
  readGatewaySpendImport,
  readJsonlDimension,
  type FactorySpendRow,
  type RunRecordLike,
} from "../src/kpi/join.ts";
import { parseValueFlags, tokenizeArgs } from "./lib/cli-args.ts";
import { retainSnapshot, type RetainSkipLine } from "./lib/kpi-retain.ts";

const VALUE_FLAGS = [
  "--window", "--runs-dir", "--ledger", "--audit-db", "--dispatch-log",
  "--imports-file", "--snapshots-dir", "--repo",
] as const;

/** src/fleet/dispatch.ts's DISPATCH_FAILURE_LOG literal — consume-only fence. */
const DEFAULT_DISPATCH_LOG = ".sandbox/dispatch-log.jsonl";
const DEFAULT_ROUTING_LOG = ".sandbox/routing-log.jsonl";
const AUDIT_WALK_CAP = 200;
const AUDIT_HOP_CEILING_MS = 500;

const HELP = [
  "Usage: qds-kpi --window <Nd|Nw> [flags]",
  "",
  "  --window <spec>       required window: days or weeks (e.g. 7d, 2w)",
  "  --runs-dir <dir>      run records directory (default $QDS_RUNS_DIR | .sandbox/runs)",
  "  --ledger <path>       cost ledger (default $QDS_COST_LEDGER_FILE | .sandbox/cost-ledger.db)",
  "  --audit-db <path>     audit chain db (default $QDS_AUDIT_DB | .sandbox/audit.db)",
  "  --dispatch-log <path> dispatch failure log (default .sandbox/dispatch-log.jsonl)",
  "  --imports-file <path> gateway-spend import (default .sandbox/imports/gateway-spend-<windowId>.jsonl)",
  "  --snapshots-dir <dir> snapshot directory (default .sandbox/kpi-snapshots)",
  "  --repo <slug>         repo slug for the retain bank (default $QDS_REPO_SLUG | git remote origin)",
  "",
  "Writes .sandbox/kpi-snapshots/<UTC-timestamp>.json (0600, append-only) with the",
  "four yield KPIs, each paired with its FR-LEARN-33 counter-metric. Read-only over",
  "every store; retains the summary best-effort when Hindsight env is configured.",
  "",
  "Scheduling is operator-owned (no daemon is shipped). Crontab line:",
  "  # m3.2/a5 yield snapshot — cron: 17 6 * * * bun scripts/qds-kpi.ts --window 7d",
  "",
];

/** Typed script failure: code + remediation ride the `!!` envelope, exit != 0. */
class KpiScriptError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly remediation: string,
  ) {
    super(message);
    this.name = "KpiScriptError";
  }
}

/** writeSync can write short; a truncated envelope is worse than a slow one (qds-cost idiom). */
function writeAll(fd: number, s: string): void {
  const buf = Buffer.from(s, "utf8");
  let off = 0;
  while (off < buf.length) {
    const n = writeSync(fd, buf, off, buf.length - off);
    if (n <= 0) throw Object.assign(new Error(`fd ${fd} accepted 0 of ${buf.length - off} bytes`), { code: "EAGAIN" });
    off += n;
  }
}

function fail(out: (s: string) => void, code: string, message: string, remediation?: string): void {
  out(`!! ${code}: ${message}\n`);
  if (remediation !== undefined && remediation !== "") out(`next: ${remediation}\n`);
}

/** A DIAGNOSTIC write never replaces the outcome it reports on. */
function writeBestEffort(fd: number, s: string): void {
  try {
    writeAll(fd, s);
  } catch {
    // Nothing left to report it to.
  }
}

interface CliOptions {
  windowSpec: string;
  runsDir: string;
  ledgerPath: string;
  auditDbPath: string;
  dispatchLogPath: string;
  importsFile: string | undefined;
  snapshotsDir: string;
  repoSlug: string | undefined;
}

/** Usage refusal — the message IS the full `!!` envelope + help, qds-cost style. */
function usageError(code: string, message: string, remediation: string): Error {
  return new Error(`!! ${code}: ${message}\nnext: ${remediation}\n${HELP.join("\n")}\n`);
}

function parseCli(argv: readonly string[], now: Date): CliOptions {
  const values: Record<string, string | undefined> = {};
  const seen = new Set<string>();
  const { positionals, flagTokens } = tokenizeArgs(argv, { valueFlags: VALUE_FLAGS });
  try {
    parseValueFlags(flagTokens, {
      flags: VALUE_FLAGS,
      onValue: (flag, value) => {
        if (seen.has(flag)) {
          throw usageError("kpi-flag-invalid", `${flag} given more than once`, "pass each flag at most once");
        }
        seen.add(flag);
        values[flag] = value;
      },
      help: HELP,
    });
  } catch (e) {
    // The shared grammar throws bare ("unknown flag: --x", "--f requires a
    // non-empty value"); this CLI's envelope carries the code + remediation.
    if (e instanceof Error && !e.message.startsWith("!!")) {
      throw usageError("kpi-flag-invalid", e.message, "check the flag against --help");
    }
    throw e;
  }
  if (positionals.length > 0) {
    throw usageError("kpi-usage-invalid", `unexpected argument: ${positionals[positionals.length - 1]}`, "flags only — this CLI takes no positional arguments");
  }
  const windowSpec = values["--window"];
  if (windowSpec === undefined) {
    throw usageError("kpi-window-missing", "missing required --window", 'pass --window as a day- or week-count spec (e.g. "7d", "2w")');
  }
  // parseWindow's typed refusal is a usage error here (the operator's spec, not a store fault).
  try {
    parseWindow(windowSpec, now);
  } catch (e) {
    if (e instanceof KpiError) throw usageError(e.code, e.message, e.remediation);
    throw e;
  }
  return {
    windowSpec,
    runsDir: values["--runs-dir"] ?? process.env.QDS_RUNS_DIR?.trim() ?? ".sandbox/runs",
    ledgerPath: values["--ledger"] ?? process.env.QDS_COST_LEDGER_FILE ?? ".sandbox/cost-ledger.db",
    auditDbPath: values["--audit-db"] ?? process.env.QDS_AUDIT_DB ?? ".sandbox/audit.db",
    dispatchLogPath: values["--dispatch-log"] ?? DEFAULT_DISPATCH_LOG,
    importsFile: values["--imports-file"],
    snapshotsDir: values["--snapshots-dir"] ?? ".sandbox/kpi-snapshots",
    repoSlug: values["--repo"] ?? (process.env.QDS_REPO_SLUG?.trim() || undefined),
  };
}

/** The frozen-or-real clock. A typo'd freeze is a test bug, refused loudly. */
function resolveNow(): Date {
  const raw = process.env.QDS_KPI_NOW;
  if (raw === undefined) return new Date();
  const t = Date.parse(raw);
  if (Number.isNaN(t)) {
    throw usageError("kpi-now-invalid", `QDS_KPI_NOW=${JSON.stringify(raw)} is not a parseable ISO timestamp`, "pass an ISO 8601 timestamp or unset the variable");
  }
  return new Date(t);
}

/**
 * Last path segment of a git remote URL, `.git` stripped — "de-slugged" only in
 * the sense that host/owner/scheme drop away; resolveBankId lowercases the rest.
 * Exported for the derivation unit test.
 */
export function repoSlugFromRemoteUrl(url: string): string | null {
  const cleaned = url.trim().replace(/\/+$/, "");
  const bySlash = cleaned.slice(cleaned.lastIndexOf("/") + 1);
  const seg = (bySlash.includes(":") ? bySlash.slice(bySlash.lastIndexOf(":") + 1) : bySlash) || cleaned;
  const slug = seg.replace(/\.git$/, "");
  return slug.length > 0 ? slug : null;
}

/** --repo flag ?? $QDS_REPO_SLUG ?? `git remote get-url origin` in the cwd. */
function resolveRepoSlug(flagValue: string | undefined): string | undefined {
  if (flagValue !== undefined) return flagValue;
  const env = process.env.QDS_REPO_SLUG?.trim();
  if (env !== undefined && env !== "") return env;
  const git = spawnSync("git", ["remote", "get-url", "origin"], { encoding: "utf8" });
  if (git.status !== 0 || typeof git.stdout !== "string") return undefined;
  return repoSlugFromRemoteUrl(git.stdout) ?? undefined;
}

/** Append-only snapshot write: O_EXCL on the FINAL name, 0600, fsynced (run-record idiom). */
function writeSnapshot(snapshotsDir: string, payload: KpiSnapshotPayload, now: Date): string {
  mkdirSync(snapshotsDir, { recursive: true, mode: 0o700 });
  const finalPath = join(snapshotsDir, `${now.toISOString().replace(/[:.]/g, "-")}.json`);
  const bytes = Buffer.from(stableStringify(payload), "utf8");
  let fd: number;
  try {
    fd = openSync(finalPath, "wx", 0o600);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "EEXIST") {
      throw new KpiScriptError(
        "kpi-snapshot-exists",
        `snapshot ${finalPath} already exists — same-millisecond filename collision; a prior snapshot is never overwritten or mutated (AC5)`,
        "re-run — the next millisecond mints a fresh filename; prior snapshots are immutable",
      );
    }
    throw new KpiScriptError("kpi-snapshot-write-failed", `cannot create snapshot ${finalPath} (${code ?? (e as Error).message})`, "check the snapshots directory's permissions and re-run");
  }
  try {
    let off = 0;
    while (off < bytes.length) off += writeSync(fd, bytes, off, bytes.length - off);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  // Best-effort directory sync (run-record's fsyncDir posture): a platform that
  // refuses it must not fail a durable-enough file.
  try {
    const dirFd = openSync(snapshotsDir, "r");
    fsyncSync(dirFd);
    closeSync(dirFd);
  } catch {
    // Hygiene only.
  }
  return finalPath;
}

/**
 * Main run function — every path returns an exit code; no path throws past it.
 */
export async function run(argv: readonly string[], out: (s: string) => void = (s) => writeAll(1, s)): Promise<number> {
  const startedAt = Date.now();
  const requestId = newRequestId();
  const skipLine: RetainSkipLine = (code, reason) => {
    try {
      log({
        requestId, operation: "kpi-retain", agentId: null, timestamp: new Date().toISOString(),
        duration: 0, status: "error", error: { code, message: reason },
        reason: "best-effort retain skipped — the snapshot landed and the exit code is unchanged (M1.2 AC4 posture)",
      });
    } catch {
      // A raising sink must not turn a skipped retain into a failed snapshot.
    }
  };

  let opts: CliOptions;
  let now: Date;
  try {
    now = resolveNow();
    opts = parseCli(argv, now);
  } catch (e) {
    out(`${(e as Error).message}\n`);
    return 2;
  }
  const repoSlug = resolveRepoSlug(opts.repoSlug);

  try {
    const window = parseWindow(opts.windowSpec, now);
    const startMs = Date.parse(window.startUtc);
    const endMs = Date.parse(window.endUtc);
    const inWindow = (ts: string): boolean => {
      const t = Date.parse(ts);
      return !Number.isNaN(t) && t >= startMs && t < endMs;
    };

    // Run records: read-only store, never created. Absent dir → typed absence.
    let records: RunRecordLike[] = [];
    let recordsSkipped: number | "absent" = "absent";
    let runsDirAbsent = true;
    try {
      statSync(opts.runsDir);
      runsDirAbsent = false;
      const listing = new RunRecordStore({ dir: opts.runsDir, create: false }).listWithAnomalies();
      recordsSkipped = listing.skipped.length;
      records = listing.records.filter((r) => inWindow(typeof r.closedAt === "string" && r.closedAt !== "" ? r.closedAt : r.createdAt));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }

    // Dispatch log: window-filtered by entry timestamp (unparseable kept).
    const dispatchLog = readDispatchLog(opts.dispatchLogPath);
    const dispatch = dispatchLog.status === "present"
      ? { status: "present" as const, entries: dispatchLog.entries.filter((en) => !Number.isNaN(Date.parse(en.timestamp)) ? inWindow(en.timestamp) : true) }
      : dispatchLog;

    // Cost ledger: read-only open, never created. ledger-absent → empty rows.
    const factorySpendRows: FactorySpendRow[] = [];
    let ledgerAbsent = false;
    try {
      const ledger = CostLedger.openReadOnly({ path: opts.ledgerPath });
      try {
        const identities = new Map(buildRunIdentities(records, dispatch.status === "present" ? dispatch.entries : []).map((i) => [i.runId, i.workKey]));
        for (const r of records) {
          const view = ledger.readRunCost(r.runId);
          if (view.hasEvents) factorySpendRows.push({ runId: r.runId, workKey: identities.get(r.runId) ?? null, microUsd: view.totalMicroUsd, eventCount: view.eventCount });
        }
      } finally {
        ledger.close();
      }
    } catch (e) {
      const err = e as { code?: string; message?: string; remediation?: string };
      if (err.code !== "ledger-absent") {
        throw new KpiScriptError(err.code ?? "ledger-error", err.message ?? String(e), err.remediation ?? "inspect the ledger path and re-run");
      }
      ledgerAbsent = true;
    }

    // Gateway import: default path derives from the windowId slug, never the bare label.
    const importsPath = opts.importsFile ?? `.sandbox/imports/gateway-spend-${window.windowId}.jsonl`;
    const gatewayImport = readGatewaySpendImport(importsPath);

    // Dimensions: routing log joins read-side when present; A2/Z2 are typed absent.
    const dimensions = [
      readJsonlDimension("j3-routing-log", DEFAULT_ROUTING_LOG),
      absentDimension("a2-qa-findings"),
      absentDimension("z2-observe-artifacts"),
    ];

    // Audit walk: never constructed when the db file is absent; bounded otherwise.
    let audit: { status: "present"; reports: AuditReportLike[] } | { status: "absent" } = { status: "absent" };
    let auditWalked = 0;
    let auditFailed = 0;
    let auditCapped = false;
    if (existsSync(opts.auditDbPath)) {
      const terminal = records.filter((r) => typeof r.closedAt === "string" && r.closedAt !== "");
      auditCapped = terminal.length > AUDIT_WALK_CAP;
      const reports: AuditReportLike[] = [];
      for (const r of terminal.slice(0, AUDIT_WALK_CAP)) {
        try {
          reports.push((await walkAuditChain(r.runId, { runsDir: opts.runsDir, auditDb: opts.auditDbPath, requestId, hopCeilingMs: AUDIT_HOP_CEILING_MS })) as unknown as AuditReportLike);
          auditWalked++;
        } catch {
          auditFailed++; // ChainWalkError or any walk fault: that run contributes nothing.
        }
      }
      if (reports.length > 0) audit = { status: "present", reports };
    }

    let payload: KpiSnapshotPayload;
    try {
      payload = assembleSnapshot({
        window, records, recordsSkipped, dispatch,
        factorySpendRows, gatewayImport, dimensions, audit,
      });
    } catch (e) {
      if (e instanceof KpiError) throw new KpiScriptError(e.code, e.message, e.remediation);
      throw new KpiScriptError("kpi-snapshot-invalid", `snapshot assembly refused validation: ${(e as Error).message}`, "this is a schema-level fault — inspect the KPI module contract before re-running");
    }

    const snapshotPath = writeSnapshot(opts.snapshotsDir, payload, now);

    // Per-KPI failures are typed lines on stdout AND ride the payload.
    for (const f of payload.per_kpi_failures) fail(out, f.code, `[${f.kpi}] ${f.message}`, f.remediation);

    const durationMs = Date.now() - startedAt;
    log({
      requestId, operation: "kpi-snapshot-written", agentId: null, timestamp: now.toISOString(),
      duration: durationMs, status: "ok",
      window: opts.windowSpec, window_id: window.windowId,
      snapshot_path: snapshotPath,
      spend_incomplete: payload.spend.spend_incomplete,
      unmatched_gateway_rows: payload.spend.unmatched_gateway_rows,
      missing_gateway_rows: payload.spend.missing_gateway_rows,
      dimensions_present: payload.dimensions.filter((d) => d.status === "joined").map((d) => d.source),
      kpis: payload.kpis.length,
      pairs: payload.kpis.length,
      duration_ms: durationMs,
      ...(ledgerAbsent ? { factory_ledger_absent: true } : {}),
      ...(runsDirAbsent ? { runs_dir_absent: true } : {}),
      audit: audit.status === "present" ? { walked: auditWalked, failed: auditFailed } : "absent",
      ...(auditCapped ? { audit_walks_capped: AUDIT_WALK_CAP } : {}),
    });

    await retainSnapshot(payload, window.windowId, repoSlug, skipLine);
    return 0;
  } catch (e) {
    if (e instanceof KpiScriptError) {
      fail(out, e.code, e.message, e.remediation);
      return 1;
    }
    const err = e as { code?: string; message?: string; remediation?: string };
    fail(out, err.code ?? "kpi-store-error", err.message ?? String(e), err.remediation);
    return 1;
  }
}

if (import.meta.main) {
  // The observability line must survive process.exit's teardown and NODE_ENV
  // muting (qds-cost D5 posture): writeSync through our own sink.
  setLogSink((entry) => writeBestEffort(1, `${JSON.stringify(entry)}\n`));
  try {
    process.exit(await run(process.argv.slice(2)));
  } catch (e) {
    writeBestEffort(2, `${(e as Error)?.message ?? String(e)}\n`);
    process.exit(1);
  }
}
