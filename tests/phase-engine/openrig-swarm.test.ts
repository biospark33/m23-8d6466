import { afterAll, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  SWARM_CLI_TIMEOUT_MS,
  SWARM_MAX_STALE_POLLS,
  openrigSwarmPhase,
  parseQueueShow,
  type CmdResult,
  type CmdRunner,
} from "../../src/phase-engine/phases/openrig-swarm.ts";
import type { PhaseSpec } from "../../src/phase-engine/types.ts";

const SPEC: PhaseSpec = {
  name: "swarm_build",
  kind: "rig_swarm",
  description: "Run the OpenRig swarm",
  maxDurationMs: 600_000,
  retries: 0,
  rigSpec: {
    name: "devrig",
    pods: [{ id: "dev", members: [
      { id: "lead", model: "openrouter/anthropic/claude-haiku-4.5" },
      { id: "worker", model: "openrouter/deepseek/deepseek-v3.2" },
    ]}],
  },
  objective: "Add hello() plus a test; delegate the test to worker.",
  leadSeat: "lead",
  seatBudgets: { lead: 250_000_000, worker: 250_000_000 },
  testCommand: ["bun", "test"],
};

// Deterministic fake runner: records argv, serves canned responses.
function fakeRunner(handlers: Record<string, (argv: string[]) => CmdResult>): { run: CmdRunner; calls: string[][] } {
  const calls: string[][] = [];
  const run: CmdRunner = async (argv) => {
    const key = argv.join(" ");
    calls.push([...argv]);
    for (const [pattern, handler] of Object.entries(handlers)) {
      if (key.includes(pattern)) return handler([...argv]);
    }
    return { exitCode: 0, stdout: "", stderr: "" };
  };
  return { run, calls };
}

const KEYS = JSON.stringify({ lead: "sk-or-v1-lead", worker: "sk-or-v1-worker" });

function baseHandlers(): Record<string, (argv: string[]) => CmdResult> {
  return {
    "healthz": () => ({ exitCode: 0, stdout: "OK", stderr: "" }),
    "/api/rigs/import": () => ({ exitCode: 0, stdout: JSON.stringify({ ok: true, name: "devrig" }), stderr: "" }),
    "/api/queue/create": () => ({ exitCode: 0, stdout: JSON.stringify({ id: "q-1" }), stderr: "" }),
    "queue show q-1": () => ({ exitCode: 0, stdout: "id: q-1\nstate: done\nclosureReason: no-follow-on\n", stderr: "" }),
  };
}

// ─── makeTempHome: temp HOME with app/, the seat-keys file, optional session ───
// JSONL. The keys file is published through QDS_SWARM_KEYS_FILE (the env seam
// the body reads in production) and restored afterAll. The brief's runPhase
// call sites pass only (spec, run, home), so the tracer/money sink made here
// ride a module-level handle the helper picks up.
interface TraceRow {
  name?: string;
  payloadJson?: string;
}

const SAVED_KEYS_ENV = process.env.QDS_SWARM_KEYS_FILE;
afterAll(() => {
  if (SAVED_KEYS_ENV === undefined) delete process.env.QDS_SWARM_KEYS_FILE;
  else process.env.QDS_SWARM_KEYS_FILE = SAVED_KEYS_ENV;
});

let live: { traces: TraceRow[]; money: Record<string, unknown>[] } | null = null;

function pricedLine(cost: number): string {
  return JSON.stringify({
    role: "assistant",
    model: "deepseek/deepseek-v3.2",
    timestamp: "2026-09-23T18:00:00.000Z",
    usage: { cost, input: 1000, output: 200, cacheRead: 50, cacheWrite: 10 },
  });
}

function makeTempHome(opts: { withKeys?: boolean; sessionJsonl?: boolean } = {}): {
  home: string;
  traces: TraceRow[];
  money: Record<string, unknown>[];
} {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "qds-swarm-test-"));
  fs.mkdirSync(path.join(home, "app"), { recursive: true }); // the workdir probe target
  if (opts.withKeys === false) {
    delete process.env.QDS_SWARM_KEYS_FILE;
  } else {
    const keysFile = path.join(home, "seat-keys.json");
    fs.writeFileSync(keysFile, KEYS);
    process.env.QDS_SWARM_KEYS_FILE = keysFile;
  }
  if (opts.sessionJsonl) {
    const sessions = path.join(home, ".openrig", "state", "pi", "dev-worker@devrig", "sessions");
    fs.mkdirSync(sessions, { recursive: true });
    fs.writeFileSync(path.join(sessions, "s1.jsonl"), `${pricedLine(0.0125)}\n${pricedLine(0.002)}\n`);
  }
  const traces: TraceRow[] = [];
  const money: Record<string, unknown>[] = [];
  live = { traces, money };
  return { home, traces, money };
}

