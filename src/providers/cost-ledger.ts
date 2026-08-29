/**
 * The micro-dollar cost ledger (DF2.8).
 *
 * Host-side SQLite beside the run records, so it survives box destruction
 * (§6 item 4). One append-only row per ingested event, keyed by a
 * deterministic digest: a redelivered line digests identically and lands on
 * `INSERT … ON CONFLICT DO NOTHING`, never an update. Money is integer
 * micro-dollars everywhere (DD-9); DF2.7 wire costs convert to µ$ here, at
 * ingest. It is not the only float→µ$ boundary in the factory — the provider
 * key API's dollar figures (usage, limits) convert in credentials.ts's own
 * `usdToMicros` — but no OTHER conversion happens on this ledger's path. Per-issue spend is always `SUM(cost_micro_usd)`
 * over priced rows — derived on demand, never denormalized (INV-COST-2) — and
 * the gate reads that same SUM inside a BEGIN IMMEDIATE admission
 * transaction, because a bare read-and-compare is a TOCTOU two concurrent
 * dispatches can both win (R2 §6 serialized-admission mandate).
 *
 * **What actually reaches this ledger today (F001).** `kind='box_hours'` rows
 * only. `teardown.ts` writes those; `ingestCostEvent`, the only writer of
 * `kind='tokens'` rows, has no caller outside `tests/` — nothing bridges the
 * DF2.7 `CostEvent`s that `cli-anything/src/runner.ts` emits into this store.
 * So every figure derived here, `admitIssue`'s cap included, is box time and
 * no token spend. INV-COST-2 still holds as written — the SUM is derived and
 * nothing is denormalized — but it promises DERIVATION, never COMPLETENESS,
 * and the two must not be confused while reading a total. `qds-cost` says so
 * out loud on every degraded ledger (`emitTokenBridgeState`, code
 * `tokens-ledger-unwired`). Q1 of `docs/decisions/2026-08-tech-debt-answers.md`
 * deferred (did not drop) the bridge: the writer and its tests stay, ready for
 * the one dispatcher call site that would make the prose above complete.
 *
 * The float accumulator this design exists to NOT be: inkwell's tracer keeps
 * `total_cost REAL` and does `total_cost = total_cost + ?` per turn (tracer.py
 * session_add_usage) — mutable, drift-prone, and unattributable. Every figure
 * here is recomputed from immutable rows instead.
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";

import { Database } from "bun:sqlite";

import type { CostEvent } from "../../cli-anything/src/types.ts";
import { canonicalRepoSlug } from "../phase-engine/issue-correlation.ts";
import { log, newRequestId } from "../swarmclaw/log.ts";
// The orphan guard's stat cross-check resolves the record filename the same way
// the DF2.1 store does, and admits its READ-path id grammar — both live there,
// and a second copy of either is a grammar that drifts.
import { LEGACY_RUN_ID_RE, resolveRunsDir } from "./run-record.ts";
import { ProviderError } from "./errors.ts";

// ─── units ───────────────────────────────────────────────────────────────────

const MICRO_PER_USD = 1_000_000;
const MS_PER_HOUR = 3_600_000;

// ─── identity ────────────────────────────────────────────────────────────────

/**
 * Canonical form of an issue id — the OTHER half of the (repoSlug, issueId)
 * budget key, and the same cap-bypass class `canonicalRepoSlug` closed.
 *
 * Every issue-scoped predicate here is a byte-exact SQL comparison on
 * `issue_id`, and `capForIssue` looks its per-issue override up by the id that
 * follows the `#`. Canonicalising only the slug left the bypass open on this
 * side: `42`, `#42`, `042` and `42 ` are four distinct strings, so each one
 * opens its own budget identity holding a full untouched cap, and an override
 * an operator wrote as `owner/repo#042` never matched the `"42"` a dispatch
 * supplies — the cap silently reverting to the default, the direction that
 * costs money.
 *
 * Three foldings, each for a shape a human or a hand-edited record actually
 * produces: surrounding whitespace, the `#` operators write out of habit, and
 * leading zeros. The `#` fold takes the whole `#\s*` prefix — `"# 42"` is the
 * same habit spelled with a space, and stripping only the `#` left it a fresh
 * budget identity. Leading zeros are stripped by regex rather than through
 * `Number`, which would round any id past 2^53 into a different issue.
 *
 * TOTAL, like `canonicalRepoSlug`: a non-numeric remainder is passed through
 * trimmed rather than rejected, so this can canonicalise on every path
 * (including reads of rows written before it existed) without becoming a
 * second validation gate. `resolveRunCorrelation` is where an issue id is
 * validated; this is only where it is made a key. Budget-key consumers go one
 * step further — `assertCanonicalIdentity` refuses a non-numeric remainder, so
 * a malformed id can never become a budget at all.
 */
