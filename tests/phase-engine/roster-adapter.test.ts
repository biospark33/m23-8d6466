/**
 * Roster → TeamManifest adapter tests (Story DF1.6 T2).
 *
 * Tests the conversion between DF1.5's ResolvedRole and cli-anything's
 * TeamRole, plus the manifest construction.
 */
import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import type { ResolvedRole, ResolvedRoster } from "../../src/phase-engine/roster/schema.ts";
import {
  rosterRoleToTeamRole,
  rosterToTeamManifest,
} from "../../src/phase-engine/phases/roster-adapter.ts";
import { TeamManifestSchema } from "../../cli-anything/src/types.ts";
import { splitRoleModel } from "../../cli-anything/src/team-events.ts";

const tmpRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "df1-6-adapter-")));
afterEach(() => {
  // Clean up any test artifacts
  if (fs.existsSync(tmpRoot)) {
    const entries = fs.readdirSync(tmpRoot);
    for (const entry of entries) {
      const p = path.join(tmpRoot, entry);
      fs.rmSync(p, { recursive: true, force: true });
    }
  }
});
afterAll(() => {
  try {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  } catch (e) {
    // best-effort cleanup — warn so orphaned temp dirs are visible
    console.warn(`roster-adapter.test cleanup failed: ${tmpRoot}`, e instanceof Error ? e.message : String(e));
  }
});

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
      expect(parsed.data.team.budgetCapUsd).toBeDefined();
      expect(parsed.data.team.turnCap).toBeDefined();
      expect(parsed.data.team.wallClockCapMs).toBeDefined();
      expect(parsed.data.team.comsAwaitTimeoutMs).toBeDefined();
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
    // role.name in rosterRoleToTeamRole throws a TypeError: "Cannot read
    // properties of null (reading 'provider')". This is a runtime crash, not
    // a clean ZodError.
    // NOTE: This is observable behavior, not ideal — a ZodError at the
    // boundary would be cleaner. Documented here for pre-dev contract clarity.
    const badRoster = {
      path: "/fake.yaml",
      roles: [null, { name: "w1", model: "m", provider: "p", thinking: "off", tools: null, writes: [], harness_engineering: [], slug: "p/m", warnings: [] }] as ResolvedRole[],
      warnings: [],
    } as ResolvedRoster;

    expect(() =>
      rosterToTeamManifest(badRoster, {
        name: "bad",
        project: "p",
        leadRoleName: "w1",
        workerRoleNames: [],
        prompts: { w1: "x" },
      }),
    ).toThrow(TypeError);
  });

  test("role missing name: Map lookup fails with Error (not ZodError)", () => {
    // A role object with missing/undefined name still goes into the Map, but
    // the name key becomes undefined. When the adapter looks up the role by
    // name (e.g., "lead"), Map.get("lead") returns undefined, and the adapter
    // throws a clean Error with message "Lead role 'lead' not found in roster".
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

  test("role missing provider: creates invalid model field, Zod catches it at parse", () => {
    // A role with missing provider/model pair causes rosterRoleToTeamRole to
    // construct model as "undefined/m" (undefined coerced to string). The
    // resulting manifest fails TeamManifestSchema.parse with a ZodError about
    // the invalid model field. This is the CLEANEST error path among the
    // garbage-structure cases — Zod validates at the boundary.
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
    ).toThrow(); // ZodError from TeamManifestSchema.parse
  });
});
