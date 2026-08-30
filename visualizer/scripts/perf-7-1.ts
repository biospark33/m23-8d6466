/**
 * Task 7.1 measurement harness (F026, F027, F028, F076, F077).
 *
 * There is no browser automation in this environment, so the four numbers the
 * task asks for are measured by driving the real modules the components call,
 * against a synthetic fleet the size the audit describes: /api/sessions
 * answers with 200 rows (server/index.ts default limit) and SessionsList
 * renders every one.
 *
 * WHICH NUMBERS ARE MEASURED AND WHICH ARE MODELLED — read this before quoting
 * the table anywhere:
 *
 *   MEASURED (a counter on the real code path, driven by the exact expression
 *   the template used before and after the change):
 *     (a-count) /api/events fetches on list mount — `fetch` is stubbed and
 *               counted, so this is the true request count, not an estimate.
 *     (b)       dot spans per agent row — the real span count timelineRows()
 *               emits.
 *
 *   MODELLED (this harness runs in Bun with no browser, no DOM, no network and
 *   no real Hindsight server, so these are what the model says the change is
 *   worth, NOT observations of the shipped UI):
 *     (a-wall)  wall time for that mount — against a stubbed `fetch`, so it
 *               prices the client-side work only; real latency (an ssh-forwarded
 *               server, 200 concurrent sockets) is exactly what it cannot see.
 *     (c)       renderMarkdown calls on phase load — counting wrappers around
 *               the real functions, but the call COUNT comes from the template
 *               expression transcribed here, not from a mounted component.
 *     (d)       parseToolCall calls per poll tick — same: transcribed
 *               expression, no component, no Vue reactivity.
 *
 * The synthetic fleet is the size the audit describes: /api/sessions answers
 * with 200 rows (server/index.ts default limit) and SessionsList renders every
 * one.
 *
 * Run:  bun run scripts/perf-7-1.ts
 * It asserts nothing and changes nothing — it prints the table that goes in
 * the commit body and the report.
 */
import { drainEvents } from '../src/lib/api.ts'
import { buildEventViews, dotColor, eventLabel, parseToolCall, type EventView } from '../src/lib/events.ts'
import { fmtOffset, ts } from '../src/lib/format.ts'
import { renderMarkdown } from '../src/lib/markdown.ts'
import { timelineRows } from '../src/lib/timeline.ts'
import type { AgentSession, EventRow, Phase } from '../src/lib/types.ts'

const SESSIONS = 200 // server/index.ts:271 — /api/sessions defaults to limit=200
const EVENTS_PER_SESSION = 5000 // a long agent row, per F027
const VISIBLE_CARDS = 9 // a 1440x900 viewport of 420px-tall cards
const PAGE = 1000 // drainEvents' page size
const T0 = Date.parse('2026-01-01T00:00:00.000Z')

const TOOL_PAYLOAD = JSON.stringify({
  tool: 'bash',
  ok: true,
  duration_ms: 12,
  args: { command: 'bun test visualizer/test/ --coverage' },
  result_snippet: 'ok',
})

function makeEvent(i: number): EventRow {
  return {
    rowid: i + 1,
    event_id: `ev-${i}`,
    request_id: 'req-1',
    phase_id: 'p-agent',
    parent_id: null,
    type: i % 500 === 499 ? 'error' : 'tool_call',
    name: 'bash: bun test',
    payload_json: TOOL_PAYLOAD,
    tokens: 120,
    started_at: new Date(T0 + i * 40).toISOString(),
    ended_at: new Date(T0 + i * 40 + 12).toISOString(),
  }
}

const EVENTS = Array.from({ length: EVENTS_PER_SESSION }, (_, i) => makeEvent(i))

const PHASES: Phase[] = [
  {
    phase_id: 'p-agent',
    request_id: 'req-1',
    seq: 0,
    name: 'build',
    kind: 'agent',
    owner: 'builder',
    description: null,
    status: 'running',
    attempt: 1,
    retries: 0,
    error: null,
    started_at: new Date(T0).toISOString(),
    ended_at: null,
  },
]

const AGENTS: AgentSession[] = [
  {
    request_id: 'req-1',
    agent: 'builder',
    coding_agent: null,
    model: 'claude',
    session_id: null,
    color: '#c89bff',
    context_tokens: null,
    context_window: null,
  },
]

// ── (a) concurrent /api/events fetches fired on mount ────────────────────────

