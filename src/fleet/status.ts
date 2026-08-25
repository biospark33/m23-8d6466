/**
 * DF3.1 Agent C: status verb (C4).
 *
 * Joins store.listWithAnomalies() ∪ driver.list() with 30s timeout.
 * Row states per AC4: live, boxMissing, boxUnknown, closed, orphan — plus the
 * two fleet-level rows that describe the listing itself, listUnavailable and
 * recordsSkipped (see FLEET_ROW_ID).
 *
 * FleetError unified: ONE class, in dispatch.ts (C2). Imported here, never
 * re-exported — see the import below.
 */
import { SBX_OWNERSHIP_TAG, type ProviderVm } from "../providers/driver.ts";
import type { RunRecord, RunRecordListing, RunRecordStore } from "../providers/run-record.ts";

import { MAX_REQUEST_ID, MAX_URL, sanitizeLabel } from "./brief-schema.ts";
// NOT re-exported. `FleetError` has ONE owner, `dispatch.ts`, and the barrel
// star-exports both modules — so a re-export here is the same binding reached
// twice through `index.ts`. It resolves today only because the two resolve to
// one symbol; the day `status.ts` declares its own, the barrel has a duplicate
// star export and every consumer of `src/fleet/index.ts` breaks at once. No
// caller imports it from here (the CLI and both test files take it from
// `dispatch.ts`), so the re-export was dead weight on the barrel path.
import { assertFleetRunId, FleetError } from "./dispatch.ts";

