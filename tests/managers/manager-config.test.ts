/**
 * A1 — the manager config of record (AC1, AC4, AC5's validator half).
 *
 * Every named refusal is asserted with its error code; the accepted shape is
 * asserted with the validated types. No mock library — plain fixtures built by
 * mutating one valid config.
 */

import { describe, expect, test } from "bun:test";
import {
  ManagerConfigError,
  ManagerConfigSchema,
  WorkKeySchema,
  validateManagerConfig,
  zodErrors,
  type ManagerConfig,
  type ManagerConfigErrorCode,
} from "../../src/managers/manager-config.ts";

/** The accepted shape of record: one Home, operator-as-user owner, three bots with ceilings. */
function baseConfig() {
  return {
    homes: [
      {
        owner: { kind: "user", id: "operator-principal" },
        gatewayBaseUrl: "https://gateway.internal",
      },
    ],
    bots: [
      { id: "bot-dev-manager", department: "dev", spendCeilingUsd: 5 },
      { id: "bot-qa-manager", department: "qa", spendCeilingUsd: 5 },
      { id: "bot-maintenance-manager", department: "maintenance", spendCeilingUsd: 5 },
    ],
  };
}

/** Assert validation refuses with the named code, a non-empty remediation, and any required message fragments. */
function expectRefusal(input: unknown, code: ManagerConfigErrorCode, messageParts: string[] = []): void {
  let err: unknown;
  try {
    validateManagerConfig(input);
    err = undefined;
  } catch (e) {
    err = e;
  }
  expect(err).toBeInstanceOf(ManagerConfigError);
  const refusal = err as ManagerConfigError;
  expect(refusal.code).toBe(code);
  expect(refusal.remediation.length).toBeGreaterThan(0);
  for (const part of messageParts) expect(refusal.message).toContain(part);
}

