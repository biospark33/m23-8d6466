/**
 * Gate library tests (Story DF1.2).
 *
 * A gate's report is evidence: one check per item examined, populated notes on
 * passes as well as failures, violations and passed derived — never authored.
 * A report that examined nothing is not green (INV-5).
 */
import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  FileJournal,
  GateReport,
  type GateCheck,
  type GateContext,
  type Envelope,
  type PhaseBodyContext,
  Run,
  artifactsExist,
  asEnvelope,
  commandGate,
  diffMatchesClaims,
  filesNonEmpty,
  gatedBody,
  jsonParses,
  verdictConsistent,
} from "../../src/phase-engine/index.ts";
import { readJournal } from "./journal-test-util.ts";

const reviewCases = JSON.parse(
  fs.readFileSync(new URL("./fixtures/review-envelopes.json", import.meta.url), "utf8"),
) as Record<string, Envelope>;

const tmpRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "df1-2-gates-")));
afterAll(() => fs.rmSync(tmpRoot, { recursive: true, force: true }));
let markerRoot = "";

beforeEach(() => {
  markerRoot = fs.realpathSync(fs.mkdtempSync(path.join(tmpRoot, "marker-")));
  process.env.QDS_RUN_ROOT = markerRoot;
});

afterEach(() => {
  // biome-ignore lint/performance/noDelete: delete is the only correct way to restore "not set"
  delete process.env.QDS_RUN_ROOT;
});

describe("GateReport derivation (AC1, INV-4, INV-5)", () => {
  test("check() appends one GateCheck per item and returns itself", () => {
    const report = new GateReport();
    const returned = report.check("a.txt", true, "exists, 1B");
    expect(returned).toBe(report);
    report.check("b.txt", false, "declared artifact does not exist");
    expect(report.checks).toHaveLength(2);
    expect(report.checks[0]!).toEqual({ item: "a.txt", ok: true, note: "exists, 1B" });
    expect(report.checks[1]!.ok).toBe(false);
  });

  test("violations are 'item: note' and empty notes degrade to 'item: failed'", () => {
    const report = new GateReport();
    report.check("gone.txt", false, "declared artifact does not exist").check("bad.json", false, "");
    expect(report.violations).toEqual([
      "gone.txt: declared artifact does not exist",
      "bad.json: failed",
    ]);
  });

  test("empty report negative control: examined nothing is passed: false (INV-5)", () => {
    const report = new GateReport();
    expect(report.checks).toHaveLength(0);
    expect(report.violations).toEqual([]);
    // `violations.length === 0` alone would call this green — it must not be.
    expect(report.passed).toBe(false);
  });

  test("all-pass report with checks is green", () => {
    const report = new GateReport().check("a", true, "exit 0");
    expect(report.passed).toBe(true);
    expect(report.violations).toEqual([]);
  });

  test("recorded checks are immutable: flipping one after the fact throws (INV-4)", () => {
    const report = new GateReport().check("gone.txt", false, "declared artifact does not exist");
    // Frozen at check(): editing a recorded check would manufacture a pass
    // with no new evidence. ESM is strict mode, so the assignment throws.
    expect(() => {
      (report.checks[0] as GateCheck).ok = true;
    }).toThrow();
    // The getter hands out a copy: appending cannot grow the report either.
    const exposed = report.checks as GateCheck[];
    exposed.push({ item: "forged", ok: true, note: "self-certified" });
    expect(report.checks).toHaveLength(1);
    expect(report.passed).toBe(false);
  });
});

