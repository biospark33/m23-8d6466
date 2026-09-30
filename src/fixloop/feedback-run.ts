/**
 * DF6.1a — the fix-loop core: PR review feedback in, a bounded fix attempt out.
 *
 * This module owns everything host-side and fix-specific that is NOT the CLI
 * (`scripts/fix-run.ts`): the bot-comment read and its normalization/bounding/
 * redaction, the brief build, the single-fixer admission guard, the
 * issue-ceiling pre-flight, the host-owned scope artifact read and the
 * harvested-diff classification, the fixContext record codec with its INV-7
 * validate-only preflight, and the INV-3 credential probe.
 *
 * What is deliberately NOT here: the push. `pushVerifiedSha` is called by the
 * CLI layer (invocation 2) after the approval binding and the scope check; this
 * module never imports `src/pr/push.ts`. The import fence (story Security
 * Invariants / PLAN C18) permits exactly `RunRecordStore`/`RunRecord` from
 * `src/providers/run-record.ts` and bans `approval-gate.ts`/`approvers.ts`
 * outright; the fence gate's symbol-level grep enforces both.
 *
 * The redactor is the PATTERN redactor `redactSecrets` from
 * `src/providers/step-log.ts` — the only redactor permitted on untrusted
 * third-party prose. `cli-anything/src/redact.ts`'s same-named function is a
 * known-value redactor: on a credential literal quoted by a reviewer it is a
 * guaranteed no-op, and using it here is a critical finding, not a style one.
 */
import { createHash } from "node:crypto";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { z } from "zod";

import { BriefSchema, type Brief } from "../fleet/brief-schema.ts";
import { FleetError } from "../fleet/dispatch.ts";
import type { ResolvedRole } from "../phase-engine/roster/schema.ts";
import { readGuardedFile } from "../providers/allowlist-path.ts";
import type { ExecResult } from "../providers/driver.ts";
import { RunRecordStore } from "../providers/run-record.ts";
import type { RunRecord } from "../providers/run-record.ts";
import { redactSecrets } from "../providers/step-log.ts";
import { resolveRepoEntry } from "../pr/repos.ts";
import type { GitHubApi } from "../pr/github.ts";

// ─── bounds (locked: PLAN I2/I5/I6, story Technical Notes) ───────────────────

/** At most 20 comments enter the brief (P1.18's own bound, mirrored). */
export const MAX_FIX_COMMENTS = 20;
/** Each `bodySnippet` is capped at 4 000 chars — P1.18's injection cap. */
export const MAX_FIX_SNIPPET_CHARS = 4000;
/** The snippets' UTF-8-encoded bytes sum to at most 40 000. */
export const MAX_FIX_SNIPPET_BYTES_TOTAL = 40_000;
/** `omittedCommentIds` is capped at 20 entries; the rest is `omittedCount`. */
export const MAX_OMITTED_COMMENT_IDS = 20;

export const FIX_RUN_MANIFEST_PATH = "config/rosters/fix-run.pipeline.json";
export const FIX_SCOPE_FILE = ".factory/fix-scope.json";

/**
 * The dispatch wall-clock ceiling invocation1 hands to `dispatch()` via
 * `DispatchDeps.timeoutMs`. The default (600_000) can NEVER run the fix
 * pipeline: the shipped manifest's `runBudgetMs` is the loader's pricing of
 * the 600 s fix phase (×3 for parse-fix attempts + routing margins =
 * 1 855 000, +2.4% headroom = 1 900 000), and `runBudgetMs > callerBudgetMs`
 * refuses at the manifest load — measured live on the first paid round
 * attempt (2026-09-20: `manifest runBudgetMs 1900000 exceeds callerBudgetMs
 * 599999`). Sized above the manifest with the e2e plan's engine window: the
 * in-box phases stay bounded by the manifest itself; this is only the
 * host-side wall clock the whole dispatch must fit inside. PAIRED with the
 * manifest by test (tests/fixloop/cli.test.ts) so a runBudgetMs raise that
 * outgrows this ceiling fails a unit test, not a paid round.
 */
export const FIX_DISPATCH_CEILING_MS = 2_100_000;

// ─── typed refusals ──────────────────────────────────────────────────────────

/**
 * Every refusal this module raises is a `FleetError` at exit 5 — the refusal
 * exit the CLI maps (`not-a-factory-pr`, `fix-scope-missing`, … are all 5).
 * Raised BEFORE the spend it guards: nothing provisioned, no ledger row, no
 * box.
 */
function refuse(code: string, message: string, remediation: string, payload?: Record<string, unknown>): never {
  // Message and remediation are redacted through the same pattern redactor as
  // every other fleet refusal — payload values are host-computed, never prose.
  throw new FleetError(5, code, redactSecrets(message), redactSecrets(remediation), payload);
}

// ─── fetchBotComments ────────────────────────────────────────────────────────

export interface BotComment {
  commentId: string;
  author: string;
  bodySnippet: string;
}

export interface BotCommentSet {
  /** The bounded, normalized, redacted set that enters the brief. */
  botComments: BotComment[];
  /** IDs of the comments RETAINED (in PR comment order) — the dedupe key. */
  commentIds: string[];
  /**
   * IDs of comments left out (overflow past either ceiling, or invalid), in PR
   * order, capped at MAX_OMITTED_COMMENT_IDS.
   */
  omittedCommentIds: string[];
  /**
   * The number of omitted comments NOT listed in `omittedCommentIds` (the
   * remainder past its cap). Total omitted = omittedCommentIds.length +
   * omittedCount, so the record stays bounded no matter how long the PR's
   * comment list grows.
   */
  omittedCount: number;
  /** See commentsDigest(). */
  commentsDigest: string;
}

