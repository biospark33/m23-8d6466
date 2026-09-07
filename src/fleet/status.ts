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
import { log, newRequestId } from "../swarmclaw/log.ts";
import { SBX_OWNERSHIP_TAG, type ExecResult, type ProviderVm } from "../providers/driver.ts";
import type { RunRecord, RunRecordListing, RunRecordStore } from "../providers/run-record.ts";
// Imported, not restated as "120 s": it is the number a status read must never
// inherit, and the note that says so has to name the value that is actually in force.
import { DEFAULT_EXEC_TIMEOUT_MS } from "../providers/exedev/transport.ts";
// AC5: the completion marker's IN-BOX path and the fan-out poller's OWN read —
// the four verdicts and the fail-closed catch — shared as code rather than
// re-derived here. Imported from `fanout-primitive.ts` because nothing there
// imports this module back. `boxMarkerPath(runId)` and NOT `runMarkerPath()`: the
// latter derives its base from the HOST's `QDS_RUN_ROOT`, and this path is
// shipped into a `test -f` INSIDE the box (see boxMarkerPath). Per-run since
// #217 F-D1 — the row's own runId names the root.
import {
  boxMarkerPath,
  DEFAULT_PER_CALL_DEADLINE_MS,
  type MarkerReadDriver,
  type MarkerVerdict,
  readMarkerVerdict,
} from "./fanout-primitive.ts";
// The liveness probe an absent marker needs, shared with `fleet run`'s
// post-start corroboration so the two verbs can never disagree about whether
// one unit is up. `run.ts` imports nothing from here.
import { unitActivity } from "./run.ts";
// TYPE-ONLY, and load-bearing: `ExeDevReadsMarkers` below turns "the production
// driver lost `execTimed`" from a log line into a BUILD BREAK.
import type { ExeDevDriver } from "../providers/exedev/driver.ts";

import { MAX_REQUEST_ID, MAX_URL, sanitizeLabel } from "./brief-schema.ts";
import { boundedEcho } from "../providers/step-log.ts";
// NOT re-exported. `FleetError` has ONE owner, `dispatch.ts`, and the barrel
// star-exports both modules — so a re-export here is the same binding reached
// twice through `index.ts`. It resolves today only because the two resolve to
// one symbol; the day `status.ts` declares its own, the barrel has a duplicate
// star export and every consumer of `src/fleet/index.ts` breaks at once. No
// caller imports it from here (the CLI and both test files take it from
// `dispatch.ts`), so the re-export was dead weight on the barrel path.
import { assertFleetRunId, FleetError } from "./dispatch.ts";
// The ONE expiry rule, shared with the gate so `fleet status` can never report a
// window closed that `submitDecision` and `sweepExpired` disagree about. The
// edge runs one way only — `approval-gate.ts` does not import this module — so
// there is no cycle.
import { expiredState } from "./approval-gate.ts";

