/**
 * Runtime tests for the qds-audit CLI (DF5.3): the exit-code matrix
 * (0 complete / 1 broken chain / 2 bad invocation OR a walk that faulted
 * before producing a report), the --json contract (ChainReport verbatim on
 * stdout, logs on stderr), the four store-path seams (a fixture walk never
 * touches the developer's `.sandbox/`), and INV-AUDIT-2 (no secret material in
 * stdout or stderr).
 *
 * Drives the REAL script through Bun.spawnSync, and — where the process
 * boundary adds nothing — the exported `run(argv): Promise<number>` directly,
 * which returns the exit code instead of calling `process.exit`. Fixtures are
 * built with the real stores (RunRecordStore, CostLedger, openAuditStore, the
 * trace schema) — the minimal fixture set this file needs, copied from the
 * chain suite's approach rather than imported from it (test files never import
 * test files).
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";

import { AUDIT_HOPS, OQ4_VOID_REASON, type AuditLinkInput, type ChainReport, type HopOutcome } from "../../src/audit/index.ts";
import { canonicalJson, openAuditStore, sha256Hex } from "../../src/audit/link-store.ts";
import { applyMigrations, SCHEMA_DDL } from "../../src/phase-engine/trace/schema.ts";
import type { CostEvent } from "../../cli-anything/src/types.ts";
import { CostLedger } from "../../src/providers/cost-ledger.ts";
import { RunRecordStore } from "../../src/providers/run-record.ts";
import { brokenDetail, describeHop, run } from "../../scripts/qds-audit.ts";
import { chainVerdict } from "../../src/audit/index.ts";
import { log, setLogSink, type LogEntry } from "../../src/swarmclaw/log.ts";

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
/**
 * INV-AUDIT-2 has to be tested against secrets the code under test actually
 * READS. `GH_TOKEN`/`PROVISIONING_KEY` above are env values and this is a
 * zero-network run-id walk, so asserting on those alone is a tautology that
 * would pass on empty output. These two are planted INSIDE the walked data —
 * one in a link row's `detail`, one in a run-record field — so the assertion
 * fails if any renderer ever echoes the payload it was handed.
 */
const PLANTED_LINK_SECRET = "sk-or-v1-PLANTEDINLINKDETAIL000000000000";
const PLANTED_RECORD_SECRET = "ghp_PLANTEDINTHERUNRECORD00000000000";

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
 * One decoy per seam, evaluated against THIS fixture's tmp dir. If any of the
 * four explicit paths leaks to its default, the walk reads (or worse, creates)
 * the decoy instead of the fixture — and `expectNoDecoys` catches it whatever
 * the exit code says.
 *
 * Three of the four have an env override; `--reverify-dir` has none, so its
 * default (`.sandbox/reverify`) resolves against the CWD, which every spawn
 * sets to the fixture dir. `.sandbox` is therefore the fourth decoy.
 */
function decoyPaths(): Record<string, string> {
  return {
    auditDb: join(fx.dir, "decoy-audit.db"),
    runsDir: join(fx.dir, "decoy-runs"),
    ledger: join(fx.dir, "decoy-cost-ledger.db"),
    sandbox: join(fx.dir, ".sandbox"),
  };
}

function expectNoDecoys(): void {
  for (const path of Object.values(decoyPaths())) {
    // the path rides in the expectation so a failure names WHICH seam leaked
    expect([path, existsSync(path)]).toEqual([path, false]);
  }
}

/**
 * The CLI runs with NO .sandbox anywhere on its path — the seams are the
 * point. An explicit ALLOWLIST rather than `...process.env`: a developer with
 * `QDS_COST_LEDGER_FILE` exported would otherwise have this suite read their
 * real ledger, and the leak would be invisible because the decoy assertions
 * would still hold.
 */
function spawnEnv(): Record<string, string> {
  const decoys = decoyPaths();
  return {
    PATH: process.env.PATH ?? "",
    HOME: process.env.HOME ?? "",
    TMPDIR: process.env.TMPDIR ?? "/tmp",
    GH_TOKEN,
    OPENROUTER_PROVISIONING_KEY: PROVISIONING_KEY,
    QDS_AUDIT_DB: decoys.auditDb as string,
    QDS_RUNS_DIR: decoys.runsDir as string,
    QDS_COST_LEDGER_FILE: decoys.ledger as string,
  };
}

interface SpawnResult {
  code: number;
  stdout: string;
  stderr: string;
}

/**
 * A walk of this fixture is milliseconds of work; anything near this is wedged
 * (a hop budget that stopped firing, a `gh` invocation that blocks). Without it
 * `Bun.spawnSync` blocks FOREVER and the suite reports a bun-level test timeout
 * with no stdout, no stderr and no case attribution — the signal diagnostic
 * below, which exists precisely to name what went wrong, never runs.
 */
const SPAWN_TIMEOUT_MS = 30_000;

