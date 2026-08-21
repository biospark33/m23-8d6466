/**
 * DF4.1 auth gate tests (AC1, AC5, INV-1/2/3/5, Observability Contract).
 *
 * In-process Bun.serve on 127.0.0.1:0. fetch() sends the correct Host header
 * by default; forged Host headers need a raw socket (Host is the one header
 * fetch will not reliably carry).
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { connect } from "node:net";
import * as fs from "node:fs";
import * as path from "node:path";
import { seedTrace, FIXTURE_REQUEST_ID } from "./fixtures/trace-fixture.ts";
import { startVisualizer } from "../server/index.ts";
import {
  assertNeverPublic,
  validatePort,
  validateToken,
  VizError,
} from "../server/auth.ts";

const TOKEN = "0123456789abcdef0123456789abcdef"; // 32 bytes
const WRONG_SAME_LENGTH = "ffffffffffffffffffffffffffffffff"; // 32 bytes, wrong

let seeded: ReturnType<typeof seedTrace>;
let handle: ReturnType<typeof startVisualizer>;
let port: number;

beforeAll(() => {
  seeded = seedTrace();
  handle = startVisualizer({ dbPath: seeded.dbPath, token: TOKEN, port: 0 });
  port = handle.server.port ?? 0;
});

afterAll(async () => {
  await handle.server.stop(true);
  handle.db.close();
  seeded.cleanup();
});

const base = () => `http://127.0.0.1:${port}`;
const bearer = (token: string = TOKEN) => ({ authorization: `Bearer ${token}` });
const basic = (token: string = TOKEN) => ({
  authorization: `Basic ${Buffer.from(`:${token}`).toString("base64")}`,
});

/** Raw HTTP/1.1 over a socket — the only way to forge a Host header. */
function rawHttp(
  targetPort: number,
  lines: string[],
): Promise<{ status: number; headers: string; body: string }> {
  return new Promise((resolve, reject) => {
    const sock = connect(targetPort, "127.0.0.1", () => {
      sock.write(`${lines.join("\r\n")}\r\nConnection: close\r\n\r\n`);
    });
    sock.setEncoding("utf8");
    let data = "";
    sock.on("data", (chunk: string) => {
      data += chunk;
    });
    sock.on("error", reject);
    sock.on("close", () => {
      const idx = data.indexOf("\r\n\r\n");
      if (idx === -1) {
        reject(new Error(`malformed response: ${JSON.stringify(data)}`));
        return;
      }
      const head = data.slice(0, idx);
      resolve({
        status: Number(head.split(" ")[1]),
        headers: head,
        body: data.slice(idx + 4),
      });
    });
  });
}

/**
 * A header-less response would make a `for (key of headers)` loop assert
 * nothing at all, so the named keys are checked explicitly first — that half
 * runs even on an empty Headers — and the sweep then catches any
 * Access-Control-Allow-* spelling not on the list.
 */
function expectNoAca(headers: Headers): void {
  for (const key of [
    "access-control-allow-origin",
    "access-control-allow-credentials",
    "access-control-allow-methods",
    "access-control-allow-headers",
  ]) {
    expect(headers.get(key)).toBe(null);
  }
  for (const key of headers.keys()) {
    expect(key.toLowerCase().startsWith("access-control-allow")).toBe(false);
  }
}

/**
 * AC5 detector, shared by the src/providers walk and its positive control:
 * the resolved QDS_VIZ_PORT (or its default literal) can only enter a file
 * through one of these tokens. File granularity, not call-site granularity.
 */
const VIZ_PORT_TOKENS = [/QDS_VIZ_PORT/i, /viz[-_]?port/i, /\b4600\b/];
const carriesVizPortOperand = (src: string): boolean =>
  VIZ_PORT_TOKENS.some((re) => re.test(src));
const isUnguardedVizPortUse = (src: string): boolean =>
  carriesVizPortOperand(src) && !src.includes("assertNeverPublic");

