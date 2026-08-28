/**
 * F002: SwarmClaw binds loopback by default and, when SWARMCLAW_AUTH_TOKEN is
 * set, checks the bearer credential ABOVE the 413 payload guard — an
 * unauthenticated caller must not be able to distinguish "too big" from
 * "unauthorized", nor spend the server's body-drain budget.
 */
import { afterEach, expect, test } from "bun:test";
import { createServer, MAX_BODY_BYTES } from "../../src/swarmclaw/index.ts";

function saveEnv(key: string): () => void {
  const prev = process.env[key];
  return () => {
    if (prev === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = prev;
    }
  };
}

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

function serve(): { url: string; hostname: string } {
  const srv = createServer(0);
  cleanups.push(() => srv.stop());
  return { url: `http://${srv.hostname}:${srv.port}`, hostname: srv.hostname };
}

const OVERSIZE = "x".repeat(MAX_BODY_BYTES + 1024);

test("serve binds loopback by default", () => {
  cleanups.push(saveEnv("SWARMCLAW_BIND"));
  // biome-ignore lint/performance/noDelete: unsetting env vars requires delete
  delete process.env.SWARMCLAW_BIND;
  expect(serve().hostname).toBe("127.0.0.1");
});

test("SWARMCLAW_BIND is the documented waiver for the loopback bind", () => {
  cleanups.push(saveEnv("SWARMCLAW_BIND"));
  // "localhost" rather than a routable address: the point is that the env var
  // is honoured, and a test must not open a listener off the loopback.
  process.env.SWARMCLAW_BIND = "localhost";
  expect(serve().hostname).toBe("localhost");
});

test("a request without the bearer token is 401 before the 413 guard", async () => {
  cleanups.push(saveEnv("SWARMCLAW_AUTH_TOKEN"));
  process.env.SWARMCLAW_AUTH_TOKEN = "t0ken";
  const { url } = serve();
  const res = await fetch(`${url}/api/mcp-servers`, { method: "POST", body: OVERSIZE });
  expect(res.status).toBe(401);
});

test("a wrong token of the same length is 401 (timing-safe compare, not a length check)", async () => {
  cleanups.push(saveEnv("SWARMCLAW_AUTH_TOKEN"));
  process.env.SWARMCLAW_AUTH_TOKEN = "t0ken";
  const { url } = serve();
  const res = await fetch(`${url}/api/agents`, {
    method: "POST",
    headers: { authorization: "Bearer wrong" },
    body: "{}",
  });
  expect(res.status).toBe(401);
});

test("the correct token reaches the route table (and the 413 guard below it)", async () => {
  cleanups.push(saveEnv("SWARMCLAW_AUTH_TOKEN"));
  process.env.SWARMCLAW_AUTH_TOKEN = "t0ken";
  const { url } = serve();
  const auth = { authorization: "Bearer t0ken" };
  expect((await fetch(`${url}/api/mcp-servers`, { method: "POST", headers: auth, body: OVERSIZE })).status).toBe(413);
  expect((await fetch(`${url}/nope`, { method: "GET", headers: auth })).status).toBe(404);
});

test("with no token configured the surface is unauthenticated as before", async () => {
  cleanups.push(saveEnv("SWARMCLAW_AUTH_TOKEN"));
  // biome-ignore lint/performance/noDelete: unsetting env vars requires delete
  delete process.env.SWARMCLAW_AUTH_TOKEN;
  const { url } = serve();
  expect((await fetch(`${url}/nope`, { method: "GET" })).status).toBe(404);
});
