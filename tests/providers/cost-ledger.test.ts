/**
 * DF2.8 — the micro-dollar cost ledger.
 *
 * AC1  one row per emitted event, deterministic event_id PK, idempotent replay,
 *      second invocation of one agent is a second row
 * AC4  malformed events persist unpriced=1 / cost 0, never dropped
 * AC5  zero-row issue reads as a zero view (hasEvents:false), never an error
 * AC6  box-hours: exactly one row per torn-down run, at close only
 * INV-COST-1 append-only enforced by store triggers
 * INV-COST-2 no denormalized cost column anywhere
 * INV-COST-4 integer micro-dollars everywhere; float exists only on the wire
 * INV-COST-5 key_hash + key_limit on every token row, fail-closed when absent
 * INV-COST-6 unopenable ledger / unpersistable ingest refuse, never read as zero
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";

import type { CostEvent } from "../../cli-anything/src/types.ts";
import {
  ADMISSION_GRACE_MS,
  ADMISSION_SKEW_MARGIN_MS,
  CostConfigError,
  CostLedger,
  CostLedgerError,
  DEFAULT_COST_CONFIG,
  capForIssue,
  loadCostConfig,
  type RunCostRecord,
} from "../../src/providers/cost-ledger.ts";
import { setLogSink } from "../../src/swarmclaw/log.ts";

// ─── fixtures ────────────────────────────────────────────────────────────────

let dir: string;
let prevCwd: string;
let prevConfigEnv: string | undefined;
let ledgerPath: string;
let ledger: CostLedger;

/** The record the ledger resolves run_id → key through (DF2.3's mint wrote it). */
const RECORDS = new Map<string, RunCostRecord>();
function seedRecord(runId: string, over: Partial<RunCostRecord> = {}): void {
  RECORDS.set(runId, {
    keyHash: "sha256:deadbeef",
    limitMicroUsd: 50_000_000,
    createdAt: "2026-08-20T12:00:00.000Z",
    ...over,
  });
}

function mkEvent(over: Partial<CostEvent> = {}): CostEvent {
  return {
    agentId: "lead-1",
    model: "cheap/model",
    inputTokens: 1_000,
    outputTokens: 500,
    cacheReadTokens: 200,
    cacheWriteTokens: 100,
    costUsd: 0.012345,
    turnCount: 3,
    unpricedTurns: 0,
    durationMs: 1_500,
    timestamp: "2026-08-20T12:01:00.000Z",
    ...over,
  };
}

function mkCtx(over: Record<string, unknown> = {}) {
  return {
    runId: "run-a1",
    repoSlug: "qds/demo",
    issueId: "42",
    requestId: "req-1",
    role: "lead" as const,
    invocationSeq: 0,
    ...over,
  };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "qds-df28-ledger-"));
  prevCwd = process.cwd();
  prevConfigEnv = process.env.QDS_COST_CONFIG_FILE;
  if (prevConfigEnv !== undefined)
    // biome-ignore lint/performance/noDelete: unsetting env vars requires delete
    delete process.env.QDS_COST_CONFIG_FILE;
  process.chdir(dir);
  RECORDS.clear();
  ledgerPath = join(dir, "cost-ledger.db");
  ledger = new CostLedger({
    path: ledgerPath,
    readRunRecord: (runId) => RECORDS.get(runId),
    config: { defaultCapMicroUsd: 5_000_000, boxHourRateMicroUsd: 3_600_000 },
  });
});

afterEach(() => {
  ledger.close();
  process.chdir(prevCwd);
  rmSync(dir, { recursive: true, force: true });
  if (prevConfigEnv !== undefined) process.env.QDS_COST_CONFIG_FILE = prevConfigEnv;
});

/** Raw handle for trigger/schema assertions — the module itself never updates. */
function rawDb(): Database {
  return new Database(ledgerPath);
}

/**
 * Write a gate_admissions row aged `ageMs` into the past. gate_admissions is
 * append-only, so an admission older than the gate's grace window can only be
 * inserted, never back-dated — and the window is deliberately not injectable,
 * so the clock cannot be faked either.
 *
 * The `decided_at` encoding here is hand-written, so it is only as good as the
 * writer it imitates: "the reader's age predicate is applied to the format the
 * WRITER actually writes" below pins the two together.
 */
function admitAged(runId: string, requestId: string, ceiling: number, ageMs: number, issueId = "42"): void {
  const db = rawDb();
  try {
    db.prepare(
      `INSERT INTO gate_admissions (request_id, run_id, repo_slug, issue_id, ceiling_micro_usd, decided_at)
       VALUES (?,?,?,?,?,?)`,
    ).run(requestId, runId, "qds/demo", issueId, ceiling, new Date(Date.now() - ageMs).toISOString());
  } finally {
    db.close();
  }
}

