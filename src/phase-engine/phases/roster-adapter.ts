/**
 * DF1.6 — Roster → TeamManifest adapter.
 *
 * Converts DF1.5's validated roster into cli-anything's TeamManifest format.
 * This is the ONE conversion point; all roster→manifest wiring goes through
 * these functions.
 *
 * Key invariant: model string joining happens HERE, decomposition happens via
 * splitRoleModel (cli-anything/src/team-events.ts). A model id may itself
 * contain '/' (e.g., openrouter + deepseek/deepseek-v4-flash-0731), so the
 * join must preserve the original pair verbatim.
 */

import { TeamManifestSchema, type TeamManifest, type TeamRole } from "../../../cli-anything/src/types.ts";
import type { ResolvedRole, ResolvedRoster } from "../roster/schema.ts";

/**
 * Convert a DF1.5 ResolvedRole to a cli-anything TeamRole.
 *
 * The model field is constructed as `${provider}/${model}` — this joins the
 * authoritative pair from ResolvedRole without re-splitting. Decomposition
 * MUST use splitRoleModel from cli-anything/src/team-events.ts, which splits
 * on the FIRST '/'.
 *
 * Options provide caller-supplied context: agentId becomes the coms cname
 * and artifact filename; prompt is the task brief (roster has no prompt field).
 *
 * lean is left undefined — a manifest-level concern, not roster-level.
 * extensions/extensionArgs ARE roster-level: harness_engineering paths and
 * compaction thresholds flow through to the worker's pi argv.
 */
export function rosterRoleToTeamRole(
  role: ResolvedRole,
  opts: { agentId: string; prompt: string },
): TeamRole {
  // Guard: provider and model must be non-empty strings (RA1: "undefined/m" garbage passes refinement)
  if (!role.provider || typeof role.provider !== "string" || role.provider.trim().length === 0) {
    throw new Error(`role provider must be a non-empty string (got ${JSON.stringify(role.provider)})`);
  }
  if (!role.model || typeof role.model !== "string" || role.model.trim().length === 0) {
    throw new Error(`role model must be a non-empty string (got ${JSON.stringify(role.model)})`);
  }
  const extensions = role.harness_engineering?.length ? role.harness_engineering : undefined;
  const extensionArgs = role.compaction
    ? [
        "--compact-soft-at", role.compaction.soft_at,
        "--compact-at", role.compaction.at,
        "--compact-buffer", role.compaction.buffer,
      ]
    : undefined;
  return {
    agentId: opts.agentId,
    // Join: never split here. splitRoleModel decomposes.
    model: `${role.provider}/${role.model}`,
    prompt: opts.prompt,
    // lean stays manifest-level; extensions/extensionArgs come from the
    // roster's harness_engineering / compaction fields (self-compact wiring).
    lean: undefined,
    ...(extensions !== undefined && { extensions }),
    ...(extensionArgs !== undefined && { extensionArgs }),
  };
}

/**
 * Options for rosterToTeamManifest.
 */
export interface RosterToManifestOptions {
  /** Manifest name — roster has no name field. */
  name: string;
  /** Warren project id (required by TeamManifestSchema). */
  project: string;
  /** Name of the lead role in roster.roles. */
  leadRoleName: string;
  /** Names of worker roles in roster.roles. */
  workerRoleNames: string[];
  /** Prompt for each role (role name → prompt text). */
  prompts: Record<string, string>;
  /** Optional budget cap USD — omitted means use schema default (0.50). */
  budgetCapUsd?: number;
  /** Optional turn cap per agent — omitted means use schema default (5). */
  turnCap?: number;
  /** Optional wall-clock cap ms — omitted means use schema default (300_000). */
  wallClockCapMs?: number;
  /** Optional coms await timeout ms — omitted means use schema default (240_000). */
  comsAwaitTimeoutMs?: number;
}

