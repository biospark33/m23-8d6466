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
 * ## Why no host-side "is it already running?" check
 *
 * AC6. `systemctl start` on an already-active instance is a NO-OP, so a second
 * `fleet run` starts no second engine — the window is closed by systemd's unit
 * IDENTITY, not by anything this file could observe. A host-side probe would be
 * strictly worse: it is a TOCTOU window (the answer can change between the
 * probe and the start) bought with an extra round trip, and it would have to
 * decide what to do about a race it cannot win. What this module owes AC6
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
 *    ExecStart that is not there. Permanent for this box: the identical retry
 *    produces the identical failure, so this must never reach the CLI's exit-1
 *    "retry me".
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
  | { outcome: "started"; vm: string; unit: string; requestId?: string }
  | {
      /**
       * Refused on the RECORD, before any exec — so the box (if it still
       * exists) was never touched. Mirrors `attachToRun`'s arm of the same
       * name, on the same evidence: `requestApproval` runs the real teardown
       * BEFORE it promotes to any approval state, so `vmName` outlives the box
       * and an approval state means the box is gone.
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
 * 120 s keeps ~30 s of headroom for the ssh round trip and systemd's job queue
 * while staying well under a caller that waits forever. `--no-block` is NOT the
 * alternative: it returns before the unit is confirmed started and throws away
 * the failure signal `fleet run` exists to surface.
 */
export const RUN_START_TIMEOUT_MS = 120_000;

/** How much transport text rides a failure. A box can put megabytes on stderr. */
const DETAIL_CHARS = 300;

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
 * Start the run's engine and return.
 *
 * Refuses `run-not-startable` for a run whose box is gone — checked BEFORE the
 * exec, so a refusal touches nothing. NEITHER failure arm throws: an untyped
 * throw reaches the CLI's `report()`, which classifies an unrecognised error as
 * transient = exit 1 = "retry me", and that is the one posture `unit-refused`
 * must never produce.
 */
export async function startRun(
  deps: StartRunDeps,
  runId: string,
  opts: StartRunOptions = {},
): Promise<StartRunResult> {
  const rec = deps.store.get(runId);
  const state = rec.extensions?.approval?.state;
  // ANY value, including one this build does not know: an unrecognised
  // approval state is not evidence that the box survived, and the fail-safe
  // reading of an unknown state is the refusal, never the start.
  if (state !== undefined) return { outcome: "run-not-startable", state: String(state) };
  if (rec.closedAt !== undefined) return { outcome: "run-not-startable", state: "closed" };
  const vm = rec.vmName;
  if (vm === undefined) return { outcome: "run-not-startable", state: "no-box" };

  const requestId = rec.requestId;
  const unit = runUnitName(runId);
  const argv = ["sudo", "-n", "systemctl", "start", unit];
  // Floored: `StartRunOptions` is a documented seam, and a 0 or NaN budget
  // refuses the call before the driver can answer.
  const timeoutMs = Number.isFinite(opts.timeoutMs) ? Math.max(1, opts.timeoutMs as number) : RUN_START_TIMEOUT_MS;

  let res: ExecResult;
  try {
    const call =
      deps.driver.execTimed === undefined
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
      requestId,
      // `?? e`, not `?? String(e)`: `redactSecrets` coerces anything without
      // throwing, and `String` on a null-prototype or hostile-`toString`
      // rejection throws inside the reporter (`report`'s own rule).
      detail: boxText((e as Error | null)?.message ?? e),
    };
  }
  if (res.exitCode === 0) return { outcome: "started", vm, unit, requestId };
  // 137/255 are the transport's OWN statuses (`transport.ts:265-266`), not
  // systemctl's: the exec was SIGKILLed at its budget, or ssh never connected.
  // Reading them as a unit refusal would send an operator to audit a systemd
  // policy for a fault the network had — the same three-way split
  // `steeringProvisionFailure` draws one layer down.
  const unreachable = res.exitCode === EXEC_KILLED_EXIT || res.exitCode === EXEC_TRANSPORT_EXIT;
  return {
    outcome: "start-failed",
    reason: unreachable ? "box-unreachable" : "unit-refused",
    requestId,
    exitCode: res.exitCode,
    // stderr first: `systemctl start` says why on stderr ("Assertion failed
    // for …", "Unit … not found."), and that one line is the whole diagnosis
    // for a unit whose `Restart=no` makes the failure terminal.
    detail: boxText(res.stderr.trim() || res.stdout.trim()),
  };
}
