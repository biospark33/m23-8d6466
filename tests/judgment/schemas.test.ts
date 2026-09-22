/**
 * Strict request/response schema tests (JEV-2 AC-4).
 *
 * Every schema here is `.strict()` — an unknown top-level key, a missing
 * required field, or an answer to a question that was never asked must fail
 * the zod path so no envelope is ever built from an unparsed body.
 */
import { describe, expect, test } from "bun:test";
import {
  ChoiceQuestionSchema,
  JudgmentRequestSchema,
  NoulQuestionSchema,
  ScoreQuestionSchema,
  makeJudgmentResponseSchema,
  TYPESAFE_MODEL,
} from "../../src/judgment/schemas.ts";

const NQ = { probe: { type: "noul", instructions: "Is this a real defect?" } };

describe("JudgmentRequestSchema", () => {
  test("minimal valid request (noul, no criteria — criteria optional for noul)", () => {
    expect(JudgmentRequestSchema.safeParse({ model: TYPESAFE_MODEL, state: "s", questions: NQ }).success).toBe(true);
  });

  test("state accepts string, object and array (caller's serialization choice)", () => {
    for (const state of ["text", { a: 1 }, [1, 2]]) {
      expect(JudgmentRequestSchema.safeParse({ model: TYPESAFE_MODEL, state, questions: NQ }).success).toBe(true);
    }
    expect(JudgmentRequestSchema.safeParse({ model: TYPESAFE_MODEL, state: 7, questions: NQ }).success).toBe(false);
  });

  test("model literal is pinned — anything else fails (INV: never jev-latest)", () => {
    expect(JudgmentRequestSchema.safeParse({ model: "jev-latest", state: "s", questions: NQ }).success).toBe(false);
    expect(JudgmentRequestSchema.safeParse({ model: "jev-1.14.0", state: "s", questions: NQ }).success).toBe(false);
  });

  test("unknown top-level key fails (strict)", () => {
    const bad = { model: TYPESAFE_MODEL, state: "s", questions: NQ, temperature: 0 };
    expect(JudgmentRequestSchema.safeParse(bad).success).toBe(false);
  });

  test("questions map requires instructions on every entry", () => {
    const bad = { model: TYPESAFE_MODEL, state: "s", questions: { q: { type: "noul" } } };
    expect(JudgmentRequestSchema.safeParse(bad).success).toBe(false);
  });

  test("unknown question type fails", () => {
    const bad = { model: TYPESAFE_MODEL, state: "s", questions: { q: { type: "essay" } } };
    expect(JudgmentRequestSchema.safeParse(bad).success).toBe(false);
  });
});

describe("per-type criteria (discriminated, not one loose criteria)", () => {
  test("choice REQUIRES a criteria map; >255 options fails", () => {
    expect(ChoiceQuestionSchema.safeParse({ type: "choice", instructions: "i", criteria: { a: "opt a" } }).success).toBe(true);
    expect(ChoiceQuestionSchema.safeParse({ type: "choice", instructions: "i" }).success).toBe(false);
    const tooMany = Object.fromEntries(Array.from({ length: 256 }, (_, i) => [`o${i}`, "opt"]));
    expect(ChoiceQuestionSchema.safeParse({ type: "choice", instructions: "i", criteria: tooMany }).success).toBe(false);
    // Empty option labels are not options.
    expect(ChoiceQuestionSchema.safeParse({ type: "choice", instructions: "i", criteria: { a: "" } }).success).toBe(false);
  });

  test("score REQUIRES ordered criteria array of 2-10 levels", () => {
    const ok = { type: "score", instructions: "i", criteria: ["low", "high"] };
    expect(ScoreQuestionSchema.safeParse(ok).success).toBe(true);
    expect(ScoreQuestionSchema.safeParse({ type: "score", instructions: "i" }).success).toBe(false);
    expect(ScoreQuestionSchema.safeParse({ type: "score", instructions: "i", criteria: ["only"] }).success).toBe(false);
    const eleven = Array.from({ length: 11 }, (_, i) => `l${i}`);
    expect(ScoreQuestionSchema.safeParse({ type: "score", instructions: "i", criteria: eleven }).success).toBe(false);
  });

  test("noul takes criteria optionally as {true?, false?} — unknown keys fail", () => {
    expect(NoulQuestionSchema.safeParse({ type: "noul", instructions: "i" }).success).toBe(true);
    expect(NoulQuestionSchema.safeParse({ type: "noul", instructions: "i", criteria: { true: "yes because" } }).success).toBe(true);
    expect(NoulQuestionSchema.safeParse({ type: "noul", instructions: "i", criteria: { true: "y", false: "n" } }).success).toBe(true);
    expect(NoulQuestionSchema.safeParse({ type: "noul", instructions: "i", criteria: { maybe: "m" } }).success).toBe(false);
  });
});

