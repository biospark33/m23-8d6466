/**
 * Dual retry discipline tests (Story DF1.3).
 *
 * Loop B (gate retries, bound `PhaseParams.retries`) is OUTER; Loop A (parse
 * fixes, bound `PARSE_FIX_ATTEMPTS`) is INNER — each gate correction's response
 * is re-parsed under a FRESH parse budget. The send ceiling is
 * `(retries + 1) × (PARSE_FIX_ATTEMPTS + 1)` and is asserted, not assumed: an
 * implementation sharing one budget across both loops produces a lower count
 * and MUST fail here (AC1).
 *
 * Tests drive a synthetic per-send usage stream — the only way to assert an
 * exact send-count ceiling deterministically (Technical Notes).
 */
import { afterAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { EnvelopeParseExhausted, runAgentPhase, type AgentSendResult, type AgentSender } from "../../src/phase-engine/agents/retry.ts";
import { SessionCache } from "../../src/phase-engine/agents/session.ts";
import { GateReport } from "../../src/phase-engine/gates/report.ts";
import type { Gate } from "../../src/phase-engine/gates/library.ts";
import { GateFailureError } from "../../src/phase-engine/gates/library.ts";
import { FileJournal } from "../../src/phase-engine/journal.ts";
import { PhaseSpecSchema } from "../../src/phase-engine/manifest.ts";
import { PARSE_FIX_ATTEMPTS } from "../../src/phase-engine/types.ts";
import type { PhaseParams } from "../../src/phase-engine/types.ts";
import type { RunContext } from "../../src/phase-engine/types.ts";
import type { SendUsage } from "../../src/phase-engine/usage.ts";

const tmpRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "df1-3-retry-")));
let seq = 0;

const AGENT = { agentId: "reviewer-1", provider: "openrouter", model: "qwen/qwen3-coder", contextWindow: 131_072 };

function params(over: Partial<PhaseParams> = {}): PhaseParams {
  return {
    name: "review",
    // DF1.10 C19 removed the `agent` kind (superseded by `dispatch_task` with a
    // one-role roster). `runAgentPhase` never switched on `kind` — it takes its
    // sender, gates and prompt from AgentPhaseOptions — so the kind was, and
    // remains, an inert syntactically-valid placeholder here.
    kind: "code",
    // `PhaseSpecSchema` refuses a `code` phase with no `command`, so omitting it
    // here built a spec no real manifest can produce — it typechecked only
    // because `command` is optional on the interface. Present so these cases
    // stay valid if `Run.phase` ever gains the loader's coherence check; inert
    // otherwise, since `runAgentPhase` never spawns it.
    command: ["true"],
    description: "Review the change against its requirements",
    maxDurationMs: 10_000,
    retries: 0,
    agent: AGENT,
    ...over,
  };
}

function usageAt(send: number): SendUsage {
  return {
    inputTokens: 100 + send,
    outputTokens: 10 + send,
    cacheReadTokens: 1_000,
    cacheWriteTokens: 0,
    reasoningTokens: 1,
    costMicros: 100_000 * send,
  };
}

/** Envelope JSON the scripted agent emits. */
function envelopeJson(over: Record<string, unknown> = {}): string {
  return JSON.stringify({ kind: "review", label: "code-review", status: "success", summary: "reviewed", ...over });
}

/**
 * Deterministic sender: returns queued responses (last one repeats), records
 * every prompt and the session id each send was issued under.
 */
function scriptedSender(responses: Array<Partial<AgentSendResult> & { text: string }>) {
  const prompts: string[] = [];
  const sessionIds: (string | undefined)[] = [];
  let calls = 0;
  const sender: AgentSender = {
    async send({ prompt, sessionId }) {
      prompts.push(prompt);
      sessionIds.push(sessionId);
      const r = responses[Math.min(calls, responses.length - 1)]!;
      calls += 1;
      return { stopReason: "end_turn", usage: usageAt(calls), contextTokens: 2_000 * calls, ...r };
    },
  };
  return { sender, prompts, sessionIds, count: () => calls };
}

