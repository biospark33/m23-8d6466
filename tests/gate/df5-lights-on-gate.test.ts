/**
 * DF5.4 lights-on-gate — driver integration suite (story DF5.4, leaf-1.2.1).
 *
 * Drives the REAL driver as a subprocess against the frozen run of record
 * copied into a mkdtemp scratch (the fixture itself is never modified):
 * the three e2e demo arms (green / reverify deleted / reverify red),
 * determinism, non-vacuity, preflight fail-fast, the INV-GATE-1 file-set
 * snapshot (baseline + absent-audit.db + the identity window), the C9 tamper
 * two-walk (one shared scratch), INV-GATE-2 redaction, fixture hygiene, and
 * the exit-2 fatal path in both phases (run-id shape + length faults under the
 * usage prefix, the post-flag fatal under the error prefix, and the blocking
 * rows' code/message/remediation log lines).
 *
 * Deviation (recorded per the story's deviation clause): the probe→bind swap
 * inside the walker runs in a microsecond window that cannot be interposed
 * deterministically from outside the process; the identity window is asserted
 * at the opener the gate invokes (probeAndBind, DF5.3's exported test hook)
 * against THIS gate's fixture store, and its gate-level red consequence is
 * covered by the absent-store, tamper and depth arms plus the swapped-store
 * run below.
 */
import { Database } from "bun:sqlite";
import { afterAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { GateReportSchema, runGate, type GateReport } from "../../src/gate/gate-runner.ts";
import { OQ4_VOID_REASON } from "../../src/audit/index.ts";
import { __auditStoreTestHooks } from "../../src/audit/link-store.ts";
import { CostLedger } from "../../src/providers/cost-ledger.ts";

const RUN_ID = "qds-20260918-cc93a3";
const FIXTURE = path.join(import.meta.dir, "fixtures", "df5-run-of-record");
const DRIVER = path.resolve(import.meta.dir, "../..", "scripts", "df5-lights-on-gate.ts");

interface Scratch {
  root: string;
  report: string;
}

const scratches: Scratch[] = [];

/** Every driver this suite spawned — the afterAll kill sweep runs over it so a
 *  hung child cannot outlive the test timeout and litter /tmp. */
const children: Array<Bun.Subprocess<"ignore", "pipe", "pipe">> = [];

/** Fixture copy laid out the way the driver's seams expect: reverify jsonl
 *  renamed out of its `.reverify.` infix into <root>/reverify/<runId>.jsonl. */
function makeScratch(): Scratch {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "df54-driver-"));
  fs.cpSync(FIXTURE, root, { recursive: true });
  fs.mkdirSync(path.join(root, "reverify"), { recursive: true });
  fs.renameSync(path.join(root, `${RUN_ID}.reverify.jsonl`), path.join(root, "reverify", `${RUN_ID}.jsonl`));
  const s = { root, report: path.join(root, "gate-report.json") };
  scratches.push(s);
  return s;
}

function gateArgs(s: Scratch, runId: string = RUN_ID, report: string = s.report): string[] {
  return [
    process.execPath,
    DRIVER,
    "--run-id",
    runId,
    "--report",
    report,
    "--runs-dir",
    s.root,
    "--git-dir",
    path.join(s.root, "refs.git"),
    "--audit-db",
    path.join(s.root, "audit.db"),
    "--ledger",
    path.join(s.root, "cost-ledger.db"),
    "--reverify-dir",
    path.join(s.root, "reverify"),
    "--pr-body",
    path.join(s.root, "pr-body.txt"),
  ];
}

interface RunResult {
  exit: number;
  stdout: string;
  stderr: string;
}

