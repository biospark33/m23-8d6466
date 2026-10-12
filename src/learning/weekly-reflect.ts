/**
 * M3.2 — the L4 weekly reflect → PROPOSE job: the single orchestrator both
 * trigger legs (crontab + schedule) call. HOST-side semantics like M3.1's
 * nightly: gather (read-only) → reflect per manager meta bank → compose →
 * store + idempotent retain + operator posting. PROPOSE is the ceiling
 * (FR-LEARN-30): the only writes are `.sandbox/proposals/` records and
 * `*-meta` retains — no path here mutates routing, threshold, skill, gate, or
 * any consumed store (AC1/INV-LEARN-1/2).
 *
 * Gateway posture (INV-LEARN-4): every bank op rides verifyRequest → forwardScoped with the HOST-class agent
 * token ({reflect, retain}) — the nightly-consolidate.ts:349 idiom. The plan's client-at-gateway-origin primary
 * is not taken, deliberately: MemgateDeps is an in-process library surface (no origin to point a client at), and
 * HindsightClient's items-wrapped retain body would degrade under the gateway's top-level forward contract —
 * verify-then-forward is the sanctioned fallback and is therefore THE path (per the plan's "no third option").
 *
 * Idempotency is borrowed, not built (M1.2's P2.8 fold): `documentId = <proposal_id> =
 * "l4-proposal-<week>-<firedAt-stamp>-<seq>"` + `updateMode: "replace"`. `replace` guards the byte-identical
 * retry within a firing; the stamp in the id makes a same-week re-fire mint NEW ids — never a rewrite of an old
 * id — and the receipt names the superseded earlier ids.
 *
 * Divergence policy (C7, decided): a `PROPOSAL_DIVERGENT` fault means the store's append-only discipline WORKED —
 * the stored row stands, the incoming rewrite is dropped, a typed fault is logged, and the dropped id leaves both
 * `receipt.proposals` and `posted` (the receipt invariant stays exact).
 *
 * Exit contract: `ok` is true only when EVERY bank reflected (banks_failed empty — the M3.1 nightly precedent:
 * ok = failures.length === 0), no store/retain fault occurred, and (≥1 proposal landed or none was expected) — a
 * firing with a failed bank, a landing fault, or an all-diverged store never reads green.
 */

import { randomUUID } from "node:crypto";
import { closeSync, fsyncSync, linkSync, mkdirSync, openSync, readdirSync, readFileSync, statSync, unlinkSync, writeSync } from "node:fs";
import { join } from "node:path";

import { buildReflectQuery, composeProposals, type ReflectEntry } from "./compose.ts";
import { gatherEvidence, GatherFault, type GatheredEvidence } from "./gather.ts";
import { ISO_WEEK_RE, WeeklyReceiptSchema, type ProposalRecord, type WeeklyReceipt } from "./proposal-schema.ts";
import { ReflectResponseSchema } from "../hindsight/schemas.ts";
import { forwardScoped, verifyRequest, type MemgateDeps } from "../memgate/gateway.ts";
import { MemgateError, type MemgateRefusalReason } from "../memgate/schemas.ts";
import { log, type LogEntry } from "../swarmclaw/log.ts";

// ─── constants ───────────────────────────────────────────────────────────────

/** Overall job deadline (start + this), above 2× the client's 30 s reflect/retain timeouts; banks whose turn
 * starts after it are skipped fail-loud, never silently (the nightly guard idiom). */
export const WEEKLY_WALL_CLOCK_BUDGET_MS = 600_000;
/** Default proposals store — the crontab carrier redirect lands beside it. */
export const DEFAULT_PROPOSALS_DIR = ".sandbox/proposals";
/** Retain-content ceiling on the wire (bytes) — a proposal is read in a chat turn; the rationale's own 4 000-char
 * ceiling lives in the schema. */
