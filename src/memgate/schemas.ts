/**
 * M2.1 memory gateway — constants, closed vocabularies, parse schemas, and the
 * pure gates hoisted from gateway.ts (500-line pin). Everything the gateway
 * refuses with is either a constant here or a route in `VERB_ROUTES`: verb
 * vocabulary, the two agent grant classes, the eight refusal reasons and the
 * route table are all CLOSED (DD-28.26). Wildcards are structurally impossible:
 * `banks` is a min-1 BankId array everywhere, no sentinel type exists, and
 * per-run keys carry the literal ["recall"] tuple (AC2).
 */

import { createHash, createHmac, timingSafeEqual } from "node:crypto";

import { z } from "zod";

import { BankIdSchema } from "../hindsight/schemas.ts";
import { assertPlainBoxPath } from "../providers/path-guard.ts";
import { log, type LogEntry } from "../swarmclaw/log.ts";
import type { MemgateIssuanceRow, MemgateLedger } from "./ledger.ts";

/**
 * The TTL ceiling every per-run key inherits through the mint's single
 * pre-issuance guard (INV-CAP-1, mirror of defaultKeyCapMicroUsd):
 * `ttlMs (per mint) <= DEFAULT_KEY_TTL_BACKSTOP_MS` — checked at mint,
 * never at use, so every caller inherits the bound.
 */
export const DEFAULT_KEY_TTL_BACKSTOP_MS = 86_400_000;

/** runId grammar (F-019): bounded length + safe charset — it rides every row and
 * log line. gatewayUrl grammar (F-008): a plain http(s) URL — no newline/space/
 * `=` can inject a second env entry into the delivered file. */
export const RUN_ID_MAX_LENGTH = 256;
export const RUN_ID_PATTERN = /^[A-Za-z0-9._:\-]+$/;
export const GATEWAY_URL_PATTERN = /^https?:\/\/[A-Za-z0-9.:\-/]+$/;

/** keyMaterial grammar (R2-F-001, same injection class as F-008): after the
 * "mgrun-" prefix the remainder must be base64url — no newline or '=' can
 * inject a second env entry into the delivered box file. */
export const KEY_MATERIAL_REMAINDER_PATTERN = /^[A-Za-z0-9_-]+$/;

/** Scope-array ceiling (R2-F-017): a banks array serializes into claims_json,
 * which the append-only ledger keeps forever (INV-MG-4). */
export const MAX_SCOPE_BANKS = 64;

/** Env-var names, referenced by NAME in remediations — never expanded (errors.ts:21-22). */
export const MEMGATE_ADMIN_KEY = "MEMGATE_ADMIN_KEY";
export const QDS_MEMGATE_SIGNING_KEY = "QDS_MEMGATE_SIGNING_KEY";
export const QDS_MEMGATE_LEDGER = "QDS_MEMGATE_LEDGER";

/** The DD-28.23 canonical pair delivered into the box's env file. */
export const QDS_KG_RECALL_KEY = "QDS_KG_RECALL_KEY";
export const QDS_KG_GATEWAY_URL = "QDS_KG_GATEWAY_URL";

/** Delivery default — the KEY_ENV_FILE name discipline (credentials.ts:100),
 * kept HOME-relative so the BOX-routed leg (M2.2's driver fill: every driver
 * exec lands in the box's ssh HOME, so relative is image-agnostic) can adopt
 * it unchanged. M2.1's write is process-LOCAL (gateway cwd), not box-routed.
 * Consumer: runMemoryKeyLifecycle's default target (F-025). */
export const MEMGATE_ENV_FILE = "app/.env";

/** The ledger's default resting place when QDS_MEMGATE_LEDGER is unset. */
export const DEFAULT_MEMGATE_LEDGER = ".sandbox/memgate-ledger.db";

/**
 * The closed request-path refusal set (DD-28.26(13) + the mint-side TTL
 * refusal). Exactly these eight; D3 keeps invalid credentials INSIDE `no-auth`
 * (structured `authOutcome` detail) rather than widening the union; admin/mint
 * typed refusals ride plain `code` lines (F-014).
 */
export const MEMGATE_REFUSAL_REASONS = [
  "scope-bank", "scope-verb", "expired", "revoked",
  "no-auth", "admin-auth", "ledger-unreadable", "mint-invalid-ttl",
] as const;

export type MemgateRefusalReason = (typeof MEMGATE_REFUSAL_REASONS)[number];

