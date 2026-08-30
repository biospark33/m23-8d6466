/**
 * DF4.1 route tests (AC2, AC3, AC4, INV-3/4, DoD contract items).
 *
 * In-process Bun.serve on 127.0.0.1:0 against real DF1.4 trace dbs seeded by
 * the real Tracer (see fixtures/trace-fixture.ts).
 */
/* oxlint-disable no-await-in-loop -- these suites walk a table of bad inputs, or
   a cursor whose next value comes from the previous response, against ONE shared
   server and ONE shared fixture db; Promise.all would interleave requests and
   test something other than what each case asserts. */
import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { Database } from "bun:sqlite";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  seedTrace,
  seedManyEvents,
  seedEmptyTrace,
  EMPTY_REQUEST_ID,
  FIXTURE_REQUEST_ID,
  MANY_REQUEST_ID,
  appendAgentEnds,
  PHASE_AGENT,
  PHASE_ENGINEER,
} from "./fixtures/trace-fixture.ts";
import { startVisualizer } from "../server/index.ts";
import * as indexMod from "../server/index.ts";
import { resolveDbPath, TraceDb } from "../server/db.ts";
import { VizError } from "../server/auth.ts";
import * as authMod from "../server/auth.ts";

const TOKEN = "0123456789abcdef0123456789abcdef";

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
const bearer = { authorization: `Bearer ${TOKEN}` };

async function getJson<T>(route: string): Promise<{ res: Response; body: T }> {
  const res = await fetch(`${base()}${route}`, { headers: bearer });
  return { res, body: (await res.json()) as T };
}

/** Start a throwaway visualizer over a fixture variant DB; stop it after fn. */
async function withServer(
  dbPath: string,
  fn: (serverPort: number) => Promise<void>,
): Promise<void> {
  const local = startVisualizer({ dbPath, token: TOKEN, port: 0 });
  try {
    await fn(local.server.port ?? 0);
  } finally {
    await local.server.stop(true);
    local.db.close();
  }
}

/**
 * Swallow console.error and keep what was written. The 500 body carries no
 * detail any more (F11), so the diagnostic is only pinnable where it now
 * lives — the log line.
 */
function captureConsoleError(): { text: () => string; restore: () => void } {
  const lines: string[] = [];
  const spy = spyOn(console, "error").mockImplementation((...args: unknown[]) => {
    lines.push(args.map((a) => String(a)).join(" "));
  });
  return { text: () => lines.join("\n"), restore: () => spy.mockRestore() };
}

/** Read sessions.archived straight from the db — no filtered-listing inference. */
function archivedFlag(dbPath: string, requestId: string): number | null {
  const aux = new Database(dbPath, { readonly: true });
  try {
    return (
      aux
        .query<{ archived: number | null }, [string]>(
          "SELECT archived FROM sessions WHERE request_id = ?",
        )
        .get(requestId)?.archived ?? null
    );
  } finally {
    aux.close();
  }
}

describe("L1 — GET /api/sessions (AC2)", () => {
  test("embeds phases and agents in one response, keyed on request_id", async () => {
    const { res, body } = await getJson<
      Array<{
        request_id: string;
        phases: Array<{ phase_id: string }>;
        agents: Array<{ agent: string }>;
        phase_count: number;
      }>
    >("/api/sessions?limit=50");
    expect(res.status).toBe(200);

    const fixture = body.find((s) => s.request_id === FIXTURE_REQUEST_ID);
    expect(fixture).toBeDefined();
    expect(fixture?.phases.map((p) => p.phase_id)).toEqual([PHASE_ENGINEER, PHASE_AGENT]);
    expect(fixture?.agents.map((a) => a.agent)).toEqual(["builder"]);
    expect(fixture?.phase_count).toBe(2);

    // The rename is at the port boundary, not an alias: no adw_id anywhere.
    expect(JSON.stringify(body)).not.toContain("adw_id");
  });

  test("total_cost is integer micro-dollars, not a float or cents", async () => {
    const { body } = await getJson<Array<{ request_id: string; total_cost: number }>>(
      "/api/sessions",
    );
    const fixture = body.find((s) => s.request_id === FIXTURE_REQUEST_ID);
    expect(fixture?.total_cost).toBe(250_000);
    expect(Number.isInteger(fixture?.total_cost)).toBe(true);
  });
});

describe("L2 — GET /api/sessions/:requestId (AC2)", () => {
  test("returns session + usage + phases + agents in one response", async () => {
    const { res, body } = await getJson<{
      session: { request_id: string; total_cost: number; pipeline_name: string | null };
      usage: { read: number; written: number };
      phases: Array<{ phase_id: string }>;
      agents: Array<{ agent: string; model: string | null }>;
    }>(`/api/sessions/${FIXTURE_REQUEST_ID}`);
    expect(res.status).toBe(200);
    expect(body.session.request_id).toBe(FIXTURE_REQUEST_ID);
    expect(body.session.total_cost).toBe(250_000);
    expect(body.usage).toEqual({ read: 150, written: 80 });
    expect(body.phases.map((p) => p.phase_id)).toEqual([PHASE_ENGINEER, PHASE_AGENT]);
    expect(body.agents[0]?.model).toBe("qds/test-max");
  });

  test("unknown requestId → 404", async () => {
    const res = await fetch(`${base()}/api/sessions/req-nope`, { headers: bearer });
    expect(res.status).toBe(404);
  });

  test("unsafe path segment → 400, rejected not sanitized", async () => {
    const res = await fetch(`${base()}/api/sessions/..%2Fetc`, { headers: bearer });
    expect(res.status).toBe(400);
  });
});

describe("L3 — gates and envelopes (AC2)", () => {
  test("gates include checks_json AND violations_json evidence", async () => {
    const { res, body } = await getJson<
      Array<{
        gate: string | null;
        passed: number | null;
        violations_json: string | null;
        checks_json: string | null;
      }>
    >(`/api/sessions/${FIXTURE_REQUEST_ID}/gates`);
    expect(res.status).toBe(200);

    const failed = body.find((g) => g.gate === "build-review");
    expect(failed?.passed).toBe(0);
    expect(JSON.parse(failed?.violations_json ?? "[]")).toEqual(["lint failed"]);
    const checks = JSON.parse(failed?.checks_json ?? "[]") as Array<{
      item: string;
      ok: boolean;
      note: string;
    }>;
    expect(checks).toHaveLength(2);
    expect(checks[1]).toEqual({ item: "lint", ok: false, note: "1 error" });
  });

  test("envelopes return rows keyed on request_id", async () => {
    const { res, body } = await getJson<
      Array<{ envelope_id: string; request_id: string; agent: string | null; valid: number }>
    >(`/api/sessions/${FIXTURE_REQUEST_ID}/envelopes`);
    expect(res.status).toBe(200);
    expect(body).toHaveLength(1);
    expect(body[0]?.request_id).toBe(FIXTURE_REQUEST_ID);
    expect(body[0]?.agent).toBe("builder");
    expect(body[0]?.valid).toBe(1);
  });
});