type Line = Record<string, unknown>;

function harness(over: { params?: Partial<PhaseParams>; responses?: Array<Partial<AgentSendResult> & { text: string }>; gates?: Gate[]; sender?: AgentSender; sessionCache?: SessionCache } = {}) {
  const runId = `run-${seq++}`;
  const journal = new FileJournal(path.join(tmpRoot, `journal-${runId}.json`), runId);
  const lines: Line[] = [];
  const ctx: RunContext = { runId, pipelineId: "demo-pipeline", requestId: "req-df13" };
  const gates: Gate[] =
    over.gates ??
    [
      {
        name: "approvedIsConsistent",
        run: (envelope) =>
          new GateReport().check(
            "approved vs blocking",
            !((envelope?.approved ?? false) && (envelope?.blocking ?? []).length > 0),
            "verdict is supported",
          ),
      },
    ];
  const scripted = scriptedSender(over.responses ?? [{ text: envelopeJson({ approved: true }) }]);
  const result = runAgentPhase({
    params: params(over.params),
    ctx,
    phaseId: `${runId}:0:review`,
    journal,
    log: (line) => lines.push(line),
    sender: over.sender ?? scripted.sender,
    gates,
    initialPrompt: "Produce your Report JSON.",
    sessionCache: over.sessionCache,
  });
  return { result, journal, lines, ctx, scripted };
}

afterAll(() => fs.rmSync(tmpRoot, { recursive: true, force: true }));

describe("send-count ceiling (R + 1) × (P + 1) — AC1, make-or-break", () => {
  // The DoD matrix: retries × parse-failure counts, gates failing until the
  // last attempt. With pf parse failures before each attempt's valid envelope,
  // every gate attempt issues pf + 1 sends, so the exact total is
  // (retries + 1) × (pf + 1). At pf = PARSE_FIX_ATTEMPTS that IS the ceiling —
  // an implementation sharing one budget across both loops caps total attempts
  // at retries + PARSE_FIX_ATTEMPTS + 1 sends and MUST fail those rows.
  test.each([
    { retries: 0, parseFailures: 0, expected: 1 },
    { retries: 0, parseFailures: PARSE_FIX_ATTEMPTS, expected: (0 + 1) * (PARSE_FIX_ATTEMPTS + 1) },
    { retries: 1, parseFailures: 0, expected: 2 },
    { retries: 1, parseFailures: 1, expected: (1 + 1) * 2 },
    { retries: 1, parseFailures: PARSE_FIX_ATTEMPTS, expected: (1 + 1) * (PARSE_FIX_ATTEMPTS + 1) },
    { retries: 2, parseFailures: 0, expected: 3 },
    { retries: 2, parseFailures: PARSE_FIX_ATTEMPTS, expected: (2 + 1) * (PARSE_FIX_ATTEMPTS + 1) },
  ])("retries=$retries, parse failures=$parseFailures per attempt → exactly $expected sends", async ({ retries, parseFailures, expected }) => {
    const responses: Array<{ text: string }> = [];
    for (let attempt = 1; attempt <= retries + 1; attempt += 1) {
      for (let i = 0; i < parseFailures; i += 1) responses.push({ text: `invalid attempt ${attempt}-${i}` });
      // Gates fail every attempt except the last (blocking item + approved).
      responses.push(
        attempt <= retries
          ? { text: envelopeJson({ approved: true, blocking: ["one thing"] }) }
          : { text: envelopeJson({ approved: true }) },
      );
    }
    const h = harness({ params: { retries }, responses });
    const out = await h.result;
    expect(h.scripted.count()).toBe(expected);
    expect(out.record.sends).toBe(expected);
    // The shared-budget kill line: at the ceiling rows with a gate retry to
    // spend, one combined budget of R + P + 1 attempts is strictly fewer sends
    // than the discipline allows (at retries=0 both coincide, as they must).
    if (parseFailures === PARSE_FIX_ATTEMPTS && retries >= 1) {
      expect(retries + PARSE_FIX_ATTEMPTS + 1).toBeLessThan(expected);
    }
  });

  test("invalid JSON on EVERY send raises at P + 1 sends — still inside the ceiling (AC1 'at most')", async () => {
    const h = harness({ params: { retries: 2 }, responses: [{ text: "not json at all" }] });
    await expect(h.result).rejects.toBeInstanceOf(EnvelopeParseExhausted);
    expect(h.scripted.count()).toBe(PARSE_FIX_ATTEMPTS + 1);
    expect(PARSE_FIX_ATTEMPTS + 1).toBeLessThan((2 + 1) * (PARSE_FIX_ATTEMPTS + 1));
  });

  test("each gate correction resets the parse budget: one gate retry buys a fresh (P + 1) parse window", async () => {
    // Attempt 1: parse fails twice, then valid envelope → gate fails.
    // Attempt 2 (gate correction): parse fails twice, then valid envelope → gate passes.
    const responses = [
      { text: "nope" },
      { text: "still nope" },
      { text: envelopeJson({ approved: true, blocking: ["x"] }) },
      { text: "nope again" },
      { text: "nope again 2" },
      { text: envelopeJson({ approved: true }) },
    ];
    const h = harness({ params: { retries: 1 }, responses });
    const out = await h.result;
    expect(h.scripted.count()).toBe(6);
    expect(out.record.envelopeValid).toBe(true);
    expect(out.record.sends).toBe(6);
    expect(out.record.parseAttempts).toBe(6);
  });
});