let fetches = 0
const realFetch = globalThis.fetch
globalThis.fetch = (async (input: RequestInfo | URL) => {
  fetches++
  const after = Number(new URL(String(input), 'http://x').searchParams.get('after') ?? 0)
  const rows = EVENTS.slice(after, after + PAGE)
  return new Response(
    JSON.stringify({ rows, cursor: rows.at(-1)?.rowid ?? after, hasMore: after + PAGE < EVENTS.length }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  )
}) as unknown as typeof fetch // dp:ok assigns a stub to globalThis.fetch in a benchmark script

/** Every mounted card drains, unconditionally — SessionCard.vue before 7.1. */
async function mountBefore(): Promise<number> { // dp:ok benchmark script awaited at top level; a rejection fails the script with a stack, which is the intended behaviour
  fetches = 0
  const t = performance.now()
  await Promise.all(Array.from({ length: SESSIONS }, () => drainEvents('req-1', 0)))
  return performance.now() - t
}

/** Only the cards the IntersectionObserver reports on screen drain — after. */
async function mountAfter(): Promise<number> { // dp:ok benchmark script awaited at top level; a rejection fails the script with a stack, which is the intended behaviour
  fetches = 0
  const t = performance.now()
  await Promise.all(
    Array.from({ length: SESSIONS }, (_, i) =>
      drainEvents('req-1', 0, undefined, () => i < VISIBLE_CARDS),
    ),
  )
  return performance.now() - t
}

// ── (b) dot spans rendered per card, for one 5,000-event agent row ───────────

/** SessionCard's `rows` computed before 7.1 — one span per colored event. */
function dotsBefore(): number {
  let n = 0
  for (const e of EVENTS) {
    if (!e.phase_id || !dotColor(e.type)) continue
    const t = ts(e.started_at)
    if (!Number.isFinite(t)) continue
    // The title was built for every event, label parse included.
    void `${e.type} ${eventLabel(e)} at ${fmtOffset(t - T0)}`
    n++
  }
  return n
}

function dotsAfter(): number {
  const rows = timelineRows({
    phases: PHASES,
    agents: AGENTS,
    events: EVENTS,
    t0: T0,
    span: EVENTS_PER_SESSION * 40,
    running: true,
  })
  return rows.reduce((sum, r) => sum + r.dots.length, 0)
}

// ── (c) renderMarkdown calls on phase load ───────────────────────────────────

const PROMPTS = Array.from({ length: 6 }, (_, i) => ({
  id: `prompt-${i}`,
  text: `# prompt ${i}\n\n${'a compiled prompt line with `code` and **bold**\n'.repeat(400)}`,
}))

function markdownBefore(): { calls: number; ms: number } {
  let calls = 0
  const t = performance.now()
  // promptPanels built `html` for every panel the moment the fetch resolved.
  for (const p of PROMPTS) {
    calls++
    void renderMarkdown(p.text)
  }
  return { calls, ms: performance.now() - t }
}

function markdownAfter(): { calls: number; ms: number } {
  const calls = 0
  const t = performance.now()
  // Panels all start collapsed (openPanels is cleared on every phase change),
  // so nothing renders until one is opened — only the header facts are built.
  for (const p of PROMPTS) void { id: p.id, lines: p.text.split('\n').length }
  return { calls, ms: performance.now() - t }
}

// ── (d) parseToolCall calls per poll tick ────────────────────────────────────

const PHASE_EVENTS = EVENTS.slice(-200) // the detail list's window
const EXPANDED = 2 // rows the operator has open

let parses = 0
function countedParseToolCall(e: EventRow) {
  parses++
  return parseToolCall(e)
}

/**
 * PhaseDetail's template before 7.1: eventLabel twice per row (each a parse on
 * a tool_call), eventDurationMs once, and richCall seven times per expanded
 * row — all re-run whenever the 500ms poll replaced the events array.
 */
function parsesBefore(): number {
  parses = 0
  for (const [i, e] of PHASE_EVENTS.entries()) {
    if (e.type === 'tool_call') {
      countedParseToolCall(e) // :665 :title="eventLabel(e)"
      countedParseToolCall(e) // :666 {{ eventLabel(e) }}
    }
    // eventDurationMs only parses when ended_at is missing; these rows have it.
    if (i < EXPANDED) for (let k = 0; k < 7; k++) countedParseToolCall(e)
  }
  return parses
}

/** After: one view per event, cached by event_id across ticks. */
function parsesAfter(ticks: number): number {
  parses = 0
  const cache = new Map<string, EventView>()
  for (let tick = 0; tick < ticks; tick++) {
    for (const e of PHASE_EVENTS) {
      if (cache.has(e.event_id)) continue
      parses++
    }
    buildEventViews(PHASE_EVENTS, cache)
  }
  return parses
}

// ── Report ───────────────────────────────────────────────────────────────────

const beforeMs = await mountBefore()
const beforeFetches = fetches
const afterMs = await mountAfter()
const afterFetches = fetches
globalThis.fetch = realFetch

const mdBefore = markdownBefore()
const mdAfter = markdownAfter()

const rowsN = (n: number) => n.toLocaleString('en-US')

console.log(`fleet: ${SESSIONS} sessions x ${rowsN(EVENTS_PER_SESSION)} events, ${VISIBLE_CARDS} cards on screen\n`)
console.log('measurement                                   before        after')
console.log('------------------------------------------------------------------')
console.log(`(a-count) /api/events fetches on mount   M ${String(rowsN(beforeFetches)).padStart(10)}   ${String(rowsN(afterFetches)).padStart(10)}`)
console.log(`(a-wall)  wall time for that mount (ms)  ~ ${beforeMs.toFixed(0).padStart(10)}   ${afterMs.toFixed(0).padStart(10)}`)
console.log(`(b) dot spans per 5,000-event agent row  M ${String(rowsN(dotsBefore())).padStart(10)}   ${String(rowsN(dotsAfter())).padStart(10)}`)
console.log(`(c) renderMarkdown calls on phase load   ~ ${String(mdBefore.calls).padStart(10)}   ${String(mdAfter.calls).padStart(10)}`)
console.log(`    time spent in it (ms)                 ${mdBefore.ms.toFixed(1).padStart(10)}   ${mdAfter.ms.toFixed(1).padStart(10)}`)
console.log(`(d) parseToolCall calls, tick 1          ~ ${String(rowsN(parsesBefore())).padStart(10)}   ${String(rowsN(parsesAfter(1))).padStart(10)}`)
console.log(`    parseToolCall calls, ticks 2..10      ${String(rowsN(parsesBefore() * 9)).padStart(10)}   ${String(rowsN(parsesAfter(10) - parsesAfter(1))).padStart(10)}`)
console.log('')
console.log('M = measured on the real code path.  ~ = MODELLED (no browser, no DOM,')
console.log('    no network): what the model says the change is worth, not an observation')
console.log('    of the shipped UI.')
