/**
 * M2.1 memory gateway — mint / deliver / lifecycle / verify / grant / forward.
 * Mirror of credentials.ts runCredentialLifecycle (:1622-1727) over a gateway-LOCAL
 * mint (HMAC + ledger; ZERO mint network — D4). ANY post-mint fault compensates
 * best-effort BEFORE the ORIGINAL error rethrows (INV-MG-2); deliver-state-write-failed
 * bare-rethrows. INV-MG-5/6: no material in any log/argv/error; memgate-refused
 * `reason` stays the closed 8-member set (F-014).
 */

import { createHmac, randomBytes as nodeRandomBytes } from "node:crypto";
import { dirname } from "node:path";

import { assertDirMode0700, atomicReplaceFile } from "../providers/fs-atomic.ts";
import { MemgateLedger } from "./ledger.ts";
import {
  DEFAULT_KEY_TTL_BACKSTOP_MS, KEY_MATERIAL_REMAINDER_PATTERN, MEMGATE_ADMIN_KEY, MEMGATE_ENV_FILE,
  QDS_KG_GATEWAY_URL, QDS_KG_RECALL_KEY, QDS_MEMGATE_SIGNING_KEY, assertDeliveryConfigSafe, bankOfPath,
  checkGrantVerbs, checkMintScope, emit, emitBestEffort, matchRoute, MemgateError, parseAgentTokenScope,
  parseClaims, parseForwardBody, parseRunKeyScope, refused, resolveCredential, resolveMemgateLedgerPath, sha256Hex,
  stringArrayOf, timingSafeEqualStrings,
  type DeliverRunKeyInput, type GrantAgentTokenInput, type GrantedAgentToken, type MemgateDeps,
  type MemgateDepsOptions, type MemgatePrincipal, type MemgateVerifyResult,
  type MintRunKeyInput, type RevokeTokenInput, type RunKeyScope, type RunMemoryKeyLifecycleInput,
  type VerifyRequestInput,
} from "./schemas.ts";

// Gateway data types live in schemas.ts; re-exported for both import paths.
export type {
  DeliverRunKeyInput, GrantAgentTokenInput, GrantedAgentToken, MemgateClient, MemgateDeps, MemgateDepsOptions,
  MemgatePrincipal, MemgateVerifyResult, MintedRunKey, MintRunKeyInput, RevokeTokenInput,
  RunMemoryKeyLifecycleInput, VerifyRequestInput,
} from "./schemas.ts";

/** Keys asserted PRESENT by env-var NAME BEFORE any ledger open — refusal
 * creates nothing (:1748-1755). F-009: the INJECTED env resolves the ledger too. */
export function memgateDeps(opts: MemgateDepsOptions = {}): MemgateDeps {
  const env = opts.env ?? (process.env as Record<string, string | undefined>);
  const admin = env[MEMGATE_ADMIN_KEY];
  if (admin === undefined || admin === "") {
    throw new MemgateError("admin-key-missing", "MEMGATE_ADMIN_KEY is not set — the gateway refuses to construct before any state change", "export MEMGATE_ADMIN_KEY (the operator admin credential) before constructing the gateway");
  }
  const signing = env[QDS_MEMGATE_SIGNING_KEY];
  if (signing === undefined || signing === "") {
    throw new MemgateError("signing-key-missing", "QDS_MEMGATE_SIGNING_KEY is not set — the gateway refuses to construct before any state change", "export QDS_MEMGATE_SIGNING_KEY (the HMAC key for agent tokens) before constructing the gateway");
  }
  return { // the writable open is HERE — after the key assertions: refusal creates nothing
    ledger: opts.ledger ?? new MemgateLedger(resolveMemgateLedgerPath(opts.ledgerPath, env)),
    client: opts.client, now: opts.now, randomBytes: opts.randomBytes,
    signingKey: signing, adminKey: admin, env, log: opts.log,
    ...(opts.env === undefined ? { embeddedAdmin: true as const } : {}), // R2-F-002 embedded seam
  };
}

function nowMs(deps: MemgateDeps): number { return deps.now !== undefined ? deps.now() : Date.now(); }
function randomOf(deps: MemgateDeps, length: number): Uint8Array {
  return deps.randomBytes !== undefined ? deps.randomBytes(length) : nodeRandomBytes(length);
}
function detail(e: unknown): string { return e instanceof Error ? e.message : String(e); }

