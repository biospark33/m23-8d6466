/**
 * M2.1 memory gateway — per-run key lifecycle, TDD suite (written RED).
 *
 * Mirror target: src/providers/credentials.ts runCredentialLifecycle (:1622-1727)
 * — ordering, compensation, retry posture — per the m2-1 PLAN contracts (D1-D4).
 * Mock boundary: a structural FAKE client ({recall, reflect, consolidate, retain})
 * with a call recorder — no network anywhere; deps.client is always injected and
 * deps.now is fixed, so the suite is deterministic and offline. The ledger is the
 * REAL MemgateLedger over a per-test mkdtemp tmpdir; env paths (C-5) point INSIDE
 * the tmpdir so an accidental default-path open can never resolve at the repo
 * root. The modules under test (src/memgate/{schemas,ledger,gateway}.ts) do not
 * exist yet — the static imports below fail at load, which IS the red phase.
 *
 * Fault injection: the delivery target is the filesystem, so
 *  - a grammar-invalid target ("../") refuses PRE-mint (env-file-invalid), and
 *  - a grammar-valid target under a regular FILE (blocker) passes the assert and
 *    fails at write time — the compensation path — with the path embedded in the
 *    original fault's message (the credentials :1258-1303 real-fs-sentinel idiom).
 * The named discrimination case (deliver-state-write-failed) is triggered through
 * the injectable deps.log: the post-write state emit throws, delivery having
 * already succeeded.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { setLogSink, type LogEntry } from "../../src/swarmclaw/log.ts";
import {
  DEFAULT_KEY_TTL_BACKSTOP_MS,
  MEMGATE_ADMIN_KEY,
  MEMGATE_ENV_FILE,
  MemgateError,
  QDS_MEMGATE_SIGNING_KEY,
  VERB_ROUTES,
} from "../../src/memgate/schemas.ts";
import { MemgateLedger } from "../../src/memgate/ledger.ts";
import {
  forwardScoped,
  mintRunMemoryKey,
  runMemoryKeyLifecycle,
  verifyRequest,
  type MemgateDeps,
} from "../../src/memgate/gateway.ts";

// ---------------------------------------------------------------------------
// Fixtures — tmpdir layout, env discipline (C-5), fake client, deps factory
// ---------------------------------------------------------------------------

const NOW_MS = Date.parse("2026-10-07T10:00:00.000Z");
const ADMIN_KEY = "mgadm-test-admin-key-0001";
const SIGNING_KEY = "mgsgn-test-signing-key-0000001";
const GATEWAY_URL = "http://127.0.0.1:18890";

const ENV_KEYS = [
  "QDS_MEMGATE_LEDGER",
  "MEMGATE_ADMIN_KEY",
  "QDS_MEMGATE_SIGNING_KEY",
  "QDS_KG_RECALL_KEY",
  "QDS_KG_GATEWAY_URL",
  "MEMGATE_ENV_FILE",
] as const;

type Verb = "recall" | "reflect" | "consolidate" | "retain";
interface ClientCall {
  verb: Verb;
  bankId: string;
}

let savedEnv: Record<string, string | undefined> = {};
let dir = "";
let logs: LogEntry[] = [];
let restoreLog: (() => void) | undefined;
let ledger: MemgateLedger = undefined as unknown as MemgateLedger;
let clientFake: MemgateDeps["client"] = undefined as unknown as MemgateDeps["client"];
let clientCalls: ClientCall[] = [];

const ledgerPath = () => join(dir, "memgate-ledger.db");

beforeEach(() => {
  savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of ENV_KEYS) delete process.env[k];
  dir = mkdtempSync(join(tmpdir(), "qds-m21-lifecycle-"));
  // C-5: the env-pointed ledger lives INSIDE the tmpdir — a stray default-path
  // open resolves into the fixture sandbox, never the repo root.
  process.env.QDS_MEMGATE_LEDGER = ledgerPath();
  logs = [];
  restoreLog = setLogSink((entry) => logs.push(entry));
  const fresh = makeClient();
  clientCalls = fresh.calls;
  clientFake = fresh.client;
  ledger = new MemgateLedger(ledgerPath());
});

afterEach(() => {
  restoreLog?.();
  restoreLog = undefined;
  try {
    ledger?.close();
  } catch {
    // a faulting close must not mask the test's own failure
  }
  ledger = undefined as unknown as MemgateLedger;
  rmSync(dir, { recursive: true, force: true });
  for (const k of ENV_KEYS) {
    const v = savedEnv[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

function runId(n: number): string {
  return `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
}

function at<T>(arr: T[], i: number): T {
  const v = arr[i];
  if (v === undefined) throw new Error(`fixture index ${i} out of range`);
  return v;
}

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function num(v: unknown): number {
  return typeof v === "number" ? v : Number.NaN;
}

/** The default happy-path lifecycle options; spread overrides per test. */
function lifecycleOpts(
  over: Partial<Parameters<typeof runMemoryKeyLifecycle>[1]> = {},
): Parameters<typeof runMemoryKeyLifecycle>[1] {
  return {
    runId: runId(1),
    banks: ["bank-a"],
    ttlMs: 60 * 60 * 1000,
    target: join(dir, "delivered.env"),
    gatewayUrl: GATEWAY_URL,
    requestId: "req-lifecycle",
    ...over,
  };
}

