/**
 * live-probe gate test (JEV-2 INV-J5).
 *
 * Only the PURE gate is tested — no test may run the probe against the
 * network. The gate is the security control: no key, no wire; no explicit
 * steve go (QDS_LIVE_PROBE_CONFIRMED=1), no wire.
 */
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import {
  canonicalRequest,
  diffEnvelope,
  main as liveProbeMain,
  probeGate,
} from "../../scripts/judgment/live-probe.ts";
import { DEFAULT_MAX_EGRESS_CLASS } from "../../src/judgment/egress.ts";
import { JudgmentClient } from "../../src/judgment/index.ts";

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

/**
 * The wire-adjacent assembly, pinned OFF the wire.
 *
 * `liveProbeMain` runs here under TYPESAFE_MOCK=1, which forces the client
 * into mock mode EVEN THOUGH main constructs it with mode:"live" (client.ts
 * resolves the env flag ahead of the constructor arg) — so the full path is
 * scored in-process, where the coverage gate can see it, without a single
 * byte on the network. INV-J5 holds in tests as in prod: no key and no go
 * flag, no wire.
 */
describe("live-probe main + contract diff (mock mode, never the network)", () => {
  const GO_KEYS = ["TYPESAFE_API_KEY", "QDS_LIVE_PROBE_CONFIRMED", "TYPESAFE_MOCK"] as const;
  let saved: [string, string | undefined][] = [];
  let probedLog: string[] = [];
  let probedErr: string[] = [];

  afterEach(() => {
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    saved = [];
    probedLog = [];
    probedErr = [];
  });

  test("main resolves under the mock override — full path, zero network", async () => {
    saved = GO_KEYS.map((k) => [k, process.env[k]]);
    process.env.TYPESAFE_API_KEY = "test-key-not-a-real-credential";
    process.env.QDS_LIVE_PROBE_CONFIRMED = "1";
    process.env.TYPESAFE_MOCK = "1";
    const log = spyOn(console, "log").mockImplementation((s: unknown) => {
      probedLog.push(String(s));
    });
    const err = spyOn(console, "error").mockImplementation((s: unknown) => {
      probedErr.push(String(s));
    });
    try {
      await expect(liveProbeMain()).resolves.toBeUndefined();
      expect(probedLog.join("")).toContain("contract matches");
      expect(probedErr.join("")).not.toContain("CONTRACT DRIFT");
    } finally {
      log.mockRestore();
      err.mockRestore();
    }
  });

  test("diffEnvelope accepts a contract-shaped envelope and drifts (exit 2) on a moved model", async () => {
    const client = new JudgmentClient({ mode: "mock" });
    const env = await client.judge(
      "probe diff check",
      { probe_ok: { type: "noul", instructions: "ok" } },
      { egressClass: "machine-state" },
    );
    expect(() => diffEnvelope(env)).not.toThrow();

    const exit = spyOn(process, "exit").mockImplementation((() => undefined) as never);
    const err = spyOn(console, "error").mockImplementation((s: unknown) => {
      probedErr.push(String(s));
    });
    try {
      diffEnvelope({ ...env, model: "drifted-model" } as unknown as typeof env);
      expect(exit).toHaveBeenCalledWith(2);
      expect(probedErr.join("")).toContain("CONTRACT DRIFT");
    } finally {
      exit.mockRestore();
      err.mockRestore();
    }
  });
});
