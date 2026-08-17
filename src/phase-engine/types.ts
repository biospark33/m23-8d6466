/**
 * Phase-engine shared types and module constants (Story DF1.1).
 *
 * This file is the single declaration site for the phase primitive's shape and
 * for the numbers the admission formula depends on. Four sibling stories append
 * their own regions here (DF1.2 `PhaseParams.previous`, DF1.3 its retry-loop
 * types, DF1.4 its trace/event types, DF1.8 its issue-correlation types); none
 * of them re-declares what this story put here.
 *
 * `ExitStatus` is imported from the CC-1 5-value taxonomy in
 * `cli-anything/src/types.ts` and is never re-declared.
 */
import type { ZodIssue } from "zod";
import type { ExitStatus } from "../../cli-anything/src/types.ts";
import type { Envelope } from "./envelopes/types.ts";

export type { ExitStatus };

/** The only manifest `version` this engine accepts (in-flight version pin). */
export const MANIFEST_VERSION = "1.0.0" as const;

/**
 * Gate-parse repair attempts per phase attempt. DF1.3 owns the parse-fix loop's
 * *behaviour*; the constant lives here because this story's admission formula,
 * closed schema and boundary test all depend on it and DF1.3 lands later.
 */
export const PARSE_FIX_ATTEMPTS = 2;

/** `retries` bound carried by the closed schema (DF1.3 imports, never re-declares). */
export const MIN_RETRIES = 0;
export const MAX_RETRIES = 5;

/** Per-phase wall-clock ceiling: default and hard upper bound (design §5.2). */
export const DEFAULT_MAX_DURATION_MS = 600_000;
export const MAX_MAX_DURATION_MS = 900_000;

/** Engine dispatch + journal-write overhead allowed per phase, in ms. */
export const ROUTING_MARGIN_MS = 5_000;

/**
 * How long the engine waits for an aborted phase body to settle before it
 * records the overflow anyway. A body that ignores its `AbortSignal` must not
 * be able to hang the run (INV-3, "the run does not hang").
 */
export const CANCEL_GRACE_MS = 5_000;

/** Load-time `pipelineId` shape (survives from P1.4's `templateId` clause). */
export const PIPELINE_ID_PATTERN = /^[a-z][a-z0-9-]{1,63}$/;

/** Ceiling on the manifest file itself; a phase list never approaches it. */
export const MANIFEST_MAX_BYTES = 1_048_576;

/** Bound on the credential walk, so a hostile nesting depth is a load error. */
export const MANIFEST_MAX_DEPTH = 64;

/** Minimum phases a manifest must declare (P1.4 load-validation clause). */
export const MIN_PHASES = 2;

/**
 * Every manifest-controlled string (phase `name`, `description`, and manifest
 * keys) is attacker-controlled and reaches error/log messages verbatim in
 * several files (`manifest.ts`, `phase.ts`, `scripts/pipeline-run.ts`). A
 * newline or other control character in any of them could otherwise forge
 * extra log/journal lines wherever the resulting message is reported.
 * `JSON.stringify` escapes control characters into a single-line,
 * unambiguous form; the wrapping quotes it adds are stripped so call sites
 * keep their existing quoting style. This is the one shared implementation —
 * every site that interpolates a manifest-controlled value into a message
 * must route through it rather than re-deriving its own escaping.
 *
 * `JSON.stringify` does NOT escape U+007F (DEL), the C1 control range
 * U+0080-U+009F (which includes U+0085 NEL, a Unicode line terminator), or
 * U+2028/U+2029 (LINE/PARAGRAPH SEPARATOR, also line terminators many log
 * processors and terminals honor) — those are valid JSON string characters,
 * so they pass through JSON.stringify literal. A second pass escapes them.
 */
export function sanitizeForMessage(s: string): string {
  return JSON.stringify(s)
    .slice(1, -1)
    .replace(
      /[\x7f\x80-\x9f\u2028\u2029]/g,
      (ch) => `\\u${ch.codePointAt(0)!.toString(16).padStart(4, "0")}`,
    );
}

/**
 * One Zod issue, formatted for a `ManifestError`/`PhaseConstructionError`
 * message. Both `path` segments and `message` are attacker-controlled: a
 * `.strict()` schema's `unrecognized_keys` issue embeds the raw offending key
 * verbatim in `message` (not just `path`), so the whole formatted string is
 * routed through `sanitizeForMessage`, not only the path segments.
 */
export function formatZodIssue(issue: ZodIssue): string {
  const path = issue.path.map((seg) => sanitizeForMessage(String(seg))).join(".") || "$";
  return `${path}: ${sanitizeForMessage(issue.message)}`;
}

