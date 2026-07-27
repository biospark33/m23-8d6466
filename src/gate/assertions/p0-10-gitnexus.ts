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
import { z } from "zod";
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

/** `unknown`, not `any` (#F028): a shape change must fail a parse, not vanish. */
function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

/**
 * The gitnexus response shapes the gate actually reads, validated rather than
 * trusted (#F028). `passthrough` keeps them tolerant of the many fields the gate
 * ignores; `error` and `impactedCount` stay `unknown` because they are only
 * rendered, never compared.
 */
const ContextResponseSchema = z
  .object({
    status: z.string().optional(),
    error: z.unknown(),
    symbol: z.object({ filePath: z.string().min(1) }).passthrough().optional(),
  })
  .passthrough();

const ImpactResponseSchema = z
  .object({
    error: z.unknown(),
    target: z.object({ name: z.string().min(1) }).passthrough().optional(),
    impactedCount: z.unknown(),
  })
  .passthrough();

/** Audits `gitnexus context` output. Returns the resolved filePath on success. */
export function auditContextJson(raw: unknown): { pass: boolean; detail: string; filePath?: string } {
  const parsed = ContextResponseSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      pass: false,
      detail: `gitnexus context returned an unrecognised shape: ${parsed.error.issues
        .map((i) => `${i.path.join(".") || "<root>"}: ${i.message}`)
        .join("; ")}`,
    };
  }
  const json = parsed.data;
  // A soft failure is reported as an error object with exit 0.
  if (json.error) return { pass: false, detail: `gitnexus context: ${String(json.error)}` };
  if (json.status !== "found" || !json.symbol?.filePath) {
    return {
      pass: false,
      detail: `gitnexus context returned status=${String(json.status)} with no symbol filePath`,
    };
  }
  return { pass: true, detail: "", filePath: json.symbol.filePath };
}

/** Audits `gitnexus impact` output. Returns the impacted count for the detail line. */
export function auditImpactJson(raw: unknown): {
  pass: boolean;
  detail: string;
  impactedCount?: unknown;
} {
  const parsed = ImpactResponseSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      pass: false,
      detail: `gitnexus impact returned an unrecognised shape: ${parsed.error.issues
        .map((i) => `${i.path.join(".") || "<root>"}: ${i.message}`)
        .join("; ")}`,
    };
  }
  const json = parsed.data;
  if (json.error) return { pass: false, detail: `gitnexus impact: ${String(json.error)}` };
  if (!json.target?.name) {
    return { pass: false, detail: "gitnexus impact returned no target — graph data absent" };
  }
  return { pass: true, detail: "", impactedCount: json.impactedCount };
}

/**
 * Staleness is NOT part of clause 7b (which requires a non-error state and real
 * data), but it is material to Phase-1 correctness, so it is surfaced in the
 * detail rather than silently ignored.
 *
 * A failed `gitnexus status` must NOT read as "fresh": an empty stdout misses
 * the regex and would silently suppress the staleness signal, the opposite of
 * surfacing it.
 */
export function stalenessNote(status: {
  status: number | null;
  stdout: string;
  stderr: string;
}): string {
  if (status.status !== 0) {
    return ` WARNING: staleness UNKNOWN — \`gitnexus status\` exited ${String(status.status)}: ${status.stderr}`;
  }
  // Exit 0 with NOTHING on stdout is not a fresh index, it is an unanswered
  // question: no output misses every pattern and would silently read as fresh.
  if (status.stdout.trim().length === 0) {
    return " WARNING: staleness UNKNOWN — `gitnexus status` exited 0 but printed nothing.";
  }
  // Word-bounded and negation-aware: a bare /stale/i also matches "stale: false"
  // and "not stale", so a FRESH index would have been reported STALE — and a
  // warning that fires on every healthy run is a warning nobody reads.
  const out = status.stdout.toLowerCase();
  const negated = /\bstale\b\s*[:=]\s*(?:false|no|0)\b/.test(out) || /\bnot stale\b/.test(out);
  return !negated && /\bstale\b/.test(out)
    ? " WARNING: index reports STALE — re-run `gitnexus analyze` before Phase-1 stories."
    : "";
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
        if (ctxJson === undefined) {
          return { pass: false, detail: "gitnexus context emitted no parseable JSON" };
        }
        const ctxAudit = auditContextJson(ctxJson);
        if (!ctxAudit.pass) return { pass: false, detail: ctxAudit.detail };

        const imp = await gitnexus(["impact", PROBE_SYMBOL, "-r", repoRoot, "--direction", "upstream"], repoRoot);
        if (imp.status !== 0) {
          return { pass: false, detail: `gitnexus impact exited ${String(imp.status)}: ${imp.stderr}` };
        }
        const impJson = parseJson(imp.stdout);
        if (impJson === undefined) {
          return { pass: false, detail: "gitnexus impact emitted no parseable JSON" };
        }
        const impAudit = auditImpactJson(impJson);
        if (!impAudit.pass) return { pass: false, detail: impAudit.detail };

        const stale = stalenessNote(await gitnexus(["status"], repoRoot));

        return {
          pass: true,
          detail: `context resolved ${PROBE_SYMBOL} -> ${String(ctxAudit.filePath)}; impact returned target with impactedCount=${String(
            impAudit.impactedCount,
          )}.${stale}`,
        };
      },
    },
  ];
}
