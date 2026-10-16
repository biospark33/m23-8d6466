/**
 * Seam-fidelity suite (Story A1, AC6 + AC4): the Home/gateway/budget-journal
 * fakes in ./home-seam-fakes.ts honor the E21 seams AS WRITTEN.
 *
 * What this file pins:
 *
 *  A. S02b principal vocabulary: TURN_REFUSALS is exactly the three values
 *     (CON2-20 single vocabulary) and no other fake surface emits a principal
 *     refusal string outside that set — the gateway-domain and profile-seam
 *     refusal reasons are deliberately different vocabularies.
 *  B. S02B-owned isHomeBackedAgent: the boundary predicate verbatim, exported
 *     standalone (a leaf export — never a property of a principal-shaped
 *     object, modeling that home-principal.ts never references it).
 *  C. S03b writeProfileTokens: exactly the four SOLSTICE_*_TOKEN names, the
 *     home_gateway_url_mismatch refusal performing NO write, INV-MGR-3
 *     (profile tokens are names, never values, in every exposed record).
 *  D. AC4 / INV-MGR-4: one budget reservation per bot BEFORE its first turn;
 *     an unreserved turn is a gateway-domain refusal, not a warning.
 *  E. INV-8 turn principal: the three initiator cases map onto exactly the
 *     three TURN_REFUSALS values.
 *  F. Charter §5.4 CI-green invariant: zero fork/zeropoint imports anywhere in
 *     the factory graph (static specifier scan over src/** and
 *     tests/managers/*.ts present at run time).
 */
import { describe, expect, test } from "bun:test";
import { forkImportOffenders, tsFilesUnder } from "./scan-helpers.ts";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import {
  GatewayBudgetError,
  HOME_GATEWAY_URL_MISMATCH,
  HomeTurnRefusalError,
  isHomeBackedAgent,
  PROFILE_TOKEN_NAMES,
  SeamRefusalError,
  TURN_REFUSALS,
  createSeamFakes,
  type Principal,
} from "./home-seam-fakes.ts";

const OPERATOR: Principal = { kind: "user", id: "operator-principal" };

function makeFake(opts?: {
  gatewayUrl?: string;
  pinnedGatewayBaseUrl?: string;
  owner?: Principal | null;
}) {
  const fake = createSeamFakes({
    gatewayUrl: opts?.gatewayUrl ?? "https://gateway.internal/v1",
    pinnedGatewayBaseUrl: opts?.pinnedGatewayBaseUrl,
    owner: opts?.owner === undefined ? OPERATOR : opts.owner,
  });
  fake.addBot("bot-dev");
  return fake;
}

describe("A. S02b principal refusal vocabulary (CON2-20)", () => {
  test("TURN_REFUSALS is exactly the three seam values, in order", () => {
    expect(TURN_REFUSALS).toEqual([
      "initiator_missing",
      "initiator_mismatch",
      "no_owner",
    ]);
  });

  test("every principal refusal the fake records is inside the vocabulary", () => {
    const fake = makeFake({ owner: null });
    // Drive all three refusal paths and a refusal on a second bot.
    expect(() => fake.runBotTurn("bot-dev")).toThrow(HomeTurnRefusalError);
    const second = createSeamFakes({
      gatewayUrl: "https://gateway.internal/v1",
      owner: { kind: "user", id: "op" },
    });
    second.addBot("bot-qa");
    expect(() =>
      second.runBotTurn("bot-qa", { initiator: { kind: "user", id: "nope" } }),
    ).toThrow(HomeTurnRefusalError);

    for (const record of [...fake.principalRefusals, ...second.principalRefusals]) {
      expect(TURN_REFUSALS).toContain(record.refusal);
    }
  });

  test("the other refusal vocabularies do not leak into the principal set", () => {
    // The gateway seam's own error reasons and the S03b profile refusal are
    // deliberate non-members: inventing a second principal reason is the AC6
    // negative control; folding these in would blur the domains instead.
    expect(TURN_REFUSALS).not.toContain(HOME_GATEWAY_URL_MISMATCH);
    expect(TURN_REFUSALS).not.toContain("budget_reservation_missing");
    expect(TURN_REFUSALS).not.toContain("budget_reservation_exists");
  });

  test("the three refusal classes are distinct — a catch of one never swallows another", () => {
    // Distinct classes are what make `catch (e) { if (e instanceof X) }` keep
    // the other two vocabularies separate; any shared base would let one
    // handler swallow another domain's refusal.
    const budget = new GatewayBudgetError("budget_reservation_missing");
    const turn = new HomeTurnRefusalError("no_owner");
    const seam = new SeamRefusalError("detail");
    expect(budget).not.toBeInstanceOf(HomeTurnRefusalError);
    expect(budget).not.toBeInstanceOf(SeamRefusalError);
    expect(turn).not.toBeInstanceOf(GatewayBudgetError);
    expect(turn).not.toBeInstanceOf(SeamRefusalError);
    expect(seam).not.toBeInstanceOf(GatewayBudgetError);
    expect(seam).not.toBeInstanceOf(HomeTurnRefusalError);
  });
});

