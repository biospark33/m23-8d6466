/**
 * qa-retain — A2 AC3: the idempotent host-side multi-finding retain.
 *
 * `retainRunOutcome` (M1.2) is one document per runId; the hunter-pack is N
 * findings per leg, so this module derives its own stable dated documentId
 * per finding (qds-YYYYMMDD-hex6, the run-retain.ts:82 pin) and retains each
 * one over the UNMODIFIED `HindsightClient.retain` with
 * `updateMode:"replace"` — a byte-identical replay REPLACES instead of
 * duplicating, leaving one memory per finding.
 *
 * INV-KG-2: no credential parameter exists on any surface here — the client
 * carries the host env token (INV-HM1), and that is the only retain
 * credential there is. INV-A2-6: the bank id is the caller-resolved
 * `qds-<repo>` repo bank (`resolveRepoBankId` semantics, never re-derived
 * here) and is guard-checked for the full BankIdSchema identity — the
 * `solstice-*` families have no guard to pass.
 *
 * The audit receipt (INV-KG-4) lands AFTER retain success only, best-effort,
 * on the same coalesce identity (runId, memory-retain-receipt, retain,
 * documentId) M1.2 uses: a byte-identical replay dedups to one row per
 * finding, and a divergent-content re-retain under the same documentId trips
 * the store's divergent-evidence tamper alarm. A store refusal is logged,
 * never allowed to fail a landed retain.
 */

import { canonicalJson, sha256Hex, type AuditStoreWriter } from "../audit/link-store.ts";
import type { HindsightClient } from "../hindsight/client.ts";
import { RETAIN_PAYLOAD_MAX_BYTES } from "../hindsight/run-retain.ts";
import { BankIdSchema, resolveBankId } from "../hindsight/schemas.ts";
import { provisionedRepoBankCandidates, safeRepoBaseCandidates } from "../hindsight/bank-provisioner.ts";
import { log } from "../lib/log.ts";
import { redactSecrets } from "../providers/step-log.ts";
import { QA_LENS, QA_LOG, FindingSchema, MAX_FINDINGS_PER_HARVEST, type Finding } from "./findings.ts";

/**
 * The minted-runId shape — pinned verbatim from run-retain.ts:82 (M1.2).
 */
const RUN_ID_RE = /^qds-\d{8}-[a-f0-9]{6}$/;

/** The commit shape every fleet run already pins (40-hex, lowercase). */
const COMMIT_SHA_RE = /^[a-f0-9]{40}$/;

/**
 * The correlation-id and repo-slug shape — run-retain.ts:87-89's G14 bounds,
 * so the "no prose channel" header holds for every non-finding field here too.
 */
const REQUEST_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const REQUEST_ID_MAX_LEN = 64;
const REPO_SLUG_MAX_LEN = 200;

// biome-ignore lint/suspicious/noControlCharactersInRegex: detecting control characters IS the purpose (G14 posture)
const CONTROL_CHAR_RE = /[\u0000-\u001F\u007F]/;

/**
 * What `retainFindings` takes. `repoBankId` is the caller-resolved repo bank
 * (resolveRepoBankId semantics) — never re-derived here. `legRan` is the
 * absent-not-0 gate: a leg that did not run is refused upstream of any
 * retain, so `findings: []` can only ever mean ran-and-found-none.
 */
export interface RetainFindingsInput {
  repoBankId: string;
  runId: string;
  lens: string;
  commitSha: string;
  /** Provenance for the audit receipt (AuditLinkInput requires it). */
  repoSlug: string;
  requestId: string;
  legRan: boolean;
  findings: Finding[];
}

export interface QaRetainResult {
  retained: true;
  bank: string;
  documentIds: string[];
  /** Present only when some-but-not-all retains landed — absent-not-0: the
   * key itself is omitted when every finding landed. */
  failures?: { documentId: string; error: string }[];
}

