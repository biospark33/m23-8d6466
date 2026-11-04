/**
 * P1.9 — deterministic failure classification + restart policy + caps.
 *
 * Covers the pure core (classifyFailure / evaluateRestart / runWithRestart)
 * and the phase-settle integration (PhaseRecord.restart audit trail).
 * INV-RESTART-2 (classification is a pure, deterministic function) and
 * INV-RESTART-1 (caps enforced atomically, cannot be bypassed) are asserted
 * directly; the audit-trail invariant (INV-RESTART-3) is asserted through the
 * journal rows the phase engine writes.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { classifyFailure, FailureSignalSchema, type FailureSignal } from "../../src/phase-engine/failure-signal.ts";
import {
  DEFAULT_RESTART_CAPS,
  evaluateRestart,
  MAX_BACKOFF_MS,
  RestartDecisionSchema,
  runWithRestart,
} from "../../src/phase-engine/restart-policy.ts";
import type { CapExceededError } from "../../src/phase-engine/restart-policy.ts";
import { FileJournal } from "../../src/phase-engine/journal.ts";
import { Run, walkPhases, type PhaseBody, type PhaseSpec } from "../../src/phase-engine/index.ts";

let seq = 0;
function tmpJournalPath(): string {
  return join(mkdtempSync(join(realpathSync(tmpdir()), "p19-")), `journal-${seq++}.jsonl`);
}

/** An Error carrying a FailureSignal — how steps hand the executor their signal (INV-RESTART-2: the signal is data, not instruction). */
function newSignalError(signal: FailureSignal): Error & { failureSignal: FailureSignal } {
  return Object.assign(new Error(signal.message), { failureSignal: signal });
}

// ─── classifyFailure — determinism + the deterministic rules ────────────────

describe("classifyFailure (P1.9 AC1, INV-RESTART-2)", () => {
  test("timeout signal classifies transient", () => {
    expect(classifyFailure({ type: "timeout", message: "step exceeded 30000ms" })).toBe("transient");
  });

  test("token-overflow type classifies overflow", () => {
    expect(classifyFailure({ type: "token-overflow", message: "context window exhausted" })).toBe("overflow");
  });

  test("token arithmetic beats the label: tokensUsed > maxTokens is overflow even for type timeout", () => {
    expect(
      classifyFailure({ type: "timeout", message: "m", tokensUsed: 900_000, maxTokens: 800_000 }),
    ).toBe("overflow");
  });

  test("http-status codes 408/429/5xx classify transient; anything else logic", () => {
    for (const code of [408, 429, 500, 502, 503, 504]) {
      expect(classifyFailure({ type: "http-status", message: "upstream", code })).toBe("transient");
    }
    expect(classifyFailure({ type: "http-status", message: "bad request", code: 400 })).toBe("logic");
  });

  test("assertion / exception / unknown types fail closed to logic", () => {
    expect(classifyFailure({ type: "assertion", message: "assert x === y" })).toBe("logic");
    expect(classifyFailure({ type: "schema-violation", message: "missing field" })).toBe("logic");
    expect(classifyFailure({ type: "exception", message: "TypeError: x is not a function" })).toBe("logic");
    expect(classifyFailure({ type: "something-never-seen", message: "mystery" })).toBe("logic");
  });

  test("deterministic: the same signal always produces the same class (100 iterations)", () => {
    const signal: FailureSignal = { type: "http-status", message: "rate limited", code: 429 };
    const first = classifyFailure(signal);
    for (let i = 0; i < 100; i++) {
      expect(classifyFailure(signal)).toBe(first);
    }
  });

  test("FailureSignalSchema rejects unknown keys (strictObject)", () => {
    expect(FailureSignalSchema.safeParse({ type: "timeout", message: "m", extra: 1 }).success).toBe(false);
    expect(FailureSignalSchema.safeParse({ type: "timeout", message: "m" }).success).toBe(true);
    expect(FailureSignalSchema.safeParse({ type: "", message: "m" }).success).toBe(false);
  });
});

// ─── evaluateRestart — backoff, caps, class branches ─────────────────────────

