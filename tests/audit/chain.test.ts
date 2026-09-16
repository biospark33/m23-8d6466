/**
 * DF5.3 audit-chain walker tests — the story DoD clauses BY NAME.
 *
 * Clause map:
 *  1. complete run: ten hops, zero nulls, one key, memory VOID (exact OQ-4
 *     reason), cost µ$ + perRole + hasTokenRows:true — AND a hasTokenRows:false
 *     fixture pinning the single-key tolerance as tolerance, never expectation
 *  2. PR body with no runId → hop 1 named expected/actual/diagnostic; the other
 *     nine resolved yet the chain reports incomplete, never complete
 *  3. in-box-evidence negative control: reverify record absent, in-box
 *     gate_results green → hop 7 BROKEN (INV-AUDIT-5)
 *  4. per-run isolation: hop 9 of each run reads only its own trace rows, hop 8
 *     only its own record — a globbing implementation fails
 *  5. hot-WAL recovery through a temp-dir copy (artifacts byte-identical, no
 *     -shm) PLUS the trace/ prefix fixture: root-level decoy trace.db vs
 *     trace/trace.db
 *  6. the walker never creates audit.db (typed refusal on hops 4/5/6, path
 *     still absent); identity-window cases are pinned at store level
 *     (tests/audit/link-store.test.ts) and not duplicated here
 *  7. authorizing-record tamper: bound-report verdict edit → evidence-mismatch;
 *     a lawful second report and lawful closedAt/spendMicroUsd writes do NOT
 *     mismatch (hops 1 and 8 digests are entry-scoped)
 *  8. ordering: revoke-before-mint, decidedAt-before-completedAt and EQUAL
 *     decidedAt/completedAt violate; a shared-ms credential pair does not
 *  9. reap not-applicable on a cleanly torn-down run (an unlinked fails this)
 * 10. evidence-not-harvested distinct from unlinked, naming paths
 * 11. hop-timeout fail-closed (tiny ceiling override + slow hop-1 seam)
 * 12. redaction (INV-AUDIT-2): no token, no OPENROUTER_PROVISIONING_KEY value,
 *     no minted key material in the report or any log line
 *
 * Every test builds REAL stores in its own tmpdir: RunRecordStore, the real
 * audit store (openAuditStore), a real CostLedger, real report JSONL and real
 * trace DBs (SCHEMA_DDL + applyMigrations).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { OQ4_VOID_REASON, chainVerdict, walkAuditChain } from "../../src/audit/index.ts";
import type { AuditLinkInput, ChainReport, HopOutcome } from "../../src/audit/index.ts";
import { REAP_NOT_APPLICABLE_REASON } from "../../src/audit/chain.ts";
import { applyMigrations, SCHEMA_DDL } from "../../src/phase-engine/trace/schema.ts";
import type { CostEvent } from "../../cli-anything/src/types.ts";
import { CostLedger } from "../../src/providers/cost-ledger.ts";
import { RunRecordStore } from "../../src/providers/run-record.ts";
import { setLogSink } from "../../src/swarmclaw/log.ts";
import { canonicalJson, openAuditStore, sha256Hex } from "../../src/audit/link-store.ts";

// ─── fixture constants ───────────────────────────────────────────────────────

const T0 = Date.parse("2026-09-16T10:00:00.000Z");
const iso = (minute: number): string => new Date(T0 + minute * 60_000).toISOString();
const RUN = "qds-20260916-a1b2c3";
const RUN_B = "qds-20260916-d4e5f6";
const REQ = "req-df53-aaaa";
const REQ_B = "req-df53-bbbb";
const SLUG = "acme/widgets";
const ISSUE = "42";
const PR_URL = "https://github.com/acme/widgets/pull/57";
const PR_CREATED = iso(12); // pr.createdAt, after the approval (AC7 strict)
const COMPLETED_AT = iso(10);
const DECIDED_AT = iso(11);
const REPORT_ID = `rv-${RUN}-0001`;
const REPORT_ID_B = `rv-${RUN_B}-0001`;
const HEAD = "a".repeat(40);
const KEY_HASH = `sha256:${"ab".repeat(32)}`;

let dir: string;
let prevCwd: string;
let runsDir: string;
let auditDb: string;
let ledgerPath: string;
let reverifyDir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "qds-df53-chain-"));
  prevCwd = process.cwd();
  process.chdir(dir);
  runsDir = join(dir, "runs");
  auditDb = join(dir, "audit.db");
  ledgerPath = join(dir, "cost-ledger.db");
  reverifyDir = join(dir, "reverify");
  mkdirSync(runsDir, { recursive: true, mode: 0o700 });
});

afterEach(() => {
  process.chdir(prevCwd);
  rmSync(dir, { recursive: true, force: true });
});

// ─── fixture builders ────────────────────────────────────────────────────────

interface RecordSpec {
  runId: string;
  requestId: string;
  reportId?: string;
  prUrl?: string;
  prCreatedAt?: string;
  httpsUrl?: string;
  closedAt?: Date;
  superseded?: string[];
}

/** Real RunRecordStore writes: create → set (core + extensions) → close. */
function seedRecord(spec: RecordSpec): void {
  const store = new RunRecordStore({ dir: runsDir });
  store.create(spec.runId, new Date(iso(0)));
  const extensions: Record<string, Record<string, string | number | string[]>> = {
    budget: {
      repoSlug: SLUG, issueId: ISSUE,
      capMicroUsd: 50_000_000, spentMicroUsd: 0, reservedMicroUsd: 0, admittedCeilingMicroUsd: 50_000_000,
    },
  };
  if (spec.prUrl !== undefined) {
    extensions.pr = { prUrl: spec.prUrl, prNumber: 57, createdAt: spec.prCreatedAt ?? PR_CREATED };
  }
  if (spec.reportId !== undefined) {
    extensions.approval = {
      state: "approved", proposal: "ship it", reportId: spec.reportId, headSha: HEAD,
      requestId: spec.requestId, expiresAt: iso(60), requestedAt: iso(9),
      ...(spec.superseded !== undefined ? { supersededReportIds: spec.superseded } : {}),
      approverId: "alice", decidedAt: DECIDED_AT, reason: "green report",
    };
  }
  store.set(spec.runId, {
    requestId: spec.requestId,
    keyHash: KEY_HASH,
    httpsUrl: spec.httpsUrl ?? "https://vm.example.exec/",
    limitMicroUsd: 50_000_000,
    extensions,
  });
  if (spec.closedAt !== undefined) store.close(spec.runId, spec.closedAt);
}

