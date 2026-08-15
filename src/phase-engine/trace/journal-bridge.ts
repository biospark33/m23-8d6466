/**
 * TracingJournal implements PhaseJournal port (Story DF1.4 Wave 3).
 *
 * Delegates every PhaseJournal op to inner journal AND forwards to Tracer.
 * Tracer errors never break the run — AC5 discipline: wrap every tracer forward
 * in try/catch, surface via onTraceError, and continue with inner journal.
 *
 * The four ops maintain unchanged signatures/semantics per journal.ts header.
 */
import type { PhaseJournal } from "../journal.ts";
import type { GateEvent, PhaseRecord, PhaseStatus, RunContext } from "../types.ts";
import type { Tracer, TracerError } from "./tracer.ts";
import { coherentStartedAt, serializeTraceError } from "./tracer.ts";

// AC5: a broken/closed stderr (EPIPE — piped to head, fd closed by a
// supervisor) reports its failure asynchronously via the stream's 'error'
// event; a synchronous try/catch around write() never sees it, and an
// unhandled 'error' kills the process. One listener at module scope makes
// tracer error reporting unable to break the run.
//
// This no-op listener is process-wide: importing this module installs it on
// process.stderr for the lifetime of the process. That is intentional AC5
// defense (an unhandled 'error' event on a stream kills the process), and it
// suppresses crash-on-EPIPE for every stderr writer in the process, not just
// this module — it also guards phase.ts's default logger and any other stderr
// writer.
process.stderr.on("error", () => {});

/** Error handler for tracer failures (AC5). Exported for testing. */
export function onTraceError(err: TracerError, requestId: string): void {
  try {
    // Log structured error to stderr, never throw — and a closed/broken
    // stderr (EPIPE) must not turn a tracer failure into a run failure.
    // Shared field names/defaults come from serializeTraceError so this sink
    // cannot drift from the runner's run-level failure log.
    process.stderr.write(
      `${JSON.stringify({
        requestId,
        level: "warn",
        event: "trace_error",
        ...serializeTraceError(err),
        error: {
          code: err.code,
          message: err.message,
          ...(err.stack ? { stack: err.stack } : {}),
        },
      })}\n`,
    );
  } catch {
    /* nowhere left to report — swallowing is the AC5 contract */
  }
}

/**
 * TracingJournal wraps a PhaseJournal with Tracer forwarding.
 * Constructor(inner: PhaseJournal, tracer: Tracer, ctx: RunContext).
 */
export class TracingJournal implements PhaseJournal {
  private phaseSeq = 0;
  /**
   * phaseId → seq assigned at first observation. phase.ts writes each phase
   * twice (open, then the settled record) — the second write is a row update,
   * not a new phase, so it must reuse the seq and must not re-emit
   * phase_start.
   */
  private readonly phaseSeqs = new Map<string, number>();

  constructor(
    private readonly inner: PhaseJournal,
    private readonly tracer: Tracer,
    private readonly ctx: RunContext,
  ) {}

  writePhase(record: PhaseRecord): void {
    // Delegate to inner first (must not throw)
    this.inner.writePhase(record);

    // Forward to tracer — never let tracer errors break the run
    try {
      const existingSeq = this.phaseSeqs.get(record.phaseId);
      const isFirstObservation = existingSeq === undefined;
      const seq = existingSeq ?? this.phaseSeq++;
      if (isFirstObservation) {
        this.phaseSeqs.set(record.phaseId, seq);
      }

      // Upsert phases row (insert on first observation, update on settle)
      this.tracer.upsertPhase({
        requestId: this.ctx.requestId,
        phaseId: record.phaseId,
        seq,
        name: record.name,
        kind: record.kind,
        status: "fail", // default-fail
        startedAt: record.startedAt,
        error: record.error ? JSON.stringify(record.error) : undefined,
      });

      // phase_start is emitted once per phase, at first observation — later
      // writePhase calls settle the same phase, they do not start a new one.
      if (isFirstObservation) {
        this.tracer.trace({
          requestId: this.ctx.requestId,
          phaseId: record.phaseId,
          type: "phase_start",
          name: record.name,
          payloadJson: JSON.stringify({ kind: record.kind, seq }),
          startedAt: record.startedAt,
        });
      }
    } catch (err) {
      onTraceError(err as TracerError, this.ctx.requestId);
    }
  }

