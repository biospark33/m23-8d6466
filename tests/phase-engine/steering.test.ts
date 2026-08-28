/**
 * Engine-owned steering port tests (Story DF3.3, cluster C1).
 *
 * The resident's only egress into the engine is one validated directive
 * returned from an engine-initiated call (INV-RES-1) — so these tests drive
 * `createSteering` with a scripted in-file `ResidentCaller` (house ruling:
 * fakes live in the test file) and assert the port's fail-closed contract:
 *
 * - closed `.strict()` union: unknown actions/fields are REJECTIONS with a
 *   `gate_bypass_attempt` tripwire naming the attempt, never executed (AC2);
 * - unreachable / timeout / two consecutive malformed replies degrade to the
 *   deterministic default with no third call (AC3, R3 fail-closed);
 * - spend is metered engine-side in integer µ$ from usage × rate (DD-9);
 * - the solicitation prompt is capped at PROMPT_CHAR_CEILING chars INCLUDING
 *   its truncation suffix, suffix reserved before cutting;
 * - `directives` is a COUNT, `steeringIterations` counts per phase.
 */
import { describe, expect, test } from "bun:test";
import { join } from "node:path";

import {
  MAX_MALFORMED_ATTEMPTS,
  MAX_OUTPUT_TOKENS,
  PROMPT_CHAR_CEILING,
  SteeringDirectiveSchema,
  createSteering,
  type ResidentCaller,
  type ResidentTripwire,
  type SolicitCtx,
} from "../../src/phase-engine/steering.ts";
// The fleet reaches the port only through the engine barrel (INV-RES-1 module
// boundary) — assert the barrel re-exports the same factory, not a copy.
import { createSteering as createSteeringFromBarrel } from "../../src/phase-engine/index.ts";

const RATE = { inputPerMTok: 100_000, outputPerMTok: 180_000 };

/** One scripted caller step: a raw reply, or a throw (timeout/unreachable). */
interface Step {
  raw?: string;
  usage?: { inputTokens: number; outputTokens: number };
  error?: Error;
}

function scriptedCaller(steps: Step[]) {
  const prompts: string[] = [];
  let calls = 0;
  const caller: ResidentCaller = {
    async call(prompt: string) {
      prompts.push(prompt);
      const step = steps[Math.min(calls, steps.length - 1)]!;
      calls += 1;
      if (step.error !== undefined) throw step.error;
      return {
        raw: step.raw ?? '{"action":"proceed"}',
        usage: step.usage ?? { inputTokens: 0, outputTokens: 0 },
      };
    },
  };
  return { caller, prompts, calls: () => calls };
}

function ctx(over: Partial<SolicitCtx> = {}): SolicitCtx {
  return { runId: "run-1", requestId: "req-1", promptContext: ["brief: fix the assertion"], ...over };
}

const PROCEED = { action: "proceed" } as const;

