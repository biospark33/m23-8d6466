/**
 * A real host for DF5.2's tests: a real git repo, a real bare remote, a real
 * run record, a real `ReverifyReport` on disk.
 *
 * The only seam is the REMOTE URL. `.factory/repos.json` accepts https
 * github.com remotes only, so the `exec` wrapper below rewrites that one URL to
 * the local bare repo — every git invocation (`ls-remote`, `push`, `fetch`,
 * `merge-base --is-ancestor`) still runs for real, which is what makes the
 * non-force and fast-forward assertions mean anything.
 */
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { RunRecordStore } from "../../src/providers/run-record.ts";
import { appendReport, sealReport, type ReverifyEvidence, type ReverifyReport } from "../../src/reverify/report.ts";
import { exec, type ExecResult } from "../../src/reverify/worktree.ts";
import type { GitHubApi, PrRef, PrReviewComment, PullRequestInfo } from "../../src/pr/github.ts";

export const REPO_SLUG = "acme/widgets";
export const REMOTE_URL = "https://github.com/acme/widgets.git";
export const AUTHOR_LOGIN = "steve-bot";
export const TOKEN = "ghp-sentinel-token-value-0123456789";

export interface Host {
  root: string;
  runsDir: string;
  reverifyDir: string;
  prDir: string;
  remoteDir: string;
  store: RunRecordStore;
  baseSha: string;
  headSha: string;
  exec: (argv: readonly string[], opts?: { cwd?: string; env?: Record<string, string> }) => Promise<ExecResult>;
}

async function git(cwd: string, ...argv: string[]): Promise<ExecResult> {
  const res = await exec(["git", ...argv], { cwd });
  if (res.exitCode !== 0) throw new Error(`git ${argv.join(" ")} failed: ${res.stderr || res.stdout}`);
  return res;
}

/** Deterministic identity + no signing, so the suite never depends on ~/.gitconfig. */
async function initRepo(dir: string, bare = false): Promise<void> {
  mkdirSync(dir, { recursive: true });
  await git(dir, "init", ...(bare ? ["--bare"] : []), "--initial-branch=main", ".");
  await git(dir, "config", "user.email", "test@example.invalid");
  await git(dir, "config", "user.name", "DF5.2 Test");
  await git(dir, "config", "commit.gpgsign", "false");
  // The host's own config lives INSIDE the checkout. Excluding it keeps a
  // stray `git add -A` from committing the allowlist and a later checkout from
  // deleting it out from under the test.
  if (!bare) writeFileSync(join(dir, ".git", "info", "exclude"), ".factory/\n");
}

export async function makeHost(runId: string): Promise<Host> {
  const root = mkdtempSync(join(tmpdir(), "df52-"));
  const remoteDir = join(root, "remote.git");
  const work = join(root, "work");

  await initRepo(work);
  await initRepo(remoteDir, true);

  writeFileSync(join(work, "README.md"), "base\n");
  await git(work, "add", "-A");
  await git(work, "commit", "-m", "base");
  const baseSha = (await git(work, "rev-parse", "HEAD")).stdout.trim();
  await git(work, "push", remoteDir, "main:refs/heads/main");

  writeFileSync(join(work, "src.ts"), "export const x = 1;\n");
  await git(work, "add", "-A");
  await git(work, "commit", "-m", "the agent's work");
  const headSha = (await git(work, "rev-parse", "HEAD")).stdout.trim();
  // The quarantine ref DF2.5 leaves behind, and the branch reset back to base so
  // nothing but the ref publishes the work.
  await git(work, "update-ref", `refs/sandbox/${runId}`, headSha);
  await git(work, "reset", "--hard", baseSha);

  const runsDir = join(root, "runs");
  const store = new RunRecordStore({ dir: runsDir });

  const wrapped = (argv: readonly string[], opts: { cwd?: string; env?: Record<string, string> } = {}) =>
    exec(
      argv.map((a) => (a === REMOTE_URL ? remoteDir : a)),
      opts,
    );

  return {
    root: work,
    runsDir,
    reverifyDir: join(root, "reverify"),
    prDir: join(root, "pr"),
    remoteDir,
    store,
    baseSha,
    headSha,
    exec: wrapped,
  };
}

/** The allowlisted base every fixture repo registers. */
export const BASE_BRANCH = "main";

export function writeAllowlist(
  host: Host,
  entries: Record<string, { remote: string; baseBranch: string; authorLogin: string }> | null,
  mode = 0o600,
): string {
  const dir = join(host.root, ".factory");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "repos.json");
  if (entries === null) return path;
  writeFileSync(path, JSON.stringify({ version: 1, repos: entries }));
  chmodSync(path, mode);
  return path;
}

export function defaultAllowlist(host: Host, mode = 0o600): string {
  return writeAllowlist(
    host,
    { [REPO_SLUG]: { remote: REMOTE_URL, baseBranch: BASE_BRANCH, authorLogin: AUTHOR_LOGIN } },
    mode,
  );
}

export function makeRecord(
  host: Host,
  runId: string,
  opts: { issueId?: string; approval?: Record<string, string> | null } = {},
): void {
  host.store.create(runId);
  host.store.set(runId, {
    commitSha: host.baseSha,
    requestId: "req-df52",
    extensions: {
      budget: { repoSlug: REPO_SLUG, issueId: opts.issueId ?? "42" },
      ...(opts.approval === null ? {} : { approval: opts.approval ?? {} }),
    },
  });
}

