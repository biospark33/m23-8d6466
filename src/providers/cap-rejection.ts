/**
 * DF2.4 — CAP-based hit/kill classification and redaction.
 *
 * This story adds one mechanism and no more: pure functions, no I/O.
 *
 * AC2: overflow classification iff usage >= cap AND providerCapRejected===true
 *      AND terminationProvenance is NOT "wall-clock" or "host-error".
 * AC5: redactWithKey replaces >=8-char substrings of secret with [REDACTED].
 */

/**
 * CC-1 MIRROR: InBoxExit mirrors cli-anything/src/types.ts:99-108 EXIT_STATUSES.
 *
 * Contract source: cli-anything EXIT_STATUSES array. src/providers/ imports no
 * tier-3 workspace code (R3 §9.2 / story AC5 rationale), so we mirror the enum
 * here. The mirror-sync test in tests/providers/cap-rejection.test.ts guards drift.
 */
export type InBoxExit = "success" | "transient" | "overflow" | "logic" | "lead_failure";

/** Runtime enum validation for InBoxExit. */
export const IN_BOX_EXITS: readonly InBoxExit[] = ["success", "transient", "overflow", "logic", "lead_failure"];

/**
 * Domain invariant for every µ$ figure crossing the classifier boundary (DD-9):
 * finite and non-negative. NaN/±Infinity/negative inputs are corrupt —
 * classifyRunExit throws on them, while cap-hit-demo's artifact paths fall back
 * to a safe figure. One predicate so both failure semantics agree on WHAT is
 * invalid and cannot drift (round 2→3 had already guarded the classification
 * path but not the artifact path).
 */
export function isValidMicroUsd(v: number | undefined | null): v is number {
  return typeof v === "number" && Number.isFinite(v) && v >= 0;
}

/** Provenance of run termination — host-side guard or null. */
export type TerminationProvenance = "provider-cap" | "wall-clock" | "host-error" | null;

/** Input to the overflow classifier. */
export interface ClassifyRunExitInput {
  /** Box-reported exit status (CC-1 enum). */
  inBoxExit: InBoxExit;
  /** Host-side provider API read of key usage in microdollars (DD-9). */
  usageMicroUsd: number;
  /** Key's spend cap in microdollars — DF2.3 mint limit, DF2.1 limitMicroUsd. */
  capMicroUsd: number;
  /** Host observed provider cap-rejection for this key this run. */
  providerCapRejected: boolean;
  /** Which host-side guard ended the run (null = workload self-terminated). */
  terminationProvenance: TerminationProvenance;
}

/** Classifier output — the final exit status and kill origin. */
export interface RunExitClassification {
  /** Final exitStatus (CC-1 enum). */
  exitStatus: InBoxExit;
  /** Origin of the kill, or null if none. */
  killOrigin: "provider-cap" | "wall-clock" | "host-error" | null;
}

/**
 * Classify a run's exit based on host-side provider evidence.
 *
 * Returns `overflow` with `killOrigin: "provider-cap"` iff:
 * - usageMicroUsd >= capMicroUsd
 * - providerCapRejected === true
 * - terminationProvenance is NOT "wall-clock" or "host-error"
 *
 * Otherwise passes through the inBoxExit with terminationProvenance as killOrigin.
 * Integer µ$ inputs (DD-9).
 *
 * NOTE: Invalid usageMicroUsd or capMicroUsd (non-finite or negative) now throw
 * rather than classify — callers treat a throw as a host-side failure, never a
 * no-rejection answer.
 */
export function classifyRunExit(input: ClassifyRunExitInput): RunExitClassification {
  const {
    inBoxExit,
    usageMicroUsd,
    capMicroUsd,
    providerCapRejected,
    terminationProvenance,
  } = input;

  // input validation — non-finite or negative figures are corrupt
  if (!isValidMicroUsd(usageMicroUsd) || !isValidMicroUsd(capMicroUsd)) {
    throw new Error(
      `classifyRunExit: usageMicroUsd and capMicroUsd must be finite non-negative integers (DD-9), got usage=${usageMicroUsd} cap=${capMicroUsd}`
    );
  }

  // runtime enum validation
  if (!IN_BOX_EXITS.includes(inBoxExit)) {
    throw new Error(
      `classifyRunExit: invalid inBoxExit "${inBoxExit}" — must be one of ${IN_BOX_EXITS.join(", ")}`
    );
  }

  const overCap = usageMicroUsd >= capMicroUsd;
  const validProvenance = terminationProvenance !== "wall-clock" && terminationProvenance !== "host-error";

  if (overCap && providerCapRejected && validProvenance) {
    return { exitStatus: "overflow", killOrigin: "provider-cap" };
  }

  return { exitStatus: inBoxExit, killOrigin: terminationProvenance };
}

/**
 * Minimum secret-fragment length redactWithKey replaces.
 *
 * Boundary mirrors cli-anything/src/redact.ts MIN_REDACTABLE_VALUE_LEN; the
 * mirror-sync test in tests/providers/cap-rejection.test.ts asserts the two
 * constants stay equal and that this redactor honors the boundary behaviorally.
 */
export const MIN_REDACTABLE_LEN = 8;

