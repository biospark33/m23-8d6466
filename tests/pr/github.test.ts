/**
 * The GitHub HTTP surface (Story DF5.2).
 *
 * A real `Bun.serve` on loopback rather than a `fetch` stub: the property under
 * test is how many times a request actually reaches the server, and only a
 * server can count that.
 */
import { join } from "node:path";
import { describe, expect, test } from "bun:test";

import { httpGitHubApi } from "../../src/pr/github.ts";

const TOKEN = "ghp_0123456789abcdef";

/** A server that answers `status` for the first `failures` hits, then 200s. */
function serveFlaky(status: number, failures: number, ok: unknown) {
  let hits = 0;
  const server = Bun.serve({
    port: 0,
    fetch() {
      hits += 1;
      if (hits <= failures) return new Response("upstream fell over", { status });
      return Response.json(ok);
    },
  });
  return { server, hits: () => hits, base: `http://localhost:${server.port}` };
}

describe("retry policy", () => {
  test("a GET is retried once on a 5xx", async () => {
    const s = serveFlaky(503, 1, { login: "biospark33" });
    try {
      expect(await httpGitHubApi(s.base).authenticatedLogin(TOKEN)).toBe("biospark33");
      expect(s.hits()).toBe(2);
    } finally {
      s.server.stop(true);
    }
  });

  test("`POST /pulls` is NEVER retried — a retried write is a duplicate PR", async () => {
    // GitHub can land the write and then fail the response. A second POST would
    // open a second pull request, or 422 into a refusal for a run that already
    // has one.
    const s = serveFlaky(502, 1, { html_url: "https://example.test/pull/1", number: 1 });
    try {
      await expect(
        httpGitHubApi(s.base).createPr({
          owner: "o",
          repo: "r",
          base: "main",
          head: "qds/run-1",
          title: "t",
          body: "b",
          token: TOKEN,
        }),
      ).rejects.toThrow(/502/);
      expect(s.hits()).toBe(1);
    } finally {
      s.server.stop(true);
    }
  });

  test("the refusal comment is not retried either", async () => {
    const s = serveFlaky(500, 1, {});
    try {
      await expect(
        httpGitHubApi(s.base).commentIssue({ owner: "o", repo: "r", issueNumber: 42, body: "b", token: TOKEN }),
      ).rejects.toThrow(/500/);
      expect(s.hits()).toBe(1);
    } finally {
      s.server.stop(true);
    }
  });

  test("a 4xx is not retried on any method", async () => {
    const s = serveFlaky(404, 1, {});
    try {
      await expect(httpGitHubApi(s.base).authenticatedLogin(TOKEN)).rejects.toThrow(/404/);
      expect(s.hits()).toBe(1);
    } finally {
      s.server.stop(true);
    }
  });
});

describe("response body parsing", () => {
  test("a 200 whose body is not JSON refuses without echoing the body", async () => {
    // A proxy or SSO login page answering 200 in place of the API. The parse
    // used to throw a bare SyntaxError past every caller keyed on
    // GitHubApiError — and a SyntaxError's message embeds a PREFIX OF THE BODY
    // verbatim, so the refusal itself would carry whatever that page held.
    const body = "<html>login page ghp_secret</html>";
    const server = Bun.serve({
      port: 0,
      fetch: () => new Response(body, { status: 200, headers: { "content-type": "text/html" } }),
    });
    try {
      const call = httpGitHubApi(`http://localhost:${server.port}`).authenticatedLogin(TOKEN);
      await expect(call).rejects.toThrow(/unparseable JSON/);
      const err: Error = await call.then(
        () => new Error("expected a refusal, got a resolved login"),
        (e: unknown) => e as Error,
      );
      expect(err.name).toBe("GitHubApiError");
      expect(err.message).not.toContain("login page");
      expect(err.message).not.toContain("ghp_secret");
    } finally {
      server.stop(true);
    }
  });
});

describe("findOpenPr query", () => {
  test("filters on BOTH the head branch and the base branch", async () => {
    // A head-only query resolves an open PR on `qds/<run-id>` that targets some
    // other base, which the reuse and 422-adoption paths would then adopt.
    let seen = "";
    const server = Bun.serve({
      port: 0,
      fetch(req) {
        seen = new URL(req.url).search;
        return Response.json([{ html_url: "https://example.test/pull/3", number: 3 }]);
      },
    });
    try {
      const hit = await httpGitHubApi(`http://localhost:${server.port}`).findOpenPr({
        owner: "acme",
        repo: "widgets",
        headBranch: "qds/run-1",
        baseBranch: "main",
        token: TOKEN,
      });
      expect(hit).toEqual({ url: "https://example.test/pull/3", number: 3 });
      expect(seen).toContain(`head=${encodeURIComponent("acme:qds/run-1")}`);
      expect(seen).toContain("base=main");
      expect(seen).toContain("state=open");
    } finally {
      server.stop(true);
    }
  });
});