/** A green report, or a red one, at whatever sha the caller names. */
export function writeReport(
  host: Host,
  runId: string,
  opts: { headSha?: string; red?: boolean; note?: string; completedAt?: string; claimedSuccess?: boolean } = {},
): ReverifyReport {
  const headSha = opts.headSha ?? host.headSha;
  const completedAt = opts.completedAt ?? "2026-08-25T10:00:00.000Z";
  const evidence: ReverifyEvidence = {
    reverifyId: `rv-${runId}-1`,
    runId,
    requestId: "req-df52",
    headSha,
    baseSha: host.baseSha,
    startedAt: "2026-08-25T09:59:00.000Z",
    completedAt,
    durationMs: 60_000,
    checks: [
      { item: "install", ok: true, note: opts.note ?? "exit 0" },
      { item: "tests: bun test", ok: !opts.red, note: opts.red ? "exit 1, 6 pass, 1 fail" : "exit 0, 7 pass, 0 fail" },
    ],
    testResults: opts.red ? { passed: 6, failed: 1 } : { passed: 7, failed: 0 },
    flags: ["test-files-modified"],
    discrepancies: [],
    claimed:
      opts.claimedSuccess === undefined
        ? null
        : opts.claimedSuccess
          ? { exitStatus: "success", testResults: { passed: 7, failed: 0 }, changedFiles: ["src.ts"] }
          : { exitStatus: "logic", testResults: { passed: 6, failed: 1 }, changedFiles: ["src.ts"] },
    toolchain: { git: "2.44.0", bun: "1.2.0" },
    timings: { worktree_ms: 1, install_ms: 1, tests_ms: 1, gates_ms: 1, cleanup_ms: 1 },
  };
  const report = sealReport(evidence, {});
  appendReport(host.reverifyDir, report);
  return report;
}

/** An approval bound to `report`, decided one second after it completed. */
export function approve(
  host: Host,
  runId: string,
  report: ReverifyReport,
  over: Partial<Record<string, string>> = {},
): void {
  host.store.set(runId, {
    extensions: {
      approval: {
        state: "approved",
        proposal: `open a PR for run ${runId}`,
        reportId: report.reverifyId,
        headSha: report.headSha,
        requestedAt: report.completedAt,
        approverId: "steve",
        decidedAt: new Date(Date.parse(report.completedAt) + 1_000).toISOString(),
        ...over,
      },
    },
  });
}

export interface FakeGitHub extends GitHubApi {
  created: { base: string; head: string; title: string; body: string }[];
  comments: { issueNumber: number; body: string }[];
  /** Head AND base ride along so `findOpenPr` can FILTER on both, not just return. */
  openPrs: (PrRef & { head: string; base?: string })[];
  /** Review comments keyed by PR number; an absent key is an empty list. */
  reviewComments: Record<number, PrReviewComment[]>;
  /** PR state keyed by PR number; an absent key is a 404 (null). */
  pullRequests: Record<number, PullRequestInfo>;
  loginValue: string;
  failCreate: Error | null;
}

export function fakeGitHub(over: Partial<Pick<FakeGitHub, "loginValue" | "failCreate">> = {}): FakeGitHub {
  const api: FakeGitHub = {
    created: [],
    comments: [],
    openPrs: [],
    reviewComments: {},
    pullRequests: {},
    loginValue: over.loginValue ?? AUTHOR_LOGIN,
    failCreate: over.failCreate ?? null,
    async authenticatedLogin() {
      return api.loginValue;
    },
    async findOpenPr({ headBranch, baseBranch }) {
      // Filtering, not `[0]`: a production change that queries the wrong head
      // branch still resolves to a PR under a fake that ignores its arguments,
      // and the AC4 reuse tests would not notice. The base is filtered too —
      // `qds/<run-id>` can carry an open PR against another base, and a fake
      // that ignores it cannot see a reuse that lands on the wrong one.
      const hit = api.openPrs.find((p) => p.head === headBranch && (p.base ?? BASE_BRANCH) === baseBranch);
      return hit ? { url: hit.url, number: hit.number } : null;
    },
    async createPr({ base, head, title, body }) {
      if (api.failCreate) throw api.failCreate;
      api.created.push({ base, head, title, body });
      const pr = { url: `https://github.com/${REPO_SLUG}/pull/${100 + api.created.length}`, number: 100 + api.created.length };
      api.openPrs.push({ ...pr, head, base });
      return pr;
    },
    async commentIssue({ issueNumber, body }) {
      api.comments.push({ issueNumber, body });
    },
    async listPrReviewComments({ prNumber }) {
      return api.reviewComments[prNumber] ?? [];
    },
    async getPullRequest({ prNumber }) {
      return api.pullRequests[prNumber] ?? null;
    },
  };
  return api;
}

/** Every ref the bare remote currently carries. */
export async function remoteRefs(host: Host): Promise<Record<string, string>> {
  const res = await exec(["git", "for-each-ref", "--format=%(refname) %(objectname)"], { cwd: host.remoteDir });
  const out: Record<string, string> = {};
  for (const line of res.stdout.split("\n")) {
    const [ref, sha] = line.trim().split(" ");
    if (ref && sha) out[ref] = sha;
  }
  return out;
}