describe("B. isHomeBackedAgent — S02B-owned boundary predicate", () => {
  test("true only for hermes-sandbox runtime with a user-kind owner", () => {
    expect(
      isHomeBackedAgent({ runtime: "hermes-sandbox", owner: OPERATOR }),
    ).toBe(true);
  });

  test("false for an org-kind owner, an absent owner, or a foreign runtime", () => {
    expect(
      isHomeBackedAgent({ runtime: "hermes-sandbox", owner: { kind: "org", id: "o" } }),
    ).toBe(false);
    expect(isHomeBackedAgent({ runtime: "hermes-sandbox" })).toBe(false);
    expect(isHomeBackedAgent({ runtime: "local-process", owner: OPERATOR })).toBe(false);
  });

  test("exported standalone — not a property of any principal-shaped object", () => {
    // The fork rule is that home-principal.ts never references it; the fake
    // models that by keeping it a leaf export. A principal object carrying it
    // would model the opposite shape — so assert the real principal fixture
    // this suite provisions carries no such property.
    const fake = makeFake();
    const principal = fake.home.owner!;
    expect("isHomeBackedAgent" in principal).toBe(false);
    expect(isHomeBackedAgent({ runtime: "hermes-sandbox", owner: principal })).toBe(true);
    expect(
      isHomeBackedAgent({ runtime: "hermes-sandbox", owner: { kind: "org", id: "o" } }),
    ).toBe(false);
    expect(isHomeBackedAgent({ runtime: "local-process", owner: OPERATOR })).toBe(false);
  });
});

