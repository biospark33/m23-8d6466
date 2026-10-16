/**
 * Factory-side seam fakes for the E21 Home seams (Story A1, AC6 + AC4).
 *
 * Honors the seams AS WRITTEN in the merged story texts:
 *  - S02b: `TURN_REFUSALS` is the single principal-refusal vocabulary
 *    (CON2-20) — exactly three values; no second principal reason is invented
 *    anywhere in this module. `isHomeBackedAgent` is S02B-owned and stays a
 *    standalone leaf export: the fork rule is that `home-principal.ts` never
 *    references it, so it is deliberately NOT a property of any
 *    principal-shaped object here.
 *  - S03b: `writeProfileTokens` writes exactly the four `SOLSTICE_*_TOKEN`
 *    names and refuses `home_gateway_url_mismatch` (lowercase snake_case)
 *    without writing when the token's gateway env value does not prefix-match
 *    the Home's pinned gateway base URL. INV-MGR-3: token VALUES are opaque
 *    strings held only in the fake's own state; every exposed record carries
 *    token NAMES only.
 *  - AC4 / INV-MGR-4: the gateway budget journal records one reservation per
 *    bot BEFORE its first turn; an unreserved turn is a refusal.
 *
 * Zero fork/zeropoint imports: these fakes are factory-side only (charter
 * §5.4) — the only import-safe way CI stays green without E21's code.
 */

/** The single principal-refusal vocabulary (E21 S02b, CON2-20). Verbatim. */
export const TURN_REFUSALS = [
  "initiator_missing",
  "initiator_mismatch",
  "no_owner",
] as const;

export type TurnRefusal = (typeof TURN_REFUSALS)[number];

/**
 * ADR-RUN-2 D1's owner seam admits `org`, but policy refuses it until the
 * company-bot feature ships (AC1) — the type keeps the seam's shape; the fake
 * homes it builds are operator-as-user (`kind:'user'`).
 */
export type Principal = { kind: "user" | "org"; id: string };

/** E21 S02B-owned boundary predicate, verbatim, standalone leaf export. */
export type AgentRuntimeShape = { runtime: string; owner?: Principal };

export function isHomeBackedAgent(agent: AgentRuntimeShape): boolean {
  return agent.runtime === "hermes-sandbox" && agent.owner?.kind === "user";
}

/** The four S03b profile-token names, exactly. */
export const PROFILE_TOKEN_NAMES = [
  "SOLSTICE_LLM_GATEWAY_TOKEN",
  "SOLSTICE_KNOWLEDGE_TOKEN",
  "SOLSTICE_MEMORY_GATEWAY_TOKEN",
  "SOLSTICE_WORKSPACE_GATEWAY_TOKEN",
] as const;

export type ProfileTokenName = (typeof PROFILE_TOKEN_NAMES)[number];

/** S03b's profile-seam refusal reason (lowercase snake_case). Not a principal refusal. */
export const HOME_GATEWAY_URL_MISMATCH = "home_gateway_url_mismatch";

/**
 * INV-MGR-4: an unreserved turn is a refusal, not a warning. This is the E08
 * gateway seam's OWN error domain — deliberately NOT in the TURN_REFUSALS
 * principal vocabulary above: the principal vocabulary answers "who may turn",
 * this answers "is the turn funded". Folding one into the other would invent a
 * second principal reason (the AC6 negative control).
 */
export class GatewayBudgetError extends Error {
  readonly reason: "budget_reservation_missing" | "budget_reservation_exists";

  constructor(reason: "budget_reservation_missing" | "budget_reservation_exists") {
    super(`gateway budget refusal: ${reason}`);
    this.name = "GatewayBudgetError";
    this.reason = reason;
  }
}

export class HomeTurnRefusalError extends Error {
  readonly refusal: TurnRefusal;

  constructor(refusal: TurnRefusal) {
    super(`home turn refusal: ${refusal}`);
    this.name = "HomeTurnRefusalError";
    this.refusal = refusal;
  }
}

export class SeamRefusalError extends Error {
  readonly reason: typeof HOME_GATEWAY_URL_MISMATCH;

  constructor(detail: string) {
    super(`${HOME_GATEWAY_URL_MISMATCH}: ${detail}`);
    this.name = "SeamRefusalError";
    this.reason = HOME_GATEWAY_URL_MISMATCH;
  }
}

export type FakeBot = { readonly id: `bot-${string}` };

export type FakeHome = {
  readonly id: string;
  readonly owner: Principal | null; // ownerless homes exist only so INV-8's no_owner case is observable
  readonly pinnedGatewayBaseUrl: string;
  readonly bots: readonly FakeBot[];
};

export type ProfileTokenAuditEntry =
  | { botId: string; outcome: "written" }
  | { botId: string; outcome: "refused"; reason: typeof HOME_GATEWAY_URL_MISMATCH };

export type BudgetReservation = { botId: string; ceilingUsd: number; order: number };
export type TurnRecord = { botId: string; initiator: Principal; order: number };
export type PrincipalRefusalRecord = { botId: string; refusal: TurnRefusal; order: number };

export type SeamFakes = {
  readonly home: FakeHome;
  addBot(id: `bot-${string}`): FakeBot;
  writeProfileTokens(home: FakeHome, botId: string): void;
  reserveBudget(botId: string, ceilingUsd: number): void;
  runBotTurn(botId: string, opts?: { initiator?: Principal }): void;
  /** Fake profile paths -> the token NAMES written there (never values). */
  readonly profilePaths: ReadonlyMap<string, readonly string[]>;
  readonly profileTokenAudit: readonly ProfileTokenAuditEntry[];
  readonly budgetJournal: readonly BudgetReservation[];
  readonly turns: readonly TurnRecord[];
  readonly principalRefusals: readonly PrincipalRefusalRecord[];
  /**
   * Held-only-in-fake-state token values, exposed solely so the suite can
   * assert their ABSENCE from every exposed record. Never part of profile
   * paths, audit lines, the journal, or turns (INV-MGR-3).
   */
  readonly mintedTokenValues: ReadonlyMap<string, Record<ProfileTokenName, string>>;
};

