/**
 * The audit chain walker (DF5.3).
 *
 * Ten typed hops per contributing runId (story Technical Notes hop table,
 * DD-8). The walker resolves records its predecessors already wrote, appends
 * first-observation digest rows for the three authorizing records (hops 1, 7,
 * 8 — story "Digest coverage is asymmetric") and never creates, migrates or
 * re-runs anything it audits. The only store it writes is `audit_links`,
 * append-only (INV-AUDIT-4); the only network it touches is the single GitHub
 * PR read at hop 1 — and only when the ref is a PR URL or a branch (hop 1
 * resolves locally from `extensions.pr` on a runId ref).
 *
 * Store discipline: the walk opens through `openAuditStoreForWalk` (no-create
 * probe, inode-verified attach, schema asserted) and — only after that open
 * has PROVEN the store exists — a lazily-opened writer on the SAME path
 * appends the digest rows via `record()`'s ON CONFLICT DO NOTHING. An absent
 * store therefore refuses on hops 4/5/6 as typed broken hops and the walk
 * never materialises a file (INV-AUDIT-6).
 *
 * Hop subjects and digests (BINDING):
 *  - hop 1 digests the `extensions.pr` ENTRY alone; subject_id = prUrl
 *  - hop 7 digests the bound `ReverifyReport` object; subject_id = reverifyId
 *  - hop 8 digests the `extensions.approval` ENTRY alone; subject_id =
 *    `approverId@decidedAt` (the composite, not headSha: two approvals of one
 *    head must not collide on the walker's UNIQUE key)
 *  - hops 4/5/6 carry emitted rows; the walker re-canonicalises each row's
 *    `detail_json` and compares against the row's `evidence_digest` (emitter
 *    convention: digest of exactly the object handed as `detail`; a row
 *    emitted without detail digests canonicalised null). Hop 6 additionally
 *    compares the bundle file's sha256 against the bundle-verify row's
 *    `detail_json.sha256` when that field is present.
 *
 * The harvested trace DB is read through a private temp-dir copy — NEVER in
 * place (hot WAL, no shm). The exact path `trace/trace.db` is resolved, never
 * globbed: the artifacts root also carries a decoy root-level `trace.db` with
 * no `gate_results` (story Technical Notes — the `trace/` prefix is
 * load-bearing).
 */

import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Database } from "bun:sqlite";

import { EXEC_MAX_OUTPUT_BYTES, readBounded } from "../providers/bounded-exec.ts";
import { CostLedger, DEFAULT_COST_LEDGER_FILE } from "../providers/cost-ledger.ts";
import { resolveRunsDir, RunRecordStore, type RunRecord } from "../providers/run-record.ts";
import { DEFAULT_REVERIFY_DIR, readReports, reportPath, type ReverifyReport } from "../reverify/report.ts";
import { log, newRequestId } from "../swarmclaw/log.ts";
import { OQ4_VOID_REASON } from "./index.ts";
import {
  type AuditHop,
  type AuditLinkRow,
  type AuditStoreReader,
  type AuditStoreWriter,
  AuditStoreError,
  canonicalJson,
  DEFAULT_AUDIT_DB_FILE,
  openAuditStore,
  openAuditStoreForWalk,
  sha256Hex,
  WALK_OBSERVED_EVENT,
} from "./link-store.ts";

export type HopName = AuditHop;

export type HopOutcome =
  | { status: "resolved"; hop: HopName; runId: string; subjectId: string; evidencePath?: string; evidenceDigest?: string; linkId?: number; evidence?: { kind: "claim" }; detail?: unknown }
  | { status: "void"; hop: HopName; reason: string }
  | { status: "not-applicable"; hop: HopName; reason: string }
  | { status: "evidence-not-harvested"; hop: HopName; reason: string; evidencePath: string }
  | { status: "unlinked"; hop: HopName; emitter: string; diagnostic: string }
  | { status: "evidence-mismatch"; hop: HopName; expectedDigest: string; actualDigest: string; evidencePath: string }
  | { status: "order-violation"; hop: HopName; constraint: string; earlier: string; later: string }
  | { status: "hop-timeout"; hop: HopName; ceilingMs: number; elapsedMs: number }
  | { status: "broken"; hop: HopName; expected: string; actual: string; diagnostic: string; evidencePath?: string };

export interface RunChain {
  runId: string;
  complete: boolean;
  hops: Record<HopName, HopOutcome>;
}

export interface ChainReport {
  ref: string;
  refKind: "pr-url" | "branch" | "run-id";
  generatedAt: string;
  complete: boolean;
  timings: { prFetchMs: number; perHopMs: Record<string, number> };
  /** Keyed by contributing runId; EXACTLY one key (the parent run) in this story. */
  runs: Record<string, RunChain>;
}

export interface WalkOptions {
  runsDir?: string;
  auditDb?: string;
  ledger?: string;
  reverifyDir?: string;
  now?: () => Date;
  /** Hop-1 GitHub read seam (tests). Production default: `gh pr view`. */
  fetchPull?: (ref: string) => Promise<{ body: string; headRef?: string; prUrl: string }>;
  /** Per-hop ceiling override for tests; default 3 s, total walk ceiling 30 s. */
  hopCeilingMs?: number;
}

export const DEFAULT_HOP_CEILING_MS = 3_000;
const TOTAL_CEILING_MS = 30_000;
const DIAGNOSTIC_MAX_CHARS = 2_000;
const GATE_ROWS_IN_DETAIL = 50;

/** AC5's exact `not-applicable` reason for the box-lifecycle reap sub-event. */
export const REAP_NOT_APPLICABLE_REASON =
  "record closed through teardownSandbox; the reaper collects only unowned units (the RowClass union)";
/** AC2's exact `not-applicable` reason for a NULL issue correlation on a runId-rooted walk. */
const BARE_RUN_NULL_CORRELATION_REASON = "bare run carries no issue correlation (DF1.8 nullability)";
const AUTHORIZATION_CONSTRAINT =
  "reverify.completedAt < approval.decidedAt < pr.createdAt (strict; equality violates)";