export interface StatusRow {
  runId: string;
  /**
   * `orphan` is an owned box no record claims — unattributed spend, which is
   * precisely what the documented union exists to surface (it has no record,
   * hence no createdAt: the field is ABSENT and the row sorts first).
   */
  state: "live" | "boxMissing" | "boxUnknown" | "closed" | "orphan" | "listUnavailable" | "recordsSkipped";
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
   * Tri-state on a `closed` row, and set only there:
   *  - `true`  — the substrate still reports the box. Teardown destroys before
   *    it closes, so a closed record over a live box means the destroy never
   *    landed and the box is still billing.
   *  - `false` — the substrate answered and the box is gone (the normal case).
   *  - ABSENT  — the substrate could not be reached, so nothing is known.
   *
   * `false` and absent were one value until round 4, which meant every list
   * failure silently reported the still-billing case as confirmed-destroyed.
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
  /**
   * Record filenames the listing refused to read (`listWithAnomalies().skipped`),
   * sanitized like every other store-supplied string (a POSIX filename may hold
   * newlines and worse). Present on the `recordsSkipped` row, and on the one
   * `statusRun` row whose verdict those files could contradict — the `orphan`
   * row returned when this run's record is missing while a live box answers to
   * its id. Never anywhere else, and never empty. On every other `statusRun`
   * exit there IS no row to carry it, so the same caveat travels in the
   * run-not-found remediation instead (which names the files when it has them).
   */
  skippedRecords?: string[];
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

/**
 * Cap on a substrate-supplied box name in a row. A run id is `RUN_ID_MAX` long;
 * a foreign box on a tag-blind provider is whatever the account named it.
 */
const MAX_VM_NAME = 128;

/**
 * Cap on a record-supplied timestamp in a row. `assertWellFormed` proves only
 * that the store's value is a string `Date.parse` accepts — parseability is not
 * printability, and a hostile store is one structural interface away (see
 * `safeName`), so the field gets the same two rules as every other
 * record-supplied string before it reaches an operator.
 */
const MAX_TIMESTAMP = 64;

/**
 * Cap on store exception text interpolated into a typed message
 * (`record-store-unreadable`, `record-read-failed`). The producer-side rule
 * `sanitizeLabel`'s docstring states — repair at the producer, never per
 * consumer — applies here too: an exception's `.message` is store-authored
 * text (`malformed run record <name>.json: …`, where `<name>` came from
 * `readdirSync`), and it lands verbatim in the operator-facing envelope. Sized
 * like a diagnostic, not a label: long enough to keep the filename and the
 * failure reason together, short enough that a hostile record body cannot ride
 * the refusal out unbounded.
 */
const MAX_DIAGNOSTIC = 512;

/** The message half of a store exception, under the same two rules as names. */
function safeDiagnostic(e: unknown): string {
  // Optional chain, not a bare cast: a `throw null` must still classify (the
  // same argument statusRun's handler makes) rather than TypeError here.
  return sanitizeLabel((e as Error | null)?.message ?? String(e), MAX_DIAGNOSTIC);
}

/**
 * A substrate-supplied name on its way into a row, under the same two rules
 * `brief-schema.ts` applies to a brief.
 *
 * The brief is the MORE trusted of the two sources and gets both rules; the
 * substrate got neither. A box named `"box\nFLEET teardown ok"` went straight
 * into `orphanRow`'s `runId` interpolation and out to the operator stream, which
 * is the forged log line NO_CONTROL_CHARS exists to stop — and on a tag-blind
 * provider the orphan sweep emits EVERY box in the account (see `isOwnedVm`), so
 * the names are not even the factory's own.
 */
function safeName(name: string): string {
  return sanitizeLabel(name, MAX_VM_NAME);
}

/** `sanitizeLabel` over an optional field, preserving the absence. */
function sanitizeOptional(text: string | undefined, max: number): string | undefined {
  return text === undefined ? undefined : sanitizeLabel(text, max);
}

/**
 * A substrate- or record-supplied URL as a row field, or ABSENT when it carries
 * a credential or a non-https scheme.
 *
 * INV-CRED-1's rule, applied on the way OUT as well as on the way in: the brief
 * schema refuses `https://token@host/…` because userinfo is "a credential by
 * construction", and a provider `httpsUrl` of that shape reached both
 * `orphanRow` and every record-backed row untouched. A row cannot refuse, so the
 * field is OMITTED — `StatusRow.httpsUrl` is already optional, and a missing
 * link is a smaller loss than a token in whatever an operator pastes the status
 * output into. An unparseable URL is dropped for the same reason `hasNoUserinfo`
 * gives: it cannot be shown to be free of one.
 *
 * The scheme is https-only for the same reason `BriefSchema.repoUrl`/`issueUrl`
 * are (`^https:\/\/` there): these rows render as CLICKABLE links in operator
 * output, and `.url()`-style parsing alone admits `javascript:` (script in the
 * operator's page context) and `file:` (local path disclosure) — the outbound
 * arm of the same INV-CRED-1 boundary. `URL.protocol` is normalized lowercase,
 * so `HTTPS://` passes exactly as the brief schema's case-insensitive regex
 * intends.
 */
function safeUrl(url: string | undefined): string | undefined {
  if (url === undefined) return undefined;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:") return undefined;
    if (parsed.username !== "" || parsed.password !== "") return undefined;
  } catch {
    return undefined;
  }
  return sanitizeLabel(url, MAX_URL);
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
  const listing = driver.list(name);
  // The race abandons its loser, and an abandoned promise that later REJECTS
  // surfaces as an unhandled rejection — which kills the process AFTER the
  // caller has already classified the timeout as boxUnknown/null. A wedged
  // substrate answering with an error seconds late must not take `fleet status`
  // down on its way out; this no-op handler pins the loser on BOTH outcomes and
  // is ignored when `listing` wins. (The timer half needs no such pin:
  // `Promise.race` subscribes to every entrant, so its rejection is always
  // observed.)
  void listing.catch(() => {});
  try {
    return await Promise.race([
      listing,
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
 *
 * A NAMED lookup that fails is RETRIED UNFILTERED before it is called a list
 * failure, and that retry is the whole difference between "the substrate
 * answered, nothing matched" and "the substrate could not be asked". On a
 * driver whose named lookup ERRORS for a box that is not there — the ordinary
 * shape of a CLI `ls <name>` exiting non-zero, and exactly what
 * `ExeDevDriver.listWithAnomalies` does with a non-zero `ssh exe.dev ls`
 * — the catch below cannot tell the two apart, so the commonest state in the
 * fleet (a torn-down run) came back from `statusRun` as `boxUnknown`, or on a
 * closed record as "substrate unreachable" with `boxAlive` omitted, while
 * `statusAll` called the same run `boxMissing`/`boxAlive: false` off the
 * unfiltered path. Two entry points, opposite verdicts, and the filtered one is
 * the query an operator types when they already know the id.
 *
 * A REAL listing failure is not downgraded by this: the unfiltered list has to
 * ANSWER for the retry to change the verdict, and if it fails too the result is
 * `null` exactly as before. The cost is one extra call on the failure path
 * only, and a wider map than the caller asked for — harmless, because every
 * caller reads it by `get(name)`.
 */
async function listOwnedBoxes(
  deps: StatusDeps,
  timeoutMs: number,
  name?: string,
): Promise<Map<string, ProviderVm> | null> {
  // ONE deadline across BOTH attempts. `timeoutMs` is the caller's bound on this
  // function, and handing it to each call in turn silently doubled it: a wedged
  // substrate held `fleet status` for twice as long as it asked for.
  const deadline = Date.now() + timeoutMs;
  const boxes = await listOwnedBoxesOnce(deps, timeoutMs, name);
  if (boxes !== null || name === undefined) return boxes;

  const remaining = deadline - Date.now();
  // NOTHING LEFT ⇒ do not start the fallback, and `null` is the honest answer.
  //
  // Two reasons, and the second is the load-bearing one:
  //
  //  - A remaining budget of 0 is not a 0ms timeout. `listWithTimeout` races
  //    `driver.list()` against `setTimeout(…, 0)`, and a zero-delay timer does
  //    not reject immediately — it rejects in a later timers phase. A driver
  //    resolving before that callback runs WINS the race, so the fallback adds
  //    elapsed time past the deadline and `timeoutMs` stops being a bound at all.
  //  - The retry would be futile anyway. Reaching here with the budget gone
  //    means the NAMED lookup timed out, and the fallback is the same call
  //    without the filter — strictly more work against the same wedged
  //    substrate. The case the retry was written for is the one documented
  //    above: a named lookup that ERRORS FAST for a box that is not there
  //    (`ls <name>` exiting non-zero), which leaves nearly the whole budget
  //    intact and still gets its unfiltered second look.
  //
  // So this costs the retry nothing it could have delivered, and buys back the
  // strict bound. `null` is also exactly right here: a lookup that timed out IS
  // "the substrate could not be asked".
  if (remaining <= 0) return null;
  return listOwnedBoxesOnce(deps, remaining);
}

async function listOwnedBoxesOnce(
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
    // Record-supplied strings are sanitized like their siblings: parseability
    // (or grammar-checking) is not printability, and `assertWellFormed` proves
    // nothing about control characters in these two.
    requestId: sanitizeOptional(rec.requestId, MAX_REQUEST_ID),
    // In the crash window the record has no handle but the box does; the box
    // name is what teardown would target (`rec.vmName ?? runId`).
    //
    // Both candidates go through `safeName`, and `RunRecordStore` being a
    // structural interface is why the record half needs it too — the same
    // argument `listOwnedBoxes` makes about `StatusDeps.driver`. `httpsUrl`
    // originates at the provider on both paths.
    vmName: sanitizeOptional(rec.vmName ?? box?.name, MAX_VM_NAME),
    httpsUrl: safeUrl(rec.httpsUrl),
    // `runId` stays RAW deliberately — it is the join key (`claimed` in
    // statusAll matches box names against it), and the store has already
    // grammar-checked it against the filename it was read from
    // (`assertWellFormed`). `createdAt` is only proven parseable, so it is
    // sanitized like its siblings.
    createdAt: sanitizeLabel(rec.createdAt, MAX_TIMESTAMP),
    spendMicroUsd: rec.spendMicroUsd,
    limitMicroUsd: rec.limitMicroUsd,
  };

  // closedAt → "closed", but the driver still gets consulted: consumers key on
  // the state, and a live box behind a closed record keeps billing silently.
  if (rec.closedAt !== undefined) {
    return {
      ...base,
      state: "closed",
      // Same treatment as createdAt: bounded, control-char-free — a timestamp's
      // parseability says nothing about what else is in the string.
      closedAt: sanitizeLabel(rec.closedAt, MAX_TIMESTAMP),
      // The same `boxes === null ⇒ no evidence` rule the open rows get below.
      // Omitted (not `false`) on a list failure: a closed record whose destroy
      // never landed must not read as confirmed-destroyed just because the
      // substrate was unreachable.
      ...(boxes === null ? {} : { boxAlive: box !== undefined }),
    };
  }

  // No list ⇒ no evidence either way, for a vmName-less record too (its box may
  // be live under the run id).
  if (boxes === null) return { ...base, state: "boxUnknown" };

  return { ...base, state: box === undefined ? "boxMissing" : "live" };
}

/**
 * The sort instant per row, taken from the record BEFORE `sanitizeLabel` bounds
 * it. Truncating an over-long-but-valid ISO string with an ellipsis makes it
 * unparseable, and feeding that truncation artifact to `byCreatedAtDesc`
 * dropped exactly the row the newest-first order exists to surface among the
 * failure rows (+Infinity). Keyed weakly so rows stay plain JSON-serializable
 * objects; rows with no entry (orphans, fleet-level rows) fall back to the
 * comparator's own parse of `createdAt`, which is `undefined` there anyway.
 */
const sortInstants = new WeakMap<object, number>();

function pinSortInstant(row: StatusRow, rawCreatedAt: string): void {
  const t = Date.parse(rawCreatedAt);
  if (!Number.isNaN(t)) sortInstants.set(row, t);
}

/**
 * An owned box no record claims: billing with nobody accountable for it.
 *
 * The box name is NOT the row's identity, even though `createRun` names a box
 * after its run: an orphan is by definition a box no record claims, so its name
 * is whatever the SUBSTRATE called it. On a tag-blind substrate that is every
 * box in the account (see `isOwnedVm`), so a personal `my-dev-box` is emitted
 * here — and a bare `"runId": "my-dev-box"` is a string whose next operator
 * command is `fleet teardown my-dev-box`. Parenthesised exactly like
 * `FLEET_ROW_ID`, for exactly that reason: `RUN_ID_RE` admits only `[a-z0-9-]`,
 * so the id can never be mistaken for a real one. The name teardown actually
 * targets rides on `vmName`, where it always did.
 *
 * No record ⇒ no `requestId` and no `createdAt`: both are omitted deliberately,
 * because there is nothing to join an unclaimed box to and no instant to
 * report (see StatusRow.requestId / StatusRow.createdAt).
 *
 * Shared by both entry points — `statusAll`'s unclaimed-box sweep and
 * `statusRun`'s recordless fallback — so the two can never disagree about what
 * an orphan row looks like.
 */
function orphanRow(vm: ProviderVm): StatusRow {
  // `safeName` FIRST, then the interpolation: the name is substrate-supplied and
  // this is the one row field that embeds it in a sentence, so a raw newline in
  // it forges an operator-facing line. See safeName / safeUrl.
  const name = safeName(vm.name);
  return { runId: `(orphan ${name})`, state: "orphan", vmName: name, httpsUrl: safeUrl(vm.httpsUrl) };
}

/**
 * Identity of the fleet-level rows `statusAll` can emit — the ones that describe
 * the listing itself rather than a run (`listUnavailable`, `recordsSkipped`).
 * Parenthesised so it can never collide with a real run id: `RUN_ID_RE` admits
 * only `[a-z0-9-]`. The `state` is what tells the two apart.
 */
export const FLEET_ROW_ID = "(fleet)";

/**
 * The substrate could not be listed — emitted by `statusAll` whenever
 * `driver.list()` failed or timed out, no matter how many records exist.
 *
 * `boxUnknown` alone could not carry this: it only ever attaches to an OPEN
 * record, so with no records on disk (or with every record closed) a total
 * listing failure produced an empty row set — byte-identical to a healthy empty
 * fleet, and an exit 0 telling the operator the fleet is clean while every box
 * in it kept billing. This row exists so the failure is in the output on every
 * one of those paths.
 *
 * No `createdAt`, so it sorts first for the same reason `orphan` does: it is the
 * row that invalidates every other row's box column.
 */
function listUnavailableRow(): StatusRow {
  return { runId: FLEET_ROW_ID, state: "listUnavailable" };
}

/**
 * The record listing refused to read one or more files — emitted by `statusAll`
 * whenever `listWithAnomalies().skipped` is non-empty.
 *
 * INV-4 has one exception: a `.json` whose stem is outside the id grammar is
 * logged and skipped, so a single bad filename cannot take the whole directory
 * down. But a skipped file can hold an OPEN record naming a live box. Without
 * this row that run simply vanishes from the listing and its box comes back in
 * the unclaimed sweep as an unattributed `orphan` — or, if the substrate cannot
 * be listed either, as nothing at all. `listWithAnomalies` names this verb in
 * its own docstring for the reason: "3 runs" and "3 runs and one record I
 * refused to read" must not render identically. `reapRuns` refuses to act at
 * all in this state; status reports instead, but it must not report a truncated
 * fleet as the whole fleet.
 *
 * No `createdAt`, so it sorts first for the same reason `listUnavailable` does:
 * it is a row about the completeness of every other row.
 */
function recordsSkippedRow(skipped: string[]): StatusRow {
  // Sanitized at the PRODUCER, not left to each consumer: these are filesystem
  // names from `readdirSync`, so a newline in one forges the very log line this
  // row is rendered into — and the CLI's records-skipped envelope reads them
  // back out of this row.
  return { runId: FLEET_ROW_ID, state: "recordsSkipped", skippedRecords: skipped.map(safeName) };
}

/**
 * Skipped record filenames, or `null` when the listing itself could not be read.
 *
 * `statusRun` consults this from inside an error handler already committed to a
 * typed verdict, so a listing that THROWS — one malformed record body anywhere
 * in the directory — must not turn this run's clean exit 4 into an untyped stack
 * dump about an unrelated run's file. That is why the failure is caught.
 *
 * It is `null` and not `[]` because the two are opposite answers. `[]` is "the
 * listing was read and holds no mangled names", which is what lets the exit-4
 * remediation say the run simply is not there. A failure knows neither, and
 * returning `[]` for it published the stronger claim: both the caveat AND the
 * store failure vanished, and the operator heard "check the run ID or create the
 * run first" — an invitation to re-create a run whose box may be live — about a
 * directory `statusAll` exits 1 on. The absence itself still stands (ENOENT on
 * `<runId>.json` is direct evidence about THIS run, not something derived from
 * the listing), so the verdict stays 4; what the caller owes is saying so.
 */
function skippedRecordNames(store: RunRecordStore): string[] | null {
  try {
    const skipped = store.listWithAnomalies().skipped;
    return Array.isArray(skipped) ? skipped : null;
  } catch {
    return null;
  }
}

/** Newest-first by createdAt, `runId` breaking ties so the order is total. */
function byCreatedAtDesc(a: StatusRow, b: StatusRow): number {
  // Numeric, never localeCompare: createdAt is an instant, and ICU collation on
  // mixed ISO shapes ("…Z" vs "…+00:00") orders them by text, not by time.
  // A row whose instant was pinned before sanitization (see `sortInstants`)
  // sorts by the RAW value, so a truncation artifact never feeds this
  // comparator; everything else parses its (bounded) display string.
  // Absent or unparseable (orphan rows carry none) sorts first — unowned spend
  // is the row an operator most needs to see.
  const ts = (r: StatusRow): number => {
    const pinned = sortInstants.get(r);
    if (pinned !== undefined) return pinned;
    const t = r.createdAt === undefined ? Number.NaN : Date.parse(r.createdAt);
    return Number.isNaN(t) ? Number.POSITIVE_INFINITY : t;
  };
  // Two rows that both sort first give `Infinity - Infinity` = NaN, which is
  // falsy and falls through to the tie-break — so the tie-break runs on the
  // rows least likely to have a well-formed runId, and must not throw there.
  // Code-unit `<`/`>`, for the reason the instant arm already gives — ICU
  // collation reorders and can disagree between hosts; ids sort by their bytes.
  // `?? ""` over a declared-string field on purpose: rows are built from a
  // structural driver/store interface, not from a validated type.
  const aId = a.runId ?? "";
  const bId = b.runId ?? "";
  return ts(b) - ts(a) || (aId < bId ? -1 : aId > bId ? 1 : 0);
}

/**
 * Status: store.listWithAnomalies() ∪ driver.list() with 30s timeout.
 *
 * Per C4: boxUnknown only on list failure/timeout; empty list is boxMissing.
 * Output order: newest-first by createdAt desc.
 */
export async function statusAll(deps: StatusDeps): Promise<StatusRow[]> {
  const timeoutMs = resolveTimeoutMs(deps);

  // `listWithAnomalies`, not `list`: the skipped filenames are the difference
  // between "3 runs" and "3 runs and one record I refused to read", and `list()`
  // throws that difference away. See recordsSkippedRow.
  let listing: RunRecordListing;
  try {
    listing = deps.store.listWithAnomalies();
    // The SHAPE read is inside the guard, not just the call. `RunRecordStore` is
    // a structural interface exactly like `StatusDeps.driver`, and the same
    // argument applies: any injected or test store satisfies the type while
    // answering `{records: […]}` with no `skipped`, with a non-array
    // `records`, or — the same trust level one step deeper — with ELEMENTS
    // that are not records (`null` dereferenced in `rowForRecord` as
    // `rec.vmName`). Read outside, all three threw a TypeError out of
    // `statusAll` untyped — the precise failure `record-store-unreadable` was
    // added to prevent. The throw here lands in the catch below and comes out
    // as that error. Elements are refused rather than dropped (the driver-side
    // filter's shape): a silently missing record is exactly the truncated
    // fleet the `recordsSkipped` row exists to keep honest. Arrays are refused
    // with them: `typeof [] === "object"`, so an array element passed the old
    // guard and dereferenced as a record full of undefined fields.
    if (
      !Array.isArray(listing?.records) ||
      !Array.isArray(listing.skipped) ||
      listing.records.some((rec) => rec === null || typeof rec !== "object" || Array.isArray(rec))
    ) {
      throw new Error("listWithAnomalies() did not return {records: [], skipped: []}");
    }
  } catch (e) {
    // INV-4 makes list() throw on the FIRST unreadable record — untyped, so one
    // corrupt file would hide the whole fleet behind an exit-1 stack trace.
    throw new FleetError(
      1,
      "record-store-unreadable",
      `Cannot read the run record store: ${safeDiagnostic(e)}`,
      "Fix or move the record file named in the message, then re-run `fleet status`",
    );
  }

  // Unconditional: the union has to see boxes no record claims, and a closed
  // record's box can still be alive — neither is visible from the records.
  const boxes = await listOwnedBoxes(deps, timeoutMs);

  const records = listing.records;
  const rows: StatusRow[] = records.map((rec) => {
    const row = rowForRecord(rec, boxes);
    // From the RAW value, before sanitization bounded it — see sortInstants.
    pinSortInstant(row, rec.createdAt);
    return row;
  });

  // Independent of the driver: a truncated record listing invalidates the row
  // COUNT, and (below) makes any orphan verdict unprovable — a skipped file may
  // be exactly the record that claims the box.
  if (listing.skipped.length > 0) rows.push(recordsSkippedRow(listing.skipped));

  if (boxes === null) {
    // Unconditional, and NOT folded into the per-record rows: the orphan sweep
    // below is the half of the union that never runs on a list failure, and with
    // no open record there is no `boxUnknown` row either. See listUnavailableRow.
    rows.push(listUnavailableRow());
  } else {
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
 * Single-run status. Validates runId (path safety); refuses with a typed error
 * when the record is ABSENT and no box answers to the id (4), or when the record
 * is present but unreadable (1) — never untyped, on either path.
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

    // Either way the record is unusable, and either way the box it owns may be
    // live and BILLING — so the driver is consulted before anything is said
    // about the run. `readRecord` throws a bare `Error("malformed run record
    // X.json: …")` with NO `code` on the JSON.parse/assertWellFormed paths, so
    // the old `throw e` sent a corrupt record out untyped: an exit-1 stack dump
    // from `report()`, with the driver never asked.
    const boxes = await listOwnedBoxes(deps, timeoutMs, runId);
    const box = boxes?.get(runId);

    if (code === "ENOENT") {
      // A missing FILE is not proof of a missing record: `listWithAnomalies`
      // skips any `.json` whose stem is outside the id grammar, and a record for
      // THIS run renamed to such a stem is skipped with the rest. Both verdicts
      // below assume no such record exists, so both carry the caveat when one
      // might. Read once, here — the only path where it changes the answer.
      // `null` ⇒ the listing could not be read at all, which is a THIRD answer
      // and not the empty one; see skippedRecordNames.
      const skipped = skippedRecordNames(deps.store);

      // No record is not the same as no box. The box is named after the run id
      // by `createRun`, so a hit is the `orphan` state — the unattributed spend
      // this verb exists to surface. A list failure is NOT a hit, so it still
      // refuses as 4 rather than inventing a box out of a timeout.
      if (box !== undefined) {
        return {
          ...orphanRow(box),
          // Same sanitization the fleet-level row applies — these names reach
          // the same output stream.
          ...(skipped !== null && skipped.length > 0 ? { skippedRecords: skipped.map(safeName) } : {}),
        };
      }
      throw new FleetError(
        4,
        "run-not-found",
        `No run record for ${runId}`,
        // Four arms, because there are four states and two of them used to
        // render as "create the run": the BOX listing could not be asked, so
        // nothing rules out a live box behind this id (`statusAll` renders the
        // same outage as its listUnavailable row — an unaskable substrate never
        // renders clean); the RECORD listing could not be read, so nothing
        // rules out this run's record sitting under a mangled name; or it was
        // read — cleanly, or naming the files in question. Only a substrate
        // that ANSWERED may tell the operator to create the run.
        boxes === null
          ? "Check the run ID — the driver could not be listed (timed out or errored), so whether a live box answers to this id cannot be ruled out and one may still be billing. Run `fleet status` (which reports the same outage as its listUnavailable row) and resolve it before creating the run"
          : skipped === null
            ? "Check the run ID — the record listing could not be read, so a record for this run under a mangled name cannot be ruled out. Run `fleet status` (which refuses with record-store-unreadable and names the file) and repair it before creating the run; a box may still be billing behind it"
            : skipped.length === 0
              ? "Check the run ID or create the run first"
              : `Check the run ID or create the run first — the listing skipped ${skipped.length} file(s) whose names are not run ids (${skipped.map(safeName).join(", ")}), and one of them may be this run's record under a mangled name`,
      );
    }

    // Present-but-unreadable is NOT `orphan`: a record exists, so the box is
    // claimed and the row would deny the corruption the operator has to fix.
    // Typed like every sibling — `statusAll`'s record-store-unreadable and
    // harvest/teardown's record-read-failed — and the box verdict rides in the
    // remediation, since exit 1 is the only way the operator hears it.
    throw new FleetError(
      1,
      "record-read-failed",
      // Both interpolations are sanitized like every sibling producer: the
      // exception text is store-authored (see safeDiagnostic) and the box name
      // is substrate-supplied (see safeName) — the same sentence a raw newline
      // in either would forge.
      `Run record for ${runId} could not be read: ${safeDiagnostic(e)}`,
      box !== undefined
        ? `The box ${safeName(box.name)} is STILL LIVE and billing behind that record — repair the record in place, then \`fleet teardown ${runId}\`; do not re-create the run`
        : "Repair or move the record file named in the message, then re-run `fleet status`; a box may still sit behind it, so inspect before re-creating the run",
    );
  }

  // One run, one box: use the driver's own name filter rather than paging the
  // whole fleet. Only when the two candidate names differ (a record whose box
  // was not named after it) does the join need the unfiltered list.
  const filter = rec.vmName === undefined || rec.vmName === rec.runId ? rec.runId : undefined;
  const boxes = await listOwnedBoxes(deps, timeoutMs, filter);

  return rowForRecord(rec, boxes);
}
