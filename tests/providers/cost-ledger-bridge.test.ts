/**
 * DF2.12 host leg — the cost-attribution bridge (`cost-ledger-bridge.ts`).
 *
 * AC1  a three-agent log → three token rows split by role, µ$ exact, key-linked
 * AC2  idempotent re-ingest; two genuine invocations → two rows (invocation_seq)
 * AC4  absent/unreadable log → tokens-not-harvested, never an implicit zero;
 *      zero emission → no-token-spend; all-refused → refused
 * AC5  unusable money reaches ingestCostEvent and persists unpriced=1 — the
 *      reader never filters a row
 * INV-COST-8  role/invocationSeq are read off the line — a partial re-harvest
 *      re-ingests lines 1-2 then 1-4 without renumbering anything
 * INV-COST-9  the fail-closed direction; every refusal is loud and counted
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";

import { CostLedger, type RunCostRecord } from "../../src/providers/cost-ledger.ts";
import {
  classifyHarvestedTokens,
  harvestedEngineLogPath,
  ingestHarvestedTokens,
} from "../../src/providers/cost-ledger-bridge.ts";
import { setLogSink, type LogEntry } from "../../src/swarmclaw/log.ts";

const IS_ROOT = (process.getuid?.() ?? -1) === 0;

const RUN = "run-bridge-a1";
const REPO = "qds/demo";
const ISSUE = "42";

let dir: string;
let prevCwd: string;
let runsDir: string;
let ledgerPath: string;
let ledger: CostLedger;
let logs: LogEntry[];
let restoreLog: (() => void) | undefined;

const RECORDS = new Map<string, RunCostRecord>();
function seedRecord(runId: string, over: Partial<RunCostRecord> = {}): void {
  RECORDS.set(runId, {
    keyHash: "sha256:deadbeef",
    limitMicroUsd: 50_000_000,
    createdAt: "2026-09-10T12:00:00.000Z",
    closedAt: "2026-09-10T12:30:00.000Z",
    ...over,
  });
}

/** One in-box `cost_attribution` line, in the exact wire shape dispatch-task/steering emit. */
function attributionLine(over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    type: "cost_attribution",
    requestId: "req-box",
    runId: RUN,
    phaseId: "implement",
    agentId: "lead-1",
    role: "lead",
    invocationSeq: 0,
    model: "cheap/model",
    costMicroUsd: 12_345,
    inputTokens: 1_000,
    outputTokens: 500,
    cacheReadTokens: 200,
    cacheWriteTokens: 100,
    turnCount: 3,
    unpricedTurns: 0,
    timestamp: "2026-09-10T12:01:00.000Z",
    ...over,
  });
}

function writeLog(lines: string[], runId = RUN): string {
  const artifacts = join(runsDir, `${runId}-artifacts`);
  mkdirSync(artifacts, { recursive: true });
  const p = harvestedEngineLogPath(runsDir, runId);
  writeFileSync(p, lines.length === 0 ? "" : `${lines.join("\n")}\n`);
  return p;
}

function rawDb(): Database {
  return new Database(ledgerPath);
}

function rows(sql: string, ...params: string[]): Record<string, unknown>[] {
  const db = rawDb();
  try {
    return db.prepare(sql).all(...params) as Record<string, unknown>[];
  } finally {
    db.close();
  }
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "qds-df212-bridge-"));
  prevCwd = process.cwd();
  process.chdir(dir);
  runsDir = join(dir, "runs");
  RECORDS.clear();
  seedRecord(RUN);
  ledgerPath = join(dir, "cost-ledger.db");
  ledger = new CostLedger({
    path: ledgerPath,
    readRunRecord: (runId) => RECORDS.get(runId),
    config: { defaultCapMicroUsd: 5_000_000, boxHourRateMicroUsd: 3_600_000 },
  });
  logs = [];
  restoreLog = setLogSink((entry) => logs.push(entry));
});

afterEach(() => {
  ledger.close();
  restoreLog?.();
  process.chdir(prevCwd);
  rmSync(dir, { recursive: true, force: true });
});

// ─── in-box refusal markers + mixed-log honesty (closeout review F2/F4) ─────

