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

import { ChainWalkError, OQ4_VOID_REASON, chainVerdict, walkAuditChain } from "../../src/audit/index.ts";
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
  /** `null` omits `extensions.pr.createdAt` entirely — hop 8's missing-stamp arm. */
  prCreatedAt?: string | null;
  httpsUrl?: string;
  closedAt?: Date;
  superseded?: string[];
  /**
   * Which half of the budget correlation to withhold. The walker reports three
   * DIFFERENT `actual` strings ("neither present" / "repoSlug absent" /
   * "issueId absent"), so a boolean flag could only ever reach the first.
   */
  omitCorrelation?: "both" | "repo" | "issue";
}

function correlationOf(omit: RecordSpec["omitCorrelation"]): Record<string, string> {
  if (omit === "both") return {};
  if (omit === "repo") return { issueId: ISSUE };
  if (omit === "issue") return { repoSlug: SLUG };
  return { repoSlug: SLUG, issueId: ISSUE };
}

/**
 * Real RunRecordStore writes: create → set (core + extensions) → close.
 *
 * No `try/finally` dispose, unlike every other builder here: `RunRecordStore`
 * is HANDLE-FREE. It holds only `dir`/`requestId`/callbacks and does every read
 * and write through a one-shot `readFileSync`/atomic rename; `store.close(id)`
 * closes the RECORD (stamps `closedAt`), not the store, and there is no other
 * dispose method to call. Constructing several over one directory leaks nothing.
 */
