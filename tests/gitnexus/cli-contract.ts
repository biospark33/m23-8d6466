/**
 * The gitnexus CLI output contract — single source of truth for BOTH test
 * suites in this directory.
 *
 * Two tiers, deliberately (drift triage layer):
 *
 *  - STRICT schemas (`.strict()` — every known field, no extras) are exercised
 *    ONLY by contract.test.ts, the drift alarm. An upstream payload change —
 *    renamed, dropped, OR ADDED field — fails exactly one suite with a message
 *    naming the drifted fields and the installed-vs-pinned CLI versions.
 *
 *  - LENIENT schemas (minimal invariant set + `.passthrough()`) back the
 *    functional tests in graph-queries.test.ts. They assert only the fields
 *    the behavior under test actually depends on, so an additive upstream
 *    change does not shatter the functional suite.
 *
 * The CLI ships no importable output schema (checked dist/**; only
 * group/cross-impact types exist), so this file is hand-maintained — that is
 * precisely why the strict/lenient split and the version pin exist. Field
 * inventories verified live against 1.6.9 on 2026-08-28 (every tool the suites
 * exercise: query, context found/not-found, impact resolved/ambiguous, cypher,
 * list, detect-changes).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";

const CONTRACT_JSON = JSON.parse(
  readFileSync(join(import.meta.dir, "gitnexus-cli-contract.json"), "utf8"),
) as { expectedCliVersion: string };
/** The CLI version this contract was verified against. Bump via the upgrade
 * ritual in AGENTS.md — never silently. */
export const EXPECTED_CLI_VERSION: string = CONTRACT_JSON.expectedCliVersion;

// ---------------------------------------------------------------------------
// STRICT tier — contract.test.ts only
// ---------------------------------------------------------------------------

const DefinitionStrict = z
  .object({
    id: z.string(),
    name: z.string(),
    filePath: z.string(),
    // Required for SYMBOL definitions; absent on File:-node definitions
    // (verified live 2026-09-01, CLI 1.6.9, reindex at 7806bbe — query
    // "SwarmClaw routes" returns File:scripts/provision-hindsight-banks.ts and
    // File:src/swarmclaw/index.ts with no line span; the 2026-08-28 index did
    // not surface File: nodes here). The superRefine below keeps the alarm
    // armed for a SYMBOL definition losing its span.
    startLine: z.number().optional(),
    endLine: z.number().optional(),
    // Optional in the 1.6.9 payload: present on module-mapped definitions,
    // absent on others (verified live 2026-08-28 — several query definitions
    // omit it). Still type-checked when present; `.strict()` rejects extras.
    module: z.string().optional(),
  })
  .strict()
  .superRefine((def, ctx) => {
    if (!def.id.startsWith("File:") && (def.startLine === undefined || def.endLine === undefined)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `symbol definition ${def.id} lost its startLine/endLine span`,
      });
    }
  });

const ProcessStrict = z
  .object({
    id: z.string(),
    summary: z.string(),
    priority: z.number(),
    symbol_count: z.number(),
    process_type: z.string(),
    step_count: z.number(),
  })
  .strict();

const ProcessSymbolStrict = z
  .object({
    id: z.string(),
    name: z.string(),
    filePath: z.string(),
    startLine: z.number(),
    endLine: z.number(),
    module: z.string(),
    process_id: z.string(),
    step_index: z.number(),
  })
  .strict();

const TimingStrict = z
  .object({
    vector: z.number(),
    bm25: z.number(),
    merge: z.number(),
    symbol_lookup: z.number(),
    ranking: z.number(),
    formatting: z.number(),
    wall: z.number(),
  })
  .strict();

export const QueryResultStrict = z
  .object({
    processes: z.array(ProcessStrict),
    process_symbols: z.array(ProcessSymbolStrict),
    definitions: z.array(DefinitionStrict),
    timing: TimingStrict,
  })
  .strict();

const RefStrict = z
  .object({ uid: z.string(), name: z.string(), filePath: z.string() })
  .strict();

export const ContextFoundStrict = z
  .object({
    status: z.literal("found"),
    symbol: z
      .object({
        uid: z.string(),
        name: z.string(),
        kind: z.string(),
        filePath: z.string(),
        startLine: z.number(),
        endLine: z.number(),
      })
      .strict(),
    epistemic: z.string(),
    incoming: z.object({ calls: z.array(RefStrict).optional() }).strict(),
    outgoing: z.object({ calls: z.array(RefStrict).optional() }).strict(),
    processes: z.array(z.unknown()),
  })
  .strict();

/** The 1.6.9 not-found variant is a bare `{error}` — no status field. */
export const ContextNotFoundStrict = z.object({ error: z.string() }).strict();

const RiskLevel = z.enum(["LOW", "MEDIUM", "HIGH", "CRITICAL", "UNKNOWN"]);
const ImpactDirection = z.enum(["upstream", "downstream"]);

const ImpactNodeStrict = z
  .object({
    depth: z.number(),
    id: z.string(),
    name: z.string(),
    filePath: z.string(),
    relationType: z.string(),
    confidence: z.number(),
    processes: z.array(
      z
        .object({
          id: z.string(),
          label: z.string(),
          processType: z.string(),
          step: z.number(),
        })
        .strict(),
    ),
  })
  .strict();