/** A complete ReverifyReport line the report layer's own schema accepts. */
function mkReport(runId: string, requestId: string, reverifyId: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    reverifyId, runId, requestId, headSha: HEAD, baseSha: "b".repeat(40),
    startedAt: iso(8), completedAt: COMPLETED_AT, durationMs: 45_000,
    checks: [{ item: "tests-pass", ok: true, note: "12 passed" }],
    testResults: { passed: 12, failed: 0 },
    flags: [], discrepancies: [],
    claimed: { exitStatus: "success", testResults: { passed: 12, failed: 0 }, changedFiles: ["src/x.ts"] },
    toolchain: { bun: "1.1" },
    timings: { worktree_ms: 10, install_ms: 20, tests_ms: 30, gates_ms: 40, cleanup_ms: 50 },
    verdict: "green",
    ...over,
  };
}

function writeReports(runId: string, reports: Record<string, unknown>[]): void {
  mkdirSync(reverifyDir, { recursive: true, mode: 0o700 });
  writeFileSync(join(reverifyDir, `${runId}.jsonl`), reports.map((r) => `${JSON.stringify(r)}\n`).join(""), { mode: 0o600 });
}

/** Real trace DB with the DF1.8 correlation columns + gate rows. */
function buildTrace(
  artifactsDir: string,
  opts: { requestId: string; repoSlug?: string | null; issueId?: string | null; gates?: { gate: string; passed: number }[] },
): void {
  const traceDir = join(artifactsDir, "trace");
  mkdirSync(traceDir, { recursive: true, mode: 0o700 });
  const db = new Database(join(traceDir, "trace.db"));
  try {
    for (const ddl of SCHEMA_DDL) db.exec(ddl);
    applyMigrations(db);
    db.prepare(
      "INSERT INTO sessions (request_id, request, status, started_at, ended_at, repo_slug, issue_id) VALUES (?,?,?,?,?,?,?)",
    ).run(opts.requestId, "do the thing", "success", iso(1), iso(9), opts.repoSlug ?? null, opts.issueId ?? null);
    for (const [i, gate] of (opts.gates ?? []).entries()) {
      db.prepare("INSERT INTO gate_results (request_id, phase_id, attempt, gate, passed) VALUES (?,?,?,?,?)")
        .run(opts.requestId, "verify", i, gate.gate, gate.passed);
    }
  } finally {
    db.close();
  }
}

/** The decoy the real tar carries at the artifacts ROOT (no gate_results table). */
function buildDecoyRootTrace(artifactsDir: string): void {
  const db = new Database(join(artifactsDir, "trace.db"));
  try {
    db.exec("CREATE TABLE sessions (request_id TEXT PRIMARY KEY, request TEXT)");
    db.prepare("INSERT INTO sessions (request_id, request) VALUES (?,?)").run("decoy-request", "not the run");
  } finally {
    db.close();
  }
}

/**
 * Hot-WAL fixture: trace.db + trace.db-wal at rest with NO -shm, the
 * gate_results row reachable ONLY through the WAL. Built by copying the pair
 * out while a live connection still holds them, then restoring the pair after
 * the close checkpoint removes the originals.
 */
