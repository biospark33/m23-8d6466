/**
 * Shared harness for the six P0.9 leg drivers (story M1.1, dev-half).
 *
 * Purpose: one place for the cross-leg invariants so six drivers do not each
 * re-implement (and drift on) them:
 *   - LegDeps: every network-touching collaborator (fetch, client,
 *     provision/retain routines, auth header) is an injectable field, so
 *     tests/p0-9/legs.test.ts never monkeypatches and never hits the network.
 *   - forbiddenOrigin + requireBaseUrl: the wrong-instance traps, fail-closed.
 *   - maskTail: tokens never land in recorded evidence tails (INV-HM1).
 *   - writeLegEvidence / resolveEvidenceDir: openrig-sc2 timestamped
 *     filenames + the mock/live evidence-directory policy (AC2 negative
 *     control: mock evidence can never stand in for live evidence in the
 *     closure dir).
 *   - legLog: the story's observability contract — one JSON line per leg
 *     event on stderr, `{event:"p0-9-leg", ...}`.
 *   - Hoisted driver helpers (m1-1 round-1 review, F-004/F-006/F-018/F-021/
 *     F-022/F-025): extractBankIds, safeRepoBase, rand6,
 *     PROBE_DOWN_URL_DEFAULT, scanLiveShapePrereq, rerunAwareProvision,
 *     assertQdsRepoSlug. Drivers migrate onto these next wave; additive only
 *     (one deliberate exception, M3.1 review round 2: the superseded
 *     MAX_BASE_LEN mirror was DELETED in favor of deriving safeRepoBase from
 *     the provisioner — a hoisted mirror that could silently disagree with
 *     its source was the defect; tsc is the drift alarm for any importer).
 *   - m1-1 round-2 review additions: acquireHeartbeatLock (R2-002 lock
 *     asymmetry), sanitizeOrigin (R2-015 userinfo stripping),
 *     resolveRepoSlug (R2-018 the one slug default), exact-word maskTail
 *     fields (R2-014), URL-port-first forbiddenOrigin (R2-016), the
 *     ok:true prereq requirement (R2-001), case-folded closure-dir refusal
 *     (R2-010), and the collective-id slug refusal (R2-021).
 *   - m1-1 round-3 review additions: [_-]-compounded credential field names
 *     in maskTail (R3-001), escape-aware quoted-value masking (R3-010),
 *     opaque/trailing-dot trap origins refused (R3-011), fresh-lane
 *     createdInAttempt filtered to status:"created" (R3-009), and the
 *     newest-live-stamp-must-pass prereq policy (R3-014).
 *
 * Step-name vocabulary (drivers recording round-trip steps) is the verifier's
 * own: retain | recall | reflect | consolidate | post_consolidate_recall
 * (src/hindsight/round-trip-verifier.ts RoundTripErr.step).
 *
 * Exit-code contract (drivers): 0 = leg pass, 1 = leg failure, 2 = fatal
 * refusal before/at setup (phase0-exit-gate.ts idiom: thin main() → runLeg →
 * write evidence → process.exitCode under an import.meta.main guard).
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { tmpdir } from "node:os";

import { BankIdSchema, resolveBankId } from "../../src/hindsight/index.ts";
import {
  COLLECTIVE_BANK_ID,
  provisionBanks,
  safeRepoBaseCandidates,
  type BridgeProbe,
  type ProvisionClient,
  type ProvisionOptions,
  type ProvisionResult,
} from "../../src/hindsight/bank-provisioner.ts";
import { acquireFileLock, type StaleCheck } from "../../src/lib/file-lock.ts";

/** Re-exported so bank-creating drivers need only leg-lib for the roster contract (story AC3). */
export { COLLECTIVE_BANK_ID };

export type LegMode = "live" | "mock";

/**
 * Inject-everything dependency bundle for a leg driver's exported
 * `runLeg(deps)`. `client` / `provisionImpl` / `retainImpl` are deliberately
 * loose (`unknown`): their concrete types arrive with the drivers (leaf
 * 1.2.5 / 1.2.6); the skeleton and its tests cast through minimal structural
 * types so this file compiles with zero driver files present.
 */
export interface LegDeps {
  baseUrl: string;
  mode: LegMode;
  now?: () => number;
  fetchImpl?: typeof fetch;
  lockPath?: string;
  /** Staleness budget for the leg's diff-window lock (default LEG_LOCK_STALE_MS, F-005). */
  lockStaleMs?: number;
  outDir?: string;
  /** Pre-built HindsightClient-shaped collaborator (listBanks/createBank/deleteBank/retain/recall/request). */
  client?: unknown;
  /** Provision-routine override (defaults to the provisioner's provisionBanks over `client`). */
  provisionImpl?: unknown;
  /** Retain-routine override (defaults to the driver's own raw client.request call site). */
  retainImpl?: unknown;
  /** Full Authorization header VALUE (e.g. "Bearer <tok>") for authenticated probes; env-derived when absent. */
  authHeader?: string;
}

export interface LegStepRecord {
  step: string;
  outcome: string;
  durationMs?: number;
  detail?: unknown;
}

export interface LegEvidence {
  leg: string;
  mode: LegMode;
  ok: boolean;
  outcome: string;
  steps: LegStepRecord[];
  origin: string;
  exitCode: number;
  stdoutTail: string;
  stderrTail: string;
  writtenAt: string;
  [k: string]: unknown;
}

// ---------------------------------------------------------------------------
// Wrong-instance origin traps
// ---------------------------------------------------------------------------

