/**
 * Run-capture issue correlation (Story DF1.8).
 *
 * The dispatch-side half of correlating a run to the GitHub issue that
 * authorized it: `resolveRunCorrelation` settles the requestId once and
 * validates the (repoSlug, issueId) pair BEFORE any session row, box or key
 * exists — pure, no fs/db/network. `appendDispatchFailure` is the host-side
 * dispatch log an initiation failure is recorded against (AC4); it must
 * succeed when the trace store could not even be opened, and throws only on
 * hard fs failure (the caller then logs to stderr and exits 2).
 *
 * Issue identity is (repoSlug, issueId), never issueId alone (INV-RUN-3):
 * `#42` exists in every repo the factory touches, so every guard here
 * requires the pair and a brief omitting repoSlug is refused, never defaulted.
 *
 * Deliberately imports nothing from trace/ — and since the trace store's
 * initiateSession throws RequestIdRepoMismatchError, that class lives in
 * types.ts so trace/ never imports this module either: no edge in either
 * direction. The trace-store half of DF1.8 (three columns, composite index,
 * initiateSession upsert) lives in trace/ on DF1.4's additive mechanisms.
 */
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type { IssueRef, ResolvedRunCorrelation } from "./types.ts";

// Re-exported so callers of the correlation API (tracer.ts, DF3.1's dispatch)
// can import the runtime errors and the result type from this one module.
export type { IssueRef, ResolvedRunCorrelation };

/** `owner/name` GitHub slug: 1..100 chars per segment, GitHub-safe charset. */
export const REPO_SLUG_PATTERN = /^[A-Za-z0-9._-]{1,100}\/[A-Za-z0-9._-]{1,100}$/;

/**
 * Canonical form of a repository slug — the identity every budget key is
 * written and queried under.
 *
 * GitHub folds owner/name case, so `Owner/Repo` and `owner/repo` are ONE
 * repository. But `repo_slug` is a byte-exact SQL predicate on every spend
 * aggregate and cap check in the cost ledger, and `capForIssue` looks the
 * per-issue override up by exact key — so without a canonical form the two
 * casings open two budget identities, and the per-issue cap is bypassable by
 * retyping the slug in a different case. Canonicalising here, in the module
 * that owns (repoSlug, issueId) identity, is what makes the pair a key rather
 * than a string that happens to be compared.
 *
 * Trims first, for the same reason `canonicalIssueId` does: both halves of the
 * pair are fed from hand-edited records and operator-authored config, and
 * `" owner/repo"` otherwise opens its own budget identity holding a full
 * untouched cap while never matching the `owner/repo#N` an override is keyed
 * by. REPO_SLUG_PATTERN rejects whitespace, so for every slug that came through
 * `resolveRunCorrelation` this is a no-op; it only folds the values that reach
 * the ledger around the charset guard.
 *
 * ASCII case-folding on purpose. SQLite's `lower()` folds ASCII and nothing
 * else, and that is what the ledger's row-side predicates use; a Unicode-aware
 * `toLowerCase()` folds characters SQLite leaves alone (`İ` is the classic
 * one), so JS and SQL would then disagree about identity for any value that
 * reached the ledger without passing REPO_SLUG_PATTERN — a hand-edited run
 * record, for one. Matching SQLite exactly removes that divergence class
 * instead of relying on the charset guard upstream.
 *
 * The cost is that the cap-bypass class is closed for ASCII slugs only:
 * `Ünïcode/Repo` and `ünïcode/repo` remain two budget identities, each holding
 * its own cap. Nothing is stranded by that — bind side and column side agree on
 * both spellings, so no row is unreachable and no spend vanishes — but a
 * non-ASCII slug retyped in another case is still two budgets. Closing it needs
 * JS and SQLite to agree on a Unicode folding, which they do not; the charset
 * guard is what keeps such slugs off the dispatch path in the first place.
 */
export function canonicalRepoSlug(slug: string): string {
  return slug.trim().replace(/[A-Z]/g, (c) => c.toLowerCase());
}

/**
 * Strict UUID v4: version nibble 4, variant nibble [89ab]; case-insensitive.
 * NOTE: the contract's literal sketch had `[89ab][0-9a-f]{4}` — a 5-char
 * variant group (37 chars total) that rejects every real 36-char UUID,
 * including randomUUID() output. The tests pin correct strict-v4 semantics,
 * so the variant group is `{3}` here.
 */
export const UUID_V4_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** GitHub issue numbers are positive int32; nothing larger is ever a real issue. */
export const MAX_ISSUE_ID = 2 ** 31 - 1;

/**
 * Headless work ids (Q1.7): slug-safe, 1..64 chars, first char not a separator.
 * Charset deliberately matches what the ledger identity string tolerates — the
 * id is half of the `${slug}#${workId}` spend key, so anything a SQL predicate
 * or a grep would trip on (whitespace, `#`, control characters) never gets in.
 * `/`, `.`, `_`, `-` are inside so DAG node ids like `dag/build-docs` are
 * expressible without a second encoding. `:` joined 2026-10-17 (A2 live
 * round's first fire, watch 542b9d73…): the QA hunter-pack's contract workId
 * `w:qa-<utcstamp>-<lens>` crossed this class and was refused at submit —
 * while the SPEND KEY this identity feeds ALREADY carries `w:` tails for
 * headless work (`issueKey = "w:<workId>"`, the test pin above), so the
 * character was always legal in the key; only the brief-side charset lagged.
 * Like `/`, it is neither whitespace, `#`, nor a control character — nothing
 * a SQL predicate or a grep would trip on.
 */