function buildHotWalTrace(artifactsDir: string, requestId: string): void {
  const traceDir = join(artifactsDir, "trace");
  mkdirSync(traceDir, { recursive: true, mode: 0o700 });
  const dbPath = join(traceDir, "trace.db");
  const staging = mkdtempSync(join(tmpdir(), "qds-df53-wal-"));
  try {
    const db = new Database(dbPath);
    try {
      db.exec("PRAGMA journal_mode = WAL;");
      for (const ddl of SCHEMA_DDL) db.exec(ddl);
      applyMigrations(db);
      db.prepare("INSERT INTO sessions (request_id, repo_slug, issue_id) VALUES (?,?,?)").run(requestId, SLUG, ISSUE);
      // The row the walker must recover: it lives only in the -wal.
      db.prepare("INSERT INTO gate_results (request_id, phase_id, attempt, gate, passed) VALUES (?,?,?,?,?)")
        .run(requestId, "verify", 0, "wal-only-gate", 1);
      // Copy while the connection is OPEN (wal + shm exist on disk); copy only
      // db + wal — the -shm is deliberately omitted, like harvest.ts ships it.
      copyFileSync(dbPath, join(staging, "trace.db"));
      copyFileSync(`${dbPath}-wal`, join(staging, "trace.db-wal"));
    } finally {
      db.close(); // checkpoints + removes the originals' -wal/-shm
    }
    copyFileSync(join(staging, "trace.db"), dbPath);
    copyFileSync(join(staging, "trace.db-wal"), `${dbPath}-wal`);
    if (existsSync(`${dbPath}-shm`)) rmSync(`${dbPath}-shm`);
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
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
  const store = openAuditStore(auditDb);
  try {
    for (const row of rows) store.record(row);
  } finally {
    store.close();
  }
}

function credentialLinks(runId = RUN, requestId = REQ, base = 2): AuditLinkInput[] {
  const events: [string, string][] = [["mint", "m"], ["deliver", "d"], ["revoke", "r"], ["verify-revoked", "v"]];
  return events.map(([event], i) =>
    link({
      runId, requestId, event, subjectId: KEY_HASH, subjectKind: "run-key",
      evidencePath: join(runsDir, `${runId}.json`),
      detail: { keyHash: KEY_HASH, limitMicroUsd: 50_000_000 },
      evidenceDigest: sha256Hex(canonicalJson({ keyHash: KEY_HASH, limitMicroUsd: 50_000_000 })),
      occurredAt: iso(base + i * 0.5 + 0), recordedAt: iso(base + i),
    }),
  );
}

function boxLinks(runId = RUN, requestId = REQ): AuditLinkInput[] {
  return (["create", "fill", "setup-gate", "teardown"] as const).map((event, i) =>
    link({
      runId, requestId, hop: "run-box", event, subjectId: runId, subjectKind: "box",
      evidencePath: join(runsDir, `${runId}.json`), detail: { attempt: i },
      evidenceDigest: sha256Hex(canonicalJson({ attempt: i })),
      occurredAt: iso(4 + i), recordedAt: iso(4 + i),
    }),
  );
}

function bundleFile(runId = RUN): string {
  const path = join(runsDir, `${runId}.bundle`);
  writeFileSync(path, `bundle-bytes-${runId}\n`, { mode: 0o600 });
  return path;
}

function bundleLinks(runId = RUN, requestId = REQ): AuditLinkInput[] {
  const path = bundleFile(runId);
  const bytes = readFileSync(path);
  const sha = createHash("sha256").update(bytes).digest("hex");
  const verifyDetail = { sha256: sha, bytes: bytes.byteLength };
  return [
    link({
      runId, requestId, hop: "run-bundle", event: "bundle-verify", subjectId: runId, subjectKind: "bundle",
      evidencePath: path, detail: verifyDetail, evidenceDigest: sha256Hex(canonicalJson(verifyDetail)),
      occurredAt: iso(5), recordedAt: iso(5),
    }),
    link({
      runId, requestId, hop: "run-bundle", event: "bundle-fetch", subjectId: runId, subjectKind: "bundle",
      evidencePath: path, detail: { fetched: true }, evidenceDigest: sha256Hex(canonicalJson({ fetched: true })),
      occurredAt: iso(6), recordedAt: iso(6),
    }),
  ];
}

/** Real CostLedger (write path), production-shaped: token rows + box hours. */
function seedLedger(runId = RUN, requestId = REQ, withTokens = true): void {
  const ledger = new CostLedger({
    path: ledgerPath,
    readRunRecord: (id) =>
      id === runId
        ? { keyHash: KEY_HASH, limitMicroUsd: 50_000_000, createdAt: iso(0), closedAt: iso(30) }
        : undefined,
    config: { defaultCapMicroUsd: 50_000_000, boxHourRateMicroUsd: 3_600_000 },
  });
  try {
    if (withTokens) {
      const event = (over: Partial<CostEvent>): CostEvent => ({
        agentId: "lead-1", model: "cheap/model",
        inputTokens: 1_000, outputTokens: 500, cacheReadTokens: 200, cacheWriteTokens: 100,
        costUsd: 0.012345, turnCount: 3, unpricedTurns: 0, durationMs: 1_500,
        timestamp: iso(20), ...over,
      });
      ledger.ingestCostEvent(event({}), { runId, repoSlug: SLUG, issueId: ISSUE, requestId, role: "lead", invocationSeq: 0 });
      ledger.ingestCostEvent(event({ agentId: "worker-1", costUsd: 0.002, inputTokens: 10 }), { runId, repoSlug: SLUG, issueId: ISSUE, requestId, role: "worker", invocationSeq: 1 });
    }
    ledger.ingestBoxHours({ runId, repoSlug: SLUG, issueId: ISSUE, requestId });
  } finally {
    ledger.close();
  }
}

function fetchPullOk(_ref: string): Promise<{ body: string; headRef?: string; prUrl: string }> {
  return Promise.resolve({ body: `Automated fix for run ${RUN}\n`, headRef: `qds/${RUN}`, prUrl: PR_URL });
}

const walkOpts = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  runsDir, auditDb, ledger: ledgerPath, reverifyDir, fetchPull: fetchPullOk, ...over,
});

function walk(ref: string, over: Record<string, unknown> = {}): Promise<ChainReport> {
  return walkAuditChain(ref, walkOpts(over) as never);
}

function hopOf(report: ChainReport, hop: string): HopOutcome {
  const key = Object.keys(report.runs)[0];
  if (key === undefined) throw new Error(`no run key in report for ${report.ref}`);
  const run = report.runs[key];
  const out = run !== undefined ? (run.hops as Record<string, HopOutcome | undefined>)[hop] : undefined;
  if (out === undefined) throw new Error(`no outcome for hop ${hop}`);
  return out;
}

function dirFingerprints(root: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const name of readdirSync(root)) {
    out.set(name, createHash("sha256").update(readFileSync(join(root, name))).digest("hex"));
  }
  return out;
}

// ─── 1. the complete run ─────────────────────────────────────────────────────

