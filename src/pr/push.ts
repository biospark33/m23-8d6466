/**
 * The host-side push, and the preflight that guards it (Story DF5.2).
 *
 * `pushVerifiedSha` is a SEPARATE export from `openPullRequest` because DF6.1's
 * fix loop enters here — it appends to an existing PR branch and never opens a
 * second PR. Both entry points run the SAME preflight (INV-PR-5): there is no
 * push path that skips the gate, so a fix run's append needs its own green
 * report and its own matching approval exactly as a first PR does.
 *
 * DD-10: P1.15 had the agent push from inside the box. D8 reverses that. The
 * credential is host-only, the push happens after DF5.1's out-of-box re-verify,
 * and nothing in this file is reachable from a provider driver (INV-PR-1).
 */
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

import { RunRecordStore, assertExistingRunId, resolveRunsDir, type RunRecord } from "../providers/run-record.ts";
import { DEFAULT_REVERIFY_DIR, readReportsWithTail, reportPath, type ReverifyReport } from "../reverify/report.ts";
import { exec as defaultExec, type ExecResult } from "../reverify/worktree.ts";
import { httpGitHubApi, readHostToken, type GitHubApi } from "./github.ts";
import { PrRefusalError, resolveRepoEntry, type RepoEntry } from "./repos.ts";

export { PrRefusalError };

/** Where refusals are recorded — host-side, append-only, mode 0600. */
export const DEFAULT_PR_DIR = ".sandbox/pr";

/**
 * The namespace EVERY publishable ref lives under.
 *
 * The factory publishes to `qds/…` and to nothing else. Without this,
 * `pushVerifiedSha`'s `targetRef` is caller-controlled: an ancestor-validated
 * push straight onto `refs/heads/main`, or the creation of a tag, is a
 * one-argument change away — and the ancestry check is not a permission, it
 * only proves the update is an append (INV-PR-6).
 */
export const PUBLISH_REF_PREFIX = "refs/heads/qds/";

/** The branch a first PR is opened from. `openPullRequest` uses this and only this. */
export function defaultTargetRef(runId: string): string {
  return `refs/heads/qds/${runId}`;
}

/**
 * Refuse any ref outside the publish namespace, and any name git would reject
 * or a path join would resolve out of it.
 *
 * `..` is the traversal that makes `refs/heads/qds/../../heads/main` a push to
 * `main`; the rest is `git check-ref-format`'s grammar, applied here rather
 * than discovered as a push failure after the credential has been handed to a
 * child.
 */
/**
 * Each `/`-separated segment of a publishable ref, in full — git's own
 * component grammar, not an approximation of it.
 *
 * A dot may only appear BETWEEN two non-dot runs. That is what rejects `a.`
 * and `a..b`, which `git check-ref-format` rejects too (`..` is its range
 * operator). A looser `[A-Za-z0-9._-]*` tail accepts both, and the refusal
 * then arrives as a failed `git push` — after the token has already been
 * handed to a git child, which is the ordering this guard exists to prevent.
 */
const REF_SEGMENT_RE = /^[A-Za-z0-9][A-Za-z0-9_-]*(?:\.[A-Za-z0-9_-]+)*$/;

export function assertPublishableRef(targetRef: string): void {
  const rest = targetRef.startsWith(PUBLISH_REF_PREFIX) ? targetRef.slice(PUBLISH_REF_PREFIX.length) : null;
  const segments = rest === null ? [] : rest.split("/");
  // An ALLOW-list, not a deny-list: a leading `.`, a `..`, an empty segment, a
  // space, a control character and every one of git's own `~^:?*[\@{`
  // metacharacters all fail to match, and none of them has to be enumerated.
  const ok =
    rest !== null &&
    segments.length > 0 &&
    segments.every((seg) => REF_SEGMENT_RE.test(seg) && !seg.endsWith(".lock"));
  if (!ok) {
    throw new PrRefusalError(
      "target-ref-outside-namespace",
      `${JSON.stringify(targetRef)} is not a publishable ref; the factory pushes only to ${PUBLISH_REF_PREFIX}<name>`,
      { securityEvent: true },
    );
  }
}

