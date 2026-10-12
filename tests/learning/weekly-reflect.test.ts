/**
 * M3.2 leaf-1.3.1 — the weekly-reflect suite (nightly-consolidate.test.ts
 * rig idiom: env table, tmpdir ledger, tracked closes, fetch stubbed at the
 * wire boundary, tick clock, NO mock library).
 *
 * Mandated-case map:
 *   "AC6 class split + rig"        → host {reflect,retain} grant / bot retain refusal
 *   "module-graph fences (AC1/AC6)"→ writer-import + E21 + raw-instance-port fences
 *   "crontab leg"                  → full pipeline, carriers, AC2/AC5, store 0600
 *   "schedule leg (AC3)"           → chat carrier summaries
 *   "AC4 absence arms"             → typed absence, zero-evidence green, read-only proof
 *   "idempotent re-fire (C7)"      → retry / re-fire / divergent (both arms)
 *   "budgets (C8)"                 → NaN guard, exhaustion with no partial posting
 *   "CLI driver (memory-weekly)"   → env fail-closed FIRST, seams, usage, bank resolution
 *   "typed faults + exit contract" → F-001 bank-failure red, F-006/F-010/F-018 typed seams
 *   "e2e"                          → MANDATORY spawned demo over a loopback shim
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { run, runMemoryWeekly } from "../../scripts/memory-weekly.ts";
import { HindsightClient } from "../../src/hindsight/client.ts";
import {
  RETAIN_CONTENT_BYTE_CEILING,
  runWeeklyReflect,
  type WeeklyDeps,
} from "../../src/learning/weekly-reflect.ts";
import { ProposalSchema, type ProposalRecord } from "../../src/learning/proposal-schema.ts";
import {
  MEMGATE_ADMIN_KEY,
  QDS_MEMGATE_SIGNING_KEY,
  MemgateError,
  grantAgentToken,
  memgateDeps,
  verifyRequest,
} from "../../src/memgate/index.ts";
import type { LogEntry } from "../../src/swarmclaw/log.ts";

// ─── fixtures + env discipline ───────────────────────────────────────────────

const NOW_MS = Date.parse("2026-10-05T06:23:00.000Z");
const WEEK = "2026-W41";
const FIRED_AT = "2026-10-05T06:23:00.000Z";
const STAMP = "2026-10-05T06-23-00-000Z";
const ADMIN = "memgate-admin-test-key-0000000000000001";
const SIGNING = "memgate-signing-test-key-0000000000000001";
const BASE_URL = "http://hindsight.test";
const FAMILY = ["qds-factory-dev-meta", "qds-factory-qa-meta", "qds-factory-maint-meta"];
const ENV_KEYS = [MEMGATE_ADMIN_KEY, QDS_MEMGATE_SIGNING_KEY, "QDS_MEMGATE_LEDGER", "HINDSIGHT_BASE_URL", "HINDSIGHT_BEARER_TOKEN", "HINDSIGHT_API_KEY", "QDS_MEMORY_WEEKLY_AGENT_TOKEN", "QDS_MEMORY_REPO_SLUG", "QDS_WEEKLY_NOW", "QDS_WEEKLY_FIRED_AT"] as const;

let savedEnv: Record<string, string | undefined> = {};
let dir = "";
let clockMs = NOW_MS;
let openLedgers: Array<{ close(): void }> = [];
let events: LogEntry[] = [];

beforeEach(() => {
  savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of ENV_KEYS) delete process.env[k];
  dir = mkdtempSync(join(tmpdir(), "qds-m32-weekly-"));
  clockMs = NOW_MS;
  events = [];
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
  globalThis.fetch = originalFetch;
  rmSync(dir, { recursive: true, force: true });
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

const tickClock = (): number => {
  clockMs += 1;
  return clockMs;
};
const ledgerPath = () => join(dir, "memgate-ledger.db");
const evName = (e: LogEntry): string => (typeof e.event === "string" ? e.event : "");
const at = <T>(arr: T[], i: number): T => {
  const v = arr[i];
  if (v === undefined) throw new Error(`fixture index ${i} out of range`);
  return v;
};
const codeOfMemgate = (fn: () => unknown): string => {
  try {
    fn();
  } catch (e) {
    if (e instanceof MemgateError) return e.code;
    throw e;
  }
  throw new Error("expected MemgateError, none thrown");
};

// ─── evidence factories ──────────────────────────────────────────────────────

const routingLine = (runId: string, applied_tier: string, quality: number): Record<string, unknown> => ({
  workKey: `wk-${runId.slice(-1)}`,
  runId,
  shape: "review",
  risk_tier: "high",
  applied_tier,
  score: { quality },
  jev_recommendation: null,
  created_at: "2026-10-08T10:00:00.000Z", // inside the 2026-W41 evidence window (Mon Oct 5 – Sun Oct 11)
});
const ROUTING_LOG_TEXT = [
  routingLine("qds-20261008-000001", "opus", 0.5),
  routingLine("qds-20261008-000002", "opus", 0.5),
  routingLine("qds-20261008-000003", "sonnet", 0.8),
  routingLine("qds-20261008-000004", "sonnet", 0.8),
]
  .map((l) => JSON.stringify(l))
  .join("\n");
const kpi = (name: string, counter: number): Record<string, unknown> => ({
  name,
  direction: name === "first_pass_accept" ? "up" : "down",
  sources: ["runs"],
  value: { status: "measured", value: 0.2, denominator: 10, sources: ["runs"] },
  counter: { name: name === "retry_rate" ? "unclassified_restart_rate" : `${name}_counter`, value: counter, source: "runs" },
});
/** A real-shape A5 snapshot (src/kpi/schema.ts closed form) — counter positive on retry_rate. */
const snapshot = (counter = 3): Record<string, unknown> => ({
  schema: "qds.kpi-snapshot",
  schema_version: 1,
  window: { start: "2026-10-05T00:00:00.000Z", end: "2026-10-12T00:00:00.000Z", window_id: "20261005-20261012" },
  kpis: [kpi("tdi_proxy", 0), kpi("cost_per_story", 0), kpi("first_pass_accept", 0), kpi("retry_rate", counter)],
  spend: {
    join_key: "workKey+runId", factory_micro_usd_total: 0, factory_event_count: 0, gateway_row_count: null,
    gateway_micro_usd_total: null, gateway_duplicate_rows: null, gateway_matched_micro_usd: null,
    matched_gateway_rows: 0, unmatched_gateway_rows: null, missing_gateway_rows: null, spend_incomplete: true,
  },
  dimensions: [],
  run_accounting: { records_in_window: 2, records_skipped: 0, records_undated: 0, terminal_runs: 2, accepted_runs: 1 },
  per_kpi_failures: [],
});
const RUN_RECORD = { status: "error", classification: "retry-loop" };

/** Seed the consumed stores (all defaults on). Returns the input paths. */
function seed(o: { routing?: boolean; kpi?: boolean; runs?: boolean } = {}): { routing: string; kpis: string; runs: string } {
  const routing = join(dir, "routing-log.jsonl");
  const kpis = join(dir, "kpi-snapshots");
  const runs = join(dir, "runs");
  if (o.routing !== false) writeFileSync(routing, `${ROUTING_LOG_TEXT}\n`);
  if (o.kpi !== false) {
    mkdirSync(kpis, { recursive: true });
    writeFileSync(join(kpis, "2026-10-05T00-00-00-000Z.json"), JSON.stringify(snapshot(3)));
  }
  if (o.runs !== false) {
    mkdirSync(runs, { recursive: true });
    writeFileSync(join(runs, "qds-20261009-120000.json"), JSON.stringify(RUN_RECORD));
    writeFileSync(join(runs, "qds-20261010-120000.json"), JSON.stringify(RUN_RECORD));
  }
  return { routing, kpis, runs };
}

