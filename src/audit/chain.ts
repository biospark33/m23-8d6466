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
 *  - hops 1/7/8 are SINGULAR: exactly one walk-observed row per (runId, hop)
 *    may ever exist. The prior row is therefore looked up by (runId, hop)
 *    ALONE, never by subject_id — a rewritten subject whose edit lands in the
 *    field that FORMS the subject id (`extensions.approval.approverId`, the
 *    bound `reportId`, the `prUrl`) would otherwise miss its own prior row,
 *    skip the digest comparison and append a second first-observation row.
 *    A rewritten subject reports `evidence-mismatch` naming BOTH subject ids;
 *    a rewrite that leaves the subject id intact reports the digest pair.
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

import { closeSync, copyFileSync, existsSync, mkdtempSync, openSync, readSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Database } from "bun:sqlite";

import { EXEC_MAX_OUTPUT_BYTES, readBounded } from "../providers/bounded-exec.ts";
import { CostLedger, DEFAULT_COST_LEDGER_FILE } from "../providers/cost-ledger.ts";
import { LEGACY_RUN_ID_RE, resolveRunsDir, RunRecordStore, RUN_ID_MAX, type RunRecord } from "../providers/run-record.ts";
import { redactSecrets } from "../providers/step-log.ts";
import { DEFAULT_REVERIFY_DIR, readReports, reportPath, type ReverifyReport } from "../reverify/report.ts";
import { log, newRequestId } from "../swarmclaw/log.ts";
import { OQ4_VOID_REASON } from "./index.ts";
import {
  type AuditHop,
  type AuditLinkRow,
  type AuditStoreWalkHandle,
  type AuditStoreWriter,
  AuditStoreError,
  canonicalJson,
  DEFAULT_AUDIT_DB_FILE,
  openAuditStoreForWalk,
  sha256Hex,
  WALK_OBSERVED_EVENT,
} from "./link-store.ts";

export type HopName = AuditHop;

export type HopOutcome =
  /** `keyHash`/`keyHashPrefix` are hop 4's only credential fields (INV-AUDIT-2: the hash and its prefix, never key material). Declared, not spread-smuggled. */
  | { status: "resolved"; hop: HopName; runId: string; subjectId: string; evidencePath?: string; evidenceDigest?: string; linkId?: number; evidence?: { kind: "claim" }; keyHash?: string; keyHashPrefix?: string; detail?: unknown }
  | { status: "void"; hop: HopName; reason: string }
  | { status: "not-applicable"; hop: HopName; reason: string }
  | { status: "evidence-not-harvested"; hop: HopName; reason: string; evidencePath: string }
  | { status: "unlinked"; hop: HopName; emitter: string; diagnostic: string }
  /**
   * `expectedSubjectId`/`actualSubjectId` are present ONLY on the rewritten-
   * subject arm of a singular hop (1/7/8): the prior walk observed one subject
   * id for this hop and the walk now sees another. On the ordinary digest arm
   * both are absent and the two digests are the whole diagnosis.
   */
  | { status: "evidence-mismatch"; hop: HopName; expectedDigest: string; actualDigest: string; evidencePath: string; expectedSubjectId?: string; actualSubjectId?: string }
  /**
   * CONSTRAINT ORDER, never observed order: `earlier` is the event the
   * constraint requires to come FIRST and `later` is the one required to come
   * second. On a violation the two stamps are therefore out of order relative
   * to each other — that is the report. (Hops 4/5/6 read them off the adjacent
   * lifecycle pair; hop 8 off the pair of the authorization constraint it
   * names.)
   */
  | { status: "order-violation"; hop: HopName; constraint: string; earlier: string; later: string }
  /** `budget` names WHICH ceiling was exhausted: the per-hop one (AC4's `ceilingMs`) or the whole-walk one. */
  | { status: "hop-timeout"; hop: HopName; ceilingMs: number; elapsedMs: number; budget: "hop" | "total" }
  | { status: "broken"; hop: HopName; expected: string; actual: string; diagnostic: string; evidencePath?: string };

export interface RunChain {
  /**
   * The contributing runId, or `null` when hop 1 resolved none. It is never a
   * PR url standing in for a run — the `ChainReport.runs` MAP KEY may be the PR
   * url or the raw ref in that case (it is a key, not a claim), but this field
   * only ever holds a real run id.
   */
  runId: string | null;
  complete: boolean;
  hops: Record<HopName, HopOutcome>;
}

export interface ChainReport {
  ref: string;
  refKind: "pr-url" | "branch" | "run-id";
  generatedAt: string;
  complete: boolean;
  /**
   * TWO spellings, deliberately. The TS type is camelCase because DF5.4-C9
   * imports it as an idiomatic type; the story's Observability Contract governs
   * the structured LOG LINE, where the same two numbers are `pr_fetch_ms` and
   * `per_hop_ms` (repo convention: `LogEntry`'s core fields are camelCase,
   * added metric fields are snake_case — `fill_ms`, `ingest_ms`, `log_read_ms`,
   * `duration_ms`). The hop line below emits `per_hop_ms`; the walk-level
   * `audit-chain.verdict` line in `scripts/qds-audit.ts` emits both.
   */
  timings: { prFetchMs: number; perHopMs: Record<string, number> };
  /**
   * Keyed by contributing runId; EXACTLY one key (the parent run) in this
   * story. When hop 1 resolved no runId the key falls back to the PR url and
   * then to the raw ref — a lookup key, never a claim that the run exists.
   */
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
  /**
   * The caller's correlation id, so a CLI invocation's own log lines and the
   * walk's `audit-chain.hop` lines join. Omitted → the walk mints its own.
   */
  requestId?: string;
}

export const DEFAULT_HOP_CEILING_MS = 3_000;
const TOTAL_CEILING_MS = 30_000;
const DIAGNOSTIC_MAX_CHARS = 2_000;
const GATE_ROWS_IN_DETAIL = 50;

/** AC5's exact `not-applicable` reason for the box-lifecycle reap sub-event. */
export const REAP_NOT_APPLICABLE_REASON =
  "record closed through teardownSandbox; the reaper collects only unowned units (the RowClass union)";
/**
 * Hop 2's reason when the harvested `sessions` row correlates nothing. The
 * string is the hop-2 table row's `not-applicable` outcome, byte-exact — NOT
 * AC2, which is the broken-correlation-key criterion and says nothing about
 * this shape.
 */
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
/**
 * The run-id FORM test — `run-record.ts`'s own admission rule, imported rather
 * than re-typed, so the walker and the store can never disagree about what a
 * run id is. It is deliberately WIDE (it admits `main`, `dev`, any lowercase
 * word): run ids are `<slug>-<YYYYMMDD>-<6 hex>` by construction but legacy
 * ids outside that shape exist on disk, so narrowing the regex would refuse
 * real runs. The ref kind is committed to only once the run RECORD exists —
 * see `assertRunIdRefResolves` — which is what turns an operator typo
 * (`qds-audit dev`) into the `invalid-ref` refusal with its remediation
 * instead of a ten-hop broken-chain report about a run that never existed.
 */
const RUN_ID_FORM_RE = LEGACY_RUN_ID_RE;
/**
 * The PR body must name its run as a WHOLE token. `body.includes(runId)` was a
 * bare substring test, and `BRANCH_RE` admits a one-character run id, so
 * `qds/a` made `"a"` match essentially any English PR body — and this body is
 * the walker's stated run-correlation record (DF5.2). The delimiter class is
 * stricter than `\b`: a hyphen counts as part of the token, so
 * `not-qds-20260916-a1b2c3-either` does not match `qds-20260916-a1b2c3`. The
 * `qds/<runId>` branch form the body is supposed to name satisfies it too (the
 * `/` is a delimiter).
 */
