/**
 * Runtime tests for the qds-audit CLI (DF5.3): the exit-code matrix
 * (0 complete / 1 broken chain / 2 bad invocation), the --json contract
 * (ChainReport verbatim on stdout, logs on stderr), the four store-path
 * seams (a fixture walk never touches the developer's `.sandbox/`), and
 * INV-AUDIT-2 (no secret material in stdout or stderr).
 *
 * Drives the REAL script through Bun.spawnSync. Fixtures are built with the
 * real stores (RunRecordStore, CostLedger, openAuditStore, the trace schema)
 * — the minimal fixture set this file needs, copied from the chain suite's
 * approach rather than imported from it (test files never import test files).
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";

import { OQ4_VOID_REASON, type AuditLinkInput, type ChainReport } from "../../src/audit/index.ts";
import { canonicalJson, openAuditStore, sha256Hex } from "../../src/audit/link-store.ts";
import { applyMigrations, SCHEMA_DDL } from "../../src/phase-engine/trace/schema.ts";
import type { CostEvent } from "../../cli-anything/src/types.ts";
import { CostLedger } from "../../src/providers/cost-ledger.ts";
import { RunRecordStore } from "../../src/providers/run-record.ts";

const SCRIPT = join(import.meta.dir, "../../scripts/qds-audit.ts");

// ─── fixture constants ───────────────────────────────────────────────────────

const T0 = Date.parse("2026-09-16T10:00:00.000Z");
const iso = (minute: number): string => new Date(T0 + minute * 60_000).toISOString();
const RUN = "qds-20260916-c7d8e9";
const REQ = "req-df53-cli01";
const SLUG = "acme/widgets";
const ISSUE = "42";
const PR_URL = "https://github.com/acme/widgets/pull/57";
const COMPLETED_AT = iso(10);
const DECIDED_AT = iso(11);
const PR_CREATED = iso(12); // strict chain: completedAt < decidedAt < pr.createdAt
const REPORT_ID = `rv-${RUN}-0001`;
const HEAD = "a".repeat(40);
const KEY_HASH = `sha256:${"ab".repeat(32)}`;
const GH_TOKEN = "ghp_TESTTOKEN00000000000000000000000";
const PROVISIONING_KEY = "sk-or-v1-TESTSECRET0000000000000000000";

// ─── fixture builders ────────────────────────────────────────────────────────

interface FixturePaths {
  dir: string;
  runsDir: string;
  auditDb: string;
  ledgerPath: string;
  reverifyDir: string;
}

let fx: FixturePaths;

beforeEach(() => {
  const dir = mkdtempSync(join(tmpdir(), "qds-df53-cli-"));
  fx = {
    dir,
    runsDir: join(dir, "runs"),
    auditDb: join(dir, "audit.db"),
    ledgerPath: join(dir, "cost-ledger.db"),
    reverifyDir: join(dir, "reverify"),
  };
  mkdirSync(fx.runsDir, { recursive: true, mode: 0o700 });
});

afterEach(() => {
  rmSync(fx.dir, { recursive: true, force: true });
});

/**
 * The CLI runs with NO .sandbox anywhere on its path — the seams are the
 * point. The hostile defaults are evaluated at spawn time (against THIS
 * fixture's tmp dir): if any of the four explicit paths leaks to an env
 * default, the walk reads (or worse, creates) there instead of the fixture.
 */
function spawnEnv(): Record<string, string> {
  return {
    GH_TOKEN,
    OPENROUTER_PROVISIONING_KEY: PROVISIONING_KEY,
    QDS_AUDIT_DB: join(fx.dir, "must-not-be-touched.db"),
    QDS_RUNS_DIR: join(fx.dir, "must-not-be-touched-runs"),
  };
}

interface SpawnResult {
  code: number;
  stdout: string;
  stderr: string;
}

function spawnAudit(argv: string[]): SpawnResult {
  const env = spawnEnv();
  const proc = Bun.spawnSync(["bun", SCRIPT, ...argv], {
    cwd: fx.dir,
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, ...env },
  });
  return {
    code: proc.exitCode ?? 1,
    stdout: proc.stdout.toString(),
    stderr: proc.stderr.toString(),
  };
}

function auditFlags(): string[] {
  return [
    "--runs-dir", fx.runsDir,
    "--audit-db", fx.auditDb,
    "--ledger", fx.ledgerPath,
    "--reverify-dir", fx.reverifyDir,
  ];
}