function spawnAudit(argv: string[]): SpawnResult {
  // `process.execPath`, not "bun": `bun test` runs every file in one process,
  // so a sibling suite that rewrites `process.env.PATH` (or a host with another
  // `bun` earlier on it) would otherwise decide which runtime audits the
  // fixture. The same reasoning — and the same fix — as
  // `tests/phase-engine/pipeline-run.test.ts`'s `spawnRunner`.
  const proc = Bun.spawnSync([process.execPath, SCRIPT, ...argv], {
    cwd: fx.dir,
    stdout: "pipe",
    stderr: "pipe",
    env: spawnEnv(),
    timeout: SPAWN_TIMEOUT_MS,
  });
  // `exitCode ?? 1` silently converted a CRASHED CLI (null exit code + a
  // signal) into the exact value the broken-chain tests assert. A crash is
  // never a verdict: surface it as a test error naming the signal.
  if (proc.exitCode === null) {
    const why = proc.exitedDueToTimeout === true
      ? `wedged — killed after ${SPAWN_TIMEOUT_MS}ms`
      : `signal ${String(proc.signalCode)}`;
    throw new Error(`qds-audit did not exit normally (${why}): ${proc.stderr.toString()}`);
  }
  return {
    code: proc.exitCode,
    stdout: proc.stdout.toString(),
    stderr: proc.stderr.toString(),
  };
}

/**
 * The fixture dir as the SPAWNED CLI's `process.cwd()` spells it. On macOS
 * `$TMPDIR` is `/var/folders/…`, a symlink to `/private/var/folders/…`, and the
 * child's cwd is the realpath — so any assertion on a path the CLI built by
 * `resolve()`ing a RELATIVE seam value (or a default) must be anchored here,
 * not on `fx.dir`. Absolute values passed on argv are unaffected.
 */
function spawnCwd(): string {
  return realpathSync(fx.dir);
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
        state: "approved", proposal: "ship it",
        reportId: REPORT_ID, headSha: HEAD,
        requestId: REQ, expiresAt: iso(60), requestedAt: iso(9),
        approverId: "alice", decidedAt: DECIDED_AT, reason: "green report",
      },
    },
  });
  store.close(RUN, new Date(iso(30)));
  // INV-AUDIT-2 bait, planted on disk rather than through `set`: the store
  // REFUSES key material outright ("refusing to write key material into the run
  // record: extensions.approval.proposal" — a separate, welcome guard), and a
  // record written by an older build or by a tamperer is the threat the READ
  // side has to survive anyway. `proposal` sits inside the object hop 8 digests
  // and hop 7 reads, and outside the four fields either one projects.
  const recordFile = join(fx.runsDir, `${RUN}.json`);
  const onDisk = JSON.parse(readFileSync(recordFile, "utf8")) as { extensions: { approval: Record<string, unknown> } };
  onDisk.extensions.approval.proposal = `ship it ${PLANTED_RECORD_SECRET}`;
  writeFileSync(recordFile, JSON.stringify(onDisk), { mode: 0o600 });
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
  // INV-AUDIT-2 bait: an emitter-supplied `detail` field on the CREDENTIAL hop.
  const detail = { keyHash: KEY_HASH, limitMicroUsd: 50_000_000, provisioningKey: PLANTED_LINK_SECRET };
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

/**
 * The REAL hop-6 shapes CONTRACT C3 gave `emitBundleLink`
 * (src/providers/harvest.ts): subject `<bundlePath>#<sha256>` for
 * bundle-verify and `<bundlePath>#<tip>` for bundle-fetch, `detail` carrying
 * exactly the one value that formed the subject. The fixture writes through
 * `openAuditStore().record(...)` rather than through the emitter, so it is
 * free to drift — which is why it mirrors the emitter's subject rather than
 * the bare `RUN` it used to use.
 */
const BUNDLE_TIP = "c".repeat(40);

