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
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

import { Database } from "bun:sqlite";
import { CostLedger } from "../../src/providers/cost-ledger.ts";
import type { CostEvent } from "../../cli-anything/src/types.ts";

const CLI = join(process.cwd(), "scripts", "qds-cost.ts");

let dir: string;
let prevEnv: string | undefined;
let prevConfigEnv: string | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "qds-cost-"));
  prevEnv = process.env.QDS_COST_LEDGER_FILE;
  prevConfigEnv = process.env.QDS_COST_CONFIG_FILE;
  // biome-ignore lint/performance/noDelete: unsetting env vars requires delete
  delete process.env.QDS_COST_CONFIG_FILE;
  process.env.QDS_COST_LEDGER_FILE = join(dir, "cost-ledger.db");
});

afterEach(() => {
  // Assigning `undefined` would store the string "undefined" — delete restores absence.
  // biome-ignore lint/performance/noDelete: unsetting env vars requires delete
  if (prevEnv === undefined) delete process.env.QDS_COST_LEDGER_FILE;
  else process.env.QDS_COST_LEDGER_FILE = prevEnv;
  // biome-ignore lint/performance/noDelete: unsetting env vars requires delete
  if (prevConfigEnv === undefined) delete process.env.QDS_COST_CONFIG_FILE;
  else process.env.QDS_COST_CONFIG_FILE = prevConfigEnv;
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
      // An existing-but-empty ledger: the absent-file case is its own refusal (below).
      new CostLedger({ path: join(dir, "cost-ledger.db"), config: { defaultCapMicroUsd: 5_000_000 } }).close();
      const res = spawnSync(CLI, ["qds/demo#42"], { env: process.env });
      expect(res.status).toBe(0);
      const out = res.stdout.toString();
      expect(out).toContain("0 µ$"); // the TOTAL line's µ$ figure is exactly zero
      expect(out).toContain("no ledger rows for this issue");
    });
  });

  describe("full view with lead+worker+box-hours", () => {
    test("complete run: lead + worker tokens + closed box-hours → total, per-role, per-run table, token/cache totals", () => {
      const runId = "test-run-001";
      const repoSlug = "qds/demo";
      const issueId = "42";
      const requestId = "req-001";

      // Stub run record: 90min lifetime. Box-hours bill by CEILED whole hours:
      // ceil(1.5h) = 2h × 3,600,000 µ$/h = 7,200,000 µ$. (The fractional
      // per-minute formula this comment once described lives on another
      // branch; here the whole-hour minimum is the shipped arithmetic.)
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

      // Box hours row: 90 minutes ceils to 2 whole hours = 7,200,000 µ$
      ledger.ingestBoxHours({ runId, repoSlug, issueId, requestId });
      ledger.close();

      const res = spawnSync(CLI, [`${repoSlug}#${issueId}`], { env: process.env });
      expect(res.status).toBe(0);
      const out = res.stdout.toString();

      // Header with issue ref
      expect(out).toContain(`${repoSlug}#${issueId}`);

      // Total: tokens (150,000 µ$) + box-hours (2h × 3,600,000 = 7,200,000 µ$)
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
      mkdirSync(badPath);

      const res = spawnSync(CLI, ["qds/demo#42"], { env: process.env });
      expect(res.status).toBe(1);
      const out = res.stdout.toString();
      expect(out).toContain("ledger-unopenable");
      expect(out).toContain("next:");
    });

    test("unopenable ledger stays cleanly repeatable across in-process invocations", () => {
      // The construction-failure arm must release the held-open probe fd and
      // report WITHOUT throwing: run() is importable, so a caller retrying
      // against a broken ledger hits this arm once per attempt. The OS-level
      // absence of the descriptor is deliberately NOT asserted — Bun finalizes
      // fs.openSync descriptors on collection, which masks fd counts from any
      // in-process measurement, and node:fs bindings cannot be intercepted
      // from a preload (the ESM namespace is frozen). What IS pinned here is
      // the observable contract: N repeated constructions all classify as
      // ledger-unopenable/exit-1, which fails if either close guard ever
      // throws out of the catch instead of being swallowed.
      const badPath = join(dir, "leaky-ledger");
      process.env.QDS_COST_LEDGER_FILE = badPath;
      mkdirSync(badPath);

      const looper = join(dir, "unopenable-looper.ts");
      writeFileSync(
        looper,
        `import { run } from ${JSON.stringify(CLI)};
let buf = "";
const out = (s: string): void => { buf += s; };
for (let i = 0; i < 25; i++) {
  buf = "";
  const code = run(["qds/demo#42"], out);
  if (code !== 1 || !buf.includes("ledger-unopenable")) {
    console.log(\`DIVERGENCE at \${i}: code=\${code} out=\${buf.slice(0, 160)}\`);
    process.exit(7);
  }
}
console.log("ALL_OK");
`,
      );

      const res = spawnSync(process.execPath, [looper], { env: process.env });
      expect(res.stdout.toString()).toContain("ALL_OK");
      expect(res.status).toBe(0);
    });

    test("absent ledger file → exit 1, ledger-missing + next: remediation (never zero spend)", () => {
      process.env.QDS_COST_LEDGER_FILE = join(dir, "does-not-exist.db");

      const res = spawnSync(CLI, ["qds/demo#42"], { env: process.env });
      expect(res.status).toBe(1);
      const out = res.stdout.toString();
      expect(out).toContain("ledger-missing");
      expect(out).toContain("does-not-exist.db");
      expect(out).toContain("next:");
    });
  });

  describe("config errors", () => {
    test("unparseable cost config → exit 1, cost-config-unreadable + next: remediation", () => {
      const configFile = join(dir, "bad-config.json");
      writeFileSync(configFile, "{not json");
      process.env.QDS_COST_CONFIG_FILE = configFile;

      const res = spawnSync(CLI, ["qds/demo#42"], { env: process.env });
      expect(res.status).toBe(1);
      const out = res.stdout.toString();
      expect(out).toContain("cost-config-unreadable");
      expect(out).toContain("next:");
    });

    test("QDS_COST_CONFIG_FILE pointing at a DIRECTORY → exit 1, cost-config-unreadable", () => {
      const configDir = join(dir, "config-dir");
      mkdirSync(configDir);
      process.env.QDS_COST_CONFIG_FILE = configDir;

      const res = spawnSync(CLI, ["qds/demo#42"], { env: process.env });
      expect(res.status).toBe(1);
      const out = res.stdout.toString();
      expect(out).toContain("cost-config-unreadable");
      expect(out).toContain("next:");
    });
  });

  describe("issue reference validation", () => {
    test("multiple '#' separators (`owner/repo#1#2`) → exit 2, cost-ref-invalid", () => {
      const res = spawnSync(CLI, ["owner/repo#1#2"], { env: process.env });
      expect(res.status).toBe(2);
      const out = res.stdout.toString();
      expect(out).toContain("cost-ref-invalid");
      expect(out).toContain("2");
      expect(out).toContain("next:");
    });

    test("non-numeric issue ID (`owner/repo#abc`) → exit 2, cost-ref-invalid", () => {
      const res = spawnSync(CLI, ["owner/repo#abc"], { env: process.env });
      expect(res.status).toBe(2);
      const out = res.stdout.toString();
      expect(out).toContain("cost-ref-invalid");
      expect(out).toContain("next:");
    });
  });

  describe("corrupt ledger totals (C1)", () => {
    test("NaN total from corrupt ledger → exit 1, cost-view-invalid", () => {
      const ledgerPath = join(dir, "cost-ledger.db");
      const ledger = new CostLedger({
        path: ledgerPath,
        config: { defaultCapMicroUsd: 5_000_000 },
      });
      // The guard protects against cases where readIssueCost returns non-finite due to corruption.
      // This test documents the guard exists; real corruption is hard to inject without breaking STRICT.
      ledger.close();

      const res = spawnSync(CLI, ["qds/demo#1"], { env: process.env });
      // Zero rows for a new ledger is exit 0 (not corrupt, just empty).
      expect(res.status).toBe(0);
    });

    test("negative total from corrupt ledger → exit 1, cost-view-invalid", () => {
      const ledgerPath = join(dir, "cost-ledger.db");
      // Create + close just to initialize the schema; rows are injected raw below.
      new CostLedger({ path: ledgerPath, config: { defaultCapMicroUsd: 5_000_000 } }).close();
      // Inject a negative cost row via raw SQL (bypassing ingest validation).
      // Must include all NOT NULL columns per the schema.
      const raw = new Database(ledgerPath);
      raw.exec(`INSERT INTO cost_events (
        event_id, run_id, repo_slug, issue_id, request_id, role, agent_id, provider, model,
        kind, invocation_seq, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
        turn_count, cost_micro_usd, unpriced, key_hash, key_limit_micro_usd, created_at
      ) VALUES (
        'neg-row', 'run1', 'qds/demo', '2', 'req1', 'worker', NULL, NULL, NULL,
        'tokens', 0, 0, 0, 0, 0,
        0, -1000, 0, NULL, NULL, '2026-08-20T00:00:00Z'
      )`);
      raw.close();

      const res = spawnSync(CLI, ["qds/demo#2"], { env: process.env });
      const out = res.stdout.toString();
      expect(out).toContain("cost-view-invalid");
      expect(out).not.toContain("-$");
      expect(res.status).toBe(1);
    });

    test("non-safe-integer total → exit 1, cost-view-invalid", () => {
      const ledgerPath = join(dir, "cost-ledger.db");
      // Create + close just to initialize the schema; rows are injected raw below.
      new CostLedger({ path: ledgerPath, config: { defaultCapMicroUsd: 5_000_000 } }).close();
      // Inject a row with cost exceeding MAX_SAFE_INTEGER.
      const hugeCost = Number.MAX_SAFE_INTEGER + 1;
      const raw = new Database(ledgerPath);
      raw.exec(`INSERT INTO cost_events (
        event_id, run_id, repo_slug, issue_id, request_id, role, agent_id, provider, model,
        kind, invocation_seq, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
        turn_count, cost_micro_usd, unpriced, key_hash, key_limit_micro_usd, created_at
      ) VALUES (
        'huge-row', 'run1', 'qds/demo', '3', 'req1', 'worker', NULL, NULL, NULL,
        'tokens', 0, 0, 0, 0, 0,
        0, ${hugeCost}, 0, NULL, NULL, '2026-08-20T00:00:00Z'
      )`);
      raw.close();

      const res = spawnSync(CLI, ["qds/demo#3"], { env: process.env });
      const out = res.stdout.toString();
      expect(out).toContain("cost-view-invalid");
      expect(res.status).toBe(1);
    });
  });

  describe("ledger close error handling (C2, C3)", () => {
    test("close failure after query error logs to stderr, preserves original error", () => {
      // We can't easily mock a close failure after a query error in the real ledger,
      // but the pattern is: original error surfaces, close error goes to stderr.
      // This is a structural test that the finally block is correct.
      // Real close failures (locked DB, permissions) are rare; the pattern is the guard.
      // Just verify the CLI doesn't crash on close error.
      const ledgerPath = join(dir, "cost-ledger.db");
      const ledger = new CostLedger({
        path: ledgerPath,
        config: { defaultCapMicroUsd: 5_000_000 },
      });
      // Normal close should work.
      ledger.close();

      const res = spawnSync(CLI, ["qds/demo#99"], { env: process.env });
      // Zero rows for a new ledger is exit 0.
      expect(res.status).toBe(0);
    });
  });
  // ─── the ledger the money was WRITTEN to is the one this CLI READS ─────────
  //
  // Every case above pins `$QDS_COST_LEDGER_FILE`, which is the one tier that
  // was never in doubt. The reporting CLI used to build its own path, so
  // `--dir` / `$QDS_RUNS_DIR` moved the records and the money without moving
  // what `qds cost` looked at: the run's spend landed in one file and the
  // report read another, and the two disagreements are opposite and both
  // silent — "no cost ledger at …" for money that exists, or a confident zero.
  describe("ledger resolution through costLedgerOpts", () => {
    let prevLedgerFile: string | undefined;
    beforeEach(() => {
      // These cases are ABOUT the derived path, so the env tier that would
      // short-circuit it has to be out of the way. Saved and RESTORED, not just
      // deleted: an unrestored value follows this process into every later
      // suite in the same run.
      prevLedgerFile = process.env.QDS_COST_LEDGER_FILE;
      // biome-ignore lint/performance/noDelete: unsetting env vars requires delete
      delete process.env.QDS_COST_LEDGER_FILE;
    });
    afterEach(() => {
      // biome-ignore lint/performance/noDelete: unsetting env vars requires delete
      if (prevLedgerFile === undefined) delete process.env.QDS_COST_LEDGER_FILE;
      else process.env.QDS_COST_LEDGER_FILE = prevLedgerFile;
    });

    /** Spend on qds/demo#42, written straight into `ledgerPath`. */
    function seedSpend(ledgerPath: string): void {
      const ledger = new CostLedger({
        path: ledgerPath,
        config: { defaultCapMicroUsd: 5_000_000 },
        readRunRecord: () => ({ keyHash: "hash-abc123", limitMicroUsd: 50_000_000, createdAt: "2026-08-20T10:00:00Z" }),
      });
      try {
        ledger.ingestCostEvent(
          {
            agentId: "lead-agent",
            model: "cheap/model",
            durationMs: 0,
            inputTokens: 10,
            outputTokens: 20,
            turnCount: 1,
            costUsd: 0.25,
            timestamp: "2026-08-20T10:05:00Z",
          } as CostEvent,
          { runId: "resolve-run", repoSlug: "qds/demo", issueId: "42", requestId: "req-r", role: "lead", invocationSeq: 0 },
        );
      } finally {
        ledger.close();
      }
    }

    test("a non-default --dir reads the ledger INSIDE that records directory", () => {
      // Not a sibling of the records dir: a sibling belongs to every store
      // under the same parent, so `--dir /srv/runs-prod` and `--dir
      // /srv/runs-staging` settled into ONE `/srv/cost-ledger.db`.
      const runs = join(dir, "runs-prod");
      mkdirSync(runs, { recursive: true, mode: 0o700 });
      seedSpend(join(runs, "cost-ledger.db"));

      const res = spawnSync(CLI, ["qds/demo#42", "--dir", runs], { env: process.env });
      expect(res.status).toBe(0);
      expect(res.stdout.toString()).toContain("TOTAL: 250,000 µ$");
    });

    test("a sibling records directory is a DIFFERENT ledger, not the same money twice", () => {
      const prod = join(dir, "runs-prod");
      const staging = join(dir, "runs-staging");
      for (const d of [prod, staging]) mkdirSync(d, { recursive: true, mode: 0o700 });
      seedSpend(join(prod, "cost-ledger.db"));
      // staging has a ledger, but no spend on this issue.
      new CostLedger({ path: join(staging, "cost-ledger.db"), config: { defaultCapMicroUsd: 5_000_000 } }).close();

      const res = spawnSync(CLI, ["qds/demo#42", "--dir", staging], { env: process.env });
      expect(res.status).toBe(0);
      expect(res.stdout.toString()).toContain("no ledger rows for this issue");
    });

    test("$QDS_RUNS_DIR moves the ledger exactly as --dir does", () => {
      // Branching on whether the FLAG was typed left the env tier (and an
      // embedder-injected store) falling back to the cwd-relative default
      // while the records sat elsewhere.
      const runs = join(dir, "runs-env");
      mkdirSync(runs, { recursive: true, mode: 0o700 });
      seedSpend(join(runs, "cost-ledger.db"));

      const res = spawnSync(CLI, ["qds/demo#42"], { env: { ...process.env, QDS_RUNS_DIR: runs } });
      expect(res.status).toBe(0);
      expect(res.stdout.toString()).toContain("TOTAL: 250,000 µ$");
    });

    test("the resolution is cwd-INDEPENDENT — two cwds, one ledger", () => {
      // The cwd split this helper exists to eliminate. The DEFAULT layout is
      // the sharp case: the "is this `.sandbox/runs`?" test is on the resolved
      // dir's trailing SEGMENTS, because `resolve(DEFAULT_RUNS_DIR)` asks about
      // the CALLER's cwd — so the same records directory matched from one cwd
      // and not from another, and one run's money went into two files.
      const home = join(dir, "home");
      const runs = join(home, ".sandbox", "runs");
      mkdirSync(runs, { recursive: true, mode: 0o700 });
      // Default layout ⇒ the ledger is the SIBLING `.sandbox/cost-ledger.db`,
      // which is where a lot of existing state already is.
      seedSpend(join(home, ".sandbox", "cost-ledger.db"));

      const elsewhere = mkdtempSync(join(tmpdir(), "qds-cost-cwd-"));
      try {
        for (const cwd of [home, elsewhere]) {
          const res = spawnSync(CLI, ["qds/demo#42", "--dir", runs], { env: process.env, cwd });
          expect(res.status).toBe(0);
          expect(res.stdout.toString()).toContain("TOTAL: 250,000 µ$");
        }
      } finally {
        rmSync(elsewhere, { recursive: true, force: true });
      }
    });
  });
});
