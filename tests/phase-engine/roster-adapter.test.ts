/**
 * Roster → TeamManifest adapter tests (Story DF1.6 T2).
 *
 * Tests the conversion between DF1.5's ResolvedRole and cli-anything's
 * TeamRole, plus the manifest construction.
 */
import { beforeEach, describe, expect, test } from "bun:test";
import * as path from "node:path";

import type { ResolvedRole, ResolvedRoster } from "../../src/phase-engine/roster/schema.ts";
import {
  rosterRoleToTeamRole,
  rosterToTeamManifest,
} from "../../src/phase-engine/phases/roster-adapter.ts";
import { TeamManifestSchema } from "../../cli-anything/src/types.ts";
import { splitRoleModel } from "../../cli-anything/src/team-events.ts";

describe("rosterRoleToTeamRole", () => {
  test("joins provider and model with single slash", () => {
    const role: ResolvedRole = {
      name: "analyst",
      model: "claude-sonnet-4-5",
      provider: "anthropic",
      thinking: "off",
      tools: null,
      writes: [],
      harness_engineering: [],
      slug: "anthropic/claude-sonnet-4-5",
      warnings: [],
    };

    const teamRole = rosterRoleToTeamRole(role, {
      agentId: "analyst-1",
      prompt: "You are an analyst",
    });

    expect(teamRole.agentId).toBe("analyst-1");
    expect(teamRole.model).toBe("anthropic/claude-sonnet-4-5");
    expect(teamRole.prompt).toBe("You are an analyst");
    expect(teamRole.lean).toBeUndefined();
    expect(teamRole.extensions).toBeUndefined();
  });

  test("handles model id containing slash — openrouter/deepseek/deepseek-v4-flash-0731", () => {
    const role: ResolvedRole = {
      name: "fixer",
      model: "deepseek/deepseek-v4-flash-0731",
      provider: "openrouter",
      thinking: "medium",
      tools: null,
      writes: ["cli-anything/"],
      harness_engineering: [],
      slug: "openrouter/deepseek/deepseek-v4-flash-0731",
      warnings: [],
    };

    const teamRole = rosterRoleToTeamRole(role, {
      agentId: "fixer-1",
      prompt: "Fix the code",
    });

    expect(teamRole.model).toBe("openrouter/deepseek/deepseek-v4-flash-0731");
  });

  test("round-trips through splitRoleModel correctly (negative control)", () => {
    const role: ResolvedRole = {
      name: "fixer",
      model: "deepseek/deepseek-v4-flash-0731",
      provider: "openrouter",
      thinking: "medium",
      tools: null,
      writes: [],
      harness_engineering: [],
      slug: "openrouter/deepseek/deepseek-v4-flash-0731",
      warnings: [],
    };

    const teamRole = rosterRoleToTeamRole(role, {
      agentId: "fixer-1",
      prompt: "Fix the code",
    });

    // Correct behavior: splitRoleModel splits on FIRST '/'
    const split = splitRoleModel(teamRole.model);
    expect(split.provider).toBe("openrouter");
    expect(split.model).toBe("deepseek/deepseek-v4-flash-0731");

    // Negative control: a wrong split on LAST '/' would fail
    const lastSlashIdx = teamRole.model.lastIndexOf("/");
    const wrongProvider = teamRole.model.slice(0, lastSlashIdx);
    const wrongModel = teamRole.model.slice(lastSlashIdx + 1);
    expect(wrongProvider).not.toBe("openrouter");
    expect(wrongModel).not.toBe("deepseek/deepseek-v4-flash-0731");
  });

  test("negative control: split('/') array approach would truncate model", () => {
    const role: ResolvedRole = {
      name: "fixer",
      model: "deepseek/deepseek-v4-flash-0731",
      provider: "openrouter",
      thinking: "off",
      tools: null,
      writes: [],
      harness_engineering: [],
      slug: "openrouter/deepseek/deepseek-v4-flash-0731",
      warnings: [],
    };

    const teamRole = rosterRoleToTeamRole(role, {
      agentId: "fixer-1",
      prompt: "Fix",
    });

    // Correct behavior via splitRoleModel
    const correct = splitRoleModel(teamRole.model);
    expect(correct.model).toBe("deepseek/deepseek-v4-flash-0731");

    // Wrong: s.split("/")[1] would give only "deepseek"
    const wrongModel = teamRole.model.split("/")[1];
    expect(wrongModel).not.toBe("deepseek/deepseek-v4-flash-0731");
    expect(wrongModel).toBe("deepseek"); // This proves the assertion catches it
  });
});

