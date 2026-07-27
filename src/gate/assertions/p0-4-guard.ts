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

/**
 * Strips comment lines so a DISABLED declaration cannot satisfy a "declares X"
 * check.
 *
 * This closes a false green that both halves of the audit had: `# budgetCapUsd:
 * 0.5` in the manifest satisfied `/budgetCapUsd\s*:/`, and a stale `// overflow:
 * 3` comment in index.ts was matched by `String.match` BEFORE the real mapping,
 * so a live `overflow: 0` (cap breach exits zero — the exact runaway this clause
 * guards) was reported green.
 */
function stripComments(text: string, marker: "#" | "//"): string {
  return text
    .split("\n")
    .map((l) => (l.trimStart().startsWith(marker) ? "" : l))
    .join("\n");
}

/**
 * A declaration must carry an actual positive number. `budgetCapUsd:` with no
 * value, or `: null`, is an absent cap wearing the key's name.
 */
function declaresPositive(text: string, key: string): boolean {
  // Anchored at the line start so `defaultBudgetCapUsd` cannot stand in for
  // `budgetCapUsd` — the key the launcher actually reads.
  const m = text.match(new RegExp(`^[ \\t]*${key}\\s*:\\s*([0-9]*\\.?[0-9]+)`, "m"));
  return m !== null && Number(m[1]) > 0;
}

export interface LauncherGuardAudit {
  failures: string[];
  overflowExit?: string;
}

/**
 * Audits the launcher's cap declarations and its overflow exit mapping.
 *
 * Exported so clause 3's structural contract is testable rather than buried in
 * a check (same shape as p0-2's `auditOqDecisions`).
 *
 * EVERY overflow mapping must be non-zero, not merely the first one found: the
 * previous first-match-wins read let a second, real mapping of 0 hide behind an
 * earlier benign one.
 */
export function auditLauncherGuards(manifestText: string, indexText: string): LauncherGuardAudit {
  const manifest = stripComments(manifestText, "#");
  const index = stripComments(indexText, "//");

  const failures: string[] = [];
  if (!declaresPositive(manifest, "budgetCapUsd")) {
    failures.push("manifest declares no budgetCapUsd");
  }
  if (!declaresPositive(manifest, "wallClockCapMs")) {
    failures.push("manifest declares no wallClockCapMs");
  }

  // The overflow exit status must map to a NON-ZERO code, else a cap
  // breach would look like success to any caller.
  const overflowMatches = [...index.matchAll(/\boverflow\s*:\s*(\d+)/g)].map((m) => m[1] as string);
  if (overflowMatches.length === 0) {
    failures.push("no overflow exit-code mapping found in cli-anything/src/index.ts");
  }
  const zeroMapping = overflowMatches.find((code) => Number(code) === 0);
  if (zeroMapping !== undefined) {
    failures.push(`overflow maps to exit ${zeroMapping} (must be non-zero)`);
  }

  return { failures, overflowExit: overflowMatches[0] };
}

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

        const { failures, overflowExit } = auditLauncherGuards(
          fs.readFileSync(manifest, "utf8"),
          fs.readFileSync(indexTs, "utf8"),
        );

        const caveat =
          "STRUCTURAL only — proves the cap path exists and exits non-zero; " +
          "no live loopy-prompt run has ever been executed in Phase-0 (P0.4 was killed)";

        return failures.length > 0
          ? { pass: false, detail: `${failures.join("; ")} — ${caveat}` }
          : {
              pass: true,
              detail: `budgetCapUsd + wallClockCapMs declared; overflow -> exit ${overflowExit}. ${caveat}`,
            };
      },
    },
  ];
}
