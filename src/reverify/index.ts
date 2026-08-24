/**
 * Host-side out-of-box re-verification (Story DF5.1).
 *
 * The public surface: `reverify(runId)` and the contract types DF3.4, DF5.2 and
 * DF5.3 read. Test seams (`loadManifestWithSeams`-style internals) stay behind
 * their own modules.
 */
export {
  DEFAULT_REVERIFY_DIR,
  CHECKS_MAX,
  NOTE_MAX_CHARS,
  appendReport,
  readReports,
  reportPath,
  sealReport,
  type RedactionMap,
  type ReverifyEvidence,
  type ReverifyReport,
  type ReverifyVerdict,
} from "./report.ts";
export {
  recordApprovalPort,
  type ApprovalOutcome,
  type ApprovalPort,
  type ApprovalRequest,
  type ApprovalState,
} from "./approval.ts";
export { divergenceFlags, resolveHostPlan, type GateCommand, type HostPlan } from "./plan.ts";
export {
  DEFAULT_RSS_BYTES,
  DEFAULT_WALL_CLOCK_MS,
  ReverifyError,
  probeToolchain,
  sandboxRef,
  withGuards,
  withQuarantineWorktree,
} from "./worktree.ts";
export {
  parseTestCounts,
  readClaimed,
  reverify,
  verifyEnv,
  type ReverifyDeps,
  type ReverifyOutcome,
} from "./runner.ts";
