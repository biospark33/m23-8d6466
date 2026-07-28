import { describe, expect, it } from "bun:test";
import { redactBoundaryPrefix, redactSecrets } from "../src/redact.ts";

// Focused tests for the extracted redaction/KMP security layer (#62). Moved
// verbatim from runner.test.ts — same assertions, now against ../src/redact.ts.

describe("redactSecrets (extended SECRET_KEY_RE heuristic)", () => {
  it("redacts values under DATABASE_URL / DSN / CRED / CERT / PASS / PRIVATE keys", () => {
    const parent = {
      DATABASE_URL: "postgres://fake-host/db",
      APP_DSN: "hunter2-dsn-value",
      GH_CREDS: "sk-test-creds-1234",
      CLIENT_CERT: "hunter2-cert-pem-material",
      DB_PASSPHRASE: "hunter2-passphrase",
      PRIVATE_KEY: "hunter2-privatekey-material",
    };
    const out = redactSecrets(Object.values(parent).join(" "), parent);
    for (const [key, value] of Object.entries(parent)) {
      expect(out).not.toContain(value);
      expect(out).toContain(`[REDACTED:${key}]`);
    }
  });

  it("leaves short values (< 8 chars) and non-secret keys alone", () => {
    const out = redactSecrets("short7! visible-text", {
      MY_SECRET: "short7!",
      EDITOR: "visible-text",
    });
    expect(out).toBe("short7! visible-text");
  });

  it("processes overlapping secret values longest-first so no tail leaks", () => {
    const parent = {
      MY_PASS: "hunter2",
      MY_TOKEN: "hunter2-abc123",
    };
    const out = redactSecrets("value: hunter2-abc123", parent);
    expect(out).not.toContain("hunter2-abc123");
    expect(out).not.toContain("hunter2");
    expect(out).toContain("[REDACTED:MY_TOKEN]");
  });

  it("does not corrupt markers when a shorter secret value is a substring of a marker", () => {
    const parent = {
      LONG_TOKEN: "hunter2-abc123",
      SHORT_TOKEN: "REDACTED",
    };
    const out = redactSecrets("hunter2-abc123", parent);
    expect(out).toBe("[REDACTED:LONG_TOKEN]");
    expect(out).not.toContain("[REDACTED:SHORT_TOKEN]");
  });

  it("redacts values under extended secret-key patterns", () => {
    const parent = {
      API_KEY: "ak-12345678",
      SERVICE_URL: "https://example.com/secret",
      DATABASE_URI: "db://secret",
      SSH_PRIVATE: "ssh-12345678",
      SIGNING_KEY: "sk-12345678",
      AUTH_TOKEN: "at-12345678",
    };
    const out = redactSecrets(Object.values(parent).join(" "), parent);
    for (const [key, value] of Object.entries(parent)) {
      expect(out).not.toContain(value);
      expect(out).toContain(`[REDACTED:${key}]`);
    }
  });

  it("deduplicates shared secret values instead of emitting duplicate regex branches", () => {
    const shared = "hunter2-shared-secret-value";
    const parent = {
      FIRST_TOKEN: shared,
      SECOND_TOKEN: shared,
    };
    const out = redactSecrets(`prefix ${shared} suffix`, parent);
    expect(out).not.toContain(shared);
    // Identical values must redact once; the first key in insertion order owns
    // the label, so no duplicate `[REDACTED:SECOND_TOKEN]` marker is produced.
    expect(out).toContain("[REDACTED:FIRST_TOKEN]");
    expect(out).not.toContain("[REDACTED:SECOND_TOKEN]");
  });
});

