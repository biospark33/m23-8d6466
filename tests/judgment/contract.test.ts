/**
 * TypeSafe vendor-contract suite — THE upstream-drift alarm (JEV-2, handoff
 * §3.6), in the tests/gitnexus contract-trio pattern.
 *
 * tests/judgment/typesafe-api-contract.json is the pin. This suite asserts
 * that the client's pinned constants and the zod schemas in src/judgment
 * match it EXACTLY (unknown-key tolerance = zero). A loud failure here means
 * "contract json and schemas diverged — reconcile in one commit".
 *
 * Honest limitation (stated plainly, per the story): this suite NEVER touches
 * the wire, so it cannot by itself detect upstream API drift. The wire check
 * is scripts/judgment/live-probe.ts — steve-gated (TYPESAFE_API_KEY set AND
 * QDS_LIVE_PROBE_CONFIRMED=1), diffing the live response against this same
 * contract json and exiting 2 on drift.
 */
import { describe, expect, test } from "bun:test";
import contract from "./typesafe-api-contract.json";
import {
  DEFAULT_MAX_ATTEMPTS,
  TYPESAFE_API_URL,
  TYPESAFE_MODEL,
} from "../../src/judgment/client.ts";
import { DEFAULT_MAX_EGRESS_CLASS } from "../../src/judgment/egress.ts";
import {
  ChoiceQuestionSchema,
  JudgmentRequestSchema,
  makeJudgmentResponseSchema,
  ScoreQuestionSchema,
} from "../../src/judgment/schemas.ts";

const USAGE = contract.response.usageKeys.reduce<Record<string, number>>((acc, k) => {
  acc[k] = 1;
  return acc;
}, {});

const FATAL = contract.http.fatalFirstAttemptStatuses as number[];
const RETRY = contract.http.retryOnStatuses as number[];

describe("contract pin: client constants match typesafe-api-contract.json", () => {
  test("pinned model id is the contract's model id (never jev-latest)", () => {
    if (TYPESAFE_MODEL !== contract.model) {
      throw new Error(
        `[typesafe contract drift] client pin is "${TYPESAFE_MODEL}" but the contract json pins "${contract.model}". Re-verify against docs.typesafe.ai/models.md, then update contract json + schemas.ts + client constants in ONE commit, then re-run scripts/judgment/live-probe.ts.`,
      );
    }
    expect(TYPESAFE_MODEL).not.toContain("latest");
  });

  test("endpoint matches the contract", () => {
    expect(TYPESAFE_API_URL).toBe(`${contract.endpoint.url}`);
    expect(contract.endpoint.method).toBe("POST");
  });

  test("retry posture matches the contract (429/529 only, 401/422 fatal)", () => {
    expect(DEFAULT_MAX_ATTEMPTS).toBe(contract.http.maxAttempts);
    expect(FATAL).toEqual([401, 422]);
    expect(RETRY).toEqual([429, 529]);
  });

  test("stage-1 egress max is the code-pinned ac-prose (ADR 0001 ACCEPTED)", () => {
    expect(DEFAULT_MAX_EGRESS_CLASS).toBe("ac-prose");
    expect(contract.request.topLevelKeys).toEqual(["model", "state", "questions"]);
    expect(contract.response.topLevelKeys).toEqual(["model", "answers", "usage"]);
  });
});

describe("contract pin: request schemas match the contract's shape rules", () => {
  const q = contract.request.questionTypes;

  test("choice criteria is a REQUIRED map of <=255 options", () => {
    const max = q.choice.criteria.maxOptions;
    const spec = { type: "choice", instructions: "i", criteria: { a: "opt" } };
    expect(ChoiceQuestionSchema.safeParse(spec).success).toBe(true);
    expect(ChoiceQuestionSchema.safeParse({ type: "choice", instructions: "i" }).success).toBe(false);
    const at = Object.fromEntries(Array.from({ length: max }, (_, i) => [`o${i}`, "x"]));
    const over = Object.fromEntries(Array.from({ length: max + 1 }, (_, i) => [`o${i}`, "x"]));
    expect(ChoiceQuestionSchema.safeParse({ ...spec, criteria: at }).success).toBe(true);
    expect(ChoiceQuestionSchema.safeParse({ ...spec, criteria: over }).success).toBe(false);
  });

  test("score criteria is a REQUIRED ordered array of 2-10 levels", () => {
    const { minLevels, maxLevels } = q.score.criteria;
    const at = Array.from({ length: minLevels }, (_, i) => `l${i}`);
    expect(ScoreQuestionSchema.safeParse({ type: "score", instructions: "i", criteria: at }).success).toBe(true);
    expect(ScoreQuestionSchema.safeParse({ type: "score", instructions: "i", criteria: at.slice(0, minLevels - 1) }).success).toBe(false);
    const over = Array.from({ length: maxLevels + 1 }, (_, i) => `l${i}`);
    expect(ScoreQuestionSchema.safeParse({ type: "score", instructions: "i", criteria: over }).success).toBe(false);
  });

  test("noul criteria is OPTIONAL with only {true?, false?} keys", () => {
    expect(q.noul.criteria.required).toBe(false);
    const base = { type: "noul", instructions: "i" };
    const ok = { ...base, criteria: { true: "y", false: "n" } };
    expect(JudgmentRequestSchema.safeParse({
      model: TYPESAFE_MODEL,
      state: "s",
      questions: { n: base },
    }).success).toBe(true);
    // unknown criteria key refused
    expect(JudgmentRequestSchema.safeParse({
      model: TYPESAFE_MODEL,
      state: "s",
      questions: { n: { ...base, criteria: { maybe: "x" } } },
    }).success).toBe(false);
    // (ok-shape sanity through the full request)
    expect(JudgmentRequestSchema.safeParse({ model: TYPESAFE_MODEL, state: "s", questions: { n: ok } }).success).toBe(true);
  });

  test("unknown top-level request key has ZERO tolerance", () => {
    const bad = { model: TYPESAFE_MODEL, state: "s", questions: {}, seed: 1 };
    expect(JudgmentRequestSchema.safeParse(bad).success).toBe(false);
  });
});

