/**
 * run-retain — M1.2 AC4/AC6: the idempotent host-side harvest retain.
 *
 * One outcome document per run, retained to the provision-time repo bank id
 * with `documentId = <runId>` (the minted `qds-YYYYMMDD-hex6` id, dated BY
 * CONSTRUCTION — never time- or random-derived here) and
 * `updateMode:"replace"`, so a byte-identical replay REPLACES instead of
 * duplicating. The payload is host-authored and structured ONLY (INV-KG-3 /
 * F10): the builder's exact-shape literal leaves no prose channel for raw box
 * output, and the 4 KiB ceiling is refused before any network call.
 *
 * INV-KG-2: no credential parameter exists on any surface in this module — the
 * client carries the host env token (INV-HM1), and that is the only retain
 * credential there is.
 *
 * The audit receipt (INV-KG-4) lands AFTER retain success only, best-effort:
 * the store's coalesce identity dedups a replayed receipt to ONE row, and its
 * divergent-evidence check is the tamper alarm when the same documentId is
 * re-emitted with different content. A store refusal is logged, never allowed
 * to fail a landed retain.
 */

import { canonicalJson, sha256Hex, type AuditStoreWriter } from "../audit/link-store.ts";
import { log } from "../lib/log.ts";
import { redactSecrets } from "../providers/step-log.ts";
import type { HindsightClient } from "./client.ts";

/** Story Guards/limits: the retain payload's UTF-8 byte ceiling. */
export const RETAIN_PAYLOAD_MAX_BYTES = 4_096;

/**
 * The closed harvest exit classification. The payload's ONLY non-id string is
 * this field, so it is a union, not a string: raw box prose has no field to
 * ride in on. The fleet.ts harvest seam passes one of these; anything else is
 * a builder refusal, not a passthrough.
 */
export type ExitClassification = "green" | "vetoed" | "failed" | "unsettled";

const EXIT_CLASSIFICATIONS: readonly ExitClassification[] = ["green", "vetoed", "failed", "unsettled"];

/** The structured outcome the payload serialises — plus the wire-item tags. */
export interface RetainOutcome {
  runId: string;
  repoSlug: string;
  requestId: string;
  exitClassification: ExitClassification;
  harvestedCount?: number;
  spendMicroUsd?: number;
  bundlePath?: string;
  tags: string[];
}

/** What `retainRunOutcome` takes: the outcome plus the caller-resolved bank. */
export interface RunRetainInput extends RetainOutcome {
  /** Provision-time repo bank id (`resolveRepoBankId` semantics) — never re-derived here. */
  repoBankId: string;
}

export interface RunRetainResult {
  retained: true;
  documentId: string;
  bank: string;
  contentDigest: string;
}

export type RunRetainErrorCode =
  | "retain-run-id-invalid"
  | "retain-payload-invalid"
  | "retain-payload-oversize";

export class RunRetainError extends Error {
  constructor(
    readonly code: RunRetainErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "RunRetainError";
  }
}

/** The minted-runId shape — pinned verbatim from dispatch.ts's MINTED_RUN_ID_RE. */
const RUN_ID_RE = /^qds-\d{8}-[a-f0-9]{6}$/;

/** The correlation-id shape [G14]: alnum-led, `._-` body, never `..` (a
 * path-ellipsis channel), at most 64 chars — the "no prose channel" header
 * holds for every string field, not only the classification. */
const REQUEST_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const REQUEST_ID_MAX_LEN = 64;
const REPO_SLUG_MAX_LEN = 200;

// biome-ignore lint/suspicious/noControlCharactersInRegex: detecting control characters IS the purpose (F8 bundlePath guard)
const CONTROL_CHAR_RE = /[\u0000-\u001F\u007F]/;

/**
 * The document identity IS the runId (AC4: "dated by construction"). Refusing
 * every other shape is what makes a time-based or random documentId
 * structurally impossible — there is no other input to derive from.
 */
