/**
 * The forward surface (M2.1 D6 split): the closed verb→route table, route
 * parsing, and strict forward-body validation. Hoisted from schemas.ts by the
 * round-2 fix wave to hold the 500-line pin; schemas.ts re-exports every
 * symbol here, so all existing imports (gateway, barrel, tests) hold.
 */
import { MemgateError, type AgentVerb } from "./schemas.ts";

/** One bank-scoped route template. `{bankId}` is the capture slot. */
export interface MemgateRoute {
  readonly method: "POST";
  readonly path: string;
}

/**
 * The closed verb→route table (client.ts:4-6; R3 §7 closure). Everything else
 * bank-scoped — mental-models, config, transfer, DELETE, … — is UNMAPPED and
 * default-refuses with `scope-verb`. POST only (D4): the forward path never
 * retries a non-POST because it never issues one.
 */
export const VERB_ROUTES: Readonly<Record<AgentVerb, readonly MemgateRoute[]>> = {
  recall: [{ method: "POST", path: "/v1/default/banks/{bankId}/memories/recall" }],
  reflect: [{ method: "POST", path: "/v1/default/banks/{bankId}/reflect" }],
  consolidate: [{ method: "POST", path: "/v1/default/banks/{bankId}/consolidate" }],
  retain: [
    { method: "POST", path: "/v1/default/banks/{bankId}/memories" },
    { method: "POST", path: "/v1/default/banks/{bankId}/files/retain" },
  ],
};

const BANK_ROUTE_PREFIX = "/v1/default/banks/{bankId}";

/** Bank id out of a bank-scoped request path, or undefined (scope-bank check). */
export function bankOfPath(path: string): string | undefined {
  const m = /^\/v1\/default\/banks\/([^/]+)(?:\/|$)/.exec(path);
  return m === null ? undefined : m[1];
}

/** Bank-scoped route → {verb, bankId}, or null when unmapped (default-refuse). */
export function matchRoute(method: string, path: string): { verb: AgentVerb; bankId: string } | null {
  if (!path.startsWith("/v1/default/banks/")) return null;
  const rest = path.slice("/v1/default/banks/".length);
  const slash = rest.indexOf("/");
  if (slash <= 0) return null; // no bank/suffix pair ("GET /v1/default/banks", "/banks/x")
  const bankId = rest.slice(0, slash);
  const suffix = rest.slice(slash);
  for (const verb of Object.keys(VERB_ROUTES) as AgentVerb[]) {
    for (const route of VERB_ROUTES[verb]) {
      if (route.method === method && suffix === route.path.slice(BANK_ROUTE_PREFIX.length)) {
        return { verb, bankId };
      }
    }
  }
  return null;
}

/** The retain content ceiling (F-023) — oversized content refuses, never forwards. */
export const MAX_RETAIN_CONTENT_CHARS = 1_000_000;

/** One validated forward call — the exact client args for the matched verb.
 * Strict body validation (F-023): a present body must be a JSON object (E1);
 * a present limit must be an integer in [1, 1000] (R2-F-006 — silent undefined
 * coercion would widen the call, the exact hazard the query arm refuses); a
 * present query MUST be a string; retain content must be a string (R2-F-005)
 * and is size-capped; consolidate options (E2) and retain metadata (E3) must
 * be plain objects under the same ceiling. Violations throw the typed
 * forward-body refusal. */
export type ForwardArgs =
  | { verb: "recall"; args: [query: string | undefined, limit: number | undefined] }
  | { verb: "reflect"; args: [query: string | undefined] }
  | { verb: "consolidate"; args: [options: { maxAge?: number; preserveRecent?: number } | undefined] }
  | { verb: "retain"; args: [content: unknown, metadata: unknown] };

/** E1/E2/E3 shared gate: value must be a plain JSON object when present. */
function requirePlainObject(what: string, v: unknown): Record<string, unknown> {
  if (typeof v !== "object" || v === null || Array.isArray(v)) {
    throw new MemgateError("forward-body-invalid",
      `${what} must be a plain JSON object when present (got ${Array.isArray(v) ? "array" : typeof v}) — a non-object would silently widen or ride the forward unchecked`,
      `pass ${what} as a JSON object, or omit it`);
  }
  return v as Record<string, unknown>;
}

