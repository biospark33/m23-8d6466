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

function expectNoAca(headers: Headers): void {
  for (const key of headers.keys()) {
    expect(key.toLowerCase().startsWith("access-control-allow")).toBe(false);
  }
}

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

    const vizPortTokens = [/QDS_VIZ_PORT/i, /viz[-_]?port/i, /\b4600\b/];
    for (const file of files) {
      const src = fs.readFileSync(file, "utf8");
      if (!vizPortTokens.some((re) => re.test(src))) continue;
      // The operand reached src/providers — only a same-file assertNeverPublic
      // guard can keep this green; any unguarded use goes red.
      expect(
        src.includes("assertNeverPublic"),
        `${file} carries a visualizer-port operand without an assertNeverPublic guard`,
      ).toBe(true);
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
