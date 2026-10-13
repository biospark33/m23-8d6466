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
 * appends the digest rows via `record()`'s ON CONFLICT DO NOTHING. The walk
 * never materialises a file (INV-AUDIT-6).
 *
 * ENVIRONMENT FAULTS ARE NOT CHAIN BREAKS (N5). An unopenable audit store, an
 * unopenable cost ledger and a `gh` that cannot be spawned say nothing about
 * the run — they say the walker could not look. Each is rethrown as
 * `ChainWalkError("walk-environment-fault")` with its remediation, so the CLI
 * exits 2 ("I could not check") rather than publishing a confident
 * "this PR's chain is BROKEN". Only hops the walk genuinely WALKED and found
 * incomplete report `broken`.
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
import { log, newRequestId } from "../lib/log.ts";
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
   * Keyed by contributing runId. DF5.3 walked the parent run alone; DF6.1b
   * extends the map ADDS-ONLY with one entry per contributing fix runId
   * (`extensions.fixLoop.fixOutcome.runIds` on the parent record) — a PR walk
   * resolves the parent's chain AND each fix run's, and a contributing runId
   * whose chain is missing or incomplete is a broken hop, never an ignored one
   * (INV-AUDIT-6). When hop 1 resolved no runId the key falls back to the PR
   * url and then to the raw ref — a lookup key, never a claim that the run
   * exists.
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

/**
 * `walk-environment-fault` is the "I could not look" code (N5): the walker's
 * own substrate refused (no audit store, no cost ledger, no `gh` binary), which
 * is never evidence about the run. The CLI maps it to exit 2 with the
 * remediation, never to a broken-chain verdict.
 */
export type ChainWalkErrorCode = "invalid-ref" | "pr-fetch-failed" | "walk-environment-fault";

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

/**
 * The PR number is BOUNDED to 10 digits. An unbounded `(\d+)` let
 * `.../pull/99999999999999999999999` round-trip through `Number` into
 * `"1e+23"`, which is what was then handed to `gh pr view` as the selector —
 * a `pr-fetch-failed` about a PR number the operator never typed, and a
 * silently imprecise `prNumber` in the report. Over the bound the ref is not a
 * PR URL at all and earns the `invalid-ref` refusal with its remediation.
 */
const PR_URL_RE = /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d{1,10})\/?$/;
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
 * The form test PLUS the two things this file needs and the imported regex
 * does not promise: a length bound and no path separator. `runId` is
 * interpolated straight into `join(runsDir, …)` by `recordPath()`,
 * `artifactsDir()` and `bundlePath()`, and `RUN_ID_FORM_RE` lives in another
 * module that can widen without this one noticing — so the traversal guard is
 * local, not borrowed. The bound also settles a real disagreement between the
 * two ref arms: the bare-runId arm tested `RUN_ID_MAX`, the `qds/<id>` branch
 * arm tested nothing, so an over-length id could enter through the branch form
 * and degrade every record-joined hop into an internal validation message
 * instead of the `invalid-ref` refusal the bare form gives.
 */
function safeRunId(id: string): boolean {
  return (
    id.length > 0 && id.length <= RUN_ID_MAX &&
    !id.includes("/") && !id.includes("\\") && !id.includes("..") &&
    RUN_ID_FORM_RE.test(id)
  );
}
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
  if (branch && safeRunId(branch[1] ?? "")) return { refKind: "branch", runId: branch[1] };
  if (safeRunId(ref)) return { refKind: "run-id", runId: ref };
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

/**
 * How far INSIDE the hop's race budget `gh`'s own kill timer is armed, so the
 * typed `pr-fetch-failed` refusal always beats the race's `hop-timeout` label.
 */
const GH_KILL_MARGIN_MS = 100;

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
const GH_REMEDIATION =
  "authenticate gh (`gh auth status`), or invoke the walk with the bare runId form so hop 1 resolves locally from the run record's extensions.pr";

async function ghFetchPull(ref: string, timeoutMs: number): Promise<{ body: string; headRef?: string; prUrl: string }> {
  const parsed = parseRef(ref);
  const target =
    parsed.refKind === "pr-url"
      ? [String(parsed.prNumber), "--repo", `${parsed.owner}/${parsed.repo}`]
      : [ref];
  // A missing `gh` binary makes `Bun.spawn` throw SYNCHRONOUSLY (ENOENT). That
  // is the walker's substrate, not the run's chain (N5) — an environment fault
  // with its own remediation, never hop 1 reported broken.
  const proc = ((): Bun.Subprocess<"ignore", "pipe", "pipe"> => {
    try {
      return Bun.spawn(["gh", "pr", "view", ...target, "--json", "body,headRefName,url"], {
        stdin: "ignore", stdout: "pipe", stderr: "pipe",
      });
    } catch (e) {
      throw new ChainWalkError(
        "walk-environment-fault",
        `the GitHub CLI could not be started for ${ref}: ${cap((e as Error).message)}`,
        "install the GitHub CLI (`brew install gh`) and authenticate it (`gh auth status`), or invoke the walk with the bare runId form so hop 1 resolves locally from the run record's extensions.pr",
      );
    }
  })();
  const controller = new AbortController();
  const kill = (): void => { try { proc.kill(9); } catch { /* already gone */ } };
  const killer = setTimeout(() => { controller.abort(); kill(); }, Math.max(1, timeoutMs));
  killer.unref?.();
  let code: number;
  let out: { text: string; truncated: boolean };
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
    // Clearing the timer disarms the ONLY thing that would have reaped `gh`.
    // When a `readBounded` rejects for a reason that did not itself kill the
    // child, `Promise.all` rejects immediately, `proc.exited` is never awaited
    // and the process survives the walk holding its pipes. Kill it here.
    if (proc.exitCode === null) kill();
  }
  if (code !== 0) {
    const cause = err.text.trim();
    throw new ChainWalkError(
      "pr-fetch-failed",
      `gh pr view failed for ${ref} (exit ${code})${cause.length === 0 ? "" : `: ${redactSecrets(cause).slice(0, GH_STDERR_EXCERPT_CHARS)}`}`,
      GH_REMEDIATION,
    );
  }
  // The fetch SUCCEEDED and the payload is merely truncated — `readBounded`
  // says so, and parsing it anyway produced a bare `SyntaxError` that is not a
  // ChainWalkError, so hop 1 degraded to "unhandled walk error" with no
  // remediation for a condition the signal names outright.
  if (out.truncated) {
    throw new ChainWalkError(
      "pr-fetch-failed",
      `gh pr view returned more than ${EXEC_MAX_OUTPUT_BYTES} bytes for ${ref}; the JSON payload is truncated and cannot be read`,
      GH_REMEDIATION,
    );
  }
  let body: { body?: unknown; headRefName?: unknown; url?: unknown };
  try {
    body = JSON.parse(out.text) as { body?: unknown; headRefName?: unknown; url?: unknown };
  } catch (e) {
    throw new ChainWalkError("pr-fetch-failed", `gh pr view returned unparsable JSON for ${ref}: ${cap((e as Error).message)}`, GH_REMEDIATION);
  }
  // `null`, an array and a bare number all survive `JSON.parse`; the first of
  // them threw a TypeError on the very next line.
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new ChainWalkError("pr-fetch-failed", `gh pr view returned ${Array.isArray(body) ? "a JSON array" : `a JSON ${body === null ? "null" : typeof body}`} for ${ref}, not an object`, GH_REMEDIATION);
  }
  return {
    body: typeof body.body === "string" ? body.body : "",
    headRef: typeof body.headRefName === "string" ? body.headRefName : undefined,
    prUrl: typeof body.url === "string" ? body.url : ref,
  };
}

