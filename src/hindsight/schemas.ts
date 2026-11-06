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
 * Legacy-view placeholders were issue #408's OPEN DECISION, RESOLVED
 * 2026-11-04 for `memoryId` (RoundTripOk option): 0.10.0 has NO wire source
 * for `memoryId` — identity is `document_id` now — so the transform no longer
 * emits the field at all; the only honest identity signal is recall-side
 * (`RoundTripOk.matchedMemoryId`, round-trip-verifier.ts). `status` is pinned
 * "created": the 0.10.0 body carries no created/updated distinction (the
 * upsert is silent). `durationMs` is absent from the measured body → 0
 * (host-side latency is the honest figure anyway — round-trip-verifier F009).
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
  bankId: w.bank_id ?? "", // dp:ok bank_id is optional on the measured wire; the legacy view pins string, absent folds to ""
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
 * old-name tolerance per the conformance contract — `text` first, `content`
 * as the old name, folded to the empty string when both are absent; `score`
 * folds to 0. The pre-change 0..1 score bound is DROPPED with the wire
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
      memoryId: r.id ?? "", // dp:ok id is optional on the measured wire; expected-id matching consumes documentId, absent id folds to ""
      content: r.text ?? r.content ?? "", // dp:ok old-name tolerance per the conformance contract (see above); both absent folds to ""
      score: r.score ?? 0,
      documentId: r.document_id ? r.document_id : null,
    })),
    durationMs: w.durationMs ?? 0,
  }));

export const ReflectResponseSchema = z.object({
  // Wire = view: the 0.10.0 reflect response carries the reflect markdown
  // itself (openapi.json components/schemas/ReflectResponse, required list =
  // ["text"]; raw captured body
  // 2026-11-06T03-16-12Z-p0-9-reflect-raw-body-fisr9.json — based_on /
  // structured_output / structured_output_error / usage / trace all null,
  // stripped). The legacy `{bankId, insights[], durationMs}` shape does NOT
  // exist on the wire — round-trip-via-bridge 5d934h refused it
  // (`bankId` received undefined). Nothing on the wire maps to the legacy
  // fields, so unlike RetainResponseSchema there is nothing to fold — no
  // `.transform()`.
  text: z.string().min(1),
});

export const ConsolidateResponseSchema = z.object({
  // WIDENING + TIGHTEN (F-025, round-1): the real 0.10.0 wire body is
  // `{operation_id (required), deduplicated?}` — openapi.json:10350-10369
  // ConsolidationResponse. The pre-widening required-counts shape parse-FAILED
  // against the real instance (502 via requestJSON safeParse); the widening
  // then went too far — with operation_id optional, `{}` parsed as success and
  // CONSOLIDATE_UNPARSEABLE was dead code. operation_id is now REQUIRED per
  // the openapi `required` list: a legacy-counts-only body (pre-M2 mocks)
  // REFUSES (502 via requestJSON safeParse) — the real wire always carries
  // operation_id. The three legacy camelCase fields stay in the OUTPUT type as
  // required numbers via `.default(0)` — parse-tolerant — while the z.infer
  // view keeps round-trip-verifier.ts:461-464's `number` assignments compiling
  // (strict mode; that file is outside this change's file fence). Absent
  // counts fold to 0 exactly like RetainResponseSchema's `durationMs → 0`
  // precedent (:146-183): on the async 0.10.0 wire the true counts live in
  // the operation's result — consumers needing them must poll
  // client.listOperations, not read them here.
  consolidatedCount: z.number().default(0),
  preservedCount: z.number().default(0),
  durationMs: z.number().default(0),
  operation_id: z.string(),
  deduplicated: z.boolean().optional(),
});

// ---------------------------------------------------------------------------
// Mental models + operations (M3.1 leaf 1.1.2). Request/response shapes are
// the vendored 0.10.0 OpenAPI — citations inline per schema. Read-back
// schemas are `.passthrough()` where the wire carries fields this schema
// does not enumerate, so server-side fields survive GET round-trips.
// ---------------------------------------------------------------------------

