/**
 * DF1.10 AC1, host side — start the in-box phase engine and RETURN.
 *
 * `fleet run <run-id>` does exactly one thing to a box that dispatch already
 * provisioned and the setup gate already passed: it starts DF2.10's
 * `qds-run@<runId>.service` instance. It never walks a phase, never holds the
 * run, and never waits for the engine to finish. The engine's completion is
 * observed by a DIFFERENT verb (`fleet status`, over the in-box marker) and its
 * artifacts by a third (`fleet harvest`); wiring any of that in here is what
 * would make the host hold a run whose whole point is that it does not.
 *
 * There was no host-side `systemctl` call site in this repo before this module,
 * so nothing here is copied from a systemd precedent — the posture is the
 * providers layer's exec-and-classify idiom (`fill.ts`'s `step()`), and the
 * transport is the one every other in-box operation already uses.
 *
 * ## Why an ARGV and not a shell script
 *
 * Sibling in-box work in this directory (`attach.ts`) builds `sh -c` strings
 * because it needs the BOX to resolve a path and needs a payload on stdin.
 * This needs neither, so it stays an argv: with no shell in the chain there is
 * no quoting question to get wrong, which is the hazard `src/fleet/dispatch.ts`
 * :63-66's "no substrate command string under src/fleet/" exists to keep in one
 * place. The one interpolated value is the runId, and `assertFleetRunId` has
 * already narrowed it to the RFC 1123 label grammar (`RUN_ID_RE`,
 * `run-record.ts:342`) — `[a-z0-9-]` only, so it carries no shell
 * metacharacter, and none of the `/`, `.`, `\` or `%` that `systemd-escape`
 * exists for either. The instance name needs no escaping and the argv needs no
 * quoting, and both facts come from the same one-line grammar.
 *
 * ## Why `sudo -n`
 *
 * `qds-run@.service` is a SYSTEM unit (`/etc/systemd/system/`) and the box's
 * exec user is not root — `src/providers/exedev/driver.ts:99-104` establishes
 * both, and provisions the steering channel through `sudo -n install -d` on
 * every box, asserting the result rather than trusting it. So passwordless
 * `sudo -n` is a substrate property this repo already depends on and already
 * verifies at box creation; using it here invents no new privilege assumption.
 * `-n` (never prompt) rather than bare `sudo`: a policy that would prompt must
 * fail fast with a named exit, not park an ssh session on a password prompt
 * until the exec budget SIGKILLs it.
 *
 * ## Why no host-side "is it already running?" check BEFORE the start
 *
 * AC6. `systemctl start` on an already-active instance is a NO-OP, so a second
 * `fleet run` starts no second engine — the window is closed by systemd's unit
 * IDENTITY, not by anything this file could observe. A PRE-start probe would be
 * strictly worse: it is a TOCTOU window (the answer can change between the
 * probe and the start) bought with an extra round trip, and it would have to
 * decide what to do about a race it cannot win.
 *
 * There IS a probe after the start (`unitActivity`), and it is not that probe.
 * It decides nothing about whether to start — the start has already happened —
 * and it has no race to lose: it reads what systemd made of a job this process
 * just submitted. It exists because `Type=simple` makes exit 0 mean "forked",
 * so without it every post-fork failure was reported as a healthy start. See
 * `unitActivity`.
 *
 * What this module owes AC6
 * instead is that both invocations address the byte-identical instance name and
 * that the argv never says `restart`, `try-restart` or `--force` — each of
 * which turns the second invocation into a second engine over phases whose git
 * commits and LLM spend already happened.
 *
 * Nor `systemctl enable`, ever. The unit deliberately ships with no `[Install]`
 * section, and that absence is the policy: an ENABLED instance is pulled in by
 * multi-user.target on EVERY subsequent boot and re-walks paid phases — the
 * same double-spend `Restart=no` refuses, arriving through a different door.
 */