/** P1.18's bot filter, locked: the API type, or the `[bot]` login suffix. */
function isBotAuthor(c: { authorLogin: string; authorType: string }): boolean {
  return c.authorType === "Bot" || c.authorLogin.endsWith("[bot]");
}

/**
 * The ONE normalization the digest sees (CRLF→LF only). Everything else —
 * control-character rejection, truncation, redaction — is a property of the
 * BRIEF snippet, not of the content identity the digest proves.
 */
export function normalizeBody(body: string): string {
  return body.replace(/\r\n/g, "\n");
}

/**
 * Strict-UTF-8 at this seam means well-formed: the body arrived as a JSON
 * string, already decoded, so the only ill-formedness left is a lone
 * surrogate (no UTF-8 encoding exists for one). Scan-based rather than
 * `isWellFormed()` for the project's lib target — the semantics are copied
 * verbatim from `src/fleet/brief-schema.ts`'s guard.
 */
function isWellFormed(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      if (!(charCodeAtIsLowSurrogate(s, i + 1))) return false;
      i++;
    } else if (c >= 0xdc00 && c <= 0xdfff) {
      return false;
    }
  }
  return true;
}

function charCodeAtIsLowSurrogate(s: string, i: number): boolean {
  const c = s.charCodeAt(i);
  return c >= 0xdc00 && c <= 0xdfff;
}

/** C0 controls other than LF and TAB. A real review comment is Markdown and multiline; it never needs BEL or CR. */
// biome-ignore lint/suspicious/noControlCharactersInRegex: refusing them is the point
const FORBIDDEN_C0_RE = /[\x00-\x08\x0B\x0C\x0D\x0E-\x1F]/;

/** A comment that cannot safely enter the brief is OMITTED, not fatal — one malformed comment must not sink twenty good ones. */
function isBriefable(normalized: string): boolean {
  return isWellFormed(normalized) && !FORBIDDEN_C0_RE.test(normalized);
}

/**
 * `slice` can end a 4 000-char cut in the middle of a surrogate pair, leaving
 * a lone high surrogate that the brief schema's own well-formedness guard
 * would refuse. Drop the dangling half.
 */
function capSnippet(normalized: string): string {
  if (normalized.length <= MAX_FIX_SNIPPET_CHARS) return normalized;
  const cut = normalized.slice(0, MAX_FIX_SNIPPET_CHARS);
  const last = cut.charCodeAt(cut.length - 1);
  return last >= 0xd800 && last <= 0xdbff ? cut.slice(0, -1) : cut;
}

const snippetBytes = (() => {
  const encoder = new TextEncoder();
  return (s: string): number => encoder.encode(s).length;
})();

function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/**
 * Lowercase-hex SHA-256 over the canonical JSON of the ordered
 * `[{ commentId, bodyHash }]` array, `bodyHash` over the normalized (CRLF→LF
 * only), PRE-redaction body exactly as GitHub returned it.
 *
 * Pre-redaction is load-bearing: redaction output depends on the LIVING
 * `SECRET_PREFIXES`/`LONG_TOKEN_RE` lists, so a post-redaction digest silently
 * invalidates every historical digest the day either list gains an entry. The
 * digest is a statement about what the reviewer wrote; redaction is a
 * statement about what the box may see.
 *
 * Canonical JSON = `JSON.stringify` of the array built from `{ commentId,
 * bodyHash }` literals in that key order — no whitespace, no other keys.
 */
export function commentsDigest(entries: { commentId: string; normalizedBody: string }[]): string {
  const pairs = entries.map((e) => ({ commentId: e.commentId, bodyHash: sha256Hex(e.normalizedBody) }));
  return sha256Hex(JSON.stringify(pairs));
}

/**
 * Read the PR's review comments, keep the bot-authored ones, and bound the
 * set for the brief. Structural `Pick` on the seam — this module compiles
 * against the locked signature, never the concrete interface.
 *
 * Order is the PR's comment order, preserved end to end. Bounding takes a
 * PREFIX: the first comment that would cross either ceiling (20 comments, or
 * the 40 000-byte UTF-8 sum over the final snippets) closes the brief, and
 * every later comment is omitted. A prefix, not a skip-and-continue, so the
 * brief never reorders the reviewer's feedback.
 */