export function deriveDocumentId(runId: string): string {
  if (typeof runId !== "string" || !RUN_ID_RE.test(runId)) {
    throw new RunRetainError(
      "retain-run-id-invalid",
      `runId ${JSON.stringify(String(runId).slice(0, 64))} is not a minted run id (qds-YYYYMMDD-hex6) — the documentId is the runId itself, so no other shape can be retained`,
    );
  }
  return runId;
}

/**
 * The bounded, canonical retain payload. PURE: no network, no clock, no
 * randomness. Built as an exact-shape literal in sorted key order, so the
 * serialised bytes are deterministic (byte-identical replays are what make the
 * substrate's `document_id` upsert a replace) and match `canonicalJson`.
 */
export function buildRetainPayload(input: RetainOutcome): string {
  if (typeof input.exitClassification !== "string" || !EXIT_CLASSIFICATIONS.includes(input.exitClassification as ExitClassification)) {
    throw new RunRetainError(
      "retain-payload-invalid",
      `exitClassification must be one of ${EXIT_CLASSIFICATIONS.join(" | ")} — the payload has no prose channel (INV-KG-3)`,
    );
  }
  for (const field of ["runId", "repoSlug", "requestId"] as const) {
    if (typeof input[field] !== "string" || input[field].length === 0) {
      throw new RunRetainError("retain-payload-invalid", `payload field ${field} must be a non-empty string`);
    }
  }
  // G14: the correlation fields are bounded, printable identity — never prose
  // channels. Same inline class style as the bundlePath guard below, refused
  // before any network call.
  if (input.repoSlug.length > REPO_SLUG_MAX_LEN || CONTROL_CHAR_RE.test(input.repoSlug)) {
    throw new RunRetainError(
      "retain-payload-invalid",
      `payload field repoSlug must be a string of at most ${REPO_SLUG_MAX_LEN} characters with no control characters`,
    );
  }
  if (input.requestId.length > REQUEST_ID_MAX_LEN || !REQUEST_ID_RE.test(input.requestId) || input.requestId.includes("..")) {
    throw new RunRetainError(
      "retain-payload-invalid",
      `payload field requestId must be a string of at most ${REQUEST_ID_MAX_LEN} characters matching ${REQUEST_ID_RE.source} with no ".."`,
    );
  }
  for (const field of ["harvestedCount", "spendMicroUsd"] as const) {
    const v = input[field];
    if (v !== undefined && (typeof v !== "number" || !Number.isFinite(v))) {
      throw new RunRetainError("retain-payload-invalid", `payload field ${field} must be a finite number when present`);
    }
  }
  // F8: bundlePath is optional but never free-form — when present it must be a
  // bounded, printable string (≤512 chars, no control characters), or the
  // payload-invalid refusal fires here, before any network call.
  if (input.bundlePath !== undefined) {
    const p: unknown = input.bundlePath;
    if (
      typeof p !== "string" || p.length === 0 || p.length > 512 || CONTROL_CHAR_RE.test(p)
    ) {
      throw new RunRetainError(
        "retain-payload-invalid",
        "payload field bundlePath must be a non-empty string of at most 512 characters with no control characters when present",
      );
    }
  }
  if (!Array.isArray(input.tags) || !input.tags.every((t) => typeof t === "string")) {
    throw new RunRetainError("retain-payload-invalid", "tags must be an array of strings");
  }
  // Undefined members are dropped by JSON.stringify, so the present-key set is
  // exactly the caller's — and the literal's order is the canonical order.
  const payload = {
    bundlePath: input.bundlePath,
    exitClassification: input.exitClassification,
    harvestedCount: input.harvestedCount,
    repoSlug: input.repoSlug,
    requestId: input.requestId,
    runId: input.runId,
    spendMicroUsd: input.spendMicroUsd,
  };
  const json = JSON.stringify(payload);
  if (Buffer.byteLength(json, "utf8") > RETAIN_PAYLOAD_MAX_BYTES) {
    throw new RunRetainError(
      "retain-payload-oversize",
      `retain payload is ${Buffer.byteLength(json, "utf8")} bytes — past the ${RETAIN_PAYLOAD_MAX_BYTES}-byte ceiling (refused before any network call, never truncated)`,
    );
  }
  return json;
}