export function createSeamFakes(opts: {
  gatewayUrl: string;
  /** Defaults to the mint gateway. Override to model a foreign pin. */
  pinnedGatewayBaseUrl?: string;
  owner: Principal | null;
  homeId?: string;
}): SeamFakes {
  const { gatewayUrl, owner } = opts;
  const pinnedGatewayBaseUrl = opts.pinnedGatewayBaseUrl ?? gatewayUrl;

  const bots: FakeBot[] = [];
  const home: FakeHome = {
    id: opts.homeId ?? "home-factory",
    owner,
    pinnedGatewayBaseUrl,
    bots,
  };

  const profilePaths = new Map<string, readonly string[]>();
  const profileTokenAudit: ProfileTokenAuditEntry[] = [];
  const budgetJournal: BudgetReservation[] = [];
  const turns: TurnRecord[] = [];
  const principalRefusals: PrincipalRefusalRecord[] = [];
  const mintedTokenValues = new Map<string, Record<ProfileTokenName, string>>();
  const reserved = new Set<string>();

  // One monotonic counter across reservations, turns, and refusals so the
  // suite can assert the reservation is ordered BEFORE the turn it funded.
  let order = 0;

  function requireBot(botId: string): FakeBot {
    const bot = bots.find((b) => b.id === botId);
    if (!bot) throw new Error(`unknown bot: ${botId}`);
    return bot;
  }

  return {
    home,

    addBot(id) {
      if (!id.startsWith("bot-")) {
        throw new Error(`bot ids are bot- prefixed immutable strings, got: ${id}`);
      }
      if (bots.some((b) => b.id === id)) {
        throw new Error(`duplicate bot id: ${id}`);
      }
      const bot: FakeBot = { id };
      bots.push(bot);
      return bot;
    },

    writeProfileTokens(targetHome, botId) {
      requireBot(botId);
      const path = `/fake-homes/${targetHome.id}/bots/${botId}/profile-env`;
      // Double provisioning is REFUSED, not silently replaced (mirrors
      // reserveBudget's budget_reservation_exists): no write, no second audit
      // line, and no invented vocabulary value — a plain caller error.
      if (profilePaths.has(path)) {
        throw new Error(
          `profile_tokens_exist: bot ${botId} already has profile tokens — double provisioning is refused, not silently replaced`,
        );
      }
      // Token VALUES are opaque and held only in fake state; the env value
      // embeds the gateway it was minted for, so a token minted for a
      // different gateway never prefix-matches a foreign pin (S03b refusal).
      // EVERY minted value is checked, not just the first — a batch carrying
      // one foreign token must refuse, not ride on the others.
      const values = {} as Record<ProfileTokenName, string>;
      for (const name of PROFILE_TOKEN_NAMES) {
        values[name] = `${gatewayUrl}#${crypto.randomUUID()}`;
      }
      const allMintedMatchPin = Object.values(values).every((value) =>
        value.startsWith(targetHome.pinnedGatewayBaseUrl),
      );
      if (!allMintedMatchPin) {
        profileTokenAudit.push({ botId, outcome: "refused", reason: HOME_GATEWAY_URL_MISMATCH });
        throw new SeamRefusalError(
          `token gateway env value does not prefix-match home pin ${targetHome.pinnedGatewayBaseUrl}`,
        );
      }

      // Exactly the four names, nothing else — one entry per bot, so no
      // fifth name can accumulate.
      profilePaths.set(path, [...PROFILE_TOKEN_NAMES]);
      mintedTokenValues.set(botId, values);
      profileTokenAudit.push({ botId, outcome: "written" });
    },

    reserveBudget(botId, ceilingUsd) {
      requireBot(botId);
      // Scope: ceiling PRESENCE/positivity is manager-config's refusal (AC4
      // config-side); this journal records funded reservations and refuses the
      // unfunded turn — it does not re-validate config.
      if (reserved.has(botId)) {
        throw new GatewayBudgetError("budget_reservation_exists");
      }
      reserved.add(botId);
      budgetJournal.push({ botId, ceilingUsd, order: order++ });
    },

    runBotTurn(botId, turnOpts) {
      requireBot(botId);
      // INV-8 first: a turn runs only when the recorded initiator equals the
      // owner. Owner absence dominates (nothing could match), then a missing
      // initiator, then a mismatch — the three map 1:1 onto TURN_REFUSALS.
      if (owner === null) {
        principalRefusals.push({ botId, refusal: "no_owner", order: order++ });
        throw new HomeTurnRefusalError("no_owner");
      }
      const initiator = turnOpts?.initiator;
      if (initiator === undefined) {
        principalRefusals.push({ botId, refusal: "initiator_missing", order: order++ });
        throw new HomeTurnRefusalError("initiator_missing");
      }
      if (initiator.kind !== owner.kind || initiator.id !== owner.id) {
        principalRefusals.push({ botId, refusal: "initiator_mismatch", order: order++ });
        throw new HomeTurnRefusalError("initiator_mismatch");
      }
      // INV-MGR-4 second: no reservation, no turn.
      if (!reserved.has(botId)) {
        throw new GatewayBudgetError("budget_reservation_missing");
      }
      turns.push({ botId, initiator, order: order++ });
    },

    profilePaths,
    profileTokenAudit,
    budgetJournal,
    turns,
    principalRefusals,
    mintedTokenValues,
  };
}