export async function fetchBotComments(
  api: Pick<GitHubApi, "listPrReviewComments">,
  o: { owner: string; repo: string; prNumber: number; token: string },
): Promise<BotCommentSet> {
  const all = await api.listPrReviewComments(o);
  const kept: BotComment[] = [];
  const digestEntries: { commentId: string; normalizedBody: string }[] = [];
  const omittedIds: string[] = [];
  let omittedBeyondCap = 0;
  let byteSum = 0;
  let closed = false;

  const omit = (commentId: string): void => {
    if (omittedIds.length < MAX_OMITTED_COMMENT_IDS) omittedIds.push(commentId);
    else omittedBeyondCap++;
  };

  for (const c of all) {
    if (!isBotAuthor(c)) continue;
    const commentId = String(c.id);
    const normalized = normalizeBody(c.body);
    if (closed || !isBriefable(normalized)) {
      omit(commentId);
      continue;
    }
    // Redact the SNIPPET, never the digest input: the digest below is taken
    // over `normalized` as returned, before redaction and before truncation.
    let snippet = redactSecrets(capSnippet(normalized));
    // Redaction can EXPAND (`sk-` → `«redacted»`), so the char cap is
    // re-asserted on the final text the brief schema will measure.
    if (snippet.length > MAX_FIX_SNIPPET_CHARS) snippet = capSnippet(snippet);
    const bytes = snippetBytes(snippet);
    if (kept.length >= MAX_FIX_COMMENTS || byteSum + bytes > MAX_FIX_SNIPPET_BYTES_TOTAL) {
      closed = true;
      omit(commentId);
      continue;
    }
    kept.push({ commentId, author: c.authorLogin, bodySnippet: snippet });
    digestEntries.push({ commentId, normalizedBody: normalized });
    byteSum += bytes;
  }

  return {
    botComments: kept,
    commentIds: kept.map((c) => c.commentId),
    omittedCommentIds: omittedIds,
    omittedCount: omittedBeyondCap,
    commentsDigest: commentsDigest(digestEntries),
  };
}

// ─── buildFixBrief ───────────────────────────────────────────────────────────

/**
 * The fix brief is an ORDINARY DF3.1 brief — no fix-specific dispatch path.
 * `repoSlug`/`issueId` are pinned from the PARENT record's `extensions.budget`
 * (the admission identity the parent ran under), `commitSha` is the PR head
 * the attempt starts from, and `repoUrl` resolves from the host-side
 * allowlist — never from the brief, the harvested tree, or the box.
 */
export function buildFixBrief(o: {
  hostRoot: string;
  parent: RunRecord;
  pr: { number: number; headRefName: string; headSha: string };
  botComments: BotComment[];
  requestId?: string;
  /** DF6.1b: attempt ≥ 2 carries the prior attempt's CI failure (already redacted) and runId. */
  priorAttempt?: { runId: string; classification: string; ciFailure: string };
}): Brief {
  const budget = o.parent.extensions?.budget;
  const repoSlug = typeof budget?.repoSlug === "string" ? budget.repoSlug : undefined;
  const issueIdRaw = budget?.issueId;
  const issueId = typeof issueIdRaw === "string" && /^\d+$/.test(issueIdRaw) ? Number(issueIdRaw) : undefined;
  if (repoSlug === undefined || issueId === undefined) {
    refuse(
      "fix-parent-budget-missing",
      `parent run ${o.parent.runId} carries no extensions.budget repoSlug/issueId to pin the fix brief to`,
      "the fix loop runs only on factory PRs whose parent run was admitted with an issue ref — check the parent record",
    );
  }
  // Propagates PrRefusalError (allowlist unreadable / slug unregistered):
  // the repository authority is the host's, and its refusal is already typed.
  const repoUrl = resolveRepoEntry(o.hostRoot, repoSlug).remote;
  return BriefSchema.parse({
    repoSlug,
    issueId,
    commitSha: o.pr.headSha,
    manifestPath: FIX_RUN_MANIFEST_PATH,
    repoUrl,
    ...(o.requestId === undefined ? {} : { requestId: o.requestId }),
    fixContext: {
      schemaVersion: 1,
      botComments: o.botComments,
      ...(o.priorAttempt === undefined ? {} : { priorAttempt: o.priorAttempt }),
    },
  });
}

// ─── the single-fixer guard ──────────────────────────────────────────────────

/**
 * Write-capable ⟺ `writes !== null ? writes.length > 0 : true`. DF1.5's field
 * has THREE states: `[]` is no repo writes, a non-empty array is scoped
 * writes, and `null` is UNRESTRICTED writes — the widest scope in the schema,
 * not an absent value. `writes.length > 0` throws on the null roster;
 * `(writes?.length ?? 0) > 0` scores two unrestricted workers as zero. Both
 * spellings are the documented mutants; neither is this one.
 */
export function countWriteCapable(roles: ResolvedRole[]): number {
  return roles.filter((r) => r.writes === null || r.writes.length > 0).length;
}

/**
 * AC5's admission guard, evaluated host-side BEFORE the brief reaches the
 * dispatcher — the refusal costs no box. More than one write-capable role is
 * refused (F6 proved single-fixer editing, not concurrent editing); the count
 * is read from the DECLARED `writes` scope, never the role's name.
 */
export function assertSingleFixer(roles: ResolvedRole[]): void {
  const capable = countWriteCapable(roles);
  if (capable > 1) {
    refuse(
      "fix-roster-not-single-fixer",
      `fix rosters stay single-fixer: ${capable} roles are write-capable (writes null or non-empty), at most one is admitted`,
      "declare exactly one write-capable role beside a verifying lead — read-only roles carry writes: []",
      { writeCapable: capable },
    );
  }
}

// ─── the issue-ceiling pre-flight ────────────────────────────────────────────

/** The snapshot read this check needs — structural, so tests drive a fake ledger. */
export interface IssueBudgetSnapshotSource {
  issueBudgetSnapshot(repoSlug: string, issueId: string): {
    ceilingMicroUsd: number;
    spentMicroUsd: number;
    reservedMicroUsd: number;
  };
}