function rowCount(db: Database, table: string): number {
  return (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
}

// ─── AC1: one row per event, exact attribution, idempotent replay ───────────

describe("DF2.8 cost ledger ingest (AC1)", () => {
  test("three events for one run → three rows, split by role, summing exactly to the issue total", () => {
    seedRecord("run-a1");
    ledger.ingestCostEvent(mkEvent(), mkCtx({ role: "lead", agentId: "lead-1" }));
    ledger.ingestCostEvent(mkEvent({ agentId: "worker-1", costUsd: 0.002, inputTokens: 10 }), mkCtx({ role: "worker", invocationSeq: 1 }));
    ledger.ingestCostEvent(mkEvent({ agentId: "worker-2", costUsd: 0.001, inputTokens: 5 }), mkCtx({ role: "worker", invocationSeq: 2 }));

    const db = rawDb();
    expect(rowCount(db, "cost_events")).toBe(3);
    db.close();

    const view = ledger.readIssueCost("qds/demo", "42");
    expect(view.totalMicroUsd).toBe(12_345 + 2_000 + 1_000);
    expect(view.perRole).toEqual({ lead: 12_345, worker: 3_000 });
    expect(view.hasEvents).toBe(true);
    expect(view.unpricedRows).toBe(0);
  });

  test("re-ingesting the identical event set adds zero rows and mutates none", () => {
    seedRecord("run-a1");
    const events: CostEvent[] = [
      mkEvent({ agentId: "lead-1", costUsd: 0.01 }),
      mkEvent({ agentId: "worker-1", costUsd: 0.02 }),
    ];
    const ctxs = [mkCtx({ role: "lead", invocationSeq: 0 }), mkCtx({ role: "worker", invocationSeq: 1 })];
    for (let i = 0; i < 2; i++) ledger.ingestCostEvent(events[i]!, ctxs[i]!);
    const before = ledger.readIssueCost("qds/demo", "42");

    const second = [ledger.ingestCostEvent(events[0]!, ctxs[0]!), ledger.ingestCostEvent(events[1]!, ctxs[1]!)];
    expect(second.every((r) => r.inserted === false)).toBe(true);

    const after = ledger.readIssueCost("qds/demo", "42");
    expect(after).toEqual(before);

    const db = rawDb();
    expect(rowCount(db, "cost_events")).toBe(2);
    db.close();
  });

  test("a second invocation of the same agent in the same run records a second row, not a collision", () => {
    seedRecord("run-a1");
    // Identical (kind, turn_count, cost_micro_usd, timestamp) — only invocation_seq differs.
    const ev = mkEvent();
    const r1 = ledger.ingestCostEvent(ev, mkCtx({ role: "lead", invocationSeq: 0 }));
    const r2 = ledger.ingestCostEvent(ev, mkCtx({ role: "lead", invocationSeq: 1 }));
    expect(r1.inserted).toBe(true);
    expect(r2.inserted).toBe(true);
    expect(r1.eventId).not.toBe(r2.eventId);

    const db = rawDb();
    expect(rowCount(db, "cost_events")).toBe(2);
    db.close();
    expect(ledger.readIssueCost("qds/demo", "42").totalMicroUsd).toBe(24_690);
  });

  test("redelivery into a FRESH ledger digests identically (event_id is deterministic)", () => {
    seedRecord("run-a1");
    const r1 = ledger.ingestCostEvent(mkEvent(), mkCtx());
    ledger.close();
    const again = new CostLedger({
      path: ledgerPath,
      readRunRecord: (runId) => RECORDS.get(runId),
      config: { defaultCapMicroUsd: 5_000_000 },
    });
    const r2 = again.ingestCostEvent(mkEvent(), mkCtx());
    expect(r2.eventId).toBe(r1.eventId);
    expect(r2.inserted).toBe(false);
    again.close();
    ledger = again; // so afterEach closes the live handle, not the stale one
  });

  test("every required column is populated — no nulls in the NOT NULL set", () => {
    seedRecord("run-a1");
    ledger.ingestCostEvent(mkEvent(), mkCtx());
    const db = rawDb();
    const row = db.prepare(
      "SELECT event_id, run_id, repo_slug, issue_id, request_id, kind, invocation_seq, cost_micro_usd, unpriced, created_at, key_hash, key_limit_micro_usd, role, agent_id FROM cost_events",
    ).get() as Record<string, unknown>;
    db.close();
    for (const key of ["event_id", "run_id", "repo_slug", "issue_id", "request_id", "kind", "invocation_seq", "cost_micro_usd", "unpriced", "created_at", "key_hash", "key_limit_micro_usd", "role", "agent_id"]) {
      expect(row[key]).not.toBeNull();
      expect(row[key]).not.toBeUndefined();
    }
    expect(row.kind).toBe("tokens");
  });
});

// ─── attribution context: fail closed, name the field, write zero rows ──────

describe("DF2.8 attribution ctx (DoD: attribution context)", () => {
  test.each(["runId", "repoSlug", "issueId", "requestId", "role", "invocationSeq"] as const)(
    "ctx omitting %s → structured error naming it, zero rows written",
    (field) => {
      seedRecord("run-a1");
      const ctx = mkCtx() as Record<string, unknown>;
      delete ctx[field];
      const partial = ctx as unknown as Parameters<CostLedger["ingestCostEvent"]>[1];
      expect(() => ledger.ingestCostEvent(mkEvent(), partial)).toThrow(CostLedgerError);
      try {
        const c = mkCtx() as Record<string, unknown>;
        delete c[field];
        ledger.ingestCostEvent(mkEvent(), c as unknown as Parameters<CostLedger["ingestCostEvent"]>[1]);
      } catch (e) {
        const err = e as CostLedgerError;
        expect(err.code).toBe("ingest-ctx-invalid");
        expect(err.message).toContain(field);
        expect(err.remediation).toBeTruthy();
      }
      const db = rawDb();
      expect(rowCount(db, "cost_events")).toBe(0);
      db.close();
    },
  );

  test("the stored role is the dispatcher's verbatim value — nothing derives it from model or agent name", () => {
    seedRecord("run-a1");
    ledger.ingestCostEvent(mkEvent({ model: "worker/model", agentId: "looks-like-a-lead" }), mkCtx({ role: "resident" }));
    const db = rawDb();
    const row = db.prepare("SELECT role FROM cost_events").get() as { role: string };
    db.close();
    expect(row.role).toBe("resident");
  });

  test("token row without any resolvable keyHash → fail closed, zero rows (INV-COST-5)", () => {
    seedRecord("run-a1", { keyHash: undefined });
    let msg = "";
    try {
      ledger.ingestCostEvent(mkEvent(), mkCtx());
    } catch (e) {
      const err = e as CostLedgerError;
      msg = err.message;
      expect(err.code).toBe("key-hash-missing");
    }
    expect(msg).toContain("keyHash");
    const db = rawDb();
    expect(rowCount(db, "cost_events")).toBe(0);
    db.close();
  });
});

// ─── AC4: malformed events are persisted unpriced, never dropped ────────────

describe("DF2.8 malformed events (AC4)", () => {
  test.each([
    ["non-finite costUsd", { costUsd: Number.NaN }],
    ["negative costUsd", { costUsd: -0.01 }],
  ] as const)("malformed cost (%s) → row persisted unpriced=1, cost 0, excluded from SUM, counted", (_label, over) => {
    seedRecord("run-a1");
    const res = ledger.ingestCostEvent(mkEvent(over as Partial<CostEvent>), mkCtx());
    expect(res.unpriced).toBe(true);

    const view = ledger.readIssueCost("qds/demo", "42");
    expect(view.totalMicroUsd).toBe(0); // excluded from the priced SUM
    expect(view.unpricedRows).toBe(1); // surfaced, not silent
    expect(view.hasEvents).toBe(true);

    const db = rawDb();
    const row = db.prepare("SELECT cost_micro_usd, unpriced FROM cost_events").get() as {
      cost_micro_usd: number;
      unpriced: number;
    };
    db.close();
    expect(row.cost_micro_usd).toBe(0);
    expect(row.unpriced).toBe(1);
  });

  test("finite non-negative costUsd with unpricedTurns > 0 → flagged unpriced, converted partial cost kept", () => {
    seedRecord("run-a1");
    const res = ledger.ingestCostEvent(mkEvent({ costUsd: 0.05, unpricedTurns: 2 }), mkCtx());
    expect(res.unpriced).toBe(true);

    const view = ledger.readIssueCost("qds/demo", "42");
    expect(view.totalMicroUsd).toBe(0); // still excluded — partial usage would undercount the cap
    expect(view.unpricedRows).toBe(1); // surfaced, not silent

    const db = rawDb();
    const row = db.prepare("SELECT cost_micro_usd, unpriced FROM cost_events").get() as {
      cost_micro_usd: number;
      unpriced: number;
    };
    db.close();
    expect(row.cost_micro_usd).toBe(50_000); // the recorded partial figure, not zeroed
    expect(row.unpriced).toBe(1);
  });

  test("zero events dropped: priced and unpriced siblings coexist", () => {
    seedRecord("run-a1");
    ledger.ingestCostEvent(mkEvent({ agentId: "a", costUsd: 0.01 }), mkCtx({ invocationSeq: 0 }));
    ledger.ingestCostEvent(mkEvent({ agentId: "b", costUsd: Number.POSITIVE_INFINITY }), mkCtx({ invocationSeq: 1 }));
    const view = ledger.readIssueCost("qds/demo", "42");
    expect(view.totalMicroUsd).toBe(10_000);
    expect(view.unpricedRows).toBe(1);
    const db = rawDb();
    expect(rowCount(db, "cost_events")).toBe(2);
    db.close();
  });

  test("a NONZERO cost that rounds to 0 µ$ is unpriced and says so; a genuine 0 stays priced", () => {
    // The two are byte-identical in the row — `cost_micro_usd = 0` — and mean
    // opposite things: 0.0000004 USD is spend this ledger's UNIT cannot express,
    // a free/cached turn is spend that did not happen. Recorded the same way, the
    // sub-micro one is invisible in `unpricedRows` and reads as real, fully
    // priced, zero money. The flag is what keeps the collapse visible; the log
    // code is what tells an operator WHICH kind of unpriced this row is.
    seedRecord("run-sub");
    seedRecord("run-free");
    const lines: Record<string, unknown>[] = [];
    const restore = setLogSink((e) => lines.push(e as unknown as Record<string, unknown>));
    let sub: ReturnType<CostLedger["ingestCostEvent"]>;
    let free: ReturnType<CostLedger["ingestCostEvent"]>;
    try {
      sub = ledger.ingestCostEvent(
        mkEvent({ agentId: "sub", costUsd: 0.0000004 }),
        mkCtx({ runId: "run-sub", requestId: "req-sub" }),
      );
      free = ledger.ingestCostEvent(
        mkEvent({ agentId: "free", costUsd: 0 }),
        mkCtx({ runId: "run-free", requestId: "req-free" }),
      );
    } finally {
      restore();
    }
    expect(sub.unpriced).toBe(true);
    expect(free.unpriced).toBe(false);

    // Distinguishable from the OTHER unpriced classes (`cost-convert-invalid`,
    // `unpricedTurns`), which is the whole point of giving it its own code.
    const subLine = lines.find((l) => l.agentId === "sub");
    expect(subLine?.code).toBe("cost-sub-micro-unpriced");
    expect(subLine?.costUsd).toBe(0.0000004);
    // A genuinely free turn carries no code at all — nothing collapsed.
    expect(lines.find((l) => l.agentId === "free")?.code).toBeUndefined();

    // Both rows store 0 µ$; only the sub-micro one is counted as unpriced.
    const db = rawDb();
    const rows = db
      .prepare("SELECT agent_id AS agent, cost_micro_usd AS micros, unpriced FROM cost_events ORDER BY agent_id")
      .all() as { agent: string; micros: number; unpriced: number }[];
    db.close();
    expect(rows).toEqual([
      { agent: "free", micros: 0, unpriced: 0 },
      { agent: "sub", micros: 0, unpriced: 1 },
    ]);
    expect(ledger.readIssueCost("qds/demo", "42").unpricedRows).toBe(1);
  });
});

// ─── AC5 + views ─────────────────────────────────────────────────────────────

describe("DF2.8 views (AC2/AC5)", () => {
  test("zero-row issue → 0 µ$, empty split, hasEvents:false, no throw", () => {
    const view = ledger.readIssueCost("qds/demo", "999");
    expect(view.totalMicroUsd).toBe(0);
    expect(view.perRole).toEqual({});
    expect(view.tokenTotals).toEqual({ inputTokens: 0, outputTokens: 0 });
    expect(view.cacheTotals).toEqual({ cacheReadTokens: 0, cacheWriteTokens: 0 });
    expect(view.unpricedRows).toBe(0);
    expect(view.hasEvents).toBe(false);
  });

  test("token and cache totals are summed over priced token rows only", () => {
    seedRecord("run-a1");
    ledger.ingestCostEvent(
      mkEvent({ inputTokens: 100, outputTokens: 40, cacheReadTokens: 7, cacheWriteTokens: 3, costUsd: 0.01 }),
      mkCtx(),
    );
    ledger.ingestCostEvent(
      mkEvent({ agentId: "w", inputTokens: 1, outputTokens: 1, cacheReadTokens: 1, cacheWriteTokens: 1, costUsd: 0.001 }),
      mkCtx({ role: "worker", invocationSeq: 1 }),
    );
    const view = ledger.readIssueCost("qds/demo", "42");
    expect(view.tokenTotals).toEqual({ inputTokens: 101, outputTokens: 41 });
    expect(view.cacheTotals).toEqual({ cacheReadTokens: 8, cacheWriteTokens: 4 });
  });

  test("readRunCost shares the exact view schema, keyed by run", () => {
    seedRecord("run-a1");
    seedRecord("run-b2", { keyHash: "sha256:other", createdAt: "2026-08-20T12:00:00.000Z" });
    ledger.ingestCostEvent(mkEvent({ costUsd: 0.01 }), mkCtx());
    ledger.ingestCostEvent(mkEvent({ costUsd: 0.005 }), mkCtx({ runId: "run-b2", requestId: "req-2", invocationSeq: 1 }));

    const a = ledger.readRunCost("run-a1");
    const b = ledger.readRunCost("run-b2");
    expect(Object.keys(a).sort()).toEqual(Object.keys(b).sort());
    expect(a.totalMicroUsd).toBe(10_000);
    expect(b.totalMicroUsd).toBe(5_000);
    expect(ledger.readRunCost("run-none").hasEvents).toBe(false);
  });

  test("a bare issue number with no repo slug is never defaulted — the reader takes both keys", () => {
    seedRecord("run-a1");
    ledger.ingestCostEvent(mkEvent(), mkCtx({ repoSlug: "qds/demo", issueId: "42" }));
    // Same issueId under a DIFFERENT slug is a different issue — no cross-contamination.
    ledger.ingestCostEvent(mkEvent({ agentId: "x", costUsd: 0.001 }), mkCtx({ repoSlug: "other/repo", issueId: "42", requestId: "r9" }));
    expect(ledger.readIssueCost("qds/demo", "42").totalMicroUsd).toBe(12_345);
    expect(ledger.readIssueCost("other/repo", "42").totalMicroUsd).toBe(1_000);
  });
});

// ─── INV-COST-1/2/4: store-level invariants ─────────────────────────────────

describe("DF2.8 store invariants (INV-COST-1/2/4)", () => {
  test("UPDATE against a persisted row aborts (append-only trigger)", () => {
    seedRecord("run-a1");
    ledger.ingestCostEvent(mkEvent(), mkCtx());
    const db = rawDb();
    expect(() => db.run("UPDATE cost_events SET cost_micro_usd = 0")).toThrow(/append-only/);
    db.close();
  });

  test("DELETE against a persisted row aborts (append-only trigger)", () => {
    seedRecord("run-a1");
    ledger.ingestCostEvent(mkEvent(), mkCtx());
    const db = rawDb();
    expect(() => db.run("DELETE FROM cost_events")).toThrow(/append-only/);
    db.close();
  });

  test("no denormalized cost column exists anywhere (INV-COST-2)", () => {
    const db = rawDb();
    const cols = (db.prepare("PRAGMA table_info(cost_events)").all() as { name: string }[]).map((c) => c.name);
    const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]).map((t) => t.name);
    db.close();
    expect(tables).toEqual(["cost_events", "gate_admissions"]);
    for (const forbidden of ["issue_cost", "total", "total_micro_usd", "spend"]) {
      expect(cols).not.toContain(forbidden);
    }
  });

  test("a float cost value cannot be stored — STRICT INTEGER rejects it (unit-change negative control)", () => {
    seedRecord("run-a1");
    const db = rawDb();
    expect(() =>
      db.run(
        `INSERT INTO cost_events (event_id, run_id, repo_slug, issue_id, request_id, kind, invocation_seq, cost_micro_usd, unpriced, created_at) VALUES ('x','r','s','1','q','tokens',0, 12345.5, 0, '2026-08-20T00:00:00Z')`,
      ),
    ).toThrow();
    db.close();
  });

  test("sub-cent per-role split round-trips without precision loss (all-cheap roster)", () => {
    seedRecord("run-a1");
    // $0.015 across three roles at µ$ resolution: 5000/4999/5001 — cents cannot express this.
    ledger.ingestCostEvent(mkEvent({ agentId: "l", costUsd: 0.005 }), mkCtx({ role: "lead", invocationSeq: 0 }));
    ledger.ingestCostEvent(mkEvent({ agentId: "w1", costUsd: 0.004999 }), mkCtx({ role: "worker", invocationSeq: 1 }));
    ledger.ingestCostEvent(mkEvent({ agentId: "w2", costUsd: 0.005001 }), mkCtx({ role: "worker", invocationSeq: 2 }));
    const view = ledger.readIssueCost("qds/demo", "42");
    expect(view.perRole).toEqual({ lead: 5_000, worker: 10_000 });
    expect(view.totalMicroUsd).toBe(15_000);
  });

  test("the ledger file is 0600 (or 0400 read-only after close)", () => {
    const mode = statSync(ledgerPath).mode & 0o777;
    expect(mode === 0o600 || mode === 0o400).toBe(true);
  });

  test("default path opens .sandbox/cost-ledger.db with a 0700 directory", () => {
    const def = new CostLedger({ readRunRecord: (id) => RECORDS.get(id), config: { defaultCapMicroUsd: 5_000_000 } });
    seedRecord("run-z");
    def.ingestCostEvent(mkEvent(), mkCtx({ runId: "run-z" }));
    def.close();
    expect(statSync(join(dir, ".sandbox", "cost-ledger.db")).mode & 0o777).toBe(0o600);
    expect(statSync(join(dir, ".sandbox")).mode & 0o777).toBe(0o700);
  });
});

// ─── INV-COST-6: fail closed on an unopenable ledger ────────────────────────

describe("DF2.8 fail-closed open (INV-COST-6)", () => {
  test("a ledger path that cannot be opened refuses — never reads as zero spend", () => {
    // A directory at the file path: mkdir succeeds, the open itself fails.
    mkdirSync(join(dir, "blocked.db"), { recursive: true });
    let code = "";
    try {
      new CostLedger({ path: join(dir, "blocked.db"), readRunRecord: () => undefined });
    } catch (e) {
      code = (e as CostLedgerError).code;
    }
    expect(code).toBe("ledger-unopenable");
  });
});

// ─── AC6: box hours ──────────────────────────────────────────────────────────

describe("DF2.8 box hours (AC6)", () => {
  const boxCtx = { runId: "run-a1", repoSlug: "qds/demo", issueId: "42", requestId: "req-1" };

  test("a closed run writes exactly one box_hours row = ceil(lifetime) × rate", () => {
    seedRecord("run-a1", { createdAt: "2026-08-20T12:00:00.000Z", closedAt: "2026-08-20T13:30:00.000Z" });
    const res = ledger.ingestBoxHours(boxCtx);
    expect(res.inserted).toBe(true);

    const db = rawDb();
    const rows = db.prepare(
      "SELECT kind, cost_micro_usd, role, agent_id, key_hash, invocation_seq FROM cost_events WHERE kind='box_hours'",
    ).all() as { kind: string; cost_micro_usd: number; role: string | null; agent_id: string | null; key_hash: string | null; invocation_seq: number }[];
    db.close();
    expect(rows.length).toBe(1);
    expect(rows[0]!.cost_micro_usd).toBe(2 * 3_600_000); // ceil(1.5h) = 2h × 3.6M µ$/h
    expect(rows[0]!.role).toBeNull();
    expect(rows[0]!.agent_id).toBeNull();
    expect(rows[0]!.key_hash).toBeNull();
    expect(rows[0]!.invocation_seq).toBe(0);
  });

  test("re-calling ingestBoxHours on the same closed record writes no second row (idempotent close)", () => {
    seedRecord("run-a1", { closedAt: "2026-08-20T13:30:00.000Z" });
    const first = ledger.ingestBoxHours(boxCtx);
    const second = ledger.ingestBoxHours({ ...boxCtx, requestId: "req-2" }); // different caller, same closed_at
    expect(first.inserted).toBe(true);
    expect(second.inserted).toBe(false);
    expect(second.eventId).toBe(first.eventId);
    const db = rawDb();
    expect(rowCount(db, "cost_events")).toBe(1);
    db.close();
  });

  test("an open record (teardown aborted before close) refuses — zero rows, structured error", () => {
    seedRecord("run-a1"); // no closedAt
    let code = "";
    try {
      ledger.ingestBoxHours(boxCtx);
    } catch (e) {
      code = (e as CostLedgerError).code;
    }
    expect(code).toBe("box-hours-record-open");
    const db = rawDb();
    expect(rowCount(db, "cost_events")).toBe(0);
    db.close();
  });

  test("the issue SUM equals token rows plus exactly one box row — captureSpend money appears nowhere", () => {
    seedRecord("run-a1", { closedAt: "2026-08-20T12:10:00.000Z" });
    ledger.ingestCostEvent(mkEvent({ costUsd: 0.01 }), mkCtx());
    ledger.ingestBoxHours(boxCtx); // ceil(10min) = 1h × 3.6M
    const view = ledger.readIssueCost("qds/demo", "42");
    expect(view.totalMicroUsd).toBe(10_000 + 3_600_000);
    // box-hours surface as an explicit unattributed line, never an invented role
    expect(view.perRole).toEqual({ lead: 10_000, "box-hours": 3_600_000 });
  });

  test("an unconfigured box-hour rate is a structured config error, not a zero row", () => {
    const unConfigured = new CostLedger({ path: ledgerPath, readRunRecord: (id) => RECORDS.get(id) });
    seedRecord("run-a1", { closedAt: "2026-08-20T13:00:00.000Z" });
    expect(() => unConfigured.ingestBoxHours(boxCtx)).toThrow(CostConfigError);
    unConfigured.close();
  });
});