/** Articles carry no information, so stripping them is what makes an echo visible. */
const FILLER_WORDS = new Set(["the", "a", "an"]);

function normalizeWords(value: string): string {
  return value
    .replace(/\.+$/, "")
    .toLowerCase()
    .split(/[\s_]+/)
    .filter((w) => w.length > 0 && !FILLER_WORDS.has(w))
    .join(" ");
}

/**
 * Why a description is illegible, or `null` if it is fine (AC3).
 *
 * The AC's stated form is
 * `d.replace(/\.+$/,"").toLowerCase() === name.replaceAll("_"," ").toLowerCase()`.
 * That exact comparison misses the DoD's own example (`commit_plan` / "Commit
 * the plan"), so both sides are normalized identically — trailing dots stripped,
 * case folded, `_` treated as a space, articles dropped — which is a strict
 * superset of the AC's form: anything the AC rejects, this rejects too.
 *
 * Lives here, not in `phase.ts`, because both the loader (as a `ManifestError`)
 * and the phase constructor (as a `PhaseConstructionError`) apply it.
 */
export function descriptionDefect(name: string, description: string): string | null {
  const trimmed = description.trim();
  if (trimmed.length === 0) return "description must not be empty or whitespace-only";
  const normalized = normalizeWords(trimmed);
  // "...", "the", "a the an" — everything informative removed.
  if (normalized.length === 0) {
    return `description '${sanitizeForMessage(description)}' carries no words`;
  }
  if (normalized === normalizeWords(name)) {
    return `description '${sanitizeForMessage(description)}' only restates the phase name`;
  }
  return null;
}

export type PhaseKind = "engineer" | "agent" | "code" | "dispatch_task";

/** A phase row is `fail` until the clean-exit branch earns `success`. */
export type PhaseStatus = "fail" | "success";

/**
 * The identity DF1.3 keys its session cache on. Absent means the phase runs
 * without a cached session — never a default roster entry.
 */
export interface PhaseAgent {
  agentId: string;
  provider: string;
  model: string;
  contextWindow: number;
}

/** A phase as declared in the manifest, post-validation (defaults applied). */
export interface PhaseSpec {
  name: string;
  kind: PhaseKind;
  description: string;
  maxDurationMs: number;
  retries: number;
  /** Required iff `kind === "code"`; the only manifest-borne argv source. */
  command?: string[];
  /** Optional on any kind; absent means `testsExecuted: false`, never a zero. */
  testCommand?: string[];
  /** Required iff `kind === "dispatch_task"`; path to DF1.5 roster file. */
  roster?: string;
  /** Required iff `kind === "dispatch_task"`; task brief for the team. */
  task?: string;
}

/**
 * What `Run.phase` is handed. A manifest-declared phase plus the caller-supplied
 * bits a manifest may not carry.
 */
export interface PhaseParams extends PhaseSpec {
  agent?: PhaseAgent;
  /**
   * DF1.2 region — the one slot both code results and agent reports flow
   * through: the prior phase's envelope, handed to this phase's body through
   * the identical `previous:` position (AC2/AC3).
   */
  previous?: Envelope;
}

export interface PipelineManifest {
  version: typeof MANIFEST_VERSION;
  pipelineId: string;
  runBudgetMs: number;
  phases: PhaseSpec[];
}

/**
 * Per-run context carried alongside the manifest.
 *
 * `effectiveCeilingMicros` is the run's effective spend ceiling in integer µ$
 * (DD-9). It is optional by design: this story declares it and reads it
 * nowhere. DF3.1's dispatch is the sole producer; DF1.6's spawn seam is the
 * first consumer. Absent means "no run-level ceiling was supplied" — never zero
 * and never unlimited.
 */
export interface RunContext {
  runId: string;
  pipelineId: string;
  requestId: string;
  effectiveCeilingMicros?: number;
}

/** Sub-timings required by the observability contract. A stage that did not run reports 0. */
export interface PhaseSubTimings {
  manifest_load_ms: number;
  phase_body_ms: number;
  journal_write_ms: number;
  /** DF1.6 v5 names — optional for backward compatibility */
  mulch_prime_ms?: number;
  box_setup_ms?: number;
  team_execution_ms?: number;
  gate_validation_ms?: number;
}