describe("rosterToTeamManifest", () => {
  test("constructs valid manifest with lead and workers", () => {
    const roster: ResolvedRoster = {
      path: "/fake/roster.yaml",
      roles: [
        {
          name: "lead",
          model: "claude-sonnet-4-5",
          provider: "anthropic",
          thinking: "low",
          tools: null,
          writes: [],
          harness_engineering: [],
          slug: "anthropic/claude-sonnet-4-5",
          warnings: [],
        },
        {
          name: "fixer",
          model: "claude-haiku-4-5",
          provider: "anthropic",
          thinking: "off",
          tools: null,
          writes: ["cli-anything/"],
          harness_engineering: [],
          slug: "anthropic/claude-haiku-4-5",
          warnings: [],
        },
      ],
      warnings: [],
    };

    const manifest = rosterToTeamManifest(roster, {
      name: "test-team",
      project: "qds-factory",
      leadRoleName: "lead",
      workerRoleNames: ["fixer"],
      prompts: {
        lead: "Lead the team",
        fixer: "Fix the bugs",
      },
    });

    const parsed = TeamManifestSchema.safeParse(manifest);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.name).toBe("test-team");
      expect(parsed.data.team.project).toBe("qds-factory");
      expect(parsed.data.team.lead.agentId).toBe("lead");
      expect(parsed.data.team.workers).toHaveLength(1);
      expect(parsed.data.team.workers[0]?.agentId).toBe("fixer");
    }
  });

  test("accepts 1-3 workers per TeamManifestSchema", () => {
    const baseRole: Omit<ResolvedRole, "name"> = {
      model: "claude-haiku-4-5",
      provider: "anthropic",
      thinking: "off",
      tools: null,
      writes: [],
      harness_engineering: [],
      slug: "anthropic/claude-haiku-4-5",
      warnings: [],
    };

    // 1 worker
    const roster1: ResolvedRoster = {
      path: "/fake.yaml",
      roles: [
        { ...baseRole, name: "lead" },
        { ...baseRole, name: "w1" },
      ],
      warnings: [],
    };
    const m1 = rosterToTeamManifest(roster1, {
      name: "t1",
      project: "p",
      leadRoleName: "lead",
      workerRoleNames: ["w1"],
      prompts: { lead: "x", w1: "y" },
    });
    expect(TeamManifestSchema.safeParse(m1).success).toBe(true);

    // 2 workers
    const roster2: ResolvedRoster = {
      path: "/fake.yaml",
      roles: [
        { ...baseRole, name: "lead" },
        { ...baseRole, name: "w1" },
        { ...baseRole, name: "w2" },
      ],
      warnings: [],
    };
    const m2 = rosterToTeamManifest(roster2, {
      name: "t2",
      project: "p",
      leadRoleName: "lead",
      workerRoleNames: ["w1", "w2"],
      prompts: { lead: "x", w1: "y", w2: "z" },
    });
    expect(TeamManifestSchema.safeParse(m2).success).toBe(true);

    // 3 workers
    const roster3: ResolvedRoster = {
      path: "/fake.yaml",
      roles: [
        { ...baseRole, name: "lead" },
        { ...baseRole, name: "w1" },
        { ...baseRole, name: "w2" },
        { ...baseRole, name: "w3" },
      ],
      warnings: [],
    };
    const m3 = rosterToTeamManifest(roster3, {
      name: "t3",
      project: "p",
      leadRoleName: "lead",
      workerRoleNames: ["w1", "w2", "w3"],
      prompts: { lead: "x", w1: "y", w2: "z", w3: "a" },
    });
    expect(TeamManifestSchema.safeParse(m3).success).toBe(true);
  });

  test("rejects >3 workers: THROWS at the adapter boundary (schema.parse inside)", () => {
    // The parse now lives INSIDE rosterToTeamManifest: an over-wide roster
    // must fail before manifest persistence or runTeamManifest, not at the
    // first downstream safeParse.
    const baseRole: Omit<ResolvedRole, "name"> = {
      model: "claude-haiku-4-5",
      provider: "anthropic",
      thinking: "off",
      tools: null,
      writes: [],
      harness_engineering: [],
      slug: "anthropic/claude-haiku-4-5",
      warnings: [],
    };

    const roster: ResolvedRoster = {
      path: "/fake.yaml",
      roles: [
        { ...baseRole, name: "lead" },
        { ...baseRole, name: "w1" },
        { ...baseRole, name: "w2" },
        { ...baseRole, name: "w3" },
        { ...baseRole, name: "w4" },
      ],
      warnings: [],
    };

    expect(() =>
      rosterToTeamManifest(roster, {
        name: "too-many",
        project: "p",
        leadRoleName: "lead",
        workerRoleNames: ["w1", "w2", "w3", "w4"],
        prompts: { lead: "x", w1: "y", w2: "z", w3: "a", w4: "b" },
      }),
    ).toThrow(/at most 3.*element/i);
  });

  test("omits optional caps when not provided — schema defaults apply", () => {
    const roster: ResolvedRoster = {
      path: "/fake.yaml",
      roles: [
        {
          name: "lead",
          model: "claude-sonnet-4-5",
          provider: "anthropic",
          thinking: "off",
          tools: null,
          writes: [],
          harness_engineering: [],
          slug: "anthropic/claude-sonnet-4-5",
          warnings: [],
        },
        {
          name: "w1",
          model: "claude-haiku-4-5",
          provider: "anthropic",
          thinking: "off",
          tools: null,
          writes: [],
          harness_engineering: [],
          slug: "anthropic/claude-haiku-4-5",
          warnings: [],
        },
      ],
      warnings: [],
    };

    const manifest = rosterToTeamManifest(roster, {
      name: "defaults-test",
      project: "p",
      leadRoleName: "lead",
      workerRoleNames: ["w1"],
      prompts: { lead: "x", w1: "y" },
      // No caps provided
    });

    const parsed = TeamManifestSchema.safeParse(manifest);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      // Schema defaults should be applied by Zod during parse
      expect(parsed.data.team.budgetCapUsd).toBe(0.5);
      expect(parsed.data.team.turnCap).toBe(5);
      expect(parsed.data.team.wallClockCapMs).toBe(300_000);
      expect(parsed.data.team.comsAwaitTimeoutMs).toBe(240_000);
    }
  });

  test("passes through provided caps without duplicating schema defaults", () => {
    const roster: ResolvedRoster = {
      path: "/fake.yaml",
      roles: [
        {
          name: "lead",
          model: "claude-sonnet-4-5",
          provider: "anthropic",
          thinking: "off",
          tools: null,
          writes: [],
          harness_engineering: [],
          slug: "anthropic/claude-sonnet-4-5",
          warnings: [],
        },
        {
          name: "w1",
          model: "claude-haiku-4-5",
          provider: "anthropic",
          thinking: "off",
          tools: null,
          writes: [],
          harness_engineering: [],
          slug: "anthropic/claude-haiku-4-5",
          warnings: [],
        },
      ],
      warnings: [],
    };

    const manifest = rosterToTeamManifest(roster, {
      name: "caps-test",
      project: "p",
      leadRoleName: "lead",
      workerRoleNames: ["w1"],
      prompts: { lead: "x", w1: "y" },
      budgetCapUsd: 1.5,
      turnCap: 10,
      wallClockCapMs: 600_000,
      comsAwaitTimeoutMs: 120_000,
    });

    const parsed = TeamManifestSchema.safeParse(manifest);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.team.budgetCapUsd).toBe(1.5);
      expect(parsed.data.team.turnCap).toBe(10);
      expect(parsed.data.team.wallClockCapMs).toBe(600_000);
      expect(parsed.data.team.comsAwaitTimeoutMs).toBe(120_000);
    }
  });
});

