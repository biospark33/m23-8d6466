import type { AgentStartPayload, EventRow, ToolCallPayload } from './types'
import { payloadOk, ts } from './format'

// ── Event dot colors ─────────────────────────────────────────────────────────
// One color per event type, shared by the session-card timelines and the phase
// detail list. gate_fail reads as an error signal on purpose.

export const EVENT_DOT_COLORS: Record<string, string> = {
  agent_start: '#c89bff',
  tool_call: '#5ad2dd',
  handoff: '#94a3ff',
  agent_end: '#4ade80',
  error: '#ff6f67',
  gate_fail: '#ff6f67',
}

export function dotColor(type: string | null): string | null {
  if (!type) return null
  return EVENT_DOT_COLORS[type] ?? null
}

// ── Agent lane colors ────────────────────────────────────────────────────────
// Config color wins (agents[].color from the API, or the agent_start payload
// for in-flight agents); the palette below covers dbs written before the
// color column existed.

export const AGENT_FALLBACK_COLORS = ['#c89bff', '#5ad2dd', '#94a3ff', '#e8b64a', '#f2a2c4']

export function agentColor(
  configColor: string | null | undefined,
  payloadColor: string | null | undefined,
  index: number,
): string {
  return (
    configColor ??
    payloadColor ??
    AGENT_FALLBACK_COLORS[index % AGENT_FALLBACK_COLORS.length] ??
    '#c89bff'
  )
}

/** "#c89bff" + alpha → rgba() usable in inline styles. Invalid input → transparent. */
export function hexAlpha(hex: string, alpha: number): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim())
  if (!m || !m[1]) return 'transparent'
  const n = Number.parseInt(m[1], 16)
  return `rgba(${(n >> 16) & 0xff}, ${(n >> 8) & 0xff}, ${n & 0xff}, ${alpha})`
}

// ── Payload parsing ──────────────────────────────────────────────────────────

export function parsePayload(raw: string | null | undefined): Record<string, unknown> | null {
  if (!raw) return null
  try {
    const parsed: unknown = JSON.parse(raw)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>
    }
  } catch {
    /* legacy or truncated payloads render raw */
  }
  return null
}

export function parseToolCall(e: EventRow): ToolCallPayload | null {
  const payload = parsePayload(e.payload_json)
  if (!payload || typeof payload.tool !== 'string') return null
  return payload as ToolCallPayload
}

export function parseAgentStart(e: EventRow): AgentStartPayload | null {
  return parsePayload(e.payload_json) as AgentStartPayload | null
}

// Args keys most likely to BE the call, in priority order — a bash command, a
// file path, a search pattern. Used to build the one-line label.
const ARG_LABEL_KEYS = [
  'command',
  'cmd',
  'file_path',
  'path',
  'pattern',
  'query',
  'url',
  'prompt',
  'description',
]

const LABEL_MAX = 160

function oneLine(value: string): string {
  const flat = value.replaceAll(/\s+/g, ' ').trim()
  return flat.length > LABEL_MAX ? `${flat.slice(0, LABEL_MAX)}…` : flat
}

/** One-line summary of a tool's args: the call itself, not a JSON dump. */
export function argsSummary(args: Record<string, unknown> | undefined): string {
  if (!args) return ''
  for (const key of ARG_LABEL_KEYS) {
    const v = args[key]
    if (typeof v === 'string' && v.trim() !== '') return oneLine(v)
  }
  const parts: string[] = []
  for (const [key, v] of Object.entries(args)) {
    if (v == null) continue
    parts.push(`${key}=${typeof v === 'string' ? v : JSON.stringify(v)}`)
  }
  return oneLine(parts.join(' '))
}

/**
 * Exact-call row label for an event.
 * Rich tool_call → "bash: bun test src". Legacy payloads fall back to
 * the event name plus whatever hint the payload carries.
 */
export function eventLabel(e: EventRow): string {
  if (e.type === 'tool_call') {
    const call = parseToolCall(e)
    if (call?.tool) {
      // New-tracer rows already carry the human label in events.name
      // ("bash: ls -la src") — prefer it over re-deriving.
      if (e.name?.startsWith(call.tool)) return oneLine(e.name)
      const summary = argsSummary(call.args)
      return summary ? `${call.tool}: ${summary}` : call.tool
    }
    const legacy = parsePayload(e.payload_json)
    if (legacy && typeof legacy.pi_event === 'string') {
      return `${e.name ?? 'tool'} ${legacy.pi_event}`
    }
  }
  return e.name ?? e.type ?? ''
}

// ── Per-phase indexing ───────────────────────────────────────────────────────

/**
 * Groups a run's events by phase_id in one pass (F028). The trace view holds
 * the whole history and the detail pane wants one phase's slice; scanning the
 * history once per poll tick beats each of the detail pane's derived computeds
 * scanning it again. Insertion order is preserved, so a rowid-ordered input
 * yields rowid-ordered slices. Events with no phase are dropped — nothing
 * renders them.
 */
export function eventsByPhase(events: readonly EventRow[]): Map<string, EventRow[]> {
  const map = new Map<string, EventRow[]>()
  for (const e of events) {
    if (!e.phase_id) continue
    const slice = map.get(e.phase_id)
    if (slice) slice.push(e)
    else map.set(e.phase_id, [e])
  }
  return map
}

// ── Event row views ──────────────────────────────────────────────────────────

/**
 * How long one event took. Falls back to the tool_call payload's own
 * duration_ms for older tracers that recorded no ended_at.
 */
export function eventDurationMs(e: EventRow): number {
  const a = ts(e.started_at)
  const b = ts(e.ended_at)
  if (Number.isFinite(a) && Number.isFinite(b)) return b - a
  if (e.type === 'tool_call') {
    const call = parseToolCall(e)
    if (call?.duration_ms != null) return call.duration_ms
  }
  return NaN
}

/** One event's rendered facts, parsed exactly once (F077). */
export interface EventView {
  event: EventRow
  /** The one-line row label. */
  label: string
  /** The rich tool_call payload, or null (legacy payload / other type). */
  call: ToolCallPayload | null
  durationMs: number
  /** False only for a tool_call whose payload reports failure. */
  ok: boolean
  /** Filled on first expand — see PhaseDetail. Highlighted args JSON. */
  argsHtml?: string
}

function buildView(e: EventRow): EventView {
  const call = e.type === 'tool_call' ? parseToolCall(e) : null
  return {
    event: e,
    label: eventLabel(e),
    call,
    durationMs: eventDurationMs(e),
    ok: e.type !== 'tool_call' || payloadOk(e.payload_json),
  }
}

/**
 * Views for a phase's events, reusing the view already built for an event_id.
 *
 * The 500ms poll re-derives this list on every tick; without the cache each
 * tick re-`JSON.parse`d every payload in the phase (the template asked for the
 * label twice and the payload seven more times per expanded row). `cache` is
 * owned by the caller so it can be dropped when the phase changes.
 */
export function buildEventViews(
  events: readonly EventRow[],
  cache: Map<string, EventView>,
): EventView[] {
  return events.map((e) => {
    let view = cache.get(e.event_id)
    if (!view) {
      view = buildView(e)
      cache.set(e.event_id, view)
    }
    return view
  })
}
