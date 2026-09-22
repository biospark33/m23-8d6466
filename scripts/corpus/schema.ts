/**
 * The triage corpus record schema (JEV-1) — single source for every writer.
 *
 * Three consumers share this file: `merge.ts` (forward capture, validates the
 * skill's sidecar and projects records), `backfill.ts` (historical ledgers),
 * and the Wave-3 Jev observer (imports the barrel `scripts/corpus/index.ts`).
 * The schema is the shared contract — never re-declared per caller.
 *
 * Shape decisions are LOCKED in handoff §11 gate resolution 1: five historical
 * dispositions + the widened `GATE_ACTION`, and the six reserved A/B fields
 * (§3.12) defined NOW so the agreement-with-lead join has a selectable frontier
 * population before any measurement exists. `.strict()` means an unknown key —
 * including a secret-bearing one (INV-C1) — is a validation error, never a
 * silently dropped field.
 */

import { z } from "zod";

/** The disposition vocabulary: 5 historical + the widened GATE_ACTION. LOCKED — do not narrow. */
export const DISPOSITIONS = ["PATCH", "DISMISS", "DEFER", "DECISION_NEEDED", "POST_MERGE_CHANGED", "GATE_ACTION"] as const;
export type Disposition = (typeof DISPOSITIONS)[number];

/**
 * ISO-8601 date or timestamp. Date-only is legal — it is exactly the
 * day-granular honesty the backfill timestamp rule demands (never a
 * fabricated intraday time).
 */
const ISO_8601_RE = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?(Z|[+-]\d{2}:?\d{2})?)?$/;

const isoTimestamp = z
  .string()
  .refine((s) => ISO_8601_RE.test(s) && !Number.isNaN(Date.parse(s)), "must be an ISO-8601 date or timestamp");

/**
 * The six reserved A/B measurement fields (§3.12). Written `null` unless real
 * data exists — an estimate is labeled by its field name, never passed off as
 * metered, and the frontier rate stays null until steve calibrates it.
 */
const abReserved = {
  arm: z.enum(["frontier", "jev"]).nullish().default(null),
  latency_ms: z.number().int().nonnegative().nullish().default(null),
  cost_exact_usd: z.number().nullish().default(null),
  cost_estimate_usd: z.number().nullish().default(null),
  outcome_confirmed: z.boolean().nullish().default(null),
  outcome_source: z.string().nullish().default(null),
};

/** One corpus record — the unit every writer appends to the JSONL files. */
export const TriageRecordSchema = z
  .object({
    finding_id: z.string().min(1),
    finding_text: z.string().min(1),
    diff_context_ref: z.string().min(1),
    label: z.string().min(1),
    disposition: z.enum(DISPOSITIONS),
    rationale: z.string().optional(),
    labeler: z.string().min(1),
    pr: z.number().int().positive().nullable(),
    round: z.number().int().positive().nullable(),
    created_at: isoTimestamp.nullable(),
    ...abReserved,
  })
  .strict();
export type TriageRecord = z.infer<typeof TriageRecordSchema>;

/**
 * `<workdir>/triage.json` — the sidecar the bmad-code-review skill writes
 * (Appendix A of the story). It is the record's INPUT projection: unified
 * findings plus `pr`/`round`, with `created_at`/`latency_ms` optional per
 * finding (the session knows the triage moment better than merge time) and
 * `duration_ms` optional at top level (the §3.12 frontier cost input).
 */
export const TriageSidecarSchema = z
  .object({
    pr: z.number().int().positive(),
    round: z.number().int().positive(),
    duration_ms: z.number().int().nonnegative().optional(),
    findings: z
      .array(
        z
          .object({
            finding_id: z.string().min(1),
            finding_text: z.string().min(1),
            diff_context_ref: z.string().min(1),
            label: z.string().min(1),
            disposition: z.enum(DISPOSITIONS),
            rationale: z.string().optional(),
            created_at: isoTimestamp.optional(),
            latency_ms: z.number().int().nonnegative().optional(),
          })
          .strict(),
      )
      .min(1),
  })
  .strict();
export type TriageSidecar = z.infer<typeof TriageSidecarSchema>;

/**
 * The idempotence key `(pr, round, finding_id, labeler)` — the same tuple for
 * both writers, so a backfill record can never duplicate a forward one and a
 * re-run can never double-append.
 */
export function recordKey(r: { pr: number | null; round: number | null; finding_id: string; labeler: string }): string {
  return `${r.pr ?? "x"}|${r.round ?? "x"}|${r.finding_id}|${r.labeler}`;
}

/** Zod issues as `field.path: message` lines — the named-field error contract (AC3). */
export function zodErrors(error: z.ZodError): string[] {
  return error.issues.map((i) => `${i.path.join(".")}: ${i.message}`);
}
