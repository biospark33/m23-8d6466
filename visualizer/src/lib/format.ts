export function ts(iso: string | null | undefined): number {
  if (!iso) return Number.NaN
  return new Date(iso).getTime()
}

export function fmtDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '—'
  if (ms < 1000) return `${(ms / 1000).toFixed(2)}s`
  const s = ms / 1000
  if (s < 60) return `${s.toFixed(1)}s`
  // Round to whole seconds first, else a 59.5s remainder renders as "2m 60s".
  const total = Math.round(s)
  const m = Math.floor(total / 60)
  const rem = total % 60
  if (m < 60) return `${m}m ${String(rem).padStart(2, '0')}s`
  const h = Math.floor(m / 60)
  return `${h}h ${String(m % 60).padStart(2, '0')}m`
}

export function fmtClock(iso: string | null | undefined): string {
  const t = ts(iso)
  if (!Number.isFinite(t)) return '—'
  return new Date(t).toLocaleTimeString([], { hour12: false })
}

export function fmtDate(iso: string | null | undefined): string {
  const t = ts(iso)
  if (!Number.isFinite(t)) return '—'
  const d = new Date(t)
  return `${d.toLocaleDateString([], { month: 'short', day: 'numeric' })} ${fmtClock(iso)}`
}

export function fmtTokens(n: number | null | undefined): string {
  if (n == null) return '—'
  if (n < 1000) return String(n)
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`
  return `${(n / 1_000_000).toFixed(2)}M`
}

/**
 * Integer micro-dollars → a dollar string, conversion at display only.
 * Data stays integer µ$ end to end; a float exists only inside this function.
 */
export function fmtCost(micro: number | null | undefined): string {
  if (micro == null) return '—'
  const dollars = micro / 1_000_000
  if (dollars === 0) return '$0'
  if (dollars >= 1) return `$${dollars.toFixed(2)}`
  if (dollars >= 0.0001) return `$${dollars.toFixed(4)}`
  return '<$0.0001'
}

// Compact offset label for time axes: 0s, 30s, 1m, 1m30s, 2m, 1h05m.
export function fmtOffset(ms: number): string {
  const s = Math.round(ms / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) {
    const rem = s % 60
    return rem ? `${m}m${String(rem).padStart(2, '0')}s` : `${m}m`
  }
  const h = Math.floor(m / 60)
  const mrem = m % 60
  return mrem ? `${h}h${String(mrem).padStart(2, '0')}m` : `${h}h`
}

const TICK_STEPS_MS = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 1200, 1800, 3600].map(
  (s) => s * 1000,
)

/** Evenly-stepped time-axis ticks over a span, ≤ maxTicks of them. */
export function axisTicks(spanMs: number, maxTicks = 8): { pct: number; label: string }[] {
  // A non-finite span (bad timestamp pair) would make the loop below never end.
  const span = Number.isFinite(spanMs) ? Math.max(spanMs, 1) : 1
  // Past the largest preset step the contract still holds: widen the step so the
  // tick count stays within maxTicks instead of emitting span/1h ticks.
  const step =
    TICK_STEPS_MS.find((s) => span / s <= maxTicks) ?? Math.max(1, Math.ceil(span / maxTicks))
  const out: { pct: number; label: string }[] = []
  for (let t = 0; t <= span; t += step) {
    out.push({ pct: (t / span) * 100, label: fmtOffset(t) })
  }
  return out
}

// New-tracer tool_call payloads carry ok:false on tool errors; older payloads
// have no ok key and count as ok.
export function payloadOk(raw: string | null | undefined): boolean {
  if (!raw) return true
  try {
    const p: unknown = JSON.parse(raw)
    if (p && typeof p === 'object' && 'ok' in p) return (p as { ok?: unknown }).ok !== false
  } catch {
    /* not JSON — treat as ok */
  }
  return true
}

export function prettyJson(raw: string | null | undefined): string {
  if (!raw) return ''
  try {
    return JSON.stringify(JSON.parse(raw), null, 2)
  } catch {
    return raw
  }
}
