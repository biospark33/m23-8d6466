/**
 * M1.3 recall measurement harness — shared schema, mint-record readers,
 * and the label-integrity gate (INV-PH-1/PH-2).
 *
 * Mock boundary: type-only imports for the real client surface; no network.
 * All readers are read-only (INV-PH-2) — absent sources stay absent.
 */

import { z } from "zod";
import { BankIdSchema } from "../../src/hindsight/schemas.ts";
import type { RecallClient } from "../../src/hindsight/kg-context.ts";
import type { HindsightClient } from "../../src/hindsight/client.ts";
import { Database } from "bun:sqlite";
import { existsSync, readdirSync, readFileSync } from "node:fs";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const MAX_PROBE_QUERY_CHARS = 1_000;
export const MIN_PROBE_SET_SIZE = 20;
export const CANARY_DOCUMENT_ID = "qds-canary";
export const SEED_PROBE_BANK = "qds-factory-dev-meta";
export const SLOW_QUERY_THRESHOLD_MS = 5_000;
export const PROBE_WRITER_LOCK_ID = "probe-writer";
export const DEFAULT_PROBE_SET_FILE = "_bmad-output/memory/probes/probe-set.json";
export const DEFAULT_EVIDENCE_DIR = "_bmad-output/evidence/memory";
export const DEFAULT_REPORTS_DIR = "_bmad-output/memory/reports";
export const DEFAULT_P09_EVIDENCE_DIR = "_bmad-output/evidence/p0-9-closure";
export const DEFAULT_AUDIT_DB_FILE = ".sandbox/audit.db";

// ---------------------------------------------------------------------------
// Probe schema + set parsing
// ---------------------------------------------------------------------------

export const ProbeSchema = z.object({
  probeId: z.string().min(1),
  query: z.string().min(1).max(MAX_PROBE_QUERY_CHARS),
  expectedDocumentIds: z.array(z.string().min(1)).min(1),
  bank: BankIdSchema,
});

export type Probe = z.infer<typeof ProbeSchema>;

/** Parse a raw probe-set payload; refuse duplicate probeIds (non-empty error). */
export function parseProbeSet(raw: unknown): { ok: true; value: Probe[] } | { ok: false; error: string } {
  const parsed = z.array(ProbeSchema).safeParse(raw);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") };
  }
  const seen = new Map<string, number>();
  for (const p of parsed.data) seen.set(p.probeId, (seen.get(p.probeId) ?? 0) + 1);
  const dups = [...seen.entries()].filter(([, n]) => n > 1).map(([id]) => id);
  if (dups.length > 0) return { ok: false, error: `duplicate probeIds: ${dups.join(", ")}` };
  return { ok: true, value: parsed.data };
}

// ---------------------------------------------------------------------------
// Mint records — bankId → minted documentIds
// ---------------------------------------------------------------------------

export type MintRecords = Map<string, Set<string>>;

/**
 * Read mint records from P0.9 provision-and-import evidence JSONs.
 * ok:true records only; latest writtenAt wins per bank; absent dir → empty.
 */
export function loadP09MintRecords(evidenceDir: string = DEFAULT_P09_EVIDENCE_DIR): MintRecords {
  const mint: MintRecords = new Map();
  let files: string[];
  try {
    files = readdirSync(evidenceDir).filter((n) => n.includes("provision-and-import")).sort();
  } catch {
    return mint; // absent/unreadable dir → empty map, never throws
  }
  const latest = new Map<string, string>(); // bank → winning writtenAt
  for (const name of files) {
    let data: unknown;
    try {
      data = JSON.parse(readFileSync(`${evidenceDir}/${name}`, "utf8"));
    } catch {
      continue; // malformed file → skip (data, not code)
    }
    if (typeof data !== "object" || data === null) continue;
    const rec = data as { ok?: unknown; writtenAt?: unknown; mintRecord?: unknown };
    if (rec.ok !== true) continue;
    if (typeof rec.mintRecord !== "object" || rec.mintRecord === null) continue;
    const at = typeof rec.writtenAt === "string" ? rec.writtenAt : "";
    for (const [bank, entry] of Object.entries(rec.mintRecord as Record<string, unknown>)) {
      const ids = (entry as { documentIds?: unknown })?.documentIds;
      if (!Array.isArray(ids)) continue;
      const prev = latest.get(bank);
      if (prev !== undefined && prev >= at) continue; // latest writtenAt wins per bank
      latest.set(bank, at);
      mint.set(bank, new Set(ids.filter((id): id is string => typeof id === "string")));
    }
  }
  return mint;
}

