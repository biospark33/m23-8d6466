/**
 * F002: SwarmClaw binds loopback by default and, when SWARMCLAW_AUTH_TOKEN is
 * set, checks the bearer credential ABOVE the 413 payload guard — an
 * unauthenticated caller must not be able to distinguish "too big" from
 * "unauthorized", nor spend the server's body-drain budget.
 */
import { afterEach, expect, test } from "bun:test";
import { connect } from "node:net";
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

function serve(): { url: string; hostname: string; port: number } {
  const srv = createServer(0);
  cleanups.push(() => srv.stop());
  return { url: `http://${srv.hostname}:${srv.port}`, hostname: srv.hostname, port: srv.port };
}

/**
 * Send a raw request line with NO Host header. fetch() always sets one, so a
 * socket is the only way to reach the pre-parse path.
 */
function rawRequest(port: number, request: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const sock = connect(port, "127.0.0.1", () => sock.write(request));
    let out = "";
    sock.setTimeout(5000, () => sock.destroy(new Error("timeout")));
    sock.on("data", (d) => {
      out += d.toString();
      // These responses are bodyless, so the header terminator is the whole
      // response — don't wait on the peer to close the socket.
      if (out.includes("\r\n\r\n")) {
        sock.destroy();
        resolve(out);
      }
    });
    sock.on("close", () => resolve(out));
    sock.on("error", reject);
  });
}

const OVERSIZE = "x".repeat(MAX_BODY_BYTES + 1024);

test("serve binds loopback by default", () => {
  cleanups.push(saveEnv("SWARMCLAW_BIND"));
  // biome-ignore lint/performance/noDelete: unsetting env vars requires delete
  delete process.env.SWARMCLAW_BIND;
  expect(serve().hostname).toBe("127.0.0.1");
});

test("an empty SWARMCLAW_BIND does not fail open to every interface", () => {
  cleanups.push(saveEnv("SWARMCLAW_BIND"));
  // `docker -e SWARMCLAW_BIND=`, a blank shell export, or the blank-value
  // style .env.example itself uses. `??` would pass "" straight to Bun.serve,
  // which binds ALL interfaces while reporting hostname "localhost".
  process.env.SWARMCLAW_BIND = "";
  expect(serve().hostname).toBe("127.0.0.1");
});

test("a whitespace-only SWARMCLAW_BIND does not fail open either", () => {
  cleanups.push(saveEnv("SWARMCLAW_BIND"));
  process.env.SWARMCLAW_BIND = "   ";
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
  // biome-ignore lint/performance/noDelete: unsetting env vars requires delete
  delete process.env.SWARMCLAW_AUTH_TOKEN;
  const { url } = serve();
  expect((await fetch(`${url}/nope`, { method: "GET" })).status).toBe(404);
});

// Bun builds req.url from the Host header. Each of these leaves it an
// unparseable target that `new URL` throws on. Before the fix that throw
// escaped the try/catch AND the credential gate, and Bun answered with a 67KB
// default error page carrying the source excerpt, stack and absolute paths.
// (An absent Host on HTTP/1.1 is the one case Bun itself refuses, with a
// bodyless 400 before `fetch` runs — asserted here so a Bun upgrade that stops
// doing that is caught.)
test.each([
  ["absent (HTTP/1.1)", "POST /api/agents HTTP/1.1\r\n\r\n"],
  ["empty", "POST /api/agents HTTP/1.1\r\nHost:\r\n\r\n"],
  ["whitespace-only", "POST /api/agents HTTP/1.1\r\nHost: \r\n\r\n"],
  ["absent (HTTP/1.0)", "POST /api/agents HTTP/1.0\r\n\r\n"],
  ["malformed", "POST /api/agents HTTP/1.1\r\nHost: a b c\r\n\r\n"],
])("a %s Host header is refused bodyless, with no stack", async (_label, request) => {
  cleanups.push(saveEnv("SWARMCLAW_AUTH_TOKEN"));
  // biome-ignore lint/performance/noDelete: unsetting env vars requires delete
  delete process.env.SWARMCLAW_AUTH_TOKEN;
  const { port } = serve();
  const res = await rawRequest(port, request);
  expect(res).toMatch(/^HTTP\/1\.1 40[03] /);
  expect(res).not.toContain("<html");
  expect(res).not.toContain("src/swarmclaw/index.ts");
  // Bodyless: headers only, nothing after the blank line.
  expect(res.split("\r\n\r\n")[1] ?? "").toBe("");
});