export type QaRetainErrorCode =
  | "retain-leg-not-ran"
  | "retain-run-id-invalid"
  | "retain-bank-not-repo"
  | "retain-payload-invalid"
  | "retain-payload-oversize"
  | "retain-findings-overflow"
  | "retain-attribution-mismatch"
  | "retain-none-landed";

export class QaRetainError extends Error {
  constructor(
    readonly code: QaRetainErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "QaRetainError";
  }
}

/**
 * The per-finding document identity: `qds-<runId's date>-<hex6 over a digest
 * of (runId, lens, index)>` — content is EXCLUDED on purpose so a
 * divergent-content re-retain keeps the same documentId and trips the store's
 * tamper alarm instead of minting a fresh id (M1.2 trio #3).
 */
export function deriveFindingDocumentId(runId: string, lens: string, index: number): string {
  if (typeof runId !== "string" || !RUN_ID_RE.test(runId)) {
    throw new QaRetainError(
      "retain-run-id-invalid",
      `runId ${JSON.stringify(String(runId).slice(0, 64))} is not a minted run id (qds-YYYYMMDD-hex6) — the document date is the runId's, so no other shape can be retained`,
    );
  }
  return `qds-${runId.slice(4, 12)}-${sha256Hex(canonicalJson({ index, lens, runId })).slice(0, 6)}`;
}

/**
 * One finding's bounded, canonical retain payload. PURE. Exact-shape literal
 * in sorted key order (run-retain.ts:115 posture) — the finding's prose
 * (`finding_text`) is the ONLY prose channel, already bounded by
 * FindingSchema and secret-REDACTED here (secret-hygiene findings quote
 * secret material by construction), and the 4 KiB ceiling is refused before
 * any network call. Redaction only shrinks, so the ceiling stays honest
 * behind it.
 */
function buildFindingPayload(input: RetainFindingsInput, finding: Finding): string {
  const parsed = FindingSchema.safeParse(finding);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new QaRetainError(
      "retain-payload-invalid",
      `finding is malformed at ${issue?.path.join(".") || "(root)"}: ${issue?.message} — structured-only, refused, never passthrough`,
    );
  }
  const payload = {
    commitSha: input.commitSha,
    diff_context_ref: parsed.data.diff_context_ref,
    // Redact → build → ceiling, in that order: the retained copy of the sole
    // prose channel never carries live token material.
    finding_text: redactSecrets(parsed.data.finding_text),
    lens: input.lens,
    runId: input.runId,
  };
  const json = JSON.stringify(payload);
  if (Buffer.byteLength(json, "utf8") > RETAIN_PAYLOAD_MAX_BYTES) {
    throw new QaRetainError(
      "retain-payload-oversize",
      `finding retain payload is ${Buffer.byteLength(json, "utf8")} bytes — past the ${RETAIN_PAYLOAD_MAX_BYTES}-byte ceiling (refused before any network call, never truncated)`,
    );
  }
  return json;
}

/**
 * Validate the caller-resolved identity fields — every refusal here fires
 * before any client call, and the identity used to be trusted.
 */
