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
// `runMarkerPath` and `writeTerminalMarker` are deliberately absent: they are
// the journal's on-disk marker layout and the writer that bypasses
// `FileJournal`'s atomic flush/rename path. `phase.ts` already imports them
// directly from `./journal.ts`, and putting them here would let any caller
// depend on the storage layout or write terminal markers outside `FileJournal`
// — the same reasoning `loadManifestWithSeams` gets above.
//
// `runMarkerRoot` IS exported (F056): keeping it off this surface is what
// pushed `scripts/pipeline-run.ts` into re-implementing the derivation inline.
// It exposes a policy (where the run root is), not the storage layout, so
// there is nothing here for a caller to depend on wrongly.
export {
  FileJournal,
  JournalWriteError,
  runMarkerRoot,
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
  looksLikeEnvelope,
  verdictConsistent,
  type Gate,
  type GateContext,
  type GatedBodyOptions,
} from "./gates/library.ts";
export { GateReport, type GateCheck } from "./gates/report.ts";
export { GATE_NOTE_TAIL_CHARS, commandGate, type CommandGateOptions } from "./gates/command-gate.ts";
// DF1.4: trace store — writer, reader, and journal bridge
export {
  Tracer,
  TracerError,
  serializeTraceError,
  type TracerOptions,
} from "./trace/tracer.ts";
export {
  openTraceReader,
  MAX_LIMIT,
  DEFAULT_LIMIT,
  type TraceReader,
} from "./trace/reader.ts";
export { TracingJournal } from "./trace/journal-bridge.ts";
// DF1.6: dispatch_task phase body + phases surface
export {
  dispatchTask,
  type DispatchTaskDeps,
  type DispatchTaskValue,
} from "./phases/dispatch-task.ts";
// DF3.3: engine-owned steering port — solicitation, closed directive union,
// resident telemetry. The fleet side (resident agent) imports this barrel and
// injects the caller; the engine never imports fleet (INV-RES-1).
export {
  MAX_MALFORMED_ATTEMPTS,
  MAX_OUTPUT_TOKENS,
  PROMPT_CHAR_CEILING,
  SOLICIT_TIMEOUT_MS,
  SteeringDirectiveSchema,
  createSteering,
  type ResidentCaller,
  type ResidentStatus,
  type ResidentTelemetry,
  type ResidentTripwire,
  type SolicitCtx,
  type SteeringController,
  type SteeringDirective,
  type SteeringPoint,
} from "./steering.ts";
