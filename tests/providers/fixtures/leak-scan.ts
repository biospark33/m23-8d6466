/**
 * Shared leak scanner for DF2.4 tests (AC5/INV-4).
 *
 * Fragment length is sourced from the redactor's own boundary constant so the
 * scanner tracks the redaction rule instead of re-hard-coding 8 in every test.
 */
import { MIN_REDACTABLE_LEN } from "../../../src/providers/cap-rejection.ts";

export { MIN_REDACTABLE_LEN };

/** Any >=MIN_REDACTABLE_LEN-char substring of the secret found in any corpus, else null. */
export function leakScan(secret: string, ...corpora: string[]): string | null {
  for (let i = 0; i + MIN_REDACTABLE_LEN <= secret.length; i++) {
    const frag = secret.slice(i, i + MIN_REDACTABLE_LEN);
    for (const corpus of corpora) {
      if (corpus.includes(frag)) return frag;
    }
  }
  return null;
}

/** Scan JSON-stringified artifact for leaked secret fragments. */
export function scanArtifactForLeak(secret: string, artifact: unknown): string | null {
  return leakScan(secret, JSON.stringify(artifact));
}