describe("rosterToTeamManifest: garbage-structure input handling", () => {
  test("null role entry throws TypeError (not schema error)", () => {
    // The adapter does NOT validate roster structure at the boundary — it
    // trusts the ResolvedRoster type. When a null entry is present (which can
    // only happen via type-erasure at runtime, bypassing TypeScript), accessing
    // role.name in rosterRoleToTeamRole throws a TypeError: "null is not an object (evaluating 'r.name')". This is a runtime crash, not
    // a clean ZodError.
    // NOTE: This is observable behavior, not ideal — a ZodError at the
    // boundary would be cleaner. Documented here for pre-dev contract clarity.
    const badRoster = {
      path: "/fake.yaml",
      roles: [null, { name: "w1", model: "m", provider: "p", thinking: "off", tools: null, writes: [], harness_engineering: [], slug: "p/m", warnings: [] }] as ResolvedRole[],
      warnings: [],
    } as ResolvedRoster;

    let thrownError: Error | undefined;
    try {
      rosterToTeamManifest(badRoster, {
        name: "bad",
        project: "p",
        leadRoleName: "w1",
        workerRoleNames: [],
        prompts: { w1: "x" },
      });
    } catch (e) {
      thrownError = e as Error;
    }
    expect(thrownError).toBeDefined();
    expect(thrownError).toBeInstanceOf(TypeError);
    expect(thrownError?.message).toMatch(/null.*not an object/i);
  });

  test("role missing name: Map lookup fails with Error (not ZodError)", () => {
    // A role object with missing/undefined name still goes into the Map, but
    // the name key becomes undefined. When the adapter looks up the role by
    // name (e.g., "lead"), Map.get("lead") returns undefined, and the adapter
    // throws a clean Error with message `Lead role "lead" not found in roster`.
    // This is better than a TypeError but still not a ZodError.
    const badRoster: ResolvedRoster = {
      path: "/fake.yaml",
      roles: [
        { name: undefined as unknown as string, model: "m", provider: "p", thinking: "off", tools: null, writes: [], harness_engineering: [], slug: "p/m", warnings: [] },
      ],
      warnings: [],
    };

    expect(() =>
      rosterToTeamManifest(badRoster, {
        name: "bad",
        project: "p",
        leadRoleName: "lead",
        workerRoleNames: [],
        prompts: {},
      }),
    ).toThrow(/Lead role "lead" not found in roster/);
  });

  test("role missing provider: adapter throws clean Error at the provider guard", () => {
    // A role with provider undefined hits rosterRoleToTeamRole's RA guard
    // (roster-adapter.ts:37) BEFORE any "undefined/m" model can be built — a
    // plain Error with the provider name in the message, not a ZodError from
    // TeamManifestSchema.parse. (The ZodError-at-parse path this test used to
    // describe was superseded by that guard in review round 6/7 hardening.)
    const badRoster: ResolvedRoster = {
      path: "/fake.yaml",
      roles: [
        { name: "lead", model: "m", provider: undefined as unknown as string, thinking: "off", tools: null, writes: [], harness_engineering: [], slug: "undefined/m", warnings: [] },
      ],
      warnings: [],
    };

    expect(() =>
      rosterToTeamManifest(badRoster, {
        name: "bad",
        project: "p",
        leadRoleName: "lead",
        workerRoleNames: [],
        prompts: { lead: "x" },
      }),
    ).toThrow(/role provider must be a non-empty string \(got undefined\)/);
  });

  test("empty workers array is rejected by TeamManifestSchema (min 1 required)", () => {
    // TeamManifestSchema requires at least 1 worker: .min(1).max(3).
    // Empty workerRoleNames triggers ZodError at parse boundary.
    const baseRole: Omit<ResolvedRole, "name"> = {
      model: "claude-haiku-4-5",
      provider: "anthropic",
      thinking: "off",
      tools: null,
      writes: [],
      harness_engineering: [],
      slug: "anthropic/claude-haiku-4-5",
      warnings: [],
    };

    const roster: ResolvedRoster = {
      path: "/fake.yaml",
      roles: [
        { ...baseRole, name: "lead" },
      ],
      warnings: [],
    };

    expect(() =>
      rosterToTeamManifest(roster, {
        name: "no-workers",
        project: "p",
        leadRoleName: "lead",
        workerRoleNames: [], // Empty — should reject
        prompts: { lead: "x" },
      }),
    ).toThrow(/at least 1.*element/i);
  });
});