export function canonicalIssueId(issueId: string): string {
  // `trim`, then `#` WITH whatever whitespace follows it. Stripping the bare
  // `#` left `"# 42"` folded to `" 42"` — a fourth spelling no override key
  // matches and the dispatch never writes.
  const bare = issueId.trim().replace(/^#[ \t\n\v\f\r]*/, "");
  // `(?=\d)` keeps "0" as "0" instead of folding it to the empty string.
  return /^\d+$/.test(bare) ? bare.replace(/^0+(?=\d)/, "") : bare;
}

/**
 * The COLUMN-side mirror of `canonicalIssueId` — the one thing canonicalising
 * the bind alone cannot reach: rows already on disk.
 *
 * `lower(repo_slug) = ?` folds both sides of the slug half, so a row written
 * before canonicalisation still matches. The issue half folded on the bind
 * only, so a stored `#42` / `042` / `42 ` was permanently unmatchable: its
 * spend vanished from every SUM the cap reads, which is a silent UNDER-count
 * and therefore a cap bypass. `cost_events` and `gate_admissions` both carry
 * BEFORE UPDATE/DELETE triggers (INV-COST-1), so a canonicalising migration is
 * impossible by construction — the fold has to happen in the predicate.
 *
 * Mirrors the three foldings exactly: trim, `#` WITH following whitespace (the
 * same `"# 42"` fold the bind side makes), and leading zeros ONLY when the
 * remainder is all digits (so `"0"` stays `"0"` and `"0abc"` is never folded
 * into `"abc"`, which would merge two genuinely distinct issues). The one
 * divergence is the trim set: JS `.trim()` also folds Unicode spaces, SQLite's
 * two-arg `trim()` folds only the characters named. ASCII whitespace is what a
 * hand-edited record or a shell argument actually carries; a row whose id is
 * padded with U+00A0 stays unmatched, which is the same under-count this
 * closes — narrowed, not eliminated.
 */
function sqlCanonicalIssueId(col: string): string {
  // Space, tab, LF, VT, FF, CR — JS `.trim()`'s ASCII set.
  const trimmed = `trim(${col}, char(32,9,10,11,12,13))`;
  // One-or-more ASCII spaces after the `#` fold too, matching
  // canonicalIssueId's `/^#[ \t\n\v\f\r]*/`: strip the `#`, then left-trim
  // whitespace once (the ltrim runs past further spaces but never past a
  // second `#`, exactly like the anchored regex). Same char list as the trim.
  const bare = `(CASE WHEN substr(${trimmed}, 1, 1) = '#' THEN ltrim(substr(${trimmed}, 2), char(32,9,10,11,12,13)) ELSE ${trimmed} END)`;
  // GLOB is the case-sensitive, character-class matcher: leading digit AND no
  // non-digit anywhere ⇒ `/^\d+$/`. `ltrim(…,'0')` empties an all-zero id, so
  // "000" folds to "0" the way the `(?=\d)` lookahead does.
  return `(CASE WHEN ${bare} GLOB '[0-9]*' AND ${bare} NOT GLOB '*[^0-9]*'
             THEN (CASE WHEN ltrim(${bare}, '0') = '' THEN '0' ELSE ltrim(${bare}, '0') END)
             ELSE ${bare} END)`;
}

/**
 * The issue-scope predicate EVERY issue-keyed query in this file shares, so
 * they cannot drift apart into two definitions of one budget.
 *
 * Three binds, in order: canonical slug, canonical issue, canonical issue —
 * see `issueScopeKeys`. The raw-equality disjunct comes FIRST and unchanged so
 * canonical rows (every row this code writes) still hit
 * `cost_events_issue_canonical`; the mirrored expression is the recovery path
 * for legacy rows only, and over-inclusive in the safe direction — it can add
 * spend the cap had lost sight of, never subtract any.
 *
 * The SLUG half folds on the column side too, mirroring `canonicalRepoSlug`'s
 * trim as well as its case fold. Folding only `lower()` left a row stored with
 * a padded raw slug (`" qds/demo "`, written by a pre-canonicalisation build)
 * permanently unmatchable: its priced spend vanished from every SUM the cap
 * reads — an UNDER-count, which is the cap-bypass direction. The trim set is
 * the same ASCII set `sqlCanonicalIssueId` uses, with the same documented
 * divergence from JS `.trim()`'s Unicode set; over-inclusion only ever ADDS
 * spend to a scope, never subtracts.
 */
function issueScopeSql(slugCol = "repo_slug", issueCol = "issue_id"): string {
  // Space, tab, LF, VT, FF, CR — JS `.trim()`'s ASCII set (same list as sqlCanonicalIssueId).
  const trimmedSlug = `trim(${slugCol}, char(32,9,10,11,12,13))`;
  return `lower(${trimmedSlug}) = ? AND (${issueCol} = ? OR ${sqlCanonicalIssueId(issueCol)} = ?)`;
}

/** The three binds `issueScopeSql` expects, canonicalised once. */
function issueScopeKeys(repoSlug: string, issueId: string): string[] {
  const issue = canonicalIssueId(issueId);
  return [canonicalRepoSlug(repoSlug), issue, issue];
}

/**
 * Refuse a pair that canonicalises to nothing — validated on the CANONICAL
 * values, never the raw ones.
 *
 * A raw non-empty check ran before the fold and so passed `"#"`, `" "`, `"#  "`
 * and `" # "`, every one of which canonicalises to `""`. They then all bound
 * `issue_id = ''` and shared ONE budget identity; and since ISSUE_KEY_RE
 * requires `#\d+`, no `perIssueOverrides` key can ever name that identity, so
 * the shared bucket always got `defaultCapMicroUsd` — one default cap covering
 * an unbounded set of malformed dispatches.
 *
 * The remnant the empty-check alone left open: a NON-empty canonical value no
 * override can name either. `"42x"` or `"-1"` folded to themselves, passed the
 * emptiness check, opened their OWN budget identity holding a full untouched
 * cap, and no ISSUE_KEY_RE key (`#\d+`) ever matched it — an operator could not
 * lower what they cannot spell. Every legitimate dispatch source reaches here
 * through `resolveRunCorrelation`, which demands a positive int32; a residue
 * outside `/^\d+$/` therefore names a programmatic/hand-edited value, and the
 * fail-closed answer is to refuse the identity outright (a refused budget key
 * books no rows; a mis-spelled one books spend nobody can cap).
 */
function assertCanonicalIdentity(code: string, repoSlug: string, issueId: string, remediation: string): void {
  const canonicalIssue = canonicalIssueId(issueId);
  if (
    canonicalRepoSlug(repoSlug).length === 0 ||
    canonicalIssue.length === 0 ||
    // The only shape every ISSUE_KEY_RE override key can name: digits, after
    // the fold. Anything else is an identity perIssueOverrides cannot address.
    !/^\d+$/.test(canonicalIssue)
  ) {
    throw new CostLedgerError(
      code,
      `repoSlug ${JSON.stringify(repoSlug)} / issueId ${JSON.stringify(issueId)} canonicalises to ${JSON.stringify(canonicalRepoSlug(repoSlug))}#${JSON.stringify(canonicalIssue)} — not a budget key a perIssueOverrides entry (owner/repo#N) can name`,
      remediation,
    );
  }
}

/**
 * How long an admission counts toward `reservedMicroUsd` before a missing run
 * record is read as "never created" rather than "not created yet".
 *
 * Dispatch admits BEFORE `store.create` (INV-COST-3), so between the admission
 * COMMIT and the record appearing on disk there is a real interval in which
 * that reservation resolves to no record. Without a floor on the interval, two
 * concurrent dispatches for one issue each see the other's reservation as an
 * orphan, each skip it, and both are granted the full remaining headroom — the
 * cap exceeded by design gap, not by rounding.
 *
 * The path between the two is a `ledger.close()`, a handful of integer checks
 * and `store.create`'s couple of syscalls: single-digit milliseconds, low
 * hundreds on a loaded host. 60s is ~1000× that, because the two error
 * directions are not symmetric — too short double-allocates real money, too
 * long merely holds a genuinely orphaned reservation against the cap for one
 * minute. Over-reserving is the fail-safe direction INV-COST-6 takes
 * everywhere else. Deliberately not configurable: a deployment tuning this
 * number is tuning its own odds of overspending.
 *
 * Exported for tests ONLY so the grace-window assertions derive their ages from
 * the real value instead of mirroring the literal — a mirrored copy lets the
 * window be retuned to a value that under-protects against the dispatch race
 * with every test still green. Not a config knob: nothing reads it but this file.
 */
export const ADMISSION_GRACE_MS = 60_000;

/**
 * Clock-skew slack added to the grace window before an admission can expire.
 *
 * `decided_at` is a FOREIGN wall clock — whichever host dispatched wrote it —
 * compared against the reader's own. A reader running ahead of the writer (NTP
 * step, VM resume, container drift) sees a live in-flight reservation as aged,
 * skips it as an orphan, and hands the same headroom out a second time: the
 * exact double allocation the grace window exists to prevent, and the one
 * direction of skew that fails OPEN. The expiry therefore fires only once a row
 * is older than the grace window by more skew than a clock plausibly carries.
 * Skew the other way is already safe: a future-dated row is younger than any
 * cutoff, so it counts. The schema carries no local-origin timestamp to compare
 * against instead (gate_admissions is append-only, so it cannot acquire one for
 * rows already written), which is why this is a clamp and not a better clock.
 *
 * The price is only how long a genuinely orphaned reservation (store.create
 * failed, so no run can ever report spend) wedges its issue: ~6 minutes rather
 * than ~1. The price of the other mistake is spending the cap twice, so the
 * slack buys in the fail-safe direction (INV-COST-6).
 *
 * Exported for tests ONLY, on the same reasoning as ADMISSION_GRACE_MS.
 */
export const ADMISSION_SKEW_MARGIN_MS = 300_000;

/**
 * DD-9: float USD exists only on DF2.7's wire; converted once, here, half-up.
 * (The provider key API's own dollar figures — caps and usage — convert at
 * credentials.ts's `usdToMicros`; these are two distinct wire boundaries.)
 *
 * ROUND FIRST, then validate the ROUNDED value. Validating the product was the
 * bug: `usd * 1e6` is a float, and almost no ordinary cost lands on an integer
 * — `1.005 * 1e6` is `1004999.9999999999`, `0.0000015 * 1e6` is `1.5` — so
 * `Number.isSafeInteger` on the product threw for the common case, not the
 * pathological one. Rounding is exactly what the conversion is for; the range
 * check exists to catch a figure too large to be money, and `Math.round`
 * preserves that (a value past 2^53 rounds to itself and still fails).
 */
function usdToMicros(usd: number): number {
  if (!Number.isFinite(usd)) {
    throw new CostLedgerError("cost-convert-invalid", `costUsd must be finite (got ${usd})`, "fix the producer's cost event");
  }
  const micros = Math.round(usd * MICRO_PER_USD);
  if (!Number.isSafeInteger(micros)) {
    throw new CostLedgerError("cost-convert-invalid", `costUsd ${usd} × 1e6 exceeds safe integer range (${micros})`, "fix the producer's cost event");
  }
  return micros;
}

// ─── schema ──────────────────────────────────────────────────────────────────

/**
 * `event_id` is a sha256 over the event's stable fields — stable across
 * redelivery, distinct from the ingest-time `created_at`. Two digests exist:
 * token rows digest `run_id, agent_id, kind, invocation_seq, turn_count,
 * cost_micro_usd, timestamp` (the WIRE event's emission time); box-hour rows
 * digest `run_id, kind='box_hours', closed_at` (the record's own close
 * timestamp, fixed once close runs). `invocation_seq` is what keeps two genuine
 * invocations of one agent in one run from ever digesting identically — DF2.7
 * emits one `cost` event per pi subprocess, and keying on
 * `(run_id, agent_id, kind)` would silently drop the second one.
 */
function tokenEventId(input: {
  runId: string;
  agentId: string;
  invocationSeq: number;
  turnCount: number;
  costMicroUsd: number;
  timestamp: string;
}): string {
  const h = new Bun.CryptoHasher("sha256");
  h.update(`${input.runId}|${input.agentId}|tokens|${input.invocationSeq}|${input.turnCount}|${input.costMicroUsd}|${input.timestamp}`);
  return h.digest("hex");
}

function boxHoursEventId(runId: string, closedAt: string): string {
  const h = new Bun.CryptoHasher("sha256");
  h.update(`${runId}|box_hours|box_hours|${closedAt}`);
  return h.digest("hex");
}

/** The differing-field check in ingestCostEvent reads exactly these columns. */
type TokenRowCols = {
  cost_micro_usd: number;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  unpriced: number;
};

const SCHEMA = `
CREATE TABLE IF NOT EXISTS cost_events (
  event_id           TEXT PRIMARY KEY,
  run_id             TEXT NOT NULL,
  repo_slug          TEXT NOT NULL,
  issue_id           TEXT NOT NULL,
  request_id         TEXT NOT NULL,
  role               TEXT CHECK (role IN ('lead','worker','resident','tier1')),
  agent_id           TEXT,
  provider           TEXT,
  model              TEXT,
  kind               TEXT NOT NULL CHECK (kind IN ('tokens','box_hours')),
  invocation_seq     INTEGER NOT NULL,
  input_tokens       INTEGER,
  output_tokens      INTEGER,
  cache_read_tokens  INTEGER,
  cache_write_tokens INTEGER,
  turn_count         INTEGER,
  cost_micro_usd     INTEGER NOT NULL,
  unpriced           INTEGER NOT NULL DEFAULT 0,
  key_hash           TEXT,
  key_limit_micro_usd INTEGER,
  created_at         TEXT NOT NULL
) STRICT;
CREATE INDEX IF NOT EXISTS cost_events_issue ON cost_events (repo_slug, issue_id, unpriced);
-- Identity is the CANONICAL slug (see canonicalRepoSlug): every issue-scoped
-- predicate filters on lower(trim(repo_slug, …)), so the index has to be on the
-- SAME expression or SQLite falls back to a scan — inside BEGIN IMMEDIATE on
-- the admission path. The older lower()-only expression below is kept for
-- existing databases (IF NOT EXISTS never rewrites one) and any external
-- reader; the raw-column index above is kept: cost_events_run and per-row
-- lookups still use the stored value.
CREATE INDEX IF NOT EXISTS cost_events_issue_canonical
  ON cost_events (lower(repo_slug), issue_id, unpriced);
CREATE INDEX IF NOT EXISTS cost_events_issue_canonical_trimmed
  ON cost_events (lower(trim(repo_slug, char(32,9,10,11,12,13))), issue_id, unpriced);
CREATE INDEX IF NOT EXISTS cost_events_run ON cost_events (run_id);
CREATE TRIGGER IF NOT EXISTS cost_events_no_update
BEFORE UPDATE ON cost_events
BEGIN SELECT RAISE(ABORT, 'cost_events is append-only (INV-COST-1)'); END;
CREATE TRIGGER IF NOT EXISTS cost_events_no_delete
BEFORE DELETE ON cost_events
BEGIN SELECT RAISE(ABORT, 'cost_events is append-only (INV-COST-1)'); END;

CREATE TABLE IF NOT EXISTS gate_admissions (
  request_id        TEXT NOT NULL,
  run_id            TEXT NOT NULL,
  repo_slug         TEXT NOT NULL,
  issue_id          TEXT NOT NULL,
  ceiling_micro_usd INTEGER NOT NULL,
  decided_at        TEXT NOT NULL,
  PRIMARY KEY (request_id, run_id)
) STRICT;
CREATE INDEX IF NOT EXISTS gate_admissions_issue ON gate_admissions (repo_slug, issue_id);
CREATE INDEX IF NOT EXISTS gate_admissions_issue_canonical
  ON gate_admissions (lower(repo_slug), issue_id);
CREATE INDEX IF NOT EXISTS gate_admissions_issue_canonical_trimmed
  ON gate_admissions (lower(trim(repo_slug, char(32,9,10,11,12,13))), issue_id);
CREATE TRIGGER IF NOT EXISTS gate_admissions_no_update
BEFORE UPDATE ON gate_admissions
BEGIN SELECT RAISE(ABORT, 'gate_admissions is append-only (INV-COST-1)'); END;
CREATE TRIGGER IF NOT EXISTS gate_admissions_no_delete
BEFORE DELETE ON gate_admissions
BEGIN SELECT RAISE(ABORT, 'gate_admissions is append-only (INV-COST-1)'); END;
`;

// ─── errors ──────────────────────────────────────────────────────────────────

export class CostLedgerError extends ProviderError {
  constructor(code: string, message: string, remediation: string) {
    super(code, message, remediation);
    this.name = "CostLedgerError";
  }
}

export class CostConfigError extends CostLedgerError {
  constructor(code: string, message: string, remediation: string) {
    super(code, message, remediation);
    this.name = "CostConfigError";
  }
}

/**
 * SQLITE_BUSY → the typed `ledger-busy` refusal; `undefined` for anything else,
 * so callers rethrow the original rather than reclassify a real fault as
 * contention.
 *
 * ONE definition because `admitIssue` now touches SQLite from two places — the
 * reservation prefetch, deliberately outside the write transaction, and
 * `decide.immediate()` itself. Two copies of this test would be two chances for
 * one of them to drift into throwing a raw driver error, and a caller that
 * cannot tell "retry me" from "the ledger is broken" either retries a fault or
 * gives up on a lock.
 */
function ledgerBusyError(e: unknown): CostLedgerError | undefined {
  const msg = (e as Error)?.message ?? String(e);
  if (!/database is (locked|busy)|database table is locked/i.test(msg)) return undefined;
  return new CostLedgerError(
    "ledger-busy",
    `the cost ledger stayed write-locked past the 5s busy timeout (${msg}) — transient contention, not corruption`,
    "retry the dispatch; if it persists, check for a process holding .sandbox/cost-ledger.db open",
  );
}

// ─── config ──────────────────────────────────────────────────────────────────

export interface CostConfig {
  /** Default per-issue spend cap, µ$. 5,000,000 µ$ = $5.00 (DD-9 restatement). */
  defaultCapMicroUsd: number;
  /** Per-issue overrides keyed `owner/repo#N`. */
  perIssueOverrides?: Record<string, number>;
  /**
   * Box-hour rate, µ$/h. exe.dev pricing is vendor-single-origin [VERIFY]
   * (R5 §6 fact 11), so the rate is configuration, never a compiled constant.
   * Required before any box-hours row can be priced.
   */
  boxHourRateMicroUsd?: number;
}

export const DEFAULT_COST_CONFIG: Readonly<CostConfig> = Object.freeze({ defaultCapMicroUsd: 5_000_000 });
// Intentionally omits boxHourRateMicroUsd: box-hours are optional and configured per-deployment.

export const DEFAULT_COST_CONFIG_FILE = ".sandbox/cost-config.json";

/** The ledger's default path — shared with the reporting CLI's existence check. */
export const DEFAULT_COST_LEDGER_FILE = ".sandbox/cost-ledger.db";

const ISSUE_KEY_RE = /^[\w.-]+\/[\w.-]+#\d+$/;

/** The `<canonical slug>#<canonical issue>` identity both sides of an override lookup are reduced to. */
function canonicalIssueKey(repoSlug: string, issueId: string): string {
  return `${canonicalRepoSlug(repoSlug)}#${canonicalIssueId(issueId)}`;
}

/**
 * The same identity for an operator-authored override key, or `undefined` when
 * the key carries no `#` at all and so names no issue. The slug charset
 * excludes '#', so the FIRST one always separates the pair.
 */
function canonicalOverrideKey(key: string): string | undefined {
  const sep = key.indexOf("#");
  return sep === -1 ? undefined : canonicalIssueKey(key.slice(0, sep), key.slice(sep + 1));
}

const CONFIG_KEYS: readonly (keyof CostConfig)[] = ["defaultCapMicroUsd", "perIssueOverrides", "boxHourRateMicroUsd"];

function configInvalid(file: string, detail: string): CostConfigError {
  return new CostConfigError(
    "cost-config-invalid",
    `cost config ${file}: ${detail}`,
    `write a partial-or-full override object, e.g. {"defaultCapMicroUsd": 5000000, "boxHourRateMicroUsd": 3600000, "perIssueOverrides": {"owner/repo#1": 1000000}}`,
  );
}

function assertMicros(file: string, key: string, value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw configInvalid(file, `${key} must be a positive safe integer of micro-dollars (got ${JSON.stringify(value)})`);
  }
  return value;
}

export interface LoadedCostConfig {
  config: CostConfig;
  source: "default" | "file";
  file?: string;
}

/**
 * A throwing log sink must not turn an outcome the ledger has ALREADY COMMITTED
 * (or a legitimate layout it is only reporting) into a thrown error. Swallow
 * with a stderr note naming the operation; never echo the payload itself —
 * stderr is a second channel and these lines are not redacted. The default sink
 * already drops on EPIPE, so only a raising custom sink reaches the catch — and
 * the stderr note is best-effort too: a diagnostic that throws is worse than
 * silence.
 */
function emitGuarded(line: Parameters<typeof log>[0]): void {
  try {
    log(line);
  } catch (e) {
    try {
      process.stderr.write(
        `cost-ledger: log sink threw for ${line.operation} (${(e as Error).message}) — the ledger outcome stands\n`,
      );
    } catch {
      // best-effort diagnostic only
    }
  }
}