function deps(overrides: Partial<MemgateDeps> = {}): MemgateDeps {
  return {
    ledger,
    client: clientFake,
    now: () => NOW_MS,
    signingKey: SIGNING_KEY,
    adminKey: ADMIN_KEY,
    // R2-F-002: env-wired hand-built deps — requireAdmin compares the PRESENTED
    // adminKey against the CONFIGURED env value, timing-safe. (Without env a
    // hand-built deps fails admin-auth CLOSED by design.)
    env: { [MEMGATE_ADMIN_KEY]: ADMIN_KEY, [QDS_MEMGATE_SIGNING_KEY]: SIGNING_KEY },
    ...overrides,
  };
}

/**
 * Structural fake of the forwarded HindsightClient subset — plain object, no
 * mock library (R2 §7). biome noExplicitAny is off repo-wide (R2 §8); the any
 * signatures keep the fake assignable to whatever client subset MemgateDeps
 * names, canned bodies included.
 */
function makeClient(
  overrides: Partial<Record<Verb, (...args: any[]) => Promise<any>>> = {},
): { calls: ClientCall[]; client: MemgateDeps["client"] } {
  const calls: ClientCall[] = [];
  const base = {
    recall: async (bankId: string, _query?: unknown, _limit?: unknown) => {
      calls.push({ verb: "recall", bankId });
      return { results: [], durationMs: 0 };
    },
    reflect: async (bankId: string, _query?: unknown) => {
      calls.push({ verb: "reflect", bankId });
      return { bankId, insights: [], durationMs: 0 };
    },
    consolidate: async (bankId: string, _options?: unknown) => {
      calls.push({ verb: "consolidate", bankId });
      return { bankId };
    },
    retain: async (bankId: string, _content?: unknown, _metadata?: unknown) => {
      calls.push({ verb: "retain", bankId });
      return { success: true, items_count: 1, async: false };
    },
  };
  return {
    calls,
    // Overriding verbs must still RECORD (the call-count assertions observe
    // `calls`): wrap each override record-then-delegate instead of letting the
    // spread shadow the base recorder. (Driver fix, PLAN rev 3 — the bare
    // spread made `failing.calls` provably unable to exceed 0.)
    client: {
      ...base,
      ...Object.fromEntries(
        Object.entries(overrides).map(([verb, fn]) => [
          verb,
          async (...args: unknown[]) => {
            calls.push({ verb: verb as Verb, bankId: args[0] as string });
            return await (fn as (...a: unknown[]) => Promise<unknown>)(...args);
          },
        ]),
      ),
    } as unknown as MemgateDeps["client"],
  };
}

/**
 * Grammar-valid target that PASSES the pre-mint assert and fails at write
 * time: its parent is a regular file, so mkdir/open under it cannot succeed.
 * The original fault's message embeds the "blocker" path segment.
 */
function blockerTarget(): string {
  const blocker = join(dir, "blocker");
  writeFileSync(blocker, "a regular file — the delivery write under it must fail\n");
  return join(blocker, "box.env");
}

