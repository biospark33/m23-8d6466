/**
 * DF4.1 static-serving branch WITH a ./dist build present (INV-3 confinement).
 *
 * Lives in its own file, not a second describe in auth.test.ts: the fixture
 * creates the real `dist/` directory in beforeAll, and Bun's hook scheduling
 * made that creation order-dependent relative to the no-dist describe in the
 * same file (the no-dist assertions ran after `dist/` already existed and
 * served the SPA shell instead of the plaintext hint). Two files cannot see
 * each other's filesystem fixtures, so this file's existence is the
 * ordering guarantee — independent of any runner's hook semantics.
 *
 * Server, token and fixture preamble mirror auth.test.ts; the two files
 * intentionally do not share a harness module so each remains readable
 * standalone.
 */
import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { connect } from "node:net";
import * as fs from "node:fs";
import * as path from "node:path";
import { seedTrace, FIXTURE_REQUEST_ID } from "./fixtures/trace-fixture.ts";
import { startVisualizer } from "../server/index.ts";

const TOKEN = "0123456789abcdef0123456789abcdef"; // 32 bytes

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

const DIST_DIR = path.resolve(import.meta.dir, "..", "dist");
const INDEX_BODY = '<!doctype html><title>viz-dist-fixture</title><div id="app"></div>';
const ASSET_BODY = "console.log('viz-fixture-asset');";
const ENCODED_ASSET_BODY = "encoded-name-asset";

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
    // Guard the tracked-list removal: every path we rm must sit inside dist/.
    // A future edit to `write()` that escapes the tree would otherwise delete
    // an operator file at teardown — the one direction this fixture must never
    // fail in.
    for (const full of written) {
      if (!path.resolve(full).startsWith(`${DIST_DIR}${path.sep}`)) {
        throw new Error(`fixture wrote outside dist/: ${full}`);
      }
      fs.rmSync(full, { force: true });
    }
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

  test.each([
    ["double-encoded", "/..%252f".repeat(8), "%252fetc%252fhosts", "localhost"],
    ["backslash separators", "/..%5c".repeat(8), "etc%5chosts", "localhost"],
    ["uppercase hex digits", "/..%2E%2F".repeat(4), "etc%2Fhosts", "localhost"],
  ])("%s traversal spelling → JSON 404, never the file", async (_label, up, tail, marker) => {
    // The three spellings a naive decoder chain is known to miss: one decode
    // pass leaves %252f as literal "%2f" (so it must not be decoded TWICE into
    // a separator); a backslash is a plain filename character on POSIX and
    // must never be treated as one; and case in the hex digits must not decide
    // whether an escape decodes. All of them end the same way either way —
    // inside dist (no such file) or refused at the confinement check — and
    // none may hand back bytes from outside it.
    const res = await rawHttp(port, [
      `GET ${up}${tail} HTTP/1.1`,
      `Host: 127.0.0.1:${port}`,
      `Authorization: Bearer ${TOKEN}`,
    ]);
    expect(res.body.includes(marker)).toBe(false);
    expect(res.status).toBe(404);
    expect(res.body).toBe(JSON.stringify({ error: "not found" }));
  });

  test("a stat failure between existsSync and statSync (TOCTOU) is a 404, not a 500", async () => {
    // The comment on serveStatic calls this out by name: "bun run build"
    // empties dist wholesale, so the file can vanish between the check and
    // the stat. That race is not reliably reproducible by timing alone, so
    // the fault is injected directly at the one call this branch makes —
    // this is exactly the failure the surrounding try/catch exists to
    // convert into a 404 instead of an unhandled throw.
    const spy = spyOn(fs, "statSync").mockImplementation(() => {
      throw new Error("ENOENT: injected TOCTOU race");
    });
    try {
      const res = await fetch(`${base()}/assets/viz-fixture.js`, { headers: bearer() });
      expect(res.status).toBe(404);
      expect(res.headers.get("content-type")).toBe("application/json; charset=utf-8");
      expect(await res.json()).toEqual({ error: "not found" });
    } finally {
      spy.mockRestore();
    }
  });
});