describe("evaluateRestart (P1.9 AC2/AC3/AC4)", () => {
  test("fresh transient retries with the 2s initial backoff", () => {
    const d = evaluateRestart({ type: "timeout", message: "m" }, { retriesUsed: 0, wallClockMs: 0 });
    expect(d.class).toBe("transient");
    expect(d.shouldRetry).toBe(true);
    expect(d.nextBackoffMs).toBe(2000);
    expect(d.retriesRemaining).toBe(DEFAULT_RESTART_CAPS.maxRetries);
    expect(d.wallClockRemainingMs).toBe(DEFAULT_RESTART_CAPS.maxWallClockMs);
  });

  test("transient backoff doubles and saturates at MAX_BACKOFF_MS", () => {
    const seq: number[] = [];
    for (let used = 0; used < 8; used++) {
      const d = evaluateRestart({ type: "timeout", message: "m" }, { retriesUsed: used, wallClockMs: 0 });
      expect(d.shouldRetry).toBe(true);
      seq.push(d.nextBackoffMs as number);
    }
    expect(seq).toEqual([2000, 4000, 8000, 16000, 32000, MAX_BACKOFF_MS, MAX_BACKOFF_MS, MAX_BACKOFF_MS]);
    expect(MAX_BACKOFF_MS).toBe(60_000);
  });

  test("transient at the 8-retry cap refuses and reports cap-exceeded", () => {
    const d = evaluateRestart({ type: "timeout", message: "m" }, { retriesUsed: 8, wallClockMs: 1000 });
    expect(d.shouldRetry).toBe(false);
    expect(d.reason).toBe("cap-exceeded");
    expect(d.retriesRemaining).toBe(0);
  });

  test("transient past the 1h wall-clock cap refuses, even with retries left", () => {
    const d = evaluateRestart(
      { type: "timeout", message: "m" },
      { retriesUsed: 1, wallClockMs: DEFAULT_RESTART_CAPS.maxWallClockMs },
    );
    expect(d.shouldRetry).toBe(false);
    expect(d.reason).toBe("cap-exceeded");
    expect(d.wallClockRemainingMs).toBe(0);
  });

  test("overflow retries immediately (no backoff) with reduced scope", () => {
    const d = evaluateRestart({ type: "token-overflow", message: "m" }, { retriesUsed: 2, wallClockMs: 500 });
    expect(d.class).toBe("overflow");
    expect(d.shouldRetry).toBe(true);
    expect(d.nextBackoffMs).toBeUndefined();
    expect(d.reducedScope).toBe(true);
  });

  test("overflow at a cap also refuses with cap-exceeded", () => {
    const d = evaluateRestart({ type: "token-overflow", message: "m" }, { retriesUsed: 8, wallClockMs: 0 });
    expect(d.shouldRetry).toBe(false);
    expect(d.reason).toBe("cap-exceeded");
  });

  test("logic never retries", () => {
    const d = evaluateRestart({ type: "assertion", message: "wrong output" }, { retriesUsed: 0, wallClockMs: 0 });
    expect(d.class).toBe("logic");
    expect(d.shouldRetry).toBe(false);
    expect(d.reason).toBeUndefined();
    expect(d.nextBackoffMs).toBeUndefined();
  });

  test("explicit class override wins over the signal's own classification (declared exitStatus seam)", () => {
    const d = evaluateRestart(
      { type: "exit-status", message: "dispatch declared it" },
      { class: "transient", retriesUsed: 0, wallClockMs: 0 },
    );
    expect(d.class).toBe("transient");
    expect(d.shouldRetry).toBe(true);
    expect(d.nextBackoffMs).toBe(2000);
  });

  test("custom caps are honoured (and stay above the floor)", () => {
    const d = evaluateRestart(
      { type: "timeout", message: "m" },
      { retriesUsed: 2, wallClockMs: 0, caps: { maxRetries: 2, maxWallClockMs: 60_000 } },
    );
    expect(d.shouldRetry).toBe(false);
    expect(d.reason).toBe("cap-exceeded");
  });
});

// ─── runWithRestart — the cross-run retry executor ──────────────────────────