function validateIdentity(input: RetainFindingsInput): void {
  if (input.legRan !== true) {
    throw new QaRetainError(
      "retain-leg-not-ran",
      "legRan is false — a non-ran leg has no findings to retain (absent-not-0: [] is reserved for ran-and-found-none)",
    );
  }
  if (!RUN_ID_RE.test(input.runId)) {
    throw new QaRetainError("retain-run-id-invalid", `runId must be a minted run id (qds-YYYYMMDD-hex6), got ${JSON.stringify(String(input.runId).slice(0, 64))}`);
  }
  if (!(QA_LENS as readonly string[]).includes(input.lens)) {
    throw new QaRetainError("retain-payload-invalid", `lens ${JSON.stringify(String(input.lens).slice(0, 64))} is not in QA_LENS — a finding outside the roster has no leg to attribute to`);
  }
  if (typeof input.commitSha !== "string" || !COMMIT_SHA_RE.test(input.commitSha)) {
    throw new QaRetainError("retain-payload-invalid", "commitSha must be 40-hex lowercase");
  }
  if (typeof input.repoSlug !== "string" || input.repoSlug.length === 0 || input.repoSlug.length > REPO_SLUG_MAX_LEN || CONTROL_CHAR_RE.test(input.repoSlug)) {
    throw new QaRetainError("retain-payload-invalid", `repoSlug must be a string of at most ${REPO_SLUG_MAX_LEN} characters with no control characters`);
  }
  // INV-A2-6: the full repo-bank identity guard. The bank id must be
  // BankIdSchema-shaped (lowercase alnum + hyphen, 1-64 chars, no hyphen-
  // padded ends) AND one of the repo's own provisioned-family candidates —
  // the SAME enumeration the dispatch-time recall fan-out resolves through
  // resolveProvisionedRepoBankId (provisionedRepoBankCandidates: every safe
  // base form of resolveBankId(repoSlug), plus its -2..-11 siblings). The
  // guard and the recall therefore read one candidate list and cannot drift:
  // whatever the recall fan-out reads is exactly what a retain may target,
  // which is what closes seam gap #11 for org-scoped slugs (the resolved
  // family carries no `qds-` prefix there) while a hand-named bank outside
  // the family — `qds-<short-name>`, the solstice-* families, a foreign
  // repo's bank — is refused by construction.
  if (typeof input.repoBankId !== "string" || !BankIdSchema.safeParse(input.repoBankId).success) {
    throw new QaRetainError("retain-bank-not-repo", `repoBankId must be BankIdSchema-shaped, got ${JSON.stringify(String(input.repoBankId).slice(0, 64))} — never the solstice-* families`);
  }
  const baseId = resolveBankId(input.repoSlug);
  const baseForms = safeRepoBaseCandidates(baseId);
  if (!provisionedRepoBankCandidates(baseId).includes(input.repoBankId)) {
    throw new QaRetainError("retain-bank-not-repo", `repoBankId ${JSON.stringify(input.repoBankId)} is not one of repo ${JSON.stringify(input.repoSlug)}'s provisioned-family candidates (base forms: ${baseForms.join(" / ")}, suffixes -2..-11) — the retain must target the same family the dispatch recall reads`);
  }
  if (typeof input.requestId !== "string" || input.requestId.length > REQUEST_ID_MAX_LEN || !REQUEST_ID_RE.test(input.requestId) || input.requestId.includes("..")) {
    throw new QaRetainError("retain-payload-invalid", `requestId must be a string of at most ${REQUEST_ID_MAX_LEN} characters matching ${REQUEST_ID_RE.source} with no ".."`);
  }
  if (!Array.isArray(input.findings)) {
    throw new QaRetainError("retain-payload-invalid", "findings must be an array");
  }
  if (input.findings.length > MAX_FINDINGS_PER_HARVEST) {
    throw new QaRetainError(
      "retain-findings-overflow",
      `findings length ${input.findings.length} exceeds the per-harvest cap of ${MAX_FINDINGS_PER_HARVEST} — refused, never truncated`,
    );
  }
  for (const f of input.findings) {
    if (f == null || typeof f !== "object") {
      throw new QaRetainError("retain-payload-invalid", "each finding must be an object");
    }
    if (f.runId !== input.runId || f.lens !== input.lens) {
      throw new QaRetainError(
        "retain-attribution-mismatch",
        `finding claims (runId ${JSON.stringify(String(f.runId).slice(0, 64))}, lens ${JSON.stringify(String(f.lens).slice(0, 64))}) but the retain is for (runId ${JSON.stringify(input.runId)}, lens ${JSON.stringify(input.lens)}) — never silently re-attributed`,
      );
    }
  }
}

/**
 * Retain N findings from one QA leg, then receipt them.
 *
 * Order is load-bearing: EVERY payload is built and bounded FIRST (an oversize
 * or malformed finding anywhere refuses before any client call), the retains
 * land per finding — a mid-run rejection keeps the landed work (resolved, with
 * each failure recorded on the result; only a nothing-landed run rejects) —
 * and only then are the receipts attempted — best-effort, so an
 * audit-store refusal is logged and NEVER fails a landed retain. The receipt's
 * coalesce identity is (runId, memory-retain-receipt, retain, documentId): a
 * byte-identical replay dedups to one row per finding; different content under
 * the same documentId trips the store's divergent-evidence alarm by design
 * (INV-KG-4) — the store keeps the first row and logs the divergence.
 */