/**
 * Host-side pre-dispatch check (story W19): the loop's per-issue ceiling must
 * cover the worst-case union of every resource-bearing box the ceilings
 * sanction — `parentSpend + 2 × cap + (3 + 3) × cap` with ONE uniform rate
 * (`perAttemptCap = perDispatchSpendCap = capMicroUsd`, W19-3;
 * unchargedCeiling = 3 per DF6.1b AC2; the `+3` counts dispatch-refused,
 * out-of-scope-diff and scope-requires-privilege, which reserve without
 * charging).
 *
 * Read-only by construction: the ledger is touched through
 * `issueBudgetSnapshot` alone, nothing is provisioned and no ledger row is
 * written on either arm. The refusal names the exact `perIssueOverrides` line
 * the operator must declare.
 */
export function assertFixCeilingCovered(o: {
  ledger: IssueBudgetSnapshotSource;
  repoSlug: string;
  issueId: number | string;
  /** The parent record's spendMicroUsd; 0 when absent. */
  parentSpendMicroUsd?: number;
  capMicroUsd: number;
}): void {
  const parentSpend = o.parentSpendMicroUsd ?? 0;
  const need = parentSpend + 8 * o.capMicroUsd;
  const issueId = String(o.issueId);
  const snapshot = o.ledger.issueBudgetSnapshot(o.repoSlug, issueId);
  if (snapshot.ceilingMicroUsd >= need) return;
  const issueKey = `${o.repoSlug}#${issueId}`;
  refuse(
    "fix-ceiling-insufficient",
    `${issueKey} needs ${need} µ$ of per-issue ceiling for the fix loop's worst-case union (parent spend ${parentSpend} + 8 × ${o.capMicroUsd} µ$); the ledger has ${snapshot.ceilingMicroUsd}`,
    `declare the loop's aggregate in .sandbox/cost-config.json: {"perIssueOverrides": {"${issueKey}": ${need}}}`,
    { issueKey, needMicroUsd: need, ...snapshot },
  );
}

// ─── the host-owned scope artifact ───────────────────────────────────────────

export type FixScopeAction = "modify" | "add" | "delete";

export interface FixScopeDeny {
  glob: string;
  reason: string;
}

export interface FixScopeEntry {
  allowedPathGlobs: string[];
  deniedPathGlobs: FixScopeDeny[];
  permittedActions: FixScopeAction[];
}

const FixScopeEntrySchema = z
  .strictObject({
    allowedPathGlobs: z.array(z.string().min(1)),
    deniedPathGlobs: z.array(z.strictObject({ glob: z.string().min(1), reason: z.string().min(1) })),
    permittedActions: z.array(z.enum(["modify", "add", "delete"])),
  })
  .strict();

const FixScopeFileSchema = z
  .strictObject({ schemaVersion: z.literal(1), scopes: z.record(z.string(), FixScopeEntrySchema) })
  .strict();

/** How the shared guard speaks about THIS file — thresholds are the guard's own. */
const FIX_SCOPE_SPEC = {
  codePrefix: "fix-scope",
  label: "fix scope allowlist",
  defaultFile: FIX_SCOPE_FILE,
  contentHint: "mapping each repoSlug to its {allowedPathGlobs, deniedPathGlobs, permittedActions}",
  consequence: "every fix attempt is refused before any box is provisioned",
} as const;

/**
 * Read `.factory/fix-scope.json` under `hostRoot` through the shared guard —
 * the same no-create, identity-checked read the repo allowlist and the
 * approver file go through, never a bespoke open — and resolve this repoSlug's
 * entry (exact key, then its lowercase variant, matching `.factory/repos.json`'s
 * casing discipline). No entry, an unreadable file, or an invalid document are
 * all the same refusal, raised BEFORE any box: `fix-scope-missing`. This is
 * AC6's attempt-start probe; the enforcement read is `classifyDiffScope`.
 */
export function readFixScope(hostRoot: string, repoSlug: string): FixScopeEntry {
  const read = readGuardedFile(hostRoot, FIX_SCOPE_FILE, FIX_SCOPE_SPEC);
  if (!read.ok) {
    refuse(
      "fix-scope-missing",
      `${read.refusal.message} — ${read.refusal.remediation}`,
      `create ${read.path} with mode 0600 ${FIX_SCOPE_SPEC.contentHint} — with no readable scope artifact, ${FIX_SCOPE_SPEC.consequence}`,
      { guardCode: read.refusal.code },
    );
  }
  let parsed: z.output<typeof FixScopeFileSchema>;
  try {
    parsed = FixScopeFileSchema.parse(JSON.parse(read.text));
  } catch (e) {
    refuse(
      "fix-scope-missing",
      `fix scope allowlist ${read.path} is not a valid scope document: ${(e as Error).message}`,
      `fix ${read.path} to the {schemaVersion: 1, scopes} shape — an unreadable scope artifact refuses every fix attempt`,
    );
  }
  const lower = repoSlug.toLowerCase();
  const entry = Object.hasOwn(parsed.scopes, repoSlug)
    ? parsed.scopes[repoSlug]
    : Object.hasOwn(parsed.scopes, lower)
      ? parsed.scopes[lower]
      : undefined;
  if (!entry) {
    refuse(
      "fix-scope-missing",
      `no fix scope entry for ${repoSlug} in ${read.path}`,
      `register ${repoSlug} under "scopes" in ${read.path} — a repoSlug with no entry is a refusal, never a permissive default`,
    );
  }
  return entry;
}

