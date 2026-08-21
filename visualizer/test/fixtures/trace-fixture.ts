/**
 * DF4.1 test fixture — a real DF1.4 trace.db seeded through the real Tracer.
 *
 * Pattern lifted from tests/phase-engine/trace/tracer.test.ts: mkdtemp root,
 * QDS_RUN_ROOT pointed at it, Tracer writes the seven-table store. Rows the
 * Tracer's public API cannot write (agent_sessions, a bare second sessions
 * row, bulk events past fsync-practical counts) fall to raw sqlite INSERTs
 * against the same schema the Tracer just applied.
 */
import { Database } from "bun:sqlite";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Tracer } from "../../../src/phase-engine/trace/tracer.ts";

export const FIXTURE_REQUEST_ID = "req-df41-fixture";
export const EMPTY_REQUEST_ID = "req-df41-empty";
export const MANY_REQUEST_ID = "req-df41-many";
export const PHASE_ENGINEER = "phase-engineer-1";
export const PHASE_AGENT = "phase-agent-2";

export interface SeededTrace {
  root: string;
  dbPath: string;
  requestId: string;
  phaseIds: { engineer: string; agent: string };
  /** Total events written for the main fixture request (prompts+agent+filler). */
  eventCount: number;
  /** rm the temp root and restore the previous QDS_RUN_ROOT. */
  cleanup(): void;
}

interface FixtureBase {
  root: string;
  dbPath: string;
  tracer: Tracer;
  prevRunRoot: string | undefined;
}

function startFixture(requestId: string): FixtureBase {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "df4-1-viz-")));
  const prevRunRoot = process.env.QDS_RUN_ROOT;
  process.env.QDS_RUN_ROOT = root;
  const dataDir = path.join(root, "trace");
  const tracer = new Tracer({ dataDir, requestId, pipelineName: "fixture-pipeline" });
  return { root, dbPath: path.join(dataDir, "trace.db"), tracer, prevRunRoot };
}

function finishFixture(base: FixtureBase, requestId: string): { cleanup: () => void } {
  return {
    cleanup: () => {
      base.tracer.close();
      fs.rmSync(base.root, { recursive: true, force: true });
      if (base.prevRunRoot === undefined) {
        // biome-ignore lint/performance/noDelete: delete is the only correct way to restore "not set"
        delete process.env.QDS_RUN_ROOT;
      } else {
        process.env.QDS_RUN_ROOT = base.prevRunRoot;
      }
    },
  };
}

/**
 * The full fixture: one finished run, 2 phases, system+user prompt events per
 * phase, agent_start/agent_end with a usage payload, 2 gate results (one
 * failing, with checks+violations), 1 envelope, 1 agent_sessions row, and 12
 * filler log events so small limits force multi-page iteration.
 */
