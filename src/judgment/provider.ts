/**
 * JudgmentProvider seam (v6 J1, D-4 / DD-21) — the ONE pluggable step of
 * `JudgmentClient.judge()`: transport, `JudgmentRequest → raw response body`.
 *
 * Everything else is neutral-layer policy and stays in the seam client
 * (client.ts): egress choke, stage-ceiling admit/record, strict
 * `makeJudgmentResponseSchema` parse, envelope build, provenance emit. An
 * adapter therefore exposes `{ id, ask }` and nothing else — it cannot
 * redact, cannot validate, and its body counts for nothing until the seam
 * has parsed it.
 *
 * The registry is CLOSED: a frozen module-level constant of adapter makers,
 * the verbs.ts / `AUDIT_HOPS` / `EGRESS_CLASSES` idiom. There is no
 * `registerProvider()` — a runtime registration would put a transport on the
 * seam that no contract test has run. A future jev-like tier-1 system is a
 * code change here plus membership in tests/judgment/adapter-contract.test.ts.
 */

import { makeJevProvider } from "./adapters/jev.ts";
import { makeMockProvider } from "./adapters/mock.ts";
import { UnknownProviderError } from "./errors.ts";
import type { JudgmentRequest } from "./schemas.ts";

export { UnknownProviderError };

export interface JudgmentProvider {
  /** The registry key this adapter was made from — named on the house log line. */
  readonly id: JudgmentProviderId;
  /**
   * Send the seam-built request; resolve the raw, UNVALIDATED body. The
   * seam-minted `requestId` rides the wire call and every transport error so
   * wire call, envelope, side channel and house log stay correlated.
   */
  ask(request: JudgmentRequest, requestId: string): Promise<unknown>;
}

/** The closed registry: adapter makers keyed by provider id. */
export const JUDGMENT_PROVIDERS = Object.freeze({
  jev: makeJevProvider,
  mock: makeMockProvider,
});

export type JudgmentProviderId = keyof typeof JUDGMENT_PROVIDERS;

export const JUDGMENT_PROVIDER_IDS: readonly JudgmentProviderId[] = Object.freeze(
  Object.keys(JUDGMENT_PROVIDERS) as JudgmentProviderId[],
);

/**
 * Resolve a registered adapter maker. Any id that is not an OWN key of the
 * registry refuses typed — `Object.hasOwn`, so `"toString"`/`"__proto__"`
 * never resolve to a prototype member.
 */
export function resolveProvider<K extends JudgmentProviderId>(id: K): (typeof JUDGMENT_PROVIDERS)[K];
export function resolveProvider(id: string): (typeof JUDGMENT_PROVIDERS)[JudgmentProviderId];
export function resolveProvider(id: string): (typeof JUDGMENT_PROVIDERS)[JudgmentProviderId] {
  if (typeof id !== "string" || !Object.hasOwn(JUDGMENT_PROVIDERS, id)) {
    throw new UnknownProviderError(id, JUDGMENT_PROVIDER_IDS);
  }
  return JUDGMENT_PROVIDERS[id as JudgmentProviderId];
}