describe("rosterToTeamManifest: RA-tests — negative tests for new roster-adapter guards", () => {
  const baseRole: Omit<ResolvedRole, "name"> = {
    model: "claude-haiku-4-5",
    provider: "anthropic",
    thinking: "off",
    tools: null,
    writes: [],
    harness_engineering: [],
    slug: "anthropic/claude-haiku-4-5",
    warnings: [],
  };

  test("empty provider throws clean Error (NOT undefined/m passing schema)", () => {
    // Empty string provider fails at the adapter boundary with a clean Error,
    // not as a Zod schema pass with "undefined/m" model.
    const badRoster: ResolvedRoster = {
      path: "/fake.yaml",
      roles: [
        { ...baseRole, name: "lead", provider: "" as unknown as string, slug: "/claude-haiku-4-5" },
        { ...baseRole, name: "w1" },
      ],
      warnings: [],
    };

    // ponytail: Bun test doesn't support predicates in .toThrow(), check error message directly
    let thrownError: Error | undefined;
    try {
      rosterToTeamManifest(badRoster, {
        name: "bad",
        project: "p",
        leadRoleName: "lead",
        workerRoleNames: ["w1"],
        prompts: { lead: "x", w1: "y" },
      });
    } catch (e) {
      thrownError = e as Error;
    }
    expect(thrownError).toBeDefined();
    // Clean Error about provider, not "undefined/m" Zod message
    expect(thrownError?.message).toContain("provider");
    expect(thrownError?.message).not.toContain("undefined");
  });

  test("missing prompts[worker] entry throws Error containing the role name", () => {
    // Adapter checks prompts map has entries for each worker role name.
    // Missing entry throws Error mentioning the specific role.
    const roster: ResolvedRoster = {
      path: "/fake.yaml",
      roles: [
        { ...baseRole, name: "lead" },
        { ...baseRole, name: "fixer" },
      ],
      warnings: [],
    };

    // ponytail: Bun test doesn't support predicates in .toThrow(), check error message directly
    let thrownError: Error | undefined;
    try {
      rosterToTeamManifest(roster, {
        name: "missing-prompt",
        project: "p",
        leadRoleName: "lead",
        workerRoleNames: ["fixer"],
        prompts: { lead: "Lead the team" }, // Missing "fixer" prompt
      });
    } catch (e) {
      thrownError = e as Error;
    }
    expect(thrownError).toBeDefined();
    expect(thrownError?.message).toContain("fixer");
  });

  test("empty-string worker prompt throws clean Error (S5)", () => {
    // Adapter guards against empty/whitespace prompts per S5 hardening.
    // Empty prompt string throws a clean Error, not a ZodError.
    const roster: ResolvedRoster = {
      path: "/fake.yaml",
      roles: [
        { ...baseRole, name: "lead" },
        { ...baseRole, name: "fixer" },
      ],
      warnings: [],
    };

    let thrownError: Error | undefined;
    try {
      rosterToTeamManifest(roster, {
        name: "empty-prompt",
        project: "p",
        leadRoleName: "lead",
        workerRoleNames: ["fixer"],
        prompts: { lead: "Lead", fixer: "" }, // Empty prompt
      });
    } catch (e) {
      thrownError = e as Error;
    }
    expect(thrownError).toBeDefined();
    expect(thrownError?.message).toMatch(/missing or empty prompt/i);
    expect(thrownError?.message).toContain("fixer");
  });

  test("duplicate workerRoleNames throws clean Error", () => {
    // Duplicate worker names in the array should throw a clean Error.
    const roster: ResolvedRoster = {
      path: "/fake.yaml",
      roles: [
        { ...baseRole, name: "lead" },
        { ...baseRole, name: "w1" },
      ],
      warnings: [],
    };

    expect(() =>
      rosterToTeamManifest(roster, {
        name: "dup-workers",
        project: "p",
        leadRoleName: "lead",
        workerRoleNames: ["w1", "w1"], // Duplicate
        prompts: { lead: "x", w1: "y" },
      }),
    ).toThrow(/duplicate/i);
  });

  test("worker listed that also appears as lead-in-workers throws clean Error", () => {
    // When a worker is also the lead (lead-in-workers pattern), it should
    // throw a clean Error. Use valid second worker so min(1) isn't the issue.
    const roster: ResolvedRoster = {
      path: "/fake.yaml",
      roles: [
        { ...baseRole, name: "lead" },
        { ...baseRole, name: "w1" },
        { ...baseRole, name: "w2" },
      ],
      warnings: [],
    };

    // ponytail: Bun test doesn't support predicates in .toThrow(), check error message directly
    let thrownError: Error | undefined;
    try {
      rosterToTeamManifest(roster, {
        name: "lead-in-workers",
        project: "p",
        leadRoleName: "lead",
        workerRoleNames: ["lead", "w1", "w2"], // lead appears in workers
        prompts: { lead: "x", w1: "y", w2: "z" },
      });
    } catch (e) {
      thrownError = e as Error;
    }
    expect(thrownError).toBeDefined();
    expect(thrownError?.message).toMatch(/duplicate/i);
  });
});