const HOPS: readonly HopName[] = [
  "pr-run", "run-issue", "run-cost", "run-credential", "run-box",
  "run-bundle", "run-reverify", "run-approval", "run-gate-evidence", "memory-retain-receipt",
];

export type ChainWalkErrorCode = "invalid-ref" | "pr-fetch-failed";

export class ChainWalkError extends Error {
  readonly code: ChainWalkErrorCode;
  readonly remediation: string;
  constructor(code: ChainWalkErrorCode, message: string, remediation: string) {
    super(message);
    this.name = "ChainWalkError";
    this.code = code;
    this.remediation = remediation;
  }
}

const PR_URL_RE = /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)\/?$/;
const BRANCH_RE = /^qds\/([a-z0-9][a-z0-9-]*)$/;
const RUN_ID_FORM_RE = /^[a-z0-9][a-z0-9-]*$/;

interface ParsedRef {
  refKind: "pr-url" | "branch" | "run-id";
  prUrl?: string;
  prNumber?: number;
  owner?: string;
  repo?: string;
  runId?: string;
}

function parseRef(ref: string): ParsedRef {
  const pr = PR_URL_RE.exec(ref);
  if (pr) return { refKind: "pr-url", prUrl: ref, owner: pr[1], repo: pr[2], prNumber: Number(pr[3]) };
  const branch = BRANCH_RE.exec(ref);
  if (branch) return { refKind: "branch", runId: branch[1] };
  if (RUN_ID_FORM_RE.test(ref)) return { refKind: "run-id", runId: ref };
  throw new ChainWalkError(
    "invalid-ref",
    `${JSON.stringify(ref)} is not a PR URL (https://github.com/{owner}/{repo}/pull/{n}), a qds/{runId} branch, or a bare runId`,
    "pass the merged PR URL, its qds/<run-id> branch, or the bare run id",
  );
}

/**
 * Production hop-1 read: `gh pr view`. gh carries the host auth itself; the
 * walker never reads a token, so none can reach a diagnostic (INV-AUDIT-2).
 */
async function ghFetchPull(ref: string): Promise<{ body: string; headRef?: string; prUrl: string }> {
  const parsed = parseRef(ref);
  const target =
    parsed.refKind === "pr-url"
      ? [String(parsed.prNumber), "--repo", `${parsed.owner}/${parsed.repo}`]
      : [ref];
  const proc = Bun.spawn(["gh", "pr", "view", ...target, "--json", "body,headRefName,url"], {
    stdin: "ignore", stdout: "pipe", stderr: "pipe",
  });
  const [code, out] = await Promise.all([
    proc.exited,
    readBounded(proc.stdout, EXEC_MAX_OUTPUT_BYTES, { kill: () => proc.kill(9), exited: proc.exited }),
  ]);
  if (code !== 0) {
    throw new ChainWalkError(
      "pr-fetch-failed",
      `gh pr view failed for ${ref} (exit ${code})`,
      "authenticate gh (`gh auth status`), or invoke the walk with the bare runId form so hop 1 resolves locally from the run record's extensions.pr",
    );
  }
  const body = JSON.parse(out.text) as { body?: unknown; headRefName?: unknown; url?: unknown };
  return {
    body: typeof body.body === "string" ? body.body : "",
    headRef: typeof body.headRefName === "string" ? body.headRefName : undefined,
    prUrl: typeof body.url === "string" ? body.url : ref,
  };
}

const cap = (text: string): string =>
  text.length <= DIAGNOSTIC_MAX_CHARS ? text : `${text.slice(0, DIAGNOSTIC_MAX_CHARS - 1)}…`;
const digestOf = (value: unknown): string => sha256Hex(canonicalJson(value));
const msOf = (iso: string | undefined): number | undefined => {
  if (typeof iso !== "string") return undefined;
  const parsed = Date.parse(iso);
  return Number.isFinite(parsed) ? parsed : undefined;
};
/** INV-AUDIT-2: the hash and its 8-char prefix — never key material. */
function keyFields(keyHash: string | undefined): { keyHash?: string; keyHashPrefix?: string } {
  if (typeof keyHash !== "string" || keyHash.length === 0) return {};
  return { keyHash, keyHashPrefix: keyHash.slice(0, 8) };
}

interface TraceRow {
  id: number;
  gate: string | null;
  passed: number | null;
  phaseId: string | null;
  attempt: number | null;
}
type TraceRead =
  | { kind: "ok"; tracePath: string; session: { repoSlug: string | null; issueId: string | null } | null; gates: TraceRow[] }
  | { kind: "not-harvested"; evidencePath: string; reason: string }
  | { kind: "error"; evidencePath: string; message: string };

/** Hop outcomes that keep a chain complete (AC1). Everything else breaks it (INV-AUDIT-6). */
function breaksChain(out: HopOutcome): boolean {
  return !(out.status === "resolved" || out.status === "void" || out.status === "not-applicable");
}

function chainComplete(hops: Record<HopName, HopOutcome>): boolean {
  const values = Object.values(hops);
  // Never vacuous: a chain whose only resolving hops are void/not-applicable is broken.
  return !values.some(breaksChain) && values.some((h) => h.status === "resolved");
}

export function chainVerdict(report: ChainReport): { complete: boolean; brokenHops: HopOutcome[] } {
  const brokenHops = Object.values(report.runs).flatMap((run) => Object.values(run.hops).filter(breaksChain));
  const anyResolved = Object.values(report.runs).some((run) =>
    Object.values(run.hops).some((h) => h.status === "resolved"),
  );
  return { complete: brokenHops.length === 0 && anyResolved, brokenHops };
}