describe("construction bounds (INV-1) — rejected, never clamped", () => {
  test("DF1.1's closed schema rejects retries 6 and retries -1", () => {
    const base = {
      name: "review",
      kind: "code",
      // Required by the schema for kind "code"; the bounds under test are the
      // retries ones below.
      command: ["true"],
      description: "Review the change against its requirements",
      maxDurationMs: 10_000,
    };
    expect(PhaseSpecSchema.safeParse({ ...base, retries: 6 }).success).toBe(false);
    expect(PhaseSpecSchema.safeParse({ ...base, retries: -1 }).success).toBe(false);
    expect(PhaseSpecSchema.safeParse({ ...base, retries: 0 }).success).toBe(true);
    expect(PhaseSpecSchema.safeParse({ ...base, retries: 5 }).success).toBe(true);
  });

  test("runAgentPhase itself refuses out-of-bound retries rather than clamping", async () => {
    const h = harness({ params: { retries: 6 } });
    await expect(h.result).rejects.toThrow(/retries/);
    expect(h.scripted.count()).toBe(0);
  });
});

describe("session identity (AC2, INV-4)", () => {
  test("every send in one phase carries the identical session id", async () => {
    const h = harness({
      params: { retries: 1 },
      responses: [
        { text: "invalid" },
        { text: "invalid 2" },
        { text: envelopeJson({ approved: true, blocking: ["x"] }) },
        { text: envelopeJson({ approved: true }) },
      ],
    });
    await h.result;
    expect(h.scripted.count()).toBe(4);
    const ids = new Set(h.scripted.sessionIds);
    expect(ids.size).toBe(1);
    expect(typeof [...ids][0]).toBe("string");
  });

  test("same agentId and model but a provider change mints a distinct session id", async () => {
    const cache = new SessionCache();
    const h1 = harness({ sessionCache: cache, responses: [{ text: envelopeJson({ approved: true }) }] });
    await h1.result;
    const h2 = harness({
      sessionCache: cache,
      params: { agent: { ...AGENT, provider: "anthropic" } },
      responses: [{ text: envelopeJson({ approved: true }) }],
    });
    await h2.result;
    expect(h1.scripted.sessionIds[0]).toBeDefined();
    expect(h1.scripted.sessionIds[0]).not.toBe(h2.scripted.sessionIds[0]);
  });

  test("same agentId and provider but a model change also mints a new session id", async () => {
    const cache = new SessionCache();
    const h1 = harness({ sessionCache: cache, responses: [{ text: envelopeJson({ approved: true }) }] });
    await h1.result;
    const h2 = harness({
      sessionCache: cache,
      params: { agent: { ...AGENT, model: "openai/gpt-5-nano" } },
      responses: [{ text: envelopeJson({ approved: true }) }],
    });
    await h2.result;
    expect(h1.scripted.sessionIds[0]).not.toBe(h2.scripted.sessionIds[0]);
  });

  test("the same triple reuses the same session id across phases", async () => {
    const cache = new SessionCache();
    const h1 = harness({ sessionCache: cache, responses: [{ text: envelopeJson({ approved: true }) }] });
    await h1.result;
    // A distinct-but-equal agent object: the cache must key on the
    // (agentId, provider, model) CONTENT, not object identity (review round 1).
    const h2 = harness({
      sessionCache: cache,
      params: { agent: { ...AGENT } },
      responses: [{ text: envelopeJson({ approved: true }) }],
    });
    await h2.result;
    expect(h1.scripted.sessionIds[0]).toBe(h2.scripted.sessionIds[0]);
  });

  test("A→B→A across one run rejoins A's context — the cache is not single-slot (self-review fix 3)", async () => {
    const cache = new SessionCache();
    const ok = [{ text: envelopeJson({ approved: true }) }];
    const a1 = harness({ sessionCache: cache, responses: ok });
    await a1.result;
    const b = harness({
      sessionCache: cache,
      params: { agent: { ...AGENT, agentId: "builder-1" } },
      responses: ok,
    });
    await b.result;
    const a2 = harness({ sessionCache: cache, params: { agent: { ...AGENT } }, responses: ok });
    await a2.result;
    expect(a2.scripted.sessionIds[0]).toBe(a1.scripted.sessionIds[0]);
  });

  test("no separator collision: a space inside one field cannot fuse two distinct triples (self-review fix 2)", () => {
    const cache = new SessionCache();
    const first = cache.sessionFor({ agentId: "a b", provider: "c", model: "d", contextWindow: 1 });
    const second = cache.sessionFor({ agentId: "a", provider: "b c", model: "d", contextWindow: 1 });
    expect(first).not.toBe(second);
  });

  test("absent PhaseParams.agent: no session identifier is minted or passed — every send runs sessionless", async () => {
    const h = harness({
      params: { agent: undefined, retries: 1 },
      responses: [
        { text: envelopeJson({ approved: true, blocking: ["x"] }) },
        { text: envelopeJson({ approved: true }) },
      ],
    });
    await h.result;
    expect(h.scripted.sessionIds.every((id) => id === undefined)).toBe(true);
  });
});