// ─── serialized admission (R2 §6 mandate: the gate's TOCTOU fix) ────────────

describe("DF2.8 serialized admission (R2 §6, INV-COST-3)", () => {
  const cap = 5_000_000;
  /** What the orphan guard actually expires on: the window PLUS the skew clamp. */
  const expiryMs = ADMISSION_GRACE_MS + ADMISSION_SKEW_MARGIN_MS;

  test("under cap: admits, reserves min(keyCap, remaining), returns the decision", () => {
    seedRecord("run-a1");
    const d = ledger.admitIssue({ repoSlug: "qds/demo", issueId: "42", runId: "run-a1", requestId: "req-1" }, cap, 50_000_000);
    if (!d.admitted) throw new Error("expected admission under cap");
    expect(d.admittedCeilingMicroUsd).toBe(cap); // min(50M, 5M-0)
    expect(d.remainingMicroUsd).toBe(cap);
  });

  test("at or above cap: refuses with the exact payload keys", () => {
    seedRecord("run-a1");
    ledger.ingestCostEvent(mkEvent({ costUsd: 5.0 }), mkCtx());
    const d = ledger.admitIssue({ repoSlug: "qds/demo", issueId: "42", runId: "run-a2", requestId: "req-2" }, cap, 50_000_000);
    if (d.admitted) throw new Error("expected refusal at cap");
    expect(d.status).toBe("over-budget");
    expect(d.reason).toBe("spend-cap-exceeded");
    expect(d.capMicroUsd).toBe(cap);
    expect(d.spentMicroUsd).toBe(5_000_000);
    expect(d.unpricedRows).toBe(0);
  });

  test("an outstanding admission reserves its ceiling — the concurrent second dispatch refuses", () => {
    seedRecord("run-a1");
    // Dispatch 1 admits with the full remaining cap…
    const first = ledger.admitIssue({ repoSlug: "qds/demo", issueId: "42", runId: "run-a1", requestId: "req-1" }, cap, 50_000_000);
    expect(first.admitted).toBe(true);
    // …before its spend lands, a concurrent dispatch for the same issue sees the reservation.
    const second = ledger.admitIssue({ repoSlug: "qds/demo", issueId: "42", runId: "run-a2", requestId: "req-2" }, cap, 50_000_000);
    expect(second.admitted).toBe(false);
    expect(second.spentMicroUsd).toBe(0);
    expect(second.reservedMicroUsd).toBe(cap);
  });

  test("a repeated (requestId, runId) returns the RECORDED ceiling, never a second uncounted one", () => {
    seedRecord("run-a0");
    seedRecord("run-a1");
    // The fixture is built so the RECORDED ceiling and the one a retry would
    // recompute DIFFER — otherwise dropping `ceiling = prior.ceiling` keeps the
    // test green and it proves nothing. run-a0 reserves 2M, so run-a1's
    // admission is clamped to the 3M remainder; run-a0 then spends only 500k,
    // which retires its reservation and leaves 4.5M of headroom, so a
    // recomputed ceiling would be min(keyCap 4M, 4.5M) = 4M, not 3M.
    const other = ledger.admitIssue({ repoSlug: "qds/demo", issueId: "42", runId: "run-a0", requestId: "req-0" }, cap, 2_000_000);
    if (!other.admitted) throw new Error("expected the first dispatch to be admitted");
    const first = ledger.admitIssue({ repoSlug: "qds/demo", issueId: "42", runId: "run-a1", requestId: "req-1" }, cap, 4_000_000);
    if (!first.admitted) throw new Error("expected first admission");
    expect(first.admittedCeilingMicroUsd).toBe(3_000_000); // cap − run-a0's 2M reservation
    ledger.ingestCostEvent(mkEvent({ agentId: "lead-0", costUsd: 0.5 }), mkCtx({ runId: "run-a0", requestId: "req-0" }));

    // A retried dispatch reusing its correlation id: `ON CONFLICT DO NOTHING`
    // writes no row, so a freshly-computed ceiling here would be handed to the
    // mint while holding NO reservation — and the next dispatch would grant the
    // same headroom all over again.
    const retry = ledger.admitIssue({ repoSlug: "qds/demo", issueId: "42", runId: "run-a1", requestId: "req-1" }, cap, 4_000_000);
    if (!retry.admitted) throw new Error("expected the retry to be admitted");
    expect(retry.admittedCeilingMicroUsd).toBe(3_000_000); // the recorded one, not the 4M recompute
    expect(retry.spentMicroUsd).toBe(500_000);
    // Its own reservation is not counted against it — the retry is judged
    // against the headroom its original saw — and the ceiling it hands back
    // still fits inside that headroom.
    expect(retry.reservedMicroUsd).toBe(0);
    expect(retry.remainingMicroUsd).toBe(4_500_000);
    expect(retry.admittedCeilingMicroUsd).toBeLessThanOrEqual(retry.remainingMicroUsd);
    // Exactly one reservation on the books per correlation id, not two: the
    // decision's own `reservedMicroUsd` is read BEFORE the INSERT, so only the
    // row count can see a double-insert.
    const db = rawDb();
    expect(rowCount(db, "gate_admissions")).toBe(2);
    db.close();
  });

  test("a retry whose own reservation is the whole cap is still admitted, not refused as over-budget", () => {
    seedRecord("run-a1");
    // The default configuration: keyCap (50M) above the cap (5M), so the first
    // admission reserves the ENTIRE cap. Counting that reservation against its
    // own retry makes `committed >= cap` and refuses every retry before the
    // replay branch can run — the idempotent path was unreachable in the only
    // configuration that ships.
    const first = ledger.admitIssue({ repoSlug: "qds/demo", issueId: "42", runId: "run-a1", requestId: "req-1" }, cap, 50_000_000);
    if (!first.admitted) throw new Error("expected first admission");
    expect(first.admittedCeilingMicroUsd).toBe(cap);

    const retry = ledger.admitIssue({ repoSlug: "qds/demo", issueId: "42", runId: "run-a1", requestId: "req-1" }, cap, 50_000_000);
    if (!retry.admitted) throw new Error("expected the saturated retry to be admitted idempotently");
    expect(retry.admittedCeilingMicroUsd).toBe(cap);
    expect(retry.remainingMicroUsd).toBe(cap);

    // …and the exclusion is strictly the caller's own row: a DIFFERENT
    // correlation id still sees the reservation and is still refused.
    const other = ledger.admitIssue({ repoSlug: "qds/demo", issueId: "42", runId: "run-a2", requestId: "req-2" }, cap, 50_000_000);
    expect(other.admitted).toBe(false);
    expect(other.reservedMicroUsd).toBe(cap);
    const db = rawDb();
    expect(rowCount(db, "gate_admissions")).toBe(1); // the retry inserted nothing
    db.close();
  });

  test("a replayed correlation id under a DIFFERENT repository is refused, not admitted on the old ceiling", () => {
    seedRecord("run-a1");
    const first = ledger.admitIssue(
      { repoSlug: "qds/demo", issueId: "42", runId: "run-a1", requestId: "req-1" },
      cap,
      50_000_000,
    );
    if (!first.admitted) throw new Error("expected first admission");

    // The PRIMARY KEY is (request_id, run_id) alone, so this INSERT conflicts
    // with a row the reservation query — scoped to (repo_slug, issue_id) —
    // never saw. Returning its ceiling would authorize spend against a budget
    // holding NOTHING for it: the reservation lives on qds/demo#42's cap.
    expect(() =>
      ledger.admitIssue(
        { repoSlug: "other/repo", issueId: "42", runId: "run-a1", requestId: "req-1" },
        cap,
        50_000_000,
      ),
    ).toThrow(CostLedgerError);
    try {
      ledger.admitIssue(
        { repoSlug: "other/repo", issueId: "42", runId: "run-a1", requestId: "req-1" },
        cap,
        50_000_000,
      );
      throw new Error("expected the cross-repo replay to refuse");
    } catch (e) {
      expect((e as CostLedgerError).code).toBe("ledger-admission-mismatch");
      // The refusal names both identities — an operator has to see WHICH budget
      // holds the reservation to know the replay is a caller bug.
      expect((e as Error).message).toContain("qds/demo#42");
      expect((e as Error).message).toContain("other/repo#42");
    }

    // Append-only, and nothing was minted: the ledger still holds exactly the
    // one reservation the first admission made.
    const db = rawDb();
    expect(rowCount(db, "gate_admissions")).toBe(1);
    db.close();

    // Case differences are NOT a mismatch: repo identity is canonical, and rows
    // written before it was hold the brief's original casing.
    const cased = ledger.admitIssue(
      { repoSlug: "QDS/Demo", issueId: "42", runId: "run-a1", requestId: "req-1" },
      cap,
      50_000_000,
    );
    if (!cased.admitted) throw new Error("expected the canonical-casing retry to replay idempotently");
    expect(cased.admittedCeilingMicroUsd).toBe(first.admittedCeilingMicroUsd);
  });

  test("a replayed correlation id under a DIFFERENT issue is refused, not admitted on the old ceiling", () => {
    seedRecord("run-a1");
    const first = ledger.admitIssue(
      { repoSlug: "qds/demo", issueId: "42", runId: "run-a1", requestId: "req-1" },
      cap,
      50_000_000,
    );
    if (!first.admitted) throw new Error("expected first admission");

    try {
      ledger.admitIssue(
        { repoSlug: "qds/demo", issueId: "7", runId: "run-a1", requestId: "req-1" },
        cap,
        50_000_000,
      );
      throw new Error("expected the cross-issue replay to refuse");
    } catch (e) {
      expect((e as CostLedgerError).code).toBe("ledger-admission-mismatch");
      expect((e as Error).message).toContain("qds/demo#42");
      expect((e as Error).message).toContain("qds/demo#7");
    }

    // Issue #7's own cap is untouched by the refusal: a FRESH correlation id
    // still admits against it, so the guard refuses the collision, not the run.
    seedRecord("run-b1");
    const fresh = ledger.admitIssue(
      { repoSlug: "qds/demo", issueId: "7", runId: "run-b1", requestId: "req-2" },
      cap,
      50_000_000,
    );
    if (!fresh.admitted) throw new Error("expected a fresh correlation id to admit under issue 7");
    expect(fresh.reservedMicroUsd).toBe(0); // #42's reservation is not #7's
  });

  test("the reservation retires once the run's first priced ledger row lands", () => {
    seedRecord("run-a1");
    ledger.admitIssue({ repoSlug: "qds/demo", issueId: "42", runId: "run-a1", requestId: "req-1" }, cap, 50_000_000);
    ledger.ingestCostEvent(mkEvent({ costUsd: 0.01 }), mkCtx()); // run-a1 now has priced rows
    const next = ledger.admitIssue({ repoSlug: "qds/demo", issueId: "42", runId: "run-a2", requestId: "req-2" }, cap, 50_000_000);
    if (!next.admitted) throw new Error("expected admission after retirement");
    expect(next.reservedMicroUsd).toBe(0);
    expect(next.spentMicroUsd).toBe(10_000);
    expect(next.admittedCeilingMicroUsd).toBe(4_990_000);
  });

  test("an unpriced row does not retire the reservation — unpriced traffic cannot silently restore headroom", () => {
    seedRecord("run-a1");
    ledger.admitIssue({ repoSlug: "qds/demo", issueId: "42", runId: "run-a1", requestId: "req-1" }, cap, 50_000_000);
    // Unpriced (partial usage): persists, is excluded from the priced SUM, and
    // by design does NOT retire run-a1's reservation — its spend is not
    // observable, so the full ceiling stays counted until a priced row lands.
    ledger.ingestCostEvent(mkEvent({ costUsd: 0.01, unpricedTurns: 1 }), mkCtx());
    const next = ledger.admitIssue({ repoSlug: "qds/demo", issueId: "42", runId: "run-a2", requestId: "req-2" }, cap, 50_000_000);
    expect(next.admitted).toBe(false);
    expect(next.reservedMicroUsd).toBe(cap);
  });

  test("a priced ZERO row does not retire the reservation — a free first turn cannot hand out the cap twice", () => {
    // THE blocker. A cached or free first turn writes a perfectly valid
    // `cost_micro_usd = 0, unpriced = 0` row, and testing the reservation's
    // retirement on the EXISTENCE of a priced row retired run-a1's ENTIRE
    // ceiling while its key was still live at that ceiling: the next dispatch
    // then read `spent = 0, reserved = 0` and was granted the full cap again,
    // N times over for N dispatches. `ce.cost_micro_usd > 0` is the difference
    // between "has reported what it spent" and "has reported something".
    seedRecord("run-a1");
    const first = ledger.admitIssue({ repoSlug: "qds/demo", issueId: "42", runId: "run-a1", requestId: "req-1" }, cap, 50_000_000);
    if (!first.admitted) throw new Error("expected the first dispatch to be admitted");
    expect(first.admittedCeilingMicroUsd).toBe(cap);

    ledger.ingestCostEvent(mkEvent({ costUsd: 0 }), mkCtx());
    // Priced (it is not unpriced traffic — that case is covered above), zero,
    // and present: the exact row the existence test mistook for spend.
    const view = ledger.readIssueCost("qds/demo", "42");
    expect(view.hasEvents).toBe(true);
    expect(view.unpricedRows).toBe(0);
    expect(view.totalMicroUsd).toBe(0);

    const next = ledger.admitIssue({ repoSlug: "qds/demo", issueId: "42", runId: "run-a2", requestId: "req-2" }, cap, 50_000_000);
    if (next.admitted) throw new Error("expected the second dispatch to be refused — run-a1's key is still live at the full cap");
    expect(next.reservedMicroUsd).toBe(cap);
    expect(next.spentMicroUsd).toBe(0);
  });

  test("a CLOSED run record retires the reservation — a genuinely zero-cost run cannot wedge the issue forever", () => {
    // The other half of "spend, not a row": with retirement keyed on positive
    // spend, a run that really did cost nothing would hold its ceiling against
    // the issue for good, and `gate_admissions_no_delete` leaves no manual exit.
    // A closed record means the box is destroyed and the key revoked, so there
    // is no unspent exposure left to reserve against.
    seedRecord("run-a1");
    const first = ledger.admitIssue({ repoSlug: "qds/demo", issueId: "42", runId: "run-a1", requestId: "req-1" }, cap, 50_000_000);
    if (!first.admitted) throw new Error("expected the first dispatch to be admitted");
    // Still OPEN with a priced-zero row ⇒ still reserved (the case above).
    ledger.ingestCostEvent(mkEvent({ costUsd: 0 }), mkCtx());
    const whileOpen = ledger.admitIssue({ repoSlug: "qds/demo", issueId: "42", runId: "run-a2", requestId: "req-2" }, cap, 50_000_000);
    expect(whileOpen.admitted).toBe(false);

    // Teardown closes the record; the exposure is over.
    seedRecord("run-a1", { closedAt: "2026-08-20T13:00:00.000Z" });
    const afterClose = ledger.admitIssue({ repoSlug: "qds/demo", issueId: "42", runId: "run-a3", requestId: "req-3" }, cap, 50_000_000);
    if (!afterClose.admitted) throw new Error("expected the closed run's reservation to have retired");
    expect(afterClose.reservedMicroUsd).toBe(0);
    expect(afterClose.admittedCeilingMicroUsd).toBe(cap);
  });

  test("a FRESHLY-closed record keeps counting until its close passes the grace cutoff", () => {
    // The close→price race guard, in the over-reserve direction. Teardown closes
    // the record FIRST and writes the priced box_hours row moments later;
    // retiring on the bare close freed headroom inside exactly that window and
    // the imminent charge then landed past cap — box hours being the one term no
    // key bounds. So a young close must keep the ceiling counted (the opposite
    // trade of the fixed-past-timestamp test above, which is what makes this one
    // runnable without a faked clock).
    seedRecord("run-a1");
    const first = ledger.admitIssue({ repoSlug: "qds/demo", issueId: "42", runId: "run-a1", requestId: "req-1" }, cap, 50_000_000);
    if (!first.admitted) throw new Error("expected the first dispatch to be admitted");
    // A priced ZERO row is present too — neither retirement arm may fire.
    ledger.ingestCostEvent(mkEvent({ costUsd: 0 }), mkCtx());
    seedRecord("run-a1", { closedAt: new Date().toISOString() }); // teardown just closed it
    const next = ledger.admitIssue({ repoSlug: "qds/demo", issueId: "42", runId: "run-a2", requestId: "req-2" }, cap, 50_000_000);
    if (next.admitted) throw new Error("expected the freshly-closed reservation to still count");
    expect(next.reservedMicroUsd).toBe(cap);
    expect(next.spentMicroUsd).toBe(0);
  });

  test("close-retirement fires once the close is past the cutoff, not merely 'a while' after it", () => {
    // The boundary arm of the test above, on a LIVE timestamp rather than a
    // fixed past date: the cutoff is ADMISSION_GRACE_MS + ADMISSION_SKEW_MARGIN_MS
    // before now, and a close just past it retires even though its admission row
    // is brand new — the cutoff qualifier rides closedAt alone, not decided_at.
    seedRecord("run-a1");
    const first = ledger.admitIssue({ repoSlug: "qds/demo", issueId: "42", runId: "run-a1", requestId: "req-1" }, cap, 50_000_000);
    if (!first.admitted) throw new Error("expected the first dispatch to be admitted");
    ledger.ingestCostEvent(mkEvent({ costUsd: 0 }), mkCtx());
    const cutoff = expiryMs + 1_000; // just past the grace window + skew margin
    seedRecord("run-a1", { closedAt: new Date(Date.now() - cutoff).toISOString() });
    const next = ledger.admitIssue({ repoSlug: "qds/demo", issueId: "42", runId: "run-a2", requestId: "req-2" }, cap, 50_000_000);
    if (!next.admitted) throw new Error("expected the aged close's reservation to have retired");
    expect(next.reservedMicroUsd).toBe(0);
  });

  test("a THROWING log sink does not turn an already-committed admission into an error (S13)", () => {
    // The decision is durable the moment `decide.immediate()` returns; a custom
    // setLogSink that raises used to surface out of admitIssue AFTER that commit,
    // so the gate retried a dispatch the ledger had already reserved for. Swallow
    // with a stderr note naming the operation instead — never the payload, which
    // is not redacted on stderr.
    seedRecord("run-a1");
    let threw = false; // flipped by the first sink call, so a silent skip cannot pass
    let notes = "";
    const restore = setLogSink(() => {
      threw = true;
      throw new Error("sink exploded");
    });
    const origWrite = process.stderr.write;
    process.stderr.write = ((chunk: unknown) => {
      notes += String(chunk);
      return true;
    }) as typeof process.stderr.write;
    let decision: ReturnType<CostLedger["admitIssue"]>;
    try {
      decision = ledger.admitIssue(
        { repoSlug: "qds/demo", issueId: "42", runId: "run-a1", requestId: "req-1" },
        cap,
        50_000_000,
      );
    } finally {
      restore();
      process.stderr.write = origWrite;
    }
    expect(threw).toBe(true); // the sink really ran and really raised
    if (!decision.admitted) throw new Error("expected the committed admission to be returned");
    expect(decision.admittedCeilingMicroUsd).toBe(cap);
    // And it really committed: the reservation row exists behind the returned
    // ceiling, not just in the value the caller happens to hold.
    const db = rawDb();
    expect(rowCount(db, "gate_admissions")).toBe(1);
    db.close();
    expect(notes).toContain("log sink threw for cost-ledger.gate");
    expect(notes).toContain("the ledger outcome stands");
  });

  test("two admission rows for ONE run reserve its ceiling ONCE, not twice", () => {
    // gate_admissions' PRIMARY KEY is (request_id, run_id), so a dispatch
    // retried under a FRESH request id for the same run inserts a SECOND row.
    // Ungrouped, both counted: the issue's headroom fell by twice the ceiling
    // for a single live key, and later legitimate dispatches were refused
    // against exposure that does not exist.
    seedRecord("run-a1");
    const first = ledger.admitIssue({ repoSlug: "qds/demo", issueId: "42", runId: "run-a1", requestId: "req-1" }, cap, 1_000_000);
    if (!first.admitted) throw new Error("expected the first admission");
    expect(first.admittedCeilingMicroUsd).toBe(1_000_000);
    // Same run, fresh correlation id — not a replay, so `DO NOTHING` does not
    // fire and a second row lands.
    const retry = ledger.admitIssue({ repoSlug: "qds/demo", issueId: "42", runId: "run-a1", requestId: "req-1b" }, cap, 1_500_000);
    if (!retry.admitted) throw new Error("expected the re-admission under a fresh request id");
    const db = rawDb();
    expect(rowCount(db, "gate_admissions")).toBe(2); // two rows, one run
    db.close();

    // A third dispatch sees ONE reservation for run-a1, at MAX(ceiling) — the
    // largest exposure, which is the fail-safe pick — not 1M + 1.5M.
    seedRecord("run-a2");
    const third = ledger.admitIssue({ repoSlug: "qds/demo", issueId: "42", runId: "run-a2", requestId: "req-2" }, cap, 50_000_000);
    if (!third.admitted) throw new Error("expected the third dispatch to be admitted");
    expect(third.reservedMicroUsd).toBe(1_500_000);
    expect(third.remainingMicroUsd).toBe(cap - 1_500_000);
  });

  test("the SELECT and the INSERT run inside ONE write transaction — a concurrent writer is locked out mid-decision", () => {
    // Every other test here is SEQUENTIAL, so all of them stay green with the
    // `decide.immediate()` wrapper deleted: one call finishes before the next
    // begins, and a bare SELECT-then-INSERT is indistinguishable from a
    // serialized one. What that wrapper buys is the thing sequential calls can
    // never exercise — that no OTHER connection can commit between this
    // admission's SUM and its reservation. Two real dispatchers interleaved
    // there each read the same headroom and each mint the full cap.
    //
    // The probe rides `readRunRecord`, which is the one caller-supplied seam
    // that runs INSIDE the transaction body: reservations are prefetched before
    // the write lock is taken, so a row that appears after the prefetch is read
    // live under the lock. `run-late` is inserted from the prefetch callback to
    // put it in exactly that position.
    const probePath = ledgerPath;
    // An array, not a scalar: the seam fires from inside a callback, so a
    // narrowed `let` is a type error at the assertion — and the length is worth
    // having anyway. Exactly one probe means the seam fired where it was meant
    // to and not on some other row.
    const lockProbe: string[] = [];
    const probing = new CostLedger({
      path: probePath,
      readRunRecord: (id) => {
        if (id === "run-early") {
          // Prefetch is OUTSIDE the lock, so this write succeeds — and lands
          // run-late in the reservation SELECT the transaction is about to run.
          const w = new Database(probePath);
          try {
            w.prepare(
              `INSERT INTO gate_admissions (request_id, run_id, repo_slug, issue_id, ceiling_micro_usd, decided_at)
               VALUES ('req-late', 'run-late', 'qds/demo', '42', 1000000, ?)`,
            ).run(new Date().toISOString());
          } finally {
            w.close();
          }
          return RECORDS.get(id);
        }
        if (id === "run-late") {
          // Inside `decide.immediate()`. A second connection must not be able to
          // start writing here: with the wrapper dropped there is no write lock
          // at all, and with `.deferred()` WAL readers do not block writers
          // either — both let this BEGIN IMMEDIATE through.
          const other = new Database(probePath);
          try {
            other.exec("PRAGMA busy_timeout = 0;");
            other.exec("BEGIN IMMEDIATE;");
            lockProbe.push("acquired");
            other.exec("ROLLBACK;");
          } catch (e) {
            expect((e as Error).message).toMatch(/busy|locked/i);
            lockProbe.push("busy");
          } finally {
            other.close();
          }
          return RECORDS.get(id);
        }
        return RECORDS.get(id);
      },
      config: { defaultCapMicroUsd: cap, boxHourRateMicroUsd: 3_600_000 },
    });
    try {
      seedRecord("run-early");
      seedRecord("run-late");
      seedRecord("run-new");
      // One pre-existing reservation, so the prefetch loop runs at all.
      admitAged("run-early", "req-early", 1_000_000, 0);
      const d = probing.admitIssue({ repoSlug: "qds/demo", issueId: "42", runId: "run-new", requestId: "req-new" }, cap, 50_000_000);
      // The seam fired where it was supposed to: under the lock, not before it.
      expect(lockProbe).toEqual(["busy"]);
      // …and the late row was in the decision, which is what proves the SELECT
      // ran inside the same transaction the INSERT did.
      if (!d.admitted) throw new Error("expected the admission to be granted");
      expect(d.reservedMicroUsd).toBe(2_000_000); // run-early + run-late
    } finally {
      probing.close();
    }
  });

  test("an unwired readRunRecord counts every outstanding reservation (fail-safe default)", () => {
    const bare = new CostLedger({ path: join(dir, "bare.db") });
    const a = bare.admitIssue({ repoSlug: "qds/demo", issueId: "42", runId: "run-b1", requestId: "req-b1" }, cap, 50_000_000);
    if (!a.admitted) throw new Error("expected first admission");
    // The default seam resolves a (keyless) record for every runId, so the
    // orphan guard never expires run-b1's reservation on an unwired ledger —
    // over-reserving is the fail-safe direction (INV-COST-6).
    const b = bare.admitIssue({ repoSlug: "qds/demo", issueId: "42", runId: "run-b2", requestId: "req-b2" }, cap, 50_000_000);
    expect(b.admitted).toBe(false);
    expect(b.reservedMicroUsd).toBe(cap);
    bare.close();
  });

  test("admission is serialized: the concurrent second dispatch refuses where a bare read-compare would pass both", () => {
    seedRecord("run-a0");
    seedRecord("run-a1");
    seedRecord("run-a2");
    // Prior completed run's spend: 4.9M of the 5M cap.
    ledger.ingestCostEvent(mkEvent({ agentId: "lead-0", costUsd: 4.9 }), mkCtx({ runId: "run-a0", requestId: "r0" }));
    // Two fresh dispatches (fresh runIds — the gate runs before store.create, so a
    // dispatched run never has rows yet). Reservation accounting must make the
    // second refuse: 4.9M spent + 100k reserved = at cap. A bare read-and-compare
    // reads 4.9M twice and admits both — the TOCTOU R2 §6 exists to close.
    const a = ledger.admitIssue({ repoSlug: "qds/demo", issueId: "42", runId: "run-a1", requestId: "r1" }, cap, 50_000_000);
    const b = ledger.admitIssue({ repoSlug: "qds/demo", issueId: "42", runId: "run-a2", requestId: "r2" }, cap, 50_000_000);
    if (a.admitted !== true) throw new Error("expected first admission");
    if (b.admitted !== false) throw new Error("expected second refusal");
    expect(a.admittedCeilingMicroUsd).toBe(100_000);
    expect(b.reservedMicroUsd).toBe(100_000);
  });

  test("gate_admissions is append-only too", () => {
    seedRecord("run-a1");
    ledger.admitIssue({ repoSlug: "qds/demo", issueId: "42", runId: "run-a1", requestId: "r1" }, cap, 50_000_000);
    const db = rawDb();
    expect(() => db.run("DELETE FROM gate_admissions")).toThrow(/append-only/);
    db.close();
  });

  test("an admitted ceiling subtracts outstanding reservations from headroom — never over-commits the cap", () => {
    seedRecord("run-a0");
    seedRecord("run-a1");
    seedRecord("run-a2");
    ledger.ingestCostEvent(mkEvent({ agentId: "lead-0", costUsd: 1.0 }), mkCtx({ runId: "run-a0", requestId: "r0" })); // 1M spent
    // Dispatch 1: keyCap (500k) below the 4M headroom — the key-cap clamp wins.
    const first = ledger.admitIssue({ repoSlug: "qds/demo", issueId: "42", runId: "run-a1", requestId: "r1" }, cap, 500_000);
    if (!first.admitted) throw new Error("expected first admission");
    expect(first.admittedCeilingMicroUsd).toBe(500_000);
    // Dispatch 2: headroom is cap − spent − reserved (3.5M), the same committed
    // figure the refusal check uses — not cap − spent (4M).
    const second = ledger.admitIssue({ repoSlug: "qds/demo", issueId: "42", runId: "run-a2", requestId: "r2" }, cap, 4_000_000);
    if (!second.admitted) throw new Error("expected second admission");
    expect(second.reservedMicroUsd).toBe(500_000);
    expect(second.remainingMicroUsd).toBe(cap - 1_000_000 - 500_000);
    expect(second.admittedCeilingMicroUsd).toBe(cap - 1_000_000 - 500_000); // never above cap − committed
  });

  test("an admission whose run record never existed (store.create failed) expires — it cannot consume the issue cap", () => {
    seedRecord("run-real");
    // Orphaned admission: dispatched, admitted, then store.create threw
    // (EEXIST / invalid id) — no run record, so no run can ever report spend.
    // Aged past the grace window by INSERTing it directly: gate_admissions is
    // append-only, so an old admission can only be created, never back-dated.
    admitAged("run-orphan", "r1", cap, expiryMs * 2);
    // A later dispatch for a real run is not refused by the orphan's reservation.
    const after = ledger.admitIssue({ repoSlug: "qds/demo", issueId: "42", runId: "run-real", requestId: "r2" }, cap, 50_000_000);
    if (!after.admitted) throw new Error("expected admission past the expired orphan reservation");
    expect(after.reservedMicroUsd).toBe(0);
  });

  test("two dispatches racing one issue cannot both win the full remaining headroom", () => {
    // The real interleaving: A's admission COMMITs, and A has NOT yet reached
    // store.create — so A's run record does not resolve when B walks the
    // reservations. Without the grace window B reads A's reservation as an
    // orphan, skips it, and both are granted the whole 5M cap.
    const a = ledger.admitIssue({ repoSlug: "qds/demo", issueId: "42", runId: "run-race-a", requestId: "ra" }, cap, 50_000_000);
    if (!a.admitted) throw new Error("expected the first dispatch to be admitted");
    expect(a.admittedCeilingMicroUsd).toBe(cap);
    expect(RECORDS.has("run-race-a")).toBe(false); // store.create has not run yet

    const b = ledger.admitIssue({ repoSlug: "qds/demo", issueId: "42", runId: "run-race-b", requestId: "rb" }, cap, 50_000_000);
    // A holds the entire cap, so B has no headroom at all — and for THAT
    // reason. `admitted: false` alone is every refusal shape the ledger has, so
    // a refusal on some unrelated ground would read as "the reservation held".
    if (b.admitted) throw new Error("expected the second dispatch to be refused");
    expect(b.status).toBe("over-budget");
    expect(b.reason).toBe("spend-cap-exceeded");
    expect(b.reservedMicroUsd).toBe(cap);

    // And with room for both, the second ceiling is the REMAINDER — never the
    // full headroom a second time. `d`'s keyCap is deliberately ABOVE the 3M
    // remainder: with a keyCap at or below it, `min(keyCap, remaining)` returns
    // the keyCap and a bug handing `d` the whole remaining headroom is
    // indistinguishable from correct.
    const c = ledger.admitIssue({ repoSlug: "qds/demo", issueId: "7", runId: "run-race-c", requestId: "rc" }, cap, 2_000_000);
    const d = ledger.admitIssue({ repoSlug: "qds/demo", issueId: "7", runId: "run-race-d", requestId: "rd" }, cap, 4_000_000);
    if (!c.admitted || !d.admitted) throw new Error("expected both dispatches on the fresh issue to be admitted");
    expect(c.admittedCeilingMicroUsd).toBe(2_000_000); // the keyCap clamp
    expect(d.reservedMicroUsd).toBe(2_000_000);
    expect(d.admittedCeilingMicroUsd).toBe(cap - 2_000_000); // the remainder, not 4M and not the full cap
    expect(c.admittedCeilingMicroUsd + d.admittedCeilingMicroUsd).toBe(cap);
  });

  test("a reservation younger than the grace window counts even with no run record; an older one does not", () => {
    admitAged("run-young", "ry", 1_000_000, ADMISSION_GRACE_MS / 2); // its dispatch is still in flight
    const withYoung = ledger.admitIssue({ repoSlug: "qds/demo", issueId: "42", runId: "run-x", requestId: "rx" }, cap, 500_000);
    if (!withYoung.admitted) throw new Error("expected admission alongside the young reservation");
    expect(withYoung.reservedMicroUsd).toBe(1_000_000);

    admitAged("run-old", "ro", 1_000_000, expiryMs * 2); // no record, past the window — orphaned
    const withOld = ledger.admitIssue({ repoSlug: "qds/demo", issueId: "42", runId: "run-y", requestId: "ryy" }, cap, 500_000);
    if (!withOld.admitted) throw new Error("expected admission past the expired reservation");
    // run-young (still young) + run-x's own 500k reservation. run-old is not
    // counted, so adding it left the reserved figure unchanged.
    expect(withOld.reservedMicroUsd).toBe(1_500_000);
  });

  test("the expiry boundary is the grace window itself, not merely 'a while'", () => {
    // Two separate properties, and importing the constant only buys the first:
    //
    // 1. The boundary IS the constant. The /2 and *2 ages above pass for any
    //    window strictly between them; these two rows straddle it by a second
    //    in each direction, so an expiry that drifts off the constant fails.
    //    Derived from the import, so this holds at whatever the window is set to.
    // 2. The constant is 60s. Ages derived from the import move WITH a retune,
    //    which is what stops the tests going flaky — and also what stops them
    //    noticing. This line is the noticing: the window is a money knob (too
    //    short double-allocates the cap under the dispatch race, too long wedges
    //    an issue for minutes), so retuning it should be a deliberate two-file
    //    change a reviewer sees, not a silent one.
    expect(ADMISSION_GRACE_MS).toBe(60_000);
    expect(ADMISSION_SKEW_MARGIN_MS).toBe(300_000);
    admitAged("run-just-young", "rjy", 1_000_000, expiryMs - 1_000, "101");
    const young = ledger.admitIssue({ repoSlug: "qds/demo", issueId: "101", runId: "run-jy", requestId: "rjy2" }, cap, 500_000);
    if (!young.admitted) throw new Error("expected admission alongside the just-young reservation");
    expect(young.reservedMicroUsd).toBe(1_000_000);

    admitAged("run-just-old", "rjo", 1_000_000, expiryMs + 1_000, "102");
    const old = ledger.admitIssue({ repoSlug: "qds/demo", issueId: "102", runId: "run-jo", requestId: "rjo2" }, cap, 500_000);
    if (!old.admitted) throw new Error("expected admission past the just-old reservation");
    expect(old.reservedMicroUsd).toBe(0);
  });

  test("a reservation written by a host whose clock lags ours is not expired as an orphan", () => {
    // `decided_at` is the WRITER's wall clock. A reader whose clock sits a few
    // minutes ahead (NTP step, VM resume, container drift) reads a reservation
    // committed SECONDS ago as minutes old. Without the skew clamp it expires,
    // and the full remaining headroom is handed out a second time against the
    // same cap — the double allocation the grace window exists to prevent.
    // Skew is indistinguishable from age in the row itself, so the age below is
    // exactly what a 4-minute-fast reader sees of a brand-new reservation.
    admitAged("run-skewed", "rs", 1_000_000, ADMISSION_GRACE_MS + 180_000, "103");
    const after = ledger.admitIssue({ repoSlug: "qds/demo", issueId: "103", runId: "run-sk", requestId: "rs2" }, cap, 500_000);
    if (!after.admitted) throw new Error("expected admission alongside the skewed reservation");
    expect(after.reservedMicroUsd).toBe(1_000_000); // still counted, not skipped

    // The other direction of skew — a writer running ahead of us — is younger
    // than any cutoff and was never at risk.
    admitAged("run-future", "rf1", 2_000_000, -ADMISSION_GRACE_MS, "104");
    const withFuture = ledger.admitIssue({ repoSlug: "qds/demo", issueId: "104", runId: "run-fu", requestId: "rf2" }, cap, 500_000);
    if (!withFuture.admitted) throw new Error("expected admission alongside the future-dated reservation");
    expect(withFuture.reservedMicroUsd).toBe(2_000_000);
  });

  test("the reader's age predicate is applied to the format the WRITER actually writes", () => {
    // Every grace-window case above hand-INSERTs `decided_at`, so the reader's
    // `Date.parse` is only ever tried against test-authored bytes. If the real
    // insert switched to SQLite CURRENT_TIMESTAMP ("2026-08-22 12:00:00", no
    // offset ⇒ parsed as LOCAL time) or to an epoch integer, the window would
    // silently never expire, or expire instantly, and every test above would
    // still be green.
    ledger.admitIssue({ repoSlug: "qds/demo", issueId: "77", runId: "run-fmt", requestId: "rf" }, cap, 500_000);
    const db = rawDb();
    const { decidedAt } = db
      .prepare("SELECT decided_at AS decidedAt FROM gate_admissions WHERE run_id = ?")
      .get("run-fmt") as { decidedAt: string };
    db.close();
    // The reader's own predicate: Date.parse(...) against a `Date.now() - ADMISSION_GRACE_MS` cutoff.
    const parsed = Date.parse(decidedAt);
    expect(Number.isFinite(parsed)).toBe(true);
    expect(parsed).toBeGreaterThan(Date.now() - ADMISSION_GRACE_MS);
    expect(parsed).toBeLessThanOrEqual(Date.now());
    // …and it is byte-for-byte the encoding admitAged imitates, so the ages
    // those tests fabricate are the ages production actually produces.
    expect(decidedAt).toBe(new Date(parsed).toISOString());
  });
});