/** A persisted phase row. `status` is `fail` at construction, by two independent defaults. */
export interface PhaseRecord {
  runId: string;
  requestId: string;
  pipelineId: string;
  phaseId: string;
  name: string;
  kind: PhaseKind;
  status: PhaseStatus;
  startedAt: string;
  updatedAt: string;
  exitStatus?: ExitStatus;
  durationMs?: number;
  error?: { code: string; message: string; stack?: string };
  subTimings?: PhaseSubTimings;
  /** DF1.6 stream health counters — optional, emitted as 0 when absent */
  malformedLines?: number;
  droppedOversizeLines?: number;
}

/** DF1.2 owns this event's shape; the port accepts it append-only from this story on. */
export interface GateEvent {
  runId: string;
  phaseId: string;
  [k: string]: unknown;
}

export interface RunOutcome {
  ok: boolean;
  completedAt: string;
}

// ---------------------------------------------------------------------------
// DF1.3 region — retry-loop types. Appended below DF1.1's declarations and
// DF1.2's `PhaseParams.previous`; nothing above this line is edited by this
// story. `PARSE_FIX_ATTEMPTS`, the `retries: 0..5` bound and `PhaseParams.agent`
// above are DF1.1's and are imported by the retry loop, never re-declared.
// ---------------------------------------------------------------------------

import type { UsageBreakdown } from "./usage.ts";

/** One gate attempt's outcome, as `PhaseAttemptRecord.gateReports` carries it. */
export interface GateAttemptReport {
  attempt: number;
  passed: boolean;
  violations: string[];
  checks: Array<{ item: string; ok: boolean; note: string }>;
}

/**
 * The result of one agent phase attempt: send and parse accounting plus every
 * gate report, each with its attempt number.
 */
export interface PhaseAttemptRecord {
  /** The gate attempt the phase reached. */
  attempt: number;
  sends: number;
  parseAttempts: number;
  gateReports: GateAttemptReport[];
  envelopeValid: boolean;
}

/** A response that failed Loop A, retained as data — never as instruction text (INV-2). */
export interface InvalidEnvelopeRecord {
  attempt: number;
  parseAttempt: number;
  issues: string[];
  textTail: string;
}

/**
 * The widened `agent_end` payload (DF1.3's addition to the DF1.1 log contract):
 * phase-total usage — a retried phase paid for every attempt — plus the LAST
 * send's occupancy (`contextTokens`) against the declared `contextWindow`
 * (0 = unknown, never full).
 */
export interface AgentEndEvent {
  event: "agent_end";
  requestId: string;
  phase: string;
  agentId: string;
  usage: UsageBreakdown;
  contextTokens: number;
  contextWindow: number;
}

// ---------------------------------------------------------------------------
// DF1.4 region: trace-layer types. Append-only — DF1.4 adds the event-type
// union (including `prompt`), the trace row shapes, and the reader's
// cursor/page types. No sibling story's declaration is edited here.
// ---------------------------------------------------------------------------

/** Event types the trace store persists (spec: DF1.4 Technical Notes). */
export type TraceEventType =
  | "phase_start"
  | "agent_start"
  | "prompt"
  | "tool_call"
  | "handoff"
  | "gate_pass"
  | "gate_fail"
  | "log"
  | "agent_end"
  | "phase_end"
  | "error";

/**
 * Payload of a `prompt` event — the single owner of compiled-prompt
 * persistence. `text` is full client source code and is bound by INV-1.
 */
export interface PromptEventPayload {
  role: "system" | "user";
  agent: string;
  phase_id: string;
  text: string;
}

/** Input to `Tracer.trace()` — dual-written JSONL-first, then SQLite. */
export interface TraceEventInput {
  requestId: string;
  phaseId?: string;
  parentId?: string;
  type: TraceEventType;
  name: string;
  payloadJson?: string;
  tokens?: number;
  startedAt?: string;
  endedAt?: string;
}

/** A row of `events` as returned by the reader. */
export interface TraceEventRow {
  rowid: number;
  event_id: string;
  request_id: string;
  phase_id: string | null;
  parent_id: string | null;
  type: TraceEventType;
  name: string;
  payload_json: string | null;
  tokens: number | null;
  started_at: string | null;
  ended_at: string | null;
}

/** One bounded page of `events` rows, rowid-ordered (AC4). */
export interface EventPage {
  rows: TraceEventRow[];
  cursor: number;
  hasMore: boolean;
}

/** A row of `sessions` as returned by the reader. */
export interface TraceSessionRow {
  request_id: string;
  request: string | null;
  status: string | null;
  engineer: string | null;
  started_at: string | null;
  ended_at: string | null;
  duration_ms: number | null;
  total_tokens: number | null;
  total_cost: number | null;
  pipeline_name: string | null;
  archived: number | null;
}