/**
 * Read mint records from memory-retain-receipt audit rows (bun:sqlite
 * READONLY — an absent db is never created). subject_id IS the documentId.
 */
export function loadReceiptMintRecords(auditPath?: string): MintRecords {
  const path = auditPath ?? process.env.QDS_AUDIT_DB ?? DEFAULT_AUDIT_DB_FILE;
  const mint: MintRecords = new Map();
  if (!existsSync(path)) return mint;
  const db = new Database(path, { readonly: true });
  try {
    const rows = db
      .prepare(`SELECT subject_id, detail_json FROM audit_links WHERE hop='memory-retain-receipt'`)
      .all() as { subject_id: unknown; detail_json: unknown }[];
    for (const row of rows) {
      if (typeof row.subject_id !== "string") continue;
      let detail: unknown;
      try {
        detail = JSON.parse(String(row.detail_json));
      } catch {
        continue; // malformed detail_json → skip row
      }
      const bank = (detail as { bank?: unknown })?.bank;
      if (typeof bank !== "string") continue;
      const set = mint.get(bank) ?? new Set<string>();
      set.add(row.subject_id);
      mint.set(bank, set);
    }
  } finally {
    db.close();
  }
  return mint;
}

// ---------------------------------------------------------------------------
// Label-integrity gate
// ---------------------------------------------------------------------------

export interface ProbeClient extends RecallClient {
  retain: Pick<HindsightClient, "retain">["retain"];
}

/**
 * Bank ids extracted defensively from either listBanks envelope shape:
 * a bare array of {bank_id} or {banks:[{bank_id}]}; `id` tolerated as fallback.
 */
function extractBankIds(envelope: unknown): Set<string> {
  const rows: unknown[] = Array.isArray(envelope)
    ? envelope
    : Array.isArray((envelope as { banks?: unknown })?.banks)
      ? ((envelope as { banks: unknown[] }).banks)
      : [];
  const ids = new Set<string>();
  for (const row of rows) {
    if (typeof row !== "object" || row === null) continue;
    const id = (row as { bank_id?: unknown; id?: unknown }).bank_id ?? (row as { id?: unknown }).id;
    if (typeof id === "string") ids.add(id);
  }
  return ids;
}

/**
 * Label integrity: every probe's bank must exist in listBanks, and every
 * expectedDocumentId must be minted into THAT bank (per-bank lookup only —
 * a cross-bank id is phantom-class, never a global union).
 */
export async function checkLabelIntegrity(
  probes: Probe[],
  deps: { client: Pick<ProbeClient, "listBanks">; mint: MintRecords },
): Promise<{ ok: boolean; violations: { probeId: string; reason: string }[]; checkedProbes: number }> {
  const listed = extractBankIds(await deps.client.listBanks());
  const violations: { probeId: string; reason: string }[] = [];
  for (const probe of probes) {
    if (!listed.has(probe.bank)) {
      violations.push({ probeId: probe.probeId, reason: `bank "${probe.bank}" is absent from listBanks` });
    }
    const minted = deps.mint.get(probe.bank);
    if (!minted) {
      violations.push({ probeId: probe.probeId, reason: `no mint record for bank "${probe.bank}"` });
      continue;
    }
    for (const id of probe.expectedDocumentIds) {
      if (!minted.has(id)) {
        violations.push({
          probeId: probe.probeId,
          reason: `expected document "${id}" is not minted into bank "${probe.bank}"`,
        });
      }
    }
  }
  return { ok: violations.length === 0, violations, checkedProbes: probes.length };
}