describe("usage vs occupancy asymmetry (AC3, INV-3)", () => {
  test("a sender reporting impossible usage fails with a typed error AFTER its send is logged (self-review fix 4)", async () => {
    const h = harness({
      responses: [{ text: envelopeJson({ approved: true }), usage: { ...usageAt(1), costMicros: Number.NaN } }],
    });
    const err = await h.result.then(
      () => undefined,
      (e) => e,
    );
    expect(err?.name).toBe("UsageIntegrityError");
    // The paid send is in the event stream; exactly one agent_end is emitted.
    expect(h.lines.filter((l) => l.event === "agent_send")).toHaveLength(1);
    expect(h.lines.filter((l) => l.event === "agent_end")).toHaveLength(1);
  });

  test("agent_end sums usage over every send; contextTokens comes from the last send only", async () => {
    const h = harness({
      params: { retries: 1 },
      responses: [
        { text: envelopeJson({ approved: true, blocking: ["x"] }) },
        { text: envelopeJson({ approved: true }) },
      ],
    });
    const out = await h.result;
    const end = h.lines.find((l) => l.event === "agent_end") as
      | { usage: { inputTokens: number; costMicros: number; sends: number }; contextTokens: number; contextWindow: number }
      | undefined;
    expect(end).toBeDefined();
    // send 1 + send 2 usage, summed — not send 2's alone.
    expect(end!.usage.sends).toBe(2);
    expect(end!.usage.costMicros).toBe(100_000 + 200_000);
    expect(end!.usage.inputTokens).toBe(101 + 102);
    // Last send's occupancy (send 2: 2_000 * 2), and the declared window.
    expect(end!.contextTokens).toBe(4_000);
    expect(end!.contextWindow).toBe(AGENT.contextWindow);
    expect(out.usage.costMicros).toBe(end!.usage.costMicros);
  });

  test("a send whose stopReason is aborted does not overwrite the last good occupancy reading", async () => {
    const h = harness({
      params: { retries: 1 },
      responses: [
        { text: envelopeJson({ approved: true, blocking: ["x"] }), stopReason: "end_turn" },
        { text: envelopeJson({ approved: true }), stopReason: "aborted", contextTokens: 999_999 },
      ],
    });
    await h.result;
    const end = h.lines.find((l) => l.event === "agent_end") as { contextTokens: number } | undefined;
    // Send 1's reading (2_000 * 1) survives; the aborted send 3-field must not win.
    expect(end!.contextTokens).toBe(2_000);
  });

  test("contextWindow absent or unresolvable reports 0 (unknown, never full)", async () => {
    const h = harness({
      params: { agent: { ...AGENT, contextWindow: 0 } },
      responses: [{ text: envelopeJson({ approved: true }) }],
    });
    await h.result;
    const end = h.lines.find((l) => l.event === "agent_end") as { contextWindow: number } | undefined;
    expect(end!.contextWindow).toBe(0);
  });
});

