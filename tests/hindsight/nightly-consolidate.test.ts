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
 * Mandated-case map (story Trigger Surface + AC2/AC3/AC4 + DoD):
 *   describe "both legs, one module"        → cases 1-3
 *   describe "coalescing (AC2)"             → case 4
 *   describe "token scoping (AC3)"          → cases 5-6
 *   describe "fail-loud refresh proof (AC2)"→ cases 7-11
 *   describe "in-box write-back fence"      → cases 12-14
 *   describe "AC4 module-graph fences"      → case 15
 *   describe "CLI driver (memory-nightly)"  → cases 16-18
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { runMemoryNightly } from "../../scripts/memory-nightly.ts";
import { HindsightClient } from "../../src/hindsight/client.ts";
import { runNightlyConsolidate, type NightlyDeps, type NightlyReceipt } from "../../src/hindsight/nightly-consolidate.ts";
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
import type { LogEntry } from "../../src/swarmclaw/log.ts";

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
const EVIDENCE_BUDGET_MS = 40;

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
const triggeredMm = (bank: string): Record<string, unknown> => ({
  id: mmOf(bank),
  name: `nightly model ${bank}`,
  bank_id: bank,
  trigger: { refresh_after_consolidation: true },
});
const mmListBody = (items: unknown[]): Record<string, unknown> => ({ items, total: items.length, limit: 100, offset: 0 });
const refreshOpRow = (
  bank: string,
  opts: { createdAt: string; opId?: string; status?: string; errorMessage?: string | null },
): Record<string, unknown> => ({
  id: opts.opId ?? `op-refresh-${bank}`,
  task_type: "refresh_mental_model",
  operation_id: opts.opId ?? `op-refresh-${bank}`,
  operation_type: "refresh_mental_model",
  items_count: 0,
  mental_model_id: mmOf(bank),
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
// coalescing (AC2) — case 4
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
// fail-loud refresh proof (AC2) — cases 7-11
// ---------------------------------------------------------------------------

describe("fail-loud refresh proof (AC2)", () => {
  test("case 7 — MM present but trigger.refresh_after_consolidation=false → MM_TRIGGER_ABSENT and NO consolidate call (preflight gates the write)", async () => {
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

  test("case 9 — ops poll never yields a refresh op within budget → REFRESH_EVIDENCE_MISSING, ok=false (trigger presence alone NEVER passes)", async () => {
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
  /** The E21 seam fakes, by symbol: the graph must contain NONE of them. */
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
    if (FORBIDDEN_IN_SOURCE.test(src)) violations.push(`${entry}: forbidden E21-seam symbol in source`);
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
// CLI driver (scripts/memory-nightly.ts) — cases 16-18
// ---------------------------------------------------------------------------

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
});