// ─── the glob matcher (hand-rolled; NO new dependency) ───────────────────────

const REGEX_SPECIAL_RE = /[.+^${}()|[\]\\]/g;

/**
 * Compile a glob to an anchored RegExp. Semantics (locked, I6):
 * `*` = `[^/]*` (never crosses `/`), `**` crosses `/`, `?` = exactly one
 * non-`/` char. A `**` immediately followed by `/` additionally matches ZERO
 * segments, so the double-star form of `*.yml` matches both `ci.yml` and
 * `.github/workflows/ci.yml`, and `src/**` matches everything under `src/` at
 * any depth.
 */
export function globToRegExp(glob: string): RegExp {
  let out = "";
  let i = 0;
  while (i < glob.length) {
    const c = glob[i]!;
    if (c === "*") {
      if (glob[i + 1] === "*") {
        // `**/` = zero or more whole segments; a trailing/non-slashed `**` is `.*`.
        if (glob[i + 2] === "/") {
          out += "(?:[^/]+/)*";
          i += 3;
        } else {
          out += ".*";
          i += 2;
        }
      } else {
        out += "[^/]*";
        i += 1;
      }
    } else if (c === "?") {
      out += "[^/]";
      i += 1;
    } else {
      out += c.replace(REGEX_SPECIAL_RE, "\\$&");
      i += 1;
    }
  }
  return new RegExp(`^${out}$`);
}

export function matchGlob(glob: string, path: string): boolean {
  return globToRegExp(glob).test(path);
}

// ─── classifyDiffScope ───────────────────────────────────────────────────────

export type ScopeClassification =
  | { ok: true }
  | { ok: false; code: "out-of-scope-diff"; paths: string[] }
  | { ok: false; code: "scope-requires-privilege"; matched: { path: string; glob: string; reason: string }[] };

/**
 * The host-side scope verdict on `git diff --name-status <pinned commitSha>..
 * <green headSha>` — exactly this attempt's own changes, computed by the
 * caller against the PINNED base (a default-branch diff would see the parent
 * run's paths and refuse a healthy attempt).
 *
 * DENY WINS: a path matching any deny glob is `scope-requires-privilege` —
 * the fix necessarily requires a privileged path, retry can never succeed, and
 * the refusal names the matched glob and its `reason`. Only when no deny
 * matched does the allow-list speak: a path matching no allow glob, or whose
 * action is not permitted (a fix may not delete under the shipped scope), is
 * `out-of-scope-diff` — agent error, retry may help. The two refusals are
 * different events with different remediations and are never conflated.
 */
export function classifyDiffScope(
  entries: { path: string; action: FixScopeAction }[],
  scope: FixScopeEntry,
): ScopeClassification {
  const matched: { path: string; glob: string; reason: string }[] = [];
  for (const entry of entries) {
    for (const deny of scope.deniedPathGlobs) {
      if (matchGlob(deny.glob, entry.path)) {
        matched.push({ path: entry.path, glob: deny.glob, reason: deny.reason });
        break; // one deny verdict per path — the first matching rule names it
      }
    }
  }
  if (matched.length > 0) return { ok: false, code: "scope-requires-privilege", matched };

  const outOfScope: string[] = [];
  for (const entry of entries) {
    const allowed = scope.allowedPathGlobs.some((glob) => matchGlob(glob, entry.path));
    if (!allowed || !scope.permittedActions.includes(entry.action)) outOfScope.push(entry.path);
  }
  if (outOfScope.length > 0) return { ok: false, code: "out-of-scope-diff", paths: outOfScope };
  return { ok: true };
}

// ─── the fixContext record codec (I5, INV-7) ─────────────────────────────────

/**
 * INV-7's preflight placeholders: the two fields whose real values cannot
 * exist before `pushVerifiedSha` returns. The post-push write differs from the
 * pre-flighted encoding in EXACTLY these two fields. A 40-lowercase-hex sha
 * cannot trip `assertNoSecret`'s prefix scan nor the shape heuristic's
 * mixedClass conjunct (lower AND upper AND digit), and the canonical ISO stamp
 * carries no secret shape — the one operator-uncontrollable input is provably
 * incapable of failing validation.
 */
export const ATTEMPT_SHA_PLACEHOLDER = "0000000000000000000000000000000000000000";
export const POLL_WINDOW_OPENED_AT_PLACEHOLDER = "1970-01-01T00:00:00.000Z";

export interface FixContextPayload {
  schemaVersion: 1;
  prNumber: number;
  prBranch: string;
  attemptSha: string;
  attempt: number;
  pollWindowOpenedAt: string;
  commentIds: string[];
  omittedCommentIds: string[];
  omittedCount: number;
  commentsDigest: string;
}

/** Canonical ISO-8601 with milliseconds and Z — the shape new Date().toISOString() emits, and the placeholder's shape. */
const ISO_STAMP_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const COMMENT_ID_RE = /^\d+$/;
const SHA40_RE = /^[0-9a-f]{40}$/;
const DIGEST_RE = /^[0-9a-f]{64}$/;

