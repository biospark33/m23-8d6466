/**
 * `mock` adapter (v6 J1) — deterministic canned answers, moved verbatim from
 * JEV-2's `mockResponse`. It short-circuits the NETWORK only: its bodies go
 * through the seam's same strict parse as live bodies, and
 * tests/judgment/adapter-contract.test.ts holds them to the live contract.
 *
 * The maker takes no configuration at all — no key path exists here as a
 * type fact (INV-J1), not a convention. Mock is the default transport
 * (INV-J5).
 */

import type { JudgmentProvider } from "../provider.ts";
import { TYPESAFE_MODEL, type JudgmentRequest } from "../schemas.ts";

export function makeMockProvider(): JudgmentProvider {
  return Object.freeze({
    id: "mock" as const,
    ask: async (request: JudgmentRequest, _requestId: string): Promise<unknown> => mockResponse(request),
  });
}

function mockResponse(request: JudgmentRequest): unknown {
  const answers: Record<string, unknown> = {};
  for (const [qid, q] of Object.entries(request.questions)) {
    if (q.type === "noul") {
      answers[qid] = { type: "noul", noul: 0.9 };
    } else if (q.type === "choice") {
      const keys = Object.keys(q.criteria);
      answers[qid] = {
        type: "choice",
        choice: keys[0] ?? "",
        probabilities: Object.fromEntries(keys.map((k, i) => [k, i === 0 ? 1 : 0])),
        confidence: 1,
      };
    } else {
      const legend = q.criteria;
      answers[qid] = {
        type: "score",
        score: legend[0] ?? "",
        legend,
        probabilities: Object.fromEntries(legend.map((k, i) => [k, i === 0 ? 1 : 0])),
        confidence: 1,
      };
    }
  }
  return {
    model: TYPESAFE_MODEL,
    answers,
    usage: { input_tokens: 10, output_tokens: 1 },
  };
}
