import type {
  Envelope,
  EventsPage,
  GateResult,
  HealthResponse,
  PromptEvent,
  SessionDetail,
  SessionSummary,
} from './types'

// ── Credential presentation ──────────────────────────────────────────────────
// Bearer is primary but a navigation cannot set a header, so the operator's
// first visit takes a 401 challenge on the static branch and pastes the token
// as a Basic password the browser then caches and attaches to every request
// here. A token set programmatically via setToken() overrides that: it lives
// in module memory ONLY — never localStorage, sessionStorage, a URL, query
// string, `#` fragment, history entry or log — and is attached as a Bearer
// header to every fetch this module makes.

let token: string | null = null

export function setToken(value: string): void {
  token = value
}

// This UI is reached through an SSH forward, where a half-open connection would
// otherwise leave a request unsettled forever (spinner with no error, no retry).
const REQUEST_TIMEOUT_MS = 30_000

async function authedFetch(url: string, init?: RequestInit): Promise<Response> {
  const headers = new Headers(init?.headers)
  if (token && !headers.has('authorization')) {
    headers.set('authorization', `Bearer ${token}`)
  }
  const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS)
  const signal = init?.signal ? AbortSignal.any([init.signal, timeout]) : timeout
  return fetch(url, { ...init, headers, signal })
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

async function getJson(url: string): Promise<unknown> {
  const res = await authedFetch(url)
  if (!res.ok) throw new Error(`GET ${url} → ${res.status}`)
  return parseJson(res, `GET ${url}`)
}

export function fetchSessions(archived = false): Promise<SessionSummary[]> {
  return getJson(archived ? '/api/sessions?archived=1' : '/api/sessions') as Promise<
    SessionSummary[]
  >
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
  return (await parseJson(res, 'GET prompts')) as PromptEvent[]
}

export function fetchEnvelopes(requestId: string): Promise<Envelope[]> {
  return getJson(`/api/sessions/${encodeURIComponent(requestId)}/envelopes`) as Promise<Envelope[]>
}

export function fetchGates(requestId: string): Promise<GateResult[]> {
  return getJson(`/api/sessions/${encodeURIComponent(requestId)}/gates`) as Promise<GateResult[]>
}
