/**
 * Egress choke-point tests (JEV-2 AC-3, INV-J2).
 *
 * The fence is declaration-discipline, not content sniffing: a fixture
 * DECLARING `diff-hunk` at stage 1 is refused with the ZDR-gate error; an
 * unknown or absent egress class is refused likewise. Per-class redaction is
 * designed fresh here — the tests pin exactly what each class scrubs.
 */
import { describe, expect, test } from "bun:test";
import {
  DEFAULT_MAX_EGRESS_CLASS,
  EGRESS_CLASSES,
  EgressRefusedError,
  egress,
  redactForEgress,
} from "../../src/judgment/egress.ts";

const SECRET_TEXT = 'token sk-abc123DEF456ghi789 set, and Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.sig';
const STATE = `gate verdict: FAIL\nrun exit: 2\n${SECRET_TEXT}`;

describe("class validation", () => {
  test("all four declared classes are the known set", () => {
    expect([...EGRESS_CLASSES]).toEqual(["machine-state", "finding-text", "ac-prose", "diff-hunk"]);
  });

  test("unknown class refused", () => {
    expect(() => egress(STATE, "bot-comment" as never)).toThrow(EgressRefusedError);
    expect(() => egress(STATE, "DIFF-HUNK" as never)).toThrow(EgressRefusedError);
  });

  test("absent class refused (INV-J2: every seam declares what it ships)", () => {
    expect(() => egress(STATE, undefined as never)).toThrow(EgressRefusedError);
    expect(() => egress(STATE, null as never)).toThrow(EgressRefusedError);
  });

  test("stage-1 max class is code-pinned to ac-prose (ADR 0001 ACCEPTED)", () => {
    expect(DEFAULT_MAX_EGRESS_CLASS).toBe("ac-prose");
  });

  test("diff-hunk at stage 1 throws the HARD GATE naming the ZDR addendum (handoff §3.7)", () => {
    let msg = "";
    try {
      egress(STATE, "diff-hunk");
    } catch (e) {
      msg = (e as Error).message;
    }
    expect(msg).toContain("diff-hunk");
    expect(msg).toContain("ZDR");
    expect(msg).toContain("stage 2");
  });
});

describe("per-class redaction (designed fresh — redactSecrets is NOT imported)", () => {
  test("secret-shaped tokens are scrubbed in every allowed class", () => {
    for (const cls of ["machine-state", "finding-text", "ac-prose"] as const) {
      const out = redactForEgress(SECRET_TEXT, cls);
      expect(out).not.toContain("sk-abc123DEF456ghi789");
      expect(out).not.toContain("eyJhbGciOiJIUzI1NiJ9");
      expect(out).toContain("[REDACTED");
    }
  });

  test("key=value / key: value assignments are scrubbed in every allowed class", () => {
    for (const cls of ["machine-state", "finding-text", "ac-prose"] as const) {
      const out = redactForEgress("api_key = hunter2hunter2hunter2", cls);
      expect(out).not.toContain("hunter2hunter2hunter2");
    }
  });

  test("machine-state also scrubs long opaque hex/base64 runs; prose does not", () => {
    const hex = "deadbeef".repeat(8); // 64 chars — an opaque run, not prose
    const machine = redactForEgress(`commit ${hex}`, "machine-state");
    expect(machine).not.toContain(hex);
    // finding-text / ac-prose is lead-authored prose: it may legitimately quote
    // long identifiers, so the aggressive long-run pass is machine-state-only.
    const prose = redactForEgress(`sha ${hex}`, "ac-prose");
    expect(prose).toContain(hex);
  });

  test("ordinary lead-authored prose passes through finding-text unredacted", () => {
    const prose = "The fix loop re-ran twice; classifyDiffScope says the diff is stale.";
    expect(redactForEgress(prose, "finding-text")).toBe(prose);
  });
});

describe("choke point runs before any request is built", () => {
  test("client.judge with a diff-hunk declaration throws before fetch", async () => {
    const { JudgmentClient } = await import("../../src/judgment/client.ts");
    const client = new JudgmentClient(); // mock default
    let fetched = false;
    const orig = globalThis.fetch;
    globalThis.fetch = (async () => {
      fetched = true;
      throw new Error("must not fetch");
    }) as unknown as typeof globalThis.fetch;
    try {
      await expect(
        client.judge("some diff", { q: { type: "noul", instructions: "i" } }, { egressClass: "diff-hunk" }),
      ).rejects.toThrow(EgressRefusedError);
      expect(fetched).toBe(false);
    } finally {
      globalThis.fetch = orig;
    }
  });
});
