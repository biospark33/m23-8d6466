/**
 * Preflight + PRD §13 Phase-0 clause 5 (Story P0.11).
 *
 * Clause 5 (Archon per-node `env` patch) is VOID: its story P0.1 was killed by
 * the Warren decision ("flat agents, no Archon DAG"), so there is no Archon DAG
 * in the v4 architecture for the clause to be true of. It is recorded rather
 * than deleted so a reader can see it was dropped deliberately.
 *
 * The preflight group is the fail-fast barrier required by AC3: if the basic
 * toolchain is absent, the gate reports exactly what is missing instead of
 * waiting out a per-assertion timeout against every downstream service.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import type { GateAssertion } from "../gate-runner.ts";

/** Binaries every downstream assertion depends on. */
const REQUIRED_BINARIES = ["bun", "node", "git"] as const;

/**
 * Env vars the gate reads. None is hard-required (each has a default), so an
 * unset var is reported as context on failure rather than failing preflight —
 * but the list makes AC3's "report which env vars are missing" answerable.
 */
const OPTIONAL_ENV = [
  "HINDSIGHT_BASE_URL",
  "HINDSIGHT_BEARER_TOKEN",
  "SWARMCLAW_BASE_URL",
  "PI_LENS_ROOT",
  "QDS_REPO_SLUG",
] as const;

/**
 * Resolves a binary against PATH by inspecting the filesystem directly.
 *
 * Deliberately not a subprocess: a synchronous spawn would block the gate's
 * event loop (defeating its own timeouts), and shelling out to `command -v`
 * would put a `shell: true` invocation on the hot path for no benefit.
 *
 * `isFile` is load-bearing: `X_OK` is set on every directory, so a directory
 * named `git` sitting on PATH would otherwise satisfy "git is installed" — a
 * preflight that greens on something it cannot execute.
 */
export function onPath(bin: string): boolean {
  const dirs = (process.env.PATH ?? "").split(path.delimiter).filter((d) => d.length > 0);
  return dirs.some((dir) => {
    const candidate = path.join(dir, bin);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return fs.statSync(candidate).isFile();
    } catch {
      return false;
    }
  });
}

/**
 * The preflight verdict itself, separated from the filesystem probing so the
 * barrier's pass/fail boundary is unit-testable (see p0-2's `auditOqDecisions`
 * for the same shape).
 *
 * The unset-env list is REPORTING ONLY — every var has a default, so it must
 * never move the verdict. It is threaded through both branches so AC3's "report
 * which env vars are missing" is answerable from either outcome.
 */
export function preflightVerdict(
  missingBins: readonly string[],
  missingPaths: readonly string[],
  unsetEnv: readonly string[],
): { pass: boolean; detail: string } {
  const envNote = `unset env (defaults apply): ${unsetEnv.length > 0 ? unsetEnv.join(", ") : "none"}`;
  if (missingBins.length > 0 || missingPaths.length > 0) {
    const parts = [
      missingBins.length > 0 ? `missing binaries: ${missingBins.join(", ")}` : "",
      missingPaths.length > 0 ? `missing repo paths: ${missingPaths.join(", ")}` : "",
      envNote,
    ].filter(Boolean);
    return { pass: false, detail: parts.join("; ") };
  }
  return { pass: true, detail: `toolchain present; ${envNote}` };
}

export function envAssertions(repoRoot: string): GateAssertion[] {
  return [
    {
      id: "preflight-toolchain",
      story: "P0.11",
      prd_clause: "§13 P0 preflight",
      description: "Required toolchain is present and the gate is running in the repo root",
      group: "preflight",
      check: async () => {
        const missingBins = REQUIRED_BINARIES.filter((b) => !onPath(b));
        const missingPaths = ["package.json", "scripts", "src"].filter(
          (p) => !fs.existsSync(path.join(repoRoot, p)),
        );
        const unsetEnv = OPTIONAL_ENV.filter((v) => !process.env[v]);
        return preflightVerdict(missingBins, missingPaths, unsetEnv);
      },
    },
    {
      id: "P0.1-archon-env-patch",
      story: "P0.1 (killed)",
      prd_clause: "§13 P0 clause 5",
      description: "Archon bash node per-node env patch + no-regression inherit",
      group: "main",
      void_reason:
        "P0.1 killed by Warren decision (flat agents, no Archon DAG). There is no Archon " +
        "DAG in the v4 architecture, so clause 5 has no subject and is dropped, not failed.",
      check: async () => ({ pass: false, detail: "void" }),
    },
  ];
}
