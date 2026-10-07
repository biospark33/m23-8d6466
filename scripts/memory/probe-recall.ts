#!/usr/bin/env bun
/**
 * M1.3 probe-recall runner — hit-rate@5 over the labeled probe set.
 *
 * Order is load-bearing (story AC1): take the probes-dir writer lock → load
 * probe set → label-integrity gate (P0.9 provision-and-import mint records
 * MERGED with memory-retain-receipt audit rows, union per bank) → self-hit
 * canary (ONE retain + one recall, BEFORE any scoring) → per-probe scoring at
 * k=5. Any gate refusal withholds the hit-rate artifact entirely — never a
 * legitimate-looking 0.0.
 *
 * CLI: bun scripts/memory/probe-recall.ts
 *   exit 0 scored (evidence JSON written)
 *   exit 2 label-integrity refusal (offending probeIds + reasons on stderr)
 *   exit 3 canary refusal (failure diagnostic JSON written)
 *   exit 1 scoring refusal / lock failure (no artifact — a rejected recall
 *   mid-scoring is an unmeasured run, never a score)
 */

import { mkdirSync, readFileSync, writeSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { dirname, join } from "node:path";
import { HindsightClient } from "../../src/hindsight/client.ts";
import { atomicReplaceFile } from "../../src/providers/fs-atomic.ts";
import { acquireRunLock, releaseRunLock, RunLockedError, type RunLockHandle } from "../lib/run-lock.ts";
import {
  CANARY_DOCUMENT_ID,
  DEFAULT_EVIDENCE_DIR,
  DEFAULT_PROBE_SET_FILE,
  MIN_PROBE_SET_SIZE,
  PROBE_WRITER_LOCK_ID,
  SEED_PROBE_BANK,
  SLOW_QUERY_THRESHOLD_MS,
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
  auditPath?: string;
  now?: () => Date;
}

export interface HitRateMetrics {
  perProbe: {
    probeId: string;
    hit: boolean;
    rank: number | null;
    bank: string;
    origin: "seed" | "cycle";
    recallMs: number;
  }[];
  aggregate: {
    probes: number;
    hits: number;
    /** Withheld below MIN_PROBE_SET_SIZE (see belowFloor) — never printed off-floor. */
    hitRateAt5?: number;
    medianRecallMs?: number;
    belowFloor?: boolean;
    bankBreakdown: Record<string, { probes: number; hits: number }>;
    byOrigin: Record<"seed" | "cycle", { probes: number; hits: number }>;
  };
  canary: { bank: string; documentId: string; hit: boolean };
}

export type ProbeRecallResult =
  | { ok: true; artifactPath: string; metrics: HitRateMetrics }
  | {
      ok: false;
      stage: "label-integrity" | "canary" | "scoring";
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

/** Run-unique filename suffix — same-millisecond stamp collisions must not overwrite evidence (F-018). */
function rand6(): string {
  return Array.from(randomBytes(6), (b) => (b % 36).toString(36)).join("");
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

  // F-022: one writer at a time on the probes dir — the same guard the growth
  // appender takes — serializes concurrent probe-recall runs across gates,
  // scoring, and the artifact write. Contention polls (25ms) up to 60s, then
  // throws: a refused run never scored, so there is no artifact to withhold.
  const probesDir = dirname(probeSetPath);
  mkdirSync(probesDir, { recursive: true });
  const lockDeadline = Date.now() + 60_000;
  let lock: RunLockHandle | undefined;
  for (;;) {
    try {
      lock = acquireRunLock(probesDir, PROBE_WRITER_LOCK_ID, "probe-recall run");
      break;
    } catch (e) {
      if (e instanceof RunLockedError && Date.now() <= lockDeadline) {
        await Bun.sleep(25);
        continue;
      }
      throw e;
    }
  }
  try {
    return await probeRecallLocked(deps, { now, probeSetPath, evidenceDir });
  } finally {
    releaseRunLock(lock);
  }
}

/** Gate order + scoring, under the caller-held probes-dir lock. */
async function probeRecallLocked(
  deps: Pick<ProbeRecallDeps, "client" | "auditPath" | "p09EvidenceDir">,
  env: { now: () => Date; probeSetPath: string; evidenceDir: string },
): Promise<ProbeRecallResult> {
  const now = env.now;

  // Gate 0: probe-set load + parse. A parse failure is a label-integrity refusal.
  let probes: Probe[];
  try {
    const parsed = parseProbeSet(JSON.parse(readFileSync(env.probeSetPath, "utf8")));
    if (!parsed.ok) {
      return {
        ok: false,
        stage: "label-integrity",
        reason: `probe set invalid at ${env.probeSetPath}: ${parsed.error}`,
      };
    }
    probes = parsed.value;
  } catch (e) {
    return {
      ok: false,
      stage: "label-integrity",
      reason: `probe set unreadable at ${env.probeSetPath}: ${(e as Error).message}`,
    };
  }
  // F-003: an empty set parses valid but measures nothing — refusing here
  // keeps a zero-sample run from writing a legitimate-looking artifact at all.
  if (probes.length === 0) {
    return { ok: false, stage: "label-integrity", reason: `probe set empty at ${env.probeSetPath}` };
  }

  // Gate 1: label integrity — BEFORE any recall/retain traffic. Every
  // violation refuses (bank provenance AND per-id mint membership): a probe
  // whose expected id is absent from the mint records is a data gap that
  // would deflate hit-rate — it must fail validation, not the score.
  const mint = mergeMint(loadP09MintRecords(deps.p09EvidenceDir), loadReceiptMintRecords(deps.auditPath));
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
    mkdirSync(env.evidenceDir, { recursive: true });
    const missReason =
      canaryError !== undefined
        ? `canary "${CANARY_DOCUMENT_ID}" failed: ${canaryError}`
        : `canary "${CANARY_DOCUMENT_ID}" did not surface in the top-5 self-hit recall`;
    const diagnostic = {
      writtenAt: now().toISOString(),
      bank: SEED_PROBE_BANK,
      documentId: CANARY_DOCUMENT_ID,
      query: CANARY_CONTENT,
      recallTail: canaryResults.slice(0, 5).map((r) => r.documentId ?? null),
      ...(canaryError !== undefined ? { error: canaryError } : {}),
    };
    // F-019: the diagnostic is best-effort — a write failure must not break
    // the refusal contract itself, so the refusal still returns (reason notes
    // the write failure, diagnosticPath omitted).
    const diagnosticPath = join(env.evidenceDir, `${stampOf(now())}-canary-failure-${rand6()}.json`);
    let diagnosticWritten = true;
    try {
      atomicReplaceFile(diagnosticPath, `${JSON.stringify(diagnostic, null, 2)}\n`);
    } catch (e) {
      diagnosticWritten = false;
      writeSync(2, `canary diagnostic write failed: ${(e as Error).message}\n`);
    }
    return {
      ok: false,
      stage: "canary",
      reason: diagnosticWritten ? missReason : `${missReason}; diagnostic write failed`,
      ...(diagnosticWritten ? { diagnosticPath } : {}),
    };
  }

  // Scoring: k=5 per probe; hit iff an expected documentId appears in the
  // top-5 (position 6+ does not count); rank = 1-based first match, else null.
  // F-001: a recall rejection mid-scoring is a refusal at stage "scoring" —
  // an unmeasured run, never an unhandled crash, and no artifact is written.
  const perProbe: HitRateMetrics["perProbe"] = [];
  const bankBreakdown: Record<string, { probes: number; hits: number }> = {};
  const byOrigin: HitRateMetrics["aggregate"]["byOrigin"] = {
    seed: { probes: 0, hits: 0 },
    cycle: { probes: 0, hits: 0 },
  };
  try {
    for (const probe of probes) {
      const started = Date.now();
      const resp = await deps.client.recall(probe.bank, probe.query, 5);
      // The 0.10.0 wire omits durationMs (schema folds it to 0) — a 0 server
      // figure and an absent one are indistinguishable, so a non-positive
      // value falls back to the local wall-clock measure. The 1ms floor keeps
      // sub-ms localhost recalls measurable (recallMs=0 reads as broken, and
      // the DD-22 bar this feeds is 5000ms).
      const recallMs = resp.durationMs > 0 ? resp.durationMs : Math.max(1, Date.now() - started);
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
      perProbe.push({ probeId: probe.probeId, hit, rank, bank: probe.bank, origin: probe.origin, recallMs });
      const bucket = bankBreakdown[probe.bank] ?? { probes: 0, hits: 0 };
      bucket.probes += 1;
      if (hit) bucket.hits += 1;
      bankBreakdown[probe.bank] = bucket;
      const originBucket = byOrigin[probe.origin];
      originBucket.probes += 1;
      if (hit) originBucket.hits += 1;
    }
  } catch (e) {
    return { ok: false, stage: "scoring", reason: `scoring failed: ${(e as Error).message}` };
  }

  const hits = perProbe.filter((p) => p.hit).length;
  const aggregate: HitRateMetrics["aggregate"] = {
    probes: perProbe.length,
    hits,
    bankBreakdown,
    byOrigin,
  };
  if (perProbe.length >= MIN_PROBE_SET_SIZE) {
    // F-003: hit-rate and median both print only at or above the floor —
    // below it the aggregate says belowFloor and withholds both.
    aggregate.hitRateAt5 = hits / perProbe.length;
    aggregate.medianRecallMs = median(perProbe.map((p) => p.recallMs));
  } else {
    aggregate.belowFloor = true;
  }

  const canary = { bank: SEED_PROBE_BANK, documentId: CANARY_DOCUMENT_ID, hit: true };
  const metrics: HitRateMetrics = { perProbe, aggregate, canary };

  mkdirSync(env.evidenceDir, { recursive: true });
  const artifactPath = join(env.evidenceDir, `${stampOf(now())}-hit-rate-${rand6()}.json`);
  const artifact = {
    writtenAt: now().toISOString(),
    perProbe,
    aggregate,
    labelIntegrity: "pass" as const,
    canary,
    // DD-22 decision-input context (F-024): the working bar the operator will
    // judge the checkpoint against, carried with the evidence so no reader
    // has to reconstruct it. Purely informational — INV-PH-3 means there is
    // deliberately NO comparison logic here; the go/no-go is the operator's.
    dd22WorkingBar: { hitRateAt5Min: 0.7, medianRecallLtMs: SLOW_QUERY_THRESHOLD_MS },
    dd22Note:
      "decision-input context only — no evaluation logic (INV-PH-3); the DD-22 decision is the operator's at the dated checkpoint",
  };
  // Throw-on-failure is deliberate: a scored run that cannot persist must not
  // masquerade as ok — the throw IS the honest signal.
  atomicReplaceFile(artifactPath, `${JSON.stringify(artifact, null, 2)}\n`);
  return { ok: true, artifactPath, metrics };
}

if (import.meta.main) {
  const res = await runProbeRecall({ client: new HindsightClient() });
  if (res.ok) {
    const agg = res.metrics.aggregate;
    const floorNote =
      agg.hitRateAt5 !== undefined
        ? `hitRateAt5=${agg.hitRateAt5}`
        : "hitRateAt5 withheld (below 20-probe floor)";
    const medianNote =
      agg.medianRecallMs !== undefined
        ? ` medianRecallMs=${agg.medianRecallMs}ms`
        : " (below 20-probe floor: no median emitted)";
    writeSync(1, `${floorNote} probes=${agg.probes} hits=${agg.hits}${medianNote}\n`);
    // F-012: seed vs cycle split, printed only when cycle probes exist.
    if (agg.byOrigin.cycle.probes > 0) {
      writeSync(
        1,
        `byOrigin seed=${agg.byOrigin.seed.probes}/${agg.byOrigin.seed.hits} cycle=${agg.byOrigin.cycle.probes}/${agg.byOrigin.cycle.hits} (probes/hits)\n`,
      );
    }
    writeSync(1, `artifact=${res.artifactPath}\n`);
    process.exit(0);
  }
  if (res.stage === "label-integrity") {
    for (const v of res.violations ?? []) writeSync(2, `label-integrity violation ${v.probeId}: ${v.reason}\n`);
    writeSync(2, `${res.reason}\n`);
    process.exit(2);
  }
  if (res.stage === "scoring") {
    writeSync(2, `scoring refusal: ${res.reason}\n`);
    process.exit(1);
  }
  writeSync(2, `canary refusal: ${res.reason}\ndiagnostic=${res.diagnosticPath ?? "-"}\n`);
  process.exit(3);
}