/** Admin gate (R2-F-002): env-wired deps compare configured-vs-presented, timing-safe;
 * unwired env refuses UNLESS memgateDeps flagged embeddedAdmin (presented IS configured).
 * Hand-built deps without env fail CLOSED. F-017 falsy guards — "" never authorizes. */
function requireAdmin(deps: MemgateDeps, requestId: string): void {
  const configured = deps.env !== undefined ? deps.env[MEMGATE_ADMIN_KEY] : deps.adminKey;
  const presented = deps.adminKey;
  const ok = (deps.env !== undefined || deps.embeddedAdmin === true)
    && typeof configured === "string" && configured !== "" && typeof presented === "string"
    && presented !== "" && timingSafeEqualStrings(presented, configured);
  if (!ok) {
    emitBestEffort(deps, { event: "memgate-refused", requestId, reason: "admin-auth" });
    throw new MemgateError("admin-auth",
      "the presented admin credential is missing or mismatched (or no configured env is wired) — the operation was refused before any state change",
      `construct the gateway via memgateDeps and present the configured ${MEMGATE_ADMIN_KEY} value as the admin credential for this call`);
  }
}

// --- Mint — gateway-local, zero network (D4); the row IS the record (D1) -----
/** Guards PRE-issuance: admin → TTL backstop FIRST (INV-CAP-1) → finite clock
 * (F-018) → scope + runId grammar (F-019). "mgrun-" + 32B base64url. */
export function mintRunMemoryKey(
  deps: MemgateDeps,
  input: MintRunKeyInput,
): { keyMaterial: string; tokenId: string; expiresAtMs: number } {
  const started = Date.now();
  const { runId, banks, ttlMs, requestId } = input;
  requireAdmin(deps, requestId);
  if (!Number.isInteger(ttlMs) || ttlMs <= 0 || ttlMs > DEFAULT_KEY_TTL_BACKSTOP_MS) {
    emitBestEffort(deps, { event: "memgate-refused", requestId, runId, reason: "mint-invalid-ttl" });
    throw new MemgateError("mint-invalid-ttl",
      `ttlMs ${String(ttlMs)} is not an integer in (0, ${String(DEFAULT_KEY_TTL_BACKSTOP_MS)}] — refused before any key exists`,
      `pass ttlMs between 1 and the DEFAULT_KEY_TTL_BACKSTOP_MS ceiling (${String(DEFAULT_KEY_TTL_BACKSTOP_MS)} ms)`);
  }
  // F-018: NaN expiry binds as NULL — an immortal key; mint-invalid-ttl IS a set member.
  const now = nowMs(deps);
  if (!Number.isFinite(now)) {
    emitBestEffort(deps, { event: "memgate-refused", requestId, runId, reason: "mint-invalid-ttl" });
    throw new MemgateError("mint-invalid-ttl", "the clock returned a non-finite value — a NaN expiry binds as NULL and the key would never expire", "wire deps.now to a finite ms-since-epoch clock");
  }
  try { checkMintScope(runId, banks); } // F-019
  catch (e) {
    emitBestEffort(deps, { requestId, runId, code: e instanceof MemgateError ? e.code : "mint-invalid-scope" }); // F-014
    throw e;
  }
  const keyMaterial = `mgrun-${Buffer.from(randomOf(deps, 32)).toString("base64url")}`;
  const digest = sha256Hex(keyMaterial);
  const expiresAtMs = now + ttlMs;
  const scope: RunKeyScope = { runId, banks, expiresAtMs, verbs: ["recall"] };
  deps.ledger.recordIssuance({
    tokenId: digest, kind: "per-run", digest, claimsJson: JSON.stringify(scope),
    runId, createdAtMs: now, expiresAtMs,
  });
  // F-003: a throwing sink must not strand a row whose material is never returned.
  emitBestEffort(deps, { event: "memgate-mint", requestId, runId, tokenId: digest, mint_ms: Date.now() - started });
  return { keyMaterial, tokenId: digest, expiresAtMs };
}