import type { ExecResult, ProviderDriver } from "../providers/driver.ts";
import { EXEC_KILLED_EXIT, EXEC_TRANSPORT_EXIT } from "../providers/exedev/transport.ts";
import type { RunRecordStore } from "../providers/run-record.ts";
import { redactSecrets } from "../providers/step-log.ts";
import { withTimeout } from "../providers/timeout.ts";
// The producer-side sanitize rule `status.ts` already applies to this same
// approval state on its rows — `run.ts` was the outlier echoing it raw.
import { sanitizeLabel } from "./brief-schema.ts";
// The store's grammar and length cap, reached through the fleet wrapper so an
// off-grammar id refuses as exit 2 rather than as an untyped store error — the
// same call `statusRun` makes as ITS first statement. `dispatch.ts` does not
// import this module, so the edge runs one way only.
import { assertFleetRunId } from "./dispatch.ts";

/**
 * The exec shape one unit start needs, structural like `readBoxFile`'s.
 *
 * `execTimed` is PREFERRED when present: `exec` hard-codes
 * `DEFAULT_EXEC_TIMEOUT_MS` (120 s), so a host-side `withTimeout` expiring only
 * ABANDONS the ssh — the start keeps running against the box with its output
 * discarded, past the very deadline the caller set. `execTimed` passes the
 * budget down to the spawn. Optional so a structural test double with only
 * `exec` still satisfies this; a production driver that lost the method dies
 * loudly at `fill.ts:269` long before it reaches here.
 */
export type StartRunDriver = Pick<ProviderDriver, "exec"> & {
  execTimed?: (vm: string, argv: string[], timeoutMs: number, stdin?: string) => Promise<ExecResult>;
};

export interface StartRunDeps {
  driver: StartRunDriver;
  store: RunRecordStore;
}

export interface StartRunOptions {
  /**
   * Per-call deadline. A seam, not a flag: the registry declares none and the
   * budget below is derived from the unit, not chosen. Tests use it to reach
   * the `box-unreachable` mapping in milliseconds.
   */
  timeoutMs?: number;
}

/**
 * Why a start did not happen. Both arms mean NO engine was started as far as
 * this host can tell, and both leave the box exactly as they found it — but
 * they need different operator postures, and collapsing them would put a
 * permanently-broken box into a retry loop.
 *
 *  - `unit-refused` — systemd ran the job and it FAILED. `AssertPathExists=`
 *    on the credential file, a box built from an image with no such unit, an
 *    ExecStart that is not there — or a job that was ACCEPTED (exit 0) and
 *    whose unit `systemctl is-active` already reports `failed`, which is the
 *    post-fork half `Type=simple` hides from the exit status. Permanent for
 *    this box: the identical retry produces the identical failure, so this must
 *    never reach the CLI's exit-1 "retry me".
 *  - `box-unreachable` — no job verdict was obtained at all: the exec was
 *    SIGKILLed at its budget (137), ssh never connected or dropped mid-flight
 *    (255), or the call did not come back and the host deadline fired. This one
 *    IS retryable, and safely so: `withTimeout` cannot cancel the in-box
 *    command, so the start may well have landed — and if it did, the retry is
 *    systemd's no-op rather than a second engine (see the AC6 note above).
 */
export type StartRunFailureReason = "unit-refused" | "box-unreachable";

/**
 * `requestId` on the arms that HAVE one is the RECORD's — the id `dispatch`
 * stamped when it provisioned the box (INV-4-bis), not this invocation's. It is
 * the cross-layer join key that ties this start to that dispatch and to the
 * engine's own lines once it is walking, and it is returned rather than re-read
 * by the caller because this function has already read the record. Optional
 * because the record's is (`run-record.ts:134`): a dispatched run carries one, a
 * bare `provisionAdmittedRun` does not, and echoing `undefined` as a string
 * would be a fabricated correlation id. `run-not-startable` carries none — it
 * refuses on the record read itself, exactly as `attachToRun` does.
 */
