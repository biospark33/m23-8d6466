/**
 * exe.dev `fill` (DF2.2) — clone the repo and pin the recorded SHA on a
 * `sbx/<run-id>` branch (fill.just:74-90 semantics).
 *
 * The branch is created at whatever HEAD already is: it adds no commit, changes
 * no file, and leaves the tree byte-identical — which is exactly why setup's
 * assertion A (HEAD prefix-match + empty porcelain) still passes after fill.
 * A re-fill SWITCHES to the existing branch and never re-creates it; the
 * branch's commits are the run's output, harvested by DF2.5.
 *
 * The clone is public and unauthenticated by construction: the URL grammar
 * admits `https://` (production) and `file://` (offline tests) with NO
 * userinfo — a credential-carrying URL is refused before any command runs,
 * because a push/pull secret in a box is exactly what INV-CRED-1 forbids.
 */

import { log } from "../../swarmclaw/log.ts";
import { assertValidRunId } from "../run-record.ts";
import { ExeDevDriverError, type ExeDevDriver } from "./driver.ts";

export interface FillOptions {
  /** The run id — becomes the `sbx/<run-id>` branch name. */
  runId: string;
  /** Public unauthenticated clone source (`https://`, or `file://` in tests). */
  repoUrl: string;
  /** The commit SHA from the run record, pinned verbatim. */
  commitSha: string;
  /** Clone target inside the box. Defaults to the app directory. */
  workdir?: string;
}

/**
 * Deliberately NOT `/home/agent/app` (DF2.3's KEY_ENV_FILE directory): the
 * env file and the clone must not share a directory. Key-delivered-before-fill
 * breaks `git clone` into a non-empty dir; fill-before-key makes `.env` an
 * untracked file that assertion A's porcelain check false-fails on for any
 * repo that does not .gitignore it. A sibling directory sidesteps both.
 */
export const DEFAULT_FILL_WORKDIR = "/home/agent/src";

/** 7–64 hex chars: accepts both short and full SHAs, rejects everything else. */
const SHA_RE = /^[0-9a-f]{7,64}$/i;

function assertRepoUrl(repoUrl: string): void {
  // No userinfo anywhere: `user:pass@host` inside an https URL is a credential
  // this driver refuses to carry (INV-CRED-1: no second secret in a box). The
  // host segment may not contain "/" or "@"; a PATH after the host is normal
  // (every real clone URL carries one) and is admitted whitespace-free.
  const okProto = /^https:\/\/[^\s/@]+[^\s@]*$/i.test(repoUrl) || /^file:\/\/\/[^\s@]*$/i.test(repoUrl);
  if (!okProto || repoUrl.includes("@")) {
    throw new ExeDevDriverError(
      "repo-url-invalid",
      `repoUrl ${JSON.stringify(repoUrl)} is not a plain public clone source (https:// or file:// without userinfo or whitespace)`,
      "pass an unauthenticated https:// clone URL",
    );
  }
}

function assertCommitSha(commitSha: string): void {
  if (!SHA_RE.test(commitSha)) {
    throw new ExeDevDriverError(
      "commit-sha-invalid",
      `commitSha ${JSON.stringify(commitSha)} is not 7-64 hex characters`,
      "pass the run record's commitSha verbatim",
    );
  }
}

/** One fill step: run, and turn a non-zero exit into a named fill failure. */
async function step(driver: ExeDevDriver, vm: string, label: string, argv: string[]): Promise<void> { /* dp:ok a rejection IS the error contract: non-zero exits are content-checked below, spawn errors propagate through the registry proxy's error log */
  const res = await driver.exec(vm, argv);
  if (res.exitCode !== 0) {
    throw new ExeDevDriverError(
      "fill-failed",
      `fill ${label} exited ${res.exitCode}: ${res.stderr.trim() || res.stdout.trim()}`,
      `ssh ${vm}.exe.xyz and re-run: ${argv.join(" ")}`,
    );
  }
}

/**
 * Clone (or fetch on a re-fill), pin `commitSha`, then create-or-switch
 * `sbx/<runId>`. All git work happens inside the box over the driver's exec
 * primitive — nothing is checked out on the host.
 */
export async function fillExeDev(driver: ExeDevDriver, vm: string, opts: FillOptions): Promise<void> { /* dp:ok a rejection IS the error contract: non-zero exits are content-checked below, spawn errors propagate through the registry proxy's error log */
  assertValidRunId(opts.runId);
  assertValidRunId(vm);
  assertRepoUrl(opts.repoUrl);
  assertCommitSha(opts.commitSha);
  const work = opts.workdir ?? DEFAULT_FILL_WORKDIR;
  const branch = `sbx/${opts.runId}`;
  const started = Date.now();

  // Clone only when the workdir is not already a git checkout; a re-fill
  // fetches instead, so the existing sandbox branch (the run's output) is
  // never re-created or reset.
  const fresh = await driver.exec(vm, ["sh", "-c", `test ! -d ${shq(`${work}/.git`)} && echo fresh || echo refill`]);
  if (fresh.exitCode !== 0) {
    throw new ExeDevDriverError(
      "fill-failed",
      `fill could not inspect ${work} (exit ${fresh.exitCode}): ${fresh.stderr.trim()}`,
      `ssh ${vm}.exe.xyz "ls -la ${work}" and inspect the box by hand`,
    );
  }
  if (fresh.stdout.trim() === "fresh") {
    await step(driver, vm, "clone", ["git", "clone", "--quiet", opts.repoUrl, work]);
  } else {
    await step(driver, vm, "fetch", ["git", "-C", work, "fetch", "--quiet", "origin"]);
  }
  await step(driver, vm, "checkout", ["git", "-C", work, "checkout", "--quiet", opts.commitSha]);

  // Create-or-switch: `--verify` is the existence probe (content, not $? of a
  // branch switch). The branch is created AT HEAD — no commit is added.
  const exists = await driver.exec(vm, ["git", "-C", work, "rev-parse", "--verify", "--quiet", branch]);
  if (exists.exitCode === 0) {
    await step(driver, vm, "switch", ["git", "-C", work, "switch", "--quiet", branch]);
  } else {
    await step(driver, vm, "create-branch", ["git", "-C", work, "switch", "--quiet", "-c", branch]);
  }

  const fillMs = Date.now() - started;
  log({
    requestId: driver.requestId,
    operation: "exedev.fill",
    agentId: null,
    timestamp: new Date().toISOString(),
    duration: fillMs,
    status: "ok",
    runId: opts.runId,
    driver: "exedev",
    vm,
    branch,
    commitSha: opts.commitSha,
    fill_ms: fillMs,
  });
}

/** Inline twin of driver.ts's shQuote — keep the two spellings identical. */
function shq(s: string): string {
  return `'${s.replaceAll("'", `'\\''`)}'`;
}