// --- Deliver — exactly the DD-28.23 pair, KEY_ENV_FILE discipline ------------
/** Grammar gates FIRST (F-007/F-008): target+URL safety and the mgrun- barrier
 * (AC6). The post-write state emit is the ONE strict emit (the seam).
 * Boundary (review round 4): M2.1's write is process-LOCAL — target resolves
 * against THIS process's cwd (the F-025 default "app/.env" included), fs-modes
 * by the repo-wide fs-atomic idiom (parent forced 0700, file 0600). The
 * BOX-routed leg (driver fill into the box HOME) is M2.2's seam; the target
 * grammar is already box-shaped, so M2.2 re-points the write, not the input. */
export function deliverRunKey(deps: MemgateDeps, input: DeliverRunKeyInput): void {
  const { target, keyMaterial, gatewayUrl, requestId } = input;
  const deliveryFailed = (e: unknown): MemgateError => new MemgateError("delivery-failed",
    `key delivery to ${target} failed (${detail(e)})`,
    "fix the delivery target's parent (it must be a writable 0700 directory), then re-run the lifecycle");
  try { assertDeliveryConfigSafe(target, gatewayUrl); }
  catch (e) {
    emitBestEffort(deps, { requestId, runId: input.runId, code: e instanceof MemgateError ? e.code : "env-file-invalid" });
    throw e;
  }
  // R2-F-001: prefix + charset — a base64url remainder cannot inject env entries.
  const rest = keyMaterial.slice("mgrun-".length);
  if (!keyMaterial.startsWith("mgrun-") || !KEY_MATERIAL_REMAINDER_PATTERN.test(rest)) {
    emitBestEffort(deps, { requestId, runId: input.runId, code: "env-file-invalid" });
    throw new MemgateError("env-file-invalid", "keyMaterial is not a per-run key (mgrun- + base64url) — an agent token has NO delivery path into a box (AC6)", "deliver only the keyMaterial returned by mintRunMemoryKey");
  }
  // R2-F-019: the crafted dir-mode refusal escapes INTACT; only fs faults rewrap.
  try { assertDirMode0700(dirname(target), (octal) => new MemgateError(
    "env-file-invalid", `delivery target dir is mode 0${octal}, not 0700`, "deliver into a 0700 directory")); }
  catch (e) { if (e instanceof MemgateError) throw e; throw deliveryFailed(e); }
  try { atomicReplaceFile(target, `${QDS_KG_RECALL_KEY}=${keyMaterial}\n${QDS_KG_GATEWAY_URL}=${gatewayUrl}\n`); }
  catch (e) { throw deliveryFailed(e); }
  try { emit(deps, { event: "memgate-deliver", requestId, runId: input.runId, target }); }
  catch (e) {
    // R2-F-003: the live key's revoke handle rides the error (tokenId IS sha256(material)).
    throw new MemgateError("deliver-state-write-failed",
      `the delivered key is LIVE at ${target} but the post-delivery state emit failed (${detail(e)}) — delivery itself SUCCEEDED`,
      "repair the log sink, then tear the run down normally — the key must NOT be compensated away",
      sha256Hex(keyMaterial));
  }
}

// --- Lifecycle — the runCredentialLifecycle mirror ---------------------------
/** AC1 order: config assert (pre-mint) → mint → deliver in try → catch:
 * deliver-state-write-failed bare-rethrows (NO compensation), else compensate
 * THEN rethrow the ORIGINAL (:1722) → the live-key window (input.run, optional —
 * caller work while the key is usable; a fault here compensates first) →
 * capture (D2) → revoke → verify — the tail under the SAME bracket (F-002):
 * faults compensate first. */
