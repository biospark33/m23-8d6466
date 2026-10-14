/**
 * M3.1 nightly-consolidate integration suite (leaf 1.3.2) — the job module
 * (src/hindsight/nightly-consolidate.ts) driven through the REAL gateway
 * machinery (memgateDeps + grantAgentToken + verifyRequest + forwardScoped)
 * against a REAL HindsightClient whose fetch is stubbed at the wire boundary.
 *
 * Idioms mirror tests/memgate/gateway.test.ts (env table, tmpdir ledger,
 * tracked closes) and tests/hindsight/client.test.ts (global fetch stub that
 * records every call). No network anywhere; no mock library — plain-object
 * structural fakes (R2 §7).
 *
 * Mandated-case map (story Trigger Surface + AC2/AC3/AC4 + DoD + round-1 fix
 * pins):
 *   describe "both legs, one module"        → cases 1-3
 *   describe "coalescing (AC2)"             → case 4 + the stale-coalesce pin
 *   describe "token scoping (AC3)"          → cases 5-6
 *   describe "fail-loud refresh proof (AC2)"→ cases 7-11 + cancelled/pending/
 *                                             unparseable evidence pins
 *   describe "nightly robustness gates"     → terminal-status gate, dedupe,
 *                                             pagination, clock/poll-interval
 *                                             validation, wall-clock budget,
 *                                             multi-model evidence
 *   describe "in-box write-back fence"      → cases 12-14
 *   describe "AC4 module-graph fences"      → case 15
 *   describe "CLI driver (memory-nightly)"  → cases 16-21
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { runMemoryNightly } from "../../scripts/memory-nightly.ts";
import { HindsightClient } from "../../src/hindsight/client.ts";
import {
  NIGHTLY_WALL_CLOCK_BUDGET_MS,
  POLL_INTERVAL_FLOOR_MS,
  runNightlyConsolidate,
  type NightlyDeps,
  type NightlyReceipt,
} from "../../src/hindsight/nightly-consolidate.ts";
import {
  AGENT_GRANT_CLASSES,
  AGENT_TOKEN_VERBS,
  MEMGATE_ADMIN_KEY,
  QDS_MEMGATE_LEDGER,
  QDS_MEMGATE_SIGNING_KEY,
  MemgateError,
  grantAgentToken,
  memgateDeps,
  verifyRequest,
  type MemgateDeps,
  type MemgateLedger,
} from "../../src/memgate/index.ts";
import type { LogEntry } from "../../src/lib/log.ts";

// ---------------------------------------------------------------------------
// Fixtures — env discipline (C-5), tmpdir ledger, tracked closes (gateway
// test pattern) — plus the fetch-stub router and the injectable tick clock.
// ---------------------------------------------------------------------------

const NOW_MS = Date.parse("2026-10-07T10:00:00.000Z");
const ADMIN = "memgate-admin-test-key-0000000000000001";
const SIGNING = "memgate-signing-test-key-0000000000000001";
const BANK = "alpha";
const BASE_URL = "http://hindsight.test";
/** 1 ms per clock read — monotonic, deterministic evidence/deadline progress. */
const TICK_MS = 1;
/**
 * Per-job evidence budget in tick-ms. Sized so the clamped poll-interval
 * floor (POLL_INTERVAL_FLOOR_MS = 50, added in the deadline check as
 * nowMs + interval) leaves room for several polls before the budget trips:
 * the pre-consolidate reads burn ~6 ticks, so poll 1 checks ~7+50=57 < 60
 * and the poll loop gets a handful of iterations (~150ms of real sleeps).
 */
const EVIDENCE_BUDGET_MS = 60;

const ENV_KEYS = [
  MEMGATE_ADMIN_KEY,
  QDS_MEMGATE_SIGNING_KEY,
  QDS_MEMGATE_LEDGER,
  "HINDSIGHT_BASE_URL",
  "HINDSIGHT_BEARER_TOKEN",
  "HINDSIGHT_API_KEY",
  "QDS_MEMORY_AGENT_TOKEN",
  "QDS_MEMORY_REPO_SLUG",
] as const;

let savedEnv: Record<string, string | undefined> = {};
let dir = "";
let clockMs = NOW_MS;
let openLedgers: MemgateLedger[] = [];

beforeEach(() => {
  savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of ENV_KEYS) delete process.env[k];
  dir = mkdtempSync(join(tmpdir(), "qds-m31-nightly-"));
  // C-5: a stray default-path ledger open resolves into the fixture sandbox.
  process.env[QDS_MEMGATE_LEDGER] = join(dir, "default-placement-ledger.db");
  clockMs = NOW_MS;
  openLedgers = [];
});

