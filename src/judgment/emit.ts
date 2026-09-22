/**
 * Side-channel provenance emit (JEV-2, handoff §3.4 FALLBACK).
 *
 * Exactly one JSON file per requestId under the provenance dir (default
 * `_bmad-output/judgment/provenance/`; overridable — tests ALWAYS override to
 * a temp dir). The real run-record side channel would need an
 * `EXTENSION_NAMESPACES` allow-list edit in src/providers/run-record.ts, a
 * banned provider edit (§11 resolution 2) — hence this fallback.
 *
 * `detail` is DIGEST-STABLE (INV-J3): model, egress class, question
 * ids/types, usage, timestamps. Answer values and confidence NEVER enter —
 * they ride the envelope and the log line — so a re-emit of the same subject
 * can never read as divergent (the tamper-alarm bug class credentials.ts hit
 * 3×). Re-emit semantics: identical digest = no-op; different digest for the
 * same requestId = typed DigestDivergenceError.
 *
 * Fidelity note (§3.4): this FALLBACK logs nothing about tampering —
 * divergence is a tested property of this module (AC-6), not a store-level
 * alarm. The `divergent` alarm belongs to the real store channel, which this
 * story does not touch.
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { EgressClass } from "./egress.ts";
import type { Question } from "./schemas.ts";
import type { JudgmentEnvelope } from "./envelope.ts";

export const DEFAULT_PROVENANCE_DIR = "_bmad-output/judgment/provenance";

export interface ProvenanceDetail {
  requestId: string;
  model: string;
  egressClass: EgressClass;
  questions: { id: string; type: Question["type"] }[];
  usage: { input_tokens: number; output_tokens: number };
  createdAt: string;
}

export class DigestDivergenceError extends Error {
  constructor(
    message: string,
    public readonly requestId: string,
    public readonly existingDigest: string,
    public readonly incomingDigest: string,
  ) {
    super(message);
    this.name = "DigestDivergenceError";
  }
}

export interface EmitResult {
  requestId: string;
  digest: string;
  /** false = an identical entry already existed (no-op re-emit). */
  wrote: boolean;
}

export function provenanceDigest(detail: ProvenanceDetail): string {
  return createHash("sha256").update(JSON.stringify(detail)).digest("hex");
}

/** The digest-stable view of a completed call (INV-J3 — no answer fields). */
export function detailFromEnvelope(envelope: JudgmentEnvelope): ProvenanceDetail {
  return {
    requestId: envelope.requestId,
    model: envelope.model,
    egressClass: envelope.egress_class as EgressClass,
    questions: Object.entries(envelope.questions).map(([id, q]) => ({ id, type: q.type })),
    usage: envelope.usage,
    createdAt: envelope.created_at,
  };
}

function entryPath(dir: string, requestId: string): string {
  // requestIds are UUIDs (or caller-supplied test ids); guard the path join
  // so a hostile requestId can never escape the provenance dir.
  if (requestId.includes("/") || requestId.includes("\\") || requestId.includes("..")) {
    throw new DigestDivergenceError(
      `refusing to emit: requestId ${JSON.stringify(requestId)} is not a safe file key`,
      requestId,
      "",
      "",
    );
  }
  return join(dir, `${requestId}.json`);
}

export function emitProvenance(
  detail: ProvenanceDetail,
  dir: string = DEFAULT_PROVENANCE_DIR,
): EmitResult {
  const digest = provenanceDigest(detail);
  const path = entryPath(dir, detail.requestId);

  if (existsSync(path)) {
    const existing = JSON.parse(readFileSync(path, "utf8")) as { digest?: string };
    if (existing.digest === digest) return { requestId: detail.requestId, digest, wrote: false };
    throw new DigestDivergenceError(
      `provenance divergence: requestId ${detail.requestId} already emitted with digest ${existing.digest} but re-emitted with ${digest}`,
      detail.requestId,
      existing.digest ?? "unknown",
      digest,
    );
  }

  mkdirSync(dir, { recursive: true });
  writeFileSync(path, `${JSON.stringify({ requestId: detail.requestId, digest, detail }, null, 2)}\n`);
  return { requestId: detail.requestId, digest, wrote: true };
}
