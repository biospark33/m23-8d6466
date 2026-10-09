/**
 * M3.1 nightly consolidation — the single orchestrator both trigger legs
 * (crontab + schedule) call. HOST-side semantics: this module runs in the
 * trusted tier — the manager bot TRIGGERS the nightly pass, the memgate
 * gateway AUTHORIZES each consolidate, and Hindsight CONSOLIDATES
 * server-side; nothing here addresses the instance directly for the write.
 *
 * Gateway-fronted trigger (INV-MEM-2): the consolidate verb never touches
 * 8888/18889 — every consolidate rides verifyRequest → forwardScoped with an
 * agent token (bot grant class = consolidate only).
 *
 * Read-side exception: the preflight mental-model read and the refresh-evidence
 * operations poll call the server-credentialed client DIRECTLY. Rationale: no
 * gateway route exists for mental-models/operations (forward.ts default-refuses
 * them), adding one is out-of-scope for this story, and these reads are
 * read-only trusted-tier calls on the same credential class the gateway itself
 * embeds (deps.gateway.client IS that client). Evidence reads prove; writes
 * authorize.
 *
 * No job lock: bank-level consolidate dedup on the server IS the borrowed
 * idempotency — a second trigger leg firing while one is in flight coalesces
 * (operations.md:65,80), so an overlapping run is a counted success, not a
 * race to guard.
 *
 * DD-28.16 trigger-only: refresh is never called directly — there is no
 * refresh method on the client (pinned by tests elsewhere). The proof
 * standard is OBSERVED refresh evidence: an operation row of type
 * refresh_mental_model for this bank's mental model, created AFTER the
 * consolidate call completed, read from client.listOperations. Trigger
 * presence is configuration, never proof.
 */

import {
  ConsolidateResponseSchema,
  type ConsolidateResponse,
  type MentalModel,
  type MentalModelOperation,
  type MentalModelList,
  type OperationsList,
} from "./schemas.ts";
import { forwardScoped, verifyRequest, type MemgateDeps, type MemgatePrincipal } from "../memgate/gateway.ts";
import { MemgateError, type MemgateRefusalReason } from "../memgate/schemas.ts";
import { log, newRequestId, type LogEntry } from "../swarmclaw/log.ts";

export interface NightlyDeps {
  /** Built by the caller via memgateDeps(...) — its `.client` is the
   * server-credentialed HindsightClient used for the read-side evidence. */
  gateway: MemgateDeps;
  /** Agent token material (mgat.…) — read from env by the caller; NEVER
   * logged, never present in any event or receipt. */
  token: string;
  /** Manager meta bank ids — one consolidate each, never a fan-out verb. */
  banks: string[];
  leg: "crontab" | "schedule";
  now?: () => number;
  pollIntervalMs?: number;
  /** Per-JOB budget for observing refresh operations — shared across banks. */
  refreshEvidenceTimeoutMs?: number;
  log?: (entry: LogEntry) => void;
}

export interface NightlyReceipt {
  bankId: string;
  mentalModelId: string;
  consolidate: {
    operationId?: string;
    deduplicated?: boolean;
    consolidateMs?: number;
  };
  refresh: {
    mechanism: "consolidation-trigger";
    operationId: string;
    status: string;
    observedVia: "operations-list";
  };
}

export interface NightlyFailure {
  bankId: string;
  code: string;
  message: string;
  remediation: string;
}

export interface NightlyResult {
  ok: boolean;
  leg: "crontab" | "schedule";
  receipts: NightlyReceipt[];
  failures: NightlyFailure[];
  totalMs: number;
  banksOk: number;
  banksFailed: number;
}

/** The read-side subset of the server client (no gateway route exists for
 * these; see the header rationale). The real HindsightClient satisfies it. */
interface MemgateClientWithEvidence {
  listMentalModels(bankId: string, detail?: "metadata" | "content" | "full"): Promise<MentalModelList>;
  listOperations(bankId: string, opts?: { type?: string; status?: string; limit?: number }): Promise<OperationsList>;
}

