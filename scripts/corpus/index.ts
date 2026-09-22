/**
 * Public surface of the triage corpus capture tooling (JEV-1).
 *
 * The pinned import boundary for everything crossing the module line — the
 * Wave-3 Jev observer appends records through exactly this barrel and never
 * re-declares the schema:
 *
 *   import { TriageRecordSchema, appendRecord } from "scripts/corpus/index.ts";
 *
 * The CLIs (`validate.ts`, `merge.ts`, `backfill.ts`) import their internals
 * from `./schema.ts` / `./merge.ts` directly; only these names are public.
 */

export { DISPOSITIONS, TriageRecordSchema, TriageSidecarSchema } from "./schema.ts";
export { appendRecord } from "./merge.ts";
export type { Disposition, TriageRecord, TriageSidecar } from "./schema.ts";
