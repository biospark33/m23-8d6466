/**
 * coms-core — shared layer for the vendored coms extensions
 *
 * `coms.ts` (local Unix-socket IPC) and `coms-net.ts` (HTTP/SSE hub) are two
 * transports of the same subsystem, historically maintained in manual parity.
 * This module holds the pieces that are byte-for-byte identical (or identical
 * after the documented drift fixes) between them: pure helpers, one bounded
 * env-int parser, the duplicate-registration predicate, and the caps whose
 * value AND meaning are shared.
 *
 * Transport-specific logic (registry/socket/SSE, tombstone bookkeeping,
 * queues, widgets, dispatch) stays in each transport file. Constants that
 * intentionally differ per transport (e.g. MAX_PROMPT_BYTES) also stay put —
 * see DIVERGENCE.md.
 *
 * Both files import this exactly like they import "./themeMap.ts".
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs";

// ━━ Shared constants (identical value AND meaning in both transports) ━━━━━━━
//
// Divergent caps (MAX_PROMPT_BYTES: 256 KiB local vs 200_000 net) stay in
// their own files — see DIVERGENCE.md.

// Fixed hop cap: prompts at/over MAX_HOPS are nacked and relays refuse to
// forward. Deliberately NOT an env knob — the documented guard is exactly 5.
export const MAX_HOPS = 5;
// Cap on concurrent unfulfilled inbounds (entries removed only at agent_end or
// by the deadline sweep) so a flooding peer can't grow the queue without bound.
export const MAX_INBOUND = 256;
// Hard cap on fulfilled-msg_id replay tombstones: prune expired first, then
// evict oldest-inserted, so a unique-id flood can't pin memory.
export const MAX_FULFILLED_TOMBSTONES = 1000;
// Cap on retained exit-fallback dispatches: each undelivered entry costs one
// blocking spawnSync at process exit, so a dead peer can't stall exit.
export const MAX_PENDING_EXIT_DISPATCHES = 64;
// Total wall-clock budget for all exit-fallback dispatches so a backlog can't
// stall process exit for minutes.
export const EXIT_DELIVER_BUDGET_MS = 10_000;
// Receiver-side cap on a peer-supplied response body. The reply lands verbatim
// in the caller's coms_get/coms_await (coms_net_get/coms_net_await) tool
// output, so without it a buggy/hostile peer can push a full transport-cap
// (16 MiB line / SSE) payload into the caller's context window per round-trip.
export const MAX_RESPONSE_BYTES = 256 * 1024;
// Receiver-side cap on a peer-supplied response_schema: the blob is stored per
// inbound and persisted into the session branch, so the 16 MiB transport cap is
// far too loose. Shared deliberately — the two transports are behavioral peers
// and a schema accepted by one must not be nacked by the other.
export const MAX_RESPONSE_SCHEMA_BYTES = 32_768;

// ━━ Bounded env-int parser ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//
// `Number(env) || DEFAULT` is wrong for tunables: it rejects a legitimate 0,
// accepts -1 (setInterval(-1) spins at ~1ms — a self-DoS) or Infinity
// (silently disables hop/timeout guards), and allows unbounded TTLs that pin
// memory. So: require finite and > 0, optionally require integer (values above
// 2^31-1 overflow Node's setTimeout; a fractional value like 0.5 floors to 0 —
// a zero timer bricks intervals), then clamp into [min, max] when given.
export interface EnvBoundedIntOptions {
	min?: number;
	max?: number;
	/** Reject non-integer values (falls back to default), for timer knobs. */
	integer?: boolean;
}

export function envBoundedInt(env: string | undefined, def: number, opts: EnvBoundedIntOptions = {}): number {
	const { min, max, integer = false } = opts;
	const n = Number(env);
	if (!Number.isFinite(n) || n <= 0) return def;
	if (integer && !Number.isInteger(n)) return def;
	let out = n;
	if (min !== undefined) out = Math.max(out, min);
	if (max !== undefined) out = Math.min(out, max);
	return out;
}

