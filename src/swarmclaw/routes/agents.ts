/**
 * POST /api/agents — register a SwarmClaw agent (INV-SC1 + SSRF-safe endpointUrl).
 */

import { log, newRequestId } from "../mcp/stdio-transport.ts";
import {
  type AgentStore,
  CapacityError,
  DuplicateAgentError,
  isLoopbackEndpoint,
  RegisterAgentSchema,
} from "../store/agent-store.ts";

export interface RouteResponse {
  status: number;
  body: unknown;
}

export async function handleRegisterAgent(
  store: AgentStore,
  payload: unknown,
  requestId = newRequestId(),
): Promise<RouteResponse> {
  const start = Date.now();
  const parsed = RegisterAgentSchema.safeParse(payload);
  if (!parsed.success) {
    return finish(start, requestId, null, {
      status: 400,
      body: { error: "invalid agent registration", details: parsed.error.issues },
    });
  }
  const input = parsed.data;

  if (input.endpointUrl) {
    // The SSRF guard is "local HTTP POST only" — z.string().url() accepts any
    // scheme (e.g. ftp://), so restrict to HTTP(S) before the loopback check.
    // new URL cannot throw here: z.string().url() already parsed it.
    const proto = new URL(input.endpointUrl).protocol;
    if (proto !== "http:" && proto !== "https:") {
      return finish(start, requestId, input.agentId, {
        status: 422,
        body: { error: `endpointUrl must use http(s) scheme: ${input.endpointUrl}` },
      });
    }
    const loopback = await isLoopbackEndpoint(input.endpointUrl);
    if (!loopback) {
      return finish(start, requestId, input.agentId, {
        status: 422,
        body: { error: `endpointUrl must resolve to loopback (SSRF guard): ${input.endpointUrl}` },
      });
    }
  }

  try {
    const record = store.create(input);
    return finish(start, requestId, record.agentId, { status: 201, body: record });
  } catch (err) {
    if (err instanceof DuplicateAgentError) {
      return finish(start, requestId, input.agentId, {
        status: 409,
        body: { error: err.message },
      });
    }
    if (err instanceof CapacityError) {
      return finish(start, requestId, input.agentId, {
        status: 429,
        body: { error: err.message },
      });
    }
    throw err;
  }
}

function finish(
  start: number,
  requestId: string,
  agentId: string | null,
  resp: RouteResponse,
): RouteResponse {
  log({
    requestId,
    operation: "agent.register",
    agentId,
    timestamp: new Date().toISOString(),
    duration: Date.now() - start,
    status: resp.status < 400 ? "ok" : "error",
    ...(resp.status >= 400
      ? { error: { code: String(resp.status), message: deriveErrorMessage(resp.body, "agent registration failed") } }
      : {}),
  });
  return resp;
}

/** CC-9: surface the real error message from the response body when present. */
export function deriveErrorMessage(body: unknown, fallback: string): string {
  if (body !== null && typeof body === "object") {
    const err = (body as Record<string, unknown>).error;
    if (typeof err === "string") return err;
    if (err !== null && typeof err === "object") {
      const msg = (err as Record<string, unknown>).message;
      if (typeof msg === "string") return msg;
    }
  }
  return fallback;
}