async function runPhase(
  spec: PhaseSpec,
  run: CmdRunner,
  home: string,
  signal = new AbortController().signal,
  extra: { pollIntervalMs?: number } = {},
) {
  return openrigSwarmPhase(spec, {
    run,
    home,
    ...extra,
    ...(live === null
      ? {}
      : {
          tracer: { trace: (row: Record<string, unknown>) => live!.traces.push(row as TraceRow) },
          emitMoneyLine: (line: Record<string, unknown>) => live!.money.push(line),
        }),
  })({
    signal,
    phaseId: "ph-1",
    params: spec,
    ctx: { runId: "run-1", pipelineId: "pipe-1", requestId: "req-1" },
  });
}

test("full lifecycle: seeds, boots, imports, queues, polls to done, tears down", async () => {
  const { run, calls } = fakeRunner(baseHandlers());
  const { home, traces } = makeTempHome(); // helper in this test file
  const value = await runPhase(SPEC, run, home);
  expect(value.exitStatus).toBe("success");
  const joined = calls.map((c) => c.join(" "));
  expect(joined.some((c) => c.includes("daemon start --no-kernel"))).toBe(true);
  expect(joined.some((c) => c.includes("/api/rigs/import") && c.includes("X-Rig-Root"))).toBe(true);
  expect(joined.some((c) => c.includes("/api/queue/create") && c.includes("dev-lead@devrig"))).toBe(true);
  expect(joined.some((c) => c.includes("rig down devrig --delete --force"))).toBe(true);
  expect(joined.some((c) => c.includes("daemon stop"))).toBe(true);
  expect(joined.some((c) => c.includes("tmux kill-server"))).toBe(true);
  // teardown happens AFTER the settled trace and cost emission
  const names = traces.map((t) => t.name);
  expect(names).toContain("swarm_seat_up");
  expect(names).toContain("swarm_qitem_transition");
  expect(names).toContain("swarm_settled");
  // per-seat auth.json seeded BEFORE import
  for (const seat of ["lead", "worker"]) {
    const auth = await Bun.file(`${home}/.openrig/state/pi/dev-${seat}@devrig/agent/auth.json`).text();
    expect(JSON.parse(auth).openrouter.key).toBe(`sk-or-v1-${seat}`);
  }
});

test("missing keys file refuses before any box state changes", async () => {
  const { run, calls } = fakeRunner(baseHandlers());
  const { home } = makeTempHome({ withKeys: false });
  await expect(runPhase(SPEC, run, home)).rejects.toThrow(/QDS_SWARM_KEYS_FILE/);
  expect(calls.map((c) => c.join(" ")).some((c) => c.includes("daemon start"))).toBe(false);
});

test("lead closing the item tears down IMMEDIATELY (no further polling)", async () => {
  let polls = 0;
  const handlers = baseHandlers();
  handlers["queue show q-1"] = () => {
    polls += 1;
    return { exitCode: 0, stdout: "state: done\nclosureReason: no-follow-on\n", stderr: "" };
  };
  const { run, calls } = fakeRunner(handlers);
  const { home } = makeTempHome();
  await runPhase(SPEC, run, home);
  expect(polls).toBe(1);
  const after = calls.map((c) => c.join(" "));
  const doneIdx = after.findIndex((c) => c.includes("queue show"));
  const downIdx = after.findIndex((c) => c.includes("rig down devrig --delete --force"));
  expect(downIdx).toBeGreaterThan(doneIdx);
  expect(after.slice(doneIdx + 1).some((c) => c.includes("queue show"))).toBe(false);
});

test("abort mid-poll still tears down (finally)", async () => {
  const ac = new AbortController();
  const handlers = baseHandlers();
  handlers["queue show q-1"] = () => {
    ac.abort();
    return { exitCode: 0, stdout: "state: open\n", stderr: "" };
  };
  const { run, calls } = fakeRunner(handlers);
  const { home } = makeTempHome();
  await expect(runPhase(SPEC, run, home, ac.signal)).rejects.toThrow();
  expect(calls.map((c) => c.join(" ")).some((c) => c.includes("rig down devrig --delete --force"))).toBe(true);
});

test("abort mid-poll still emits seat costs BEFORE teardown", async () => {
  const ac = new AbortController();
  const handlers = baseHandlers();
  handlers["queue show q-1"] = () => {
    ac.abort();
    return { exitCode: 0, stdout: "state: open\n", stderr: "" };
  };
  const { run } = fakeRunner(handlers);
  const { home, money } = makeTempHome({ sessionJsonl: true });
  const events: string[] = [];
  const moneyPush = money.push.bind(money);
  money.push = (...rows: Record<string, unknown>[]) => {
    events.push(`money:${String(rows[0]?.agentId ?? "")}`);
    return moneyPush(...rows);
  };
  const wrapped: CmdRunner = async (argv, opts) => {
    const res = await run(argv, opts);
    events.push(argv.join(" "));
    return res;
  };
  await expect(runPhase(SPEC, wrapped, home, ac.signal)).rejects.toThrow();
  expect(money.some((l) => (l as { agentId?: string }).agentId === "dev-worker@devrig")).toBe(true);
  expect(events.findIndex((e) => e.startsWith("money:"))).toBeLessThan(
    events.findIndex((e) => e.includes("rig down devrig --delete --force")),
  );
});

