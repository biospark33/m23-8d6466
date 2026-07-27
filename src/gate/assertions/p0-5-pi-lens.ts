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
import type { GateAssertion, GateCheckOutcome } from "../gate-runner.ts";
import { runVerifier, type VerifierRun } from "../verifier-child.ts";
import { checkRequiredAcs, isOutcome } from "./lib/verdict.ts";

/** pi-lens-verify budgets ~1-2 min: LSP cold starts plus opengrep's warmup. */
const VERIFIER_TIMEOUT_MS = 150_000;

const SCOPE =
  "SCOPED: clause 4's TDI/stable-finding-ID branch is NOT asserted — OQ-2 found TDI is " +
  "TUI-only and P0.5 recorded the stable id as derived, not pi-lens-assigned (idObserved:false).";

/**
 * Turns a pi-lens verifier run into the clause-4 verdict.
 *
 * Exported so the boundary is testable without spawning the harness (same shape
 * as p0-2's `auditOqDecisions`).
 *
 * The evidence key is asserted, not assumed. The previous version returned a
 * green whose detail read "warning-count proxy read headless with an explicit
 * fallbackReason" while inspecting only `status === "pass"` — it never looked at
 * `warningCount` or `fallbackReason` at all. That is the p0-6 pattern (assert
 * the specific evidence key, not merely a green check) missing here: a verifier
 * whose AC3 shape drifted so that `warningCount` vanished would still have been
 * certified as satisfying clause 4, with the gate asserting in prose that it had
 * seen a number it never read.
 */
export function evaluatePiLensVerdict(run: VerifierRun): GateCheckOutcome {
  const result = checkRequiredAcs(run, ["AC3"]);
  if (isOutcome(result)) return result;
  const { failures, checks } = result;
  const ac3 = checks.AC3;

  // Clause 4's second branch is about a warning COUNT being readable. A green
  // AC3 carrying no numeric count proves nothing the clause asks for.
  const count = ac3?.evidence?.warningCount;
  if (failures.length === 0 && (typeof count !== "number" || !Number.isFinite(count))) {
    failures.push(`AC3 reported pass but evidence.warningCount=${String(count)} is not a readable number`);
  }

  if (failures.length > 0) return { pass: false, detail: failures.join("; ") };

  // Reported, never required: the PRIMARY artifact path (actionable-warnings.jsonl)
  // legitimately carries no fallbackReason, so demanding one would false-red a
  // healthy run. Stating what was actually observed keeps the detail honest.
  const fallbackReason = ac3?.evidence?.fallbackReason;
  const provenance =
    typeof fallbackReason === "string" && fallbackReason.length > 0
      ? `via the §9.3 fallback path (fallbackReason: ${fallbackReason.slice(0, 200)})`
      : "from the primary actionable-warnings artifact (no fallback was needed)";

  return {
    pass: true,
    detail: `AC3 warning-count proxy read headless: warningCount=${count} ${provenance}. ${SCOPE}`,
  };
}

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
        return evaluatePiLensVerdict(run);
      },
    },
  ];
}
