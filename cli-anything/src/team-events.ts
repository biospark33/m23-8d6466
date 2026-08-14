/**
 * P0.3 team-path wire layer: lead-run spawn construction, NDJSON event
 * parsing, and atomic worker-partial writes. Extracted verbatim from runner.ts
 * (#62) — pure functions plus one fs helper, no process/timer state.
 */

import { renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { CostEvent, TeamManifest } from "./types.ts";

/** Split a `provider/model` role string at the FIRST slash (CC-2 amended). */
export function splitRoleModel(roleModel: string): {
  provider: string;
  model: string;
} {
  const idx = roleModel.indexOf("/");
  // Defensive: zod validation requires a "/", but programmatic callers can
  // bypass it — without this guard, slice(0, -1) mangles both halves.
  if (idx === -1) {
    return { provider: "", model: roleModel };
  }
  return { provider: roleModel.slice(0, idx), model: roleModel.slice(idx + 1) };
}

/**
 * Build the real Warren 0.10.0 invocation for the team lead (CC-2 amended
 * 2026-07-20): `warren run pi <project> -p "<prompt>" --provider --model`.
 * Worker role-models ride in QDS_AGENT_TEAM_CONFIG_JSON env (agent-team
 * extension config), NOT in Warren CLI flags.
 *
 * Runtime provider selection (mirrors warren's own WARREN_RUNTIME pattern):
 * `QDS_TEAM_RUNNER=local` swaps the warren-server dispatch for the local
 * subprocess-RPC lead driver (`scripts/team-lead-driver.ts`, OQ-1 zero-infra
 * path) — same event protocol, same merged-output contract, no server.
 */
export function buildTeamSpawn(
  manifest: TeamManifest,
  runner: "warren" | "local" = "warren",
): {
  file: string;
  argv: string[];
} {
  if (runner === "local") {
    return {
      file: "bun",
      argv: [join(import.meta.dir, "..", "scripts", "team-lead-driver.ts")],
    };
  }
  const lead = splitRoleModel(manifest.team.lead.model);
  return {
    file: "warren",
    argv: [
      "run",
      "pi",
      manifest.team.project,
      "-p",
      manifest.team.lead.prompt,
      "--provider",
      lead.provider,
      "--model",
      lead.model,
      "--trigger",
      "cli-anything",
    ],
  };
}

/** One parsed NDJSON event from the lead run's stdout. */
export type TeamEvent =
  | { kind: "cost"; event: CostEvent }
  | { kind: "coms"; raw: unknown }
  | { kind: "worker_output"; agentId: string; output: unknown }
  | { kind: "merged"; result: Record<string, unknown> }
  | { kind: "coms_init_error"; reason: string };

/**
 * Non-negative finite count, else 0 (DF2.7). Unlike the pre-existing
 * `typeof === "number"` defaulting on inputTokens/outputTokens, this also
 * floors NaN, Infinity and negatives — a cumulative accumulator must never
 * be fed a value that can move it backwards or poison it with NaN.
 */
function countOr0(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : 0;
}

/**
 * `unpricedTurns` specifically (DF2.7). Flooring to 0 is the SAFE direction
 * for a usage counter (it under-reports) and the UNSAFE direction for this
 * one, because 0 asserts "this cost record is complete". A field that is
 * present but unparseable is evidence the producer had something to say and
 * we could not read it, so it counts as at least one unpriced turn — never as
 * a clean bill of health (INV-COST-5, fail closed).
 */
function unpricedOr0(v: unknown): number {
  if (v === undefined || v === null) return 0;
  return typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : 1;
}

/** Parse one stdout line into a team event; null for non-event lines. */
export function parseTeamEventLine(line: string): TeamEvent | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith("{")) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (typeof raw !== "object" || raw === null) return null;
  const o = raw as Record<string, unknown>;
  switch (o.type) {
    case "cost": {
      const costUsd = o.costUsd;
      if (typeof costUsd !== "number" || !Number.isFinite(costUsd) || costUsd < 0) {
        return null;
      }
      return {
        kind: "cost",
        event: {
          agentId: typeof o.agentId === "string" ? o.agentId : "unknown",
          model: typeof o.model === "string" ? o.model : "unknown",
          // DF2.7: these two moved from a bare `typeof === "number"` check to
          // the same finite/non-negative floor as the new fields. A NaN or
          // negative token count is malformed by construction — no legitimate
          // producer emits one — and letting it through put NaN straight onto
          // a CostEvent that DF2.8's ledger sums.
          inputTokens: countOr0(o.inputTokens),
          outputTokens: countOr0(o.outputTokens),
          // Additive fields. A producer that predates the widening —
          // the warren branch at runner.ts:554, any external emitter — omits
          // them entirely and still parses to a valid TeamEvent (AC3).
          cacheReadTokens: countOr0(o.cacheReadTokens),
          cacheWriteTokens: countOr0(o.cacheWriteTokens),
          costUsd,
          turnCount: countOr0(o.turnCount),
          unpricedTurns: unpricedOr0(o.unpricedTurns),
          durationMs: countOr0(o.durationMs),
          timestamp: typeof o.timestamp === "string" ? o.timestamp : "",
        },
      };
    }
    case "coms":
      return { kind: "coms", raw: o };
    case "worker_output": {
      if (typeof o.agentId !== "string") return null;
      return { kind: "worker_output", agentId: o.agentId, output: o.output };
    }
    case "merged": {
      const result = o.result;
      // A malformed `result` used to collapse to `{}`, which the harness reads
      // as a real merged payload — a garbled lead run then reported success
      // with an empty result. Reject it like every other malformed event here
      // (null); mergedResult stays null and the run classifies as lead_failure.
      if (typeof result !== "object" || result === null || Array.isArray(result)) {
        return null;
      }
      return { kind: "merged", result: result as Record<string, unknown> };
    }
    case "coms_init_error":
      return {
        kind: "coms_init_error",
        reason: typeof o.reason === "string" ? o.reason : "unknown",
      };
    default:
      return null;
  }
}

/** Artifact names are single path components: word chars, dot, dash. */
const SAFE_ARTIFACT_NAME_RE = /^[\w.-]+$/;

/** Atomic write: tmpfile + rename (P0.3-S-M4, mirrors writeRegistryAtomic). */
export function writeArtifactAtomic(
  dir: string,
  name: string,
  data: unknown,
): void {
  // `name` reaches the only in-tree caller pre-whitelisted against the declared
  // worker set, but this is an exported utility (#62) — guard here so a future
  // caller cannot escape `dir` with separators or `..`.
  if (!SAFE_ARTIFACT_NAME_RE.test(name)) {
    throw new Error(`writeArtifactAtomic: unsafe artifact name "${name}"`);
  }
  const tmp = join(dir, `.${name}.tmp-${process.pid}`);
  try {
    writeFileSync(tmp, JSON.stringify(data, null, 2));
    renameSync(tmp, join(dir, `${name}.json`));
  } catch (err) {
    // Best-effort: a failed write/rename must not leave `.{name}.tmp-{pid}`
    // behind. Swallow the unlink error so it cannot mask the real one.
    try {
      unlinkSync(tmp);
    } catch {}
    throw err;
  }
}
