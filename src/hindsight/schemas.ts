/**
 * Hindsight bank-scoped Zod schemas + resolveBankId + error code consts.
 *
 * OWNED BY P0.9 (foundation). Downstream agents (provisioner / importer /
 * verifier) import the EXACT names below. Do not rename without bumping the
 * contract — see research-brief.md "File plan".
 *
 * Endpoint deviation (research-brief.md "Story endpoint paths are WRONG"):
 * the story body lists flat paths like `/v1/default/recall`. The real
 * Hindsight OpenAPI is BANK-SCOPED — client.ts uses these paths, and the
 * payload schemas below match the bank-scoped body shapes (bank_id lives in
 * the URL path, NOT the body, at the REST boundary). The MCP tool layer
 * (P0.7) keeps accepting bank_id in args for backward compat; only client.ts
 * cares about the URL-scoped form.
 *
 * Casing (story CC-8): payloads use snake_case (Hindsight internal names);
 * RESPONSE schemas PARSE the measured snake_case wire (issue #408 conformance
 * slice) and `.transform()` it into the legacy camelCase view, so REST-boundary
 * consumers compile unchanged.
 *
 * Zod v3 syntax — `.optional()`, `.default()`, `.refine({message})`.
 */

import { z } from "zod";

// ---------------------------------------------------------------------------
// Bank ID + resolver
// ---------------------------------------------------------------------------