/** Lifecycle (event, emitter-name) tables for the two emitted multi-event hops. */
const CREDENTIAL_EVENTS: readonly (readonly [event: string, emitter: string])[] = [
  ["mint", "mintRunKey"], ["deliver", "deliverRunKey"], ["revoke", "revokeRunKey"], ["verify-revoked", "verifyRevoked"],
];
const BOX_EVENTS: readonly (readonly [event: string, emitter: string])[] = [
  ["create", "provisionAdmittedRun"], ["fill", "fillRun"], ["setup-gate", "setup-gate (dispatch)"], ["teardown", "teardownSandbox"],
];

/** Non-decreasing (`≤`) lifecycle ordering over occurred_at; equality is legal (AC7). */
function firstOrderViolation(rows: readonly AuditLinkRow[]): [earlier: string, later: string] | undefined {
  for (let i = 1; i < rows.length; i++) {
    const prev = msOf(rows[i - 1]?.occurredAt);
    const cur = msOf(rows[i]?.occurredAt);
    if (prev === undefined || cur === undefined) continue;
    if (cur < prev) return [rows[i - 1]?.occurredAt ?? "", rows[i]?.occurredAt ?? ""];
  }
  return undefined;
}

/** The emitted rows' self-consistency: digest of the re-canonicalised detail_json. */
function firstDigestMismatch(rows: readonly AuditLinkRow[], fallbackPath: string): HopOutcome | undefined {
  for (const row of rows) {
    const recomputed = digestOf(row.detail ?? null);
    if (recomputed !== row.evidenceDigest) {
      return { status: "evidence-mismatch", hop: row.hop, expectedDigest: row.evidenceDigest, actualDigest: recomputed, evidencePath: row.evidencePath ?? fallbackPath };
    }
  }
  return undefined;
}

function rowsByEvent(links: readonly AuditLinkRow[], hop: HopName): Map<string, AuditLinkRow> {
  return new Map(links.filter((r) => r.hop === hop).map((r) => [r.event, r]));
}

// ---------------------------------------------------------------------------
// The walk
// ---------------------------------------------------------------------------