test("the 401 names the scheme in WWW-Authenticate", async () => {
  cleanups.push(saveEnv("SWARMCLAW_AUTH_TOKEN"));
  process.env.SWARMCLAW_AUTH_TOKEN = "t0ken";
  const { url } = serve();
  const res = await fetch(`${url}/api/agents`, { method: "POST", body: "{}" });
  expect(res.status).toBe(401);
  expect(res.headers.get("www-authenticate")).toBe("Bearer");
});

// ---------------------------------------------------------------------------
// Startup refusals. A blank credential and an unpaired non-loopback bind are
// silent fail-opens: the process comes up looking configured and is not. Both
// are refused at construction, before the listener exists.
// ---------------------------------------------------------------------------

test.each([
  ["blank", ""],
  ["whitespace-only", "   "],
])("a %s SWARMCLAW_AUTH_TOKEN is a startup refusal, not an unauthenticated boot", (_label, value) => {
  cleanups.push(saveEnv("SWARMCLAW_AUTH_TOKEN"));
  process.env.SWARMCLAW_AUTH_TOKEN = value;
  expect(() => createServer(0)).toThrow(/SWARMCLAW_AUTH_TOKEN is set but blank/);
});

test("a non-loopback SWARMCLAW_BIND without a token is a startup refusal", () => {
  cleanups.push(saveEnv("SWARMCLAW_BIND"), saveEnv("SWARMCLAW_AUTH_TOKEN"));
  process.env.SWARMCLAW_BIND = "0.0.0.0";
  // biome-ignore lint/performance/noDelete: unsetting env vars requires delete
  delete process.env.SWARMCLAW_AUTH_TOKEN;
  expect(() => createServer(0)).toThrow(/SWARMCLAW_AUTH_TOKEN is required/);
});

test("a non-loopback SWARMCLAW_BIND paired with a token starts", () => {
  cleanups.push(saveEnv("SWARMCLAW_BIND"), saveEnv("SWARMCLAW_AUTH_TOKEN"));
  // CodeRabbit (PR #148) suggested binding a non-canonical loopback address
  // (e.g. 127.0.0.2) here instead of 0.0.0.0, to avoid opening a listener on
  // every interface during the test. Verified against this repo's actual
  // sandboxed test environment: only 127.0.0.1/::1/localhost and true
  // wildcard binds (0.0.0.0, ::) succeed — 127.0.0.2/.3 fail with
  // EADDRINUSE, so that substitution isn't viable here. The listener this
  // test opens is already torn down by the shared `afterEach` cleanup below
  // before any other test runs, which bounds the real exposure.
  process.env.SWARMCLAW_BIND = "0.0.0.0";
  process.env.SWARMCLAW_AUTH_TOKEN = "t0ken";
  expect(serve().hostname).toBe("0.0.0.0");
});

test.each(["127.0.0.1", "::1", "localhost"])(
  "loopback bind %s needs no token",
  (bind) => {
    cleanups.push(saveEnv("SWARMCLAW_BIND"), saveEnv("SWARMCLAW_AUTH_TOKEN"));
    process.env.SWARMCLAW_BIND = bind;
    // biome-ignore lint/performance/noDelete: unsetting env vars requires delete
    delete process.env.SWARMCLAW_AUTH_TOKEN;
    expect(() => serve()).not.toThrow();
  },
);

// ---------------------------------------------------------------------------
// Browser-origin CSRF. The loopback listener is reachable from any page the
// user has open; a simple no-cors POST needs no preflight, and safeJson never
// checks content-type. No legitimate caller here is a browser, so an Origin
// header at all is the signal.
// ---------------------------------------------------------------------------

test("a request carrying an Origin header is refused, even with a valid token", async () => {
  cleanups.push(saveEnv("SWARMCLAW_AUTH_TOKEN"));
  process.env.SWARMCLAW_AUTH_TOKEN = "t0ken";
  const { url } = serve();
  const res = await fetch(`${url}/api/mcp-servers`, {
    method: "POST",
    headers: { origin: "http://evil.example", authorization: "Bearer t0ken" },
    body: "{}",
  });
  expect(res.status).toBe(403);
  expect(await res.text()).toBe("");
});

test("a request with no Origin header is unaffected", async () => {
  cleanups.push(saveEnv("SWARMCLAW_AUTH_TOKEN"));
  // biome-ignore lint/performance/noDelete: unsetting env vars requires delete
  delete process.env.SWARMCLAW_AUTH_TOKEN;
  const { url } = serve();
  expect((await fetch(`${url}/nope`, { method: "GET" })).status).toBe(404);
});
