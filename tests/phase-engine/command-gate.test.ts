/**
 * commandGate tests (Story DF1.2).
 *
 * INV-1: argv array, never a shell string. AC5: a subprocess that cannot be
 * spawned at all is a failed check — never a pass, never a skip.
 */
import { afterAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { commandGate } from "../../src/phase-engine/index.ts";

const tmpRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "df1-2-cmdgate-")));
afterAll(() => fs.rmSync(tmpRoot, { recursive: true, force: true }));
const gateCtx = { runRoot: tmpRoot };

describe("commandGate (INV-1, AC5)", () => {
  test("exit 0 is one passing check whose note is the evidence", async () => {
    const gate = commandGate([process.execPath, "-e", "process.exit(0)"]);
    const report = await gate.run(undefined, gateCtx);
    expect(report.checks).toHaveLength(1);
    expect(report.checks[0]!.ok).toBe(true);
    expect(report.checks[0]!.note).toBe("exit 0");
    expect(report.passed).toBe(true);
  });

  test("non-zero exit fails with the exit code and the output tail in the note", async () => {
    const gate = commandGate([
      process.execPath,
      "-e",
      "console.log('unit failed: expected 1 got 2'); process.exit(3)",
    ]);
    const report = await gate.run(undefined, gateCtx);
    expect(report.passed).toBe(false);
    expect(report.checks[0]!.note).toContain("exit 3");
    expect(report.checks[0]!.note).toContain("unit failed");
  });

  test("the note tail is bounded to the last 1,000 characters of output", async () => {
    const gate = commandGate([
      process.execPath,
      "-e",
      "console.log('x'.repeat(5000) + 'ENDMARK'); process.exit(1)",
    ]);
    const report = await gate.run(undefined, gateCtx);
    const note = report.checks[0]!.note;
    expect(note).toContain("ENDMARK");
    expect(note.length).toBeLessThanOrEqual("exit 1\n".length + 1_000);
  });

  test("a secret printed by the subprocess is redacted from the note (INV-2)", async () => {
    const token = "df12-gate-secret-token-31415926";
    const gate = commandGate(
      [process.execPath, "-e", `console.log('key=' + process.env.GATE_TEST_TOKEN); process.exit(1)`],
      { env: { PATH: process.env.PATH ?? "", GATE_TEST_TOKEN: token } },
    );
    const report = await gate.run(undefined, gateCtx);
    expect(report.passed).toBe(false);
    expect(report.checks[0]!.note).toContain("[REDACTED:GATE_TEST_TOKEN]");
    expect(report.checks[0]!.note).not.toContain(token);
  });

  test("redaction precedes the tail cut: a token straddling the 1,000-char window leaves no partial (INV-2)", async () => {
    const token = "df12-cut-straddle-token-24682468";
    // Geometry: the token spans [202, 234) of a 1,205-char output, so the
    // 1,000-char tail window opens at 205 — 3 chars INTO the token. Truncating
    // before redacting would strand its unmatched tail in the note; redacting
    // first shrinks the text so the window opens before the replacement
    // marker instead, which must ride along whole.
    const gate = commandGate(
      [
        process.execPath,
        "-e",
        `console.log('x'.repeat(200) + 'p=' + process.env.GATE_CUT_TOKEN + 'y'.repeat(967) + 'END'); process.exit(1)`,
      ],
      { env: { PATH: process.env.PATH ?? "", GATE_CUT_TOKEN: token } },
    );
    const report = await gate.run(undefined, gateCtx);
    const note = report.checks[0]!.note;
    expect(note).toContain("[REDACTED:GATE_CUT_TOKEN]");
    expect(note).not.toContain(token);
    expect(note).not.toContain("24682468");
    expect(note).toContain("END");
  });

  test("a binary that cannot be spawned is a failed check naming the error (AC5)", async () => {
    const gate = commandGate(["/no/such/binary-df12-9x7"]);
    const report = await gate.run(undefined, gateCtx);
    expect(report.checks).toHaveLength(1);
    expect(report.checks[0]!.ok).toBe(false);
    expect(report.checks[0]!.note).toMatch(/spawn/i);
    expect(report.passed).toBe(false);
  });

  test("argv is never a shell string: shell metacharacters stay literal (INV-1)", async () => {
    const gate = commandGate([
      process.execPath,
      "-e",
      "console.log(process.argv.slice(1).join('|'))",
      "a; rm -rf /",
      "b && c",
    ]);
    const report = await gate.run(undefined, gateCtx);
    expect(report.passed).toBe(true);
    expect(report.checks[0]!.note).toBe("exit 0");
  });

  test("the gate's name carries the label or argv so events stay legible", async () => {
    const labeled = commandGate([process.execPath, "-e", "process.exit(0)"], { label: "pi-lens" });
    expect(labeled.name).toContain("pi-lens");
    const plain = commandGate([process.execPath, "--version"]);
    expect(plain.name).toContain(process.execPath);
  });

  test("the existing verifier scripts register unchanged (P0.5/P0.6, zero edits)", async () => {
    // The registration path only: both scripts keep their own exit-code
    // contracts and plug in as argv. Live spawns are not exercised here —
    // each script has its own verify entry point (`verify:pi-lens`,
    // `verify:lsp`) and takes minutes; commandGate's behaviour over a
    // subprocess exit code is covered by the tests above.
    for (const script of ["scripts/pi-lens-verify.ts", "scripts/lsp-verify.ts"]) {
      expect(fs.existsSync(path.join(process.cwd(), script))).toBe(true);
      const gate = commandGate([process.execPath, script, "--json"]);
      expect(typeof gate.run).toBe("function");
      expect(gate.name).toContain(script);
    }
  });

  test("empty argv returns a failed check with 'argv is empty' note", async () => {
    const gate = commandGate([]);
    const report = await gate.run(undefined, gateCtx);
    expect(report.passed).toBe(false);
    expect(report.checks).toHaveLength(1);
    expect(report.checks[0]!.ok).toBe(false);
    expect(report.checks[0]!.note).toContain("argv is empty");
  });

  // POSIX-only: on Windows libuv emulates SIGKILL via TerminateProcess, so the
  // child exits with a numeric code and signalCode is null — the gate then
  // truthfully reports the exit-code branch instead of "killed by signal".
  test.skipIf(process.platform === "win32")("signal death is reported with signal name in note", async () => {
    const gate = commandGate([process.execPath, "-e", "process.kill(process.pid, 'SIGKILL')"]);
    const report = await gate.run(undefined, gateCtx);
    expect(report.passed).toBe(false);
    expect(report.checks).toHaveLength(1);
    expect(report.checks[0]!.ok).toBe(false);
    expect(report.checks[0]!.note).toContain("killed by signal");
  });

  test("when all output is redacted, note contains fallback text", async () => {
    const secret = "df12-all-redacted-secret-27182818";
    const gate = commandGate(
      [process.execPath, "-e", "console.log(process.env.ALL_REDACTED_SECRET); process.exit(1)"],
      { env: { PATH: process.env.PATH ?? "", ALL_REDACTED_SECRET: secret } },
    );
    const report = await gate.run(undefined, gateCtx);
    expect(report.passed).toBe(false);
    expect(report.checks[0]!.note).toContain("(all output redacted)");
    expect(report.checks[0]!.note).not.toContain(secret);
  });
});
