/**
 * In-memory OpenRouter key-API double (DF2.3).
 *
 * Models the provider behaviours the story pins as measured/UNVERIFIED facts:
 * - the single-key endpoint returns 200 for an already-deleted key
 *   (teardown.just:179-180, MEASURED upstream);
 * - whether GET /keys paginates is UNVERIFIED upstream (reap.just:41-42), so
 *   pagination is fully controllable here (pageSize + maxPages truncation);
 * - DELETE may 404 (already gone), 5xx (hard failure), or "succeed" while the
 *   hash stays listed (the stale-list negative control);
 * - usage may zero out post-delete, proving captureSpend reads BEFORE revoke.
 */

import { createHash, randomBytes } from "node:crypto";

import { CredentialLifecycleError, MAX_VERIFY_PAGES } from "../../../src/providers/credentials.ts";

export interface FakeKey {
  hash: string;
  name: string;
  limitUsd: number | null;
  usageUsd: number;
  deleted: boolean;
}

export interface FakeKeyApiOptions {
  /** Keys per list page. Default 100 (OpenRouter's documented page size). */
  pageSize?: number;
  /** Minted keys start with this usage (dollars) — simulated in-box spend. */
  usageOnCreateUsd?: number;
  /** DELETE zeroes the entry's usage — captureSpend must have read it first. */
  zeroUsageOnDelete?: boolean;
  /** DELETE returns 2xx but the hash stays in the list (stale-list control). */
  staleListAfterDelete?: boolean;
  /** Override the status every DELETE returns, without touching state. */
  deleteStatus?: number;
  /** Override the status createKey fails with (non-2xx mint). */
  createStatus?: number;
  /** Override the limitUsd the mint RESPONSE reports (null ⇒ uncapped refusal). */
  returnedLimitUsd?: number | null;
  /** Override the hash the mint RESPONSE reports (for injection-guard testing). */
  returnedHash?: string;
  /** createKey registers the key server-side, then throws CredentialLifecycleError code "transport". */
  mintTransportErrorAfterCreate?: boolean;
  /** listAllKeys returns truncated=true (pagination budget exhausted). */
  listTruncated?: boolean;
  /** Override the status every chatComplete returns, without touching state. */
  chatStatus?: number;
}

export interface RecordedRequest {
  method: "POST" | "GET" | "DELETE";
  path: string;
  /** Create requests only. */
  name?: string;
  limitUsd?: number;
}

export class FakeKeyApi {
  readonly keys: FakeKey[] = [];
  /** hash -> plaintext key. Test-side only: proves hygiene by scanning it. */
  readonly plaintexts = new Map<string, string>();
  readonly requests: RecordedRequest[] = [];

  private readonly opts: Required<Pick<FakeKeyApiOptions, "pageSize">> & FakeKeyApiOptions;

  constructor(opts: FakeKeyApiOptions = {}) {
    this.opts = { pageSize: 100, ...opts };
  }

  async createKey(
    name: string,
    limitUsd: number,
  ): Promise<{ key: string; hash: string; limitUsd: number | null; usageUsd: number }> {
    this.requests.push({ method: "POST", path: "/keys", name, limitUsd });
    if (this.opts.createStatus !== undefined && this.opts.createStatus >= 400) {
      throw new Error(`fake key api: POST /keys returned ${this.opts.createStatus}`);
    }
    const key = `sk-or-fake-${randomBytes(24).toString("hex")}`;
    const realHash = createHash("sha256").update(key).digest("hex");
    const hash = this.opts.returnedHash ?? realHash;
    this.keys.push({
      hash: realHash, // always store the real hash for deletion/verification
      name,
      limitUsd,
      usageUsd: this.opts.usageOnCreateUsd ?? 0,
      deleted: false,
    });
    this.plaintexts.set(realHash, key);
    const reportedLimit = this.opts.returnedLimitUsd !== undefined ? this.opts.returnedLimitUsd : limitUsd;
    // mintTransportErrorAfterCreate: key exists server-side but transport "timed out"
    if (this.opts.mintTransportErrorAfterCreate === true) {
      throw new CredentialLifecycleError(
        "transport",
        "fake key api: POST /keys timed out after 1 attempt: connection reset",
        "check network/provider status, then re-run — no state was changed",
      );
    }
    return { key, hash, limitUsd: reportedLimit, usageUsd: this.opts.usageOnCreateUsd ?? 0 };
  }

  /** Visible list membership: live keys, plus dead ones when the list is stale. */
  private visible(): FakeKey[] {
    return this.keys.filter((k) => !k.deleted || this.opts.staleListAfterDelete === true);
  }

