/**
 * DF2.5 step-log tests — timedLoggedStep null/undefined rejection handling (P7)
 *
 * The catch normalizes non-Error rejections (null/undefined) via `(e ?? {})` so
 * logging can't throw. These tests pin that behavior.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { timedLoggedStep, type StepCtx, type StepLogLabels } from "../../src/providers/step-log.ts";
import { setLogSink, type LogEntry } from "../../src/swarmclaw/log.ts";

let logs: LogEntry[];
let restoreLog: (() => void) | undefined;

beforeEach(() => {
  logs = [];
  restoreLog = setLogSink((entry) => logs.push(entry));
});

afterEach(() => {
  restoreLog?.();
});

describe("timedLoggedStep", () => {
  const ctx: StepCtx = { requestId: "test-req", runId: "test-run", driver: "test-driver" };
  const prefix = "test";
  const labels: StepLogLabels = { ok: "ok", error: "failed", errorCode: "UNKNOWN_ERROR" };

  test("null rejection: rethrows null, log carries fallback code with message 'null', status 'error', outcome labels.error", async () => {
    const step = "null-test";
    let caught: unknown;
    try {
      await timedLoggedStep(ctx, prefix, step, labels, async () => {
        throw null;
      });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBe(null);

    const errorLine = logs.find((l) => l.operation === `${prefix}.${step}` && l.status === "error");
    expect(errorLine).toBeDefined();
    expect(errorLine?.error?.code).toBe(labels.errorCode);
    expect(errorLine?.error?.message).toBe("null");
    expect(errorLine?.status).toBe("error");
    expect(errorLine?.outcome).toBe(labels.error);
  });

  test("undefined rejection: rethrows undefined, log carries fallback code with message 'undefined', status 'error', outcome labels.error", async () => {
    const step = "undefined-test";
    let caught: unknown;
    try {
      await timedLoggedStep(ctx, prefix, step, labels, async () => {
        throw undefined;
      });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBe(undefined);

    const errorLine = logs.find((l) => l.operation === `${prefix}.${step}` && l.status === "error");
    expect(errorLine).toBeDefined();
    expect(errorLine?.error?.code).toBe(labels.errorCode);
    expect(errorLine?.error?.message).toBe("undefined");
    expect(errorLine?.status).toBe("error");
    expect(errorLine?.outcome).toBe(labels.error);
  });

  test("Error with code+remediation: log preserves code/message/remediation, rethrown unchanged (same reference)", async () => {
    class CustomError extends Error {
      constructor(
        message: string,
        public code: string,
        public remediation: string,
      ) {
        super(message);
        this.name = "CustomError";
      }
    }

    const step = "custom-error-test";
    const originalError = new CustomError("something failed", "CUSTOM_CODE", "try X then Y");
    let caught: unknown;
    try {
      await timedLoggedStep(ctx, prefix, step, labels, async () => {
        throw originalError;
      });
    } catch (e) {
      caught = e;
    }

    // same reference rethrown
    expect(caught).toBe(originalError);

    const errorLine = logs.find((l) => l.operation === `${prefix}.${step}` && l.status === "error");
    expect(errorLine).toBeDefined();
    expect(errorLine?.error?.code).toBe("CUSTOM_CODE");
    expect(errorLine?.error?.message).toBe("something failed");
    expect(errorLine?.remediation).toBe("try X then Y");
    expect(errorLine?.status).toBe("error");
    expect(errorLine?.outcome).toBe(labels.error);
  });

  test("successful step: log carries status 'ok', outcome labels.ok, duration fields", async () => {
    const step = "success-test";
    await timedLoggedStep(ctx, prefix, step, labels, async () => {
      return 42;
    });

    const okLine = logs.find((l) => l.operation === `${prefix}.${step}` && l.status === "ok");
    expect(okLine).toBeDefined();
    expect(okLine?.status).toBe("ok");
    expect(okLine?.outcome).toBe(labels.ok);
    expect(typeof okLine?.duration).toBe("number");
    expect(typeof okLine?.durationMs).toBe("number");
    expect(typeof okLine?.[`${step}_ms`]).toBe("number");
  });

  test("a key echoed in the failure message never reaches the log line (INV-2/INV-4)", async () => {
    // How the leak actually arrives: an exec wrapper reporting the argv it ran,
    // and `deliverRunKey`'s argv carries the minted key in plaintext.
    const key = "sk-or-v1-0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcd";
    const step = "deliver";
    await expect(
      timedLoggedStep(ctx, prefix, step, labels, async () => {
        throw Object.assign(new Error(`exec failed: sh -c 'echo OPENROUTER_API_KEY=${key} >> /box/.env'`), {
          code: "exec-failed",
          remediation: `re-run: ssh box 'echo ${key}'`,
        });
      }),
    ).rejects.toThrow();

    const line = logs.find((l) => l.operation === `${prefix}.${step}` && l.status === "error");
    expect(JSON.stringify(line)).not.toContain(key);
    expect(JSON.stringify(line)).not.toContain("sk-or-v1-");
    // Redacted, not dropped — the operator still learns which step and why.
    expect(line?.error?.message).toContain("exec failed");
    expect(line?.error?.code).toBe("exec-failed");
    expect(line?.remediation).toContain("re-run");
  });

  test("redaction leaves the fields these lines exist to carry readable", async () => {
    const sha = "a".repeat(40); // all-lowercase hex: not mixed-class, not a secret
    const step = "harvest";
    await expect(
      timedLoggedStep(ctx, prefix, step, labels, async () => {
        throw new Error(`clone at ${sha} failed for run qds-20260822-a1b2c3`);
      }),
    ).rejects.toThrow();

    const line = logs.find((l) => l.operation === `${prefix}.${step}` && l.status === "error");
    expect(line?.error?.message).toContain(sha);
    expect(line?.error?.message).toContain("qds-20260822-a1b2c3");
  });
});
