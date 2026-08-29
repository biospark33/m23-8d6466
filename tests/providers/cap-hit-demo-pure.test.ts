/**
 * F021 — unit coverage for the pure functions split out of runCapHitDemo.
 * The end-to-end behaviour stays pinned by cap-hit-demo.test.ts; these cover
 * the branch matrices that needed a whole substrate to reach before the split.
 */
import { describe, expect, test } from "bun:test";

import {
  decideCapHitVerdict,
  isCapRejection,
  resolveCapHitOptions,
  type CapHitDemoDeps,
  type CapHitVerdictInputs,
} from "../../scripts/cap-hit-demo.ts";

const deps = {} as CapHitDemoDeps;

describe("resolveCapHitOptions", () => {
  test("defaults when nothing is provided", () => {
    const r = resolveCapHitOptions(deps, {}, false);
    expect(r.capMicroUsd).toBe(50_000);
    expect(r.wallClockMs).toBe(900_000);
    expect(r.runBudgetCapMicros).toBe(40_000);
    expect(r.residentCeilingMicros).toBe(30_000);
    expect(r.envFile).toBe("app/.env");
    expect(r.cancelGraceMs).toBe(10_000);
  });

  test("live substrate gets the exe.dev env file", () => {
    expect(resolveCapHitOptions(deps, {}, true).envFile).toBe("/home/exedev/.env");
  });

  test("deps beat opts beat env for evidenceDir", () => {
    expect(resolveCapHitOptions({ evidenceDir: "d" } as CapHitDemoDeps, { evidenceDir: "o" }, false).evidenceDir).toBe("d");
    expect(resolveCapHitOptions(deps, { evidenceDir: "o" }, false).evidenceDir).toBe("o");
  });

  test.each([
    ["capMicroUsd", { capMicroUsd: 0 }],
    ["capMicroUsd", { capMicroUsd: -1 }],
    ["wallClockMs", { wallClockMs: Number.NaN }],
    ["wallClockMs", { wallClockMs: Number.POSITIVE_INFINITY }],
    ["runBudgetCapMicros", { runBudgetCapMicros: 1.5 }],
    ["residentCeilingMicros", { residentCeilingMicros: -0.1 }],
  ])("rejects a bad %s", (name, opts) => {
    let caught: (Error & { code?: string; remediation?: string }) | null = null;
    try {
      resolveCapHitOptions(deps, opts, false);
    } catch (e) {
      caught = e as Error & { code?: string };
    }
    expect(caught).not.toBeNull();
    expect(caught?.code).toBe("invalid-value");
    expect(caught?.message).toContain(`${name} must be a positive integer`);
    expect(caught?.remediation).toBe(`pass a positive integer for ${name}`);
  });
});

describe("isCapRejection", () => {
  test.each([
    [402, "Insufficient credits", true],
    [402, "anything at all", true],
    [403, 'Key limit exceeded (total limit)', true],
    [403, "not authorized for this model", false],
    [200, "Key limit exceeded", false],
    [429, "rate limited", false],
    [500, "", false],
  ])("isCapRejection(%i, %j) → %s", (status, body, expected) => {
    expect(isCapRejection(status as number, body as string)).toBe(expected);
  });
});

const base: CapHitVerdictInputs = {
  classificationValid: true,
  teardownOk: true,
  classification: { exitStatus: "overflow", killOrigin: "provider-cap" },
  turnsCompleted: 1,
  workloadStillActive: false,
  terminationProvenance: null,
  spendCaptureError: null,
  providerCapRejected: true,
};

/**
 * The demonstrated gate (valid classification + clean teardown + overflow +
 * provider-cap kill origin + ≥1 turn) is checked first, so a row that only
 * perturbs the reason inputs still demonstrates. `nd` breaks the gate on the
 * kill origin so the reason-priority chain below is the thing under test.
 */
const nd = (patch: Partial<CapHitVerdictInputs>): CapHitVerdictInputs => ({
  ...base,
  classification: { exitStatus: "overflow", killOrigin: "wall-clock" },
  ...patch,
});

const verdictMatrix: Array<[CapHitVerdictInputs, "demonstrated" | "inconclusive", string | null]> = [
  [base, "demonstrated", null],
  // Perturbing only a reason input leaves the gate intact — still demonstrated.
  [{ ...base, spendCaptureError: "boom" }, "demonstrated", null],
  [{ ...base, teardownOk: false }, "inconclusive", "teardown-aborted"],
  // teardown-aborted outranks every other reason.
  [nd({ teardownOk: false, workloadStillActive: true, terminationProvenance: "host-error" }), "inconclusive", "teardown-aborted"],
  [nd({ workloadStillActive: true }), "inconclusive", "workload-cancel-failed"],
  [nd({ workloadStillActive: true, terminationProvenance: "host-error" }), "inconclusive", "workload-cancel-failed"],
  [nd({ terminationProvenance: "host-error" }), "inconclusive", "host-error"],
  [nd({ terminationProvenance: "wall-clock" }), "inconclusive", "wall-clock-first"],
  [{ ...base, classificationValid: false }, "inconclusive", "classification-invalid"],
  [nd({ spendCaptureError: "boom" }), "inconclusive", "spend-capture-failed"],
  [{ ...base, turnsCompleted: 0 }, "inconclusive", "cap-below-first-turn"],
  [nd({ classification: { exitStatus: "success", killOrigin: null } }), "inconclusive", "no-rejection"],
  // overflow + a turn but no provider-cap kill origin: still not a demonstration.
  [nd({ providerCapRejected: false }), "inconclusive", "no-rejection"],
  [nd({}), "inconclusive", "no-live-account"],
];

test.each(verdictMatrix)("decideCapHitVerdict(%j) → %s / %s", (inputs, verdict, reason) => {
  expect(decideCapHitVerdict(inputs)).toEqual({ verdict, reason });
});