describe("startup validation (INV-1/INV-5, AC5)", () => {
  test("validateToken refuses an unset token with a named error", () => {
    try {
      validateToken({});
      throw new Error("expected validateToken to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(VizError);
      expect((error as VizError).name).toBe("VizError");
      expect((error as VizError).code).toBe("VIZ_TOKEN_MISSING");
    }
  });

  test("validateToken refuses a short token, accepts a 32-byte one", () => {
    expect(() => validateToken({ QDS_VIZ_TOKEN: "x".repeat(31) })).toThrow(VizError);
    expect(validateToken({ QDS_VIZ_TOKEN: TOKEN })).toBe(TOKEN);
  });

  test("validatePort defaults to 4600 and enforces 1024-65535", () => {
    expect(validatePort({})).toBe(4600);
    expect(validatePort({ QDS_VIZ_PORT: "4601" })).toBe(4601);
    for (const bad of ["0", "1023", "65536", "abc", "4600.5", "-1"]) {
      try {
        validatePort({ QDS_VIZ_PORT: bad });
        throw new Error(`expected port "${bad}" to be refused`);
      } catch (error) {
        expect(error).toBeInstanceOf(VizError);
        expect((error as VizError).code).toBe("VIZ_PORT_INVALID");
      }
    }
  });

  test("startVisualizer refuses a short token — no ungated in-process path", () => {
    expect(() =>
      startVisualizer({ dbPath: seeded.dbPath, token: "short" }),
    ).toThrow(VizError);
  });

  test("startVisualizer refuses a privileged port", () => {
    expect(() =>
      startVisualizer({ dbPath: seeded.dbPath, token: TOKEN, port: 80 }),
    ).toThrow(VizError);
  });

  test("AC1(b)/INV-5: the listener binds 127.0.0.1, never a wildcard", () => {
    // Every request in this suite reaches the server identically on a
    // 0.0.0.0 bind, so the bind itself has to be asserted on the server
    // object. Bun reports the requested hostname verbatim; dropping the
    // `hostname:` key from startVisualizer makes it "localhost" here.
    expect(handle.server.hostname).toBe("127.0.0.1");
    expect(handle.server.url.hostname).toBe("127.0.0.1");
  });
});

describe("assertNeverPublic (AC5)", () => {
  test("signature: name + exactly one numeric parameter", () => {
    expect(typeof assertNeverPublic).toBe("function");
    expect(assertNeverPublic.name).toBe("assertNeverPublic");
    expect(assertNeverPublic.length).toBe(1);
  });

  test("throws a named error on the visualizer port", () => {
    try {
      assertNeverPublic(4600);
      throw new Error("expected assertNeverPublic to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(VizError);
      expect((error as VizError).name).toBe("VizError");
    }
  });

  test("positive control: the viz-port detector fires, and demands a guard when it does", () => {
    // Without this, the walk below is vacuous: zero files under src/providers
    // currently match, so a broken regex or a mis-resolved directory would be
    // invisible. These pin the predicate itself.
    expect(carriesVizPortOperand("const p = process.env.QDS_VIZ_PORT;")).toBe(true);
    expect(carriesVizPortOperand("const vizPort = resolvePort();")).toBe(true);
    expect(carriesVizPortOperand("const viz_port = resolvePort();")).toBe(true);
    expect(carriesVizPortOperand("box.sharePort(4600);")).toBe(true);
    expect(carriesVizPortOperand("box.sharePort(3000);")).toBe(false);

    expect(isUnguardedVizPortUse("box.sharePort(4600);")).toBe(true);
    expect(
      isUnguardedVizPortUse("assertNeverPublic(4600);\nbox.sharePort(4600);"),
    ).toBe(false);
    expect(isUnguardedVizPortUse("box.sharePort(3000);")).toBe(false);
  });

  test("port-scoped static assert: no viz-port operand reaches src/providers unguarded", () => {
    // DF2.2 legitimately ships share-port/set-public shapes under src/providers,
    // so the shapes themselves are NOT the defect. The assert is over the viz
    // port OPERAND's data flow, at token granularity: the resolved QDS_VIZ_PORT
    // (or its default literal) can only enter a providers file through these
    // tokens, and a file carrying one must guard it with assertNeverPublic.
    const providersDir = path.resolve(import.meta.dir, "../../src/providers");
    const files: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.name.endsWith(".ts")) files.push(full);
      }
    };
    walk(providersDir);
    expect(files.length).toBeGreaterThan(0);

    for (const file of files) {
      // The operand reached src/providers — only a same-file assertNeverPublic
      // guard can keep this green; any unguarded use goes red.
      expect(
        isUnguardedVizPortUse(fs.readFileSync(file, "utf8")),
        `${file} carries a visualizer-port operand without an assertNeverPublic guard`,
      ).toBe(false);
    }
  });
});

