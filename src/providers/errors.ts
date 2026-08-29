/**
 * The one `{code, remediation}` provider error shape (F041).
 *
 * Eleven classes across this seam had hand-copied the same three lines
 * (`code`, `remediation`, `this.name = "…"`), and consumers then re-derived
 * the shape structurally anyway. They all extend this now. Subclasses keep
 * their own `name` and their own extra fields, so every `instanceof
 * XError` and every `.code` read that existed before still works — that,
 * not the deduplication, is the acceptance criterion.
 *
 * This module is a LEAF on purpose: it imports nothing. `exedev/transport.ts`
 * is itself the cycle-breaking bottom of the exedev layer and `fake-driver.ts`
 * must not depend on any specific substrate's module, so the only place all
 * eleven can import from without an import cycle is a file with no imports.
 * Keep it that way — do not add an import here.
 */

export class ProviderError extends Error {
  /** Machine-readable failure class; also the `code` in every log line. */
  readonly code: string;
  /** The literal next command, secrets referenced by env-var NAME, never expanded. */
  readonly remediation: string;

  constructor(code: string, message: string, remediation: string) {
    super(message);
    this.name = "ProviderError";
    this.code = code;
    this.remediation = remediation;
  }
}
