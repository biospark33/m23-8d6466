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
 *   # start your coms-net hub server first (external — not shipped in this
 *   # branch; see _bmad-output/sprint-artifacts/_research/oq-1-coms-arch-decision.md)
 *   pi -e pi-vs-claude-code-vendor/coms-net.ts                     # auto-discover local server.json
 *   pi -e pi-vs-claude-code-vendor/coms-net.ts --server-url http://host:port \
 *      --auth-token <tok> --cname planner --project default
 *
 * Note: the agent name flag is `--cname` (not `--name`). pi's own harness owns
 * `--name` and resumes it across sessions, so coms-net uses a distinct flag.
 */

import type { AgentToolResult, ExtensionAPI, ExtensionContext, Theme } from "@mariozechner/pi-coding-agent";
import { Text, truncateToWidth } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";
import { applyExtensionDefaults } from "./themeMap.ts";
import {
	abbreviateModel,
	envBoundedInt,
	fallbackColor,
	hexFg,
	isDuplicateRegistration,
	isSafePathComponent,
	isValidHex,
	isWireRecord,
	type WireRecord,
	MAX_FULFILLED_TOMBSTONES,
	MAX_HOPS,
	MAX_INBOUND,
	MAX_PENDING_EXIT_DISPATCHES,
	MAX_RESPONSE_BYTES,
	MAX_RESPONSE_SCHEMA_BYTES,
	EXIT_DELIVER_BUDGET_MS,
	nowIso,
	readFrontmatterFromArgv,
	sanitizePeerText,
	ulid,
} from "./coms-core.ts";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { spawnSync } from "node:child_process";

// ━━ Constants ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

const COMS_NET_DIR = path.join(os.homedir(), ".pi", "coms-net");
// Env overrides for tunables are clamped by envBoundedInt (imported from
// ./coms-core.ts): `Number(env) || DEFAULT` would reject a legitimate 0,
// accept -1 (setInterval(-1) spins at ~1ms — a self-DoS) or Infinity (silently
// disables hop protection), and allow unbounded TTLs that pin memory for days.
// MAX_HOPS is fixed at the documented guard (5), imported from core.
const HEARTBEAT_MS = envBoundedInt(process.env.PI_COMS_NET_HEARTBEAT_MS, 10_000, { min: 1_000, max: 300_000 });
const RECONNECT_BASE_MS = 500;
const RECONNECT_MAX_MS = 10_000;
const MESSAGE_TIMEOUT_MS = envBoundedInt(process.env.PI_COMS_NET_MESSAGE_TTL_MS, 1_800_000, { min: 1_000, max: 86_400_000 });
const HTTP_TIMEOUT_MS = 10_000;
const SSE_BUF_CAP_BYTES = 16 * 1024 * 1024;
const HTTP_BODY_CAP_BYTES = 16 * 1024 * 1024;
const SHUTDOWN_DELETE_TIMEOUT_MS = 2_000;
// Receiver-side prompt cap (byte length). coms_net_send enforces this same
// value before POSTing (send-side == receive-side), or the receiver's silent
// drop would leave the caller waiting until its own await times out.
// Intentionally 200_000, NOT coms.ts's 256*1024: this is a transport-specific
// HTTP cap, whereas coms.ts sizes its cap against the local-IPC 16MB×256
// envelope-queue memory pin, a concern that does not exist over HTTP. See
// DIVERGENCE.md.
const MAX_PROMPT_BYTES = 200_000;
// MAX_INBOUND, MAX_FULFILLED_TOMBSTONES, MAX_PENDING_EXIT_DISPATCHES,
// EXIT_DELIVER_BUDGET_MS, MAX_RESPONSE_BYTES and MAX_RESPONSE_SCHEMA_BYTES are
// imported from ./coms-core.ts — identical value and meaning in both
// transports (see DIVERGENCE.md).
const EXIT_DELIVER_TIMEOUT_MS = 4_000;
// Bounded wait for the session_start/session_shutdown init latch: a wedged
// init must not spin the poll loop forever — on timeout proceed and audit
// loudly (mirrors coms.ts INIT_LATCH_TIMEOUT_MS).
const INIT_LATCH_TIMEOUT_MS = envBoundedInt(process.env.PI_COMS_NET_INIT_LATCH_TIMEOUT_MS, 30_000, { min: 1_000, max: 300_000 });
// SSE watchdog: server pings must arrive within this factor of the heartbeat
// interval, or the (half-open) connection is torn down and reconnected. A
// silently-dead connection would otherwise heartbeat "online" forever while
// never receiving prompts. Server pings must arrive at least once per
// heartbeat interval for this to be correct (see server contract, B9 comment).
const SSE_WATCHDOG_FACTOR = 3;

const SERVER_URL_ENV = process.env.PI_COMS_NET_SERVER_URL;
const AUTH_TOKEN_ENV = process.env.PI_COMS_NET_AUTH_TOKEN;
const PROJECT_ENV = process.env.PI_COMS_NET_PROJECT;

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
	response: unknown;
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
	// Set synchronously when agent_end claims this entry for submission and
	// cleared when the first POST settles (fulfilled, or a retry timer armed
	// — the responseRetryTimers guard covers it from there). Closes the
	// duplicate-POST window where a second fire-and-forget agent_end could
	// fallback-submit an inbound whose first POST is still in flight.
	dispatching: boolean;
	// Epoch ms at receipt; the heartbeat sweep evicts entries that never
	// reached agent_end (aborted turns) so they can't linger forever or
	// misattribute later sends' hops.
	created_at: number;
}

// The synchronous half of a response submission (payload/schema handling +
// exit-dispatch bookkeeping), produced by prepareInboundResponse and consumed
// by submitInboundResponse. Split so a batched agent_end can push EVERY
// dispatch before its first await (see agent_end).
interface PreparedInboundResponse {
	inbound: InboundContext;
	req: ResponseSubmitRequest;
	error: string | null;
	dispatch: { msg_id: string; url: string; body: string; token: string; done: boolean };
	dropDispatch: () => void;
}