describe("401 gate on every route (AC1c, INV-1)", () => {
  const routes = [
    "/api/health",
    "/api/sessions",
    `/api/sessions/${FIXTURE_REQUEST_ID}`,
    `/api/sessions/${FIXTURE_REQUEST_ID}/events`,
    `/api/sessions/${FIXTURE_REQUEST_ID}/envelopes`,
    `/api/sessions/${FIXTURE_REQUEST_ID}/gates`,
    `/api/sessions/${FIXTURE_REQUEST_ID}/prompts`,
    "/",
  ];

  for (const route of routes) {
    test(`no credential → 401 empty body: ${route}`, async () => {
      const res = await fetch(`${base()}${route}`);
      expect(res.status).toBe(401);
      expect(await res.text()).toBe("");
      expectNoAca(res.headers);
    });

    test(`malformed credential → 401 empty body: ${route}`, async () => {
      const res = await fetch(`${base()}${route}`, {
        headers: { authorization: "Bearer ???not-a-token" },
      });
      expect(res.status).toBe(401);
      expect(await res.text()).toBe("");
    });

    test(`wrong-but-same-length credential → 401 empty body: ${route}`, async () => {
      const res = await fetch(`${base()}${route}`, { headers: bearer(WRONG_SAME_LENGTH) });
      expect(res.status).toBe(401);
      expect(await res.text()).toBe("");
    });
  }

  test("POST archive with no credential → 401 empty body", async () => {
    const res = await fetch(`${base()}/api/sessions/${FIXTURE_REQUEST_ID}/archive`, {
      method: "POST",
    });
    expect(res.status).toBe(401);
    expect(await res.text()).toBe("");
  });

  test("WWW-Authenticate appears on the static 401 only", async () => {
    const staticRes = await fetch(`${base()}/`);
    expect(staticRes.status).toBe(401);
    expect(staticRes.headers.get("www-authenticate")).toBe('Basic realm="qds-viz"');

    const jsonRes = await fetch(`${base()}/api/health`);
    expect(jsonRes.status).toBe(401);
    expect(jsonRes.headers.get("www-authenticate")).toBe(null);

    const gatesRes = await fetch(`${base()}/api/sessions/${FIXTURE_REQUEST_ID}/gates`);
    expect(gatesRes.status).toBe(401);
    expect(gatesRes.headers.get("www-authenticate")).toBe(null);
  });

  test("both accepted credential forms succeed when valid", async () => {
    expect((await fetch(`${base()}/api/health`, { headers: bearer() })).status).toBe(200);
    expect((await fetch(`${base()}/api/health`, { headers: basic() })).status).toBe(200);
  });

  test("Basic with the wrong password (same length) → 401", async () => {
    const res = await fetch(`${base()}/api/health`, { headers: basic(WRONG_SAME_LENGTH) });
    expect(res.status).toBe(401);
    expect(await res.text()).toBe("");
  });

  test("OPTIONS is never answered affirmatively (no CORS), 200 and 401", async () => {
    const authed = await fetch(`${base()}/api/health`, {
      method: "OPTIONS",
      headers: bearer(),
    });
    expect(Math.floor(authed.status / 100)).not.toBe(2);
    expectNoAca(authed.headers);

    const anon = await fetch(`${base()}/api/health`, { method: "OPTIONS" });
    expect(anon.status).toBe(401);
    expectNoAca(anon.headers);
  });
});