function seedRecord(): void {
  const store = new RunRecordStore({ dir: fx.runsDir });
  store.create(RUN, new Date(iso(0)));
  store.set(RUN, {
    requestId: REQ,
    keyHash: KEY_HASH,
    httpsUrl: "https://vm.example.exec/",
    limitMicroUsd: 50_000_000,
    extensions: {
      budget: {
        repoSlug: SLUG, issueId: ISSUE,
        capMicroUsd: 50_000_000, spentMicroUsd: 0, reservedMicroUsd: 0, admittedCeilingMicroUsd: 50_000_000,
      },
      pr: { prUrl: PR_URL, prNumber: 57, createdAt: PR_CREATED },
      approval: {
        state: "approved", proposal: "ship it", reportId: REPORT_ID, headSha: HEAD,
        requestId: REQ, expiresAt: iso(60), requestedAt: iso(9),
        approverId: "alice", decidedAt: DECIDED_AT, reason: "green report",
      },
    },
  });
  store.close(RUN, new Date(iso(30)));
}

function link(over: Partial<AuditLinkInput>): AuditLinkInput {
  return {
    runId: RUN, repoSlug: SLUG, requestId: REQ,
    hop: "run-credential", event: "mint",
    evidenceDigest: sha256Hex(canonicalJson(null)),
    occurredAt: iso(2), recordedAt: iso(2),
    ...over,
  };
}

function seedLinks(rows: AuditLinkInput[]): void {
  const store = openAuditStore(fx.auditDb);
  try {
    for (const row of rows) store.record(row);
  } finally {
    store.close();
  }
}

function credentialLinks(withRevoke = true): AuditLinkInput[] {
  const detail = { keyHash: KEY_HASH, limitMicroUsd: 50_000_000 };
  return (["mint", "deliver", ...(withRevoke ? ["revoke"] : []), "verify-revoked"] as const).map((event, i) =>
    link({
      hop: "run-credential", event, subjectId: KEY_HASH, subjectKind: "run-key",
      evidencePath: join(fx.runsDir, `${RUN}.json`), detail,
      evidenceDigest: sha256Hex(canonicalJson(detail)),
      occurredAt: iso(2 + i), recordedAt: iso(2 + i),
    }),
  );
}

function boxLinks(): AuditLinkInput[] {
  return (["create", "fill", "setup-gate", "teardown"] as const).map((event, i) =>
    link({
      hop: "run-box", event, subjectId: RUN, subjectKind: "box",
      evidencePath: join(fx.runsDir, `${RUN}.json`), detail: { attempt: i },
      evidenceDigest: sha256Hex(canonicalJson({ attempt: i })),
      occurredAt: iso(4 + i), recordedAt: iso(4 + i),
    }),
  );
}

function bundlePath(): string {
  return join(fx.runsDir, `${RUN}.bundle`);
}

function bundleLinks(): AuditLinkInput[] {
  const bytes = readFileSync(bundlePath());
  const sha = createHash("sha256").update(bytes).digest("hex");
  const verifyDetail = { sha256: sha, bytes: bytes.byteLength };
  return [
    link({
      hop: "run-bundle", event: "bundle-verify", subjectId: RUN, subjectKind: "bundle",
      evidencePath: bundlePath(), detail: verifyDetail,
      evidenceDigest: sha256Hex(canonicalJson(verifyDetail)),
      occurredAt: iso(5), recordedAt: iso(5),
    }),
    link({
      hop: "run-bundle", event: "bundle-fetch", subjectId: RUN, subjectKind: "bundle",
      evidencePath: bundlePath(), detail: { fetched: true },
      evidenceDigest: sha256Hex(canonicalJson({ fetched: true })),
      occurredAt: iso(6), recordedAt: iso(6),
    }),
  ];
}

function seedEmittedLinks(): void {
  writeFileSync(bundlePath(), `bundle-bytes-${RUN}\n`, { mode: 0o600 });
  seedLinks([...credentialLinks(), ...boxLinks(), ...bundleLinks()]);
}

function buildTrace(): void {
  const traceDir = join(fx.runsDir, `${RUN}-artifacts`, "trace");
  mkdirSync(traceDir, { recursive: true, mode: 0o700 });
  const db = new Database(join(traceDir, "trace.db"));
  try {
    for (const ddl of SCHEMA_DDL) db.exec(ddl);
    applyMigrations(db);
    db.prepare(
      "INSERT INTO sessions (request_id, request, status, started_at, ended_at, repo_slug, issue_id) VALUES (?,?,?,?,?,?,?)",
    ).run(REQ, "do the thing", "success", iso(1), iso(9), SLUG, ISSUE);
    db.prepare("INSERT INTO gate_results (request_id, phase_id, attempt, gate, passed) VALUES (?,?,?,?,?)")
      .run(REQ, "verify", 0, "tests-pass", 1);
  } finally {
    db.close();
  }
}

