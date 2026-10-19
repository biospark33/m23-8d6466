// G2: the priming loop closes on ONE bank. A retain via `retainFindings` into
// the slug-resolved provisioned family lands where `primeDispatchBrief`'s
// recall fan-out reads. Proof rides a single Map-backed substrate both sides
// share, so the round trip is a property of the wiring (the retain guard
// accepts exactly the family the recall resolves), not of a mock that already
// knows the answer. Seam gap #11 rides along as a negative control: the legacy
// hand-named bank is refused, so the old dual-bank workaround cannot close
// the loop either.
import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { primeDispatchBrief, type RecallClient } from "../../src/hindsight/kg-context.ts";
import { QaRetainError, retainFindings, type RetainFindingsInput } from "../../src/qa/retain.ts";
import type { HindsightClient } from "../../src/hindsight/client.ts";

const SLUG = "Quantum-Digital-Solutions/QDS-Factory";
const FAMILY = "quantum-digital-solutions-qds-factory";

function makeSubstrate() {
  const docs = new Map<string, Map<string, string>>();
  const banks = new Set<string>([FAMILY, `${FAMILY}-dev-meta`]);
  const client = {
    retain: async (bankId: string, content: string, metadata?: { documentId?: string }) => {
      if (!docs.has(bankId)) docs.set(bankId, new Map());
      docs.get(bankId)!.set(metadata?.documentId ?? `doc-${docs.get(bankId)!.size}`, content);
      return { memoryId: `mem-${Math.random()}`, bankId, status: "created" as const, durationMs: 0 };
    },
    listBanks: async () => ({ banks: [...banks].map((bank_id) => ({ bank_id })) }),
    recall: async (bankId: string) => ({
      // recallFanOut consumes the TRANSFORMED RecallResponse shape
      // (memoryId/content/score/documentId), not the raw wire keys.
      results: [...(docs.get(bankId)?.entries() ?? [])].map(([document_id, text]) => ({
        memoryId: `mem-${document_id}`,
        content: text,
        score: 1,
        documentId: document_id,
      })),
    }),
  };
  return { docs, client: client as unknown as Pick<HindsightClient, "retain"> & RecallClient };
}

function retainInput(over: Partial<RetainFindingsInput> = {}): RetainFindingsInput {
  return {
    repoBankId: FAMILY,
    runId: "qds-20261018-ab12cd",
    lens: "correctness",
    commitSha: `${"b".repeat(39)}1`,
    repoSlug: SLUG,
    requestId: "req-priming-round-trip-1",
    legRan: true,
    findings: [
      {
        runId: "qds-20261018-ab12cd",
        lens: "correctness",
        finding_text: "priming round trip: off-by-one in the bounded review set",
        diff_context_ref: "src/qa/findings.ts:42",
      },
    ],
    ...over,
  };
}

const BRIEF = {
  requestId: "11111111-2222-4333-8444-555555555555",
  repoSlug: SLUG,
  commitSha: "c061869ae68d103a773832748712b8d587d3f4d6",
  manifestPath: "config/rosters/priming-round-trip.pipeline.json",
  workId: "w:qa-20261018t120000z-correctness",
  task: "Dev implement: continue the QA department work.",
};

describe("priming round trip at the primeDispatchBrief seam", () => {
  let dir = "";
  let prevBase = "";
  let prevKey = "";
  let hadBase = false;
  let hadKey = false;

  const setup = () => {
    dir = mkdtempSync(join(tmpdir(), "qds-priming-rt-"));
    hadBase = "HINDSIGHT_BASE_URL" in process.env;
    hadKey = "HINDSIGHT_API_KEY" in process.env;
    prevBase = process.env.HINDSIGHT_BASE_URL ?? "";
    prevKey = process.env.HINDSIGHT_API_KEY ?? "";
    process.env.HINDSIGHT_BASE_URL = "http://127.0.0.1:1";
    process.env.HINDSIGHT_API_KEY = "gate-only";
  };
  const restore = () => {
    const observed: Array<[string, boolean, string]> = [
      ["HINDSIGHT_BASE_URL", hadBase, prevBase],
      ["HINDSIGHT_API_KEY", hadKey, prevKey],
    ];
    for (const [key, had, prev] of observed) {
      if (had) process.env[key] = prev;
      else Reflect.deleteProperty(process.env, key);
    }
    rmSync(dir, { recursive: true, force: true });
  };

  test("a retain into the slug-resolved family is exactly what primeDispatchBrief recalls", async () => {
    setup();
    const { docs, client } = makeSubstrate();
    await retainFindings({ client }, retainInput());
    const primed = await primeDispatchBrief(BRIEF, { client, recallDir: dir });
    const ctx = (primed as { kgContext?: string }).kgContext ?? "";
    expect(ctx).toContain("priming round trip");
    const row = JSON.parse(readFileSync(join(dir, `${BRIEF.requestId}.json`), "utf8"));
    expect(row.primed).toBe(true);
    expect(row.banks).toEqual([FAMILY, "qds-collective"]);
    expect(row.recalledDocumentIds.length).toBe(1);
    expect(docs.get(FAMILY)!.size).toBe(1);
    restore();
  });

  test("seam gap #11 negative: the legacy hand-named bank is refused, so the loop cannot close through it", async () => {
    setup();
    const { docs, client } = makeSubstrate();
    let thrown: unknown;
    try {
      await retainFindings({ client }, retainInput({ repoBankId: "qds-factory" }));
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(QaRetainError);
    expect((thrown as QaRetainError).code).toBe("retain-bank-not-repo");
    expect(docs.get(FAMILY)?.size ?? 0).toBe(0);
    restore();
  });
});