describe("Host check runs before the credential check (DNS rebinding)", () => {
  test("foreign Host → 403 empty body, even with no credential at all", async () => {
    const res = await rawHttp(port, ["GET /api/health HTTP/1.1", "Host: evil.example"]);
    expect(res.status).toBe(403);
    expect(res.body).toBe("");
  });

  test("foreign Host with a VALID credential is still 403 — order is host first", async () => {
    const res = await rawHttp(port, [
      "GET /api/health HTTP/1.1",
      "Host: evil.example",
      `Authorization: Bearer ${TOKEN}`,
    ]);
    expect(res.status).toBe(403);
    expect(res.body).toBe("");
  });

  test("Host: localhost:<port> is an allowed loopback host", async () => {
    const res = await rawHttp(port, [
      "GET /api/health HTTP/1.1",
      `Host: localhost:${port}`,
      `Authorization: Bearer ${TOKEN}`,
    ]);
    expect(res.status).toBe(200);
  });

  test("foreign Host on the static branch → 403 too", async () => {
    const res = await rawHttp(port, ["GET / HTTP/1.1", "Host: evil.example"]);
    expect(res.status).toBe(403);
  });
});

describe("CSRF decision table on POST archive (AC1)", () => {
  const archiveUrl = () => `${base()}/api/sessions/${FIXTURE_REQUEST_ID}/archive`;
  const post = (headers: Record<string, string>) =>
    fetch(archiveUrl(), { method: "POST", headers, body: JSON.stringify({ archived: false }) });

  test("row 2: foreign Origin → 403 before credential validation (valid Bearer)", async () => {
    const res = await post({ origin: "http://evil.example", ...bearer() });
    expect(res.status).toBe(403);
    expect(await res.text()).toBe("");
  });

  test("row 4: no Origin + foreign Referer → 403 before credential validation", async () => {
    const res = await post({ referer: "http://evil.example/x", ...bearer() });
    expect(res.status).toBe(403);
    expect(await res.text()).toBe("");
  });

  test("row 5: neither header + Bearer → proceeds and succeeds", async () => {
    const res = await post(bearer());
    expect(res.status).toBe(200);
    const body = (await res.json()) as { request_id: string; archived: boolean };
    expect(body.request_id).toBe(FIXTURE_REQUEST_ID);
    expect(body.archived).toBe(false);
  });

  test("row 6: neither header + Basic → 403 even with valid credentials", async () => {
    const res = await post(basic());
    expect(res.status).toBe(403);
    expect(await res.text()).toBe("");
  });

  test("row 1: same-origin Origin → proceeds to the credential check (Basic ok)", async () => {
    const res = await post({ origin: `http://127.0.0.1:${port}`, ...basic() });
    expect(res.status).toBe(200);
  });

  test("row 3: same-origin Referer with a path → still matches by components", async () => {
    const res = await post({
      referer: `http://localhost:${port}/#/session/${FIXTURE_REQUEST_ID}`,
      ...bearer(),
    });
    expect(res.status).toBe(200);
  });

  test("unparsable Origin (\"null\") → 403 before credential validation", async () => {
    const res = await post({ origin: "null", ...bearer() });
    expect(res.status).toBe(403);
  });

  test("foreign Origin on a GET route is ignored — CSRF gates the write route only", async () => {
    const res = await fetch(`${base()}/api/health`, {
      headers: { origin: "http://evil.example", ...bearer() },
    });
    expect(res.status).toBe(200);
  });
});

describe("redaction: the token is never logged (Observability Contract)", () => {
  test("no captured log line during a 401 or a 200 contains the token or a prefix", async () => {
    const captured: string[] = [];
    const origLog = console.log;
    const origError = console.error;
    const sink = (...args: unknown[]) => {
      captured.push(args.map((a) => String(a)).join(" "));
    };
    console.log = sink as typeof console.log;
    console.error = sink as typeof console.error;
    try {
      const unauthorized = await fetch(`${base()}/api/health`, {
        headers: bearer(WRONG_SAME_LENGTH),
      });
      expect(unauthorized.status).toBe(401);
      const ok = await fetch(`${base()}/api/health`, { headers: bearer() });
      expect(ok.status).toBe(200);
    } finally {
      console.log = origLog;
      console.error = origError;
    }

    // The request log must exist for both outcomes — otherwise this test
    // would pass vacuously on a server that logs nothing.
    expect(captured.length).toBeGreaterThanOrEqual(2);
    for (const line of captured) {
      expect(line.includes(TOKEN)).toBe(false);
      expect(line.includes(TOKEN.slice(0, 16))).toBe(false);
      expect(line.includes(TOKEN.slice(0, 8))).toBe(false);
    }
  });
});

