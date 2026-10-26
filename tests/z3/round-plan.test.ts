/**
 * Z3 round plan — fixture tier (no network, no spend): the cap derived from
 * A2's constant, the worst-case spend sum printed before fire, and the
 * operator-GO gate that refuses a fire on an absent/malformed/short record.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { MAX_QA_LEGS, QA_LENS } from "../../src/qa/findings.ts";
import {
  codePollTimeoutFor,
  composeRound,
  consumeOperatorGo,
  reflectAllowanceUsd,
  gateFire,
  readOperatorGo,
  worstCaseSpendLine,
  worstCaseSpendUsd,
  Z3_LEGS,
  Z3_MAX_FLEET_RUNS,
  Z3_QA_LEG_POLL_MS,
  Z3_REFLECT_CALL_USD,
  Z3_STEP,
  Z3_UPSTREAM_BLOCKERS,
  upstreamBlockerRefusal,
} from "../../scripts/z3/round-plan.ts";

const REV = "0123456789abcdef0123456789abcdef01234567";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "z3-plan-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function goFile(body: unknown): string {
  const p = join(dir, "operator-GO.json");
  writeFileSync(p, typeof body === "string" ? body : JSON.stringify(body));
  return p;
}

const GOOD_GO = {
  who: "operator (biospark33)",
  when: new Date(Date.now() - 60_000).toISOString(),
  spendApproved: { worstCaseUsd: 30, legs: "3 x $6 + code $6" },
  swarmclawForkRev: REV,
};

describe("round composition", () => {
  test("the 11 legs, in the story's Observability Contract order", () => {
    expect([...Z3_LEGS]).toEqual([
      "trigger",
      "kill-and-provision",
      "box-forensics",
      "qa-run-observe",
      "findings-retain",
      "priming-recall",
      "observe-read-only",
      "approval-park",
      "approve",
      "branch-and-complete",
      "crash-window-redrive",
    ]);
  });

  test("Z3_MAX_FLEET_RUNS is derived from A2's MAX_QA_LEGS (+1 code run)", () => {
    expect(Z3_MAX_FLEET_RUNS).toBe(MAX_QA_LEGS + 1);
  });

  test("default round: one qa-leg run per QA_LENS, then the code run, sequential", () => {
    const runs = composeRound({ qaGroupCapUsd: 6, codeGroupCapUsd: 8 });
    expect(runs.map((r) => r.stepId)).toEqual([...QA_LENS.map((l) => Z3_STEP.qaLeg(l)), Z3_STEP.codeRun]);
    expect(runs.at(-1)?.kind).toBe("code");
  });

  test("a composition over the cap is refused", () => {
    const lenses = Array.from({ length: Z3_MAX_FLEET_RUNS }, (_, i) => `lens-${i}`);
    expect(() => composeRound({ lenses, qaGroupCapUsd: 1, codeGroupCapUsd: 1 })).toThrow(/Z3_MAX_FLEET_RUNS/);
  });

  test("duplicate or off-roster lenses and non-positive caps are refused", () => {
    expect(() => composeRound({ lenses: ["correctness", "correctness"], qaGroupCapUsd: 1, codeGroupCapUsd: 1 })).toThrow(/duplicate/);
    expect(() => composeRound({ lenses: ["vibes"], qaGroupCapUsd: 1, codeGroupCapUsd: 1 })).toThrow(/QA_LENS/);
    expect(() => composeRound({ qaGroupCapUsd: 0, codeGroupCapUsd: 1 })).toThrow(/groupCapUsd/);
    expect(() => composeRound({ qaGroupCapUsd: 1, codeGroupCapUsd: Number.NaN })).toThrow(/groupCapUsd/);
  });

  test("Σ per-run caps equals the fork's QA_LENS.length × qaGroupCapUsd + codeGroupCapUsd", () => {
    const runs = composeRound({ qaGroupCapUsd: 2.5, codeGroupCapUsd: 7 });
    expect(worstCaseSpendUsd(runs)).toBe(QA_LENS.length * 2.5 + 7);
  });

  test("the code run's fork deadline is the round budget minus the QA legs' worst case, and refuses a starved budget", () => {
    const runs = composeRound({ qaGroupCapUsd: 6, codeGroupCapUsd: 8 });
    expect(codePollTimeoutFor(300 * 60_000, runs)).toBe(300 * 60_000 - QA_LENS.length * Z3_QA_LEG_POLL_MS);
    expect(() => codePollTimeoutFor(200 * 60_000, runs)).toThrow(/raise the round budget/);
  });

  test("worst-case spend = Σ per-run groupCapUsd, and the line names it", () => {
    const runs = composeRound({ qaGroupCapUsd: 6, codeGroupCapUsd: 8 });
    expect(worstCaseSpendUsd(runs)).toBe(6 * QA_LENS.length + 8);
    expect(worstCaseSpendLine(runs)).toContain(`$${(6 * QA_LENS.length + 8).toFixed(2)}`);
  });
});

describe("operator-GO gate", () => {
  test("a well-formed GO covering the spend and naming the round's rev passes; spend is printed first", () => {
    const runs = composeRound({ qaGroupCapUsd: 6, codeGroupCapUsd: 8 });
    const printed: string[] = [];
    const out = gateFire({ runs, goFile: goFile(GOOD_GO), forkRev: REV, print: (l) => printed.push(l) });
    expect(out.worstCaseUsd).toBe(26);
    expect(out.go.who).toBe(GOOD_GO.who);
    expect(printed[0]).toContain("worst-case spend");
  });

  test("an absent GO refuses the fire — and the spend line was still printed before the refusal", () => {
    const runs = composeRound({ qaGroupCapUsd: 6, codeGroupCapUsd: 8 });
    const printed: string[] = [];
    expect(() => gateFire({ runs, goFile: join(dir, "nope.json"), forkRev: REV, print: (l) => printed.push(l) })).toThrow(
      /operator GO not recorded/,
    );
    expect(printed).toHaveLength(1);
  });

  test("malformed GO records are refused (bad JSON, missing who, unparseable when, no spend, bad rev)", () => {
    expect(() => readOperatorGo(goFile("{not json"))).toThrow(/malformed/);
    expect(() => readOperatorGo(goFile({ ...GOOD_GO, who: "" }))).toThrow(/malformed/);
    expect(() => readOperatorGo(goFile({ ...GOOD_GO, when: "yesterday-ish" }))).toThrow(/malformed/);
    expect(() => readOperatorGo(goFile({ ...GOOD_GO, spendApproved: {} }))).toThrow(/malformed/);
    expect(() => readOperatorGo(goFile({ ...GOOD_GO, swarmclawForkRev: "UNSET" }))).toThrow(/malformed/);
    expect(() => readOperatorGo(goFile([GOOD_GO]))).toThrow(/malformed/);
  });

  test("a GO approving less than the worst case is refused", () => {
    const runs = composeRound({ qaGroupCapUsd: 6, codeGroupCapUsd: 8 });
    const go = goFile({ ...GOOD_GO, spendApproved: { worstCaseUsd: 25.99 } });
    expect(() => gateFire({ runs, goFile: go, forkRev: REV, print: () => {} })).toThrow(/approves \$25.99/);
  });

  test("a stale (or future-dated) GO authorizes nothing", () => {
    const runs = composeRound({ qaGroupCapUsd: 6, codeGroupCapUsd: 8 });
    const stale = goFile({ ...GOOD_GO, when: new Date(Date.now() - 25 * 3_600_000).toISOString() });
    expect(() => gateFire({ runs, goFile: stale, forkRev: REV, print: () => {} })).toThrow(/older than 24h/);
    const future = goFile({ ...GOOD_GO, when: new Date(Date.now() + 3_600_000).toISOString() });
    expect(() => gateFire({ runs, goFile: future, forkRev: REV, print: () => {} })).toThrow(/in the future/);
  });

  test("zero future tolerance: a GO dated even 1 s ahead is refused (AC7 needs go.when <= firedAt)", () => {
    const runs = composeRound({ qaGroupCapUsd: 6, codeGroupCapUsd: 8 });
    const now = Date.now();
    const ahead = goFile({ ...GOOD_GO, when: new Date(now + 1000).toISOString() });
    expect(() => gateFire({ runs, goFile: ahead, forkRev: REV, print: () => {}, now })).toThrow(/in the future/);
  });

  test("the GO must also cover the host-side gateway reflect allowance, and the spend line names it", () => {
    const runs = composeRound({ qaGroupCapUsd: 6, codeGroupCapUsd: 8 });
    expect(reflectAllowanceUsd(runs)).toBe(Math.round((QA_LENS.length + 2) * Z3_REFLECT_CALL_USD * 100) / 100);
    const fleetOnly = goFile({ ...GOOD_GO, spendApproved: { worstCaseUsd: 26 } });
    expect(() => gateFire({ runs, goFile: fleetOnly, forkRev: REV, print: () => {} })).toThrow(/fleet \+ gateway reflect/);
    expect(worstCaseSpendLine(runs)).toContain("host-side gateway reflect");
  });

  test("one GO per round: consuming it moves the file, and a second consume (or round) finds none", () => {
    const p = goFile(GOOD_GO);
    const consumed = consumeOperatorGo(p, "2026-10-19T12-00-00-000Z");
    expect(existsSync(p)).toBe(false);
    expect(JSON.parse(readFileSync(consumed, "utf8")).who).toBe(GOOD_GO.who);
    expect(() => readOperatorGo(p)).toThrow(/not recorded/);
    expect(() => consumeOperatorGo(p, "2026-10-19T12-00-00-000Z")).toThrow();
  });

  test("the upstream blockers list is empty — the round is GO-gated, not blocker-refused", () => {
    // #467 unblocked 2026-10-26: the image re-published with the sidecar
    // writer (publish run 40326654015 green), pin adopted (#474/#476),
    // verify-image-pin's verify job green (40336238552).
    expect(Z3_UPSTREAM_BLOCKERS).toEqual([]);
    expect(upstreamBlockerRefusal()).toBe("");
  });

  test("the refusal still renders by name for any future blocker", () => {
    const line = upstreamBlockerRefusal([{ issue: "#9999", url: "u", what: "w" }]);
    expect(line).toContain("#9999");
    expect(line).toContain("before any spend");
  });

  test("a GO recorded against another fork rev is refused", () => {
    const runs = composeRound({ qaGroupCapUsd: 6, codeGroupCapUsd: 8 });
    expect(() => gateFire({ runs, goFile: goFile(GOOD_GO), forkRev: "fedcba9", print: () => {} })).toThrow(/fork rev/);
  });
});