export async function runMemoryKeyLifecycle(
  deps: MemgateDeps,
  input: RunMemoryKeyLifecycleInput,
): Promise<{ tokenId: string; expiresAtMs: number }> {
  const { runId, banks, ttlMs, gatewayUrl, requestId } = input;
  const target = (input.target as string | undefined) ?? MEMGATE_ENV_FILE; // F-025 default target
  // 1. pure config checking — must fail while no key exists, not after.
  try { assertDeliveryConfigSafe(target, gatewayUrl); }
  catch (e) {
    emitBestEffort(deps, { requestId, runId, code: e instanceof MemgateError ? e.code : "env-file-invalid" }); // F-014
    throw e;
  }
  // 2. mint OUTSIDE the try: a mint refusal takes no compensation bracket.
  const minted = mintRunMemoryKey(deps, { runId, banks, ttlMs, requestId });
  // 3-4. deliver; the ONE named case — delivery SUCCEEDED, only the state emit
  // failed — bare-rethrows, never compensated. Everything else: compensate first.
  try {
    deliverRunKey(deps, { target, keyMaterial: minted.keyMaterial, gatewayUrl, requestId, runId });
  } catch (e) {
    if (e instanceof MemgateError && e.code === "deliver-state-write-failed") throw e;
    compensate(deps, minted.tokenId, runId, requestId);
    throw e;
  }
  // 4.5 (review round 4): the live-key window — caller work runs while the
  // delivered key is LIVE, after delivery and BEFORE capture/revoke. A fault
  // here compensates THEN rethrows the ORIGINAL (INV-MG-2) — the same bracket
  // discipline as delivery. Emits nothing: the window's side effects are the
  // caller's, and AC1's exact event sequence is preserved.
  if (input.run !== undefined) {
    try { await input.run(); }
    catch (e) { compensate(deps, minted.tokenId, runId, requestId); throw e; }
  }
  // 5-7. capture → revoke → PROVE under the SAME bracket (F-002): a fault here
  // compensates BEFORE rethrowing — no stranded key.
  try {
    const revokedAtCapture = deps.ledger.isRevoked(minted.tokenId);
    emitBestEffort(deps, { event: "memgate-capture", requestId, runId, tokenId: minted.tokenId, revokedAtCapture });
    revokeAndVerify(deps, minted.tokenId, runId, requestId);
  } catch (e) {
    compensate(deps, minted.tokenId, runId, requestId);
    throw e;
  }
  return { tokenId: minted.tokenId, expiresAtMs: minted.expiresAtMs };
}

/** The compensation bracket body (F-001): best-effort revokeAndVerify; ANY fault
 * inside is swallowed best-effort, so the caller ALWAYS reaches its `throw e`. */
function compensate(deps: MemgateDeps, tokenId: string, runId: string | undefined, requestId: string): void {
  try {
    emitBestEffort(deps, { event: "memgate-compensate", requestId, runId, tokenId });
    revokeAndVerify(deps, tokenId, runId, requestId);
  } catch (compErr) {
    emitBestEffort(deps, {
      event: "memgate-compensation-failed", requestId, runId, tokenId, status: "error",
      error: { code: compErr instanceof MemgateError ? compErr.code : "compensation_failed", message: detail(compErr) },
    });
  }
}

/** Revoke → memgate-revoke → fail-closed isRevoked proof → memgate-verify-revoked
 * (:976-977: the verify read is the proof, never the write's answer). */
function revokeAndVerify(deps: MemgateDeps, tokenId: string, runId: string | undefined, requestId: string): "revoked" | "already-gone" {
  const outcome = deps.ledger.recordRevocation(tokenId, "revoked");
  emitBestEffort(deps, { event: "memgate-revoke", requestId, runId, tokenId });
  const started = Date.now();
  if (!deps.ledger.isRevoked(tokenId)) {
    throw new MemgateError("revoke-unverified", `revocation of ${tokenId} is absent from the revocation set after the write — revocation UNVERIFIED, treat the key as LIVE`, "inspect the ledger named by QDS_MEMGATE_LEDGER, then re-run the revocation");
  }
  emitBestEffort(deps, { event: "memgate-verify-revoked", requestId, runId, tokenId, verify_ms: Date.now() - started });
  return outcome;
}

/** Union mirror of revokeRunKey (:978): never-issued → "none" (NO event), issued+live →
 * "revoked", already-revoked → "already-gone". Admin-gated (AC7). R2-F-015: the row's
 * run_id rides the emits. */