/**
 * Trap-ids, NOT connection config — no driver ever connects to these values;
 * it REFUSES them. The two traps (story M1.1 AC1/AC6 negative controls):
 *   - `:8888`  — the HindsightClient silent fallback default
 *     (`DEFAULT_BASE_URL = http://127.0.0.1:8888`, src/hindsight/client.ts)
 *     which is the SHARED-sidecar/tenant origin (runbook §6.4: "the bank
 *     provisioner's built-in default is the TENANT base URL"; §6.3: that
 *     value "is the SHARED-SIDECAR (tenant stack) origin and resolves the
 *     WRONG instance for factory work"). Story AC1: any path that reaches
 *     the shared zeropoint tenant sidecar MUST fail.
 *   - `:18889` — the platform TENANT stack's host map; the factory dedicated
 *     instance is 18890, never 18889 (runbook §0/§5; story AC6: "an on-box
 *     18889 answer is the TENANT instance and fails AC1's negative control").
 * The dedicated instance's legit origins — host-side `127.0.0.1:18890` and
 * compose-side `hindsight-qds:8888` — are distinguished by who may use them:
 * host-side legs only ever carry the env-read 18890 value, so any origin a
 * factory leg resolves on these two ports is a trap hit.
 */
const FORBIDDEN_ORIGIN_PORT_SUFFIXES = [":8888", ":18889"] as const;

/**
 * F-001: trim + strip trailing slashes so routine env shapes
 * (`" http://127.0.0.1:8888 "`, `http://127.0.0.1:8888/`) cannot slip past a
 * string-tail port check. Shared by forbiddenOrigin and requireBaseUrl.
 */
function normalizeOrigin(origin: string): string {
  let s = origin.trim();
  while (s.endsWith("/")) s = s.slice(0, -1);
  return s;
}

/**
 * Returns a fatal-refusal reason string when `origin` is a wrong-instance trap, else null.
 *
 * F-001 + R2-016: one trap-port table, two layers, URL-port FIRST.
 *   1. `new URL(normalized).port` comparison — the semantic layer. When the
 *      input parses as a WHATWG URL WITH an authority (host !== "") the
 *      decision is made on the PORT ALONE: `http://127.0.0.1:8888/../x` is
 *      caught (the URL normalizes the path, port reads 8888) while a
 *      dedicated origin whose PATH tail merely ends in a trap-looking suffix
 *      (`http://127.0.0.1:18890/prefix:8888`) is NOT refused — running the
 *      suffix layer first is exactly what produced that false refusal.
 *   2. Normalized suffix match — trim + trailing-slash strip, then endsWith.
 *      Applies to input the URL parser REJECTS (raw scheme-less `host:port`
 *      spellings — `127.0.0.1:8888`, a digit-leading "scheme" does not
 *      parse) AND, since R3-011, to input that only parses OPAQUE (empty
 *      host): letter-leading scheme-less spellings such as `localhost:8888`
 *      or `hindsight-qds:8888` read as scheme + opaque path, so the port
 *      verdict has no authority to read and layer 1's "port is empty → pass"
 *      let the likeliest human misspelling of the :8888 trap through both
 *      layers (the R2-016-documented residual, now closed). Unparseable
 *      input is matched with trailing dots stripped first: port `8888.` is
 *      not a number, so `http://127.0.0.1:8888.` also used to slip through.
 * Residual (documented, deliberate): the refusal MESSAGE preserves both the
 * raw and the normalized spelling, so an operator typing a misspelled trap
 * origin sees exactly what they typed; sanitizeOrigin's `***` degradation
 * for unparseable values (R2-015) is unchanged — INV-HM1 outranks
 * diagnostics, and trap-shaped values are now refused before ever being
 * recorded.
 */
export function forbiddenOrigin(origin: string): string | null {
  let hit: string | null = null;
  const normalized = normalizeOrigin(origin);
  let authoritative = false; // the URL layer read an authority and decided
  try {
    const url = new URL(normalized);
    if (url.host !== "") {
      authoritative = true;
      if (FORBIDDEN_ORIGIN_PORT_SUFFIXES.some((suffix) => suffix.slice(1) === url.port)) {
        hit = `:${url.port}`;
      }
    }
    // opaque parse (host "") — no port to compare; the suffix layer decides
  } catch {
    // unparseable — the suffix layer below renders the verdict
  }
  if (!authoritative) {
    let s = normalized;
    while (s.endsWith(".")) s = s.slice(0, -1); // `:8888.` is the trap with a typo
    for (const suffix of FORBIDDEN_ORIGIN_PORT_SUFFIXES) {
      if (s.endsWith(suffix)) {
        hit = suffix;
        break;
      }
    }
  }
  if (hit === null) return null;
  return `forbidden origin "${origin}" (normalized "${normalized}"): port ${hit.slice(1)} is a wrong-instance trap (:8888 = the client's silent shared-sidecar/tenant default, runbook §6.4; :18889 = the tenant stack's host map, runbook §6.3 — the dedicated factory instance is 18890). Set HINDSIGHT_BASE_URL to the dedicated instance's env-carried origin.`;
}

/**
 * R2-015: strip userinfo (`user:pass@`) from an origin BEFORE it is recorded
 * into evidence — `http://user:pass@host:18890` passes every trap/guard yet
 * leaks its credential into the `origin` field of every closure-dir evidence
 * JSON (INV-HM1 covers recorded evidence, not just tails). URL-parse, clear
 * username/password, reconstruct (note: WHATWG reconstruction appends `/`
 * when the input had no path). An origin that does not parse cannot be
 * reasoned about safely, so it degrades to a fully masked string rather than
 * passing through verbatim. Drivers route their `LegEvidence.origin` (and
 * probe origins) through this.
 */
export function sanitizeOrigin(origin: string): string {
  try {
    const url = new URL(origin);
    url.username = "";
    url.password = "";
    return url.toString();
  } catch {
    return "***";
  }
}

// ---------------------------------------------------------------------------
// Leg diff-window lock budget (F-005)
// ---------------------------------------------------------------------------

/**
 * Staleness budget for a leg's diff-window lock. 900s, deliberately NOT the
 * provisioner's LOCK_STALE_MS 300s: that constant was derived for "3 banks ×
 * consolidate timeout" and never accounted for the leg window's full corpus
 * import (edge-case-hunter M1 — a healthy-but-slow mint overrun would let a
 * second driver steal the lock mid-window and interleave diff windows).
 */
