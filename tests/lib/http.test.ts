/**
 * `src/lib/http.ts` — the one fetch contract (F063).
 *
 * A real `Bun.serve` on port 0 rather than a stubbed `fetch`: the properties
 * under test are retry timing, `retry-after` honouring and abort mapping, and
 * a stub proves none of them.
 */
import { describe, expect, test } from "bun:test";

import { httpRequest } from "../../src/lib/http.ts";

class CallerError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "CallerError";
    this.status = status;
  }
}

describe("httpRequest", () => {
  test("retries once on 429 honouring retry-after", async () => {
    let hits = 0;
    const seen: number[] = [];
    const server = Bun.serve({
      port: 0,
      fetch() {
        seen.push(Date.now());
        hits += 1;
        if (hits === 1) {
          return new Response("slow down", { status: 429, headers: { "retry-after": "0.05" } });
        }
        return Response.json({ ok: true });
      },
    });
    try {
      const { res, text } = await httpRequest(
        `http://127.0.0.1:${server.port}/x`,
        { method: "GET" },
        {
          timeoutMs: 5_000,
          maxAttempts: 2,
          retryOn: (r) => r.status >= 500 || r.status === 429,
          onHttpError: (r, body) => new CallerError(r.status, `failed: ${r.status} ${body ?? ""}`),
        },
      );
      expect(hits).toBe(2);
      expect(res.status).toBe(200);
      expect(JSON.parse(text)).toEqual({ ok: true });
      // The `retry-after: 0.05` was WAITED, not ignored.
      expect(seen[1]! - seen[0]!).toBeGreaterThanOrEqual(40);
    } finally {
      server.stop(true);
    }
  });

  test("a 4xx is never retried and surfaces the caller's error class", async () => {
    let hits = 0;
    const server = Bun.serve({
      port: 0,
      fetch() {
        hits += 1;
        return new Response("nope", { status: 422 });
      },
    });
    try {
      const p = httpRequest(
        `http://127.0.0.1:${server.port}/x`,
        { method: "GET" },
        {
          timeoutMs: 5_000,
          maxAttempts: 2,
          retryOn: (r) => r.status >= 500 || r.status === 429,
          onHttpError: (r, body) => new CallerError(r.status, `failed: ${r.status} ${body ?? ""}`),
        },
      );
      await expect(p).rejects.toThrow(CallerError);
      await p.catch((e) => expect((e as CallerError).status).toBe(422));
      expect(hits).toBe(1);
    } finally {
      server.stop(true);
    }
  });

  test("a timeout maps to the caller's error class", async () => {
    const server = Bun.serve({
      port: 0,
      async fetch() {
        await Bun.sleep(5_000);
        return new Response("late");
      },
    });
    try {
      const p = httpRequest(
        `http://127.0.0.1:${server.port}/x`,
        { method: "GET" },
        {
          timeoutMs: 30,
          onHttpError: (r) => new CallerError(r.status, "unused"),
          onTransportError: (_e, timedOut) => new CallerError(timedOut ? 408 : 502, "timed out after 30ms"),
        },
      );
      await expect(p).rejects.toThrow("timed out after 30ms");
      await p.catch((e) => expect((e as CallerError).status).toBe(408));
    } finally {
      server.stop(true);
    }
  });

  test("a body that stalls after the headers still hits the deadline", async () => {
    // Headers, then a stream that never enqueues: the failure mode a
    // `clearTimeout` on header arrival would leave unbounded forever.
    const server = Bun.serve({
      port: 0,
      fetch: () => new Response(new ReadableStream({ start() {} }), { status: 200 }),
    });
    try {
      const started = Date.now();
      const p = httpRequest(
        `http://127.0.0.1:${server.port}/x`,
        { method: "GET" },
        {
          timeoutMs: 50,
          onTransportError: (_e, timedOut) => new CallerError(timedOut ? 408 : 502, "body stalled"),
        },
      );
      await expect(p).rejects.toThrow("body stalled");
      await p.catch((e) => expect((e as CallerError).status).toBe(408));
      expect(Date.now() - started).toBeLessThan(2_000);
    } finally {
      server.stop(true);
    }
  });

  test("without onHttpError a non-2xx is RETURNED, never thrown", async () => {
    const server = Bun.serve({ port: 0, fetch: () => new Response("gone", { status: 404 }) });
    try {
      const { res, text } = await httpRequest(`http://127.0.0.1:${server.port}/x`, { method: "POST" }, { timeoutMs: 5_000 });
      expect(res.status).toBe(404);
      expect(text).toBe("gone");
    } finally {
      server.stop(true);
    }
  });

  test("a body is JSON-encoded and content-type set; caller headers survive", async () => {
    let seen: { ct: string | null; auth: string | null; body: string } | undefined;
    const server = Bun.serve({
      port: 0,
      async fetch(req) {
        seen = {
          ct: req.headers.get("content-type"),
          auth: req.headers.get("authorization"),
          body: await req.text(),
        };
        return Response.json({});
      },
    });
    try {
      await httpRequest(
        `http://127.0.0.1:${server.port}/x`,
        { method: "POST", body: { a: 1 } },
        { timeoutMs: 5_000, headers: { authorization: "Bearer t" } },
      );
      expect(seen?.ct).toBe("application/json");
      expect(seen?.auth).toBe("Bearer t");
      expect(seen?.body).toBe('{"a":1}');
    } finally {
      server.stop(true);
    }
  });
});