describe("prompts — served from the trace, not the disk (AC2, INV-3)", () => {
  interface PromptRow {
    event_id: string;
    phase_id: string | null;
    name: string | null;
    payload_json: string | null;
    tokens: number | null;
    started_at: string | null;
  }

  test("omitted phaseId returns every prompt for the run", async () => {
    const { res, body } = await getJson<PromptRow[]>(
      `/api/sessions/${FIXTURE_REQUEST_ID}/prompts`,
    );
    expect(res.status).toBe(200);
    expect(body).toHaveLength(4);
    expect(body.every((p) => p.phase_id === PHASE_ENGINEER || p.phase_id === PHASE_AGENT)).toBe(
      true,
    );
  });

  test("phaseId filter returns that phase's per-role prompts, payload verbatim", async () => {
    const { body } = await getJson<PromptRow[]>(
      `/api/sessions/${FIXTURE_REQUEST_ID}/prompts?phaseId=${PHASE_ENGINEER}`,
    );
    expect(body).toHaveLength(2);
    expect(body.map((p) => p.name).toSorted()).toEqual(["engineer", "planner"]);
    const first = body[0];
    if (first === undefined) throw new Error("expected a first prompt row");
    // payload_json passes through verbatim — DF1.4's {agentId, prompt, model}.
    const parsed = JSON.parse(first.payload_json ?? "{}") as {
      agentId?: string;
      prompt?: string;
      model?: string;
    };
    expect(parsed.prompt).toContain("compiled");
    expect(first.name).toBe(parsed.agentId ?? null);
    expect(parsed.model).toBe("qds/test-max");
  });

  test("phaseId failing SAFE_SEGMENT → 400, rejected outright", async () => {
    for (const bad of ["..%2Fetc", "bad%20seg", "."]) {
      const res = await fetch(
        `${base()}/api/sessions/${FIXTURE_REQUEST_ID}/prompts?phaseId=${bad}`,
        { headers: bearer },
      );
      expect(res.status).toBe(400);
    }
  });

  test("the upstream filesystem prompts route shape is gone", async () => {
    const res = await fetch(
      `${base()}/api/sessions/${FIXTURE_REQUEST_ID}/agents/builder/prompts`,
      { headers: bearer },
    );
    expect(res.status).toBe(404);
  });
});

describe("events — {rows, cursor, hasMore} on a rowid cursor (AC4, INV-3)", () => {
  test("default page: initial cursor, rowid order, hasMore false under 500", async () => {
    const { res, body } = await getJson<{
      rows: Array<{ rowid: number }>;
      cursor: number;
      hasMore: boolean;
    }>(`/api/sessions/${FIXTURE_REQUEST_ID}/events`);
    expect(res.status).toBe(200);
    expect(body.rows).toHaveLength(seeded.eventCount);
    const rowids = body.rows.map((r) => r.rowid);
    expect(rowids).toEqual(rowids.toSorted((a, b) => a - b));
    const lastRowid = rowids.at(-1);
    if (lastRowid === undefined) throw new Error("expected a non-empty page");
    expect(body.cursor).toBe(lastRowid);
    expect(body.hasMore).toBe(false);
  });

  test("paging with a small limit walks every row exactly once", async () => {
    const seen: number[] = [];
    let cursor = 0;
    let pages = 0;
    for (;;) {
      const { body } = await getJson<{ rows: Array<{ rowid: number }>; cursor: number; hasMore: boolean }>(
        `/api/sessions/${FIXTURE_REQUEST_ID}/events?after=${cursor}&limit=5`,
      );
      seen.push(...body.rows.map((r) => r.rowid));
      cursor = body.cursor;
      pages += 1;
      if (!body.hasMore) break;
      expect(pages).toBeLessThan(20); // loop guard
    }
    expect(seen).toHaveLength(seeded.eventCount);
    expect(new Set(seen).size).toBe(seeded.eventCount);
    expect(pages).toBeGreaterThanOrEqual(4);
  });

  test("limit=99999 clamps to MAX_LIMIT=1000 before binding", async () => {
    const many = seedManyEvents(1005);
    try {
      await withServer(many.dbPath, async (manyPort) => {
        const first = await fetch(
          `http://127.0.0.1:${manyPort}/api/sessions/${MANY_REQUEST_ID}/events?limit=99999`,
          { headers: bearer },
        );
        expect(first.status).toBe(200);
        const page1 = (await first.json()) as { rows: unknown[]; cursor: number; hasMore: boolean };
        expect(page1.rows).toHaveLength(1000);
        expect(page1.hasMore).toBe(true);

        const second = await fetch(
          `http://127.0.0.1:${manyPort}/api/sessions/${MANY_REQUEST_ID}/events?after=${page1.cursor}&limit=99999`,
          { headers: bearer },
        );
        const page2 = (await second.json()) as { rows: unknown[]; hasMore: boolean };
        expect(page2.rows).toHaveLength(5);
        expect(page2.hasMore).toBe(false);
      });
    } finally {
      many.cleanup();
    }
  });

  test("after=-1 and after=abc are rejected, never coerced", async () => {
    for (const bad of ["-1", "abc", "1.5", "+3"]) {
      const res = await fetch(
        `${base()}/api/sessions/${FIXTURE_REQUEST_ID}/events?after=${bad}`,
        { headers: bearer },
      );
      expect(res.status).toBe(400);
    }
  });

  test("after=0 is the same initial cursor as omitted", async () => {
    const a = await getJson<{ rows: unknown[]; cursor: number }>(
      `/api/sessions/${FIXTURE_REQUEST_ID}/events`,
    );
    const b = await getJson<{ rows: unknown[]; cursor: number }>(
      `/api/sessions/${FIXTURE_REQUEST_ID}/events?after=0`,
    );
    expect(b.body.rows).toHaveLength(a.body.rows.length);
    expect(b.body.cursor).toBe(a.body.cursor);
  });

  test("unknown requestId → 200 empty page, cursor 0, hasMore false", async () => {
    const { res, body } = await getJson<{ rows: unknown[]; cursor: number; hasMore: boolean }>(
      "/api/sessions/req-unknown/events",
    );
    expect(res.status).toBe(200);
    expect(body).toEqual({ rows: [], cursor: 0, hasMore: false });
  });

  test("event-less requestId → 200 empty page, cursor unchanged", async () => {
    const { res, body } = await getJson<{ rows: unknown[]; cursor: number; hasMore: boolean }>(
      `/api/sessions/${EMPTY_REQUEST_ID}/events?after=7`,
    );
    expect(res.status).toBe(200);
    expect(body).toEqual({ rows: [], cursor: 7, hasMore: false });
  });

  test("malformed percent-encoding: 401 pre-gate (never a crash), 400 post-gate", async () => {
    const anon = await fetch(`${base()}/api/sessions/%E0%A4%A/events`);
    expect(anon.status).toBe(401);
    expect(await anon.text()).toBe("");
    const authed = await fetch(`${base()}/api/sessions/%E0%A4%A/events`, {
      headers: bearer,
    });
    expect(authed.status).toBe(400);
  });
});