describe("DF2.12 refusal markers and mixed-log summary", () => {
  test("a cost_attribution_refused marker counts as refused evidence and writes no row", () => {
    writeLog([
      JSON.stringify({
        type: "cost_attribution_refused",
        runId: RUN,
        agentId: "ghost",
        phaseId: "phase-1",
        reason: "missing role — no roster entry spawned this agentId (INV-COST-8)",
      }),
    ]);
    const summary = ingestHarvestedTokens(ledger, runsDir, RUN, { repoSlug: REPO, issueId: ISSUE }, "req-host");
    expect(summary.rowsRefused).toBe(1);
    expect(summary.rowsRead).toBe(0);
    expect(summary.rowsInserted).toBe(0);
    expect(summary.outcome).toBe("refused");
    // The marker is evidence, not money: no row landed in the ledger, and the
    // only token-kind log line is the refusal report itself.
    const view = ledger.readRunCost!(RUN);
    expect(view.hasTokenRows).toBe(false);
    expect(logs.filter((l) => (l as { kind?: string; outcome?: string }).kind === "tokens" && (l as { outcome?: string }).outcome === "inserted").length).toBe(0);
  });

  test("a MIXED log (priced line + refused evidence) reports ingested AND names the refusals in its reason", () => {
    writeLog([
      attributionLine({ role: "lead", costMicroUsd: 12_345 }),
      JSON.stringify({
        type: "cost_attribution_refused",
        runId: RUN,
        agentId: "ghost",
        reason: "missing role",
      }),
    ]);
    const summary = ingestHarvestedTokens(ledger, runsDir, RUN, { repoSlug: REPO, issueId: ISSUE }, "req-host");
    expect(summary.outcome).toBe("ingested");
    expect(summary.rowsInserted).toBe(1);
    expect(summary.rowsRefused).toBe(1);
    expect(String(summary.reason)).toContain("1 line");
  });
});

// ─── AC1: the three-agent run ────────────────────────────────────────────────

describe("DF2.12 bridge ingest (AC1)", () => {
  test("lead + two workers → three token rows split by role, µ$ exact, key-linked; role is the line's, never the model's", () => {
    writeLog([
      // The LEAD carries the cheap model and the WORKER a frontier one: a role
      // derived from the model slug would swap these rows (negative control).
      attributionLine({ role: "lead", model: "cheap/model", costMicroUsd: 12_345 }),
      attributionLine({
        agentId: "worker-1",
        role: "worker",
        model: "frontier/model",
        costMicroUsd: 2_000,
        inputTokens: 10,
        timestamp: "2026-09-10T12:02:00.000Z",
      }),
      attributionLine({
        agentId: "worker-2",
        role: "worker",
        model: "frontier/model",
        costMicroUsd: 1_000,
        inputTokens: 5,
        invocationSeq: 1,
        timestamp: "2026-09-10T12:03:00.000Z",
      }),
    ]);
    const summary = ingestHarvestedTokens(ledger, runsDir, RUN, { repoSlug: REPO, issueId: ISSUE }, "req-host");
    expect(summary.outcome).toBe("ingested");
    expect(summary.rowsRead).toBe(3);
    expect(summary.rowsInserted).toBe(3);
    expect(summary.rowsDuplicate).toBe(0);
    expect(summary.rowsUnpriced).toBe(0);

    const tokenRows = rows("SELECT * FROM cost_events WHERE kind = 'tokens' ORDER BY agent_id, invocation_seq");
    expect(tokenRows).toHaveLength(3);
    expect(tokenRows.map((r) => r.role)).toEqual(["lead", "worker", "worker"]);
    expect(tokenRows.map((r) => r.agent_id)).toEqual(["lead-1", "worker-1", "worker-2"]);
    expect(tokenRows.map((r) => r.invocation_seq)).toEqual([0, 0, 1]);
    expect(tokenRows.map((r) => r.cost_micro_usd)).toEqual([12_345, 2_000, 1_000]);
    expect(tokenRows.map((r) => r.input_tokens)).toEqual([1_000, 10, 5]);
    expect(tokenRows.map((r) => r.output_tokens)).toEqual([500, 500, 500]);
    expect(tokenRows.map((r) => r.cache_read_tokens)).toEqual([200, 200, 200]);
    expect(tokenRows.map((r) => r.turn_count)).toEqual([3, 3, 3]);
    // INV-COST-5: every row carries the DF2.3 key's hash and cap.
    for (const r of tokenRows) {
      expect(r.key_hash).toBe("sha256:deadbeef");
      expect(r.key_limit_micro_usd).toBe(50_000_000);
    }

    const runView = ledger.readRunCost(RUN);
    expect(runView?.hasTokenRows).toBe(true);
    // Priced SUM equals the sum of the individual rows exactly.
    expect(runView?.perRole).toEqual({ lead: 12_345, worker: 3_000 });
    expect(runView?.totalMicroUsd).toBe(12_345 + 2_000 + 1_000);
  });

  test("a line missing role is refused with zero rows and a field-naming error (INV-COST-8)", () => {
    writeLog([attributionLine({ role: undefined })]);
    const summary = ingestHarvestedTokens(ledger, runsDir, RUN, { repoSlug: REPO, issueId: ISSUE }, "req-host");
    expect(summary.outcome).toBe("refused");
    expect(summary.rowsRefused).toBe(1);
    expect(rows("SELECT COUNT(*) AS n FROM cost_events")[0]?.n).toBe(0);
    const refusal = logs.find((l) => l.operation === "cost-ledger.token-ingest" && l.outcome === "refused");
    expect(String(refusal?.reason)).toContain("role");
  });

  test("a line missing invocationSeq is refused with zero rows and names the field (INV-COST-8)", () => {
    writeLog([attributionLine({ invocationSeq: undefined })]);
    const summary = ingestHarvestedTokens(ledger, runsDir, RUN, { repoSlug: REPO, issueId: ISSUE }, "req-host");
    expect(summary.outcome).toBe("refused");
    expect(summary.rowsRefused).toBe(1);
    expect(rows("SELECT COUNT(*) AS n FROM cost_events")[0]?.n).toBe(0);
    const refusal = logs.find((l) => l.operation === "cost-ledger.token-ingest" && l.outcome === "refused");
    expect(String(refusal?.reason)).toContain("invocationSeq");
  });

  test("run record without string budget attribution → refused, zero rows, the field is named", () => {
    writeLog([attributionLine()]);
    const summary = ingestHarvestedTokens(ledger, runsDir, RUN, { repoSlug: 123, issueId: ISSUE }, "req-host");
    expect(summary.outcome).toBe("refused");
    expect(summary.rowsRead).toBe(0);
    expect(String(summary.reason)).toContain("repoSlug");
    expect(rows("SELECT COUNT(*) AS n FROM cost_events")[0]?.n).toBe(0);
  });
});

