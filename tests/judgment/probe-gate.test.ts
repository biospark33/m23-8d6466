/**
 * live-probe gate test (JEV-2 INV-J5).
 *
 * Only the PURE gate is tested — no test may run the probe against the
 * network. The gate is the security control: no key, no wire; no explicit
 * steve go (QDS_LIVE_PROBE_CONFIRMED=1), no wire.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  canonicalRequest,
  diffEnvelope,
  main as liveProbeMain,
  PROBE_PROVIDER,
  probeGate,
} from "../../scripts/judgment/live-probe.ts";
import { DEFAULT_MAX_EGRESS_CLASS } from "../../src/judgment/egress.ts";
import { DEFAULT_PROVENANCE_DIR, JudgmentClient, TYPESAFE_API_URL, TYPESAFE_MODEL } from "../../src/judgment/index.ts";

/**
 * main() and a default-dir mock client write provenance to the REAL default
 * side-channel dir (tracked files live there). Snapshot it once per file and
 * remove only what this file's tests added, so a test run never leaves
 * untracked judgment files behind.
 */
let provenanceAtStart = new Set<string>();
function provenanceFiles(): Set<string> {
  try {
    return new Set(readdirSync(DEFAULT_PROVENANCE_DIR));
  } catch {
    return new Set();
  }
}
beforeAll(() => {
  provenanceAtStart = provenanceFiles();
});
afterAll(() => {
  for (const f of provenanceFiles()) {
    if (!provenanceAtStart.has(f)) rmSync(join(DEFAULT_PROVENANCE_DIR, f), { force: true });
  }
});

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

/**
 * v6 J1 AC6 — the probe reaches the wire through the REGISTRY-resolved `jev`
 * adapter, never a hand-constructed transport, and the INV-J5 double gate
 * still refuses before any request exists. The live arm runs against a
 * `globalThis.fetch` stub — no test touches the network.
 */