describe("archive — the only write (INV-4)", () => {
  const post = (body: string, requestId: string = EMPTY_REQUEST_ID) =>
    fetch(`${base()}/api/sessions/${requestId}/archive`, {
      method: "POST",
      headers: { ...bearer, "content-type": "application/json" },
      body,
    });

  test("happy path sets the flag and echoes request_id", async () => {
    expect((await post(JSON.stringify({ archived: false }))).status).toBe(200);
    const res = await post(JSON.stringify({ archived: true }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ request_id: EMPTY_REQUEST_ID, archived: true });
    // The echo is the route's word for it; the column is the fact.
    expect(archivedFlag(seeded.dbPath, EMPTY_REQUEST_ID)).toBe(1);
    await post(JSON.stringify({ archived: false })); // leave restored
  });

  test("unknown requestId → 404", async () => {
    const res = await post(JSON.stringify({ archived: true }), "req-nope");
    expect(res.status).toBe(404);
  });

  test("body over 1 KB → 413", async () => {
    const res = await post(JSON.stringify({ archived: true, pad: "x".repeat(2048) }));
    expect(res.status).toBe(413);
  });

  test("auth-gated like every other route", async () => {
    const res = await fetch(`${base()}/api/sessions/${EMPTY_REQUEST_ID}/archive`, {
      method: "POST",
    });
    expect(res.status).toBe(401);
  });

  test("malformed JSON body → 400 and no write (fail closed on the one write)", async () => {
    // The precondition is set here and the column is read back directly: the
    // old version inferred "no write" from db.sessions()'s
    // `WHERE COALESCE(archived,0) = 0` filter, which is a fact about the
    // listing query, not about the write. archived=0 is the discriminating
    // precondition — an unparseable body that fell through to the
    // `archived === undefined → true` default would flip it to 1.
    expect((await post(JSON.stringify({ archived: false }))).status).toBe(200);
    expect(archivedFlag(seeded.dbPath, EMPTY_REQUEST_ID)).toBe(0);
    const res = await post("this is not json");
    expect(res.status).toBe(400);
    expect(archivedFlag(seeded.dbPath, EMPTY_REQUEST_ID)).toBe(0);
  });

  test("empty body → 200 with the archive default (true)", async () => {
    const res = await post("");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ request_id: EMPTY_REQUEST_ID, archived: true });
    await post(JSON.stringify({ archived: false })); // leave restored
  });
});

describe("health (AC3)", () => {
  test("ok shape: {ok, db, journal_mode, sessions}", async () => {
    const { res, body } = await getJson<{
      ok: boolean;
      db: string;
      journal_mode: string;
      sessions: number;
    }>("/api/health");
    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.db).toBe(seeded.dbPath);
    expect(body.journal_mode).toBe("wal");
    expect(body.sessions).toBeGreaterThanOrEqual(2);
  });

  test("cache-control: no-store on JSON responses", async () => {
    const res = await fetch(`${base()}/api/health`, { headers: bearer });
    expect(res.headers.get("cache-control")).toBe("no-store");
  });
});