  promotePhase(phaseId: string, status: string, exitStatus?: string): void {
    // Delegate to inner first
    this.inner.promotePhase(phaseId, status as PhaseStatus, exitStatus as import("../types.ts").ExitStatus | undefined);

    // Forward to tracer
    try {
      const endedAt = new Date().toISOString();

      // Update phases row status + ended_at.
      // seq comes from the map when writePhase was seen (authoritative); the
      // phaseId parse (format: runId:index:name) is only a fallback for a
      // promote without a prior write — and a malformed index degrades to 0,
      // never NaN (NaN binds as NULL and breaks seq ordering).
      const parts = phaseId.split(":");
      const parsedSeq = parts.length >= 2 ? Number.parseInt(parts[1]!, 10) : 0;
      const seq =
        this.phaseSeqs.get(phaseId) ??
        (Number.isFinite(parsedSeq) ? parsedSeq : 0);
      const phaseName = parts.length >= 3 ? parts.slice(2).join(":") : parts[0] ?? "";

      this.tracer.upsertPhase({
        requestId: this.ctx.requestId,
        phaseId,
        seq,
        name: phaseName,
        kind: "code", // default, will be ignored on update
        status, // upsertPhase accepts string
        // One clock read per promote: on the insert path (promote without a
        // prior writePhase) we need started_at; using the same read as
        // ended_at via coherentStartedAt prevents storing a negative duration.
        startedAt: coherentStartedAt(undefined, endedAt),
        endedAt,
      });

      // Record phase_end event
      this.tracer.trace({
        requestId: this.ctx.requestId,
        phaseId,
        type: "phase_end",
        name: phaseName,
        payloadJson: JSON.stringify({ status, exitStatus }),
        endedAt,
      });
    } catch (err) {
      onTraceError(err as TracerError, this.ctx.requestId);
    }
  }

  writeGateEvent(event: GateEvent): void {
    // Delegate to inner first
    this.inner.writeGateEvent(event);

    // Forward to tracer
    try {
      // Narrow open-shape GateEvent fields with type guards
      const requestId = typeof event.requestId === "string" ? event.requestId : "";
      const phaseId = typeof event.phaseId === "string" ? event.phaseId : "";
      const name = typeof event.name === "string" ? event.name : "";
      const eventType = typeof event.type === "string" ? event.type : "gate_fail";
      const attempt =
        typeof event.attempt === "number" && Number.isFinite(event.attempt)
          ? Math.trunc(event.attempt)
          : 1;
      const violations = Array.isArray(event.violations) ? event.violations as string[] : [];
      const checks = Array.isArray(event.checks) ? event.checks as { item: string; ok: boolean; note: string }[] : [];
      const phase = typeof event.phase === "string" ? event.phase : "";
      const gateExecMs =
        typeof event.gate_exec_ms === "number" && Number.isFinite(event.gate_exec_ms)
          ? event.gate_exec_ms
          : 0;
      const gateReportMs =
        typeof event.gate_report_ms === "number" && Number.isFinite(event.gate_report_ms)
          ? event.gate_report_ms
          : 0;

      // Record gate_result row
      this.tracer.recordGateResult({
        requestId,
        phaseId,
        attempt,
        gate: name,
        passed: eventType === "gate_pass",
        violations,
        checks,
      });

      // Record gate_pass or gate_fail event
      this.tracer.trace({
        requestId,
        phaseId,
        type: eventType as import("../types.ts").TraceEventType,
        name,
        payloadJson: JSON.stringify({
          phase,
          attempt,
          gate_exec_ms: gateExecMs,
          gate_report_ms: gateReportMs,
        }),
      });
    } catch (err) {
      onTraceError(err as TracerError, this.ctx.requestId);
    }
  }

  finish(runId: string, accepted: boolean): { ok: boolean; completedAt: string } {
    // Delegate to inner first
    const outcome = this.inner.finish(runId, accepted);

    // Forward to tracer. Processes end before the session settles — a session
    // row must not claim completion while its children read "believed alive".
    try {
      this.tracer.processesEndAll(this.ctx.requestId);
      this.tracer.finishSession({
        requestId: this.ctx.requestId,
        status: outcome.ok ? "ok" : "fail",
      });
    } catch (err) {
      onTraceError(err as TracerError, this.ctx.requestId);
    }

    return outcome;
  }

  phases(): readonly PhaseRecord[] {
    // Pure delegation — no tracing needed
    return this.inner.phases();
  }
}
