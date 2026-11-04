/**
 * P1.2 — /qds intake: one validated brief → one owned, labeled GitHub issue.
 *
 * Re-homed per the DF5.5 amendment: the spec's Dev-Manager/A2A front door and
 * its session store died with the protocol engine; the live HTTP front door
 * today is the SwarmClaw server (src/swarmclaw), so intake is a route there.
 * INV-2 holds by construction: owner/repo are explicit handler deps, never
 * read from env. The MANDATORY live e2e (a real issue on the real repo) is an
 * outward-facing act — operator-gated, NOT part of this suite.
 */
import { describe, expect, test } from "bun:test";

import {
  IntakeRequestSchema,
  buildIntakeIssue,
  handleIntake,
  makeIntakeRateLimiter,
  makeIntakeService,
  sanitizeBrief,
} from "../../src/swarmclaw/intake.ts";

const DEPS_BASE = {
  owner: "Quantum-Digital-Solutions",
  repo: "e2e-scratch",
  token: "t",
  github: {
    createIssue: async () => ({ issueNumber: 42, htmlUrl: "https://github.com/x/y/issues/42" }),
  },
};

describe("intake schema (P1.2 contract)", () => {
  test("accepts a minimal valid request", () => {
    expect(IntakeRequestSchema.safeParse({ brief: "Add auth middleware", domain: "backend" }).success).toBe(true);
  });

  test("rejects empty and oversize briefs; unknown keys refuse", () => {
    expect(IntakeRequestSchema.safeParse({ brief: "", domain: "backend" }).success).toBe(false);
    expect(IntakeRequestSchema.safeParse({ brief: "x".repeat(281), domain: "backend" }).success).toBe(false);
    expect(IntakeRequestSchema.safeParse({ brief: "ok", domain: "backend", extra: 1 }).success).toBe(false);
  });

  test("rejects invalid domain and priority values", () => {
    expect(IntakeRequestSchema.safeParse({ brief: "ok", domain: "devops" }).success).toBe(false);
    expect(IntakeRequestSchema.safeParse({ brief: "ok", domain: "backend", priority: "urgent" }).success).toBe(false);
  });
});

describe("sanitizeBrief (INV-1)", () => {
  test("strips backticks, quotes, and newlines before the title", () => {
    expect(sanitizeBrief("add `rm -rf` with \"quotes\" and\nnewlines\rand 'single'")).toBe(
      "add rm -rf with quotes and newlines and single",
    );
  });

  test("collapses whitespace runs and trims", () => {
    expect(sanitizeBrief("  spaced   out  \t brief ")).toBe("spaced out brief");
  });

  test("a brief that sanitizes to nothing is unusable (empty check)", () => {
    expect(sanitizeBrief("``` ''' \"\"\"")).toBe("");
  });
});

describe("buildIntakeIssue", () => {
  test("title matches the spec pattern with the 8-hex short id; labels carry qds-intake + domain", () => {
    const sessionId = "123e4567-e89b-42d3-a456-426614174000";
    const built = buildIntakeIssue({ sessionId, brief: "Add auth middleware", domain: "backend" });
    expect(built.title).toBe("[QDS-123e4567] Add auth middleware");
    expect(built.title).toMatch(/^\[QDS-[a-f0-9]{8}\] /);
    expect(built.labels).toEqual(["qds-intake", "backend"]);
    expect(built.body).toContain(sessionId);
  });

  test("a brief longer than the title cap is sliced to fit GitHub's 256-char title limit (full brief stays in the body)", () => {
    const built = buildIntakeIssue({
      sessionId: "12345678-aaaa-bbbb-cccc-000000000000",
      brief: "y".repeat(280),
      domain: "backend",
    });
    expect(built.title.length).toBeLessThanOrEqual(256);
    expect(built.title).toBe(`[QDS-12345678] ${"y".repeat(241)}`);
    expect(built.body).toContain("y".repeat(280));
  });

  test("no domain: labels are just qds-intake", () => {
    const built = buildIntakeIssue({ sessionId: "abcdefgh-0000", brief: "b", domain: undefined });
    expect(built.labels).toEqual(["qds-intake"]);
  });
});

describe("rate limiter (INV-3)", () => {
  test("10 requests per window pass; the 11th refuses; window resets", () => {
    let fakeNow = 0;
    const allow = makeIntakeRateLimiter({ max: 10, windowMs: 60_000, now: () => fakeNow });
    for (let i = 0; i < 10; i++) expect(allow("agent-1")).toBe(true);
    expect(allow("agent-1")).toBe(false);
    expect(allow("agent-2")).toBe(true); // per-key isolation
    fakeNow = 60_001;
    expect(allow("agent-1")).toBe(true); // window slid
  });
});

describe("handleIntake (P1.2 AC1/AC2/AC3)", () => {
  test("valid brief creates exactly one issue; response carries sessionId/issueUrl/issueNumber", async () => {
    let calls = 0;
    const deps = {
      ...DEPS_BASE,
      github: {
        createIssue: async () => {
          calls++;
          return { issueNumber: 7, htmlUrl: "https://github.com/o/r/issues/7" };
        },
      },
    };
    const res = await handleIntake(deps, { brief: "Add auth middleware", domain: "backend" });
    expect(res.status).toBe(201);
    expect(calls).toBe(1);
    expect((res.body as { sessionId: string }).sessionId).toMatch(/^[0-9a-f-]{36}$/);
    expect((res.body as { issueUrl: string }).issueUrl).toBe("https://github.com/o/r/issues/7");
    expect((res.body as { issueNumber: number }).issueNumber).toBe(7);
  });

  test("schema violations return 400 and never reach GitHub", async () => {
    let calls = 0;
    const deps = {
      ...DEPS_BASE,
      github: {
        createIssue: async () => {
          calls++;
          return { issueNumber: 1, htmlUrl: "u" };
        },
      },
    };
    const res = await handleIntake(deps, { brief: "", domain: "backend" });
    expect(res.status).toBe(400);
    expect(calls).toBe(0);
  });

  test("a brief that sanitizes to nothing returns 400 before GitHub", async () => {
    const res = await handleIntake(DEPS_BASE, { brief: "``` '''", domain: "backend" });
    expect(res.status).toBe(400);
  });

  test("GitHub failure maps to the structured -32603 error (AC3)", async () => {
    const deps = {
      ...DEPS_BASE,
      github: {
        createIssue: async () => {
          throw new Error("auth expired");
        },
      },
    };
    const res = await handleIntake(deps, { brief: "ok", domain: "backend" });
    expect(res.status).toBe(500);
    expect((res.body as { error: { code: number; message: string } }).error.code).toBe(-32603);
    expect((res.body as { error: { code: number; message: string } }).error.message).toContain("GitHub issue creation failed");
  });

  test("rate limit breaches return 429 without calling GitHub", async () => {
    let calls = 0;
    const deps = {
      ...DEPS_BASE,
      github: {
        createIssue: async () => {
          calls++;
          return { issueNumber: 1, htmlUrl: "u" };
        },
      },
    };
    const svc = makeIntakeService(deps);
    for (let i = 0; 10 > i; i++) {
      await svc.handle({ brief: String(i), domain: "backend" });
    }
    const res = await svc.handle({ brief: "eleven", domain: "backend" });
    expect(res.status).toBe(429);
    expect(calls).toBe(10);
  });
});
