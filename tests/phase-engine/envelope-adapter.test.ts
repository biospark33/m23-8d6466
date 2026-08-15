/**
 * Envelope adapter tests (Story DF1.2).
 *
 * The adapter's one job: a deterministic subprocess result must travel back
 * through the same door an agent report uses, redacted at the boundary, with
 * `spawnEnv` dropped before anything is serialized.
 */
import { afterAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  OUTPUT_TAIL_CHARS,
  type Envelope,
  type QualityCheckResult,
  asEnvelope,
  truncateTail,
} from "../../src/phase-engine/index.ts";

const tmpRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "df1-2-adapter-")));
afterAll(() => fs.rmSync(tmpRoot, { recursive: true, force: true }));

function result(over: Partial<QualityCheckResult> = {}): QualityCheckResult {
  return {
    name: "tests",
    command: [process.execPath, "-e", "process.exit(1)"],
    exitCode: 1,
    outputTail: "1 pass, 2 fail",
    outputArtifact: path.join(tmpRoot, "tests.log"),
    spawnEnv: {},
    ...over,
  };
}

const ENVELOPE_KEYS = new Set([
  "kind",
  "label",
  "status",
  "summary",
  "outputTail",
  "artifacts",
  "approved",
  "blocking",
  "findings",
  "changedFiles",
]);

describe("asEnvelope (AC2)", () => {
  test("returns the same Envelope type an agent report produces", () => {
    const envelope = asEnvelope(result({ exitCode: 0 }), "tests");
    const agentReport: Envelope = {
      kind: "verify",
      label: "tests",
      status: "success",
      summary: "tests: all checks passed",
    };
    for (const key of Object.keys(envelope)) {
      expect(ENVELOPE_KEYS.has(key)).toBe(true);
    }
    // No source-distinguishing field may ride along.
    expect(Object.keys(envelope)).not.toContain("command");
    expect(Object.keys(envelope)).not.toContain("exitCode");
    expect(Object.keys(envelope)).not.toContain("spawnEnv");
    // Same door: both satisfy the identical structural shape.
    for (const key of Object.keys(agentReport)) {
      expect(key in envelope).toBe(true);
    }
  });

  test("maps exit codes onto the CC-1 taxonomy", () => {
    expect(asEnvelope(result({ exitCode: 0 }), "tests").status).toBe("success");
    expect(asEnvelope(result({ exitCode: 1 }), "tests").status).toBe("logic");
  });

  test("carries the log path as the artifact and names the check in the summary", () => {
    const envelope = asEnvelope(result(), "lint");
    expect(envelope.artifacts).toEqual([path.join(tmpRoot, "tests.log")]);
    expect(envelope.summary).toContain("tests");
    expect(envelope.summary).toContain("1");
  });
});

describe("redaction at the adapter boundary (INV-2)", () => {
  test("a token printed by the subprocess is redacted from outputTail", () => {
    const token = "sk-ant-redacted-token-0123456789";
    const envelope = asEnvelope(
      result({
        spawnEnv: { ANTHROPIC_API_KEY: token },
        outputTail: `fatal: auth failed for ${token}`,
      }),
      "tests",
    );
    expect(envelope.outputTail).toContain("[REDACTED:ANTHROPIC_API_KEY]");
    expect(envelope.outputTail).not.toContain(token);
  });

  test("a secret present ONLY in spawnEnv (absent from process.env) is still redacted", () => {
    const token = "df12-custom-spawn-secret-987654321";
    const envelope = asEnvelope(
      result({
        spawnEnv: { CUSTOM_SECRET_TOKEN: token },
        outputTail: `probe replied: ${token}`,
      }),
      "tests",
    );
    expect(process.env.CUSTOM_SECRET_TOKEN).toBeUndefined();
    expect(envelope.outputTail).toContain("[REDACTED:CUSTOM_SECRET_TOKEN]");
    expect(envelope.outputTail).not.toContain(token);
  });

  test("redaction precedes truncation: a token straddling the 4,000-char cut leaves no partial", () => {
    // The token is 303 chars at the head and the output is 4,108 chars, so
    // the 4,000-char cut would open 108 chars INTO the token if truncation
    // ran first — stranding its unmatched tail past the redactor.
    const token = `df12-straddle-${"v".repeat(280)}-ENDMARK9`;
    const envelope = asEnvelope(
      result({
        spawnEnv: { STRADDLE_TOKEN: token },
        outputTail: `${token}${"y".repeat(3_800)}TRAIL`,
      }),
      "tests",
    );
    expect(envelope.outputTail).toContain("[REDACTED:STRADDLE_TOKEN]");
    expect(envelope.outputTail).not.toContain(token);
    expect(envelope.outputTail).not.toContain("-ENDMARK9");
    expect(envelope.outputTail).toContain("TRAIL");
  });
});

describe("outputTail ceiling (INV-2)", () => {
  test("is bounded to 4,000 characters INCLUDING the truncation suffix", () => {
    const long = `${"x".repeat(9_500)}TAILMARKER`;
    const envelope = asEnvelope(result({ outputTail: long }), "tests");
    expect(envelope.outputTail!.length).toBeLessThanOrEqual(OUTPUT_TAIL_CHARS);
    expect(envelope.outputTail!.length).toBeLessThanOrEqual(4_000);
    expect(envelope.outputTail).toContain("[truncated, ");
    expect(envelope.outputTail).toContain(" chars total]");
    expect(envelope.outputTail).toContain("TAILMARKER");
  });

  test("short tails ride along verbatim with no suffix", () => {
    const envelope = asEnvelope(result({ outputTail: "clean run" }), "tests");
    expect(envelope.outputTail).toBe("clean run");
  });

  test("the ceiling holds even when it is smaller than the truncation suffix", () => {
    // `[truncated, N chars total]` is ~30 chars; a ceiling below that must
    // still bound the result — the suffix is cut to fit, never overrun.
    expect(truncateTail("x".repeat(50), 10)).toHaveLength(10);
    expect(truncateTail("x".repeat(50), 10)).toContain("[trun");
    expect(truncateTail("x".repeat(50), 0)).toBe("");
  });
});

describe("spawnEnv is redaction input only (INV-6)", () => {
  test("the produced envelope serializes without the sentinel or any spawnEnv key", () => {
    const token = "df12-inv6-sentinel-value-424242";
    const envelope = asEnvelope(
      result({ spawnEnv: { WORKER_SECRET_TOKEN: token }, outputTail: "no secrets printed" }),
      "tests",
    );
    const serialized = JSON.stringify(envelope);
    expect(serialized).not.toContain(token);
    expect(serialized).not.toContain("spawnEnv");
  });
});
