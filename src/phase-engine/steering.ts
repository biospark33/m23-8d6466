/**
 * Engine-owned steering port (Story DF3.3) — the solicitation seam.
 *
 * The resident agent holds no gate authority (INV-RES-1): its only egress
 * into the engine is one validated `SteeringDirective` returned from an
 * engine-initiated call through an injected `ResidentCaller`. This module
 * renders the bounded prompt, parses the reply against the closed `.strict()`
 * union, meters spend engine-side in integer µ$ (DD-9), and degrades
 * fail-closed to the deterministic default (R3) — it holds no engine state;
 * applying an accepted directive's effect is the pipeline runner's job.
 *
 * Fleet imports this through the engine barrel; this file never imports
 * fleet code (module boundary, story R3 §9.2).
 */
import { z, type ZodError } from "zod";

import { extractJsonCandidate } from "./agents/envelope-parse.ts";
// TYPE-ONLY, and it must stay that way: resident-bounds.ts imports
// PROMPT_CHAR_CEILING/MAX_OUTPUT_TOKENS from THIS file (values), so a value
// import here would be a runtime cycle. Erased at compile, no edge at run.
import type { ResidentBoundsGuard } from "./resident-bounds.ts";
import { formatZodIssue, sanitizeForMessage, type ExitStatus } from "./types.ts";

/** Solicitation prompt ceiling INCLUDING its truncation suffix (per call). */
export const PROMPT_CHAR_CEILING = 16_000;
/** Output bound per call. pi 0.55.x has no CLI flag for this — enforced via
 * the prompt instruction (SCHEMA_INSTRUCTION text) per wave-0 deviation note. */
export const MAX_OUTPUT_TOKENS = 1_024;
/** Per-call wall clock bound; the caller (fleet) owns the actual timer. */
export const SOLICIT_TIMEOUT_MS = 60_000;
/** Two consecutive malformed replies → degrade. Never a third call (AC3). */
export const MAX_MALFORMED_ATTEMPTS = 2;
/** Free-text directive field ceiling: accepted guidance is pushed into
 *  promptContext and rides every later solicitation for the run's lifetime,
 *  so a directive string needs its own bound well under PROMPT_CHAR_CEILING.
 *  An over-ceiling field fails schema parse and takes the rejection path. */
export const DIRECTIVE_TEXT_CHAR_CEILING = 4_000;
/** Roster/phase ids are harness-minted slugs; 256 chars is generous headroom. */
export const DIRECTIVE_ID_CHAR_CEILING = 256;
/** Inbound `fleet attach` text ceiling — its OWN constant, deliberately not
 *  DIRECTIVE_TEXT_CHAR_CEILING. That constant's header is emphatic that prompt
 *  context is INPUT and a directive is OUTPUT (INV-APPROVE-5); sharing one
 *  number makes tuning the model's reply budget silently move the operator's
 *  message budget, in a file where the two are one line apart. Equal today by
 *  coincidence, not by contract. Applied AFTER sanitizing, so it bounds the
 *  chars actually stored: `sanitizeForMessage` is JSON.stringify plus a `\uXXXX`
 *  pass, which expands a newline to 2 chars and `\x7f` to 6 — capping first let
 *  a 4 000-char message store ~24 000. */
export const ATTACH_MESSAGE_CHAR_CEILING = 4_000;
/** Total attach text one run may fold, across EVERY solicitation.
 *  `promptContext` is cumulative and `renderPrompt` truncates from the HEAD, so
 *  a per-message cap alone bounds nothing that matters: a flood of attach lines
 *  evicts the run's own founding task context and survives at the tail. Half
 *  the prompt ceiling — the run keeps the other half. */
export const ATTACH_FOLD_CHAR_BUDGET = PROMPT_CHAR_CEILING / 2;
/** Smallest attach body worth folding when the run-wide budget is nearly gone.
 *  The budget check used to skip ANY message that did not fit the remaining
 *  room, so one full-ceiling message (prefix + 4 000-char body) arriving when
 *  less than that remained was never folded, never acked, and every
 *  solicitation re-fired the same fault — permanently undeliverable guidance.
 *  A message with at least this much room folds TRUNCATED instead (the cut is
 *  stated in the folded line), so nothing is stranded by arithmetic. Below the
 *  floor the pass really is out of budget and stops, naming it — a body this
 *  small carries no operator intent worth spending the fault on. Deliberately
 *  a fraction of the per-message ceiling, not derived from it: it is a
 *  readability floor, not a size bound. */
export const ATTACH_FOLD_MIN_BODY_CHARS = 256;
/** Deadline on each injected inbox call. The port is injected precisely so the
 *  transport can be swapped, and `solicit` serializes every solicitation through
 *  one chain — so a hung inbox (a stalled mount, any future non-local
 *  `SteeringInbox`) wedges every LATER solicitation with no timeout, no
 *  `onInboxError` and no diagnostic. The channel's own convention on the fleet
 *  leg is a deadline (`withTimeout(..., "attach-ack-read")`); this is the
 *  engine-side half of it. */
export const INBOX_CALL_TIMEOUT_MS = 5_000;
/** Aggregate wall-clock bound on ONE drain pass's fold+ack work. `INBOX_CALL_TIMEOUT_MS`
 *  bounds each CALL; it bounds nothing across the drain LOOP, which re-reads the
 *  inbox in full and acks every queued message in turn — so N stalled acks cost
 *  N × INBOX_CALL_TIMEOUT_MS serialized in front of every later solicitation,
 *  the wedge the per-call deadline exists to prevent, re-created by summation.
 *  Derived from an existing constant, not new tuning: a drain precedes a
 *  solicitation, and SOLICIT_TIMEOUT_MS is the budget the resident CALL itself
 *  gets — the sidecar leg must not outcost the call it feeds. On exhaustion the
 *  pass stops and its fault names what it left behind — messages it did not
 *  process AND messages folded whose ack did not stick (two different
 *  remainders, counted separately); both are retried by the NEXT
 *  solicitation's drain, which re-reads the queue in full. */
export const DRAIN_PASS_TIMEOUT_MS = SOLICIT_TIMEOUT_MS;

/** The three engine-owned solicitation points — there is no fourth. */
export type SteeringPoint = "run_start" | "post_gate_failure" | "run_end";

/**
 * The closed directive union (AC2): guidance text, a roster choice, or an
 * abort — and nothing else. Closed-ness is member-level in zod v3: every
 * member of the discriminated union is `.strict()`, so an unknown action
 * (`invalid_union_discriminator`) or an unknown field on a known action
 * (`unrecognized_keys`) is a REJECTION, never a warning (INV-RES-2).
 */
export const SteeringDirectiveSchema = z.discriminatedUnion("action", [
  z
    .object({ action: z.literal("proceed"), note: z.string().max(DIRECTIVE_TEXT_CHAR_CEILING).optional() })
    .strict(),
  z
    .object({
      action: z.literal("retry"),
      guidance: z.string().max(DIRECTIVE_TEXT_CHAR_CEILING),
      note: z.string().max(DIRECTIVE_TEXT_CHAR_CEILING).optional(),
    })
    .strict(),
  z
    .object({
      action: z.literal("select_roster"),
      phase: z.string().max(DIRECTIVE_ID_CHAR_CEILING),
      rosterId: z.string().max(DIRECTIVE_ID_CHAR_CEILING),
      note: z.string().max(DIRECTIVE_TEXT_CHAR_CEILING).optional(),
    })
    .strict(),
  z
    .object({
      action: z.literal("abort"),
      reason: z.string().max(DIRECTIVE_TEXT_CHAR_CEILING),
      note: z.string().max(DIRECTIVE_TEXT_CHAR_CEILING).optional(),
    })
    .strict(),
]);
export type SteeringDirective = z.infer<typeof SteeringDirectiveSchema>;

/** Derived from the schema itself (A8) so the literals cannot drift apart. */
const KNOWN_ACTIONS = SteeringDirectiveSchema.options.map((m) => m.shape.action.value) as readonly string[];

/** Per-point directive allowlist: a schema-valid reply whose action has
 *  nothing to steer at this point is a REJECTION, not an acceptance —
 *  `telemetry.directives` counts only directives the runner can actually
 *  apply. Mirrors the runner's wiring: run_start applies abort (the empty-run
 *  fail transition) and select_roster (the dispatch_task pick);
 *  post_gate_failure applies retry (guidance into promptContext) and abort
 *  (declining the authorized retry); at run_end the run is already settled —
 *  proceed only. */