/**
 * Redact text by replacing any >=8-char substring of secret with [REDACTED].
 *
 * Pattern and >=8-char boundary from cli-anything/src/redact.ts:23-27
 * (MIN_REDACTABLE_VALUE_LEN = 8), reimplemented here because src/providers/
 * imports no tier-3 workspace code (R3 §9.2).
 *
 * Semantics: every span in `text` that matches ANY substring of `secret` with
 * length >= 8 is replaced by `[REDACTED]`. Longest match wins. Secret shorter
 * than 8 chars → text verbatim.
 *
 * Implementation: one pass over the ORIGINAL text — substring search runs
 * against a NUL-masked working copy (matched spans are blanked as they are
 * found), and the markers are spliced once at the end. Searching the evolving
 * output instead would let a generated "[REDACTED]" be selected (or re-split)
 * as a later match whenever the secret itself contains marker text.
 *
 * NOTE: iteration-budget exhaustion throws rather than returning
 * under-redacted text. Adversarial input or pathological cases trigger the
 * throw; callers (cap-hit-demo.ts probe catch) wrap thrown errors into
 * redacted probe-error strings, so throwing is the fail-closed direction.
 *
 * ponytail: O(n·m) ceiling where n=text.length and m=secret.length, but bodies
 * are <1KB so this is acceptable. A more efficient approach (Aho-Corasick,
 * suffix automaton) is not needed at this scale.
 */
export function redactWithKey(text: string, secret: string): string {
  // real run keys are OpenRouter `sk-or-v1-…` (>=8 chars by construction,
  // ~73 chars measured). The 8-char verbatim-return boundary is the sanctioned
  // cli-anything policy mirrored here; the mirror-sync test pins it.
  if (secret.length < MIN_REDACTABLE_LEN) return text;

  // Mask char must be absent from the secret, or masked spans could re-match:
  // a secret carrying BOTH \x00 and an >=8-char \x01 run would keep matching
  // its own mask until MAX_ITERATIONS, splicing duplicate [REDACTED]s over the
  // same span. Scan for the first UTF-16 code unit the secret never uses — a
  // finite secret cannot contain all 65,536, so this always terminates (in
  // practice at code 0: real keys carry no NULs).
  let mask = "";
  for (let code = 0; code < 0x10000 && mask === ""; code++) {
    const ch = String.fromCharCode(code);
    if (!secret.includes(ch)) mask = ch;
  }
  if (mask === "") {
    // Unreachable for any secret shorter than the full UTF-16 code space;
    // fail loudly rather than corrupt the text with empty-string masking.
    throw new Error("redactWithKey: secret uses every UTF-16 code unit — no mask character available");
  }
  const work = text.split("");
  const spans: Array<[number, number]> = [];
  let iteration = 0;
  const MAX_ITERATIONS = 4096; // Guard: each iteration masks >=8 chars

  while (iteration < MAX_ITERATIONS) {
    const probe = work.join("");
    // Find the longest secret substring (length down to 8) present in the
    // not-yet-masked text.
    let foundSubstring = "";
    search:
    for (let len = secret.length; len >= MIN_REDACTABLE_LEN; len--) {
      for (let start = 0; start + len <= secret.length; start++) {
        const substr = secret.slice(start, start + len);
        if (probe.includes(substr)) {
          foundSubstring = substr;
          break search;
        }
      }
    }

    if (foundSubstring === "") break; // No >=8-char substring left

    // Mask ALL its occurrences (left-to-right, non-overlapping — matching the
    // split/join semantics this replaces).
    let at = probe.indexOf(foundSubstring);
    while (at !== -1) {
      spans.push([at, at + foundSubstring.length]);
      for (let i = at; i < at + foundSubstring.length; i++) work[i] = mask;
      at = probe.indexOf(foundSubstring, at + foundSubstring.length);
    }
    iteration++;
  }

  // fail-closed on budget exhaustion — if any >=8-char secret substring
  // remains, the input is adversarial or pathological; throw rather than leak.
  if (iteration === MAX_ITERATIONS) {
    const probe = work.join("");
    for (let len = secret.length; len >= MIN_REDACTABLE_LEN; len--) {
      for (let start = 0; start + len <= secret.length; start++) {
        if (probe.includes(secret.slice(start, start + len))) {
          throw new Error("redactWithKey: iteration budget exhausted — refusing to return under-redacted text");
        }
      }
    }
  }

  // Splice markers back-to-front so earlier indices stay valid.
  spans.sort((a, b) => b[0] - a[0]);
  let result = text;
  for (const [start, end] of spans) {
    result = `${result.slice(0, start)}[REDACTED]${result.slice(end)}`;
  }
  return result;
}

/**
 * OpenRouter key-management URL (embeds the key hash). Stripped from
 * rejectionStatus in addition to run-key redaction: the hash is published
 * deliberately in the artifact's keyHash field, but a live management
 * deep-link has no place in a committed artifact (defense-in-depth).
 * Charset broadened (hex + alnum + percent-encoding + URL-safe Base64 `-`/`_`)
 * so an encoding or format drift degrades to over-redaction, never a leak.
 */
export const KEY_MANAGEMENT_URL_RE = /https:\/\/openrouter\.ai\/[^\s"'}]*\/keys\/[0-9a-zA-Z%_-]{16,}/g;

/** Strip key-management deep-links from provider rejection text. */
export function redactKeyManagementUrls(text: string): string {
  return text.replace(KEY_MANAGEMENT_URL_RE, "[REDACTED]");
}
