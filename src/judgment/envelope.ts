/**
 * Provenance envelope (JEV-2): the typed result of one judgment call.
 *
 * Provenance rides WITH the answer set so any later consumer can state what
 * was sent, to which model, at what cost. `latency_ms` is measured around
 * `judge()` and feeds the handoff §3.12 A/B latency metric. Volatile fields
 * (answer values, confidence) live in the envelope and on the log line —
 * NEVER in the digest-stable side-channel detail (INV-J3, emit.ts).
 */

import { z } from "zod";
import { AnswerSchema, QuestionSchema, TYPESAFE_MODEL, UsageSchema } from "./schemas.ts";

export const EnvelopeSchema = z
  .object({
    requestId: z.string().min(1),
    model: z.literal(TYPESAFE_MODEL),
    questions: z.record(QuestionSchema),
    answers: z.record(AnswerSchema),
    usage: UsageSchema,
    latency_ms: z.number().nonnegative(),
    egress_class: z.string(),
    created_at: z.string().refine((s) => !Number.isNaN(Date.parse(s)), {
      message: "created_at must be an ISO-8601 timestamp",
    }),
  })
  .strict();

export type JudgmentEnvelope = z.infer<typeof EnvelopeSchema>;