/**
 * The walker's ONE diagnostic chokepoint: REDACT, then cap (INV-AUDIT-2).
 * `redactSecrets` used to be applied to `gh` stderr alone, while every other
 * diagnostic went through a bare `slice` — and the messages that reach here are
 * exactly the ones that quote their input: `bun:sqlite` quotes values in
 * constraint and datatype errors, a JSON parse error quotes the offending
 * fragment, `CostLedger` quotes paths, and `RunRecordStore.get` quotes record
 * contents. All of it flowed verbatim into `--json` reports and log lines.
 *
 * The cap trims a trailing lone HIGH SURROGATE: slicing at a fixed UTF-16 index
 * can cut a non-BMP character in half, and the orphaned unit corrupts on any
 * downstream UTF-8 write of the report.
 */
const cap = (text: string): string => {
  const redacted = redactSecrets(text);
  if (redacted.length <= DIAGNOSTIC_MAX_CHARS) return redacted;
  const sliced = redacted.slice(0, DIAGNOSTIC_MAX_CHARS - 1);
  const tail = sliced.charCodeAt(sliced.length - 1);
  return `${tail >= 0xd800 && tail <= 0xdbff ? sliced.slice(0, -1) : sliced}…`;
};
const digestOf = (value: unknown): string => sha256Hex(canonicalJson(value));
/**
 * CANONICAL UTC ISO-8601 or nothing — the store's own write-time rule
 * (`validateAndBind` in link-store.ts), applied on the read side because the
 * three stamps hop 8 orders (`approval.decidedAt`, `pr.createdAt`, the bound
 * report's `completedAt`) never came from `audit_links` and were never checked
 * by it.
 *
 * Bare `Date.parse` accepts `"March 5, 2026"`, `"2026"` and — worst —
 * `"2026-09-16T10:00:00"`, which it reads as LOCAL time. Comparing one of those
 * against a `Z` stamp shifts by the walker host's UTC offset, so the same
 * records resolved on a UTC CI runner and reported `order-violation` on a
 * developer machine in UTC+2. Every diagnostic that rejects one of these
 * already says "as an ISO-8601 stamp"; now that is what was checked.
 */
const msOf = (iso: string | undefined): number | undefined => {
  if (typeof iso !== "string") return undefined;
  const parsed = Date.parse(iso);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== iso) return undefined;
  return parsed;
};
/**
 * `Date.parse` alone — for NORMALISING a subject's own stamp into the canonical
 * spelling the store demands (`new Date(ms).toISOString()`), never for
 * ordering. Ordering goes through `msOf`, which refuses a stamp it cannot
 * compare across time bases.
 */
