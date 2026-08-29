/**
 * Test results runner (Story DF1.6 AC6): engine-side testCommand runner.
 *
 * Spawns a test command as an argv array (never a shell string), captures
 * stdout+stderr with a per-stream byte cap (reads start immediately — see
 * readBounded), and parses passed/failed counts from the output.
 *
 * Supported output formats:
 * - Bun test: " 7 pass\n 2 fail" (leading spaces, exact words, own lines)
 * - Jest: "Tests: 7 passed, 2 failed" (failed leads when present, then
 *   skipped/todo, then passed; zero categories are omitted, so a green run
 *   has no failed clause)
 * - Vitest default reporter: "Tests  2 failed | 4 passed (6)" (failed first,
 *   no colon; an all-green run prints only "Tests  7 passed (7)" and an
 *   all-failing run prints only "Tests  2 failed (2)" — the omitted count
 *   defaults to 0)
 *
 * Non-pass/fail categories on the Tests line (skipped/todo) are ignored:
 * jest's summary order puts them BEFORE passed, so "Tests: 1 skipped,
 * 2 passed, 3 total" parses as {passed: 2, failed: 0}.
 *
 * Fail-closed: any spawn failure, signal kill, output-cap breach, or
 * unparseable output returns {testsExecuted: false, testResults: {passed:0,
 * failed:0}} with a reason.
 *
 * Security: the child env is process.env MINUS the provider API keys
 * (ANTHROPIC_API_KEY / OPENROUTER_API_KEY) — a repo test suite has no
 * legitimate need for the orchestrator's billing credentials.
 *
 * @example
 * const result = await runTestCommand(["bun", "test", "my-test.test.ts"], {
 *   cwd: workspaceRoot,
 *   signal: abortSignal,
 * });
 */

import { EXEC_MAX_OUTPUT_BYTES, readBounded } from "../../providers/bounded-exec.ts";

/** Grace between SIGTERM and SIGKILL on the abort path. */
const TERM_GRACE_MS = 5000;