/**
 * Trigger settings (openapi.json:15629 MentalModelTrigger-Input; the GET
 * read-back shape :15856-16081 MentalModelTrigger-Output carries the same
 * fields). Enumerated: refresh_after_consolidation (:15879, default false),
 * mode (:15869, "full"|"delta"), refresh_cron (:15885, nullable string —
 * mutually exclusive with refresh_after_consolidation). `.passthrough()`
 * keeps the ~12 unenumerated fields (budget :15858,
 * min_refresh_interval_seconds :15897, fact_types :15910, tag_groups :15970,
 * ...) present on GET read-backs instead of stripped by the parse.
 */
export const MentalModelTriggerSchema = z
  .object({
    refresh_after_consolidation: z.boolean().optional(),
    mode: z.enum(["full", "delta"]).optional(),
    refresh_cron: z.string().nullable().optional(),
  })
  .passthrough();

/**
 * Mental model body (openapi.json:15355-15501 MentalModelResponse — required
 * id/bank_id/name :15495; content/config/reflect_response appear only at
 * detail=content|full per the list `detail` param :1898-1914). Loose via
 * `.passthrough()`; trigger is nullish (:15411-15420 — anyOf trigger|null)
 * so a metadata-detail row (no trigger) parses.
 */
export const MentalModelSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    bank_id: z.string().optional(),
    source_query: z.string().optional(),
    trigger: MentalModelTriggerSchema.nullish(),
  })
  .passthrough();

/**
 * List envelope (openapi.json:15057-15090 MentalModelListResponse): the
 * wrapper key is `items` — NOT `mental_models` and NOT a bare array; all
 * four keys required (:15083-15088).
 */
export const MentalModelListSchema = z.object({
  items: z.array(MentalModelSchema),
  total: z.number(),
  limit: z.number(),
  offset: z.number(),
});

/**
 * POST .../mental-models response (openapi.json:10993-11018
 * CreateMentalModelResponse): operation_id required (:11014-11016);
 * mental_model_id string|null (:10995-11006) — null until the background
 * reflect has generated content; track it via client.listOperations.
 */
export const CreateMentalModelResponseSchema = z.object({
  mental_model_id: z.string().nullable().optional(),
  operation_id: z.string(),
});

/**
 * One async-operation row (openapi.json:16282-16443 OperationResponse).
 * Required (:16434-16441): id, task_type, items_count, created_at, status,
 * error_message (nullable string). operation_id/operation_type
 * (:16292/:16304 — same as id/task_type under the single-op read names) and
 * mental_model_id (:16343 — set on refresh_mental_model rows, null
 * otherwise) are nullable-optional. details (:16355) is a per-operation-type
 * discriminated payload this schema does not enumerate — z.unknown keeps it
 * inspectable without pinning a shape.
 */
export const MentalModelOperationSchema = z.object({
  id: z.string(),
  task_type: z.string(),
  operation_id: z.string().nullable().optional(),
  operation_type: z.string().nullable().optional(),
  items_count: z.number(),
  mental_model_id: z.string().nullable().optional(),
  details: z.unknown().nullable().optional(),
  created_at: z.string(),
  updated_at: z.string().nullable().optional(),
  status: z.string(),
  error_message: z.string().nullable(),
  retry_count: z.number().nullable().optional(),
  next_retry_at: z.string().nullable().optional(),
});

/**
 * GET .../operations envelope (openapi.json:16666-16701
 * OperationsListResponse — all five keys required :16693-16699).
 */
export const OperationsListSchema = z.object({
  bank_id: z.string(),
  total: z.number(),
  limit: z.number(),
  offset: z.number(),
  operations: z.array(MentalModelOperationSchema),
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

export type MentalModelTrigger = z.infer<typeof MentalModelTriggerSchema>;
export type MentalModel = z.infer<typeof MentalModelSchema>;
export type MentalModelList = z.infer<typeof MentalModelListSchema>;
export type CreateMentalModelResponse = z.infer<typeof CreateMentalModelResponseSchema>;
export type MentalModelOperation = z.infer<typeof MentalModelOperationSchema>;
export type OperationsList = z.infer<typeof OperationsListSchema>;

export type MulchExpertise = z.infer<typeof MulchExpertiseSchema>;
