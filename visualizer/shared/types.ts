/**
 * Types shared by the read-only server and the Vue client.
 *
 * Ported from upstream SSSF at the DF4.1 port boundary: `adw_id` →
 * `request_id` everywhere (renamed, never aliased — no route accepts both
 * spellings), `adw_name` dropped (DF1.4 has no such column; `pipeline_name`
 * is its counterpart), and cost is INTEGER micro-dollars end to end (DD-9) —
 * no costCents, no floats; display conversion is the client's job.
 *
 * Every interface mirrors a table of the DF1.4 trace store one-for-one (see
 * src/phase-engine/trace/schema.ts). Nothing here is derived state: phase
 * durations, session progress and lane layout are computed in the UI, never
 * stored.
 */

/** sessions.status — a run is running until it earns success. */
export type SessionStatus = "running" | "success" | "fail";

/** phases.status — queued only for manifest-declared phases not yet entered. */
export type PhaseStatus = "queued" | "running" | "success" | "fail";

/** phases.kind — decides which lane a block renders in. */
export type PhaseKind = "engineer" | "code" | "agent";

/** events.type — the trace's event vocabulary, DF1.4's among them: `prompt`. */
export type EventType =
  | "phase_start"
  | "phase_end"
  | "agent_start"
  | "agent_end"
  | "tool_call"
  | "handoff"
  | "gate_pass"
  | "gate_fail"
  | "prompt"
  | "log"
  | "error";

/**
 * sessions — exactly DF1.4's column set: request_id, request, status,
 * engineer, started_at, ended_at, duration_ms, total_tokens, total_cost,
 * pipeline_name, archived. total_cost is integer micro-dollars.
 */
export interface Session {
  request_id: string;
  request: string | null;
  status: SessionStatus | null;
  engineer: string | null;
  started_at: string | null;
  ended_at: string | null;
  duration_ms: number | null;
  total_tokens: number | null;
  total_cost: number | null;
  pipeline_name: string | null;
  /** 1 once archived out of the review list. Review state, not run state. */
  archived: number | null;
}

/**
 * A session row with its phases embedded, so the L1 table draws the
 * mini-progress dots without a second request per row.
 */
export interface SessionSummary extends Session {
  /** Full phase rows, ordered by seq — one dot each. */
  phases: Phase[];
  /**
   * The session's agents, same shape and merge rules as SessionDetail.agents —
   * so an L1 card can color its per-agent dots without a request per card.
   */
  agents: AgentSession[];
}

export interface Phase {
  phase_id: string;
  request_id: string;
  seq: number | null;
  name: string | null;
  kind: PhaseKind | null;
  owner: string | null;
  description: string | null;
  status: PhaseStatus | null;
  attempt: number | null;
  retries: number | null;
  error: string | null;
  started_at: string | null;
  ended_at: string | null;
}

export interface Event {
  /** SQLite rowid — the polling cursor. Monotonic, insertion-ordered. */
  rowid: number;
  event_id: string;
  request_id: string;
  phase_id: string | null;
  /** Span nesting: an agent phase expands into its tool-call children. */
  parent_id: string | null;
  type: EventType | null;
  name: string | null;
  /** Raw JSON string as written by the tracer; parse at the point of display. */
  payload_json: string | null;
  tokens: number | null;
  started_at: string | null;
  ended_at: string | null;
}

export interface Envelope {
  envelope_id: string;
  request_id: string;
  phase_id: string | null;
  agent: string | null;
  /** Name of the data_types model the response was parsed against. */
  output_type: string | null;
  payload_json: string | null;
  /** SQLite integer boolean. */
  valid: number | null;
  attempt: number | null;
}

export interface GateResult {
  id: number;
  request_id: string;
  phase_id: string | null;
  attempt: number | null;
  gate: string | null;
  /** SQLite integer boolean. */
  passed: number | null;
  /** JSON array of violation strings; "[]" on a pass. */
  violations_json: string | null;
  /**
   * JSON array of GateCheck — the per-item evidence behind the verdict, so a
   * green gate can say WHAT it verified rather than only that it passed.
   * Null on rows written before the tracer recorded checks; those are not
   * backfilled, so fall back to the verdict alone.
   */
  checks_json: string | null;
}

/** One item a gate inspected — the parsed element of `checks_json`. */
export interface GateCheck {
  item: string;
  ok: boolean;
  note: string;
}

/**
 * agent_sessions — the queryable mirror of the run's agent roster. Supplies
 * lane labels (`name · model`). DF1.4 has no created_at/last_used_at; rows
 * read in insertion order.
 */
export interface AgentSession {
  request_id: string;
  agent: string;
  coding_agent: string | null;
  model: string | null;
  session_id: string | null;
  /**
   * The agent's lane color, e.g. "#a78bfa". Null on agents with no configured
   * color — fall back to the UI's own palette.
   */
  color: string | null;
  /**
   * How full the agent's context window was after its last turn, and the
   * model's ceiling. Null on an agent still running — the lane draws no bar
   * rather than a misleading empty one.
   */
  context_tokens: number | null;
  context_window: number | null;
}

// ── payload_json shapes ──────────────────────────────────────────────────────
// events.payload_json is stored as a string. These are the parsed shapes for
// the two payloads the UI renders; every field is optional because the tracer
// writes what the coding agent reported, which varies by agent and by version.

/** Parsed `agent_start` payload — the live source of a lane's label and color. */
export interface AgentStartPayload {
  model?: string;
  thinking?: string;
  session_id?: string;
  color?: string;
  coding_agent?: string;
  purpose?: string;
  /** Tool allowlist; null means all tools. */
  tools?: string[] | null;
  harness_engineering?: string[];
}

