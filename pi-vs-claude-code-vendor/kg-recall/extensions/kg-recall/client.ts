/**
 * kg-recall client — the one fetch wrapper for the M2 memory gateway's recall
 * route.
 *
 * ONE POST {gatewayUrl}/v1/default/banks/{bank}/memories/recall, ONE attempt,
 * never retried (D4: a refused or unreachable gateway is surfaced to the model
 * verbatim, not papered over). The Authorization header carries the per-run
 * recall-only key; nothing here ever sends a write verb.
 *
 * Refusals pass through verbatim: a non-2xx body whose error.code is INSIDE
 * the closed 8-member MemgateRefusalReason set (mirrored below— the extension is standalone and
 * must not import src/) becomes `{ ok:false, reason: code }` with the
 * gateway's message or an explicit placeholder when the gateway omitted one— the caller
 * reports that token, never a paraphrase. Anything else — missing/unparseable
 * error body, or a code OUTSIDE the closed set — is a transport-class failure
 * carrying the raw token in the message text, never as `reason`. A 2xx body
 * without a `results` array is likewise transport-class (shape drift), never a
 * silent empty success; an actual `results: []` is genuine success.
 */
import { KG_RECALL_TIMEOUT_MS } from "./sanitize.ts";

/** Mirror of MEMGATE_REFUSAL_REASONS (src/memgate/schemas.ts:69-71) — standalone copy, no src/ import. */
const MEMGATE_REFUSAL_REASONS: readonly string[] = [
	"scope-bank",
	"scope-verb",
	"expired",
	"revoked",
	"no-auth",
	"admin-auth",
	"ledger-unreadable",
	"mint-invalid-ttl",
];

export type RecallOutcome =
	| { ok: true; memories: string[]; gatewayResults: number; durationMs: number | undefined }
	| { ok: false; reason: string; message: string }
	| { ok: false; transport: true; message: string };

export async function recall(input: {
	gatewayUrl: string;
	key: string;
	bank: string;
	query: string;
	limit?: number;
	timeoutMs?: number;
	signal?: AbortSignal;
	fetchImpl?: typeof fetch;
}): Promise<RecallOutcome> {
	const { gatewayUrl, key, bank, query, limit, timeoutMs, signal, fetchImpl } = input;
	const doFetch = fetchImpl ?? globalThis.fetch;
	// A trailing slash on the origin would concatenate into dead //v1/... paths.
	const origin = gatewayUrl.replace(/\/+$/, "");
	const controller = new AbortController();
	const timeoutBudget = timeoutMs ?? KG_RECALL_TIMEOUT_MS;
	// A timer-fired abort gets its own message so a slow gateway is tellable
	// from an unreachable one (DNS failures surface as their own fetch error).
	let timedOut = false;
	const timer = setTimeout(() => {
		timedOut = true;
		controller.abort();
	}, timeoutBudget);
	// The harness's AbortSignal and the timeout both route into the one fetch:
	// either source aborting aborts controller.signal.
	const onExternalAbort = () => controller.abort();
	if (signal) {
		if (signal.aborted) controller.abort();
		// A non-standard signal object (the harness types it any) may lack the
		// DOM methods — attaching must not throw outside the try and leak the timer.
		else if (typeof signal.addEventListener === "function")
			signal.addEventListener("abort", onExternalAbort, { once: true });
	}
	try {
		const body: Record<string, unknown> = { query };
		if (limit !== undefined) body.limit = limit;
		const res = await doFetch(`${origin}/v1/default/banks/${encodeURIComponent(bank)}/memories/recall`, {
			method: "POST",
			headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
			body: JSON.stringify(body),
			signal: controller.signal,
		});
		if (!res.ok) {
			let parsed: { error?: { code?: unknown; message?: unknown } } | undefined;
			try {
				parsed = (await res.json()) as { error?: { code?: unknown; message?: unknown } };
			} catch {
				parsed = undefined;
			}
			const code = typeof parsed?.error?.code === "string" ? parsed.error.code : undefined;
			const gatewayMessage = typeof parsed?.error?.message === "string" ? parsed.error.message : undefined;
			// An in-set code is a refusal even when the message is missing or empty:
			// the closed set is the classifier, not the message shape.
			if (code !== undefined && MEMGATE_REFUSAL_REASONS.includes(code)) {
				return {
					ok: false,
					reason: code,
					message:
						gatewayMessage !== undefined && gatewayMessage !== "" ? gatewayMessage : "(gateway omitted message)",
				};
			}
			const status = `HTTP ${res.status}${res.statusText ? ` ${res.statusText}` : ""}`;
			return {
				ok: false,
				transport: true,
				message: code !== undefined ? `${status} (unrecognized error code: ${code})` : status,
			};
		}
		const data = (await res.json()) as { results?: Array<{ text?: unknown; content?: unknown }>; durationMs?: unknown };
		const results = data?.results;
		if (!Array.isArray(results)) {
			return { ok: false, transport: true, message: "recall response missing results array (gateway shape drift)" };
		}
		const memories = results
			.map((r) => (typeof r?.text === "string" ? r.text : typeof r?.content === "string" ? r.content : ""))
			.filter((text) => text !== "");
		const durationMs = typeof data?.durationMs === "number" ? data.durationMs : undefined;
		return { ok: true, memories, gatewayResults: results.length, durationMs };
	} catch (error) {
		if (timedOut) return { ok: false, transport: true, message: `recall timed out after ${timeoutBudget}ms` };
		return { ok: false, transport: true, message: error instanceof Error ? error.message : String(error) };
	} finally {
		clearTimeout(timer);
		if (typeof signal?.removeEventListener === "function") signal.removeEventListener("abort", onExternalAbort);
	}
}
