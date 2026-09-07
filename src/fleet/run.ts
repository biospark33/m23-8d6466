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
 * That no-op argument covers the IDENTITY question ("is it active?") and
 * nothing else. `failed` is one exception, and it is not a liveness question:
 * only an ACTIVE start is a no-op — `systemctl start` on a unit sitting
 * `failed` from a PRIOR attempt re-runs ExecStart, which forks a second engine
 * over phases that already spent. A COMPLETED run is the second exception and
 * the same shape of hazard: the engine exits after writing its marker, the
 * unit goes `inactive`, and a start on an `inactive` unit re-runs ExecStart
 * exactly as a `failed` one does. So there IS one pre-start probe (see the
 * guard in `startRun`), and it asks TWO questions — `is-active` == `failed`?,
 * and, only on `inactive`, is this run's completion marker still on the box?
 * — refusing on those answers; every other reading falls through to the start
 * as if the probe had not run (`active` is the no-op AC6 relies on — even
 * with a marker under it, that is a healthy engine still walking — and
 * `unknown`, `inactive` without a decidable marker, are not evidence a start
 * is unsafe). Its TOCTOU shape
 * is not the one refused above either: a unit already `failed` cannot become
 * `failed` again in the window (nothing ran), and it does not LEAVE `failed`
 * without an operator's `systemctl reset-failed` — the manual step the
 * refusal's detail names. The marker arm's residual race is the same
 * unwinnable one named above — an engine settling in the gap between the
 * probe and the start — and the marker lives on tmpfs `/run`, so a box
 * reboot after completion wipes it and the guard reads a first start;
 * closing THAT needs a durable in-box artefact, the same limitation
 * `status.ts`'s `not-running` vocabulary documents.
 *
 * Nor `systemctl enable`, ever. The unit deliberately ships with no `[Install]`
 * section, and that absence is the policy: an ENABLED instance is pulled in by
 * multi-user.target on EVERY subsequent boot and re-walks paid phases — the
 * same double-spend `Restart=no` refuses, arriving through a different door.
 */
import type { ExecResult, ProviderDriver } from "../providers/driver.ts";
import { EXEC_KILLED_EXIT, EXEC_TRANSPORT_EXIT } from "../providers/exedev/transport.ts";
import type { RunRecordStore } from "../providers/run-record.ts";
// The READ-path id admission rule, not the mint rule — see `runUnitName` for
// why the distinction is load-bearing here.
import { assertExistingRunId } from "../providers/run-record.ts";
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
// The completion-marker read `fleet status` and the race poller share, imported
// rather than re-derived for status.ts's own reason: the pre-start guard's
// second question must be answered by the SAME classified read, or `fleet run`
// and `fleet status` can disagree about whether one run's marker exists.
// `fanout-primitive.ts` imports neither this module nor `status.ts`, so the
// edge runs one way. `boxMarkerPath(runId)` and not `runMarkerPath()`: the marker
// is probed INSIDE the box (status.ts's same note), per-run since #217 F-D1.
import { boxMarkerPath, readMarkerVerdict } from "./fanout-primitive.ts";

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
 *    post-fork half `Type=simple` hides from the exit status — or the unit was
 *    ALREADY `failed` before this invocation, refused by the pre-start guard
 *    before any job ran (see the module header's carve-out: a start on a
 *    `failed` unit re-runs ExecStart, so this arm is what keeps the
 *    "identical retry" claim below true for it). Permanent for
 *    this box: the identical retry produces the identical failure, so this must
 *    never reach the CLI's exit-1 "retry me".
 *  - `box-unreachable` — no job verdict was obtained at all: the exec was
 *    SIGKILLed at its budget (137), ssh never connected or dropped mid-flight
 *    (255), or the call did not come back and the host deadline fired. This one
 *    IS retryable, and safely so: `withTimeout` cannot cancel the in-box
 *    command, so the start may well have landed — and if it did, the retry is
 *    systemd's no-op for as long as the unit stays ACTIVE, and the
 *    `run-already-complete` refusal once the run has settled; the one shape it
 *    can never be is a second engine.
 *  - `run-already-complete` — the pre-start guard found the unit `inactive`
 *    AND this run's completion marker still on the box: the engine already
 *    ran this run to settlement, and `systemctl start` on an `inactive` unit
 *    re-runs ExecStart — a second engine over phases that already spent,
 *    through the one door AC6's no-op argument never covered (a no-op is an
 *    ACTIVE unit; a COMPLETED one reads `inactive`). Terminal like
 *    `unit-refused`: the marker stays until harvest or an operator removes
 *    it, so the identical retry refuses identically and must never reach the
 *    CLI's exit-1 "retry me".
 */