// ─── config ──────────────────────────────────────────────────────────────────

describe("DF2.8 cost config", () => {
  test("defaults: absent file → default cap 5,000,000 µ$ ($5.00), source default", () => {
    const loaded = loadCostConfig(join(dir, "none.json"));
    expect(loaded.config.defaultCapMicroUsd).toBe(5_000_000);
    expect(loaded.source).toBe("default");
    expect(DEFAULT_COST_CONFIG.defaultCapMicroUsd).toBe(5_000_000);
  });

  test("per-issue overrides keyed owner/repo#N apply; unknown issues keep the default", () => {
    const cfg = { defaultCapMicroUsd: 5_000_000, perIssueOverrides: { "qds/demo#42": 1_000_000 } };
    expect(capForIssue(cfg, "qds/demo", "42")).toBe(1_000_000);
    expect(capForIssue(cfg, "qds/demo", "43")).toBe(5_000_000);
  });

  test("an override key that is not owner/repo#N is rejected at load, never silently ignored", () => {
    const file = join(dir, "bad.json");
    writeFileSync(file, JSON.stringify({ defaultCapMicroUsd: 1, perIssueOverrides: { "no-slug#1": 2 } }));
    expect(() => loadCostConfig(file)).toThrow(CostConfigError);
  });

  test("non-positive or non-integer cap values are rejected", () => {
    const file = join(dir, "bad2.json");
    writeFileSync(file, JSON.stringify({ defaultCapMicroUsd: 0 }));
    expect(() => loadCostConfig(file)).toThrow(CostConfigError);
    const file2 = join(dir, "bad3.json");
    writeFileSync(file2, JSON.stringify({ boxHourRateMicroUsd: -5 }));
    expect(() => loadCostConfig(file2)).toThrow(CostConfigError);
  });

  test("a cap exceeding MAX_SAFE_INTEGER is rejected — unsafe integers store wrong in SQLite 64-bit", () => {
    const file = join(dir, "bad-overflow.json");
    writeFileSync(file, JSON.stringify({ defaultCapMicroUsd: Number.MAX_SAFE_INTEGER + 1 }));
    let code = "";
    try {
      loadCostConfig(file);
    } catch (e) {
      code = (e as CostConfigError).code;
    }
    expect(code).toBe("cost-config-invalid");
  });
});