export const LEG_LOCK_STALE_MS = 900_000;

export interface HeartbeatLockOptions {
  /**
   * Age budget mapping to acquireFileLock's staleness predicate (the leg
   * window's LEG_LOCK_STALE_MS, or deps.lockStaleMs).
   */
  staleMs: number;
  /**
   * mtime-refresh interval while held. Default 60_000 — must stay well under
   * the SMALLEST steal budget in the lock family: the provisioner's
   * LOCK_STALE_MS is 300s and steals on age alone, so a 60s heartbeat keeps
   * a live leg window fresh from every family member's perspective.
   */
  heartbeatMs?: number;
  /**
   * Override for the derived age-only staleness predicate — the caller's own
   * judgement about the holder (e.g. the drivers' pid-aware
   * `ageMs >= staleMs || pid === undefined || isPidDead(pid)`).
   */
  holder?: (check: StaleCheck) => boolean;
}

/**
 * R2-002: acquireFileLock + a heartbeat that refreshes the lock file's mtime
 * every `heartbeatMs` while held.
 *
 * WHY: the provision family shares ONE lock path with TWO staleness budgets
 * — legs hold their diff window under LEG_LOCK_STALE_MS (900s) while
 * provisionBanks/CLI steal the same file at the provisioner's LOCK_STALE_MS
 * (300s, age only). A healthy-but-slow leg window (>300s: the mint loop is
 * corpus × roster sequential 30s-ceiling requests) therefore looked stale to
 * a concurrent CLI run, which stole the lock mid-mint and let the leg's
 * compensation delete the interleaver's banks. A live heartbeat keeps the
 * file's mtime young, so the 300s age-steal never fires against a held leg
 * window.
 *
 * The lock file's `<pid>:<nonce>` CONTENT is never rewritten — only its mtime
 * — so acquireFileLock's content verification (trySteal's claim check,
 * releaseOwn) still sees exactly this acquisition's lock. The touch itself is
 * content-verified first: a taken-over lock is never refreshed. Release
 * clears the interval BEFORE the inner release (also on taken-over paths,
 * where the inner release throws), so no timer outlives the window; the
 * interval is unref'd when the runtime supports it so a forgotten release
 * cannot pin the event loop either.
 *
 * Drivers migrate onto this next wave; this is the correct, leak-free
 * primitive.
 */
export async function acquireHeartbeatLock(
  lockPath: string,
  opts: HeartbeatLockOptions,
): Promise<(() => void) | null> {
  const release = await acquireFileLock(lockPath, {
    isStale: opts.holder ?? (({ ageMs }: StaleCheck) => ageMs >= opts.staleMs),
    label: "provision-family heartbeat lock",
  });
  if (release === null) return null;
  const content = fs.readFileSync(lockPath, "utf8"); // our pid:nonce — verified before every touch
  const beat = setInterval(() => {
    try {
      if (fs.readFileSync(lockPath, "utf8") === content) {
        const now = new Date();
        fs.utimesSync(lockPath, now, now);
      }
    } catch {
      // lock gone (we released) or taken over — the inner release()/its throw surfaces it
    }
  }, opts.heartbeatMs ?? 60_000);
  (beat as { unref?: () => void }).unref?.();
  return () => {
    clearInterval(beat);
    release();
  };
}

// ---------------------------------------------------------------------------
// Token masking (INV-HM1: tokens/keys are never logged or recorded)
// ---------------------------------------------------------------------------

/**
 * R2-014: the exact credential FIELD words — `keyword` / `monkey` /
 * `keynote` (shape-evidence fields) never match; `key`, `token`, `secret`,
 * `password`, `api_key`, `apikey`, `credential`, `authorization`, `bearer`
 * always do — including as JSON keys (`"apiKey"`, case-insensitive) and
 * hyphenated headers (`X-Api-Key`).
 */
const CREDENTIAL_FIELD_WORDS =
  "api_key|apikey|authorization|bearer|credential|key|password|secret|token";

/**
 * R3-001: a credential field NAME as a [_-]-separated compound — optional
 * alnum segments on either side of a core word (`access_token`, `X_API_KEY`,
 * `AWS_SECRET_ACCESS_KEY`, `secret-key`, `private_key`). `_` is a word
 * character, so R2-014's `\b…\b` anchors could never fire inside an
 * underscore run and every such compound escaped ALL masking rules
 * (hunter-verified live; `access_token` is *the* OAuth field name). The
 * R2-014 guarantee survives: a bare-alpha extension of a core word still
 * never matches, because the character after the core word can neither
 * start the `[_-]suffix` branch nor the `["']?\s*[=:]` the surrounding
 * rules require — `keyword=`, `keywords`, `monkey`, `keynote:` stay raw.
 */
const CREDENTIAL_FIELD_NAME = `(?:[A-Za-z0-9]+[_-])*(?:${CREDENTIAL_FIELD_WORDS})(?:[_-][A-Za-z0-9]+)*`;

/**
 * `name…["']?\s*[=:]\s*` + one opening quote — a quoted value then masks
 * whole, to its closing quote. R3-010: the value class honors `\\.`
 * escapes, so a JSON-escaped quote (`"api_key":"ab\"cd"`) no longer ends
 * the value early and leaks everything past the `\"`.
 */
function quotedValueRule(names: string, quote: string): RegExp {
  return new RegExp(
    `(${names}["']?\\s*[=:]\\s*${quote})(?:\\\\.|[^${quote}\\\\])*(${quote})?`,
    "gi",
  );
}

