/**
 * TypeSafe Jev request/response schemas — strict zod, pinned to
 * tests/judgment/typesafe-api-contract.json (handoff §4, §3.6).
 *
 * Strict-at-runtime is a deliberate divergence from the hindsight precedent:
 * this client is RECORDING-ONLY, so a refused judgment is safer than an
 * unparsed one. An upstream model repoint fails validation here rather than
 * flowing through (an unparsed response can never gate anything, and nothing
 * gates on these answers yet).
 *
 * `questions` is discriminated on `type` — NOT one loose `criteria?`
 * free-for-all: `choice` requires a map of ≤255 options, `score` requires an
 * ordered array of 2–10 levels, `noul` takes `{true?, false?}` optionally.
 * The response `model` is a pinned literal — the only automated
 * model-identity guard.
 */

import { z } from "zod";

/** The pinned model id. NEVER the `jev-latest` alias (aliases repoint silently). */
export const TYPESAFE_MODEL = "jev-1.13.0";

// ---------------------------------------------------------------------------
// Request
// ---------------------------------------------------------------------------

export const StateSchema = z.union([z.string(), z.record(z.unknown()), z.array(z.unknown())]);

export const ChoiceQuestionSchema = z
  .object({
    type: z.literal("choice"),
    instructions: z.string().min(1),
    criteria: z
      .record(z.string().min(1))
      .refine((m) => Object.keys(m).length <= 255, {
        message: "choice criteria exceeds 255 options",
      }),
  })
  .strict();

export const ScoreQuestionSchema = z
  .object({
    type: z.literal("score"),
    instructions: z.string().min(1),
    criteria: z.array(z.string().min(1)).min(2).max(10),
  })
  .strict();

export const NoulQuestionSchema = z
  .object({
    type: z.literal("noul"),
    instructions: z.string().min(1),
    criteria: z
      .object({ true: z.string().optional(), false: z.string().optional() })
      .strict()
      .optional(),
  })
  .strict();

export const QuestionSchema = z.discriminatedUnion("type", [
  ChoiceQuestionSchema,
  ScoreQuestionSchema,
  NoulQuestionSchema,
]);

export const JudgmentRequestSchema = z
  .object({
    model: z.literal(TYPESAFE_MODEL),
    state: StateSchema,
    questions: z.record(QuestionSchema),
  })
  .strict();

// ---------------------------------------------------------------------------
// Response
// ---------------------------------------------------------------------------

const ProbabilitiesSchema = z.record(z.number().min(0).max(1));

export const NoulAnswerSchema = z.object({ type: z.literal("noul"), noul: z.number().min(0).max(1) }).strict();

export const ChoiceAnswerSchema = z
  .object({
    type: z.literal("choice"),
    choice: z.string(),
    probabilities: ProbabilitiesSchema,
    confidence: z.number().min(0).max(1),
  })
  .strict();

export const ScoreAnswerSchema = z
  .object({
    type: z.literal("score"),
    score: z.string(),
    legend: z.array(z.string()),
    probabilities: ProbabilitiesSchema,
    confidence: z.number().min(0).max(1),
  })
  .strict();

export const AnswerSchema = z.discriminatedUnion("type", [
  NoulAnswerSchema,
  ChoiceAnswerSchema,
  ScoreAnswerSchema,
]);

export const UsageSchema = z
  .object({
    input_tokens: z.number().int().nonnegative(),
    output_tokens: z.number().int().nonnegative(),
  })
  .strict();

/**
 * Response schema parameterized by the ids the request ASKED, so
 * `answers ⊆ questions` is enforced by the zod path itself (AC-4) — an
 * answer to an unasked id fails validation and no envelope is built.
 */
export function makeJudgmentResponseSchema(askedQuestionIds: readonly string[]) {
  const asked = new Set(askedQuestionIds);
  return z
    .object({
      model: z.literal(TYPESAFE_MODEL),
      answers: z.record(AnswerSchema),
      usage: UsageSchema,
    })
    .strict()
    .superRefine((res, ctx) => {
      for (const qid of Object.keys(res.answers)) {
        if (!asked.has(qid)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["answers", qid],
            message: `response answers unasked question id "${qid}" — answers must be a subset of the asked question ids`,
          });
        }
      }
    });
}

// ---------------------------------------------------------------------------
// Type inferences
// ---------------------------------------------------------------------------

export type State = z.infer<typeof StateSchema>;
export type ChoiceQuestion = z.infer<typeof ChoiceQuestionSchema>;
export type ScoreQuestion = z.infer<typeof ScoreQuestionSchema>;
export type NoulQuestion = z.infer<typeof NoulQuestionSchema>;
export type Question = z.infer<typeof QuestionSchema>;
export type JudgmentRequest = z.infer<typeof JudgmentRequestSchema>;
export type Answer = z.infer<typeof AnswerSchema>;
export type Usage = z.infer<typeof UsageSchema>;
export type JudgmentResponse = z.infer<ReturnType<typeof makeJudgmentResponseSchema>>;
