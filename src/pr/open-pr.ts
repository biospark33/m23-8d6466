/**
 * `openPullRequest(runId)` — the last step of a run (Story DF5.2).
 *
 * The one irreversible, outward-facing action the factory takes, and the one
 * action a box can neither perform nor forge: the credential has never been
 * inside a sandbox, the work was re-verified out of the box (DF5.1), and an
 * operator approved that verdict (DF3.4). The box is already destroyed when
 * this runs — DF3.4 tears it down at pause — so nothing here reads from or
 * writes to a sandbox.
 *
 * Every boundary is independently resumable and none is partially recorded: a
 * push that succeeded with a PR-open that failed writes no `prUrl` and resumes
 * at the PR-open step against the existing branch (AC4).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { CostLedger } from "../providers/cost-ledger.ts";
import {
  RunRecordStore,
  assertExistingRunId,
  resolveRunsDir,
  type ExtensionEntry,
  type RunRecord,
} from "../providers/run-record.ts";
import { assertRedactable, type RedactionMap } from "../reverify/report.ts";
import { renderBody, renderRefusalComment, renderTitle, type CostSummary } from "./body.ts";
import { GitHubApiError, httpGitHubApi, readHostToken, type GitHubApi, type PrRef } from "./github.ts";
import { resolveRepoEntry, type RepoEntry } from "./repos.ts";
import {
  DEFAULT_PR_DIR,
  PrRefusalError,
  defaultTargetRef,
  preflight,
  pushWithPreflight,
  recordRefusal,
  stderrLog,
  toRefusal,
  type PrDeps,
  type Preflight,
  type RefusalRecord,
} from "./push.ts";

/** P1.3's mirror index. Non-blocking: an unresolved mapping still opens a PR. */
export const DEFAULT_MIRROR_INDEX = ".seeds/mirror-index.jsonl";

export interface OpenPrDeps extends PrDeps {
  /**
   * The run's OWN known-sensitive values (INV-PR-7). Assembled by the caller;
   * never `process.env`, which never holds the token in the first place.
   */
  redaction?: RedactionMap;
  /**
   * DF2.8's ledger file. `null` disables the lookup outright. ABSENT is not the
   * same thing: it falls through to `CostLedger`'s own default (the
   * `QDS_COST_LEDGER_FILE` path, else `.sandbox/cost-ledger.db`), which is the
   * host's real ledger and what the CLI relies on. Either way a ledger that is
   * unreachable, or that holds no row for this run, renders `Cost: unavailable`
   * rather than blocking the PR (AC2 boundary).
   */
  ledgerPath?: string | null;
  mirrorIndexPath?: string;
  /**
   * Refused outright unless it is the default `refs/heads/qds/<run-id>`.
   * Opening a PR against an operator-supplied ref is not a path this story
   * exposes — the append-to-a-branch entry point is `pushVerifiedSha` (DF6.1).
   */
  targetRef?: string;
}

export type OpenPrOutcome =
  | { ok: true; prUrl: string; prNumber: number; createdAt: string; reused: boolean }
  | { ok: false; refusal: RefusalRecord };

/** What the body's `Issue:` line renders, and where a refusal comment would go. */
export interface IssueRefs {
  line: string;
  /** The number a refusal comment is posted to, or null when unresolved. */
  issueNumber: number | null;
}

/**
 * Resolve the run's issue through P1.3's mirror index.
 *
 * ALWAYS returns a line. An unresolved mapping renders `unresolved` rather than
 * omitting the line — that is what makes DF5.4-C8 assertable on the body's
 * SHAPE rather than on P1.3's availability, and it is why P1.3 is not a hard
 * dependency edge here.
 */
