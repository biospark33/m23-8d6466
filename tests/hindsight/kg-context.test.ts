/**
 * kg-context tests (M1.2 AC1/AC2/AC3 + Observability Contract).
 *
 * Mock boundary: a structural FAKE client ({recall, listBanks}) — no network
 * anywhere, and the real HindsightClient is never constructed because
 * deps.client is always injected (env vars are set only to flip the seam's
 * gate). Side-channel writes go to a per-test tmpdir via deps.recallDir —
 * never the real _bmad-output. Logs are captured via setLogSink (CC-9).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { setLogSink, type LogEntry } from "../../src/swarmclaw/mcp/stdio-transport.ts";
import { HindsightHttpError } from "../../src/hindsight/client.ts";
import type { RecallResponse } from "../../src/hindsight/schemas.ts";
import {
  buildKgContextXml,
  CITATION_INSTRUCTION,
  EMPTY_KG_DIRECTIVE,
  KG_CONTEXT_MAX_CHARS,
  KG_RECALL_LIMIT,
  primeDispatchBrief,
  recallFanOut,
  type RecallClient,
  type RecallRow,
} from "../../src/hindsight/kg-context.ts";

// ---------------------------------------------------------------------------
// Fixtures — fake client, env control, tmpdir, log capture
// ---------------------------------------------------------------------------

// A strict UUID v4 — the row gate is now EXACTLY resolveBriefRequestId's gate
// (isValidUuidV4), so the test correlation id must be one dispatch would keep.
const RUN_ID = "00000000-0000-4000-8000-000000000001";
const OUTCOME_DOC_ID = "qds-20261006-kgtest";
const REPO_SLUG = "acme/widget";
const REPO_BANK = "acme-widget"; // resolveBankId("acme/widget")
const COLLECTIVE = "qds-collective";

interface RecallCall {
  bankId: string;
  query: string;
  limit?: number;
}

/** Structural fake client — records every recall for fan-out assertions. */
function fakeClient(cfg: {
  banks?: unknown;
  recall?: (bankId: string, query: string, limit?: number) => Promise<unknown>;
  listBanks?: () => Promise<unknown>;
}): RecallClient & { calls: RecallCall[] } {
  const calls: RecallCall[] = [];
  // Default bank list = the PROVISIONED family (repo base + its -dev-meta
  // sibling, the pair only the provisioner creates) — the read leg resolves
  // the provision-time id by that family signature.
  return {
    calls,
    listBanks: cfg.listBanks ??
      (async () =>
        cfg.banks ?? {
          banks: [{ bank_id: REPO_BANK }, { bank_id: `${REPO_BANK}-dev-meta` }],
        }),
    recall: async (bankId, query, limit) => {
      calls.push({ bankId, query, limit });
      const res = cfg.recall
        ? await cfg.recall(bankId, query, limit)
        : { results: [], durationMs: 1 };
      return res as RecallResponse;
    },
  };
}

const ENV_KEYS = ["HINDSIGHT_BASE_URL", "HINDSIGHT_BEARER_TOKEN", "HINDSIGHT_API_KEY"] as const;
let savedEnv: Record<string, string | undefined> = {};
let dir = "";
let logEntries: LogEntry[] = [];
let restoreLogSink: (() => void) | undefined;

beforeEach(() => {
  savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of ENV_KEYS) delete process.env[k];
  dir = mkdtempSync(join(tmpdir(), "kg-context-"));
  logEntries = [];
  restoreLogSink = setLogSink((e) => {
    logEntries.push(e);
  });
});

