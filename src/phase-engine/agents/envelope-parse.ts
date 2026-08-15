/**
 * Loop A's parse step (Story DF1.3).
 *
 * A send returns raw model text. `extractJsonCandidate` finds the Report JSON
 * the way SSSF's `_extract_json` did (R4 §1.9, `MOD/agents.py:253-264`) — the
 * model may wrap it in prose or a fenced code block — and `EnvelopeSchema`
 * schema-validates it against DF1.2's envelope shape. On failure, `parseEnvelope`
 * returns STRUCTURED issues plus the required-field list, which is everything
 * the correction prompt may carry: the model's own output is never
 * interpolated back into instruction text (INV-2).
 */
import { z, type ZodIssue } from "zod";

import type { Envelope } from "../envelopes/types.ts";
import { sanitizeForMessage } from "../types.ts";

// Keep both literal enums in sync with their declaration sites: ExitStatus is
// the CC-1 5-value taxonomy in cli-anything/src/types.ts, the kind union is
// DF1.2's EnvelopeKind in envelopes/types.ts. A sixth CC-1 status must be
// added here in the same change (no shared const exists across the two
// packages without widening this story's file scope).
const ExitStatusSchema = z.enum(["success", "transient", "overflow", "logic", "lead_failure"]);

const ReviewFindingSchema = z.object({
  requirement: z.string(),
  met: z.boolean(),
  note: z.string(),
});

/**
 * DF1.2's `Envelope` as a closed schema: every key is known, so an
 * instruction-shaped extra key is a validation error whose sanitized name
 * reaches the correction prompt — never a silently ignored field.
 */
export const EnvelopeSchema = z
  .object({
    kind: z.enum(["generic", "verify", "review", "changes"]),
    label: z.string(),
    status: ExitStatusSchema,
    summary: z.string(),
    outputTail: z.string().optional(),
    artifacts: z.array(z.string()).optional(),
    changedFiles: z.array(z.string()).optional(),
    approved: z.boolean().optional(),
    blocking: z.array(z.string()).optional(),
    findings: z.array(ReviewFindingSchema).optional(),
  })
  .strict();

/** The fields a correction prompt may tell the model about. */
export const REQUIRED_ENVELOPE_FIELDS = ["kind", "label", "status", "summary"] as const;

/** First balanced `{...}` in `text`, respecting string escapes; `undefined` if none closes. */
function balancedObject(text: string): string | undefined {
  const start = text.indexOf("{");
  if (start < 0) return undefined;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i]!;
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return undefined;
}

/**
 * Extracts the JSON candidate from a raw response: a fenced code block is
 * preferred, otherwise the first balanced object anywhere in the text.
 */
export function extractJsonCandidate(text: string): string | undefined {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  if (fenced?.[1] !== undefined) {
    const inner = balancedObject(fenced[1]);
    if (inner !== undefined) return inner;
  }
  return balancedObject(text);
}

export type ParseOutcome =
  | { ok: true; envelope: Envelope }
  | {
      ok: false;
      reason: "no_json" | "schema";
      /** Sanitized, harness-formatted — safe to embed in a correction prompt. */
      issues: string[];
      requiredFields: readonly string[];
    };

/**
 * One Zod issue as an INV-2-safe line: the sanitized path plus the issue code
 * and harness-authored extras ONLY. Zod's own `message` is NOT used — codes
 * like `invalid_enum_value` and `unrecognized_keys` echo the model's raw input
 * back into the message ("...received 'STEER-ME-…'", the offending key text),
 * and the model's output must never be interpolated into a correction
 * instruction. Type names, enum option lists and numeric bounds are harness
 * words and are safe to carry.
 */
function safeIssueLine(issue: ZodIssue): string {
  const path = issue.path.map((seg) => sanitizeForMessage(String(seg))).join(".") || "$";
  const detail = issue as ZodIssue & {
    expected?: unknown;
    received?: unknown;
    options?: unknown;
    minimum?: unknown;
    maximum?: unknown;
  };
  switch (issue.code) {
    case "invalid_type":
      return `${path}: expected type ${String(detail.expected ?? "valid")}, received type ${String(detail.received ?? "unknown")}`;
    case "invalid_enum_value":
      return `${path}: value must be one of ${JSON.stringify(
        Array.isArray(detail.options) ? detail.options.map(String) : [],
      )}`;
    case "unrecognized_keys":
      return `${path}: unrecognized key(s) present; only envelope fields are allowed`;
    case "too_small":
      return `${path}: too small (minimum ${String(detail.minimum ?? "?")})`;
    case "too_big":
      return `${path}: too big (maximum ${String(detail.maximum ?? "?")})`;
    default:
      return `${path}: ${issue.code}`;
  }
}

export function parseEnvelope(raw: string): ParseOutcome {
  const candidate = extractJsonCandidate(raw);
  if (candidate === undefined) {
    return {
      ok: false,
      reason: "no_json",
      issues: ["no JSON object was found in the response"],
      requiredFields: REQUIRED_ENVELOPE_FIELDS,
    };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(candidate);
  } catch {
    // INV-2: the parse error's message is NOT used — engines echo the raw
    // offending token verbatim ("Unexpected identifier '<model text>'"), which
    // would carry model-authored text straight into the correction prompt.
    return {
      ok: false,
      reason: "no_json",
      issues: ["the extracted JSON candidate is not valid JSON"],
      requiredFields: REQUIRED_ENVELOPE_FIELDS,
    };
  }
  const result = EnvelopeSchema.safeParse(parsed);
  if (!result.success) {
    return {
      ok: false,
      reason: "schema",
      issues: result.error.issues.map(safeIssueLine),
      requiredFields: REQUIRED_ENVELOPE_FIELDS,
    };
  }
  return { ok: true, envelope: result.data };
}

/**
 * The Loop A correction, built from harness-generated text ONLY (INV-2): the
 * validator's structured error plus the required field list. The model's
 * invalid output is retained as data in an invalid-envelope record and is
 * never interpolated here — an agent cannot steer its own retry by emitting
 * instruction-shaped garbage.
 */
export function parseCorrectionPrompt(outcome: Extract<ParseOutcome, { ok: false }>): string {
  return [
    "Your previous response could not be used as a Report envelope.",
    "Validator errors:",
    ...outcome.issues.map((issue) => `- ${issue}`),
    `Required fields: ${outcome.requiredFields.join(", ")}.`,
    "Re-emit ONLY your Report JSON.",
  ].join("\n");
}
