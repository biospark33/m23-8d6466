/**
 * PRD §13 Phase-0 clause 1 (Story P0.11).
 *
 * Clause 1 as written: "`pi-team-launch.sh \"refactor X\" ./ctx` returns a
 * single merged JSON object on stdout."
 *
 * SPEC-VS-IMPL: `pi-team-launch.sh` does not exist and never did — every
 * reference is PRD/planning prose. P0.3 shipped the capability as the
 * `cli-anything` team harness instead. The gate asserts the CAPABILITY the
 * clause describes (a single merged JSON object from a mixed-model team run)
 * against the artifact that actually implements it, and records the naming
 * discrepancy rather than silently reinterpreting the clause.
 *
 * Asserted against P0.3's frozen run of record: the live path costs real money
 * (~$0.5 cap, ~3 min) and a gate must be safe to re-run. The evidence is a
 * recording of a real live run, labelled as such in the detail string.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import type { GateAssertion } from "../gate-runner.ts";
import { meetsMinCount } from "./p0-2-coms.ts";

interface LiveRun {
  // exit_code lives INSIDE `assertions`, not at the top level.
  assertions?: {
    exit_code?: number;
    ac1_merged_json_partial_false?: boolean;
    ac1_distinct_models_gte2?: boolean;
    ac2_coms_messages_gte2?: boolean;
  };
  merged_output?: {
    exitStatus?: string;
    partial?: boolean;
    comsLog?: unknown[];
    result?: { models?: unknown[] };
  };
}

export function mixedModelAssertions(repoRoot: string): GateAssertion[] {
  const evidence = path.join(
    repoRoot,
    "_bmad-output",
    "sprint-artifacts",
    "_research",
    "p0-3-live-run-2026-07-20.json",
  );

  return [
    {
      id: "P0.3-merged-json-mixed-model",
      story: "P0.3",
      prd_clause: "§13 P0 clause 1",
      description:
        "A mixed-model team run emits ONE merged JSON object with partial:false and >=2 distinct models",
      group: "main",
      check: async () => {
        if (!fs.existsSync(evidence)) {
          return { pass: false, detail: `P0.3 run of record missing: ${evidence}` };
        }
        let run: LiveRun;
        try {
          run = JSON.parse(fs.readFileSync(evidence, "utf8")) as LiveRun;
        } catch (err) {
          return {
            pass: false,
            detail: `P0.3 run of record is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
          };
        }

        const merged = run.merged_output;
        const models = merged?.result?.models ?? [];
        // JSON.stringify rather than String(): the current evidence file holds
        // model-id strings, but String() on objects collapses every element to
        // "[object Object]" (size always 1), so this is schema-change-proof.
        const distinctModels = new Set(models.map((m) => JSON.stringify(m))).size;
        const comsCount = merged?.comsLog?.length ?? 0;

        const failures: string[] = [];
        if (run.assertions?.exit_code !== 0) {
          failures.push(`assertions.exit_code=${String(run.assertions?.exit_code)} (expected 0)`);
        }
        if (!merged) failures.push("no merged_output object");
        if (merged?.partial !== false) failures.push(`partial=${String(merged?.partial)} (expected false)`);
        if (merged?.exitStatus !== "success") {
          failures.push(`exitStatus=${String(merged?.exitStatus)} (expected "success")`);
        }
        // Routed through the shared NaN-safe threshold helper so no assertion
        // module carries a bare `< min` comparison for a future caller to copy.
        if (!meetsMinCount(distinctModels, 2)) {
          failures.push(`distinct models=${distinctModels} (expected >=2)`);
        }

        const provenance =
          `evidence-of-record ${path.basename(evidence)} (recorded live run, not re-executed by this gate; run used QDS_TEAM_RUNNER=local subprocess-RPC, not the warren-server path)`;

        return failures.length > 0
          ? { pass: false, detail: `${failures.join("; ")} — ${provenance}` }
          : {
              pass: true,
              detail: `single merged JSON, partial=false, exitStatus=success, ${distinctModels} distinct models, ${comsCount} coms entries — ${provenance}. NOTE: clause names pi-team-launch.sh, which does not exist; capability shipped as cli-anything.`,
            };
      },
    },
  ];
}