afterEach(() => {
  for (const l of openLedgers) {
    try {
      l.close();
    } catch {
      // a faulting close must not mask the test's own failure
    }
  }
  openLedgers = [];
  globalThis.fetch = originalFetch; // never leak the stub into another suite
  rmSync(dir, { recursive: true, force: true });
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

const tickClock = (): number => {
  clockMs += TICK_MS;
  return clockMs;
};

const ledgerPath = () => join(dir, "memgate-ledger.db");

function at<T>(arr: T[], i: number): T {
  const v = arr[i];
  if (v === undefined) throw new Error(`fixture index ${i} out of range`);
  return v;
}

/** Code of a thrown MemgateError, or a loud failure when nothing is thrown. */
function codeOf(fn: () => unknown): string {
  try {
    fn();
  } catch (e) {
    if (e instanceof MemgateError) return e.code;
    throw e;
  }
  throw new Error("expected MemgateError, none thrown");
}

const evName = (e: LogEntry): string => (typeof e.event === "string" ? e.event : "");
const iso = (ms: number): string => new Date(ms).toISOString();

// --- fetch stub: routing router that records every call ----------------------

interface CallRecord {
  method: string;
  url: string;
}
interface RouteReply {
  status?: number;
  body: unknown;
}
type Router = (method: string, url: string) => RouteReply;

const originalFetch: typeof globalThis.fetch = globalThis.fetch.bind(globalThis);
let calls: CallRecord[] = [];
let router: Router | undefined;

function installRouter(r: Router): void {
  router = r;
  calls = [];
  globalThis.fetch = (async (input: Parameters<typeof globalThis.fetch>[0], init?: Parameters<typeof globalThis.fetch>[1]) => {
    const url = typeof input === "string" ? input : input instanceof Request ? input.url : String(input);
    const method = init?.method ?? "GET";
    calls.push({ method, url });
    const reply = router?.(method, url);
    if (reply === undefined) throw new Error(`nightly-consolidate.test: unrouted ${method} ${url}`);
    return new Response(JSON.stringify(reply.body ?? {}), {
      status: reply.status ?? 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof globalThis.fetch;
}

// --- wire-shape builders (the measured 0.10.0 bodies) ------------------------

const mmOf = (bank: string): string => `mm-${bank}`;
const triggeredMm = (bank: string, id?: string): Record<string, unknown> => ({
  id: id ?? mmOf(bank),
  name: `nightly model ${bank}`,
  bank_id: bank,
  trigger: { refresh_after_consolidation: true },
});
const mmListBody = (items: unknown[]): Record<string, unknown> => ({ items, total: items.length, limit: 100, offset: 0 });
const refreshOpRow = (
  bank: string,
  opts: { createdAt: string; opId?: string; status?: string; errorMessage?: string | null; mmId?: string },
): Record<string, unknown> => ({
  id: opts.opId ?? `op-refresh-${bank}`,
  task_type: "refresh_mental_model",
  operation_id: opts.opId ?? `op-refresh-${bank}`,
  operation_type: "refresh_mental_model",
  items_count: 0,
  mental_model_id: opts.mmId ?? mmOf(bank),
  created_at: opts.createdAt,
  updated_at: opts.createdAt,
  status: opts.status ?? "completed",
  error_message: opts.errorMessage ?? null,
});
const opsListBody = (bank: string, operations: unknown[]): Record<string, unknown> => ({
  bank_id: bank,
  total: operations.length,
  limit: 50,
  offset: 0,
  operations,
});
const emptyOps = (bank: string): Record<string, unknown> => opsListBody(bank, []);

// --- the nightly router: MM reads / consolidate POSTs / ops-poll sequences ----

interface RouterArgs {
  banks: string[];
  /** Per-bank override of the mental-model list items (default: one triggered model). */
  mmItems?: Record<string, unknown[]>;
  /** Per-bank consolidate response (default: real 0.10.0 non-dedup body). */
  consolidateBody?: (bank: string) => unknown;
  /** Per-bank SEQUENCE of OperationsList bodies — popped per poll, last one sticky. */
  opsQueues?: Record<string, unknown[]>;
  /** Body for the CLI's bank-resolution listBanks read (absent = unrouted). */
  listBanksBody?: unknown;
}

const BANK_PATH_RE = /\/v1\/default\/banks\/([^/]+)\/(mental-models|operations|consolidate)(\?.*)?$/;

function installNightlyRouter(args: RouterArgs): void {
  const queues = new Map<string, unknown[]>(Object.entries(args.opsQueues ?? {}));
  installRouter((method, url) => {
    if (url.includes("/v1/default/banks") && !url.includes("/v1/default/banks/")) {
      if (args.listBanksBody === undefined) throw new Error(`nightly-consolidate.test: unrouted ${method} ${url}`);
      return { body: args.listBanksBody };
    }
    const m = BANK_PATH_RE.exec(url);
    if (m === null) throw new Error(`nightly-consolidate.test: unrouted ${method} ${url}`);
    const bank = at(m, 1);
    const leaf = at(m, 2);
    if (leaf === "mental-models") {
      if (method !== "GET") throw new Error(`nightly-consolidate.test: unrouted ${method} ${url}`);
      return { body: mmListBody(args.mmItems?.[bank] ?? [triggeredMm(bank)]) };
    }
    if (leaf === "consolidate") {
      if (method !== "POST") throw new Error(`nightly-consolidate.test: unrouted ${method} ${url}`);
      return { body: args.consolidateBody ? args.consolidateBody(bank) : { operation_id: `op-c-${bank}`, deduplicated: false } };
    }
    // operations — the SEQUENCE-controllable evidence poll
    const q = queues.get(bank) ?? [];
    const body = q.length > 1 ? q.shift() : q[0];
    return { body: body ?? emptyOps(bank) };
  });
}

// --- the rig: real gateway + real-minted token + injected clock + event sink --

interface Rig {
  gateway: MemgateDeps;
  token: string;
  events: LogEntry[];
  deps: NightlyDeps;
}

function rig(args: { banks: string[]; leg?: "crontab" | "schedule"; tokenOverride?: string; overrides?: Partial<NightlyDeps> }): Rig {
  const gateway = memgateDeps({
    env: { [MEMGATE_ADMIN_KEY]: ADMIN, [QDS_MEMGATE_SIGNING_KEY]: SIGNING },
    ledgerPath: ledgerPath(),
    now: tickClock,
    client: new HindsightClient({ baseUrl: BASE_URL }),
  });
  openLedgers.push(gateway.ledger);
  const token =
    args.tokenOverride ??
    grantAgentToken(gateway, { consumerClass: "bot", banks: args.banks, verbs: ["consolidate"], requestId: "req-grant" }).token;
  const events: LogEntry[] = [];
  const deps: NightlyDeps = {
    gateway,
    token,
    banks: args.banks,
    leg: args.leg ?? "crontab",
    now: tickClock,
    pollIntervalMs: 1,
    refreshEvidenceTimeoutMs: EVIDENCE_BUDGET_MS,
    log: (entry) => events.push(entry),
    ...args.overrides,
  };
  return { gateway, token, events, deps };
}

/** The exact success receipt shape, shared by cases 1 and 2 (no fork). */
function expectStandardReceipt(r: NightlyReceipt, bank: string, refreshOpId: string): void {
  expect(r.bankId).toBe(bank);
  expect(r.mentalModelId).toBe(mmOf(bank));
  expect(Object.keys(r.consolidate).sort()).toEqual(["consolidateMs", "operationId"]);
  expect(r.consolidate.operationId).toBe(`op-c-${bank}`);
  expect(typeof r.consolidate.consolidateMs).toBe("number");
  expect(r.refresh).toEqual({
    mechanism: "consolidation-trigger",
    operationId: refreshOpId,
    status: "completed",
    observedVia: "operations-list",
  });
}

/** Every nightly event line carries the leg it fired under. */
function expectLegEverywhere(events: LogEntry[], leg: "crontab" | "schedule"): void {
  for (const e of events) {
    if (["nightly-fire", "consolidate-op", "coalesced", "refresh-op", "nightly-complete", "nightly-bank-failed"].includes(evName(e))) {
      expect(e.leg).toBe(leg);
    }
  }
}

// ---------------------------------------------------------------------------
// both legs, one module (cases 1-3)
// ---------------------------------------------------------------------------

describe("both legs, one module", () => {
  test("case 1 — crontab leg happy path: one bank, refresh op appears on the 2nd ops poll, exact receipt + event sequence", async () => {
    installNightlyRouter({
      banks: [BANK],
      opsQueues: {
        [BANK]: [emptyOps(BANK), opsListBody(BANK, [refreshOpRow(BANK, { createdAt: iso(NOW_MS), opId: "op-refresh-1" })])],
      },
    });
    const { events, deps } = rig({ banks: [BANK], leg: "crontab" });

    const result = await runNightlyConsolidate(deps);

    expect(result.ok).toBe(true);
    expect(result.failures).toEqual([]);
    expect(result.banksOk).toBe(1);
    expect(result.banksFailed).toBe(0);
    expectStandardReceipt(at(result.receipts, 0), BANK, "op-refresh-1");

    // the evidence read is the typed ops poll, not some ad-hoc read
    expect(calls.some((c) => c.url.includes("/operations?type=refresh_mental_model"))).toBe(true);
    expect(calls.some((c) => c.method === "POST" && c.url.endsWith(`/v1/default/banks/${BANK}/consolidate`))).toBe(true);

    const names = events.map(evName);
    for (const expected of ["nightly-fire", "consolidate-op", "refresh-op", "nightly-complete"]) {
      expect(names).toContain(expected);
    }
    expect(names.indexOf("nightly-fire")).toBeLessThan(names.indexOf("consolidate-op"));
    expect(names.indexOf("consolidate-op")).toBeLessThan(names.indexOf("refresh-op"));
    expect(names.indexOf("refresh-op")).toBeLessThan(names.indexOf("nightly-complete"));
    expect(names).not.toContain("coalesced");
    expect(names).not.toContain("nightly-bank-failed");
    const fire = at(events.filter((e) => evName(e) === "nightly-fire"), 0);
    expect(fire.leg).toBe("crontab");
    const complete = at(events.filter((e) => evName(e) === "nightly-complete"), 0);
    expect(complete.banks_ok).toBe(1);
    expect(complete.status).toBe("ok"); // a green run never logs as an error
  });

  test("case 2 — schedule leg consumes the SAME module: identical receipt shape, leg carried on every nightly event, no behavioral fork", async () => {
    installNightlyRouter({
      banks: [BANK],
      opsQueues: {
        [BANK]: [emptyOps(BANK), opsListBody(BANK, [refreshOpRow(BANK, { createdAt: iso(NOW_MS), opId: "op-refresh-1" })])],
      },
    });
    const { events, deps } = rig({ banks: [BANK], leg: "schedule" });

    const result = await runNightlyConsolidate(deps);

    expect(result.ok).toBe(true);
    expect(result.leg).toBe("schedule");
    expect(result.banksOk).toBe(1);
    // the identical receipt shape — same keys, same values, same mechanism
    expectStandardReceipt(at(result.receipts, 0), BANK, "op-refresh-1");
    expectLegEverywhere(events, "schedule");
    const names = events.map(evName);
    expect(names).toContain("consolidate-op");
    expect(names).toContain("refresh-op");
    const complete = at(events.filter((e) => evName(e) === "nightly-complete"), 0);
    expect(complete.banks_ok).toBe(1);
    expect(complete.status).toBe("ok");
    expect(names).not.toContain("nightly-bank-failed");
  });

  test("case 3 — three banks → three SEPARATE consolidate POSTs (never one fan-out verb), per-bank receipts", async () => {
    const banks = ["alpha", "beta", "gamma"];
    installNightlyRouter({
      banks,
      opsQueues: Object.fromEntries(
        banks.map((b) => [b, [opsListBody(b, [refreshOpRow(b, { createdAt: iso(NOW_MS) })])]]),
      ),
    });
    const { deps } = rig({ banks, leg: "crontab" });

    const result = await runNightlyConsolidate(deps);

    expect(result.ok).toBe(true);
    expect(result.banksOk).toBe(3);
    const consolidates = calls.filter((c) => c.method === "POST" && c.url.includes("/consolidate"));
    expect(consolidates.length).toBe(3);
    expect(new Set(consolidates.map((c) => c.url)).size).toBe(3);
    expect(result.receipts.map((r) => r.bankId)).toEqual(banks);
    for (const r of result.receipts) {
      expect(r.consolidate.operationId).toBe(`op-c-${r.bankId}`);
      expect(r.refresh.mechanism).toBe("consolidation-trigger");
    }
  });
});

// ---------------------------------------------------------------------------
// coalescing (AC2) — case 4 + the honest-failure pin
// ---------------------------------------------------------------------------

describe("coalescing (AC2)", () => {
  test("case 4 — deduplicated consolidate → coalesced event, receipt.consolidate === {deduplicated:true} (no operationId, no consolidateMs), counted success", async () => {
    installNightlyRouter({
      banks: [BANK],
      consolidateBody: () => ({ operation_id: "op-x", deduplicated: true }),
      // evidence is still required after a coalesced re-fire
      opsQueues: { [BANK]: [opsListBody(BANK, [refreshOpRow(BANK, { createdAt: iso(NOW_MS), opId: "op-refresh-1" })])] },
    });
    const { events, deps } = rig({ banks: [BANK] });

    const result = await runNightlyConsolidate(deps);

    expect(result.ok).toBe(true);
    expect(result.banksOk).toBe(1); // counted success, never an error
    expect(result.failures).toEqual([]);
    const r = at(result.receipts, 0);
    expect(r.consolidate).toEqual({ deduplicated: true });
    expect("operationId" in r.consolidate).toBe(false);
    expect("consolidateMs" in r.consolidate).toBe(false);
    const names = events.map(evName);
    expect(names).toContain("coalesced");
    expect(names).not.toContain("consolidate-op");
    expect(names).toContain("refresh-op");
    expect(names).toContain("nightly-complete");
  });

  test("deduplicated:true whose only refresh op is STALE (created well before the re-fire) → REFRESH_EVIDENCE_MISSING, ok:false — success is never fabricated from a stale op", async () => {
    installNightlyRouter({
      banks: [BANK],
      consolidateBody: () => ({ operation_id: "op-x", deduplicated: true }),
      opsQueues: { [BANK]: [opsListBody(BANK, [refreshOpRow(BANK, { createdAt: iso(NOW_MS - 3_600_000), opId: "op-stale" })])] },
    });
    const { deps } = rig({ banks: [BANK] });

    const result = await runNightlyConsolidate(deps);

    expect(result.ok).toBe(false);
    expect(result.receipts).toEqual([]);
    const f = at(result.failures, 0);
    expect(f.code).toBe("REFRESH_EVIDENCE_MISSING");
  });
});

// ---------------------------------------------------------------------------
// token scoping (AC3) — cases 5-6
// ---------------------------------------------------------------------------

describe("token scoping (AC3)", () => {
  test("case 5 — token granted for another bank → GATEWAY_SCOPE_BANK, no consolidate fetch call", async () => {
    installNightlyRouter({ banks: [BANK] });
    const { gateway, deps } = rig({ banks: [BANK] });
    const foreign = grantAgentToken(gateway, {
      consumerClass: "bot",
      banks: ["other-bank"],
      verbs: ["consolidate"],
      requestId: "req-t5",
    }).token;

    const result = await runNightlyConsolidate({ ...deps, token: foreign });

    expect(result.ok).toBe(false);
    expect(result.receipts).toEqual([]);
    const f = at(result.failures, 0);
    expect(f.bankId).toBe(BANK);
    expect(f.code).toBe("GATEWAY_SCOPE_BANK");
    // the preflight read happened; the WRITE never did
    expect(calls.some((c) => c.url.includes("/mental-models"))).toBe(true);
    expect(calls.some((c) => c.url.includes("/consolidate"))).toBe(false);
  });

  test("case 6 — host-class token (reflect/retain) on the right bank → GATEWAY_SCOPE_VERB (consolidate ∉ host class), no consolidate fetch", async () => {
    installNightlyRouter({ banks: [BANK] });
    const { gateway, deps } = rig({ banks: [BANK] });
    const host = grantAgentToken(gateway, {
      consumerClass: "host",
      banks: [BANK],
      verbs: ["reflect", "retain"],
      requestId: "req-t6",
    }).token;

    const result = await runNightlyConsolidate({ ...deps, token: host });

    expect(result.ok).toBe(false);
    const f = at(result.failures, 0);
    expect(f.code).toBe("GATEWAY_SCOPE_VERB");
    expect(calls.some((c) => c.url.includes("/consolidate"))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// fail-loud refresh proof (AC2) — cases 7-11 + terminal-status/evidence pins
// ---------------------------------------------------------------------------

describe("fail-loud refresh proof (AC2)", () => {
  test("case 7 — MM present but trigger.refresh_after_consolidation=false → MM_TRIGGER_ABSENT naming the models seen, NO consolidate call (preflight gates the write)", async () => {
    installNightlyRouter({
      banks: [BANK],
      mmItems: {
        [BANK]: [{ id: mmOf(BANK), name: "untriggered", bank_id: BANK, trigger: { refresh_after_consolidation: false } }],
      },
    });
    const { deps } = rig({ banks: [BANK] });

    const result = await runNightlyConsolidate(deps);

    expect(result.ok).toBe(false);
    const f = at(result.failures, 0);
    expect(f.code).toBe("MM_TRIGGER_ABSENT");
    expect(f.message).toContain(mmOf(BANK)); // the message lists the models seen
    expect(calls.some((c) => c.url.includes("/consolidate"))).toBe(false);
    expect(calls.some((c) => c.url.includes("/operations"))).toBe(false);
  });

  test("case 8 — no mental model at all → MM_TRIGGER_ABSENT", async () => {
    installNightlyRouter({ banks: [BANK], mmItems: { [BANK]: [] } });
    const { deps } = rig({ banks: [BANK] });

    const result = await runNightlyConsolidate(deps);

    expect(result.ok).toBe(false);
    expect(at(result.failures, 0).code).toBe("MM_TRIGGER_ABSENT");
    expect(calls.some((c) => c.url.includes("/consolidate"))).toBe(false);
  });

  test("case 9 — ops poll never yields a refresh op within budget → REFRESH_EVIDENCE_MISSING, ok=false (trigger presence alone NEVER passes); failure events carry status:error", async () => {
    installNightlyRouter({ banks: [BANK], opsQueues: { [BANK]: [emptyOps(BANK)] } }); // sticky-empty
    const { events, deps } = rig({ banks: [BANK] });

    const result = await runNightlyConsolidate(deps);

    expect(result.ok).toBe(false);
    const f = at(result.failures, 0);
    expect(f.code).toBe("REFRESH_EVIDENCE_MISSING");
    // the consolidate DID happen — the failure is evidence-side, not preflight
    expect(calls.some((c) => c.url.includes("/consolidate"))).toBe(true);
    expect(calls.some((c) => c.url.includes("/operations?type=refresh_mental_model"))).toBe(true);
    const failed = at(events.filter((e) => evName(e) === "nightly-bank-failed"), 0);
    expect(failed.code).toBe("REFRESH_EVIDENCE_MISSING");
    expect(failed.status).toBe("error"); // a log consumer keying on status sees the failure
    const complete = at(events.filter((e) => evName(e) === "nightly-complete"), 0);
    expect(complete.status).toBe("error");
    expect(result.banksOk).toBe(0);
  });

  test("case 10 — observed refresh with status=failed + error_message → REFRESH_FAILED with the error_message quoted", async () => {
    installNightlyRouter({
      banks: [BANK],
      opsQueues: {
        [BANK]: [opsListBody(BANK, [refreshOpRow(BANK, { createdAt: iso(NOW_MS), status: "failed", errorMessage: "refresh detonated" })])],
      },
    });
    const { deps } = rig({ banks: [BANK] });

    const result = await runNightlyConsolidate(deps);

    expect(result.ok).toBe(false);
    const f = at(result.failures, 0);
    expect(f.code).toBe("REFRESH_FAILED");
    expect(f.message).toContain("refresh detonated");
    expect(result.receipts).toEqual([]);
  });

  test("case 11 — refresh op created BEFORE the consolidate completed (1h stale) is NOT evidence → REFRESH_EVIDENCE_MISSING", async () => {
    installNightlyRouter({
      banks: [BANK],
      opsQueues: { [BANK]: [opsListBody(BANK, [refreshOpRow(BANK, { createdAt: iso(NOW_MS - 3_600_000), opId: "op-stale" })])] },
    });
    const { deps } = rig({ banks: [BANK] });

    const result = await runNightlyConsolidate(deps);

    expect(result.ok).toBe(false);
    const f = at(result.failures, 0);
    expect(f.code).toBe("REFRESH_EVIDENCE_MISSING");
    expect(result.receipts).toEqual([]);
  });

  test("terminal status cancelled is NOT success evidence → REFRESH_FAILED naming the status (consistent with the provisioner's poll)", async () => {
    installNightlyRouter({
      banks: [BANK],
      opsQueues: {
        [BANK]: [opsListBody(BANK, [refreshOpRow(BANK, { createdAt: iso(NOW_MS), status: "cancelled", errorMessage: "cancelled upstream" })])],
      },
    });
    const { deps } = rig({ banks: [BANK] });

    const result = await runNightlyConsolidate(deps);

    expect(result.ok).toBe(false);
    expect(result.receipts).toEqual([]);
    const f = at(result.failures, 0);
    expect(f.code).toBe("REFRESH_FAILED");
    expect(f.message).toContain("cancelled");
    expect(f.message).toContain("cancelled upstream");
  });

  test("pending refresh keeps polling — a later poll sees it completed → observed (the poll loops through non-terminal statuses)", async () => {
    installNightlyRouter({
      banks: [BANK],
      opsQueues: {
        [BANK]: [
          opsListBody(BANK, [refreshOpRow(BANK, { createdAt: iso(NOW_MS), status: "pending", opId: "op-inflight" })]),
          opsListBody(BANK, [refreshOpRow(BANK, { createdAt: iso(NOW_MS), status: "completed", opId: "op-done" })]),
        ],
      },
    });
    const { deps } = rig({ banks: [BANK] });

    const result = await runNightlyConsolidate(deps);

    expect(result.ok).toBe(true);
    const r = at(result.receipts, 0);
    expect(r.refresh.operationId).toBe("op-done");
    expect(r.refresh.status).toBe("completed");
    // at least two ops polls happened (the pending one did not pass as evidence)
    expect(calls.filter((c) => c.url.includes("/operations")).length).toBeGreaterThanOrEqual(2);
  });

  test("a matching row with an UNPARSEABLE created_at → REFRESH_EVIDENCE_MISSING whose message names the N-row diagnostic (the failure is honest about what was seen)", async () => {
    installNightlyRouter({
      banks: [BANK],
      opsQueues: { [BANK]: [opsListBody(BANK, [refreshOpRow(BANK, { createdAt: "not-a-timestamp", opId: "op-badts" })])] },
    });
    const { deps } = rig({ banks: [BANK] });

    const result = await runNightlyConsolidate(deps);

    expect(result.ok).toBe(false);
    const f = at(result.failures, 0);
    expect(f.code).toBe("REFRESH_EVIDENCE_MISSING");
    expect(f.message).toContain("1 matching refresh row(s) seen with unparseable created_at");
  });

  test("multiple triggered models: the refresh fired for the SECOND model is matched; the receipt names it", async () => {
    installNightlyRouter({
      banks: [BANK],
      mmItems: {
        [BANK]: [
          triggeredMm(BANK, "mm-alpha-one"),
          triggeredMm(BANK, "mm-alpha-two"),
        ],
      },
      opsQueues: {
        [BANK]: [opsListBody(BANK, [refreshOpRow(BANK, { createdAt: iso(NOW_MS), opId: "op-second", mmId: "mm-alpha-two" })])],
      },
    });
    const { deps } = rig({ banks: [BANK] });

    const result = await runNightlyConsolidate(deps);

    expect(result.ok).toBe(true);
    const r = at(result.receipts, 0);
    expect(r.mentalModelId).toBe("mm-alpha-two");
    expect(r.refresh.operationId).toBe("op-second");
  });
});

// ---------------------------------------------------------------------------
// nightly robustness gates (round-1 fixes) — dedupe, pagination, clock,
// poll-interval floor, wall-clock budget
// ---------------------------------------------------------------------------

describe("nightly robustness gates", () => {
  test("duplicate bank ids are deduped at entry — one consolidate per unique bank, a nightly-banks-deduped event, nightly-fire carries the deduped list", async () => {
    const banks = ["alpha", "alpha", "beta"];
    installNightlyRouter({
      banks: ["alpha", "beta"],
      opsQueues: Object.fromEntries(
        ["alpha", "beta"].map((b) => [b, [opsListBody(b, [refreshOpRow(b, { createdAt: iso(NOW_MS) })])]]),
      ),
    });
    const { events, deps } = rig({ banks });

    const result = await runNightlyConsolidate(deps);

    // the duplicate did NOT produce a second (coalescing, then failing) pass
    expect(result.ok).toBe(true);
    expect(result.receipts.map((r) => r.bankId)).toEqual(["alpha", "beta"]);
    const consolidates = calls.filter((c) => c.method === "POST" && c.url.includes("/consolidate"));
    expect(consolidates.length).toBe(2);
    expect(new Set(consolidates.map((c) => c.url)).size).toBe(2);
    const deduped = at(events.filter((e) => evName(e) === "nightly-banks-deduped"), 0);
    expect(deduped.dropped).toBe(1);
    const fire = at(events.filter((e) => evName(e) === "nightly-fire"), 0);
    expect(fire.banks).toEqual(["alpha", "beta"]);
  });

  test("the evidence poll PAGINATES: a matching refresh op on page 2 (offset=50) is still observed — no silent 50-row cap", async () => {
    // page 1: a FULL page of rows for a different model; page 2 (offset=50): the match
    const chaff = Array.from({ length: 50 }, (_, i) =>
      refreshOpRow(BANK, { createdAt: iso(NOW_MS), opId: `op-chaff-${i}`, mmId: "mm-some-other-model" }),
    );
    installRouter((method, url) => {
      const m = BANK_PATH_RE.exec(url);
      if (m === null) throw new Error(`nightly-consolidate.test: unrouted ${method} ${url}`);
      const bank = at(m, 1);
      const leaf = at(m, 2);
      if (leaf === "mental-models") return { body: mmListBody([triggeredMm(bank)]) };
      if (leaf === "consolidate") return { body: { operation_id: `op-c-${bank}`, deduplicated: false } };
      if (url.includes("offset=50")) return { body: opsListBody(bank, [refreshOpRow(BANK, { createdAt: iso(NOW_MS), opId: "op-page2" })]) };
      return { body: opsListBody(bank, chaff) };
    });
    const { deps } = rig({ banks: [BANK] });

    const result = await runNightlyConsolidate(deps);

    expect(result.ok).toBe(true);
    expect(at(result.receipts, 0).refresh.operationId).toBe("op-page2");
    expect(calls.some((c) => c.url.includes("/operations") && c.url.includes("offset=50"))).toBe(true);
  });

  test("a non-finite injected clock → typed nightly-clock-invalid naming the deps.now seam, NO network", async () => {
    installRouter(() => {
      throw new Error("nightly-consolidate.test: clock-invalid must not touch the network");
    });
    const { deps } = rig({ banks: [BANK], overrides: { now: () => Number.NaN } });

    try {
      await runNightlyConsolidate(deps);
      throw new Error("expected MemgateError, none thrown");
    } catch (e) {
      if (!(e instanceof MemgateError)) throw e;
      expect(e.code).toBe("nightly-clock-invalid");
      expect(e.remediation).toContain("deps.now");
    }
    expect(calls.length).toBe(0);
  });

  test("pollIntervalMs below the floor is clamped — the poll loop never issues a sleep below POLL_INTERVAL_FLOOR_MS", async () => {
    installNightlyRouter({ banks: [BANK], opsQueues: { [BANK]: [emptyOps(BANK)] } }); // sticky-empty → several polls
    const { deps } = rig({ banks: [BANK], overrides: { pollIntervalMs: 0 } });

    const sleeps: number[] = [];
    const realSetTimeout = globalThis.setTimeout;
    const recorder = ((fn: () => void, ms?: number) => {
      sleeps.push(ms ?? 0);
      return realSetTimeout(fn, 0); // resolve fast — only the ISSUED interval is under test
    }) as unknown as typeof globalThis.setTimeout;
    globalThis.setTimeout = recorder;
    try {
      await runNightlyConsolidate(deps);
    } finally {
      globalThis.setTimeout = realSetTimeout;
    }

    // The recorder sees OTHER timers too (the client's own request-timeout
    // guards, ~10s each) — the pin is that NOTHING was issued below the floor
    // and the loop's clamped interval is visibly present.
    expect(sleeps.some((ms) => ms === POLL_INTERVAL_FLOOR_MS)).toBe(true);
    expect(sleeps.filter((ms) => ms < POLL_INTERVAL_FLOOR_MS)).toEqual([]);
  });

  test("wall-clock budget exhausted before ANY bank starts → every remaining bank NIGHTLY_BUDGET_EXHAUSTED, zero fetches", async () => {
    installRouter(() => {
      throw new Error("nightly-consolidate.test: a bank after budget exhaustion must not touch the network");
    });
    const { events, deps } = rig({ banks: [BANK, "beta"], overrides: { wallClockBudgetMs: 0 } });

    const result = await runNightlyConsolidate(deps);

    expect(result.ok).toBe(false);
    expect(result.receipts).toEqual([]);
    expect(result.failures.map((f) => f.code)).toEqual(["NIGHTLY_BUDGET_EXHAUSTED", "NIGHTLY_BUDGET_EXHAUSTED"]);
    for (const f of result.failures) expect(f.message).toContain("NIGHTLY_WALL_CLOCK_BUDGET_MS");
    expect(calls.length).toBe(0);
    const failed = events.filter((e) => evName(e) === "nightly-bank-failed");
    expect(failed.length).toBe(2);
    for (const e of failed) expect(e.status).toBe("error");
  });

  test("wall-clock budget: the first bank still receipts inside the budget; a bank whose turn starts AFTER the deadline → NIGHTLY_BUDGET_EXHAUSTED", async () => {
    // Deterministic stepped clock: each fetch call advances the injected clock
    // one 60s step — the trace is call-count arithmetic, not wall time.
    const stepClock = (): number => NOW_MS + 60_000 * calls.length;
    installNightlyRouter({
      banks: [BANK, "beta"],
      opsQueues: {
        [BANK]: [opsListBody(BANK, [refreshOpRow(BANK, { createdAt: iso(NOW_MS + 130_000) })])], // after the stepped completion
        beta: [opsListBody("beta", [refreshOpRow("beta", { createdAt: iso(NOW_MS + 130_000) })])],
      },
    });
    const { events, deps } = rig({
      banks: [BANK, "beta"],
      overrides: { now: stepClock, wallClockBudgetMs: 150_000, refreshEvidenceTimeoutMs: 10_000_000 },
    });

    const result = await runNightlyConsolidate(deps);

    // bank 1: clock reads at calls=0/1/2 (start, consolidate timestamps) all < 150s → receipts
    expect(result.receipts.map((r) => r.bankId)).toEqual([BANK]);
    // bank 2's turn begins after a fetch that pushed the stepped clock past
    // the 150s wall budget → skipped loud, not consolidated
    const f = at(result.failures, 0);
    expect(f.bankId).toBe("beta");
    expect(f.code).toBe("NIGHTLY_BUDGET_EXHAUSTED");
    expect(f.message).toContain("NIGHTLY_WALL_CLOCK_BUDGET_MS");
    expect(result.banksFailed).toBe(1);
    const complete = at(events.filter((e) => evName(e) === "nightly-complete"), 0);
    expect(complete.status).toBe("error");
  });

  test("the exported wall-clock budget default is 15 minutes (the named guard the story's guards list pins)", () => {
    expect(NIGHTLY_WALL_CLOCK_BUDGET_MS).toBe(900_000);
  });
});

// ---------------------------------------------------------------------------
// in-box write-back + vocabulary negative controls (AC2 fence, INV-MEM-1) —
// cases 12-14
// ---------------------------------------------------------------------------

describe("in-box write-back + vocabulary negative controls (AC2 fence, INV-MEM-1)", () => {
  test("case 12 — AGENT_GRANT_CLASSES.bot deep-equals [consolidate]; AGENT_TOKEN_VERBS never gains refresh", () => {
    expect([...AGENT_GRANT_CLASSES.bot]).toEqual(["consolidate"]);
    expect([...AGENT_GRANT_CLASSES.host]).toEqual(["reflect", "retain"]);
    expect((AGENT_TOKEN_VERBS as readonly string[]).includes("refresh")).toBe(false);
  });

  test("case 13 — bot grant asking for retain is refused (grant-verb-outside-class) — no in-box write-back credential shape for a bot", () => {
    const { gateway } = rig({ banks: [BANK] });
    expect(
      codeOf(() =>
        grantAgentToken(gateway, { consumerClass: "bot", banks: [BANK], verbs: ["retain"], requestId: "req-t13" }),
      ),
    ).toBe("grant-verb-outside-class");
  });

  test("case 14 — the nightly bot token on a RETAIN path (/memories POST) → refused scope-verb: no content-write verb on the job token", () => {
    installNightlyRouter({ banks: [BANK] });
    const { gateway, token } = rig({ banks: [BANK] }); // minted as the job does: bot + [consolidate]
    const v = verifyRequest(gateway, {
      authHeader: `Bearer ${token}`,
      method: "POST",
      path: `/v1/default/banks/${BANK}/memories`,
      requestId: "req-t14",
    });
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.reason).toBe("scope-verb");
  });
});

// ---------------------------------------------------------------------------
// AC4 module-graph fences — case 15
// ---------------------------------------------------------------------------

describe("AC4 module-graph fences", () => {
  /** The E21 seam fakes, by symbol. The in-source scan is restricted to files
   * THIS story owns: a whole-file token grep matches comments and prose, so
   * scanning files the branch does not own would let any future ADR-style
   * mention of "E21" in an unrelated module flip this fence red while naming
   * a file with no forbidden import. The import-SPECIFIER scan below still
   * covers the full transitive closure — that half is the meaningful one: an
   * actual seam import fails no matter which file it lives in. */
  const FORBIDDEN_IN_SOURCE = /home-bot|home_bot|\bE21\b|from "[^"]*fleet|pi-vs-claude-code-vendor|scripts\/lib\/run-lock/;
  const FORBIDDEN_SPECIFIER = /home-bot|home_bot|\bE21\b|fleet|pi-vs-claude-code-vendor|scripts\/lib\/run-lock/;
  const SPEC_PATTERNS = [
    /from\s*["']([^"']+)["']/g,
    /import\s*["']([^"']+)["']/g,
    /import\(\s*["']([^"']+)["']\s*\)/g,
    /require\(\s*["']([^"']+)["']\s*\)/g,
  ];

  const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));
  const ENTRIES = [join(REPO_ROOT, "scripts/memory-nightly.ts"), join(REPO_ROOT, "src/hindsight/nightly-consolidate.ts")];
  const OWNED_FILES = new Set([
    join(REPO_ROOT, "src/hindsight/nightly-consolidate.ts"),
    join(REPO_ROOT, "scripts/memory-nightly.ts"),
  ]);

  /** Resolve a RELATIVE specifier to a repo file (append .tsx/.js/index.ts as
   * needed); bare/node/bun specifiers are outside the walk. */
  function resolveSpecifier(spec: string, fromFile: string): string | null {
    if (!spec.startsWith(".")) return null;
    const base = resolve(dirname(fromFile), spec);
    for (const cand of [base, `${base}.ts`, `${base}.tsx`, `${base}.js`, join(base, "index.ts")]) {
      if (existsSync(cand) && statSync(cand).isFile()) return cand;
    }
    return null;
  }

  function collectViolations(entry: string, seen: Set<string>, violations: string[], depth = 0): void {
    if (depth > 24 || seen.has(entry) || !existsSync(entry)) return; // cycle + depth guards
    seen.add(entry);
    const src = readFileSync(entry, "utf8");
    if (OWNED_FILES.has(entry) && FORBIDDEN_IN_SOURCE.test(src)) violations.push(`${entry}: forbidden E21-seam symbol in source`);
    for (const pattern of SPEC_PATTERNS) {
      pattern.lastIndex = 0;
      for (const m of src.matchAll(pattern)) {
        const spec = m[1];
        if (spec === undefined) continue;
        if (FORBIDDEN_SPECIFIER.test(spec)) violations.push(`${entry}: forbidden specifier "${spec}"`);
        const target = resolveSpecifier(spec, entry);
        if (target !== null) collectViolations(target, seen, violations, depth + 1);
      }
    }
  }

  test("case 15 — the transitive import graph of the nightly entrypoints carries NO E21-seam symbol (runs green with the fakes deleted)", () => {
    const seen = new Set<string>();
    const violations: string[] = [];
    for (const entry of ENTRIES) {
      expect(existsSync(entry)).toBe(true); // both real entrypoints must exist in the graph
      collectViolations(entry, seen, violations);
    }
    expect(seen.size).toBeGreaterThan(2); // the walk actually traversed the closure
    expect(violations).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// CLI driver (scripts/memory-nightly.ts) — cases 16-21
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// round-2 hardening (review round 2): budget guards, evidence ordering, CLI
// refusals found by the second adversarial pass over the fix wave
// ---------------------------------------------------------------------------

describe("round-2 hardening", () => {
  test("unknown op status (queued) is NEVER success evidence — whitelist: poll to budget, then REFRESH_EVIDENCE_MISSING (blind-R2 HIGH)", async () => {
    installNightlyRouter({
      banks: [BANK],
      opsQueues: { [BANK]: [opsListBody(BANK, [refreshOpRow(BANK, { createdAt: iso(NOW_MS), status: "queued", opId: "op-queued" })])] },
    });
    const { events, deps } = rig({ banks: [BANK], overrides: { pollIntervalMs: 1, refreshEvidenceTimeoutMs: 200 } });

    const result = await runNightlyConsolidate(deps);

    expect(result.ok).toBe(false);
    expect(result.failures.map((f) => f.code)).toEqual(["REFRESH_EVIDENCE_MISSING"]);
    // the consolidate DID happen — the failure is the open-set refusal, not a skipped write
    expect(calls.some((c) => c.method === "POST" && c.url.endsWith("/consolidate"))).toBe(true);
    expectLegEverywhere(events, "crontab");
  });

  test("NaN wallClockBudgetMs → typed nightly-budget-invalid throw before any work", async () => {
    installRouter(() => {
      throw new Error("round-2: budget validation must precede any network touch");
    });
    const { deps } = rig({ banks: [BANK], overrides: { wallClockBudgetMs: Number.NaN } });

    await expect(runNightlyConsolidate(deps)).rejects.toMatchObject({ code: "nightly-budget-invalid" });
    expect(calls.length).toBe(0);
  });

  test("NaN refreshEvidenceTimeoutMs → typed nightly-budget-invalid throw", async () => {
    installRouter(() => {
      throw new Error("round-2: budget validation must precede any network touch");
    });
    const { deps } = rig({ banks: [BANK], overrides: { refreshEvidenceTimeoutMs: Number.NaN } });

    await expect(runNightlyConsolidate(deps)).rejects.toMatchObject({ code: "nightly-budget-invalid" });
  });

  test("two triggered models, failed refresh row FIRST then completed → the completed one is the receipt (page order never decides)", async () => {
    installNightlyRouter({
      banks: [BANK],
      mmItems: { [BANK]: [triggeredMm(BANK, "mm-alpha"), triggeredMm(BANK, "mm-beta")] },
      opsQueues: {
        [BANK]: [
          opsListBody(BANK, [
            refreshOpRow(BANK, { createdAt: iso(NOW_MS), status: "failed", errorMessage: "alpha detonated", mmId: "mm-alpha" }),
            refreshOpRow(BANK, { createdAt: iso(NOW_MS), opId: "op-refresh-beta", mmId: "mm-beta" }),
          ]),
        ],
      },
    });
    const { events, deps } = rig({ banks: [BANK] });

    const result = await runNightlyConsolidate(deps);

    expect(result.ok).toBe(true);
    expect(at(result.receipts, 0).mentalModelId).toBe("mm-beta");
    expect(at(result.receipts, 0).refresh.operationId).toBe("op-refresh-beta");
    expectLegEverywhere(events, "crontab");
  });

  test("bank whose evidence window is already gone when the poll begins → NIGHTLY_BUDGET_EXHAUSTED, not REFRESH_EVIDENCE_MISSING", async () => {
    installNightlyRouter({
      banks: [BANK],
      opsQueues: { [BANK]: [opsListBody(BANK, [refreshOpRow(BANK, { createdAt: iso(NOW_MS) })])] },
    });
    // Aggressive clock tuned so the PRE-BANK check still passes (500 < 1500)
    // but preflight + consolidate consume the rest before the evidence poll
    // begins — poll 0 must attribute to the budget, not to a silent instance.
    const { deps } = rig({
      banks: [BANK],
      overrides: {
        wallClockBudgetMs: 1500,
        now: () => {
          clockMs += 500;
          return clockMs;
        },
      },
    });

    const result = await runNightlyConsolidate(deps);

    expect(result.ok).toBe(false);
    expect(result.failures.map((f) => f.code)).toEqual(["NIGHTLY_BUDGET_EXHAUSTED"]);
    expect(result.failures[0]?.message).toContain("already exhausted");
  });
});

describe("CLI driver (memory-nightly)", () => {
  const REPO_BANKS = {
    banks: [
      { bankId: "qds-factory" },
      { bankId: "qds-factory-dev-meta" },
      { bankId: "qds-factory-qa-meta" },
      { bankId: "qds-factory-maint-meta" },
    ],
  };
  const DERIVED_BANKS = ["qds-factory-dev-meta", "qds-factory-qa-meta", "qds-factory-maint-meta"];
  const CLI_SCRIPT = fileURLToPath(new URL("../../scripts/memory-nightly.ts", import.meta.url));
  /** Complete gateway/job env (token material is fixture-only, never real). */
  const FULL_ENV = {
    QDS_MEMORY_AGENT_TOKEN: "mgat.fixture.material",
    MEMGATE_ADMIN_KEY: ADMIN,
    QDS_MEMGATE_SIGNING_KEY: SIGNING,
    QDS_MEMGATE_LEDGER: "", // filled per-test — the ledger must land in the sandbox
    HINDSIGHT_BASE_URL: BASE_URL,
  };
  /** Read the fault-envelope fields without coupling this suite to the
   * driver's (evolving) envelope union — the runtime contract is what's
   * pinned, and the union gains variants on the CLI side in step. */
  const faultOf = (envelope: unknown): { code?: string; message?: string; remediation?: string } =>
    envelope as { code?: string; message?: string; remediation?: string };

  test("case 16 — empty env → code 2 config refusal naming QDS_MEMORY_AGENT_TOKEN; NO fetch call, NO gateway side effects", async () => {
    installRouter(() => {
      throw new Error("nightly-consolidate.test: config refusal must not touch the network");
    });

    const { code, envelope } = await runMemoryNightly({ env: {} });

    expect(code).toBe(2);
    expect(envelope.ok).toBe(false);
    if (!("missing" in envelope)) throw new Error("expected the config-refusal envelope");
    expect(envelope.code).toBe("config-refusal");
    expect(envelope.leg).toBe("crontab");
    expect(envelope.missing).toContain("QDS_MEMORY_AGENT_TOKEN");
    expect(envelope.remediation).toContain("QDS_MEMORY_AGENT_TOKEN");
    expect(calls.length).toBe(0); // no fetch, no bank resolution, no gateway construction
  });

  test("case 17 — full env + fetch stub → code 0, envelope ok with leg crontab and one receipt per derived bank", async () => {
    installNightlyRouter({
      banks: DERIVED_BANKS,
      listBanksBody: REPO_BANKS,
      opsQueues: Object.fromEntries(
        DERIVED_BANKS.map((b) => [b, [opsListBody(b, [refreshOpRow(b, { createdAt: iso(NOW_MS) })])]]),
      ),
    });
    // mint the job's agent token with the REAL machinery under the SAME
    // signing key + ledger the CLI's gateway will verify against
    const mintGateway = memgateDeps({
      env: { [MEMGATE_ADMIN_KEY]: ADMIN, [QDS_MEMGATE_SIGNING_KEY]: SIGNING },
      ledgerPath: join(dir, "cli-ledger.db"),
      now: tickClock,
    });
    openLedgers.push(mintGateway.ledger);
    const token = grantAgentToken(mintGateway, {
      consumerClass: "bot",
      banks: DERIVED_BANKS,
      verbs: ["consolidate"],
      requestId: "req-t17",
    }).token;

    const { code, envelope } = await runMemoryNightly({
      env: {
        QDS_MEMORY_AGENT_TOKEN: token,
        MEMGATE_ADMIN_KEY: ADMIN,
        QDS_MEMGATE_SIGNING_KEY: SIGNING,
        QDS_MEMGATE_LEDGER: join(dir, "cli-ledger.db"),
        HINDSIGHT_BASE_URL: BASE_URL,
      },
      now: tickClock,
    });

    expect(code).toBe(0);
    expect(envelope.ok).toBe(true);
    expect(envelope.leg).toBe("crontab");
    if (!("receipts" in envelope)) throw new Error("expected the job-outcome envelope");
    expect(envelope.banks).toEqual(DERIVED_BANKS); // the landed CLI derives the three meta banks
    expect(envelope.receipts.length).toBe(3);
    expect(envelope.banksOk).toBe(3);
    expect(envelope.banksFailed).toBe(0);
    // exactly ONE listBanks resolution read, then three separate consolidates
    expect(calls.filter((c) => c.url.endsWith("/v1/default/banks")).length).toBe(1);
    expect(new Set(calls.filter((c) => c.url.includes("/consolidate")).map((c) => c.url)).size).toBe(3);
  });

  test("case 18 — listBanks yields only foreign banks → code 2, remediation names the provisioning script, no ledger opened", async () => {
    installNightlyRouter({
      banks: [],
      listBanksBody: { banks: [{ bankId: "some-other-repo" }, { bankId: "some-other-repo-dev-meta" }] },
    });
    const neverOpened = join(dir, "never-opened.db");

    const { code, envelope } = await runMemoryNightly({
      env: {
        QDS_MEMORY_AGENT_TOKEN: "mgat.irrelevant.material",
        MEMGATE_ADMIN_KEY: ADMIN,
        QDS_MEMGATE_SIGNING_KEY: SIGNING,
        QDS_MEMGATE_LEDGER: neverOpened,
        HINDSIGHT_BASE_URL: BASE_URL,
      },
      now: tickClock,
    });

    expect(code).toBe(2);
    expect(envelope.ok).toBe(false);
    if (!("repoSlug" in envelope)) throw new Error("expected the bank-resolution-failed envelope");
    expect(envelope.code).toBe("bank-resolution-failed");
    expect(envelope.remediation).toContain("provision-hindsight-banks");
    // fail-closed: the config was complete but bank resolution failed BEFORE
    // the gateway constructed — the pinned ledger path was never opened
    expect(existsSync(neverOpened)).toBe(false);
    expect(calls.some((c) => c.url.includes("/mental-models") || c.url.includes("/consolidate") || c.url.includes("/operations"))).toBe(false);
  });

  test("case 19 — QDS_MEMORY_REPO_SLUG=qds-collective → code 2, COLLECTIVE_SLUG_REFUSED naming the no-provisioning-circle rationale", async () => {
    installNightlyRouter({ banks: [], listBanksBody: REPO_BANKS }); // bank list answered; the slug gate must fire without further reads
    const neverOpened = join(dir, "case19-ledger.db");

    const { code, envelope } = await runMemoryNightly({
      env: { ...FULL_ENV, QDS_MEMGATE_LEDGER: neverOpened, QDS_MEMORY_REPO_SLUG: "qds-collective" },
      now: tickClock,
    });

    expect(code).toBe(2);
    expect(envelope.ok).toBe(false);
    const fault = faultOf(envelope);
    expect(fault.code).toBe("COLLECTIVE_SLUG_REFUSED");
    const rendered = JSON.stringify(envelope);
    expect(rendered).toContain("collective");
    // the refusal must BREAK the circle, not create one: it explains that the
    // provisioning script refuses the same slug instead of sending the
    // operator there
    expect(rendered).toContain("no provisioning circle");
    expect(existsSync(neverOpened)).toBe(false); // fail-closed before any gateway state
  });

  test("case 20 — unknown argv flag (--dry-run) → exit 2 with an unknown-flag usage line at the real CLI boundary", () => {
    // fx4 landed the unknown-flag gate in the script's import.meta.main block
    // (MemoryNightlyDeps.argv is documented core-ignored), so the honest pin
    // is the spawned CLI itself: the gate exits 2 before any config read,
    // network call, or gateway state.
    const proc = Bun.spawnSync({
      cmd: ["bun", CLI_SCRIPT, "--dry-run"],
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(proc.exitCode).toBe(2);
    const text = `${proc.stderr.toString()}${proc.stdout.toString()}`;
    expect(text).toContain("unknown flag: --dry-run");
    expect(text).toContain("usage:");
  });

  test("case 21 — listBanks unreachable (fetch 500) → code 1, structured fault envelope code BANK_LIST_UNREACHABLE with remediation naming HINDSIGHT_BASE_URL reachability", async () => {
    installRouter(() => ({ status: 500, body: { error: "instance down" } }));
    const neverOpened = join(dir, "case21-ledger.db");

    const { code, envelope } = await runMemoryNightly({
      env: { ...FULL_ENV, QDS_MEMGATE_LEDGER: neverOpened },
      now: tickClock,
    });

    expect(code).toBe(1);
    expect(envelope.ok).toBe(false);
    const fault = faultOf(envelope);
    expect(fault.code).toBe("BANK_LIST_UNREACHABLE");
    expect(fault.remediation).toContain("HINDSIGHT_BASE_URL");
    expect(calls.some((c) => c.url.includes("/consolidate"))).toBe(false);
  });

  test("case 22 — single-dash typo flag (-dry-run) → exit 2 unknown-flag usage line (the -- gate's class, closed for - too)", () => {
    const proc = Bun.spawnSync({
      cmd: ["bun", CLI_SCRIPT, "-dry-run"],
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(proc.exitCode).toBe(2);
    const text = `${proc.stderr.toString()}${proc.stdout.toString()}`;
    expect(text).toContain("unknown flag: -dry-run");
    expect(text).toContain("usage:");
  });

  test("case 23 — legacy collision family resolves to a repoBankId whose maint-meta id overflows the 64-char cap → code 2 bank-id-overflow naming the convergence path", async () => {
    // A 52-era slug collides to "<base52>-2" (55 chars): dev-meta still fits
    // (64), maint-meta is 66 — that bank can never exist, so the nightly
    // must refuse at config time instead of failing it every run.
    const base52 = "a".repeat(52);
    const legacyBank = `${base52}-2`;
    installNightlyRouter({
      banks: [],
      listBanksBody: { banks: [{ bank_id: legacyBank }, { bank_id: `${legacyBank}-dev-meta` }] },
      opsQueues: {},
    });

    const { code, envelope } = await runMemoryNightly({
      env: { ...FULL_ENV, QDS_MEMGATE_LEDGER: join(dir, "case23-ledger.db"), QDS_MEMORY_REPO_SLUG: base52 },
      now: tickClock,
    });

    expect(code).toBe(2);
    expect(envelope.ok).toBe(false);
    const fault = faultOf(envelope);
    expect(fault.code).toBe("bank-id-overflow");
    expect(fault.remediation).toContain("50-char rule");
    expect(calls.some((c) => c.url.includes("/consolidate"))).toBe(false);
  });

  test("case 24 — HINDSIGHT_BASE_URL is REQUIRED (the client's silent 127.0.0.1:8888 default aims at the wrong instance) → config-refusal names it", async () => {
    installRouter(() => {
      throw new Error("round-2: config refusal must not touch the network");
    });
    const env: Record<string, string | undefined> = { ...FULL_ENV, QDS_MEMGATE_LEDGER: join(dir, "case24-ledger.db") };
    env.HINDSIGHT_BASE_URL = undefined; // the case: the required var is absent

    const { code, envelope } = await runMemoryNightly({ env, now: tickClock });

    expect(code).toBe(2);
    expect(envelope.ok).toBe(false);
    if (!("missing" in envelope)) throw new Error("expected the config-refusal envelope");
    expect(envelope.missing).toContain("HINDSIGHT_BASE_URL");
    expect(calls.length).toBe(0);
  });
});