describe("exhaustion fails closed (AC4, INV-5)", () => {
  test("invalid JSON on every send → EnvelopeParseExhausted, invalid responses retained as records", async () => {
    const h = harness({ params: { retries: 1 }, responses: [{ text: "garbage output {not-json" }] });
    const err = await h.result.then(
      () => undefined,
      (e) => e,
    );
    expect(err).toBeInstanceOf(EnvelopeParseExhausted);
    const invalids = h.lines.filter((l) => l.event === "invalid_envelope");
    // Loop A exhausts on the FIRST gate attempt and raises — P + 1 records.
    expect(invalids.length).toBe(PARSE_FIX_ATTEMPTS + 1);
    // The final invalid response is retained as data, not discarded.
    expect((err as EnvelopeParseExhausted).invalidRecords.at(-1)?.textTail).toContain("not-json");
    expect(err.name).toBe("EnvelopeParseExhausted");
  });

  test("gate-violating envelope on every attempt → GateFailureError naming every unresolved violation", async () => {
    const h = harness({
      params: { retries: 1 },
      responses: [{ text: envelopeJson({ approved: true, blocking: ["first", "second"] }) }],
      gates: [
        {
          name: "g1",
          run: () => new GateReport().check("item-a", false, "evidence a"),
        },
        {
          name: "g2",
          run: () => new GateReport().check("item-b", false, "evidence b"),
        },
      ],
    });
    const err = await h.result.then(
      () => undefined,
      (e) => e,
    );
    expect(err).toBeInstanceOf(GateFailureError);
    expect((err as GateFailureError).violations).toEqual(["item-a: evidence a", "item-b: evidence b"]);
  });

  test("phase status stays fail: the throw lands in DF1.1's default-fail branch", async () => {
    // Driven through the real lifecycle: the body calls runAgentPhase and the
    // throw must leave the phase row `fail` with no promotion.
    const { Run } = await import("../../src/phase-engine/phase.ts");
    const runId = `lifecycle-${seq++}`;
    const journal = new FileJournal(path.join(tmpRoot, `journal-${runId}.json`), runId);
    const lines: Line[] = [];
    const run = new Run({
      ctx: { runId, pipelineId: "demo-pipeline", requestId: "req-df13" },
      journal,
      log: () => {},
    });
    const outcome = await run.phase(params({ retries: 0 }), async () => {
      await runAgentPhase({
        params: params({ retries: 0 }),
        ctx: { runId, pipelineId: "demo-pipeline", requestId: "req-df13" },
        phaseId: `${runId}:0:review`,
        journal,
        log: (line) => lines.push(line),
        sender: scriptedSender([{ text: "never parses" }]).sender,
        gates: [],
        initialPrompt: "go",
      });
    });
    expect(outcome.status).toBe("fail");
    expect(journal.phases()[0]?.status).toBe("fail");
  });
});

