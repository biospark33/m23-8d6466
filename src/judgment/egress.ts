/**
 * Egress choke point (JEV-2, handoff §3.7/§3.8, ADR 0001).
 *
 * ONE function every judgment passes through before a request is built: it
 * validates the declared egress class, refuses unknown/absent declarations,
 * enforces the stage-1 ceiling, and redacts per class with rules designed
 * FRESH for this whitelist.
 *
 * `redactSecrets` (src/providers/step-log.ts) is deliberately NOT used, and
 * nothing from providers/ is imported (the module's two-import fence): it is
 * a targeted pattern redactor, lossy both ways (§3.8, the audit/chain.ts
 * join-slug lesson). The stage-1 max class is CODE-PINNED per ADR 0001
 * (ACCEPTED) — the config knob ships with stage-2 ZDR work.
 */

/** What a seam may declare it ships. INV-J2: the declaration is discipline, not sniffing. */
export const EGRESS_CLASSES = ["machine-state", "finding-text", "ac-prose", "diff-hunk"] as const;

export type EgressClass = (typeof EGRESS_CLASSES)[number];

/**
 * Stage-1 maximum, code-pinned per ADR 0001 (ACCEPTED, steve 2026-09-22):
 * `_bmad-output/typesafe-integration/adr/0001-egress-max-class-code-pinned.md`.
 * Raising this is a reviewed code change paired with the executed-ZDR
 * precondition it must satisfy — not a config flip.
 */
export const DEFAULT_MAX_EGRESS_CLASS = "ac-prose";

export class EgressRefusedError extends Error {
  constructor(
    message: string,
    public readonly egressClass: unknown,
  ) {
    super(message);
    this.name = "EgressRefusedError";
  }
}

// ---------------------------------------------------------------------------
// Redaction — designed fresh for THIS whitelist (§3.8). Per-class rules:
//   machine-state  host-derived structured state → secrets + opaque long runs
//   finding-text / ac-prose  lead-authored prose → secrets only (prose may
//                  legitimately quote code identifiers and hashes)
//   diff-hunk      unreachable — hard-gated below, never redacted-through
// ---------------------------------------------------------------------------

const SECRET_PATTERNS: [RegExp, string][] = [
  // Opaque credential shapes first, so `token <credential>` redacts as a whole.
  [/\b(?:sk|rk|pk|ghp|gho|ghu|xoxb|xoxp|github_pat)-[A-Za-z0-9_-]{8,}\b/g, "[REDACTED_TOKEN]"],
  [/\bAKIA[0-9A-Z]{16}\b/g, "[REDACTED_AWS_KEY]"],
  [/Bearer\s+\S+/gi, "Bearer [REDACTED]"],
  [/\b(api[-_]?key|apikey|token|secret|password|passwd|credential|authorization)s?\b\s*[:=]\s*"?[^\s",;]{4,}"?/gi, "$1: [REDACTED]"],
];

const OPAQUE_RUN_PATTERNS: [RegExp, string][] = [
  [/\b[A-Fa-f0-9]{40,}\b/g, "[REDACTED_HEX]"],
  [/\b[A-Za-z0-9+/]{60,}={0,2}\b/g, "[REDACTED_B64]"],
];

export function redactForEgress(text: string, egressClass: EgressClass): string {
  let out = text;
  for (const [pattern, replacement] of SECRET_PATTERNS) {
    out = out.replace(pattern, replacement);
  }
  if (egressClass === "machine-state") {
    for (const [pattern, replacement] of OPAQUE_RUN_PATTERNS) {
      out = out.replace(pattern, replacement);
    }
  }
  return out;
}

/**
 * THE choke point: validate the declared class, then redact. Throws BEFORE
 * any request is built for an unknown/absent class or a stage-1
 * `diff-hunk` declaration.
 */
export function egress(text: string, egressClass: unknown): string {
  if (typeof egressClass !== "string" || !(EGRESS_CLASSES as readonly string[]).includes(egressClass)) {
    throw new EgressRefusedError(
      `egress refused: unknown or absent egress class (${JSON.stringify(
        egressClass ?? null,
      )}) — every seam must declare one of ${EGRESS_CLASSES.join(" | ")} (handoff §3.7)`,
      egressClass,
    );
  }
  if (egressClass === "diff-hunk") {
    throw new EgressRefusedError(
      `egress refused: "diff-hunk" is HARD-GATED at stage 1 (max class ${DEFAULT_MAX_EGRESS_CLASS}, ADR 0001) — stage 2 unlocks only on an EXECUTED ZDR addendum with defined retention + deletion clauses (handoff §3.7); the published DPA has none`,
      egressClass,
    );
  }
  return redactForEgress(text, egressClass as EgressClass);
}