export type StartRunResult =
  | {
      outcome: "started";
      vm: string;
      unit: string;
      requestId?: string;
      /**
       * Present ONLY when the post-start probe produced no reading — the start
       * is reported (exit 0 is a verdict, and `unknown` is not evidence of
       * failure) but UNCORROBORATED, and that fact was previously invisible:
       * every other non-happy arm in this union carries a diagnosis, and this
       * one dropped the probe's failure on the floor. Absent on a corroborated
       * start, so `toEqual` on the healthy shape stays exact.
       */
      detail?: string;
    }
  | {
      /**
       * Refused on the RECORD, before any exec — so the box (if it still
       * exists) was never touched. Mirrors `attachToRun`'s arm of the same
       * name, on the same evidence: `requestApproval` runs the real teardown
       * BEFORE it promotes to any approval state, so `vmName` outlives the box
       * and an approval state means the box is gone.
       *
       * `state` is one of `closed`, `no-box`, `gate-failed`, or whatever
       * approval state the record carries (including one this build does not
       * know — see the guard). `gate-failed` is the odd one out and worth
       * naming: its box is ALIVE (INV-5 leaves it up on purpose so the failure
       * can be inspected), so unlike every other arm here the refusal is not
       * "the box is gone" — it is "this box failed its setup assertions and
       * must not be given an engine".
       */
      outcome: "run-not-startable";
      state: string;
    }
  | {
      outcome: "start-failed";
      reason: StartRunFailureReason;
      requestId?: string;
      /** The transport's own status, absent when nothing ever ran. */
      exitCode?: number;
      /** Bounded transport text — see `DETAIL_CHARS`. */
      detail?: string;
    };

/** The systemd template this verb starts instances of, minus `@`. */
export const RUN_UNIT_PREFIX = "qds-run";

/**
 * The instance name for a run. The runId is interpolated raw and that is safe
 * by grammar, not by luck — see the module header's escaping note.
 */
export function runUnitName(runId: string): string {
  return `${RUN_UNIT_PREFIX}@${runId}.service`;
}

/**
 * Host deadline for the start, passed EXPLICITLY at the call site and never
 * inherited from `DEFAULT_EXEC_TIMEOUT_MS`.
 *
 * DERIVED FROM THE MANAGER DEFAULT, and that correction is the whole point of
 * this comment's current shape. It used to read "derived from the unit:
 * `qds-run@.service` declares `TimeoutStartSec=60`". The unit declares no such
 * directive — DF1.10 deleted it as provably inert, because for `Type=simple`
 * systemd considers the unit started as soon as the process is FORKED, so the
 * start window closes microseconds after activation and a per-unit start
 * timeout can never elapse. The old arithmetic ("90 s clears 60 s") was
 * therefore derived from a ceiling that no longer exists.
 *
 * The ceiling that DOES bound this call is the manager's
 * `DefaultTimeoutStartSec` — 90 s on Ubuntu 24.04, which the box-environment
 * probe measured as the box OS. It binds because `systemctl start` WITHOUT
 * `--no-block` waits for the whole job transaction, and this unit's
 * `Requires=systemd-tmpfiles-setup.service` can ACTIVATE that oneshot rather
 * than merely order against it (the unit's own CEILING note).
 *
 * So the budget must strictly EXCEED 90 s, not equal it. At exactly 90 s the
 * host and systemd give up at the same instant while the ssh round trip is
 * spent inside the HOST's window and outside systemd's — so the host abandons a
 * start job systemd is still legitimately running and reports
 * `box-unreachable` for a healthy box. That is the precise failure this
 * constant exists to prevent, and the previous value sat exactly on it.
 *
 * It must clear a SECOND ceiling for the same reason, and that is why 120 s was
 * not enough either. When the driver has no `execTimed` the call below falls
 * back to `exec`, which hard-codes `DEFAULT_EXEC_TIMEOUT_MS` (120 s) — so the
 * host's `withTimeout` and the transport's own budget expired at the same
 * instant, and which of the two won was a coin flip: either the exec's real
 * verdict (137, SIGKILLed at its budget) or a bare TimeoutError. `status.ts`
 * refuses to read over `exec` at all rather than live with that; this module
 * cannot refuse (the fallback is a documented structural seam), so it clears
 * the number instead. 125 s is strictly above BOTH ceilings, and the headroom
 * over each is what buys the losing timer a chance to report.
 *
 * `--no-block` is NOT the alternative: it returns before the unit is confirmed
 * started and throws away the failure signal `fleet run` exists to surface.
 */
export const RUN_START_TIMEOUT_MS = 125_000;

/**
 * systemd's `DefaultTimeoutStartSec` on the box OS (Ubuntu 24.04) — the ceiling
 * `RUN_START_TIMEOUT_MS` is derived against, exported so the suite can assert
 * the RELATIONSHIP instead of re-typing the number. A test that hard-codes 90 s
 * asserts nothing about this derivation: the day the box OS moves, the constant
 * moves here and the test keeps passing against a stale copy.
 */
