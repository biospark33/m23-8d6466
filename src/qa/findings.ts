/**
 * A2 QA-department findings — the shared vocabulary every QA leg speaks.
 *
 * Three artifacts, all schema-validated (zod, safeParse at the trust
 * boundary):
 *  - `FindingSchema`     — the normalized payload (AC2: attributable to
 *                          `(runId, lens)`), the shape leaf-1.2.1's retain
 *                          and leaf-1.4.1's hunter-pack consume.
 *  - `HarvestOutputSchema` — what a QA leg's harvest output may contain:
 *                          structured-only, INV-KG-3 posture (run-retain.ts
 *                          builds its payload the same way) — every field is
 *                          bounded identity except `finding_text`, the sole
 *                          prose channel.
 *  - `QaVerdictProducerSchema` — ADR-2's producer side (C8): the consumed
 *                          shape is G1's `QaVerdictSchema`
 *                          (auto-merge-policy.ts:88), and this producer adds
 *                          provenance extras on top of it, adds-only.
 *
 * `normalizeHarvest` is the per-lens normalizer: it stamps every finding with
 * the leg's `runId` and the driver's `lens` (so (runId, lens) attribution is
 * minted here, never in the box), and it obeys the absent-not-0 law
 * (kpis.ts:17): a leg that did not run yields NO findings array at all — `[]`
 * is reserved for ran-and-found-none.
 */

import { z } from "zod";

import type { ResultPayload } from "../fleet/result.ts";

/**
 * The hunter-pack lens roster (story Technical Notes, thresholds-in-code):
 * three lenses today, `MAX_QA_LEGS` = 4 leaves headroom for one added lens
 * without a config surface.
 */
export const QA_LENS = ["correctness", "secret-hygiene", "diff-scope"] as const;
export type QaLens = (typeof QA_LENS)[number];

/** Cap on concurrent QA legs — roster length + headroom for one added lens. */
export const MAX_QA_LEGS = 4;

/**
 * The story-pinned QA log-vocabulary tokens (Observability Contract), the
 * operation ids every QA module uses — identical strings everywhere.
 */
export const QA_LOG = {
  protocolStart: "qa-protocol-start",
  legSubmitted: "qa-leg-submitted",
  legTerminal: "qa-leg-terminal",
  findingsRetained: "qa-findings-retained",
  issuesFiled: "qa-issues-filed",
} as const;

/** Bounded-printable ceiling for the non-prose string fields. */
const ID_MAX = 64;
/** Bounded-printable ceiling for the diff reference (a path-ish ref, not prose). */
const DIFF_REF_MAX = 512;
/** The prose channel is still bounded — never truncated, refused at the boundary. */
const FINDING_TEXT_MAX = 4096;
/** Per-harvest finding cap (a leg's harvest is one lens's pass over one commit). */
export const MAX_FINDINGS_PER_HARVEST = 32;

/** Printable bounded identity, never prose: the "no prose channel" header. */
const BOUNDED_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;

/** The minted-runId shape (qds-YYYYMMDD-hex6) — a finding is attributable only
 * to a fleet run, so the boundary refuses legacy/foreign id shapes. (retain.ts
 * re-checks with the same pin as defense-in-depth.) */
const RUN_ID_RE = /^qds-\d{8}-[a-f0-9]{6}$/;

/**
 * A diff reference is path-shaped (`/` allowed), so it carries the same
 * path-ellipsis channel request-id guards refuse in run-retain.ts:87.
 */
const BOUNDED_REF_RE = /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/;
const noPathEllipsis = (s: string) => !s.includes("..");
const BoundedRefSchema = z
  .string()
  .min(1)
  .max(DIFF_REF_MAX)
  .regex(BOUNDED_REF_RE)
  .refine(noPathEllipsis);

/** A normalized QA finding — the exact E2E-slice shape, strict (no extras). */
export const FindingSchema = z
  .object({
    runId: z.string().regex(RUN_ID_RE),
    lens: z.string().min(1).max(ID_MAX).regex(BOUNDED_ID_RE),
    finding_text: z.string().min(1).max(FINDING_TEXT_MAX),
    diff_context_ref: BoundedRefSchema,
  })
  .strict();
export type Finding = z.infer<typeof FindingSchema>;

/** One structured finding a QA leg's harvest may carry (no runId/lens yet —
 * those are minted by the normalizer from the leg record, never trusted from
 * the box). */
const HarvestFindingSchema = z
  .object({
    finding_text: z.string().min(1).max(FINDING_TEXT_MAX),
    diff_context_ref: BoundedRefSchema,
  })
  .strict();

/** One finding as a harvest must carry it — the per-entry gate a host-side reader filters by (#467). */
export function isHarvestFinding(f: unknown): boolean {
  return HarvestFindingSchema.safeParse(f).success;
}

/**
 * The structured harvest JSON a QA leg emits. Bounded, structured-only; the
 * `lens` field lets the normalizer prove no lens mixing (a harvest claiming
 * another lens is refused, never re-attributed).
 */
export const HarvestOutputSchema = z
  .object({
    schemaVersion: z.literal(1),
    lens: z.enum(QA_LENS),
    findings: z.array(HarvestFindingSchema).max(MAX_FINDINGS_PER_HARVEST),
  })
  .strict();
