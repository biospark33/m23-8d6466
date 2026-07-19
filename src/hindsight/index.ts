/**
 * Public API for the Hindsight module (P0.9 foundation).
 *
 * Downstream agents (bank-provisioner, mulch-importer, round-trip-verifier)
 * import from here. This file re-exports the stable contract; do not re-shape
 * without coordinating — see research-brief.md "File plan".
 */

export {
  BankIdSchema,
  ConsolidatePayloadSchema,
  ConsolidateResponseSchema,
  ERR_BANK_COLLISION,
  ERR_BANK_ID_INVALID,
  ERR_HINDSIGHT_UNAVAILABLE,
  ERR_MCP_BRIDGE_NOT_REGISTERED,
  ERR_MULCH_FILE_COUNT,
  MulchExpertiseSchema,
  RecallPayloadSchema,
  RecallResponseSchema,
  ReflectPayloadSchema,
  ReflectResponseSchema,
  RetainPayloadSchema,
  RetainResponseSchema,
  resolveBankId,
} from "./schemas.ts";

export type {
  ConsolidatePayload,
  ConsolidateResponse,
  MulchExpertise,
  RecallPayload,
  RecallResponse,
  ReflectPayload,
  ReflectResponse,
  RetainPayload,
  RetainResponse,
} from "./schemas.ts";

export {
  CONSOLIDATE_TIMEOUT_MS,
  HindsightClient,
  HindsightHttpError,
  RECALL_TIMEOUT_MS,
  REFLECT_TIMEOUT_MS,
  RETAIN_TIMEOUT_MS,
} from "./client.ts";

export type { HindsightClientOptions } from "./client.ts";
