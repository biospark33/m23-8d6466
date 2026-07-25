/**
 * PRD §13 Phase-0 clause 7b (Story P0.11).
 *
 * Clause 7b: "The initial `gitnexus analyze` completes to a non-error state on
 * the target repo and `gitnexus_context`/`gitnexus_impact` return real graph
 * data — required before any Phase-1 story executes."
 *
 * This is a SEQUENCING GATE for Phase 1, so it is asserted live against the
 * standing index rather than against a recorded artifact.
 *
 * The probe symbol is deliberately a real production symbol (`createServer` in
 * src/swarmclaw/index.ts), NOT the fixture symbol P0.10's own test uses:
 * gitnexus's default ignore list filters `fixtures/`, so that symbol is absent
 * from the standing index and would produce a false red.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { GateAssertion } from "../gate-runner.ts";

const execFileAsync = promisify(execFile);

const CLI_TIMEOUT_MS = 20_000;
/** Three sequential CLI calls, each bounded by CLI_TIMEOUT_MS, plus slack. */
const ASSERTION_TIMEOUT_MS = CLI_TIMEOUT_MS * 3 + 10_000;
/** A production symbol that is present in the standing index. */
const PROBE_SYMBOL = "createServer";

/**
 * Async (not `spawnSync`): a synchronous spawn would block the event loop and
 * make the gate runner's per-assertion timeout unable to fire.
 */
async function gitnexus(
  args: string[],
  cwd: string,
): Promise<{ status: number | null; stdout: string; stderr: string }> {
  try {
    const res = await execFileAsync("gitnexus", args, {
      cwd,
      encoding: "utf8",
      timeout: CLI_TIMEOUT_MS,
      maxBuffer: 32 * 1024 * 1024,
    });
    return { status: 0, stdout: res.stdout, stderr: res.stderr.slice(-500) };
  } catch (err) {
    const e = err as { code?: number | string; stdout?: string; stderr?: string; message?: string };
    return {
      status: typeof e.code === "number" ? e.code : null,
      stdout: e.stdout ?? "",
      stderr: (e.stderr ?? e.message ?? "").slice(-500),
    };
  }
}

function parseJson(text: string): any | undefined {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

export function gitnexusAssertions(repoRoot: string): GateAssertion[] {
  return [
    {
      id: "P0.10-gitnexus-graph-queries",
      story: "P0.10",
      prd_clause: "§13 P0 clause 7b",
      description: "gitnexus context and impact return real graph data for a known symbol",
      group: "main",
      timeout_ms: ASSERTION_TIMEOUT_MS,
      check: async () => {
        const ctx = await gitnexus(["context", PROBE_SYMBOL, "-r", repoRoot], repoRoot);
        if (ctx.status !== 0) {
          return {
            pass: false,
            detail: `gitnexus context exited ${String(ctx.status)}: ${ctx.stderr}`,
          };
        }
        const ctxJson = parseJson(ctx.stdout);
        if (!ctxJson) return { pass: false, detail: "gitnexus context emitted no parseable JSON" };
        // A soft failure is reported as an error object with exit 0.
        if (ctxJson.error) {
          return { pass: false, detail: `gitnexus context: ${String(ctxJson.error)}` };
        }
        if (ctxJson.status !== "found" || !ctxJson.symbol?.filePath) {
          return {
            pass: false,
            detail: `gitnexus context returned status=${String(ctxJson.status)} with no symbol filePath`,
          };
        }

        const imp = await gitnexus(["impact", PROBE_SYMBOL, "-r", repoRoot, "--direction", "upstream"], repoRoot);
        if (imp.status !== 0) {
          return { pass: false, detail: `gitnexus impact exited ${String(imp.status)}: ${imp.stderr}` };
        }
        const impJson = parseJson(imp.stdout);
        if (!impJson) return { pass: false, detail: "gitnexus impact emitted no parseable JSON" };
        if (impJson.error) return { pass: false, detail: `gitnexus impact: ${String(impJson.error)}` };
        if (!impJson.target?.name) {
          return { pass: false, detail: "gitnexus impact returned no target — graph data absent" };
        }

        // Staleness is NOT part of clause 7b (which requires a non-error state
        // and real data), but it is material to Phase-1 correctness, so it is
        // surfaced in the detail rather than silently ignored.
        // A failed `gitnexus status` must NOT read as "fresh": an empty stdout
        // misses the regex and would silently suppress the staleness signal,
        // the opposite of surfacing it.
        const status = await gitnexus(["status"], repoRoot);
        const stale =
          status.status !== 0
            ? ` WARNING: staleness UNKNOWN — \`gitnexus status\` exited ${String(status.status)}: ${status.stderr}`
            : /stale/i.test(status.stdout)
              ? " WARNING: index reports STALE — re-run `gitnexus analyze` before Phase-1 stories."
              : "";

        return {
          pass: true,
          detail: `context resolved ${PROBE_SYMBOL} -> ${String(ctxJson.symbol.filePath)}; impact returned target with impactedCount=${String(
            impJson.impactedCount,
          )}.${stale}`,
        };
      },
    },
  ];
}
