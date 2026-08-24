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
 * No credential ever rides the URL, on either side of the wire: the grammar
 * admits `https://` (production) and `file://` (offline tests) with NO
 * userinfo — a credential-carrying URL is refused before any command runs,
 * because a push/pull secret in a box is exactly what INV-CRED-1 forbids.
 * Since F4 (2026-08-24) the DEFAULT mode is bundle-push: the host's own git
 * credential helpers do the authenticating HOST-side (see FillMode), so
 * PRIVATE repos fill too, and the box itself never needs credentials at all.
 */

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { log } from "../../swarmclaw/log.ts";
import { assertValidRunId } from "../run-record.ts";
import { bunGitRunner, type GitRunner } from "../harvest.ts";
import type { ExeDevDriver } from "./driver.ts";
import { ExeDevDriverError, shQuote } from "./transport.ts";

/**
 * How the repo reaches the box (F4, 2026-08-24).
 *
 *  - `bundle-push` (DEFAULT): the HOST fetches the pinned SHA with the HOST's
 *    own credentials (keychain/agent — the 2026-08-24 live session proved host
 *    git auth works while in-box git 404s), `git bundle`-packs it, and pushes
 *    the bundle into the box over exec stdin (base64); the box clones from the
 *    LOCAL bundle file. Credentials never cross the wire — INV-CRED-1 stays
 *    pure — and PRIVATE repos work, which the in-box anonymous clone made
 *    impossible by design. Same machinery as DF2.5 harvest, run in reverse.
 *  - `remote-clone`: the box clones `repoUrl` itself — public repos only.
 */
export type FillMode = "bundle-push" | "remote-clone";

export interface FillOptions {
  /** The run id — becomes the `sbx/<run-id>` branch name. */
  runId: string;
  /**
   * Clone source (`https://`, or `file://` in tests). No userinfo — a
   * credential-carrying URL is refused before any command runs on either side
   * of the wire; bundle-push authenticates HOST-side through the host's own
   * git credential helpers, never through the URL.
   */
  repoUrl: string;
  /** The commit SHA from the run record, pinned verbatim. */
  commitSha: string;
  /** Clone target inside the box. HOME-relative by default (see DEFAULT_FILL_WORKDIR). */
  workdir?: string;
  /** Fill mode. Default `bundle-push` (see FillMode). */
  mode?: FillMode;
  /**
   * Bundle-push ceiling: refuse a bundle larger than this many bytes before
   * any box mutation. Whole-bundle base64 rides one exec stdin, so an
   * unbounded repo would be an unbounded host memory commitment.
   */
  bundleMaxBytes?: number;
  /** Host-side git seam for bundle-push (tests inject; default: real git). */
  gitRunner?: GitRunner;
}

/**
 * HOME-RELATIVE (F3, 2026-08-24): every driver exec lands in the box's ssh
 * HOME — the only writable root on the real exe.dev image (ssh user `exedev`,
 * `/home` root-owned; the inkwell-era `/home/agent` does not exist there). A
 * relative default is image-agnostic: it resolves wherever HOME points. An
 * absolute workdir override keeps working for embedders with a different
 * layout.
 *
 * Deliberately NOT the KEY_ENV_FILE directory (`app`): the env file and the
 * clone must not share a directory. Key-delivered-before-fill breaks
 * `git clone` into a non-empty dir; fill-before-key makes `.env` an untracked
 * file that assertion A's porcelain check false-fails on for any repo that
 * does not .gitignore it. Sibling directories (`src` beside `app`) sidestep
 * both.
 */
export const DEFAULT_FILL_WORKDIR = "src";

/** 7–64 hex chars: accepts both short and full SHAs, rejects everything else. */
const SHA_RE = /^[0-9a-f]{7,64}$/i;