/**
 * Convert a validated DF1.5 roster to a cli-anything TeamManifest.
 *
 * The constructed manifest is VALIDATED through TeamManifestSchema.parse and
 * the parsed TeamManifest returned — an invalid roster-derived manifest
 * (e.g. >3 workers) throws HERE, before persistence or runTeamManifest,
 * rather than surfacing as a zod error deep in the harness. Callers should
 * handle ZodError (typically surfaced as a logic exitStatus).
 */
export function rosterToTeamManifest(
  roster: ResolvedRoster,
  opts: RosterToManifestOptions,
): TeamManifest {
  const roleByName = new Map(roster.roles.map((r) => [r.name, r]));

  const leadRole = roleByName.get(opts.leadRoleName);
  if (!leadRole) {
    throw new Error(`Lead role "${opts.leadRoleName}" not found in roster`);
  }

  // RA4: the runner forwards extensions/extensionArgs for WORKERS only —
  // QDS_AGENT_TEAM_CONFIG_JSON's lead object carries agentId/model/prompt
  // alone (cli-anything/src/runner.ts), so a lead declaring self-compact
  // wiring would pass TeamManifestSchema and then silently run WITHOUT the
  // extension. INV-3: a declared extension must not be skipped without
  // warning — refuse here, at the one conversion point. Workers keep full
  // support; compaction alone still trips this because the DF1.5 schema gate
  // only admits compaction alongside harness_engineering, and the adapter is
  // deliberately defensive about what schema already validated (RA1).
  const leadDeclared: string[] = [];
  if (leadRole.harness_engineering?.length) {
    leadDeclared.push("harness_engineering");
  }
  if (leadRole.compaction !== undefined) {
    leadDeclared.push("compaction");
  }
  if (leadDeclared.length > 0) {
    throw new Error(
      `lead role "${opts.leadRoleName}" declares ${leadDeclared.join(" + ")} but the runner drops extensions/extensionArgs on the lead — move self-compact wiring to a worker role`,
    );
  }

  const workers = opts.workerRoleNames.map((name) => {
    const role = roleByName.get(name);
    if (!role) {
      throw new Error(`Worker role "${name}" not found in roster`);
    }
    // RA2: explicit missing prompt check — avoids misleading ZodError "prompt must be at least 1 character"
    const prompt = opts.prompts[name];
    if (prompt === undefined || prompt === null || prompt.trim().length === 0) {
      throw new Error(`missing or empty prompt for worker role "${name}"`);
    }
    return rosterRoleToTeamRole(role, {
      agentId: name,
      prompt,
    });
  });

  // RA2: explicit missing prompt check for lead role
  const leadPrompt = opts.prompts[opts.leadRoleName];
  if (leadPrompt === undefined || leadPrompt === null || leadPrompt.trim().length === 0) {
    throw new Error(`missing or empty prompt for lead role "${opts.leadRoleName}"`);
  }
  const lead = rosterRoleToTeamRole(leadRole, {
    agentId: opts.leadRoleName,
    prompt: leadPrompt,
  });

  // RA3: dedup guard — duplicate agentIds cause cname/artifact collisions
  const agentIds = new Set([opts.leadRoleName, ...opts.workerRoleNames]);
  if (agentIds.size !== opts.workerRoleNames.length + 1) {
    const dup = [opts.leadRoleName, ...opts.workerRoleNames].filter((id, i, arr) => arr.indexOf(id) !== i);
    throw new Error(`duplicate agentIds: ${dup.join(", ")}`);
  }

  return TeamManifestSchema.parse({
    name: opts.name,
    team: {
      lead,
      workers,
      project: opts.project,
      // Pass through optional caps — Zod defaults apply when omitted
      ...(opts.budgetCapUsd !== undefined && { budgetCapUsd: opts.budgetCapUsd }),
      ...(opts.turnCap !== undefined && { turnCap: opts.turnCap }),
      ...(opts.wallClockCapMs !== undefined && { wallClockCapMs: opts.wallClockCapMs }),
      ...(opts.comsAwaitTimeoutMs !== undefined && {
        comsAwaitTimeoutMs: opts.comsAwaitTimeoutMs,
      }),
    },
  });
}