afterEach(() => {
  if (restoreLogSink) restoreLogSink();
  rmSync(dir, { recursive: true, force: true });
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

/** Flip the seam's env gate ON (the injected fake means no network results). */
function configEnv(): void {
  process.env.HINDSIGHT_BASE_URL = "http://127.0.0.1:1";
  process.env.HINDSIGHT_BEARER_TOKEN = "test-host-token";
}

function brief(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { requestId: RUN_ID, repoSlug: REPO_SLUG, ...overrides };
}

function readRow(runId: string = RUN_ID): RecallRow {
  const raw = readFileSync(join(dir, `${runId}.json`), "utf8");
  expect(raw.endsWith("\n")).toBe(true);
  return JSON.parse(raw) as RecallRow;
}

/** File-existence check (the tmpdir itself always exists — never gate on it). */
function rowFileExists(name: string): boolean {
  return existsSync(join(dir, name));
}

function kgRecallEntries(): LogEntry[] {
  return logEntries.filter((e) => e.operation === "kg-recall");
}

const ROW_KEYS = [
  "banks",
  "chars",
  "directive",
  "latencyMs",
  "primed",
  "recalledDocumentIds",
  "runId",
];

// ---------------------------------------------------------------------------
// describe 1 — kg context assembly
// ---------------------------------------------------------------------------

describe("kg context assembly", () => {
  test("ladder (a): unconfigured env → brief untouched (same reference), no attempt, no row, no line", async () => {
    const b = brief();
    const client = fakeClient({});
    const primed = await primeDispatchBrief(b, { client, recallDir: dir });
    expect(primed).toBe(b); // byte-identical v5 dispatch = same object reference
    expect(client.calls.length).toBe(0);
    expect(rowFileExists(`${RUN_ID}.json`)).toBe(false);
    expect(kgRecallEntries().length).toBe(0);
  });

  test("ladder (d): results → shallow copy with ranked, citation-floored <kg_context> block", async () => {
    configEnv();
    const client = fakeClient({
      recall: async (bankId) =>
        bankId === REPO_BANK
          ? {
              results: [
                { memoryId: "obs-1", content: "CI uses bun test", score: 0.9, documentId: OUTCOME_DOC_ID },
              ],
              durationMs: 3,
            }
          : {
              results: [
                { memoryId: "obs-2", content: "Always tee test logs", score: 0.7, documentId: null },
              ],
              durationMs: 4,
            },
    });
    const b = brief();
    const primed = (await primeDispatchBrief(b, { client, recallDir: dir })) as {
      kgContext?: string;
    };
    expect(primed).not.toBe(b); // shallow copy, caller's object identity preserved
    const kg = primed.kgContext ?? "";
    expect(kg.startsWith("<kg_context>")).toBe(true);
    expect(kg).toContain('id="obs-1"');
    expect(kg).toContain(`documentId="${OUTCOME_DOC_ID}"`);
    // Rank: higher score first, merged across banks.
    expect(kg.indexOf('id="obs-1"')).toBeLessThan(kg.indexOf('id="obs-2"'));
    expect(kg).toContain(CITATION_INSTRUCTION);
    expect(kg.length).toBeLessThanOrEqual(KG_CONTEXT_MAX_CHARS);
    // Citation floor: every observation line carries its [cite:<id>] id attribute.
    for (const m of kg.matchAll(/<observation id="([^"]+)"/g)) {
      expect(m[1]).toMatch(/^[A-Za-z0-9_-]+$/);
    }
    // Side-channel row — the Observability Contract shape, EXACTLY.
    const row = readRow();
    expect(Object.keys(row).sort()).toEqual(ROW_KEYS);
    expect(row.runId).toBe(RUN_ID);
    expect(row.primed).toBe(true);
    expect(row.directive).toBe("kg_context");
    expect(row.banks).toEqual([REPO_BANK, COLLECTIVE]);
    expect(row.recalledDocumentIds).toEqual([OUTCOME_DOC_ID]); // nulls filtered, rank order
    expect(row.chars).toBe(kg.length);
    expect(row.latencyMs).toBeGreaterThanOrEqual(0);
    const entry = kgRecallEntries()[0];
    expect(entry).toBeDefined();
    expect(entry?.directive).toBe("kg_context");
    expect(typeof entry?.recallMs).toBe("number");
    expect(typeof entry?.bankMs).toBe("object");
  });

  test("ladder (c): zero observations across banks → EMPTY_KG_DIRECTIVE only, directive 'empty'", async () => {
    configEnv();
    const client = fakeClient({}); // default recall → empty results, both banks ok
    const primed = (await primeDispatchBrief(brief(), { client, recallDir: dir })) as {
      kgContext?: string;
    };
    expect(primed.kgContext).toBe(EMPTY_KG_DIRECTIVE);
    const row = readRow();
    expect(row.primed).toBe(true);
    expect(row.directive).toBe("empty");
    expect(row.recalledDocumentIds).toEqual([]);
    expect(row.chars).toBe(EMPTY_KG_DIRECTIVE.length);
    expect(row.banks).toEqual([REPO_BANK, COLLECTIVE]);
  });

  test("fan-out set is exactly {provision-time repo bank, qds-collective}, one attempt each, limit=KG_RECALL_LIMIT", async () => {
    configEnv();
    const client = fakeClient({});
    await primeDispatchBrief({ requestId: RUN_ID, repoSlug: REPO_SLUG, workId: "M1.2" }, {
      client,
      recallDir: dir,
    });
    expect(client.calls.map((c) => c.bankId)).toEqual([REPO_BANK, COLLECTIVE]);
    expect(client.calls[0]?.limit).toBe(KG_RECALL_LIMIT);
    // Query is the short deterministic repoSlug + workId derivation.
    expect(client.calls[0]?.query).toBe("acme/widget M1.2");
  });

  test("read leg recalls the PROVISION-TIME id via the -dev-meta family signature (collision-provisioned)", async () => {
    configEnv();
    // Collision-provisioned state: acme-widget is a FOREIGN bank (no -dev-meta
    // sibling — the provisioner never created it); the provisioner created the
    // acme-widget-2 family. The read leg must recall acme-widget-2 and never
    // the raw base.
    const client = fakeClient({
      banks: {
        banks: [
          { bank_id: REPO_BANK },
          { bank_id: `${REPO_BANK}-2` },
          { bank_id: `${REPO_BANK}-2-dev-meta` },
        ],
      },
    });
    await primeDispatchBrief(brief(), { client, recallDir: dir });
    expect(client.calls.map((c) => c.bankId)).toEqual([`${REPO_BANK}-2`, COLLECTIVE]);
    expect(client.calls.some((c) => c.bankId === REPO_BANK)).toBe(false);
  });

  test("provisioned family at the base id → recalled at the base, never suffixed", async () => {
    configEnv();
    // Default fixture bank list = {REPO_BANK, REPO_BANK-dev-meta} family.
    const client = fakeClient({});
    await primeDispatchBrief(brief(), { client, recallDir: dir });
    expect(client.calls.map((c) => c.bankId)).toEqual([REPO_BANK, COLLECTIVE]);
    expect(client.calls.some((c) => c.bankId === `${REPO_BANK}-2`)).toBe(false);
  });

  test("bare foreign base (no -dev-meta sibling) → no provisioned family: proceed-unprimed, NOTHING recalled", async () => {
    configEnv();
    const client = fakeClient({ banks: { banks: [{ bank_id: REPO_BANK }] } });
    const b = brief();
    const primed = await primeDispatchBrief(b, { client, recallDir: dir });
    expect(primed).toBe(b); // ladder (b) — same reference, unprimed
    expect(client.calls.length).toBe(0); // no recall call to ANY bank
    expect(readRow().directive).toBe("none");
  });

  test("per-bank partial failure contributes nothing, but partial results still count as results", async () => {
    configEnv();
    const client = fakeClient({
      recall: async (bankId) => {
        if (bankId === COLLECTIVE) {
          throw new HindsightHttpError(408, "timed out after 10000ms", "req-p");
        }
        return {
          results: [{ memoryId: "obs-1", content: "CI uses bun test", score: 0.9, documentId: null }],
          durationMs: 2,
        };
      },
    });
    const primed = (await primeDispatchBrief(brief(), { client, recallDir: dir })) as {
      kgContext?: string;
    };
    const kg = primed.kgContext ?? "";
    expect(kg).toContain('id="obs-1"');
    expect(kg).not.toContain("obs-2");
    const row = readRow();
    expect(row.directive).toBe("kg_context"); // any bank returned results → kg_context
    expect(row.banks).toEqual([REPO_BANK, COLLECTIVE]); // both were ATTEMPTED
  });

  test("rank: score desc with stable fan-out-order tie-break", () => {
    const block = buildKgContextXml([
      { id: "low", content: "low", score: 0.2, documentId: null },
      { id: "high", content: "high", score: 0.9, documentId: null },
      { id: "tie-1", content: "tie one", score: 0.5, documentId: null },
      { id: "tie-2", content: "tie two", score: 0.5, documentId: null },
    ]);
    const at = (id: string) => block.indexOf(`id="${id}"`);
    expect(at("high")).toBeLessThan(at("tie-1"));
    expect(at("tie-1")).toBeLessThan(at("tie-2")); // equal scores keep original order
    expect(at("tie-2")).toBeLessThan(at("low"));
  });

  test("citation floor: an observation without a citable id is dropped whole", async () => {
    configEnv();
    const client = fakeClient({
      recall: async (bankId) =>
        bankId === REPO_BANK
          ? {
              results: [
                { memoryId: "", content: "uncitable fact", score: 0.99, documentId: null },
                { memoryId: "good-1", content: "citable fact", score: 0.5, documentId: null },
              ],
              durationMs: 1,
            }
          : { results: [], durationMs: 1 },
    });
    const primed = (await primeDispatchBrief(brief(), { client, recallDir: dir })) as {
      kgContext?: string;
    };
    const kg = primed.kgContext ?? "";
    expect(kg).toContain('id="good-1"');
    expect(kg).not.toContain("uncitable fact");
  });

  test("whole-observation ceiling stop: a non-fitting observation is dropped whole, never split", () => {
    const big1 = "A".repeat(5000);
    const big2 = "B".repeat(5000);
    const block = buildKgContextXml([
      { id: "big-1", content: big1, score: 0.9, documentId: null },
      { id: "big-2", content: big2, score: 0.8, documentId: null },
      { id: "small", content: "tiny fits", score: 0.7, documentId: null },
    ]);
    expect(block.length).toBeLessThanOrEqual(KG_CONTEXT_MAX_CHARS);
    expect(block).toContain(big1);
    expect(block).not.toContain(big2.slice(0, 64)); // not present in any fragment
    expect(block).not.toContain('id="big-2"');
    expect(block).toContain("tiny fits"); // a smaller later-ranked one still fits
  });

  test("ceiling-dropped observations are not advertised in recalledDocumentIds", async () => {
    configEnv();
    const client = fakeClient({
      recall: async (bankId) =>
        bankId === REPO_BANK
          ? {
              results: [
                // 9000 chars + wrapper > the 8000 ceiling → dropped whole.
                { memoryId: "big-1", content: "A".repeat(9000), score: 0.9, documentId: "doc-big" },
                { memoryId: "small-1", content: "tiny fits", score: 0.5, documentId: "doc-small" },
              ],
              durationMs: 1,
            }
          : { results: [], durationMs: 1 },
    });
    await primeDispatchBrief(brief(), { client, recallDir: dir });
    const row = readRow();
    expect(row.directive).toBe("kg_context");
    expect(row.recalledDocumentIds).toEqual(["doc-small"]); // doc-big dropped by the ceiling
  });

  test("every observation over the ceiling → ladder (c) 'empty', never a zero-observation kg_context block", async () => {
    configEnv();
    const client = fakeClient({
      recall: async () => ({
        results: [
          { memoryId: "big-1", content: "A".repeat(9000), score: 0.9, documentId: "doc-big" },
          { memoryId: "big-2", content: "B".repeat(9000), score: 0.8, documentId: "doc-big-2" },
        ],
        durationMs: 1,
      }),
    });
    const primed = (await primeDispatchBrief(brief(), { client, recallDir: dir })) as {
      kgContext?: string;
    };
    expect(primed.kgContext).toBe(EMPTY_KG_DIRECTIVE);
    const row = readRow();
    expect(row.directive).toBe("empty");
    expect(row.chars).toBe(EMPTY_KG_DIRECTIVE.length);
    expect(row.recalledDocumentIds).toEqual([]);
  });

  test("content is escaped only for XML-structural safety (< > &)", () => {
    const block = buildKgContextXml([
      { id: "esc-1", content: "a <b> & c > d", score: 1, documentId: null },
    ]);
    expect(block).toContain("a &lt;b&gt; &amp; c &gt; d");
    expect(block).not.toContain("<b>");
  });

  test("documentId is charset-stripped too: control chars in the attribute cannot re-poison the block", () => {
    // A refused control char in document_id would re-poison the block past
    // the schema refine (same refused class as content) - the attribute
    // strips it the same way content does.
    const block = buildKgContextXml([
      { id: "obs-doc", content: "fact", score: 1, documentId: "doc\vid" },
    ]);
    expect(block).not.toContain("\v");
    expect(block).toContain('documentId="docid"');
  });

  test("recalled text is charset-stripped, not dropped: \\r and U+2028 removed, text kept", async () => {
    configEnv();
    const client = fakeClient({
      recall: async () => ({
        results: [
          {
            memoryId: "obs-cr",
            // \r and U+2028 are refused by the brief schema's kgContext refine —
            // unstripped, a poisoned bank would exit-2 at dispatch.
            content: "line1\rline2\u2028line3",
            score: 0.9,
            documentId: null,
          },
        ],
        durationMs: 1,
      }),
    });
    const primed = (await primeDispatchBrief(brief(), { client, recallDir: dir })) as {
      kgContext?: string;
    };
    const kg = primed.kgContext ?? "";
    expect(kg).not.toContain("\r");
    expect(kg).not.toContain("\u2028");
    // Stripped, not dropped whole — the fact itself still grounds.
    expect(kg).toContain("line1line2");
    expect(kg).toContain("line3");
    // Atomic write: the rename completed (row parses above via readRow) and
    // left no temp behind.
    expect(readdirSync(dir).every((f) => !f.endsWith(".tmp"))).toBe(true);
    expect(readRow().directive).toBe("kg_context");
  });

  test("numeric issueId reaches the recall query (BriefSchema types issueId as number)", async () => {
    configEnv();
    const client = fakeClient({});
    await primeDispatchBrief({ requestId: RUN_ID, repoSlug: REPO_SLUG, issueId: 42 }, {
      client,
      recallDir: dir,
    });
    expect(client.calls[0]?.query).toBe("acme/widget 42");
  });

  test("recallFanOut dedups when the repo bank IS the collective", async () => {
    const client = fakeClient({});
    const fan = await recallFanOut(client, COLLECTIVE, "q");
    expect(client.calls.map((c) => c.bankId)).toEqual([COLLECTIVE]);
    expect(fan.banks).toEqual([COLLECTIVE]);
  });

  test("recallFanOut dedups by fact id across banks: first-seen wins (repo bank before qds-collective)", async () => {
    const client = fakeClient({
      recall: async (bankId) =>
        bankId === REPO_BANK
          ? { results: [{ memoryId: "shared-1", content: "from repo bank", score: 0.9, documentId: null }], durationMs: 1 }
          : { results: [{ memoryId: "shared-1", content: "from collective", score: 0.99, documentId: null }], durationMs: 1 },
    });
    const fan = await recallFanOut(client, REPO_BANK, "q");
    expect(fan.observations.map((o) => o.id)).toEqual(["shared-1"]);
    expect(fan.observations[0]?.content).toBe("from repo bank");
  });
});

// ---------------------------------------------------------------------------
// describe 2 — kg context ladder negative controls
// ---------------------------------------------------------------------------

describe("kg context ladder negative controls", () => {
  test("timeout → proceed-unprimed, NEVER the empty directive", async () => {
    configEnv();
    const client = fakeClient({
      recall: async () => {
        throw new HindsightHttpError(408, "timed out after 10000ms", "req-t");
      },
    });
    const b = brief();
    const primed = (await primeDispatchBrief(b, { client, recallDir: dir })) as {
      kgContext?: string;
    };
    expect(primed).toBe(b); // v5-identical, same reference
    expect(primed.kgContext).toBeUndefined();
    // Ladder (b) still writes the row — M1.3 counts every M1 cycle.
    const row = readRow();
    expect(row.primed).toBe(false);
    expect(row.directive).toBe("none"); // NOT "empty" — that is the AC2 negative control
    expect(row.chars).toBe(0);
    expect(row.banks).toEqual([REPO_BANK, COLLECTIVE]);
    expect(kgRecallEntries()[0]?.directive).toBe("none");
  });

  test("one bank times out, the other succeeds-but-empty → 'empty' (only ALL-bank failure is 'none')", async () => {
    configEnv();
    const client = fakeClient({
      recall: async (bankId) => {
        if (bankId === COLLECTIVE) throw new HindsightHttpError(408, "timeout", "req-t2");
        return { results: [], durationMs: 1 };
      },
    });
    const primed = (await primeDispatchBrief(brief(), { client, recallDir: dir })) as {
      kgContext?: string;
    };
    expect(primed.kgContext).toBe(EMPTY_KG_DIRECTIVE);
    expect(readRow().directive).toBe("empty");
  });

  test("recall/listBanks errors never throw out of primeDispatchBrief (even non-Error rejections)", async () => {
    configEnv();
    const boom = fakeClient({
      recall: async () => {
        throw new Error("boom");
      },
    });
    await expect(primeDispatchBrief(brief(), { client: boom, recallDir: dir })).resolves.toBeDefined();
    const strReject = fakeClient({
      recall: async () => {
        throw "not-an-error"; // non-Error rejection — the seam must still swallow it
      },
    });
    await expect(
      primeDispatchBrief(brief(), { client: strReject, recallDir: dir }),
    ).resolves.toBeDefined();
    const listFail = fakeClient({
      listBanks: async () => {
        throw new HindsightHttpError(500, "list failed", "req-l");
      },
    });
    const b = brief();
    await expect(primeDispatchBrief(b, { client: listFail, recallDir: dir })).resolves.toBe(b);
    expect(readRow().directive).toBe("none");
  });

  test("no provisioned family anywhere (bare banks, no -dev-meta siblings) → proceed-unprimed, directive 'none'", async () => {
    configEnv();
    // Every candidate exists but NONE carries the -dev-meta sibling, so no
    // candidate is the provisioned repo bank → ladder (b).
    const existing = [REPO_BANK, ...Array.from({ length: 10 }, (_, i) => `${REPO_BANK}-${i + 2}`)];
    const client = fakeClient({ banks: { banks: existing.map((bank_id) => ({ bank_id })) } });
    const b = brief();
    const primed = (await primeDispatchBrief(b, { client, recallDir: dir })) as {
      kgContext?: string;
    };
    expect(primed).toBe(b);
    expect(client.calls.length).toBe(0); // never recalled — no provisioned family
    expect(readRow().directive).toBe("none");
  });

  test("brief missing repoSlug → proceed-unprimed, row fires when requestId present", async () => {
    configEnv();
    const b = { requestId: RUN_ID };
    const primed = (await primeDispatchBrief(b, { client: fakeClient({}), recallDir: dir })) as
      Record<string, unknown>;
    expect(primed).toBe(b);
    const row = readRow();
    expect(row.primed).toBe(false);
    expect(row.directive).toBe("none");
    expect(row.banks).toEqual([]);
  });

  test("brief missing requestId → priming still works, but NEITHER row NOR line is written", async () => {
    configEnv();
    const b = { repoSlug: REPO_SLUG };
    const primed = (await primeDispatchBrief(b, { client: fakeClient({}), recallDir: dir })) as
      Record<string, unknown>;
    expect(typeof primed.kgContext).toBe("string"); // primed, just unobservable
    expect(rowFileExists("undefined.json")).toBe(false);
    expect(kgRecallEntries().length).toBe(0);
  });

  test("unsafe requestId (traversal / dot-segment forgery) is treated as NO id: no row file anywhere, no line, priming unaffected", async () => {
    configEnv();
    for (const requestId of ["../../evil", "..", "a..b", ".hidden", "has space", "a".repeat(64)]) {
      const b = { requestId, repoSlug: REPO_SLUG };
      const primed = (await primeDispatchBrief(b, { client: fakeClient({}), recallDir: dir })) as
        Record<string, unknown>;
      // Priming is unaffected by observability's refusal.
      expect(typeof primed.kgContext).toBe("string");
      // No file AT ALL in the side-channel dir — a traversal id must not land
      // as any filename segment, inside or outside the dir.
      expect(readdirSync(dir)).toEqual([]);
      expect(kgRecallEntries().length).toBe(0);
    }
  });

  test("safe-but-non-UUID requestId is treated as NO id — the row gate is resolveBriefRequestId's gate, so dispatch would drop it and NO orphan row is written", async () => {
    configEnv();
    // All of these pass the OLD SAFE_RUN_ID charset gate but fail
    // isValidUuidV4 — under the old gate each left an orphan row a receipt
    // could never join to (Amendment R7's case; the tightened gate closes it).
    for (const requestId of ["qds-20261006-kgtest", "abc123", "00000000-0000-4000-8000-00000000000", "00000000-0000-4000-8000-000000000001extra"]) {
      const b = { requestId, repoSlug: REPO_SLUG };
      const primed = (await primeDispatchBrief(b, { client: fakeClient({}), recallDir: dir })) as
        Record<string, unknown>;
      expect(typeof primed.kgContext).toBe("string");
      expect(readdirSync(dir)).toEqual([]);
      expect(kgRecallEntries().length).toBe(0);
    }
  });

  test("deps.requestId (submit's --request-id) wins over the brief field and keys the row when the brief names NO id at all", async () => {
    configEnv();
    const depsId = "11111111-2222-4333-8444-555555555555";
    // Submit's shape: the correlation id exists ONLY as a flag — the brief
    // carries none. Before the threading this cycle wrote no row at all.
    const b = { repoSlug: REPO_SLUG };
    const primed = (await primeDispatchBrief(b, { client: fakeClient({}), recallDir: dir, requestId: depsId })) as
      Record<string, unknown>;
    expect(typeof primed.kgContext).toBe("string");
    const row = readRow(depsId);
    expect(row.runId).toBe(depsId);
    expect(kgRecallEntries().some((e) => e.runId === depsId)).toBe(true);
  });

  test("deps.requestId overrides a DIFFERENT brief requestId — the row keys on the id the run will carry", async () => {
    configEnv();
    const depsId = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
    const b = { requestId: RUN_ID, repoSlug: REPO_SLUG };
    const primed = (await primeDispatchBrief(b, { client: fakeClient({}), recallDir: dir, requestId: depsId })) as
      Record<string, unknown>;
    expect(typeof primed.kgContext).toBe("string");
    expect(rowFileExists(`${RUN_ID}.json`)).toBe(false);
    expect(readRow(depsId).runId).toBe(depsId);
  });

  test("INVALID deps.requestId is treated as NO id — the gate is uniform, the seam never throws", async () => {
    configEnv();
    const b = { requestId: RUN_ID, repoSlug: REPO_SLUG };
    const primed = (await primeDispatchBrief(b, { client: fakeClient({}), recallDir: dir, requestId: "not-a-uuid" })) as
      Record<string, unknown>;
    // Priming unaffected (deps-win does not mean deps-trusted past the gate).
    expect(typeof primed.kgContext).toBe("string");
    expect(readdirSync(dir)).toEqual([]);
    expect(kgRecallEntries().length).toBe(0);
  });

  test("unconfigured env (including empty-string values): no row file, no log line, byte-identical brief", async () => {
    const cases: Array<Record<string, string>> = [
      {}, // nothing set
      { HINDSIGHT_BASE_URL: "", HINDSIGHT_BEARER_TOKEN: "t" },
      { HINDSIGHT_BASE_URL: "http://x", HINDSIGHT_BEARER_TOKEN: "" },
      { HINDSIGHT_BASE_URL: "http://x", HINDSIGHT_API_KEY: "" },
    ];
    for (const env of cases) {
      for (const [k, v] of Object.entries(env)) process.env[k] = v;
      const b = brief();
      const primed = (await primeDispatchBrief(b, { client: fakeClient({}), recallDir: dir })) as {
        kgContext?: string;
      };
      expect(primed).toBe(b);
      expect(primed.kgContext).toBeUndefined();
      // No row file at all — absent, not zero.
      expect(rowFileExists(`${RUN_ID}.json`)).toBe(false);
      expect(kgRecallEntries().length).toBe(0);
      for (const k of ENV_KEYS) delete process.env[k];
    }
  });
});

// ---------------------------------------------------------------------------
// describe 3 — side channel round trip
// ---------------------------------------------------------------------------

describe("side channel round trip", () => {
  test("row written → read back → recalledDocumentIds feed a probe recall that finds the retained outcome document", async () => {
    configEnv();
    const outcome = {
      memoryId: "outcome-fact",
      content: "run outcome: exit ok, bundle archived",
      score: 1,
      documentId: OUTCOME_DOC_ID,
    };
    const client = fakeClient({
      recall: async (bankId) =>
        bankId === REPO_BANK
          ? { results: [outcome], durationMs: 2 }
          : { results: [], durationMs: 1 },
    });
    const primed = await primeDispatchBrief(brief(), { client, recallDir: dir });
    expect(typeof (primed as { kgContext?: string }).kgContext).toBe("string");

    // 1. Row written with a trailing newline, EXACT seven-key shape.
    const raw = readFileSync(join(dir, `${RUN_ID}.json`), "utf8");
    expect(raw.endsWith("\n")).toBe(true);
    const row = JSON.parse(raw) as RecallRow;
    expect(Object.keys(row).sort()).toEqual(ROW_KEYS);
    expect(row.recalledDocumentIds).toContain(OUTCOME_DOC_ID);

    // 2. M1.3's input contract: probe recall keyed on the row's retained ids
    //    finds the outcome document among the results.
    const probe = fakeClient({
      recall: async (_bankId, query) =>
        query.includes(OUTCOME_DOC_ID)
          ? { results: [outcome], durationMs: 1 }
          : { results: [], durationMs: 1 },
    });
    for (const expected of row.recalledDocumentIds) {
      const probeRes = await probe.recall(REPO_BANK, expected, KG_RECALL_LIMIT);
      const found = probeRes.results.map((r) => r.documentId);
      expect(found).toContain(expected);
      expect(found).toContain(OUTCOME_DOC_ID); // the retained outcome document itself
    }
  });

  test("recalledDocumentIds are in RANK order and the top-ranked retained document is probe-recoverable", async () => {
    configEnv();
    const docHigh = "qds-20261006-rank-high";
    const docLow = "qds-20261006-rank-low";
    const byDoc: Record<string, { memoryId: string; content: string; score: number; documentId: string }> = {
      [docHigh]: { memoryId: "fact-high", content: "top-ranked outcome", score: 1, documentId: docHigh },
      [docLow]: { memoryId: "fact-low", content: "lower-ranked outcome", score: 1, documentId: docLow },
    };
    const client = fakeClient({
      recall: async (bankId) =>
        bankId === REPO_BANK
          ? {
              // Deliberately unranked on the wire: low score arrives first.
              results: [
                { memoryId: "fact-low", content: "lower-ranked outcome", score: 0.4, documentId: docLow },
                { memoryId: "fact-high", content: "top-ranked outcome", score: 0.9, documentId: docHigh },
                { memoryId: "fact-nodoc", content: "no document identity", score: 0.95, documentId: null },
              ],
              durationMs: 2,
            }
          : { results: [], durationMs: 1 },
    });
    const primed = await primeDispatchBrief(brief(), { client, recallDir: dir });
    // The block itself proves the rank: high before low, null-documentId fact cited but absent from docIds.
    const kg = (primed as { kgContext?: string }).kgContext ?? "";
    expect(kg.indexOf('id="fact-high"')).toBeLessThan(kg.indexOf('id="fact-low"'));

    const row = readRow();
    expect(row.recalledDocumentIds).toEqual([docHigh, docLow]); // rank order, nulls excluded
    // M1.3 probe: the FIRST expected id recovers the top-ranked outcome document.
    const probe = fakeClient({
      recall: async (_bankId, query) =>
        query in byDoc ? { results: [byDoc[query]], durationMs: 1 } : { results: [], durationMs: 1 },
    });
    const top = await probe.recall(REPO_BANK, row.recalledDocumentIds[0] ?? "", KG_RECALL_LIMIT);
    expect(top.results[0]?.documentId).toBe(docHigh);
  });
});