export function revokeRunMemoryKey(deps: MemgateDeps, input: RevokeTokenInput): "revoked" | "already-gone" | "none" {
  requireAdmin(deps, input.requestId);
  const row = deps.ledger.getIssuance(input.tokenId);
  if (row === undefined) return "none";
  if (row.kind !== "per-run") { // R3-BH-3: the F-026 mirror — a sweep must not silently kill the other kind
    emitBestEffort(deps, { requestId: input.requestId, tokenId: input.tokenId, code: "revoke-kind-mismatch" });
    throw new MemgateError("revoke-kind-mismatch", `${input.tokenId} is an agent token — revokeRunMemoryKey refuses everything but per-run keys`, "use revokeAgentToken for agent token ids");
  }
  return revokeAndVerify(deps, input.tokenId, row.run_id ?? undefined, input.requestId);
}

// --- Verify — the closed refusal ladder --------------------------------------
/** Refusal ladder: absent header → no-auth; non-string method/path → scope-verb
 * (F-010); malformed/unknown → no-auth + authOutcome "unknown-key" (D3); claims
 * re-validated through the zod scope schemas (F-013); then revocation FIRST
 * (fail-closed → ledger-unreadable) → revoked → expired (ttl ONLY here, never
 * 0, F-016) → bank → route closure. */
export function verifyRequest(deps: MemgateDeps, input: VerifyRequestInput): MemgateVerifyResult {
  const { authHeader, method, path, requestId } = input;
  if (typeof authHeader !== "string" || authHeader === "") {
    return refused(deps, { requestId, reason: "no-auth" });
  }
  if (typeof method !== "string" || typeof path !== "string") {
    return refused(deps, { requestId, reason: "scope-verb" }); // F-010: closed-set, not a raw TypeError
  }
  const material = authHeader.startsWith("Bearer ") ? authHeader.slice("Bearer ".length).trim() : "";
  let resolved: ReturnType<typeof resolveCredential> = null;
  try { resolved = resolveCredential(deps.signingKey, (tokenId) => deps.ledger.getIssuance(tokenId), material); }
  catch { return refused(deps, { requestId, reason: "ledger-unreadable" }); } // a faulting read is never unknown-key
  if (resolved === null) { // D3: the closed set is NOT widened — authOutcome carries the split
    return refused(deps, { requestId, reason: "no-auth", authOutcome: "unknown-key" });
  }
  const { tokenId, row, claims } = resolved;
  // F-013: claims shape re-proven through the SAME zod schemas mint used — a
  // corrupt-claims row lands here too (claims:null), inside D3's unknown-key.
  const parsed = row.kind === "per-run" ? parseRunKeyScope(claims) : parseAgentTokenScope(claims);
  if (!parsed.success) {
    return refused(deps, { requestId, reason: "no-auth", authOutcome: "unknown-key", tokenId });
  }
  const scope = parsed.data;
  let revoked: boolean;
  try { revoked = deps.ledger.isRevoked(tokenId); }
  catch { return refused(deps, { requestId, reason: "ledger-unreadable", tokenId }); }
  if (revoked) return refused(deps, { requestId, reason: "revoked", tokenId });
  const now = nowMs(deps);
  // R2-F-007: a non-finite clock proves nothing — fail closed, ttl ABSENT.
  if (!Number.isFinite(now)) return refused(deps, { requestId, reason: "expired", tokenId });
  // Expiry (R3-BH-2): rides the zod-VALIDATED claims — agent ceiling (F-006), per-run
  // claims ARE the ceiling. The mint-bound ledger column is a cross-check only: a
  // differing number is corruption → D3 unknown-key; a NULL column → claims win.
  const expiresAtMs = scope.expiresAtMs ?? null;
  if (row.kind === "per-run" && typeof row.expires_at_ms === "number" && row.expires_at_ms !== scope.expiresAtMs) {
    return refused(deps, { requestId, reason: "no-auth", authOutcome: "unknown-key", tokenId });
  }
  if (typeof expiresAtMs === "number" && now >= expiresAtMs) {
    const ttl = expiresAtMs - now;
    return refused(deps, {
      requestId, reason: "expired", tokenId,
      ...(ttl !== 0 ? { ttlRemainingMs: ttl } : {}), // F-016: 0 → absent; negative stays (test-pinned)
    });
  }
  const banks: string[] = scope.banks;
  const verbs: string[] = scope.verbs;
  const bankId = bankOfPath(path);
  if (bankId !== undefined && !banks.includes(bankId)) {
    return refused(deps, { requestId, reason: "scope-bank", tokenId, runId: row.run_id ?? undefined });
  }
  const route = matchRoute(method, path);
  if (route === null || !verbs.includes(route.verb)) {
    return refused(deps, { requestId, reason: "scope-verb", tokenId, runId: row.run_id ?? undefined });
  }
  const principal: MemgatePrincipal = { kind: row.kind, tokenId, banks, verbs, expiresAtMs };
  if ("runId" in scope) principal.runId = scope.runId;
  if ("consumerClass" in scope) principal.consumerClass = scope.consumerClass;
  return { ok: true, principal };
}

