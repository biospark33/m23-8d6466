/**
 * Envelope types (Story DF1.2).
 *
 * Agents hand each other typed envelopes; code blocks return
 * `QualityCheckResult`. `asEnvelope` (in `adapter.ts`) is the adapter between
 * the two, so a failing lint or test run flows back to the builder through
 * exactly the same door a tester agent's report used to — the pipeline script
 * is the only thing that knows the difference (`MOD/data_types.py:240-244`,
 * `MOD/quality.py:196-199`; R4 §1.3).
 *
 * `ExitStatus` is the CC-1 5-value taxonomy imported from
 * `cli-anything/src/types.ts` — imported directly, not via
 * `../types.ts`, so the shared declarations file can type-import `Envelope`
 * without a cycle.
 */
import type { ExitStatus } from "../../../cli-anything/src/types.ts";

/**
 * One requirement from the requester's words, with whether it was met. The
 * evidence lives in `note` — where it is, or what is missing
 * (`MOD/data_types.py:107-120`).
 */
export interface ReviewFinding {
  requirement: string;
  met: boolean;
  note: string;
}

/**
 * The kind of report travelling in the envelope. Deliberately NOT a
 * "deterministic vs agent" distinction — a consumer reading only the envelope
 * cannot tell which produced it (AC2).
 */
export type EnvelopeKind = "generic" | "verify" | "review" | "changes";

/**
 * The one report type every phase handoff carries. Deterministic subprocess
 * results enter through `asEnvelope`; agent reports enter as-is.
 */
export interface Envelope {
  kind: EnvelopeKind;
  label: string;
  status: ExitStatus;
  summary: string;
  /** Tail of stdout+stderr, verbatim and unparsed, redacted at the adapter boundary (INV-2). */
  outputTail?: string;
  artifacts?: string[];
  /** Claim of which files changed — what `diffMatchesClaims` examines. */
  changedFiles?: string[];
  approved?: boolean;
  /** What must change before approval. */
  blocking?: string[];
  findings?: ReviewFinding[];
}

/**
 * What a deterministic code block produces. `spawnEnv` is redaction input
 * only (INV-6): it is handed to `redactSecrets` and then dropped — never
 * journaled, traced, or serialized. A `QualityCheckResult` crossing a
 * serialization boundary crosses it without that field.
 */
export interface QualityCheckResult {
  name: string;
  command: string[];
  exitCode: number;
  outputTail: string;
  outputArtifact: string;
  spawnEnv: Record<string, string>;
}
