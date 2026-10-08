/**
 * live-probe gate test (JEV-2 INV-J5).
 *
 * Only the PURE gate is tested — no test may run the probe against the
 * network. The gate is the security control: no key, no wire; no explicit
 * steve go (QDS_LIVE_PROBE_CONFIRMED=1), no wire.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
import { JudgmentClient, TYPESAFE_API_URL, TYPESAFE_MODEL } from "../../src/judgment/index.ts";

/**
 * Every main()/client in this file writes provenance to a per-file tmp dir —
 * never the REAL default side-channel dir, which holds tracked files and is
 * shared with any live judge run in the same checkout.
 */
let TMP_PROVENANCE = "";
beforeAll(() => {
  TMP_PROVENANCE = mkdtempSync(join(tmpdir(), "probe-gate-prov-"));
});
afterAll(() => {
  rmSync(TMP_PROVENANCE, { recursive: true, force: true });
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
      await expect(liveProbeMain([], { provenanceDir: TMP_PROVENANCE })).resolves.toBeUndefined();
      expect(probedLog.join("")).toContain("contract matches");
      expect(probedErr.join("")).not.toContain("CONTRACT DRIFT");
    } finally {
      log.mockRestore();
      err.mockRestore();
    }
  });

  test("diffEnvelope accepts a contract-shaped envelope and drifts (exit 2) on a moved model", async () => {
    const client = new JudgmentClient({ mode: "mock", provenanceDir: TMP_PROVENANCE });
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
 * still refuses before any request exists. The live arms run against a
 * `globalThis.fetch` stub — no test touches the network.
 */
describe("live-probe through the provider registry (J1 AC6)", () => {
  const PROBE_SRC = join(import.meta.dir, "..", "..", "scripts", "judgment", "live-probe.ts");
  const ENV_KEYS = ["TYPESAFE_API_KEY", "QDS_LIVE_PROBE_CONFIRMED", "TYPESAFE_MOCK"] as const;
  const KEY = "test-key-not-a-real-credential";
  const GOOD_BODY = {
    model: TYPESAFE_MODEL,
    answers: { probe_ok: { type: "noul", noul: 0.97 } },
    usage: { input_tokens: 42, output_tokens: 1 },
  };
  const originalFetch = globalThis.fetch;
  let savedEnv: [string, string | undefined][] = [];
  let fetched: { url: string; body: unknown }[] = [];
  let out: string[] = [];
  let tmp: string;

  function serve(status: number, body: unknown): void {
    globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit): Promise<Response> => {
      fetched.push({
        url: typeof input === "string" ? input : input.toString(),
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
      });
      return new Response(JSON.stringify(body), { status });
    }) as typeof fetch;
  }

  beforeEach(() => {
    savedEnv = ENV_KEYS.map((k) => [k, process.env[k]]);
    for (const k of ENV_KEYS) delete process.env[k];
    fetched = [];
    out = [];
    tmp = mkdtempSync(join(tmpdir(), "live-probe-"));
    serve(200, GOOD_BODY);
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    for (const [k, v] of savedEnv) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    rmSync(tmp, { recursive: true, force: true });
  });

  function go(): void {
    process.env.TYPESAFE_API_KEY = KEY;
    process.env.QDS_LIVE_PROBE_CONFIRMED = "1";
  }

  /** Run main with console captured and process.exit turned into a throw. */
  async function runMain(argv: string[]): Promise<{ exit?: number; error?: Error }> {
    const log = spyOn(console, "log").mockImplementation((s: unknown) => {
      out.push(String(s));
    });
    const err = spyOn(console, "error").mockImplementation((s: unknown) => {
      out.push(String(s));
    });
    const exit = spyOn(process, "exit").mockImplementation(((code: number) => {
      throw new Error(`exit:${code}`);
    }) as never);
    try {
      await liveProbeMain(argv, { provenanceDir: TMP_PROVENANCE });
      return {};
    } catch (e) {
      const m = (e as Error).message.match(/^exit:(\d+)$/);
      return m ? { exit: Number(m[1]) } : { error: e as Error };
    } finally {
      log.mockRestore();
      err.mockRestore();
      exit.mockRestore();
    }
  }

  function evidence(): Record<string, unknown>[] {
    return readdirSync(tmp).map((f) => JSON.parse(readFileSync(join(tmp, f), "utf8")));
  }

  test("the probe has no route to a transport but the client — no adapter import, no maker, no raw HTTP", () => {
    const src = readFileSync(PROBE_SRC, "utf8");
    expect(src).not.toMatch(/src\/judgment\/(adapters\/|provider\.ts)/);
    expect(src).not.toMatch(/\b(makeJevProvider|makeMockProvider|JUDGMENT_PROVIDERS|resolveProvider)\b/);
    expect(src).not.toMatch(/\bhttpRequest\(|\bfetch\(/);
    expect(PROBE_PROVIDER).toBe("jev");
  });

  test("live arm: one request through the registry-resolved jev adapter to the pinned endpoint; provider + spend named before fire", async () => {
    go();
    expect(await runMain([])).toEqual({});
    expect(fetched.length).toBe(1);
    expect(fetched[0]!.url).toBe(TYPESAFE_API_URL);
    expect((fetched[0]!.body as { model: string }).model).toBe(TYPESAFE_MODEL);
    const text = out.join("\n");
    expect(text).toContain("provider jev (registry-resolved, transport live)");
    expect(text.indexOf("spend:")).toBeGreaterThan(-1);
    expect(text.indexOf("spend:")).toBeLessThan(text.indexOf("contract matches"));
    expect(text).not.toContain(KEY);
    expect(readdirSync(TMP_PROVENANCE).length).toBeGreaterThan(0);
  });

  test("--evidence-dir writes one scrubbed, ms-stamped evidence JSON naming provider, transport and the clean diff", async () => {
    go();
    expect(await runMain(["--evidence-dir", tmp])).toEqual({});
    const files = readdirSync(tmp);
    expect(files.length).toBe(1);
    expect(files[0]).toMatch(/^live-probe-\d{8}T\d{9}Z-[\w-]{1,8}\.json$/);
    expect(readFileSync(join(tmp, files[0]!), "utf8")).not.toContain(KEY);
    expect(evidence()[0]).toMatchObject({
      provider: "jev",
      transport: "live",
      contractDiff: "clean",
      endpoint: TYPESAFE_API_URL,
      spend: { requests: 1, input_tokens: 42, output_tokens: 1 },
      envelope: { model: TYPESAFE_MODEL, egress_class: "machine-state" },
    });
  });

  test("two rounds into the same evidence dir never collide", async () => {
    go();
    expect(await runMain(["--evidence-dir", tmp])).toEqual({});
    expect(await runMain(["--evidence-dir", tmp])).toEqual({});
    expect(readdirSync(tmp).length).toBe(2);
  });

  test("under TYPESAFE_MOCK=1 the evidence says transport mock with no endpoint — a mock run can never pass as live evidence", async () => {
    go();
    process.env.TYPESAFE_MOCK = "1";
    expect(await runMain(["--evidence-dir", tmp])).toEqual({});
    expect(fetched.length).toBe(0);
    expect(evidence()[0]).toMatchObject({ provider: "mock", transport: "mock", endpoint: null });
    expect(out.join("\n")).toContain("provider mock (registry-resolved, transport mock)");
  });

  test("a drifting live body is recorded as drift evidence, then exits 2", async () => {
    go();
    serve(200, { ...GOOD_BODY, answers: { probe_ok: { type: "noul", noul: true } } });
    expect(await runMain(["--evidence-dir", tmp])).toEqual({ exit: 2 });
    const [ev] = evidence();
    expect(String(ev?.contractDiff)).toStartWith("drift: ");
    expect(ev).toMatchObject({ transport: "live", envelope: null, error: { status: 502 } });
    expect(out.join("\n")).toContain("CONTRACT DRIFT");
  });

  test("an HTTP refusal is recorded as error evidence and rethrown (not mislabelled drift)", async () => {
    go();
    serve(401, { message: "bad key" });
    const r = await runMain(["--evidence-dir", tmp]);
    expect(r.error?.message).toContain("HTTP 401");
    expect(evidence()[0]).toMatchObject({ contractDiff: "error: http_401", error: { status: 401 }, envelope: null });
  });

  test("an unusable --evidence-dir is refused BEFORE the paid request", async () => {
    go();
    const file = join(tmp, "not-a-dir");
    writeFileSync(file, "x");
    const r = await runMain(["--evidence-dir", file]);
    expect(r.error).toBeDefined();
    expect(fetched.length).toBe(0);
    expect(out.join("\n")).not.toContain("spend:");
  });

  for (const [name, env] of [
    ["no key", { QDS_LIVE_PROBE_CONFIRMED: "1" }],
    ["no confirm flag", { TYPESAFE_API_KEY: KEY }],
  ] as const) {
    test(`${name} → refused before any request is built or sent`, async () => {
      Object.assign(process.env, env);
      expect(await runMain(["--evidence-dir", tmp])).toEqual({ exit: 1 });
      expect(fetched.length).toBe(0);
      expect(readdirSync(tmp)).toEqual([]);
      expect(out.join("\n")).toContain("refusing to run");
      expect(out.join("\n")).not.toContain("spend:");
    });
  }

  for (const [argv, msg] of [
    [["--evidence", "x"], /unknown argument/],
    [["--evidence-dir"], /needs a directory value/],
    [["--evidence-dir", ""], /needs a directory value/],
    [["--evidence-dir", "-out"], /needs a directory value/],
    [["--evidence-dir", "a", "--evidence-dir", "b"], /given twice/],
  ] as const) {
    test(`argv ${JSON.stringify(argv)} is refused before the gate (${msg.source})`, async () => {
      go();
      const r = await runMain([...argv]);
      expect(r.error?.message).toMatch(msg);
      expect(fetched.length).toBe(0);
    });
  }
});