describe("runWithRestart (P1.9 AC2/AC4 e2e demo)", () => {
  test("transient failing 3 times succeeds on retry 4, every attempt classified + logged", async () => {
    const events: Array<Record<string, unknown>> = [];
    let calls = 0;
    const result = await runWithRestart(
      () => {
        calls++;
        if (calls <= 3) throw newSignalError({ type: "timeout", message: `blip ${calls}` });
        return "done";
      },
      { runId: "r1", stepId: "s1", sleep: async () => {}, onEvent: (e) => events.push(e as Record<string, unknown>) },
    );
    expect(result).toBe("done");
    expect(calls).toBe(4);
    const classifications = events.filter((e) => e.event === "restart_classification");
    expect(classifications).toHaveLength(3);
    for (const c of classifications) expect(c.class).toBe("transient");
    expect(events.some((e) => e.event === "restart_succeeded" && (e.attempt as number) === 4)).toBe(true);
  });

  test("logic error halts immediately: exactly one attempt, no sleeps", async () => {
    const sleeps: number[] = [];
    let calls = 0;
    await expect(
      runWithRestart(
        () => {
          calls++;
          throw newSignalError({ type: "assertion", message: "logic bomb" });
        },
        { runId: "r2", stepId: "s2", sleep: async (ms): Promise<void> => { sleeps.push(ms); } },
      ),
    ).rejects.toThrow("logic bomb");
    expect(calls).toBe(1);
    expect(sleeps).toEqual([]);
  });

  test("always-transient step exhausts the 8-retry cap and halts with cap-exceeded", async () => {
    const events: Array<Record<string, unknown>> = [];
    const sleeps: number[] = [];
    let calls = 0;
    try {
      await runWithRestart(
        () => {
          calls++;
          throw newSignalError({ type: "timeout", message: "forever" });
        },
        {
          runId: "r3",
          stepId: "s3",
          sleep: async (ms): Promise<void> => {
            sleeps.push(ms);
          },
          onEvent: (e) => events.push(e as Record<string, unknown>),
        },
      );
      expect.unreachable();
    } catch (err) {
      expect((err as CapExceededError).name).toBe("CapExceededError");
      expect((err as CapExceededError).reason).toBe("cap-exceeded");
    }
    // initial attempt + 8 retries, never a 9th retry
    expect(calls).toBe(DEFAULT_RESTART_CAPS.maxRetries + 1);
    expect(events.some((e) => e.event === "restart_cap_exceeded")).toBe(true);
    expect(events.filter((e) => e.event === "restart_classification")).toHaveLength(DEFAULT_RESTART_CAPS.maxRetries + 1);
    // backoff schedule ran between attempts, saturated at 60s
    expect(sleeps.length).toBe(DEFAULT_RESTART_CAPS.maxRetries);
    expect(sleeps[4]).toBe(32_000);
    expect(sleeps[5]).toBe(MAX_BACKOFF_MS);
  });

  test("wall-clock cap stops retries mid-flight (fake wall clock)", async () => {
    let fakeNow = 0;
    const events: Array<Record<string, unknown>> = [];
    let calls = 0;
    try {
      await runWithRestart(
        () => {
          calls++;
          fakeNow += 20 * 60_000; // each attempt burns 20 minutes
          throw newSignalError({ type: "timeout", message: "slow" });
        },
        {
          runId: "r4",
          stepId: "s4",
          now: () => fakeNow,
          sleep: async () => {},
          onEvent: (e) => events.push(e as Record<string, unknown>),
        },
      );
      expect.unreachable();
    } catch (err) {
      expect((err as CapExceededError).reason).toBe("cap-exceeded");
    }
    // attempt 1 (0→20m), retry at 20m (→40m), retry at 40m (→60m): that third
    // evaluation sees wallClockMs ≥ cap and refuses. 3 attempts total.
    expect(calls).toBe(3);
    expect(events.some((e) => e.event === "restart_cap_exceeded")).toBe(true);
  });

  test("overflow retries immediately with reducedScope, and succeeds", async () => {
    const events: Array<Record<string, unknown>> = [];
    let calls = 0;
    const result = await runWithRestart(
      () => {
        calls++;
        if (calls === 1) throw newSignalError({ type: "token-overflow", message: "context exhausted" });
        return "ok";
      },
      { runId: "r5", stepId: "s5", onEvent: (e) => events.push(e as Record<string, unknown>) },
    );
    expect(result).toBe("ok");
    expect(calls).toBe(2);
    const first = events.find((e) => e.event === "restart_decision") as
      | { decision: Record<string, unknown> }
      | undefined;
    expect(first?.decision.reducedScope).toBe(true);
    expect(first?.decision.nextBackoffMs).toBeUndefined();
  });
  test("reducedScope threads from the decision, not the attempt ordinal: transient retries run full scope, overflow retries don't", async () => {
    const scopeByCall: boolean[] = [];
    let calls = 0;
    await runWithRestart(
      (stepOpts) => {
        calls++;
        scopeByCall.push(stepOpts.reducedScope);
        if (calls <= 2) throw newSignalError({ type: "timeout", message: "transient blip" });
        return "done";
      },
      { runId: "r6", stepId: "s6", sleep: async () => {} },
    );
    expect(scopeByCall).toEqual([false, false, false]);
    let overflowCalls = 0;
    await runWithRestart(
      (stepOpts) => {
        overflowCalls++;
        if (overflowCalls === 1) throw newSignalError({ type: "token-overflow", message: "too big" });
        expect(stepOpts.reducedScope).toBe(true);
        return "ok";
      },
      { runId: "r7", stepId: "s7" },
    );
    expect(overflowCalls).toBe(2);
  });

  test("CapExceededError preserves the last attempt's original error as cause", async () => {
    const root = new Error("root failure");
    try {
      await runWithRestart(() => {
        throw Object.assign(new Error("wrapper"), { failureSignal: { type: "timeout", message: "m" }, cause: root });
      }, { runId: "r8", stepId: "s8", sleep: async () => {}, caps: { maxRetries: 1, maxWallClockMs: 60_000 } });
      expect.unreachable();
    } catch (err) {
      expect((err as CapExceededError).name).toBe("CapExceededError");
      // The cause is the last attempt's own thrown value (the wrapper), which
      // itself carries the root as its cause — nothing is swallowed.
      const cause = (err as CapExceededError).cause as Error;
      expect(cause.message).toBe("wrapper");
      expect((cause.cause as Error).message).toBe("root failure");
    }
  });

  test("evaluateRestart clamps hostile numerics (negative/fractional inputs stay within caps and schema)", () => {
    const d = evaluateRestart({ type: "timeout", message: "m" }, { retriesUsed: -3.5, wallClockMs: -1000 });
    expect(d.retriesRemaining).toBeLessThanOrEqual(DEFAULT_RESTART_CAPS.maxRetries);
    expect(d.wallClockRemainingMs).toBeLessThanOrEqual(DEFAULT_RESTART_CAPS.maxWallClockMs);
    expect(d.nextBackoffMs).toBe(2000);
    expect(RestartDecisionSchema.safeParse(d).success).toBe(true);
  });
  test("a backoff that would start the next attempt past the wall-clock cap refuses (INV-RESTART-1)", () => {
    // 59:59 elapsed, 1s remaining: the 2s initial backoff would land past 1h.
    const d = evaluateRestart(
      { type: "timeout", message: "m" },
      { retriesUsed: 0, wallClockMs: DEFAULT_RESTART_CAPS.maxWallClockMs - 1_000 },
    );
    expect(d.shouldRetry).toBe(false);
    expect(d.reason).toBe("cap-exceeded");
  });
});