/** Mirrors quota.ts's loader: absent file ⇒ defaults; a config that cannot be trusted never falls back silently. */
export function loadCostConfig(
  file: string = process.env.QDS_COST_CONFIG_FILE ?? DEFAULT_COST_CONFIG_FILE,
): LoadedCostConfig {
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    if (err.code === "ENOENT") {
      // Absent is a legitimate layout, but it is NOT the same as "the caps you
      // configured". `costLedgerOpts` derives this path from the records dir,
      // so relocating the records (`--dir`, $QDS_RUNS_DIR) silently swaps the
      // operator's caps for the built-ins — the same spend priced against a
      // different ceiling, with nothing on stdout or stderr saying so. Name the
      // path we looked at; the fallback itself stays non-fatal. Guarded like
      // every other emission here: a raising sink must not convert a legitimate
      // layout into a thrown error.
      emitGuarded({
        requestId: newRequestId(),
        operation: "cost-ledger.config",
        agentId: null,
        timestamp: new Date().toISOString(),
        duration: 0,
        status: "ok",
        code: "cost-config-absent-using-defaults",
        configFile: file,
        defaultCapMicroUsd: DEFAULT_COST_CONFIG.defaultCapMicroUsd,
        message: `no cost config at ${file} — pricing and caps fall back to the built-in defaults`,
        outcome: "default-config",
      });
      return { config: { ...DEFAULT_COST_CONFIG }, source: "default" };
    }
    throw new CostConfigError(
      "cost-config-unreadable",
      `cannot read the cost config file ${file} (${err.message ?? String(e)}) — refusing to guess caps`,
      `fix the permissions on ${file}, or remove it to fall back to the built-in defaults`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new CostConfigError(
      "cost-config-unreadable",
      `cost config file ${file} is not valid JSON: ${(e as Error).message} — refusing to guess caps`,
      `write a valid JSON object over it, e.g. {"defaultCapMicroUsd": 5000000}`,
    );
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw configInvalid(file, "the body is not a JSON object");
  }
  const over: CostConfig = { ...DEFAULT_COST_CONFIG };
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (!(CONFIG_KEYS as readonly string[]).includes(key)) {
      throw configInvalid(file, `unknown key ${JSON.stringify(key)}`);
    }
    if (key === "perIssueOverrides") {
      if (typeof value !== "object" || value === null || Array.isArray(value)) {
        throw configInvalid(file, "perIssueOverrides must be an object keyed owner/repo#N");
      }
      const overrides: Record<string, number> = {};
      // Two keys that name the SAME issue are an operator error, not a value to
      // resolve. `capForIssue` walks the map and returns the first match, so
      // `{"Owner/Repo#42": 20000000, "owner/repo#42": 1000000}` silently
      // returned 20 USD — ignoring the very line the operator added to LOWER
      // the cap. Picking the lower one instead would be just as wrong: it would
      // quietly ignore the line added to raise it. In a money table the honest
      // answer to "which of these did you mean?" is to refuse and let the
      // operator say, which is what every other malformed-config path here does.
      const seen = new Map<string, string>();
      for (const [issueKey, cap] of Object.entries(value as Record<string, unknown>)) {
        if (!ISSUE_KEY_RE.test(issueKey)) {
          throw configInvalid(file, `perIssueOverrides key ${JSON.stringify(issueKey)} is not of the form owner/repo#N`);
        }
        // Non-undefined: ISSUE_KEY_RE already required the '#'.
        const identity = canonicalOverrideKey(issueKey) as string;
        const first = seen.get(identity);
        if (first !== undefined) {
          throw configInvalid(
            file,
            `perIssueOverrides keys ${JSON.stringify(first)} and ${JSON.stringify(issueKey)} both name the issue ${identity} — refusing to pick one cap for it`,
          );
        }
        seen.set(identity, issueKey);
        overrides[issueKey] = assertMicros(file, `perIssueOverrides.${issueKey}`, cap);
      }
      over.perIssueOverrides = overrides;
    } else {
      (over as unknown as Record<string, unknown>)[key] = assertMicros(file, key, value);
    }
  }
  return { config: over, source: "file", file };
}

/**
 * The cap that governs one issue: its override when present, the default
 * otherwise.
 *
 * Both sides of the lookup are canonicalised — the WHOLE key, not just the
 * slug — because both are typed by a human: the operator writes
 * `perIssueOverrides` keys in the cost config, and a brief supplies the pair.
 * Matching raw strings meant an override authored as
 * `BiosparkHealth/QDS-Factory#42` was silently not applied to a dispatch that
 * spelled the slug in any other case, and an override authored as
 * `owner/repo#042` was never applied to anything at all — the cap quietly
 * reverting to the default, which is the failure direction that costs money.
 *
 * Comparing key-by-key rather than canonicalising the map once keeps this
 * total: a `CostConfig` built in code (tests, callers) gets the same treatment
 * as one parsed from disk, so there is no way to construct a config whose
 * overrides are matched raw. The map is a small operator-authored table.
 *
 * AMBIGUITY RESOLVES TO THE LOWEST CAP. `loadCostConfig` REFUSES a file whose
 * override keys name one issue twice — refusing is the honest answer when an
 * operator can still be asked. But that guard lives on the parse arm only, and
 * a `CostConfig` assembled in code (a test, a caller merging overrides, a
 * default never read from a file) can hold `{"Owner/Repo#42": 20000000,
 * "owner/repo#42": 1000000}` with nobody left to ask. Returning the FIRST match
 * then served 20 USD and ignored the line added to LOWER it, and iteration
 * order is not a contract anyone authored. `Math.min` is the direction that
 * cannot overspend: at worst it ignores a line meant to RAISE a cap, which
 * refuses a dispatch — recoverable — where the other mistake spends money that
 * is not recoverable.
 */
export function capForIssue(config: CostConfig, repoSlug: string, issueId: string): number {
  const overrides = config.perIssueOverrides;
  // `null` alongside `undefined`: the type forbids it, but a CostConfig
  // assembled in code or read from JSON without the parse validator reaches
  // here anyway, and `Object.entries(null)` threw out of the GATE where the
  // pre-canonicalisation code's `config.perIssueOverrides?.[…]` returned the
  // default cap. Absent overrides mean the default cap in either spelling.
  if (overrides === undefined || overrides === null) return config.defaultCapMicroUsd;
  const want = canonicalIssueKey(repoSlug, issueId);
  let cap: number | undefined;
  for (const [key, value] of Object.entries(overrides)) {
    // `undefined` (a key naming no issue) never equals `want`.
    if (canonicalOverrideKey(key) !== want) continue;
    cap = cap === undefined ? value : Math.min(cap, value);
  }
  return cap ?? config.defaultCapMicroUsd;
}

// ─── ledger ──────────────────────────────────────────────────────────────────

/**
 * The DF2.7 wire event as this module WOULD receive it — float USD on the
 * wire, µ$ never. No production caller passes one yet (F001, see the header);
 * the type is the contract the unbuilt bridge would satisfy.
 */
export type CostWireEvent = CostEvent;

export type CostRole = "lead" | "worker" | "resident" | "tier1";

/**
 * The attribution context only the spawning dispatcher WOULD know: DF2.7's
 * event carries agent/model/tokens/cost and nothing else, so run/issue/request/
 * role and the invocation counter arrive here. `role` is read from the roster
 * entry the dispatcher spawned under — never inferred from the model slug, the
 * agent name, or emission order.
 *
 * No dispatcher assembles one today (F001): only `tests/` construct this.
 */
export interface IngestCtx {
  runId: string;
  repoSlug: string;
  issueId: string;
  requestId: string;
  role: CostRole;
  /** Dispatcher's monotonic per-(run_id, agent_id) counter, fixed at spawn. */
  invocationSeq: number;
}

export interface BoxHoursCtx {
  runId: string;
  repoSlug: string;
  issueId: string;
  requestId: string;
}

/** What the ledger needs to resolve a run's DF2.3 credential linkage (INV-COST-5). */
export interface RunCostRecord {
  keyHash?: string;
  limitMicroUsd?: number;
  createdAt: string;
  closedAt?: string;
}

export interface CostLedgerDeps {
  /** Defaults to `.sandbox/cost-ledger.db` (cwd-relative, like every `.sandbox/` path). */
  path?: string;
  /** Resolves run_id → the DF2.1 record's credential/lifetime fields. */
  readRunRecord?: (runId: string) => RunCostRecord | undefined;
  /**
   * The DF2.1 records directory the admission gate's orphan guard stats when a
   * run-record read THROWS for an aged reservation — the cross-check that tells
   * "the file is gone" (safe to expire) from "the file is there but unreadable"
   * (a live run whose ceiling must stay counted). Defaults through
   * `resolveRunsDir()`, i.e. `$QDS_RUNS_DIR ?? .sandbox/runs`; pass
   * `store.dir` explicitly when the records were relocated by flag.
   */
  runsDir?: string;
  /** Explicit config; otherwise `loadCostConfig()` (env tier → `.sandbox/cost-config.json` → defaults). */
  config?: CostConfig;
}

/** One shared schema for every view — `qds cost` and the audit chain read the same field names. */
export interface CostView {
  totalMicroUsd: number;
  /** Priced spend by role; box-hours surface under the literal `"box-hours"` key (explicit unattributed line). */
  perRole: Record<string, number>;
  tokenTotals: { inputTokens: number; outputTokens: number };
  cacheTotals: { cacheReadTokens: number; cacheWriteTokens: number };
  unpricedRows: number;
  /** Every row in scope, priced or not — DF5.2's PR body reports it beside the total. */
  eventCount: number;
  /** `false` distinguishes a run/issue with no ledger rows from one that spent nothing. */
  hasEvents: boolean;
}

export interface IngestResult {
  eventId: string;
  inserted: boolean;
  unpriced: boolean;
}

export interface AdmissionInput {
  repoSlug: string;
  issueId: string;
  runId: string;
  requestId: string;
}

export type AdmissionDecision =
  | {
      admitted: true;
      status: "within-budget";
      capMicroUsd: number;
      spentMicroUsd: number;
      reservedMicroUsd: number;
      remainingMicroUsd: number;
      unpricedRows: number;
      /** min(keyCapMicroUsd, remainingMicroUsd) — the one number handed to DF2.3's mint. */
      admittedCeilingMicroUsd: number;
    }
  | {
      admitted: false;
      status: "over-budget";
      reason: "spend-cap-exceeded";
      capMicroUsd: number;
      spentMicroUsd: number;
      reservedMicroUsd: number;
      unpricedRows: number;
    };

/**
 * The three outcomes of reading a reservation's run record, as data — so the
 * classification below can be a pure function of them (F042).
 *
 * `unreadable` carries `structurallyAbsent`: whether the record's absence is
 * PROVEN (ENOENT, or a confirmed zero-byte tombstone) as opposed to a record
 * that may still be on disk behind a transient fault.
 */
export type ReservationRecord =
  | { kind: "resolved"; record: RunCostRecord }
  | { kind: "absent" }
  | { kind: "unreadable"; structurallyAbsent: boolean };

/**
 * What admitIssue does with one reservation row.
 *
 * - `count`             — the ceiling stays reserved against the cap.
 * - `expire`            — the row has retired; drop its ceiling, say nothing.
 * - `refuse`            — a YOUNG unreadable record: rethrow, refuse this dispatch.
 * - `hold-unresolvable` — an AGED unreadable record still on disk: count it, and log why.
 * - `expire-unresolvable` — an AGED, structurally absent record: expire it, and log why.
 */
export type ReservationVerdict =
  | "count"
  | "expire"
  | "refuse"
  | "hold-unresolvable"
  | "expire-unresolvable";

/**
 * A reservation is YOUNG until `graceCutoff`. An unparseable decided_at counts
 * as young for the same fail-safe reason the whole guard is conservative:
 * over-reserve, never expire. So does a future-dated one, and one within
 * ADMISSION_SKEW_MARGIN_MS of the window on either host's reading of the clock
 * — `graceCutoff` carries that margin, because `decided_at` is the WRITER's
 * clock and ours may run ahead of it.
 */
export function isReservationYoung(row: { decidedAt: string }, graceCutoff: number): boolean {
  const decidedAt = Date.parse(row.decidedAt);
  return !Number.isFinite(decidedAt) || decidedAt > graceCutoff;
}