const POINT_ALLOWLIST: Record<SteeringPoint, readonly SteeringDirective["action"][]> = {
  run_start: ["proceed", "abort", "select_roster"],
  post_gate_failure: ["proceed", "retry", "abort"],
  run_end: ["proceed"],
};

/** Fleet-supplied agent caller. Engine never imports fleet (INV-RES-1). */
export interface ResidentCaller {
  /** One synchronous solicitation. Returns raw reply text + token usage.
   *  Throws on timeout / unreachable / process death. Fleet's implementation
   *  (DF3.6b) additionally rejects with the typed `PlacementRefusedError`
   *  (exit 97) when the per-solicitation cgroup placement wrapper fails —
   *  classified by the engine's `instanceof` arm, never the opaque degrade
   *  latch. */
  call(prompt: string): Promise<{ raw: string; usage: { inputTokens: number; outputTokens: number } }>;
}

/** DF3.6b (landed with DF3.6a — the deps/seams this needs are this story's
 *  diff): fleet's caller throws this when the per-solicitation cgroup
 *  placement wrapper fails (`|| exit 97`) — the engine classifies it by
 *  type instead of the opaque degrade latch. Engine-owned (fleet→engine is
 *  the allowed import direction); the engine learns the placement failed,
 *  never how to place. */
export class PlacementRefusedError extends Error {
  readonly exitCode: number;
  constructor(exitCode = 97, message = "resident cgroup placement refused") {
    super(message);
    this.name = "PlacementRefusedError";
    this.exitCode = exitCode;
  }
}

/**
 * DF3.4 attach transport port. The engine never imports fleet or provider code
 * (module boundary, header above), so the inbox implementation is INJECTED,
 * exactly like `ResidentCaller`. A drained message enters as prompt CONTEXT and
 * nothing else — it is never parsed as a directive (INV-APPROVE-5: prompt
 * context is INPUT, a directive is OUTPUT, and `parseReply` only ever sees
 * `reply.raw`).
 */
export interface SteeringInbox {
  /** Every message queued for this run, oldest first. Re-reads in FULL — the
   *  controller dedupes on `messageId`, so a re-issued line delivers once.
   *  That guarantee is IN-PROCESS: the queue itself survives the process, so a
   *  transport that keeps no ack log re-offers every already-acked message to
   *  the next process, which is exactly what `ackedIds` below is for. */
  drain(point: SteeringPoint): Promise<readonly { messageId: string; message: string }[]>;
  /** Records that `messageId` reached a solicitation's prompt context. */
  ack(messageId: string, point: SteeringPoint): Promise<void>;
  /**
   * OPTIONAL. Every id the transport has ALREADY recorded as acked, wherever
   * its ack log lives — the durable half of the dedupe in `drainInbox`.
   *
   * The queue is persistent and the controller's `delivered`/`acked` sets are
   * not: without this, the pausing→crash→retry strand this PR exists for
   * re-reads the FULL queue in the new process and re-folds + re-acks every
   * message the PREVIOUS process already delivered — "delivers once" held only
   * within one process. A transport that implements this makes the ack log the
   * persistence it already writes, and the controller treats those ids as
   * settled before any fold or ack. Optional because a transport with no
   * readable ack log cannot be forced to invent one; absent ⇒ the in-process
   * dedupe is all there is, which is the pre-fix behavior.
   */
  ackedIds?(): Promise<readonly string[]>;
}

export interface SolicitCtx {
  runId: string;
  requestId?: string;
  phase?: string; // undefined at run_start
  rosterIds?: readonly string[]; // closed DF1.5 id set, for select_roster validation
  phaseIds?: readonly string[]; // closed phase id set, for select_roster phase validation (absent = empty set = reject)
  promptContext: string[]; // mutable — DF3.4 will push drained inbox lines pre-render
}

export type ResidentStatus = "active" | "degraded" | "disabled" | "stopped";

/** D4 tripwire row. The cause union is closed at three members: DF3.3's
 *  `gate_bypass_attempt` (still its only raiser), DF3.6a's
 *  `spend_ceiling_breach` (raised at the SEAM DF3.6 spend refusal in
 *  `solicitSerialized`), and DF3.6b's `watchdog_kill` — landed here with
 *  DF3.6a because the union is one closed type on one line and splitting the
 *  edit across two stories would put two PRs on the same literal. */
export interface ResidentTripwire {
  runId: string;
  requestId?: string;
  cause: "gate_bypass_attempt" | "spend_ceiling_breach" | "watchdog_kill";
  phase?: string;
  detail: string;
}

export interface ResidentTelemetry {
  status: ResidentStatus;
  /** COUNT of accepted directives (not an array). */
  directives: number;
  directivesRejected: number;
  /** Per-phase count of accepted retry directives at post_gate_failure (the
   *  only point where a retry is executable). */
  steeringIterations: Record<string, number>;
  /** Engine-metered resident subtotal, integer µ$ (usage × rate ÷ 1e6). */
  spendMicros: number;
  /** How the resident process itself ended; null until someone who owns the
   *  process (C2/C3 wiring, DF3.6's watchdog) writes it. Import, never
   *  re-declare the values (CC-1). */
  exitStatus: ExitStatus | null;
  tripwires: ResidentTripwire[];
}

export interface SteeringController {
  /** A point-in-time SNAPSHOT: a shallow copy with `steeringIterations` and
   *  `tripwires` (rows included) copied, so internal writes never mutate an
   *  object a caller already holds — and a caller's writes never touch the
   *  live counters. */
  readonly telemetry: ResidentTelemetry;
  /** In-memory diagnostic for the most recent degradation (call failure or
   *  malformed-reply limit), sanitized at write. NOT journaled: the journal's
   *  resident block is a closed key set with no field for a degradation
   *  cause, and the tripwire cause union stays closed to
   *  "gate_bypass_attempt" (AC5/AC2) — so this lives on the controller only.
   */
  readonly lastDegradationReason: string | null;
  /**
   * The same, for the DF3.4 attach CHANNEL — a separate slot, deliberately.
   * Sharing one field let a sidecar fault (written pre-render, on a perfectly
   * healthy resident) overwrite a real resident degradation reason before
   * anything read it, and answer `lastDegradationReason` with a value that
   * contradicts `telemetry.status: "active"` sitting right beside it. The
   * resident's health and the channel's health are two facts.
   */
  readonly lastInboxErrorReason: string | null;
  /**
   * DF2.12 (PR #253 review): the first sanitized failure cause of the
   * cost-attribution sink, or null while every emission landed. A throwing
   * `emitAttribution` is a sidecar fault — the reply is still metered, the
   * resident is not degraded — but it is money EVIDENCE being lost, so it may
   * not also be silent. Latched once: a persistently broken sink re-fires
   * nothing. Additive getter, deliberately NOT on `ResidentTelemetry` (the
   * journal's resident block is a closed shape) — the same in-process
   * diagnostic pattern as `acksBeforeCall`.
   */
  readonly lastAttributionErrorReason: string | null;
  /** Never throws. Degraded/disabled → resolves { action: "proceed" }
   *  (deterministic default, INV-RES-5). */
  solicit(point: SteeringPoint, ctx: SolicitCtx): Promise<SteeringDirective>;
  /**
   * DF3.4 (round 7): how many acks THIS PROCESS wrote on solicitations where no
   * prompt reached the resident — drained-and-acked ahead of the status gate,
   * a failed prompt render, or a caller that threw before reading. AC6's ack
   * means "reached a solicitation's prompt context", not "the resident read
   * it", so `fleet attach`'s `attach-acked` is an inbox-processing receipt;
   * this counter is the in-process diagnostic for whether any ack was the
   * weaker kind. 0 ⇒ every ack this process wrote was followed by a resident
   * call.
   *
   * PROCESS-LOCAL, and the doc says so because an earlier draft did not: the
   * counter lives on the controller inside the resident/runner process, while
   * `fleet attach` runs in a separate process that never receives a
   * `SteeringController` — so NO consumer can print this number next to an
   * `attach-acked` line, and 0 must not be read across the process boundary as
   * "the operator's message was genuinely read". The resident surfaces the
   * weaker-ack fact through its own channel instead (`onInboxError`/trace rows
   * and `lastInboxErrorReason`, wired in `scripts/pipeline-run.ts`); this
   * getter exists for in-process observers of the controller — tests and a
   * future in-resident diagnostic. Additive getter, deliberately NOT on
   * `ResidentTelemetry`: the journal's resident block is a closed shape and
   * widening it is not this fix's job.
   */
  readonly acksBeforeCall: number;
}

