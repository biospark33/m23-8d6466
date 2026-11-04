/**
 * P1.2 — /qds intake: one validated brief → one owned, labeled GitHub issue.
 *
 * Re-homed per the DF5.5 amendment: the spec's Dev-Manager/A2A front door and
 * its session store died with the protocol engine, so intake lands on the
 * LIVE HTTP front door — the SwarmClaw server — as a route. The spec's
 * "SwarmClaw session" has no surviving store; the ISSUE itself is the durable
 * trace: the sessionId is minted here, embedded in the issue body (the
 * traceability clause), and returned. A failed issue creation therefore
 * leaves nothing behind — the "no orphan active sessions" rollback clause is
 * satisfied by construction (nothing pre-exists to orphan).
 *
 * INV-1: the brief passes sanitization before it reaches the title — backticks
 * and quotes (markdown/shell injection material), CR/LF (title smuggling).
 * INV-2 holds by construction: owner/repo/token are explicit handler deps;
 * nothing reads a repo from the environment. INV-3: a per-key sliding-window
 * limiter (10/min) runs BEFORE the GitHub call.
 */
import { randomUUID } from "node:crypto";
import { z } from "zod";

export const INTAKE_DOMAINS = ["backend", "frontend", "infra", "docs", "test"] as const;
export const INTAKE_PRIORITIES = ["low", "normal", "high"] as const;
/** INV-3: max intake calls per window per requester key. */
export const INTAKE_RATE_MAX = 10;
export const INTAKE_RATE_WINDOW_MS = 60_000;

export const IntakeRequestSchema = z
  .strictObject({
    brief: z.string().min(1).max(280),
    domain: z.enum(INTAKE_DOMAINS).optional(),
    priority: z.enum(INTAKE_PRIORITIES).optional(),
  })
  .strict();

export type IntakeRequest = z.infer<typeof IntakeRequestSchema>;

export interface IntakeDeps {
  owner: string;
  repo: string;
  token: string;
  /** The one GitHub seam — createIssue only; intake never needs more. */
  github: {
    createIssue(o: {
      owner: string;
      repo: string;
      title: string;
      body: string;
      token: string;
      labels?: string[];
    }): Promise<{ issueNumber: number; htmlUrl: string }>;
  };
  /** Injectable limiter (tests pass a fake-now one). */
  rateLimiter?: (key: string) => boolean;
  /** Injectable id mint (tests pin it for assertions). */
  mintSessionId?: () => string;
}

export interface IntakeRouteResponse {
  status: number;
  body: unknown;
}

/** INV-1: strip the injection + smuggling material, collapse whitespace, trim. */
export function sanitizeBrief(brief: string): string {
  return brief
    .replace(/[`"'\n\r\t]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Spec title convention: `[QDS-{first 8 hex}] {brief}`.
 *
 * GitHub rejects issue titles over 256 chars, and the 15-char prefix eats into
 * that: the brief is sliced to 241 so the title always fits. The FULL brief
 * still lives in the body — the title is a label, not the record.
 */
export const TITLE_BRIEF_CAP = 241;

export function buildIntakeIssue(o: { sessionId: string; brief: string; domain?: string }): {
  title: string;
  body: string;
  labels: string[];
} {
  const title = `[QDS-${o.sessionId.slice(0, 8)}] ${o.brief.slice(0, TITLE_BRIEF_CAP)}`;
  const body = [
    "QDS intake record.",
    "",
    `sessionId: ${o.sessionId}`,
    `domain: ${o.domain ?? "unspecified"}`,
    "",
    "Brief:",
    "",
    o.brief,
  ].join("\n");
  return { title, body, labels: o.domain === undefined ? ["qds-intake"] : ["qds-intake", o.domain] };
}

/**
 * Sliding-window limiter (INV-3). Returns false when the key is over budget.
 * The key vocabulary exists for per-requester buckets, but the intake surface
 * carries no requester identity (no identity layer survives the protocol
 * engine), so the deployed service uses ONE endpoint-wide bucket — one
 * hostile client can starve the rest for a window. Fail-closed direction;
 * per-agent attribution is the recorded re-home delta.
 */
export function makeIntakeRateLimiter(o: { max: number; windowMs: number; now?: () => number }): (key: string) => boolean {
  const now = o.now ?? Date.now;
  const hits = new Map<string, number[]>();
  return (key: string): boolean => {
    const t = now();
    const prev = (hits.get(key) ?? []).filter((h) => t - h < o.windowMs);
    if (prev.length >= o.max) {
      hits.set(key, prev);
      return false;
    }
    prev.push(t);
    hits.set(key, prev);
    return true;
  };
}

export class IntakeGitHubError extends Error {
  readonly code = -32603;
  constructor(reason: string) {
    super(`GitHub issue creation failed: ${reason}`);
    this.name = "IntakeGitHubError";
  }
}

/**
 * The intake handler. Validates, sanitizes, rate-limits, mints the sessionId,
 * creates exactly one labeled issue, and returns {sessionId, issueUrl,
 * issueNumber}. The route layer (routes/intake.ts) adapts this to the server.
 */
export async function handleIntake(
  deps: IntakeDeps,
  payload: unknown,
): Promise<IntakeRouteResponse> {
  const parsed = IntakeRequestSchema.safeParse(payload);
  if (!parsed.success) {
    return { status: 400, body: { error: "invalid intake request", details: parsed.error.issues } };
  }
  const brief = sanitizeBrief(parsed.data.brief);
  if (brief === "") {
    return { status: 400, body: { error: "brief sanitizes to empty" } };
  }
  const key = "intake";
  if (deps.rateLimiter !== undefined && !deps.rateLimiter(key)) {
    return { status: 429, body: { error: `rate limit exceeded: max ${INTAKE_RATE_MAX} per ${INTAKE_RATE_WINDOW_MS / 1000}s` } };
  }
  const sessionId = (deps.mintSessionId ?? randomUUID)();
  const { title, body, labels } = buildIntakeIssue({ sessionId, brief, domain: parsed.data.domain });
  try {
    const created = await deps.github.createIssue({
      owner: deps.owner,
      repo: deps.repo,
      title,
      body,
      token: deps.token,
      labels,
    });
    return { status: 201, body: { sessionId, issueUrl: created.htmlUrl, issueNumber: created.issueNumber } };
  } catch (err) {
    const reason = err instanceof Error && err.message !== "" ? err.message : String(err);
    return { status: 500, body: { error: { code: -32603, message: new IntakeGitHubError(reason).message } } };
  }
}

/**
 * Service form: constructs the handler ONCE with its own limiter state (the
 * stateless `handleIntake` above creates a fresh limiter per call, which
 * enforces nothing — the route layer uses THIS).
 */
export function makeIntakeService(deps: IntakeDeps): {
  handle(payload: unknown): Promise<IntakeRouteResponse>;
} {
  const limiter = deps.rateLimiter ?? makeIntakeRateLimiter({ max: INTAKE_RATE_MAX, windowMs: INTAKE_RATE_WINDOW_MS });
  return { handle: (payload) => handleIntake({ ...deps, rateLimiter: limiter }, payload) };
}
