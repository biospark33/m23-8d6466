/**
 * DF4.1 route tests (AC2, AC3, AC4, INV-3/4, DoD contract items).
 *
 * In-process Bun.serve on 127.0.0.1:0 against real DF1.4 trace dbs seeded by
 * the real Tracer (see fixtures/trace-fixture.ts).
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import * as path from "node:path";
import {
  seedTrace,
  seedManyEvents,
  EMPTY_REQUEST_ID,
  FIXTURE_REQUEST_ID,
  MANY_REQUEST_ID,
  PHASE_AGENT,
  PHASE_ENGINEER,
} from "./fixtures/trace-fixture.ts";
import { startVisualizer } from "../server/index.ts";
import { VizError } from "../server/auth.ts";

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
    expect(body.map((p) => p.name).sort()).toEqual(["engineer", "planner"]);
    // payload_json passes through verbatim — DF1.4's {agentId, prompt, model}.
    const parsed = JSON.parse(body[0]?.payload_json ?? "{}") as {
      agentId?: string;
      prompt?: string;
      model?: string;
    };
    expect(parsed.prompt).toContain("compiled");
    expect(parsed.agentId).toBe(body[0]?.name);
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
    expect(rowids).toEqual([...rowids].sort((a, b) => a - b));
    expect(body.cursor).toBe(rowids[rowids.length - 1]);
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
    const res = await post(JSON.stringify({ archived: true }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ request_id: EMPTY_REQUEST_ID, archived: true });
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
    // Restore first so the no-write is observable in the L1 listing.
    const restore = await post(JSON.stringify({ archived: false }));
    expect(restore.status).toBe(200);
    const res = await post("this is not json");
    expect(res.status).toBe(400);
    const { body } = await getJson<Array<{ request_id: string }>>("/api/sessions");
    expect(body.some((s) => s.request_id === EMPTY_REQUEST_ID)).toBe(true);
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
        const failed = await fetch(`${url}/api/sessions`, { headers: bearer });
        expect(failed.status).toBe(500);
        const errBody = (await failed.json()) as { error: string };
        expect(errBody.error).toContain("archived");

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
