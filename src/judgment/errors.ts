/**
 * Typed judgment-tier errors shared by the seam client and its adapters.
 *
 * They live in their own leaf module so `client.ts` (the seam) and
 * `adapters/jev.ts` (a transport) can both throw them without an import
 * cycle through `provider.ts`. `client.ts` re-exports `JudgmentHttpError`
 * unchanged, so its public surface is identical to JEV-2's.
 */

export class JudgmentHttpError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly requestId: string,
    /** The (truncated) response body text, for field-level diagnosis. */
    public readonly bodyText: string,
  ) {
    super(message);
    this.name = "JudgmentHttpError";
  }
}

/**
 * The response body was received but is not a contract-shaped judgment — the
 * strict parse refused it, or it was not JSON at all. Still a 502
 * JudgmentHttpError (callers that branch on status are unchanged); the
 * subclass is what lets the live probe tell CONTRACT DRIFT apart from a
 * transport failure or an upstream 502, which share the status.
 */
export class JudgmentSchemaError extends JudgmentHttpError {
  constructor(message: string, requestId: string, bodyText: string) {
    super(502, message, requestId, bodyText);
    this.name = "JudgmentSchemaError";
  }
}

/**
 * A provider id that is not an own key of the closed registry (J1
 * Observability Contract: typed `unknown-provider`, refused before any
 * request exists).
 */
export class UnknownProviderError extends Error {
  readonly code = "unknown-provider";
  constructor(
    public readonly providerId: unknown,
    registered: readonly string[],
  ) {
    super(`unknown judgment provider ${describeId(providerId)} — the closed registry holds ${registered.join(" | ")}`);
    this.name = "UnknownProviderError";
  }
}

/** Total over every input (BigInt and cyclic values make JSON.stringify throw). */
function describeId(id: unknown): string {
  return typeof id === "string" ? JSON.stringify(id) : `<${typeof id}>`;
}