function seedRecord(spec: RecordSpec): void {
  const store = new RunRecordStore({ dir: runsDir });
  store.create(spec.runId, new Date(iso(0)));
  const extensions: Record<string, Record<string, string | number | string[]>> = {
    budget: {
      ...correlationOf(spec.omitCorrelation),
      capMicroUsd: 50_000_000, spentMicroUsd: 0, reservedMicroUsd: 0, admittedCeilingMicroUsd: 50_000_000,
    },
  };
  if (spec.prUrl !== undefined) {
    extensions.pr = {
      prUrl: spec.prUrl, prNumber: 57,
      ...(spec.prCreatedAt === null ? {} : { createdAt: spec.prCreatedAt ?? PR_CREATED }),
    };
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

/**
 * Plant unregistered keys on `extensions.pr` the way an older build did: the
 * store's WRITE path refuses an unknown key, its READ path keeps whatever a
 * registered namespace already holds on disk, and the per-field deep merge
 * re-persists it forever. That is the passthrough hop 1's projection closes.
 */
function plantPrExtras(runId: string, extras: Record<string, unknown>): void {
  const path = join(runsDir, `${runId}.json`);
  const doc = JSON.parse(readFileSync(path, "utf8")) as { extensions?: Record<string, Record<string, unknown>> };
  const pr = doc.extensions?.pr;
  if (pr === undefined) throw new Error(`no extensions.pr on ${path}`);
  Object.assign(pr, extras);
  writeFileSync(path, JSON.stringify(doc), { mode: 0o600 });
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
    assertWalOnly(dbPath, requestId);
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

/**
 * The fixture's PREMISE, asserted rather than assumed: `wal-only-gate` must be
 * unreachable without the `-wal`. SQLite auto-checkpoints (`wal_autocheckpoint`
 * defaults to 1 000 pages) and `applyMigrations` re-opens, so the row can land
 * in the main file — at which point "hot-WAL recovery" silently degrades into
 * an ordinary "reads a trace db" test that passes with zero WAL handling. A
 * `-wal` file merely EXISTING proves nothing about which file holds the row.
 */
function assertWalOnly(dbPath: string, requestId: string): void {
  const probeDir = mkdtempSync(join(tmpdir(), "qds-df53-walprobe-"));
  try {
    const lone = join(probeDir, "trace.db"); // the db WITHOUT its -wal
    copyFileSync(dbPath, lone);
    const db = new Database(lone, { readonly: true });
    try {
      // Without the -wal the table itself may not exist yet — a stronger form
      // of "not visible", so an absent table satisfies the premise too.
      let gates: string[] = [];
      try {
        gates = (db.prepare("SELECT gate FROM gate_results WHERE request_id = ?").all(requestId) as { gate: string }[])
          .map((r) => r.gate);
      } catch {
        gates = [];
      }
      expect(gates).not.toContain("wal-only-gate");
    } finally {
      db.close();
    }
  } finally {
    rmSync(probeDir, { recursive: true, force: true });
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

/**
 * A row the STORE would refuse today (FIX-1 validates ISO stamps at write
 * time) but which sits on disk from before that landed. The walker must still
 * meet it — the read-side guard is the half this covers. The append-only
 * triggers block UPDATE/DELETE, never INSERT.
 */
function seedRawLink(row: AuditLinkInput): void {
  const db = new Database(auditDb);
  try {
    db.prepare(
      `INSERT INTO audit_links (run_id, repo_slug, request_id, hop, event, subject_id, subject_kind,
         evidence_path, evidence_digest, detail_json, occurred_at, recorded_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(
      row.runId, row.repoSlug, row.requestId, row.hop, row.event, row.subjectId ?? null, row.subjectKind ?? null,
      row.evidencePath ?? null, row.evidenceDigest, row.detail === undefined ? null : canonicalJson(row.detail),
      row.occurredAt, row.recordedAt,
    );
  } finally {
    db.close();
  }
}

/** The exact object every credential row digests — the emitter convention, shared so a test can restate it. */
const CREDENTIAL_DETAIL = { keyHash: KEY_HASH, limitMicroUsd: 50_000_000 };

function credentialLinks(runId = RUN, requestId = REQ, base = 2): AuditLinkInput[] {
  const events: [string, string][] = [["mint", "m"], ["deliver", "d"], ["revoke", "r"], ["verify-revoked", "v"]];
  return events.map(([event], i) =>
    link({
      runId, requestId, event, subjectId: KEY_HASH, subjectKind: "run-key",
      evidencePath: join(runsDir, `${runId}.json`),
      detail: CREDENTIAL_DETAIL,
      evidenceDigest: sha256Hex(canonicalJson(CREDENTIAL_DETAIL)),
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

/**
 * The reaper's own link row. Absent on every other fixture, so hop 5's
 * resolved-WITH-reap branch, the conditional ` <= reap` constraint tail and the
 * reap row's digest check had no coverage at all — only the two ABSENT arms
 * (`not-applicable` and `unlinked`) were driven.
 */
function reapLink(minute: number, runId = RUN, requestId = REQ): AuditLinkInput {
  return link({
    runId, requestId, hop: "run-box", event: "reap", subjectId: runId, subjectKind: "box",
    evidencePath: join(runsDir, `${runId}.json`), detail: { reaped: true },
    evidenceDigest: sha256Hex(canonicalJson({ reaped: true })),
    occurredAt: iso(minute), recordedAt: iso(minute),
  });
}

/**
 * A BINARY bundle, like the real thing: a git bundle is an ASCII header
 * followed by a packfile whose bytes run the full 0x00–0xff range. An
 * ASCII-only fixture cannot catch a walker that round-trips the file through
 * latin1 before hashing (utf8 re-encodes every byte >= 0x80 into two), which is
 * exactly how hop 6 reported evidence-mismatch on every harvested bundle.
 */
function bundleFile(runId = RUN): string {
  const path = join(runsDir, `${runId}.bundle`);
  const header = Buffer.from(`# v2 git bundle\n${runId}\n`, "utf8");
  const pack = Buffer.from([0x50, 0x41, 0x43, 0x4b, 0x00, 0x02, 0x80, 0x81, 0xc3, 0xa9, 0xfe, 0xff, 0x9c, 0x0a]);
  writeFileSync(path, Buffer.concat([header, pack]), { mode: 0o600 });
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

/**
 * The walker's OWN options type. `Record<string, unknown>` + `as never` erased
 * the contract: a production rename of `ledger`/`auditDb`/`runsDir`/
 * `reverifyDir`/`hopCeilingMs` kept compiling here and silently handed the
 * walker an ignored key, so the suite would have stopped testing the injected
 * paths and started testing the production defaults without a single red test.
 */
type WalkOverrides = Partial<Parameters<typeof walkAuditChain>[1]>;

const walkOpts = (over: WalkOverrides = {}): WalkOverrides => ({
  runsDir, auditDb, ledger: ledgerPath, reverifyDir, fetchPull: fetchPullOk, ...over,
});

function walk(ref: string, over: WalkOverrides = {}): Promise<ChainReport> {
  return walkAuditChain(ref, walkOpts(over));
}

/** The typed refusal a walk raises, narrowed — anything else rethrows. */
async function refusalOfWalk(ref: string, over: WalkOverrides = {}): Promise<ChainWalkError> {
  try {
    await walk(ref, over);
  } catch (e) {
    if (e instanceof ChainWalkError) return e;
    throw e;
  }
  throw new Error(`expected a ChainWalkError walking ${ref}, the walk returned a report`);
}

/**
 * The sink is proven WIRED to the walk before any "no secret in any log line"
 * loop runs over it. `for (const entry of lines)` with an empty `lines` asserts
 * nothing at all, so half of INV-AUDIT-2's clause 12 would evaporate the day
 * the walker stopped logging — or logged through a different module.
 */
function assertWalkLogged(lines: unknown[], runId: string): void {
  expect(lines.length).toBeGreaterThan(0);
  const own = lines.filter((e) => {
    const entry = e as { operation?: unknown; runId?: unknown };
    return entry.operation === "audit-chain.hop" && entry.runId === runId;
  });
  expect(own.length).toBeGreaterThan(0);
}

function hopOf(report: ChainReport, hop: string): HopOutcome {
  const key = Object.keys(report.runs)[0];
  if (key === undefined) throw new Error(`no run key in report for ${report.ref}`);
  const run = report.runs[key];
  const out = run !== undefined ? (run.hops as Record<string, HopOutcome | undefined>)[hop] : undefined;
  if (out === undefined) throw new Error(`no outcome for hop ${hop}`);
  return out;
}

/**
 * Every FILE directly under `root`, by name → sha256 of its bytes.
 *
 * `readdirSync` alone threw EISDIR — not a clean assertion failure — the moment
 * the walker created a subdirectory in there, so directories are recorded by
 * name with a sentinel instead of read. Callers fingerprint the artifacts ROOT
 * as well as `trace/`: the root carries `buildDecoyRootTrace`'s `trace.db`, and
 * a walker that opened THAT read-write (a `-wal`/`-shm` sibling, a checkpoint)
 * mutates harvested evidence exactly as the immutability claim forbids.
 */
function dirFingerprints(root: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    out.set(
      entry.name,
      entry.isDirectory() ? "<dir>" : createHash("sha256").update(readFileSync(join(root, entry.name))).digest("hex"),
    );
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
    // The hop KEY SET, not membership: the walker backfills every name in its
    // own HOPS constant with a `broken` placeholder, so a per-name
    // `toBeDefined()` is structurally guaranteed and a silently added or
    // renamed hop key passes it. Equality catches both.
    expect(Object.keys(run.hops).sort()).toEqual([...hopNames].sort());
    // The exact status of every hop. `.not.toBe("broken")` left the other five
    // failing statuses (unlinked, evidence-mismatch, order-violation,
    // hop-timeout, evidence-not-harvested) passing this loop.
    expect(Object.fromEntries(hopNames.map((n) => [n, (run.hops[n] as HopOutcome).status]))).toEqual({
      "pr-run": "resolved", "run-issue": "resolved", "run-cost": "resolved", "run-credential": "resolved",
      "run-box": "resolved", "run-bundle": "resolved", "run-reverify": "resolved", "run-approval": "resolved",
      "run-gate-evidence": "resolved", "memory-retain-receipt": "void",
    });
    const memory = run.hops["memory-retain-receipt"] as { status: string; reason: string };
    expect(memory.status).toBe("void");
    expect(memory.reason).toBe(OQ4_VOID_REASON);
    const cost = run.hops["run-cost"] as { status: string; detail: { totalMicroUsd: number; perRole: Record<string, number>; hasTokenRows: boolean } };
    expect(cost.status).toBe("resolved");
    expect(cost.detail.hasTokenRows).toBe(true);
    // EXACT µ$, derived from the fixture's own inputs: $0.012345 → 12_345 µ$,
    // $0.002 → 2_000 µ$, and a 30-minute lifetime at 3_600_000 µ$/h →
    // 1_800_000 µ$. Key names alone let all the spend land in one role, and
    // `> 0` lets a USD→µ$ scale error of 10³ through.
    expect(cost.detail.perRole).toEqual({ lead: 12_345, worker: 2_000, "box-hours": 1_800_000 });
    expect(cost.detail.totalMicroUsd).toBe(12_345 + 2_000 + 1_800_000);
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

    const cost = hopOf(report, "run-cost") as { status: string; detail: { hasTokenRows: boolean; perRole: Record<string, number>; totalMicroUsd: number } };
    expect(cost.status).toBe("resolved");
    expect(cost.detail.hasTokenRows).toBe(false);
    // The box-hours-only arithmetic — the single remaining µ$ path — was
    // declared in the cast and never asserted, so `{}`, `0` or USD-instead-of-µ$
    // all passed. 30 minutes at 3 600 000 µ$/h is 1 800 000 µ$.
    expect(cost.detail.perRole).toEqual({ "box-hours": 1_800_000 });
    expect(cost.detail.totalMicroUsd).toBe(1_800_000);
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
    // Hop 3 reads only its OWN run's ledger rows: the ledger was seeded for A
    // alone, so B has no cost provenance and must say so. A `readRunCost` that
    // ignored its runId would resolve here on A's money.
    const costA = hopOf(reportA, "run-cost") as { status: string; detail: { totalMicroUsd: number } };
    expect(costA.status).toBe("resolved");
    const costB = hopOf(reportB, "run-cost") as { status: string; actual: string };
    expect(costB.status).toBe("broken");
    expect(costB.actual).toBe("hasEvents: false");
    expect(reportB.complete).toBe(false);
    // Hop 4 likewise: two runs, two distinct mint rows, never one shared row.
    const credA = hopOf(reportA, "run-credential") as { detail: { linkIds: Record<string, number> } };
    const credB = hopOf(reportB, "run-credential") as { detail: { linkIds: Record<string, number> } };
    expect(credA.detail.linkIds.mint).toBeGreaterThan(0);
    expect(credB.detail.linkIds.mint).not.toBe(credA.detail.linkIds.mint);
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
    // The ROOT too: `buildDecoyRootTrace` writes trace.db there, and its bytes
    // were never compared — a walker opening the decoy read-write was unseen.
    const rootBefore = dirFingerprints(artifacts);
    expect(rootBefore.has("trace.db")).toBe(true);

    const report = await walk(RUN);

    const gates = hopOf(report, "run-gate-evidence") as { status: string; detail: { count: number; rows: { gate: string }[] }; evidencePath: string };
    expect(gates.status).toBe("resolved");
    expect(gates.detail.rows.map((r) => r.gate)).toContain("wal-only-gate");
    expect(gates.evidencePath).toBe(join(traceDir, "trace.db")); // trace/ prefix resolved EXACTLY
    expect(hopOf(report, "run-issue").status).toBe("resolved");
    // The artifacts directory was never written: same files, same bytes — in
    // `trace/` AND at the root, where the decoy lives.
    const after = dirFingerprints(traceDir);
    expect([...after.keys()].sort()).toEqual([...before.keys()].sort());
    for (const [name, hash] of before) expect(after.get(name)).toBe(hash);
    const rootAfter = dirFingerprints(artifacts);
    expect([...rootAfter.keys()].sort()).toEqual([...rootBefore.keys()].sort());
    for (const [name, hash] of rootBefore) expect(rootAfter.get(name)).toBe(hash);
  });
});

// ─── 6. the walker never creates the store it audits ─────────────────────────

describe("no-create discipline (DoD: absent store refuses, path still absent)", () => {
  test("an absent store is an ENVIRONMENT FAULT, not a broken chain; audit.db is still absent afterwards", async () => {
    seedRecord({ runId: RUN, requestId: REQ, reportId: REPORT_ID, prUrl: PR_URL, closedAt: new Date(iso(30)) });
    seedLedger();
    // No openAuditStore call — the fixture ships NO audit.db precisely so the branch runs.
    buildTrace(join(runsDir, `${RUN}-artifacts`), { requestId: REQ, repoSlug: SLUG, issueId: ISSUE, gates: [{ gate: "tests-pass", passed: 1 }] });
    writeReports(RUN, [mkReport(RUN, REQ, REPORT_ID)]);

    // N5: the store's refusal is rethrown as ChainWalkError, so NO report is
    // produced. "I could not look" must never render as "the chain is broken"
    // — a false BROKEN verdict on this PR's chain is the more damaging error,
    // and the CLI maps this code to exit 2 with the store's own remediation.
    const err = await refusalOfWalk(RUN);
    expect(err.code).toBe("walk-environment-fault");
    expect(err.message).toContain("audit-store-absent");
    expect(err.message).toContain(auditDb);
    expect(err.remediation).toContain(auditDb);
    expect(err.remediation).toMatch(/the walk never creates one/); // the store's OWN remediation, not a generic hint

    expect(existsSync(auditDb)).toBe(false); // the path check, not a log check
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
    const before = readFileSync(reportFile, "utf8");
    const tampered = before.replace('"verdict":"green"', '"verdict":"red"');
    expect(tampered).not.toContain('"verdict":"green"');
    writeFileSync(reportFile, tampered, { mode: 0o600 });

    const second = await walk(RUN);
    const hop7 = hopOf(second, "run-reverify") as { status: string; expectedDigest: string; actualDigest: string; evidencePath: string };
    expect(hop7.status).toBe("evidence-mismatch");
    // The EXACT pre- and post-tamper digests, as the sibling hop-6 test pins
    // them. Two distinct hex-64 strings satisfy a shape check, so a walker that
    // baselined the WRONG subject — the whole JSONL file, or the run record
    // instead of the bound entry — reported a mismatch for the wrong reason and
    // passed. The digest is over the bound ENTRY (clause 7, entry-scoped).
    expect(hop7.expectedDigest).toBe(sha256Hex(canonicalJson(JSON.parse(before.trim()))));
    expect(hop7.actualDigest).toBe(sha256Hex(canonicalJson(JSON.parse(tampered.trim()))));
    expect(hop7.expectedDigest).not.toBe(hop7.actualDigest);
    expect(hop7.evidencePath).toBe(reportFile);
    expect(second.complete).toBe(false);
  });

  test("a TRUNCATED final JSONL line does not throw out of the middle of the walk", async () => {
    // The file is append-only, so a killed write leaves a torn last line. Every
    // other fixture here is machine-perfect JSONL — even the "append" test
    // rewrites the whole file — so an unguarded `JSON.parse` per line would
    // throw a bare SyntaxError out of hop 7: neither a named outcome nor a
    // ChainWalkError, which is what the DoD promises.
    seedRecord({ runId: RUN, requestId: REQ, reportId: REPORT_ID, prUrl: PR_URL, closedAt: new Date(iso(30)) });
    seedLedger();
    seedLinks([...credentialLinks(), ...boxLinks(), ...bundleLinks()]);
    buildTrace(join(runsDir, `${RUN}-artifacts`), { requestId: REQ, repoSlug: SLUG, issueId: ISSUE, gates: [{ gate: "tests-pass", passed: 1 }] });
    const bound = mkReport(RUN, REQ, REPORT_ID);
    // A complete bound line, then a crashed append: no closing brace, no
    // trailing newline.
    mkdirSync(reverifyDir, { recursive: true, mode: 0o700 });
    writeFileSync(
      join(reverifyDir, `${RUN}.jsonl`),
      `${JSON.stringify(bound)}\n\n{"reverifyId":"rv-${RUN}-0002","runId":"${RUN}`,
      { mode: 0o600 },
    );

    const report = await walk(RUN);

    const hop7 = hopOf(report, "run-reverify") as { status: string; subjectId: string };
    expect(hop7.status).toBe("resolved"); // the torn tail is dropped; the bound report still resolves
    expect(hop7.subjectId).toBe(REPORT_ID);
    expect(report.complete).toBe(true);
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
    // While the record is still OPEN, AC5's not-applicable has only one of its
    // two halves: `unlinked` naming the sweep is the fail-closed reading of an
    // uncollected box, and it must not be reported as a complete chain.
    const openBox = hopOf(first, "run-box") as { status: string; emitter: string; diagnostic: string };
    expect(openBox.status).toBe("unlinked");
    expect(openBox.emitter).toBe("sweep");
    expect(openBox.diagnostic).toContain("closedAt absent");
    expect(first.complete).toBe(false);

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

  test("verify-revoked before revoke → order-violation on the FOURTH credential edge", async () => {
    // The only other hop-4 ordering case moves `revoke` to iso(1), which trips
    // the `deliver → revoke` edge FIRST — so the fourth edge was never
    // violated, and `constraint).toContain("mint <= deliver <= revoke")` is a
    // prefix that matches whether or not ` <= verify-revoked` is even declared.
    // An `i < events.length - 1` off-by-one leaves exactly this edge unchecked
    // and ships green: the edge that proves revocation was WITNESSED after it
    // was requested.
    seedRecord({ runId: RUN, requestId: REQ, reportId: REPORT_ID, prUrl: PR_URL, closedAt: new Date(iso(30)) });
    seedLedger();
    // mint 2 <= deliver 2.5 <= revoke 3, and the witness stamped at 2.75.
    const rows = credentialLinks().map((r) => (r.event === "verify-revoked" ? { ...r, occurredAt: iso(2.75) } : r));
    seedLinks([...rows, ...boxLinks(), ...bundleLinks()]);
    buildTrace(join(runsDir, `${RUN}-artifacts`), { requestId: REQ, repoSlug: SLUG, issueId: ISSUE, gates: [{ gate: "tests-pass", passed: 1 }] });
    writeReports(RUN, [mkReport(RUN, REQ, REPORT_ID)]);

    const report = await walk(RUN);

    const hop4 = hopOf(report, "run-credential") as { status: string; constraint: string; earlier: string; later: string };
    expect(hop4.status).toBe("order-violation");
    expect(hop4.constraint).toContain("verify-revoked");
    expect(hop4.earlier).toBe(iso(3)); // revoke, which the constraint requires first
    expect(hop4.later).toBe(iso(2.75)); // the witness that preceded it
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
    // CONSTRAINT order, as on hops 4/5/6: `earlier` is the event the constraint
    // requires FIRST (the report's completedAt), `later` the one that preceded it.
    expect(hop8.earlier).toBe(COMPLETED_AT);
    expect(hop8.later).toBe(iso(9));
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
    const hop8 = hopOf(report, "run-approval") as { status: string; constraint: string; earlier: string; later: string };
    expect(hop8.status).toBe("order-violation");
    expect(hop8.constraint).toContain("strict");
    // WHICH of the two strict constraints fired. `"strict"` appears in both, so
    // a walker reporting the pr.createdAt pair for a completedAt equality
    // passed — and the equality boundary this test exists for went untested.
    expect(hop8.constraint).toContain("completedAt");
    expect(hop8.earlier).toBe(COMPLETED_AT);
    expect(hop8.later).toBe(COMPLETED_AT);
    expect(report.complete).toBe(false);
  });

  test("decidedAt EQUAL to pr.createdAt → order-violation (the SECOND strict boundary)", async () => {
    // The fixture's default stamps are 60 s apart, so no off-by-one on this
    // comparison could ever register: `<` relaxed to `<=` left every test green.
    seedRecord({ runId: RUN, requestId: REQ, reportId: REPORT_ID, prUrl: PR_URL, prCreatedAt: DECIDED_AT, closedAt: new Date(iso(30)) });
    seedLedger();
    seedLinks([...credentialLinks(), ...boxLinks(), ...bundleLinks()]);
    buildTrace(join(runsDir, `${RUN}-artifacts`), { requestId: REQ, repoSlug: SLUG, issueId: ISSUE, gates: [{ gate: "tests-pass", passed: 1 }] });
    writeReports(RUN, [mkReport(RUN, REQ, REPORT_ID)]);

    const report = await walk(RUN);

    const hop8 = hopOf(report, "run-approval") as { status: string; constraint: string; earlier: string; later: string };
    expect(hop8.status).toBe("order-violation");
    expect(hop8.constraint).toContain("pr.createdAt");
    expect(hop8.constraint).toContain("strict");
    expect(hop8.earlier).toBe(DECIDED_AT);
    expect(hop8.later).toBe(DECIDED_AT);
    expect(report.complete).toBe(false);
  });

  test("a PR created BEFORE its own approval → order-violation on the pr.createdAt half", async () => {
    seedRecord({ runId: RUN, requestId: REQ, reportId: REPORT_ID, prUrl: PR_URL, prCreatedAt: iso(10.5), closedAt: new Date(iso(30)) });
    seedLedger();
    seedLinks([...credentialLinks(), ...boxLinks(), ...bundleLinks()]);
    buildTrace(join(runsDir, `${RUN}-artifacts`), { requestId: REQ, repoSlug: SLUG, issueId: ISSUE, gates: [{ gate: "tests-pass", passed: 1 }] });
    writeReports(RUN, [mkReport(RUN, REQ, REPORT_ID)]);

    const report = await walk(RUN);

    const hop8 = hopOf(report, "run-approval") as { status: string; constraint: string; earlier: string; later: string };
    expect(hop8.status).toBe("order-violation");
    expect(hop8.constraint).toContain("pr.createdAt");
    expect(hop8.constraint).toContain("strict");
    // The first half (completedAt < decidedAt) holds here, so this is the
    // SECOND constraint reporting, in constraint order.
    expect(hop8.earlier).toBe(DECIDED_AT);
    expect(hop8.later).toBe(iso(10.5));
    expect(report.complete).toBe(false);
  });

  test("teardown stamped before setup-gate → order-violation on hop 5, naming the box constraint", async () => {
    seedRecord({ runId: RUN, requestId: REQ, reportId: REPORT_ID, prUrl: PR_URL, closedAt: new Date(iso(30)) });
    seedLedger();
    // create 4 <= fill 5 <= setup-gate 6, and a teardown stamped at 3.
    const rows = boxLinks().map((r) => (r.event === "teardown" ? { ...r, occurredAt: iso(3) } : r));
    seedLinks([...credentialLinks(), ...rows, ...bundleLinks()]);
    buildTrace(join(runsDir, `${RUN}-artifacts`), { requestId: REQ, repoSlug: SLUG, issueId: ISSUE, gates: [{ gate: "tests-pass", passed: 1 }] });
    writeReports(RUN, [mkReport(RUN, REQ, REPORT_ID)]);

    const report = await walk(RUN);

    const hop5 = hopOf(report, "run-box") as { status: string; constraint: string; earlier: string; later: string };
    expect(hop5.status).toBe("order-violation");
    // The conditional ` <= reap` tail is absent on a run with no reap row —
    // the string itself is rendered by no other test in either arm.
    expect(hop5.constraint).toBe("create <= fill <= setup-gate <= teardown (non-decreasing)");
    expect(hop5.earlier).toBe(iso(6));
    expect(hop5.later).toBe(iso(3));
    expect(report.complete).toBe(false);
  });

  test("bundle-fetch stamped before bundle-verify → order-violation on hop 6", async () => {
    seedRecord({ runId: RUN, requestId: REQ, reportId: REPORT_ID, prUrl: PR_URL, closedAt: new Date(iso(30)) });
    seedLedger();
    const rows = bundleLinks().map((r) => (r.event === "bundle-fetch" ? { ...r, occurredAt: iso(4) } : r));
    seedLinks([...credentialLinks(), ...boxLinks(), ...rows]);
    buildTrace(join(runsDir, `${RUN}-artifacts`), { requestId: REQ, repoSlug: SLUG, issueId: ISSUE, gates: [{ gate: "tests-pass", passed: 1 }] });
    writeReports(RUN, [mkReport(RUN, REQ, REPORT_ID)]);

    const report = await walk(RUN);

    const hop6 = hopOf(report, "run-bundle") as { status: string; constraint: string; earlier: string; later: string };
    expect(hop6.status).toBe("order-violation");
    expect(hop6.constraint).toContain("bundle-verify <= bundle-fetch");
    expect(hop6.earlier).toBe(iso(5));
    expect(hop6.later).toBe(iso(4));
    expect(report.complete).toBe(false);
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

  test("a PRESENT reap link resolves as emitted and extends the constraint with the ` <= reap` tail", async () => {
    // The reap arm was only ever driven in its two ABSENT forms. The
    // resolved-with-reap branch, the conditional constraint tail and the reap
    // row's own digest check had no coverage at all.
    seedRecord({ runId: RUN, requestId: REQ, reportId: REPORT_ID, prUrl: PR_URL, closedAt: new Date(iso(30)) });
    seedLedger();
    seedLinks([...credentialLinks(), ...boxLinks(), reapLink(8), ...bundleLinks()]);
    buildTrace(join(runsDir, `${RUN}-artifacts`), { requestId: REQ, repoSlug: SLUG, issueId: ISSUE, gates: [{ gate: "tests-pass", passed: 1 }] });
    writeReports(RUN, [mkReport(RUN, REQ, REPORT_ID)]);

    const report = await walk(RUN);

    const hop5 = hopOf(report, "run-box") as {
      status: string;
      detail: { events: { reap: { status: string; occurredAt?: string; linkId?: number; reason?: string } } };
    };
    expect(hop5.status).toBe("resolved");
    expect(hop5.detail.events.reap.status).toBe("resolved"); // emitted, never the not-applicable courtesy
    expect(hop5.detail.events.reap.occurredAt).toBe(iso(8));
    expect(hop5.detail.events.reap.linkId).toBeGreaterThan(0);
    expect(hop5.detail.events.reap.reason).toBeUndefined();
    expect(report.complete).toBe(true);
  });

  test("a reap stamped BEFORE its teardown → order-violation naming the ` <= reap` tail", async () => {
    // The ordering edge the conditional tail adds: with no reap row the
    // constraint string stops at `teardown`, so this edge exists only on a
    // reaped run and was never exercised in either direction.
    seedRecord({ runId: RUN, requestId: REQ, reportId: REPORT_ID, prUrl: PR_URL, closedAt: new Date(iso(30)) });
    seedLedger();
    // create 4 <= fill 5 <= setup-gate 6 <= teardown 7, and a reap at 6.5.
    seedLinks([...credentialLinks(), ...boxLinks(), reapLink(6.5), ...bundleLinks()]);
    buildTrace(join(runsDir, `${RUN}-artifacts`), { requestId: REQ, repoSlug: SLUG, issueId: ISSUE, gates: [{ gate: "tests-pass", passed: 1 }] });
    writeReports(RUN, [mkReport(RUN, REQ, REPORT_ID)]);

    const report = await walk(RUN);

    const hop5 = hopOf(report, "run-box") as { status: string; constraint: string; earlier: string; later: string };
    expect(hop5.status).toBe("order-violation");
    expect(hop5.constraint).toBe("create <= fill <= setup-gate <= teardown <= reap (non-decreasing)");
    expect(hop5.earlier).toBe(iso(7)); // teardown, which the constraint requires first
    expect(hop5.later).toBe(iso(6.5));
    expect(report.complete).toBe(false);
  });

  test("a reap row whose detail no longer digests to its evidence_digest → hop 5 evidence-mismatch", async () => {
    // The digest check runs over EVERY row of the hop, tabled or not. A reap
    // row was never among them, so the one row the reaper writes had no
    // tamper coverage.
    seedRecord({ runId: RUN, requestId: REQ, reportId: REPORT_ID, prUrl: PR_URL, closedAt: new Date(iso(30)) });
    seedLedger();
    const tamperedDigest = sha256Hex(canonicalJson({ tampered: true }));
    seedLinks([...credentialLinks(), ...boxLinks(), { ...reapLink(8), evidenceDigest: tamperedDigest }, ...bundleLinks()]);
    buildTrace(join(runsDir, `${RUN}-artifacts`), { requestId: REQ, repoSlug: SLUG, issueId: ISSUE, gates: [{ gate: "tests-pass", passed: 1 }] });
    writeReports(RUN, [mkReport(RUN, REQ, REPORT_ID)]);

    const report = await walk(RUN);

    const hop5 = hopOf(report, "run-box") as { status: string; expectedDigest: string; actualDigest: string };
    expect(hop5.status).toBe("evidence-mismatch");
    expect(hop5.expectedDigest).toBe(tamperedDigest);
    expect(hop5.actualDigest).toBe(sha256Hex(canonicalJson({ reaped: true })));
    expect(report.complete).toBe(false);
  });
});

// ─── 9b. unlinked is a FAILING status (INV-AUDIT-4) ──────────────────────────

describe("unlinked (DoD: a missing emitter breaks the chain, never completes it)", () => {
  test("a credential lifecycle missing verify-revoked names the emitter and fails the chain", async () => {
    seedRecord({ runId: RUN, requestId: REQ, reportId: REPORT_ID, prUrl: PR_URL, closedAt: new Date(iso(30)) });
    seedLedger();
    // mint, deliver, revoke — and no witness that the revocation took effect.
    seedLinks([...credentialLinks().slice(0, 3), ...boxLinks(), ...bundleLinks()]);
    buildTrace(join(runsDir, `${RUN}-artifacts`), { requestId: REQ, repoSlug: SLUG, issueId: ISSUE, gates: [{ gate: "tests-pass", passed: 1 }] });
    writeReports(RUN, [mkReport(RUN, REQ, REPORT_ID)]);

    const report = await walk(RUN);

    const hop4 = hopOf(report, "run-credential") as { status: string; emitter: string; diagnostic: string };
    expect(hop4.status).toBe("unlinked");
    expect(hop4.emitter).toBe("verifyRevoked");
    expect(hop4.diagnostic).toContain("verify-revoked");
    expect(hop4.diagnostic).toContain("INV-AUDIT-4");
    // The whole point of the status: `not-applicable` here would read as a
    // COMPLETE chain over a run whose key was never proven revoked.
    expect(report.complete).toBe(false);
    expect(chainVerdict(report).complete).toBe(false);
    expect(chainVerdict(report).brokenHops.map((h) => h.hop)).toEqual(["run-credential"]);
  });
});

// ─── 9c. run-cost fails closed on a run with no provenance (DF5.4-C1) ────────

describe("run-cost fail-closed (DoD: no ledger rows is never zero spend)", () => {
  test("an ABSENT ledger is an environment fault, never a broken hop 3", async () => {
    seedRecord({ runId: RUN, requestId: REQ, reportId: REPORT_ID, prUrl: PR_URL, closedAt: new Date(iso(30)) });
    seedLinks([...credentialLinks(), ...boxLinks(), ...bundleLinks()]);
    buildTrace(join(runsDir, `${RUN}-artifacts`), { requestId: REQ, repoSlug: SLUG, issueId: ISSUE, gates: [{ gate: "tests-pass", passed: 1 }] });
    writeReports(RUN, [mkReport(RUN, REQ, REPORT_ID)]);

    // N5, same rule as the absent audit store: the OPEN failing is the walker's
    // own substrate refusing, which is never evidence about this run's spend.
    const err = await refusalOfWalk(RUN);
    expect(err.code).toBe("walk-environment-fault");
    expect(err.message).toContain("ledger-absent");
    expect(err.message).toContain(ledgerPath);
    expect(err.remediation.length).toBeGreaterThan(0);
  });

  test("a ledger holding only ANOTHER run's rows breaks hop 3 — past the open, it IS evidence", async () => {
    seedRecord({ runId: RUN, requestId: REQ, reportId: REPORT_ID, prUrl: PR_URL, closedAt: new Date(iso(30)) });
    seedLinks([...credentialLinks(), ...boxLinks(), ...bundleLinks()]);
    buildTrace(join(runsDir, `${RUN}-artifacts`), { requestId: REQ, repoSlug: SLUG, issueId: ISSUE, gates: [{ gate: "tests-pass", passed: 1 }] });
    writeReports(RUN, [mkReport(RUN, REQ, REPORT_ID)]);

    // A real, readable ledger that simply carries no row for THIS run. Only the
    // open is an environment fault; everything past it is about the run, and a
    // run with no cost provenance is never zero spend (DF5.4-C1).
    seedLedger(RUN_B, REQ_B);
    const report = await walk(RUN);
    const cost = hopOf(report, "run-cost") as { status: string; expected: string; actual: string; diagnostic: string; evidencePath: string };
    expect(cost.status).toBe("broken");
    expect(cost.actual).toBe("hasEvents: false");
    expect(cost.diagnostic).toContain("DF5.4-C1");
    expect(cost.evidencePath).toBe(ledgerPath);
    expect(report.complete).toBe(false);
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
    // AC6: hops 2/6/9 all report the unharvested trace as `evidence-not-harvested`
    // naming the artifacts dir — never a resolved hop with a footnote.
    const hop2 = hopOf(report, "run-issue") as { status: string; hop: string; reason: string; evidencePath: string; detail?: unknown };
    expect(hop2.status).toBe("evidence-not-harvested");
    expect(hop2.hop).toBe("run-issue");
    expect(hop2.reason).toContain(join(runsDir, `${RUN}-artifacts`));
    expect(hop2.evidencePath).toBe(join(runsDir, `${RUN}-artifacts`));
    expect(hop2.detail).toBeUndefined();
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

// ─── 10c. hop 9's empty-collection boundary ──────────────────────────────────

describe("zero gate rows (DoD: an unverified run is not a complete chain)", () => {
  test("a harvested trace with NO gate_results rows is broken, distinct from evidence-not-harvested", async () => {
    // `buildTrace`'s `gates: []` default was never used: every one of its ~20
    // call sites passes at least one gate, and the only zero-evidence case
    // driven anywhere was a MISSING artifacts dir. The in-between shape — the
    // trace exists, hop 9 reads it, there are no gate rows — is what a run that
    // crashed before the verify phase harvests, and production could have
    // returned `resolved` with `count: 0` (a COMPLETE chain over a run with no
    // gate evidence at all), `unlinked`, or this. Pin the intended one.
    seedRecord({ runId: RUN, requestId: REQ, reportId: REPORT_ID, prUrl: PR_URL, closedAt: new Date(iso(30)) });
    seedLedger();
    seedLinks([...credentialLinks(), ...boxLinks(), ...bundleLinks()]);
    buildTrace(join(runsDir, `${RUN}-artifacts`), { requestId: REQ, repoSlug: SLUG, issueId: ISSUE, gates: [] });
    writeReports(RUN, [mkReport(RUN, REQ, REPORT_ID)]);

    const report = await walk(RUN);

    const hop9 = hopOf(report, "run-gate-evidence") as { status: string; expected: string; actual: string; diagnostic: string; evidencePath: string };
    expect(hop9.status).toBe("broken");
    expect(hop9.actual).toBe("none");
    expect(hop9.expected).toContain(REQ);
    expect(hop9.diagnostic).toContain("not a run this chain vouches for");
    // NOT evidence-not-harvested: the trace is right there and was read.
    expect(hop9.evidencePath).toBe(join(runsDir, `${RUN}-artifacts`, "trace", "trace.db"));
    // Hop 2 reads the same trace and its own correlation is intact.
    expect(hopOf(report, "run-issue").status).toBe("resolved");
    expect(report.complete).toBe(false);
  });
});

// ─── 10b. hop 6 digests the bundle's RAW BYTES ───────────────────────────────

describe("bundle digest over raw bytes (regression: the latin1 round-trip)", () => {
  test("a binary bundle resolves and reports the same sha256 the emitter wrote", async () => {
    seedRecord({ runId: RUN, requestId: REQ, reportId: REPORT_ID, prUrl: PR_URL, closedAt: new Date(iso(30)) });
    seedLedger();
    seedLinks([...credentialLinks(), ...boxLinks(), ...bundleLinks()]);
    buildTrace(join(runsDir, `${RUN}-artifacts`), { requestId: REQ, repoSlug: SLUG, issueId: ISSUE, gates: [{ gate: "tests-pass", passed: 1 }] });
    writeReports(RUN, [mkReport(RUN, REQ, REPORT_ID)]);

    const bytes = readFileSync(join(runsDir, `${RUN}.bundle`));
    expect(bytes.some((b) => b >= 0x80)).toBe(true); // the fixture must be genuinely binary
    const fileSha = createHash("sha256").update(bytes).digest("hex");

    const report = await walk(RUN);

    const hop6 = hopOf(report, "run-bundle") as { status: string; detail: { sha256: string; bundleBytes: number } };
    expect(hop6.status).toBe("resolved");
    expect(hop6.detail.sha256).toBe(fileSha); // a latin1 round-trip reports a different hex here
    expect(hop6.detail.bundleBytes).toBe(bytes.byteLength);
    expect(report.complete).toBe(true);
  });
});

// ─── 10d. emitted-row tamper on hops 4/5/6 ───────────────────────────────────

describe("emitted-row tamper (DoD: the digest is the guard, on every row)", () => {
  test("a credential row whose detail no longer digests to its evidence_digest → hop 4 evidence-mismatch", async () => {
    seedRecord({ runId: RUN, requestId: REQ, reportId: REPORT_ID, prUrl: PR_URL, closedAt: new Date(iso(30)) });
    seedLedger();
    // Every OTHER fixture row digests the detail it stores, so the recompute
    // can never disagree — this is the one row that carries a foreign digest.
    const tamperedDigest = sha256Hex(canonicalJson({ tampered: true }));
    const rows = credentialLinks().map((r) => (r.event === "deliver" ? { ...r, evidenceDigest: tamperedDigest } : r));
    seedLinks([...rows, ...boxLinks(), ...bundleLinks()]);
    buildTrace(join(runsDir, `${RUN}-artifacts`), { requestId: REQ, repoSlug: SLUG, issueId: ISSUE, gates: [{ gate: "tests-pass", passed: 1 }] });
    writeReports(RUN, [mkReport(RUN, REQ, REPORT_ID)]);

    const report = await walk(RUN);

    const hop4 = hopOf(report, "run-credential") as { status: string; expectedDigest: string; actualDigest: string; evidencePath: string };
    expect(hop4.status).toBe("evidence-mismatch");
    expect(hop4.expectedDigest).toBe(tamperedDigest);
    expect(hop4.actualDigest).toBe(sha256Hex(canonicalJson(CREDENTIAL_DETAIL)));
    expect(hop4.evidencePath).toBe(join(runsDir, `${RUN}.json`));
    expect(report.complete).toBe(false);
  });

  test("a bundle whose bytes changed after harvest → hop 6 evidence-mismatch on the claimed sha256", async () => {
    seedRecord({ runId: RUN, requestId: REQ, reportId: REPORT_ID, prUrl: PR_URL, closedAt: new Date(iso(30)) });
    seedLedger();
    seedLinks([...credentialLinks(), ...boxLinks(), ...bundleLinks()]);
    buildTrace(join(runsDir, `${RUN}-artifacts`), { requestId: REQ, repoSlug: SLUG, issueId: ISSUE, gates: [{ gate: "tests-pass", passed: 1 }] });
    writeReports(RUN, [mkReport(RUN, REQ, REPORT_ID)]);

    // One appended byte AFTER the link rows were written: the rows still
    // self-digest cleanly, so only hop 6's own file-vs-claim check can see it.
    const path = join(runsDir, `${RUN}.bundle`);
    const claimed = createHash("sha256").update(readFileSync(path)).digest("hex");
    writeFileSync(path, Buffer.concat([readFileSync(path), Buffer.from([0x7f])]), { mode: 0o600 });
    const actual = createHash("sha256").update(readFileSync(path)).digest("hex");

    const report = await walk(RUN);

    const hop6 = hopOf(report, "run-bundle") as { status: string; expectedDigest: string; actualDigest: string; evidencePath: string };
    expect(hop6.status).toBe("evidence-mismatch");
    expect(hop6.expectedDigest).toBe(claimed);
    expect(hop6.actualDigest).toBe(actual);
    expect(hop6.evidencePath).toBe(path);
    expect(report.complete).toBe(false);
  });
});

// ─── 10c. hop 2 authority: the record decides, the trace corroborates ────────

describe("run-issue authority (INV-AUDIT-5: the box's trace is a claim)", () => {
  test("record correlation with an agreeing trace → resolved, corroboration confirmed", async () => {
    seedRecord({ runId: RUN, requestId: REQ, reportId: REPORT_ID, prUrl: PR_URL, closedAt: new Date(iso(30)) });
    seedLedger();
    seedLinks([...credentialLinks(), ...boxLinks(), ...bundleLinks()]);
    buildTrace(join(runsDir, `${RUN}-artifacts`), { requestId: REQ, repoSlug: SLUG, issueId: ISSUE, gates: [{ gate: "tests-pass", passed: 1 }] });
    writeReports(RUN, [mkReport(RUN, REQ, REPORT_ID)]);

    const report = await walk(RUN);

    const hop2 = hopOf(report, "run-issue") as { status: string; subjectId: string; evidencePath: string; detail: { repoSlug: string; issueId: string; corroboration: string } };
    expect(hop2.status).toBe("resolved");
    expect(hop2.subjectId).toBe(`${SLUG}#${ISSUE}`);
    expect(hop2.evidencePath).toBe(join(runsDir, `${RUN}.json`)); // the HOST record, not the trace
    expect(hop2.detail.repoSlug).toBe(SLUG);
    expect(hop2.detail.issueId).toBe(ISSUE);
    expect(hop2.detail.corroboration).toBe("confirmed");
    expect(report.complete).toBe(true);
  });

  test("NULL in-box correlation (the shape every dispatched run harvests) → resolved, unavailable", async () => {
    seedRecord({ runId: RUN, requestId: REQ, reportId: REPORT_ID, prUrl: PR_URL, closedAt: new Date(iso(30)) });
    seedLedger();
    seedLinks([...credentialLinks(), ...boxLinks(), ...bundleLinks()]);
    // The box invoked bare: repo_slug and issue_id are both NULL on its session row.
    buildTrace(join(runsDir, `${RUN}-artifacts`), { requestId: REQ, repoSlug: null, issueId: null, gates: [{ gate: "tests-pass", passed: 1 }] });
    writeReports(RUN, [mkReport(RUN, REQ, REPORT_ID)]);

    const report = await walk(PR_URL); // the PR-rooted walk, where the old code broke

    const hop2 = hopOf(report, "run-issue") as { status: string; subjectId: string; detail: { corroboration: string; corroborationReason: string } };
    expect(hop2.status).toBe("resolved");
    expect(hop2.subjectId).toBe(`${SLUG}#${ISSUE}`);
    expect(hop2.detail.corroboration).toBe("unavailable");
    expect(hop2.detail.corroborationReason).toContain("DF1.8 nullability");
    expect(report.complete).toBe(true);
  });

  test("record vs trace disagreement → broken with the INV-AUDIT-1 divergence diagnostic", async () => {
    seedRecord({ runId: RUN, requestId: REQ, reportId: REPORT_ID, prUrl: PR_URL, closedAt: new Date(iso(30)) });
    seedLedger();
    seedLinks([...credentialLinks(), ...boxLinks(), ...bundleLinks()]);
    buildTrace(join(runsDir, `${RUN}-artifacts`), { requestId: REQ, repoSlug: SLUG, issueId: "999", gates: [{ gate: "tests-pass", passed: 1 }] });
    writeReports(RUN, [mkReport(RUN, REQ, REPORT_ID)]);

    const report = await walk(RUN);

    const hop2 = hopOf(report, "run-issue") as { status: string; expected: string; actual: string; diagnostic: string; evidencePath: string };
    expect(hop2.status).toBe("broken");
    expect(hop2.expected).toContain(`issue ${ISSUE}`);
    expect(hop2.actual).toContain("issue 999");
    expect(hop2.diagnostic).toContain("INV-AUDIT-1");
    expect(hop2.evidencePath).toBe(join(runsDir, `${RUN}-artifacts`, "trace", "trace.db"));
    expect(report.complete).toBe(false);
  });

  test("record vs trace REPO disagreement → broken naming both repos (the other half of INV-AUDIT-1)", async () => {
    seedRecord({ runId: RUN, requestId: REQ, reportId: REPORT_ID, prUrl: PR_URL, closedAt: new Date(iso(30)) });
    seedLedger();
    seedLinks([...credentialLinks(), ...boxLinks(), ...bundleLinks()]);
    // Identity is the PAIR: the issue agrees, the repo does not. This is the
    // half that would attribute a run to the wrong repository.
    buildTrace(join(runsDir, `${RUN}-artifacts`), { requestId: REQ, repoSlug: "impostor/widgets", issueId: ISSUE, gates: [{ gate: "tests-pass", passed: 1 }] });
    writeReports(RUN, [mkReport(RUN, REQ, REPORT_ID)]);

    const report = await walk(RUN);

    const hop2 = hopOf(report, "run-issue") as { status: string; expected: string; actual: string; diagnostic: string; evidencePath: string };
    expect(hop2.status).toBe("broken");
    expect(hop2.expected).toContain(`repo ${SLUG}`);
    expect(hop2.actual).toContain("impostor/widgets");
    expect(hop2.diagnostic).toContain("INV-AUDIT-1");
    expect(hop2.evidencePath).toBe(join(runsDir, `${RUN}-artifacts`, "trace", "trace.db"));
    expect(report.complete).toBe(false);
  });

  test("a record carrying HALF the correlation → broken naming which half is absent", async () => {
    seedRecord({ runId: RUN, requestId: REQ, reportId: REPORT_ID, prUrl: PR_URL, closedAt: new Date(iso(30)), omitCorrelation: "issue" });
    seedLedger();
    seedLinks([...credentialLinks(), ...boxLinks(), ...bundleLinks()]);
    buildTrace(join(runsDir, `${RUN}-artifacts`), { requestId: REQ, repoSlug: SLUG, issueId: ISSUE, gates: [{ gate: "tests-pass", passed: 1 }] });
    writeReports(RUN, [mkReport(RUN, REQ, REPORT_ID)]);

    const report = await walk(RUN);

    const hop2 = hopOf(report, "run-issue") as { status: string; actual: string; evidencePath: string };
    expect(hop2.status).toBe("broken");
    expect(hop2.actual).toBe("issueId absent"); // never the "neither present" arm
    expect(hop2.evidencePath).toBe(join(runsDir, `${RUN}.json`));
    expect(report.complete).toBe(false);
  });

  test("a record carrying no correlation → broken, naming the record path", async () => {
    seedRecord({ runId: RUN, requestId: REQ, reportId: REPORT_ID, prUrl: PR_URL, closedAt: new Date(iso(30)), omitCorrelation: "both" });
    seedLedger();
    seedLinks([...credentialLinks(), ...boxLinks(), ...bundleLinks()]);
    // The box's trace DOES carry a correlation — and it cannot rescue the hop.
    buildTrace(join(runsDir, `${RUN}-artifacts`), { requestId: REQ, repoSlug: SLUG, issueId: ISSUE, gates: [{ gate: "tests-pass", passed: 1 }] });
    writeReports(RUN, [mkReport(RUN, REQ, REPORT_ID)]);

    const report = await walk(RUN);

    const hop2 = hopOf(report, "run-issue") as { status: string; expected: string; actual: string; diagnostic: string; evidencePath: string };
    expect(hop2.status).toBe("broken");
    expect(hop2.expected).toContain("extensions.budget.repoSlug");
    expect(hop2.actual).toBe("neither present");
    expect(hop2.evidencePath).toBe(join(runsDir, `${RUN}.json`));
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

    // `hopCeilingMs: 1`, not 0: a NON-POSITIVE ceiling now means "already
    // expired" and reports `elapsedMs: 0` WITHOUT running the hop (pinned in
    // its own test below), which would measure nothing. A positive 1 ms ceiling
    // is what the 25 ms sync seam genuinely exceeds, so the post-hoc arm — the
    // one this test exists for — is the one that fires.
    const report = await walk(PR_URL, { hopCeilingMs: 1, fetchPull: slowFetch });

    const hop1 = hopOf(report, "pr-run") as { status: string; ceilingMs: number; elapsedMs: number };
    expect(hop1.status).toBe("hop-timeout");
    expect(hop1.ceilingMs).toBe(1);
    expect(hop1.elapsedMs).toBeGreaterThanOrEqual(20);
    expect(report.timings.perHopMs["pr-run"]).toBeGreaterThanOrEqual(20);
    expect(report.complete).toBe(false);
    expect(chainVerdict(report).complete).toBe(false);
  });

  test("hopCeilingMs 0 means ALREADY EXPIRED: every hop times out at elapsedMs 0, the seam never runs", async () => {
    // One option, one meaning. Before this, a zero ceiling depended on whether
    // the hop body happened to block the event loop: a synchronous hop won the
    // `raceMs = 0` race (microtask beats macrotask) and resolved normally,
    // while hop 1's `ghFetchPull` clamped to `max(1, 0)` and did a third thing.
    seedRecord({ runId: RUN, requestId: REQ, reportId: REPORT_ID, prUrl: PR_URL, closedAt: new Date(iso(30)) });
    seedLedger();
    seedLinks([...credentialLinks(), ...boxLinks(), ...bundleLinks()]);
    buildTrace(join(runsDir, `${RUN}-artifacts`), { requestId: REQ, repoSlug: SLUG, issueId: ISSUE, gates: [{ gate: "tests-pass", passed: 1 }] });
    writeReports(RUN, [mkReport(RUN, REQ, REPORT_ID)]);
    let fetched = 0;
    const countingFetch = async (): Promise<{ body: string; headRef?: string; prUrl: string }> => {
      fetched += 1;
      return { body: `run ${RUN}`, headRef: `qds/${RUN}`, prUrl: PR_URL };
    };

    const report = await walk(PR_URL, { hopCeilingMs: 0, fetchPull: countingFetch });

    const hop1 = hopOf(report, "pr-run") as { status: string; ceilingMs: number; elapsedMs: number; budget: string };
    expect(hop1.status).toBe("hop-timeout");
    expect(hop1.ceilingMs).toBe(0);
    expect(hop1.elapsedMs).toBe(0);
    expect(hop1.budget).toBe("hop");
    expect(fetched).toBe(0); // the hop body never ran
    expect(report.timings.perHopMs["pr-run"]).toBe(0);
    expect(report.complete).toBe(false);
  });

  test("a hop whose promise NEVER settles is abandoned at its ceiling (the actual fail-closed case)", async () => {
    // Every other timeout case here blocks the loop with `Bun.sleepSync` or
    // fakes the clock, so all of them exercise only the POST-HOC "measure after
    // the hop returned" arm. A ceiling implemented as a bare `Date.now()`
    // comparison passes all of them and hangs the CLI forever on a wedged
    // `gh pr view`. This is the case that needs the race.
    seedRecord({ runId: RUN, requestId: REQ, reportId: REPORT_ID, prUrl: PR_URL, closedAt: new Date(iso(30)) });
    seedLedger();
    seedLinks([...credentialLinks(), ...boxLinks(), ...bundleLinks()]);
    buildTrace(join(runsDir, `${RUN}-artifacts`), { requestId: REQ, repoSlug: SLUG, issueId: ISSUE, gates: [{ gate: "tests-pass", passed: 1 }] });
    writeReports(RUN, [mkReport(RUN, REQ, REPORT_ID)]);

    const report = await walk(PR_URL, { hopCeilingMs: 50, fetchPull: () => new Promise<never>(() => {}) });

    const hop1 = hopOf(report, "pr-run") as { status: string; ceilingMs: number; budget: string };
    expect(hop1.status).toBe("hop-timeout");
    expect(hop1.ceilingMs).toBe(50);
    expect(hop1.budget).toBe("hop");
    // Hop 1 named no runId, so the record-joined hops say so rather than
    // vouching for a run the walk never identified.
    expect(hopOf(report, "run-approval").status).toBe("broken");
    expect(report.complete).toBe(false);
    expect(chainVerdict(report).complete).toBe(false);
  }, 10_000);

  test("the SAME slow hop 1 under a real (non-zero) ceiling stays resolved", async () => {
    // With `hopCeilingMs: 0` every hop taking ≥ 1 ms times out, so that test
    // cannot tell a per-hop measurement from a blanket failure. Same seam,
    // same ~25 ms, a ceiling well above it: this one must resolve.
    //
    // The ceiling is 10 s, not 1 s: the assertions below are wall-clock
    // readings of a real 25 ms sync sleep, and a GC pause or a contended CI box
    // can push that past a 1 s ceiling — which flips the hop to `hop-timeout`
    // and reds the suite for a reason that has nothing to do with the walker.
    // An intermittent red on the timeout suite trains the team to re-run it,
    // which is how a genuine fail-closed regression gets waved through.
    seedRecord({ runId: RUN, requestId: REQ, reportId: REPORT_ID, prUrl: PR_URL, closedAt: new Date(iso(30)) });
    seedLedger();
    seedLinks([...credentialLinks(), ...boxLinks(), ...bundleLinks()]);
    buildTrace(join(runsDir, `${RUN}-artifacts`), { requestId: REQ, repoSlug: SLUG, issueId: ISSUE, gates: [{ gate: "tests-pass", passed: 1 }] });
    writeReports(RUN, [mkReport(RUN, REQ, REPORT_ID)]);
    const slowFetch = async (): Promise<{ body: string; headRef?: string; prUrl: string }> => {
      Bun.sleepSync(25);
      return { body: `run ${RUN}`, headRef: `qds/${RUN}`, prUrl: PR_URL };
    };

    const report = await walk(PR_URL, { hopCeilingMs: 10_000, fetchPull: slowFetch });

    const hop1 = hopOf(report, "pr-run") as { status: string };
    expect(hop1.status).toBe("resolved");
    expect(report.timings.prFetchMs).toBeGreaterThanOrEqual(20); // the slow seam really ran
    expect(report.timings.perHopMs["pr-run"]).toBeGreaterThanOrEqual(20);
    expect(report.timings.perHopMs["pr-run"]).toBeLessThan(10_000); // under ITS ceiling, hence resolved
  });

  test("the WALK budget, not the hop's, names itself: budget 'total' at the 30 s ceiling", async () => {
    seedRecord({ runId: RUN, requestId: REQ, reportId: REPORT_ID, prUrl: PR_URL, closedAt: new Date(iso(30)) });
    seedLedger();
    seedLinks([...credentialLinks(), ...boxLinks(), ...bundleLinks()]);
    buildTrace(join(runsDir, `${RUN}-artifacts`), { requestId: REQ, repoSlug: SLUG, issueId: ISSUE, gates: [{ gate: "tests-pass", passed: 1 }] });
    writeReports(RUN, [mkReport(RUN, REQ, REPORT_ID)]);

    // The walk measures its total budget with Date.now(); the hop-1 seam jumps
    // the clock past the 30 s ceiling rather than the suite waiting for it.
    const realNow = Date.now;
    let offset = 0;
    Date.now = () => realNow() + offset;
    let report: ChainReport;
    try {
      report = await walk(PR_URL, {
        fetchPull: async () => {
          offset = 40_000;
          return { body: `run ${RUN}`, headRef: `qds/${RUN}`, prUrl: PR_URL };
        },
      });
    } finally {
      Date.now = realNow;
    }

    const hop2 = hopOf(report, "run-issue") as { status: string; ceilingMs: number; budget: string; elapsedMs: number };
    expect(hop2.status).toBe("hop-timeout");
    expect(hop2.budget).toBe("total"); // never "hop": the per-hop ceiling was never reached
    expect(hop2.ceilingMs).toBe(30_000);
    expect(hop2.elapsedMs).toBeGreaterThanOrEqual(40_000);
    expect(report.complete).toBe(false);
  });
});

// ─── 12. redaction (INV-AUDIT-2) ─────────────────────────────────────────────

describe("redaction (DoD: INV-AUDIT-2, no secret material in report or logs)", () => {
  test("a clone-URL token and minted key material never reach the report or a log line", async () => {
    // No OPENROUTER_PROVISIONING_KEY arm: `src/audit/chain.ts` has zero
    // references to that variable, so the assertion (and the env juggling that
    // set it up) could never fail whatever the walker did. These two secrets
    // are the ones the walk genuinely READS — the record's httpsUrl and the
    // mint row's detail.
    const gitToken = "tok_SECRETTOKENVALUE123456789";
    const minted = "sk-or-v1-MINTEDKEYVALUE999999999";
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
    for (const secret of [gitToken, minted]) {
      expect(serialized).not.toContain(secret);
    }
    // The log half of the claim is vacuous when the sink received nothing: the
    // loop body simply never runs and "no secret in any log line" evaporates
    // silently. Prove the sink is wired to the code under test — the walk emits
    // one `audit-chain.hop` line per hop, carrying THIS run's id.
    assertWalkLogged(lines, RUN);
    for (const entry of lines) {
      const line = JSON.stringify(entry);
      for (const secret of [gitToken, minted]) expect(line).not.toContain(secret);
    }
    const hop4 = hopOf(report, "run-credential") as { status: string; detail: { keyHash?: string; keyHashPrefix?: string; keyMaterial?: string } };
    expect(hop4.status).toBe("resolved");
    expect(hop4.detail.keyHash).toBe(KEY_HASH);
    // The LITERAL, not `KEY_HASH.slice(0, 8)` — an expectation computed by the
    // same expression the implementation uses pins nothing. `sha256:a` is seven
    // characters of algorithm label plus ONE hex digit, which is the property:
    // a prefix that leaked 40 hex chars is a one-character edit from passing.
    expect(hop4.detail.keyHashPrefix).toBe("sha256:a");
    expect(hop4.detail.keyMaterial).toBeUndefined();
    // The POSITIVE control for the mint half: the walker demonstrably READ this
    // row's detail (it reported `keyHash` out of it) and dropped only the key
    // material. Without it, `not.toContain(minted)` is satisfied by a walker
    // that never opened the row at all.
    //
    // `httpsUrl` has NO equivalent, and cannot: `src/audit/chain.ts` contains
    // zero references to it, so the clone URL is never projected into any hop's
    // detail. The `gitToken` assertion above is therefore a REGRESSION guard —
    // it fires the day a hop starts surfacing box/clone metadata — and the
    // redaction MECHANISM it would depend on is pinned positively, on a value
    // that does reach the report, by the `cap() redacts` test below.
    expect(JSON.stringify(report)).not.toContain("x-access-token");
  });

  test("caller data is PROJECTED at hop 1: a retired extensions.pr field has no route into the report", async () => {
    seedRecord({ runId: RUN, requestId: REQ, reportId: REPORT_ID, prUrl: PR_URL, closedAt: new Date(iso(30)) });
    // A retired key an older build left in extensions.pr, which the store's
    // per-field deep merge re-persists verbatim on every write. Hop 1 spread
    // the entry WHOLE into the report; it now projects the three registered
    // fields, so this value has no route into a --json report.
    const retired = "tok_RETIREDPRFIELDSECRET0001";
    plantPrExtras(RUN, { cloneToken: retired });
    seedLedger();
    seedLinks([...credentialLinks(), ...boxLinks(), ...bundleLinks()]);
    buildTrace(join(runsDir, `${RUN}-artifacts`), { requestId: REQ, repoSlug: SLUG, issueId: ISSUE, gates: [{ gate: "tests-pass", passed: 1 }] });
    writeReports(RUN, [mkReport(RUN, REQ, REPORT_ID)]);

    const lines: unknown[] = [];
    const restore = setLogSink((entry) => lines.push(entry));
    let report: ChainReport;
    try {
      report = await walk(RUN);
    } finally {
      restore();
    }

    const hop1 = hopOf(report, "pr-run") as { status: string; detail: Record<string, unknown> };
    expect(hop1.status).toBe("resolved");
    // The three registered fields survive — the projection is a whitelist, not
    // a deletion of one known-bad key.
    expect(Object.keys(hop1.detail).sort()).toEqual(["createdAt", "prNumber", "prUrl"]);
    expect(JSON.stringify(report)).not.toContain(retired);
    assertWalkLogged(lines, RUN);
    for (const entry of lines) expect(JSON.stringify(entry)).not.toContain(retired);
  });

  test("cap() REDACTS before it bounds: a secret-shaped gate string arrives as «redacted», not as 2 000 chars of it", async () => {
    // C-4: `cap()` is the walker's ONE diagnostic chokepoint and runs
    // `redactSecrets` first, so a 5 000-char opaque token never reaches the
    // 2 000-char bound at all. Capping such a value would have published 2 000
    // characters of the secret — redaction is the STRONGER guarantee and the
    // one INV-AUDIT-2 actually claims. This is also the positive control for
    // the redaction mechanism: a value that genuinely reaches the report.
    seedRecord({ runId: RUN, requestId: REQ, reportId: REPORT_ID, prUrl: PR_URL, closedAt: new Date(iso(30)) });
    seedLedger();
    seedLinks([...credentialLinks(), ...boxLinks(), ...bundleLinks()]);
    // `gate` and `phase_id` are written INSIDE the box — agent-controlled text,
    // echoed up to 50 rows deep. This one is the long-opaque-token shape.
    const secretGate = "g".repeat(5_000);
    buildTrace(join(runsDir, `${RUN}-artifacts`), { requestId: REQ, repoSlug: SLUG, issueId: ISSUE, gates: [{ gate: secretGate, passed: 1 }] });
    writeReports(RUN, [mkReport(RUN, REQ, REPORT_ID)]);

    const lines: unknown[] = [];
    const restore = setLogSink((entry) => lines.push(entry));
    let report: ChainReport;
    try {
      report = await walk(RUN);
    } finally {
      restore();
    }

    const hop9 = hopOf(report, "run-gate-evidence") as { status: string; detail: { rows: { gate: string }[] } };
    expect(hop9.status).toBe("resolved");
    expect(hop9.detail.rows[0]?.gate).toBe("«redacted»");
    // Not one character of the token survives anywhere — report or log line.
    expect(JSON.stringify(report)).not.toContain("gggg");
    assertWalkLogged(lines, RUN);
    for (const entry of lines) expect(JSON.stringify(entry)).not.toContain("gggg");
  });

  test("cap() BOUNDS what redaction leaves alone: hop 9's gate and hop 1's head ref both land at 2 000 chars", async () => {
    seedRecord({ runId: RUN, requestId: REQ, reportId: REPORT_ID, prUrl: PR_URL, closedAt: new Date(iso(30)) });
    seedLedger();
    seedLinks([...credentialLinks(), ...boxLinks(), ...bundleLinks()]);
    // Long, but with word boundaries — NOT the opaque-token shape, so
    // `redactSecrets` returns it untouched and the 2 000-char bound is what
    // actually fires. (The previous fixture's `"g".repeat(5_000)` collapsed to
    // ten characters before ever reaching the bound, so the length assertion
    // was testing redaction under a capping name.)
    const longGate = "gate step ".repeat(500);
    expect(longGate.length).toBe(5_000);
    buildTrace(join(runsDir, `${RUN}-artifacts`), { requestId: REQ, repoSlug: SLUG, issueId: ISSUE, gates: [{ gate: longGate, passed: 1 }] });
    writeReports(RUN, [mkReport(RUN, REQ, REPORT_ID)]);

    const report = await walk(RUN);
    // The head ref is GitHub's string; a PR whose head is not qds/<runId>
    // lands it in hop 1's `actual`, where it must arrive capped.
    const prReport = await walk(PR_URL, {
      fetchPull: async () => ({ body: `run ${RUN}`, headRef: `x/${"head ref ".repeat(600)}`, prUrl: PR_URL }),
    });

    const hop9 = hopOf(report, "run-gate-evidence") as { status: string; detail: { rows: { gate: string }[] } };
    expect(hop9.status).toBe("resolved");
    const gate = hop9.detail.rows[0]?.gate as string;
    expect(gate.length).toBe(2_000);
    expect(gate.endsWith("…")).toBe(true);
    expect(gate.startsWith("gate step ")).toBe(true); // bounded, not replaced

    const brokenHop1 = hopOf(prReport, "pr-run") as { status: string; actual: string };
    expect(brokenHop1.status).toBe("broken");
    expect(brokenHop1.actual.length).toBe(2_000);
    expect(brokenHop1.actual.endsWith("…")).toBe(true);
  });
});

// ─── 13. typed refusals that escape the walk (no report is produced) ─────────

describe("ChainWalkError (DoD: a refusal the CLI handles, never a confident report)", () => {
  test("a bare ref shaped like a runId with no record refuses invalid-ref, before any hop", async () => {
    // `RUN_ID_FORM_RE` admits any lowercase word, so `dev` parses as a run id;
    // the record-existence gate is what turns an operator typo into a refusal
    // instead of a ten-hop broken-chain report about a run nobody dispatched.
    let caught: unknown;
    try {
      await walk("dev");
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ChainWalkError);
    const err = caught as ChainWalkError;
    expect(err.code).toBe("invalid-ref");
    expect(err.message).toContain(join(runsDir, "dev.json"));
    expect(err.remediation.length).toBeGreaterThan(0);
  });

  test("a hop-1 PR read failure ESCAPES the walk with its remediation, never flattened into a broken hop", async () => {
    seedRecord({ runId: RUN, requestId: REQ, reportId: REPORT_ID, prUrl: PR_URL, closedAt: new Date(iso(30)) });
    seedLedger();
    seedLinks([...credentialLinks(), ...boxLinks(), ...bundleLinks()]);
    const refusal = new ChainWalkError(
      "pr-fetch-failed",
      "gh pr view failed for the ref (exit 1): could not resolve to a PullRequest",
      "authenticate gh (`gh auth status`), or walk the bare runId",
    );

    let caught: unknown;
    try {
      await walk(PR_URL, { fetchPull: () => Promise.reject(refusal) });
    } catch (e) {
      caught = e;
    }
    // Before C9 the hop's catch-all swallowed this into a generic `broken`,
    // discarded the remediation and returned a report — exit 0 territory.
    expect(caught).toBe(refusal);
    expect((caught as ChainWalkError).code).toBe("pr-fetch-failed");
    expect((caught as ChainWalkError).remediation).toContain("gh auth status");
  });
});

// ─── 14. the rewritten subject (the attack the module header claims) ─────────

describe("rewritten approval subject (DoD: a tamper that MOVES the subject id is still caught)", () => {
  test("editing extensions.approval.approverId between walks → evidence-mismatch naming both subject ids", async () => {
    seedRecord({ runId: RUN, requestId: REQ, reportId: REPORT_ID, prUrl: PR_URL, closedAt: new Date(iso(30)) });
    seedLedger();
    seedLinks([...credentialLinks(), ...boxLinks(), ...bundleLinks()]);
    buildTrace(join(runsDir, `${RUN}-artifacts`), { requestId: REQ, repoSlug: SLUG, issueId: ISSUE, gates: [{ gate: "tests-pass", passed: 1 }] });
    writeReports(RUN, [mkReport(RUN, REQ, REPORT_ID)]);

    const first = await walk(RUN);
    const firstHop8 = hopOf(first, "run-approval") as { status: string; subjectId: string };
    expect(firstHop8.status).toBe("resolved");
    expect(firstHop8.subjectId).toBe(`alice@${DECIDED_AT}`);

    // The tamper that used to succeed: hop 8's subject id is
    // `${approverId}@${decidedAt}`, so rewriting the approver MOVED the key the
    // prior row was looked up under. No prior found → no comparison → a second
    // first-observation row appended → resolved, complete, exit 0.
    const store = new RunRecordStore({ dir: runsDir });
    store.set(RUN, { extensions: { approval: { approverId: "mallory" } } });

    const second = await walk(RUN);
    const hop8 = hopOf(second, "run-approval") as {
      status: string; expectedDigest: string; actualDigest: string;
      expectedSubjectId: string; actualSubjectId: string; evidencePath: string;
    };
    expect(hop8.status).toBe("evidence-mismatch");
    expect(hop8.expectedSubjectId).toBe(`alice@${DECIDED_AT}`);
    expect(hop8.actualSubjectId).toBe(`mallory@${DECIDED_AT}`);
    expect(hop8.expectedDigest).not.toBe(hop8.actualDigest);
    expect(hop8.evidencePath).toBe(join(runsDir, `${RUN}.json`));
    expect(second.complete).toBe(false);
  });
});

// ─── 15. hop 8 needs the stamps its constraint names ─────────────────────────

describe("missing authorization stamps (DoD: a stamp the constraint needs is a named broken hop)", () => {
  test("extensions.pr with no createdAt → hop 8 broken naming the field, never a skipped constraint", async () => {
    seedRecord({ runId: RUN, requestId: REQ, reportId: REPORT_ID, prUrl: PR_URL, prCreatedAt: null, closedAt: new Date(iso(30)) });
    seedLedger();
    seedLinks([...credentialLinks(), ...boxLinks(), ...bundleLinks()]);
    buildTrace(join(runsDir, `${RUN}-artifacts`), { requestId: REQ, repoSlug: SLUG, issueId: ISSUE, gates: [{ gate: "tests-pass", passed: 1 }] });
    writeReports(RUN, [mkReport(RUN, REQ, REPORT_ID)]);

    const report = await walk(RUN);

    const hop1 = hopOf(report, "pr-run") as { status: string };
    expect(hop1.status).toBe("resolved"); // hop 1 tolerates the absent stamp
    const hop8 = hopOf(report, "run-approval") as { status: string; expected: string; actual: string; diagnostic: string; evidencePath: string };
    expect(hop8.status).toBe("broken");
    expect(hop8.expected).toContain("extensions.pr.createdAt");
    expect(hop8.actual).toContain("no createdAt");
    expect(hop8.diagnostic).toContain("DF5.2");
    expect(hop8.evidencePath).toBe(join(runsDir, `${RUN}.json`));
    expect(report.complete).toBe(false);
  });
});

// ─── 16. rows already on disk: unparsable stamps and lawful duplicates ───────

describe("link rows the store would refuse today (DoD: the read side guards too)", () => {
  test("an unparsable occurred_at is a named broken hop, never a silently skipped order check", async () => {
    seedRecord({ runId: RUN, requestId: REQ, reportId: REPORT_ID, prUrl: PR_URL, closedAt: new Date(iso(30)) });
    seedLedger();
    const [mint, deliver, revoke, verify] = credentialLinks() as [AuditLinkInput, AuditLinkInput, AuditLinkInput, AuditLinkInput];
    seedLinks([mint, deliver, verify, ...boxLinks(), ...bundleLinks()]);
    // The row a pre-validation build could write: a garbage stamp between two
    // good ones. `msOf` returned undefined and the ordering loop continued —
    // i.e. a bad timestamp was a way to switch the check off.
    seedRawLink({ ...revoke, occurredAt: "yesterday-ish" });
    buildTrace(join(runsDir, `${RUN}-artifacts`), { requestId: REQ, repoSlug: SLUG, issueId: ISSUE, gates: [{ gate: "tests-pass", passed: 1 }] });
    writeReports(RUN, [mkReport(RUN, REQ, REPORT_ID)]);

    const report = await walk(RUN);

    const hop4 = hopOf(report, "run-credential") as { status: string; expected: string; actual: string; diagnostic: string; evidencePath: string };
    expect(hop4.status).toBe("broken");
    expect(hop4.expected).toContain("ISO-8601 occurred_at");
    expect(hop4.actual).toMatch(/^link \d+ \(run-credential\.revoke\) carries occurred_at "yesterday-ish"$/);
    // The DoD clause is a NAMED broken hop, and every sibling pins its own
    // token (INV-AUDIT-1/-4, DF5.4-C1, DF5.2). `length > 0` accepted `"error"`;
    // this pins the remediation sentence that makes the hop actionable.
    expect(hop4.diagnostic).toContain("not permission to skip the ordering check");
    expect(hop4.evidencePath).toBe(join(runsDir, `${RUN}.json`));
    expect(report.complete).toBe(false);
  });

  test("a lawful SECOND row for one event (a re-mint) resolves and is reported as a count", async () => {
    seedRecord({ runId: RUN, requestId: REQ, reportId: REPORT_ID, prUrl: PR_URL, closedAt: new Date(iso(30)) });
    seedLedger();
    // A re-mint under a NEW keyHash: a different subject, so the schema's
    // UNIQUE (run_id, hop, event, subject_key) admits it. Two rows for one
    // event are lawful (C3/C4) and the newest is the ordering subject.
    const reMintDetail = { keyHash: `sha256:${"cd".repeat(32)}`, limitMicroUsd: 50_000_000 };
    const reMint = link({
      event: "mint", subjectId: reMintDetail.keyHash, subjectKind: "run-key",
      evidencePath: join(runsDir, `${RUN}.json`), detail: reMintDetail,
      evidenceDigest: sha256Hex(canonicalJson(reMintDetail)),
      occurredAt: iso(2.25), recordedAt: iso(2.25),
    });
    seedLinks([...credentialLinks(), reMint, ...boxLinks(), ...bundleLinks()]);
    buildTrace(join(runsDir, `${RUN}-artifacts`), { requestId: REQ, repoSlug: SLUG, issueId: ISSUE, gates: [{ gate: "tests-pass", passed: 1 }] });
    writeReports(RUN, [mkReport(RUN, REQ, REPORT_ID)]);

    const report = await walk(RUN);

    const hop4 = hopOf(report, "run-credential") as {
      status: string; detail: { rowsPerEvent?: Record<string, number>; events: Record<string, { occurredAt: string }> };
    };
    expect(hop4.status).toBe("resolved");
    expect(hop4.detail.rowsPerEvent).toEqual({ mint: 2 });
    expect(hop4.detail.events.mint?.occurredAt).toBe(iso(2.25)); // the NEWEST row orders
    expect(report.complete).toBe(true);
  });
});
