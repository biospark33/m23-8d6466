/**
 * The dual retry discipline (Story DF1.3).
 *
 * Two loops inside one agent phase, separately bounded, both re-entering the
 * SAME agent session so a correctable response is corrected without paying for
 * a fresh context (design §3.3; R4 §1.9):
 *
 *  - **Loop B (outer)** — gate retries, bounded by `PhaseParams.retries`
 *    (0..5, rejected at construction by DF1.1's closed schema — INV-1).
 *  - **Loop A (inner)** — parse fixes, bounded by `PARSE_FIX_ATTEMPTS`
 *    (DF1.1's constant, imported). A gate correction's response is re-parsed
 *    under a FRESH Loop A budget, so the send ceiling is
 *    `(retries + 1) × (PARSE_FIX_ATTEMPTS + 1)` and is asserted by the suite.
 *
 * Exhausting either budget raises (`EnvelopeParseExhausted` / DF1.2's
 * `GateFailureError`) and the phase status stays `fail` — the throw lands in
 * DF1.1's default-fail branch (INV-5). No failure classifier, no backoff
 * schedule, no wall-clock restart cap: cross-run restart is P1.9's boundary
 * (decisions doc §4).
 *
 * Both budgets are evaluated BEFORE each send, from constants and validated
 * phase params — never from model output. No loop in this module can iterate
 * more than the ceiling times (INV-1).
 */
import { parseCorrectionPrompt, parseEnvelope } from "./envelope-parse.ts";
import { SessionCache } from "./session.ts";
import { truncateTail } from "../envelopes/adapter.ts";
import type { Envelope } from "../envelopes/types.ts";
import { type Gate, type GateContext, GateFailureError } from "../gates/library.ts";
import { GateReport } from "../gates/report.ts";
import type { PhaseJournal } from "../journal.ts";
import { PhaseConstructionError } from "../phase.ts";
import {
  type AgentEndEvent,
  type GateAttemptReport,
  type InvalidEnvelopeRecord,
  MAX_RETRIES,
  MIN_RETRIES,
  type PhaseAttemptRecord,
  type PhaseParams,
  PARSE_FIX_ATTEMPTS,
  type RunContext,
  sanitizeForMessage,
} from "../types.ts";
import { UsageAccumulator, UsageIntegrityError, type SendUsage, type UsageBreakdown } from "../usage.ts";

/** One send's outcome, as the sender reports it. */
export interface AgentSendResult {
  text: string;
  /**
   * Required (INV-3): a send that cannot be priced reports zeros, never
   * omits — an omitted usage would make `agent_end.usage.sends` under-count
   * the sends the loops actually issued.
   */
  usage: SendUsage;
  /** `aborted` | `error` readings do not overwrite the last good occupancy (AC3). */
  stopReason?: string;
  contextTokens?: number;
  /** The id the send actually ran under when no cached session supplied one. */
  sessionId?: string;
}

/**
 * The send seam. DF1.6's dispatch supplies the real pi-backed sender
 * (`--session-id` create-or-continue under OpenRouter routing); the suite
 * supplies a deterministic scripted sender.
 */
export interface AgentSender {
  send(args: { prompt: string; sessionId: string | undefined; signal?: AbortSignal }): Promise<AgentSendResult>;
}

export interface AgentPhaseOptions {
  params: PhaseParams;
  ctx: RunContext;
  phaseId: string;
  journal: PhaseJournal;
  log: (line: Record<string, unknown>) => void;
  sender: AgentSender;
  /** DF1.2 gates, consumed unchanged: `gate(envelope, run) -> GateReport`. */
  gates: readonly Gate[];
  initialPrompt: string;
  /** Share a session cache across phases of one run; default is a fresh cache. */
  sessionCache?: SessionCache;
  gateCtx?: GateContext;
  signal?: AbortSignal;
}

export interface AgentPhaseResult {
  record: PhaseAttemptRecord;
  envelope: Envelope;
  usage: UsageBreakdown;
}

