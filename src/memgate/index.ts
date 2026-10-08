/**
 * Public API for the M2.1 memory gateway.
 *
 * Consumers: the M2.2 box side (reads the delivered QDS_KG_RECALL_KEY +
 * QDS_KG_GATEWAY_URL pair out of the box env — it does NOT import this
 * module), the M2.3 live battery, the M3.1 nightly lifecycle proof, and the
 * future Z4 8080 image's HTTP listener (out of scope for M2.1 — this module
 * is library-only). This file re-exports the stable contract; do not re-shape
 * without coordinating (hindsight/index.ts idiom).
 */

export {
  AGENT_GRANT_CLASSES,
  AGENT_TOKEN_VERBS,
  DEFAULT_KEY_TTL_BACKSTOP_MS,
  DEFAULT_MEMGATE_LEDGER,
  MEMGATE_ADMIN_KEY,
  MEMGATE_ENV_FILE,
  MEMGATE_REFUSAL_REASONS,
  QDS_KG_GATEWAY_URL,
  QDS_KG_RECALL_KEY,
  QDS_MEMGATE_LEDGER,
  QDS_MEMGATE_SIGNING_KEY,
  VERB_ROUTES,
  matchRoute,
  MemgateError,
  parseAgentTokenScope,
  parseRunKeyScope,
  resolveMemgateLedgerPath,
} from "./schemas.ts";

export { MemgateLedger, openReadOnly } from "./ledger.ts";

export {
  deliverRunKey,
  forwardScoped,
  grantAgentToken,
  listAgentTokens,
  memgateDeps,
  mintRunMemoryKey,
  revokeAgentToken,
  revokeRunMemoryKey,
  runMemoryKeyLifecycle,
  verifyRequest,
} from "./gateway.ts";

export type {
  AgentConsumerClass,
  AgentTokenScope,
  AgentVerb,
  MemgateRefusalReason,
  MemgateRoute,
  RunKeyScope,
} from "./schemas.ts";

export type { MemgateIssuanceInput, MemgateIssuanceRow, MemgateKeyKind } from "./ledger.ts";

export type {
  DeliverRunKeyInput,
  GrantedAgentToken,
  GrantAgentTokenInput,
  MemgateClient,
  MemgateDeps,
  MemgateDepsOptions,
  MemgatePrincipal,
  MemgateVerifyResult,
  MintedRunKey,
  MintRunKeyInput,
  RevokeTokenInput,
  RunMemoryKeyLifecycleInput,
  VerifyRequestInput,
} from "./gateway.ts";