export type HarvestOutput = z.infer<typeof HarvestOutputSchema>;

/** The commit shape every fleet run already pins (40-hex, lowercase). */
const COMMIT_SHA_RE = /^[a-f0-9]{40}$/;

/** Pinned ISO-8601 instant shape — Date.parse alone would accept loose forms
 * like "soon" or "Oct 16 2026"; the regex pins machine-emitted ISO only. */
const ISO_8601_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;
const isIso8601 = (v: string) => !Number.isNaN(Date.parse(v)) && ISO_8601_RE.test(v);

/**
 * A2's ADR-2 producer verdict (C8): G1's consumed `QaVerdictSchema` shape
 * plus provenance extras, adds-only. `approved` is the sole passing value in
 * the fleet-results vocabulary today (auto-merge-policy.ts:66) — the producer
 * emits only vocabulary the consumer already knows; anything else is the
 * consumer's fail-closed path, not ours to invent.
 */
export const QaVerdictProducerSchema = z
  .object({
    status: z.literal("approved"),
    producedAt: z.string().refine(isIso8601),
    escalated: z.boolean().optional(),
    qaRunId: z.string().min(1).max(ID_MAX).regex(BOUNDED_ID_RE),
    commitSha: z.string().regex(COMMIT_SHA_RE),
    findingCount: z.number().int().min(0),
    findingRefs: z.array(z.string().min(1).max(ID_MAX).regex(BOUNDED_ID_RE)).max(MAX_FINDINGS_PER_HARVEST),
  })
  .strict();
export type QaVerdictProducer = z.infer<typeof QaVerdictProducerSchema>;

/** Named refusals, one code per malformed-shape arm. `harvest-unknown-lens` is
 * the CALLER passing a lens outside QA_LENS; `harvest-lens-mismatch` is a ran
 * leg's harvest payload claiming a different lens than the one it was
 * submitted under. */
export type QaFindingsErrorCode = "harvest-malformed" | "harvest-lens-mismatch" | "harvest-unknown-lens";

export class QaFindingsError extends Error {
  constructor(
    readonly code: QaFindingsErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "QaFindingsError";
  }
}

/**
 * The normalizer's result. Absent-not-0 as a TYPE: `legRan: false` carries no
 * findings array at all, so empty-array-as-success is unrepresentable — `[]`
 * only ever means the leg ran and found none.
 */
export type HarvestNormalization =
  | { legRan: false; lens: string }
  | { legRan: true; lens: QaLens; runId: string; findings: Finding[] };

/**
 * Normalize one lens's harvest into findings attributable to `(runId, lens)`.
 *
 * - A leg that did not run (no result payload, non-terminal, or terminal
 *   anything-but-completed) yields `{legRan: false}` — no findings, no `[]`.
 * - A leg that RAN must hand over a well-formed harvest: malformed → named
 *   refusal (`harvest-malformed`), never passthrough; a harvest naming a
 *   different lens → `harvest-lens-mismatch` (no lens mixing).
 * - ran-and-found-none is `findings: []`, explicitly present.
 */
export function normalizeHarvest(
  lens: string,
  leg: ResultPayload | undefined,
  harvest: unknown,
): HarvestNormalization {
  if (!(QA_LENS as readonly string[]).includes(lens)) {
    throw new QaFindingsError(
      "harvest-unknown-lens",
      `lens ${JSON.stringify(lens)} is not in QA_LENS — a finding outside the roster has no leg to attribute to`,
    );
  }
  // "Ran" is the record-visible terminal state the result seam already
  // defines; approval statuses never occur here (A2 touches no gate, C7).
  if (leg === undefined || !leg.terminal || leg.status !== "completed") {
    return { legRan: false, lens };
  }
  const parsed = HarvestOutputSchema.safeParse(harvest);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    if (!issue) {
      throw new QaFindingsError("harvest-malformed", `QA leg harvest for lens ${lens} failed validation with no detail — refused, never passthrough`);
    }
    throw new QaFindingsError(
      "harvest-malformed",
      `QA leg harvest for lens ${lens} is malformed at ${issue.path.join(".") || "(root)"}: ${issue.message} — structured-only, refused, never passthrough`,
    );
  }
  if (parsed.data.lens !== lens) {
    throw new QaFindingsError(
      "harvest-lens-mismatch",
      `harvest claims lens ${parsed.data.lens} but was submitted for ${lens} — refusing to re-attribute (no lens mixing)`,
    );
  }
  const minted = parsed.data.findings.map((f) => ({
    runId: leg.runId,
    lens,
    finding_text: f.finding_text,
    diff_context_ref: f.diff_context_ref,
  }));
  // Validate the MINT against the Finding pin: leg.runId rides the wire and a
  // legacy/foreign shape would otherwise sail through mint and only surface
  // downstream at retain (refusal there stays as defense-in-depth).
  const mint = z.array(FindingSchema).safeParse(minted);
  if (!mint.success) {
    throw new QaFindingsError(
      "harvest-malformed",
      `harvest minted unattributable findings: ${mint.error.issues[0]?.message ?? "schema rejected"}`,
    );
  }
  return {
    legRan: true,
    lens,
    runId: leg.runId,
    findings: mint.data,
  };
}