const DEFAULT_POLL_INTERVAL_MS = 2_000;
const DEFAULT_REFRESH_EVIDENCE_TIMEOUT_MS = 300_000;
/** created_at is the SERVER's clock; consolidateCompletedAtMs is ours. A
 * small backwards-skew allowance keeps a slightly-behind instance clock from
 * masking real refresh evidence (a false REFRESH_EVIDENCE_MISSING is a
 * fail-loud defect — keep the window honest in both directions). */
const EVIDENCE_CLOCK_SKEW_MS = 5_000;

function nowMs(deps: NightlyDeps): number {
  return deps.now !== undefined ? deps.now() : Date.now();
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ponytail: discriminated per-bank outcome — the caller owns both arrays
type BankOutcome = { kind: "failure"; failure: NightlyFailure } | { kind: "receipt"; receipt: NightlyReceipt };

function failOf(bankId: string, code: string, message: string, remediation: string): BankOutcome {
  return { kind: "failure", failure: { bankId, code, message, remediation } };
}

function errorFields(e: unknown): { code: string; message: string; remediation: string } {
  if (e instanceof MemgateError) return { code: e.code, message: e.message, remediation: e.remediation };
  return {
    code: "NIGHTLY_FAULT",
    message: e instanceof Error ? e.message : String(e),
    remediation: "inspect the nightly-consolidate events above for the failing bank",
  };
}

function emit(deps: NightlyDeps, requestId: string, fields: Record<string, unknown>): void {
  const entry: LogEntry = {
    requestId,
    operation: "nightly-consolidate",
    agentId: null,
    timestamp: new Date().toISOString(),
    duration: 0,
    status: "ok",
    ...fields,
  };
  try {
    if (deps.log !== undefined) deps.log(entry);
    else log(entry);
  } catch {
    // observability only — a throwing sink must never gate the nightly pass
  }
}

/** The closed refusal reason → GATEWAY_* failure-code map (MemgateRefusalReason). */
const REFUSAL_CODE: Record<MemgateRefusalReason, string> = {
  "scope-bank": "GATEWAY_SCOPE_BANK",
  "scope-verb": "GATEWAY_SCOPE_VERB",
  expired: "GATEWAY_EXPIRED",
  revoked: "GATEWAY_REVOKED",
  "no-auth": "GATEWAY_NO_AUTH",
  "admin-auth": "GATEWAY_ADMIN_AUTH",
  "ledger-unreadable": "GATEWAY_LEDGER_UNREADABLE",
  "mint-invalid-ttl": "GATEWAY_MINT_INVALID_TTL",
};

/**
 * Run the nightly pass: one gateway-fronted consolidate per bank, each proven
 * by an OBSERVED consolidation-trigger refresh operation. Per-bank failures
 * never abort other banks (the shared evidence deadline still applies);
 * only config-level invalid input throws.
 */
export async function runNightlyConsolidate(deps: NightlyDeps): Promise<NightlyResult> {
  if (!Array.isArray(deps.banks) || deps.banks.length === 0) {
    throw new MemgateError("nightly-banks-empty",
      "banks is empty — the nightly pass must name at least one manager meta bank",
      "pass the provisioned manager meta bank ids (scripts/provision-hindsight-banks.ts output)");
  }
  if (typeof deps.token !== "string" || deps.token === "") {
    throw new MemgateError("nightly-token-missing",
      "no agent token material — the consolidate trigger rides the gateway and must be authorized",
      "grant an agent token (consumerClass bot, verbs [consolidate], banks = the manager meta banks) and pass its material");
  }
  const client = deps.gateway.client;
  if (client === undefined) {
    throw new MemgateError("client-missing",
      "no Hindsight client is wired into the gateway — the consolidate trigger and the evidence reads have no target",
      "construct the gateway via memgateDeps with a server-credentialed client");
  }
  const read = client as unknown as MemgateClientWithEvidence; // the one read-side seam (see header)
  const deadlineMs = nowMs(deps) + (deps.refreshEvidenceTimeoutMs ?? DEFAULT_REFRESH_EVIDENCE_TIMEOUT_MS);
  const started = nowMs(deps);
  const requestId = newRequestId();

  emit(deps, requestId, { event: "nightly-fire", leg: deps.leg, banks: [...deps.banks] });

  const receipts: NightlyReceipt[] = [];
  const failures: NightlyFailure[] = [];

  for (const bank of deps.banks) {
    const outcome = await consolidateOneBank(deps, read, bank, requestId, deadlineMs);
    if (outcome.kind === "failure") {
      failures.push(outcome.failure);
      emit(deps, requestId, {
        event: "nightly-bank-failed", leg: deps.leg, bankId: bank, code: outcome.failure.code,
      });
      continue;
    }
    receipts.push(outcome.receipt);
  }

  const totalMs = nowMs(deps) - started;
  emit(deps, requestId, {
    event: "nightly-complete",
    leg: deps.leg,
    banks_ok: receipts.length,
    banks_failed: failures.length,
    total_ms: totalMs,
  });
  return {
    ok: failures.length === 0,
    leg: deps.leg,
    receipts,
    failures,
    totalMs,
    banksOk: receipts.length,
    banksFailed: failures.length,
  };
}

/** One bank: preflight → gateway-fronted consolidate → observed refresh
 * evidence. Returns the receipt on success, a failure row otherwise. */
async function consolidateOneBank(
  deps: NightlyDeps,
  read: MemgateClientWithEvidence,
  bank: string,
  requestId: string,
  deadlineMs: number,
): Promise<BankOutcome> {
  // 1. PREFLIGHT — trigger presence is checked here, but it is configuration,
  //    never proof (the proof is step 3).
  let model: MentalModel;
  try {
    const list = await read.listMentalModels(bank, "content");
    const found = list.items.find((m) => m.trigger?.refresh_after_consolidation === true);
    if (found === undefined) {
      return failOf(bank, "MM_TRIGGER_ABSENT",
        `bank ${bank} has no mental model with trigger.refresh_after_consolidation=true — there is nothing to consolidate into and nothing to observe`,
        "run scripts/provision-hindsight-banks.ts to create the triggered mental model");
    }
    model = found;
  } catch (e) {
    const f = errorFields(e);
    return failOf(bank, f.code === "NIGHTLY_FAULT" ? "PREFLIGHT_FAILED" : f.code,
      `preflight mental-model read failed for bank ${bank}: ${f.message}`, f.remediation);
  }

  // 2. CONSOLIDATE THROUGH THE GATEWAY — verify-then-forward with the agent
  //    token; INV-MEM-2: the verb never addresses the instance directly.
  const path = `/v1/default/banks/${bank}/consolidate`;
  const verify = verifyRequest(deps.gateway, {
    authHeader: `Bearer ${deps.token}`,
    method: "POST",
    path,
    requestId,
  });
  if (!verify.ok) {
    return failOf(bank, REFUSAL_CODE[verify.reason],
      `the gateway refused the consolidate for bank ${bank} (reason: ${verify.reason})`,
      "check agent token scope (bank/verb)");
  }
  const principal: MemgatePrincipal = verify.principal;
  const consolidateStarted = nowMs(deps);
  let raw: unknown;
  try {
    // undefined body = argument-less consolidate (forward.ts: b.options absent → args [undefined])
    raw = await forwardScoped(deps.gateway, principal, "POST", path, undefined, requestId);
  } catch (e) {
    const f = errorFields(e);
    return failOf(bank, f.code === "NIGHTLY_FAULT" ? "CONSOLIDATE_FAILED" : f.code,
      `consolidate forward failed for bank ${bank}: ${f.message}`, f.remediation);
  }
  const consolidateCompletedAtMs = nowMs(deps);
  const parsed = ConsolidateResponseSchema.safeParse(raw);
  if (!parsed.success) {
    return failOf(bank, "CONSOLIDATE_UNPARSEABLE",
      `the consolidate response for bank ${bank} did not parse as ConsolidateResponse`,
      "check the Hindsight instance version against ConsolidateResponseSchema");
  }
  const response: ConsolidateResponse = parsed.data;
  const deduplicated = response.deduplicated === true;
  const consolidateMs = nowMs(deps) - consolidateStarted;

  if (deduplicated) {
    // Coalesced re-fire — a COUNTED SUCCESS, never an error; consolidate_ms and
    // operation_id stay ABSENT (the coalescing op is the server's, not ours).
    emit(deps, requestId, { event: "coalesced", leg: deps.leg, bankId: bank });
  } else {
    emit(deps, requestId, {
      event: "consolidate-op",
      leg: deps.leg,
      bankId: bank,
      operationId: response.operation_id,
      consolidate_ms: consolidateMs,
    });
  }

  // 3. REFRESH EVIDENCE — OBSERVED, fail-loud: a refresh_mental_model op for
  //    THIS model created AFTER the consolidate call completed.
  const op = await observeRefresh(deps, read, bank, model.id, consolidateCompletedAtMs, deadlineMs);
  if (op.kind === "missing") {
    return failOf(bank, "REFRESH_EVIDENCE_MISSING",
      `no refresh_mental_model operation for mental model ${model.id} was observed after the consolidate for bank ${bank} within the evidence budget`,
      "verify the instance fired the consolidation-trigger refresh; check the bank's mental-model history");
  }
  if (op.row.status === "failed") {
    return failOf(bank, "REFRESH_FAILED",
      `the observed refresh for bank ${bank} failed: ${op.row.error_message ?? "server reported status=failed without an error message"}`,
      "inspect the operation's error_message via client.listOperations and re-run the nightly pass");
  }

  const receipt: NightlyReceipt = {
    bankId: bank,
    mentalModelId: model.id,
    consolidate: deduplicated
      ? { deduplicated: true }
      : {
          ...(response.operation_id !== undefined ? { operationId: response.operation_id } : {}),
          consolidateMs,
        },
    refresh: {
      mechanism: "consolidation-trigger",
      operationId: op.row.id,
      status: op.row.status,
      observedVia: "operations-list",
    },
  };
  emit(deps, requestId, {
    event: "refresh-op",
    leg: deps.leg,
    bankId: receipt.bankId,
    mechanism: receipt.refresh.mechanism,
    receipt,
  });
  return { kind: "receipt", receipt };
}

// ponytail: discriminated result — the found op row vs the budgeted absence
type ObservedRefresh =
  | { kind: "observed"; row: MentalModelOperation }
  | { kind: "missing" };

async function observeRefresh(
  deps: NightlyDeps,
  read: MemgateClientWithEvidence,
  bank: string,
  mentalModelId: string,
  consolidateCompletedAtMs: number,
  deadlineMs: number,
): Promise<ObservedRefresh> {
  const pollIntervalMs = deps.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  while (true) {
    let op: MentalModelOperation | undefined;
    try {
      const list = await read.listOperations(bank, { type: "refresh_mental_model", limit: 50 });
      op = list.operations.find(
        (o) =>
          o.mental_model_id === mentalModelId &&
          Date.parse(o.created_at) > consolidateCompletedAtMs - EVIDENCE_CLOCK_SKEW_MS,
      );
    } catch {
      op = undefined; // a faulting read is retried until the budget — fail-loud lives in the deadline
    }
    if (op !== undefined) return { kind: "observed", row: op };
    if (nowMs(deps) + pollIntervalMs >= deadlineMs) return { kind: "missing" };
    await sleep(pollIntervalMs);
  }
}