describe("listPrReviewComments", () => {
  test("maps id/body/user.login/user.type from `/pulls/{n}/comments?per_page=100`", async () => {
    let seen = "";
    const server = Bun.serve({
      port: 0,
      fetch(req) {
        const url = new URL(req.url);
        seen = `${url.pathname}${url.search}`;
        return Response.json([
          { id: 11, body: "first", user: { login: "review-bot[bot]", type: "Bot" } },
          { id: 12, body: "second", user: { login: "steve", type: "User" } },
        ]);
      },
    });
    try {
      const rows = await httpGitHubApi(`http://localhost:${server.port}`).listPrReviewComments({
        owner: "acme",
        repo: "widgets",
        prNumber: 7,
        token: TOKEN,
      });
      expect(rows).toEqual([
        { id: 11, body: "first", authorLogin: "review-bot[bot]", authorType: "Bot" },
        { id: 12, body: "second", authorLogin: "steve", authorType: "User" },
      ]);
      // The REVIEW-comment surface, not the issue-comment one, on a single page.
      expect(seen).toBe("/repos/acme/widgets/pulls/7/comments?per_page=100");
    } finally {
      server.stop(true);
    }
  });

  test("a malformed element refuses as GitHubApiError and never echoes the body", async () => {
    const server = Bun.serve({
      port: 0,
      fetch: () => Response.json([{ id: 11, body: "ghp_secret comment body", user: { login: "bot", type: 42 } }]),
    });
    try {
      const call = httpGitHubApi(`http://localhost:${server.port}`).listPrReviewComments({
        owner: "acme",
        repo: "widgets",
        prNumber: 7,
        token: TOKEN,
      });
      const err: Error = await call.then(
        () => new Error("expected a refusal, got a resolved list"),
        (e: unknown) => e as Error,
      );
      expect(err.name).toBe("GitHubApiError");
      expect(err.message).toContain("malformed");
      expect(err.message).not.toContain("ghp_secret");
    } finally {
      server.stop(true);
    }
  });

  test("a non-array body refuses as GitHubApiError", async () => {
    const server = Bun.serve({ port: 0, fetch: () => Response.json({ message: "not an array" }) });
    try {
      await expect(
        httpGitHubApi(`http://localhost:${server.port}`).listPrReviewComments({
          owner: "acme",
          repo: "widgets",
          prNumber: 7,
          token: TOKEN,
        }),
      ).rejects.toThrow(/non-array/);
    } finally {
      server.stop(true);
    }
  });
});

describe("getPullRequest", () => {
  test("maps number/state/head.ref/head.sha/merged from `/pulls/{n}`", async () => {
    let seen = "";
    const server = Bun.serve({
      port: 0,
      fetch(req) {
        seen = new URL(req.url).pathname;
        return Response.json({
          number: 7,
          state: "open",
          merged: false,
          head: { ref: "qds/run-1", sha: "a".repeat(40) },
        });
      },
    });
    try {
      const pr = await httpGitHubApi(`http://localhost:${server.port}`).getPullRequest({
        owner: "acme",
        repo: "widgets",
        prNumber: 7,
        token: TOKEN,
      });
      expect(pr).toEqual({ number: 7, state: "open", headRefName: "qds/run-1", headSha: "a".repeat(40), merged: false });
      expect(seen).toBe("/repos/acme/widgets/pulls/7");
    } finally {
      server.stop(true);
    }
  });

  test("a 404 is null, an answer rather than a failure", async () => {
    const server = Bun.serve({ port: 0, fetch: () => Response.json({ message: "Not Found" }, { status: 404 }) });
    try {
      const pr = await httpGitHubApi(`http://localhost:${server.port}`).getPullRequest({
        owner: "acme",
        repo: "widgets",
        prNumber: 999,
        token: TOKEN,
      });
      expect(pr).toBeNull();
    } finally {
      server.stop(true);
    }
  });

  test("a malformed body refuses as GitHubApiError rather than coercing", async () => {
    const server = Bun.serve({
      port: 0,
      fetch: () => Response.json({ number: 7, state: "open", merged: false, head: { ref: "qds/run-1" } }),
    });
    try {
      const call = httpGitHubApi(`http://localhost:${server.port}`).getPullRequest({
        owner: "acme",
        repo: "widgets",
        prNumber: 7,
        token: TOKEN,
      });
      const err: Error = await call.then(
        () => new Error("expected a refusal, got a resolved PR"),
        (e: unknown) => e as Error,
      );
      expect(err.name).toBe("GitHubApiError");
      expect(err.message).toContain("malformed");
    } finally {
      server.stop(true);
    }
  });

  test("a non-404 error still throws", async () => {
    const server = Bun.serve({ port: 0, fetch: () => new Response("upstream fell over", { status: 500 }) });
    try {
      await expect(
        httpGitHubApi(`http://localhost:${server.port}`).getPullRequest({
          owner: "acme",
          repo: "widgets",
          prNumber: 7,
          token: TOKEN,
        }),
      ).rejects.toThrow(/500/);
    } finally {
      server.stop(true);
    }
  });
});

describe("readHostToken", () => {
  test("a host without `security` falls through to the piped stdin instead of throwing", async () => {
    // `Bun.spawn` THROWS ENOENT rather than exiting non-zero, so an unguarded
    // call would reject on every non-macOS host.
    const mod = join(import.meta.dir, "../../src/pr/github.ts");
    const proc = Bun.spawn(
      [process.execPath, "-e", `import(${JSON.stringify(mod)}).then(async (m) => process.stdout.write(String(await m.readHostToken())))`],
      {
        stdin: new Blob(["piped-secret-value\n"]),
        stdout: "pipe",
        stderr: "pipe",
        // No `security` on the PATH — the shape of every non-macOS host.
        env: { ...process.env, PATH: "/nonexistent" },
      },
    );
    const [code, out, err] = await Promise.all([
      proc.exited,
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    expect(err).not.toContain("ENOENT");
    expect(code).toBe(0);
    expect(out.trim()).toBe("piped-secret-value");
  });
});
