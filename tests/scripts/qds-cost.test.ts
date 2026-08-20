/**
 * TDD tests for `scripts/qds-cost.ts` (DF2.8 AC2, AC5).
 *
 * CLI contract: `bun scripts/qds-cost.ts <owner/repo>#<N>` — exactly one
 * positional matching `/^[\w.-]+\/[\w.-]+#\d+$/`. Bare issue numbers,
 * `#42`, `demo#42` (no owner), or empty argv are all rejected with
 * `cost-ref-invalid` and exit 2.
 *
 * The view derives everything from SUM, no denormalized columns:
 * - total µ$ + $ representation (two-tier rule: >= 1 → 2dp, < 1 → 4dp)
 * - per-role split (lead/worker/resident/tier1 + literal `box-hours` line)
 * - per-run table (RUN | SPEND µ$ | BOX HOURS — `pending` when hasBoxHours false)
 * - token totals (inputTokens/outputTokens) with thousands separators
 * - cache totals (cacheReadTokens/cacheWriteTokens) with thousands separators
 * - unpriced count line
 * - Zero-row issue: prints 0 µ$, empty split, "no ledger rows for this issue", exit 0
 *
 * Ledger errors (unopenable/dir-mode/file-mode) exit 1 with code + remediation.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

import { CostLedger } from "../../src/providers/cost-ledger.ts";
import type { CostEvent } from "../../cli-anything/src/types.ts";

const CLI = join(process.cwd(), "scripts", "qds-cost.ts");

let dir: string;
let prevEnv: string | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "qds-cost-"));
  prevEnv = process.env.QDS_COST_LEDGER_FILE;
  process.env.QDS_COST_LEDGER_FILE = join(dir, "cost-ledger.db");
});

afterEach(() => {
  if (prevEnv === undefined) process.env.QDS_COST_LEDGER_FILE = undefined;
  else process.env.QDS_COST_LEDGER_FILE = prevEnv;
  rmSync(dir, { recursive: true, force: true });
});

describe("qds-cost CLI", () => {
  describe("argument validation", () => {
    test("bare issue number `42` → exit 2, cost-ref-invalid", () => {
      const res = spawnSync(CLI, ["42"], { env: process.env });
      expect(res.status).toBe(2);
      expect(res.stdout.toString()).toContain("cost-ref-invalid");
      expect(res.stdout.toString()).toContain("next:");
    });

    test("`#42` (no repo slug) → exit 2, cost-ref-invalid", () => {
      const res = spawnSync(CLI, ["#42"], { env: process.env });
      expect(res.status).toBe(2);
      expect(res.stdout.toString()).toContain("cost-ref-invalid");
    });

    test("`demo#42` (no owner) → exit 2, cost-ref-invalid", () => {
      const res = spawnSync(CLI, ["demo#42"], { env: process.env });
      expect(res.status).toBe(2);
      expect(res.stdout.toString()).toContain("cost-ref-invalid");
    });

    test("empty argv → exit 2, cost-ref-invalid", () => {
      const res = spawnSync(CLI, [], { env: process.env });
      expect(res.status).toBe(2);
      expect(res.stdout.toString()).toContain("cost-ref-invalid");
    });

    test("valid ref `qds/demo#42` with zero rows → exit 0, prints 0 µ$, no-rows line", () => {
      // Fresh ledger has no rows
      const res = spawnSync(CLI, ["qds/demo#42"], { env: process.env });
      expect(res.status).toBe(0);
      const out = res.stdout.toString();
      expect(out).toContain("0");
      expect(out).toContain("no ledger rows for this issue");
    });
  });

  describe("full view with lead+worker+box-hours", () => {
    test("complete run: lead + worker tokens + closed box-hours → total, per-role, per-run table, token/cache totals", () => {
      const runId = "test-run-001";
      const repoSlug = "qds/demo";
      const issueId = "42";
      const requestId = "req-001";

      // Stub run record with 90min lifetime (2h box hours = 7,200,000 µ$)
      const stubRecord = {
        keyHash: "hash-abc123",
        limitMicroUsd: 50_000_000,
        createdAt: "2026-08-20T10:00:00Z",
        closedAt: "2026-08-20T11:30:00Z",
      };

      const ledger = new CostLedger({
        path: join(dir, "cost-ledger.db"),
        config: { defaultCapMicroUsd: 5_000_000, boxHourRateMicroUsd: 3_600_000 },
        readRunRecord: () => stubRecord,
      });

      // Lead agent: 1000 input, 2000 output, 100 cache read, 50 cache write, $0.10
      const leadEvent: CostEvent = {
        agentId: "lead-agent",
        model: "cheap/model",
        durationMs: 0,
        inputTokens: 1000,
        outputTokens: 2000,
        cacheReadTokens: 100,
        cacheWriteTokens: 50,
        turnCount: 5,
        costUsd: 0.1,
        timestamp: "2026-08-20T10:05:00Z",
      };
      ledger.ingestCostEvent(leadEvent, {
        runId,
        repoSlug,
        issueId,
        requestId,
        role: "lead",
        invocationSeq: 0,
      });

      // Worker agent: 500 input, 1000 output, 0 cache, $0.05
      const workerEvent: CostEvent = {
        agentId: "worker-001",
        model: "cheap/model",
        durationMs: 0,
        inputTokens: 500,
        outputTokens: 1000,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        turnCount: 3,
        costUsd: 0.05,
        timestamp: "2026-08-20T10:10:00Z",
      };
      ledger.ingestCostEvent(workerEvent, {
        runId,
        repoSlug,
        issueId,
        requestId,
        role: "worker",
        invocationSeq: 0,
      });

      // Box hours row: 90min = 2h = 7,200,000 µ$
      ledger.ingestBoxHours({ runId, repoSlug, issueId, requestId });
      ledger.close();

      const res = spawnSync(CLI, [`${repoSlug}#${issueId}`], { env: process.env });
      expect(res.status).toBe(0);
      const out = res.stdout.toString();

      // Header with issue ref
      expect(out).toContain(`${repoSlug}#${issueId}`);

      // Total: tokens (150,000 µ$) + box-hours (7,200,000 µ$) = 7,350,000 µ$
      expect(out).toContain("7,350,000");
      expect(out).toContain("$7.35");

      // Per-role split
      expect(out).toContain("lead");
      expect(out).toContain("100,000"); // 0.10 USD
      expect(out).toContain("worker");
      expect(out).toContain("50,000"); // 0.05 USD
      expect(out).toContain("box-hours");
      expect(out).toContain("7,200,000");

      // Per-run table with the closed run's box hours NOT pending
      expect(out).toContain(runId);
      expect(out).toContain("7,350,000"); // run total
      // Box hours should NOT be pending for a closed run
      expect(out).not.toContain("pending");

      // Token totals with thousands separators
      expect(out).toContain("1,500"); // 1000 + 500 input
      expect(out).toContain("3,000"); // 2000 + 1000 output

      // Cache totals with thousands separators
      expect(out).toContain("100"); // cache read
      expect(out).toContain("50"); // cache write

      // Unpriced count (should be 0)
      expect(out).toContain("unpriced rows: 0");
    });
  });

  describe("box-hours pending", () => {
    test("run with token rows but no box-hours row → shows `pending` in BOX HOURS column", () => {
      const runId = "pending-box-001";
      const repoSlug = "qds/demo";
      const issueId = "99";
      const requestId = "req-002";

      const stubRecord = {
        keyHash: "hash-def456",
        limitMicroUsd: 50_000_000,
        createdAt: "2026-08-20T12:00:00Z",
        // No closedAt — box hours cannot be written
      };

      const ledger = new CostLedger({
        path: join(dir, "cost-ledger.db"),
        config: { defaultCapMicroUsd: 5_000_000 },
        readRunRecord: () => stubRecord,
      });

      const event: CostEvent = {
        agentId: "agent-001",
        model: "cheap/model",
        durationMs: 0,
        inputTokens: 100,
        outputTokens: 200,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        turnCount: 1,
        costUsd: 0.01,
        timestamp: "2026-08-20T12:05:00Z",
      };
      ledger.ingestCostEvent(event, {
        runId,
        repoSlug,
        issueId,
        requestId,
        role: "worker",
        invocationSeq: 0,
      });
      ledger.close();

      const res = spawnSync(CLI, [`${repoSlug}#${issueId}`], { env: process.env });
      expect(res.status).toBe(0);
      const out = res.stdout.toString();

      // Should show pending in the box hours column for this run
      expect(out).toContain(runId);
      expect(out).toContain("pending");
    });
  });

  describe("unpriced rows", () => {
    test("unpriced event → excluded from total, appears in unpriced count line", () => {
      const repoSlug = "qds/demo";
      const issueId = "88";
      const requestId = "req-unpriced";

      const stubRecord = {
        keyHash: "hash-ghi789",
        limitMicroUsd: 50_000_000,
        createdAt: "2026-08-20T14:00:00Z",
        closedAt: "2026-08-20T15:30:00Z",
      };

      const ledger = new CostLedger({
        path: join(dir, "cost-ledger.db"),
        config: { defaultCapMicroUsd: 5_000_000 },
        readRunRecord: () => stubRecord,
      });

      // Priced event: $0.10 = 100,000 µ$
      const pricedEvent: CostEvent = {
        agentId: "agent-001",
        model: "cheap/model",
        durationMs: 0,
        inputTokens: 1000,
        outputTokens: 2000,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        turnCount: 5,
        costUsd: 0.1,
        timestamp: "2026-08-20T14:05:00Z",
      };
      ledger.ingestCostEvent(pricedEvent, {
        runId: "run-001",
        repoSlug,
        issueId,
        requestId,
        role: "worker",
        invocationSeq: 0,
      });

      // Unpriced event: negative cost (unpricedTurns > 0 case)
      const unpricedEvent: CostEvent = {
        agentId: "agent-002",
        model: "cheap/model",
        durationMs: 0,
        inputTokens: 500,
        outputTokens: 1000,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        turnCount: 1,
        costUsd: -0.05, // Invalid cost → unpriced
        timestamp: "2026-08-20T14:10:00Z",
      };
      ledger.ingestCostEvent(unpricedEvent, {
        runId: "run-001",
        repoSlug,
        issueId,
        requestId,
        role: "worker",
        invocationSeq: 1,
      });
      ledger.close();

      const res = spawnSync(CLI, [`${repoSlug}#${issueId}`], { env: process.env });
      expect(res.status).toBe(0);
      const out = res.stdout.toString();

      // Total should only include priced amount (100,000 µ$ = $0.10)
      expect(out).toContain("100,000");
      expect(out).toContain("$0.10");
      // Unpriced count should be 1
      expect(out).toContain("unpriced rows: 1");
    });
  });

  describe("ledger errors", () => {
    test("unopenable ledger (path is a directory) → exit 1, code + next: remediation", () => {
      // Create a directory at the ledger path (SQLite will fail to open it)
      const badPath = join(dir, "bad-ledger");
      process.env.QDS_COST_LEDGER_FILE = badPath;
      const { mkdirSync } = require("node:fs");
      mkdirSync(badPath);

      const res = spawnSync(CLI, ["qds/demo#42"], { env: process.env });
      expect(res.status).toBe(1);
      const out = res.stdout.toString();
      expect(out).toContain("ledger-unopenable");
      expect(out).toContain("next:");
    });
  });
});