/** The ONE ledger mutation the compensation uses, wrapped as a recorder. */
function ledgerWithRecorder(
  opts: { faultOnRevoke?: boolean } = {},
): { wrapped: MemgateLedger; revokedTokenIds: string[] } {
  const revokedTokenIds: string[] = [];
  const wrapped = Object.create(ledger) as MemgateLedger;
  wrapped.recordRevocation = ((tokenId: string, ...rest: unknown[]) => {
    revokedTokenIds.push(tokenId);
    if (opts.faultOnRevoke) {
      throw new MemgateError("revoke-failed", "sentinel-compensation-fault", "injected fault");
    }
    return (ledger.recordRevocation as (...a: unknown[]) => unknown)(tokenId, ...rest);
  }) as MemgateLedger["recordRevocation"];
  return { wrapped, revokedTokenIds };
}

function issuedRows(): Array<Record<string, unknown>> {
  return ledger.listIssued() as unknown as Array<Record<string, unknown>>;
}

function onlyIssuance(): Record<string, unknown> {
  const rows = issuedRows();
  expect(rows.length).toBe(1);
  return at(rows, 0);
}

function eventOf(entry: LogEntry): string | undefined {
  const e = entry.event;
  return typeof e === "string" ? e : undefined;
}

function memgateEvents(): string[] {
  return logs
    .map(eventOf)
    .filter((e): e is string => typeof e === "string" && e.startsWith("memgate-"));
}

function memgateLines(): LogEntry[] {
  return logs.filter((l) => (eventOf(l) ?? "").startsWith("memgate-"));
}

/**
 * Duplicate-inline leakScan (D5 — no shared fixtures file): every ≥8-char
 * substring of the secret against every corpus line. Returns the needles that
 * leaked; the caller asserts the empty array.
 */
function leakScan(secret: string, corpora: string[]): string[] {
  const hits: string[] = [];
  for (let len = 8; len <= secret.length; len++) {
    for (let start = 0; start + len <= secret.length; start++) {
      const needle = secret.slice(start, start + len);
      for (const corpus of corpora) {
        if (corpus.includes(needle) && !hits.includes(needle)) hits.push(needle);
      }
    }
  }
  return hits;
}

// ---------------------------------------------------------------------------
// lifecycle-order — AC1: the ordering IS the mirror
// ---------------------------------------------------------------------------