describe("artifact gates over a pinned run root (INV-3)", () => {
  const runRoot = path.join(tmpRoot, "artifacts");
  const gateCtx: GateContext = { runRoot };

  function write(rel: string, content: string): void {
    const p = path.join(runRoot, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content);
  }

  beforeEach(() => {
    fs.rmSync(runRoot, { recursive: true, force: true });
    fs.mkdirSync(runRoot, { recursive: true });
  });

  test("artifactsExist multi-item evidence (AC1): 4 declared, 1 missing", async () => {
    write("report.json", '{"ok":true}');
    write("coverage.txt", "82%\n");
    write("schema.sql", "CREATE TABLE t;");
    // fourth declared artifact intentionally absent
    const envelope: Envelope = {
      kind: "verify",
      label: "build",
      status: "success",
      summary: "built",
      artifacts: ["report.json", "coverage.txt", "schema.sql", "missing-output.bin"],
    };
    const report = await artifactsExist.run(envelope, gateCtx);
    expect(report.checks).toHaveLength(4);
    for (const check of report.checks) {
      // Passes carry evidence too — a green gate says what it verified.
      expect(check.note.length).toBeGreaterThan(0);
    }
    expect(report.checks.filter((c) => c.ok)).toHaveLength(3);
    expect(report.violations).toHaveLength(1);
    expect(report.violations[0]).toContain("missing-output.bin");
    expect(report.passed).toBe(false);
  });

  test("artifactsExist passes with populated notes when everything exists", async () => {
    write("a.txt", "hello");
    const envelope: Envelope = {
      kind: "verify",
      label: "build",
      status: "success",
      summary: "built",
      artifacts: ["a.txt"],
    };
    const report = await artifactsExist.run(envelope, gateCtx);
    expect(report.passed).toBe(true);
    expect(report.checks[0]!.note).toMatch(/exists,/);
  });

  test("artifactsExist refuses a path outside the pinned run root", async () => {
    const outside = path.join(tmpRoot, "outside.txt");
    fs.writeFileSync(outside, "escaped");
    const envelope: Envelope = {
      kind: "verify",
      label: "build",
      status: "success",
      summary: "built",
      artifacts: ["../outside.txt"],
    };
    const report = await artifactsExist.run(envelope, gateCtx);
    expect(report.passed).toBe(false);
    expect(report.violations[0]).toContain("../outside.txt");
  });

  test("filesNonEmpty flags an empty artifact and skips missing ones", async () => {
    write("empty.txt", "");
    write("full.txt", "data");
    const envelope: Envelope = {
      kind: "verify",
      label: "build",
      status: "success",
      summary: "built",
      artifacts: ["empty.txt", "full.txt", "not-there.txt"],
    };
    const report = await filesNonEmpty.run(envelope, gateCtx);
    // Existence is artifactsExist's job: only artifacts that exist are examined.
    expect(report.checks).toHaveLength(2);
    expect(report.checks.find((c) => c.item.endsWith("empty.txt"))?.ok).toBe(false);
    expect(report.passed).toBe(false);
  });

  test("jsonParses names the parsed type on pass and the error on fail", async () => {
    write("good.json", '{"a":1}');
    write("bad.json", "{not json");
    write("plain.txt", "text");
    const envelope: Envelope = {
      kind: "verify",
      label: "build",
      status: "success",
      summary: "built",
      artifacts: ["good.json", "bad.json", "plain.txt"],
    };
    const report = await jsonParses.run(envelope, gateCtx);
    expect(report.checks).toHaveLength(2);
    const good = report.checks.find((c) => c.item.endsWith("good.json"));
    const bad = report.checks.find((c) => c.item.endsWith("bad.json"));
    expect(good?.ok).toBe(true);
    expect(good?.note).toBe("parses, object");
    expect(bad?.ok).toBe(false);
    expect(bad?.note).toContain("does not parse");
    expect(report.passed).toBe(false);
  });

  test("diffMatchesClaims: every file claimed changed must exist", async () => {
    write("src/one.ts", "export {};");
    const envelope: Envelope = {
      kind: "changes",
      label: "fix",
      status: "success",
      summary: "2 files changed",
      changedFiles: ["src/one.ts", "src/two.ts"],
    };
    const report = await diffMatchesClaims.run(envelope, gateCtx);
    expect(report.checks).toHaveLength(2);
    expect(report.violations).toHaveLength(1);
    expect(report.violations[0]).toContain("src/two.ts");
  });
});

