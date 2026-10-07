/**
 * M1.2 AC1/AC2 — the dispatch kg seam, pinned through the REAL
 * `ingestBriefJson` (fleet.ts's shared brief ingress of dispatch/fanout/
 * submit) via `__fleetTestHooks`. What is under test is the WIRING, not a
 * copy of it:
 *   (a) memory env unconfigured  → the parse comes back byte-identical, no
 *       `kgContext` key, no recall attempted (v5-identical dispatch);
 *   (b) env set + a live local Hindsight stand-in → the brief GAINS
 *       `kgContext`, assembled over exactly the fan-out set
 *       {<repo bank>, qds-collective} (the `-dev-meta` exclusion holds at the
 *       seam too), through the REAL client and env path — no injected mock on
 *       the production call;
 *   (c) env set + unreachable endpoint → proceed-unprimed: the ingest still
 *       resolves (the seam never throws, so dispatch's exit table downstream
 *       is untouched), brief unchanged;
 *   (d) the hook identity: the seam delegates to the landed `primeDispatchBrief`
 *       itself (G1's grep proves the call count; this pins WHICH function).
 *
 * Briefs here deliberately carry NO `requestId`: the side-channel row and the
 * `kg-recall` line key on it, so their absence keeps this suite from writing
 * into the repo's `_bmad-output/memory/recall` — the row/log shapes are
 * pinned by tests/hindsight/kg-context.test.ts through `deps.recallDir`.
 *
 * Env save/restore is per-test and total: HINDSIGHT_* must never leak out of
 * (or into) a test.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { __fleetTestHooks } from "../../scripts/fleet.ts";
import { primeDispatchBrief as landedPrimeDispatchBrief } from "../../src/hindsight/kg-context.ts";

const ENV_KEYS = ["HINDSIGHT_BASE_URL", "HINDSIGHT_BEARER_TOKEN", "HINDSIGHT_API_KEY"] as const;
let savedEnv: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>> = {};

beforeEach(() => {
  savedEnv = {};
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    const saved = savedEnv[key];
    if (saved === undefined) delete process.env[key];
    else process.env[key] = saved;
  }
});

/** Dispatch-shaped brief; the fields the seam itself reads are repoSlug/workId. */
const briefJson = (): string =>
  JSON.stringify({
    repoSlug: "acme/widgets",
    workId: "IBOX-1",
    steps: [{ id: "s1", prompt: "do the thing" }],
  });

async function ingest(): Promise<unknown> {
  return __fleetTestHooks.ingestBriefJson(undefined, { readBrief: async () => briefJson() });
}

describe("dispatch kg seam", () => {
  test("(a) env unconfigured → v5-identical parse, no kgContext, no recall", async () => {
    const out = (await ingest()) as Record<string, unknown>;
    // Byte-identical in value: the seam added nothing and removed nothing.
    expect(out).toEqual({
      repoSlug: "acme/widgets",
      workId: "IBOX-1",
      steps: [{ id: "s1", prompt: "do the thing" }],
    });
    expect("kgContext" in out).toBe(false);
  });

  test("(b) env set + local Hindsight → brief gains kgContext over the exact fan-out set", async () => {
    const seen: { method: string; path: string }[] = [];
    const server = Bun.serve({
      port: 0,
      fetch: async (req) => {
        const url = new URL(req.url);
        seen.push({ method: req.method, path: url.pathname });
        if (req.method === "GET" && url.pathname === "/v1/default/banks") {
          // The read leg resolves the PROVISION-TIME bank by family signature
          // (candidate + `-dev-meta` sibling — the pair only the provisioner
          // creates); no pair → proceed-unprimed, which is exactly what this
          // stub's family is here to satisfy.
          return Response.json({ banks: ["acme-widgets", "acme-widgets-dev-meta"] });
        }
        if (req.method === "POST" && url.pathname.endsWith("/memories/recall")) {
          return Response.json({
            results: [
              {
                id: "obs-1",
                content: "prior observation about widgets",
                score: 0.9,
                document_id: "qds-20260101-abc123",
              },
            ],
            durationMs: 1,
          });
        }
        return new Response("not found", { status: 404 });
      },
    });
    try {
      process.env.HINDSIGHT_BASE_URL = `http://127.0.0.1:${server.port}`;
      process.env.HINDSIGHT_BEARER_TOKEN = "test-token-not-a-secret";

      const out = (await ingest()) as Record<string, unknown>;

      // The brief GAINS the appendix; the input shape is otherwise untouched.
      const kg = out.kgContext;
      expect(typeof kg).toBe("string");
      expect(kg as string).toContain("<kg_context>");
      expect(kg as string).toContain('id="obs-1"');
      expect(kg as string).toContain('documentId="qds-20260101-abc123"');
      expect(kg as string).toContain("prior observation about widgets");
      expect(kg as string).toContain("[cite:");
      // The appendix is the ONLY change.
      const { kgContext: _kg, ...rest } = out;
      expect(rest).toEqual({
        repoSlug: "acme/widgets",
        workId: "IBOX-1",
        steps: [{ id: "s1", prompt: "do the thing" }],
      });
      // The fan-out set is EXACTLY {<provision-time repo bank>, qds-collective}
      // — one listBanks, one recall per bank, no `-dev-meta` probe. Sorted:
      // the two recalls are parallel requests, so arrival order is not the
      // assertion — the SET is.
      const recalls = seen.filter((r) => r.path.endsWith("/memories/recall")).map((r) => r.path);
      expect(recalls.slice().sort()).toEqual([
        "/v1/default/banks/acme-widgets/memories/recall",
        "/v1/default/banks/qds-collective/memories/recall",
      ]);
      expect(seen.filter((r) => r.path === "/v1/default/banks")).toHaveLength(1);
    } finally {
      server.stop(true);
    }
  });

  test("(c) env set + unreachable endpoint → proceed-unprimed, ingest still resolves", async () => {
    // Port 1 (tcpmux) refuses on any sane host: the client's listBanks fails
    // at the transport, and the seam must hand the parse back UNPRIMED — the
    // resolve (not a throw) is what keeps dispatch's exit table exactly v5's.
    process.env.HINDSIGHT_BASE_URL = "http://127.0.0.1:1";
    process.env.HINDSIGHT_BEARER_TOKEN = "test-token-not-a-secret";

    const out = (await ingest()) as Record<string, unknown>;
    expect("kgContext" in out).toBe(false);
    expect(out).toEqual({
      repoSlug: "acme/widgets",
      workId: "IBOX-1",
      steps: [{ id: "s1", prompt: "do the thing" }],
    });
  });

  test("(d) the seam IS the landed prime — hook identity pinned", () => {
    expect(__fleetTestHooks.primeDispatchBrief).toBe(landedPrimeDispatchBrief);
    expect(typeof __fleetTestHooks.ingestBriefJson).toBe("function");
  });
});
