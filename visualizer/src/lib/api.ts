import type {
  Envelope,
  EventRow,
  EventsPage,
  GateResult,
  HealthResponse,
  PromptEvent,
  SessionDetail,
  SessionSummary,
} from './types'

// ── Credential presentation ──────────────────────────────────────────────────
// This module never sets an authorization header, and holding a token here
// would be the wrong place for one. The server accepts Bearer, but a
// navigation cannot set a header, so the operator's first visit takes the
// static branch's 401 Basic challenge (server/index.ts) and pastes the token
// as the password; the browser caches that credential and attaches it to
// every same-origin request the SPA makes, XHR and fetch alike. So the
// credential lives in the browser's own store and never in JS memory,
// localStorage, sessionStorage, a URL, query string, `#` fragment, history
// entry or log.

// This UI is reached through an SSH forward, where a half-open connection would
// otherwise leave a request unsettled forever (spinner with no error, no retry).
const REQUEST_TIMEOUT_MS = 30_000

function authedFetch(url: string, init?: RequestInit): Promise<Response> {
  const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS)
  const signal = init?.signal ? AbortSignal.any([init.signal, timeout]) : timeout
  return fetch(url, { ...init, signal })
}

// A response body is never allowed into an error message: on /prompts the body
// IS compiled prompt content, and SyntaxError embeds a prefix of it verbatim.
async function parseJson(res: Response, what: string): Promise<unknown> {
  try {
    return await res.json()
  } catch {
    throw new Error(`${what} → invalid JSON response`)
  }
}

// The wire is untyped at runtime: a route that should answer with an array and
// does not is a contract break, named here rather than surfacing later as a
// `.map is not a function` from inside a component render.
function asArray<T>(value: unknown, what: string): T[] {
  if (!Array.isArray(value)) throw new Error(`${what} → expected an array`)
  return value as T[]
}

async function getJson(url: string): Promise<unknown> {
  const res = await authedFetch(url)
  if (!res.ok) throw new Error(`GET ${url} → ${res.status}`)
  return parseJson(res, `GET ${url}`)
}

export async function fetchSessions(archived = false): Promise<SessionSummary[]> {
  const body = await getJson(archived ? '/api/sessions?archived=1' : '/api/sessions')
  return asArray<SessionSummary>(body, 'sessions')
}

export async function fetchSession(requestId: string): Promise<SessionDetail> {
  const detail = (await getJson(`/api/sessions/${encodeURIComponent(requestId)}`)) as SessionDetail
  return {
    session: detail.session,
    usage: detail.usage ?? { read: 0, written: 0 },
    phases: detail.phases ?? [],
    agents: detail.agents ?? [],
  }
}

export async function fetchEvents(
  requestId: string,
  after: number,
  limit = 500,
): Promise<EventsPage> {
  // `number` does not exclude NaN — a non-numeric server cursor can round-trip
  // back here as one, so clamp both to sane integers at the boundary.
  const from = Number.isFinite(after) ? Math.max(0, Math.trunc(after)) : 0
  const size = Number.isFinite(limit) ? Math.max(1, Math.trunc(limit)) : 500
  const page = (await getJson(
    `/api/sessions/${encodeURIComponent(requestId)}/events?after=${from}&limit=${size}`,
  )) as EventsPage
  return { rows: page.rows ?? [], cursor: page.cursor ?? from, hasMore: page.hasMore ?? false }
}

/** Hard ceiling on pages drained per call — a server that keeps saying hasMore
 *  must not hold the caller (and the ui) hostage. */
const MAX_PAGES = 50

/**
 * Drains every event page available from `cursor` in one go, up to `maxPages`.
 * Returns the rows taken and the cursor they advance to; the caller decides
 * whether the result is still wanted (ownership/abort) before adopting either.
 *
 * `isCurrent` is re-asked between pages. A drain can span dozens of round
 * trips, and the view that started it may be looking at a different run (or be
 * unmounted) long before page 50 — without the check the loop keeps fetching
 * history nobody will render. What was drained before the flip is still
 * returned, cursor and all, so a caller that IS still current after a
 * transient false loses nothing; the ownership decision stays the caller's.
 */
export async function drainEvents(
  requestId: string,
  cursor: number,
  maxPages: number = MAX_PAGES,
  isCurrent: () => boolean = () => true,
): Promise<{ rows: EventRow[]; cursor: number }> {
  const rows: EventRow[] = []
  let at = cursor
  for (let round = 0; round < maxPages; round++) {
    if (!isCurrent()) break
    // Cursor pagination is inherently sequential: each request needs the previous cursor.
    // oxlint-disable-next-line no-await-in-loop
    const page = await fetchEvents(requestId, at, 1000)
    rows.push(...page.rows)
    // Advance from the rows actually taken, never from the reported cursor: a
    // server cursor that does not move (or is not a number) would otherwise
    // spin this loop forever, or stick at NaN and refetch all history a poll.
    const next = Math.max(at, ...page.rows.map((r) => r.rowid).filter(Number.isFinite))
    if (next <= at) break
    at = next
    if (!page.hasMore) break
  }
  return { rows, cursor: at }
}

/** Archive a run out of the review list (or restore it with archived=false). */
export async function archiveSession(requestId: string, archived = true): Promise<void> {
  const url = `/api/sessions/${encodeURIComponent(requestId)}/archive`
  const res = await authedFetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ archived }),
  })
  if (!res.ok) throw new Error(`POST ${url} → ${res.status}`)
}

export function fetchHealth(): Promise<HealthResponse> {
  return getJson('/api/health') as Promise<HealthResponse>
}

// PhaseDetail imports the prompts type from here alongside fetchPrompts.
export type { PromptsResponse, PromptEvent } from './types'

/**
 * The compiled prompts recorded for one phase — its `prompt`-type event rows,
 * read from the trace store (not the filesystem). Keyed by
 * (request_id, phase_id); a phase with none recorded is a valid empty answer.
 */
export async function fetchPrompts(requestId: string, phaseId: string): Promise<PromptEvent[]> {
  const res = await authedFetch(
    `/api/sessions/${encodeURIComponent(requestId)}/prompts?phaseId=${encodeURIComponent(phaseId)}`,
  )
  // Not recorded (or endpoint not deployed yet) renders as "no prompts", not an error.
  if (res.status === 404) return []
  if (!res.ok) throw new Error(`GET prompts → ${res.status}`)
  return asArray<PromptEvent>(await parseJson(res, 'GET prompts'), 'prompts')
}

export async function fetchEnvelopes(requestId: string): Promise<Envelope[]> {
  const body = await getJson(`/api/sessions/${encodeURIComponent(requestId)}/envelopes`)
  return asArray<Envelope>(body, 'envelopes')
}

export async function fetchGates(requestId: string): Promise<GateResult[]> {
  const body = await getJson(`/api/sessions/${encodeURIComponent(requestId)}/gates`)
  return asArray<GateResult>(body, 'gates')
}
