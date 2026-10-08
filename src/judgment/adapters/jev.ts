/**
 * `jev` adapter (v6 J1) — the TypeSafe live transport, moved verbatim from
 * JEV-2's `JudgmentClient.post()`. It sends the seam-built request and
 * returns the raw parsed JSON body; validation is the seam's job, never this
 * module's.
 *
 * INV-J1: the key is read once by the seam client at construction and handed
 * ONLY to this maker; the made transport closes over it and never exposes it.
 *
 * POST-replay safety (stated at the call site, per the credentials.ts
 * idempotent-verb-only precedent): these POSTs are read-only judgments —
 * replaying the same questions yields the same answers, no server-side
 * state, no charge beyond the input tokens already reported in `usage`.
 * maxAttempts is therefore 2, retryOn 429/529 only; 401/422 are fatal on
 * the first attempt (auth/validation problems do not heal on retry).
 */

import { httpRequest, retryAfterMs } from "../../lib/http.ts";
import { JudgmentHttpError } from "../errors.ts";
import type { JudgmentProvider } from "../provider.ts";
import type { JudgmentRequest } from "../schemas.ts";

/** Attempts INCLUDING the first — exactly one retry, 429/529 only (§4). */
export const DEFAULT_MAX_ATTEMPTS = 2;

export interface JevProviderConfig {
  /** `TYPESAFE_API_KEY`, as read once by the seam client. */
  apiKey: string | undefined;
  /** Origin without trailing slash; the path is always /v1/systemone. */
  baseUrl: string;
  /** Per-attempt budget. */
  timeoutMs: number;
  /** Test-only retry-delay override so backoff tests never sleep wall-clock. */
  retryDelayMs?: number;
}

export function makeJevProvider(config: JevProviderConfig): JudgmentProvider {
  const { apiKey, baseUrl, timeoutMs, retryDelayMs } = config;
  return Object.freeze({
    id: "jev" as const,
    /**
     * Live POST. Retry posture is stated here ON PURPOSE (not inherited): see
     * the header note on POST-replay safety — maxAttempts 2, 429/529 only,
     * delay from `retry-after` capped at MAX_RETRY_AFTER_MS; 401/422 fatal on
     * attempt one with the (truncated) body carried in the thrown error.
     */
    ask: async (request: JudgmentRequest, requestId: string): Promise<unknown> => {
      const { text } = await httpRequest(
        `${baseUrl}/v1/systemone`,
        { method: "POST", body: request },
        {
          timeoutMs,
          headers: {
            "content-type": "application/json",
            ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
            "x-request-id": requestId,
          },
          maxAttempts: DEFAULT_MAX_ATTEMPTS,
          retryOn: (res) => res.status === 429 || res.status === 529,
          retryDelayMs: (res) => retryDelayMs ?? retryAfterMs(res),
          onHttpError: (res, raw) =>
            new JudgmentHttpError(
              res.status,
              `TypeSafe API returned HTTP ${res.status}: ${safeMessage(raw)}`,
              requestId,
              truncate(raw),
            ),
          onTransportError: (e, timedOut) =>
            timedOut
              ? new JudgmentHttpError(408, `TypeSafe judge timed out after ${timeoutMs}ms`, requestId, "")
              : new JudgmentHttpError(502, `TypeSafe judge fetch failed: ${(e as Error).message}`, requestId, ""),
        },
      );
      try {
        return text.length === 0 ? {} : JSON.parse(text);
      } catch {
        throw new JudgmentHttpError(502, `TypeSafe returned a non-JSON body: ${truncate(text)}`, requestId, truncate(text));
      }
    },
  });
}

// ---------------------------------------------------------------------------
// Helpers (hindsight idiom)
// ---------------------------------------------------------------------------

function truncate(s: string, max = 512): string {
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

/** Defensively extract a SAFE message from a non-2xx body (INV-HM5 idiom). */
function safeMessage(text: string): string {
  if (text.length === 0) return "(empty body)";
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return truncate(text);
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return truncate(JSON.stringify(parsed));
  }
  const obj = parsed as { message?: unknown; error?: unknown; detail?: unknown };
  for (const key of ["message", "error", "detail"] as const) {
    const v = obj[key];
    if (typeof v === "string") return truncate(v);
  }
  return truncate(JSON.stringify(parsed));
}