// ─── AC2: idempotency and the second invocation ──────────────────────────────

describe("DF2.12 bridge idempotency (AC2)", () => {
  const LINES = () => [
    attributionLine(),
    attributionLine({ agentId: "worker-1", role: "worker", costMicroUsd: 2_000, timestamp: "2026-09-10T12:02:00.000Z" }),
  ];

  test("re-ingesting the same log adds zero rows (teardown re-run)", () => {
    writeLog(LINES());
    const first = ingestHarvestedTokens(ledger, runsDir, RUN, { repoSlug: REPO, issueId: ISSUE }, "req-1");
    const second = ingestHarvestedTokens(ledger, runsDir, RUN, { repoSlug: REPO, issueId: ISSUE }, "req-2");
    expect(first.rowsInserted).toBe(2);
    expect(second.rowsInserted).toBe(0);
    expect(second.rowsDuplicate).toBe(2);
    expect(second.outcome).toBe("ingested");
    expect(rows("SELECT COUNT(*) AS n FROM cost_events WHERE kind = 'tokens'")[0]?.n).toBe(2);
  });

  test("two genuine invocations of one agent → two rows distinguished by invocation_seq", () => {
    writeLog([
      attributionLine({ agentId: "worker-1", role: "worker", invocationSeq: 0, timestamp: "2026-09-10T12:02:00.000Z" }),
      attributionLine({ agentId: "worker-1", role: "worker", invocationSeq: 1, timestamp: "2026-09-10T12:05:00.000Z" }),
    ]);
    const summary = ingestHarvestedTokens(ledger, runsDir, RUN, { repoSlug: REPO, issueId: ISSUE }, "req-host");
    expect(summary.rowsInserted).toBe(2);
    const seqs = rows(
      "SELECT invocation_seq FROM cost_events WHERE agent_id = 'worker-1' ORDER BY invocation_seq",
    ).map((r) => r.invocation_seq);
    expect(seqs).toEqual([0, 1]);
  });

  test("partial re-harvest: lines 1-2, then lines 1-4 → four rows, the first two unchanged (INV-COST-8's reader rule)", () => {
    const all = [
      attributionLine({ invocationSeq: 0, costMicroUsd: 100, timestamp: "2026-09-10T12:01:00.000Z" }),
      attributionLine({ invocationSeq: 1, costMicroUsd: 200, timestamp: "2026-09-10T12:02:00.000Z" }),
      attributionLine({ invocationSeq: 2, costMicroUsd: 300, timestamp: "2026-09-10T12:03:00.000Z" }),
      attributionLine({ invocationSeq: 3, costMicroUsd: 400, timestamp: "2026-09-10T12:04:00.000Z" }),
    ];
    writeLog(all.slice(0, 2));
    ingestHarvestedTokens(ledger, runsDir, RUN, { repoSlug: REPO, issueId: ISSUE }, "req-1");
    const before = rows("SELECT event_id, invocation_seq, cost_micro_usd FROM cost_events ORDER BY invocation_seq");
    expect(before.map((r) => r.invocation_seq)).toEqual([0, 1]);

    writeLog(all);
    ingestHarvestedTokens(ledger, runsDir, RUN, { repoSlug: REPO, issueId: ISSUE }, "req-2");
    const after = rows("SELECT event_id, invocation_seq, cost_micro_usd FROM cost_events ORDER BY invocation_seq");
    expect(after).toHaveLength(4);
    // The first harvest's rows are byte-identical — a position-derived reader
    // would have renumbered lines 3-4 to 0-1 and collided with them.
    expect(after.slice(0, 2)).toEqual(before);
    expect(after.map((r) => r.cost_micro_usd)).toEqual([100, 200, 300, 400]);
  });
});

