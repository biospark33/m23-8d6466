/**
 * Bank provisioner (P0.9) — creates the three Hindsight banks per story
 * Bank ID Resolution (CC-6): `{resolveBankId(repoSlug)}`, `…-dev-meta`, and
 * the fixed `qds-collective`.
 *
 * Surface (b) in the two-source error split (CC-W3): application-layer codes
 * `-32001..-32005` returned as `{ok:false,error:{code,message},requestId}`.
 * P0.9 owns no HTTP listener.
 *
 * Reuses foundation exports (do NOT modify): BankIdSchema, resolveBankId,
 * HindsightClient, HindsightHttpError, error code consts. Reuses P0.7
 * `log()` (CC-9) + `newRequestId()` + `LogEntry`.
 */

import { existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

import { acquireFileLock, isPidDead } from "../lib/file-lock.ts";
import {
  log,
  newRequestId,
  type LogEntry,
} from "../swarmclaw/mcp/stdio-transport.ts";
import {
  BankIdSchema,
  ERR_BANK_COLLISION,
  ERR_BANK_ID_INVALID,
  ERR_HINDSIGHT_UNAVAILABLE,
  ERR_MCP_BRIDGE_NOT_REGISTERED,
  HindsightHttpError,
  resolveBankId,
} from "./index.ts";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Fixed shared cross-project bank id (not derived from any repo slug). */
export const COLLECTIVE_BANK_ID = "qds-collective";

/**
 * Minimal client surface the provisioner touches. Declared as a structural
 * type so tests inject a plain-object mock; the real HindsightClient is
 * structurally compatible (createBank + listBanks).
 */
export interface ProvisionClient {
  createBank(bankId: string): Promise<unknown>;
  listBanks(): Promise<unknown>;
}

/** Bridge probe result — injected so tests mock without touching network. */
export interface BridgeProbe {
  registered: boolean;
  healthy: boolean;
}

// `failed` is used only for the logProvision bankStatus field when
// createBank throws a non-idempotent error (HTTP 500/502/408 etc.) or when
// schema validation rejects the bankId inside createBankIdempotent. The
// top-level ProvisionResult envelope does NOT carry `failed` — failed
// provisions surface via the provisionBanks -32005 error envelope. This
// keeps the success-path type narrow while making the observability log
// honest about what happened.
export type BankStatus = "created" | "exists" | "failed";

export interface ProvisionedBank {
  bankId: string;
  status: BankStatus;
}

export interface ProvisionError {
  code: number;
  message: string;
}

export interface ProvisionOk {
  ok: true;
  banks: ProvisionedBank[];
  requestId: string;
}

/**
 * Error envelope. `code` is OPTIONAL on the `provision_in_progress` path per
 * spec CC-10/INV-HM6: that single-flight envelope is EXACTLY
 * `{ ok:false, error:{ message:"provision_in_progress" }, requestId }` with
 * NO code field. Every other error path carries both code + message.
 */
export interface ProvisionErr {
  ok: false;
  error: { message: string; code?: number };
  requestId: string;
}

export type ProvisionResult = ProvisionOk | ProvisionErr;

export interface ProvisionOptions {
  client: ProvisionClient;
  repoSlug: string;
  requestId?: string;
  bridgeProbe?: BridgeProbe;
  /** Override single-flight lock path (tests use tmpdir). */
  lockPath?: string;
  /** Skip the single-flight lock entirely (tests for the other branches). */
  noLock?: boolean;
}

// ---------------------------------------------------------------------------
// Default bridge probe (used by the CLI when SWARMCLAW_BASE_URL is unset)
// ---------------------------------------------------------------------------

const DEFAULT_BRIDGE_PROBE: BridgeProbe = { registered: true, healthy: true };

// ---------------------------------------------------------------------------
// Lock helpers (INV-HM6 / CC-10). O_EXCL advisory file lock with stale recovery.
// ---------------------------------------------------------------------------

/**
 * Stale-lock threshold: 5 min. Derived from 3 banks × max consolidate timeout
 * (60s) + createBank latency + slop. A lock older than this is treated as
 * orphaned (SIGKILL/crash mid-provision) and recovered.
 */
export const LOCK_STALE_MS = 300_000;

function defaultLockPath(): string {
  return join(homedir(), ".hindsight", "provision.lock");
}

/**
 * Acquire the single-flight provision lock, or null when a live, fresh holder
 * has it (no blocking — a concurrent provisioner returns
 * `provision_in_progress` immediately, per story CC-10's second option).
 *
 * The mechanism — O_EXCL, and the atomic rename-to-claim steal with content
 * re-verification — is `src/lib/file-lock.ts`. What stays here is the POLICY:
 * this lock is stealable on AGE alone (a SIGKILLed provisioner leaves no other
 * trace), on a dead holder, or on a corrupt body.
 */
async function acquireLock(path: string): Promise<(() => void) | null> {
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return acquireFileLock(path, {
    label: "provision lock",
    isStale: ({ ageMs, pid }) =>
      // A corrupt / unparsable pid means the body was never written or was
      // truncated: treat it as stale so one bad file cannot block every
      // provision for LOCK_STALE_MS.
      ageMs >= LOCK_STALE_MS || pid === undefined || isPidDead(pid),
  });
}

// ---------------------------------------------------------------------------
// Bank ID resolution with collision loop (CC-6 + INV-HM6, lines 230, INV-HM6)
// ---------------------------------------------------------------------------

const MAX_SUFFIX = 11; // -2 .. -11 → 10 candidates, plus the base = 11 total

/**
 * Truncate a base bank id so that base + the LONGEST suffix we'll ever
 * append stays within the BankIdSchema cap of 64 chars. Suffixes we use:
 *   - "-2" .. "-11"  (collision loop)  → up to 3 chars ("-11")
 *   - "-dev-meta"    (dev-meta bank)   → 9 chars, joined to repoBankId
 * Worst case: safeBase + "-11" + "-dev-meta" = safeBase + 12 chars. So
 * base ≤ 64 − 12 = 52 guarantees base, suffixed, AND `-dev-meta` variants
 * all stay schema-valid (≤64) even when the collision loop appends "-11".
 */
const MAX_BASE_LEN = 52; // 64 - len("-11") - len("-dev-meta")

function truncateForSuffix(baseId: string): string {
  if (baseId.length <= MAX_BASE_LEN) return baseId;
  // Truncate, then strip a trailing hyphen so we don't emit "foo--11".
  let truncated = baseId.slice(0, MAX_BASE_LEN);
  while (truncated.endsWith("-")) truncated = truncated.slice(0, -1);
  return truncated;
}

/**
 * Resolve the repo bank id (`{resolveBankId}`) against existing banks + the
 * fixed `qds-collective` id. Returns the chosen id, or null if every suffix
 * collides (`-2..-11` all taken, OR every suffix candidate fails BankIdSchema
 * — the latter happens when the base id is already near the 64-char cap and
 * truncation cannot produce a valid suffixed form → -32005 per INV-HM6).
 */
export function resolveRepoBankId(
  baseId: string,
  existing: Set<string>,
): string | null {
  // ALWAYS truncate to the safe-max length first. This guarantees the
  // returned id, AND its `-dev-meta` variant, stay schema-valid even when
  // the base id is already at the 64-char schema cap.
  const safeBase = truncateForSuffix(baseId);
  // Try the (truncated) base as-is first.
  if (
    safeBase !== COLLECTIVE_BANK_ID &&
    BankIdSchema.safeParse(safeBase).success &&
    !existing.has(safeBase)
  ) {
    return safeBase;
  }
  // Base collides → suffix loop.
  for (let n = 2; n <= MAX_SUFFIX; n++) {
    const candidate = `${safeBase}-${n}`;
    if (candidate === COLLECTIVE_BANK_ID) continue;
    if (existing.has(candidate)) continue;
    if (!BankIdSchema.safeParse(candidate).success) continue;
    return candidate;
  }
  return null;
}

/**
 * READ/WRITE-side counterpart of resolveRepoBankId — identifies the bank a
 * PREVIOUS provision call actually created. Nothing persists the provision-time
 * id (the spec's persistence alternative stays unimplemented by design), so the
 * provisioned repo bank is recognised by its family signature: a candidate `c`
 * that exists WITH its `-dev-meta` sibling — the pair only the provisioner
 * creates. Same candidate order as resolveRepoBankId; null when no candidate
 * carries the signature (a bare base without the sibling is a FOREIGN bank —
 * never recalled/written as ours).
 */
export function resolveProvisionedRepoBankId(
  baseId: string,
  existing: Set<string>,
): string | null {
  const safeBase = truncateForSuffix(baseId);
  if (existing.has(safeBase) && existing.has(`${safeBase}-dev-meta`)) {
    return safeBase;
  }
  for (let n = 2; n <= MAX_SUFFIX; n++) {
    const candidate = `${safeBase}-${n}`;
    if (existing.has(candidate) && existing.has(`${candidate}-dev-meta`)) {
      return candidate;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Existing-bank set extraction (defensive — INV-HM5 style narrowing)
// ---------------------------------------------------------------------------

export function extractExistingBankIds(raw: unknown): Set<string> {
  const out = new Set<string>();
  if (raw === null || typeof raw !== "object") return out;
  // Accept {banks:[{bank_id|bankId|id}]}, {banks:[string]}, [string], [{}].
  const root = raw as Record<string, unknown>;
  const arr: unknown = Array.isArray(raw) ? raw : root.banks ?? root.items ?? root.data;
  if (!Array.isArray(arr)) return out;
  for (const entry of arr) {
    if (typeof entry === "string") {
      out.add(entry);
      continue;
    }
    if (entry !== null && typeof entry === "object") {
      const obj = entry as Record<string, unknown>;
      const id = obj.bank_id ?? obj.bankId ?? obj.id;
      if (typeof id === "string") {
        out.add(id);
      } else {
        // Fall back to `name` ONLY when it is itself a schema-valid bank id.
        // A human display name ("My Repo") would otherwise pollute the
        // collision set and force a spurious -2 suffix on first provision.
        const name = obj.name;
        if (typeof name === "string" && BankIdSchema.safeParse(name).success) {
          out.add(name);
        }
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// createBank with idempotent-PUT semantics (409 / "exists" → success)
// ---------------------------------------------------------------------------

async function createBankIdempotent(
  client: ProvisionClient,
  bankId: string,
  requestId: string,
): Promise<BankStatus> {
  const start = Date.now();
  let status: BankStatus = "created";
  let logErr: { code: string; message: string } | undefined;
  try {
    // Defensive: belt-and-suspenders schema check before any PUT. Derived ids
    // are validated at the resolver; an explicit --bank-id from a caller could
    // still slip through (CLI does its own check; this is the last gate).
    // Inside the try so the finally below emits an observability entry for a
    // validation failure (the listBanks-fail fallback can reach us with an
    // edge id that bypassed the -32003 guard in provisionBanks).
    if (!BankIdSchema.safeParse(bankId).success) {
      status = "failed";
      logErr = { code: "schema_invalid", message: `invalid bank_id (schema): ${bankId}` };
      throw new HindsightHttpError(
        422,
        `invalid bank_id (schema): ${bankId}`,
        requestId,
      );
    }
    await client.createBank(bankId);
    status = "created";
    return status;
  } catch (e) {
    if (e instanceof HindsightHttpError) {
      // 409 / 422 conflict, or a body indicating the bank already exists —
      // idempotent success per "re-provisioning existing bank returns
      // existing bank_id" (DoD bullet 1).
      const msg = e.message.toLowerCase();
      // Idempotent-success signal: HTTP 409 (canonical "already exists"), OR a
      // body that explicitly says "already exist(s)". Bare 422 is intentionally
      // NOT treated as idempotent — a real Hindsight 422 is a validation
      // failure (bad shape/field), not a conflict; masking it as "exists"
      // would silently skip bank creation and 404 every later retain. A server
      // that returns 422 for an existing bank is expected to say so in the
      // body (caught by the message match below). Loose substrings like bare
      // "exist"/"already" are also excluded — they match unrelated messages
      // ("field X must exist").
      if (e.status === 409 || msg.includes("already exist")) {
        status = "exists";
        return status;
      }
    }
    status = "failed"; // bank was never created — don't log bankStatus:"created"
    logErr = {
      code: `http_${e instanceof HindsightHttpError ? e.status : "error"}`,
      message: (e as Error).message,
    };
    throw e;
  } finally {
    logProvision(requestId, bankId, Date.now() - start, status, logErr);
  }
}

// ---------------------------------------------------------------------------
// Logging (CC-9)
// ---------------------------------------------------------------------------

function logProvision(
  requestId: string,
  bankId: string,
  durationMs: number,
  status: BankStatus,
  error?: { code: string; message: string },
): void {
  const entry: LogEntry = {
    requestId,
    operation: "provision",
    agentId: null,
    timestamp: new Date().toISOString(),
    duration: durationMs,
    status: error ? "error" : "ok",
    bankId,
    provision_ms: durationMs,
    bankStatus: status,
    ...(error ? { error } : {}),
  };
  log(entry);
}

function envelopeErr(
  code: number,
  message: string,
  requestId: string,
): ProvisionErr {
  return { ok: false, error: { code, message }, requestId };
}

/**
 * Per spec CC-10/INV-HM6 the single-flight "already running" envelope is
 * EXACTLY `{ ok:false, error:{ message:"provision_in_progress" }, requestId }`
 * — NO `code` field. -32005 is reserved for collision-unresolvable only.
 */
function provisionInProgress(requestId: string): ProvisionErr {
  return { ok: false, error: { message: "provision_in_progress" }, requestId };
}

// ---------------------------------------------------------------------------
// provisionBanks — the public entry point
// ---------------------------------------------------------------------------

export async function provisionBanks(opts: ProvisionOptions): Promise<ProvisionResult> {
  const requestId = opts.requestId ?? newRequestId();
  const probe: BridgeProbe = opts.bridgeProbe ?? DEFAULT_BRIDGE_PROBE;

  // AC-4 (-32001): bridge not registered → exit before any bank work.
  if (!probe.registered) {
    return envelopeErr(ERR_MCP_BRIDGE_NOT_REGISTERED, "MCP bridge not registered", requestId);
  }
  // AC-5 (-32002): registered but Hindsight unavailable (/test ok:false).
  if (!probe.healthy) {
    return envelopeErr(ERR_HINDSIGHT_UNAVAILABLE, "Hindsight binary unavailable", requestId);
  }

  // -32003 (INV-HM2): validate the resolved bank id BEFORE any API call.
  // resolveBankId("!!!!") → "" which fails BankIdSchema — short-circuit.
  const resolved = resolveBankId(opts.repoSlug);
  const parsed = BankIdSchema.safeParse(resolved);
  if (!parsed.success) {
    return envelopeErr(ERR_BANK_ID_INVALID, "Invalid bank ID derived from repo slug", requestId);
  }
  const baseId = parsed.data;

  // Single-flight (INV-HM6 / CC-10). Skip when explicitly disabled.
  const lockPath = opts.lockPath ?? defaultLockPath();
  let release: (() => void) | null;
  if (opts.noLock) {
    release = () => {};
  } else {
    // acquireLock can throw on an unwritable lock dir (EACCES/ENOSPC) — wrap
    // it so the CLI emits a structured envelope instead of a raw stack trace
    // escaping the contract.
    try {
      release = await acquireLock(lockPath);
    } catch (e) {
      return envelopeErr(
        ERR_BANK_COLLISION,
        `provision lock unavailable: ${(e as Error).message}`,
        requestId,
      );
    }
  }
  if (release === null) {
    // Fresh lock held by a live process → provision_in_progress (no code).
    return provisionInProgress(requestId);
  }

  try {
    // Fetch existing banks for collision detection (idempotency + -32005).
    // If listBanks fails we CANNOT reliably detect collisions, so we skip the
    // suffix loop entirely and let createBank be the source of truth (a real
    // collision surfaces as 409/422 → idempotent "exists" per DoD bullet 1).
    let existing: Set<string>;
    let listBanksOk = true;
    try {
      const raw = await opts.client.listBanks();
      existing = extractExistingBankIds(raw);
    } catch (e) {
      listBanksOk = false;
      existing = new Set();
      log({
        requestId,
        operation: "provision.listBanks",
        agentId: null,
        timestamp: new Date().toISOString(),
        duration: 0,
        status: "error",
        bankId: "",
        level: "warn",
        message: `listBanks failed; collision-detection skipped (idempotent PUT fallback). error=${(e as Error).message}`,
      });
    }

    // Resolve repo bank id with collision loop. `qds-collective` is always
    // the fixed id and is excluded from the loop (never steal it).
    // When listBanks failed we skip the loop entirely (cannot fabricate
    // collision info) — base id is used as-is.
    let repoBankId: string;
    if (listBanksOk) {
      const resolved_id = resolveRepoBankId(baseId, existing);
      if (resolved_id === null) {
        return envelopeErr(
          ERR_BANK_COLLISION,
          "bank_id_collision_unresolvable",
          requestId,
        );
      }
      repoBankId = resolved_id;
    } else {
      // listBanks failed → no collision loop. Truncate to the safe-max length
      // so the `${repoBankId}-dev-meta` variant stays schema-valid (≤64). Using
      // the untruncated baseId (up to 64 chars) here would make -dev-meta
      // overflow to 73 chars and fail inside createBankIdempotent. A real
      // collision is still caught by the idempotent PUT below.
      repoBankId = truncateForSuffix(baseId);
    }

    const targets: string[] = [repoBankId, `${repoBankId}-dev-meta`, COLLECTIVE_BANK_ID];

    const banks: ProvisionedBank[] = [];
    try {
      for (const bankId of targets) {
        const status = await createBankIdempotent(opts.client, bankId, requestId);
        banks.push({ bankId, status });
      }
    } catch (e) {
      // Non-idempotent createBank error (e.g. HTTP 500/502/408) — emit the
      // -32005 envelope rather than letting the raw HindsightHttpError escape
      // and crash the CLI without a JSON envelope. Lock still releases via
      // the outer finally.
      return envelopeErr(
        ERR_BANK_COLLISION,
        `bank provisioning failed: ${(e as Error).message}`,
        requestId,
      );
    }

    return { ok: true, banks, requestId };
  } finally {
    try {
      release();
    } catch (e) {
      // The lock was age-stolen while we ran, so release() refuses to unlink
      // another holder's file (file-lock.ts). That is a diagnostic, never an
      // outcome: throwing here would discard the `{ok:true, banks}` above and
      // escape raw, exactly what the envelope contract forbids.
      log({
        requestId,
        operation: "provision.release",
        agentId: null,
        timestamp: new Date().toISOString(),
        duration: 0,
        status: "error",
        bankId: "",
        level: "warn",
        message: `provision lock was taken over by another holder; not released here. error=${(e as Error).message}`,
      });
    }
  }
}