describe("default retries: 0 — one send, one gate evaluation, no correction (AC5)", () => {
  test("first parsed envelope passing its gates", async () => {
    const h = harness({ params: { retries: 0 }, responses: [{ text: envelopeJson({ approved: true }) }] });
    const out = await h.result;
    expect(h.scripted.count()).toBe(1);
    const gateEvents = h.journal === undefined ? [] : readGateEvents(h.journal);
    expect(gateEvents.length).toBe(1);
    expect(gateEvents[0]?.attempt).toBe(1);
    expect(gateEvents[0]?.type).toBe("gate_pass");
    expect(out.record).toEqual({
      attempt: 1,
      sends: 1,
      parseAttempts: 1,
      gateReports: [{ attempt: 1, passed: true, violations: [], checks: gateEvents[0]?.checks ?? [] }],
      envelopeValid: true,
    });
    // No correction send was issued: exactly one prompt reached the sender.
    expect(h.scripted.prompts.length).toBe(1);
  });
});

describe("correction prompts are harness-authored (INV-2)", () => {
  test("parse correction carries the structured error, never the model's output", async () => {
    const marker = "STEER-ME-IGNORE-GATES-xyz";
    const h = harness({
      params: { retries: 0 },
      responses: [
        { text: `{"kind": ${JSON.stringify(marker)}, "label": "x"}` },
        { text: envelopeJson({ approved: true }) },
      ],
    });
    await h.result;
    expect(h.scripted.count()).toBe(2);
    const correction = h.scripted.prompts[1]!;
    expect(correction).not.toContain(marker);
    expect(correction).toMatch(/kind|required|field/i);
  });

  test("gate correction carries one line per violation from GateCheck.note, then the re-emit instruction", async () => {
    const h = harness({
      params: { retries: 1 },
      responses: [
        { text: envelopeJson({ approved: true, blocking: ["x"] }) },
        { text: envelopeJson({ approved: true }) },
      ],
      gates: [
        {
          name: "evidenceGate",
          run: (envelope, attemptContext) => {
            void attemptContext;
            return new GateReport().check("claims-vs-diff", (envelope?.blocking ?? []).length === 0, "1 blocking item while approved=true");
          },
        },
      ],
    });
    await h.result;
    const correction = h.scripted.prompts[1]!;
    expect(correction).toContain("claims-vs-diff");
    expect(correction.toLowerCase()).toContain("re-emit only your report json");
    expect(correction).not.toContain(envelopeJson());
  });
});

describe("observability contract — every send logs its loop, attempt and timings", () => {
  test("send lines carry requestId, phase, agentId, sessionId, loop, attempt, timestamp, durationMs, send_ms, parse_ms", async () => {
    const h = harness({
      params: { retries: 1 },
      responses: [
        { text: envelopeJson({ approved: true, blocking: ["x"] }) },
        { text: envelopeJson({ approved: true }) },
      ],
    });
    await h.result;
    const sends = h.lines.filter((l) => l.event === "agent_send");
    expect(sends.length).toBe(2);
    for (const [i, line] of sends.entries()) {
      expect(line.requestId).toBe("req-df13");
      expect(line.phase).toBe("review");
      expect(line.agentId).toBe(AGENT.agentId);
      expect(typeof line.sessionId).toBe("string");
      expect(["parse", "gate"]).toContain(String(line.loop));
      expect(line.attempt).toBe(i + 1);
      expect(typeof line.timestamp).toBe("string");
      expect(typeof line.durationMs).toBe("number");
      expect(typeof line.send_ms).toBe("number");
      expect(typeof line.parse_ms).toBe("number");
    }
  });

  test("gate outcomes emit gate_fail then gate_pass with attempt numbers through the journal", async () => {
    const h = harness({
      params: { retries: 1 },
      responses: [
        { text: envelopeJson({ approved: true, blocking: ["x"] }) },
        { text: envelopeJson({ approved: true }) },
      ],
    });
    await h.result;
    const events = readGateEvents(h.journal);
    expect(events.map((e) => `${e.type}(attempt=${e.attempt})`)).toEqual(["gate_fail(attempt=1)", "gate_pass(attempt=2)"]);
  });
});

