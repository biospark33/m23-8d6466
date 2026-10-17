/**
 * DF2.8 — the micro-dollar cost ledger.
 *
 * AC1  one row per emitted event, deterministic event_id PK, idempotent replay,
 *      second invocation of one agent is a second row
 * AC4  malformed events persist unpriced=1 / cost 0, never dropped
 * AC5  zero-row issue reads as a zero view (hasEvents:false), never an error
 * AC6  box-hours: exactly one row per torn-down run, at close only
 * INV-COST-1 append-only enforced by store triggers
 * INV-COST-2 no denormalized cost column anywhere — DERIVATION, not
 *            COMPLETENESS: the DF2.12 bridge now calls ingestCostEvent in
 *            production, but a run's SUM is complete only once its token rows
 *            landed (tokens-not-harvested otherwise) — read totals accordingly
 * INV-COST-4 integer micro-dollars everywhere; float exists only on the wire
 * INV-COST-5 key_hash + key_limit on every token row, fail-closed when absent
 * INV-COST-6 unopenable ledger / unpersistable ingest refuse, never read as zero
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
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
import { setLogSink } from "../../src/lib/log.ts";

// ─── fixtures ────────────────────────────────────────────────────────────────

let dir: string;
let prevCwd: string;
let prevConfigEnv: string | undefined;
let ledgerPath: string;
let ledger: CostLedger;

/**
 * Permission-shaped refusals cannot be provoked under root (root reads
 * mode-0000 files), so those tests are SKIPPED there — via `test.skipIf`, not
 * an in-body `return`: bun records a returned body as PASSED, which under
 * root would report the whole refusal block as green while proving nothing.
 * A skip is visible; a vacuous pass is not.
 */