test("timeout fallback settles without done and lets the gate decide", async () => {
  const handlers = baseHandlers();
  handlers["queue show q-1"] = () => ({ exitCode: 0, stdout: "state: open\n", stderr: "" });
  const { run } = fakeRunner(handlers);
  const { home, traces } = makeTempHome();
  const spec = { ...SPEC, maxDurationMs: 1000 }; // margin makes deadline immediate
  const value = await runPhase(spec, run, home);
  expect(value.exitStatus).toBe("success"); // body settles; the GATE owns the verdict
  const settled = traces.find((t) => t.name === "swarm_settled");
  expect(JSON.parse(settled!.payloadJson!).reason).toBe("timeout-fallback");
});

test("seat costs are emitted BEFORE teardown runs", async () => {
  const { run } = fakeRunner(baseHandlers());
  const { home, money } = makeTempHome({ sessionJsonl: true });
  // The brief sketched the ordering pin as indices into two different arrays
  // (money vs calls) — incomparable. One shared timeline actually pins it:
  // money pushes and teardown cmds both stamp `events` in emission order.
  const events: string[] = [];
  const moneyPush = money.push.bind(money);
  money.push = (...rows: Record<string, unknown>[]) => {
    events.push(`money:${String(rows[0]?.agentId ?? "")}`);
    return moneyPush(...rows);
  };
  const wrapped: CmdRunner = async (argv, opts) => {
    const res = await run(argv, opts);
    events.push(argv.join(" "));
    return res;
  };
  await runPhase(SPEC, wrapped, home);
  const costIdx = money.findIndex((l) => (l as { type?: string }).type === "cost_attribution");
  expect(costIdx).toBeGreaterThanOrEqual(0);
  expect(money.some((l) => (l as { agentId?: string }).agentId === "dev-worker@devrig")).toBe(true);
  expect(events.findIndex((e) => e.startsWith("money:"))).toBeLessThan(
    events.findIndex((e) => e.includes("rig down devrig")),
  );
});

test("parseQueueShow reads the human output shape", () => {
  expect(parseQueueShow("id: q-1\nstate: done\nclosureReason: no-follow-on\n"))
    .toEqual({ state: "done", closureReason: "no-follow-on" });
  expect(parseQueueShow('{"id":"q-1","state":"done","closureReason":"no-follow-on"}'))
    .toEqual({ state: "done", closureReason: "no-follow-on" });
  expect(parseQueueShow("")).toEqual({ state: null, closureReason: null });
});

test("lead seat in a SECOND pod: the objective queues to that pod's session, not pods[0]'s", async () => {
  const spec: PhaseSpec = {
    ...SPEC,
    rigSpec: {
      name: "devrig",
      pods: [
        { id: "dev", members: [{ id: "worker", model: "openrouter/deepseek/deepseek-v3.2" }] },
        { id: "probe", members: [{ id: "lead", model: "openrouter/anthropic/claude-haiku-4.5" }] },
      ],
    },
  };
  const { run, calls } = fakeRunner(baseHandlers());
  const { home } = makeTempHome();
  await runPhase(spec, run, home);
  const create = calls.find((c) => c.join(" ").includes("/api/queue/create"));
  expect(create).toBeDefined();
  const payload = JSON.parse(create![create!.indexOf("-d") + 1]!) as { destinationSession: string };
  expect(payload.destinationSession).toBe("probe-lead@devrig");
});

test("a permanently failing `rig queue show` throws after SWARM_MAX_STALE_POLLS and the finally still tears down", async () => {
  const handlers = baseHandlers();
  handlers["queue show q-1"] = () => ({ exitCode: 1, stdout: "", stderr: "daemon hung" });
  const { run, calls } = fakeRunner(handlers);
  const { home } = makeTempHome();
  await expect(runPhase(SPEC, run, home, new AbortController().signal, { pollIntervalMs: 1 }))
    .rejects.toThrow(/unreadable .* polls in a row/);
  const joined = calls.map((c) => c.join(" "));
  expect(joined.filter((c) => c.includes("queue show"))).toHaveLength(SWARM_MAX_STALE_POLLS);
  expect(joined.some((c) => c.includes("rig down devrig --delete --force"))).toBe(true);
});

test("poll-loop queue show and healthz calls carry the bounded SWARM_CLI_TIMEOUT_MS", async () => {
  const { run } = fakeRunner(baseHandlers());
  const seen: { argv: string[]; timeoutMs?: number }[] = [];
  const wrapped: CmdRunner = async (argv, opts) => {
    seen.push({ argv: [...argv], timeoutMs: opts?.timeoutMs });
    return run(argv, opts);
  };
  const { home } = makeTempHome();
  await runPhase(SPEC, wrapped, home);
  const queueShows = seen.filter((c) => c.argv.join(" ").includes("queue show"));
  expect(queueShows.length).toBeGreaterThanOrEqual(1);
  for (const c of queueShows) expect(c.timeoutMs).toBe(SWARM_CLI_TIMEOUT_MS);
  for (const c of seen.filter((x) => x.argv.join(" ").includes("healthz"))) {
    expect(c.timeoutMs).toBe(SWARM_CLI_TIMEOUT_MS);
  }
});
