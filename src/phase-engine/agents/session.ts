/**
 * Session identity for the agent phase (Story DF1.3).
 *
 * Session reuse is keyed on an EXACT `(PhaseParams.agent.agentId, provider,
 * model)` match (INV-4). This is a deliberate hardening over the SSSF source,
 * which keys on a model match only (R4 §1.9, `MOD/agents.py:228-232`): a
 * provider-only change is not a same-session continuation, since it can carry
 * different credentials or a different price table. A model change is likewise
 * a new context. Any mismatch mints a fresh id; an exact match continues the
 * cached one, so the retry loops continue one context rather than opening new
 * ones.
 *
 * Where `PhaseParams.agent` is absent, the phase runs without a cached session:
 * every send opens its own, and no key is invented from elsewhere (AC2) —
 * `sessionFor` returns `undefined` and the sender owns per-send ids.
 *
 * The cache is a Map, not a single slot: a run that alternates agents
 * (review → build → review) must rejoin the FIRST agent's context on the third
 * phase, not pay a fresh re-context because the middle phase evicted it.
 */
import { randomUUID } from "node:crypto";

import type { PhaseAgent } from "../types.ts";

/**
 * `JSON.stringify` of the ordered triple: unambiguous (no separator character
 * can appear "inside" a field and make two distinct triples collide) and
 * plain-text (a NUL-byte separator would make this file binary to git, hiding
 * the keying logic from every reviewer and scanner).
 */
function sessionKey(agent: PhaseAgent): string {
  return JSON.stringify([agent.agentId, agent.provider, agent.model]);
}

export class SessionCache {
  readonly #sessions = new Map<string, string>();

  constructor(
    private readonly idFactory: () => string = (): string => `qds-${randomUUID()}`,
  ) {}

  /**
   * The session id every send of this phase's agent should continue. Exact
   * triple match ⇒ the cached id; any provider or model change ⇒ a freshly
   * minted id (cached under its own key, so returning to a prior triple
   * rejoins that triple's context); absent agent ⇒ `undefined` (no cached
   * session).
   */
  sessionFor(agent: PhaseAgent | undefined): string | undefined {
    if (agent === undefined) return undefined;
    const key = sessionKey(agent);
    const cached = this.#sessions.get(key);
    if (cached !== undefined) return cached;
    const sessionId = this.idFactory();
    this.#sessions.set(key, sessionId);
    return sessionId;
  }
}