const sha = (b: Buffer): string => createHash("sha256").update(b).digest("hex");
/** Recursive digest over explicit paths — the consumed-stores byte-identity proof. */
function digestPaths(paths: string[]): string {
  const h = createHash("sha256");
  const walk = (p: string): void => {
    if (statSync(p).isDirectory()) for (const n of readdirSync(p).sort()) walk(join(p, n));
    else h.update(`${p}:${sha(readFileSync(p))}`);
  };
  for (const p of paths) walk(p);
  return h.digest("hex");
}

// ─── fetch stub (wire boundary) ──────────────────────────────────────────────

const RETAIN_WIRE = { success: true, items_count: 1, async: false, usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0, cached_tokens: 0, thoughts_tokens: 0 } };
interface Call {
  method: string;
  url: string;
  body?: unknown;
}
const originalFetch: typeof globalThis.fetch = globalThis.fetch.bind(globalThis);
let calls: Call[] = [];
function installRouter(
  route: (method: string, url: string, body: unknown) => { status?: number; body: unknown } | undefined,
): void {
  calls = [];
  globalThis.fetch = (async (input: Parameters<typeof globalThis.fetch>[0], init?: Parameters<typeof globalThis.fetch>[1]) => {
    const url = typeof input === "string" ? input : input instanceof Request ? input.url : String(input);
    const method = init?.method ?? "GET";
    let body: unknown;
    if (typeof init?.body === "string") body = JSON.parse(init.body);
    else if (init?.body !== undefined) body = init.body;
    calls.push({ method, url, body });
    const reply = route(method, url, body);
    if (reply === undefined) throw new Error(`weekly-reflect.test: unrouted ${method} ${url}`);
    return new Response(JSON.stringify(reply.body ?? {}), { status: reply.status ?? 200, headers: { "content-type": "application/json" } });
  }) as typeof globalThis.fetch;
}
const bankOfUrl = (url: string): string => {
  const m = /\/v1\/default\/banks\/([^/]+)\//.exec(url);
  if (m === null) throw new Error(`no bank segment in ${url}`);
  return at(m, 1);
};
function installWeeklyRouter(o: { listBanks?: unknown; reflectStatus?: number } = {}): void {
  installRouter((_method, url) => {
    if (url.endsWith("/v1/default/banks")) return { body: o.listBanks ?? { banks: FAMILY.map((b) => ({ bank_id: b })) } };
    if (url.endsWith("/reflect")) {
      if (o.reflectStatus !== undefined) return { status: o.reflectStatus, body: {} };
      return { body: { bankId: bankOfUrl(url), insights: [{ summary: "cost per story trending down" }], durationMs: 1 } };
    }
    if (url.endsWith("/memories")) return { body: RETAIN_WIRE };
    return undefined;
  });
}
const retainCalls = (): Call[] => calls.filter((c) => c.url.endsWith("/memories"));
const reflectQueries = (): string[] =>
  calls.filter((c) => c.url.endsWith("/reflect")).map((c) => ((c.body as { query?: string })?.query ?? ""));

// ─── the rig: real gateway + real-minted HOST token + tick clock ─────────────

function rig(o: { banks?: string[]; leg?: "crontab" | "schedule"; grantClass?: "host" | "bot"; seedInputs?: boolean; overrides?: Partial<WeeklyDeps> } = {}): WeeklyDeps {
  const banks = o.banks ?? FAMILY;
  const gateway = memgateDeps({
    env: { [MEMGATE_ADMIN_KEY]: ADMIN, [QDS_MEMGATE_SIGNING_KEY]: SIGNING },
    ledgerPath: ledgerPath(),
    now: tickClock,
    client: new HindsightClient({ baseUrl: BASE_URL }),
  });
  openLedgers.push(gateway.ledger);
  const cls = o.grantClass ?? "host";
  const token = grantAgentToken(gateway, { consumerClass: cls, banks, verbs: cls === "host" ? ["reflect", "retain"] : ["consolidate"], requestId: "req-grant" }).token;
  const paths = o.seedInputs === false ? { routing: join(dir, "routing-log.jsonl"), kpis: join(dir, "kpi-snapshots"), runs: join(dir, "runs") } : seed();
  return {
    gateway,
    token,
    banks,
    leg: o.leg ?? "crontab",
    week: WEEK,
    firedAt: FIRED_AT,
    proposalsDir: join(dir, "proposals"),
    routingLogPath: paths.routing,
    kpiSnapshotsDir: paths.kpis,
    runsDir: paths.runs,
    now: (): Date => new Date(tickClock()),
    log: (e) => events.push(e as LogEntry),
    ...o.overrides,
  };
}

const storeFiles = (): string[] => (existsSync(join(dir, "proposals")) ? readdirSync(join(dir, "proposals")).sort() : []);
const readStore = (name: string): ProposalRecord => JSON.parse(readFileSync(join(dir, "proposals", name), "utf8")) as ProposalRecord;
const idsOf = (r: { proposals: string[] }): string[] => r.proposals;

// ─── AC6 class split + rig ───────────────────────────────────────────────────

describe("AC6 class split + rig", () => {
  test("host-class grant {reflect, retain} authorizes BOTH the reflect and the retain path for the family", () => {
    const deps = rig();
    for (const bank of FAMILY) {
      expect(verifyRequest(deps.gateway, { authHeader: `Bearer ${deps.token}`, method: "POST", path: `/v1/default/banks/${bank}/reflect`, requestId: "r" }).ok).toBe(true);
      expect(verifyRequest(deps.gateway, { authHeader: `Bearer ${deps.token}`, method: "POST", path: `/v1/default/banks/${bank}/memories`, requestId: "r" }).ok).toBe(true);
    }
  });

  test("bot grant asking retain is REFUSED (grant-verb-outside-class) — the retain verb never enters a bot-held token", () => {
    const deps = rig({ grantClass: "bot" });
    expect(codeOfMemgate(() => grantAgentToken(deps.gateway, { consumerClass: "bot", banks: FAMILY, verbs: ["retain"], requestId: "r2" }))).toBe("grant-verb-outside-class");
  });

  test("a bot-class token is refused on BOTH weekly paths (reflect + retain) — scope-verb", () => {
    const deps = rig({ grantClass: "bot" });
    for (const path of [`/v1/default/banks/${FAMILY[0]}/reflect`, `/v1/default/banks/${FAMILY[0]}/memories`]) {
      const v = verifyRequest(deps.gateway, { authHeader: `Bearer ${deps.token}`, method: "POST", path, requestId: "r3" });
      expect(v.ok).toBe(false);
      if (!v.ok) expect(v.reason).toBe("scope-verb");
    }
  });
});

// ─── module-graph fences (AC1/AC6 static) ────────────────────────────────────