export interface PrDeps {
  /** The operator's checkout — the host git repo AND where `.factory/` lives. */
  hostRoot?: string;
  runsDir?: string;
  store?: RunRecordStore;
  reverifyDir?: string;
  /** Where `<run-id>.refusals.jsonl` is appended. Defaults to `<hostRoot>/.sandbox/pr`. */
  prDir?: string;
  reposFile?: string;
  /** Reads the host token. Defaults to keychain-then-stdin; never env, never argv. */
  token?: () => Promise<string | null>;
  github?: GitHubApi;
  exec?: (argv: readonly string[], opts?: { cwd?: string; env?: Record<string, string> }) => Promise<ExecResult>;
  now?: () => Date;
  log?: (event: Record<string, unknown>) => void;
}

/** Everything the gate proved, handed forward so no caller re-reads it. */
export interface Preflight {
  runId: string;
  requestId: string;
  record: RunRecord;
  report: ReverifyReport;
  approval: { approverId: string; decidedAt: string; reportId: string; headSha: string };
  entry: RepoEntry;
  headSha: string;
  token: string;
  login: string;
  hostRoot: string;
  reverifyDir: string;
  store: RunRecordStore;
  github: GitHubApi;
  exec: NonNullable<PrDeps["exec"]>;
  durationMs: number;
}

export type PushOutcome =
  | { ok: true; sha: string; targetRef: string; pushed: boolean }
  | { ok: false; refusal: RefusalRecord };

export interface RefusalRecord {
  runId: string;
  attemptedAt: string;
  failedPrecondition: string;
  failingChecks: string[];
  reportPath: string;
  message: string;
}

export function stderrLog(event: Record<string, unknown>): void {
  process.stderr.write(`${JSON.stringify(event)}\n`);
}

export function refusalPath(dir: string, runId: string): string {
  return join(dir, `${runId}.refusals.jsonl`);
}

/**
 * The DURABLE half of AC3, and the only half that is not best-effort.
 *
 * The issue comment is a notification on top of this line, not instead of it: a
 * run dispatched without an issue reference, or one whose comment API call
 * fails, still refuses with this record written — a fail-closed path whose only
 * sink is an optional surface is not fail-closed.
 */
export function recordRefusal(dir: string, record: RefusalRecord): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  appendFileSync(refusalPath(dir, record.runId), `${JSON.stringify(record)}\n`, { mode: 0o600 });
}

export function toRefusal(runId: string, at: string, e: unknown): RefusalRecord {
  const err = e instanceof PrRefusalError ? e : null;
  return {
    runId,
    attemptedAt: at,
    failedPrecondition: err?.precondition ?? "unexpected-error",
    failingChecks: err?.failingChecks ?? [],
    reportPath: err?.reportPath ?? "",
    message: e instanceof Error ? e.message : String(e),
  };
}

/**
 * Git with the host token, supplied through a credential helper reading a
 * variable set on THAT CHILD ONLY.
 *
 * Not an authenticated remote URL and not a `-c http.extraheader=` — both put
 * the token in argv, where `ps` reads it (INV-PR-2). The helper body in argv is
 * a shell function; the secret it echoes lives in the child's environment and
 * nowhere else, and the process it is handed to is `git`, never a provider
 * driver (INV-PR-1).
 */
function gitEnv(token: string): Record<string, string> {
  return {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    HOME: process.env.HOME ?? "/tmp",
    // The credential chain is reset in argv (see `authedGit`); the config that
    // can REWRITE the remote — an operator's `url.<base>.insteadOf` or `http.*`
    // rule — is reset here. Repo-local config still loads, which is the only
    // config this module relies on.
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    // No prompt, ever: an unattended refusal beats a hung push waiting on a tty.
    GIT_TERMINAL_PROMPT: "0",
    GIT_ASKPASS: "",
    QDS_PR_TOKEN: token,
  };
}

