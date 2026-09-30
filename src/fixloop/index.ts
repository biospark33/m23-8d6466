/**
 * DF6.1a fix-loop core — the public surface (PLAN I6, locked; leaf-6 consumes).
 */
export {
  APPROVED_ENV_FILE,
  ATTEMPT_SHA_PLACEHOLDER,
  assertFixCeilingCovered,
  assertSingleFixer,
  buildFixBrief,
  buildFixContextPayload,
  classifyDiffScope,
  commentsDigest,
  countWriteCapable,
  encodeFixContext,
  fetchBotComments,
  FIX_DISPATCH_CEILING_MS,
  FIX_RUN_MANIFEST_PATH,
  FIX_SCOPE_FILE,
  globToRegExp,
  matchGlob,
  MAX_FIX_COMMENTS,
  MAX_FIX_SNIPPET_BYTES_TOTAL,
  MAX_FIX_SNIPPET_CHARS,
  MAX_OMITTED_COMMENT_IDS,
  normalizeBody,
  parseFixContext,
  POLL_WINDOW_OPENED_AT_PLACEHOLDER,
  preflightFixContextWrite,
  probeBoxCredentials,
  readFixScope,
} from "./feedback-run.ts";
export type {
  BotComment,
  BotCommentSet,
  CredentialProbeDriver,
  CredentialProbeResult,
  FixContextPayload,
  FixScopeAction,
  FixScopeDeny,
  FixScopeEntry,
  IssueBudgetSnapshotSource,
  ScopeClassification,
} from "./feedback-run.ts";

// DF6.1b — the CI-verdict poll, the attempt ladder/ceilings, the fixOutcome
// codec and the escalation comment.
export {
  CI_POLL_INTERVAL_MS,
  CI_POLL_WINDOW_MS,
  defaultGhRunner,
  ghRunnerFromToken,
  parseChecksJson,
  pollRequiredChecks,
  probeRequiredChecks,
} from "./ci-status.ts";
export type { CheckEntry, GhResult, GhRunner, PollRequiredChecksOpts, PollVerdict, ProbeResult } from "./ci-status.ts";
export { GhRunnerUnavailableError } from "./ci-status.ts";
export {
  buildEscalationComment,
  CHARGED_CLASSES,
  deriveAttemptLadder,
  fixContextHasRealSha,
  encodeFixOutcome,
  evaluateCeilings,
  LOOP_STOP_CLASSES,
  MAX_CHARGED_ATTEMPTS,
  MAX_OUT_OF_SCOPE_DIFF,
  MAX_UNCHARGED_ATTEMPTS,
  ONCE_PER_PR_CLASSES,
  parseFixOutcome,
  parseFixOutcomeClass,
  postEscalationComment,
  preflightFixOutcomeWrite,
  UNCHARGED_TERMINAL_CLASSES,
} from "./escalation.ts";
export type {
  AttemptEntry,
  BudgetCounts,
  EscalationClass,
  EscalationDiagnostic,
  FixOutcomePayload,
} from "./escalation.ts";