/** impact on a resolved (unique or disambiguated) target. */
export const ImpactResolvedStrict = z
  .object({
    target: z
      .object({
        id: z.string(),
        name: z.string(),
        type: z.string(),
        filePath: z.string(),
      })
      .strict(),
    direction: ImpactDirection,
    impactedCount: z.number(),
    risk: RiskLevel,
    epistemic: z.string(),
    summary: z
      .object({
        direct: z.number(),
        processes_affected: z.number(),
        modules_affected: z.number(),
      })
      .strict(),
    byDepthCounts: z.record(z.string(), z.number()),
    affected_processes: z.array(
      z
        .object({
          name: z.string(),
          type: z.string(),
          filePath: z.string(),
          affected_process_count: z.number(),
          total_hits: z.number(),
          earliest_broken_step: z.number(),
        })
        .strict(),
    ),
    affected_modules: z.array(
      z
        .object({ name: z.string(), hits: z.number(), impact: z.string() })
        .strict(),
    ),
    byDepth: z.record(z.string(), z.array(ImpactNodeStrict)),
  })
  .strict();

/** impact on a bare name matching >1 symbol — a FIRST-CLASS response variant
 * since 1.6.9 (eval-server.js handles it; upstream issue #2129). This is the
 * payload that broke the pre-split suite when `src/fleet/dispatch.ts:dispatch`
 * joined the fixture's `dispatch` in the index: `target` carries only `name`,
 * and affected_processes/affected_modules are absent. */
export const ImpactAmbiguousStrict = z
  .object({
    status: z.literal("ambiguous"),
    message: z.string(),
    target: z.object({ name: z.string() }).strict(),
    direction: ImpactDirection,
    totalCandidates: z.number(),
    impactedCount: z.number(),
    risk: RiskLevel,
    maxImpactedCount: z.number(),
    maxRisk: RiskLevel,
    candidates: z.array(
      z
        .object({
          uid: z.string(),
          name: z.string(),
          kind: z.string(),
          filePath: z.string(),
          line: z.number(),
          score: z.number(),
          impactedCount: z.number(),
          risk: RiskLevel,
          direct: z.number(),
        })
        .strict(),
    ),
  })
  .strict();

export const CypherResultStrict = z
  .object({ markdown: z.string(), row_count: z.number() })
  .strict();

/** detect-changes emits TEXT, not JSON (no --json flag in 1.6.9) — the
 * contract is its two headline forms. */
export const DETECT_CHANGES_TEXT_RE =
  /^(No changes detected\.|Changes: \d+ files?, \d+ symbols?\n)/;

// ---------------------------------------------------------------------------
// LENIENT tier — graph-queries.test.ts functional assertions. Passthrough:
// additive upstream fields are tolerated here; the strict tier owns drift.
// ---------------------------------------------------------------------------

const DefinitionLenient = z
  .object({
    name: z.string(),
    filePath: z.string(),
  })
  .passthrough();

export const QueryResultSchema = z
  .object({
    processes: z.array(z.unknown()),
    definitions: z.array(DefinitionLenient),
  })
  .passthrough();

export const ContextResultSchema = z
  .object({
    status: z.literal("found"),
    symbol: z
      .object({ name: z.string(), filePath: z.string() })
      .passthrough(),
    incoming: z
      .object({ calls: z.array(RefStrict.passthrough()).optional() })
      .passthrough(),
    outgoing: z
      .object({ calls: z.array(RefStrict.passthrough()).optional() })
      .passthrough(),
  })
  .passthrough();

/** Lenient RESOLVED impact payload — functional tests disambiguate their
 * targets (`-f FIXTURE_PATH`), so the ambiguous variant never reaches them;
 * if it ever does, the contract suite explains the shape in one loud failure. */
export const ImpactResultSchema = z
  .object({
    target: z
      .object({ name: z.string(), filePath: z.string() })
      .passthrough(),
    impactedCount: z.number(),
    risk: z.string(),
  })
  .passthrough();

// ---------------------------------------------------------------------------
// Drift triage — the failure message is the deliverable
// ---------------------------------------------------------------------------

function formatIssues(error: z.ZodError): string {
  return error.issues
    .map((i) => `  - ${i.path.length > 0 ? i.path.join(".") : "(root)"}: ${i.message}`)
    .join("\n");
}

function driftError(tool: string, variantIssues: string, installed: string | null): Error {
  return new Error(
    `[gitnexus contract drift] the ${tool} payload no longer matches the strict contract (tests/gitnexus/cli-contract.ts).\nInstalled CLI: ${installed ?? "UNREADABLE"} — contract pinned to: ${EXPECTED_CLI_VERSION} (tests/gitnexus/gitnexus-cli-contract.json).\nDrifted fields:\n${variantIssues}\nTriage: if you just upgraded gitnexus, follow the upgrade ritual in AGENTS.md (bump expected version -> reindex -> contract suite -> review diff). If the version did NOT change, the index content changed instead (e.g. a once-unique symbol is now ambiguous) — inspect the payload shape above before editing assertions.`,
  );
}

/** Strict-validate one tool payload; on failure throw a drift-named error
 * listing every drifted field plus installed-vs-pinned versions. */
export function assertContract(
  tool: string,
  raw: unknown,
  schema: z.ZodType,
  installed: string | null,
): void {
  const r = schema.safeParse(raw);
  if (!r.success) throw driftError(tool, formatIssues(r.error), installed);
}

/** Impact responses are a UNION: resolved | ambiguous. Strict-validate against
 * both; drift only when NEITHER variant matches. Returns which variant matched
 * so callers can assert on it. */
export function assertImpactContract(
  raw: unknown,
  installed: string | null,
): "resolved" | "ambiguous" {
  const resolved = ImpactResolvedStrict.safeParse(raw);
  if (resolved.success) return "resolved";
  const ambiguous = ImpactAmbiguousStrict.safeParse(raw);
  if (ambiguous.success) return "ambiguous";
  throw driftError(
    "impact",
    `resolved variant:\n${formatIssues(resolved.error)}\nambiguous variant:\n${formatIssues(ambiguous.error)}`,
    installed,
  );
}