export function resolveIssueRefs(hostRoot: string, repoSlug: string, issueId: unknown, indexPath?: string): IssueRefs {
  const raw = typeof issueId === "string" ? issueId.trim() : "";
  const unresolved: IssueRefs = { line: "unresolved", issueNumber: null };
  if (raw === "") return unresolved;

  let mirror: number | null = null;
  let parent: number | null = null;
  try {
    const text = readFileSync(indexPath ?? join(hostRoot, DEFAULT_MIRROR_INDEX), "utf8");
    for (const line of text.split("\n")) {
      if (line.trim().length === 0) continue;
      let row: Record<string, unknown>;
      try {
        row = JSON.parse(line) as Record<string, unknown>;
      } catch {
        continue; // a torn line in an index is not a reason to withhold a PR
      }
      if (String(row.repoSlug ?? "") !== repoSlug) continue;
      if (String(row.issueId ?? "").replace(/^#/, "") !== raw.replace(/^#/, "")) continue;
      const m = Number(row.mirrorIssue ?? row.issueNumber ?? row.number);
      const p = Number(row.parentIssue ?? row.parentIssueNumber);
      if (Number.isInteger(m) && m > 0) mirror = m;
      if (Number.isInteger(p) && p > 0) parent = p;
      break;
    }
  } catch {
    // No index, unreadable index — non-blocking by design.
  }

  // Absent a mirror entry, a plain `#42`-shaped issueId on the SAME repo is
  // already the reference: the mirror index exists to translate ACROSS repos,
  // so a same-repo id needs no translation.
  if (mirror === null && /^#?\d+$/.test(raw)) mirror = Number(raw.replace(/^#/, ""));
  if (mirror === null) return unresolved;

  return {
    line: `Closes #${mirror}${parent !== null ? ` (parent #${parent})` : ""}`,
    issueNumber: mirror,
  };
}

/** DF2.8's per-run totals, or null when the ledger is unreachable or empty. */
export function readCostSummary(runId: string, ledgerPath: string | null | undefined): CostSummary | null {
  if (ledgerPath === null) return null;
  let ledger: CostLedger | undefined;
  try {
    ledger = new CostLedger(ledgerPath === undefined ? {} : { path: ledgerPath });
    const view = ledger.readRunCost(runId);
    if (!view.hasEvents) return null;
    return { totalMicroUsd: view.totalMicroUsd, eventCount: view.eventCount, unpricedRows: view.unpricedRows };
  } catch {
    // A missing or unopenable ledger is a reporting gap, not a reason to
    // withhold a verified PR (AC2 boundary).
    return null;
  } finally {
    ledger?.close();
  }
}

/**
 * The host's own diff, never the box's claim: `changedFiles` is agent-authored.
 *
 * A failed diff REFUSES rather than returning an empty list. `[]` renders
 * `## Changed files (0)` and a `0 files, re-verified green` title — a reviewer
 * reads that as "this run changed nothing", which is a false statement about a
 * run that passed re-verification. The push has already happened by then and is
 * idempotent, so the next invocation resumes at this step (AC4).
 */
async function changedFiles(pre: Preflight): Promise<string[]> {
  const res = await pre.exec(["git", "diff", "--name-only", pre.report.baseSha, pre.headSha], { cwd: pre.hostRoot });
  if (res.exitCode !== 0) {
    throw new PrRefusalError(
      "diff-unavailable",
      `git diff ${pre.report.baseSha}..${pre.headSha} failed (exit ${res.exitCode}): ${res.stderr.trim()}`,
    );
  }
  return res.stdout.split("\n").map((l) => l.trim()).filter((l) => l.length > 0);
}

export async function openPullRequest(runId: string, deps: OpenPrDeps = {}): Promise<OpenPrOutcome> {
  // BEFORE `prDir`: `recordRefusal` writes `<prDir>/<runId>.refusals.jsonl` and
  // `defaultTargetRef` interpolates the id into a git ref, so a traversing id
  // would escape both. A malformed id is a caller bug, not a refusal the
  // factory can record durably — it throws, and the CLI exits 2.
  assertExistingRunId(runId);
  const now = deps.now ?? (() => new Date());
  const log = deps.log ?? stderrLog;
  const hostRoot = deps.hostRoot ?? process.cwd();
  const prDir = deps.prDir ?? join(hostRoot, DEFAULT_PR_DIR);
  const redaction = deps.redaction ?? {};
  // Validated HERE, not only at `renderBody`. The body is rendered AFTER the
  // push, so a map whose keys `redactSecrets` cannot see would publish a branch
  // and only then fail — and the refusal comment, which renders through the
  // same validated boundary, could not be posted either. A caller bug throws
  // before anything leaves the host.
  assertRedactable(redaction);
  const timings = { preflight_ms: 0, push_ms: 0, pr_open_ms: 0, record_write_ms: 0 };
  const startedMs = Date.now();

  // Refused before ANYTHING else, including the preflight: this entry point
  // publishes to `qds/<run-id>` and to nothing else (INV-PR-6).
  if (deps.targetRef !== undefined && deps.targetRef !== defaultTargetRef(runId)) {
    const refusal = toRefusal(
      runId,
      now().toISOString(),
      new PrRefusalError(
        "non-default-target-ref",
        `openPullRequest does not accept targetRef ${deps.targetRef}; use pushVerifiedSha for an append to an existing PR branch`,
      ),
    );
    recordRefusal(prDir, refusal);
    // Logged HERE rather than through `refuse`: that helper also notifies the
    // issue best-effort, which resolves the repo entry and reads a token. This
    // refusal happens before the preflight precisely so neither is touched.
    log({
      requestId: "unknown",
      runId,
      step: "refuse",
      repoSlug: "unknown",
      timestamp: refusal.attemptedAt,
      durationMs: Date.now() - startedMs,
      outcome: "refused",
      failedPrecondition: refusal.failedPrecondition,
      ...timings,
    });
    return { ok: false, refusal };
  }

  // ── idempotency, BEFORE the preflight: a run that already has a PR gets no
  // second one, no second push, and no credential read at all (AC4). Checked
  // here rather than after the gate so a report that has since been superseded
  // cannot turn an already-published run into a refusal.
  // Writable: this entry point WRITES `extensions.pr`, so a read-mode store
  // would refuse at the last step, after the PR was already open.
  const store = deps.store ?? new RunRecordStore({ dir: resolveRunsDir(deps.runsDir) });
  // Through `refuse` like every other precondition: an absent or unreadable
  // record makes `store.get` throw, and an unrouted throw here would reject the
  // promise with no refusal written and no log line — the one precondition in
  // this function that failed silently.
  let existing: ExtensionEntry | undefined;
  let requestId = "unknown";
  try {
    const record = store.get(runId);
    requestId = record.requestId ?? "unknown";
    existing = record.extensions?.pr;
  } catch (e) {
    return await refuse(e, null);
  }
  if (typeof existing?.prUrl === "string" && existing.prUrl.length > 0) {
    log({ requestId, runId, step: "pr_open", timestamp: now().toISOString(), durationMs: Date.now() - startedMs, outcome: "already-open", ...timings });
    return {
      ok: true,
      prUrl: existing.prUrl,
      prNumber: Number(existing.prNumber ?? 0),
      createdAt: String(existing.createdAt ?? ""),
      reused: true,
    };
  }

  let pre: Preflight;
  try {
    pre = await preflight(runId, { ...deps, store });
    timings.preflight_ms = pre.durationMs;
  } catch (e) {
    return await refuse(e, null);
  }

  const targetRef = defaultTargetRef(runId);
  const headBranch = targetRef.replace(/^refs\/heads\//, "");

  try {
    const pushStart = Date.now();
    await pushWithPreflight(pre, targetRef, log);
    timings.push_ms = Date.now() - pushStart;

    const issue = resolveIssueRefs(hostRoot, pre.entry.repoSlug, pre.record.extensions?.budget?.issueId, deps.mirrorIndexPath);
    const files = await changedFiles(pre);
    const body = renderBody(
      {
        runId,
        report: pre.report,
        approval: { approverId: pre.approval.approverId, decidedAt: pre.approval.decidedAt },
        issueRef: issue.line,
        cost: readCostSummary(runId, deps.ledgerPath),
        changedFiles: files,
      },
      redaction,
    );

    // A lost `POST /pulls` response is the duplicate-PR hazard, so the reuse
    // probe runs BEFORE the create, not only after a failure: if a branch
    // already carries an open PR, that PR is this run's PR.
    const openStart = Date.now();
    const found = await pre.github.findOpenPr({
      owner: pre.entry.owner,
      repo: pre.entry.repo,
      headBranch,
      baseBranch: pre.entry.baseBranch,
      token: pre.token,
    });
    // The host clock, stamped immediately before the call — never GitHub's
    // `created_at`, whose server clock is not comparable with the host clocks
    // that stamp `ReverifyReport.completedAt` and `ApprovalRecord.decidedAt`.
    // DF5.4-C6 proves re-verify-precedes-PR by comparing host clocks only.
    const createdAt = now().toISOString();

    /**
     * GitHub, not a lock in this process, is the serializer: it permits ONE
     * open PR per head branch and answers a second `POST /pulls` with a 422.
     * Two callers of this exported function racing past the probe above
     * therefore cannot open two PRs — the loser gets the 422, and the run whose
     * branch is published and whose PR exists must ADOPT that PR rather than
     * refuse. A 422 the probe cannot explain (a rejected base, a head with no
     * commits) is still the refusal it always was.
     */
    async function createOrAdopt(): Promise<{ pr: PrRef; adopted: boolean }> {
      try {
        const opened = await pre.github.createPr({
          owner: pre.entry.owner,
          repo: pre.entry.repo,
          base: pre.entry.baseBranch,
          head: headBranch,
          title: renderTitle(runId, files),
          body,
          token: pre.token,
        });
        return { pr: opened, adopted: false };
      } catch (e) {
        if (!(e instanceof GitHubApiError) || e.status !== 422) throw e;
        const raced = await pre.github.findOpenPr({
          owner: pre.entry.owner,
          repo: pre.entry.repo,
          headBranch,
          baseBranch: pre.entry.baseBranch,
          token: pre.token,
        });
        if (raced === null) throw e;
        return { pr: raced, adopted: true };
      }
    }

    const outcome = found !== null ? { pr: found, adopted: false } : await createOrAdopt();
    const pr = outcome.pr;
    const reused = found !== null || outcome.adopted;
    timings.pr_open_ms = Date.now() - openStart;

    // A HOST clock, never GitHub's. On the path that opens the PR this is the
    // stamp taken immediately before `POST /pulls`. On the two paths that do
    // NOT post — the lost-response reuse probe and the 422 adoption — no host
    // stamp for the true creation exists to recover (the run that made it lost
    // its response, and GitHub's `created_at` is excluded by DF5.4-C6 as a
    // non-comparable clock), so it is the host's FIRST-OBSERVATION time. That
    // is later than the true creation, which keeps re-verify-precedes-PR true
    // conservatively; it is not, on those paths, the creation instant.
    const writeStart = Date.now();
    try {
      pre.store.set(runId, {
        extensions: { pr: { prUrl: pr.url, prNumber: pr.number, createdAt } },
      });
    } catch (e) {
      // The PR IS OPEN by the time this can fail. A bare rethrow lands in the
      // outer catch as `unexpected-error`, and both the durable line and the
      // issue comment then describe a run that published nothing — the one
      // refusal in this function that would be a false statement about GitHub.
      // It stays a refusal (an unwritten correlation key is a real failure the
      // run must not pass silently) but it NAMES the PR, and the next
      // invocation resumes exactly here: `extensions.pr` is still absent, the
      // pre-create probe finds the open PR, and the reuse path writes the
      // record without opening a second one (AC4).
      throw new PrRefusalError(
        "record-write-after-publication",
        `PR ${pr.url} (#${pr.number}) IS OPEN; writing extensions.pr for ${runId} failed: ${
          e instanceof Error ? e.message : String(e)
        }. Re-run to reconcile — the open PR is reused, never reopened.`,
      );
    }
    timings.record_write_ms = Date.now() - writeStart;

    log({
      requestId: pre.requestId,
      runId,
      step: "pr_open",
      repoSlug: pre.entry.repoSlug,
      timestamp: createdAt,
      durationMs: Date.now() - startedMs,
      outcome: found !== null ? "reused" : outcome.adopted ? "adopted" : "created",
      prUrl: pr.url,
      prNumber: pr.number,
      ...timings,
    });
    return { ok: true, prUrl: pr.url, prNumber: pr.number, createdAt, reused };
  } catch (e) {
    return await refuse(e, pre);
  }

  /**
   * Record the refusal durably, then TRY the issue comment. In that order: the
   * comment is a notification on top of the record, and a run with no issue —
   * or a failing comment call — still refuses with the record written.
   */
  async function refuse(e: unknown, ctx: Preflight | null): Promise<OpenPrOutcome> {
    const refusal = toRefusal(runId, now().toISOString(), e);
    recordRefusal(prDir, refusal);
    log({
      requestId: ctx?.requestId ?? "unknown",
      runId,
      step: "refuse",
      repoSlug: ctx?.entry.repoSlug ?? "unknown",
      timestamp: refusal.attemptedAt,
      durationMs: Date.now() - startedMs,
      outcome: "refused",
      failedPrecondition: refusal.failedPrecondition,
      ...(e instanceof PrRefusalError && e.securityEvent ? { securityEvent: true } : {}),
      ...timings,
    });
    await commentBestEffort(ctx, e, refusal);
    return { ok: false, refusal };
  }

  /**
   * Post the same content as an issue comment — best effort, and never a
   * precondition for anything.
   *
   * A refusal from the GATE itself (a red verdict, an unapproved run) happens
   * before the preflight returns, so the repo entry and the token have to be
   * resolved here to notify at all. A refusal that IS about the credential or
   * the allowlist — every `securityEvent` — is deliberately not retried that
   * way: an unregistered repo must not cause a credential to be read, which is
   * the whole point of refusing it.
   */
  async function commentBestEffort(ctx: Preflight | null, e: unknown, refusal: RefusalRecord): Promise<void> {
    try {
      const resolved = ctx ?? (await notifyContext(e));
      if (resolved === null) return;
      const issue = resolveIssueRefs(
        hostRoot,
        resolved.entry.repoSlug,
        resolved.record.extensions?.budget?.issueId,
        deps.mirrorIndexPath,
      );
      if (issue.issueNumber === null) return;
      await resolved.github.commentIssue({
        owner: resolved.entry.owner,
        repo: resolved.entry.repo,
        issueNumber: issue.issueNumber,
        body: renderRefusalComment(runId, refusal, redaction),
        token: resolved.token,
      });
    } catch (err) {
      log({
        runId,
        step: "issue_comment",
        timestamp: now().toISOString(),
        durationMs: 0,
        outcome: "comment-failed",
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /** Just enough of a preflight to notify — never enough to push. */
  async function notifyContext(
    e: unknown,
  ): Promise<{ entry: RepoEntry; record: RunRecord; github: GitHubApi; token: string } | null> {
    if (e instanceof PrRefusalError && e.securityEvent) return null;
    const record = store.get(runId);
    const repoSlug = record.extensions?.budget?.repoSlug;
    if (typeof repoSlug !== "string" || repoSlug.length === 0) return null;
    const entry = resolveRepoEntry(hostRoot, repoSlug, deps.reposFile);
    const token = await (deps.token ?? readHostToken)();
    if (token === null || token.length === 0) return null;
    return { entry, record, github: deps.github ?? httpGitHubApi(), token };
  }
}
