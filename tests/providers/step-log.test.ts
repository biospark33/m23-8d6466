/**
 * DF2.5 step-log tests — timedLoggedStep null/undefined rejection handling (P7)
 *
 * The catch normalizes non-Error rejections (null/undefined) via `(e ?? {})` so
 * logging can't throw. These tests pin that behavior.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { redactSecrets, timedLoggedStep, type StepCtx, type StepLogLabels } from "../../src/providers/step-log.ts";
import { setLogSink, type LogEntry } from "../../src/swarmclaw/log.ts";
import { leakScan } from "./fixtures/leak-scan.ts";

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
    //
    // `leakScan`, not `not.toContain(key.slice(9, 25))`: a single hand-picked
    // window only proves that ONE window is gone. The failure this guards
    // against is the floor being lowered and the key coming back in PIECES, and
    // any regression that leaves a different piece behind — a tail, a middle
    // run — passes a single-window check. `leakScan` walks every 8-char
    // fragment, which is the redactor's own boundary constant.
    expect(leakScan(key, redactSecrets(`token ${key}`, "sk-"))).toBeNull();
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
    const awsId = "AKIAIOSFODNN7EXAMPLE";
    const awsSecret = "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY";
    const awsPair = redactSecrets(`AWS_ACCESS_KEY_ID=${awsId} AWS_SECRET_ACCESS_KEY=${awsSecret}`);
    // `leakScan`, not `not.toContain("wJalrXUtnFEMI")`: the secret carries `/`,
    // which is inside BOTH token charsets, so the plausible regression here is a
    // charset or path-exemption change that stops the match at the first `/` and
    // leaves `K7MDENG/bPxRfiCYEXAMPLEKEY` in the log. A prefix-fragment check
    // passes right through that; scanning every 8-char fragment does not.
    expect(leakScan(awsId, awsPair)).toBeNull();
    expect(leakScan(awsSecret, awsPair)).toBeNull();
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

  test("an unterminated `-----BEGIN` is BOUNDED — it cannot erase the rest of a long diagnostic", () => {
    // The tail of the PEM alternation used to be `|$`, i.e. unbounded: one
    // `-----BEGIN` in provider free text with no closing marker swallowed the
    // message to its end, so a whole multi-KB `driver.exec` diagnostic came out
    // as the six characters of the placeholder. The text is whatever the BOX
    // printed, which makes a whole-message eraser purchasable for ten literal
    // characters. The cap is what turns that from "erase everything" into
    // "erase 8 KB".
    // The real shape: an unterminated key body, then a long run of ordinary
    // provider prose — the `driver.exec` diagnostic an operator needs.
    const keyBody = "MIIEowIBAAKCAQEAx7Vn8sQ2".repeat(125); // 3 KB, inside the cap
    const prose = "connection refused on port 22. ".repeat(800); // ~24 KB readable
    const out = redactSecrets(`stderr: -----BEGIN ${keyBody}\n${prose}`);

    // The block itself is gone — every 8-char fragment of it.
    expect(out).not.toContain("-----BEGIN");
    expect(leakScan(keyBody, out)).toBeNull();
    expect(out).toContain("«redacted»");

    // And the diagnostic past the 8 KB cap comes back. Unbounded, the ENTIRE
    // message collapsed to the placeholder; the cap is what turns "erase
    // everything" into "erase 8 KB".
    expect(out.startsWith("stderr: ")).toBe(true);
    expect(out).toContain("connection refused on port 22");
    expect(out.length).toBeGreaterThan(10_000);
  });

  test("a diagnostic full of `-----BEGIN` mentions redacts in linear time, not quadratically", () => {
    // The bounded arm is ordered terminated-first and its SECOND branch cannot
    // fail, which is what keeps the scan linear. A bounded arm that CAN fail is
    // retried at every `-----BEGIN` in the text and pays the full 8 KB cap each
    // time — measured at 3.7 s on a 1 MB input against ~1 ms here. The input
    // below is 4× that size, so the quadratic shape costs ~15 s against the
    // unchanged 2 s ceiling: slow CI drifts the LINEAR figure (still hundreds
    // of ms) without ever letting the QUADRATIC one under the bar.
    const noisy = "-----BEGIN mention in provider output. ".repeat(100_000); // ~4 MB
    const started = Date.now();
    redactSecrets(noisy);
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  test("a JSON-ESCAPED PEM body on one line is swallowed whole by the same arm", () => {
    // How the block actually reaches the redactor from structured sinks: a log
    // entry stringified to JSON turns every newline into the two literal
    // characters `\` + `n`, so the block arrives as ONE line with no `\n` byte
    // anywhere in it. The PEM arm's body matcher is `[\s\S]{0,N}?`, i.e. ANY
    // character including those two, so escaping must not reopen the hole the
    // arm closed — most importantly for the short tail line the long-token arm
    // would otherwise pass.
    const pem = [
      "-----BEGIN OPENSSH PRIVATE KEY-----",
      "b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAABAAAA",
      "AbCd", // the short tail line the token arm would have passed
      "-----END OPENSSH PRIVATE KEY-----",
    ].join("\\n"); // literal backslash-n between segments, JSON-style
    const wrapped = JSON.stringify({ stderr: pem });
    const out = redactSecrets(wrapped);
    expect(out).not.toContain("b3BlbnNzaC1rZXktdjE");
    expect(leakScan(pem, out)).toBeNull();
    expect(out).toContain("«redacted»");
  });

  test("the `keep` splice-back is budgeted: forged marks in provider text stay literal", () => {
    // `split(KEEP_MARK).join(keep)` restored at EVERY mark, including ones the
    // SOURCE text supplied — so provider text carrying N forged marks expanded
    // the log line by N × the hash length, a cheap attacker-chosen
    // amplification into the log sink. The forged marks are harmless in
    // themselves (only a non-secret identifier is ever spliced in); the COUNT
    // was the problem.
    const hash = "RGvhoNKDIZzsKKEoJm2Y7CDsY2m1S91GtNb3jvbXbfg";
    // Three forged marks, one genuine occurrence to park.
    const text = `box said «keep» «keep» «keep» while deleting ${hash}`;
    const out = redactSecrets(text, hash);
    // Exactly one restoration — the one this call actually parked.
    expect(out.split(hash).length - 1).toBe(1);
    // The forgeries are left as the literal mark, not expanded and not turned
    // into anything else.
    expect(out.split("«keep»").length - 1).toBe(3);
  });

  test("single-character-class tokens redact; SHAs, paths and stack frames still survive", () => {
    // The rule used to be ≥40 chars AND all three of [a-z], [A-Z], \d, so any
    // token missing ONE class passed at ANY length. Those are shapes issuers
    // actually mint, so it was not a narrow residual — it was a hole the width
    // of every single-class alphabet.
    const lower = "abcdefghijklmnopqrstuvwxyzabcdefghijklmnop"; // 42, all lowercase
    const upperDigit = "ABCDEFGHIJ1234567890ABCDEFGHIJ1234567890AB"; // 42, upper+digits
    const digits = "1".repeat(45); // all digits — a real 40-char hex digest is
    // all-digit at probability (10/16)^40 ≈ 1e-9, which is why the exemption
    // requires an a–f letter rather than just "looks hexy".
    for (const token of [lower, upperDigit, digits]) {
      expect(redactSecrets(`blob ${token} end`)).toBe("blob «redacted» end");
    }

    // What must still be READABLE — the fields these lines exist to carry.
    // Both hex cases: a lowercase git SHA and an uppercase digest.
    const sha = "a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4";
    const upperSha = sha.toUpperCase();
    expect(redactSecrets(`clone at ${sha}`)).toBe(`clone at ${sha}`);
    expect(redactSecrets(`digest ${upperSha}`)).toBe(`digest ${upperSha}`);
    // MIXED-case hex is NOT a digest shape anyone emits, and letting it through
    // would widen the exemption to a two-class alphabet.
    const mixedHex = `${sha.slice(0, 20).toUpperCase()}${sha.slice(20)}`;
    expect(redactSecrets(`odd ${mixedHex}`)).toBe("odd «redacted»");
    // Paths and frames keep their own exemption (covered above); re-asserted
    // here because widening the token rule is exactly the change that breaks it.
    const path = "/Users/steve/QDS-Factory/.sandbox/runs/qds-20260822-a1b2c3.json";
    expect(redactSecrets(`wrote ${path}`)).toBe(`wrote ${path}`);
    const frame = "    at provisionAdmittedRun (/Users/steve/QDS-Factory/src/providers/driver.ts:318:20)";
    expect(redactSecrets(frame)).toBe(frame);
  });

  // Every body is a PLACEHOLDER, deliberately not the issuer's real shape, and
  // that costs the test nothing: `SECRET_PREFIX_RE` is `<prefix>` followed by
  // `[A-Za-z0-9+/=_.:-]*` — zero or more — so the arm under test is driven
  // identically by a 24-character placeholder and a 36-character token. What the
  // real shapes DID buy was a push block: `ghs_[A-Za-z0-9]{36}` and the Slack
  // and Stripe patterns are what repository secret scanning matches, so fixtures
  // wearing them cost a triage cycle each for strings that were never issued.
  //
  // The placeholders are also a STRONGER test than the tokens they replace. The
  // old `xapp-`/`xoxa-`/`xoxr-`/`rk_*` bodies ran past LONG_TOKEN_RE's 40-char
  // floor, so the shape heuristic would have redacted them with the prefix entry
  // deleted — the row passed without proving the thing it names. Under the floor
  // (asserted below) the prefix arm is the ONLY arm that can reach them.
  test.each([
    ["xapp-", "xapp-EXAMPLE-NOT-A-REAL-TOKEN"],
    ["xoxa-", "xoxa-EXAMPLE-NOT-A-REAL-TOKEN"],
    ["xoxr-", "xoxr-EXAMPLE-NOT-A-REAL-TOKEN"],
    ["rk_live_", "rk_live_EXAMPLE_NOT_A_REAL_KEY"],
    ["rk_test_", "rk_test_EXAMPLE_NOT_A_REAL_KEY"],
    ["ghs_", "ghs_EXAMPLE_NOT_A_REAL_TOKEN"],
    ["ghu_", "ghu_EXAMPLE_NOT_A_REAL_TOKEN"],
    ["ghr_", "ghr_EXAMPLE_NOT_A_REAL_TOKEN"],
  ])("the %s issuer prefix is redacted on sight", (_prefix, token) => {
    // The prefix arm is UNCONDITIONAL on character classes: a known issuer
    // prefix is the strong signal, so the shape heuristic is never the sole
    // test for a token the issuer has already labelled. `ghs_` is the one a
    // real clone URL carries (`https://x-access-token:ghs_…@github.com/…`),
    // and the shape heuristic cannot reach it at all — anything matching
    // `scheme://` returns early.
    // Under LONG_TOKEN_RE's 40-char floor BY CONSTRUCTION, so the assertions
    // below can only be satisfied by the prefix arm. Without this, re-lengthening
    // a body would quietly hand the row back to the shape heuristic.
    expect(token.length).toBeLessThan(40);
    const out = redactSecrets(`auth failed for ${token}`);
    expect(leakScan(token, out)).toBeNull();
    expect(out).toContain("«redacted»");
  });

  test.each([
    ["bare, space-delimited", (k: string) => `key ${k} used`],
    ["JSON string value", (k: string) => `{"api_key": "${k}"}`],
    ["inside a quoted header", (k: string) => `curl -H "X-Goog-Api-Key: ${k}" https://example.test`],
  ])("a Google API key is redacted when %s", (_shape, wrap) => {
    // A Google API key is 39 characters — one SHORT of LONG_TOKEN_RE's 40-char
    // floor, and that floor is load-bearing at 40 because a git SHA sits there.
    // So the shape heuristic cannot reach this issuer at any charset and the
    // `AIza` prefix is the only thing that catches it.
    //
    // Deliberately NOT `GOOGLE_API_KEY=<key>`: that one redacts for the WRONG
    // reason — `=` is inside the token charset, so it glues the variable name
    // onto the key and pushes the run past the 40-char floor. It would pass
    // with the prefix entry removed, which makes it false comfort. Each shape
    // here is delimited by a character OUTSIDE the token charset, so only the
    // prefix arm can catch it.
    const gkey = "AIzaSyD-1a2B3c4D5e6F7g8H9i0J1k2L3m4N5oP";
    expect(gkey).toHaveLength(39); // one under the floor, by construction
    const out = redactSecrets(wrap(gkey));
    expect(leakScan(gkey, out)).toBeNull();
    expect(out).toContain("«redacted»");
  });

  test("a redactor that throws returns the marker, never the text it failed to clear", () => {
    // Every caller is a catch block logging someone else's failure, so a throw
    // escaping here would REPLACE the failure being reported with this
    // function's own. The fallback can never be the raw text either: the raw
    // text is exactly what was not yet proven free of key material. Losing a
    // diagnostic beats leaking a key.
    //
    // `keep` is the reachable hostile input — it arrives as a provider-supplied
    // keyHash — and both shapes below throw INSIDE the guarded body: one at the
    // length floor, one at the `split` coercion.
    const text = `revoke failed for ${key}`;
    const throwsOnLength = Object.defineProperty({}, "length", {
      get() {
        throw new Error("hostile length");
      },
    }) as unknown as string;
    const throwsOnToString = Object.assign(Object.create({
      toString() {
        throw new Error("hostile toString");
      },
    }), { length: 12 }) as unknown as string;

    for (const hostile of [throwsOnLength, throwsOnToString]) {
      const out = redactSecrets(text, hostile);
      expect(out).toBe("«redacted»");
      // The whole point: not the raw text, and not a partially-cleared version
      // of it.
      expect(leakScan(key, out)).toBeNull();
    }
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