export const RETAIN_CONTENT_BYTE_CEILING = 4_096;
/** Firing-identity seam: a FIXED-WIDTH ms stamp — the receipt's supersession claim is lexicographic over it, so
 * the `.mmm` form is mandatory. CLI callers normalize via toISOString; only the library seam can be wrong. */
const FIRED_AT_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
/** Store filename grammar: `l4-proposal-<week>-<stamp>-<seq3>.json`. */
const PROPOSAL_FILE_RE = /^l4-proposal-(\d{4}-W\d{2})-(.+)-(\d{3})\.json$/;

/** The closed gateway refusal → failure-code map (nightly's REFUSAL_CODE). */
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

// ─── types ───────────────────────────────────────────────────────────────────

/** The store/gather lanes' local fault type — MemgateError stays on gateway surfaces; the proposals store and
 * evidence gather are local filesystem, not a gateway. Same {code, message, remediation} shape. */
export class ProposalStoreError extends Error {
  readonly code: string;
  readonly remediation: string;
  constructor(code: string, message: string, remediation: string) {
    super(message);
    this.name = "ProposalStoreError";
    this.code = code;
    this.remediation = remediation;
  }
}

export interface WeeklyDeps {
  /** Built by the caller via memgateDeps(...) — the reflect/retain forwards verify against it; its `.client` is the server-credentialed target. */
  gateway: MemgateDeps;
  /** Host-class agent token material (mgat.…) — NEVER logged, never in any event or receipt (INV-LEARN-4). */
  token: string;
  /** Manager meta bank ids — one reflect each. */
  banks: string[];
  leg: "crontab" | "schedule";
  week: string;
  /** Firing identity — stable across a byte-identical retry, advanced by a same-week re-fire. Default: now().toISOString(). */
  firedAt?: string;
  proposalsDir?: string;
  routingLogPath?: string;
  kpiSnapshotsDir?: string;
  runsDir?: string;
  now?: () => Date;
  wallClockBudgetMs?: number;
  log?: (e: unknown) => void;
}

export interface WeeklyResult {
  ok: boolean;
  leg: "crontab" | "schedule";
  week: string;
  receipt: WeeklyReceipt;
  /** This firing's fully-landed proposals (store + retain + post all held). */
  proposals: ProposalRecord[];
  /** The firing leg's carrier texts — full operator text (crontab) or the chat summary (schedule); the bot relays verbatim (A1 seam). */
  postedTexts: { proposal_id: string; text: string }[];
  totalMs: number;
}

// ─── operator-facing text (host-composed; bot relays verbatim) ───────────────

const refList = (refs: string[]): string => (refs.length === 0 ? "none" : refs.join(", "));

/** The full proposal text — the crontab leg's carrier payload. */
export function composeOperatorText(p: ProposalRecord): string {
  const lines = [
    `L4 proposal ${p.proposal_id} (week ${p.week}, kind ${p.kind})`,
    `target bank: ${p.target_bank}`,
    `advisory: ${p.advisory ? "yes" : "no"}${p.adjudicator !== undefined ? ` — adjudicator: ${p.adjudicator}` : ""}`,
    ...(p.j2_gate_note !== undefined ? [`J2 gate: ${p.j2_gate_note}`] : []),
    `proposed change (${p.suggested_change.area}): ${p.suggested_change.summary}`,
    `rationale: ${p.rationale}`,
    `evidence — routing: ${refList(p.evidence.routing_log_refs)} | kpi snapshots: ${refList(p.evidence.kpi_snapshot_refs)} | run records: ${refList(p.evidence.run_record_refs)}`,
    ...(p.insights_cited.length > 0 ? [`insights: ${p.insights_cited.join(" | ")}`] : []),
    "Nothing is applied automatically — apply any change by hand in your own commit.",
  ];
  return lines.join("\n");
}