/** E2/E3 shared ceiling: the payload must be measurable AND under the cap. */
function refuseOversized(what: string, v: object): void {
  const size = JSON.stringify(v).length;
  if (size > MAX_RETAIN_CONTENT_CHARS) {
    throw new MemgateError("forward-body-invalid",
      `${what} serializes to ${size} chars, over the ${MAX_RETAIN_CONTENT_CHARS}-char ceiling — refusing instead of forwarding`,
      "chunk or shrink the payload");
  }
}

export function parseForwardBody(verb: AgentVerb, body: unknown): ForwardArgs {
  // E1: only null/undefined degrade to a body-less call — a string/number/array
  // body must REFUSE, not silently widen to an unfiltered default forward.
  if (body !== undefined && body !== null && (typeof body !== "object" || Array.isArray(body))) {
    throw new MemgateError("forward-body-invalid",
      `body must be a JSON object when present (got ${Array.isArray(body) ? "array" : typeof body}) — a non-object body would silently widen to a body-less forward`,
      "pass a JSON object body, or omit it");
  }
  const b = (body ?? {}) as Record<string, unknown>;
  // R2-F-006: a present limit that is not an integer in [1, 1000] REFUSES on
  // every verb — dropping it to undefined silently widens the call.
  if (b.limit !== undefined
    && (typeof b.limit !== "number" || !Number.isInteger(b.limit) || b.limit < 1 || b.limit > 1000)) {
    throw new MemgateError("forward-body-invalid",
      `limit must be an integer in [1, 1000] when present (got ${String(b.limit)}) — silently dropping it would widen the call to the client default`,
      "pass limit as an integer in [1, 1000], or omit it");
  }
  const limit = typeof b.limit === "number" ? b.limit : undefined;
  const query = (v: unknown): string | undefined => {
    if (v === undefined) return undefined;
    if (typeof v !== "string") {
      throw new MemgateError("forward-body-invalid",
        `query must be a string when present (got ${typeof v}) — a dropped non-string would silently widen the call to unfiltered`,
        "pass query as a string");
    }
    return v;
  };
  switch (verb) {
    case "recall":
      return { verb, args: [query(b.query), limit] };
    case "reflect":
      return { verb, args: [query(b.query)] };
    case "consolidate": {
      // E2: options is shape-checked and measured like its retain siblings — a
      // blob must not ride an object-typed field past the ceiling, and a present
      // non-number maxAge/preserveRecent must not drop silently to the default.
      if (b.options === undefined) return { verb, args: [undefined] };
      const options = requirePlainObject("consolidate options", b.options);
      for (const key of ["maxAge", "preserveRecent"] as const) {
        if (options[key] !== undefined && typeof options[key] !== "number") {
          throw new MemgateError("forward-body-invalid",
            `consolidate options.${key} must be a number when present (got ${String(options[key])}) — a dropped non-number would silently widen the call to the client default`,
            `pass options.${key} as a number, or omit it`);
        }
      }
      refuseOversized("consolidate options", options);
      return { verb, args: [options as { maxAge?: number; preserveRecent?: number }] };
    }
    case "retain": {
      // R2-F-005: only strings are measurable against the ceiling — a present
      // non-string content must not forward at all.
      if (b.content !== undefined && typeof b.content !== "string") {
        throw new MemgateError("forward-body-invalid",
          `retain content must be a string when present (got ${typeof b.content}) — an unmeasurable body cannot be size-checked`,
          "pass content as a string");
      }
      const content = b.content as string | undefined;
      if (content !== undefined && content.length > MAX_RETAIN_CONTENT_CHARS) {
        throw new MemgateError("forward-body-invalid",
          `retain content exceeds the ${MAX_RETAIN_CONTENT_CHARS}-char ceiling — refusing instead of forwarding`,
          "chunk the content into smaller retain calls");
      }
      if (b.metadata !== undefined) { // E3: metadata is a plain object under the same ceiling
        const metadata = requirePlainObject("retain metadata", b.metadata);
        refuseOversized("retain metadata", metadata);
      }
      return { verb, args: [content, b.metadata] };
    }
  }
}