// ─── P2/P3/P5: safe-integer guards (precision loss / overflow BLOCKERs) ──────────

describe("DF2.8 safe-integer guards (P2, P3, P5)", () => {
  test("box-hours cost overflow (P2 BLOCKER): huge rate × lifetime → box-hours-cost-invalid, zero rows", () => {
    const hugeRate = new CostLedger({
      path: ledgerPath,
      readRunRecord: (id) => RECORDS.get(id),
      config: { defaultCapMicroUsd: 5_000_000, boxHourRateMicroUsd: Number.MAX_SAFE_INTEGER },
    });
    // Lifetime ≥ 2h to overflow: 2 × MAX_SAFE_INTEGER exceeds MAX_SAFE_INTEGER.
    seedRecord("run-a1", { createdAt: "2026-08-20T12:00:00.000Z", closedAt: "2026-08-20T14:30:00.000Z" });
    let code = "";
    try {
      hugeRate.ingestBoxHours({ runId: "run-a1", repoSlug: "qds/demo", issueId: "42", requestId: "req-1" });
    } catch (e) {
      code = (e as CostLedgerError).code;
    }
    expect(code).toBe("box-hours-cost-invalid");
    const db = rawDb();
    expect(rowCount(db, "cost_events")).toBe(0);
    db.close();
    hugeRate.close();
  });

  test("costUsd that exceeds MAX_SAFE_INTEGER on µ$ conversion (P3) persists unpriced, never loses the event", () => {
    seedRecord("run-a1");
    const hugeCost = { costUsd: 1e15 }; // finite, non-negative, but × 1e6 overflows
    // AC4: an unconvertible figure is a malformed event, in the same class as a
    // negative or non-finite one — not a reason to drop the turn. The throw
    // escaped ingest and lost the row, so the issue read as having spent
    // NOTHING on it, and `unpricedTurns > 0` never fired either. Now the turn
    // is on the ledger at 0 µ$ / unpriced=1, which is what makes the gate see
    // an issue it cannot price.
    const res = ledger.ingestCostEvent(mkEvent(hugeCost), mkCtx());
    expect(res.inserted).toBe(true);
    expect(res.unpriced).toBe(true);
    const db = rawDb();
    expect(rowCount(db, "cost_events")).toBe(1);
    const row = db.prepare("SELECT cost_micro_usd, unpriced FROM cost_events").get() as {
      cost_micro_usd: number;
      unpriced: number;
    };
    expect(row.cost_micro_usd).toBe(0);
    expect(row.unpriced).toBe(1);
    db.close();
  });

  test("cap exceeding MAX_SAFE_INTEGER via config file (P5) → cost-config-invalid", () => {
    const file = join(dir, "cap-overflow.json");
    writeFileSync(file, JSON.stringify({ defaultCapMicroUsd: Number.MAX_SAFE_INTEGER * 2 }));
    let code = "";
    try {
      loadCostConfig(file);
    } catch (e) {
      code = (e as CostConfigError).code;
    }
    expect(code).toBe("cost-config-invalid");
  });

  test("costUsd at MAX_SAFE/1e6 boundary persists unpriced; just under it prices normally", () => {
    seedRecord("run-a1");
    // MAX_SAFE_INTEGER / 1e6 ≈ 9,007,199,254.740992 USD, which × 1e6 lands
    // exactly ON MAX_SAFE_INTEGER's float neighbourhood and does not round to a
    // safe integer — so usdToMicros still refuses it.
    const boundaryCost = Number.MAX_SAFE_INTEGER / 1_000_000;
    // Refusing to CONVERT it no longer means refusing to RECORD it: the row
    // lands unpriced rather than the event being lost (see the P3 test above).
    const boundary = ledger.ingestCostEvent(mkEvent({ costUsd: boundaryCost }), mkCtx());
    expect(boundary.inserted).toBe(true);
    expect(boundary.unpriced).toBe(true);
    // Slightly under boundary should succeed
    const res = ledger.ingestCostEvent(mkEvent({ costUsd: boundaryCost - 0.001 }), mkCtx({ requestId: "r2" }));
    expect(res.unpriced).toBe(false);
  });

  test("overflow-sum admission: many reservations overflow → ledger-overflow", () => {
    seedRecord("run-a1");
    seedRecord("run-a2");
    seedRecord("run-a3");
    // Use a cap much larger than MAX_SAFE_INTEGER so overflow check hits before cap check
    const cap = Number.MAX_SAFE_INTEGER * 10;
    // Each ceiling 5e15 µ$ — two prior reservations alone sum past MAX_SAFE_INTEGER
    const largeCeiling = 5_000_000_000_000_000;
    ledger.admitIssue({ repoSlug: "qds/demo", issueId: "42", runId: "run-a1", requestId: "r1" }, cap, largeCeiling);
    ledger.admitIssue({ repoSlug: "qds/demo", issueId: "42", runId: "run-a2", requestId: "r2" }, cap, largeCeiling);
    // Third admission sees the two prior 5e15 reservations sum past MAX_SAFE_INTEGER (1e16 > 9.007e15)
    const error = (() => {
      try {
        ledger.admitIssue({ repoSlug: "qds/demo", issueId: "42", runId: "run-a3", requestId: "r3" }, cap, largeCeiling);
        return new Error("expected ledger-overflow");
      } catch (e) {
        return e;
      }
    })();
    const err = error as CostLedgerError;
    expect(err.code).toBe("ledger-overflow");
    expect(err.message).toContain("exceeds safe integer range");
  });

  test("committed > cap refusal: cap lowered after spend → over-budget", () => {
    seedRecord("run-a1");
    // Spend 4M of original 5M cap
    ledger.ingestCostEvent(mkEvent({ costUsd: 4.0 }), mkCtx());
    // Lower cap to 3M (below existing spend)
    const d = ledger.admitIssue({ repoSlug: "qds/demo", issueId: "42", runId: "run-a2", requestId: "r2" }, 3_000_000, 100_000);
    if (d.admitted) throw new Error("expected refusal when committed > cap");
    expect(d.status).toBe("over-budget");
    expect(d.reason).toBe("spend-cap-exceeded");
    expect(d.spentMicroUsd).toBe(4_000_000);
    expect(d.capMicroUsd).toBe(3_000_000);
  });

  test("config negative-value rejection: negative cap → cost-config-invalid", () => {
    const file = join(dir, "negative-cap.json");
    writeFileSync(file, JSON.stringify({ defaultCapMicroUsd: -1000 }));
    try {
      loadCostConfig(file);
      throw new Error("expected cost-config-invalid");
    } catch (e) {
      expect((e as CostConfigError).code).toBe("cost-config-invalid");
    }
  });

  test("box-hours createdAt > 0 validation: pre-1970 timestamp rejected", () => {
    seedRecord("run-a1", { createdAt: "1969-12-31T23:59:59.000Z", closedAt: "1970-01-01T00:00:01.000Z" });
    try {
      ledger.ingestBoxHours({ runId: "run-a1", repoSlug: "qds/demo", issueId: "42", requestId: "r1" });
      throw new Error("expected box-hours-lifetime-invalid");
    } catch (e) {
      expect((e as CostLedgerError).code).toBe("box-hours-lifetime-invalid");
    }
  });
});

