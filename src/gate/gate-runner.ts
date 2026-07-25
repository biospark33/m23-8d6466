/**
 * Phase-0 exit gate runner (Story P0.11).
 *
 * Orchestration only — it knows nothing about any individual Phase-0 story.
 * Assertion modules supply `check()` closures; this module decides ordering,
 * timeouts, concurrency, and the single binary verdict.
 *
 * Semantics that are deliberate, not incidental:
 *
 *  - A SKIP is NOT a pass. "Could not check" is the failure mode an exit gate
 *    exists to catch, so an unproven assertion makes the gate red. Phase-0's
 *    verification history is full of probe-passes that were not acceptance
 *    (see the P0.6 story's PARTIAL AC table); the gate must not repeat that.
 *  - A VOID clause is excluded from the verdict entirely. Those are PRD §13
 *    clauses whose predecessor story was killed by the Warren decision — they
 *    are recorded for traceability so a reader can see the clause was dropped
 *    on purpose rather than silently forgotten.
 *  - A gate with no live assertions is FAIL, never a vacuous PASS.
 *  - Every failure carries its own detail string. PRD-driven AC2 requires the
 *    failing assertion be named, not summarised as "checks failed".
 */
import { z } from "zod";

/** 30 s per assertion (story "Guards/limits"). */
export const DEFAULT_ASSERTION_TIMEOUT_MS = 30_000;
/** 600 s for the whole gate (story "Guards/limits"). */
export const DEFAULT_TOTAL_TIMEOUT_MS = 600_000;
/** Bounded so a wide gate cannot stampede the services it is probing. */
export const DEFAULT_CONCURRENCY = 4;

export type GateStatus = "pass" | "fail" | "skip" | "void";

/**
 * What an assertion's `check()` returns.
 *
 * `skip: true` means "this could not be evaluated" — it is reported distinctly
 * from a failure so the report is diagnosable, but it still fails the gate.
 */
export interface GateCheckOutcome {
  pass: boolean;
  skip?: boolean;
  detail?: string;
}

export interface GateAssertion {
  /** Stable identifier, e.g. "P0.7-mcp-bridge". Printed on failure. */
  id: string;
  /** Predecessor story, e.g. "P0.7". */
  story: string;
  /** PRD clause this traces to, e.g. "§13 P0 clause 6". */
  prd_clause: string;
  description: string;
  /**
   * "preflight" assertions run first as a barrier; if any is not green the
   * remaining assertions are skipped rather than attempted (story AC3 —
   * fail fast, never hang waiting on downstream timeouts).
   */
  group: "preflight" | "main";
  check: () => Promise<GateCheckOutcome>;
  /**
   * Per-assertion budget override. Some checks legitimately exceed the 30 s
   * default — the P0.6 LSP harness alone budgets ~55 s for a cold server plus
   * 20 warm samples. Declaring it here keeps the runner's advertised guard
   * TRUE for every assertion instead of quietly false for the slow ones.
   *
   * Checks MUST NOT block the event loop (no `spawnSync`), or no timeout can
   * preempt them — use async spawning.
   */
  timeout_ms?: number;
  /**
   * Set only for PRD clauses dropped because their story was killed. Presence
   * makes the clause VOID: `check` is never invoked and the verdict ignores it.
   */
  void_reason?: string;
}

export interface GateAssertionResult {
  id: string;
  story: string;
  prd_clause: string;
  status: GateStatus;
  /** Convenience mirror of `status === "pass"` (story contract field). */
  pass: boolean;
  detail?: string;
  duration_ms: number;
}

export interface GateReport {
  timestamp: string;
  overall: "PASS" | "FAIL";
  assertions: GateAssertionResult[];
  summary: { pass: number; fail: number; skip: number; void: number };
  total_duration_ms: number;
}

export const GateAssertionSchema = z.object({
  id: z.string().min(1),
  story: z.string().min(1),
  prd_clause: z.string().min(1),
  description: z.string().min(1),
  group: z.enum(["preflight", "main"]),
  check: z.function(),
  timeout_ms: z.number().positive().optional(),
  void_reason: z.string().min(1).optional(),
});

