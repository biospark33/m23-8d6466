/**
 * M3.2 — the closed L4 proposal + weekly-receipt schemas.
 *
 * PROPOSE is the ceiling (FR-LEARN-30): a proposal is an advisory record the
 * operator applies in their own change — never a directive. Everything here is
 * zod `.strictObject()` — unknown fields refuse at every level (the A5
 * missing-and-extra-fail discipline applied to proposals) — and the
 * make-or-break negative controls live in refinements: a `threshold-suggestion`
 * that is not advisory + operator-adjudicated + J2-gate-noted refuses (AC2),
 * and a receipt whose proposals are not covered exactly once by `posted`
 * refuses — bank-only retention without a firing-leg carrier is not posting
 * (AC3). By the same token there is NO severity field of any kind (Jev
 * LOCKED #9 — severity stays with the frontier session) and NO status field
 * (a proposal-status machine written and honored by this system is auto-apply's
 * little sibling; the operator's adjudication lives in their own change, not
 * in a state this schema tracks).
 */
import { z } from "zod";

// ─── kinds + literals ────────────────────────────────────────────────────────

/** The closed proposal kinds — `router-tuning` concerns model-tier selection only. */
export const PROPOSAL_KINDS = ["router-tuning", "threshold-suggestion", "skill-update"] as const;

export type ProposalKind = (typeof PROPOSAL_KINDS)[number];

export const PROPOSAL_SCHEMA_LITERAL = "qds.l4-proposal";
export const RECEIPT_SCHEMA_LITERAL = "qds.l4-week-receipt";

/** The weekly `week` field shape — e.g. `2026-W41` (ISO-8601 week numbering),
 *  year 0001–9999 and week 01–53 only: `isoWeekOf` can never emit W00/W54+ (nor
 *  year 0000 — Date.UTC maps it to 1900), and a mislabeled week is unrecoverable
 *  in the append-only store. Shared seam contract — imported by weekly-reflect.ts
 *  and scripts/memory-weekly.ts. */
export const ISO_WEEK_RE = /^[1-9]\d{3}-W(0[1-9]|[1-4]\d|5[0-3])$/;

/** Proposal rationale ceiling, mirroring phase-engine's ATTACH_MESSAGE_CHAR_CEILING
 *  (steering.ts) — same number, not derived from it: a proposal is read in a
 *  chat turn (DF1.11), so it inherits the attach-message bound by coincidence
 *  of the same constraint, not by contract; tuning one must not silently move
 *  the other. */
export const PROPOSAL_RATIONALE_CHAR_CEILING = 4_000;

/** ISO-8601 week label for a date: `2026-W41`. Pure UTC arithmetic — the year
 *  is the year of the week's THURSDAY, not the date's own year, so a Jan 1
 *  that falls in the prior year's last week (2027-01-01 → 2026-W53) labels
 *  correctly. */
export function isoWeekOf(d: Date): string {
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const day = t.getUTCDay() || 7; // Mon=1 … Sun=7
  t.setUTCDate(t.getUTCDate() + 4 - day); // the week's Thursday
  const year = t.getUTCFullYear();
  const week = Math.ceil(((t.getTime() - Date.UTC(year, 0, 1)) / 86_400_000 + 1) / 7);
  return `${year}-W${String(week).padStart(2, "0")}`;
}

// ─── proposal schema (AC2 refinement) ────────────────────────────────────────