describe("verdictConsistent (AC3)", () => {
  test.each(["approvedWithBlocking", "approvedWithUnmet", "rejectionNamesNothing"])(
    "%s is refuted judged against itself",
    async (key) => {
      const report = await verdictConsistent.run(reviewCases[key], { runRoot: tmpRoot });
      expect(report.passed).toBe(false);
      expect(report.checks).toHaveLength(3);
      expect(report.violations).toHaveLength(1);
    },
  );

  test.each(["consistentApproval", "consistentRejection"])(
    "%s passes with populated notes",
    async (key) => {
      const report = await verdictConsistent.run(reviewCases[key], { runRoot: tmpRoot });
      expect(report.passed).toBe(true);
      expect(report.checks).toHaveLength(3);
      for (const check of report.checks) {
        expect(check.note.length).toBeGreaterThan(0);
      }
    },
  );

  test("self-consistency negative control: an approved-flag-only gate would pass approvedWithBlocking", async () => {
    const envelope = reviewCases.approvedWithBlocking!;
    // The gate under test must refute on structure, not on the approved flag.
    expect(envelope.approved).toBe(true); // the trap is real...
    const report = await verdictConsistent.run(envelope, { runRoot: tmpRoot });
    expect(report.passed).toBe(false); // ...and the gate escapes it
  });
});

