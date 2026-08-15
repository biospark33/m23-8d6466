/**
 * The envelope adapter (Story DF1.2).
 *
 * `asEnvelope` wraps a deterministic subprocess outcome — a test run, a lint
 * pass — into the same `Envelope` type an agent produces, so the repair loop
 * has one code path instead of two (`MOD/quality.py:193-211`; R4 §1.3).
 *
 * `outputTail` is deliberately raw: the tail of stdout+stderr verbatim and
 * unparsed, because the next agent cannot open a log file it was never handed,
 * and a generic parser over every runner's failure format would be confidently
 * wrong (`MOD/data_types.py:158-163`). The full log stays at `outputArtifact`.
 */
import { redactSecrets } from "../../../cli-anything/src/redact.ts";
import type { Envelope, QualityCheckResult } from "./types.ts";

/**
 * Ceiling on the envelope's `outputTail`. Enough for a builder to act on
 * without opening the artifact; bounded so a runaway stack trace cannot swamp
 * the next agent's context (`MOD/quality.py:46`).
 */
export const OUTPUT_TAIL_CHARS = 4_000;

/**
 * Suffix-inclusive truncation: the ceiling is on the FINAL stored string, not
 * a budget the suffix is added on top of. The suffix width is reserved before
 * cutting, so `result.length <= ceiling` always holds.
 */
export function truncateTail(text: string, ceiling: number = OUTPUT_TAIL_CHARS): string {
  const limit = Math.max(0, ceiling);
  if (text.length <= limit) return text;
  const suffix = `[truncated, ${text.length} chars total]`;
  // A ceiling smaller than the suffix cannot hold text plus suffix; the
  // invariant is on the RESULT, so the suffix itself is cut to fit.
  if (limit <= suffix.length) return suffix.slice(0, limit);
  return `${text.slice(text.length - (limit - suffix.length))}${suffix}`;
}

/**
 * INV-2: redaction happens at this boundary, once, using the env map the
 * subprocess was spawned with (`redactSecrets` is parent-env-derived, not
 * pattern-based). Redaction runs BEFORE truncation so a token split by the
 * cut can never leak a partial. `spawnEnv` itself never enters the envelope
 * (INV-6).
 */
export function asEnvelope(result: QualityCheckResult, label: string): Envelope {
  const passed = result.exitCode === 0;
  const tail = truncateTail(redactSecrets(result.outputTail, result.spawnEnv));
  return {
    kind: "verify",
    label,
    status: passed ? "success" : "logic",
    summary: `${label}: ${result.name} exited ${result.exitCode}`,
    ...(tail.length > 0 ? { outputTail: tail } : {}),
    ...(result.outputArtifact.length > 0 ? { artifacts: [result.outputArtifact] } : {}),
  };
}