export async function walkAuditChain(ref: string, opts: WalkOptions = {}): Promise<ChainReport> {
  const startedAt = Date.now();
  const walkRequestId = newRequestId();
  const now = () => (opts.now ? opts.now() : new Date());
  const ceiling = opts.hopCeilingMs ?? DEFAULT_HOP_CEILING_MS;
  const parsed = parseRef(ref);
  const runsDir = opts.runsDir !== undefined ? opts.runsDir : resolveRunsDir();
  const auditDb = opts.auditDb ?? process.env.QDS_AUDIT_DB ?? DEFAULT_AUDIT_DB_FILE;
  const ledgerPath = opts.ledger ?? process.env.QDS_COST_LEDGER_FILE ?? DEFAULT_COST_LEDGER_FILE;
  const reverifyDir = opts.reverifyDir ?? DEFAULT_REVERIFY_DIR;
  const recordStore = new RunRecordStore({ dir: runsDir, create: false });

  const perHopMs: Record<string, number> = {};
  let prFetchMs = 0;

  // Shared state, resolved once across the hops that need it.
  let runId: string | null = parsed.runId ?? null;
  let record: RunRecord | undefined;
  let recordError: string | undefined;
  let prEntry: Record<string, unknown> | undefined;
  let prUrl: string | undefined;
  let auditReader: AuditStoreReader | undefined;
  let auditRefusal: AuditStoreError | undefined;
  let auditWriter: AuditStoreWriter | undefined;
  let trace: TraceRead | undefined;
  let boundReport: ReverifyReport | undefined;

  const recordPath = (): string => join(runsDir, `${runId ?? ""}.json`);
  const artifactsDir = (): string => (runId ? join(runsDir, `${runId}-artifacts`) : "");
  const bundlePath = (): string => (runId ? join(runsDir, `${runId}.bundle`) : "");

  const hopLine = (hop: HopName, outcome: HopOutcome, durationMs: number, key: string, repoSlug: string): void => {
    try {
      log({
        requestId: walkRequestId,
        operation: "audit-chain.hop",
        agentId: null,
        timestamp: now().toISOString(),
        duration: durationMs,
        status: breaksChain(outcome) ? "error" : "ok",
        runId: key, repoSlug, hop,
        durationMs,
        outcome: outcome.status,
        message: `hop ${hop} → ${outcome.status}`,
      });
    } catch {
      // a failing log sink must never fail the walk
    }
  };

  const readRecord = (): void => {
    if (record !== undefined || recordError !== undefined || runId === null) return;
    try {
      record = recordStore.get(runId);
    } catch (e) {
      recordError = cap((e as Error).message);
    }
  };

  const openAudit = (): void => {
    if (auditReader !== undefined || auditRefusal !== undefined) return;
    try {
      auditReader = openAuditStoreForWalk(auditDb);
    } catch (e) {
      if (e instanceof AuditStoreError) auditRefusal = e;
      else auditRefusal = new AuditStoreError("audit-store-absent", cap((e as Error).message), "inspect the audit store path");
    }
  };

  /** Lazily-opened writer on the SAME path the walk already proved exists. */
  const digestWriter = (): AuditStoreWriter | undefined => {
    if (auditWriter !== undefined || auditRefusal !== undefined) return auditWriter;
    const requestId = record?.requestId;
    if (typeof requestId !== "string" || requestId.length === 0) return undefined;
    try {
      auditWriter = openAuditStore(auditDb);
    } catch {
      auditWriter = undefined; // refusal already reported on hops 4/5/6
    }
    return auditWriter;
  };

  const repoSlugFor = (): string => {
    const budget = record?.extensions?.budget as Record<string, unknown> | undefined;
    const fromBudget = typeof budget?.repoSlug === "string" ? budget.repoSlug : undefined;
    if (fromBudget !== undefined && fromBudget.length > 0) return fromBudget;
    const session = trace?.kind === "ok" ? trace.session?.repoSlug : undefined;
    if (typeof session === "string" && session.length > 0) return session;
    if (parsed.owner !== undefined && parsed.repo !== undefined) return `${parsed.owner}/${parsed.repo}`;
    const fromUrl = prUrl !== undefined ? PR_URL_RE.exec(prUrl) : undefined;
    if (fromUrl) return `${fromUrl[1]}/${fromUrl[2]}`;
    return "unknown";
  };

  /**
   * First-observation digest for hops 1/7/8: compare the stored digest, else
   * insert (ON CONFLICT DO NOTHING via record()). A store refusal is reported
   * on hops 4/5/6, not here — the hop itself resolved from files.
   */
  const authorizingDigest = (
    hop: HopName, subjectId: string, subject: unknown, evidencePath: string, subjectKind: string,
  ): HopOutcome | undefined => {
    openAudit();
    if (auditReader === undefined || runId === null) return undefined;
    const digest = digestOf(subject);
    const existing = auditReader
      .linksForRun(runId)
      .find((r) => r.hop === hop && r.event === WALK_OBSERVED_EVENT && r.subjectId === subjectId);
    if (existing !== undefined) {
      if (existing.evidenceDigest !== digest) {
        return { status: "evidence-mismatch", hop, expectedDigest: existing.evidenceDigest, actualDigest: digest, evidencePath };
      }
      return undefined;
    }
    readRecord();
    const requestId = record?.requestId;
    const repoSlug = repoSlugFor();
    if (typeof requestId !== "string" || requestId.length === 0 || repoSlug.length === 0 || repoSlug === "unknown") {
      return undefined;
    }
    const writer = digestWriter();
    if (writer === undefined) return undefined;
    const stamp = now().toISOString();
    try {
      writer.record({
        runId, repoSlug, requestId, hop, event: WALK_OBSERVED_EVENT,
        subjectId, subjectKind, evidencePath, evidenceDigest: digest, occurredAt: stamp, recordedAt: stamp,
      });
    } catch {
      // A refused digest row (e.g. past the 8 KiB detail cap — not possible here,
      // no detail is written) must not turn a resolved hop into a walk failure.
    }
    return undefined;
  };

  const readTrace = (): TraceRead => {
    if (trace !== undefined) return trace;
    if (!existsSync(artifactsDir())) {
      trace = {
        kind: "not-harvested", evidencePath: artifactsDir(),
        reason: `no artifacts directory at ${artifactsDir()} — the artifacts pull never landed (DF2.5's non-fatal teardown arm) or the box rebooted before harvest`,
      };
      return trace;
    }
    // The `trace/` prefix is resolved EXACTLY, never globbed: the artifacts
    // root also carries the checkout's own root-level trace.db (no
    // gate_results) — resolving that decoy would read the wrong store.
    const tracePath = join(artifactsDir(), "trace", "trace.db");
    if (!existsSync(tracePath)) {
      trace = { kind: "not-harvested", evidencePath: artifactsDir(), reason: `no harvested trace at ${tracePath}` };
      return trace;
    }
    // Private temp-dir copy: trace.db + trace.db-wal (if present), NEVER the
    // -shm; opened read-write so SQLite recovers the WAL. The artifacts
    // directory is never written; the temp dir dies in the finally.
    const tmp = mkdtempSync(join(tmpdir(), "qds-audit-trace-"));
    try {
      const copyPath = join(tmp, "trace.db");
      copyFileSync(tracePath, copyPath);
      const walPath = `${tracePath}-wal`;
      if (existsSync(walPath)) copyFileSync(walPath, `${copyPath}-wal`);
      const db = new Database(copyPath);
      try {
        db.exec("PRAGMA busy_timeout = 5000;");
        readRecord();
        const requestId = record?.requestId;
        const sessionRow =
          typeof requestId === "string" && requestId.length > 0
            ? (db.prepare("SELECT repo_slug, issue_id FROM sessions WHERE request_id = ?").get(requestId) as
                { repo_slug: string | null; issue_id: number | string | null } | null | undefined)
            : undefined;
        const gateRows =
          typeof requestId === "string" && requestId.length > 0
            ? (db.prepare("SELECT id, gate, passed, phase_id, attempt FROM gate_results WHERE request_id = ? ORDER BY id").all(requestId) as Record<string, unknown>[])
            : [];
        trace = {
          kind: "ok",
          tracePath,
          session:
            sessionRow === null || sessionRow === undefined
              ? null
              : {
                  repoSlug: typeof sessionRow.repo_slug === "string" ? sessionRow.repo_slug : null,
                  issueId: sessionRow.issue_id === null || sessionRow.issue_id === undefined ? null : String(sessionRow.issue_id),
                },
          gates: gateRows.map((r) => ({
            id: Number(r.id),
            gate: typeof r.gate === "string" ? r.gate : null,
            passed: r.passed === null || r.passed === undefined ? null : Number(r.passed),
            phaseId: typeof r.phase_id === "string" ? r.phase_id : null,
            attempt: r.attempt === null || r.attempt === undefined ? null : Number(r.attempt),
          })),
        };
      } finally {
        db.close();
      }
    } catch (e) {
      trace = { kind: "error", evidencePath: tracePath, message: cap((e as Error).message) };
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
    return trace;
  };

  const recordBroken = (hop: HopName): HopOutcome => ({
    status: "broken", hop,
    expected: `run record at ${recordPath()}`,
    actual: recordError ?? "absent",
    diagnostic: "every record-joined hop needs the run record; an unreadable record is a named broken hop, never a skipped one",
    evidencePath: recordPath(),
  });

  // ── hop bodies 4–9 (closures over the shared state above) ──

  function hop4credential(): HopOutcome {
    const rid = runId as string;
    openAudit();
    if (auditRefusal !== undefined) {
      return { status: "broken", hop: "run-credential", expected: "a readable audit-link store", actual: auditRefusal.code, diagnostic: cap(auditRefusal.message), evidencePath: auditDb };
    }
    const byEvent = rowsByEvent(auditReader?.linksForRun(rid) ?? [], "run-credential");
    const missing = CREDENTIAL_EVENTS.filter(([ev]) => !byEvent.has(ev));
    if (missing.length > 0) {
      return { status: "unlinked", hop: "run-credential", emitter: missing.map(([, em]) => em).join(", "), diagnostic: `no audit_links row for run-credential event(s) ${missing.map(([ev]) => ev).join(", ")} — links are emitted at the event, never inferred (INV-AUDIT-4)` };
    }
    const ordered = CREDENTIAL_EVENTS.map(([ev]) => byEvent.get(ev) as AuditLinkRow);
    const mismatch = firstDigestMismatch(ordered, auditDb);
    if (mismatch !== undefined) return mismatch;
    const violation = firstOrderViolation(ordered);
    if (violation !== undefined) {
      return { status: "order-violation", hop: "run-credential", constraint: "mint <= deliver <= revoke <= verify-revoked (non-decreasing)", earlier: violation[0], later: violation[1] };
    }
    const keyHash = record?.keyHash ?? (ordered[0]?.detail as { keyHash?: unknown } | null | undefined)?.keyHash;
    const hash = typeof keyHash === "string" ? keyHash : undefined;
    return {
      status: "resolved", hop: "run-credential", runId: rid,
      subjectId: hash ?? ordered[0]?.subjectId ?? rid,
      evidencePath: ordered[0]?.evidencePath, linkId: ordered[0]?.linkId,
      ...keyFields(hash),
      detail: {
        ...keyFields(hash),
        events: Object.fromEntries(CREDENTIAL_EVENTS.map(([ev]) => [ev, { occurredAt: byEvent.get(ev)?.occurredAt, linkId: byEvent.get(ev)?.linkId }])),
        linkIds: Object.fromEntries(CREDENTIAL_EVENTS.map(([ev]) => [ev, byEvent.get(ev)?.linkId])),
      },
    };
  }

  function hop5box(): HopOutcome {
    const rid = runId as string;
    openAudit();
    if (auditRefusal !== undefined) {
      return { status: "broken", hop: "run-box", expected: "a readable audit-link store", actual: auditRefusal.code, diagnostic: cap(auditRefusal.message), evidencePath: auditDb };
    }
    const byEvent = rowsByEvent(auditReader?.linksForRun(rid) ?? [], "run-box");
    const missing = BOX_EVENTS.filter(([ev]) => !byEvent.has(ev));
    if (missing.length > 0) {
      return { status: "unlinked", hop: "run-box", emitter: missing.map(([, em]) => em).join(", "), diagnostic: `no audit_links row for run-box event(s) ${missing.map(([ev]) => ev).join(", ")} — links are emitted at the event, never synthesized from end state (INV-AUDIT-4)` };
    }
    // reap: an emitted link resolves as emitted; on the ordinary path a closed
    // record (torn down through teardownSandbox, no VM left) is the canonical
    // not-applicable; an open record with no reap link is an uncollected run.
    const reapRow = byEvent.get("reap");
    const closedAt = record?.closedAt;
    const reap: Record<string, unknown> =
      reapRow !== undefined
        ? { status: "resolved", occurredAt: reapRow.occurredAt, linkId: reapRow.linkId }
        : { status: "not-applicable", reason: REAP_NOT_APPLICABLE_REASON };
    if (reapRow === undefined && typeof closedAt !== "string") {
      return { status: "unlinked", hop: "run-box", emitter: "sweep", diagnostic: "the record is open and no reap link exists — the reaper never collected this run" };
    }
    const lifecycle = (reapRow !== undefined ? [...BOX_EVENTS.map(([ev]) => ev), "reap"] : BOX_EVENTS.map(([ev]) => ev))
      .map((ev) => byEvent.get(ev) as AuditLinkRow);
    const mismatch = firstDigestMismatch(lifecycle, auditDb);
    if (mismatch !== undefined) return mismatch;
    const violation = firstOrderViolation(lifecycle);
    if (violation !== undefined) {
      return { status: "order-violation", hop: "run-box", constraint: `create <= fill <= setup-gate <= teardown${reapRow !== undefined ? " <= reap" : ""} (non-decreasing)`, earlier: violation[0], later: violation[1] };
    }
    return {
      status: "resolved", hop: "run-box", runId: rid,
      subjectId: lifecycle[0]?.subjectId ?? rid,
      evidencePath: lifecycle[0]?.evidencePath, linkId: lifecycle[0]?.linkId,
      detail: {
        closedAt, vmName: record?.vmName,
        events: Object.fromEntries([
          ...BOX_EVENTS.map(([ev]) => [ev, { occurredAt: byEvent.get(ev)?.occurredAt, linkId: byEvent.get(ev)?.linkId }]),
          ["reap", reap],
        ]),
      },
    };
  }

  function hop6bundle(): HopOutcome {
    const rid = runId as string;
    openAudit();
    if (auditRefusal !== undefined) {
      return { status: "broken", hop: "run-bundle", expected: "a readable audit-link store", actual: auditRefusal.code, diagnostic: cap(auditRefusal.message), evidencePath: auditDb };
    }
    const path = bundlePath();
    if (!existsSync(path)) {
      return { status: "evidence-not-harvested", hop: "run-bundle", reason: `no bundle at ${path} — harvestRun's verify/fetch steps never produced it (a lawful post-harvest deletion, or a noHarvest teardown with no earlier harvestRun)`, evidencePath: path };
    }
    const byEvent = rowsByEvent(auditReader?.linksForRun(rid) ?? [], "run-bundle");
    const verifyRow = byEvent.get("bundle-verify");
    const fetchRow = byEvent.get("bundle-fetch");
    if (verifyRow === undefined) {
      return { status: "unlinked", hop: "run-bundle", emitter: "harvestRun (bundle-verify)", diagnostic: "the bundle exists but no bundle-verify link row was emitted at harvest time" };
    }
    if (fetchRow === undefined) {
      return { status: "unlinked", hop: "run-bundle", emitter: "harvestRun (bundle-fetch)", diagnostic: "bundle-verify is linked but bundle-fetch was never emitted" };
    }
    const mismatch = firstDigestMismatch([verifyRow, fetchRow], path);
    if (mismatch !== undefined) return mismatch;
    const bytes = readFileSync(path);
    const actualDigest = sha256Hex(bytes.toString("latin1"));
    const claimed = (verifyRow.detail as { sha256?: unknown } | null | undefined)?.sha256;
    if (typeof claimed === "string" && claimed !== actualDigest) {
      return { status: "evidence-mismatch", hop: "run-bundle", expectedDigest: claimed, actualDigest, evidencePath: path };
    }
    const verifyMs = msOf(verifyRow.occurredAt);
    const fetchMs = msOf(fetchRow.occurredAt);
    if (verifyMs !== undefined && fetchMs !== undefined && fetchMs < verifyMs) {
      return { status: "order-violation", hop: "run-bundle", constraint: "bundle-verify <= bundle-fetch (non-decreasing)", earlier: verifyRow.occurredAt, later: fetchRow.occurredAt };
    }
    return {
      status: "resolved", hop: "run-bundle", runId: rid,
      subjectId: verifyRow.subjectId ?? rid,
      evidencePath: path, evidenceDigest: verifyRow.evidenceDigest, linkId: verifyRow.linkId,
      detail: { sha256: actualDigest, bundleBytes: bytes.byteLength, linkIds: { "bundle-verify": verifyRow.linkId, "bundle-fetch": fetchRow.linkId } },
    };
  }

  function hop7reverify(): HopOutcome {
    const rid = runId as string;
    readRecord();
    if (recordError !== undefined) return recordBroken("run-reverify");
    const approval = record?.extensions?.approval as Record<string, unknown> | undefined;
    const reportId = typeof approval?.reportId === "string" ? approval.reportId : undefined;
    const path = reportPath(reverifyDir, rid);
    if (reportId === undefined) {
      return { status: "broken", hop: "run-reverify", expected: "extensions.approval.reportId naming the bound ReverifyReport", actual: "no approval binding", diagnostic: `hop 7 resolves the BOUND report in ${path} — never the last line`, evidencePath: path };
    }
    const superseded = approval?.supersededReportIds;
    if (Array.isArray(superseded) && superseded.includes(reportId)) {
      return { status: "broken", hop: "run-reverify", expected: `report ${reportId} to be the bound, non-superseded subject`, actual: "the id appears in extensions.approval.supersededReportIds", diagnostic: `a superseded report is never the subject (${path})`, evidencePath: path };
    }
    const reports = readReports(reverifyDir, rid);
    const bound = reports.find((r) => r.reverifyId === reportId);
    if (bound === undefined) {
      return { status: "broken", hop: "run-reverify", expected: `ReverifyReport ${reportId}`, actual: `${reports.length} report(s) at ${path}, none with that id`, diagnostic: "a reportId resolving to no line cannot authorize anything; the in-box gate results are a claim, never authority (INV-AUDIT-5)", evidencePath: path };
    }
    boundReport = bound;
    const mismatch = authorizingDigest("run-reverify", reportId, bound, path, "reverify-report");
    if (mismatch !== undefined) return mismatch;
    return {
      status: "resolved", hop: "run-reverify", runId: rid, subjectId: reportId,
      evidencePath: path, evidenceDigest: digestOf(bound),
      detail: { verdict: bound.verdict, completedAt: bound.completedAt, headSha: bound.headSha, testResults: bound.testResults },
    };
  }

  function hop8approval(): HopOutcome {
    const rid = runId as string;
    readRecord();
    if (recordError !== undefined) return recordBroken("run-approval");
    const approval = record?.extensions?.approval as Record<string, unknown> | undefined;
    if (approval === undefined || typeof approval !== "object") {
      // INV-PR-5: no PR exists without an approval, so on a PR-bearing walk an
      // absent approval is broken — never not-applicable (AC5).
      return { status: "broken", hop: "run-approval", expected: "extensions.approval (approverId, decidedAt, reportId, headSha)", actual: "no approval entry", diagnostic: "INV-PR-5: no PR without an approval — an absent approval on a PR-bearing run is a broken hop", evidencePath: recordPath() };
    }
    const approverId = typeof approval.approverId === "string" ? approval.approverId : undefined;
    const decidedAt = typeof approval.decidedAt === "string" ? approval.decidedAt : undefined;
    if (approverId === undefined || decidedAt === undefined) {
      return { status: "broken", hop: "run-approval", expected: "approverId and decidedAt", actual: JSON.stringify(Object.keys(approval)), diagnostic: "an approval without a decision cannot authorize the PR", evidencePath: recordPath() };
    }
    // The authorization chain is STRICT (AC7): equality is a violation.
    const completedMs = msOf(boundReport?.completedAt);
    const decidedMs = msOf(decidedAt);
    const prCreatedAt = typeof prEntry?.createdAt === "string" ? prEntry.createdAt : undefined;
    const prCreatedMs = msOf(prCreatedAt);
    if (completedMs !== undefined && decidedMs !== undefined && prCreatedMs !== undefined) {
      // Constraint A < B violated ⇒ B is the event that wrongly did not follow A.
      if (!(completedMs < decidedMs)) {
        return { status: "order-violation", hop: "run-approval", constraint: AUTHORIZATION_CONSTRAINT, earlier: decidedAt, later: boundReport?.completedAt as string };
      }
      if (!(decidedMs < prCreatedMs)) {
        return { status: "order-violation", hop: "run-approval", constraint: AUTHORIZATION_CONSTRAINT, earlier: prCreatedAt as string, later: decidedAt };
      }
    }
    const subjectId = `${approverId}@${decidedAt}`;
    const mismatch = authorizingDigest("run-approval", subjectId, approval, recordPath(), "run-record.approval");
    if (mismatch !== undefined) return mismatch;
    return {
      status: "resolved", hop: "run-approval", runId: rid, subjectId,
      evidencePath: recordPath(), evidenceDigest: digestOf(approval),
      detail: { approverId, decidedAt, reportId: approval.reportId, headSha: approval.headSha },
    };
  }

  function hop9gateEvidence(): HopOutcome {
    const rid = runId as string;
    readRecord();
    if (recordError !== undefined) return recordBroken("run-gate-evidence");
    const requestId = record?.requestId;
    if (typeof requestId !== "string" || requestId.length === 0) {
      return { status: "broken", hop: "run-gate-evidence", expected: "record.requestId", actual: "absent", diagnostic: "gate_results joins on request_id", evidencePath: recordPath() };
    }
    const t = readTrace();
    if (t.kind === "not-harvested") return { status: "evidence-not-harvested", hop: "run-gate-evidence", reason: t.reason, evidencePath: t.evidencePath };
    if (t.kind === "error") {
      return { status: "broken", hop: "run-gate-evidence", expected: `gate_results rows for ${requestId}`, actual: t.message, diagnostic: "the harvested trace could not be opened through its temp-dir copy", evidencePath: t.evidencePath };
    }
    if (t.gates.length === 0) {
      return { status: "broken", hop: "run-gate-evidence", expected: `gate_results rows for ${requestId}`, actual: "none", diagnostic: "a run with no gate evidence is not a run this chain vouches for", evidencePath: t.tracePath };
    }
    return {
      status: "resolved", hop: "run-gate-evidence", runId: rid, subjectId: requestId,
      evidencePath: t.tracePath, evidence: { kind: "claim" },
      detail: { count: t.gates.length, rows: t.gates.slice(0, GATE_ROWS_IN_DETAIL) },
    };
  }

  return await (async (): Promise<ChainReport> => {
    const outcomes: Partial<Record<HopName, HopOutcome>> = {};
    const timed = async (hop: HopName, fn: () => HopOutcome | Promise<HopOutcome>): Promise<void> => {
      if (Date.now() - startedAt > TOTAL_CEILING_MS) {
        perHopMs[hop] = 0;
        outcomes[hop] = { status: "hop-timeout", hop, ceilingMs: TOTAL_CEILING_MS, elapsedMs: Date.now() - startedAt };
        return;
      }
      const t0 = Date.now();
      let out: HopOutcome;
      try {
        out = await fn();
      } catch (e) {
        out = { status: "broken", hop, expected: "hop resolution", actual: cap((e as Error).message), diagnostic: `unhandled walk error at hop ${hop}` };
      }
      const elapsed = Date.now() - t0;
      perHopMs[hop] = elapsed;
      // AC4: a hop over its ceiling fails closed as hop-timeout, never resolved.
      if (elapsed > ceiling) out = { status: "hop-timeout", hop, ceilingMs: ceiling, elapsedMs: elapsed };
      outcomes[hop] = out;
    };

    // ── hop 1: ref → PR → contributing runId ──
    await timed("pr-run", async (): Promise<HopOutcome> => {
      if (parsed.refKind === "run-id") {
        readRecord();
        const ext = record?.extensions as Record<string, Record<string, unknown>> | undefined;
        prEntry = ext?.pr;
        prUrl = typeof prEntry?.prUrl === "string" ? prEntry.prUrl : undefined;
        if (prUrl === undefined) {
          return { status: "broken", hop: "pr-run", expected: "extensions.pr.prUrl in the run record", actual: "no pr entry", diagnostic: `the runId form resolves hop 1 locally from ${recordPath()} — zero network`, evidencePath: recordPath() };
        }
        const mismatch = authorizingDigest("pr-run", prUrl, prEntry, recordPath(), "run-record.pr");
        if (mismatch !== undefined) return mismatch;
        return { status: "resolved", hop: "pr-run", runId: runId as string, subjectId: prUrl, evidencePath: recordPath(), evidenceDigest: digestOf(prEntry), detail: prEntry };
      }
      const fetchStart = Date.now();
      const pull = await (opts.fetchPull ?? ghFetchPull)(ref);
      prFetchMs = Date.now() - fetchStart;
      prUrl = pull.prUrl;
      const head = pull.headRef;
      const branch = head !== undefined ? BRANCH_RE.exec(head) : null;
      if (branch === null) {
        runId = null;
        return { status: "broken", hop: "pr-run", expected: "head branch qds/{runId}", actual: head === undefined ? "no headRef returned" : head, diagnostic: "the PR→run correlation needs the qds/{runId} head branch; without it no contributing runId exists", evidencePath: prUrl };
      }
      const branchRunId = branch[1];
      if (branchRunId === undefined) {
        runId = null;
        return { status: "broken", hop: "pr-run", expected: "head branch qds/{runId}", actual: head ?? "no headRef returned", diagnostic: "the qds/ head branch carried no runId; no contributing runId exists", evidencePath: prUrl };
      }
      runId = branchRunId;
      if (!pull.body.includes(branchRunId)) {
        return { status: "broken", hop: "pr-run", expected: `the contributing runId ${branchRunId} in the PR body`, actual: `absent from the ${pull.body.length}-char body`, diagnostic: `PR ${prUrl} does not name its run; the body is the run-correlation record (DF5.2)`, evidencePath: prUrl };
      }
      readRecord();
      const ext = record?.extensions as Record<string, Record<string, unknown>> | undefined;
      prEntry = ext?.pr;
      const digestOutcome = prEntry !== undefined ? authorizingDigest("pr-run", prUrl, prEntry, recordPath(), "run-record.pr") : undefined;
      if (digestOutcome !== undefined) return digestOutcome;
      return {
        status: "resolved", hop: "pr-run", runId: branchRunId, subjectId: prUrl,
        evidencePath: prEntry !== undefined ? recordPath() : prUrl,
        evidenceDigest: prEntry !== undefined ? digestOf(prEntry) : undefined,
        detail: { headRef: head, prEntrySet: prEntry !== undefined },
      };
    });

    // ── hops 2–9 (record-joined) — or broken when hop 1 named no runId ──
    if (runId === null) {
      for (const hop of HOPS.slice(1, 9)) {
        outcomes[hop] = { status: "broken", hop, expected: "a contributing runId", actual: "hop 1 resolved none", diagnostic: "no run to walk; fix hop 1 and re-run" };
      }
    } else {
      await timed("run-issue", (): HopOutcome => {
        readRecord();
        if (recordError !== undefined) return recordBroken("run-issue");
        const requestId = record?.requestId;
        if (typeof requestId !== "string" || requestId.length === 0) {
          return { status: "broken", hop: "run-issue", expected: "record.requestId", actual: "absent", diagnostic: "the runId→trace join key is missing from the record", evidencePath: recordPath() };
        }
        const t = readTrace();
        if (t.kind === "not-harvested") return { status: "evidence-not-harvested", hop: "run-issue", reason: t.reason, evidencePath: t.evidencePath };
        if (t.kind === "error") {
          return { status: "broken", hop: "run-issue", expected: `sessions row for ${requestId}`, actual: t.message, diagnostic: "the harvested trace could not be opened through its temp-dir copy", evidencePath: t.evidencePath };
        }
        if (t.session === null) {
          return { status: "broken", hop: "run-issue", expected: `sessions.request_id = ${requestId}`, actual: "no session row", diagnostic: "a runId with no session row is a broken correlation (AC2)", evidencePath: t.tracePath };
        }
        // Integer column vs string record value: String() the sessions side.
        if (t.session.repoSlug === null && t.session.issueId === null) {
          if (parsed.refKind === "run-id") {
            return { status: "not-applicable", hop: "run-issue", reason: BARE_RUN_NULL_CORRELATION_REASON };
          }
          return { status: "broken", hop: "run-issue", expected: "issue correlation on a PR-rooted walk", actual: "sessions.repo_slug and sessions.issue_id are NULL", diagnostic: "admission required the issue ref, so NULL correlation on a PR-bearing run cannot arise — fail closed", evidencePath: t.tracePath };
        }
        const budget = record?.extensions?.budget as Record<string, unknown> | undefined;
        const recordIssue = typeof budget?.issueId === "string" ? budget.issueId : undefined;
        if (recordIssue !== undefined && t.session.issueId !== null && recordIssue !== t.session.issueId) {
          return { status: "broken", hop: "run-issue", expected: `issue ${recordIssue} (record, canonicalised)`, actual: `issue ${t.session.issueId} (sessions INTEGER coerced via String())`, diagnostic: "the record and the trace disagree about the issue; identity is (repo_slug, issue_id), never the number alone (INV-AUDIT-1)", evidencePath: t.tracePath };
        }
        return {
          status: "resolved", hop: "run-issue", runId: runId as string,
          subjectId: `${t.session.repoSlug ?? "?"}#${t.session.issueId ?? "?"}`,
          evidencePath: t.tracePath,
          detail: { repoSlug: t.session.repoSlug, issueId: t.session.issueId, requestId },
        };
      });

      await timed("run-cost", (): HopOutcome => {
        let ledger: CostLedger | undefined;
        try {
          ledger = CostLedger.openReadOnly({ path: ledgerPath });
          const view = ledger.readRunCost(runId as string);
          if (!view.hasEvents) {
            return { status: "broken", hop: "run-cost", expected: "ledger rows for the run", actual: "hasEvents: false", diagnostic: "a run with no ledger rows was admitted by nothing and capped by nothing — never read as zero spend (DF5.4-C1)", evidencePath: ledgerPath };
          }
          return {
            status: "resolved", hop: "run-cost", runId: runId as string, subjectId: runId as string, evidencePath: ledgerPath,
            detail: {
              totalMicroUsd: view.totalMicroUsd, perRole: view.perRole, hasTokenRows: view.hasTokenRows,
              tokenTotals: view.tokenTotals, cacheTotals: view.cacheTotals, unpricedRows: view.unpricedRows, eventCount: view.eventCount,
            },
          };
        } catch (e) {
          const code = (e as { code?: string }).code ?? "ledger-unopenable";
          return { status: "broken", hop: "run-cost", expected: "a readable cost ledger", actual: code, diagnostic: cap((e as Error).message), evidencePath: ledgerPath };
        } finally {
          try { ledger?.close(); } catch { /* the read already happened or never started */ }
        }
      });

      await timed("run-credential", hop4credential);
      await timed("run-box", hop5box);
      await timed("run-bundle", hop6bundle);
      await timed("run-reverify", hop7reverify);
      await timed("run-approval", hop8approval);
      await timed("run-gate-evidence", hop9gateEvidence);
    }

    // ── hop 10: unconditional VOID (DD-4), excluded from the verdict ──
    outcomes["memory-retain-receipt"] = { status: "void", hop: "memory-retain-receipt", reason: OQ4_VOID_REASON };
    perHopMs["memory-retain-receipt"] = 0;

    const mapKey = runId ?? prUrl ?? ref;
    for (const hop of HOPS) {
      const out = outcomes[hop];
      if (out === undefined) {
        outcomes[hop] = { status: "broken", hop, expected: "a typed outcome", actual: "missing", diagnostic: "the walk produced no outcome for this hop" };
      }
      perHopMs[hop] = perHopMs[hop] ?? 0;
      hopLine(hop, outcomes[hop] as HopOutcome, perHopMs[hop] as number, mapKey, repoSlugFor());
    }

    const hops = Object.fromEntries(HOPS.map((h) => [h, outcomes[h] as HopOutcome])) as Record<HopName, HopOutcome>;
    const runChain: RunChain = { runId: mapKey, complete: chainComplete(hops), hops };
    if (auditWriter !== undefined) { try { auditWriter.close(); } catch { /* best-effort */ } }
    if (auditReader !== undefined) { try { auditReader.close(); } catch { /* best-effort */ } }
    return {
      ref, refKind: parsed.refKind, generatedAt: now().toISOString(),
      complete: runChain.complete, timings: { prFetchMs, perHopMs }, runs: { [mapKey]: runChain },
    };
  })();
}
