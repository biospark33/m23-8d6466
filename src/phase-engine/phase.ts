/**
 * The phase lifecycle primitive and the run that walks it (Story DF1.1).
 *
 * One lifecycle wrapper serves all three phase kinds — no per-kind subclass, no
 * phase registry. What it guarantees:
 *
 *  - **Success is earned.** `Run.phase` writes the row as `fail` before the body
 *    runs and promotes to `success` only on the clean-exit branch. No path
 *    downgrades an optimistic `success` after the fact, so a throw, a rejected
 *    promise, a signal or a hard kill all leave `fail` behind.
 *  - **The walk halts on the first non-success.** A phase that overflows or
 *    throws halts the run; phases declared after it are never constructed and
 *    write no row at all — not `fail`, not `skipped`, absence (AC6).
 *  - **One settle.** `Run.finish(accepted)` settles the journal row, the banner
 *    and the exit code together, and writes the terminal marker, so the four
 *    cannot disagree.
 */
import {
  type PhaseJournal,
  writeTerminalMarker,
} from "./journal.ts";
import { redactSecrets } from "../../cli-anything/src/redact.ts";
import { EXIT_STATUSES } from "../../cli-anything/src/types.ts";
import { PhaseAgentSchema } from "./manifest.ts";
import {
  CANCEL_GRACE_MS,
  type ExitStatus,
  MAX_MAX_DURATION_MS,
  type PhaseParams,
  type PhaseRecord,
  type PhaseSubTimings,
  type PhaseSpec,
  type RunContext,
  type RunOutcome,
  descriptionDefect,
  formatZodIssue,
  sanitizeForMessage,
} from "./types.ts";

/** Thrown at construction, before any row reaches the journal (AC3). */
export class PhaseConstructionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PhaseConstructionError";
  }
}

/** Thrown when a phase is opened on a run the walk has already halted (AC6). */
export class RunHaltedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RunHaltedError";
  }
}

/** The abort reason when the engine's own per-attempt timer fires (INV-3). */
export class PhaseOverflowError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PhaseOverflowError";
  }
}

/** The abort reason when SIGTERM/SIGINT is converted to a terminating exception. */
export class RunTerminatedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RunTerminatedError";
  }
}

export interface PhaseBodyContext {
  /** Aborted on overflow and on signal; the body owns cancelling its subprocess tree. */
  signal: AbortSignal;
  phaseId: string;
  params: PhaseParams;
  ctx: RunContext;
}

export type PhaseBody<T> = (bodyCtx: PhaseBodyContext) => Promise<T> | T;

export interface PhaseOutcome<T> {
  phaseId: string;
  name: string;
  status: "fail" | "success";
  exitStatus: ExitStatus;
  durationMs: number;
  value?: T;
  error?: unknown;
}

/** AC3, at construction. The rule itself lives in `types.ts`; the loader applies it too. */
export function assertLegibleDescription(name: string, description: string): void {
  const defect = descriptionDefect(name, description);
  if (defect !== null) {
    throw new PhaseConstructionError(`phase '${sanitizeForMessage(name)}': ${defect}`);
  }
}

export interface RunOptions {
  ctx: RunContext;
  journal: PhaseJournal;
  /** `manifest_load_ms` for the observability contract. */
  manifestLoadMs?: number;
  /** Structured log sink; defaults to one JSON object per line on stderr. */
  log?: (line: Record<string, unknown>) => void;
}

export interface FinishResult extends RunOutcome {
  exitCode: number;
  banner: string;
}

/** Caps on persisted error text; the journal rewrites itself in full on every write. */
const ERROR_MESSAGE_CAP = 4_096;
const ERROR_STACK_CAP = 8_192;

/** Membership set over the canonical EXIT_STATUSES taxonomy (same derivation
 * as team-event-adapter's isExitStatus — kept local so the core engine doesn't
 * import a phase adapter). A body value's declared `exitStatus` is honored as
 * the phase verdict only when it is one of these five strings. */
const EXIT_STATUS_SET: ReadonlySet<string> = new Set(EXIT_STATUSES);

/**
 * A body's error text reaches both the journal and the log, and INV-4 says
 * credentials never transit a journal record. Bodies spawn processes and call
 * APIs, so their messages routinely quote environment-derived material — route
 * every persisted string through the repo's existing parent-env redactor.
 */
