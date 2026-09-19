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
 * - a per-point allowlist rejects schema-valid directives that have nothing
 *   to steer at the solicited point (run_end is proceed-only), BEFORE
 *   `telemetry.directives` can count them;
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
  ATTACH_FOLD_CHAR_BUDGET,
  ATTACH_FOLD_MIN_BODY_CHARS,
  ATTACH_MESSAGE_CHAR_CEILING,
  DIRECTIVE_ID_CHAR_CEILING,
  DIRECTIVE_TEXT_CHAR_CEILING,
  INBOX_CALL_TIMEOUT_MS,
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

  test("free-text fields carry a length ceiling — at-ceiling passes, +1 fails closed (S1-3)", () => {
    // Accepted guidance rides promptContext for the run's lifetime, so a
    // directive string is bounded well under PROMPT_CHAR_CEILING.
    const atCeiling = "x".repeat(DIRECTIVE_TEXT_CHAR_CEILING);
    const overCeiling = "x".repeat(DIRECTIVE_TEXT_CHAR_CEILING + 1);
    expect(SteeringDirectiveSchema.safeParse({ action: "retry", guidance: atCeiling }).success).toBe(true);
    expect(SteeringDirectiveSchema.safeParse({ action: "retry", guidance: overCeiling }).success).toBe(false);
    expect(SteeringDirectiveSchema.safeParse({ action: "abort", reason: overCeiling }).success).toBe(false);
    expect(SteeringDirectiveSchema.safeParse({ action: "proceed", note: overCeiling }).success).toBe(false);
    // Ids are harness-minted slugs — a 4k-char rosterId is a probe, not a pick.
    expect(
      SteeringDirectiveSchema.safeParse({ action: "select_roster", phase: "build", rosterId: "r".repeat(257) }).success,
    ).toBe(false);
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

  test("a retry at run_start is OFF-POINT — rejected before telemetry.directives counts it (S1-1 point allowlist)", async () => {
    // Only post_gate_failure retries steer an executable phase attempt; at
    // run_start there is no phase attempt a retry could steer, so the reply
    // takes the reject() path — counted rejected, tripwire-recorded.
    const s = scriptedCaller([{ raw: '{"action":"retry","guidance":"g"}' }]);
    const c = createSteering({ caller: s.caller, rate: RATE });
    const d = await c.solicit("run_start", ctx({ phase: "build" }));
    expect(d).toEqual(PROCEED);
    expect(c.telemetry.directives).toBe(0);
    expect(c.telemetry.directivesRejected).toBe(1);
    expect(c.telemetry.steeringIterations).toEqual({});
    expect(c.telemetry.tripwires[0]!.cause).toBe("gate_bypass_attempt");
    expect(c.telemetry.tripwires[0]!.detail).toContain("run_start");
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

describe("S1-1 — per-point allowlist: off-point directives are rejected, never counted", () => {
  test("run_end is proceed-only: retry / select_roster / abort are off-point rejections", async () => {
    // The run is settled by the run_end solicitation — no phase attempt,
    // roster decision, or fail transition is pending for these to steer.
    for (const raw of [
      '{"action":"retry","guidance":"g"}',
      '{"action":"select_roster","phase":"build","rosterId":"r1"}',
      '{"action":"abort","reason":"r"}',
    ]) {
      const s = scriptedCaller([{ raw }]);
      const c = createSteering({ caller: s.caller, rate: RATE });
      // Closed id sets deliberately PRESENT: the allowlist fires before the
      // closed-set checks, so this cannot pass as a closed-set rejection.
      const d = await c.solicit("run_end", ctx({ phase: "build", rosterIds: ["r1"], phaseIds: ["build"] }));
      expect(d).toEqual(PROCEED);
      expect(c.telemetry.directives).toBe(0);
      expect(c.telemetry.directivesRejected).toBe(1);
      expect(c.telemetry.tripwires[0]!.cause).toBe("gate_bypass_attempt");
      expect(c.telemetry.tripwires[0]!.detail).toContain("run_end");
    }
  });

  test("select_roster at post_gate_failure is off-point even with the closed sets present", async () => {
    // No roster decision is pending mid-phase; previously this relied on the
    // runner omitting rosterIds (empty-set rejection). Now structural.
    const s = scriptedCaller([{ raw: '{"action":"select_roster","phase":"build","rosterId":"r1"}' }]);
    const c = createSteering({ caller: s.caller, rate: RATE });
    const d = await c.solicit("post_gate_failure", ctx({ phase: "build", rosterIds: ["r1"], phaseIds: ["build"] }));
    expect(d).toEqual(PROCEED);
    expect(c.telemetry.directives).toBe(0);
    expect(c.telemetry.directivesRejected).toBe(1);
    expect(c.telemetry.tripwires[0]!.detail).toContain("post_gate_failure");
  });

  test("on-point directives still pass: abort at post_gate_failure, select_roster at run_start", async () => {
    const aborting = createSteering({
      caller: scriptedCaller([{ raw: '{"action":"abort","reason":"decline the retry"}' }]).caller,
      rate: RATE,
    });
    const dAbort = await aborting.solicit("post_gate_failure", ctx({ phase: "build" }));
    expect(dAbort).toEqual({ action: "abort", reason: "decline the retry" });
    expect(aborting.telemetry.directives).toBe(1);

    const picking = createSteering({
      caller: scriptedCaller([{ raw: '{"action":"select_roster","phase":"build","rosterId":"r1"}' }]).caller,
      rate: RATE,
    });
    const dPick = await picking.solicit("run_start", ctx({ rosterIds: ["r1"], phaseIds: ["build"] }));
    expect(dPick).toEqual({ action: "select_roster", phase: "build", rosterId: "r1" });
    expect(picking.telemetry.directives).toBe(1);
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

  test("an over-ceiling free-text field is a schema rejection, counted rejected (S1-3)", async () => {
    const s = scriptedCaller([
      { raw: JSON.stringify({ action: "retry", guidance: "x".repeat(DIRECTIVE_TEXT_CHAR_CEILING + 1) }) },
    ]);
    const c = createSteering({ caller: s.caller, rate: RATE });
    const d = await c.solicit("post_gate_failure", ctx({ phase: "build" }));
    expect(d).toEqual(PROCEED);
    expect(c.telemetry.directives).toBe(0);
    expect(c.telemetry.directivesRejected).toBe(1);
    expect(c.telemetry.tripwires[0]!.detail).toContain("action retry rejected:");
    expect(s.calls()).toBe(1); // schema rejection — single attempt, no reparse
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

  test("a malformed harness ctx (promptContext not an array) degrades to PROCEED — never throws (S1-4)", async () => {
    const s = scriptedCaller([{ raw: '{"action":"proceed"}' }]);
    const c = createSteering({ caller: s.caller, rate: RATE });
    const badCtx = { ...ctx(), promptContext: "not-an-array" } as unknown as SolicitCtx;
    const d = await c.solicit("run_start", badCtx);
    expect(d).toEqual(PROCEED);
    expect(c.telemetry.status).toBe("degraded");
    expect(c.lastDegradationReason).toContain("prompt render failed:");
    expect(s.calls()).toBe(0); // the caller was never reached
  });

  test("telemetry is a snapshot: mutating a handed-out copy never touches the live counters (S1-5)", async () => {
    const s = scriptedCaller([{ raw: '{"action":"proceed"}' }]);
    const c = createSteering({ caller: s.caller, rate: RATE });
    const handed = c.telemetry;
    handed.directives = 999;
    handed.steeringIterations.build = 99;
    handed.tripwires.push({ runId: "run-1", cause: "gate_bypass_attempt", detail: "forged" });
    await c.solicit("run_start", ctx());
    expect(c.telemetry.directives).toBe(1);
    expect(c.telemetry.steeringIterations).toEqual({});
    expect(c.telemetry.tripwires).toHaveLength(0);
    // And the earlier snapshot is not retro-mutated by the accepted directive.
    expect(handed.directives).toBe(999);
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

  test("finite MAX_VALUE tokens overflow a term — the last finite spendMicros is preserved", async () => {
    // clampTerm admits any finite positive input, so MAX_VALUE tokens × a
    // real rate overflows the rounded term to Infinity; the meter must skip
    // the mutation rather than poison spendMicros (JSON null) for the run.
    const s = scriptedCaller([
      { raw: '{"action":"proceed"}', usage: { inputTokens: 1_000, outputTokens: 0 } }, // 100
      { raw: '{"action":"proceed"}', usage: { inputTokens: Number.MAX_VALUE, outputTokens: 0 } },
      { raw: '{"action":"proceed"}', usage: { inputTokens: 0, outputTokens: Number.MAX_VALUE } },
      { raw: '{"action":"proceed"}', usage: { inputTokens: 1_000, outputTokens: 0 } }, // 100
    ]);
    const c = createSteering({ caller: s.caller, rate: RATE });
    await c.solicit("run_start", ctx());
    await c.solicit("post_gate_failure", ctx());
    await c.solicit("post_gate_failure", ctx());
    await c.solicit("run_end", ctx());
    expect(Number.isFinite(c.telemetry.spendMicros)).toBe(true);
    // Only the two well-formed replies metered; both overflow replies skipped.
    expect(c.telemetry.spendMicros).toBe(200);
  });

  test("finite MAX_VALUE RATES overflow both terms — spendMicros stays finite", async () => {
    const s = scriptedCaller([
      { raw: '{"action":"proceed"}', usage: { inputTokens: 1_000, outputTokens: 1_000 } },
    ]);
    const c = createSteering({
      caller: s.caller,
      rate: { inputPerMTok: Number.MAX_VALUE, outputPerMTok: Number.MAX_VALUE },
    });
    await c.solicit("run_start", ctx());
    expect(c.telemetry.spendMicros).toBe(0);
    expect(Number.isFinite(c.telemetry.spendMicros)).toBe(true);
  });

  test("huge-but-finite tokens × a real rate overflow the PRODUCT before division — a second per-term overflow case", async () => {
    // Round-7 honesty fix: big × 2e6 overflows to Infinity BEFORE the ÷1e6,
    // so this trips the PER-TERM guard (like the MAX_VALUE cases above), not
    // the accumulated-sum guard — that one is covered by the MAX_SAFE_INTEGER
    // sum test below.
    const big = Number.MAX_VALUE / 2;
    const s = scriptedCaller([
      { raw: '{"action":"proceed"}', usage: { inputTokens: big, outputTokens: 0 } },
      { raw: '{"action":"proceed"}', usage: { inputTokens: big, outputTokens: 0 } },
    ]);
    const c = createSteering({
      caller: s.caller,
      rate: { inputPerMTok: 2_000_000, outputPerMTok: 0 },
    });
    await c.solicit("run_start", ctx());
    const afterFirst = c.telemetry.spendMicros;
    expect(Number.isFinite(afterFirst)).toBe(true);
    await c.solicit("run_end", ctx());
    expect(c.telemetry.spendMicros).toBe(afterFirst);
  });

  test("finite rounded term above MAX_SAFE_INTEGER — the last exact spendMicros is preserved", async () => {
    // 1e18 tokens × 2e6 rate = 2e24 (finite product), ÷1e6 = 2e16 µ$ — finite
    // but past MAX_SAFE_INTEGER, so JS cannot represent it exactly; metering
    // it would silently lose µ$ on every later addition. The meter must skip
    // the mutation (isSafeInteger, matching every other µ$ path).
    const s = scriptedCaller([
      { raw: '{"action":"proceed"}', usage: { inputTokens: 1_000, outputTokens: 0 } }, // 2_000 µ$
      { raw: '{"action":"proceed"}', usage: { inputTokens: 1e18, outputTokens: 0 } }, // 2e16 µ$ — unsafe, skipped
      { raw: '{"action":"proceed"}', usage: { inputTokens: 1_000, outputTokens: 0 } }, // 2_000 µ$
    ]);
    const c = createSteering({
      caller: s.caller,
      rate: { inputPerMTok: 2_000_000, outputPerMTok: 0 },
    });
    await c.solicit("run_start", ctx());
    expect(c.telemetry.spendMicros).toBe(2_000);
    await c.solicit("post_gate_failure", ctx());
    expect(c.telemetry.spendMicros).toBe(2_000);
    await c.solicit("run_end", ctx());
    expect(c.telemetry.spendMicros).toBe(4_000);
  });

  test("two individually safe terms whose SUM passes MAX_SAFE_INTEGER — the sum guard keeps the last exact value", async () => {
    // 4.5e15 tokens × 2e6 rate ÷1e6 = 9e15 µ$ per reply — each rounded term
    // is a safe integer; the second accumulation (1.8e16) crosses
    // MAX_SAFE_INTEGER, so the mutation is skipped and the exact prior total
    // survives.
    const s = scriptedCaller([
      { raw: '{"action":"proceed"}', usage: { inputTokens: 4.5e15, outputTokens: 0 } },
      { raw: '{"action":"proceed"}', usage: { inputTokens: 4.5e15, outputTokens: 0 } },
    ]);
    const c = createSteering({
      caller: s.caller,
      rate: { inputPerMTok: 2_000_000, outputPerMTok: 0 },
    });
    await c.solicit("run_start", ctx());
    expect(c.telemetry.spendMicros).toBe(9e15);
    await c.solicit("run_end", ctx());
    expect(c.telemetry.spendMicros).toBe(9e15);
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
    // stderr is piped, so it must be drained alongside stdout — an undrained
    // pipe can backpressure the child before exit.
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    expect(exitCode).toBe(0);
    expect(stderr).toBe(""); // the fixture's success path writes nothing to stderr
    const events = stdout.trim().split("\n").map((l) => JSON.parse(l) as { type: string });
    expect(events.map((e) => e.type)).toContain("message_end");
    expect(stdout).toContain('"text":"{\\"action\\":\\"proceed\\"}"');
    expect(stdout).toContain('"input":1200');
  });
});

describe("steering — DF3.4 inbox faults are observable, never silent (F1)", () => {
  const RATE_F1 = { inputPerMTok: 0, outputPerMTok: 0 };

  test("a NON-ENOENT drain failure is reported on lastInboxErrorReason and does not abort the solicitation", async () => {
    // The channel used to fail open to SILENCE. `localSteeringInbox.drain`
    // deliberately separates ENOENT ("nothing queued", return []) from a real
    // read error ("could not read", throw) — and drainInbox's blanket catch
    // collapsed both into "no messages", with nothing logged anywhere.
    //
    // The consequence is a documented guarantee turning false: `fleet attach`
    // tells the operator "the message stays queued — neither dropped nor
    // re-sent" (attach.ts:235-237). When every drain throws, that message is
    // never delivered on any later solicitation and NOTHING says so.
    const eacces = Object.assign(new Error("EACCES: permission denied, open '/run/steering/inbox.ndjson'"), {
      code: "EACCES",
    });
    const c = createSteering({
      caller: scriptedCaller([{ raw: '{"action":"proceed"}' }]).caller,
      rate: RATE_F1,
      inbox: {
        drain: async () => {
          throw eacces;
        },
        ack: async () => {},
      },
    });
    const d = await c.solicit("run_start", ctx());
    // The solicitation still happens: steering is a sidecar and an inbox fault
    // is not a resident fault. This half is the pre-existing behavior.
    expect(d).toEqual(PROCEED);
    expect(c.telemetry.status).toBe("active");
    // ...but it is now SAYABLE. This half is the fix.
    expect(c.lastInboxErrorReason).toContain("steering inbox");
    expect(c.lastInboxErrorReason).toContain("EACCES");
    // ...on the CHANNEL's slot, not the RESIDENT's. One slot for both let a
    // sidecar fault answer "why did the resident degrade?" with a reason about
    // the inbox, beside a `status` that says it did not degrade at all.
    expect(c.lastDegradationReason).toBeNull();
  });

  test("an EMPTY drain leaves the diagnostic untouched — nothing queued is not a fault", async () => {
    // The other side of the split. `localSteeringInbox` maps ENOENT to `[]`,
    // which is the ordinary case on every run before the first attach; it must
    // never look like a broken channel.
    const c = createSteering({
      caller: scriptedCaller([{ raw: '{"action":"proceed"}' }]).caller,
      rate: RATE_F1,
      inbox: { drain: async () => [], ack: async () => {} },
    });
    const d = await c.solicit("run_start", ctx());
    expect(d).toEqual(PROCEED);
    expect(c.lastDegradationReason).toBeNull();
  });

  test("onInboxError PUSHES the fault out of the process — fires once, naming the channel", async () => {
    // lastDegradationReason is a PULL field with no consumer outside this
    // module (steering.test.ts:468 pins it out of `telemetry` deliberately), so
    // on its own it does not answer the original defect: the operator has no
    // way to learn the channel is broken. This is the push half.
    const seen: { runId: string; requestId?: string; detail: string }[] = [];
    const c = createSteering({
      caller: scriptedCaller([{ raw: '{"action":"proceed"}' }]).caller,
      rate: RATE_F1,
      inbox: {
        drain: async () => {
          throw Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" });
        },
        ack: async () => {},
      },
      onInboxError: (e) => {
        seen.push(e);
      },
    });
    await c.solicit("run_start", ctx());
    expect(seen).toHaveLength(1);
    expect(seen[0]?.runId).toBe("run-1");
    expect(seen[0]?.requestId).toBe("req-1");
    expect(seen[0]?.detail).toContain("steering inbox");
    expect(seen[0]?.detail).toContain("EACCES");
  });

  test("onInboxError does NOT fire on an empty drain, but DOES on an ack failure", async () => {
    const seen: { detail: string }[] = [];
    const quiet = createSteering({
      caller: scriptedCaller([{ raw: '{"action":"proceed"}' }]).caller,
      rate: RATE_F1,
      inbox: { drain: async () => [], ack: async () => {} },
      onInboxError: (e) => {
        seen.push(e);
      },
    });
    await quiet.solicit("run_start", ctx());
    expect(seen).toEqual([]);

    const ackFails = createSteering({
      caller: scriptedCaller([{ raw: '{"action":"proceed"}' }]).caller,
      rate: RATE_F1,
      inbox: {
        drain: async () => [{ messageId: "m1", message: "steer" }],
        ack: async () => {
          throw new Error("EROFS");
        },
      },
      onInboxError: (e) => {
        seen.push(e);
      },
    });
    await ackFails.solicit("run_start", ctx({ promptContext: [] }));
    // An ack failure now REPORTS. It is the fault with the nastiest downstream
    // consequence and it used to reach nothing at all: `fleet attach` polls its
    // full 30s on an unwritable acks file and then prints a remediation
    // recommending the re-send that double-delivers.
    expect(seen).toHaveLength(1);
    // Named as an ACK failure, never as an unreadable channel — the fold DID
    // happen, and collapsing the two makes the diagnostic mean nothing.
    expect(seen[0]?.detail).toContain("ack failed for m1");
    expect(seen[0]?.detail).toContain("EROFS");
  });

  test("a THROWING onInboxError does not break the solicitation", async () => {
    // Same rule as onTripwire's observer: observability is a sidecar and must
    // never convert a solicitation into a failure.
    const c = createSteering({
      caller: scriptedCaller([{ raw: '{"action":"proceed"}' }]).caller,
      rate: RATE_F1,
      inbox: {
        drain: async () => {
          throw new Error("EIO");
        },
        ack: async () => {},
      },
      onInboxError: () => {
        throw new Error("the observer itself is broken");
      },
    });
    const d = await c.solicit("run_start", ctx());
    expect(d).toEqual(PROCEED);
    expect(c.telemetry.status).toBe("active");
  });

  test("an ack failure does NOT report a drain fault — the message was still folded", async () => {
    // The fold already happened; the acks file is evidence, not delivery. An
    // ack write failure must not be reported as an unreadable channel, or the
    // diagnostic stops meaning anything.
    const folded: string[] = [];
    const c = createSteering({
      caller: scriptedCaller([{ raw: '{"action":"proceed"}' }]).caller,
      rate: RATE_F1,
      inbox: {
        drain: async () => [{ messageId: "m1", message: "look at the retry budget" }],
        ack: async () => {
          throw new Error("EROFS: read-only file system");
        },
      },
    });
    const c2 = ctx({ promptContext: folded });
    await c.solicit("run_start", c2);
    expect(folded.some((l) => l.includes("look at the retry budget"))).toBeTrue();
    expect(c.lastInboxErrorReason).toContain("ack failed");
    expect(c.lastInboxErrorReason).not.toContain("unreadable");
    // And still not the RESIDENT's slot: the resident never faulted.
    expect(c.lastDegradationReason).toBeNull();
  });

  test("the run-wide fold budget bounds attach text, and an unfolded message is NOT acked", async () => {
    // Per-message capping bounds nothing that matters on its own: promptContext
    // is cumulative and renderPrompt truncates from the HEAD, so a flood of
    // attach lines evicts the run's own founding task context and survives at
    // the tail. The budget is what stops that.
    const acks: string[] = [];
    const folded: string[] = [];
    const queued = Array.from({ length: 8 }, (_, i) => ({
      messageId: `m${i}`,
      message: "x".repeat(ATTACH_MESSAGE_CHAR_CEILING),
    }));
    const c = createSteering({
      caller: scriptedCaller([{ raw: '{"action":"proceed"}' }]).caller,
      rate: RATE_F1,
      inbox: {
        drain: async () => queued,
        ack: async (id) => {
          acks.push(id);
        },
      },
    });
    await c.solicit("run_start", ctx({ promptContext: folded }));
    expect(folded.join("").length).toBeLessThanOrEqual(ATTACH_FOLD_CHAR_BUDGET);
    // Only what fit is acked: the ack means "this reached a solicitation's
    // prompt context", so acking a message the budget refused would make
    // `fleet attach`'s "still queued" a lie in the other direction.
    expect(acks).toEqual(folded.map((_, i) => `m${i}`));
    expect(acks.length).toBeLessThan(queued.length);
    // The flood must be REAL for the bound above to mean anything: 8 ×
    // ATTACH_MESSAGE_CHAR_CEILING has to overshoot the budget by a wide
    // margin, not merely edge past it. Asserted against the EXPORTED
    // constants — never a hidden literal ratio — so moving either ceiling
    // keeps this a genuine beyond-budget flood (or fails here, naming the
    // arithmetic) instead of silently flipping which side of the bound the
    // fixture lands on.
    expect(8 * ATTACH_MESSAGE_CHAR_CEILING).toBeGreaterThan(2 * ATTACH_FOLD_CHAR_BUDGET);
    expect(c.lastInboxErrorReason).toContain("fold budget");
  });

  test("the message cap is applied AFTER sanitizing, not before", async () => {
    // `sanitizeForMessage` is JSON.stringify plus a `\uXXXX` pass: a newline
    // expands to 2 chars and \x7f to 6, so capping the RAW text let a
    // 4 000-char message store ~24 000 — the cap bounded the wrong string.
    const folded: string[] = [];
    const c = createSteering({
      caller: scriptedCaller([{ raw: '{"action":"proceed"}' }]).caller,
      rate: RATE_F1,
      inbox: {
        drain: async () => [{ messageId: "m1", message: "\x7f".repeat(ATTACH_MESSAGE_CHAR_CEILING) }],
        ack: async () => {},
      },
    });
    await c.solicit("run_start", ctx({ promptContext: folded }));
    // prefix + id + separator + exactly the capped payload.
    expect(folded[0]?.length).toBeLessThanOrEqual(
      "operator attach m1: ".length + ATTACH_MESSAGE_CHAR_CEILING,
    );
  });

  test("a failed ack is RETRIED on the next solicitation, and the message folds only once", async () => {
    // The regression this closes: `delivered.add` ran BEFORE the ack and the
    // ack's throw was swallowed, so the id was already deduped by the time the
    // retry could have happened — the next drain re-read the file in full and
    // `continue`d past it. The ack then never landed for the run's lifetime and
    // `fleet attach` reported `attach-not-acked` for a message that WAS folded.
    const acks: string[] = [];
    let ackFails = true;
    const folded: string[] = [];
    const c = createSteering({
      caller: scriptedCaller([{ raw: '{"action":"proceed"}' }, { raw: '{"action":"proceed"}' }]).caller,
      rate: RATE_F1,
      inbox: {
        // Re-reads in FULL, exactly as localSteeringInbox does.
        drain: async () => [{ messageId: "m1", message: "raise the retry budget" }],
        ack: async (id) => {
          if (ackFails) throw new Error("ENOSPC");
          acks.push(id);
        },
      },
    });
    const shared = ctx({ promptContext: folded });
    await c.solicit("run_start", shared);
    expect(acks).toEqual([]);
    ackFails = false;
    await c.solicit("post_gate_failure", shared);
    expect(acks).toEqual(["m1"]);
    // Fold once, ack until it sticks — the two facts are tracked separately.
    expect(folded.filter((l) => l.includes("raise the retry budget"))).toHaveLength(1);
    // …and the state is STABLE past the success: the mock keeps re-draining
    // m1 forever, so a third solicitation proves a stuck ack does not re-fold
    // (the delivered latch holds) and does not double-ack (the acked latch
    // holds). Both regressions leave `fleet attach` lying about delivery.
    await c.solicit("run_end", shared);
    expect(acks).toEqual(["m1"]);
    expect(folded.filter((l) => l.includes("raise the retry budget"))).toHaveLength(1);
  });

  test("the inbox drains even after the resident has degraded", async () => {
    // `telemetry.status` is a one-way latch: three paths write "degraded" and
    // nothing writes "active" back. Draining behind that gate meant one caller
    // timeout stopped the channel for the rest of the run — never drained,
    // never acked, `onInboxError` never fired — which is the very defect the
    // hook exists to close, reached through the other door.
    const acks: string[] = [];
    // Queued only AFTER the degradation, exactly as an operator would: they
    // attach because the run looks stuck.
    let queued: readonly { messageId: string; message: string }[] = [];
    const c = createSteering({
      caller: {
        call: async () => {
          throw new Error("resident is gone");
        },
      },
      rate: RATE_F1,
      inbox: {
        drain: async () => queued,
        ack: async (id) => {
          acks.push(id);
        },
      },
    });
    await c.solicit("run_start", ctx({ promptContext: [] }));
    expect(c.telemetry.status).toBe("degraded");
    queued = [{ messageId: "m1", message: "still steering" }];
    const later: string[] = [];
    const d = await c.solicit("post_gate_failure", ctx({ promptContext: later }));
    // The resident CALL still stops at the gate — INV-RES-5 is untouched.
    expect(d).toEqual(PROCEED);
    // ...but the message landed and was acked.
    expect(later.some((l) => l.includes("still steering"))).toBeTrue();
    expect(acks).toEqual(["m1"]);
  });
});

describe("steering — the two diagnostic slots are two FACTS, across solicitations", () => {
  const RATE_F2 = { inputPerMTok: 0, outputPerMTok: 0 };

  test("an EMPTY drain leaves a PRIOR inbox fault standing — it does not clear the diagnostic", async () => {
    // The existing empty-drain test builds a FRESH controller and asserts
    // `null`, which proves the INITIAL value and nothing about what an empty
    // drain does to a value already there. One instance, two solicitations,
    // asserted after each is the case that separates "untouched" from "reset".
    let broken = true;
    const c = createSteering({
      caller: scriptedCaller([{ raw: '{"action":"proceed"}' }]).caller,
      rate: RATE_F2,
      inbox: {
        drain: async () => {
          if (broken) throw new Error("EIO: the channel is unreadable");
          return [];
        },
        ack: async () => {},
      },
    });

    await c.solicit("run_start", ctx({ promptContext: [] }));
    expect(c.lastInboxErrorReason).toContain("EIO");
    expect(c.lastDegradationReason).toBeNull();

    broken = false;
    await c.solicit("post_gate_failure", ctx({ promptContext: [] }));
    // "Nothing queued" is not evidence the channel healed, and an operator
    // reading the diagnostic after the fact must still find the fault.
    expect(c.lastInboxErrorReason).toContain("EIO");
    expect(c.lastDegradationReason).toBeNull();
  });

  test("an inbox fault NEVER writes the resident's slot, even after a real degradation", async () => {
    // The clobber this split exists for: one slot for both let a sidecar fault
    // — written pre-render, on a perfectly healthy resident — destroy the
    // resident's real degradation reason before anything read it.
    const c = createSteering({
      caller: {
        call: async () => {
          throw new Error("resident call timed out after 60000ms");
        },
      },
      rate: RATE_F2,
      inbox: {
        drain: async () => {
          throw new Error("EACCES on the inbox");
        },
        ack: async () => {},
      },
    });

    // ONE solicitation in which BOTH fail — the realistic incident is a wedged
    // box, not a broken channel beside a healthy resident. Every existing test
    // pairs a broken inbox with a working caller.
    const d = await c.solicit("run_start", ctx({ promptContext: [] }));
    expect(d).toEqual(PROCEED);
    expect(c.telemetry.status).toBe("degraded");
    // Each slot holds ITS OWN fault, and neither holds the other's.
    expect(c.lastDegradationReason).toContain("resident call timed out");
    expect(c.lastDegradationReason).not.toContain("EACCES");
    expect(c.lastInboxErrorReason).toContain("EACCES");
    expect(c.lastInboxErrorReason).not.toContain("resident call");
  });

  test("a resident degradation does not clobber the inbox slot on the NEXT solicitation either", async () => {
    let residentDown = false;
    const c = createSteering({
      caller: {
        call: async () => {
          if (residentDown) throw new Error("resident is gone");
          return { raw: '{"action":"proceed"}', usage: { inputTokens: 0, outputTokens: 0 } };
        },
      },
      rate: RATE_F2,
      inbox: {
        drain: async () => {
          throw new Error("ENOTDIR on the inbox mount");
        },
        ack: async () => {},
      },
    });

    await c.solicit("run_start", ctx({ promptContext: [] }));
    expect(c.lastInboxErrorReason).toContain("ENOTDIR");
    residentDown = true;
    await c.solicit("post_gate_failure", ctx({ promptContext: [] }));
    expect(c.lastDegradationReason).toContain("resident is gone");
    expect(c.lastInboxErrorReason).toContain("ENOTDIR");
  });
});

describe("steering — onInboxError fires ONCE per fault, not once per solicitation", () => {
  const RATE_F3 = { inputPerMTok: 0, outputPerMTok: 0 };

  test("a STABLE fault fires exactly once across many solicitations", async () => {
    // "Fires once" asserted over exactly ONE solicitation establishes "at least
    // one fire per solicitation", not "once": a fire-per-attempt observer
    // passes that assertion and floods the operator's sink on every gate of a
    // long run.
    const seen: { detail: string }[] = [];
    const c = createSteering({
      caller: scriptedCaller([{ raw: '{"action":"proceed"}' }]).caller,
      rate: RATE_F3,
      inbox: {
        drain: async () => {
          throw new Error("EACCES: permission denied");
        },
        ack: async () => {},
      },
      onInboxError: (e) => {
        seen.push(e);
      },
    });

    await c.solicit("run_start", ctx({ promptContext: [] }));
    await c.solicit("post_gate_failure", ctx({ promptContext: [] }));
    await c.solicit("run_end", ctx({ promptContext: [] }));
    expect(seen).toHaveLength(1);
  });

  test("a DIFFERENT fault still fires — the dedupe is on the detail, not on the channel", async () => {
    // The other half. A latch that goes quiet after the first fire never
    // re-reports a fault that CHANGED — the channel breaking a second, new way
    // reaches nobody — and it passes the "fires once" assertion above.
    const seen: { detail: string }[] = [];
    let cause = "EACCES: permission denied";
    const c = createSteering({
      caller: scriptedCaller([{ raw: '{"action":"proceed"}' }]).caller,
      rate: RATE_F3,
      inbox: {
        drain: async () => {
          throw new Error(cause);
        },
        ack: async () => {},
      },
      onInboxError: (e) => {
        seen.push(e);
      },
    });

    await c.solicit("run_start", ctx({ promptContext: [] }));
    await c.solicit("post_gate_failure", ctx({ promptContext: [] }));
    expect(seen).toHaveLength(1);

    cause = "ENOSPC: no space left on device";
    await c.solicit("run_end", ctx({ promptContext: [] }));
    expect(seen).toHaveLength(2);
    expect(seen[1]?.detail).toContain("ENOSPC");
    // ...and the new fault is itself deduped from here on.
    await c.solicit("run_end", ctx({ promptContext: [] }));
    expect(seen).toHaveLength(2);
  });

  test("an ASYNC onInboxError is AWAITED — its rejection is caught, never a process-fatal one", async () => {
    // `=> void` accepts an `async` observer, so `onInboxError: async (e) =>
    // await appendFile(...)` on a failing append became an unhandled rejection
    // — fatal under Bun — while the try/catch around the call caught only a
    // SYNCHRONOUS throw.
    let ran = false;
    const c = createSteering({
      caller: scriptedCaller([{ raw: '{"action":"proceed"}' }]).caller,
      rate: RATE_F3,
      inbox: {
        drain: async () => {
          throw new Error("EIO");
        },
        ack: async () => {},
      },
      onInboxError: async () => {
        await Bun.sleep(1);
        ran = true;
        throw new Error("the observer's own append failed");
      },
    });
    const d = await c.solicit("run_start", ctx({ promptContext: [] }));
    expect(d).toEqual(PROCEED);
    // Awaited, not fired and forgotten: the observer had finished before
    // `solicit` resolved, which is the only way its rejection can be caught.
    expect(ran).toBeTrue();
    expect(c.telemetry.status).toBe("active");
  });

  test("a HUNG drain and a HUNG ack are both bounded by INBOX_CALL_TIMEOUT_MS", async () => {
    // `solicit` serializes every solicitation through one chain, so a hung
    // inbox with no deadline wedges every LATER solicitation — no timeout, no
    // onInboxError, no diagnostic. Both legs run at once so the suite pays the
    // 5 s once.
    const hang = new Promise<never>(() => {});
    const hungDrain = createSteering({
      caller: scriptedCaller([{ raw: '{"action":"proceed"}' }]).caller,
      rate: RATE_F3,
      inbox: { drain: () => hang, ack: async () => {} },
    });
    const hungAck = createSteering({
      caller: scriptedCaller([{ raw: '{"action":"proceed"}' }]).caller,
      rate: RATE_F3,
      inbox: { drain: async () => [{ messageId: "m1", message: "steer" }], ack: () => hang },
    });

    const started = Date.now();
    const [a, b] = await Promise.all([
      hungDrain.solicit("run_start", ctx({ promptContext: [] })),
      hungAck.solicit("run_start", ctx({ promptContext: [] })),
    ]);
    const elapsed = Date.now() - started;

    expect(a).toEqual(PROCEED);
    expect(b).toEqual(PROCEED);
    expect(elapsed).toBeGreaterThanOrEqual(INBOX_CALL_TIMEOUT_MS - 100);
    expect(elapsed).toBeLessThan(3 * INBOX_CALL_TIMEOUT_MS);
    expect(hungDrain.lastInboxErrorReason).toContain("drain timed out");
    expect(hungAck.lastInboxErrorReason).toContain("ack timed out");
    // A hung sidecar is not a resident fault.
    expect(hungDrain.telemetry.status).toBe("active");
    expect(hungAck.telemetry.status).toBe("active");
  }, 30_000);

  test("an operator-supplied messageId is CAPPED in the prompt line", async () => {
    // The id is operator-supplied text on the same line as the message, so an
    // uncapped one blows the message's budget from the other side.
    const folded: string[] = [];
    const c = createSteering({
      caller: scriptedCaller([{ raw: '{"action":"proceed"}' }]).caller,
      rate: RATE_F3,
      inbox: {
        drain: async () => [{ messageId: "i".repeat(5_000), message: "steer" }],
        ack: async () => {},
      },
    });
    await c.solicit("run_start", ctx({ promptContext: folded }));
    expect(folded).toHaveLength(1);
    expect(folded[0]!.length).toBeLessThanOrEqual(
      "operator attach : ".length + DIRECTIVE_ID_CHAR_CEILING + "steer".length,
    );
    // AT-boundary, exact: the cap TRUNCATES TO the ceiling, never shorter.
    // Only an upper bound is asserted above, so a hard-coded 64-char cut or a
    // ceiling-100 slice would pass it; the oversized id must land as exactly
    // DIRECTIVE_ID_CHAR_CEILING `i`s (steering.ts:601 slices the sanitized id
    // to the constant).
    expect(folded[0]!.startsWith(`operator attach ${"i".repeat(DIRECTIVE_ID_CHAR_CEILING)}: `)).toBe(true);
    expect(folded[0]!.length).toBe(
      "operator attach ".length + DIRECTIVE_ID_CHAR_CEILING + ": ".length + "steer".length,
    );
  });
});

describe("steering — observer deadline, dedupe recovery, and fold-time ack point", () => {
  const RATE_F4 = { inputPerMTok: 0, outputPerMTok: 0 };

  test("a HUNG onInboxError observer is bounded by INBOX_CALL_TIMEOUT_MS and does not wedge the chain", async () => {
    // The observer type explicitly allows `Promise<void>` (steering.ts:333);
    // a hung one (a stalled mount under the trace sink) wedged the serialized
    // solicit chain forever — every LATER solicitation queued behind it with
    // no timeout and no diagnostic, the failure mode INBOX_CALL_TIMEOUT_MS's
    // header exists to prevent for the inbox calls.
    const hang = new Promise<void>(() => {});
    const c = createSteering({
      caller: scriptedCaller([{ raw: '{"action":"proceed"}' }]).caller,
      rate: RATE_F4,
      inbox: {
        drain: async () => {
          throw new Error("EIO");
        },
        ack: async () => {},
      },
      onInboxError: () => hang,
    });
    const started = Date.now();
    const d1 = await c.solicit("run_start", ctx({ promptContext: [] }));
    // The chain is NOT wedged: a second solicitation queued behind the hung
    // observer still resolves (deduped, so no second 5s wait).
    const d2 = await c.solicit("post_gate_failure", ctx({ promptContext: [] }));
    const elapsed = Date.now() - started;
    expect(d1).toEqual(PROCEED);
    expect(d2).toEqual(PROCEED);
    expect(elapsed).toBeGreaterThanOrEqual(INBOX_CALL_TIMEOUT_MS - 100);
    expect(elapsed).toBeLessThan(3 * INBOX_CALL_TIMEOUT_MS);
    // The fault itself was still recorded — a timed-out push loses only the push.
    expect(c.lastInboxErrorReason).toContain("EIO");
    // A hung sidecar is not a resident fault.
    expect(c.telemetry.status).toBe("active");
  }, 30_000);

  test("the dedupe latch RESETS after a healthy pass — the same fault recurring later re-fires", async () => {
    // The latch keeps a STABLE fault from flooding the observer's sink; left
    // standing forever it also silenced a NEW incident after a recovery,
    // because timeout messages stringify byte-identically. A fault-free pass
    // is the recovery signal that resets it.
    const seen: { detail: string }[] = [];
    let broken = true;
    const c = createSteering({
      caller: scriptedCaller([{ raw: '{"action":"proceed"}' }]).caller,
      rate: RATE_F4,
      inbox: {
        drain: async () => {
          if (broken) throw new Error("steering inbox drain timed out after 5000ms");
          return [];
        },
        ack: async () => {},
      },
      onInboxError: (e) => {
        seen.push(e);
      },
    });

    await c.solicit("run_start", ctx({ promptContext: [] }));
    await c.solicit("post_gate_failure", ctx({ promptContext: [] }));
    // The stable fault still fires exactly once — the flood guard is intact.
    expect(seen).toHaveLength(1);

    broken = false;
    await c.solicit("run_end", ctx({ promptContext: [] }));
    // A healthy pass pushes nothing but RESETS the latch...
    expect(seen).toHaveLength(1);

    broken = true;
    await c.solicit("run_end", ctx({ promptContext: [] }));
    // ...so the byte-identical recurrence is a new incident and fires again.
    expect(seen).toHaveLength(2);
    expect(seen[1]?.detail).toBe(seen[0]?.detail);
  });

  test("an ack RETRY records the FOLD-TIME point, not the retry solicitation's", async () => {
    // The ack means "reached a solicitation's prompt context" and is written
    // at fold time. A failed ack retries under a LATER solicitation, and
    // stamping it with that solicitation's point records a context the
    // message never reached.
    const ackCalls: { messageId: string; point: string }[] = [];
    let ackFails = true;
    const c = createSteering({
      caller: scriptedCaller([{ raw: '{"action":"proceed"}' }, { raw: '{"action":"proceed"}' }]).caller,
      rate: RATE_F4,
      inbox: {
        // Re-reads in FULL, exactly as localSteeringInbox does.
        drain: async () => [{ messageId: "m1", message: "raise the retry budget" }],
        ack: async (messageId, point) => {
          if (ackFails) throw new Error("ENOSPC");
          ackCalls.push({ messageId, point });
        },
      },
    });
    const shared = ctx({ promptContext: [] });
    await c.solicit("run_start", shared);
    expect(ackCalls).toEqual([]);
    ackFails = false;
    await c.solicit("post_gate_failure", shared);
    // Folded at run_start, acked on the post_gate_failure retry — the record
    // says run_start, where the message actually reached the prompt context.
    expect(ackCalls).toEqual([{ messageId: "m1", point: "run_start" }]);
  });
});

describe("steering — the durable dedupe: ackedIds is the persistence (round-10 S2)", () => {
  const RATE_S2 = { inputPerMTok: 0, outputPerMTok: 0 };

  test("ids the transport already acked are SETTLED — neither re-folded nor re-acked", async () => {
    // The queue is persistent and `acked` is not: after a crash-retry the new
    // process re-reads the FULL queue, and without the ack log it re-delivered
    // every message the previous process already saw — "delivers once" held
    // only within one process. `ackedIds` is the durable half: those ids are
    // settled BEFORE any fold or ack.
    const acks: string[] = [];
    const folded: string[] = [];
    const c = createSteering({
      caller: scriptedCaller([{ raw: '{"action":"proceed"}' }]).caller,
      rate: RATE_S2,
      inbox: {
        // Re-offers everything on EVERY drain, exactly as the real transport
        // does after a restart.
        drain: async () => [
          { messageId: "m-old", message: "delivered by the previous process" },
          { messageId: "m-new", message: "queued after the restart" },
        ],
        ack: async (id) => {
          acks.push(id);
        },
        // The ack log the previous process wrote.
        ackedIds: async () => ["m-old"],
      },
    });
    await c.solicit("run_start", ctx({ promptContext: folded }));
    expect(folded.some((l) => l.includes("delivered by the previous process"))).toBeFalse();
    expect(folded.some((l) => l.includes("queued after the restart"))).toBeTrue();
    expect(acks).toEqual(["m-new"]);
    // A later pass over the SAME queue changes nothing: the seeded set holds
    // for the process lifetime, not just the pass that read it.
    await c.solicit("run_end", ctx({ promptContext: folded }));
    expect(acks).toEqual(["m-new"]);
    expect(folded.filter((l) => l.includes("queued after the restart"))).toHaveLength(1);
  });

  test("a FAILED ackedIds read degrades to the in-process dedupe and still delivers", async () => {
    // An unreadable ack log must not withhold guidance: proceeding can only
    // re-fold text an earlier prompt already carried (bounded by the fold
    // budget), refusing bounds nothing. The fault is still reported — as the
    // ACKS read, never as an unreadable queue.
    const seen: { detail: string }[] = [];
    const folded: string[] = [];
    const acks: string[] = [];
    const c = createSteering({
      caller: scriptedCaller([{ raw: '{"action":"proceed"}' }]).caller,
      rate: RATE_S2,
      inbox: {
        drain: async () => [{ messageId: "m1", message: "still worth delivering" }],
        ack: async (id) => {
          acks.push(id);
        },
        ackedIds: async () => {
          throw new Error("EACCES: permission denied");
        },
      },
      onInboxError: (e) => {
        seen.push(e);
      },
    });
    await c.solicit("run_start", ctx({ promptContext: folded }));
    expect(folded.some((l) => l.includes("still worth delivering"))).toBeTrue();
    expect(acks).toEqual(["m1"]);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.detail).toContain("acks unreadable");
    expect(seen[0]?.detail).toContain("EACCES");
    // A channel fault, never a resident fault.
    expect(c.telemetry.status).toBe("active");
  });
});

describe("steering — the fold-budget floor: truncate, never strand (round-10 S4)", () => {
  const RATE_S4 = { inputPerMTok: 0, outputPerMTok: 0 };
  /** The prefix and the marker, derived from the source's own literals. */
  const prefixOf = (id: string): string => `operator attach ${id}: `;
  /** The marker is computed from the CAPPED body length, before the cut — an
   *  at-ceiling body states `4000 chars total` even when fewer are folded. */
  const MARKER = `[attach truncated, ${ATTACH_MESSAGE_CHAR_CEILING} chars total]`;
  const full = "x".repeat(ATTACH_MESSAGE_CHAR_CEILING);

  test("an over-budget message folds TRUNCATED with the stated cut — and IS acked", async () => {
    // The budget check used to skip ANY message that did not fit whole, so one
    // full-ceiling body landing inside the last few thousand chars of the
    // budget was never folded, never acked, and the same fault re-fired on
    // every solicitation for the run's lifetime — permanently undeliverable
    // guidance. Above the floor it now folds clamped and marked.
    const acks: string[] = [];
    const folded: string[] = [];
    const c = createSteering({
      caller: scriptedCaller([{ raw: '{"action":"proceed"}' }]).caller,
      rate: RATE_S4,
      inbox: {
        drain: async () => [
          { messageId: "m1", message: full },
          { messageId: "m2", message: full },
          { messageId: "m3", message: full },
        ],
        ack: async (id) => {
          acks.push(id);
        },
      },
    });
    await c.solicit("run_start", ctx({ promptContext: folded }));
    // m1 fits whole: prefix + a full-ceiling body is well inside the budget.
    expect(folded[0]).toBe(`${prefixOf("m1")}${full}`);
    // m2 does not fit whole — the fixture must genuinely be over budget for
    // what follows to mean anything.
    const room = ATTACH_FOLD_CHAR_BUDGET - folded[0]!.length;
    expect(prefixOf("m2").length + full.length).toBeGreaterThan(room);
    // …but there is room above the floor, so it folds CLAMPED to exactly what
    // is left, with the cut stated. Never silently partial.
    const cut = room - prefixOf("m2").length - MARKER.length;
    expect(cut).toBeGreaterThan(0);
    expect(folded[1]).toBe(`${prefixOf("m2")}${"x".repeat(cut)}${MARKER}`);
    expect(folded[1]!.length).toBe(room); // the truncated fold consumes the room exactly
    // Nothing is stranded by the arithmetic: a folded message is an ACKED one,
    // so `fleet attach` never recommends re-sending guidance the prompt
    // already carried.
    expect(acks).toEqual(["m1", "m2"]);
    // m3 arrives with the budget genuinely gone — below the floor the pass
    // stops and names it, and THAT message (not the one above) stays queued.
    expect(folded).toHaveLength(2);
    expect(acks).not.toContain("m3");
    expect(c.lastInboxErrorReason).toContain("fold budget");
    // The two folds together spend exactly the run-wide budget.
    expect(folded.join("").length).toBe(ATTACH_FOLD_CHAR_BUDGET);
  });

  test("at the floor EXACTLY the fold still happens — with ATTACH_FOLD_MIN_BODY_CHARS of body", async () => {
    // The floor is the boundary between "truncate" and "stop": a remaining
    // room of exactly prefix + marker + floor must fold (the refusal arm is
    // strictly `>`), so the smallest deliverable body is precisely
    // ATTACH_FOLD_MIN_BODY_CHARS. One char less of room and the pass stops.
    const p1 = prefixOf("m1").length;
    const p2 = prefixOf("m2").length;
    const p3 = prefixOf("m3").length;
    const floorNeed = p3 + MARKER.length + ATTACH_FOLD_MIN_BODY_CHARS;
    // Fill the budget so EXACTLY floorNeed chars remain when m3 is reached:
    // m1 folds whole, m2 folds whole, and the remainder is the boundary.
    const m1Body =
      ATTACH_FOLD_CHAR_BUDGET - floorNeed - p1 - p2 - ATTACH_MESSAGE_CHAR_CEILING;
    expect(m1Body).toBeGreaterThan(0);
    const acks: string[] = [];
    const folded: string[] = [];
    const c = createSteering({
      caller: scriptedCaller([{ raw: '{"action":"proceed"}' }]).caller,
      rate: RATE_S4,
      inbox: {
        drain: async () => [
          { messageId: "m1", message: "a".repeat(m1Body) },
          { messageId: "m2", message: "b".repeat(ATTACH_MESSAGE_CHAR_CEILING) },
          { messageId: "m3", message: "c".repeat(ATTACH_MESSAGE_CHAR_CEILING) },
        ],
        ack: async (id) => {
          acks.push(id);
        },
      },
    });
    await c.solicit("run_start", ctx({ promptContext: folded }));
    expect(folded[0]).toBe(`${prefixOf("m1")}${"a".repeat(m1Body)}`);
    expect(folded[1]).toBe(`${prefixOf("m2")}${"b".repeat(ATTACH_MESSAGE_CHAR_CEILING)}`);
    // At the floor: exactly the minimum body folds, and the marker still states
    // the body's FULL length — the cut is stated, not the remainder.
    expect(folded[2]).toBe(`${prefixOf("m3")}${"c".repeat(ATTACH_FOLD_MIN_BODY_CHARS)}${MARKER}`);
    expect(acks).toEqual(["m1", "m2", "m3"]);
    // Boundary case, not a fault: nothing is reported.
    expect(c.lastInboxErrorReason).toBeNull();
  });
});

describe("steering — the ack-fault latch is id-normalized (round-10 S7)", () => {
  const RATE_S7 = { inputPerMTok: 0, outputPerMTok: 0 };

  test("three distinct ids failing the SAME ack write fire onInboxError ONCE per pass", async () => {
    // N queued ids against one unwritable acks dir produce N details differing
    // only in the id. Comparing the raw detail fired the observer N times in
    // ONE pass for what is ONE fault — the channel is broken, and the flood
    // added no fact. The latch compares the id-stripped key; the observer still
    // receives the full per-id detail, because the id is what `fleet attach`'s
    // poll is waiting on.
    const seen: { detail: string }[] = [];
    const ackAttempts: string[] = [];
    const c = createSteering({
      caller: scriptedCaller([{ raw: '{"action":"proceed"}' }]).caller,
      rate: RATE_S7,
      inbox: {
        drain: async () => [
          { messageId: "m1", message: "first" },
          { messageId: "m2", message: "second" },
          { messageId: "m3", message: "third" },
        ],
        ack: async (id) => {
          ackAttempts.push(id);
          throw new Error("EROFS: read-only file system");
        },
      },
      onInboxError: (e) => {
        seen.push(e);
      },
    });
    await c.solicit("run_start", ctx({ promptContext: [] }));
    // Every id was still attempted — the fault never short-circuits the queue.
    expect(ackAttempts).toEqual(["m1", "m2", "m3"]);
    // One unwritable acks dir is ONE incident: fired once, on the first id's
    // full detail.
    expect(seen).toHaveLength(1);
    expect(seen[0]?.detail).toContain("ack failed for m1");
    expect(seen[0]?.detail).toContain("EROFS");
    // And a genuinely different cause still fires — the normalization drops the
    // id, never the cause.
    const seen2: { detail: string }[] = [];
    const c2 = createSteering({
      caller: scriptedCaller([{ raw: '{"action":"proceed"}' }]).caller,
      rate: RATE_S7,
      inbox: {
        drain: async () => [
          { messageId: "m1", message: "first" },
          { messageId: "m2", message: "second" },
        ],
        ack: async () => {
          throw new Error("EACCES: permission denied");
        },
      },
      onInboxError: (e) => {
        seen2.push(e);
      },
    });
    await c2.solicit("run_start", ctx({ promptContext: [] }));
    expect(seen2).toHaveLength(1);
    expect(seen2[0]?.detail).toContain("EACCES");
  });
});

/**
 * DF2.12 in-box leg, resident half: every metered solicitation emits one
 * `cost_attribution` line with `role: "resident"` and the resident's µ$ carried
 * DIRECTLY (the resident has no provider-reported USD). Additive at the meter
 * site only — solicitation points, fold budget, ResidentTelemetry's key set and
 * the journal resident block are untouched.
 */
describe("resident cost attribution (DF2.12)", () => {
  let captured: string[];
  let savedWrite: typeof process.stderr.write;

  const fd2Lines = (): Record<string, unknown>[] =>
    captured
      .flatMap((chunk) => chunk.split("\n"))
      .filter((l) => l.trim().length > 0)
      .map((l) => JSON.parse(l) as Record<string, unknown>) // dp:ok parses THIS test's own captured fd-2 lines, not external input
      .filter((o) => o.type === "cost_attribution");

  test("a metered solicitation emits role resident with the µ$ delta (DD-9, integer µ$)", async () => {
    const lines: Record<string, unknown>[] = [];
    const s = scriptedCaller([
      { raw: '{"action":"proceed"}', usage: { inputTokens: 100, outputTokens: 50 } },
    ]);
    const c = createSteering({ caller: s.caller, rate: RATE, emitAttribution: (l) => void lines.push(l) });
    const d = await c.solicit("run_start", ctx());
    expect(d).toEqual(PROCEED);
    expect(lines.length).toBe(1);
    // 100 × 100_000/1e6 = 10 µ$ in, 50 × 180_000/1e6 = 9 µ$ out.
    expect(lines[0]).toMatchObject({
      type: "cost_attribution",
      requestId: "req-1",
      runId: "run-1",
      role: "resident",
      invocationSeq: 0,
      agentId: "resident",
      costMicroUsd: 19,
      inputTokens: 100,
      outputTokens: 50,
      turnCount: 1,
      unpricedTurns: 0,
    });
    expect(c.telemetry.spendMicros).toBe(19);
  });

  test("second solicitation increments invocationSeq and carries the active phase", async () => {
    const lines: Record<string, unknown>[] = [];
    const s = scriptedCaller([
      { raw: '{"action":"proceed"}', usage: { inputTokens: 1, outputTokens: 1 } },
      { raw: '{"action":"proceed"}', usage: { inputTokens: 1, outputTokens: 1 } },
    ]);
    const c = createSteering({ caller: s.caller, rate: RATE, emitAttribution: (l) => void lines.push(l) });
    await c.solicit("run_start", ctx());
    await c.solicit("post_gate_failure", ctx({ phase: "build" }));
    expect(lines.map((l) => l.invocationSeq)).toEqual([0, 1]);
    expect(lines[0]?.phaseId).toBeNull(); // run_start: no phase active
    expect(lines[1]?.phaseId).toBe("build");
  });

  test("malformed token counts price nothing and read unpriced, not free (PR #253 review)", async () => {
    // A negative count is evidence money flowed that could not be metered.
    // clampTerm alone would silently LAUNDER it into a priced-zero row — the
    // exact conflation the ledger's unpriced taxonomy exists to prevent.
    const lines: Record<string, unknown>[] = [];
    const s = scriptedCaller([{ raw: '{"action":"proceed"}', usage: { inputTokens: -5, outputTokens: 50 } }]);
    const c = createSteering({ caller: s.caller, rate: RATE, emitAttribution: (l) => void lines.push(l) });
    const d = await c.solicit("run_start", ctx());
    expect(d).toEqual(PROCEED);
    expect(lines.length).toBe(1);
    expect(lines[0]).toMatchObject({ costMicroUsd: 0, unpricedTurns: 1 });
    // Nothing was metered off the poisoned input.
    expect(c.telemetry.spendMicros).toBe(0);
  });

  test("the two honest zeros stay distinct: absent usage unpriced, zero-token usage priced (PR #253 review)", async () => {
    const lines: Record<string, unknown>[] = [];
    // A bespoke caller, not scriptedCaller: its `?? {0, 0}` default can never
    // produce the absent-usage shape this test's second arm needs.
    const replies: { raw: string; usage?: { inputTokens: number; outputTokens: number } }[] = [
      { raw: '{"action":"proceed"}', usage: { inputTokens: 0, outputTokens: 0 } },
      { raw: '{"action":"proceed"}' },
    ];
    let i = 0;
    const caller: ResidentCaller = {
      // ResidentCaller's type pins usage non-optional; the RUNTIME contract
      // (never-throws metering) still has to survive a caller that omits it —
      // hence the cast, mirroring what a loose JS embedder produces.
      async call(): Promise<Awaited<ReturnType<ResidentCaller["call"]>>> {
        const reply = replies[Math.min(i++, replies.length - 1)]!;
        return reply as Awaited<ReturnType<ResidentCaller["call"]>>;
      },
    };
    const c = createSteering({ caller, rate: RATE, emitAttribution: (l) => void lines.push(l) });
    await c.solicit("run_start", ctx());
    await c.solicit("run_end", ctx());
    expect(lines.length).toBe(2);
    // A genuinely free (fully-cached) reply: priced, unpricedTurns 0 — it must
    // not be conflated with the unpriced class.
    expect(lines[0]).toMatchObject({ costMicroUsd: 0, unpricedTurns: 0 });
    // No usage object at all: fail-closed, unpriced (the shipped behavior).
    expect(lines[1]).toMatchObject({ costMicroUsd: 0, unpricedTurns: 1 });
  });

  test("fields the resident wire genuinely lacks are null, never invented", async () => {
    const lines: Record<string, unknown>[] = [];
    const s = scriptedCaller([{ raw: '{"action":"proceed"}', usage: { inputTokens: 10, outputTokens: 10 } }]);
    const c = createSteering({ caller: s.caller, rate: RATE, emitAttribution: (l) => void lines.push(l) });
    await c.solicit("run_start", ctx());
    expect(lines[0]?.model).toBeNull();
    expect(lines[0]?.cacheReadTokens).toBeNull();
    expect(lines[0]?.cacheWriteTokens).toBeNull();
    // µ$ is carried directly (`costMicroUsd`) and no USD key exists AT ALL —
    // absence, not null: the line's schema never declares a `costUsd` field.
    expect(lines[0]).not.toHaveProperty("costUsd");
  });

  test("default writer reaches fd 2 with no injected dep (INV-COST-10)", async () => {
    captured = [];
    savedWrite = process.stderr.write;
    process.stderr.write = ((chunk: unknown): boolean => {
      captured.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;
    try {
      const s = scriptedCaller([{ raw: '{"action":"proceed"}', usage: { inputTokens: 5, outputTokens: 5 } }]);
      const c = createSteering({ caller: s.caller, rate: RATE });
      await c.solicit("run_start", ctx());
      expect(fd2Lines().length).toBe(1);
      expect(fd2Lines()[0]?.role).toBe("resident");
    } finally {
      process.stderr.write = savedWrite;
    }
  });

  test("a throwing emitAttribution is a sidecar fault, never a degradation", async () => {
    const s = scriptedCaller([{ raw: '{"action":"proceed"}', usage: { inputTokens: 5, outputTokens: 5 } }]);
    const c = createSteering({
      caller: s.caller,
      rate: RATE,
      emitAttribution: () => {
        throw new Error("stderr is broken");
      },
    });
    const d = await c.solicit("run_start", ctx());
    expect(d).toEqual(PROCEED);
    expect(c.telemetry.status).toBe("active");
    expect(c.telemetry.spendMicros).toBeGreaterThan(0); // metering unaffected
    // Never silent: the failure is latched on the controller (PR #253 review).
    expect(c.lastAttributionErrorReason).toBe("stderr is broken");
    // Once-only: a second solicitation against the same broken sink re-fires
    // nothing — the latch keeps the first cause.
    await c.solicit("run_end", ctx());
    expect(c.lastAttributionErrorReason).toBe("stderr is broken");
  });

  test("a healthy attribution sink leaves no diagnostic", async () => {
    const s = scriptedCaller([{ raw: '{"action":"proceed"}', usage: { inputTokens: 5, outputTokens: 5 } }]);
    const c = createSteering({ caller: s.caller, rate: RATE, emitAttribution: () => {} });
    await c.solicit("run_start", ctx());
    expect(c.lastAttributionErrorReason).toBeNull();
  });
});

// ─── DF3.6b: the kernel memory bound's engine-side classification ────────────

describe("DF3.6b AC1/AC5 — a kernel OOM-kill stops the resident and says so", () => {
  /** A call that dies the way a cgroup OOM-kill dies: a SIGNAL death, which at
   *  the process level is indistinguishable from a timeout or an external
   *  kill. The kernel's own account (`lastMemory`) is the discriminator. */
  const signalDeath = () => new Error("resident pi killed by signal SIGKILL before exit");

  test("status is `stopped` and exitStatus `overflow` — never `degraded` beside `overflow`", async () => {
    const s = scriptedCaller([{ error: signalDeath() }]);
    const breaches: unknown[] = [];
    const tripwires: ResidentTripwire[] = [];
    const c = createSteering({
      caller: s.caller,
      rate: RATE,
      onTripwire: (t) => tripwires.push(t),
      onBoundBreach: (e) => {
        breaches.push(e);
      },
      // DISTINCT values, deliberately: a shared number lets the assertion below
      // pass against a `detail` that reports only one field, or substitutes one
      // for the other.
      lastMemory: () => ({ peakBytes: 70_254_592, oomKilled: true, boundBytes: 67_108_864 }),
    });
    expect(await c.solicit("post_gate_failure", ctx({ phase: "code" }))).toEqual(PROCEED);
    expect(c.telemetry.status).toBe("stopped");
    expect(c.telemetry.exitStatus).toBe("overflow");
    // An implementation leaning on the "degraded" status gate instead of the
    // stop() latch leaves the journal reading `degraded` beside `overflow` — a
    // combination no story owns, and the negative control AC5 names.
    expect(c.telemetry.status).not.toBe("degraded");
    expect(breaches).toEqual([
      {
        bound: "rss",
        allowed: false,
        cause: "watchdog_kill",
        runId: "run-1",
        requestId: "req-1",
        phase: "code",
      },
    ]);
    expect(tripwires).toHaveLength(1);
    expect(tripwires[0]?.cause).toBe("watchdog_kill");
    // The NUMERIC contract: the row names the peak and the bound it crossed,
    // so an implementation whose assertions pass with any bound value cannot
    // satisfy this one.
    expect(tripwires[0]?.detail).toContain("70254592"); // the measured peak
    expect(tripwires[0]?.detail).toContain("67108864"); // the bound it crossed
    expect(c.telemetry.tripwires.map((t) => t.cause)).toEqual(["watchdog_kill"]);
  });

  test("no further solicitation is issued after the kill — the status gate holds", async () => {
    const s = scriptedCaller([{ error: signalDeath() }]);
    const c = createSteering({
      caller: s.caller,
      rate: RATE,
      lastMemory: () => ({ peakBytes: 1, oomKilled: true, boundBytes: 2 }),
    });
    await c.solicit("run_start", ctx());
    expect(s.calls()).toBe(1);
    await c.solicit("run_end", ctx());
    expect(s.calls()).toBe(1);
  });

  test("NEGATIVE CONTROL — the same signal death with NO kill on the leaf degrades, as it always did", async () => {
    // Without this, the arm above would pass against an implementation that
    // classified every call failure as an OOM — which would relabel every
    // timeout and every unreachable resident a watchdog_kill.
    const s = scriptedCaller([{ error: signalDeath() }]);
    const breaches: unknown[] = [];
    const c = createSteering({
      caller: s.caller,
      rate: RATE,
      onBoundBreach: (e) => {
        breaches.push(e);
      },
      lastMemory: () => ({ peakBytes: 4096, oomKilled: false, boundBytes: 67_108_864 }),
    });
    expect(await c.solicit("run_start", ctx())).toEqual(PROCEED);
    expect(c.telemetry.status).toBe("degraded");
    expect(c.telemetry.exitStatus).toBeNull();
    expect(breaches).toEqual([]);
    expect(c.telemetry.tripwires).toEqual([]);
  });

  test("NEGATIVE CONTROL — with no `lastMemory` dep at all (the pre-DF3.6b shape) nothing changes", async () => {
    const s = scriptedCaller([{ error: signalDeath() }]);
    const c = createSteering({ caller: s.caller, rate: RATE });
    await c.solicit("run_start", ctx());
    expect(c.telemetry.status).toBe("degraded");
    expect(c.telemetry.exitStatus).toBeNull();
  });

  test("a THROWING lastMemory is a sidecar fault: it degrades, it never fails the solicitation", async () => {
    const s = scriptedCaller([{ error: signalDeath() }]);
    const c = createSteering({
      caller: s.caller,
      rate: RATE,
      lastMemory: () => {
        throw new Error("accounting read failed");
      },
    });
    expect(await c.solicit("run_start", ctx())).toEqual(PROCEED);
    expect(c.telemetry.status).toBe("degraded");
  });

  test("the OOM arm outranks the degrade arm even when the reply would otherwise be retried", async () => {
    // Ordering is the assertion: an implementation writing "degraded" first and
    // "stopped" second leaves the one-way latch pointing at the wrong value.
    const s = scriptedCaller([{ error: signalDeath() }]);
    const seen: string[] = [];
    const c = createSteering({
      caller: s.caller,
      rate: RATE,
      onBoundBreach: () => {
        // Fired AFTER the enforcement writes, per DF3.6a's rule — so the
        // observer already sees the settled status.
        seen.push(c.telemetry.status);
      },
      lastMemory: () => ({ peakBytes: 9, oomKilled: true, boundBytes: 8 }),
    });
    await c.solicit("run_start", ctx());
    expect(seen).toEqual(["stopped"]);
    // `status` alone does NOT discriminate the inversion: writing "degraded"
    // first and "stopped" second still reads "stopped" at breach time. The
    // observable that does is the degradation reason, which the wrong order
    // sets and the right one never touches.
    expect(c.lastDegradationReason).toBeNull();
  });
});
