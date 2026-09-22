/**
 * src/judgment public surface — the TypeSafe (Jev) judgment core (JEV-2).
 * JEV-3 (S1 observer) is the sole Wave-3 consumer.
 */

export {
  DEFAULT_MAX_ATTEMPTS,
  DEFAULT_WARN_STATE_CHARS,
  JUDGE_TIMEOUT_MS,
  JudgmentClient,
  JudgmentConfigError,
  JudgmentHttpError,
  TYPESAFE_API_URL,
  TYPESAFE_MODEL,
  type JudgeOptions,
  type JudgmentClientOptions,
} from "./client.ts";
export {
  CeilingExceededError,
  DEFAULT_STAGE_CEILING_INPUT_TOKENS,
  JudgmentCeiling,
} from "./ceiling.ts";
export {
  DEFAULT_MAX_EGRESS_CLASS,
  egress,
  EGRESS_CLASSES,
  EgressRefusedError,
  redactForEgress,
  type EgressClass,
} from "./egress.ts";
export { DEFAULT_PROVENANCE_DIR, detailFromEnvelope, DigestDivergenceError, emitProvenance, provenanceDigest, type ProvenanceDetail } from "./emit.ts";
export { EnvelopeSchema, type JudgmentEnvelope } from "./envelope.ts";
export {
  JudgmentRequestSchema,
  makeJudgmentResponseSchema,
  QuestionSchema,
  StateSchema,
  UsageSchema,
  type Answer,
  type JudgmentRequest,
  type JudgmentResponse,
  type Question,
  type Usage,
} from "./schemas.ts";
