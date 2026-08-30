// Session-card timeline geometry: which agent lanes exist, where each event
// sits on the shared time axis, and — the point of this module — how many dot
// spans that is allowed to become.
//
// F027: a long agent row carries thousands of colored events and the card
// rendered one absolutely-positioned span per event, on up to 200 cards at
// once. A track is a few hundred pixels wide, so most of those spans landed on
// a pixel another span already covered. Dots are bucketed by percentage column
// instead: one span per column, carrying the most significant event that fell
// in it. Same picture, bounded DOM — and the per-dot label (a JSON.parse, on
// tool_call rows) is only paid for the dots that survive.

import type { AgentSession, EventRow, Phase } from './types'
import { agentColor, dotColor, eventLabel } from './events'
import { fmtOffset, ts } from './format'

export interface TimelineDot {
  id: string
  xPct: number
  color: string
  title: string
  latest: boolean
}

export interface TimelineRow {
  owner: string
  color: string
  title: string
  dots: TimelineDot[]
}

/** How loud an event type is, for deciding which dot survives its column. */
const TYPE_SEVERITY: Record<string, number> = {
  error: 3,
  gate_fail: 3,
  agent_end: 2,
  handoff: 1,
}

function severityOf(type: string | null): number {
  return TYPE_SEVERITY[type ?? ''] ?? 0
}

/**
 * Columns a track is divided into. 100 ≈ one column per percent, which on a
 * real card track (a few hundred px) is already finer than the 9px dot — going
 * finer only adds spans nobody can tell apart.
 */
export const DOT_SLOTS = 100

/** A dot before its label is built — bucketing runs on these. */
export interface Placed {
  xPct: number
  severity: number
  latest: boolean
}

/**
 * Collapses items sharing a column into one, keeping the most significant.
 * Ties go to the later item, so a column shows the most recent of the loudest.
 * `latest` always survives: it is the live run's cursor, and a louder
 * neighbour must not swallow it.
 *
 * Below `slots` items there is nothing to collapse, so the input is returned
 * as-is (identity, not a copy) — the common short-row case costs nothing.
 */
export function bucketDots<T extends Placed>(items: T[], slots: number = DOT_SLOTS): T[] {
  const cols = Math.max(1, Math.trunc(slots))
  if (items.length <= cols) return items
  const kept = new Map<number, T>()
  for (const item of items) {
    const col = Math.min(cols - 1, Math.max(0, Math.trunc((item.xPct / 100) * cols)))
    const held = kept.get(col)
    if (!held || item.latest || (!held.latest && item.severity >= held.severity)) {
      kept.set(col, item)
    }
  }
  return [...kept.values()].toSorted((a, b) => a.xPct - b.xPct)
}

export interface TimelineInput {
  phases: Phase[]
  agents: AgentSession[]
  events: EventRow[]
  /** Axis origin and width, in ms — the card owns the range calculation. */
  t0: number
  span: number
  /** A live run gets its most recent dot marked for the pulse animation. */
  running: boolean
  slots?: number
}

interface PlacedEvent extends Placed {
  event: EventRow
  color: string
  offsetMs: number
}

/**
 * Per-agent dot rows for one session card. Events attribute to an agent
 * through their phase's owner; a session with no agent phases has no rows.
 */
export function timelineRows(input: TimelineInput): TimelineRow[] {
  const owners: string[] = []
  const ownerByPhase = new Map<string, string>()
  for (const p of input.phases) {
    if (p.kind !== 'agent' || !p.owner) continue
    ownerByPhase.set(p.phase_id, p.owner)
    if (!owners.includes(p.owner)) owners.push(p.owner)
  }
  if (!owners.length) return []

  const { t0, span } = input
  const byOwner = new Map<string, PlacedEvent[]>(owners.map((o) => [o, []]))
  let latest: PlacedEvent | null = null
  let latestT = Number.NEGATIVE_INFINITY

  for (const e of input.events) {
    const owner = e.phase_id ? ownerByPhase.get(e.phase_id) : undefined
    const color = dotColor(e.type)
    if (!owner || !color) continue
    const t = ts(e.started_at)
    if (!Number.isFinite(t)) continue
    const placed: PlacedEvent = {
      event: e,
      color,
      offsetMs: t - t0,
      xPct: Math.min(Math.max(((t - t0) / span) * 100, 0), 100),
      severity: severityOf(e.type),
      latest: false,
    }
    byOwner.get(owner)?.push(placed)
    if (t >= latestT) {
      latestT = t
      latest = placed
    }
  }
  if (input.running && latest) latest.latest = true

  // /api/sessions embeds agents so the labels can use config colors with no
  // extra request; historical sessions return color null → fallback palette.
  return owners.map((owner, i) => {
    const info = input.agents.find((a) => a.agent === owner)
    return {
      owner,
      color: agentColor(info?.color, null, i),
      title: info?.model ? `${owner} ${info.model}` : owner,
      dots: bucketDots(byOwner.get(owner) ?? [], input.slots ?? DOT_SLOTS).map((p) => ({
        id: p.event.event_id,
        xPct: p.xPct,
        color: p.color,
        title: `${p.event.type} ${eventLabel(p.event)} at ${fmtOffset(p.offsetMs)}`,
        latest: p.latest,
      })),
    }
  })
}