/**
 * The one `{code, remediation}` memgate error shape (ProviderError pattern,
 * src/providers/errors.ts:18-30). Remediations reference env vars by NAME,
 * never expanded values; remediation is optional at construction.
 */
export class MemgateError extends Error {
  /** Machine-readable failure class; also the `reason` in every refusal line. */
  readonly code: string;
  /** The literal next command, secrets referenced by env-var NAME, never expanded. */
  readonly remediation: string;
  /** R2-F-003: the compensation handle when the fault strands a live token
   * (deliver-state-write-failed) — absent on every other error. */
  readonly tokenId?: string;

  constructor(code: string, message: string, remediation: string, tokenId?: string) {
    super(message);
    this.name = "MemgateError";
    this.code = code;
    this.remediation = remediation;
    this.tokenId = tokenId;
  }
}

/**
 * The closed agent-token verb vocabulary. `recall` stays IN the vocabulary —
 * the AC5 negative control stays well-defined — but NO grant class carries it
 * (D-vocab): only per-run keys recall.
 */
export const AGENT_TOKEN_VERBS = ["recall", "reflect", "consolidate", "retain"] as const;

export type AgentVerb = (typeof AGENT_TOKEN_VERBS)[number];
/** The two EXHAUSTIVE agent grant classes (DD-28.26 item 1 / D-vocab):
 * host-held {reflect, retain}, bot-held {consolidate}. Nothing else. */
export const AGENT_GRANT_CLASSES = {
  host: ["reflect", "retain"],
  bot: ["consolidate"],
} as const;

export type AgentConsumerClass = keyof typeof AGENT_GRANT_CLASSES;


/** Per-run key scope — verbs are the LITERAL ["recall"] tuple (AC2); runId is
 * grammar-bounded (F-019); re-validated at the authz decision (F-013). */
export const RUN_KEY_SCOPE_SCHEMA = z.object({
  runId: z.string().min(1).max(RUN_ID_MAX_LENGTH).regex(RUN_ID_PATTERN),
  banks: z.array(BankIdSchema).min(1).max(MAX_SCOPE_BANKS), // R2-F-017
  expiresAtMs: z.number().int().positive(),
  verbs: z.tuple([z.literal("recall")]),
});

export type RunKeyScope = z.infer<typeof RUN_KEY_SCOPE_SCHEMA>;

/** Agent token scope. expiresAtMs (F-006): optional ceiling enforced at verify,
 * absent = revocation-bound. name (F-025): optional label, persisted in claims. */
export const AGENT_TOKEN_SCOPE_SCHEMA = z.object({
  tokenId: z.string().min(1),
  consumerClass: z.enum(["host", "bot"]),
  banks: z.array(BankIdSchema).min(1).max(MAX_SCOPE_BANKS), // R2-F-017
  verbs: z.array(z.enum(AGENT_TOKEN_VERBS)).min(1),
  expiresAtMs: z.number().int().positive().optional(),
  name: z.string().min(1).max(256).optional(),
});

export type AgentTokenScope = z.infer<typeof AGENT_TOKEN_SCOPE_SCHEMA>;

export function parseRunKeyScope(input: unknown): { success: true; data: RunKeyScope } | { success: false } {
  const parsed = RUN_KEY_SCOPE_SCHEMA.safeParse(input);
  return parsed.success ? { success: true, data: parsed.data } : { success: false };
}

export function parseAgentTokenScope(
  input: unknown,
): { success: true; data: AgentTokenScope } | { success: false } {
  const parsed = AGENT_TOKEN_SCOPE_SCHEMA.safeParse(input);
  return parsed.success ? { success: true, data: parsed.data } : { success: false };
}

/**
 * `QDS_MEMGATE_LEDGER` resolution chain (run-record.ts:1230-1247 doctrine):
 * explicit argument wins; an EMPTY string is UNSET, not a path; otherwise the
 * trimmed env value; otherwise the default. `env` is the injection seam (F-009):
 * memgateDeps threads opts.env through so an embedded consumer never resolves
 * against the host process.env; the default keeps the direct-caller behavior.
 */
export function resolveMemgateLedgerPath(
  raw?: string,
  env: Record<string, string | undefined> = process.env,
): string {
  const explicit = raw?.trim();
  if (explicit !== undefined && explicit !== "") return explicit;
  const fromEnv = env[QDS_MEMGATE_LEDGER]?.trim();
  if (fromEnv !== undefined && fromEnv !== "") return fromEnv;
  return DEFAULT_MEMGATE_LEDGER;
}

// --- Pure guards + offline credential/claims helpers (hoisted — 500-line pin) ---