/**
 * Retain one run outcome, then receipt it.
 *
 * Order is load-bearing: the payload is built and bounded FIRST (an oversize
 * run refuses before any client call), the retain lands, and only then is the
 * receipt attempted — best-effort, so an audit-store refusal is logged and
 * NEVER fails the landed retain. The receipt's coalesce identity is
 * (runId, memory-retain-receipt, retain, documentId): a byte-identical replay
 * dedups to one row; different content under the same documentId trips the
 * store's divergent-evidence alarm by design (INV-KG-4) — the store keeps the
 * first row and logs the divergence; this module adds nothing on top.
 */
export async function retainRunOutcome(
  client: Pick<HindsightClient, "retain">,
  auditStore: AuditStoreWriter | undefined,
  input: RunRetainInput,
): Promise<RunRetainResult> {
  const documentId = deriveDocumentId(input.runId);
  const payload = buildRetainPayload(input);
  const contentDigest = sha256Hex(payload);
  await client.retain(input.repoBankId, payload, {
    documentId,
    updateMode: "replace",
    tags: input.tags,
    kind: "observation",
    source: "agent",
  });
  // The Observability Contract line: `memory-retain` {runId, documentId, bank,
  // contentDigest}. Latency rides the client's own retain log — never here.
  // G5: a throwing sink must never convert a LANDED retain into a reported
  // failure — telemetry is best-effort exactly like the receipt below, and a
  // sink throw here would otherwise skip the receipt record entirely.
  try {
    log({
      requestId: input.requestId,
      operation: "memory-retain",
      agentId: null,
      timestamp: new Date().toISOString(),
      duration: 0,
      status: "ok",
      runId: input.runId,
      documentId,
      bank: input.repoBankId,
      contentDigest,
    });
  } catch {
    // The retain landed; losing the log line is not losing the retain.
  }
  if (auditStore !== undefined) {
    try {
      const now = new Date().toISOString();
      auditStore.record({
        runId: input.runId,
        repoSlug: input.repoSlug,
        requestId: input.requestId,
        hop: "memory-retain-receipt",
        event: "retain",
        subjectId: documentId,
        subjectKind: "document",
        evidenceDigest: sha256Hex(canonicalJson({ bank: input.repoBankId, documentId, contentDigest })),
        // Digest-stable on replay (both fields are run-stable) and the readable
        // provenance input M1.3's bank gate compares per probe.
        detail: { documentId, bank: input.repoBankId },
        occurredAt: now,
        recordedAt: now,
      });
    } catch (e) {
      // Best-effort by contract: the retain already landed. A refusal (invalid
      // link, 8 KiB, lock, drift) is one structured error line — the operator
      // can see the receipt is missing without the harvest failing. G5: the
      // line itself is wrapped too — a throwing sink must never drop the
      // landed retain's result over a refusal it is merely reporting.
      try {
        log({
          requestId: input.requestId,
          operation: "memory-retain-receipt",
          agentId: null,
          timestamp: new Date().toISOString(),
          duration: 0,
          status: "error",
          error: {
            code: typeof (e as { code?: unknown })?.code === "string" ? (e as { code: string }).code : "receipt-refused",
            // The twins' posture: stringified, secret-redacted, bounded — the
            // refusal line is never a raw un-redacted prose channel.
            message: redactSecrets(String((e as Error)?.message ?? e)).slice(0, 200),
          },
          runId: input.runId,
          documentId,
        });
      } catch {
        // The receipt is already gone; refusing to report that is not a failure.
      }
    }
  }
  return { retained: true, documentId, bank: input.repoBankId, contentDigest };
}
