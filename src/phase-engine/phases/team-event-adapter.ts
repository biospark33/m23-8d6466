/**
 * Team-event adapter (Story DF1.6, Task T6).
 *
 * Adapts parsed TeamEvent from cli-anything's NDJSON stream into phase-engine
 * surfaces: trace events and envelopes.
 *
 * Exported functions:
 * - adaptTeamEvent: transforms TeamEvent into AdaptedEvent (trace or envelope)
 * - classifyRun: implements the exit classification precedence rule
 * - makeStreamHealth: factory for stream health counters
 */
import type { TeamEvent } from "../../../cli-anything/src/team-events.ts";
import type { ExitStatus } from "../types.ts";

/**
 * Adapted event output from adaptTeamEvent. Discriminated union covering:
 * - coms, cost, coms_init_error: trace events
 * - worker_output: generic envelope (DF1.2)
 * - merged: terminal marker for phase validation
 */
export type AdaptedEvent =
  | ComsTraceEvent
  | CostTraceEvent
  | WorkerEnvelope
  | MergedMarker
  | ComsInitErrorTraceEvent;

/** Trace event for coms (communications log). */
export interface ComsTraceEvent {
  type: "coms";
  name: string;
  payloadJson: string;
}

/** Trace event for cost (LLM turn cost). costMicros is integer µ$. (DF1.3 Technical Notes µ$→USD boundary rule). */
export interface CostTraceEvent {
  type: "cost";
  name: string;
  costMicros: number;
  tokens: number;
}

/** Trace event for coms initialization error. */
export interface ComsInitErrorTraceEvent {
  type: "coms_init_error";
  name: string;
  reason: string;
}

/**
 * Generic envelope for worker_output (DF1.2 contract).
 * Worker output IS an agent report, follows asEnvelope precedent:
 * kind "generic", label = agentId, status derived from content.
 */
export interface WorkerEnvelope {
  type: "envelope";
  kind: "generic";
  label: string;
  status: ExitStatus;
  summary: string;
  output?: unknown;
}

/** Terminal marker for merged result — phase validates schema, not adapter. */
export interface MergedMarker {
  type: "merged";
  kind: "merged";
  result: Record<string, unknown>;
}

/** Stream health counters: separate tracking for malformed vs oversized lines. */
export interface StreamHealth {
  malformedLines: number;
  droppedOversizeLines: number;
  /** Count a malformed line (parser returned null). */
  malformed(line: string): void;
  /** Count a line dropped by size cap (never reached parser). */
  dropped(): void;
  /** Snapshot current counts (always emitted, even if zero). */
  snapshot(): StreamHealthSnapshot;
}

/** Snapshot of stream health counters. */
export interface StreamHealthSnapshot {
  malformedLines: number;
  droppedOversizeLines: number;
}

/**
 * Factory for stream health counters.
 * Tracks malformed and dropped lines separately (AC2 requirement).
 */
export function makeStreamHealth(): StreamHealth {
  let malformedLines = 0;
  let droppedOversizeLines = 0;

  const health = {
    get malformedLines() {
      return malformedLines;
    },
    get droppedOversizeLines() {
      return droppedOversizeLines;
    },
    malformed(_line: string): void {
      malformedLines++;
    },
    dropped(): void {
      droppedOversizeLines++;
    },
    snapshot() {
      return { malformedLines, droppedOversizeLines };
    },
  } satisfies StreamHealth;

  return health;
}

/**
 * Adapt a parsed TeamEvent into a phase-engine surface.
 *
 * Context carries:
 * - requestId: for trace correlation
 * - phaseId: for trace grouping
 * - redact: function to redact secrets from payloads
 *
 * Mapping per AC2:
 * - coms → trace event with camelCase ComsLogEntry shape in payloadJson
 * - cost → trace event with costUsd + tokens (input + output sum)
 * - worker_output → generic envelope (kind="generic", label=agentId)
 * - merged → terminal marker {kind:"merged", result}
 * - coms_init_error → trace event {type:"coms_init_error", reason}
 */