describe("optionalColumn degradation (AC3)", () => {
  test("declared optional column (sessions.pipeline_name): 200 with NULL while missing, real value after the ALTER lands mid-process", async () => {
    const variant = seedTrace();
    try {
      const aux = new Database(variant.dbPath);
      aux.exec("PRAGMA busy_timeout=5000");
      aux.exec("ALTER TABLE sessions DROP COLUMN pipeline_name");
      aux.close();

      await withServer(variant.dbPath, async (variantPort) => {
        const url = `http://127.0.0.1:${variantPort}`;
        const before = await fetch(`${url}/api/sessions`, { headers: bearer });
        expect(before.status).toBe(200);
        const rowsBefore = (await before.json()) as Array<{
          request_id: string;
          pipeline_name: string | null;
        }>;
        expect(rowsBefore.find((s) => s.request_id === FIXTURE_REQUEST_ID)?.pipeline_name).toBe(
          null,
        );

        // health reports the degraded condition in every case.
        const healthBefore = (await (
          await fetch(`${url}/api/health`, { headers: bearer })
        ).json()) as { ok: boolean; db: string; journal_mode: string };
        expect(healthBefore.ok).toBe(false);
        expect("sessions" in healthBefore).toBe(false);

        // The migration lands while we serve — the probe re-runs and latches.
        const migrate = new Database(variant.dbPath);
        migrate.exec("PRAGMA busy_timeout=5000");
        migrate.exec("ALTER TABLE sessions ADD COLUMN pipeline_name TEXT");
        migrate
          .prepare("UPDATE sessions SET pipeline_name = 'fixture-pipeline'")
          .run();
        migrate.close();

        const after = await fetch(`${url}/api/sessions`, { headers: bearer });
        expect(after.status).toBe(200);
        const rowsAfter = (await after.json()) as Array<{
          request_id: string;
          pipeline_name: string | null;
        }>;
        expect(
          rowsAfter.find((s) => s.request_id === FIXTURE_REQUEST_ID)?.pipeline_name,
        ).toBe("fixture-pipeline");

        const healthAfter = (await (
          await fetch(`${url}/api/health`, { headers: bearer })
        ).json()) as { ok: boolean; sessions: number };
        expect(healthAfter.ok).toBe(true);
        expect(healthAfter.sessions).toBeGreaterThanOrEqual(2);
      });
    } finally {
      variant.cleanup();
    }
  });

  test("non-declared missing column (sessions.archived): 500 via safely(), process stays up", async () => {
    const variant = seedTrace();
    try {
      const aux = new Database(variant.dbPath);
      aux.exec("PRAGMA busy_timeout=5000");
      aux.exec("ALTER TABLE sessions DROP COLUMN archived");
      aux.close();

      await withServer(variant.dbPath, async (variantPort) => {
        const url = `http://127.0.0.1:${variantPort}`;
        const logged = captureConsoleError();
        let failed: Response;
        try {
          failed = await fetch(`${url}/api/sessions`, { headers: bearer });
        } finally {
          logged.restore();
        }
        expect(failed.status).toBe(500);
        // F11: the sqlite message does not cross the response boundary…
        const errBody = (await failed.json()) as { error: string };
        expect(errBody.error).toBe("internal error");
        expect(JSON.stringify(errBody)).not.toContain("archived");
        // …the operator-facing detail lives in the log line instead.
        expect(logged.text()).toContain("archived");
        expect(logged.text()).toContain("viz_error");

        // The process stays up: health still answers, degraded.
        const health = await fetch(`${url}/api/health`, { headers: bearer });
        expect(health.status).toBe(200);
        const healthBody = (await health.json()) as { ok: boolean; journal_mode: string };
        expect(healthBody.ok).toBe(false);
        expect(healthBody.journal_mode).toBe("wal");
      });
    } finally {
      variant.cleanup();
    }
  });

  test("trace removed after a successful start: health degraded, process stays up", async () => {
    const variant = seedTrace();
    try {
      await withServer(variant.dbPath, async (variantPort) => {
        const url = `http://127.0.0.1:${variantPort}`;
        const ok = (await (await fetch(`${url}/api/health`, { headers: bearer })).json()) as {
          ok: boolean;
        };
        expect(ok.ok).toBe(true);

        const { rmSync } = await import("node:fs");
        for (const suffix of ["", "-wal", "-shm"]) {
          try {
            rmSync(variant.dbPath + suffix);
          } catch {}
        }

        const degraded = await fetch(`${url}/api/health`, { headers: bearer });
        expect(degraded.status).toBe(200);
        const body = (await degraded.json()) as { ok: boolean; db: string; journal_mode: string };
        expect(body.ok).toBe(false);
        expect(body.db).toBe(variant.dbPath);
        expect("sessions" in body).toBe(false);
      });
    } finally {
      variant.cleanup();
    }
  });

  test("trace absent at start → named error (INV-5 fatal, never binds)", async () => {
    const nowhere = path.join(seeded.root, "does-not-exist", "trace.db");
    try {
      startVisualizer({ dbPath: nowhere, token: TOKEN });
      throw new Error("expected startVisualizer to refuse an absent trace db");
    } catch (error) {
      expect(error).toBeInstanceOf(VizError);
      const named = error as VizError;
      expect(named.name).toBe("VizError");
      expect(named.code).toBe("VIZ_TRACE_DB_OPEN");
      expect(named.message).toContain(nowhere);
    }
  });
});

describe("limit is coerced, never validated — the clamp is the only bound (G4)", () => {
  // intQuery() silently falls back on garbage and passes a negative through,
  // so clamp(value, 1, MAX_LIMIT)'s LOWER bound is the whole defence: with
  // Math.min(limit, MAX_LIMIT) instead, `?limit=-1` is `LIMIT -1` — unbounded
  // in SQLite — and `?limit=0` returns nothing.

  test("/api/sessions: limit=-1 and limit=0 clamp to 1; limit=abc falls back to the default", async () => {
    for (const bad of ["-1", "0"]) {
      const { res, body } = await getJson<unknown[]>(`/api/sessions?limit=${bad}`);
      expect(res.status).toBe(200);
      expect(body).toHaveLength(1);
    }
    const garbage = await getJson<unknown[]>("/api/sessions?limit=abc");
    const fallback = await getJson<unknown[]>("/api/sessions?limit=200");
    expect(garbage.res.status).toBe(200);
    expect(garbage.body).toHaveLength(fallback.body.length);
    expect(garbage.body.length).toBeGreaterThan(1);
  });

  test("/api/sessions/:id/events: limit=-1 and limit=0 clamp to 1; limit=abc falls back", async () => {
    for (const bad of ["-1", "0"]) {
      const { res, body } = await getJson<{ rows: unknown[]; hasMore: boolean }>(
        `/api/sessions/${FIXTURE_REQUEST_ID}/events?limit=${bad}`,
      );
      expect(res.status).toBe(200);
      expect(body.rows).toHaveLength(1);
      // A page of exactly the capped limit is by definition not the last one.
      expect(body.hasMore).toBe(true);
    }
    const { body } = await getJson<{ rows: unknown[]; hasMore: boolean }>(
      `/api/sessions/${FIXTURE_REQUEST_ID}/events?limit=abc`,
    );
    expect(body.rows).toHaveLength(seeded.eventCount);
    expect(body.hasMore).toBe(false);
  });

  test("/api/sessions/:id/prompts: limit=-1 and limit=0 clamp to 1; limit=abc falls back", async () => {
    for (const bad of ["-1", "0"]) {
      const { res, body } = await getJson<unknown[]>(
        `/api/sessions/${FIXTURE_REQUEST_ID}/prompts?limit=${bad}`,
      );
      expect(res.status).toBe(200);
      expect(body).toHaveLength(1);
    }
    const { body } = await getJson<unknown[]>(
      `/api/sessions/${FIXTURE_REQUEST_ID}/prompts?limit=abc`,
    );
    expect(body).toHaveLength(4);
  });
});