const FixContextSchema = z
  .strictObject({
    schemaVersion: z.literal(1),
    prNumber: z.number().int().positive(),
    prBranch: z.string().min(1),
    attemptSha: z.string().regex(SHA40_RE),
    attempt: z.number().int().positive(),
    pollWindowOpenedAt: z.string().regex(ISO_STAMP_RE),
    commentIds: z.array(z.string().regex(COMMENT_ID_RE)),
    omittedCommentIds: z.array(z.string().regex(COMMENT_ID_RE)).max(MAX_OMITTED_COMMENT_IDS),
    omittedCount: z.number().int().nonnegative(),
    commentsDigest: z.string().regex(DIGEST_RE),
  })
  .strict();

/**
 * The record payload (schemaVersion 1). Carries IDs and a content digest and
 * NO comment prose (INV-7) — untrusted third-party text never enters the
 * closed, secret-scanned run record; the full bodies stay reachable on GitHub
 * through the IDs. `attempt` is always 1 at this story's merge.
 */
export function buildFixContextPayload(o: {
  prNumber: number;
  prBranch: string;
  commentIds: string[];
  omittedCommentIds: string[];
  omittedCount: number;
  commentsDigest: string;
  attemptSha?: string;
  attempt?: number;
  pollWindowOpenedAt?: string;
}): FixContextPayload {
  return FixContextSchema.parse({
    schemaVersion: 1,
    prNumber: o.prNumber,
    prBranch: o.prBranch,
    attemptSha: o.attemptSha ?? ATTEMPT_SHA_PLACEHOLDER,
    attempt: o.attempt ?? 1,
    pollWindowOpenedAt: o.pollWindowOpenedAt ?? POLL_WINDOW_OPENED_AT_PLACEHOLDER,
    commentIds: o.commentIds,
    omittedCommentIds: o.omittedCommentIds,
    omittedCount: o.omittedCount,
    commentsDigest: o.commentsDigest,
  });
}

/**
 * JSON-encode a validated payload. Key order is the schema's declaration
 * order, fixed, so two encodings of the same payload are byte-identical and a
 * string diff of pre-flight vs post-push encodings names the changed fields.
 */
export function encodeFixContext(payload: FixContextPayload): string {
  const p = FixContextSchema.parse(payload);
  return JSON.stringify({
    schemaVersion: p.schemaVersion,
    prNumber: p.prNumber,
    prBranch: p.prBranch,
    attemptSha: p.attemptSha,
    attempt: p.attempt,
    pollWindowOpenedAt: p.pollWindowOpenedAt,
    commentIds: p.commentIds,
    omittedCommentIds: p.omittedCommentIds,
    omittedCount: p.omittedCount,
    commentsDigest: p.commentsDigest,
  });
}

/**
 * This story's OWN parser for the encoded `"string"` field (the record store
 * has no object kind; shape authority lives here). Rejects non-strings, wrong
 * schemaVersions, unknown keys and malformed fields — fail-closed, always.
 */
export function parseFixContext(encoded: unknown): FixContextPayload {
  if (typeof encoded !== "string") {
    refuse("fix-context-invalid", "fixContext is not a JSON-encoded string", "the field is written by encodeFixContext and read back verbatim");
  }
  let raw: unknown;
  try {
    raw = JSON.parse(encoded);
  } catch (e) {
    refuse("fix-context-invalid", `fixContext does not parse: ${(e as Error).message}`, "the field is written by encodeFixContext and read back verbatim");
  }
  const parsed = FixContextSchema.safeParse(raw);
  if (!parsed.success) {
    refuse(
      "fix-context-invalid",
      `fixContext failed schema validation: ${parsed.error.issues[0]?.message ?? "invalid"}`,
      "schemaVersion 1 with the DF6.1a field set is the only accepted shape",
    );
  }
  return parsed.data;
}

/**
 * INV-7's validate-only route: run the encoded payload through the SAME
 * validation the post-push write will apply — this module's own parser, then
 * a real `RunRecordStore.set` on a SCRATCH store over an `mkdtempSync` dir
 * (constructor default `create: true`), the directory discarded afterwards.
 * The store's `assertNoSecret`/`assertKind` are not exported, so the scratch
 * store is the only way "the same validation" runs for real before the push.
 * Nothing here touches the caller's records directory.
 */
