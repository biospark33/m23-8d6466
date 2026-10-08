/**
 * M2.2 AC1 — roster-granted kg-recall (in-box) reaches the worker purely via
 * the DF1.5 `harness_engineering` shape; roles without the grant see nothing.
 * No schema change, no argv-builder change: the existing plumbing is the
 * contract under test.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync, realpathSync } from "node:fs";
import { resolve } from "node:path";

import { parseRoster } from "../../src/phase-engine/roster/schema.ts";
import { rosterRoleToTeamRole } from "../../src/phase-engine/phases/roster-adapter.ts";
import {
  buildWorkerArgv,
  REPO_ROOT,
  resolveExtensionPaths,
} from "../../cli-anything/scripts/team-lead-driver.ts";

const ROSTER_PATH = resolve(import.meta.dir, "../../config/rosters/qds-default.roster.yaml");
const SELF_COMPACT = "pi-vs-claude-code-vendor/self-compact/extensions/self-compact/self-compact.ts";
const KG_RECALL = "pi-vs-claude-code-vendor/kg-recall/extensions/kg-recall/kg-recall.ts";

const loadDefaultRoster = () =>
  parseRoster(readFileSync(ROSTER_PATH, "utf8"), ROSTER_PATH);

/** The exact narrowed-tools warning the resolver emits (schema.ts:356-362). */
const NARROWED_TOOLS_WARNING = (label: string) =>
  `roles[${label}]: harness_engineering extensions are loaded but tools is a non-null allowlist — any tool an extension registers is silently filtered out unless named in tools`;

describe("AC1: qds-default roster grant", () => {
  test("worker role carries BOTH self-compact and kg-recall; no other role carries kg-recall", () => {
    const roster = loadDefaultRoster();
    const worker = roster.roles.find((r) => r.name === "worker");
    expect(worker).toBeDefined();
    expect(worker?.harness_engineering).toContain(SELF_COMPACT);
    expect(worker?.harness_engineering).toContain(KG_RECALL);

    // Silent-drop hazard pinned on the REAL roster, not just the synthetic
    // YAML below: the worker's `tools` must stay null or name kg_recall — any
    // other non-null allowlist and pi's --tools filter silently drops the
    // extension's tool outright (the hazard the worker-role comment in
    // qds-default.roster.yaml names; schema.ts only WARNS).
    expect(
      worker?.tools === null || (worker?.tools ?? []).includes("kg_recall"),
    ).toBe(true);

    for (const role of roster.roles.filter((r) => r.name !== "worker")) {
      expect(role.harness_engineering).not.toContain(KG_RECALL);
    }
  });
});

describe("AC1: buildWorkerArgv carries the grant", () => {
  const baseWorker = {
    agentId: "worker",
    provider: "openrouter",
    model: "deepseek/deepseek-v3.2",
    prompt: "do the work",
  };

  test("extensions [self-compact, kg-recall] → argv has the -e pair for kg-recall", () => {
    const argv = buildWorkerArgv({ ...baseWorker, extensions: [SELF_COMPACT, KG_RECALL] });
    const i = argv.indexOf("-e");
    expect(i).toBeGreaterThanOrEqual(0);
    // The kg-recall pair specifically (it is the second entry in the list).
    const j = argv.indexOf(KG_RECALL);
    expect(j).toBeGreaterThan(0);
    expect(argv[j - 1]).toBe("-e");
  });

  test("extensions undefined → no -e token anywhere", () => {
    const argv = buildWorkerArgv({ ...baseWorker });
    expect(argv).not.toContain("-e");
  });

  test("extensions [] → argv byte-identical to the undefined case (DF1.5 AC3)", () => {
    const withEmpty = buildWorkerArgv({ ...baseWorker, extensions: [] });
    expect(withEmpty).toEqual(buildWorkerArgv({ ...baseWorker }));
  });

  test("extensions WITHOUT kg-recall → no -e pair for it (un-granted role sees nothing)", () => {
    const argv = buildWorkerArgv({ ...baseWorker, extensions: [SELF_COMPACT] });
    expect(argv).not.toContain(KG_RECALL);
  });
});

describe("AC1: resolveExtensionPaths accepts the kg-recall path", () => {
  test("repo-relative kg-recall path resolves, contained in REPO_ROOT, realpath-resolved", () => {
    const r = resolveExtensionPaths([KG_RECALL], REPO_ROOT);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.paths).toHaveLength(1);

    // Expected = realpath when the tree exists, lexical containment fallback
    // when it does not yet — computed the same way the driver computes it.
    const root = (() => {
      try {
        return realpathSync(REPO_ROOT);
      } catch {
        return REPO_ROOT;
      }
    })();
    let expected: string;
    try {
      expected = realpathSync(resolve(root, KG_RECALL));
    } catch {
      expected = resolve(root, KG_RECALL);
    }
    expect(r.paths[0]).toBe(expected);
  });
});

describe("AC1: schema narrowed-tools warning names the kg-recall hazard", () => {
  const roleYaml = (tools: string) => `
defaults:
  provider: openrouter
  writes: []
roles:
  - name: kgworker
    model: some/model-x
    tools: ${tools}
    harness_engineering:
      - ${KG_RECALL}
`;

  test("non-null tools NOT naming kg_recall → the exact warning fires", () => {
    const roster = parseRoster(roleYaml('["read", "grep"]'));
    const role = roster.roles.find((r) => r.name === "kgworker");
    expect(role?.warnings).toContain(NARROWED_TOOLS_WARNING("kgworker"));
  });

  test("tools: null → no such warning", () => {
    const roster = parseRoster(roleYaml("null"));
    const role = roster.roles.find((r) => r.name === "kgworker");
    expect(role?.warnings).not.toContain(NARROWED_TOOLS_WARNING("kgworker"));
  });
});

describe("AC1: negative controls — un-granted roles surface no extensions key", () => {
  test("planner/reviewer from the real roster map to TeamRole with extensions undefined", () => {
    const roster = loadDefaultRoster();
    for (const role of roster.roles.filter((r) => r.name !== "worker")) {
      const t = rosterRoleToTeamRole(role, { agentId: role.name, prompt: "p" });
      expect(t.extensions).toBeUndefined();
    }
  });
});