describe("module-graph fences (AC1/AC6)", () => {
  // Comment-prose mentions must not flip the fence; only OWNED files get the
  // token scan, while the SPECIFIER scan covers the full transitive closure.
  const FORBIDDEN_IN_SOURCE = /home-bot|home_bot|\bE21\b|from "[^"]*fleet|from "[^"]*managers|from "[^"]*phase-engine|pi-vs-claude-code-vendor|scripts\/lib\/run-lock/;
  // \bgate/ is boundary-anchored so "memgate/" never false-positives (self-review round 0 #5).
  const FORBIDDEN_SPECIFIER = /home-bot|home_bot|\bE21\b|fleet|managers|phase-engine|\bgate\/|pi-vs-claude-code-vendor|scripts\/lib\/run-lock/;
  const WRITER_PATHS = /(^|\/)(managers|fleet|phase-engine|gate)\//;  // src/gate/** = the frozen gate machinery (INV-LEARN-5)
  const SPEC_PATTERNS = [/from\s*["']([^"']+)["']/g, /import\s*["']([^"']+)["']/g, /import\(\s*["']([^"']+)["']\s*\)/g, /require\(\s*["']([^"']+)["']\s*\)/g];
  const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));
  const ENTRIES = [join(REPO_ROOT, "scripts/memory-weekly.ts"), join(REPO_ROOT, "src/learning/weekly-reflect.ts"), join(REPO_ROOT, "src/learning/index.ts")];

  function resolveSpecifier(spec: string, fromFile: string): string | null {
    if (!spec.startsWith(".")) return null;
    const base = resolve(dirname(fromFile), spec);
    for (const cand of [base, `${base}.ts`, `${base}.tsx`, `${base}.js`, join(base, "index.ts")]) {
      if (existsSync(cand) && statSync(cand).isFile()) return cand;
    }
    return null;
  }
  function collect(entry: string, seen: Set<string>, violations: string[], depth = 0): void {
    if (depth > 24 || seen.has(entry) || !existsSync(entry)) return;
    seen.add(entry);
    const src = readFileSync(entry, "utf8");
    if (ENTRIES.includes(entry)) {
      if (FORBIDDEN_IN_SOURCE.test(src)) violations.push(`${entry}: forbidden seam token in source`);
    }
    // Raw-instance-port scan over the WHOLE closure (self-review round 0 #5) —
    // except the M1.1-owned client, whose silent localhost default is why the
    // job must not reach it at all (asserted separately below).
    if (!entry.endsWith("hindsight/client.ts") && /127\.0\.0\.1:8888|:18889|localhost:8888/.test(src)) {
      violations.push(`${entry}: raw instance port in source`);
    }
    for (const pattern of SPEC_PATTERNS) {
      pattern.lastIndex = 0;
      for (const m of src.matchAll(pattern)) {
        const spec = m[1];
        if (spec === undefined) continue;
        if (FORBIDDEN_SPECIFIER.test(spec)) violations.push(`${entry}: forbidden specifier "${spec}"`);
        if (WRITER_PATHS.test(spec)) violations.push(`${entry}: writer-of-state import "${spec}"`);
        const target = resolveSpecifier(spec, entry);
        if (target !== null) collect(target, seen, violations, depth + 1);
      }
    }
  }

  test("fence — the transitive graph of the weekly entrypoints carries NO writer of routing/threshold/gate state, NO E21/fleet symbol, NO raw instance port", () => {
    const seen = new Set<string>();
    const violations: string[] = [];
    for (const entry of ENTRIES) {
      expect(existsSync(entry)).toBe(true);
      collect(entry, seen, violations);
    }
    expect(seen.size).toBeGreaterThan(3); // the walk actually traversed the closure
    expect(violations).toEqual([]);
    // client.ts IS in the closure by architecture: the CLI hands the gateway
    // its forward client (M2.1 posture, nightly-identical). INV-LEARN-2 is
    // protected NOT by absence but by (a) the port scan above (client.ts's
    // silent 8888 default is exempt as M1.1-owned, never this job's config)
    // and (b) HINDSIGHT_BASE_URL being fail-closed REQUIRED (tested in the
    // config-refusal suite) — the default can never fire.
    expect([...seen].some((f) => f.endsWith("hindsight/client.ts"))).toBe(true);
  });
});

// ─── crontab leg — the full pipeline ─────────────────────────────────────────

describe("crontab leg — full pipeline", () => {
  test("e2e — gather → reflect ×3 → compose 3 kinds → store 0600 → retain replace → stdout carrier; reflect query severity-free", async () => {
    installWeeklyRouter();
    const deps = rig({ leg: "crontab" });
    const result = await runWeeklyReflect(deps);

    expect(result.ok).toBe(true);
    expect(result.leg).toBe("crontab");
    expect(idsOf(result.receipt)).toHaveLength(3);
    expect(result.proposals.map((p) => p.kind)).toEqual(["router-tuning", "threshold-suggestion", "skill-update"]);
    // store: 0600 records in a 0700 dir, every emitted record schema-clean
    expect(storeFiles()).toHaveLength(3);
    expect(statSync(join(dir, "proposals")).mode & 0o777).toBe(0o700);
    for (const f of storeFiles()) {
      expect(statSync(join(dir, "proposals", f)).mode & 0o777).toBe(0o600);
      expect(ProposalSchema.safeParse(readStore(f)).success).toBe(true);
    }
    // retain: replace + identity tags + ≤4096-byte content, on the family's target bank
    const retains = retainCalls();
    expect(retains).toHaveLength(3);
    for (const c of retains) {
      expect(c.url).toContain(`/${FAMILY[0]}/memories`);
      const item = at((c.body as { items: Array<Record<string, unknown>> }).items, 0);
      expect(item.update_mode).toBeUndefined(); // replace is API-level upsert semantics, no wire field
      expect(item.document_id).toMatch(/^l4-proposal-2026-W41-2026-10-05T06-23-00-000Z-\d{3}$/);
      expect((item.tags as string[]).length).toBe(3);
      expect(Buffer.byteLength(item.content as string, "utf8")).toBeLessThanOrEqual(RETAIN_CONTENT_BYTE_CEILING);
      expect((item.metadata as Record<string, string>).kind).toBe("observation");
      expect((item.metadata as Record<string, string>).source).toBe("agent");
    }
    // AC3: crontab carrier = stdout, FULL text; receipt posted covers exactly once
    expect(result.receipt.posted.every((p) => p.carrier === "stdout")).toBe(true);
    expect(result.postedTexts).toHaveLength(3);
    for (const t of result.postedTexts) {
      expect(t.text).toContain(t.proposal_id);
      expect(t.text).toContain("Nothing is applied automatically");
    }
    expect(result.receipt.absent_sources).toEqual([]);
    expect(result.receipt.reflect_ms_by_bank && Object.keys(result.receipt.reflect_ms_by_bank)).toHaveLength(3);
    // AC5: the reflect query carries no severity token; nothing emitted does
    expect(reflectQueries().length).toBe(3);
    for (const q of reflectQueries()) expect(/sever/i.test(q)).toBe(false);
    expect(/sever/i.test(JSON.stringify([result.receipt, result.proposals, result.postedTexts]))).toBe(false);
    // event sequence
    const names = events.map(evName);
    const firstIdx = (n: string): number => names.indexOf(n);
    expect(firstIdx("weekly-fire")).toBeGreaterThanOrEqual(0);
    expect(firstIdx("weekly-fire")).toBeLessThan(firstIdx("reflect-run"));
    expect(firstIdx("reflect-run")).toBeLessThan(firstIdx("proposal-composed"));
    expect(firstIdx("proposal-composed")).toBeLessThan(firstIdx("proposal-posted"));
    expect(firstIdx("proposal-posted")).toBeLessThan(firstIdx("weekly-complete"));
    const complete = at(events.filter((e) => evName(e) === "weekly-complete"), 0);
    expect(complete.proposals).toBe(3);
    expect(complete.banks_ok).toBe(3);
  });

  test("AC2 — the emitted threshold-suggestion carries advisory + operator adjudicator + the J2 DD-21-unsatisfied note end-to-end", async () => {
    installWeeklyRouter();
    await runWeeklyReflect(rig());
    const file = at(storeFiles().filter((f) => readStore(f).kind === "threshold-suggestion"), 0);
    const p = readStore(file);
    expect(p.advisory).toBe(true);
    expect(p.adjudicator).toBe("operator");
    expect(p.j2_gate_note).toContain("DD-21");
    expect(p.j2_gate_note).toContain("NOT satisfied");
  });

});