/** The deterministic default every degradation path lands on (INV-RES-5). */
const PROCEED: SteeringDirective = { action: "proceed" };

const DIRECTIVE_INSTRUCTION = [
  "You are the resident orchestrator for this run. Reply with ONE JSON object and nothing else.",
  `Keep the reply at or under ${MAX_OUTPUT_TOKENS} output tokens.`,
  "The object must match exactly one member of this closed union:",
  '{"action":"proceed"}',
  '{"action":"retry","guidance":string}',
  '{"action":"select_roster","phase":string,"rosterId":string}',
  '{"action":"abort","reason":string}',
  'Each member may also carry an optional "note" string. No other actions, no other fields.',
].join("\n");

/**
 * Tail-truncation reserving the suffix width BEFORE cutting: context lines
 * arrive oldest-first and accepted guidance is pushed LAST, so the NEWEST
 * context is what a steering prompt must not lose — drop from the head.
 * (The head-keep variant came from cli-anything/src/merger.ts:218-245, where
 * newest-last was not the invariant.) Surrogate-safe.
 */
function truncateTailWithSuffix(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  const suffix = `[truncated, ${text.length} chars total]`;
  const proseBudget = maxLength - suffix.length;
  if (proseBudget < 0) {
    const minimalMarker = "[…]";
    if (maxLength >= 3) return minimalMarker;
    return minimalMarker.slice(0, maxLength);
  }
  let cutPoint = text.length - proseBudget;
  while (
    cutPoint < text.length &&
    text.charCodeAt(cutPoint) >= 0xdc00 &&
    text.charCodeAt(cutPoint) <= 0xdfff
  ) {
    cutPoint += 1;
  }
  return suffix + text.slice(cutPoint);
}

/**
 * Cap already-sanitized attach text to its stored-char ceiling, WITHOUT a
 * truncation suffix — the fold line (unlike a truncating prompt) drops the
 * tail outright. `slice` counts UTF-16 CODE UNITS, so an arbitrary cut can
 * land between the halves of a surrogate pair and store a LONE surrogate — an
 * unpaired code unit that is not valid text and survives no JSON round trip
 * intact. Drop the orphan half: one character short beats one character
 * corrupt. The same guard as `approval-gate.ts`'s `capText`, which a fixed
 * suffix lets skip — here the cut is the whole budget, so the tail half is
 * always the one at risk.
 */
function capFoldedText(text: string, max: number): string {
  if (text.length <= max) return text;
  let head = text.slice(0, max);
  if (/[\uD800-\uDBFF]$/.test(head)) head = head.slice(0, -1);
  return head;
}

function renderPrompt(point: SteeringPoint, ctx: SolicitCtx): string {
  const header = `Steering point: ${point}.\n`;
  const context = ctx.promptContext.join("\n");
  // Reserve the header and the instruction (+ joiner) BEFORE cutting so the
  // instruction that carries the closed union always survives the cap — the
  // ceiling then holds for the whole prompt, suffix included.
  const budget = PROMPT_CHAR_CEILING - header.length - DIRECTIVE_INSTRUCTION.length - 1;
  return `${header}${truncateTailWithSuffix(context, budget)}\n${DIRECTIVE_INSTRUCTION}`;
}

/** The malformed-reply correction, built from harness-authored text plus the
 *  bounded solicitation context (INV-2, modelled on envelope-parse.ts's
 *  parseCorrectionPrompt): the parse failure is named, the model's own reply
 *  is never interpolated. The steering point and the tail-truncated context
 *  ride along so a stateless caller knows WHAT it is steering, and the union
 *  is restated so its correction attempt still sees the schema it must answer
 *  with. The 16,000-char ceiling holds for the whole correction, suffix
 *  included. */
function malformedCorrectionPrompt(reason: string, point: SteeringPoint, ctx: SolicitCtx): string {
  const header = `Steering point: ${point}.\n`;
  const body = [
    "Your previous response could not be parsed as a steering directive.",
    `Parse failure: ${reason}.`,
    `Reply with ONE JSON object matching the closed union, at most ${MAX_OUTPUT_TOKENS} output tokens, and nothing else.`,
    DIRECTIVE_INSTRUCTION,
  ].join("\n");
  // Reserve header + body (+ joiner) BEFORE cutting the context so the whole
  // correction honors the ceiling — the same discipline as renderPrompt.
  const budget = PROMPT_CHAR_CEILING - header.length - body.length - 1;
  return `${header}${truncateTailWithSuffix(ctx.promptContext.join("\n"), budget)}\n${body}`;
}

type ReplyParse = { ok: true; parsed: unknown } | { ok: false; reason: string };

function parseReply(raw: string): ReplyParse {
  const candidate = extractJsonCandidate(raw);
  if (candidate === undefined) {
    return { ok: false, reason: "no JSON object was found in the response" };
  }
  try {
    return { ok: true, parsed: JSON.parse(candidate) };
  } catch {
    return { ok: false, reason: "the extracted JSON candidate is not valid JSON" };
  }
}

/** Tripwire detail for a schema rejection: the rejected action name when the
 *  reply named one outside the union; for a KNOWN action carrying an unknown
 *  field, the action name plus the first sanitized issue (AC2's row names the
 *  action in both cases). All routes sanitize model-authored text
 *  (INV-2 / R7 §2c). */
function rejectionDetail(parsed: unknown, error: ZodError): string {
  const action = (parsed as { action?: unknown } | null)?.action;
  if (typeof action === "string" && !KNOWN_ACTIONS.includes(action)) {
    return `unrecognized action: ${sanitizeForMessage(action)}`;
  }
  const issue = error.issues[0];
  if (issue === undefined) return "schema rejected the reply";
  const detail = formatZodIssue(issue);
  return typeof action === "string" ? `action ${sanitizeForMessage(action)} rejected: ${detail}` : detail;
}