describe("SteeringDirectiveSchema — closed union (AC2 contract)", () => {
  test("accepts all four actions, note optional", () => {
    expect(SteeringDirectiveSchema.safeParse({ action: "proceed" }).success).toBe(true);
    expect(SteeringDirectiveSchema.safeParse({ action: "proceed", note: "n" }).success).toBe(true);
    expect(SteeringDirectiveSchema.safeParse({ action: "retry", guidance: "g" }).success).toBe(true);
    expect(
      SteeringDirectiveSchema.safeParse({ action: "select_roster", phase: "build", rosterId: "r1" }).success,
    ).toBe(true);
    expect(SteeringDirectiveSchema.safeParse({ action: "abort", reason: "r" }).success).toBe(true);
  });

  test("rejects unknown actions and unknown fields (.strict())", () => {
    for (const action of ["skip_gate", "reorder_phases", "set_status", "extend_budget", "proceed!"]) {
      expect(SteeringDirectiveSchema.safeParse({ action }).success).toBe(false);
    }
    expect(SteeringDirectiveSchema.safeParse({ action: "proceed", evil: true }).success).toBe(false);
    expect(SteeringDirectiveSchema.safeParse("not an object").success).toBe(false);
  });

  test("known actions with a missing or wrong-typed required field are REJECTED (AC1 verb contract, A13)", () => {
    expect(SteeringDirectiveSchema.safeParse({ action: "retry" }).success).toBe(false); // no guidance
    expect(SteeringDirectiveSchema.safeParse({ action: "select_roster" }).success).toBe(false); // no rosterId
    expect(SteeringDirectiveSchema.safeParse({ action: "abort" }).success).toBe(false); // no reason
    expect(SteeringDirectiveSchema.safeParse({ action: "retry", guidance: 42 }).success).toBe(false); // wrong type
  });

  test("the derived action list and the schema literals cannot drift (A8)", () => {
    // Mirror the instruction text's four members; any schema change that
    // drops or renames one must update this list (and DIRECTIVE_INSTRUCTION)
    // in the same commit.
    expect(SteeringDirectiveSchema.options.map((m) => m.shape.action.value)).toEqual([
      "proceed",
      "retry",
      "select_roster",
      "abort",
    ]);
  });
});

describe("solicit — accepted directives", () => {
  test("proceed is resolved and counted; exitStatus starts null (DF3.6/C3 own it)", async () => {
    const s = scriptedCaller([{ raw: '{"action":"proceed"}' }]);
    const c = createSteering({ caller: s.caller, rate: RATE });
    const d = await c.solicit("run_start", ctx());
    expect(d).toEqual(PROCEED);
    expect(c.telemetry.status).toBe("active");
    expect(c.telemetry.directives).toBe(1);
    expect(c.telemetry.directivesRejected).toBe(0);
    expect(c.telemetry.exitStatus).toBeNull();
  });

  test("retry increments steeringIterations[phase] only when phase is set", async () => {
    const withPhase = createSteering({
      caller: scriptedCaller([{ raw: '{"action":"retry","guidance":"compare bytes"}' }]).caller,
      rate: RATE,
    });
    await withPhase.solicit("post_gate_failure", ctx({ phase: "build" }));
    expect(withPhase.telemetry.steeringIterations).toEqual({ build: 1 });

    const noPhase = createSteering({
      caller: scriptedCaller([{ raw: '{"action":"retry","guidance":"g"}' }]).caller,
      rate: RATE,
    });
    await noPhase.solicit("post_gate_failure", ctx());
    expect(noPhase.telemetry.steeringIterations).toEqual({});
  });

  test("a retry accepted at run_start counts in directives but NOT steeringIterations (S1-6 point gating)", async () => {
    // Only post_gate_failure retries steer an executable phase attempt — a
    // run_start/run_end retry must not inflate the per-phase counter (AC5).
    const s = scriptedCaller([{ raw: '{"action":"retry","guidance":"g"}' }]);
    const c = createSteering({ caller: s.caller, rate: RATE });
    const d = await c.solicit("run_start", ctx({ phase: "build" }));
    expect(d).toEqual({ action: "retry", guidance: "g" });
    expect(c.telemetry.directives).toBe(1);
    expect(c.telemetry.steeringIterations).toEqual({});
  });

  test("select_roster with an id inside the closed set is accepted", async () => {
    const s = scriptedCaller([{ raw: '{"action":"select_roster","phase":"build","rosterId":"r2"}' }]);
    const c = createSteering({ caller: s.caller, rate: RATE });
    const d = await c.solicit("run_start", ctx({ rosterIds: ["r1", "r2"], phaseIds: ["build"] }));
    expect(d).toEqual({ action: "select_roster", phase: "build", rosterId: "r2" });
    expect(c.telemetry.directives).toBe(1);
  });

  test("abort is resolved as-is — steering parses and records, never acts (C3 owns the fail transition)", async () => {
    const s = scriptedCaller([{ raw: '{"action":"abort","reason":"off track"}' }]);
    const c = createSteering({ caller: s.caller, rate: RATE });
    const d = await c.solicit("run_start", ctx());
    expect(d).toEqual({ action: "abort", reason: "off track" });
  });

  test("directives is a COUNT of accepted directives, not an array", async () => {
    const s = scriptedCaller([{ raw: '{"action":"proceed"}' }]);
    const c = createSteering({ caller: s.caller, rate: RATE });
    await c.solicit("run_start", ctx());
    await c.solicit("post_gate_failure", ctx({ phase: "build" }));
    await c.solicit("run_end", ctx());
    expect(c.telemetry.directives).toBe(3);
    expect(Number.isInteger(c.telemetry.directives)).toBe(true);
    expect(Array.isArray(c.telemetry.directives)).toBe(false);
  });
});

