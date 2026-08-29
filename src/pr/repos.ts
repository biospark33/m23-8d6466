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
import { z } from "zod";

import { readGuardedFile } from "../providers/allowlist-path.ts";

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
 * How the shared guard (`src/providers/allowlist-path.ts`) speaks about THIS
 * file. The thresholds are not here and are not ours to choose — containment
 * under `hostRoot`, no group- or world-writable ancestor, self-or-root
 * ownership, a regular file, mode 0600. Only the operator-facing words are.
 */
const REPOS_FILE_SPEC = {
  codePrefix: "repo-allowlist",
  label: "repo allowlist",
  defaultFile: DEFAULT_REPOS_FILE,
  contentHint: "mapping each repoSlug to its {remote, baseBranch, authorLogin}",
  consequence: "nothing is pushed and no PR is opened",
} as const;

/**
 * Read and validate the allowlist, then resolve one `repoSlug` through it.
 *
 * Absent, unreadable, outside `hostRoot`, reached through a group- or
 * world-writable ancestor, owned by another account, not a regular file, wider
 * than `0600`, schema-invalid, or simply not carrying this slug — every one of
 * them is the same refusal: nothing is pushed and nothing is opened (AC5).
 *
 * The path guards are DELEGATED, not written here. They used to be a lone mode
 * check while `src/fleet/approvers.ts` — the other file on this host that
 * decides a security question — had all of them, which is exactly the drift a
 * shared callee prevents. See that module's header for what each guard buys.
 */
export function resolveRepoEntry(hostRoot: string, repoSlug: string, file = DEFAULT_REPOS_FILE): RepoEntry {
  // The guard's `code` rides in `failingChecks`, which is the field that
  // already exists for naming the specific check that failed, and is rendered
  // into the operator-facing refusal comment by `renderRefusalComment`. The
  // `precondition` stays `"allowlist"` for EVERY arm so no downstream `switch`
  // or assertion needs updating for the new refusals.
  //
  // No `reportPath`: that field names the RE-VERIFY report, and an allowlist
  // refusal happens before one is relevant. The path is in the message, where
  // it belongs.
  const refuse = (message: string, code = "repo-allowlist-invalid"): never => {
    throw new PrRefusalError("allowlist", message, { failingChecks: [code], securityEvent: true });
  };

  const read = readGuardedFile(hostRoot, file, REPOS_FILE_SPEC);
  if (!read.ok) return refuse(`${read.refusal.message} — ${read.refusal.remediation}`, read.refusal.code);
  const path = read.path;

  let parsed: z.output<typeof ReposFileSchema>;
  try {
    parsed = ReposFileSchema.parse(JSON.parse(read.text));
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
