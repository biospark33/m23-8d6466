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

async function authedFetch(url: string, init?: RequestInit): Promise<Response> {
  const headers = new Headers(init?.headers)
  if (token && !headers.has('authorization')) {
    headers.set('authorization', `Bearer ${token}`)
  }
  return fetch(url, { ...init, headers })
}

async function getJson(url: string): Promise<unknown> {
  const res = await authedFetch(url)
  if (!res.ok) throw new Error(`GET ${url} → ${res.status}`)
  return res.json()
}

export function fetchSessions(): Promise<SessionSummary[]> {
  return getJson('/api/sessions') as Promise<SessionSummary[]>
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
  const page = (await getJson(
    `/api/sessions/${encodeURIComponent(requestId)}/events?after=${after}&limit=${limit}`,
  )) as EventsPage
  return { rows: page.rows ?? [], cursor: page.cursor ?? after, hasMore: page.hasMore ?? false }
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
  return (await res.json()) as PromptEvent[]
}

export function fetchEnvelopes(requestId: string): Promise<Envelope[]> {
  return getJson(`/api/sessions/${encodeURIComponent(requestId)}/envelopes`) as Promise<Envelope[]>
}

export function fetchGates(requestId: string): Promise<GateResult[]> {
  return getJson(`/api/sessions/${encodeURIComponent(requestId)}/gates`) as Promise<GateResult[]>
}