function assertRepoUrl(repoUrl: string): void {
  // No userinfo anywhere: `user:pass@host` inside an https URL is a credential
  // this driver refuses to carry (INV-CRED-1: no second secret in a box). The
  // host segment may not contain "/" or "@"; a PATH after the host is normal
  // (every real clone URL carries one) and is admitted whitespace-free.
  // round 6: reject shell-hostile chars beyond RFC 3986 URL grammar (minus userinfo).
  const okProto = /^https:\/\/[^\s/@]+[^\s@]*$/i.test(repoUrl) || /^file:\/\/\/[^\s@]*$/i.test(repoUrl);
  if (!okProto || repoUrl.includes("@")) {
    throw new ExeDevDriverError(
      "repo-url-invalid",
      `repoUrl ${JSON.stringify(repoUrl)} is not a plain public clone source (https:// or file:// without userinfo or whitespace)`,
      "pass an unauthenticated https:// clone URL",
    );
  }
  if (!/^[A-Za-z0-9._~:/?#[\]%+-]+$/.test(repoUrl)) {
    throw new ExeDevDriverError(
      "repo-url-invalid",
      `repoUrl ${JSON.stringify(repoUrl)} contains characters outside the plain-URL charset (RFC 3986 minus userinfo)`,
      "pass a clean https:// URL with no shell metacharacters",
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
async function step(
  driver: ExeDevDriver,
  vm: string,
  label: string,
  argv: string[],
  stdin?: string,
): Promise<void> { /* dp:ok a rejection IS the error contract: non-zero exits are content-checked below, spawn errors propagate through the registry proxy's error log */
  const res = await driver.exec(vm, argv, stdin);
  if (res.exitCode !== 0) {
    throw new ExeDevDriverError(
      "fill-failed",
      `fill ${label} exited ${res.exitCode}: ${res.stderr.trim() || res.stdout.trim()}`,
      `ssh ${vm}.exe.xyz and re-run: ${argv.join(" ")}`,
    );
  }
}

// ─── bundle-push (F4): host-credentialed fill for private repos ─────────────

/** The named ref every pushed bundle carries (host writes it, box reads it). */
const BUNDLE_REF = "refs/heads/qds-fill";

/** Default bundle-push ceiling: 512 MiB before base64 inflation. */
const DEFAULT_BUNDLE_MAX_BYTES = 512 * 1024 * 1024;

/**
 * Host-side half of bundle-push: fetch the pinned SHA with the HOST's own
 * credentials into a scratch clone, then bundle it under BUNDLE_REF. Returns
 * the bundle bytes and owns nothing after the call — the caller rm's the
 * scratch dir when done.
 */
async function hostBundle(
  opts: FillOptions,
  gitRunner: GitRunner,
): Promise<{ scratchDir: string; bundleBytes: Buffer }> {
  const scratchDir = mkdtempSync(join(tmpdir(), "qds-fill-host-"));
  const bundlePath = join(scratchDir, "fill.bundle");
  // Full fetch by SHA (no --depth): a bundle must carry the complete history
  // reachable from the ref, and `git bundle create` refuses shallow repos.
  // GitHub's server allows fetching reachable SHAs (proven live 2026-08-24 by
  // the e2e harness's own scratchClone).
  const sequence: readonly (readonly string[])[] = [
    ["git", "init", "--quiet"],
    ["git", "remote", "add", "origin", opts.repoUrl],
    ["git", "fetch", "--quiet", "origin", opts.commitSha],
    ["git", "cat-file", "-e", `${opts.commitSha}^{commit}`],
    ["git", "update-ref", BUNDLE_REF, opts.commitSha],
    ["git", "bundle", "create", bundlePath, BUNDLE_REF],
  ];
  try {
    for (const argv of sequence) {
      const res = await gitRunner(argv, scratchDir);
      if (res.exitCode !== 0) {
        throw new ExeDevDriverError(
          "fill-failed",
          `fill host-bundle '${argv.join(" ")}' exited ${res.exitCode}: ${res.stderr.trim() || res.stdout.trim()}`,
          `run it by hand in a scratch dir — the HOST's git credentials are the ones in play here; check they can read ${opts.repoUrl} at ${opts.commitSha}`,
        );
      }
    }
    const bundleBytes = readFileSync(bundlePath);
    const maxBytes = opts.bundleMaxBytes ?? DEFAULT_BUNDLE_MAX_BYTES;
    if (bundleBytes.byteLength > maxBytes) {
      throw new ExeDevDriverError(
        "fill-failed",
        `fill bundle-too-large: ${opts.repoUrl} at ${opts.commitSha} bundles to ${bundleBytes.byteLength} bytes, over the ${maxBytes}-byte ceiling — nothing was sent to the box`,
        "raise FillOptions.bundleMaxBytes for an embedder that accepts the memory cost, or shallow the repository",
      );
    }
    return { scratchDir, bundleBytes };
  } catch (e) {
    rmSync(scratchDir, { recursive: true, force: true });
    throw e;
  }
}

/**
 * Box-side half of bundle-push: land the base64'd bundle via exec stdin (the
 * only host→box content channel — `copyFile` is box→host by design), then
 * clone/fetch from the LOCAL file. The bundle lands beside the workdir as
 * `<workdir>.bundle` and is removed once the checkout is pinned.
 */
async function pushBundle(
  driver: ExeDevDriver,
  vm: string,
  bundleRel: string,
  bundleBytes: Buffer,
): Promise<void> {
  // `rm -f` then create: a leftover bundle from an aborted fill must not be
  // appended to or cloned stale. Same create posture as deliverScript
  // (credentials.ts): validated path, plain redirection.
  await step(
    driver,
    vm,
    "bundle-push",
    ["sh", "-c", `umask 077 && rm -f ${shQuote(bundleRel)} && base64 -d > ${shQuote(bundleRel)}`],
    bundleBytes.toString("base64"),
  );
  const sizeProbe = await driver.exec(vm, ["sh", "-c", `wc -c < ${shQuote(bundleRel)}`]);
  if (sizeProbe.exitCode !== 0 || Number(sizeProbe.stdout.trim()) !== bundleBytes.byteLength) {
    throw new ExeDevDriverError(
      "fill-failed",
      `fill bundle-push landed ${sizeProbe.stdout.trim()} bytes in the box, expected ${bundleBytes.byteLength} — the transfer corrupted`,
      `ssh ${vm}.exe.xyz and re-run the fill; the bundle is recreated fresh each time`,
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
  // never re-created or reset. round 6: test -d follows symlinks; fill must
  // write only where it was pointed.
  // round 7: walk EVERY path component (parent symlinks escape the tree).
  // POSIX-portable: IFS=/ splits; leading / produces empty first element,
  // so we start p at / for absolute paths. For each non-empty component,
  // build the prefix incrementally and check for symlink-ness.
  const probe = `w=${shQuote(work)}
p=
case $w in /*) p=/ ;; esac
IFS=/; set -f; set -- $w  # -f: a workdir component with a glob char must not expand against the filesystem
for part in "$@"; do
  [ -z "$part" ] && continue
  p="$p$part"
  [ -L "$p" ] && echo symlink && exit 0
  p="$p/"
done
[ ! -d ${shQuote(`${work}/.git`)} ] && echo fresh || echo refill`;
  const fresh = await driver.exec(vm, ["sh", "-c", probe]);
  if (fresh.exitCode !== 0) {
    throw new ExeDevDriverError(
      "fill-failed",
      `fill could not inspect ${work} (exit ${fresh.exitCode}): ${fresh.stderr.trim()}`,
      `ssh ${vm}.exe.xyz "ls -la ${work}" and inspect the box by hand`,
    );
  }
  if (fresh.stdout.trim() === "symlink") {
    throw new ExeDevDriverError(
      "workdir-symlink",
      `fill workdir ${work} on ${vm}.exe.xyz is a symlink; fill requires a regular directory`,
      `ssh ${vm}.exe.xyz "ls -la ${work}" and inspect by hand`,
    );
  }
  // F4: source selection. bundle-push (default) moves the repo host→box with
  // the HOST's credentials; remote-clone is the legacy in-box https clone.
  const mode = opts.mode ?? "bundle-push";
  const bundleRel = `${work}.bundle`;
  let hostScratch: string | undefined;
  try {
    if (mode === "bundle-push") {
      const gitRunner = opts.gitRunner ?? bunGitRunner;
      const { scratchDir, bundleBytes } = await hostBundle(opts, gitRunner);
      hostScratch = scratchDir;
      await pushBundle(driver, vm, bundleRel, bundleBytes);
      if (fresh.stdout.trim() === "fresh") {
        await step(driver, vm, "clone", [
          "git",
          "clone",
          "--quiet",
          "--branch",
          BUNDLE_REF.slice("refs/heads/".length),
          bundleRel,
          work,
        ]);
      } else {
        // The bundle is a SIBLING of the workdir in the ssh HOME; `git -C work`
        // re-roots relative paths at the workdir, so reference it as ../<name>.
        const bundleName = `${work.split("/").filter(Boolean).pop()}.bundle`;
        await step(driver, vm, "fetch", ["git", "-C", work, "fetch", "--quiet", `../${bundleName}`, BUNDLE_REF]);
      }
    } else if (fresh.stdout.trim() === "fresh") {
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
  } finally {
    // Bundle-push litter, both sides. Best-effort by design: the checkout is
    // already pinned, so a leftover bundle is disk noise, never correctness —
    // and a cleanup failure must not mask the fill's own error.
    if (mode === "bundle-push") {
      try {
        await driver.exec(vm, ["rm", "-f", bundleRel]);
      } catch {
        // box unreachable — the teardown destroys the box anyway
      }
    }
    if (hostScratch !== undefined) {
      rmSync(hostScratch, { recursive: true, force: true });
    }
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
    mode,
    fill_ms: fillMs,
  });
}