// ─── canonical repo identity ─────────────────────────────────────────────────

/**
 * `repo_slug` is a byte-exact SQL predicate on every spend aggregate and cap
 * check. Without a canonical form, `Owner/Repo` and `owner/repo` are two budget
 * identities for one repository — dispatch under each and the per-issue cap is
 * served twice. These pin that the identity is the repository, not the casing.
 *
 * The rows are NOT migrated: `cost_events` and `gate_admissions` are append-only
 * (INV-COST-1, enforced by triggers). The predicates canonicalise instead, which
 * is why the "written before canonicalisation" case below is the load-bearing
 * one — it is the half a migration would have covered.
 */
describe("canonical repo identity (cap bypass)", () => {
  test("spend billed in one casing counts against the cap read in another", () => {
    seedRecord("run-a1");
    ledger.ingestCostEvent(mkEvent({ costUsd: 4.0 }), mkCtx({ repoSlug: "QDS/Demo" }));

    // Same repository, every casing, one balance.
    for (const slug of ["qds/demo", "QDS/Demo", "Qds/DEMO"]) {
      expect(ledger.readIssueCost(slug, "42").totalMicroUsd).toBe(4_000_000);
    }

    // And the gate reads that same balance regardless of how the brief spelled it.
    seedRecord("run-a2");
    const d = ledger.admitIssue(
      { repoSlug: "QDS/Demo", issueId: "42", runId: "run-a2", requestId: "req-2" },
      5_000_000,
      50_000_000,
    );
    expect(d.spentMicroUsd).toBe(4_000_000);
    if (!d.admitted) throw new Error(`expected admission, got ${d.reason}`);
    expect(d.admittedCeilingMicroUsd).toBe(1_000_000);
  });

  test("a row written BEFORE canonicalisation still counts — the append-only tables are never rewritten", () => {
    // Written straight to the table, as a pre-canonicalisation build would have.
    // INSERT is the only mutation the triggers permit, which is exactly why the
    // read side has to do the folding.
    const raw = rawDb();
    raw.prepare(
      `INSERT INTO cost_events (event_id, run_id, repo_slug, issue_id, request_id, role,
                                agent_id, kind, invocation_seq, cost_micro_usd, unpriced, created_at)
       VALUES ('legacy-1', 'run-legacy', 'QDS/Demo', '42', 'req-legacy', 'lead',
               'lead-1', 'tokens', 0, 2500000, 0, '2026-08-20T12:00:00.000Z')`,
    ).run();
    raw.close();

    expect(ledger.readIssueCost("qds/demo", "42").totalMicroUsd).toBe(2_500_000);

    seedRecord("run-new");
    const d = ledger.admitIssue(
      { repoSlug: "qds/demo", issueId: "42", runId: "run-new", requestId: "req-new" },
      5_000_000,
      50_000_000,
    );
    expect(d.spentMicroUsd).toBe(2_500_000);
  });

  test("admitIssue writes its reservation under the canonical slug, so a later admission in any casing sees it", () => {
    seedRecord("run-r1");
    ledger.admitIssue(
      { repoSlug: "QDS/Demo", issueId: "42", runId: "run-r1", requestId: "req-r1" },
      5_000_000,
      2_000_000,
    );
    seedRecord("run-r2");
    const second = ledger.admitIssue(
      { repoSlug: "qds/demo", issueId: "42", runId: "run-r2", requestId: "req-r2" },
      5_000_000,
      50_000_000,
    );
    expect(second.reservedMicroUsd).toBe(2_000_000);
    if (!second.admitted) throw new Error(`expected admission, got ${second.reason}`);
    expect(second.admittedCeilingMicroUsd).toBe(3_000_000);
  });

  test("a gate_admissions row written BEFORE canonicalisation still reserves against a canonical admission", () => {
    // The reservation half of the legacy case. admitIssue now WRITES canonical,
    // so this row can only come from a build that predates that — which is
    // exactly what the lower() on the reserved-rows predicate is for, and the
    // only thing that distinguishes it from a plain equality.
    const raw = rawDb();
    raw.prepare(
      `INSERT INTO gate_admissions (request_id, run_id, repo_slug, issue_id, ceiling_micro_usd, decided_at)
       VALUES ('req-legacy', 'run-legacy', 'QDS/Demo', '42', 2000000, ?)`,
    ).run(new Date().toISOString());
    raw.close();

    seedRecord("run-next");
    const d = ledger.admitIssue(
      { repoSlug: "qds/demo", issueId: "42", runId: "run-next", requestId: "req-next" },
      5_000_000,
      50_000_000,
    );
    expect(d.reservedMicroUsd).toBe(2_000_000);
    if (!d.admitted) throw new Error(`expected admission, got ${d.reason}`);
    expect(d.admittedCeilingMicroUsd).toBe(3_000_000);
  });

  test("the ledger persists the canonical slug, so teardown re-reading an old record cannot fork identity", () => {
    seedRecord("run-t1", {
      createdAt: "2026-08-20T12:00:00.000Z",
      closedAt: "2026-08-20T13:30:00.000Z",
    });
    // The slug teardown reads back off a run record written before canonicalisation.
    ledger.ingestBoxHours({
      runId: "run-t1",
      repoSlug: "QDS/Demo",
      issueId: "42",
      requestId: "req-t1",
    });
    const raw = rawDb();
    const stored = raw
      .prepare("SELECT DISTINCT repo_slug AS s FROM cost_events WHERE run_id = 'run-t1'")
      .all() as { s: string }[];
    raw.close();
    expect(stored.map((r) => r.s)).toEqual(["qds/demo"]);
  });

  test("INV-COST-1 still holds — neither table can be updated or deleted", () => {
    seedRecord("run-a1");
    ledger.ingestCostEvent(mkEvent(), mkCtx());
    // Both tables need a row: a BEFORE UPDATE/DELETE trigger that matches
    // nothing never fires, so an empty table would pass this vacuously.
    seedRecord("run-adm");
    ledger.admitIssue(
      { repoSlug: "qds/demo", issueId: "42", runId: "run-adm", requestId: "req-adm" },
      5_000_000,
      50_000_000,
    );
    const raw = rawDb();
    try {
      expect(() => raw.prepare("UPDATE cost_events SET repo_slug = 'x/y'").run()).toThrow(/append-only/);
      expect(() => raw.prepare("DELETE FROM cost_events").run()).toThrow(/append-only/);
      expect(() => raw.prepare("UPDATE gate_admissions SET repo_slug = 'x/y'").run()).toThrow(/append-only/);
      expect(() => raw.prepare("DELETE FROM gate_admissions").run()).toThrow(/append-only/);
    } finally {
      raw.close();
    }
  });

  test("capForIssue matches an override across casing on either side", () => {
    const config = {
      ...DEFAULT_COST_CONFIG,
      perIssueOverrides: { "BiosparkHealth/QDS-Factory#42": 9_000_000 },
    };
    // The operator authored the key in one casing; the brief spells it another.
    expect(capForIssue(config, "biosparkhealth/qds-factory", "42")).toBe(9_000_000);
    expect(capForIssue(config, "BiosparkHealth/QDS-Factory", "42")).toBe(9_000_000);
    // Still scoped to the issue, and still falls back when nothing matches.
    expect(capForIssue(config, "biosparkhealth/qds-factory", "43")).toBe(
      DEFAULT_COST_CONFIG.defaultCapMicroUsd,
    );
    expect(capForIssue(config, "other/repo", "42")).toBe(DEFAULT_COST_CONFIG.defaultCapMicroUsd);
  });
});