/**
 * Tokens per component for one agent phase, summed across every send it made
 * (a retried phase paid more than once).
 *
 * This is what the tracer actually writes: `src/phase-engine/usage.ts:41-49`,
 * emitted verbatim as `agent_end.usage` by
 * `src/phase-engine/agents/retry.ts:142-151`. Note there is exactly ONE cost
 * figure — `costMicros`, integer µ$ (DD-9). Per-component costs do not exist;
 * the tracer never computes them.
 *
 * Keys are read camelCase-first with the vendored SSSF snake_case spelling as
 * a heritage fallback — the precedent `Db.usage()` set (`server/db.ts:395-431`).
 * Every field is optional because a payload is only ever as complete as the
 * tracer that wrote it.
 */
export interface UsageBreakdown {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  /**
   * Thinking tokens — the reasoning SHARE of `outputTokens`, not a fifth
   * component. Never added to a total.
   */
  reasoningTokens?: number;
  /** Integer micro-dollars (DD-9) — the phase's only cost figure. */
  costMicros?: number;
  /** How many sends the phase paid for (a retried phase paid more than once). */
  sends?: number;

  // Heritage SSSF spellings, still present in older payloads.
  input_tokens?: number;
  output_tokens?: number;
  cache_read_tokens?: number;
  cache_write_tokens?: number;
  reasoning_tokens?: number;
  total_cost?: number;
}

/** Parsed `agent_end` payload — closes out a call with its cost and context use. */
export interface AgentEndPayload {
  /** Integer micro-dollars. */
  cost?: number;
  /** Absent on runs predating the breakdown; `cost` alone survives there. */
  usage?: UsageBreakdown;
  /**
   * Window occupancy after the final turn, and the model's ceiling — camelCase
   * because that is what the tracer writes (`src/phase-engine/types.ts:299-306`).
   * Not to be confused with the agent_sessions COLUMNS of the same meaning,
   * which are genuinely `context_tokens`/`context_window` (see `AgentSession`).
   */
  contextTokens?: number;
  contextWindow?: number;
}

/**
 * Parsed `tool_call` payload — one event per real tool call, emitted when the
 * tool returns. `result_snippet` and `duration_ms` are absent when the coding
 * agent never reported a result.
 */
export interface ToolCallPayload {
  tool?: string;
  tool_call_id?: string;
  args?: Record<string, unknown>;
  result_snippet?: string;
  ok?: boolean;
  duration_ms?: number;
  agent?: string;
}

// ── API responses ────────────────────────────────────────────────────────────

/** GET /api/sessions */
export type SessionsResponse = SessionSummary[];

/** GET /api/sessions/:requestId */
/**
 * What actually moved through a session, summed across every agent.
 *
 * Deliberately NOT the billed total: `sessions.total_tokens` also counts every
 * cached re-read, which is the same context charged again on each turn.
 */
export interface SessionUsage {
  /** Raw prompt tokens read for the first time: new input + cache writes. */
  read: number;
  /** Tokens generated. Each produced exactly once, so this needs no adjusting. */
  written: number;
}

export interface SessionDetail {
  session: Session;
  /** Derived from agent_end payloads, so historical runs have it too. */
  usage: SessionUsage;
  /** Ordered by seq. */
  phases: Phase[];
  /**
   * One entry per agent that has run OR is running under this request_id —
   * lane labels come from here. Finished agents come from the agent_sessions
   * table; an agent still in flight has no row there yet, so its entry is
   * built from its agent_start event (coding_agent is null until it finishes).
   */
  agents: AgentSession[];
}

/**
 * GET /api/sessions/:requestId/events?after=<rowid>&limit=500
 *
 * Poll with `after` = the cursor from the previous response. `cursor` is the
 * highest rowid in this page (or the `after` you sent, when the page is
 * empty), so it can be fed straight back in. `hasMore` means the page hit the
 * limit. An unknown or event-less requestId is an empty page, never a 404.
 */
export interface EventsPage {
  rows: Event[];
  cursor: number;
  hasMore: boolean;
}

/**
 * GET /api/sessions/:requestId/prompts?phaseId=<id>
 *
 * The compiled prompts a run was sent, read from the trace itself — DF1.4's
 * `events` rows of type `prompt`, written pre-execution (DD-8), not from the
 * filesystem. `name` is the agent ROLE the prompt was compiled for (DF1.4's
 * dispatch-task writes one event per roster role). `payload_json` is the raw
 * JSON string as written — DF1.4's shape is `{agentId, prompt, model}` with
 * the compiled text in `.prompt` — and passes through verbatim; extracting
 * the text (with bare-string/raw fallbacks) is the client's job. Omitting
 * `phaseId` returns every prompt for the run.
 */
export interface PromptEvent {
  event_id: string;
  phase_id: string | null;
  name: string | null;
  payload_json: string | null;
  tokens: number | null;
  started_at: string | null;
}

/** GET /api/sessions/:requestId/prompts */
export type PromptsResponse = PromptEvent[];

/** GET /api/sessions/:requestId/envelopes */
export type EnvelopesResponse = Envelope[];

/** GET /api/sessions/:requestId/gates */
export type GatesResponse = GateResult[];

/**
 * GET /api/health. Degraded (schema drift, or the trace removed/locked after
 * a successful start) reports {ok:false, db, journal_mode} with no sessions
 * count, and the process stays up (AC3).
 */
export interface HealthResponse {
  ok: boolean;
  db: string;
  journal_mode: string;
  sessions?: number;
}

export interface ApiError {
  error: string;
}
