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
 * RESPONSE schemas use camelCase (REST-boundary consumers).
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

export const RetainPayloadSchema = z.object({
  bank_id: BankIdSchema,
  content: z
    .string()
    .min(1)
    .refine((v) => Buffer.byteLength(v, "utf8") <= 102_400, {
      message: "Content exceeds 100KB byte limit",
    }),
  metadata: z
    .object({
      source: z.enum(["agent", "mulch-import", "manual", "consolidate"]),
      kind: z.enum(["decision", "pattern", "expertise", "observation"]).optional(),
      tags: z.array(z.string()).optional(),
    })
    .optional(),
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
// Responses (camelCase — REST-boundary consumers, story CC-8 exception list)
// ---------------------------------------------------------------------------

export const RetainResponseSchema = z.object({
  memoryId: z.string(),
  bankId: BankIdSchema,
  status: z.enum(["created", "updated"]),
  durationMs: z.number(),
});

export const RecallResponseSchema = z.object({
  results: z.array(
    z.object({
      content: z.string(),
      score: z.number().min(0).max(1),
      memoryId: z.string(),
    }),
  ),
  durationMs: z.number(),
});

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