const MASK_HINDSIGHT_QUOTED = quotedValueRule(
  String.raw`\b(?:HINDSIGHT_BEARER_TOKEN|HINDSIGHT_API_KEY)\b`,
  '"',
);
const MASK_HINDSIGHT_UNQUOTED =
  /(\b(?:HINDSIGHT_BEARER_TOKEN|HINDSIGHT_API_KEY)\b["']?\s*[=:]\s*)\S+/gi;
const MASK_FIELD_QUERY = new RegExp(`([?&](?:${CREDENTIAL_FIELD_NAME})=)[^&\\s"']*`, "gi");
const MASK_FIELD_QUOTED_DQ = quotedValueRule(`\\b(?:${CREDENTIAL_FIELD_NAME})`, '"');
const MASK_FIELD_QUOTED_SQ = quotedValueRule(`\\b(?:${CREDENTIAL_FIELD_NAME})`, "'");
const MASK_FIELD_UNQUOTED =
  new RegExp(`(\\b(?:${CREDENTIAL_FIELD_NAME})["']?\\s*[=:]\\s*)[^\\s,&"']+`, "gi");

/**
 * Mask credential-looking values in a recorded tail: `Bearer <tok>` /
 * `Basic <cred>` / `X-Api-Key <key>` header forms, the two HINDSIGHT env
 * names, credential-shaped assignments in ANY field position (JSON bodies,
 * env dumps — F-019: keys/names survive, values are masked), and credential
 * query params (`?token=…`). `opts.maxLen` additionally truncates the tail to
 * a tail-length cap.
 *
 * R2-014 field-name semantics: EXACT word matches against
 * CREDENTIAL_FIELD_WORDS — over-matching (`keyword=`, `monkey=`) destroyed
 * shape evidence the hindsight-live leg records raw bodies to derive.
 * Because `authorization`/`bearer` are field words, a bare header line
 * (`Authorization: <raw>`) now masks the raw value's first token as well,
 * and a scheme-word header double-masks (`Authorization: Bearer tok` →
 * `Authorization: *** ***`) — fail-closed direction, accepted.
 * R3-001: "exact word" is now "exact [_-]-separated compound" — a field
 * name with a credential SEGMENT (`access_token`, `AWS_SECRET_ACCESS_KEY`)
 * masks, while bare-alpha extensions (`keywords`) still never do.
 *
 * R2-014 value semantics: a QUOTED value masks whole, to its closing quote
 * (`"apiKey":"ab&cd"` → `"apiKey":"***"`); an unclosed quote masks to end of
 * string (R3-010: the value class steps over `\"` escapes, so a quoted
 * value containing an escaped quote still masks whole). Unquoted values
 * mask the non-space/&/quote run — documented
 * ceiling: an exotic UNQUOTED value containing `&` or whitespace is only
 * partially masked (quoted context is the only place such values carry
 * meaning). Query values stop at `&` BY DESIGN — that is the next parameter,
 * not part of the value.
 */
export function maskTail(s: string, opts: { maxLen?: number } = {}): string {
  let out = s
    .replace(/(\bbearer\s+)\S+/gi, "$1***")
    .replace(/(\bbasic\s+)\S+/gi, "$1***")
    .replace(/(\bx-api-key\b["']?\s*[=:]\s*["']?)\S+/gi, "$1***")
    .replace(MASK_HINDSIGHT_QUOTED, "$1***$2")
    .replace(MASK_HINDSIGHT_UNQUOTED, "$1***")
    .replace(MASK_FIELD_QUERY, "$1***")
    .replace(MASK_FIELD_QUOTED_DQ, "$1***$2")
    .replace(MASK_FIELD_QUOTED_SQ, "$1***$2")
    .replace(MASK_FIELD_UNQUOTED, "$1***");
  if (opts.maxLen !== undefined && out.length > opts.maxLen) {
    out = `${out.slice(0, opts.maxLen)}...`;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Evidence writing
// ---------------------------------------------------------------------------

/** Live evidence home (closure-plan house style); repo-root relative to this file (scripts/p0-9/). */
export const LIVE_EVIDENCE_DIR = path.join(
  import.meta.dir,
  "..",
  "..",
  "_bmad-output",
  "evidence",
  "p0-9-closure",
);

/** Mock-rehearsal default: out of the repo, out of the closure dir, obviously not live. */
const MOCK_REHEARSAL_DIR = path.join(tmpdir(), "p0-9-dev-rehearsal");

/** `2026-10-03T21-30-00-123Z` — the openrig-sc2 dash-timestamp filename component. */
function isoDashTimestamp(d = new Date()): string {
  return d.toISOString().replace(/[:.]/g, "-");
}

/** Exactly 6 lowercase alnum chars of randomness for the filename suffix. */
export function rand6(): string {
  let s = "";
  while (s.length < 6) s += Math.random().toString(36).slice(2);
  return s.slice(0, 6);
}

/** realpath when the path exists (symlink/case-spelling tolerance, F-009); lexical resolve otherwise. */
function realPathIfReachable(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}

/**
 * True when `candidate` IS the closure dir or lives UNDER it (F-009:
 * separator-aware prefix — `<closure>/sub` is refused, not just the exact
 * path). Both sides realpath'd when they exist so symlinked candidates
 * cannot escape the policy. R2-010: a path that does NOT exist yet falls
 * back to the lexical spelling, and on case-insensitive platforms
 * (darwin/win32) a later mkdir case-folds onto the real directory — so there
 * the comparison is case-insensitive too (exact on case-sensitive platforms,
 * where a differently-cased path genuinely mkdirs a different directory).
 * Residual ceiling, documented (R2-023, dismissed as contrived): a
 * pre-planted symlink AT a nonexistent path can still steer the lexical
 * fallback — the real defense is that writeLegEvidence mkdirs UNDER the
 * resolved dir rather than over any existing dir entry.
 */
function isInsideClosureDir(candidate: string): boolean {
  const c = realPathIfReachable(candidate);
  const live = realPathIfReachable(LIVE_EVIDENCE_DIR);
  const fold = process.platform === "darwin" || process.platform === "win32";
  const cc = fold ? c.toLowerCase() : c;
  const lc = fold ? live.toLowerCase() : live;
  return cc === lc || cc.startsWith(`${lc}${path.sep}`);
}

/**
 * Pure directory resolution for one leg's evidence (F-017 export):
 *   - explicit `outDir` → resolved verbatim; in mock mode an outDir that IS
 *     the closure dir or a subdirectory of it is REFUSED (throws) — the
 *     closure dir means "live VPS-day evidence" (closure-plan C9) and a
 *     mock-stamped file there is precisely the mock-stands-in-for-live
 *     confusion the policy exists to prevent (AC2 negative control);
 *   - no outDir → live: LIVE_EVIDENCE_DIR, mock: MOCK_REHEARSAL_DIR.
 * writeLegEvidence routes through here; tests can assert routing (and the
 * refusal) without writing anything.
 */
export function resolveEvidenceDir(deps: { mode: LegMode; outDir?: string }): string {
  if (deps.outDir !== undefined) {
    const dir = path.resolve(deps.outDir);
    if (deps.mode === "mock" && isInsideClosureDir(dir)) {
      throw new Error(
        `mock-mode evidence refused in the live closure dir (${dir}): mock evidence must never stand in for live VPS-day evidence (AC2 negative control). Write to an explicit scratch dir or omit outDir to route to ${MOCK_REHEARSAL_DIR}.`,
      );
    }
    return dir;
  }
  return deps.mode === "live" ? LIVE_EVIDENCE_DIR : MOCK_REHEARSAL_DIR;
}

/**
 * Write one leg's evidence JSON; returns the written path.
 *
 * Filename (openrig-sc2 idiom):
 * `<ISO-dash-timestamp>-<leg>-<rand6>.json` — `<leg>` is the closure-plan
 * slug (p0-9-hindsight-live, p0-9-provision-and-import,
 * p0-9-round-trip-via-bridge, p0-9-negative-probes, p0-9-idempotency-rerun,
 * p0-9-auth-retired-check). Directory policy: resolveEvidenceDir decides
 * (see its doc for the mock/live routing and the closure-dir refusal).
 * Content: 2-space-indented JSON + trailing newline.
 */
export function writeLegEvidence(
  deps: { mode: LegMode; outDir?: string },
  leg: string,
  payload: LegEvidence,
): string {
  const dir = resolveEvidenceDir(deps);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${isoDashTimestamp()}-${leg}-${rand6()}.json`);
  fs.writeFileSync(file, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  return file;
}

/**
 * writeLegEvidence with the F-030 guarantee: a run that already MUTATED the
 * instance (provisions, compensations, residue) must never lose its outcomes
 * to a failing evidence write — on throw, the payload is dumped to stderr as
 * ONE JSON line (the caller's main can still exit 2 with the record in hand).
 */
export function writeEvidenceOrStderr(
  leg: string,
  payload: LegEvidence,
  outDir?: string,
): { path: string; fellBack: boolean } {
  try {
    const file = writeLegEvidence(
      outDir === undefined ? { mode: payload.mode } : { mode: payload.mode, outDir },
      leg,
      payload,
    );
    return { path: file, fellBack: false };
  } catch {
    process.stderr.write(`${JSON.stringify(payload)}\n`);
    return { path: "", fellBack: true };
  }
}

// ---------------------------------------------------------------------------
// Observability line
// ---------------------------------------------------------------------------

/**
 * The story's leg observability contract: exactly one JSON line per leg event
 * on stderr — `{event:"p0-9-leg", leg, step?, bankId?, durationMs?, outcome}`.
 * Durations are omitted when unmeasured (absent ≠ 0).
 */
export function legLog(entry: {
  leg: string;
  step?: string;
  bankId?: string;
  durationMs?: number;
  outcome: string;
}): void {
  process.stderr.write(`${JSON.stringify({ event: "p0-9-leg", ...entry })}\n`);
}

// ---------------------------------------------------------------------------
// Fail-closed env guard
// ---------------------------------------------------------------------------

/**
 * Read `HINDSIGHT_BASE_URL` BY NAME and fail closed when unset/empty, and
 * again when the value is a wrong-instance trap.
 *
 * Why fatal: the HindsightClient constructor silently falls back to
 * `DEFAULT_BASE_URL = http://127.0.0.1:8888` (src/hindsight/client.ts) — the
 * shared-sidecar/tenant origin (runbook §6.4 trap; §6.3's stale line "MUST
 * NOT be copied blind"). The env template's own comment: "Always set the
 * variable; nothing may rely on the default." A driver that proceeds on the
 * default provisions banks against the wrong instance; a driver that throws
 * here is exit-2 fatal by the driver contract.
 *
 * Returns the NORMALIZED value (F-001: trimmed, trailing slashes stripped) —
 * the checked value is the used value.
 */
export function requireBaseUrl(env: Record<string, string | undefined>): string {
  const url = env.HINDSIGHT_BASE_URL;
  // whitespace-only is as good as unset — a blank-looking value must not slip
  // past the fail-closed guard and become the client's silent default
  if (url === undefined || url.trim() === "") {
    throw new Error(
      "HINDSIGHT_BASE_URL is unset/empty — refusing to run: the HindsightClient silent " +
        "default (127.0.0.1:8888) is the shared-sidecar/tenant wrong-instance trap (runbook §6.4). " +
        "Always set the variable; nothing may rely on the default.",
    );
  }
  const normalized = normalizeOrigin(url);
  const trap = forbiddenOrigin(normalized);
  if (trap !== null) throw new Error(trap);
  return normalized;
}

// ---------------------------------------------------------------------------
// Hoisted bank-id / roster helpers (F-004, F-018, F-025)
// ---------------------------------------------------------------------------

/**
 * The base bank id the provisioner's resolver would land on (F-018 hoist of
 * the drivers' safeRepoBase): resolveBankId, truncated by the provisioner's
 * own canonical rule — bank-provisioner.ts truncateForSuffix (MAX_BASE_LEN
 * 50 since the M3.1 retune, when qa/maint meta banks widened the family).
 * Derived from the provisioner (safeRepoBaseCandidates[0]) so the mirror
 * cannot drift again.
 */
export function safeRepoBase(repoSlug: string): string {
  return safeRepoBaseCandidates(resolveBankId(repoSlug))[0];
}

/**
 * The attempt's own roster SHAPE, matched against candidate bank ids: base,
 * base-2..-11 (the collision discipline), and their -dev-meta forms — under
 * BOTH base forms the read side recognizes (current 50-char truncation and
 * the legacy 52-era form, safeRepoBaseCandidates), so an attempt that
 * touches either shape is claimed. This is the fallback ATTRIBUTION for a
 * FAILED fresh provision whose failure envelope is the provisioner's
 * ProvisionErr — which carries NO banks (the partial roster is dropped,
 * bank-provisioner.ts:459-468), so the status:"created" claim set is
 * unavailable exactly when compensation is needed. Within the serialized
 * diff window (family lock held), a diff bank matching the attempt's own
 * roster shape is attributable to the attempt with high confidence: family
 * writers are serialized, probe banks are `qds-probe-*`, and the collision
 * discipline exists precisely to name these ids. Collective is NOT
 * claimable by pattern (canonical, pre-existing). Callers intersect with the
 * diff (claim ∩ diff stays the rule) and record whatever falls outside both
 * the claim and the pattern as unclaimedCreated.
 */
export function rosterPatternClaim(repoSlug: string, candidates: string[]): string[] {
  const shapes = new Set<string>();
  for (const base of safeRepoBaseCandidates(resolveBankId(repoSlug))) {
    shapes.add(base);
    shapes.add(`${base}-dev-meta`);
    // M3.1: the family the lanes create is five banks — the pattern must
    // claim qa/maint too, or a failed fresh provision that died after
    // creating them records them as unclaimedCreated (never compensated).
    shapes.add(`${base}-qa-meta`);
    shapes.add(`${base}-maint-meta`);
    for (let n = 2; n <= 11; n++) {
      shapes.add(`${base}-${n}`);
      shapes.add(`${base}-${n}-dev-meta`);
      shapes.add(`${base}-${n}-qa-meta`);
      shapes.add(`${base}-${n}-maint-meta`);
    }
  }
  return candidates.filter((id) => shapes.has(id));
}

/**
 * INV-MEM-1 prefix gate for every bank-creating leg driver (F-004): the CLI's
 * checkBankPrefix refused non-qds- slugs, the drivers fed QDS_REPO_SLUG / cwd
 * basename straight into bank creation. Throws an Error whose message carries
 * code bank_prefix_violation; returns the resolved (suffix-safe) base.
 *
 * R2-021: the fixed collective roster id is refused as a repo base — it
 * exists on every provisioned instance, so a slug resolving to it takes the
 * rerun lane permanently and the roster upsert would mint
 * `qds-collective-dev-meta` junk attributed to a "repo" that is not one.
 */
export function assertQdsRepoSlug(repoSlug: string): string {
  const resolved = resolveBankId(repoSlug);
  if (resolved === COLLECTIVE_BANK_ID) {
    throw new Error(
      `collective_id_slug: repo slug "${repoSlug}" resolves to "${COLLECTIVE_BANK_ID}" — the fixed collective roster id, not a repo base. Using it as a slug takes the rerun lane permanently and mints ${COLLECTIVE_BANK_ID}-dev-meta junk; pass a real repo slug.`,
    );
  }
  if (!resolved.startsWith("qds-")) {
    throw new Error(
      `bank_prefix_violation: resolved bank id "${resolved}" (from repo slug "${repoSlug}") lacks the qds- prefix required by INV-MEM-1 (every bank id explicit and qds--prefixed)`,
    );
  }
  return safeRepoBase(repoSlug);
}

/**
 * R2-018: THE one repo-slug default — `QDS_REPO_SLUG ?? basename(cwd)`.
 * Divergent per-driver defaults (round-trip's literal `"qds-factory"` vs the
 * provision legs' cwd basename) let a renamed checkout's round trip verify a
 * bank this environment never provisioned. Drivers resolve their slug
 * through this; assertQdsRepoSlug still gates the result.
 */
export function resolveRepoSlug(env: Record<string, string | undefined>): string {
  return env.QDS_REPO_SLUG ?? path.basename(process.cwd());
}

/**
 * listBanks-payload extractor at the provisioner's own tolerance (F-006/F-018
 * hoist; mirrors src/hindsight/bank-provisioner.ts extractExistingBankIds):
 * bare arrays, `{banks|items|data:[…]}`, per-entry `bank_id|bankId|id|string`,
 * `name` only when it is itself a schema-valid bank id. Returns an array —
 * drivers diff before/post snapshots with them.
 */
export function extractBankIds(raw: unknown): string[] {
  const out: string[] = [];
  if (raw === null || typeof raw !== "object") return out;
  const root = raw as Record<string, unknown>;
  const arr: unknown = Array.isArray(raw) ? raw : root.banks ?? root.items ?? root.data;
  if (!Array.isArray(arr)) return out;
  for (const entry of arr) {
    if (typeof entry === "string") {
      out.push(entry);
      continue;
    }
    if (entry !== null && typeof entry === "object") {
      const obj = entry as Record<string, unknown>;
      const id = obj.bank_id ?? obj.bankId ?? obj.id;
      if (typeof id === "string") {
        out.push(id);
      } else {
        // `name` ONLY when schema-valid — a human display name would pollute
        // the snapshot diff (same rationale as the provisioner's copy).
        const name = obj.name;
        if (typeof name === "string" && BankIdSchema.safeParse(name).success) {
          out.push(name);
        }
      }
    }
  }
  return out;
}

/**
 * Default down-instance probe TARGET, not connection config (F-021 hoist from
 * negative-probes.ts): TCP port 9 is the loopback discard port — nothing
 * legitimately listens there, so a refused connection IS the unavailability
 * proof. AC1's no-host:port-literal rule names leg-lib as the sanctioned home
 * for probe-target constants; callers override via QDS_PROBE_DOWN_URL.
 */
export const PROBE_DOWN_URL_DEFAULT = "http://127.0.0.1:9";

// ---------------------------------------------------------------------------
// Rerun-aware provisioning (F-025)
// ---------------------------------------------------------------------------

export interface RerunAwareProvisionOpts {
  /** listBanks snapshot taken BEFORE the attempt — the fresh/rerun fork reads it. */
  existingBankIds: string[];
  /** Passed through to provisionBanks verbatim on the fresh path (DD-17: the dedicated topology's always-healthy literal). */
  bridgeProbe?: BridgeProbe;
  /**
   * Caller holds the provisioner's provision.lock across the whole diff
   * window (F-005) → pass noLock:true so the inner single-flight cannot
   * deadlock on the caller's own lock.
   */
  holdProvisionerLock?: boolean;
  requestId?: string;
  /** Driver step recorder; the attempt mode is recorded per step, never silent. */
  rec?: (step: string, outcome: string, detail?: unknown) => void;
  /**
   * R2-011: fresh-path provision routine override — wins over provisionBanks
   * (lets tests and the CLI lanes substitute the whole attempt without
   * re-implementing the fork).
   */
  provisionImpl?: (opts: ProvisionOptions) => Promise<ProvisionResult>;
  /**
   * R2-011: structured step observer for callers that are not drivers (the
   * CLI's stdout envelope) — fires once per provision step with the lane's
   * mode, ok, and the same detail `rec` records.
   */
  onStep?: (step: {
    label: string;
    mode: "resolved-fresh" | "reupsert-existing";
    ok: boolean;
    detail?: unknown;
  }) => void;
}

export interface RerunAwareProvisionResult {
  ok: boolean;
  mode: "resolved-fresh" | "reupsert-existing";
  /**
   * Banks THIS attempt created. Fresh (R3-009): the status:"created" members
   * of provisionBanks' roster — a member that came back `status:"exists"`
   * (e.g. a pre-existing collective) is NOT this attempt's creation and must
   * not be named in the caller's residue. Rerun (R2-011): roster members
   * ABSENT from existingBankIds — a recreated `-dev-meta` is a creation,
   * honestly reported ([] would let a rerun's recreation escape the caller's
   * compensation accounting). Failure paths report [] — the caller's own
   * post∖pre diff is the authority under failure.
   */
  createdInAttempt: string[];
  /** The underlying provisionBanks envelope (fresh) / upsert-roster record (rerun). */
  raw: unknown;
}

/**
 * One provision attempt, rerun-aware (F-025 hoist of the drivers'
 * provisionAttempt; the CLI's bare-rerun junk-bank story is exactly this):
 *
 *   - fresh (resolved base bank ABSENT from existingBankIds): provisionBanks
 *     is the resolution authority — its collision loop (-2..-11) exists for
 *     genuinely foreign collisions;
 *   - rerun (base bank PRESENT — this leg's own earlier run created it): the
 *     resolver would treat our OWN bank as a foreign collision and suffix -2,
 *     minting junk on every rerun; instead PUT-upsert the canonical five-bank
 *     roster (base + dev/qa/maint meta + COLLECTIVE_BANK_ID, M3.1 — the
 *     stored pre-M3.1 three-name snapshot is stale, the run converges the
 *     family) via client.createBank. The mode is recorded per step, never
 *     silent.
 */
export async function rerunAwareProvision(
  client: ProvisionClient,
  repoSlug: string,
  opts: RerunAwareProvisionOpts,
): Promise<RerunAwareProvisionResult> {
  const rec = opts.rec ?? (() => {});
  const notify = (
    mode: "resolved-fresh" | "reupsert-existing",
    ok: boolean,
    detail?: unknown,
  ): void => {
    if (opts.onStep !== undefined) {
      opts.onStep(
        detail === undefined ? { label: "provision", mode, ok } : { label: "provision", mode, ok, detail },
      );
    }
  };
  const provisionOpts: ProvisionOptions = {
    client,
    repoSlug,
    ...(opts.bridgeProbe !== undefined ? { bridgeProbe: opts.bridgeProbe } : {}),
    ...(opts.holdProvisionerLock ? { noLock: true } : {}),
    ...(opts.requestId !== undefined ? { requestId: opts.requestId } : {}),
  };

  // M3.1: the rerun gate recognizes BOTH base forms the read-side resolver
  // recognizes — the current 50-char truncation and the legacy 52-era form —
  // so a long-slug second run upserts the existing family instead of minting
  // a junk -2 family. The roster below is built from the DETECTED family
  // base: upserting the 50-form over a legacy 52-form family would fork, not
  // converge. Adoption stays BASE-MATCH ONLY (pre-M3.1 semantics, R2-011): a
  // base whose dev-meta was lost must be CONVERGED by the rerun upsert, not
  // forked via the fresh lane — that convergence is this lane's purpose. The
  // strict dev-meta ownership signature lives read-side
  // (resolveProvisionedRepoBankId); the provision-side leniency predates
  // this story and is unchanged by it.
  const familyBase = safeRepoBaseCandidates(resolveBankId(repoSlug)).find((c) =>
    opts.existingBankIds.includes(c),
  );
  if (familyBase === undefined) {
    const provision = opts.provisionImpl ?? provisionBanks;
    try {
      const result = await provision(provisionOpts);
      if (result.ok) {
        rec("provision", "ok", { banks: result.banks, repoSlug, mode: "resolved-fresh" });
        notify("resolved-fresh", true, { banks: result.banks, repoSlug, mode: "resolved-fresh" });
        return {
          ok: true,
          mode: "resolved-fresh",
          // R3-009: "exists" members are not this attempt's creations — the
          // figure feeds R2-019 residue naming and must not overclaim
          createdInAttempt: result.banks
            .filter((b) => b.status === "created")
            .map((b) => b.bankId),
          raw: result,
        };
      }
      rec("provision", "failed", { error: result.error, repoSlug, mode: "resolved-fresh" });
      notify("resolved-fresh", false, { error: result.error, repoSlug, mode: "resolved-fresh" });
      return { ok: false, mode: "resolved-fresh", createdInAttempt: [], raw: result };
    } catch (e) {
      rec("provision", "failed-thrown", {
        error: (e as Error).message,
        repoSlug,
        mode: "resolved-fresh",
      });
      notify("resolved-fresh", false, {
        error: (e as Error).message,
        repoSlug,
        mode: "resolved-fresh",
      });
      return {
        ok: false,
        mode: "resolved-fresh",
        createdInAttempt: [],
        raw: { thrown: (e as Error).message },
      };
    }
  }

  // Canonical five-bank roster (M3.1 — matches bank-provisioner.ts `targets`
  // and provision-hindsight-banks.ts canonicalRoster): a stored pre-M3.1
  // three-name roster snapshot is a STALE snapshot, never a limit — the run
  // converges the family by upserting all five, so reruns create the
  // qa/maint meta banks the nightly MM leg requires.
  const roster = [
    familyBase,
    `${familyBase}-dev-meta`,
    `${familyBase}-qa-meta`,
    `${familyBase}-maint-meta`,
    COLLECTIVE_BANK_ID,
  ];
  // R2-011: roster members ABSENT from the pre-snapshot are this attempt's
  // creations (the recreated -dev-meta case), not no-op PUTs.
  const created = roster.filter((id) => !opts.existingBankIds.includes(id));
  for (const bankId of roster) {
    try {
      await client.createBank(bankId);
      rec("provision", "ok", { bankId, mode: "reupsert-existing" });
      notify("reupsert-existing", true, { bankId, mode: "reupsert-existing" });
    } catch (e) {
      rec("provision", "failed-thrown", {
        bankId,
        mode: "reupsert-existing",
        error: (e as Error).message,
      });
      notify("reupsert-existing", false, {
        bankId,
        mode: "reupsert-existing",
        error: (e as Error).message,
      });
      return {
        ok: false,
        mode: "reupsert-existing",
        createdInAttempt: [],
        raw: { roster, error: (e as Error).message },
      };
    }
  }
  rec("provision", "ok", { roster, repoSlug, mode: "reupsert-existing" });
  notify("reupsert-existing", true, { roster, repoSlug, mode: "reupsert-existing" });
  return { ok: true, mode: "reupsert-existing", createdInAttempt: created, raw: { roster } };
}

// ---------------------------------------------------------------------------
// Live prereq gate (F-022)
// ---------------------------------------------------------------------------

/**
 * AC1 shape-check-before-consumption ordering gate, hoisted from
 * round-trip-dedicated.ts's private copy (semantics mirrored exactly so its
 * migration is mechanical): a live leg may only consume the instance after a
 * hindsight-live shape-check evidence file stamped mode:"live" exists. Mock
 * mode is exempt ({ok:true}).
 *
 * R2-001: the stamp must ALSO carry ok:true — a FAILED live shape-check run
 * (fatal env refusal, failed health/digest) still writes mode:"live"
 * evidence, and accepting it let the ordering gate pass on a check that ran
 * but never passed. The gate now proves the shape check PASSED, not merely
 * happened.
 *
 * R3-014: the NEWEST live-mode stamp decides. Scanning newest-first, the
 * first `mode:"live"` entry settles it — a pass satisfies, a failure
 * refuses; an older pass can no longer satisfy the gate once a strictly
 * newer failed run exists (Monday's pass must not gate Thursday's leg over
 * Wednesday's failed re-pin). Residual (documented): there is still no
 * binding between the stamp and the currently running container digest —
 * recency-by-filename is the ceiling without one.
 */
export function scanLiveShapePrereq(deps: {
  mode: LegMode;
  outDir?: string;
}): { ok: true; file?: string } | { ok: false; reason: string } {
  if (deps.mode !== "live") return { ok: true };
  const dir =
    deps.outDir !== undefined ? realPathIfReachable(deps.outDir) : LIVE_EVIDENCE_DIR;
  let names: string[] = [];
  try {
    names = fs.readdirSync(dir);
  } catch {
    // unreadable/missing dir ≡ no prereq — the refusal below names the rule
  }
  const hits = names
    .filter((n) => n.includes("-p0-9-hindsight-live") && n.endsWith(".json"))
    .sort();
  const noEvidence = `no hindsight-live shape evidence found in ${dir} — the AC1 shape check must run BEFORE the round-trip leg (story DoD ordering; run scripts/p0-9/hindsight-live.ts first)`;
  if (hits.length === 0) return { ok: false, reason: noEvidence };
  for (const name of hits.reverse()) {
    try {
      const parsed = JSON.parse(
        fs.readFileSync(path.join(dir, name), "utf8"),
      ) as { mode?: unknown; ok?: unknown };
      if (parsed.mode !== "live") continue; // mock/other stamps never settle it
      if (parsed.ok === true) return { ok: true, file: name };
      return {
        ok: false,
        reason: `newest hindsight-live shape-check evidence (${name}) is mode:"live" and FAILED — an older PASS cannot satisfy the AC1 ordering gate after a newer failure (a re-pin invalidates prior passes). Re-run scripts/p0-9/hindsight-live.ts until it passes, then re-run this leg.`,
      };
    } catch {
      // unreadable candidate — keep scanning; only a parseable live stamp counts
    }
  }
  return {
    ok: false,
    reason: `hindsight-live evidence present in ${dir} but none stamped mode:"live" AND ok:true — a FAILED live shape-check run (or a mock-stamped prereq) cannot gate a live leg: the AC1 ordering gate proves the shape check PASSED, not merely ran (AC2 negative control: mock must never stand in for live)`,
  };
}
