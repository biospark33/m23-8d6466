import type { ComsLogEntry } from "./types.ts";

/** Cap on stored coms-log entries (memory bound; overflow counted, not kept). */
export const MAX_COMS_LOG_ENTRIES = 1000;

function str(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/**
 * Parse one coms wire entry into the camelCase `ComsLogEntry` stdout shape
 * (CC-9). coms-net's internal wire format is snake_case; the harness boundary
 * owns the conversion. camelCase input is accepted too (idempotent), so a
 * future coms-net that already emits camelCase needs no change here.
 * Malformed entries return null — the caller counts them as dropped.
 */
export function parseComsWireEntry(raw: unknown): ComsLogEntry | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return null;
  }
  const o = raw as Record<string, unknown>;
  const pick = (snake: string, camel: string): unknown =>
    o[camel] !== undefined ? o[camel] : o[snake];

  const requestId = str(pick("request_id", "requestId"));
  const sessionId = str(pick("session_id", "sessionId"));
  const phaseId = str(pick("phase_id", "phaseId"));
  const channel = str(o.channel);
  const direction = str(o.direction);
  const senderAgent = str(pick("sender_agent", "senderAgent"));
  const receiverAgent = str(pick("receiver_agent", "receiverAgent"));
  const payloadSize = num(pick("payload_size", "payloadSize"));
  const durationMs = num(pick("duration_ms", "durationMs"));
  const timestamp = str(o.timestamp);

  if (
    requestId === null ||
    sessionId === null ||
    phaseId === null ||
    channel === null ||
    (direction !== "send" && direction !== "receive") ||
    senderAgent === null ||
    receiverAgent === null ||
    payloadSize === null ||
    durationMs === null ||
    timestamp === null
  ) {
    return null;
  }
  return {
    requestId,
    sessionId,
    phaseId,
    channel,
    direction,
    senderAgent,
    receiverAgent,
    payloadSize,
    durationMs,
    timestamp,
  };
}

/** Accumulates parsed coms entries with a hard cap and a dropped counter. */
export class ComsLogCollector {
  readonly entries: ComsLogEntry[] = [];
  dropped = 0;

  /** Returns true when the entry parsed AND was stored. */
  push(raw: unknown): boolean {
    const entry = parseComsWireEntry(raw);
    if (entry === null || this.entries.length >= MAX_COMS_LOG_ENTRIES) {
      this.dropped++;
      return false;
    }
    this.entries.push(entry);
    return true;
  }
}