describe("credential compare handles wrong LENGTHS (INV-1)", () => {
  // A timingSafeEqual over the raw strings throws on unequal lengths — which
  // would turn a wrong-length credential into a 500 (leaking that the length
  // was wrong) instead of the 401 it is owed. The sha256-both-sides
  // normalisation is what keeps these at 401. This pins that crash path; it
  // does not measure timing.
  const cases: Array<[string, string]> = [
    ["short Bearer", "abc"],
    ["long Bearer", "f".repeat(64)],
    ["Bearer one byte short", TOKEN.slice(0, 31)],
    ["Bearer one byte long", `${TOKEN}f`],
  ];
  for (const [label, credential] of cases) {
    test(`${label} → 401 empty body, never 500`, async () => {
      const res = await fetch(`${base()}/api/health`, { headers: bearer(credential) });
      expect(res.status).toBe(401);
      expect(await res.text()).toBe("");
    });
  }

  for (const [label, credential] of cases) {
    test(`Basic form, ${label} → 401 empty body, never 500`, async () => {
      const res = await fetch(`${base()}/api/health`, { headers: basic(credential) });
      expect(res.status).toBe(401);
      expect(await res.text()).toBe("");
    });
  }

  test("an empty Bearer value → 401 empty body", async () => {
    const res = await fetch(`${base()}/api/health`, {
      headers: { authorization: "Bearer " },
    });
    expect(res.status).toBe(401);
    expect(await res.text()).toBe("");
  });
});

describe("no CORS header on SUCCESSFUL responses either (INV-1)", () => {
  // INV-1's threat rides on 200s: a permissive header lets a hostile origin
  // read the trace with a cached Basic credential. Asserting it only on 401s
  // leaves `json()` free to grow an Access-Control-Allow-Origin.
  test("200 on a JSON read route carries no Access-Control-Allow-*", async () => {
    const res = await fetch(`${base()}/api/health`, { headers: bearer() });
    expect(res.status).toBe(200);
    expectNoAca(res.headers);
  });

  test("200 on the write route carries no Access-Control-Allow-*", async () => {
    const res = await fetch(`${base()}/api/sessions/${FIXTURE_REQUEST_ID}/archive`, {
      method: "POST",
      headers: bearer(),
      body: JSON.stringify({ archived: false }),
    });
    expect(res.status).toBe(200);
    expectNoAca(res.headers);
  });

  test("404 and 400 error responses carry no Access-Control-Allow-*", async () => {
    const missing = await fetch(`${base()}/api/nope`, { headers: bearer() });
    expect(missing.status).toBe(404);
    expectNoAca(missing.headers);

    const bad = await fetch(
      `${base()}/api/sessions/${FIXTURE_REQUEST_ID}/events?after=-1`,
      { headers: bearer() },
    );
    expect(bad.status).toBe(400);
    expectNoAca(bad.headers);
  });
});

describe("API/static classification of the 401 challenge (A12)", () => {
  test("GET /api exactly is an API path — bare 401, no WWW-Authenticate", async () => {
    const res = await fetch(`${base()}/api`);
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toBe(null);
    expect(await res.text()).toBe("");
  });

  test("a non-/api path still gets the Basic challenge", async () => {
    const res = await fetch(`${base()}/x`);
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toBe('Basic realm="qds-viz"');
  });

  test("/apifoo is NOT an API path — prefix match is on /api/ or /api exactly", async () => {
    const res = await fetch(`${base()}/apifoo`);
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toBe('Basic realm="qds-viz"');
  });
});

