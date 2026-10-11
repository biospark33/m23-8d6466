/**
 * A5 — the closed snapshot schemas and the direction/pair tables they enforce.
 *
 * Split out of kpis.ts for the <500-line file rule; kpis.ts re-exports this
 * module's surface so its locked API is unchanged. Everything here is zod
 * `.strict()` — unknown fields refuse at every level (the Q1
 * missing-and-extra-fail discipline applied to data), and the two AC1/AC3
 * negative controls live in refinements: a counter whose source is null
 * (the zero-fill signature) refuses, a direction off the v4 literal refuses,
 * and a counter that is not the KPI's FR-LEARN-33 pair refuses.
 */
import { z } from "zod";

import { DimensionSchema } from "./dimensions.ts";
import { SpendJoinSchema } from "./join.ts";

// ─── directions + pairs (AC3 / FR-LEARN-33) ──────────────────────────────────

/** The literal v4 directions — the schema refuses any other value per KPI. */
export const KPI_DIRECTIONS = {
  tdi_proxy: "down",
  cost_per_story: "down",
  first_pass_accept: "up",
  retry_rate: "down",
} as const;

export type KpiName = keyof typeof KPI_DIRECTIONS;

export const KPI_NAMES: readonly KpiName[] = ["tdi_proxy", "cost_per_story", "first_pass_accept", "retry_rate"];

/** The FR-LEARN-33 counter-metric pair per KPI — the schema refuses any other pairing (AC1). */
export const COUNTER_PAIRS = {
  tdi_proxy: "unattributed_signal_count",
  cost_per_story: "cost_per_accepted_pr",
  first_pass_accept: "escaped_defect_rate",
  retry_rate: "unclassified_restart_rate",
} as const;

// ─── value / counter / KPI object schemas ────────────────────────────────────

export const KpiValueSchema = z.discriminatedUnion("status", [
  z.strictObject({
    status: z.literal("measured"),
    value: z.number(),
    denominator: z.number(),
    sources: z.array(z.string()),
  }),
  z.strictObject({ status: z.literal("absent"), source: z.string(), detail: z.string() }),
]);

export type KpiValue = z.infer<typeof KpiValueSchema>;

export const CounterMetricSchema = z
  .strictObject({
    name: z.string(),
    value: z.union([z.number(), z.literal("absent")]),
    source: z.string().nullable(),
    detail: z.string().optional(),
  })
  .refine((c) => c.source !== null && c.source.length > 0, {
    message:
      "counter source must be named — source null is the zero-fill signature (AC1); an absent counter names its missing source",
  });

export type CounterMetric = z.infer<typeof CounterMetricSchema>;

export const KpiObjectSchema = z
  .strictObject({
    name: z.enum(["tdi_proxy", "cost_per_story", "first_pass_accept", "retry_rate"]),
    direction: z.enum(["up", "down"]),
    sources: z.array(z.string()),
    value: KpiValueSchema,
    counter: CounterMetricSchema,
  })
  .refine((o) => o.direction === KPI_DIRECTIONS[o.name], {
    message: "direction must be the literal v4 direction for this KPI (AC3)",
  })
  .refine((o) => o.counter.name === COUNTER_PAIRS[o.name], {
    message: "counter must be the FR-LEARN-33 pair for this KPI (AC1)",
  });

export type KpiObject = z.infer<typeof KpiObjectSchema>;

// ─── snapshot schema ─────────────────────────────────────────────────────────

export const PerKpiFailureSchema = z.strictObject({
  kpi: z.enum(["tdi_proxy", "cost_per_story", "first_pass_accept", "retry_rate"]),
  code: z.string(),
  message: z.string(),
  remediation: z.string(),
});

export type PerKpiFailure = z.infer<typeof PerKpiFailureSchema>;

export const KpiSnapshotSchema = z.strictObject({
  schema: z.literal("qds.kpi-snapshot"),
  schema_version: z.literal(1),
  window: z.strictObject({ start: z.string(), end: z.string(), window_id: z.string() }),
  kpis: z
    .array(KpiObjectSchema)
    .length(4)
    .refine((ks) => {
      const names = ks.map((k) => k.name).sort().join(",");
      return names === [...KPI_NAMES].sort().join(",");
    }, { message: "exactly the four canonical KPIs, no more, no fewer" }),
  spend: SpendJoinSchema,
  dimensions: z.array(DimensionSchema),
  run_accounting: z.strictObject({
    records_in_window: z.number().int(),
    records_skipped: z.union([z.number().int(), z.literal("absent")]),
    records_undated: z.union([z.number().int(), z.literal("absent")]),
    terminal_runs: z.union([z.number().int(), z.literal("absent")]),
    accepted_runs: z.union([z.number().int(), z.literal("absent")]),
  }),
  per_kpi_failures: z.array(PerKpiFailureSchema),
});

export type KpiSnapshotPayload = z.infer<typeof KpiSnapshotSchema>;