function bodyNamesRun(body: string, runId: string): boolean {
  const escaped = runId.replace(/[.*+?^${}()|[\]\\-]/g, "\\$&");
  return new RegExp(`(^|[^A-Za-z0-9_-])${escaped}($|[^A-Za-z0-9_-])`).test(body);
}

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
  if (ref.length <= RUN_ID_MAX && RUN_ID_FORM_RE.test(ref)) return { refKind: "run-id", runId: ref };
  throw new ChainWalkError(
    "invalid-ref",
    `${JSON.stringify(ref)} is not a PR URL (https://github.com/{owner}/{repo}/pull/{n}), a qds/{runId} branch, or a bare runId`,
    "pass the merged PR URL, its qds/<run-id> branch, or the bare run id",
  );
}

/**
 * The second half of the `run-id` ref decision (see `RUN_ID_FORM_RE`): the form
 * test admits any lowercase word, so the REF KIND is only committed to once the
 * run record it names exists. A bare `main`/`dev`/typo therefore refuses with
 * `invalid-ref` and its remediation rather than producing a full, confident
 * broken-chain report about a run that was never dispatched.
 *
 * Existence only — an unreadable or malformed record still walks, and hop 1
 * reports it as a named broken hop (that IS a run the operator meant).
 */
function assertRunIdRefResolves(ref: string, runsDir: string): void {
  if (existsSync(join(runsDir, `${ref}.json`))) return;
  throw new ChainWalkError(
    "invalid-ref",
    `${JSON.stringify(ref)} has the shape of a run id but no run record exists at ${join(runsDir, `${ref}.json`)}`,
    "list the runs (`bun scripts/fleet.ts list`) and pass one of their ids, or pass the PR URL / qds/<run-id> branch; set QDS_RUNS_DIR if the records live elsewhere",
  );
}

/** The `gh` stderr excerpt carried into a `pr-fetch-failed` diagnostic (redacted, then capped). */
const GH_STDERR_EXCERPT_BYTES = 2_048;
const GH_STDERR_EXCERPT_CHARS = 400;

/**
 * Production hop-1 read: `gh pr view`. gh carries the host auth itself; the
 * walker never reads a token, so none can reach a diagnostic (INV-AUDIT-2) —
 * and the stderr excerpt below goes through `redactSecrets` regardless,
 * because gh's own warnings quote what it was handed.
 *
 * BOTH pipes are drained concurrently. stderr was piped and never read, so
 * once the ~64 KiB pipe buffer filled (auth warnings, proxy/TLS dumps, upgrade
 * notices) `gh` blocked on write, `proc.exited` never settled and the walk hung
 * forever — the per-hop ceiling is measured after the hop returns, so nothing
 * could interrupt it. The fd leaked per invocation too, and the diagnostic
 * carried no cause at all beyond `exit ${code}`.
 *
 * `timeoutMs` is the hop's own ceiling, passed by the caller: it arms a real
 * kill, so the ceiling can terminate the child rather than merely label it.
 */
