/**
 * live-probe gate test (JEV-2 INV-J5).
 *
 * Only the PURE gate is tested — no test may run the probe against the
 * network. The gate is the security control: no key, no wire; no explicit
 * steve go (QDS_LIVE_PROBE_CONFIRMED=1), no wire.
 */
import { describe, expect, test } from "bun:test";
import { canonicalRequest, probeGate } from "../../scripts/judgment/live-probe.ts";
import { DEFAULT_MAX_EGRESS_CLASS } from "../../src/judgment/egress.ts";

describe("live-probe gate", () => {
  test("no key → refuse", () => {
    const g = probeGate({ TYPESAFE_API_KEY: undefined, QDS_LIVE_PROBE_CONFIRMED: "1" });
    expect(g.ok).toBe(false);
    if (!g.ok) expect(g.reason).toContain("TYPESAFE_API_KEY");
  });

  test("empty key → refuse", () => {
    const g = probeGate({ TYPESAFE_API_KEY: "", QDS_LIVE_PROBE_CONFIRMED: "1" });
    expect(g.ok).toBe(false);
  });

  test("key without the explicit go flag → refuse (steve-gated spend, §8)", () => {
    const g = probeGate({ TYPESAFE_API_KEY: "k", QDS_LIVE_PROBE_CONFIRMED: undefined });
    expect(g.ok).toBe(false);
    if (!g.ok) expect(g.reason).toContain("QDS_LIVE_PROBE_CONFIRMED");
  });

  test("any go value other than exactly \"1\" → refuse", () => {
    expect(probeGate({ TYPESAFE_API_KEY: "k", QDS_LIVE_PROBE_CONFIRMED: "yes" }).ok).toBe(false);
    expect(probeGate({ TYPESAFE_API_KEY: "k", QDS_LIVE_PROBE_CONFIRMED: "1" }).ok).toBe(true);
  });
});

describe("live-probe canonical request", () => {
  test("ships machine-state only, one noul question (ADR 0001)", () => {
    const req = canonicalRequest();
    expect(req.egressClass).toBe("machine-state");
    expect(DEFAULT_MAX_EGRESS_CLASS).toBe("ac-prose");
    expect(Object.keys(req.questions)).toEqual(["probe_ok"]);
    expect(req.questions.probe_ok.type).toBe("noul");
  });
});