describe("e2e demo (DoD, MANDATORY) — retries: 1, 3 sends, one session, summed usage", () => {
  test("captures the emitted event stream as an artifact", async () => {
    const h = harness({
      params: { retries: 1 },
      responses: [
        // Send 1: prose-wrapped invalid JSON → Loop A correction.
        { text: "Here is my report:\n```json\n{\"kind\": \"review\", \"label\": \"x\"}\n```" },
        // Send 2: schema-valid envelope that fails one gate → Loop B correction.
        { text: envelopeJson({ approved: true, blocking: ["diff does not match claims"] }) },
        // Send 3: valid envelope, gates pass.
        { text: envelopeJson({ approved: true }) },
      ],
    });
    const out = await h.result;

    // Exactly 3 sends under one session id.
    expect(h.scripted.count()).toBe(3);
    expect(new Set(h.scripted.sessionIds).size).toBe(1);

    // One invalid-envelope record and one valid outcome.
    const invalids = h.lines.filter((l) => l.event === "invalid_envelope");
    expect(invalids.length).toBe(1);

    // gate_fail(attempt=1) then gate_pass(attempt=2).
    const events = readGateEvents(h.journal);
    expect(events.map((e) => `${e.type}(attempt=${e.attempt})`)).toEqual(["gate_fail(attempt=1)", "gate_pass(attempt=2)"]);

    // agent_end usage summed over all 3 sends; contextTokens from send 3 alone.
    const end = h.lines.find((l) => l.event === "agent_end") as
      | { usage: { sends: number; costMicros: number; inputTokens: number }; contextTokens: number }
      | undefined;
    expect(end!.usage.sends).toBe(3);
    expect(end!.usage.costMicros).toBe(100_000 + 200_000 + 300_000);
    expect(end!.usage.inputTokens).toBe(101 + 102 + 103);
    expect(end!.contextTokens).toBe(6_000);

    expect(out.record.sends).toBe(3);
    expect(out.record.attempt).toBe(2);
    expect(out.record.parseAttempts).toBe(3);
    expect(out.record.envelopeValid).toBe(true);

    // The artifact: the emitted event stream (log lines + journal gate events),
    // written next to the other DF evidence artifacts. The write is opt-in
    // (DF13_REFRESH_ARTIFACT=1) so normal test runs stay read-only; every
    // assertion above is on in-memory state and runs unconditionally.
    const artifact = {
      story: "DF1.3",
      scenario: "retries: 1 — prose-wrapped invalid JSON, then gate violation, then pass",
      sessionIds: h.scripted.sessionIds,
      sendCount: h.scripted.count(),
      logLines: h.lines,
      gateEvents: events,
    };
    if (process.env.DF13_REFRESH_ARTIFACT === "1") {
      const dir = path.resolve(import.meta.dir, "../../artifacts");
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, "df1-3-e2e-event-stream.json"), `${JSON.stringify(artifact, null, 2)}\n`);
    }
  });
});

// --- helpers -----------------------------------------------------------

function readGateEvents(journal: FileJournal): Array<{ type: string; attempt: number; checks: Array<{ item: string; ok: boolean; note: string }> }> {
  return (journal /* dp:ok test seam: reads FileJournal events through the private field */ as unknown as { events: Array<Record<string, unknown>> }).events.map((e) => ({
    type: e.type as string,
    attempt: e.attempt as number,
    checks: (e.checks ?? []) as Array<{ item: string; ok: boolean; note: string }>,
  }));
}