describe("C. S03b writeProfileTokens — four names, mismatch refusal, names-only", () => {
  test("prefix match writes exactly the four SOLSTICE token names, no fifth", () => {
    const fake = makeFake();
    fake.writeProfileTokens(fake.home, "bot-dev");

    const paths = [...fake.profilePaths.values()];
    expect(paths.length).toBe(1);
    const written = paths[0] ?? [];
    expect([...written].sort()).toEqual([...PROFILE_TOKEN_NAMES].sort());
    expect(written.length).toBe(4);
    for (const name of PROFILE_TOKEN_NAMES) {
      expect(written).toContain(name);
    }
  });

  test("gateway mismatch refuses, writes NOTHING, and records the refusal", () => {
    const fake = makeFake({ pinnedGatewayBaseUrl: "https://other-gateway.internal/v1" });
    const pathsBefore = fake.profilePaths.size;
    const auditBefore = fake.profileTokenAudit.length;

    expect(() => fake.writeProfileTokens(fake.home, "bot-dev")).toThrow(
      HOME_GATEWAY_URL_MISMATCH,
    );

    expect(fake.profilePaths.size).toBe(pathsBefore);
    expect(fake.profileTokenAudit.length).toBe(auditBefore + 1);
    expect(fake.profileTokenAudit).toEqual([
      { botId: "bot-dev", outcome: "refused", reason: HOME_GATEWAY_URL_MISMATCH },
    ]);
  });

  test("an unknown bot id is not a principal refusal — plain error, no audit confusion", () => {
    const fake = makeFake();
    expect(() => fake.writeProfileTokens(fake.home, "bot-ghost")).toThrow(/unknown bot/);
    expect(fake.profileTokenAudit).toEqual([]);
  });

  test("a token minted for a near-miss superset pin is ACCEPTED — the seam's as-written startsWith semantics, deliberately pinned", () => {
    // S03b verbatim refuses only when "the env value is not the prefix of the
    // pinned base_url". A token minted for https://gw.internal/v1-evil starts
    // with the pin https://gw.internal/v1, so the write SUCCEEDS. This test
    // pins that near-miss acceptance so any fork-side move to stricter
    // matching is a visible decision, never a silent drift.
    const fake = makeFake({
      gatewayUrl: "https://gw.internal/v1-evil",
      pinnedGatewayBaseUrl: "https://gw.internal/v1",
    });
    fake.writeProfileTokens(fake.home, "bot-dev");
    expect(fake.profilePaths.size).toBe(1);
    expect(fake.profileTokenAudit).toEqual([{ botId: "bot-dev", outcome: "written" }]);
  });

  test("duplicate addBot id refuses without mutating the bot list", () => {
    const fake = makeFake();
    expect(() => fake.addBot("bot-dev")).toThrow(/duplicate bot id: bot-dev/);
    expect(fake.home.bots).toHaveLength(1);
  });

  test("double provisioning refuses: profile_tokens_exist, no write, no second audit line", () => {
    const fake = makeFake();
    fake.writeProfileTokens(fake.home, "bot-dev");
    const auditBefore = fake.profileTokenAudit.length;
    expect(() => fake.writeProfileTokens(fake.home, "bot-dev")).toThrow(/profile_tokens_exist/);
    // Mirrors reserveBudget's budget_reservation_exists: the second write is
    // a refusal, not a silent replacement of the first provision.
    expect(fake.profileTokenAudit.length).toBe(auditBefore); // no second audit line
    expect(fake.profileTokenAudit.filter((a) => a.outcome === "written")).toHaveLength(1); // exactly one "written"
    const paths = [...fake.profilePaths.values()];
    expect(paths.length).toBe(1); // still the first provisioning's single path
    expect([...paths[0] ?? []]).toEqual([...PROFILE_TOKEN_NAMES]);
  });
});