// ─── canonical issue identity ────────────────────────────────────────────────

/**
 * The OTHER half of the (repoSlug, issueId) budget key, and the same cap-bypass
 * class the slug half closed above. `issue_id` is a byte-exact SQL predicate
 * everywhere, so `42`, `#42`, `042` and `42 ` were four budget identities for
 * one issue — each holding a full untouched cap — and an override an operator
 * wrote as `owner/repo#042` matched the `"42"` a dispatch supplies in nothing,
 * so the cap silently reverted to the default. Both directions cost money.
 */
describe("canonical issue identity (cap bypass)", () => {
  /** Every spelling a human, a hand-edited record or a brief actually produces. */
  const SPELLINGS = ["42", "#42", "042", "42 "];

  test("every spelling of one issue reads ONE balance, not four empty ones", () => {
    seedRecord("run-i1");
    // Billed under the most-decorated spelling; read under all of them.
    ledger.ingestCostEvent(mkEvent({ costUsd: 1.0 }), mkCtx({ runId: "run-i1", issueId: "#042" }));
    for (const issueId of SPELLINGS) {
      expect(ledger.readIssueCost("qds/demo", issueId).totalMicroUsd).toBe(1_000_000);
    }
    // Still scoped: a genuinely different issue is not folded in with it.
    expect(ledger.readIssueCost("qds/demo", "43").hasEvents).toBe(false);
    // …and the row itself carries the canonical spelling, so the per-run
    // breakdown and the gate key on the same string the events were written on.
    expect(ledger.readIssueRuns("qds/demo", "0042").map((r) => r.runId)).toEqual(["run-i1"]);
  });

  test("four spellings of one issue share ONE cap — each does not get its own", () => {
    // THE bypass, end to end. cap 5 µ$, keyCap 2 µ$: folded, the four
    // admissions draw 2 + 2 + 1 from a single 5 and the fourth is refused.
    // Unfolded, each spelling opened a fresh identity holding the whole cap and
    // all four were admitted at 2 — 8 µ$ authorized against a 5 µ$ budget.
    const cap = 5;
    const seen: { reserved: number; ceiling: number | null }[] = [];
    for (const [i, issueId] of SPELLINGS.entries()) {
      const runId = `run-fold-${i}`;
      seedRecord(runId);
      const d = ledger.admitIssue({ repoSlug: "qds/demo", issueId, runId, requestId: `req-fold-${i}` }, cap, 2);
      seen.push({
        reserved: d.reservedMicroUsd,
        ceiling: d.admitted ? d.admittedCeilingMicroUsd : null,
      });
    }
    expect(seen).toEqual([
      { reserved: 0, ceiling: 2 },
      { reserved: 2, ceiling: 2 },
      { reserved: 4, ceiling: 1 }, // clamped by the headroom, not by the key cap
      { reserved: 5, ceiling: null }, // committed >= cap ⇒ refused
    ]);
  });

  test("a cost_events row written BEFORE canonicalisation still counts — the predicate folds the COLUMN too", () => {
    // The load-bearing half, and the one the slug side already had twice. Every
    // test above writes through `ingestCostEvent`, which canonicalises the BIND
    // — so they prove the two sides agree, never that a row already ON DISK is
    // reachable. `cost_events` is append-only (INV-COST-1), so a canonicalising
    // migration is impossible by construction: a stored `#42` / ` 042 ` / `42 `
    // was permanently unmatchable, its spend vanished from every SUM the cap
    // reads, and a silent UNDER-count is a cap bypass.
    const raw = rawDb();
    try {
      for (const [i, stored] of ["#42", " 042 ", "42 "].entries()) {
        raw.prepare(
          `INSERT INTO cost_events (event_id, run_id, repo_slug, issue_id, request_id, role,
                                    agent_id, kind, invocation_seq, cost_micro_usd, unpriced, created_at)
           VALUES (?, ?, 'qds/demo', ?, 'req-legacy', 'lead', 'lead-1', 'tokens', 0, 1000000, 0, '2026-08-20T12:00:00.000Z')`,
        ).run(`legacy-${i}`, `run-legacy-${i}`, stored);
      }
      // A DIFFERENT issue whose id merely starts with the same digits. Folding
      // through `Number` or a prefix match would swallow it into #42's balance
      // and let #42 spend #420's budget.
      raw.prepare(
        `INSERT INTO cost_events (event_id, run_id, repo_slug, issue_id, request_id, role,
                                  agent_id, kind, invocation_seq, cost_micro_usd, unpriced, created_at)
         VALUES ('legacy-420', 'run-legacy-420', 'qds/demo', '420', 'req-legacy', 'lead',
                 'lead-1', 'tokens', 0, 7000000, 0, '2026-08-20T12:00:00.000Z')`,
      ).run();
    } finally {
      raw.close();
    }

    // All three legacy spellings reachable from every spelling of the read.
    for (const issueId of SPELLINGS) {
      expect(ledger.readIssueCost("qds/demo", issueId).totalMicroUsd).toBe(3_000_000);
    }
    expect(ledger.readIssueCost("qds/demo", "420").totalMicroUsd).toBe(7_000_000);

    // And the gate reads that same recovered spend, so the cap sees it too.
    seedRecord("run-new");
    const d = ledger.admitIssue(
      { repoSlug: "qds/demo", issueId: "42", runId: "run-new", requestId: "req-new" },
      5_000_000,
      50_000_000,
    );
    expect(d.spentMicroUsd).toBe(3_000_000);
  });

  test("a gate_admissions row written BEFORE canonicalisation still reserves against a canonical admission", () => {
    // The reservation half of the same legacy case: an outstanding reservation
    // the fold cannot reach is exposure the next dispatch is never charged for,
    // so it is handed headroom a live key is already holding.
    const raw = rawDb();
    try {
      raw.prepare(
        `INSERT INTO gate_admissions (request_id, run_id, repo_slug, issue_id, ceiling_micro_usd, decided_at)
         VALUES ('req-legacy', 'run-legacy', 'qds/demo', '#042', 2000000, ?)`,
      ).run(new Date().toISOString());
      // Same guard as above on the reservation side — #420 is not #42.
      raw.prepare(
        `INSERT INTO gate_admissions (request_id, run_id, repo_slug, issue_id, ceiling_micro_usd, decided_at)
         VALUES ('req-legacy-420', 'run-legacy-420', 'qds/demo', '420', 4000000, ?)`,
      ).run(new Date().toISOString());
    } finally {
      raw.close();
    }
    seedRecord("run-legacy");
    seedRecord("run-next");
    const d = ledger.admitIssue(
      { repoSlug: "qds/demo", issueId: "42", runId: "run-next", requestId: "req-next" },
      5_000_000,
      50_000_000,
    );
    expect(d.reservedMicroUsd).toBe(2_000_000); // the legacy row only — never #420's 4M
    if (!d.admitted) throw new Error(`expected admission, got ${d.reason}`);
    expect(d.admittedCeilingMicroUsd).toBe(3_000_000);
  });

  test.each(["#", " ", "#  ", " # "])(
    "issueId %p is REFUSED — it canonicalises to an identity no override can name",
    (issueId) => {
      // Validation moved onto the CANONICAL values. A raw non-empty check ran
      // BEFORE the fold, so all four passed it, all four then bound
      // `issue_id = ''`, and they shared ONE budget identity. ISSUE_KEY_RE
      // requires `#\d+`, so no `perIssueOverrides` key can ever name that
      // identity — the shared bucket always got `defaultCapMicroUsd`, one
      // default cap covering an unbounded set of malformed dispatches.
      seedRecord("run-empty");
      for (const call of [
        () => ledger.admitIssue({ repoSlug: "qds/demo", issueId, runId: "run-empty", requestId: "req-empty" }, 5_000_000, 50_000_000),
        () => ledger.ingestCostEvent(mkEvent(), mkCtx({ runId: "run-empty", issueId })),
        () => ledger.ingestBoxHours({ runId: "run-empty", repoSlug: "qds/demo", issueId, requestId: "req-empty" }),
      ]) {
        let err: CostLedgerError | undefined;
        try {
          call();
        } catch (e) {
          err = e as CostLedgerError;
        }
        expect(err).toBeInstanceOf(CostLedgerError);
        expect(err?.message).toContain("canonicalises to an empty identity");
      }
      // Nothing on either table on the way out: a refusal that still wrote the
      // row would leave the shared bucket in place regardless.
      const db = rawDb();
      expect(rowCount(db, "gate_admissions")).toBe(0);
      expect(rowCount(db, "cost_events")).toBe(0);
      db.close();
    },
  );

  test("capForIssue matches an override written with a `#`-decorated or zero-padded id", () => {
    const config = { ...DEFAULT_COST_CONFIG, perIssueOverrides: { "qds/demo#042": 9_000_000 } };
    // The operator padded the key; the brief supplies the bare id (and vice versa).
    for (const issueId of SPELLINGS) expect(capForIssue(config, "qds/demo", issueId)).toBe(9_000_000);
    expect(capForIssue({ ...DEFAULT_COST_CONFIG, perIssueOverrides: { "qds/demo#42": 9_000_000 } }, "qds/demo", "042")).toBe(9_000_000);
    // Not a numeric-prefix match: 420 is a different issue, and `Number` folding
    // would also have to be watched for ids past 2^53.
    expect(capForIssue(config, "qds/demo", "420")).toBe(DEFAULT_COST_CONFIG.defaultCapMicroUsd);
  });

  test("two override keys naming ONE issue are REFUSED at load, never silently resolved", () => {
    // `capForIssue` returns the first match, so this quietly served 20 USD and
    // ignored the very line the operator added to lower the cap. Picking the
    // lower one would be just as wrong — it would ignore a line added to RAISE
    // it. In a money table the honest answer is to refuse and let them say.
    const file = join(dir, "dup-override.json");
    writeFileSync(
      file,
      JSON.stringify({
        defaultCapMicroUsd: 5_000_000,
        perIssueOverrides: { "QDS/Demo#42": 20_000_000, "qds/demo#042": 1_000_000 },
      }),
    );
    let err: CostConfigError | undefined;
    try {
      loadCostConfig(file);
    } catch (e) {
      err = e as CostConfigError;
    }
    expect(err?.code).toBe("cost-config-invalid");
    // BOTH keys named, or the operator cannot tell which two lines collided.
    expect(err?.message).toContain("QDS/Demo#42");
    expect(err?.message).toContain("qds/demo#042");
    // Two keys naming two DIFFERENT issues remain perfectly legal.
    const ok = join(dir, "two-overrides.json");
    writeFileSync(ok, JSON.stringify({ perIssueOverrides: { "qds/demo#42": 1, "qds/demo#43": 2 } }));
    expect(loadCostConfig(ok).config.perIssueOverrides).toEqual({ "qds/demo#42": 1, "qds/demo#43": 2 });
  });

  test("an ambiguity that reaches capForIssue anyway resolves to the LOWEST cap, not the first key", () => {
    // The refusal above lives on the PARSE arm only. A `CostConfig` assembled in
    // code — a test, a caller merging overrides, a default never read from a
    // file — can still hold two keys naming one issue, with nobody left to ask.
    // Returning the first match served 20 USD and ignored the very line added to
    // LOWER the cap, and object iteration order is not a contract anyone
    // authored. `Math.min` is the direction that cannot overspend: at worst it
    // ignores a line meant to RAISE a cap, which refuses a dispatch —
    // recoverable — where the other mistake spends money that is not.
    const ambiguous = {
      ...DEFAULT_COST_CONFIG,
      perIssueOverrides: { "Owner/Repo#42": 20_000_000, "owner/repo#42": 1_000_000 },
    };
    expect(capForIssue(ambiguous, "owner/repo", "42")).toBe(1_000_000);
    // Not an artefact of insertion order: reversed, the answer is the same.
    const reversed = {
      ...DEFAULT_COST_CONFIG,
      perIssueOverrides: { "owner/repo#42": 1_000_000, "Owner/Repo#42": 20_000_000 },
    };
    expect(capForIssue(reversed, "OWNER/REPO", "#042")).toBe(1_000_000);
    // A key naming a DIFFERENT issue is not dragged into the min.
    const mixed = {
      ...DEFAULT_COST_CONFIG,
      perIssueOverrides: { "Owner/Repo#42": 20_000_000, "owner/repo#43": 1 },
    };
    expect(capForIssue(mixed, "owner/repo", "42")).toBe(20_000_000);
  });
});

