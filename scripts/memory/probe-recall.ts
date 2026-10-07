#!/usr/bin/env bun
/**
 * M1.3 probe-recall runner — hit-rate@5 over the labeled probe set.
 *
 * Order is load-bearing (story AC1): load probe set → label-integrity gate
 * (P0.9 provision-and-import mint records MERGED with memory-retain-receipt
 * audit rows, union per bank) → self-hit canary (ONE retain + one recall,
 * BEFORE any scoring) → per-probe scoring at k=5. Any gate refusal withholds
 * the hit-rate artifact entirely — never a legitimate-looking 0.0.
 *
 * CLI: bun scripts/memory/probe-recall.ts
 *   exit 0 scored (evidence JSON written)
 *   exit 2 label-integrity refusal (offending probeIds + reasons on stderr)
 *   exit 3 canary refusal (failure diagnostic JSON written)
 */

import { mkdirSync, readFileSync, writeSync } from "node:fs";
import { join } from "node:path";
import { HindsightClient } from "../../src/hindsight/client.ts";
import { atomicReplaceFile } from "../../src/providers/fs-atomic.ts";
import {
  CANARY_DOCUMENT_ID,
  DEFAULT_EVIDENCE_DIR,
  DEFAULT_PROBE_SET_FILE,
  MIN_PROBE_SET_SIZE,
  SEED_PROBE_BANK,
  checkLabelIntegrity,
  loadP09MintRecords,
  loadReceiptMintRecords,
  parseProbeSet,
  type MintRecords,
  type Probe,
  type ProbeClient,
} from "./probe-schema.ts";

export interface ProbeRecallDeps {
  client: ProbeClient;
  probeSetPath?: string;
  evidenceDir?: string;
  p09EvidenceDir?: string;
  now?: () => Date;
}

export interface HitRateMetrics {
  perProbe: { probeId: string; hit: boolean; rank: number | null; bank: string; recallMs: number }[];
  aggregate: {
    probes: number;
    hits: number;
    hitRateAt5: number;
    medianRecallMs?: number;
    belowFloor?: boolean;
    bankBreakdown: Record<string, { probes: number; hits: number }>;
  };
  canary: { bank: string; documentId: string; hit: boolean };
}

export type ProbeRecallResult =
  | { ok: true; artifactPath: string; metrics: HitRateMetrics }
  | {
      ok: false;
      stage: "label-integrity" | "canary";
      reason: string;
      violations?: { probeId: string; reason: string }[];
      diagnosticPath?: string;
    };

/**
 * Fixed canary content — the canary query IS this content, so on a healthy
 * instance the recall self-hits on the deterministic documentId.
 */
export const CANARY_CONTENT =
  "qds-canary self-hit marker: M1.3 probe-recall canary document, deterministic id, replace-on-write";

/** openrig-sc2 naming discipline: ISO millis, colon-free. */
function stampOf(d: Date): string {
  return d.toISOString().replaceAll(":", "-").replaceAll(".", "-");
}

/** Union of mint records per bank — neither source alone is the truth. */
function mergeMint(a: MintRecords, b: MintRecords): MintRecords {
  const merged: MintRecords = new Map();
  for (const source of [a, b]) {
    for (const [bank, ids] of source) {
      const into = merged.get(bank) ?? new Set<string>();
      for (const id of ids) into.add(id);
      merged.set(bank, into);
    }
  }
  return merged;
}

function median(values: number[]): number {
  const sorted = [...values].sort((x, y) => x - y);
  const mid = Math.floor(sorted.length / 2);
  const hi = sorted[mid];
  if (hi === undefined) return 0;
  return sorted.length % 2 === 1 ? hi : ((sorted[mid - 1] ?? hi) + hi) / 2;
}