function scrubErrorText(text: string, cap: number): string {
  const parentEnv: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (typeof v === "string") parentEnv[k] = v;
  }
  return redactSecrets(text, parentEnv).slice(0, cap);
}

function toErrorShape(err: unknown): { code: string; message: string; stack?: string } {
  if (err instanceof Error) {
    return {
      code: err.name,
      message: scrubErrorText(err.message, ERROR_MESSAGE_CAP),
      ...(err.stack ? { stack: scrubErrorText(err.stack, ERROR_STACK_CAP) } : {}),
    };
  }
  return { code: "NonError", message: scrubErrorText(String(err), ERROR_MESSAGE_CAP) };
}

export class Run {
  private readonly ctx: RunContext;
  private readonly journal: PhaseJournal;
  private readonly manifestLoadMs: number;
  private readonly log: (line: Record<string, unknown>) => void;
  private index = 0;
  private halted = false;
  private settled = false;
  private current: AbortController | undefined;
  private terminating: RunTerminatedError | undefined;

  constructor(opts: RunOptions) {
    this.ctx = opts.ctx;
    this.journal = opts.journal;
    this.manifestLoadMs = opts.manifestLoadMs ?? 0;
    this.log =
      opts.log ?? ((line) => process.stderr.write(`${JSON.stringify(line)}\n`));
  }

  /** True once a phase has failed; the walk is over and no further phase opens. */
  get isHalted(): boolean {
    return this.halted;
  }

  /**
   * SIGTERM/SIGINT converted to a terminating exception: the in-flight phase's
   * signal is aborted so the handler closes the run and settles its rows, rather
   * than leaving the journal claiming work is in flight that is already dead.
   */
  terminate(reason: string): void {
    this.terminating = new RunTerminatedError(`run terminated: ${reason}`);
    this.halted = true;
    this.current?.abort(this.terminating);
  }

