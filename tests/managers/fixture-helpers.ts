/**
 * One copy of the fixtures shared by the two composeDigest suites — review
 * finding D15 (the one-copy principle that produced scan-helpers.ts, applied
 * to the fixture families too).
 *
 * Divergences found between the two former local copies, and how the union
 * resolves each:
 *
 * - fakeCli — the composer copy is the superset: statusRc / statusStdout /
 *   statusStderr / statusThrows / resultThrows / resultHangs / hang / slowMs
 *   knobs, the result payload carries `terminal: true`, and an unknown verb
 *   patches the journal rc to 2. The e2e copy (statusRows required, status
 *   always rc 0, no terminal field, unknown verb leaves journal rc 0) is a
 *   strict subset at its call sites — every e2e call passes only statusRows
 *   and resultRc, so it reaches no divergent branch and the composer body is
 *   the union, verbatim. (`terminal` is never read by composeDigest — verified
 *   against src/managers/digest-composer.ts — so the payload difference is
 *   behaviorally inert.)
 * - costView / record / event / NOW — literal-identical copies; verbatim.
 * - captureInto — both copies already used the same chained-restore
 *   discipline (the composer suite's is canonical). The sink state now lives
 *   here once; each suite's afterEach calls restoreCaptures(). bun test runs
 *   files sequentially in one process, so the shared state cannot interleave.
 *
 * Deliberately NOT extracted (never duplicated between the two files): the
 * per-suite deps builders (the composer's `deps`, the e2e `e2eDeps` plus its
 * one inline deps literal), the composer's `row` helper, and the e2e inline
 * status-row literals.
 */

import type { CliInvoker, CliResult, DigestLine } from "../../src/managers/digest-composer.ts";
import type { CostView } from "../../src/providers/cost-ledger.ts";
import type { RunRecord } from "../../src/providers/run-record.ts";
import { setLogSink, type LogEntry } from "../../src/lib/log.ts";

/** The fixed base clock both suites assert against. */
export const NOW = new Date("2026-10-15T12:00:00.000Z");

export type JournalEntry = { verb: string; argv: readonly string[]; rc: number };

type FakeCliOpts = {
  /** The `fleet status` answer. Default: rc 0 with the rows given at build time. */
  statusRc?: number;
  statusRows?: Record<string, unknown>[];
  /** Raw status stdout override — rows are ignored when present. */
  statusStdout?: string;
  /** Raw status stderr (rides a non-zero statusRc). */
  statusStderr?: string;
  /** The status invocation's invoker THROWS (a spawn failure, not a timeout). */
  statusThrows?: boolean;
  /** Every `fleet result` invocation's invoker THROWS (a spawn failure). */
  resultThrows?: boolean;
  /** Every `fleet result` invocation never resolves (a hung child). */
  resultHangs?: boolean;
  /** Per-runId `fleet result` answer. Default: rc 0. */
  resultRc?: (runId: string) => number;
  /** Never-resolving invocations (tests the verb deadline). */
  hang?: boolean;
  /** Wall-clock delay before every invocation answers (tests the total budget). */
  slowMs?: number;
};

export function fakeCli(opts: FakeCliOpts): { cli: CliInvoker; journal: JournalEntry[] } {
  const journal: JournalEntry[] = [];
  const cli: CliInvoker = async (argv) => {
    const verb = argv[0] as string;
    if (opts.hang) return new Promise<CliResult>(() => {});
    if (opts.resultHangs && verb === "result") {
      journal.push({ verb, argv, rc: 0 }); // the verb WAS issued before it hung
      return new Promise<CliResult>(() => {});
    }
    if (opts.statusThrows && verb === "status") throw new Error("spawn failed: bun not found");
    if (opts.resultThrows && verb === "result") throw new Error("spawn failed: result leg down");
    if (opts.slowMs !== undefined) await new Promise((r) => setTimeout(r, opts.slowMs));
    journal.push({ verb, argv, rc: 0 });
    if (verb === "status") {
      const rc = opts.statusRc ?? 0;
      journal[journal.length - 1]!.rc = rc;
      const stdout =
        opts.statusStdout !== undefined
          ? opts.statusStdout
          : rc === 0
            ? `${opts.statusRows?.map((r) => JSON.stringify(r)).join("\n")}\n`
            : "";
      return { exitCode: rc, stdout, stderr: opts.statusStderr ?? "" };
    }
    if (verb === "result") {
      const runId = argv[1] as string;
      const rc = opts.resultRc?.(runId) ?? 0;
      journal[journal.length - 1]!.rc = rc;
      const payload = { runId, status: "completed", terminal: true };
      return { exitCode: rc, stdout: rc === 0 ? `${JSON.stringify(payload)}\n` : "", stderr: "" };
    }
    journal[journal.length - 1]!.rc = 2;
    return { exitCode: 2, stdout: "", stderr: "unknown verb" };
  };
  return { cli, journal };
}

/** An explicit `hasEvents` (default true) so a 0-with-events view stays representable. */
export function costView(totalMicroUsd: number, hasEvents = true): CostView {
  return {
    totalMicroUsd,
    perRole: hasEvents ? { "box-hours": totalMicroUsd } : {},
    tokenTotals: { inputTokens: 0, outputTokens: 0 },
    cacheTotals: { cacheReadTokens: 0, cacheWriteTokens: 0 },
    unpricedRows: 0,
    eventCount: hasEvents ? 1 : 0,
    hasEvents,
    hasTokenRows: false,
  };
}

export function record(
  runId: string,
  extensions?: Record<string, Record<string, unknown>>,
): RunRecord {
  // Every extension namespace carries its schemaVersion on a real record;
  // the fixtures stamp 1 so the shapes read as written records.
  const stamped = Object.fromEntries(
    Object.entries(extensions ?? {}).map(([ns, entry]) => [ns, { schemaVersion: 1, ...entry }]),
  );
  return {
    runId,
    createdAt: NOW.toISOString(),
    ...(extensions === undefined ? {} : { extensions: stamped as RunRecord["extensions"] }),
  };
}

/**
 * Capture the composer's channel lines. Restores are CHAINED: a capture
 * installed while another is live must unwind through it (the
 * threshold-boundary loop installs three in one test), so the latest
 * restore runs its own restore first and then its predecessor's — a sink is
 * never left installed after afterEach, which would override log.ts's
 * bun-test mute for the WHOLE process.
 */
let restoreSink: (() => void) | undefined;

export function captureInto(): DigestLine[] {
  const seen: DigestLine[] = [];
  const previous = restoreSink;
  const restore = setLogSink((entry: LogEntry) => {
    seen.push(entry as unknown as DigestLine);
  });
  restoreSink = () => {
    restore();
    previous?.();
  };
  return seen;
}

/** The afterEach half of captureInto: unwind the whole chained restore. */
export function restoreCaptures(): void {
  restoreSink?.();
  restoreSink = undefined;
}

export function event(lines: DigestLine[], name: string): DigestLine[] {
  return lines.filter((l) => l.event === name);
}