export async function runProbeRecall(deps: ProbeRecallDeps): Promise<ProbeRecallResult> {
  const now = deps.now ?? (() => new Date());
  const probeSetPath = deps.probeSetPath ?? DEFAULT_PROBE_SET_FILE;
  const evidenceDir = deps.evidenceDir ?? DEFAULT_EVIDENCE_DIR;

  // Gate 0: probe-set load + parse. A parse failure is a label-integrity refusal.
  let probes: Probe[];
  try {
    const parsed = parseProbeSet(JSON.parse(readFileSync(probeSetPath, "utf8")));
    if (!parsed.ok) {
      return { ok: false, stage: "label-integrity", reason: `probe set invalid at ${probeSetPath}: ${parsed.error}` };
    }
    probes = parsed.value;
  } catch (e) {
    return {
      ok: false,
      stage: "label-integrity",
      reason: `probe set unreadable at ${probeSetPath}: ${(e as Error).message}`,
    };
  }

  // Gate 1: label integrity — BEFORE any recall/retain traffic. Every
  // violation refuses (bank provenance AND per-id mint membership): a probe
  // whose expected id is absent from the mint records is a data gap that
  // would deflate hit-rate — it must fail validation, not the score.
  const mint = mergeMint(loadP09MintRecords(deps.p09EvidenceDir), loadReceiptMintRecords());
  const integrity = await checkLabelIntegrity(probes, { client: deps.client, mint });
  if (!integrity.ok) {
    return {
      ok: false,
      stage: "label-integrity",
      reason: `label integrity failed (${integrity.violations.length} violations)`,
      violations: integrity.violations,
    };
  }

  // Gate 2: self-hit canary — retains once (replace-on-write, so it never
  // accumulates), then recalls itself. It gates scoring; it never scores.
  // A canary that ERRORS (network, upstream extraction failure) is refused at
  // this stage exactly like a canary miss — never an unhandled crash, never a
  // scored run.
  let canaryResults: { documentId: string | null }[] = [];
  let canaryError: string | undefined;
  try {
    await deps.client.retain(SEED_PROBE_BANK, CANARY_CONTENT, {
      documentId: CANARY_DOCUMENT_ID,
      updateMode: "replace",
      source: "manual",
      kind: "observation",
      tags: ["qds-canary"],
    });
    const canaryRecall = await deps.client.recall(SEED_PROBE_BANK, CANARY_CONTENT, 5);
    canaryResults = canaryRecall.results ?? [];
  } catch (e) {
    canaryError = (e as Error).message;
  }
  if (canaryError !== undefined || !canaryResults.some((r) => r.documentId === CANARY_DOCUMENT_ID)) {
    mkdirSync(evidenceDir, { recursive: true });
    const diagnosticPath = join(evidenceDir, `${stampOf(now())}-canary-failure.json`);
    const diagnostic = {
      writtenAt: now().toISOString(),
      bank: SEED_PROBE_BANK,
      documentId: CANARY_DOCUMENT_ID,
      query: CANARY_CONTENT,
      recallTail: canaryResults.slice(0, 5).map((r) => r.documentId ?? null),
      ...(canaryError !== undefined ? { error: canaryError } : {}),
    };
    atomicReplaceFile(diagnosticPath, `${JSON.stringify(diagnostic, null, 2)}\n`);
    return {
      ok: false,
      stage: "canary",
      reason:
        canaryError !== undefined
          ? `canary "${CANARY_DOCUMENT_ID}" failed: ${canaryError}`
          : `canary "${CANARY_DOCUMENT_ID}" did not surface in the top-5 self-hit recall`,
      diagnosticPath,
    };
  }

  // Scoring: k=5 per probe; hit iff an expected documentId appears in the
  // top-5 (position 6+ does not count); rank = 1-based first match, else null.
  const perProbe: HitRateMetrics["perProbe"] = [];
  const bankBreakdown: Record<string, { probes: number; hits: number }> = {};
  for (const probe of probes) {
    const started = Date.now();
    const resp = await deps.client.recall(probe.bank, probe.query, 5);
    // The 0.10.0 wire omits durationMs (schema folds it to 0) — a 0 server
    // figure and an absent one are indistinguishable, so a non-positive value
    // falls back to the local wall-clock measure.
    const recallMs = resp.durationMs > 0 ? resp.durationMs : Date.now() - started;
    const top5 = (resp.results ?? []).slice(0, 5);
    const expected = new Set(probe.expectedDocumentIds);
    let rank: number | null = null;
    for (let i = 0; i < top5.length; i++) {
      const docId = top5[i]?.documentId;
      if (docId !== null && docId !== undefined && expected.has(docId)) {
        rank = i + 1;
        break;
      }
    }
    const hit = rank !== null;
    perProbe.push({ probeId: probe.probeId, hit, rank, bank: probe.bank, recallMs });
    const bucket = bankBreakdown[probe.bank] ?? { probes: 0, hits: 0 };
    bucket.probes += 1;
    if (hit) bucket.hits += 1;
    bankBreakdown[probe.bank] = bucket;
  }

  const hits = perProbe.filter((p) => p.hit).length;
  const aggregate: HitRateMetrics["aggregate"] = {
    probes: perProbe.length,
    hits,
    hitRateAt5: perProbe.length === 0 ? 0 : hits / perProbe.length,
    bankBreakdown,
  };
  if (perProbe.length >= MIN_PROBE_SET_SIZE) {
    aggregate.medianRecallMs = median(perProbe.map((p) => p.recallMs));
  } else {
    // Too small a sample to print a median over — say so instead.
    aggregate.belowFloor = true;
  }

  const canary = { bank: SEED_PROBE_BANK, documentId: CANARY_DOCUMENT_ID, hit: true };
  const metrics: HitRateMetrics = { perProbe, aggregate, canary };

  mkdirSync(evidenceDir, { recursive: true });
  const artifactPath = join(evidenceDir, `${stampOf(now())}-hit-rate.json`);
  const artifact = {
    writtenAt: now().toISOString(),
    perProbe,
    aggregate,
    labelIntegrity: "pass" as const,
    canary,
  };
  atomicReplaceFile(artifactPath, `${JSON.stringify(artifact, null, 2)}\n`);
  return { ok: true, artifactPath, metrics };
}

if (import.meta.main) {
  const res = await runProbeRecall({ client: new HindsightClient() });
  if (res.ok) {
    const agg = res.metrics.aggregate;
    const medianNote =
      agg.medianRecallMs !== undefined ? ` medianRecallMs=${agg.medianRecallMs}ms` : " (below 20-probe floor: no median emitted)";
    writeSync(1, `hitRateAt5=${agg.hitRateAt5} probes=${agg.probes} hits=${agg.hits}${medianNote}\nartifact=${res.artifactPath}\n`);
    process.exit(0);
  }
  if (res.stage === "label-integrity") {
    for (const v of res.violations ?? []) writeSync(2, `label-integrity violation ${v.probeId}: ${v.reason}\n`);
    writeSync(2, `${res.reason}\n`);
    process.exit(2);
  }
  writeSync(2, `canary refusal: ${res.reason}\ndiagnostic=${res.diagnosticPath ?? "-"}\n`);
  process.exit(3);
}