// ━━ Pure helpers ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

// Exported because the coms smoke test asserts generated ids against the
// alphabet, and a second copy of it there is what #59 was about.
export const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

// 10 Crockford chars encode 50 bits of timestamp; Date.now() needs 48 bits
// (good until ~year 10889), so the final slice(0, 26) never truncates the
// time portion and ids stay roughly time-ordered.
export function ulid(): string {
	const time = Date.now();
	const rand = crypto.randomBytes(10);
	let timeStr = "";
	let t = time;
	for (let i = 9; i >= 0; i--) {
		timeStr = CROCKFORD[t % 32] + timeStr;
		t = Math.floor(t / 32);
	}
	let randStr = "";
	let bits = 0;
	let value = 0;
	for (const byte of rand) {
		value = (value << 8) | byte;
		bits += 8;
		while (bits >= 5) {
			bits -= 5;
			randStr += CROCKFORD[(value >> bits) & 31];
		}
	}
	return (timeStr + randStr).slice(0, 26);
}

export const FALLBACK_PALETTE = [
	"#72F1B8", "#36F9F6", "#FF7EDB", "#FEDE5D",
	"#C792EA", "#FF8B39", "#4D9DE0", "#FFAA8B",
];

export function isValidHex(hex: string): boolean {
	return /^#[0-9a-fA-F]{6}$/.test(hex);
}

export function hexFg(hex: string, s: string): string {
	if (!isValidHex(hex)) return s;
	const r = Number.parseInt(hex.slice(1, 3), 16);
	const g = Number.parseInt(hex.slice(3, 5), 16);
	const b = Number.parseInt(hex.slice(5, 7), 16);
	return `\x1b[38;2;${r};${g};${b}m${s}\x1b[39m`;
}

export function fallbackColor(sessionId: string): string {
	const h = crypto.createHash("sha256").update(sessionId).digest("hex").slice(0, 8);
	// The modulo guarantees an in-range index.
	return FALLBACK_PALETTE[Number(BigInt(`0x${h}`)) % FALLBACK_PALETTE.length]!;
}

export function parseFrontmatter(raw: string): { name?: string; description?: string; color?: string; body: string } {
	const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
	if (!match) return { body: raw };
	// Both groups are required by the regex; the defaults only satisfy
	// noUncheckedIndexedAccess.
	const [, fm = "", body = ""] = match;
	const frontmatter: Record<string, string> = {};
	for (const line of fm.split(/\r?\n/)) {
		const idx = line.indexOf(":");
		if (idx > 0) {
			const key = line.slice(0, idx).trim();
			let val = line.slice(idx + 1).trim();
			// strip surrounding quotes for values like color: "#36F9F6"
			if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
				val = val.slice(1, -1);
			}
			frontmatter[key] = val;
		}
	}
	return {
		name: frontmatter.name,
		description: frontmatter.description,
		color: frontmatter.color,
		body,
	};
}

export function nowIso(): string {
	return new Date().toISOString();
}

// ━━ Filesystem-touching helpers ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//
// Everything above this banner is pure (no I/O, no ambient state). The two
// functions below read the filesystem via `fs` — see DIVERGENCE.md's
// "coms-core.ts" section for why that's in-scope for this module.

// Prefer --system-prompt (overwrite). Fall back to --append-system-prompt.
// These flags are pi-builtin (not extension-registered) so we scan argv
// directly. First match wins per preference order.
export function findSystemPromptPath(argv: string[]): string | null {
	const scan = (flag: string): string | null => {
		for (let i = 0; i < argv.length; i++) {
			// Accept both `--flag value` and `--flag=value` argv forms; pi's
			// parser handles both, and silently ignoring the `=` form registers
			// the agent under an auto-generated name with no warning.
			const arg = argv[i];
			if (arg === undefined) continue;
			const candidate = arg === flag && i + 1 < argv.length
				? argv[i + 1]
				: arg.startsWith(`${flag}=`)
					? arg.slice(flag.length + 1)
					: null;
			if (candidate?.endsWith(".md")) {
				try {
					if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
						return candidate;
					}
				} catch {
					// fall through
				}
			}
		}
		return null;
	};
	return scan("--system-prompt") ?? scan("--append-system-prompt");
}

