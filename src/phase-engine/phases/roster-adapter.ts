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
 * DF1.9 fields (lean, extensions) are left undefined — those are manifest-
 * level concerns, not roster-level.
 */
export function rosterRoleToTeamRole(
  role: ResolvedRole,
  opts: { agentId: string; prompt: string },
): TeamRole {
  return {
    agentId: opts.agentId,
    // Join: never split here. splitRoleModel decomposes.
    model: `${role.provider}/${role.model}`,
    prompt: opts.prompt,
    // DF1.9 fields — omitted here, added by manifest construction if needed
    lean: undefined,
    extensions: undefined,
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

  const workers = opts.workerRoleNames.map((name) => {
    const role = roleByName.get(name);
    if (!role) {
      throw new Error(`Worker role "${name}" not found in roster`);
    }
    return rosterRoleToTeamRole(role, {
      agentId: name,
      prompt: opts.prompts[name] ?? "",
    });
  });

  const lead = rosterRoleToTeamRole(leadRole, {
    agentId: opts.leadRoleName,
    prompt: opts.prompts[opts.leadRoleName] ?? "",
  });

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
