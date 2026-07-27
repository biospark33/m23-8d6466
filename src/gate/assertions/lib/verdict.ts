/**
 * Shared shell for the verifier-backed clause assertions (p0-5, p0-6, ...).
 *
 * Both modules independently answer the same three questions before they
 * ever look at clause-specific evidence: is the run usable at all, are the
 * required ACs present in the verdict, and is each one individually green?
 * That triplet is exactly where p0-6 hardened itself (asserting specific
 * evidence keys instead of a bare `status === "pass"`) while p0-5 initially
 * had not — the two modules are structurally identical peers, so the next
 * hardening fix landing in only one of them is the mechanism by which they
 * drift apart. This hoists the shared part; the evidence-specific guards
 * (p0-5's numeric warningCount vs p0-6's two boolean flags) stay in each
 * module, since those genuinely differ and should not be flattened.
 */
import type { GateCheckOutcome } from "../../gate-runner.ts";
import { findCheck, verifierUnusable, type VerifierCheck, type VerifierRun } from "../../verifier-child.ts";

export interface RequiredAcsResult {
  /** One entry per AC asked for; undefined when that check was absent. */
  checks: Record<string, VerifierCheck | undefined>;
  /** "no <AC> check in verdict" / "<AC> status=<status>: <reason>" per AC. Empty when every AC is present and green. */
  failures: string[];
}

/** True when `checkRequiredAcs` already produced a final outcome (run unusable). */
export function isOutcome(x: RequiredAcsResult | GateCheckOutcome): x is GateCheckOutcome {
  return "pass" in x;
}

/**
 * Confirms the run is usable, then checks that each requested AC is present
 * and its own status is "pass". Callers layer clause-specific evidence guards
 * on top of `failures`/`checks` before deciding the final verdict.
 */
export function checkRequiredAcs(run: VerifierRun, acs: readonly string[]): RequiredAcsResult | GateCheckOutcome {
  const unusable = verifierUnusable(run);
  if (unusable) return { pass: false, skip: true, detail: unusable };

  const failures: string[] = [];
  const checks: Record<string, VerifierCheck | undefined> = {};
  for (const ac of acs) {
    const found = findCheck(run, ac);
    checks[ac] = found;
    if (!found) {
      failures.push(`no ${ac} check in verdict`);
    } else if (found.status !== "pass") {
      failures.push(`${ac} status=${found.status}: ${found.reason ?? "no reason given"}`);
    }
  }
  return { checks, failures };
}