describe("prompts are bounded like events (A1)", () => {
  test("default caps at 500, ?limit= is honoured and clamps at MAX_LIMIT=1000, shape stays a bare array", async () => {
    // Prompt payloads are the largest blobs in a trace: an unbounded read here
    // loads every compiled prompt of a long run into memory to serialize it.
    const many = seedManyEvents(1005, "prompt");
    try {
      await withServer(many.dbPath, async (manyPort) => {
        const url = `http://127.0.0.1:${manyPort}/api/sessions/${MANY_REQUEST_ID}/prompts`;
        const read = async (query: string): Promise<unknown[]> => {
          const res = await fetch(`${url}${query}`, { headers: bearer });
          expect(res.status).toBe(200);
          const body = (await res.json()) as unknown;
          // No cursor envelope on this route — still a bare array.
          expect(Array.isArray(body)).toBe(true);
          return body as unknown[];
        };
        expect(await read("")).toHaveLength(500);
        expect(await read("?limit=7")).toHaveLength(7);
        expect(await read("?limit=99999")).toHaveLength(1000);
        // The phaseId-filtered arm binds a third parameter — it must clamp too.
        expect(await read("?phaseId=nope&limit=99999")).toHaveLength(0);
      });
    } finally {
      many.cleanup();
    }
  });
});

describe("cursor rejection past MAX_SAFE_INTEGER (A10, INV-3)", () => {
  test("an unsafe integer after= is a 400, never coerced to a float and bound as a real", async () => {
    for (const bad of ["99999999999999999999999", String(Number.MAX_SAFE_INTEGER + 2)]) {
      const res = await fetch(
        `${base()}/api/sessions/${FIXTURE_REQUEST_ID}/events?after=${bad}`,
        { headers: bearer },
      );
      expect(res.status).toBe(400);
    }
    // …and the largest cursor that IS exact still pages normally.
    const ok = await getJson<{ rows: unknown[]; cursor: number }>(
      `/api/sessions/${FIXTURE_REQUEST_ID}/events?after=${Number.MAX_SAFE_INTEGER}`,
    );
    expect(ok.res.status).toBe(200);
    expect(ok.body.rows).toHaveLength(0);
    expect(ok.body.cursor).toBe(Number.MAX_SAFE_INTEGER);
  });
});

describe("unmatched /api route (A4b)", () => {
  test("404 body is the constant {error:'no route'} — the pathname is not reflected", async () => {
    const res = await fetch(`${base()}/api/zzz-reflect-me`, { headers: bearer });
    expect(res.status).toBe(404);
    const text = await res.text();
    expect(JSON.parse(text)).toEqual({ error: "no route" });
    expect(text).not.toContain("zzz-reflect-me");
  });

  test("a known route with an unknown id still names the id (unchanged)", async () => {
    const { res, body } = await getJson<{ error: string }>("/api/sessions/req-nope");
    expect(res.status).toBe(404);
    expect(body).toEqual({ error: "no session req-nope" });
  });
});

describe("archive refuses on the declared length, before the body is read (A7)", () => {
  test("Content-Length over 1 KB → 413 with no body sent at all", async () => {
    // Raw socket: the request head declares 5000 bytes and then sends none.
    // A server that read the body first would still be waiting; a 413 coming
    // back proves the refusal happened on the header alone.
    const head = [
      `POST /api/sessions/${EMPTY_REQUEST_ID}/archive HTTP/1.1`,
      `Host: 127.0.0.1:${port}`,
      `Authorization: Bearer ${TOKEN}`,
      "Content-Type: application/json",
      "Content-Length: 5000",
      "",
      "",
    ].join("\r\n");

    const statusLine = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("no response without a body")), 5000);
      void Bun.connect({
        hostname: "127.0.0.1",
        port,
        socket: {
          open: (socket) => {
            socket.write(head);
          },
          data: (socket, chunk) => {
            clearTimeout(timer);
            socket.end();
            resolve(new TextDecoder().decode(chunk).split("\r\n")[0] ?? "");
          },
          error: (_socket, error) => {
            clearTimeout(timer);
            reject(error);
          },
        },
      }).catch(reject);
    });

    expect(statusLine).toContain("413");
    // Fail closed: a refused write is not a write.
    expect(archivedFlag(seeded.dbPath, EMPTY_REQUEST_ID)).toBe(0);
  });
});

describe("archive after the trace file vanishes (A2)", () => {
  test("500, and no empty db is materialised at the trace path", async () => {
    const variant = seedTrace();
    try {
      await withServer(variant.dbPath, async (variantPort) => {
        const { rmSync, existsSync } = await import("node:fs");
        for (const suffix of ["", "-wal", "-shm"]) {
          try {
            rmSync(variant.dbPath + suffix);
          } catch {}
        }
        expect(existsSync(variant.dbPath)).toBe(false);

        const logged = captureConsoleError();
        let res: Response;
        try {
          res = await fetch(
            `http://127.0.0.1:${variantPort}/api/sessions/${EMPTY_REQUEST_ID}/archive`,
            {
              method: "POST",
              headers: { ...bearer, "content-type": "application/json" },
              body: JSON.stringify({ archived: true }),
            },
          );
        } finally {
          logged.restore();
        }
        expect(res.status).toBe(500);
        expect(await res.json()).toEqual({ error: "internal error" });
        // The writer opens {create:false}: a vanished trace is an error, not a
        // brand-new empty db at the path (which would then make health()
        // report drift-degraded instead of missing-db).
        expect(existsSync(variant.dbPath)).toBe(false);

        const health = (await (
          await fetch(`http://127.0.0.1:${variantPort}/api/health`, { headers: bearer })
        ).json()) as { ok: boolean; sessions?: number };
        expect(health.ok).toBe(false);
        expect("sessions" in health).toBe(false);
      });
    } finally {
      variant.cleanup();
    }
  });
});

describe("usage() derivation from agent_end payloads (G-fixture-fallback)", () => {
  // The rule, not a magic total: read = new input + cache WRITES, accumulated
  // over every agent_end. Cache reads are the same tokens served again on a
  // later turn — counting them rebuilds the inflation this split exposes.
  const CAMEL = { inputTokens: 10, cacheWriteTokens: 5, cacheReadTokens: 1000, outputTokens: 2 };
  const HERITAGE = {
    input_tokens: 100,
    cache_write_tokens: 50,
    cache_read_tokens: 9999,
    output_tokens: 20,
  };
  const NEW_INPUT = CAMEL.inputTokens + HERITAGE.input_tokens;
  const CACHE_WRITES = CAMEL.cacheWriteTokens + HERITAGE.cache_write_tokens;
  const CACHE_READS = CAMEL.cacheReadTokens + HERITAGE.cache_read_tokens;

  test("accumulates over events, takes the heritage snake_case arm, excludes cache reads, and survives junk", async () => {
    const variant = seedTrace();
    try {
      // EMPTY_REQUEST_ID is the event-less session — these four rows are its
      // entire event history, so the totals below are exactly what they imply.
      appendAgentEnds(variant.dbPath, EMPTY_REQUEST_ID, [
        JSON.stringify({ usage: CAMEL }),
        JSON.stringify({ usage: HERITAGE }),
        JSON.stringify({ contextTokens: 5 }), // no usage key at all
        "{not json", // a payload an older tracer mangled
        null,
      ]);

      await withServer(variant.dbPath, async (variantPort) => {
        const res = await fetch(
          `http://127.0.0.1:${variantPort}/api/sessions/${EMPTY_REQUEST_ID}`,
          { headers: bearer },
        );
        expect(res.status).toBe(200);
        const { usage } = (await res.json()) as { usage: { read: number; written: number } };
        expect(usage.read).toBe(NEW_INPUT + CACHE_WRITES);
        expect(usage.read).not.toBe(NEW_INPUT + CACHE_WRITES + CACHE_READS);
        expect(usage.written).toBe(CAMEL.outputTokens + HERITAGE.output_tokens);
      });
    } finally {
      variant.cleanup();
    }
  });
});

