/**
 * DF4.1 visualizer server — the SSSF JSON API + SPA over a DF1.4 trace store,
 * behind a pre-dispatch auth gate on a loopback bind.
 *
 *   bun run server/index.ts
 *   bun run server/index.ts --db /run/trace/trace.db
 *   QDS_VIZ_DB=/run/trace/trace.db QDS_VIZ_PORT=4600 bun run server/index.ts
 *
 * There is no ingest endpoint and no websocket. The data path is
 * pipeline → trace.db → this server → web ui, and the UI gets there by polling.
 *
 * Security posture (AC1/INV-1..5): ONE fetch dispatcher — not Bun's routes
 * object — so the gate runs BEFORE route dispatch and a route added later is
 * gated by construction. Order inside the handler: (1) Host check (DNS
 * rebinding), (2) CSRF check (the archive write only), (3) credential check,
 * (4) route match, (5) safely(handler), (6) static SPA fallback — gated too.
 * No CORS header is ever emitted on any response at any status.
 */
import { existsSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { TraceDb, resolveDbPath } from "./db.ts";
import {
  checkCredential,
  checkCsrf,
  checkHost,
  mintRequestId,
  validatePort,
  validateToken,
  VizError,
} from "./auth.ts";
import type { ApiError, HealthResponse } from "../shared/types.ts";

const DIST_DIR = resolve(import.meta.dir, "..", "dist");

export interface VisualizerHandle {
  server: ReturnType<typeof Bun.serve>;
  db: TraceDb;
}

export interface StartOptions {
  dbPath: string;
  /** The gate secret — ≥32 bytes or the server never binds. */
  token: string;
  /** 0 binds an ephemeral port (tests); production ports validate 1024-65535. */
  port?: number;
}

/**
 * Bind the visualizer. Fail-closed on every input: a short token, a
 * privileged/out-of-range port, or a trace db that cannot be opened readonly
 * throws a named VizError before Bun.serve is ever reached (INV-1/INV-5) —
 * there is no in-process path to an ungated or degraded listener.
 */
export function startVisualizer(options: StartOptions): VisualizerHandle {
  // Reuse validateToken's rule by feeding the token through the env shape.
  const token = validateToken({ QDS_VIZ_TOKEN: options.token });
  const port = options.port ?? 4600;
  if (
    !Number.isInteger(port) ||
    port < 0 ||
    port > 65535 ||
    (port > 0 && port < 1024)
  ) {
    throw new VizError(
      "VIZ_PORT_INVALID",
      `port ${port} is invalid (must be an integer in 1024-65535, or 0 for an ephemeral test bind)`,
      "Set QDS_VIZ_PORT to an integer in 1024-65535, or unset it for the default 4600.",
    );
  }

  const db = new TraceDb(options.dbPath); // throws VizError when absent/unreadable

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port,
    fetch: (req, srv) => handle(req, { db, token, srv }),
  });
  return { server, db };
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

function notFound(message: string): Response {
  return json({ error: message } satisfies ApiError, 404);
}

/** Empty-body refusal — 401/403 never leak a JSON shape or a credential hint. */
function emptyStatus(status: 401 | 403, extraHeaders?: Record<string, string>): Response {
  return new Response(null, { status, headers: extraHeaders });
}

/** Guard every handler so a malformed query can't take the server down mid-run. */
function safely(
  handler: (req: Request) => Response | Promise<Response>,
): (req: Request) => Promise<Response> {
  return async (req) => {
    try {
      return await handler(req);
    } catch (error) {
      // Errors name the failing statement (sqlite messages carry the column
      // and SQL), never a row's payload; the token is never in scope here.
      console.error(
        JSON.stringify({
          event: "viz_error",
          code: (error as { code?: string }).code ?? "HANDLER",
          message: (error as Error).message,
          stack: (error as Error).stack,
        }),
      );
      return json({ error: (error as Error).message } satisfies ApiError, 500);
    }
  };
}

/**
 * requestId and phaseId are path segments from the trace's own vocabulary, so
 * anything that isn't a plain identifier is rejected outright rather than
 * sanitized into something that might still escape (INV-3). phaseId arrives
 * as the flattened `?phaseId=` selector and gets the same rule.
 */