/**
 * F042: admitIssue's reservation-row decision, pure — young/aged x
 * resolves/throws/absent x closed/open, with no live handle and no seeded rows
 * needed to exercise it.
 *
 * Orphan guard: a reservation counts while its run record resolves — and, for
 * the first ADMISSION_GRACE_MS, whether it resolves or not. createRun admits
 * BEFORE store.create (INV-COST-3), so a missing record means one of two
 * things the record alone cannot tell apart: NEVER created (store.create
 * failed with EEXIST or an invalid run id — that run can never report spend)
 * or NOT created YET (the admitting dispatch is still in flight). Only the
 * older one is an orphan; a young one still counts, which is what stops two
 * concurrent dispatches from each skipping the other's reservation and both
 * winning the full remaining headroom.
 *
 * An AGED throw is not automatically an absence. The record may be sitting on
 * disk behind a transient fault — EIO on a flaky mount, an EACCES after a
 * sibling's chown, a torn read — and the box it describes may be LIVE and
 * billing right now. So expiry is reserved for STRUCTURAL absence; anything
 * else keeps the ceiling counted, under-admitting rather than over-admitting
 * (INV-COST-6's direction).
 *
 * Closed record ⇒ retired — once the close is older than `graceCutoff`. Every
 * row reaching here is a run that has reported no positive spend, so without
 * this a run that genuinely cost nothing holds its ceiling against the issue
 * forever and INV-COST-1 leaves no manual exit. The cutoff qualifier is the
 * close→price race guard: teardown closes the record first and lands the
 * priced box_hours row moments later, and retiring inside that window frees
 * headroom the imminent charge then consumes past cap. A young close keeps
 * counting; an unparseable closed_at retires, because holding it would wedge
 * with no expiry (the record resolves, so the orphan guard never fires).
 */
export function classifyReservation(
  row: { decidedAt: string },
  record: ReservationRecord,
  graceCutoff: number,
): ReservationVerdict {
  const young = isReservationYoung(row, graceCutoff);
  if (record.kind === "unreadable") {
    if (young) return "refuse";
    return record.structurallyAbsent ? "expire-unresolvable" : "hold-unresolvable";
  }
  if (record.kind === "absent") return young ? "count" : "expire";
  const { closedAt } = record.record;
  if (closedAt === undefined) return "count";
  const closedAtMs = Date.parse(closedAt);
  return !Number.isFinite(closedAtMs) || closedAtMs <= graceCutoff ? "expire" : "count";
}

export class CostLedger {
  private readonly db: Database;
  private readonly readRunRecord: (runId: string) => RunCostRecord | undefined;
  private readonly runsDir: string;
  readonly config: CostConfig;
  readonly path: string;

  constructor(deps: CostLedgerDeps = {}) {
    this.path = deps.path ?? process.env.QDS_COST_LEDGER_FILE ?? DEFAULT_COST_LEDGER_FILE;
    this.runsDir = resolveRunsDir(deps.runsDir);
    // Fail-safe default (INV-COST-6): an unwired seam must not expire
    // reservations — a truthy stub keeps every outstanding admission counted
    // (over-reserving, never under-counting). The ingest paths stay fail-closed
    // on the stub: it carries no keyHash/closedAt, so token ingest and
    // box-hours pricing still refuse rather than persist under guessed keys.
    this.readRunRecord = deps.readRunRecord ?? (() => ({ createdAt: "" }));
    this.config = deps.config ?? loadCostConfig().config;
    const dir = dirname(this.path);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    chmodSync(dir, 0o700);
    const dirMode = statSync(dir).mode & 0o777;
    if (dirMode !== 0o700) {
      throw new CostLedgerError(
        "ledger-dir-mode",
        `cost ledger dir ${dir} is mode 0${dirMode.toString(8)}, not 0700`,
        `chmod 0700 ${dir}`,
      );
    }
    const isNew = !existsSync(this.path);
    let db: Database;
    try {
      db = new Database(this.path);
    } catch (e) {
      // INV-COST-6: an unopenable ledger is never read as zero spend.
      throw new CostLedgerError(
        "ledger-unopenable",
        `cannot open the cost ledger ${this.path} (${(e as Error).message}) — refusing to treat spend as zero`,
        `fix the permissions on ${this.path} or remove the file if it is not a ledger, then re-run`,
      );
    }
    try {
      if (isNew) chmodSync(this.path, 0o600); // SQLite propagates the main file's mode to -wal/-shm
      const fileMode = statSync(this.path).mode & 0o777;
      if (fileMode !== 0o600) {
        throw new CostLedgerError(
          "ledger-file-mode",
          `cost ledger ${this.path} is mode 0${fileMode.toString(8)}, not 0600`,
          `chmod 0600 ${this.path}`,
        );
      }
      // Lifted pragma posture from inkwell's tracer.py:108-113 / visualizer db.ts:77-93.
      db.exec("PRAGMA journal_mode = WAL;");
      db.exec("PRAGMA synchronous = NORMAL;");
      db.exec("PRAGMA busy_timeout = 5000;");
      db.exec(SCHEMA);
      this.db = db;
    } catch (e) {
      // chmod/stat/db.exec can all throw after the handle exists but before
      // this.db is assigned — close the handle here so no failure path leaks
      // the fd and SQLite memory (the file-mode throw above rides this too).
      try {
        db.close();
      } catch {
        // The handle dies with the process; the original error is the diagnosis.
      }
      throw e;
    }
  }

  close(): void {
    this.db.close();
  }

  // ─── ingest ────────────────────────────────────────────────────────────────

  /**
   * One row per emitted event — the ONLY writer of `kind='tokens'` rows, and
   * (F001) a writer with no caller outside `tests/`. The DF2.7 events that
   * `cli-anything/src/runner.ts` produces are consumed by that runner's own
   * in-process budget guard and are never handed to this method, so the
   * behaviour described below is exercised only by its tests. Q1 kept it
   * deliberately: the bridge is deferred, not dropped, and this is the half
   * that already exists. Wiring it means one call at the dispatcher site that
   * consumes the `{kind:"cost"}` team event — nothing here needs to change.
   *
   * A malformed event — non-finite or negative
   * `costUsd` — persists with `unpriced = 1` and `cost_micro_usd = 0`, never
   * dropped: an unrecorded cost is an unenforceable cap (AC4). An event with
   * `unpricedTurns > 0` (how DF2.7 marks absent/malformed usage upstream) is
   * flagged `unpriced = 1` — excluded from the priced SUM, because partial
   * usage undercounts — but its finite, non-negative `costUsd` still converts
   * and persists, so the recorded partial figure stays visible instead of
   * being zeroed.
   */
  ingestCostEvent(event: CostWireEvent, ctx: IngestCtx): IngestResult {
    const started = Date.now();
    assertIngestCtx(ctx);
    const record = this.readRunRecord(ctx.runId);
    // INV-COST-5: every token-kind row carries the DF2.3 key's hash and cap —
    // spend is attributable to the one credential that could have produced it.
    const keyHash = record?.keyHash;
    const keyLimit = record?.limitMicroUsd;
    if (keyHash === undefined || keyLimit === undefined) {
      const missing = keyHash === undefined ? "keyHash" : "limitMicroUsd";
      throw new CostLedgerError(
        "key-hash-missing",
        `run ${ctx.runId} has no resolvable ${missing} — token spend is unattributable, refusing to persist under a guessed key`,
        `re-run the ingest after mintRunKey records the run's key (see scripts/run-record.ts ${ctx.runId}), or pass the record through readRunRecord`,
      );
    }
    // An unconvertible cost is a MALFORMED EVENT, not a reason to drop it: a
    // cost that never reaches a row is spend the cap cannot see, which is the
    // one outcome AC4 and the docstring above rule out. So the conversion joins
    // non-finite and negative in the `costInvalid` class — persisted at 0 µ$
    // with `unpriced = 1`, visible in every unpricedRows count — instead of
    // throwing out of ingest and taking the event with it.
    let costInvalid = !Number.isFinite(event.costUsd) || event.costUsd < 0;
    let costMicroUsd = 0;
    // Never silently: the reason rides the ingest log line below, so a row that
    // went unpriced because the FIGURE was unusable is distinguishable from one
    // that went unpriced because the producer said so (unpricedTurns > 0).
    let convertError: string | undefined;
    if (!costInvalid) {
      try {
        costMicroUsd = usdToMicros(event.costUsd);
      } catch (e) {
        costInvalid = true;
        costMicroUsd = 0;
        convertError = (e as Error).message;
      }
    }
    // A NONZERO cost that rounds to zero µ$ is not free spend — it is spend
    // this ledger's unit cannot express. `costUsd: 0.0000004` converts to 0 µ$
    // and would otherwise be recorded as real, fully-priced, zero money:
    // invisible in `unpricedRows`, and indistinguishable from the genuinely
    // free cached turn a run reports at exactly 0. Half-up rounding is still
    // the right conversion (DD-9); the flag is what keeps the collapse visible.
    const subMicro = !costInvalid && event.costUsd > 0 && costMicroUsd === 0;
    const unpriced = costInvalid || subMicro || (event.unpricedTurns ?? 0) > 0;
    const eventId = tokenEventId({
      runId: ctx.runId,
      agentId: event.agentId,
      invocationSeq: ctx.invocationSeq,
      turnCount: event.turnCount ?? 0,
      costMicroUsd,
      timestamp: event.timestamp,
    });
    const insert = () =>
      this.db
        .prepare(
          `INSERT INTO cost_events (
           event_id, run_id, repo_slug, issue_id, request_id, role, agent_id,
           kind, invocation_seq, input_tokens, output_tokens, cache_read_tokens,
           cache_write_tokens, turn_count, cost_micro_usd, unpriced,
           key_hash, key_limit_micro_usd, created_at
         ) VALUES (?,?,?,?,?,?,?, 'tokens', ?,?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(event_id) DO NOTHING`,
        )
        .run(
          eventId,
          ctx.runId,
          // Persist the canonical identity: teardown re-reads this slug back out of
          // the run record on disk, and a record written before canonicalisation
          // would otherwise mint a second identity on every later ingest.
          canonicalRepoSlug(ctx.repoSlug),
          canonicalIssueId(ctx.issueId),
          ctx.requestId,
          ctx.role,
          event.agentId,
          ctx.invocationSeq,
          event.inputTokens ?? 0,
          event.outputTokens ?? 0,
          event.cacheReadTokens ?? 0,
          event.cacheWriteTokens ?? 0,
          event.turnCount ?? 0,
          costMicroUsd,
          unpriced ? 1 : 0,
          keyHash,
          keyLimit,
          new Date().toISOString(),
        );
    // The ingest INSERT is a ledger-write like admitIssue's own: SQLITE_BUSY
    // past the busy timeout (a concurrent ingest or gate holding the write
    // lock) surfaces as the same typed retryable refusal, not a raw driver
    // error no caller can switch on. Anything else rethrows unchanged.
    let changes: number;
    try {
      ({ changes } = insert());
    } catch (e) {
      throw ledgerBusyError(e) ?? e;
    }
    if (changes === 0) {
      // ON CONFLICT fired on THIS event's digest: same run/agent/seq/turn/cost/
      // timestamp. A redelivery digesting identically is correct dedup; but the
      // key cannot distinguish two DISTINCT events that collide in one tick
      // (both turned `turnCount ?? 0`, say). Read what the conflicting row
      // holds: byte-identical ⇒ a genuine redelivery, dedup silently as before;
      // any differing field is spend the SUM will count once for TWO events —
      // money-visible, so it gets its own structured line, never "duplicate".
      const prior = this.db
        .prepare(
          "SELECT cost_micro_usd, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, unpriced FROM cost_events WHERE event_id = ?",
        )
        .get(eventId) as TokenRowCols | undefined;
      // MONEY-VISIBLE fields only. `request_id` is provenance, not spend: two
      // distinct events whose cost/token/cache/unpriced fields are identical
      // count the SAME sum either way, so a request-id difference alone is not
      // a collision the cap cares about — and alarming on it cried
      // "ingest-digest-collision" (only one will be counted) for rows that
      // count identically.
      const differs =
        prior !== undefined &&
        !(
          prior.cost_micro_usd === costMicroUsd &&
          prior.input_tokens === (event.inputTokens ?? 0) &&
          prior.output_tokens === (event.outputTokens ?? 0) &&
          prior.cache_read_tokens === (event.cacheReadTokens ?? 0) &&
          prior.cache_write_tokens === (event.cacheWriteTokens ?? 0) &&
          prior.unpriced === (unpriced ? 1 : 0)
        );
      if (differs) {
        emitGuarded({
          requestId: ctx.requestId,
          operation: "cost-ledger.ingest",
          agentId: event.agentId,
          timestamp: new Date().toISOString(),
          duration: Date.now() - started,
          durationMs: Date.now() - started,
          status: "ok",
          runId: ctx.runId,
          repoSlug: canonicalRepoSlug(ctx.repoSlug),
          issueId: canonicalIssueId(ctx.issueId),
          code: "ingest-digest-collision",
          eventId,
          message: `event ${eventId} digests to an existing row whose fields differ — two distinct events share one identity and only one will be counted toward the cap`,
          outcome: "digest-collision",
        });
      }
    }
    const durationMs = Date.now() - started;
    const inserted = changes === 1;
    log({
      requestId: ctx.requestId,
      operation: "cost-ledger.ingest",
      agentId: event.agentId,
      timestamp: new Date().toISOString(),
      duration: durationMs,
      status: "ok",
      runId: ctx.runId,
      repoSlug: canonicalRepoSlug(ctx.repoSlug),
      issueId: canonicalIssueId(ctx.issueId),
      role: ctx.role,
      kind: "tokens",
      costMicroUsd,
      unpriced: unpriced ? 1 : 0,
      ...(convertError === undefined
        ? {}
        : { code: "cost-convert-invalid", convertError, costUsd: event.costUsd }),
      // Mutually exclusive with the branch above (`subMicro` requires a VALID
      // conversion), so the two spreads can never fight over `code`.
      ...(subMicro ? { code: "cost-sub-micro-unpriced", costUsd: event.costUsd } : {}),
      durationMs,
      outcome: inserted ? "inserted" : "duplicate",
      ingest_ms: durationMs,
    });
    return { eventId, inserted, unpriced };
  }

