/**
 * M2.3 negative-probe battery — unit suite (in-process, no network).
 *
 * The battery's client+assert path is exercised against the SHIPPED gateway
 * refusal ladder: a local Bun.serve stub decodes each request's Authorization
 * header + path bank and calls the REAL verifyRequest(src/memgate) — the only
 * faked part is the wire encoding, which is the documented consumer contract
 * (pi-vs-claude-code-vendor/kg-recall/extensions/kg-recall/client.ts:
 * ok:false → non-200 JSON {error:{code,message}}; ok:true → 200 {results:[]}).
 * Mint/revoke run in-process against a tmpdir ledger (fixture discipline of
 * tests/memgate/gateway.test.ts: env save/strip, no mock library, plain
 * structural fakes). No mock library anywhere.
 *
 * Time control: the ttl probe runs under an ADVANCING injected clock
 * (each read steps CLOCK_STEP_MS) — the battery's poll loop sees now() past
 * expiresAtMs + skew on its first check, so no test wall-clock-waits, while
 * the 1h backstop TTL on the other probes keeps them alive under stepping.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { HindsightClient } from "../../src/hindsight/client.ts";
import type { LogEntry } from "../../src/swarmclaw/log.ts";
import {
  MEMGATE_ADMIN_KEY,
  QDS_MEMGATE_LEDGER,
  QDS_MEMGATE_SIGNING_KEY,
  memgateDeps,
  revokeRunMemoryKey,
  verifyRequest,
  type MemgateDeps,
} from "../../src/memgate/index.ts";
import {
  PROBE_NAMES,
  REQUIRED_ENV_KEYS,
  runNegativeProbeBattery,
  type ProbeBatteryResult,
} from "../../scripts/e2e/memory-negative-probes.ts";

const NOW_MS = Date.parse("2026-10-08T10:00:00.000Z");
const ADMIN = "mgx-admin-sentinel-0000000000000002";
const SIGNING = "mgx-signing-sentinel-0000000000000002";
const BATTERY_REQUEST_ID = "m23-battery-test";
const STUB_REQUEST_ID = "m23-stub-test";

/** Each clock READ advances this far — two reads span the ttl probe's whole
 * expiry+skew window, so its poll loop fires on the first check. */
const CLOCK_STEP_MS = 10_000;

const ENV_KEYS = [
  MEMGATE_ADMIN_KEY,
  QDS_MEMGATE_SIGNING_KEY,
  QDS_MEMGATE_LEDGER,
  "QDS_KG_GATEWAY_URL",
  "HINDSIGHT_BASE_URL",
  "HINDSIGHT_BEARER_TOKEN",
  "HINDSIGHT_API_KEY",
] as const;

let savedEnv: Record<string, string | undefined> = {};
let dir = "";
let clockMs = NOW_MS;
let stubDeps: MemgateDeps | undefined;
let stubEvents: LogEntry[] = [];
let server: ReturnType<typeof Bun.serve> | undefined;

beforeEach(() => {
  savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of ENV_KEYS) delete process.env[k];
  dir = mkdtempSync(join(tmpdir(), "qds-m23-negprobes-"));
  clockMs = NOW_MS;
  stubDeps = undefined;
  stubEvents = [];
  server = undefined;
});

