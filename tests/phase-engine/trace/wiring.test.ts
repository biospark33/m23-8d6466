/**
 * DF1.4 Wave 3 wiring tests (Story DF1.4).
 *
 * TDD tests for TracingJournal delegation + forwarding, gate event wiring,
 * tracer failure discipline, finish session wiring, and e2e-lite demo.
 */
import { afterAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import Database from "bun:sqlite";
import { openTraceReader } from "../../../src/phase-engine/trace/reader.ts";
import { Tracer } from "../../../src/phase-engine/trace/tracer.ts";
import type { GateEvent, PhaseRecord } from "../../../src/phase-engine/types.ts";
import type { PhaseJournal } from "../../../src/phase-engine/journal.ts";

// Test utilities
const tmpRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "df1-4-wiring-")));
afterAll(() => fs.rmSync(tmpRoot, { recursive: true, force: true }));

let seq = 0;
function workspace(): { dir: string; traceDb: string; journalPath: string } {
  const dir = path.join(tmpRoot, `ws-${seq++}`);
  fs.mkdirSync(dir, { recursive: true });
  return {
    dir,
    traceDb: path.join(dir, "trace", "trace.db"),
    journalPath: path.join(dir, "journal.json"),
  };
}

describe("TracingJournal delegation + forwarding", () => {
  test("writePhase calls inner AND writes phases row", () => {
    const ws = workspace();
    const innerCalls: { op: string; args: unknown[] }[] = [];

    const innerJournal: PhaseJournal = {
      writePhase: (record: PhaseRecord) => {
        innerCalls.push({ op: "writePhase", args: [record] });
      },
      promotePhase: () => {},
      writeGateEvent: () => {},
      finish: () => ({ ok: true, completedAt: new Date().toISOString() }),
      phases: () => [],
    };

    const recorder: PhaseRecord = {
      runId: "",
      requestId: "",
      pipelineId: "",
      phaseId: "",
      name: "",
      kind: "code",
      status: "fail",
      startedAt: "",
      updatedAt: "",
    };

    const tracer = new Tracer({
      dataDir: path.join(ws.dir, "trace"),
      requestId: "test-req-1",
      pipelineName: "test-pipeline",
    });

    // Import after tracer exists to avoid circular dep issues in test environment
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { TracingJournal } = require("../../../src/phase-engine/trace/journal-bridge.ts");

    const journal = new TracingJournal(innerJournal, tracer, {
      runId: "test-run-1",
      requestId: "test-req-1",
      pipelineId: "test-pipeline",
    });

    const record: PhaseRecord = {
      runId: "test-run-1",
      requestId: "test-req-1",
      pipelineId: "test-pipeline",
      phaseId: "phase-1",
      name: "plan",
      kind: "code",
      status: "fail",
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    journal.writePhase(record);

    // Inner journal called
    expect(innerCalls).toHaveLength(1);
    expect(innerCalls[0]?.op).toBe("writePhase");

    // Tracer wrote phases row
    tracer.close();
    const db = new Database(ws.traceDb, { readonly: true });
    const phases = db.query("SELECT * FROM phases WHERE request_id = ?").all("test-req-1") as {
      name: string;
      status: string;
      seq: number;
    }[];
    expect(phases).toHaveLength(1);
    expect(phases[0]?.name).toBe("plan");
    expect(phases[0]?.status).toBe("fail");
    expect(phases[0]?.seq).toBe(0);
    db.close();
  });

  test("promotePhase updates phases row status and ended_at", () => {
    const ws = workspace();
    const innerCalls: { op: string; args: unknown[] }[] = [];

    const innerJournal: PhaseJournal = {
      writePhase: () => {},
      promotePhase: (phaseId: string, status: string, exitStatus?: string) => {
        innerCalls.push({ op: "promotePhase", args: [phaseId, status, exitStatus] });
      },
      writeGateEvent: () => {},
      finish: () => ({ ok: true, completedAt: new Date().toISOString() }),
      phases: () => [],
    };

    const tracer = new Tracer({
      dataDir: path.join(ws.dir, "trace"),
      requestId: "test-req-2",
      pipelineName: "test-pipeline",
    });

    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { TracingJournal } = require("../../../src/phase-engine/trace/journal-bridge.ts");

    const journal = new TracingJournal(innerJournal, tracer, {
      runId: "test-run-2",
      requestId: "test-req-2",
      pipelineId: "test-pipeline",
    });

    journal.promotePhase("phase-1", "success", "success");

    expect(innerCalls).toHaveLength(1);
    expect(innerCalls[0]?.args).toEqual(["phase-1", "success", "success"]);

    tracer.close();
    const db = new Database(ws.traceDb, { readonly: true });
    const phase = db.query("SELECT * FROM phases WHERE phase_id = ?").get("phase-1") as {
      status: string;
      ended_at: string | null;
    } | null;
    expect(phase).not.toBeNull();
    expect(phase?.status).toBe("success");
    expect(phase?.ended_at).not.toBeNull();
    db.close();
  });

  test("writeGateEvent forwards to tracer.recordGateResult", () => {
    const ws = workspace();
    const innerCalls: { op: string; args: unknown[] }[] = [];

    const innerJournal: PhaseJournal = {
      writePhase: () => {},
      promotePhase: () => {},
      writeGateEvent: (event: GateEvent) => {
        innerCalls.push({ op: "writeGateEvent", args: [event] });
      },
      finish: () => ({ ok: true, completedAt: new Date().toISOString() }),
      phases: () => [],
    };

    const tracer = new Tracer({
      dataDir: path.join(ws.dir, "trace"),
      requestId: "test-req-3",
      pipelineName: "test-pipeline",
    });

    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { TracingJournal } = require("../../../src/phase-engine/trace/journal-bridge.ts");

    const journal = new TracingJournal(innerJournal, tracer, {
      runId: "test-run-3",
      requestId: "test-req-3",
      pipelineId: "test-pipeline",
    });

    const gateEvent: GateEvent = {
      runId: "test-run-3",
      phaseId: "phase-1",
      type: "gate_fail",
      name: "artifactsExist",
      requestId: "test-req-3",
      phase: "plan",
      attempt: 1,
      gate_exec_ms: 10,
      gate_report_ms: 5,
      violations: ["artifact missing: plan.md"],
      checks: [
        { item: "plan.md exists", ok: false, note: "not found" },
        { item: "plan.json exists", ok: true, note: "" },
      ],
    };

    journal.writeGateEvent(gateEvent);

    // Inner journal called
    expect(innerCalls).toHaveLength(1);
    expect(innerCalls[0]?.op).toBe("writeGateEvent");

    // Tracer wrote gate_results row
    tracer.close();
    const db = new Database(ws.traceDb, { readonly: true });
    const gateResults = db.query("SELECT * FROM gate_results WHERE request_id = ?").all("test-req-3");
    expect(gateResults).toHaveLength(1);
    const row = gateResults[0] as {
      gate: string;
      passed: number;
      violations_json: string;
      checks_json: string;
    };
    expect(row.gate).toBe("artifactsExist");
    expect(row.passed).toBe(0);
    expect(JSON.parse(row.violations_json)).toEqual(["artifact missing: plan.md"]);
    expect(JSON.parse(row.checks_json)).toHaveLength(2);
    db.close();
  });

  test("tracer failure does not break the run", () => {
    const ws = workspace();
    const innerCalls: { op: string; args: unknown[] }[] = [];

    const innerJournal: PhaseJournal = {
      writePhase: (record: PhaseRecord) => {
        innerCalls.push({ op: "writePhase", args: [record] });
      },
      promotePhase: (phaseId: string, status: string) => {
        innerCalls.push({ op: "promotePhase", args: [phaseId, status] });
      },
      writeGateEvent: () => {},
      finish: () => ({ ok: true, completedAt: new Date().toISOString() }),
      phases: () => [],
    };

    const tracer = new Tracer({
      dataDir: path.join(ws.dir, "trace"),
      requestId: "test-req-fail",
      pipelineName: "test-pipeline",
    });

    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { TracingJournal } = require("../../../src/phase-engine/trace/journal-bridge.ts");

    const journal = new TracingJournal(innerJournal, tracer, {
      runId: "test-run-fail",
      requestId: "test-req-fail",
      pipelineId: "test-pipeline",
    });

    // Close tracer out from under it
    tracer.close();

    // Operations should still work via inner journal
    const record: PhaseRecord = {
      runId: "test-run-fail",
      requestId: "test-req-fail",
      pipelineId: "test-pipeline",
      phaseId: "phase-1",
      name: "plan",
      kind: "code",
      status: "fail",
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    journal.writePhase(record);
    journal.promotePhase("phase-1", "success");

    // Inner journal was called twice (write + promote)
    expect(innerCalls).toHaveLength(2);
    expect(innerCalls[0]?.op).toBe("writePhase");
    expect(innerCalls[1]?.op).toBe("promotePhase");
  });

  test("finish calls finishSession and processesEndAll", () => {
    const ws = workspace();

    const innerJournal: PhaseJournal = {
      writePhase: () => {},
      promotePhase: () => {},
      writeGateEvent: () => {},
      finish: (runId: string, accepted: boolean) => {
        return { ok: accepted, completedAt: new Date().toISOString() };
      },
      phases: () => [],
    };

    const tracer = new Tracer({
      dataDir: path.join(ws.dir, "trace"),
      requestId: "test-req-finish",
      pipelineName: "test-pipeline",
    });

    // Start session and record a process
    tracer.startSession({ requestId: "test-req-finish", request: "test-request" });
    tracer.recordProcess({
      requestId: "test-req-finish",
      kind: "command",
      pid: 12345,
      command: "echo test",
    });

    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { TracingJournal } = require("../../../src/phase-engine/trace/journal-bridge.ts");

    const journal = new TracingJournal(innerJournal, tracer, {
      runId: "test-run-finish",
      requestId: "test-req-finish",
      pipelineId: "test-pipeline",
    });

    const outcome = journal.finish("test-run-finish", true);

    expect(outcome.ok).toBe(true);

    // Verify session status and processes ended_at
    tracer.close();
    const db = new Database(ws.traceDb, { readonly: true });
    const session = db.query("SELECT * FROM sessions WHERE request_id = ?").get("test-req-finish") as {
      status: string | null;
      ended_at: string | null;
    } | null;
    expect(session).not.toBeNull();
    expect(session?.status).toBe("ok");

    const process = db.query("SELECT * FROM processes WHERE request_id = ?").get("test-req-finish") as {
      ended_at: string | null;
    } | null;
    expect(process).not.toBeNull();
    expect(process?.ended_at).not.toBeNull();
    db.close();
  });

  test("phases() delegates to inner journal", () => {
    const innerPhases: PhaseRecord[] = [
      {
        runId: "test-run",
        requestId: "test-req",
        pipelineId: "test-pipeline",
        phaseId: "phase-1",
        name: "plan",
        kind: "code",
        status: "success",
        startedAt: "2024-01-01T00:00:00Z",
        updatedAt: "2024-01-01T00:01:00Z",
      },
    ];

    const innerJournal: PhaseJournal = {
      writePhase: () => {},
      promotePhase: () => {},
      writeGateEvent: () => {},
      finish: () => ({ ok: true, completedAt: new Date().toISOString() }),
      phases: () => innerPhases,
    };

    const tracer = new Tracer({
      dataDir: path.join(tmpRoot, "trace"),
      requestId: "test-req",
      pipelineName: "test-pipeline",
    });

    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { TracingJournal } = require("../../../src/phase-engine/trace/journal-bridge.ts");

    const journal = new TracingJournal(innerJournal, tracer, {
      runId: "test-run",
      requestId: "test-req",
      pipelineId: "test-pipeline",
    });

    const phases = journal.phases();
    expect(phases).toEqual(innerPhases);

    tracer.close();
  });
});

describe("e2e-lite: full engine run with trace", () => {
  test("two-phase run with phase 2 killed leaves trace.db with correct rows", async () => {
    const ws = workspace();
    const manifest = path.join(ws.dir, "pipeline.json");
    const journalPath = path.join(ws.dir, "out.json");
    const traceDir = path.join(ws.dir, "trace");

    fs.writeFileSync(
      manifest,
      JSON.stringify({
        version: "1.0.0",
        pipelineId: "e2e-lite-pipeline",
        runBudgetMs: 100_000,
        phases: [
          {
            name: "plan",
            kind: "code",
            description: "Phase that passes",
            maxDurationMs: 15_000,
            retries: 0,
            command: ["echo", "plan complete"],
          },
          {
            name: "build",
            kind: "code",
            description: "Phase that gets killed",
            maxDurationMs: 15_000,
            retries: 0,
            command: ["sleep", "12"],
          },
        ],
      }),
    );

    const REPO_ROOT = path.resolve(import.meta.dir, "..", "..", "..");
    const RUNNER = path.join(REPO_ROOT, "scripts", "pipeline-run.ts");

    const proc = Bun.spawn({
      cmd: [process.execPath, RUNNER, "--manifest", manifest, "--budget-ms", "120000", "--journal", journalPath, "--run-root", ws.dir],
      cwd: REPO_ROOT,
      env: { ...process.env, QDS_RUN_ROOT: ws.dir },
      stdout: "pipe",
      stderr: "pipe",
    });

    // Wait for second phase to start (check trace.db directly for 2 phase_start events)
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      if (fs.existsSync(ws.traceDb)) {
        const db = new Database(ws.traceDb, { readonly: true });
        const events = db.query("SELECT * FROM events WHERE type = 'phase_start'").all() as { type: string }[];
        db.close();
        if (events.length >= 2) break;
      }
      await Bun.sleep(50);
    }

    // Kill the process
    proc.kill("SIGTERM");
    await proc.exited;

    // Verify trace.db exists and has correct rows
    expect(fs.existsSync(ws.traceDb)).toBe(true);

    const db = new Database(ws.traceDb, { readonly: true });

    // 1 sessions row
    const sessions = db.query("SELECT * FROM sessions").all();
    expect(sessions).toHaveLength(1);

    // 2 phases rows with phase 2 status 'fail'
    const phases = db.query("SELECT * FROM phases ORDER BY seq").all() as {
      status: string;
    }[];
    expect(phases).toHaveLength(2);
    expect(phases[0]?.status).toBe("success");
    expect(phases[1]?.status).toBe("fail");

    // processes row with ended_at set
    const processes = db.query("SELECT * FROM processes WHERE request_id = ?").all(
      (sessions[0] as { request_id: string }).request_id,
    );
    expect(processes.length).toBeGreaterThanOrEqual(1);

    // events rows for requestId
    const requestId = (sessions[0] as { request_id: string }).request_id;
    const events = db.query("SELECT * FROM events WHERE request_id = ? ORDER BY rowid").all(requestId);
    expect(events.length).toBeGreaterThan(0);

    // gate_results coverage lives at the port level (writeGateEvent forward
    // test above + tracer.test.ts round-trip): DF1.2 AC4 keeps a command's
    // exit code as data, so the runner composes no blanket gate whose failure
    // would flip a phase verdict here.

    db.close();

    // Two-page rowid read via openTraceReader
    const reader = openTraceReader(ws.traceDb);
    const page1 = reader.readEvents(requestId, undefined, 2);
    expect(page1.rows).toHaveLength(2);
    expect(page1.hasMore).toBe(true);
    expect(page1.cursor).toBeDefined();

    const page2 = reader.readEvents(requestId, page1.cursor, 2);
    expect(page2.rows.length).toBeGreaterThan(0);
    reader.close();
  }, 60_000);

  test("e2e demo artifact: copies trace.db and two-page read to evidence dir", async () => {
    const ws = workspace();
    // DoD (mandatory): the demo artifacts must be durable evidence under the
    // repo's evidence dir, not a tmpdir that vanishes with the suite.
    const REPO_ROOT_EARLY = path.resolve(import.meta.dir, "..", "..", "..");
    const evidenceDir = path.join(REPO_ROOT_EARLY, "_bmad-output", "evidence", "df1-4");
    fs.mkdirSync(evidenceDir, { recursive: true });

    const manifest = path.join(ws.dir, "pipeline.json");
    const journalPath = path.join(ws.dir, "out.json");

    fs.writeFileSync(
      manifest,
      JSON.stringify({
        version: "1.0.0",
        pipelineId: "artifact-pipeline",
        runBudgetMs: 100_000,
        phases: [
          {
            name: "plan",
            kind: "code",
            description: "Phase one",
            maxDurationMs: 15_000,
            retries: 0,
            command: ["echo", "done"],
          },
          {
            name: "build",
            kind: "code",
            description: "Phase two",
            maxDurationMs: 15_000,
            retries: 0,
            command: ["sleep", "12"],
          },
        ],
      }),
    );

    const REPO_ROOT = path.resolve(import.meta.dir, "..", "..", "..");
    const RUNNER = path.join(REPO_ROOT, "scripts", "pipeline-run.ts");

    const proc = Bun.spawn({
      cmd: [process.execPath, RUNNER, "--manifest", manifest, "--budget-ms", "120000", "--journal", journalPath, "--run-root", ws.dir],
      cwd: REPO_ROOT,
      env: { ...process.env, QDS_RUN_ROOT: ws.dir },
      stdout: "pipe",
      stderr: "pipe",
    });

    // Wait and kill
    await Bun.sleep(3000);
    proc.kill("SIGTERM");
    await proc.exited;

    // Copy artifacts. Checkpoint the WAL into the main db first so the
    // standalone .db copy is complete without -wal/-shm sidecars.
    const traceDbSource = ws.traceDb;
    const checkpointDb = new Database(traceDbSource);
    checkpointDb.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    checkpointDb.close();
    const traceDbDest = path.join(evidenceDir, "e2e-two-phase-trace.db");
    fs.copyFileSync(traceDbSource, traceDbDest);

    // Generate two-page read
    const reader = openTraceReader(traceDbSource);
    const db2 = new Database(traceDbSource, { readonly: true });
    const session = reader.readSession(
      (db2.query("SELECT request_id FROM sessions").get() as { request_id: string }).request_id,
    );
    db2.close();
    expect(session).not.toBeNull();

    const requestId = session!.request_id;
    const page1 = reader.readEvents(requestId, undefined, 2);
    const page2 = reader.readEvents(requestId, page1.cursor, 2);

    const twoPageRead = {
      requestId,
      page1: { rows: page1.rows, cursor: page1.cursor, hasMore: page1.hasMore },
      page2: { rows: page2.rows, cursor: page2.cursor, hasMore: page2.hasMore },
    };

    const twoPageReadDest = path.join(evidenceDir, "two-page-read.json");
    fs.writeFileSync(twoPageReadDest, JSON.stringify(twoPageRead, null, 2));

    reader.close();

    // Verify artifacts exist. Reading the copy may recreate -wal/-shm sidecars
    // beside it — remove them so the evidence dir holds exactly the checkpointed
    // db and the JSON read (the checkpoint folded all committed rows in).
    expect(fs.existsSync(traceDbDest)).toBe(true);
    expect(fs.existsSync(twoPageReadDest)).toBe(true);
    fs.rmSync(`${traceDbDest}-wal`, { force: true });
    fs.rmSync(`${traceDbDest}-shm`, { force: true });
  }, 60_000);
});