// ─── admission input / SQL binds ─────────────────────────────────────────────

describe("admitIssue correlation binds (NULL safety)", () => {
  const cap = 5_000_000;

  test("a missing or non-string correlation key is refused before any query runs", () => {
    seedRecord("run-a1");
    const base = { repoSlug: "qds/demo", issueId: "42", runId: "run-a1", requestId: "req-1" };
    for (const field of ["repoSlug", "issueId", "runId", "requestId"] as const) {
      // Each of the three shapes that binds as NULL or as nothing at all.
      for (const bad of [null, undefined, ""]) {
        const input = { ...base, [field]: bad } as unknown as Parameters<typeof ledger.admitIssue>[0];
        let err: CostLedgerError | undefined;
        try {
          ledger.admitIssue(input, cap, 50_000_000);
        } catch (e) {
          err = e as CostLedgerError;
        }
        expect(err?.code).toBe("admission-input-invalid");
        expect(err?.message).toContain(field);
      }
    }
    // Nothing was written on the way to any of those refusals.
    const db = rawDb();
    expect(rowCount(db, "gate_admissions")).toBe(0);
    db.close();
  });

  test("the reservation predicate is NULL-safe in the SQL itself, not only via the guard above", () => {
    // Why this is a source assertion rather than a call: `request_id`/`run_id`
    // are `TEXT NOT NULL`, so the NULL can only ever arrive from the BIND side —
    // and the guard above refuses exactly that, so there is no runtime path left
    // to reach the predicate with one. What is still reachable is a FUTURE
    // caller added after the guard is moved or relaxed, and with plain `=`
    // SQLite's three-valued logic makes `NOT (a.request_id = NULL AND …)`
    // evaluate to NULL for every row: the WHERE drops all of them, every
    // outstanding reservation vanishes, and the admission is handed the whole
    // remaining cap on top of every live one. `IS` is what makes the query safe
    // on its own, so `IS` is what is pinned.
    const source = readFileSync(new URL("../../src/providers/cost-ledger.ts", import.meta.url), "utf8");
    const predicate = /NOT \(a\.request_id (\S+) \? AND a\.run_id (\S+) \?\)/.exec(source);
    expect(predicate).not.toBeNull();
    expect([predicate?.[1], predicate?.[2]]).toEqual(["IS", "IS"]);
  });
});

// ─── replay clamp ────────────────────────────────────────────────────────────

describe("admitIssue replay clamp", () => {
  test("a replay is clamped to the headroom recomputed NOW, upholding ceiling <= remaining", () => {
    // The exact scenario: cap 100 µ$, keyCap 10 µ$.
    const cap = 100;
    const keyCap = 10;
    seedRecord("run-a");
    seedRecord("run-b");
    const a = ledger.admitIssue({ repoSlug: "qds/demo", issueId: "42", runId: "run-a", requestId: "req-a" }, cap, keyCap);
    if (!a.admitted) throw new Error(`expected A admitted, got ${a.reason}`);
    expect(a.admittedCeilingMicroUsd).toBe(10);

    const b = ledger.admitIssue({ repoSlug: "qds/demo", issueId: "42", runId: "run-b", requestId: "req-b" }, cap, keyCap);
    expect(b.admitted).toBe(true);
    // B then reports 95 µ$ of PRICED spend — which also retires B's own
    // reservation, so the headroom A's replay recomputes is 100 - 95 = 5.
    ledger.ingestCostEvent(mkEvent({ costUsd: 0.000095 }), mkCtx({ runId: "run-b", requestId: "req-b" }));

    const replay = ledger.admitIssue({ repoSlug: "qds/demo", issueId: "42", runId: "run-a", requestId: "req-a" }, cap, keyCap);
    if (!replay.admitted) throw new Error(`expected the replay admitted, got ${replay.reason}`);
    expect(replay.remainingMicroUsd).toBe(5);
    // 5, not the 10 on the row: handing back the recorded figure raw broke the
    // `admittedCeilingMicroUsd <= remainingMicroUsd` invariant and gave the mint
    // a ceiling twice the headroom left. A replay may only ever be authorized
    // for LESS than its original.
    expect(replay.admittedCeilingMicroUsd).toBe(5);
    expect(replay.admittedCeilingMicroUsd).toBeLessThanOrEqual(replay.remainingMicroUsd);

    // The ROW is untouched (INV-COST-1): the cap is still holding the original
    // 10, so the clamp narrows what is minted, never what is reserved.
    const db = rawDb();
    const row = db
      .prepare("SELECT ceiling_micro_usd AS c FROM gate_admissions WHERE request_id = 'req-a' AND run_id = 'run-a'")
      .get() as { c: number };
    expect(row.c).toBe(10);
    expect(rowCount(db, "gate_admissions")).toBe(2); // no second reservation for A
    db.close();
  });
});

// ─── orphan guard: an UNREADABLE record ──────────────────────────────────────

describe("admitIssue orphan guard (unreadable record)", () => {
  const cap = 5_000_000;
  const expiryMs = ADMISSION_GRACE_MS + ADMISSION_SKEW_MARGIN_MS;

  /** A ledger whose record reader throws for exactly one run id. */
  function ledgerThatThrowsFor(runId: string): CostLedger {
    return new CostLedger({
      path: ledgerPath,
      readRunRecord: (id) => {
        if (id === runId) throw new Error("record is 0 bytes");
        return RECORDS.get(id);
      },
      config: { defaultCapMicroUsd: 5_000_000, boxHourRateMicroUsd: 3_600_000 },
    });
  }

  test("PAST the grace window an unreadable record EXPIRES the reservation, naming it on the log line", () => {
    // `undefined` and "cannot be read at all" are the same fact — this run will
    // never report spend — but only the second one used to wedge the issue
    // FOREVER: an ungrammatical run_id in gate_admissions, a corrupt record or a
    // 0-byte one caught mid-create made readRunRecord throw, that throw refused
    // every future dispatch for the issue, and `gate_admissions_no_delete`
    // blocked the manual remedy. A permanent refusal is not fail-safe; it is a
    // wedge with no exit.
    const throwing = ledgerThatThrowsFor("run-corrupt");
    try {
      admitAged("run-corrupt", "rc", 4_000_000, expiryMs * 2, "201");
      const lines: Record<string, unknown>[] = [];
      const restore = setLogSink((e) => lines.push(e as unknown as Record<string, unknown>));
      let d: ReturnType<CostLedger["admitIssue"]>;
      try {
        d = throwing.admitIssue({ repoSlug: "qds/demo", issueId: "201", runId: "run-next", requestId: "rn" }, cap, 500_000);
      } finally {
        restore();
      }
      if (!d.admitted) throw new Error(`expected the wedge to clear, got ${d.reason}`);
      expect(d.reservedMicroUsd).toBe(0); // expired, not counted
      // Never silent — an operator has to be able to tell an expiry from a
      // reservation that simply retired, and needs the run id to go look.
      const line = lines.find((l) => l.code === "reservation-unresolvable-expired");
      expect(line).toBeDefined();
      expect(line?.orphanRunId).toBe("run-corrupt");
      expect(line?.orphanCeilingMicroUsd).toBe(4_000_000);
    } finally {
      throwing.close();
    }
  });

  test("a YOUNG unreadable record still refuses the dispatch — fail-closed, unchanged", () => {
    // Below the cutoff the throw propagates: a young unreadable record is far
    // more likely a real in-flight dispatch than an orphan, and refusing once is
    // recoverable where over-granting the cap is not.
    const throwing = ledgerThatThrowsFor("run-fresh");
    try {
      admitAged("run-fresh", "rf", 4_000_000, expiryMs / 2, "202");
      expect(() =>
        throwing.admitIssue({ repoSlug: "qds/demo", issueId: "202", runId: "run-next2", requestId: "rn2" }, cap, 500_000),
      ).toThrow(/record is 0 bytes/);
      // And nothing was reserved on the way out.
      const db = rawDb();
      expect(rowCount(db, "gate_admissions")).toBe(1);
      db.close();
    } finally {
      throwing.close();
    }
  });
});

// ─── key cap validation ──────────────────────────────────────────────────────

describe("admitIssue keyCapMicroUsd validation", () => {
  test("a non-positive, non-integer or NaN key cap is refused, like the issue cap", () => {
    // It is the OTHER operand of the `Math.min` that becomes the minted ceiling
    // and it lands in a STRICT INTEGER column: `-1` returned `admitted: true`
    // with a NEGATIVE ceiling handed to the mint, and a float or NaN failed at
    // the INSERT with a bare SQLITE_CONSTRAINT naming nothing.
    seedRecord("run-a1");
    for (const keyCap of [-1, Number.NaN, 1.5, 0]) {
      let err: CostConfigError | undefined;
      try {
        ledger.admitIssue({ repoSlug: "qds/demo", issueId: "42", runId: "run-a1", requestId: "req-1" }, 5_000_000, keyCap);
      } catch (e) {
        err = e as CostConfigError;
      }
      expect(err?.code).toBe("cost-config-invalid");
      expect(err?.message).toContain("keyCapMicroUsd");
    }
    // Refused BEFORE the reservation is written, every time.
    const db = rawDb();
    expect(rowCount(db, "gate_admissions")).toBe(0);
    db.close();
  });
});
