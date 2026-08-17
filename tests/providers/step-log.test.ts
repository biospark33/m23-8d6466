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
});