export function adaptTeamEvent(
  event: TeamEvent,
  ctx: { requestId: string; phaseId: string; redact: (s: string) => string },
): AdaptedEvent {
  switch (event.kind) {
    case "coms": {
      // Raw coms event already has camelCase fields (requestId, sessionId, etc.)
      // per CC-9 harness boundary contract
      const raw = event.raw as Record<string, unknown>;
      return {
        type: "coms",
        name: "coms",
        payloadJson: ctx.redact(JSON.stringify(raw)),
      };
    }

    case "cost": {
      const e = event.event;
      return {
        type: "cost",
        name: "cost",
        costMicros: Math.round(e.costUsd * 1_000_000), // DF1.3 Tech Notes µ$ boundary rule: USD→µ$ once, at the adapter
        tokens: e.inputTokens + e.outputTokens,
      };
    }

    case "worker_output": {
      const output = event.output as Record<string, unknown> | null;
      // Follow asEnvelope precedent: status derived from output content
      // If output has explicit status, use it; default to success for non-null
      const status = output?.status === "logic" || output?.status === "overflow"
        ? (output.status as ExitStatus)
        : "success";
      return {
        type: "envelope",
        kind: "generic",
        label: event.agentId,
        status,
        summary: `Worker ${event.agentId} output`,
        output: ctx.redact(JSON.stringify(output ?? {})),
      };
    }

    case "merged": {
      return {
        type: "merged",
        kind: "merged",
        result: event.result,
      };
    }

    case "coms_init_error": {
      return {
        type: "coms_init_error",
        name: "coms_init_error",
        reason: event.reason,
      };
    }

    default: {
      // Exhaustiveness guard — TeamEvent is a closed union
      const _exhaust: never = event;
      throw new Error(`Unknown TeamEvent kind: ${_exhaust}`);
    }
  }
}

/**
 * Classify a team run's exit into an ExitStatus.
 *
 * Precedence rule (Technical Notes "Precedence rule", AC2):
 * Step 0: comsInitError → "transient"
 * Step 1: termSignal present → classify by killOrigin:
 *   - watchdog → "overflow"
 *   - userCancel or requestedShutdown → "logic"
 *   - unknown or null → "transient"
 * Step 2: valid merged present → "success"
 * Step 3: exit-code table (when no merged):
 *   - 64 → "logic" (driver config error, UNCONDITIONAL per story exit table)
 *   - any other non-zero → "transient"
 *   - 0 → "lead_failure" (merged null with exit 0)
 *
 * "valid" = parseTeamEventLine accepted it (upstream validation).
 * classifyRun receives mergedResult as already-parsed-or-null.
 * A merged whose result was rejected upstream arrives as null.
 *
 * Source: DF1.6 Technical Notes, µ$→USD boundary rule (DF1.3).
 */
export function classifyRun(input: {
  exitCode: number | null;
  termSignal: string | null;
  mergedResult: Record<string, unknown> | null;
  comsInitError: boolean;
  killOrigin: "watchdog" | "userCancel" | "requestedShutdown" | "unknown" | null;
}): ExitStatus {
  // Step 0: coms_init_error beats everything
  if (input.comsInitError) {
    return "transient";
  }

  // Step 1: signal classification by killOrigin
  if (input.termSignal !== null) {
    switch (input.killOrigin) {
      case "watchdog":
        return "overflow";
      case "userCancel":
      case "requestedShutdown":
        return "logic";
      case "unknown":
      case null:
        return "transient";
    }
  }

  // Step 2a: exit 64 → logic UNCONDITIONAL (driver config error)
  // This beats a merged result per story exit table
  if (input.exitCode === 64) {
    return "logic";
  }

  // Step 2b: valid merged present → success (exit code ignored, except 64 above)
  if (input.mergedResult !== null) {
    return "success";
  }
  if (input.exitCode !== null && input.exitCode !== 0 && input.exitCode !== 64) {
    return "transient";
  }
  // Exit 0 without merged → lead_failure
  if (input.exitCode === 0) {
    return "lead_failure";
  }

  // Fallback: null exitCode without merged (should not happen with proper harness)
  return "lead_failure";
}