export async function retainFindings(
  deps: { client: Pick<HindsightClient, "retain">; auditStore?: AuditStoreWriter },
  input: RetainFindingsInput,
): Promise<QaRetainResult> {
  validateIdentity(input);
  const payloads = input.findings.map((f) => buildFindingPayload(input, f));
  const documentIds = input.findings.map((_, i) => deriveFindingDocumentId(input.runId, input.lens, i));
  const tags = ["qa-f3", input.runId, input.lens];
  // Partial-failure semantics: a rejection on finding i>0 must not lose the
  // work already landed — per-finding try/catch, landed docs still get their
  // receipts, every failure is recorded on the result. Only a run where
  // NOTHING landed rejects.
  const landed: { documentId: string; payload: string }[] = [];
  const failures: { documentId: string; error: string }[] = [];
  for (let i = 0; i < payloads.length; i++) {
    const documentId = documentIds[i] as string;
    try {
      await deps.client.retain(input.repoBankId, payloads[i] as string, {
        documentId,
        updateMode: "replace",
        tags,
        kind: "observation",
        source: "agent",
      });
      landed.push({ documentId, payload: payloads[i] as string });
    } catch (e) {
      // Redacted + bounded: the caught error can carry a response body —
      // never let it leave this module as raw prose (house posture, :298).
      failures.push({
        documentId,
        error: redactSecrets(String((e as Error)?.message ?? e)).slice(0, 200),
      });
    }
  }
  if (failures.length > 0 && landed.length === 0) {
    throw new QaRetainError(
      "retain-none-landed",
      `all ${failures.length} retain calls failed — nothing landed, nothing retained (bounded count only; the per-finding wire errors ride the result, not this message)`,
    );
  }
  const landedIds = landed.map((l) => l.documentId);
  // The story-pinned Observability Contract line: qa-findings-retained
  // {bankId, documentIds}. Absent-not-0: documentIds is [] exactly when the
  // ran leg found none (a non-ran leg was refused above, before this line
  // existed to emit; an all-failed run rejects above, ditto). Best-effort:
  // the retains landed; losing the log line is not losing the retains.
  try {
    log({
      requestId: input.requestId,
      operation: QA_LOG.findingsRetained,
      agentId: null,
      timestamp: new Date().toISOString(),
      duration: 0,
      status: "ok",
      bankId: input.repoBankId,
      documentIds: landedIds,
    });
  } catch {
    // Telemetry is best-effort exactly like the receipts below.
  }
  if (deps.auditStore !== undefined) {
    const now = new Date().toISOString();
    for (const { documentId, payload } of landed) {
      const contentDigest = sha256Hex(payload);
      try {
        deps.auditStore.record({
          runId: input.runId,
          repoSlug: input.repoSlug,
          requestId: input.requestId,
          hop: "memory-retain-receipt",
          event: "retain",
          subjectId: documentId,
          subjectKind: "document",
          evidenceDigest: sha256Hex(canonicalJson({ bank: input.repoBankId, documentId, contentDigest })),
          // Digest-stable on replay and the readable provenance input the
          // priming round-trip probe compares.
          detail: { documentId, bank: input.repoBankId },
          occurredAt: now,
          recordedAt: now,
        });
      } catch (e) {
        // Best-effort by contract: the retain already landed. A refusal is one
        // structured error line — wrapped, so a throwing sink never drops the
        // landed retains' result over a refusal it is merely reporting.
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
              // Stringified, secret-redacted, bounded — never a raw un-redacted prose channel.
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
  }
  const result: QaRetainResult = { retained: true, bank: input.repoBankId, documentIds: landedIds };
  if (failures.length > 0) {
    result.failures = failures;
  }
  return result;
}