export const MANAGER_DEFAULT_START_MS = 90_000;

/**
 * The upper clamp on a caller-supplied `timeoutMs`.
 *
 * `setTimeout` (which `withTimeout` uses) stores its delay in a signed 32-bit
 * int: a delay past this fires in 1 ms, so a caller asking for a LONGER budget
 * would get the shortest possible one and every start would report
 * `box-unreachable`. `resolveMarkerDeadlineMs` (status.ts) clamps against
 * exactly this, for exactly this reason.
 */
const MAX_START_TIMEOUT_MS = 2_147_483_647;

/** How much transport text rides a failure. A box can put megabytes on stderr. */
const DETAIL_CHARS = 300;

/**
 * The cap on the echoed approval state — the same bound `status.ts`'s
 * `MAX_APPROVAL_STATE` puts on the same value, for the same reason: it is
 * record-supplied text on its way to an operator's channel, and a hand-edited
 * record can carry anything. Sanitizing here is producer-side defence in depth
 * — the CLI re-sanitizes at the printer (`scripts/fleet.ts`'s `run` handler),
 * and both layers are load-bearing the way any double barrier is.
 */
const MAX_STATE_ECHO = 64;

/**
 * Foreign text — the box's stderr, or a transport exception's message — made
 * safe to carry, in that ORDER: redact, THEN cap. `assertFleetRunId` fixed the
 * same order for its own echo.
 *
 * The order is load-bearing for exactly one of `redactSecrets`'s three arms, and
 * naming which one is the point. Its PREFIX arm survives either order —
 * `SECRET_PREFIX_RE`'s tail is `[…]*`, so a `sk-or-…` sliced down to its bare
 * prefix still matches. Its LONG-TOKEN arm does not: `LONG_TOKEN_RE` requires
 * ≥40 characters, so a 45-character unprefixed credential straddling the cap
 * leaves a 10-character fragment the arm can no longer see, and cap-first ships
 * it. Redacting the whole string first replaces the token with the placeholder
 * before the cap ever runs, so the cap can only truncate placeholder text.
 *
 * `systemctl start`'s stderr is not a credential surface today — it says
 * "Assertion failed for …" or "Unit … not found." — but this is the point where
 * text this process did not compose enters a value it hands to a printer, and
 * that is the point the repo redacts at. `redactSecrets` never throws (it fails
 * closed to the placeholder), so nothing here can fail while reporting.
 */
const boxText = (raw: unknown): string => redactSecrets(raw).slice(0, DETAIL_CHARS);

// ─── the liveness probe (B1/B2: "is this run's engine actually alive?") ───────

/**
 * What systemd says about `qds-run@<runId>.service` right now.
 *
 * `unknown` is the FAIL-CLOSED reading and it covers everything that is not an
 * answer: the probe never ran, the transport died, the budget expired, or
 * `systemctl` printed a word this build does not know. INV-IBOX-7's rule
 * applied to the unit instead of the marker — no evidence is never good news.
 */
export type UnitActivity = "active" | "inactive" | "failed" | "unknown";

/**
 * `systemctl is-active` and nothing else, because the two questions that need
 * it are the same question.
 *
 * `fleet run` needs it because `systemctl start` exiting 0 does NOT mean the
 * engine started: `qds-run@.service` is `Type=simple`, so systemd calls the
 * unit started the instant the process is FORKED, and everything after the fork
 * — `deriveInBoxArgv` throwing on an unreadable `run-context.json`, a
 * non-positive `budgetMs`, an unset HOME, a box dispatch never finished
 * furnishing — is invisible to that exit status. With `Restart=no` the unit
 * simply sits `failed` and no marker is ever written.
 *
 * `fleet status` needs it because an ABSENT marker means four different things
 * (never started, died after the fork, box rebooted so tmpfs `/run` was wiped,
 * marker harvested) and only one of them is "still walking its phases". Absence
 * alone is the reading that made a run report `running` forever.
 *
 * ONE probe for both, here, because the two answers must agree: a start that
 * this file called `started` and a status row that calls the same unit
 * `not-running` seconds later is the two-verdicts-on-one-run contradiction the
 * fleet verbs already refuse elsewhere.
 *
 * No `sudo`: `is-active` is a query, and the steering channel's `sudo -n` is
 * provisioned for the WRITES. Never throws — a liveness probe that can take its
 * caller down is worse than one that says `unknown`.
 *
 * `activating`/`reloading` read as `active` (the unit is coming up, which is
 * the same operator posture as up); `deactivating` reads as `inactive`.
 */
