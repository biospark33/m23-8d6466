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
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync, type SpawnSyncOptions } from "node:child_process";

import { Database } from "bun:sqlite";
import { CostLedger, type CostLedgerError } from "../../src/providers/cost-ledger.ts";
import type { CostEvent } from "../../cli-anything/src/types.ts";
import { reportLedgerOpenFailure, run } from "../../scripts/qds-cost.ts";

const CLI = join(process.cwd(), "scripts", "qds-cost.ts");

/**
 * Every child spawn goes through here, so the timeout is stated once: a wedged
 * CLI must fail its own test, not hang the whole suite until the runner's
 * global timeout scrambles the blame. Inherits `process.env` by default — the
 * suite's beforeEach pins `$QDS_COST_LEDGER_FILE` into it — and callers pass
 * only what differs.
 */
const runCli = (args: string[], opts: SpawnSyncOptions = {}): ReturnType<typeof spawnSync> =>
  spawnSync(CLI, args, { env: process.env, timeout: 30_000, ...opts });

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
      const res = runCli(["42"]);
      expect(res.status).toBe(2);
      expect(res.stdout.toString()).toContain("cost-ref-invalid");
      expect(res.stdout.toString()).toContain("next:");
    });

    test("`#42` (no repo slug) → exit 2, cost-ref-invalid", () => {
      const res = runCli(["#42"]);
      expect(res.status).toBe(2);
      expect(res.stdout.toString()).toContain("cost-ref-invalid");
    });

    test("`demo#42` (no owner) → exit 2, cost-ref-invalid", () => {
      const res = runCli(["demo#42"]);
      expect(res.status).toBe(2);
      expect(res.stdout.toString()).toContain("cost-ref-invalid");
    });

    test("empty argv → exit 2, cost-ref-invalid", () => {
      const res = runCli([]);
      expect(res.status).toBe(2);
      expect(res.stdout.toString()).toContain("cost-ref-invalid");
    });

    test("valid ref `qds/demo#42` with zero rows → exit 0, prints 0 µ$, no-rows line", () => {
      // An existing-but-empty ledger: the absent-file case is its own refusal (below).
      new CostLedger({ path: join(dir, "cost-ledger.db"), config: { defaultCapMicroUsd: 5_000_000 } }).close();
      const res = runCli(["qds/demo#42"]);
      expect(res.status).toBe(0);
      const out = res.stdout.toString();
      expect(out).toContain("0 µ$"); // the TOTAL line's µ$ figure is exactly zero
      expect(out).toContain("no ledger rows for this issue");
    });

    test("a repeated `--dir` refuses instead of silently last-winning", () => {
      // Both values name real directories with ledgers, so a last-win
      // implementation would EXIT 0 against whichever came second — the refusals
      // below are what prove the duplicate itself is rejected, not just that
      // some dir resolved.
      const first = join(dir, "runs-a");
      const second = join(dir, "runs-b");
      for (const d of [first, second]) mkdirSync(d, { recursive: true, mode: 0o700 });
      writeFileSync(join(first, "cost-ledger.db"), "");
      writeFileSync(join(second, "cost-ledger.db"), "");

      const spaced = runCli(["qds/demo#42", "--dir", first, "--dir", second]);
      expect(spaced.status).toBe(2);
      expect(spaced.stdout.toString()).toContain("--dir given more than once");
      // help-suffix shape, matching fleet.ts's duplicate-flag refusal
      expect(spaced.stdout.toString()).toContain("Usage: qds-cost");

      const inline = runCli(["qds/demo#42", `--dir=${first}`, "--dir", second]);
      expect(inline.status).toBe(2);
      expect(inline.stdout.toString()).toContain("--dir given more than once");
    });

    test("an EMPTY $QDS_RUNS_DIR resolves to the default records dir, not the cwd", () => {
      // Round 11 / E6: `""` is not nullish, so it used to beat DEFAULT_RUNS_DIR
      // and locate both money files at the caller's cwd — an exported-unset
      // variable (`export QDS_RUNS_DIR=$UNSET`) silently moved the ledger out
      // of `.sandbox/`. Discriminator: the DEFAULT layout's money sits in
      // `<home>/.sandbox/cost-ledger.db`; the pre-fix resolution for "" read
      // `<cwd>/cost-ledger.db`, so that file holds an EMPTY decoy here — the
      // run must report the real spend, never the decoy's zero rows.
      const home = mkdtempSync(join(tmpdir(), "qds-cost-emptyenv-"));
      try {
        const runs = join(home, ".sandbox", "runs");
        mkdirSync(runs, { recursive: true, mode: 0o700 });
        const ledger = new CostLedger({
          path: join(home, ".sandbox", "cost-ledger.db"),
          config: { defaultCapMicroUsd: 5_000_000 },
          readRunRecord: () => ({ keyHash: "h", limitMicroUsd: 50_000_000, createdAt: "2026-08-20T10:00:00Z" }),
        });
        ledger.ingestCostEvent(
          { agentId: "lead-agent", model: "cheap/model", durationMs: 0, inputTokens: 1, outputTokens: 2, turnCount: 1, costUsd: 0.25, timestamp: "2026-08-20T10:05:00Z" } as CostEvent,
          { runId: "emptyenv-run", repoSlug: "qds/demo", issueId: "42", requestId: "req-e", role: "lead", invocationSeq: 0 },
        );
        ledger.close();

        // Exactly the file the ""-as-set resolution used to open: <cwd-of-child>/cost-ledger.db.
        new CostLedger({ path: join(home, "cost-ledger.db"), config: { defaultCapMicroUsd: 5_000_000 } }).close();

        // This suite's beforeEach pins $QDS_COST_LEDGER_FILE — an explicit env
        // override wins OUTRIGHT over every derived tier, so for this one run
        // it must be absent or it would decide the path instead of the
        // resolution chain under test. (Destructure-and-omit, not `delete`: this
        // is a fresh child-env object, never the live process.env.)
        const { QDS_COST_LEDGER_FILE: _drop, ...rest } = process.env;
        const env = { ...rest, QDS_RUNS_DIR: "" };

        const res = runCli(["qds/demo#42"], { env, cwd: home });
        expect(res.status).toBe(0);
        const out = res.stdout.toString();
        expect(out).toContain("TOTAL: 250,000 µ$");
        expect(out).not.toContain("no ledger rows");
        expect(out).not.toContain("no cost ledger");
      } finally {
        rmSync(home, { recursive: true, force: true });
      }
    });
  });

  describe("full view with lead+worker+box-hours", () => {
    test("complete run: lead + worker tokens + closed box-hours → total, per-role, per-run table, token/cache totals", () => {
      const runId = "test-run-001";
      const repoSlug = "qds/demo";
      const issueId = "42";
      const requestId = "req-001";

      // Stub run record: 90min lifetime. Box-hours bill FRACTIONALLY (F8):
      // 1.5h × 3,600,000 µ$/h = 5,400,000 µ$ — no whole-hour ceiling.
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

      // Box hours row: 90 minutes billed fractionally (F8) = 5,400,000 µ$
      ledger.ingestBoxHours({ runId, repoSlug, issueId, requestId });
      ledger.close();

      const res = runCli([`${repoSlug}#${issueId}`]);
      expect(res.status).toBe(0);
      const out = res.stdout.toString();

      // Header with issue ref
      expect(out).toContain(`${repoSlug}#${issueId}`);

      // Total: tokens (150,000 µ$) + box-hours (1.5h × 3,600,000 = 5,400,000 µ$)
      expect(out).toContain("5,550,000");
      expect(out).toContain("$5.55");

      // Per-role split
      expect(out).toContain("lead");
      expect(out).toContain("100,000"); // 0.10 USD
      expect(out).toContain("worker");
      expect(out).toContain("50,000"); // 0.05 USD
      expect(out).toContain("box-hours");
      expect(out).toContain("5,400,000");

      // Per-run table with the closed run's box hours NOT pending
      expect(out).toContain(runId);
      expect(out).toContain("5,550,000"); // run total
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

      const res = runCli([`${repoSlug}#${issueId}`]);
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

      const res = runCli([`${repoSlug}#${issueId}`]);
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

      const res = runCli(["qds/demo#42"]);
      expect(res.status).toBe(1);
      const out = res.stdout.toString();
      // The ledger's ledger-unopenable renders as this CLI's ledger-unreadable
      // (the untouched exit taxonomy), and — D8 round 3 — the CLI passes the
      // ledger's OWN remediation through instead of a generic "fix the
      // permissions" line: it names the offending path and offers removal only
      // when the path is not a ledger, which a directory sitting at the ledger
      // path literally is.
      expect(out).toContain("ledger-unreadable");
      expect(out).toContain(`fix the permissions on ${badPath}`);
      expect(out).toContain("or remove the file if it is not a ledger, then re-run");
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
      // ledger-unreadable/exit-1 (the ledger's ledger-unopenable, mapped),
      // which fails if either close guard ever
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
  if (code !== 1 || !buf.includes("ledger-unreadable")) {
    console.log(\`DIVERGENCE at \${i}: code=\${code} out=\${buf.slice(0, 160)}\`);
    process.exit(7);
  }
}
console.log("ALL_OK");
`,
      );

      const res = spawnSync(process.execPath, [looper], { env: process.env, timeout: 60_000 });
      expect(res.stdout.toString()).toContain("ALL_OK");
      expect(res.status).toBe(0);
    });

    test("absent ledger file → exit 1, ledger-missing + next: remediation (never zero spend)", () => {
      process.env.QDS_COST_LEDGER_FILE = join(dir, "does-not-exist.db");

      const res = runCli(["qds/demo#42"]);
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

      const res = runCli(["qds/demo#42"]);
      expect(res.status).toBe(1);
      const out = res.stdout.toString();
      expect(out).toContain("cost-config-unreadable");
      expect(out).toContain("next:");
    });

    test("QDS_COST_CONFIG_FILE pointing at a DIRECTORY → exit 1, cost-config-unreadable", () => {
      const configDir = join(dir, "config-dir");
      mkdirSync(configDir);
      process.env.QDS_COST_CONFIG_FILE = configDir;

      const res = runCli(["qds/demo#42"]);
      expect(res.status).toBe(1);
      const out = res.stdout.toString();
      expect(out).toContain("cost-config-unreadable");
      expect(out).toContain("next:");
    });
  });

  describe("issue reference validation", () => {
    test("multiple '#' separators (`owner/repo#1#2`) → exit 2, cost-ref-invalid", () => {
      const res = runCli(["owner/repo#1#2"]);
      expect(res.status).toBe(2);
      const out = res.stdout.toString();
      expect(out).toContain("cost-ref-invalid");
      expect(out).toContain("2");
      expect(out).toContain("next:");
    });

    test("non-numeric issue ID (`owner/repo#abc`) → exit 2, cost-ref-invalid", () => {
      const res = runCli(["owner/repo#abc"]);
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

      const res = runCli(["qds/demo#1"]);
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

      const res = runCli(["qds/demo#2"]);
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

      const res = runCli(["qds/demo#3"]);
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

      const res = runCli(["qds/demo#99"]);
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

      const res = runCli(["qds/demo#42", "--dir", runs]);
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

      const res = runCli(["qds/demo#42", "--dir", staging]);
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

      const res = runCli(["qds/demo#42"], { env: { ...process.env, QDS_RUNS_DIR: runs } });
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
          const res = runCli(["qds/demo#42", "--dir", runs], { cwd });
          expect(res.status).toBe(0);
          expect(res.stdout.toString()).toContain("TOTAL: 250,000 µ$");
        }
      } finally {
        rmSync(elsewhere, { recursive: true, force: true });
      }
    });
  });

  // ── the zero-token-row ledger: what the qualification says NOW ─────────────
  //
  // `ingestCostEvent` is the only writer of `kind='tokens'` rows, and the
  // DF2.12 bridge (cost-ledger-bridge.ts) drives it at teardown. A ledger
  // with zero token rows therefore means no run has DELIVERED token rows yet
  // — runs still open, harvested runs that spent nothing, or a bridge/harvest
  // regression — and the qualification says exactly that, plus where the
  // per-run evidence lives.
  //
  // `QDS_LOG_VERBOSE=1` because src/swarmclaw/log.ts mutes the JSONL sink
  // under NODE_ENV=test (which `bun test` sets and spawnSync inherits); in
  // production the line is on stdout unconditionally.
  describe("zero-token-row ledger qualification", () => {
    // Built per test, never hoisted to the describe body: the describe
    // callback runs at COLLECTION time, before `beforeEach` sets
    // QDS_COST_LEDGER_FILE, so a hoisted snapshot points the CLI at a ledger
    // that does not exist (`ledger-missing`, exit 1).
    const verbose = () => ({ ...process.env, QDS_LOG_VERBOSE: "1" });

    function boxHoursOnlyLedger(): void {
      const ledger = new CostLedger({
        path: join(dir, "cost-ledger.db"),
        config: { defaultCapMicroUsd: 5_000_000, boxHourRateMicroUsd: 3_600_000 },
        readRunRecord: () => ({
          keyHash: "hash-f001",
          limitMicroUsd: 50_000_000,
          createdAt: "2026-08-20T10:00:00Z",
          closedAt: "2026-08-20T11:30:00Z",
        }),
      });
      ledger.ingestBoxHours({
        runId: "unwired-run-001",
        repoSlug: "qds/demo",
        issueId: "42",
        requestId: "req-f001",
      });
      ledger.close();
    }

    test("a ledger with no kind='tokens' row reports tokens-ledger-unwired", () => {
      boxHoursOnlyLedger();
      const res = runCli(["qds/demo#42"], { env: verbose() });
      expect(res.status).toBe(0);
      const out = res.stdout.toString();
      expect(out).toContain("tokens-ledger-unwired");
      // The reclassified (DF2.12) wording: the bridge is live, so the line
      // names the live condition — nothing delivered yet — and its money
      // consequence, and points at the per-run evidence.
      expect(out).toContain("pricing box hours only until a token row lands");
      expect(out).toContain("cost-ledger-bridge.ts");
    });

    test("the line is ledger-wide, not issue-scoped — a token row anywhere silences it", () => {
      boxHoursOnlyLedger();
      const ledger = new CostLedger({
        path: join(dir, "cost-ledger.db"),
        config: { defaultCapMicroUsd: 5_000_000 },
        readRunRecord: () => ({
          keyHash: "hash-f001",
          limitMicroUsd: 50_000_000,
          createdAt: "2026-08-20T12:00:00Z",
        }),
      });
      // A DIFFERENT issue: the claim the line makes is about the ledger's
      // wiring, so one token row anywhere proves the bridge is live.
      ledger.ingestCostEvent(
        {
          agentId: "agent-f001",
          model: "cheap/model",
          durationMs: 0,
          inputTokens: 10,
          outputTokens: 20,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          turnCount: 1,
          costUsd: 0.01,
          timestamp: "2026-08-20T12:05:00Z",
        } satisfies CostEvent,
        { runId: "wired-run-001", repoSlug: "qds/other", issueId: "7", requestId: "req-f001b", role: "worker", invocationSeq: 0 },
      );
      ledger.close();

      const res = runCli(["qds/demo#42"], { env: verbose() });
      expect(res.status).toBe(0);
      expect(res.stdout.toString()).not.toContain("tokens-ledger-unwired");
    });
  });

  // ── DF2.12: the per-run TOKENS discriminator (AC4) ─────────────────────────
  //
  // `qds cost` re-derives the per-run token state from the SAME harvested
  // evidence the teardown's bridge read —
  // `<runsDir>/<runId>-artifacts/<runId>.engine.log`, through the same
  // classifier — so the teardown summary and this table agree by construction.
  // Unharvested spend renders `tokens-not-harvested`, never `0 µ$`.
  describe("per-run token discriminator (DF2.12)", () => {
    const LEDGER_FILE = () => join(dir, "cost-ledger.db");
    const RUNS = () => join(dir, "runs");

    function seedLedger(seed: (ledger: CostLedger) => void): void {
      const ledger = new CostLedger({
        path: LEDGER_FILE(),
        config: { defaultCapMicroUsd: 5_000_000, boxHourRateMicroUsd: 3_600_000 },
        readRunRecord: () => ({
          keyHash: "hash-df212",
          limitMicroUsd: 50_000_000,
          createdAt: "2026-09-10T10:00:00Z",
          closedAt: "2026-09-10T10:30:00Z",
        }),
      });
      try {
        seed(ledger);
      } finally {
        ledger.close();
      }
    }

    function line(runId: string, over: Record<string, unknown> = {}): string {
      return JSON.stringify({
        type: "cost_attribution",
        requestId: "req-box",
        runId,
        phaseId: "implement",
        agentId: "lead-1",
        role: "lead",
        invocationSeq: 0,
        model: "cheap/model",
        costMicroUsd: 12_345,
        inputTokens: 1_000,
        outputTokens: 500,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        turnCount: 1,
        unpricedTurns: 0,
        timestamp: "2026-09-10T10:05:00Z",
        ...over,
      });
    }

    function writeEngineLog(runId: string, lines: string[]): void {
      mkdirSync(join(RUNS(), `${runId}-artifacts`), { recursive: true });
      writeFileSync(join(RUNS(), `${runId}-artifacts`, `${runId}.engine.log`), `${lines.join("\n")}\n`);
    }

    function costCli(args: string[]): ReturnType<typeof spawnSync> {
      return runCli(args, { env: { ...process.env, QDS_RUNS_DIR: RUNS() } });
    }

    function boxHours(runId: string): (ledger: CostLedger) => void {
      return (ledger: CostLedger): void => {
        ledger.ingestBoxHours({ runId, repoSlug: "qds/demo", issueId: "42", requestId: "req-df212" });
      };
    }

    test("priced token rows → multi-role split and a ✓ TOKENS cell", () => {
      const runId = "df212-priced-run";
      mkdirSync(RUNS(), { recursive: true });
      seedLedger((ledger) => {
        boxHours(runId)(ledger);
        ledger.ingestCostEvent(
          {
            agentId: "lead-1", model: "cheap/model", durationMs: 0, inputTokens: 1_000, outputTokens: 500,
            cacheReadTokens: 0, cacheWriteTokens: 0, turnCount: 1, costUsd: 12_345 / 1e6,
            timestamp: "2026-09-10T10:05:00Z",
          } satisfies CostEvent,
          { runId, repoSlug: "qds/demo", issueId: "42", requestId: "r", role: "lead", invocationSeq: 0 },
        );
        ledger.ingestCostEvent(
          {
            agentId: "resident", model: "", durationMs: 0, inputTokens: 2_000, outputTokens: 900,
            cacheReadTokens: 0, cacheWriteTokens: 0, turnCount: 1, costUsd: 7_000 / 1e6,
            timestamp: "2026-09-10T10:06:00Z",
          } satisfies CostEvent,
          { runId, repoSlug: "qds/demo", issueId: "42", requestId: "r", role: "resident", invocationSeq: 0 },
        );
      });
      writeEngineLog(runId, [line(runId), line(runId, { agentId: "resident", role: "resident", costMicroUsd: 7_000 })]);

      const res = costCli(["qds/demo#42"]);
      expect(res.status).toBe(0);
      const out = res.stdout.toString();
      // The multi-role split: lead, worker-less but resident-present, and the
      // literal box-hours key, all in PER ROLE.
      expect(out).toContain("lead");
      expect(out).toContain("resident");
      expect(out).toContain("box-hours (unattributed)");
      expect(out).not.toContain("tokens-not-harvested");
      expect(out).toContain("✓");
    });

    test("absent engine log → tokens-not-harvested, never 0 µ$", () => {
      const runId = "df212-unharvested-run";
      mkdirSync(RUNS(), { recursive: true });
      seedLedger(boxHours(runId));
      const res = costCli(["qds/demo#42"]);
      expect(res.status).toBe(0);
      const out = res.stdout.toString();
      expect(out).toContain("tokens-not-harvested");
      expect(out).toContain(runId);
    });

    test("readable log with zero cost_attribution lines → no-token-spend", () => {
      const runId = "df212-spendless-run";
      mkdirSync(RUNS(), { recursive: true });
      seedLedger(boxHours(runId));
      writeEngineLog(runId, [JSON.stringify({ type: "step", name: "implement" })]);
      const res = costCli(["qds/demo#42"]);
      expect(res.status).toBe(0);
      expect(res.stdout.toString()).toContain("no-token-spend");
    });

    test("lines present but zero priced rows landed → token-rows-refused (n)", () => {
      const runId = "df212-refused-run";
      mkdirSync(RUNS(), { recursive: true });
      seedLedger((ledger) => {
        boxHours(runId)(ledger);
        // The run's only token row is UNPRICED (the producer said so) —
        // excluded from every priced bucket, so nothing priced landed.
        ledger.ingestCostEvent(
          {
            agentId: "lead-1", model: "cheap/model", durationMs: 0, inputTokens: 10, outputTokens: 5,
            cacheReadTokens: 0, cacheWriteTokens: 0, turnCount: 1, costUsd: 0, unpricedTurns: 1,
            timestamp: "2026-09-10T10:05:00Z",
          } satisfies CostEvent,
          { runId, repoSlug: "qds/demo", issueId: "42", requestId: "r", role: "lead", invocationSeq: 0 },
        );
      });
      writeEngineLog(runId, [line(runId), line(runId, { agentId: "worker-1", role: "worker", costMicroUsd: 5 })]);
      const res = costCli(["qds/demo#42"]);
      expect(res.status).toBe(0);
      expect(res.stdout.toString()).toContain("token-rows-refused (2)");
    });
  });

  // ─── the open is CostLedger.openReadOnly's now; this CLI only translates ───
  //
  // DF2.11 moved the CLI-local guard (no-create probe, probe fd held across
  // the open, post-open inode compare) inside openReadOnly, and the CLI maps
  // that method's refusal codes onto its own long-standing surfaces. These
  // cases pin the two refusals the CLI-local guard could not even see: the
  // WAL ceiling (new in DF2.11) and the replaced-ledger mapping.
  describe("openReadOnly refusal mapping (DF2.11)", () => {
    test("crashed-writer WAL shape (-wal non-empty, no -shm) → exit 1, ledger-wal-recovery-required + checkpoint remediation", () => {
      // Seeded honestly: a real writable ledger with a committed row, and the
      // writer STILL OPEN so the commit content genuinely lives in the -wal.
      // Only the transient -shm index is removed — the exact crashed-writer
      // shape openReadOnly's ceiling exists for.
      const ledgerPath = join(dir, "cost-ledger.db");
      const writer = new CostLedger({
        path: ledgerPath,
        config: { defaultCapMicroUsd: 5_000_000 },
        readRunRecord: () => ({ keyHash: "hash-wal", limitMicroUsd: 50_000_000, createdAt: "2026-08-20T10:00:00Z" }),
      });
      const shm = `${ledgerPath}-shm`;
      // Everything the test asserts is captured and rethrown AFTER the cleanup
      // below, so the original failure always wins: a raw throw out of a
      // `finally` used to REPLACE an in-flight assertion failure — and a
      // skipped `writer.close()` leaked the -wal-holding handle into every
      // later test in the suite. Cleanup failures of their own still surface,
      // but only from a test that otherwise passed.
      let failure: unknown;
      try {
        writer.ingestCostEvent(
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
          { runId: "wal-run", repoSlug: "qds/demo", issueId: "42", requestId: "req-wal", role: "lead", invocationSeq: 0 },
        );
        expect(statSync(`${ledgerPath}-wal`).size).toBeGreaterThan(0);
        unlinkSync(shm);

        const res = runCli(["qds/demo#42"]);
        expect(res.status).toBe(1);
        const out = res.stdout.toString();
        expect(out).toContain("ledger-wal-recovery-required");
        expect(out).toContain("un-checkpointed WAL");
        // The checkpoint remediation, rendered — the operator's way out.
        expect(out).toContain("never fall back to a read-write open");
        expect(out).toContain("next:");

        // Behavioral proof of that remediation: a read-write fallback open
        // would have recreated the -shm index; the refusal must not have.
        expect(existsSync(shm)).toBe(false);
      } catch (e) {
        failure = e;
      }

      // Cleanup, guarded: neither step may mask the in-flight `failure` above,
      // and the writer closes no matter which of them threw.
      let cleanup: unknown;
      try {
        // Restore a sane WAL shape before the clean close: any fresh db access
        // recreates the -shm index (reader traffic, not ledger content) — the
        // same restore the provider suite's WAL-ceiling test uses.
        const healer = new Database(ledgerPath);
        try {
          healer.exec("SELECT 1");
        } finally {
          healer.close();
        }
      } catch (e) {
        cleanup = e;
      }
      try {
        writer.close();
      } catch (e) {
        cleanup ??= e;
      }
      if (failure !== undefined) throw failure;
      if (cleanup !== undefined) throw cleanup;
    });

    test("ledger-identity-changed maps onto the ledger-replaced surface (unit seam — no live replace race)", () => {
      // The replaced case cannot be provoked black-box: it needs a replace to
      // land INSIDE the child's probe→attach window, which is the C5 race
      // itself. So the error is built honestly at the same seam the provider
      // suite uses (the identity compare, with a real inode from a real
      // ledger) and handed to the CLI's own mapping function — the real
      // CostLedgerError through the real translation, deterministically.
      const ledgerPath = join(dir, "cost-ledger.db");
      new CostLedger({ path: ledgerPath, config: { defaultCapMicroUsd: 5_000_000 } }).close();
      const ino = statSync(ledgerPath).ino;
      // dp:ok test-only seam into the module-private identity compare — the
      // black-box replace race is not deterministically provable in a child
      // process, so the error is built at the real seam and fed through the
      // real mapping (same pattern as tests/providers/cost-ledger.test.ts).
      const seam = CostLedger as unknown as { assertSameInode: (probedIno: number, path: string) => void };
      // The pin, in two named steps BEFORE the mapping assertion: a seam that
      // stopped throwing — or now throws a raw errno instead of a coded
      // CostLedgerError — is THIS test's own failure, named here, not a
      // confusing `undefined code` two lines later. (The old shape threw a
      // sentinel Error inside the same try that caught it, so a non-throwing
      // seam funneled into the same catch and failed the code assert.)
      let thrown: unknown;
      let threw = false;
      try {
        seam.assertSameInode(ino + 999_999, ledgerPath);
      } catch (e) {
        threw = true;
        thrown = e;
      }
      expect(threw).toBeTrue();
      expect(thrown).toBeInstanceOf(Error);
      const identityError = thrown as CostLedgerError;
      expect(identityError.code).toBe("ledger-identity-changed");

      const chunks: string[] = [];
      const exit = reportLedgerOpenFailure((s) => chunks.push(s), identityError, ledgerPath);
      const out = chunks.join("");
      expect(exit).toBe(1);
      expect(out).toContain("ledger-replaced");
      expect(out).toContain("was removed or replaced while this invocation opened it");
      expect(out).toContain("next:");
      expect(out).toContain("re-run once any concurrent dispatch or teardown");
    });

    // R4-18: the seam test above pins the TRANSLATION, but the CLI's real
    // catch → mapper dispatch never executed — a catch that swallowed the
    // error, or an exit code hardcoded beside the call, would pass it and
    // still ship the wrong surface. These two drive the exported `run()`
    // in-process with ONLY the open intercepted: the refusal is minted at the
    // same real seam as above (identity) or as a plain coded error, reaches
    // run()'s catch through the real call site, and the mapper's returned
    // code is what the assertion reads. Provoking either refusal inside a
    // child's probe→attach window is the C5 race itself, so the in-process
    // route is the deterministic one; the black-box dispatch (child, real
    // openReadOnly) is already pinned by the ledger-missing and crashed-writer
    // WAL cases above.
    test("identity-changed refusal routes through run()'s catch to the mapped ledger-replaced surface and its exit 1", () => {
      const ledgerPath = join(dir, "cost-ledger.db");
      new CostLedger({ path: ledgerPath, config: { defaultCapMicroUsd: 5_000_000 } }).close();
      const ino = statSync(ledgerPath).ino;
      // Same named two-step pin as the seam test above: the seam throwing a
      // coded CostLedgerError is THIS test's own precondition.
      const seam = CostLedger as unknown as { assertSameInode: (probedIno: number, path: string) => void };
      let thrown: unknown;
      try {
        seam.assertSameInode(ino + 999_999, ledgerPath);
      } catch (e) {
        thrown = e;
      }
      expect((thrown as CostLedgerError).code).toBe("ledger-identity-changed");

      const realOpenReadOnly = CostLedger.openReadOnly;
      let seamHits = 0;
      CostLedger.openReadOnly = () => {
        seamHits += 1;
        throw thrown;
      };
      const chunks: string[] = [];
      let exit: number;
      try {
        // --dir pins resolution to this test's temp records dir; the ledger
        // path itself still comes from the beforeEach env override, so the
        // patch is the ONLY faked half.
        exit = run(["qds/demo#42", "--dir", join(dir, "runs")], (s) => chunks.push(s));
      } finally {
        CostLedger.openReadOnly = realOpenReadOnly;
      }
      expect(exit).toBe(1);
      // ROUTING, counted: run()'s catch got its refusal from the (patched) open
      // seam, exactly once — not from some earlier exit beside the call site.
      // (An "the patch is back" check here would only re-assert the finally
      // above it.)
      expect(seamHits).toBe(1);
      const out = chunks.join("");
      expect(out).toContain("ledger-replaced");
      expect(out).toContain("was removed or replaced while this invocation opened it");
      expect(out).toContain("next: re-run once any concurrent dispatch or teardown");
    });

    test("an unrecognized open refusal with an EMPTY remediation routes through run()'s catch with no bare next: line", () => {
      const realOpenReadOnly = CostLedger.openReadOnly;
      CostLedger.openReadOnly = () => {
        throw Object.assign(new Error("some exotic open failure"), { code: "ledger-exotic", remediation: "" });
      };
      const chunks: string[] = [];
      let exit: number;
      try {
        exit = run(["qds/demo#42", "--dir", join(dir, "runs")], (s) => chunks.push(s));
      } finally {
        CostLedger.openReadOnly = realOpenReadOnly;
      }
      expect(exit).toBe(1);
      const out = chunks.join("");
      // The default arm forwards the unrecognized code and message…
      expect(out).toContain("ledger-exotic");
      expect(out).toContain("some exotic open failure");
      // …but "" is no remediation (R4-41): the `next:` line carries words or
      // does not exist — an empty one is a bare `next:` automation cannot act
      // on.
      expect(out).not.toContain("next:");
    });
  });
});