interface PendingReply {
	resolve: (value: { response?: unknown; error?: string | null }) => void;
	promise: Promise<{ response?: unknown; error?: string | null }>;
	result?: { response?: unknown; error?: string | null };
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

// One-shot synchronous delivery script for the 'exit' fallback (see the exit
// handler at the bottom of the default export). In pi's print/json mode (-p)
// main.js calls process.exit(0) right after the final turn and can kill the
// floating agent_end listener mid-POST; this re-POSTs the response body
// (given via env so argv layout differences under bun don't matter) and
// exits as soon as the server answers. Plain CommonJS so it runs under both
// node and bun via `process.execPath -e`.
const EXIT_DELIVER_SCRIPT = `
const url = process.env.COMS_NET_DELIVER_URL;
const headers = { "Authorization": "Bearer " + (process.env.COMS_NET_DELIVER_TOKEN || ""), "Content-Type": "application/json", "Accept": "application/json" };
const body = require("node:fs").readFileSync(0, "utf-8");
fetch(url, { method: "POST", headers, body })
	.then(() => process.exit(0))
	.catch(() => process.exit(1));
setTimeout(() => process.exit(2), ${EXIT_DELIVER_TIMEOUT_MS}).unref();
`;

// Responses not yet confirmed delivered by the async POST path — see the
// 'exit' handler at the bottom of the default export for the print/json-mode
// exit race this covers (mirrors coms.ts pendingExitDispatches). Module-level
// (not per-extension-instance) so the single install-once 'exit' handler sees
// live state even after an extension reload stacks a second default-export
// invocation. The token is captured per dispatch at push time: the handler
// closure may belong to a stale instance whose authToken was already nulled
// by a session_start reset.
const pendingExitDispatches: { msg_id: string; url: string; body: string; token: string; done: boolean }[] = [];
let exitHandlerInstalled = false;

// ━━ Helpers — transport-specific; shared/parity helpers live in coms-core.ts ━
//
// ulid, hexFg, fallbackColor, abbreviateModel, sanitizePeerText,
// isSafePathComponent, nowIso, findSystemPromptPath and
// readFrontmatterFromArgv are imported from ./coms-core.ts. The card/body
// helpers below are net-transport-specific and stay here.

// Cards arrive over the wire from the hub (ultimately from other peers), so
// their string fields are untrusted: coerce non-strings to safe defaults and
// strip control characters / cap length, or a single malformed card crashes
// widget rendering (localeCompare/padEnd on a non-string). A card without a
// string session_id is unusable as a map key — drop it.
function sanitizeCard(a: unknown): AgentCard | null {
	if (!isWireRecord(a) || typeof a.session_id !== "string" || !a.session_id) return null;
	// Coerce the status enum: an out-of-enum or missing status (e.g. from the
	// agent_updated defensive join path, which may lack it entirely) would
	// render as "online" with a --% bar — default to offline, the safe
	// pessimistic reading.
	const status: AgentStatus = a.status === "online" || a.status === "stale" || a.status === "offline" ? a.status : "offline";
	// Every AgentCard field is built explicitly (no `...a` spread): the spread
	// also carried unrecognised wire keys into a value declared AgentCard, and
	// those keys have no reader — they only rode along into rendered details.
	return {
		session_id: a.session_id,
		name: sanitizePeerText(a.name, "?"),
		purpose: sanitizePeerText(a.purpose),
		model: sanitizePeerText(a.model, "?"),
		provider: typeof a.provider === "string" ? a.provider : undefined,
		color: sanitizePeerText(a.color),
		cwd: sanitizePeerText(a.cwd),
		project: sanitizePeerText(a.project),
		explicit: a.explicit === true,
		started_at: typeof a.started_at === "string" ? a.started_at : "",
		// Non-numeric/non-finite peer values become NaN, which every consumer
		// already screens with Number.isFinite (bar/label rendering, list
		// details) — same rendering as the old untyped passthrough, but the
		// declared `number` is now true.
		context_used_pct: wireFiniteNumber(a.context_used_pct),
		queue_depth: wireFiniteNumber(a.queue_depth),
		status,
	};
}

// A peer-supplied numeric field: pass finite numbers through, map everything
// else (missing, string, null, NaN, Infinity) to NaN so the value is a real
// `number` and still fails the Number.isFinite checks at each use site.
function wireFiniteNumber(v: unknown): number {
	return typeof v === "number" && Number.isFinite(v) ? v : Number.NaN;
}

// Same coercion for the partial fields of an agent_updated patch — only the
// fields actually present in the patch.
function sanitizeCardPatch(a: WireRecord): Partial<AgentCard> {
	const out: Partial<AgentCard> = {};
	// Only known AgentCard fields are copied out — an unrecognised wire key
	// has no reader anyway, and dropping it keeps the patch honest.
	if (a.name !== undefined) out.name = sanitizePeerText(a.name, "?");
	if (a.purpose !== undefined) out.purpose = sanitizePeerText(a.purpose);
	if (a.model !== undefined) out.model = sanitizePeerText(a.model, "?");
	if (a.color !== undefined) out.color = sanitizePeerText(a.color);
	if (a.cwd !== undefined) out.cwd = sanitizePeerText(a.cwd);
	if (a.project !== undefined) out.project = sanitizePeerText(a.project);
	if (typeof a.session_id === "string") out.session_id = a.session_id;
	if (typeof a.provider === "string") out.provider = a.provider;
	if (a.explicit !== undefined) out.explicit = a.explicit === true;
	if (typeof a.started_at === "string") out.started_at = a.started_at;
	if (a.context_used_pct !== undefined) out.context_used_pct = wireFiniteNumber(a.context_used_pct);
	if (a.queue_depth !== undefined) out.queue_depth = wireFiniteNumber(a.queue_depth);
	// Same enum coercion as sanitizeCard: an out-of-enum status from a patch
	// would overwrite a card's valid status, and renderPool treats anything
	// not stale/offline as live — a liveness spoof from a buggy/hostile
	// heartbeat payload. Default to offline, the safe pessimistic reading.
	if (a.status !== undefined) out.status = a.status === "online" || a.status === "stale" ? a.status : "offline";
	return out;
}

// Serialized byte size of a peer-supplied response payload for the
// MAX_RESPONSE_BYTES cap. Unserializable values (e.g. circular refs) count
// as 0 — they can't be stringified into the caller's context anyway.
function responseSizeBytes(v: unknown): number {
	try {
		const s = typeof v === "string" ? v : JSON.stringify(v);
		return Buffer.byteLength(s ?? "", "utf8");
	} catch {
		return 0;
	}
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
					// Tear the socket down like the SSE error path does — without
					// cancel() an aborted-over-cap response body lingers until GC.
					try { await reader.cancel(); } catch { /* ignore */ }
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

// ━━ Registry / server-discovery I/O ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// isSafePathComponent (imported from ./coms-core.ts) rejects path
// traversal / separator injection in the project name (--project CLI flag or
// PI_COMS_NET_PROJECT env var).

function projectDir(project: string): string {
	if (!isSafePathComponent(project)) {
		throw new Error(`coms-net: invalid project name "${project}"`);
	}
	return path.join(COMS_NET_DIR, "projects", project);
}

// True when pid belongs to a live process we can signal. process.kill(pid, 0)
// performs no signal but still validates existence; EPERM means "exists but
// owned by someone else" — treat as live (we can't judge its state, and it's
// not ours to reap).
function pidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (err: any) {
		return err?.code === "EPERM";
	}
}

// Both server.json and server.secret.json carry trust (the bearer token, and
// the URL every request — including the token — is sent to). Apply the same
// group/other permission check to both: a world-writable server.json could
// redirect all traffic (token included) to an attacker host. Windows doesn't
// map st.mode onto Unix permission bits (it's always ~0o666/0o444 based on
// the read-only attribute), so this check is meaningless there — skip it and
// rely on the OS's own ACL-based file protection instead.
function isOwnerOnlyFile(p: string): boolean {
	if (process.platform === "win32") return true;
	try {
		const st = fs.statSync(p);
		// Reject if group or other has any access; owner-only read (0o400) or
		// read-write (0o600) are both fine — 0o400 is the more locked-down
		// choice for a secret file, not a reason to refuse it.
		return (st.mode & 0o077) === 0;
	} catch {
		return false;
	}
}

function readServerJson(project: string): ServerJson | null {
	// projectDir throws on an invalid project name — resolve inside the try so
	// the function returns null (its failure contract) instead of escaping.
	try {
		const p = path.join(projectDir(project), "server.json");
		if (!fs.existsSync(p)) return null;
		// Same trust check as the secret file: local_url redirects every request
		// (bearer token included) — see isOwnerOnlyFile.
		if (!isOwnerOnlyFile(p)) return null;
		const raw = fs.readFileSync(p, "utf-8");
		const parsed = JSON.parse(raw) as ServerJson;
		if (!parsed || typeof parsed.local_url !== "string") return null;
		// A stale server.json (server crashed without cleanup) costs a 10s
		// health-check hang on every session start. The writer records its pid;
		// if that's present and no such process is alive, skip the file fast.
		// A missing pid means an older server — trust it (health check decides).
		if (typeof parsed.pid === "number" && Number.isInteger(parsed.pid) && parsed.pid > 0 && !pidAlive(parsed.pid)) {
			return null;
		}
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
		if (!isOwnerOnlyFile(p)) return null;
		const raw = fs.readFileSync(p, "utf-8");
		const parsed = JSON.parse(raw) as ServerSecretJson;
		// Trim: a trailing newline in the token file (common when written with
		// an editor or echo) otherwise produces a 401 and a confusing terminal
		// shutdown.
		if (!parsed || typeof parsed.token !== "string") return null;
		const token = parsed.token.trim();
		if (token.length === 0) return null;
		return { token };
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
	// Drop userinfo/query/fragment: credentials must never ride along in the
	// stored URL (it is written to the audit log verbatim), and query/fragment
	// are meaningless on an API base URL. url.toString() then yields a
	// canonical credential-free form.
	url.username = "";
	url.password = "";
	url.search = "";
	url.hash = "";
	return url.toString().replace(/\/+$/, "");
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
	// coms.ts registers several of the same flag names (purpose/project/color/
	// explicit); when both extensions are co-loaded the second registration
	// throws a duplicate-flag error. Swallow only that shape for the flag names
	// this file registers — the flag then already exists with an equivalent
	// definition, and getFlag reads the same value.
	// Verified against the installed pi-coding-agent 0.55.0: its registerFlag
	// (dist/core/extensions/loader.js) never throws — cross-extension duplicates
	// are reported as load diagnostics (`Flag "--<name>" conflicts with <path>`,
	// dist/core/resource-loader.js), not exceptions. No "already registered"
	// text exists in the installed package, so the swallow condition is the
	// loose /already|duplicate/i matcher scoped to the known co-loaded flag
	// names below — defensive against pi builds whose registerFlag does throw.
	// Any other registration error is real and must still throw.
	const KNOWN_COMS_FLAGS = new Set(["cname", "purpose", "project", "color", "explicit", "server-url", "auth-token"]);
	function registerFlagOnce(name: string, def: any): void {
		try {
			pi.registerFlag(name, def);
		} catch (err: any) {
			// Scoped to known co-loaded flag names — stricter than coms.ts's
			// blanket swallow (see coms-core.isDuplicateRegistration, which
			// supplies the shared /already|duplicate/i predicate).
			if (KNOWN_COMS_FLAGS.has(name) && isDuplicateRegistration(err)) return;
			throw err;
		}
	}
	registerFlagOnce("cname", {
		description: "Override coms-net agent name (otherwise from frontmatter or auto-generated). Distinct from pi's own --name, which the harness owns and resumes.",
		type: "string",
		default: undefined,
	});
	registerFlagOnce("purpose", {
		description: "Override agent purpose (otherwise from frontmatter description)",
		type: "string",
		default: undefined,
	});
	registerFlagOnce("project", {
		description: "Project namespace for the coms-net hub",
		type: "string",
		default: "default",
	});
	registerFlagOnce("color", {
		description: "Hex color #RRGGBB (otherwise from frontmatter or palette fallback)",
		type: "string",
		default: undefined,
	});
	registerFlagOnce("explicit", {
		description: "Hide this agent from auto-discovery; only addressable by exact name",
		type: "boolean",
		default: false,
	});
	registerFlagOnce("server-url", {
		description: "coms-net server base URL (overrides env and local server.json)",
		type: "string",
		default: undefined,
	});
	registerFlagOnce("auth-token", {
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
	// `response` SSE events that arrived before coms_net_send parked its
	// pending entry (the server can deliver the reply between queuing the
	// prompt and our POST returning). Buffered here and drained when the
	// pending entry is created; expired on insert so a flood of replies for
	// msg_ids we never sent can't pin memory.
	const earlyResponses = new Map<string, { result: { response?: unknown; error?: string | null }; expires: number }>();
	const EARLY_RESPONSE_TTL_MS = 300_000;
	const MAX_EARLY_RESPONSES = 256;
	const inboundQueue: Map<string, InboundContext> = new Map();
	// FIFO of msg_ids injected this session with triggerTurn: true. agent_end
	// answers the OLDEST still-pending one, never the newest branch entry —
	// otherwise a second inbound arriving mid-turn steals the first's reply.
	const turnQueue: string[] = [];
	// msg_id → expiry ts for inbounds already answered. Redelivery of the same
	// msg_id after an SSE reconnect must not re-inject a fulfilled prompt; the
	// inboundQueue-only dedupe window closed at agent_end. Entries outlive
	// session resets deliberately (reconnects straddle them) and expire by TTL.
	const fulfilledMsgIds = new Map<string, number>();
	// Server redelivery contract (documented in the architecture decision
	// artifact): the server must not redeliver a message past this TTL, or must
	// carry a delivery epoch the client can check — a redelivery after expiry
	// is indistinguishable from a fresh prompt with a reused msg_id and would
	// inject a duplicate turn.
	const FULFILLED_TTL_MS = 3_600_000;
	// One retry timer per failed response POST (see agent_end). Tracked so
	// cleanShutdown can cancel them instead of letting a retry fire into a
	// torn-down session.
	const responseRetryTimers = new Map<string, NodeJS.Timeout>();
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
	// Latch so a slow heartbeat POST can't stack up overlapping requests when
	// the tick interval is shorter than the server's response time.
	let heartbeatInFlight = false;
	// Latch so a manual `/coms-net --reconnect` racing the scheduled backoff
	// timer can't run two reRegisterAndOpen calls concurrently (double
	// register + double SSE open).
	let reconnectInFlight = false;
	// Latch so two back-to-back session_start events (session switch + /new,
	// or print/json mode where session_shutdown may never have fired — pi-mono
	// #2576) can't both pass the identity/timer checks and double-register
	// flags, SSE, and heartbeats (mirrors coms.ts).
	let initializing = false;
	// Incremented on every session_start and cleanShutdown. An in-flight
	// reRegisterAndOpen captures it before awaiting and discards its result
	// when the generation moved on underneath it (stale reconnect).
	let sessionGeneration = 0;
	// Effective heartbeat cadence — the server may tune it via
	// RegisterResponse.heartbeat_interval_ms; defaults to HEARTBEAT_MS.
	let heartbeatIntervalMs = HEARTBEAT_MS;
	// Residual-gap latch (see handleInboundResponse): response authenticity is
	// delegated to the server contract — audit once per session so the
	// delegation is on record without logging on every reply.
	let responseAuthGapAudited = false;

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
		const timer = setTimeout(onAbort, timeoutMs);
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
		// Redaction below 8 chars would mangle unrelated text (a 1-char token
		// would redact every occurrence of that character) — and such a token is
		// brute-forceable anyway, so the leak it prevents is negligible.
		if (!authToken || authToken.length < 8) return msg;
		// Defense in depth: never leak the bearer.
		return msg.split(authToken).join("<redacted>");
	}

	// ━━ SSE parser (hand-rolled, no dep) ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

	function makeSseParser(onEvent: (event: string, data: unknown, id?: string) => void) {
		const decoder = new TextDecoder("utf-8");
		let buf = "";
		// buf.length counts UTF-16 code units, not bytes — track the buffered
		// UTF-8 byte length incrementally so the cap check below stays O(1)
		// per feed instead of re-measuring the whole tail (O(N^2) on a
		// newline-starved stream, exactly the case the cap guards).
		let bufBytes = 0;
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
				let data: unknown = joined;
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
				if (bufBytes + chunk.length > SSE_BUF_CAP_BYTES) {
					throw new Error("coms-net: SSE buffer exceeded cap — dropping connection");
				}
				buf += decoder.decode(chunk, { stream: true });
				bufBytes += chunk.length;
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
				if (start > 0) {
					// One bounded measurement of the consumed prefix instead of
					// re-measuring the whole tail on every feed.
					bufBytes -= Buffer.byteLength(buf.slice(0, start), "utf8");
					buf = buf.slice(start);
				}
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
					bufBytes = 0;
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
		// includeExplicit/displayProject change what renderPool shows without
		// changing any card — fold them in or toggling `/coms-net --all` /
		// `--project` against an unchanged pool diffs to a no-op render.
		return `${includeExplicit ? 1 : 0}|${displayProject ?? ""}\n${arr.join("\n")}`;
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

	function handleSseEvent(event: string, data: unknown, _id?: string): void {
		// Everything below reads `data.x` as `unknown` — the hub is untrusted,
		// so each field needs its own check before use.
		if (!isWireRecord(data)) return;
		switch (event) {
			case "hello": {
				audit("sse_hello", { server_id: data.server_id, server_time: data.server_time });
				return;
			}
			case "pool_snapshot": {
				// Validate BEFORE mutating: a malformed snapshot (non-array
				// `agents`) used to clear the pool and then iterate nothing, so
				// one bad frame from the hub wiped every known peer.
				if (!Array.isArray(data.agents)) return;
				peerCards.clear();
				const agents: unknown[] = data.agents;
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
				const a = data.agent;
				if (!isWireRecord(a) || typeof a.session_id !== "string") return;
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
				const sid = typeof data.session_id === "string" ? data.session_id : "";
				if (!sid) return;
				const prev = peerCards.get(sid);
				if (prev) {
					peerCards.set(sid, { ...prev, status: "stale" });
					maybeRequestRender();
				}
				return;
			}
			case "agent_left": {
				const sid = typeof data.session_id === "string" ? data.session_id : "";
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
				// Informational status transition for one of our outbound
				// messages — surface it in the audit log so delivery problems
				// are traceable; no state to update client-side.
				audit("message_status", { msg_id: data.msg_id, status: data.status });
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
	// The injected inbound prompt entry anchors the turn it triggered. pi
	// 0.55.0 stores extension-injected messages as custom_message entries with
	// details at entry level (session-manager appendCustomMessageEntry); plain
	// message entries carry details on entry.message. Match both shapes.
	function anchorMsgIdOf(entry: any): string | undefined {
		if (!entry) return undefined;
		if (entry.type === "custom_message") return (entry as any).details?.msg_id;
		if (entry.type === "message" && entry.message) return (entry.message as any).details?.msg_id;
		return undefined;
	}

	function activeInbound(ctx?: ExtensionContext | null): InboundContext | null {
		const c = ctx ?? currentCtx;
		if (!c) return null;
		const branch = c.sessionManager?.getBranch() ?? [];
		for (let i = branch.length - 1; i >= 0; i--) {
			const msgId = anchorMsgIdOf(branch[i]);
			if (msgId) {
				const inbound = inboundQueue.get(msgId);
				if (inbound && !inbound.fulfilled) return inbound;
			}
		}
		return null;
	}

	function handleInboundPrompt(data: WireRecord): void {
		const msg_id: unknown = data.msg_id;
		// The server controls msg_id and it keys maps, anchors branch entries,
		// and is interpolated raw into the injected prompt — validate charset
		// and length (ULID shape) instead of trusting it. Case-insensitive:
		// ULIDs are case-insensitive per spec and the server (not in this repo)
		// may emit lowercase — a strict uppercase match would silently drop
		// every inbound prompt.
		if (typeof msg_id !== "string" || !/^[0-9A-HJKMNP-TV-Z]{26}$/i.test(msg_id)) {
			audit("prompt_malformed", { reason: "bad_msg_id" });
			return;
		}
		// Redelivery after an SSE reconnect must not inject the same prompt
		// twice into the session — including prompts already answered, whose
		// inboundQueue entry was removed at agent_end (tombstone window).
		if (inboundQueue.has(msg_id) || fulfilledMsgIds.has(msg_id)) {
			audit("prompt_in_duplicate", { msg_id });
			return;
		}
		// A non-string prompt would inject an empty/garbage turn with
		// triggerTurn — reject it outright instead of coercing to "".
		if (typeof data.prompt !== "string") {
			audit("prompt_malformed", { msg_id });
			return;
		}
		const promptText = data.prompt;
		// Bound injected context: the 16 MiB SSE cap is the only other limit,
		// and a single prompt that large blows out the agent's context window
		// (and real token cost) from a buggy/hostile peer.
		const promptBytes = Buffer.byteLength(promptText, "utf8");
		if (promptBytes > MAX_PROMPT_BYTES) {
			audit("prompt_too_large", { msg_id, bytes: promptBytes });
			return;
		}
		// `sender` is a nested wire object: narrow it before reading fields
		// (sanitizePeerText already takes `unknown` and falls back safely).
		const sender: WireRecord = isWireRecord(data.sender) ? data.sender : {};
		const senderName = sanitizePeerText(sender.name, "unknown");
		const senderCwd = sanitizePeerText(sender.cwd, "?");
		const senderSession = sanitizePeerText(sender.session_id, "?");
		// Clamp hops at the trust boundary: a negative value from a peer would
		// keep `hops + 1 >= MAX_HOPS` permanently false in coms_net_send and
		// bypass the runaway-chain stop entirely.
		const hops = typeof data.hops === "number" && Number.isFinite(data.hops)
			? Math.max(0, Math.min(Math.floor(data.hops), MAX_HOPS))
			: 0;
		// Match the sender-side rule in coms_net_send: schemas must be plain
		// JSON objects — arrays would cross the wire here but be rejected at
		// send time, an asymmetric contract. Also cap the serialized size at
		// the trust boundary: the schema rides inside the injected prompt's
		// details, so an unbounded one lands up to the 16 MiB SSE cap of JSON
		// into the session context.
		let responseSchema: object | null = null;
		if (data.response_schema && typeof data.response_schema === "object" && !Array.isArray(data.response_schema)) {
			let schemaJson: string | null = null;
			try { schemaJson = JSON.stringify(data.response_schema); } catch { /* unserializable */ }
			if (schemaJson === null || schemaJson.length > MAX_RESPONSE_SCHEMA_BYTES) {
				audit("prompt_schema_too_large", { msg_id });
				return;
			}
			responseSchema = data.response_schema;
		}
		const conversationId = typeof data.conversation_id === "string" ? data.conversation_id : null;

		// Queue cap: inboundQueue entries are only removed at agent_end (or by
		// the heartbeat sweep at MESSAGE_TIMEOUT_MS + 60s), so a prompt flood
		// must not grow the queue unbounded for ~31 min (mirrors coms.ts).
		if (inboundQueue.size >= MAX_INBOUND) {
			audit("prompt_queue_full", { msg_id, size: inboundQueue.size });
			// The sender's POST already succeeded and its coms_net_await is
			// parked on a response — a silent drop here would leave it waiting
			// out the full MESSAGE_TIMEOUT_MS. Nack definitively (mirrors
			// coms.ts): POST an error response through the same submit path
			// agent_end uses so the caller fails fast. Best-effort and
			// fire-and-forget — never throw inside the SSE handler.
			if (identity && serverUrl && authToken) {
				const nack: ResponseSubmitRequest = {
					project: identity.project,
					responder_session: identity.session_id,
					response: null,
					error: "queue full (receiver inbound queue at capacity)",
					conversation_id: conversationId,
				};
				httpFetch("POST", `/v1/messages/${encodeURIComponent(msg_id)}/response`, nack)
					.catch((err) => audit("prompt_queue_full_nack_failed", { msg_id, reason: safeError(err) }));
			} else {
				// Not registered — no local path back to the server; the loud
				// audit above is all we can do.
				audit("prompt_queue_full_nack_skipped", { msg_id, reason: "not_registered" });
			}
			return;
		}

		const inbound: InboundContext = {
			msg_id,
			hops,
			sender_session: senderSession,
			sender_name: senderName,
			sender_cwd: senderCwd,
			response_schema: responseSchema,
			conversation_id: conversationId,
			fulfilled: false,
			dispatching: false,
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
			// FIFO turn attribution: agent_end answers the oldest queued inbound.
			turnQueue.push(msg_id);
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

	// Tombstone a fulfilled msg_id so a redelivered copy is dropped by
	// handleInboundPrompt. Prune expired entries on insert once the map grows
	// past MAX_FULFILLED_TOMBSTONES so a prompt flood can't pin memory.
	function tombstoneFulfilled(msgId: string): void {
		fulfilledMsgIds.set(msgId, Date.now() + FULFILLED_TTL_MS);
		if (fulfilledMsgIds.size > MAX_FULFILLED_TOMBSTONES) {
			const now = Date.now();
			for (const [mid, exp] of fulfilledMsgIds.entries()) {
				if (exp <= now) fulfilledMsgIds.delete(mid);
			}
			// A distinct-id flood within the TTL leaves nothing expired — evict
			// oldest (Map is insertion-ordered) so the bound is real. An evicted
			// tombstone admits at most one redelivery re-injection, which the
			// inboundQueue dedupe still covers.
			while (fulfilledMsgIds.size > MAX_FULFILLED_TOMBSTONES) {
				const oldest = fulfilledMsgIds.keys().next().value;
				if (oldest === undefined) break;
				fulfilledMsgIds.delete(oldest);
			}
		}
	}

	// Terminal transition for an inbound: mark fulfilled, drop it from the
	// queue and the FIFO turn attribution list, and tombstone the msg_id.
	function markInboundFulfilled(inbound: InboundContext): void {
		inbound.fulfilled = true;
		inboundQueue.delete(inbound.msg_id);
		const qi = turnQueue.indexOf(inbound.msg_id);
		if (qi >= 0) turnQueue.splice(qi, 1);
		tombstoneFulfilled(inbound.msg_id);
	}

	// Context usage can be NaN (e.g. 0/0 before any tokens are counted);
	// clamp non-finite values to 0 so agent cards never carry NaN/Infinity,
	// which would later crash widget rendering ("#".repeat(NaN) → RangeError).
	function safeContextPct(ctx: ExtensionContext | null | undefined): number {
		// pi 0.55: percent is `number | null` (null right after compaction);
		// the typeof check below already maps null/undefined/NaN to 0.
		const p = ctx?.getContextUsage?.()?.percent;
		return typeof p === "number" && Number.isFinite(p) ? Math.round(p) : 0;
	}

	function handleInboundResponse(data: WireRecord): void {
		// Same ULID gate as the prompt path: an unvalidated server/peer-controlled
		// id would key the map lookups as garbage, churn the earlyResponses
		// buffer, and land raw in the audit log.
		const msg_id: unknown = data.msg_id;
		if (typeof msg_id !== "string" || !/^[0-9A-HJKMNP-TV-Z]{26}$/i.test(msg_id)) {
			// Settle — don't silently strand — any pending entry keyed by a
			// non-ULID id (registered before the send-side format check below
			// existed, or by an older build): dropping the response here would
			// otherwise leave its coms_net_await hanging until the full
			// MESSAGE_TIMEOUT_MS.
			let settled = false;
			if (typeof msg_id === "string") {
				const stranded = pendingReplies.get(msg_id);
				if (stranded && !stranded.result) {
					stranded.result = { response: null, error: "malformed server reply (bad msg_id format)" };
					try { stranded.resolve(stranded.result); } catch { /* ignore */ }
					settled = true;
				}
			}
			audit("response_malformed", { reason: "bad_msg_id", settled });
			return;
		}
		// Residual authentication gap: unlike coms.ts, this response path has no
		// per-message secret echo + timing-safe verify (coms.ts secretEqual /
		// forged_response). The scheme is not safely implementable here: the hub
		// server is external/unshipped and its contract (the canonical type
		// block above, mirrored on the server) round-trips only known fields
		// (conversation_id, response_schema) — whether it would preserve an
		// unknown secret field through send → prompt event → response submit →
		// response event is unverifiable from this repo, and hard-failing on a
		// stripped field would reject every legitimate reply. Response
		// authenticity is therefore delegated to the server contract (like the
		// redelivery contract at FULFILLED_TTL_MS): the hub must accept
		// /v1/messages/{id}/response only from the session the prompt was
		// delivered to. Audited once per session so the delegation is on
		// record; response_in still logs each accepted reply.
		if (!responseAuthGapAudited) {
			responseAuthGapAudited = true;
			audit("response_auth_delegated", { msg_id });
		}
		const responseVal = data.response;
		const errVal: string | null = typeof data.error === "string" ? data.error : null;
		// Mirror the long-poll guard in coms_net_await: "complete" with no
		// response and no error is a malformed reply, not a blank success. And
		// cap the reply at the trust boundary (MAX_RESPONSE_BYTES): the only
		// other bound is the 16 MiB SSE cap, and the payload lands verbatim in
		// the caller's coms_net_get/await tool output.
		let result: { response: unknown; error: string | null };
		if (responseVal === undefined && errVal === null) {
			result = { response: null, error: "malformed server reply" };
		} else if (
			responseSizeBytes(responseVal) > MAX_RESPONSE_BYTES ||
			(errVal !== null && responseSizeBytes(errVal) > MAX_RESPONSE_BYTES)
		) {
			// Cap whichever terminal value will be surfaced. The error string
			// is peer-supplied and bounded only by the 16 MiB SSE cap — without
			// this branch a hostile/buggy hub could interpolate a multi-MiB
			// error verbatim into the caller's tool output. (responseSizeBytes
			// returns 0 for undefined, so the responseVal term is safe when
			// only an error is present.)
			audit("response_too_large", { msg_id });
			result = { response: null, error: "response too large" };
		} else {
			result = { response: responseVal, error: errVal };
		}
		const pending = pendingReplies.get(msg_id);
		if (pending) {
			pending.result = result;
			try { pending.resolve(pending.result); } catch { /* ignore */ }
			try {
				pi.appendEntry("coms-net-log", {
					event: "response_in",
					ts: nowIso(),
					msg_id,
					error: result.error,
				});
			} catch { /* best-effort */ }
		} else {
			// The reply can outrun coms_net_send's POST return (server delivers
			// over SSE before our fetch resolves): buffer it and drain into the
			// pending entry when it's created, or the caller waits the full
			// timeout for a reply we already held.
			if (earlyResponses.size >= MAX_EARLY_RESPONSES) {
				const now = Date.now();
				for (const [mid, e] of earlyResponses.entries()) {
					if (e.expires <= now) earlyResponses.delete(mid);
				}
				// Distinct-id flood within the TTL: evict oldest (insertion
				// order) so the bound is real.
				while (earlyResponses.size >= MAX_EARLY_RESPONSES) {
					const oldest = earlyResponses.keys().next().value;
					if (oldest === undefined) break;
					earlyResponses.delete(oldest);
				}
			}
			earlyResponses.set(msg_id, {
				result,
				expires: Date.now() + EARLY_RESPONSE_TTL_MS,
			});
			audit("orphan_response", { msg_id, buffered: true });
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
				// Drain/cancel the body or the socket lingers until GC on every
				// non-OK response — a flapping server would accumulate half-open
				// connections across the reconnect loop (mirrors the SSE
				// read-loop teardown and readBodyCapped's over-cap cancel).
				try { await resp.body?.cancel(); } catch { /* ignore */ }
				// A newer attempt (manual --reconnect) or cleanShutdown can abort
				// `ac` and reassign `sseAbort` during the cancel await above. If
				// that happened this attempt no longer owns the connection, and
				// processing the status below would race the current owner: a
				// stale scheduleReconnect() pins a timer that can survive the
				// superseder's success, and a stale cleanShutdown() (401/403/404)
				// would tear down even as the superseder reconnects. Bail and let
				// the owner drive. (Mirrors the fetch-reject supersede check
				// above and the stream-end `ac === sseAbort` guard further down.)
				if (ac !== sseAbort) {
					audit("sse_connect_aborted");
					return;
				}
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
			// Half-open watchdog: a silently-dead server leaves reader.read()
			// hanging forever while heartbeats keep us "online" — we'd never
			// receive a prompt again. Abort if no chunk arrives within
			// SSE_WATCHDOG_FACTOR × the heartbeat interval (server pings must
			// arrive at least once per interval; see the constant's comment).
			const watchdogMs = SSE_WATCHDOG_FACTOR * heartbeatIntervalMs;
			let watchdogTimer: NodeJS.Timeout | null = null;
			// Distinguish a watchdog abort from an intentional one (manual
			// reconnect superseding this attempt, or shutdown): both set
			// ac.signal.aborted with handshakeTimedOut === false, but the
			// watchdog must fall through to scheduleReconnect() below —
			// treating it as intentional would kill inbound delivery
			// permanently on the first half-open connection.
			let watchdogFired = false;
			const armWatchdog = () => {
				if (watchdogTimer) { try { clearTimeout(watchdogTimer); } catch { /* ignore */ } }
				watchdogTimer = setTimeout(() => { watchdogFired = true; try { ac.abort(); } catch { /* ignore */ } }, watchdogMs);
				try { (watchdogTimer as any).unref?.(); } catch { /* ignore */ }
			};
			const disarmWatchdog = () => {
				if (watchdogTimer) { try { clearTimeout(watchdogTimer); } catch { /* ignore */ } watchdogTimer = null; }
			};
			// Distinguish the parser's buffer-cap throw from a transient error:
			// an oversize stream will re-trip the cap on every reconnect —
			// looping scheduleReconnect forever at the backoff ceiling.
			let capExceeded = false;
			try {
				armWatchdog();
				while (true) {
					const { done, value } = await reader.read();
					if (done) break;
					if (value) {
						try {
							parser.feed(value);
						} catch (err: any) {
							capExceeded = err instanceof Error && err.message.includes("SSE buffer exceeded cap");
							throw err;
						}
					}
					armWatchdog();
				}
				// Stream ended — flush any event the server sent without a
				// trailing blank line so it isn't dropped.
				try { parser.end(); } catch { /* best-effort */ }
				audit("sse_disconnect", { reason: "stream_end" });
			} catch (err: any) {
				if (ac.signal.aborted && !handshakeTimedOut && !watchdogFired) {
					audit("sse_disconnect", { reason: "aborted" });
					return;
				}
				// A handshake-timeout or watchdog abort must fall through to
				// the scheduleReconnect() below — treating either as an
				// intentional abort (like the fetch-rejection path above used
				// to) kills the reconnect loop: the handshake case on a single
				// transient stall, the watchdog case on every half-open
				// connection (the exact failure the watchdog exists to recover
				// from).
				audit("sse_disconnect", { reason: watchdogFired ? "watchdog_timeout" : handshakeTimedOut ? "handshake_timeout" : safeError(err) });
			} finally {
				disarmWatchdog();
				// releaseLock() alone does not close the underlying source: on an
				// errored body stream (network failure) the socket would linger
				// until GC. cancel() explicitly tears it down. After `done` or an
				// abort this is a no-op/rejection — both swallowed by the try.
				try { await reader.cancel(); } catch { /* ignore */ }
				try { reader.releaseLock(); } catch { /* ignore */ }
			}
			if (capExceeded) {
				// Terminal, like a 401: the same oversize stream will trip the
				// cap on every reconnect, so don't loop forever. Without
				// cleanShutdown the heartbeat would keep us "online" and
				// routable while inbound delivery is dead.
				audit("sse_cap_exceeded_terminal");
				if (currentCtx?.hasUI) {
					try { currentCtx.ui.notify("📡 coms-net: SSE stream exceeded buffer cap — not retrying", "error"); } catch { /* ignore */ }
				}
				void cleanShutdown();
				return;
			}
			// A superseded attempt must not schedule a reconnect: a manual
			// /coms-net --reconnect (or shutdown) created a newer controller
			// and owns the follow-up. This guards the one path the catch-block
			// `ac.signal.aborted` check cannot reach — a stream that ended
			// normally (loop broke on `done`, no throw → no catch) and was then
			// superseded during the finally's `await reader.cancel()`. The
			// newer attempt reassigns `sseAbort` (and aborts `ac` on its way
			// in, line ~1468), so `ac === sseAbort` is false here exactly when
			// this attempt no longer owns the connection. (The catch block
			// needs no separate `ac !== sseAbort` guard: every reassignment
			// site aborts the prior controller first, so there `ac.signal
			// .aborted` is already true and the early-return above fires.)
			if (!shuttingDown && ac === sseAbort) {
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
			// A manual /coms-net --reconnect may already be mid-flight — don't
			// stack a second register + SSE-open; the in-flight one owns the
			// outcome (and schedules its own follow-up on failure).
			if (reconnectInFlight) return;
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
					// Without this the heartbeat keeps POSTing status "online" and
					// the hub shows the agent routable while its SSE is dead.
					// (Mirrors the terminal-status handling in openSse.)
					void cleanShutdown();
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
				.then((data: unknown) => {
					if (!isWireRecord(data)) return;
					if (data.status !== "complete" && data.status !== "error" && data.status !== "timeout") return;
					if (entry.result) return; // resolved via SSE while this poll was in flight
					const errVal = data.status === "timeout"
						? "timeout"
						: typeof data.error === "string" ? data.error
							: data.status === "error" ? "error" : null;
					// Mirror the long-poll guard: "complete" with no response and
					// no error is a malformed reply, not a blank success. And cap
					// the reply like the SSE path (MAX_RESPONSE_BYTES): this GET
					// body is bounded only by HTTP_BODY_CAP_BYTES (16 MiB) and the
					// payload lands verbatim in the caller's tool output.
					const malformed = data.status === "complete" && data.response === undefined && errVal === null;
					// Cap whichever terminal value surfaces (mirrors the SSE
					// path): the response on a "complete" status, AND a peer-
					// supplied error string on any status — both are bounded
					// only by the 16 MiB HTTP body cap.
					const tooLarge = !malformed && (
						(errVal === null && data.status === "complete"
							&& responseSizeBytes(data.response) > MAX_RESPONSE_BYTES) ||
						(errVal !== null && responseSizeBytes(errVal) > MAX_RESPONSE_BYTES)
					);
					if (tooLarge) audit("response_too_large", { msg_id: mid });
					entry.result = malformed
						? { response: null, error: "malformed server reply" }
						: tooLarge
							? { response: null, error: "response too large" }
							: { response: data.response ?? null, error: errVal };
					try { entry.resolve(entry.result); } catch { /* ignore */ }
					audit("response_resynced", { msg_id: mid, status: data.status });
				})
				.catch(() => { /* best-effort resync; the prune sweep is the backstop */ });
		}
	}

	async function reRegisterAndOpen(): Promise<void> {
		if (!identity || shuttingDown) return;
		if (reconnectInFlight) return;
		reconnectInFlight = true;
		try {
			// Defensive: cleanShutdown keeps serverUrl/authToken — they survive
			// it for --reconnect recovery (see the /coms-net --reconnect
			// handler), and the paths that DO null them (session_start, boot
			// failure) also leave identity null, so the early return above
			// already covered them. If URL/token are ever missing here anyway,
			// re-run boot's resolution or httpFetch throws "no server URL"/"no
			// auth token" forever and the heartbeat stays dead even after a
			// successful re-register.
			if (!serverUrl) serverUrl = resolveServerUrl(identity.project, readCliFlags(pi).serverUrl);
			if (!authToken) authToken = resolveAuthToken(identity.project, readCliFlags(pi).authToken);
			if (!serverUrl || !authToken) {
				throw new Error("coms-net: cannot reconnect — no server URL or auth token resolvable");
			}
			// Capture the session generation before awaiting: a session_start/cleanShutdown
			// racing this call bumps it, making any result we resolve afterwards stale.
			const gen = sessionGeneration;
			// Re-register (server upserts), then re-open SSE.
			const reg = await registerAgent();
			if (shuttingDown || gen !== sessionGeneration) {
				// Shutdown (or a session reset) raced our in-flight registration:
				// cleanShutdown() already sent its DELETE while this POST was on the
				// wire, so the register that just resolved re-created the record
				// after it was removed — an orphaned registration for a dead client.
				// Undo it best-effort and discard the result without opening SSE.
				// (Returning early without the DELETE — as a naive shuttingDown check
				// would — stops openSse() but leaves the orphan on the server.)
				audit("reconnect_registration_orphaned", { attempt: reconnectAttempts });
				await unregisterAgentBestEffort(HTTP_TIMEOUT_MS);
				return;
			}
			sseUrlPath = reg.sse_url;
			// Honor the server-advertised heartbeat cadence on every re-register —
			// it may have changed since session_start. Restart the interval so the
			// new cadence takes effect immediately (same sanity clamp as boot).
			const srvHb = reg.heartbeat_interval_ms;
			const newHb = typeof srvHb === "number" && Number.isFinite(srvHb) && srvHb >= 1_000
				? Math.min(srvHb, 300_000)
				: HEARTBEAT_MS;
			if (newHb !== heartbeatIntervalMs && heartbeatTimer) {
				heartbeatIntervalMs = newHb;
				try { clearInterval(heartbeatTimer); } catch { /* ignore */ }
				heartbeatTimer = setInterval(heartbeatTick, heartbeatIntervalMs);
				try { (heartbeatTimer as any).unref?.(); } catch { /* ignore */ }
			} else {
				heartbeatIntervalMs = newHb;
			}
			audit("sse_reconnect", { attempt: reconnectAttempts });
			resyncPendingReplies();
			// Fire and forget; openSse manages its own lifecycle.
			void openSse();
		} finally {
			reconnectInFlight = false;
		}
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
		// Server may auto-suffix the name on collision. It is still
		// server-controlled text rendered into the TUI (status line, widget
		// border) — sanitize like any peer-controlled string; a non-string
		// keeps the current name instead of propagating into target
		// comparisons and audit entries.
		const assigned = sanitizePeerText(resp.agent.name, identity.name);
		if (assigned !== identity.name) {
			try {
				pi.appendEntry("coms-net-log", {
					event: "name_collision",
					ts: nowIso(),
					desired: identity.name,
					assigned,
					project: identity.project,
				});
			} catch { /* best-effort */ }
			identity.name = assigned;
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

	// ━━ Heartbeat tick (extracted so re-register can restart the interval) ━━

	// The tick runs under setInterval: a synchronous throw (e.g. a host API
	// like sessionManager.getBranch() mid-teardown after a session switch)
	// would escape the interval callback as an uncaughtException and crash the
	// agent process, so the whole body is guarded and audited.
	function heartbeatTick(): void {
		try {
			heartbeatTickBody();
		} catch (err) {
			audit("heartbeat_tick_error", { reason: safeError(err) });
		}
	}

	function heartbeatTickBody(): void {
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
		// Skip the POST while a previous heartbeat is still unsettled — the
		// interval can be shorter than a stalled server's response time, and
		// overlapping heartbeats would stack unbounded in-flight requests.
		if (heartbeatInFlight) {
			audit("heartbeat_skipped_busy");
		} else {
			heartbeatInFlight = true;
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
				})
				.finally(() => { heartbeatInFlight = false; });
		}

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
		// under a prompt flood. Entries still anchored in the current branch
		// are exempt: their turn may legitimately run longer than the
		// MESSAGE_TIMEOUT_MS window (agent_end hasn't fired yet) — pruning one
		// mid-turn would make agent_end find nothing and leave the caller
		// waiting out its full timeout. An unanchored entry (compacted/forked
		// anchor) can't be mid-turn, so age applies. created_at is refreshed
		// at agent_end, so a fulfilled-on-failure retry never outlives this
		// window by more than one turn.
		// The anchored exemption is capped at 2× the window: a turn that never
		// reaches agent_end (wedged model, session torn down without a shutdown
		// event) would otherwise pin its entry — and one of the MAX_INBOUND
		// slots — forever. 2× rather than 1× so a turn still legitimately
		// running past one window (created_at only refreshes at agent_end /
		// retry) isn't pruned out from under itself.
		const branchNow = currentCtx?.sessionManager?.getBranch() ?? [];
		const anchoredMsgIds = new Set<string>();
		for (const e of branchNow) {
			const mid = anchorMsgIdOf(e);
			if (typeof mid === "string") anchoredMsgIds.add(mid);
		}
		const PRUNE_WINDOW_MS = MESSAGE_TIMEOUT_MS + 60_000;
		for (const [mid, ctx] of inboundQueue.entries()) {
			const age = now - ctx.created_at;
			if (anchoredMsgIds.has(mid) && age <= 2 * PRUNE_WINDOW_MS) continue;
			if (age > PRUNE_WINDOW_MS) {
				inboundQueue.delete(mid);
				const qi = turnQueue.indexOf(mid);
				if (qi >= 0) turnQueue.splice(qi, 1);
				// Tombstone so a redelivery after an SSE reconnect can't
				// re-inject this stale prompt as a fresh turn — the dedupe
				// gate checks fulfilledMsgIds as well as inboundQueue.
				tombstoneFulfilled(mid);
			}
		}
		// Expire buffered early responses (see earlyResponses) so a burst of
		// orphan replies doesn't linger its full TTL when no new ones arrive.
		for (const [mid, e] of earlyResponses.entries()) {
			if (e.expires <= now) earlyResponses.delete(mid);
		}
	}

	// ━━ session_start ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

	async function onSessionStart(_event: unknown, ctx: ExtensionContext) {
		// session_start can fire again on this same extension instance — session
		// switch, /new, or print/json mode where session_shutdown may never have
		// fired (pi-mono #2576). Tear down any live prior session and reset all
		// per-session state, or the shuttingDown latch stays set and silently
		// disables the extension, and stale identity/maps/timers leak across.
		if (!shuttingDown && (identity || sseAbort || heartbeatTimer || reconnectTimer)) {
			await cleanShutdown();
		}
		shuttingDown = false;
		// Re-arm the once-per-session residual-gap audit (see
		// handleInboundResponse) for the new session.
		responseAuthGapAudited = false;
		// Invalidate any reRegisterAndOpen still awaiting from the prior session.
		sessionGeneration++;
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
		earlyResponses.clear();
		inboundQueue.clear();
		turnQueue.length = 0;
		for (const t of responseRetryTimers.values()) {
			try { clearTimeout(t); } catch { /* ignore */ }
		}
		responseRetryTimers.clear();
		// Dispatches left by a dead session are useless — their registration
		// was deleted by cleanShutdown — and would otherwise accumulate across
		// resets, each costing one blocking spawnSync at process exit.
		pendingExitDispatches.length = 0;
		sseAbort = null;
		heartbeatTimer = null;
		reconnectTimer = null;
		reconnectAttempts = 0;
		notifiedReconnectCap = false;
		lastWidgetSnapshot = "";
		heartbeatIntervalMs = HEARTBEAT_MS;
		heartbeatInFlight = false;

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
		// The name lands in server cards, the widget border and status line —
		// strip control chars and cap length like any other rendered string,
		// falling back to the default if sanitizing empties it.
		const desiredName = sanitizePeerText(flags.name || fm.name || defaultName, defaultName, 32) || defaultName;
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
				identity = null;
				return;
			}
			ctx.ui?.notify?.(
				`📡 coms-net: no server URL for project "${project}". Start your coms-net hub server (external — not shipped in this branch; see _bmad-output/sprint-artifacts/_research/oq-1-coms-arch-decision.md)`,
				"error",
			);
			audit("boot_failed", { reason: "no_server_url", project });
			identity = null;
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
			identity = null;
			return;
		}

		// 4. Health check — verify reachability over the authenticated channel
		// (httpFetch attaches the bearer to every request, /health included).
		try {
			await httpFetch("GET", "/health");
		} catch (err) {
			ctx.ui?.notify?.(
				`📡 coms-net: server unreachable at ${serverUrl} — ${safeError(err)}. Start your coms-net hub server (external — not shipped in this branch; see _bmad-output/sprint-artifacts/_research/oq-1-coms-arch-decision.md)`,
				"error",
			);
			audit("boot_failed", { reason: "health_failed", error: safeError(err) });
			identity = null;
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
			identity = null;
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
		heartbeatTimer = setInterval(heartbeatTick, heartbeatIntervalMs);
		try { (heartbeatTimer as any).unref?.(); } catch { /* ignore */ }
	}

	// Registered through a wrapper that serializes concurrent session_start
	// events on the initializing latch (two back-to-back events would both
	// pass the identity/timer checks and double-register SSE/heartbeats —
	// mirrors coms.ts) and contains any throw (e.g. applyExtensionDefaults)
	// as an audit entry instead of an unhandled rejection leaving half-init
	// state. The latch always releases in finally, so a failed init can't
	// wedge later sessions.
	pi.on("session_start", (event, ctx) => {
		void (async () => {
			while (initializing) {
				await new Promise((resolve) => setTimeout(resolve, 25));
			}
			initializing = true;
			try {
				await onSessionStart(event, ctx);
			} catch (err) {
				audit("session_start_error", { reason: safeError(err) });
				try { ctx.ui?.notify?.(`📡 coms-net: session start failed — ${safeError(err)}`, "error"); } catch { /* ignore */ }
			} finally {
				initializing = false;
			}
		})();
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
			// Code points, not UTF-16 units — a non-BMP name would otherwise
			// overcount and misalign the border.
			const nameLen = identity ? Array.from(identity.name).length : 0;
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
			// The bar clamps to 0..15 but the label rendered the raw peer value
			// (150% is a valid hostile card value) — clamp the label to 0..100
			// so the two never disagree.
			const pctLabel = Number.isFinite(r.pct) ? `${Math.max(0, Math.min(100, Math.round(r.pct as number)))}%` : "--%";

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
			// Gate on the shutdown latch too: after a terminal-status
			// cleanShutdown the identity survives (for --reconnect recovery)
			// but the token is dead — fail fast instead of 401 round-trips.
			if (!identity || shuttingDown) {
				throw new Error("coms-net not initialised");
			}
			const projectFilter = params.project ?? identity.project;
			const includeExp = params.include_explicit === true;
			const qs = `?project=${encodeURIComponent(projectFilter)}&include_explicit=${includeExp ? "true" : "false"}`;
			let resp: any;
			try {
				resp = await httpFetch("GET", `/v1/agents${qs}`);
			} catch (err) {
				if (err instanceof HttpError) {
					// err.body is parsed hub JSON — `error` is any type and
					// this message reaches the terminal as tool-error text.
					const raw = err.body?.error;
					const detail = typeof raw === "string"
						? sanitizePeerText(raw, "", 256)
						: err.message;
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
					const ctxStr = Number.isFinite(a.context_used_pct) ? ` ${a.context_used_pct}%` : " ?%";
					return `${live} ${a.name} (${abbreviateModel(a.model)})${ctxStr}${a.purpose ? ` — ${a.purpose}` : ""}`;
				}).join("\n");

			return {
				content: [{ type: "text" as const, text: `${peers.length} peer(s):\n${lines}` }],
				details: { agents: peers, project: projectFilter },
			};
		},
		renderCall(args: WireRecord, theme) {
			// renderCall args are raw (possibly still-streaming) model output,
			// not the TypeBox-validated `params` execute() receives — hence
			// WireRecord, which makes the compiler demand sanitizePeerText.
			const proj = sanitizePeerText(args.project);
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
				const pct = Number.isFinite(a.context_used_pct) ? `${a.context_used_pct}%` : "?%";
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
			response_schema: Type.Optional(Type.Unknown({ description: "Optional JSON Schema describing the expected response shape." })),
		}),
		async execute(_callId, params) {
			// Gate on the shutdown latch too (see coms_net_list).
			if (!identity || shuttingDown) throw new Error("coms-net not initialised");

			// Enforce the same prompt cap the receiver applies in
			// handleInboundPrompt — otherwise the receiver silently drops the
			// prompt and this side's coms_net_await hangs to its full timeout.
			const promptBytes = Buffer.byteLength(params.prompt, "utf8");
			if (promptBytes > MAX_PROMPT_BYTES) {
				throw new Error(`coms-net: prompt too large (${promptBytes} bytes > ${MAX_PROMPT_BYTES})`);
			}

			// Derive hops from the same FIFO head agent_end answers — walking
			// the branch newest-first (activeInbound) would attribute this
			// send to a different inbound than the one the current turn is
			// actually replying to, and the two paths would disagree. The head
			// must still anchor this session's branch: a stale lost-anchor head
			// (compacted out, not yet swept at agent_end) is not being
			// answered by this turn and must not inflate hops.
			const headMid = turnQueue.length > 0 ? (turnQueue[0] as string) : undefined;
			const headCand = headMid ? inboundQueue.get(headMid) : null;
			const headAnchored = headMid
				? (currentCtx?.sessionManager?.getBranch() ?? []).some(e => anchorMsgIdOf(e) === headMid)
				: false;
			const hops = headCand && !headCand.fulfilled && headAnchored ? headCand.hops + 1 : 0;
			if (hops >= MAX_HOPS) {
				throw new Error(`coms-net: hop limit reached (${hops} >= ${MAX_HOPS})`);
			}

			const conversationId = typeof params.conversation_id === "string" ? params.conversation_id : null;
			// Validate with the same rule the receiver applies in
			// handleInboundPrompt: a string/number schema would otherwise cross
			// the wire and be silently dropped, masking a caller error in a
			// contract parameter. Fail loudly instead of coercing to null.
			const schemaParam = params.response_schema;
			if (schemaParam !== undefined && schemaParam !== null && (typeof schemaParam !== "object" || Array.isArray(schemaParam))) {
				throw new Error("coms-net: response_schema must be a JSON object");
			}
			const responseSchema = (schemaParam && typeof schemaParam === "object") ? schemaParam : null;

			// Sending to self would auto-answer its own prompt at agent_end —
			// a degenerate ping-pong loop. Refuse both name and session_id forms.
			if (params.target === identity.name || params.target === identity.session_id) {
				throw new Error("coms-net: cannot send to self");
			}

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
					// err.body is parsed hub JSON — `error` is any type and
					// this message reaches the terminal as tool-error text.
					const raw = err.body?.error;
					const detail = typeof raw === "string"
						? sanitizePeerText(raw, "", 256)
						: err.message;
					throw new Error(`coms-net: send failed (${err.status}): ${detail}`);
				}
				throw new Error(`coms-net: send failed: ${safeError(err)}`);
			}
			// Without a string msg_id the pending entry would key the map by
			// `undefined` and the SSE response could never match it.
			if (typeof resp?.msg_id !== "string" || !resp.msg_id) {
				throw new Error("coms-net: malformed send response (missing msg_id)");
			}
			// The response path hard-gates on ULID ids (handleInboundResponse,
			// same assumption as the prompt path): if the hub ever assigned any
			// other format, the pending entry registered below could never be
			// resolved by a response event and the caller would hang until
			// MESSAGE_TIMEOUT_MS — fail fast and loud on the contract mismatch.
			if (!/^[0-9A-HJKMNP-TV-Z]{26}$/i.test(resp.msg_id)) {
				throw new Error("coms-net: malformed send response (bad msg_id format)");
			}
			const { msg_id, target_session } = resp;

			// Park a pending entry that the SSE `response` event will resolve.
			let resolveFn!: (v: { response?: unknown; error?: string | null }) => void;
			const promise = new Promise<{ response?: unknown; error?: string | null }>((res) => {
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
			// A `response` SSE event can outrun this POST's return (the server
			// queues the prompt before our fetch resolves): drain any buffered
			// early reply now or the caller waits the full timeout for a reply
			// we already held.
			const early = earlyResponses.get(msg_id);
			if (early) {
				earlyResponses.delete(msg_id);
				const entry = pendingReplies.get(msg_id);
				if (entry && !entry.result) {
					entry.result = early.result;
					try { entry.resolve(entry.result); } catch { /* ignore */ }
				}
			}

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
		renderCall(args: WireRecord, theme) {
			// Tool args are model output, and peer prompt text is injected into
			// the session — a hostile peer prompt can steer the model into
			// passing ANSI escape sequences here. Sanitize like any
			// peer-controlled string before rendering into the TUI. Typed
			// WireRecord (not the validated `params` shape) so the compiler
			// refuses a raw read.
			const tgt = sanitizePeerText(args.target, "?");
			const prompt = sanitizePeerText(args.prompt);
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
		async execute(_callId, params): Promise<AgentToolResult<any>> {
			// Gate like send/list: after a terminal-status cleanShutdown the
			// identity survives but the token is dead — fail fast instead of
			// 401 round-trips (and pendingReplies was cleared anyway).
			if (!identity || shuttingDown) throw new Error("coms-net not initialised");
			const msg_id = params.msg_id;
			// Local SSE-resolved fast path.
			const pending = pendingReplies.get(msg_id);
			if (pending?.result) {
				const r = pending.result;
				// Same nullish test as coms_net_await — an `error: ""` reply must
				// not read as "complete" here and as an error there.
				const failed = r.error != null;
				const text = failed
					? `coms_net_get: error — ${r.error}`
					: `coms_net_get: complete\n${typeof r.response === "string" ? r.response : JSON.stringify(r.response, null, 2)}`;
				return {
					content: [{ type: "text" as const, text }],
					details: { status: failed ? "error" : "complete", response: r.response, error: r.error ?? null, conversation_id: pending.conversation_id ?? null },
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
		renderCall(args: WireRecord, theme) {
			// Sanitized like coms_net_send's renderCall — tool args are model
			// output reachable by prompt injection.
			const id = sanitizePeerText(args.msg_id, "?");
			return new Text(
				theme.fg("toolTitle", theme.bold("coms_net_get ")) + theme.fg("warning", id),
				0, 0,
			);
		},
		renderResult(result, _options, theme) {
			const d = result.details as any;
			// Server-derived on the fallback path (`resp?.status` straight off
			// the hub's JSON), so sanitize before rendering.
			const status = sanitizePeerText(d?.status, "?", 32);
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
		async execute(_callId, params, signal: AbortSignal | undefined): Promise<AgentToolResult<any>> {
			// Gate like send/list (see coms_net_get).
			if (!identity || shuttingDown) throw new Error("coms-net not initialised");
			const msg_id = params.msg_id;
			// Clamp to the documented server cap: an uncapped value lets
			// Infinity / >2³¹−1 collapse to ~1ms in setTimeout (instant spurious
			// timeout), and a huge value would block the agent far past the
			// "Server cap applies" contract. Floor at 1s: a near-zero value
			// would delete the pending entry on an instant spurious timeout and
			// orphan the late reply.
			const rawTimeout = params.timeout_ms;
			const timeoutMs = typeof rawTimeout === "number" && Number.isFinite(rawTimeout) && rawTimeout > 0
				? Math.min(Math.max(rawTimeout, 1_000), MESSAGE_TIMEOUT_MS)
				: MESSAGE_TIMEOUT_MS;

			// Local SSE-resolved fast path.
			const pending = pendingReplies.get(msg_id);
			if (pending?.awaiting) {
				// A coms_net_await is already racing this reply — a second one
				// would double-consume it (or hit "unknown msg_id" after the
				// first await deletes the entry).
				return {
					content: [{ type: "text" as const, text: `coms_net_await: error — already awaiting msg_id ${msg_id}` }],
					details: { error: "already_awaiting", conversation_id: pending?.conversation_id ?? null },
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
				// Nullish, not truthy: handleInboundResponse preserves a
				// peer-supplied `error: ""`, and a truthiness check would report
				// that failure as a blank success.
				if (r.error != null) {
					return {
						content: [{ type: "text" as const, text: `coms_net_await: error — ${r.error}` }],
						details: { error: r.error, conversation_id: pending.conversation_id ?? null },
					};
				}
				const resp = r.response;
				return {
					content: [{ type: "text" as const, text: typeof resp === "string" ? resp : (JSON.stringify(resp, null, 2) ?? "") }],
					details: { response: resp, conversation_id: pending.conversation_id ?? null },
				};
			}

			// Race the server long-poll (and the local SSE promise, when one is
			// tracked for this msg_id) against the timeout. pending.promise is only
			// entered into the race when a local entry exists, so the absence of one
			// no longer plants a never-resolving placeholder that pins closures.
			// (timeoutMs is already clamped to MESSAGE_TIMEOUT_MS above.)
			const ac = new AbortController();
			// Honor tool cancellation: without this the long-poll fetch and the
			// 30-min timeout timer survive a host abort (user interrupt), and
			// the entry stays marked awaiting until its own timeout.
			let resolveAbort: (() => void) | null = null;
			const abortPromise = new Promise<{ error: string }>((resolve) => {
				resolveAbort = () => resolve({ error: "cancelled" });
			});
			const onCallerAbort = () => {
				try { ac.abort(); } catch { /* ignore */ }
				resolveAbort?.();
			};
			if (signal) {
				if (signal.aborted) onCallerAbort();
				else signal.addEventListener("abort", onCallerAbort, { once: true });
			}
			const serverPromise = httpFetch(
				"GET",
				`/v1/messages/${encodeURIComponent(msg_id)}/await?timeout_ms=${timeoutMs}`,
				undefined,
				{ timeoutMs: timeoutMs + 5_000, signal: ac.signal },
			).then((raw: unknown) => {
				// Untrusted hub body: a non-object (e.g. a plain string) reads as
				// an empty record, which falls through to unexpected_status below
				// exactly as the old `data.status` optional chain did.
				const data: WireRecord = isWireRecord(raw) ? raw : {};
				// The server echoes the conversation id; carry it through so an
				// await with no local pending entry (e.g. a pruned msg_id) still
				// surfaces it in details instead of dropping it.
				const conv = typeof data.conversation_id === "string" ? data.conversation_id : null;
				if (data.status === "complete") {
					const responseVal = data.response;
					// Mirror SSE/resync: accept a string OR a structured (parsed
					// JSON) response. prepareInboundResponse POSTs parsed JSON
					// objects for schema-driven prompts, and the SSE/resync
					// paths already surface them — rejecting non-strings here
					// broke valid schema-driven replies on the await path. Only
					// an absent response (undefined) is malformed.
					if (responseVal === undefined) {
						return { response: null, error: "malformed server reply", conversation_id: conv };
					}
					// Cap like the SSE path (MAX_RESPONSE_BYTES via
					// responseSizeBytes, which measures strings AND objects):
					// this long-poll body is bounded only by HTTP_BODY_CAP_BYTES
					// (16 MiB) and lands verbatim in the tool result. Capping
					// objects too keeps the long-poll a behavioral peer of the
					// SSE path (which also caps objects) rather than a looser
					// back-door for oversized structured payloads.
					if (responseSizeBytes(responseVal) > MAX_RESPONSE_BYTES) {
						audit("response_too_large", { msg_id });
						return { response: null, error: "response too large", conversation_id: conv };
					}
					return { response: responseVal, error: null, conversation_id: conv };
				}
				if (data.status === "error") {
					// Cap a peer-supplied error string too (parity with the
					// complete path and the SSE/resync paths): the error is
					// interpolated verbatim into the caller's tool output and
					// is bounded only by the 16 MiB HTTP body cap.
					const e = typeof data.error === "string" ? data.error : "error";
					if (responseSizeBytes(e) > MAX_RESPONSE_BYTES) {
						audit("response_too_large", { msg_id });
						return { response: null, error: "response too large", conversation_id: conv };
					}
					return { response: null, error: e, conversation_id: conv };
				}
				if (data.status === "timeout") return { response: null, error: "timeout", conversation_id: conv };
				// A non-terminal status (queued/delivered/pending) or a missing
				// one must not alias to a successful empty reply.
				return { response: null, error: `unexpected_status:${String(data.status ?? "unknown")}`, conversation_id: conv };
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
			// Caller-cancel racer: settles the race immediately on host abort so
			// execute returns instead of surviving until the long-poll or the
			// timeout fires (see onCallerAbort above).
			// One shared result shape for every racer, so the winner is read
			// through the type instead of an `as any` per field.
			const racers: Promise<{ response?: unknown; error?: string | null; conversation_id?: string | null }>[] = [serverPromise, timeoutPromise, abortPromise];
			if (pending) racers.push(pending.promise);
			const winner = await Promise.race(racers);
			clearTimeout(timeoutTimer);
			try { ac.abort(); } catch { /* ignore */ }
			if (signal) { try { signal.removeEventListener("abort", onCallerAbort); } catch { /* ignore */ } }
			// The reply is fully consumed by this await (success, error, or
			// timeout). Drop the entry immediately instead of leaving it for the
			// heartbeat pruning loop to reclaim up to timeout_ms + 60s later.
			// On caller-cancel the entry is also freed — a late reply resolves
			// into the void (audited as orphan/buffered), matching the timeout
			// path, and the next await won't hit "already awaiting".
			pendingReplies.delete(msg_id);

			// Nullish, not truthy — same reason as the SSE-resolved path above.
			if (winner.error != null) {
				return {
					content: [{ type: "text" as const, text: `coms_net_await: error — ${winner.error}` }],
					details: { error: winner.error, conversation_id: winner.conversation_id ?? pending?.conversation_id ?? null },
				};
			}
			const resp = winner.response;
			return {
				content: [{ type: "text" as const, text: typeof resp === "string" ? resp : (JSON.stringify(resp, null, 2) ?? "") }],
				details: { response: resp, conversation_id: winner.conversation_id ?? pending?.conversation_id ?? null },
			};
		},
		renderCall(args: WireRecord, theme) {
			// Sanitized like coms_net_send's renderCall — tool args are model
			// output reachable by prompt injection.
			const id = sanitizePeerText(args.msg_id, "?");
			return new Text(
				theme.fg("toolTitle", theme.bold("coms_net_await ")) + theme.fg("warning", id),
				0, 0,
			);
		},
		renderResult(result, _options, theme) {
			const d = result.details as any;
			// The error string is hub/peer-supplied and lands straight in the
			// TUI — same ANSI-injection channel renderCall closes, one hop
			// downstream. 256 chars, not the 64 default: this is a whole
			// error message, not a name.
			if (d?.error) return new Text(theme.fg("error", `✗ ${sanitizePeerText(d.error, "?", 256)}`), 0, 0);
			return new Text(theme.fg("success", "✓ response received"), 0, 0);
		},
	});

	// ━━ agent_end: capture turn output and submit response ━━━━━━━━━━━━━━━━

	// Extract one turn's reply text: the LAST non-empty assistant text within
	// [startIdx, endIdx) of the branch. Only overwrite on non-empty text — a
	// later assistant message that's tool-calls-only (no text block) must not
	// blank out a real reply from an earlier message in the same turn. The
	// slice bound keeps batched follow-up turns from cross-attributing each
	// other's replies (see agent_end).
	function sliceReplyText(branch: any[], startIdx: number, endIdx: number): string {
		let text = "";
		for (let i = startIdx; i < endIdx; i++) {
			const entry = branch[i];
			if (entry?.type === "message" && entry.message && entry.message.role === "assistant") {
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
					text = msgText;
				}
			}
		}
		return text;
	}

	// Build one inbound's reply submission WITHOUT awaiting: payload/schema
	// handling and exit-dispatch bookkeeping. Extracted from
	// submitInboundResponse so a batched agent_end can record every dispatch
	// synchronously before its first await — in pi's print/json mode (-p)
	// agent event listeners are fire-and-forget and main.js calls
	// process.exit(0) immediately after the final turn, so dispatches pushed
	// only inside an awaited loop iteration would silently lose replies #2..N
	// (the 'exit' fallback can only deliver what was pushed before the yield).
	function prepareInboundResponse(inbound: InboundContext, lastAssistantText: string): PreparedInboundResponse | null {
		if (!identity) return null;
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
			const jsonText = fenced?.[1] ?? lastAssistantText;
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

		// Producer-side response cap (mirrors the receiver-side check in
		// handleInboundResponse and the producer-side cap in coms.ts): an
		// oversized payload would be rejected at the transport layer and strand
		// the caller's coms_net_await until its full timeout — fail cleanly
		// here. Mutate req before dispatch is constructed so the body string
		// below stringifies the capped value.
		if (responseSizeBytes(req.response) > MAX_RESPONSE_BYTES) {
			req.response = null;
			req.error = "response too large";
		}

		// The bearer token is captured NOW: the install-once exit handler's
		// closure may belong to a stale extension instance whose authToken was
		// nulled by a session_start reset (see the module-level declaration).
		const dispatch = {
			msg_id: inbound.msg_id,
			url: `${serverUrl}/v1/messages/${encodeURIComponent(inbound.msg_id)}/response`,
			body: JSON.stringify(req),
			token: authToken ?? "",
			done: false,
		};
		pendingExitDispatches.push(dispatch);
		// Enforce the cap at push time, not only in the retry give-up path:
		// evict the oldest entries (their turns are the most likely already
		// abandoned) so a flood of failed POSTs can't stall process exit with
		// one blocking spawnSync per entry.
		while (pendingExitDispatches.length > MAX_PENDING_EXIT_DISPATCHES) {
			pendingExitDispatches.shift();
		}
		const dropDispatch = () => {
			const idx = pendingExitDispatches.indexOf(dispatch);
			if (idx >= 0) pendingExitDispatches.splice(idx, 1);
		};
		return { inbound, req, error, dispatch, dropDispatch };
	}

	// Submit one prepared reply: the POST itself, bounded retries, and
	// fulfillment. Extracted from agent_end so a batched runLoop's single
	// agent_end can fulfill every anchored inbound, each with its own
	// dispatch + retry state.
	async function submitInboundResponse(prep: PreparedInboundResponse): Promise<void> {
		const { inbound, req, error, dispatch, dropDispatch } = prep;
		// Retry with backoff (2s/10s/60s) instead of a single fixed 2s retry —
		// a brief network blip would otherwise lose the reply and leave the
		// caller waiting its full timeout. Only one timer per msg_id is ever
		// live (the schedule function clears any predecessor).
		const RETRY_DELAYS_MS = [2_000, 10_000, 60_000];
		const scheduleResponseRetry = (attempt: number) => {
			const msgId = inbound.msg_id;
			// Clear any orphaned timer for the same msg_id before overwriting —
			// otherwise the old timer still fires and its map delete() evicts
			// the live one, escaping cleanShutdown's cancellation sweep.
			const prev = responseRetryTimers.get(msgId);
			if (prev) { try { clearTimeout(prev); } catch { /* ignore */ } }
			const t = setTimeout(async () => {
				responseRetryTimers.delete(msgId);
				// Drop the exit dispatch BEFORE bailing: without this a
				// shutting-down or already-fulfilled retry leaves a done:false
				// entry that the 'exit' handler re-POSTs with a stale/empty
				// bearer after terminal cleanShutdown.
				if (shuttingDown || inbound.fulfilled) {
					dropDispatch();
					return;
				}
				// Refresh the prune clock: the entry is anchored mid-retry, so
				// the heartbeat sweep exempts it anyway — but once fulfilled the
				// anchor stays until compaction and the age window restarts
				// cleanly from the last delivery attempt.
				inbound.created_at = Date.now();
				try {
					await httpFetch("POST", `/v1/messages/${encodeURIComponent(msgId)}/response`, req);
					dispatch.done = true;
					dropDispatch();
					try {
						pi.appendEntry("coms-net-log", {
							event: "response_out",
							ts: nowIso(),
							msg_id: msgId,
							error,
							retried: true,
						});
					} catch { /* best-effort */ }
					markInboundFulfilled(inbound);
				} catch (e2: any) {
					audit("response_out_retry_failed", { msg_id: msgId, attempt, reason: safeError(e2) });
					if (attempt + 1 < RETRY_DELAYS_MS.length) {
						scheduleResponseRetry(attempt + 1);
						return;
					}
					audit("response_out_failed_final", { msg_id: msgId, reason: safeError(e2) });
					// Give up: tombstone and let the caller's own timeout resolve
					// it. Keep the exit dispatch — process exit still gets one
					// synchronous delivery attempt, and responses are idempotent
					// on the server (a duplicate is an orphan_response audit).
					// The MAX_PENDING_EXIT_DISPATCHES cap is enforced at push
					// time, so no trim is needed here.
					markInboundFulfilled(inbound);
				}
			}, RETRY_DELAYS_MS[attempt]);
			try { (t as any).unref?.(); } catch { /* ignore */ }
			responseRetryTimers.set(msgId, t);
		};

		// Refresh the prune clock now that the turn produced an answer — see
		// the matching refresh in scheduleResponseRetry.
		inbound.created_at = Date.now();
		try {
			await httpFetch("POST", `/v1/messages/${encodeURIComponent(inbound.msg_id)}/response`, req);
			dispatch.done = true;
			dropDispatch();
			try {
				pi.appendEntry("coms-net-log", {
					event: "response_out",
					ts: nowIso(),
					msg_id: inbound.msg_id,
					error,
				});
			} catch { /* best-effort */ }
			markInboundFulfilled(inbound);
		} catch (e: any) {
			// Do NOT fulfill on a failed POST — the reply never reached the
			// server and the caller is still waiting. Retry with backoff; only
			// after the last attempt do we give up, tombstone, and let the
			// caller's own timeout resolve it.
			audit("response_out_failed", { msg_id: inbound.msg_id, reason: safeError(e) });
			scheduleResponseRetry(0);
		} finally {
			// The first attempt is settled: the entry is either fulfilled
			// (activeInbound skips it) or retry-armed (the responseRetryTimers
			// guard in agent_end covers it), so the in-flight claim can go.
			inbound.dispatching = false;
		}
	}

	pi.on("agent_end", async (_event, ctx) => {
		// Shutdown latch (all four tools gate on it too): after a terminal-
		// status cleanShutdown the token is dead and the heartbeat sweep that
		// prunes unfulfilled inbounds is stopped — POSTing here would burn a
		// dead-token request (plus a retry timer) per queued inbound and leak
		// the entries until the next session_start reset.
		if (shuttingDown) return;
		const branch = ctx.sessionManager?.getBranch() ?? [];
		// FIFO turn attribution, per turn: pi 0.55.0 runs queued follow-ups in
		// ONE runLoop with a single agent_end, so this event must fulfill EVERY
		// anchored unfulfilled turnQueue entry — not just the oldest — each
		// reply scoped to the slice between its anchor and the next inbound's
		// anchor. (The old one-inbound-per-event + unbounded-walk-to-branch-end
		// both lost the later turns' replies and cross-attributed text produced
		// after later anchors to the first inbound.) Only claim entries whose
		// injected prompt actually anchors this branch — a user-driven turn
		// must not consume a queued inbound's reply slot.
		const claimed: { inbound: InboundContext; anchorIdx: number }[] = [];
		const kept: string[] = [];
		for (const mid of turnQueue) {
			const cand = inboundQueue.get(mid);
			if (!cand || cand.fulfilled) continue; // stale slot — drop
			const anchorIdx = branch.findIndex(e => anchorMsgIdOf(e) === mid);
			if (anchorIdx < 0) {
				// Not anchored in this branch: its followUp may not be persisted
				// yet (pi 0.55.0 queues followUps in memory until their turn
				// starts — the anchor lands at message_end), or the anchor was
				// lost to fork/navigation/compaction. Keep the slot: it can't
				// block the per-entry scan, a later agent_end claims it once
				// anchored, and a never-anchored entry is pruned + tombstoned
				// by the heartbeat sweep.
				kept.push(mid);
				continue;
			}
			claimed.push({ inbound: cand, anchorIdx });
		}
		turnQueue.length = 0;
		turnQueue.push(...kept);
		if (!identity) return;
		// Don't double-POST an inbound whose retry is already pending — a
		// failed response POST leaves the entry unfulfilled and re-findable
		// here, which would arm a second retry timer for the same msg_id.
		if (claimed.length === 0) {
			// Fallback for inbounds not tracked in turnQueue (e.g. injected
			// before this build of the extension state existed). Skip an
			// inbound another fire-and-forget agent_end already claimed but
			// whose first POST is still in flight (dispatching) — the
			// responseRetryTimers guard alone doesn't cover that window, and
			// re-submitting here would POST the same msg_id twice.
			const inbound = activeInbound(ctx);
			if (!inbound || inbound.dispatching || responseRetryTimers.has(inbound.msg_id)) return;
			const anchorIdx = branch.findIndex(e => anchorMsgIdOf(e) === inbound.msg_id);
			inbound.dispatching = true;
			const prep = prepareInboundResponse(inbound, sliceReplyText(branch, anchorIdx + 1, branch.length));
			if (prep) await submitInboundResponse(prep);
			else inbound.dispatching = false;
			return;
		}
		// Branch order (not queue order) decides the slice boundaries.
		claimed.sort((a, b) => a.anchorIdx - b.anchorIdx);
		// Pass 1 — synchronous: mark every claim in-flight and build every
		// submission (which pushes its exit-dispatch) BEFORE the first await.
		// Both are required by the print-mode race: process.exit(0) can fire
		// at the first await in pass 2, and the 'exit' fallback can only
		// deliver dispatches already recorded; a second agent_end running
		// while pass 2 is suspended must also see these as claimed.
		const prepared: PreparedInboundResponse[] = [];
		for (const { inbound, anchorIdx } of claimed) {
			if (responseRetryTimers.has(inbound.msg_id)) continue;
			// Slice end = the NEXT inbound prompt anchor in the branch (any
			// msg_id), not just the next CLAIMED one. claimed skips fulfilled /
			// retry-pending inbounds, so using claimed[i+1].anchorIdx would
			// span across a foreign anchor sitting between two claimed ones
			// and fold that turn's replies into this slice (sliceReplyText
			// returns the LAST non-empty assistant text, so the later foreign
			// reply wins → cross-attribution). Reachable under session fork /
			// navigation / compaction, which can leave a fulfilled inbound's
			// anchor between two still-unfulfilled ones.
			let end = branch.length;
			for (let j = anchorIdx + 1; j < branch.length; j++) {
				if (anchorMsgIdOf(branch[j]) !== undefined) {
					end = j;
					break;
				}
			}
			inbound.dispatching = true;
			const prep = prepareInboundResponse(inbound, sliceReplyText(branch, anchorIdx + 1, end));
			if (prep) prepared.push(prep);
			else inbound.dispatching = false;
		}
		// Pass 2 — the awaited POSTs.
		for (const prep of prepared) {
			await submitInboundResponse(prep);
		}
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
				// A scheduled reconnect is mid-flight: tearing down here would
				// abort the SSE it just opened, and reRegisterAndOpen would
				// no-op on the reconnectInFlight latch while the heartbeat
				// below arms as if we succeeded. Defer to the in-flight one.
				if (reconnectInFlight) {
					try { ctx.ui.notify("coms-net: reconnect already in progress", "info"); } catch { /* ignore */ }
					return;
				}
				// Boot never completed (no server URL / token / health check at
				// session_start) — there is nothing to re-register and arming
				// the heartbeat below would spin a dead interval forever. The
				// user must fix the boot failure; a new session_start retries.
				if (!identity) {
					try { ctx.ui.notify("coms-net: cannot reconnect — no active registration (boot failed or not started)", "error"); } catch { /* ignore */ }
					return;
				}
				try { ctx.ui.notify("coms-net: reconnecting SSE...", "info"); } catch { /* ignore */ }
				// Re-resolve URL/token from the same sources boot used — the
				// server may have restarted on a new port (server.json
				// rewritten) or rotated its token since session_start. Keep the
				// current values if resolution now fails rather than bricking
				// the connection.
				{
					const flags = readCliFlags(pi);
					const freshUrl = resolveServerUrl(identity.project, flags.serverUrl);
					const freshToken = resolveAuthToken(identity.project, flags.authToken);
					if (freshUrl) serverUrl = freshUrl;
					if (freshToken) authToken = freshToken;
				}
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
				// A prior terminal-status cleanShutdown latched shuttingDown;
				// identity, serverUrl and authToken survive it, so clear the
				// latch or both reRegisterAndOpen and scheduleReconnect
				// silently no-op.
				if (shuttingDown) shuttingDown = false;
				try {
					await reRegisterAndOpen();
					// cleanShutdown cleared the heartbeat interval and
					// reRegisterAndOpen only restarts it when one is already
					// running — re-arm it here or the agent stays registered
					// with a dead heartbeat.
					if (!heartbeatTimer) {
						heartbeatTimer = setInterval(heartbeatTick, heartbeatIntervalMs);
						try { (heartbeatTimer as any).unref?.(); } catch { /* ignore */ }
					}
				} catch (err) {
					audit("manual_reconnect_failed", { reason: safeError(err) });
					// A transient failure here would otherwise leave inbound
					// delivery dead until the extension restarts — fall back to
					// the scheduled backoff loop. Terminal auth/path errors get
					// the same treatment as the scheduled path: notify + shutdown.
					if (err instanceof HttpError && (err.status === 401 || err.status === 403 || err.status === 404)) {
						try { ctx.ui.notify(`📡 coms-net: reconnect failed (HTTP ${err.status}) — not retrying`, "error"); } catch { /* ignore */ }
						void cleanShutdown();
					} else {
						scheduleReconnect();
					}
				}
			}
			if (tokens.includes("--server")) {
				try {
					const health = await httpFetch("GET", "/health");
					// httpFetch returns `any` — both fields are hub-controlled
					// and this string goes straight to the terminal notifier.
					ctx.ui?.notify?.(
						`coms-net server: ${serverUrl} · version ${sanitizePeerText(health?.version, "?", 64)} · server_id ${sanitizePeerText(health?.server_id, "?", 64)}`,
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
		// Invalidate any reRegisterAndOpen still awaiting — its registration
		// result is stale the moment shutdown begins.
		sessionGeneration++;

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
		// Cancel pending response-POST retries — their timers would otherwise
		// fire into a torn-down session (they also self-skip on shuttingDown).
		for (const t of responseRetryTimers.values()) {
			try { clearTimeout(t); } catch { /* ignore */ }
		}
		responseRetryTimers.clear();

		// Settle in-flight entries so a coms_net_await racing this shutdown
		// resolves immediately instead of hanging until its own timeout (up to
		// MESSAGE_TIMEOUT_MS = 30 min). Mirrors the session_start reset loop.
		for (const entry of pendingReplies.values()) {
			entry.result = { error: "shutdown" };
			try { entry.resolve(entry.result); } catch { /* ignore */ }
		}
		pendingReplies.clear();
		earlyResponses.clear();

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

	// Shared latch for session_start AND session_shutdown: a shutdown racing a
	// start would run cleanShutdown against half-built state and wedge every
	// later cleanup. Bounded wait — a wedged init must not spin the poll loop
	// forever; on timeout we proceed and audit loudly (mirrors coms.ts
	// acquireInitLatch; builds on the `initializing` flag from the B21 fix).
	async function acquireInitLatch(waiter: string): Promise<void> {
		const deadline = Date.now() + INIT_LATCH_TIMEOUT_MS;
		while (initializing) {
			if (Date.now() >= deadline) {
				audit("init_latch_timeout", { waiter });
				break;
			}
			await new Promise((resolve) => setTimeout(resolve, 25));
		}
		initializing = true;
	}

	// Rely on the host's session_shutdown event for cleanup. Registering
	// process-level SIGINT/SIGTERM handlers from an extension suppresses Node's
	// default termination (once any listener attaches, Ctrl-C no longer exits)
	// and can hang the host on shutdown. The host owns process lifecycle.
	pi.on("session_shutdown", async () => {
		// Serialize with session_start on the same latch: cleanShutdown against
		// half-built state would set the shuttingDown latch while init
		// continues and wedges every later cleanup (mirrors coms.ts). Hold the
		// latch during cleanShutdown so a queued session_start can't win the
		// poll race and then be torn down by this shutdown.
		await acquireInitLatch("session_shutdown");
		try {
			await cleanShutdown();
		} finally {
			initializing = false;
		}
	});

	// The 'exit' event, unlike SIGINT/SIGTERM handlers, cannot suppress or
	// defer termination beyond its own synchronous run — so this does not
	// hijack the host's lifecycle. It buys one synchronous delivery attempt
	// for responses that the print/json-mode exit race (see agent_end) would
	// otherwise drop: main.js's process.exit(0) kills the floating agent_end
	// handler mid-POST. 'exit' handlers must be fully synchronous, so the
	// delivery runs in a child process (spawnSync) that re-POSTs the body;
	// normally the async path has already marked every dispatch done and this
	// is a no-op. Responses are idempotent on the server — a duplicate is at
	// worst an orphan_response audit on the caller.
	// Install at most once: process.on accumulates listeners, so an extension
	// reload / co-load would otherwise stack duplicate exit handlers
	// re-delivering the same array. The dispatch array is module-level so the
	// single handler sees live state (mirrors coms.ts).
	if (!exitHandlerInstalled) {
		exitHandlerInstalled = true;
		process.on("exit", () => {
			// Total budget across all dispatches: each spawnSync blocks up to
			// EXIT_DELIVER_TIMEOUT_MS (+1s), so without a cap a backlog of
			// undelivered responses could stall process exit for minutes.
			const deadline = Date.now() + EXIT_DELIVER_BUDGET_MS;
			for (const d of pendingExitDispatches) {
				if (d.done) continue;
				if (Date.now() >= deadline) break;
				try {
					spawnSync(process.execPath, ["-e", EXIT_DELIVER_SCRIPT], {
						input: d.body,
						env: { ...process.env, COMS_NET_DELIVER_URL: d.url, COMS_NET_DELIVER_TOKEN: d.token },
						timeout: EXIT_DELIVER_TIMEOUT_MS + 1_000,
						stdio: ["pipe", "ignore", "ignore"],
					});
				} catch { /* best-effort — the process is already exiting */ }
			}
		});
	}
}