  /**
   * The box-hours row: fractional VM lifetime × boxHourRateMicroUsd, in
   * INTEGER µ$ (rounded up to the next whole µ$), from the DF2.1 record's own
   * timestamps, written at teardown's close step — the one point at which the
   * destroy is confirmed and the lifetime is final. Never from
   * `captureSpend`: that reads the same token money DF2.7 already priced, and
   * ingesting it would double-count inside the SUM the gate reads — a rule
   * that survives F001 unchanged. It is about which SOURCE owns token money,
   * not about whether that money currently arrives; when the bridge lands,
   * `ingestCostEvent` is still the one writer, and `captureSpend` is still not.
   *
   * F8 (2026-08-24): the DF2.8 story originally specified ceil(lifetime in
   * whole hours) × rate — a 1-hour MINIMUM per box. Live evidence (a ~20s box
   * billed a full hour, 230,000 µ$) overstates short-lived runs by up to 1h
   * each, which compounds at fleet scale. Pricing now runs on wall-clock ms
   * with the µ$ result rounded up (never down — sub-µ$ runtime is not free);
   * the story's Technical Notes carry the amendment.
   */
  ingestBoxHours(ctx: BoxHoursCtx): IngestResult {
    const started = Date.now();
    for (const field of ["runId", "repoSlug", "issueId", "requestId"] as const) {
      const v = (ctx as unknown as Record<string, unknown>)[field];
      if (typeof v !== "string" || v.length === 0) {
        throw new CostLedgerError(
          "ingest-ctx-invalid",
          `box-hours ctx is missing ${field}`,
          "supply { runId, repoSlug, issueId, requestId } from the dispatch that owns the run",
        );
      }
    }
    assertCanonicalIdentity(
      "ingest-ctx-invalid",
      ctx.repoSlug,
      ctx.issueId,
      "supply { runId, repoSlug, issueId, requestId } from the dispatch that owns the run",
    );
    const record = this.readRunRecord(ctx.runId);
    if (record === undefined) {
      throw new CostLedgerError(
        "record-missing",
        `no run record resolves for ${ctx.runId} — the box-hours lifetime has no source`,
        `re-run teardown with readRunRecord wired to the DF2.1 store (see .sandbox/runs/${ctx.runId}.json)`,
      );
    }
    if (record.closedAt === undefined) {
      // A teardown that aborts before close never reaches this call by design;
      // reaching it with an open record means the caller jumped the gun — a
      // billed box may still be alive (AC6 negative control).
      throw new CostLedgerError(
        "box-hours-record-open",
        `run ${ctx.runId} is not closed — the VM lifetime is not final and the destroy is unconfirmed`,
        're-run teardown to completion; qds cost reports this run as box-hours-pending until then',
      );
    }
    const created = Date.parse(record.createdAt);
    const closed = Date.parse(record.closedAt);
    if (!Number.isFinite(created) || !Number.isFinite(closed) || closed < created || created <= 0) {
      throw new CostLedgerError(
        "box-hours-lifetime-invalid",
        `run ${ctx.runId} lifetime is not computable (createdAt ${record.createdAt}, closedAt ${record.closedAt})`,
        `repair the run record's timestamps, then re-run teardown — the row is pending until then`,
      );
    }
    const rate = this.config.boxHourRateMicroUsd;
    if (rate === undefined) {
      throw new CostConfigError(
        "box-hour-rate-unconfigured",
        "boxHourRateMicroUsd is not configured — an unpriced box hour must surface, not silently cost 0",
        `write {"boxHourRateMicroUsd": <integer µ$/h>} to .sandbox/cost-config.json (exe.dev figures are vendor-single-origin [VERIFY] — R5 §6 fact 11), then re-run teardown`,
      );
    }
    // F8: integer µ$ from wall-clock ms — rate·ms over ms-per-hour, rounded UP
    // so a sub-µ$ lifetime still prices at 1 µ$, never 0. The product
    // rate·lifetimeMs is checked for exact-integrality BEFORE the division:
    // a float drift there would silently misprice by more than the rounding.
    const lifetimeMs = closed - created;
    const numerator = rate * lifetimeMs;
    if (!Number.isSafeInteger(numerator)) {
      throw new CostLedgerError(
        "box-hours-cost-invalid",
        `run ${ctx.runId} box-hours product is not a safe integer (lifetime ${lifetimeMs}ms × rate ${rate} µ$/h = ${numerator}) — refusing to store a silently wrong figure`,
        "repair the run record's createdAt/closedAt or lower boxHourRateMicroUsd in .sandbox/cost-config.json, then re-run teardown",
      );
    }
    const costMicroUsd = Math.ceil(numerator / MS_PER_HOUR);
    if (!Number.isSafeInteger(costMicroUsd)) {
      throw new CostLedgerError(
        "box-hours-cost-invalid",
        `run ${ctx.runId} box-hours cost is not a safe integer (lifetime ${lifetimeMs}ms × rate ${rate} µ$/h = ${costMicroUsd} µ$) — refusing to store a silently wrong figure`,
        "repair the run record's createdAt/closedAt or lower boxHourRateMicroUsd in .sandbox/cost-config.json, then re-run teardown",
      );
    }
    const eventId = boxHoursEventId(ctx.runId, record.closedAt);
    // Same busy taxonomy as ingestCostEvent: a teardown-ingest racing the gate
    // surfaces as `ledger-busy`, not a raw driver error (fail-closed either
    // way — this is classification, not correction).
    let changes: number;
    try {
      ({ changes } = this.db
        .prepare(
          `INSERT INTO cost_events (
           event_id, run_id, repo_slug, issue_id, request_id, role, agent_id,
           kind, invocation_seq, cost_micro_usd, unpriced, created_at
         ) VALUES (?,?,?,?,?, NULL, NULL, 'box_hours', 0, ?, 0, ?)
         ON CONFLICT(event_id) DO NOTHING`,
        )
        .run(eventId, ctx.runId, canonicalRepoSlug(ctx.repoSlug), canonicalIssueId(ctx.issueId), ctx.requestId, costMicroUsd, new Date().toISOString()));
    } catch (e) {
      throw ledgerBusyError(e) ?? e;
    }
    const durationMs = Date.now() - started;
    const inserted = changes === 1;
    if (inserted) {
      // K1 residual, made loud instead of silent: admitIssue retires a closed
      // run's reservation once `closedAt` passes ADMISSION_GRACE_MS +
      // ADMISSION_SKEW_MARGIN_MS (~6 min), re-granting the freed headroom to
      // the next dispatch. Teardown's crash-recovery re-run can land THIS row
      // after that cutoff — spend on a cap whose reservation is gone. Nothing
      // here can un-retire (gate_admissions is append-only, INV-COST-1), so
      // the money-safe response is to name the exposure the moment it lands.
      const landedLate =
        costMicroUsd > 0 &&
        Number.isFinite(closed) &&
        closed <= Date.now() - ADMISSION_GRACE_MS - ADMISSION_SKEW_MARGIN_MS;
      if (landedLate) {
        emitGuarded({
          requestId: ctx.requestId,
          operation: "cost-ledger.ingest",
          agentId: null,
          timestamp: new Date().toISOString(),
          duration: durationMs,
          durationMs,
          status: "ok",
          runId: ctx.runId,
          repoSlug: canonicalRepoSlug(ctx.repoSlug),
          issueId: canonicalIssueId(ctx.issueId),
          kind: "box_hours",
          costMicroUsd,
          closedAt: record.closedAt,
          code: "box-hours-late-past-reservation-cutoff",
          message: `box hours for run ${ctx.runId} landed ${Math.round((Date.now() - closed) / 1000)}s after its close — past the ~${(ADMISSION_GRACE_MS + ADMISSION_SKEW_MARGIN_MS) / 1000}s reservation-retirement cutoff, so admissions granted since may have spent into this charge; the issue total can exceed its cap`,
          outcome: "late-ingest-over-cap-risk",
        });
      }
    }
    if (!inserted) {
      // The digest keys on (runId, closedAt). A redelivered teardown digesting
      // identically is correct dedup — the idempotent re-run path. But a row on
      // disk priced DIFFERENTLY than this call computes means the stored figure
      // no longer matches the record's lifetime × rate: a hand-edited rate or
      // record re-priced after the fact, and one of the two figures is wrong in
      // the SUM. Never silent — money-visible.
      const prior = this.db
        .prepare("SELECT cost_micro_usd FROM cost_events WHERE event_id = ?")
        .get(eventId) as { cost_micro_usd: number } | undefined;
      if (prior !== undefined && prior.cost_micro_usd !== costMicroUsd) {
        emitGuarded({
          requestId: ctx.requestId,
          operation: "cost-ledger.ingest",
          agentId: null,
          timestamp: new Date().toISOString(),
          duration: durationMs,
          durationMs,
          status: "ok",
          runId: ctx.runId,
          repoSlug: canonicalRepoSlug(ctx.repoSlug),
          issueId: canonicalIssueId(ctx.issueId),
          code: "ingest-digest-collision",
          eventId,
          storedCostMicroUsd: prior.cost_micro_usd,
          computedCostMicroUsd: costMicroUsd,
          message: `box-hours event ${eventId} digests to an existing row priced ${prior.cost_micro_usd} µ$ but recomputed at ${costMicroUsd} µ$ — rate or record changed since it landed; the SUM counts the STORED figure`,
          outcome: "digest-collision",
        });
      }
    }
    log({
      requestId: ctx.requestId,
      operation: "cost-ledger.ingest",
      agentId: null,
      timestamp: new Date().toISOString(),
      duration: durationMs,
      status: "ok",
      runId: ctx.runId,
      repoSlug: canonicalRepoSlug(ctx.repoSlug),
      issueId: canonicalIssueId(ctx.issueId),
      role: null,
      kind: "box_hours",
      costMicroUsd,
      unpriced: 0,
      durationMs,
      outcome: inserted ? "inserted" : "duplicate",
      ingest_ms: durationMs,
    });
    return { eventId, inserted, unpriced: false };
  }

  // ─── views ─────────────────────────────────────────────────────────────────

  /** The run-keyed view (DF5.3 audit hop 3 / DF5.4 C10) — same schema, and the same F001 box-hours-only caveat, as the issue view. */
  readRunCost(runId: string): CostView {
    return this.view("run_id = ?", [runId], "run_id = ? AND unpriced = 0", [runId], "run_id = ? AND unpriced = 1", [runId]);
  }

  /**
   * The issue-keyed view — the same SUM the gate reads (INV-COST-2: derived,
   * never denormalized; see the header for what that does NOT promise while
   * F001 stands — the rows summed here are box hours only).
   */
  readIssueCost(repoSlug: string, issueId: string): CostView {
    const all = issueScopeSql();
    const priced = `${all} AND unpriced = 0`;
    const unpricedQ = `${all} AND unpriced = 1`;
    // Both halves fold on BOTH sides (issueScopeSql): a row written before
    // canonicalisation and one written after both match. The OR is parenthesised
    // inside the fragment, so appending ` AND unpriced = …` stays correct.
    const keys = issueScopeKeys(repoSlug, issueId);
    return this.view(all, keys, priced, keys, unpricedQ, keys);
  }