async function ghFetchPull(ref: string, timeoutMs: number): Promise<{ body: string; headRef?: string; prUrl: string }> {
  const parsed = parseRef(ref);
  const target =
    parsed.refKind === "pr-url"
      ? [String(parsed.prNumber), "--repo", `${parsed.owner}/${parsed.repo}`]
      : [ref];
  const proc = Bun.spawn(["gh", "pr", "view", ...target, "--json", "body,headRefName,url"], {
    stdin: "ignore", stdout: "pipe", stderr: "pipe",
  });
  const controller = new AbortController();
  const kill = (): void => { try { proc.kill(9); } catch { /* already gone */ } };
  const killer = setTimeout(() => { controller.abort(); kill(); }, Math.max(1, timeoutMs));
  killer.unref?.();
  let code: number;
  let out: { text: string };
  let err: { text: string };
  try {
    [code, out, err] = await Promise.all([
      proc.exited,
      readBounded(proc.stdout, EXEC_MAX_OUTPUT_BYTES, { signal: controller.signal, kill, exited: proc.exited }),
      // drainPastCap: read stderr to the END and keep only the excerpt — a
      // chatty gh must never block on a full pipe, whatever it decides to say.
      readBounded(proc.stderr, GH_STDERR_EXCERPT_BYTES, { signal: controller.signal, kill, exited: proc.exited, drainPastCap: true }),
    ]);
  } finally {
    clearTimeout(killer);
  }
  if (code !== 0) {
    const cause = err.text.trim();
    throw new ChainWalkError(
      "pr-fetch-failed",
      `gh pr view failed for ${ref} (exit ${code})${cause.length === 0 ? "" : `: ${redactSecrets(cause).slice(0, GH_STDERR_EXCERPT_CHARS)}`}`,
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

/**
 * Hop 1's `detail`, PROJECTED to the three fields `extensions.pr` is
 * registered to carry (run-record.ts `EXTENSION_NAMESPACES.pr`) — never the
 * raw entry. The namespace's per-field deep merge re-persists retired keys
 * written by older builds verbatim, so spreading the entry whole makes hop 1 a
 * passthrough for whatever a past schema let land there, straight into a
 * `--json` report (INV-AUDIT-2: the walker is the redaction boundary). The
 * DIGEST still covers the WHOLE entry — projection is what is reported, never
 * what is attested.
 */
function prDetail(entry: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (entry === undefined) return undefined;
  return {
    prUrl: typeof entry.prUrl === "string" ? cap(entry.prUrl) : undefined,
    prNumber: typeof entry.prNumber === "number" ? entry.prNumber : undefined,
    createdAt: typeof entry.createdAt === "string" ? cap(entry.createdAt) : undefined,
  };
}

const prCreatedAtOf = (entry: Record<string, unknown> | undefined): string | undefined =>
  typeof entry?.createdAt === "string" ? entry.createdAt : undefined;

/**
 * The bundle hash, STREAMED in 64 KiB chunks — the same shape (and the same
 * raw-bytes discipline) as the emitter side's `sha256File` in
 * `src/providers/harvest.ts`. `readFileSync` materialised a whole git bundle in
 * memory purely to feed a hasher, which is both unbounded and a sync read the
 * hop ceiling cannot race.
 */
function sha256File(path: string): string {
  const hasher = new Bun.CryptoHasher("sha256");
  const chunk = Buffer.alloc(64 * 1024);
  const fd = openSync(path, "r");
  try {
    for (;;) {
      const n = readSync(fd, chunk, 0, chunk.length, null);
      if (n <= 0) break;
      hasher.update(n === chunk.length ? chunk : chunk.subarray(0, n));
    }
  } finally {
    closeSync(fd);
  }
  return hasher.digest("hex");
}

interface TraceRow {
  id: number;
  gate: string | null;
  passed: number | null;
  phaseId: string | null;
  attempt: number | null;
}
/**
 * PER-TABLE availability, not one verdict for the file. The two queries used to
 * share a try/catch with `sessions` issued first, so a trace missing ONLY the
 * `sessions` table marked the whole read `kind: "error"` and broke hop 9 —
 * whose gate evidence was sitting in the same file, readable. Hop 2 degrades on
 * `sessionError`; hop 9 breaks on `gatesError`; neither can be taken down by
 * the other's table.
 */
type TraceRead =
  | {
      kind: "ok";
      tracePath: string;
      session: { repoSlug: string | null; issueId: string | null } | null;
      sessionError?: string;
      gates: TraceRow[];
      gateCount: number;
      gatesError?: string;
    }
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

/**
 * Non-decreasing (`≤`) lifecycle ordering over occurred_at; equality is legal
 * (AC7). Returned in CONSTRAINT order (see `HopOutcome`'s `order-violation`).
 *
 * An UNPARSABLE stamp is its own typed outcome, never a skipped constraint:
 * `10 → garbage → 5` used to report no violation at all, because `msOf`
 * returned `undefined` and the loop simply continued. The store now validates
 * ISO at write time, which closes the door going forward; this closes it for
 * rows already on disk.
 */
type OrderProblem =
  | { kind: "violation"; earlier: string; later: string }
  | { kind: "unparsable"; row: AuditLinkRow };

function firstOrderProblem(rows: readonly AuditLinkRow[]): OrderProblem | undefined {
  for (const row of rows) {
    if (msOf(row.occurredAt) === undefined) return { kind: "unparsable", row };
  }
  for (let i = 1; i < rows.length; i++) {
    const prev = msOf(rows[i - 1]?.occurredAt) as number;
    const cur = msOf(rows[i]?.occurredAt) as number;
    if (cur < prev) return { kind: "violation", earlier: rows[i - 1]?.occurredAt ?? "", later: rows[i]?.occurredAt ?? "" };
  }
  return undefined;
}

/** The typed `broken` an unparsable `occurred_at` earns — the field and the raw value, by name. */
function unparsableStamp(hop: HopName, row: AuditLinkRow, fallbackPath: string): HopOutcome {
  return {
    status: "broken", hop,
    expected: `an ISO-8601 occurred_at on every ${hop} link row`,
    actual: `link ${row.linkId} (${hop}.${row.event}) carries occurred_at ${JSON.stringify(row.occurredAt)}`,
    diagnostic: "an unparsable stamp is not permission to skip the ordering check — a chain whose order cannot be established is a chain this walk does not vouch for",
    evidencePath: row.evidencePath ?? fallbackPath,
  };
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

/**
 * ALL rows per event, oldest→newest — never `new Map(pairs)`, which silently
 * keeps only the LAST row for a duplicated key. The schema's
 * `UNIQUE (run_id, hop, event, subject_key)` explicitly PERMITS two rows with
 * the same event and different subjects (a re-mint with a new keyHash, a
 * re-provision with a new vmName, a re-harvest with a new bundle sha), and the
 * dropped row was checked by nothing: not the digest pass, not the order pass.
 * More than one row for an event is LAWFUL and never an error on its own; the
 * digest pass runs over every row, the order pass over the newest per event,
 * and `detail` reports the count when it is > 1.
 *
 * `linksForRun` already orders by (occurred_at, link_id), so insertion order
 * into each bucket is the sort order.
 */
function rowsByEvent(links: readonly AuditLinkRow[], hop: HopName): Map<string, AuditLinkRow[]> {
  const out = new Map<string, AuditLinkRow[]>();
  for (const row of links) {
    if (row.hop !== hop) continue;
    const bucket = out.get(row.event);
    if (bucket === undefined) out.set(row.event, [row]);
    else bucket.push(row);
  }
  return out;
}

/** The newest row for an event (the ordering subject); `undefined` when the event is absent. */
function newestOf(byEvent: Map<string, AuditLinkRow[]>, event: string): AuditLinkRow | undefined {
  const bucket = byEvent.get(event);
  return bucket === undefined ? undefined : bucket[bucket.length - 1];
}

/** `{ event: n }` for every event carrying more than one lawful row; `undefined` when none does. */
function duplicateCounts(byEvent: Map<string, AuditLinkRow[]>): Record<string, number> | undefined {
  const counts: Record<string, number> = {};
  for (const [event, rows] of byEvent) if (rows.length > 1) counts[event] = rows.length;
  return Object.keys(counts).length === 0 ? undefined : counts;
}

// ---------------------------------------------------------------------------
// The walk
// ---------------------------------------------------------------------------

export async function walkAuditChain(ref: string, opts: WalkOptions = {}): Promise<ChainReport> {
  const startedAt = Date.now();
  const walkRequestId =
    typeof opts.requestId === "string" && opts.requestId.length > 0 ? opts.requestId : newRequestId();
  const now = () => (opts.now ? opts.now() : new Date());
  const ceiling = opts.hopCeilingMs ?? DEFAULT_HOP_CEILING_MS;
  const parsed = parseRef(ref);
  const runsDir = opts.runsDir !== undefined ? opts.runsDir : resolveRunsDir();
  const auditDb = opts.auditDb ?? process.env.QDS_AUDIT_DB ?? DEFAULT_AUDIT_DB_FILE;
  const ledgerPath = opts.ledger ?? process.env.QDS_COST_LEDGER_FILE ?? DEFAULT_COST_LEDGER_FILE;
  const reverifyDir = opts.reverifyDir ?? DEFAULT_REVERIFY_DIR;
  // The `run-id` ref kind is only committed to once the record exists — the
  // form test alone admits any lowercase word (see RUN_ID_FORM_RE).
  if (parsed.refKind === "run-id") assertRunIdRefResolves(ref, runsDir);
  const recordStore = new RunRecordStore({ dir: runsDir, create: false });

  const perHopMs: Record<string, number> = {};
  let prFetchMs = 0;

  // Shared state, resolved once across the hops that need it.
  let runId: string | null = parsed.runId ?? null;
  let record: RunRecord | undefined;
  let recordError: string | undefined;
  let prEntry: Record<string, unknown> | undefined;
  let prUrl: string | undefined;
  /** ONE handle for the whole walk: inode-verified reader AND first-observation appender. */
  let auditStore: AuditStoreWalkHandle | undefined;
  let auditRefusal: AuditStoreError | undefined;
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
        // The Observability Contract's spelling. `LogEntry.duration` carries
        // the same number under the core schema's camelCase; added metric
        // fields are snake_case across this repo (`fill_ms`, `ingest_ms`,
        // `log_read_ms`, `duration_ms`), and the exported TS `timings` type
        // stays camelCase for DF5.4-C9. See `ChainReport.timings`.
        per_hop_ms: durationMs,
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

  /**
   * `extensions.pr`, read from the RECORD and cached — not from whatever hop 1
   * happened to leave behind. `prEntry` used to be assigned only on hop 1's
   * success paths, so any hop-1 failure after the fetch (a PR body that does
   * not name its run, say) left hop 8 blind to a `pr.createdAt` sitting in the
   * record it also reads, and hop 8's strict-ordering constraint then reported
   * a missing stamp that was never missing.
   */
  const readPrEntry = (): Record<string, unknown> | undefined => {
    if (prEntry !== undefined) return prEntry;
    readRecord();
    const ext = record?.extensions as Record<string, Record<string, unknown>> | undefined;
    prEntry = ext?.pr;
    return prEntry;
  };

  const openAudit = (): void => {
    if (auditStore !== undefined || auditRefusal !== undefined) return;
    try {
      auditStore = openAuditStoreForWalk(auditDb);
    } catch (e) {
      if (e instanceof AuditStoreError) auditRefusal = e;
      else auditRefusal = new AuditStoreError("audit-store-absent", cap((e as Error).message), "inspect the audit store path");
    }
  };

  /**
   * The walk's ONE inode-verified handle — never a second by-path open.
   * `openAuditStoreForWalk` now returns an appender as well as a reader
   * (`AuditStoreWalkHandle`), so the first-observation rows go through the
   * handle whose inode the open already proved, instead of through a fresh
   * `openAuditStore()` that re-resolves the path and could bind a replacement.
   */
  const digestWriter = (): AuditStoreWriter | undefined => {
    openAudit();
    if (auditStore === undefined) return undefined;
    const requestId = record?.requestId;
    if (typeof requestId !== "string" || requestId.length === 0) return undefined;
    return auditStore;
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
   *
   * The prior row is found by (runId, hop) ALONE. Keying the lookup on
   * `subjectId` too made tamper detection defeatable by editing the field that
   * FORMS the subject id — change `extensions.approval.approverId` to
   * "mallory" and hop 8's key `${approverId}@${decidedAt}` changes with it, so
   * no prior row was found, the mismatch branch was skipped, a NEW
   * first-observation row was appended and the hop resolved clean. Hops 1/7/8
   * are singular (module header), so a prior row under a DIFFERENT subject id
   * is a rewritten subject and reports `evidence-mismatch` naming both.
   *
   * `occurredAt` is the SUBJECT's own timestamp, never the walk's clock: the
   * store documents that column as the EVENT time and that rows are written at
   * the moment of the event, never retroactively (INV-AUDIT-4), and
   * `linksForRun` sorts on it. `recordedAt` is the walk's clock, which is what
   * it is for. A subject carrying no timestamp falls back to now() — the
   * observation is then genuinely the only event there is.
   */
  const authorizingDigest = (
    hop: HopName, subjectId: string, subject: unknown, evidencePath: string, subjectKind: string,
    subjectOccurredAt?: string,
  ): HopOutcome | undefined => {
    openAudit();
    if (auditStore === undefined || runId === null) return undefined;
    const digest = digestOf(subject);
    const priors = auditStore
      .linksForRun(runId)
      .filter((r) => r.hop === hop && r.event === WALK_OBSERVED_EVENT);
    const existing = priors.find((r) => r.subjectId === subjectId);
    if (existing !== undefined) {
      if (existing.evidenceDigest !== digest) {
        return { status: "evidence-mismatch", hop, expectedDigest: existing.evidenceDigest, actualDigest: digest, evidencePath };
      }
      return undefined;
    }
    const rewritten = priors[0];
    if (rewritten !== undefined) {
      return {
        status: "evidence-mismatch", hop,
        expectedDigest: rewritten.evidenceDigest, actualDigest: digest, evidencePath,
        expectedSubjectId: rewritten.subjectId ?? "<none>", actualSubjectId: subjectId,
      };
    }
    readRecord();
    const requestId = record?.requestId;
    const repoSlug = repoSlugFor();
    if (typeof requestId !== "string" || requestId.length === 0 || repoSlug.length === 0 || repoSlug === "unknown") {
      return undefined;
    }
    const writer = digestWriter();
    if (writer === undefined) return undefined;
    const recordedAt = now().toISOString();
    const occurredAt = msOf(subjectOccurredAt) !== undefined ? (subjectOccurredAt as string) : recordedAt;
    try {
      writer.record({
        runId, repoSlug, requestId, hop, event: WALK_OBSERVED_EVENT,
        subjectId, subjectKind, evidencePath, evidenceDigest: digest, occurredAt, recordedAt,
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
        const joinable = typeof requestId === "string" && requestId.length > 0;
        // Each table in its OWN try/catch: a trace missing one of them must not
        // take the other's hop down with it (see `TraceRead`).
        let session: { repoSlug: string | null; issueId: string | null } | null = null;
        let sessionError: string | undefined;
        if (joinable) {
          try {
            const sessionRow = db.prepare("SELECT repo_slug, issue_id FROM sessions WHERE request_id = ?").get(requestId as string) as
              { repo_slug: string | null; issue_id: number | string | null } | null | undefined;
            session =
              sessionRow === null || sessionRow === undefined
                ? null
                : {
                    repoSlug: typeof sessionRow.repo_slug === "string" ? sessionRow.repo_slug : null,
                    issueId: sessionRow.issue_id === null || sessionRow.issue_id === undefined ? null : String(sessionRow.issue_id),
                  };
          } catch (e) {
            sessionError = cap((e as Error).message);
          }
        }
        // COUNT(*) + LIMIT, never `.all()`: only the count and the first
        // GATE_ROWS_IN_DETAIL rows are ever used, and a run with thousands of
        // gate rows must not be materialised whole to learn its length.
        let gates: TraceRow[] = [];
        let gateCount = 0;
        let gatesError: string | undefined;
        if (joinable) {
          try {
            const counted = db.prepare("SELECT COUNT(*) AS n FROM gate_results WHERE request_id = ?").get(requestId as string) as { n?: unknown } | null | undefined;
            gateCount = Number(counted?.n ?? 0);
            const gateRows = db
              .prepare("SELECT id, gate, passed, phase_id, attempt FROM gate_results WHERE request_id = ? ORDER BY id LIMIT ?")
              .all(requestId as string, GATE_ROWS_IN_DETAIL) as Record<string, unknown>[];
            gates = gateRows.map((r) => ({
              id: Number(r.id),
              // INV-AUDIT-2: `gate` and `phase_id` are written INSIDE the box,
              // so they are caller data on their way into the report — capped
              // here, at the walker's redaction boundary, not at the consumer.
              gate: typeof r.gate === "string" ? cap(r.gate) : null,
              passed: r.passed === null || r.passed === undefined ? null : Number(r.passed),
              phaseId: typeof r.phase_id === "string" ? cap(r.phase_id) : null,
              attempt: r.attempt === null || r.attempt === undefined ? null : Number(r.attempt),
            }));
          } catch (e) {
            gatesError = cap((e as Error).message);
          }
        }
        trace = { kind: "ok", tracePath, session, gates, gateCount, ...(sessionError !== undefined ? { sessionError } : {}), ...(gatesError !== undefined ? { gatesError } : {}) };
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
    // The record is read BEFORE anything reads a field off it: this hop's
    // `keyHash` fallback used to read `record?.keyHash` off whatever state an
    // earlier hop happened to populate, so an unreadable record silently became
    // "no keyHash" instead of the named broken hop hops 2/7/8/9 all report.
    readRecord();
    if (recordError !== undefined) return recordBroken("run-credential");
    openAudit();
    if (auditRefusal !== undefined) {
      return { status: "broken", hop: "run-credential", expected: "a readable audit-link store", actual: auditRefusal.code, diagnostic: cap(auditRefusal.message), evidencePath: auditDb };
    }
    const byEvent = rowsByEvent(auditStore?.linksForRun(rid) ?? [], "run-credential");
    const missing = CREDENTIAL_EVENTS.filter(([ev]) => !byEvent.has(ev));
    if (missing.length > 0) {
      return { status: "unlinked", hop: "run-credential", emitter: missing.map(([, em]) => em).join(", "), diagnostic: `no audit_links row for run-credential event(s) ${missing.map(([ev]) => ev).join(", ")} — links are emitted at the event, never inferred (INV-AUDIT-4)` };
    }
    // Digest EVERY row (a tampered duplicate must not hide behind a clean
    // newest); order the NEWEST row per event.
    const everyRow = CREDENTIAL_EVENTS.flatMap(([ev]) => byEvent.get(ev) ?? []);
    const mismatch = firstDigestMismatch(everyRow, auditDb);
    if (mismatch !== undefined) return mismatch;
    const ordered = CREDENTIAL_EVENTS.map(([ev]) => newestOf(byEvent, ev) as AuditLinkRow);
    const problem = firstOrderProblem(ordered);
    if (problem?.kind === "unparsable") return unparsableStamp("run-credential", problem.row, auditDb);
    if (problem !== undefined) {
      return { status: "order-violation", hop: "run-credential", constraint: "mint <= deliver <= revoke <= verify-revoked (non-decreasing)", earlier: problem.earlier, later: problem.later };
    }
    const keyHash = record?.keyHash ?? (ordered[0]?.detail as { keyHash?: unknown } | null | undefined)?.keyHash;
    const hash = typeof keyHash === "string" ? keyHash : undefined;
    const duplicates = duplicateCounts(byEvent);
    return {
      status: "resolved", hop: "run-credential", runId: rid,
      subjectId: hash ?? ordered[0]?.subjectId ?? rid,
      evidencePath: ordered[0]?.evidencePath, linkId: ordered[0]?.linkId,
      ...keyFields(hash),
      detail: {
        ...keyFields(hash),
        events: Object.fromEntries(CREDENTIAL_EVENTS.map(([ev]) => [ev, { occurredAt: newestOf(byEvent, ev)?.occurredAt, linkId: newestOf(byEvent, ev)?.linkId }])),
        linkIds: Object.fromEntries(CREDENTIAL_EVENTS.map(([ev]) => [ev, newestOf(byEvent, ev)?.linkId])),
        ...(duplicates !== undefined ? { rowsPerEvent: duplicates } : {}),
      },
    };
  }

  function hop5box(): HopOutcome {
    const rid = runId as string;
    // M3: this hop reads `record.closedAt` to decide reap, and on an unreadable
    // record `record` is simply undefined — which produced the confident, FALSE
    // claim "the record is open and no reap link exists — the reaper never
    // collected this run" about a record nobody could read.
    readRecord();
    if (recordError !== undefined) return recordBroken("run-box");
    openAudit();
    if (auditRefusal !== undefined) {
      return { status: "broken", hop: "run-box", expected: "a readable audit-link store", actual: auditRefusal.code, diagnostic: cap(auditRefusal.message), evidencePath: auditDb };
    }
    const byEvent = rowsByEvent(auditStore?.linksForRun(rid) ?? [], "run-box");
    const missing = BOX_EVENTS.filter(([ev]) => !byEvent.has(ev));
    if (missing.length > 0) {
      return { status: "unlinked", hop: "run-box", emitter: missing.map(([, em]) => em).join(", "), diagnostic: `no audit_links row for run-box event(s) ${missing.map(([ev]) => ev).join(", ")} — links are emitted at the event, never synthesized from end state (INV-AUDIT-4)` };
    }
    // reap: an emitted link resolves as emitted; on the ordinary path AC5's
    // not-applicable needs BOTH halves — the record carries `closedAt` AND no
    // live VM. The second half is proven by the `teardown` link row (mandatory
    // above), NOT by `record.vmName`: `vmName` is stamped at provision and
    // never cleared on close, so a cleanly torn-down run still carries it, and
    // the reaper's own predicate is `closedAt !== undefined ⇒ not claimed`
    // (`reapOrphanBoxes` in src/providers/driver.ts). Testing `vmName` for
    // liveness would report every real torn-down run as uncollected.
    const reapRow = newestOf(byEvent, "reap");
    const teardownRow = newestOf(byEvent, "teardown");
    const closedAt = record?.closedAt;
    const tornDown = typeof closedAt === "string" && teardownRow !== undefined;
    const reap: Record<string, unknown> =
      reapRow !== undefined
        ? { status: "resolved", occurredAt: reapRow.occurredAt, linkId: reapRow.linkId }
        : { status: "not-applicable", reason: REAP_NOT_APPLICABLE_REASON };
    if (reapRow === undefined && !tornDown) {
      return {
        status: "unlinked", hop: "run-box", emitter: "sweep",
        diagnostic: `no reap link exists and the run is not provably torn down (closedAt ${closedAt ?? "absent"}, teardown link ${teardownRow === undefined ? "absent" : `#${teardownRow.linkId}`}) — nothing here shows the box was collected`,
      };
    }
    const lifecycleEvents = reapRow !== undefined ? [...BOX_EVENTS.map(([ev]) => ev), "reap"] : BOX_EVENTS.map(([ev]) => ev);
    const everyRow = lifecycleEvents.flatMap((ev) => byEvent.get(ev) ?? []);
    const mismatch = firstDigestMismatch(everyRow, auditDb);
    if (mismatch !== undefined) return mismatch;
    const lifecycle = lifecycleEvents.map((ev) => newestOf(byEvent, ev) as AuditLinkRow);
    const problem = firstOrderProblem(lifecycle);
    if (problem?.kind === "unparsable") return unparsableStamp("run-box", problem.row, auditDb);
    if (problem !== undefined) {
      return { status: "order-violation", hop: "run-box", constraint: `create <= fill <= setup-gate <= teardown${reapRow !== undefined ? " <= reap" : ""} (non-decreasing)`, earlier: problem.earlier, later: problem.later };
    }
    const duplicates = duplicateCounts(byEvent);
    return {
      status: "resolved", hop: "run-box", runId: rid,
      subjectId: lifecycle[0]?.subjectId ?? rid,
      evidencePath: lifecycle[0]?.evidencePath, linkId: lifecycle[0]?.linkId,
      detail: {
        closedAt, vmName: record?.vmName,
        events: Object.fromEntries([
          ...BOX_EVENTS.map(([ev]) => [ev, { occurredAt: newestOf(byEvent, ev)?.occurredAt, linkId: newestOf(byEvent, ev)?.linkId }]),
          ["reap", reap],
        ]),
        ...(duplicates !== undefined ? { rowsPerEvent: duplicates } : {}),
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
    const byEvent = rowsByEvent(auditStore?.linksForRun(rid) ?? [], "run-bundle");
    // A lawful in-place re-harvest (`--force`, AC5) emits a SECOND row per
    // event under a new subject (`${bundlePath}#${sha256}` / `#${tip}`), so the
    // NEWEST row is the one that describes the bundle on disk now. Assuming
    // exactly one row froze `detail.sha256` at the first bundle and reported
    // evidence-mismatch on a healthy run forever.
    const verifyRow = newestOf(byEvent, "bundle-verify");
    const fetchRow = newestOf(byEvent, "bundle-fetch");
    if (verifyRow === undefined) {
      return { status: "unlinked", hop: "run-bundle", emitter: "harvestRun (bundle-verify)", diagnostic: "the bundle exists but no bundle-verify link row was emitted at harvest time" };
    }
    if (fetchRow === undefined) {
      return { status: "unlinked", hop: "run-bundle", emitter: "harvestRun (bundle-fetch)", diagnostic: "bundle-verify is linked but bundle-fetch was never emitted" };
    }
    const everyRow = [...(byEvent.get("bundle-verify") ?? []), ...(byEvent.get("bundle-fetch") ?? [])];
    const mismatch = firstDigestMismatch(everyRow, path);
    if (mismatch !== undefined) return mismatch;
    // Streamed in 64 KiB chunks over the RAW BYTES — never
    // `bytes.toString("latin1")`. A CryptoHasher fed a string encodes it as
    // UTF-8, so a latin1 round-trip silently expands every byte >= 0x80 into
    // two and the digest of any real (binary) bundle stops matching
    // harvest.ts's `sha256File`. That mismatch reported `evidence-mismatch` on
    // every harvested bundle; ASCII-only fixtures never see it.
    const actualDigest = sha256File(path);
    const bundleBytes = statSync(path).size;
    const claimed = (verifyRow.detail as { sha256?: unknown } | null | undefined)?.sha256;
    if (typeof claimed === "string" && claimed !== actualDigest) {
      return { status: "evidence-mismatch", hop: "run-bundle", expectedDigest: claimed, actualDigest, evidencePath: path };
    }
    const orderProblem = firstOrderProblem([verifyRow, fetchRow]);
    if (orderProblem?.kind === "unparsable") return unparsableStamp("run-bundle", orderProblem.row, path);
    if (orderProblem !== undefined) {
      return { status: "order-violation", hop: "run-bundle", constraint: "bundle-verify <= bundle-fetch (non-decreasing)", earlier: orderProblem.earlier, later: orderProblem.later };
    }
    const duplicates = duplicateCounts(byEvent);
    return {
      status: "resolved", hop: "run-bundle", runId: rid,
      subjectId: verifyRow.subjectId ?? rid,
      evidencePath: path, evidenceDigest: verifyRow.evidenceDigest, linkId: verifyRow.linkId,
      detail: {
        sha256: actualDigest, bundleBytes,
        linkIds: { "bundle-verify": verifyRow.linkId, "bundle-fetch": fetchRow.linkId },
        ...(duplicates !== undefined ? { rowsPerEvent: duplicates } : {}),
      },
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
    const mismatch = authorizingDigest("run-reverify", reportId, bound, path, "reverify-report", bound.completedAt);
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
    const approval = record?.extensions?.approval as Record<string, unknown> | null | undefined;
    // `typeof null === "object"`, so a null approval reached `approval.approverId`
    // below and threw a TypeError the catch-all flattened into a generic broken
    // hop — losing the INV-PR-5 explanation written for exactly this case.
    if (approval === undefined || approval === null || typeof approval !== "object") {
      // INV-PR-5: no PR exists without an approval, so on a PR-bearing walk an
      // absent approval is broken — never not-applicable (AC5).
      return { status: "broken", hop: "run-approval", expected: "extensions.approval (approverId, decidedAt, reportId, headSha)", actual: "no approval entry", diagnostic: "INV-PR-5: no PR without an approval — an absent approval on a PR-bearing run is a broken hop", evidencePath: recordPath() };
    }
    const approverId = typeof approval.approverId === "string" ? approval.approverId : undefined;
    const decidedAt = typeof approval.decidedAt === "string" ? approval.decidedAt : undefined;
    if (approverId === undefined || decidedAt === undefined) {
      return { status: "broken", hop: "run-approval", expected: "approverId and decidedAt", actual: JSON.stringify(Object.keys(approval)), diagnostic: "an approval without a decision cannot authorize the PR", evidencePath: recordPath() };
    }
    // The authorization chain is STRICT (AC7): equality is a violation. Each
    // pairwise constraint is evaluated under ITS OWN guard. The whole
    // conjunction used to be gated on all three stamps being present, so an
    // absent `pr.createdAt` — which hop 1 explicitly tolerates on a PR-URL or
    // branch walk whose record was never stamped, and which `ghFetchPull` can
    // never supply (it requests only body,headRefName,url) — skipped the
    // `reverify.completedAt < approval.decidedAt` half too. An approval decided
    // BEFORE the report it cites then resolved clean, complete, exit 0.
    const completedAt = boundReport?.completedAt;
    const completedMs = msOf(completedAt);
    const decidedMs = msOf(decidedAt);
    const prCreatedAt = prCreatedAtOf(readPrEntry());
    const prCreatedMs = msOf(prCreatedAt);
    if (decidedMs === undefined) {
      return { status: "broken", hop: "run-approval", expected: "extensions.approval.decidedAt as an ISO-8601 stamp", actual: JSON.stringify(decidedAt), diagnostic: `a decision whose time cannot be read orders against nothing; ${AUTHORIZATION_CONSTRAINT}`, evidencePath: recordPath() };
    }
    // A stamp the constraint NEEDS but cannot get is a named broken hop, never
    // permission to skip the constraint.
    if (completedMs === undefined) {
      return { status: "broken", hop: "run-approval", expected: `the bound reverify report's completedAt, to check ${AUTHORIZATION_CONSTRAINT}`, actual: completedAt === undefined ? "hop 7 resolved no bound report" : `unparsable completedAt ${JSON.stringify(completedAt)}`, diagnostic: "the approval cannot be shown to follow the report it cites; fix hop 7 and re-run", evidencePath: reportPath(reverifyDir, rid) };
    }
    if (!(completedMs < decidedMs)) {
      // CONSTRAINT order: `earlier` is the event required to come first.
      return { status: "order-violation", hop: "run-approval", constraint: AUTHORIZATION_CONSTRAINT, earlier: completedAt as string, later: decidedAt };
    }
    if (prCreatedMs === undefined) {
      return { status: "broken", hop: "run-approval", expected: `extensions.pr.createdAt as an ISO-8601 stamp, to check ${AUTHORIZATION_CONSTRAINT}`, actual: prCreatedAt === undefined ? "no createdAt in the record's extensions.pr (the PR read supplies body/headRefName/url only)" : `unparsable createdAt ${JSON.stringify(prCreatedAt)}`, diagnostic: "the PR cannot be shown to follow its own authorization; stamp extensions.pr.createdAt at PR-open time (DF5.2) and re-run", evidencePath: recordPath() };
    }
    if (!(decidedMs < prCreatedMs)) {
      return { status: "order-violation", hop: "run-approval", constraint: AUTHORIZATION_CONSTRAINT, earlier: decidedAt, later: prCreatedAt as string };
    }
    const subjectId = `${approverId}@${decidedAt}`;
    const mismatch = authorizingDigest("run-approval", subjectId, approval, recordPath(), "run-record.approval", decidedAt);
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
    // Only the GATE table's own failure breaks this hop — a trace missing
    // `sessions` alone still carries the gate evidence hop 9 needs.
    if (t.gatesError !== undefined) {
      return { status: "broken", hop: "run-gate-evidence", expected: `gate_results rows for ${requestId}`, actual: t.gatesError, diagnostic: "the harvested trace opened but its gate_results table could not be read", evidencePath: t.tracePath };
    }
    if (t.gateCount === 0) {
      return { status: "broken", hop: "run-gate-evidence", expected: `gate_results rows for ${requestId}`, actual: "none", diagnostic: "a run with no gate evidence is not a run this chain vouches for", evidencePath: t.tracePath };
    }
    return {
      status: "resolved", hop: "run-gate-evidence", runId: rid, subjectId: requestId,
      evidencePath: t.tracePath, evidence: { kind: "claim" },
      // `count` is the SQL COUNT(*); `rows` is the first GATE_ROWS_IN_DETAIL of
      // them, which is all the query ever fetched.
      detail: { count: t.gateCount, rows: t.gates },
    };
  }

  return await (async (): Promise<ChainReport> => {
    const outcomes: Partial<Record<HopName, HopOutcome>> = {};
    /**
     * Each hop RACES its ceiling rather than being measured after the fact.
     * `await fn()` then `elapsed > ceiling` made the 3 s per-hop ceiling a
     * label applied to work that had already finished, and the 30 s walk
     * ceiling was sampled only BETWEEN hops — so neither could interrupt
     * anything. The race is against `min(per-hop ceiling, total remaining)`,
     * and the winning timer names WHICH budget it was (`budget`, AC4's
     * `ceilingMs` being the per-hop one).
     *
     * RESIDUAL, stated plainly: a hop that blocks the event loop synchronously
     * (`readFileSync`, a `bun:sqlite` query, `Bun.sleepSync` in a test seam)
     * cannot be interrupted by any timer in this runtime — the timer callback
     * is a macrotask and cannot run while the loop is blocked. For those the
     * POST-HOC check below still applies and still fails the hop closed; the
     * race is what bounds the awaited work (the `gh` read at hop 1, which is
     * also killed at the source by `ghFetchPull`'s abort). The sync inputs are
     * capped instead: streamed bundle hash, `COUNT(*)` + `LIMIT` on
     * `gate_results`, bounded `detail` reads.
     */
    const timed = async (hop: HopName, fn: () => HopOutcome | Promise<HopOutcome>): Promise<void> => {
      const remainingTotal = TOTAL_CEILING_MS - (Date.now() - startedAt);
      if (remainingTotal <= 0) {
        perHopMs[hop] = 0;
        outcomes[hop] = { status: "hop-timeout", hop, ceilingMs: TOTAL_CEILING_MS, elapsedMs: Date.now() - startedAt, budget: "total" };
        return;
      }
      const budget: "hop" | "total" = ceiling <= remainingTotal ? "hop" : "total";
      const raceMs = Math.min(ceiling, remainingTotal);
      const t0 = Date.now();
      let timer: ReturnType<typeof setTimeout> | undefined;
      let out: HopOutcome;
      try {
        const raced = await Promise.race<{ timedOut: false; out: HopOutcome } | { timedOut: true }>([
          Promise.resolve().then(fn).then((o) => ({ timedOut: false as const, out: o })),
          new Promise((resolve) => {
            timer = setTimeout(() => resolve({ timedOut: true }), Math.max(0, raceMs));
            timer.unref?.();
          }),
        ]);
        out = raced.timedOut
          ? { status: "hop-timeout", hop, ceilingMs: budget === "hop" ? ceiling : TOTAL_CEILING_MS, elapsedMs: Date.now() - t0, budget }
          : raced.out;
      } catch (e) {
        // C9: a typed walk refusal is the CLI's to handle (exit 2 with its
        // remediation). Flattening it here made ChainWalkError("pr-fetch-failed")
        // unreachable and the CLI's dedicated handler dead code.
        if (e instanceof ChainWalkError) throw e;
        out = { status: "broken", hop, expected: "hop resolution", actual: cap((e as Error).message), diagnostic: `unhandled walk error at hop ${hop}`, evidencePath: runId !== null ? recordPath() : ref };
      } finally {
        if (timer !== undefined) clearTimeout(timer);
      }
      const elapsed = Date.now() - t0;
      perHopMs[hop] = elapsed;
      // AC4: a hop over its ceiling fails closed as hop-timeout, never
      // resolved. This is the post-hoc arm for the sync-blocking case above —
      // and it never OVERWRITES a broken outcome, which would discard the real
      // diagnostic in favour of a timing label.
      if (elapsed > ceiling && out.status !== "broken" && out.status !== "hop-timeout") {
        out = { status: "hop-timeout", hop, ceilingMs: ceiling, elapsedMs: elapsed, budget: "hop" };
      }
      outcomes[hop] = out;
    };

    // ── hop 1: ref → PR → contributing runId ──
    await timed("pr-run", async (): Promise<HopOutcome> => {
      if (parsed.refKind === "run-id") {
        readPrEntry();
        prUrl = typeof prEntry?.prUrl === "string" ? prEntry.prUrl : undefined;
        if (prUrl === undefined) {
          return { status: "broken", hop: "pr-run", expected: "extensions.pr.prUrl in the run record", actual: "no pr entry", diagnostic: `the runId form resolves hop 1 locally from ${recordPath()} — zero network`, evidencePath: recordPath() };
        }
        const mismatch = authorizingDigest("pr-run", prUrl, prEntry, recordPath(), "run-record.pr", prCreatedAtOf(prEntry));
        if (mismatch !== undefined) return mismatch;
        return { status: "resolved", hop: "pr-run", runId: runId as string, subjectId: prUrl, evidencePath: recordPath(), evidenceDigest: digestOf(prEntry), detail: prDetail(prEntry) };
      }
      const fetchStart = Date.now();
      const pull = await (opts.fetchPull !== undefined ? opts.fetchPull(ref) : ghFetchPull(ref, ceiling));
      prFetchMs = Date.now() - fetchStart;
      prUrl = pull.prUrl;
      const head = pull.headRef;
      const branch = head !== undefined ? BRANCH_RE.exec(head) : null;
      if (branch === null) {
        runId = null;
        return { status: "broken", hop: "pr-run", expected: "head branch qds/{runId}", actual: head === undefined ? "no headRef returned" : cap(head), diagnostic: "the PR→run correlation needs the qds/{runId} head branch; without it no contributing runId exists", evidencePath: prUrl };
      }
      const branchRunId = branch[1];
      if (branchRunId === undefined) {
        runId = null;
        return { status: "broken", hop: "pr-run", expected: "head branch qds/{runId}", actual: head === undefined ? "no headRef returned" : cap(head), diagnostic: "the qds/ head branch carried no runId; no contributing runId exists", evidencePath: prUrl };
      }
      runId = branchRunId;
      if (!bodyNamesRun(pull.body, branchRunId)) {
        return { status: "broken", hop: "pr-run", expected: `the contributing runId ${branchRunId} as a whole token in the PR body`, actual: `absent from the ${pull.body.length}-char body`, diagnostic: `PR ${prUrl} does not name its run; the body is the run-correlation record (DF5.2)`, evidencePath: prUrl };
      }
      readPrEntry();
      // The record's own prUrl must BE the PR that was fetched. Without this
      // the digest is taken over PR #1's entry while the walk reports PR #2 as
      // its subject — two different pull requests inside one resolved hop.
      const recordedPrUrl = typeof prEntry?.prUrl === "string" ? prEntry.prUrl : undefined;
      if (recordedPrUrl !== undefined && recordedPrUrl !== pull.prUrl) {
        return { status: "broken", hop: "pr-run", expected: `the fetched PR ${pull.prUrl} to be the one the record names`, actual: `extensions.pr.prUrl is ${recordedPrUrl}`, diagnostic: `run ${branchRunId} is correlated to a different pull request; the digest and the subject would describe two PRs`, evidencePath: recordPath() };
      }
      const digestOutcome = prEntry !== undefined ? authorizingDigest("pr-run", prUrl, prEntry, recordPath(), "run-record.pr", prCreatedAtOf(prEntry)) : undefined;
      if (digestOutcome !== undefined) return digestOutcome;
      return {
        status: "resolved", hop: "pr-run", runId: branchRunId, subjectId: prUrl,
        evidencePath: prEntry !== undefined ? recordPath() : prUrl,
        evidenceDigest: prEntry !== undefined ? digestOf(prEntry) : undefined,
        detail: { headRef: head === undefined ? undefined : cap(head), prEntrySet: prEntry !== undefined },
      };
    });

    // ── hops 2–9 (record-joined) — or broken when hop 1 named no runId ──
    if (runId === null) {
      for (const hop of HOPS.slice(1, 9)) {
        outcomes[hop] = { status: "broken", hop, expected: "a contributing runId", actual: "hop 1 resolved none", diagnostic: "no run to walk; fix hop 1 and re-run", evidencePath: prUrl ?? ref };
      }
    } else {
      // Authority ordering (INV-AUDIT-5, "the in-box gate results are a claim,
      // never authority"): the run record is written HOST-side at admission
      // from the validated brief and the box can never reach it, while the
      // `sessions` row is harvested OUT of an agent-controlled box. So the
      // record's `extensions.budget` correlation decides this hop; the trace is
      // read only to CORROBORATE it. The earlier ordering — trace first,
      // record consulted afterwards — let a box that invoked bare (NULL
      // repo_slug/issue_id, which is what every dispatched run actually
      // harvests) decide the hop's status, and its own diagnostic claimed that
      // shape "cannot arise". Corroboration is reported, never required; the
      // one thing it still FAILS on is disagreement, which is tamper
      // (INV-AUDIT-1) and stays fail-closed.
      //
      // Record authority does NOT dissolve the two statuses the spec names for
      // this hop, which the rework had reduced to fields inside a `resolved`
      // detail. Both are restored on top of the ordering above:
      //  - AC6 requires hops 2/6/9 to resolve to `evidence-not-harvested` with
      //    a reason and `<runsDir>/<runId>-artifacts` as the evidencePath. An
      //    unharvested trace is therefore that status, which BREAKS the chain —
      //    stricter than the `resolved`-with-a-note it replaces, deliberately.
      //  - the hop-2 table row requires `not-applicable` with
      //    BARE_RUN_NULL_CORRELATION_REASON for a NULL in-box correlation on a
      //    runId-rooted walk.
      // A record carrying no `extensions.budget` correlation keeps `broken`
      // where the table says `not-applicable`: `broken` is the fail-closed
      // reading (the box's own trace cannot supply the host's admission
      // correlation, INV-AUDIT-5), and the deviation is recorded in the story.
      await timed("run-issue", (): HopOutcome => {
        readRecord();
        if (recordError !== undefined) return recordBroken("run-issue");
        const requestId = record?.requestId;
        if (typeof requestId !== "string" || requestId.length === 0) {
          return { status: "broken", hop: "run-issue", expected: "record.requestId", actual: "absent", diagnostic: "the runId→trace join key is missing from the record", evidencePath: recordPath() };
        }
        const budget = record?.extensions?.budget as Record<string, unknown> | undefined;
        const recordSlug = typeof budget?.repoSlug === "string" && budget.repoSlug.length > 0 ? budget.repoSlug : undefined;
        const recordIssue = typeof budget?.issueId === "string" && budget.issueId.length > 0 ? budget.issueId : undefined;
        if (recordSlug === undefined || recordIssue === undefined) {
          return {
            status: "broken", hop: "run-issue",
            expected: "extensions.budget.repoSlug and extensions.budget.issueId (the host-side admission correlation)",
            actual: recordSlug === undefined && recordIssue === undefined ? "neither present" : recordSlug === undefined ? "repoSlug absent" : "issueId absent",
            diagnostic: "admission writes the validated issue correlation into the run record; a record carrying none names no issue this walk can vouch for, and the box's own trace cannot supply it (INV-AUDIT-5) — fail closed",
            evidencePath: recordPath(),
          };
        }
        const t = readTrace();
        // AC6: an unharvested trace is `evidence-not-harvested` naming the
        // artifacts dir — not a resolved hop with a footnote.
        if (t.kind === "not-harvested") {
          return { status: "evidence-not-harvested", hop: "run-issue", reason: t.reason, evidencePath: artifactsDir() };
        }
        const session = t.kind === "ok" ? t.session : null;
        let corroboration: "confirmed" | "unavailable" = "unavailable";
        let corroborationReason: string | undefined;
        if (t.kind === "error") {
          corroborationReason = `trace unreadable through its temp-dir copy: ${t.message}`;
        } else if (t.sessionError !== undefined) {
          corroborationReason = `the harvested trace's sessions table could not be read: ${t.sessionError}`;
        } else if (session === null) {
          corroborationReason = `no sessions row for request_id ${requestId} in the harvested trace`;
        } else if (session.repoSlug === null && session.issueId === null) {
          // The hop-2 table's own outcome, on the walk shape it names.
          if (parsed.refKind === "run-id") {
            return { status: "not-applicable", hop: "run-issue", reason: BARE_RUN_NULL_CORRELATION_REASON };
          }
          corroborationReason = BARE_RUN_NULL_CORRELATION_REASON;
        } else {
          // Integer column vs string record value: String() the sessions side
          // (done in readTrace) — an uncoerced 42 === "42" would report tamper
          // on a healthy run. Identity is the PAIR, so either half diverging is
          // divergence; a half that is NULL simply corroborates nothing.
          if (session.issueId !== null && session.issueId !== recordIssue) {
            return { status: "broken", hop: "run-issue", expected: `issue ${recordIssue} (record, canonicalised)`, actual: `issue ${session.issueId} (sessions INTEGER coerced via String())`, diagnostic: "the record and the trace disagree about the issue; identity is (repo_slug, issue_id), never the number alone (INV-AUDIT-1)", evidencePath: t.kind === "ok" ? t.tracePath : recordPath() };
          }
          if (session.repoSlug !== null && session.repoSlug !== recordSlug) {
            return { status: "broken", hop: "run-issue", expected: `repo ${recordSlug} (record, canonicalised)`, actual: `repo ${session.repoSlug} (sessions.repo_slug)`, diagnostic: "the record and the trace disagree about the repo; identity is (repo_slug, issue_id), never the number alone (INV-AUDIT-1)", evidencePath: t.kind === "ok" ? t.tracePath : recordPath() };
          }
          corroboration = "confirmed";
        }
        return {
          status: "resolved", hop: "run-issue", runId: runId as string,
          subjectId: `${recordSlug}#${recordIssue}`,
          evidencePath: recordPath(),
          detail: {
            repoSlug: recordSlug, issueId: recordIssue, requestId,
            corroboration,
            ...(corroborationReason !== undefined ? { corroborationReason } : {}),
            ...(t.kind === "ok" ? { tracePath: t.tracePath, traceCorrelation: session } : {}),
          },
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

    // A lookup KEY, not a claim: `RunChain.runId` below holds the real runId or
    // null, and never a PR url standing in for one.
    const mapKey = runId ?? prUrl ?? ref;
    for (const hop of HOPS) {
      const out = outcomes[hop];
      if (out === undefined) {
        outcomes[hop] = { status: "broken", hop, expected: "a typed outcome", actual: "missing", diagnostic: "the walk produced no outcome for this hop", evidencePath: runId !== null ? recordPath() : ref };
      }
      perHopMs[hop] = perHopMs[hop] ?? 0;
      hopLine(hop, outcomes[hop] as HopOutcome, perHopMs[hop] as number, mapKey, repoSlugFor());
    }

    const hops = Object.fromEntries(HOPS.map((h) => [h, outcomes[h] as HopOutcome])) as Record<HopName, HopOutcome>;
    const runChain: RunChain = { runId, complete: chainComplete(hops), hops };
    return {
      ref, refKind: parsed.refKind, generatedAt: now().toISOString(),
      complete: runChain.complete, timings: { prFetchMs, perHopMs }, runs: { [mapKey]: runChain },
    };
  })().finally(() => {
    // Every other resource in this file closes in a finally (`readTrace`'s
    // db.close()/rmSync, `probeAndBind`'s closeSync, hop 3's ledger.close());
    // this sat on the straight-line success path, so a throw anywhere in the
    // walk — a ChainWalkError now that C9 lets one out, or any unhandled error
    // before the returns — leaked the store handle.
    if (auditStore !== undefined) { try { auditStore.close(); } catch { /* best-effort */ } }
  });
}
