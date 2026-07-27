/**
 * PRD §13 Phase-0 clause 4b (Story P0.11).
 *
 * Clause 4b: "An active LSP is proven for the target language: `lsp_diagnostics`
 * surfaces a seeded type error and `lsp_navigation` resolves a definition."
 *
 * SCOPING IS LOAD-BEARING HERE. P0.11's own story text warns that P0.6's 7/7
 * probe pass is NOT full story acceptance: AC1, AC3, AC3a and AC4 are recorded
 * story-level PARTIAL. The only unconditionally safe claim, verbatim from the
 * story, is "warm diagnostics reflect uncommitted edits within the latency
 * budget". So this gate asserts:
 *
 *   - AC1 (diagnostics surface a seeded error on an uncommitted edit), and
 *   - AC2 (navigation resolves a cross-file definition)
 *
 * and explicitly does NOT assert first-query freshness (9/20 warm samples
 * returned a stale line), the AC3 artifact half (artifactSignalObserved:false),
 * pi-lens's internal init timeout (AC3a, unreachable), or literal sequential
 * per-file RPCs (AC4).
 *
 * The harness is invoked rather than re-implemented, per the story's explicit
 * instruction.
 */
import * as path from "node:path";
import type { GateAssertion, GateCheckOutcome } from "../gate-runner.ts";
import { runVerifier, type VerifierRun } from "../verifier-child.ts";
import { checkRequiredAcs, isOutcome } from "./lib/verdict.ts";

/** The harness itself budgets ~55 s (cold LSP + 20 warm samples + a 15 s probe). */
const VERIFIER_TIMEOUT_MS = 180_000;

const SCOPE =
  "SCOPED to warm diagnostics + navigation. NOT asserted (P0.6 story-level PARTIAL): " +
  "single-query freshness, the AC3 artifact half, pi-lens-internal init timeout (AC3a), " +
  "literal sequential per-file RPCs (AC4).";

/**
 * Turns an lsp-verify run into the clause-4b verdict.
 *
 * Exported so the boundary is testable without spawning the harness (same shape
 * as p0-2's `auditOqDecisions`).
 */
export function evaluateLspVerdict(run: VerifierRun): GateCheckOutcome {
  const result = checkRequiredAcs(run, ["AC1", "AC2"]);
  if (isOutcome(result)) return result;
  const { failures, checks } = result;
  const ac1 = checks.AC1;

  // The clause is about diagnostics reflecting a real uncommitted edit —
  // assert that specific evidence key, not merely a green check.
  const editUncommitted = ac1?.evidence?.editUncommitted;
  if (ac1?.status === "pass" && editUncommitted !== true) {
    failures.push(`AC1 passed but editUncommitted=${String(editUncommitted)} (expected true)`);
  }
  const warmP95Met = ac1?.evidence?.warmP95Met;
  if (ac1?.status === "pass" && warmP95Met !== true) {
    failures.push(`AC1 passed but warmP95Met=${String(warmP95Met)} (latency budget not met)`);
  }

  if (failures.length > 0) return { pass: false, detail: `${failures.join("; ")} — ${SCOPE}` };
  return {
    pass: true,
    detail: `warm diagnostics reflect an uncommitted edit within the latency budget (warmP95Ms=${String(
      ac1?.evidence?.warmP95Ms,
    )}/${String(ac1?.evidence?.warmP95BudgetMs)}); cross-file definition resolved. ${SCOPE}`,
  };
}

export function lspAssertions(repoRoot: string): GateAssertion[] {
  const verifier = path.join(repoRoot, "scripts", "lsp-verify.ts");

  return [
    {
      id: "P0.6-lsp-warm-diagnostics-and-navigation",
      story: "P0.6",
      prd_clause: "§13 P0 clause 4b",
      description:
        "Warm lsp_diagnostics reflects an uncommitted seeded error, and lsp_navigation resolves a definition",
      group: "main",
      // Declared so the runner's advertised per-assertion guard stays TRUE for
      // this assertion rather than being silently exceeded by 6x.
      timeout_ms: VERIFIER_TIMEOUT_MS + 15_000,
      check: async () => {
        const run = await runVerifier(verifier, [], {
          cwd: repoRoot,
          timeoutMs: VERIFIER_TIMEOUT_MS,
        });
        return evaluateLspVerdict(run);
      },
    },
  ];
}
