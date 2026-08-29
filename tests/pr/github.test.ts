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