describe("rosterToTeamManifest: review-round hardening (A19, A20)", () => {
  const baseRole: Omit<ResolvedRole, "name"> = {
    model: "claude-haiku-4-5",
    provider: "anthropic",
    thinking: "off",
    tools: null,
    writes: [],
    harness_engineering: [],
    slug: "anthropic/claude-haiku-4-5",
    warnings: [],
  };

  test("A19: role with empty model field → rejected per adapter contract", () => {
    // Empty model string fails the guard in rosterRoleToTeamRole
    const badRoster: ResolvedRoster = {
      path: "/fake.yaml",
      roles: [
        { ...baseRole, name: "lead", model: "" as unknown as string, slug: "/claude-haiku-4-5" },
        { ...baseRole, name: "w1" },
      ],
      warnings: [],
    };

    // Adapter checks model is non-empty string before joining
    let thrownError: Error | undefined;
    try {
      rosterToTeamManifest(badRoster, {
        name: "bad",
        project: "p",
        leadRoleName: "lead",
        workerRoleNames: ["w1"],
        prompts: { lead: "x", w1: "y" },
      });
    } catch (e) {
      thrownError = e as Error;
    }
    expect(thrownError).toBeDefined();
    expect(thrownError?.message).toContain("model");
    expect(thrownError?.message).toMatch(/non-empty|string/i);
  });

  test("A20: single-slash model id round-trips provider/model correctly", () => {
    // Complement to existing multi-slash test — verify simple case works
    const role: ResolvedRole = {
      name: "lead",
      model: "claude-sonnet-4-5",
      provider: "anthropic",
      thinking: "off",
      tools: null,
      writes: [],
      harness_engineering: [],
      slug: "anthropic/claude-sonnet-4-5",
      warnings: [],
    };

    const teamRole = rosterRoleToTeamRole(role, {
      agentId: "lead-1",
      prompt: "Lead",
    });

    expect(teamRole.model).toBe("anthropic/claude-sonnet-4-5");

    // Verify round-trip through splitRoleModel
    const split = splitRoleModel(teamRole.model);
    expect(split.provider).toBe("anthropic");
    expect(split.model).toBe("claude-sonnet-4-5");
  });
});
