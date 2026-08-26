/**
 * The registered-repository allowlist (Story DF5.2, INV-PR-3 / AC5).
 *
 * The factory acts only on repositories an operator explicitly registered in
 * `.factory/repos.json`. The remote and the base branch come from HERE and
 * never from the harvested tree's git config — the tree is agent-authored, so
 * its `origin` is exactly the kind of thing a skip-permissions agent would
 * point somewhere else (INV-PR-3).
 *
 * An EMPTY allowlist matches no repository. It never means "any repository".
 */
import { readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { z } from "zod";

export const DEFAULT_REPOS_FILE = ".factory/repos.json";

const RepoEntrySchema = z
  .object({
    /** Push URL. HTTPS only — an ssh remote would use a key this story never reads. */
    remote: z.string().min(1),
    baseBranch: z.string().min(1),
    /**
     * The GitHub account this repository's review automation is bound to. Load
     * bearing, not cosmetic: a PR opened by the wrong identity gets no bot
     * review, so DF6.1's fix loop — which triggers on a bot review comment —
     * never fires. Preflight refuses on mismatch rather than opening a silently
     * unreviewable PR.
     */
    authorLogin: z.string().min(1),
  })
  .strict();

const ReposFileSchema = z
  .object({ version: z.literal(1), repos: z.record(z.string(), RepoEntrySchema) })
  .strict();

export interface RepoEntry {
  repoSlug: string;
  remote: string;
  baseBranch: string;
  authorLogin: string;
  owner: string;
  repo: string;
}

/** A refusal that names the precondition it failed. Never carries the token. */
export class PrRefusalError extends Error {
  readonly precondition: string;
  readonly failingChecks: string[];
  readonly reportPath: string;
  readonly securityEvent: boolean;

  constructor(
    precondition: string,
    message: string,
    opts: { failingChecks?: string[]; reportPath?: string; securityEvent?: boolean } = {},
  ) {
    super(message);
    this.name = "PrRefusalError";
    this.precondition = precondition;
    this.failingChecks = opts.failingChecks ?? [];
    this.reportPath = opts.reportPath ?? "";
    this.securityEvent = opts.securityEvent ?? false;
  }
}

/**
 * `owner/repo` out of an https remote. Only github.com HTTPS remotes are
 * accepted: an `ssh://`/`git@` remote authenticates with a key this story never
 * reads, so accepting one would silently fall back to whatever the operator's
 * ambient ssh agent holds — a credential path INV-PR-1 cannot reason about.
 */
export function parseRemote(remote: string): { owner: string; repo: string } | null {
  const m = /^https:\/\/(?:[^@/]+@)?github\.com\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/.exec(remote);
  if (!m) return null;
  return { owner: m[1]!, repo: m[2]! };
}

/**
 * Read and validate the allowlist, then resolve one `repoSlug` through it.
 *
 * Absent, unreadable, wider than `0600`, schema-invalid, or simply not
 * carrying this slug — every one of them is the same refusal: nothing is
 * pushed and nothing is opened (AC5).
 */
export function resolveRepoEntry(hostRoot: string, repoSlug: string, file = DEFAULT_REPOS_FILE): RepoEntry {
  const path = resolve(hostRoot, file);
  const refuse = (message: string): never => {
    // No `reportPath`: that field names the RE-VERIFY report, and an
    // allowlist refusal happens before one is relevant. The path is in the
    // message, where it belongs.
    throw new PrRefusalError("allowlist", message, { securityEvent: true });
  };

  let st: ReturnType<typeof statSync>;
  try {
    st = statSync(path);
  } catch (e) {
    return refuse(`repo allowlist ${path} could not be read: ${(e as Error).message}`);
  }
  // Mode is checked BEFORE the content is read: a world-readable allowlist is
  // an allowlist anyone on the host can extend, and reading it first would let
  // an entry planted that way decide the target of the push.
  if ((st.mode & 0o077) !== 0) {
    return refuse(
      `repo allowlist ${path} has mode ${(st.mode & 0o777).toString(8)}; it must be 0600 — chmod 600 it and re-run`,
    );
  }

  let parsed: z.output<typeof ReposFileSchema>;
  try {
    parsed = ReposFileSchema.parse(JSON.parse(readFileSync(path, "utf8").replace(/^﻿/, "")));
  } catch (e) {
    return refuse(`repo allowlist ${path} is not a valid allowlist: ${(e as Error).message}`);
  }

  const entry = Object.hasOwn(parsed.repos, repoSlug) ? parsed.repos[repoSlug] : undefined;
  if (!entry) {
    return refuse(`repository ${repoSlug} is not registered in ${path}; the factory opens PRs only on registered repos`);
  }

  const parts = parseRemote(entry.remote);
  if (!parts) {
    return refuse(`allowlist entry for ${repoSlug} carries remote ${entry.remote}, which is not an https github.com URL`);
  }

  return {
    repoSlug,
    remote: entry.remote,
    baseBranch: entry.baseBranch,
    authorLogin: entry.authorLogin,
    owner: parts.owner,
    repo: parts.repo,
  };
}
