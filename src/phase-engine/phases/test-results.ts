/**
 * Test results runner (Story DF1.6 AC6): engine-side testCommand runner.
 *
 * Spawns a test command as an argv array (never a shell string), captures
 * stdout+stderr with a per-stream byte cap (reads start immediately — see
 * readCapped), and parses passed/failed counts from the output.
 *
 * Supported output formats:
 * - Bun test: " 7 pass\n 2 fail" (leading spaces, exact words, own lines)
 * - Jest: "Tests: 7 passed, 2 failed" (passed first; green runs omit the
 *   failed clause)
 * - Vitest default reporter: "Tests  2 failed | 4 passed (6)" (failed first,
 *   no colon; an all-green run prints only "Tests  7 passed (7)" and an
 *   all-failing run prints only "Tests  2 failed (2)" — the omitted count
 *   defaults to 0)
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

/** Per-stream capture cap. Far above any legitimate summary; a runaway test
 * binary spewing output must not grow engine memory without bound. */
const MAX_CAPTURE_BYTES = 512 * 1024;

/** Grace between SIGTERM and SIGKILL on the abort path. */
const TERM_GRACE_MS = 5000;

/**
 * Read a piped stdio stream to text, stopping hard at `cap` bytes.
 *
 * Started IMMEDIATELY after spawn: awaiting the exit race first would leave
 * the pipe undrained — a chatty test binary fills the 64 KiB pipe buffer,
 * blocks on write, and the exit being awaited never happens (deadlock).
 */
async function readCapped(
  stream: ReadableStream<Uint8Array> | number | undefined,
  cap: number,
): Promise<{ text: string; capped: boolean }> {
  if (stream === undefined || typeof stream === "number") {
    return { text: "", capped: false };
  }
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let text = "";
  let bytes = 0;
  let capped = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    if (bytes > cap) {
      capped = true;
      await reader.cancel().catch(() => {
        // stream already closed
      });
      break;
    }
    text += decoder.decode(value, { stream: true });
  }
  if (!capped) {
    text += decoder.decode(); // flush any trailing partial multibyte char
  }
  return { text, capped };
}

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

  // ponytail: no early exit for empty argv — callers handle (T7), not here

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

    // Read BOTH streams immediately (see readCapped) — before any exit wait.
    const stdoutRead = readCapped(proc.stdout, MAX_CAPTURE_BYTES);
    const stderrRead = readCapped(proc.stderr, MAX_CAPTURE_BYTES);

    if (signal) {
      // Named handler removed after the race: a long-lived AbortSignal reused
      // across many runs would otherwise accumulate one dead listener (and
      // its closure) per completed run.
      let onAbort: (() => void) | undefined;
      const aborted = new Promise<void>((resolve) => {
        // An AbortSignal never re-fires: an already-aborted signal must be
        // observed NOW, not after a listener that will never run.
        if (signal.aborted) return resolve();
        onAbort = () => resolve();
        signal.addEventListener("abort", onAbort, { once: true });
      });
      const exitedFirst = await Promise.race([
        proc.exited.then(() => true),
        aborted.then(() => false),
      ]);
      if (onAbort !== undefined) signal.removeEventListener("abort", onAbort);
      if (!exitedFirst) {
        // SIGTERM, grace, then SIGKILL: a test command that traps or ignores
        // SIGTERM (or sits in uninterruptible sleep) must not hang the abort
        // path — the exact case aborts exist to recover from.
        try {
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
          try {
            proc.kill("SIGKILL");
          } catch {
            // already gone
          }
        }
        await proc.exited; // reap the child before returning
        // Drain the readers (bounded by the cap) so no fd leaks.
        await Promise.allSettled([stdoutRead, stderrRead]);
        return {
          testsExecuted: false,
          testResults: { passed: 0, failed: 0 },
          reason: "Test command aborted by signal",
        };
      }
    }

    await proc.exited;
    const [{ text: stdout, capped: stdoutCapped }, { text: stderr, capped: stderrCapped }] =
      await Promise.all([stdoutRead, stderrRead]);

    // Fail-closed when the command exited on a signal. NOT proc.killed: Bun
    // reports killed === true after ANY awaited exit (observed with exit code
    // 0), so it cannot distinguish a signal death from a clean one.
    // signalCode is null exactly when the process exited under its own control.
    if (proc.signalCode !== null) {
      return failClosed(`Test command exited on signal ${proc.signalCode}`);
    }

    if (stdoutCapped || stderrCapped) {
      // Stop the producer, then refuse to parse a truncated summary.
      try {
        proc.kill("SIGKILL");
      } catch {
        // already gone
      }
      return failClosed(
        `Test output exceeded ${MAX_CAPTURE_BYTES} byte capture cap`,
      );
    }

    // Parse the output
    const parsed = parseTestOutput(`${stdout}\n${stderr}`);
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
 * Matches jest/vitest format: "Tests: 7 passed, 2 failed" (jest, passed
 * first) or "Tests  2 failed | 4 passed" (vitest default reporter, failed
 * first, colon-less); a green run omits the failed clause and an all-failing
 * run omits the passed clause — the omitted count defaults to 0 in both
 * directions.
 *
 * @param output - Combined stdout+stderr from the test command
 * @returns Parsed counts or null if unparseable
 */
