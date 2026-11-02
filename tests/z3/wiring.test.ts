/**
 * Z3 live wiring — the pure halves, fixture tier: the fork CLI `state`
 * contract (zod over the fork's own projection, tests/z3/fixtures/fork-state.json
 * — E-1/A-1/B-1: no field may silently default), the armed-config gate
 * (A-2/B-2, B-18/E-10), and the cancel timeout sized to the fork's worst case
 * (E-7). The substrate-touching halves run only in the live round.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  ARM_LEAD_MS,
  armedCapsProblems,
  waitFindingsRecallable,
  FORK_ARM_TIMEOUT_MS,
  FORK_CANCEL_TIMEOUT_MS,
  FORK_CLI_TIMEOUT_MS,
  FORK_DISARM_TIMEOUT_MS,
  FLEET_CLI_TIMEOUT_MS,
  ForkStateSchema,
  IN_CONTAINER_KILL_MARGIN_MS,
  armZ3Schedule,
  healMidFlightTeardown,
  Z3_CLEANUP_STEPS_MS,
  Z3_FORK_STEPS_BUDGET_MS,
  Z3_LIVE_BUDGET,
  Z3_ROUND_SLACK_MS,
} from "../../scripts/z3/live-round-wiring.ts";
import { codePollTimeoutFor, composeRound } from "../../scripts/z3/round-plan.ts";

const forkState = JSON.parse(readFileSync(path.join(import.meta.dir, "fixtures", "fork-state.json"), "utf8")) as Record<string, unknown>;
const run0 = (forkState.runs as Record<string, unknown>[])[0] as Record<string, unknown>;

describe("fork state contract", () => {
  test("the fork CLI's own state projection parses: epoch-ms createdAt, artifacts, events, schedules", () => {
    const s = ForkStateSchema.parse(forkState);
    expect(s.runs[0]?.createdAt).toBe(1_760_875_200_000);
    expect(s.runs[0]?.artifacts[0]?.kind).toBe("factory_result");
    expect(s.runs[0]?.factoryState["qa-observe-correctness"]?.runId).toBe("qds-20261019-aaaaa1");
    expect(s.schedules[0]?.status).toBe("active");
  });

  test("a missing contract field fails loudly — never an empty default (artifacts, events, steps, factoryState, schedules)", () => {
    for (const k of ["artifacts", "events", "steps", "factoryState"]) {
      const { [k]: _gone, ...rest } = run0;
      expect(ForkStateSchema.safeParse({ ...forkState, runs: [rest] }).success).toBe(false);
    }
    const { schedules: _s, ...noSchedules } = forkState;
    expect(ForkStateSchema.safeParse(noSchedules).success).toBe(false);
    expect(ForkStateSchema.safeParse({ ...forkState, runs: [{ ...run0, createdAt: "2026-10-19T12:00:00Z" }] }).success).toBe(false);
  });
});

describe("armed config gate", () => {
  test("the persisted read-back must carry exactly the GO-gated caps and the round's code poll deadline", () => {
    const want = { qaGroupCapUsd: 6, codeGroupCapUsd: 8, codePollTimeoutMs: 7_200_000 };
    expect(armedCapsProblems({ templateId: "z3_exit_round", ...want }, want)).toEqual([]);
    expect(armedCapsProblems({ templateId: "z3_exit_round", qaGroupCapUsd: 25, codeGroupCapUsd: 40, codePollTimeoutMs: 7_200_000 }, want)).toHaveLength(2);
    expect(armedCapsProblems({ templateId: "z3_exit_round", ...want, codePollTimeoutMs: 3_600_000 }, want)).toHaveLength(1);
    expect(armedCapsProblems({ templateId: "qa_hunter_pack", ...want }, want)).toHaveLength(1);
  });

  test("the armed reviewSet must equal the round's pinned set — absent, wrong set, and order-insensitive match (scope-derivation amendment)", () => {
    const base = { qaGroupCapUsd: 6, codeGroupCapUsd: 8 };
    const set = ["scripts/z3/round-plan.ts", "tests/z3/wiring.test.ts"];
    expect(armedCapsProblems({ templateId: "z3_exit_round", ...base, reviewSet: set }, { ...base, reviewSet: set })).toEqual([]);
    // order-insensitive: git's path order is stable but not contractual
    expect(armedCapsProblems({ templateId: "z3_exit_round", ...base, reviewSet: [...set].reverse() }, { ...base, reviewSet: set })).toEqual([]);
    expect(armedCapsProblems({ templateId: "z3_exit_round", ...base }, { ...base, reviewSet: set })).toHaveLength(1);
    expect(armedCapsProblems({ templateId: "z3_exit_round", ...base, reviewSet: ["src/other.ts"] }, { ...base, reviewSet: set })).toHaveLength(1);
  });
});

describe("budgets add up (E-4/B-10)", () => {
  test("the cancel timeout covers the fork's reported floor (1 submit × 300 s + one 300 s verify = 660 s)", () => {
    expect(FORK_CANCEL_TIMEOUT_MS).toBeGreaterThanOrEqual(660_000);
  });

  test("the cleanup budget covers the sum of its worst-case steps, recomputed here from the configured timeouts", () => {
    const outage = 180_000;
    const independent =
      FORK_DISARM_TIMEOUT_MS + FORK_CLI_TIMEOUT_MS + // disarm + re-read
      2 * FORK_CANCEL_TIMEOUT_MS + // ≤ 2 protocol-run cancels
      outage + FORK_CLI_TIMEOUT_MS + // sweep
      FLEET_CLI_TIMEOUT_MS + // parallel destroy
      5 * 60_000 + // revoke-verify
      2 * (60_000 + outage + FORK_CLI_TIMEOUT_MS) + // final inventory + re-sweep, twice
      FLEET_CLI_TIMEOUT_MS + // parallel leftover destroy
      FORK_DISARM_TIMEOUT_MS + FORK_CLI_TIMEOUT_MS + // end residue re-check
      FORK_CANCEL_TIMEOUT_MS + // a late cancel
      outage + FORK_CLI_TIMEOUT_MS; // the crash watcher standing down before cleanup
    expect(Object.values(Z3_CLEANUP_STEPS_MS).reduce((a, b) => a + b, 0)).toBe(independent);
    expect(Z3_LIVE_BUDGET.cleanupMs).toBeGreaterThanOrEqual(independent);
  });

  test("the test timeout covers every pre-round term (arm lead included), the fork steps + slack, cleanup and margin", () => {
    const b = Z3_LIVE_BUDGET;
    // recomputed independently from the configured constants, not from Z3_LIVE_BUDGET's own fields
    const pre = 8 * 60_000 + FORK_CLI_TIMEOUT_MS + 2 * 60_000 + 60_000 + ARM_LEAD_MS;
    expect(b.testTimeoutMs).toBeGreaterThanOrEqual(pre + Z3_FORK_STEPS_BUDGET_MS + Z3_ROUND_SLACK_MS + b.cleanupMs + 10 * 60_000);
    expect(b.roundMs).toBeGreaterThan(Z3_FORK_STEPS_BUDGET_MS); // slack beyond the fork deadlines
    expect(codePollTimeoutFor(Z3_FORK_STEPS_BUDGET_MS, composeRound({ qaGroupCapUsd: 1, codeGroupCapUsd: 1 }))).toBeGreaterThanOrEqual(60 * 60_000);
  });

  test("the arm lead covers the arm timeout, the in-container kill margin and a second sweep", () => {
    expect(ARM_LEAD_MS).toBeGreaterThanOrEqual(FORK_ARM_TIMEOUT_MS + IN_CONTAINER_KILL_MARGIN_MS + FORK_CLI_TIMEOUT_MS + FORK_DISARM_TIMEOUT_MS);
  });

  test("the schedule's runAt lead outlasts the arm's own timeout (a timed-out arm is swept before it fires)", () => {
    expect(ARM_LEAD_MS).toBeGreaterThan(FORK_ARM_TIMEOUT_MS);
  });
});

describe("arm failure sweep (N-1)", () => {
  const state = (schedules: string[], runs: Array<{ id: string; scheduleId: string }> = []) => ({
    schedules: schedules.map((id) => ({ id, status: "active" })),
    runs: runs.map((r) => ({ ...run0, id: r.id, scheduleId: r.scheduleId })),
    writtenAt: 1,
  });

  test("a timed-out arm whose row persists LATE (after the first sweep's read) is swept by the second sweep", () => {
    const calls: string[] = [];
    let stateReads = 0;
    const cli = (args: string[]) => {
      calls.push(args.join(" "));
      if (args[0] === "arm") throw new Error("fork CLI arm failed (exit null): timed out");
      if (args[0] === "state") {
        stateReads++;
        // first sweep: only the pre-existing schedule; the in-container arm persists before the second read
        return stateReads === 1 ? state(["sch-old"]) : state(["sch-old", "sch-late"], [{ id: "pr-late", scheduleId: "sch-late" }]);
      }
      if (args[0] === "disarm") return { disarmed: false, firedRunId: null };
      if (args[0] === "cancel") return { cancelled: true, fleetCancelled: [], inFlightRequestIds: [] };
      throw new Error(`unexpected ${args[0]}`);
    };
    let err: unknown;
    try {
      armZ3Schedule({ config: {}, participants: "a1" }, ["sch-old"], cli, () => {});
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(AggregateError);
    expect((err as AggregateError).cause).toBeInstanceOf(Error);
    expect(String((err as Error).message)).toContain("sch-late");
    expect(calls).toContain("disarm sch-late");
    expect(calls).toContain("cancel pr-late");
    expect(calls.some((c) => c === "disarm sch-old")).toBe(false); // never a schedule this round did not arm
  });
});

describe("waitFindingsRecallable — the release waits for the last retain to be recallable", () => {
  const okProbe = (recalls: unknown[]) => {
    let i = 0;
    return {
      recall: async () => recalls[Math.min(i++, recalls.length - 1)],
      sleep: async () => {},
      deadlineMs: Date.now() + 60_000,
    };
  };
  test("true when the first probe already surfaces a round doc id", async () => {
    const probe = okProbe([{ results: [{ documentId: "qds-x-1" }, { documentId: "qds-y-9" }] }]);
    expect(await waitFindingsRecallable({ bank: "b", docIds: ["qds-y-9"] }, probe)).toBe(true);
  });
  test("keeps polling until a later probe surfaces one (the mid-ingestion window)", async () => {
    const probe = okProbe([{ results: [{ documentId: "old-doc" }] }, { results: [{ documentId: "qds-y-9" }] }]);
    expect(await waitFindingsRecallable({ bank: "b", docIds: ["qds-y-9"] }, probe)).toBe(true);
  });
  test("false when the bound passes with zero overlap (refuses the release upstream)", async () => {
    let i = 0;
    const probe = {
      recall: async () => ({ results: [{ documentId: `old-${i++}` }] }),
      sleep: async () => {},
      deadlineMs: Date.now() + 100,
      cadenceMs: 1,
    };
    expect(await waitFindingsRecallable({ bank: "b", docIds: ["qds-y-9"] }, probe)).toBe(false);
  });
  test("true with no doc ids owed (nothing retained this round)", async () => {
    const probe = okProbe([{ results: [] }]);
    expect(await waitFindingsRecallable({ bank: "b", docIds: [] }, probe)).toBe(true);
  });
  test("a probe that throws keeps polling (a blip is not a verdict)", async () => {
    let calls = 0;
    const probe = {
      recall: async () => {
        calls++;
        if (calls === 1) throw new Error("blip");
        return { results: [{ documentId: "qds-y-9" }] };
      },
      sleep: async () => {},
      deadlineMs: Date.now() + 60_000,
    };
    expect(await waitFindingsRecallable({ bank: "b", docIds: ["qds-y-9"] }, probe)).toBe(true);
    expect(calls).toBe(2);
  });
});

describe("healMidFlightTeardown", () => {
  function tmpRunsDir(): string {
    return mkdtempSync(path.join(tmpdir(), "z3-heal-"));
  }

  test("stale dead-pid lock is cleared and one --no-harvest teardown retries", () => {
    const dir = tmpRunsDir();
    const lock = path.join(dir, "qds-x.lock");
    writeFileSync(lock, "999999 dead-host 2026-11-02T00:00:00Z 7e\n");
    const calls: string[][] = [];
    const heal = healMidFlightTeardown({
      runId: "qds-x",
      runsDir: dir,
      fleet: (args, _t) => {
        calls.push(args);
        return { exitCode: 0, stdout: "torn down: qds-x", stderr: "" };
      },
      deadline: Date.now() + 60_000,
      pastDeadline: () => {},
    });
    expect(heal).not.toBeNull();
    expect(heal?.exitCode).toBe(0);
    expect(calls.length).toBe(1);
    expect(calls[0]?.join(" ")).toContain("--no-harvest");
    expect(existsSync(lock)).toBe(false);
    rmSync(dir, { recursive: true, force: true });
  });

  test("a LIVE holder owns the lock — never touched, no retry", () => {
    const dir = tmpRunsDir();
    const lock = path.join(dir, "qds-live.lock");
    writeFileSync(lock, `${process.pid} live-host 2026-11-02T00:00:00Z 7e\n`);
    const calls: string[][] = [];
    const heal = healMidFlightTeardown({
      runId: "qds-live",
      runsDir: dir,
      fleet: (args) => {
        calls.push(args);
        return { exitCode: 0, stdout: "", stderr: "" };
      },
      deadline: Date.now() + 60_000,
      pastDeadline: () => {},
    });
    expect(heal).toBeNull();
    expect(calls.length).toBe(0);
    expect(existsSync(lock)).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });

  test("no lock file at all — retry proceeds without a clear", () => {
    const dir = tmpRunsDir();
    const calls: string[][] = [];
    const heal = healMidFlightTeardown({
      runId: "qds-bare",
      runsDir: dir,
      fleet: (args) => {
        calls.push(args);
        return { exitCode: 6, stdout: "", stderr: "still wedged" };
      },
      deadline: Date.now() + 60_000,
      pastDeadline: () => {},
    });
    expect(heal).not.toBeNull();
    expect(heal?.exitCode).toBe(6);
    expect(calls.length).toBe(1);
    expect(calls[0]?.join(" ")).toContain("--no-harvest");
    rmSync(dir, { recursive: true, force: true });
  });

  test("a past deadline stands the heal down via pastDeadline", () => {
    const dir = tmpRunsDir();
    const calls: string[][] = [];
    let named = "";
    expect(() =>
      healMidFlightTeardown({
        runId: "qds-late",
        runsDir: dir,
        fleet: (args) => {
          calls.push(args);
          return { exitCode: 0, stdout: "", stderr: "" };
        },
        deadline: Date.now() - 1_000,
        pastDeadline: (what) => {
          named = what;
          throw new Error(`past deadline: ${what}`);
        },
      }),
    ).toThrow("past deadline");
    expect(named).toContain("teardown heal");
    expect(calls.length).toBe(0);
    rmSync(dir, { recursive: true, force: true });
  });
});