describe("live-probe through the provider registry (J1 AC6)", () => {
  const PROBE_SRC = join(import.meta.dir, "..", "..", "scripts", "judgment", "live-probe.ts");
  const ENV_KEYS = ["TYPESAFE_API_KEY", "QDS_LIVE_PROBE_CONFIRMED", "TYPESAFE_MOCK"] as const;
  const originalFetch = globalThis.fetch;
  let savedEnv: [string, string | undefined][] = [];
  let fetched: { url: string; body: unknown }[] = [];
  let out: string[] = [];
  let tmp: string;

  beforeEach(() => {
    savedEnv = ENV_KEYS.map((k) => [k, process.env[k]]);
    for (const k of ENV_KEYS) {
      delete process.env[k];
    }
    fetched = [];
    out = [];
    tmp = mkdtempSync(join(tmpdir(), "live-probe-"));
    globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit): Promise<Response> => {
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      fetched.push({ url: typeof input === "string" ? input : input.toString(), body });
      return new Response(
        JSON.stringify({
          model: TYPESAFE_MODEL,
          answers: { probe_ok: { type: "noul", noul: 0.97 } },
          usage: { input_tokens: 42, output_tokens: 1 },
        }),
        { status: 200 },
      );
    }) as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    for (const [k, v] of savedEnv) {
      if (v === undefined) {
        delete process.env[k];
      } else process.env[k] = v;
    }
    rmSync(tmp, { recursive: true, force: true });
  });

  function captureConsole(): () => void {
    const log = spyOn(console, "log").mockImplementation((s: unknown) => {
      out.push(String(s));
    });
    const err = spyOn(console, "error").mockImplementation((s: unknown) => {
      out.push(String(s));
    });
    return () => {
      log.mockRestore();
      err.mockRestore();
    };
  }

  test("the probe imports no adapter module — the registry is its only route to a transport", () => {
    const src = readFileSync(PROBE_SRC, "utf8");
    expect(src).not.toMatch(/src\/judgment\/adapters\//);
    expect(src).not.toMatch(/\bmake(Jev|Mock)Provider\b/);
    expect(src).toMatch(/\bresolveProvider\(PROBE_PROVIDER\)/);
    expect(PROBE_PROVIDER).toBe("jev");
  });

  test("live arm: one request through the registered jev adapter to the pinned endpoint, provider named before fire", async () => {
    process.env.TYPESAFE_API_KEY = "test-key-not-a-real-credential";
    process.env.QDS_LIVE_PROBE_CONFIRMED = "1";
    const restore = captureConsole();
    try {
      await expect(liveProbeMain([])).resolves.toBeUndefined();
    } finally {
      restore();
    }
    expect(fetched.length).toBe(1);
    expect(fetched[0]!.url).toBe(TYPESAFE_API_URL);
    expect((fetched[0]!.body as { model: string }).model).toBe(TYPESAFE_MODEL);
    const text = out.join("\n");
    expect(text).toContain("provider jev");
    expect(text).toContain("contract matches");
    // spend is printed BEFORE the fire line, and the observed usage after
    expect(text.indexOf("spend:")).toBeGreaterThan(-1);
    expect(text.indexOf("spend:")).toBeLessThan(text.indexOf("contract matches"));
    expect(text).not.toContain("test-key-not-a-real-credential");
  });

  test("--evidence-dir writes one scrubbed timestamped evidence JSON naming provider, transport and the clean diff", async () => {
    process.env.TYPESAFE_API_KEY = "test-key-not-a-real-credential";
    process.env.QDS_LIVE_PROBE_CONFIRMED = "1";
    const restore = captureConsole();
    try {
      await liveProbeMain(["--evidence-dir", tmp]);
    } finally {
      restore();
    }
    const files = readdirSync(tmp);
    expect(files.length).toBe(1);
    expect(files[0]).toMatch(/^live-probe-\d{8}T\d{6}Z\.json$/);
    const raw = readFileSync(join(tmp, files[0]!), "utf8");
    expect(raw).not.toContain("test-key-not-a-real-credential");
    const ev = JSON.parse(raw);
    expect(ev).toMatchObject({
      provider: "jev",
      transport: "live",
      contractDiff: "clean",
      endpoint: TYPESAFE_API_URL,
      spend: { requests: 1, input_tokens: 42, output_tokens: 1 },
      envelope: { model: TYPESAFE_MODEL, egress_class: "machine-state" },
    });
  });

  test("under TYPESAFE_MOCK=1 the evidence says transport mock — a mock run can never pass as live evidence", async () => {
    process.env.TYPESAFE_API_KEY = "test-key-not-a-real-credential";
    process.env.QDS_LIVE_PROBE_CONFIRMED = "1";
    process.env.TYPESAFE_MOCK = "1";
    const restore = captureConsole();
    try {
      await liveProbeMain(["--evidence-dir", tmp]);
    } finally {
      restore();
    }
    expect(fetched.length).toBe(0);
    const ev = JSON.parse(readFileSync(join(tmp, readdirSync(tmp)[0]!), "utf8"));
    expect(ev).toMatchObject({ provider: "mock", transport: "mock" });
    expect(out.join("\n")).toContain("provider mock");
  });

  for (const [name, env] of [
    ["no key", { QDS_LIVE_PROBE_CONFIRMED: "1" }],
    ["no confirm flag", { TYPESAFE_API_KEY: "test-key-not-a-real-credential" }],
  ] as const) {
    test(`${name} → refused before any request is built or sent`, async () => {
      Object.assign(process.env, env);
      const exit = spyOn(process, "exit").mockImplementation(((code: number) => {
        throw new Error(`exit:${code}`);
      }) as never);
      const restore = captureConsole();
      try {
        await expect(liveProbeMain(["--evidence-dir", tmp])).rejects.toThrow("exit:1");
      } finally {
        exit.mockRestore();
        restore();
      }
      expect(fetched.length).toBe(0);
      expect(readdirSync(tmp)).toEqual([]);
      expect(out.join("\n")).toContain("refusing to run");
      expect(out.join("\n")).not.toContain("spend:");
    });
  }

  test("an unknown --flag is refused (no silent typo of --evidence-dir)", async () => {
    await expect(liveProbeMain(["--evidence", tmp])).rejects.toThrow(/unknown argument/);
  });
});
