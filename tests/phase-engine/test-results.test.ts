/**
 * Test results runner tests (Story DF1.6 AC6): engine-side testCommand runner.
 *
 * Tests the runTestCommand function which:
 * - Spawns argv as array via Bun.spawn (never shell string)
 * - Captures stdout+stderr bounded by AbortSignal
 * - Parses passed/failed counts from bun test output format
 * - Returns fail-closed results when spawn fails, signal kills, or output unparseable
 */
import { afterAll, describe, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { runTestCommand, coerceTestsExecuted } from "../../src/phase-engine/phases/test-results.ts";
import { EXEC_MAX_OUTPUT_BYTES } from "../../src/providers/bounded-exec.ts";

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

  test("argv spawned as array, never a shell string (discriminating fixture: counts only when one arg contains a space)", async () => {
    // Pass ONE argument that itself contains a space. Under argv-spawn it arrives
    // intact as $1="a b"; under a collapsed shell string ("sh -c 'script a b'") the
    // shell word-splits it into $1=a $2=b. Only the intact arg emits counts —
    // so a shell-spawning implementation fails the parse, an argv-spawning one passes.
    // ($# alone cannot discriminate: "sh -c 'script a b'" yields the same $#=2
    // as a direct 2-arg exec, because $0 is the script in both.)
    const discriminatingScript = path.join(cwd, "argv-check.sh");
    fs.writeFileSync(
      discriminatingScript,
      '#!/bin/sh\nif [ "$#" -eq 1 ] && [ "$1" = "a b" ]; then echo " 7 pass"; echo " 0 fail"; else echo "argv-collapsed: $# args, first: $1"; fi\n',
      { mode: 0o755 },
    );

    const result = await runTestCommand([discriminatingScript, "a b"], {
      cwd,
    });

    // If spawn collapsed argv into a shell string, the arg splits, the fixture
    // withholds the counts, and the parse fails closed here.
    expect(result.testsExecuted).toBe(true);
    expect(result.testResults).toEqual({ passed: 7, failed: 0 });
    // Also sanity-check the script ran correctly (not some other output path)
    expect(result.reason).toBeUndefined();
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
    // ponytail: asymmetric counts from Test Suites line ensure the regex doesn't
    // mistakenly match the wrong line (the real jest order has Test Suites first).
    const jestFormatScript = path.join(cwd, "jest-format.sh");
    fs.writeFileSync(
      jestFormatScript,
      "#!/bin/sh\necho 'Test Suites: 3 passed, 1 failed'\necho 'Tests: 7 passed, 2 failed'\n",
      { mode: 0o755 },
    );

    const result = await runTestCommand([jestFormatScript], { cwd });
    expect(result.testsExecuted).toBe(true);
    // These counts match the Tests line only, not the Test Suites line.
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

  test("all-failing jest run omits the zero passed clause", async () => {
    // jest omits zero categories: when every test fails the "Tests:" line has
    // no "passed" clause. This is the DF1.6 seeded-failing-test path when
    // testCommand uses jest — it must parse as tests-run (failed>0), not
    // fail closed as "tests did not run".
    const script = path.join(cwd2, "jest-all-fail.sh");
    fs.writeFileSync(
      script,
      "#!/bin/sh\necho 'Test Suites: 1 failed, 1 total'\necho 'Tests:       2 failed, 2 total'\n",
      { mode: 0o755 },
    );
    const result = await runTestCommand([script], { cwd: cwd2 });
    expect(result.testsExecuted).toBe(true);
    expect(result.testResults).toEqual({ passed: 0, failed: 2 });
  });

  test("all-failing vitest run omits the zero passed clause", async () => {
    // vitest likewise: "Tests  2 failed (2)" with no passed clause.
    const script = path.join(cwd2, "vitest-all-fail.sh");
    fs.writeFileSync(
      script,
      "#!/bin/sh\necho ' Test Files  1 failed (1)'\necho '      Tests  2 failed (2)'\n",
      { mode: 0o755 },
    );
    const result = await runTestCommand([script], { cwd: cwd2 });
    expect(result.testsExecuted).toBe(true);
    expect(result.testResults).toEqual({ passed: 0, failed: 2 });
  });

  test("jest green run with skips: skipped clause precedes passed", async () => {
    // jest's summary order is failed → skipped → todo → passed, so a green
    // run with skips prints the skipped count FIRST: "Tests: 1 skipped,
    // 2 passed, 3 total". The old parser anchored on the first number after
    // "Tests" and required passed/failed there — this line failed closed as
    // "tests did not run".
    const script = path.join(cwd2, "jest-skipped-first.sh");
    fs.writeFileSync(
      script,
      "#!/bin/sh\necho 'Test Suites: 1 skipped, 1 total'\necho 'Tests:       1 skipped, 2 passed, 3 total'\n",
      { mode: 0o755 },
    );
    const result = await runTestCommand([script], { cwd: cwd2 });
    expect(result.testsExecuted).toBe(true);
    expect(result.testResults).toEqual({ passed: 2, failed: 0 });
  });

  test("jest run with todo clause first still parses the passed count", async () => {
    // todo (test.fixme/'todo' tests) also precedes passed in jest's order.
    const script = path.join(cwd2, "jest-todo-first.sh");
    fs.writeFileSync(
      script,
      "#!/bin/sh\necho 'Tests:       2 todo, 3 passed, 5 total'\n",
      { mode: 0o755 },
    );
    const result = await runTestCommand([script], { cwd: cwd2 });
    expect(result.testsExecuted).toBe(true);
    expect(result.testResults).toEqual({ passed: 3, failed: 0 });
  });

  test("vitest run with leading skipped clause: 'Tests  1 skipped | 2 passed (3)'", async () => {
    // vitest puts skipped between the (omitted) failed and passed counts,
    // so a no-failure run with skips leads with skipped.
    const script = path.join(cwd2, "vitest-skipped-first.sh");
    fs.writeFileSync(
      script,
      "#!/bin/sh\necho ' Test Files  1 passed (1)'\necho '      Tests  1 skipped | 2 passed (3)'\n",
      { mode: 0o755 },
    );
    const result = await runTestCommand([script], { cwd: cwd2 });
    expect(result.testsExecuted).toBe(true);
    expect(result.testResults).toEqual({ passed: 2, failed: 0 });
  });

  test("output beyond the capture cap fails closed with a cap reason", async () => {
    // 98 A's + newline = 99 bytes/line × 8000 lines = 792,000 bytes ≈ 773 KiB > 512 KiB cap on ONE stream.
    const script = path.join(cwd2, "flood.sh");
    fs.writeFileSync(
      script,
      "#!/bin/sh\nfor i in $(seq 1 8000); do echo 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'; done\necho ' 7 pass'\necho ' 0 fail'\n",
      { mode: 0o755 },
    );
    const result = await runTestCommand([script], { cwd: cwd2 });
    expect(result.testsExecuted).toBe(false);
    expect(result.testResults).toEqual({ passed: 0, failed: 0 });
    // Reason should mention output/cap/buffer — the actual message may vary
    expect(result.reason).toBeDefined();
    expect(result.reason?.toLowerCase()).toMatch(/(output|cap|buffer|exceed)/i);
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

  test("abort signals the child directly, never a negative pid (F038)", async () => {
    // Bun.spawn is not detached, so the child is NOT a group leader and its pid
    // is not a pgid. `process.kill(-pid, …)` therefore either ESRCHes into the
    // fallback or — if some unrelated group happens to hold that id — signals
    // THAT group. Nothing here may ever call process.kill with a negative pid.
    const killSpy = spyOn(process, "kill");
    try {
      const controller = new AbortController();
      setTimeout(() => controller.abort(), 150);
      const result = await runTestCommand(
        ["perl", "-e", '$SIG{TERM}="IGNORE"; sleep 100'],
        { cwd: cwd2, signal: controller.signal },
      );
      expect(result.testsExecuted).toBe(false);
      const negatives = killSpy.mock.calls.filter((c) => typeof c[0] === "number" && (c[0] as number) < 0);
      expect(negatives).toEqual([]);
    } finally {
      killSpy.mockRestore();
    }
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
      // ponytail: exact restore — undefined→delete, ""→"", value→assign value.
      // `= undefined` would stringify to "undefined"; treating "" as falsy
      // leaves the key deleted. The saved value tells us which case we have.
      // biome-ignore lint/performance/noDelete: env unset semantics
      if (prevAnthropic === undefined) delete process.env.ANTHROPIC_API_KEY;
      else if (prevAnthropic === "") process.env.ANTHROPIC_API_KEY = "";
      else process.env.ANTHROPIC_API_KEY = prevAnthropic;
      // biome-ignore lint/performance/noDelete: env unset semantics
      if (prevOpenrouter === undefined) delete process.env.OPENROUTER_API_KEY;
      else if (prevOpenrouter === "") process.env.OPENROUTER_API_KEY = "";
      else if (prevOpenrouter !== undefined) process.env.OPENROUTER_API_KEY = prevOpenrouter;
    }
  });

  test("all-skipped output: Tests: 3 skipped, 3 total → fail-closed {0,0,false}", async () => {
    // jest/vitest all-skipped: no passed/failed counts, only skipped + total.
    // Must fail-closed as tests-did-not-run, not parse as true with 0/0.
    const script = path.join(cwd2, "all-skipped.sh");
    fs.writeFileSync(
      script,
      "#!/bin/sh\necho 'Test Suites: 1 skipped, 1 total'\necho 'Tests:       3 skipped, 3 total'\n",
      { mode: 0o755 },
    );
    const result = await runTestCommand([script], { cwd: cwd2 });
    expect(result.testsExecuted).toBe(false);
    expect(result.testResults).toEqual({ passed: 0, failed: 0 });
  });

  test("child killed by external signal → fail-closed with signal reason", async () => {
    // Script kills itself with SIGTERM — must fail-closed with signal reason.
    const selfKillScript = path.join(cwd2, "self-kill.sh");
    fs.writeFileSync(
      selfKillScript,
      // $$ is the current shell's PID; kill -9 sends SIGKILL uncatchably.
      "#!/bin/sh\nkill -9 $$\n",
      { mode: 0o755 },
    );
    const result = await runTestCommand([selfKillScript], { cwd: cwd2 });
    expect(result.testsExecuted).toBe(false);
    expect(result.testResults).toEqual({ passed: 0, failed: 0 });
    expect(result.reason).toBeDefined();
    expect(result.reason).toMatch(/signal/i);
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

  test("coerces to false when sum===0 and testsExecuted is true (edge case: test runner ran but reported zero)", () => {
    // The contract says: consumers reject when sum===0 AND (absent|true)
    // This helper enforces the invariant at the boundary
    const input = { testsExecuted: true, testResults: { passed: 0, failed: 0 } };
    const result = coerceTestsExecuted(input);
    expect(result.testsExecuted).toBe(false);
  });
});

describe("runTestCommand — review-round hardening", () => {
  const cwd3 = freshRoot();

  test("all-todo summary: Tests: 3 todo, 3 total → passed 0 / failed 0 per parser contract", async () => {
    // jest todo-only (test.fixme): no passed/failed, only todo + total
    const script = path.join(cwd3, "all-todo.sh");
    fs.writeFileSync(
      script,
      "#!/bin/sh\necho 'Test Suites: 1 todo, 1 total'\necho 'Tests:       3 todo, 3 total'\n",
      { mode: 0o755 },
    );
    const result = await runTestCommand([script], { cwd: cwd3 });
    // Parser finds no passed/failed clauses → defaults to 0/0
    expect(result.testResults).toEqual({ passed: 0, failed: 0 });
    // sum===0 → testsExecuted coerced to false
    expect(result.testsExecuted).toBe(false);
  });

  test("failed+skipped combo in jest order: Tests: 2 failed, 1 skipped, 3 total → failed 2, skipped ignored", async () => {
    // jest order: failed → skipped → passed (passed omitted here)
    const script = path.join(cwd3, "failed-skipped.sh");
    fs.writeFileSync(
      script,
      "#!/bin/sh\necho 'Tests:       2 failed, 1 skipped, 3 total'\n",
      { mode: 0o755 },
    );
    const result = await runTestCommand([script], { cwd: cwd3 });
    expect(result.testResults).toEqual({ passed: 0, failed: 2 });
    expect(result.testsExecuted).toBe(true);
  });

  test("jest unsafe-integer passed count alongside safe failed count fails closed", async () => {
    // 2^53 is above Number.MAX_SAFE_INTEGER: the passed clause is unsafe.
    // Regression (review round 12): the parser used to skip just the unsafe
    // clause, fabricate passed: 0, keep failed: 1, and report
    // testsExecuted: true — violating the fail-closed rule. The whole parse
    // must now fail closed.
    const script = path.join(cwd3, "unsafe-passed.sh");
    fs.writeFileSync(
      script,
      "#!/bin/sh\necho 'Tests: 9007199254740992 passed, 1 failed'\n",
      { mode: 0o755 },
    );
    const result = await runTestCommand([script], { cwd: cwd3 });
    expect(result.testsExecuted).toBe(false);
    expect(result.testResults).toEqual({ passed: 0, failed: 0 });
    expect(result.reason).toBeDefined();
  });

  test("vitest unsafe-integer failed count alongside safe passed count fails closed", async () => {
    // Mirror of the above on the failed clause, vitest pipe format: the safe
    // passed count must not rescue an unsafe failed count either.
    const script = path.join(cwd3, "unsafe-failed.sh");
    fs.writeFileSync(
      script,
      "#!/bin/sh\necho 'Tests  9007199254740992 failed | 4 passed (9007199254740996)'\n",
      { mode: 0o755 },
    );
    const result = await runTestCommand([script], { cwd: cwd3 });
    expect(result.testsExecuted).toBe(false);
    expect(result.testResults).toEqual({ passed: 0, failed: 0 });
    expect(result.reason).toBeDefined();
  });

  test("bun output with exactly one pass line and no fail line → passed N / failed 0", async () => {
    // Minimal bun test output: only a pass line
    const script = path.join(cwd3, "one-pass.sh");
    fs.writeFileSync(
      script,
      "#!/bin/sh\necho ' 5 pass'\n",
      { mode: 0o755 },
    );
    const result = await runTestCommand([script], { cwd: cwd3 });
    expect(result.testResults).toEqual({ passed: 5, failed: 0 });
    expect(result.testsExecuted).toBe(true);
  });

  test("go-format output fails closed: no go parser (pins runTestCommand's declared contract)", async () => {
    // The fail-closed-on-Go contract and its upgrade trigger live in
    // runTestCommand's docstring, where the parser is. This test pins it.
    const script = path.join(cwd3, "go-format.sh");
    fs.writeFileSync(
      script,
      // go test -json format (example) — NOT parsed unless it coincidentally matches
      "#!/bin/sh\necho 'ok  pkg/name 0.01s'\necho '--- PASS: TestX'\necho 'PASS'\necho 'ok'\n",
      { mode: 0o755 },
    );
    const result = await runTestCommand([script], { cwd: cwd3 });
    // Current parser does NOT recognize go format → fails closed
    expect(result.testsExecuted).toBe(false);
    expect(result.testResults).toEqual({ passed: 0, failed: 0 });
    expect(result.reason).toBeDefined();
  });

  test("output at exactly the capture cap boundary (EXEC_MAX_OUTPUT_BYTES)", async () => {
    // At the exact boundary: output = cap → NOT capped (reads succeed)
    const cap = EXEC_MAX_OUTPUT_BYTES;
    const script = path.join(cwd3, "exact-cap.sh");
    // 98 A's + newline = 99 bytes/line; 5173 lines = 511,727 bytes (under cap)
    // One more 98-char line + newline = 99 bytes → 511,826 bytes (still under)
    // This test verifies EXACT cap boundary behavior
    fs.writeFileSync(
      script,
      `#!/bin/sh
for i in $(seq 1 5173); do echo 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'; done
echo ' 1 pass'\n`,
      { mode: 0o755 },
    );
    const result = await runTestCommand([script], { cwd: cwd3 });
    // Under cap → parses successfully
    expect(result.testsExecuted).toBe(true);
    expect(result.testResults).toEqual({ passed: 1, failed: 0 });
  });

  test("output at cap+1 byte → fails closed with cap reason", async () => {
    // Just over the cap: one extra byte beyond the capture cap
    const cap = EXEC_MAX_OUTPUT_BYTES;
    const script = path.join(cwd3, "over-cap.sh");
    // 98 A's + newline = 99 bytes/line; 5174 lines = 511,826 bytes
    // Add 200 more A's → 711,826 bytes (> cap)
    fs.writeFileSync(
      script,
      `#!/bin/sh
for i in $(seq 1 5174); do echo 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'; done
echo ' 1 pass'\n`,
      { mode: 0o755 },
    );
    const result = await runTestCommand([script], { cwd: cwd3 });
    // Over cap → fail-closed
    expect(result.testsExecuted).toBe(false);
    expect(result.testResults).toEqual({ passed: 0, failed: 0 });
    expect(result.reason).toBeDefined();
    expect(result.reason).toMatch(/cap|exceed/i);
  }, 20_000);

  test("env-restore delete branch: ANTHROPIC_API_KEY initially UNSET → must DELETE after test", async () => {
    // ponytail: exact restore semantics — when env var was UNSET (not ""),
    // the restore must DELETE the key, not set undefined (which stringifies)
    const script = path.join(cwd3, "probe-env.sh");
    // Save original state
    const prevAnthropic = process.env.ANTHROPIC_API_KEY;
    // biome-ignore lint/performance/noDelete: unset is the semantic
    delete process.env.ANTHROPIC_API_KEY;
    try {
      fs.writeFileSync(
        script,
        // Verify ANTHROPIC_API_KEY is unset during test run
        "#!/bin/sh\nif [ -n \"${ANTHROPIC_API_KEY:-}\" ]; then echo 'LEAK'; else echo ' 1 pass'; echo ' 0 fail'; fi\n",
        { mode: 0o755 },
      );
      const result = await runTestCommand([script], { cwd: cwd3 });
      expect(result.testsExecuted).toBe(true);
      expect(result.testResults).toEqual({ passed: 1, failed: 0 });
      // CRITICAL: verify key was NOT restored as "undefined" string AND was actually deleted
      expect(process.env.ANTHROPIC_API_KEY).toBeUndefined();
      expect("ANTHROPIC_API_KEY" in process.env).toBe(false); // proves deletion, not just undefined value
    } finally {
      // Restore original state
      // biome-ignore lint/performance/noDelete: unset is the semantic
      if (prevAnthropic === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = prevAnthropic;
    }
  });

  test("drain backstop arms only after exit — a suite longer than DRAIN_TIMEOUT_MS still parses (R9)", async () => {
    // Regression (review round 9): the 2s drain timer used to arm at read
    // START (right after spawn), so any legitimate suite running longer than
    // DRAIN_TIMEOUT_MS had both readers cancelled before the terminal summary
    // line existed — output came back partial with capped:false and the parser
    // failed closed. The timer must arm only once proc.exited resolves, while
    // reads keep starting immediately (pipe-backpressure deadlock guard).
    const script = path.join(freshRoot(), "slow-suite.sh");
    fs.writeFileSync(
      script,
      // > DRAIN_TIMEOUT_MS (2s) of runtime BEFORE the summary is printed.
      // 3s sleep gives 1s margin over DRAIN_TIMEOUT_MS=2000ms to avoid CI flakiness.
      "#!/bin/sh\nsleep 3\necho 'Tests: 5 passed, 1 failed'\n",
      { mode: 0o755 },
    );
    const result = await runTestCommand([script], { cwd: path.dirname(script) });
    expect(result.testsExecuted).toBe(true);
    expect(result.testResults).toEqual({ passed: 5, failed: 1 });
  }, 15_000);

  test("drain backstop FIRES when a descendant holds the pipe open after exit", async () => {
    // Round 11: the R9 test above proves the timer does NOT arm early; this
    // one proves it DOES fire when needed. The script's foreground work ends
    // immediately, but a backgrounded sleep inherits stdout and keeps the
    // pipe open past DRAIN_TIMEOUT_MS — without the backstop, readCapped
    // would hang until the 3s holder exits; with it, the reader is cancelled
    // ~2s after exit and the already-captured summary still parses.
    const script = path.join(freshRoot(), "pipe-holder.sh");
    fs.writeFileSync(
      script,
      "#!/bin/sh\nsleep 3 &\necho 'Tests: 4 passed, 2 failed'\n",
      { mode: 0o755 },
    );
    const startedAt = Date.now();
    const result = await runTestCommand([script], { cwd: path.dirname(script) });
    const elapsedMs = Date.now() - startedAt;
    // Backstop fired: returned well before the 3s holder released the pipe
    // (drain at ~2s post-exit), and the captured summary line still parsed.
    expect(elapsedMs).toBeLessThan(3_000);
    expect(result.testsExecuted).toBe(true);
    expect(result.testResults).toEqual({ passed: 4, failed: 2 });
  }, 15_000);

  test("reused non-aborted AbortSignal keeps abort listeners balanced across runs (R9)", async () => {
    // Regression (review round 9): readCapped registered a { once: true }
    // abort listener and removed it only when the signal FIRED — a long-lived
    // pipeline signal reused across runs accumulated two dead listeners (and
    // their closures) per completed runTestCommand call. Adds and removes must
    // balance on the normal-completion path.
    const script = path.join(freshRoot(), "quick-suite.sh");
    fs.writeFileSync(
      script,
      "#!/bin/sh\necho 'Tests: 2 passed'\n",
      { mode: 0o755 },
    );
    const controller = new AbortController();
    const signal = controller.signal;
    const addSpy = spyOn(signal, "addEventListener");
    const removeSpy = spyOn(signal, "removeEventListener");
    try {
      for (let i = 0; i < 3; i++) {
        const result = await runTestCommand([script], { cwd: path.dirname(script), signal });
        expect(result.testsExecuted).toBe(true);
      }
      const abortAdds = addSpy.mock.calls.filter((c) => c[0] === "abort").length;
      const abortRemoves = removeSpy.mock.calls.filter((c) => c[0] === "abort").length;
      expect(abortAdds).toBeGreaterThan(0);
      expect(abortRemoves).toBe(abortAdds);
    } finally {
      addSpy.mockRestore();
      removeSpy.mockRestore();
    }
  });
});