describe("Host gate parser edges (AC1c, DNS rebinding)", () => {
  const authed = (host: string | null) =>
    rawHttp(port, [
      "GET /api/health HTTP/1.1",
      ...(host === null ? [] : [`Host: ${host}`]),
      `Authorization: Bearer ${TOKEN}`,
    ]);

  test("no Host header at all → 403 empty body", async () => {
    const res = await rawHttp(port, [
      "GET /api/health HTTP/1.0",
      `Authorization: Bearer ${TOKEN}`,
    ]);
    expect(res.status).toBe(403);
    expect(res.body).toBe("");
  });

  test("Host with no port → 403 (the port is part of the identity)", async () => {
    const res = await authed("127.0.0.1");
    expect(res.status).toBe(403);
    expect(res.body).toBe("");
  });

  test("Host: [::1]:<port> is not an allowed spelling → 403", async () => {
    const res = await authed(`[::1]:${port}`);
    expect(res.status).toBe(403);
    expect(res.body).toBe("");
  });

  test("right hostname, wrong port → 403", async () => {
    const res = await authed(`127.0.0.1:${port === 65535 ? 1024 : port + 1}`);
    expect(res.status).toBe(403);
    expect(res.body).toBe("");
  });

  test("Host is case-insensitive on the hostname → LOCALHOST:<port> is allowed", async () => {
    const res = await authed(`LOCALHOST:${port}`);
    expect(res.status).toBe(200);
  });

  test("a hostname that merely ends in localhost → 403 (no suffix confusion)", async () => {
    const res = await authed(`notlocalhost:${port}`);
    expect(res.status).toBe(403);
    expect(res.body).toBe("");
  });

  test("empty Host value → 403", async () => {
    const res = await authed("");
    expect(res.status).toBe(403);
    expect(res.body).toBe("");
  });
});

describe("CSRF origin parser edges (AC1)", () => {
  const post = (headers: Record<string, string>) =>
    fetch(`${base()}/api/sessions/${FIXTURE_REQUEST_ID}/archive`, {
      method: "POST",
      headers,
      body: JSON.stringify({ archived: false }),
    });

  test("https://127.0.0.1:<port> Origin → 403 (scheme is compared, not just host)", async () => {
    const res = await post({ origin: `https://127.0.0.1:${port}`, ...bearer() });
    expect(res.status).toBe(403);
    expect(await res.text()).toBe("");
  });

  test("suffix-confusion Origin 127.0.0.1.evil.com → 403", async () => {
    const res = await post({ origin: `http://127.0.0.1.evil.com:${port}`, ...bearer() });
    expect(res.status).toBe(403);
    expect(await res.text()).toBe("");
  });

  test("loopback Origin on the WRONG port → 403", async () => {
    const other = port === 65535 ? 1024 : port + 1;
    const res = await post({ origin: `http://127.0.0.1:${other}`, ...bearer() });
    expect(res.status).toBe(403);
    expect(await res.text()).toBe("");
  });

  test("Origin whose hostname merely ENDS in localhost → 403", async () => {
    // endsWith-style matching would let evil.localhost through.
    const res = await post({ origin: `http://evil.localhost:${port}`, ...bearer() });
    expect(res.status).toBe(403);
    expect(await res.text()).toBe("");
  });

  test("suffix-confusion Referer (no Origin) → 403", async () => {
    const res = await post({ referer: `http://localhost.evil.com:${port}/x`, ...bearer() });
    expect(res.status).toBe(403);
    expect(await res.text()).toBe("");
  });
});

/**
 * DIST_DIR is a module constant (`resolve(server/.., "dist")`), so the static
 * branch can only be exercised by putting a real directory there. Under
 * `bun test` it does not exist, which is why every static assertion above this
 * point silently hits the "no ./dist build" early return instead of the
 * file-serving body. These two describes cover both modes, in declaration
 * order: the no-dist branch first, then the fixture that creates dist.
 */
const DIST_DIR = path.resolve(import.meta.dir, "..", "dist");
const INDEX_BODY = '<!doctype html><title>viz-dist-fixture</title><div id="app"></div>';
const ASSET_BODY = "console.log('viz-fixture-asset');";
const ENCODED_ASSET_BODY = "encoded-name-asset";

describe("static branch with NO ./dist build", () => {
  // Skipped when a developer has actually run `bun run build`.
  test.if(!fs.existsSync(DIST_DIR))(
    "authenticated GET / → plaintext hint carrying the static headers",
    async () => {
      const res = await fetch(`${base()}/`, { headers: bearer() });
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toBe("text/plain; charset=utf-8");
      expect(res.headers.get("cache-control")).toBe("no-store");
      expect(res.headers.get("x-content-type-options")).toBe("nosniff");
      expect(await res.text()).toContain("No ./dist build found");
    },
  );
});