describe("AC2 — schema rejections record a gate_bypass_attempt tripwire, default proceed", () => {
  for (const action of ["skip_gate", "reorder_phases", "set_status", "extend_budget"]) {
    test(`unknown action "${action}" → tripwire naming it, single attempt, default proceed`, async () => {
      const s = scriptedCaller([{ raw: JSON.stringify({ action }) }]);
      const tripwires: ResidentTripwire[] = [];
      const c = createSteering({ caller: s.caller, rate: RATE, onTripwire: (t) => tripwires.push(t) });
      const d = await c.solicit("run_start", ctx({ phase: "build" }));
      expect(d).toEqual(PROCEED);
      expect(s.calls()).toBe(1); // single attempt — no reparse for schema rejections
      expect(c.telemetry.status).toBe("active"); // a rejection is not degradation
      expect(c.telemetry.directives).toBe(0);
      expect(c.telemetry.directivesRejected).toBe(1);
      expect(c.telemetry.tripwires).toHaveLength(1);
      expect(c.telemetry.tripwires[0]).toMatchObject({
        runId: "run-1",
        requestId: "req-1",
        phase: "build",
        cause: "gate_bypass_attempt",
      });
      expect(c.telemetry.tripwires[0]!.detail).toContain(action);
      expect(tripwires).toEqual(c.telemetry.tripwires); // onTripwire emits the same row
    });
  }

  test("unknown field on a known action → tripwire naming the field issue", async () => {
    const s = scriptedCaller([{ raw: '{"action":"proceed","evil":true}' }]);
    const c = createSteering({ caller: s.caller, rate: RATE });
    await c.solicit("run_start", ctx());
    expect(c.telemetry.directivesRejected).toBe(1);
    expect(c.telemetry.tripwires[0]!.cause).toBe("gate_bypass_attempt");
    // S1-7: the detail names the KNOWN action, then the issue.
    expect(c.telemetry.tripwires[0]!.detail).toContain("action proceed rejected:");
    expect(c.telemetry.tripwires[0]!.detail).toContain("evil");
  });

  test("select_roster outside the closed set is a rejected directive, not a spawn", async () => {
    const s = scriptedCaller([{ raw: '{"action":"select_roster","phase":"build","rosterId":"nope"}' }]);
    const c = createSteering({ caller: s.caller, rate: RATE });
    const d = await c.solicit("run_start", ctx({ rosterIds: ["r1"] }));
    expect(d).toEqual(PROCEED);
    expect(c.telemetry.directivesRejected).toBe(1);
    expect(c.telemetry.tripwires[0]!.detail).toContain("nope");
    expect(s.calls()).toBe(1); // single attempt — roster rejection never reparses
  });

  test("select_roster with rosterIds ABSENT is rejected — missing set reads as empty (fail-closed)", async () => {
    const s = scriptedCaller([{ raw: '{"action":"select_roster","phase":"build","rosterId":"r1"}' }]);
    const c = createSteering({ caller: s.caller, rate: RATE });
    const d = await c.solicit("run_start", ctx());
    expect(d).toEqual(PROCEED);
    expect(c.telemetry.status).toBe("active");
    expect(c.telemetry.directives).toBe(0);
    expect(c.telemetry.directivesRejected).toBe(1);
    expect(c.telemetry.tripwires[0]!.detail).toContain("outside closed roster set");
  });

  test("select_roster naming a phase outside ctx.phaseIds is rejected (S1-5 fail-closed)", async () => {
    const s = scriptedCaller([{ raw: '{"action":"select_roster","phase":"deploy","rosterId":"r1"}' }]);
    const c = createSteering({ caller: s.caller, rate: RATE });
    const d = await c.solicit("run_start", ctx({ rosterIds: ["r1"], phaseIds: ["build"] }));
    expect(d).toEqual(PROCEED);
    expect(c.telemetry.status).toBe("active");
    expect(c.telemetry.directives).toBe(0);
    expect(c.telemetry.directivesRejected).toBe(1);
    expect(c.telemetry.tripwires[0]!.detail).toContain("phase outside closed phase set: deploy");
  });

  test("select_roster with phaseIds ABSENT is rejected — missing set reads as empty (S1-5)", async () => {
    // rosterId is inside the closed set, so the phase guard is what fires.
    const s = scriptedCaller([{ raw: '{"action":"select_roster","phase":"build","rosterId":"r1"}' }]);
    const c = createSteering({ caller: s.caller, rate: RATE });
    const d = await c.solicit("run_start", ctx({ rosterIds: ["r1"] }));
    expect(d).toEqual(PROCEED);
    expect(c.telemetry.directivesRejected).toBe(1);
    expect(c.telemetry.tripwires[0]!.detail).toContain("phase outside closed phase set: build");
  });

  test("a throwing onTripwire observer never breaks the never-throws contract", async () => {
    const s = scriptedCaller([{ raw: '{"action":"skip_gate"}' }]);
    const c = createSteering({
      caller: s.caller,
      rate: RATE,
      onTripwire: () => {
        throw new Error("trace store exploded");
      },
    });
    const d = await c.solicit("run_start", ctx({ phase: "build" }));
    expect(d).toEqual(PROCEED);
    expect(c.telemetry.directivesRejected).toBe(1);
    expect(c.telemetry.tripwires).toHaveLength(1); // the journal row survived
  });
});