/** Save/restore a set of env vars around `fn`, so a case can't leak into a
 * test that runs after it in the same process. */
function withEnv(vars: Record<string, string | undefined>, fn: () => void): void {
  const prev: Record<string, string | undefined> = {};
  for (const key of Object.keys(vars)) prev[key] = process.env[key];
  try {
    for (const [key, value] of Object.entries(vars)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    fn();
  } finally {
    for (const [key, value] of Object.entries(prev)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

describe("resolveDbPath precedence (db.ts, AC1 reader surface)", () => {
  // --db flag > --db=inline > QDS_VIZ_DB > QDS_RUN_ROOT/trace/trace.db > /run.

  test("default: QDS_RUN_ROOT unset falls back to /run/trace/trace.db", () => {
    withEnv({ QDS_RUN_ROOT: undefined, QDS_VIZ_DB: undefined }, () => {
      expect(resolveDbPath([])).toBe(path.join("/run", "trace", "trace.db"));
    });
  });

  test("QDS_RUN_ROOT relocates the default path", () => {
    withEnv({ QDS_RUN_ROOT: "/custom/run", QDS_VIZ_DB: undefined }, () => {
      expect(resolveDbPath([])).toBe(path.join("/custom/run", "trace", "trace.db"));
    });
  });

  test("QDS_VIZ_DB wins over the QDS_RUN_ROOT default", () => {
    withEnv({ QDS_RUN_ROOT: "/custom/run", QDS_VIZ_DB: "/env/db.sqlite" }, () => {
      expect(resolveDbPath([])).toBe("/env/db.sqlite");
    });
  });

  test("--db=<path> inline wins over QDS_VIZ_DB", () => {
    withEnv({ QDS_VIZ_DB: "/env/db.sqlite" }, () => {
      expect(
        resolveDbPath(["bun", "run", "server/index.ts", "--db=/inline/db.sqlite"]),
      ).toBe("/inline/db.sqlite");
    });
  });

  test("--db <path> flag wins over --db=inline", () => {
    expect(
      resolveDbPath([
        "bun",
        "run",
        "server/index.ts",
        "--db=/inline/db.sqlite",
        "--db",
        "/flag/db.sqlite",
      ]),
    ).toBe("/flag/db.sqlite");
  });

  test("a relative --db path resolves against process.cwd(), not left relative", () => {
    expect(resolveDbPath(["bun", "--db", "relative/db.sqlite"])).toBe(
      path.resolve(process.cwd(), "relative/db.sqlite"),
    );
  });

  test("an absolute --db path passes through unchanged", () => {
    expect(resolveDbPath(["bun", "--db", "/abs/db.sqlite"])).toBe("/abs/db.sqlite");
  });
});

describe("bind failure after a successful db open (A-EADDRINUSE)", () => {
  test("a second bind on the same port throws and closes the db handle it just opened", () => {
    // Reuse the already-bound port from a live server — Bun.serve's second
    // bind on it fails after startVisualizer has already opened db readonly,
    // exercising the close-then-rethrow branch (never a leaked handle). The
    // throw alone doesn't pin that branch — Bun.serve's own bind failure
    // throws too, with no db involved — so spy on TraceDb.prototype.close
    // to prove the catch block's `db.close()` actually ran before rethrow.
    const closeSpy = spyOn(TraceDb.prototype, "close");
    try {
      expect(() => startVisualizer({ dbPath: seeded.dbPath, token: TOKEN, port })).toThrow();
      expect(closeSpy).toHaveBeenCalled();
    } finally {
      closeSpy.mockRestore();
    }
  });
});

describe("dispatch-level failure never reaches Bun's default handler (F11)", () => {
  // Every gate function (checkHost/checkCsrf/checkCredential) is documented
  // to return false rather than throw — but handle()'s own try/catch exists
  // specifically so a bug in one of them still fails closed as a logged 500,
  // not an unhandled exception leaking Bun's default error page. This pins
  // that fail-closed behavior by injecting the fault the comment guards
  // against, rather than waiting for a real bug in auth.ts to prove it.
  test("a gate function that throws surfaces as 500 with a DISPATCH-coded log line, not a crash", async () => {
    const logged = captureConsoleError();
    const spy = spyOn(authMod, "checkCredential").mockImplementation(() => {
      throw new Error("injected-gate-failure");
    });
    let res: Response;
    try {
      res = await fetch(`${base()}/api/health`, { headers: bearer });
    } finally {
      spy.mockRestore();
      logged.restore();
    }
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "internal error" });
    expect(logged.text()).toContain("DISPATCH");
    expect(logged.text()).toContain("injected-gate-failure");
  });

  test("a requestIP lookup failure falls back to logging the request with no source, not a crash", async () => {
    const spy = spyOn(handle.server, "requestIP").mockImplementation(() => {
      throw new Error("injected-requestIP-failure");
    });
    try {
      const res = await fetch(`${base()}/api/health`, { headers: bearer });
      // /api/health returns 200 with no requestIP fault too — that alone
      // doesn't prove the fallback path ran, so pin that the injection was
      // actually exercised before trusting the response.
      expect(spy).toHaveBeenCalled();
      expect(res.status).toBe(200);
    } finally {
      spy.mockRestore();
    }
  });
});

describe("AC5 boundary: a trace with zero sessions (L1 empty list, not an error)", () => {
  test("GET /api/sessions on a freshly-schema'd, session-less trace → 200 []", async () => {
    const empty = seedEmptyTrace();
    try {
      await withServer(empty.dbPath, async (emptyPort) => {
        const res = await fetch(`http://127.0.0.1:${emptyPort}/api/sessions`, {
          headers: bearer,
        });
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual([]);

        // health still reports ok on a session-less-but-well-formed trace.
        const health = await fetch(`http://127.0.0.1:${emptyPort}/api/health`, {
          headers: bearer,
        });
        const healthBody = (await health.json()) as { ok: boolean; sessions: number };
        expect(healthBody.ok).toBe(true);
        expect(healthBody.sessions).toBe(0);
      });
    } finally {
      empty.cleanup();
    }
  });
});

describe("archive body backstop when no Content-Length is declared (A7-cont)", () => {
  test("chunked body with no Content-Length header still 413s once the read exceeds 1 KB", async () => {
    // A client that streams the body (Transfer-Encoding: chunked) never sends
    // Content-Length at all, so line 332's pre-read refusal is a no-op for
    // it — this is what the post-read Buffer.byteLength check backstops.
    const body = JSON.stringify({ archived: true, pad: "x".repeat(2000) });
    const head = [
      `POST /api/sessions/${EMPTY_REQUEST_ID}/archive HTTP/1.1`,
      `Host: 127.0.0.1:${port}`,
      `Authorization: Bearer ${TOKEN}`,
      "Content-Type: application/json",
      "Transfer-Encoding: chunked",
      "",
      "",
    ].join("\r\n");

    const statusLine = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("no response")), 5000);
      void Bun.connect({
        hostname: "127.0.0.1",
        port,
        socket: {
          open: (socket) => {
            socket.write(head);
            for (let i = 0; i < body.length; i += 200) {
              const chunk = body.slice(i, i + 200);
              socket.write(`${chunk.length.toString(16)}\r\n${chunk}\r\n`);
            }
            socket.write("0\r\n\r\n");
          },
          data: (socket, chunk) => {
            clearTimeout(timer);
            socket.end();
            resolve(new TextDecoder().decode(chunk).split("\r\n")[0] ?? "");
          },
          error: (_socket, error) => {
            clearTimeout(timer);
            reject(error);
          },
        },
      }).catch(reject);
    });

    expect(statusLine).toContain("413");
    expect(archivedFlag(seeded.dbPath, EMPTY_REQUEST_ID)).toBe(0);
  });
});