describe("contract pin: response schemas match the contract's shape rules", () => {
  test("response model is a literal — a repoint fails validation rather than flowing through", () => {
    const schema = makeJudgmentResponseSchema(["q"]);
    const body = { model: TYPESAFE_MODEL, answers: {}, usage: USAGE };
    expect(schema.safeParse(body).success).toBe(true);
    expect(schema.safeParse({ ...body, model: "jev-1.14.0" }).success).toBe(false);
    expect(schema.safeParse({ ...body, model: "jev-latest" }).success).toBe(false);
  });

  test("answers ⊆ asked question ids is enforced by the schema itself", () => {
    const schema = makeJudgmentResponseSchema(["asked"]);
    const body = { model: TYPESAFE_MODEL, answers: { unasked: { type: "noul", noul: true } }, usage: USAGE };
    expect(schema.safeParse(body).success).toBe(false);
  });

  test("usage carries exactly the contract's keys", () => {
    const schema = makeJudgmentResponseSchema(["q"]);
    const ok = { model: TYPESAFE_MODEL, answers: {}, usage: USAGE };
    const extra = { model: TYPESAFE_MODEL, answers: {}, usage: { ...USAGE, total: 2 } };
    const missing = { model: TYPESAFE_MODEL, answers: {}, usage: { input_tokens: 1 } };
    expect(schema.safeParse(ok).success).toBe(true);
    expect(schema.safeParse(extra).success).toBe(false);
    expect(schema.safeParse(missing).success).toBe(false);
  });

  test("per-answer shapes match the contract's answerShapes exactly", () => {
    const shapes = contract.response.answerShapes;
    expect(shapes.noul.keys).toEqual(["type", "noul"]);
    expect(shapes.choice.keys).toEqual(["type", "choice", "probabilities", "confidence"]);
    expect(shapes.score.keys).toEqual(["type", "score", "legend", "probabilities", "confidence"]);

    const noul = makeJudgmentResponseSchema(["n"]);
    const choice = makeJudgmentResponseSchema(["c"]);
    const score = makeJudgmentResponseSchema(["s"]);
    const wrap = (answers: Record<string, unknown>) => ({ model: TYPESAFE_MODEL, answers, usage: USAGE });

    expect(noul.safeParse(wrap({ n: { type: "noul", noul: true } })).success).toBe(true);
    expect(noul.safeParse(wrap({ n: { type: "noul", noul: true, confidence: 1 } })).success).toBe(false);
    const c = { type: "choice", choice: "patch", probabilities: { patch: 0.9 }, confidence: 0.5 };
    expect(choice.safeParse(wrap({ c })).success).toBe(true);
    expect(choice.safeParse(wrap({ c: { ...c, confidence: undefined } })).success).toBe(false);
    const s = { type: "score", score: "high", legend: ["low", "high"], probabilities: { high: 0.9 }, confidence: 0.5 };
    expect(score.safeParse(wrap({ s })).success).toBe(true);
    expect(score.safeParse(wrap({ s: { type: "score", score: "high" } })).success).toBe(false);
  });

  test("confidence and probabilities are bounded [0,1] numbers", () => {
    const schema = makeJudgmentResponseSchema(["c"]);
    const c = { type: "choice", choice: "patch", probabilities: { patch: 1.5 }, confidence: 0.5 };
    expect(schema.safeParse({ model: TYPESAFE_MODEL, answers: { c }, usage: USAGE }).success).toBe(false);
  });
});