export interface StatusRow {
  runId: string;
  /**
   * `orphan` is an owned box no record claims — unattributed spend, which is
   * precisely what the documented union exists to surface (it has no record,
   * hence no createdAt: the field is ABSENT and the row sorts first).
   */
  /**
   * DF3.4 AC7 adds `awaiting-approval` and `timed-out`: a run paused for
   * approval whose box is gone is an INTENTIONAL pause, and reporting it as
   * `boxMissing` sends an operator hunting a box that was deliberately torn
   * down. `timed-out` is DERIVED from `expiresAt` at read time and never
   * persisted here — see `approvalRowFields`.
   */
  /**
   * DF1.10 AC5 adds the IN-BOX states, and they REPLACE `live` on the one row
   * class that can carry them: an open record whose box the substrate still
   * reports. `live` is a fact about the BOX ("something is up and billing");
   * the in-box states are facts about the RUN, read off the in-box completion
   * marker with `readBoxFile` and — when that marker is absent — off
   * `systemctl is-active` on the run's unit. A run that finished an hour ago
   * inside a box nobody tore down reported `live` forever — true about the box,
   * and the reason an operator could not tell a working run from a finished one.
   *
   * THE WHOLE VOCABULARY, and exactly when each is produced. This list is the
   * verb's output contract: anything reading `state` off a row is reading from
   * here.
   *
   *  - `ok` / `not-ok` — the marker parsed and carries a boolean `ok`, and (when
   *    it names a run at all) it names THIS one. The only two decisive states.
   *  - `running` — the marker is absent AND `unitActivity` reports the unit
   *    `active`. ONE word is tested because `unitActivity` has already
   *    collapsed systemctl's `activating`/`reloading` into `active` (run.ts) —
   *    a booting engine reads `running` through this arm, not `unknown`.
   *    Absence CORROBORATED: the engine is up and has not settled yet.
   *  - `engine-failed` — the marker is absent and the unit is `failed`. The
   *    engine died without settling; `Restart=no` means nothing will retry it.
   *  - `not-running` — the marker is absent and the unit is `inactive`. Four
   *    causes with one honest reading ("no engine is running and no result was
   *    left behind"): dispatched but `fleet run` never invoked; the engine
   *    exited without writing a marker; the box REBOOTED, which wipes tmpfs
   *    `/run` and — with `Restart=no` and no `[Install]` — does not bring the
   *    engine back, so a run that reported `ok` reverts here permanently; or the
   *    marker was deleted. Distinguishing them needs a durable in-box artefact
   *    (`$HOME`, which survives a reboot), which this read does not have.
   *  - `unknown` — the FAIL-CLOSED verdict (INV-IBOX-7): a marker present but
   *    unjudgeable, a marker naming a DIFFERENT run, or any probe that produced
   *    no reading at all — including the unit probe. In-box evidence is a claim,
   *    not a proof, so nothing here ever upgrades to `ok` on a doubtful read.
   *  - `live` REMAINS for a box the marker could not be asked about at all — a
   *    driver with no `execTimed`/`exec` (see `StatusDeps.driver`). Reporting
   *    the box fact when the run fact is unobtainable is the honest answer, and
   *    it is exactly what this row said before AC5.
   *
   * `absent` used to collapse straight to `running`, which is how an in-box run
   * reported progress forever — the exact failure AC5's negative control says
   * must fail, reached through a different word. `engine-failed` and
   * `not-running` are the states that split it.
   */
  state:
    | "live"
    | "running"
    | "ok"
    | "not-ok"
    | "unknown"
    | "engine-failed"
    | "not-running"
    | "boxMissing"
    | "boxUnknown"
    | "closed"
    | "orphan"
    | "listUnavailable"
    | "recordsSkipped"
    | "awaiting-approval"
    | "timed-out"
    | "pausing"
    /** Passthrough of an approval state this build does not know (see
     *  `approvalRowFields`): rendered rather than silently relabelled, so
     *  `fleet status` never contradicts attach's `run-not-attachable` refusal
     *  of the same record. */
    | (string & {});
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
   * Tri-state on a `closed` row and on the two approval rows, and set only
   * there:
   *  - `true`  — the substrate still reports the box. Teardown destroys before
   *    it closes, so a closed record over a live box means the destroy never
   *    landed and the box is still billing.
   *  - `false` — the substrate answered and the box is gone (the normal case).
   *  - ABSENT  — the substrate could not be reached, so nothing is known.
   *
   * `false` and absent were one value until round 4, which meant every list
   * failure silently reported the still-billing case as confirmed-destroyed.
   *
   * The approval rows carry it for the same reason and by the same rule: a run
   * paused at the gate is the row an operator most wants "nothing is still
   * billing" on, and it was the one row that could never say it — the approval
   * arm returned before `closed` could attach one. On a list FAILURE it is
   * absent there too, which is what keeps "the box is confirmed gone" distinct
   * from "the driver could not be consulted" on a row whose state no longer
   * says so.
   */
  boxAlive?: boolean;
  /**
   * AC7, and set only on the approval states: the DF5.1 report this pause
   * is bound to, and the time left before `expiresAt` (0 once past it, so a
   * `timed-out` row reads as expired rather than negative). Both ABSENT when
   * the record carries no approval extension — an absent field is how a
   * consumer tells "not paused" from "paused with nothing bound".
   */
  reportId?: string;
  expiresInMs?: number;
  /**
   * The remediation an operator should run, set only on the `pausing` row (the
   * one state NO decision verb can settle). `requestApproval` re-presents the
   * bound report and promotes `pausing` → `awaiting-approval` on re-entry, so
   * re-running reverify IS the exit — and nothing else is. Without this field
   * the row could only gesture at the remedy, and the CLI-side remediations
   * (approve's not-decidable, attach's run-not-attachable) named a re-run of
   * `fleet status` that always reports the same state — a circle.
   */
  resumeHint?: string;
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
   * #221 (DF1.10 review round 3): set only on rows whose record carries the
   * `teardown` extension — teardown's artifacts step failed, was deliberately
   * NOT allowed to block revoke+destroy, and marked the loss on the record.
   * The run's artifact bundle (trace DB, marker, journal, resident artifacts,
   * engine log) is gone with the box; `code` is the typed failure, `failedAt`
   * the host-clock stamp. ABSENT on every ordinary closed row — an absent
   * field is how a consumer tells "torn down clean" from "torn down, evidence
   * lost", which is the whole point of the field.
   */
  artifactsLost?: { code: string; failedAt?: string };
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
  driver: {
    list(name?: string): Promise<ProviderVm[]>;
    /**
     * AC5's in-box marker read, and OPTIONAL on purpose — twice over.
     *
     * Optional at all, because `StatusDeps.driver` is the structural interface
     * every list-only test double and every future read-only driver satisfies;
     * a required method would refuse them for a capability the row degrades
     * gracefully without (state stays `live`, exactly as before AC5).
     *
     * `execTimed` and not `exec` as the CAPABILITY TEST, because AC5's deadline
     * requirement is not satisfiable over `exec`: `exec` hard-codes
     * `DEFAULT_EXEC_TIMEOUT_MS` (120 s), so a `withTimeout` around it only
     * ABANDONS the ssh — the process keeps running against the box past the
     * deadline the caller set, with its output discarded (`readBoxFile`'s own
     * docblock states this). `execTimed` pushes the budget down to the spawn, so
     * the deadline KILLS the read. A status verb that read the marker over
     * `exec` would be inheriting the 120 s default the AC exists to forbid, so
     * it refuses to read at all instead — fail-closed, and `live` remains the
     * honest answer. `exec` rides along because `readBoxFile` types it as
     * required; it is never called while `execTimed` is present.
     *
     * WHO HAS IT, because this decides whether AC5 is live and the answer must
     * not live only in a review comment: BOTH shipped drivers do.
     * `ExeDevDriver.execTimed` (`exedev/driver.ts:1269`) pushes the budget to
     * ssh, and DF1.10 gave `FakeDriver` one too
     * (`providers/fake-driver.ts:374` — `Bun.spawn`'s own `timeout` +
     * `SIGKILL`, the same kill the ssh transport takes). `scripts/fleet.ts`
     * builds `const statusDeps = { driver, store }` straight from the resolved
     * `--driver`, so **AC5 is live on the real CLI path AND under
     * `--driver fake`, with no wiring change needed from the `fleet run`
     * leaf** — the fake's method is what lets the marker-read path be
     * exercised without spend, and its absence is what used to make every
     * `--driver fake` run silently skip this read.
     *
     * What still degrades to `live` is a driver missing EITHER half of the
     * pair `markerReader` demands (`exec` AND `execTimed`): every list-only
     * test double, and any future read-only driver.
     *
     * The skip is NOT silent: the first live row skipped for want of this
     * method emits `fleet.status.marker_channel` (see `onceNoteNoMarkerChannel`).
     * A status verb that quietly stops answering the question is the failure
     * mode AC5 exists to fix, and a future driver that loses `execTimed` would
     * otherwise reintroduce it invisibly.
     */
    exec?: (vm: string, argv: string[], stdin?: string) => Promise<ExecResult>;
    execTimed?: (vm: string, argv: string[], timeoutMs: number, stdin?: string) => Promise<ExecResult>;
  };
  store: RunRecordStore;
  listTimeoutMs?: number;
  /**
   * AC5's per-call deadline for ONE row's in-box marker read, passed EXPLICITLY
   * to `readBoxFile` at the call site and defaulted to the fan-out poller's own
   * `DEFAULT_PER_CALL_DEADLINE_MS` — never to `DEFAULT_EXEC_TIMEOUT_MS`. It
   * bounds the WHOLE read for a row — `readBoxFile`'s probe and `cat` legs
   * together, ONE read with no retry loop — so an unreachable box costs
   * `fleet status` one deadline and not a multiple of one.
   *
   * Separate from `listTimeoutMs` because they bound different substrate calls
   * with different failure meanings: a list that times out makes every row's box
   * column unknown, while a marker read that times out makes ONE row's run state
   * unknown.
   */
  markerDeadlineMs?: number;
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
 * Cap on a record-supplied approval STATE echoed onto a row. A state is a
 * vocabulary word (`pausing`, `awaiting-approval`, a newer writer's word), so
 * 64 is far past anything a writer mints and still refuses the multi-KB value a
 * hostile record can put in the field. The row's own `state` is the one field
 * consumers branch on, so an over-long value is truncated with `…` rather than
 * allowed to rewrite the operator's table.
 */
const MAX_APPROVAL_STATE = 64;

/**
 * The row state for an approval extension whose `state` carries no printable
 * word at all — a non-string (`null` aside), or a verdict that sanitizes to
 * nothing. Parenthesised like `FLEET_ROW_ID` and `(orphan …)` so it can never
 * collide with a state word a writer mints or a real run id, and verbose enough
 * that an operator reading the row knows the record needs a look.
 */
const UNKNOWN_APPROVAL_STATE = "(unknown approval state)";

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
export const MAX_DIAGNOSTIC = 512;

/**
 * Cap on how many skipped filenames the run-not-found remediation interpolates
 * into ONE operator-facing line. The list scales with the runs directory, so an
 * unbounded join put megabytes of stderr (and payload) behind one `statusRun`
 * on a directory holding thousands of non-run-id `.json` files. The COUNT stays
 * exact — a truncated list is visibly partial, never silently short.
 */
export const MAX_SKIPPED_ECHO = 16;

/** The message half of a store exception, under the same two rules as names. */
function safeDiagnostic(e: unknown): string {
  // Optional chain, not a bare cast: a `throw null` must still classify (the
  // same argument statusRun's handler makes) rather than TypeError here.
  // The EXTRACTION itself is guarded too: a `.message` getter or a
  // `toString`/`Symbol.toPrimitive` that throws would otherwise escape this
  // helper mid-catch and replace the typed refusal (record-store-unreadable,
  // record-read-failed) with a secondary crash — defeating the one job the
  // helper has. Fixed fallback, no interpolation of the unprintable value.
  try {
    return sanitizeLabel((e as Error | null)?.message ?? String(e), MAX_DIAGNOSTIC);
  } catch {
    return "[unprintable diagnostic]";
  }
}

/**
 * A rejected numeric option as the value the operator actually passed.
 * `JSON.stringify(NaN)` is `"null"`, so a NaN deadline rendered as `got null`
 * on exactly the config-error path whose whole job is to name the bad input.
 * `String()` shows `NaN`/`Infinity` for what they are; finite numbers keep the
 * JSON form, and `undefined` still reads `undefined`.
 */
function badNumber(value: number | undefined): string {
  return typeof value === "number" && Number.isFinite(value) ? JSON.stringify(value) : String(value);
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

/**
 * `setTimeout` clamps a delay past the 32-bit signed max to 1 ms — the same
 * inversion dispatch.ts's `MAX_TIMEOUT_MS` guards, and status did not: a
 * caller asking for a LONGER budget got the SHORTEST possible one, every box
 * reported `boxUnknown` and `statusAll` emitted `listUnavailable`. Clamped
 * rather than refused so an over-eager configured ceiling degrades to the
 * largest real one instead of breaking every verb.
 */
const MAX_LIST_TIMEOUT_MS = 2_147_483_647;

/** Story: 30s default. A non-positive value would fire the timer immediately. */
function resolveTimeoutMs(deps: StatusDeps): number {
  const ms = deps.listTimeoutMs ?? 30_000;
  if (!Number.isFinite(ms) || ms <= 0) {
    throw new FleetError(
      2,
      "invalid-list-timeout",
      `listTimeoutMs must be a positive finite number, got ${badNumber(deps.listTimeoutMs)}`,
      "Omit listTimeoutMs for the 30s default, or pass a positive millisecond value",
    );
  }
  return Math.min(ms, MAX_LIST_TIMEOUT_MS);
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
 * F091: box names the substrate reported MORE THAN ONCE, keyed by the map they
 * were collapsed into, with how many boxes answered to each. A WeakMap for the
 * same reason `sortInstants` is one — the join map stays a plain `Map` that
 * every caller reads with `get`, and the collision rides alongside it instead
 * of widening the type through the whole join.
 */
const collapsedBoxNames = new WeakMap<object, Map<string, number>>();

/**
 * F091: one `duplicate-box-name` line per colliding name, naming every record
 * that claims it.
 *
 * Two collisions, one line, because they are the same accident seen from the
 * two sides of the join and both end with a LIVE, BILLING box the operator's
 * own status verb does not show:
 *  - the SUBSTRATE reported two boxes under one name (`collapsedBoxNames`), so
 *    the map kept the last and the earlier box has no row at all — not even as
 *    an orphan;
 *  - two RECORDS claim one name, so one of them is reporting a box it does not
 *    own, and its own box is unaccounted for.
 *
 * Reported, never repaired: the table keeps last-wins exactly as before (see
 * the marker in `listOwnedBoxesOnce`). Never throws — a status verb must not
 * die on the way to describing a broken fleet.
 */
function reportDuplicateBoxNames(records: readonly RunRecord[], boxes: Map<string, ProviderVm> | null): void {
  // Claims by the SAME two names the join looks a record up under, so this can
  // never disagree with `rowForRecord` about who claims what.
  const claims = new Map<string, string[]>();
  const claim = (name: string, runId: string): void => {
    const ids = claims.get(name);
    if (ids === undefined) claims.set(name, [runId]);
    else if (!ids.includes(runId)) ids.push(runId);
  };
  for (const rec of records) {
    claim(rec.runId, rec.runId);
    if (rec.vmName !== undefined && rec.vmName !== rec.runId) claim(rec.vmName, rec.runId);
  }

  const collapsed = boxes === null ? undefined : collapsedBoxNames.get(boxes);
  const names = new Set<string>(collapsed?.keys() ?? []);
  for (const [name, ids] of claims) if (ids.length > 1) names.add(name);

  // ONE id for every line this call emits: the lines describe one listing, and
  // a fresh uuid per line breaks the join an operator uses to group them.
  // (`StatusDeps` carries no requestId to inherit — no caller of either entry
  // point has one to pass, so minting it here is the whole story.)
  const requestId = newRequestId();
  for (const name of names) {
    // boxes === null means the driver failed/timed out (boxUnknown), not that
    // it reported zero boxes — collapse to "unknown" instead of 0 so the
    // message below doesn't claim a listing the provider never returned.
    const boxCount = collapsed?.get(name) ?? (boxes === null ? undefined : boxes.has(name) ? 1 : 0);
    const runIds = claims.get(name) ?? [];
    // Record-supplied, same as boxName — a runId with a newline must not reach
    // the log payload or the interpolated message unsanitized.
    const displayRunIds = runIds.map(safeName);
    try {
      log({
        requestId,
        operation: "fleet.status.duplicate_box_name",
        agentId: null,
        timestamp: new Date().toISOString(),
        duration: 0,
        status: "ok",
        code: "duplicate-box-name",
        // Substrate-supplied, and this one is interpolated into a sentence.
        boxName: safeName(name),
        boxCount,
        runIds: displayRunIds,
        message:
          boxCount === undefined
            ? `box name ${safeName(name)} is not unique: the substrate's box listing is unavailable (driver-unavailable) and ${displayRunIds.length} record(s) claim it (${displayRunIds.join(", ") || "none"}). \`fleet status\` keeps the LAST box under a name, so any other box under it is live and billing with no row in the table — reconcile by name before acting on this listing`
            : `box name ${safeName(name)} is not unique: the substrate reported ${boxCount} box(es) under it and ${displayRunIds.length} record(s) claim it (${displayRunIds.join(", ") || "none"}). \`fleet status\` keeps the LAST box under a name, so any other box under it is live and billing with no row in the table — reconcile by name before acting on this listing`,
        outcome: "duplicate-box-name",
      });
    } catch {
      // a throwing log sink must not take the status verb down
    }
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
    // ponytail: still last-wins on a duplicate `name` for the TABLE — but the
    // collision is no longer silent (F091): every collapsed name is recorded on
    // `collapsedBoxNames` below and reported by `reportDuplicateBoxNames`, so
    // the hidden box is named on the operator's channel even though its row is
    // not in the table. The name IS the join key across records, driver and
    // teardown, so two boxes sharing one is a substrate that has already broken
    // the addressing every verb depends on; carrying `Map<string, ProviderVm[]>`
    // through the record join to give the hidden box a ROW of its own is still
    // the upgrade if a substrate ever allows it.
    const owned = vms.filter((v) => typeof v?.name === "string" && v.name.length > 0 && isOwnedVm(v));
    const boxes = new Map(owned.map((v) => [v.name, v] as const));
    if (owned.length > boxes.size) {
      const counts = new Map<string, number>();
      for (const v of owned) counts.set(v.name, (counts.get(v.name) ?? 0) + 1);
      collapsedBoxNames.set(
        boxes,
        new Map([...counts].filter(([, n]) => n > 1)),
      );
    }
    return boxes;
  } catch {
    return null;
  }
}

/**
 * AC7's row fields for a run PAUSED for approval, or `undefined` when the run
 * is not paused — which is what makes this an override rather than a relabel.
 *
 * Only the paused states qualify. A settled approval (`approved`, `rejected`,
 * and a persisted `timed-out`) is history: such a run is an ordinary open run,
 * and a box missing under it really is missing.
 *
 * `pausing` and `awaiting-approval` are DISTINCT rows, because no verb will
 * ever settle a `pausing` one (CodeRabbit round-7 / DN2). `awaiting-approval`
 * is "this run is waiting on you": `fleet approve`/`fleet reject` is the exit.
 * `pausing` is "the pause is still being taken": teardown may be mid-flight,
 * and `submitDecision` refuses such a run as `not-decidable` — the only exit
 * is re-running reverify, whose `requestApproval` re-presents the bound report
 * and promotes `pausing` → `awaiting-approval`. Both rows carry `reportId`;
 * the `pausing` row additionally carries `resumeHint` naming that exit, so no
 * consumer can render a remediation that circles back to this same state.
 *
 * A crashed teardown leaves `pausing` on disk indefinitely BY DESIGN (it is
 * the recoverable state `requestApproval` throws into), so the state is
 * reachable and persistent, not a mid-flight instant. Consequently `pausing`
 * reports NO `expiresInMs`: a countdown that runs to zero and then changes
 * nothing is worse than no countdown, which is `expiredState`'s own stated
 * reason for never expiring `pausing`.
 *
 * Expiry is DERIVED, never written: `fleet status --dir` builds a `create:false`
 * store that throws on every write, so a sweep here would either crash or
 * reintroduce the writable-store regression. A past `expiresAt` therefore
 * DISPLAYS as `timed-out`; approve/reject persist it, holding the lock and a
 * writable store. An unparseable `expiresAt` is left as `awaiting-approval`
 * with no `expiresInMs` — declaring a run expired on a garbage timestamp is
 * the one failure mode worth avoiding here.
 *
 * The expiry RULE is `expiredState`'s, imported rather than re-implemented, and
 * that is a fix rather than a tidy-up (CodeRabbit, post-Session-C review). An
 * inline re-derivation is a second place the rule can move.
 *
 * TWO SOURCES OF TRUTH, stated so record-readers do not have to rediscover it:
 * a derived `timed-out` is RENDER-ONLY. The record's own `state` stays
 * `awaiting-approval` until `submitDecision`/`sweepExpired` — which hold a
 * writable store and the lock — persist the terminal state (approve/reject
 * write it by design; status never does, see the `create:false` note above).
 * So a record-reader that opens the JSON sees `awaiting-approval` for a row
 * `fleet status` displays as `timed-out`; the row is the opinion of this
 * read-time derivation, the record is the authority. Anything needing the
 * persisted fact (DF5.2-style consumers) must read the record, not the row.
 *
 * An approval state NONE of {`pausing`, `awaiting-approval`, terminal} — a
 * hand-migrated `on-hold`, a newer writer's word — is returned as a row whose
 * `state` IS that string (sanitized and capped like every other echoed field:
 * it is a record-supplied value on its way to an operator, not a trusted
 * vocabulary word), rather than falling through to an ordinary
 * live/boxMissing/closed row: `attachToRun` refuses every state value as
 * `run-not-attachable`, so a silent fall-through would let `fleet status`
 * call the run ordinary while the attach verb refuses it. Fail-visible, not
 * fail-silent.
 *
 * ONE clock read (round-7 item 24): `now` feeds both `expiredState` and the
 * countdown. Two reads let the deadline pass between them and produce
 * `awaiting-approval` with `expiresInMs: 0` — a countdown reading as expired
 * on a row the gate still considers live.
 */
function approvalRowFields(rec: RunRecord, now: Date):
  | { state: string; reportId?: string; expiresInMs?: number; resumeHint?: string }
  | undefined {
  const approval = rec.extensions?.approval;
  if (approval === undefined) return undefined;
  // The RECORD's own word, before any derivation — read as `unknown`, because
  // `RunRecordStore` is a structural interface and a record off disk can carry
  // anything in an extension field, whatever `ExtensionValue` claims.
  //
  // `?.` on the OBJECT too: the extension body itself can be null on that same
  // seam (the file-backed store's read validation refuses it; an injected
  // store can still hand it back), and a bare `approval.state` on it threw
  // out of the `rowForRecord` sweep exactly the way a torn `{teardown: null}`
  // did in `artifactsLostFields`. `null?.state` is `undefined`, so the null
  // OBJECT renders under the same UNKNOWN_APPROVAL_STATE literal as `{}` —
  // the arm `fleet run`'s start gate refuses under, keeping the two verbs in
  // agreement on the shape.
  //
  // A non-string is NOT `String()`-coerced: coercion fabricated the literal
  // `"null"` and `"[object Object]"` as row states — vocabulary words no writer
  // mints, presented as if one had. A state that is not a string carries no
  // printable word at all — and that includes `null` and the ABSENT `state` of
  // a torn `{}` extension, which `fleet run`'s start gate refuses under this
  // same literal (its approval-object guard sits above its `closedAt` check)
  // — so every non-string shape is shown as `UNKNOWN_APPROVAL_STATE` and
  // routed through the SAME sanitized unknown-state arm below. They used to
  // fall through to the ordinary rows, which let `fleet status` call a record
  // ordinary that `fleet run` refused as not-startable: two verdicts on one
  // record, the exact disagreement the run-side fix closed.
  const stated: unknown = approval?.state;
  const rawState = typeof stated === "string" ? stated : UNKNOWN_APPROVAL_STATE;

  // A SETTLED approval — approved, rejected, and a PERSISTED `timed-out`, the
  // terminal vocabulary the gate writes — is history: such a run is an
  // ordinary open/closed run, and a box missing under it really is missing.
  // Return undefined so the caller's ordinary arms take it. A persisted
  // `timed-out` falls through here even though a DERIVED one renders as
  // `timed-out` below: the gate's own sweep already committed that one, while
  // the derived one is this read's verdict on a record that still says
  // `awaiting-approval`.
  // An EMPTY state is no evidence of anything (`expiredState` returns
  // undefined for it for the same reason) — fall through rather than invent.
  if (rawState === "" || rawState === "approved" || rawState === "rejected" || rawState === "timed-out") {
    return undefined;
  }

  // ponytail: MAX_REQUEST_ID reused — a reportId is the same class of harness-
  // minted id and sanitizeOptional wants a bound, not a bespoke constant.
  // `?.` here too: the null OBJECT lands in the unknown-state arm below, and a
  // bare `approval.reportId` would re-crash it one arm after `?.state` fixed
  // it. The true branch's second read is safe once the typeof passes.
  const reportId = sanitizeOptional(
    typeof approval?.reportId === "string" ? approval.reportId : undefined,
    MAX_REQUEST_ID,
  );

  // An approval state this build does not know (a hand-migrated `on-hold`, a
  // newer writer's word) renders with the state VISIBLE on the row rather than
  // falling through to an ordinary live/boxMissing/closed row. Two verdicts on
  // one record is the failure this prevents: `attachToRun` refuses EVERY
  // state value — including one it does not recognize — as
  // `run-not-attachable`, and the CLI's remediation for that arm sends the
  // operator to `fleet status` to "inspect the box"; a row that silently
  // rendered the run as ordinary-and-live under the same record contradicts
  // that refusal. Fail-safe = visible: the operator sees a state word they do
  // not recognize, which is the truth about the record. (Intentional behavior
  // change from the earlier drop-to-closed reading — flagged for the test
  // wave; the fall-through pins above hold for the KNOWN terminal states,
  // which are dispatched before this arm.)
  if (rawState !== "pausing" && rawState !== "awaiting-approval") {
    // Visible, not RAW: the value goes through the same sanitize-then-cap as
    // every other echoed field on this row. This was the last field echoing
    // record bytes verbatim, and `state` is the field every consumer branches
    // on — so a record carrying a newline could forge the rows rendered after
    // it, and an oversized one could ride the row out unbounded. Display form
    // only; the stored record is never rewritten.
    return {
      state: sanitizeLabel(rawState, MAX_APPROVAL_STATE),
      ...(reportId === undefined ? {} : { reportId }),
    };
  }

  // The gate's OWN rule, so the two can never disagree about whether a window
  // closed — and the gate's own clock instant, so its verdict and the
  // countdown below are the same instant's facts. Only the two LIVE pause
  // states reach here, so `effective` is one of `pausing` / `timed-out` /
  // `awaiting-approval`.
  const effective = expiredState(approval, now);

  // The `pausing` resumeHint. The record may name WHY the pause is stuck
  // (`approval.reason`, written by some writers alongside the extension); when
  // it does, that cause is the truthful hint and is echoed through
  // `boundedEcho` — the same redact-then-cap discipline every other id/text
  // echo in the fleet uses (a raw template here skipped both the redaction
  // and the cap that siblings apply). When it does not, the hint stays the
  // generic reverify exit: truthful, but it must not promise that re-running
  // reverify FIXES the blocker, because for the R5-C (no-keyHash) and
  // INV-APPROVE-6 (no-teardown-seam) refusal arms the gate leaves `pausing`
  // standing until the named underlying problem is fixed — reverify will
  // re-present and refuse again.
  const pauseHint =
    typeof approval.reason === "string" && approval.reason.length > 0
      ? `the pause is still being taken — ${boundedEcho(approval.reason)} (re-run reverify for this run to re-present report ${reportId === undefined ? "(unbound)" : reportId})`
      : `the pause is still being taken — re-run reverify for this run; its approval request re-presents report ${reportId === undefined ? "(unbound)" : reportId} and promotes the run to awaiting-approval`;

  // The gate still holds `pausing`: rendered as its own state, never expired,
  // never countdowned, with the ONE remediation that can settle it.
  if (effective === "pausing") {
    return {
      state: "pausing",
      ...(reportId === undefined ? {} : { reportId }),
      // Keep the hint in the row so every renderer says the same thing; the
      // phrasing matches approve's not-decidable arm after the DN2 alignment,
      // and (when the record carries one) names the actual blocker instead of
      // promising the re-run fixes it — see pauseHint above.
      resumeHint: pauseHint,
    };
  }

  // The VERDICT is `effective`'s — re-deriving it here re-opened exactly the
  // drift the header comment exists to close: an inline `remaining > 0` called
  // `now === expiresAt` timed-out while the gate's strict `>` still awaits,
  // and a second implementation is a second place the rule can move.
  // `expiresAt` is parsed only for the countdown DISPLAY, which is this
  // function's own concern (expiredState deliberately never expires
  // `pausing`, so an effective timed-out is always the gate's verdict).
  if (effective === "timed-out") {
    // Self-consistent by construction, and not contradictory with a `closedAt`
    // already on the record: `requestApproval` runs the REAL teardown BEFORE
    // promoting, so a record that reached a settled/paused state at all is
    // closed FIRST. A `timed-out` row over a record with `closedAt` therefore
    // reads as one story — the window closed after the box went down — and
    // `rowForRecord` merges the closed/box facts onto this row (below), never
    // a "live box + expired window" pair.
    return { state: "timed-out", ...(reportId === undefined ? {} : { reportId }), expiresInMs: 0 };
  }
  // The LIVE row only when the verdict IS the live one. It used to be an
  // UNGUARDED `else` — every verdict the gate could not name fell into a
  // fabricated `awaiting-approval` with a countdown computed off the record's
  // `expiresAt`, i.e. a decision window invented out of a record this build
  // cannot interpret. Today the arms above dispatch every verdict `expiredState`
  // can return for the two states that reach this line, so the arm below is
  // unreachable; it exists so the day the gate grows a verdict, status renders
  // it truthfully (sanitized, no countdown) instead of telling an approver they
  // have a window to act in.
  if (effective === "awaiting-approval") {
    // `expiresAt` is parsed only for the countdown DISPLAY, which is this
    // function's own concern (expiredState deliberately never expires
    // `pausing`, so an effective timed-out is always the gate's verdict).
    const expiresAt = typeof approval.expiresAt === "string" ? Date.parse(approval.expiresAt) : Number.NaN;
    if (Number.isNaN(expiresAt)) return { state: "awaiting-approval", ...(reportId === undefined ? {} : { reportId }) };
    return {
      state: "awaiting-approval",
      ...(reportId === undefined ? {} : { reportId }),
      expiresInMs: Math.max(0, expiresAt - now.getTime()),
    };
  }
  // Any verdict this build cannot name — or an absent one — is displayed as
  // itself, sanitized, with NO countdown: an unknown verdict must never render
  // as a live window an approver can act on.
  const verdict = sanitizeLabel(effective ?? "", MAX_APPROVAL_STATE);
  return {
    state: verdict === "" ? UNKNOWN_APPROVAL_STATE : verdict,
    ...(reportId === undefined ? {} : { reportId }),
  };
}

/**
 * The box this record owns, or `undefined` when the substrate reported none —
 * or could not be asked at all (`boxes === null`, which is no evidence either
 * way and is the CALLER's to distinguish; see `rowForRecord`'s `boxUnknown`).
 *
 * The box join matches on runId **and** vmName, exactly as `reapRuns` claims:
 * `createRun` names the box after the run id and persists `vmName` only after
 * `driver.create()` returns, so an open record with no `vmName` can still own a
 * live box. Matching on `vmName` alone reports that box missing, which is the
 * INV-1 crash window the record was designed to survive.
 *
 * Extracted so the AC5 marker read addresses the SAME box `rowForRecord` built
 * the row from. Re-deriving the join at the read site is how the two would come
 * to disagree — and the read is an `exec` against a named box, so a disagreement
 * there is a marker read aimed at the wrong machine.
 */
function joinedBox(rec: RunRecord, boxes: Map<string, ProviderVm> | null): ProviderVm | undefined {
  if (boxes === null) return undefined;
  const names = rec.vmName === undefined ? [rec.runId] : [rec.vmName, rec.runId];
  return names.map((n) => boxes.get(n)).find((b) => b !== undefined);
}

/**
 * State derivation per C4, shared by both entry points.
 *
 * `live` rides back as its OWN flag rather than being re-read off `row.state`,
 * and that is a correctness fix, not a tidy-up: `approvalRowFields` echoes an
 * approval state this build does not know onto the row VERBATIM (sanitized), so
 * a record carrying `extensions.approval.state: "live"` produces a row whose
 * `state` is the string `"live"` without being the ordinary live arm at all.
 * Probing that row would overwrite the deliberately fail-VISIBLE unknown-state
 * signal with a run state — and `attachToRun` still refuses the same record as
 * `run-not-attachable`, which is exactly the two-verdicts-on-one-record
 * contradiction that arm exists to prevent.
 */
type BuiltRow =
  | { row: StatusRow; live: false }
  /** `live` is only ever true WITH a box, and the pair rides together so the
   *  marker read cannot re-derive the join and address a different machine. */
  | { row: StatusRow; live: true; box: ProviderVm };

/**
 * #221: the `teardown` extension's artifacts-loss fields, sanitized like every
 * other store-supplied string and ABSENT when the record carries no such
 * extension. Spread onto `base`, so EVERY record-backed arm carries it: the
 * extension is stamped during the artifacts step (step 2 of 6), and any later
 * step throwing leaves the record OPEN with the extension already set — an
 * aborted teardown (box alive, evidence lost) must not read as "clean" on the
 * open-row arms (boxUnknown / boxMissing / live) exactly because that is the
 * state where the operator most needs the signal.
 */
function artifactsLostFields(rec: RunRecord): { artifactsLost?: { code: string; failedAt?: string } } {
  const ext = rec.extensions?.teardown as { artifactsCode?: unknown; artifactsFailedAt?: unknown } | undefined;
  // NULL is treated like ABSENT, never dereferenced: a torn `{teardown: null}`
  // record put `null` past the `=== undefined` check and `null.artifactsCode`
  // threw — killing the whole SYNCHRONOUS `records.map(rowForRecord …)` sweep
  // in `statusAll` (it runs before `allSettled`, so no per-row fallback and no
  // `row-read-failed` line: an untyped exit 1 for one malformed record). The
  // file-backed store's read-mode validation refuses the shape, but
  // `RunRecordStore` is a structural interface — the same seam every shape
  // guard in `statusAll` defends — so the null object can still arrive here.
  if (ext === null || ext === undefined || typeof ext.artifactsCode !== "string" || ext.artifactsCode.length === 0) {
    return {};
  }
  return {
    artifactsLost: {
      code: sanitizeLabel(ext.artifactsCode, 64),
      ...(typeof ext.artifactsFailedAt === "string"
        ? { failedAt: sanitizeLabel(ext.artifactsFailedAt, MAX_TIMESTAMP) }
        : {}),
    },
  };
}

function rowForRecord(rec: RunRecord, boxes: Map<string, ProviderVm> | null): BuiltRow {
  const box = joinedBox(rec, boxes);
  // ONE clock instant for the whole row: the approval override's expiry verdict
  // and its countdown must be the same instant's facts (round-7 item 24).
  const now = new Date();

  // Every record-backed row is built from `base`, so `requestId` reaches all of
  // them — closed, boxUnknown, boxMissing, live, and both entry points. A field
  // populated on five of six paths is how the last round of this bug started.
  const base = {
    runId: rec.runId,
    // Record-supplied strings are sanitized like their siblings: parseability
    // (or grammar-checking) is not printability, and `assertWellFormed` proves
    // nothing about control characters in these two.
    requestId: sanitizeOptional(rec.requestId, MAX_REQUEST_ID),
    // #221 on EVERY arm via `base` — see `artifactsLostFields`' docblock: the
    // extension can sit on an OPEN record (artifacts step 2 of 6, a later
    // step's throw), and the open-row arms are exactly where the loss signal
    // must not vanish.
    ...artifactsLostFields(rec),
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

  // AC7: a run paused for approval was paused ON PURPOSE, and the approval
  // extension is the only thing that says so. The pause OVERRIDES the row
  // state — including a LIVE box (DN3, round 7).
  //
  // ORDER — this arm sits above `closed` AND above the live/boxMissing arms,
  // and both placements are load-bearing.
  //
  // Above `closed`: `requestApproval` runs the REAL teardown before promoting
  // to `awaiting-approval`, and teardown's last step sets `closedAt`, so EVERY
  // genuinely paused record is also a closed record. Below `closed` this branch
  // is unreachable in production and `fleet status` reports "closed" for a run
  // sitting on an approver's desk (caught by the live tier-1 demo, not by unit
  // fixtures that omitted `closedAt`).
  //
  // Above a LIVE box (DN3): the old `box === undefined` guard rendered a paused
  // run whose teardown stalled or was refused — INV-APPROVE-6's no-seam guard
  // leaves exactly this — as `live`, hiding the stranded pause behind a box
  // column and stranding the operator (approve refuses `pausing` as
  // not-decidable). AC7's letter is "each paused run appears with its state",
  // so the approval state now wins over box presence. The box FACTS ride
  // along rather than being lost: `vmName`/`httpsUrl` are already on `base`,
  // and `boxAlive` is set on the row whenever the substrate could be asked —
  // so the strand and the still-billing box are visible in ONE row. This is an
  // intentional behavior change: a paused run with a live box now renders
  // `awaiting-approval`/`pausing` (+`boxAlive: true`) where it rendered `live`.
  //
  // Settled approvals still fall through: `approvalRowFields` returns undefined
  // for approved/rejected/timed-out, so only the PAUSED states pre-empt. Both
  // entry points get it: statusAll and statusRun share this function.
  //
  // `boxAlive` keeps its whole-file rule (`boxes === null` ⇒ ABSENT, no
  // evidence): a list outage must not read as "confirmed gone" OR as
  // "confirmed alive" on a row whose state no longer reports the box at all.
  const approval = approvalRowFields(rec, now);
  if (approval !== undefined) {
    return {
      live: false,
      row: {
        ...base,
        ...approval,
        ...(rec.closedAt === undefined ? {} : { closedAt: sanitizeLabel(rec.closedAt, MAX_TIMESTAMP) }),
        ...(boxes === null ? {} : { boxAlive: box !== undefined }),
      },
    };
  }

  // closedAt → "closed", but the driver still gets consulted: consumers key on
  // the state, and a live box behind a closed record keeps billing silently.
  if (rec.closedAt !== undefined) {
    return {
      live: false,
      row: {
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
      },
    };
  }

  // No list ⇒ no evidence either way, for a vmName-less record too (its box may
  // be live under the run id).
  if (boxes === null) return { live: false, row: { ...base, state: "boxUnknown" } };

  if (box === undefined) return { live: false, row: { ...base, state: "boxMissing" } };
  // The box rides back with the row. `withInBoxState` used to take a SECOND
  // `joinedBox(rec, boxes)` result from each call site — two call sites, two
  // re-derivations of a join this function had already made, which is precisely
  // the "re-deriving the join is how the two come to disagree" hazard
  // `joinedBox`'s own docblock warns about, reintroduced by the extraction that
  // was supposed to close it.
  return { live: true, row: { ...base, state: "live" }, box };
}

// ─── AC5: the in-box marker read ───────────────────────────────────────────────

/**
 * The states AC5 reports for a run whose box is up and whose record is open.
 * The full vocabulary and the reading behind each is on `StatusRow.state`.
 */
type InBoxState = "running" | "ok" | "not-ok" | "unknown" | "engine-failed" | "not-running";

/**
 * One non-decisive marker reading, on the operator's channel. `unknown` is a
 * verdict an operator has to act on, and without the cause behind it the row
 * says only "something went wrong somewhere" — the same argument
 * `reportDuplicateBoxNames` makes for its own line. Never throws, for the same
 * reason it gives: a status verb must not die on the way to describing a
 * broken fleet.
 *
 * `marker_read_ms` is the MEASURED duration of the marker read this line
 * reports — the story's Observability Contract names the key ("Sub-timings:
 * `engine_start_ms`, `phase_walk_ms`, `marker_read_ms`, `harvest_pull_ms`"),
 * and the engine side already emits its two; this is the host's half. Snake_case
 * in an otherwise camelCase payload for the same reason `engine_settled`'s
 * timings are: the contract pins the exact spelling and a consumer greps it.
 */
function noteMarkerRead(
  requestId: string,
  vm: string,
  runId: string,
  verdict: Extract<MarkerVerdict, { code: string }>,
  markerReadMs: number,
): void {
  try {
    log({
      requestId,
      operation: "fleet.status.marker_read",
      agentId: null,
      timestamp: new Date().toISOString(),
      // MEASURED, not a fabricated 0 — the same figure `marker_read_ms` below
      // carries; a duration-keyed consumer must not read a failed read as
      // instantaneous.
      duration: markerReadMs,
      status: "error",
      code: verdict.code,
      // Substrate- and box-supplied, both interpolated into an operator-facing
      // sentence — the same two rules every other producer here applies.
      boxName: safeName(vm),
      runId: safeName(runId),
      message: `in-box completion marker for ${safeName(runId)} on ${safeName(vm)} could not be read: ${safeDiagnostic(verdict.error)}`,
      outcome: verdict.kind,
      marker_read_ms: markerReadMs,
    });
  } catch {
    // a throwing log sink must not take the status verb down
  }
}

/**
 * The absent marker whose unit could not be reached either — the reading that
 * used to be reported as `running` and is now `unknown`.
 *
 * Worth its own line for `noteMarkerRead`'s reason: `unknown` is a verdict an
 * operator has to act on, and this particular `unknown` has a specific next
 * step (the box answered about the FILE and not about the UNIT, so the box is
 * up and something about the exec channel or systemd is not). Never throws.
 *
 * `marker_read_ms` rides here too, with the value from THIS reading's marker
 * read (the probe line is the second half of that same reading): the contract
 * key belongs on every line the host's marker-read path emits, so a consumer
 * grepping it finds the sub-timing without having to know which arm fired.
 */
function noteUnitProbe(
  requestId: string,
  vm: string,
  runId: string,
  markerReadMs: number,
  /** The WHOLE reading's measured cost (marker read + probe) — the line's `duration`. */
  readTotalMs: number,
): void {
  try {
    log({
      requestId,
      operation: "fleet.status.unit_probe",
      agentId: null,
      timestamp: new Date().toISOString(),
      // MEASURED (marker read + probe), not a fabricated 0; the marker-read
      // half alone rides `marker_read_ms` below.
      duration: readTotalMs,
      status: "error",
      code: "unit-activity-unknown",
      boxName: safeName(vm),
      runId: safeName(runId),
      message: `no completion marker for ${safeName(runId)} on ${safeName(vm)} and \`systemctl is-active\` gave no readable answer, so the run's state is UNKNOWN rather than running: ssh the box and read \`systemctl status qds-run@${safeName(runId)}.service\``,
      outcome: "unit-activity-unknown",
      marker_read_ms: markerReadMs,
    });
  } catch {
    // a throwing log sink must not take the status verb down
  }
}

/**
 * The run's own state, read off the in-box completion marker (AC5) and — when
 * the marker is absent — off the run unit's own liveness.
 *
 * The read, its four verdicts and its fail-closed catch are the fan-out race
 * poller's, imported rather than restated (`readMarkerVerdict`). What differs
 * is the SHAPE of the caller: the poller ticks for up to an hour and can afford
 * to wait a marker out; a status verb answers now. So the mapping is the
 * poller's own, collapsed to one answer:
 *
 *  - `settled` → `ok` / `not-ok`, the marker's own `{ok: boolean}`. The row's
 *    runId rides the read, so a marker naming a DIFFERENT run never settles
 *    this row (see `classifyMarkerRead`'s `expectedRunId`): two records can
 *    address one box, and the marker is the only thing that knows whose run it
 *    describes.
 *  - `absent`  → the unit probe below. NOT `running` on its own.
 *  - `skip`    → `unknown`. No reading at all is no evidence, and INV-IBOX-7
 *    makes no evidence fail CLOSED.
 *  - `unusable` → `unknown`, NEVER `ok`.
 *
 * ## Why absence is corroborated
 *
 * `absent` used to return `running` unqualified, and it is the ONE verdict with
 * no corroboration behind it. Four states produce it: dispatched but `fleet
 * run` never invoked; the engine died after the fork; the box REBOOTED, wiping
 * tmpfs `/run` — and with `Restart=no` and no `[Install]` the engine does not
 * come back, so a run that had reported `ok` reverts to `running` permanently;
 * or the marker was harvested. Every one of them reported "still walking its
 * phases" forever, on a box that bills by the hour. So an absent marker is
 * followed by `systemctl is-active` on the run's unit, and only an ACTIVE unit
 * reads as `running` — see `unitActivity` and `StatusRow.state`.
 *
 * The extra probe costs one round trip and only on the absent path: a settled
 * marker is decisive whatever the unit says (the engine EXITS after it writes
 * the marker, so a healthy finished run is `inactive` with `ok` on disk — which
 * is exactly why the marker is read first and the unit second).
 *
 * ## ONE read, not a retry loop
 *
 * The unusable RETRY that used to sit here is gone. Its docblock justified it
 * by "a `cat` killed at the budget is classified `unreadable`, so one unusable
 * read can be a busy box" — but every attempt was handed `until - Date.now()`,
 * the WHOLE remaining budget, so such a `cat` consumed all of it and the next
 * iteration returned `unknown` after one attempt anyway. The retry could only
 * ever fire for FAST unusable reads (a parse failure, a non-boolean `ok`, an
 * oversized marker), which the same docblock calls permanently corrupt: three
 * reads of a marker that will read identically every time. Slicing the budget
 * per attempt would not have saved it either — it makes the busy-box case
 * strictly worse, four reads each with a quarter of the window.
 *
 * So the read is a single SNAPSHOT, and the docblock is true again. The tick
 * ceiling (`MARKER_UNUSABLE_TICKS_LIMIT`, `markerUnusableGivesUp`) is the
 * POLLER's alone — status never consumes it, because there is no streak to
 * count: one unusable read is one `unknown` row, this read's verdict. That
 * also makes status strictly more fail-closed than the poller: it can never
 * report `ok` on a read the poller would still be counting toward its
 * ceiling.
 *
 * ONE budget for the whole thing, taken as an absolute deadline at entry,
 * exactly as `readBoxFile` bounds its own probe/`cat` pair.
 */
async function inBoxState(
  driver: MarkerReadDriver,
  vm: string,
  runId: string,
  deadlineMs: number,
  /**
   * The RECORD's requestId, when it has one — the dispatch join key the
   * Observability Contract says propagates "onto the host's marker read, so a
   * status row joins an in-box trace row without a second key". A record
   * without one (`provisionAdmittedRun`'s shape) keeps the old rule instead:
   * ONE fresh id minted here, so the marker read and the unit probe still
   * group as one reading.
   */
  recordRequestId?: string,
): Promise<InBoxState> {
  const until = Date.now() + deadlineMs;
  const requestId = recordRequestId ?? newRequestId();
  // The whole budget, unconditionally — `resolveMarkerDeadlineMs` has already
  // refused a non-positive one, so there is no "budget already gone" arm to
  // fall through silently before the first read (there used to be, and with
  // `markerDeadlineMs: 1` or an NTP slew between two statements it returned
  // `unknown` with nothing logged).
  const readBeganAt = Date.now();
  const verdict = await readMarkerVerdict(driver, vm, boxMarkerPath(runId), deadlineMs, runId);
  // The contract's `marker_read_ms` — the measured cost of THIS read, handed
  // to whichever note below fires so the key is never fabricated.
  const markerReadMs = Date.now() - readBeganAt;
  if (verdict.kind === "settled") return verdict.ok ? "ok" : "not-ok";
  if (verdict.kind !== "absent") {
    noteMarkerRead(requestId, vm, runId, verdict, markerReadMs);
    return "unknown";
  }
  // Absent. What is LEFT of the one budget goes to the corroborating probe —
  // floored at 1 ms rather than skipped, exactly as `readBoxFile` floors its
  // own second leg: a probe killed at the spawn answers `unknown`, which is the
  // same fail-closed disposition as not asking, and it says so on the channel.
  const activity = await unitActivity(driver, vm, runId, Math.max(1, until - Date.now()));
  if (activity === "active") return "running";
  if (activity === "failed") return "engine-failed";
  if (activity === "inactive") return "not-running";
  // The unit could not be read. The marker is absent and nothing corroborates
  // it, so this is the fail-closed verdict — never `running`.
  noteUnitProbe(requestId, vm, runId, markerReadMs, Date.now() - readBeganAt);
  return "unknown";
}

/**
 * AC5's override: the row's `state` becomes the RUN's state whenever the run's
 * state can be read at all.
 *
 * Applied ONLY to a `live` row, which is the AC's "a live `vmName` and no
 * terminal state" exactly — every other state is already a verdict this read
 * must not overwrite. A `closed` record's box is not walking phases; a paused
 * run's approval state outranks box presence by design (see `rowForRecord`);
 * `boxUnknown` means the substrate could not be listed, so there is no box name
 * to address a read to.
 *
 * The box's OWN name, not the row's: `vmName` on the row has been through
 * `sanitizeLabel`, which may have truncated it with an ellipsis, and a
 * truncated name is a different box (or none).
 *
 * Applied by BOTH entry points, and that is the point of putting it here rather
 * than in `statusAll`: `fleet status` and `fleet status <id>` reporting
 * different states for one record is the same two-verdicts-on-one-record
 * failure `listOwnedBoxes` documents at length.
 */
async function withInBoxState(
  reader: MarkerReadDriver | undefined,
  noteNoChannel: (runId: string, vm: string) => void,
  built: BuiltRow,
  deadlineMs: number,
): Promise<StatusRow> {
  const row = built.row;
  // `built.live` carries the box with it (see `BuiltRow`), so there is no
  // second `joinedBox` call and no `box === undefined` arm to be unreachable —
  // that arm could only ever have SKIPPED the read silently if it did fire,
  // which is the opposite of failing closed.
  if (!built.live) return row;
  if (reader === undefined) {
    noteNoChannel(row.runId, built.box.name);
    return row;
  }
  // The ROW's requestId is the record's, sanitized and bounded on the way into
  // the row (`rowForRecord`) — the dispatch join key the marker-read lines
  // carry (see `inBoxState`'s `recordRequestId`), which is the letter of the
  // Observability Contract's "onto the host's marker read".
  //
  // JOIN-KEY CAUTION: this is a SANITIZED value doing join duty. A minted
  // correlation id is a 36-char UUID — well under `MAX_REQUEST_ID`, over a
  // charset `sanitizeLabel` passes through untouched — so the row's key and
  // the dispatch ack's key are the same string today. If `sanitizeLabel` ever
  // truncates or rewrites a record's requestId, these note lines would carry
  // the REWRITTEN key and the "a status row joins an in-box trace row"
  // contract would break silently. The honest fix if that ever bites is the
  // RAW record id here, sanitized only at the operator-facing echoes.
  return {
    ...row,
    state: await inBoxState(reader, built.box.name, row.runId, deadlineMs, row.requestId),
  };
}

/**
 * The marker-read channel, or `undefined` when this driver has none.
 *
 * Resolved ONCE per verb call, not per row: the capability belongs to the
 * driver, not to the record, so re-deciding it (and re-`bind`ing) for every row
 * of a fleet is a fleet's worth of work for one answer.
 *
 * `execTimed` is the capability test — see `StatusDeps.driver` for why it and
 * not `exec`. Both are `.bind`-ed because they are class methods on a real
 * driver and a bare reference would lose `this`.
 */
function markerReader(deps: StatusDeps): MarkerReadDriver | undefined {
  const driver = deps.driver;
  if (typeof driver.exec !== "function" || typeof driver.execTimed !== "function") return undefined;
  return { exec: driver.exec.bind(driver), execTimed: driver.execTimed.bind(driver) };
}

/**
 * COMPILE-TIME ONLY: the production driver satisfies the marker-read channel.
 *
 * `markerReader` degrades to `undefined` for a driver without `execTimed`, and
 * the degradation announces itself with ONE log line that no gate can fail on —
 * so the day `ExeDevDriver` loses the method, every live row goes back to
 * reporting `live` and the whole of AC5 goes dark behind a note. That is the
 * same fake-drift class as the `pullArtifacts` empty-argv defect this story's
 * Dev Agent Record is a post-mortem of.
 *
 * The parameter's `extends` clause is the assertion: if `ExeDevDriver` stops
 * structurally satisfying `MarkerReadDriver`, THIS LINE fails `tsc` and the
 * build breaks. Exported so it is not an unused local, and a type alias so it
 * costs nothing at runtime.
 *
 * `FakeDriver` now implements `execTimed` too (`providers/fake-driver.ts:374`),
 * so `--driver fake` reads markers rather than reporting `live`. It is still
 * not asserted HERE, because this file has no other reason to name the fake and
 * the alarm for it already exists where it belongs: `FakeDriver.execTimed`'s
 * own docblock states that this module's `typeof driver.execTimed ===
 * "function"` gate is why the method exists, and
 * `tests/providers/fake-driver.test.ts` ("PARITY: execTimed exists, honours its
 * ceiling…") fails if it is removed.
 */
type SatisfiesMarkerReadDriver<T extends MarkerReadDriver> = T;
export type ExeDevReadsMarkers = SatisfiesMarkerReadDriver<ExeDevDriver>;

/**
 * ONE note per verb call, on the FIRST live row skipped for want of `execTimed`.
 *
 * Latched rather than emitted per row because the fact is about the DRIVER, not
 * the row: a fleet of thirty live boxes would otherwise put thirty identical
 * lines on the operator's channel, and a note repeated thirty times is a note
 * nobody reads. Emitted at the first SKIPPED ROW rather than at resolution, so
 * a fleet with nothing to read (all closed, all boxMissing, or empty) says
 * nothing — the note is about a question that went unanswered, and there was no
 * question.
 *
 * It exists because the alternative is silence: a driver without `execTimed`
 * reports `live` exactly as it did before AC5, which is indistinguishable from
 * AC5 working and finding a box that is up. That is the failure AC5 was written
 * to end, so the degradation says so out loud. Never throws, for
 * `reportDuplicateBoxNames`' reason: a status verb must not die on the way to
 * describing a fleet.
 */
function onceNoteNoMarkerChannel(deps: StatusDeps): (runId: string, vm: string) => void {
  let fired = false;
  // WHICH method is missing, named accurately. `markerReader` requires `exec`
  // AND `execTimed`, so a driver exposing only `execTimed` also lands here —
  // and the note asserted "this driver exposes no `execTimed`", a paragraph of
  // remediation about the one method the driver actually had.
  const why =
    typeof deps.driver.execTimed !== "function"
      ? `this driver exposes no \`execTimed\`, the only exec channel that can carry an explicit per-call deadline — \`exec\` hard-codes ${String(DEFAULT_EXEC_TIMEOUT_MS)}ms, which a status read must never inherit. Both drivers this repository ships (ExeDevDriver, FakeDriver) expose \`execTimed\`, so whatever is wired here is neither of them`
      : "this driver exposes `execTimed` but no `exec`, and the marker read needs both (`readBoxFile` falls back to `exec` when no deadline can be pushed to the spawn)";
  return (runId, vm) => {
    if (fired) return;
    fired = true;
    try {
      log({
        requestId: newRequestId(),
        operation: "fleet.status.marker_channel",
        agentId: null,
        timestamp: new Date().toISOString(),
        // `duration: 0` here is a diagnosed ABSENCE, not a measurement —
        // nothing ran to be timed (see the `marker_read_ms` note below).
        duration: 0,
        // "error", not "ok": this line IS the alarm. A driver that lost the
        // marker channel sends every live row back to `live` — the exact
        // failure AC5 exists to end — and a consumer alerting on
        // `status: "error"` never saw the day AC5 went dark.
        status: "error",
        code: "marker-channel-unavailable",
        // Record- and substrate-supplied, both interpolated into an
        // operator-facing sentence — the same two rules every producer here applies.
        runId: safeName(runId),
        boxName: safeName(vm),
        message: `in-box run state is NOT being reported for ${safeName(runId)} (box ${safeName(vm)}), nor for any other live row in this listing: ${why}. Rows keep reporting \`live\` (the box is up) instead of running/ok/not-ok/engine-failed/not-running/unknown (what the run is doing)`,
        outcome: "marker-channel-unavailable",
        // The contract's "a path never evaluated reports 0" — on this line the
        // marker read was never attempted at all (no channel to read over), so
        // the sub-timing key is present with the 0 that says "not evaluated",
        // never omitted (a consumer grepping `marker_read_ms` finds every
        // status line that could have carried a reading, evaluated or not).
        marker_read_ms: 0,
      });
    } catch {
      // a throwing log sink must not take the status verb down
    }
  };
}

/**
 * AC5's per-call deadline, resolved and CHECKED once per verb call — the same
 * shape and the same reason as `resolveTimeoutMs` above.
 *
 * Refused rather than tolerated because the failure is silent and total: a
 * non-positive deadline makes the loop's budget check fire before its first
 * read, so every live row in the fleet reports `unknown` — a whole fleet
 * rendered unknowable by one bad config number, with the rows looking exactly
 * like genuinely unreadable markers. The 32-bit clamp is `resolveTimeoutMs`'s
 * for its reason too: `readBoxFile` bounds its legs with `setTimeout`, which
 * turns a delay past the signed max into 1 ms — a caller asking for a LONGER
 * budget getting the shortest possible one.
 *
 * Defaulted to the fan-out poller's own per-call deadline, never to
 * `DEFAULT_EXEC_TIMEOUT_MS`: it is the same class of budget for the same class
 * of read, and the 120 s exec default is the one number AC5 forbids inheriting.
 */
function resolveMarkerDeadlineMs(deps: StatusDeps): number {
  const ms = deps.markerDeadlineMs ?? DEFAULT_PER_CALL_DEADLINE_MS;
  if (!Number.isFinite(ms) || ms <= 0) {
    throw new FleetError(
      2,
      "invalid-marker-deadline",
      `markerDeadlineMs must be a positive finite number, got ${badNumber(deps.markerDeadlineMs)}`,
      `Omit markerDeadlineMs for the ${DEFAULT_PER_CALL_DEADLINE_MS}ms default, or pass a positive millisecond value`,
    );
  }
  return Math.min(ms, MAX_MARKER_DEADLINE_MS);
}

/**
 * The 32-bit clamp for the MARKER deadline, which is its own budget.
 *
 * It used to clamp against `MAX_LIST_TIMEOUT_MS`, re-coupling two budgets
 * `resolveMarkerDeadlineMs`'s own docblock insists are separate because they
 * bound different substrate calls — so shrinking the LIST cap would silently
 * shrink every marker read with it. Same number today, and that is exactly the
 * hazard: they agree by coincidence, not by derivation, and each has to be free
 * to move without dragging the other.
 */
const MAX_MARKER_DEADLINE_MS = 2_147_483_647;

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
 * The optional TEXT fields `rowForRecord` reads off a record. Each must be
 * absent or a string: `sanitizeOptional`/`safeUrl` trust their inputs are
 * strings, and the store being a structural interface means a test double can
 * hand back a record whose `vmName` is a number.
 */
const RECORD_TEXT_FIELDS = ["vmName", "httpsUrl", "requestId", "closedAt"] as const;

/**
 * How many live-row marker reads `statusAll` holds in flight at once. 8 stays
 * under sshd's `MaxStartups` drop threshold (default 10:30:100 — probabilistic
 * drops BEGIN past 10 simultaneous unauthenticated connections) with headroom
 * for the second connection an absent-marker row opens for its unit probe.
 * The `driver.list()` this same verb makes is ONE connection and is not
 * counted; rows that settle without a read (closed, boxMissing, paused) never
 * take a slot.
 *
 * Single-verb assumption, stated because nothing enforces it: the pump is
 * per-call and process-local, so the cap holds ONE `fleet status` sweep. Two
 * concurrent sweeps (an operator and a cron, say) each open up to 8 marker
 * reads plus their absent-marker unit probes — 16+ simultaneous connections,
 * past the 10:30:100 threshold — and can drop each other's probes as exit-255
 * `skip`s, flipping healthy rows to the fail-closed verdict. Nothing in this
 * module can see the other sweep; serialising whole verbs across processes is
 * the fleet lock's job, not a status read's.
 */
const MAX_ROW_FANOUT = 8;

/**
 * The `statusAll` sweep's slot pump — deliberately not a helper type: one
 * caller, one shape (acquire before the substrate touch, release in `finally`
 * so a rejected row cannot leak a slot and starve the rest of the fleet).
 *
 * Slots HAND OFF on release rather than decrement-then-wake, so `active` is
 * never observable below the cap while a waiter is still due one — see
 * `releaseRowSlot` for the overcommit that the split sequence allowed.
 */
function rowSlotPump(): { acquireRowSlot: () => Promise<void>; releaseRowSlot: () => void } {
  let active = 0;
  const waiters: Array<() => void> = [];
  return {
    acquireRowSlot: async () => {
      if (active >= MAX_ROW_FANOUT) {
        // The slot is HANDED OVER by `releaseRowSlot` — `active` already
        // counts this waiter by the time the await resolves, so this arm
        // must not increment again.
        await new Promise<void>((resolve) => waiters.push(resolve));
        return;
      }
      active += 1;
    },
    releaseRowSlot: () => {
      const next = waiters.shift();
      if (next === undefined) {
        active -= 1;
        return;
      }
      // Direct handoff: the slot transfers to the waiter without `active`
      // ever being decremented, so an acquire issued between the release and
      // the waiter's resumption still sees the cap held. The old
      // decrement-then-resume pair left a window in which a NEW acquire
      // passed the `active >= MAX_ROW_FANOUT` check and overcommitted past
      // the cap — safe only because every acquire today is issued
      // synchronously in the single `built.map(...)` batch before any
      // release can occur; a second caller or re-entrant acquire turned it
      // into silent >8 concurrent ssh connections against the `MaxStartups`
      // threshold MAX_ROW_FANOUT exists to respect.
      next();
    },
  };
}

/**
 * Status: store.listWithAnomalies() ∪ driver.list() with 30s timeout.
 *
 * Per C4: boxUnknown only on list failure/timeout; empty list is boxMissing.
 * Output order: newest-first by createdAt desc.
 */
export async function statusAll(deps: StatusDeps): Promise<StatusRow[]> {
  const timeoutMs = resolveTimeoutMs(deps);
  const { acquireRowSlot, releaseRowSlot } = rowSlotPump();
  // Both budgets checked BEFORE the substrate is touched, so a bad number
  // refuses with exit 2 rather than after a fleet's worth of listing.
  const markerDeadlineMs = resolveMarkerDeadlineMs(deps);
  // Both resolved ONCE for the whole listing: the channel is the driver's, and
  // the note is latched so a fleet reports the missing channel once, not per row.
  const reader = markerReader(deps);
  const noteNoChannel = onceNoteNoMarkerChannel(deps);

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
      listing.records.some((rec) => {
        if (rec === null || typeof rec !== "object" || Array.isArray(rec)) return true;
        // One step deeper still: the FIELDS rowForRecord dereferences. A
        // non-string runId breaks the box join and the sort key; a numeric
        // vmName rides into sanitizeOptional, which trusts its input is a
        // string. Same refusal vocabulary as above: elements are refused,
        // never dropped.
        const r = rec as Partial<RunRecord>;
        return (
          typeof r.runId !== "string" ||
          typeof r.createdAt !== "string" ||
          RECORD_TEXT_FIELDS.some((f) => r[f] !== undefined && typeof r[f] !== "string")
        );
      })
    ) {
      throw new Error(
        "listWithAnomalies() did not return {records: [], skipped: []} of records with string runId/createdAt and absent-or-string optional fields",
      );
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
  // F091 — before the rows are built, so the collision is on the operator's
  // channel even if a later step throws.
  reportDuplicateBoxNames(records, boxes);
  // CONCURRENT, and the whole point of that is the bound: each row's AC5 marker
  // read carries its own deadline, so run in series a fleet of N live boxes
  // would cost `fleet status` N deadlines. Run together the sweep costs ONE
  // (ceil(N / MAX_ROW_FANOUT) in the worst case once the semaphore below
  // bounds it). Rows with nothing to read (closed, boxMissing, paused, or a
  // driver that cannot exec) never touch the substrate and settle immediately.
  //
  // BOUNDED at MAX_ROW_FANOUT, because the fan's real ceiling is not the fleet
  // an operator pays for but sshd's `MaxStartups` (10:30:100 by default): past
  // ~10 simultaneous unauthenticated connections sshd starts DROPPING them
  // probabilistically, the dropped probes surface as exit 255 → `skip` →
  // `unknown`, and a status verb whose own concurrency artifact flips healthy
  // rows to the fail-closed verdict defeats the read it performed. A semaphore
  // (the shape this block's own note used to defer) keeps the fan under the
  // drop threshold while staying concurrent for the fleet-sized case.
  //
  // `allSettled`, not `all`, and the fallback is the point. `readMarkerVerdict`
  // is documented as never rejecting, but the per-row callback also runs
  // `withInBoxState`, `noteMarkerRead` and `pinSortInstant` — so ONE unexpected
  // throw on ONE row rejected the whole thing and `fleet status` returned
  // nothing at all for a fleet of N healthy runs. That is the failure this file
  // states three times as its own rule: a status verb must not die on the way
  // to describing a fleet. A row that throws falls back to the RECORD-only row,
  // which is every fact the store knew before the substrate was asked.
  //
  // The record-only rows are built ONCE, up front, and the fallback reuses
  // them: `rowForRecord` is pure and touches no substrate, so re-running it in
  // the failure handler would be a second chance for the same input to fail.
  const built = records.map((rec) => rowForRecord(rec, boxes));
  const settled = await Promise.allSettled(
    built.map(async (b, i) => {
      const rec = records[i] as RunRecord;
      const settle = async (): Promise<StatusRow> => {
        const row = await withInBoxState(reader, noteNoChannel, b, markerDeadlineMs);
        // From the RAW value, before sanitization bounded it — see sortInstants.
        // Pinned on the FINAL object: `withInBoxState` returns a new row, and
        // pinning the pre-override one would leave the row that reaches the
        // comparator with no instant at all — sorting a live run to the top with
        // the orphans.
        pinSortInstant(row, rec.createdAt);
        return row;
      };
      // A row with nothing to read — not `live`, or a driver with no exec
      // channel — never ACQUIRES: `withInBoxState` settles it without touching
      // the substrate, and acquiring first queued it behind live rows' marker
      // deadlines (in a listing whose first eight records are live rows on
      // slow boxes, every later no-read row waited a full deadline each). The
      // MAX_ROW_FANOUT comment's "rows that settle without a read … never
      // take a slot", which the acquire-first order silently broke. Output
      // order is untouched: `allSettled` maps results by index, so rows land
      // in `built` order whatever order they finish in.
      if (!b.live || reader === undefined) return settle();
      await acquireRowSlot();
      try {
        return await settle();
      } finally {
        releaseRowSlot();
      }
    }),
  );
  const rows: StatusRow[] = settled.map((r, i) => {
    if (r.status === "fulfilled") return r.value;
    // The rejection is NAMED, not swallowed. The fallback row below is honest
    // about the box, but `r.reason` was the only record of WHY the run fact
    // could not be read — and this was the one reading in the verb that could
    // fail without a trace, while every other degraded reading here
    // (`noteMarkerRead`, `noteUnitProbe`) says so on the channel. A fresh id:
    // `StatusDeps` carries no requestId to inherit (`reportDuplicateBoxNames`
    // makes the same decision). `duration: 0` is honest — this fallback scan
    // is synchronous; nothing ran to be timed.
    const rec = records[i] as RunRecord;
    try {
      log({
        requestId: newRequestId(),
        operation: "fleet.status.row_failed",
        agentId: null,
        timestamp: new Date().toISOString(),
        duration: 0,
        status: "error",
        code: "row-read-failed",
        // Record-supplied, interpolated into the message — same two rules as
        // every sibling producer here.
        runId: safeName(rec.runId),
        message: `status row for ${safeName(rec.runId)} fell back to the record-only row: its in-box read threw (${safeDiagnostic(r.reason)})`,
        outcome: "row-read-failed",
      });
    } catch {
      // a throwing log sink must not take the status verb down
    }
    // The PRE-OVERRIDE row: its state is the BOX fact (`live`/`closed`/…),
    // which is honest — the run fact is what could not be obtained.
    const row = (built[i] as BuiltRow).row;
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
  const markerDeadlineMs = resolveMarkerDeadlineMs(deps);

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
              : `Check the run ID or create the run first — the listing skipped ${skipped.length} file(s) whose names are not run ids (${
                  skipped.slice(0, MAX_SKIPPED_ECHO).map(safeName).join(", ")
                }${skipped.length > MAX_SKIPPED_ECHO ? `, and ${skipped.length - MAX_SKIPPED_ECHO} more` : ""}), and one of them may be this run's record under a mangled name`,
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

  // F091: the same collision, on the entry point an operator types when they
  // already know the id — one record, so only the substrate-side arm can fire.
  reportDuplicateBoxNames([rec], boxes);
  // AC5 rides the SHARED row builder's output, so this entry point and
  // `statusAll` can never report different states for one record.
  return withInBoxState(markerReader(deps), onceNoteNoMarkerChannel(deps), rowForRecord(rec, boxes), markerDeadlineMs);
}