const SAFE_SEGMENT = /^[A-Za-z0-9._-]+$/;

function isSafeSegment(value: string): boolean {
  return SAFE_SEGMENT.test(value) && value !== "." && value !== "..";
}

/**
 * Decode a path segment AFTER the credential gate. Malformed percent-encoding
 * returns null (→ 400), never a throw — and the raw segment is what flows
 * pre-gate (log lines, route labels), so untrusted input is never decoded
 * before the request has proven eligible to present a credential.
 */
function decodeSegment(raw: string): string | null {
  try {
    return decodeURIComponent(raw);
  } catch {
    return null;
  }
}

function intQuery(req: Request, key: string, fallback: number): number {
  const raw = new URL(req.url).searchParams.get(key);
  if (raw === null || raw.trim() === "") return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

/**
 * `after` is a cursor, not a number to fix up: present and non-empty it must
 * be a non-negative integer or the request is rejected — never coerced
 * (INV-3). Omitted/empty is the initial cursor, rowid 0.
 */
function afterQuery(req: Request): { ok: true; value: number } | { ok: false } {
  const raw = new URL(req.url).searchParams.get("after");
  if (raw === null || raw === "") return { ok: true, value: 0 };
  if (!/^\d+$/.test(raw)) return { ok: false };
  return { ok: true, value: Number(raw) };
}

/** Serve the built SPA if it has been built; otherwise point at the dev server. */
async function serveStatic(req: Request): Promise<Response> {
  const { pathname } = new URL(req.url);

  if (!existsSync(DIST_DIR)) {
    return new Response(
      "QDS visualizer API is running.\n\n" +
        `No ./dist build found. Run "bun run dev" for the Vite dev server ` +
        `(it proxies /api here), or "bun run build" to serve the UI from this process.\n`,
      { status: 200, headers: { "content-type": "text/plain; charset=utf-8" } },
    );
  }

  // Reject traversal before touching the filesystem.
  const candidate = resolve(join(DIST_DIR, pathname));
  if (candidate === DIST_DIR || candidate.startsWith(`${DIST_DIR}/`)) {
    if (existsSync(candidate) && statSync(candidate).isFile()) {
      return new Response(Bun.file(candidate));
    }
  }

  // SPA fallback: breadcrumb routes are client-side.
  const indexHtml = join(DIST_DIR, "index.html");
  if (existsSync(indexHtml)) {
    return new Response(Bun.file(indexHtml), {
      headers: { "content-type": "text/html; charset=utf-8" },
    });
  }
  return notFound("not found");
}

// ── route table ──────────────────────────────────────────────────────────────
// Small regex table, matched inside the gated dispatcher. The eight literal
// paths are the pinned list DF4.2's suite asserts verbatim.

interface RouteRule {
  method: "GET" | "POST";
  pattern: RegExp;
  label: string;
  /** The one write route — the CSRF table applies to it alone. */
  write?: boolean;
  handler: (
    req: Request,
    requestId: string,
    db: TraceDb,
  ) => Response | Promise<Response>;
}

const ROUTES: readonly RouteRule[] = [
  {
    method: "GET",
    pattern: /^\/api\/health$/,
    label: "/api/health",
    handler: (_req, _requestId, db) => json(db.health() satisfies HealthResponse),
  },
  {
    method: "GET",
    pattern: /^\/api\/sessions$/,
    label: "/api/sessions",
    handler: (req, _requestId, db) => json(db.sessions(intQuery(req, "limit", 200))),
  },
  {
    method: "GET",
    pattern: /^\/api\/sessions\/([^/]+)$/,
    label: "/api/sessions/:requestId",
    handler: (_req, requestId, db) => {
      const detail = db.sessionDetail(requestId);
      return detail ? json(detail) : notFound(`no session ${requestId}`);
    },
  },
  {
    method: "GET",
    pattern: /^\/api\/sessions\/([^/]+)\/events$/,
    label: "/api/sessions/:requestId/events",
    handler: (req, requestId, db) => {
      const after = afterQuery(req);
      if (!after.ok) {
        return json({ error: "after must be a non-negative integer" } satisfies ApiError, 400);
      }
      // limit is clamped before binding; default 500, MAX 1000.
      return json(db.events(requestId, after.value, intQuery(req, "limit", 500)));
    },
  },
  {
    method: "GET",
    pattern: /^\/api\/sessions\/([^/]+)\/envelopes$/,
    label: "/api/sessions/:requestId/envelopes",
    handler: (_req, requestId, db) => json(db.envelopes(requestId)),
  },
  {
    method: "GET",
    pattern: /^\/api\/sessions\/([^/]+)\/gates$/,
    label: "/api/sessions/:requestId/gates",
    handler: (_req, requestId, db) => json(db.gates(requestId)),
  },
  {
    method: "GET",
    pattern: /^\/api\/sessions\/([^/]+)\/prompts$/,
    label: "/api/sessions/:requestId/prompts",
    handler: (req, requestId, db) => {
      const phaseId = new URL(req.url).searchParams.get("phaseId");
      if (phaseId !== null && !isSafeSegment(phaseId)) {
        return json({ error: "invalid phaseId" } satisfies ApiError, 400);
      }
      return json(db.prompts(requestId, phaseId ?? undefined));
    },
  },
  {
    // The one write. Archiving is review triage — it belongs to the reader,
    // not to the run — so it never touches anything a tracer wrote.
    method: "POST",
    pattern: /^\/api\/sessions\/([^/]+)\/archive$/,
    label: "/api/sessions/:requestId/archive",
    write: true,
    handler: async (req, requestId, db) => {
      const body = await req.text();
      if (Buffer.byteLength(body, "utf8") > 1024) {
        return json({ error: "body exceeds 1 KB cap" } satisfies ApiError, 413);
      }
      let parsed: { archived?: unknown };
      if (body.trim() === "") {
        // An empty body means "archive" — the button's default.
        parsed = {};
      } else {
        try {
          parsed = JSON.parse(body) as { archived?: unknown };
        } catch {
          // Fail closed on the ONE persistent write: unparseable JSON is a
          // client bug, never a silent archive.
          return json({ error: "body is not valid JSON" } satisfies ApiError, 400);
        }
      }
      const archived = parsed.archived === undefined ? true : Boolean(parsed.archived);
      return db.setArchived(requestId, archived)
        ? json({ request_id: requestId, archived })
        : notFound(`no session ${requestId}`);
    },
  },
];

interface GateContext {
  db: TraceDb;
  token: string;
  srv?: Parameters<NonNullable<Parameters<typeof Bun.serve>[0]["fetch"]>>[1];
}

/**
 * The one dispatcher. The gate (host → csrf → credential) runs before any
 * route or static handling, and every request — allowed or refused — leaves
 * exactly one log line on the Observability Contract's shape. The token is
 * never logged in any form: no header value reaches the log line.
 */
async function handle(req: Request, ctx: GateContext): Promise<Response> {
  const started = performance.now();
  const url = new URL(req.url);
  const { pathname } = url;
  const isApi = pathname.startsWith("/api/");

  const candidates = ROUTES.flatMap((rule) => {
    const m = rule.pattern.exec(pathname);
    return m !== null && rule.method === req.method ? [{ rule, m }] : [];
  });
  const routeMatch = candidates[0];
  const routeLabel = routeMatch ? routeMatch.rule.label : pathname;
  // Logged requestId is the RAW path segment — decoding untrusted input
  // pre-gate (a malformed %-sequence throws) would hand an unauthenticated
  // caller a crash instead of the 401/403 it is owed.
  const requestId =
    routeMatch && routeMatch.m[1] !== undefined
      ? (routeMatch.m[1] as string)
      : mintRequestId();

  let authOutcome = "ok";
  let authMs = 0;
  let queryMs = 0;
  let status = 500;
  try {
    const authStart = performance.now();

    // (1) DNS-rebinding gate — before the credential check, so a forged Host
    // can never probe even an invalid credential.
    const boundPort = resolveBoundPort(ctx);
    if (!checkHost(req, boundPort)) {
      authOutcome = "host_rejected";
      status = 403;
      return emptyStatus(403);
    }

    // (2) CSRF gate — the write route only, before credential validation.
    if (routeMatch?.rule.write === true && !checkCsrf(req, boundPort)) {
      authOutcome = "csrf_rejected";
      status = 403;
      return emptyStatus(403);
    }

    // (3) Credential gate — every route, JSON, write and static alike.
    if (!checkCredential(req, ctx.token)) {
      authOutcome = "rejected";
      status = 401;
      // A navigation cannot set a bearer header, so only the static branch's
      // 401 challenges (Basic realm); JSON routes stay silent.
      return emptyStatus(
        401,
        isApi ? undefined : { "www-authenticate": 'Basic realm="qds-viz"' },
      );
    }
    authMs = performance.now() - authStart;

    // (4/5) Route match + safely() — or (6) the gated static fallback.
    const queryStart = performance.now();
    let response: Response;
    if (routeMatch) {
      const { rule, m } = routeMatch;
      const hasParam = m[1] !== undefined;
      const segment = hasParam ? decodeSegment(m[1] as string) : "";
      if (hasParam && (segment === null || !isSafeSegment(segment))) {
        response = json({ error: "invalid requestId" } satisfies ApiError, 400);
      } else {
        response = await safely((r) => rule.handler(r, segment ?? "", ctx.db))(req);
      }
    } else if (isApi) {
      response = notFound(`no route ${pathname}`);
    } else {
      response = await serveStatic(req);
    }
    queryMs = performance.now() - queryStart;
    status = response.status;
    return response;
  } finally {
    // Sub-timings report 0 when there is no breakdown to report (a refused
    // request never reaches the query leg).
    const line = {
      event: "viz_request",
      requestId,
      route: routeLabel,
      authOutcome,
      status,
      durationMs: Math.round(performance.now() - started),
      auth_ms: Math.round(authOutcome === "ok" ? authMs : 0),
      query_ms: Math.round(queryMs),
    };
    try {
      const ip = ctx.srv?.requestIP(req);
      console.log(JSON.stringify({ ...line, source: ip?.address ?? "unknown" }));
    } catch {
      console.log(JSON.stringify(line));
    }
  }
}

/**
 * The Host/CSRF gates compare against the port the client actually reached —
 * with an ephemeral bind that is server.port, not the requested 0.
 */
function resolveBoundPort(ctx: GateContext): number {
  const ports = ctx.srv?.port;
  return typeof ports === "number" ? ports : 4600;
}

/**
 * Entry point: validate token and port BEFORE binding, resolve the db path
 * the way the pipeline wrote it, and exit non-zero with a named error on any
 * refusal — never degrade to 0.0.0.0, never serve ungated (INV-5).
 */
export function main(): void {
  let handleResult: VisualizerHandle;
  try {
    const port = validatePort(process.env);
    const token = validateToken(process.env);
    handleResult = startVisualizer({ dbPath: resolveDbPath(), token, port });
  } catch (error) {
    const named =
      error instanceof VizError
        ? error
        : new VizError(
            "VIZ_STARTUP",
            (error as Error)?.message ?? String(error),
            "Fix the reported condition and restart.",
          );
    console.error(
      JSON.stringify({
        event: "viz_startup_refused",
        code: named.code,
        message: named.message,
        remediation: named.remediation,
      }),
    );
    process.exit(1);
  }

  const { server, db } = handleResult;
  console.log(`[viz] visualizer api  http://127.0.0.1:${server.port}`);
  console.log(`[viz] db              ${db.path}  [journal_mode=${db.journalMode}]`);
  console.log(
    existsSync(DIST_DIR)
      ? `[viz] serving ui from  ${DIST_DIR}`
      : `[viz] no ./dist — use "bun run dev" for the Vite dev server`,
  );

  process.on("SIGINT", () => {
    db.close();
    process.exit(0);
  });
}

if (import.meta.main) {
  main();
}
