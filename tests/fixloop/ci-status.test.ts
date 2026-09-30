/**
 * DF6.1b — the CI-verdict poll suite (three-invocation composition, SHA-bound).
 *
 * Every leg drives `pollRequiredChecks` / `probeRequiredChecks` in-process with
 * a scripted fake `gh` runner — no network, no real timers (sleep is injected
 * and resolves immediately; the clock is injected). The REAL `gh` surface is
 * exercised once by the G5 gate against PR #389, read-only.
 *
 * Legs: green-settles · red-then-green · ci-red (failed checks named) ·
 * never-settles (window expiry → ci-verdict-unavailable, never green) ·
 * stale-sha (poll discarded whole, no transition) · intermediate-sha ·
 * sha-changes-between-reads · registration lag (empty required set inside the
 * window is pending, never the empty-set refusal) · required-only (an advisory
 * lint red outside the required set never blocks) · exit 8 = pending tick ·
 * malformed output fails closed · the attempt-start probe's empty-set refusal.
 */
import { describe, expect, test } from "bun:test";

import {
  CI_POLL_INTERVAL_MS,
  CI_POLL_WINDOW_MS,
  ghRunnerFromToken,
  parseChecksJson,
  pollRequiredChecks,
  probeRequiredChecks,
  type GhResult,
  type GhRunner,
} from "../../src/fixloop/ci-status.ts";

const SHA = "c".repeat(40);
const STALE = "a".repeat(40);
const INTERMEDIATE = "b".repeat(40);
const PR = 7;

/** A scripted gh: one entry per invocation, in order. */
function scriptGh(steps: GhResult[], calls?: string[]): GhRunner {
  let i = 0;
  return async (argv) => {
    calls?.push(argv.join(" "));
    const step = steps[i++];
    if (step === undefined) throw new Error(`fake gh exhausted after ${i - 1} calls`);
    return step;
  };
}

const view = (sha: string): GhResult => ({
  exitCode: 0,
  stdout: JSON.stringify({ headRefOid: sha, headRefName: "qds/parent1" }),
  stderr: "",
});
const checks = (buckets: Record<string, string>, exitCode = 0): GhResult => ({
  exitCode,
  stdout: JSON.stringify(Object.entries(buckets).map(([name, bucket]) => ({ name, state: "COMPLETED", bucket }))),
  stderr: "",
});
const EMPTY_MESSAGE: GhResult = {
  exitCode: 1,
  stdout: "",
  stderr: "no required checks reported on the 'qds/parent1' branch",
};

/** A clock that advances `stepMs` per read, starting at the epoch base. */
function tickingClock(stepMs: number, startMs = 1_000_000_000_000): () => Date {
  let t = startMs;
  return () => {
    const d = new Date(t);
    t += stepMs;
    return d;
  };
}

const NO_SLEEP = async () => {};

describe("parseChecksJson", () => {
  test("parses the gh pr checks --json shape into {name,bucket} entries", () => {
    const out = parseChecksJson(JSON.stringify([{ name: "ci", state: "COMPLETED", bucket: "pass" }]));
    expect(out).toEqual([{ name: "ci", state: "COMPLETED", bucket: "pass" }]);
  });

  test("fails closed on malformed output — never an empty-green", () => {
    expect(() => parseChecksJson("no required checks reported on the 'x' branch")).toThrow();
    expect(() => parseChecksJson("[]")).not.toThrow();
  });
});

