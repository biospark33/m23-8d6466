/**
 * The GitHub surface DF5.2 touches, and nothing else.
 *
 * A narrow interface rather than a client library: this story makes four calls
 * (who am I, is there already a PR for this branch, open one, comment on an
 * issue) and every one of them must carry a host-only token, a 30 s timeout and
 * at most one retry. `fetch` covers that in fewer lines than configuring a
 * dependency would, and the interface is the seam every test drives.
 *
 * INV-PR-2: the token is a call ARGUMENT, never module state, never an env var
 * and never argv. Nothing here logs, so nothing here can log it.
 */

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

export interface GitHubApi {
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
export const MAX_RETRY_AFTER_MS = 60_000;
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

function retryAfterMs(res: Response): number {
  const raw = res.headers.get("retry-after");
  if (raw === null) return 1_000;
  const seconds = Number(raw);
  if (!Number.isFinite(seconds) || seconds < 0) return 1_000;
  return Math.min(seconds * 1_000, MAX_RETRY_AFTER_MS);
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
 */
async function request(
  path: string,
  init: { method: string; token: string; body?: unknown },
  apiBase = API_BASE,
): Promise<unknown> {
  const maxAttempts = SAFE_METHODS.has(init.method) ? 2 : 1;
  let lastError: Error | undefined;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    let res: Response;
    try {
      res = await fetch(`${apiBase}${path}`, {
        method: init.method,
        headers: {
          accept: "application/vnd.github+json",
          authorization: `Bearer ${init.token}`,
          "x-github-api-version": "2022-11-28",
          "user-agent": "qds-factory",
          ...(init.body !== undefined ? { "content-type": "application/json" } : {}),
        },
        ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
        signal: AbortSignal.timeout(API_TIMEOUT_MS),
      });
    } catch (e) {
      // A timeout or a transport failure is retriable exactly once, on the same
      // budget as a 5xx.
      lastError = e instanceof Error ? e : new Error(String(e));
      if (attempt < maxAttempts - 1) continue;
      throw lastError;
    }

    if (res.ok) return res.status === 204 ? null : await res.json();

    const text = await res.text().catch(() => "");
    const retriable = res.status >= 500 || res.status === 429;
    if (retriable && attempt < maxAttempts - 1) {
      await Bun.sleep(res.status === 429 ? retryAfterMs(res) : 1_000);
      continue;
    }
    throw new GitHubApiError(res.status, `${init.method} ${path} failed: ${res.status} ${text.slice(0, 500)}`);
  }
  throw lastError ?? new GitHubApiError(0, `${init.method} ${path} failed`);
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
    const [code, out] = await Promise.all([proc.exited, new Response(proc.stdout).text()]);
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
