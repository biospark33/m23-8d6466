/**
 * src/judgment public surface — the TypeSafe (Jev) judgment core (JEV-2).
 * JEV-3 (S1 observer) is the sole Wave-3 consumer. v6 J1 adds the
 * JudgmentProvider seam's id list + typed refusal (never the makers).
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
// Ids, the typed refusal and the types ONLY: the adapter makers
// (JUDGMENT_PROVIDERS / resolveProvider) are deliberately NOT public. A made
// adapter's ask() skips the egress choke, the ceiling and the strict parse,
// so the only caller allowed to make one is the seam client — pinned by
// tests/judgment/provider.test.ts's repo-wide reach test.
export { JUDGMENT_PROVIDER_IDS, UnknownProviderError, type JudgmentProvider, type JudgmentProviderId } from "./provider.ts";
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