// --- Agent tokens — closed vocabulary, two exhaustive grant classes (D-vocab) -
/** Admin-gated grant; typed refusals: consumer-class-required → verb-outside-vocabulary/
 * verb-outside-class (recall is in NO class) → scope-invalid (banks 1-64 BankId;
 * F-006/F-025 ride the same zod parse). */
export function grantAgentToken(deps: MemgateDeps, input: GrantAgentTokenInput): GrantedAgentToken {
  const { requestId } = input;
  requireAdmin(deps, requestId);
  // E4: the finite-clock gate precedes any state (F-018/R2-F-007 mirror) — a NaN/±Inf
  // clock must fail as a typed clock refusal, not as a mislabeled ledger-unwritable.
  const now = nowMs(deps);
  if (!Number.isFinite(now)) {
    emitBestEffort(deps, { requestId, code: "clock-non-finite" });
    throw new MemgateError("clock-non-finite", `the clock returned ${String(now)} — expiry cannot be proven, the grant refuses`, "wire deps.now to a finite ms-since-epoch clock");
  }
  const grantClass = input.consumerClass === "host" || input.consumerClass === "bot" ? input.consumerClass : undefined;
  if (grantClass === undefined) {
    throw new MemgateError("grant-consumer-class-required", "consumerClass is required on every agent grant — a token that cannot name its consumer class is refused", 'pass consumerClass "host" or "bot"');
  }
  const signingKey = deps.signingKey;
  if (!signingKey) { // F-017: falsy — HMAC under "" is forgeable
    throw new MemgateError("signing-key-missing",
      "no signing key is wired into this gateway — agent tokens cannot be granted",
      "construct the gateway via memgateDeps so QDS_MEMGATE_SIGNING_KEY is asserted");
  }
  const verbs = Array.isArray(input.verbs) ? input.verbs : [];
  try { checkGrantVerbs(verbs, grantClass); } // D-vocab; plain-line + rethrow (F-014)
  catch (e) {
    emitBestEffort(deps, { requestId, code: e instanceof MemgateError ? e.code : "grant-scope-invalid" });
    throw e;
  }
  // R2-F-010: a born-expired grant is a typed admin refusal (plain code line,
  // F-014 — the closed refusal set is untouched); no DOA row ever persists.
  if (typeof input.expiresAtMs === "number" && Number.isInteger(input.expiresAtMs)
    && input.expiresAtMs <= now) {
    emitBestEffort(deps, { requestId, code: "grant-expiry-in-past" });
    throw new MemgateError("grant-expiry-in-past", `expiresAtMs ${String(input.expiresAtMs)} is not in the future — the grant would be dead on arrival at first verify`, "pass an expiresAtMs in ms-since-epoch AFTER the current time, or omit it (revocation-bound)");
  }
  const tokenId = `mgat-${Buffer.from(randomOf(deps, 12)).toString("hex")}`;
  // F-006/F-025: expiresAtMs + name ride the SAME zod parse — no new refusal code.
  const scopeCheck = parseAgentTokenScope({
    tokenId,
    consumerClass: grantClass,
    banks: input.banks,
    verbs,
    ...(input.expiresAtMs !== undefined ? { expiresAtMs: input.expiresAtMs } : {}),
    ...(input.name !== undefined ? { name: input.name } : {}),
  });
  if (!scopeCheck.success) {
    emitBestEffort(deps, { requestId, code: "grant-scope-invalid" });
    throw new MemgateError("grant-scope-invalid",
      "the grant scope is invalid — tokenId is assigned at grant time; banks must be a non-empty BankId array; a present expiresAtMs must be a positive integer and name a 1-256 char label",
      "pass at least one bank id matching [a-z0-9-], a future expiresAtMs in ms, a short name — or omit both optionals");
  }
  const claimsJson = JSON.stringify(scopeCheck.data);
  const sig = createHmac("sha256", signingKey).update(claimsJson, "utf8").digest("base64url");
  const token = `mgat.${Buffer.from(claimsJson, "utf8").toString("base64url")}.${sig}`;
  deps.ledger.recordIssuance({
    tokenId, kind: "agent", digest: sha256Hex(token), claimsJson,
    runId: null, createdAtMs: now, expiresAtMs: null,
  });
  emitBestEffort(deps, { event: "memgate-grant", requestId, tokenId, consumerClass: grantClass }); // F-003
  return { token, tokenId };
}