describe("AC3 — fail-closed degradation", () => {
  test("unreachable caller (ENOENT throw) → degraded, default proceed, no call retry", async () => {
    const s = scriptedCaller([{ error: new Error("spawn ENOENT") }]);
    const c = createSteering({ caller: s.caller, rate: RATE });
    const d = await c.solicit("run_start", ctx());
    expect(d).toEqual(PROCEED);
    expect(c.telemetry.status).toBe("degraded");
    expect(s.calls()).toBe(1);
  });

  test("timeout throw → degraded, default proceed", async () => {
    const s = scriptedCaller([{ error: new Error("timed out after 60000ms") }]);
    const c = createSteering({ caller: s.caller, rate: RATE });
    const d = await c.solicit("post_gate_failure", ctx({ phase: "build" }));
    expect(d).toEqual(PROCEED);
    expect(c.telemetry.status).toBe("degraded");
  });

  test("two consecutive malformed replies → degraded, exactly MAX_MALFORMED_ATTEMPTS calls, never a third", async () => {
    const s = scriptedCaller([{ raw: "I will steer this run now" }, { raw: "still not json" }]);
    const c = createSteering({ caller: s.caller, rate: RATE });
    const d = await c.solicit("run_start", ctx());
    expect(d).toEqual(PROCEED);
    expect(c.telemetry.status).toBe("degraded");
    expect(s.calls()).toBe(MAX_MALFORMED_ATTEMPTS);
    // Degradation is sticky: the next solicitation point makes no third call.
    const again = await c.solicit("run_end", ctx());
    expect(again).toEqual(PROCEED);
    expect(s.calls()).toBe(MAX_MALFORMED_ATTEMPTS); // unchanged — never N+1
  });

  test("malformed once, then a valid directive on the correction attempt → accepted", async () => {
    const s = scriptedCaller([{ raw: "garbage preamble" }, { raw: '{"action":"retry","guidance":"bytes"}' }]);
    const c = createSteering({ caller: s.caller, rate: RATE });
    const d = await c.solicit("post_gate_failure", ctx({ phase: "build" }));
    expect(d).toEqual({ action: "retry", guidance: "bytes" });
    expect(c.telemetry.status).toBe("active");
    expect(c.telemetry.directives).toBe(1);
    expect(s.calls()).toBe(2);
  });

  test("correction prompt names the parse failure and never echoes the model's raw text (INV-2)", async () => {
    const s = scriptedCaller([{ raw: "I will steer this run now" }, { raw: '{"action":"proceed"}' }]);
    const c = createSteering({ caller: s.caller, rate: RATE });
    await c.solicit("run_start", ctx());
    expect(s.prompts[1]!).toContain("no JSON object was found");
    expect(s.prompts[1]!).not.toContain("I will steer this run now");
  });

  test("correction prompt restates the closed union so a stateless second attempt is not blind (A6)", async () => {
    const s = scriptedCaller([{ raw: "garbage preamble" }, { raw: '{"action":"proceed"}' }]);
    const c = createSteering({ caller: s.caller, rate: RATE });
    await c.solicit("run_start", ctx());
    expect(s.prompts[1]!).toContain('{"action":"proceed"}');
    expect(s.prompts[1]!).toContain('{"action":"retry","guidance":string}');
    expect(s.prompts[1]!).toContain('{"action":"abort","reason":string}');
  });

  test("a throwing reply parser is a malformed reply, counted toward the limit (never throws)", async () => {
    // The scripted Step shape cannot express a throwing extractor, so the
    // caller itself returns a raw that throws on read (A4's callee-throw route).
    let calls = 0;
    const throwing = createSteering({
      caller: {
        call: async () => {
          calls += 1;
          return {
            get raw(): string {
              throw new Error("extractor blew up");
            },
            usage: { inputTokens: 0, outputTokens: 0 },
          };
        },
      },
      rate: RATE,
    });
    const d = await throwing.solicit("run_start", ctx());
    expect(d).toEqual(PROCEED);
    expect(throwing.telemetry.status).toBe("degraded"); // malformed × 2 → limit
    expect(calls).toBe(MAX_MALFORMED_ATTEMPTS);
  });

  test("malformed-counter is per-solicit: recover in one, next malformed still gets its correction (A11)", async () => {
    const s = scriptedCaller([
      { raw: "garbage preamble" },
      { raw: '{"action":"proceed"}' }, // solicit 1 recovers on the correction attempt
      { raw: "garbage again" },
      { raw: '{"action":"proceed"}' }, // solicit 2 ALSO gets a correction attempt
    ]);
    const c = createSteering({ caller: s.caller, rate: RATE });
    await c.solicit("run_start", ctx());
    await c.solicit("run_end", ctx());
    expect(c.telemetry.status).toBe("active");
    expect(c.telemetry.directives).toBe(2);
    expect(s.calls()).toBe(4);
  });

  test("two consecutive accepted retries in one phase increment, not overwrite (A12)", async () => {
    const s = scriptedCaller([
      { raw: '{"action":"retry","guidance":"first"}' },
      { raw: '{"action":"retry","guidance":"second"}' },
    ]);
    const c = createSteering({ caller: s.caller, rate: RATE });
    await c.solicit("post_gate_failure", ctx({ phase: "build" }));
    await c.solicit("post_gate_failure", ctx({ phase: "build" }));
    expect(c.telemetry.steeringIterations).toEqual({ build: 2 });
  });

  test("lastDegradationReason is set by degradation paths, sanitized, and never journaled as telemetry", async () => {
    const failing = createSteering({ caller: scriptedCaller([{ error: new Error("spawn ENOENT\n") }]).caller, rate: RATE });
    expect(failing.lastDegradationReason).toBeNull();
    await failing.solicit("run_start", ctx());
    expect(failing.lastDegradationReason).toBe("spawn ENOENT\\n");
    expect(failing.telemetry).not.toHaveProperty("lastDegradationReason");
  });
});

