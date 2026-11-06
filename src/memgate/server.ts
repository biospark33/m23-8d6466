/**
 * M2 gateway HTTP server — the Z4 compose slot's 8080 listener (the piece
 * `src/memgate/index.ts` explicitly left out of M2.1's scope: "future Z4 8080
 * image's HTTP listener"). The authz stays the library's: every request is
 * `verifyRequest` -> `forwardScoped` over the closed VERB_ROUTES table; this
 * adapter adds ONLY Bun.serve, request-id minting, and the error->HTTP
 * mapping. Boot is fail-closed: `memgateDeps()` refuses without
 * MEMGATE_ADMIN_KEY / QDS_MEMGATE_SIGNING_KEY before anything listens.
 *
 * Wire contract of record: the kg-recall client
 * (pi-vs-claude-code-vendor/kg-recall/extensions/kg-recall/client.ts) and the
 * M2.3 battery (scripts/e2e/memory-negative-probes.ts) - POST
 * /v1/default/banks/{bank}/memories/recall, Bearer key, JSON body; 2xx =
 * answer; non-2xx {error:{code}} whose code is in MEMGATE_REFUSAL_REASONS =
 * refusal; anything else = transport-class. The closed refusal set is never
 * widened: an unexpected server fault answers 500 {error:{code:"internal"}}
 * (an out-of-set code reads transport-class downstream, exactly right for a
 * server fault).
 *
 * INV-MG-5/6: no material in logs/errors; the server adds no log vocabulary -
 * the library's emit lines ride deps.log unchanged.
 */
import { randomUUID } from "node:crypto";

import { HindsightClient } from "../hindsight/client.ts";
import { forwardScoped, memgateDeps, verifyRequest } from "./gateway.ts";
import { matchRoute } from "./forward.ts";
import {
  MemgateError,
  type MemgateClient,
  type MemgateDeps,
  type MemgateDepsOptions,
  type MemgatePrincipal,
} from "./schemas.ts";

/**
 * The refusal taxonomy's HTTP face. The client classifies by error.code, not
 * by status; statuses are conventional: 401 credential-class, 403
 * scope-class, 400 request-shape, 500 store-fault. Codes outside this map
 * answer 500 (transport-class downstream, closed set unpolluted).
 */
export const STATUS_BY_CODE: Record<string, number> = {
  "no-auth": 401,
  "admin-auth": 401,
  "expired": 401,
  "revoked": 401,
  "scope-bank": 403,
  "scope-verb": 403,
  "ledger-unreadable": 500,
  "mint-invalid-ttl": 400,
};

/** One request's wire outcome (the test seam; Bun.serve is a thin shell). */
export interface MemgateRequestOutcome {
  status: number;
  /** Answers verbatim; refusals in the {error:{code, message?, remediation?}}
   * shape the kg-recall client and the M2.3 battery parse. */
  body: string;
  contentType: string;
}

/** MemgateError -> wire outcome. Out-of-map codes answer 500. */
function outcomeFor(e: MemgateError): MemgateRequestOutcome {
  const status = STATUS_BY_CODE[e.code] ?? 500;
  const error: { code: string; message?: string; remediation?: string } = { code: e.code };
  if (e.message !== "") error.message = e.message;
  if (e.remediation !== "") error.remediation = e.remediation;
  return { status, body: JSON.stringify({ error }), contentType: "application/json" };
}

/**
 * Handle ONE request against the given deps. Pure over its inputs (deps
 * carry client/ledger/now), so the contract tests drive the exact production
 * path without a socket.
 */
export async function handleMemgateRequest(
  deps: MemgateDeps,
  input: { method: string; path: string; authHeader: string; bodyText: string },
): Promise<MemgateRequestOutcome> {
  const requestId = randomUUID();
  // Route first: an unmapped path is scope-verb (in-set, 403) before any
  // auth material is examined - the route table is not a secret.
  const route = matchRoute(input.method, input.path);
  if (route === null) {
    return outcomeFor(new MemgateError("scope-verb", `no route is mapped for ${input.method} ${input.path}`, "the closed VERB_ROUTES table maps POST recall/reflect/consolidate/retain only"));
  }
  let body: unknown = undefined;
  if (input.bodyText !== "") {
    try {
      body = JSON.parse(input.bodyText);
    } catch {
      return outcomeFor(new MemgateError("scope-verb", "request body is not valid JSON", "send the JSON body the matched route's contract names"));
    }
  }
  // verifyRequest walks the credential ladder and emits its own refused
  // lines through deps. ok:false -> refusal; ok:true -> forward.
  const verified = verifyRequest(deps, {
    authHeader: input.authHeader,
    method: input.method,
    path: input.path,
    requestId,
  });
  if (!verified.ok) {
    return outcomeFor(new MemgateError(verified.reason, verified.reason, "re-mint or re-grant the credential as the refusal names"));
  }
  const principal: MemgatePrincipal = verified.principal;
  try {
    // forwardScoped RE-checks revoked/expired (F-004) and validates the body
    // (F-023); exactly one attempt, no retries (D4).
    const answer = await forwardScoped(deps, principal, input.method, input.path, body, requestId);
    return { status: 200, body: JSON.stringify(answer ?? {}), contentType: "application/json" };
  } catch (e) {
    if (e instanceof MemgateError) return outcomeFor(e);
    return {
      status: 500,
      body: JSON.stringify({ error: { code: "internal", message: "the gateway hit an unexpected fault serving this request" } }),
      contentType: "application/json",
    };
  }
}

/**
 * Build the server's deps from env (fail-closed boot), wire the Hindsight
 * client, start listening on 0.0.0.0:8080, and return the stop handle. The
 * compose healthcheck probes TCP 8080 from inside the container (nc -z); no
 * HTTP route is owed to it. The compose slot publishes NO ports - the only
 * public reach is Caddy -> m2-gateway:8080 across the front-door network.
 */
export function serveMemgate(opts: { port?: number; depsOpts?: MemgateDepsOptions; client?: MemgateClient } = {}): { stop: () => void; port: number } {
  const deps = memgateDeps({ ...opts.depsOpts, client: opts.client ?? opts.depsOpts?.client ?? new HindsightClient() });
  const server = Bun.serve({
    port: opts.port ?? 8080,
    hostname: "0.0.0.0",
    async fetch(req: Request): Promise<Response> {
      const url = new URL(req.url);
      const bodyText = req.method === "POST" ? await req.text() : "";
      const outcome = await handleMemgateRequest(deps, {
        method: req.method,
        path: url.pathname,
        authHeader: req.headers.get("authorization") ?? "",
        bodyText,
      });
      return new Response(outcome.body, { status: outcome.status, headers: { "content-type": outcome.contentType } });
    },
  });
  return { stop: () => server.stop(true), port: server.port ?? opts.port ?? 8080 };
}

if (import.meta.main) {
  serveMemgate();
  process.stderr.write("m2-gateway listening on 0.0.0.0:8080\n");
}