  async phase<T>(params: PhaseParams, body: PhaseBody<T>): Promise<PhaseOutcome<T>> {
    if (this.settled) {
      throw new RunHaltedError(`run ${this.ctx.runId} has already finished; no further phase may open`);
    }
    // `params.name` is manifest-controlled and reaches every message below
    // verbatim; sanitized once here rather than at each interpolation site so
    // a newline in it cannot forge extra log/journal lines anywhere in this
    // method (structured fields like `record.name` below are JSON-serialized
    // and stay on the raw value — only free-text messages need the escape).
    const safeName = sanitizeForMessage(params.name);
    if (this.halted) {
      // AC6: absence, not a `fail` or `skipped` row. Nothing is constructed.
      throw new RunHaltedError(`run ${this.ctx.runId} halted before phase '${safeName}'; no record is written`);
    }
    if (this.current !== undefined) {
      // The port requires strictly ordered writes and one reachable in-flight
      // controller; concurrent phases would break both silently.
      throw new RunHaltedError(
        `run ${this.ctx.runId}: a phase is already in flight; phases are strictly ordered`,
      );
    }

    // Construction-time validation runs before any row reaches the journal.
    assertLegibleDescription(params.name, params.description);
    if (params.agent !== undefined) {
      // DF1.3 keys its session cache on this identity, so it is validated
      // against the closed schema here rather than trusted as an erased type.
      const agent = PhaseAgentSchema.safeParse(params.agent);
      if (!agent.success) {
        throw new PhaseConstructionError(
          // Same sink as manifest.ts's validation-failure message: PhaseAgentSchema
          // is `.strict()` too, so an unrecognized key in `params.agent` embeds
          // its raw text in the issue's `message`, not just `path`.
          `phase '${safeName}': invalid agent — ${agent.error.issues.map(formatZodIssue).join("; ")}`,
        );
      }
    }
    if (
      !Number.isSafeInteger(params.maxDurationMs) ||
      params.maxDurationMs <= 0 ||
      params.maxDurationMs > MAX_MAX_DURATION_MS
    ) {
      throw new PhaseConstructionError(
        `phase '${safeName}': maxDurationMs must be 1..${MAX_MAX_DURATION_MS}, got ${params.maxDurationMs}`,
      );
    }

    const phaseId = `${this.ctx.runId}:${this.index}:${params.name}`;
    this.index += 1;
    const startedAt = new Date().toISOString();
    const record: PhaseRecord = {
      runId: this.ctx.runId,
      requestId: this.ctx.requestId,
      pipelineId: this.ctx.pipelineId,
      phaseId,
      name: params.name,
      kind: params.kind,
      // Default-fail at the record model, independently of the journal's own default.
      status: "fail",
      startedAt,
      updatedAt: startedAt,
    };
    const journalStarted = performance.now();
    this.journal.writePhase(record);
    const openWriteMs = performance.now() - journalStarted;

    const controller = new AbortController();
    this.current = controller;
    // `maxDurationMs` is per attempt: this timer is armed for the one attempt
    // this story runs. DF1.3's retry loop arms a fresh one per attempt.
    let overflowed = false;
    const timer = setTimeout(() => {
      overflowed = true;
      controller.abort(new PhaseOverflowError(`phase '${safeName}' exceeded ${params.maxDurationMs} ms`));
    }, params.maxDurationMs);

    let graceTimer: ReturnType<typeof setTimeout> | undefined;
    const bodyStarted = performance.now();
    let outcome: { value: T } | { error: unknown } | "unsettled";
    try {
      const settledBody = (async () => body({ signal: controller.signal, phaseId, params, ctx: this.ctx }))()
        .then((value) => ({ value }) as const)
        .catch((error) => ({ error }) as const);
      // A body that ignores its signal must not hang the run: after the abort we
      // wait a bounded grace for cancellation (including any owned subprocess
      // tree) and then record the failure regardless.
      const grace = new Promise<"unsettled">((resolve) => {
        if (controller.signal.aborted) {
          graceTimer = setTimeout(() => resolve("unsettled"), CANCEL_GRACE_MS);
          return;
        }
        controller.signal.addEventListener(
          "abort",
          () => {
            graceTimer = setTimeout(() => resolve("unsettled"), CANCEL_GRACE_MS);
          },
          { once: true },
        );
      });
      outcome = await Promise.race([settledBody, grace]);
    } finally {
      clearTimeout(timer);
      if (graceTimer !== undefined) clearTimeout(graceTimer);
      this.current = undefined;
    }
    const bodyMs = performance.now() - bodyStarted;

    const aborted = controller.signal.aborted;

    // DF1.6 Observability Contract: a body whose value carries stream-health
    // counters and/or dispatch sub-timings (as the dispatch_task phase body's
    // value does) gets them merged onto the phase record. Additive: values
    // without those fields are recorded unchanged. Not gated on the success
    // branch — the counters are truthful whatever verdict the phase settles.
    const metricsValue =
      outcome !== "unsettled" && "value" in outcome && typeof outcome.value === "object" && outcome.value !== null
        ? (outcome.value as unknown)
        : null;
    const metrics =
      metricsValue !== null && typeof metricsValue === "object"
        ? (metricsValue as {
            malformedLines?: number;
            droppedOversizeLines?: number;
            dispatchSubTimings?: Partial<PhaseSubTimings>;
          })
        : {};

    // Verdict honesty: a body value may carry the phase's OWN classified
    // verdict — dispatch_task's DispatchTaskValue is a MergedOutput whose
    // `exitStatus` is the precedence-classified dispatch result. AC5/key/
    // roster-gate refusals AND non-success run classifications all RETURN as
    // values by DF1.6 design (schema-validated step output; the body never
    // throws a refusal), so "clean return" is not proof of success. A clean
    // return promotes ONLY a success verdict; any other valid declared status
    // settles the phase fail with the value's status + error — otherwise the
    // journal shows a refused or failed dispatch as a green phase and the run
    // settles ok/exit 0. Membership-validated against EXIT_STATUSES (a garbage
    // string cannot steer the verdict); values that declare no exitStatus
    // (runCommand's {exitCode, stdoutTail}, DF1.3's AgentPhaseResult) are
    // untouched.
    const declaredStatus =
      metricsValue !== null &&
      typeof (metricsValue as { exitStatus?: unknown }).exitStatus === "string" &&
      EXIT_STATUS_SET.has((metricsValue as { exitStatus: string }).exitStatus)
        ? ((metricsValue as { exitStatus: ExitStatus }).exitStatus)
        : undefined;
    const verdictFailed =
      !aborted && declaredStatus !== undefined && declaredStatus !== "success";
    const clean = outcome !== "unsettled" && "value" in outcome && !aborted && !verdictFailed;
    const exitStatus: ExitStatus = clean
      ? "success"
      : verdictFailed && declaredStatus !== undefined
        ? declaredStatus
        : overflowed
          ? "overflow"
          : this.terminating
            ? "transient"
            : "logic";
    const declaredError =
      verdictFailed && metricsValue !== null
        ? (metricsValue as { error?: unknown }).error
        : undefined;
    const error =
      outcome === "unsettled"
        ? new Error(`phase '${safeName}' did not cancel within ${CANCEL_GRACE_MS} ms`)
        : "error" in outcome
          ? // A body that rejects with `undefined` (`throw undefined`,
            // `Promise.reject(undefined)`) must not vanish into a bare fail/logic
            // record with no explanation — normalize it to a real Error so the
            // `error === undefined` checks below don't mistake "rejected with no
            // reason" for "there is no error".
            (outcome.error ?? new Error(`phase '${safeName}' rejected without a reason`))
          : verdictFailed
            ? // The value's MergedError carries the real refusal/classification
              // reason (redacted at the dispatch boundary); a verdict without an
              // error message still fails with a legible record, never silently.
              new Error(
                declaredError !== null &&
                  typeof declaredError === "object" &&
                  typeof (declaredError as { message?: unknown }).message === "string"
                  ? (declaredError as { message: string }).message
                  : `phase '${safeName}' returned exitStatus '${declaredStatus ?? "unknown"}'`,
              )
            : aborted
              ? (controller.signal.reason ?? new Error(`phase '${safeName}' was aborted`))
              : undefined;
    const settledRecord: PhaseRecord = {
      ...record,
      updatedAt: new Date().toISOString(),
      durationMs: Math.round(bodyMs),
      ...(error === undefined ? {} : { error: toErrorShape(error) }),
      ...(metrics.malformedLines !== undefined &&
        Number.isFinite(metrics.malformedLines) &&
        metrics.malformedLines >= 0 &&
        Number.isInteger(metrics.malformedLines)
        ? { malformedLines: metrics.malformedLines }
        : {}),
      ...(metrics.droppedOversizeLines !== undefined &&
        Number.isFinite(metrics.droppedOversizeLines) &&
        metrics.droppedOversizeLines >= 0 &&
        Number.isInteger(metrics.droppedOversizeLines)
        ? { droppedOversizeLines: metrics.droppedOversizeLines }
        : {}),
      subTimings: {
        // Body-supplied dispatch timings first — the engine-owned trio below
        // is authoritative and cannot be clobbered by a body value that
        // (buggily) repeats one of these keys. Whitelist only the four documented
        // PhaseSubTimings keys (mulch_prime_ms, box_setup_ms, team_execution_ms,
        // gate_validation_ms); unknown keys are dropped rather than spread.
        ...(metrics.dispatchSubTimings?.mulch_prime_ms !== undefined &&
        Number.isFinite(metrics.dispatchSubTimings.mulch_prime_ms) &&
        metrics.dispatchSubTimings.mulch_prime_ms >= 0
          ? { mulch_prime_ms: metrics.dispatchSubTimings.mulch_prime_ms }
          : {}),
        ...(metrics.dispatchSubTimings?.box_setup_ms !== undefined &&
        Number.isFinite(metrics.dispatchSubTimings.box_setup_ms) &&
        metrics.dispatchSubTimings.box_setup_ms >= 0
          ? { box_setup_ms: metrics.dispatchSubTimings.box_setup_ms }
          : {}),
        ...(metrics.dispatchSubTimings?.team_execution_ms !== undefined &&
        Number.isFinite(metrics.dispatchSubTimings.team_execution_ms) &&
        metrics.dispatchSubTimings.team_execution_ms >= 0
          ? { team_execution_ms: metrics.dispatchSubTimings.team_execution_ms }
          : {}),
        ...(metrics.dispatchSubTimings?.gate_validation_ms !== undefined &&
        Number.isFinite(metrics.dispatchSubTimings.gate_validation_ms) &&
        metrics.dispatchSubTimings.gate_validation_ms >= 0
          ? { gate_validation_ms: metrics.dispatchSubTimings.gate_validation_ms }
          : {}),
        // `this.index` was incremented above, so `1` identifies the first phase —
        // the only one whose wall-clock includes the manifest load.
        manifest_load_ms: Math.round(this.index === 1 ? this.manifestLoadMs : 0),
        phase_body_ms: Math.round(bodyMs),
        journal_write_ms: Math.round(openWriteMs),
      },
    };
    // Re-written as `fail`; promotion is the only path to `success`.
    const settleStarted = performance.now();
    this.journal.writePhase(settledRecord);
    if (clean) {
      this.journal.promotePhase(phaseId, "success", "success");
    } else {
      this.journal.promotePhase(phaseId, "fail", exitStatus);
      this.halted = true;
    }
    // The settle writes are the expensive ones (the journal rewrites the whole
    // file), but they cannot appear inside the row they are writing. The
    // persisted row therefore carries the write cost observed up to that point;
    // the log line below carries the phase's complete journal cost.
    const totalWriteMs = openWriteMs + (performance.now() - settleStarted);

    this.log({
      requestId: this.ctx.requestId,
      pipelineId: this.ctx.pipelineId,
      phase: params.name,
      kind: params.kind,
      timestamp: settledRecord.updatedAt,
      durationMs: settledRecord.durationMs,
      status: clean ? "success" : "fail",
      exitStatus,
      ...(error === undefined ? {} : { error: toErrorShape(error) }),
      subTimings: {
        ...settledRecord.subTimings,
        journal_write_ms: Math.round(totalWriteMs),
      },
    });

    return {
      phaseId,
      name: params.name,
      status: clean ? "success" : "fail",
      exitStatus,
      durationMs: Math.round(bodyMs),
      ...(clean && outcome !== "unsettled" && "value" in outcome ? { value: outcome.value } : {}),
      ...(error === undefined ? {} : { error }),
    };
  }