async function runGateCli(argv: string[]): Promise<RunResult> { // dp:ok - a rejection here IS the test failure (bun:test surfaces it red)
  const proc = Bun.spawn(argv, { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  children.push(proc);
  const [exit, stdout, stderr] = await Promise.all([proc.exited, new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  return { exit, stdout, stderr };
}

function readReport(s: Scratch): { wrapper: Record<string, unknown>; report: GateReport } {
  const wrapper = JSON.parse(fs.readFileSync(s.report, "utf8")) as Record<string, unknown>; // dp:ok - parses the report the driver just wrote; a throw is the red test
  return { wrapper, report: GateReportSchema.parse(wrapper.report) };
}

function row(report: GateReport, id: string) {
  return report.assertions.find((r) => r.id === id);
}

/** Recursive sorted relative-path listing under root — the INV-GATE-1 snapshot
 *  walks the WHOLE scratch tree, never a cherry-picked subpath. */
function treeSnapshot(root: string, skip: (rel: string) => boolean = () => false): string[] {
  const out: string[] = [];
  const walk = (dir: string, rel: string): void => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const r = rel === "" ? e.name : `${rel}/${e.name}`;
      if (e.isDirectory()) walk(path.join(dir, e.name), r);
      else if (!skip(r)) out.push(r);
    }
  };
  walk(root, "");
  return out;
}

function statuses(report: GateReport): Record<string, string> {
  return Object.fromEntries(report.assertions.map((r) => [r.id, r.status]));
}

afterAll(() => {
  // Kill stragglers BEFORE the scratch rmSync: a hung driver (bun:test
  // timeouts do not kill the child) survives cleanup and its mkdirSync
  // recreates the deleted dir, littering /tmp. Residual window: a child the
  // sweep's own awaits admit during afterAll escapes this sweep.
  for (const child of children) {
    try {
      child.kill();
    } catch {
      // already exited — nothing to kill
    }
  }
  for (const s of scratches) fs.rmSync(s.root, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// e2e demo — the three arms (story DoD, MANDATORY)
// ---------------------------------------------------------------------------

describe("e2e demo — three arms against the frozen run of record", () => {
  test("GREEN: eleven pass + V1 void, DF_GATE: PASS, exit 0, schema-valid versioned report", async () => {
    const s = makeScratch();
    const r = await runGateCli(gateArgs(s));
    expect(r.stdout.trimEnd().endsWith("DF_GATE: PASS")).toBe(true);
    expect(r.exit).toBe(0);
    const { wrapper, report } = readReport(s);
    expect(wrapper.gate).toBe("df5-lights-on");
    expect(wrapper.gate_version).toBe("1.0.0");
    expect(wrapper.clause_map_version).toBe("1.0.0");
    expect(typeof wrapper.request_id).toBe("string");
    expect(report.overall).toBe("PASS");
    expect(report.summary).toEqual({ pass: 11, fail: 0, skip: 0, void: 1 });
    expect(row(report, "DF5.4-V1")?.status).toBe("void");
    expect(row(report, "DF5.4-V1")?.detail).toBe(`VOID — ${OQ4_VOID_REASON}`);
    for (const id of ["DF5.4-P1", "DF5.4-C1", "DF5.4-C2", "DF5.4-C3", "DF5.4-C4", "DF5.4-C5", "DF5.4-C6", "DF5.4-C7", "DF5.4-C8", "DF5.4-C9", "DF5.4-C10"]) {
      expect(row(report, id)?.status).toBe("pass");
    }
    expect(r.stderr).toContain('"assertionId":"DF5.4-C9"');
    expect(r.stderr).toContain("report_write_ms");
  }, 120_000);

  test("DELETED reverify record: C6 skip naming the path, C7 skip, C9 fail, FAIL, exit 1 (three clauses strand, not one)", async () => {
    const s = makeScratch();
    const rvFile = path.join(s.root, "reverify", `${RUN_ID}.jsonl`);
    fs.rmSync(rvFile);
    const r = await runGateCli(gateArgs(s));
    expect(r.stdout.trimEnd().endsWith("DF_GATE: FAIL")).toBe(true);
    expect(r.exit).toBe(1);
    const { report } = readReport(s);
    const st = statuses(report);
    expect(st["DF5.4-C6"]).toBe("skip");
    expect(row(report, "DF5.4-C6")?.detail).toContain(rvFile);
    expect(st["DF5.4-C7"]).toBe("skip");
    expect(st["DF5.4-C9"]).toBe("fail");
    expect(report.overall).toBe("FAIL");
    // An implementation collapsing skip and fail into one status fails here.
    expect(new Set([st["DF5.4-C6"], st["DF5.4-C9"]]).size).toBe(2);
    // G2 re-pin: the structured per-assertion lines reach stderr (with a
    // remediation hint on the failing/skipping rows) while stdout stays the
    // human render table — a PASS tag only ever appears as a table row, never
    // as a verdict claim, and the terminal marker stays FAIL.
    expect(r.stderr).toContain('"assertionId":"DF5.4-C9"');
    expect(r.stderr).toContain('"status":"fail"');
    expect(r.stderr).toContain("remediation");
    for (const l of r.stdout.split("\n")) {
      if (!l.includes("PASS")) continue;
      expect(l.trimStart().startsWith("[PASS] ")).toBe(true);
    }
    expect(r.stdout.trimEnd().endsWith("DF_GATE: FAIL")).toBe(true);
  }, 120_000);

  test("RED reverify record: C6 fail naming the verdict, FAIL, exit 1", async () => {
    const s = makeScratch();
    const rvFile = path.join(s.root, "reverify", `${RUN_ID}.jsonl`);
    const lines = fs.readFileSync(rvFile, "utf8").trimEnd().split("\n");
    const mutated = lines.map((l) => {
      const rep = JSON.parse(l) as Record<string, unknown>; // dp:ok - parses a line this test wrote; a throw is the red test
      if (typeof rep.reverifyId === "string" && rep.reverifyId.includes("02-49-30")) rep.verdict = "red";
      return JSON.stringify(rep);
    });
    fs.writeFileSync(rvFile, `${mutated.join("\n")}\n`);
    const r = await runGateCli(gateArgs(s));
    expect(r.stdout.trimEnd().endsWith("DF_GATE: FAIL")).toBe(true);
    expect(r.exit).toBe(1);
    const { report } = readReport(s);
    expect(row(report, "DF5.4-C6")?.status).toBe("fail");
    expect(row(report, "DF5.4-C6")?.detail).toContain("red");
  }, 120_000);
});

// ---------------------------------------------------------------------------
// determinism + non-vacuity + preflight fail-fast
// ---------------------------------------------------------------------------

describe("determinism, non-vacuity, preflight fail-fast", () => {
  test("two consecutive runs against unchanged state: identical per-clause statuses and overall", async () => {
    const s = makeScratch();
    const first = await runGateCli(gateArgs(s));
    expect(first.exit).toBe(0);
    const a = statuses(readReport(s).report);
    const second = await runGateCli(gateArgs(s));
    expect(second.exit).toBe(0);
    const b = statuses(readReport(s).report);
    expect(b).toEqual(a);
    // The wrapper carries a fresh request_id per run — determinism is over
    // statuses + overall (AC3), never over correlation fields.
    expect(readReport(s).wrapper.request_id).toBeTruthy();
  }, 240_000);

  test("non-vacuity: an all-void clause set and an empty clause set both FAIL", async () => {
    const voided: import("../../src/gate/gate-runner.ts").GateAssertion[] = [
      { id: "X1", story: "S", prd_clause: "p", description: "d", group: "main", void_reason: "outside horizon", check: async () => ({ pass: true }) },
      { id: "X2", story: "S", prd_clause: "p", description: "d", group: "main", void_reason: "outside horizon", check: async () => ({ pass: true }) },
    ];
    expect((await runGate(voided, { assertionTimeoutMs: 1_000, totalTimeoutMs: 2_000 })).overall).toBe("FAIL");
    expect((await runGate([], { assertionTimeoutMs: 1_000, totalTimeoutMs: 2_000 })).overall).toBe("FAIL");
  });

  test("preflight not green: main clauses listed as skip with the chassis fail-fast text", async () => {
    const s = makeScratch();
    fs.rmSync(path.join(s.root, `${RUN_ID}.json`));
    const r = await runGateCli(gateArgs(s));
    expect(r.exit).toBe(1);
    const { report } = readReport(s);
    expect(row(report, "DF5.4-P1")?.status).toBe("skip");
    for (const id of ["DF5.4-C1", "DF5.4-C2", "DF5.4-C3", "DF5.4-C4", "DF5.4-C5", "DF5.4-C6", "DF5.4-C7", "DF5.4-C8", "DF5.4-C9", "DF5.4-C10"]) {
      const main = row(report, id);
      expect(main?.status).toBe("skip");
      expect(main?.detail).toBe("not attempted — preflight assertion(s) did not pass (fail-fast)");
    }
    expect(report.overall).toBe("FAIL");
    // A7 re-pin: blocking log lines carry code + message alongside remediation.
    // A skip's detail holds no typed code, so the honest default applies.
    expect(r.stderr).toContain('"code":"evidence-unreadable"');
    expect(r.stderr).toContain('"message":"not attempted — preflight assertion(s) did not pass (fail-fast)"');
    expect(r.stderr).toContain('"remediation":');
  }, 120_000);
});

// ---------------------------------------------------------------------------
// INV-GATE-1 — file-set snapshot: exact, no sidecar exception list
// ---------------------------------------------------------------------------

describe("INV-GATE-1 — the gate writes nothing but the report", () => {
  test("baseline: full scratch tree differs by the report path and nothing else", async () => {
    const s = makeScratch();
    const before = treeSnapshot(s.root);
    const r = await runGateCli(gateArgs(s));
    expect(r.exit).toBe(0);
    const after = treeSnapshot(s.root);
    const added = after.filter((f) => !before.includes(f));
    const removed = before.filter((f) => !after.includes(f));
    expect(added).toEqual(["gate-report.json"]);
    expect(removed).toEqual([]);
    // audit.db may gain first-observation digest ROWS (the sanctioned write)
    // but never a -wal/-shm sidecar: DELETE journal, asserted by name.
    expect(after.filter((f) => f.endsWith("-wal") || f.endsWith("-shm"))).toEqual([]);
  }, 120_000);

  test("absent audit.db: ends still absent, gate red on C9 naming audit-store-absent", async () => {
    const s = makeScratch();
    fs.rmSync(path.join(s.root, "audit.db"));
    const r = await runGateCli(gateArgs(s));
    expect(r.exit).toBe(1);
    expect(fs.existsSync(path.join(s.root, "audit.db"))).toBe(false);
    const c9 = row(readReport(s).report, "DF5.4-C9");
    expect(c9?.status).toBe("fail");
    expect(c9?.detail).toContain("audit-store-absent");
    // A7 re-pin: the typed code is extracted from the detail, not defaulted.
    expect(r.stderr).toContain('"code":"audit-store-absent"');
  }, 120_000);

  test("audit_links rows only increase and no existing row changes", async () => {
    const s = makeScratch();
    const linkRows = (): Array<Record<string, unknown>> =>
      new Database(path.join(s.root, "audit.db"), { readonly: true })
        .query("SELECT link_id, run_id, hop, event, evidence_digest FROM audit_links ORDER BY link_id")
        .all() as Array<Record<string, unknown>>;
    const before = linkRows();
    expect(before.length).toBeGreaterThan(0);
    const r = await runGateCli(gateArgs(s));
    expect(r.exit).toBe(0);
    const after = linkRows();
    expect(after.length).toBeGreaterThanOrEqual(before.length);
    // Every pre-existing row survives byte-for-byte on its keyed columns.
    for (const b of before) {
      const match = after.find((a) => a.link_id === b.link_id);
      expect(match).toEqual(b);
    }
  }, 120_000);

  test("identity window: probeAndBind refuses a replaced store, writes nothing, replacement byte-identical", () => {
    const s = makeScratch();
    const store = path.join(s.root, "audit.db");
    // Hold the probe (the walker's no-create open), REPLACE the inode across
    // the window (rename, never truncate-rewrite — that keeps the inode), then
    // bind: the opener must refuse BEFORE any write lands in the replacement.
    const probe = __auditStoreTestHooks.probeAuditStore(store);
    try {
      const alt = path.join(s.root, "replacement.db");
      fs.copyFileSync(store, alt);
      const replacementBytes = fs.readFileSync(alt);
      fs.renameSync(alt, store);
      let refusal: unknown;
      try {
        __auditStoreTestHooks.probeAndBind(store, probe);
        throw new Error("bind unexpectedly succeeded across the identity window");
      } catch (e) {
        refusal = e;
      }
      expect((refusal as { code?: string }).code).toBe("audit-store-identity-changed");
      expect(fs.readFileSync(store).equals(replacementBytes)).toBe(true);
    } finally {
      probe.close(); // the probe must close even when an expect above throws
    }
  });

  test("swapped store consequence: full gate red on C9 (no emitted links for the run)", async () => {
    const s = makeScratch();
    // A schema-valid store with this run's lifecycle rows gone: the walk runs,
    // finds no emitted rows on hops 4/5/6, and C9 goes red naming them.
    const store = path.join(s.root, "audit.db");
    const db = new Database(store);
    for (const t of db.query("SELECT name FROM sqlite_master WHERE type='trigger'").all() as { name: string }[]) {
      db.run(`DROP TRIGGER "${t.name}"`);
    }
    db.run("DELETE FROM audit_links WHERE run_id = ?", [RUN_ID]);
    db.close();
    const r = await runGateCli(gateArgs(s));
    expect(r.exit).toBe(1);
    const c9 = row(readReport(s).report, "DF5.4-C9");
    expect(c9?.status).toBe("fail");
    expect(c9?.detail).toContain("run-credential");
  }, 120_000);
});

// ---------------------------------------------------------------------------
// C9 tamper — two walks, ONE shared scratch (digest asymmetry)
// ---------------------------------------------------------------------------

describe("C9 tamper — evidence-mismatch is a second-walk guarantee", () => {
  test("first walk green; bound report edited in place; second walk fails on evidence-mismatch", async () => {
    const s = makeScratch();
    const first = await runGateCli(gateArgs(s));
    expect(first.exit).toBe(0);
    const rvFile = path.join(s.root, "reverify", `${RUN_ID}.jsonl`);
    const lines = fs.readFileSync(rvFile, "utf8").trimEnd().split("\n");
    const mutated = lines.map((l) => {
      const rep = JSON.parse(l) as Record<string, unknown>; // dp:ok - parses a line this test wrote; a throw is the red test
      if (typeof rep.reverifyId === "string" && rep.reverifyId.includes("02-49-30")) rep.verdict = "red";
      return JSON.stringify(rep);
    });
    fs.writeFileSync(rvFile, `${mutated.join("\n")}\n`);
    // A fresh scratch per walk would hand the second walk a cold, tamper-free
    // digest baseline — the same scratch is the test.
    const second = await runGateCli(gateArgs(s));
    expect(second.exit).toBe(1);
    const c9 = row(readReport(s).report, "DF5.4-C9");
    expect(c9?.status).toBe("fail");
    expect(c9?.detail).toContain("evidence-mismatch");
    // And C6 names the tamper independently of the walker.
    expect(row(readReport(s).report, "DF5.4-C6")?.status).toBe("fail");
  }, 240_000);
});

// ---------------------------------------------------------------------------
// INV-GATE-2 — no secrets in any detail or report field
// ---------------------------------------------------------------------------

describe("INV-GATE-2 — redaction", () => {
  test("no token/key/PII shape reaches any assertion detail, report field, or streamed stdout/stderr (green + red)", async () => {
    const patterns = [/ghp_[A-Za-z0-9]{10,}/, /github_pat_[A-Za-z0-9]{10,}/, /sk-[A-Za-z0-9]{10,}/, /xoxb-[A-Za-z0-9-]{10,}/, /AKIA[A-Z0-9]{12,}/];
    const green = makeScratch();
    const greenRun = await runGateCli(gateArgs(green));
    expect(greenRun.exit).toBe(0);
    const red = makeScratch();
    fs.rmSync(path.join(red.root, "reverify", `${RUN_ID}.jsonl`));
    const redRun = await runGateCli(gateArgs(red));
    expect(redRun.exit).toBe(1);
    // Three surfaces, not one: the report file AND the streamed stdout/stderr
    // of both arms (the structured log lines carry per-assertion details).
    for (const [name, s, r] of [["green", green, greenRun], ["red", red, redRun]] as Array<[string, Scratch, RunResult]>) {
      const surfaces: Array<[string, string]> = [
        ["report", fs.readFileSync(s.report, "utf8")],
        ["stdout", r.stdout],
        ["stderr", r.stderr],
      ];
      for (const [surface, blob] of surfaces) {
        for (const p of patterns) expect(blob.match(p), `pattern ${p} leaked on ${name} ${surface}`).toBeNull();
      }
    }
  }, 240_000);
});

// ---------------------------------------------------------------------------
// fixture hygiene + fatal path
// ---------------------------------------------------------------------------

describe("fixture hygiene and the exit-2 fatal path", () => {
  // Root lanes must skip the whole arm: the refs.git probe rev-parses the
  // CHECKED-IN fixture (owned by the checkout user, not euid), and git's
  // dubious-ownership refusal reds the probe there. Same guard as the mode-000
  // arms in df5-assertions.test.ts (b5f71bd7) — the other four checks ride the
  // same skip, so root lanes run this suite as non-root or they ship uncovered.
  test.skipIf(process.getuid?.() === 0)(
    "frozen fixture: no hot ledger WAL, openReadOnly succeeds, refs.git resolves, pr-body frozen",
    () => {
    const wal = path.join(FIXTURE, "cost-ledger.db-wal");
    expect(fs.existsSync(wal) && fs.statSync(wal).size > 0).toBe(false);
    // DoD names the seam, not a raw open: C10's actual read path is
    // `CostLedger.openReadOnly()` — a plain readonly sqlite open succeeds on
    // fixtures DF2.11's read path refuses (e.g. WAL-mode-without-shm), so the
    // literal assertion goes through it and reads the run's spend.
    const ledger = CostLedger.openReadOnly({ path: path.join(FIXTURE, "cost-ledger.db") });
    const spend = ledger.readRunCost(RUN_ID);
    expect(spend.hasEvents).toBe(true);
    expect(spend.totalMicroUsd).toBeGreaterThan(0);
    ledger.close();
    const rev = Bun.spawnSync(["git", "--git-dir", path.join(FIXTURE, "refs.git"), "rev-parse", "--verify", `refs/sandbox/${RUN_ID}`]);
    expect(rev.exitCode).toBe(0);
    expect(fs.statSync(path.join(FIXTURE, "pr-body.txt")).size).toBeGreaterThan(0);
    expect(fs.existsSync(path.join(FIXTURE, `${RUN_ID}.reverify.jsonl`))).toBe(true);
    },
  );

  test("usage fault (missing --run-id): exit 2, no report file claims a verdict", async () => {
    const s = makeScratch();
    const r = await runGateCli([process.execPath, DRIVER, "--report", s.report]);
    expect(r.exit).toBe(2);
    expect(fs.existsSync(s.report)).toBe(false);
  }, 60_000);

  test("usage fault (run-id path traversal `..`): exit 2, stderr names the run-id rule, no report", async () => {
    const s = makeScratch();
    const r = await runGateCli([process.execPath, DRIVER, "--run-id", "..", "--report", s.report]);
    expect(r.exit).toBe(2);
    expect(r.stderr).toContain("--run-id must match");
    expect(fs.existsSync(s.report)).toBe(false);
  }, 60_000);

  test("usage fault (run-id shape rules): exit 2 naming the rejected shape, usage prefix, no report", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "df54-shape-"));
    try {
      const report = path.join(tmp, "r.json");
      for (const [runId, why] of [
        ["a..b", "a '..' substring"],
        ["-lead", "a leading '-'"],
        [".hidden", "a leading '.'"],
        ["t.lock", "a trailing '.lock'"],
      ] as Array<[string, string]>) {
        // Shape faults die at flag validation, before any evidence is read —
        // no fixture needed, only a report path that must stay empty.
        const r = await runGateCli([process.execPath, DRIVER, "--run-id", runId, "--report", report]);
        expect(r.exit, runId).toBe(2);
        expect(r.stderr, runId).toContain("df5-lights-on-gate: usage");
        expect(r.stderr, runId).toContain("--run-id must match");
        expect(r.stderr, runId).toContain(why);
        expect(fs.existsSync(report), runId).toBe(false);
      }
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }, 60_000);

  test("usage fault (run-id length 129): exit 2 naming the cap, no report; 128 chars validates and runs", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "df54-len-"));
    try {
      const report = path.join(tmp, "r.json");
      const r = await runGateCli([process.execPath, DRIVER, "--run-id", "r".repeat(129), "--report", report]);
      expect(r.exit).toBe(2);
      expect(r.stderr).toContain("--run-id must be at most 128 characters (got 129)");
      expect(fs.existsSync(report)).toBe(false);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
    // The boundary itself: at 128 chars validation passes and the gate RUNS —
    // P1 skips on the nonexistent record (exit 1), so the cap is exactly 128.
    const s = makeScratch();
    const r = await runGateCli(gateArgs(s, "r".repeat(128)));
    expect(r.exit).toBe(1);
    expect(r.stderr).not.toContain("must be at most");
  }, 120_000);

  test("post-flag fatal (--report under a regular file): exit 2, error prefix (not usage), honest remediation, no report", async () => {
    const s = makeScratch();
    const blocked = path.join(s.root, "file.json");
    fs.writeFileSync(blocked, "{}\n"); // regular file — the report's mkdir fails ENOTDIR only AFTER the gate ran
    const badReport = path.join(blocked, "r.json");
    const r = await runGateCli(gateArgs(s, RUN_ID, badReport));
    expect(r.exit).toBe(2);
    expect(r.stderr).toContain("df5-lights-on-gate: error");
    expect(r.stderr).not.toContain("df5-lights-on-gate: usage");
    expect(r.stderr).not.toContain("try --help");
    expect(r.stderr).toContain("no verdict was claimed and no report was left at the --report path");
    expect(fs.existsSync(badReport)).toBe(false);
  }, 120_000);

  test("unknown flag: exit 2 with the usage prefix", async () => {
    const r = await runGateCli([process.execPath, DRIVER, "--run-id", RUN_ID, "--bogus", "x"]);
    expect(r.exit).toBe(2);
    expect(r.stderr).toContain("usage");
  }, 60_000);
});
