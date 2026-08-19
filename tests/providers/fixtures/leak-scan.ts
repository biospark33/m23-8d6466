/**
 * Shared leak scanner for DF2.4 tests (AC5/INV-4).
 *
 * Fragment length is sourced from the redactor's own boundary constant so the
 * scanner tracks the redaction rule instead of re-hard-coding 8 in every test.
 * The key-management-URL rule is enforced here too — design.md's
 * "key-management-URL redacted" contract must hold at the shared gate, not
 * only in per-test assertions.
 */
import { KEY_MANAGEMENT_URL_RE, MIN_REDACTABLE_LEN } from "../../../src/providers/cap-rejection.ts";

export { MIN_REDACTABLE_LEN };

/**
 * Any key-management deep-link (openrouter.ai/.../keys/<16+ chars>) found in
 * any corpus, else null.
 */
export function findKeyManagementUrl(...corpora: string[]): string | null {
  for (const corpus of corpora) {
    const hit = corpus.match(KEY_MANAGEMENT_URL_RE);
    if (hit) return hit[0];
  }
  return null;
}

/**
 * Any >=MIN_REDACTABLE_LEN-char substring of the secret found in any corpus,
 * or any key-management URL found in the corpora, else null.
 */
export function leakScan(secret: string, ...corpora: string[]): string | null {
  for (let i = 0; i + MIN_REDACTABLE_LEN <= secret.length; i++) {
    const frag = secret.slice(i, i + MIN_REDACTABLE_LEN);
    for (const corpus of corpora) {
      if (corpus.includes(frag)) return frag;
    }
  }
  return findKeyManagementUrl(...corpora);
}

/** Scan JSON-stringified artifact for leaked secret fragments or key-management URLs. */
export function scanArtifactForLeak(secret: string, artifact: unknown): string | null {
  return leakScan(secret, JSON.stringify(artifact));
}