describe("redactBoundaryPrefix (INV-2 truncation-boundary hardening)", () => {
  it("redacts a trailing secret prefix that reaches the truncation boundary", () => {
    const parent = { MY_SECRET_TOKEN: "hunter2-super-secret-boundary-value" };
    const text = `prefix-${parent.MY_SECRET_TOKEN.slice(0, 12)}`;
    expect(redactBoundaryPrefix(text, parent)).toBe("prefix-[REDACTED:MY_SECRET_TOKEN]");
  });

  it("strips a short (< 8 chars) trailing secret prefix without a marker", () => {
    const parent = { MY_SECRET_TOKEN: "hunter2supersecret" };
    const text = `prefix-${parent.MY_SECRET_TOKEN.slice(0, 3)}`;
    expect(redactBoundaryPrefix(text, parent)).toBe("prefix-");
  });

  it("is safe when a very long secret value is checked against a short text", () => {
    const parent = { MY_CERT: "A".repeat(10_000) };
    const text = "short text with no cert prefix";
    const start = Date.now();
    const out = redactBoundaryPrefix(text, parent);
    expect(Date.now() - start).toBeLessThan(100);
    expect(out).toBe(text);
  });

  it("still redacts a long secret when its prefix lands at the text boundary", () => {
    const secret = "A".repeat(10_000);
    const parent = { MY_CERT: secret };
    const text = `prefix-${secret.slice(0, 20)}`;
    expect(redactBoundaryPrefix(text, parent)).toBe("prefix-[REDACTED:MY_CERT]");
  });

  it("completes fast on an adversarial divergent-prefix secret (O(n²) DoS guard)", () => {
    // Adversarial shape that made the naive suffix scan quadratic: the secret's
    // prefix matches the text tail for exactly 4096 chars, then diverges at a
    // "B". A uniform repeated value hits a full-match early-break and stays
    // cheap; the mid-string divergence defeats every early-break, so an unguarded
    // char-by-char scan is O(4096 × text.length) — ~1.2e9 comparisons / ~11s
    // wall-clock here. KMP makes boundary matching linear (O(text.length +
    // value.length) per secret), so it stays well under a second.
    const N = 300_000;
    const secret = `${"A".repeat(4096)}B${"A".repeat(N)}`;
    const parent = { MY_SECRET_TOKEN: secret };
    const text = `benign output ${"A".repeat(N)}`;
    const start = Date.now();
    const out = redactBoundaryPrefix(text, parent);
    const elapsed = Date.now() - start;
    // Unfixed (naive scan) this runs for ~11s; linear KMP keeps it fast.
    expect(elapsed).toBeLessThan(2000);
    // Correctness is preserved: the 4096-char matching tail is a >= 8-char
    // secret prefix, so it is redacted, and benign output ahead of the cut is
    // untouched (the longest prefix-suffix here is exactly k=4096).
    expect(out).toBe(`benign output ${"A".repeat(N - 4096)}[REDACTED:MY_SECRET_TOKEN]`);
  });

  it("redacts a truncation-boundary prefix LONGER than 4096 chars (no cap leak)", () => {
    // Regression for the security hole the 4096 cap opened: when the truncation
    // cut leaves a >4KB prefix of a long secret at the boundary, no k <= 4096
    // matches the true prefix-suffix length, so the capped scan found nothing and
    // the ENTIRE secret fragment leaked into stdout_excerpt. With linear KMP
    // (no cap) the full boundary prefix is redacted regardless of length.
    const secret = `AKIA${"x".repeat(6000)}`; // 6004-char secret
    const parent = { AWS_SECRET_ACCESS_KEY: secret };
    const cut = 5000; // truncation cut leaves 5000 (>4096) secret chars at boundary
    const text = `log line\n${secret.slice(0, cut)}`;
    const out = redactBoundaryPrefix(text, parent);
    expect(out).toBe("log line\n[REDACTED:AWS_SECRET_ACCESS_KEY]");
  });

  it("redacts a complete secret that lands at the text boundary (terminal full-match)", () => {
    // Defensive fallback for the terminal full-match: if a complete secret value
    // reaches redactBoundaryPrefix un-redacted at the very end of the text, the
    // KMP helper must report the full value.length (not a smaller internal border)
    // so the caller's `k >= value.length` cap redacts it (value.length - 1 chars)
    // instead of leaking the whole value. The pre-fix terminal reset returned the
    // proper border (0 for this no-border value), so the complete secret leaked.
    const secret = "Aa1Bb2Cc3Dd4Ee5Ff6Gg7Hh8"; // 24 chars, pi[23] = 0 (no border)
    const parent = { MY_SECRET_TOKEN: secret };
    const text = `log line\n${secret}`; // text ENDS with the complete secret
    const out = redactBoundaryPrefix(text, parent);
    expect(out).toBe(`log line\n${secret[0]}[REDACTED:MY_SECRET_TOKEN]`);
  });
});