export function createSteering(deps: {
  caller: ResidentCaller;
  rate: { inputPerMTok: number; outputPerMTok: number };
  onTripwire?: (t: ResidentTripwire) => void;
  /** DF3.4 `fleet attach` transport. Absent ⇒ no drain, exactly the pre-DF3.4
   *  behavior. Additive — DF3.6a's bounds deps below landed on the same
   *  object by the same rule. */
  inbox?: SteeringInbox;
  /**
   * DF3.4: an inbox fault that is NOT "nothing queued" — an unreadable
   * channel, an unwritable acks file, an exhausted fold budget. Pushed rather
   * than left on `lastInboxErrorReason`, which nothing outside this module
   * reads: the defect being closed is that an operator has no way to learn the
   * channel is broken while `fleet attach` keeps telling them their message
   * "stays queued".
   *
   * NOT a tripwire: `ResidentTripwire.cause` is closed and its members are
   * spoken for (DF3.3's `gate_bypass_attempt`, DF3.6's two), so this gets its
   * own optional dep instead of widening a union it does not belong in.
   *
   * AWAITED at the call site, and typed to say so: an `async` observer is
   * accepted by a `=> void` signature, so `onInboxError: async (e) => await
   * appendFile(...)` on a failing append became a process-level unhandled
   * rejection — fatal under Bun — while the `try/catch` around it caught only a
   * SYNCHRONOUS throw. The sidecar rule holds for both shapes or for neither.
   */
  onInboxError?: (e: { runId: string; requestId?: string; detail: string }) => void | Promise<void>;
  /**
   * DF2.12 (INV-COST-10): the cost-attribution sink. A plain
   * `process.stderr.write` default is the STANDALONE posture only — raw
   * stderr bypasses pipeline-run's fd-2 tee (the tee is caller-level, not an
   * OS-level dup), so under the in-box systemd unit the line would reach
   * journald and never the harvested `$HOME/<runId>.engine.log`. Production
   * (pipeline-run) therefore injects `moneyLineTee()` here, which writes
   * through `writeAll` and lands on BOTH surfaces. Not shared with
   * dispatch-task's `emitMoneyLine`: this file imports no phase or fleet
   * code (module boundary, file header), and the writer is one line.
   */
  emitAttribution?: (line: Record<string, unknown>) => void;
  /** DF3.6a: the resident bounds guard (spend ceiling + per-phase iteration
   *  counter), armed by the runner after startResident resolves the rate.
   *  Absent ⇒ no bounds path at all — byte-for-byte pre-DF3.6a behavior. */
  bounds?: ResidentBoundsGuard;
  /** DF3.6a: fired when this story's enforcement stops the resident (spend
   *  breach) or when DF3.6b's typed placement failure arrives. Sidecar: a
   *  throwing observer never fails a solicitation. Awaited at the call site. */
  onBoundBreach?: (e: {
    bound: "spend" | "rss";
    allowed: false;
    cause: string;
    exitCode?: number;
    runId: string;
    requestId?: string;
    phase?: string;
  }) => void | Promise<void>;
  /** DF3.6b: last solicitation's cgroup accounting. Landed here (DF3.6a's
   *  diff) because the deps object is one literal and two stories must not
   *  edit it; DF3.6b wires `lastMemory: spawned.lastMemory`. A structural
   *  callback, NOT a fleet import. Unused by DF3.6a. */
  lastMemory?: () => { peakBytes: number; oomKilled: boolean } | null;
}): SteeringController {
  const telemetry: ResidentTelemetry = {
    status: "active",
    directives: 0,
    directivesRejected: 0,
    steeringIterations: {},
    spendMicros: 0,
    exitStatus: null,
    tripwires: [],
  };
  // DF3.6a AC6: a ceiling that cannot buy one projected call is a POLICY
  // outcome, never a runaway — "bound-config-invalid" rides the guard's own
  // reachability row (emitted once, at the guard's construction), so this
  // arm writes NO tripwire: a `spend_ceiling_breach` row here would make a
  // misconfiguration indistinguishable from a loop. The run proceeds
  // deterministic; every later solicitation is refused by the status gate
  // below, and the guard's check() is never reached. This and the spend
  // refusal are the ONLY internal writers of "stopped" — no public setter,
  // because a setter is a path the resident's own tier could reach
  // (INV-BND-1).
  if (deps.bounds !== undefined && deps.bounds.reachability === "below_one_call") {
    telemetry.status = "stopped";
  }
  let lastDegradationReason: string | null = null;
  let lastInboxErrorReason: string | null = null;
  /** DF2.12: the attribution SINK's health, latched at the first failure —
   *  distinct from `lastDegradationReason` (the resident answered fine) and
   *  from `lastInboxErrorReason` (a different sidecar). Null while every
   *  emission landed. */
  let lastAttributionErrorReason: string | null = null;

  /** Integer µ$ per reply (DD-9): round at each term, sum integers only.
   *  A non-finite or negative token count — or rate — clamps to 0: one
   *  poisoned input would otherwise turn spendMicros non-integer (JSON null)
   *  for the run. A reply carrying no usage object meters as zero rather than
   *  throwing (the never-throws contract covers metering too).
   *  Safe-integer accumulation (Number.isSafeInteger, matching every other µ$
   *  path — usage.ts, team-event-adapter.ts, cost-ledger.ts, qds-cost.ts):
   *  clamping admits huge-but-finite inputs whose tokens × rate product
   *  overflows to Infinity, and JS cannot exactly represent integers above
   *  MAX_SAFE_INTEGER — a finite-but-unsafe term or sum would silently lose
   *  micro-dollars on every later addition. Each rounded term and the
   *  accumulated sum are validated before the mutation, so an unsafe value
   *  leaves the last exact spendMicros intact instead of corrupting it. */
  const clampTerm = (n: unknown): number => (typeof n === "number" && Number.isFinite(n) && n > 0 ? n : 0);
  const rateInput = clampTerm(deps.rate.inputPerMTok);
  const rateOutput = clampTerm(deps.rate.outputPerMTok);
  /** Returns the µ$ THIS reply metered (DF2.12: the attribution line's
   * `costMicroUsd`) AND whether the reply priced at all. `unpriced` is true —
   * and spendMicros is left untouched — when the usage could not be trusted to
   * a priced figure: a token value that is present but unusable (non-finite,
   * negative, non-number — clampTerm would otherwise silently LAUNDER it into
   * a priced zero, PR #253 review), a rounded term past MAX_SAFE_INTEGER, or a
   * sum that would overflow. A genuinely free reply (0/0 tokens) stays
   * priced: absence of money is not absence of evidence, and the ledger keeps
   * the two classes apart (`unpriced = 0` priced-zero rows vs
   * `unpricedTurns > 0` rows). ABSENT usage meters as zero but is recorded
   * UNPRICED (fail-closed) — that flag is the emitter's
   * (`emitResidentAttribution`), so this docstring does not promise priced
   * where the row says unpriced. */
  const rawTokens = (v: unknown): number | null =>
    typeof v === "number" && Number.isFinite(v) ? (v > 0 ? v : v === 0 ? 0 : null) : v === undefined ? 0 : null;
  const meter = (
    usage: { inputTokens?: unknown; outputTokens?: unknown } | undefined,
  ): { costMicroUsd: number; unpriced: boolean } => {
    const inTok = rawTokens(usage?.inputTokens);
    const outTok = rawTokens(usage?.outputTokens);
    if (inTok === null || outTok === null) return { costMicroUsd: 0, unpriced: true };
    const inputMicros = Math.round((inTok * rateInput) / 1_000_000);
    const outputMicros = Math.round((outTok * rateOutput) / 1_000_000);
    if (!Number.isSafeInteger(inputMicros) || !Number.isSafeInteger(outputMicros)) {
      return { costMicroUsd: 0, unpriced: true };
    }
    const next = telemetry.spendMicros + inputMicros + outputMicros;
    // Defense-in-depth: reachable when already-safe terms SUM past
    // MAX_SAFE_INTEGER — directly tested by the sum-guard test.
    if (!Number.isSafeInteger(next)) return { costMicroUsd: 0, unpriced: true };
    telemetry.spendMicros = next;
    return { costMicroUsd: inputMicros + outputMicros, unpriced: false };
  };

  /** DF2.12: the fd-2 writer. The DEFAULT is the STANDALONE posture only —
   * raw stderr, for a caller with no fd-2 tee. It confers NO durability:
   * production durability comes from pipeline-run injecting `moneyLineTee()`
   * here (pinned by tests/phase-engine/pipeline-run-money-line.test.ts), and
   * only the injected writer lands the row on the harvested engine log. Same
   * line discipline as dispatch-task's `defaultMoneyLine` (the
   * `DispatchTaskDeps.emitMoneyLine` default); not imported from there — this
   * file imports no phase code. */
  const emitAttribution =
    deps.emitAttribution ??
    ((line: Record<string, unknown>): void => {
      process.stderr.write(`${JSON.stringify(line)}\n`);
    });
  // DF2.12 INV-COST-8: ordinal of the resident's metered calls within the run,
  // incremented at the emission point. ponytail: engine-memory counter, safe
  // for the same named ceiling as dispatch-task's (Restart=no; a reboot ends
  // the run — no resumed run exists to collide with).
  let residentInvocationSeq = 0;
  /** One attribution line per metered solicitation. `role: "resident"` is
   * SUPPLIED, never inferred; µ$ is carried DIRECTLY (`costMicroUsd` — the
   * resident has no provider-reported USD, so there is no `costUsd`). Fields
   * the resident wire genuinely lacks (model, cache counts) are null, never
   * invented. `timestamp`: the resident's cost event is CREATED here — there
   * is no provider wire event to read one from — so the emission time IS the
   * event's time. A broken sink is a sidecar fault: it must never degrade a
   * resident that answered (same rule as onTripwire's observer), and it is
   * never SILENT — the first failure latches `lastAttributionErrorReason`
   * (below), once, so a persistently broken sink cannot flood anything. */
  const emitResidentAttribution = (
    ctx: SolicitCtx,
    metered: { costMicroUsd: number; unpriced: boolean },
    usage: { inputTokens?: unknown; outputTokens?: unknown } | undefined,
  ): void => {
    try {
      emitAttribution({
        type: "cost_attribution",
        requestId: ctx.requestId ?? null,
        runId: ctx.runId,
        phaseId: ctx.phase ?? null,
        agentId: "resident",
        role: "resident",
        invocationSeq: residentInvocationSeq++,
        model: null,
        costMicroUsd: metered.costMicroUsd,
        inputTokens: clampTerm(usage?.inputTokens),
        outputTokens: clampTerm(usage?.outputTokens),
        cacheReadTokens: null,
        cacheWriteTokens: null,
        turnCount: 1,
        // PR #253 review: the flag comes FROM the meter, not from usage
        // existence alone — a reply whose tokens failed the meter's safety
        // validation priced nothing and must read as unpriced, not as a
        // legitimately-free turn. Absent usage stays unpriced (fail-closed).
        unpricedTurns: metered.unpriced || usage === undefined ? 1 : 0,
        timestamp: new Date().toISOString(),
      });
    } catch (err) {
      // Sidecar — the money is still metered on telemetry.spendMicros, and a
      // broken sink must never degrade a resident that answered. But never
      // SWALLOWED: the first failure latches a sanitized diagnostic on the
      // controller. This module has no `log` dep to write through and the
      // tripwire/inbox channels are spoken for (a closed cause union; the
      // channel's health is a different fact), so the diagnostic rides the
      // same additive-getter pattern as `acksBeforeCall` — in-process
      // observers, tests today. Once-only: a persistently broken sink would
      // otherwise re-fire per reply without adding a fact.
      if (lastAttributionErrorReason === null) {
        lastAttributionErrorReason = sanitizeForMessage(err instanceof Error ? err.message : String(err));
      }
    }
  };

  /** A rejected directive has exactly one effect: a telemetry row (INV-RES-2). */
  const reject = (ctx: SolicitCtx, detail: string): SteeringDirective => {
    telemetry.directivesRejected += 1;
    const row: ResidentTripwire = {
      runId: ctx.runId,
      requestId: ctx.requestId,
      cause: "gate_bypass_attempt",
      phase: ctx.phase,
      detail,
    };
    telemetry.tripwires.push(row);
    // A throwing observer is a telemetry sidecar fault; it must never
    // convert a parsed directive into the deterministic default.
    try {
      deps.onTripwire?.(row);
    } catch {
      /* observability is a sidecar; the journal row above is the record */
    }
    return PROCEED;
  };

  /** DF3.6a: push a bound breach to the `onBoundBreach` observer. AWAITED —
   *  the dep is typed `void | Promise<void>`, and an async observer's
   *  rejection is otherwise an unhandled rejection a synchronous try/catch
   *  never sees (the `onInboxError` lesson, stated in its docstring).
   *  Swallowed on throw for the same rule as onTripwire's observer: a broken
   *  observer is a sidecar fault and must never fail — or wedge the refusal
   *  outcome of — a solicitation whose enforcement already happened. The
   *  telemetry/tripwire writes happen BEFORE this fires, so a lost push loses
   *  only the push. */
  const fireOnBoundBreach = async (e: {
    bound: "spend" | "rss";
    allowed: false;
    cause: string;
    exitCode?: number;
    runId: string;
    requestId?: string;
    phase?: string;
  }): Promise<void> => {
    try {
      await deps.onBoundBreach?.(e);
    } catch {
      /* sidecar — the status/tripwire writes are the record */
    }
  };

  /** Delivered `messageId`s, run-lifetime: a re-issued line folds ONCE (AC6).
   *  Mapped to the FOLD-TIME point so an ack retry records the solicitation
   *  whose prompt context the message actually reached — the ack means
   *  "reached a solicitation's prompt context" and is written at fold time
   *  (the drainInbox header below), so a retry landing under a LATER
   *  solicitation must not re-stamp it with a point the message never saw. */
  const delivered = new Map<string, SteeringPoint>();
  /**
   * Acked ids, tracked SEPARATELY from `delivered` — one set could not carry
   * both facts. The id was added to `delivered` BEFORE the ack and the ack's
   * throw was swallowed, so a failed ack write (EACCES on the acks file, a full
   * `/run` tmpfs) was never retried: the next drain re-reads the file in full,
   * sees the id in `delivered`, and `continue`s past it before any retry can
   * run. The ack then never lands for the run's lifetime and `fleet attach`
   * reports `attach-not-acked` for a message that WAS delivered and folded —
   * the exact outcome the fold-time ack exists to prevent, one door over.
   * Two sets: fold once, ack until it sticks.
   *
   * PROCESS-LOCAL, and that is why each drain pass seeds it from
   * `deps.inbox.ackedIds` when the transport offers one (see drainInbox): a
   * restart re-reads the persistent queue in full, and an id the previous
   * process already acked must come back as SETTLED, not as undelivered work.
   */
  const acked = new Set<string>();
  /**
   * Solicitations that wrote ≥1 ack and then returned BEFORE any prompt
   * reached the resident. The machine-readable half of the provenance note at
   * the drain seam below: AC6 defines an ack as "reached a solicitation's
   * prompt context", which is NOT "the resident read it" — a message folded on
   * a run whose resident is already degraded (the drain runs ahead of the
   * status gate by design), whose prompt failed to render, or whose call
   * threw, is acked and unread.
   *
   * Exposed on the controller (not `telemetry`, whose block is a journaled
   * closed shape) as an IN-PROCESS diagnostic. It cannot annotate `fleet
   * attach`'s output: attach runs in a separate process and never holds a
   * `SteeringController`, so nothing outside this process can print this count
   * beside an `attach-acked` line. 0 ⇒ every ack THIS PROCESS wrote was
   * followed by a resident call; non-zero ⇒ at least one was not, and the
   * count is how many. The operator-facing half of the same fact is the
   * resident's own fault reporting (`onInboxError`/`lastInboxErrorReason`),
   * not this number.
   */
  let acksBeforeCall = 0;
  /** Attach chars folded so far this run (ATTACH_FOLD_CHAR_BUDGET). */
  let foldedChars = 0;
  /** The last fault already pushed to `onInboxError`. A broken channel stays
   *  broken across every solicitation, and re-firing an identical detail on
   *  each one turns the observer's sink into a flood without adding a fact. A
   *  DIFFERENT fault still fires — the dedupe is on the detail, not on the
   *  channel. Reset by a fault-free drain pass (drainInbox's tail), so a fault
   *  recurring AFTER a healthy interval is a new incident and fires again. */
  let lastPushedFault: string | null = null;

  const causeOf = (e: unknown): string => (e instanceof Error ? e.message : String(e));

  /**
   * Bound one injected inbox call. A local race rather than
   * `src/providers/timeout.ts`: the engine imports no provider or fleet code
   * (module boundary, file header), and a new dependency edge is a worse price
   * than eight lines. The losing promise gets a no-op catch BEFORE the race so
   * its late rejection can never surface as an unhandled rejection after the
   * deadline has already refused the caller — the same discipline as that file.
   */
  const withDeadline = async <T>(p: Promise<T>, what: string): Promise<T> => {
    void p.catch(() => {});
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        p,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error(`${what} timed out after ${INBOX_CALL_TIMEOUT_MS}ms`)), INBOX_CALL_TIMEOUT_MS);
        }),
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  };

  /**
   * Record an inbox fault and push it out of the process.
   *
   * `lastInboxErrorReason`, NOT `lastDegradationReason`: one slot for both made
   * a sidecar fault clobber a real resident degradation reason before anything
   * read it, and produced the self-contradictory pair (`status: "active"`,
   * reason: "steering inbox unreadable"). The resident's health and the
   * channel's health are two facts and now have two slots.
   *
   * `latchKey` (optional) is the detail the `lastPushedFault` dedupe compares.
   * The per-id ack fault needs it: N queued ids against one unwritable acks
   * dir produce N details differing only in the id, so comparing the raw
   * detail fired the observer N times in ONE pass for what is ONE fault — the
   * channel is broken, and the flood added no fact. The normalized key drops
   * the per-id part (the cause is kept, so a genuinely different failure still
   * fires), while the observer still receives the full per-id detail: the id
   * is what `fleet attach`'s poll is waiting on.
   */
  const reportInboxFault = async (ctx: SolicitCtx, detail: string, latchKey?: string): Promise<void> => {
    const sanitized = sanitizeForMessage(detail); // INV-2: sanitized at write
    lastInboxErrorReason = sanitized;
    const latch = sanitizeForMessage(latchKey ?? detail);
    if (latch === lastPushedFault) return;
    lastPushedFault = latch;
    try {
      // Awaited: see onInboxError's docstring — an async observer's rejection
      // is otherwise an unhandled rejection this catch never sees. And
      // deadline-bound with the SAME budget as the inbox calls: `solicit`
      // serializes every solicitation through one chain, so a hung observer
      // (a stalled mount under the trace sink) wedges every LATER
      // solicitation with no diagnostic — the failure mode
      // INBOX_CALL_TIMEOUT_MS's header exists to prevent, one door over. The
      // fault itself is already recorded on `lastInboxErrorReason` above, so
      // a timed-out push loses only the push; the latch stays set because the
      // next identical fault would just hang the same broken sink again.
      await withDeadline(
        Promise.resolve(deps.onInboxError?.({ runId: ctx.runId, requestId: ctx.requestId, detail: sanitized })),
        "onInboxError observer",
      );
    } catch {
      /* same rule as onTripwire's observer: a sidecar must never fail a solicitation */
    }
  };

  /**
   * DF3.4: fold every queued operator attach message into THIS solicitation's
   * context, then ack it. ONE call site (at the seam below), so all three
   * steering points share this path and a fourth cannot appear by copy.
   *
   * The ack is written HERE, at fold time, rather than at the accepted-directive
   * seam further down: every early return between the two (degraded, render
   * failure, call failure, malformed limit, schema/allowlist rejection) would
   * swallow it, and `fleet attach` would report `attach-not-acked` for a message
   * that DID land. The ack means "this message reached a solicitation's prompt
   * context" — which is what AC6 defines it as — not "the directive was
   * accepted".
   *
   * Never throws: an inbox fault is not a resident fault, and it must not
   * degrade the resident or skip a gate. `solicit`'s never-throws contract
   * covers everything it calls.
   *
   * The pass is bounded in AGGREGATE (DRAIN_PASS_TIMEOUT_MS), not just per
   * call: on exhaustion it stops and names the un-processed remainder in its
   * fault. Everything is retried by the next solicitation's drain — EXCEPT
   * what the transport reports as already acked (`ackedIds`), which is settled
   * and skipped: the queue is persistent and this controller is not, so the
   * ack log is the only record that a message already reached a prompt.
   */
  const drainInbox = async (point: SteeringPoint, ctx: SolicitCtx): Promise<void> => {
    if (deps.inbox === undefined) return;
    // Whether THIS pass reported a fault — a fault-free pass is the recovery
    // signal that resets the push dedupe latch at the bottom.
    let faulted = false;
    // The aggregate deadline. ONE read at pass start; per-call deadlines bound
    // individual calls, and without this bound a drain over N stalled acks
    // costs N × INBOX_CALL_TIMEOUT_MS serialized into the chain.
    const deadline = Date.now() + DRAIN_PASS_TIMEOUT_MS;
    let processed = 0;
    let unacked = 0;
    let queued: readonly { messageId: string; message: string }[];
    try {
      queued = await withDeadline(deps.inbox.drain(point), "steering inbox drain");
    } catch (e) {
      // The solicitation still happens — the inbox is a sidecar and an inbox
      // fault is not a resident fault — but it is no longer SILENT.
      //
      // The transport already separates "nothing queued" from "could not
      // read": `localSteeringInbox.drain` returns [] on ENOENT and THROWS on
      // anything else. Swallowing the throw collapsed that distinction and made
      // a documented guarantee false — `fleet attach` tells the operator the
      // message "stays queued, neither dropped nor re-sent", which it is not
      // when every later drain fails the same way. Nothing anywhere said so.
      //
      // NOT a tripwire: the tripwire `cause` union is closed to
      // `gate_bypass_attempt` and its members are spoken for (DF3.6's two).
      // `telemetry.status` is deliberately untouched: the resident is fine, the
      // channel is not.
      await reportInboxFault(ctx, `steering inbox unreadable: ${causeOf(e)}`);
      return;
    }
    // The DURABLE half of the dedupe: ids the transport already acked in a
    // PREVIOUS process are settled — neither re-folded nor re-acked here. The
    // queue outlives this process and `acked` does not, so without this read
    // the crash-retry strand re-delivered every message the last process saw.
    // Id-keyed, not run-keyed: the ack log is host-wide while `drain` is
    // run-scoped, and an id acked by anyone means that message was consumed —
    // there is no second consumer waiting on it. Loaded once per pass (the pass
    // is already a full re-read) and deadline-bound like every inbox call. A
    // read fault does NOT stop the drain: proceeding can only re-fold text an
    // earlier prompt already carried (bounded by the fold budget), while
    // refusing would withhold guidance — so it degrades to the in-process
    // dedupe alone and says so.
    if (deps.inbox.ackedIds !== undefined) {
      try {
        for (const id of await withDeadline(deps.inbox.ackedIds(), "steering inbox ack read")) acked.add(id);
      } catch (e) {
        faulted = true;
        await reportInboxFault(ctx, `steering inbox acks unreadable: ${causeOf(e)}`);
      }
    }
    try {
      for (const { messageId, message } of queued) {
        // Aggregate bound (round-7 item 23): stop when the pass's budget is
        // gone, and SAY what was left behind. Everything here is retried by the
        // next solicitation's drain — the queue is re-read in full, un-acked
        // ids retry their ack, un-folded ids re-eligible on budget — so
        // stopping is a deferral, never a loss; the alternative is the wedge.
        if (Date.now() >= deadline) {
          faulted = true;
          // Two remainders, counted separately: `queued.length - processed` is
          // what this pass never reached, and `unacked` is what it DID reach —
          // folded or already folded — whose ack write did not stick. One
          // number could not say both: an ack-faulted message IS in the prompt
          // context, so folding it into "unprocessed" is false, and leaving it
          // out of the fault entirely hides that it is still owed an ack. Both
          // retry on the next drain, which re-reads the queue in full:
          // un-entered ids become fold-eligible again, un-acked ids retry
          // their ack.
          await reportInboxFault(
            ctx,
            `steering inbox drain pass exceeded its ${DRAIN_PASS_TIMEOUT_MS}ms budget with ${Math.max(0, queued.length - processed)} of ${queued.length} message(s) unprocessed and ${unacked} ack(s) unconfirmed; everything stays queued and the next solicitation retries it`,
          );
          break;
        }
        processed += 1;
        // Settled ids come out FIRST, before the fold: settled means "already
        // reached a prompt context" — in THIS process (the acked latch) or in a
        // PREVIOUS one (`ackedIds`, seeded above the loop). Re-folding settled
        // text after a restart would spend the run's remaining fold budget
        // re-stating guidance an earlier prompt already carried. An id in
        // `delivered` but NOT here still falls through: its ack write failed,
        // and this pass is the retry.
        if (acked.has(messageId)) continue;
        if (!delivered.has(messageId)) {
          // PUSH, never unshift: context lines are oldest-first and renderPrompt
          // truncates from the HEAD, so newest-last is the invariant and an
          // unshifted line would be the first thing the ceiling drops.
          // sanitizeForMessage is mandatory — an attach message is unsanitized
          // operator text, and a bare newline in it would forge an instruction
          // line inside the rendered prompt (INV-2). Both halves are capped
          // AFTER sanitizing (the ceilings bound stored chars, not pre-escape
          // chars) and the id is capped too — it is operator-supplied text on
          // the same line, and an uncapped one would blow the message's budget
          // from the other side.
          const prefix = `operator attach ${capFoldedText(sanitizeForMessage(messageId), DIRECTIVE_ID_CHAR_CEILING)}: `;
          const body = capFoldedText(sanitizeForMessage(message), ATTACH_MESSAGE_CHAR_CEILING);
          // The stated cut, same convention as truncateTailWithSuffix's marker:
          // a budget-clamped fold is a PARTIAL delivery and the resident must
          // be able to tell that from a complete message.
          const marker = `[attach truncated, ${body.length} chars total]`;
          const room = ATTACH_FOLD_CHAR_BUDGET - foldedChars;
          // Below the floor nothing worth reading fits, so the budget really is
          // gone: NOT folded, and therefore NOT acked — the ack means "this
          // reached a solicitation's prompt context" and this one did not, so
          // the message remains queued in the inbox (until a reboot wipes it),
          // which is what `fleet attach`'s fold-budget arm tells the operator.
          // `break`, not `continue`: the queue is oldest-first, so nothing
          // behind this one is more entitled to the remaining budget.
          if (prefix.length + marker.length + ATTACH_FOLD_MIN_BODY_CHARS > room) {
            faulted = true;
            await reportInboxFault(
              ctx,
              `steering inbox fold budget of ${ATTACH_FOLD_CHAR_BUDGET} chars is exhausted: later attach messages are not being delivered`,
            );
            break;
          }
          // Above the floor the message folds WHATEVER the room is, clamped and
          // marked. The old whole-message check skipped any message that did
          // not fit entire, which stranded a full-ceiling body landing inside
          // the last few thousand chars of the budget — never folded, never
          // acked, the same fault re-fired on every solicitation for the run's
          // lifetime.
          const line =
            prefix.length + body.length <= room
              ? `${prefix}${body}`
              : `${prefix}${capFoldedText(body, room - prefix.length - marker.length)}${marker}`;
          ctx.promptContext.push(line);
          foldedChars += line.length;
          delivered.set(messageId, point);
        }
        try {
          // The FOLD-TIME point, never this solicitation's: on a retry the two
          // differ, and the ack's meaning ("reached a solicitation's prompt
          // context") belongs to the fold. `?? point` is unreachable — the ack
          // only runs for ids already in `delivered`.
          await withDeadline(deps.inbox.ack(messageId, delivered.get(messageId) ?? point), "steering inbox ack");
          acked.add(messageId);
        } catch (e) {
          // Reported, not swallowed. The fold DID happen, so this is not an
          // unreadable channel and it says so — but an unwritable acks file
          // reaching no trace and no operator is how `fleet attach` polls its
          // full 30s and then prints a remediation recommending the re-send
          // that double-delivers. The id stays out of `acked`, so the next
          // solicitation retries the write.
          faulted = true;
          unacked += 1;
          // The per-id detail goes to the observer; the NORMALIZED detail (id
          // stripped) is what the latch compares — see reportInboxFault.
          await reportInboxFault(
            ctx,
            `steering inbox ack failed for ${sanitizeForMessage(messageId).slice(0, DIRECTIVE_ID_CHAR_CEILING)}: ${causeOf(e)}`,
            `steering inbox ack failed: ${causeOf(e)}`,
          );
        }
      }
    } catch (e) {
      // The never-throws contract, held past the drain: a malformed harness ctx
      // (promptContext not an array) throws on the push, and this is the only
      // frame between it and `solicit`'s callers.
      faulted = true;
      await reportInboxFault(ctx, `steering inbox fold failed: ${causeOf(e)}`);
    }
    // RECOVERY resets the push dedupe. `lastPushedFault` exists to keep a STABLE
    // fault from flooding the observer's sink, not to silence a NEW incident
    // that happens to stringify identically (the withDeadline timeout messages
    // do, byte-for-byte). Left standing forever, a fault pushed once could never
    // be pushed again for the run's lifetime — even after the channel healed and
    // broke the same way again. A fault-free pass clears the latch; a faulted
    // pass (including the drain-failure early return above) leaves it standing,
    // so a persistently broken channel still fires exactly once. The DIAGNOSTIC
    // is untouched: `lastInboxErrorReason` deliberately survives a healthy pass
    // ("nothing queued" is not evidence the channel healed).
    if (!faulted) lastPushedFault = null;
  };

  // Solicitations are serialized: a second solicit() queues behind the
  // in-flight one so telemetry/status mutations and caller calls never
  // interleave (the runner solicits sequentially today; the chain keeps that
  // an invariant rather than a convention). solicit never throws, so the
  // chain cannot wedge — the trailing catch is belt-and-braces only.
  let chain: Promise<unknown> = Promise.resolve();
  const solicit: SteeringController["solicit"] = (point, ctx) => {
    const run = chain.then(() => solicitSerialized(point, ctx));
    chain = run.catch(() => undefined);
    return run;
  };

  async function solicitSerialized(point: SteeringPoint, ctx: SolicitCtx): Promise<SteeringDirective> {
    // SEAM DF3.4: drain the resident inbox into ctx.promptContext here,
    // pre-render (the ctx field is mutable for exactly this slot).
    //
    // BEFORE the status gate, not after. `telemetry.status` is a one-way latch
    // — three paths write "degraded" and nothing anywhere writes "active" back
    // — so draining behind it meant one caller timeout silently stopped the
    // channel for the rest of the run: the operator's attach message was never
    // drained, never folded, never acked, and `onInboxError` never fired, while
    // `fleet attach` kept reporting it queued. That is the exact defect this
    // hook was added to close, reached through the other door. The inbox is a
    // sidecar and the operator's visibility into it must not depend on resident
    // health; the resident CALL below still stops at the gate.
    // WHAT `attach-acked` THEREFORE MEANS, stated here because this is the
    // only place the two halves are visible at once. Draining ahead of the
    // status gate is right (see above), but it means a message can be drained,
    // folded and ACKED on a solicitation that then returns PROCEED at the very
    // next line — no prompt rendered, no `deps.caller.call`, nothing put in
    // front of the resident. `fleet attach` reports `attach-acked` for that,
    // because the ack is defined by AC6 as the message reaching a
    // solicitation's prompt context, and it did.
    //
    // So `attach-acked` is an INBOX-PROCESSING receipt, not a delivery receipt,
    // and no consumer may read it as "the agent saw this". The provenance is
    // now measurable, not just arguable: a solicitation that acks something and
    // then exits at the status gate / render guard / call failure below — no
    // prompt reached the resident — bumps `acksBeforeCall`. That counter is a
    // PROCESS-LOCAL diagnostic on this controller: `fleet attach` runs in
    // another process and can never read it, so it annotates nothing the
    // operator sees — the resident's own fault channel is where the weaker-ack
    // fact surfaces. `lastInboxErrorReason` still carries the channel's
    // health.
    let ackedThisPass = 0;
    const ackedBefore = acked.size;
    await drainInbox(point, ctx);
    ackedThisPass = acked.size - ackedBefore;
    // Degraded residents are treated as absent: less agent influence, never
    // a skipped gate (INV-RES-5).
    if (telemetry.status !== "active") {
      acksBeforeCall += ackedThisPass;
      return PROCEED;
    }
    // SEAM DF3.6: the resident bounds guard gates here — AFTER the status
    // gate (AC5(a): a non-active resident is never bound-checked; a resident
    // that cannot call cannot spend, and a degraded one keeps its
    // already-latched status — "stopped" wins only when this story's
    // enforcement is the proximate cause) and BEFORE any prompt is rendered,
    // so a refused solicitation never reaches the resident. The guard emits
    // its own bounds-check log line on every call, allowed and refused alike.
    // `stopForSpend` is the one stop path, shared by the SEAM refusal and the
    // pre-correction re-gate below: internal `telemetry.status = "stopped"`
    // write (no public setter — INV-BND-1), the tripwire row carrying the
    // projected + cumulative figures, and the onBoundBreach fire — all
    // sidecar-guarded, never a throw on the solicitation path.
    const stopForSpend = async (detail: string | undefined): Promise<void> => {
      telemetry.status = "stopped";
      const row: ResidentTripwire = {
        runId: ctx.runId,
        requestId: ctx.requestId,
        cause: "spend_ceiling_breach",
        phase: ctx.phase,
        // The projected + cumulative figures that crossed the ceiling
        // (Observability Contract); the fallback is belt-and-braces for a
        // guard that refused without a detail.
        detail: detail ?? "resident spend ceiling breach",
      };
      telemetry.tripwires.push(row);
      // Same sidecar rule as reject's observer: a throwing onTripwire must
      // never convert the refusal into a throw on the solicitation path —
      // the journal row above is the record.
      try {
        deps.onTripwire?.(row);
      } catch {
        /* observability is a sidecar; the journal row above is the record */
      }
      await fireOnBoundBreach({
        bound: "spend",
        allowed: false,
        cause: "spend_ceiling_breach",
        runId: ctx.runId,
        requestId: ctx.requestId,
        phase: ctx.phase,
      });
    };
    if (deps.bounds !== undefined) {
      const verdict = deps.bounds.check(point, {
        runId: ctx.runId,
        requestId: ctx.requestId,
        phase: ctx.phase,
        spent: telemetry.spendMicros,
      });
      if (!verdict.allowed) {
        if (verdict.bound === "spend") {
          await stopForSpend(verdict.detail);
        }
        // An iterations refusal refuses THIS solicitation only — no stop, no
        // tripwire (AC3/INV-BND-5): the one bound that never stops the
        // resident. The deterministic phase walk continues, and later phases
        // solicit normally; the guard's log line is the record.
        acksBeforeCall += ackedThisPass;
        return PROCEED;
      }
    }
    let prompt: string;
    try {
      prompt = renderPrompt(point, ctx);
    } catch (err) {
      // A malformed harness ctx (e.g. promptContext not an array) throws HERE,
      // outside the call/parse guards: degrade like a call failure — the
      // never-throws contract covers prompt rendering too.
      telemetry.status = "degraded";
      lastDegradationReason = sanitizeForMessage(
        `prompt render failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      acksBeforeCall += ackedThisPass;
      return PROCEED;
    }
    for (let attempt = 1; ; attempt += 1) {
      let reply: Awaited<ReturnType<ResidentCaller["call"]>>;
      try {
        // SEAM: render → call. The caller (fleet) owns the SOLICIT_TIMEOUT_MS
        // wall-clock timer; a timeout arrives here as a throw.
        reply = await deps.caller.call(prompt);
        // A prompt REACHED the resident: every ack counted this pass is a
        // genuine fold-before-read receipt. The two exits below (degrade on
        // call failure, malformed-limit) reverse that for this pass.
        ackedThisPass = 0;
      } catch (err) {
        if (err instanceof PlacementRefusedError) {
          // DF3.6b AC4: stopped FIRST (proximate cause is this pair's
          // enforcement, not a call failure), then onBoundBreach — so the
          // next solicitation is refused by the status gate above and this
          // classification can never fall through to the degrade write
          // below, where a stopped-and-unenforceable resident would be
          // re-labeled "degraded".
          telemetry.status = "stopped";
          await fireOnBoundBreach({
            bound: "rss",
            allowed: false,
            cause: "unenforceable",
            exitCode: err.exitCode,
            runId: ctx.runId,
            requestId: ctx.requestId,
            phase: ctx.phase,
          });
          acksBeforeCall += ackedThisPass;
          return PROCEED;
        }
        // Timeout / unreachable / process death: no retry of the call, no
        // retry of the underlying phase, no gate skipped (AC3). The cause is
        // kept in memory for diagnostics — the journal's resident block is a
        // closed key set, so it has no field to carry a degradation reason.
        telemetry.status = "degraded";
        lastDegradationReason = sanitizeForMessage(err instanceof Error ? err.message : String(err));
        acksBeforeCall += ackedThisPass;
        return PROCEED;
      }
      const metered = meter(reply.usage);
      // DF3.6a INV-BND-3 (AC4): a reply yielding no positive usage — the
      // usage object ABSENT, a literal {0,0}, or unpriced garbage (any shape
      // whose token counts are not positive numbers) — is charged the
      // projected worst case on the CEILING accumulator, never zero: without
      // this arm a silent resident zeroes its own meter by replying with no
      // usage and spends unbounded. A POSITIVE-token reply whose per-term
      // rounding lands at 0 µ$ (ten tokens at 0.08/MTok) is genuinely PRICED
      // sub-micro-dollar and is NOT charged — its metered figure is real,
      // and charging it the projection would stop a cheap-call resident far
      // below the ceiling. The DF2.12 attribution row below keeps its
      // shipped METERED disposition (absent → unpriced, {0,0} → priced-zero,
      // unpriced garbage → unpriced) — the projection is ceiling-side
      // protection and never enters the ledger (one spend truth per basis).
      // Runs per REPLY: the malformed-correction attempt is also a billed
      // call. Safe-integer guard matches the meter's own: an unsafe sum
      // leaves the last exact spendMicros intact instead of corrupting it.
      const posTokens = (v: unknown): boolean => typeof v === "number" && Number.isFinite(v) && v > 0;
      if (
        deps.bounds !== undefined &&
        metered.costMicroUsd === 0 &&
        !(posTokens(reply.usage?.inputTokens) || posTokens(reply.usage?.outputTokens))
      ) {
        const charged = telemetry.spendMicros + deps.bounds.projectedPerCallMicros;
        if (Number.isSafeInteger(charged)) telemetry.spendMicros = charged;
      }
      emitResidentAttribution(ctx, metered, reply.usage);
      let parsed: ReplyParse;
      try {
        // SEAM: call → parse.
        parsed = parseReply(reply.raw);
      } catch (err) {
        // A throwing extractor is a malformed reply like any other (AC3's
        // never-throws contract) — it counts toward the malformed limit.
        parsed = { ok: false, reason: `reply extraction failed: ${sanitizeForMessage(String(err))}` };
      }
      if (!parsed.ok) {
        if (attempt >= MAX_MALFORMED_ATTEMPTS) {
          telemetry.status = "degraded";
          lastDegradationReason = sanitizeForMessage(`malformed reply: ${parsed.reason}`);
          return PROCEED;
        }
        // DF3.6a re-gate (AC1's margin): the correction attempt is a SECOND
        // billed call inside ONE solicitation, and the SEAM check above gated
        // only the first. Without this, a resident at ceiling−ε that replies
        // malformed once and then validly meters TWO calls past a single
        // check — the exact "spend above ceiling + one call's metered cost"
        // shape AC1's negative control exists to fail. The comparison is
        // inline against the guard's public figures, NOT a second
        // guard.check(): check() emits the bounds line and (on allow)
        // increments the per-phase counter, and a correction is not a new
        // solicitation. Refused ⇒ stopped via the same stopForSpend path.
        if (
          deps.bounds !== undefined &&
          telemetry.spendMicros + deps.bounds.projectedPerCallMicros > deps.bounds.effectiveCeilingMicros
        ) {
          await stopForSpend(
            `projected ${deps.bounds.projectedPerCallMicros} µ$ + spent ${telemetry.spendMicros} µ$ = ${
              telemetry.spendMicros + deps.bounds.projectedPerCallMicros
            } µ$ exceeds effective ceiling ${deps.bounds.effectiveCeilingMicros} µ$ (pre-correction re-gate)`,
          );
          return PROCEED;
        }
        prompt = malformedCorrectionPrompt(parsed.reason, point, ctx);
        continue;
      }
      const result = SteeringDirectiveSchema.safeParse(parsed.parsed);
      if (!result.success) {
        // Single attempt — no reparse for schema rejections (AC2).
        return reject(ctx, rejectionDetail(parsed.parsed, result.error));
      }
      const directive = result.data;
      // A schema-valid directive at a point where nothing it names is pending
      // is rejected like any other overreach — counted rejected and
      // tripwire-recorded BEFORE `directives` can count it, never returned to
      // the runner as an accepted steer.
      if (!POINT_ALLOWLIST[point].includes(directive.action)) {
        return reject(ctx, `action ${sanitizeForMessage(directive.action)} has no steering effect at ${point}`);
      }
      // An absent rosterIds is an EMPTY set, not an unvalidated one: with no
      // closed id set in hand there is nothing a roster pick could legally
      // name (fail-closed, INV-RES-2).
      if (
        directive.action === "select_roster" &&
        !(ctx.rosterIds ?? []).includes(directive.rosterId)
      ) {
        return reject(ctx, `rosterId outside closed roster set: ${sanitizeForMessage(directive.rosterId)}`);
      }
      // The same fail-closed rule for the phase the pick names: an absent
      // phaseIds reads as an EMPTY set, so a pick targeting a phase the
      // runner never declared is a rejection, not an acceptance.
      if (
        directive.action === "select_roster" &&
        !(ctx.phaseIds ?? []).includes(directive.phase)
      ) {
        return reject(ctx, `phase outside closed phase set: ${sanitizeForMessage(directive.phase)}`);
      }
      telemetry.directives += 1;
      // steeringIterations counts retries that are actually executable —
      // post_gate_failure is the only point where a retry survives the
      // allowlist above (AC5: the per-phase counter is steering proof, so it
      // must not be inflated by a retry that cannot run).
      if (directive.action === "retry" && point === "post_gate_failure" && ctx.phase !== undefined) {
        telemetry.steeringIterations[ctx.phase] = (telemetry.steeringIterations[ctx.phase] ?? 0) + 1;
      }
      // SEAM DF3.4: ack the reply into the inbox record here.
      return directive;
    }
  }

  return {
    // Snapshot accessor: internal writes target the private `telemetry`
    // instance; callers get a copy they can neither mutate through nor
    // observe mid-flight mutation on.
    get telemetry(): ResidentTelemetry {
      return {
        ...telemetry,
        steeringIterations: { ...telemetry.steeringIterations },
        tripwires: telemetry.tripwires.map((t) => ({ ...t })),
      };
    },
    solicit,
    get lastDegradationReason() {
      return lastDegradationReason; // sanitized at write (INV-2)
    },
    get lastInboxErrorReason() {
      return lastInboxErrorReason; // sanitized at write (INV-2)
    },
    get lastAttributionErrorReason() {
      return lastAttributionErrorReason; // sanitized at latch (INV-2)
    },
    get acksBeforeCall() {
      return acksBeforeCall;
    },
  };
}