export function seedTrace(): SeededTrace {
  const requestId = FIXTURE_REQUEST_ID;
  const base = startFixture(requestId);
  const t = base.tracer;

  t.startSession({
    requestId,
    request: "fixture: port the visualizer",
    engineer: "fixture-engineer",
  });

  t.upsertPhase({
    requestId,
    phaseId: PHASE_ENGINEER,
    seq: 1,
    name: "plan",
    kind: "engineer",
    description: "planning phase",
    status: "success",
    startedAt: "2026-08-21T10:00:00.000Z",
    endedAt: "2026-08-21T10:00:01.000Z",
  });
  t.upsertPhase({
    requestId,
    phaseId: PHASE_AGENT,
    seq: 2,
    name: "build",
    kind: "agent",
    description: "agent phase",
    status: "success",
    startedAt: "2026-08-21T10:00:01.000Z",
    endedAt: "2026-08-21T10:00:05.000Z",
  });

  // Compiled prompts live in the trace (DD-8), seeded in DF1.4's REAL shape
  // (dispatch-task.ts:227): one event per roster role, name = the role,
  // payload_json = {agentId, prompt, model} with the text in `.prompt`.
  const rolesByPhase: Array<[string, string[]]> = [
    [PHASE_ENGINEER, ["planner", "engineer"]],
    [PHASE_AGENT, ["builder", "reviewer"]],
  ];
  for (const [phaseId, roles] of rolesByPhase) {
    for (const role of roles) {
      t.trace({
        requestId,
        phaseId,
        type: "prompt",
        name: role,
        payloadJson: JSON.stringify({
          agentId: role,
          prompt: `compiled prompt for ${role} in ${phaseId}`,
          model: "qds/test-max",
        }),
      });
    }
  }

  t.trace({
    requestId,
    phaseId: PHASE_AGENT,
    type: "agent_start",
    name: "builder",
    payloadJson: JSON.stringify({
      model: "qds/test-max",
      session_id: "agent-sess-1",
      color: "#a78bfa",
    }),
  });
  // usage(): read = inputTokens 100 + cacheWriteTokens 50 = 150, written =
  // outputTokens 80. Payload is DF1.4's REAL AgentEndEvent shape —
  // UsageBreakdown in camelCase (src/phase-engine/types.ts:294-306,
  // usage.ts:31-50), never the vendored SSSF snake_case spelling.
  t.trace({
    requestId,
    phaseId: PHASE_AGENT,
    type: "agent_end",
    name: "builder",
    payloadJson: JSON.stringify({
      usage: {
        inputTokens: 100,
        cacheReadTokens: 200,
        cacheWriteTokens: 50,
        outputTokens: 80,
        reasoningTokens: 0,
        costMicros: 250_000,
        sends: 2,
      },
      contextTokens: 12_000,
      contextWindow: 200_000,
    }),
  });

  t.recordGateResult({
    requestId,
    phaseId: PHASE_ENGINEER,
    attempt: 1,
    gate: "plan-review",
    passed: true,
    violations: [],
    checks: [{ item: "manifest", ok: true, note: "loads" }],
  });
  t.recordGateResult({
    requestId,
    phaseId: PHASE_AGENT,
    attempt: 1,
    gate: "build-review",
    passed: false,
    violations: ["lint failed"],
    checks: [
      { item: "tests", ok: true, note: "3 passed" },
      { item: "lint", ok: false, note: "1 error" },
    ],
  });

  t.recordEnvelope({
    requestId,
    phaseId: PHASE_AGENT,
    agent: "builder",
    outputType: "TaskOutput",
    payloadJson: JSON.stringify({ built: true }),
    valid: true,
    attempt: 1,
  });

  const FILLER = 12;
  for (let i = 0; i < FILLER; i++) {
    t.trace({ requestId, type: "log", name: `filler-${i}`, payloadJson: "{}" });
  }

  // Integer micro-dollars end to end (DD-9): 250000 µ$ = $0.25.
  t.finishSession({
    requestId,
    status: "success",
    durationMs: 12345,
    totalTokens: 430,
    totalCostMicros: 250_000,
  });

  const aux = new Database(base.dbPath);
  aux.exec("PRAGMA busy_timeout=5000");
  // phases.owner: upsertPhase's API has no owner param — raw UPDATE against
  // the DDL (the agentsFor fallback reads phases.owner as the agent name).
  aux
    .prepare("UPDATE phases SET owner = ? WHERE phase_id = ?")
    .run("engineer", PHASE_ENGINEER);
  aux.prepare("UPDATE phases SET owner = ? WHERE phase_id = ?").run("builder", PHASE_AGENT);
  // agent_sessions: no Tracer API for it — raw INSERT against the DDL.
  aux
    .prepare(
      `INSERT INTO agent_sessions (
         request_id, agent, coding_agent, model, color, session_id,
         context_tokens, context_window
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      requestId,
      "builder",
      "claude-code",
      "qds/test-max",
      "#a78bfa",
      "agent-sess-1",
      12_000,
      200_000,
    );
  // A second session with zero events — the AC4 "exists, event-less" case.
  aux
    .prepare(
      `INSERT INTO sessions (
         request_id, request, status, engineer, started_at, ended_at,
         duration_ms, total_tokens, total_cost, pipeline_name, archived
       ) VALUES (?, ?, 'success', ?, ?, ?, 1000, 0, 0, 'fixture-pipeline', 0)`,
    )
    .run(
      EMPTY_REQUEST_ID,
      "empty run",
      "fixture-engineer",
      "2020-01-01T00:00:00.000Z",
      "2020-01-01T00:00:01.000Z",
    );
  aux.close();

  const { cleanup } = finishFixture(base, requestId);
  return {
    root: base.root,
    dbPath: base.dbPath,
    requestId,
    phaseIds: { engineer: PHASE_ENGINEER, agent: PHASE_AGENT },
    // 4 prompts + agent_start + agent_end + 12 filler = 18.
    eventCount: 4 + 2 + FILLER,
    cleanup,
  };
}

/**
 * A run whose only payload is `count` events, bulk-inserted in one raw
 * transaction (fsync-per-event through Tracer is impractical past ~1000).
 * Used to observe the MAX_LIMIT=1000 clamp with limit=99999.
 */
export function seedManyEvents(count: number): SeededTrace {
  const requestId = MANY_REQUEST_ID;
  const base = startFixture(requestId);
  base.tracer.startSession({ requestId, request: "bulk events", engineer: "fixture" });
  base.tracer.finishSession({
    requestId,
    status: "success",
    durationMs: 1,
    totalTokens: 0,
    totalCostMicros: 0,
  });
  base.tracer.close();

  const aux = new Database(base.dbPath);
  aux.exec("PRAGMA busy_timeout=5000");
  const ins = aux.prepare(
    `INSERT INTO events (
       event_id, request_id, phase_id, parent_id, type, name,
       payload_json, tokens, started_at, ended_at
     ) VALUES (?, ?, NULL, NULL, 'log', 'bulk', NULL, NULL, ?, NULL)`,
  );
  aux.transaction(() => {
    for (let i = 0; i < count; i++) {
      ins.run(`evt-${i}`, requestId, "2026-08-21T10:00:00.000Z");
    }
  })();
  aux.close();

  const { cleanup } = finishFixture(base, requestId);
  return {
    root: base.root,
    dbPath: base.dbPath,
    requestId,
    phaseIds: { engineer: "", agent: "" },
    eventCount: count,
    cleanup,
  };
}