describe("makeJudgmentResponseSchema — strict + answers ⊆ asked", () => {
  const asked = Object.keys(NQ);
  const schema = makeJudgmentResponseSchema(asked);
  const usage = { input_tokens: 10, output_tokens: 1 };

  test("valid noul answer parses; model literal is pinned", () => {
    const body = { model: TYPESAFE_MODEL, answers: { probe: { type: "noul", noul: 1 } }, usage };
    expect(schema.safeParse(body).success).toBe(true);
    expect(schema.safeParse({ ...body, model: "jev-latest" }).success).toBe(false);
  });

  test("missing usage field fails", () => {
    const body = { model: TYPESAFE_MODEL, answers: { probe: { type: "noul", noul: 1 } } };
    expect(schema.safeParse(body).success).toBe(false);
  });

  test("unknown top-level key fails (strict)", () => {
    const body = { model: TYPESAFE_MODEL, answers: {}, usage, id: "x" };
    expect(schema.safeParse(body).success).toBe(false);
  });

  test("answering a question that was not asked fails (answers ⊆ questions)", () => {
    const body = { model: TYPESAFE_MODEL, answers: { never_asked: { type: "noul", noul: 1 } }, usage };
    const parsed = schema.safeParse(body);
    expect(parsed.success).toBe(false);
    if (!parsed.success) expect(JSON.stringify(parsed.error.issues)).toContain("never_asked");
  });

  test("per-type answer shapes are strict — wrong type/fields fail", () => {
    const choiceSchema = makeJudgmentResponseSchema(["c"]);
    const scoreSchema = makeJudgmentResponseSchema(["s"]);
    const choice = { type: "choice", choice: "patch", probabilities: { patch: 0.9, dismiss: 0.1 }, confidence: 0.8 };
    const score = { type: "score", score: "high", legend: ["low", "high"], probabilities: { low: 0.1, high: 0.9 }, confidence: 0.7 };
    expect(choiceSchema.safeParse({ model: TYPESAFE_MODEL, answers: { c: choice }, usage }).success).toBe(true);
    expect(scoreSchema.safeParse({ model: TYPESAFE_MODEL, answers: { s: score }, usage }).success).toBe(true);
    // choice without probabilities / with an extra key
    expect(choiceSchema.safeParse({ model: TYPESAFE_MODEL, answers: { c: { type: "choice", choice: "patch" } }, usage }).success).toBe(false);
    expect(choiceSchema.safeParse({ model: TYPESAFE_MODEL, answers: { c: { ...choice, noul: true } }, usage }).success).toBe(false);
    // score without legend
    expect(scoreSchema.safeParse({ model: TYPESAFE_MODEL, answers: { s: { type: "score", score: "high" } }, usage }).success).toBe(false);
    // confidence outside [0,1]
    expect(choiceSchema.safeParse({ model: TYPESAFE_MODEL, answers: { c: { ...choice, confidence: 1.5 } }, usage }).success).toBe(false);
  });
});