export const ProposalSchema = z
  .strictObject({
    schema: z.literal(PROPOSAL_SCHEMA_LITERAL),
    proposal_id: z.string().min(1),
    kind: z.enum(PROPOSAL_KINDS),
    week: z.string().regex(ISO_WEEK_RE),
    fired_at: z.string().datetime(),
    target_bank: z.string().min(1),
    advisory: z.boolean(),
    /** Only ever "operator" — FR-LEARN-30: the operator reviews and applies;
     *  a proposal asserted to satisfy J2's DD-21 sign-off is out of bounds. */
    adjudicator: z.literal("operator").optional(),
    /** Required on threshold-suggestions: names J2's DD-21 milestone gate as
     *  UNSATISFIED by this proposal (a proposal is not sign-off). */
    j2_gate_note: z.string().optional(),
    rationale: z.string().max(PROPOSAL_RATIONALE_CHAR_CEILING),
    suggested_change: z.strictObject({
      area: z.enum(["router", "threshold", "skill"]),
      summary: z.string().min(1),
    }),
    evidence: z.strictObject({
      routing_log_refs: z.array(z.string()),
      kpi_snapshot_refs: z.array(z.string()),
      run_record_refs: z.array(z.string()),
    }),
    insights_cited: z.array(z.string()),
    created_at: z.string().datetime(),
  })
  .superRefine((p, ctx) => {
    if (p.kind !== "threshold-suggestion") return;
    if (p.advisory !== true) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["advisory"],
        message:
          'a threshold-suggestion must carry advisory:true — a suggestion indistinguishable from a directive is the AC2 negative control',
      });
    }
    if (p.adjudicator !== "operator") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["adjudicator"],
        message: 'a threshold-suggestion must name its adjudicator — the operator (AC2)',
      });
    }
    if (p.j2_gate_note === undefined || p.j2_gate_note.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["j2_gate_note"],
        message:
          "a threshold-suggestion must carry a j2_gate_note naming J2's DD-21 milestone gate as unsatisfied by this proposal",
      });
    }
  });

export type ProposalRecord = z.infer<typeof ProposalSchema>;

// ─── weekly receipt schema (AC3 refinement) ──────────────────────────────────

export const WeeklyReceiptSchema = z
  .strictObject({
    schema: z.literal(RECEIPT_SCHEMA_LITERAL),
    week: z.string().regex(ISO_WEEK_RE),
    fired_at: z.string().datetime(),
    leg: z.enum(["crontab", "schedule"]),
    proposals: z.array(z.string()),
    superseded: z.array(z.string()),
    absent_sources: z.array(
      z.strictObject({
        source: z.enum(["routing-log", "kpi-snapshots", "run-records"]),
        status: z.literal("absent"),
      }),
    ),
    banks_ok: z.array(z.string()),
    banks_failed: z.array(z.string()),
    posted: z.array(
      z.strictObject({
        proposal_id: z.string().min(1),
        carrier: z.enum(["chat", "stdout"]),
      }),
    ),
    total_ms: z.number().int().min(0),
    /** Absent, not 0-filled, when a bank was skipped (AC4 absence discipline). */
    reflect_ms_by_bank: z.record(z.number()).optional(),
  })
  .superRefine((r, ctx) => {
    // AC3, both directions: bank-only retention is not posting (every proposal
    // id covered EXACTLY once in `posted` — a duplicate carrier row is not a
    // second post) and posting-without-landing is not posting either (no
    // `posted` row naming an id absent from `proposals`).
    const postedCount = new Map<string, number>();
    for (const p of r.posted) postedCount.set(p.proposal_id, (postedCount.get(p.proposal_id) ?? 0) + 1);
    const proposalCount = new Map<string, number>();
    for (const id of r.proposals) proposalCount.set(id, (proposalCount.get(id) ?? 0) + 1);
    r.proposals.forEach((id, i) => {
      if (proposalCount.get(id) !== 1) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["proposals", i],
          message: `proposal "${id}" appears ${proposalCount.get(id)} times in proposals — one landing, one receipt row (AC3)`,
        });
      } else if (postedCount.get(id) !== 1) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["proposals", i],
          message: `proposal "${id}" must appear exactly once in posted — retention without the firing leg's carrier is not posting (AC3)`,
        });
      }
    });
    r.posted.forEach((p, i) => {
      if (!proposalCount.has(p.proposal_id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["posted", i],
          message: `posted proposal "${p.proposal_id}" is not in proposals — a posting without a landed proposal is not posting (AC3)`,
        });
      }
    });
  });

export type WeeklyReceipt = z.infer<typeof WeeklyReceiptSchema>;
