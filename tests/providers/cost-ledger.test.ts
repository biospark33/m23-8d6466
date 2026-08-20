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
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";

import type { CostEvent } from "../../cli-anything/src/types.ts";
import {
  CostConfigError,
  CostLedger,
  CostLedgerError,
  DEFAULT_COST_CONFIG,
  capForIssue,
  loadCostConfig,
  type RunCostRecord,
} from "../../src/providers/cost-ledger.ts";

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

  test("the ledger file is 0600", () => {
    expect(statSync(ledgerPath).mode & 0o777).toBe(0o600);
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

  test("the reservation retires once the run's first ledger row lands", () => {
    seedRecord("run-a1");
    ledger.admitIssue({ repoSlug: "qds/demo", issueId: "42", runId: "run-a1", requestId: "req-1" }, cap, 50_000_000);
    ledger.ingestCostEvent(mkEvent({ costUsd: 0.01 }), mkCtx()); // run-a1 now has rows
    const next = ledger.admitIssue({ repoSlug: "qds/demo", issueId: "42", runId: "run-a2", requestId: "req-2" }, cap, 50_000_000);
    if (!next.admitted) throw new Error("expected admission after retirement");
    expect(next.reservedMicroUsd).toBe(0);
    expect(next.spentMicroUsd).toBe(10_000);
    expect(next.admittedCeilingMicroUsd).toBe(4_990_000);
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
    const orphan = ledger.admitIssue({ repoSlug: "qds/demo", issueId: "42", runId: "run-orphan", requestId: "r1" }, cap, 50_000_000);
    expect(orphan.admitted).toBe(true);
    // A later dispatch for a real run is not refused by the orphan's reservation.
    const after = ledger.admitIssue({ repoSlug: "qds/demo", issueId: "42", runId: "run-real", requestId: "r2" }, cap, 50_000_000);
    if (!after.admitted) throw new Error("expected admission past the expired orphan reservation");
    expect(after.reservedMicroUsd).toBe(0);
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

  test("costUsd that exceeds MAX_SAFE_INTEGER on µ$ conversion (P3) → cost-convert-invalid", () => {
    seedRecord("run-a1");
    const hugeCost = { costUsd: 1e15 }; // finite, non-negative, but × 1e6 overflows
    let code = "";
    try {
      ledger.ingestCostEvent(mkEvent(hugeCost), mkCtx());
    } catch (e) {
      code = (e as CostLedgerError).code;
    }
    expect(code).toBe("cost-convert-invalid");
    const db = rawDb();
    expect(rowCount(db, "cost_events")).toBe(0);
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
});
