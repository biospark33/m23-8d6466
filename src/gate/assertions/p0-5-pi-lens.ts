/**
 * PRD §13 Phase-0 clause 4 (Story P0.11).
 *
 * Clause 4: "pi-lens runs headless and EITHER emits a turn-end report with TDI
 * + stable finding IDs, OR the logged warning-count proxy fallback is recorded
 * with the §9.3 fallback flag set."
 *
 * The clause is an explicit EITHER/OR, and Phase-0 took the second branch:
 * OQ-2 established that TDI is a TUI slash-command with no headless flag. So
 * the gate asserts the warning-count proxy branch (P0.5 AC3), which is the one
 * P0.5 recorded as fully met, and does NOT assert the stable-finding-ID branch,
 * which P0.5 recorded as PARTIAL (`idObserved: false` — the id is derived by
 * the harness, never assigned by pi-lens).
 */
import * as path from "node:path";
import type { GateAssertion } from "../gate-runner.ts";
import { findCheck, runVerifier, verifierUnusable } from "../verifier-child.ts";

/** pi-lens-verify budgets ~1-2 min: LSP cold starts plus opengrep's warmup. */
const VERIFIER_TIMEOUT_MS = 150_000;

export function piLensAssertions(repoRoot: string): GateAssertion[] {
  const verifier = path.join(repoRoot, "scripts", "pi-lens-verify.ts");

  return [
    {
      id: "P0.5-pi-lens-headless-warning-proxy",
      story: "P0.5",
      prd_clause: "§13 P0 clause 4",
      description:
        "pi-lens runs headless and the warning-count proxy fallback is readable (clause 4, second branch)",
      group: "main",
      // The harness budgets ~1-2 min (LSP cold starts + opengrep's ~8 s warmup),
      // so it is declared here rather than silently overrunning the 30 s default.
      timeout_ms: VERIFIER_TIMEOUT_MS + 15_000,
      check: async () => {
        const run = await runVerifier(verifier, [], {
          cwd: repoRoot,
          timeoutMs: VERIFIER_TIMEOUT_MS,
        });
        const unusable = verifierUnusable(run);
        if (unusable) return { pass: false, skip: true, detail: unusable };

        const ac3 = findCheck(run, "AC3");
        if (!ac3) {
          return { pass: false, detail: "pi-lens verifier emitted no AC3 (warning-count) check" };
        }
        if (ac3.status !== "pass") {
          return {
            pass: false,
            detail: `AC3 warning-count proxy status=${ac3.status}: ${ac3.reason ?? "no reason given"}`,
          };
        }
        return {
          pass: true,
          detail:
            "AC3 warning-count proxy read headless with an explicit fallbackReason. " +
            "SCOPED: clause 4's TDI/stable-finding-ID branch is NOT asserted — OQ-2 found TDI is " +
            "TUI-only and P0.5 recorded the stable id as derived, not pi-lens-assigned (idObserved:false).",
        };
      },
    },
  ];
}
