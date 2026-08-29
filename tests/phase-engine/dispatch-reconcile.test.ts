/**
 * F061 — the two pure functions split out of the dispatchTask body.
 *
 * Before the split these branches were reachable only by driving a whole
 * spawn: the three-stage reconciliation mutated `finalExitStatus` under
 * overlapping conditions, and the output merge only ran at the end of a live
 * run. Both matrices below are exhaustive over the taxonomy that matters.
 */
import { describe, expect, test } from "bun:test";

import {
  buildDispatchOutput,
  reconcileExitStatus,
  type DispatchRunFacts,
} from "../../src/phase-engine/phases/dispatch-task.ts";
import type { ExitStatus, MergedError, MergedOutput } from "../../cli-anything/src/types.ts";

const NO_EVIDENCE: DispatchRunFacts = { exitCode: null, termSignal: null, killOrigin: null };
const EXITED: DispatchRunFacts = { exitCode: 1, termSignal: null, killOrigin: null };
const SIGNALLED: DispatchRunFacts = { exitCode: null, termSignal: "SIGKILL", killOrigin: null };
const KILLED: DispatchRunFacts = { exitCode: null, termSignal: null, killOrigin: "budget" };

const exitMatrix: Array<[
  { classified: ExitStatus; runResultStatus: ExitStatus; runFacts: DispatchRunFacts },
  ExitStatus,
]> = [
  // Both agree — nothing to reconcile.
  [{ classified: "success", runResultStatus: "success", runFacts: EXITED }, "success"],
  [{ classified: "logic", runResultStatus: "logic", runFacts: EXITED }, "logic"],

  // D2: no exit-signal evidence at all, runner reported a real failure mode →
  // the runner's verdict wins over the phase's lead_failure default.
  [{ classified: "lead_failure", runResultStatus: "transient", runFacts: NO_EVIDENCE }, "transient"],
  [{ classified: "lead_failure", runResultStatus: "overflow", runFacts: NO_EVIDENCE }, "overflow"],
  [{ classified: "lead_failure", runResultStatus: "logic", runFacts: NO_EVIDENCE }, "logic"],
  // D2 does NOT fire for success or lead_failure runner verdicts.
  [{ classified: "lead_failure", runResultStatus: "lead_failure", runFacts: NO_EVIDENCE }, "lead_failure"],
  [{ classified: "lead_failure", runResultStatus: "success", runFacts: NO_EVIDENCE }, "lead_failure"],
  // Any one piece of evidence disarms D2 — the phase's classification stands.
  [{ classified: "lead_failure", runResultStatus: "transient", runFacts: EXITED }, "lead_failure"],
  [{ classified: "lead_failure", runResultStatus: "transient", runFacts: SIGNALLED }, "lead_failure"],
  [{ classified: "lead_failure", runResultStatus: "transient", runFacts: KILLED }, "lead_failure"],

  // D3: dispatch must never force success over a non-success runner verdict.
  [{ classified: "success", runResultStatus: "transient", runFacts: EXITED }, "transient"],
  [{ classified: "success", runResultStatus: "overflow", runFacts: SIGNALLED }, "overflow"],
  [{ classified: "success", runResultStatus: "logic", runFacts: KILLED }, "logic"],
  [{ classified: "success", runResultStatus: "lead_failure", runFacts: EXITED }, "lead_failure"],
  // D3 also fires with no evidence, where D2 declined (lead_failure runner verdict).
  [{ classified: "success", runResultStatus: "lead_failure", runFacts: NO_EVIDENCE }, "lead_failure"],
  // A non-success classification is never upgraded by a success runner verdict.
  [{ classified: "overflow", runResultStatus: "success", runFacts: KILLED }, "overflow"],
  [{ classified: "transient", runResultStatus: "success", runFacts: EXITED }, "transient"],
];

test.each(exitMatrix)("reconcileExitStatus(%j) → %s", (input, expected) => {
  expect(reconcileExitStatus(input)).toBe(expected);
});

const runResult = (patch: Partial<MergedOutput> = {}): MergedOutput =>
  ({
    exitStatus: "success",
    partial: true,
    result: { r: 1 },
    agentOutputs: { a: { ok: true } },
    changedFiles: ["ignored.ts"],
    comsLog: [],
    durationMs: 0,
    waivers: [],
    error: null,
    testResults: { passed: 0, failed: 0 },
    testsExecuted: false,
    summary: "s",
    mulchPrimed: false,
    mulchPrimeError: null,
    artifacts: [],
    partialOutput: null,
    ...patch,
  }) as MergedOutput;

const build = (finalExitStatus: ExitStatus, patch: Partial<MergedOutput> = {}, runFacts = EXITED) =>
  buildDispatchOutput({
    finalExitStatus,
    runResult: runResult(patch),
    runFacts,
    health: { malformedLines: 2, droppedOversizeLines: 3 },
    changedFiles: ["src/a.ts"],
    artifacts: [],
    durationMs: 42,
    testResult: { testResults: { passed: 1, failed: 0 }, testsExecuted: true },
    redact: (s) => s,
  });

describe("buildDispatchOutput", () => {
  test("success clears partial and error, keeps agentOutputs and changedFiles", () => {
    const out = build("success");
    expect(out.exitStatus).toBe("success");
    expect(out.partial).toBe(false);
    expect(out.error).toBeNull();
    expect(out.partialOutput).toBeNull();
    expect(out.agentOutputs).toEqual({ a: { ok: true } });
    expect(out.changedFiles).toEqual(["src/a.ts"]);
  });

  test("lead_failure empties agentOutputs and changedFiles", () => {
    const out = build("lead_failure");
    expect(out.agentOutputs).toEqual({});
    expect(out.changedFiles).toEqual([]);
  });

  const failureStatuses: Array<[MergedError["reason"]]> = [["transient"], ["overflow"], ["logic"], ["lead_failure"]];
  test.each(failureStatuses)(
    "%s synthesises an error and partialOutput from the run facts",
    (status: MergedError["reason"]) => {
      const out = build(status);
      expect(out.error).toEqual({
        reason: status,
        message: `run classified ${status} (exit=1 signal=none malformed=2 dropped=3)`,
      });
      expect(out.partialOutput).toBe(`run ended ${status}: exit=1 signal=none`);
      expect(out.partial).toBe(true);
    },
  );

  test("a runner-supplied error and partialOutput are preferred over the synthesised ones", () => {
    const out = build("logic", {
      error: { reason: "logic", message: "from the runner" },
      partialOutput: "runner tail",
    });
    expect(out.error).toEqual({ reason: "logic", message: "from the runner" });
    expect(out.partialOutput).toBe("runner tail");
  });

  test("null exit code and a signal render as null/<signal> in both messages", () => {
    const out = build("overflow", {}, SIGNALLED);
    expect(out.error?.message).toBe(
      "run classified overflow (exit=null signal=SIGKILL malformed=2 dropped=3)",
    );
    expect(out.partialOutput).toBe("run ended overflow: exit=null signal=SIGKILL");
  });

  test("counters and sub-timings ride on the value", () => {
    const out = build("success");
    expect(out.malformedLines).toBe(2);
    expect(out.droppedOversizeLines).toBe(3);
    expect(out.dispatchSubTimings).toEqual({ team_execution_ms: 42 });
    expect(out.durationMs).toBe(42);
  });
});
