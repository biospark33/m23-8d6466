/**
 * Phase engine (Story DF1.1) — public surface.
 *
 * A versioned manifest drives an ordered, budget-bounded, journaled phase walk:
 * `loadManifest` → `new Run` → `walkPhases` → `Run.finish`.
 */
// `loadManifestWithSeams` is deliberately absent: its seams can weaken INV-1, so
// they stay off the public surface and the suite imports `manifest.ts` directly.
export {
  ManifestError,
  PhaseAgentSchema,
  PhaseSpecSchema,
  PipelineManifestSchema,
  loadManifest,
  readArtifactBeneathRoot,
  requiredBudgetMs,
  type LoadedManifest,
} from "./manifest.ts";
// `runMarkerPath`, `runMarkerRoot` and `writeTerminalMarker` are deliberately
// absent: they are the journal's on-disk marker layout and the writer that
// bypasses `FileJournal`'s atomic flush/rename path. `phase.ts` already
// imports them directly from `./journal.ts`, and putting them here would let
// any caller depend on the storage layout or write terminal markers outside
// `FileJournal` — the same reasoning `loadManifestWithSeams` gets above.
export {
  FileJournal,
  JournalWriteError,
  type JournalFile,
  type PhaseJournal,
} from "./journal.ts";
export {
  PhaseConstructionError,
  PhaseOverflowError,
  Run,
  RunHaltedError,
  RunTerminatedError,
  assertLegibleDescription,
  walkPhases,
  type FinishResult,
  type PhaseBody,
  type PhaseBodyContext,
  type PhaseBodyFactory,
  type PhaseOutcome,
  type RunOptions,
} from "./phase.ts";
export * from "./types.ts";
// DF1.2: gates with evidence + the unified envelope adapter.
export {
  OUTPUT_TAIL_CHARS,
  asEnvelope,
  truncateTail,
} from "./envelopes/adapter.ts";
export type {
  Envelope,
  EnvelopeKind,
  QualityCheckResult,
  ReviewFinding,
} from "./envelopes/types.ts";
export {
  GateFailureError,
  artifactsExist,
  diffMatchesClaims,
  filesNonEmpty,
  gatedBody,
  jsonParses,
  verdictConsistent,
  type Gate,
  type GateContext,
  type GatedBodyOptions,
} from "./gates/library.ts";
export { GateReport, type GateCheck } from "./gates/report.ts";
export { GATE_NOTE_TAIL_CHARS, commandGate, type CommandGateOptions } from "./gates/command-gate.ts";
