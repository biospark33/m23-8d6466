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
    super(`unknown judgment provider ${JSON.stringify(providerId)} — the closed registry holds ${registered.join(" | ")}`);
    this.name = "UnknownProviderError";
  }
}
