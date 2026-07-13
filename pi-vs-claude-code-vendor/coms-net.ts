/**
 * coms-net — HTTP/SSE Pi Agent Communication Network (client)
 *
 * Drop-in successor to `extensions/coms.ts` whose substrate is a dedicated
 * Bun HTTP/SSE hub instead of per-agent Unix sockets / named pipes. The
 * user-facing tool surface is renamed for total separation from v1:
 *
 *   tools         coms_net_list / coms_net_send / coms_net_get / coms_net_await
 *   slash command /coms-net
 *   widget key    "coms-net-pool"   (placement: belowEditor only)
 *   audit channel "coms-net-log"
 *   customType    "coms-net-inbound"
 *   status key    "coms-net"
 *   registry root ~/.pi/coms-net/
 *
 * Both `coms.ts` and `coms-net.ts` may be loaded together without identifier
 * collision. v1 stays untouched.
 *
 * Usage:
 *   bun scripts/coms-net-server.ts                                 # start hub (planned — not yet shipped in this branch)
 *   pi -e pi-vs-claude-code-vendor/coms-net.ts                     # auto-discover local server.json
 *   pi -e pi-vs-claude-code-vendor/coms-net.ts --server-url http://host:port \
 *      --auth-token <tok> --cname planner --project default
 *
 * Note: the agent name flag is `--cname` (not `--name`). pi's own harness owns
 * `--name` and resumes it across sessions, so coms-net uses a distinct flag.
 */

import type { ExtensionAPI, ExtensionContext, Theme } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { truncateToWidth } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";
import { applyExtensionDefaults } from "./themeMap.ts";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import * as crypto from "node:crypto";

// ━━ Constants ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

const COMS_NET_DIR = path.join(os.homedir(), ".pi", "coms-net");
// Env overrides for tunables are clamped: `Number(env) || DEFAULT` would
// reject a legitimate 0, accept -1 (setInterval(-1) spins at ~1ms — a
// self-DoS) or Infinity (silently disables hop protection), and allow
// unbounded TTLs that pin memory for days.
function envBoundedInt(env: string | undefined, def: number, min: number, max: number): number {
	const n = Number(env);
	if (!Number.isFinite(n) || n <= 0) return def;
	return Math.min(Math.max(n, min), max);
}
const MAX_HOPS = envBoundedInt(process.env.PI_COMS_NET_MAX_HOPS, 5, 1, 64);
const HEARTBEAT_MS = envBoundedInt(process.env.PI_COMS_NET_HEARTBEAT_MS, 10_000, 1_000, 300_000);
const RECONNECT_BASE_MS = 500;
const RECONNECT_MAX_MS = 10_000;
const MESSAGE_TIMEOUT_MS = envBoundedInt(process.env.PI_COMS_NET_MESSAGE_TTL_MS, 1_800_000, 1_000, 86_400_000);
const HTTP_TIMEOUT_MS = 10_000;
const SSE_BUF_CAP_BYTES = 16 * 1024 * 1024;
const HTTP_BODY_CAP_BYTES = 16 * 1024 * 1024;
const SHUTDOWN_DELETE_TIMEOUT_MS = 2_000;

const SERVER_URL_ENV = process.env.PI_COMS_NET_SERVER_URL;
const AUTH_TOKEN_ENV = process.env.PI_COMS_NET_AUTH_TOKEN;
const PROJECT_ENV = process.env.PI_COMS_NET_PROJECT;

const FALLBACK_PALETTE = [
	"#72F1B8", "#36F9F6", "#FF7EDB", "#FEDE5D",
	"#C792EA", "#FF8B39", "#4D9DE0", "#FFAA8B",
];

// ━━ Shared types (canonical block — mirrored on server) ━━━━━━━━━━━━━━━━━━━

type AgentStatus = "online" | "stale" | "offline";
type MessageStatus = "queued" | "delivered" | "complete" | "error" | "timeout";

interface AgentCard {
	session_id: string;
	name: string;
	purpose: string;
	model: string;
	provider?: string;
	color: string;
	cwd: string;
	project: string;
	explicit: boolean;
	started_at: string;
	context_used_pct: number;
	queue_depth: number;
	status: AgentStatus;
}

interface RegisterRequest {
	project: string;
	session_id: string;
	name: string;
	purpose: string;
	model: string;
	provider?: string;
	color: string;
	cwd: string;
	explicit: boolean;
}

interface RegisterResponse {
	ok: true;
	agent: AgentCard;
	heartbeat_interval_ms: number;
	sse_url: string;
}

interface HeartbeatRequest {
	project: string;
	context_used_pct: number;
	queue_depth: number;
	model?: string;
	status?: AgentStatus;
}

interface SendRequest {
	project: string;
	sender_session: string;
	target: string;
	target_session: string | null;
	prompt: string;
	conversation_id: string | null;
	response_schema: object | null;
	hops: number;
}

interface SendResponse {
	ok: true;
	msg_id: string;
	status: MessageStatus;
	target_session: string;
}

interface ResponseSubmitRequest {
	project: string;
	responder_session: string;
	response: any;
	error: string | null;
	// Echoed from the inbound envelope so the original caller can correlate
	// the reply with its conversation thread.
	conversation_id: string | null;
}

interface InboundContext {
	msg_id: string;
	hops: number;
	sender_session: string;
	sender_name: string;
	sender_cwd: string;
	response_schema?: object | null;
	conversation_id: string | null;
	fulfilled: boolean;
	// Epoch ms at receipt; the heartbeat sweep evicts entries that never
	// reached agent_end (aborted turns) so they can't linger forever or
	// misattribute later sends' hops.
	created_at: number;
}

interface PendingReply {
	resolve: (value: { response?: any; error?: string | null }) => void;
	promise: Promise<{ response?: any; error?: string | null }>;
	result?: { response?: any; error?: string | null };
	target_name?: string;
	target_session?: string;
	conversation_id?: string | null;
	// Set while a coms_net_await is in flight for this msg_id; a second
	// concurrent await must not race the same reply.
	awaiting?: boolean;
	// Epoch ms at coms_net_send time (kept as a number so the heartbeat
	// pruning loop avoids re-parsing an ISO string on every sweep).
	created_at: number;
	// Effective await deadline (ms). Defaults to MESSAGE_TIMEOUT_MS at send time;
	// a coms_net_await override replaces it so the heartbeat pruning loop does
	// not evict the entry before the caller's own timeout fires.
	timeout_ms?: number;
	// Epoch ms when coms_net_await took ownership of the deadline. Pruning
	// measures the effective timeout from this point (the server-side await
	// starts at invocation, not at send); entries never awaited fall back to
	// created_at.
	await_started_at?: number;
}

interface ServerJson {
	version: number;
	project: string;
	pid?: number;
	host?: string;
	port?: number;
	local_url: string;
	public_url?: string;
	started_at?: string;
}

interface ServerSecretJson {
	token: string;
}

class HttpError extends Error {
	status: number;
	body: any;
	constructor(status: number, body: any, message?: string) {
		super(message ?? `HTTP ${status}`);
		this.status = status;
		this.body = body;
	}
}

// ━━ Helpers — verbatim from coms.ts (lines 131-210) ━━━━━━━━━━━━━━━━━━━━━━━━

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

function ulid(): string {
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

function isValidHex(hex: string): boolean {
	return /^#[0-9a-fA-F]{6}$/.test(hex);
}

function hexFg(hex: string, s: string): string {
	if (!isValidHex(hex)) return s;
	const r = Number.parseInt(hex.slice(1, 3), 16);
	const g = Number.parseInt(hex.slice(3, 5), 16);
	const b = Number.parseInt(hex.slice(5, 7), 16);
	return `\x1b[38;2;${r};${g};${b}m${s}\x1b[39m`;
}

function fallbackColor(sessionId: string): string {
	const h = crypto.createHash("sha256").update(sessionId).digest("hex").slice(0, 8);
	return FALLBACK_PALETTE[Number(BigInt(`0x${h}`)) % FALLBACK_PALETTE.length];
}

function parseFrontmatter(raw: string): { name?: string; description?: string; color?: string; body: string } {
	const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
	if (!match) return { body: raw };
	const frontmatter: Record<string, string> = {};
	for (const line of match[1].split(/\r?\n/)) {
		const idx = line.indexOf(":");
		if (idx > 0) {
			const key = line.slice(0, idx).trim();
			let val = line.slice(idx + 1).trim();
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
		body: match[2],
	};
}

function nowIso(): string {
	return new Date().toISOString();
}

function abbreviateModel(model: string): string {
	let m = model || "";
	if (m.startsWith("claude-")) m = m.slice("claude-".length);
	if (m.length > 14) m = m.slice(0, 14);
	return m;
}

// Peer-controlled strings (card name/purpose/cwd, sender identity) are
// rendered raw into the TUI and interpolated into injected prompts. Strip
// C0/DEL control characters (ANSI escape sequences are a terminal-injection
// channel) and cap length so a hostile or buggy peer can't wreck widget
// layout. Non-strings coerce to the fallback.
function sanitizePeerText(s: unknown, fallback = "", max = 64): string {
	if (typeof s !== "string") return fallback;
	// biome-ignore lint/suspicious/noControlCharactersInRegex: intentional — strips C0/DEL control characters from peer-controlled strings
	const clean = s.replace(/[\x00-\x1f\x7f]/g, "");
	return clean.length > max ? clean.slice(0, max) : clean;
}

// Cards arrive over the wire from the hub (ultimately from other peers), so
// their string fields are untrusted: coerce non-strings to safe defaults and
// strip control characters / cap length, or a single malformed card crashes
// widget rendering (localeCompare/padEnd on a non-string). A card without a
// string session_id is unusable as a map key — drop it.
function sanitizeCard(a: any): AgentCard | null {
	if (!a || typeof a !== "object" || typeof a.session_id !== "string" || !a.session_id) return null;
	return {
		...a,
		name: sanitizePeerText(a.name, "?"),
		purpose: sanitizePeerText(a.purpose),
		model: sanitizePeerText(a.model, "?"),
		color: sanitizePeerText(a.color),
		cwd: sanitizePeerText(a.cwd),
		project: sanitizePeerText(a.project),
	};
}

// Same coercion for the partial fields of an agent_updated patch — only the
// fields actually present in the patch.
function sanitizeCardPatch(a: Partial<AgentCard>): Partial<AgentCard> {
	const out: Partial<AgentCard> = { ...a };
	if (out.name !== undefined) out.name = sanitizePeerText(out.name, "?");
	if (out.purpose !== undefined) out.purpose = sanitizePeerText(out.purpose);
	if (out.model !== undefined) out.model = sanitizePeerText(out.model, "?");
	if (out.color !== undefined) out.color = sanitizePeerText(out.color);
	if (out.cwd !== undefined) out.cwd = sanitizePeerText(out.cwd);
	if (out.project !== undefined) out.project = sanitizePeerText(out.project);
	return out;
}

// Read a response body with an accumulated-byte cap: resp.text() buffers the
// whole body, so a misbehaving/compromised server could OOM the agent on any
// endpoint. (The SSE path has its own cap in makeSseParser.feed.)
async function readBodyCapped(resp: Response): Promise<string> {
	if (!resp.body) return "";
	const reader = resp.body.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			if (value) {
				total += value.length;
				if (total > HTTP_BODY_CAP_BYTES) {
					throw new Error("coms-net: response body exceeded cap");
				}
				chunks.push(value);
			}
		}
	} finally {
		try { reader.releaseLock(); } catch { /* ignore */ }
	}
	return new TextDecoder("utf-8").decode(Buffer.concat(chunks));
}