// ─── AC4 / INV-COST-9: the fail-closed direction ─────────────────────────────

describe("DF2.12 bridge fail-closed (AC4/INV-COST-9)", () => {
  test("absent log → tokens-not-harvested, zero rows, the path is named", () => {
    const summary = ingestHarvestedTokens(ledger, runsDir, RUN, { repoSlug: REPO, issueId: ISSUE }, "req-host");
    expect(summary.outcome).toBe("tokens-not-harvested");
    expect(summary.rowsRead).toBe(0);
    expect(summary.logPath).toBe(harvestedEngineLogPath(runsDir, RUN));
    expect(String(summary.reason)).toContain(summary.logPath);
    expect(ledger.readRunCost(RUN)?.hasTokenRows).toBe(false);
    const summaryLine = logs.find((l) => l.operation === "cost-ledger.token-ingest-summary");
    expect(summaryLine?.outcome).toBe("tokens-not-harvested");
    expect(String(summaryLine?.logPath)).toContain("engine.log");
  });

  test.skipIf(IS_ROOT)("unreadable log → tokens-not-harvested, never an implicit zero", () => {
    const p = writeLog([attributionLine()]);
    chmodSync(p, 0o000);
    try {
      const summary = ingestHarvestedTokens(ledger, runsDir, RUN, { repoSlug: REPO, issueId: ISSUE }, "req-host");
      expect(summary.outcome).toBe("tokens-not-harvested");
      expect(summary.rowsRead).toBe(0);
      expect(rows("SELECT COUNT(*) AS n FROM cost_events")[0]?.n).toBe(0);
    } finally {
      chmodSync(p, 0o644);
    }
  });

  test("log present with zero cost_attribution lines → no-token-spend, zero rows", () => {
    writeLog(['{"type":"step","name":"implement"}', "not json at all, but not a cost line either"]);
    const summary = ingestHarvestedTokens(ledger, runsDir, RUN, { repoSlug: REPO, issueId: ISSUE }, "req-host");
    expect(summary.outcome).toBe("no-token-spend");
    expect(summary.rowsRead).toBe(0);
    expect(rows("SELECT COUNT(*) AS n FROM cost_events")[0]?.n).toBe(0);
  });

  test("another run's cost_attribution lines are not folded into this run", () => {
    writeLog([attributionLine({ runId: "some-other-run" })]);
    const summary = ingestHarvestedTokens(ledger, runsDir, RUN, { repoSlug: REPO, issueId: ISSUE }, "req-host");
    expect(summary.outcome).toBe("no-token-spend");
    expect(rows("SELECT COUNT(*) AS n FROM cost_events")[0]?.n).toBe(0);
  });
});

// ─── AC5: the unpriced taxonomy, unchanged ───────────────────────────────────

