/**
 * A2 QA department — host-side GitHub issue filing for actionable findings
 * (story AC4, INV-A2-5).
 *
 * Posture (C4): the credential never touches argv, env, or any box. The token
 * is read host-side by `readHostToken` (`src/pr/github.ts:252`, keychain →
 * piped stdin, reused UNMODIFIED) and stays in-process: filing goes over the
 * pinned GitHub REST client (`src/pr/github.ts`), the token riding each call
 * as a Bearer header argument over direct HTTPS — no child, no spawn, no env.
 * The finding prose body goes over HTTPS JSON, never argv or env; the bounded
 * title is a URL/argv-safe string field by GitHub's own API contract; the
 * token never enters argv, env, or any child.
 *
 * The input shape is strict (zod `.strict()`): a caller handing over a
 * `boxEnv`-shaped or token-shaped field is refused by name — issue filing is
 * host-side-only and the shape itself is the negative control (AC4). INV-A2-2:
 * no write credential ever enters a box.
 *
 * No interaction with the fleet approval gate (AC7): no fix PR, no merge,
 * nothing parked for approval — the module's only outputs are issue URLs and
 * per-issue failure records.
 *
 * Actionability: harvest producers mark a finding actionable by carrying a
 * concrete `diff_context_ref` — a finding with no diff reference has no
 * reproducible context to file against, and a stub-length text is not a
 * specific defect. `isActionable` gates on both, explicitly and tested.
 */

import { z } from "zod";

import { redactSecrets } from "../providers/step-log.ts";
import { httpGitHubApi, readHostToken, type GitHubApi } from "../pr/github.ts";
import { log, newRequestId, type LogEntry } from "../lib/log.ts";
import { FindingSchema, MAX_FINDINGS_PER_HARVEST, QA_LOG, type Finding } from "./findings.ts";

/** Stub-length texts are noise, not defects — below this the finding is not filed. */
export const ACTIONABLE_TEXT_MIN = 16;
/** Bounded title: first line of the finding text, never the whole prose channel. */
const TITLE_MAX = 120;

/** mirror of findings.ts RUN_ID_RE */
const RUN_ID_RE = /^qds-\d{8}-[a-f0-9]{6}$/;

/**
 * Explicit classification gate: a finding is fileable when it carries a
 * concrete diff reference AND a text long enough to state a specific defect.
 */
export function isActionable(finding: Finding): boolean {
  return (
    finding.diff_context_ref.trim().length > 0 &&
    finding.finding_text.trim().length >= ACTIONABLE_TEXT_MIN
  );
}

/** Named refusals, one code per arm. */
export type QaIssuesErrorCode = "issues-input-refused" | "issues-no-token" | "issues-bad-repo-slug";

export class QaIssuesError extends Error {
  constructor(
    readonly code: QaIssuesErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "QaIssuesError";
  }
}

/**
 * Strict input schema (AC4 negative control): any extra property — a `boxEnv`,
 * a `GH_TOKEN`-shaped field, anything — is refused. The refusal fires before
 * any token read or API call, so a box-shaped caller never gets as far as the
 * GitHub API.
 */
export const FileIssuesInputSchema = z
  .object({
    commitSha: z.string().regex(/^[a-f0-9]{40}$/),
    runId: z.string().regex(RUN_ID_RE),
    lens: z.string().min(1).max(64),
    findings: z.array(FindingSchema).max(MAX_FINDINGS_PER_HARVEST),
    titlePrefix: z.string().min(1).max(64).optional(),
    requestId: z.string().min(1).max(64).optional(),
  })
  .strict();
export type FileIssuesInput = z.infer<typeof FileIssuesInputSchema>;

export interface IssuesDeps {
  /** `owner/repo` the issues are filed against. */
  repoSlug: string;
  /** Injectable for tests; default is the real pinned REST client. */
  api?: GitHubApi;
  /** Injectable for tests; default is the real `readHostToken` seam. */
  tokenReader?: () => Promise<string | null>;
  /** Injectable structured-log sink; default is `src/lib/log.ts`. */
  log?: (entry: LogEntry) => void;
}

export interface IssuesFiling {
  filed: number;
  urls: string[];
  failures: { finding: Finding; error: string }[];
  /** Same-batch duplicates (lens + finding_text + diff_context_ref) not filed again (absent-not-0). */
  skipped?: number;
}

/**
 * File one GitHub issue per actionable finding. Failures are collected
 * per-issue and never throw mid-batch; the caller decides what a failure rate
 * means. Logs `qa-issues-filed{count}` — ABSENT when no filing was attempted
 * (zero actionable findings), `0` only when the leg ran and filed none
 * (absent-not-0, story Observability Contract); `failedCount` rides the line
 * only when failures exist. Cross-restart idempotency is out of scope here —
 * the retain path owns idempotence (documentId+replace); a host retry after
 * partial filing may re-file.
 */