  /**
   * Settles journal row, banner, exit code and terminal marker in one call.
   * `ok = phases.length > 0 && every phase succeeded && accepted`.
   */
  finish(accepted: boolean): FinishResult {
    if (this.settled) {
      throw new RunHaltedError(`run ${this.ctx.runId} has already been finished`);
    }
    this.settled = true;
    // A terminated run is never ok, even if the signal landed between phases and
    // no row was failed. The engine owns that rule — a caller of the library
    // primitive must not have to remember it.
    const outcome = this.journal.finish(this.ctx.runId, accepted && this.terminating === undefined);
    try {
      writeTerminalMarker(this.ctx.runId, outcome);
    } catch (err) {
      // The journal already says `ok`; without a marker the poller reads the run
      // as unfinished and the caller exits "never settled". Force the journal
      // back to not-ok so the three cannot disagree in the optimistic direction.
      try {
        this.journal.finish(this.ctx.runId, false);
      } catch {
        // The marker failure is the one worth reporting; a journal that also
        // cannot be written is already covered by the throw below.
      }
      throw err;
    }
    const banner = `RUN ${this.ctx.runId} pipeline=${this.ctx.pipelineId} ok=${outcome.ok} accepted=${accepted} phases=${this.index} completedAt=${outcome.completedAt}`;
    return { ...outcome, exitCode: outcome.ok ? 0 : 1, banner };
  }
}

/** Builds the body for a declared phase. The seam a test spies on to prove a phase was never constructed. */
export type PhaseBodyFactory = (spec: PhaseSpec, index: number) => PhaseBody<unknown>;

/**
 * Walks the manifest's phases in order, halting on the first non-success.
 * Does not settle the run — the caller owns `accepted` and calls `finish`.
 */
export async function walkPhases(
  run: Run,
  phases: readonly PhaseSpec[],
  makeBody: PhaseBodyFactory,
): Promise<PhaseOutcome<unknown>[]> {
  const outcomes: PhaseOutcome<unknown>[] = [];
  for (const [index, spec] of phases.entries()) {
    if (run.isHalted) break;
    const outcome = await run.phase(spec, makeBody(spec, index));
    outcomes.push(outcome);
    if (outcome.status !== "success") break;
  }
  return outcomes;
}