function parseTestOutput(output: string): { passed: number; failed: number } | null {
  // Bun test format: lines like " 7 pass" or " 2 fail" (with leading spaces).
  // Line-anchored + word-bounded so prose like "7 passed" (jest/vitest) or a
  // filename containing "pass" can never satisfy the bun branch.
  // Real output: " 7 pass\n 0 fail\n 7 expect() calls\nRan 7 tests..."
  const bunPassMatch = output.match(/^\s*(\d+)\s+pass\b/m);
  const bunFailMatch = output.match(/^\s*(\d+)\s+fail\b/m);

  if (bunPassMatch && bunFailMatch) {
    return {
      passed: Number.parseInt(bunPassMatch[1] ?? "0", 10),
      failed: Number.parseInt(bunFailMatch[1] ?? "0", 10),
    };
  }

  // Jest/Vitest summary. Jest puts passed first ("Tests:       7 passed,
  // 2 failed, 9 total"); vitest puts failed first ("Tests  2 failed |
  // 4 passed (6)"). The failed clause is optional on green runs ("Tests:
  // 7 passed, 7 total", "Tests  7 passed (7)") — a green suite must parse
  // with failed=0, not fail closed. Both counts anchor to the SAME "Tests"
  // line and never cross a newline: jest's earlier "Test Suites: 1 failed"
  // and vitest's "Test Files  2 failed" lines must not donate their counts.
  const passedFirst = output.match(
    /Tests[:\s]+(\d+)\s+passed(?:[^\n\d]+(\d+)\s+failed)?/,
  );
  if (passedFirst) {
    return {
      passed: Number.parseInt(passedFirst[1] ?? "0", 10),
      failed: passedFirst[2] ? Number.parseInt(passedFirst[2], 10) : 0,
    };
  }
  // The passed clause is optional here too: an all-failing run omits the
  // zero "passed" count (jest: "Tests: 2 failed, 9 total"; vitest: "Tests
  // 2 failed (2)"), and passed defaults to 0 — the DF1.6 seeded-failing-test
  // path must parse, not fail closed as "tests did not run".
  const failedFirst = output.match(
    /Tests[:\s]+(\d+)\s+failed(?:[^\n\d]+(\d+)\s+passed)?/,
  );
  if (failedFirst) {
    return {
      passed: failedFirst[2] ? Number.parseInt(failedFirst[2], 10) : 0,
      failed: Number.parseInt(failedFirst[1] ?? "0", 10),
    };
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