export type StartRunFailureReason = "unit-refused" | "box-unreachable" | "run-already-complete";

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
 * by grammar, not by luck — see the module header's escaping note — and the
 * grammar check is ATTACHED HERE, at the interpolation point, rather than
 * borrowed from whichever caller happens to hold it. `startRun` and the CLI
 * assert first, but `unitActivity` is also exported for `fleet status`, and
 * this module's own rule (`startRun`'s comment: "the guarantee has to be
 * attached to the function that relies on it") was violated by every consumer
 * that is not `startRun` — an off-grammar id reached the interpolation as a
 * wrong unit lookup reported `inactive`, not as a refusal.
 *
 * The READ-path rule (`assertExistingRunId`: strict grammar plus the legacy
 * tail), not the mint rule (`assertFleetRunId`): `fleet status` sweeps records
 * the older store minted under the tail grammar, and both grammars share the
 * `[a-z0-9-]` class that carries no shell metacharacter and none of the `/`,
 * `.`, `\` or `%` the module header's escaping argument turns on. The mint
 * rule here would have made one legacy record kill the whole `fleet status`
 * sweep. Refuses as the store's typed `InvalidRunIdError` before any exec.
 */
export function runUnitName(runId: string): string {
  assertExistingRunId(runId);
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
 *
 * A CALL bound, not a VERB bound — the honest worst case is ~2× this constant.
 * `startRun` makes up to three sequential substrate calls and only the LAST is
 * budget-sliced (the exit-0 arm's probe); the pre-start guard's `is-active`
 * probe — and, on its `inactive` arm, the marker read, which is sliced against
 * the same window — plus the start itself each carry the full amount, so a box
 * that hangs a status query for the whole window and then hangs the start the
 * same way costs the verb two windows. Deliberate: starving the pre-start legs
 * to milliseconds makes them fail open (see the guard's comment), and a box
 * that eats a full window on `is-active` was dead on arrival anyway.
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

/**
 * DOMESTIC composed text — the detail arms this file writes itself, whose only
 * interpolated values are the runId and the unit name. NOT capped at
 * `DETAIL_CHARS`: that bound exists because "a box can put megabytes on
 * stderr", and these strings are bounded by construction instead — the id is
 * grammar-capped (`RUN_ID_MAX` = 63, asserted at the interpolation point in
 * `runUnitName`), so the longest arm is ~350 chars. Routing composed text
 * through the 300-char cap cut exactly the wrong half: a legal 63-char id
 * pushed the arm past the bound and the slice ended it mid-command, dropping
 * the `journalctl`/`fleet status` instruction that is the arm's entire point.
 * Still REDACTED — the arms quote no secrets, but "text this process hands a
 * printer gets redacted at the producer" is enforced in the same place for
 * composed and foreign text alike.
 */
const composedText = (raw: string): string => redactSecrets(raw);

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
 * provisioned for the WRITES. Never throws FOR A PROBE OUTCOME — a liveness
 * probe that can take its caller down is worse than one that says `unknown`.
 * The one throw it can make is the grammar refusal `runUnitName` raises while
 * building the argv: a typed, pre-exec refusal for an id no unit could be
 * named after, not a probe verdict.
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
  // shell metacharacter because `runUnitName` asserts the id at the
  // interpolation point, so this holds for every caller, not just the ones
  // that asserted first.
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
  // FAIL-CLOSED on the OBJECT, not merely on a present `state`. The old guard
  // (`state !== undefined`) let a torn or hand-edited approval write —
  // `extensions.approval` present with `state` absent (`{}`) or `null` — pass
  // to an engine start, even though the object's PRESENCE means the approval
  // flow touched this record and `requestApproval` runs its real teardown
  // BEFORE any state lands (see the `run-not-startable` docblock): the box may
  // already be gone, and the failure would have been a retryable
  // `box-unreachable` on a dead box instead of this terminal refusal.
  // `closedAt` two lines down already fails safe on the analogous
  // malformation (`null !== undefined` refuses); the approval guard now does
  // too, on both halves at once.
  const approval = rec.extensions?.approval;
  if (approval !== undefined) {
    // `?.`, not `.`: the OBJECT itself can be null on the structural-store
    // seam — `RunRecordStore` is an interface, the file-backed store's
    // read-mode validation refuses the shape, so this is the injected-store
    // path, the same seam every guard in `status.ts` defends. A bare
    // `approval.state` on it threw untyped out of `startRun`, straight into
    // the CLI's transient-retry arm — the one posture this docblock refuses.
    // `null?.state` is `undefined`, which lands in the non-string refusal
    // below alongside `{}` and a non-string `state`.
    const stated: unknown = approval?.state;
    // A STRING is refused whatever it says — including a word this build does
    // not know: an unrecognised approval state is not evidence that the box
    // survived, and the fail-safe reading of an unknown state is the refusal,
    // never the start — and it is echoed sanitized at the PRODUCER, because
    // `status.ts` runs the same record field through `sanitizeLabel` before it
    // reaches a row, and `String()` alone would echo control characters and
    // unbounded length out of a hand-edited record. A NON-STRING (including
    // `null`, and the absent `state` of `{}`) carries no printable word at
    // all, and coercing one fabricated the literals `"null"` and
    // `"[object Object]"` as vocabulary words no writer minted — the exact
    // fabrication that let `fleet status` and `fleet run` render one record
    // with two verdicts. It is refused under the SAME literal `status.ts`
    // renders for a present-but-unreadable state (`status.ts`'s
    // `UNKNOWN_APPROVAL_STATE`). That literal is restated here rather than
    // imported because `status.ts` imports THIS module for `unitActivity` —
    // the edge runs one way — and `MAX_STATE_ECHO` already mirrors
    // `status.ts`'s `MAX_APPROVAL_STATE` locally for the same reason.
    return {
      outcome: "run-not-startable",
      state:
        typeof stated === "string" ? sanitizeLabel(stated, MAX_STATE_ECHO) : "(unknown approval state)",
    };
  }
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
  // Taken BEFORE the verb's FIRST substrate call, because the budget below is
  // the VERB's, not any one call's: the post-start probe is handed what
  // everything before it LEFT of the one budget (see the exit-0 arm).
  const startBeganAt = Date.now();

  // PRE-START, `failed` or already-complete — the module header's carve-outs,
  // not the "is it already running?" probe AC6 refuses. `systemctl start` is a
  // no-op on an ACTIVE unit but RE-RUNS ExecStart on a `failed` one, so without
  // this guard a re-issued `fleet run` over a post-fork death forked a second
  // engine over phases whose commits and spend already happened — while the
  // CLI's remediation called the retry inert. Refused here, BEFORE the start,
  // as `unit-refused`: no job ran this invocation (so no `exitCode` — one
  // would be `is-active`'s own exit 3 wearing the start's clothes), and the
  // state is terminal until an operator resets it, which the detail names.
  // Fail-OPEN on every other reading by design: `active` falls through to the
  // no-op start AC6 relies on, and `unknown` is not evidence a start is
  // unsafe — a slow probe must not convert a healthy start into a refusal.
  // The probe is a status QUERY with no systemd job behind it, so it carries
  // the verb budget but no ceiling of its own; the verb's worst case grows a
  // second full window only on a box that hung answering `is-active`, which
  // was dead on arrival anyway.
  const preStart = await unitActivity(deps.driver, vm, runId, timeoutMs);
  if (preStart === "failed") {
    return {
      outcome: "start-failed",
      reason: "unit-refused",
      ...requestId,
      detail: composedText(
        `${unit} is already \`failed\` from a prior attempt — \`systemctl start\` is a no-op only on an ACTIVE unit, so re-running \`fleet run\` would re-run ExecStart and fork a second engine over phases that already spent. Read \`fleet status ${runId}\`; to start again, run \`sudo systemctl reset-failed ${unit}\` on the box first`,
      ),
    };
  }
  // The SECOND carve-out, asked only on `inactive`: `inactive` is also a FIRST
  // start's reading (dispatched, `fleet run` never invoked), so the unit alone
  // cannot refuse — the completion marker is the one artefact that says this
  // run already settled, and it is read with the SAME classified read
  // `fleet status` acts on (`readMarkerVerdict`, this runId as the expected
  // owner) so the two verbs can never disagree about whose marker it is. Only
  // `settled` refuses — the DECISIVE reading that the marker parsed and names
  // THIS run. `unusable` (present but unjudgeable — corruption, or a marker
  // naming another run) and `skip` stay fail-OPEN: a marker that cannot be
  // tied to this run cannot prove this run settled, and refusing on it would
  // convert a startable run into a refusal off someone ELSE's bytes. A marker
  // under an `active` unit never reaches this read — that is a healthy engine
  // still walking, exactly the case AC6's no-op exists for.
  //
  // SLICED from what the `is-active` probe left of the one verb budget, like
  // the post-start probe below: a healthy box answers `is-active` in
  // milliseconds, so the read keeps essentially the whole window, while a box
  // that hung the full budget on a status query leaves 1 ms — the read is
  // killed at the spawn, `skip`s, and the start proceeds into a box that was
  // dead on arrival anyway. Unsliced, the verb's worst case grew a THIRD full
  // window; sliced, it stays at the ~2× RUN_START_TIMEOUT_MS's comment states.
  if (preStart === "inactive") {
    const marker = await readMarkerVerdict(
      deps.driver,
      vm,
      boxMarkerPath(runId),
      Math.max(1, timeoutMs - (Date.now() - startBeganAt)),
      runId,
    );
    if (marker.kind === "settled") {
      return {
        outcome: "start-failed",
        reason: "run-already-complete",
        ...requestId,
        detail: composedText(
          `${unit} is \`inactive\` and this run's completion marker is still on the box (read as ${marker.ok ? "ok" : "not-ok"}) — the engine already ran this run to settlement, and \`systemctl start\` on an INACTIVE unit re-runs ExecStart, forking a second engine over phases that already spent. Read \`fleet status ${runId}\` and harvest the artifacts if you need them; a fresh pass over the same work needs a new dispatch`,
        ),
      };
    }
  }

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
    //
    // The `.message` ACCESS is itself guarded: a rejection whose `message`
    // getter throws (null-prototype or hostile-`toString` object) made the
    // extraction throw INSIDE this catch arm, and the escape was an untyped
    // throw out of `startRun` — the CLI's exit-1 "retry me" on a permanent
    // driver defect, the exact posture this function's docblock refuses.
    // `status.ts`'s `safeDiagnostic` wraps its `.message` read for the same
    // reason; a failed extraction just falls to `?? e` below, and
    // `redactSecrets` coerces anything without throwing.
    let message: string | undefined;
    try {
      message = (e as Error | null)?.message || undefined;
    } catch {
      message = undefined;
    }
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
      // `||` for the same reason on the stderr/stdout pair.) And the THIRD
      // fallthrough: a rejection that is itself nullish (`reject()`,
      // `reject(undefined)`) left `message ?? e` nullish and `redactSecrets`
      // coerced it to `""` — present-but-empty again, on the same arm — so a
      // nullish rejection composes a real sentence instead.
      detail: boxText(message ?? e ?? "transport rejected with no message"),
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
    // The probe gets what everything BEFORE it left of the one budget, never a
    // fresh full one. `timeoutMs` is the verb's per-call deadline and the verb
    // makes THREE sequential substrate calls (the pre-start guard, the start,
    // this probe); handing the last one the whole budget again made the verb's
    // worst case TWO deadlines (~250 s against a "125 s" number) for a verdict
    // the start had already determined — the one boundary in this file where
    // "per-call deadline" quietly became "per-verb 2×". Sliced, and floored at
    // 1 ms exactly as `inBoxState` floors its own second leg: a probe killed at
    // the spawn answers `unknown`, the same fail-closed disposition as not
    // asking, and the arm below says so in its detail.
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
        detail: composedText(
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
        detail: composedText(
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
  // `sudo -n`'s own policy refusal — a box whose sudoers lost the NOPASSWD
  // rule `driver.ts` provisions at box creation — exits 1 with "a password is
  // required" on stderr: the SAME exit code as a systemd job failure, so the
  // code cannot separate the two and the words must. It stays `unit-refused`
  // (terminal — the identical retry hits the identical policy), but the raw
  // stderr alone steered the operator at `AssertPathExists=`/wrong-image
  // audits for a fault that is host-side privilege config; the composed arm
  // names the sudoers repair instead. Only on the non-transport arm: 137/255
  // mean the exec never got systemctl's — or sudo's — answer at all.
  if (!unreachable && /a password is required/i.test(echo)) {
    return {
      outcome: "start-failed",
      reason: "unit-refused",
      ...requestId,
      exitCode: res.exitCode,
      detail: composedText(
        `sudo -n could not ask for a password (exit ${res.exitCode}) — the start never reached systemd. The box's sudoers lost the NOPASSWD rule it was provisioned with (the steering channel's \`sudo -n install -d\` depends on the same rule); restore it on the box before retrying`,
      ),
    };
  }
  return {
    outcome: "start-failed",
    reason: unreachable ? "box-unreachable" : "unit-refused",
    ...requestId,
    exitCode: res.exitCode,
    ...(echo === "" ? {} : { detail: boxText(echo) }),
  };
}
