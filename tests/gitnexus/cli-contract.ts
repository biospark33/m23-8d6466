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
 * inventories verified live against 1.6.9 on 2026-08-28 and re-verified against 1.6.12 on 2026-10-03 (every tool the suites
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

const SymbolDefinitionStrict = z
  .object({
    id: z.string(),
    name: z.string(),
    filePath: z.string(),
    // Required for SYMBOL definitions; absent on File:-node definitions
    // (verified live 2026-09-01, CLI 1.6.9, reindex at 7806bbe — query
    // "SwarmClaw routes" returns File:scripts/provision-hindsight-banks.ts and
    // File:src/swarmclaw/index.ts with no line span; the 2026-08-28 index did
    // not surface File: nodes here). File-node spans are currently absent;
    // the superRefine below trips on a change in EITHER direction — a SYMBOL
    // definition losing its span, or a File: node gaining one (span-addition
    // is exactly the shape change this alarm exists for).
    startLine: z.number().optional(),
    endLine: z.number().optional(),
    // Optional in the 1.6.9 payload: present on module-mapped definitions,
    // absent on others (verified live 2026-08-28 — several query definitions
    // omit it). Still type-checked when present; `.strict()` rejects extras.
    module: z.string().optional(),
    // Node kind ("Function", "Const", …). ADOPTED 2026-09-08, same CLI (1.6.9 ==
    // pin) — this is index-CONTENT drift, not a version move, exactly the case the
    // alarm's own triage text names.
    //
    // Root-caused at the emit site rather than inferred from the payload:
    // `dist/mcp/local/local-backend.js` builds `symbolEntry` with `type: sym.type`
    // UNCONDITIONALLY, and `undefined` simply drops out of JSON. So the field was
    // never new — it was invisible because `sym.type` was always undefined for us.
    // `merged` combines the vector and BM25 retrieval paths; BM25 rows carry no
    // `type`, vector rows do.
    //
    // Why now: until 2026-09-08 EVERY index this repo had ever built was BM25-only.
    // `scripts/install-gitnexus-plus.sh`'s arch guard read `uname -m`, which under a
    // Rosetta'd x86_64 bash answers x86_64 on Apple Silicon, so `--embeddings` was
    // silently dropped on the only hardware we build on. The guard now also consults
    // `sysctl -n hw.optional.arm64`; the first embeddings index followed, the vector
    // path started returning rows (`timing.vector` is now non-zero and dominates
    // wall time), and those rows carry `type`.
    //
    // Optional, not required: the BM25 path still contributes rows without it — in
    // the verified payload 4 of 20 definitions carry `type`, and two functions in the
    // SAME file differ, which is what proves this is per-row provenance rather than a
    // schema change. Nothing was dropped, so nothing is owed upstream.
    type: z.string().optional(),
  })
  .strict()
  .superRefine((def, ctx) => {
    const hasStart = def.startLine !== undefined;
    const hasEnd = def.endLine !== undefined;
    // Both-present-or-both-absent on EVERY definition — a partial span
    // (startLine without endLine or vice versa) is never a legal shape.
    if (hasStart !== hasEnd) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `definition ${def.id} has a partial span (startLine ${hasStart ? "present" : "absent"}, endLine ${hasEnd ? "present" : "absent"})`,
      });
      return;
    }
    if (def.id.startsWith("File:")) {
      if (hasStart) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `File:-node definition ${def.id} gained a startLine/endLine span`,
        });
      }
    } else if (!hasStart) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `symbol definition ${def.id} lost its startLine/endLine span`,
      });
    }
  });

/** `File:`-id definitions carry NO line span — a 1.6.9 payload variant first
 * surfaced 2026-09-01 when an index-content shift ranked two File nodes into
 * a query's definitions (same CLI, no version drift; the alarm's own triage
 * text says to inspect the payload and model the variant, not loosen the
 * symbol shape). The union is discriminated by the id prefix so a SYMBOL
 * definition missing its lines still fails loudly. */
const FileDefinitionStrict = z
  .object({
    id: z.string().startsWith("File:"),
    name: z.string(),
    filePath: z.string(),
    module: z.string().optional(),
    // NO `type` here, deliberately, even though the sibling symbol variant gained one
    // on 2026-09-08. The `File:`-id definition verified live in that same payload
    // carried none, and `.strict()` is what makes this shape a statement rather than a
    // shrug: if a File node starts arriving with a node kind, the alarm should say so
    // and someone should decide whether that is upstream intent. Same reasoning as the
    // span rule above — a File node GAINING a field is precisely what this tier exists
    // to catch. Widen it when a real payload forces the question, not before.
  })
  .strict();

const DefinitionStrict = z.union([
  // File variant first: its startsWith guard makes it span-less by definition,
  // so a File:-id entry carrying lines parses HERE, never below.
  FileDefinitionStrict,
  // ADOPTED (A2 follow-through, 2026-10-19, CLI 1.6.12 == pin): a File: row
  // WITH a span — {"id":"File:tests/swarmclaw/mask-env.test.ts",
  // "startLine":141,"endLine":144}, no name, no filePath — verified live on
  // the freshly reindexed branch tree, same CLI as the pin. Index-CONTENT
  // drift (the alarm's own second case). The span must stay BOTH-present
  // (the partial-span rule below keeps its teeth); the data-quality question
  // — should a File: row ever carry a span, or a row ever lack its own
  // name/path — is upstream's to answer. Both-or-neither is enforced here.
  z
    .object({
      id: z.string().startsWith("File:"),
      startLine: z.number(),
      endLine: z.number(),
    })
    .strict(),
  // ADOPTED (same round): a minimal SYMBOL row of ONLY {id, startLine,
  // endLine} — {"id":"TypeAlias:src/learning/gather.ts:GatherErrorCode",
  // "startLine":61,"endLine":61}, name and filePath absent. Same reasoning.
  z
    .object({
      id: z.string(),
      startLine: z.number(),
      endLine: z.number(),
    })
    .strict()
    .refine((d) => !d.id.startsWith("File:"), {
      message: "File:-id definitions must match a File variant",
    }),
  SymbolDefinitionStrict.refine((d) => !d.id.startsWith("File:"), {
    message: "File:-id definitions must match the line-less File variant",
  }),
]);

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
    // Same provenance as the definition-level `type` documented above: process
    // symbols are built from the same `symbolEntry` shape, so vector-path rows
    // carry the node kind and BM25-path rows do not. Verified live 2026-09-08:
    // 1 of 2 process_symbols carried it.
    type: z.string().optional(),
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