const CREDENTIAL_HELPER =
  '!f() { test "$1" = get && printf "username=x-access-token\\npassword=%s\\n" "$QDS_PR_TOKEN"; }; f';

function authedGit(argv: readonly string[]): string[] {
  // The empty helper first RESETS the inherited chain: without it the
  // operator's global helper (osxkeychain, gh, a manager) answers before ours
  // and the push authenticates as whoever that holds — the exact identity
  // mismatch AC5's `authorLogin` check exists to prevent.
  return ["git", "-c", "credential.helper=", "-c", `credential.helper=${CREDENTIAL_HELPER}`, ...argv];
}

/**
 * The gate, in the fixed order: ref → re-verify → approval → allowlist → token
 * identity. Every step refuses before the next one runs, and the token is read
 * LAST — an unregistered repo or a red verdict must never cause a credential to
 * be touched at all.
 */
export async function preflight(runId: string, deps: PrDeps = {}): Promise<Preflight> {
  const startedMs = Date.now();
  const hostRoot = deps.hostRoot ?? process.cwd();
  const runsDir = resolveRunsDir(deps.runsDir);
  const store = deps.store ?? new RunRecordStore({ dir: runsDir, create: false });
  const reverifyDir = deps.reverifyDir ?? join(hostRoot, DEFAULT_REVERIFY_DIR);
  const exec = deps.exec ?? defaultExec;
  const github = deps.github ?? httpGitHubApi();

  const record = store.get(runId);
  const requestId = record.requestId ?? "unknown";

  // ── 1. the quarantine ref, and the sha it resolves to RIGHT NOW ──
  const ref = `refs/sandbox/${runId}`;
  const probe = await exec(["git", "rev-parse", "--verify", "--quiet", `${ref}^{commit}`], { cwd: hostRoot });
  const headSha = probe.exitCode === 0 ? probe.stdout.trim() : "";
  if (headSha === "") {
    throw new PrRefusalError("quarantine-ref", `${ref} does not resolve to a commit in ${hostRoot}`, {
      reportPath: reportPath(reverifyDir, runId),
    });
  }

  // ── 2. DF5.1's report: the LAST record is authoritative, unless bound ──
  const { reports, lastLineInvalid } = readReportsWithTail(reverifyDir, runId);
  const rp = reportPath(reverifyDir, runId);
  // The extension is read BEFORE selection (the record is already in hand, so
  // this touches nothing the record read did not) because it picks WHICH report
  // is authoritative — see below. The approval REFUSALS stay in step 3, in
  // order, after every re-verify check; only selection is informed here, and no
  // credential is touched on any of these paths.
  const approval = record.extensions?.approval;
  // The LAST record is authoritative — EXCEPT on DF3.4's approval-gate resume
  // strand (AC1(c)). A `pausing` record crashed mid-gate; the operator's retry
  // appended a FRESH green report (runner.ts appends before requesting
  // approval) and re-presented the BOUND reportId, which the gate's resume arm
  // promoted while deliberately preserving it. The record therefore ends
  // `approved` bound to the STRANDED id while a newer report — the very retry
  // that resumed it — sits last in the JSONL. Selecting by recency there would
  // refuse `approval-report-mismatch` on every successful resume, permanently:
  // recovery only by hand-editing the record. So a set `approval.reportId`
  // outranks recency, and the report it names is selected from the FULL parsed
  // list. When the bound id is absent or names no parsed report, recency wins
  // and step 3's `approval-report-mismatch` still refuses (fail-safe: a bound
  // id that matches nothing may name the unreadable tail, so `at(-1)` is a
  // refusal bound, never an authorization).
  const boundReportId = typeof approval?.reportId === "string" ? approval.reportId : "";
  // A DUPLICATED bound id binds to the LATEST matching report, not the first:
  // `find` returned the EARLIEST, and a duplicated id means the run re-verified
  // under the same id — so the earliest is the stale one, the twin of the
  // "last record is authoritative" default this whole selection exists for.
  // (A stale report still cannot authorize a push: the headSha check below
  // refuses it. Latest-wins makes the duplicated-id case deliver instead of
  // merely refusing.)
  const report = boundReportId !== "" ? (reports.filter((r) => r.reverifyId === boundReportId).at(-1) ?? reports.at(-1)) : reports.at(-1);
  // "The LAST record is authoritative" inverts when the last line is the one
  // that was dropped: `at(-1)` then returns an EARLIER report, and an earlier
  // green would authorize a push the current — unreadable — verdict never did.
  // Refuse instead, and BEFORE the token read like every other gate here.
  if (lastLineInvalid) {
    throw new PrRefusalError(
      "reverify-unreadable",
      `the last line of ${rp} is not a readable ReverifyReport — refusing to fall back to an earlier verdict for run ${runId}`,
      { reportPath: rp },
    );
  }
  if (report === undefined) {
    throw new PrRefusalError("reverify-missing", `no ReverifyReport for run ${runId} at ${rp}`, { reportPath: rp });
  }
  const failingChecks = report.checks.filter((c) => !c.ok).map((c) => c.item);
  if (report.verdict !== "green") {
    throw new PrRefusalError(
      `reverify-${report.verdict}`,
      `re-verify verdict for ${runId} is ${report.verdict}${report.reason ? ` (${report.reason})` : ""}`,
      { failingChecks, reportPath: rp },
    );
  }
  // The verdict is about a SHA, not about a run. A green at some earlier sha
  // never authorizes publishing a later re-harvest.
  if (report.headSha !== headSha) {
    throw new PrRefusalError(
      "reverify-sha-mismatch",
      `re-verify for ${runId} is green at ${report.headSha} but ${ref} now resolves to ${headSha}`,
      { failingChecks, reportPath: rp },
    );
  }

  // ── 3. DF3.4's approval, bound to THAT report ──
  if (approval === undefined) {
    throw new PrRefusalError("approval-missing", `run ${runId} carries no approval record`, { reportPath: rp });
  }
  if (approval.state !== "approved") {
    throw new PrRefusalError("approval-not-approved", `approval for ${runId} is ${String(approval.state)}, not approved`, {
      reportPath: rp,
    });
  }
  const approverId = String(approval.approverId ?? "");
  const decidedAt = String(approval.decidedAt ?? "");
  if (approverId === "" || decidedAt === "") {
    throw new PrRefusalError("approval-incomplete", `approval for ${runId} carries no approverId/decidedAt`, {
      reportPath: rp,
    });
  }
  if (String(approval.reportId ?? "") !== report.reverifyId) {
    throw new PrRefusalError(
      "approval-report-mismatch",
      `approval for ${runId} is bound to report ${String(approval.reportId)}, not ${report.reverifyId}`,
      { reportPath: rp },
    );
  }
  if (String(approval.headSha ?? "") !== headSha) {
    throw new PrRefusalError(
      "approval-sha-mismatch",
      `approval for ${runId} is bound to sha ${String(approval.headSha)}, not ${headSha}`,
      { reportPath: rp },
    );
  }
  // An approval of an EARLIER verdict never authorizes a later re-harvest, so
  // the decision must post-date the report it claims to authorize. Both stamps
  // are host clocks (DF5.1 and DF3.4 both write host-side), so they compare.
  // DF5.3 (AC7) tightened the boundary from `decided < completed` to
  // `decided <= completed`: an ordering that cannot distinguish the decision
  // from the evidence has not demonstrated the decision FOLLOWED it, and the
  // audit chain's own strict comparison (same host clocks) refuses the pair
  // this used to admit.
  const decided = Date.parse(decidedAt);
  const completed = Date.parse(report.completedAt);
  // An UNPARSEABLE stamp is its own fault, with its own refusal: reported as an
  // ordering violation it sent an operator hunting for a clock skew between two
  // timestamps, one of which is not a timestamp at all.
  if (!Number.isFinite(decided) || !Number.isFinite(completed)) {
    throw new PrRefusalError(
      "approval-timestamp-unparseable",
      `approval for ${runId} cannot be ordered against report ${report.reverifyId}: ${
        !Number.isFinite(decided)
          ? `the approval's decidedAt ${JSON.stringify(decidedAt)}`
          : `the report's completedAt ${JSON.stringify(report.completedAt)}`
      } is not a parseable timestamp`,
      { reportPath: rp },
    );
  }
  // PARSEABLE is not enough: the comparison assumes both stamps are on the same
  // clock basis. `decidedAt` always is (`nowOf(deps).toISOString()`), but
  // `completedAt` is read off disk under a `z.string().min(1)` that constrains
  // no format, and `Date.parse("2026-09-17T10:00:00")` — no `Z`, no offset — is
  // parsed as LOCAL time. East of UTC that makes an offsetless stamp parse
  // EARLIER than it is, so `decided <= completed` admits an approval that in
  // fact preceded its report: the exact defeat AC7's tightening closes. West of
  // UTC it refuses a correctly-ordered pair. Both pass the guard above, so the
  // rule is the audit store's own (`validateAndBind`): canonical UTC or refuse.
  // Its OWN code — `approval-precedes-report` would send an operator looking
  // for an ordering fault in a pair that was never comparable.
  const stamps = [
    ["the approval's decidedAt", decidedAt],
    ["the report's completedAt", report.completedAt],
  ] as const;
  // Safe after the guard above: `new Date(s)` and `Date.parse(s)` share one
  // parser, so a finite parse means `toISOString()` cannot throw.
  const nonCanonical = stamps.find(([, stamp]) => new Date(stamp).toISOString() !== stamp);
  if (nonCanonical !== undefined) {
    throw new PrRefusalError(
      "approval-timestamp-non-canonical",
      `approval for ${runId} cannot be ordered against report ${report.reverifyId}: ${nonCanonical[0]} ${JSON.stringify(
        nonCanonical[1],
      )} is not a canonical UTC timestamp (YYYY-MM-DDTHH:MM:SS.sssZ), so the two stamps are not on the same clock basis`,
      { reportPath: rp },
    );
  }
  if (decided <= completed) {
    throw new PrRefusalError(
      // The CODE is unchanged — an operator's greps and anything keying on it
      // predate this PR. Only the MESSAGE moves, because `<=` admits the
      // EQUALITY case, for which "before" is factually false and two identical
      // timestamps under that word read as a clock bug that does not exist.
      "approval-precedes-report",
      `approval for ${runId} was decided at ${decidedAt}, which does not strictly follow report ${report.reverifyId} completed at ${report.completedAt}${
        // The equality case has no ordering to fix: neither stamp can be moved
        // (`decidedAt` is written once under the approval lock, the re-verify
        // report is immutable), so the refusal is a dead end without this.
        decided === completed
          ? " — the two stamps are identical, so nothing here can be corrected in place: re-run the re-verify, then re-approve against the new report"
          : ""
      }`,
      { reportPath: rp },
    );
  }

  // ── 4. the allowlist — remote and base branch, never the harvested config ──
  const repoSlug = record.extensions?.budget?.repoSlug;
  if (typeof repoSlug !== "string" || repoSlug.length === 0) {
    throw new PrRefusalError("no-repo-slug", `run ${runId} carries no extensions.budget.repoSlug to resolve a repo by`, {
      reportPath: rp,
      securityEvent: true,
    });
  }
  const entry = resolveRepoEntry(hostRoot, repoSlug, deps.reposFile);

  // ── 5. the token, read LAST, and the identity it authenticates as ──
  const token = await (deps.token ?? readHostToken)();
  if (token === null || token.length === 0) {
    throw new PrRefusalError("no-token", "no host GitHub token is available (keychain empty and stdin not piped)", {
      reportPath: rp,
      securityEvent: true,
    });
  }
  let login: string;
  try {
    login = await github.authenticatedLogin(token);
  } catch (e) {
    throw new PrRefusalError("token-unusable", `the host token could not be identified: ${(e as Error).message}`, {
      reportPath: rp,
      securityEvent: true,
    });
  }
  if (login !== entry.authorLogin) {
    throw new PrRefusalError(
      "author-identity-mismatch",
      `host token authenticates as ${login} but ${entry.repoSlug} requires ${entry.authorLogin}; a PR from the wrong identity gets no bot review`,
      { reportPath: rp, securityEvent: true },
    );
  }

  return {
    runId,
    requestId,
    record,
    report,
    approval: { approverId, decidedAt, reportId: report.reverifyId, headSha },
    entry,
    headSha,
    token,
    login,
    hostRoot,
    reverifyDir,
    store,
    github,
    exec,
    durationMs: Date.now() - startedMs,
  };
}

/** The remote's current sha for `ref`, or null when the ref does not exist there. */
async function remoteTip(pre: Preflight, ref: string): Promise<string | null> {
  const res = await pre.exec(authedGit(["ls-remote", pre.entry.remote, ref]), {
    cwd: pre.hostRoot,
    env: gitEnv(pre.token),
  });
  if (res.exitCode !== 0) {
    throw new PrRefusalError("remote-unreachable", `git ls-remote ${ref} failed (exit ${res.exitCode}): ${res.stderr.trim()}`);
  }
  const line = res.stdout.split("\n").find((l) => l.trim().length > 0);
  const tip = line ? (line.split(/\s+/)[0] ?? null) : null;
  if (tip === null) return null;
  // The remote decides this string, and it lands in `git fetch … <tip>` and
  // `git merge-base --is-ancestor <tip> …` — a leading `-` parses as an option
  // there. Everything else in this module is validated before a git child
  // (`assertPublishableRef`); the tip was the one value that was not (F065).
  // Both object-format widths, so a sha256 remote is a refusal-free upgrade
  // rather than an outage.
  if (!/^[0-9a-f]{40}$|^[0-9a-f]{64}$/.test(tip)) {
    throw new PrRefusalError(
      "remote-tip-unreadable",
      `git ls-remote ${ref} answered with ${JSON.stringify(tip)}, which is not an object id; the factory never passes an unshaped remote value to git`,
      { securityEvent: true },
    );
  }
  return tip;
}

/**
 * Push the sha DF5.1 was green at, non-force, to `targetRef`.
 *
 * The SHA is pushed, never the ref name: `refs/sandbox/<run-id>` could move
 * between preflight and push, and `git push <remote> <ref>:<target>` would then
 * publish something no host ever verified (AC1).
 *
 * A non-default `targetRef` is DF6.1's PR branch. It is additionally required to
 * be a fast-forward — an append is the only accepted update and a rewrite is a
 * refusal (INV-PR-6).
 */
export async function pushVerifiedSha(
  runId: string,
  opts: { targetRef?: string } & PrDeps = {},
): Promise<PushOutcome> {
  // BEFORE `prDir`, and before anything else can be named after `runId`:
  // `recordRefusal` writes `<prDir>/<runId>.refusals.jsonl`, so a traversing id
  // would escape the refusal directory on the very path that is supposed to
  // contain the refusal. A malformed id is a caller bug, not a refusal the
  // factory can record — it throws.
  assertExistingRunId(runId);
  const now = opts.now ?? (() => new Date());
  const prDir = opts.prDir ?? join(opts.hostRoot ?? process.cwd(), DEFAULT_PR_DIR);
  try {
    // BEFORE the preflight, for the same reason the preflight reads the token
    // LAST: a ref the factory would never publish to must not cause a
    // credential to be touched at all. `pushWithPreflight` asserts it again —
    // that is the choke point every push routes through, this is the ordering.
    const targetRef = opts.targetRef ?? defaultTargetRef(runId);
    assertPublishableRef(targetRef);
    const pre = await preflight(runId, opts);
    const pushed = await pushWithPreflight(pre, targetRef, opts.log ?? stderrLog);
    return { ok: true, sha: pre.headSha, targetRef, pushed };
  } catch (e) {
    const refusal = toRefusal(runId, now().toISOString(), e);
    recordRefusal(prDir, refusal);
    (opts.log ?? stderrLog)({
      runId,
      step: "push",
      timestamp: refusal.attemptedAt,
      durationMs: 0,
      outcome: "refused",
      failedPrecondition: refusal.failedPrecondition,
      ...(e instanceof PrRefusalError && e.securityEvent ? { securityEvent: true } : {}),
    });
    return { ok: false, refusal };
  }
}

/**
 * The push itself, on an already-satisfied preflight. Returns whether a ref
 * update actually happened — a remote already at this sha is a RESUME, not a
 * second push (AC4).
 */
export async function pushWithPreflight(
  pre: Preflight,
  targetRef: string,
  log: (e: Record<string, unknown>) => void,
): Promise<boolean> {
  const startedMs = Date.now();
  // Every push in this file routes through here — one guard covers both entry
  // points, and it runs before the token is handed to any git child.
  assertPublishableRef(targetRef);
  const isDefault = targetRef === defaultTargetRef(pre.runId);
  const tip = await remoteTip(pre, targetRef);

  if (tip === pre.headSha) {
    log({ requestId: pre.requestId, runId: pre.runId, step: "push", repoSlug: pre.entry.repoSlug, timestamp: new Date().toISOString(), durationMs: Date.now() - startedMs, outcome: "already-present" });
    return false;
  }

  if (tip !== null) {
    if (isDefault) {
      // A divergent `qds/<run-id>` is a refusal, not an overwrite (INV-PR-6).
      throw new PrRefusalError(
        "remote-ref-diverged",
        `${targetRef} already exists on ${pre.entry.repoSlug} at ${tip}, not ${pre.headSha}; the factory never force-updates a published ref`,
      );
    }
    // DF6.1's append: the new sha must be a DESCENDANT of the remote tip. The
    // tip is fetched first because `merge-base` needs the object locally, and a
    // remote whose tip we cannot fetch is a refusal rather than an assumption.
    const fetched = await pre.exec(authedGit(["fetch", "--no-tags", pre.entry.remote, `${tip}`]), {
      cwd: pre.hostRoot,
      env: gitEnv(pre.token),
    });
    if (fetched.exitCode !== 0) {
      throw new PrRefusalError(
        "remote-tip-unfetchable",
        `could not fetch ${targetRef}'s tip ${tip} to prove the push is an append: ${fetched.stderr.trim()}`,
      );
    }
    const ancestor = await pre.exec(["git", "merge-base", "--is-ancestor", tip, pre.headSha], { cwd: pre.hostRoot });
    if (ancestor.exitCode !== 0) {
      throw new PrRefusalError(
        "not-fast-forward",
        `${pre.headSha} is not a descendant of ${targetRef}'s tip ${tip}; an append is the only accepted update`,
      );
    }
  }

  const res = await pre.exec(authedGit(["push", pre.entry.remote, `${pre.headSha}:${targetRef}`]), {
    cwd: pre.hostRoot,
    env: gitEnv(pre.token),
  });
  if (res.exitCode !== 0) {
    throw new PrRefusalError("push-failed", `git push to ${targetRef} failed (exit ${res.exitCode}): ${res.stderr.trim()}`);
  }
  log({
    requestId: pre.requestId,
    runId: pre.runId,
    step: "push",
    repoSlug: pre.entry.repoSlug,
    timestamp: new Date().toISOString(),
    durationMs: Date.now() - startedMs,
    outcome: "pushed",
    targetRef,
    sha: pre.headSha,
  });
  return true;
}