/** The one-line summary — the schedule leg's carrier payload. */
export function composeOperatorSummary(p: ProposalRecord): string {
  const flag = p.advisory ? `advisory — ${p.adjudicator ?? "operator"} applies` : "operator applies in their own change";
  return `[${p.proposal_id}] ${p.kind}: ${p.suggested_change.summary} (${flag})`;
}

// ─── emit + small helpers ────────────────────────────────────────────────────

function emit(deps: WeeklyDeps, requestId: string, fields: Record<string, unknown>): void {
  const entry: LogEntry = { requestId, operation: "weekly-reflect", agentId: null, timestamp: new Date().toISOString(), duration: 0, status: "ok", ...fields };
  try {
    if (deps.log !== undefined) deps.log(entry);
    else log(entry);
  } catch {
    // observability only — a throwing sink must never gate the weekly pass
  }
}

function nowMs(deps: WeeklyDeps): number {
  return (deps.now ?? (() => new Date()))().getTime();
}

/** Clamp a duration read off the (possibly drifting) clock to a finite ≥0 int (receipt schema: z.number().int().min(0)). */
const elapsedMs = (started: number, end: number): number => (Number.isFinite(end) ? Math.max(0, Math.round(end - started)) : 0);

/** Truncate to a UTF-8 byte ceiling without splitting a code point — one linear pass; for-of iterates whole code
 * points (ponytail: rationales are ≤4 000 chars, never a hot path). */
function capBytes(s: string, max: number): string {
  let used = 0;
  let cut = 0;
  for (const ch of s) {
    const w = Buffer.byteLength(ch, "utf8");
    if (used + w > max) break;
    used += w;
    cut += ch.length;
  }
  return s.slice(0, cut);
}

// ─── the store (0700 dir, 0600 records; temp+fsync+link = exclusive create) ──

type StoreOutcome = "written" | "kept-existing" | "divergent";

function writeProposalRecord(dir: string, p: ProposalRecord): StoreOutcome {
  const bytes = Buffer.from(JSON.stringify(p), "utf8"); // compose's literal key order is deterministic
  const finalPath = join(dir, `${p.proposal_id}.json`);
  // Mode gate FIRST (F-007) — an existing row must never mask a wide-mode directory.
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const dirMode = statSync(dir).mode & 0o777;
  if (dirMode !== 0o700) {
    throw new ProposalStoreError(
      "proposals-dir-mode",
      `proposals dir ${dir} is mode 0${dirMode.toString(8)}, not 0700`,
      "chmod 0700 the proposals dir and re-run — proposal records are 0600 and must not sit in a wider-mode directory",
    );
  }
  const tempPath = join(dir, `.${p.proposal_id}.tmp-${process.pid}-${randomUUID()}`);
  let fd: number | undefined;
  try {
    fd = openSync(tempPath, "wx", 0o600); // O_EXCL — a stranded temp never collides
    writeSync(fd, bytes); // ponytail: one write — records are ≤8 KiB and regular files write whole
    fsyncSync(fd);
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
  try {
    // link() is the exclusive create (F-002): exactly ONE racing writer's link succeeds, so a same-firedAt firing
    // can never silently overwrite another's row the way existsSync→rename could.
    linkSync(tempPath, finalPath);
    return "written";
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "EEXIST") {
      // Lost the race — the stored row stands. Byte-identical retry = no-op; divergent content = stored row wins.
      return readFileSync(finalPath).equals(bytes) ? "kept-existing" : "divergent";
    }
    throw e;
  } finally {
    try {
      unlinkSync(tempPath); // link() leaves the temp name behind on success too
    } catch {
      // best-effort — the temp name is unique per attempt, never the final name
    }
  }
}

/** The receipt's superseded set: `l4-proposal-<week>-*` ids whose stamp segment is from a STRICTLY EARLIER firing
 * (lexicographic — the stamp is fixed-width ISO). Name-based on purpose: the store row's proposal_id IS its
 * filename by construction. An out-of-order re-fire (operator pins an earlier QDS_WEEKLY_FIRED_AT after a newer
 * firing) therefore does NOT label the newer ids superseded — a later firing is never superseded by an earlier one. */
