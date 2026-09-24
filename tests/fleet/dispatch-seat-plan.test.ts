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
  // F-031: the LITERAL is asserted alongside the constant — an assertion
  // against `defaultKeyCapMicroUsd` alone re-passes silently if the constant
  // itself moves; the literal pins the clamp's actual value.
  test("clamps each seat to the defaultKeyCapMicroUsd backstop", () => {
    const plan = seatKeyPlan({ lead: 250_000_000, worker: 250_000_000 }, 500_000_000);
    expect(defaultKeyCapMicroUsd).toBe(50_000_000);
    expect(plan).toEqual([
      { seat: "lead", limitMicroUsd: defaultKeyCapMicroUsd },
      { seat: "worker", limitMicroUsd: defaultKeyCapMicroUsd },
    ]);
    // The same plan, spelled as the number: the clamp lands at 50M µ$.
    expect(plan).toEqual([
      { seat: "lead", limitMicroUsd: 50_000_000 },
      { seat: "worker", limitMicroUsd: 50_000_000 },
    ]);
  });

  // F-010: the plan is refused at dispatch, before any arithmetic — a Σ ≤ 0
  // budget set or a non-positive ceiling used to divide into NaN and poison
  // every limit via Math.max(1, NaN), surfacing post-box as the mint's
  // confusing non-integer refusal. Each refusal names its operand.
  test("refuses seatBudgets that sum to 0 (nothing to divide the ceiling across)", () => {
    expect(() => seatKeyPlan({}, 50_000_000)).toThrow(/seatKeyPlan: .*sum to 0 µ\$ — need a positive integer total/);
    expect(() => seatKeyPlan({ a: 0, b: 0 }, 50_000_000)).toThrow(/sum to 0 µ\$/);
  });

  test("refuses a non-positive ceiling", () => {
    expect(() => seatKeyPlan({ a: 10 }, 0)).toThrow(/seatKeyPlan: ceiling 0 µ\$ is not a positive integer/);
    expect(() => seatKeyPlan({ a: 10 }, -5_000_000)).toThrow(/ceiling -5000000 µ\$ is not a positive integer/);
  });

  test("refuses a non-integer authored budget and a non-integer ceiling", () => {
    // The Σ guard fires first, so a non-integer-per-seat case needs an INTEGER
    // total: 10.5 + 9.5 = 20, and the per-seat loop then names the offender.
    expect(() => seatKeyPlan({ a: 10.5, b: 9.5 }, 50_000_000)).toThrow(
      /seat 'a' authored budget 10\.5 µ\$ is not an integer/,
    );
    expect(() => seatKeyPlan({ a: 10 }, 50.5)).toThrow(/ceiling 50\.5 µ\$ is not a positive integer/);
  });

  // The brief's named floor ("never a 0-limit key"), pinned directly: shares
  // that floor to 0 still mint 1 µ$. At ceiling 2 both shares floor to 1 and
  // the plan still FITS (Σ = 2 = ceiling); the sub-seat-count ceiling that
  // used to return an over-sum plan is now the refusal below.
  test("floors a zero-share seat at 1 µ$ — never a 0-limit key", () => {
    expect(seatKeyPlan({ a: 1, b: 99 }, 2)).toEqual([
      { seat: "a", limitMicroUsd: 1 },
      { seat: "b", limitMicroUsd: 1 },
    ]);
  });

  // The floor's honest tension, resolved at plan time: with a sub-seat-count
  // ceiling the floored plan sums OVER the ceiling (2 seats, 1 µ$). That plan
  // used to be returned and left for mintSeatKeys' Σ-guard — a refusal that
  // only fires AFTER box creation, stranding the provisioned spend. The
  // completed plan is now verified here, before any key is minted.
  test("refuses a plan whose 1 µ$ floor pushes the sum over the ceiling", () => {
    expect(() => seatKeyPlan({ a: 1, b: 99 }, 1)).toThrow(
      /plan sums to 2 µ\$ against a 1 µ\$ ceiling/,
    );
  });
});
