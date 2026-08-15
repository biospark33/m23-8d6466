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

import { MAX_VERIFY_PAGES } from "../../../src/providers/credentials.ts";

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
    const hash = createHash("sha256").update(key).digest("hex");
    this.keys.push({
      hash,
      name,
      limitUsd,
      usageUsd: this.opts.usageOnCreateUsd ?? 0,
      deleted: false,
    });
    this.plaintexts.set(hash, key);
    const reportedLimit = this.opts.returnedLimitUsd !== undefined ? this.opts.returnedLimitUsd : limitUsd;
    return { key, hash, limitUsd: reportedLimit, usageUsd: this.opts.usageOnCreateUsd ?? 0 };
  }

  /** Visible list membership: live keys, plus dead ones when the list is stale. */
  private visible(): FakeKey[] {
    return this.keys.filter((k) => !k.deleted || this.opts.staleListAfterDelete === true);
  }

  async listAllKeys(maxPages: number): Promise<{ entries: FakeKey[]; truncated: boolean }> {
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
}
