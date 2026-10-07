/**
 * M1.3 recall measurement harness — TDD suite (written RED).
 *
 * Mock boundary: a structural FAKE ProbeClient ({recall, listBanks, retain}) —
 * no network anywhere; the real HindsightClient is never constructed because
 * deps.client is always injected. All stores (audit.db, cost ledger, probe
 * set, side channel, evidence dir) are per-test tmpdir fixtures; env paths
 * (C-5) point INSIDE the tmpdir so an accidental default-path open can never
 * resolve at the repo root. The modules under test
 * (scripts/memory/probe-schema.ts, probe-recall.ts, priming-report.ts) do not
 * exist yet — the static imports below fail at load, which IS the red phase.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Database } from "bun:sqlite";

import { canonicalJson, openAuditStore, sha256Hex } from "../../src/audit/link-store.ts";
import { CostLedger } from "../../src/providers/cost-ledger.ts";
import type { RecallRow } from "../../src/hindsight/kg-context.ts";
import { acquireRunLock, releaseRunLock } from "../../scripts/lib/run-lock.ts";
import {
  CANARY_DOCUMENT_ID,
  MAX_PROBE_QUERY_CHARS,
  MIN_PROBE_SET_SIZE,
  PROBE_WRITER_LOCK_ID,
  ProbeSchema,
  SEED_PROBE_BANK,
  checkLabelIntegrity,
  loadP09MintRecords,
  loadReceiptMintRecords,
  parseProbeSet,
  type MintRecords,
  type Probe,
  type ProbeClient,
} from "../../scripts/memory/probe-schema.ts";
import { runProbeRecall } from "../../scripts/memory/probe-recall.ts";
import {
  renderReportMd,
  runPrimingReport,
  type ReportMetrics,
} from "../../scripts/memory/priming-report.ts";

// ---------------------------------------------------------------------------
// Fixtures — tmpdir layout, env discipline (C-5), fake client, seed helpers
// ---------------------------------------------------------------------------

const NOW = new Date("2026-10-07T10:00:00.000Z");

const ENV_KEYS = [
  "QDS_AUDIT_DB",
  "QDS_COST_LEDGER_FILE",
  "QDS_RUNS_DIR",
  "HINDSIGHT_BASE_URL",
  "HINDSIGHT_BEARER_TOKEN",
  "HINDSIGHT_API_KEY",
] as const;

let savedEnv: Record<string, string | undefined> = {};
let dir = "";

beforeEach(() => {
  savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of ENV_KEYS) delete process.env[k];
  dir = mkdtempSync(join(tmpdir(), "qds-m13-probe-"));
  // C-5: env-pointed stores live INSIDE the tmpdir — a stray default-path
  // open resolves into the fixture sandbox, never the repo root.
  process.env.QDS_AUDIT_DB = join(dir, "audit.db");
  process.env.QDS_COST_LEDGER_FILE = join(dir, "cost-ledger.db");
  process.env.QDS_RUNS_DIR = join(dir, "runs");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

// Path layout inside the per-test tmpdir.
const probeSetPath = () => join(dir, "probes", "probe-set.json");
const evidenceDir = () => join(dir, "evidence");
const p09Dir = () => join(dir, "p09");
const recallDir = () => join(dir, "recall");
const reportsDir = () => join(dir, "reports");
const auditPath = () => join(dir, "audit.db");
const ledgerPath = () => join(dir, "cost-ledger.db");

function runId(n: number): string {
  return `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
}

function probe(i: number, over: Partial<Probe> = {}): Probe {
  return {
    probeId: `seed-probe-${i}`,
    query: `probe query ${i}`,
    expectedDocumentIds: [`mulch-doc-${i}`],
    bank: SEED_PROBE_BANK,
    origin: "seed",
    ...over,
  };
}

function makeProbes(n: number): Probe[] {
  return Array.from({ length: n }, (_, i) => probe(i));
}

function at<T>(arr: T[], i: number): T {
  const v = arr[i];
  if (v === undefined) throw new Error(`fixture index ${i} out of range`);
  return v;
}

function writeProbeSet(path: string, probes: Probe[]): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(probes, null, 2));
}

/** P0.9 provision-and-import leg fixture (the mint-record reader contract). */
function writeP09(
  target: string,
  banks: Record<string, string[]>,
  stamp: string,
  ok = true,
): void {
  mkdirSync(target, { recursive: true });
  writeFileSync(
    join(target, `${stamp.replaceAll(":", "-").replaceAll(".", "-")}-p0-9-provision-and-import-fixture.json`),
    JSON.stringify({
      leg: "p0-9-provision-and-import",
      mode: "fixture",
      ok,
      outcome: ok ? "pass" : "leg-failure",
      writtenAt: stamp, // F1: the stamp STRING — the old `at` bound the helper function, which JSON.stringify silently dropped
      mintRecord: Object.fromEntries(
        Object.entries(banks).map(([bank, ids]) => [
          bank,
          { resolvedFrom: "fixture", documentIds: ids },
        ]),
      ),
    }),
  );
}

function rowOf(runIdValue: string, over: Partial<RecallRow> = {}): RecallRow {
  return {
    runId: runIdValue,
    primed: true,
    directive: "kg_context",
    banks: [SEED_PROBE_BANK],
    recalledDocumentIds: [],
    chars: 1200,
    latencyMs: 100,
    ...over,
  };
}

function writeRecallRow(rowDir: string, fileName: string, row: RecallRow): void {
  mkdirSync(rowDir, { recursive: true });
  writeFileSync(join(rowDir, fileName), `${JSON.stringify(row)}\n`);
}

/** Seed memory-retain-receipt rows via the real audit store (R2 §5). */
function seedReceipt(path: string, runIdValue: string, bank = SEED_PROBE_BANK, subjectId = runIdValue): void {
  const store = openAuditStore(path);
  try {
    store.record({
      runId: runIdValue,
      repoSlug: "test/repo",
      requestId: runIdValue,
      hop: "memory-retain-receipt",
      event: "retain",
      subjectId,
      subjectKind: "document",
      evidenceDigest: sha256Hex(
        canonicalJson({ bank, documentId: runIdValue, contentDigest: "fixture" }),
      ),
      detail: { bank, documentId: runIdValue },
      occurredAt: "2026-10-07T00:00:00.000Z",
      recordedAt: "2026-10-07T00:00:00.000Z",
    });
  } finally {
    store.close();
  }
}

