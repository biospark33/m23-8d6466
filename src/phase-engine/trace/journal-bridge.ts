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
import type { Tracer } from "./tracer.ts";

/** Error handler for tracer failures (AC5). */
function onTraceError(err: Error): void {
  // Log structured error to stderr, never throw
  process.stderr.write(
    `${JSON.stringify({
      level: "warn",
      event: "trace_error",
      error: {
        code: err.name,
        message: err.message,
        ...(err instanceof Error && err.stack ? { stack: err.stack } : {}),
      },
      timestamp: new Date().toISOString(),
    })}\n`,
  );
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
      onTraceError(err as Error);
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
      // promote without a prior write.
      const parts = phaseId.split(":");
      const seq =
        this.phaseSeqs.get(phaseId) ??
        (parts.length >= 2 ? Number.parseInt(parts[1]!, 10) : 0);
      const phaseName = parts.length >= 3 ? parts.slice(2).join(":") : parts[0] ?? "";

      this.tracer.upsertPhase({
        requestId: this.ctx.requestId,
        phaseId,
        seq,
        name: phaseName,
        kind: "code", // default, will be ignored on update
        status, // upsertPhase accepts string
        startedAt: new Date().toISOString(), // required for upsert
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
      onTraceError(err as Error);
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
      onTraceError(err as Error);
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
      onTraceError(err as Error);
    }

    return outcome;
  }

  phases(): readonly PhaseRecord[] {
    // Pure delegation — no tracing needed
    return this.inner.phases();
  }
}
