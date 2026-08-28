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
  z.object({ action: z.literal("proceed"), note: z.string().optional() }).strict(),
  z.object({ action: z.literal("retry"), guidance: z.string(), note: z.string().optional() }).strict(),
  z
    .object({
      action: z.literal("select_roster"),
      phase: z.string(),
      rosterId: z.string(),
      note: z.string().optional(),
    })
    .strict(),
  z.object({ action: z.literal("abort"), reason: z.string(), note: z.string().optional() }).strict(),
]);
export type SteeringDirective = z.infer<typeof SteeringDirectiveSchema>;

/** Derived from the schema itself (A8) so the literals cannot drift apart. */
const KNOWN_ACTIONS = SteeringDirectiveSchema.options.map((m) => m.shape.action.value) as readonly string[];

/** Fleet-supplied agent caller. Engine never imports fleet (INV-RES-1). */
export interface ResidentCaller {
  /** One synchronous solicitation. Returns raw reply text + token usage.
   *  Throws on timeout / unreachable / process death. */
  call(prompt: string): Promise<{ raw: string; usage: { inputTokens: number; outputTokens: number } }>;
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
  readonly telemetry: ResidentTelemetry;
  /** In-memory diagnostic for the most recent degradation (call failure or
   *  malformed-reply limit), sanitized at write. NOT journaled: the journal's
   *  resident block is a closed key set with no field for a degradation
   *  cause, and the tripwire cause union stays closed to
   *  "gate_bypass_attempt" (AC5/AC2) — so this lives on the controller only.
   */
  readonly lastDegradationReason: string | null;
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

  /** Integer µ$ per reply (DD-9): round at each term, sum integers only.
   *  A non-finite or negative token count — or rate — clamps to 0: one
   *  poisoned input would otherwise turn spendMicros non-integer (JSON null)
   *  for the run. A reply carrying no usage object meters as zero rather than
   *  throwing (the never-throws contract covers metering too). */
  const clampTerm = (n: unknown): number => (typeof n === "number" && Number.isFinite(n) && n > 0 ? n : 0);
  const rateInput = clampTerm(deps.rate.inputPerMTok);
  const rateOutput = clampTerm(deps.rate.outputPerMTok);
  const meter = (usage: { inputTokens?: unknown; outputTokens?: unknown } | undefined): void => {
    telemetry.spendMicros +=
      Math.round((clampTerm(usage?.inputTokens) * rateInput) / 1_000_000) +
      Math.round((clampTerm(usage?.outputTokens) * rateOutput) / 1_000_000);
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
    // Degraded residents are treated as absent: less agent influence, never
    // a skipped gate (INV-RES-5).
    if (telemetry.status !== "active") return PROCEED;
    // SEAM DF3.6: checkBounds(point) wraps here — spend/iteration/RSS bounds
    // gate before any prompt is rendered.
    // SEAM DF3.4: drain the resident inbox into ctx.promptContext here,
    // pre-render (the ctx field is mutable for exactly this slot).
    let prompt = renderPrompt(point, ctx);
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
      // post_gate_failure only. A retry accepted at run_start/run_end still
      // counts in `directives`, but there is no phase attempt it could steer
      // (AC5: the per-phase counter is steering proof, so it must not be
      // inflated by a retry that cannot run).
      if (directive.action === "retry" && point === "post_gate_failure" && ctx.phase !== undefined) {
        telemetry.steeringIterations[ctx.phase] = (telemetry.steeringIterations[ctx.phase] ?? 0) + 1;
      }
      // SEAM DF3.4: ack the reply into the inbox record here.
      return directive;
    }
  }

  return {
    telemetry,
    solicit,
    get lastDegradationReason() {
      return lastDegradationReason; // sanitized at write (INV-2)
    },
  };
}