export const BankIdSchema = z
  .string()
  .regex(/^[a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?$/);

/**
 * Resolve a repo slug to a Hindsight bank ID per story Bank ID Resolution
 * (CC-6): lowercase, `[^a-z0-9]+`→`-`, slice(0,64), then loop-strip leading
 * and trailing hyphens (including hyphens reintroduced by truncation).
 *
 * Does NOT enforce BankIdSchema — single-char returns ("a") are valid, empty
 * returns ("!!!!" → "") are NOT. Callers MUST safeParse the result against
 * BankIdSchema before any API call (INV-HM2). The provisioner does this and
 * emits -32003 on failure.
 *
 * Collision-prone for slugs sharing a common 64-char prefix — callers must
 * supply known-unique slugs; the provisioner disambiguates with `-2..-11`.
 */
export function resolveBankId(repoSlug: string): string {
  let result = repoSlug
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .slice(0, 64);
  while (result.startsWith("-") || result.endsWith("-")) {
    result = result.replace(/^-|-$/g, "");
  }
  return result;
}

// ---------------------------------------------------------------------------
// Payloads (snake_case — Hindsight internal API arg names)
// ---------------------------------------------------------------------------

/**
 * Retain wire body (M1.2 AC5): an `items` array whose items carry `document_id`
 * and `tags` TOP-LEVEL. Measured against live 0.10.0 — same document_id
 * retained twice upserts to ONE document, and `metadata.tags` 422s (evidence:
 * _bmad-output/evidence/p0-9-closure/2026-10-04T20-19-46Z-p0-9-document-id-retain-twice.json,
 * `documentsAfter1`/`documentsAfter2` = 1 + note).
 *
 * F21: `bank_id` is OPTIONAL and no longer required — the REAL body the client
 * sends is `{items:[...]}` with the bank scoped in the URL path
 * (`POST /v1/default/banks/{bank_id}/memories`); a required top-level
 * `bank_id` described a body nobody sends. Kept as an optional passthrough so
 * any future body-borne bank_id still validates (grep verified: no consumer
 * parses outgoing bodies with this schema — it is only re-exported from
 * index.ts).
 */
export const RetainPayloadSchema = z.object({
  bank_id: BankIdSchema.optional(),
  items: z
    .array(
      z.object({
        content: z
          .string()
          .min(1)
          .refine((v) => Buffer.byteLength(v, "utf8") <= 102_400, {
            message: "Content exceeds 100KB byte limit",
          }),
        document_id: z.string().optional(),
        tags: z.array(z.string()).optional(),
        metadata: z
          .object({
            source: z.enum(["agent", "mulch-import", "manual", "consolidate"]),
            kind: z.enum(["decision", "pattern", "expertise", "observation"]).optional(),
          })
          .optional(),
      }),
    )
    .min(1),
});

/**
 * M1.2 AC5 retain-extension metadata — camelCase client-arg names, mapped onto
 * the wire item by client.retain. `updateMode:"replace"` is API-LEVEL
 * semantics: it IS the document_id upsert, so NO wire field exists for it and
 * none is invented. `"replace"` is the only honored mode — any other value is
 * refused at the client boundary (422, before fetch).
 */
export const RetainExtensionSchema = z.object({
  // .min(1): documentId is the upsert identity — an empty string must never
  // ride the wire as one.
  documentId: z.string().min(1).optional(),
  updateMode: z.literal("replace").optional(),
  // F20: tags are schema-OWNED here (the client maps them TOP-LEVEL on the wire
  // item — never metadata.tags, which 0.10.0 422s on). A non-array refusal
  // fires at the client boundary, before fetch.
  tags: z.array(z.string()).optional(),
});

export const RecallPayloadSchema = z.object({
  bank_id: BankIdSchema,
  query: z.string().min(1),
  limit: z.number().int().min(1).max(50).default(5),
});

export const ReflectPayloadSchema = z.object({
  bank_id: BankIdSchema,
  query: z.string().optional(),
});

export const ConsolidatePayloadSchema = z.object({
  bank_id: BankIdSchema,
  options: z
    .object({
      maxAge: z.number().optional(),
      preserveRecent: z.number().default(10),
    })
    .optional(),
});

// ---------------------------------------------------------------------------
// Responses — parse the measured snake_case wire; `.transform()` emits the
// legacy camelCase view (REST-boundary consumers, story CC-8 exception list).
// ---------------------------------------------------------------------------

/**
 * RetainResponse — wire shape measured live on 0.10.0
 * (_bmad-output/evidence/p0-9-closure/2026-10-04T20-19-46Z-p0-9-document-id-retain-twice.json):
 * `{success, bank_id?, items_count, async, usage?}`. The transform produces the
 * legacy camelCase view so existing consumers compile unchanged (issue #408
 * conformance slice).
 *
 * Legacy-view placeholders are issue #408's OPEN DECISION, not observations:
 * 0.10.0 has NO wire source for `memoryId` — identity is `document_id` now —
 * so `memoryId` falls back to "" from a forward-compat `id` field no current
 * server emits. `status` is pinned "created": the 0.10.0 body carries no
 * created/updated distinction (the upsert is silent). `durationMs` is absent
 * from the measured body → 0 (host-side latency is the honest figure anyway —
 * round-trip-verifier F009).
 */
const RetainWireSchema = z.object({
  success: z.boolean(),
  bank_id: z.string().optional(),
  items_count: z.number(),
  async: z.boolean(),
  id: z.string().optional(),
  durationMs: z.number().optional(),
  usage: z
    .object({
      input_tokens: z.number(),
      output_tokens: z.number(),
      total_tokens: z.number(),
      cached_tokens: z.number(),
      thoughts_tokens: z.number(),
    })
    .optional(),
});

export const RetainResponseSchema = RetainWireSchema.transform((w) => ({
  memoryId: w.id ?? "",
  bankId: w.bank_id ?? "",
  status: "created" as const,
  durationMs: w.durationMs ?? 0,
}));

/**
 * RecallResponse — results measured live on 0.10.0 carry DISTINCT `id`
 * (server-minted fact id) and `document_id` (document identity); never
 * assumed equal. `documentId` in the view is the additive null-tolerant field
 * M1.3's expected-id matching consumes: an item retained without an explicit
 * identity gets a server-assigned one, so a missing `document_id` → null, not
 * "" — and an empty-string wire id folds into absent the same way (the
 * null-tolerance contract gets no third state). `content`/`score` keep
 * old-name tolerance per the conformance contract — `text ?? content ?? ""`,
 * `score ?? 0`. The pre-change 0..1 score bound is DROPPED with the wire
 * shape: the live scale is unmeasured (issue #408), and ranking tolerates any
 * finite number.
 */
export const RecallResponseSchema = z
  .object({
    results: z.array(
      z.object({
        id: z.string().optional(),
        text: z.string().optional(),
        document_id: z.string().nullish(),
        content: z.string().optional(),
        score: z.number().optional(),
      }),
    ),
    durationMs: z.number().optional(),
  })
  .transform((w) => ({
    results: w.results.map((r) => ({
      memoryId: r.id ?? "",
      content: r.text ?? r.content ?? "",
      score: r.score ?? 0,
      documentId: r.document_id ? r.document_id : null,
    })),
    durationMs: w.durationMs ?? 0,
  }));

export const ReflectResponseSchema = z.object({
  bankId: z.string(),
  insights: z
    .array(
      z.object({
        summary: z.string().min(1),
        relatedMemories: z.number().int().min(0).optional(),
      }),
    )
    .min(1),
  durationMs: z.number(),
});

export const ConsolidateResponseSchema = z.object({
  consolidatedCount: z.number(),
  preservedCount: z.number(),
  durationMs: z.number(),
});

// ---------------------------------------------------------------------------
// Mulch expertise entry (canonical storage = JSONL one object per line)
// ---------------------------------------------------------------------------

export const MulchExpertiseSchema = z.object({
  id: z.string().uuid().optional(),
  // `.min(1)` on domain + expertise: an all-empty entry would otherwise pass,
  // dedup to a constant hash, and silently import one empty record per run.
  // concepts left as-is (empty concepts array = untagged but valid entry).
  domain: z.string().min(1),
  concepts: z.array(z.string()),
  expertise: z.string().min(1),
  source: z.string().optional(),
  confidence: z.number().min(0).max(1).optional(),
});

// ---------------------------------------------------------------------------
// Provisioner / importer error code taxonomy (surface (b) per CC-W3).
// These surface as CLI exit codes + {ok:false,error:{code,message},requestId}
// envelopes on script output — P0.9 owns NO HTTP listener.
// ---------------------------------------------------------------------------

export const ERR_MCP_BRIDGE_NOT_REGISTERED = -32001;
export const ERR_HINDSIGHT_UNAVAILABLE = -32002;
export const ERR_BANK_ID_INVALID = -32003;
export const ERR_MULCH_FILE_COUNT = -32004;
export const ERR_BANK_COLLISION = -32005;

// ---------------------------------------------------------------------------
// Type inferences (downstream consumers want typed payloads/responses)
// ---------------------------------------------------------------------------

export type RetainPayload = z.infer<typeof RetainPayloadSchema>;
export type RecallPayload = z.infer<typeof RecallPayloadSchema>;
export type ReflectPayload = z.infer<typeof ReflectPayloadSchema>;
export type ConsolidatePayload = z.infer<typeof ConsolidatePayloadSchema>;

export type RetainResponse = z.infer<typeof RetainResponseSchema>;
export type RecallResponse = z.infer<typeof RecallResponseSchema>;
export type ReflectResponse = z.infer<typeof ReflectResponseSchema>;
export type ConsolidateResponse = z.infer<typeof ConsolidateResponseSchema>;

export type MulchExpertise = z.infer<typeof MulchExpertiseSchema>;
