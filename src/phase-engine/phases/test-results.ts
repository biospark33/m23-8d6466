/**
 * Test results runner (Story DF1.6 AC6): engine-side testCommand runner.
 *
 * Spawns a test command as an argv array (never a shell string), captures
 * stdout+stderr, and parses passed/failed counts from the output.
 *
 * Supported output formats:
 * - Bun test: " 7 pass\n 2 fail" (leading spaces, exact words)
 * - Jest/Vitest: "Tests: 7 passed, 2 failed"
 *
 * Fail-closed: any spawn failure, signal kill, or unparseable output returns
 * {testsExecuted: false, testResults: {passed:0, failed:0}} with a reason.
 *
 * @example
 * const result = await runTestCommand(["bun", "test", "my-test.test.ts"], {
 *   cwd: workspaceRoot,
 *   signal: abortSignal,
 * });
 */

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

  let proc: ReturnType<typeof Bun.spawn> | null = null;
  try {
    proc = Bun.spawn(argv, {
      cwd,
      stdout: "pipe",
      stderr: "pipe",
      env: process.env,
    });

    // Watch for abort signal
    if (signal) {
      const aborted = new Promise<void>((resolve) => {
        signal.addEventListener("abort", () => resolve(), { once: true });
      });
      const raced = await Promise.race([proc.exited, aborted]);
      if (raced === undefined) {
        // Aborted: kill the process
        try {
          if (proc.pid) {
            process.kill(proc.pid, "SIGTERM");
          }
        } catch {
          // Ignore kill errors
        }
        // Reap the child before returning — an un-awaited exit promise
        // leaves the subprocess unreaped for the remainder of the run.
        await proc.exited;
        return {
          testsExecuted: false,
          testResults: { passed: 0, failed: 0 },
          reason: "Test command aborted by signal",
        };
      }
    }

    // Capture output (Bun.spawn returns fd or stream)
    const stdout =
      typeof proc.stdout === "number"
        ? ""
        : await new Response(proc.stdout).text();
    const stderr =
      typeof proc.stderr === "number"
        ? ""
        : await new Response(proc.stderr).text();
    const combined = `${stdout}\n${stderr}`;

    // Fail-closed when the command exited on a signal. NOT proc.killed: Bun
    // reports killed === true after ANY awaited exit (observed with exit code
    // 0), so it cannot distinguish a signal death from a clean one.
    // signalCode is null exactly when the process exited under its own control.
    if (proc.signalCode !== null) {
      return {
        testsExecuted: false,
        testResults: { passed: 0, failed: 0 },
        reason: `Test command exited on signal ${proc.signalCode}`,
      };
    }

    // Parse the output
    const parsed = parseTestOutput(combined);
    if (!parsed) {
      return {
        testsExecuted: false,
        testResults: { passed: 0, failed: 0 },
        reason: sanitizeReason("Failed to parse test output"),
      };
    }

    return {
      testsExecuted: true,
      testResults: parsed,
    };
  } catch (error) {
    return {
      testsExecuted: false,
      testResults: { passed: 0, failed: 0 },
      reason: sanitizeReason(
        error instanceof Error ? error.message : String(error),
      ),
    };
  }
}

/**
 * Parse passed/failed counts from test output.
 *
 * Matches bun test format: " 7 pass\n 2 fail"
 * Matches jest/vitest format: "Tests: 7 passed, 2 failed"
 *
 * @param output - Combined stdout+stderr from the test command
 * @returns Parsed counts or null if unparseable
 */
function parseTestOutput(output: string): { passed: number; failed: number } | null {
  // Bun test format: lines like " 7 pass" or " 2 fail" (with leading spaces)
  // Real output: " 7 pass\n 0 fail\n 7 expect() calls\nRan 7 tests..."
  const bunPassMatch = output.match(/(\d+)\s+pass/);
  const bunFailMatch = output.match(/(\d+)\s+fail/);

  if (bunPassMatch && bunFailMatch) {
    return {
      passed: Number.parseInt(bunPassMatch[1] ?? "0", 10),
      failed: Number.parseInt(bunFailMatch[1] ?? "0", 10),
    };
  }

  // Jest/Vitest format: "Tests: 7 passed, 2 failed"
  const jestMatch = output.match(
    /Tests?:\s*(\d+)\s+passed[^,]*,\s*(\d+)\s+failed/,
  );
  if (jestMatch) {
    return {
      passed: Number.parseInt(jestMatch[1] ?? "0", 10),
      failed: Number.parseInt(jestMatch[2] ?? "0", 10),
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