export function preflightFixContextWrite(encoded: string): void {
  parseFixContext(encoded);
  const dir = mkdtempSync(join(realpathSync(tmpdir()), "qds-fixctx-"));
  try {
    const store = new RunRecordStore({ dir });
    store.create("qds-fixctx-preflight");
    store.set("qds-fixctx-preflight", { extensions: { fixLoop: { fixContext: encoded } } });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ─── INV-3: the credential probe ─────────────────────────────────────────────

/** The driver surface the probe needs. `execTimed` is preferred when present, exactly as `src/fleet/run.ts` prefers it. */
export interface CredentialProbeDriver {
  exec(vm: string, argv: string[], stdin?: string): Promise<ExecResult>;
  execTimed?(vm: string, argv: string[], timeoutMs: number, stdin?: string): Promise<ExecResult>;
}

export type CredentialProbeResult = { ok: true } | { ok: false; hits: string[] };

/** The one approved EnvironmentFile for qds-run@ — the file leg (b) checks the content of. */
export const APPROVED_ENV_FILE = "/home/exedev/app/.env";
const UNIT_USER_FALLBACK = "exedev";
const PROBE_EXEC_TIMEOUT_MS = 30_000;

/** Env var names the transient-unit leg asserts are unset. */
const PROBE_ENV_VARS = ["GH_TOKEN", "GITHUB_TOKEN", "GH_ENTERPRISE_TOKEN", "GITHUB_API_TOKEN", "SSH_AUTH_SOCK"] as const;

/**
 * Git-config indirection names, probed in the transient unit ONLY for their
 * presence. A manager-env `GIT_CONFIG_GLOBAL` / `GIT_CONFIG_COUNT` is an
 * UNRESOLVED credential surface — its target file may carry
 * `credential.helper` — and sudo's env_reset scrubs both names, so the
 * git-config legs (a1/a2) cannot see the file they point at. Nothing here
 * resolves-and-scans the target: PRESENCE is the hit (fail closed).
 */
const PROBE_CONFIG_INDIRECTION_VARS = ["GIT_CONFIG_GLOBAL", "GIT_CONFIG_COUNT"] as const;

/** Credential-file sinks, checked readable-or-not in the unit user's home. */
const CREDENTIAL_FILES = [".git-credentials", ".netrc", ".config/gh/hosts.yml"] as const;

/**
 * The EnvironmentFile-content rules: no GH_ or GITHUB_ prefixed token line, no
 * GIT_ASKPASS, no SSH_AUTH_SOCK. Matched per line; the hit names the KEY,
 * never the value.
 */
const ENV_FILE_FORBIDDEN_RE = /^(?:(?:GH|GITHUB)_[A-Z_]*TOKEN|GIT_ASKPASS|SSH_AUTH_SOCK)=/;

/**
 * An `Environment=` value's credential-bearing keys: any key ending in
 * `TOKEN` (covers GH_TOKEN, GITHUB_API_TOKEN, OPENAI_API_TOKEN, …), plus the
 * two named non-TOKEN keys. The key is everything up to the first `=`.
 */
const ENV_KEY_RE = /(?:^|\s|["'])([A-Za-z_][A-Za-z0-9_]*)=/g;

function envValueCredentialKeys(value: string): string[] {
  const keys: string[] = [];
  for (const m of value.matchAll(ENV_KEY_RE)) {
    const key = m[1]!;
    if (key.endsWith("TOKEN") || key === "GIT_ASKPASS" || key === "SSH_AUTH_SOCK") keys.push(key);
  }
  return keys;
}

/** The script leg (a3) runs inside the transient unit: file readability and the env-var set, one PROBE-HIT line per sink. */
const ENV_PROBE_SCRIPT = [
  'H="${HOME:-/home/$(id -un)}"',
  ...CREDENTIAL_FILES.map((f) => `[ -r "$H/${f}" ] && echo "PROBE-HIT file:$H/${f}"`),
  ...PROBE_ENV_VARS.map((v) => `printenv ${v} >/dev/null 2>&1 && echo "PROBE-HIT env:${v}"`),
  // Config indirection — see PROBE_CONFIG_INDIRECTION_VARS: presence is the hit.
  ...PROBE_CONFIG_INDIRECTION_VARS.map((v) => `printenv ${v} >/dev/null 2>&1 && echo "PROBE-HIT env:${v}"`),
  "exit 0",
].join("\n");

/**
 * INV-3's defence-in-depth probe, run between dispatch return and `fleet run`
 * — the last point at which no agent-authored code has run. Three legs:
 *
 *  (c) `systemctl cat qds-run@<runId>.service` — the RESOLVED unit and its
 *      drop-ins: every `Environment=` value free of credential-bearing keys
 *      (any `*TOKEN=`, GIT_ASKPASS, SSH_AUTH_SOCK), every `EnvironmentFile=`
 *      naming only the approved path. Read first because the unit's `User=`
 *      is what the legs below run as.
 *  (a1/a2) `sudo -n -H -u <User> git config --show-origin --get-regexp` — the
 *      unit user's HOME-scoped config surface. NOT the manager environment:
 *      sudo's env_reset scrubs it, and that is also why the indirection names
 *      (GIT_CONFIG_GLOBAL / GIT_CONFIG_COUNT) are probed in (a3) instead of
 *      resolved here. This is not the `systemd-run --wait --pipe` wrapper the
 *      first cut used — the wrapper prints its own status lines ("Running as
 *      unit …", "Finished with result …") to STDERR on every invocation, so
 *      the clean arm could never hold and the scan hit on EVERY box including
 *      a freshly-booted empty one (measured live 2026-09-20, evidence
 *      2026-09-20-231127). Clean is proven by the `sudo … true` preflight
 *      below, then `git config`'s OWN three-way outcome decides: exit 1 with
 *      empty stdout (any stderr) is CLEAN, exit 0 is a match, everything else
 *      is a hit.
 *  (a3) `sudo -n systemd-run --wait --pipe --service-type=exec --uid=<User>`
 *      — kept on systemd-run deliberately, because THIS leg is the one that
 *      must see the system-manager environment the run unit starts from
 *      (env-var sinks and the GIT_CONFIG_* indirection names), which plain
 *      sudo cannot deliver. The script reports file readability and the
 *      env-var set, one PROBE-HIT line per sink.
 *  (b) `cat /home/exedev/app/.env` directly — the one env source the unit
 *      loads that a transient unit cannot inherit; no credential-keyed line.
 *
 * Every leg fails CLOSED: an unreadable unit, a failed probe exec or a
 * truncated capture is a hit, never a pass. The result names every sink that
 * fired, so the operator sees the whole plant, not the first one.
 */
export async function probeBoxCredentials(
  driver: CredentialProbeDriver,
  vmName: string,
  runId: string,
): Promise<CredentialProbeResult> {
  const hits: string[] = [];
  const exec = (argv: string[]): Promise<ExecResult> =>
    typeof driver.execTimed === "function"
      ? driver.execTimed(vmName, argv, PROBE_EXEC_TIMEOUT_MS)
      : driver.exec(vmName, argv);

  // Leg (c) — the resolved unit and its drop-ins. Also yields User= for leg (a).
  let unitUser = UNIT_USER_FALLBACK;
  {
    const res = await exec(["systemctl", "cat", `qds-run@${runId}.service`]);
    if (res.exitCode !== 0 || res.truncated === true) {
      hits.push(`unit-unreadable:qds-run@${runId}.service`);
    } else {
      for (const line of res.stdout.split("\n")) {
        const user = /^User=(.+)$/.exec(line);
        if (user) unitUser = user[1]!.trim();
        const env = /^\s*Environment=(.*)$/.exec(line);
        if (env) {
          for (const key of envValueCredentialKeys(env[1]!)) {
            hits.push(`unit-environment:${key}`);
          }
        }
        const envFile = /^\s*EnvironmentFile=(.*)$/.exec(line);
        if (envFile) {
          // systemd's `-` prefix marks an optional file; it names the same path.
          const named = envFile[1]!.trim().replace(/^["']|["']$/g, "");
          if (named.replace(/^-/, "") !== APPROVED_ENV_FILE) {
            hits.push(`unit-environment-file:${named}`);
          }
        }
      }
    }
  }

  // Leg (a3)'s wrapper — kept on systemd-run deliberately (docstring): the
  // env-var and file sinks must be observed in the MANAGER environment the
  // run unit starts from, which plain sudo cannot deliver.
  const systemdRun = ["sudo", "-n", "systemd-run", "--wait", "--pipe", "--service-type=exec", `--uid=${unitUser}`];
  // Leg (a) preflight — prove the `sudo -n -H -u` invocation works AT ALL
  // before any git-config leg is allowed to speak for it. A sudo refusal
  // (exit 1, "a password is required") used to be told apart from git's
  // no-match arm only by requiring stderr empty on the clean arm — which also
  // refused every box whose PAM stack prints a benign warning there. With
  // sudo's functionality proven first, the git legs no longer need stderr to
  // be silent; a refusal can no longer masquerade as clean because the legs
  // that could confuse it never run.
  {
    const pre = await exec(["sudo", "-n", "-H", "-u", unitUser, "true"]);
    if (pre.exitCode !== 0 || pre.truncated === true) {
      hits.push("sudo-preflight-failed");
    } else {
      // Leg (a1/a2) — git config surfaces, in the unit user's HOME-scoped
      // config (see the docstring for why this is NOT systemd-run).
      const gitConfigChecks: { hit: string; pattern: string }[] = [
        { hit: "git-config:credential.*", pattern: "^credential\\." },
        { hit: "git-config:url.insteadOf", pattern: "^url\\..*\\.insteadof" },
      ];
      for (const check of gitConfigChecks) {
        const res = await exec(["sudo", "-n", "-H", "-u", unitUser, "git", "config", "--show-origin", "--get-regexp", check.pattern]);
        // Three-way, now that the preflight owns sudo's verdict:
        //  - exit 1 with EMPTY stdout is CLEAN — git's no-match arm — and
        //    stderr is NOT required empty: sudo's functionality is proven and
        //    PAM chatter ("unable to resolve host") is not a credential.
        //  - exit 0 is a MATCH (config emitted on stdout) — a hit, which is
        //    why a config error that writes to stderr alongside a match never
        //    slips through: that case exits 0.
        //  - anything else — non-empty stdout at exit 1, any other exit code,
        //    a truncated capture — is unaccounted for and refuses. The probe
        //    fails closed, never open.
        if (!(res.exitCode === 1 && res.stdout === "") || res.truncated === true) {
          hits.push(check.hit);
        }
      }
    }
  }

  // Leg (a3) — credential files and the env-var set, same transient unit.
  {
    const res = await exec([...systemdRun, "sh", "-c", ENV_PROBE_SCRIPT]);
    if (res.exitCode !== 0 || res.truncated === true) {
      hits.push("env-probe-exec-failed");
    } else {
      for (const line of res.stdout.split("\n")) {
        if (line.startsWith("PROBE-HIT ")) hits.push(line.slice("PROBE-HIT ".length).trim());
      }
    }
  }

  // Leg (b) — the unit's EnvironmentFile, read directly.
  {
    const res = await exec(["cat", APPROVED_ENV_FILE]);
    if (res.exitCode !== 0 || res.truncated === true) {
      // DF2.3 delivers the box's one secret into this file during provisioning;
      // a file that cannot be read cannot be proven clean.
      hits.push(`env-file-unreadable:${APPROVED_ENV_FILE}`);
    } else {
      for (const line of res.stdout.split("\n")) {
        const m = ENV_FILE_FORBIDDEN_RE.exec(line);
        if (m) hits.push(`env-file:${m[0].slice(0, -1)}`);
      }
    }
  }

  return hits.length === 0 ? { ok: true } : { ok: false, hits };
}