function seedLedger(): void {
  const ledger = new CostLedger({
    path: fx.ledgerPath,
    readRunRecord: (id) =>
      id === RUN
        ? { keyHash: KEY_HASH, limitMicroUsd: 50_000_000, createdAt: iso(0), closedAt: iso(30) }
        : undefined,
    config: { defaultCapMicroUsd: 50_000_000, boxHourRateMicroUsd: 3_600_000 },
  });
  try {
    const event = (): CostEvent => ({
      agentId: "lead-1", model: "cheap/model",
      inputTokens: 1_000, outputTokens: 500, cacheReadTokens: 200, cacheWriteTokens: 100,
      costUsd: 0.012345, turnCount: 3, unpricedTurns: 0, durationMs: 1_500,
      timestamp: iso(20),
    });
    ledger.ingestCostEvent(event(), { runId: RUN, repoSlug: SLUG, issueId: ISSUE, requestId: REQ, role: "lead", invocationSeq: 0 });
    ledger.ingestBoxHours({ runId: RUN, repoSlug: SLUG, issueId: ISSUE, requestId: REQ });
  } finally {
    ledger.close();
  }
}

function writeReverifyReport(): void {
  const report = {
    reverifyId: REPORT_ID, runId: RUN, requestId: REQ, headSha: HEAD, baseSha: "b".repeat(40),
    startedAt: iso(8), completedAt: COMPLETED_AT, durationMs: 45_000,
    checks: [{ item: "tests-pass", ok: true, note: "12 passed" }],
    testResults: { passed: 12, failed: 0 },
    flags: [], discrepancies: [],
    claimed: { exitStatus: "success", testResults: { passed: 12, failed: 0 }, changedFiles: ["src/x.ts"] },
    toolchain: { bun: "1.1" },
    timings: { worktree_ms: 10, install_ms: 20, tests_ms: 30, gates_ms: 40, cleanup_ms: 50 },
    verdict: "green",
  };
  mkdirSync(fx.reverifyDir, { recursive: true, mode: 0o700 });
  writeFileSync(join(fx.reverifyDir, `${RUN}.jsonl`), `${JSON.stringify(report)}\n`, { mode: 0o600 });
}

function buildCompleteFixture(): void {
  seedRecord();
  buildTrace();
  seedLedger();
  seedEmittedLinks();
  writeReverifyReport();
}

// ─── 1. the complete fixture ─────────────────────────────────────────────────

describe("complete fixture", () => {
  test("--json: ChainReport verbatim on stdout, complete, exit 0, seams respected", () => {
    buildCompleteFixture();
    const r = spawnAudit([RUN, "--json", ...auditFlags()]);
    expect(r.code).toBe(0);
    const report = JSON.parse(r.stdout.trim()) as ChainReport;
    expect(report.ref).toBe(RUN);
    expect(report.refKind).toBe("run-id");
    expect(report.complete).toBe(true);
    expect(typeof report.timings.prFetchMs).toBe("number");
    const run = Object.values(report.runs)[0]!;
    expect(Object.keys(run.hops)).toHaveLength(10);
    expect(run.hops["memory-retain-receipt"]).toEqual({ status: "void", hop: "memory-retain-receipt", reason: OQ4_VOID_REASON });
    expect(run.hops["run-cost"]?.status).toBe("resolved");
    // stdout carries the report and nothing else; stderr is the log stream:
    // the walker logs the per-hop lines itself, and the CLI adds exactly ONE
    // aggregated verdict line — no CLI-level double-logging of hops.
    expect(r.stdout.startsWith("{")).toBe(true);
    expect(r.stderr.split("audit-chain.verdict").length - 1).toBe(1);
    expect(r.stderr.split('"operation":"audit-chain.hop"').length - 1).toBe(10);
    // CWD independence: nothing under the fixture cwd's default paths.
    expect(existsSync(join(fx.dir, ".sandbox"))).toBe(false);
    expect(existsSync(join(fx.dir, "must-not-be-touched.db"))).toBe(false);
  });

  test("human mode: per-hop blocks, VOID reason verbatim, COMPLETE summary", () => {
    buildCompleteFixture();
    const r = spawnAudit([RUN, ...auditFlags()]);
    expect(r.code).toBe(0);
    for (const hop of ["pr-run", "run-cost", "run-credential", "run-box", "run-bundle", "run-reverify", "run-approval", "run-gate-evidence", "memory-retain-receipt"]) {
      expect(r.stdout).toContain(hop);
    }
    expect(r.stdout).toContain(OQ4_VOID_REASON); // verbatim
    expect(r.stdout).toContain("chain: COMPLETE");
    // credential hop: hash + 8-char prefix, never key material
    expect(r.stdout).toContain(KEY_HASH.slice(0, 8));
  });
});

