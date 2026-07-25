/**
 * PRD §13 Phase-0 clause 3 (Story P0.11).
 *
 * Clause 3: "A deliberately loopy prompt hits a hard cap (budget/turn/tilldone/
 * `coms_await` timeout) and exits non-zero — credits are not exhausted."
 *
 * Story P0.4 was killed, but NOT because the capability was dropped: the
 * sprint record says "loopy-kill absorbed into launcher guards". So this clause
 * is deliberately NOT voided — voiding it would silently retire a budget-runaway
 * safety property (risk R10).
 *
 * What is honestly assertable without spending money: that the launcher's
 * hard-cap path EXISTS and is wired to a non-zero exit. This is a STRUCTURAL
 * assertion — it proves the guard is present and correctly wired, not that a
 * live loopy prompt was killed. The detail string says exactly that, and the
 * evidence report records the residual gap.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import type { GateAssertion } from "../gate-runner.ts";

export function guardAssertions(repoRoot: string): GateAssertion[] {
  const manifest = path.join(repoRoot, "cli-anything", "manifests", "research-trio.yaml");
  const indexTs = path.join(repoRoot, "cli-anything", "src", "index.ts");

  return [
    {
      id: "P0.4-hard-cap-wired-nonzero-exit",
      story: "P0.4 (killed; absorbed into launcher guards)",
      prd_clause: "§13 P0 clause 3",
      description: "Launcher declares budget/wall-clock caps and maps overflow to a non-zero exit",
      group: "main",
      check: async () => {
        const missing = [manifest, indexTs].filter((f) => !fs.existsSync(f));
        if (missing.length > 0) {
          return { pass: false, detail: `launcher files missing: ${missing.join(", ")}` };
        }

        const manifestText = fs.readFileSync(manifest, "utf8");
        const indexText = fs.readFileSync(indexTs, "utf8");

        const failures: string[] = [];
        if (!/budgetCapUsd\s*:/.test(manifestText)) failures.push("manifest declares no budgetCapUsd");
        if (!/wallClockCapMs\s*:/.test(manifestText)) failures.push("manifest declares no wallClockCapMs");

        // The overflow exit status must map to a NON-ZERO code, else a cap
        // breach would look like success to any caller.
        const overflowMatch = indexText.match(/overflow\s*:\s*(\d+)/);
        if (!overflowMatch) {
          failures.push("no overflow exit-code mapping found in cli-anything/src/index.ts");
        } else if (Number(overflowMatch[1]) === 0) {
          failures.push(`overflow maps to exit ${overflowMatch[1]} (must be non-zero)`);
        }

        const caveat =
          "STRUCTURAL only — proves the cap path exists and exits non-zero; " +
          "no live loopy-prompt run has ever been executed in Phase-0 (P0.4 was killed)";

        return failures.length > 0
          ? { pass: false, detail: `${failures.join("; ")} — ${caveat}` }
          : {
              pass: true,
              detail: `budgetCapUsd + wallClockCapMs declared; overflow -> exit ${overflowMatch?.[1]}. ${caveat}`,
            };
      },
    },
  ];
}
