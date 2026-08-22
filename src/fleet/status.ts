/**
 * DF3.1 Agent C: status verb (C4).
 *
 * Joins store.list() ∪ driver.list() with 30s timeout.
 * Row states per AC4: live, boxMissing, boxUnknown, closed, orphan.
 *
 * FleetError unified: one class in dispatch.ts, re-exported here (C2).
 */
import { SBX_OWNERSHIP_TAG, type ProviderVm } from "../providers/driver.ts";
import type { RunRecord, RunRecordStore } from "../providers/run-record.ts";

export { FleetError } from "./dispatch.ts";
import { assertFleetRunId, FleetError } from "./dispatch.ts";

export interface StatusRow {
  runId: string;
  /**
   * `orphan` is an owned box no record claims — unattributed spend, which is
   * precisely what the documented union exists to surface (it has no record,
   * hence no createdAt: the field is ABSENT and the row sorts first).
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
  /**
   * The record's creation instant. Optional because an `orphan` row has no
   * record to take one from, and only there. A placeholder `""` was worse than
   * an absence: it is a required field a renderer trusts, so
   * `new Date(row.createdAt).toISOString()` threw and `toLocaleString()` printed
   * "Invalid Date" — on the one row class the sort floats to the top for
   * operator attention. Absent forces the consumer to handle the absence.
   */
  createdAt?: string;
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
 * Ownership filter, stated as the policy it actually implements: **untagged ⇒
 * treated as ours**. Only an explicit *other* tag is proof of foreign
 * ownership; a missing tag is no evidence either way and is admitted.
 *
 * Tag EQUALITY is not the test, because exedev's `ls --json` carries no tag
 * field at all (see `ProviderVm.tag`): requiring the tag would classify every
 * real box foreign and report the entire fleet as `boxMissing` — a live box
 * hidden from the operator, the failure this verb exists to prevent. Same
 * fail-safe reading the DF2.6 reaper takes: untagged ⇒ reported, never
 * destroyed.
 *
 * The two costs of that default are real and accepted, because both are
 * over-reporting and the alternative is under-reporting live spend:
 *  - an UNTAGGED foreign VM whose name collides with a run id makes that run
 *    report `live`; and
 *  - on a tag-blind substrate every box in the account is admitted, so every
 *    unclaimed one lands as an `orphan` row.
 * Narrowing this needs the substrate to say whether its list carries tags at
 * all — a driver-interface capability that does not exist today (`ProviderDriver`
 * has no such flag), not a guess made here.
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
 *
 * `StatusDeps.driver` is a structural interface, so "entries that are not VMs"
 * is not hypothetical: any injected or test driver satisfies the type while
 * answering with nameless entries. A nameless entry keyed the Map under
 * `undefined` and reached `statusAll` as an orphan row with no runId, which the
 * comparator then dereferenced. It is dropped here instead — an entry with no
 * name is not a box any verb could act on (teardown targets it BY name).
 */
async function listOwnedBoxes(
  deps: StatusDeps,
  timeoutMs: number,
  name?: string,
): Promise<Map<string, ProviderVm> | null> {
  try {
    const vms = await listWithTimeout(deps.driver, timeoutMs, name);
    // ponytail: last-wins on a duplicate `name`, which hides the earlier box's
    // row. The name IS the join key across records, driver and teardown, so two
    // boxes sharing one is a substrate that has already broken the addressing
    // every verb depends on; carrying `Map<string, ProviderVm[]>` through the
    // record join to report both is the upgrade if a substrate ever allows it.
    return new Map(
      vms
        .filter((v) => typeof v?.name === "string" && v.name.length > 0 && isOwnedVm(v))
        .map((v) => [v.name, v] as const),
    );
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

/**
 * An owned box no record claims: billing with nobody accountable for it.
 *
 * The box name is the run id by construction, so it is the row's identity. No
 * record ⇒ no `requestId` and no `createdAt`: both are omitted deliberately,
 * because there is nothing to join an unclaimed box to and no instant to
 * report (see StatusRow.requestId / StatusRow.createdAt).
 *
 * Shared by both entry points — `statusAll`'s unclaimed-box sweep and
 * `statusRun`'s recordless fallback — so the two can never disagree about what
 * an orphan row looks like.
 */
function orphanRow(vm: ProviderVm): StatusRow {
  return { runId: vm.name, state: "orphan", vmName: vm.name, httpsUrl: vm.httpsUrl };
}

/** Newest-first by createdAt, `runId` breaking ties so the order is total. */
function byCreatedAtDesc(a: StatusRow, b: StatusRow): number {
  // Numeric, never localeCompare: createdAt is an instant, and ICU collation on
  // mixed ISO shapes ("…Z" vs "…+00:00") orders them by text, not by time.
  // Absent or unparseable (orphan rows carry none) sorts first — unowned spend
  // is the row an operator most needs to see.
  const ts = (r: StatusRow): number => {
    const t = r.createdAt === undefined ? Number.NaN : Date.parse(r.createdAt);
    return Number.isNaN(t) ? Number.POSITIVE_INFINITY : t;
  };
  // Two rows that both sort first give `Infinity - Infinity` = NaN, which is
  // falsy and falls through to the tie-break — so the tie-break runs on the
  // rows least likely to have a well-formed runId, and must not throw there.
  // `?? ""` over a declared-string field on purpose: rows are built from a
  // structural driver/store interface, not from a validated type.
  return ts(b) - ts(a) || (a.runId ?? "").localeCompare(b.runId ?? "");
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
      rows.push(orphanRow(vm));
    }
  }

  rows.sort(byCreatedAtDesc);

  return rows;
}

/**
 * Single-run status. Validates runId (path safety), throws typed error only
 * when NEITHER a record nor a box exists for the id.
 *
 * Mutates NOTHING when not found — the driver is read, never written. It is
 * read because the record and the box are separately losable: the box outlives
 * operator record cleanup, a `--dir` mismatch between dispatch and this query,
 * and the crash window `provisionAdmittedRun` documents. `statusAll` already
 * classifies exactly that box as `orphan`; exiting 4 here for the same id would
 * make the one query an operator types when they KNOW the run id deny the
 * existence of a box that is alive and spending.
 *
 * Found records use same join logic as statusAll.
 */
export async function statusRun(deps: StatusDeps, runId: string): Promise<StatusRow> {
  // The store's grammar and length cap, not a local copy — a 400-char id is a
  // path hazard too, and it has to refuse as exit 2, not as an untyped store
  // error. See assertFleetRunId for why this is not re-composed here.
  assertFleetRunId(runId);
  const timeoutMs = resolveTimeoutMs(deps);

  let rec: RunRecord;
  try {
    rec = deps.store.get(runId);
  } catch (e) {
    // Optional chain, not a bare cast: a `throw null` must not become a
    // TypeError in the handler that is supposed to classify it.
    const code = (e as NodeJS.ErrnoException | null)?.code;
    if (code === "ENOENT") {
      // No record is not the same as no box. Ask the substrate under the run id
      // — the name `createRun` gives the box — before denying it exists. A hit
      // is the `orphan` state, i.e. the unattributed spend this verb exists to
      // surface; a list failure is NOT a hit, so it still refuses as 4 rather
      // than inventing a box out of a timeout.
      const boxes = await listOwnedBoxes(deps, timeoutMs, runId);
      const box = boxes?.get(runId);
      if (box !== undefined) return orphanRow(box);
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