afterEach(() => {
  closeStub();
  rmSync(dir, { recursive: true, force: true });
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

const ledgerPath = (): string => join(dir, "memgate-ledger.db");

/** The shared fixture clock — READS step it forward (see CLOCK_STEP_MS), so the
 * ttl probe's poll loop is past expiry+skew on its first check and its verify
 * read lands past expiry, while the 1h backstop TTL keeps every other probe's
 * key alive across the ~10 reads one battery makes. */
const clock = (): number => {
  clockMs += CLOCK_STEP_MS;
  return clockMs;
};

const batteryEnv = (): Record<string, string> => ({
  [MEMGATE_ADMIN_KEY]: ADMIN,
  [QDS_MEMGATE_SIGNING_KEY]: SIGNING,
  [QDS_MEMGATE_LEDGER]: ledgerPath(),
});

function closeStub(): void {
  server?.stop(true);
  server = undefined;
  try {
    stubDeps?.ledger.close();
  } catch {
    // a faulting close must not mask the test's own failure
  }
  stubDeps = undefined;
}

interface StubOptions {
  /** Negative control: answer 200 {results:[]} to a NO-auth request. */
  answerNoAuth?: boolean;
  /** Force this error code on every refusal (out-of-set → transport-class). */
  errorCode?: string;
  /** Answer refusals with a non-JSON body (transport-class). */
  nonJson?: boolean;
}

/**
 * Local stub origin. The decision is the SHIPPED verifyRequest refusal ladder;
 * only the wire encoding below is the documented consumer contract
 * (kg-recall client.ts: non-2xx JSON {error:{code,message}}, 2xx {results:[]}).
 */
function startStub(opts: StubOptions = {}): string {
  closeStub();
  stubEvents = [];
  const deps = memgateDeps({
    env: batteryEnv(),
    now: clock,
    client: new HindsightClient({ mode: "mock" }),
    log: (entry) => stubEvents.push(entry),
  });
  stubDeps = deps;
  server = Bun.serve({
    port: 0,
    fetch: (req) => {
      const url = new URL(req.url);
      const authHeader = req.headers.get("authorization") ?? undefined;
      if (opts.answerNoAuth === true && authHeader === undefined) {
        return Response.json({ results: [] });
      }
      const v = verifyRequest(deps, {
        authHeader,
        method: req.method,
        path: url.pathname,
        requestId: STUB_REQUEST_ID,
      });
      if (v.ok) return Response.json({ results: [] });
      if (opts.nonJson === true) return new Response("<html>stub non-json</html>", { status: 403 });
      const code = opts.errorCode ?? v.reason;
      return Response.json({ error: { code, message: "refused by stub" } }, { status: 403 });
    },
  });
  return `http://127.0.0.1:${server.port}`;
}

async function runBattery(origin: string): Promise<ProbeBatteryResult> {
  return runNegativeProbeBattery({
    origin,
    env: batteryEnv(),
    requestId: BATTERY_REQUEST_ID,
    now: clock,
  });
}

const outcomeOf = (result: ProbeBatteryResult, probe: string) => {
  const o = result.outcomes.find((x) => x.probe === probe);
  if (o === undefined) throw new Error(`outcome for ${probe} missing`);
  return o;
};

describe("M2.3 memory-negative-probes battery", () => {
  test("each of the five probes produces its expected named reason through the shipped ladder", async () => {
    const origin = startStub();
    const result = await runBattery(origin);
    expect(result.allRefused).toBe(true);
    expect(result.outcomes.map((o) => o.probe)).toEqual([...PROBE_NAMES]);
    expect(result.outcomes.map((o) => o.reason)).toEqual([
      "no-auth",
      "scope-bank",
      "scope-bank",
      "expired",
      "revoked",
    ]);
    const noAuth = outcomeOf(result, "no-auth");
    expect(noAuth.httpStatus).toBe(403);
    // exactly 4 mints: keyA, keyB, the ttl key, the revoked key (no-auth mints none)
    expect(result.mintedTokenIds).toHaveLength(4);
    // the stub-side refused lines prove the SHIPPED ladder decided each probe
    expect(stubEvents.filter((e) => e.event === "memgate-refused").map((e) => e.reason)).toEqual([
      "no-auth",
      "scope-bank",
      "scope-bank",
      "expired",
      "revoked",
    ]);
    expect(result.cleanup?.every((c) => c.result !== "failed")).toBe(true);
  });

  test("negative control: a 200 on no-auth flips the probe to refused:false and allRefused:false", async () => {
    const origin = startStub({ answerNoAuth: true });
    const result = await runBattery(origin);
    const noAuth = outcomeOf(result, "no-auth");
    expect(noAuth.httpStatus).toBe(200);
    expect(noAuth.refused).toBe(false);
    expect(noAuth.reason).toBeNull();
    expect(result.allRefused).toBe(false);
  });

  test("an out-of-set error code is transport-class (reason null, never a refusal)", async () => {
    const origin = startStub({ errorCode: "totally-unknown-code" });
    const result = await runBattery(origin);
    const crossRun = outcomeOf(result, "cross-run");
    expect(crossRun.httpStatus).toBe(403);
    expect(crossRun.refused).toBe(false);
    expect(crossRun.reason).toBeNull();
    expect(result.allRefused).toBe(false);
  });

  test("a non-JSON refusal body is transport-class (reason null)", async () => {
    const origin = startStub({ nonJson: true });
    const result = await runBattery(origin);
    const ttl = outcomeOf(result, "ttl");
    expect(ttl.httpStatus).toBe(403);
    expect(ttl.refused).toBe(false);
    expect(ttl.reason).toBeNull();
    expect(result.allRefused).toBe(false);
  });

  test("cleanup revokes every minted token id (post-battery revoke → already-gone)", async () => {
    const origin = startStub();
    const result = await runBattery(origin);
    expect(result.mintedTokenIds.length).toBeGreaterThan(0);
    for (const c of result.cleanup ?? []) {
      expect(c.result !== "failed").toBe(true);
    }
    for (const tokenId of result.mintedTokenIds) {
      expect(revokeRunMemoryKey(stubDeps as MemgateDeps, { tokenId, requestId: "post-battery" })).toBe(
        "already-gone",
      );
    }
  });

  test("CLI env-refusal: no gateway/admin env → exit 2, never spends", async () => {
    const scrubbed: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) {
      if (v === undefined || (REQUIRED_ENV_KEYS as readonly string[]).includes(k)) continue;
      scrubbed[k] = v;
    }
    const proc = Bun.spawn(["bun", "scripts/e2e/memory-negative-probes.ts"], {
      env: scrubbed,
      stdout: "pipe",
      stderr: "pipe",
      cwd: join(import.meta.dir, "..", ".."),
    });
    const [exit, errText] = await Promise.all([proc.exited, new Response(proc.stderr).text()]);
    expect(exit).toBe(2);
    expect(errText).toContain("refusing");
  }, { timeout: 30_000 });
});