export async function unitActivity(
  driver: StartRunDriver,
  vm: string,
  runId: string,
  timeoutMs: number,
): Promise<UnitActivity> {
  // An argv, never an `sh -c` string — the module header's whole escaping
  // argument, and the same grammar guarantee: the instance name carries no
  // shell metacharacter because `assertFleetRunId` already narrowed the id.
  const argv = ["systemctl", "is-active", runUnitName(runId)];
  let res: ExecResult;
  try {
    const ms = Math.max(1, Math.min(timeoutMs, MAX_START_TIMEOUT_MS));
    const call =
      typeof driver.execTimed !== "function"
        ? driver.exec(vm, argv)
        : driver.execTimed(vm, argv, ms);
    res = await withTimeout(call, ms, "unit-is-active");
  } catch {
    return "unknown";
  }
  // The WORD, not the exit code. `is-active` exits non-zero for `inactive` and
  // for `failed` alike, and it exits non-zero for "no such unit" too — three
  // states one status cannot separate, and the separation is the whole point.
  // The transport's own statuses are read first: 137/255 mean the exec never
  // got an answer, and whatever is on stdout then is not systemd's.
  if (res.exitCode === EXEC_KILLED_EXIT || res.exitCode === EXEC_TRANSPORT_EXIT) return "unknown";
  switch (res.stdout.trim()) {
    case "active":
    case "activating":
    case "reloading":
      return "active";
    case "failed":
      return "failed";
    case "inactive":
    case "deactivating":
      return "inactive";
    default:
      // Includes `unknown` (systemd's own word for a unit it has never loaded)
      // and empty stdout. Neither proves the engine is running OR gone.
      return "unknown";
  }
}

/**
 * Start the run's engine and return.
 *
 * Refuses `run-not-startable` for a run this record says cannot take a start —
 * checked BEFORE the exec, so a refusal touches nothing. NEITHER failure arm
 * throws: an untyped throw reaches the CLI's `report()`, which classifies an
 * unrecognised error as transient = exit 1 = "retry me", and that is the one
 * posture `unit-refused` must never produce.
 *
 * The record read itself DOES throw, and deliberately: `readRecord` preserves
 * the errno, so the CLI's `assertRunExists` has already separated a missing
 * file (exit 4, "no such run") from an unparseable one (exit 5,
 * `record-read-failed`) before this function is reached. Re-classifying it here
 * would be a second copy of that rule.
 */