describe("complete run (DoD: ten hops, zero nulls, one key)", () => {
  test("production-shaped: ten typed hops, memory VOID, µ$ cost with real role buckets", async () => {
    seedRecord({ runId: RUN, requestId: REQ, reportId: REPORT_ID, prUrl: PR_URL, closedAt: new Date(iso(30)) });
    seedLedger();
    seedLinks([...credentialLinks(), ...boxLinks(), ...bundleLinks()]);
    buildTrace(join(runsDir, `${RUN}-artifacts`), {
      requestId: REQ, repoSlug: SLUG, issueId: ISSUE,
      gates: [{ gate: "tests-pass", passed: 1 }, { gate: "no-secrets", passed: 1 }],
    });
    writeReports(RUN, [mkReport(RUN, REQ, REPORT_ID)]);

    const report = await walk(PR_URL);

    expect(Object.keys(report.runs)).toEqual([RUN]);
    const run = report.runs[RUN] as { hops: Record<string, HopOutcome> };
    const hopNames = [
      "pr-run", "run-issue", "run-cost", "run-credential", "run-box",
      "run-bundle", "run-reverify", "run-approval", "run-gate-evidence", "memory-retain-receipt",
    ];
    for (const name of hopNames) {
      const hop = run.hops[name] as HopOutcome | undefined;
      expect(hop).toBeDefined();
      expect(hop?.status).not.toBe("broken");
    }
    const memory = run.hops["memory-retain-receipt"] as { status: string; reason: string };
    expect(memory.status).toBe("void");
    expect(memory.reason).toBe(OQ4_VOID_REASON);
    const cost = run.hops["run-cost"] as { status: string; detail: { totalMicroUsd: number; perRole: Record<string, number>; hasTokenRows: boolean } };
    expect(cost.status).toBe("resolved");
    expect(cost.detail.totalMicroUsd).toBeGreaterThan(0);
    expect(cost.detail.hasTokenRows).toBe(true);
    expect(Object.keys(cost.detail.perRole).sort()).toEqual(["box-hours", "lead", "worker"]);
    expect(report.complete).toBe(true);
    expect(chainVerdict(report).complete).toBe(true);
  });

  test("hasTokenRows:false (box-hours only) resolves identically complete — tolerance, not expectation", async () => {
    seedRecord({ runId: RUN, requestId: REQ, reportId: REPORT_ID, prUrl: PR_URL, closedAt: new Date(iso(30)) });
    seedLedger(undefined, undefined, false);
    seedLinks([...credentialLinks(), ...boxLinks(), ...bundleLinks()]);
    buildTrace(join(runsDir, `${RUN}-artifacts`), { requestId: REQ, repoSlug: SLUG, issueId: ISSUE, gates: [{ gate: "tests-pass", passed: 1 }] });
    writeReports(RUN, [mkReport(RUN, REQ, REPORT_ID)]);

    const report = await walk(RUN); // the runId form: zero network

    const cost = hopOf(report, "run-cost") as { status: string; detail: { hasTokenRows: boolean; perRole: Record<string, number> } };
    expect(cost.status).toBe("resolved");
    expect(cost.detail.hasTokenRows).toBe(false);
    expect(report.refKind).toBe("run-id");
    expect(report.timings.prFetchMs).toBe(0);
    expect(report.complete).toBe(true);
  });
});

// ─── 2. broken correlation key at hop 1 ──────────────────────────────────────

describe("PR body with no runId (DoD: named broken hop, never complete)", () => {
  test("hop 1 names expected/actual/diagnostic; the other nine resolve; the chain is incomplete", async () => {
    seedRecord({ runId: RUN, requestId: REQ, reportId: REPORT_ID, prUrl: PR_URL, closedAt: new Date(iso(30)) });
    seedLedger();
    seedLinks([...credentialLinks(), ...boxLinks(), ...bundleLinks()]);
    buildTrace(join(runsDir, `${RUN}-artifacts`), { requestId: REQ, repoSlug: SLUG, issueId: ISSUE, gates: [{ gate: "tests-pass", passed: 1 }] });
    writeReports(RUN, [mkReport(RUN, REQ, REPORT_ID)]);
    const noCorrelation = async (): Promise<{ body: string; headRef?: string; prUrl: string }> =>
      Promise.resolve({ body: "A pull request with no run correlation whatsoever.", headRef: `qds/${RUN}`, prUrl: PR_URL });

    const report = await walk(PR_URL, { fetchPull: noCorrelation });

    const hop1 = hopOf(report, "pr-run") as { status: string; expected: string; actual: string; diagnostic: string };
    expect(hop1.status).toBe("broken");
    expect(hop1.expected).toContain(RUN);
    expect(hop1.actual).toContain("absent from");
    expect(hop1.diagnostic).toContain(PR_URL);
    for (const name of ["run-issue", "run-cost", "run-credential", "run-box", "run-bundle", "run-reverify", "run-approval", "run-gate-evidence"]) {
      expect(hopOf(report, name).status).toBe("resolved");
    }
    expect(report.complete).toBe(false);
    expect(chainVerdict(report).complete).toBe(false);
    expect(chainVerdict(report).brokenHops.map((h) => h.hop)).toEqual(["pr-run"]);
  });
});

// ─── 3. in-box evidence is a claim, never authority (INV-AUDIT-5) ────────────

describe("in-box-evidence negative control (DoD: hop 7 broken without the host record)", () => {
  test("reverify record absent but in-box gate_results green → hop 7 broken", async () => {
    seedRecord({ runId: RUN, requestId: REQ, reportId: REPORT_ID, prUrl: PR_URL, closedAt: new Date(iso(30)) });
    seedLedger();
    seedLinks([...credentialLinks(), ...boxLinks(), ...bundleLinks()]);
    // In-box gate results are GREEN — and they satisfy nothing.
    buildTrace(join(runsDir, `${RUN}-artifacts`), { requestId: REQ, repoSlug: SLUG, issueId: ISSUE, gates: [{ gate: "tests-pass", passed: 1 }] });
    // No report file at all.

    const report = await walk(RUN);

    const hop7 = hopOf(report, "run-reverify") as { status: string; expected: string; evidencePath: string };
    expect(hop7.status).toBe("broken");
    expect(hop7.expected).toContain(REPORT_ID);
    expect(hop7.evidencePath).toBe(join(reverifyDir, `${RUN}.jsonl`));
    expect(hopOf(report, "run-gate-evidence").status).toBe("resolved"); // the claim still attaches
    expect(report.complete).toBe(false);
  });
});

// ─── 4. per-run isolation ────────────────────────────────────────────────────