// ─── schedule leg (AC3) ──────────────────────────────────────────────────────

describe("schedule leg (AC3)", () => {
  test("chat carrier: postedTexts are the host-composed summaries; receipt.posted carrier is chat", async () => {
    installWeeklyRouter();
    const result = await runWeeklyReflect(rig({ leg: "schedule" }));
    expect(result.ok).toBe(true);
    expect(result.receipt.leg).toBe("schedule");
    expect(result.receipt.posted.every((p) => p.carrier === "chat")).toBe(true);
    expect(result.postedTexts).toHaveLength(3);
    for (const t of result.postedTexts) {
      expect(t.text.startsWith("[")).toBe(true);
      expect(t.text).toContain("operator applies");
      expect(t.text).not.toContain("rationale:"); // summary, not the full text
    }
  });
});

// ─── AC4 absence arms ────────────────────────────────────────────────────────

describe("AC4 absence arms", () => {
  test("routing log deleted ⇒ typed absent entry, job green, proposals still compose from KPI + runs", async () => {
    installWeeklyRouter();
    const paths = seed({ routing: false });
    const result = await runWeeklyReflect(rig({ seedInputs: false, overrides: { routingLogPath: paths.routing } }));
    expect(result.ok).toBe(true);
    expect(result.receipt.absent_sources).toEqual([{ source: "routing-log", status: "absent" }]);
    expect(result.receipt.proposals).toHaveLength(2); // threshold + skill; router-tuning had no lines
  });

  test("all sources absent ⇒ zero proposals, green, receipt empty sets, no proposals dir created", async () => {
    installWeeklyRouter();
    const paths = seed({ routing: false, kpi: false, runs: false });
    const result = await runWeeklyReflect(rig({ seedInputs: false, overrides: { routingLogPath: paths.routing, kpiSnapshotsDir: paths.kpis, runsDir: paths.runs } }));
    expect(result.ok).toBe(true);
    expect(result.receipt.absent_sources).toHaveLength(3);
    expect(result.receipt.proposals).toEqual([]);
    expect(result.proposals).toEqual([]);
    expect(result.postedTexts).toEqual([]);
    expect(existsSync(join(dir, "proposals"))).toBe(false);
  });

  test("read-only proof — consumed stores byte-identical after a full run; nothing written outside proposalsDir", async () => {
    installWeeklyRouter();
    const deps = rig();
    const paths = { routing: deps.routingLogPath as string, kpis: deps.kpiSnapshotsDir as string, runs: deps.runsDir as string };
    const before = digestPaths([paths.routing, paths.kpis, paths.runs]);
    const dirBefore = readdirSync(dir).sort();
    const result = await runWeeklyReflect(deps);
    expect(result.ok).toBe(true);
    expect(digestPaths([paths.routing, paths.kpis, paths.runs])).toBe(before);
    // the only NEW top-level entry is the proposals dir (the ledger is rig-created, before the run)
    expect(readdirSync(dir).sort().filter((f) => !dirBefore.includes(f))).toEqual(["proposals"]);
  });
});

// ─── idempotent re-fire (C7) ─────────────────────────────────────────────────