describe("manager config of record", () => {
  test("happy path: the accepted shape validates and returns the pinned types", () => {
    const cfg: ManagerConfig = validateManagerConfig(baseConfig());
    expect(cfg.homes).toHaveLength(1);
    expect(cfg.homes[0]!.owner.kind).toBe("user");
    expect(cfg.homes[0]!.gatewayBaseUrl).toBe("https://gateway.internal");
    expect(cfg.bots.map((b) => b.id)).toEqual([
      "bot-dev-manager",
      "bot-qa-manager",
      "bot-maintenance-manager",
    ]);
    // AC4: every bot carries a positive ceiling, typed as required (not optional).
    for (const bot of cfg.bots) expect(bot.spendCeilingUsd).toBeGreaterThan(0);
  });

  test("strict schema: an unknown key is a validation error, never dropped", () => {
    const cfg = baseConfig();
    (cfg.bots[0] as Record<string, unknown>).nickname = "dev";
    const parsed = ManagerConfigSchema.safeParse(cfg);
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(zodErrors(parsed.error)).toContain("bots.0: Unrecognized key(s) in object: 'nickname'");
    }
    expectRefusal(cfg, "schema-invalid", ["Unrecognized key"]);
  });

  test("org-kind owner refused, citing ADR-RUN-2 D1 and the company-bot upgrade door", () => {
    const cfg = baseConfig();
    cfg.homes[0]!.owner = { kind: "org", id: "acme-corp" };
    expectRefusal(cfg, "org-owner-refused", ["ADR-RUN-2", "company-bot"]);
  });

  test("ceiling-less bot refused (AC4: absent = refusal, never silently unlimited)", () => {
    const cfg = baseConfig();
    const dev = cfg.bots[0]!;
    const qa = cfg.bots[1]!;
    const maint = cfg.bots[2]!;
    const ceilingLess = { id: qa.id, department: qa.department };
    expectRefusal({ ...cfg, bots: [dev, ceilingLess, maint] }, "spend-ceiling-required");
  });

  test("zero and negative ceilings refused (AC4: zero ceiling is not unlimited)", () => {
    const zero = baseConfig();
    zero.bots[2]!.spendCeilingUsd = 0;
    expectRefusal(zero, "spend-ceiling-positive");

    const negative = baseConfig();
    negative.bots[0]!.spendCeilingUsd = -1;
    expectRefusal(negative, "spend-ceiling-positive");
  });

  test("duplicate Home refused (a second Home entry) — and zero Homes", () => {
    const cfg = baseConfig();
    cfg.homes = [cfg.homes[0]!, { ...cfg.homes[0]! }];
    expectRefusal(cfg, "home-count", ["duplicate"]);

    const empty = baseConfig();
    empty.homes = [];
    expectRefusal(empty, "home-count");
  });

  test("non-`bot-`-prefixed id refused (ADR-RUN-2 D1)", () => {
    const cfg = baseConfig();
    cfg.bots[0]!.id = "dev-manager";
    expectRefusal(cfg, "bot-id-prefix");
  });

  test("`default` alias refused — Hermes's reserved root alias", () => {
    const cfg = baseConfig();
    cfg.bots[0]!.id = "default";
    expectRefusal(cfg, "reserved-default-alias");
  });

  test("duplicate bot id refused", () => {
    const cfg = baseConfig();
    cfg.bots[1]!.id = cfg.bots[0]!.id;
    expectRefusal(cfg, "bot-id-duplicate");
  });

  test("wrong bot count refused — exactly three, one per department", () => {
    const two = baseConfig();
    two.bots = two.bots.slice(0, 2);
    expectRefusal(two, "bot-count");

    const four = baseConfig();
    four.bots.push({ ...four.bots[0]!, id: "bot-dev-backup", department: "dev" });
    expectRefusal(four, "bot-count");
  });

  test("two bots on one department refused (one per department: dev, qa, maintenance)", () => {
    const cfg = baseConfig();
    cfg.bots[1]!.department = "dev";
    expectRefusal(cfg, "bot-department");
  });

  test("`w:`-form workKey validation (AC5, DD-20)", () => {
    expect(WorkKeySchema.safeParse("w:qa-42").success).toBe(true);
    expect(WorkKeySchema.safeParse("w:x").success).toBe(true);
    expect(WorkKeySchema.safeParse("w: x").success).toBe(true); // whitespace inside the remainder is fine
    expect(WorkKeySchema.safeParse("qa-42").success).toBe(false); // missing prefix
    expect(WorkKeySchema.safeParse("w:").success).toBe(false); // empty remainder
    expect(WorkKeySchema.safeParse("w: ").success).toBe(false); // whitespace-only remainder
    expect(WorkKeySchema.safeParse("w:  ").success).toBe(false);
    // control characters are refused anywhere in the key (U+0000–U+001F, U+007F)
    expect(WorkKeySchema.safeParse("w:run\u0000").success).toBe(false); // NUL in the remainder
    expect(WorkKeySchema.safeParse("w:\u0007").success).toBe(false); // control char as the whole remainder
    expect(WorkKeySchema.safeParse("w:\u007Fqa").success).toBe(false); // DEL
  });

  test("non-URL gatewayBaseUrl refused with gateway-url-invalid (the pin must be a URL)", () => {
    const cfg = baseConfig();
    cfg.homes[0]!.gatewayBaseUrl = "not-a-url";
    expectRefusal(cfg, "gateway-url-invalid", ["not-a-url"]);
  });

  test("credential-bearing gatewayBaseUrl refused — the verbatim pin never carries a secret", () => {
    const userpass = baseConfig();
    userpass.homes[0]!.gatewayBaseUrl = "https://user:pass@host";
    expectRefusal(userpass, "gateway-url-invalid", ["user:pass@host"]);

    const userOnly = baseConfig();
    userOnly.homes[0]!.gatewayBaseUrl = "https://user@host";
    expectRefusal(userOnly, "gateway-url-invalid", ["user@host"]);
  });

  test("bare https://host (no credentials) accepted", () => {
    const cfg = baseConfig();
    cfg.homes[0]!.gatewayBaseUrl = "https://host";
    expect(() => validateManagerConfig(cfg)).not.toThrow();
  });

  test("http and https gateway base URLs are accepted", () => {
    const https = baseConfig();
    https.homes[0]!.gatewayBaseUrl = "https://gateway.internal";
    expect(() => validateManagerConfig(https)).not.toThrow();

    const http = baseConfig();
    http.homes[0]!.gatewayBaseUrl = "http://gw:1";
    expect(() => validateManagerConfig(http)).not.toThrow();
  });

  test("hygiene: whitespace-padded, query-bearing, and fragment-bearing pins are refused (the pin is compared verbatim)", () => {
    // Leading whitespace would be stripped by the URL parser but compared
    // verbatim downstream — a refusal, never a silent trim.
    const padded = baseConfig();
    padded.homes[0]!.gatewayBaseUrl = " https://gw";
    expectRefusal(padded, "gateway-url-invalid", [" https://gw"]);

    // A query could carry a secret.
    const query = baseConfig();
    query.homes[0]!.gatewayBaseUrl = "https://gw?token=x";
    expectRefusal(query, "gateway-url-invalid", ["token=x"]);

    // So could a fragment.
    const fragment = baseConfig();
    fragment.homes[0]!.gatewayBaseUrl = "https://gw#frag";
    expectRefusal(fragment, "gateway-url-invalid");

    // Trailing whitespace too.
    const trailing = baseConfig();
    trailing.homes[0]!.gatewayBaseUrl = "https://gw ";
    expectRefusal(trailing, "gateway-url-invalid");

    // And the clean pins still pass.
    expect(() => validateManagerConfig(baseConfig())).not.toThrow();
  });
});