  async listAllKeys(maxPages: number): Promise<{ entries: FakeKey[]; truncated: boolean }> {
    if (this.opts.listTruncated === true) {
      return { entries: this.visible(), truncated: true };
    }
    const all = this.visible();
    const pageSize = Math.max(1, this.opts.pageSize ?? 100);
    // Mirror production exactly: exhaustion is proven ONLY by an empty page
    // fetched within the budget. Data needing exactly maxPages full pages
    // leaves no budget for that empty proof page — so it is truncation too,
    // even though every entry "fits". truncated:false requires maxPages-1
    // full pages (or fewer) plus one empty page inside the budget.
    const fullPages = all.length === 0 ? 0 : Math.ceil(all.length / pageSize);
    if (fullPages >= maxPages) {
      return { entries: all.slice(0, maxPages * pageSize), truncated: true };
    }
    return { entries: all, truncated: false };
  }

  async getKeyEntry(
    hash: string,
    maxPages = MAX_VERIFY_PAGES,
  ): Promise<{ entry: FakeKey | null; truncated: boolean }> {
    const { entries, truncated } = await this.listAllKeys(maxPages);
    return { entry: entries.find((k) => k.hash === hash) ?? null, truncated };
  }

  async deleteKey(hash: string): Promise<number> {
    this.requests.push({ method: "DELETE", path: `/keys/${hash}` });
    if (this.opts.deleteStatus !== undefined) return this.opts.deleteStatus;
    const entry = this.keys.find((k) => k.hash === hash);
    if (!entry || entry.deleted) return 404;
    entry.deleted = true;
    if (this.opts.zeroUsageOnDelete) entry.usageUsd = 0;
    return 200;
  }

  /**
   * The MEASURED upstream behaviour: GET /keys/{hash} answers 200 for a key
   * that is already deleted. Provided so tests can prove the implementation
   * gates on the list, never on this endpoint.
   */
  singleKeyEndpointStatus(hash: string): number {
    return this.keys.some((k) => k.hash === hash) ? 200 : 404;
  }

  /** Test helper: simulate the box spending through the run key. */
  setUsage(hash: string, usageUsd: number): void {
    const entry = this.keys.find((k) => k.hash === hash);
    if (entry) entry.usageUsd = usageUsd;
  }

  /** Test helper: read current usage for a hash. */
  usageOf(hash: string): number {
    return this.keys.find((k) => k.hash === hash)?.usageUsd ?? 0;
  }

  /**
   * Simulated POST /chat/completions with a RUNTIME key (the demo's host-side
   * re-probe substrate). Two DISTINCT rejection shapes (the demo's classifier
   * accepts both):
   * - HTTP 403 "Key limit exceeded" — the PER-KEY spend-cap refusal, the shape
   *   MEASURED live 2026-08-19. This is the natural answer for a capped key
   *   whose usage has reached its limit.
   * - HTTP 402 "Insufficient credits" — the ACCOUNT-level credits refusal the
   *   provider docs describe; reachable in tests via the chatStatus override.
   * 200 for uncapped or under-limit keys; 401 for unknown or deleted (revoked)
   * keys. The key material itself never appears in the body.
   */
  async chatComplete(key: string): Promise<{ status: number; body: string }> {
    this.requests.push({ method: "POST", path: "/chat/completions" });

    // Forced override mode
    if (this.opts.chatStatus !== undefined) {
      return {
        status: this.opts.chatStatus,
        body: `{"error":{"code":${this.opts.chatStatus},"message":"forced"}}`,
      };
    }

    // Exact-hash match on the presented key: hashing first drops the
    // reverse-scan's silent arbitrary-match on duplicate values. Deleted
    // (revoked) entries are excluded — a revoked key must authenticate as
    // invalid, not as a live key. The lookup itself is a linear scan over a
    // test-sized table — a hash-keyed Map would buy nothing at this scale.
    const presentedHash = createHash("sha256").update(key).digest("hex");
    const foundEntry: FakeKey | null = this.keys.find((k) => !k.deleted && k.hash === presentedHash) ?? null;

    // Unknown or revoked key → 401
    if (!foundEntry) {
      return {
        status: 401,
        body: '{"error":{"code":401,"message":"invalid key"}}',
      };
    }

    // Key found: check limit — refusal is the per-key 403 shape (MEASURED)
    if (foundEntry.limitUsd !== null && foundEntry.usageUsd >= foundEntry.limitUsd) {
      return {
        status: 403,
        body: '{"error":{"message":"Key limit exceeded (total limit)","code":403}}',
      };
    }

    // Uncapped or under-limit → 200
    return {
      status: 200,
      body: '{"choices":[]}',
    };
  }
}
