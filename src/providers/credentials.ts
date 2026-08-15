/**
 * Per-run credential lifecycle (DF2.3) — mint, cap, deliver, revoke,
 * verify-against-list.
 *
 * Lifted from inkwell's create.just / fill.just / teardown.just / reap.just
 * (R4 §3.1). Those justfiles shipped unrun upstream, so every MEASURED claim
 * they encode is re-proven here by executable tests, and every UNVERIFIED one
 * (list pagination) fails closed instead of being assumed.
 *
 * Order is the design (create.just:8-14, teardown.just:8-11): the record and
 * VM already exist (DF2.1's createRun), the key is minted last, spend is read
 * before the DELETE, and revocation is proven against the authoritative key
 * list — never the single-key endpoint, which returns 200 for dead keys
 * (teardown.just:179-180, MEASURED).
 *
 * The record is deliberately left OPEN on every path: closure is DF2.5
 * teardown's last step.
 */

import { closeSync, mkdtempSync, openSync, readFileSync, rmSync, statSync, unlinkSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

import { log, newRequestId } from "../swarmclaw/log.ts";
import type { ProviderDriver } from "./driver.ts";
import type { RunRecordStore } from "./run-record.ts";

/** Provider-side backstop cap. DF3.6's `loadResidentBounds` asserts `residentSpendCeilingMicros < runBudgetCapMicros ≤ defaultKeyCapMicroUsd` against this value. */
export const defaultKeyCapMicroUsd = 50_000_000;

/** Load-bearing (reap.just:60-61): the only thing distinguishing managed keys from the operator's personal ones. */
export const SBX_KEY_PREFIX = "sbx-";

/** Fixed delivery contract — DF2.2's setup gate and the pi runtime read exactly this. */
export const KEY_ENV_FILE = "/home/agent/app/.env";
export const KEY_ENV_VAR = "OPENROUTER_API_KEY";

const MICRO_PER_USD = 1_000_000;
const REQUEST_TIMEOUT_MS = 15_000;
const MAX_TRANSPORT_RETRIES = 2;
const RETRY_BACKOFF_MS = 100;
/** Verification lists at most 20 pages before failing closed (list-unverified). */
export const MAX_VERIFY_PAGES = 20;

/** DD-9: conversion happens ONLY at this HTTP boundary. */
function usdToMicros(usd: number): number {
  return Math.round(usd * MICRO_PER_USD);
}

function microsToUsd(micros: number): number {
  return micros / MICRO_PER_USD;
}

export class CredentialLifecycleError extends Error {
  /** Machine-readable failure class; also the `code` in every log line. */
  readonly code: string;
  /** The literal next command, secrets referenced by env-var NAME, never expanded. */
  readonly remediation: string;

  constructor(code: string, message: string, remediation: string) {
    super(message);
    this.name = "CredentialLifecycleError";
    this.code = code;
    this.remediation = remediation;
  }
}

export interface KeyEntry {
  hash: string;
  name: string;
  usageUsd: number;
}

/**
 * The provider key API seam. Tests drive FakeKeyApi; production drives
 * OpenRouter via `openRouterKeyApi()`. `listAllKeys` either follows pages to
 * exhaustion or reports `truncated: true` — absence is never inferred from a
 * partial page.
 */
export interface KeyApi {
  createKey(name: string, limitUsd: number): Promise<{
    key: string;
    hash: string;
    limitUsd: number | null;
    usageUsd: number;
  }>;
  /**
   * Entry by hash from the authoritative list. `truncated` is reported
   * separately from `entry === null` — "not found" and "cannot know" are
   * different facts, and every guard built on this (prefix re-assert, spend
   * capture) must fail closed on the latter, never treat it as absence.
   */
  getKeyEntry(hash: string, maxPages?: number): Promise<{ entry: KeyEntry | null; truncated: boolean }>;
  listAllKeys(maxPages: number): Promise<{ entries: KeyEntry[]; truncated: boolean }>;
  /** Returns the HTTP status: 2xx revoked, 404 already-gone, else failure. */
  deleteKey(hash: string): Promise<number>;
}

export interface CredentialDeps {
  keyApi: KeyApi;
  driver: ProviderDriver;
  store: RunRecordStore;
  /** Propagated from the dispatch that created the run record (§5.2). */
  requestId?: string;
  /**
   * Effective per-mint cap. DF2.8 hands `min(defaultKeyCapMicroUsd,
   * remainingMicroUsd)`; a run near its issue cap legitimately mints below
   * every configured ceiling, so no ordering is re-asserted here (DF3.6 owns it).
   */
  capMicroUsd?: number;
  /**
   * Delivery target. Production uses the fixed `KEY_ENV_FILE` contract; the
   * fake driver's boxes are plain host directories, so its tests override with
   * a box-relative path. // ponytail: knob exists only for the fake substrate
   */
  envFile?: string;
}

// ─── observability ───────────────────────────────────────────────────────────

interface StepContext {
  requestId: string;
  runId: string | null;
  keyHash?: string;
}

function keyHashPrefix(hash: string | undefined): string | null {
  return hash ? hash.slice(0, 8) : null; // first 8 chars of the HASH, never the key
}

async function timed<T>(ctx: StepContext, step: string, fn: () => Promise<T>): Promise<T> {
  const started = Date.now();
  try {
    const result = await fn();
    const durationMs = Date.now() - started;
    log({
      requestId: ctx.requestId,
      operation: `credential.${step}`,
      agentId: null,
      timestamp: new Date().toISOString(),
      duration: durationMs,
      status: "ok",
      runId: ctx.runId,
      step,
      keyHashPrefix: keyHashPrefix(ctx.keyHash),
      durationMs,
      outcome: "ok",
      [`${step}_ms`]: durationMs,
    });
    return result;
  } catch (e) {
    const durationMs = Date.now() - started;
    const err = e as CredentialLifecycleError;
    log({
      requestId: ctx.requestId,
      operation: `credential.${step}`,
      agentId: null,
      timestamp: new Date().toISOString(),
      duration: durationMs,
      status: "error",
      error: { code: err.code ?? "credential_error", message: err.message },
      remediation: err.remediation ?? null, // env-var names only, never expanded
      runId: ctx.runId,
      step,
      keyHashPrefix: keyHashPrefix(ctx.keyHash),
      durationMs,
      outcome: "error",
      [`${step}_ms`]: durationMs,
    });
    throw e;
  }
}

// ─── lifecycle steps ─────────────────────────────────────────────────────────

/**
 * Mint `sbx-<runId>` capped at the effective cap. Writes ONLY `keyHash` and
 * `limitMicroUsd` into the DF2.1 record; the plaintext exists in the return
 * value for `deliverRunKey` and nowhere else.
 */
export async function mintRunKey(deps: CredentialDeps, runId: string): Promise<{ key: string; hash: string }> {
  const ctx: StepContext = { requestId: deps.requestId ?? newRequestId(), runId };
  // One live key per run: a re-run after a partial lifecycle must revoke the
  // existing key, not mint a second one whose predecessor stays live and
  // unrecorded — the exact orphan the lifecycle exists to prevent.
  // The full hash in the remediation is deliberate: a keyHash is a non-secret
  // provider-side identifier (DF2.1 persists it in the plaintext run record);
  // the remediation must be a copy-pasteable command, and only the plaintext
  // key is credential material.
  const existing = deps.store.get(runId).keyHash;
  if (existing) {
    throw new CredentialLifecycleError(
      "already-minted",
      `run ${runId} already carries keyHash ${existing.slice(0, 8)}… — revoke it before minting another`,
      `curl -X DELETE https://openrouter.ai/api/v1/keys/${existing} -H 'Authorization: Bearer $OPENROUTER_PROVISIONING_KEY', then re-run`,
    );
  }
  const capMicroUsd = deps.capMicroUsd ?? defaultKeyCapMicroUsd;
  if (!Number.isInteger(capMicroUsd) || capMicroUsd <= 0) {
    throw new CredentialLifecycleError(
      "cap-invalid",
      `capMicroUsd must be a positive integer of micro-dollars, got ${capMicroUsd}`,
      "pass an integer µ$ ceiling (e.g. 50_000_000), or omit it for the default",
    );
  }
  const name = `${SBX_KEY_PREFIX}${runId}`;
  const res = await timed(ctx, "mint", () => deps.keyApi.createKey(name, microsToUsd(capMicroUsd)));
  // Record the mint BEFORE judging the returned cap: if the refusal below
  // fires, a live key exists at the provider, and an UNRECORDED live key is
  // exactly the orphan the lifecycle exists to prevent — with keyHash in the
  // record, revokeRunKey (or a re-run) can still reach it.
  ctx.keyHash = res.hash;
  deps.store.set(runId, { keyHash: res.hash });
  // INV-CRED-1: an uncapped key must never be minted-and-kept. The same
  // refusal covers a malformed limit (NaN/±Infinity/non-positive): a number
  // that cannot be trusted as a cap is treated as no cap at all.
  if (res.limitUsd === null || !Number.isFinite(res.limitUsd) || res.limitUsd <= 0) {
    throw new CredentialLifecycleError(
      "uncapped-key",
      `provider returned an unusable limit for ${name} despite a ${microsToUsd(capMicroUsd)} USD request`,
      `re-run teardown after revoking by hand: curl -X DELETE .../keys/${res.hash} -H 'Authorization: Bearer $OPENROUTER_PROVISIONING_KEY'`,
    );
  }
  deps.store.set(runId, { limitMicroUsd: usdToMicros(res.limitUsd) });
  return { key: res.key, hash: res.hash };
}

/**
 * Deliver the secret over the driver's stdin channel into `KEY_ENV_FILE`
 * (mode 0600). The argv carries only the fixed script — the value never
 * appears in `ps` on either side (fill.just:147-155). Confirmation is by
 * `stat` mode, never by echoing the value back.
 */
function deliverScript(envFile: string): string {
  // Single quotes are safe AND sufficient: assertEnvFileSafe's charset excludes
  // every character (space, quote, $, ...) that could escape them. Belt over
  // braces — the validator is the primary defense, this is the secondary.
  return (
    `umask 077 && mkdir -p "$(dirname '${envFile}')" && cat > '${envFile}' && ` +
    `chmod 600 '${envFile}' && ` +
    // python3 rather than GNU `stat -c`: the fake driver runs on the host, which
    // may be macOS (BSD stat has no -c); inside a real box either works.
    `python3 -c 'import os,sys; print(oct(os.stat(sys.argv[1]).st_mode)[-3:])' '${envFile}'`
  );
}

/**
 * The delivery target becomes part of a `sh -c` script, so it is validated
 * against a strict path grammar (charset allow-list, no `..` segments, not
 * empty) BEFORE interpolation — a caller-supplied `envFile` carrying shell
 * metacharacters must fail closed here, never reach the box.
 */
function assertEnvFileSafe(envFile: string): void {
  const wellFormed = /^[A-Za-z0-9._/-]+$/.test(envFile) && envFile.length > 0;
  const noTraversal = envFile
    .split("/")
    .every((segment) => segment !== "..");
  if (!wellFormed || !noTraversal) {
    throw new CredentialLifecycleError(
      "env-file-invalid",
      `envFile ${JSON.stringify(envFile)} is not a plain path (charset [A-Za-z0-9._/-], no ".." segments) — refusing to build a shell script from it`,
      "pass an absolute in-box path or a box-relative path without shell metacharacters",
    );
  }
}

export async function deliverRunKey(deps: CredentialDeps, vm: string, key: string): Promise<void> {
  const ctx: StepContext = { requestId: deps.requestId ?? newRequestId(), runId: null };
  const envFile = deps.envFile ?? KEY_ENV_FILE;
  assertEnvFileSafe(envFile);
  const stdin = `${KEY_ENV_VAR}=${key}\n`;
  const res = await timed(ctx, "deliver", () => deps.driver.exec(vm, ["sh", "-c", deliverScript(envFile)], stdin));
  const mode = res.stdout.trim();
  if (res.exitCode !== 0 || mode !== "600") {
    throw new CredentialLifecycleError(
      "delivery-failed",
      `key delivery to ${vm}:${envFile} failed (exit ${res.exitCode}, mode ${mode || "unknown"})`,
      "inspect the box by hand, then re-run teardown for the run",
    );
  }
}

/**
 * Read usage for the run's key BEFORE anything is destroyed — after the DELETE
 * the number is unrecoverable (teardown.just:73-100). Usage is read from the
 * authoritative list entry, in dollars; stored as integer µ$ (DD-9).
 */
export async function captureSpend(deps: CredentialDeps, runId: string): Promise<number> {
  const ctx: StepContext = { requestId: deps.requestId ?? newRequestId(), runId };
  const rec = deps.store.get(runId);
  if (!rec.keyHash) return 0; // nothing was ever minted for this run
  ctx.keyHash = rec.keyHash;
  const { entry, truncated } = await timed(ctx, "capture_spend", () =>
    deps.keyApi.getKeyEntry(rec.keyHash as string, MAX_VERIFY_PAGES),
  );
  if (truncated) {
    // Recording 0 here would be an authoritative-looking lie: the run's true
    // spend is unrecoverable after the DELETE, so an unenumerable list is a
    // hard failure, never a zero.
    throw new CredentialLifecycleError(
      "list-unverified",
      `could not enumerate the provider key list to read spend for run ${runId} — refusing to record 0`,
      `re-list by hand with paging: curl 'https://openrouter.ai/api/v1/keys?offset=0' -H 'Authorization: Bearer $OPENROUTER_PROVISIONING_KEY'`,
    );
  }
  if (entry === null) {
    // The key is absent from a fully-enumerated list (revoked out-of-band): its
    // usage is unobservable, and recording 0 here would be an authoritative-
    // looking lie. Return the last stored spend untouched.
    return rec.spendMicroUsd ?? 0;
  }
  const spendMicroUsd = usdToMicros(entry.usageUsd);
  deps.store.set(runId, { spendMicroUsd });
  return spendMicroUsd;
}

/**
 * Re-assert the `sbx-` prefix at the point of deletion (reap.just:106-110 —
 * a bug upstream must not reach a personal key), then issue the DELETE.
 * A 404 is NOT revocation — it is confirmed (or refuted) by `verifyRevoked`.
 */
export async function revokeRunKey(deps: CredentialDeps, runId: string): Promise<"revoked" | "already-gone" | "none"> {
  const ctx: StepContext = { requestId: deps.requestId ?? newRequestId(), runId };
  const rec = deps.store.get(runId);
  if (!rec.keyHash) return "none"; // no key was ever minted — nothing to revoke
  ctx.keyHash = rec.keyHash;
  return revokeHash(deps, ctx, rec.keyHash);
}

/**
 * Record-free variant for DF2.6's orphan sweep: same DELETE → re-list →
 * assert-absent gate against a hash alone. Writes no record, captures no spend.
 */
export async function revokeAndVerify(deps: CredentialDeps, keyHash: string): Promise<void> {
  const ctx: StepContext = { requestId: deps.requestId ?? newRequestId(), runId: null, keyHash };
  await revokeHash(deps, ctx, keyHash);
  await verifyHash(deps, ctx, keyHash);
}

async function revokeHash(
  deps: CredentialDeps,
  ctx: StepContext,
  keyHash: string,
): Promise<"revoked" | "already-gone"> {
  return timed(ctx, "revoke", async () => {
    // INV-CRED-6: prefix re-asserted immediately before the DELETE. An
    // unenumerable list disarms the guard — that is a refusal, not a skip.
    const { entry, truncated } = await deps.keyApi.getKeyEntry(keyHash, MAX_VERIFY_PAGES);
    if (truncated) {
      throw new CredentialLifecycleError(
        "list-unverified",
        `could not enumerate the provider key list before deletion — the ${SBX_KEY_PREFIX} prefix defense cannot run, refusing to delete ${keyHash.slice(0, 8)}…`,
        `re-list by hand with paging: curl 'https://openrouter.ai/api/v1/keys?offset=0' -H 'Authorization: Bearer $OPENROUTER_PROVISIONING_KEY'`,
      );
    }
    if (entry && !entry.name.startsWith(SBX_KEY_PREFIX)) {
      throw new CredentialLifecycleError(
        "prefix-refused",
        `refusing to delete key ${keyHash.slice(0, 8)}…: name "${entry.name}" lacks the ${SBX_KEY_PREFIX} prefix`,
        "verify the hash by hand against the provider console before deleting anything",
      );
    }
    const status = await deps.keyApi.deleteKey(keyHash);
    if (status >= 200 && status < 300) return "revoked";
    if (status === 404) return "already-gone";
    throw new CredentialLifecycleError(
      "revoke-failed",
      `DELETE /keys/${keyHash} returned ${status} — the key may still be live; VM untouched, record left open`,
      `curl -X DELETE https://openrouter.ai/api/v1/keys/${keyHash} -H 'Authorization: Bearer $OPENROUTER_PROVISIONING_KEY'`,
    );
  });
}

/**
 * Prove revocation against the authoritative key LIST. The single-key
 * endpoint returns 200 for dead keys (teardown.just:179-180, MEASURED) and
 * must never gate this. An unenumerable list fails closed.
 */
export async function verifyRevoked(deps: CredentialDeps, runId: string): Promise<void> {
  const rec = deps.store.get(runId);
  if (!rec.keyHash) return;
  const ctx: StepContext = { requestId: deps.requestId ?? newRequestId(), runId, keyHash: rec.keyHash };
  await verifyHash(deps, ctx, rec.keyHash);
}

async function verifyHash(deps: CredentialDeps, ctx: StepContext, keyHash: string): Promise<void> {
  await timed(ctx, "verify", async () => {
    const { entries, truncated } = await deps.keyApi.listAllKeys(MAX_VERIFY_PAGES);
    if (truncated) {
      // AC4: absence is never inferred from a truncated page
      throw new CredentialLifecycleError(
        "list-unverified",
        `could not enumerate the provider key list within ${MAX_VERIFY_PAGES} pages — revocation UNVERIFIED`,
        `re-list by hand with paging: curl 'https://openrouter.ai/api/v1/keys?offset=0' -H 'Authorization: Bearer $OPENROUTER_PROVISIONING_KEY'`,
      );
    }
    if (entries.some((k) => k.hash === keyHash)) {
      throw new CredentialLifecycleError(
        "still-listed",
        `key ${keyHash.slice(0, 8)}… is still present in the provider key list — it is LIVE`,
        `curl -X DELETE https://openrouter.ai/api/v1/keys/${keyHash} -H 'Authorization: Bearer $OPENROUTER_PROVISIONING_KEY'`,
      );
    }
  });
}

/**
 * One ordered lifecycle against an existing DF2.1 run record + VM:
 * mint → deliver → capture spend → revoke → verify. Leaves the record OPEN —
 * closure is DF2.5 teardown's last step — and never destroys the VM.
 */
export async function runCredentialLifecycle(deps: CredentialDeps, runId: string): Promise<void> {
  const rec = deps.store.get(runId);
  if (!rec.vmName) {
    throw new CredentialLifecycleError(
      "no-vm",
      `run ${runId} has no VM — ordering is record → VM → key (create.just:8-14); refusing to mint a key with no box to spend it`,
      `re-run the create phase for ${runId} before minting`,
    );
  }
  // Validate the delivery target BEFORE minting: it is pure config checking,
  // so a bad envFile must fail while no key exists, not after one is live.
  assertEnvFileSafe(deps.envFile ?? KEY_ENV_FILE);
  const minted = await mintRunKey(deps, runId);
  try {
    await deliverRunKey(deps, rec.vmName, minted.key);
  } catch (e) {
    // A minted key must never outlive a failed delivery: the mint and revoke
    // guarantees must bracket the unhappy path too, or a spend-capable key is
    // stranded at the provider with nothing to revoke it. Best-effort — the
    // delivery error remains the reported failure.
    try {
      await revokeAndVerify(deps, minted.hash);
    } catch {
      // revokeAndVerify's own remediation is lost here; the record still
      // carries keyHash, so DF2.6's orphan sweep or a manual re-run reaches it.
    }
    throw e;
  }
  await captureSpend(deps, runId);
  await revokeRunKey(deps, runId);
  await verifyRevoked(deps, runId);
}

// ─── OpenRouter production client ────────────────────────────────────────────

export interface OpenRouterKeyApiOptions {
  baseUrl?: string;
  /** Env var holding the provisioning (management) key. Host-only (INV-CRED-2). */
  provisioningKeyEnv?: string;
}

// The server's default page size is NOT assumed anywhere: the list walk stops
// only on an empty page (see listAllKeys), so any server-side page size works.

/**
 * Build the production KeyApi. Throws before any VM or record exists when the
 * provisioning key is absent — presence is asserted by env-var NAME only; the
 * value never leaves this closure's fetch headers.
 */
export function openRouterKeyApi(opts: OpenRouterKeyApiOptions = {}): KeyApi {
  const baseUrl = opts.baseUrl ?? "https://openrouter.ai/api/v1";
  const envName = opts.provisioningKeyEnv ?? "OPENROUTER_PROVISIONING_KEY";
  const provisioningKey = process.env[envName];
  if (!provisioningKey) {
    throw new CredentialLifecycleError(
      "provisioning-key-missing",
      `${envName} is not set — cannot mint or revoke run keys; nothing has been created`,
      `set ${envName} in the host environment and re-run`,
    );
  }
  const headers = {
    Authorization: `Bearer ${provisioningKey}`,
    "Content-Type": "application/json",
  };

  /**
   * Transport errors retry (≤2) for idempotent verbs only; a 4xx is a
   * response, never a transport error, and is never retried. POST /keys is
   * deliberately exempt: a timed-out mint may have SUCCEEDED server-side, and
   * retrying would mint a second live key whose predecessor nobody records.
   * A short backoff separates attempts (never after the last) so a blipped
   * provider is not hammered three times in a row.
   */
  async function http(method: string, url: string, body?: string): Promise<Response> {
    const attempts = method === "POST" ? 1 : MAX_TRANSPORT_RETRIES + 1;
    let lastError: unknown;
    for (let attempt = 0; attempt < attempts; attempt++) {
      try {
        return await fetch(url, {
          method,
          headers,
          body,
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
      } catch (e) {
        lastError = e;
      }
      if (attempt + 1 < attempts) {
        await new Promise((resolve) => setTimeout(resolve, RETRY_BACKOFF_MS * (attempt + 1)));
      }
    }
    const detail = lastError instanceof Error ? lastError.message : String(lastError);
    throw new CredentialLifecycleError(
      "transport",
      `${method} ${url} failed after ${attempts} attempt${attempts === 1 ? "" : "s"}: ${detail}`,
      "check network/provider status, then re-run — no state was changed",
    );
  }

  /**
   * Response bodies land in a 0600 temp file shredded on every exit path
   * (create.just:70-79): the mint response contains the plaintext key, so it
   * never sits in an unguarded string that outlives the call.
   */
  async function parseBody(response: Response): Promise<Record<string, unknown>> {
    const text = await response.text();
    const tmpDir = mkdtempSync(join(tmpdir(), "qds-keyapi-"));
    const bodyPath = join(tmpDir, "body.json");
    try {
      const fd = openSync(bodyPath, "w", 0o600);
      try {
        writeSync(fd, text);
      } finally {
        closeSync(fd);
      }
      try {
        return JSON.parse(readFileSync(bodyPath, "utf8")) as Record<string, unknown>;
      } catch {
        // Generic message by design: the body may embed provider echoes of
        // credential material, and a SyntaxError's text is not for logs.
        throw new CredentialLifecycleError(
          "response-unparseable",
          "provider response body was not valid JSON",
          "re-run; if it repeats, inspect the provider console — no state was changed by this call",
        );
      }
    } finally {
      shred(bodyPath);
      rmSync(tmpDir, { recursive: true, force: true });
    }
  }

  /** shred(1)-equivalent: one overwrite pass, then unlink (rm -P's contract). */
  function shred(path: string): void {
    try {
      const size = statSync(path).size;
      // "r+" (not "w"): truncating first would leave a zero-length file behind
      // if the write then failed — an overwrite pass must not destroy before it
      // has something to write over the old bytes with.
      const fd = openSync(path, "r+");
      try {
        writeSync(fd, randomBytes(size));
      } finally {
        closeSync(fd);
      }
    } catch {
      // already gone — unlink below is still attempted
    } finally {
      try {
        unlinkSync(path);
      } catch {
        // a re-run must never fail on an already-removed file
      }
    }
  }

  function requireOk(response: Response, what: string): void {
    if (!(response.status >= 200 && response.status < 300)) {
      throw new CredentialLifecycleError(
        "provider-error",
        `${what} returned ${response.status}`,
        "inspect the provider console, then re-run",
      );
    }
  }

  function keyEntryOf(raw: unknown): KeyEntry {
    const k = (raw ?? {}) as Record<string, unknown>;
    return {
      hash: String(k.hash ?? ""),
      name: String(k.name ?? k.label ?? ""),
      usageUsd: Number(k.usage ?? 0),
    };
  }

  return {
    async createKey(name, limitUsd) {
      const response = await http("POST", `${baseUrl}/keys`, JSON.stringify({ name, limit: limitUsd }));
      requireOk(response, "POST /keys");
      const body = await parseBody(response);
      const data = (body.data ?? {}) as Record<string, unknown>;
      // Observed shape is key at top level, hash under .data — accept either (create.just:146-167).
      const key = body.key ?? data.key;
      const hash = body.hash ?? data.hash;
      if (typeof key !== "string" || typeof hash !== "string") {
        throw new CredentialLifecycleError(
          "mint-malformed",
          "mint response missing key/hash",
          "re-run; if it repeats, inspect the provider console for a half-created key",
        );
      }
      return {
        key,
        hash,
        // null (unlimited) and absent both stay null; numeric strings convert.
        // Note the == — Number(null) is 0, which would masquerade as a real cap.
        limitUsd: data.limit == null ? null : Number(data.limit),
        usageUsd: Number(data.usage ?? 0),
      };
    },

    async listAllKeys(maxPages) {
      const entries: KeyEntry[] = [];
      let offset = 0;
      // Only an EMPTY page proves exhaustion. A short page proves nothing —
      // the server's default page size is undocumented (only `offset` is in
      // the spec), so "50 of an assumed 100" could equally be "all 50 there
      // are". Walking to the empty page costs one extra request and removes
      // the assumption entirely.
      for (let page = 0; page < maxPages; page++) {
        const response = await http("GET", `${baseUrl}/keys?offset=${offset}`);
        requireOk(response, "GET /keys");
        const body = await parseBody(response);
        const data = Array.isArray(body.data) ? body.data : [];
        if (data.length === 0) return { entries, truncated: false };
        entries.push(...data.map(keyEntryOf));
        offset += data.length;
      }
      return { entries, truncated: true };
    },

    async getKeyEntry(hash, maxPages = MAX_VERIFY_PAGES) {
      const { entries, truncated } = await this.listAllKeys(maxPages);
      return { entry: entries.find((k) => k.hash === hash) ?? null, truncated };
    },

    async deleteKey(hash) {
      // revokeAndVerify accepts a caller-supplied hash — encode it so any
      // path-breaking character it carries cannot forge a different endpoint.
      const response = await http("DELETE", `${baseUrl}/keys/${encodeURIComponent(hash)}`);
      return response.status;
    },
  };
}