/** Admin-gated list of LIVE agent-token scopes. Revoked rows are excluded
 * (F-005 — "live" is truthful); a corrupt claims row is SKIPPED, never fatal. */
export function listAgentTokens(deps: MemgateDeps, input: { requestId: string }): Array<{
  tokenId: string; consumerClass: string; banks: string[]; verbs: string[]; createdAtMs: number;
  /** R3-BH-4: the expiry audit fact — null when absent (revocation-bound = immortal until revoked). */
  expiresAtMs: number | null; name: string | undefined;
}> {
  requireAdmin(deps, input.requestId);
  return deps.ledger.listIssued("agent").flatMap((row) => {
    if (deps.ledger.isRevoked(row.token_id)) return []; // live only
    try {
      const claims = parseClaims(row.claims_json);
      return [{
        tokenId: row.token_id, // R2-F-016: the PK — the handle revokeAgentToken looks up
        consumerClass: claims.consumerClass === "host" || claims.consumerClass === "bot" ? claims.consumerClass : "unknown",
        banks: stringArrayOf(claims.banks),
        verbs: stringArrayOf(claims.verbs),
        createdAtMs: row.created_at_ms,
        expiresAtMs: typeof claims.expiresAtMs === "number" ? claims.expiresAtMs : null, // R3-BH-4
        name: typeof claims.name === "string" ? claims.name : undefined,
      }];
    } catch {
      return []; // corrupt row — skipped, never fatal (F-005)
    }
  });
}

/** Admin-gated revoke, kind-checked (F-026): ONLY agent tokens — a per-run
 * tokenId here is a typed refusal, so a "revoke all agent tokens" sweep never
 * silently kills live run keys. Same none/revoked/already-gone union. */
export function revokeAgentToken(deps: MemgateDeps, input: RevokeTokenInput): "revoked" | "already-gone" | "none" {
  requireAdmin(deps, input.requestId);
  const row = deps.ledger.getIssuance(input.tokenId);
  if (row === undefined) return "none";
  if (row.kind !== "agent") {
    emitBestEffort(deps, { requestId: input.requestId, tokenId: input.tokenId, code: "revoke-kind-mismatch" });
    throw new MemgateError("revoke-kind-mismatch", `${input.tokenId} is a per-run key — revokeAgentToken refuses everything but agent tokens`, "use revokeRunMemoryKey for per-run token ids");
  }
  return revokeAndVerify(deps, input.tokenId, undefined, input.requestId);
}

// --- Forward — ONE mapped POST per call, no retries (D4) ----------------------
/** ONE mapped POST through the injected client; the caller verifies FIRST and
 * passes the principal — RE-CHECKED here (F-004): revoked/expired between verify
 * and forward never forwards (read faults fail closed). Bodies strictly validated (F-023);
 * exactly one attempt + best-effort line (F-024). */
