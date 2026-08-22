/**
 * DF2.5 step-log tests — timedLoggedStep null/undefined rejection handling (P7)
 *
 * The catch normalizes non-Error rejections (null/undefined) via `(e ?? {})` so
 * logging can't throw. These tests pin that behavior.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { redactSecrets, timedLoggedStep, type StepCtx, type StepLogLabels } from "../../src/providers/step-log.ts";
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

describe("redactSecrets", () => {
  const key = "sk-or-v1-0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcd";

  test("an issuer prefix is redacted whatever its character classes are", () => {
    // The class heuristic is arm 2's fallback only — an all-uppercase+digits
    // `AKIA…` and an all-lowercase `ghp_…` both carry a known prefix.
    expect(redactSecrets("creds AKIAIOSFODNN7EXAMPLE here")).not.toContain("AKIAIOSFODNN7EXAMPLE");
    expect(redactSecrets(`ghp_${"abcdefghij".repeat(4)}`)).not.toContain("abcdefghij");
  });

  test("`keep` restores the named non-secret token and nothing else", () => {
    const hash = "RGvhoNKDIZzsKKEoJm2Y7CDsY2m1S91GtNb3jvbXbfg";
    const text = `DELETE /keys/${hash} failed; retried with ${key}`;
    expect(redactSecrets(text)).not.toContain(hash); // ...without `keep`, gone
    const kept = redactSecrets(text, hash);
    expect(kept).toContain(hash);
    expect(kept).not.toContain(key);
  });

  test("a `keep` shorter than the 8-char floor cannot split a secret out of redaction", () => {
    // "sk-" as `keep` would park a fragment of every key and hand back the
    // pieces unredacted — the floor is what refuses that.
    expect(redactSecrets(`token ${key}`, "sk-")).not.toContain(key.slice(9, 25));
  });
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

  test("non-string message: log line is still written and the original value rethrown", async () => {
    // `??` guards only null/undefined, so a rejection carrying a structured
    // `message` used to reach `.replace` and make the LOGGER the failure —
    // replacing the real one with a TypeError and writing no line at all.
    const step = "nonstring-message-test";
    const thrown = { code: "transport", message: { detail: "socket hang up" } };
    let caught: unknown;
    try {
      await timedLoggedStep(ctx, prefix, step, labels, async () => {
        throw thrown;
      });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBe(thrown); // the original failure, not a TypeError

    const errorLine = logs.find((l) => l.operation === `${prefix}.${step}` && l.status === "error");
    expect(errorLine).toBeDefined();
    expect(errorLine?.error?.code).toBe("transport");
    expect(errorLine?.error?.message).toBe("[object Object]");
  });

  test("a message whose own toString throws is still logged, not rethrown as the logger's failure", async () => {
    const step = "hostile-message-test";
    const thrown = { message: Object.create(null) as unknown as string };
    let caught: unknown;
    try {
      await timedLoggedStep(ctx, prefix, step, labels, async () => {
        throw thrown;
      });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBe(thrown);

    const errorLine = logs.find((l) => l.operation === `${prefix}.${step}` && l.status === "error");
    expect(errorLine?.error?.message).toBe("[unprintable]");
  });

  test("redaction leaves the fields these lines exist to carry readable", async () => {
    // A REAL git SHA shape: lowercase hex WITH digits. `"a".repeat(40)` would
    // fail the mixed-class test on two counts and so prove nothing about the
    // fields this line exists to carry.
    const sha = "a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4";
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