describe("per-run isolation (DoD: side-by-side runs, no cross-run reads)", () => {
  test("hop 9 of each run sees only its own gate rows; hop 8 only its own record", async () => {
    seedRecord({ runId: RUN, requestId: REQ, reportId: REPORT_ID, prUrl: PR_URL, closedAt: new Date(iso(30)) });
    seedRecord({ runId: RUN_B, requestId: REQ_B, reportId: REPORT_ID_B, prUrl: PR_URL, closedAt: new Date(iso(30)) });
    seedLedger(RUN, REQ);
    seedLinks([
      ...credentialLinks(), ...boxLinks(), ...bundleLinks(),
      ...credentialLinks(RUN_B, REQ_B), ...boxLinks(RUN_B, REQ_B), ...bundleLinks(RUN_B, REQ_B),
    ]);
    buildTrace(join(runsDir, `${RUN}-artifacts`), { requestId: REQ, repoSlug: SLUG, issueId: ISSUE, gates: [{ gate: "tests-pass", passed: 1 }] });
    // The neighbour run carries a DISTINCTIVE gate row a globbing reader would pick up.
    buildTrace(join(runsDir, `${RUN_B}-artifacts`), {
      requestId: REQ_B, repoSlug: SLUG, issueId: ISSUE,
      gates: [{ gate: "tests-pass", passed: 1 }, { gate: "b-only-extra", passed: 1 }, { gate: "b-only-extra-2", passed: 1 }],
    });
    writeReports(RUN, [mkReport(RUN, REQ, REPORT_ID)]);
    writeReports(RUN_B, [mkReport(RUN_B, REQ_B, REPORT_ID_B)]);

    const reportA = await walk(RUN);
    const reportB = await walk(RUN_B);

    const gatesA = hopOf(reportA, "run-gate-evidence") as { status: string; detail: { count: number; rows: { gate: string }[] } };
    expect(gatesA.detail.count).toBe(1);
    expect(gatesA.detail.rows.every((r) => !r.gate.startsWith("b-only"))).toBe(true);
    const gatesB = hopOf(reportB, "run-gate-evidence") as { status: string; detail: { count: number } };
    expect(gatesB.detail.count).toBe(3);
    const approvalA = hopOf(reportA, "run-approval") as { status: string; detail: { reportId: string } };
    expect(approvalA.detail.reportId).toBe(REPORT_ID);
    const approvalB = hopOf(reportB, "run-approval") as { status: string; detail: { reportId: string } };
    expect(approvalB.detail.reportId).toBe(REPORT_ID_B);
    expect(Object.keys(reportA.runs)).toEqual([RUN]);
    expect(Object.keys(reportB.runs)).toEqual([RUN_B]);
  });
});

// ─── 5. hot-WAL recovery + the trace/ prefix ─────────────────────────────────

describe("hot-WAL recovery and the trace/ prefix (DoD)", () => {
  test("a WAL-only gate_results row resolves through the temp-dir copy; artifacts byte-identical; decoy root trace.db ignored", async () => {
    seedRecord({ runId: RUN, requestId: REQ, reportId: REPORT_ID, prUrl: PR_URL, closedAt: new Date(iso(30)) });
    seedLedger();
    seedLinks([...credentialLinks(), ...boxLinks(), ...bundleLinks()]);
    const artifacts = join(runsDir, `${RUN}-artifacts`);
    buildHotWalTrace(artifacts, REQ);
    // The collision the story names: a root-level trace.db with NO gate_results.
    buildDecoyRootTrace(artifacts);
    writeReports(RUN, [mkReport(RUN, REQ, REPORT_ID)]);

    const traceDir = join(artifacts, "trace");
    const before = dirFingerprints(traceDir);
    expect(before.has("trace.db-wal")).toBe(true);
    expect(before.has("trace.db-shm")).toBe(false);

    const report = await walk(RUN);

    const gates = hopOf(report, "run-gate-evidence") as { status: string; detail: { count: number; rows: { gate: string }[] }; evidencePath: string };
    expect(gates.status).toBe("resolved");
    expect(gates.detail.rows.map((r) => r.gate)).toContain("wal-only-gate");
    expect(gates.evidencePath).toBe(join(traceDir, "trace.db")); // trace/ prefix resolved EXACTLY
    expect(hopOf(report, "run-issue").status).toBe("resolved");
    // The artifacts directory was never written: same files, same bytes.
    const after = dirFingerprints(traceDir);
    expect([...after.keys()].sort()).toEqual([...before.keys()].sort());
    for (const [name, hash] of before) expect(after.get(name)).toBe(hash);
  });
});

// ─── 6. the walker never creates the store it audits ─────────────────────────

describe("no-create discipline (DoD: absent store refuses, path still absent)", () => {
  test("hops 4/5/6 break with the typed refusal; audit.db is still absent afterwards", async () => {
    seedRecord({ runId: RUN, requestId: REQ, reportId: REPORT_ID, prUrl: PR_URL, closedAt: new Date(iso(30)) });
    seedLedger();
    // No openAuditStore call — the fixture ships NO audit.db precisely so the branch runs.
    buildTrace(join(runsDir, `${RUN}-artifacts`), { requestId: REQ, repoSlug: SLUG, issueId: ISSUE, gates: [{ gate: "tests-pass", passed: 1 }] });
    writeReports(RUN, [mkReport(RUN, REQ, REPORT_ID)]);

    const report = await walk(RUN);

    for (const name of ["run-credential", "run-box", "run-bundle"]) {
      const hop = hopOf(report, name) as { status: string; actual: string; diagnostic: string };
      expect(hop.status).toBe("broken");
      expect(hop.actual).toBe("audit-store-absent");
      expect(hop.diagnostic).toContain("audit-link store");
    }
    expect(hopOf(report, "pr-run").status).toBe("resolved"); // digests are file-resolved
    expect(hopOf(report, "run-approval").status).toBe("resolved");
    expect(existsSync(auditDb)).toBe(false); // the path check, not a log check
    expect(report.complete).toBe(false);
    // The probe→bind identity window (replace-and-restore, removal) is pinned
    // at the store level in tests/audit/link-store.test.ts and not duplicated.
  });
});