/** Sentinel thrown by the mocked process.exit, so a "refused" main() unwinds
 * the way the real exit would instead of falling through past its own
 * uninitialized handleResult (main() has no early return after the catch). */
class ExitCalled extends Error {
  constructor(readonly code: number | undefined) {
    super(`process.exit(${code})`);
  }
}

describe("main() entry point (INV-1/INV-5, only reachable via `bun run server/index.ts`)", () => {
  // main() is the CLI entry: import.meta.main is false for every test file
  // (Bun only sets it true for the process's actual entry script), so the
  // module-level `if (import.meta.main) main();` never calls it under `bun
  // test`. main() itself is exported and callable directly, and everything
  // it does — validate, call startVisualizer, log, wire signal handlers, or
  // log-and-exit(1) on refusal — is real behavior worth pinning; the two
  // seams mocked below (startVisualizer, process.exit) are precisely the
  // ones that would otherwise bind a real port or kill this test process.
  // `process.env.X = undefined` stores the string "undefined", not an
  // absent var (Bun's env is a proxy over a string-keyed object) — a
  // later test reading QDS_VIZ_TOKEN/QDS_VIZ_PORT would see that stale
  // literal instead of an unset value. Route the restore through `withEnv`
  // (defined below), which already deletes rather than assigns undefined.
  const withTokenAndPort = (envPort: string, fn: () => void) =>
    withEnv({ QDS_VIZ_TOKEN: TOKEN, QDS_VIZ_PORT: envPort }, fn);

  test("success path: validates, calls startVisualizer once, logs, and wires SIGINT/SIGTERM — without ever binding a real port", () => {
    let dbClosed = false;
    const fakeDb = { close: () => { dbClosed = true; }, path: "/fake/trace.db", journalMode: "wal" };
    const fakeServer = { port: 4601, stop: async () => {} };
    const spy = spyOn(indexMod, "startVisualizer").mockImplementation(
      () => ({ server: fakeServer, db: fakeDb }) as unknown as ReturnType<typeof startVisualizer>,
    );
    const prevSigint = process.listeners("SIGINT");
    const prevSigterm = process.listeners("SIGTERM");
    try {
      withTokenAndPort("4601", () => indexMod.main());
      expect(spy).toHaveBeenCalledTimes(1);
      // Signal handlers were registered by this call — proven by the
      // listener count growing over the pre-call baseline, not just assumed.
      const addedSigint = process.listeners("SIGINT").filter((fn) => !prevSigint.includes(fn));
      const addedSigterm = process.listeners("SIGTERM").filter((fn) => !prevSigterm.includes(fn));
      expect(addedSigint.length).toBeGreaterThan(0);
      expect(addedSigterm.length).toBeGreaterThan(0);

      // Fire the registered SIGINT handler directly (never a real OS signal)
      // and prove its body — db.close() then process.exit(0) — actually
      // runs, not just that the listener was attached.
      const exitSpy = spyOn(process, "exit").mockImplementation((() => undefined) as never);
      try {
        (addedSigint[0] as () => void)();
        expect(dbClosed).toBe(true);
        expect(exitSpy).toHaveBeenCalledWith(0);
      } finally {
        exitSpy.mockRestore();
      }
    } finally {
      // Strip exactly the listeners this call added — a real SIGINT/SIGTERM
      // on this test process must never reach a handler closing a fake db.
      for (const fn of process.listeners("SIGINT")) {
        if (!prevSigint.includes(fn)) process.removeListener("SIGINT", fn as NodeJS.SignalsListener);
      }
      for (const fn of process.listeners("SIGTERM")) {
        if (!prevSigterm.includes(fn)) process.removeListener("SIGTERM", fn as NodeJS.SignalsListener);
      }
      spy.mockRestore();
    }
  });

  test("refusal path: a startup validation failure logs viz_startup_refused and exits 1, never reaching startVisualizer", () => {
    const spy = spyOn(indexMod, "startVisualizer");
    const logged = captureConsoleError();
    const exitSpy = spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new ExitCalled(code);
    }) as never);
    try {
      withTokenAndPort("80", () => {
        // 80 is privileged — validatePort refuses it before startVisualizer
        // is ever called, so this exercises main()'s catch/log/exit path on
        // a plain VizError without touching startVisualizer at all.
        expect(() => indexMod.main()).toThrow(ExitCalled);
      });
      expect(exitSpy).toHaveBeenCalledWith(1);
      expect(spy).not.toHaveBeenCalled();
    } finally {
      exitSpy.mockRestore();
      spy.mockRestore();
      logged.restore();
    }
    expect(logged.text()).toContain("viz_startup_refused");
    expect(logged.text()).toContain("VIZ_PORT_INVALID");
  });

  test("refusal path wraps a non-VizError thrown by startVisualizer into a named VIZ_STARTUP error", () => {
    // main()'s catch coerces ANY thrown error to a named VizError before
    // logging — this pins that coercion for the non-VizError case, which the
    // VIZ_PORT_INVALID case above does not exercise (that one is already a
    // VizError and passes straight through the `error instanceof VizError`
    // branch).
    const spy = spyOn(indexMod, "startVisualizer").mockImplementation(() => {
      throw new Error("plain-error-from-startVisualizer");
    });
    const logged = captureConsoleError();
    const exitSpy = spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new ExitCalled(code);
    }) as never);
    try {
      withTokenAndPort("4602", () => {
        expect(() => indexMod.main()).toThrow(ExitCalled);
      });
      expect(exitSpy).toHaveBeenCalledWith(1);
    } finally {
      exitSpy.mockRestore();
      spy.mockRestore();
      logged.restore();
    }
    expect(logged.text()).toContain("viz_startup_refused");
    expect(logged.text()).toContain("VIZ_STARTUP");
    expect(logged.text()).toContain("plain-error-from-startVisualizer");
  });
});

