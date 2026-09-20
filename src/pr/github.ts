/**
 * The GitHub surface DF5.2 touches, and nothing else.
 *
 * A narrow interface rather than a client library: this seam makes six calls
 * (who am I, is there already a PR for this branch, open one, comment on an
 * issue, list a PR's review comments, read a PR's state and head) and every one of them must carry a host-only token, a 30 s timeout and
 * at most one retry. `fetch` covers that in fewer lines than configuring a
 * dependency would, and the interface is the seam every test drives.
 *
 * INV-PR-2: the token is a call ARGUMENT, never module state, never an env var
 * and never argv. Nothing here logs, so nothing here can log it.
 */

import { httpRequest, retryAfterMs } from "../lib/http.ts";
import { EXEC_MAX_OUTPUT_BYTES, readBounded } from "../providers/bounded-exec.ts";

export interface CreatePrInput {
  owner: string;
  repo: string;
  base: string;
  head: string;
  title: string;
  body: string;
  token: string;
}

export interface PrRef {
  url: string;
  number: number;
}

/** One PR REVIEW comment (`/pulls/{n}/comments`), not an issue comment. */
export interface PrReviewComment {
  id: number;
  body: string;
  authorLogin: string;
  authorType: string;
}

export interface PullRequestInfo {
  number: number;
  state: string;
  headRefName: string;
  headSha: string;
  merged: boolean;
}

export interface GitHubApi {
  /**
   * The PR's REVIEW comments — `/pulls/{n}/comments`, a different endpoint
   * from issue comments (DF6.1a: bot-authored review feedback is what a fix
   * run reads). A malformed element is a GitHubApiError, never a coercion.
   */
  listPrReviewComments(o: { owner: string; repo: string; prNumber: number; token: string }): Promise<PrReviewComment[]>;
  /** The PR's state and head, or null on a 404 (DF6.1a's closed/merged no-op probe). */
  getPullRequest(o: { owner: string; repo: string; prNumber: number; token: string }): Promise<PullRequestInfo | null>;
  /** The login the token authenticates as — compared against the entry's `authorLogin` (AC5). */
  authenticatedLogin(token: string): Promise<string>;
  /**
   * An OPEN PR whose head branch is `headBranch` AND whose base is
   * `baseBranch`, or null. Called before a `POST /pulls` retry so a lost
   * response never becomes a duplicate PR.
   *
   * BOTH filters, not just the head: `qds/<run-id>` can carry an open PR
   * against some other base, and reusing or adopting that one would leave the
   * run correlated to a PR that never targets the allowlisted base branch.
   */
  findOpenPr(o: { owner: string; repo: string; headBranch: string; baseBranch: string; token: string }): Promise<PrRef | null>;
  createPr(o: CreatePrInput): Promise<PrRef>;
  /** Best-effort refusal notification (AC3). Its failure never rescues a refusal. */
  commentIssue(o: { owner: string; repo: string; issueNumber: number; body: string; token: string }): Promise<void>;
}

export const API_TIMEOUT_MS = 30_000;
/** Ceiling on an honoured `retry-after`; a longer one is not waited out. */
export { MAX_RETRY_AFTER_MS } from "../lib/http.ts";
const API_BASE = "https://api.github.com";

/**
 * A non-retriable HTTP answer from the API. `status` is the discriminator
 * callers act on — 422 on `POST /pulls` is "a pull request already exists for
 * this head", which `openPullRequest` adopts rather than refuses.
 */
export class GitHubApiError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "GitHubApiError";
    this.status = status;
  }
}

/** Retried on a hiccup. A write is never replayed — see `request`. */
const SAFE_METHODS = new Set(["GET", "HEAD"]);

