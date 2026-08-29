/**
 * One `fetch` contract for the whole repo (F063).
 *
 * Four modules had independently hand-rolled the same wrapper — a timeout, a
 * retry policy, a body encoder, an error mapping — and drifted on every one of
 * them. What actually differs between callers is POLICY, not mechanism, so the
 * mechanism lives here once and each caller passes its own policy: its timeout,
 * whether a transient failure is retried, its headers, and the error class it
 * throws. Nothing is defaulted that a caller ought to decide, and nothing here
 * knows what a GitHub, a Hindsight or a SwarmClaw response means.
 *
 * The response is returned RAW (plus its already-read body text) — parsing,
 * schema validation and telemetry belong to the caller, which is why no
 * `Response` is ever consumed twice.
 */

export interface HttpPolicy {
  /** Per-attempt budget. The whole call can take up to `maxAttempts` of these. */
  timeoutMs: number;
  headers?: Record<string, string>;
  /** Attempts INCLUDING the first. Default 1 — a retry is opt-in, never a surprise replay of a write. */
  maxAttempts?: number;
  /** Which non-2xx is a hiccup worth retrying. Only consulted when attempts remain. */
  retryOn?: (res: Response) => boolean;
  /** How long to wait before retrying `res`. Default 1 s. */
  retryDelayMs?: (res: Response) => number;
  /**
   * The error thrown for a non-2xx. `text` is the body, or null when the body
   * itself could not be read. OMIT to have the response RETURNED instead —
   * callers that treat a status as data (a 404 that means "not registered")
   * never want a throw.
   */
  onHttpError?: (res: Response, text: string | null) => Error;
  /**
   * The error thrown for a timeout or a transport failure. `timedOut` is true
   * only when THIS wrapper's own deadline fired. Default: rethrow as-is.
   */
  onTransportError?: (e: unknown, timedOut: boolean) => Error;
}

export interface HttpResult {
  res: Response;
  /** The body, already read. Empty string when it could not be read. */
  text: string;
}

/** Ceiling on an honoured `retry-after`; a longer one is not waited out. */
export const MAX_RETRY_AFTER_MS = 60_000;

/** `retry-after` in ms, falling back to 1 s for a missing or unusable header. */
export function retryAfterMs(res: Response): number {
  const raw = res.headers.get("retry-after");
  if (raw === null) return 1_000;
  const seconds = Number(raw);
  if (!Number.isFinite(seconds) || seconds < 0) return 1_000;
  return Math.min(seconds * 1_000, MAX_RETRY_AFTER_MS);
}

/**
 * One request under `policy`.
 *
 * `AbortController` + a timer rather than `AbortSignal.timeout`: the two raise
 * DIFFERENT error names (`AbortError` vs `TimeoutError`), and callers key their
 * timeout mapping off the former. The `timedOut` flag handed to
 * `onTransportError` is authoritative regardless.
 */
export async function httpRequest(
  url: string,
  init: { method?: string; body?: unknown },
  policy: HttpPolicy,
): Promise<HttpResult> {
  const maxAttempts = policy.maxAttempts ?? 1;
  const method = init.method ?? "GET";
  const headers: Record<string, string> = {
    ...(init.body !== undefined ? { "content-type": "application/json" } : {}),
    ...policy.headers,
  };

  let lastError: unknown;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, policy.timeoutMs);

    let res: Response;
    try {
      res = await fetch(url, {
        method,
        headers,
        ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
        signal: controller.signal,
      });
    } catch (e) {
      // A timeout or a transport failure is retriable on the same budget as a
      // retriable status.
      lastError = policy.onTransportError ? policy.onTransportError(e, timedOut) : e;
      if (attempt < maxAttempts - 1) continue;
      throw lastError;
    } finally {
      clearTimeout(timer);
    }

    const text = await res.text().catch(() => null);
    if (!res.ok) {
      if (attempt < maxAttempts - 1 && policy.retryOn?.(res)) {
        await Bun.sleep(policy.retryDelayMs?.(res) ?? 1_000);
        continue;
      }
      if (policy.onHttpError) throw policy.onHttpError(res, text);
    }
    return { res, text: text ?? "" };
  }
  // Unreachable: every path above returns or throws. Kept so the signature does
  // not depend on the compiler's flow analysis holding.
  throw lastError ?? new Error(`${method} ${url} failed`);
}