function bundleLinks(): AuditLinkInput[] {
  const bytes = readFileSync(bundlePath());
  const sha = createHash("sha256").update(bytes).digest("hex");
  return [
    link({
      hop: "run-bundle", event: "bundle-verify",
      subjectId: `${bundlePath()}#${sha}`, subjectKind: "bundle",
      evidencePath: bundlePath(), detail: { sha256: sha },
      evidenceDigest: sha256Hex(canonicalJson({ sha256: sha })),
      occurredAt: iso(5), recordedAt: iso(5),
    }),
    link({
      hop: "run-bundle", event: "bundle-fetch",
      subjectId: `${bundlePath()}#${BUNDLE_TIP}`, subjectKind: "bundle",
      evidencePath: bundlePath(), detail: { tip: BUNDLE_TIP },
      evidenceDigest: sha256Hex(canonicalJson({ tip: BUNDLE_TIP })),
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

/**
 * A REAL ledger that simply holds no rows for this run — the way to break hop 3
 * now that the walker rethrows an unopenable ledger as a `ChainWalkError`
 * (N5). Deleting the file is an ENVIRONMENT fault ("I could not look", exit 2),
 * not a statement about the chain; a ledger the walk CAN read which records no
 * spend for the run is the genuine break (`hasEvents: false`, DF5.4-C1) and the
 * only shape that still reaches exit 1 through hop 3.
 */
function seedEmptyLedger(): void {
  // The WAL sidecars too: a `-wal` left beside a deleted db replays into the
  // fresh file and the schema create then fails on a table that is half there.
  for (const p of [fx.ledgerPath, `${fx.ledgerPath}-wal`, `${fx.ledgerPath}-shm`]) rmSync(p, { force: true });
  new CostLedger({
    path: fx.ledgerPath,
    readRunRecord: () => undefined,
    config: { defaultCapMicroUsd: 50_000_000, boxHourRateMicroUsd: 3_600_000 },
  }).close();
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
    // `typeof … === "number"` passes for NaN, and this walk performs no PR
    // fetch at all — the honest value is 0.
    expect(report.timings.prFetchMs).toBe(0);
    const run = Object.values(report.runs)[0]!;
    expect(Object.keys(run.hops)).toHaveLength(10);
    expect(run.hops["memory-retain-receipt"]).toEqual({ status: "void", hop: "memory-retain-receipt", reason: OQ4_VOID_REASON });
    expect(run.hops["run-cost"]?.status).toBe("resolved");
    // C3: the fixture now carries the emitter's real bundle subject shape.
    expect(run.hops["run-bundle"]?.status).toBe("resolved");
    expect((run.hops["run-bundle"] as { subjectId: string }).subjectId).toBe(`${bundlePath()}#${createHash("sha256").update(readFileSync(bundlePath())).digest("hex")}`);
    // stdout carries the report and nothing else; stderr is the log stream:
    // the walker logs the per-hop lines itself, and the CLI adds exactly ONE
    // aggregated verdict line — no CLI-level double-logging of hops.
    expect(r.stdout.startsWith("{")).toBe(true);
    expect(r.stderr.split("audit-chain.verdict").length - 1).toBe(1);
    expect(r.stderr.split('"operation":"audit-chain.hop"').length - 1).toBe(10);
    // all four seams held: nothing under any default path.
    expectNoDecoys();
  });

  test("human mode: every AUDIT_HOPS block, VOID reason verbatim, COMPLETE summary", () => {
    buildCompleteFixture();
    const r = spawnAudit([RUN, ...auditFlags()]);
    expect(r.code).toBe(0);
    // Iterated, not hand-listed: the previous literal was missing `run-issue`,
    // so the renderer could drop that hop undetected. And asserted on the
    // rendered HEADER line (`  <hop> [<status>]`), not a bare substring — a hop
    // name also appears inside diagnostics.
    expect(AUDIT_HOPS).toHaveLength(10);
    for (const hop of AUDIT_HOPS) {
      expect(r.stdout).toContain(`  ${hop} [`);
    }
    expect(r.stdout).toContain(OQ4_VOID_REASON); // verbatim
    expect(r.stdout).toContain(`chain: COMPLETE (${RUN}, run-id)`);
    // credential hop: the LABELLED hash + prefix lines. `toContain(prefix)`
    // alone can never fail while the full hash prints — it IS a prefix of it.
    expect(r.stdout).toContain(`\n    keyHash: ${KEY_HASH}\n`);
    expect(r.stdout).toContain(`\n    keyHashPrefix: ${KEY_HASH.slice(0, 8)}\n`);
    expectNoDecoys();
  });
});

// ─── 2. the broken chain ─────────────────────────────────────────────────────

describe("broken chain", () => {
  test("exit 1; human output names hop + expected/actual/diagnostic; --json still prints the report", () => {
    buildCompleteFixture();
    // A readable ledger with no rows FOR THIS RUN. Deleting the file instead
    // now exits 2 (the walker rethrows the failed open as a
    // `walk-environment-fault` — N5), which is a different contract and is
    // pinned in `walk faults` below; the exit-1 contract this test owns needs a
    // break the walk can actually SEE.
    seedEmptyLedger();
    const human = spawnAudit([RUN, ...auditFlags()]);
    expect(human.code).toBe(1);
    expect(human.stdout).toContain("run-cost");
    expect(human.stdout).toContain("ledger rows for the run");
    expect(human.stdout).toContain("actual: hasEvents: false");
    // The BROKEN verdict names the ref and its kind, and its COUNT is the
    // count of the DEDUPED names it lists — not of the raw broken-hop rows.
    const verdictLine = human.stdout.split("\n").find((l) => l.startsWith("chain: BROKEN")) as string;
    expect(verdictLine).toBeDefined();
    const parsed = /^chain: BROKEN \((.+), (.+); (\d+) broken hop\(s\): (.+)\)$/.exec(verdictLine);
    expect(parsed).not.toBeNull();
    const [, ref, refKind, count, names] = parsed as RegExpExecArray;
    expect([ref, refKind]).toEqual([RUN, "run-id"]);
    const listed = (names as string).split(", ");
    expect(Number(count)).toBe(listed.length);
    expect(new Set(listed).size).toBe(listed.length); // deduped
    expect(listed).toContain("run-cost");

    const json = spawnAudit([RUN, "--json", ...auditFlags()]);
    expect(json.code).toBe(1);
    const report = JSON.parse(json.stdout.trim()) as ChainReport;
    expect(report.complete).toBe(false);
    const run = Object.values(report.runs)[0]!;
    expect(run.hops["run-cost"]?.status).toBe("broken");
    expectNoDecoys();
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

// ─── 3. the invalid ref and the argv grammar ─────────────────────────────────

describe("invalid ref", () => {
  test("exit 2 with message + remediation, on STDERR", () => {
    const r = spawnAudit(["BAD_REF", ...auditFlags()]);
    expect(r.code).toBe(2);
    // stderr specifically: the documented contract is "the ChainReport and
    // NOTHING else on stdout", so a refusal written to fd 1 would break every
    // machine consumer of --json while a `stdout + stderr` assertion stayed green.
    expect(r.stderr).toContain("invalid-ref");
    expect(r.stderr).toContain("not a PR URL");
    expect(r.stderr).toContain("next: pass the merged PR URL");
    expect(r.stdout).toBe("");
  });

  test("--json + an invalid ref: stdout is EMPTY", () => {
    const r = spawnAudit(["BAD_REF", "--json", ...auditFlags()]);
    expect(r.code).toBe(2);
    expect(r.stdout).toBe("");
    expect(r.stderr).toContain("invalid-ref");
  });

  test("a well-formed runId with no run record is invalid-ref → 2, never a broken chain", () => {
    // The exit-1/exit-2 boundary for a ref that PARSES: `assertRunIdRefResolves`
    // throws before any hop runs, so no report exists and 1 is not available.
    const r = spawnAudit([RUN, ...auditFlags()]); // fixture never built: runs dir is empty
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("!! invalid-ref");
    expect(r.stderr).toContain(`no run record exists at ${join(fx.runsDir, `${RUN}.json`)}`);
    expect(r.stdout).toBe("");
  });

  test("usage: no ref → exit 2 with the usage line", () => {
    const r = spawnAudit([...auditFlags()]);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("Usage: qds-audit");
  });

  test("usage: two refs → exit 2 naming the arity, touching nothing", () => {
    // No seam flags here on purpose: without the stderr + decoy assertions a
    // regression that WALKED both refs against the hostile defaults would also
    // exit 2, indistinguishably.
    const r = spawnAudit(["run-a", "run-b"]);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("expected exactly one ref, got 2 (run-a, run-b)");
    expectNoDecoys();
  });

  test("an unknown flag is reported as itself, exit 2", () => {
    const r = spawnAudit([RUN, "--bogus", ...auditFlags()]);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("unknown flag: --bogus");
    expectNoDecoys();
  });

  test("a value flag with no value refuses instead of falling back to the default store", () => {
    const r = spawnAudit([RUN, "--audit-db"]);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("--audit-db requires a non-empty value");
    expectNoDecoys();
  });

  test("a stray single-dash token throws instead of being dropped", () => {
    // Dropped, `-runs-dir=/tmp/fixture` fell back to the developer's real store
    // while the command still exited 0/1.
    const r = spawnAudit([RUN, "-j", ...auditFlags()]);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("unknown flag: -j");
    expectNoDecoys();
  });

  test("a repeated value flag throws rather than silently last-winning", () => {
    // No fixture: this exits during argv parsing, so a full record + trace db +
    // ledger + link store + reverify report was pure cost. And the decoys are
    // asserted for the same reason every other usage-error test asserts them —
    // a regression that opened a store BEFORE validating the grammar would
    // otherwise still exit 2, indistinguishably.
    const r = spawnAudit([RUN, "--audit-db", fx.auditDb, "--audit-db", join(fx.dir, "other.db"), ...auditFlags().slice(0, 2)]);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("--audit-db given more than once");
    expectNoDecoys();
  });

  test("--help returns 0 and prints the usage block on stdout", () => {
    const r = spawnAudit(["--help"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("Usage: qds-audit");
    expect(r.stdout).toContain("--reverify-dir <dir>");
    // Help walks nothing — including none of the four DEFAULT seams, which is
    // the only state this test leaves them in.
    expectNoDecoys();
  });

  test("--json --help puts the help block on STDERR and leaves stdout empty", () => {
    // `--json` binds stdout to "the ChainReport and NOTHING else": a consumer's
    // JSON.parse must never be handed a help block. Exit is still 0 — help was
    // asked for and answered.
    const r = spawnAudit(["--json", "--help"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toBe("");
    expect(r.stderr).toContain("Usage: qds-audit");
    expectNoDecoys();
  });

  test("help in a VALUE position is the usage error it always was, never exit 0", () => {
    // Help used to be matched against raw argv, so a seam missing its value
    // printed help and returned 0 — which this CLI's binding matrix defines as
    // "a ChainReport was produced and the chain is COMPLETE". On a tool whose
    // exit code IS the verdict, a scripted caller read that as a verified
    // chain. Both spellings: `--help` after a value flag falls to the
    // missing-value error, and `-h` (which `tokenizeArgs` exempts from the
    // stray-single-dash rule) survives as a literal seam VALUE and is refused
    // by the path check with the path echoed.
    const missingValue = spawnAudit([RUN, "--ledger", "--help"]);
    expect(missingValue.code).toBe(2);
    expect(missingValue.stderr).toContain("--ledger requires a non-empty value");
    expect(missingValue.stdout).toBe("");

    const swallowed = spawnAudit([RUN, "--runs-dir", "-h"]);
    expect(swallowed.code).toBe(2);
    expect(swallowed.stderr).toContain("!! seam-unusable");
    expect(swallowed.stderr).toContain(`--runs-dir ${join(spawnCwd(), "-h")}`);
    expect(swallowed.stdout).toBe("");
    expectNoDecoys();
  });

  test("the --flag=value grammar: honoured when it carries a value, refused when it does not", () => {
    // `parseValueFlags` has a dedicated `--flag=value` branch that bypasses
    // `tokenizeArgs`' value pairing AND its empty-value refusal, so the whole
    // `=` spelling of every seam was uncovered — including the shape that
    // silently falls back to the operator's real store.
    buildCompleteFixture();
    const eq = spawnAudit([
      RUN, "--json",
      `--runs-dir=${fx.runsDir}`, `--audit-db=${fx.auditDb}`,
      `--ledger=${fx.ledgerPath}`, `--reverify-dir=${fx.reverifyDir}`,
    ]);
    expect(eq.code).toBe(0);
    // The seam was HONOURED, not merely accepted: a fallback to the decoys
    // would exit non-zero, and no seam warning fires when all four are given.
    expect(eq.stderr).not.toContain("audit-chain.seams");
    expect((JSON.parse(eq.stdout.trim()) as ChainReport).complete).toBe(true);
    expectNoDecoys();

    const empty = spawnAudit([RUN, "--audit-db=", ...auditFlags().slice(0, 2)]);
    expect(empty.code).toBe(2);
    expect(empty.stderr).toContain("--audit-db requires a non-empty value");
    expect(empty.stdout).toBe("");

    // The pairing spelling of the same emptiness — one rule, two grammars.
    const emptyPaired = spawnAudit([RUN, "--audit-db", "", ...auditFlags().slice(0, 2)]);
    expect(emptyPaired.code).toBe(2);
    expect(emptyPaired.stderr).toContain("--audit-db requires a non-empty value");
    expectNoDecoys();
  });

  test("a BOOL flag given a value, or given twice, is named as itself", () => {
    // `--json=true` reached `parseValueFlags`' `=` branch, whose membership
    // test is against the VALUE flags only, and came back `unknown flag:
    // --json` — sending an operator hunting for a typo in a flag that is spelt
    // correctly. And a repeated `--json` was silently accepted while a repeated
    // seam was a usage error: a parser with a rule for half its flags has none.
    const valued = spawnAudit([RUN, "--json=true", ...auditFlags()]);
    expect(valued.code).toBe(2);
    expect(valued.stderr).toContain("--json takes no value");
    expect(valued.stderr).not.toContain("unknown flag");
    expect(valued.stdout).toBe("");

    const twice = spawnAudit([RUN, "--json", "--json", ...auditFlags()]);
    expect(twice.code).toBe(2);
    expect(twice.stderr).toContain("--json given more than once");
    expect(twice.stdout).toBe("");
  });
});

// ─── 4. the seams redirect ───────────────────────────────────────────────────

describe("store-path seams", () => {
  test("--audit-db at a nonexistent path: typed audit-store-absent refusal, nothing created, exit 2", () => {
    // N5. A store the walk cannot OPEN is "I could not look", never "this PR's
    // chain is BROKEN": the walker rethrows the typed refusal as a
    // `ChainWalkError("walk-environment-fault")`, so no report is produced and
    // exit 1 — which by contract means walked-and-incomplete — is not
    // reachable from here. A false BROKEN verdict about a store nobody ever had
    // is the more damaging of the two errors.
    buildCompleteFixture();
    const parent = join(fx.dir, "subdir");
    const absent = join(parent, "not-there.db");
    const r = spawnAudit([RUN, "--json", ...auditFlags().slice(0, 2), "--audit-db", absent, ...auditFlags().slice(4)]);
    expect(r.code).toBe(2);
    // Under a 2, stdout is never a report — a `--json` consumer that finds one
    // there has no rule left to apply.
    expect(r.stdout).toBe("");
    expect(r.stderr).toContain("!! walk-environment-fault");
    // The typed code survives the rethrow, and the path is echoed: the two
    // facts that make a mis-pointed seam actionable.
    expect(r.stderr).toContain("audit-store-absent");
    expect(r.stderr).toContain(absent);
    expect(r.stderr).toContain("next: ");
    // the walk never materialised the store it audits — NOR its parent. The
    // probe never passes O_CREAT, so a `mkdirSync(…, {recursive:true})` creeping
    // into the walk path leaves the FILE absent while the walk has written to
    // the filesystem it is supposed to only read.
    expect(existsSync(absent)).toBe(false);
    expect(existsSync(parent)).toBe(false);
  });

  test("a PARTIAL seam override warns once, naming each default seam and its RESOLVED path", () => {
    buildCompleteFixture();
    const decoys = decoyPaths();
    const r = spawnAudit([RUN, "--runs-dir", fx.runsDir]);
    // The decoy `--audit-db` is absent, so the walk cannot look (N5) — exit 2,
    // not 1. The subject of this test is the WARNING, which fires before the
    // walk either way.
    expect(r.code).toBe(2);
    const warnings = r.stderr.split("\n").filter((l) => l.includes('"operation":"audit-chain.seams"'));
    expect(warnings).toHaveLength(1);
    const warning = warnings[0] as string;
    expect(warning).toContain(`--audit-db → ${decoys.auditDb}`);
    expect(warning).toContain(`--ledger → ${decoys.ledger}`);
    // ABSOLUTE, not the bare `.sandbox/reverify` this used to pin. The warning
    // exists to answer "which directories is this walk joining"; a relative
    // path printed beside two absolute ones does not answer it. The spawn's cwd
    // is the fixture dir, so this is also a strictly stronger assertion.
    expect(warning).toContain(`--reverify-dir → ${join(spawnCwd(), ".sandbox", "reverify")}`);
    expect(warning).not.toContain("--runs-dir →"); // the one that WAS given
    expectNoDecoys();
  });

  test("all four seams given: no seam warning at all", () => {
    buildCompleteFixture();
    const r = spawnAudit([RUN, ...auditFlags()]);
    expect(r.code).toBe(0);
    expect(r.stderr).not.toContain("audit-chain.seams");
  });

  test("seam values are resolved to absolute paths before the walk sees them", () => {
    buildCompleteFixture();
    // `runs` is relative to the CWD the spawn sets (the fixture dir).
    const r = spawnAudit([RUN, "--runs-dir", "runs", "--audit-db", fx.auditDb, "--ledger", fx.ledgerPath, "--reverify-dir", fx.reverifyDir]);
    expect(r.code).toBe(0);
    expect(r.stderr).not.toContain("audit-chain.seams");
    expectNoDecoys();
  });
});

// ─── 5. a walk that faults produces no report — exit 2, never 1 ──────────────

describe("walk faults", () => {
  test("an overridden --runs-dir that is not there is refused BEFORE the walk: exit 2, no stack trace, no report", () => {
    // This used to surface as an anonymous `!! walk-failed` from deep inside
    // the walk (a PR-URL ref reaches `new RunRecordStore({create:false})`
    // before hop 1, so a missing runs dir threw a plain ENOENT). It is now
    // caught by the pre-walk seam check, which echoes the FLAG and the resolved
    // PATH — an explicitly named directory that is not there is a typo.
    //
    // The contract this test owns is unchanged and is what every assertion
    // below is about: exit 2 and NEVER 1, stdout empty, no stack trace, and no
    // default seam touched. Reporting an environment fault as "the audit chain
    // is broken" is a false accusation against the PR under audit.
    const missing = join(fx.dir, "no-such-runs");
    const r = spawnAudit([PR_URL, "--runs-dir", missing, "--audit-db", fx.auditDb, "--ledger", fx.ledgerPath, "--reverify-dir", fx.reverifyDir]);
    expect(r.code).toBe(2);
    expect(r.stdout).toBe("");
    expect(r.stderr).toContain("!! seam-unusable");
    expect(r.stderr).toContain(`--runs-dir ${missing}`);
    expect(r.stderr).toContain("ENOENT");
    expect(r.stderr).toContain("next: fix the path(s) above — an overridden seam that is not there is a typo, not a broken chain");
    expect(r.stderr).not.toContain("\n    at "); // no stack trace
    // Refused before the walk: no verdict line was ever logged, because no walk
    // was ever attempted.
    expect(r.stderr).not.toContain('"operation":"audit-chain.verdict"');
    expectNoDecoys();
  });

  test("an overridden seam of the WRONG KIND is refused with the path echoed", () => {
    // The other half of the pre-walk check, and the one no exit code alone can
    // tell apart from a broken chain: `--ledger <a directory>` opened, found no
    // rows, and reported hop 3 BROKEN about a ledger that was never a ledger.
    const r = spawnAudit([RUN, "--runs-dir", fx.runsDir, "--audit-db", fx.auditDb, "--ledger", fx.dir, "--reverify-dir", fx.reverifyDir]);
    expect(r.code).toBe(2);
    expect(r.stdout).toBe("");
    expect(r.stderr).toContain("!! seam-unusable");
    expect(r.stderr).toContain(`--ledger ${fx.dir}: not a file`);
    expectNoDecoys();
  });

  test("a `~` in a seam value is refused rather than resolved against the CWD", () => {
    // `resolve()` does not expand `~`, so a quoted `--audit-db "~/fx/audit.db"`
    // (or one read from a roster, where no shell expands it) became
    // `$CWD/~/fx/audit.db` — and then a confident verdict about a store nobody
    // ever had.
    const r = spawnAudit([RUN, "--audit-db", "~/fixtures/audit.db", ...auditFlags().slice(0, 2)]);
    expect(r.code).toBe(2);
    expect(r.stdout).toBe("");
    expect(r.stderr).toContain("--audit-db: ~ is not expanded here");
    expect(r.stderr).toContain("~/fixtures/audit.db");
    expectNoDecoys();
  });
});

// ─── 6. run() drives the exit matrix in-process ──────────────────────────────

describe("run() as a library", () => {
  test("returns 0/1/2 and never calls process.exit", async () => {
    // Every assertion AFTER the first is itself the proof: `process.exit`
    // anywhere in this path would tear the test runner down mid-file.
    // `--json` keeps each walk to one line on the runner's own stdout.
    buildCompleteFixture();
    expect(await run([RUN, "--json", ...auditFlags()])).toBe(0);
    // A readable ledger with no rows for this run — the break the walk can SEE.
    // An ABSENT ledger is an environment fault and returns 2 (see below), so it
    // can no longer stand in for the incomplete-chain arm.
    seedEmptyLedger();
    expect(await run([RUN, "--json", ...auditFlags()])).toBe(1);
    rmSync(fx.ledgerPath);
    expect(await run([RUN, "--json", ...auditFlags()])).toBe(2); // N5: could not look
    expect(await run([...auditFlags()])).toBe(2); // no ref
    expect(await run([RUN, "--bogus", ...auditFlags()])).toBe(2);
    expect(await run(["--help"])).toBe(0);
    expect(await run(["-h"])).toBe(0);
  });
});

// ─── 7. describeHop: every arm of the union ──────────────────────────────────

describe("describeHop", () => {
  const cases: { out: HopOutcome; lines: string[] }[] = [
    {
      out: {
        status: "resolved", hop: "run-credential", runId: RUN, subjectId: KEY_HASH,
        evidencePath: "/fx/runs/r.json", evidenceDigest: "d00d", linkId: 7,
        keyHash: KEY_HASH, keyHashPrefix: "sha256:a",
        detail: { totalMicroUsd: 1234, perRole: { lead: 1234 } },
      },
      lines: [
        "status: resolved", `subject: ${KEY_HASH}`, "evidence: /fx/runs/r.json", "digest: d00d", "link: #7",
        `keyHash: ${KEY_HASH}`, "keyHashPrefix: sha256:a",
        "totalMicroUsd: 1234", 'perRole: {"lead":1234}',
      ],
    },
    {
      // the prefix FALLBACK arm: a resolved hop carrying only the hash
      out: { status: "resolved", hop: "run-credential", runId: RUN, subjectId: KEY_HASH, keyHash: KEY_HASH },
      lines: ["status: resolved", `subject: ${KEY_HASH}`, `keyHash: ${KEY_HASH}`, `keyHashPrefix: ${KEY_HASH.slice(0, 8)}`],
    },
    {
      out: { status: "void", hop: "memory-retain-receipt", reason: OQ4_VOID_REASON },
      lines: ["status: void", OQ4_VOID_REASON],
    },
    {
      out: { status: "not-applicable", hop: "run-issue", reason: "bare run carries no issue correlation" },
      lines: ["status: not-applicable", "bare run carries no issue correlation"],
    },
    {
      out: { status: "evidence-not-harvested", hop: "run-bundle", reason: "no bundle at /fx/r.bundle", evidencePath: "/fx/r.bundle" },
      lines: ["status: evidence-not-harvested", "no bundle at /fx/r.bundle", "evidence: /fx/r.bundle"],
    },
    {
      out: { status: "unlinked", hop: "run-box", emitter: "sweep", diagnostic: "no reap link exists" },
      lines: ["status: unlinked", "emitter: sweep", "no reap link exists"],
    },
    {
      // the ordinary digest arm: the two digests are the whole diagnosis
      out: { status: "evidence-mismatch", hop: "run-bundle", expectedDigest: "aaa", actualDigest: "bbb", evidencePath: "/fx/r.bundle" },
      lines: ["status: evidence-mismatch", "expected: aaa", "actual: bbb", "evidence: /fx/r.bundle"],
    },
    {
      // the REWRITTEN-SUBJECT arm (hops 1/7/8): a rewritten subject is
      // invisible in a digest pair alone.
      out: {
        status: "evidence-mismatch", hop: "run-approval", expectedDigest: "aaa", actualDigest: "bbb",
        evidencePath: "/fx/runs/r.json", expectedSubjectId: `alice@${DECIDED_AT}`, actualSubjectId: `mallory@${DECIDED_AT}`,
      },
      lines: [
        "status: evidence-mismatch", "expected: aaa", "actual: bbb", "evidence: /fx/runs/r.json",
        `expectedSubject: alice@${DECIDED_AT}`, `actualSubject: mallory@${DECIDED_AT}`,
      ],
    },
    {
      // CONSTRAINT order: `earlier` is the event required to come FIRST.
      out: { status: "order-violation", hop: "run-approval", constraint: "completedAt < decidedAt", earlier: COMPLETED_AT, later: iso(9) },
      lines: ["status: order-violation", "constraint: completedAt < decidedAt", `earlier: ${COMPLETED_AT}`, `later: ${iso(9)}`],
    },
    {
      // `budget` names WHICH ceiling fired — a per-hop stall and a whole-walk
      // overrun are different operator actions, and without it "ceiling: 30000"
      // vs "ceiling: 3000" is the only distinguishing text.
      out: { status: "hop-timeout", hop: "run-gate-evidence", ceilingMs: 30_000, elapsedMs: 30_412, budget: "total" },
      lines: ["status: hop-timeout", "elapsed: 30412ms", "ceiling: 30000ms", "budget: total"],
    },
    {
      out: { status: "hop-timeout", hop: "run-bundle", ceilingMs: 3_000, elapsedMs: 3_100, budget: "hop" },
      lines: ["status: hop-timeout", "elapsed: 3100ms", "ceiling: 3000ms", "budget: hop"],
    },
    {
      out: { status: "broken", hop: "run-cost", expected: "a readable cost ledger", actual: "ledger-absent", diagnostic: "no ledger at /fx/l.db", evidencePath: "/fx/l.db" },
      lines: ["status: broken", "expected: a readable cost ledger", "actual: ledger-absent", "no ledger at /fx/l.db", "evidence: /fx/l.db"],
    },
    {
      // `evidencePath` is optional on `broken` — its absence drops the line
      // rather than rendering `evidence: undefined`.
      out: { status: "broken", hop: "run-cost", expected: "a readable cost ledger", actual: "ledger-absent", diagnostic: "no ledger" },
      lines: ["status: broken", "expected: a readable cost ledger", "actual: ledger-absent", "no ledger"],
    },
  ];

  /**
   * The union's statuses, enumerated ONCE and checked by the compiler.
   *
   * `expect(new Set(…).size).toBe(9)` could not detect the thing it claimed to:
   * it is a property of the `cases` array alone, so a TENTH status added to
   * `HopOutcome` left the set at 9 and the test green — the exact scenario the
   * comment said would show up here. The only guard that saw it was the
   * `const unreachable: never` in `describeHop`, which `bun test` strips.
   *
   * A `Record` keyed by the union makes the enumeration itself exhaustive:
   * adding a status to `HopOutcome` fails `bunx tsc --noEmit` on a missing key
   * here, and the assertion below then fails until a rendering case exists for
   * it. Equality both ways, not a count: a case carrying a status the union
   * does not have fails too.
   */
  const ALL_STATUSES: Record<HopOutcome["status"], true> = {
    resolved: true,
    void: true,
    "not-applicable": true,
    "evidence-not-harvested": true,
    unlinked: true,
    "evidence-mismatch": true,
    "order-violation": true,
    "hop-timeout": true,
    broken: true,
  };

  test("every HopOutcome status is covered by a case", () => {
    const declared = Object.keys(ALL_STATUSES) as HopOutcome["status"][];
    expect(new Set(cases.map((c) => c.out.status))).toEqual(new Set(declared));
  });

  for (const { out, lines } of cases) {
    const label = out.status === "evidence-mismatch" && out.expectedSubjectId !== undefined
      ? "evidence-mismatch (rewritten subject)"
      : out.status === "hop-timeout"
        ? `hop-timeout (budget: ${out.budget})`
        : out.status;
    test(`renders ${label} with every field the variant carries`, () => {
      // toEqual on the whole array, not toContain: a DROPPED line fails too.
      expect(describeHop(out)).toEqual(lines);
    });
  }
});

// ─── 8. redaction (INV-AUDIT-2) ──────────────────────────────────────────────

describe("INV-AUDIT-2 redaction", () => {
  test("no planted link/record secret, no env secret, in stdout or stderr", () => {
    buildCompleteFixture();
    for (const json of [false, true]) {
      const r = spawnAudit([RUN, ...(json ? ["--json"] : []), ...auditFlags()]);
      expect(r.code).toBe(0);
      // The secrets the walk actually READ: one inside a hop-4 link row's
      // `detail`, one inside the run-record's approval entry.
      expect(r.stdout).not.toContain(PLANTED_LINK_SECRET);
      expect(r.stderr).not.toContain(PLANTED_LINK_SECRET);
      expect(r.stdout).not.toContain(PLANTED_RECORD_SECRET);
      expect(r.stderr).not.toContain(PLANTED_RECORD_SECRET);
      const everything = r.stdout + r.stderr;
      expect(everything).not.toContain("ghp_");
      expect(everything).not.toContain("sk-or-v1-");
      // cheap extra: the env values, which this zero-network walk never reads
      expect(everything).not.toContain(GH_TOKEN);
      expect(everything).not.toContain(PROVISIONING_KEY);
      // only the hash and its 8-char prefix ever appear
      expect(everything).toContain(KEY_HASH);
    }
  });
});

describe("run() is exported for a harness — so its log-sink swap must be re-entrant", () => {
  test("overlapping run() calls leave the CALLER's sink installed, not one of their own", async () => {
    // `setLogSink` is a module GLOBAL with a save/restore discipline. Two
    // overlapping `run()` calls used to interleave as
    //   save(caller) · save(A) · restore(caller) · restore(A)
    // — the first finisher restores the sink the SECOND one displaced, so when
    // both had returned the installed sink was A's stderr writer and the
    // caller's was gone for good. `run` is exported precisely so a harness can
    // drive the exit matrix, and a harness driving it twice at once is the
    // intended use, so the window was reachable from the public API.
    //
    // `--help` is the shortest path through `walkAndRender`: it reads no store,
    // no record and no ledger, and returns 0 — the interleaving is a property of
    // `run`'s own prologue, not of any walk.
    const caller: LogEntry[] = [];
    const restore = setLogSink((entry) => caller.push(entry));
    try {
      const codes = await Promise.all([run(["--help"]), run(["--help"])]);
      expect(codes).toEqual([0, 0]);

      // The observable: a line logged AFTER both returned must reach the sink
      // this test installed.
      log({
        requestId: "sink-probe",
        operation: "test.sink-probe",
        agentId: null,
        timestamp: new Date().toISOString(),
        duration: 0,
        status: "ok",
        message: "the caller's sink is still the installed one",
      });
      expect(caller.map((l) => l.operation)).toEqual(["test.sink-probe"]);
    } finally {
      restore();
    }
  });
});

describe("brokenDetail — a BROKEN verdict with no broken hops has TWO causes", () => {
  // `chainVerdict` is `brokenHops.length === 0 && anyResolved`, so a report can
  // be BROKEN with an empty `brokenHops` either because nothing was walked or
  // because nothing RESOLVED. Both printed "no runs walked", which is a lie in
  // the second case — the per-run block sits directly above the summary line
  // showing the run and its hops.
  const reportOf = (runs: ChainReport["runs"]): ChainReport =>
    ({
      ref: "qds/r", refKind: "branch", generatedAt: "2026-09-17T00:00:00.000Z",
      complete: false, timings: { prFetchMs: 0, perHopMs: {} }, runs,
    }) as unknown as ChainReport;

  test("an EMPTY runs map is 'no runs walked'", () => {
    const report = reportOf({});
    expect(brokenDetail(report, chainVerdict(report))).toBe("no runs walked");
  });

  test("a run present with NO resolved hop is 'no hop resolved', not 'no runs walked'", () => {
    // `void` neither resolves nor breaks the chain — the shape `chainVerdict`
    // turns into BROKEN-with-no-broken-hops.
    const report = reportOf({
      "r-1": {
        runId: "r-1", complete: false,
        hops: { "memory-retain-receipt": { status: "void", hop: "memory-retain-receipt", reason: "OQ-4 unresolved" } },
      },
    } as unknown as ChainReport["runs"]);
    const verdict = chainVerdict(report);
    // The premise: this really is the no-broken-hops branch.
    expect(verdict).toMatchObject({ complete: false, brokenHops: [] });
    expect(brokenDetail(report, verdict)).toBe("no hop resolved");
  });

  test("broken hops win over both, deduped by hop NAME across runs", () => {
    const broken = (hop: string) => ({ status: "broken", hop, expected: "x", actual: "y", diagnostic: "d", evidencePath: "p" });
    const report = reportOf({
      // The SAME hop broken in two runs is one hop NAME, not two.
      "r-1": { runId: "r-1", complete: false, hops: { "run-cost": broken("run-cost") } },
      "r-2": { runId: "r-2", complete: false, hops: { "run-cost": broken("run-cost"), "run-box": broken("run-box") } },
    } as unknown as ChainReport["runs"]);
    expect(brokenDetail(report, chainVerdict(report))).toBe("2 broken hop(s): run-cost, run-box");
  });
});