export function readFrontmatterFromArgv(argv: string[]): { name?: string; description?: string; color?: string } {
	const p = findSystemPromptPath(argv);
	if (!p) return {};
	try {
		const raw = fs.readFileSync(p, "utf-8");
		const { name, description, color } = parseFrontmatter(raw);
		return { name, description, color };
	} catch {
		return {};
	}
}

export function abbreviateModel(model: unknown): string {
	// Registry/pong fields are peer-controlled; a non-string would throw on
	// startsWith/slice and crash the TUI render callback.
	let m = typeof model === "string" ? model : "";
	if (m.startsWith("claude-")) m = m.slice("claude-".length);
	if (m.length > 14) m = m.slice(0, 14);
	return m;
}

// Peer-supplied display strings are interpolated raw into injected prompts and
// rendered in the TUI. Strip C0/DEL/C1 control characters (ANSI escape
// sequences are a terminal-injection channel) and cap length — the transport
// frame allows near-16MB fields. Non-strings coerce to the fallback.
export function sanitizePeerText(s: unknown, fallback = "", max = 64): string {
	if (typeof s !== "string") return fallback;
	// biome-ignore lint/suspicious/noControlCharactersInRegex: intentional — strips C0/DEL/C1 control characters from peer-controlled strings
	const clean = s.replace(/[\x00-\x1f\x7f\u0080-\u009f]/g, "");
	return clean.length > max ? clean.slice(0, max) : clean;
}

// Constant-time secret comparison: a plain !== short-circuits on the first
// mismatched byte, leaking the match-prefix length through timing.
// timingSafeEqual requires equal-length buffers, so check length first.
// Used by coms.ts's shared-secret IPC auth; coms-net authenticates with a
// bearer token and does not call this.
export function secretEqual(a: string, b: string): boolean {
	const ba = Buffer.from(a);
	const bb = Buffer.from(b);
	if (ba.length !== bb.length) return false;
	return crypto.timingSafeEqual(ba, bb);
}

// Rejects path traversal / separator injection in project & agent names, which
// can originate from untrusted input (--project CLI flag / env var, agent
// frontmatter, or another agent's list tool). Strict whitelist rather than a
// separator blacklist: also blocks Windows ADS (colon) and null-byte
// injection. "." and ".." pass the character class, so reject them explicitly.
export function isSafePathComponent(s: unknown): s is string {
	return typeof s === "string" && /^[a-zA-Z0-9_.-]+$/.test(s) && s !== "." && s !== "..";
}

// ━━ Wire-protocol narrowing (trust boundary) ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//
// Anything decoded from a peer/hub (JSON.parse of a socket line or an SSE
// data field) is untrusted. `WireRecord` is the honest type for it: the value
// is known to be a non-null, non-array object and NOTHING else — every field
// reads as `unknown` and only a real runtime check can narrow it. Declaring a
// wire value as a rich interface (`as PromptEnvelope`) is a lie the compiler
// then propagates; `WireRecord` makes the compiler demand the check instead.
export type WireRecord = Record<string, unknown>;

export function isWireRecord(v: unknown): v is WireRecord {
	return typeof v === "object" && v !== null && !Array.isArray(v);
}

// Co-loading coms.ts + coms-net.ts (or an extension reload) double-registers
// the same flag/tool/command names; on pi builds whose registerFlag throws on
// duplicates, swallow ONLY the duplicate error — anything else is a real bug.
export function isDuplicateRegistration(err: unknown): boolean {
	const msg = err instanceof Error ? err.message : String(err);
	return /already|duplicate/i.test(msg);
}