/** ANSI escape sequence regex for stripping before parsing test output. */
// biome-ignore lint/suspicious/noControlCharactersInRegex: intentional ANSI escape sequence
const ANSI_ESCAPE = /\x1b\[[0-9;]*m/g;

/** Result of running a test command. */
export interface TestCommandResult {
  /** Whether the test command ran and output was successfully parsed. */
  testsExecuted: boolean;
  /** Parsed test counts (zero when testsExecuted is false). */
  testResults: { passed: number; failed: number };
  /** Human-readable reason for failure (absent on success, sanitized, <=200 chars). */
  reason?: string;
}

/**
 * Run a test command and parse its output for passed/failed counts.
 *
 * PARSED FORMATS: the bun/jest-shaped summary (`^\s+\d+ pass\b` and its
 * `fail` counterpart). Go test output is NOT explicitly parsed — a Go repo's
 * phase reports `testsExecuted: false` and fails CLOSED unless the output
 * happens to coincide with the bun pattern. That is the intended behaviour
 * today, not an oversight: a wrong count is worse than a declared unknown.
 *
 * ponytail: one parser family, everything else fails closed. Upgrade trigger:
 * when a Go parser lands — add it beside the bun matcher and give the pinning
 * test in tests/phase-engine/test-results.test.ts its real expectation.
 *
 * @param argv - Command and arguments as an array (never a shell string)
 * @param opts.cwd - Working directory for the command
 * @param opts.signal - Optional AbortSignal to terminate the process
 * @returns Parsed test results or fail-closed error
 */
export async function runTestCommand(
  argv: string[],
  opts: { cwd: string; signal?: AbortSignal },
): Promise<TestCommandResult> {
  const { cwd, signal } = opts;

  // NOTE: no early exit for empty argv — callers handle (T7), not here

  try {
    // Child env = parent env minus the provider keys: a repo test suite has
    // no legitimate need for the orchestrator's billing credentials, and the
    // command string comes from the manifest, not from untrusted input — but
    // INV-1 discipline says secrets propagate only to their consumer.
    //
    // ponytail: Bun.spawn has no detached/process-group option, so the abort
    // path below signals the LEAD pid only; a descendant that outlives its
    // leader is bounded by its own runtime. node:child_process (which does
    // support groups) is not usable under Bun here: with a prior live child,
    // the next spawn freezes and kill(2) does not land — observed on bun
    // 1.2.22. Revisit when the runtime grows group support.
    const {
      ANTHROPIC_API_KEY: _omitAnthropic,
      OPENROUTER_API_KEY: _omitOpenrouter,
      ...env
    } = process.env;
    const proc = Bun.spawn(argv, {
      cwd,
      env,
      stdout: "pipe",
      stderr: "pipe",
    });

    // Read BOTH streams immediately (see readBounded) — before any exit wait.
    // Pass the abort signal so drain timeouts respect aborts, and proc.exited
    // so the drain backstop arms only once the child is gone.
    const stdoutRead = readBounded(proc.stdout, EXEC_MAX_OUTPUT_BYTES, { signal, exited: proc.exited });
    const stderrRead = readBounded(proc.stderr, EXEC_MAX_OUTPUT_BYTES, { signal, exited: proc.exited });

    if (signal) {
      // Named handler removed after the race: a long-lived AbortSignal reused
      // across many runs would otherwise accumulate one dead listener (and
      // its closure) per completed run.
      let onAbort: (() => void) | undefined;
      try {
        const aborted = new Promise<void>((resolve) => {
          // An AbortSignal never re-fires: an already-aborted signal must be
          // observed NOW, not after a listener that will never run.
          if (signal.aborted) return resolve();
          onAbort = () => resolve();
          signal.addEventListener("abort", onAbort, { once: true });
          // NOTE: re-check after addEventListener to close the race between
          // the early check above and the listener registration. If the signal
          // aborted during this window, resolve synchronously; the { once: true }
          // listener will simply never fire (that's fine — it can't fire twice).
          if (signal.aborted) resolve();
        });
        const exitedFirst = await Promise.race([
          proc.exited.then(() => true),
          aborted.then(() => false),
        ]);
        if (!exitedFirst) {
        // SIGTERM, grace, then SIGKILL: a test command that traps or ignores
        // SIGTERM (or sits in uninterruptible sleep) must not hang the abort
        // path — the exact case aborts exist to recover from.
        //
        // NOTE: Bun.spawn has no process-group API; we signal only the lead pid.
        // A backgrounded grandchild may outlive SIGTERM and hold the pipe open,
        // but the drain timeout (in readBounded) bounds the drain wait so we never
        // hang forever.
        try {
          // Signal the child directly. NOT `process.kill(-pid, …)`: the spawn
          // above is not detached, so the child is not a group leader and its
          // pid is not a pgid — the negative form either ESRCHes or lands on
          // whatever unrelated group holds that id.
          proc.kill("SIGTERM");
        } catch {
          // already gone
        }
        let graceTimer: ReturnType<typeof setTimeout> | undefined;
        const grace = new Promise<boolean>((resolve) => {
          graceTimer = setTimeout(() => resolve(false), TERM_GRACE_MS);
          graceTimer.unref();
        });
        const exitedDuringGrace = await Promise.race([
          proc.exited.then(() => true),
          grace,
        ]);
        if (graceTimer !== undefined) clearTimeout(graceTimer);
        if (!exitedDuringGrace) {
          // Grace expired — force-kill the child (lead pid only, as above)
          try {
            proc.kill("SIGKILL");
          } catch {
            // already gone
          }
        }
          await proc.exited; // reap the child before returning
          // Drain the readers (bounded by the cap AND DRAIN_TIMEOUT_MS) so no fd leaks.
          await Promise.allSettled([stdoutRead, stderrRead]);
          return {
            testsExecuted: false,
            testResults: { passed: 0, failed: 0 },
            reason: "Test command aborted by signal",
          };
        }
      } finally {
        // NOTE: guaranteed removal on ALL exit paths (spawn throw, reader
        // setup throw, normal resolve, abort resolve). A long-lived signal would
        // otherwise accumulate dead listeners.
        if (onAbort !== undefined) signal.removeEventListener("abort", onAbort);
      }
    }

    await proc.exited;
    const [{ text: stdout, truncated: stdoutCapped }, { text: stderr, truncated: stderrCapped }] =
      await Promise.all([stdoutRead, stderrRead]);

    // Fail-closed when the output cap was breached (checked before signal — a cap
    // breach during SIGTERM after reader.cancel() should report the cap reason,
    // not the signal).
    if (stdoutCapped || stderrCapped) {
      // Stop the producer, then refuse to parse a truncated summary.
      try {
        proc.kill("SIGKILL");
      } catch {
        // already gone
      }
      return failClosed(
        `Test output exceeded ${EXEC_MAX_OUTPUT_BYTES} byte capture cap`,
      );
    }

    // Fail-closed when the command exited on a signal. NOT proc.killed: Bun
    // reports killed === true after ANY awaited exit (observed with exit code
    // 0), so it cannot distinguish a signal death from a clean one.
    // signalCode is null exactly when the process exited under its own control.
    if (proc.signalCode !== null) {
      return failClosed(`Test command exited on signal ${proc.signalCode}`);
    }

    // Parse the output (ANSI-stripped first)
    const combined = `${stdout}\n${stderr}`.replace(ANSI_ESCAPE, "");
    const parsed = parseTestOutput(combined);
    if (!parsed) {
      return failClosed("Failed to parse test output");
    }

    return {
      testsExecuted: true,
      testResults: parsed,
    };
  } catch (error) {
    return failClosed(
      error instanceof Error ? error.message : String(error),
    );
  }
}

/** Uniform fail-closed result with a sanitized reason. */
function failClosed(reason: string): TestCommandResult {
  return {
    testsExecuted: false,
    testResults: { passed: 0, failed: 0 },
    reason: sanitizeReason(reason),
  };
}

/**
 * Parse passed/failed counts from test output.
 *
 * Matches bun test format: dedicated " 7 pass" / " 2 fail" summary lines.
 * Matches jest/vitest format: ALL "Tests" summary lines ("Tests: 7 passed,
 * 2 failed" or colon-less "Tests  2 failed | 4 passed") scanned for every
 * "<n> passed|failed" clause ON those lines. Zero categories are omitted by
 * both reporters (a green run has no failed clause, an all-failing run no
 * passed clause — the omitted count defaults to 0), and non-pass/fail
 * categories (skipped/todo) may precede them because jest's summary order
 * is failed → skipped → todo → passed: "Tests: 1 skipped, 2 passed,
 * 3 total" must parse, not fail closed.
 *
 * T2: Collects ALL lines matching the Tests anchor (handles vitest banners like
 * "⎯ Failed Tests 2 ⎯" before the summary) and prefers the LAST line with
 * passed/failed clauses (the real summary is terminal).
 *
 * T3: Bun format uses LAST match per category (summary is terminal).
 *
 * @param output - Combined stdout+stderr from the test command (ANSI-stripped)
 * @returns Parsed counts or null if unparseable
 */
function parseTestOutput(output: string): { passed: number; failed: number } | null {
  // Bun test format: lines like " 7 pass" or " 2 fail" (with leading spaces).
  // Line-anchored + word-bounded so prose like "7 passed" (jest/vitest) or a
  // filename containing "pass" can never satisfy the bun branch.
  // Real output: " 7 pass\n 0 fail\n 7 expect() calls\nRan 7 tests..."
  // T3: Use LAST match per category — bun's summary is terminal.
  const bunPassMatches = output.matchAll(/^\s*(\d+)\s+pass\b/mg);
  const bunFailMatches = output.matchAll(/^\s*(\d+)\s+fail\b/mg);

  // Convert to array and take last match
  const bunPassMatch = Array.from(bunPassMatches).at(-1);
  const bunFailMatch = Array.from(bunFailMatches).at(-1);

  if (bunPassMatch || bunFailMatch) {
    const bunPassed = bunPassMatch ? Number.parseInt(bunPassMatch[1] ?? "0", 10) : 0;
    const bunFailed = bunFailMatch ? Number.parseInt(bunFailMatch[1] ?? "0", 10) : 0;
    if (!Number.isSafeInteger(bunPassed) || !Number.isSafeInteger(bunFailed)) {
      return null;
    }
    return { passed: bunPassed, failed: bunFailed };
  }

  // Jest/Vitest summary: capture ALL "Tests" lines, then read every
  // "<n> passed|failed" clause ON those lines. T2: A banner line like
  // "⎯ Failed Tests 2 ⎯" matches the anchor but has no clauses — we skip
  // those and prefer the LAST line with actual passed/failed data.
  const testsLines = output.match(/Tests[:\s][^\n]*/g) ?? [];
  let passed: number | undefined;
  let failed: number | undefined;
  for (const line of testsLines) {
    let linePassed: number | undefined;
    let lineFailed: number | undefined;
    for (const clause of line.matchAll(/(\d+)\s+(passed|failed)/g)) {
      const count = Number.parseInt(clause[1] ?? "0", 10);
      // Fail closed on ANY non-safe-integer count (same rule as the bun
      // branch above): skipping the clause here would fabricate a 0 for the
      // unsafe category while a sibling safe count still parses — the run
      // would report testsExecuted:true with invented numbers.
      if (!Number.isSafeInteger(count)) return null;
      if (clause[2] === "passed") {
        if (linePassed === undefined) linePassed = count;
      } else if (lineFailed === undefined) {
        lineFailed = count;
      }
    }
    // If this line has real data (not just a banner), remember it
    if (linePassed !== undefined || lineFailed !== undefined) {
      passed = linePassed;
      failed = lineFailed;
    }
  }
  if (passed !== undefined || failed !== undefined) {
    return { passed: passed ?? 0, failed: failed ?? 0 };
  }

  // No match
  return null;
}

/**
 * Sanitize a reason string for the error field.
 * - Caps at 200 characters
 * - No verbatim output (already sanitized at call sites)
 */
function sanitizeReason(reason: string | undefined): string {
  if (!reason) return "Unknown error";
  const sanitized = reason.trim();
  if (sanitized.length <= 200) {
    return sanitized;
  }
  return `${sanitized.slice(0, 197)}...`;
}

/**
 * Coerce testsExecuted to false when sum===0 (story invariant enforcement).
 *
 * The contract: consumers MUST reject output where testResults.passed +
 * testResults.failed === 0 and testsExecuted is absent or true. This helper
 * enforces that invariant at the boundary, converting true→false when sum===0.
 *
 * @param result - The test command result to coerce
 * @returns The same result with testsExecuted coerced if needed
 */
export function coerceTestsExecuted(result: TestCommandResult): TestCommandResult {
  if (result.testResults.passed + result.testResults.failed === 0) {
    return { ...result, testsExecuted: false };
  }
  return result;
}

/**
 * Zero result constant for "no testCommand" case.
 * Callers (dispatch-task T7) use this instead of spawning nothing.
 */
export const ZERO_TEST_RESULTS: TestCommandResult = {
  testsExecuted: false,
  testResults: { passed: 0, failed: 0 },
};