/**
 * The index-staleness marker, ADOPTED (A2 follow-through, 2026-10-19, CLI
 * 1.6.12 == pin): every read tool's payload carries a root `staleness` object
 * when the index predates HEAD — {"status":"behind","commitsBehind":14,
 * "hint":"⚠️ Index is 14 commits behind HEAD. Run analyze tool to update."}
 * verified live. This is DESIGNED upstream signal (the same marker the MCP
 * hooks surface), not accidental shape drift: it appears exactly when
 * indexedHead != HEAD and disappears after a reindex, so the strict schemas
 * accept it as an OPTIONAL root field rather than stripping it.
 */
const StalenessStrict = z
  .object({
    status: z.string(),
    commitsBehind: z.number(),
    hint: z.string(),
  })
  .strict();

export const QueryResultStrict = z
  .object({
    processes: z.array(ProcessStrict),
    process_symbols: z.array(ProcessSymbolStrict),
    definitions: z.array(DefinitionStrict),
    timing: TimingStrict,
    // ADOPTED: the designed staleness marker (see StalenessStrict).
    staleness: StalenessStrict.optional(),
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
    // ADOPTED 1.6.12: `uses` (type references) and `accesses` (property
    // reads/writes) join `calls` as outgoing edge classes, same ref shape.
    outgoing: z
      .object({
        calls: z.array(RefStrict).optional(),
        uses: z.array(RefStrict).optional(),
        accesses: z.array(RefStrict).optional(),
      })
      .strict(),
    processes: z.array(z.unknown()),
    // ADOPTED: the designed staleness marker (see StalenessStrict).
    staleness: StalenessStrict.optional(),
  })
  .strict();

/** The 1.6.9 not-found variant is a bare `{error}` — no status field. */

/** The 1.6.9 not-found variant is a bare `{error}` — no status field. */
export const ContextNotFoundStrict = z.object({ error: z.string() }).strict();

const RiskLevel = z.enum(["LOW", "MEDIUM", "HIGH", "CRITICAL", "UNKNOWN"]);
const ImpactDirection = z.enum(["upstream", "downstream"]);

/** ADOPTED 1.6.12 (upstream #3075, shared-axis risk): every impact verdict
 * also reports the risk computed on the axes all symbol kinds share, which axes
 * were not used and why, and — when no caller resolved — a note that an empty
 * edge set is not proof the symbol is unused. */
const RiskScaleStrict = z
  .object({
    comparableAcrossKinds: z.boolean(),
    unusedAxes: z.array(z.object({ axis: z.string(), reason: z.string() }).strict()),
  })
  .strict();
const SharedRiskFields = {
  riskSharedAxes: RiskLevel,
  riskScale: RiskScaleStrict,
  riskNote: z.string().optional(),
};

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
    ...SharedRiskFields,
    epistemic: z.string(),
    // ADOPTED: the designed staleness marker (see StalenessStrict).
    staleness: StalenessStrict.optional(),
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
    // ADOPTED 1.6.12: true when `candidates` shows fewer than totalCandidates.
    candidatesTruncated: z.boolean(),
    // ADOPTED 1.6.12: null when any candidate could not be walked — upstream
    // stopped reporting an unmeasured blast radius as a measured count.
    impactedCount: z.number().nullable(),
    risk: RiskLevel,
    maxImpactedCount: z.number(),
    maxRisk: RiskLevel,
    // ADOPTED 1.6.12: the max risk over the candidates that resolved.
    knownMaxRisk: RiskLevel,
    // ADOPTED (A2 follow-through): the designed staleness marker (see
    // StalenessStrict) — the ambiguous variant carries it like the rest.
    staleness: StalenessStrict.optional(),
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
          ...SharedRiskFields,
          direct: z.number(),
        })
        .strict(),
    ),
  })
  .strict();

export const CypherResultStrict = z
  .object({
    markdown: z.string(),
    row_count: z.number(),
    // ADOPTED: the designed staleness marker (see StalenessStrict).
    staleness: StalenessStrict.optional(),
  })
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
    // ADOPTED (A2 follow-through, 2026-10-19, CLI 1.6.12 == pin): BOTH fields
    // are optional now. The freshly reindexed branch tree's query payloads
    // carry minimal rows — a File: row of ONLY {id, startLine, endLine} and a
    // TypeAlias row of ONLY {id, startLine, endLine} (name and filePath
    // absent) — verified live on this index, same CLI as the pin. A
    // definition row without a filePath cannot leave the repo, so INV-GN1's
    // security reading is untouched; the data-quality question (should a
    // definition row ever lack its own path?) is upstream's, and the strict
    // tier's new variants carry the same question in their comments.
    name: z.string().optional(),
    filePath: z.string().optional(),
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