// ─── 2. the broken chain ─────────────────────────────────────────────────────

describe("broken chain", () => {
  test("exit 1; human output names hop + expected/actual/diagnostic; --json still prints the report", () => {
    buildCompleteFixture();
    rmSync(fx.ledgerPath); // run-cost broken, not merely empty
    const human = spawnAudit([RUN, ...auditFlags()]);
    expect(human.code).toBe(1);
    expect(human.stdout).toContain("run-cost");
    expect(human.stdout).toContain("a readable cost ledger");
    expect(human.stdout).toContain("chain: BROKEN");

    const json = spawnAudit([RUN, "--json", ...auditFlags()]);
    expect(json.code).toBe(1);
    const report = JSON.parse(json.stdout.trim()) as ChainReport;
    expect(report.complete).toBe(false);
    const run = Object.values(report.runs)[0]!;
    expect(run.hops["run-cost"]?.status).toBe("broken");
  });

  test("a missing emitted link (revoke) is a named unlinked hop, exit 1", () => {
    buildCompleteFixture();
    // Rebuild the store without the revoke row: append-only, so a fresh store.
    rmSync(fx.auditDb);
    writeFileSync(bundlePath(), `bundle-bytes-${RUN}\n`, { mode: 0o600 });
    seedLinks([...credentialLinks(false), ...boxLinks(), ...bundleLinks()]);
    const r = spawnAudit([RUN, ...auditFlags()]);
    expect(r.code).toBe(1);
    expect(r.stdout).toContain("run-credential");
    expect(r.stdout).toContain("no audit_links row for run-credential event(s) revoke");
    expect(r.stdout).toContain("chain: BROKEN");
  });
});

// ─── 3. the invalid ref ──────────────────────────────────────────────────────

describe("invalid ref", () => {
  test("exit 2 with message + remediation", () => {
    const r = spawnAudit(["BAD_REF", ...auditFlags()]);
    expect(r.code).toBe(2);
    const out = r.stdout + r.stderr;
    expect(out).toContain("invalid-ref");
    expect(out).toContain("not a PR URL");
    expect(out).toContain("next: pass the merged PR URL");
  });

  test("usage: no ref → exit 2 with the usage line", () => {
    const r = spawnAudit([...auditFlags()]);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("Usage: qds-audit");
  });

  test("usage: two refs → exit 2", () => {
    const r = spawnAudit(["run-a", "run-b"]);
    expect(r.code).toBe(2);
  });
});

// ─── 4. the seams redirect ───────────────────────────────────────────────────

describe("store-path seams", () => {
  test("--audit-db at a nonexistent path: typed audit-store-absent refusal, file still absent, exit 1", () => {
    buildCompleteFixture();
    const absent = join(fx.dir, "subdir", "not-there.db");
    const r = spawnAudit([RUN, "--json", ...auditFlags().slice(0, 2), "--audit-db", absent, ...auditFlags().slice(4)]);
    expect(r.code).toBe(1);
    const report = JSON.parse(r.stdout.trim()) as ChainReport;
    const run = Object.values(report.runs)[0]!;
    expect(run.hops["run-credential"]?.status).toBe("broken");
    expect((run.hops["run-credential"] as { actual: string }).actual).toBe("audit-store-absent");
    expect(run.hops["run-box"]?.status).toBe("broken");
    expect(run.hops["run-bundle"]?.status).toBe("broken");
    // the walk never materialised the store it audits
    expect(existsSync(absent)).toBe(false);
  });
});

// ─── 5. redaction (INV-AUDIT-2) ──────────────────────────────────────────────

describe("INV-AUDIT-2 redaction", () => {
  test("no token, no provisioning key, no minted key material in stdout+stderr", () => {
    buildCompleteFixture();
    for (const json of [false, true]) {
      const r = spawnAudit([RUN, ...(json ? ["--json"] : []), ...auditFlags()]);
      const everything = r.stdout + r.stderr;
      expect(r.code).toBe(0);
      expect(everything).not.toContain(GH_TOKEN);
      expect(everything).not.toContain(PROVISIONING_KEY);
      expect(everything).not.toContain("ghp_");
      expect(everything).not.toContain("sk-or-v1-");
      // only the hash and its 8-char prefix ever appear
      expect(everything).toContain(KEY_HASH);
      expect(everything).toContain(KEY_HASH.slice(0, 8));
    }
  });
});