const msOfLoose = (iso: string | undefined): number | undefined => {
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
      /** How many `sessions` rows shared the request id (>1 is lawful; the first binds). */
      sessionRows: number;
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
 * (AC7). Reported in CONSTRAINT order (see `HopOutcome`'s `order-violation`).
 *
 * WITHIN a generation, never across mixed ones. Taking `newestOf` for every
 * event independently and then comparing the picks reported `order-violation`
 * on exactly the shapes `rowsByEvent` declares lawful: a re-mint with a new
 * keyHash, a re-provision with a new vmName, a re-harvest with a new bundle sha
 * all repeat a PREFIX event without repeating the suffix, so
 * `newestOf("mint") > newestOf("deliver")` on a perfectly healthy run. That is
 * the same class of permanent false alarm the hop-6 comment says the
 * newest-row rule was introduced to fix, reintroduced one pass later.
 *
 * The selection runs BACKWARDS: newest row of the last event, then for each
 * preceding event the newest row at or before the pick that follows it. A
 * violation is real only when an event has NO row at or before its successor —
 * i.e. even its oldest instance happened after the event the constraint puts
 * last. Absent events are skipped (the callers check presence first and decide
 * their own `unlinked` outcome).
 *
 * An UNPARSABLE stamp is its own typed outcome, never a skipped constraint:
 * `10 → garbage → 5` used to report no violation at all, because `msOf`
 * returned `undefined` and the loop simply continued.
 */
type Lifecycle =
  | { kind: "ok"; rows: AuditLinkRow[] }
  | { kind: "violation"; earlier: string; later: string }
  | { kind: "unparsable"; row: AuditLinkRow };

function orderedLifecycle(byEvent: Map<string, AuditLinkRow[]>, events: readonly string[]): Lifecycle {
  const buckets = events.map((ev) => byEvent.get(ev) ?? []);
  for (const bucket of buckets) {
    for (const row of bucket) if (msOf(row.occurredAt) === undefined) return { kind: "unparsable", row };
  }
  const picked: AuditLinkRow[] = [];
  let ceilingMs = Number.POSITIVE_INFINITY;
  let successor: AuditLinkRow | undefined;
  for (let i = buckets.length - 1; i >= 0; i--) {
    const bucket = buckets[i] as AuditLinkRow[];
    if (bucket.length === 0) continue;
    let choice: AuditLinkRow | undefined;
    for (let j = bucket.length - 1; j >= 0; j--) {
      const row = bucket[j] as AuditLinkRow;
      if ((msOf(row.occurredAt) as number) <= ceilingMs) { choice = row; break; }
    }
    if (choice === undefined) {
      // Not one instance of this event precedes the one after it.
      return { kind: "violation", earlier: (bucket[0] as AuditLinkRow).occurredAt, later: successor?.occurredAt ?? "" };
    }
    picked[i] = choice;
    ceilingMs = msOf(choice.occurredAt) as number;
    successor = choice;
  }
  return { kind: "ok", rows: picked.filter((r): r is AuditLinkRow => r !== undefined) };
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

/**
 * DF6.1b: the contributing fix runIds a parent record names, in attempt order,
 * parsed tolerantly from the JSON-encoded `fixLoop.fixOutcome` string. Empty
 * when the record is absent, carries no fixOutcome, or the payload is torn —
 * a torn payload contributes NOTHING here (the loop's own INV-7 discipline
 * owns the write; the walker only reads what landed).
 */
function contributingRunIdsOf(rec: RunRecord | undefined): string[] {
  if (rec === undefined) return [];
  const raw = (rec.extensions?.fixLoop as Record<string, unknown> | undefined)?.fixOutcome;
  if (typeof raw !== "string") return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return [];
    const runIds = (parsed as { runIds?: unknown }).runIds;
    if (!Array.isArray(runIds)) return [];
    return runIds.filter((id): id is string => typeof id === "string" && id.length > 0);
  } catch {
    return [];
  }
}

/** The typed broken hop a contributing runId whose chain cannot resolve reports (INV-AUDIT-6). */
function brokenContributorChain(fixRunId: string, diagnostic: string): RunChain {
  const hops = Object.fromEntries(
    HOPS.map((h) => [h, { status: "broken", hop: h, expected: "a resolvable contributing run chain", actual: "unresolved", diagnostic } as HopOutcome]),
  ) as Record<HopName, HopOutcome>;
  return { runId: fixRunId, complete: false, hops };
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
  /** `extensions.pr` is present but is not a JSON object (older schema, hand-edit). */
  let prEntryMalformed = false;
  let prUrl: string | undefined;
  /** ONE handle for the whole walk: inode-verified reader AND first-observation appender. */
  let auditStore: AuditStoreWalkHandle | undefined;
  let trace: TraceRead | undefined;
  let boundReport: ReverifyReport | undefined;
  /**
   * First-observation rows the current hop WANTS written, held until `timed`
   * settles the hop. A row must never be persisted for a hop the report calls
   * `hop-timeout` (a later walk would then compare against a baseline
   * established by a run that reported nothing), and an abandoned hop must
   * never reach the store at all — its continuation runs after the walk's
   * `finally` has closed the handle.
   */
  let pendingDigestRows: Parameters<AuditStoreWriter["record"]>[0][] = [];
  /**
   * Why an authorizing hop is NOT digest-attested, by hop. `authorizingDigest`
   * returning `undefined` is indistinguishable from "the digest matched", so an
   * unresolvable `repoSlug`/`requestId` silently switched tamper detection off
   * for hops 1/7/8 — forever, since no baseline row is ever written and the
   * next walk repeats it. An unattested hop now SAYS it is unattested.
   */
  const digestCoverage = new Map<HopName, string>();
  const coverageDetail = (hop: HopName): { digestCoverage?: string } => {
    const reason = digestCoverage.get(hop);
    return reason === undefined ? {} : { digestCoverage: reason };
  };

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
      // `get()` is TYPED as returning a record and throws for a missing one —
      // but every hop guarded on `recordError` alone, so a nullish return would
      // have walked on with `record === undefined` and hop 5 would emit the
      // confident, FALSE "no reap link exists and the run is not provably torn
      // down" about a record nobody could read. `recordBroken`'s own `"absent"`
      // arm was unreachable proof that this shape was expected; it is reachable
      // now.
      const got = recordStore.get(runId) as RunRecord | undefined;
      if (got === undefined || got === null) recordError = "absent";
      else record = got;
    } catch (e) {
      recordError = cap((e as Error).message);
    }
  };

  /** The one guard every record-joined hop uses: unreadable AND absent. */
  const recordUnavailable = (): boolean => {
    readRecord();
    return recordError !== undefined || record === undefined;
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
    const ext = record?.extensions as Record<string, unknown> | undefined;
    const entry = ext?.pr;
    if (entry === undefined || entry === null) return undefined;
    // A string/number/array `extensions.pr` used to be cast to
    // `Record<string, unknown>` unchecked, so hop 1 reported "no pr entry" for
    // an entry that is present and CORRUPT — sending the operator to look for a
    // missing PR stamp rather than a malformed one — and `prDetail`/`digestOf`
    // quietly treated the malformed value as an object.
    if (typeof entry !== "object" || Array.isArray(entry)) {
      prEntryMalformed = true;
      return undefined;
    }
    prEntry = entry as Record<string, unknown>;
    return prEntry;
  };

  /**
   * The walk's ONE inode-verified handle. A store that cannot be opened is an
   * ENVIRONMENT fault, not a broken chain (N5): it says the walker could not
   * look, never that the run's evidence is missing. Scoring it against hops
   * 4/5/6 published "this PR's chain is BROKEN" for a mistyped `QDS_AUDIT_DB`.
   */
  const openAudit = (): void => {
    if (auditStore !== undefined) return;
    try {
      auditStore = openAuditStoreForWalk(auditDb);
    } catch (e) {
      // C-1: narrow on the TYPED store error and report its `code` — never a
      // raw driver errno, which carries no remediation.
      if (e instanceof AuditStoreError) {
        throw new ChainWalkError("walk-environment-fault", `the audit-link store at ${auditDb} could not be opened (${e.code}): ${cap(e.message)}`, e.remediation);
      }
      throw new ChainWalkError("walk-environment-fault", `the audit-link store at ${auditDb} could not be opened: ${cap((e as Error).message)}`, "inspect the audit store path, or point QDS_AUDIT_DB at the store this run's links were emitted to");
    }
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
   * QUEUE the insert for `timed` to flush once the hop has settled
   * non-timed-out (ON CONFLICT DO NOTHING via record()).
   *
   * The walk's ONE inode-verified handle does the appending — never a second
   * by-path open: `openAuditStoreForWalk` returns an appender as well as a
   * reader, so the row goes through the handle whose inode the open already
   * proved, instead of through a fresh `openAuditStore()` that re-resolves the
   * path and could bind a replacement.
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
   * observation is then genuinely the only event there is. The stamp is
   * NORMALISED through `new Date(ms).toISOString()`: the store refuses anything
   * that is not canonical, and the everyday subject stamp — GitHub's
   * second-precision `extensions.pr.createdAt` — is not. That refusal used to
   * land in an empty `catch`, so NO baseline row was ever written, the next
   * walk found no prior, and tamper detection for hops 1/7/8 was off,
   * silently, forever.
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
    // Hops 1/7/8 are SINGULAR (module header). More than one walk-observed row
    // is itself a violation of that invariant, and picking `priors[0]` out of
    // them INVERTS the diagnosis: `occurredAt` is the subject's OWN stamp, so a
    // tampered subject backdated to an earlier `decidedAt` sorts first under
    // `linksForRun`'s (occurred_at, link_id) and gets reported as the
    // legitimate expectation. Refuse instead of guessing.
    if (priors.length > 1) {
      return {
        status: "broken", hop,
        expected: `exactly one ${WALK_OBSERVED_EVENT} row for (${runId}, ${hop}) — hops 1/7/8 are singular`,
        actual: `${priors.length} rows: ${priors.map((p) => `#${p.linkId} ${JSON.stringify(p.subjectId ?? null)}`).join(", ")}`,
        diagnostic: "two walk-observed baselines for one authorizing record cannot both be the expectation; neither is binding until the extra rows are accounted for",
        evidencePath,
      };
    }
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
    if (typeof requestId !== "string" || requestId.length === 0) {
      digestCoverage.set(hop, "unattested: the run record carries no requestId, so no first-observation baseline could be written — this hop is NOT tamper-checked");
      return undefined;
    }
    if (repoSlug.length === 0 || repoSlug === "unknown") {
      digestCoverage.set(hop, "unattested: no repo slug could be resolved for this run, so no first-observation baseline could be written — this hop is NOT tamper-checked");
      return undefined;
    }
    const recordedAt = now().toISOString();
    // Canonical or the walk's clock — never the subject's raw spelling.
    const subjectMs = msOfLoose(subjectOccurredAt);
    const occurredAt = subjectMs === undefined ? recordedAt : new Date(subjectMs).toISOString();
    pendingDigestRows.push({
      runId, repoSlug, requestId, hop, event: WALK_OBSERVED_EVENT,
      subjectId, subjectKind, evidencePath, evidenceDigest: digest, occurredAt, recordedAt,
    });
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
    //
    // WAL FIRST, then the .db. The two copies cannot be atomic — the module
    // header says the harvested WAL is hot, and snapshotting the pair through
    // SQLite (`VACUUM INTO`, the backup API) needs a connection to the SOURCE,
    // which in WAL mode with no -shm cannot be opened read-only and would write
    // an -shm into the artifacts directory this walk is forbidden to touch.
    // The ORDER is what makes the non-atomic pair safe: if a checkpoint lands
    // between the two copies, the copied WAL's salt no longer matches the (now
    // newer) copied .db, SQLite silently ignores the WAL — and the .db already
    // contains everything the checkpoint folded in, so nothing is lost. The
    // reverse order (.db first) loses exactly those rows, which read as
    // `gateCount === 0` and made hop 9 report "a run with no gate evidence" on
    // a healthy run.
    // ponytail: source-side snapshot is the only fully atomic answer; it needs
    // a harvest-time change (ship a checkpointed trace), not a walker one.
    const tmp = mkdtempSync(join(tmpdir(), "qds-audit-trace-"));
    try {
      const copyPath = join(tmp, "trace.db");
      const walPath = `${tracePath}-wal`;
      if (existsSync(walPath)) {
        try {
          copyFileSync(walPath, `${copyPath}-wal`);
        } catch (e) {
          // A checkpoint can remove the -wal between the probe and the copy;
          // the .db below then already carries its contents.
          if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
        }
      }
      try {
        copyFileSync(tracePath, copyPath);
      } catch (e) {
        // `existsSync` above is a check-then-open: a harvest cleanup can remove
        // the trace between the two. That is the not-harvested shape, not an
        // "unhandled walk error".
        if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
        trace = { kind: "not-harvested", evidencePath: artifactsDir(), reason: `the harvested trace at ${tracePath} was removed while this walk was copying it` };
        return trace;
      }
      const db = new Database(copyPath);
      try {
        db.exec("PRAGMA busy_timeout = 5000;");
        readRecord();
        const requestId = record?.requestId;
        const joinable = typeof requestId === "string" && requestId.length > 0;
        // Each table in its OWN try/catch: a trace missing one of them must not
        // take the other's hop down with it (see `TraceRead`).
        let session: { repoSlug: string | null; issueId: string | null } | null = null;
        let sessionRows = 0;
        let sessionError: string | undefined;
        if (joinable) {
          try {
            // ORDER BY rowid: `request_id` carries no uniqueness guarantee (a
            // retry or a resumed session writes a second row), and an
            // unordered `get()` let SQLite decide which one hop 2's
            // fail-closed tamper branch was evaluated against. The oldest row
            // is the session the run started under; the COUNT is reported so a
            // reader can see there was more than one.
            const rows = db.prepare("SELECT repo_slug, issue_id FROM sessions WHERE request_id = ? ORDER BY rowid").all(requestId as string) as
              { repo_slug: unknown; issue_id: unknown }[];
            sessionRows = rows.length;
            const sessionRow = rows[0];
            session =
              sessionRow === undefined
                ? null
                : {
                    // RAW, never `cap()`: these two columns feed hop 2's
                    // EQUALITY JOIN against the record's canonicalised pair,
                    // and `cap` is the diagnostic chokepoint (redactSecrets
                    // then cap) — running the join data through it let the
                    // redactor's ≥40-char token heuristic rewrite a lawful
                    // `owner/repo` slug (e.g. quantum-digital-solutions/
                    // qds-audit-demo, exactly 40 units of the token charset)
                    // to «redacted», and the hop then reported the run's OWN
                    // slug as a tamper disagreement (INV-AUDIT-1 false
                    // positive, live 2026-09-18). The columns are bounded at
                    // the WRITER — `resolveRunCorrelation`'s charset and
                    // length validation gates every initiateSession — and
                    // identifiers are INV-AUDIT-2's admitted class ("ids,
                    // digests, hops, paths and codes"). The `typeof` guard
                    // stays: the store is a box-written file, and a non-string
                    // must read as null (corroborates nothing) rather than
                    // throw the walk.
                    repoSlug: typeof sessionRow.repo_slug === "string" ? sessionRow.repo_slug : null,
                    // The column is INTEGER; the record side is a string. Both
                    // sides are String()-ed so an uncoerced 42 === "42" cannot
                    // report tamper on a healthy run. Same no-cap rule: an
                    // issue number is the admitted class, and the heuristic
                    // has nothing to say about digits anyway.
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
              // (`cap` redacts as well as bounds — capping is length control,
              // not redaction, and with GATE_ROWS_IN_DETAIL = 50 this is up to
              // ~200 KB of box-written text per report.)
              gate: typeof r.gate === "string" ? cap(r.gate) : null,
              passed: r.passed === null || r.passed === undefined ? null : Number(r.passed),
              phaseId: typeof r.phase_id === "string" ? cap(r.phase_id) : null,
              attempt: r.attempt === null || r.attempt === undefined ? null : Number(r.attempt),
            }));
          } catch (e) {
            gatesError = cap((e as Error).message);
          }
        }
        trace = { kind: "ok", tracePath, session, sessionRows, gates, gateCount, ...(sessionError !== undefined ? { sessionError } : {}), ...(gatesError !== undefined ? { gatesError } : {}) };
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

  /**
   * INV-AUDIT-1 scope: audit identity is `(repo_slug, run_id)`, never the run
   * id alone. `linksForRun` selects on the run id only, so a row emitted under
   * a DIFFERENT repo slug — a run id colliding across repos, or a forged row
   * appended by a repo that has no business in this chain — was read as this
   * run's evidence by hops 4/5/6. Fail closed: a foreign row makes the hop
   * broken rather than being silently dropped, because dropping it would let a
   * forgery decide which rows the walk did not see.
   *
   * Skipped when no slug can be resolved at all ("unknown"): there is nothing
   * to scope against, and scoring that against the chain is the environment
   * fault N5 rules out.
   */
  const foreignSlugRow = (rows: readonly AuditLinkRow[], hop: HopName): HopOutcome | undefined => {
    const expected = repoSlugFor();
    if (expected === "unknown") return undefined;
    const foreign = rows.find((r) => r.repoSlug !== expected);
    if (foreign === undefined) return undefined;
    return {
      status: "broken", hop,
      expected: `every ${hop} link row scoped to repo ${expected}`,
      actual: `link #${foreign.linkId} (${hop}.${foreign.event}) carries repo_slug ${JSON.stringify(foreign.repoSlug)}`,
      diagnostic: "audit identity is (repo_slug, run_id), never the run id alone (INV-AUDIT-1) — a row from another repo is not this run's evidence",
      evidencePath: auditDb,
    };
  };

  // ── hop bodies 4–9 (closures over the shared state above) ──

  function hop4credential(): HopOutcome {
    const rid = runId as string;
    // The record is read BEFORE anything reads a field off it: this hop's
    // `keyHash` fallback used to read `record?.keyHash` off whatever state an
    // earlier hop happened to populate, so an unreadable record silently became
    // "no keyHash" instead of the named broken hop hops 2/7/8/9 all report.
    if (recordUnavailable()) return recordBroken("run-credential");
    openAudit();
    const links = auditStore?.linksForRun(rid) ?? [];
    const byEvent = rowsByEvent(links, "run-credential");
    const missing = CREDENTIAL_EVENTS.filter(([ev]) => !byEvent.has(ev));
    if (missing.length > 0) {
      return { status: "unlinked", hop: "run-credential", emitter: missing.map(([, em]) => em).join(", "), diagnostic: `no audit_links row for run-credential event(s) ${missing.map(([ev]) => ev).join(", ")} — links are emitted at the event, never inferred (INV-AUDIT-4)` };
    }
    // EVERY row for the hop, not just the rows whose event is in the lifecycle
    // table: an out-of-vocabulary row (a future `rotate`, a fabricated event)
    // is counted in `rowsPerEvent` and reported in `detail`, so leaving it
    // un-digested showed the row exists while implying the hop verified it.
    const everyRow = [...byEvent.values()].flat();
    const foreign = foreignSlugRow(everyRow, "run-credential");
    if (foreign !== undefined) return foreign;
    const mismatch = firstDigestMismatch(everyRow, auditDb);
    if (mismatch !== undefined) return mismatch;
    const lifecycle = orderedLifecycle(byEvent, CREDENTIAL_EVENTS.map(([ev]) => ev));
    if (lifecycle.kind === "unparsable") return unparsableStamp("run-credential", lifecycle.row, auditDb);
    if (lifecycle.kind === "violation") {
      return { status: "order-violation", hop: "run-credential", constraint: "mint <= deliver <= revoke <= verify-revoked (non-decreasing)", earlier: lifecycle.earlier, later: lifecycle.later };
    }
    const ordered = lifecycle.rows;
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
        // The SELECTED generation, which is what the ordering ran over.
        events: Object.fromEntries(CREDENTIAL_EVENTS.map(([ev], i) => [ev, { occurredAt: ordered[i]?.occurredAt, linkId: ordered[i]?.linkId }])),
        linkIds: Object.fromEntries(CREDENTIAL_EVENTS.map(([ev], i) => [ev, ordered[i]?.linkId])),
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
    if (recordUnavailable()) return recordBroken("run-box");
    openAudit();
    const links = auditStore?.linksForRun(rid) ?? [];
    const byEvent = rowsByEvent(links, "run-box");
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
    // Every row for the hop, tabled event or not (see hop 4).
    const everyRow = [...byEvent.values()].flat();
    const foreign = foreignSlugRow(everyRow, "run-box");
    if (foreign !== undefined) return foreign;
    const mismatch = firstDigestMismatch(everyRow, auditDb);
    if (mismatch !== undefined) return mismatch;
    const selection = orderedLifecycle(byEvent, lifecycleEvents);
    if (selection.kind === "unparsable") return unparsableStamp("run-box", selection.row, auditDb);
    if (selection.kind === "violation") {
      return { status: "order-violation", hop: "run-box", constraint: `create <= fill <= setup-gate <= teardown${reapRow !== undefined ? " <= reap" : ""} (non-decreasing)`, earlier: selection.earlier, later: selection.later };
    }
    const lifecycle = selection.rows;
    const duplicates = duplicateCounts(byEvent);
    return {
      status: "resolved", hop: "run-box", runId: rid,
      subjectId: lifecycle[0]?.subjectId ?? rid,
      evidencePath: lifecycle[0]?.evidencePath, linkId: lifecycle[0]?.linkId,
      detail: {
        closedAt, vmName: record?.vmName,
        events: Object.fromEntries([
          ...BOX_EVENTS.map(([ev], i) => [ev, { occurredAt: lifecycle[i]?.occurredAt, linkId: lifecycle[i]?.linkId }]),
          ["reap", reap],
        ]),
        ...(duplicates !== undefined ? { rowsPerEvent: duplicates } : {}),
      },
    };
  }

  function hop6bundle(): HopOutcome {
    const rid = runId as string;
    // The record is what `repoSlugFor()` scopes the link rows against.
    readRecord();
    openAudit();
    const path = bundlePath();
    if (!existsSync(path)) {
      return { status: "evidence-not-harvested", hop: "run-bundle", reason: `no bundle at ${path} — harvestRun's verify/fetch steps never produced it (a lawful post-harvest deletion, or a noHarvest teardown with no earlier harvestRun)`, evidencePath: path };
    }
    const byEvent = rowsByEvent(auditStore?.linksForRun(rid) ?? [], "run-bundle");
    if (!byEvent.has("bundle-verify")) {
      return { status: "unlinked", hop: "run-bundle", emitter: "harvestRun (bundle-verify)", diagnostic: "the bundle exists but no bundle-verify link row was emitted at harvest time" };
    }
    if (!byEvent.has("bundle-fetch")) {
      return { status: "unlinked", hop: "run-bundle", emitter: "harvestRun (bundle-fetch)", diagnostic: "bundle-verify is linked but bundle-fetch was never emitted" };
    }
    const everyRow = [...byEvent.values()].flat();
    const foreign = foreignSlugRow(everyRow, "run-bundle");
    if (foreign !== undefined) return foreign;
    const mismatch = firstDigestMismatch(everyRow, path);
    if (mismatch !== undefined) return mismatch;
    // A lawful in-place re-harvest (`--force`, AC5) emits a SECOND row per
    // event under a new subject (`${bundlePath}#${sha256}` / `#${tip}`), so the
    // newest CONSISTENT generation is the one that describes the bundle on disk
    // now. Assuming exactly one row froze `detail.sha256` at the first bundle
    // and reported evidence-mismatch on a healthy run forever.
    const selection = orderedLifecycle(byEvent, ["bundle-verify", "bundle-fetch"]);
    if (selection.kind === "unparsable") return unparsableStamp("run-bundle", selection.row, path);
    if (selection.kind === "violation") {
      return { status: "order-violation", hop: "run-bundle", constraint: "bundle-verify <= bundle-fetch (non-decreasing)", earlier: selection.earlier, later: selection.later };
    }
    const verifyRow = selection.rows[0] as AuditLinkRow;
    const fetchRow = selection.rows[1] as AuditLinkRow;
    // Streamed in 64 KiB chunks over the RAW BYTES — never
    // `bytes.toString("latin1")`. A CryptoHasher fed a string encodes it as
    // UTF-8, so a latin1 round-trip silently expands every byte >= 0x80 into
    // two and the digest of any real (binary) bundle stops matching
    // harvest.ts's `sha256File`. That mismatch reported `evidence-mismatch` on
    // every harvested bundle; ASCII-only fixtures never see it.
    //
    // ENOENT is tolerated around the hash/stat: `existsSync` above is a
    // check-then-open, and the hop's own reason string calls a concurrent
    // post-harvest deletion lawful — so losing that race must produce
    // `evidence-not-harvested`, not "unhandled walk error at hop run-bundle".
    let actualDigest: string;
    let bundleBytes: number;
    try {
      actualDigest = sha256File(path);
      bundleBytes = statSync(path).size;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
      return { status: "evidence-not-harvested", hop: "run-bundle", reason: `the bundle at ${path} was removed while this hop was reading it (a lawful post-harvest deletion)`, evidencePath: path };
    }
    // Hex digests compare CASE-INSENSITIVELY: `sha256File` returns lowercase,
    // and an emitter that wrote uppercase hex would otherwise produce a false
    // tamper report on a byte-identical bundle — the most expensive false
    // positive this file can make.
    const claimed = (verifyRow.detail as { sha256?: unknown } | null | undefined)?.sha256;
    if (typeof claimed === "string" && claimed.toLowerCase() !== actualDigest) {
      return { status: "evidence-mismatch", hop: "run-bundle", expectedDigest: claimed, actualDigest, evidencePath: path };
    }
    // Every bundle-verify row's claim is REPORTED even though only the newest
    // generation binds: the older rows describe bundles that no longer exist
    // (that is what makes a re-harvest lawful), so failing on them would
    // reintroduce the permanent false mismatch above — but a reader must be
    // able to see that a second row superseded the first.
    const verifyBucket = byEvent.get("bundle-verify") ?? [];
    const claims = verifyBucket.length <= 1
      ? undefined
      : verifyBucket.map((r) => ({ linkId: r.linkId, occurredAt: r.occurredAt, sha256: (r.detail as { sha256?: unknown } | null | undefined)?.sha256 }));
    const duplicates = duplicateCounts(byEvent);
    return {
      status: "resolved", hop: "run-bundle", runId: rid,
      subjectId: verifyRow.subjectId ?? rid,
      evidencePath: path, evidenceDigest: verifyRow.evidenceDigest, linkId: verifyRow.linkId,
      detail: {
        sha256: actualDigest, bundleBytes,
        linkIds: { "bundle-verify": verifyRow.linkId, "bundle-fetch": fetchRow.linkId },
        ...(claims !== undefined ? { bundleVerifyClaims: claims } : {}),
        ...(duplicates !== undefined ? { rowsPerEvent: duplicates } : {}),
      },
    };
  }

  function hop7reverify(): HopOutcome {
    const rid = runId as string;
    if (recordUnavailable()) return recordBroken("run-reverify");
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
    const matches = reports.filter((r) => r.reverifyId === reportId);
    const bound = matches[0];
    if (bound === undefined) {
      return { status: "broken", hop: "run-reverify", expected: `ReverifyReport ${reportId}`, actual: `${reports.length} report(s) at ${path}, none with that id`, diagnostic: "a reportId resolving to no line cannot authorize anything; the in-box gate results are a claim, never authority (INV-AUDIT-5)", evidencePath: path };
    }
    // The file is append-only JSONL, so two lines can claim one id with
    // different verdicts. `find` silently vouched for the first while any
    // consumer taking the last saw the other — two reports claiming one id is
    // itself evidence this chain must not vouch for.
    if (matches.length > 1) {
      return { status: "broken", hop: "run-reverify", expected: `exactly one ReverifyReport line with reverifyId ${reportId}`, actual: `${matches.length} lines share that id (verdicts: ${matches.map((r) => JSON.stringify(r.verdict)).join(", ")})`, diagnostic: "a duplicated reverifyId makes the bound report ambiguous; neither line can authorize the approval that cites it", evidencePath: path };
    }
    boundReport = bound;
    const mismatch = authorizingDigest("run-reverify", reportId, bound, path, "reverify-report", bound.completedAt);
    if (mismatch !== undefined) return mismatch;
    return {
      status: "resolved", hop: "run-reverify", runId: rid, subjectId: reportId,
      evidencePath: path, evidenceDigest: digestOf(bound),
      detail: { verdict: bound.verdict, completedAt: bound.completedAt, headSha: bound.headSha, testResults: bound.testResults, ...coverageDetail("run-reverify") },
    };
  }

  function hop8approval(): HopOutcome {
    const rid = runId as string;
    if (recordUnavailable()) return recordBroken("run-approval");
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
      detail: { approverId, decidedAt, reportId: approval.reportId, headSha: approval.headSha, ...coverageDetail("run-approval") },
    };
  }

  function hop9gateEvidence(): HopOutcome {
    const rid = runId as string;
    if (recordUnavailable()) return recordBroken("run-gate-evidence");
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
     *
     * CANCELLATION. `Promise.race` cancels nothing: the losing hop body keeps
     * running and its continuation lands after the report was assembled and
     * after the walk's `finally` closed the store. `fn` therefore receives a
     * `live()` predicate — false once the timer has won — and hop 1 (the only
     * awaiting hop, so the only one that can lose) checks it the instant its
     * await returns, BEFORE assigning `runId`/`prUrl`/`prEntry` or touching the
     * store. Without it a timed-out hop 1 on a branch ref left eight `resolved`
     * hops standing against a runId taken from an unverified branch name, and a
     * timed-out hop 1 on a PR url rewrote the report's own `runs` key after
     * every hop inside it had said no runId was resolved.
     */
    const timed = async (
      hop: HopName,
      fn: (ctx: { live: () => boolean; budgetMs: number }) => HopOutcome | Promise<HopOutcome>,
    ): Promise<void> => {
      pendingDigestRows = [];
      const remainingTotal = TOTAL_CEILING_MS - (Date.now() - startedAt);
      if (remainingTotal <= 0) {
        perHopMs[hop] = 0;
        outcomes[hop] = { status: "hop-timeout", hop, ceilingMs: TOTAL_CEILING_MS, elapsedMs: Date.now() - startedAt, budget: "total" };
        return;
      }
      const budget: "hop" | "total" = ceiling <= remainingTotal ? "hop" : "total";
      const raceMs = Math.min(ceiling, remainingTotal);
      const t0 = Date.now();
      // A non-positive ceiling means "already expired". The hop body runs in a
      // MICROTASK and a timer is a macrotask, so a synchronous hop always won a
      // `raceMs = 0` race and then passed the post-hoc `elapsed > 0` test too
      // whenever `Date.now()` had not ticked — `hopCeilingMs: 0` resolved hops
      // normally while hop 1 (whose `ghFetchPull` clamps to `max(1, 0)`) did
      // something else again. One option, one meaning.
      if (raceMs <= 0) {
        perHopMs[hop] = 0;
        outcomes[hop] = { status: "hop-timeout", hop, ceilingMs: budget === "hop" ? ceiling : TOTAL_CEILING_MS, elapsedMs: 0, budget };
        return;
      }
      let timer: ReturnType<typeof setTimeout> | undefined;
      let settled = false;
      let out: HopOutcome;
      try {
        const raced = await Promise.race<{ timedOut: false; out: HopOutcome } | { timedOut: true }>([
          Promise.resolve().then(() => fn({ live: () => !settled, budgetMs: raceMs })).then((o) => ({ timedOut: false as const, out: o })),
          new Promise((resolve) => {
            timer = setTimeout(() => { settled = true; resolve({ timedOut: true }); }, raceMs);
            timer.unref?.();
          }),
        ]);
        out = raced.timedOut
          ? {
              status: "hop-timeout", hop,
              ceilingMs: budget === "hop" ? ceiling : TOTAL_CEILING_MS,
              // `budget: "total"` is a WALK-wide exhaustion, so it reports
              // walk-wide elapsed. Reporting per-hop elapsed against the
              // walk-wide ceiling made the pair internally incoherent
              // (`ceilingMs: 30000, elapsedMs: 900`) and disagreed with the
              // sibling arm six lines up, which uses walk-wide elapsed for the
              // same `budget` value.
              elapsedMs: budget === "hop" ? Date.now() - t0 : Date.now() - startedAt,
              budget,
            }
          : raced.out;
      } catch (e) {
        // C9: a typed walk refusal is the CLI's to handle (exit 2 with its
        // remediation). Flattening it here made ChainWalkError("pr-fetch-failed")
        // unreachable and the CLI's dedicated handler dead code.
        if (e instanceof ChainWalkError) throw e;
        out = { status: "broken", hop, expected: "hop resolution", actual: cap((e as Error).message), diagnostic: `unhandled walk error at hop ${hop}`, evidencePath: runId !== null ? recordPath() : ref };
      } finally {
        settled = true;
        if (timer !== undefined) clearTimeout(timer);
      }
      const elapsed = Date.now() - t0;
      perHopMs[hop] = elapsed;
      // AC4: a hop over its ceiling fails closed as hop-timeout, never
      // resolved. This is the post-hoc arm for the sync-blocking case above.
      // It overwrites `resolved` and NOTHING ELSE: the exclusion list used to
      // name `broken`/`hop-timeout` only, so `evidence-mismatch` and
      // `order-violation` — the two outcomes that report DETECTED TAMPERING,
      // with the digest pair — were replaced by a timing label. Both break the
      // chain either way, so the verdict was unchanged and the diagnosis was
      // lost: the operator was told "slow" where the walk found forgery.
      if (elapsed > ceiling && out.status === "resolved") {
        out = { status: "hop-timeout", hop, ceilingMs: ceiling, elapsedMs: elapsed, budget: "hop" };
      }
      // The walk's ONLY write, flushed here and only here. A hop the report
      // calls `hop-timeout` must not leave a first-observation baseline behind
      // (a later walk would then compare against a run that reported nothing),
      // and an abandoned continuation must never reach a handle the walk's
      // `finally` may already have closed.
      if (out.status !== "hop-timeout" && pendingDigestRows.length > 0 && auditStore !== undefined) {
        const rows = pendingDigestRows;
        pendingDigestRows = [];
        try {
          for (const row of rows) auditStore.record(row);
        } catch (e) {
          // C-1: the typed store refusal, by CODE. The empty catch this
          // replaces swallowed `audit-link-invalid` (a non-canonical subject
          // stamp) and `audit-store-identity-changed` (the store replaced
          // mid-walk) — so no baseline was ever written and tamper detection
          // for hops 1/7/8 was permanently, silently off. A baseline that could
          // not be recorded is not a hop this walk vouches for.
          const code = e instanceof AuditStoreError ? e.code : "audit-store-unreadable";
          out = { status: "broken", hop, expected: `the first-observation ${WALK_OBSERVED_EVENT} row for ${hop}`, actual: code, diagnostic: cap((e as Error).message), evidencePath: auditDb };
        }
      }
      pendingDigestRows = [];
      outcomes[hop] = out;
    };

    // ── hop 1: ref → PR → contributing runId ──
    await timed("pr-run", async ({ live, budgetMs }): Promise<HopOutcome> => {
      if (parsed.refKind === "run-id") {
        if (recordUnavailable()) return recordBroken("pr-run");
        readPrEntry();
        if (prEntryMalformed) {
          return { status: "broken", hop: "pr-run", expected: "extensions.pr to be a JSON object carrying prUrl", actual: "extensions.pr is present but is not an object", diagnostic: "a malformed pr entry is not a missing one; the operator is looking for a corrupt stamp, not an absent one", evidencePath: recordPath() };
        }
        prUrl = typeof prEntry?.prUrl === "string" ? prEntry.prUrl : undefined;
        if (prUrl === undefined) {
          return { status: "broken", hop: "pr-run", expected: "extensions.pr.prUrl in the run record", actual: "no pr entry", diagnostic: `the runId form resolves hop 1 locally from ${recordPath()} — zero network`, evidencePath: recordPath() };
        }
        const mismatch = authorizingDigest("pr-run", prUrl, prEntry, recordPath(), "run-record.pr", prCreatedAtOf(prEntry));
        if (mismatch !== undefined) return mismatch;
        return { status: "resolved", hop: "pr-run", runId: runId as string, subjectId: prUrl, evidencePath: recordPath(), evidenceDigest: digestOf(prEntry), detail: { ...prDetail(prEntry), ...coverageDetail("pr-run") } };
      }
      const fetchStart = Date.now();
      let pull: { body: string; headRef?: string; prUrl: string };
      try {
        // `gh`'s own kill timer is armed STRICTLY INSIDE the race budget, so
        // the typed `pr-fetch-failed` refusal always wins. Two timers armed for
        // the same ceiling decided between two completely different behaviours
        // — hop-timeout and a report, or an aborted walk with exit 2 — on
        // whichever fired first, from the same input.
        pull = await (opts.fetchPull !== undefined ? opts.fetchPull(ref) : ghFetchPull(ref, Math.max(1, budgetMs - GH_KILL_MARGIN_MS)));
      } finally {
        // In a `finally`: assigning after the await reported `prFetchMs: 0` for
        // exactly the walks where the PR fetch consumed the whole budget, which
        // is the metric's only interesting case.
        prFetchMs = Date.now() - fetchStart;
      }
      // The race is already lost: this continuation runs alongside (or after)
      // the rest of the walk, so nothing it computes may reach shared state.
      if (!live()) {
        return { status: "hop-timeout", hop: "pr-run", ceilingMs: ceiling, elapsedMs: Date.now() - fetchStart, budget: "hop" };
      }
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
      // A branch ref already NAMED its run (`parseRef`); `gh pr view qds/foo`
      // can still resolve to a PR whose head is `qds/bar` (renamed branch, or
      // gh reading the argument as a PR number / URL). Auditing `bar` while the
      // report's `ref` says `qds/foo`, with no hop reporting the substitution,
      // is a silent subject swap.
      if (parsed.refKind === "branch" && parsed.runId !== branchRunId) {
        runId = null;
        return { status: "broken", hop: "pr-run", expected: `the PR for ${ref} to have head branch qds/${parsed.runId}`, actual: `its head branch is ${cap(head as string)}`, diagnostic: "the ref names one run and the pull request names another; the walk will not silently audit the substitute", evidencePath: prUrl };
      }
      runId = branchRunId;
      if (!bodyNamesRun(pull.body, branchRunId)) {
        return { status: "broken", hop: "pr-run", expected: `the contributing runId ${branchRunId} as a whole token in the PR body`, actual: `absent from the ${pull.body.length}-char body`, diagnostic: `PR ${prUrl} does not name its run; the body is the run-correlation record (DF5.2)`, evidencePath: prUrl };
      }
      readPrEntry();
      if (prEntryMalformed) {
        return { status: "broken", hop: "pr-run", expected: "extensions.pr to be a JSON object carrying prUrl", actual: "extensions.pr is present but is not an object", diagnostic: "a malformed pr entry is not a missing one; the fetched PR cannot be checked against a record entry that has no shape", evidencePath: recordPath() };
      }
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
        detail: { headRef: head === undefined ? undefined : cap(head), prEntrySet: prEntry !== undefined, ...coverageDetail("pr-run") },
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
      //  - BARE_RUN_NULL_CORRELATION_REASON, the hop-2 table's reason for a
      //    NULL in-box correlation, is reported as the CORROBORATION reason —
      //    never as a `not-applicable` status that discards the correlation the
      //    record just proved. A run-id-rooted walk whose record carries
      //    `extensions.budget` and whose harvested sessions row is NULL (which
      //    is what every dispatched run actually harvests) used to drop a fully
      //    resolved hop out of the report and state, in the reason string, that
      //    the run carries no issue correlation — contradicted by the record
      //    ten lines above, and enough on a void-heavy run to flip
      //    `chainComplete`'s "some hop actually resolved" guard.
      // A record carrying no `extensions.budget` correlation keeps `broken`
      // where the table says `not-applicable`: `broken` is the fail-closed
      // reading (the box's own trace cannot supply the host's admission
      // correlation, INV-AUDIT-5), and the deviation is recorded in the story.
      await timed("run-issue", (): HopOutcome => {
        if (recordUnavailable()) return recordBroken("run-issue");
        const requestId = record?.requestId;
        if (typeof requestId !== "string" || requestId.length === 0) {
          return { status: "broken", hop: "run-issue", expected: "record.requestId", actual: "absent", diagnostic: "the runId→trace join key is missing from the record", evidencePath: recordPath() };
        }
        const budget = record?.extensions?.budget as Record<string, unknown> | undefined;
        const recordSlug = typeof budget?.repoSlug === "string" && budget.repoSlug.length > 0 ? budget.repoSlug : undefined;
        // `string | number`, String()-ed — SYMMETRIC with `readTrace`, whose own
        // `String()` on the INTEGER `issue_id` column exists precisely because
        // the two sides disagree about the type. Accepting only a string here
        // reported `broken / "issueId absent"` on every record whose admission
        // wrote the issue as a JSON number, for a correlation the record
        // carries perfectly well.
        const rawIssue = budget?.issueId;
        const recordIssue =
          (typeof rawIssue === "string" && rawIssue.length > 0) || (typeof rawIssue === "number" && Number.isFinite(rawIssue))
            ? String(rawIssue)
            : undefined;
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
          corroborationReason = BARE_RUN_NULL_CORRELATION_REASON;
        } else {
          // Integer column vs string record value: String() on BOTH sides —
          // an uncoerced 42 === "42" would report tamper on a healthy run.
          // Identity is the PAIR, so either half diverging is divergence; a
          // half that is NULL simply corroborates nothing.
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
            // >1 sessions row for one request_id is lawful (a retry, a resumed
            // session); the OLDEST binds, and the count says so rather than
            // letting SQLite's row order decide silently.
            ...(t.kind === "ok" && t.sessionRows > 1 ? { traceSessionRows: t.sessionRows } : {}),
          },
        };
      });

      await timed("run-cost", (): HopOutcome => {
        let ledger: CostLedger;
        // The OPEN is the walker's substrate, not the run's evidence (N5): an
        // absent, unreadable or busy ledger says the walk could not look, and
        // scoring it against the chain published "this PR's chain is BROKEN"
        // for a mistyped QDS_COST_LEDGER_FILE. Everything PAST the open — a run
        // with no rows, a read that fails on this run's rows — is about the run
        // and stays a named broken hop.
        try {
          ledger = CostLedger.openReadOnly({ path: ledgerPath });
        } catch (e) {
          const code = (e as { code?: string }).code ?? "ledger-unopenable";
          const remediation = (e as { remediation?: string }).remediation;
          throw new ChainWalkError(
            "walk-environment-fault",
            `the cost ledger at ${ledgerPath} could not be opened (${code}): ${cap((e as Error).message)}`,
            typeof remediation === "string" && remediation.length > 0
              ? remediation
              : "point QDS_COST_LEDGER_FILE at the ledger this run's spend was recorded to",
          );
        }
        try {
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
          const code = (e as { code?: string }).code ?? "ledger-read-failed";
          return { status: "broken", hop: "run-cost", expected: "readable ledger rows for the run", actual: code, diagnostic: cap((e as Error).message), evidencePath: ledgerPath };
        } finally {
          try { ledger.close(); } catch { /* the read already happened or never started */ }
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

    // ── DF6.1b, adds only: per-contributing-runId resolution (AC3). The
    // parent record's `extensions.fixLoop.fixOutcome.runIds` names every
    // contributing fix run in attempt order; each gets its own RunChain entry
    // here, walked through the SAME walk (run-id ref kind). A contributing
    // runId whose chain is missing or incomplete is a BROKEN HOP, never an
    // ignored one (INV-AUDIT-6): its entry simply reports complete: false, and
    // the report's top-level `complete` ANDs it in. Expansion is exactly one
    // level — only the PR's parent record is expanded, never a contributing
    // run's own (a fix run carries no fixOutcome of its own).
    const runs: Record<string, RunChain> = { [mapKey]: runChain };
    let contributionsComplete = true;
    const contributingIds = contributingRunIdsOf(record);
    for (const fixRunId of contributingIds) {
      if (runId !== null && fixRunId === runId) continue;
      try {
        const sub = await walkAuditChain(fixRunId, { ...opts, requestId: walkRequestId });
        const subChain = sub.runs[fixRunId];
        if (subChain === undefined) {
          runs[fixRunId] = brokenContributorChain(fixRunId, "the sub-walk resolved no chain for the contributing runId");
          contributionsComplete = false;
        } else {
          runs[fixRunId] = subChain;
          contributionsComplete = contributionsComplete && subChain.complete;
        }
      } catch (e) {
        runs[fixRunId] = brokenContributorChain(fixRunId, `the contributing run's chain could not be walked: ${cap((e as Error).message)}`);
        contributionsComplete = false;
      }
    }

    return {
      ref, refKind: parsed.refKind, generatedAt: now().toISOString(),
      complete: runChain.complete && contributionsComplete,
      timings: { prFetchMs, perHopMs }, runs,
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