export const WORK_ID_PATTERN = /^[A-Za-z0-9._:/-]{1,64}$/;

/**
 * Refuse a headless workId. One shape rule and one COLLISION rule:
 *  - WORK_ID_PATTERN (charset + length); and
 *  - never ALL DIGITS — `"42"` would resolve to issue 42's spend identity
 *    (`${slug}#42` after the same canonicalisation issue ids get) and share its
 *    cap with it. The schema refuses the CLASS, not the value: any all-digit
 *    workId is the same collision (Q1.7).
 */
export function isValidWorkId(value: string): boolean {
  return WORK_ID_PATTERN.test(value) && !/^[0-9]+$/.test(value);
}

/** Structured refusal of a dispatch brief — fail-closed, before any row/box/key. */
export class CorrelationError extends Error {
  name = "CorrelationError";
  /** One of "INVALID_REPO_SLUG" | "INVALID_ISSUE_ID" | "INVALID_REQUEST_ID". */
  code: string;

  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

/**
 * AC3 refusal (RequestIdRepoMismatchError) lives in types.ts, not here: the
 * trace store's initiateSession throws it, and trace/ must not depend on this
 * dispatch-level module (which owns fs logging). Re-exported below so the
 * correlation API's callers keep importing it from this one module.
 */
export { RequestIdRepoMismatchError } from "./types.ts";

/** Strict UUID v4 check (the pattern itself is exported for tests and DF3.1). */
export function isValidUuidV4(value: string): boolean {
  return UUID_V4_PATTERN.test(value);
}

/**
 * Settle the run's correlation once, at dispatch.
 *
 * Honours a caller-supplied requestId only if it is a strict UUID v4; absent
 * (undefined) means generate one — the resolved value is what every downstream
 * row carries, and the caller reads it back from the result rather than
 * assuming its own stuck. Validates the (repoSlug, issueId | workId) pair
 * fail-closed: exactly one of issueId / workId is required (Q1.7) — an issue
 * brief and a headless brief are the two shapes, and neither both-at-once nor
 * neither-at-all is representable.
 *
 * PURE: no fs, no db, no network. Refusal happens here, before any session
 * row, box or key exists (AC2/INV-RUN-4).
 *
 * @throws {CorrelationError} INVALID_REPO_SLUG | INVALID_ISSUE_ID | INVALID_WORK_ID | INVALID_REQUEST_ID.
 */
export function resolveRunCorrelation(
  brief: IssueRef & { requestId?: string },
): ResolvedRunCorrelation {
  const repoSlug = brief.repoSlug.trim();
  if (repoSlug.length === 0 || !REPO_SLUG_PATTERN.test(repoSlug)) {
    throw new CorrelationError(
      "INVALID_REPO_SLUG",
      `repoSlug must be owner/name, 1..100 chars per segment, charset [A-Za-z0-9._-] (got ${JSON.stringify(brief.repoSlug)})`,
    );
  }
  // Q1.7: exactly one of issueId / workId. The neither arm keeps the
  // INVALID_ISSUE_ID code (it is the missing-identity refusal the schema's own
  // message names both fields for); a present-but-malformed workId gets its
  // own INVALID_WORK_ID so an operator can tell "you named no work" from
  // "the work id you named is not usable".
  const hasIssue = brief.issueId !== undefined;
  const hasWork = brief.workId !== undefined;
  if (hasIssue === hasWork) {
    throw new CorrelationError(
      "INVALID_ISSUE_ID",
      hasWork
        ? "exactly one of issueId or workId is required — a brief cannot carry both"
        : "exactly one of issueId or workId is required — issue work carries issueId, headless work carries workId",
    );
  }
  let issueId: number | undefined;
  let workId: string | undefined;
  if (hasIssue) {
    const id = brief.issueId as number;
    if (!Number.isInteger(id) || id <= 0 || id > MAX_ISSUE_ID) {
      throw new CorrelationError(
        "INVALID_ISSUE_ID",
        `issueId must be a positive integer <= ${MAX_ISSUE_ID} (got ${id})`,
      );
    }
    issueId = id;
  } else {
    const work = brief.workId as string;
    if (typeof work !== "string" || !isValidWorkId(work)) {
      throw new CorrelationError(
        "INVALID_WORK_ID",
        `workId must match ${WORK_ID_PATTERN.source} and may not be all digits (all digits collide with a numeric issue's spend identity) (got ${JSON.stringify(work)})`,
      );
    }
    workId = work;
  }
  let requestId: string;
  if (brief.requestId !== undefined) {
    if (!isValidUuidV4(brief.requestId)) {
      throw new CorrelationError(
        "INVALID_REQUEST_ID",
        `requestId must be a strict UUID v4 (got ${JSON.stringify(brief.requestId)})`,
      );
    }
    requestId = brief.requestId;
  } else {
    requestId = randomUUID();
  }
  return {
    requestId,
    // Validated on the raw value above so the refusal quotes what the operator
    // typed; canonicalised here so what every downstream row is keyed on is the
    // repository, not the casing. The pattern is case-blind, so the canonical
    // form is always still valid.
    repoSlug: canonicalRepoSlug(repoSlug),
    // #380: the identity TAIL is the spend key every budget row and override
    // lookup is reduced to. Issue briefs keep the numeric spelling; headless
    // briefs get the SANCTIONED work-key namespace — `w:` + the case-FOLDED
    // workId — because a bare workId is an identity no `perIssueOverrides` key
    // can address (the ledger refused every such admission, $0 spent, #380),
    // and an unfolded one would let `Sc26` and `sc26` open two budget
    // identities for one piece of work. Folding here (not at the ledger) is
    // the same choice `canonicalRepoSlug` makes one field above: one spelling
    // per identity, minted once, at the boundary that owns identity. The raw
    // `workId` field stays verbatim — it is the caller's own identifier.
    issueKey: workId === undefined ? String(issueId) : `w:${workId.toLowerCase()}`,
    issueId,
    workId,
    issueUrl: brief.issueUrl ?? null,
  };
}

/**
 * Append one JSON line to the host-side dispatch log (AC4): the correlation
 * pair plus a code and message — never prompt content (INV-RUN-5).
 *
 * Must succeed when the trace store could not even be opened, so the log's
 * parent dir is created 0700 if missing and the file is appended at mode 0600
 * (mkdir → chmod → verify, per the tracer's data-dir pattern). Throws only on
 * hard fs failure; the caller then logs to stderr and exits 2 — a lost entry
 * is never silenced into a fabricated runId.
 */
export function appendDispatchFailure(
  logPath: string,
  entry: {
    /** Null when the refusal fired before that half of the pair was known — never ""/0. */
    repoSlug: string | null;
    /** The identity half the brief named: issueId (number) or workId (string) — Q1.7. */
    issueId: number | string | null;
    requestId: string | null;
    code: string;
    message: string;
  },
): void {
  const parent = path.dirname(logPath);
  let parentStat: fs.Stats | undefined;
  try {
    // lstat, not stat: the parent itself must be a real directory. stat/exists
    // follow a symlinked parent out of the boundary, and O_NOFOLLOW below only
    // pins the FINAL component (logPath), never the directory walk to it — a
    // symlinked parent would redirect every append to an attacker-chosen file.
    parentStat = fs.lstatSync(parent);
  } catch {
    /* missing → created below */
  }
  if (parentStat === undefined) {
    // mode is umask-masked, so chmod after mkdir and verify — the contract is
    // 0700, not "0700 modulo umask".
    fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
    fs.chmodSync(parent, 0o700);
    if ((fs.statSync(parent).mode & 0o777) !== 0o700) {
      throw new Error(`dispatch-log parent dir ${parent} is not mode 0700 after chmod`);
    }
  } else if (parentStat.isSymbolicLink()) {
    throw new Error(`dispatch-log parent dir ${parent} is a symlink`);
  } else if (!parentStat.isDirectory()) {
    throw new Error(`dispatch-log parent dir ${parent} is not a directory`);
  } else if ((parentStat.mode & 0o022) !== 0) {
    // Same boundary discipline as the tracer's data-dir guards (tracer.ts):
    // a group/world-writable parent lets any uid swap the log between this
    // stat and the open below — refuse rather than append through it.
    throw new Error(`dispatch-log parent dir ${parent} is group/world-writable`);
  }

  const line = `${JSON.stringify({
    timestamp: new Date().toISOString(),
    repoSlug: entry.repoSlug,
    issueId: entry.issueId,
    requestId: entry.requestId,
    code: entry.code,
    message: entry.message,
  })}\n`;

  // O_NOFOLLOW (the tracer's pinPathNoFollow discipline, at the one
  // path-based open this module makes): a symlinked final component fails
  // with ELOOP instead of being followed out of the boundary. Mode 0600
  // applies only at create; the chmod+verify below enforces it on re-append.
  const fd = fs.openSync(
    logPath,
    fs.constants.O_WRONLY |
      fs.constants.O_APPEND |
      fs.constants.O_CREAT |
      (fs.constants.O_NOFOLLOW ?? 0),
    0o600,
  );
  try {
    fs.writeSync(fd, line);
    // fd-scoped chmod+verify: the assertion holds for the descriptor just
    // written through. Path-based chmod/stat here would re-resolve the path
    // after the close — a swap window between write and check this fd form
    // cannot have. (fstat BEFORE closeSync: the fd, not the name, is the
    // thing whose mode was just enforced.)
    fs.fchmodSync(fd, 0o600);
    if ((fs.fstatSync(fd).mode & 0o777) !== 0o600) {
      throw new Error(`dispatch log ${logPath} is not mode 0600 after chmod`);
    }
  } finally {
    fs.closeSync(fd);
  }
}
