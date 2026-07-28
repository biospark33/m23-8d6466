/**
 * Secret redaction + excerpt caps (INV-2). Extracted verbatim from runner.ts
 * (#62): this is the security layer where both prior fixes landed (`36b2eeb`
 * linear KMP boundary redaction, `967f47b` full terminal match). It is pure —
 * no spawn, no fs, no process state — so it is testable on its own
 * (test/redact.test.ts).
 */

import type { EnvMap } from "./env.ts";

/** Hard cap on captured subprocess stdout kept in memory / emitted. */
export const MAX_STDOUT_EXCERPT = 256 * 1024;

/** Hard cap on the extracted QDS_PROBE value. */
export const MAX_PROBE_RESULT_LEN = 1024;

/**
 * Parent-env KEY NAMES whose values look secret-ish. Values under such keys
 * are redacted from stdout_excerpt / env_probe_result (INV-2 hardening).
 * Heuristic: high-signal secret-bearing key patterns only, plus the
 * MIN_REDACTABLE_VALUE_LEN floor below.
 */
export const SECRET_KEY_RE =
  /SECRET|TOKEN|PASS|CRED|API[_-]?KEY|PRIVATE|CERT|DSN|DATABASE_URL|SSH|SIGNING|AUTH|[_-]KEY|[_-]URL|[_-]URI/i;

/** Short values are ignored to avoid mangling output with false positives. */
export const MIN_REDACTABLE_VALUE_LEN = 8;

/** Minimum trailing-prefix length redacted at the truncation cut boundary. */
export const MIN_BOUNDARY_PREFIX_LEN = MIN_REDACTABLE_VALUE_LEN;

/**
 * Enforce the excerpt cap (measured in UTF-16 code units, matching
 * String.prototype.length) without leaving a trailing unpaired surrogate
 * from a sliced pair.
 */
export function capExcerpt(text: string): string {
  return text.slice(0, MAX_STDOUT_EXCERPT).replace(/[\uD800-\uDBFF]$/, "");
}

/**
 * Enforce the probe-result cap (measured in UTF-16 code units) without
 * leaving a trailing unpaired surrogate.
 */
export function capProbe(value: string): string {
  return value.slice(0, MAX_PROBE_RESULT_LEN).replace(/[\uD800-\uDBFF]$/, "");
}

/**
 * Redact secret-looking PARENT env values from a string (INV-2 hardening).
 * Only the pre-merge parent env is consulted: manifest-supplied values (e.g.
 * the QDS_PROBE probe) are never redacted.
 *
 * Candidates are processed longest-value-first so a shorter secret that is a
 * substring of a longer one cannot replace inside the longer occurrence and
 * leave the longer secret's tail leaking.
 */
function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\-]/g, "\\$&");
}

export function redactSecrets(text: string, parentEnv: EnvMap): string {
  const entries = Object.entries(parentEnv)
    .filter(
      ([key, value]) =>
        value.length >= MIN_REDACTABLE_VALUE_LEN && SECRET_KEY_RE.test(key),
    )
    .sort((a, b) => b[1].length - a[1].length);
  if (entries.length === 0) return text;

  const valueToKey = new Map<string, string>();
  const patterns: string[] = [];
  for (const [key, value] of entries) {
    if (!valueToKey.has(value)) {
      valueToKey.set(value, key);
      patterns.push(escapeRegex(value));
    }
  }
  const re = new RegExp(patterns.join("|"), "g");
  return text.replace(re, (match) => `[REDACTED:${valueToKey.get(match)!}]`);
}

/**
 * Length of the longest prefix of `value` that is also a suffix of `text`
 * (0 if no non-empty prefix qualifies). Linear time via the KMP automaton:
 * O(value.length) to build the failure function, O(text.length) to scan — so
 * boundary redaction of an arbitrarily long secret is O(text.length +
 * value.length) per env var, not the O(text × value) quadratic the naive
 * suffix scan hits on adversarial divergent input. Only tests UTF-16 code-unit
 * equality, never slices into the middle of a surrogate pair.
 */
function longestPrefixSuffix(text: string, value: string): number {
  if (value.length === 0 || text.length === 0) return 0;
  // KMP failure function for the pattern (value).
  const pi = new Array<number>(value.length).fill(0);
  for (let i = 1, k = 0; i < value.length; i++) {
    while (k > 0 && value[i] !== value[k]) k = pi[k - 1]!;
    if (value[i] === value[k]) k++;
    pi[i] = k;
  }
  // Drive the automaton over text; the terminal state is the longest prefix of
  // `value` that is a suffix of `text`. On a full match mid-text, reset j to the
  // longest proper border so the scan can keep looking for further matches — but
  // at the terminal position PRESERVE j === value.length: if text ends with the
  // complete value, the longest qualifying prefix is the value itself, not a
  // smaller border. The caller's `k >= value.length` fallback decides policy
  // (redactSecrets already removed complete occurrences); the helper just reports
  // the true prefix-suffix length.
  let j = 0;
  for (let i = 0; i < text.length; i++) {
    while (j > 0 && text[i] !== value[j]) j = pi[j - 1]!;
    if (text[i] === value[j]) j++;
    if (j === value.length && i < text.length - 1) j = pi[j - 1]!;
  }
  return j;
}

/**
 * Redact a TRAILING partial prefix of a secret value left at the truncation
 * cut boundary (INV-2). When the excerpt was capped mid-value, the full value
 * no longer matches — but its prefix at the cut still leaks.
 *
 * If the trailing fragment is at least MIN_BOUNDARY_PREFIX_LEN, it is replaced
 * with a redaction marker. If it is shorter than that minimum, the fragment is
 * stripped entirely (no marker, no leaked secret characters, no output
 * mangling).
 */
export function redactBoundaryPrefix(text: string, parentEnv: EnvMap): string {
  let bestRedact: { key: string; len: number } | null = null;
  let bestStrip = 0;

  for (const [key, value] of Object.entries(parentEnv)) {
    if (value.length < MIN_REDACTABLE_VALUE_LEN || !SECRET_KEY_RE.test(key)) {
      continue;
    }
    // Largest k where text ends with value[0..k) — the true prefix-suffix
    // length, in linear time. The previous capped scan (maxK ≤ 4096) leaked the
    // WHOLE fragment when a >4KB secret prefix sat at the truncation cut: no
    // k ≤ 4096 matched the true length, so nothing was redacted. KMP has no cap,
    // so the full boundary prefix is redacted regardless of secret length.
    let k = longestPrefixSuffix(text, value);
    if (k === 0) continue;
    // Complete occurrences are already removed by redactSecrets() before this
    // scan; cap defensively excludes a full trailing match.
    if (k >= value.length) k = value.length - 1;
    if (k >= MIN_BOUNDARY_PREFIX_LEN) {
      if (bestRedact === null || k > bestRedact.len) {
        bestRedact = { key, len: k };
      }
    } else if (k > bestStrip) {
      bestStrip = k;
    }
  }

  if (bestRedact !== null) {
    return `${text.slice(0, text.length - bestRedact.len)}[REDACTED:${bestRedact.key}]`;
  }
  if (bestStrip > 0) {
    return text.slice(0, text.length - bestStrip);
  }
  return text;
}