export async function startRun(
  deps: StartRunDeps,
  runId: string,
  opts: StartRunOptions = {},
): Promise<StartRunResult> {
  // FIRST, matching `statusRun`. The CLI already validates (scripts/fleet.ts),
  // so this is defence in depth rather than a live hole — but `runUnitName`
  // interpolates the id into a systemd instance name on the strength of the
  // grammar, and the guarantee has to be attached to the function that relies
  // on it, not to the one caller that happens to hold it today.
  assertFleetRunId(runId);
  const rec = deps.store.get(runId);
  const state = rec.extensions?.approval?.state;
  // ANY value, including one this build does not know: an unrecognised
  // approval state is not evidence that the box survived, and the fail-safe
  // reading of an unknown state is the refusal, never the start. Sanitized at
  // the PRODUCER — `status.ts` runs the same record field through
  // `sanitizeLabel` before it reaches a row, and `String()` alone would echo
  // control characters and unbounded length out of a hand-edited record.
  if (state !== undefined) return { outcome: "run-not-startable", state: sanitizeLabel(String(state), MAX_STATE_ECHO) };
  if (rec.closedAt !== undefined) return { outcome: "run-not-startable", state: "closed" };
  // The setup gate FAILED on this box. Per INV-5 dispatch then leaves the
  // record OPEN and the box ALIVE with `vmName` set and no approval state — so
  // a gate-failed run passed all three guards above and got an engine, which
  // then walked phases (git commits, LLM spend) on a box that failed assertion
  // A/B/C. The story's premise is a box "already dispatched AND gate-passed";
  // this is the half of that premise nothing was checking.
  //
  // `!== "passed"` would be the stronger rule and is the WRONG one today:
  // dispatch writes `extensions.gate` only on FAILURE (dispatch.ts's `if
  // (!gate.ready)` arm), so a healthy run carries no gate record at all and
  // refusing on its absence would refuse every run there is. The positive
  // "dispatch finished furnishing this box" fact does not exist yet; until it
  // does, the post-start liveness probe below is what catches a start against a
  // box with no manifest — the engine exits non-zero and the unit goes `failed`.
  if (rec.extensions?.gate?.outcome === "failed") return { outcome: "run-not-startable", state: "gate-failed" };
  const vm = rec.vmName;
  if (vm === undefined) return { outcome: "run-not-startable", state: "no-box" };

  // SPREAD, never `requestId: rec.requestId`. The type says optional and the
  // docblock says "absent rather than fabricated", but writing the key
  // unconditionally put `requestId: undefined` on every result of a run that
  // was never dispatched — present-with-undefined, which `toEqual` cannot tell
  // from absent and which `JSON.stringify` drops only by luck. The claim is now
  // structural.
  const requestId = rec.requestId === undefined ? {} : { requestId: rec.requestId };
  const unit = runUnitName(runId);
  const argv = ["sudo", "-n", "systemctl", "start", unit];
  // Clamped at BOTH ends. `StartRunOptions` is a documented seam: the floor
  // keeps a 0/negative budget from refusing the call before the driver can
  // answer (NaN and Infinity never reach it — `Number.isFinite` sends them to
  // the default), and the ceiling keeps a past-32-bit budget from firing in
  // 1 ms, which would hand a caller asking for LONGER the shortest window there
  // is and report `box-unreachable` for every healthy box. See
  // MAX_START_TIMEOUT_MS.
  const timeoutMs = Number.isFinite(opts.timeoutMs)
    ? Math.min(Math.max(1, opts.timeoutMs as number), MAX_START_TIMEOUT_MS)
    : RUN_START_TIMEOUT_MS;
  // Taken BEFORE the start, because the budget below is the VERB's, not the
  // call's: the post-start probe is handed what the start LEFT of it (see the
  // exit-0 arm).
  const startBeganAt = Date.now();

  let res: ExecResult;
  try {
    const call =
      // `typeof … !== "function"`, matching status.ts's `markerReader`. A
      // driver carrying `execTimed: null` passed an `=== undefined` check and
      // then threw a TypeError on the call — caught below and reported as
      // `box-unreachable`, the ONE arm documented as safe to retry, so a
      // permanent driver defect became an unbounded retry loop.
      typeof deps.driver.execTimed !== "function"
        ? deps.driver.exec(vm, argv)
        : deps.driver.execTimed(vm, argv, timeoutMs);
    res = await withTimeout(call, timeoutMs, "engine-start");
  } catch (e) {
    // The host deadline fired, or the transport threw. Either way no job
    // verdict exists — and the start may still be in flight, which is the arm
    // `box-unreachable` documents as safe to retry.
    return {
      outcome: "start-failed",
      reason: "box-unreachable",
      ...requestId,
      // `?? e`, not `?? String(e)`: `redactSecrets` coerces anything without
      // throwing, and `String` on a null-prototype or hostile-`toString`
      // rejection throws inside the reporter (`report`'s own rule).
      //
      // `|| undefined` BEFORE the `??`: `??` falls through on null/undefined
      // only, so `Object.assign(new Error(""), {code:"ECONNRESET"})` yielded
      // `detail: ""` on the one arm whose whole job is explaining an
      // unreachable box. An empty message is no message. (:287 already uses
      // `||` for the same reason on the stderr/stdout pair.)
      detail: boxText(((e as Error | null)?.message || undefined) ?? e),
    };
  }
  if (res.exitCode === 0) {
    // Exit 0 is systemd accepting the JOB, not the engine running. For
    // `Type=simple` the unit is "started" the instant the process is forked, so
    // every post-fork failure — an unreadable `run-context.json`, a
    // non-positive `budgetMs`, an unset HOME, a box dispatch never finished
    // furnishing — left `fleet run` printing `started` and exiting 0 while
    // `Restart=no` held the unit `failed` and no marker was ever written. Exit
    // 0 alone only ever caught the `Assert…=` directives and unit-not-found.
    //
    // So the start is CORROBORATED before it is reported. Only `failed`
    // converts it into a refusal: `inactive` means the process ran and exited
    // (a start that landed — possibly a whole run that finished), and `unknown`
    // means the probe produced no reading, which is not evidence of failure.
    // Neither may manufacture `unit-refused`, the arm the CLI maps to a
    // terminal exit 5.
    //
    // BEST EFFORT by construction, and the docblock says so rather than
    // overclaiming: the probe is a second ssh round trip, so an engine that has
    // not failed YET still reads `active` and reports `started` exactly as
    // before. What it removes is the case where the failure has already
    // happened and the host insisted the engine was running. The clean fix is
    // `Type=exec` in the unit — systemd then holds the start job until the
    // execve succeeds — which is an IMAGE change and out of scope here.
    //
    // The probe gets what the START LEFT of the one budget, never a fresh full
    // one. `timeoutMs` is the verb's per-call deadline and the verb makes TWO
    // sequential substrate calls; handing the probe the whole budget again made
    // the verb's worst case TWO deadlines (~250 s against a "125 s" number) for
    // a verdict the start had already determined — the one boundary in this
    // file where "per-call deadline" quietly became "per-verb 2×". Sliced, and
    // floored at 1 ms exactly as `inBoxState` floors its own second leg: a
    // probe killed at the spawn answers `unknown`, the same fail-closed
    // disposition as not asking, and the arm below says so in its detail.
    const activity = await unitActivity(
      deps.driver,
      vm,
      runId,
      Math.max(1, timeoutMs - (Date.now() - startBeganAt)),
    );
    if (activity === "failed") {
      return {
        outcome: "start-failed",
        reason: "unit-refused",
        ...requestId,
        detail: boxText(
          `systemctl start returned 0 but ${unit} is already \`failed\` — the engine died after the fork (Type=simple reports a start at fork, and Restart=no leaves the unit failed). Read \`journalctl -u ${unit}\` on the box`,
        ),
      };
    }
    if (activity === "unknown") {
      // Not evidence of failure, so the start is still reported — but silently
      // dropping the probe's failure reported a CORROBORATED start the verb
      // never obtained. Every other non-happy arm carries a diagnosis; this one
      // now names the uncorroborated reading so the operator's next command is
      // `fleet status`, not trust.
      return {
        outcome: "started",
        vm,
        unit,
        ...requestId,
        detail: boxText(
          `systemctl start returned 0 but the post-start \`systemctl is-active\` on ${unit} produced no reading, so the start is UNCORROBORATED, not contradicted — read \`fleet status ${runId}\` before spending on this run`,
        ),
      };
    }
    return { outcome: "started", vm, unit, ...requestId };
  }
  // 137/255 are the transport's OWN statuses (`transport.ts:265-266`), not
  // systemctl's: the exec was SIGKILLed at its budget, or ssh never connected.
  // Reading them as a unit refusal would send an operator to audit a systemd
  // policy for a fault the network had — the same three-way split
  // `steeringProvisionFailure` draws one layer down.
  const unreachable = res.exitCode === EXEC_KILLED_EXIT || res.exitCode === EXEC_TRANSPORT_EXIT;
  // stderr first: `systemctl start` says why on stderr ("Assertion failed
  // for …", "Unit … not found."), and that one line is the whole diagnosis
  // for a unit whose `Restart=no` makes the failure terminal. A failure with
  // nothing on EITHER stream carries no detail key at all — the catch arm's
  // own rule (see `|| undefined` above): an empty message is no message, and
  // `detail: ""` is present-but-empty, the exact wart that rule condemns, on
  // the one terminal arm whose whole job is diagnosis.
  const echo = res.stderr.trim() || res.stdout.trim();
  return {
    outcome: "start-failed",
    reason: unreachable ? "box-unreachable" : "unit-refused",
    ...requestId,
    exitCode: res.exitCode,
    ...(echo === "" ? {} : { detail: boxText(echo) }),
  };
}