/** Seed exact cost_events rows via a writable open, then leave it closed. */
function seedLedger(path: string, rows: { runId: string; microUsd: number; unpriced?: number }[]): void {
  const writer = new CostLedger({ path, readRunRecord: () => undefined });
  writer.close();
  const db = new Database(path);
  try {
    rows.forEach((r, i) => {
      db.prepare(
        `INSERT INTO cost_events (event_id, run_id, repo_slug, issue_id, request_id,
           role, agent_id, provider, model, kind, invocation_seq, input_tokens,
           output_tokens, cache_read_tokens, cache_write_tokens, turn_count,
           cost_micro_usd, unpriced, key_hash, key_limit_micro_usd, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        `ev-${i}`,
        r.runId,
        "test/repo",
        "1",
        `req-${i}`,
        "lead",
        null,
        null,
        "test/model",
        "tokens",
        0,
        10,
        5,
        0,
        0,
        1,
        r.microUsd,
        r.unpriced ?? 0,
        null,
        null,
        "2026-10-07T00:00:00.000Z",
      );
    });
  } finally {
    db.close();
  }
}

interface CannedResult {
  memoryId: string;
  content: string;
  score: number;
  documentId: string | null;
}
interface RecallRecord {
  bankId: string;
  query: string;
  limit?: number;
}
interface RetainRecord {
  bankId: string;
  content: string;
  metadata?: Record<string, unknown>;
}

function resultOf(documentId: string | null, i: number): CannedResult {
  return { memoryId: `mem-${i}`, content: `content ${i}`, score: 1 - i * 0.1, documentId };
}
function canned(...docIds: (string | null)[]): CannedResult[] {
  return docIds.map(resultOf);
}

/**
 * Deterministic fake ProbeClient: canned recall results keyed by
 * (bank, query); any query NOT in the canned map is treated as the canary
 * query and served a qds-canary hit unless `canaryHits` is false. Retain
 * records the call and returns a RetainResponse-shaped created receipt.
 */
function fakeProbeClient(
  opts: {
    banks?: unknown;
    canned?: Map<string, { results: CannedResult[]; durationMs?: number }>;
    canaryHits?: boolean;
    /** R2-006: the canary recall RESOLVES with this (possibly malformed) payload. */
    canaryResults?: unknown;
    /** F-002: listBanks itself rejects (endpoint down). */
    listBanksThrows?: string;
    /** F-001: recall rejects only for this query — mid-scoring traffic failure. */
    recallThrowsOnQuery?: string;
  } = {},
): { client: ProbeClient; recalls: RecallRecord[]; retains: RetainRecord[] } {
  const recalls: RecallRecord[] = [];
  const retains: RetainRecord[] = [];
  const raw = {
    listBanks: async () => {
      if (opts.listBanksThrows !== undefined) throw new Error(opts.listBanksThrows);
      return opts.banks ?? { banks: [{ bank_id: SEED_PROBE_BANK }] };
    },
    recall: async (bankId: string, query: string, limit?: number) => {
      recalls.push({ bankId, query, limit });
      if (opts.recallThrowsOnQuery !== undefined && query === opts.recallThrowsOnQuery) {
        throw new Error(`HTTP 502: recall upstream failed for ${bankId}`);
      }
      const hit = opts.canned?.get(`${bankId}\u0000${query}`);
      if (hit) return { results: hit.results, durationMs: hit.durationMs ?? 5 };
      return {
        results:
          opts.canaryResults !== undefined
            ? opts.canaryResults
            : opts.canaryHits === false
              ? []
              : [
                  {
                    memoryId: "canary-1",
                    content: "canary self-hit",
                    score: 1,
                    documentId: CANARY_DOCUMENT_ID,
                  },
                ],
        durationMs: 2,
      };
    },
    retain: async (bankId: string, content: string, metadata?: Record<string, unknown>) => {
      retains.push({ bankId, content, metadata });
      return {
        memoryId: `mem-retain-${retains.length}`,
        bankId,
        status: "created" as const,
        durationMs: 0,
      };
    },
  };
  return { client: raw as unknown as ProbeClient, recalls, retains };
}

function cannedKey(p: Probe): string {
  return `${p.bank}\u0000${p.query}`;
}

function baseRecallDeps(client: ProbeClient) {
  return {
    client,
    probeSetPath: probeSetPath(),
    evidenceDir: evidenceDir(),
    p09EvidenceDir: p09Dir(),
    now: () => NOW,
  };
}

function baseReportDeps() {
  return {
    recallDir: recallDir(),
    ledgerPath: ledgerPath(),
    auditPath: auditPath(),
    reportsDir: reportsDir(),
    probeSetPath: probeSetPath(),
    p09EvidenceDir: p09Dir(),
    now: () => NOW,
  };
}

function filesIn(target: string): string[] {
  return existsSync(target) ? readdirSync(target) : [];
}

/** F-018: artifact names carry a random suffix — contains-match, never endsWith. */
function readArtifact(target: string, marker: string): string | undefined {
  return filesIn(target).find((n) => n.includes(marker));
}

/** One call to the label-integrity gate with a fake listBanks client. */
async function checkLabels(
  banks: unknown,
  p: Probe,
  mint: MintRecords,
): Promise<{ ok: boolean; violations: { probeId: string; reason: string }[]; checkedProbes: number }> {
  const { client } = fakeProbeClient({ banks });
  return checkLabelIntegrity([p], { client, mint });
}

// ---------------------------------------------------------------------------
// probe-schema
// ---------------------------------------------------------------------------

describe("probe-schema", () => {
  test("ProbeSchema accepts a well-formed probe", () => {
    const p = probe(0);
    expect(ProbeSchema.parse(p)).toEqual(p);
  });

  test("ProbeSchema rejects an empty query", () => {
    expect(ProbeSchema.safeParse(probe(0, { query: "" })).success).toBe(false);
  });

  test("ProbeSchema rejects a query over MAX_PROBE_QUERY_CHARS and accepts the boundary", () => {
    expect(
      ProbeSchema.safeParse(probe(0, { query: "q".repeat(MAX_PROBE_QUERY_CHARS + 1) })).success,
    ).toBe(false);
    expect(
      ProbeSchema.safeParse(probe(0, { query: "q".repeat(MAX_PROBE_QUERY_CHARS) })).success,
    ).toBe(true);
  });

  test("ProbeSchema rejects empty expectedDocumentIds", () => {
    expect(ProbeSchema.safeParse(probe(0, { expectedDocumentIds: [] })).success).toBe(false);
  });

  test("parseProbeSet accepts a unique probe set", () => {
    const probes = makeProbes(3);
    const res = parseProbeSet(probes);
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.value).toEqual(probes);
  });

  test("parseProbeSet rejects duplicate probeIds", () => {
    const res = parseProbeSet([probe(0), probe(0, { query: "other phrasing" })]);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.length).toBeGreaterThan(0);
  });

  test("loadP09MintRecords reads ok:true mint records per bank", () => {
    writeP09(p09Dir(), { [SEED_PROBE_BANK]: ["mulch-aaa", "mulch-bbb"] }, "2026-10-07T10:00:00.000Z");
    const mint = loadP09MintRecords(p09Dir());
    expect([...(mint.get(SEED_PROBE_BANK) ?? [])].sort()).toEqual(["mulch-aaa", "mulch-bbb"]);
  });

  test("loadP09MintRecords: latest writtenAt wins per bank", () => {
    writeP09(p09Dir(), { [SEED_PROBE_BANK]: ["mulch-old"] }, "2026-10-07T10:00:00.000Z");
    writeP09(p09Dir(), { [SEED_PROBE_BANK]: ["mulch-new"] }, "2026-10-07T11:00:00.000Z");
    const mint = loadP09MintRecords(p09Dir());
    expect([...(mint.get(SEED_PROBE_BANK) ?? [])]).toEqual(["mulch-new"]);
  });

  test("loadP09MintRecords: identical writtenAt → lexicographically-LATER filename wins (tie path, F1)", () => {
    // writeP09 derives the filename from the stamp, so a same-stamp tie needs
    // hand-named files — identical writtenAt, different names, same bank.
    mkdirSync(p09Dir(), { recursive: true });
    const body = (ids: string[]) =>
      JSON.stringify({
        leg: "p0-9-provision-and-import",
        mode: "fixture",
        ok: true,
        outcome: "pass",
        writtenAt: "2026-10-07T10:00:00.000Z",
        mintRecord: { [SEED_PROBE_BANK]: { resolvedFrom: "fixture", documentIds: ids } },
      });
    writeFileSync(join(p09Dir(), "aaa-earlier-name-p0-9-provision-and-import-fixture.json"), body(["mulch-from-aaa"]));
    writeFileSync(join(p09Dir(), "zzz-later-name-p0-9-provision-and-import-fixture.json"), body(["mulch-from-zzz"]));
    const mint = loadP09MintRecords(p09Dir());
    expect([...(mint.get(SEED_PROBE_BANK) ?? [])]).toEqual(["mulch-from-zzz"]);
  });

  test("loadP09MintRecords ignores ok:false records", () => {
    writeP09(p09Dir(), { [SEED_PROBE_BANK]: ["mulch-bad"] }, "2026-10-07T10:00:00.000Z", false);
    writeP09(p09Dir(), { [SEED_PROBE_BANK]: ["mulch-good"] }, "2026-10-07T11:00:00.000Z");
    const mint = loadP09MintRecords(p09Dir());
    expect([...(mint.get(SEED_PROBE_BANK) ?? [])]).toEqual(["mulch-good"]);
  });

  test("loadP09MintRecords: absent dir yields an empty map", () => {
    const mint = loadP09MintRecords(join(dir, "does-not-exist"));
    expect(mint.size).toBe(0);
  });

  test("loadReceiptMintRecords maps bank from detail_json and doc from subject_id", () => {
    seedReceipt(auditPath(), runId(1));
    seedReceipt(auditPath(), runId(2));
    seedReceipt(auditPath(), runId(3), "other-bank");
    const mint = loadReceiptMintRecords(auditPath());
    expect(mint.get(SEED_PROBE_BANK)?.has(runId(1))).toBe(true);
    expect(mint.get(SEED_PROBE_BANK)?.has(runId(2))).toBe(true);
    expect(mint.get("other-bank")?.has(runId(3))).toBe(true);
  });

  test("loadReceiptMintRecords: absent audit file stays absent, empty map (readonly posture)", () => {
    const absent = join(dir, "absent.db");
    const mint = loadReceiptMintRecords(absent);
    expect(mint.size).toBe(0);
    expect(existsSync(absent)).toBe(false);
  });

  test("checkLabelIntegrity accepts bank existence in both listBanks envelope shapes", async () => {
    const p = probe(0);
    const mint: MintRecords = new Map([[SEED_PROBE_BANK, new Set(["mulch-doc-0"])]]);
    const bare = await checkLabels([{ bank_id: SEED_PROBE_BANK }], p, mint);
    expect(bare.ok).toBe(true);
    expect(bare.violations).toEqual([]);
    expect(bare.checkedProbes).toBe(1);
    const wrapped = await checkLabels({ banks: [{ bank_id: SEED_PROBE_BANK }] }, p, mint);
    expect(wrapped.ok).toBe(true);
    expect(wrapped.violations).toEqual([]);
  });

  test("checkLabelIntegrity flags a phantom expected id, naming the probeId", async () => {
    const p = probe(0);
    const mint: MintRecords = new Map([[SEED_PROBE_BANK, new Set(["mulch-other"])]]);
    const res = await checkLabels({ banks: [{ bank_id: SEED_PROBE_BANK }] }, p, mint);
    expect(res.ok).toBe(false);
    expect(res.violations.map((v) => v.probeId)).toContain("seed-probe-0");
  });

  test("checkLabelIntegrity flags a cross-bank minted id (wrong-bank pair = phantom class)", async () => {
    const p = probe(0);
    // mulch-doc-0 exists — but minted into a DIFFERENT bank than probe.bank.
    const mint: MintRecords = new Map([["other-bank", new Set(["mulch-doc-0"])]]);
    const res = await checkLabels({ banks: [{ bank_id: SEED_PROBE_BANK }] }, p, mint);
    expect(res.ok).toBe(false);
    expect(res.violations.map((v) => v.probeId)).toContain("seed-probe-0");
  });

  test("checkLabelIntegrity flags a probe whose bank is absent from listBanks", async () => {
    const p = probe(0);
    const mint: MintRecords = new Map([[SEED_PROBE_BANK, new Set(["mulch-doc-0"])]]);
    const res = await checkLabels({ banks: [{ bank_id: "unrelated-bank" }] }, p, mint);
    expect(res.ok).toBe(false);
    expect(res.violations.map((v) => v.probeId)).toContain("seed-probe-0");
  });
});

// ---------------------------------------------------------------------------
// probe-recall
// ---------------------------------------------------------------------------

describe("probe-recall", () => {
  test("scores hits with 1-based rank of the first expected documentId (hit-rate math)", async () => {
    const probes = [
      probe(0), // hit at rank 1
      probe(1), // hit at rank 3
      probe(2), // hit at rank 5
      probe(3), // miss
    ];
    writeProbeSet(probeSetPath(), probes);
    writeP09(
      p09Dir(),
      // All four probe labels minted — AC1's letter: an absent-from-mint id
      // must fail validation, never score as a miss. Rank-math fixture mints
      // every probe's expected id (driver ruling rev 5).
      { [SEED_PROBE_BANK]: ["mulch-doc-0", "mulch-doc-1", "mulch-doc-2", "mulch-doc-3"] },
      "2026-10-07T10:00:00.000Z",
    );
    const cannedMap = new Map<string, { results: CannedResult[]; durationMs?: number }>();
    cannedMap.set(cannedKey(at(probes, 0)), { results: canned("mulch-doc-0") });
    cannedMap.set(cannedKey(at(probes, 1)), {
      results: canned("mulch-filler-1a", "mulch-filler-1b", "mulch-doc-1"),
    });
    cannedMap.set(cannedKey(at(probes, 2)), {
      results: canned("mulch-filler-2a", "mulch-filler-2b", "mulch-filler-2c", "mulch-filler-2d", "mulch-doc-2"),
    });
    cannedMap.set(cannedKey(at(probes, 3)), {
      results: canned("mulch-filler-3a", "mulch-filler-3b", "mulch-filler-3c", "mulch-filler-3d", "mulch-filler-3e"),
    });
    const { client } = fakeProbeClient({ canned: cannedMap });

    const res = await runProbeRecall(baseRecallDeps(client));
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const { metrics } = res;
    const byId = (id: string) => metrics.perProbe.find((p) => p.probeId === id);
    expect(byId("seed-probe-0")?.hit).toBe(true);
    expect(byId("seed-probe-0")?.rank).toBe(1);
    expect(byId("seed-probe-1")?.hit).toBe(true);
    expect(byId("seed-probe-1")?.rank).toBe(3);
    expect(byId("seed-probe-2")?.rank).toBe(5);
    expect(byId("seed-probe-3")?.hit).toBe(false);
    const missRank = byId("seed-probe-3")?.rank;
    expect(missRank === null || missRank === undefined).toBe(true);
    expect(metrics.aggregate.probes).toBe(4);
    expect(metrics.aggregate.hits).toBe(3);
    // F-003: below the 20-probe floor the rate is WITHHELD — absent, not 0.
    expect("hitRateAt5" in metrics.aggregate).toBe(false);
    expect(metrics.aggregate.belowFloor).toBe(true);
  });

  test("a probe matching nothing expected misses", async () => {
    const probes = [probe(0)];
    writeProbeSet(probeSetPath(), probes);
    writeP09(p09Dir(), { [SEED_PROBE_BANK]: ["mulch-doc-0"] }, "2026-10-07T10:00:00.000Z");
    const cannedMap = new Map<string, { results: CannedResult[] }>();
    cannedMap.set(cannedKey(at(probes, 0)), {
      results: canned("mulch-x1", "mulch-x2", "mulch-x3", "mulch-x4", "mulch-x5"),
    });
    const { client } = fakeProbeClient({ canned: cannedMap });

    const res = await runProbeRecall(baseRecallDeps(client));
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.metrics.aggregate.hits).toBe(0);
    expect(res.metrics.perProbe[0]?.hit).toBe(false);
  });

  test("null documentId results never match an expected id", async () => {
    const probes = [probe(0)];
    writeProbeSet(probeSetPath(), probes);
    writeP09(p09Dir(), { [SEED_PROBE_BANK]: ["mulch-doc-0"] }, "2026-10-07T10:00:00.000Z");
    const cannedMap = new Map<string, { results: CannedResult[] }>();
    cannedMap.set(cannedKey(at(probes, 0)), {
      results: canned(null, "mulch-filler", null, "mulch-filler", null),
    });
    const { client } = fakeProbeClient({ canned: cannedMap });

    const res = await runProbeRecall(baseRecallDeps(client));
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.metrics.perProbe[0]?.hit).toBe(false);
  });

  test("recalls with k=5: an expected id at position 6 does not hit", async () => {
    const probes = [probe(0)];
    writeProbeSet(probeSetPath(), probes);
    writeP09(p09Dir(), { [SEED_PROBE_BANK]: ["mulch-doc-0"] }, "2026-10-07T10:00:00.000Z");
    const cannedMap = new Map<string, { results: CannedResult[] }>();
    cannedMap.set(cannedKey(at(probes, 0)), {
      results: canned("mulch-f1", "mulch-f2", "mulch-f3", "mulch-f4", "mulch-f5", "mulch-doc-0"),
    });
    const { client, recalls } = fakeProbeClient({ canned: cannedMap });

    const res = await runProbeRecall(baseRecallDeps(client));
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const probeCall = recalls.find((r) => r.query === at(probes, 0).query);
    expect(probeCall?.limit).toBe(5);
    expect(res.metrics.perProbe[0]?.hit).toBe(false);
  });

  test("canary retains + recalls BEFORE scoring and is excluded from the aggregate", async () => {
    const probes = [probe(0), probe(1)];
    writeProbeSet(probeSetPath(), probes);
    writeP09(
      p09Dir(),
      { [SEED_PROBE_BANK]: ["mulch-doc-0", "mulch-doc-1"] },
      "2026-10-07T10:00:00.000Z",
    );
    const cannedMap = new Map<string, { results: CannedResult[] }>();
    cannedMap.set(cannedKey(at(probes, 0)), { results: canned("mulch-doc-0") });
    cannedMap.set(cannedKey(at(probes, 1)), { results: canned("mulch-doc-1") });
    const { client, recalls, retains } = fakeProbeClient({ canned: cannedMap });

    const res = await runProbeRecall(baseRecallDeps(client));
    expect(res.ok).toBe(true);
    if (!res.ok) return;

    // The canary recall is the call whose query is NOT a probe-set query, and
    // it must be the FIRST recall (gates before scoring).
    const probeQueries = new Set(probes.map((p) => p.query));
    expect(recalls.length).toBeGreaterThan(0);
    expect(probeQueries.has(recalls[0]?.query ?? "")).toBe(false);

    // Exactly one retain: the self-hit canary into the seeded probe bank.
    expect(retains.length).toBe(1);
    expect(retains[0]?.bankId).toBe(SEED_PROBE_BANK);
    const md = (retains[0]?.metadata ?? {}) as Record<string, unknown>;
    expect(md.documentId).toBe(CANARY_DOCUMENT_ID);
    expect(md.updateMode).toBe("replace");
    expect(Array.isArray(md.tags) && (md.tags as string[]).includes("qds-canary")).toBe(true);

    // Canary gates, never scores.
    expect(res.metrics.aggregate.probes).toBe(2);
    expect(res.metrics.perProbe.length).toBe(2);
    expect(res.metrics.canary.hit).toBe(true);
    expect(res.metrics.canary.documentId).toBe(CANARY_DOCUMENT_ID);
    expect(res.metrics.canary.bank).toBe(SEED_PROBE_BANK);
  });

  test("canary retain ERROR refuses at the canary stage: no crash, no hit-rate artifact, diagnostic carries the error", async () => {
    const probes = [probe(0)];
    writeProbeSet(probeSetPath(), probes);
    writeP09(p09Dir(), { [SEED_PROBE_BANK]: ["mulch-doc-0"] }, "2026-10-07T10:00:00.000Z");
    const { client, recalls } = fakeProbeClient({});
    // The canary retain throws (upstream extraction failure / network / 402).
    const throwing = {
      ...client,
      retain: async () => {
        throw new Error("HTTP 500: Fact extraction failed (402 upstream)");
      },
    } as unknown as ProbeClient;

    const res = await runProbeRecall(baseRecallDeps(throwing));
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.stage).toBe("canary");
    expect(/402|extraction/i.test(res.reason)).toBe(true);
    expect(/-canary-failure-[a-z0-9]{6}\.json$/.test(res.diagnosticPath ?? "")).toBe(true);
    const diagName = readArtifact(evidenceDir(), "-canary-failure-");
    expect(diagName).toBeDefined();
    const diag = JSON.parse(readFileSync(join(evidenceDir(), diagName ?? ""), "utf8")) as Record<string, unknown>;
    expect(typeof diag.error).toBe("string");
    // No scoring happened: the retain threw before any recall.
    expect(recalls.length).toBe(0);
    expect(readArtifact(evidenceDir(), "-hit-rate-")).toBeUndefined();
  });

  test("a malformed canary RESOLVE (results not an array) refuses at the canary stage, inside the try (R2-006)", async () => {
    const probes = [probe(0)];
    writeProbeSet(probeSetPath(), probes);
    writeP09(p09Dir(), { [SEED_PROBE_BANK]: ["mulch-doc-0"] }, "2026-10-07T10:00:00.000Z");
    const { client } = fakeProbeClient({ canaryResults: 5 }); // resolves malformed, does not reject

    const res = await runProbeRecall(baseRecallDeps(client));
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.stage).toBe("canary");
    expect(/malformed canary recall envelope: results not an array/.test(res.reason)).toBe(true);
    expect(/-canary-failure-[a-z0-9]{6}\.json$/.test(res.diagnosticPath ?? "")).toBe(true);
    const diagName = readArtifact(evidenceDir(), "-canary-failure-");
    expect(diagName).toBeDefined();
    const diag = JSON.parse(readFileSync(join(evidenceDir(), diagName ?? ""), "utf8")) as Record<string, unknown>;
    expect(/malformed canary recall envelope/.test(String(diag.error))).toBe(true);
    expect(readArtifact(evidenceDir(), "-hit-rate-")).toBeUndefined();
  });

  test("canary results with null/primitive elements: non-matching noise, not a crash — the real hit still gates open (R2-006)", async () => {
    const probes = [probe(0)];
    writeProbeSet(probeSetPath(), probes);
    writeP09(p09Dir(), { [SEED_PROBE_BANK]: ["mulch-doc-0"] }, "2026-10-07T10:00:00.000Z");
    const { client } = fakeProbeClient({
      canaryResults: [null, "junk", { memoryId: "m", content: "c", score: 1, documentId: CANARY_DOCUMENT_ID }],
    });

    const res = await runProbeRecall(baseRecallDeps(client));
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.metrics.canary.hit).toBe(true);
  });

  test("canary miss refuses: stage canary, hit-rate withheld, canary-failure diagnostic written", async () => {
    const probes = [probe(0)];
    writeProbeSet(probeSetPath(), probes);
    writeP09(p09Dir(), { [SEED_PROBE_BANK]: ["mulch-doc-0"] }, "2026-10-07T10:00:00.000Z");
    const cannedMap = new Map<string, { results: CannedResult[] }>();
    cannedMap.set(cannedKey(at(probes, 0)), { results: canned("mulch-doc-0") });
    const { client } = fakeProbeClient({ canned: cannedMap, canaryHits: false });

    const res = await runProbeRecall(baseRecallDeps(client));
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.stage).toBe("canary");
    expect(/-canary-failure-[a-z0-9]{6}\.json$/.test(res.diagnosticPath ?? "")).toBe(true);

    const diagName = readArtifact(evidenceDir(), "-canary-failure-");
    expect(diagName).toBeDefined();
    const diag = JSON.parse(
      readFileSync(join(evidenceDir(), diagName ?? ""), "utf8"),
    ) as Record<string, unknown>;
    expect(diag.bank).toBe(SEED_PROBE_BANK);
    expect(diag.documentId).toBe(CANARY_DOCUMENT_ID);
    expect(typeof diag.query).toBe("string");
    expect(Array.isArray(diag.recallTail)).toBe(true);

    // The hit-rate evidence JSON is WITHHELD — never a legitimate-looking 0.0.
    expect(readArtifact(evidenceDir(), "-hit-rate-")).toBeUndefined();
  });

  test("canary refusal with an UNCREATABLE evidence dir still returns the contracted refusal (E1): reason notes the diagnostic write failure, diagnosticPath omitted", async () => {
    const probes = [probe(0)];
    writeProbeSet(probeSetPath(), probes);
    writeP09(p09Dir(), { [SEED_PROBE_BANK]: ["mulch-doc-0"] }, "2026-10-07T10:00:00.000Z");
    // A FILE where the evidence dir's parent should be → mkdirSync ENOTDIR.
    // Pre-E1 the mkdir threw PAST the canary refusal (generic crash); the
    // refusal contract must survive any diagnostic-persistence failure.
    writeFileSync(join(dir, "blocker"), "{}\n");
    const { client } = fakeProbeClient({ canaryHits: false });

    const res = await runProbeRecall({
      ...baseRecallDeps(client),
      evidenceDir: join(dir, "blocker", "evidence"),
    });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.stage).toBe("canary");
    expect(/did not surface in the top-5/.test(res.reason)).toBe(true);
    expect(/diagnostic write failed/.test(res.reason)).toBe(true);
    expect(res.diagnosticPath).toBeUndefined();
  });

  test("label-integrity failure refuses before any client traffic, naming the offending probeId", async () => {
    const probes = [probe(0), probe(1)];
    writeProbeSet(probeSetPath(), probes);
    // No mint fixture in evidenceDir: every expected id is phantom-class.

    const { client, recalls, retains } = fakeProbeClient({});
    const res = await runProbeRecall(baseRecallDeps(client));

    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.stage).toBe("label-integrity");
    expect(res.violations?.map((v) => v.probeId)).toContain("seed-probe-0");
    expect(res.violations?.map((v) => v.probeId)).toContain("seed-probe-1");

    // Nothing ran: no retain, no recall, no artifacts at all.
    expect(retains.length).toBe(0);
    expect(recalls.length).toBe(0);
    expect(filesIn(evidenceDir()).length).toBe(0);
  });

  test("happy path writes the hit-rate artifact with the contracted shape", async () => {
    const probes = makeProbes(20); // exactly the floor: median must be emitted
    writeProbeSet(probeSetPath(), probes);
    writeP09(
      p09Dir(),
      { [SEED_PROBE_BANK]: probes.flatMap((p) => p.expectedDocumentIds) },
      "2026-10-07T10:00:00.000Z",
    );
    const cannedMap = new Map<string, { results: CannedResult[] }>();
    for (const p of probes) {
      cannedMap.set(cannedKey(p), { results: canned(p.expectedDocumentIds[0] ?? null) });
    }
    const { client } = fakeProbeClient({ canned: cannedMap });

    const res = await runProbeRecall(baseRecallDeps(client));
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    // F-018: stamp + random suffix — same-millisecond runs never overwrite.
    expect(/-hit-rate-[a-z0-9]{6}\.json$/.test(res.artifactPath)).toBe(true);

    const name = readArtifact(evidenceDir(), "-hit-rate-");
    expect(name).toBeDefined();
    const artifact = JSON.parse(
      readFileSync(join(evidenceDir(), name ?? ""), "utf8"),
    ) as Record<string, unknown>;
    expect(typeof artifact.writtenAt).toBe("string");
    expect(artifact.labelIntegrity).toBe("pass");
    const aggregate = artifact.aggregate as Record<string, unknown>;
    expect(aggregate.probes).toBe(20);
    expect(aggregate.hits).toBe(20);
    expect(aggregate.hitRateAt5).toBe(1);
    expect(typeof aggregate.medianRecallMs).toBe("number");
    expect("belowFloor" in aggregate).toBe(false);
    expect(aggregate.bankBreakdown).toBeTypeOf("object");
    expect(SEED_PROBE_BANK in (aggregate.bankBreakdown as object)).toBe(true);
    // F-012: origin split always present — this set is all-seed.
    expect(aggregate.byOrigin).toEqual({ seed: { probes: 20, hits: 20 }, cycle: { probes: 0, hits: 0 } });
    const canary = artifact.canary as Record<string, unknown>;
    expect(canary.hit).toBe(true);
    expect(canary.documentId).toBe(CANARY_DOCUMENT_ID);
  });

  test("below MIN_PROBE_SET_SIZE: belowFloor true and no medianRecallMs", async () => {
    const probes = makeProbes(3);
    expect(probes.length).toBeLessThan(MIN_PROBE_SET_SIZE);
    writeProbeSet(probeSetPath(), probes);
    writeP09(
      p09Dir(),
      { [SEED_PROBE_BANK]: probes.flatMap((p) => p.expectedDocumentIds) },
      "2026-10-07T10:00:00.000Z",
    );
    const cannedMap = new Map<string, { results: CannedResult[] }>();
    for (const p of probes) {
      cannedMap.set(cannedKey(p), { results: canned(p.expectedDocumentIds[0] ?? null) });
    }
    const { client } = fakeProbeClient({ canned: cannedMap });

    const res = await runProbeRecall(baseRecallDeps(client));
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.metrics.aggregate.belowFloor).toBe(true);
    expect("medianRecallMs" in res.metrics.aggregate).toBe(false);
  });

  test("medianRecallMs is computed from per-probe recall durations, hitRateAt5 emitted at the floor (odd count)", async () => {
    const probes = makeProbes(21);
    writeProbeSet(probeSetPath(), probes);
    writeP09(
      p09Dir(),
      { [SEED_PROBE_BANK]: probes.flatMap((p) => p.expectedDocumentIds) },
      "2026-10-07T10:00:00.000Z",
    );
    const cannedMap = new Map<string, { results: CannedResult[]; durationMs?: number }>();
    probes.forEach((p, i) => {
      if (i % 4 === 3) {
        // 5 misses (indices 3,7,11,15,19) → 16/21 — a rate that is neither 0 nor 1.
        cannedMap.set(cannedKey(p), {
          results: canned("f1", "f2", "f3", "f4", "f5"),
          durationMs: 10 * (i + 1),
        });
        return;
      }
      cannedMap.set(cannedKey(p), {
        results: canned(p.expectedDocumentIds[0] ?? null),
        durationMs: 10 * (i + 1), // 10..210, distinct
      });
    });
    const { client } = fakeProbeClient({ canned: cannedMap });

    const res = await runProbeRecall(baseRecallDeps(client));
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const byId = res.metrics.perProbe.find((p) => p.probeId === "seed-probe-12");
    expect(byId?.recallMs).toBe(130);
    const sorted = res.metrics.perProbe.map((p) => p.recallMs).sort((a, b) => a - b);
    expect(sorted[10]).toBe(110);
    expect(res.metrics.aggregate.medianRecallMs).toBe(sorted[10]);
    // At/above the floor the rate is emitted and correct (F-003 math pin,
    // moved here from the sub-floor fixture where it must stay withheld).
    expect(res.metrics.aggregate.belowFloor).toBeUndefined();
    expect(Math.abs((res.metrics.aggregate.hitRateAt5 ?? -1) - 16 / 21)).toBeLessThan(1e-9);
  });

  test("a recall rejection mid-scoring refuses at stage scoring: no artifact (F-001)", async () => {
    const probes = [probe(0), probe(1)];
    writeProbeSet(probeSetPath(), probes);
    writeP09(
      p09Dir(),
      { [SEED_PROBE_BANK]: ["mulch-doc-0", "mulch-doc-1"] },
      "2026-10-07T10:00:00.000Z",
    );
    const cannedMap = new Map<string, { results: CannedResult[] }>();
    cannedMap.set(cannedKey(at(probes, 0)), { results: canned("mulch-doc-0") });
    const { client } = fakeProbeClient({
      canned: cannedMap,
      recallThrowsOnQuery: at(probes, 1).query, // probe 0 scores, probe 1 throws
    });

    const res = await runProbeRecall(baseRecallDeps(client));
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.stage).toBe("scoring");
    expect(/scoring failed/i.test(res.reason)).toBe(true);
    // An unmeasured run never leaves a score behind.
    expect(readArtifact(evidenceDir(), "-hit-rate-")).toBeUndefined();
  });

  test("a listBanks rejection is a label-integrity refusal under the reserved <listBanks> probeId (F-002)", async () => {
    const probes = [probe(0)];
    writeProbeSet(probeSetPath(), probes);
    writeP09(p09Dir(), { [SEED_PROBE_BANK]: ["mulch-doc-0"] }, "2026-10-07T10:00:00.000Z");
    const { client, recalls, retains } = fakeProbeClient({ listBanksThrows: "HTTP 503 upstream" });

    const res = await runProbeRecall(baseRecallDeps(client));
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.stage).toBe("label-integrity");
    expect(res.violations?.map((v) => v.probeId)).toEqual(["<listBanks>"]);
    expect(/listBanks failed/.test(res.violations?.[0]?.reason ?? "")).toBe(true);
    // No traffic beyond the failed listing itself.
    expect(recalls.length).toBe(0);
    expect(retains.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// priming-report
// ---------------------------------------------------------------------------

describe("priming-report", () => {
  test("dedupes side-channel rows on runId (last-wins) and counts unique cycles", async () => {
    writeProbeSet(probeSetPath(), []);
    writeRecallRow(recallDir(), `${runId(1)}.json`, rowOf(runId(1), { primed: true, latencyMs: 100 }));
    writeRecallRow(recallDir(), "duplicate-of-run1.json", rowOf(runId(1), { primed: false, latencyMs: 200 }));
    writeRecallRow(recallDir(), `${runId(2)}.json`, rowOf(runId(2), { primed: false, latencyMs: 300 }));
    // Pin mtime order: the duplicate file is the NEWER (winning) write.
    utimesSync(join(recallDir(), `${runId(1)}.json`), new Date(1000), new Date(1000));
    utimesSync(join(recallDir(), "duplicate-of-run1.json"), new Date(2000), new Date(2000));
    utimesSync(join(recallDir(), `${runId(2)}.json`), new Date(1500), new Date(1500));

    const res = await runPrimingReport(baseReportDeps());
    expect(res.metrics.cyclesToDate).toBe(2);
    // Winner for run 1 is the newer primed:false row; run 2 is unprimed too.
    expect(res.metrics.primedCount).toBe(0);
    expect(res.metrics.unprimedCount).toBe(2);
  });

  test("receipt join is LEFT-JOIN: a receipt-less row still counts", async () => {
    writeProbeSet(probeSetPath(), []);
    writeRecallRow(recallDir(), `${runId(1)}.json`, rowOf(runId(1)));
    writeRecallRow(recallDir(), `${runId(2)}.json`, rowOf(runId(2)));
    utimesSync(join(recallDir(), `${runId(1)}.json`), new Date(1000), new Date(1000));
    utimesSync(join(recallDir(), `${runId(2)}.json`), new Date(2000), new Date(2000));
    mkdirSync(dirname(auditPath()), { recursive: true });
    seedReceipt(auditPath(), runId(1)); // run 2 has no receipt

    const res = await runPrimingReport(baseReportDeps());
    expect(res.metrics.cyclesToDate).toBe(2); // receipt-less cycle still counts
    expect(res.metrics.receiptCoverage.withReceipt).toBe(1);
    expect(res.metrics.receiptCoverage.withoutReceipt).toBe(1);
    // F-020: the per-cycle rows behind the aggregate — receiptPresence per row.
    expect(res.metrics.cycles?.[0]).toEqual({
      runId: runId(1),
      primed: true,
      receiptPresent: true,
      latencyMs: 100,
    });
    expect(res.metrics.cycles?.[1]).toEqual({
      runId: runId(2),
      primed: true,
      receiptPresent: false,
      latencyMs: 100,
    });
  });

  test("receipt join keys on run_id, not subject_id (the documentId alias)", async () => {
    writeProbeSet(probeSetPath(), []);
    writeRecallRow(recallDir(), `${runId(1)}.json`, rowOf(runId(1)));
    writeRecallRow(recallDir(), `${runId(2)}.json`, rowOf(runId(2)));
    utimesSync(join(recallDir(), `${runId(1)}.json`), new Date(1000), new Date(1000));
    utimesSync(join(recallDir(), `${runId(2)}.json`), new Date(2000), new Date(2000));
    mkdirSync(dirname(auditPath()), { recursive: true });
    // A receipt whose subject_id (the retain's documentId) names a LIVE cycle
    // but whose run_id does not: coverage must follow run_id — M1.2's
    // deriveDocumentId happens to alias runId today, but the join is on the
    // run, not on that upstream alias.
    seedReceipt(auditPath(), "receipt-for-some-other-run", SEED_PROBE_BANK, runId(1));

    const res = await runPrimingReport(baseReportDeps());
    expect(res.metrics.cyclesToDate).toBe(2);
    expect(res.metrics.receiptCoverage).toEqual({ withReceipt: 0, withoutReceipt: 2 });
    expect(res.metrics.cycles?.every((c) => c.receiptPresent === false)).toBe(true);
  });

  test("cost join: exact integer micro-usd per group when every observed cycle is fully priced", async () => {
    writeProbeSet(probeSetPath(), []);
    writeRecallRow(recallDir(), `${runId(1)}.json`, rowOf(runId(1), { primed: true }));
    writeRecallRow(recallDir(), `${runId(2)}.json`, rowOf(runId(2), { primed: false }));
    seedLedger(ledgerPath(), [
      { runId: runId(1), microUsd: 700 },
      { runId: runId(1), microUsd: 50 },
      { runId: runId(2), microUsd: 0 }, // fully-cached free turn: priced, prints 0
    ]);

    const res = await runPrimingReport(baseReportDeps());
    const cost = res.metrics.costTable;
    if (!cost) throw new Error("costTable must be present when every cycle is priced");
    expect(cost.primed.runs).toBe(1);
    expect(cost.primed.totalMicroUsd).toBe(750);
    expect(cost.primed.meanMicroUsd).toBe(750);
    expect(cost.unprimed.runs).toBe(1);
    expect(cost.unprimed.totalMicroUsd).toBe(0);
    expect(cost.unprimed.meanMicroUsd).toBe(0);
    // R2-001: fully-priced-only → no cost notes at all.
    expect(res.metrics.dataNotes.some((n) => /cost absent|cost partial/.test(n))).toBe(false);
  });

  test("cost join: a cycle with no ledger events is ABSENT cost — costTable withheld + note, never $0 (R2-001)", async () => {
    writeProbeSet(probeSetPath(), []);
    writeRecallRow(recallDir(), `${runId(1)}.json`, rowOf(runId(1), { primed: true }));
    // Ledger exists but holds events only for an UNOBSERVED runId.
    seedLedger(ledgerPath(), [{ runId: runId(99), microUsd: 42 }]);

    const res = await runPrimingReport(baseReportDeps());
    expect("costTable" in res.metrics).toBe(false);
    expect(res.metrics.dataNotes.some((n) => /cost absent for 1 of 1 observed cycles \(no ledger events\)/.test(n))).toBe(
      true,
    );
  });

  test("cost join: unpriced rows flag PARTIAL (total included); all-partial omits the table (R2-001)", async () => {
    writeProbeSet(probeSetPath(), []);
    writeRecallRow(recallDir(), `${runId(1)}.json`, rowOf(runId(1), { primed: true }));
    writeRecallRow(recallDir(), `${runId(2)}.json`, rowOf(runId(2), { primed: false }));
    // Run 1: an unpriced token row → PARTIAL; run 2: priced → the table prints.
    seedLedger(ledgerPath(), [
      { runId: runId(1), microUsd: 30, unpriced: 1 },
      { runId: runId(2), microUsd: 250 },
    ]);

    const mixed = await runPrimingReport(baseReportDeps());
    const cost = mixed.metrics.costTable;
    if (!cost) throw new Error("costTable must be present when at least one cycle is fully priced and none absent");
    // The ledger never prices an unpriced row, so the partial cycle's total is
    // its priced portion (0 here) — still printed, but flagged by the note.
    expect(cost.primed.totalMicroUsd).toBe(0);
    expect(cost.unprimed.totalMicroUsd).toBe(250);
    expect(mixed.metrics.dataNotes.some((n) => /cost partial for 1 cycles \(unpriced rows present/.test(n))).toBe(true);

    // All-partial: no fully-priced cycle → no table, only the partial note.
    const onlyRun1 = join(dir, "recall-only-1");
    writeRecallRow(onlyRun1, `${runId(1)}.json`, rowOf(runId(1), { primed: true }));
    const allPartial = await runPrimingReport({
      ...baseReportDeps(),
      recallDir: onlyRun1,
      reportsDir: join(dir, "reports-2"),
    });
    expect("costTable" in allPartial.metrics).toBe(false);
    expect(allPartial.metrics.dataNotes.some((n) => /cost partial for 1 cycles/.test(n))).toBe(true);
  });

  test("side-channel row file unreadable AT READ TIME (EISDIR dir-as-row): counted + dataNote, distinct from the malformed-row skip (E5)", async () => {
    writeProbeSet(probeSetPath(), []);
    writeRecallRow(recallDir(), `${runId(1)}.json`, rowOf(runId(1)));
    writeRecallRow(recallDir(), `${runId(2)}.json`, rowOf(runId(2), { primed: false }));
    // A DIRECTORY named like a row file: readdir lists it, readFileSync EISDIRs
    // — a non-ENOENT read failure, counted and noted instead of silently
    // vanishing beside the valid rows.
    mkdirSync(join(recallDir(), `${runId(3)}.json`), { recursive: true });

    const res = await runPrimingReport(baseReportDeps());
    expect(res.metrics.cyclesToDate).toBe(2);
    expect(res.metrics.dataNotes.some((n) => /1 side-channel row\(s\) unreadable and skipped/.test(n))).toBe(true);
  });

  test("audit db present-but-unreadable: receiptCoverage 0 + dataNote (E4); an absent db stays silently absent", async () => {
    writeProbeSet(probeSetPath(), []);
    writeRecallRow(recallDir(), `${runId(1)}.json`, rowOf(runId(1)));
    writeFileSync(auditPath(), "this is not a sqlite database");

    const res = await runPrimingReport(baseReportDeps());
    expect(res.metrics.receiptCoverage).toEqual({ withReceipt: 0, withoutReceipt: 1 });
    expect(res.metrics.dataNotes.some((n) => /audit db unreadable at .+ \(.*\); receiptCoverage reported 0/.test(n))).toBe(
      true,
    );

    // Absent file: the normal no-receipts-yet state — silent, no note.
    const absent = await runPrimingReport({
      ...baseReportDeps(),
      auditPath: join(dir, "never-created.db"),
      reportsDir: join(dir, "reports-4"),
    });
    expect(absent.metrics.receiptCoverage.withReceipt).toBe(0);
    expect(absent.metrics.dataNotes.some((n) => /audit db unreadable/.test(n))).toBe(false);
  });

  test("side-channel dir present as a FILE (non-ENOENT): dataNote + zero cycles, not a silent fresh factory (R2-005)", async () => {
    writeProbeSet(probeSetPath(), []);
    const fileDir = join(dir, "recall-as-file");
    writeFileSync(fileDir, "{}\n"); // a file where recallDir should be → ENOTDIR

    const res = await runPrimingReport({ ...baseReportDeps(), recallDir: fileDir });
    expect(res.metrics.cyclesToDate).toBe(0);
    expect(res.metrics.dataNotes.some((n) => /side-channel dir unreadable at .*cycles counted as 0/.test(n))).toBe(true);
    // ENOENT (absent dir) stays silent-absent — the note is for unreadable, not missing.
    const absentRes = await runPrimingReport({
      ...baseReportDeps(),
      recallDir: join(dir, "recall-never-created"),
      reportsDir: join(dir, "reports-3"),
    });
    expect(absentRes.metrics.cyclesToDate).toBe(0);
    expect(absentRes.metrics.dataNotes.some((n) => /side-channel dir unreadable/.test(n))).toBe(false);
  });

  test("absent ledger file: costTable omitted + dataNote, file stays absent (readonly posture)", async () => {
    writeProbeSet(probeSetPath(), []);
    writeRecallRow(recallDir(), `${runId(1)}.json`, rowOf(runId(1)));
    const absent = ledgerPath();

    const res = await runPrimingReport({ ...baseReportDeps(), ledgerPath: absent });
    expect("costTable" in res.metrics).toBe(false);
    expect(res.metrics.dataNotes.some((n) => /ledger/i.test(n))).toBe(true);
    // Read-only posture: the absent ledger was never created by the reader.
    expect(existsSync(absent)).toBe(false);
  });

  test("outcomeTable: primed-vs-unprimed counts + mean latencyMs", async () => {
    writeProbeSet(probeSetPath(), []);
    writeRecallRow(recallDir(), `${runId(1)}.json`, rowOf(runId(1), { primed: true, latencyMs: 100 }));
    writeRecallRow(recallDir(), `${runId(2)}.json`, rowOf(runId(2), { primed: true, latencyMs: 300 }));
    writeRecallRow(recallDir(), `${runId(3)}.json`, rowOf(runId(3), { primed: false, latencyMs: 50 }));

    const res = await runPrimingReport(baseReportDeps());
    const outcome = res.metrics.outcomeTable;
    if (!outcome) throw new Error("outcomeTable must be present above 0 cycles");
    expect(outcome.primed.runs).toBe(2);
    expect(outcome.primed.meanLatencyMs).toBe(200);
    expect(outcome.unprimed.runs).toBe(1);
    expect(outcome.unprimed.meanLatencyMs).toBe(50);
  });

  test("zero cycles: outcomeTable and cycles keys absent with a dataNote; a present ledger with no observed events omits costTable too (F-009/F-020)", async () => {
    writeProbeSet(probeSetPath(), []);
    // recallDir stays absent → 0 cycles; the ledger EXISTS but holds only
    // unrelated runs — no events for the (zero) observed cycles.
    seedLedger(ledgerPath(), [{ runId: runId(99), microUsd: 42 }]);

    const res = await runPrimingReport(baseReportDeps());
    expect(res.metrics.cyclesToDate).toBe(0);
    expect("outcomeTable" in res.metrics).toBe(false);
    expect("cycles" in res.metrics).toBe(false);
    expect("costTable" in res.metrics).toBe(false);
    expect(res.metrics.dataNotes.some((n) => /no observed cycles/i.test(n))).toBe(true);
  });

  test("exitClassification carries a dataNote naming where it lives (D1)", async () => {
    writeProbeSet(probeSetPath(), []);
    writeRecallRow(recallDir(), `${runId(1)}.json`, rowOf(runId(1)));

    const res = await runPrimingReport(baseReportDeps());
    const note = res.metrics.dataNotes.find((n) => /exitClassification/i.test(n));
    expect(note).toBeDefined();
    expect(note && /retain/i.test(note)).toBe(true);
  });

  test("dispatchFailures: line count from an explicit log path; a present-but-unreadable path is a dataNote, key absent (F-010)", async () => {
    writeProbeSet(probeSetPath(), []);
    writeRecallRow(recallDir(), `${runId(1)}.json`, rowOf(runId(1)));

    const logPath = join(dir, "dispatch-failures.log");
    writeFileSync(logPath, "line one\nline two\nline three\n");
    const readable = await runPrimingReport({ ...baseReportDeps(), dispatchLogPath: logPath });
    expect(readable.metrics.dispatchFailures).toBe(3);

    const dirPath = join(dir, "not-a-file"); // a directory: readFileSync → EISDIR
    mkdirSync(dirPath, { recursive: true });
    const unreadable = await runPrimingReport({ ...baseReportDeps(), dispatchLogPath: dirPath });
    expect("dispatchFailures" in unreadable.metrics).toBe(false);
    expect(unreadable.metrics.dataNotes.some((n) => /dispatch failure log unreadable/i.test(n))).toBe(true);
  });

  test("cyclesToDate 29 stays below the DD-22 checkpoint (false)", async () => {
    writeProbeSet(probeSetPath(), []);
    for (let i = 1; i <= 29; i++) {
      writeRecallRow(recallDir(), `${runId(i)}.json`, rowOf(runId(i)));
    }
    const res = await runPrimingReport(baseReportDeps());
    expect(res.metrics.cyclesToDate).toBe(29);
    expect(res.metrics.checkpointEligible).toBe(false);
  });

  test("cyclesToDate 30 sets checkpointEligible true", async () => {
    writeProbeSet(probeSetPath(), []);
    for (let i = 1; i <= 30; i++) {
      writeRecallRow(recallDir(), `${runId(i)}.json`, rowOf(runId(i)));
    }
    const res = await runPrimingReport(baseReportDeps());
    expect(res.metrics.cyclesToDate).toBe(30);
    expect(res.metrics.checkpointEligible).toBe(true);
  });

  test("an eligible report emits no swap/eval vocabulary (md + json)", async () => {
    writeProbeSet(probeSetPath(), []);
    for (let i = 1; i <= 30; i++) {
      writeRecallRow(recallDir(), `${runId(i)}.json`, rowOf(runId(i)));
    }
    const res = await runPrimingReport(baseReportDeps());
    expect(res.metrics.checkpointEligible).toBe(true);
    const json = readFileSync(res.jsonPath, "utf8");
    const md = readFileSync(res.mdPath, "utf8");
    expect(/graphiti|swap/i.test(json)).toBe(false);
    expect(/graphiti|swap/i.test(md)).toBe(false);
  });

  test("correlation note appears exactly once; no causal wording in the md", async () => {
    writeProbeSet(probeSetPath(), []);
    writeRecallRow(recallDir(), `${runId(1)}.json`, rowOf(runId(1)));
    writeRecallRow(recallDir(), `${runId(2)}.json`, rowOf(runId(2), { primed: false }));

    const res = await runPrimingReport(baseReportDeps());
    expect(typeof res.metrics.correlationNote).toBe("string");
    expect(/correlation/i.test(res.metrics.correlationNote)).toBe(true);
    expect(/observational/i.test(res.metrics.correlationNote)).toBe(true);

    const md = readFileSync(res.mdPath, "utf8");
    expect((md.match(/correlation \(observational\)/g) ?? []).length).toBe(1);
    expect(/caus|because of|leads to/i.test(md)).toBe(false);
  });

  test("renderReportMd is pure from the metrics JSON (byte-for-byte) and the JSON is number-complete", async () => {
    writeProbeSet(probeSetPath(), []);
    writeRecallRow(recallDir(), `${runId(1)}.json`, rowOf(runId(1), { latencyMs: 120 }));
    writeRecallRow(recallDir(), `${runId(2)}.json`, rowOf(runId(2), { primed: false, latencyMs: 80 }));
    seedLedger(ledgerPath(), [{ runId: runId(1), microUsd: 4242 }]);

    const res = await runPrimingReport(baseReportDeps());
    const parsed = JSON.parse(readFileSync(res.jsonPath, "utf8")) as ReportMetrics;
    // AC5: the md renders purely from the JSON — byte-for-byte.
    expect(renderReportMd(parsed)).toBe(readFileSync(res.mdPath, "utf8"));
    // JSON alone carries every number the md shows (spot-check).
    expect(parsed.cyclesToDate).toBe(2);
    expect(parsed.primedCount).toBe(1);
    expect(parsed.checkpointEligible).toBe(false);
  });

  test("probe growth appends integrity-gated candidates, existing rows canonically identical", async () => {
    // Raw pre-F-012 row: no origin field on disk — re-serialization stamps it.
    const seedRaw = {
      probeId: "seed-probe-100",
      query: "probe query 100",
      expectedDocumentIds: ["mulch-doc-100"],
      bank: SEED_PROBE_BANK,
    };
    mkdirSync(dirname(probeSetPath()), { recursive: true });
    writeFileSync(probeSetPath(), `${JSON.stringify([seedRaw], null, 2)}\n`);
    writeP09(p09Dir(), { [SEED_PROBE_BANK]: ["mulch-doc-200"] }, "2026-10-07T10:00:00.000Z");
    writeRecallRow(
      recallDir(),
      `${runId(1)}.json`,
      rowOf(runId(1), { recalledDocumentIds: ["mulch-doc-200", "mulch-phantom"] }),
    );

    const res = await runPrimingReport(baseReportDeps());
    expect(res.appendedProbes).toBe(1);

    const after = JSON.parse(readFileSync(probeSetPath(), "utf8")) as Probe[];
    expect(after.length).toBe(2);
    // F-012: the existing row re-serializes canonically identical PLUS the
    // defaulted origin:"seed"; the appended row carries origin:"cycle".
    expect(canonicalJson(after[0])).toBe(canonicalJson({ ...seedRaw, origin: "seed" }));
    const appended = after[1];
    expect(appended?.origin).toBe("cycle");
    expect(appended?.bank).toBe(SEED_PROBE_BANK);
    expect(appended?.expectedDocumentIds).toContain("mulch-doc-200");
    // The report JSON carries the appended count too.
    const reportJson = JSON.parse(readFileSync(res.jsonPath, "utf8")) as Record<string, unknown>;
    expect(reportJson.appendedProbes).toBe(1);
  });

  test("growth refuses an unminted candidate: appends nothing (appendedProbes 0)", async () => {
    const seed = [probe(100)];
    writeProbeSet(probeSetPath(), seed);
    const before = readFileSync(probeSetPath(), "utf8");
    // p09Dir stays empty: no mint record covers the candidate id.
    writeRecallRow(
      recallDir(),
      `${runId(1)}.json`,
      rowOf(runId(1), { recalledDocumentIds: ["mulch-phantom"] }),
    );

    const res = await runPrimingReport(baseReportDeps());
    expect(res.appendedProbes).toBe(0);
    expect(readFileSync(probeSetPath(), "utf8")).toBe(before);
  });

  test("growth on an unreadable probe set: appendedProbes 0 + dataNote, matching the lock-degradation pattern (R2-011)", async () => {
    mkdirSync(dirname(probeSetPath()), { recursive: true });
    writeFileSync(probeSetPath(), "{ not json at all");
    // Candidates exist and would pass the mint gate — growth skips ONLY
    // because the set cannot be parsed, and the report must say so.
    writeP09(p09Dir(), { [SEED_PROBE_BANK]: ["mulch-doc-200"] }, "2026-10-07T10:00:00.000Z");
    writeRecallRow(
      recallDir(),
      `${runId(1)}.json`,
      rowOf(runId(1), { recalledDocumentIds: ["mulch-doc-200"] }),
    );

    const res = await runPrimingReport(baseReportDeps());
    expect(res.appendedProbes).toBe(0);
    expect(res.metrics.dataNotes.some((n) => /probe growth skipped: probe set unreadable at /.test(n))).toBe(true);
    // The corrupt set is left untouched.
    expect(readFileSync(probeSetPath(), "utf8")).toBe("{ not json at all");
  });

  test("append runs under the probe-writer lock: genuine contention blocks, release lets the append land", async () => {
    const seed = [probe(100)];
    writeProbeSet(probeSetPath(), seed);
    writeP09(p09Dir(), { [SEED_PROBE_BANK]: ["mulch-doc-200"] }, "2026-10-07T10:00:00.000Z");
    writeRecallRow(
      recallDir(),
      `${runId(1)}.json`,
      rowOf(runId(1), { recalledDocumentIds: ["mulch-doc-200"] }),
    );

    const probesDir = dirname(probeSetPath());
    const lockFile = join(probesDir, `${PROBE_WRITER_LOCK_ID}.lock`);
    // A FOREIGN holder (another process's body: pid not ours, host not ours) —
    // growth must WAIT on genuine contention, not spin on a reentrant refusal.
    // (R2-015: an in-process reentrant acquire is now fatal — pinned below.)
    writeFileSync(lockFile, "424242 some-other-host 2026-10-07T10:00:00.000Z deadbeef\n");
    let done = false;
    const pending = runPrimingReport(baseReportDeps()).then((r) => {
      done = true;
      return r;
    });
    await Bun.sleep(150);
    expect(done).toBe(false); // blocked on the held lock — append serialized
    expect(existsSync(lockFile)).toBe(true);
    rmSync(lockFile); // the holder releases

    const res = await pending;
    expect(done).toBe(true);
    expect(res.appendedProbes).toBe(1);
    const after = JSON.parse(readFileSync(probeSetPath(), "utf8")) as Probe[];
    expect(after.length).toBe(2);
  });

  test("growth: a reentrant acquire in THIS process is fatal to growth, not spun on (R2-015) — report completes with a dataNote", async () => {
    const seed = [probe(100)];
    writeProbeSet(probeSetPath(), seed);
    writeP09(p09Dir(), { [SEED_PROBE_BANK]: ["mulch-doc-200"] }, "2026-10-07T10:00:00.000Z");
    writeRecallRow(
      recallDir(),
      `${runId(1)}.json`,
      rowOf(runId(1), { recalledDocumentIds: ["mulch-doc-200"] }),
    );

    // Same process holds the probe-writer lock: growth's acquire is a nesting
    // bug — it must fail fast (F-007 degradation), not poll until the deadline.
    const probesDir = dirname(probeSetPath());
    const mine = acquireRunLock(probesDir, PROBE_WRITER_LOCK_ID, "leaf-t reentrant test");
    const res = await runPrimingReport(baseReportDeps());
    releaseRunLock(mine);
    expect(res.appendedProbes).toBe(0);
    expect(res.metrics.dataNotes.some((n) => /probe growth skipped/.test(n))).toBe(true);
    // The set is untouched — growth appended nothing before refusing.
    expect((JSON.parse(readFileSync(probeSetPath(), "utf8")) as Probe[]).length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// harness-e2e
// ---------------------------------------------------------------------------

describe("harness-e2e", () => {
  test("combined fixtures: one recall run + one report run produce both artifacts, checkpointEligible false", async () => {
    const probes = [probe(0), probe(1)];
    writeProbeSet(probeSetPath(), probes);
    writeP09(
      p09Dir(),
      { [SEED_PROBE_BANK]: ["mulch-doc-0", "mulch-doc-1"] },
      "2026-10-07T10:00:00.000Z",
    );
    const cannedMap = new Map<string, { results: CannedResult[] }>();
    for (const p of probes) {
      cannedMap.set(cannedKey(p), { results: canned(p.expectedDocumentIds[0] ?? null) });
    }
    const { client } = fakeProbeClient({ canned: cannedMap });

    const recallRes = await runProbeRecall(baseRecallDeps(client));
    expect(recallRes.ok).toBe(true);
    if (!recallRes.ok) return;
    expect(readArtifact(evidenceDir(), "-hit-rate-")).toBeDefined();

    // Side channel: 5 cycles (3 primed, 2 unprimed), receipts for 2, cost for 1.
    for (let i = 1; i <= 5; i++) {
      writeRecallRow(recallDir(), `${runId(i)}.json`, rowOf(runId(i), { primed: i <= 3, latencyMs: 100 + i }));
    }
    mkdirSync(dirname(auditPath()), { recursive: true });
    seedReceipt(auditPath(), runId(1));
    seedReceipt(auditPath(), runId(2));
    seedLedger(ledgerPath(), [{ runId: runId(1), microUsd: 400 }]);

    const reportRes = await runPrimingReport({
      ...baseReportDeps(),
      p09EvidenceDir: p09Dir(), // the same mint fixture dir the recall run used
    });
    expect(reportRes.metrics.cyclesToDate).toBe(5);
    expect(reportRes.metrics.checkpointEligible).toBe(false);
    expect(reportRes.metrics.primedCount).toBe(3);
    expect(existsSync(reportRes.jsonPath)).toBe(true);
    expect(existsSync(reportRes.mdPath)).toBe(true);
    expect(readFileSync(reportRes.mdPath, "utf8").length).toBeGreaterThan(0);
  });

  test("read-only posture: audit.db and ledger mtime unchanged after a report run", async () => {
    writeProbeSet(probeSetPath(), []);
    writeRecallRow(recallDir(), `${runId(1)}.json`, rowOf(runId(1)));
    mkdirSync(dirname(auditPath()), { recursive: true });
    seedReceipt(auditPath(), runId(1));
    seedLedger(ledgerPath(), [{ runId: runId(1), microUsd: 250 }]);
    const auditBefore = statSync(auditPath()).mtimeMs;
    const ledgerBefore = statSync(ledgerPath()).mtimeMs;

    await runPrimingReport(baseReportDeps());

    expect(statSync(auditPath()).mtimeMs).toBe(auditBefore);
    expect(statSync(ledgerPath()).mtimeMs).toBe(ledgerBefore);
  });

  test("env hygiene: runners resolve QDS_AUDIT_DB / QDS_COST_LEDGER_FILE (C-5) when explicit paths are omitted", async () => {
    // beforeEach pointed QDS_AUDIT_DB / QDS_COST_LEDGER_FILE inside the tmpdir.
    const probes = [probe(0), probe(1)];
    writeProbeSet(probeSetPath(), probes);
    writeP09(
      p09Dir(),
      { [SEED_PROBE_BANK]: ["mulch-doc-0", "mulch-doc-1"] },
      "2026-10-07T10:00:00.000Z",
    );
    writeRecallRow(recallDir(), `${runId(1)}.json`, rowOf(runId(1), { primed: true }));
    writeRecallRow(recallDir(), `${runId(2)}.json`, rowOf(runId(2), { primed: false }));
    mkdirSync(dirname(auditPath()), { recursive: true });
    seedReceipt(auditPath(), runId(1));
    // R2-001: both observed cycles priced (run 2 a fully-cached 0) so the
    // env-pointed ledger still surfaces in costTable.
    seedLedger(ledgerPath(), [
      { runId: runId(1), microUsd: 400 },
      { runId: runId(2), microUsd: 0 },
    ]);

    // probe-recall: receipts come from the env-pointed audit db (no explicit path).
    const cannedMap = new Map<string, { results: CannedResult[] }>();
    for (const p of probes) {
      cannedMap.set(cannedKey(p), { results: canned(p.expectedDocumentIds[0] ?? null) });
    }
    const { client } = fakeProbeClient({ canned: cannedMap });
    const recallRes = await runProbeRecall({
      client,
      probeSetPath: probeSetPath(),
      evidenceDir: evidenceDir(),
      p09EvidenceDir: p09Dir(),
      now: () => NOW,
    });
    expect(recallRes.ok).toBe(true);

    // priming-report: no auditPath / ledgerPath — env resolution only.
    const reportRes = await runPrimingReport({
      recallDir: recallDir(),
      reportsDir: reportsDir(),
      probeSetPath: probeSetPath(),
      p09EvidenceDir: p09Dir(),
      now: () => NOW,
    });
    expect(reportRes.metrics.cyclesToDate).toBe(2);
    expect(reportRes.metrics.receiptCoverage.withReceipt).toBe(1);
    const cost = reportRes.metrics.costTable;
    if (!cost) throw new Error("env-pointed ledger must be read");
    expect(cost.primed.totalMicroUsd).toBe(400);
  });
});