describe("idempotent re-fire (C7)", () => {
  test("same firedAt retry: same ids, no duplicate files, byte-identical rows, retain replace re-sent, receipt identical modulo total_ms", async () => {
    installWeeklyRouter();
    const deps = rig();
    const first = await runWeeklyReflect(deps);
    const firstFiles = storeFiles();
    const firstBytes = firstFiles.map((f) => sha(readFileSync(join(dir, "proposals", f))));
    const retainsAfterFirst = retainCalls().length;
    const second = await runWeeklyReflect(deps);
    expect(second.receipt.proposals).toEqual(first.receipt.proposals);
    expect(second.receipt.superseded).toEqual(first.receipt.superseded);
    expect(second.receipt.posted).toEqual(first.receipt.posted);
    expect(storeFiles()).toEqual(firstFiles); // rename-over equivalent: no duplicates
    expect(firstFiles.map((f) => sha(readFileSync(join(dir, "proposals", f))))).toEqual(firstBytes);
    expect(retainCalls().length).toBe(retainsAfterFirst * 2); // replace re-sent per proposal
  });

  test("different firedAt, same week: NEW documentIds, old records intact, receipt.superseded names the earlier firing's ids", async () => {
    installWeeklyRouter();
    const first = await runWeeklyReflect(rig({ overrides: { firedAt: "2026-10-05T06:23:00.000Z" } }));
    const oldFiles = storeFiles();
    expect(oldFiles).toHaveLength(3);
    const second = await runWeeklyReflect(rig({ overrides: { firedAt: "2026-10-08T06:23:00.000Z" } }));
    const newFiles = storeFiles();
    expect(newFiles).toHaveLength(6); // old intact + new mints
    expect(newFiles.filter((f) => oldFiles.includes(f))).toEqual(oldFiles);
    expect(second.receipt.proposals.every((id) => id.includes("2026-10-08T06-23-00-000Z"))).toBe(true);
    expect(second.receipt.superseded.sort()).toEqual(first.receipt.proposals.sort());
  });

  test("an out-of-order EARLIER pinned firedAt never labels the NEWER ids superseded (self-review round 0 #4)", async () => {
    installWeeklyRouter();
    const later = await runWeeklyReflect(rig({ overrides: { firedAt: "2026-10-08T06:23:00.000Z" } }));
    expect(later.receipt.superseded).toEqual([]); // first firing of this week in this store
    const earlier = await runWeeklyReflect(rig({ overrides: { firedAt: "2026-10-05T06:23:00.000Z" } }));
    expect(earlier.receipt.superseded).toEqual([]); // the 10-08 ids are LATER — never superseded by an earlier firing
    expect(earlier.receipt.proposals.every((id) => id.includes("2026-10-05T06-23-00-000Z"))).toBe(true);
  });

  test("async retain failure (wire 500): typed RETAIN_FAILED fault, proposal excluded from the receipt, run NOT ok — the await is load-bearing", async () => {
    installRouter((_method, url) => {
      if (url.endsWith("/memories")) return { status: 500, body: {} };
      if (url.endsWith("/reflect")) return { body: { bankId: bankOfUrl(url), insights: [{ summary: "s" }], durationMs: 1 } };
      return undefined;
    });
    const result = await runWeeklyReflect(rig());
    expect(result.ok).toBe(false);
    expect(result.receipt.proposals).toEqual([]); // stored but never fully landed
    expect(storeFiles()).toHaveLength(3); // the store row stands; only the carrier step is withheld
    const faults = events.filter((e) => evName(e) === "weekly-fault");
    expect(faults.length).toBeGreaterThanOrEqual(1);
    for (const f of faults) expect(f.code).toBe("RETAIN_FAILED");
  });

  test("divergent same-id content (sole proposal): PROPOSAL_DIVERGENT fault, stored row stands, incoming dropped, run NOT ok", async () => {
    installWeeklyRouter();
    const paths = seed({ kpi: false, runs: false }); // router-tuning only ⇒ exactly one proposal (...-001)
    const divergentId = `l4-proposal-${WEEK}-${STAMP}-001`;
    mkdirSync(join(dir, "proposals"), { recursive: true, mode: 0o700 });
    writeFileSync(join(dir, "proposals", `${divergentId}.json`), JSON.stringify({ schema: "qds.l4-proposal", proposal_id: divergentId, tampered: true }));
    const result = await runWeeklyReflect(rig({ seedInputs: false, overrides: { routingLogPath: paths.routing, kpiSnapshotsDir: paths.kpis, runsDir: paths.runs } }));
    expect(result.ok).toBe(false); // a firing whose every proposal diverged must not read green
    expect(result.proposals).toEqual([]);
    expect(result.receipt.proposals).toEqual([]);
    expect(readFileSync(join(dir, "proposals", `${divergentId}.json`), "utf8")).toContain("tampered"); // stored row stands
    const fault = at(events.filter((e) => evName(e) === "weekly-fault"), 0);
    expect(fault.code).toBe("PROPOSAL_DIVERGENT");
    expect(retainCalls()).toHaveLength(0); // never retained, never posted
  });

  test("divergent same-id among several: the divergent id is excluded, its siblings land, the run stays ok (documented C7 policy)", async () => {
    installWeeklyRouter();
    const divergentId = `l4-proposal-${WEEK}-${STAMP}-001`; // the router-tuning id (first in emission order)
    mkdirSync(join(dir, "proposals"), { recursive: true, mode: 0o700 });
    writeFileSync(join(dir, "proposals", `${divergentId}.json`), JSON.stringify({ tampered: true }));
    const result = await runWeeklyReflect(rig());
    expect(result.ok).toBe(true); // ≥1 proposal landed ⇒ the firing is green, divergence reported by fault
    expect(result.receipt.proposals).not.toContain(divergentId);
    expect(result.receipt.proposals).toHaveLength(2);
    expect(result.receipt.posted.every((p) => p.proposal_id !== divergentId)).toBe(true);
    expect(readFileSync(join(dir, "proposals", `${divergentId}.json`), "utf8")).toBe(JSON.stringify({ tampered: true }));
  });

  test("store race (F-002): two concurrent same-firedAt firings with identical payloads both read ok — link-serialized, no duplicates, no divergent", async () => {
    installWeeklyRouter();
    const [a, b] = await Promise.all([runWeeklyReflect(rig()), runWeeklyReflect(rig())]);
    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);
    expect(storeFiles()).toHaveLength(3);
    expect(storeFiles()).toEqual([...new Set(storeFiles())]); // no duplicate rows
    expect(a.receipt.proposals).toEqual(b.receipt.proposals);
    const divergent = events.filter((e) => evName(e) === "weekly-fault" && e.code === "PROPOSAL_DIVERGENT");
    expect(divergent).toEqual([]); // identical bytes ⇒ the loser of the link race keeps the stored row
  });

  test("store race, mixed (F-002): concurrent firings over a pre-seeded divergent row — both drop it, siblings land, stored tamper intact", async () => {
    installWeeklyRouter();
    const divergentId = `l4-proposal-${WEEK}-${STAMP}-001`;
    mkdirSync(join(dir, "proposals"), { recursive: true, mode: 0o700 });
    writeFileSync(join(dir, "proposals", `${divergentId}.json`), JSON.stringify({ tampered: true }));
    const [a, b] = await Promise.all([runWeeklyReflect(rig()), runWeeklyReflect(rig())]);
    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);
    expect(storeFiles()).toHaveLength(3); // the tampered row + the two landed siblings, once each
    expect(readFileSync(join(dir, "proposals", `${divergentId}.json`), "utf8")).toBe(JSON.stringify({ tampered: true }));
    for (const r of [a, b]) expect(r.receipt.proposals).not.toContain(divergentId);
    expect(events.filter((e) => evName(e) === "weekly-fault" && e.code === "PROPOSAL_DIVERGENT")).toHaveLength(2); // one per firing
  });
});

// ─── budgets (C8) ────────────────────────────────────────────────────────────

describe("budgets (C8)", () => {
  test("NaN wallClockBudgetMs ⇒ typed weekly-budget-invalid throw BEFORE any network", async () => {
    installRouter(() => {
      throw new Error("budget validation must precede any network touch");
    });
    const deps = rig({ overrides: { wallClockBudgetMs: Number.NaN } });
    await expect(runWeeklyReflect(deps)).rejects.toMatchObject({ code: "weekly-budget-invalid" });
    expect(calls.length).toBe(0);
  });

  test("budget exhausted ⇒ banks skip fail-loud (reflect_ms ABSENT, never 0) and NO partial posting: nothing stored, retained, or posted", async () => {
    installWeeklyRouter();
    const result = await runWeeklyReflect(rig({ overrides: { wallClockBudgetMs: 1 } }));
    expect(result.ok).toBe(false);
    expect(result.receipt.banks_failed).toHaveLength(3);
    expect(result.receipt.reflect_ms_by_bank).toBeUndefined();
    expect(result.proposals).toEqual([]);
    expect(result.postedTexts).toEqual([]);
    expect(existsSync(join(dir, "proposals"))).toBe(false);
    const runs = events.filter((e) => evName(e) === "reflect-run");
    expect(runs).toHaveLength(3);
    for (const r of runs) expect("reflect_ms" in r).toBe(false);
    const faults = events.filter((e) => evName(e) === "weekly-fault");
    expect(faults.length).toBeGreaterThanOrEqual(1);
    for (const f of faults) expect(f.code).toBe("WEEKLY_BUDGET_EXHAUSTED");
    expect(retainCalls()).toHaveLength(0);
  });

  test("retain-content ceiling: a pathological rationale is capped to ≤4096 bytes on the wire, the stored row keeps its schema ceiling", async () => {
    installWeeklyRouter();
    const longName = "x".repeat(5_000);
    const kpis = join(dir, "kpi-snapshots");
    mkdirSync(kpis, { recursive: true });
    // writer-managed ISO-stamp name (gather's snapshot-name filter keeps only those)
    writeFileSync(join(kpis, "2026-10-05T00-00-01-000Z.json"), JSON.stringify({ kpis: [{ name: longName, value: { status: "measured", value: 1 }, counter: { name: "c", value: 5 } }] }));
    const result = await runWeeklyReflect(rig({ overrides: { kpiSnapshotsDir: kpis } }));
    expect(result.ok).toBe(true);
    for (const c of retainCalls()) {
      const it = at((c.body as { items: Array<Record<string, unknown>> }).items, 0);
      expect(Buffer.byteLength(it.content as string, "utf8")).toBeLessThanOrEqual(RETAIN_CONTENT_BYTE_CEILING);
    }
    const contents = retainCalls().map((c) => at((c.body as { items: Array<Record<string, unknown>> }).items, 0).content as string);
    expect(contents.some((c) => c.length > 4_000)).toBe(true); // the long rationale really rode the wire, capped
    const ts = readStore(at(storeFiles().filter((f) => readStore(f).kind === "threshold-suggestion"), 0));
    expect(ts.rationale.length).toBeLessThanOrEqual(4_000);
  });
});