export async function fileIssues(deps: IssuesDeps, rawInput: unknown): Promise<IssuesFiling> {
  const parsed = FileIssuesInputSchema.safeParse(rawInput);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new QaIssuesError(
      "issues-input-refused",
      `fileIssues input refused at ${issue ? issue.path.join(".") || "(root)" : "(root)"}: ${
        issue ? issue.message : "no detail"
      } — strict shape; a boxEnv- or token-shaped caller is the AC4 negative control, refused by name`,
    );
  }
  const input = parsed.data;
  const api = deps.api ?? httpGitHubApi();
  const readToken = deps.tokenReader ?? readHostToken;
  const sink = deps.log ?? log;

  // The slug gate runs BEFORE the empty-batch early return: a malformed
  // repoSlug is a caller bug, refused whether or not anything would be filed.
  // Split on the FIRST slash only; anything without exactly one is not a
  // slug, and a batch against an unparsable repo is a named refusal.
  const slash = deps.repoSlug.indexOf("/");
  const owner = slash === -1 ? null : deps.repoSlug.slice(0, slash);
  const repo = slash === -1 || deps.repoSlug.indexOf("/", slash + 1) !== -1 ? null : deps.repoSlug.slice(slash + 1);
  if (owner === null || repo === null || owner.length === 0 || repo.length === 0) {
    throw new QaIssuesError(
      "issues-bad-repo-slug",
      `repoSlug ${JSON.stringify(deps.repoSlug)} is not an owner/repo pair (exactly one "/") — refusing to file`,
    );
  }

  const actionable = input.findings.filter(isActionable);
  if (actionable.length === 0) {
    // Absent-not-0: no filing attempted, so no log line at all — `0` is
    // reserved for ran-and-filed-none.
    return { filed: 0, urls: [], failures: [] };
  }

  const token = await readToken();
  if (token === null || token.length === 0) {
    throw new QaIssuesError(
      "issues-no-token",
      "readHostToken returned no GitHub token (no keychain entry, no piped stdin) — refusing to file unauthenticated",
    );
  }

  const started = Date.now();
  let filed = 0;
  let skipped = 0;
  const urls: string[] = [];
  const failures: { finding: Finding; error: string }[] = [];
  const seen = new Set<string>();

  for (const finding of actionable) {
    const key = JSON.stringify([finding.lens, finding.finding_text, finding.diff_context_ref]);
    if (seen.has(key)) {
      skipped += 1;
      continue;
    }
    seen.add(key);
    try {
      const ref = await api.createIssue({ owner, repo, title: buildTitle(input, finding), body: renderBody(input, finding), token });
      filed += 1;
      urls.push(ref.htmlUrl);
    } catch (e) {
      // The twins' posture (run-retain.ts:270): stringified, secret-redacted,
      // bounded — the failure line is never a raw un-redacted prose channel.
      failures.push({ finding, error: redactSecrets(String((e as Error)?.message ?? e)).slice(0, 200) });
    }
  }

  // Best-effort: an already-earned filing result must never be lost to a
  // throwing log sink.
  try {
    sink({
      requestId: input.requestId ?? newRequestId(),
      operation: QA_LOG.issuesFiled,
      agentId: null,
      timestamp: new Date().toISOString(),
      duration: Date.now() - started,
      status: "ok",
      runId: input.runId,
      count: filed,
      // Absent-not-0: no failures, no failedCount.
      ...(failures.length > 0 ? { failedCount: failures.length } : {}),
    });
  } catch {
    // Sink failed; the filing result stands.
  }
  const result: IssuesFiling = { filed, urls, failures };
  if (skipped > 0) result.skipped = skipped;
  return result;
}

function buildTitle(input: FileIssuesInput, finding: Finding): string {
  // Redact BEFORE cutting the title: a secret-hygiene finding quotes a
  // credential by construction, and the title is the one human-facing surface
  // GitHub renders everywhere (search, notifications, email).
  const firstLine = redactSecrets(finding.finding_text).split("\n", 1)[0] ?? "";
  const base = `${finding.lens}: ${firstLine}`;
  const title = input.titlePrefix !== undefined ? `${input.titlePrefix} ${base}` : base;
  // Codepoint-bounded, not UTF-16-bounded: slicing raw indices can cut a
  // surrogate pair and hand GitHub a lone surrogate.
  return [...title].slice(0, TITLE_MAX).join("");
}

function renderBody(input: FileIssuesInput, finding: Finding): string {
  // finding_text is the prose channel a secret-hygiene finding quotes by
  // construction — never post unredacted prose to GitHub.
  return [
    "## QA finding",
    "",
    redactSecrets(finding.finding_text),
    "",
    "## Provenance",
    "",
    `- runId: ${finding.runId}`,
    `- lens: ${finding.lens}`,
    `- commit: ${input.commitSha}`,
    `- diff context: ${finding.diff_context_ref}`,
    "",
    "Filed host-side by the A2 QA department hunter-pack (post-merge, no approval traffic).",
    "",
  ].join("\n");
}
