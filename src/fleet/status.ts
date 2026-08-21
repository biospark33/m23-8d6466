/**
 * DF3.1 Agent C: status verb (C4).
 *
 * Joins store.list() ∪ driver.list() with 30s timeout.
 * Row states per AC4: live, boxMissing, boxUnknown, closed, orphan.
 *
 * FleetError unified: one class in dispatch.ts, re-exported here (C2).
 */
import { SBX_OWNERSHIP_TAG, type ProviderVm } from "../providers/driver.ts";
import { RUN_ID_MAX, RUN_ID_RE, type RunRecord, type RunRecordStore } from "../providers/run-record.ts";

export { FleetError } from "./dispatch.ts";
import { FleetError } from "./dispatch.ts";

export interface StatusRow {
  runId: string;
  /**
   * `orphan` is an owned box no record claims — unattributed spend, which is
   * precisely what the documented union exists to surface (it has no record,
   * hence no createdAt: the field is empty and the row sorts first).
   */
  state: "live" | "boxMissing" | "boxUnknown" | "closed" | "orphan";
  /**
   * INV-4-bis's cross-layer join key, straight off the record — the id that ties
   * this run's dispatch ack, driver lines and record writes together in the log
   * stream. Absent on `orphan` rows and only there: an unclaimed box has no
   * record, so there is nothing to join it to. Optional for that reason alone,
   * not because a record row may omit it.
   */
  requestId?: string;
  vmName?: string;
  httpsUrl?: string;
  /**
   * Set only on a `closed` row whose box the substrate still reports. Teardown
   * destroys before it closes, so a closed record over a live box means the
   * destroy never landed and the box is still billing.
   */
  boxAlive?: boolean;
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

/**
 * Ownership filter. `driver.list()` reports the whole account, so a foreign VM
 * whose name collides with a run id must not make that run report `live`.
 *
 * Tag EQUALITY is not the test: exedev's `ls --json` carries no tag field at
 * all (see `ProviderVm.tag`), so requiring the tag would classify every real
 * box foreign and report the entire fleet as `boxMissing` — a live box hidden
 * from the operator, the failure this verb exists to prevent. Only an explicit
 * *other* tag is proof of foreign ownership. Same fail-safe reading the DF2.6
 * reaper takes: untagged ⇒ reported, never destroyed.
 */
function isOwnedVm(vm: ProviderVm): boolean {
  return vm.tag === undefined || vm.tag === SBX_OWNERSHIP_TAG;
}

/** Story: 30s default. A non-positive value would fire the timer immediately. */
function resolveTimeoutMs(deps: StatusDeps): number {
  const ms = deps.listTimeoutMs ?? 30_000;
  if (!Number.isFinite(ms) || ms <= 0) {
    throw new FleetError(
      2,
      "invalid-list-timeout",
      `listTimeoutMs must be a positive finite number, got ${JSON.stringify(deps.listTimeoutMs)}`,
      "Omit listTimeoutMs for the 30s default, or pass a positive millisecond value",
    );
  }
  return ms;
}

/** driver.list() under a cleared-on-completion timeout (story: 30s → boxUnknown). */
async function listWithTimeout(
  driver: StatusDeps["driver"],
  timeoutMs: number,
  name?: string,
): Promise<ProviderVm[]> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      driver.list(name),
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
 * Owned boxes by name, or `null` when the list failed/timed out (→ boxUnknown).
 *
 * The shaping runs INSIDE the try: a driver that answers with a non-array (or
 * with entries that are not VMs) must degrade to boxUnknown like any other
 * list failure, not throw out of the status verb.
 */
async function listOwnedBoxes(
  deps: StatusDeps,
  timeoutMs: number,
  name?: string,
): Promise<Map<string, ProviderVm> | null> {
  try {
    const vms = await listWithTimeout(deps.driver, timeoutMs, name);
    return new Map(vms.filter(isOwnedVm).map((v) => [v.name, v] as const));
  } catch {
    return null;
  }
}

/**
 * State derivation per C4, shared by both entry points.
 *
 * The box join matches on runId **and** vmName, exactly as `reapRuns` claims:
 * `createRun` names the box after the run id and persists `vmName` only after
 * `driver.create()` returns, so an open record with no `vmName` can still own a
 * live box. Matching on `vmName` alone reports that box missing, which is the
 * INV-1 crash window the record was designed to survive.
 */
function rowForRecord(rec: RunRecord, boxes: Map<string, ProviderVm> | null): StatusRow {
  const names = rec.vmName === undefined ? [rec.runId] : [rec.vmName, rec.runId];
  const box = boxes === null ? undefined : names.map((n) => boxes.get(n)).find((b) => b !== undefined);

  // Every record-backed row is built from `base`, so `requestId` reaches all of
  // them — closed, boxUnknown, boxMissing, live, and both entry points. A field
  // populated on five of six paths is how the last round of this bug started.
  const base = {
    runId: rec.runId,
    requestId: rec.requestId,
    // In the crash window the record has no handle but the box does; the box
    // name is what teardown would target (`rec.vmName ?? runId`).
    vmName: rec.vmName ?? box?.name,
    httpsUrl: rec.httpsUrl,
    createdAt: rec.createdAt,
    spendMicroUsd: rec.spendMicroUsd,
    limitMicroUsd: rec.limitMicroUsd,
  };

  // closedAt → "closed", but the driver still gets consulted: consumers key on
  // the state, and a live box behind a closed record keeps billing silently.
  if (rec.closedAt !== undefined) {
    return {
      ...base,
      state: "closed",
      closedAt: rec.closedAt,
      ...(box === undefined ? {} : { boxAlive: true }),
    };
  }

  // No list ⇒ no evidence either way, for a vmName-less record too (its box may
  // be live under the run id).
  if (boxes === null) return { ...base, state: "boxUnknown" };

  return { ...base, state: box === undefined ? "boxMissing" : "live" };
}

/** Newest-first by createdAt, `runId` breaking ties so the order is total. */
function byCreatedAtDesc(a: StatusRow, b: StatusRow): number {
  // Numeric, never localeCompare: createdAt is an instant, and ICU collation on
  // mixed ISO shapes ("…Z" vs "…+00:00") orders them by text, not by time.
  // Unparseable (orphan rows carry none) sorts first — unowned spend is the row
  // an operator most needs to see.
  const ts = (r: StatusRow): number => {
    const t = Date.parse(r.createdAt);
    return Number.isNaN(t) ? Number.POSITIVE_INFINITY : t;
  };
  return ts(b) - ts(a) || a.runId.localeCompare(b.runId);
}

/**
 * Status: store.list() ∪ driver.list() with 30s timeout.
 *
 * Per C4: boxUnknown only on list failure/timeout; empty list is boxMissing.
 * Output order: newest-first by createdAt desc.
 */
export async function statusAll(deps: StatusDeps): Promise<StatusRow[]> {
  const timeoutMs = resolveTimeoutMs(deps);

  let records: RunRecord[];
  try {
    records = deps.store.list();
  } catch (e) {
    // INV-4 makes list() throw on the FIRST unreadable record — untyped, so one
    // corrupt file would hide the whole fleet behind an exit-1 stack trace.
    throw new FleetError(
      1,
      "record-store-unreadable",
      `Cannot read the run record store: ${(e as Error | null)?.message ?? String(e)}`,
      "Fix or move the record file named in the message, then re-run `fleet status`",
    );
  }

  // Unconditional: the union has to see boxes no record claims, and a closed
  // record's box can still be alive — neither is visible from the records.
  const boxes = await listOwnedBoxes(deps, timeoutMs);

  const rows: StatusRow[] = records.map((rec) => rowForRecord(rec, boxes));

  if (boxes !== null) {
    // Claim by both names, same as reapRuns — including CLOSED records, whose
    // live box is already reported on its own row as closed + boxAlive.
    const claimed = new Set<string>();
    for (const rec of records) {
      claimed.add(rec.runId);
      if (rec.vmName !== undefined) claimed.add(rec.vmName);
    }
    for (const [name, vm] of boxes) {
      if (claimed.has(name)) continue;
      // An owned box no record claims: billing with nobody accountable for it.
      // The box name is the run id by construction, so it is the row's identity.
      // No record ⇒ no requestId: the field is omitted deliberately, because
      // there is nothing to join an unclaimed box to (see StatusRow.requestId).
      rows.push({ runId: name, state: "orphan", vmName: name, httpsUrl: vm.httpsUrl, createdAt: "" });
    }
  }

  rows.sort(byCreatedAtDesc);

  return rows;
}

/**
 * Single-run status. Validates runId (path safety), throws typed error on ENOENT.
 *
 * Mutates NOTHING when not found (no driver calls; per C4: assert in D's tests).
 * Found records use same join logic as statusAll.
 */
export async function statusRun(deps: StatusDeps, runId: string): Promise<StatusRow> {
  // Same grammar AND length cap as assertValidRunId — a 400-char id is a path
  // hazard too, and it has to refuse as exit 2, not as an untyped store error.
  if (
    typeof runId !== "string" ||
    runId.length === 0 ||
    runId.length > RUN_ID_MAX ||
    !RUN_ID_RE.test(runId)
  ) {
    throw new FleetError(
      2,
      "invalid-run-id",
      `Invalid run ID: ${JSON.stringify(runId)} (must match ${RUN_ID_RE.source} and be <= ${RUN_ID_MAX} chars)`,
      "Provide a valid run ID matching the hostname grammar",
    );
  }
  const timeoutMs = resolveTimeoutMs(deps);

  let rec: RunRecord;
  try {
    rec = deps.store.get(runId);
  } catch (e) {
    // Optional chain, not a bare cast: a `throw null` must not become a
    // TypeError in the handler that is supposed to classify it.
    const code = (e as NodeJS.ErrnoException | null)?.code;
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

  // One run, one box: use the driver's own name filter rather than paging the
  // whole fleet. Only when the two candidate names differ (a record whose box
  // was not named after it) does the join need the unfiltered list.
  const filter = rec.vmName === undefined || rec.vmName === rec.runId ? rec.runId : undefined;
  const boxes = await listOwnedBoxes(deps, timeoutMs, filter);

  return rowForRecord(rec, boxes);
}