/** A temp dir per case, never a shared file — mirrors trace-fixture.ts's own
 * temp-root-per-test property so nothing here leaks state between cases. */
function tempTrace(): { dir: string; dbPath: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "df42-unopenable-"));
  return { dir, dbPath: path.join(dir, "trace.db") };
}

describe("AC5 boundary: a trace db that cannot be opened (INV-5, named failure)", () => {
  test("corrupt/garbage bytes: VIZ_TRACE_DB_OPEN naming the path, and the failed attempt leaves nothing locked behind it", () => {
    const { dir, dbPath } = tempTrace();
    try {
      fs.writeFileSync(dbPath, "not a sqlite file at all, just garbage bytes");
      let first: VizError | undefined;
      try {
        const opened = new TraceDb(dbPath);
        opened.close(); // safety net only — unreachable when the throw fires
        throw new Error("expected TraceDb to refuse a corrupt file");
      } catch (error) {
        expect(error).toBeInstanceOf(VizError);
        first = error as VizError;
      }
      expect(first?.code).toBe("VIZ_TRACE_DB_OPEN");
      expect(first?.message).toContain(dbPath);

      // Fail-closed: db?.close() runs in the constructor's catch before the
      // VizError is thrown. If it didn't — a leaked readonly handle — this
      // second attempt would still see the SAME plain corruption error; it
      // would not degrade into a locking error, so this alone doesn't prove
      // much for a corrupt file. What it does prove: the failure is
      // deterministic and repeatable, never "works the second time" from
      // stale state left by the first attempt.
      try {
        const openedAgain = new TraceDb(dbPath);
        openedAgain.close();
        throw new Error("expected the second attempt to refuse identically");
      } catch (error) {
        expect(error).toBeInstanceOf(VizError);
        expect((error as VizError).code).toBe("VIZ_TRACE_DB_OPEN");
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("permission-denied (chmod 000): VIZ_TRACE_DB_OPEN naming the path", () => {
    // Mode bits do not restrict uid 0, and CI containers commonly run as
    // root — in that case the chmod 000 file still opens readonly, so this
    // case is not meaningful there.
    if (typeof process.getuid === "function" && process.getuid() === 0) return;
    const { dir, dbPath } = tempTrace();
    try {
      fs.writeFileSync(dbPath, "");
      fs.chmodSync(dbPath, 0o000);
      try {
        const opened = new TraceDb(dbPath);
        opened.close();
        throw new Error("expected TraceDb to refuse an unreadable file");
      } catch (error) {
        expect(error).toBeInstanceOf(VizError);
        const named = error as VizError;
        expect(named.code).toBe("VIZ_TRACE_DB_OPEN");
        expect(named.message).toContain(dbPath);
      }
    } finally {
      // chmod back before rm — an 0o000 file/dir can otherwise refuse cleanup.
      fs.chmodSync(dbPath, 0o600);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a genuine cross-connection EXCLUSIVE lock past busy_timeout: VIZ_TRACE_DB_OPEN, and releasing it proves nothing leaked", () => {
    // Deterministic, not a race: a real writer holds BEGIN EXCLUSIVE on a
    // non-WAL db, so TraceDb's own busy_timeout=5000 pragma genuinely blocks
    // until sqlite gives up and throws "database is locked" — this reliably
    // takes ~5s, hence the longer per-test timeout below.
    const { dir, dbPath } = tempTrace();
    const setup = new Database(dbPath, { create: true });
    setup.exec("PRAGMA journal_mode = DELETE");
    setup.exec("CREATE TABLE sessions (request_id TEXT)");
    setup.close();

    const locker = new Database(dbPath);
    locker.exec("BEGIN EXCLUSIVE");
    locker.exec("INSERT INTO sessions VALUES ('x')");
    try {
      try {
        const opened = new TraceDb(dbPath);
        opened.close();
        throw new Error("expected TraceDb to refuse a locked db");
      } catch (error) {
        expect(error).toBeInstanceOf(VizError);
        const named = error as VizError;
        expect(named.code).toBe("VIZ_TRACE_DB_OPEN");
        expect(named.message).toContain(dbPath);
      }
    } finally {
      locker.exec("ROLLBACK");
      locker.close();
    }

    try {
      // Fail-closed, concretely: with the real lock now released, a fresh
      // open succeeds immediately — nothing from the failed attempt (a
      // leaked fd or a stray lock) is left behind to block it. (health()
      // isn't asserted here: this fixture's hand-rolled `sessions` table is
      // deliberately minimal and would report schema-drift-degraded
      // regardless — the point is that opening itself no longer throws.)
      const recovered = new TraceDb(dbPath);
      recovered.close();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 15000);
});