/** One emit path: deps.log when injected, else the global sink (setLogSink-capturable). */
export function emit(deps: MemgateDeps, fields: Record<string, unknown> & { requestId: string }): void {
  const { requestId, ...rest } = fields;
  const entry: LogEntry = {
    requestId, operation: "memgate", agentId: null,
    timestamp: new Date().toISOString(), duration: 0, status: "ok",
    ...rest,
  };
  if (deps.log !== undefined) deps.log(entry);
  else log(entry);
}

/** Best-effort emit (F-001/F-003): a throwing sink never gates a state change nor
 * replaces an original fault; a line WITHOUT `event` is an F-014 admin/mint plain
 * refusal line. The ONE strict emit is deliverRunKey's post-write state line. */
export function emitBestEffort(deps: MemgateDeps, fields: Record<string, unknown> & { requestId: string }): void {
  try { emit(deps, fields); } catch { /* observability only — never fatal */ }
}

export function stringArrayOf(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

/** Every verify/forward refusal: emits memgate-refused, returns the closed-set
 * result; ttlRemainingMs rides ONLY the expired arm when a number was given. */
export function refused(
  deps: MemgateDeps,
  fields: Record<string, unknown> & { requestId: string; reason: MemgateRefusalReason },
): { ok: false; reason: MemgateRefusalReason; ttlRemainingMs?: number } {
  emitBestEffort(deps, { event: "memgate-refused", ...fields });
  if (fields.reason === "expired" && typeof fields.ttlRemainingMs === "number") {
    return { ok: false, reason: fields.reason, ttlRemainingMs: fields.ttlRemainingMs };
  }
  return { ok: false, reason: fields.reason };
}

/** Timing-safe string compare; different lengths refuse without a throw. */
export function timingSafeEqualStrings(a: string, b: string): boolean {
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

export function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** claims_json → object; anything else is a corrupt row. R2-F-013: the throw is
 * a DATA fault — resolveCredential folds it into the D3 unknown-key ladder
 * (claims:null), never ledger-unreadable (reserved for storage/fs faults). */
export function parseClaims(json: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(json);
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new MemgateError("claims-corrupt",
      "an issuance row's claims_json is not a JSON object — the row is corrupt",
      "inspect the ledger named by QDS_MEMGATE_LEDGER");
  }
  return parsed as Record<string, unknown>;
}

/** Offline HMAC check of a presented agent token; null = bad credential.
 * Falsy signing key refuses (F-017) — HMAC under "" is forgeable. */
export function verifyAgentTokenMaterial(
  signingKey: string | undefined,
  token: string,
): Record<string, unknown> | null {
  const rest = token.slice("mgat.".length);
  const dot = rest.indexOf(".");
  if (!signingKey || dot <= 0) return null;
  const claimsB64 = rest.slice(0, dot);
  const sigB64 = rest.slice(dot + 1);
  if (claimsB64 === "" || sigB64 === "" || sigB64.includes(".")) return null;
  const claimsJson = Buffer.from(claimsB64, "base64url").toString("utf8");
  const expectedSig = createHmac("sha256", signingKey).update(claimsJson, "utf8").digest("base64url");
  if (!timingSafeEqualStrings(sigB64, expectedSig)) return null;
  try {
    const parsed: unknown = JSON.parse(claimsJson);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** credential → (tokenId, row, claims) | null for unknown; ledger faults THROW
 * (fail closed). Per-run tokenId IS the sha256 digest — no second lookup.
 * R2-F-013: a claims-parse fault is DATA corruption, not storage — folded into
 * the D3 unknown-key ladder as claims:null (the zod re-validation refuses with
 * tokenId on the line); open/read faults still throw ledger-unreadable. */
export function resolveCredential(
  signingKey: string | undefined,
  getIssuance: (tokenId: string) => MemgateIssuanceRow | undefined,
  material: string,
): { tokenId: string; row: MemgateIssuanceRow; claims: Record<string, unknown> | null } | null {
  if (material.startsWith("mgrun-")) {
    const tokenId = sha256Hex(material);
    const row = getIssuance(tokenId);
    if (row === undefined || row.kind !== "per-run") return null;
    try { return { tokenId, row, claims: parseClaims(row.claims_json) }; }
    catch { return { tokenId, row, claims: null }; }
  }
  if (material.startsWith("mgat.")) {
    const claims = verifyAgentTokenMaterial(signingKey, material);
    if (claims === null || typeof claims.tokenId !== "string") return null;
    const row = getIssuance(claims.tokenId);
    if (row === undefined || row.kind !== "agent" || row.digest !== sha256Hex(material)) return null;
    return { tokenId: claims.tokenId, row, claims }; // the row's digest is the anchor
  }
  return null;
}

/** The mint scope guard (F-019): throws mint-invalid-scope; the gateway
 * plain-lines the code (F-014) and rethrows. */
export function checkMintScope(runId: unknown, banks: unknown): void {
  const idOk = typeof runId === "string" && runId.length > 0 && runId.length <= RUN_ID_MAX_LENGTH
    && RUN_ID_PATTERN.test(runId);
  const banksOk = Array.isArray(banks) && banks.length > 0 && banks.length <= MAX_SCOPE_BANKS // R2-F-017
    && banks.every((b) => BankIdSchema.safeParse(b).success);
  if (!idOk || !banksOk) {
    throw new MemgateError("mint-invalid-scope",
      `runId must be 1-${String(RUN_ID_MAX_LENGTH)} chars of [A-Za-z0-9._:-] and banks a non-empty BankId array — refused before any key exists`,
      "pass a non-empty runId and at least one bank id matching [a-z0-9-]");
  }
}

/** The grant verb guards (D-vocab): throws grant-verb-outside-vocabulary /
 * grant-verb-outside-class; recall is in NO grant class. */
export function checkGrantVerbs(verbs: string[], grantClass: AgentConsumerClass): void {
  const outsideVocab = verbs.filter((v) => !(AGENT_TOKEN_VERBS as readonly string[]).includes(v));
  if (outsideVocab.length > 0) {
    throw new MemgateError("grant-verb-outside-vocabulary",
      `verbs ${JSON.stringify(outsideVocab)} are outside the closed agent vocabulary`,
      `use only ${JSON.stringify([...AGENT_TOKEN_VERBS])}`);
  }
  const classVerbs: readonly string[] = AGENT_GRANT_CLASSES[grantClass];
  const outsideClass = verbs.filter((v) => !classVerbs.includes(v));
  if (outsideClass.length > 0) {
    throw new MemgateError("grant-verb-outside-class",
      `verbs ${JSON.stringify(outsideClass)} are outside the ${grantClass} grant class — no agent grant class carries them`,
      `the ${grantClass} class grants exactly ${JSON.stringify([...classVerbs])}`);
  }
}

/** Grammar gate on the delivery target (F-007): deliverRunKey runs this FIRST
 * so every caller inherits it, and the lifecycle runs it pre-mint (AC1). */
export function assertDeliveryTargetSafe(target: string): void {
  try {
    assertPlainBoxPath("target", target);
  } catch {
    throw new MemgateError("env-file-invalid",
      `delivery target ${JSON.stringify(target)} is not a plain path (charset [A-Za-z0-9._/-], no ".." segments) — refusing before any key exists`,
      "pass a plain path (charset [A-Za-z0-9._/-], no '..' segments) — a HOME-relative path is the sanctioned KEY_ENV_FILE idiom");
  }
}

/** The full delivery-config grammar (F-008): target path + a gatewayUrl whose
 * env-file value cannot inject entries. Runs pre-mint (lifecycle) and at the
 * write choke point (deliverRunKey). */
export function assertDeliveryConfigSafe(target: string, gatewayUrl: string): void {
  assertDeliveryTargetSafe(target);
  if (!GATEWAY_URL_PATTERN.test(gatewayUrl)) {
    throw new MemgateError("env-file-invalid",
      `gatewayUrl ${JSON.stringify(gatewayUrl)} is not a plain http(s) URL — the env file cannot carry newlines, spaces, or '=' inside a value`,
      "pass a plain http://host:port or https://host:port URL");
  }
}

// --- Forward surface (D6 split): re-exported verbatim from forward.ts ---
export {
  type ForwardArgs,
  MAX_RETAIN_CONTENT_CHARS,
  type MemgateRoute,
  VERB_ROUTES,
  bankOfPath,
  matchRoute,
  parseForwardBody,
} from "./forward.ts";

// --- Gateway surface types — the op inputs/outputs the barrel re-exports ---

/** Structural subset of HindsightClient actually forwarded (kg-context.ts:81-85
 * idiom) — the real client satisfies it; tests inject plain objects. */
export interface MemgateClient {
  recall(bankId: string, query?: string, limit?: number): Promise<unknown>;
  reflect(bankId: string, query?: string): Promise<unknown>;
  consolidate(bankId: string, options?: { maxAge?: number; preserveRecent?: number }): Promise<unknown>;
  retain(bankId: string, content?: unknown, metadata?: unknown): Promise<unknown>;
}

/**
 * Injection surface (plain-object, no mock library). `adminKey` is the
 * PRESENTED admin credential; the CONFIGURED key is read from `env` by name at
 * op time and compared timing-safe. When `env` is NOT wired, admin ops refuse
 * (fail closed, R2-F-002) UNLESS `embeddedAdmin` is set — a flag set ONLY by
 * memgateDeps when constructed without an explicit env (the registered rev-3(e)
 * embedded seam, where the presented key IS the process-env-configured one).
 * `log` is the injectable emit path; the default goes to the global sink so
 * setLogSink captures every line.
 */
export interface MemgateDeps {
  ledger: MemgateLedger;
  client?: MemgateClient;
  now?: () => number;
  randomBytes?: (length: number) => Uint8Array;
  signingKey?: string;
  adminKey?: string;
  env?: Record<string, string | undefined>;
  /** R2-F-002 — set ONLY by memgateDeps (opts.env === undefined). Hand-built
   * deps must not set it; without `env` they fail admin-auth CLOSED. */
  embeddedAdmin?: true;
  log?: (entry: LogEntry) => void;
}

export interface MemgateDepsOptions {
  env?: Record<string, string | undefined>;
  ledgerPath?: string;
  ledger?: MemgateLedger;
  client?: MemgateClient;
  now?: () => number;
  randomBytes?: (length: number) => Uint8Array;
  log?: (entry: LogEntry) => void;
}

export interface MintRunKeyInput {
  runId: string;
  banks: string[];
  ttlMs: number;
  requestId: string;
}

export interface MintedRunKey {
  /** The ONLY plaintext sink — never logged, never persisted. */
  keyMaterial: string;
  tokenId: string;
  expiresAtMs: number;
}

export interface DeliverRunKeyInput {
  /** Grammar-gated at the choke point (F-007: deliverRunKey asserts it FIRST —
   * every caller inherits the gate) AND pre-mint by the lifecycle (AC1). */
  target: string;
  keyMaterial: string;
  gatewayUrl: string;
  requestId: string;
  /** Optional run identity for the deliver event line (lifecycle caller). */
  runId?: string;
}

export interface RunMemoryKeyLifecycleInput {
  runId: string;
  banks: string[];
  ttlMs: number;
  /** Required at the type (lifecycle callers pin it — reads never widen);
   * an omitted-at-runtime target resolves to MEMGATE_ENV_FILE (F-025). */
  target: string;
  gatewayUrl: string;
  requestId: string;
  /** The live-key window (review round 4): invoked after delivery, BEFORE
   * capture/revoke — the delivered key verifies OK for its duration and is
   * dead by the time the lifecycle resolves. A fault here compensates
   * (revoke+verify) BEFORE the original error rethrows (INV-MG-2). Consume the
   * key by reading `target` (the delivered env file) — mint's return stays
   * the only plaintext handoff, and the window emits nothing (AC1's event
   * sequence is untouched). */
  run?: (() => void) | (() => Promise<void>);
}

export interface RevokeTokenInput {
  tokenId: string;
  requestId: string;
}

export interface MemgatePrincipal {
  kind: "per-run" | "agent";
  tokenId: string;
  banks: string[];
  verbs: string[];
  expiresAtMs: number | null;
  runId?: string;
  consumerClass?: "host" | "bot";
}

export interface VerifyRequestInput {
  authHeader: string | undefined;
  method: string;
  path: string;
  requestId: string;
}

/** ttlRemainingMs rides the result ONLY on the `expired` arm — absent, never 0. */
export type MemgateVerifyResult =
  | { ok: true; principal: MemgatePrincipal }
  | { ok: false; reason: MemgateRefusalReason; ttlRemainingMs?: number };

export interface GrantAgentTokenInput {
  /** Required — a grant that cannot name its class is a type error AND a refusal. */
  consumerClass: "host" | "bot";
  banks: string[];
  verbs: string[];
  requestId: string;
  /** Optional admin-supplied expiry (F-006) — validated positive integer,
   * persisted in claims_json, enforced at verify; absent = revocation-bound. */
  expiresAtMs?: number;
  /** Optional admin label (F-025) — persisted in claims_json for audit correlation. */
  name?: string;
}

export interface GrantedAgentToken {
  /** The ONLY plaintext sink — "mgat." + base64url(claims) + "." + base64url(HMAC). */
  token: string;
  tokenId: string;
}