// ─── typed faults + exit contract (round-1 review fixes) ─────────────────────

describe("typed faults + exit contract (round-1 review fixes)", () => {
  test("F-001 — a failed bank keeps the run red even when its siblings' proposals land (ok = banks_failed empty)", async () => {
    installRouter((_method, url) => {
      if (url.endsWith("/v1/default/banks")) return { body: { banks: FAMILY.map((b) => ({ bank_id: b })) } };
      if (url.endsWith("/reflect")) {
        if (bankOfUrl(url) === FAMILY[2]) return { status: 500, body: {} };
        return { body: { bankId: bankOfUrl(url), insights: [{ summary: "s" }], durationMs: 1 } };
      }
      if (url.endsWith("/memories")) return { body: RETAIN_WIRE };
      return undefined;
    });
    const result = await runWeeklyReflect(rig());
    expect(result.ok).toBe(false); // M3.1 nightly precedent: a failed bank is a red run, never a partial green
    expect(result.receipt.banks_failed).toEqual([at(FAMILY, 2)]);
    expect(result.receipt.banks_ok).toEqual([at(FAMILY, 0), at(FAMILY, 1)]);
    expect(result.receipt.proposals.length).toBeGreaterThanOrEqual(1); // proposals landed, run still red
    const runs = events.filter((e) => evName(e) === "reflect-run" && e.status === "error");
    expect(runs).toHaveLength(1);
  });

  test("F-006 — a corrupt routing line: typed GatherFault with remediation, one weekly-fault event, zero bank work", async () => {
    installRouter(() => {
      throw new Error("a gather fault must precede any network touch");
    });
    const routing = join(dir, "routing-log.jsonl");
    writeFileSync(routing, `not-json\n${ROUTING_LOG_TEXT}\n`); // corrupt NON-tail line
    await expect(
      runWeeklyReflect(rig({ seedInputs: false, overrides: { routingLogPath: routing } })),
    ).rejects.toMatchObject({ code: "routing-log-invalid", remediation: expect.any(String) });
    const faults = events.filter((e) => evName(e) === "weekly-fault");
    expect(faults).toHaveLength(1);
    expect(faults[0]!.code).toBe("routing-log-invalid");
    expect(calls.length).toBe(0);
  });

  test("F-010 — proposalsDir exists as a FILE: typed per-proposal store faults + a parseable receipt, never a raw ENOTDIR", async () => {
    installWeeklyRouter();
    writeFileSync(join(dir, "proposals"), "{}"); // the store path is occupied by a file
    const result = await runWeeklyReflect(rig());
    expect(result.ok).toBe(false);
    expect(result.receipt.superseded).toEqual([]); // ENOTDIR tolerated like ENOENT — typed absence
    const faults = events.filter((e) => evName(e) === "weekly-fault");
    expect(faults).toHaveLength(3);
    for (const f of faults) {
      expect(f.code).toBe("PROPOSAL_STORE_FAILED");
      expect(String(f.message)).not.toContain("ENOTDIR");
      expect(f.remediation).toBeTruthy();
    }
    expect(retainCalls()).toHaveLength(0);
  });

  test("F-018 — an ms-less firedAt via the library seam refuses typed (supersession orders ids lexicographically)", async () => {
    installRouter(() => {
      throw new Error("firedAt validation must precede any network touch");
    });
    await expect(runWeeklyReflect(rig({ overrides: { firedAt: "2026-10-05T06:23:00Z" } })))
      .rejects.toMatchObject({ code: "weekly-fired-at-invalid" });
    expect(calls.length).toBe(0);
  });
});

// ─── CLI driver (scripts/memory-weekly.ts) ───────────────────────────────────

