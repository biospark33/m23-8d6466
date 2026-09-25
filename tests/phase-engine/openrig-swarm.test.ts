import { afterAll, afterEach, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { parse as parseYaml } from "yaml";
import {
  SWARM_CLI_TIMEOUT_MS,
  SWARM_MAX_STALE_POLLS,
  openrigSwarmPhase,
  parseQueueShow,
  type CmdResult,
  type CmdRunner,
} from "../../src/phase-engine/phases/openrig-swarm.ts";
// The env-var name is owned by the providers layer (phase-engine already
// imports from providers) — tests must not hardcode the literal.
import { SWARM_SEAT_KEYS_ENV } from "../../src/providers/credentials.ts";
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
    // One foreign rig's session in the list: teardown must leave it alone.
    "tmux list-sessions": () => ({
      exitCode: 0,
      stdout: "dev-lead@devrig\ndev-worker@devrig\nother@otherrig\n",
      stderr: "",
    }),
  };
}

// ─── makeTempHome: temp HOME with app/, the seat-keys file, optional session ───
// JSONL. The keys file is published through SWARM_SEAT_KEYS_ENV (the env seam
// the body reads in production) and restored afterEach; every temp home is
// removed afterAll. The brief's runPhase call sites pass only (spec, run,
// home), so the tracer/money sink made here ride a module-level handle the
// helper picks up.
interface TraceRow {
  name?: string;
  payloadJson?: string;
}

const homes: string[] = [];
afterAll(() => {
  for (const h of homes) fs.rmSync(h, { recursive: true, force: true });
});