describe("DF2.12 bridge unpriced taxonomy (AC5)", () => {
  test("unpricedTurns > 0 and unusable money reach ingestCostEvent and persist unpriced=1 — never filtered", () => {
    writeLog([
      attributionLine({ agentId: "a-1", unpricedTurns: 1, timestamp: "2026-09-10T12:01:00.000Z" }),
      attributionLine({ agentId: "a-2", costMicroUsd: "junk", timestamp: "2026-09-10T12:02:00.000Z" }),
      attributionLine({ agentId: "a-3", costMicroUsd: 4_000, timestamp: "2026-09-10T12:03:00.000Z" }),
    ]);
    const summary = ingestHarvestedTokens(ledger, runsDir, RUN, { repoSlug: REPO, issueId: ISSUE }, "req-host");
    expect(summary.rowsRead).toBe(3);
    expect(summary.rowsInserted).toBe(3);
    expect(summary.rowsUnpriced).toBe(2);
    expect(summary.outcome).toBe("ingested");

    const unpriced = rows("SELECT agent_id FROM cost_events WHERE unpriced = 1 ORDER BY agent_id").map((r) => r.agent_id);
    expect(unpriced).toEqual(["a-1", "a-2"]);
    // Excluded from the priced SUM, counted in unpricedRows, zero dropped.
    const view = ledger.readRunCost(RUN);
    expect(view?.totalMicroUsd).toBe(4_000);
    expect(view?.unpricedRows).toBe(2);
    expect(view?.hasTokenRows).toBe(true);
  });

  test("a malformed (non-JSON) line is refused loudly and the good lines still land", () => {
    writeLog([
      '{"type":"cost_attribution","runId":"run-bridge-a1"', // truncated tail
      attributionLine({ agentId: "a-1", timestamp: "2026-09-10T12:01:00.000Z" }),
    ]);
    const summary = ingestHarvestedTokens(ledger, runsDir, RUN, { repoSlug: REPO, issueId: ISSUE }, "req-host");
    expect(summary.rowsRead).toBe(1);
    expect(summary.rowsInserted).toBe(1);
    expect(summary.rowsRefused).toBe(1);
    expect(summary.outcome).toBe("ingested");
    expect(summary.rowsUnpriced).toBe(0);
  });
});

// ─── observability + INV-COST-5's no-credentials half ────────────────────────

describe("DF2.12 bridge observability", () => {
  test("per-row and summary lines carry the contract fields; no credential material anywhere", () => {
    writeLog([
      attributionLine(),
      attributionLine({ agentId: "worker-1", role: "worker", costMicroUsd: 2_000, timestamp: "2026-09-10T12:02:00.000Z" }),
    ]);
    ingestHarvestedTokens(ledger, runsDir, RUN, { repoSlug: REPO, issueId: ISSUE }, "req-host");

    const rowLines = logs.filter((l) => l.operation === "cost-ledger.token-ingest");
    expect(rowLines).toHaveLength(2);
    for (const l of rowLines) {
      expect(l.requestId).toBe("req-host");
      expect(l.runId).toBe(RUN);
      expect(l.repoSlug).toBe(REPO);
      expect(l.issueId).toBe(ISSUE);
      expect(l.kind).toBe("tokens");
      expect(["ingested", "duplicate", "refused"]).toContain(l.outcome as string);
      expect(typeof l.ingest_ms).toBe("number");
    }
    const summaryLine = logs.find((l) => l.operation === "cost-ledger.token-ingest-summary") as unknown as { // dp:ok narrows THIS test's own captured log entry
      [k: string]: unknown;
    };
    for (const field of ["rowsRead", "rowsInserted", "rowsDuplicate", "rowsUnpriced", "rowsRefused", "outcome", "logPath", "log_read_ms"]) {
      expect(summaryLine).toHaveProperty(field);
    }
    // INV-COST-5/9: no key, no key hash, no sk-or- token on either leg's lines.
    const dump = JSON.stringify(logs);
    expect(dump).not.toContain("sk-or-");
    expect(dump).not.toContain("deadbeef");
    expect(dump).not.toContain("keyHash");
  });
});

// ─── the classifier qds cost renders from (AC4, same evidence) ───────────────

describe("DF2.12 classifyHarvestedTokens", () => {
  test("absent → tokens-not-harvested naming the path; empty log → no-token-spend; lines counted", () => {
    const absent = classifyHarvestedTokens(runsDir, RUN);
    expect(absent.state).toBe("tokens-not-harvested");
    if (absent.state === "tokens-not-harvested") expect(absent.logPath).toContain(`${RUN}.engine.log`);

    writeLog(['{"type":"step"}']);
    const empty = classifyHarvestedTokens(runsDir, RUN);
    expect(empty.state).toBe("no-token-spend");

    writeLog([attributionLine(), attributionLine({ agentId: "worker-1", role: "worker" })]);
    const present = classifyHarvestedTokens(runsDir, RUN);
    expect(present.state).toBe("token-rows");
    if (present.state === "token-rows") expect(present.lines).toBe(2);
  });
});