export async function forwardScoped(
  deps: MemgateDeps,
  principal: MemgatePrincipal,
  method: string,
  path: string,
  body: unknown,
  requestId: string,
): Promise<unknown> {
  const route = matchRoute(method, path);
  if (route === null || !principal.verbs.includes(route.verb)) {
    emitBestEffort(deps, { event: "memgate-refused", requestId, tokenId: principal.tokenId, reason: "scope-verb" });
    throw new MemgateError("scope-verb", `no route is mapped for ${method} ${path} under this principal's verbs`, "the closed VERB_ROUTES table maps POST recall/reflect/consolidate/retain only");
  }
  if (!principal.banks.includes(route.bankId)) {
    emitBestEffort(deps, { event: "memgate-refused", requestId, tokenId: principal.tokenId, reason: "scope-bank" });
    throw new MemgateError("scope-bank",
      `bank ${route.bankId} is outside this principal's allowlist`,
      "mint a key scoped to the bank, or use a token granted for it");
  }
  // R2-F-014: the fail-closed re-check read fault still gets its audit line.
  let revokedAgain: boolean;
  try { revokedAgain = deps.ledger.isRevoked(principal.tokenId); }
  catch (e) {
    emitBestEffort(deps, { requestId, tokenId: principal.tokenId, code: "ledger-unreadable" });
    throw e;
  }
  if (revokedAgain) {
    emitBestEffort(deps, { event: "memgate-refused", requestId, tokenId: principal.tokenId, reason: "revoked" });
    throw new MemgateError("revoked",
      `${principal.tokenId} was revoked — verify-then-forward is not verify-once-forward-forever`,
      "re-verify the request; mint or grant afresh if the revocation was intended");
  }
  const now = nowMs(deps);
  // R2-F-007: a non-finite clock proves nothing about expiry — fail closed,
  // ttlRemainingMs ABSENT (no -Infinity/null in the line). R3-BH-2: principal
  // expiry is claims-validated at verify, so a per-run null here is impossible.
  if (!Number.isFinite(now)) {
    emitBestEffort(deps, { event: "memgate-refused", requestId, tokenId: principal.tokenId, reason: "expired" });
    throw new MemgateError("expired",
      "the clock returned a non-finite value — expiry cannot be proven, the forward refuses",
      "wire deps.now to a finite ms-since-epoch clock");
  }
  if (typeof principal.expiresAtMs === "number" && now >= principal.expiresAtMs) {
    const ttl = principal.expiresAtMs - now;
    emitBestEffort(deps, {
      event: "memgate-refused", requestId, tokenId: principal.tokenId, reason: "expired",
      ...(ttl !== 0 ? { ttlRemainingMs: ttl } : {}),
    });
    throw new MemgateError("expired",
      `${principal.tokenId} expired before the forward — the forward refuses`,
      "mint a fresh per-run key or grant a fresh agent token");
  }
  const client = deps.client;
  if (client === undefined) {
    emitBestEffort(deps, { requestId, tokenId: principal.tokenId, code: "client-missing" }); // R2-F-014
    throw new MemgateError("client-missing", "no Hindsight client is wired into this gateway — nothing to forward to", "construct the gateway via memgateDeps with a client");
  }
  const started = Date.now();
  let call: ReturnType<typeof parseForwardBody>;
  try { call = parseForwardBody(route.verb, body); } // F-023: strict body validation
  catch (e) {
    emitBestEffort(deps, { // R2-F-014: the body refusal gets its plain audit line
      requestId, tokenId: principal.tokenId,
      code: e instanceof MemgateError ? e.code : "forward-body-invalid",
    });
    throw e;
  }
  let result: unknown;
  try {
    switch (call.verb) {
      case "recall": result = await client.recall(route.bankId, call.args[0], call.args[1]); break;
      case "reflect": result = await client.reflect(route.bankId, call.args[0]); break;
      case "consolidate": result = await client.consolidate(route.bankId, call.args[0]); break;
      case "retain": result = await client.retain(route.bankId, call.args[0], call.args[1]); break;
    }
  } catch (e) {
    // F-024: a transport-level failure is an audit fact — best-effort error
    // line on the SAME registered event, then the original error rethrows.
    emitBestEffort(deps, {
      event: "memgate-forward", requestId, tokenId: principal.tokenId,
      verb: route.verb, bankId: route.bankId, status: "error", forward_ms: Date.now() - started,
      error: { code: e instanceof MemgateError ? e.code : "forward-failed", message: detail(e) },
    });
    throw e;
  }
  emitBestEffort(deps, {
    event: "memgate-forward", requestId, tokenId: principal.tokenId,
    verb: route.verb, bankId: route.bankId, forward_ms: Date.now() - started,
  });
  return result;
}