/**
 * One request with a 30 s timeout and AT MOST one retry, on a 5xx or a 429
 * only. A 4xx is never retried: it is a decision, not a hiccup, and retrying a
 * 422 "pull request already exists" is how duplicates get made.
 *
 * The retry is for SAFE methods only. GitHub can land a `POST /pulls` and then
 * fail the response (a 502 from the proxy in front of a write that committed);
 * retrying that POST opens a SECOND pull request, or gets a 422 that surfaces
 * as a refusal for a run whose PR already exists. `openPullRequest`'s
 * `findOpenPr` probe runs BEFORE the first POST and cannot cover a retry
 * happening inside this function, so the write is attempted exactly once and a
 * lost response is resolved by the next invocation's reuse probe (AC4).
 *
 * The mechanism — timeout, retry, body encoding — is `src/lib/http.ts`; what
 * stays here is this API's POLICY and its error class.
 */
async function request(
  path: string,
  init: { method: string; token: string; body?: unknown },
  apiBase = API_BASE,
): Promise<unknown> {
  const { res, text } = await httpRequest(
    `${apiBase}${path}`,
    { method: init.method, ...(init.body !== undefined ? { body: init.body } : {}) },
    {
      timeoutMs: API_TIMEOUT_MS,
      maxAttempts: SAFE_METHODS.has(init.method) ? 2 : 1,
      // A write is never replayed (see the docstring above), but a GET/HEAD
      // is idempotent — a transient connect/timeout hiccup on one of those
      // deserves the same one retry a 5xx gets, not just status-based retries.
      retryTransport: SAFE_METHODS.has(init.method),
      retryOn: (r) => r.status >= 500 || r.status === 429,
      retryDelayMs: (r) => (r.status === 429 ? retryAfterMs(r) : 1_000),
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${init.token}`,
        "x-github-api-version": "2022-11-28",
        "user-agent": "qds-factory",
      },
      onHttpError: (r, body) =>
        new GitHubApiError(r.status, `${init.method} ${path} failed: ${r.status} ${body.slice(0, 500)}`),
    },
  );
  if (res.status === 204) return null;
  try {
    return JSON.parse(text);
  } catch {
    // A 2xx whose body is not JSON is an API failure, not a crash — name it
    // with this module's error class so callers key off `GitHubApiError` the
    // way they do for every other GitHub failure. The body is NOT echoed: a
    // SyntaxError embeds a prefix of it verbatim, and a proxy/login-page body
    // on an authenticated call is exactly the thing not to log.
    throw new GitHubApiError(res.status, `${init.method} ${path} returned unparseable JSON (${text.length} bytes)`);
  }
}

export function httpGitHubApi(apiBase = API_BASE): GitHubApi {
  return {
    async authenticatedLogin(token) {
      const me = (await request("/user", { method: "GET", token }, apiBase)) as { login?: unknown };
      if (typeof me?.login !== "string" || me.login.length === 0) {
        throw new Error("GET /user returned no login; the token's identity could not be established");
      }
      return me.login;
    },

    async findOpenPr({ owner, repo, headBranch, baseBranch, token }) {
      const q = `?state=open&head=${encodeURIComponent(`${owner}:${headBranch}`)}&base=${encodeURIComponent(baseBranch)}&per_page=1`;
      const rows = (await request(`/repos/${owner}/${repo}/pulls${q}`, { method: "GET", token }, apiBase)) as {
        html_url?: unknown;
        number?: unknown;
      }[];
      const hit = Array.isArray(rows) ? rows[0] : undefined;
      if (!hit || typeof hit.html_url !== "string" || typeof hit.number !== "number") return null;
      return { url: hit.html_url, number: hit.number };
    },

    async createPr({ owner, repo, base, head, title, body, token }) {
      const created = (await request(
        `/repos/${owner}/${repo}/pulls`,
        { method: "POST", token, body: { title, head, base, body } },
        apiBase,
      )) as { html_url?: unknown; number?: unknown };
      if (typeof created?.html_url !== "string" || typeof created?.number !== "number") {
        throw new Error("POST /pulls returned no html_url/number");
      }
      return { url: created.html_url, number: created.number };
    },

    async commentIssue({ owner, repo, issueNumber, body, token }) {
      await request(`/repos/${owner}/${repo}/issues/${issueNumber}/comments`, { method: "POST", token, body: { body } }, apiBase);
    },

    async listPrReviewComments({ owner, repo, prNumber, token }) {
      // ONE page at per_page=100 — that truncation is the locked contract. A
      // PR carrying more than a hundred review comments is cut at the first
      // hundred here; the fix loop bounds its comment set to 20 downstream,
      // so a second page would never change the outcome.
      const path = `/repos/${owner}/${repo}/pulls/${prNumber}/comments?per_page=100`;
      const rows = (await request(path, { method: "GET", token }, apiBase)) as {
        id?: unknown;
        body?: unknown;
        user?: { login?: unknown; type?: unknown } | null;
      }[];
      if (!Array.isArray(rows)) {
        // The wire status was 200; the refusal is about the shape it carried.
        // The body is never echoed — it is authenticated-call content.
        throw new GitHubApiError(200, `GET ${path} returned a non-array body`);
      }
      return rows.map((row, index) => {
        if (
          typeof row?.id !== "number" ||
          typeof row.body !== "string" ||
          typeof row.user?.login !== "string" ||
          typeof row.user.type !== "string"
        ) {
          throw new GitHubApiError(200, `GET ${path} returned a malformed review comment at index ${index}`);
        }
        return { id: row.id, body: row.body, authorLogin: row.user.login, authorType: row.user.type };
      });
    },

    async getPullRequest({ owner, repo, prNumber, token }) {
      const path = `/repos/${owner}/${repo}/pulls/${prNumber}`;
      let pr: { number?: unknown; state?: unknown; head?: { ref?: unknown; sha?: unknown } | null; merged?: unknown };
      try {
        pr = (await request(path, { method: "GET", token }, apiBase)) as typeof pr;
      } catch (e) {
        // A 404 is an answer ("no such PR"), not a failure — the fix-run CLI's
        // closed/absent no-op keys off it.
        if (e instanceof GitHubApiError && e.status === 404) return null;
        throw e;
      }
      if (
        typeof pr?.number !== "number" ||
        typeof pr.state !== "string" ||
        typeof pr.head?.ref !== "string" ||
        typeof pr.head.sha !== "string" ||
        typeof pr.merged !== "boolean"
      ) {
        throw new GitHubApiError(200, `GET ${path} returned a malformed pull request`);
      }
      return { number: pr.number, state: pr.state, headRefName: pr.head.ref, headSha: pr.head.sha, merged: pr.merged };
    },
  };
}

/**
 * Read the host token from the macOS keychain, falling back to a piped stdin.
 *
 * Never argv (it would show in `ps`, DF2.3 INV-CRED-3) and never
 * `process.env` — an env-resident token is inherited by every child this
 * process spawns, which is the containment INV-PR-1 exists to keep. It is held
 * for the duration of one call and never cached to disk, so a rotation or a
 * revocation takes effect on the very next invocation.
 */
export async function readHostToken(): Promise<string | null> {
  // `Bun.spawn` THROWS ENOENT when the binary is absent — it does not exit
  // non-zero. On a Linux host `security` does not exist, so an unguarded call
  // would reject here and never reach the piped-stdin path below, which is the
  // only path a non-macOS host has.
  let keychain: string | null = null;
  try {
    const proc = Bun.spawn(["security", "find-generic-password", "-s", "qds-factory-github", "-w"], {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "ignore",
    });
    const [code, { text: out }] = await Promise.all([
      proc.exited,
      readBounded(proc.stdout, EXEC_MAX_OUTPUT_BYTES, {
        kill: () => {
          proc.kill(9);
        },
        exited: proc.exited,
      }),
    ]);
    if (code === 0 && out.trim().length > 0) keychain = out.trim();
  } catch {
    // No keychain on this host. Fall through to stdin; never surface the error,
    // which on some platforms carries the argv this call was made with.
  }
  if (keychain !== null) return keychain;

  // A piped stdin is the documented non-keychain path: `… | bun scripts/open-pr.ts <run-id>`.
  if (process.stdin.isTTY) return null;
  const piped = (await Bun.stdin.text()).trim();
  return piped.length > 0 ? piped : null;
}