/** Loop A exhausted: every parse-fix send of the last gate attempt failed. */
export class EnvelopeParseExhausted extends Error {
  constructor(
    message: string,
    readonly invalidRecords: InvalidEnvelopeRecord[],
  ) {
    super(message);
    this.name = "EnvelopeParseExhausted";
  }
}

/**
 * Loop B's correction: one line per violation, taken from the `GateCheck.note`
 * evidence DF1.2 already records. Each line is sanitized (a note may carry
 * envelope-derived text; a raw newline in it could forge instruction lines —
 * INV-2), and the model's envelope is never re-injected.
 */
function gateCorrectionPrompt(violations: readonly string[]): string {
  return [
    "Your previous response failed validation:",
    ...violations.map((v) => `- ${sanitizeForMessage(v)}`),
    "Fix these problems, then re-emit ONLY your Report JSON.",
  ].join("\n");
}

export async function runAgentPhase(opts: AgentPhaseOptions): Promise<AgentPhaseResult> {
  const { params, ctx } = opts;
  // INV-1: the bound is enforced before any send, from validated params. The
  // closed schema already rejects this at construction; this guard keeps a
  // programmatically-built PhaseParams from raising the ceiling instead.
  if (
    !Number.isSafeInteger(params.retries) ||
    params.retries < MIN_RETRIES ||
    params.retries > MAX_RETRIES
  ) {
    throw new PhaseConstructionError(
      `phase '${sanitizeForMessage(params.name)}': retries must be ${MIN_RETRIES}..${MAX_RETRIES}, got ${params.retries}`,
    );
  }

  const cache = opts.sessionCache ?? new SessionCache();
  const sessionId = cache.sessionFor(params.agent);
  const accumulator = new UsageAccumulator();
  const invalidRecords: InvalidEnvelopeRecord[] = [];
  const gateReports: GateAttemptReport[] = [];

  const agentLabel = params.agent?.agentId ?? "(no-agent)";
  const emitAgentEnd = (): void => {
    const end: AgentEndEvent = {
      event: "agent_end",
      requestId: ctx.requestId,
      phase: params.name,
      agentId: agentLabel,
      usage: accumulator.spent,
      contextTokens: accumulator.latestContextTokens,
      // 0 = unknown, never full; no bound is derived from it.
      contextWindow: params.agent?.contextWindow ?? 0,
    };
    opts.log({ ...end, timestamp: new Date().toISOString() });
  };

  let prompt = opts.initialPrompt;
  let loop: "parse" | "gate" = "parse";
  let envelope: Envelope | undefined;
  let sends = 0;

  try {
    // Loop B — outer. Each iteration gets a fresh Loop A budget below.
    for (let gateAttempt = 1; gateAttempt <= params.retries + 1; gateAttempt += 1) {
      // Loop A — inner, bounded by PARSE_FIX_ATTEMPTS (+1 for the first send).
      for (let parseAttempt = 1; parseAttempt <= PARSE_FIX_ATTEMPTS + 1; parseAttempt += 1) {
        const sendStarted = performance.now();
        const res = await opts.sender.send({ prompt, sessionId, signal: opts.signal });
        const sendMs = performance.now() - sendStarted;
        sends += 1;
        const parseStarted = performance.now();
        const outcome = parseEnvelope(res.text);
        const parseMs = performance.now() - parseStarted;
        opts.log({
          event: "agent_send",
          requestId: ctx.requestId,
          phase: params.name,
          agentId: agentLabel,
          sessionId: sessionId ?? res.sessionId ?? "(uncached)",
          loop,
          attempt: gateAttempt,
          timestamp: new Date().toISOString(),
          durationMs: Math.round(sendMs + parseMs),
          send_ms: Math.round(sendMs),
          parse_ms: Math.round(parseMs),
        });
        // After the send is logged, so a rejected usage report cannot make the
        // paid send vanish from the event stream (INV-3).
        accumulator.add(res.usage, { stopReason: res.stopReason, contextTokens: res.contextTokens });
        if (outcome.ok) {
          envelope = outcome.envelope;
          break;
        }
        const record: InvalidEnvelopeRecord = {
          attempt: gateAttempt,
          parseAttempt,
          issues: outcome.issues,
          textTail: truncateTail(res.text),
        };
        invalidRecords.push(record);
        opts.log({
          event: "invalid_envelope",
          requestId: ctx.requestId,
          phase: params.name,
          agentId: agentLabel,
          sessionId: sessionId ?? res.sessionId ?? "(uncached)",
          attempt: gateAttempt,
          parseAttempt,
          issues: outcome.issues,
          textTail: record.textTail,
          timestamp: new Date().toISOString(),
        });
        if (parseAttempt > PARSE_FIX_ATTEMPTS) {
          throw new EnvelopeParseExhausted(
            `phase '${sanitizeForMessage(params.name)}' exhausted its parse-fix budget (${PARSE_FIX_ATTEMPTS + 1} sends) on gate attempt ${gateAttempt}; the final invalid response is retained as a record`,
            invalidRecords,
          );
        }
        prompt = parseCorrectionPrompt(outcome);
        loop = "parse";
      }

      // Loop B evaluation: every gate runs every attempt, each report emitted
      // with its attempt number through DF1.1's journal port (DF1.2's shape).
      const failures: string[] = [];
      for (const gate of opts.gates) {
        const gateStarted = performance.now();
        let report: GateReport;
        try {
          report = await gate.run(envelope, opts.gateCtx ?? { runRoot: process.cwd() });
        } catch (err) {
          // Fail closed: a gate that could not run is a failed check, never a
          // skip (INV-5).
          report = new GateReport().check(
            gate.name,
            false,
            `gate error: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
        const gateExecMs = performance.now() - gateStarted;
        const reportStarted = performance.now();
        const violations = report.violations;
        const checks = report.checks.map((c) => ({ ...c }));
        const gateReportMs = performance.now() - reportStarted;
        opts.journal.writeGateEvent({
          runId: ctx.runId,
          phaseId: opts.phaseId,
          type: report.passed ? "gate_pass" : "gate_fail",
          name: gate.name,
          requestId: ctx.requestId,
          phase: params.name,
          attempt: gateAttempt,
          gate_exec_ms: Math.round(gateExecMs),
          gate_report_ms: Math.round(gateReportMs),
          // Spec §Observability names `gate_ms`; the exec/report split above
          // is finer detail beneath it (review round 7).
          gate_ms: Math.round(gateExecMs + gateReportMs),
          violations,
          checks,
        });
        const attemptReport: GateAttemptReport = { attempt: gateAttempt, passed: report.passed, violations, checks };
        gateReports.push(attemptReport);
        if (!report.passed) {
          // Keyed on `passed`, not violations: a zero-check report fails with
          // an EMPTY violations list and must still fail the phase (INV-5).
          failures.push(
            ...(violations.length > 0 ? violations : [`${gate.name}: examined nothing`]),
          );
        }
      }

      if (failures.length === 0) {
        const record: PhaseAttemptRecord = {
          attempt: gateAttempt,
          sends,
          // Every send is one parse attempt — one counter tracks both (the
          // separate counter was removed as redundant; review round 6).
          parseAttempts: sends,
          gateReports,
          envelopeValid: true,
        };
        emitAgentEnd();
        return { record, envelope: envelope!, usage: accumulator.spent };
      }

      if (gateAttempt <= params.retries) {
        prompt = gateCorrectionPrompt(failures);
        loop = "gate";
        envelope = undefined;
      } else {
        throw new GateFailureError(
          `phase '${sanitizeForMessage(params.name)}' failed gate(s) after ${params.retries + 1} attempt(s):\n- ${failures.map((f) => sanitizeForMessage(f)).join("\n- ")}`,
          failures,
        );
      }
    }
    // Unreachable: the for-loop either returns or throws.
    throw new Error("unreachable: retry loop exited without a verdict");
  } catch (err) {
    // Spend accountability holds on every exit path (INV-3): the retried
    // phase's full multi-send usage is reported even when it fails.
    emitAgentEnd();
    throw err;
  }
}