describe("static branch WITH a ./dist build (INV-3 confinement)", () => {
  const written: string[] = [];
  let createdDist = false;
  let indexBody = INDEX_BODY;

  const write = (rel: string, body: string): void => {
    const full = path.join(DIST_DIR, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    if (fs.existsSync(full)) throw new Error(`refusing to clobber ${full}`);
    fs.writeFileSync(full, body);
    written.push(full);
  };

  beforeAll(() => {
    createdDist = !fs.existsSync(DIST_DIR);
    fs.mkdirSync(DIST_DIR, { recursive: true });
    const index = path.join(DIST_DIR, "index.html");
    // A real build's index.html is left alone and used as the expectation.
    if (fs.existsSync(index)) indexBody = fs.readFileSync(index, "utf8");
    else write("index.html", INDEX_BODY);
    write("assets/viz-fixture.js", ASSET_BODY);
    write("assets/viz fixture.txt", ENCODED_ASSET_BODY);
  });

  afterAll(() => {
    if (createdDist) {
      fs.rmSync(DIST_DIR, { recursive: true, force: true });
      return;
    }
    for (const full of written) fs.rmSync(full, { force: true });
  });

  test("a real asset is served with the static headers", async () => {
    const res = await fetch(`${base()}/assets/viz-fixture.js`, { headers: bearer() });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(ASSET_BODY);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expectNoAca(res.headers);
  });

  test("an asset whose name needs percent-encoding is reachable", async () => {
    const res = await fetch(`${base()}/assets/viz%20fixture.txt`, { headers: bearer() });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(ENCODED_ASSET_BODY);
  });

  test("the static branch is still gated — no credential → 401, no bytes", async () => {
    const res = await fetch(`${base()}/assets/viz-fixture.js`);
    expect(res.status).toBe(401);
    expect(await res.text()).toBe("");
  });

  test("SPA fallback: an extensionless route serves index.html as html", async () => {
    const res = await fetch(`${base()}/session/${FIXTURE_REQUEST_ID}`, {
      headers: bearer(),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(await res.text()).toBe(indexBody);
  });

  test("a missing dotted asset is a JSON 404, never the SPA shell", async () => {
    const res = await fetch(`${base()}/assets/gone.js`, { headers: bearer() });
    expect(res.status).toBe(404);
    expect(res.headers.get("content-type")).toBe("application/json; charset=utf-8");
    expect(await res.json()).toEqual({ error: "not found" });
  });

  test("percent-encoded traversal /..%2fpackage.json → JSON 404, never the file", async () => {
    const res = await rawHttp(port, [
      "GET /..%2fpackage.json HTTP/1.1",
      `Host: 127.0.0.1:${port}`,
      `Authorization: Bearer ${TOKEN}`,
    ]);
    expect(res.body.includes("sssf-visualizer")).toBe(false);
    expect(res.status).toBe(404);
    expect(res.body).toBe(JSON.stringify({ error: "not found" }));
  });

  test("plain-dot traversal never serves /etc/passwd", async () => {
    // Bun normalises dot segments out of the request target before the
    // handler sees it (this arrives as "/etc/passwd", joined back under
    // dist), so this pins the normalisation + the absence of a leak; the
    // percent-encoded variants below are what actually reach the
    // confinement check.
    const up = "/..".repeat(8);
    const res = await rawHttp(port, [
      `GET ${up}/etc/passwd HTTP/1.1`,
      `Host: 127.0.0.1:${port}`,
      `Authorization: Bearer ${TOKEN}`,
    ]);
    // The last segment has no dot, so the shell answers — the point is that
    // the bytes of /etc/passwd never do.
    expect(res.body.includes("root:")).toBe(false);
    expect(res.status).toBe(200);
    expect(res.body).toBe(indexBody);
  });

  test("percent-encoded traversal to /etc/hosts → JSON 404, never the file", async () => {
    const up = "/..%2f".repeat(8);
    const res = await rawHttp(port, [
      `GET ${up}etc%2fhosts HTTP/1.1`,
      `Host: 127.0.0.1:${port}`,
      `Authorization: Bearer ${TOKEN}`,
    ]);
    expect(res.body.includes("localhost")).toBe(false);
    expect(res.status).toBe(404);
    expect(res.body).toBe(JSON.stringify({ error: "not found" }));
  });
});