function findSystemPromptPath(argv: string[]): string | null {
	const scan = (flag: string): string | null => {
		for (let i = 0; i < argv.length; i++) {
			if (argv[i] === flag && i + 1 < argv.length) {
				const candidate = argv[i + 1];
				if (candidate.endsWith(".md")) {
					try {
						if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
							return candidate;
						}
					} catch {
						// fall through
					}
				}
			}
		}
		return null;
	};
	return scan("--system-prompt") ?? scan("--append-system-prompt");
}

function readFrontmatterFromArgv(argv: string[]): { name?: string; description?: string; color?: string } {
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

// ━━ Registry / server-discovery I/O ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

// Rejects path traversal / separator injection in the project name, which
// can originate from untrusted input (--project CLI flag or PI_COMS_NET_PROJECT
// env var). Strict whitelist rather than a separator blacklist: also blocks
// Windows ADS (colon) and null-byte injection, which the old blacklist let
// through. "." and ".." pass the character class, so they're rejected
// explicitly.
function isSafePathComponent(s: unknown): s is string {
	return typeof s === "string" && /^[a-zA-Z0-9_.-]+$/.test(s) && s !== "." && s !== "..";
}

function projectDir(project: string): string {
	if (!isSafePathComponent(project)) {
		throw new Error(`coms-net: invalid project name "${project}"`);
	}
	return path.join(COMS_NET_DIR, "projects", project);
}

function readServerJson(project: string): ServerJson | null {
	// projectDir throws on an invalid project name — resolve inside the try so
	// the function returns null (its failure contract) instead of escaping.
	try {
		const p = path.join(projectDir(project), "server.json");
		if (!fs.existsSync(p)) return null;
		const raw = fs.readFileSync(p, "utf-8");
		const parsed = JSON.parse(raw) as ServerJson;
		if (!parsed || typeof parsed.local_url !== "string") return null;
		return parsed;
	} catch {
		return null;
	}
}

function readServerSecret(project: string): ServerSecretJson | null {
	// See readServerJson: projectDir throws on an invalid name, so resolve
	// inside the try to honor the null-on-failure contract.
	try {
		const p = path.join(projectDir(project), "server.secret.json");
		if (!fs.existsSync(p)) return null;
		// Only trust the token if group/other have no access to the file.
		// Windows doesn't map st.mode onto Unix permission bits (it's always
		// ~0o666/0o444 based on the read-only attribute), so this check is
		// meaningless there — skip it and rely on the OS's own ACL-based file
		// protection instead.
		const st = fs.statSync(p);
		if (process.platform !== "win32") {
			const mode = st.mode & 0o777;
			// Reject if group or other has any access; owner-only read (0o400) or
			// read-write (0o600) are both fine — 0o400 is the more locked-down
			// choice for a secret file, not a reason to refuse it.
			if ((mode & 0o077) !== 0) return null;
		}
		const raw = fs.readFileSync(p, "utf-8");
		const parsed = JSON.parse(raw) as ServerSecretJson;
		if (!parsed || typeof parsed.token !== "string" || parsed.token.length === 0) return null;
		return parsed;
	} catch {
		return null;
	}
}

function isLoopbackHost(hostname: string): boolean {
	const h = hostname.toLowerCase();
	return h === "localhost" || h === "127.0.0.1" || h === "::1" || h === "[::1]";
}

// Accepts https for any host, or http only for explicit loopback hosts —
// server URLs can come from env vars or a project-local server.json, so a
// non-loopback http:// endpoint would send the auth bearer token in the
// clear. Invalid/insecure candidates are rejected in favor of the next
// source rather than silently downgrading.
function normalizeServerUrlCandidate(raw: string): string | null {
	let url: URL;
	try {
		url = new URL(raw);
	} catch {
		return null;
	}
	if (url.protocol !== "https:" && !(url.protocol === "http:" && isLoopbackHost(url.hostname))) {
		return null;
	}
	return raw.replace(/\/+$/, "");
}

function resolveServerUrl(project: string, cliFlag: string | undefined): string | null {
	if (cliFlag && cliFlag.length > 0) {
		// An explicitly-provided --server-url is the user's intent; if it's
		// invalid/insecure, fail here instead of silently falling through to
		// the env var or project server.json (which could be a different server).
		return normalizeServerUrlCandidate(cliFlag);
	}
	if (SERVER_URL_ENV && SERVER_URL_ENV.length > 0) {
		const v = normalizeServerUrlCandidate(SERVER_URL_ENV);
		if (v) return v;
	}
	const sj = readServerJson(project);
	if (sj?.local_url) {
		const v = normalizeServerUrlCandidate(sj.local_url);
		if (v) return v;
	}
	return null;
}

function resolveAuthToken(project: string, cliFlag: string | undefined): string | null {
	if (cliFlag && cliFlag.length > 0) return cliFlag;
	if (AUTH_TOKEN_ENV && AUTH_TOKEN_ENV.length > 0) return AUTH_TOKEN_ENV;
	const sec = readServerSecret(project);
	if (sec) return sec.token;
	return null;
}

// ━━ CLI flag shape ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

interface CliFlags {
	name?: string;
	purpose?: string;
	project?: string;
	color?: string;
	explicit?: boolean;
	serverUrl?: string;
	authToken?: string;
}

function readCliFlags(pi: ExtensionAPI): CliFlags {
	const name = pi.getFlag("cname") as string | undefined;
	const purpose = pi.getFlag("purpose") as string | undefined;
	const project = pi.getFlag("project") as string | undefined;
	const color = pi.getFlag("color") as string | undefined;
	const explicit = pi.getFlag("explicit") as boolean | undefined;
	const serverUrl = pi.getFlag("server-url") as string | undefined;
	const authToken = pi.getFlag("auth-token") as string | undefined;
	return {
		name: name && name.length > 0 ? name : undefined,
		purpose: purpose && purpose.length > 0 ? purpose : undefined,
		project: project && project.length > 0 ? project : undefined,
		color: color && color.length > 0 ? color : undefined,
		explicit: explicit === true,
		serverUrl: serverUrl && serverUrl.length > 0 ? serverUrl : undefined,
		authToken: authToken && authToken.length > 0 ? authToken : undefined,
	};
}

// ━━ Default export ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

export default function (pi: ExtensionAPI) {
	// ━━ Identity flags ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
	// Agent name flag is `--cname`: pi's harness owns `--name` and resumes it.
	pi.registerFlag("cname", {
		description: "Override coms-net agent name (otherwise from frontmatter or auto-generated). Distinct from pi's own --name, which the harness owns and resumes.",
		type: "string",
		default: undefined,
	});
	pi.registerFlag("purpose", {
		description: "Override agent purpose (otherwise from frontmatter description)",
		type: "string",
		default: undefined,
	});
	pi.registerFlag("project", {
		description: "Project namespace for the coms-net hub",
		type: "string",
		default: "default",
	});
	pi.registerFlag("color", {
		description: "Hex color #RRGGBB (otherwise from frontmatter or palette fallback)",
		type: "string",
		default: undefined,
	});
	pi.registerFlag("explicit", {
		description: "Hide this agent from auto-discovery; only addressable by exact name",
		type: "boolean",
		default: false,
	});
	pi.registerFlag("server-url", {
		description: "coms-net server base URL (overrides env and local server.json)",
		type: "string",
		default: undefined,
	});
	pi.registerFlag("auth-token", {
		description: "Bearer token for the coms-net hub (overrides env and server.secret.json). NEVER logged.",
		type: "string",
		default: undefined,
	});

	// ━━ Module-scope state ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
	let identity: {
		session_id: string;
		name: string;
		purpose: string;
		color: string;
		project: string;
		explicit: boolean;
		cwd: string;
		model: string;
		started_at: string;
	} | null = null;
	let serverUrl: string | null = null;
	let authToken: string | null = null;
	let sseUrlPath: string | null = null;
	const peerCards: Map<string, AgentCard> = new Map();
	const pendingReplies: Map<string, PendingReply> = new Map();
	const inboundQueue: Map<string, InboundContext> = new Map();
	let sseAbort: AbortController | null = null;
	let heartbeatTimer: NodeJS.Timeout | null = null;
	let reconnectTimer: NodeJS.Timeout | null = null;
	let reconnectAttempts = 0;
	let notifiedReconnectCap = false;
	let currentCtx: ExtensionContext | null = null;
	let includeExplicit = false;
	let displayProject: string | null = null;
	let lastWidgetSnapshot = "";
	let shuttingDown = false;
	// Effective heartbeat cadence — the server may tune it via
	// RegisterResponse.heartbeat_interval_ms; defaults to HEARTBEAT_MS.
	let heartbeatIntervalMs = HEARTBEAT_MS;

	// ━━ HTTP helper ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

	async function httpFetch(method: string, urlPath: string, body?: any, opts?: { timeoutMs?: number; signal?: AbortSignal }): Promise<any> {
		if (!serverUrl) throw new Error("coms-net: no server URL");
		if (!authToken) throw new Error("coms-net: no auth token");
		const url = serverUrl + urlPath;
		const headers: Record<string, string> = {
			"Authorization": `Bearer ${authToken}`,
			"Accept": "application/json",
		};
		const init: any = { method, headers };
		if (body !== undefined) {
			headers["Content-Type"] = "application/json";
			init.body = JSON.stringify(body);
		}
		// Timeout via AbortController, chained to the caller's signal (if any) so
		// neither the timeout nor the caller's own abort gets silently dropped.
		let timer: any = null;
		const ac = new AbortController();
		const timeoutMs = opts?.timeoutMs ?? HTTP_TIMEOUT_MS;
		// Shared abort handler for both the timeout and the caller's signal. Named
		// so it can be detached from the caller's signal on completion — otherwise
		// { once: true } only self-removes if the signal fires, leaving the closure
		// (and its capture of `ac`) pinned to a long-lived caller signal.
		const onAbort = () => { try { ac.abort(); } catch { /* ignore */ } };
		if (opts?.signal) {
			if (opts.signal.aborted) {
				ac.abort();
			} else {
				opts.signal.addEventListener("abort", onAbort, { once: true });
			}
		}
		init.signal = ac.signal;
		timer = setTimeout(onAbort, timeoutMs);
		try { (timer as any).unref?.(); } catch { /* ignore */ }
		let resp: Response;
		let text: string;
		try {
			resp = await fetch(url, init);
			text = await readBodyCapped(resp);
		} catch (err: any) {
			throw new Error(`coms-net: fetch failed: ${err?.message ?? String(err)}`);
		} finally {
			if (timer) { try { clearTimeout(timer); } catch { /* ignore */ } }
			if (opts?.signal) { try { opts.signal.removeEventListener("abort", onAbort); } catch { /* ignore */ } }
		}
		let parsed: any = null;
		if (text.length > 0) {
			try { parsed = JSON.parse(text); } catch { parsed = text; }
		}
		if (!resp.ok) {
			throw new HttpError(resp.status, parsed, `HTTP ${resp.status} ${method} ${urlPath}`);
		}
		return parsed;
	}

	// ━━ Audit log helper (never throws) ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

	function audit(event: string, extra: Record<string, any> = {}): void {
		try {
			pi.appendEntry("coms-net-log", { event, ts: nowIso(), ...extra });
		} catch {
			// best-effort
		}
	}

	// ━━ Strip auth token from any user-visible error string ━━━━━━━━━━━━━━━

	function safeError(err: any): string {
		const msg = err instanceof Error ? err.message : String(err);
		if (!authToken) return msg;
		// Defense in depth: never leak the bearer.
		return msg.split(authToken).join("<redacted>");
	}

	// ━━ SSE parser (hand-rolled, no dep) ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

	function makeSseParser(onEvent: (event: string, data: any, id?: string) => void) {
		const decoder = new TextDecoder("utf-8");
		let buf = "";
		let event = "message";
		let dataLines: string[] = [];
		let id: string | undefined;
		// Whether any field line was seen for the current event — lets a
		// data-less named event (e.g. `event: server_ping\n\n`) still dispatch
		// with empty data per the SSE spec instead of vanishing silently.
		let sawField = false;
		function flush(): void {
			if (dataLines.length > 0 || (sawField && event !== "message")) {
				const joined = dataLines.join("\n");
				let data: any = joined;
				try { data = JSON.parse(joined); } catch { /* keep as string */ }
				try { onEvent(event, data, id); } catch { /* ignore handler errors */ }
			}
			event = "message";
			dataLines = [];
			id = undefined;
			sawField = false;
		}
		function processLine(line: string): void {
			if (line.length === 0) {
				flush();
			} else if (line.startsWith(":")) {
				// SSE comment
			} else {
				// Per the SSE spec a field line without a colon uses the whole
				// line as the field name with an empty value (a bare `data`
				// line appends "").
				const colon = line.indexOf(":");
				const field = colon >= 0 ? line.slice(0, colon) : line;
				const raw = colon >= 0 ? line.slice(colon + 1) : "";
				if (field === "event") {
					event = raw.trimStart();
					sawField = true;
				} else if (field === "data") {
					let v = raw;
					if (v.startsWith(" ")) v = v.slice(1);
					dataLines.push(v);
					sawField = true;
				} else if (field === "id") {
					id = raw.trimStart();
					sawField = true;
				}
			}
		}
		return {
			// Line-by-line incremental parsing: each feed() only rescans the
			// unconsumed tail of buf (single indexOf per line), so total work
			// across a payload stays O(N) instead of the O(N^2) a whole-buffer
			// regex replace/rescan would cost as buf grows across chunks.
			feed(chunk: Uint8Array): void {
				// Bound the unconsumed tail so a server that streams data with no
				// newline can't grow buf without limit and OOM the process.
				// buf.length counts UTF-16 code units, not bytes — measure the
				// actual UTF-8 byte length so the cap can't be exceeded ~2-3x
				// in memory by multi-byte content.
				if (Buffer.byteLength(buf, "utf8") + chunk.length > SSE_BUF_CAP_BYTES) {
					throw new Error("coms-net: SSE buffer exceeded cap — dropping connection");
				}
				buf += decoder.decode(chunk, { stream: true });
				// Track the consumed prefix with a start index and slice buf once
				// after the loop, so a chunk with K lines costs O(N) total copying
				// instead of the O(K*N) that re-slicing the tail on every line
				// would cost.
				let start = 0;
				let nl = buf.indexOf("\n", start);
				while (nl >= 0) {
					let line = buf.slice(start, nl);
					start = nl + 1;
					// SSE line endings may be LF, CR, or CRLF per the WHATWG spec —
					// strip a trailing CR so CRLF-terminated streams parse the same
					// as LF-terminated ones.
					if (line.endsWith("\r")) line = line.slice(0, -1);
					processLine(line);
					nl = buf.indexOf("\n", start);
				}
				if (start > 0) buf = buf.slice(start);
			},
			// Dispatch any event left buffered when the stream ends without a
			// trailing blank line. SSE only emits on a blank line, so a server
			// that closes cleanly after its last `\n` (no `\n\n`) would otherwise
			// drop a complete event. A genuinely truncated event fails JSON.parse
			// and is delivered as a string — degraded, not silently lost. Named
			// end() rather than flush() to avoid shadowing the inner dispatcher.
			end(): void {
				// Flush any partial multi-byte sequence the streaming decoder is
				// still holding (stream ended mid-character): decode() without
				// { stream: true } emits U+FFFD for incomplete sequences instead
				// of silently dropping the buffered bytes.
				buf += decoder.decode();
				if (buf.length > 0) {
					let line = buf;
					if (line.endsWith("\r")) line = line.slice(0, -1);
					processLine(line);
					buf = "";
				}
				flush();
			},
		};
	}

	// ━━ Pool snapshot diff (used to gate widget renders) ━━━━━━━━━━━━━━━━━━━

	function poolSnapshotKey(): string {
		const arr = [...peerCards.values()]
			.map(c => `${c.session_id}|${c.name}|${c.color}|${c.model}|${c.context_used_pct}|${c.queue_depth}|${c.status}|${c.purpose}|${c.explicit ? 1 : 0}`)
			.sort();
		return arr.join("\n");
	}

	function maybeRequestRender(): void {
		const next = poolSnapshotKey();
		if (next === lastWidgetSnapshot) return;
		lastWidgetSnapshot = next;
		// The widget render closure pulls from `peerCards` directly; we just need
		// to re-install / re-render. Pi's TUI invalidates on setWidget no-op; we
		// rely on the next frame.
		if (currentCtx?.hasUI) {
			try {
				installPoolWidget(currentCtx);
			} catch {
				// non-fatal
			}
		}
	}

	// ━━ SSE event dispatch ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

	function applyAgentPatch(prev: AgentCard, patch: Partial<AgentCard>): AgentCard {
		return { ...prev, ...patch };
	}

	function handleSseEvent(event: string, data: any, _id?: string): void {
		if (!data || typeof data !== "object") return;
		switch (event) {
			case "hello": {
				audit("sse_hello", { server_id: data.server_id, server_time: data.server_time });
				return;
			}
			case "pool_snapshot": {
				peerCards.clear();
				const agents: AgentCard[] = Array.isArray(data.agents) ? data.agents : [];
				for (const a of agents) {
					const card = sanitizeCard(a);
					if (!card) continue;
					if (identity && card.session_id === identity.session_id) continue;
					peerCards.set(card.session_id, card);
				}
				maybeRequestRender();
				return;
			}
			case "agent_joined": {
				const card = sanitizeCard(data.agent);
				if (!card) return;
				if (identity && card.session_id === identity.session_id) return;
				peerCards.set(card.session_id, card);
				maybeRequestRender();
				return;
			}
			case "agent_updated": {
				const a: Partial<AgentCard> | undefined = data.agent;
				if (!a || typeof a.session_id !== "string") return;
				if (identity && a.session_id === identity.session_id) return;
				const prev = peerCards.get(a.session_id);
				if (prev) {
					peerCards.set(a.session_id, applyAgentPatch(prev, sanitizeCardPatch(a)));
				} else if (a.name && a.color && a.model) {
					// Defensive: treat as a join.
					const card = sanitizeCard(a);
					if (card) peerCards.set(a.session_id, card);
				}
				maybeRequestRender();
				return;
			}
			case "agent_stale": {
				const sid: string | undefined = data.session_id;
				if (!sid) return;
				const prev = peerCards.get(sid);
				if (prev) {
					peerCards.set(sid, { ...prev, status: "stale" });
					maybeRequestRender();
				}
				return;
			}
			case "agent_left": {
				const sid: string | undefined = data.session_id;
				if (!sid) return;
				if (peerCards.delete(sid)) {
					maybeRequestRender();
				}
				return;
			}
			case "prompt": {
				handleInboundPrompt(data);
				return;
			}
			case "response": {
				handleInboundResponse(data);
				return;
			}
			case "message_status": {
				// Informational. No-op beyond audit at debug level.
				return;
			}
			case "server_ping": {
				return;
			}
			case "error": {
				audit("sse_error", { code: data.code, message: data.message });
				return;
			}
			default:
				return;
		}
	}

	// The inbound whose prompt is anchored in this session's own branch —
	// not just "oldest pending in the global queue", which would misattribute
	// hops/replies to an unrelated inbound sitting in inboundQueue while this
	// session runs an unrelated turn. Walking the branch (each inbound prompt
	// is injected with details.msg_id) ties the lookup to what's actually
	// driving the current turn.
	function activeInbound(ctx?: ExtensionContext | null): InboundContext | null {
		const c = ctx ?? currentCtx;
		if (!c) return null;
		const branch = c.sessionManager?.getBranch() ?? [];
		for (let i = branch.length - 1; i >= 0; i--) {
			const entry = branch[i];
			if (entry.type === "message" && entry.message) {
				const msgId = (entry.message as any).details?.msg_id;
				if (msgId) {
					const inbound = inboundQueue.get(msgId);
					if (inbound && !inbound.fulfilled) return inbound;
				}
			}
		}
		return null;
	}

	function handleInboundPrompt(data: any): void {
		const msg_id: string | undefined = data?.msg_id;
		if (!msg_id || typeof msg_id !== "string") return;
		// Redelivery after an SSE reconnect must not inject the same prompt
		// twice into the session.
		if (inboundQueue.has(msg_id)) {
			audit("prompt_in_duplicate", { msg_id });
			return;
		}
		const sender = data.sender ?? {};
		const senderName = sanitizePeerText(sender.name, "unknown");
		const senderCwd = sanitizePeerText(sender.cwd, "?");
		const senderSession = typeof sender.session_id === "string" ? sender.session_id : "?";
		const promptText = typeof data.prompt === "string" ? data.prompt : "";
		const hops = typeof data.hops === "number" ? data.hops : 0;
		const responseSchema = (data.response_schema && typeof data.response_schema === "object") ? data.response_schema : null;
		const conversationId = typeof data.conversation_id === "string" ? data.conversation_id : null;

		const inbound: InboundContext = {
			msg_id,
			hops,
			sender_session: senderSession,
			sender_name: senderName,
			sender_cwd: senderCwd,
			response_schema: responseSchema,
			conversation_id: conversationId,
			fulfilled: false,
			created_at: Date.now(),
		};
		inboundQueue.set(msg_id, inbound);

		try {
			pi.sendMessage(
				{
					customType: "coms-net-inbound",
					content:
						`[inbound coms-net message from ${senderName} @ ${senderCwd}]\n[reply by writing a normal assistant message — your turn output is auto-returned to ${senderName}. DO NOT call coms_net_send/coms_net_await/coms_net_get to reply; that creates a ping-pong loop. msg_id ${msg_id} belongs to ${senderName}'s outbound, not yours.]\n\n${promptText}`,
					display: true,
					details: {
						msg_id,
						sender_session: senderSession,
						response_schema: responseSchema,
						conversation_id: conversationId,
						hops,
					},
				},
				{ deliverAs: "followUp", triggerTurn: true },
			);
			try {
				pi.appendEntry("coms-net-log", {
					event: "prompt_in",
					ts: nowIso(),
					msg_id,
					sender: senderSession,
					hops,
				});
			} catch { /* best-effort */ }
		} catch (err) {
			inboundQueue.delete(msg_id);
			audit("prompt_in_failed", { msg_id, reason: safeError(err) });
		}
	}

	// Context usage can be NaN (e.g. 0/0 before any tokens are counted);
	// clamp non-finite values to 0 so agent cards never carry NaN/Infinity,
	// which would later crash widget rendering ("#".repeat(NaN) → RangeError).
	function safeContextPct(ctx: { getContextUsage?: () => { percent?: number } | null | undefined } | null | undefined): number {
		const p = ctx?.getContextUsage?.()?.percent;
		return typeof p === "number" && Number.isFinite(p) ? Math.round(p) : 0;
	}

	function handleInboundResponse(data: any): void {
		const msg_id: string | undefined = data?.msg_id;
		if (!msg_id) return;
		const responseVal = data.response;
		const errVal: string | null = typeof data.error === "string" ? data.error : null;
		const pending = pendingReplies.get(msg_id);
		if (pending) {
			pending.result = { response: responseVal, error: errVal };
			try { pending.resolve(pending.result); } catch { /* ignore */ }
			try {
				pi.appendEntry("coms-net-log", {
					event: "response_in",
					ts: nowIso(),
					msg_id,
					error: errVal,
				});
			} catch { /* best-effort */ }
		} else {
			audit("orphan_response", { msg_id });
		}
	}

	// ━━ SSE open + read loop ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

	async function openSse(): Promise<void> {
		if (shuttingDown) return;
		if (!serverUrl || !authToken || !sseUrlPath || !identity) return;
		try {
			if (sseAbort) {
				try { sseAbort.abort(); } catch { /* ignore */ }
			}
			const ac = new AbortController();
			sseAbort = ac;
			const url = serverUrl + sseUrlPath;
			const headers: Record<string, string> = {
				"Authorization": `Bearer ${authToken}`,
				"Accept": "text/event-stream",
			};
			// Bound the initial handshake (headers) only — once fetch resolves the
			// SSE stream itself is long-lived and must not be subject to this timer.
			// handshakeTimedOut distinguishes a timeout abort from an intentional one:
			// ac.signal.aborted alone cannot, and treating a timeout as intentional
			// would return below without scheduleReconnect() — permanently killing
			// the reconnect loop on a single transient handshake stall.
			let handshakeTimedOut = false;
			const handshakeTimer = setTimeout(() => {
				handshakeTimedOut = true;
				try { ac.abort(); } catch { /* ignore */ }
			}, HTTP_TIMEOUT_MS);
			try { (handshakeTimer as any).unref?.(); } catch { /* ignore */ }
			let resp: Response;
			try {
				resp = await fetch(url, { method: "GET", headers, signal: ac.signal });
			} catch (err: any) {
				clearTimeout(handshakeTimer);
				if (ac.signal.aborted && !handshakeTimedOut) {
					// Intentional abort (manual reconnect superseding this attempt, or
					// shutdown) — the new attempt or cleanShutdown already owns the
					// reconnect/teardown lifecycle. Scheduling here would race it.
					audit("sse_connect_aborted");
					return;
				}
				audit("sse_connect_failed", { reason: handshakeTimedOut ? "handshake_timeout" : safeError(err) });
				scheduleReconnect();
				return;
			}
			clearTimeout(handshakeTimer);
			if (!resp.ok || !resp.body) {
				audit("sse_connect_http_error", { status: resp.status });
				// 401/403/404 mean the token or URL is wrong — retrying with the
				// same credentials/path will never succeed, so stop instead of
				// spamming the server with an unbounded reconnect loop.
				if (resp.status === 401 || resp.status === 403 || resp.status === 404) {
					if (currentCtx?.hasUI) {
						try { currentCtx.ui.notify(`📡 coms-net: connection rejected (HTTP ${resp.status}) — not retrying`, "error"); } catch { /* ignore */ }
					}
					// Without this the heartbeat keeps POSTing status "online" and
					// the hub shows the agent routable while it can never receive
					// inbound prompts. (Mirrors the heartbeat terminal-status
					// handler.)
					void cleanShutdown();
					return;
				}
				scheduleReconnect();
				return;
			}
			// Connection established. Reset the backoff state.
			reconnectAttempts = 0;
			notifiedReconnectCap = false;
			try {
				pi.appendEntry("coms-net-log", { event: "sse_open", ts: nowIso(), url: sseUrlPath });
			} catch { /* best-effort */ }

			const parser = makeSseParser((event, data, id) => handleSseEvent(event, data, id));
			const reader = resp.body.getReader();
			try {
				while (true) {
					const { done, value } = await reader.read();
					if (done) break;
					if (value) parser.feed(value);
				}
				// Stream ended — flush any event the server sent without a
				// trailing blank line so it isn't dropped.
				try { parser.end(); } catch { /* best-effort */ }
				audit("sse_disconnect", { reason: "stream_end" });
			} catch (err: any) {
				if (ac.signal.aborted) {
					audit("sse_disconnect", { reason: "aborted" });
					return;
				}
				audit("sse_disconnect", { reason: safeError(err) });
			} finally {
				// releaseLock() alone does not close the underlying source: on an
				// errored body stream (network failure) the socket would linger
				// until GC. cancel() explicitly tears it down. After `done` or an
				// abort this is a no-op/rejection — both swallowed by the try.
				try { await reader.cancel(); } catch { /* ignore */ }
				try { reader.releaseLock(); } catch { /* ignore */ }
			}
			if (!shuttingDown) {
				scheduleReconnect();
			}
		} catch (err: any) {
			// Catch-all: getReader() (or anything else in this function) can throw
			// synchronously outside the inner try blocks above. openSse is invoked
			// fire-and-forget (`void openSse()`), so an uncaught rejection here
			// would surface as an unhandled promise rejection.
			audit("sse_unhandled_error", { reason: safeError(err) });
			if (!shuttingDown) {
				scheduleReconnect();
			}
		}
	}

	function scheduleReconnect(): void {
		if (shuttingDown) return;
		if (reconnectTimer) return;
		const backoff = Math.min(RECONNECT_BASE_MS * 2 ** reconnectAttempts, RECONNECT_MAX_MS);
		reconnectAttempts++;
		audit("sse_reconnect_scheduled", { attempt: reconnectAttempts, backoff_ms: backoff });
		if (backoff >= RECONNECT_MAX_MS && !notifiedReconnectCap) {
			notifiedReconnectCap = true;
			if (currentCtx?.hasUI) {
				try { currentCtx.ui.notify("📡 coms-net: reconnect backoff at ceiling", "warning"); } catch { /* ignore */ }
			}
		}
		reconnectTimer = setTimeout(async () => {
			reconnectTimer = null;
			if (shuttingDown) return;
			try {
				await reRegisterAndOpen();
			} catch (err) {
				audit("sse_reconnect_failed", { reason: safeError(err) });
				// 401/403/404 from re-registration mean the token or URL is wrong —
				// retrying with the same credentials/path will never succeed, so stop
				// instead of spamming the server with an unbounded reconnect loop.
				// (Mirrors the terminal-status handling in openSse's SSE GET path.)
				if (err instanceof HttpError && (err.status === 401 || err.status === 403 || err.status === 404)) {
					audit("sse_reconnect_aborted", { status: err.status });
					if (currentCtx?.hasUI) {
						try { currentCtx.ui.notify(`📡 coms-net: reconnect failed (HTTP ${err.status}) — not retrying`, "error"); } catch { /* ignore */ }
					}
					return;
				}
				scheduleReconnect();
			}
		}, backoff);
		try { (reconnectTimer as any).unref?.(); } catch { /* ignore */ }
	}

	// A `response` event delivered while SSE was down is lost for any send
	// never awaited/polled — after a reconnect, poll each unresolved pending
	// entry once and resolve the ones already terminal on the server, so the
	// reply isn't silently dropped until the prune sweep (up to
	// MESSAGE_TIMEOUT_MS later).
	function resyncPendingReplies(): void {
		for (const [mid, entry] of pendingReplies.entries()) {
			if (entry.result) continue;
			httpFetch("GET", `/v1/messages/${encodeURIComponent(mid)}`)
				.then((data: any) => {
					if (data?.status !== "complete" && data?.status !== "error" && data?.status !== "timeout") return;
					if (entry.result) return; // resolved via SSE while this poll was in flight
					const errVal = data.status === "timeout"
						? "timeout"
						: typeof data.error === "string" ? data.error
							: data.status === "error" ? "error" : null;
					entry.result = { response: data.response ?? null, error: errVal };
					try { entry.resolve(entry.result); } catch { /* ignore */ }
					audit("response_resynced", { msg_id: mid, status: data.status });
				})
				.catch(() => { /* best-effort resync; the prune sweep is the backstop */ });
		}
	}

	async function reRegisterAndOpen(): Promise<void> {
		if (!identity || shuttingDown) return;
		// Re-register (server upserts), then re-open SSE.
		const reg = await registerAgent();
		if (shuttingDown) {
			// Shutdown raced our in-flight registration: cleanShutdown() already
			// sent its DELETE while this POST was on the wire, so the register
			// that just resolved re-created the record after it was removed —
			// an orphaned registration for a dead client. Undo it best-effort.
			// (Returning early without the DELETE — as a naive shuttingDown check
			// would — stops openSse() but leaves the orphan on the server.)
			audit("reconnect_registration_orphaned", { attempt: reconnectAttempts });
			await unregisterAgentBestEffort(HTTP_TIMEOUT_MS);
			return;
		}
		sseUrlPath = reg.sse_url;
		audit("sse_reconnect", { attempt: reconnectAttempts });
		resyncPendingReplies();
		// Fire and forget; openSse manages its own lifecycle.
		void openSse();
	}

	// ━━ Registration ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

	async function registerAgent(): Promise<RegisterResponse> {
		if (!identity) throw new Error("coms-net: not initialised");
		const ctx = currentCtx;
		const req: RegisterRequest = {
			project: identity.project,
			session_id: identity.session_id,
			name: identity.name,
			purpose: identity.purpose,
			model: ctx?.model?.id ?? identity.model,
			color: identity.color,
			cwd: identity.cwd,
			explicit: identity.explicit,
		};
		const resp = await httpFetch("POST", "/v1/agents/register", req) as RegisterResponse;
		if (!resp || !resp.agent) {
			throw new Error("coms-net: malformed register response");
		}
		// Without sse_url the agent registers and heartbeats but openSse()
		// silently no-ops forever — never receiving inbound prompts. Fail loud.
		if (typeof resp.sse_url !== "string" || !resp.sse_url) {
			throw new Error("coms-net: malformed register response (missing sse_url)");
		}
		// Server may auto-suffix the name on collision.
		if (resp.agent.name !== identity.name) {
			try {
				pi.appendEntry("coms-net-log", {
					event: "name_collision",
					ts: nowIso(),
					desired: identity.name,
					assigned: resp.agent.name,
					project: identity.project,
				});
			} catch { /* best-effort */ }
			identity.name = resp.agent.name;
		}
		try {
			pi.appendEntry("coms-net-log", {
				event: "register",
				ts: nowIso(),
				session_id: identity.session_id,
				name: identity.name,
				project: identity.project,
			});
		} catch { /* best-effort */ }
		return resp;
	}

	// ━━ session_start ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

	pi.on("session_start", async (_event, ctx) => {
		// session_start can fire again on this same extension instance — session
		// switch, /new, or print/json mode where session_shutdown may never have
		// fired (pi-mono #2576). Tear down any live prior session and reset all
		// per-session state, or the shuttingDown latch stays set and silently
		// disables the extension, and stale identity/maps/timers leak across.
		if (!shuttingDown && (identity || sseAbort || heartbeatTimer || reconnectTimer)) {
			await cleanShutdown();
		}
		shuttingDown = false;
		identity = null;
		serverUrl = null;
		authToken = null;
		sseUrlPath = null;
		peerCards.clear();
		// Settle in-flight entries before clearing so a coms_net_await racing
		// this reset resolves immediately instead of hanging until its own
		// timeout (up to MESSAGE_TIMEOUT_MS).
		for (const entry of pendingReplies.values()) {
			entry.result = { error: "session_reset" };
			try { entry.resolve(entry.result); } catch { /* ignore */ }
		}
		pendingReplies.clear();
		inboundQueue.clear();
		sseAbort = null;
		heartbeatTimer = null;
		reconnectTimer = null;
		reconnectAttempts = 0;
		notifiedReconnectCap = false;
		lastWidgetSnapshot = "";
		heartbeatIntervalMs = HEARTBEAT_MS;

		applyExtensionDefaults(import.meta.url, ctx);
		currentCtx = ctx;

		// 1. Resolve identity from CLI > frontmatter > defaults.
		const flags = readCliFlags(pi);
		const fm = readFrontmatterFromArgv(process.argv);
		const project = flags.project || PROJECT_ENV || "default";
		if (!isSafePathComponent(project)) {
			ctx.ui?.notify?.(`📡 coms-net: invalid --project value "${project}"`, "error");
			return;
		}
		const explicit = flags.explicit === true;
		const session_id = ulid();

		const defaultName = `agent-${session_id.slice(-6)}`;
		const desiredName = flags.name || fm.name || defaultName;
		const purpose = flags.purpose || fm.description || "";

		// Color — fallback chain: --color > frontmatter > deterministic.
		let color = fallbackColor(session_id);
		if (fm.color && isValidHex(fm.color)) color = fm.color;
		if (flags.color && isValidHex(flags.color)) color = flags.color;

		const cwd = ctx.cwd || process.cwd();
		const model = ctx.model?.id ?? "unknown";
		const started_at = nowIso();

		identity = {
			session_id,
			name: desiredName,
			purpose,
			color,
			project,
			explicit,
			cwd,
			model,
			started_at,
		};
		displayProject = project;
		includeExplicit = false;

		// 2. Resolve server URL.
		serverUrl = resolveServerUrl(project, flags.serverUrl);
		if (!serverUrl) {
			if (flags.serverUrl) {
				// An explicit --server-url was provided but rejected as
				// invalid/insecure — say so instead of telling the user to
				// start a server.
				ctx.ui?.notify?.(
					`📡 coms-net: invalid or insecure --server-url "${flags.serverUrl}" (https required for non-loopback hosts)`,
					"error",
				);
				audit("boot_failed", { reason: "invalid_server_url", project });
				return;
			}
			ctx.ui?.notify?.(
				`📡 coms-net: no server URL for project "${project}". Start one with: bun scripts/coms-net-server.ts (planned — not yet shipped in this branch)`,
				"error",
			);
			audit("boot_failed", { reason: "no_server_url", project });
			return;
		}

		// 3. Resolve auth token.
		authToken = resolveAuthToken(project, flags.authToken);
		if (!authToken) {
			ctx.ui?.notify?.(
				`📡 coms-net: no auth token for project "${project}". Set PI_COMS_NET_AUTH_TOKEN or pass --auth-token. ` +
				`If running a local server, ensure ~/.pi/coms-net/projects/${project}/server.secret.json exists with mode 0600 (or 0400).`,
				"error",
			);
			audit("boot_failed", { reason: "no_auth_token", project });
			return;
		}

		// 4. Health check — verify reachability over the authenticated channel
		// (httpFetch attaches the bearer to every request, /health included).
		try {
			await httpFetch("GET", "/health");
		} catch (err) {
			ctx.ui?.notify?.(
				`📡 coms-net: server unreachable at ${serverUrl} — ${safeError(err)}. Start one with: bun scripts/coms-net-server.ts (planned — not yet shipped in this branch)`,
				"error",
			);
			audit("boot_failed", { reason: "health_failed", error: safeError(err) });
			return;
		}

		// 5. Register agent.
		let reg: RegisterResponse;
		try {
			reg = await registerAgent();
		} catch (err) {
			ctx.ui?.notify?.(
				`📡 coms-net: register failed — ${safeError(err)}`,
				"error",
			);
			audit("boot_failed", { reason: "register_failed", error: safeError(err) });
			return;
		}
		sseUrlPath = reg.sse_url;

		// Honor the server-advertised heartbeat cadence when sane (finite,
		// 1s–5min); fall back to the local default so a malformed value can't
		// spin or stall the loop.
		const srvHb = reg.heartbeat_interval_ms;
		heartbeatIntervalMs = typeof srvHb === "number" && Number.isFinite(srvHb) && srvHb >= 1_000
			? Math.min(srvHb, 300_000)
			: HEARTBEAT_MS;

		// 6. Boot audit.
		try {
			pi.appendEntry("coms-net-log", {
				event: "boot",
				ts: nowIso(),
				session_id: identity.session_id,
				name: identity.name,
				project: identity.project,
				server_url: serverUrl,
			});
		} catch { /* best-effort */ }

		// 7. Install widget + status. Success is the default — only failures notify
		// (status line + widget already convey the connected state).
		try {
			ctx.ui.setStatus("coms-net", `📡 ${identity.name}@${identity.project}`);
			installPoolWidget(ctx);
		} catch {
			// hasUI may be false in some contexts.
		}

		// 8. Open SSE — fire and forget.
		void openSse();

		// 9. Heartbeat loop.
		heartbeatTimer = setInterval(() => {
			if (!identity || shuttingDown) return;
			const ctxNow = currentCtx;
			const pct = safeContextPct(ctxNow);
			const hbReq: HeartbeatRequest = {
				project: identity.project,
				context_used_pct: pct,
				queue_depth: inboundQueue.size,
				model: ctxNow?.model?.id ?? identity.model,
				status: "online",
			};
			httpFetch("POST", `/v1/agents/${encodeURIComponent(identity.session_id)}/heartbeat`, hbReq, { timeoutMs: 5_000 })
				.catch((err) => {
					audit("heartbeat_failed", { reason: safeError(err) });
					// 401/403/404 mean the session is dead or the token/URL is wrong —
					// retrying every heartbeatIntervalMs will never succeed, so shut down
					// cleanly instead of spamming the server. (Mirrors the
					// terminal-status handling in scheduleReconnect/openSse.)
					if (err instanceof HttpError && (err.status === 401 || err.status === 403 || err.status === 404)) {
						audit("heartbeat_terminal", { status: err.status });
						void cleanShutdown();
					}
				});

			// Prune expired pending replies so long-lived sessions don't leak
			// entries whose timeout already fired (or that were resolved but
			// never cleaned up).
			const now = Date.now();
			for (const [mid, entry] of pendingReplies.entries()) {
				const limit = (entry.timeout_ms ?? MESSAGE_TIMEOUT_MS) + 60_000;
				// Entries under a coms_net_await deadline measure from the
				// await's start; the default path measures from the message's
				// created_at.
				const base = entry.await_started_at ?? entry.created_at;
				if (now - base > limit) {
					pendingReplies.delete(mid);
				}
			}
			// Evict inbound contexts whose turn never reached agent_end
			// (aborted session): left in place they'd stay branch-anchored,
			// misattribute later sends' hops, and grow the map unboundedly
			// under a prompt flood.
			for (const [mid, ctx] of inboundQueue.entries()) {
				if (now - ctx.created_at > MESSAGE_TIMEOUT_MS + 60_000) {
					inboundQueue.delete(mid);
				}
			}
		}, heartbeatIntervalMs);
		try { (heartbeatTimer as any).unref?.(); } catch { /* ignore */ }
	});

	// ━━ Pool widget rendering ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

	function renderPool(width: number, theme: Theme): string[] {
		interface Row {
			name: string;
			model: string;
			color: string;
			purpose: string;
			pct: number | null;
			pending: boolean;
			stale: boolean;
		}

		const rows: Row[] = [];
		for (const [sid, card] of peerCards.entries()) {
			if (identity && sid === identity.session_id) continue;
			if (!includeExplicit && card.explicit) continue;
			// After `/coms-net --project X` the widget shows project X; SSE
			// events for the own project keep writing cards into peerCards, so
			// filter here or the widget gradually mixes both projects' agents.
			if (displayProject && card.project !== displayProject) continue;
			rows.push({
				name: card.name,
				model: card.model,
				color: card.color,
				purpose: card.purpose,
				pct: typeof card.context_used_pct === "number" ? card.context_used_pct : null,
				pending: card.status === "stale",
				stale: card.status === "offline",
			});
		}

		const safeWidth = Math.max(0, width);
		let topBorder: string;
		let bottomBorder: string;
		if (safeWidth < 16) {
			topBorder = theme.fg("dim", "━".repeat(safeWidth));
			bottomBorder = theme.fg("dim", "━".repeat(safeWidth));
		} else {
			const left = theme.fg("dim", "┏━") + theme.fg("border", " coms-net ");
			const leftFill = theme.fg("dim", "━");
			const nameLen = identity ? identity.name.length : 0;
			// rightTag renders " " + name + " ━" = nameLen + 3 visible cells.
			const rightTagVisLen = identity ? nameLen + 3 : 0;
			// "┏━ coms-net ━" prefix has 13 visible cells.
			const remaining = safeWidth - 13 - rightTagVisLen - 1; // -1 for "┓"
			if (identity && remaining >= 1) {
				const rightTag =
					theme.fg("dim", " ") +
					hexFg(identity.color, identity.name) +
					theme.fg("dim", " ━");
				const middle = theme.fg("dim", "━".repeat(remaining));
				const right = theme.fg("dim", "┓");
				topBorder = left + leftFill + middle + rightTag + right;
			} else {
				const fallbackRemaining = Math.max(0, safeWidth - 2 /* "┏━" */ - 10 /* " coms-net " */ - 1 /* "┓" */);
				const right = theme.fg("dim", `${"━".repeat(fallbackRemaining)}┓`);
				topBorder = left + right;
			}
			bottomBorder = theme.fg("dim", `┗${"━".repeat(safeWidth - 2)}┛`);
		}

		if (rows.length === 0) {
			const emptyMsg = theme.fg("muted", "no peers connected");
			return [
				topBorder,
				truncateToWidth(theme.fg("dim", " ") + emptyMsg, width),
				bottomBorder,
			];
		}

		rows.sort((a, b) => a.name.localeCompare(b.name));

		const out: string[] = [topBorder];

		for (const r of rows) {
			// r.pct originates from a peer's card and can be NaN (typeof NaN ===
			// "number"); without this guard Math.round(NaN) propagates and
			// String.prototype.repeat(NaN) throws RangeError, killing the TUI.
			const pctNum = Number.isFinite(r.pct) ? (r.pct as number) : 0;
			const filled = Math.max(0, Math.min(15, Math.round((pctNum / 100) * 15)));
			const empty = 15 - filled;
			const pctLabel = Number.isFinite(r.pct) ? `${r.pct}%` : "--%";

			if (r.stale) {
				const dimRow = `✗ ${r.name.padEnd(12)} ${abbreviateModel(r.model).padEnd(14)} [${"-".repeat(15)}] ${pctLabel.padStart(4)}  —  ${r.purpose || ""}`;
				out.push(truncateToWidth(` ${theme.fg("dim", dimRow)}`, width));
				continue;
			}

			const swatch = r.pending ? theme.fg("dim", "●") : hexFg(r.color, "●");
			const namePart = theme.fg("accent", r.name.padEnd(12));
			const modelPart = theme.fg("dim", abbreviateModel(r.model).padEnd(14));
			const barFill = r.pending
				? theme.fg("dim", "-".repeat(15))
				: hexFg(r.color, "#".repeat(filled)) + theme.fg("dim", "-".repeat(empty));
			const bar = theme.fg("warning", "[") + barFill + theme.fg("warning", "]");
			const pctPart = ` ${theme.fg("accent", pctLabel.padStart(4))}`;
			const sep = theme.fg("dim", "  —  ");
			const purposePart = theme.fg("muted", r.purpose || "");

			const line = ` ${swatch} ${namePart} ${modelPart} ${bar}${pctPart}${sep}${purposePart}`;
			out.push(truncateToWidth(line, width));
		}

		out.push(bottomBorder);
		return out;
	}

	function installPoolWidget(ctx: ExtensionContext): void {
		if (!ctx.hasUI) return;
		try {
			ctx.ui.setWidget("coms-net-pool", (_tui, theme) => ({
				invalidate() {},
				render(width: number): string[] {
					return renderPool(width, theme);
				},
			}), { placement: "belowEditor" });
		} catch {
			// non-fatal
		}
	}

	// ━━ Tools ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

	pi.registerTool({
		name: "coms_net_list",
		label: "Coms Net List",
		description:
			"List peer agents on the coms-net hub for the current project. Returns names, models, and live context-window usage. " +
			"Set include_explicit=true to reveal agents launched with --explicit.",
		parameters: Type.Object({
			project: Type.Optional(Type.String({ description: "Project name (defaults to caller's project)." })),
			include_explicit: Type.Optional(Type.Boolean({ description: "Include agents launched with --explicit. Default false." })),
		}),
		async execute(_callId, params) {
			if (!identity) {
				throw new Error("coms-net not initialised");
			}
			const projectFilter = (params as any).project ?? identity.project;
			const includeExp = (params as any).include_explicit === true;
			const qs = `?project=${encodeURIComponent(projectFilter)}&include_explicit=${includeExp ? "true" : "false"}`;
			let resp: any;
			try {
				resp = await httpFetch("GET", `/v1/agents${qs}`);
			} catch (err) {
				if (err instanceof HttpError) {
					const detail = (err.body?.error) || err.message;
					throw new Error(`coms-net: list failed (${err.status}): ${detail}`);
				}
				throw new Error(`coms-net: list failed: ${safeError(err)}`);
			}
			const rawAgents: any[] = Array.isArray(resp?.agents) ? resp.agents : [];
			// Cards are peer-controlled — coerce untrusted string fields so a
			// non-string name/model can't throw out of abbreviateModel and
			// escape execute().
			const agents: AgentCard[] = [];
			for (const a of rawAgents) {
				const card = sanitizeCard(a);
				if (card) agents.push(card);
			}
			const peers = agents.filter(a => a.session_id !== identity!.session_id);

			const lines = peers.length === 0
				? "No peer agents found."
				: peers.map((a) => {
					const live = a.status === "online" ? "●" : a.status === "stale" ? "~" : "✗";
					const ctxStr = typeof a.context_used_pct === "number" ? ` ${a.context_used_pct}%` : " ?%";
					return `${live} ${a.name} (${abbreviateModel(a.model)})${ctxStr}${a.purpose ? ` — ${a.purpose}` : ""}`;
				}).join("\n");

			return {
				content: [{ type: "text" as const, text: `${peers.length} peer(s):\n${lines}` }],
				details: { agents: peers, project: projectFilter },
			};
		},
		renderCall(args, theme) {
			const proj = (args as any).project;
			const filter = proj ? ` ${proj}` : "";
			return new Text(
				theme.fg("toolTitle", theme.bold("coms_net_list")) + theme.fg("dim", filter),
				0, 0,
			);
		},
		renderResult(result, options, theme) {
			const details = result.details as any;
			const agents: any[] = details?.agents ?? [];
			const header = theme.fg("accent", `📡 ${agents.length} peer(s)`);
			if (!options.expanded || agents.length === 0) {
				return new Text(header, 0, 0);
			}
			const rows = agents.map((a) => {
				const dot = a.status === "online" ? theme.fg("success", "●")
					: a.status === "stale" ? theme.fg("warning", "~")
					: theme.fg("error", "✗");
				const pct = typeof a.context_used_pct === "number" ? `${a.context_used_pct}%` : "?%";
				return `${dot} ${theme.fg("accent", a.name)} ${theme.fg("dim", abbreviateModel(a.model))} ${theme.fg("warning", pct)}`;
			}).join("\n");
			return new Text(`${header}\n${rows}`, 0, 0);
		},
	});

	pi.registerTool({
		name: "coms_net_send",
		label: "Coms Net Send",
		description:
			"INITIATE a new outbound message to a peer agent on the coms-net hub. " +
			"Returns synchronously with a msg_id once the server queues the prompt. " +
			"Use coms_net_get (non-blocking) or coms_net_await (blocking) with that msg_id to retrieve the peer's reply.\n\n" +
			"⚠️  DO NOT call this tool to REPLY to an inbound message. " +
			"When you receive a `[from <peer>] …` follow-up, just write your answer as your normal assistant message — " +
			"the coms-net extension automatically captures the final assistant text at the end of your turn and " +
			"submits it back to the original caller. Calling coms_net_send in response creates an infinite ping-pong loop.\n\n" +
			"Only valid uses: (a) you, the user, or your task explicitly ask to start a new conversation with a peer; " +
			"(b) you are forwarding/delegating to a *different* peer than the one whose prompt you are currently answering; " +
			"in that case `hops` is auto-incremented and the hop limit will eventually stop runaway chains.",
		parameters: Type.Object({
			target: Type.String({ description: "Peer name (preferred, scoped to your project) or session_id." }),
			prompt: Type.String({ description: "The prompt to send." }),
			conversation_id: Type.Optional(Type.String()),
			response_schema: Type.Optional(Type.Any({ description: "Optional JSON Schema describing the expected response shape." })),
		}),
		async execute(_callId, params) {
			if (!identity) throw new Error("coms-net not initialised");

			const active = activeInbound();
			const hops = active ? active.hops + 1 : 0;
			if (hops >= MAX_HOPS) {
				throw new Error(`coms-net: hop limit reached (${hops} >= ${MAX_HOPS})`);
			}

			const conversationId = typeof (params as any).conversation_id === "string" ? (params as any).conversation_id : null;
			// Coerce with the same rule the receiver applies in
			// handleInboundPrompt: a string/number schema would otherwise cross
			// the wire and be silently dropped, masking a caller error in a
			// contract parameter.
			const schemaParam = (params as any).response_schema;
			const responseSchema = (schemaParam && typeof schemaParam === "object") ? schemaParam as object : null;

			const req: SendRequest = {
				project: identity.project,
				sender_session: identity.session_id,
				target: params.target,
				target_session: null,
				prompt: params.prompt,
				conversation_id: conversationId,
				response_schema: responseSchema,
				hops,
			};

			let resp: SendResponse;
			try {
				resp = await httpFetch("POST", "/v1/messages", req) as SendResponse;
			} catch (err) {
				if (err instanceof HttpError) {
					const detail = (err.body?.error) || err.message;
					throw new Error(`coms-net: send failed (${err.status}): ${detail}`);
				}
				throw new Error(`coms-net: send failed: ${safeError(err)}`);
			}
			// Without a string msg_id the pending entry would key the map by
			// `undefined` and the SSE response could never match it.
			if (typeof resp?.msg_id !== "string" || !resp.msg_id) {
				throw new Error("coms-net: malformed send response (missing msg_id)");
			}
			const { msg_id, target_session } = resp;

			// Park a pending entry that the SSE `response` event will resolve.
			let resolveFn!: (v: { response?: any; error?: string | null }) => void;
			const promise = new Promise<{ response?: any; error?: string | null }>((res) => {
				resolveFn = res;
			});
			pendingReplies.set(msg_id, {
				resolve: resolveFn,
				promise,
				target_name: params.target,
				target_session,
				conversation_id: conversationId,
				created_at: Date.now(),
				timeout_ms: MESSAGE_TIMEOUT_MS,
			});

			try {
				pi.appendEntry("coms-net-log", {
					event: "prompt_out",
					ts: nowIso(),
					msg_id,
					target: params.target,
					target_session,
					hops,
				});
			} catch { /* best-effort */ }

			return {
				content: [{
					type: "text" as const,
					text: `coms_net_send → ${params.target}\nmsg_id ${msg_id}\nhops ${hops}`,
				}],
				details: { msg_id, target: params.target, target_session, hops, conversation_id: conversationId },
			};
		},
		renderCall(args, theme) {
			const tgt = (args as any).target ?? "?";
			const prompt = (args as any).prompt ?? "";
			const preview = prompt.length > 60 ? `${prompt.slice(0, 57)}...` : prompt;
			return new Text(
				theme.fg("toolTitle", theme.bold("coms_net_send ")) +
				theme.fg("accent", tgt) +
				theme.fg("dim", " — ") +
				theme.fg("muted", preview),
				0, 0,
			);
		},
		renderResult(result, _options, theme) {
			const d = result.details as any;
			if (!d) {
				const t = result.content[0];
				return new Text(t?.type === "text" ? t.text : "", 0, 0);
			}
			return new Text(
				theme.fg("success", "→ ") +
				theme.fg("accent", d.target) +
				theme.fg("dim", "  msg_id ") +
				theme.fg("warning", d.msg_id),
				0, 0,
			);
		},
	});

	pi.registerTool({
		name: "coms_net_get",
		label: "Coms Net Get",
		description:
			"Non-blocking poll of a reply to YOUR OWN coms_net_send. Returns status pending|complete|error and (when complete) the response. " +
			"Same caveat as coms_net_await: only use msg_ids you got back from coms_net_send, never msg_ids from an inbound `[from <peer>] …` prompt — " +
			"those belong to the peer, and replying to them happens automatically via your normal assistant message at end of turn.",
		parameters: Type.Object({
			msg_id: Type.String({ description: "msg_id returned by coms_net_send." }),
		}),
		async execute(_callId, params) {
			const msg_id = (params as any).msg_id as string;
			// Local SSE-resolved fast path.
			const pending = pendingReplies.get(msg_id);
			if (pending?.result) {
				const r = pending.result;
				const text = r.error
					? `coms_net_get: error — ${r.error}`
					: `coms_net_get: complete\n${typeof r.response === "string" ? r.response : JSON.stringify(r.response, null, 2)}`;
				return {
					content: [{ type: "text" as const, text }],
					details: { status: "complete", response: r.response, error: r.error ?? null, conversation_id: pending.conversation_id ?? null },
				};
			}
			// Fall back to server.
			let resp: any;
			try {
				resp = await httpFetch("GET", `/v1/messages/${encodeURIComponent(msg_id)}`);
			} catch (err) {
				if (err instanceof HttpError && err.status === 404) {
					return {
						content: [{ type: "text" as const, text: `coms_net_get: unknown msg_id ${msg_id}` }],
						details: { status: "error", error: "unknown msg_id" },
					};
				}
				return {
					content: [{ type: "text" as const, text: `coms_net_get: error — ${safeError(err)}` }],
					details: { status: "error", error: safeError(err) },
				};
			}
			const status = resp?.status ?? "pending";
			const conversationId = typeof resp?.conversation_id === "string" ? resp.conversation_id : null;
			if (status === "complete" || status === "error" || status === "timeout") {
				const text = resp.error
					? `coms_net_get: ${status} — ${resp.error}`
					: `coms_net_get: ${status}\n${typeof resp.response === "string" ? resp.response : (JSON.stringify(resp.response, null, 2) ?? "")}`;
				return {
					content: [{ type: "text" as const, text }],
					details: { status, response: resp.response, error: resp.error ?? null, conversation_id: conversationId },
				};
			}
			return {
				content: [{ type: "text" as const, text: `coms_net_get: ${status}` }],
				details: { status, conversation_id: conversationId },
			};
		},
		renderCall(args, theme) {
			const id = (args as any).msg_id ?? "?";
			return new Text(
				theme.fg("toolTitle", theme.bold("coms_net_get ")) + theme.fg("warning", id),
				0, 0,
			);
		},
		renderResult(result, _options, theme) {
			const d = result.details as any;
			const status = d?.status ?? "?";
			const color = status === "complete" ? "success"
				: status === "pending" || status === "queued" || status === "delivered" ? "warning"
				: "error";
			return new Text(theme.fg(color, status), 0, 0);
		},
	});

	pi.registerTool({
		name: "coms_net_await",
		label: "Coms Net Await",
		description:
			"Block until the reply to YOUR OWN outbound coms_net_send arrives, or the timeout fires (default 30 min). " +
			"Only call this with a msg_id that YOU received as the return value of a coms_net_send call you just made.\n\n" +
			"⚠️  Do NOT call this with a msg_id that came in via an inbound `[from <peer>] …` prompt — those msg_ids belong to the *peer's* outbound, not yours. " +
			"To reply to an inbound message, do nothing special: just answer normally as your assistant message, " +
			"and the extension will auto-submit your final text back to the caller when your turn ends.",
		parameters: Type.Object({
			msg_id: Type.String({ description: "msg_id returned by coms_net_send." }),
			timeout_ms: Type.Optional(Type.Number({ description: "Override the default timeout (ms). Server cap applies." })),
		}),
		async execute(_callId, params) {
			const msg_id = (params as any).msg_id as string;
			// Clamp to the documented server cap: an uncapped value lets
			// Infinity / >2³¹−1 collapse to ~1ms in setTimeout (instant spurious
			// timeout), and a huge value would block the agent far past the
			// "Server cap applies" contract.
			const rawTimeout = (params as any).timeout_ms;
			const timeoutMs = typeof rawTimeout === "number" && Number.isFinite(rawTimeout) && rawTimeout > 0
				? Math.min(rawTimeout, MESSAGE_TIMEOUT_MS)
				: MESSAGE_TIMEOUT_MS;

			// Local SSE-resolved fast path.
			const pending = pendingReplies.get(msg_id);
			if (pending?.awaiting) {
				// A coms_net_await is already racing this reply — a second one
				// would double-consume it (or hit "unknown msg_id" after the
				// first await deletes the entry).
				return {
					content: [{ type: "text" as const, text: `coms_net_await: error — already awaiting msg_id ${msg_id}` }],
					details: { error: "already_awaiting" },
				};
			}
			// Record the effective deadline so the heartbeat pruning loop honors
			// the caller's timeout instead of the default MESSAGE_TIMEOUT_MS,
			// measured from this invocation (the server-side await starts now,
			// not at coms_net_send time).
			if (pending) {
				pending.awaiting = true;
				pending.timeout_ms = timeoutMs;
				pending.await_started_at = Date.now();
			}
			if (pending?.result) {
				// Already resolved locally via SSE: this await consumes the reply,
				// so free the entry now rather than waiting for the prune sweep.
				pendingReplies.delete(msg_id);
				const r = pending.result;
				if (r.error) {
					return {
						content: [{ type: "text" as const, text: `coms_net_await: error — ${r.error}` }],
						details: { error: r.error },
					};
				}
				const resp = r.response;
				return {
					content: [{ type: "text" as const, text: typeof resp === "string" ? resp : (JSON.stringify(resp, null, 2) ?? "") }],
					details: { response: resp },
				};
			}

			// Race the server long-poll (and the local SSE promise, when one is
			// tracked for this msg_id) against the timeout. pending.promise is only
			// entered into the race when a local entry exists, so the absence of one
			// no longer plants a never-resolving placeholder that pins closures.
			const serverTimeoutMs = Math.min(timeoutMs, MESSAGE_TIMEOUT_MS);
			const ac = new AbortController();
			const serverPromise = httpFetch(
				"GET",
				`/v1/messages/${encodeURIComponent(msg_id)}/await?timeout_ms=${serverTimeoutMs}`,
				undefined,
				{ timeoutMs: serverTimeoutMs + 5_000, signal: ac.signal },
			).then((data: any) => {
				if (data?.status === "complete") return { response: data.response, error: null };
				if (data?.status === "error") return { response: null, error: data.error ?? "error" };
				if (data?.status === "timeout") return { response: null, error: "timeout" };
				// A non-terminal status (queued/delivered/pending) or a missing
				// one must not alias to a successful empty reply.
				return { response: null, error: `unexpected_status:${data?.status ?? "unknown"}` };
			}).catch((err) => {
				if (err instanceof HttpError) {
					if (err.status === 404) {
						return { response: null, error: "unknown msg_id" };
					}
					// Fatal server-side auth rejection (401/403). Unlike a transient
					// network error this cannot resolve on retry, so aliasing to
					// pending.promise only stalls until timeoutPromise fires (up to
					// MESSAGE_TIMEOUT_MS = 30 min). Fail fast with an actionable error
					// rather than hanging the agent on a deterministic failure.
					if (err.status === 401 || err.status === 403) {
						return { response: null, error: `authentication_failed (${err.status})` };
					}
				}
				// Transient network error on the long-poll (timeout, connection
				// reset, …). When a local SSE entry tracks this msg_id, alias its
				// promise so serverPromise settles cleanly with the local result
				// (still bounded by timeoutPromise — pending.promise is also a
				// direct racer, so this changes no race outcome, only avoids
				// leaving serverPromise pending forever). If no local entry
				// exists, there is no other delivery path: fail fast with an
				// actionable error rather than hanging the agent for the full
				// timeoutMs.
				if (pending) return pending.promise;
				return { response: null, error: "server_poll_failed" };
			});

			let timeoutTimer: NodeJS.Timeout | undefined;
			const timeoutPromise = new Promise<{ error: string }>((resolve) => {
				timeoutTimer = setTimeout(() => resolve({ error: "timeout" }), timeoutMs);
				try { timeoutTimer.unref?.(); } catch { /* ignore */ }
			});

			const racers: Promise<{ response?: any; error?: string | null }>[] = [serverPromise, timeoutPromise];
			if (pending) racers.push(pending.promise);
			const winner = await Promise.race(racers);
			clearTimeout(timeoutTimer);
			try { ac.abort(); } catch { /* ignore */ }
			// The reply is fully consumed by this await (success, error, or
			// timeout). Drop the entry immediately instead of leaving it for the
			// heartbeat pruning loop to reclaim up to timeout_ms + 60s later.
			pendingReplies.delete(msg_id);

			if ((winner as any).error) {
				return {
					content: [{ type: "text" as const, text: `coms_net_await: error — ${(winner as any).error}` }],
					details: { error: (winner as any).error },
				};
			}
			const resp = (winner as any).response;
			return {
				content: [{ type: "text" as const, text: typeof resp === "string" ? resp : (JSON.stringify(resp, null, 2) ?? "") }],
				details: { response: resp },
			};
		},
		renderCall(args, theme) {
			const id = (args as any).msg_id ?? "?";
			return new Text(
				theme.fg("toolTitle", theme.bold("coms_net_await ")) + theme.fg("warning", id),
				0, 0,
			);
		},
		renderResult(result, _options, theme) {
			const d = result.details as any;
			if (d?.error) return new Text(theme.fg("error", `✗ ${d.error}`), 0, 0);
			return new Text(theme.fg("success", "✓ response received"), 0, 0);
		},
	});

	// ━━ agent_end: capture turn output and submit response ━━━━━━━━━━━━━━━━

	pi.on("agent_end", async (_event, ctx) => {
		const inbound = activeInbound(ctx);
		if (!inbound || !identity) return;

		// Walk the session branch for the most recent assistant text *after* the
		// inbound prompt entry, so a stale reply from an earlier turn is never
		// resent if this turn produced no new assistant message. Only overwrite
		// on non-empty text — a later assistant message that's tool-calls-only
		// (no text block) must not blank out a real reply from an earlier
		// message in the same turn.
		let lastAssistantText = "";
		let foundInbound = false;
		for (const entry of ctx.sessionManager?.getBranch() ?? []) {
			if (!foundInbound) {
				if (entry.type === "message" && entry.message && (entry.message as any).details?.msg_id === inbound.msg_id) {
					foundInbound = true;
				}
				continue;
			}
			if (entry.type === "message" && entry.message && entry.message.role === "assistant") {
				const m = entry.message as any;
				let msgText = "";
				if (typeof m.content === "string") {
					msgText = m.content;
				} else if (Array.isArray(m.content)) {
					msgText = m.content
						.filter((b: any) => b && b.type === "text")
						.map((b: any) => b.text)
						.join("\n");
				}
				if (msgText.trim()) {
					lastAssistantText = msgText;
				}
			}
		}

		let payload: any = lastAssistantText;
		let error: string | null = null;
		if (!lastAssistantText.trim()) {
			// An aborted / tool-calls-only / errored turn produced no assistant
			// text — POSTing "" with error: null would resolve the caller's
			// coms_net_await with a blank success instead of a real failure.
			error = "empty response (turn produced no reply text)";
			payload = null;
		} else if (inbound.response_schema && typeof inbound.response_schema === "object") {
			// Models frequently wrap structured output in a ```json fence even when
			// asked for raw JSON — unwrap one before parsing so that common case
			// doesn't spuriously fail with "response not valid JSON".
			const fenced = lastAssistantText.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/i);
			const jsonText = fenced ? fenced[1] : lastAssistantText;
			try {
				payload = JSON.parse(jsonText);
			} catch {
				error = "response not valid JSON";
				payload = null;
			}
		}

		const req: ResponseSubmitRequest = {
			project: identity.project,
			responder_session: identity.session_id,
			response: payload,
			error,
			conversation_id: inbound.conversation_id,
		};

		try {
			await httpFetch("POST", `/v1/messages/${encodeURIComponent(inbound.msg_id)}/response`, req);
			try {
				pi.appendEntry("coms-net-log", {
					event: "response_out",
					ts: nowIso(),
					msg_id: inbound.msg_id,
					error,
				});
			} catch { /* best-effort */ }
		} catch (e: any) {
			audit("response_out_failed", { msg_id: inbound.msg_id, reason: safeError(e) });
		}

		inbound.fulfilled = true;
		inboundQueue.delete(inbound.msg_id);
	});

	// ━━ /coms-net slash command ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

	pi.registerCommand("coms-net", {
		description: "Refresh the coms-net pool widget; or --all / --project <name> / --server / --reconnect",
		handler: async (args, ctx) => {
			const trimmed = (args ?? "").trim();
			// Tokenize so `--all` etc. match only as exact tokens — substring
			// matching would also fire on `--allow`, `--allfoo`, or a project
			// name containing "--all".
			const tokens = trimmed.split(/\s+/).filter(Boolean);
			if (tokens.includes("--all")) {
				includeExplicit = !includeExplicit;
				try { ctx.ui.notify(`coms-net: include_explicit = ${includeExplicit}`, "info"); } catch { /* ignore */ }
			}
			if (tokens.includes("--reconnect")) {
				try { ctx.ui.notify("coms-net: reconnecting SSE...", "info"); } catch { /* ignore */ }
				// A pending scheduled reconnect must not fire alongside this
				// manual one — that would double the register + SSE-open.
				if (reconnectTimer) {
					try { clearTimeout(reconnectTimer); } catch { /* ignore */ }
					reconnectTimer = null;
				}
				if (sseAbort) {
					try { sseAbort.abort(); } catch { /* ignore */ }
					sseAbort = null;
				}
				reconnectAttempts = 0;
				notifiedReconnectCap = false;
				try { await reRegisterAndOpen(); } catch (err) { audit("manual_reconnect_failed", { reason: safeError(err) }); }
			}
			if (tokens.includes("--server")) {
				try {
					const health = await httpFetch("GET", "/health");
					ctx.ui?.notify?.(
						`coms-net server: ${serverUrl} · version ${health?.version ?? "?"} · server_id ${health?.server_id ?? "?"}`,
						"info",
					);
				} catch (err) {
					ctx.ui?.notify?.(`coms-net: server health failed — ${safeError(err)}`, "error");
				}
			}
			const projectIdx = tokens.indexOf("--project");
			const projectArg = projectIdx >= 0 ? tokens[projectIdx + 1] : undefined;
			if (projectArg) {
				displayProject = projectArg;
				try { ctx.ui.notify(`coms-net: displaying project ${displayProject}`, "info"); } catch { /* ignore */ }
			}

			// Bare invocation or after --project: force-refresh.
			try {
				const projectFilter = displayProject ?? identity?.project ?? "default";
				const qs = `?project=${encodeURIComponent(projectFilter)}&include_explicit=${includeExplicit ? "true" : "false"}`;
				const resp = await httpFetch("GET", `/v1/agents${qs}`);
				const agents: AgentCard[] = Array.isArray(resp?.agents) ? resp.agents : [];
				peerCards.clear();
				for (const a of agents) {
					const card = sanitizeCard(a);
					if (!card) continue;
					if (identity && card.session_id === identity.session_id) continue;
					peerCards.set(card.session_id, card);
				}
				maybeRequestRender();
			} catch (err) {
				audit("refresh_failed", { reason: safeError(err) });
				try { ctx.ui?.notify?.(`coms-net: refresh failed — ${safeError(err)}`, "error"); } catch { /* ignore */ }
			}
		},
	});

	// ━━ Clean shutdown (idempotent) ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

	// Best-effort DELETE of this agent's registration. Shared by cleanShutdown
	// and by reRegisterAndOpen's orphan-cleanup path; never throws.
	async function unregisterAgentBestEffort(timeoutMs: number): Promise<void> {
		if (!identity || !serverUrl || !authToken) return;
		const ac = new AbortController();
		const t = setTimeout(() => { try { ac.abort(); } catch { /* ignore */ } }, timeoutMs);
		try { (t as any).unref?.(); } catch { /* ignore */ }
		try {
			await httpFetch(
				"DELETE",
				`/v1/agents/${encodeURIComponent(identity.session_id)}?project=${encodeURIComponent(identity.project)}`,
				undefined,
				{ signal: ac.signal },
			);
		} catch {
			// best-effort — server may already be gone.
		} finally {
			try { clearTimeout(t); } catch { /* ignore */ }
		}
	}

	async function cleanShutdown(): Promise<void> {
		if (shuttingDown) return;
		shuttingDown = true;

		if (heartbeatTimer) {
			try { clearInterval(heartbeatTimer); } catch { /* ignore */ }
			heartbeatTimer = null;
		}
		if (reconnectTimer) {
			try { clearTimeout(reconnectTimer); } catch { /* ignore */ }
			reconnectTimer = null;
		}
		if (sseAbort) {
			try { sseAbort.abort(); } catch { /* ignore */ }
			sseAbort = null;
		}

		// Best-effort DELETE with short timeout.
		await unregisterAgentBestEffort(SHUTDOWN_DELETE_TIMEOUT_MS);

		if (identity) {
			try {
				pi.appendEntry("coms-net-log", {
					event: "shutdown",
					ts: nowIso(),
					session_id: identity.session_id,
				});
			} catch { /* best-effort */ }
		}

		if (currentCtx?.hasUI) {
			try { currentCtx.ui.setWidget("coms-net-pool", undefined); } catch { /* ignore */ }
			try { currentCtx.ui.setStatus("coms-net", ""); } catch { /* ignore */ }
		}
	}

	// Rely on the host's session_shutdown event for cleanup. Registering
	// process-level SIGINT/SIGTERM handlers from an extension suppresses Node's
	// default termination (once any listener attaches, Ctrl-C no longer exits)
	// and can hang the host on shutdown. The host owns process lifecycle.
	pi.on("session_shutdown", async () => { await cleanShutdown(); });
}
