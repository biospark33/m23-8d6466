/**
 * Public API for the M3.2 learning layer (hindsight/index.ts idiom).
 * Consumers: scripts/memory-weekly.ts, tests/learning/*, and the future
 * operator-facing surfaces. Re-exports the stable contract only.
 */

export {
  J2_GATE_NOTE,
  MIN_DECISIONS_FOR_TUNING,
  RECURRING_CLASS_THRESHOLD,
  REFLECT_QUERY_CHAR_CAP,
  TIER_COST_LADDER,
  buildReflectQuery,
  composeProposals,
} from "./compose.ts";
export type { ComposeInput, ReflectEntry } from "./compose.ts";

export {
  DEFAULT_KPI_SNAPSHOTS_DIR,
  DEFAULT_ROUTING_LOG_PATH,
  DEFAULT_RUNS_DIR,
  JEV_SKIPPED_REASONS,
  MAX_RUN_RECORDS,
  RoutingLogLineSchema,
  GatherFault,
  gatherEvidence,
} from "./gather.ts";
export type { AbsentSource, GatherErrorCode, GatheredEvidence, KpiSnapshotRef, RoutingLogLine, RunRecordRef } from "./gather.ts";

export {
  PROPOSAL_KINDS,
  PROPOSAL_RATIONALE_CHAR_CEILING,
  PROPOSAL_SCHEMA_LITERAL,
  ProposalSchema,
  RECEIPT_SCHEMA_LITERAL,
  WeeklyReceiptSchema,
  isoWeekOf,
  isoWeekStartUtc,
} from "./proposal-schema.ts";
export type { ProposalKind, ProposalRecord, WeeklyReceipt } from "./proposal-schema.ts";

export {
  DEFAULT_PROPOSALS_DIR,
  RETAIN_CONTENT_BYTE_CEILING,
  WEEKLY_WALL_CLOCK_BUDGET_MS,
  composeOperatorSummary,
  composeOperatorText,
  runWeeklyReflect,
} from "./weekly-reflect.ts";
export type { WeeklyDeps, WeeklyResult } from "./weekly-reflect.ts";