describe("CLI driver (memory-weekly)", () => {
  const cliEnv = (over: Record<string, string> = {}): Record<string, string> => ({
    QDS_MEMORY_WEEKLY_AGENT_TOKEN: "mgat.t.s", HINDSIGHT_BASE_URL: BASE_URL,
    [MEMGATE_ADMIN_KEY]: ADMIN, [QDS_MEMGATE_SIGNING_KEY]: SIGNING, QDS_MEMGATE_LEDGER: ledgerPath(),
    ...over,
  });

  test("env fail-closed FIRST: missing env ⇒ code 2 config-refusal naming every missing var, before any network", async () => {
    installRouter(() => {
      throw new Error("config refusal must precede any network touch");
    });
    const { code, envelope } = await runMemoryWeekly({ env: {} });
    expect(code).toBe(2);
    if (!("missing" in envelope)) throw new Error("expected config-refusal envelope");
    expect(envelope.code).toBe("config-refusal");
    for (const name of ["QDS_MEMORY_WEEKLY_AGENT_TOKEN", "HINDSIGHT_BASE_URL", MEMGATE_ADMIN_KEY, QDS_MEMGATE_SIGNING_KEY, "QDS_MEMGATE_LEDGER"]) {
      expect(envelope.missing).toContain(name);
    }
    expect(calls.length).toBe(0);
  });

  test("a typo'd clock or fired-at seam ⇒ typed seam-invalid refusal (code 2)", async () => {
    const env = cliEnv();
    for (const [seam, name] of [["QDS_WEEKLY_NOW", "QDS_WEEKLY_NOW"], ["QDS_WEEKLY_FIRED_AT", "QDS_WEEKLY_FIRED_AT"]] as const) {
      const { code, envelope } = await runMemoryWeekly({ env: { ...env, [seam]: "not-a-date" } });
      expect(code).toBe(2);
      if (!("seam" in envelope)) throw new Error(`expected seam-invalid envelope for ${name}`);
      expect(envelope.seam).toBe(name);
    }
  });

  test("usage + week refusals: unknown flag and a malformed --week are code 2, never a run", async () => {
    const env = cliEnv();
    const badFlag = await runMemoryWeekly({ env, argv: ["--nope"] });
    expect(badFlag.code).toBe(2);
    if (!("detail" in badFlag.envelope)) throw new Error("expected usage-refusal");
    expect(badFlag.envelope.code).toBe("usage-refusal");
    const badWeek = await runMemoryWeekly({ env, argv: ["--week", "2026-13"] });
    expect(badWeek.code).toBe(2);
    if (!("remediation" in badWeek.envelope) || !("code" in badWeek.envelope)) throw new Error("expected refusal envelope");
    expect(badWeek.envelope.code).toBe("week-invalid");
  });

  test("bank resolution: an unreachable list is code 1 BANK_LIST_UNREACHABLE; a family-less instance is code 2", async () => {
    const env = cliEnv({ QDS_WEEKLY_NOW: "2026-10-05T06:23:00.000Z", QDS_WEEKLY_FIRED_AT: FIRED_AT });
    installRouter((_method, url) => {
      if (url.endsWith("/v1/default/banks")) return { status: 500, body: {} };
      return undefined;
    });
    const unreachable = await runMemoryWeekly({ env });
    expect(unreachable.code).toBe(1);
    if (!("code" in unreachable.envelope)) throw new Error("expected envelope");
    expect(unreachable.envelope.code).toBe("BANK_LIST_UNREACHABLE");

    installWeeklyRouter({ listBanks: { banks: [{ bank_id: "some-other" }] } });
    const noFamily = await runMemoryWeekly({ env });
    expect(noFamily.code).toBe(2);
    if (!("code" in noFamily.envelope)) throw new Error("expected envelope");
    expect(noFamily.envelope.code).toBe("bank-resolution-failed");
  });

  test("F-012 — a bank override naming no family member refuses code 2 here, never as an untyped driver fault", async () => {
    installWeeklyRouter();
    const { code, envelope } = await runMemoryWeekly({
      env: cliEnv({ QDS_WEEKLY_NOW: "2026-10-05T06:23:00.000Z", QDS_WEEKLY_FIRED_AT: FIRED_AT }),
      banks: ["totally-foreign-bank"],
    });
    expect(code).toBe(2);
    if (!("code" in envelope)) throw new Error("expected refusal envelope");
    expect(envelope.code).toBe("bank-resolution-failed");
  });

  test("F-008 — a QDS_WEEKLY_FIRED_AT pinned >5 min ahead refuses seam-invalid (code 2); ≤5 min passes the seam gate", async () => {
    installRouter((_method, url) => {
      if (url.endsWith("/v1/default/banks")) return { status: 500, body: {} }; // reachable-failure past the seam gate
      return undefined;
    });
    const env = cliEnv();
    const far = await runMemoryWeekly({ env: { ...env, QDS_WEEKLY_FIRED_AT: new Date(Date.now() + 10 * 60_000).toISOString() } });
    expect(far.code).toBe(2);
    if (!("seam" in far.envelope)) throw new Error("expected seam-invalid envelope");
    expect(far.envelope.seam).toBe("QDS_WEEKLY_FIRED_AT");
    const near = await runMemoryWeekly({ env: { ...env, QDS_WEEKLY_FIRED_AT: new Date(Date.now() + 4 * 60_000).toISOString() } });
    expect(near.code).toBe(1); // BANK_LIST_UNREACHABLE — it got PAST the fired-at gate to bank resolution
    if (!("code" in near.envelope)) throw new Error("expected envelope");
    expect(near.envelope.code).toBe("BANK_LIST_UNREACHABLE");
  });

  test("F-013 — --help/-h in-process: run() returns 0 and prints usage; the lib parser's process.exit is never reached", async () => {
    installRouter(() => {
      throw new Error("help must answer before any config or network work");
    });
    const out: string[] = [];
    expect(await run(["--help"], (s) => out.push(s))).toBe(0);
    expect(await run(["-h"], (s) => out.push(s))).toBe(0);
    expect(out.join("")).toContain("usage: bun scripts/memory-weekly.ts");
    expect(calls.length).toBe(0); // this test completing at all proves the caller was never killed
  });

  test("F-021 — a repeated --week is a usage-refusal (code 2), never a silent last-win", async () => {
    const { code, envelope } = await runMemoryWeekly({ env: cliEnv(), argv: ["--week", "2026-W41", "--week", "2026-W42"] });
    expect(code).toBe(2);
    if (!("detail" in envelope)) throw new Error("expected usage-refusal envelope");
    expect(envelope.code).toBe("usage-refusal");
    expect(envelope.detail).toContain("--week");
  });
});

// ─── e2e — MANDATORY spawned demo (non-live: loopback shim, no box, no spend) ─