function supersededIds(dir: string, week: string, stamp: string): string[] {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return []; // absent OR dir-path-is-a-file: nothing superseded (F-010)
    throw e;
  }
  const out: string[] = [];
  for (const name of names) {
    const m = PROPOSAL_FILE_RE.exec(name);
    const weekSeg = m?.[1];
    const stampSeg = m?.[2];
    if (weekSeg !== undefined && stampSeg !== undefined && weekSeg === week && stampSeg < stamp) {
      out.push(name.replace(/\.json$/, ""));
    }
  }
  return out.sort();
}

// ─── per-bank reflect ────────────────────────────────────────────────────────

type BankOutcome =
  | { ok: true; insights: Array<{ summary: string }>; ms: number }
  | { ok: false; code: string; message: string; remediation: string };

async function reflectOneBank(deps: WeeklyDeps, bank: string, evidence: GatheredEvidence, requestId: string): Promise<BankOutcome> {
  const started = nowMs(deps);
  const path = `/v1/default/banks/${bank}/reflect`;
  const verify = verifyRequest(deps.gateway, { authHeader: `Bearer ${deps.token}`, method: "POST", path, requestId });
  if (!verify.ok) {
    return { ok: false, code: REFUSAL_CODE[verify.reason],
      message: `the gateway refused the reflect for bank ${bank} (reason: ${verify.reason})`,
      remediation: "check the host agent token's bank/verb scope (host class: reflect + retain)" };
  }
  let raw: unknown;
  try {
    raw = await forwardScoped(deps.gateway, verify.principal, "POST", path, { query: buildReflectQuery(bank, evidence) }, requestId);
  } catch (e) {
    return { ok: false, code: e instanceof MemgateError ? e.code : "REFLECT_FAILED",
      message: `reflect forward failed for bank ${bank}: ${e instanceof Error ? e.message : String(e)}`,
      remediation: "inspect the gateway's forward events above for the failing bank, then re-run" };
  }
  const parsed = ReflectResponseSchema.safeParse(raw);
  if (!parsed.success) {
    // Known posture (self-review round 0 #2): ReflectResponseSchema requires insights.min(1) (M1.1-owned,
    // byte-identical — not widened here), so a FRESH-EMPTY bank reflects as REFLECT_UNPARSEABLE and lands in
    // banks_failed. That red is honest: by the time the weekly job ever fires, M1.2's retain flow and M3.1's
    // consolidate have guaranteed bank content — a red weekly on an empty memory bank IS an operations problem.
    return { ok: false, code: "REFLECT_UNPARSEABLE",
      message: `the reflect response for bank ${bank} did not parse as ReflectResponse`,
      remediation: "check the instance version against ReflectResponseSchema, then re-run" };
  }
  return { ok: true, insights: parsed.data.insights, ms: elapsedMs(started, nowMs(deps)) };
}

// ─── per-proposal retain ─────────────────────────────────────────────────────

type RetainOutcome = { ok: true } | { ok: false; code: string; message: string; remediation: string };

async function retainProposal(deps: WeeklyDeps, requestId: string, p: ProposalRecord): Promise<RetainOutcome> {
  const path = `/v1/default/banks/${p.target_bank}/memories`;
  const verify = verifyRequest(deps.gateway, { authHeader: `Bearer ${deps.token}`, method: "POST", path, requestId });
  if (!verify.ok) {
    return { ok: false, code: REFUSAL_CODE[verify.reason],
      message: `the gateway refused the retain for proposal ${p.proposal_id} (reason: ${verify.reason})`,
      remediation: "check the host agent token's bank/verb scope (host class: reflect + retain)" };
  }
  try {
    await forwardScoped(deps.gateway, verify.principal, "POST", path, {
      content: capBytes(composeOperatorText(p), RETAIN_CONTENT_BYTE_CEILING),
      metadata: { documentId: p.proposal_id, updateMode: "replace", tags: [p.proposal_id, p.kind, p.week], source: "agent", kind: "observation" },
    }, requestId);
  } catch (e) {
    return { ok: false, code: e instanceof MemgateError ? e.code : "RETAIN_FAILED",
      message: `retain forward failed for proposal ${p.proposal_id}: ${e instanceof Error ? e.message : String(e)}`,
      remediation: "inspect the gateway's forward events above for this proposal, then re-run" };
  }
  return { ok: true };
}

