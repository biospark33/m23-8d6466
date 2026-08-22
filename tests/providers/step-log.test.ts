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

  // ── what must SURVIVE ────────────────────────────────────────────────────
  //
  // `/`, `.`, `-` and `_` are all inside the long-token charset, so an ordinary
  // absolute path is ONE ≥40-char token mixing all three character classes.
  // Every `/Users`-rooted or CamelCase-repo path with a digit in it was erased,
  // unevenly — which reads in the field as a redaction bug and hides the exact
  // fields these lines exist to carry. Both cases below are the real shapes.

  test("an absolute path and a stack frame survive intact", () => {
    const path = "/Users/steve/QDS-Factory/.sandbox/runs/qds-20260822-a1b2c3.json";
    expect(redactSecrets(`wrote ${path}`)).toBe(`wrote ${path}`);
    const frame = "    at provisionAdmittedRun (/Users/steve/QDS-Factory/src/providers/driver.ts:318:20)";
    expect(redactSecrets(frame)).toBe(frame);
  });

  // ── what must be REDACTED ────────────────────────────────────────────────

  test("an issuer-minted key, an AWS pair, a JWT and a bare base64 blob are all redacted", () => {
    // The prefix arm (unconditional on character classes) covers the first two;
    // the long mixed-class arm is the fallback for the unprefixed rest.
    expect(redactSecrets(`OPENROUTER_API_KEY=${key}`)).toBe("OPENROUTER_API_KEY=«redacted»");
    // BOTH halves of the AWS pair: the id by prefix, the secret by shape.
    const awsPair = redactSecrets(
      "AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
    );
    expect(awsPair).not.toContain("AKIAIOSFODNN7EXAMPLE");
    expect(awsPair).not.toContain("wJalrXUtnFEMI");
    const jwt =
      "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4ifQ.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk";
    expect(redactSecrets(`Authorization: Bearer ${jwt}`)).toBe("Authorization: Bearer «redacted»");
    expect(redactSecrets("blob dGhpcyBpcyBhIHNlY3JldCB2YWx1ZSB0aGF0IGlzIGxvbmcgZW5vdWdo0123")).toBe("blob «redacted»");
  });

  test("the path exemption is not a pass: a secret sitting INSIDE a path still redacts", () => {
    // The segments are re-tested individually against the long-token rule, so
    // the directory stays readable and the leaf goes. Without this the exemption
    // would be a hole exactly the width of `scp /tmp/qds-keys/<key>`.
    const secret = "aB3dEfGhIjKlMnOpQrStUvWxYz0123456789AbCdEf";
    expect(redactSecrets(`scp /tmp/qds-keys/${secret} box:/etc`)).toBe("scp /tmp/qds-keys/«redacted» box:/etc");
    // And a path carrying none of `._:-` fails the exemption outright and is
    // redacted whole — over-redaction is the safe direction here.
    expect(redactSecrets(`scp /tmp/keys/${secret} box:/etc`)).toBe("scp «redacted» box:/etc");
  });

  test("a key-management deep link is redacted despite its percent-encoding", () => {
    // Structurally invisible to all three token arms: no SECRET_PREFIXES entry
    // matches `https`, and encodeURIComponent turns the hash's `+`/`/`/`=` into
    // `%2B`/`%2F`/`%3D`, whose `%` is outside every charset here — so the deep
    // link is never one ≥40-char token. It is caught by DF2.4's own rule,
    // COMPOSED into this one redactor so all four sinks inherit it at once.
    const url = "https://openrouter.ai/api/v1/keys/RGvhoNKDIZzs%2BKKEoJm2Y7CDsY2m1S91GtNb3%2FjvbXbfg%3D";
    expect(redactSecrets(`DELETE ${url} failed`)).toBe("DELETE [REDACTED] failed");
  });

  test("a PEM block is swallowed whole, including its short tail line", () => {
    // `-----BEGIN` IS a known prefix, but the prefix arm's charset excludes the
    // space in `-----BEGIN RSA PRIVATE KEY-----`, so it stopped at the header
    // and left the body to the long-token arm — which sees the body one LINE at
    // a time and passes every line under 40 chars or single-class, i.e. the last
    // line of essentially every key. A private key is a block, not a token.
    const pem = [
      "-----BEGIN OPENSSH PRIVATE KEY-----",
      "b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAABAAAA",
      "AbCd", // the short tail line the token arm would have passed
      "-----END OPENSSH PRIVATE KEY-----",
    ].join("\n");
    expect(redactSecrets(pem)).toBe("«redacted»");
    // A truncated key is still a key: with no END marker the match runs to the
    // end of the text rather than giving up and leaking the body.
    expect(redactSecrets("-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEAx7Vn8sQ2")).toBe("«redacted»");
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