const SAVED_KEYS_ENV = process.env[SWARM_SEAT_KEYS_ENV];
afterEach(() => {
  if (SAVED_KEYS_ENV === undefined) delete process.env[SWARM_SEAT_KEYS_ENV];
  else process.env[SWARM_SEAT_KEYS_ENV] = SAVED_KEYS_ENV;
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
  homes.push(home);
  fs.mkdirSync(path.join(home, "app"), { recursive: true }); // the workdir probe target
  if (opts.withKeys === false) {
    delete process.env[SWARM_SEAT_KEYS_ENV];
  } else {
    const keysFile = path.join(home, "seat-keys.json");
    fs.writeFileSync(keysFile, KEYS);
    process.env[SWARM_SEAT_KEYS_ENV] = keysFile;
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

// A probe-first daemon means the HAPPY path never starts one: healthz is
// already green, the daemon is adopted (not bounced), and `rig daemon stop` is
// never called — only THIS run's daemon is ever stopped.
test("full lifecycle: seeds, boots, imports, queues, polls to done, tears down", async () => {
  const { run, calls } = fakeRunner(baseHandlers());
  // A concurrent run's session dir: per-seat teardown must leave it standing.
  const { home, traces } = makeTempHome();
  fs.mkdirSync(path.join(home, ".openrig", "state", "pi", "other-run@devrig", "sessions"), { recursive: true });
  const value = await runPhase(SPEC, run, home);
  expect(value.exitStatus).toBe("success");
  const joined = calls.map((c) => c.join(" "));
  expect(joined.some((c) => c.includes("daemon start --no-kernel"))).toBe(false);
  expect(joined.some((c) => c.includes("daemon stop"))).toBe(false);
  expect(joined.some((c) => c.includes("/api/rigs/import") && c.includes("X-Rig-Root"))).toBe(true);
  expect(joined.some((c) => c.includes("/api/queue/create") && c.includes("dev-lead@devrig"))).toBe(true);
  expect(joined.some((c) => c.includes("rig down devrig --delete --force"))).toBe(true);
  // Rig-scoped tmux: THIS rig's sessions killed by name, kill-server GONE.
  expect(joined.some((c) => c.includes("tmux kill-server"))).toBe(false);
  expect(joined.some((c) => c.includes("tmux kill-session -t dev-lead@devrig"))).toBe(true);
  expect(joined.some((c) => c.includes("tmux kill-session -t dev-worker@devrig"))).toBe(true);
  expect(joined.some((c) => c.includes("tmux kill-session -t other@otherrig"))).toBe(false);
  // Seeded state (plaintext seat keys) removed per seat — never the whole
  // state dir, so the concurrent run's data survives.
  expect(fs.existsSync(`${home}/.openrig/state/pi/dev-lead@devrig`)).toBe(false);
  expect(fs.existsSync(`${home}/.openrig/state/pi/dev-worker@devrig`)).toBe(false);
  expect(fs.existsSync(`${home}/.openrig/state/pi/other-run@devrig`)).toBe(true);
  expect(fs.existsSync(`${home}/.openrig/state/pi`)).toBe(true);
  const names = traces.map((t) => t.name);
  expect(names).toContain("swarm_seat_up");
  expect(names).toContain("swarm_qitem_transition");
  expect(names).toContain("swarm_settled");
});

// R0.7 rounds 11–12 forensics: the daemon's FIRST-PASS validator (OpenRig
// 0.5.14 rigspec-schema.js) refuses any rig.yaml without `version`,
// `pods[].label`, and per-member `agent_ref`/`profile` — and agent.yaml needs
// `name`+`version`+a `profiles` map the member's `profile` names. The authored
// shape below is what the pinned daemon ACCEPTED (proven on a real box before
// this fix landed); these pins keep a future edit from re-losing a field the
// schema refuses silently at 4.7 s into a paid round.
test("materialized rig.yaml/agent.yaml carry the fields the daemon's import validator requires", async () => {
  const { run } = fakeRunner(baseHandlers());
  const { home } = makeTempHome();
  await runPhase(SPEC, run, home);
  const rigDir = path.join(home, ".openrig", "runs", "run-1", "rig");
  const rig = parseYaml(fs.readFileSync(path.join(rigDir, "rig.yaml"), "utf8")) as {
    version?: string;
    pods?: Array<{ id: string; label?: string; members?: Array<{ id: string; agent_ref?: string; profile?: string; cwd?: string }> }>;
  };
  expect(rig.version).toBe("1");
  expect(rig.pods?.[0]?.label).toBe(rig.pods?.[0]?.id);
  for (const m of rig.pods?.[0]?.members ?? []) {
    expect(m.agent_ref).toBe(`local:agents/${m.id}`);
    expect(m.profile).toBe("default");
    expect(m.cwd).not.toBe("");
  }
  for (const seat of ["lead", "worker"]) {
    const agent = parseYaml(fs.readFileSync(path.join(rigDir, "agents", seat, "agent.yaml"), "utf8")) as {
      name?: string;
      version?: string;
      profiles?: Record<string, { preferences?: { runtime?: string } }>;
    };
    expect(agent.name).toBe(seat);
    expect(agent.version).toBe("1");
    expect(agent.profiles?.default?.preferences?.runtime).toBe("pi");
  }
});

test("auth.json is seeded BEFORE the import call (the import handler reads it)", async () => {  const { home } = makeTempHome();
  const seenAtImport: Record<string, string | null> = {};
  const handlers = baseHandlers();
  handlers["/api/rigs/import"] = () => {
    for (const seat of ["lead", "worker"]) {
      try {
        seenAtImport[seat] = fs.readFileSync(
          `${home}/.openrig/state/pi/dev-${seat}@devrig/agent/auth.json`,
          "utf8",
        );
      } catch {
        seenAtImport[seat] = null;
      }
    }
    return { exitCode: 0, stdout: JSON.stringify({ ok: true, name: "devrig" }), stderr: "" };
  };
  const { run } = fakeRunner(handlers);
  await runPhase(SPEC, run, home);
  for (const seat of ["lead", "worker"]) {
    expect(seenAtImport[seat], `auth.json for ${seat} existed at import time`).not.toBeNull();
    expect(JSON.parse(seenAtImport[seat]!)).toEqual({
      openrouter: { type: "api_key", key: `sk-or-v1-${seat}` },
    });
  }
});

test("teardown runs BEFORE the settled trace is written", async () => {
  const { run } = fakeRunner(baseHandlers());
  const { home, traces } = makeTempHome();
  // One shared timeline: trace pushes and teardown cmds both stamp `events`
  // in emission order (indices into two arrays are incomparable).
  const events: string[] = [];
  const tracesPush = traces.push.bind(traces);
  traces.push = (...rows: TraceRow[]) => {
    for (const r of rows) events.push(`trace:${String(r.name)}`);
    return tracesPush(...rows);
  };
  const wrapped: CmdRunner = async (argv, opts) => {
    const res = await run(argv, opts);
    events.push(argv.join(" "));
    return res;
  };
  await runPhase(SPEC, wrapped, home);
  const settledIdx = events.indexOf("trace:swarm_settled");
  const downIdx = events.findIndex((e) => e.includes("rig down devrig"));
  const killIdx = events.findIndex((e) => e.includes("tmux kill-session"));
  expect(settledIdx).toBeGreaterThan(downIdx);
  expect(settledIdx).toBeGreaterThan(killIdx);
});

test("a NOT-yet-healthy daemon is started (and stopped at teardown, because this run started it)", async () => {
  let healthz = 0;
  const handlers = baseHandlers();
  handlers.healthz = () => {
    healthz += 1;
    return { exitCode: healthz === 1 ? 1 : 0, stdout: healthz === 1 ? "" : "OK", stderr: "" };
  };
  const { run, calls } = fakeRunner(handlers);
  const { home } = makeTempHome();
  const value = await runPhase(SPEC, run, home);
  expect(value.exitStatus).toBe("success");
  const joined = calls.map((c) => c.join(" "));
  expect(joined.filter((c) => c.includes("daemon start --no-kernel"))).toHaveLength(1);
  expect(joined.filter((c) => c.includes("daemon stop"))).toHaveLength(1);
});

test("a failing `rig daemon start` throws immediately with the start command's stderr", async () => {
  const handlers = baseHandlers();
  handlers.healthz = () => ({ exitCode: 1, stdout: "", stderr: "" });
  handlers["daemon start"] = () => ({ exitCode: 1, stdout: "", stderr: "boom: kernel won't come up\n" });
  const { run, calls } = fakeRunner(handlers);
  const { home } = makeTempHome();
  await expect(runPhase(SPEC, run, home))
    .rejects.toThrow(/rig daemon start failed \(exit 1\): boom: kernel won't come up/);
  const joined = calls.map((c) => c.join(" "));
  // The failure surfaces at the start command — the import never ran — and the
  // finally still tears down the box state.
  expect(joined.some((c) => c.includes("/api/rigs/import"))).toBe(false);
  expect(joined.some((c) => c.includes("rig down devrig --delete --force"))).toBe(true);
  expect(joined.some((c) => c.includes("daemon stop"))).toBe(false);
});

test("missing keys file refuses before any box state changes", async () => {
  const { run, calls } = fakeRunner(baseHandlers());
  const { home } = makeTempHome({ withKeys: false });
  await expect(runPhase(SPEC, run, home)).rejects.toThrow(new RegExp(SWARM_SEAT_KEYS_ENV));
  expect(calls.map((c) => c.join(" ")).some((c) => c.includes("daemon start"))).toBe(false);
});

test("a relative or empty home is refused at body entry, before any CLI call", async () => {
  const { run, calls } = fakeRunner(baseHandlers());
  makeTempHome(); // valid keys env; the body must refuse on HOME before reading it
  await expect(runPhase(SPEC, run, "relative/home"))
    .rejects.toThrow(/absolute HOME.*'relative\/home'/);
  await expect(runPhase(SPEC, run, "")).rejects.toThrow(/absolute HOME/);
  expect(calls).toHaveLength(0);
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

test("teardown survives an ALREADY-ABORTED phase signal (teardown runner drops the abort)", async () => {
  // A spawn double faithful to defaultRun's real bound: like Bun.spawn under
  // AbortSignal.any with an aborted signal, it cannot start a child once the
  // supplied signal is aborted — and it records whether each call saw one.
  const calls: { argv: string[]; sawAbortedSignal: boolean }[] = [];
  const handlers = baseHandlers();
  const run: CmdRunner = async (argv, opts) => {
    if (opts?.signal?.aborted) {
      calls.push({ argv: [...argv], sawAbortedSignal: true });
      throw new Error("spawn with aborted signal");
    }
    calls.push({ argv: [...argv], sawAbortedSignal: false });
    const key = argv.join(" ");
    for (const [pattern, handler] of Object.entries(handlers)) {
      if (key.includes(pattern)) return handler([...argv]);
    }
    return { exitCode: 0, stdout: "", stderr: "" };
  };
  // Sanity: the double really refuses an aborted signal — the premise the
  // teardown assertion below relies on.
  const dead = new AbortController();
  dead.abort();
  await expect(run(["rig", "down", "x"], { signal: dead.signal })).rejects.toThrow("spawn with aborted signal");
  calls.length = 0; // drop the sanity row so the teardown assertions read clean
  const ac = new AbortController();
  handlers["queue show q-1"] = () => {
    ac.abort(); // abort mid-poll
    return { exitCode: 0, stdout: "", stderr: "" }; // unreadable → stale poll
  };
  const { home } = makeTempHome();
  await expect(runPhase(SPEC, run, home, ac.signal)).rejects.toThrow();
  // The teardown commands ran anyway, and NONE of them saw the aborted
  // signal: teardown spawns must carry the timeout without the phase abort.
  const teardown = calls.filter((c) => {
    const j = c.argv.join(" ");
    return j.includes("rig down") || j.includes("tmux") || j.includes("daemon stop");
  });
  expect(teardown.length).toBeGreaterThanOrEqual(3); // rig down + tmux list + kills
  expect(teardown.every((c) => !c.sawAbortedSignal)).toBe(true);
  // The seeded state (plaintext seat keys) is still removed despite the abort.
  expect(fs.existsSync(`${home}/.openrig/state/pi/dev-lead@devrig`)).toBe(false);
});

test("timeout fallback settles fail — an unverified swarm is never journaled success", async () => {
  const handlers = baseHandlers();
  handlers["queue show q-1"] = () => ({ exitCode: 0, stdout: "state: open\n", stderr: "" });
  const { run } = fakeRunner(handlers);
  const { home, traces } = makeTempHome();
  const spec = { ...SPEC, maxDurationMs: 1000 }; // margin makes deadline immediate
  const value = await runPhase(spec, run, home);
  expect(value.exitStatus).toBe("fail");
  const settled = traces.find((t) => t.name === "swarm_settled");
  const payload = JSON.parse(settled!.payloadJson!) as { reason: string; timeoutFallback: boolean };
  expect(payload.reason).toBe("timeout-fallback");
  expect(payload.timeoutFallback).toBe(true);
});

// Any terminal queue state other than `done` is a failure closure: the loop
// settles immediately instead of polling to the deadline, and the phase reads
// fail (the gate still renders a verdict on the journal).
test.each(["failed", "cancelled", "canceled"] as const)(
  "a terminal queue state '%s' settles the loop with a fail verdict",
  async (state) => {
    const handlers = baseHandlers();
    handlers["queue show q-1"] = () => ({
      exitCode: 0,
      stdout: `state: ${state}\nclosureReason: user-cancel\n`,
      stderr: "",
    });
    const { run, calls } = fakeRunner(handlers);
    const { home, traces } = makeTempHome();
    const value = await runPhase(SPEC, run, home);
    expect(value.exitStatus).toBe("fail");
    const settled = traces.find((t) => t.name === "swarm_settled");
    const payload = JSON.parse(settled!.payloadJson!) as {
      reason: string;
      state: string;
      closureReason: string;
      qid: string;
      timeoutFallback: boolean;
    };
    expect(payload).toEqual({
      reason: "queue-terminal",
      state,
      closureReason: "user-cancel",
      qid: "q-1",
      timeoutFallback: false,
    });
    // Settled on the FIRST poll — no waiting out the deadline.
    expect(calls.map((c) => c.join(" ")).filter((c) => c.includes("queue show"))).toHaveLength(1);
  },
);

test("a seat with session JSONLs traces swarm_seat_cost with its µ$ total", async () => {
  const { run } = fakeRunner(baseHandlers());
  const { home, traces, money } = makeTempHome({ sessionJsonl: true });
  await runPhase(SPEC, run, home);
  const cost = traces.find((t) => t.name === "swarm_seat_cost");
  expect(cost).toBeDefined();
  expect(JSON.parse(cost!.payloadJson!)).toEqual({
    session: "dev-worker@devrig",
    files: 1,
    totalMicroUsd: 12_500 + 2_000, // the two priced lines' µ$ sum
    role: "worker",
  });
  // And the same total reached the ledger, attributed to the session.
  const rows = money.filter((l) => (l as { type?: string }).type === "cost_attribution");
  expect(rows.reduce((sum, l) => sum + (l as { costMicroUsd: number }).costMicroUsd, 0)).toBe(14_500);
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
