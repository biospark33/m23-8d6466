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
/** Deadline on each injected inbox call. The port is injected precisely so the
 *  transport can be swapped, and `solicit` serializes every solicitation through
 *  one chain — so a hung inbox (a stalled mount, any future non-local
 *  `SteeringInbox`) wedges every LATER solicitation with no timeout, no
 *  `onInboxError` and no diagnostic. The channel's own convention on the fleet
 *  leg is a deadline (`withTimeout(..., "attach-ack-read")`); this is the
 *  engine-side half of it. */
export const INBOX_CALL_TIMEOUT_MS = 5_000;

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
   *  Throws on timeout / unreachable / process death. */
  call(prompt: string): Promise<{ raw: string; usage: { inputTokens: number; outputTokens: number } }>;
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
   *  controller dedupes on `messageId`, so a re-issued line delivers once. */
  drain(point: SteeringPoint): Promise<readonly { messageId: string; message: string }[]>;
  /** Records that `messageId` reached a solicitation's prompt context. */
  ack(messageId: string, point: SteeringPoint): Promise<void>;
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

/** D4 tripwire row. `spend_ceiling_breach` + `watchdog_kill` are DF3.6's to
 *  raise — the cause union stays closed to "gate_bypass_attempt" in DF3.3. */
export interface ResidentTripwire {
  runId: string;
  requestId?: string;
  cause: "gate_bypass_attempt";
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
  /** Never throws. Degraded/disabled → resolves { action: "proceed" }
   *  (deterministic default, INV-RES-5). */
  solicit(point: SteeringPoint, ctx: SolicitCtx): Promise<SteeringDirective>;
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
   *  behavior. Additive, so DF3.6 can add its bounds deps to the same object. */
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
  let lastDegradationReason: string | null = null;
  let lastInboxErrorReason: string | null = null;

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
  const meter = (usage: { inputTokens?: unknown; outputTokens?: unknown } | undefined): void => {
    const inputMicros = Math.round((clampTerm(usage?.inputTokens) * rateInput) / 1_000_000);
    const outputMicros = Math.round((clampTerm(usage?.outputTokens) * rateOutput) / 1_000_000);
    if (!Number.isSafeInteger(inputMicros) || !Number.isSafeInteger(outputMicros)) return;
    const next = telemetry.spendMicros + inputMicros + outputMicros;
    // Defense-in-depth: reachable when already-safe terms SUM past
    // MAX_SAFE_INTEGER — directly tested by the sum-guard test.
    if (!Number.isSafeInteger(next)) return;
    telemetry.spendMicros = next;
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
   */
  const acked = new Set<string>();
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
   */
  const reportInboxFault = async (ctx: SolicitCtx, detail: string): Promise<void> => {
    const sanitized = sanitizeForMessage(detail); // INV-2: sanitized at write
    lastInboxErrorReason = sanitized;
    if (sanitized === lastPushedFault) return;
    lastPushedFault = sanitized;
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
   */
  const drainInbox = async (point: SteeringPoint, ctx: SolicitCtx): Promise<void> => {
    if (deps.inbox === undefined) return;
    // Whether THIS pass reported a fault — a fault-free pass is the recovery
    // signal that resets the push dedupe latch at the bottom.
    let faulted = false;
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
    try {
      for (const { messageId, message } of queued) {
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
          const line = `operator attach ${sanitizeForMessage(messageId).slice(0, DIRECTIVE_ID_CHAR_CEILING)}: ${sanitizeForMessage(message).slice(0, ATTACH_MESSAGE_CHAR_CEILING)}`;
          if (foldedChars + line.length > ATTACH_FOLD_CHAR_BUDGET) {
            // Over the run's total budget: NOT folded, and therefore NOT acked —
            // the ack means "this reached a solicitation's prompt context" and
            // this one did not, so `fleet attach` telling the operator it stays
            // queued remains true. `break`, not `continue`: the queue is
            // oldest-first, so nothing behind this one is more entitled to the
            // remaining budget.
            faulted = true;
            await reportInboxFault(
              ctx,
              `steering inbox fold budget of ${ATTACH_FOLD_CHAR_BUDGET} chars is exhausted: later attach messages are not being delivered`,
            );
            break;
          }
          ctx.promptContext.push(line);
          foldedChars += line.length;
          delivered.set(messageId, point);
        }
        if (acked.has(messageId)) continue;
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
          await reportInboxFault(
            ctx,
            `steering inbox ack failed for ${sanitizeForMessage(messageId).slice(0, DIRECTIVE_ID_CHAR_CEILING)}: ${causeOf(e)}`,
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
    // and no consumer may read it as "the agent saw this". The two fields that
    // distinguish the cases are `telemetry.status` — a one-way latch, so
    // `degraded` here means degraded for the rest of the run — and
    // `lastInboxErrorReason`. An operator who needs delivery, not queueing, has
    // to look at those; the ack alone cannot tell them apart.
    await drainInbox(point, ctx);
    // Degraded residents are treated as absent: less agent influence, never
    // a skipped gate (INV-RES-5).
    if (telemetry.status !== "active") return PROCEED;
    // SEAM DF3.6: checkBounds(point) wraps here — spend/iteration/RSS bounds
    // gate before any prompt is rendered.
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
      return PROCEED;
    }
    for (let attempt = 1; ; attempt += 1) {
      let reply: Awaited<ReturnType<ResidentCaller["call"]>>;
      try {
        // SEAM: render → call. The caller (fleet) owns the SOLICIT_TIMEOUT_MS
        // wall-clock timer; a timeout arrives here as a throw.
        reply = await deps.caller.call(prompt);
      } catch (err) {
        // Timeout / unreachable / process death: no retry of the call, no
        // retry of the underlying phase, no gate skipped (AC3). The cause is
        // kept in memory for diagnostics — the journal's resident block is a
        // closed key set, so it has no field to carry a degradation reason.
        telemetry.status = "degraded";
        lastDegradationReason = sanitizeForMessage(err instanceof Error ? err.message : String(err));
        return PROCEED;
      }
      meter(reply.usage);
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
  };
}
