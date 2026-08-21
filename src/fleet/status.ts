/**
 * DF3.1 Agent C: status verb (C4).
 *
 * Joins store.list() ∪ driver.list() with 30s timeout.
 * Row states per AC4: live, boxMissing, boxUnknown, closed.
 *
 * FleetError unified: one class in dispatch.ts, re-exported here (C2).
 */
import type { ProviderVm } from "../providers/driver.ts";
import type { RunRecord, RunRecordStore } from "../providers/run-record.ts";

export { FleetError } from "./dispatch.ts";
import { FleetError } from "./dispatch.ts";

// RUN_ID_RE from run-record.ts — duplicated only until Agent D unifies.
const RUN_ID_RE = /^[a-z0-9][a-z0-9-]*$/;

export interface StatusRow {
  runId: string;
  state: "live" | "boxMissing" | "boxUnknown" | "closed";
  vmName?: string;
  httpsUrl?: string;
  requestId?: string; // Per C4, present in ack but not stored in RunRecord (INV-4-bis)
  createdAt: string;
  closedAt?: string;
  spendMicroUsd?: number;
  limitMicroUsd?: number;
}

export interface StatusDeps {
  driver: { list(name?: string): Promise<ProviderVm[]> };
  store: RunRecordStore;
  listTimeoutMs?: number;
}

/** driver.list() under a cleared-on-completion timeout (story: 30s → boxUnknown). */
async function listWithTimeout(
  driver: StatusDeps["driver"],
  timeoutMs: number,
): Promise<ProviderVm[]> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      driver.list(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("list timeout")), timeoutMs);
      }),
    ]);
  } finally {
    // the losing timer must not linger after the race settles
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * Status: store.list() ∪ driver.list() with 30s timeout.
 *
 * Per C4: boxUnknown only on list failure/timeout; empty list is boxMissing.
 * Output order: newest-first by createdAt desc.
 */
export async function statusAll(deps: StatusDeps): Promise<StatusRow[]> {
  const timeoutMs = deps.listTimeoutMs ?? 30_000;

  const records = deps.store.list();

  // Run driver.list() under timeout, track success
  let vms: ProviderVm[] = [];
  let listOk = false;

  try {
    vms = await listWithTimeout(deps.driver, timeoutMs);
    listOk = true;
  } catch {
    // Timeout or throw → listOk stays false → boxUnknown for all
  }

  const vmSet = new Set(vms.map((v) => v.name));

  // Build rows with state derivation per C4
  const rows: StatusRow[] = records.map((rec) => {
    // closedAt → state "closed" (skip driver join)
    if (rec.closedAt) {
      return {
        runId: rec.runId,
        state: "closed",
        vmName: rec.vmName,
        httpsUrl: rec.httpsUrl,
        createdAt: rec.createdAt,
        closedAt: rec.closedAt,
        spendMicroUsd: rec.spendMicroUsd,
        limitMicroUsd: rec.limitMicroUsd,
      };
    }

    // open + vmName unset → boxMissing
    if (!rec.vmName) {
      return {
        runId: rec.runId,
        state: "boxMissing",
        vmName: undefined,
        httpsUrl: rec.httpsUrl,
        createdAt: rec.createdAt,
        spendMicroUsd: rec.spendMicroUsd,
        limitMicroUsd: rec.limitMicroUsd,
      };
    }

    // open + !listOk → boxUnknown
    if (!listOk) {
      return {
        runId: rec.runId,
        state: "boxUnknown",
        vmName: rec.vmName,
        httpsUrl: rec.httpsUrl,
        createdAt: rec.createdAt,
        spendMicroUsd: rec.spendMicroUsd,
        limitMicroUsd: rec.limitMicroUsd,
      };
    }

    // open + listOk: check if vm in set
    const inSet = vmSet.has(rec.vmName);
    return {
      runId: rec.runId,
      state: inSet ? "live" : "boxMissing",
      vmName: rec.vmName,
      httpsUrl: rec.httpsUrl,
      createdAt: rec.createdAt,
      spendMicroUsd: rec.spendMicroUsd,
      limitMicroUsd: rec.limitMicroUsd,
    };
  });

  // Order: newest-first by createdAt desc
  // Note: store.list() already returns newest-first; assert with sort
  rows.sort((a, b) => b.createdAt.localeCompare(a.createdAt));

  return rows;
}

/**
 * Single-run status. Validates runId (path safety), throws typed error on ENOENT.
 *
 * Mutates NOTHING when not found (no driver calls; per C4: assert in D's tests).
 * Found records use same join logic as statusAll.
 */
export async function statusRun(deps: StatusDeps, runId: string): Promise<StatusRow> {
  // Validate runId against RUN_ID_RE (path safety)
  if (typeof runId !== "string" || !RUN_ID_RE.test(runId)) {
    throw new FleetError(
      2,
      "invalid-run-id",
      `Invalid run ID: ${JSON.stringify(runId)} (must match ${RUN_ID_RE.source})`,
      "Provide a valid run ID matching the hostname grammar",
    );
  }

  let rec: RunRecord;
  try {
    rec = deps.store.get(runId);
  } catch (e) {
    const code = (e as { code?: string }).code;
    if (code === "ENOENT") {
      throw new FleetError(
        4,
        "run-not-found",
        `No run record for ${runId}`,
        "Check the run ID or create the run first",
      );
    }
    throw e;
  }

  // If record is closed, return closed state immediately (no driver call)
  if (rec.closedAt) {
    return {
      runId: rec.runId,
      state: "closed",
      vmName: rec.vmName,
      httpsUrl: rec.httpsUrl,
      createdAt: rec.createdAt,
      closedAt: rec.closedAt,
      spendMicroUsd: rec.spendMicroUsd,
      limitMicroUsd: rec.limitMicroUsd,
    };
  }

  // For open records, use same join logic as statusAll
  // Run driver.list() under timeout once
  const timeoutMs = deps.listTimeoutMs ?? 30_000;
  let vms: ProviderVm[] = [];
  let listOk = false;

  try {
    vms = await listWithTimeout(deps.driver, timeoutMs);
    listOk = true;
  } catch {
    // Timeout or throw → listOk stays false
  }

  const vmSet = new Set(vms.map((v) => v.name));

  // State derivation per C4
  if (!rec.vmName) {
    return {
      runId: rec.runId,
      state: "boxMissing",
      vmName: undefined,
      httpsUrl: rec.httpsUrl,
      createdAt: rec.createdAt,
      spendMicroUsd: rec.spendMicroUsd,
      limitMicroUsd: rec.limitMicroUsd,
    };
  }

  if (!listOk) {
    return {
      runId: rec.runId,
      state: "boxUnknown",
      vmName: rec.vmName,
      httpsUrl: rec.httpsUrl,
      createdAt: rec.createdAt,
      spendMicroUsd: rec.spendMicroUsd,
      limitMicroUsd: rec.limitMicroUsd,
    };
  }

  const inSet = vmSet.has(rec.vmName);
  return {
    runId: rec.runId,
    state: inSet ? "live" : "boxMissing",
    vmName: rec.vmName,
    httpsUrl: rec.httpsUrl,
    createdAt: rec.createdAt,
    spendMicroUsd: rec.spendMicroUsd,
    limitMicroUsd: rec.limitMicroUsd,
  };
}
