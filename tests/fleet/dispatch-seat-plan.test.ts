/**
 * Task 6 (S1 rig_swarm): `seatKeyPlan` — the dispatch-side clamp that turns
 * authored `PhaseSpec.seatBudgets` into a `SeatKeyPlan[]` `mintSeatKeys`
 * accepts. Pure unit: the money arithmetic only, no fixtures.
 *
 * Two brief deviations, both documented at the tests they change:
 * 1. The brief's "untouched" fixture (250M µ$ seats) is now the CLAMP test's
 *    fixture — controller addition 1 clamps per-seat limits to
 *    defaultKeyCapMicroUsd, so those inputs no longer exercise the untouched
 *    arm. Replacement numbers preserve the arm (Σ authored = ceiling,
 *    per-seat ≤ backstop ⇒ limits === authored).
 * 2. The brief's floor-property loop started at ceiling 1 with THREE seats —
 *    unsatisfiable against the brief's own formula: Math.max(1, …) floors
 *    every seat at 1 µ$, so Σ ≥ #seats and Σ ≤ ceiling cannot both hold
 *    below ceiling = 3. The loop starts at the seat count, the minimum
 *    ceiling the invariant is true for; the property itself is unchanged.
 */
import { describe, expect, test } from "bun:test";

import { seatKeyPlan } from "../../src/fleet/dispatch.ts";
import { defaultKeyCapMicroUsd } from "../../src/providers/credentials.ts";

describe("seatKeyPlan (S1 dispatch clamp)", () => {
  test("scales authored budgets proportionally into the ceiling", () => {
    const plan = seatKeyPlan({ lead: 500, worker: 500 }, 750);
    expect(plan).toEqual([
      { seat: "lead", limitMicroUsd: 375 },
      { seat: "worker", limitMicroUsd: 375 },
    ]);
  });

  test("floor keeps the sum at or under the ceiling", () => {
    for (let ceiling = 3; ceiling <= 100; ceiling += 7) {
      const plan = seatKeyPlan({ a: 100, b: 100, c: 100 }, ceiling);
      const sum = plan.reduce((acc, p) => acc + p.limitMicroUsd, 0);
      expect(sum).toBeLessThanOrEqual(ceiling);
      expect(plan.every((p) => p.limitMicroUsd >= 1)).toBe(true);
    }
  });

  test("leaves budgets untouched when they already fit", () => {
    expect(seatKeyPlan({ lead: 20_000_000, worker: 30_000_000 }, 50_000_000)).toEqual([
      { seat: "lead", limitMicroUsd: 20_000_000 },
      { seat: "worker", limitMicroUsd: 30_000_000 },
    ]);
  });

  // Controller addition 1: proportional scaling alone leaves a per-seat limit
  // ABOVE defaultKeyCapMicroUsd when authored budgets are large but fit the
  // ceiling (Σ authored ≤ ceiling, single seat 250M µ$) — and mintSeatKeys
  // refuses that AFTER box creation. Regression-sensitive: removing the
  // Math.min(defaultKeyCapMicroUsd, …) clamp turns this red (250M ≠ 50M).
  test("clamps each seat to the defaultKeyCapMicroUsd backstop", () => {
    const plan = seatKeyPlan({ lead: 250_000_000, worker: 250_000_000 }, 500_000_000);
    expect(plan).toEqual([
      { seat: "lead", limitMicroUsd: defaultKeyCapMicroUsd },
      { seat: "worker", limitMicroUsd: defaultKeyCapMicroUsd },
    ]);
  });

  // The brief's named floor ("never a 0-limit key"), pinned directly: shares
  // that floor to 0 still mint 1 µ$. The Σ ≤ ceiling property and this floor
  // are in honest tension at sub-seat-count ceilings (2 seats cannot share
  // 1 µ$ without a 0-limit key) — this is the arm the equal-budget loop above
  // cannot reach, and without Math.max a 0-limit key reaches mintSeatKeys,
  // which refuses it as a non-positive integer.
  test("floors a zero-share seat at 1 µ$ — never a 0-limit key", () => {
    expect(seatKeyPlan({ a: 1, b: 99 }, 1)).toEqual([
      { seat: "a", limitMicroUsd: 1 },
      { seat: "b", limitMicroUsd: 1 },
    ]);
  });
});
