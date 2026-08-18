/**
 * Test results runner (Story DF1.6 AC6): engine-side testCommand runner.
 *
 * Spawns a test command as an argv array (never a shell string), captures
 * stdout+stderr with a per-stream byte cap (reads start immediately — see
 * readCapped), and parses passed/failed counts from the output.
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

/** Per-stream capture cap. Far above any legitimate summary; a runaway test
 * binary spewing output must not grow engine memory without bound. */
const MAX_CAPTURE_BYTES = 512 * 1024;

/** Grace between SIGTERM and SIGKILL on the abort path. */
const TERM_GRACE_MS = 5000;

/** Bounded drain timeout for stream reads after proc.exited resolves — prevents
 * hanging when a descendant holds the pipe open. */
const DRAIN_TIMEOUT_MS = 2000;

/** ANSI escape sequence regex for stripping before parsing test output. */
// biome-ignore lint/suspicious/noControlCharactersInRegex: intentional ANSI escape sequence
const ANSI_ESCAPE = /\x1b\[[0-9;]*m/g;

/**
 * Read a piped stdio stream to text, stopping hard at `cap` bytes.
 *
 * Started IMMEDIATELY after spawn: awaiting the exit race first would leave
 * the pipe undrained — a chatty test binary fills the 64 KiB pipe buffer,
 * blocks on write, and the exit being awaited never happens (deadlock).
 *
 * The DRAIN_TIMEOUT_MS backstop inside is armed only once `exited` (the
 * child's exit promise) resolves — see the timer block for why.
 */
async function readCapped(
  stream: ReadableStream<Uint8Array> | number | undefined,
  cap: number,
  signal: AbortSignal | undefined,
  exited: Promise<number>,
): Promise<{ text: string; capped: boolean }> {
  if (stream === undefined || stream === null || typeof stream === "number") {
    return { text: "", capped: false };
  }
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let text = "";
  let bytes = 0;
  let capped = false;

  // Race the read loop against a drain timeout — if a descendant holds the
  // pipe open after proc.exited resolves, cancel the reader and return what we
  // captured rather than hanging forever.
  const drainPromise = (async () => {
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
  })();

  // DRAIN_TIMEOUT_MS backstop — if the stream never closes, we abort and
  // return partial text. The abort race below (which races proc.exited) is the
  // PRIMARY guard; this is for pathological processes that never close the pipe.
  //
  // The timer is ARMED ONLY AFTER `exited` resolves: readers start at spawn,
  // but the backstop exists for a descendant holding the pipe open after the
  // child exits. Arming it at read start would cancel both readers mid-run on
  // any legitimate suite longer than DRAIN_TIMEOUT_MS, losing the terminal
  // summary line and failing closed (review round 9).
  let drainTimer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  let readerSettled = false;
  const timeout = new Promise<"timeout">((resolve) => {
    onAbort = () => {
      if (drainTimer !== undefined) clearTimeout(drainTimer);
      resolve("timeout");
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    void exited.then(() => {
      if (readerSettled) return; // drain finished before exit — nothing to arm
      drainTimer = setTimeout(() => resolve("timeout"), DRAIN_TIMEOUT_MS);
      drainTimer.unref();
    });
  });

  const result = await Promise.race([drainPromise, timeout]);
  readerSettled = true;
  if (drainTimer !== undefined) clearTimeout(drainTimer);
  // Balanced listener lifecycle: remove on EVERY settle path. On the abort path
  // { once: true } already consumed it (removal is then a harmless no-op); on
  // every other path this is what keeps a reused non-aborted signal from
  // accumulating two dead listeners per runTestCommand call.
  if (onAbort !== undefined) signal?.removeEventListener("abort", onAbort);
  if (result === "timeout") {
    // Drain timed out — cancel the reader and accept partial data
    await reader.cancel().catch(() => {});
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
    // Pass the abort signal so drain timeouts respect aborts, and proc.exited
    // so the drain backstop arms only once the child is gone.
    const stdoutRead = readCapped(proc.stdout, MAX_CAPTURE_BYTES, signal, proc.exited);
    const stderrRead = readCapped(proc.stderr, MAX_CAPTURE_BYTES, signal, proc.exited);

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
          // ponytail: re-check after addEventListener to close the race between
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
        // but DRAIN_TIMEOUT_MS (in readCapped) bounds the drain wait so we never
        // hang forever.
        try {
          // Try process-group kill first (-pid) — may not work on all platforms,
          // fall back to direct pid if group kill throws.
          try {
            if (proc.pid !== undefined) {
              process.kill(-proc.pid, "SIGTERM");
            } else {
              proc.kill("SIGTERM");
            }
          } catch {
            proc.kill("SIGTERM");
          }
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
          // Grace expired — force-kill the process group (or direct pid)
          try {
            try {
              if (proc.pid !== undefined) {
                process.kill(-proc.pid, "SIGKILL");
              } else {
                proc.kill("SIGKILL");
              }
            } catch {
              proc.kill("SIGKILL");
            }
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
        // ponytail: guaranteed removal on ALL exit paths (spawn throw, reader
        // setup throw, normal resolve, abort resolve). A long-lived signal would
        // otherwise accumulate dead listeners.
        if (onAbort !== undefined) signal.removeEventListener("abort", onAbort);
      }
    }

    await proc.exited;
    const [{ text: stdout, capped: stdoutCapped }, { text: stderr, capped: stderrCapped }] =
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
        `Test output exceeded ${MAX_CAPTURE_BYTES} byte capture cap`,
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