const IS_ROOT = (process.getuid?.() ?? -1) === 0;

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
    // T2-14 (round 11), documented gap: append-side PARALLEL writers (an agent
    // retry racing teardown's box-hours ingest on one event_id) are only ever
    // exercised SEQUENTIALLY here. Real interleave coverage would need two
    // connections racing ON CONFLICT — SQLite serialises writes anyway, so a
    // regression the sequential form cannot see is bounded to classification
    // (K8's ledger-busy taxonomy, pinned via admitIssue's probe) rather than
    // lost money. Disproportionate fixture; noted rather than silently absent.
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

  // ── S1 rig_swarm: a swarm record has NO core keyHash — its per-seat keys
  // ride extensions.swarmSeats (seats/keyHashes/limitMicroUsd, index-aligned).
  // INV-COST-5 still holds: the row carries the ONE credential that produced
  // it, resolved by the line's role naming the seat.
  const swarmSeatRecord = () => ({
    keyHash: undefined,
    limitMicroUsd: undefined,
    createdAt: "2026-09-26T12:00:00.000Z",
    swarmSeats: {
      seats: ["lead", "worker"],
      keyHashes: ["sha256:seat-lead", "sha256:seat-worker"],
      limitMicroUsd: [500_000, 400_000],
    },
  });

  test("swarm record: the seat's OWN hash + granted cap ride the row, resolved by ctx.role", () => {
    seedRecord("run-sw1", swarmSeatRecord());
    ledger.ingestCostEvent(mkEvent(), mkCtx({ role: "worker", runId: "run-sw1" }));
    const db = rawDb();
    const row = db.prepare("SELECT key_hash, key_limit_micro_usd, role FROM cost_events").get() as {
      key_hash: string;
      key_limit_micro_usd: number;
      role: string;
    };
    db.close();
    expect(row.key_hash).toBe("sha256:seat-worker");
    expect(row.key_limit_micro_usd).toBe(400_000);
    expect(row.role).toBe("worker");
  });

  test("swarm record: ctx.role naming no seat → key-hash-missing, zero rows (fail closed)", () => {
    seedRecord("run-sw2", swarmSeatRecord());
    let code = "";
    try {
      ledger.ingestCostEvent(mkEvent(), mkCtx({ role: "resident", runId: "run-sw2" }));
    } catch (e) {
      code = (e as CostLedgerError).code;
    }
    expect(code).toBe("key-hash-missing");
    const db = rawDb();
    expect(rowCount(db, "cost_events")).toBe(0);
    db.close();
  });

  test("swarm record minted before the limit stamp → refused, zero rows (no guessed cap)", () => {
    const noLimits = swarmSeatRecord();
    (noLimits.swarmSeats as Record<string, unknown>).limitMicroUsd = undefined;
    seedRecord("run-sw3", noLimits);
    let code = "";
    try {
      ledger.ingestCostEvent(mkEvent(), mkCtx({ role: "lead", runId: "run-sw3" }));
    } catch (e) {
      code = (e as CostLedgerError).code;
    }
    expect(code).toBe("key-hash-missing");
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

  test("the half-micro straddle: exactly 0.5 µ$ rounds UP to a priced 1, a hair under stays unpriced", () => {
    // The conversion is `Math.round(usd × 1e6)`, half-up — so 0.0000005 USD is
    // the last figure that is money (1 µ$, priced) and 0.0000004999 USD the
    // first that is not (0 µ$, flagged sub-micro like its 0.4 sibling above).
    // Both arms verified against JS floats: `0.0000005 * 1e6` is exactly 0.5,
    // `0.0000004999 * 1e6` ≈ 0.4999, so neither case silently flips with an
    // engine change to rounding.
    seedRecord("run-half");
    seedRecord("run-under");
    const half = ledger.ingestCostEvent(mkEvent({ agentId: "half", costUsd: 0.0000005 }), mkCtx({ runId: "run-half", requestId: "req-half" }));
    const under = ledger.ingestCostEvent(mkEvent({ agentId: "under", costUsd: 0.0000004999 }), mkCtx({ runId: "run-under", requestId: "req-under" }));
    expect(half.unpriced).toBe(false);
    expect(under.unpriced).toBe(true);

    const view = ledger.readIssueCost("qds/demo", "42");
    expect(view.totalMicroUsd).toBe(1); // the rounded half-micro, counted
    expect(view.unpricedRows).toBe(1); // …and the sub-floor one, surfaced
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
    // gate_admission_releases (2026-09-18): the compensating-release table
    // DF3.6a's pre-provision refusals write — append-only like its parent, and
    // carrying no spend figure cost_events does not already own.
    // Q1.2 adds the budget-group pair: the reservation and its compensating
    // release, append-only like the admissions family, carrying the GROUP
    // ceiling's outstanding sum — no spend figure cost_events does not own.
    expect(tables).toEqual([
      "cost_events",
      "gate_admissions",
      "budget_group_admissions",
      "budget_group_releases",
      "gate_admission_releases",
    ]);
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

  test("a closed run writes exactly one box_hours row = fractional lifetime × rate, integer µ$ (F8, 2026-08-24)", () => {
    seedRecord("run-a1", { createdAt: "2026-08-20T12:00:00.000Z", closedAt: "2026-08-20T13:30:00.000Z" });
    const res = ledger.ingestBoxHours(boxCtx);
    expect(res.inserted).toBe(true);

    const db = rawDb();
    const rows = db.prepare(
      "SELECT kind, cost_micro_usd, role, agent_id, key_hash, invocation_seq FROM cost_events WHERE kind='box_hours'",
    ).all() as { kind: string; cost_micro_usd: number; role: string | null; agent_id: string | null; key_hash: string | null; invocation_seq: number }[];
    db.close();
    expect(rows.length).toBe(1);
    // F8: 1.5h × 3.6M µ$/h = 5.4M µ$ EXACT — the old ceil-to-whole-hours
    // contract priced this 7.2M µ$ (a 2h minimum for a 1.5h box).
    expect(rows[0]!.cost_micro_usd).toBe(5_400_000);
    expect(rows[0]!.role).toBeNull();
    expect(rows[0]!.agent_id).toBeNull();
    expect(rows[0]!.key_hash).toBeNull();
    expect(rows[0]!.invocation_seq).toBe(0);
  });


  test("sub-hour boxes price fractionally — a 20-second box is not a 1-hour bill (F8)", () => {
    // The live incident (e2e-run-report F8): a ~20s box priced at exactly
    // 230,000 µ$ (= 1h at the configured rate). Wall-clock ms → integer µ$,
    // rounded UP to the next whole µ$ when the product divides unevenly.
    seedRecord("run-subhour", { createdAt: "2026-08-24T12:00:00.000Z", closedAt: "2026-08-24T12:00:20.000Z" });
    const res = ledger.ingestBoxHours({ ...boxCtx, runId: "run-subhour" });
    expect(res.inserted).toBe(true);
    const db = rawDb();
    const rows = db.prepare("SELECT cost_micro_usd FROM cost_events WHERE kind='box_hours' AND run_id='run-subhour'").all() as { cost_micro_usd: number }[];
    db.close();
    // 20s = 20,000 ms; 3.6M µ$/h = 1 µ$/ms exactly → 20,000 µ$. The old
    // formula wrote 3_600_000 (ceil → 1 whole hour).
    expect(rows[0]!.cost_micro_usd).toBe(20_000);
  });

  test("a sub-µ$ lifetime rounds UP to 1 µ$, never 0 (F8)", () => {
    // 1 ms of box life at 3.6M µ$/h is exactly 1 µ$; 0 would be free runtime.
    seedRecord("run-tiny", { createdAt: "2026-08-24T12:00:00.000Z", closedAt: "2026-08-24T12:00:00.001Z" });
    ledger.ingestBoxHours({ ...boxCtx, runId: "run-tiny" });
    const db = rawDb();
    const rows = db.prepare("SELECT cost_micro_usd FROM cost_events WHERE kind='box_hours' AND run_id='run-tiny'").all() as { cost_micro_usd: number }[];
    db.close();
    expect(rows[0]!.cost_micro_usd).toBe(1);
  });

  test("a zero-lifetime box (createdAt === closedAt) prices at the 1 µ$ FLOOR and lands priced, not unpriced (BTP-1)", () => {
    // Round-4 R4-27 pinned ceil-of-0 = 0 as observed; round-5 BTP-1 replaces
    // it: a row that recorded a REAL box prices free under the old figure,
    // against F8's own doctrine ("rounded UP so a sub-µ$ lifetime still
    // prices at 1 µ$, never 0"). The row is floored at 1 µ$. It is still a
    // PRICED row (unpriced=0, hard-coded by the ingest) that counts as an
    // event, so a closed run is never mistaken for a pending one — the
    // evidence of teardown may not be absent, and now neither may the µ$.
    seedRecord("run-zero", { createdAt: "2026-08-24T12:00:00.000Z", closedAt: "2026-08-24T12:00:00.000Z" });
    const res = ledger.ingestBoxHours({ ...boxCtx, runId: "run-zero" });
    expect(res.inserted).toBe(true);
    expect(res.unpriced).toBe(false);
    const db = rawDb();
    const row = db.prepare("SELECT cost_micro_usd, unpriced FROM cost_events WHERE run_id='run-zero'").get() as {
      cost_micro_usd: number;
      unpriced: number;
    };
    db.close();
    expect(row.cost_micro_usd).toBe(1);
    expect(row.unpriced).toBe(0);
    const view = ledger.readIssueCost("qds/demo", "42");
    expect(view.totalMicroUsd).toBe(1);
    expect(view.perRole).toEqual({ "box-hours": 1 });
    expect(view.eventCount).toBe(1);
    expect(view.hasEvents).toBe(true);
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
    ledger.ingestBoxHours(boxCtx); // F8: 10min × 3.6M µ$/h = 600,000 µ$ fractional
    const view = ledger.readIssueCost("qds/demo", "42");
    expect(view.totalMicroUsd).toBe(10_000 + 600_000);
    // box-hours surface as an explicit unattributed line, never an invented role
    expect(view.perRole).toEqual({ lead: 10_000, "box-hours": 600_000 });
  });

  test("an unconfigured box-hour rate is a structured config error, not a zero row", () => {
    const unConfigured = new CostLedger({ path: ledgerPath, readRunRecord: (id) => RECORDS.get(id) });
    seedRecord("run-a1", { closedAt: "2026-08-20T13:00:00.000Z" });
    expect(() => unConfigured.ingestBoxHours(boxCtx)).toThrow(CostConfigError);
    unConfigured.close();
  });

  // K9 (round 11): the dedup key is (runId, closedAt). A redelivery digesting
  // identically but PRICED differently — rate edited, record re-priced after the
  // fact — used to silently dedupe; now it emits a structured ingest-digest-collision
  // line naming both figures. The SUM counts the STORED row either way, which is
  // what this pin makes explicit.
  test("a same-key redelivery priced DIFFERENTLY never silently dedupes — collision line names both figures", () => {
    seedRecord("run-a1", { createdAt: "2026-08-20T12:00:00.000Z", closedAt: "2026-08-20T13:30:00.000Z" });
    const first = ledger.ingestBoxHours(boxCtx);
    expect(first.inserted).toBe(true);

    const lines: Record<string, unknown>[] = [];
    const restore = setLogSink((e) => lines.push(e as unknown as Record<string, unknown>));
    let second: ReturnType<CostLedger["ingestBoxHours"]>;
    try {
      // The record's lifetime changed under the stored row (re-priced after close):
      // same (runId, closedAt) digest, different computed figure.
      RECORDS.set("run-a1", { ...RECORDS.get("run-a1")!, closedAt: "2026-08-20T15:30:00.000Z" });
      seedRecord("run-a1", { closedAt: "2026-08-20T13:30:00.000Z", createdAt: "2026-08-20T11:00:00.000Z" });
      second = ledger.ingestBoxHours(boxCtx);
    } finally {
      restore();
    }
    expect(second.inserted).toBe(false); // ON CONFLICT DO NOTHING held
    expect(second.eventId).toBe(first.eventId);

    const line = lines.find((l) => l.code === "ingest-digest-collision");
    expect(line).toBeDefined();
    expect(line?.outcome).toBe("digest-collision");
    expect(line?.storedCostMicroUsd).toBe(5_400_000); // 1.5h × 3.6M µ$/h
    expect(line?.computedCostMicroUsd).toBe(9_000_000); // 11:00→13:30 = 2.5h × 3.6M µ$/h
    expect(String(line?.message)).toContain("the SUM counts the STORED figure");

    // And the sum indeed counts the STORED one, exactly once.
    const db = rawDb();
    expect(rowCount(db, "cost_events")).toBe(1);
    db.close();
    expect(ledger.readIssueCost("qds/demo", "42").totalMicroUsd).toBe(5_400_000);
  });

  // K1 residual: admitIssue retires a closed run's reservation once closedAt passes
  // ADMISSION_GRACE_MS + ADMISSION_SKEW_MARGIN_MS (~6 min), re-granting that headroom.
  // Teardown's crash-recovery re-run can land its box-hours row AFTER that cutoff —
  // spend against a cap whose reservation is gone, so admissions granted since may
  // have spent into this charge. Nothing can un-retire an append-only admission, so
  // the fail-safe response is to NAME the exposure, loudly and structuredly.
  test("box hours landing PAST the reservation-retirement cutoff emit a loud late-ingest warning", () => {
    const graceCutoffMs = ADMISSION_GRACE_MS + ADMISSION_SKEW_MARGIN_MS;
    const closedLongAgo = new Date(Date.now() - graceCutoffMs - 60_000);
    const createdTenMinEarlier = new Date(closedLongAgo.getTime() - 10 * 60_000);
    seedRecord("run-late", {
      createdAt: createdTenMinEarlier.toISOString(),
      closedAt: closedLongAgo.toISOString(),
    });

    const lines: Record<string, unknown>[] = [];
    const restore = setLogSink((e) => lines.push(e as unknown as Record<string, unknown>));
    let res: ReturnType<CostLedger["ingestBoxHours"]>;
    try {
      res = ledger.ingestBoxHours({ runId: "run-late", repoSlug: "qds/demo", issueId: "42", requestId: "req-late" });
    } finally {
      restore();
    }
    expect(res.inserted).toBe(true); // the money row DID land — this is a report, not a refusal

    const line = lines.find((l) => l.code === "box-hours-late-past-reservation-cutoff");
    expect(line).toBeDefined();
    expect(line?.outcome).toBe("late-ingest-over-cap-risk");
    expect(line?.closedAt).toBe(closedLongAgo.toISOString());
    expect(line?.costMicroUsd).toBe(600_000); // 10 min × 3.6M µ$/h — positive spend only
    expect(String(line?.message)).toContain("reservation-retirement cutoff");
    // BRG-10: the warning carries the literal next command, not just the alarm.
    expect(String(line?.remediation)).toContain("reservation retirement");

    // Control in the other direction: the idempotent re-run of the SAME landed row
    // does not fire again (it no longer inserts), and a row landing inside the window
    // stays silent — the warning means "past the cutoff", not "late relative to today".
    const linesAfter: Record<string, unknown>[] = [];
    const restore2 = setLogSink((e) => linesAfter.push(e as unknown as Record<string, unknown>));
    try {
      ledger.ingestBoxHours({ runId: "run-late", repoSlug: "qds/demo", issueId: "42", requestId: "req-late" });
      seedRecord("run-fresh-close", {
        createdAt: new Date(Date.now() - 5 * 60_000).toISOString(),
        closedAt: new Date(Date.now() - 30_000).toISOString(), // inside the ~6 min window
      });
      ledger.ingestBoxHours({ runId: "run-fresh-close", repoSlug: "qds/demo", issueId: "42", requestId: "req-rfc" });
    } finally {
      restore2();
    }
    expect(linesAfter.find((l) => l.code === "box-hours-late-past-reservation-cutoff")).toBeUndefined();
  });

  // Closeout review F5: token rows contribute to the SAME derived SUM admitIssue
  // reads, so a token row landing past the retirement cutoff is the SAME exposure
  // the box-hours tripwire names — and it must warn the same way, not silently
  // re-price a cap whose reservation was already re-granted.
  test("token rows landing PAST the reservation-retirement cutoff warn like box hours do", () => {
    const graceCutoffMs = ADMISSION_GRACE_MS + ADMISSION_SKEW_MARGIN_MS;
    const closedLongAgo = new Date(Date.now() - graceCutoffMs - 60_000);
    const createdTenMinEarlier = new Date(closedLongAgo.getTime() - 10 * 60_000);
    seedRecord("run-token-late", {
      createdAt: createdTenMinEarlier.toISOString(),
      closedAt: closedLongAgo.toISOString(),
    });

    const lines: Record<string, unknown>[] = [];
    const restore = setLogSink((e) => lines.push(e as unknown as Record<string, unknown>)); // dp:ok widens THIS test's own captured sink events
    let res: ReturnType<CostLedger["ingestCostEvent"]>;
    try {
      res = ledger.ingestCostEvent(mkEvent(), mkCtx({ runId: "run-token-late", requestId: "req-tl" }));
    } finally {
      restore();
    }
    expect(res.inserted).toBe(true); // the money row DID land — this is a report, not a refusal

    const line = lines.find((l) => l.code === "token-ingest-late-past-reservation-cutoff");
    expect(line).toBeDefined();
    expect(line?.outcome).toBe("late-ingest-over-cap-risk");
    expect(line?.kind).toBe("tokens");
    expect(String(line?.message)).toContain("reservation-retirement cutoff");
    // BRG-10: same literal next command as the box-hours tripwire.
    expect(String(line?.remediation)).toContain("reservation retirement");

    // Control in the other direction: a row landing inside the window stays
    // silent — the warning means "past the cutoff", not "late relative to today".
    const linesAfter: Record<string, unknown>[] = [];
    const restore2 = setLogSink((e) => linesAfter.push(e as unknown as Record<string, unknown>)); // dp:ok widens THIS test's own captured sink events
    try {
      seedRecord("run-token-fresh", {
        createdAt: new Date(Date.now() - 5 * 60_000).toISOString(),
        closedAt: new Date(Date.now() - 30_000).toISOString(),
      });
      ledger.ingestCostEvent(mkEvent(), mkCtx({ runId: "run-token-fresh", requestId: "req-tf" }));
    } finally {
      restore2();
    }
    expect(linesAfter.find((l) => l.code === "token-ingest-late-past-reservation-cutoff")).toBeUndefined();
  });

  // Review round: an UNPRICED token row (unpricedTurns > 0 with a finite,
  // positive costUsd) persists a positive cost_micro_usd but is EXCLUDED from
  // the priced SUM the gate reads — warning about cap exposure from money the
  // SUM never counts is a false alarm. Only priced rows carry the exposure.
  test("an unpriced token row landing PAST the cutoff stays silent — the priced SUM never counts it", () => {
    const graceCutoffMs = ADMISSION_GRACE_MS + ADMISSION_SKEW_MARGIN_MS;
    const closedLongAgo = new Date(Date.now() - graceCutoffMs - 60_000);
    seedRecord("run-token-late-unpriced", {
      createdAt: new Date(closedLongAgo.getTime() - 10 * 60_000).toISOString(),
      closedAt: closedLongAgo.toISOString(),
    });

    const lines: Record<string, unknown>[] = [];
    const restore = setLogSink((e) => lines.push(e as unknown as Record<string, unknown>)); // dp:ok widens THIS test's own captured sink events
    let res: ReturnType<CostLedger["ingestCostEvent"]>;
    try {
      res = ledger.ingestCostEvent(
        mkEvent({ unpricedTurns: 1, costUsd: 0.5 }), // positive money, producer-marked unpriced
        mkCtx({ runId: "run-token-late-unpriced", requestId: "req-tlu" }),
      );
    } finally {
      restore();
    }
    expect(res.inserted).toBe(true);
    expect(res.unpriced).toBe(true); // landed unpriced: positive µ$, excluded from the priced SUM
    expect(lines.find((l) => l.code === "token-ingest-late-past-reservation-cutoff")).toBeUndefined();
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

  test("the close-retirement cutoff is the same grace window, pinned from BOTH sides", () => {
    // The boundary arms of the test above, tightened to the window itself:
    // just INSIDE keeps counting (the close→price race is still open), just
    // OUTSIDE retires. Derived from the import so a window retune moves these
    // with it instead of turning them into false failures. The exact-equality
    // instant is not discriminable here: `graceCutoff` is recomputed inside
    // admitIssue from ITS Date.now(), which has already advanced by the time
    // this test hands a timestamp over, so an == fixture would drift to the
    // outside arm under either comparison operator. What these two DO pin is
    // that the qualifier rides the window constant and closedAt alone — a
    // change of window width, or of the column it reads, fails one arm.
    seedRecord("run-a1");
    const first = ledger.admitIssue({ repoSlug: "qds/demo", issueId: "42", runId: "run-a1", requestId: "req-1" }, cap, 50_000_000);
    if (!first.admitted) throw new Error("expected the first dispatch to be admitted");
    ledger.ingestCostEvent(mkEvent({ costUsd: 0 }), mkCtx());

    const JUST_INSIDE_MS = 2_000; // >> clock drift between utimes and the read
    seedRecord("run-a1", { closedAt: new Date(Date.now() - expiryMs + JUST_INSIDE_MS).toISOString() });
    // "Keeps counting" reads as a refusal here — the held ceiling alone meets
    // the cap, exactly like the freshly-closed case above — so the assertion
    // is the refusal's reserved figure, not an admission.
    const stillCounted = ledger.admitIssue({ repoSlug: "qds/demo", issueId: "42", runId: "run-inside", requestId: "req-inside" }, cap, 50_000_000);
    if (stillCounted.admitted) throw new Error("expected the just-inside close to still hold its ceiling");
    expect(stillCounted.reservedMicroUsd).toBe(cap);

    seedRecord("run-a1", { closedAt: new Date(Date.now() - expiryMs - JUST_INSIDE_MS).toISOString() });
    const retired = ledger.admitIssue({ repoSlug: "qds/demo", issueId: "42", runId: "run-outside", requestId: "req-outside" }, cap, 50_000_000);
    if (!retired.admitted) throw new Error("expected the just-outside close's reservation to have retired");
    expect(retired.reservedMicroUsd).toBe(0);
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
    //
    // T2-13 (round 11), scope honestly stated: these two admitIssue calls are
    // SEQUENTIAL, so this test alone also passes with decide.immediate() deleted
    // and would not notice real interleaving. Actual concurrency coverage is carried
    // by exactly ONE probe in this file — "the SELECT and the INSERT run inside ONE
    // write transaction" below-neighborhood (the BEGIN IMMEDIATE lock-out seam) —
    // which is why that single test is the one that must not rot or be skipped.
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

  test("two SEQUENTIAL admissions simulate the race: the second cannot win the full remaining headroom", () => {
    // Title says sequential because it is: these are two synchronous calls on
    // one ledger, not concurrent dispatches. What they simulate is the real
    // interleaving: A's admission COMMITs, and A has NOT yet reached
    // store.create — so A's run record does not resolve when B walks the
    // reservations. Without the grace window B reads A's reservation as an
    // orphan, skips it, and both are granted the whole 5M cap. (The actual
    // concurrency serialization is pinned by the BEGIN IMMEDIATE tests in the
    // serialized-admission describe above.)
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
    // ±10s, not ±1s (T2-1): these ages are computed from THIS test's Date.now(),
    // but admitIssue's predicate re-reads it INSIDE the call. A >1s stall
    // between the insert and that read aged the −1s arm past expiry and red-teamed
    // a correct implementation on loaded CI runners — money-path noise that
    // trains people to re-run and ignore. 10s keeps both arms far inside/outside
    // the boundary under any plausible stall while the straddle still pins the
    // window's width to seconds, not minutes.
    expect(ADMISSION_GRACE_MS).toBe(60_000);
    expect(ADMISSION_SKEW_MARGIN_MS).toBe(300_000);
    const BOUNDARY_MARGIN_MS = 10_000;
    admitAged("run-just-young", "rjy", 1_000_000, expiryMs - BOUNDARY_MARGIN_MS, "101");
    const young = ledger.admitIssue({ repoSlug: "qds/demo", issueId: "101", runId: "run-jy", requestId: "rjy2" }, cap, 500_000);
    if (!young.admitted) throw new Error("expected admission alongside the just-young reservation");
    expect(young.reservedMicroUsd).toBe(1_000_000);

    admitAged("run-just-old", "rjo", 1_000_000, expiryMs + BOUNDARY_MARGIN_MS, "102");
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

  test("an issue whose spend SUM crosses the safe-integer range still refuses fail-closed", () => {
    // Neighborhood of the overflow: every ROW is individually valid (usdToMicros
    // enforces safe integers per event), but their SQLite-side SUM lands past
    // 2^53, where JS numbers lose unit precision. Nothing may wrap to negative,
    // NaN, or a figure below the cap: the only acceptable shape is the ordinary
    // over-budget refusal naming a finite spent figure far above it.
    // Residual, accepted and noted: past 2^53 the reported µ$ total can drift by
    // more than 1 from the exact arithmetic sum, so a cap sitting within that
    // drift of the true committed spend could flip either way — the guard for
    // THAT would be a ledger-level overflow check, not a test.
    seedRecord("run-ovf");
    const bigRowUsd = 450_000_000; // $450M/row → 4.5e14 µ$; 40 rows ≈ 1.8e16 µ$ > 2^53
    for (let seq = 0; seq < 40; seq++) {
      const res = ledger.ingestCostEvent(
        mkEvent({ agentId: `ovf-${seq}`, costUsd: bigRowUsd }),
        mkCtx({ runId: "run-ovf", requestId: "req-ovf", invocationSeq: seq }),
      );
      expect(res.unpriced).toBe(false);
    }
    const d = ledger.admitIssue({ repoSlug: "qds/demo", issueId: "42", runId: "run-after-ovf", requestId: "req-after" }, cap, 50_000_000);
    expect(d.admitted).toBe(false);
    if (!d.admitted) {
      expect(d.reason).toBe("spend-cap-exceeded");
      expect(Number.isFinite(d.spentMicroUsd)).toBe(true);
      expect(d.spentMicroUsd).toBeGreaterThan(cap);
    }
  });

  test("reservation ceilings summing past MAX_SAFE_INTEGER throw ledger-overflow instead of wrapping", () => {
    // Companion to the spend-SUM overflow above: admitIssue's OTHER additive
    // site is the reservation-sum guard. Two live reservations whose ceilings
    // are each individually valid but jointly past 2^53 must surface the named
    // CostLedgerError — not a wrapped negative, an admitted decision carrying a
    // nonsense reserved figure, or some generic Error.
    admitAged("run-big-a", "req-big-a", Number.MAX_SAFE_INTEGER - 1000, 0);
    admitAged("run-big-b", "req-big-b", Number.MAX_SAFE_INTEGER - 1000, 0);
    let thrown: unknown;
    try {
      ledger.admitIssue(
        { repoSlug: "qds/demo", issueId: "42", runId: "run-after-big", requestId: "req-after-big" },
        Number.MAX_SAFE_INTEGER,
        Number.MAX_SAFE_INTEGER,
      );
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(CostLedgerError);
    expect((thrown as CostLedgerError).code).toBe("ledger-overflow");
  });

  test("a record created between the prefetch and the transaction is COUNTED, not expired", () => {
    // The prefetch used to cache `{record: undefined}` for an absent record;
    // inside the transaction that frozen absence read as expired-orphan for a
    // row whose dispatch had JUST created its record — retiring a live
    // reservation and handing its ceiling out twice. Only successful reads are
    // cached now; an absence re-reads LIVE under the lock.
    admitAged("run-lateborn", "rl", 1_000_000, expiryMs * 2); // aged row, record absent yet
    let reads = 0;
    const lateBorn = new CostLedger({
      path: ledgerPath,
      readRunRecord: (id) => {
        if (id === "run-lateborn") {
          reads++;
          if (reads === 1) return undefined; // absent at prefetch …
          seedRecord("run-lateborn"); // …created before the write lock was taken
        }
        return RECORDS.get(id);
      },
      config: { defaultCapMicroUsd: cap, boxHourRateMicroUsd: 3_600_000 },
    });
    try {
      const d = lateBorn.admitIssue({ repoSlug: "qds/demo", issueId: "42", runId: "run-new", requestId: "rn" }, cap, 500_000);
      expect(reads).toBe(2); // prefetch AND the live re-read inside the transaction
      if (!d.admitted) throw new Error(`expected admission, got ${d.reason}`);
      expect(d.reservedMicroUsd).toBe(1_000_000); // counted, not expired-orphaned
    } finally {
      lateBorn.close();
    }
  });

  test("a transient read failure at prefetch is retried inside the transaction, not frozen", () => {
    // Same shape for the error half of the old cache: a throw at prefetch was
    // carried into the decision, where an AGED row took it as "this run will
    // never report spend" and expired the reservation — even though the record
    // reads fine a moment later. One live retry inside the lock is enough.
    seedRecord("run-flaky");
    admitAged("run-flaky", "rfl", 1_000_000, expiryMs * 2);
    let calls = 0;
    const flaky = new CostLedger({
      path: ledgerPath,
      readRunRecord: (id) => {
        if (id === "run-flaky") {
          calls++;
          if (calls === 1) throw new Error("EIO mid-sweep"); // transient, at prefetch only
        }
        return RECORDS.get(id);
      },
      config: { defaultCapMicroUsd: cap, boxHourRateMicroUsd: 3_600_000 },
    });
    try {
      const d = flaky.admitIssue({ repoSlug: "qds/demo", issueId: "42", runId: "run-next", requestId: "rn3" }, cap, 500_000);
      expect(calls).toBe(2); // the retry really happened under the lock
      if (!d.admitted) throw new Error(`expected admission, got ${d.reason}`);
      expect(d.reservedMicroUsd).toBe(1_000_000); // counted — no frozen-error expiry
    } finally {
      flaky.close();
    }
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

  test("a THROWING log sink does not turn an absent-config layout into an error", () => {
    // The absent-file notice used to log through the raw sink; a raising custom
    // sink converted a legitimate layout into a thrown error out of a loader
    // whose contract is "absent ⇒ defaults". Routed through the same guarded
    // emission every other committed outcome here uses.
    let threw = false; // flipped by the sink itself, so a silent skip cannot pass
    const restore = setLogSink(() => {
      threw = true;
      throw new Error("sink exploded");
    });
    let loaded: ReturnType<typeof loadCostConfig>;
    try {
      loaded = loadCostConfig(join(dir, "none.json"));
    } finally {
      restore();
    }
    expect(threw).toBe(true); // the sink really ran and really raised
    expect(loaded.source).toBe("default"); // …and the layout still resolves
    expect(loaded.config).toEqual({ ...DEFAULT_COST_CONFIG });
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

  test("a raw slug padded with whitespace still counts — column-side trim mirrors the bind-side fold", () => {
    // lower() alone never matched `" qds/Demo "`: the padded row's spend sat
    // OUTSIDE every SUM the cap reads — an under-count, which is the
    // cap-bypass direction. The column side now trims exactly the ASCII set
    // canonicalRepoSlug trims, so a padded historical row lands in scope.
    const raw = rawDb();
    raw.prepare(
      `INSERT INTO cost_events (event_id, run_id, repo_slug, issue_id, request_id, role,
                                agent_id, kind, invocation_seq, cost_micro_usd, unpriced, created_at)
       VALUES ('legacy-padded', 'run-padded', ' qds/Demo ', '42', 'req-padded', 'lead',
               'lead-1', 'tokens', 0, 2500000, 0, '2026-08-20T12:00:00.000Z')`,
    ).run();
    raw.close();

    expect(ledger.readIssueCost("qds/demo", "42").totalMicroUsd).toBe(2_500_000);

    // The gate reads that same SUM: 2.5M µ$ committed against a 2M µ$ cap refuses.
    seedRecord("run-pad-next");
    const d = ledger.admitIssue(
      { repoSlug: "qds/demo", issueId: "42", runId: "run-pad-next", requestId: "req-pad-next" },
      2_000_000,
      50_000_000,
    );
    expect(d.spentMicroUsd).toBe(2_500_000);
    expect(d.admitted).toBeFalse();
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
        // The refusal names the grammar the identity fails, empty or not —
        // every value here canonicalises to "" and no override key can name it.
        expect(err?.message).toContain("not a budget key a perIssueOverrides entry");
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

  // K5 (review round 11): `"# 42"` — trim, THEN strip `#` WITH its following
  // whitespace — used to fold to `" 42"`, a fifth spelling no override matched.
  test("a space after the '#' folds with it: '# 42' is the same budget identity as '42'", () => {
    seedRecord("run-hashspace");
    // Billed under "# 42"; read under every spelling, including the raw shape
    // only this pair of folds accepts.
    ledger.ingestCostEvent(mkEvent(), mkCtx({ runId: "run-hashspace", requestId: "req-hs", issueId: "# 42" }));
    for (const issueId of ["# 42", "42", "#42", "042"]) {
      expect(ledger.readIssueCost("qds/demo", issueId).totalMicroUsd).toBe(12_345); // mkEvent's default
    }
    // Override keys name it too — the whole point of the fold.
    const config = { ...DEFAULT_COST_CONFIG, perIssueOverrides: { "qds/demo#42": 7_000_000 } };
    expect(capForIssue(config, "qds/demo", "# 42")).toBe(7_000_000);

    // The SQL-side mirror (fix-K's second half): a legacy row stored with the
    // padded spelling still counts, which is what pins sqlCanonicalIssueId to
    // the same single-pass fold instead of drifting on the `##` shapes.
    const raw = rawDb();
    try {
      raw.prepare(
        `INSERT INTO cost_events (event_id, run_id, repo_slug, issue_id, request_id, role,
                                  agent_id, kind, invocation_seq, cost_micro_usd, unpriced, created_at)
         VALUES ('legacy-hash-space', 'run-legacy-hs', 'qds/demo', '# 42', 'req-legacy', 'lead',
                 'lead-1', 'tokens', 0, 2000000, 0, '2026-08-20T12:00:00.000Z')`,
      ).run();
    } finally {
      raw.close();
    }
    expect(ledger.readIssueCost("qds/demo", "42").totalMicroUsd).toBe(2_012_345); // 12,345 fresh + 2M legacy
    // Distinct identities stay distinct: `"##42"` strips one decorator and stops,
    // exactly like the anchored JS regex — it does not become "42".
    expect(ledger.readIssueCost("qds/demo", "##42").hasEvents).toBe(false);
  });

  // K6: canonicalIssueId is TOTAL by design (reads of pre-existing rows must not
  // throw), so a non-digit remainder folded to itself and opened a budget identity
  // no ISSUE_KEY_RE override can spell — one default cap covering an unbounded set
  // of malformed dispatches. assertCanonicalIdentity refuses those now; these are
  // the typed arms for the two shapes the empty-refusal tests above cannot reach.
  test.each(["42x", "-1"])(
    "issueId %p is REFUSED — it canonicalises to a non-numeric identity no override can name",
    (issueId) => {
      seedRecord("run-malformed");
      const calls: Array<() => void> = [
        () => ledger.admitIssue({ repoSlug: "qds/demo", issueId, runId: "run-malformed", requestId: "req-malformed" }, 5_000_000, 50_000_000),
        () => ledger.ingestCostEvent(mkEvent(), mkCtx({ issueId })),
        () => ledger.ingestBoxHours({ runId: "run-malformed", repoSlug: "qds/demo", issueId, requestId: "req-malformed" }),
      ];
      for (const call of calls) {
        let err: CostLedgerError | undefined;
        try {
          call();
        } catch (e) {
          err = e as CostLedgerError;
        }
        expect(err).toBeInstanceOf(CostLedgerError);
        // Typed, and naming the actual problem — not the empty-identity wording.
        expect(err?.message).toContain("not a budget key a perIssueOverrides entry");
      }
      // A refused identity booked nothing, so no shared bucket exists either.
      const db = rawDb();
      expect(rowCount(db, "gate_admissions")).toBe(0);
      expect(rowCount(db, "cost_events")).toBe(0);
      db.close();
    },
  );

  // K10 regression pin: the type forbids null, but a CostConfig assembled in code
  // or parsed without the validator reaches capForIssue anyway — and the in-code
  // arm regressed once to Object.entries(null) throwing OUT OF THE GATE where the
  // old `?.` lookup returned the default cap. Absent overrides mean default, in
  // either spelling of absent.
  test("capForIssue treats a NULL overrides map as absent (default cap, never a throw)", () => {
    const asNull = { ...DEFAULT_COST_CONFIG, perIssueOverrides: null } as unknown as Parameters<typeof capForIssue>[0];
    expect(capForIssue(asNull, "qds/demo", "42")).toBe(DEFAULT_COST_CONFIG.defaultCapMicroUsd);
    // Through the gate too — admitIssue reads caps via capForIssue.
    seedRecord("run-null-overrides");
    const gated = new CostLedger({
      path: join(dir, "null-ovr.db"),
      config: { ...DEFAULT_COST_CONFIG, perIssueOverrides: null } as unknown as Parameters<typeof capForIssue>[0],
    });
    try {
      const d = gated.admitIssue({ repoSlug: "qds/demo", issueId: "42", runId: "run-null-overrides", requestId: "rnv" }, DEFAULT_COST_CONFIG.defaultCapMicroUsd, 50_000_000);
      if (!d.admitted) throw new Error(`expected admission under a null overrides map, got ${d.reason}`);
      expect(d.capMicroUsd).toBe(DEFAULT_COST_CONFIG.defaultCapMicroUsd);
    } finally {
      gated.close();
    }
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
    // DELIBERATE CHANGE-DETECTOR (T2-12): this pins source TEXT, not behavior —
    // a behavior-preserving reformat (line wrap, alias rename) red-tests it while
    // nothing can falsely pass. Accepted because the thing protected against has
    // no runtime probe (see below); its failure mode is CI noise, never silence.
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
    // matchAll, not exec: exec sees only the FIRST match, so a second
    // reservation-reading query added later with plain `=` inside it would sail
    // through this pin green. Every occurrence must carry IS — today there is
    // exactly ONE SQL site (the in-transaction reservation read; the prefetch
    // read outside the lock scopes on issue columns alone), and the count pin
    // below makes adding a second site a conscious decision to re-count.
    const hits = [...source.matchAll(/NOT \(a\.request_id (\S+) \? AND a\.run_id (\S+) \?\)/g)];
    expect(hits.length).toBe(1);
    for (const hit of hits) {
      expect([hit[1], hit[2]]).toEqual(["IS", "IS"]);
    }
    // And the unsafe spelling exists NOWHERE, not merely "not first": SQLite's
    // three-valued logic makes `NOT (x = NULL AND …)` NULL for every row, so one
    // copy of the `=` shape is one vanishing-reservation bug waiting to ship.
    expect(source).not.toMatch(/NOT \(a\.request_id = \? AND a\.run_id = \?\)/);
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

  // ── aged read faults vs proven absence (the stat cross-check) ───────────────

  /**
   * A ledger whose record reader throws an errno-coded fault for the named run
   * ids, pointed at a records directory pre-seeded with files of the given
   * byte sizes (`<id>.json`). This is the fixture an EIO-shaped transient
   * needs: a reader that merely RETURNS undefined exercises the absence path,
   * not the throw arm the cross-check guards.
   */
  function faultLedger(throwFor: string[], files: Record<string, number> = {}): CostLedger {
    const runsDir = join(dir, "runs-fp1");
    mkdirSync(runsDir, { recursive: true });
    for (const [id, size] of Object.entries(files)) {
      writeFileSync(join(runsDir, `${id}.json`), "x".repeat(size));
    }
    return new CostLedger({
      path: ledgerPath,
      runsDir,
      readRunRecord: (id) => {
        if (throwFor.includes(id)) {
          const e: Error & { code?: string } = new Error(`unreadable run record ${id}.json: EIO`);
          e.code = "EIO";
          throw e;
        }
        return RECORDS.get(id);
      },
      config: { defaultCapMicroUsd: 5_000_000, boxHourRateMicroUsd: 3_600_000 },
    });
  }

  test("an AGED read fault over a record STILL ON DISK keeps its ceiling counted, not re-granted", () => {
    // Transient EIO past the grace window used to expire a LIVE run's
    // reservation: the next dispatch was granted the full remaining headroom
    // ATOP that live exposure — overspend by design gap, guarded only while
    // the run was young. Present-and-non-empty counts as still-reserved
    // instead: under-admit, never over-admit.
    const throwing = faultLedger(["run-eio"], { "run-eio": 64 });
    try {
      admitAged("run-eio", "re", 4_000_000, expiryMs * 2, "211");
      const lines: Record<string, unknown>[] = [];
      const restore = setLogSink((e) => lines.push(e as unknown as Record<string, unknown>));
      let d: ReturnType<CostLedger["admitIssue"]>;
      try {
        d = throwing.admitIssue({ repoSlug: "qds/demo", issueId: "211", runId: "run-next", requestId: "rn" }, cap, 500_000);
      } finally {
        restore();
      }
      if (!d.admitted) throw new Error(`expected admission atop the held reservation, got ${d.reason}`);
      expect(d.reservedMicroUsd).toBe(4_000_000); // KEPT, not expired
      expect(d.remainingMicroUsd).toBe(1_000_000);
      // And the granted ceiling fits the headroom left AFTER the held ceiling.
      expect(d.admittedCeilingMicroUsd).toBe(500_000);
      // Never silent either way — the hold names the run and its exposure.
      const held = lines.find((l) => l.code === "reservation-unresolvable-held");
      expect(held?.orphanRunId).toBe("run-eio");
      expect(held?.orphanCeilingMicroUsd).toBe(4_000_000);
      expect(lines.find((l) => l.code === "reservation-unresolvable-expired")).toBeUndefined();
    } finally {
      throwing.close();
    }
  });

  test("a HELD unresolvable reservation refuses when it alone exceeds the cap", () => {
    // The hold is a real reservation, not a shrug: 6M µ$ held against a 5M µ$
    // cap must refuse, exactly as a readable reservation would.
    const throwing = faultLedger(["run-eio-big"], { "run-eio-big": 64 });
    try {
      admitAged("run-eio-big", "reb", 6_000_000, expiryMs * 2, "212");
      const lines: Record<string, unknown>[] = [];
      const restore = setLogSink((e) => lines.push(e as unknown as Record<string, unknown>));
      let d: ReturnType<CostLedger["admitIssue"]>;
      try {
        d = throwing.admitIssue(
          { repoSlug: "qds/demo", issueId: "212", runId: "run-next2", requestId: "rn2" },
          cap,
          500_000,
        );
      } finally {
        restore();
      }
      expect(d.admitted).toBeFalse();
      if (d.admitted) throw new Error("unreachable");
      expect(d.reason).toBe("spend-cap-exceeded");
      expect(d.reservedMicroUsd).toBe(6_000_000);
      expect(lines.find((l) => l.code === "reservation-unresolvable-held")).toBeDefined();
    } finally {
      throwing.close();
    }
  });

  test("a PROVEN-ABSENT record still expires — the path stats ENOENT", () => {
    const throwing = faultLedger(["run-gone"]);
    try {
      admitAged("run-gone", "rg", 4_000_000, expiryMs * 2, "213");
      const lines: Record<string, unknown>[] = [];
      const restore = setLogSink((e) => lines.push(e as unknown as Record<string, unknown>));
      let d: ReturnType<CostLedger["admitIssue"]>;
      try {
        d = throwing.admitIssue(
          { repoSlug: "qds/demo", issueId: "213", runId: "run-next3", requestId: "rn3" },
          cap,
          500_000,
        );
      } finally {
        restore();
      }
      if (!d.admitted) throw new Error(`expected the wedge to clear, got ${d.reason}`);
      expect(d.reservedMicroUsd).toBe(0);
      const line = lines.find((l) => l.code === "reservation-unresolvable-expired");
      expect(line?.orphanRunId).toBe("run-gone");
      expect(lines.find((l) => l.code === "reservation-unresolvable-held")).toBeUndefined();
    } finally {
      throwing.close();
    }
  });

  test("a confirmed ZERO-BYTE tombstone still expires — structural absence by size", () => {
    // The interrupted-create tombstone clearCreateTombstone documents: no
    // keyHash, no box, nothing that will ever report spend.
    const throwing = faultLedger(["run-tomb"], { "run-tomb": 0 });
    try {
      admitAged("run-tomb", "rt", 4_000_000, expiryMs * 2, "214");
      const lines: Record<string, unknown>[] = [];
      const restore = setLogSink((e) => lines.push(e as unknown as Record<string, unknown>));
      let d: ReturnType<CostLedger["admitIssue"]>;
      try {
        d = throwing.admitIssue(
          { repoSlug: "qds/demo", issueId: "214", runId: "run-next4", requestId: "rn4" },
          cap,
          500_000,
        );
      } finally {
        restore();
      }
      if (!d.admitted) throw new Error(`expected the tombstone to expire, got ${d.reason}`);
      expect(d.reservedMicroUsd).toBe(0);
      expect(lines.find((l) => l.code === "reservation-unresolvable-expired")).toBeDefined();
    } finally {
      throwing.close();
    }
  });

  test("a run id outside even the LEGACY grammar expires WITHOUT consulting the filesystem", () => {
    // An id that could never have named a record file nor a box can never
    // report spend — the original wedge-cure keeps working, and the hand-built
    // filename can never escape the records directory.
    const throwing = faultLedger(["../../escape"]);
    try {
      admitAged("../../escape", "rx", 4_000_000, expiryMs * 2, "215");
      const lines: Record<string, unknown>[] = [];
      const restore = setLogSink((e) => lines.push(e as unknown as Record<string, unknown>));
      let d: ReturnType<CostLedger["admitIssue"]>;
      try {
        d = throwing.admitIssue(
          { repoSlug: "qds/demo", issueId: "215", runId: "run-next5", requestId: "rn5" },
          cap,
          500_000,
        );
      } finally {
        restore();
      }
      if (!d.admitted) throw new Error(`expected the ungrammatical id to expire, got ${d.reason}`);
      expect(d.reservedMicroUsd).toBe(0);
      expect(lines.find((l) => l.code === "reservation-unresolvable-expired")?.orphanRunId).toBe("../../escape");
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

// ─── DF2.11 read-only open (AC5/AC6, WAL ceiling, identity) ─────────────────

describe("DF2.11 openReadOnly", () => {
  const boxCtx = { runId: "run-a1", repoSlug: "qds/demo", issueId: "42", requestId: "req-1" };

  function seedOneBoxHoursRow(): void {
    seedRecord("run-a1", { createdAt: "2026-08-20T12:00:00.000Z", closedAt: "2026-08-20T13:30:00.000Z" });
    const res = ledger.ingestBoxHours(boxCtx);
    expect(res.inserted).toBe(true);
  }

  /**
   * Identity snapshot of the files a read-only open must not disturb: the
   * ledger file, its parent directory entry, and the -wal sibling — each by
   * name, mode, mtime and size, and (regular files only) by CONTENT, so a
   * same-size rewrite inside one coarse-mtime tick still fails the comparison.
   */
  function snapshotFiles(paths: string[]): { name: string; mode: number; mtimeMs: number; size: number; sha256: string }[] {
    return paths.map((p) => {
      const st = statSync(p);
      return {
        name: p,
        mode: st.mode & 0o777,
        mtimeMs: st.mtimeMs,
        size: st.size,
        // A directory has no byte content to hash; the marker can never collide
        // with a file's digest.
        sha256: st.isFile() ? createHash("sha256").update(readFileSync(p)).digest("hex") : "",
      };
    });
  }

  test("AC5: a non-existent path refuses ledger-absent and creates NOTHING — no file, no dir, no siblings", () => {
    // The directory itself does not exist: the write path would mkdir it on
    // sight. The read-only open must not.
    const absentPath = join(dir, "never-created", "cost-ledger.db");
    let code = "";
    let remediation = "";
    try {
      CostLedger.openReadOnly({ path: absentPath });
    } catch (e) {
      code = (e as CostLedgerError).code;
      remediation = (e as CostLedgerError).remediation;
    }
    expect(code).toBe("ledger-absent");
    expect(remediation).toContain("never creates one");
    expect(existsSync(absentPath)).toBe(false);
    expect(existsSync(dirname(absentPath))).toBe(false);
    expect(existsSync(`${absentPath}-wal`)).toBe(false);
    expect(existsSync(`${absentPath}-shm`)).toBe(false);
  });

  test("AC6: a read-only open touches no byte — ledger/dir/-wal snapshots identical; -shm exclusion is deliberate", () => {
    seedOneBoxHoursRow();
    const wal = `${ledgerPath}-wal`;
    const shm = `${ledgerPath}-shm`;
    // The writer is still open, so live WAL state is on disk and must survive
    // a reader attaching beside it.
    expect(statSync(wal).size).toBeGreaterThan(0);
    const watched = [ledgerPath, dir, wal];
    const before = snapshotFiles(watched);

    const ro = CostLedger.openReadOnly({
      path: ledgerPath,
      readRunRecord: (runId) => RECORDS.get(runId),
      config: { defaultCapMicroUsd: 5_000_000, boxHourRateMicroUsd: 3_600_000 },
    });
    try {
      expect(ro.readRunCost("run-a1").eventCount).toBe(1);
      expect(ro.readIssueCost("qds/demo", "42").totalMicroUsd).toBe(ledger.readIssueCost("qds/demo", "42").totalMicroUsd);
      expect(ro.readIssueRuns("qds/demo", "42")).toEqual(ledger.readIssueRuns("qds/demo", "42"));
      expect(snapshotFiles(watched)).toEqual(before);
      // -shm is EXCLUDED from the snapshot on purpose: a readonly WAL reader
      // maps the shared-memory index SQLite itself recreates as needed, so its
      // mtime is reader traffic, not ledger state. What must hold is its
      // existence beside the open:
      expect(existsSync(shm)).toBe(true);

      // The read-only view equals the read-write view over the same rows, for
      // every read method the handle exposes.
      expect(ro.readRunCost("run-a1")).toEqual(ledger.readRunCost("run-a1"));
      expect(ro.readIssueCost("qds/demo", "42")).toEqual(ledger.readIssueCost("qds/demo", "42"));

      // Every write method refuses BEFORE any statement runs; row count is unchanged.
      const db = rawDb();
      try {
        const rowsBefore = rowCount(db, "cost_events");
        const refusals = [
          () => ro.ingestCostEvent(mkEvent(), mkCtx()),
          () => ro.ingestBoxHours(boxCtx),
          () => ro.admitIssue({ repoSlug: "qds/demo", issueId: "42", runId: "run-a1", requestId: "req-1" }, 5_000_000, 5_000_000),
        ];
        for (const attempt of refusals) {
          let code = "";
          let remediation = "";
          try {
            attempt();
          } catch (e) {
            code = (e as CostLedgerError).code;
            remediation = (e as CostLedgerError).remediation;
          }
          expect(code).toBe("ledger-readonly");
          expect(remediation).toContain("new CostLedger");
        }
        expect(rowCount(db, "cost_events")).toBe(rowsBefore);
      } finally {
        // A failing expect above must not strand this second connection.
        db.close();
      }
    } finally {
      ro.close();
    }
  });

  test("WAL ceiling: a non-empty -wal with no -shm refuses ledger-wal-recovery-required and the refused call changes no file", () => {
    seedOneBoxHoursRow(); // writer open ⇒ -wal holds committed frames
    const wal = `${ledgerPath}-wal`;
    const shm = `${ledgerPath}-shm`;
    expect(statSync(wal).size).toBeGreaterThan(0);
    // The crashed-writer shape, built honestly: the frames are real SQLite WAL
    // content this process committed; only the transient -shm index is removed.
    unlinkSync(shm);
    const fileSetBefore = readdirSync(dir).sort();
    expect(fileSetBefore).toContain("cost-ledger.db-wal");
    expect(fileSetBefore).not.toContain("cost-ledger.db-shm");
    // The refusal must also leave the ledger and its -wal byte-identical — the
    // AC6 snapshot, not merely the listing (a silent checkpoint would keep the
    // same names while draining the WAL the ceiling is refusing to miss).
    const watched = [ledgerPath, wal];
    const before = snapshotFiles(watched);

    let code = "";
    let message = "";
    let remediation = "";
    let failed: unknown;
    let healFailure: unknown;
    try {
      try {
        CostLedger.openReadOnly({ path: ledgerPath });
      } catch (e) {
        code = (e as CostLedgerError).code;
        message = (e as CostLedgerError).message;
        remediation = (e as CostLedgerError).remediation;
      }
      expect(code).toBe("ledger-wal-recovery-required");
      expect(message).toContain("un-checkpointed WAL");
      expect(remediation).toContain("never fall back to a read-write open");
      // The refusal itself must not have recovered, checkpointed, or created anything.
      expect(snapshotFiles(watched)).toEqual(before);
      expect(readdirSync(dir).sort()).toEqual(fileSetBefore);
    } catch (e) {
      failed = e; // rethrown after the finally — the healer must not swallow it
    } finally {
      // NO HEALER HERE, and the reason is the whole point of this block.
      //
      // It used to open a fresh `rawDb()` and `SELECT 1`, on the stated premise
      // that "any fresh db access recreates the -shm index". **That premise is
      // false**, and this test is precisely the world in which it is false: with
      // a non-empty WAL and its -shm unlinked, SQLite cannot recover the WAL
      // from ANY connection — every open fails `disk I/O error`. So the healer
      // did not restore anything; it threw, and since `healFailure` is rethrown
      // when the assertions pass, the healer WAS THE ONLY REASON THIS TEST
      // FAILED. Its assertions have always passed.
      //
      // Measured on clean `origin/dev`, 2026-09-20 (Bun 1.3.13): removing the
      // healer turns this file green at 151 pass / 0 fail, and `afterEach`'s
      // `ledger.close()` + `rmSync` cope with the -shm-less handle without a
      // secondary throw — the failure mode the healer was written to prevent
      // does not occur. Closing the stale writer first was also tried, and also
      // failed: nothing recovers this WAL, which is the product behaviour the
      // test exists to assert.
      //
      // `healFailure` is kept declared and rethrown below so that a future
      // cleanup step added here still cannot be swallowed. **It is UNREACHABLE
      // today** — the healer's catch was its only writer, so nothing assigns it
      // and both the `console.error` branch and the trailing rethrow are dead
      // as written. Kept deliberately as the guard rail for whatever replaces
      // the healer, and labelled so the next reader does not spend time working
      // out why a variable that is never set is being checked.
    }
    if (failed !== undefined) {
      if (healFailure !== undefined)
        console.error(`post-assertion WAL healer also failed (assertion failure reported below): ${String(healFailure)}`);
      throw failed;
    }
    if (healFailure !== undefined) throw healFailure;
  });

  test("a zero-byte -wal does NOT refuse — the checkpointed row still reads, and the open adds and removes no file", () => {
    seedOneBoxHoursRow();
    // Produce the zero-byte shape the way it occurs in the wild: SQLite's own
    // TRUNCATE checkpoint (a second connection) drains the -wal to zero bytes
    // in place. Zeroing it by hand under a live -shm index is a crashed shape,
    // not this one — bun does not checkpoint on close, so the committed row
    // would live ONLY in the -wal and truncating it destroys the data.
    const checkpoint = rawDb();
    try {
      checkpoint.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    } finally {
      checkpoint.close();
    }
    const wal = `${ledgerPath}-wal`;
    expect(statSync(wal).size).toBe(0); // the state under test, built by SQLite itself
    const listingBefore = readdirSync(dir).sort();
    const ro = CostLedger.openReadOnly({ path: ledgerPath });
    try {
      // Content, not a tautology: the row is in the main db file now, so
      // reading it through the empty -wal is a real query over real state.
      const view = ro.readRunCost("run-a1");
      expect(view.eventCount).toBe(1);
      expect(view.totalMicroUsd).toBe(5_400_000);
    } finally {
      ro.close();
    }
    // The open added and removed no file: the empty -wal is still the empty -wal.
    expect(readdirSync(dir).sort()).toEqual(listingBefore);
  });

  // Round-4 R4-19: the refusal ladder above pins absent / WAL-stuck / identity
  // / readonly, but not what a CORRUPT or wrong-typed ledger does. Both cases
  // observed and pinned (SQLite defers the header read, so where the refusal
  // lands is an observed contract, not an assumption).
  test("a ledger path holding garbage bytes types its refusal on the first read and mutates nothing", () => {
    ledger.close();
    // beforeEach's writer left live -wal/-shm siblings behind; the state under
    // test is a bare garbage file, so start from it.
    rmSync(`${ledgerPath}-wal`, { force: true });
    rmSync(`${ledgerPath}-shm`, { force: true });
    writeFileSync(ledgerPath, "definitely not a SQLite database");
    const before = snapshotFiles([ledgerPath]);
    // The probe and the attach both succeed on non-SQLite bytes (the header
    // read is deferred), so the handle OPENS — the refusal must land, typed,
    // on the first read rather than escaping as a raw driver error.
    const ro = CostLedger.openReadOnly({ path: ledgerPath });
    let code = "";
    let remediation = "";
    try {
      ro.readRunCost("run-a1");
    } catch (e) {
      code = (e as CostLedgerError).code;
      remediation = (e as CostLedgerError).remediation;
    } finally {
      ro.close();
    }
    expect(code).toBe("ledger-unqueryable");
    expect(remediation).toContain("repair or remove");
    // The refusal created no -wal/-shm siblings and left the garbage byte-identical.
    expect(snapshotFiles([ledgerPath])).toEqual(before);
    expect(existsSync(`${ledgerPath}-wal`)).toBe(false);
    expect(existsSync(`${ledgerPath}-shm`)).toBe(false);
  });

  test("a directory at the ledger path refuses ledger-unopenable and creates nothing", () => {
    ledger.close();
    rmSync(ledgerPath, { force: true });
    // Same reason as the garbage test above: the writer's siblings must not
    // masquerade as something this refused open created.
    rmSync(`${ledgerPath}-wal`, { force: true });
    rmSync(`${ledgerPath}-shm`, { force: true });
    mkdirSync(ledgerPath);
    let code = "";
    let remediation = "";
    try {
      CostLedger.openReadOnly({ path: ledgerPath });
    } catch (e) {
      code = (e as CostLedgerError).code;
      remediation = (e as CostLedgerError).remediation;
    }
    expect(code).toBe("ledger-unopenable");
    expect(remediation).toContain("if it is not a ledger");
    expect(existsSync(`${ledgerPath}-wal`)).toBe(false);
    expect(existsSync(`${ledgerPath}-shm`)).toBe(false);
  });

  test("identity seam: a moved inode at the path throws ledger-identity-changed, a stable one does not", () => {
    seedOneBoxHoursRow();
    ledger.close();
    const seam = CostLedger as unknown as { assertSameInode: (probedIno: number, path: string) => void };
    const ino = statSync(ledgerPath).ino;
    expect(() => seam.assertSameInode(ino, ledgerPath)).not.toThrow();
    // The pin, in two named steps BEFORE the code assertion (the shape
    // qds-cost.test.ts's seam test adopted): a seam that stopped throwing is
    // THIS test's own named failure here — the old throw-a-sentinel-inside-the-
    // same-try shape funneled a non-throwing call into the same catch and
    // failed the code assert as a confusing `undefined`.
    let thrown: unknown;
    let threw = false;
    try {
      seam.assertSameInode(ino + 999_999, ledgerPath);
    } catch (e) {
      threw = true;
      thrown = e;
    }
    expect(threw).toBeTrue();
    expect(thrown).toBeInstanceOf(CostLedgerError);
    expect((thrown as CostLedgerError).code).toBe("ledger-identity-changed");
    expect((thrown as CostLedgerError).message).toContain("changed between the open probe and the attach");

    // A vanished path is identity-changed by definition, not a raw stat error.
    let vanished: unknown;
    let vanishedThrew = false;
    try {
      seam.assertSameInode(ino, join(dir, "vanished.db"));
    } catch (e) {
      vanishedThrew = true;
      vanished = e;
    }
    expect(vanishedThrew).toBeTrue();
    // Typed, like its sibling arm above — a raw stat errno here would still
    // carry a coincidentally-matching code.
    expect(vanished).toBeInstanceOf(CostLedgerError);
    expect((vanished as CostLedgerError).code).toBe("ledger-identity-changed");
  });

  test("openReadOnly succeeds on both sides of an atomic replace — each call re-probes the inode at the path", () => {
    seedOneBoxHoursRow();
    ledger.close();
    const first = CostLedger.openReadOnly({ path: ledgerPath });
    const viewBefore = first.readRunCost("run-a1");
    // The FIRST handle stays OPEN across the replace: it is attached to the
    // pre-replace inode, so any probed identity a later open of the same path
    // carried over would be provably stale by the time it runs. (The held
    // handle itself is not read again after the swap — SQLite's readonly WAL
    // reader maps the -shm index beside the PATH, and a main file renamed
    // under a live connection answers "disk I/O error", which is the stale
    // handle's own business, not the re-probe's.)
    // Atomically replace the ledger with a byte-identical copy: same content,
    // NEW inode.
    const originalIno = statSync(ledgerPath).ino;
    const staged = join(dir, "staged.db");
    cpSync(ledgerPath, staged);
    renameSync(staged, ledgerPath);
    expect(statSync(ledgerPath).ino).not.toBe(originalIno);
    first.close();
    // The second open must re-probe the path AS IT IS: probed replacement inode
    // vs attached replacement inode. An implementation that reused the first
    // open's probe would compare old-vs-new and refuse
    // ledger-identity-changed; a fresh open working here is that refusal's
    // absence. (The deeper window — a replace landing between ONE open's probe
    // and its attach — is the C5 race, provable only at the assertSameInode
    // seam test above, which pins the refusal itself.)
    const ro = CostLedger.openReadOnly({ path: ledgerPath });
    try {
      expect(ro.readRunCost("run-a1")).toEqual(viewBefore);
    } finally {
      ro.close();
    }
  });

  // Round-4 R4-16: the seam test above proves the HELPER throws when called
  // by hand, and the atomic-replace test proves a FRESH open survives — but
  // neither proves openReadOnly still CALLS the check. Here the replace lands
  // inside one open's probe→attach window, injected through the class's own
  // static seam: the WAL probe runs after openSync (which pinned the probed
  // inode) and before the attach, so a wrapper around it is exactly where the
  // live rename strikes. Delete the identity check and this open SUCCEEDS —
  // the red this test exists to guarantee.
  test("openReadOnly ITSELF refuses ledger-identity-changed when the file is replaced inside its probe→attach window", () => {
    seedOneBoxHoursRow();
    ledger.close();
    const probedIno = statSync(ledgerPath).ino;
    const cls = CostLedger as unknown as { assertWalCheckpointed: (path: string) => void };
    const original = cls.assertWalCheckpointed;
    let swapped = false;
    cls.assertWalCheckpointed = (path: string): void => {
      original.call(CostLedger, path); // the real ceiling check, unchanged
      if (swapped) return; // only the FIRST probe sits inside the window
      swapped = true;
      // Atomic replace with a byte-identical copy: same content, NEW inode.
      const staged = join(dir, "staged-race.db");
      cpSync(ledgerPath, staged);
      renameSync(staged, ledgerPath);
    };
    try {
      let thrown: unknown;
      let threw = false;
      try {
        CostLedger.openReadOnly({ path: ledgerPath });
      } catch (e) {
        threw = true;
        thrown = e;
      }
      // The swap really fired inside the window — otherwise this proves nothing.
      expect(swapped).toBeTrue();
      expect(statSync(ledgerPath).ino).not.toBe(probedIno);
      expect(threw).toBeTrue();
      expect(thrown).toBeInstanceOf(CostLedgerError);
      expect((thrown as CostLedgerError).code).toBe("ledger-identity-changed");
    } finally {
      cls.assertWalCheckpointed = original;
    }
  });

  // P17 (review round 1): the write path's `ledger-unopenable` arm had no
  // DF2.11-block coverage, and the new fail-closed -wal-stat arm (P3) had none
  // anywhere portable. Both arms refuse before anything is read as zero spend.
  test.skipIf(IS_ROOT)("an owner-unreadable ledger refuses ledger-unopenable from the probe, never reading spend as zero", () => {
    seedOneBoxHoursRow(); // there IS spend on disk — the point is that it is refused, not zeroed
    chmodSync(ledgerPath, 0o000);
    try {
      let code = "";
      let remediation = "";
      try {
        CostLedger.openReadOnly({ path: ledgerPath });
      } catch (e) {
        code = (e as CostLedgerError).code;
        remediation = (e as CostLedgerError).remediation;
      }
      expect(code).toBe("ledger-unopenable");
      expect(remediation).toContain("fix the permissions");
    } finally {
      chmodSync(ledgerPath, 0o600);
    }
  });

  test.skipIf(IS_ROOT)("a readable ledger behind an unstat-able -wal refuses ledger-unopenable naming the -wal stat (P3 fail-closed arm)", () => {
    seedOneBoxHoursRow(); // committed frames sit behind the ceiling that cannot be measured
    const wal = `${ledgerPath}-wal`;
    // stat(2) needs no permission on the FILE itself, so a chmod cannot make
    // the -wal stat fail — the honest EACCES/ELOOP shape is a path that does
    // not resolve: a self-referential symlink. The writer's open fd keeps the
    // real -wal inode (and its frames) alive underneath.
    unlinkSync(wal);
    symlinkSync(wal, wal);
    try {
      let code = "";
      let message = "";
      try {
        CostLedger.openReadOnly({ path: ledgerPath });
      } catch (e) {
        code = (e as CostLedgerError).code;
        message = (e as CostLedgerError).message;
      }
      expect(code).toBe("ledger-unopenable");
      expect(message).toContain("cannot stat the -wal sibling");
    } finally {
      unlinkSync(wal); // drop the loop; the writer's fd owns the real -wal again
    }
  });

  // P15 (review round 1): the write-refusal contract cannot rest on a
  // hand-enumerated three-method list — a new write method would silently skip
  // the guard. Enumerate the prototype itself instead.
  test("every prototype method is either declared read-only/neutral or PROVEN to refuse ledger-readonly (write-refusal completeness)", () => {
    seedOneBoxHoursRow();
    const ro = CostLedger.openReadOnly({
      path: ledgerPath,
      config: { defaultCapMicroUsd: 5_000_000, boxHourRateMicroUsd: 3_600_000 },
    });
    try {
      // Derived from the current class surface: the SELECT-only views plus
      // `close` (which a read-only handle legitimately supports). `view`,
      // `assertQueryable`, `recordStructurallyAbsent` and `unqueryable` (the
      // shared refusal builder the reads rethrow through) are TS-private but
      // runtime-visible own prototype properties, so they belong here too —
      // a new read may only join after review.
      const READ_ONLY_OR_NEUTRAL = [
        "close",
        "readRunCost",
        "readIssueCost",
        "readIssueRuns",
        "emitTokenBridgeState",
        "issueBudgetSnapshot",
        "view",
        "assertQueryable",
        "unqueryable",
        "recordStructurallyAbsent",
      ];
      // Every method NOT on the read list must be proven to refuse — the
      // guard is each write method's first statement, so a no-arg call that
      // reports anything other than `ledger-readonly` fails here.
      // `releaseAdmission` (2026-09-18): the DF2.8 compensating release — a
      // write (it inserts into gate_admission_releases), so it refuses here
      // like every other one.
      const WRITES = [
        "ingestCostEvent",
        "ingestBoxHours",
        "admitIssue",
        "releaseAdmission",
        // Q1.2: the budget-group reservation and its compensating release —
        // both insert, so both refuse on a read-only handle like the rest.
        "reserveBudgetGroup",
        "releaseBudgetGroup",
      ];

      const methods = Object.getOwnPropertyNames(CostLedger.prototype).filter(
        (name) =>
          name !== "constructor" &&
          typeof (CostLedger.prototype as unknown as Record<string, unknown>)[name] === "function",
      );
      // Completeness: a method on NEITHER list fails outright, so adding one
      // forces a conscious edit to this test rather than a silent skip.
      expect([...methods].sort()).toEqual([...READ_ONLY_OR_NEUTRAL, ...WRITES].sort());
      // …and each declared write really refuses, before any statement runs.
      const target = ro as unknown as Record<string, () => unknown>;
      for (const name of WRITES) {
        let code = "";
        try {
          target[name]!(); // the completeness equality above just proved every name resolves
        } catch (e) {
          code = (e as CostLedgerError).code;
        }
        expect(code).toBe("ledger-readonly");
      }
    } finally {
      ro.close();
    }
  });
});

// ─── DF2.11 round 2: D3 (WAL-leading remediation) + D5 (warn-only mode) ──────

describe("DF2.11 read-path round 2 — D3 WAL-led remediation, D5 warn-only mode", () => {
  /**
   * Drop cost_events through a raw side handle — the honest way to make a
   * live ledger unqueryable, since the append-only triggers (INV-COST-1)
   * block nothing at the DDL layer and `assertQueryable`'s probe is exactly
   * the statement that then fails.
   */
  function dropCostEvents(): void {
    const db = rawDb();
    try {
      db.exec("DROP TABLE cost_events");
    } finally {
      db.close();
    }
  }

  function captureLogs(fn: () => void): Record<string, unknown>[] {
    const lines: Record<string, unknown>[] = [];
    const restore = setLogSink((e) => lines.push(e as unknown as Record<string, unknown>));
    try {
      fn();
    } finally {
      restore();
    }
    return lines;
  }

  test("D3: ledger-unqueryable beside a NON-EMPTY -wal leads its remediation with the checkpoint warning", () => {
    seedRecord("run-a1", { createdAt: "2026-08-20T12:00:00.000Z", closedAt: "2026-08-20T13:30:00.000Z" });
    ledger.ingestBoxHours({ runId: "run-a1", repoSlug: "qds/demo", issueId: "42", requestId: "req-1" });
    // Writer still open ⇒ live WAL frames on disk (the AC6 test pins this shape).
    expect(statSync(`${ledgerPath}-wal`).size).toBeGreaterThan(0);
    dropCostEvents();

    let code = "";
    let remediation = "";
    try {
      ledger.readIssueCost("qds/demo", "42");
    } catch (e) {
      code = (e as CostLedgerError).code;
      remediation = (e as CostLedgerError).remediation;
    }
    expect(code).toBe("ledger-unqueryable");
    // The warning LEADS — "repair or remove" must never be read first, while
    // the -wal beside the file may hold the only copy of committed spend.
    expect(remediation.startsWith("the ledger has an un-checkpointed -wal;")).toBe(true);
    expect(remediation).toContain("have any writer checkpoint it (a teardown close, or qds cost on its write path)");
    expect(remediation).toContain("never remove it");
    expect(remediation).toContain("repair or remove");
  });

  test("D3: ledger-unqueryable with NO -wal carries no checkpoint warning — nothing to protect", () => {
    ledger.close();
    dropCostEvents(); // the DROP itself writes WAL frames — empty them after
    // The checkpointed shape, crafted the way the zero-byte-WAL test above
    // crafts it: an EMPTY -wal holds no recoverable frames, so there is no
    // committed spend for the warning to protect. (bun:sqlite's close does
    // not reliably remove the file; emptiness is the state under test.)
    writeFileSync(`${ledgerPath}-wal`, "");
    expect(statSync(`${ledgerPath}-wal`).size).toBe(0);

    let code = "";
    let remediation = "";
    try {
      ledger.readIssueCost("qds/demo", "42");
    } catch (e) {
      code = (e as CostLedgerError).code;
      remediation = (e as CostLedgerError).remediation;
    }
    expect(code).toBe("ledger-unqueryable");
    expect(remediation).not.toContain("un-checkpointed -wal");
  });

  // Round-4 R4-8: round-3 C13 wrapped only the tokens probe, so a pre-`kind`
  // ledger — assertQueryable's LIMIT-1 passing happily on it — let the
  // roleRows CASE, the anyRow COUNT and readIssueRuns escape as raw driver
  // errors ("no such column: kind"). Hand-build that legacy layout and prove
  // every kind-reading read refuses typed.
  test("C13 completion: a pre-`kind` ledger types every kind-reading view failure ledger-unqueryable", () => {
    ledger.close();
    // The siblings go with the main file: a stale -wal replayed into the fresh
    // legacy db here would corrupt the very fixture this test builds (and a
    // leftover -shm would make bun's open negotiate a half-dead index).
    rmSync(`${ledgerPath}-wal`, { force: true });
    rmSync(`${ledgerPath}-shm`, { force: true });
    rmSync(ledgerPath, { force: true });
    const legacy = new Database(ledgerPath);
    try {
      legacy.exec(`CREATE TABLE cost_events (
        event_id TEXT PRIMARY KEY, run_id TEXT NOT NULL, repo_slug TEXT NOT NULL,
        issue_id TEXT NOT NULL, request_id TEXT NOT NULL, role TEXT,
        invocation_seq INTEGER NOT NULL, cost_micro_usd INTEGER NOT NULL,
        unpriced INTEGER NOT NULL, created_at TEXT NOT NULL
      )`);
      legacy
        .prepare(
          `INSERT INTO cost_events (event_id, run_id, repo_slug, issue_id, request_id, role, invocation_seq, cost_micro_usd, unpriced, created_at)
           VALUES ('e1','run-a1','qds/demo','42','req-1',NULL,0,5400000,0,'2026-08-20T13:30:00.000Z')`,
        )
        .run();
    } finally {
      legacy.close();
    }
    const ro = CostLedger.openReadOnly({ path: ledgerPath });
    try {
      for (const read of [
        () => ro.readRunCost("run-a1"),
        () => ro.readIssueCost("qds/demo", "42"),
        () => ro.readIssueRuns("qds/demo", "42"),
      ]) {
        let code = "";
        let remediation = "";
        try {
          read();
        } catch (e) {
          code = (e as CostLedgerError).code;
          remediation = (e as CostLedgerError).remediation;
        }
        expect(code).toBe("ledger-unqueryable");
        expect(remediation).toContain("repair or remove");
      }
    } finally {
      ro.close();
    }
  });

  test.skipIf(IS_ROOT)("D3: ledger-unopenable (probe arm, EACCES) beside a NON-EMPTY -wal leads with the checkpoint warning", () => {
    ledger.close();
    // A real non-empty -wal beside a real ledger: the frames here are bytes,
    // not necessarily SQLite frames — the note's trigger is the SIBLING'S
    // presence, and its job is to stop an rm, not to parse content.
    writeFileSync(`${ledgerPath}-wal`, "not-checkpointed-bytes");
    chmodSync(ledgerPath, 0o000); // probe's openSync(…, "r") now fails EACCES
    try {
      let code = "";
      let remediation = "";
      try {
        CostLedger.openReadOnly({ path: ledgerPath });
      } catch (e) {
        code = (e as CostLedgerError).code;
        remediation = (e as CostLedgerError).remediation;
      }
      expect(code).toBe("ledger-unopenable");
      expect(remediation.startsWith("the ledger has an un-checkpointed -wal;")).toBe(true);
      expect(remediation).toContain("never remove it");
      expect(remediation).toContain("fix the permissions on");
    } finally {
      chmodSync(ledgerPath, 0o600); // let afterEach rm the tree
    }
  });

  test.skipIf(IS_ROOT)("D3: ledger-unopenable (probe arm, EACCES) with NO -wal carries no warning", () => {
    ledger.close();
    // No -wal sibling at all: the state under test is the note's ABSENCE, and
    // absence of the file is exactly what the helper must treat as quiet.
    rmSync(`${ledgerPath}-wal`, { force: true });
    rmSync(`${ledgerPath}-shm`, { force: true });
    chmodSync(ledgerPath, 0o000);
    try {
      let code = "";
      let remediation = "";
      try {
        CostLedger.openReadOnly({ path: ledgerPath });
      } catch (e) {
        code = (e as CostLedgerError).code;
        remediation = (e as CostLedgerError).remediation;
      }
      expect(code).toBe("ledger-unopenable");
      expect(remediation).not.toContain("un-checkpointed -wal");
      expect(remediation).toContain("fix the permissions on");
    } finally {
      chmodSync(ledgerPath, 0o600);
    }
  });

  test("D5: a ledger file broader than 0600 emits ONE warn line, changes nothing, still opens", () => {
    seedRecord("run-a1", { createdAt: "2026-08-20T12:00:00.000Z", closedAt: "2026-08-20T13:30:00.000Z" });
    ledger.ingestBoxHours({ runId: "run-a1", repoSlug: "qds/demo", issueId: "42", requestId: "req-1" });
    const before = statSync(ledgerPath).mode & 0o777;
    expect(before).toBe(0o600); // the write path's own assert ran in beforeEach
    chmodSync(ledgerPath, 0o644); // group/other READ: broader than the posture
    try {
      const lines = captureLogs(() => {
        const ro = CostLedger.openReadOnly({ path: ledgerPath });
        try {
          expect(ro.readRunCost("run-a1").eventCount).toBe(1);
        } finally {
          ro.close();
        }
      });
      const warns = lines.filter((l) => l.code === "ledger-mode-broad");
      expect(warns).toHaveLength(1);
      // Round-4 R4-24: the warn rides the contract's own operation name, so
      // alert keys keyed on `cost-ledger.open` see it beside the line it
      // annotates (mode is already a field).
      expect(warns[0]?.operation).toBe("cost-ledger.open");
      expect(warns[0]?.ledgerPath).toBe(ledgerPath);
      expect(warns[0]?.mode).toBe(0o644);
      // The message names the POSTURE the mode is broader than ("0600") — a
      // bare digit-0 probe matched the tmpdir path and proved nothing.
      expect(String(warns[0]?.message)).toContain("0600");
      // WARN-ONLY: the read path neither repaired the mode nor threw.
      expect(statSync(ledgerPath).mode & 0o777).toBe(0o644);
    } finally {
      chmodSync(ledgerPath, 0o600);
    }
  });

  test("D5: a compliant 0600 ledger emits no mode warn at all", () => {
    seedRecord("run-a1", { createdAt: "2026-08-20T12:00:00.000Z", closedAt: "2026-08-20T13:30:00.000Z" });
    ledger.ingestBoxHours({ runId: "run-a1", repoSlug: "qds/demo", issueId: "42", requestId: "req-1" });
    const lines = captureLogs(() => {
      const ro = CostLedger.openReadOnly({ path: ledgerPath });
      try {
        ro.readRunCost("run-a1");
      } finally {
        ro.close();
      }
    });
    expect(lines.some((l) => l.code === "ledger-mode-broad")).toBe(false);
  });

  test("D5: a ledger DIR broader than 0700 is named too, and stays unrepaired", () => {
    seedRecord("run-a1", { createdAt: "2026-08-20T12:00:00.000Z", closedAt: "2026-08-20T13:30:00.000Z" });
    ledger.ingestBoxHours({ runId: "run-a1", repoSlug: "qds/demo", issueId: "42", requestId: "req-1" });
    chmodSync(dir, 0o755);
    try {
      const lines = captureLogs(() => {
        const ro = CostLedger.openReadOnly({ path: ledgerPath });
        try {
          ro.readRunCost("run-a1");
        } finally {
          ro.close();
        }
      });
      const dirWarns = lines.filter((l) => l.code === "ledger-mode-broad" && l.ledgerPath === dir);
      expect(dirWarns).toHaveLength(1);
      expect(dirWarns[0]?.mode).toBe(0o755);
      expect(statSync(dir).mode & 0o777).toBe(0o755); // warn-only, still
    } finally {
      chmodSync(dir, 0o700);
    }
  });
});

// ─── DF2.12: the token bridge is live — ledger-side contracts ────────────────

describe("DF2.12 ledger-side contracts", () => {
  /**
   * emitTokenBridgeState, reclassified (AC6): the bridge it used to announce
   * as unbuilt is live (cost-ledger-bridge.ts), so the line no longer reports
   * a permanent wiring gap — it names the live condition of a ZERO-token-row
   * ledger: nothing delivered yet (runs open, genuinely spendless runs) or a
   * bridge/harvest regression, which is the broken-bridge tripwire it is kept
   * for. The read-only behaviour DF2.11's openReadOnly path depends on is
   * unchanged (probe + boolean + guarded emit).
   */
  test("emitTokenBridgeState on a zero-token-row ledger names the live bridge and its evidence path", () => {
    seedRecord("run-a1", { createdAt: "2026-09-10T10:00:00Z", closedAt: "2026-09-10T10:30:00Z" });
    ledger.ingestBoxHours({ runId: "run-a1", repoSlug: "qds/demo", issueId: "42", requestId: "req-1" });
    const lines: Record<string, unknown>[] = [];
    const restore = setLogSink((e) => lines.push(e as unknown as Record<string, unknown>)); // dp:ok widens THIS test's own captured sink events
    try {
      expect(ledger.emitTokenBridgeState()).toBe(true);
    } finally {
      restore();
    }
    const line = lines.find((l) => l.code === "tokens-ledger-unwired") as Record<string, unknown> | undefined;
    expect(line).toBeDefined();
    const message = String(line?.message);
    // The live condition, not the old unbuilt claim — and where to look.
    expect(message).toContain("cost-ledger-bridge.ts");
    expect(message).toContain("pricing box hours only until a token row lands");
    expect(message).toContain("engine.log");
    expect(line?.outcome).toBe("token-bridge-unwired");
  });

  test("emitTokenBridgeState is silent once any token row exists anywhere — unchanged read-only contract", () => {
    seedRecord("run-a1");
    ledger.ingestCostEvent(mkEvent(), mkCtx());
    const lines: Record<string, unknown>[] = [];
    const restore = setLogSink((e) => lines.push(e as unknown as Record<string, unknown>)); // dp:ok widens THIS test's own captured sink events
    try {
      expect(ledger.emitTokenBridgeState()).toBe(false);
    } finally {
      restore();
    }
    expect(lines.some((l) => l.code === "tokens-ledger-unwired")).toBe(false);
  });

  // ── Contract pin (DoD): the bridge is a CALLER, never a schema change ──────

  test("cost_events keeps DF2.8's exact column set — DF5.3/DF5.4 read the same shape", () => {
    const db = rawDb();
    try {
      const cols = (db.prepare("PRAGMA table_info(cost_events)").all() as { name: string }[]).map((c) => c.name);
      expect(cols).toEqual([
        "event_id",
        "run_id",
        "repo_slug",
        "issue_id",
        "request_id",
        "role",
        "agent_id",
        "provider",
        "model",
        "kind",
        "invocation_seq",
        "input_tokens",
        "output_tokens",
        "cache_read_tokens",
        "cache_write_tokens",
        "turn_count",
        "cost_micro_usd",
        "unpriced",
        "key_hash",
        "key_limit_micro_usd",
        "created_at",
      ]);
    } finally {
      db.close();
    }
  });

  test("the model column is bound from the event (DF2.12 — the column existed, no caller ever filled it)", () => {
    seedRecord("run-a1");
    ledger.ingestCostEvent(mkEvent(), mkCtx());
    // The resident leg's line carries model "" (its wire has no model) — binds
    // as the empty string, never invented into a slug.
    ledger.ingestCostEvent(mkEvent({ model: "", agentId: "resident" }), mkCtx({ role: "resident", invocationSeq: 1 }));
    const db = rawDb();
    try {
      const rows = db
        .prepare("SELECT agent_id, model FROM cost_events WHERE run_id = 'run-a1' ORDER BY invocation_seq")
        .all() as { agent_id: string; model: string }[];
      expect(rows).toEqual([
        { agent_id: "lead-1", model: "cheap/model" },
        { agent_id: "resident", model: "" },
      ]);
    } finally {
      db.close();
    }
    // Re-ingest is still a no-op: model is NOT an event_id digest input, so
    // binding it changed no idempotency surface.
    const replay = ledger.ingestCostEvent(mkEvent(), mkCtx());
    expect(replay.inserted).toBe(false);
  });

  // ── The µ$ ↔ USD seam (DoD): a PROPERTY test across the money range ────────
  //
  // The bridge converts integer µ$ → float USD once (costUsd = µ$ / 1e6) and
  // usdToMicros converts back (round(µ$ / 1e6 × 1e6)). The boundary alone
  // proves nothing: the values that could expose an error are mid-range ones
  // whose /1e6 lands on a representation tie. So: ≥10,000 deterministic
  // pseudo-random integers spanning 1 … 2^50, driven through the PUBLIC seam
  // (ingestCostEvent is the only writer and usdToMicros is module-private —
  // the round trip through the real ingest is the round trip production
  // takes), every stored row read back and compared exactly.
  //
  // FINDING (dev-recorded, 2026-09-10): the story's "exact for every integer
  // µ$ value the ledger accepts" is TRUE only below ~2^51. Above that, µ$/1e6
  // ×1e6 can land on a float half-tie (ulp of the ~4.3e9 intermediate reaches
  // 0.5 µ$) and Math.round resolves it upward — the pinned test below shows
  // 4300036924212877 µ$ storing as …878, a drift of ONE µ$. That is ~$4.5
  // quadrillion of token spend — five orders of magnitude past any real run —
  // idempotency is unaffected (the same float re-harvest digests identically),
  // and the fix (an exact decimal conversion in usdToMicros) belongs to
  // cost-ledger.ts, which this story takes prose-only. Recorded, not hidden.
  test("µ$ round trip: 10,000 deterministic values across the money range [1, 2^50] come back bit-exact", () => {
    seedRecord("run-prop");
    const MAX = 2 ** 50; // empirically clean: dense sampling shows zero drift ≤ 2^50 (drift begins in (2^50, 2^51))
    const N = 10_000;
    // Fixed-stride sweep PLUS a seeded LCG (no Math.random): the stride walks
    // every magnitude band deterministically, the LCG hits arbitrary values,
    // including the /1e6 representation ties a stride misses.
    const expected = new Map<string, number>();
    const ingest = (micros: number, agentId: string): void => {
      ledger.ingestCostEvent(
        mkEvent({ agentId, costUsd: micros / 1e6, timestamp: "2026-09-10T12:00:00.000Z" }),
        mkCtx({ runId: "run-prop", role: "worker" }),
      );
      expected.set(agentId, micros);
    };
    let i = 0;
    for (let micros = 1n; micros <= BigInt(MAX); micros += BigInt(MAX) / BigInt(N / 2)) {
      ingest(Number(micros), `stride-${i++}`);
    }
    let state = 0x2f6e2b1n;
    for (let j = 0; j < N / 2; j++) {
      state = (state * 6364136223846793005n + 1442695040888963407n) & 0xffffffffffffffffn;
      const micros = 1n + ((state >> 11n) % BigInt(MAX - 1));
      ingest(Number(micros), `lcg-${j}`);
    }
    expect(expected.size).toBeGreaterThanOrEqual(N);

    const db = rawDb();
    try {
      const rows = db
        .prepare("SELECT agent_id, cost_micro_usd, unpriced FROM cost_events WHERE agent_id LIKE '%-%'")
        .all() as { agent_id: string; cost_micro_usd: number; unpriced: number }[];
      expect(rows.length).toBe(expected.size);
      for (const row of rows) {
        const want = expected.get(row.agent_id);
        expect(want).toBeDefined();
        expect(row.unpriced).toBe(0);
        expect(row.cost_micro_usd).toBe(want as number); // bit-exact: the float seam lost nothing
      }
    } finally {
      db.close();
    }
  }, 60_000);

  test("the seam's edges: 2^53−1 µ$ is refused to unpriced (never a wrong value); a half-tie above 2^51 drifts exactly 1 µ$ — pinned, not hidden", () => {
    seedRecord("run-bnd");
    // (2^53−1)/1e6 × 1e6 rounds to 2^53 — NOT a safe integer — and usdToMicros
    // refuses. The refusal joins AC4's unpriced class (row at 0, flagged,
    // counted), so the refusal is visible and nothing is dropped or mispriced.
    ledger.ingestCostEvent(
      mkEvent({ agentId: "bnd-outside", costUsd: (2 ** 53 - 1) / 1e6, timestamp: "2026-09-10T12:00:01.000Z" }),
      mkCtx({ runId: "run-bnd", role: "worker" }),
    );
    // The half-tie drift, one concrete instance of the FINDING above: the
    // product lands on .5 and half-up rounding moves it one µ$ off the line's
    // integer. Drift magnitude is 1 µ$ at ~$4.3 quadrillion of spend.
    ledger.ingestCostEvent(
      mkEvent({ agentId: "bnd-halftie", costUsd: 4300036924212877 / 1e6, timestamp: "2026-09-10T12:00:02.000Z" }),
      mkCtx({ runId: "run-bnd", role: "worker", invocationSeq: 1 }),
    );
    const db = rawDb();
    try {
      const rows = db
        .prepare("SELECT agent_id, cost_micro_usd, unpriced FROM cost_events ORDER BY agent_id")
        .all() as { agent_id: string; cost_micro_usd: number; unpriced: number }[];
      expect(rows).toHaveLength(2);
      expect(rows[0]).toMatchObject({ agent_id: "bnd-halftie", cost_micro_usd: 4300036924212878, unpriced: 0 });
      expect(rows[1]).toMatchObject({ agent_id: "bnd-outside", cost_micro_usd: 0, unpriced: 1 });
    } finally {
      db.close();
    }
  });

  // ── The D4 tripwire quantity (AC3): derivable, never enforced ──────────────
  //
  // per-run resident share = perRole.resident / (totalMicroUsd − box-hours),
  // and the p50 across runs by ONE query over cost_events, from REAL ingested
  // rows. No fifteen-percent constant exists anywhere — fact 12 forbids
  // writing the ratio into an AC, and this query writes no threshold either.

  test("resident share per run, p50 across runs by a single query — from real ingested rows", () => {
    const runs = ["run-share-1", "run-share-2", "run-share-3"];
    const shares = [0.1, 0.5, 0.9]; // resident share of token spend per run (unitless ratios, not thresholds)
    for (let r = 0; r < runs.length; r++) {
      const runId = runs[r] as string;
      seedRecord(runId, { createdAt: "2026-09-10T10:00:00Z", closedAt: "2026-09-10T10:30:00Z" });
      const tokenMicros = 10_000_000; // $10 of token spend — must exceed the box-hours row for the share denominator
      const residentMicros = Math.round(tokenMicros * (shares[r] as number));
      ledger.ingestCostEvent(
        mkEvent({ agentId: "lead", costUsd: (tokenMicros - residentMicros) / 1e6, timestamp: "2026-09-10T10:05:00Z" }),
        mkCtx({ runId, role: "lead" }),
      );
      ledger.ingestCostEvent(
        mkEvent({ agentId: "resident", costUsd: residentMicros / 1e6, timestamp: "2026-09-10T10:06:00Z" }),
        mkCtx({ runId, role: "resident", invocationSeq: 1 }),
      );
      ledger.ingestBoxHours({ runId, repoSlug: "qds/demo", issueId: "42", requestId: "req-share" });
    }

    // PR #253 review: the handle is HELD, not inlined — the extra SQLite
    // connection is released even when the query or an assertion throws.
    const db = rawDb();
    let p50: number;
    try {
      p50 = Number(
        (
          db
            .prepare(
              `WITH per_run AS (
                 SELECT run_id,
                   SUM(CASE WHEN unpriced = 0 AND kind = 'tokens' THEN cost_micro_usd ELSE 0 END) AS token_micro,
                   SUM(CASE WHEN unpriced = 0 AND kind = 'box_hours' THEN cost_micro_usd ELSE 0 END) AS box_micro,
                   SUM(CASE WHEN unpriced = 0 AND role = 'resident' THEN cost_micro_usd ELSE 0 END) AS resident_micro
                 FROM cost_events GROUP BY run_id
               ), shares AS (
                 SELECT run_id, resident_micro * 1.0 / (token_micro - box_micro) AS share
                 FROM per_run WHERE (token_micro - box_micro) > 0
               )
               SELECT share FROM shares ORDER BY share
               LIMIT 1 OFFSET (SELECT (COUNT(*) - 1) / 2 FROM shares)`,
            )
            .get() as { share: number }
        ).share,
      );
    } finally {
      db.close();
    }
    // The AC formula's denominator: totalMicroUsd − box-hours = 10M − 1.8M
    // per run, so the median share is (0.5 × 10M) / 8.2M.
    expect(p50).toBeCloseTo(5_000_000 / 8_200_000, 12);
  });

  test("a run whose resident spent but whose rows are lead/worker only reads share 0 — the false green, made visible", () => {
    seedRecord("run-nores");
    ledger.ingestCostEvent(
      mkEvent({ agentId: "lead", costUsd: 0.05, timestamp: "2026-09-10T10:05:00Z" }),
      mkCtx({ runId: "run-nores", role: "lead" }),
    );
    const view = ledger.readRunCost("run-nores");
    // The quantity is computable and honestly 0 — which is exactly why the
    // BRIDGE must land the resident's rows: a dropped resident line is a
    // resident share of 0 on a run that paid one (pinned from the log side in
    // tests/providers/cost-ledger-bridge.test.ts).
    expect(view?.perRole.resident).toBeUndefined();
    expect(view?.perRole.lead).toBe(50_000);
  });

  // ── AC6 prose retirement: the grep must prove it read the files ────────────

  test("no shipped string still claims the bridge is unbuilt — zero-match sweep PAIRED with a positive control", () => {
    const repoRoot = resolve(import.meta.dir, "..", "..");
    // BRG-T6: `-E` with plain `|` alternation. The old BRE `\|` alternation
    // is a GNU extension — macOS BSD grep reads `\|` as a literal pipe, so
    // the sweep compiled to a never-matching literal string and PASSED
    // vacuously on every zero. Both sweeps and the control below go through
    // the same `-E` mechanism so a degenerate pattern compile cannot pass
    // silently.
    const grep = (pattern: string): string[] => {
      const res = spawnSync("grep", ["-rnE", pattern, "src", "scripts", "tests", "--include=*.ts"], {
        cwd: repoRoot,
        encoding: "utf8",
      });
      return res.stdout.split("\n").filter((l) => l.trim() !== "");
    };
    // POSITIVE CONTROL, same file set and same -E mechanism: a real needle
    // alternated with a guaranteed-non-match. A grep that silently read
    // nothing (binary misclassification, wrong cwd) — or an -E parse that
    // degraded the alternation — would otherwise report a clean zero and
    // prove nothing: the control failing reads as UNPROVEN, never clean.
    const control = grep("cost_attribution|zzq-ac6-never-matches");
    expect(control.length).toBeGreaterThan(0);
    expect(control.some((l) => l.startsWith("src/providers/cost-ledger-bridge.ts"))).toBe(true);
    expect(control.some((l) => l.startsWith("src/phase-engine/phases/dispatch-task.ts"))).toBe(true);

    // The AC6 sweep. Matches inside THIS test are excluded — the sweep's own
    // pattern literal is the one string in the tree that must be allowed to
    // contain the patterns it sweeps for.
    const stale = grep("no production caller|nothing calls .ingestCostEvent|F001").filter((l) =>
      !l.startsWith("tests/providers/cost-ledger.test.ts"),
    );
    if (stale.length > 0) {
      throw new Error(
        `AC6 prose retirement FAILED — ${stale.length} shipped line(s) still describe the bridge as unbuilt:\n${stale.join("\n")}`,
      );
    }
    expect(stale).toHaveLength(0);

    // Fact 12's own grep: no fifteen-percent ratio constant anywhere (D4
    // stays decidable, never enforced — enforcement is DF3.6a's ceiling).
    // The test's own comments are excluded for the same self-reference reason
    // as the sweep above.
    const ratio = grep("15%").filter((l) => !l.startsWith("tests/providers/cost-ledger.test.ts"));
    expect(ratio).toHaveLength(0);
  });
});

// ─── #380 — headless work keys (the `w:` namespace) ──────────────────────────

/**
 * Q1.7 legitimately resolves headless briefs (`workId`, no issue), but
 * `assertCanonicalIdentity` refused every non-numeric identity — so a headless
 * dispatch provisioned and THEN refused at admission ($0 spent, #380). The fix
 * is a SANCTIONED work-key namespace, `w:<workId>`, that `perIssueOverrides`
 * keys can spell (`owner/repo#w:<id>`): the fail-closed invariant "every
 * bookable identity is spellable in config" is preserved by EXTENDING the
 * spellable grammar, never by loosening the refusal.
 *
 * These tests run the REAL ledger arithmetic on a real (tmp) sqlite file —
 * recording/fake ledgers hid this bug for months (a permissive reserve never
 * exercises the admission identity at all).
 */
describe("#380 — headless work keys (the `w:` namespace)", () => {
  const WORK = "w:sc26-handprobe";

  test("a w:-prefixed identity ADMITS on its own bucket — headless dispatch books spend", () => {
    seedRecord("run-w1");
    const d = ledger.admitIssue(
      { repoSlug: "qds/demo", issueId: WORK, runId: "run-w1", requestId: "req-w1" },
      5_000_000,
      50_000_000,
    );
    if (!d.admitted) throw new Error(`expected admission, got ${JSON.stringify(d)}`);
    expect(d.admittedCeilingMicroUsd).toBe(5_000_000);
  });

  test("a perIssueOverrides WORK KEY addresses the work identity — the cap is operator-reachable", () => {
    const cfg = {
      defaultCapMicroUsd: 5_000_000,
      perIssueOverrides: { "qds/demo#w:sc26-handprobe": 1_000_000 },
    };
    expect(capForIssue(cfg, "qds/demo", WORK)).toBe(1_000_000);
    // The numeric namespace is untouched by the work key.
    expect(capForIssue(cfg, "qds/demo", "42")).toBe(5_000_000);
  });

  test("the override CAP is ENFORCED, not merely spelled — spend past a lowered work cap refuses", () => {
    const workCfg = {
      defaultCapMicroUsd: 5_000_000,
      perIssueOverrides: { "qds/demo#w:sc26-handprobe": 1_000_000 },
    };
    const workLedger = new CostLedger({
      path: join(dir, "work-cap.db"),
      readRunRecord: (id) => RECORDS.get(id),
      config: workCfg,
    });
    try {
      seedRecord("run-w2");
      const cap = capForIssue(workCfg, "qds/demo", WORK);
      workLedger.ingestCostEvent(mkEvent({ costUsd: 1.5 }), mkCtx({ runId: "run-w2", requestId: "req-w2", issueId: WORK }));
      const d = workLedger.admitIssue(
        { repoSlug: "qds/demo", issueId: WORK, runId: "run-w2b", requestId: "req-w2b" },
        cap,
        50_000_000,
      );
      if (d.admitted) throw new Error("expected the lowered work cap to refuse");
      expect(d.reason).toBe("spend-cap-exceeded");
      expect(d.capMicroUsd).toBe(1_000_000);
      expect(d.spentMicroUsd).toBe(1_500_000);
    } finally {
      workLedger.close();
    }
  });

  test("two work ids and the numeric issue are THREE distinct buckets — no reservation bleeds", () => {
    seedRecord("run-w3");
    seedRecord("run-w4");
    seedRecord("run-w5");
    const cap = 5_000_000;
    const a = ledger.admitIssue({ repoSlug: "qds/demo", issueId: "w:build-docs", runId: "run-w3", requestId: "req-w3" }, cap, 50_000_000);
    const b = ledger.admitIssue({ repoSlug: "qds/demo", issueId: "w:other-work", runId: "run-w4", requestId: "req-w4" }, cap, 50_000_000);
    const c = ledger.admitIssue({ repoSlug: "qds/demo", issueId: "42", runId: "run-w5", requestId: "req-w5" }, cap, 50_000_000);
    expect(a.admitted).toBe(true);
    expect(b.admitted).toBe(true);
    expect(c.admitted).toBe(true);
  });

  // (`w:.` is deliberately ABSENT from the refusal table: the upstream
  // WORK_ID_PATTERN admits a bare "." as a workId — a first-char laxness that
  // predates #380 — and this grammar mirrors correlation's charset verbatim
  // rather than inventing a second, stricter one.)
  test.each(["sc26-handprobe", "w:", "w:SC26", "w:a b", "w:a#b"])(
    "an unsanctioned identity spelling refuses at the door (%s) — fail-closed kept",
    (bad) => {
      seedRecord("run-wx");
      expect(() =>
        ledger.admitIssue({ repoSlug: "qds/demo", issueId: bad, runId: "run-wx", requestId: "req-wx" }, 5_000_000, 50_000_000),
      ).toThrow(CostLedgerError);
    },
  );

  test("box-hours book a w: identity end to end (the teardown attribution path)", () => {
    seedRecord("run-w6", { createdAt: "2026-08-20T12:00:00.000Z", closedAt: "2026-08-20T12:30:00.000Z" });
    const res = ledger.ingestBoxHours({ runId: "run-w6", repoSlug: "qds/demo", issueId: WORK, requestId: "req-w6" });
    expect(res.inserted).toBe(true);
    // The same identity the admission refused pre-#380 now prices its box-hours…
    const view = ledger.issueBudgetSnapshot("qds/demo", WORK);
    expect(view.spentMicroUsd).toBe(1_800_000); // 0.5h × 3.6M µ$/h
    // …and an override addressed to the work key LOWERs the ceiling the next
    // dispatch is judged against (the invariant the refusal used to protect).
    const cfg = { defaultCapMicroUsd: 5_000_000, perIssueOverrides: { "qds/demo#w:sc26-handprobe": 1_000_000 } };
    expect(capForIssue(cfg, "qds/demo", WORK)).toBe(1_000_000);
  });

  test("loadCostConfig accepts the work-key spelling beside the numeric one; uppercase after w: refuses", () => {
    const file = join(dir, "work-keys.json");
    writeFileSync(
      file,
      JSON.stringify({
        defaultCapMicroUsd: 5_000_000,
        perIssueOverrides: { "qds/demo#42": 2_000_000, "qds/demo#w:sc26-handprobe": 1_000_000 },
      }),
    );
    const loaded = loadCostConfig(file);
    expect(loaded.config.perIssueOverrides?.["qds/demo#w:sc26-handprobe"]).toBe(1_000_000);

    const bad = join(dir, "bad-work.json");
    writeFileSync(bad, JSON.stringify({ defaultCapMicroUsd: 1, perIssueOverrides: { "qds/demo#w:SC26": 1 } }));
    expect(() => loadCostConfig(bad)).toThrow(CostConfigError);
  });

  test("the slug-case duplication guard covers work keys too", () => {
    const file = join(dir, "dup-work.json");
    writeFileSync(
      file,
      JSON.stringify({ defaultCapMicroUsd: 1, perIssueOverrides: { "QDS/Demo#w:x": 2, "qds/demo#w:x": 1 } }),
    );
    expect(() => loadCostConfig(file)).toThrow(CostConfigError);
  });
});

// f30f1339 follow-up (CodeRabbit #439): the ledger grammars mirror correlation's
// charset — `:` joined the brief-side grammar, so the mirror takes it the same
// commit. The A2 hunter-pack's contract workId `w:qa-<stamp>-<lens>` must be
// admittable end to end (identity → budget admission), not refused after the
// brief already validated.
describe("the `:` tail-charset join (CodeRabbit #439 mirror)", () => {
	test("a colon-bearing w: identity admits and prices (the A2 contract shape)", () => {
		const id = "w:qa-20261017t021348z-correctness"; // folded case, as correlation mints it
		seedRecord("run-colon");
		expect(() =>
			ledger.admitIssue({ repoSlug: "qds/demo", issueId: id, runId: "run-colon", requestId: "req-colon" }, 5_000_000, 50_000_000),
		).not.toThrow();
		expect(ledger.issueBudgetSnapshot("qds/demo", id)).toBeDefined();
	});

	test("a colon-bearing override KEY loads (config side of the mirror)", () => {
		const file = join(dir, "cost-config-colon.json");
		writeFileSync(file, JSON.stringify({ defaultCapMicroUsd: 5_000_000, perIssueOverrides: { "qds/demo#w:qa-20261017t021348z-correctness": 9_000_000 } }));
		const { config } = loadCostConfig(file);
		expect(capForIssue(config, "qds/demo", "w:qa-20261017t021348z-correctness")).toBe(9_000_000);
	});
});
