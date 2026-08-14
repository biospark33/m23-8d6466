import { describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { harvestPiStream } from "../scripts/team-lead-driver.ts";
import { parseTeamEventLine, writeArtifactAtomic } from "../src/runner.ts";
import type { TeamEvent } from "../src/runner.ts";
import type { CostEvent } from "../src/types.ts";

const fixture = (name: string): string =>
  readFileSync(join(import.meta.dir, "fixtures", name), "utf8");

describe("parseTeamEventLine — merged", () => {
  it("accepts a genuinely empty result object", () => {
    expect(parseTeamEventLine('{"type":"merged","result":{}}')).toEqual({
      kind: "merged",
      result: {},
    });
  });

  it("rejects a malformed result instead of collapsing it to {}", () => {
    // Each of these used to parse as a "successful" merged event with an empty
    // result, indistinguishable from the case above.
    expect(parseTeamEventLine('{"type":"merged"}')).toBeNull();
    expect(parseTeamEventLine('{"type":"merged","result":null}')).toBeNull();
    expect(parseTeamEventLine('{"type":"merged","result":"oops"}')).toBeNull();
    expect(parseTeamEventLine('{"type":"merged","result":[1,2]}')).toBeNull();
  });
});

describe("parseTeamEventLine — cost (DF2.7 additive widening)", () => {
  it("defaults the four new numerics to 0 on a legacy cost line (AC3)", () => {
    const parsed = parseTeamEventLine(
      '{"type":"cost","agentId":"w1","model":"p/m","inputTokens":10,"outputTokens":2,"costUsd":0.5,"durationMs":7,"timestamp":"t"}',
    );
    expect(parsed).toEqual({
      kind: "cost",
      event: {
        agentId: "w1",
        model: "p/m",
        inputTokens: 10,
        outputTokens: 2,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        costUsd: 0.5,
        turnCount: 0,
        unpricedTurns: 0,
        durationMs: 7,
        timestamp: "t",
      },
    });
  });

  it("carries the four new numerics when present", () => {
    const parsed = parseTeamEventLine(
      '{"type":"cost","agentId":"w1","model":"p/m","inputTokens":10,"outputTokens":2,"cacheReadTokens":40,"cacheWriteTokens":5,"costUsd":0.5,"turnCount":3,"unpricedTurns":1,"durationMs":7,"timestamp":"t"}',
    );
    expect(parsed?.kind).toBe("cost");
    const event = (parsed as Extract<TeamEvent, { kind: "cost" }>).event;
    expect(event.cacheReadTokens).toBe(40);
    expect(event.cacheWriteTokens).toBe(5);
    expect(event.turnCount).toBe(3);
    expect(event.unpricedTurns).toBe(1);
  });

  it("floors malformed usage numerics to 0 rather than putting NaN on the wire", () => {
    const parsed = parseTeamEventLine(
      '{"type":"cost","agentId":"w1","model":"p/m","costUsd":0,"inputTokens":-5,"outputTokens":"x","cacheReadTokens":"forty","cacheWriteTokens":-3,"turnCount":null,"durationMs":1e999}',
    );
    const event = (parsed as Extract<TeamEvent, { kind: "cost" }>).event;
    expect(event.inputTokens).toBe(0);
    expect(event.outputTokens).toBe(0);
    expect(event.cacheReadTokens).toBe(0);
    expect(event.cacheWriteTokens).toBe(0);
    expect(event.turnCount).toBe(0);
    expect(event.durationMs).toBe(0);
  });

  it("does NOT floor a malformed unpricedTurns to 0 — that would fail open", () => {
    // 0 asserts "this cost record is complete". A present-but-unparseable
    // value means the producer had something to say that we could not read,
    // so it counts as at least one unpriced turn (INV-COST-5).
    for (const bad of ['"2"', "-1", "null", "1e999", "{}"]) {
      const parsed = parseTeamEventLine(
        `{"type":"cost","agentId":"w1","model":"p/m","costUsd":0,"unpricedTurns":${bad}}`,
      );
      const event = (parsed as Extract<TeamEvent, { kind: "cost" }>).event;
      // `null` is indistinguishable from absent in JSON and stays 0.
      expect(event.unpricedTurns).toBe(bad === "null" ? 0 : 1);
    }
    // An absent field on a legacy line is still a clean 0 (AC3).
    const legacy = parseTeamEventLine(
      '{"type":"cost","agentId":"w1","model":"p/m","costUsd":0}',
    );
    expect((legacy as Extract<TeamEvent, { kind: "cost" }>).event.unpricedTurns).toBe(0);
  });

  it("accepts an all-zero cost event from a run with no usage-bearing turns (AC5)", () => {
    const parsed = parseTeamEventLine(
      '{"type":"cost","agentId":"w1","model":"p/m","inputTokens":0,"outputTokens":0,"cacheReadTokens":0,"cacheWriteTokens":0,"costUsd":0,"turnCount":0,"unpricedTurns":0,"durationMs":12,"timestamp":"t"}',
    );
    expect(parsed?.kind).toBe("cost");
    expect((parsed as Extract<TeamEvent, { kind: "cost" }>).event.costUsd).toBe(0);
  });
});

describe("harvestPiStream — session-cumulative usage (DF2.7)", () => {
  // Probe-selected fixture: pi reports usage as PER-TURN DELTAS for every
  // field (pi's own `addUsageToTotals` sums per-message usage to get session
  // totals). The fixture is deliberately non-monotone in all three priced
  // fields, so it discriminates three implementations at once:
  //   assign (today's `=`) → reports the LAST turn and fails
  //   last-wins-with-max   → reports the MAX turn and fails
  //   accumulate (`+=`)    → reports the session total and passes
  const TOTAL_INPUT = 73748 + 107436 + 81176; // 262360
  const TOTAL_OUTPUT = 158 + 799 + 333; // 1290
  const TOTAL_COST = 0.0221244 + 0.0322308 + 0.0243528; // ≈ 0.078708

  it("reports session totals, not the final turn or the maximum turn (AC1)", () => {
    const h = harvestPiStream(fixture("pi-usage-3turn.ndjson"));
    expect(h.inputTokens).toBe(TOTAL_INPUT);
    expect(h.outputTokens).toBe(TOTAL_OUTPUT);
    expect(h.costUsd).toBeCloseTo(TOTAL_COST, 10);
    // Negative controls, stated explicitly so a regression names itself.
    expect(h.inputTokens).not.toBe(81176); // last turn (assignment impl)
    expect(h.inputTokens).not.toBe(107436); // max turn (last-wins-with-max)
    expect(h.outputTokens).not.toBe(333);
    expect(h.outputTokens).not.toBe(799);
  });

  it("counts turns and cache tokens, and reports the final assistant text (AC2)", () => {
    const h = harvestPiStream(fixture("pi-usage-3turn.ndjson"));
    expect(h.turnCount).toBe(3);
    expect(h.unpricedTurns).toBe(0);
    // Observed pi corpus reports cacheRead/cacheWrite as 0; never synthesized.
    expect(h.cacheReadTokens).toBe(0);
    expect(h.cacheWriteTokens).toBe(0);
    expect(h.text).toContain('"summary":"done"');
  });

  it("does not double-count message_update / turn_end / agent_end replays (INV-COST-3)", () => {
    // The fixture repeats turn 1's usage on message_update, turn_end AND in
    // agent_end's full message list. A blind `+=` over every usage-bearing
    // event would report ~2× the truth.
    const h = harvestPiStream(fixture("pi-usage-3turn.ndjson"));
    expect(h.turnCount).toBe(3);
    expect(h.inputTokens).toBe(TOTAL_INPUT);
  });

  it("ignores toolResult usage — it is not LLM context accounting", () => {
    // The fixture carries a toolResult message_end with 999999-token usage.
    const h = harvestPiStream(fixture("pi-usage-3turn.ndjson"));
    expect(h.inputTokens).toBeLessThan(999999);
  });

  it("emits all-zero numerics with turnCount 0 for a run with no usage events (AC5)", () => {
    const h = harvestPiStream('{"type":"agent_start"}\n{"type":"agent_end","messages":[]}\n');
    expect(h).toMatchObject({
      costUsd: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      turnCount: 0,
      unpricedTurns: 0,
    });
  });

  it("counts a malformed usage turn as unpriced and leaves the priced total unchanged (AC4, INV-COST-5)", () => {
    const good =
      '{"type":"message_end","message":{"role":"assistant","usage":{"input":10,"output":2,"cacheRead":0,"cacheWrite":0,"cost":{"total":0.5}}}}';
    for (const bad of [
      '{"type":"message_end","message":{"role":"assistant"}}',
      '{"type":"message_end","message":{"role":"assistant","usage":null}}',
      '{"type":"message_end","message":{"role":"assistant","usage":"nope"}}',
      '{"type":"message_end","message":{"role":"assistant","usage":[1,2]}}',
      '{"type":"message_end","message":{"role":"assistant","usage":{"input":10,"output":2,"cost":{"total":1e999}}}}',
      '{"type":"message_end","message":{"role":"assistant","usage":{"input":-10,"output":2,"cost":{"total":0.1}}}}',
      '{"type":"message_end","message":{"role":"assistant","usage":{"input":10,"output":2,"cost":{"total":-0.1}}}}',
      '{"type":"message_end","message":{"role":"assistant","usage":{"input":10,"output":2,"cacheRead":-5,"cost":{"total":0.1}}}}',
    ]) {
      const h = harvestPiStream(`${good}\n${bad}\n`);
      expect(h.turnCount).toBe(2);
      expect(h.unpricedTurns).toBe(1);
      // Monotone non-decreasing: a negative value is malformed input, never a
      // credit that walks the accumulator backwards (INV-COST-1).
      expect(h.costUsd).toBe(0.5);
      expect(h.inputTokens).toBe(10);
      expect(h.outputTokens).toBe(2);
      expect(h.cacheReadTokens).toBe(0);
      expect(Number.isFinite(h.costUsd)).toBe(true);
      expect(Number.isNaN(h.inputTokens)).toBe(false);
    }
  });

  it("accumulates cache tokens across turns (AC2 — the field is actually read)", () => {
    // Every fixture and the shim report cacheRead/cacheWrite as 0, because
    // every one of the 1465 real pi usage records on this host does. Without
    // this test the reader could be looking at the wrong key and the story's
    // headline cache-economics field would read 0 forever with a green suite.
    const turn = (read: number, write: number): string =>
      `{"type":"message_end","message":{"role":"assistant","usage":{"input":1,"output":1,"cacheRead":${read},"cacheWrite":${write},"cost":{"total":0.1}}}}`;
    const h = harvestPiStream(`${turn(1000, 20)}\n${turn(234, 36)}\n`);
    expect(h.cacheReadTokens).toBe(1234);
    expect(h.cacheWriteTokens).toBe(56);
    expect(h.turnCount).toBe(2);
    expect(h.unpricedTurns).toBe(0);
  });

  it("accepts the alternative usage spellings it claims to accept", () => {
    // camelCase-Tokens and the Anthropic snake_case names, plus the top-level
    // `usage` shape (no wrapping message) — all three are defensive fallbacks
    // in readTurnUsage and would otherwise be dead, untested code.
    const camel = harvestPiStream(
      '{"type":"message_end","message":{"role":"assistant","usage":{"inputTokens":11,"outputTokens":3,"cacheReadTokens":7,"cacheWriteTokens":2,"cost":{"total":0.25}}}}',
    );
    expect(camel).toMatchObject({
      inputTokens: 11,
      outputTokens: 3,
      cacheReadTokens: 7,
      cacheWriteTokens: 2,
      unpricedTurns: 0,
    });
    const snake = harvestPiStream(
      '{"type":"message_end","message":{"role":"assistant","usage":{"input":11,"output":3,"cache_read_input_tokens":9,"cache_creation_input_tokens":4,"cost":0.25}}}',
    );
    expect(snake).toMatchObject({
      cacheReadTokens: 9,
      cacheWriteTokens: 4,
      costUsd: 0.25, // bare numeric cost, not the {total} object
      unpricedTurns: 0,
    });
    const topLevel = harvestPiStream(
      '{"type":"message_end","usage":{"input":5,"output":1,"cost":{"total":0.5}}}',
    );
    expect(topLevel).toMatchObject({ inputTokens: 5, costUsd: 0.5, unpricedTurns: 0 });
  });

  it("treats an absent cache field as 0 without unpricing the turn", () => {
    const h = harvestPiStream(
      '{"type":"message_end","message":{"role":"assistant","usage":{"input":10,"output":2,"cost":{"total":0.5}}}}\n',
    );
    expect(h.turnCount).toBe(1);
    expect(h.unpricedTurns).toBe(0);
    expect(h.cacheReadTokens).toBe(0);
    expect(h.cacheWriteTokens).toBe(0);
  });

  it("keeps each invocation's spend to itself across a resumed --session-id (AC6)", () => {
    const a = harvestPiStream(fixture("pi-session-resume-a.ndjson"));
    const b = harvestPiStream(fixture("pi-session-resume-b.ndjson"));
    // Leg B is a RESUMED session: its `agent_end` message list replays leg A's
    // two messages ahead of its own — the carried-in totals are physically
    // present in the stream. That is the negative control: an implementation
    // that reads them restates leg A's spend inside leg B's event, the two
    // events sum to 37000/1400/$0.072 instead of the true 26000/1000/$0.052,
    // and DF2.8's ledger SUM bills the first invocation twice.
    expect(b.inputTokens).toBe(15000);
    expect(b.inputTokens).not.toBe(26000); // ← carried-in passthrough
    expect(b.outputTokens).toBe(700);
    expect(b.costUsd).toBeCloseTo(0.03, 10);
    expect(b.turnCount).toBe(2); // not 4 — agent_end's replay is not a turn
    // The session's true total is the SUM of the two invocations' events —
    // one ledger row per emitted cost event, SUM across rows (DF2.8).
    expect(a.inputTokens + b.inputTokens).toBe(26000);
    expect(a.outputTokens + b.outputTokens).toBe(1000);
    expect(a.costUsd + b.costUsd).toBeCloseTo(0.052, 10);
  });

  it("counts a turn that started but never ended as unpriced (SIGKILLed mid-message)", () => {
    // The timeout path SIGKILLs pi mid-message: message_start and its updates
    // arrive, message_end never does. The provider bills that turn, so the
    // record is KNOWN-PARTIAL — emitting it as a complete one is the failure
    // this guards (it is the runaway-worker case, i.e. the expensive one).
    const complete =
      '{"type":"message_end","message":{"role":"assistant","usage":{"input":10,"output":2,"cost":{"total":0.5}}}}';
    const started =
      '{"type":"message_start","message":{"role":"assistant","content":[]}}';
    const update =
      '{"type":"message_update","message":{"role":"assistant","content":[{"type":"text","text":"partial"}],"usage":{"input":900,"output":9,"cost":{"total":9}}}}';
    const h = harvestPiStream(`${complete}\n${started}\n${update}\n`);
    expect(h.turnCount).toBe(2);
    expect(h.unpricedTurns).toBe(1);
    // The in-flight turn's partial usage is NOT accumulated — an unpriced turn
    // is never priced, not even from a mid-stream sample (INV-COST-5).
    expect(h.costUsd).toBe(0.5);
    expect(h.inputTokens).toBe(10);
  });

  it("does not leave a closed message open (no false unpriced turn)", () => {
    const h = harvestPiStream(
      '{"type":"message_start","message":{"role":"assistant","content":[]}}\n' +
        '{"type":"message_end","message":{"role":"assistant","usage":{"input":10,"output":2,"cost":{"total":0.5}}}}\n' +
        '{"type":"agent_end","messages":[]}\n',
    );
    expect(h.turnCount).toBe(1);
    expect(h.unpricedTurns).toBe(0);
    expect(h.costUsd).toBe(0.5);
  });
});

describe("team-lead-driver end to end — emitted cost events (DF2.7)", () => {
  const DRIVER = join(import.meta.dir, "..", "scripts", "team-lead-driver.ts");
  const TEAM_BIN = join(import.meta.dir, "fixtures", "team-bin");

  function runDriver(
    config: unknown,
    extraEnv: Record<string, string> = {},
  ): {
    costs: CostEvent[];
    stdout: string;
    stderr: string;
    exitCode: number | null;
  } {
    const proc = spawnSync("bun", [DRIVER], {
      encoding: "utf8",
      env: {
        PATH: `${TEAM_BIN}:${process.env.PATH ?? ""}`,
        HOME: process.env.HOME ?? "/tmp",
        QDS_AGENT_TEAM_CONFIG_JSON: JSON.stringify(config),
        ...extraEnv,
      },
    });
    const costs: CostEvent[] = [];
    for (const line of (proc.stdout ?? "").split("\n")) {
      const event = parseTeamEventLine(line);
      if (event?.kind === "cost") costs.push(event.event);
    }
    return {
      costs,
      stdout: proc.stdout ?? "",
      stderr: proc.stderr ?? "",
      exitCode: proc.status,
    };
  }

  const worker = (agentId: string) => ({
    agentId,
    provider: "openrouter",
    model: "stub/model",
    prompt: "do the thing",
  });

  it("emits one cost event per pi subprocess carrying that invocation's session total", () => {
    const { costs, exitCode } = runDriver({
      lead: { ...worker("lead"), provider: "anthropic", model: "claude-stub" },
      workers: [worker("worker-a"), worker("worker-b")],
    });
    expect(exitCode).toBe(0);
    // 2 workers + 1 lead merge = 3 pi invocations = 3 cost events. Workers run
    // under Promise.all and emit on their own subprocess close, so their
    // relative order is completion order, not config order — only the lead
    // (which runs after the merge inputs exist) is genuinely ordered.
    expect(new Set(costs.map((c) => c.agentId))).toEqual(
      new Set(["worker-a", "worker-b", "lead"]),
    );
    expect(costs).toHaveLength(3);
    expect(costs[2]?.agentId).toBe("lead");
    for (const c of costs) {
      expect(c.inputTokens).toBe(262360); // session total …
      expect(c.inputTokens).not.toBe(81176); // … not the final turn
      expect(c.outputTokens).toBe(1290);
      expect(c.costUsd).toBeCloseTo(0.078708, 10);
      expect(c.turnCount).toBe(3);
      expect(c.unpricedTurns).toBe(0);
      expect(c.cacheReadTokens).toBe(0);
      expect(c.cacheWriteTokens).toBe(0);
    }
  }, 30_000);

  it("refuses the next paid subprocess when the cumulative total is partial (INV-COST-5)", () => {
    const { costs, stderr, exitCode } = runDriver(
      {
        lead: { ...worker("lead"), provider: "anthropic", model: "claude-stub" },
        workers: [worker("worker-a")],
      },
      { QDS_FAKE_PI_UNPRICED: "1" },
    );
    expect(exitCode).toBe(0);
    // The worker's own event is still emitted — under-counted, and flagged.
    expect(costs).toHaveLength(1);
    expect(costs[0]?.agentId).toBe("worker-a");
    expect(costs[0]?.unpricedTurns).toBe(1);
    expect(costs[0]?.turnCount).toBe(3);
    // The unpriced turn contributes nothing: 3 turns priced minus the middle
    // one (0.0322308) = 0.0464772, never $0-priced into the total.
    expect(costs[0]?.costUsd).toBeCloseTo(0.0464772, 10);
    // …and the lead merge — the next PAID subprocess — never spawned.
    expect(stderr).toContain("refusing paid lead merge");
  }, 30_000);

  it("refuses the lead merge when ANY worker is partial, not only when all are", () => {
    // Blast radius of INV-COST-5, stated: the guard is per-RUN, because the
    // cumulative total the budget guard reads is per-run. One partial worker
    // makes the whole total partial, so the run degrades to a mechanical merge
    // even though the other worker is perfectly priced.
    const { costs, stderr } = runDriver(
      {
        lead: { ...worker("lead"), provider: "anthropic", model: "claude-stub" },
        workers: [worker("worker-a"), worker("worker-b")],
      },
      { QDS_FAKE_PI_UNPRICED: "1" },
    );
    expect(costs).toHaveLength(2); // both workers, no lead
    expect(costs.every((c) => c.agentId !== "lead")).toBe(true);
    expect(stderr).toContain("refusing paid lead merge");
  }, 30_000);

  it("marks a SIGKILLed mid-message stream partial rather than complete", () => {
    const { costs, stderr } = runDriver(
      {
        lead: { ...worker("lead"), provider: "anthropic", model: "claude-stub" },
        workers: [worker("worker-a")],
      },
      { QDS_FAKE_PI_TRUNCATE: "1" },
    );
    // Turns 1-2 completed; turn 3 started and was cut off.
    expect(costs[0]?.turnCount).toBe(3);
    expect(costs[0]?.unpricedTurns).toBe(1);
    expect(costs[0]?.costUsd).toBeCloseTo(0.0221244 + 0.0322308, 10);
    expect(stderr).toContain("refusing paid lead merge");
  }, 30_000);

  it("never lets tool output stand in for the worker's reply", () => {
    // The shim appends a toolResult message_end whose text is valid JSON with
    // a changedFiles array. If tool text reached extractJsonObject it would be
    // emitted as the worker's structured output — untrusted tool content
    // promoted to a worker result — and its 999999-token usage would be billed.
    const { costs, stdout } = runDriver(
      {
        lead: { ...worker("lead"), provider: "anthropic", model: "claude-stub" },
        workers: [worker("worker-a")],
      },
      { QDS_FAKE_PI_TOOL_TAIL: "1" },
    );
    // The tool's changedFiles never becomes the worker's changedFiles.
    expect(stdout).not.toContain("/etc/passwd");
    expect(stdout).toContain("stubbed reply from");
    // …and the tool's usage is not billed.
    expect(costs[0]?.inputTokens).toBe(262360); // not 262360 + 999999
    expect(costs[0]?.turnCount).toBe(3);
    expect(costs[0]?.unpricedTurns).toBe(0);
  }, 30_000);
});

describe("writeArtifactAtomic", () => {
  it("rejects traversal and separator names", () => {
    const dir = mkdtempSync(join(tmpdir(), "artifact-guard-"));
    try {
      for (const name of ["../escape", "a/b", "/abs", "a\0b"]) {
        expect(() => writeArtifactAtomic(dir, name, {})).toThrow(
          /unsafe artifact name/,
        );
      }
      expect(readdirSync(dir)).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("leaves no tmp file behind when the rename fails", () => {
    const dir = mkdtempSync(join(tmpdir(), "artifact-tmp-"));
    try {
      // Non-empty directory at the destination → rename throws after the tmp
      // file has already been written.
      mkdirSync(join(dir, "worker-1.json"));
      writeFileSync(join(dir, "worker-1.json", "occupied"), "x");
      expect(() => writeArtifactAtomic(dir, "worker-1", { ok: true })).toThrow();
      expect(readdirSync(dir)).toEqual(["worker-1.json"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