describe("pollRequiredChecks — the termination matrix", () => {
  test("green-settles: all required buckets pass on an SHA-bound poll → green, checks named", async () => {
    const calls: string[] = [];
    const verdict = await pollRequiredChecks({
      prNumber: PR,
      attemptSha: SHA,
      windowOpenedAt: new Date(1_000_000_000_000).toISOString(),
      gh: scriptGh([view(SHA), checks({ ci: "pass", lint: "pass" }), view(SHA)], calls),
      now: tickingClock(1000),
      sleep: NO_SLEEP,
    });
    expect(verdict.kind).toBe("green");
    if (verdict.kind === "green") {
      expect(verdict.checks.sort()).toEqual(["ci", "lint"]);
      expect(verdict.polls).toBe(1);
    }
    // the three-invocation composition, in order
    expect(calls).toEqual([
      `pr view ${PR} --json headRefOid,headRefName`,
      `pr checks ${PR} --required --json name,state,bucket`,
      `pr view ${PR} --json headRefOid,headRefName`,
    ]);
  });

  test("red-then-green: a pending first tick retried, green on the second", async () => {
    const verdict = await pollRequiredChecks({
      prNumber: PR,
      attemptSha: SHA,
      windowOpenedAt: new Date(1_000_000_000_000).toISOString(),
      gh: scriptGh([
        view(SHA), checks({ ci: "pending" }), view(SHA),
        view(SHA), checks({ ci: "pass" }), view(SHA),
      ]),
      now: tickingClock(1000),
      sleep: NO_SLEEP,
    });
    expect(verdict.kind).toBe("green");
    if (verdict.kind === "green") expect(verdict.polls).toBe(2);
  });

  test("ci-red: a settled non-pass required bucket is the named failure, never green", async () => {
    const verdict = await pollRequiredChecks({
      prNumber: PR,
      attemptSha: SHA,
      windowOpenedAt: new Date(1_000_000_000_000).toISOString(),
      gh: scriptGh([view(SHA), checks({ ci: "pass", e2e: "fail" }), view(SHA)]),
      now: tickingClock(1000),
      sleep: NO_SLEEP,
    });
    expect(verdict.kind).toBe("ci-red");
    if (verdict.kind === "ci-red") {
      expect(verdict.failedChecks.map((c) => c.name)).toEqual(["e2e"]);
    }
  });

  test("never-settles: a window that expires with pending checks is ci-verdict-unavailable, NEVER green", async () => {
    // the window opened CI_POLL_WINDOW_MS before the first read → expired immediately
    const opened = new Date(1_000_000_000_000 - CI_POLL_WINDOW_MS - 1);
    const verdict = await pollRequiredChecks({
      prNumber: PR,
      attemptSha: SHA,
      windowOpenedAt: opened.toISOString(),
      gh: scriptGh([view(SHA), checks({ ci: "pending" }), view(SHA)]),
      now: () => new Date(1_000_000_000_000),
      sleep: NO_SLEEP,
    });
    expect(verdict.kind).toBe("ci-verdict-unavailable");
    if (verdict.kind === "ci-verdict-unavailable") expect(verdict.reason).toMatch(/window/i);
  });

  test("never-settles (slow): pending polls consume the window tick by tick, then expire", async () => {
    const pendingSteps: GhResult[] = [];
    for (let i = 0; i < 5; i++) pendingSteps.push(view(SHA), checks({ ci: "pending" }), view(SHA));
    const verdict = await pollRequiredChecks({
      prNumber: PR,
      attemptSha: SHA,
      windowOpenedAt: new Date(1_000_000_000_000).toISOString(),
      // each poll cycle costs a fifth of the window
      gh: scriptGh(pendingSteps),
      now: tickingClock(CI_POLL_WINDOW_MS / 4),
      sleep: NO_SLEEP,
    });
    expect(verdict.kind).toBe("ci-verdict-unavailable");
  });

  test("stale-sha: a poll carrying another commit's sha is discarded whole and changes no state", async () => {
    const verdict = await pollRequiredChecks({
      prNumber: PR,
      attemptSha: SHA,
      windowOpenedAt: new Date(1_000_000_000_000).toISOString(),
      // green checks exist — but on the WRONG sha; never a green
      gh: scriptGh([view(STALE), checks({ ci: "pass" }), view(STALE)]),
      now: tickingClock(CI_POLL_WINDOW_MS / 2),
      sleep: NO_SLEEP,
    });
    expect(verdict.kind).toBe("ci-verdict-unavailable");
  });

  test("intermediate-sha: a mid-push sha on the post-checks read discards the whole poll", async () => {
    const verdict = await pollRequiredChecks({
      prNumber: PR,
      attemptSha: SHA,
      windowOpenedAt: new Date(1_000_000_000_000).toISOString(),
      gh: scriptGh([view(SHA), checks({ ci: "pass" }), view(INTERMEDIATE)]),
      now: tickingClock(CI_POLL_WINDOW_MS / 2),
      sleep: NO_SLEEP,
    });
    expect(verdict.kind).toBe("ci-verdict-unavailable");
  });

  test("sha-changes-between-reads: head moved under the checks read — discarded whole", async () => {
    const verdict = await pollRequiredChecks({
      prNumber: PR,
      attemptSha: SHA,
      windowOpenedAt: new Date(1_000_000_000_000).toISOString(),
      gh: scriptGh([view(INTERMEDIATE), checks({ ci: "pass" }), view(SHA)]),
      now: tickingClock(CI_POLL_WINDOW_MS / 2),
      sleep: NO_SLEEP,
    });
    expect(verdict.kind).toBe("ci-verdict-unavailable");
  });

  test("registration lag: an empty required set INSIDE the window is pending and retried, never the refusal", async () => {
    const verdict = await pollRequiredChecks({
      prNumber: PR,
      attemptSha: SHA,
      windowOpenedAt: new Date(1_000_000_000_000).toISOString(),
      gh: scriptGh([
        view(SHA), EMPTY_MESSAGE, view(SHA),
        checks({ ci: "pass" }), view(SHA),
      ]),
      now: tickingClock(1000),
      sleep: NO_SLEEP,
    });
    expect(verdict.kind).toBe("green");
  });

  test("required-only: an advisory lint red outside the required set never blocks a green", async () => {
    // gh pr checks --required does the filtering host-side; the fake models the
    // filtered output — the advisory lint is absent, so the poll is green.
    const verdict = await pollRequiredChecks({
      prNumber: PR,
      attemptSha: SHA,
      windowOpenedAt: new Date(1_000_000_000_000).toISOString(),
      gh: scriptGh([view(SHA), checks({ ci: "pass" }), view(SHA)]),
      now: tickingClock(1000),
      sleep: NO_SLEEP,
    });
    expect(verdict.kind).toBe("green");
  });

  test("exit 8 is a pending tick, never a hard failure", async () => {
    const verdict = await pollRequiredChecks({
      prNumber: PR,
      attemptSha: SHA,
      windowOpenedAt: new Date(1_000_000_000_000).toISOString(),
      gh: scriptGh([
        view(SHA), checks({ ci: "pending" }, 8), view(SHA),
        view(SHA), checks({ ci: "pass" }), view(SHA),
      ]),
      now: tickingClock(1000),
      sleep: NO_SLEEP,
    });
    expect(verdict.kind).toBe("green");
  });

  test("malformed checks output fails closed — unavailable, never green", async () => {
    const verdict = await pollRequiredChecks({
      prNumber: PR,
      attemptSha: SHA,
      windowOpenedAt: new Date(1_000_000_000_000).toISOString(),
      gh: scriptGh([view(SHA), { exitCode: 0, stdout: "not json", stderr: "" }, view(SHA)]),
      now: tickingClock(1000),
      sleep: NO_SLEEP,
    });
    expect(verdict.kind).toBe("ci-verdict-unavailable");
    if (verdict.kind === "ci-verdict-unavailable") expect(verdict.reason).toMatch(/malformed|parse/i);
  });

  test("the poll sleeps CI_POLL_INTERVAL_MS between ticks (real cadence bounded)", async () => {
    const slept: number[] = [];
    const verdict = await pollRequiredChecks({
      prNumber: PR,
      attemptSha: SHA,
      windowOpenedAt: new Date(1_000_000_000_000).toISOString(),
      gh: scriptGh([
        view(SHA), checks({ ci: "pending" }), view(SHA),
        view(SHA), checks({ ci: "pass" }), view(SHA),
      ]),
      now: tickingClock(1000),
      sleep: async (ms) => {
        slept.push(ms);
      },
    });
    expect(verdict.kind).toBe("green");
    expect(slept).toEqual([CI_POLL_INTERVAL_MS]);
  });

  test("a missing gh binary surfaces as the unavailable verdict, never a green", async () => {
    const verdict = await pollRequiredChecks({
      prNumber: PR,
      attemptSha: SHA,
      windowOpenedAt: new Date(1_000_000_000_000).toISOString(),
      gh: async () => {
        throw new Error("spawn gh ENOENT");
      },
      now: tickingClock(1000),
      sleep: NO_SLEEP,
    });
    expect(verdict.kind).toBe("ci-verdict-unavailable");
  });
});

describe("probeRequiredChecks — the attempt-start empty-set probe", () => {
  test("the gh 'no required checks' message is the refusal mechanism: present=false", async () => {
    const probe = await probeRequiredChecks({ prNumber: PR, gh: scriptGh([EMPTY_MESSAGE]) });
    expect(probe.present).toBe(false);
  });

  test("a populated required set is present", async () => {
    const probe = await probeRequiredChecks({ prNumber: PR, gh: scriptGh([checks({ ci: "pending" })]) });
    expect(probe.present).toBe(true);
    if (probe.present) {
      expect(probe.checks).toEqual(["ci"]);
      expect(probe.entries[0]?.bucket).toBe("pending");
    }
  });

  test("an unreadable probe fails closed — a typed error, never 'present'", async () => {
    await expect(
      probeRequiredChecks({
        prNumber: PR,
        gh: async () => {
          throw new Error("spawn gh ENOENT");
        },
      }),
    ).rejects.toThrow(/gh/);
  });
});

describe("ghRunnerFromToken", () => {
  test("builds a runner that resolves a real `gh --version` (binary present, token in child env only)", async () => {
    const runner = ghRunnerFromToken("tok-smoke");
    const res = await runner(["--version"]);
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toMatch(/^gh version/);
  });
});