export const GateAssertionResultSchema = z.object({
  id: z.string().min(1),
  story: z.string().min(1),
  prd_clause: z.string().min(1),
  status: z.enum(["pass", "fail", "skip", "void"]),
  pass: z.boolean(),
  detail: z.string().optional(),
  duration_ms: z.number().nonnegative(),
});

export const GateReportSchema = z.object({
  timestamp: z.string().datetime(),
  overall: z.enum(["PASS", "FAIL"]),
  assertions: z.array(GateAssertionResultSchema),
  summary: z.object({
    pass: z.number().int().nonnegative(),
    fail: z.number().int().nonnegative(),
    skip: z.number().int().nonnegative(),
    void: z.number().int().nonnegative(),
  }),
  total_duration_ms: z.number().nonnegative(),
});

export interface RunGateOptions {
  assertionTimeoutMs?: number;
  totalTimeoutMs?: number;
  concurrency?: number;
}

/** Distinguishes a budget expiry from a genuine throw inside a check. */
class AssertionTimeoutError extends Error {}

function describeThrow(err: unknown): string {
  if (err instanceof Error) return err.message;
  return typeof err === "string" ? err : JSON.stringify(err);
}

export async function runGate(
  assertions: readonly GateAssertion[],
  options: RunGateOptions = {},
): Promise<GateReport> {
  const assertionTimeoutMs = options.assertionTimeoutMs ?? DEFAULT_ASSERTION_TIMEOUT_MS;
  const totalTimeoutMs = options.totalTimeoutMs ?? DEFAULT_TOTAL_TIMEOUT_MS;
  const concurrency = Math.max(1, options.concurrency ?? DEFAULT_CONCURRENCY);

  const startedAt = Date.now();
  // Indexed by input position so the report preserves the caller's ordering
  // even though execution is reordered (preflight first) and concurrent.
  const settled: Array<GateAssertionResult | undefined> = assertions.map(() => undefined);
  const liveTimers = new Set<ReturnType<typeof setTimeout>>();
  let budgetExpired = false;

  function record(index: number, result: GateAssertionResult): void {
    if (settled[index] === undefined) settled[index] = result;
  }

  function base(a: GateAssertion): Omit<GateAssertionResult, "status" | "pass" | "duration_ms"> {
    return { id: a.id, story: a.story, prd_clause: a.prd_clause };
  }

  // VOID clauses settle up front; their checks are never invoked.
  assertions.forEach((a, i) => {
    if (a.void_reason !== undefined) {
      record(i, {
        ...base(a),
        status: "void",
        pass: false,
        detail: `VOID — ${a.void_reason}`,
        duration_ms: 0,
      });
    }
  });

  const runnable = assertions
    .map((a, i) => ({ a, i }))
    .filter(({ a }) => a.void_reason === undefined);
  const preflight = runnable.filter(({ a }) => a.group === "preflight");
  const mainGroup = runnable.filter(({ a }) => a.group !== "preflight");

  async function runOne({ a, i }: { a: GateAssertion; i: number }): Promise<void> {
    const t0 = Date.now();
    const budgetMs = a.timeout_ms ?? assertionTimeoutMs;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      // The timeout promise is constructed FIRST so its timer is registered
      // before the check starts. (It would still be armed either way, since a
      // compliant check yields to the event loop — but a check that blocked
      // the loop could otherwise finish before the timer was ever scheduled.)
      const deadline = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new AssertionTimeoutError(`timed out after ${budgetMs}ms`)),
          budgetMs,
        );
        liveTimers.add(timer);
      });
      const outcome = await Promise.race<GateCheckOutcome>([
        // Wrapped so a check that throws synchronously still rejects rather
        // than escaping the race.
        (async () => a.check())(),
        deadline,
      ]);
      const isSkip = outcome.skip === true;
      record(i, {
        ...base(a),
        status: isSkip ? "skip" : outcome.pass ? "pass" : "fail",
        pass: !isSkip && outcome.pass,
        detail: outcome.detail,
        duration_ms: Date.now() - t0,
      });
    } catch (err) {
      const detail =
        err instanceof AssertionTimeoutError
          ? err.message
          : `check threw: ${describeThrow(err)}`;
      record(i, { ...base(a), status: "fail", pass: false, detail, duration_ms: Date.now() - t0 });
    } finally {
      if (timer !== undefined) {
        clearTimeout(timer);
        liveTimers.delete(timer);
      }
    }
  }

  async function runPooled(items: Array<{ a: GateAssertion; i: number }>): Promise<void> {
    let cursor = 0;
    const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
      while (true) {
        // Stop claiming work once the total budget has blown. Without this the
        // pool keeps spawning children long after the gate has reported, and
        // the process lingers well past its stated total timeout.
        if (budgetExpired) return;
        const index = cursor++;
        const item = items[index];
        if (item === undefined) return;
        await runOne(item);
      }
    });
    await Promise.all(workers);
  }

  async function runAll(): Promise<void> {
    await runPooled(preflight);
    const preflightGreen = preflight.every(({ i }) => settled[i]?.status === "pass");
    if (!preflightGreen) {
      // AC3: fail fast. Downstream assertions are still LISTED (so the report
      // is complete) but never attempted — no waiting on service timeouts.
      for (const { a, i } of mainGroup) {
        record(i, {
          ...base(a),
          status: "skip",
          pass: false,
          detail: "not attempted — preflight assertion(s) did not pass (fail-fast)",
          duration_ms: 0,
        });
      }
      return;
    }
    await runPooled(mainGroup);
  }

  // Declared before runPooled runs so the pool can observe expiry and stop
  // claiming new items (see runPooled).
  let budgetTimer: ReturnType<typeof setTimeout> | undefined;
  const budgetHit = new Promise<void>((resolve) => {
    budgetTimer = setTimeout(() => {
      budgetExpired = true;
      resolve();
    }, totalTimeoutMs);
    liveTimers.add(budgetTimer);
  });

  try {
    await Promise.race([runAll(), budgetHit]);
  } finally {
    if (budgetTimer !== undefined) {
      clearTimeout(budgetTimer);
      liveTimers.delete(budgetTimer);
    }
    // A check that outlived the total budget still holds its own timer; drop
    // them all so the process is not kept alive by abandoned work.
    for (const t of liveTimers) clearTimeout(t);
    liveTimers.clear();
  }

  if (budgetExpired) {
    assertions.forEach((a, i) => {
      record(i, {
        ...base(a),
        status: "fail",
        pass: false,
        detail: `gate total budget of ${totalTimeoutMs}ms expired before this assertion settled`,
        duration_ms: Date.now() - startedAt,
      });
    });
  }

  const results = settled.map((r, i) => {
    if (r !== undefined) return r;
    const a = assertions[i]!;
    return {
      ...base(a),
      status: "fail" as const,
      pass: false,
      detail: "assertion never produced a result",
      duration_ms: 0,
    };
  });

  const summary = {
    pass: results.filter((r) => r.status === "pass").length,
    fail: results.filter((r) => r.status === "fail").length,
    skip: results.filter((r) => r.status === "skip").length,
    void: results.filter((r) => r.status === "void").length,
  };

  // VOID clauses are excluded from the verdict; an all-void (or empty) gate
  // proved nothing and is therefore FAIL, not a vacuous PASS.
  const live = results.filter((r) => r.status !== "void");
  const overall: "PASS" | "FAIL" =
    live.length > 0 && live.every((r) => r.status === "pass") ? "PASS" : "FAIL";

  return {
    timestamp: new Date(startedAt).toISOString(),
    overall,
    assertions: results,
    summary,
    total_duration_ms: Date.now() - startedAt,
  };
}