// ─── the job ─────────────────────────────────────────────────────────────────

/**
 * Run the weekly pass. Per-bank and per-proposal failures never abort their siblings, but they DO fail the run:
 * `ok` = every bank reflected AND no store/retain fault AND (≥1 proposal landed or none was expected). Config
 * guards throw typed faults (MemgateError / ProposalStoreError / GatherFault) BEFORE any bank work; a data-level
 * gather fault throws typed too, after a `weekly-fault` event.
 */
export async function runWeeklyReflect(deps: WeeklyDeps): Promise<WeeklyResult> {
  // Config guards first — fail before any gather, network, or state change.
  const started = nowMs(deps);
  if (!Number.isFinite(started)) {
    throw new MemgateError("weekly-clock-invalid",
      "the injected clock returned a non-finite value — every deadline derived from it is meaningless",
      "fix the deps.now seam: the function passed as WeeklyDeps.now must return a finite Date");
  }
  if (!Array.isArray(deps.banks) || deps.banks.length === 0) {
    throw new MemgateError("weekly-banks-empty",
      "banks is empty — the weekly pass must name at least one manager meta bank",
      "pass the provisioned manager meta bank ids (scripts/memory-weekly.ts derives the family)");
  }
  if (typeof deps.token !== "string" || deps.token === "") {
    throw new MemgateError("weekly-token-missing",
      "no agent token material — every reflect and retain rides the gateway and must be authorized",
      "grant a host-class agent token (consumerClass host, verbs [reflect, retain], banks = the manager meta banks) and pass its material");
  }
  const wallBudgetMs = deps.wallClockBudgetMs ?? WEEKLY_WALL_CLOCK_BUDGET_MS;
  if (!Number.isFinite(wallBudgetMs) || wallBudgetMs <= 0) {
    throw new MemgateError("weekly-budget-invalid",
      `wallClockBudgetMs ${String(wallBudgetMs)} is not a finite positive ms number — the job deadline would be meaningless`,
      "pass finite deps.wallClockBudgetMs (or omit it for the WEEKLY_WALL_CLOCK_BUDGET_MS default)");
  }
  if (!ISO_WEEK_RE.test(deps.week)) {
    throw new MemgateError("weekly-week-invalid",
      `week "${deps.week}" is not an ISO week label (YYYY-Wnn) — the receipt and every proposal id embed it`,
      'pass a week like "2026-W41" (scripts/memory-weekly.ts derives it via --week or isoWeekOf)');
  }
  const firedAt = deps.firedAt ?? new Date(started).toISOString();
  if (!FIRED_AT_RE.test(firedAt) || !Number.isFinite(Date.parse(firedAt))) {
    throw new MemgateError("weekly-fired-at-invalid",
      `firedAt "${firedAt}" is not a canonical UTC ISO instant with milliseconds — firing identity is carried in every proposal id and the receipt, and supersession orders ids lexicographically`,
      "pass deps.firedAt as a toISOString() instant (scripts/memory-weekly.ts reads the QDS_WEEKLY_FIRED_AT seam and normalizes)");
  }

  const requestId = `req-${randomUUID()}`;
  const banks = [...new Set(deps.banks)];
  const dir = deps.proposalsDir ?? DEFAULT_PROPOSALS_DIR;
  const stamp = firedAt.replace(/[:.]/g, "-"); // compose's id-stamp expression, verbatim
  const deadlineMs = started + wallBudgetMs;

  emit(deps, requestId, { event: "weekly-fire", requestId, leg: deps.leg, week: deps.week });

  // 1. GATHER — read-only, scoped to the requested ISO week (a proposal's evidence
  //    must be the week it reflects); absent sources are typed absence, but a CORRUPT source is a typed fault:
  //    logged, then thrown before any bank work.
  let evidence: GatheredEvidence;
  try {
    evidence = gatherEvidence({ routingLogPath: deps.routingLogPath, kpiSnapshotsDir: deps.kpiSnapshotsDir, runsDir: deps.runsDir, week: deps.week });
  } catch (e) {
    const fault = e instanceof GatherFault
      ? e
      : new ProposalStoreError("weekly-gather-failed",
        `evidence gather failed: ${e instanceof Error ? e.message : String(e)}`,
        "inspect the consumed-store paths (routingLogPath / kpiSnapshotsDir / runsDir), then re-run");
    emit(deps, requestId, { event: "weekly-fault", leg: deps.leg, status: "error", code: fault.code, message: fault.message, remediation: fault.remediation });
    throw fault;
  }

  // 2. REFLECT per bank — a failure skips that bank, never aborts siblings.
  const reflects: ReflectEntry[] = [];
  const reflect_ok: Record<string, boolean> = {};
  const reflectMsByBank: Record<string, number> = {};
  const banksOk: string[] = [];
  const banksFailed: string[] = [];
  for (const bank of banks) {
    if (nowMs(deps) >= deadlineMs) {
      banksFailed.push(bank);
      emit(deps, requestId, { event: "reflect-run", leg: deps.leg, bankId: bank, status: "error",
        code: "WEEKLY_BUDGET_EXHAUSTED",
        message: `wall-clock budget exhausted before bank ${bank} started (WEEKLY_WALL_CLOCK_BUDGET_MS = ${wallBudgetMs}ms) — skipped, not reflected`,
        remediation: "raise deps.wallClockBudgetMs or shrink the evidence work, then re-run" });
      continue;
    }
    const outcome = await reflectOneBank(deps, bank, evidence, requestId);
    reflect_ok[bank] = outcome.ok;
    if (!outcome.ok) {
      banksFailed.push(bank);
      emit(deps, requestId, { event: "reflect-run", leg: deps.leg, bankId: bank, status: "error",
        code: outcome.code, message: outcome.message, remediation: outcome.remediation });
      continue;
    }
    banksOk.push(bank);
    reflectMsByBank[bank] = outcome.ms;
    reflects.push({ bankId: bank, insights: outcome.insights });
    emit(deps, requestId, { event: "reflect-run", leg: deps.leg, bankId: bank, reflect_ms: outcome.ms });
  }

  // 3. COMPOSE — deterministic; zero evidence ⇒ zero proposals, green.
  const composed = composeProposals({ week: deps.week, firedAt, evidence, reflects, reflect_ok, banks });

  // 4. STORE + RETAIN + POST per proposal — one lane each, siblings continue.
  const landed: ProposalRecord[] = [];
  const postedTexts: { proposal_id: string; text: string }[] = [];
  const posted: Array<{ proposal_id: string; carrier: "chat" | "stdout" }> = [];
  let landFaults = 0; // store / retain / budget faults each flip `ok`; a DETECTED divergence does not
  for (const p of composed) {
    emit(deps, requestId, {
      event: "proposal-composed", leg: deps.leg, proposal_id: p.proposal_id, kind: p.kind,
      target_bank: p.target_bank,
      evidence_refs: [...p.evidence.routing_log_refs, ...p.evidence.kpi_snapshot_refs, ...p.evidence.run_record_refs],
    });
    if (nowMs(deps) >= deadlineMs) {
      // No partial posting: past the deadline nothing is stored, retained, or posted.
      landFaults++;
      emit(deps, requestId, { event: "weekly-fault", leg: deps.leg, proposal_id: p.proposal_id, status: "error",
        code: "WEEKLY_BUDGET_EXHAUSTED",
        message: `wall-clock budget exhausted before proposal ${p.proposal_id} landed (WEEKLY_WALL_CLOCK_BUDGET_MS = ${wallBudgetMs}ms) — not stored, not retained, not posted`,
        remediation: "raise deps.wallClockBudgetMs or shrink the evidence work, then re-run" });
      continue;
    }
    let storeOutcome: StoreOutcome;
    try {
      storeOutcome = writeProposalRecord(dir, p);
    } catch (e) {
      landFaults++;
      emit(deps, requestId, { event: "weekly-fault", leg: deps.leg, proposal_id: p.proposal_id, status: "error",
        code: e instanceof ProposalStoreError ? e.code : "PROPOSAL_STORE_FAILED",
        message: e instanceof Error ? e.message : String(e),
        remediation: e instanceof ProposalStoreError ? e.remediation : "check the proposals directory, then re-run" });
      continue;
    }
    if (storeOutcome === "divergent") {
      // The stored row stands; the incoming rewrite is dropped (C7 policy, header). A DETECTED divergence is the
      // discipline working — not a landing fault; `ok` still demands a clean run, so an all-diverged firing
      // (nothing landed, siblings none) never reads green.
      emit(deps, requestId, { event: "weekly-fault", leg: deps.leg, proposal_id: p.proposal_id, status: "error",
        code: "PROPOSAL_DIVERGENT",
        message: `proposal ${p.proposal_id} diverges from the stored record — the stored row stands and the incoming rewrite was dropped`,
        remediation: "inspect the stored proposal record; a same-id rewrite is never applied silently" });
      continue;
    }
    const retain = await retainProposal(deps, requestId, p);
    if (!retain.ok) {
      landFaults++;
      emit(deps, requestId, { event: "weekly-fault", leg: deps.leg, proposal_id: p.proposal_id, status: "error",
        code: retain.code, message: retain.message, remediation: retain.remediation });
      continue;
    }
    landed.push(p);
    const carrier = deps.leg === "crontab" ? "stdout" : "chat";
    posted.push({ proposal_id: p.proposal_id, carrier });
    postedTexts.push({ proposal_id: p.proposal_id, text: carrier === "stdout" ? composeOperatorText(p) : composeOperatorSummary(p) });
    emit(deps, requestId, { event: "proposal-posted", leg: deps.leg, proposal_id: p.proposal_id, carrier });
  }

  // 5. RECEIPT — authoritative set + superseded names; exact posted coverage.
  const receipt = WeeklyReceiptSchema.parse({
    schema: "qds.l4-week-receipt", week: deps.week, fired_at: firedAt, leg: deps.leg,
    proposals: landed.map((p) => p.proposal_id),
    superseded: supersededIds(dir, deps.week, stamp),
    absent_sources: evidence.absentSources,
    banks_ok: banksOk, banks_failed: banksFailed, posted,
    total_ms: elapsedMs(started, nowMs(deps)),
    ...(Object.keys(reflectMsByBank).length > 0 ? { reflect_ms_by_bank: reflectMsByBank } : {}),
  });

  const ok = banksFailed.length === 0 && landFaults === 0 && (landed.length >= 1 || composed.length === 0);
  const totalMs = receipt.total_ms;
  emit(deps, requestId, { event: "weekly-complete", leg: deps.leg,
    proposals: landed.length, banks_ok: banksOk.length,
    absent_sources: evidence.absentSources.length, total_ms: totalMs,
    ...(ok ? {} : { status: "error" }) });
  return { ok, leg: deps.leg, week: deps.week, receipt, proposals: landed, postedTexts, totalMs };
}