  private view(
    allWhere: string,
    allKeys: string[],
    pricedWhere: string,
    pricedKeys: string[],
    unpricedWhere: string,
    unpricedKeys: string[],
  ): CostView {
    this.assertQueryable();
    const totalRow = this.db
      .prepare(`SELECT COALESCE(SUM(cost_micro_usd), 0) AS total FROM cost_events WHERE ${pricedWhere}`)
      .get(...pricedKeys) as { total: number };
    const roleRows = this.db
      .prepare(
        `SELECT CASE WHEN kind = 'box_hours' THEN 'box-hours' ELSE role END AS bucket,
                SUM(cost_micro_usd) AS sum
         FROM cost_events WHERE ${pricedWhere} GROUP BY bucket`,
      )
      .all(...pricedKeys) as { bucket: string | null; sum: number }[];
    const tokenRow = this.db
      .prepare(
        `SELECT COALESCE(SUM(input_tokens), 0) AS inputTokens,
                COALESCE(SUM(output_tokens), 0) AS outputTokens,
                COALESCE(SUM(cache_read_tokens), 0) AS cacheReadTokens,
                COALESCE(SUM(cache_write_tokens), 0) AS cacheWriteTokens
         FROM cost_events WHERE ${pricedWhere} AND kind = 'tokens'`,
      )
      .get(...pricedKeys) as {
      inputTokens: number;
      outputTokens: number;
      cacheReadTokens: number;
      cacheWriteTokens: number;
    };
    const unpricedRow = this.db
      .prepare(`SELECT COUNT(*) AS n FROM cost_events WHERE ${unpricedWhere}`)
      .get(...unpricedKeys) as { n: number };
    const anyRow = this.db
      .prepare(`SELECT COUNT(*) AS n FROM cost_events WHERE ${allWhere}`)
      .get(...allKeys) as { n: number };
    const perRole: Record<string, number> = {};
    for (const row of roleRows) perRole[row.bucket ?? "unknown"] = row.sum;
    return {
      totalMicroUsd: totalRow.total,
      perRole,
      tokenTotals: { inputTokens: tokenRow.inputTokens, outputTokens: tokenRow.outputTokens },
      cacheTotals: { cacheReadTokens: tokenRow.cacheReadTokens, cacheWriteTokens: tokenRow.cacheWriteTokens },
      unpricedRows: unpricedRow.n,
      eventCount: anyRow.n,
      hasEvents: anyRow.n > 0,
    };
  }

  /**
   * Per-run breakdown rows for the CLI: every run with priced token spend plus
   * its box-hours state — `boxHoursPending` when no box_hours row exists yet
   * (an aborted teardown is pending, never zero).
   */
  readIssueRuns(repoSlug: string, issueId: string): {
    runId: string;
    totalMicroUsd: number;
    hasBoxHours: boolean;
  }[] {
    this.assertQueryable();
    const rows = this.db
      .prepare(
        `SELECT run_id,
                COALESCE(SUM(CASE WHEN unpriced = 0 THEN cost_micro_usd ELSE 0 END), 0) AS total,
                MAX(CASE WHEN kind = 'box_hours' THEN 1 ELSE 0 END) AS hasBox
         FROM cost_events WHERE ${issueScopeSql()}
         GROUP BY run_id ORDER BY MIN(created_at)`,
      )
      .all(...issueScopeKeys(repoSlug, issueId)) as { run_id: string; total: number; hasBox: number }[];
    return rows.map((r) => ({ runId: r.run_id, totalMicroUsd: r.total, hasBoxHours: r.hasBox === 1 }));
  }

  /**
   * F001 / Q1 ("deferred", `docs/decisions/2026-08-tech-debt-answers.md`):
   * announce that this ledger holds no `kind='tokens'` row at all.
   *
   * `ingestCostEvent` is the only writer of those rows, and nothing in the
   * dispatch path calls it — the DF2.7 `cost` events the CLI runner emits
   * (`cli-anything/src/runner.ts`) never reach this store. The bridge is
   * designed, typed and tested; it is not built. So a real ledger holds box
   * hours only, and every per-issue figure derived from it — this store's
   * views AND `admitIssue`'s cap — counts box time and no token spend. The gap
   * is money-shaped, so it is stated on the operator's own channel instead of
   * being left to a docstring nobody reads while budgeting.
   *
   * Ledger-WIDE, not issue-scoped: the claim is about the WIRING, so a single
   * token row anywhere is proof enough that the bridge is live, and an issue
   * that happens to have spent nothing on tokens is not evidence of anything.
   * A `LIMIT 1` existence probe, never a COUNT — the answer is a boolean.
   *
   * Returns whether the ledger is degraded, so a caller can branch without
   * re-querying. Guarded like every other emission here: a raising sink must
   * not convert a report into a thrown error.
   */
  // ponytail: this DECLARES the F001 gap rather than closing it — token spend
  // stays outside every per-issue cap, and only an operator reading qds-cost
  // learns that. Upgrade path: one `ingestCostEvent` call at the dispatcher
  // site that consumes the `{kind:"cost"}` team event, after which this method
  // can only ever return false and should be deleted with its tests.
  emitTokenBridgeState(): boolean {
    this.assertQueryable();
    const row = this.db.prepare("SELECT 1 AS present FROM cost_events WHERE kind = 'tokens' LIMIT 1").get() as
      | { present: number }
      | null
      | undefined;
    if (row !== null && row !== undefined) return false;
    emitGuarded({
      requestId: newRequestId(),
      operation: "cost-ledger.token-bridge",
      agentId: null,
      timestamp: new Date().toISOString(),
      duration: 0,
      status: "ok",
      code: "tokens-ledger-unwired",
      ledgerPath: this.path,
      message: `no kind='tokens' row has ever been written to ${this.path} — the DF2.7 cost-event bridge into this ledger is unbuilt, so per-issue caps count box-hours only and token spend is unbudgeted`,
      outcome: "token-bridge-unwired",
    });
    return true;
  }

  private assertQueryable(): void {
    try {
      // Probe must touch the btree — a bare SELECT 1 never opens cost_events, so page-level corruption would pass.
      this.db.prepare("SELECT 1 FROM cost_events LIMIT 1").get();
    } catch (e) {
      throw new CostLedgerError(
        "ledger-unqueryable",
        `the cost ledger cannot be queried (${(e as Error).message}) — refusing to treat spend as zero`,
        `repair or remove ${this.path} (it is append-only state; a fresh file under-counts), then re-run`,
      );
    }
  }

  // ─── serialized admission (R2 §6) ──────────────────────────────────────────

  /**
   * The cap decision, inside one BEGIN IMMEDIATE transaction: read the priced
   * SUM, add the ceilings of outstanding admissions (runs admitted but not yet
   * reporting spend), and if committed ≥ cap refuse — otherwise insert this
   * dispatch's admission and return `min(keyCapMicroUsd, remainingMicroUsd)`,
   * the one ceiling handed to DF2.3's mint (AC3). `remainingMicroUsd` is the
   * headroom AFTER spend and reservations (the same `committed` the refusal
   * check uses), so an admitted ceiling can never over-commit the issue past
   * its cap.
   *
   * **What a reservation means.** It is OUTSTANDING UNSPENT EXPOSURE: money the
   * issue's cap has already committed to a run that has not yet reported
   * spending it. It is not a bookkeeping artefact and it is not a leak, so no
   * caller should ever "release" one on a failure path. In particular, a
   * dispatch that fails AFTER provisioning still holds its reservation
   * correctly: INV-5 deliberately leaves the box alive and — past the mint —
   * the key live at the FULL admitted ceiling so an operator can diagnose the
   * failure, so the exposure the reservation represents is entirely real. A
   * compensating release there would under-report live risk and let the next
   * dispatch overcommit the same cap.
   *
   * **How it retires.** By itself, once the run reports **actual priced spend**
   * — a priced row whose `cost_micro_usd` is greater than zero — so a finished
   * run's admission never blocks the next dispatch. SPEND, not the mere
   * existence of a row: a run whose first event is a free or cached turn writes
   * a perfectly valid `cost_micro_usd = 0, unpriced = 0` row, and testing for
   * existence retired that run's ENTIRE ceiling while it still held a live key
   * at that ceiling — the next dispatch then saw `spent = 0, reserved = 0` and
   * was granted the full cap, N times over for N dispatches. An unpriced row is
   * not observable spend either: a run reporting only unpriced rows keeps its
   * full ceiling counted, so unpriced traffic never silently restores headroom
   * the cap was holding. A run that never reports priced spend keeps its
   * reservation while it is still OPEN, by design: teardown's box-hours ingest
   * (or the DF2.6 reaper, which routes through teardownSandbox) is what writes
   * the priced `box_hours` row that retires it. A reservation's lifetime is
   * therefore bounded by the same fleet hygiene that bounds an open record with
   * a live box — that is the retirement path for a failed dispatch too.
   *
   * The second retirement, and the reason "actual spend" is not a wedge: a run
   * whose record is CLOSED retires too — once the close is older than the
   * grace cutoff. Every row still in the loop is by construction a run that
   * has reported no positive spend, and a closed record means the box is gone
   * and the key revoked — the exposure the reservation represents is over, and
   * nothing else will ever come to retire it (a zero-length lifetime prices
   * box-hours at 0 µ$, which is another priced zero). Without this, a run that
   * genuinely cost nothing would hold its ceiling against the issue forever,
   * and `gate_admissions_no_delete` leaves no manual exit. This is strictly
   * more conservative than retiring on any priced row: it fires later, and
   * only for runs that spent nothing.
   *
   * The "older than the grace cutoff" qualifier is the close→price race guard:
   * teardown closes the record FIRST and writes the priced `box_hours` row
   * moments later (same step, or later through the crash-recovery re-run).
   * Retiring on the bare close freed headroom that the imminent charge then
   * consumed past cap — box hours being the one term no key bounds. So a
   * FRESHLY-closed record keeps counting until its close passes the same
   * cutoff the orphan expiry uses, by which point either the row landed or
   * teardown's retry path has surfaced the failure loudly. An unparseable
   * closed_at retires as before: holding it would be a wedge with no exit,
   * because the record resolves cleanly and the orphan expiry never fires.
   *
   * The one expiry: an admission older than `ADMISSION_GRACE_MS +
   * ADMISSION_SKEW_MARGIN_MS` whose run record is STRUCTURALLY ABSENT — it does
   * not resolve through readRunRecord AND the record path stats as ENOENT (or a
   * confirmed zero-byte tombstone), so createRun's store.create failed and no
   * run can ever exist — stops counting; a throw over a record still on disk
   * keeps its ceiling counted (see the orphan guard).
   *
   * A retry reusing the same `(requestId, runId)` is idempotent: it is judged
   * against the headroom its original saw (its own reservation is excluded from
   * the sum) and hands back the ceiling already ON the row, never a second one
   * — clamped to the headroom recomputed now, so `admittedCeilingMicroUsd <=
   * remainingMicroUsd` holds on the replay path too. Idempotent for the SAME
   * `(repoSlug, issueId)` only — the replay branch refuses a correlation id
   * that resolves to another issue's reservation.
   */
  /**
   * Read-only budget snapshot for ONE canonical (repoSlug, issueId): the
   * ceiling `admitIssue` would enforce, the priced spend booked so far, and the
   * live reservations (one per run — a run with any priced>0 event has settled
   * and stops counting, exactly as in admitIssue's own reservation sum).
   *
   * F15 (2026-08-25, live fan-20260825-{ff6d64,b37e88}): fan-out arms share the
   * brief's single issueId, and admitIssue budgets PER ISSUE — so an n-arm
   * fan-out whose issue ceiling sat below n×cap admitted arm 0 and
   * deterministically refused every later arm AFTER arm 0 had provisioned a
   * billable box. The pre-flight that prevents this needs to SEE the same three
   * numbers admission will act on, from the same ledger instance, without
   * taking the write lock or writing a row.
   */
  issueBudgetSnapshot(repoSlug: string, issueId: string): {
    ceilingMicroUsd: number;
    spentMicroUsd: number;
    reservedMicroUsd: number;
  } {
    assertCanonicalIdentity(
      "admission-input-invalid",
      repoSlug,
      issueId,
      "supply the dispatch-resolved {repoSlug, issueId} pair",
    );
    const slug = canonicalRepoSlug(repoSlug);
    const issue = canonicalIssueId(issueId);
    const scopeKeys = issueScopeKeys(repoSlug, issueId);
    this.assertQueryable();
    const spentRow = this.db
      .prepare(
        `SELECT COALESCE(SUM(cost_micro_usd), 0) AS total FROM cost_events WHERE ${issueScopeSql()} AND unpriced = 0`,
      )
      .get(...scopeKeys) as { total: number };
    // Same per-run MAX and settled-run exclusion as admitIssue's reservation
    // sum: ONE live ceiling per run, retired once the run reports real spend.
    const reservedRow = this.db
      .prepare(
        `SELECT COALESCE(SUM(ceiling), 0) AS total FROM (
           SELECT MAX(a.ceiling_micro_usd) AS ceiling
           FROM gate_admissions a
           WHERE ${issueScopeSql("a.repo_slug", "a.issue_id")}
             AND NOT EXISTS (
               SELECT 1 FROM cost_events ce
               WHERE ce.run_id = a.run_id AND ce.unpriced = 0 AND ce.cost_micro_usd > 0
             )
           GROUP BY a.run_id
         )`,
      )
      .get(...scopeKeys) as { total: number };
    return {
      ceilingMicroUsd: capForIssue(this.config, slug, issue),
      spentMicroUsd: spentRow.total,
      reservedMicroUsd: reservedRow.total,
    };
  }