describe("D. AC4 / INV-MGR-4 — reservation before first turn", () => {
  test("reserved turn succeeds and the journal shows the reservation ordered first", () => {
    const fake = makeFake();
    fake.reserveBudget("bot-dev", 25);
    fake.writeProfileTokens(fake.home, "bot-dev");
    fake.runBotTurn("bot-dev", { initiator: OPERATOR });

    expect(fake.turns.length).toBe(1);
    expect(fake.budgetJournal.length).toBe(1);
    expect(fake.budgetJournal[0]).toEqual({
      botId: "bot-dev",
      ceilingUsd: 25,
      order: expect.any(Number),
    });
    expect(fake.budgetJournal[0]!.order).toBeLessThan(fake.turns[0]!.order);
  });

  test("an unreserved turn is a gateway-domain refusal and records no turn", () => {
    const fake = makeFake();
    fake.writeProfileTokens(fake.home, "bot-dev");

    let caught: unknown;
    try {
      fake.runBotTurn("bot-dev", { initiator: OPERATOR });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(GatewayBudgetError);
    expect((caught as GatewayBudgetError).reason).toBe("budget_reservation_missing");
    expect(fake.turns).toEqual([]);
  });

  test("one reservation per bot — a second reservation for the same bot refuses", () => {
    const fake = makeFake();
    fake.reserveBudget("bot-dev", 25);
    expect(() => fake.reserveBudget("bot-dev", 25)).toThrow(GatewayBudgetError);
    expect(fake.budgetJournal.length).toBe(1);
  });
});

describe("E. INV-8 — initiator mapping onto TURN_REFUSALS", () => {
  test("missing initiator refuses initiator_missing", () => {
    const fake = makeFake();
    fake.reserveBudget("bot-dev", 10);
    expect(() => fake.runBotTurn("bot-dev")).toThrow(HomeTurnRefusalError);
    expect(fake.principalRefusals.map((r) => r.refusal)).toEqual(["initiator_missing"]);
    expect(fake.turns).toEqual([]);
  });

  test("mismatched initiator refuses initiator_mismatch", () => {
    const fake = makeFake();
    fake.reserveBudget("bot-dev", 10);
    expect(() =>
      fake.runBotTurn("bot-dev", { initiator: { kind: "user", id: "someone-else" } }),
    ).toThrow(HomeTurnRefusalError);
    expect(fake.principalRefusals.map((r) => r.refusal)).toEqual(["initiator_mismatch"]);
  });

  test("owner-absent home refuses no_owner even for a well-formed initiator", () => {
    const fake = makeFake({ owner: null });
    fake.reserveBudget("bot-dev", 10);
    expect(() => fake.runBotTurn("bot-dev", { initiator: OPERATOR })).toThrow(
      HomeTurnRefusalError,
    );
    expect(fake.principalRefusals.map((r) => r.refusal)).toEqual(["no_owner"]);
  });

  test("bot ids are bot-prefixed and immutable — a bare name is refused at declaration", () => {
    const fake = makeFake();
    // The template-literal type is the compile-time fence (a bare "dev" arg
    // fails tsc); the cast models an untyped id arriving at a boundary so the
    // runtime fence is exercised too.
    expect(() => fake.addBot("dev" as `bot-${string}`)).toThrow(/bot-/);
  });
});

describe("F. INV-MGR-3 — token values never appear in exposed records", () => {
  test("exposed surfaces carry token NAMES only; minted values appear nowhere", () => {
    const fake = makeFake();
    fake.writeProfileTokens(fake.home, "bot-dev");
    fake.reserveBudget("bot-dev", 25);
    fake.runBotTurn("bot-dev", { initiator: OPERATOR });

    const exposed = JSON.stringify({
      profilePaths: [...fake.profilePaths],
      profileTokenAudit: fake.profileTokenAudit,
      budgetJournal: fake.budgetJournal,
      turns: fake.turns,
      principalRefusals: fake.principalRefusals,
    });

    for (const [, values] of fake.mintedTokenValues) {
      for (const value of Object.values(values)) {
        expect(exposed.includes(value)).toBe(false);
      }
    }
    for (const name of PROFILE_TOKEN_NAMES) {
      expect(exposed.includes(name)).toBe(true);
    }
  });

  test("every minted value is an opaque non-empty string distinct per token", () => {
    const fake = makeFake();
    fake.writeProfileTokens(fake.home, "bot-dev");
    const values = fake.mintedTokenValues.get("bot-dev");
    expect(values).toBeDefined();
    const list = Object.values(values ?? {});
    expect(list.length).toBe(4);
    for (const value of list) {
      expect(value.length).toBeGreaterThan(0);
    }
    expect(new Set(list).size).toBe(4);
  });
});

describe("G. charter §5.4 — zero fork/zeropoint imports in the factory graph", () => {
  const REPO_ROOT = resolve(import.meta.dir, "../..");

  test("no src/** or tests/managers/*.ts import path carries a fork marker", () => {
    const scanned = [
      ...tsFilesUnder(join(REPO_ROOT, "src")),
      ...tsFilesUnder(join(REPO_ROOT, "tests", "managers")),
    ];
    expect(scanned.length).toBeGreaterThan(0);
    expect(forkImportOffenders(scanned, (f) => readFileSync(f, "utf8"))).toEqual([]);
  });
});
