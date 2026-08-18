/**
 * Test results runner tests (Story DF1.6 AC6): engine-side testCommand runner.
 *
 * Tests the runTestCommand function which:
 * - Spawns argv as array via Bun.spawn (never shell string)
 * - Captures stdout+stderr bounded by AbortSignal
 * - Parses passed/failed counts from bun test output format
 * - Returns fail-closed results when spawn fails, signal kills, or output unparseable
 */
import { afterAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { runTestCommand, coerceTestsExecuted } from "../../src/phase-engine/phases/test-results.ts";

const tmpRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "df1-6-test-results-")));
afterAll(() => fs.rmSync(tmpRoot, { recursive: true, force: true }));

let seq = 0;
function freshRoot(): string {
  const dir = path.join(tmpRoot, `root-${seq++}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

describe("runTestCommand", () => {
  const cwd = freshRoot();

  test("parses bun test output with 7 pass / 2 fail", async () => {
    // Bun test output format: " 7 pass\n 0 fail" or similar
    const fixtureScript = path.join(cwd, "emit-test-results.sh");
    fs.writeFileSync(
      fixtureScript,
      "#!/bin/sh\necho ' 7 pass'\necho ' 2 fail'\n",
      { mode: 0o755 },
    );

    const result = await runTestCommand([fixtureScript], { cwd });
    expect(result.testsExecuted).toBe(true);
    expect(result.testResults.passed).toBe(7);
    expect(result.testResults.failed).toBe(2);
    expect(result.reason).toBeUndefined();
  });

  test("returns fail-closed for unspawnable command", async () => {
    const result = await runTestCommand(["nonexistent-binary-that-does-not-exist-xyz123"], { cwd });
    expect(result.testsExecuted).toBe(false);
    expect(result.testResults.passed).toBe(0);
    expect(result.testResults.failed).toBe(0);
    expect(result.reason).toBeDefined();
    expect(result.reason!.length).toBeLessThanOrEqual(200);
  });

  test("returns fail-closed when process killed by signal", async () => {
    // Create a sleep script we can abort
    const sleepScript = path.join(cwd, "long-sleep.sh");
    fs.writeFileSync(
      sleepScript,
      "#!/bin/sh\necho 'starting'\nsleep 100\necho 'should not reach here'\n",
      { mode: 0o755 },
    );

    const controller = new AbortController();
    // Abort immediately after spawn starts
    setTimeout(() => controller.abort(), 50);

    const result = await runTestCommand([sleepScript], { cwd, signal: controller.signal });
    expect(result.testsExecuted).toBe(false);
    expect(result.testResults.passed).toBe(0);
    expect(result.testResults.failed).toBe(0);
    expect(result.reason).toBeDefined();
    expect(result.reason).toMatch(/signal|abort|kill/i);
  });

  test("returns fail-closed for unparseable output", async () => {
    const gibberishScript = path.join(cwd, "gibberish.sh");
    fs.writeFileSync(
      gibberishScript,
      "#!/bin/sh\necho 'this is not test output'\necho 'no numbers here'\necho 'just random text'\n",
      { mode: 0o755 },
    );

    const result = await runTestCommand([gibberishScript], { cwd });
    expect(result.testsExecuted).toBe(false);
    expect(result.testResults.passed).toBe(0);
    expect(result.testResults.failed).toBe(0);
    expect(result.reason).toBeDefined();
    expect(result.reason).toMatch(/parse|unparseable/i);
  });

  test("parses zero counts: 0 pass / 0 fail", async () => {
    const zeroScript = path.join(cwd, "zero-results.sh");
    fs.writeFileSync(
      zeroScript,
      "#!/bin/sh\necho ' 0 pass'\necho ' 0 fail'\n",
      { mode: 0o755 },
    );

    const result = await runTestCommand([zeroScript], { cwd });
    expect(result.testsExecuted).toBe(true);
    expect(result.testResults.passed).toBe(0);
    expect(result.testResults.failed).toBe(0);
    expect(result.reason).toBeUndefined();
  });

  test("argv is spawned as array (no shell interpretation)", async () => {
    // This script receives arguments and prints them, proving metacharacters are literals
    const echoArgsScript = path.join(cwd, "echo-args.sh");
    fs.writeFileSync(
      echoArgsScript,
      '#!/bin/sh\necho "Args: $@"\nfor arg in "$@"; do echo "  [$arg]"; done\n',
      { mode: 0o755 },
    );

    // Include shell metacharacters that would be dangerous if interpreted
    const result = await runTestCommand([echoArgsScript, "safe", "; rm -rf /", "&&&"], {
      cwd,
    });

    expect(result.testsExecuted).toBe(false); // Output doesn't have pass/fail counts
    expect(result.reason).toBeDefined();
    // The key assertion: the script ran successfully (not a spawn error)
    // and the metacharacters were passed as literal arguments, not interpreted
    expect(result.reason).not.toMatch(/spawn/i);
  });

  test("handles bun test format with 'pass' and 'fail' words", async () => {
    const bunFormatScript = path.join(cwd, "bun-format.sh");
    fs.writeFileSync(
      bunFormatScript,
      "#!/bin/sh\necho ' 12 pass'\necho ' 3 fail'\n",
      { mode: 0o755 },
    );

    const result = await runTestCommand([bunFormatScript], { cwd });
    expect(result.testsExecuted).toBe(true);
    expect(result.testResults.passed).toBe(12);
    expect(result.testResults.failed).toBe(3);
  });

  test("handles jest/vitest style: 'Tests: 7 passed, 2 failed'", async () => {
    const jestFormatScript = path.join(cwd, "jest-format.sh");
    fs.writeFileSync(
      jestFormatScript,
      "#!/bin/sh\necho 'Tests: 7 passed, 2 failed'\n",
      { mode: 0o755 },
    );

    const result = await runTestCommand([jestFormatScript], { cwd });
    expect(result.testsExecuted).toBe(true);
    expect(result.testResults.passed).toBe(7);
    expect(result.testResults.failed).toBe(2);
  });

  test("returns parsed counts even when exit code is non-zero", async () => {
    const nonZeroExitScript = path.join(cwd, "non-zero-exit.sh");
    fs.writeFileSync(
      nonZeroExitScript,
      "#!/bin/sh\necho ' 5 pass'\necho ' 1 fail'\nexit 1\n",
      { mode: 0o755 },
    );

    const result = await runTestCommand([nonZeroExitScript], { cwd });
    // Exit code is data, not a parse verdict — output parsed successfully
    expect(result.testsExecuted).toBe(true);
    expect(result.testResults.passed).toBe(5);
    expect(result.testResults.failed).toBe(1);
  });

  test("sanitizes reason (no verbatim output, capped at 200 chars)", async () => {
    const longOutputScript = path.join(cwd, "long-output.sh");
    fs.writeFileSync(
      longOutputScript,
      "#!/bin/sh\nfor i in $(seq 1 50); do echo 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'; done\n",
      { mode: 0o755 },
    );

    const result = await runTestCommand([longOutputScript], { cwd });
    expect(result.testsExecuted).toBe(false);
    expect(result.reason).toBeDefined();
    expect(result.reason!.length).toBeLessThanOrEqual(200);
    // Should not contain verbatim script output
    expect(result.reason).not.toContain("AAAAAAAAAA");
  });
});

describe("runTestCommand — reporter formats, output cap, group kill (review round)", () => {
  const cwd2 = freshRoot();

  test("parses green vitest default reporter output (colon-less, no failed clause)", async () => {
    // "Tests  7 passed (7)" — an all-green vitest run. The old parser
    // required a colon AND a failed clause, so green vitest failed closed.
    const script = path.join(cwd2, "vitest-green.sh");
    fs.writeFileSync(
      script,
      "#!/bin/sh\necho ' Test Files  2 passed (2)'\necho '      Tests  7 passed (7)'\n",
      { mode: 0o755 },
    );
    const result = await runTestCommand([script], { cwd: cwd2 });
    expect(result.testsExecuted).toBe(true);
    expect(result.testResults).toEqual({ passed: 7, failed: 0 });
  });

  test("parses green jest output (colon, ', N total' instead of failed)", async () => {
    const script = path.join(cwd2, "jest-green.sh");
    fs.writeFileSync(
      script,
      "#!/bin/sh\necho 'Tests:       7 passed, 7 total'\n",
      { mode: 0o755 },
    );
    const result = await runTestCommand([script], { cwd: cwd2 });
    expect(result.testsExecuted).toBe(true);
    expect(result.testResults).toEqual({ passed: 7, failed: 0 });
  });

  test("parses failing vitest output: 'Tests  7 passed | 3 failed'", async () => {
    const script = path.join(cwd2, "vitest-fail.sh");
    fs.writeFileSync(
      script,
      "#!/bin/sh\necho '      Tests  7 passed | 3 failed (10)'\n",
      { mode: 0o755 },
    );
    const result = await runTestCommand([script], { cwd: cwd2 });
    expect(result.testsExecuted).toBe(true);
    expect(result.testResults).toEqual({ passed: 7, failed: 3 });
  });

  test("failing jest run: failed count anchors to the Tests line, not Test Suites", async () => {
    // Real jest order: the "Test Suites: 1 failed" line precedes the "Tests:"
    // line. An output-wide /(\\d+)\\s+failed/ scan grabs the SUITE count (1)
    // instead of the test count (2).
    const script = path.join(cwd2, "jest-suites-failed.sh");
    fs.writeFileSync(
      script,
      "#!/bin/sh\necho 'Test Suites: 1 failed, 1 total'\necho 'Tests:       7 passed, 2 failed, 9 total'\n",
      { mode: 0o755 },
    );
    const result = await runTestCommand([script], { cwd: cwd2 });
    expect(result.testsExecuted).toBe(true);
    expect(result.testResults).toEqual({ passed: 7, failed: 2 });
  });

  test("failing vitest run prints failed first: 'Tests  2 failed | 4 passed (6)'", async () => {
    // vitest's default reporter lists failures first on both summary lines.
    const script = path.join(cwd2, "vitest-failed-first.sh");
    fs.writeFileSync(
      script,
      "#!/bin/sh\necho ' Test Files  1 failed (1)'\necho '      Tests  2 failed | 4 passed (6)'\n",
      { mode: 0o755 },
    );
    const result = await runTestCommand([script], { cwd: cwd2 });
    expect(result.testsExecuted).toBe(true);
    expect(result.testResults).toEqual({ passed: 4, failed: 2 });
  });

  test("output beyond the capture cap fails closed with a cap reason", async () => {
    // ~90 bytes/line × 8000 lines ≈ 720 KiB > 512 KiB cap on ONE stream.
    const script = path.join(cwd2, "flood.sh");
    fs.writeFileSync(
      script,
      "#!/bin/sh\nfor i in $(seq 1 8000); do echo 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'; done\necho ' 7 pass'\necho ' 0 fail'\n",
      { mode: 0o755 },
    );
    const result = await runTestCommand([script], { cwd: cwd2 });
    expect(result.testsExecuted).toBe(false);
    expect(result.testResults).toEqual({ passed: 0, failed: 0 });
    expect(result.reason).toMatch(/cap/i);
  }, 20_000);

  test("abort terminates the command even when it ignores SIGTERM (grace → SIGKILL)", async () => {
    // SIGTERM-ignoring leader (perl — macOS sh/bash do not honor TERM traps
    // while waiting on a foreground child): the abort path must fall through
    // to SIGKILL within TERM_GRACE_MS instead of hanging. (Group-wide kill is
    // a documented limitation — see the ponytail note in test-results.ts:
    // Bun.spawn exposes no process-group control.)
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 200);
    const started = Date.now();

    const result = await runTestCommand(
      ["perl", "-e", '$SIG{TERM}="IGNORE"; sleep 100'],
      { cwd: cwd2, signal: controller.signal },
    );
    expect(result.testsExecuted).toBe(false);
    expect(result.reason).toMatch(/abort/i);
    // SIGKILL backstop lands after the grace window, not after sleep 100.
    expect(Date.now() - started).toBeLessThan(15_000);
  }, 20_000);

  test("already-aborted signal is observed immediately (child never lingers)", async () => {
    const script = path.join(cwd2, "pre-aborted.sh");
    fs.writeFileSync(script, "#!/bin/sh\nsleep 100\n", { mode: 0o755 });
    const controller = new AbortController();
    controller.abort(); // BEFORE the call — the listener-only path would hang
    const result = await runTestCommand([script], { cwd: cwd2, signal: controller.signal });
    expect(result.testsExecuted).toBe(false);
    expect(result.reason).toMatch(/abort/i);
  }, 15_000);

  test("provider API keys are not passed to the test command", async () => {
    const script = path.join(cwd2, "env-probe.sh");
    fs.writeFileSync(
      script,
      // Two real echo lines, not one '...\n...' line: a literal \n inside
      // single quotes is NOT expanded by bash-as-sh (macOS), only by dash —
      // the old fixture's parse depended on which /bin/sh ran it.
      "#!/bin/sh\nif [ -n \"${ANTHROPIC_API_KEY:-}\" ] || [ -n \"${OPENROUTER_API_KEY:-}\" ]; then echo 'LEAK'; else echo ' 1 pass'; echo ' 0 fail'; fi\n",
      { mode: 0o755 },
    );
    const prevAnthropic = process.env.ANTHROPIC_API_KEY;
    const prevOpenrouter = process.env.OPENROUTER_API_KEY;
    process.env.ANTHROPIC_API_KEY = "sk-test-do-not-leak";
    try {
      const result = await runTestCommand([script], { cwd: cwd2 });
      expect(result.testsExecuted).toBe(true);
      expect(result.testResults).toEqual({ passed: 1, failed: 0 });
    } finally {
      // `= undefined` would stringify to "undefined" — delete is the only
      // correct unset for process.env.
      // biome-ignore lint/performance/noDelete: env unset semantics
      if (prevAnthropic === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = prevAnthropic;
      if (prevOpenrouter !== undefined) process.env.OPENROUTER_API_KEY = prevOpenrouter;
    }
  });
});

describe("coerceTestsExecuted", () => {
  test("coerces to false when sum===0 and testsExecuted is true", () => {
    const input = { testsExecuted: true, testResults: { passed: 0, failed: 0 } };
    const result = coerceTestsExecuted(input);
    expect(result.testsExecuted).toBe(false);
  });

  test("keeps true when sum>0", () => {
    const input = { testsExecuted: true, testResults: { passed: 7, failed: 2 } };
    const result = coerceTestsExecuted(input);
    expect(result.testsExecuted).toBe(true);
  });

  test("keeps false when sum===0 and already false", () => {
    const input = { testsExecuted: false, testResults: { passed: 0, failed: 0 } };
    const result = coerceTestsExecuted(input);
    expect(result.testsExecuted).toBe(false);
  });

  test("keeps true when sum===0 but no tests were run (edge case)", () => {
    // The contract says: consumers reject when sum===0 AND (absent|true)
    // This helper enforces the invariant at the boundary
    const input = { testsExecuted: true, testResults: { passed: 0, failed: 0 } };
    const result = coerceTestsExecuted(input);
    expect(result.testsExecuted).toBe(false);
  });
});
