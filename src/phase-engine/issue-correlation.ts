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
 * Deliberately imports nothing from trace/ — the tracer imports
 * RequestIdRepoMismatchError from here, so this module must stay free of that
 * cycle. The trace-store half of DF1.8 (three columns, composite index,
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
 * AC3 refusal: the requestId is already spoken for by a different
 * (repoSlug, issueId) pair — a different slug OR the same slug under a
 * different issue (both are re-pointing attempts, INV-RUN-2). Names BOTH
 * slugs and BOTH issue ids (existing first) so the operator can see the
 * collision; a silent accept would violate INV-RUN-1.
 */
export class RequestIdRepoMismatchError extends Error {
  name = "RequestIdRepoMismatchError";
  readonly code = "REQUEST_ID_REPO_MISMATCH";
  readonly requestId: string;
  readonly existingRepoSlug: string;
  readonly attemptedRepoSlug: string;
  /** Issue the row is already correlated to; null only on a malformed row. */
  readonly existingIssueId: number | null;
  readonly attemptedIssueId: number | null;

  constructor(e: {
    requestId: string;
    existingRepoSlug: string;
    attemptedRepoSlug: string;
    existingIssueId?: number | null;
    attemptedIssueId?: number | null;
  }) {
    super(
      `requestId ${e.requestId} is already correlated to repo "${e.existingRepoSlug}" issue #${e.existingIssueId ?? "?"} (attempted repo "${e.attemptedRepoSlug}" issue #${e.attemptedIssueId ?? "?"})`,
    );
    this.requestId = e.requestId;
    this.existingRepoSlug = e.existingRepoSlug;
    this.attemptedRepoSlug = e.attemptedRepoSlug;
    this.existingIssueId = e.existingIssueId ?? null;
    this.attemptedIssueId = e.attemptedIssueId ?? null;
  }
}

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
 * assuming its own stuck. Validates the (repoSlug, issueId) pair fail-closed.
 *
 * PURE: no fs, no db, no network. Refusal happens here, before any session
 * row, box or key exists (AC2/INV-RUN-4).
 *
 * @throws {CorrelationError} INVALID_REPO_SLUG | INVALID_ISSUE_ID | INVALID_REQUEST_ID.
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
  if (
    !Number.isInteger(brief.issueId) ||
    brief.issueId <= 0 ||
    brief.issueId > MAX_ISSUE_ID
  ) {
    throw new CorrelationError(
      "INVALID_ISSUE_ID",
      `issueId must be a positive integer <= ${MAX_ISSUE_ID} (got ${brief.issueId})`,
    );
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
    repoSlug,
    issueId: brief.issueId,
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
    issueId: number | null;
    requestId: string | null;
    code: string;
    message: string;
  },
): void {
  const parent = path.dirname(logPath);
  if (!fs.existsSync(parent)) {
    // mode is umask-masked, so chmod after mkdir and verify — the contract is
    // 0700, not "0700 modulo umask".
    fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
    fs.chmodSync(parent, 0o700);
    if ((fs.statSync(parent).mode & 0o777) !== 0o700) {
      throw new Error(`dispatch-log parent dir ${parent} is not mode 0700 after chmod`);
    }
  } else if ((fs.statSync(parent).mode & 0o022) !== 0) {
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
  } finally {
    fs.closeSync(fd);
  }
  fs.chmodSync(logPath, 0o600);
  if ((fs.statSync(logPath).mode & 0o777) !== 0o600) {
    throw new Error(`dispatch log ${logPath} is not mode 0600 after chmod`);
  }
}