// ─── phase-settle integration — the journal audit trail (INV-RESTART-3) ─────

describe("phase settle restart audit (P1.9 integration)", () => {
  test("a throwing phase journals fail with restart.class logic and the failure signal", async () => {
    const journalPath = tmpJournalPath();
    const runId = "restart-audit-throw";
    const journal = new FileJournal(journalPath, runId);
    const run = new Run({
      ctx: { runId, pipelineId: "restart-demo", requestId: "req-restart" },
      journal,
      log: () => {},
    });
    const phases: PhaseSpec[] = [
      { name: "explode", kind: "code", description: "Throw deterministically", maxDurationMs: 15_000, retries: 0, command: ["true"] },
    ];
    const bodies: (spec: PhaseSpec) => PhaseBody<unknown> = () => () => {
      throw new Error("body exploded");
    };
    await walkPhases(run, phases, bodies);
    const row = journal.phases().find((p) => p.name === "explode");
    expect(row?.status).toBe("fail");
    expect(row?.restart?.class).toBe("logic");
    expect(row?.restart?.signal.type).toBe("exception");
    expect(row?.restart?.decision.shouldRetry).toBe(false);
  });

  test("a wall-clock-overflowed phase journals restart.class transient (timeout signal, AC1)", async () => {
    const journalPath = tmpJournalPath();
    const runId = "restart-audit-timeout";
    const journal = new FileJournal(journalPath, runId);
    const run = new Run({
      ctx: { runId, pipelineId: "restart-demo", requestId: "req-restart-timeout" },
      journal,
      log: () => {},
    });
    const phases: PhaseSpec[] = [
      {
        name: "hang",
        kind: "code",
        description: "Hang past the attempt timer",
        maxDurationMs: 40,
        retries: 0,
        command: ["true"],
      },
    ];
    const bodies: (spec: PhaseSpec) => PhaseBody<unknown> = () =>
      // Resolves only on abort — the engine's timer aborts at 40ms and the
      // settle proceeds without waiting out the cancel grace.
      (bodyCtx) =>
        new Promise((resolve) => {
          bodyCtx.signal.addEventListener("abort", () => resolve("too late"), { once: true });
        });
    await walkPhases(run, phases, bodies);
    const row = journal.phases().find((p) => p.name === "hang");
    expect(row?.exitStatus).toBe("overflow"); // engine attempt-verdict, unchanged
    expect(row?.restart?.class).toBe("transient"); // P1.9 signal-space classification
    expect(row?.restart?.signal.type).toBe("timeout");
  });

  test("a phase whose body declares exitStatus transient gets restart.class transient via the explicit seam", async () => {
    const journalPath = tmpJournalPath();
    const runId = "restart-audit-declared";
    const journal = new FileJournal(journalPath, runId);
    const run = new Run({
      ctx: { runId, pipelineId: "restart-demo", requestId: "req-restart-declared" },
      journal,
      log: () => {},
    });
    const phases: PhaseSpec[] = [
      {
        name: "declared-transient",
        kind: "code",
        description: "Return a declared transient verdict",
        maxDurationMs: 15_000,
        retries: 0,
        command: ["true"],
      },
    ];
    const bodies: (spec: PhaseSpec) => PhaseBody<unknown> = () => () =>
      Promise.resolve({ exitStatus: "transient", error: { message: "dispatch said transient" } });
    await walkPhases(run, phases, bodies);
    const row = journal.phases().find((p) => p.name === "declared-transient");
    expect(row?.exitStatus).toBe("transient");
    expect(row?.restart?.class).toBe("transient");
    expect(row?.restart?.decision.shouldRetry).toBe(true);
  });

  test("lead_failure declares no P1.9 classification (own escalation lane)", async () => {
    const journalPath = tmpJournalPath();
    const runId = "restart-audit-lead";
    const journal = new FileJournal(journalPath, runId);
    const run = new Run({
      ctx: { runId, pipelineId: "restart-demo", requestId: "req-restart-lead" },
      journal,
      log: () => {},
    });
    const phases: PhaseSpec[] = [
      {
        name: "lead-fail",
        kind: "code",
        description: "Return a declared lead_failure verdict",
        maxDurationMs: 15_000,
        retries: 0,
        command: ["true"],
      },
    ];
    const bodies: (spec: PhaseSpec) => PhaseBody<unknown> = () => () =>
      Promise.resolve({ exitStatus: "lead_failure", error: { message: "lead died" } });
    await walkPhases(run, phases, bodies);
    const row = journal.phases().find((p) => p.name === "lead-fail");
    expect(row?.exitStatus).toBe("lead_failure");
    expect(row?.restart).toBeUndefined();
  });
});