describe("metering — engine-side integer µ$ (DD-9)", () => {
  test("accepted reply meters usage × rate ÷ 1e6, rounded, integer", async () => {
    const s = scriptedCaller([{
      raw: '{"action":"proceed"}',
      usage: { inputTokens: 1_500_000, outputTokens: 500_000 },
    }]);
    const c = createSteering({ caller: s.caller, rate: RATE });
    await c.solicit("run_start", ctx());
    // round(1.5e6·100000/1e6)=150000 + round(0.5e6·180000/1e6)=90000
    expect(c.telemetry.spendMicros).toBe(240_000);
    expect(Number.isInteger(c.telemetry.spendMicros)).toBe(true);
  });

  test("fractional products round to integers, never floats", async () => {
    const s = scriptedCaller([{
      raw: '{"action":"proceed"}',
      usage: { inputTokens: 1_111, outputTokens: 0 },
    }]);
    const c = createSteering({ caller: s.caller, rate: { inputPerMTok: 100_000, outputPerMTok: 180_000 } });
    await c.solicit("run_start", ctx());
    expect(c.telemetry.spendMicros).toBe(111); // 111.1 rounds to 111
    expect(Number.isInteger(c.telemetry.spendMicros)).toBe(true);
  });

  test("rejected and malformed replies are metered too — every reply pays", async () => {
    const s = scriptedCaller([
      { raw: '{"action":"skip_gate"}', usage: { inputTokens: 100, outputTokens: 100 } },
      { raw: "not json", usage: { inputTokens: 100, outputTokens: 100 } },
      { raw: "still not json", usage: { inputTokens: 100, outputTokens: 100 } },
    ]);
    const c = createSteering({ caller: s.caller, rate: RATE });
    await c.solicit("run_start", ctx()); // schema rejection: reply 1
    await c.solicit("run_end", ctx()); // malformed × 2: replies 2 and 3
    // per reply: round(100·100000/1e6)=10 + round(100·180000/1e6)=18 → 28 × 3
    expect(c.telemetry.spendMicros).toBe(84);
  });

  test("exactly-.5 product rounds half-up (A9): 1115 tokens × 100000 / 1e6 = 111.5 → 112", async () => {
    const s = scriptedCaller([{
      raw: '{"action":"proceed"}',
      usage: { inputTokens: 1_115, outputTokens: 0 },
    }]);
    const c = createSteering({ caller: s.caller, rate: { inputPerMTok: 100_000, outputPerMTok: 180_000 } });
    await c.solicit("run_start", ctx());
    expect(c.telemetry.spendMicros).toBe(112);
  });

  test("a malformed correction attempt meters BOTH replies (A14)", async () => {
    const s = scriptedCaller([
      { raw: "garbage", usage: { inputTokens: 100, outputTokens: 100 } }, // 28
      { raw: '{"action":"proceed"}', usage: { inputTokens: 100, outputTokens: 100 } }, // 28
    ]);
    const c = createSteering({ caller: s.caller, rate: RATE });
    await c.solicit("run_start", ctx());
    expect(c.telemetry.spendMicros).toBe(56);
    expect(s.calls()).toBe(2);
  });

  test("non-finite and negative token counts clamp to 0 — spendMicros stays a finite integer (A2)", async () => {
    const s = scriptedCaller([
      { raw: '{"action":"proceed"}', usage: { inputTokens: Number.NaN, outputTokens: 0 } },
      { raw: '{"action":"proceed"}', usage: { inputTokens: -500, outputTokens: Number.POSITIVE_INFINITY } },
      { raw: '{"action":"proceed"}', usage: { inputTokens: 1_111, outputTokens: 0 } }, // 111.1 → 111
    ]);
    const c = createSteering({ caller: s.caller, rate: RATE });
    await c.solicit("run_start", ctx());
    await c.solicit("run_end", ctx());
    await c.solicit("post_gate_failure", ctx());
    expect(Number.isInteger(c.telemetry.spendMicros)).toBe(true);
    expect(Number.isFinite(c.telemetry.spendMicros)).toBe(true);
    expect(c.telemetry.spendMicros).toBe(111);
  });
});