describe("e2e — spawned memory-weekly over a seeded .sandbox (mandatory demo)", () => {
  const CLI = join(process.cwd(), "scripts", "memory-weekly.ts");

  function childEnv(over: Record<string, string> = {}): Record<string, string> {
    const rest: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) {
      if (v === undefined || /^(QDS_|HINDSIGHT_|MEMGATE_)/.test(k) || k === "NODE_ENV") continue; // NODE_ENV=test mutes the child's event JSONL — the cron leg runs unmuted
      rest[k] = v;
    }
    return { ...rest, ...over };
  }

  /** A REAL loopback HTTP server (spawned node — Bun.serve cannot serve a
   * spawned bun peer on this host) speaking the Hindsight wire for exactly
   * the three routes the job drives. Every reflect query + retain body is
   * appended to the capture file as JSONL for post-run assertions. */
  async function startShim(banks: string[], capturePath: string): Promise<{ port: number; stop(): Promise<void> }> {
    const script = `
const http = require("node:http");
const fs = require("node:fs");
const banks = ${JSON.stringify(banks.map((b) => ({ bank_id: b })))};
const capture = ${JSON.stringify(capturePath)};
const lines = [];
const s = http.createServer((q, r) => {
  const chunks = [];
  q.on("data", (c) => chunks.push(c));
  q.on("end", () => {
    const path = q.url.split("?")[0];
    const body = Buffer.concat(chunks).toString("utf8");
    const reply = (obj) => { r.setHeader("content-type", "application/json"); r.end(JSON.stringify(obj)); };
    if (path === "/v1/default/banks") return reply({ banks });
    const m = /\\/v1\\/default\\/banks\\/([^/]+)\\/(reflect|memories)$/.exec(path);
    if (m === null) { r.statusCode = 404; return r.end("unrouted"); }
    if (m[2] === "reflect") {
      lines.push(JSON.stringify({ kind: "reflect", query: JSON.parse(body || "{}").query ?? "" }));
      return reply({ bankId: m[1], insights: [{ summary: "cost per story trending down" }], durationMs: 1 });
    }
    lines.push(JSON.stringify({ kind: "retain", body: JSON.parse(body || "{}") }));
    return reply(${JSON.stringify(RETAIN_WIRE)});
  });
});
const dump = () => { try { fs.writeFileSync(capture, lines.join(String.fromCharCode(10)) + (lines.length > 0 ? String.fromCharCode(10) : "")); } catch {} };
process.on("SIGTERM", () => { dump(); process.exit(0); });
process.on("uncaughtException", () => { dump(); process.exit(0); }); // the CLI child's exit can abort a keep-alive socket mid-idle
s.on("clientError", (err, socket) => { try { socket.end(); } catch {} });
s.listen(0, "127.0.0.1", () => console.log(JSON.stringify({ port: s.address().port })));
`;
    const child = spawn("node", ["-e", script], { stdio: ["ignore", "pipe", "pipe"] });
    const port = await new Promise<number>((res, rej) => {
      const t = setTimeout(() => {
        child.kill("SIGTERM"); // F-027: a rejected handshake must not leak the shim child
        rej(new Error("shim never bound"));
      }, 10_000);
      child.stdout.once("data", (d: Buffer) => {
        clearTimeout(t);
        res(Number(JSON.parse(d.toString().trim()).port));
      });
    });
    // stop(): SIGTERM → the shim dumps its captured lines in ONE write → exit;
    // the capture file is final before this resolves (no read/write race).
    const stopped = new Promise<void>((res) => child.once("exit", () => res()));
    return {
      port,
      stop: () => {
        child.kill("SIGTERM");
        return stopped;
      },
    };
  }

  const OLD_ID = `l4-proposal-${WEEK}-2026-09-28T06-23-00-000Z-001`;

  test("e2e — a misprovisioned host is NOT silent: spawned run with no env exits 2 and the refusal envelope lands on STDERR (self-review round 0 #1)", () => {
    const res = spawnSync(process.execPath, [CLI, "--week", "2026-W41"], {
      env: childEnv(),
      encoding: "utf8",
      timeout: 30_000,
    });
    expect(res.status).toBe(2);
    expect(res.stdout.trim()).toBe(""); // nothing on the crontab carrier
    const lines = res.stderr.trim().split("\n").filter((l) => l.trim().length > 0);
    expect(lines.length).toBeGreaterThan(0);
    const refusals = lines.map((l) => JSON.parse(l) as { code?: string; remediation?: string }).filter((e) => e.code === "config-refusal");
    expect(refusals.length).toBeGreaterThan(0);
    expect(refusals[0]!.remediation).toBeTruthy();
  });

  test("e2e — spawned `bun scripts/memory-weekly.ts --week 2026-W41`: exit 0, one stdout envelope with full texts, 0600 schema-clean store, authoritative + superseded receipt, retains captured, inputs byte-identical", async () => {
    // sandbox (cwd-relative defaults the CLI uses) + an earlier firing's record (superseded proof)
    const sb = join(dir, ".sandbox");
    mkdirSync(sb, { recursive: true, mode: 0o700 });
    writeFileSync(join(sb, "routing-log.jsonl"), `${ROUTING_LOG_TEXT}\n`);
    mkdirSync(join(sb, "kpi-snapshots"), { recursive: true });
    writeFileSync(join(sb, "kpi-snapshots", "2026-10-05T00-00-00-000Z.json"), JSON.stringify(snapshot(3)));
    mkdirSync(join(sb, "runs"), { recursive: true });
    writeFileSync(join(sb, "runs", "qds-20261009-120000.json"), JSON.stringify(RUN_RECORD));
    writeFileSync(join(sb, "runs", "qds-20261010-120000.json"), JSON.stringify(RUN_RECORD));
    mkdirSync(join(sb, "proposals"), { recursive: true, mode: 0o700 });
    writeFileSync(join(sb, "proposals", `${OLD_ID}.json`), JSON.stringify({
      schema: "qds.l4-proposal", proposal_id: OLD_ID, kind: "skill-update", week: WEEK,
      fired_at: "2026-09-28T06:23:00.000Z", target_bank: FAMILY[0], advisory: false,
      rationale: "earlier firing", suggested_change: { area: "skill", summary: "earlier" },
      evidence: { routing_log_refs: [], kpi_snapshot_refs: [], run_record_refs: [] }, insights_cited: [],
      created_at: "2026-09-28T06:23:00.000Z",
    }));
    const inputs = [join(sb, "routing-log.jsonl"), join(sb, "kpi-snapshots"), join(sb, "runs")];
    const before = digestPaths(inputs);

    // the child's gateway opens THIS ledger — the grant row is already in it (the shared-ledger posture)
    const gw = memgateDeps({ env: { [MEMGATE_ADMIN_KEY]: ADMIN, [QDS_MEMGATE_SIGNING_KEY]: SIGNING }, ledgerPath: join(dir, "ledger.db") });
    const token = grantAgentToken(gw, { consumerClass: "host", banks: FAMILY, verbs: ["reflect", "retain"], requestId: "req-e2e" }).token;
    gw.ledger.close();

    const capturePath = join(dir, "shim-capture.jsonl");
    const shim = await startShim(["qds-factory", ...FAMILY], capturePath);
    let res: ReturnType<typeof spawnSync>;
    let envelope: { ok: boolean; receipt: { proposals: string[]; superseded: string[]; absent_sources: unknown[]; posted: Array<{ carrier: string }> }; proposals: Array<{ proposal_id: string; text: string }> };
    try {
      res = spawnSync(process.execPath, [CLI, "--week", WEEK], {
        cwd: dir,
        env: childEnv({
          QDS_MEMORY_WEEKLY_AGENT_TOKEN: token,
          HINDSIGHT_BASE_URL: `http://127.0.0.1:${shim.port}`,
          [MEMGATE_ADMIN_KEY]: ADMIN,
          [QDS_MEMGATE_SIGNING_KEY]: SIGNING,
          QDS_MEMGATE_LEDGER: join(dir, "ledger.db"),
          QDS_WEEKLY_NOW: "2026-10-05T06:23:00.000Z",
          QDS_WEEKLY_FIRED_AT: FIRED_AT,
          NO_PROXY: "127.0.0.1,localhost",
        }),
        timeout: 60_000,
      });
      if (res.status !== 0) throw new Error(`spawned CLI exit=${String(res.status)}\nstdout=${res.stdout.toString().slice(0, 2000)}\nstderr=${res.stderr.toString().slice(0, 4000)}`);
      expect(res.status).toBe(0);
      // ONE stdout envelope carrying every proposal's FULL text
      const lines = res.stdout.toString().split("\n").filter((l) => l.trim() !== "");
      expect(lines).toHaveLength(1);
      envelope = JSON.parse(at(lines, 0)) as typeof envelope;
      expect(envelope.ok).toBe(true);
      expect(envelope.receipt.proposals).toHaveLength(3);
      expect(envelope.receipt.posted.every((p) => p.carrier === "stdout")).toBe(true);
      expect(envelope.receipt.superseded).toEqual([OLD_ID]);
      for (const t of envelope.proposals) expect(t.text).toContain("Nothing is applied automatically");
      // stderr events flowed beside the envelope
      expect(res.stderr.toString()).toContain("weekly-fire");
      expect(res.stderr.toString()).toContain("weekly-complete");
      // store: 3 new records, 0600, schema-clean; the pre-seeded older record intact
      const files = readdirSync(join(sb, "proposals")).sort();
      expect(files).toHaveLength(4);
      for (const f of files.filter((f) => f !== `${OLD_ID}.json`)) {
        expect(statSync(join(sb, "proposals", f)).mode & 0o777).toBe(0o600);
        expect(ProposalSchema.safeParse(JSON.parse(readFileSync(join(sb, "proposals", f), "utf8"))).success).toBe(true);
      }
      // consumed stores byte-identical
      expect(digestPaths(inputs)).toBe(before);
    } finally {
      await shim.stop();
    }
    // retains hit the shim with the upsert identity; reflect queries severity-free
    // (read AFTER stop(): the shim dumps its capture in one write on SIGTERM)
      const captured = readFileSync(capturePath, "utf8")
        .split("\n")
        .filter((l) => l.trim() !== "")
        .map((l) => JSON.parse(l) as { kind: string; query?: string; body?: Record<string, unknown> });
      const retains = captured.filter((c) => c.kind === "retain");
      const queries = captured.filter((c) => c.kind === "reflect").map((c) => c.query ?? "");
      if (retains.length !== 3 || queries.length !== 3) throw new Error(`capture(${captured.length})=${JSON.stringify(captured).slice(0, 2500)}; stderr=${res.stderr.toString().slice(0, 2500)}`);
      expect(retains).toHaveLength(3);
      for (const c of retains) {
        const item = at((c.body as { items: Array<Record<string, unknown>> }).items, 0);
        expect(envelope.receipt.proposals).toContain(item.document_id as string);
        expect(Buffer.byteLength(item.content as string, "utf8")).toBeLessThanOrEqual(RETAIN_CONTENT_BYTE_CEILING);
      }
      expect(queries.length).toBe(3);
      for (const q of queries) expect(/sever/i.test(q)).toBe(false);
  }, 60_000);
});