// ─── 7. authorizing-record tamper and lawful writes ──────────────────────────

describe("authorizing-record tamper (DoD: digest coverage is entry-scoped)", () => {
  test("editing the BOUND report's verdict in place → walk 2 evidence-mismatch on hop 7", async () => {
    seedRecord({ runId: RUN, requestId: REQ, reportId: REPORT_ID, prUrl: PR_URL, closedAt: new Date(iso(30)) });
    seedLedger();
    seedLinks([...credentialLinks(), ...boxLinks(), ...bundleLinks()]);
    buildTrace(join(runsDir, `${RUN}-artifacts`), { requestId: REQ, repoSlug: SLUG, issueId: ISSUE, gates: [{ gate: "tests-pass", passed: 1 }] });
    writeReports(RUN, [mkReport(RUN, REQ, REPORT_ID)]);

    const first = await walk(RUN);
    expect(hopOf(first, "run-reverify").status).toBe("resolved");

    const reportFile = join(reverifyDir, `${RUN}.jsonl`);
    const tampered = readFileSync(reportFile, "utf8").replace('"verdict":"green"', '"verdict":"red"');
    expect(tampered).not.toContain('"verdict":"green"');
    writeFileSync(reportFile, tampered, { mode: 0o600 });

    const second = await walk(RUN);
    const hop7 = hopOf(second, "run-reverify") as { status: string; expectedDigest: string; actualDigest: string; evidencePath: string };
    expect(hop7.status).toBe("evidence-mismatch");
    expect(hop7.expectedDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(hop7.actualDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(hop7.expectedDigest).not.toBe(hop7.actualDigest);
    expect(second.complete).toBe(false);
  });

  test("appending a lawful SECOND report does not mismatch the bound one", async () => {
    seedRecord({ runId: RUN, requestId: REQ, reportId: REPORT_ID, prUrl: PR_URL, closedAt: new Date(iso(30)) });
    seedLedger();
    seedLinks([...credentialLinks(), ...boxLinks(), ...bundleLinks()]);
    buildTrace(join(runsDir, `${RUN}-artifacts`), { requestId: REQ, repoSlug: SLUG, issueId: ISSUE, gates: [{ gate: "tests-pass", passed: 1 }] });
    writeReports(RUN, [mkReport(RUN, REQ, REPORT_ID)]);
    await walk(RUN);

    // A later, unrelated re-verify appends its own line (never a rewrite).
    const second = mkReport(RUN, REQ, `rv-${RUN}-0002`, { completedAt: iso(14) });
    writeFileSync(join(reverifyDir, `${RUN}.jsonl`), `${JSON.stringify(mkReport(RUN, REQ, REPORT_ID))}\n${JSON.stringify(second)}\n`, { mode: 0o600 });

    const report = await walk(RUN);
    const hop7 = hopOf(report, "run-reverify") as { status: string; subjectId: string };
    expect(hop7.status).toBe("resolved"); // the BOUND report is still the subject
    expect(hop7.subjectId).toBe(REPORT_ID);
    expect(report.complete).toBe(true);
  });

  test("lawful closedAt/spendMicroUsd writes do not mismatch the hop 1/8 digests", async () => {
    seedRecord({ runId: RUN, requestId: REQ, reportId: REPORT_ID, prUrl: PR_URL }); // record LEFT OPEN
    seedLedger();
    seedLinks([...credentialLinks(), ...boxLinks(), ...bundleLinks()]);
    buildTrace(join(runsDir, `${RUN}-artifacts`), { requestId: REQ, repoSlug: SLUG, issueId: ISSUE, gates: [{ gate: "tests-pass", passed: 1 }] });
    writeReports(RUN, [mkReport(RUN, REQ, REPORT_ID)]);

    const first = await walk(RUN);
    expect(hopOf(first, "pr-run").status).toBe("resolved");
    expect(hopOf(first, "run-approval").status).toBe("resolved");

    const store = new RunRecordStore({ dir: runsDir });
    store.set(RUN, { spendMicroUsd: 1_234_567 }); // the lawful captureSpend write (while open)
    store.close(RUN, new Date(iso(30))); // the lawful teardown write

    const second = await walk(RUN);
    expect(hopOf(second, "pr-run").status).toBe("resolved");
    expect(hopOf(second, "run-approval").status).toBe("resolved");
    expect(hopOf(second, "run-reverify").status).toBe("resolved");
    expect(chainVerdict(second).brokenHops).toEqual([]);
  });
});

// ─── 8. ordering (AC7) ───────────────────────────────────────────────────────

describe("ordering (DoD: non-decreasing lifecycle, STRICT authorization)", () => {
  test("revoke before mint → order-violation on hop 4", async () => {
    seedRecord({ runId: RUN, requestId: REQ, reportId: REPORT_ID, prUrl: PR_URL, closedAt: new Date(iso(30)) });
    seedLedger();
    const rows = credentialLinks();
    // mint iso(2) <= deliver iso(2.5) <= revoke iso(1): the revoke precedes its mint.
    const swapped = rows.map((r) =>
      r.event === "revoke" ? { ...r, occurredAt: iso(1) } : r,
    );
    seedLinks([...swapped, ...boxLinks(), ...bundleLinks()]);
    buildTrace(join(runsDir, `${RUN}-artifacts`), { requestId: REQ, repoSlug: SLUG, issueId: ISSUE, gates: [{ gate: "tests-pass", passed: 1 }] });
    writeReports(RUN, [mkReport(RUN, REQ, REPORT_ID)]);

    const report = await walk(RUN);
    const hop4 = hopOf(report, "run-credential") as { status: string; constraint: string; earlier: string; later: string };
    expect(hop4.status).toBe("order-violation");
    expect(hop4.constraint).toContain("mint <= deliver <= revoke");
    expect(hop4.earlier).toBe(iso(2.5));
    expect(hop4.later).toBe(iso(1));
    expect(report.complete).toBe(false);
  });

  test("decidedAt before completedAt → order-violation on hop 8", async () => {
    seedRecord({ runId: RUN, requestId: REQ, reportId: REPORT_ID, prUrl: PR_URL, closedAt: new Date(iso(30)) });
    // Re-stamp the approval EARLIER than the report's completedAt.
    const store = new RunRecordStore({ dir: runsDir });
    store.set(RUN, { extensions: { approval: { approverId: "alice", decidedAt: iso(9) } } });
    seedLedger();
    seedLinks([...credentialLinks(), ...boxLinks(), ...bundleLinks()]);
    buildTrace(join(runsDir, `${RUN}-artifacts`), { requestId: REQ, repoSlug: SLUG, issueId: ISSUE, gates: [{ gate: "tests-pass", passed: 1 }] });
    writeReports(RUN, [mkReport(RUN, REQ, REPORT_ID)]);

    const report = await walk(RUN);
    const hop8 = hopOf(report, "run-approval") as { status: string; constraint: string; earlier: string; later: string };
    expect(hop8.status).toBe("order-violation");
    expect(hop8.earlier).toBe(iso(9));
    expect(hop8.later).toBe(COMPLETED_AT);
    expect(report.complete).toBe(false);
  });

  test("decidedAt EQUAL to completedAt → order-violation (strict; equality violates)", async () => {
    seedRecord({ runId: RUN, requestId: REQ, reportId: REPORT_ID, prUrl: PR_URL, closedAt: new Date(iso(30)) });
    const store = new RunRecordStore({ dir: runsDir });
    store.set(RUN, { extensions: { approval: { approverId: "alice", decidedAt: COMPLETED_AT } } });
    seedLedger();
    seedLinks([...credentialLinks(), ...boxLinks(), ...bundleLinks()]);
    buildTrace(join(runsDir, `${RUN}-artifacts`), { requestId: REQ, repoSlug: SLUG, issueId: ISSUE, gates: [{ gate: "tests-pass", passed: 1 }] });
    writeReports(RUN, [mkReport(RUN, REQ, REPORT_ID)]);

    const report = await walk(RUN);
    const hop8 = hopOf(report, "run-approval") as { status: string; constraint: string };
    expect(hop8.status).toBe("order-violation");
    expect(hop8.constraint).toContain("strict");
  });

  test("a shared-millisecond credential pair does NOT violate (non-strict lifecycle)", async () => {
    seedRecord({ runId: RUN, requestId: REQ, reportId: REPORT_ID, prUrl: PR_URL, closedAt: new Date(iso(30)) });
    seedLedger();
    const same = iso(2);
    const rows = credentialLinks().map((r) => ({ ...r, occurredAt: same }));
    seedLinks([...rows, ...boxLinks(), ...bundleLinks()]);
    buildTrace(join(runsDir, `${RUN}-artifacts`), { requestId: REQ, repoSlug: SLUG, issueId: ISSUE, gates: [{ gate: "tests-pass", passed: 1 }] });
    writeReports(RUN, [mkReport(RUN, REQ, REPORT_ID)]);

    const report = await walk(RUN);
    expect(hopOf(report, "run-credential").status).toBe("resolved");
    expect(report.complete).toBe(true);
  });
});

// ─── 9. reap not-applicable (AC5) ────────────────────────────────────────────

describe("reap not-applicable (DoD: cleanly torn-down run)", () => {
  test("closedAt present, no live VM, no reap link → not-applicable with the story's exact reason", async () => {
    seedRecord({ runId: RUN, requestId: REQ, reportId: REPORT_ID, prUrl: PR_URL, closedAt: new Date(iso(30)) });
    seedLedger();
    seedLinks([...credentialLinks(), ...boxLinks(), ...bundleLinks()]); // deliberately NO reap row
    buildTrace(join(runsDir, `${RUN}-artifacts`), { requestId: REQ, repoSlug: SLUG, issueId: ISSUE, gates: [{ gate: "tests-pass", passed: 1 }] });
    writeReports(RUN, [mkReport(RUN, REQ, REPORT_ID)]);

    const report = await walk(RUN);
    const hop5 = hopOf(report, "run-box") as { status: string; detail: { events: { reap: { status: string; reason?: string } } } };
    expect(hop5.status).toBe("resolved"); // an `unlinked` here MUST fail this fixture
    expect(hop5.detail.events.reap.status).toBe("not-applicable");
    expect(hop5.detail.events.reap.reason).toBe(REAP_NOT_APPLICABLE_REASON);
    expect(report.complete).toBe(true);
  });
});

// ─── 10. evidence-not-harvested distinct from unlinked ───────────────────────

describe("evidence-not-harvested (DoD: named cause and path, never a missing link)", () => {
  test("noHarvest bundle loss names the bundle path; failed artifacts pull names the artifacts dir", async () => {
    seedRecord({ runId: RUN, requestId: REQ, reportId: REPORT_ID, prUrl: PR_URL, closedAt: new Date(iso(30)) });
    seedLedger();
    seedLinks([...credentialLinks(), ...boxLinks()]); // no bundle, no bundle rows
    // No artifacts directory at all — the pull never landed.

    const report = await walk(RUN);

    const hop6 = hopOf(report, "run-bundle") as { status: string; evidencePath: string };
    expect(hop6.status).toBe("evidence-not-harvested");
    expect(hop6.evidencePath).toBe(join(runsDir, `${RUN}.bundle`));
    const hop2 = hopOf(report, "run-issue") as { status: string; evidencePath: string };
    expect(hop2.status).toBe("evidence-not-harvested");
    expect(hop2.evidencePath).toBe(join(runsDir, `${RUN}-artifacts`));
    const hop9 = hopOf(report, "run-gate-evidence") as { status: string; evidencePath: string };
    expect(hop9.status).toBe("evidence-not-harvested");
    expect(hop9.evidencePath).toBe(join(runsDir, `${RUN}-artifacts`));
    // Distinct from unlinked: nothing here blames a missing emitter.
    for (const name of ["run-bundle", "run-issue", "run-gate-evidence"]) {
      expect(hopOf(report, name).status).not.toBe("unlinked");
    }
    expect(report.complete).toBe(false);
  });
});

// ─── 11. hop-timeout fails closed ────────────────────────────────────────────

describe("hop-timeout (DoD: a hop over its ceiling never reports resolved)", () => {
  test("a slow hop 1 under a tiny ceiling reports hop-timeout and the chain is incomplete", async () => {
    seedRecord({ runId: RUN, requestId: REQ, reportId: REPORT_ID, prUrl: PR_URL, closedAt: new Date(iso(30)) });
    seedLedger();
    seedLinks([...credentialLinks(), ...boxLinks(), ...bundleLinks()]);
    buildTrace(join(runsDir, `${RUN}-artifacts`), { requestId: REQ, repoSlug: SLUG, issueId: ISSUE, gates: [{ gate: "tests-pass", passed: 1 }] });
    writeReports(RUN, [mkReport(RUN, REQ, REPORT_ID)]);
    const slowFetch = async (): Promise<{ body: string; headRef?: string; prUrl: string }> => {
      Bun.sleepSync(25);
      return { body: `run ${RUN}`, headRef: `qds/${RUN}`, prUrl: PR_URL };
    };

    const report = await walk(PR_URL, { hopCeilingMs: 0, fetchPull: slowFetch });

    const hop1 = hopOf(report, "pr-run") as { status: string; ceilingMs: number; elapsedMs: number };
    expect(hop1.status).toBe("hop-timeout");
    expect(hop1.ceilingMs).toBe(0);
    expect(hop1.elapsedMs).toBeGreaterThanOrEqual(20);
    expect(report.timings.perHopMs["pr-run"]).toBeGreaterThanOrEqual(20);
    expect(report.complete).toBe(false);
    expect(chainVerdict(report).complete).toBe(false);
  });
});

// ─── 12. redaction (INV-AUDIT-2) ─────────────────────────────────────────────

describe("redaction (DoD: INV-AUDIT-2, no secret material in report or logs)", () => {
  test("token, provisioning-key value and minted key material never reach the report or a log line", async () => {
    const envKey = "sk-or-v1-SECRETVALUE1234567890";
    // A clone-URL token whose prefix the run-record store itself does not
    // refuse (its INV-2 prefix list rejects ghs_/ghp_… on every field, URLs
    // included) — the point is a secret that legitimately lands on disk and
    // must still never reach the chain or a log line.
    const gitToken = "tok_SECRETTOKENVALUE123456789";
    const minted = "sk-or-v1-MINTEDKEYVALUE999999999";
    const prevEnv = process.env.OPENROUTER_PROVISIONING_KEY;
    process.env.OPENROUTER_PROVISIONING_KEY = envKey;
    try {
      seedRecord({
        runId: RUN, requestId: REQ, reportId: REPORT_ID, prUrl: PR_URL, closedAt: new Date(iso(30)),
        // A clone URL legitimately carries an App token (URL fields skip the shape scan).
        httpsUrl: `https://x-access-token:${gitToken}@github.com/acme/widgets`,
      });
      seedLedger();
      // The mint row carries key material in its detail — the walker must digest
      // it, never echo it.
      const mintDetail = { keyHash: KEY_HASH, limitMicroUsd: 50_000_000, keyMaterial: minted };
      seedLinks([
        link({
          event: "mint", subjectId: KEY_HASH, subjectKind: "run-key", detail: mintDetail,
          evidenceDigest: sha256Hex(canonicalJson(mintDetail)), evidencePath: join(runsDir, `${RUN}.json`),
        }),
        ...credentialLinks().slice(1),
        ...boxLinks(),
        ...bundleLinks(),
      ]);
      buildTrace(join(runsDir, `${RUN}-artifacts`), { requestId: REQ, repoSlug: SLUG, issueId: ISSUE, gates: [{ gate: "tests-pass", passed: 1 }] });
      writeReports(RUN, [mkReport(RUN, REQ, REPORT_ID)]);

      const lines: unknown[] = [];
      const restore = setLogSink((entry) => lines.push(entry));
      let report: ChainReport;
      try {
        report = await walk(PR_URL);
      } finally {
        restore();
      }

      const serialized = JSON.stringify(report);
      for (const secret of [envKey, gitToken, minted]) {
        expect(serialized).not.toContain(secret);
      }
      for (const entry of lines) {
        const line = JSON.stringify(entry);
        for (const secret of [envKey, gitToken, minted]) expect(line).not.toContain(secret);
      }
      const hop4 = hopOf(report, "run-credential") as { status: string; detail: { keyHash?: string; keyHashPrefix?: string; keyMaterial?: string } };
      expect(hop4.status).toBe("resolved");
      expect(hop4.detail.keyHash).toBe(KEY_HASH);
      expect(hop4.detail.keyHashPrefix).toBe(KEY_HASH.slice(0, 8));
      expect(hop4.detail.keyMaterial).toBeUndefined();
    } finally {
      if (prevEnv === undefined) {
        // biome-ignore lint/performance/noDelete: unsetting env vars requires delete
        delete process.env.OPENROUTER_PROVISIONING_KEY;
      } else {
        process.env.OPENROUTER_PROVISIONING_KEY = prevEnv;
      }
    }
  });
});