  admitIssue(input: AdmissionInput, capMicroUsd: number, keyCapMicroUsd: number): AdmissionDecision {
    const started = Date.now();
    // All four are load-bearing SQL BINDS, not optional decoration. A non-string
    // `requestId`/`runId` binds as NULL, and SQLite's three-valued logic then
    // makes `NOT (a.request_id = NULL AND a.run_id = ?)` evaluate to NULL for
    // EVERY row — which the WHERE clause treats as false, so the reservation
    // query returns nothing, every outstanding reservation vanishes, and this
    // admission is handed the entire remaining cap on top of every live one.
    // The pair are correlation keys; refusing them here is cheaper than the
    // three-valued reasoning needed to prove any single query safe.
    for (const field of ["repoSlug", "issueId", "runId", "requestId"] as const) {
      const v = (input as unknown as Record<string, unknown>)[field];
      if (typeof v !== "string" || v.length === 0) {
        throw new CostLedgerError(
          "admission-input-invalid",
          `admission input is missing ${field} — refusing to decide a cap against a NULL bind`,
          "supply { repoSlug, issueId, runId, requestId } from the dispatch's resolved correlation",
        );
      }
    }
    // Settle identity ONCE for this admission: every predicate below and the
    // gate_admissions row all key on the same canonical (slug, issue) pair, so
    // the spend a decision reads and the reservation it writes can never be two
    // identities — and `42`/`#42`/`042` cannot each hold their own full cap.
    assertCanonicalIdentity(
      "admission-input-invalid",
      input.repoSlug,
      input.issueId,
      "supply { repoSlug, issueId, runId, requestId } from the dispatch's resolved correlation",
    );
    const repoSlug = canonicalRepoSlug(input.repoSlug);
    const issueId = canonicalIssueId(input.issueId);
    const scopeKeys = issueScopeKeys(input.repoSlug, input.issueId);
    this.assertQueryable();
    if (!Number.isInteger(capMicroUsd) || capMicroUsd <= 0) {
      throw new CostConfigError(
        "cost-config-invalid",
        `capMicroUsd must be a positive integer of micro-dollars, got ${capMicroUsd}`,
        "fix defaultCapMicroUsd / perIssueOverrides in .sandbox/cost-config.json",
      );
    }
    // Same validation as capMicroUsd above, for the same reason: this one is
    // the OTHER operand of the `Math.min` that becomes the minted ceiling, and
    // it lands in a STRICT INTEGER column. Unvalidated, `-1` returned
    // `admitted: true` with a negative ceiling handed to the mint, and a float
    // or NaN failed at the INSERT with a bare SQLITE_CONSTRAINT naming nothing.
    if (!Number.isInteger(keyCapMicroUsd) || keyCapMicroUsd <= 0) {
      throw new CostConfigError(
        "cost-config-invalid",
        `keyCapMicroUsd must be a positive integer of micro-dollars, got ${keyCapMicroUsd}`,
        "fix the DF2.3 key cap the gate passes (defaultKeyCapMicroUsd in src/providers/credentials.ts, or the caller's override)",
      );
    }
    // ── everything that touches the filesystem or a log sink happens HERE,
    // OUTSIDE the write transaction ────────────────────────────────────────
    // The reservation loop below needs one run record per outstanding
    // reservation, and `decide.immediate()` holds the WAL write lock for its
    // whole body against a 5s busy_timeout. Reading N records (and writing N log
    // lines) under that lock serializes every concurrent dispatch behind N
    // syscalls, so a slow FS or a long reservation list turns into SQLITE_BUSY
    // out of admitIssue — fail-closed, so no money is lost, but an availability
    // wedge that scales with reservation count. So: read the records first, then
    // let the transaction consult the map. Rows that appear between this read
    // and the transaction are still read live inside it — a race that can only
    // add the odd record, never the whole list. Correctness is untouched: the
    // SUM→INSERT serialization the gate depends on is all still inside.
    // Only SUCCESSFUL reads are cached. An ABSENCE or a THROW is a fact about
    // the prefetch instant, not about the decision: freezing either across the
    // gap to the write lock retired reservations whose record had appeared
    // meanwhile (`{record: undefined}` → expired-orphan for a row whose
    // dispatch had just created its record) or expired them off an error that
    // had already cleared. Both are re-read LIVE inside the transaction below.
    const prefetched = new Map<string, RunCostRecord>();
    // Moving this read OUT of the transaction moved it out of the busy mapping
    // too: `decide.immediate()` below translates SQLITE_BUSY into the typed
    // `ledger-busy` refusal, and for as long as the read lived inside it, so did
    // this query. Out here an untyped better-sqlite3 `SQLITE_BUSY` escaped
    // `admitIssue` raw — the same transient contention, in a shape the gate's
    // callers cannot switch on, so a retryable lock read as an unknown ledger
    // fault. The availability fix must not cost the typed refusal.
    //
    // Only the QUERY is wrapped. Per-record `readRunRecord` failures keep the
    // loop's own classification (young ⇒ refuse, aged ⇒ expire) — they are
    // filesystem faults about ONE reservation, not ledger contention.
    let admittedRuns: { runId: string }[];
    try {
      admittedRuns = this.db
        .prepare(`SELECT DISTINCT run_id AS runId FROM gate_admissions WHERE ${issueScopeSql()}`)
        .all(...scopeKeys) as { runId: string }[];
    } catch (e) {
      throw ledgerBusyError(e) ?? e;
    }
    for (const row of admittedRuns) {
      try {
        const record = this.readRunRecord(row.runId);
        if (record !== undefined) prefetched.set(row.runId, record);
      } catch {
        // Not cached — see the map comment above: the transaction re-reads
        // live, so a fault here costs one extra read inside the lock instead of
        // freezing a transient failure into an expiry.
      }
    }
    // Log lines the reservation loop wants to emit, flushed after the write
    // lock is released. `log` is a sink of unknown cost (fd, stdout, whatever a
    // deployment wires it to); it has no business inside BEGIN IMMEDIATE.
    const pendingLogs: Parameters<typeof log>[0][] = [];
    const decide = this.db.transaction((): AdmissionDecision => {
      const spentRow = this.db
        .prepare(
          `SELECT COALESCE(SUM(cost_micro_usd), 0) AS total, COUNT(*) AS n FROM cost_events WHERE ${issueScopeSql()} AND unpriced = 0`,
        )
        .get(...scopeKeys) as { total: number; n: number };
      // The caller's OWN row is excluded from the reservations below: this
      // admission is either fresh (no such row exists, so the exclusion matches
      // nothing) or a retry of the same (request_id, run_id), which must be
      // judged against the headroom its original saw — not against its own
      // reservation. Counting itself charged the cap twice for one run: with the
      // default cap below the key cap the first admission reserves the WHOLE
      // cap, so `committed >= cap` refused every retry with `spend-cap-exceeded`
      // and the replay branch below never ran. It also left `remainingMicroUsd`
      // net of a reservation the returned `admittedCeilingMicroUsd` (the
      // recorded one) is not net of, breaking the `admittedCeilingMicroUsd <=
      // remainingMicroUsd` invariant consumers rely on. Not a hole: the
      // exclusion is the PRIMARY KEY, so it can only ever drop the caller's own
      // row, and a DIFFERENT correlation id still sees the reservation. Every
      // admitted ceiling is <= the headroom left after the reservations
      // outstanding at ITS admission, so the recorded ceiling a replay hands
      // back still fits the headroom recomputed here.
      const reservedRows = this.db
        .prepare(
          `SELECT MAX(a.ceiling_micro_usd) AS ceiling, a.run_id AS runId, MAX(a.decided_at) AS decidedAt
           FROM gate_admissions a
           WHERE ${issueScopeSql("a.repo_slug", "a.issue_id")}
             -- IS, not =: NULL-safe equality. The guard in admitIssue already
             -- refuses a non-string correlation key, but plain = makes the whole
             -- predicate evaluate to NULL on a NULL bind and silently drops
             -- EVERY reservation, so this query does not rely on that guard
             -- staying put.
             AND NOT (a.request_id IS ? AND a.run_id IS ?)
             -- SPEND, not a row. "cost_micro_usd > 0" is the difference between
             -- "this run has reported what it spent" and "this run has reported
             -- something": a free or cached turn writes a valid priced ZERO row,
             -- and existence alone retired the run's whole ceiling while its key
             -- was still live at that ceiling — handing the next dispatch the
             -- full cap a second time.
             AND NOT EXISTS (
               SELECT 1 FROM cost_events ce
               WHERE ce.run_id = a.run_id AND ce.unpriced = 0 AND ce.cost_micro_usd > 0
             )
           -- ONE reservation per run, whatever the request id. gate_admissions'
           -- PRIMARY KEY is (request_id, run_id), so retrying a run under a
           -- FRESH request id inserts a SECOND row for one run; ungrouped, both
           -- counted and the issue's headroom fell by twice the ceiling for a
           -- single live key, refusing later legitimate dispatches. MAX on both
           -- columns is the fail-safe pick: the largest exposure, and the
           -- YOUNGEST decided_at (so the reservation ages out no sooner than its
           -- most recent admission would).
           GROUP BY a.run_id`,
        )
        .all(...scopeKeys, input.requestId, input.runId) as {
        ceiling: number;
        runId: string;
        decidedAt: string;
      }[];
      const graceCutoff = Date.now() - ADMISSION_GRACE_MS - ADMISSION_SKEW_MARGIN_MS;
      let reservedMicroUsd = 0;
      // The ONE add site for every path that counts a ceiling — the loop body
      // below and the kept-reservation arm of the catch above it — so the
      // safe-integer guard cannot drift out of either.
      const reserve = (ceiling: number): void => {
        reservedMicroUsd += ceiling;
        // Overflow guard: sum of reservation ceilings can exceed MAX_SAFE_INTEGER
        if (reservedMicroUsd > Number.MAX_SAFE_INTEGER) {
          throw new CostLedgerError(
            "ledger-overflow",
            `sum of reservation ceilings (${reservedMicroUsd} µ$) exceeds safe integer range`,
            "wait for existing reservations to retire, or raise the issue cap",
          );
        }
      };
      for (const row of reservedRows) {
        // The row's fate is classifyReservation's — see it for the orphan
        // guard, the aged-throw rule and the closed-record retirement.
        // gate_admissions is append-only (INV-COST-1), so expiry lives here in
        // the read, not in a row mutation. `young` is needed up here too: a
        // young unreadable record rethrows with the ORIGINAL error.
        const young = isReservationYoung(row, graceCutoff);
        // Read UNCONDITIONALLY, then let `young` decide how to read the answer.
        // Short-circuiting on `young` meant a corrupt record was never touched
        // at admission time for the first ADMISSION_GRACE_MS, so the refusal
        // the comment above promises did not happen — the corruption surfaced
        // 60s later, on somebody else's dispatch.
        //
        // A THROW past the cutoff expires the reservation ONLY when the record's
        // absence is STRUCTURAL (see the catch below): an ungrammatical run_id
        // that landed in gate_admissions before assertValidRunId ever saw it,
        // a proven-ENOENT path, or a 0-byte tombstone caught mid-`createUnlogged`.
        // Those made readRunRecord throw and used to refuse every future
        // dispatch for the issue while `gate_admissions_no_delete` blocked the
        // manual remedy — a wedge with no exit, which is what expiry cures. A
        // throw over a record that is demonstrably STILL ON DISK is the other
        // fact: a live box whose ceiling must keep counting.
        // Below the cutoff the throw still propagates either way: a young
        // unreadable record is far more likely a real in-flight dispatch than
        // an orphan, and refusing once is recoverable where over-granting the
        // cap is not.
        let read: ReservationRecord;
        let readError: unknown;
        try {
          // Prefetched outside the write lock — but only a successful read is
          // trusted across that gap. A cache miss (row appeared since, or the
          // prefetch read failed) re-reads LIVE here: one extra syscall inside
          // the lock, against silently expiring a reservation whose record is
          // already on disk or whose prefetch fault was transient. The
          // classification below is unchanged — a throw still lands on THIS
          // dispatch, young ⇒ refuse, aged ⇒ expire.
          const cached = prefetched.get(row.runId);
          const record = cached ?? this.readRunRecord(row.runId);
          read = record === undefined ? { kind: "absent" } : { kind: "resolved", record };
        } catch (e) {
          readError = e;
          // Aged: expiry is reserved for STRUCTURAL absence — proven ENOENT or
          // a confirmed zero-byte tombstone (see `recordStructurallyAbsent`).
          // A young row refuses whatever the answer, so the probe is skipped
          // there rather than paying for a syscall that cannot change it.
          read = {
            kind: "unreadable",
            structurallyAbsent: young ? false : this.recordStructurallyAbsent(row.runId),
          };
        }
        // The row's whole fate, decided once: classifyReservation owns the rule
        // (F042) and every one of its five verdicts is answered here.
        const verdict = classifyReservation(row, read, graceCutoff);
        switch (verdict) {
          case "refuse":
            // A young unreadable record propagates the ORIGINAL error.
            throw readError;
          case "hold-unresolvable":
            pendingLogs.push({
              requestId: input.requestId,
              operation: "cost-ledger.gate",
              agentId: null,
              timestamp: new Date().toISOString(),
              duration: Date.now() - started,
              status: "ok",
              runId: input.runId,
              repoSlug,
              issueId,
              code: "reservation-unresolvable-held",
              orphanRunId: row.runId,
              orphanDecidedAt: row.decidedAt,
              orphanCeilingMicroUsd: row.ceiling,
              message: `reservation for run ${row.runId} is past the grace window and its record could not be read (${(readError as Error).message}) — the record file is present on disk (or its absence is unprovable), so its ceiling stays counted against the cap`,
              outcome: "reservation-held",
            });
            reserve(row.ceiling);
            break;
          case "expire-unresolvable":
            // Never silent: the expired row is named, so an operator can tell an
            // expiry from a reservation that simply retired. Queued, not logged —
            // the sink runs after the write lock is released.
            pendingLogs.push({
              requestId: input.requestId,
              operation: "cost-ledger.gate",
              agentId: null,
              timestamp: new Date().toISOString(),
              duration: Date.now() - started,
              status: "ok",
              runId: input.runId,
              repoSlug,
              issueId,
              code: "reservation-unresolvable-expired",
              orphanRunId: row.runId,
              orphanDecidedAt: row.decidedAt,
              orphanCeilingMicroUsd: row.ceiling,
              message: `reservation for run ${row.runId} is past the grace window and its record cannot be read (${(readError as Error).message}) — expiring it rather than wedging the issue's cap`,
              outcome: "reservation-expired",
            });
            break;
          case "expire":
            break;
          case "count":
            reserve(row.ceiling);
            break;
          default: {
            // Unreachable while the switch is exhaustive — this assignment is
            // what makes tsc say so, and it fails the build the moment a
            // verdict is added without a case here. If one ever did reach
            // runtime, keep the ceiling counted: under-admitting is the safe
            // direction (INV-COST-6), silently dropping it is not.
            const _exhaustive: never = verdict;
            void _exhaustive;
            reserve(row.ceiling);
            break;
          }
        }
      }
      const unpricedRow = this.db
        .prepare(
          `SELECT COUNT(*) AS n FROM cost_events WHERE ${issueScopeSql()} AND unpriced = 1`,
        )
        .get(...scopeKeys) as { n: number };
      const spentMicroUsd = spentRow.total;
      const unpricedRows = unpricedRow.n;
      const cap = capMicroUsd;
      const committed = spentMicroUsd + reservedMicroUsd;
      if (committed >= cap) {
        return {
          admitted: false,
          status: "over-budget",
          reason: "spend-cap-exceeded",
          capMicroUsd: cap,
          spentMicroUsd,
          reservedMicroUsd,
          unpricedRows,
        };
      }
      // Headroom after spend AND outstanding reservations — the same
      // `committed` the refusal check uses, so an admitted ceiling can never
      // over-commit the issue past its cap.
      const remainingMicroUsd = cap - committed;
      // Guard against cap being lowered after spend: remaining <= 0 means over-cap
      if (remainingMicroUsd <= 0) {
        return {
          admitted: false,
          status: "over-budget",
          reason: "spend-cap-exceeded",
          capMicroUsd: cap,
          spentMicroUsd,
          reservedMicroUsd,
          unpricedRows,
        };
      }
      let ceiling = Math.min(keyCapMicroUsd, remainingMicroUsd);
      const { changes } = this.db
        .prepare(
          `INSERT INTO gate_admissions (request_id, run_id, repo_slug, issue_id, ceiling_micro_usd, decided_at)
           VALUES (?,?,?,?,?,?)
           ON CONFLICT(request_id, run_id) DO NOTHING`,
        )
        .run(input.requestId, input.runId, repoSlug, issueId, ceiling, new Date().toISOString());
      if (changes === 0) {
        // `DO NOTHING` fired: this (request_id, run_id) already holds a
        // reservation — a retried dispatch reusing its correlation id after a
        // `store.create` EEXIST, or any caller-level retry. Returning the
        // freshly-computed `ceiling` handed DF2.3's mint a ceiling that appears
        // in NO row and therefore holds NO reservation, and the next dispatch
        // granted the same headroom again (c1 + c2 + c2 against a cap of
        // c1 + c2). Hand back the ceiling that IS on the row instead: it is
        // already inside `reservedMicroUsd` above, so it is the one number this
        // admission actually reserved. gate_admissions is append-only
        // (INV-COST-1), so re-reading is the whole remedy.
        const prior = this.db
          .prepare(
            "SELECT repo_slug AS repoSlug, issue_id AS issueId, ceiling_micro_usd AS ceiling FROM gate_admissions WHERE request_id = ? AND run_id = ?",
          )
          .get(input.requestId, input.runId) as
          | { repoSlug: string; issueId: string; ceiling: number }
          | undefined;
        if (prior === undefined) {
          throw new CostLedgerError(
            "ledger-admission-lost",
            `the admission for request ${input.requestId} / run ${input.runId} neither inserted nor resolved — refusing to mint an unreserved ceiling`,
            // A FRESH PAIR, not a fresh request id: (request_id, run_id) is the
            // PRIMARY KEY, so reusing the runId under a new requestId writes a
            // SECOND admission row for one run. The reservation query now counts
            // one per run_id so that no longer double-books the cap, but it
            // still leaves two rows describing one run's exposure — say the
            // thing that produces clean state.
            "inspect gate_admissions for that (request_id, run_id) and re-run the dispatch with a fresh requestId AND runId",
          );
        }
        // The PRIMARY KEY is (request_id, run_id) ALONE, so the row this replay
        // resolved is not necessarily a reservation against THIS budget. Replay
        // the same correlation id under a different repo or issue and the
        // reservation query above — scoped to (repo_slug, issue_id) — never saw
        // the row, the INSERT conflicted on the key, and this branch handed back
        // a ceiling reserved out of a DIFFERENT issue's cap: spend authorized
        // against a budget holding nothing for it. Idempotency is only
        // idempotency for the SAME identity; a collision under another one is a
        // caller bug, and the fail-closed answer is to mint nothing.
        // Canonicalized on the STORED side too, both halves: rows written before
        // identity was canonicalized hold the brief's original casing and issue
        // spelling, and a legitimate retry against one of those is not a
        // mismatch.
        if (canonicalRepoSlug(prior.repoSlug) !== repoSlug || canonicalIssueId(prior.issueId) !== issueId) {
          throw new CostLedgerError(
            "ledger-admission-mismatch",
            `request ${input.requestId} / run ${input.runId} already holds an admission for ${prior.repoSlug}#${prior.issueId}, not ${repoSlug}#${issueId} — refusing to mint against a reservation another issue's cap is holding`,
            // Fresh PAIR: a new requestId over the same runId only adds a second
            // admission row for that run (the PRIMARY KEY is the pair), it does
            // not give the run a reservation under this issue.
            "re-run the dispatch with a fresh requestId AND runId: a (requestId, runId) pair belongs to exactly one (repoSlug, issueId)",
          );
        }
        // CLAMPED to the headroom recomputed just now, not handed back raw.
        // The recorded ceiling fit the headroom its ORIGINAL admission saw, and
        // that headroom can only have shrunk since: spend the run has not yet
        // reported lands as priced rows, and those rows also RETIRE this
        // reservation, so a replay routinely recomputes a `remainingMicroUsd`
        // smaller than the number on the row. Cap 100 / keyCap 10: A admits at
        // 10, B reports 95, and replaying A returned 10 against a remaining of
        // 5 — breaking the `admittedCeilingMicroUsd <= remainingMicroUsd`
        // invariant this method's contract states, and handing that 10 straight
        // to the mint. `min` is the fail-safe direction: a replay can only ever
        // be authorized for LESS than its original, never more, and the row
        // itself is untouched (INV-COST-1) so the reservation still stands at
        // the figure the cap is holding.
        ceiling = Math.min(prior.ceiling, remainingMicroUsd);
      }
      return {
        admitted: true,
        status: "within-budget",
        capMicroUsd: cap,
        spentMicroUsd,
        reservedMicroUsd,
        remainingMicroUsd,
        unpricedRows,
        admittedCeilingMicroUsd: ceiling,
      };
    });
    let decision: AdmissionDecision;
    try {
      decision = decide.immediate();
    } catch (e) {
      throw ledgerBusyError(e) ?? e;
    } finally {
      // finally, not the success path: a transaction that threw after expiring a
      // reservation still owes the operator that line. `emitGuarded` because a
      // committed outcome must survive a raising sink — see its docstring.
      for (const line of pendingLogs) emitGuarded(line);
    }
    const durationMs = Date.now() - started;
    emitGuarded({
      requestId: input.requestId,
      operation: "cost-ledger.gate",
      agentId: null,
      timestamp: new Date().toISOString(),
      duration: durationMs,
      status: "ok",
      runId: input.runId,
      repoSlug,
      // The canonical pair the decision was actually made against — logging the
      // raw spelling would make two log lines for one budget look like two.
      issueId,
      decision: decision.status,
      capMicroUsd: decision.capMicroUsd,
      spentMicroUsd: decision.spentMicroUsd,
      reservedMicroUsd: decision.reservedMicroUsd,
      unpricedRows: decision.unpricedRows,
      ...(decision.admitted ? { remainingMicroUsd: decision.remainingMicroUsd, admittedCeilingMicroUsd: decision.admittedCeilingMicroUsd } : {}),
      durationMs,
      outcome: decision.status,
      sum_query_ms: durationMs,
    });
    return decision;
  }