describe("gatedBody wiring (AC4)", () => {
  const failArgv = [
    process.execPath,
    "-e",
    "console.log('boom stdout'); console.error('boom stderr'); process.exit(1)",
  ];

  function newRun(dir: string, runId: string): { run: Run; journal: FileJournal; journalPath: string } {
    const journalPath = path.join(dir, `${runId}-journal.json`);
    const journal = new FileJournal(journalPath, runId);
    const run = new Run({
      ctx: { runId, pipelineId: "df12-test", requestId: `req-${runId}` },
      journal,
      log: () => {},
    });
    return { run, journal, journalPath };
  }

  function spec(name: string, description: string) {
    return { name, kind: "code" as const, description, maxDurationMs: 60_000, retries: 0, command: failArgv };
  }

  async function runFailingCommand(
    argv: string[],
    env: Record<string, string>,
    logPath: string,
  ): Promise<Envelope> {
    const proc = Bun.spawn(argv, { env, stdout: "pipe", stderr: "pipe" });
    const [exitCode, stdout, stderr] = await Promise.all([
      proc.exited,
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    fs.writeFileSync(logPath, `${stdout}${stderr}`);
    return asEnvelope(
      {
        name: "tests",
        command: argv,
        exitCode,
        outputTail: stdout + stderr,
        outputArtifact: logPath,
        spawnEnv: env,
      },
      "tests",
    );
  }

  test("the trio in one test: failing block is data, failing gate is a phase failure", async () => {
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(tmpRoot, "trio-")));

    // Half one: a code block exiting 1 with no gate — phase success, run not accepted.
    const a = newRun(dir, "run-a");
    const noGate = await a.run.phase(
      spec("run-tests", "Run the failing test suite"),
      async () => "block-result",
    );
    expect(noGate.status).toBe("success");
    expect(a.run.finish(false).ok).toBe(false);
    expect(readJournal(a.journalPath).gateEvents).toHaveLength(0);

    // Half two: the same command with a gate whose report is passed:false — phase fail.
    const b = newRun(dir, "run-b");
    const gated = gatedBody(b.journal, { runRoot: dir }, [
      commandGate(failArgv, { env: { PATH: process.env.PATH ?? "" } }),
    ])(async () => "block-result");
    const withGate = await b.run.phase(spec("run-tests", "Run the failing test suite"), gated);
    expect(withGate.status).toBe("fail");
    expect(b.run.isHalted).toBe(true);
    const events = readJournal(b.journalPath).gateEvents;
    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe("gate_fail");
  });

  test("a zero-check gate through gatedBody fails the phase (INV-5 end to end)", async () => {
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(tmpRoot, "vacuous-")));
    const journalPath = path.join(dir, "journal.json");
    const journal = new FileJournal(journalPath, "run-vacuous");
    const run = new Run({
      ctx: { runId: "run-vacuous", pipelineId: "df12-test", requestId: "req-vacuous" },
      journal,
      log: () => {},
    });
    // filesNonEmpty over an envelope with no artifacts examines nothing:
    // zero checks, zero violations, passed: false.
    const wrapped = gatedBody(journal, { runRoot: dir }, [filesNonEmpty])(
      async () =>
        ({
          kind: "verify",
          label: "build",
          status: "success",
          summary: "built",
        }) satisfies Envelope,
    );
    const outcome = await run.phase(
      { name: "gate-build", kind: "code", description: "Gate the build artifacts", maxDurationMs: 30_000, retries: 0, command: ["true"] },
      wrapped,
    );
    expect(outcome.status).toBe("fail");
    const events = readJournal(journalPath).gateEvents;
    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe("gate_fail");
    expect(events[0]!.violations).toEqual([]);
  });

  test("e2e slice: two phases, previous: handoff, gate_fail persisted (AC4 both halves, AC2)", async () => {
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(tmpRoot, "e2e-")));
    const { run, journal, journalPath } = newRun(dir, "run-e2e");
    const sentinelToken = "df12-e2e-secret-sentinel-777777";
    const spawnEnv: Record<string, string> = {
      PATH: process.env.PATH ?? "",
      WORKER_SECRET_TOKEN: sentinelToken,
    };
    const gateCtx: GateContext = { runRoot: dir, env: spawnEnv };

    // Phase 1: failing command, NO gate registered. The failing block is data.
    const phase1 = await run.phase(
      spec("run-tests", "Run the failing test suite"),
      async () => runFailingCommand(failArgv, spawnEnv, path.join(dir, "phase1.log")),
    );
    expect(phase1.status).toBe("success");
    const envelope = phase1.value as Envelope;
    expect(envelope.status).toBe("logic");
    expect(envelope.outputTail).toContain("boom stdout");
    expect(readJournal(journalPath).gateEvents).toHaveLength(0);

    // Phase 2: reads phase 1's envelope out of the identical previous: slot,
    // and carries a commandGate over the same failing command.
    let sawPreviousTail = "";
    const body = async (bodyCtx: PhaseBodyContext): Promise<null> => {
      sawPreviousTail = bodyCtx.params.previous?.outputTail ?? "";
      return null;
    };
    const wrapped = gatedBody(journal, gateCtx, [commandGate(failArgv, { env: spawnEnv })])(body);
    const phase2 = await run.phase(
      { ...spec("gate-tests", "Gate the failing test suite"), previous: envelope },
      wrapped,
    );
    expect(phase2.status).toBe("fail");
    expect(sawPreviousTail).toContain("boom stdout");
    expect(run.isHalted).toBe(true);

    const events = readJournal(journalPath).gateEvents;
    expect(events).toHaveLength(1);
    const event = events[0]!;
    expect(event.type).toBe("gate_fail");
    expect(event.phaseId).toBe(phase2.phaseId);
    const checks = event.checks as Array<{ item: string; ok: boolean; note: string }>;
    expect(checks).toHaveLength(1);
    expect(checks[0]!.ok).toBe(false);
    expect(checks[0]!.note).toContain("exit 1");
    expect(event.violations).toHaveLength(1);

    // INV-6: the sentinel from spawnEnv appears nowhere that was persisted.
    const rawJournal = fs.readFileSync(journalPath, "utf8");
    expect(rawJournal).not.toContain(sentinelToken);
    expect(rawJournal).not.toContain("spawnEnv");
  });
});