describe("prompt ceiling — ≤ PROMPT_CHAR_CEILING including truncation suffix", () => {
  test("20k-char context → prompt ≤ 16000 with suffix reserved pre-cut, instruction intact", async () => {
    const s = scriptedCaller([{ raw: '{"action":"proceed"}' }]);
    const c = createSteering({ caller: s.caller, rate: RATE });
    await c.solicit("run_start", ctx({ promptContext: ["x".repeat(20_000)] }));
    const prompt = s.prompts[0]!;
    expect(prompt.length).toBeLessThanOrEqual(PROMPT_CHAR_CEILING);
    // The suffix names the ORIGINAL length and sits inside the cap — an
    // append-after-cut implementation would exceed PROMPT_CHAR_CEILING.
    expect(prompt).toContain("[truncated, 20000 chars total]");
    // The instruction carrying the closed union survives the cut.
    expect(prompt).toContain("ONE JSON object");
    expect(prompt).toContain(String(MAX_OUTPUT_TOKENS));
  });

  test("over-ceiling context is cut OLDEST-first — the newest line survives (A7)", async () => {
    const s = scriptedCaller([{ raw: '{"action":"proceed"}' }]);
    const c = createSteering({ caller: s.caller, rate: RATE });
    // Oldest line first; the accepted guidance line is pushed LAST.
    await c.solicit("run_start", ctx({ promptContext: ["oldest".repeat(4_000), "newest-accepted-guidance"] }));
    const prompt = s.prompts[0]!;
    expect(prompt.length).toBeLessThanOrEqual(PROMPT_CHAR_CEILING);
    expect(prompt).not.toContain("oldest".repeat(4_000)); // head was cut
    expect(prompt).toContain("newest-accepted-guidance"); // tail survived
    // The suffix names the whole context (two lines + joiner), not just the
    // survivor — proof the cut really happened at the head.
    expect(prompt).toContain(`[truncated, ${`${"oldest".repeat(4_000)}\nnewest-accepted-guidance`.length} chars total]`);
  });

  test("short context passes through uncut, lines joined", async () => {
    const s = scriptedCaller([{ raw: '{"action":"proceed"}' }]);
    const c = createSteering({ caller: s.caller, rate: RATE });
    await c.solicit("run_start", ctx({ promptContext: ["line one", "line two"] }));
    const prompt = s.prompts[0]!;
    expect(prompt.length).toBeLessThanOrEqual(PROMPT_CHAR_CEILING);
    expect(prompt).toContain("line one\nline two");
    expect(prompt).not.toContain("[truncated");
  });

  // Boundary pins below measure the context budget by PROBING a short prompt
  // (prompt = header + context + joiner + instruction) instead of mirroring
  // source constants, so header/instruction drift cannot silently move them.
  async function promptForContext(context: string): Promise<string> {
    const s = scriptedCaller([{ raw: '{"action":"proceed"}' }]);
    const c = createSteering({ caller: s.caller, rate: RATE });
    await c.solicit("run_start", ctx({ promptContext: [context] }));
    return s.prompts[0]!;
  }

  async function contextBudget(): Promise<number> {
    const probe = "PROBE";
    const prompt = await promptForContext(probe);
    // reserve = header + joiner + instruction = prompt.length - context.length
    return PROMPT_CHAR_CEILING - (prompt.length - probe.length);
  }

  test("context at exactly the budget is NOT cut — the prompt is exactly the ceiling", async () => {
    const budget = await contextBudget();
    const prompt = await promptForContext("x".repeat(budget));
    expect(prompt.length).toBe(PROMPT_CHAR_CEILING); // whole-prompt length 16 000
    expect(prompt).not.toContain("[truncated");
  });

  test("context at budget - 1 → whole prompt 15 999, uncut", async () => {
    const budget = await contextBudget();
    const prompt = await promptForContext("x".repeat(budget - 1));
    expect(prompt.length).toBe(PROMPT_CHAR_CEILING - 1);
    expect(prompt).not.toContain("[truncated");
  });

  test("context at budget + 1 (a 16 001-char candidate) is cut to exactly the ceiling", async () => {
    const budget = await contextBudget();
    const prompt = await promptForContext("x".repeat(budget + 1));
    // suffix + proseBudget fills the budget exactly (no surrogate adjustment
    // on an all-BMP context), so the clamped prompt lands on the ceiling.
    expect(prompt.length).toBe(PROMPT_CHAR_CEILING);
    expect(prompt).toContain(`[truncated, ${budget + 1} chars total]`);
    expect(prompt).toContain("ONE JSON object"); // instruction survives
  });

  test("an astral character straddling the cut point is dropped whole — no lone surrogate", async () => {
    const budget = await contextBudget();
    const total = budget + 1;
    const suffix = `[truncated, ${total} chars total]`;
    const proseBudget = budget - suffix.length;
    // cutPoint = total - proseBudget; place the astral pair so cutPoint lands
    // on its LOW surrogate: pair at [head, head+1], cutPoint = head + 1.
    const head = total - proseBudget - 1;
    const context = `${"A".repeat(head)}😀${"z".repeat(total - head - 2)}`;
    expect(context.length).toBe(total);
    const prompt = await promptForContext(context);
    // The surrogate-safe loop advanced past the pair: it is cut WHOLE, so the
    // prompt contains zero surrogate code units (a lone half would match).
    expect(/[\uD800-\uDFFF]/.test(prompt)).toBe(false);
    expect(prompt).not.toContain("😀");
    // The suffix survives intact at the cut boundary, followed by the z-tail.
    expect(prompt).toContain(`${suffix}zzzz`);
    expect(prompt.length).toBeLessThanOrEqual(PROMPT_CHAR_CEILING);
  });
});

describe("barrel wiring (INV-RES-1 module boundary)", () => {
  test("src/phase-engine/index.ts re-exports the same createSteering", () => {
    expect(createSteeringFromBarrel).toBe(createSteering);
  });
});

describe("fixtures/fake-resident.ts — pi-emulating fixture smoke", () => {
  test("replies scripted JSON as --mode json NDJSON with message_end usage", async () => {
    const fixture = join(import.meta.dir, "fixtures/fake-resident.ts");
    const proc = Bun.spawn([process.execPath, fixture, "-p", "steer"], {
      env: {
        ...process.env,
        FAKE_RESIDENT_REPLIES: JSON.stringify(['{"action":"proceed"}']),
        FAKE_RESIDENT_USAGE: JSON.stringify({ input: 1200, output: 30 }),
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, exitCode] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
    expect(exitCode).toBe(0);
    const events = stdout.trim().split("\n").map((l) => JSON.parse(l) as { type: string });
    expect(events.map((e) => e.type)).toContain("message_end");
    expect(stdout).toContain('"text":"{\\"action\\":\\"proceed\\"}"');
    expect(stdout).toContain('"input":1200');
  });
});