  /**
   * Can this reservation's run record be proven STRUCTURALLY ABSENT — gone in
   * a way no retry will cure? Only YES may expire an aged admission.
   *
   * The gate's orphan expiry used to treat "readRunRecord threw" as the same
   * fact as "no record", so a transient read fault past the grace window
   * (EIO on a failing mount, EACCES from a sibling's chown) expired a LIVE
   * run's reservation and re-granted its ceiling to the next dispatch while
   * the box kept billing. The stat cross-check separates the two facts:
   *
   *  - the path stats ENOENT ⇒ absent: expire (createRun failed before
   *    INV-1's record landed; nothing will ever report spend);
   *  - the file exists at ZERO bytes ⇒ absent: expire — that is the
   *    interrupted-create tombstone `clearCreateTombstone` documents, which
   *    carries no keyHash and no box;
   *  - anything else — a non-empty file, or a stat that fails with any other
   *    errno — is UNPROVABLE, and unprovable counts as present: keep the
   *    ceiling reserved. Over-reserving wedges one issue until the fault
   *    clears or an operator looks; under-reserving spends money twice. Only
   *    the first is recoverable.
   *
   * A run id outside even the LEGACY read grammar can never have named a
   * record file (`path()` refuses it) nor provisioned a box, so it is absent
   * by construction — that case keeps expiring without touching the
   * filesystem, exactly as before.
   */
  private recordStructurallyAbsent(runId: string): boolean {
    if (!LEGACY_RUN_ID_RE.test(runId)) return true;
    try {
      // Built by hand rather than through RunRecordStore.path(): the store's
      // validator would THROW on the legacy-tolerant ids this check exists to
      // judge, and the ledger holds no store handle — only this directory.
      return statSync(join(this.runsDir, `${runId}.json`)).size === 0;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return true;
      return false; // EACCES/EIO/…: absence unproven ⇒ still-reserved
    }
  }
}

// ─── ctx validation ──────────────────────────────────────────────────────────

const COST_ROLES: ReadonlySet<string> = new Set(["lead", "worker", "resident", "tier1"]);

function assertIngestCtx(ctx: IngestCtx): void {
  const strings = ["runId", "repoSlug", "issueId", "requestId", "role"] as const;
  for (const field of strings) {
    const v = (ctx as unknown as Record<string, unknown>)[field];
    if (typeof v !== "string" || v.length === 0) {
      throw new CostLedgerError(
        "ingest-ctx-invalid",
        `ingest ctx is missing ${field} — an unattributable cost is not persisted under a guessed key (INV-COST-6)`,
        "supply { runId, repoSlug, issueId, requestId, role, invocationSeq } from the dispatch that spawned the agent",
      );
    }
  }
  if (!COST_ROLES.has(ctx.role)) {
    // The schema's CHECK is the backstop; this is the error surface — a raw
    // SQLITE_CONSTRAINT would name no field and suggest no next command.
    throw new CostLedgerError(
      "ingest-ctx-invalid",
      `ingest ctx role must be one of lead|worker|resident|tier1 (got ${JSON.stringify(ctx.role)})`,
      "pass the roster entry's role verbatim — it is never inferred from the model slug or agent name",
    );
  }
  if (
    typeof ctx.invocationSeq !== "number" ||
    !Number.isInteger(ctx.invocationSeq) ||
    ctx.invocationSeq < 0
  ) {
    throw new CostLedgerError(
      "ingest-ctx-invalid",
      "ingest ctx invocationSeq must be a non-negative integer (the dispatcher's per-(run, agent) spawn counter)",
      "pass the invocationSeq fixed at spawn — it is what keeps two invocations of one agent from digesting identically",
    );
  }
  // The row this ctx becomes is keyed on the CANONICAL pair, so that is what
  // has to be non-empty — the raw check above passes `"#"` and `" "`.
  assertCanonicalIdentity(
    "ingest-ctx-invalid",
    ctx.repoSlug,
    ctx.issueId,
    "supply { runId, repoSlug, issueId, requestId, role, invocationSeq } from the dispatch that spawned the agent",
  );
}
