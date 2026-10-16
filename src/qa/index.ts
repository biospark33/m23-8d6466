/**
 * Public API for the A2 QA department (post-merge hunter-pack).
 *
 * Barrel only: re-exports the stable contract of findings / retain / issues —
 * no shaping, no logic. Log-vocabulary split: the factory emits
 * qa-findings-retained + qa-issues-filed host-side (retain / issues); the
 * qa-protocol-start / qa-leg-submitted / qa-leg-terminal events are emitted by
 * the live-round leg driver (story leaf-2.0.1, scripts/qa) and journaled by
 * the fixture as record kinds.
 */

export {
  FindingSchema,
  HarvestOutputSchema,
  MAX_QA_LEGS,
  QA_LENS,
  QA_LOG,
  QaFindingsError,
  QaVerdictProducerSchema,
  normalizeHarvest,
  MAX_FINDINGS_PER_HARVEST,
} from "./findings.ts";

export type {
  Finding,
  HarvestNormalization,
  HarvestOutput,
  QaFindingsErrorCode,
  QaLens,
  QaVerdictProducer,
} from "./findings.ts";

export { QaRetainError, deriveFindingDocumentId, retainFindings } from "./retain.ts";

export type { QaRetainErrorCode, QaRetainResult, RetainFindingsInput } from "./retain.ts";

export { FileIssuesInputSchema, QaIssuesError, fileIssues, isActionable } from "./issues.ts";

export type {
  FileIssuesInput,
  IssuesDeps,
  IssuesFiling,
  QaIssuesErrorCode,
} from "./issues.ts";