describe("lifecycle-order", () => {
  test("full run emits lifecycle events in exact mint→deliver→capture→revoke→verify order", async () => {
    await runMemoryKeyLifecycle(deps(), lifecycleOpts());
    expect(memgateEvents()).toEqual([
      "memgate-mint",
      "memgate-deliver",
      "memgate-capture",
      "memgate-revoke",
      "memgate-verify-revoked",
    ]);
  });

  test("delivery target is asserted before mint — env-file-invalid refuses with no issuance row and zero client calls", async () => {
    let caught: unknown;
    try {
      await runMemoryKeyLifecycle(deps(), lifecycleOpts({ target: "../escaped.env" }));
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(MemgateError);
    expect((caught as MemgateError).code).toBe("env-file-invalid");
    expect(issuedRows().length).toBe(0);
    expect(clientCalls.length).toBe(0);
    expect(memgateEvents()).not.toContain("memgate-mint");
  });

  test("capture runs in the capture-before-revoke slot (D2 ordering preserved)", async () => {
    await runMemoryKeyLifecycle(deps(), lifecycleOpts());
    const events = memgateEvents();
    expect(events.indexOf("memgate-capture")).toBeGreaterThan(events.indexOf("memgate-deliver"));
    expect(events.indexOf("memgate-revoke")).toBeGreaterThan(events.indexOf("memgate-capture"));
  });

  test("deliver writes exactly the two registered entries and the issuance row carries the run", async () => {
    const opts = lifecycleOpts();
    await runMemoryKeyLifecycle(deps(), opts);
    const delivered = readFileSync(opts.target, "utf8");
    expect(delivered).toContain("QDS_KG_RECALL_KEY=mgrun-");
    expect(delivered).toContain(`QDS_KG_GATEWAY_URL=${GATEWAY_URL}`);
    expect(delivered.trim().split("\n").length).toBe(2);
    const row = onlyIssuance();
    expect(str(row.kind)).toBe("per-run");
    expect(str(row.run_id)).toBe(opts.runId);
    expect(num(row.expires_at_ms)).toBe(NOW_MS + opts.ttlMs);
  });

  test("F-025: the lifecycle target omitted at runtime resolves to the MEMGATE_ENV_FILE default — the HOME-relative app/.env", async () => {
    expect(MEMGATE_ENV_FILE).toBe("app/.env");
    const full = lifecycleOpts();
    // Omit `target` (type-required; the runtime consumer may omit it) — the
    // default resolves CWD-relative, so resolve it inside the tmpdir sandbox.
    const withoutTarget = {
      runId: full.runId,
      banks: full.banks,
      ttlMs: full.ttlMs,
      gatewayUrl: full.gatewayUrl,
      requestId: full.requestId,
    } as unknown as Parameters<typeof runMemoryKeyLifecycle>[1];
    const prevCwd = process.cwd();
    process.chdir(dir);
    try {
      await runMemoryKeyLifecycle(deps(), withoutTarget);
    } finally {
      process.chdir(prevCwd);
    }
    const delivered = readFileSync(join(dir, MEMGATE_ENV_FILE), "utf8");
    expect(delivered).toContain("QDS_KG_RECALL_KEY=mgrun-");
    expect(delivered).toContain(`QDS_KG_GATEWAY_URL=${GATEWAY_URL}`);
    const deliverLine = logs.find((l) => eventOf(l) === "memgate-deliver");
    expect(str((deliverLine as LogEntry).target)).toBe(MEMGATE_ENV_FILE);
    expect(memgateEvents()).toContain("memgate-verify-revoked"); // the full lifecycle still closed out
  });
});

// ---------------------------------------------------------------------------
// compensation — AC1: a minted key must never outlive a failed delivery
// ---------------------------------------------------------------------------

describe("compensation", () => {
  test("delivery failure compensates — compensate→revoke→verify precede the rethrown ORIGINAL error", async () => {
    const { wrapped, revokedTokenIds } = ledgerWithRecorder();
    let caught: unknown;
    try {
      await runMemoryKeyLifecycle(deps({ ledger: wrapped }), lifecycleOpts({ target: blockerTarget() }));
    } catch (e) {
      caught = e;
    }
    // The events are in the sink by the time the catch sees the error — they
    // were emitted BEFORE the rethrow.
    expect(memgateEvents()).toEqual([
      "memgate-mint",
      "memgate-compensate",
      "memgate-revoke",
      "memgate-verify-revoked",
    ]);
    const tokenId = str(onlyIssuance().token_id);
    expect(revokedTokenIds).toEqual([tokenId]);
    expect(await ledger.isRevoked(tokenId)).toBe(true);
    // Original-error fidelity: the delivery fault's own text, never a
    // compensation-generated message.
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toContain("blocker");
  });

  test("stranded-key negative control — compensation DID run: the minted key is verifiably dead after a failed delivery", async () => {
    const { wrapped, revokedTokenIds } = ledgerWithRecorder();
    try {
      await runMemoryKeyLifecycle(deps({ ledger: wrapped }), lifecycleOpts({ target: blockerTarget() }));
    } catch {
      // the rethrow is asserted in the sibling test; this control proves the
      // key did NOT stay stranded
    }
    const tokenId = str(onlyIssuance().token_id);
    expect(revokedTokenIds).toContain(tokenId);
    expect(await ledger.isRevoked(tokenId)).toBe(true);
    expect(memgateEvents()).toContain("memgate-revoke");
    expect(memgateEvents()).toContain("memgate-verify-revoked");
  });

  test("deliver-state-write-failed is the named discrimination case — delivery succeeded, NO compensation, original rethrown", async () => {
    const emitThrower = (entry: LogEntry): void => {
      logs.push(entry);
      if (eventOf(entry) === "memgate-deliver") throw new Error("state-emit-boom");
    };
    const opts = lifecycleOpts();
    let caught: unknown;
    try {
      await runMemoryKeyLifecycle(deps({ log: emitThrower }), opts);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(MemgateError);
    expect((caught as MemgateError).code).toBe("deliver-state-write-failed");
    // The delivery SUCCEEDED — both entries landed.
    expect(readFileSync(opts.target, "utf8")).toContain("QDS_KG_RECALL_KEY=mgrun-");
    // And the key was NOT compensated away.
    expect(memgateEvents()).not.toContain("memgate-compensate");
    expect(memgateEvents()).not.toContain("memgate-revoke");
    expect(await ledger.isRevoked(str(onlyIssuance().token_id))).toBe(false);
  });

  test("compensation faults never replace the original error — broken revocation still rethrows the delivery fault", async () => {
    const { wrapped } = ledgerWithRecorder({ faultOnRevoke: true });
    let caught: unknown;
    try {
      await runMemoryKeyLifecycle(deps({ ledger: wrapped }), lifecycleOpts({ target: blockerTarget() }));
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toContain("blocker");
    expect((caught as Error).message).not.toContain("sentinel-compensation-fault");
    // The compensation fault was LOGGED, not substituted (best-effort posture).
    expect(logs.some((l) => l.status === "error")).toBe(true);
  });

  test("F-001: a throwing sink on the memgate-compensate emit still runs revocation and rethrows the ORIGINAL delivery error", async () => {
    const { wrapped, revokedTokenIds } = ledgerWithRecorder();
    const sinkBoom = "sink-compensate-boom";
    const log: (entry: LogEntry) => void = (entry) => {
      logs.push(entry);
      if (eventOf(entry) === "memgate-compensate") throw new Error(sinkBoom);
    };
    let caught: unknown;
    try {
      await runMemoryKeyLifecycle(deps({ ledger: wrapped, log }), lifecycleOpts({ target: blockerTarget() }));
    } catch (e) {
      caught = e;
    }
    // Original-error identity: the delivery fault, never the sink's error.
    expect((caught as Error).message).toContain("blocker");
    expect((caught as Error).message).not.toContain(sinkBoom);
    // Revocation RAN despite the sink fault — the key is verifiably dead.
    const tokenId = str(onlyIssuance().token_id);
    expect(revokedTokenIds).toEqual([tokenId]);
    expect(await ledger.isRevoked(tokenId)).toBe(true);
    expect(memgateEvents()).toContain("memgate-revoke");
    expect(memgateEvents()).toContain("memgate-verify-revoked");
  });

  test("F-001: a throwing sink on the compensation-failed emit path cannot replace the original error either", async () => {
    const { wrapped } = ledgerWithRecorder({ faultOnRevoke: true });
    const sinkBoom = "sink-compfailed-boom";
    const log: (entry: LogEntry) => void = (entry) => {
      logs.push(entry);
      if (eventOf(entry) === "memgate-compensation-failed") throw new Error(sinkBoom);
    };
    let caught: unknown;
    try {
      await runMemoryKeyLifecycle(deps({ ledger: wrapped, log }), lifecycleOpts({ target: blockerTarget() }));
    } catch (e) {
      caught = e;
    }
    expect((caught as Error).message).toContain("blocker");
    expect((caught as Error).message).not.toContain(sinkBoom);
    expect((caught as Error).message).not.toContain("sentinel-compensation-fault");
  });

  test("F-002: a ledger fault in the post-delivery tail compensates best-effort and rethrows the ORIGINAL fault", async () => {
    const wrapped = Object.create(ledger) as MemgateLedger;
    wrapped.isRevoked = (() => {
      throw new MemgateError("ledger-unreadable", "sentinel-capture-fault", "injected fault");
    }) as MemgateLedger["isRevoked"];
    let caught: unknown;
    try {
      await runMemoryKeyLifecycle(deps({ ledger: wrapped }), lifecycleOpts());
    } catch (e) {
      caught = e;
    }
    // The ORIGINAL capture fault rethrows — not a compensation-generated one.
    expect(caught).toBeInstanceOf(MemgateError);
    expect((caught as MemgateError).code).toBe("ledger-unreadable");
    expect((caught as Error).message).toContain("sentinel-capture-fault");
    // The tail compensated best-effort: revoke ran, the verify read faulted (the
    // injected one), and the compensation-failed line was emitted — the key is
    // dead per the REAL ledger regardless.
    expect(memgateEvents()).toEqual([
      "memgate-mint",
      "memgate-deliver",
      "memgate-compensate",
      "memgate-revoke",
      "memgate-compensation-failed",
    ]);
    expect(await ledger.isRevoked(str(onlyIssuance().token_id))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// ttl-backstop — AC3: the ceiling is enforced at mint, PRE-issuance (INV-CAP-1)
// ---------------------------------------------------------------------------

describe("ttl-backstop", () => {
  test("ttlMs above DEFAULT_KEY_TTL_BACKSTOP_MS refuses PRE-issuance with mint-invalid-ttl", async () => {
    let caught: unknown;
    try {
      await mintRunMemoryKey(deps(), {
        runId: runId(2),
        banks: ["bank-a"],
        ttlMs: DEFAULT_KEY_TTL_BACKSTOP_MS + 1,
        requestId: "req-ttl",
      });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(MemgateError);
    expect((caught as MemgateError).code).toBe("mint-invalid-ttl");
    expect(issuedRows().length).toBe(0);
    expect(clientCalls.length).toBe(0);
    expect(memgateEvents()).not.toContain("memgate-mint");
    // The refusal is observable under the closed reason set; ttlRemainingMs is
    // absent (the TTL bound refused the mint — it is not a remaining-TTL fact).
    const refused = logs.find((l) => eventOf(l) === "memgate-refused");
    expect(refused).toBeDefined();
    expect(str((refused as LogEntry).reason)).toBe("mint-invalid-ttl");
    expect("ttlRemainingMs" in (refused as LogEntry)).toBe(false);
  });

  test("non-integer ttlMs is refused pre-issuance", async () => {
    let caught: unknown;
    try {
      await mintRunMemoryKey(deps(), {
        runId: runId(2),
        banks: ["bank-a"],
        ttlMs: 1500.5,
        requestId: "req-ttl-frac",
      });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(MemgateError);
    expect((caught as MemgateError).code).toBe("mint-invalid-ttl");
    expect(issuedRows().length).toBe(0);
  });

  test("zero and negative ttlMs are refused pre-issuance", async () => {
    for (const ttlMs of [0, -1000]) {
      let caught: unknown;
      try {
        await mintRunMemoryKey(deps(), {
          runId: runId(2),
          banks: ["bank-a"],
          ttlMs,
          requestId: "req-ttl-nonpos",
        });
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(MemgateError);
      expect((caught as MemgateError).code).toBe("mint-invalid-ttl");
    }
    expect(issuedRows().length).toBe(0);
  });

  test("ttlMs exactly at the backstop is accepted", async () => {
    const minted = await mintRunMemoryKey(deps(), {
      runId: runId(3),
      banks: ["bank-a"],
      ttlMs: DEFAULT_KEY_TTL_BACKSTOP_MS,
      requestId: "req-ttl-max",
    });
    expect(minted.keyMaterial.startsWith("mgrun-")).toBe(true);
    expect(minted.expiresAtMs).toBe(NOW_MS + DEFAULT_KEY_TTL_BACKSTOP_MS);
    expect(num(onlyIssuance().expires_at_ms)).toBe(NOW_MS + DEFAULT_KEY_TTL_BACKSTOP_MS);
  });

  test("F-018: a NaN clock refuses mint-invalid-ttl with zero state change — a NaN expiry must never bind as NULL", async () => {
    let caught: unknown;
    try {
      await mintRunMemoryKey(deps({ now: () => Number.NaN }), {
        runId: runId(10),
        banks: ["bank-a"],
        ttlMs: 60_000,
        requestId: "req-nan-clock",
      });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(MemgateError);
    expect((caught as MemgateError).code).toBe("mint-invalid-ttl");
    expect(issuedRows().length).toBe(0);
    expect(memgateEvents()).not.toContain("memgate-mint");
    const refused = logs.find((l) => eventOf(l) === "memgate-refused");
    expect(refused).toBeDefined();
    expect(str((refused as LogEntry).reason)).toBe("mint-invalid-ttl");
  });
});

// ---------------------------------------------------------------------------
// retry-posture — AC4 via D4: mint is gateway-local (zero network); the
// forward path issues each mapped POST exactly once; the route table is closed
// ---------------------------------------------------------------------------

describe("retry-posture", () => {
  test("mint performs ZERO network calls — gateway-local HMAC + ledger (D4)", async () => {
    let fetchCalls = 0;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      fetchCalls += 1;
      throw new Error("network is forbidden on the mint path");
    }) as unknown as typeof fetch;
    try {
      const minted = await mintRunMemoryKey(deps(), {
        runId: runId(4),
        banks: ["bank-a"],
        ttlMs: 60_000,
        requestId: "req-mint-net",
      });
      expect(minted.keyMaterial.startsWith("mgrun-")).toBe(true);
    } finally {
      globalThis.fetch = originalFetch;
    }
    expect(fetchCalls).toBe(0);
    expect(clientCalls.length).toBe(0);
  });

  test("forwardScoped issues exactly ONE client call for a mapped POST even when the client throws", async () => {
    const failing = makeClient({
      recall: async () => {
        throw new Error("sentinel-transport-boom");
      },
    });
    const d = deps({ client: failing.client });
    const minted = await mintRunMemoryKey(d, {
      runId: runId(5),
      banks: ["bank-a"],
      ttlMs: 60_000,
      requestId: "req-fwd",
    });
    const v = await verifyRequest(d, {
      authHeader: `Bearer ${minted.keyMaterial}`,
      method: "POST",
      path: "/v1/default/banks/bank-a/memories/recall",
      requestId: "req-fwd",
    });
    if (!v.ok) throw new Error(`fixture: verify should pass, refused with ${str(v.reason)}`);
    let forwardErr: unknown;
    try {
      await forwardScoped(
        d,
        v.principal,
        "POST",
        "/v1/default/banks/bank-a/memories/recall",
        { query: "probe", limit: 5 },
        "req-fwd",
      );
    } catch (e) {
      forwardErr = e;
    }
    // The transport error propagates — and exactly one attempt was made.
    expect((forwardErr as Error).message).toContain("sentinel-transport-boom");
    expect(failing.calls.length).toBe(1);
    expect(at(failing.calls, 0).verb).toBe("recall");
  });

  test("the closed route table maps POST only — no non-POST route exists (structural)", () => {
    expect(Object.keys(VERB_ROUTES).sort()).toEqual(["consolidate", "recall", "reflect", "retain"]);
    for (const routes of Object.values(VERB_ROUTES)) {
      for (const route of routes as readonly { method: string; path: string }[]) {
        expect(route.method).toBe("POST");
        expect(route.path).toContain("/v1/default/banks/{bankId}/");
      }
    }
  });
});

// ---------------------------------------------------------------------------
// log-shape — observability contract: identities, durations, absent-not-0,
// zero key material
// ---------------------------------------------------------------------------

describe("log-shape", () => {
  test("every lifecycle line carries requestId and runId", async () => {
    await runMemoryKeyLifecycle(deps(), lifecycleOpts({ requestId: "req-shape", runId: runId(7) }));
    const lines = memgateLines();
    expect(lines.length).toBeGreaterThanOrEqual(5);
    for (const line of lines) {
      expect(str(line.requestId)).toBe("req-shape");
      expect(str(line.runId)).toBe(runId(7));
    }
  });

  test("mint_ms rides memgate-mint and verify_ms rides memgate-verify-revoked — on no other event", async () => {
    await runMemoryKeyLifecycle(deps(), lifecycleOpts());
    for (const line of memgateLines()) {
      const event = eventOf(line) as string;
      if (event === "memgate-mint") expect(typeof line.mint_ms).toBe("number");
      else expect("mint_ms" in line).toBe(false);
      if (event === "memgate-verify-revoked") expect(typeof line.verify_ms).toBe("number");
      else expect("verify_ms" in line).toBe(false);
    }
  });

  test("ttlRemainingMs is ABSENT — not 0 — when TTL is not the refusing check", async () => {
    const d = deps();
    const minted = await mintRunMemoryKey(d, {
      runId: runId(8),
      banks: ["bank-a"],
      ttlMs: 60_000,
      requestId: "req-absent",
    });
    const v = await verifyRequest(d, {
      authHeader: `Bearer ${minted.keyMaterial}`,
      method: "POST",
      path: "/v1/default/banks/bank-b/memories/recall",
      requestId: "req-absent",
    });
    expect(v.ok).toBe(false);
    const refused = memgateLines().find((l) => eventOf(l) === "memgate-refused");
    expect(refused).toBeDefined();
    expect(str((refused as LogEntry).reason)).toBe("scope-bank");
    expect("ttlRemainingMs" in (refused as LogEntry)).toBe(false);
  });

  test("leakScan — zero key material in any captured line", async () => {
    const opts = lifecycleOpts({ requestId: "req-leak", runId: runId(9) });
    await runMemoryKeyLifecycle(deps(), opts);
    const keyMaterial =
      readFileSync(opts.target, "utf8")
        .split("\n")
        .find((line) => line.startsWith("QDS_KG_RECALL_KEY="))
        ?.slice("QDS_KG_RECALL_KEY=".length)
        .trim() ?? "";
    expect(keyMaterial.startsWith("mgrun-")).toBe(true);
    const corpora = logs.map((l) => JSON.stringify(l));
    const hits = [
      ...leakScan(keyMaterial, corpora),
      ...leakScan(ADMIN_KEY, corpora),
      ...leakScan(SIGNING_KEY, corpora),
    ];
    expect(hits).toEqual([]);
  });
});
