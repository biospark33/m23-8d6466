/**
 * coms — Peer-to-peer messaging between Pi agents on the same machine
 *
 * Each agent listens on a unix socket (POSIX-only; the Windows named-pipe
 * branch is unsupported and fails fast at startup) and discovers peers
 * through per-project registry files under
 * ~/.pi/coms/projects/<project>/agents/<name>.json.
 *
 * Phase A (foundation): identity resolution, registry I/O, transport bind/send,
 * connection handlers. Phase B: tools (coms_list/send/get/await), agent_end
 * response capture. Phase C: live pool widget, ping + keepalive cycles, /coms
 * slash command, clean shutdown lifecycle.
 *
 * Vendored into QDS-Factory (pi-vs-claude-code-vendor/) from the pi-mono coms
 * extension for the pi-vs-claude-code review harness. The identical/parity
 * layer (pure helpers, bounded env-int parser, duplicate-registration guard,
 * shared caps) lives in ./coms-core.ts — imported here exactly like
 * ./themeMap.ts. Transport-specific logic below (Unix-socket bind/send,
 * registry I/O, tombstone bookkeeping, queues, widgets) stays per-file and is
 * kept in manual parity with coms-net.ts; see DIVERGENCE.md.
 *
 * Usage: pi -e pi-vs-claude-code-vendor/coms.ts
 */

import type { AgentToolResult, ExtensionAPI, ExtensionContext, RegisteredCommand, Theme, ToolDefinition } from "@mariozechner/pi-coding-agent";
import { DynamicBorder } from "@mariozechner/pi-coding-agent";
import { Text, truncateToWidth } from "@mariozechner/pi-tui";
import { Type, type TSchema } from "@sinclair/typebox";
import { applyExtensionDefaults } from "./themeMap.ts";
import {
	abbreviateModel,
	envBoundedInt,
	fallbackColor,
	hexFg,
	isDuplicateRegistration,
	isSafePathComponent,
	isValidHex,
	MAX_FULFILLED_TOMBSTONES,
	MAX_HOPS,
	MAX_INBOUND,
	MAX_PENDING_EXIT_DISPATCHES,
	EXIT_DELIVER_BUDGET_MS,
	parseFrontmatter,
	sanitizePeerText,
	secretEqual,
	ulid,
} from "./coms-core.ts";
import * as net from "node:net";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import * as crypto from "node:crypto";
import { spawnSync } from "node:child_process";

// ━━ Constants ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

// Timer/size knobs must be finite, positive INTEGERS (the { integer: true }
// mode of envBoundedInt): Infinity would disable the guard or make timeouts
// never fire, negatives would nack every inbound or busy-loop setInterval,
// values above 2^31-1 overflow Node's setTimeout, and a fractional value like
// 0.5 would floor to 0 — a zero timer bricks intervals. Capped at 2^31-1.
const INT_MAX = 2 ** 31 - 1;

const COMS_DIR = process.env.PI_COMS_DIR || path.join(os.homedir(), ".pi", "coms");
const TIMEOUT_MS = envBoundedInt(process.env.PI_COMS_TIMEOUT_MS, 1_800_000, { integer: true, max: INT_MAX });
// Receiver-side deadline for pruning inbound turns that never completed.
// TIMEOUT_MS is the SENDER-side reply timeout; keep the two independent so a
// short sender timeout can't evict an in-flight inbound turn early.
const TURN_DEADLINE_MS = envBoundedInt(process.env.PI_COMS_TURN_DEADLINE_MS, 1_800_000, { integer: true, max: INT_MAX });
// Floor at 1s: envBoundedInt accepts any positive integer, and a
// unit-confused value like 10 (ms) would busy-loop the ping cycle.
const PING_INTERVAL_MS = Math.max(1000, envBoundedInt(process.env.PI_COMS_PING_INTERVAL_MS, 10_000, { integer: true, max: INT_MAX }));
const KEEPALIVE_INTERVAL_MS = 30_000;
// A live agent rewrites heartbeat_at every KEEPALIVE_INTERVAL_MS. Allow three
// missed cycles before declaring the entry stale — catches recycled PIDs and
// hung agents, which process.kill(pid, 0) alone cannot detect.
const HEARTBEAT_STALE_MS = 3 * KEEPALIVE_INTERVAL_MS;
// Envelopes are newline-framed JSON; prompts carrying file context or
// multi-turn history routinely exceed 64 KB. 16 MB matches coms-net's
// SSE_BUF_CAP_BYTES while still bounding the per-line accumulator.
const LINE_CAP_BYTES = 16 * 1024 * 1024;
const SOCKET_OP_TIMEOUT_MS = 5_000;
// MAX_INBOUND, MAX_PENDING_EXIT_DISPATCHES, MAX_FULFILLED_TOMBSTONES,
// EXIT_DELIVER_BUDGET_MS and MAX_HOPS are imported from ./coms-core.ts —
// identical value and meaning in both transports (see DIVERGENCE.md).
// Prompts are injected into the receiver's context; cap each one well below
// LINE_CAP_BYTES so an authenticated peer can't burn the whole context window
// (or pin ~4GB via 256 queued 16MB envelopes) with a single send.
const MAX_PROMPT_BYTES = 256 * 1024;
// Responses land verbatim in the caller's coms_get/coms_await tool output;
// cap like MAX_PROMPT_BYTES so a peer can't push a full LINE_CAP_BYTES (16MB)
// payload into the caller's context window.
const MAX_RESPONSE_BYTES = 256 * 1024;
// Receiver-side cap on a peer-supplied response_schema: the blob is stored
// per inbound and persisted into the session branch via details, so the 16MB
// transport cap is far too loose for it. Same bound as coms-net's
// MAX_RESPONSE_SCHEMA_BYTES — the two transports are behavioral peers and a
// schema accepted by one must not be nacked by the other.
const MAX_RESPONSE_SCHEMA_BYTES = 32_768;
// Completed pendingReplies entries are retained for coms_get polling until
// the keepalive sweep reclaims them; cap the retained count (oldest completed
// evicted first) so chatty agents can't grow the map without bound.
const MAX_COMPLETED_REPLIES = 256;
// Bound on the session_start/session_shutdown init-latch spin: without a
// deadline a wedged init would spin the 25ms poll loop forever.
const INIT_LATCH_TIMEOUT_MS = envBoundedInt(process.env.PI_COMS_INIT_LATCH_TIMEOUT_MS, 30_000, { integer: true, max: INT_MAX });

// ━━ Types ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

type EnvelopeType = "prompt" | "response" | "ping";

interface Envelope {
	type: EnvelopeType;
	msg_id: string;
	sender_session: string;
	sender_endpoint: string;
	hops: number;
	timestamp: string;
}

interface PromptEnvelope extends Envelope {
	type: "prompt";
	// Shared secret from the *receiver's* registry entry; receivers nack any
	// envelope whose secret doesn't match their own (D1).
	secret: string;
	prompt: string;
	sender_name: string;
	sender_cwd: string;
	conversation_id?: string | null;
	response_schema?: object | null;
}

interface ResponseEnvelope extends Envelope {
	type: "response";
	// Echo of the secret the originating prompt carried (the responder's own
	// registry secret, already verified inbound). The original sender
	// verifies it against the secret it sent; a same-user attacker who
	// harvested only a msg_id from logs cannot forge a response without it.
	secret: string;
	response: any;
	error?: string | null;
	// Echo of the originating prompt's conversation_id so the caller can
	// correlate threads (D2).
	conversation_id?: string | null;
}

interface PingEnvelope extends Envelope {
	type: "ping";
}

interface AgentCard {
	name: string;
	purpose: string;
	model: string;
	color: string;
	context_used_pct: number;
	queue_depth: number;
}

interface Pong {
	type: "pong";
	msg_id: string;
	agent_card: AgentCard;
}

interface RegistryEntry {
	session_id: string;
	name: string;
	purpose: string;
	model: string;
	color: string;
	pid: number;
	endpoint: string;
	cwd: string;
	started_at: string;
	explicit: boolean;
	version: number;
	// Per-session shared secret (crypto.randomUUID) that senders must echo in
	// prompt envelopes; the 0700 registry dir keeps it same-user-only (INV-2).
	// Optional so entries written by pre-auth agents still parse — but
	// coms_send refuses to target them.
	secret?: string;
	// Live status snapshot — refreshed every KEEPALIVE_INTERVAL_MS by the heartbeat.
	// Optional so older entries (pre-heartbeat-refresh) still parse cleanly.
	context_used_pct?: number;
	queue_depth?: number;
	heartbeat_at?: string;
}

interface PendingReply {
	resolve: (value: any) => void;
	timer: NodeJS.Timeout | null;
	promise: Promise<{ response?: any; error?: string | null }>;
	result?: { response?: any; error?: string | null };
	target_name?: string;
	// conversation_id from coms_send, surfaced by coms_get for correlation (D2).
	conversation_id?: string | null;
	// The target's registry secret we sent in the prompt; the response must
	// echo it back (verified timing-safe in handleResponse).
	expected_secret?: string;
	// Epoch ms at coms_send time (kept as a number so the keepalive pruning
	// loop avoids re-parsing an ISO string on every sweep).
	created_at: number;
	// Effective await deadline (ms). Defaults to TIMEOUT_MS at send time; a
	// coms_await override replaces it so the keepalive pruning loop below does
	// not evict the entry before the caller's own timeout fires.
	timeout_ms?: number;
	// Epoch ms when coms_await took ownership of the deadline. Pruning measures
	// the effective timeout from this point (the await's own timer starts at
	// invocation, not at send); entries never awaited fall back to created_at.
	await_started_at?: number;
}

interface InboundContext {
	msg_id: string;
	hops: number;
	sender_endpoint: string;
	sender_session: string;
	// Verified prompt secret (== our registry secret), echoed into the
	// response envelope so the original sender can authenticate the reply.
	secret: string;
	conversation_id?: string | null;
	response_schema?: object | null;
	// Epoch ms at receipt; keepalive pruning evicts unfulfilled entries older
	// than TURN_DEADLINE_MS so a never-completing turn can't leak the entry
	// forever.
	created_at: number;
	fulfilled: boolean;
}

// ━━ Helpers ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//
// Pure/parity helpers (ulid, hexFg, fallbackColor, parseFrontmatter,
// abbreviateModel, sanitizePeerText, secretEqual, isSafePathComponent) live in
// ./coms-core.ts. Transport-specific helpers stay below.

// macOS caps sun_path at 104 bytes (incl. NUL), Linux at 108 — a deep
// PI_COMS_DIR or long home path can blow past that and make bind fail with
// EINVAL/ENAMETOOLONG. Use 100 as the budget so the check is conservative on
// every POSIX platform.
const MAX_SOCKET_PATH_BYTES = 100;

function makeEndpoint(sessionId: string): string {
	// POSIX-only: Windows named pipes have no per-user ACL equivalent of the
	// 0700 socket dir (INV-2). session_start already fails fast on win32;
	// throw here too so no other path can silently derive an unsupported
	// named-pipe endpoint.
	if (process.platform === "win32") {
		throw new Error("coms: Windows named pipes are not supported (POSIX-only)");
	}
	const socketPath = path.join(COMS_DIR, "sockets", `${sessionId}.sock`);
	if (Buffer.byteLength(socketPath, "utf-8") <= MAX_SOCKET_PATH_BYTES) {
		return socketPath;
	}
	// Fall back to a per-user dir under the system tmp dir. Both ends derive
	// the endpoint solely from makeEndpoint (clients connect via the endpoint
	// recorded in the registry), so the fallback stays consistent as long as
	// the dir name is deterministic. getuid keeps concurrent users' sockets
	// apart in the shared tmp dir; the dir is chmod'd 0700 at bind time.
	const uid = typeof process.getuid === "function" ? process.getuid() : 0;
	return path.join(os.tmpdir(), `pi-coms-${uid}`, `${sessionId}.sock`);
}

function nowIso(): string {
	return new Date().toISOString();
}

// Audit hook installed by the default export so module-level helpers (which
// have no pi handle) can still record security-relevant events.
let auditFn: ((data: Record<string, unknown>) => void) | null = null;

// Responses recorded synchronously at agent_end but not yet confirmed
// delivered by the async sendEnvelope path — retried by the 'exit' fallback
// (see the bottom of the default export). Module-level (shared) because the
// 'exit' handler is installed at most once, even if the extension factory
// runs twice (reload / co-load with coms-net), and must see the live array.
const pendingExitDispatches: { endpoint: string; line: string; done: boolean }[] = [];
let exitHandlerInstalled = false;

// ━━ CLI flag shape (read via pi.registerFlag/pi.getFlag) ━━━━━━━━━━━━━━━━━━━

interface CliFlags {
	name?: string;
	purpose?: string;
	project?: string;
	color?: string;
	explicit?: boolean;
}

// isDuplicateRegistration (imported from ./coms-core.ts) swallows only the
// duplicate-registration error thrown when co-loading with coms-net.ts (or an
// extension reload) double-registers the same flag/tool/command; anything else
// is a real bug and must still propagate.
function registerFlagSafe(
	pi: ExtensionAPI,
	name: string,
	options: { description?: string; type: "boolean" | "string"; default?: boolean | string },
): void {
	try {
		pi.registerFlag(name, options);
	} catch (err) {
		if (isDuplicateRegistration(err)) return;
		throw err;
	}
}

// Same duplicate-tolerance as registerFlagSafe: co-loading with coms-net.ts
// (or an extension reload) can double-register tools/commands.
function registerToolSafe<TParams extends TSchema, TDetails>(pi: ExtensionAPI, tool: ToolDefinition<TParams, TDetails>): void {
	try {
		pi.registerTool(tool);
	} catch (err) {
		if (isDuplicateRegistration(err)) return;
		throw err;
	}
}

function registerCommandSafe(pi: ExtensionAPI, name: string, command: Omit<RegisteredCommand, "name">): void {
	try {
		pi.registerCommand(name, command);
	} catch (err) {
		if (isDuplicateRegistration(err)) return;
		throw err;
	}
}

function readCliFlags(pi: ExtensionAPI): CliFlags {
	// Identity flags are declared via pi.registerFlag at extension load time so
	// pi's CLI parser accepts them; here we just read them back.
	const name = pi.getFlag("cname") as string | undefined;
	const purpose = pi.getFlag("purpose") as string | undefined;
	const project = pi.getFlag("project") as string | undefined;
	const color = pi.getFlag("color") as string | undefined;
	const explicit = pi.getFlag("explicit") as boolean | undefined;
	return {
		name: name && name.length > 0 ? name : undefined,
		purpose: purpose && purpose.length > 0 ? purpose : undefined,
		project: project && project.length > 0 ? project : undefined,
		color: color && color.length > 0 ? color : undefined,
		explicit: explicit === true,
	};
}

// ━━ Registry I/O ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// isSafePathComponent (imported from ./coms-core.ts) rejects path
// traversal / separator injection in project & agent names.

function projectAgentsDir(project: string): string {
	if (!isSafePathComponent(project)) {
		throw new Error(`coms: invalid project name "${project}"`);
	}
	return path.join(COMS_DIR, "projects", project, "agents");
}

function registryFilePath(project: string, name: string): string {
	if (!isSafePathComponent(name)) {
		throw new Error(`coms: invalid agent name "${name}"`);
	}
	return path.join(projectAgentsDir(project), `${name}.json`);
}

function writeRegistryAtomic(entry: RegistryEntry, project: string, opts?: { exclusive?: boolean }): string {
	const dir = projectAgentsDir(project);
	fs.mkdirSync(dir, { recursive: true });
	const final = registryFilePath(project, entry.name);
	const data = JSON.stringify(entry, null, 2);
	const tmp = `${final}.${process.pid}.tmp`;
	fs.writeFileSync(tmp, data);
	// The entry carries the shared secret: tighten perms immediately so the
	// file is never world-readable in the window before the post-publish chmod.
	try { fs.chmodSync(tmp, 0o600); } catch { /* best-effort */ }
	if (opts?.exclusive) {
		// fs.linkSync is a single atomic syscall that fails with EEXIST if `final`
		// already exists — closes the TOCTOU window a plain renameSync would leave
		// between two agents racing to claim the same resolveUniqueName() result,
		// and keeps content atomic (a crash mid-write only ever orphans `tmp`).
		// Hard links are unsupported on some filesystems (FAT/exFAT, VirtualBox
		// shared folders, certain network mounts); there we fall back to an
		// O_EXCL create ('wx'), trading the tiny crash-atomicity window for
		// portability. EEXIST and all other errors propagate unchanged.
		try {
			fs.linkSync(tmp, final);
		} catch (err) {
			const code = (err as NodeJS.ErrnoException).code;
			if (code === "ENOTSUP" || code === "EPERM") {
				fs.writeFileSync(final, data, { flag: "wx", mode: 0o600 });
			} else {
				throw err;
			}
		} finally {
			try { fs.unlinkSync(tmp); } catch { /* best-effort */ }
		}
	} else {
		fs.renameSync(tmp, final);
	}
	// The entry carries the shared secret; the registry dir is 0700, but make
	// the file itself owner-only too so a permissive umask or a manually
	// created parent dir never leaves it world-readable (best-effort).
	try { fs.chmodSync(final, 0o600); } catch { /* best-effort */ }
	return final;
}

function readAllRegistryEntries(project: string, skipped?: string[]): RegistryEntry[] {
	const out: RegistryEntry[] = [];
	let dir: string;
	let files: string[];
	try {
		// projectAgentsDir throws on an invalid project name — resolve inside
		// the try so the function returns [] (its failure contract) instead of
		// escaping and crashing the caller.
		dir = projectAgentsDir(project);
		if (!fs.existsSync(dir)) return [];
		files = fs.readdirSync(dir);
	} catch {
		return [];
	}
	for (const f of files) {
		if (!f.endsWith(".json")) {
			// A crash between writeFileSync(tmp) and link/rename in
			// writeRegistryAtomic orphans `<name>.json.<pid>.tmp` forever —
			// nothing else ever touches non-.json names. Reap tmp files older
			// than 1h (far past any plausible write window, so a live agent
			// mid-write is never unlinked).
			if (f.endsWith(".tmp")) {
				try {
					const p = path.join(dir, f);
					if (Date.now() - fs.statSync(p).mtimeMs > 3_600_000) {
						fs.unlinkSync(p);
						try { auditFn?.({ event: "registry_tmp_reaped", file: f }); } catch { /* best-effort */ }
					}
				} catch { /* best-effort */ }
			}
			continue;
		}
		try {
			const raw = fs.readFileSync(path.join(dir, f), "utf-8");
			const parsed = JSON.parse(raw) as RegistryEntry;
			// A corrupt/malicious registry file could carry a `name` containing
			// path separators or "..", or non-string display fields that crash
			// the widget render (padEnd/startsWith on a number). Reject such
			// entries here so no downstream consumer (pruneDeadEntries/
			// removeRegistryEntry/renderPool) ever derives a path from an
			// unsafe stored name or renders a non-string field.
			if (
				parsed &&
				typeof parsed.session_id === "string" &&
				isSafePathComponent(parsed.name) &&
				typeof parsed.model === "string" &&
				typeof parsed.purpose === "string"
			) {
				// Registry files are same-user-writable (a planted entry passes
				// the pid + heartbeat liveness checks in pruneDeadEntries), so
				// display fields are peer-controlled: strip control characters
				// (ANSI escape injection into the pool widget) and cap length at
				// this boundary so every consumer — renderPool, coms_list text
				// AND the details object fed back to the calling model — inherits
				// it. `name` needs no sanitizing (isSafePathComponent whitelist).
				out.push({
					...parsed,
					purpose: sanitizePeerText(parsed.purpose, "", 256),
					model: sanitizePeerText(parsed.model, "unknown", 64),
					cwd: sanitizePeerText(parsed.cwd, "", 256),
				});
			} else {
				try { auditFn?.({ event: "registry_entry_malformed", file: f }); } catch { /* best-effort */ }
				skipped?.push(path.join(dir, f));
			}
		} catch {
			// Unparseable file — track it so pruneDeadEntries can unlink it;
			// otherwise a corrupt file squats its agent name forever (it is
			// invisible here yet blocks exclusive name claims with EEXIST).
			skipped?.push(path.join(dir, f));
		}
	}
	return out;
}

function removeRegistryEntry(project: string, name: string, sessionId?: string): void {
	try {
		const p = registryFilePath(project, name);
		// TOCTOU guard (narrowed, not eliminated): if another session reclaimed
		// our name between the read that decided this entry was dead and the
		// unlink, the on-disk session_id won't match ours — bail so we don't
		// delete a live agent's registry file. The second lstat catches a
		// reclaim that lands mid-check (the file is replaced between our parse
		// and the unlink); a reclaim after that still wins the race. Omitting
		// sessionId (no current callers do) skips the guard entirely.
		if (sessionId !== undefined) {
			let before: fs.Stats;
			try {
				before = fs.lstatSync(p);
			} catch {
				return; // already gone — nothing to remove
			}
			const parsed = JSON.parse(fs.readFileSync(p, "utf-8")) as RegistryEntry;
			if (parsed.session_id !== sessionId) return;
			const after = fs.lstatSync(p);
			if (after.dev !== before.dev || after.ino !== before.ino || after.mtimeMs !== before.mtimeMs) {
				return; // replaced mid-check — leave it for its new owner
			}
		}
		fs.unlinkSync(p);
	} catch {
		// best-effort
	}
}

function pruneDeadEntries(project: string): RegistryEntry[] {
	// Corrupt/unparseable files are invisible to the entry checks below and
	// would squat their agent name forever (resolveUniqueName never sees them,
	// yet an exclusive create EEXISTs on them). Unlink best-effort; filenames
	// come from readdir so they can't escape the agents dir. Small race: a
	// live agent that rewrites the file between our read and this unlink loses
	// one registration — its next heartbeat self-heals.
	const skipped: string[] = [];
	const entries = readAllRegistryEntries(project, skipped);
	for (const p of skipped) {
		try { fs.unlinkSync(p); } catch { /* best-effort */ }
		try { auditFn?.({ event: "registry_entry_corrupt_pruned", file: path.basename(p) }); } catch { /* best-effort */ }
	}
	const live: RegistryEntry[] = [];
	for (const entry of entries) {
		// A corrupt/malformed registry file can yield a non-positive pid; passing
		// that to process.kill signals the current process (undefined/null) or
		// the whole process group (0), which would falsely mark a dead entry live.
		if (typeof entry.pid !== "number" || !Number.isInteger(entry.pid) || entry.pid <= 0) {
			removeRegistryEntry(project, entry.name, entry.session_id);
			continue;
		}
		try {
			process.kill(entry.pid, 0);
		} catch (e: any) {
			if (e && e.code === "ESRCH") {
				removeRegistryEntry(project, entry.name, entry.session_id);
				continue;
			}
			// EPERM means the process exists but belongs to another user — which
			// may be a recycled PID unrelated to this agent. Don't treat that as
			// proof of life: fall through to the heartbeat check so a stale entry
			// still gets pruned instead of living in the registry forever.
		}
		// The PID appears live (signal succeeded, or EPERM for another user's
		// process), but that isn't proof the agent is alive: the PID may
		// have been recycled by an unrelated process, or the agent may be hung
		// with a live process but a dead event loop. A healthy agent rewrites
		// heartbeat_at every KEEPALIVE_INTERVAL_MS, so prune entries whose
		// heartbeat is stale (or unparseable — a live agent never writes one).
		// Entries without heartbeat_at (written by pre-heartbeat agents) are
		// exempt and stay live on the pid check alone.
		if (entry.heartbeat_at !== undefined) {
			const beatMs = Date.parse(entry.heartbeat_at);
			// Prune when the heartbeat is unparseable, too old, OR too far in
			// the future: a future-dated timestamp (clock skew or a corrupt/
			// malicious entry) would otherwise exempt the file from staleness
			// pruning indefinitely.
			if (!Number.isFinite(beatMs) || Math.abs(Date.now() - beatMs) > HEARTBEAT_STALE_MS) {
				removeRegistryEntry(project, entry.name, entry.session_id);
				continue;
			}
		}
		live.push(entry);
	}
	return live;
}

function resolveUniqueName(project: string, desiredName: string): string {
	// Returns a name that doesn't collide with any LIVE registered agent.
	// pruneDeadEntries auto-removes ESRCH entries; we only care about live ones.
	const liveEntries = pruneDeadEntries(project);
	const liveNames = new Set(liveEntries.map(e => e.name));
	if (!liveNames.has(desiredName)) return desiredName;
	let n = 2;
	while (liveNames.has(`${desiredName}${n}`)) n++;
	return `${desiredName}${n}`;
}

function pruneDeadEntriesAllProjects(): RegistryEntry[] {
	const root = path.join(COMS_DIR, "projects");
	let projects: string[];
	try {
		projects = fs.readdirSync(root);
	} catch {
		return [];
	}
	const out: RegistryEntry[] = [];
	for (const p of projects) {
		try {
			if (!fs.statSync(path.join(root, p)).isDirectory()) continue;
		} catch {
			continue;
		}
		out.push(...pruneDeadEntries(p));
	}
	return out;
}

// ━━ Transport ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

function probeStaleSocket(endpoint: string, timeoutMs = 1500): Promise<"in_use" | "stale" | "timeout"> {
	return new Promise((resolve) => {
		const sock = net.createConnection({ path: endpoint });
		let settled = false;
		const finish = (verdict: "in_use" | "stale" | "timeout") => {
			if (settled) return;
			settled = true;
			try { sock.destroy(); } catch { /* ignore */ }
			resolve(verdict);
		};
		// 250ms proved too tight: under load a live agent's accept backlog can
		// delay the probe connect past the timeout, and bindEndpoint would then
		// unlink a live agent's socket out from under it. 1.5s keeps the
		// "stale" verdict conservative, and a timeout is inconclusive — never
		// treated as stale (bindEndpoint retries once, then refuses to bind).
		const timer = setTimeout(() => finish("timeout"), timeoutMs);
		sock.once("connect", () => {
			clearTimeout(timer);
			finish("in_use");
		});
		sock.once("error", (err: any) => {
			clearTimeout(timer);
			if (err && (err.code === "ECONNREFUSED" || err.code === "ENOENT")) {
				// Nothing listening / file vanished — definitively stale.
				finish("stale");
			} else {
				// Any other error (EACCES, ...) is inconclusive: treat the
				// socket as in use so we never unlink something we don't
				// understand.
				finish("in_use");
			}
		});
	});
}

async function bindEndpoint(
	endpoint: string,
	connHandler: (socket: net.Socket) => void,
): Promise<net.Server> {
	if (process.platform !== "win32" && fs.existsSync(endpoint)) {
		let verdict = await probeStaleSocket(endpoint);
		if (verdict === "timeout") {
			// Inconclusive — the peer may be live but overloaded. Retry once
			// with a longer budget; never unlink on timeout.
			verdict = await probeStaleSocket(endpoint, 3000);
			if (verdict === "timeout") {
				throw new Error(`coms: endpoint busy: unresponsive peer (${endpoint})`);
			}
		}
		if (verdict === "in_use") {
			throw new Error(`coms: endpoint already in use (${endpoint})`);
		}
		if (verdict === "stale") {
			// Linux returns ECONNREFUSED for a live listener whose accept backlog
			// is full — re-probe once before unlinking so a loaded peer's socket
			// is never deleted out from under it.
			await new Promise((r) => setTimeout(r, 250));
			verdict = await probeStaleSocket(endpoint);
			if (verdict === "in_use" || verdict === "timeout") {
				throw new Error(`coms: endpoint already in use (${endpoint})`);
			}
		}
		try {
			fs.unlinkSync(endpoint);
		} catch {
			// best-effort
		}
	}
	return await new Promise<net.Server>((resolve, reject) => {
		const server = net.createServer(connHandler);
		server.once("error", reject);
		server.listen(endpoint, () => {
			server.removeListener("error", reject);
			resolve(server);
		});
	});
}

function readOneLine(socket: net.Socket): Promise<string> {
	return new Promise((resolve, reject) => {
		// Buffer-accumulate (not per-chunk string decode) so a multi-byte UTF-8
		// sequence split across TCP packet boundaries doesn't get corrupted by
		// premature decoding; only the complete framed line is decoded.
		const chunks: Buffer[] = [];
		let total = 0;
		let settled = false;
		const finish = (err: Error | null, line?: string) => {
			if (settled) return;
			settled = true;
			socket.removeListener("data", onData);
			socket.removeListener("error", onError);
			socket.removeListener("close", onClose);
			if (err) reject(err);
			else resolve(line as string);
		};
		const onData = (chunk: Buffer) => {
			chunks.push(chunk);
			total += chunk.length;
			if (total > LINE_CAP_BYTES) {
				finish(new Error("line too large"));
				return;
			}
			// A newline can only land in the chunk that just arrived — the previous
			// call would already have finished otherwise — so only concat (and
			// rescan from the start) once one is actually present, keeping this
			// O(N) overall instead of O(N^2) for a line split across many chunks.
			if (chunk.indexOf(0x0a) < 0) return;
			const buf = Buffer.concat(chunks, total);
			const nl = buf.indexOf(0x0a);
			if (nl >= 0) {
				finish(null, buf.slice(0, nl).toString("utf-8"));
			}
		};
		const onError = (err: Error) => finish(err);
		const onClose = () => finish(new Error("connection closed before line received"));
		socket.on("data", onData);
		socket.once("error", onError);
		socket.once("close", onClose);
	});
}

function sendEnvelope(endpoint: string, envelope: Envelope | Pong | { type: string; msg_id?: string; [k: string]: any }): Promise<any> {
	return new Promise((resolve, reject) => {
		const sock = net.createConnection({ path: endpoint });
		// The reply type that proves the receiver processed THIS envelope: a
		// pong answers a ping, an ack answers everything else, and either must
		// echo our msg_id. Previously any non-nack JSON satisfied the send.
		const expectedReply = envelope.type === "ping" ? "pong" : "ack";
		const expectedMsgId = envelope.msg_id;
		let settled = false;
		let wroteBytes = false;
		const timer = setTimeout(() => {
			const err = new Error("socket operation timeout");
			// A timeout after the bytes went out means "ack lost", not
			// "undelivered" — flag it so coms_send keeps the pending reply.
			if (wroteBytes) (err as any).bytesWritten = true;
			fail(err);
		}, SOCKET_OP_TIMEOUT_MS);
		try { timer.unref?.(); } catch { /* ignore */ }
		const fail = (err: Error) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			try { sock.destroy(); } catch { /* ignore */ }
			reject(err);
		};
		sock.once("error", fail);
		sock.once("connect", async () => {
			// Post-connect errors mean the envelope was (at least partially)
			// written — flag them like the write path below.
			sock.removeListener("error", fail);
			sock.once("error", (err) => {
				if (wroteBytes) (err as any).bytesWritten = true;
				fail(err);
			});
			try {
				sock.write(`${JSON.stringify(envelope)}\n`);
				wroteBytes = true;
				const line = await readOneLine(sock);
				const parsed = JSON.parse(line);
				try { sock.end(); } catch { /* ignore */ }
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				if (parsed && parsed.type === "nack") {
					// Definitive rejection (unauthorized, hops exceeded, ...):
					// the prompt was NOT queued, so no bytesWritten flag —
					// coms_send rolls the pending entry back.
					reject(new Error(parsed.error || "nack"));
				} else if (parsed && parsed.type === expectedReply && parsed.msg_id === expectedMsgId) {
					resolve(parsed);
				} else {
					const err = new Error(`unexpected reply (expected ${expectedReply} for ${expectedMsgId})`);
					(err as any).bytesWritten = true;
					reject(err);
				}
			} catch (err) {
				const e = err instanceof Error ? err : new Error(String(err));
				if (wroteBytes) (e as any).bytesWritten = true;
				fail(e);
			}
		});
	});
}

// One-shot synchronous delivery script for the 'exit' fallback (see the exit
// handler at the bottom of the default export). Reads the framed envelope
// line from stdin, connects to the endpoint, writes it, and waits briefly
// for the ack. Plain CommonJS so it runs under both node and bun via
// `process.execPath -e`. The endpoint arrives via env var, not argv: bun's
// argv layout for `-e` differs from node's (process.argv[1] is not the first
// script argument there).
const EXIT_DELIVER_SCRIPT = `
const net = require("node:net");
const fs = require("node:fs");
const endpoint = process.env.PI_COMS_EXIT_ENDPOINT;
if (!endpoint) process.exit(3);
const line = fs.readFileSync(0, "utf-8");
const sock = net.createConnection({ path: endpoint }, () => { sock.write(line + "\\n"); });
let buf = Buffer.alloc(0);
sock.on("data", (c) => { buf = Buffer.concat([buf, c]); if (buf.indexOf(10) >= 0) process.exit(0); });
sock.on("error", () => process.exit(1));
// Exit as soon as the socket closes (peer hung up) instead of blocking the
// full 4s on a live-but-silent peer. The timer is unref'd so only the socket
// holds the event loop open; it still fires while the socket is open, so a
// peer that never closes still trips the deadline.
sock.on("close", () => process.exit(0));
const timer = setTimeout(() => process.exit(2), 4000);
if (timer.unref) timer.unref();
`;

// ━━ System-prompt frontmatter scan ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

function findSystemPromptPath(argv: string[]): string | null {
	// Prefer --system-prompt (overwrite). Fall back to --append-system-prompt.
	// These flags are pi-builtin (not extension-registered) so we still scan
	// argv directly. First match wins per preference order.
	const scan = (flag: string): string | null => {
		for (let i = 0; i < argv.length; i++) {
			// Accept both `--flag path` and `--flag=path` (pi's parser and
			// coms-net handle both forms).
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

// ━━ Default export ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

export default function (pi: ExtensionAPI) {
	// ━━ Register identity CLI flags so pi's parser accepts them. ━━━━━━━━━
	// Without these, pi 0.73+ rejects the invocation with "Unknown options:
	// --cname, --project, ..." before this extension's hooks ever fire.
	// Agent name flag is `--cname`: pi's harness owns `--name` and resumes it.
	// registerFlagSafe tolerates co-loading with coms-net.ts (same flag names).
	registerFlagSafe(pi, "cname", {
		description: "Override coms agent name (otherwise from frontmatter or auto-generated). Distinct from pi's own --name, which the harness owns and resumes.",
		type: "string",
		default: undefined,
	});
	registerFlagSafe(pi, "purpose", {
		description: "Override agent purpose (otherwise from frontmatter description)",
		type: "string",
		default: undefined,
	});
	registerFlagSafe(pi, "project", {
		description: "Project namespace for peer discovery",
		type: "string",
		default: "default",
	});
	registerFlagSafe(pi, "color", {
		description: "Hex color #RRGGBB (otherwise from frontmatter or palette fallback)",
		type: "string",
		default: undefined,
	});
	registerFlagSafe(pi, "explicit", {
		description: "Hide this agent from auto-discovery; only addressable by exact name",
		type: "boolean",
		default: false,
	});

	// Let module-level registry helpers record security events (they have no
	// pi handle of their own).
	auditFn = (data) => {
		try { pi.appendEntry("coms-log", data); } catch { /* best-effort */ }
	};

	// State containers — shared across all hooks for this extension instance.
	let identity: {
		session_id: string;
		name: string;
		purpose: string;
		color: string;
		project: string;
		explicit: boolean;
		cwd: string;
		model: string;
		endpoint: string;
		// Shared secret written to our registry entry; inbound prompt envelopes
		// must echo it (D1).
		secret: string;
		registryFile: string;
		startedAt: string;
	} | null = null;
	const peerCards: Map<string, AgentCard & { staleCount: number }> = new Map();
	const pendingReplies: Map<string, PendingReply> = new Map();
	const inboundQueue: Map<string, InboundContext> = new Map();
	// FIFO order of msg_ids injected with triggerTurn: agent_end fulfills every
	// anchored still-unfulfilled entry (pi 0.55.0 runs follow-up turns inside
	// one runLoop and emits a single agent_end per batch), so a followUp
	// injected mid-turn can't be answered with another inbound's text while
	// the older one starves.
	const turnQueue: string[] = [];
	// msg_id → expiry ts. Fulfilled prompts stay tombstoned for 1h so a replay
	// (a retransmitted envelope, or an attacker echoing a logged msg_id) is
	// nacked as "duplicate" instead of injecting a second turn. Deliberately
	// NOT cleared on session reset: the replay guard must survive /new.
	const fulfilledMsgIds = new Map<string, number>();
	// msg_ids currently owned by a coms_await call — a second await on the
	// same id would race the first for the single result.
	const awaitingIds = new Set<string>();
	let server: net.Server | null = null;
	let pingTimer: NodeJS.Timeout | null = null;
	let keepaliveTimer: NodeJS.Timeout | null = null;
	// Shared refreshPool latch: both the ping interval and the /coms command
	// run through refreshPoolGuarded so a manual refresh can't overlap a
	// scheduled one.
	let refreshInFlight = false;
	// Bumped on every session start; an old session's refreshPool that is still
	// awaiting peer pings must drop its results instead of writing them into
	// the new session's freshly-cleared state.
	let sessionGen = 0;
	let includeExplicit = false;
	let displayProject: string | null = null;
	let currentCtx: ExtensionContext | null = null;
	// Registry-entry snapshot for the pool widget, refreshed each ping cycle so
	// renderPool never does filesystem I/O inside the TUI render callback.
	let cachedRegistryEntries: RegistryEntry[] = [];
	// (pendingExitDispatches is module-level — see the declaration near auditFn.)

	// The inbound whose prompt is anchored in this session's own branch —
	// not just "oldest pending in the global queue", which would misattribute
	// hops/replies to an unrelated inbound sitting in inboundQueue while this
	// session runs an unrelated turn. Walking the branch (each inbound prompt
	// is injected with details.msg_id) ties the lookup to what's actually
	// driving the current turn. Used by coms_send for hop counting; agent_end
	// fulfills strictly FIFO via turnQueue instead (see below).
	function activeInbound(ctx?: ExtensionContext | null): InboundContext | null {
		const c = ctx ?? currentCtx;
		if (!c) return null;
		const branch = c.sessionManager?.getBranch() ?? [];
		for (let i = branch.length - 1; i >= 0; i--) {
			const entry = branch[i];
			if (!entry) continue;
			// pi 0.55.0 stores extension-injected messages as custom_message
			// entries with details at entry level (session-manager
			// appendCustomMessageEntry); plain message entries carry details on
			// entry.message. Match both shapes.
			let msgId: string | undefined;
			if (entry.type === "custom_message") {
				msgId = (entry as any).details?.msg_id;
			} else if (entry.type === "message" && entry.message) {
				msgId = (entry.message as any).details?.msg_id;
			}
			if (msgId) {
				const inbound = inboundQueue.get(msgId);
				if (inbound && !inbound.fulfilled) return inbound;
			}
		}
		return null;
	}

	// Tombstone helpers for the fulfilled-msg_id replay guard (fulfilledMsgIds).
	function isDuplicateMsgId(msgId: string): boolean {
		const exp = fulfilledMsgIds.get(msgId);
		if (exp === undefined) return false;
		if (Date.now() > exp) {
			fulfilledMsgIds.delete(msgId);
			return false;
		}
		return true;
	}

	function markFulfilled(msgId: string): void {
		// Bound the tombstone map: prune expired entries first, then evict
		// oldest-inserted (Map iteration is insertion-ordered and expiries are
		// monotonic) so a flood of unique msg_ids can't grow it without bound
		// in a long-lived session.
		if (fulfilledMsgIds.size >= MAX_FULFILLED_TOMBSTONES) {
			const now = Date.now();
			for (const [id, exp] of fulfilledMsgIds) {
				if (now > exp) fulfilledMsgIds.delete(id);
			}
			while (fulfilledMsgIds.size >= MAX_FULFILLED_TOMBSTONES) {
				const oldest = fulfilledMsgIds.keys().next().value;
				if (oldest === undefined) break;
				fulfilledMsgIds.delete(oldest);
			}
		}
		fulfilledMsgIds.set(msgId, Date.now() + 3_600_000);
	}

	// Phase A stub handlers — each just acks valid envelopes. Phase B replaces these.
	function ackOk(socket: net.Socket, msg_id: string): void {
		try {
			socket.write(`${JSON.stringify({ type: "ack", msg_id })}\n`);
		} catch {
			// ignore
		}
		try { socket.end(); } catch { /* ignore */ }
	}

	function nack(socket: net.Socket, msg_id: string, error: string): void {
		try {
			socket.write(`${JSON.stringify({ type: "nack", msg_id, error })}\n`);
		} catch {
			// ignore
		}
		try { socket.end(); } catch { /* ignore */ }
	}

	function handlePrompt(socket: net.Socket, env: PromptEnvelope): void {
		// 1. Shared-secret auth: the sender must echo the secret from this
		// agent's own registry entry (protected by the 0700 registry dir). Nack
		// mismatches without ever triggering a turn. Compared timing-safe so a
		// same-user attacker can't probe the secret byte-by-byte.
		if (typeof env.secret !== "string" || !identity || !secretEqual(env.secret, identity.secret)) {
			nack(socket, env.msg_id, "unauthorized");
			return;
		}

		// 2. Hop limit check — require a non-negative integer: NaN slips past a
		// plain `>=` comparison and negative hops bypass the limit, either of
		// which lets a peer relay forever.
		if (!Number.isInteger(env.hops) || env.hops < 0 || env.hops >= MAX_HOPS) {
			nack(socket, env.msg_id, "hops exceeded");
			return;
		}

		// 3. Prompt-envelope-specific field validation: undefined/object values
		// would interpolate as "undefined"/"[object Object]" into the injected
		// message and burn an agent turn on garbage.
		if (typeof env.prompt !== "string" || typeof env.sender_name !== "string" || typeof env.sender_cwd !== "string") {
			nack(socket, env.msg_id, "malformed prompt envelope");
			return;
		}
		// Per-field size cap: LINE_CAP_BYTES (16MB) bounds the transport frame,
		// but a prompt that large would burn the receiver's whole context
		// window — and 256 queued ones would pin ~4GB of state.
		if (Buffer.byteLength(env.prompt, "utf8") > MAX_PROMPT_BYTES) {
			nack(socket, env.msg_id, "prompt too large");
			return;
		}
		// sender_endpoint is peer-controlled yet becomes the connect() target
		// for the response (and the exit-fallback child env): bound its length
		// so a peer can't point us at an arbitrary oversized socket path.
		// Confinement to the known socket roots is deliberately NOT enforced —
		// a legitimate relay may run under a different PI_COMS_DIR.
		if (Buffer.byteLength(env.sender_endpoint, "utf8") > 200) {
			nack(socket, env.msg_id, "malformed prompt envelope");
			return;
		}
		// response_schema must be a plain object of bounded size (mirrors the
		// coms_send sender-side rule): an array would be silently treated as
		// "parse the reply as JSON" at agent_end, and the blob is stored per
		// inbound and persisted into the session branch via details, so the
		// 16MB transport cap is far too loose for it.
		if (
			env.response_schema != null &&
			(typeof env.response_schema !== "object" || Array.isArray(env.response_schema))
		) {
			nack(socket, env.msg_id, "malformed prompt envelope");
			return;
		}
		// JSON.stringify can throw even on an acyclic value — a deeply nested
		// schema trips V8's recursive serialization stack (RangeError) before
		// any byte count exists. The envelope arriving via JSON.parse rules
		// out cycles but NOT deep nesting (parse and stringify have separate
		// depth budgets), so measure inside try and treat an unserializable
		// schema as a malformed envelope.
		if (env.response_schema != null) {
			let schemaBytes: number;
			try {
				schemaBytes = Buffer.byteLength(JSON.stringify(env.response_schema), "utf8");
			} catch {
				nack(socket, env.msg_id, "malformed prompt envelope");
				return;
			}
			if (schemaBytes > MAX_RESPONSE_SCHEMA_BYTES) {
				nack(socket, env.msg_id, "malformed prompt envelope");
				return;
			}
		}

		// 4. Replay/duplicate guard: a msg_id already queued — or fulfilled
		// within the tombstone window — must not inject a second turn.
		if (inboundQueue.has(env.msg_id) || isDuplicateMsgId(env.msg_id)) {
			nack(socket, env.msg_id, "duplicate");
			return;
		}

		// 5. Queue cap: inboundQueue entries are only removed on agent_end (or
		// by keepalive pruning), so a flooding peer must not grow it unbounded.
		if (inboundQueue.size >= MAX_INBOUND) {
			nack(socket, env.msg_id, "queue full");
			return;
		}

		// 6. Insert into inbound queue
		const conversationId = typeof env.conversation_id === "string" ? env.conversation_id : null;
		const inbound: InboundContext = {
			msg_id: env.msg_id,
			hops: env.hops,
			sender_endpoint: env.sender_endpoint,
			sender_session: env.sender_session,
			secret: env.secret,
			conversation_id: conversationId,
			response_schema: env.response_schema ?? null,
			created_at: Date.now(),
			fulfilled: false,
		};
		inboundQueue.set(env.msg_id, inbound);

		// 7. Inject as a follow-up message into the receiver's next turn.
		// sender_name/sender_cwd are peer-controlled: strip control characters
		// (ANSI escape injection into the TUI/model context) and cap length
		// before interpolation.
		const senderName = sanitizePeerText(env.sender_name, "unknown", 64);
		const senderCwd = sanitizePeerText(env.sender_cwd, "", 256);
		try {
			pi.sendMessage(
				{
					customType: "coms-inbound",
					content: `[from ${senderName} @ ${senderCwd}]\n\n${env.prompt}`,
					display: true,
					details: {
						msg_id: env.msg_id,
						sender_session: env.sender_session,
						conversation_id: conversationId,
						response_schema: env.response_schema ?? null,
					},
				},
				{ deliverAs: "followUp", triggerTurn: true },
			);
		} catch (err) {
			// If sendMessage fails, drop the inbound and nack.
			inboundQueue.delete(env.msg_id);
			nack(socket, env.msg_id, "internal error");
			return;
		}
		// Record injection order: agent_end fulfills strictly FIFO.
		turnQueue.push(env.msg_id);

		// 8. Ack + audit log
		ackOk(socket, env.msg_id);
		try {
			pi.appendEntry("coms-log", {
				event: "inbound_prompt",
				msg_id: env.msg_id,
				sender: env.sender_session,
				hops: env.hops,
			});
		} catch {
			// best-effort
		}
	}

	// Context usage can be NaN (e.g. 0/0 before any tokens are counted);
	// clamp non-finite values to 0 so agent cards never carry NaN/Infinity,
	// which would later crash widget rendering ("#".repeat(NaN) → RangeError).
	function safeContextPct(ctx: { getContextUsage?: () => { percent?: number | null } | null | undefined } | null | undefined): number {
		const p = ctx?.getContextUsage?.()?.percent;
		return typeof p === "number" && Number.isFinite(p) ? Math.round(p) : 0;
	}

	function handleResponse(socket: net.Socket, env: ResponseEnvelope): void {
		const pending = pendingReplies.get(env.msg_id);
		if (pending) {
			// Response auth: the responder must echo the SAME secret the
			// original prompt carried (this agent's registry secret). The
			// prompt receiver already verified it; echoing proves the responder
			// actually saw the prompt envelope — a same-user attacker who only
			// harvested a msg_id from logs cannot forge the response.
			if (
				typeof env.secret !== "string" ||
				typeof pending.expected_secret !== "string" ||
				!secretEqual(env.secret, pending.expected_secret)
			) {
				try {
					pi.appendEntry("coms-log", { event: "forged_response", msg_id: env.msg_id });
				} catch {
					// best-effort
				}
				nack(socket, env.msg_id, "unauthorized");
				return;
			}
			// Receiver-side response cap: the transport frame allows up to
			// LINE_CAP_BYTES (16MB), but the response lands verbatim in the
			// caller's coms_get/coms_await tool output — cap it like
			// MAX_PROMPT_BYTES so a peer can't flood the caller's context.
			let respBytes = 0;
			try {
				const s = typeof env.response === "string" ? env.response : JSON.stringify(env.response);
				respBytes = Buffer.byteLength(s ?? "", "utf8");
			} catch {
				// Unserializable payload — treat as empty for sizing.
			}
			if (respBytes > MAX_RESPONSE_BYTES) {
				// Resolve the local pending entry BEFORE nacking: dropping the
				// response without settling would strand the caller's coms_await
				// until its full timeout (and the responder would re-deliver at
				// process exit). The promise is single-settle, so a later
				// duplicate delivery re-resolving is a no-op.
				if (pending.timer) {
					try { clearTimeout(pending.timer); } catch { /* ignore */ }
					pending.timer = null;
				}
				pending.result = { response: null, error: "response too large" };
				try {
					pending.resolve(pending.result);
				} catch {
					// ignore
				}
				nack(socket, env.msg_id, "response too large");
				return;
			}
			if (pending.timer) {
				try { clearTimeout(pending.timer); } catch { /* ignore */ }
				pending.timer = null;
			}
			// Coerce error to string-or-null: a non-string value would render
			// as "[object Object]" in coms_get's output text.
			pending.result = { response: env.response, error: typeof env.error === "string" ? env.error : null };
			try {
				pending.resolve(pending.result);
			} catch {
				// ignore
			}
			// Note: do NOT delete the entry here — coms_get poll may still want
			// it. But cap retained completed entries (otherwise kept until the
			// keepalive sweep) so chatty agents can't grow the map without
			// bound: evict oldest completed entries first.
			let completed = 0;
			for (const e of pendingReplies.values()) {
				if (e.result) completed++;
			}
			if (completed > MAX_COMPLETED_REPLIES) {
				const done = [...pendingReplies.entries()]
					.filter(([, e]) => e.result)
					.sort((a, b) => a[1].created_at - b[1].created_at);
				for (const [mid] of done.slice(0, completed - MAX_COMPLETED_REPLIES)) {
					pendingReplies.delete(mid);
				}
			}
		} else {
			try {
				pi.appendEntry("coms-log", { event: "orphan_response", msg_id: env.msg_id });
			} catch {
				// best-effort
			}
		}
		ackOk(socket, env.msg_id);
	}

	function handlePing(socket: net.Socket, env: PingEnvelope): void {
		const ctx = currentCtx;
		const ident = identity;
		const pct = safeContextPct(ctx);
		const card: AgentCard = {
			name: ident?.name ?? "unknown",
			purpose: ident?.purpose ?? "",
			model: ctx?.model?.id ?? ident?.model ?? "unknown",
			color: ident?.color ?? "#36F9F6",
			context_used_pct: pct,
			queue_depth: inboundQueue.size,
		};
		const pong: Pong = { type: "pong", msg_id: env.msg_id, agent_card: card };
		try {
			socket.write(`${JSON.stringify(pong)}\n`);
		} catch {
			// ignore
		}
		try { socket.end(); } catch { /* ignore */ }
	}

	function isValidEnvelope(obj: any): obj is Envelope {
		return (
			obj &&
			typeof obj === "object" &&
			typeof obj.type === "string" &&
			typeof obj.msg_id === "string" &&
			// ULIDs are 26 chars; cap well above that so a near-16MB msg_id
			// can't become a Map key in inboundQueue/turnQueue/fulfilledMsgIds
			// or get echoed raw into acks/nacks and audit entries.
			obj.msg_id.length <= 128 &&
			typeof obj.sender_session === "string" &&
			typeof obj.sender_endpoint === "string"
		);
	}

	function connHandler(socket: net.Socket): void {
		// Idle clients that never send a complete framed line would otherwise
		// hold the socket (and its fd) open forever — bound it.
		socket.setTimeout(SOCKET_OP_TIMEOUT_MS);
		socket.once("timeout", () => {
			try { socket.destroy(); } catch { /* ignore */ }
		});
		// Buffer-accumulate (not per-chunk string decode) so a multi-byte UTF-8
		// sequence split across TCP packet boundaries doesn't get corrupted by
		// premature decoding; only the complete framed line is decoded.
		const chunks: Buffer[] = [];
		let total = 0;
		let handled = false;
		const onData = (chunk: Buffer) => {
			if (handled) return;
			chunks.push(chunk);
			total += chunk.length;
			if (total > LINE_CAP_BYTES) {
				handled = true;
				socket.removeListener("data", onData);
				nack(socket, "", "malformed envelope");
				return;
			}
			// Same O(N) vs O(N^2) reasoning as readOneLine: only concat once the
			// newline has actually arrived in the latest chunk.
			if (chunk.indexOf(0x0a) < 0) return;
			const buf = Buffer.concat(chunks, total);
			const nl = buf.indexOf(0x0a);
			if (nl < 0) return;
			handled = true;
			socket.removeListener("data", onData);
			const line = buf.slice(0, nl).toString("utf-8");
			let parsed: any;
			try {
				parsed = JSON.parse(line);
			} catch {
				nack(socket, "", "malformed envelope");
				return;
			}
			if (!isValidEnvelope(parsed)) {
				const mid = parsed && typeof parsed.msg_id === "string" ? parsed.msg_id : "";
				nack(socket, mid, "malformed envelope");
				return;
			}
			try {
				if (parsed.type === "prompt") {
					handlePrompt(socket, parsed as PromptEnvelope);
				} else if (parsed.type === "response") {
					handleResponse(socket, parsed as ResponseEnvelope);
				} else if (parsed.type === "ping") {
					handlePing(socket, parsed as PingEnvelope);
				} else {
					nack(socket, parsed.msg_id, "unknown type");
				}
			} catch {
				nack(socket, parsed.msg_id, "internal error");
			}
		};
		socket.on("data", onData);
		socket.once("error", () => {
			// connection failures during handshake — drop quietly
			try { socket.destroy(); } catch { /* ignore */ }
		});
	}

	// ━━ session_start ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
	let initializing = false;
	// Shared latch for session_start AND session_shutdown: a shutdown racing a
	// start would run cleanShutdown against half-built state and null a live
	// identity being rebuilt. Bounded wait — a wedged init must not spin the
	// poll loop forever; on timeout we proceed and audit loudly.
	async function acquireInitLatch(waiter: string): Promise<void> {
		const deadline = Date.now() + INIT_LATCH_TIMEOUT_MS;
		while (initializing) {
			if (Date.now() >= deadline) {
				try {
					pi.appendEntry("coms-log", { event: "init_latch_timeout", waiter });
				} catch { /* best-effort */ }
				break;
			}
			await new Promise((resolve) => setTimeout(resolve, 25));
		}
		initializing = true;
	}
	const onSessionStart = async (_event: unknown, ctx: ExtensionContext) => {
		// This story is POSIX-scoped: the Windows named-pipe branch has no
		// per-user ACL equivalent of the 0700 socket dir (INV-2), so fail fast
		// with a clear message instead of running unauthenticated IPC.
		if (process.platform === "win32") {
			ctx.ui?.notify?.("📡 coms: Windows named pipes are not supported — coms is POSIX-only in this release", "error");
			return;
		}
		// session_start can fire back-to-back on this same extension instance
		// (session switch + /new, or print/json mode where session_shutdown may
		// never have fired — pi-mono #2576). The handler awaits cleanShutdown()
		// and bindEndpoint(), so without this latch two invocations both pass
		// the identity/server check before either bind completes → two bound
		// servers and orphaned ping/keepalive intervals.
		await acquireInitLatch("session_start");
		const finishInit = () => { initializing = false; };
		// Tear down any live prior session and reset all per-session state, or
		// the shuttingDown latch stays set and the new session's socket/registry
		// are never cleaned up, and stale maps leak.
		if (!shuttingDown && (identity || server)) {
			// A second session_start superseding a live session — log it so
			// teardowns are attributable in the audit trail.
			try {
				pi.appendEntry("coms-log", { event: "session_superseded", had_identity: !!identity, had_server: !!server });
			} catch { /* best-effort */ }
			await cleanShutdown();
		}
		shuttingDown = false;
		identity = null;
		peerCards.clear();
		// Resolve (don't just drop) every pending reply: an in-flight
		// coms_await holding entry.promise would otherwise hang until its own
		// timeout even though the session it belongs to is gone.
		for (const entry of pendingReplies.values()) {
			if (entry.timer) {
				try { clearTimeout(entry.timer); } catch { /* ignore */ }
				entry.timer = null;
			}
			if (!entry.result) {
				entry.result = { error: "session reset" };
				try { entry.resolve(entry.result); } catch { /* ignore */ }
			}
		}
		pendingReplies.clear();
		inboundQueue.clear();
		turnQueue.length = 0;
		// Deliberately abandon dispatches left by a dead session. They target
		// the original senders' endpoints (not ours — cleanShutdown unlinks
		// only our own socket) and might still be deliverable, but a reset
		// means this session's turn context is gone, so senders observe a
		// timeout instead. The drop also bounds the blocking spawnSync (~5s)
		// each retained entry costs at process exit.
		pendingExitDispatches.length = 0;
		awaitingIds.clear();
		// fulfilledMsgIds deliberately NOT cleared — the replay tombstones must
		// survive a session switch (/new), or a replayed msg_id from before the
		// reset would inject a fresh turn.
		server = null;
		pingTimer = null;
		keepaliveTimer = null;
		refreshInFlight = false;
		sessionGen++;
		// Pool-filter state belongs to the session: reset it here (not only on
		// the success path) so a failed init doesn't leak the previous
		// session's filter into the next one.
		displayProject = null;
		includeExplicit = false;
		cachedRegistryEntries = [];

		applyExtensionDefaults(import.meta.url, ctx);
		currentCtx = ctx;

		// 1. Resolve identity from CLI flags > frontmatter > defaults.
		const flags = readCliFlags(pi);
		const fm = readFrontmatterFromArgv(process.argv);
		const project = flags.project || "default";
		if (!isSafePathComponent(project)) {
			ctx.ui?.notify?.(`📡 coms: invalid --project value "${project}"`, "error");
			finishInit();
			return;
		}
		const explicit = flags.explicit === true;
		const session_id = ulid();

		const defaultName = `agent-${session_id.slice(-6)}`;
		const desiredName = flags.name || fm.name || defaultName;
		if (!isSafePathComponent(desiredName)) {
			ctx.ui?.notify?.(`📡 coms: invalid agent name "${desiredName}"`, "error");
			finishInit();
			return;
		}
		let name = resolveUniqueName(project, desiredName);
		if (name !== desiredName) {
			try {
				pi.appendEntry("coms-log", { event: "name_collision", desired: desiredName, assigned: name, project });
			} catch {
				// best-effort
			}
		}
		const purpose = flags.purpose || fm.description || "";

		// Color: validate at every level; fall through invalid hex to next.
		// Order: --color CLI flag > frontmatter color > deterministic fallback.
		let color = fallbackColor(session_id);
		if (fm.color && isValidHex(fm.color)) {
			color = fm.color;
		}
		if (flags.color && isValidHex(flags.color)) {
			color = flags.color;
		}

		const endpoint = makeEndpoint(session_id);
		const cwd = ctx.cwd || process.cwd();
		const model = ctx.model?.id ?? "unknown";

		// 2. Ensure storage dirs exist.
		try {
			fs.mkdirSync(projectAgentsDir(project), { recursive: true });
			// (POSIX-only here — the handler already returned on win32.)
			// mkdir dirname(endpoint) (not COMS_DIR/sockets) so the tmp-dir
			// fallback from makeEndpoint gets created too; chmod 0700 keeps
			// sockets private to this user in the shared tmp dir.
			const endpointDir = path.dirname(endpoint);
			fs.mkdirSync(endpointDir, { recursive: true, mode: 0o700 });
			// recursive mkdir's mode only applies to dirs it actually creates,
			// so chmod explicitly: a pre-existing dir (left by an older
			// version or created manually) could otherwise stay world-accessible
			// and expose the socket in the shared tmp dir (INV-2).
			try { fs.chmodSync(endpointDir, 0o700); } catch { /* best-effort */ }
			try { fs.chmodSync(COMS_DIR, 0o700); } catch { /* best-effort */ }
		} catch (err) {
			ctx.ui?.notify?.(`📡 coms: failed to create dirs — ${err instanceof Error ? err.message : String(err)}`, "error");
			finishInit();
			return;
		}

		// 3. Bind the endpoint.
		try {
			server = await bindEndpoint(endpoint, connHandler);
		} catch (err) {
			ctx.ui?.notify?.(`📡 coms: bind failed — ${err instanceof Error ? err.message : String(err)}`, "error");
			finishInit();
			return;
		}
		// bindEndpoint only guards the listen phase; once it resolves the server
		// has no 'error' listener, and net.Server re-throws an unhandled 'error'
		// event (e.g. EMFILE on accept), crashing the whole process. Attach a
		// persistent listener that logs and keeps the server alive.
		server.on("error", (err) => {
			try {
				pi.appendEntry("coms-log", { event: "server_error", error: err.message });
			} catch { /* best-effort */ }
		});

		// 4. Build + write registry entry atomically. Two agents launched
		// concurrently with the same --cname can both resolveUniqueName() to the
		// same free name and then race the exclusive write; on EEXIST re-resolve
		// and retry a bounded number of times instead of leaving the agent with
		// no coms at all.
		const secret = crypto.randomUUID();
		const startedAt = nowIso();
		let registryFile: string | null = null;
		for (let attempt = 0; attempt < 3; attempt++) {
			if (attempt > 0) {
				name = resolveUniqueName(project, desiredName);
			}
			const entry: RegistryEntry = {
				session_id,
				name,
				purpose,
				model,
				color,
				pid: process.pid,
				endpoint,
				cwd,
				started_at: startedAt,
				explicit,
				version: 1,
				// Shared secret peers must echo in prompt envelopes (D1); the
				// registry dir is chmod 0700, so only same-user agents can read it.
				secret,
				// Seed the heartbeat at registration so a process that hangs before
				// its first keepalive still becomes stale-detectable by peers.
				heartbeat_at: startedAt,
			};
			try {
				registryFile = writeRegistryAtomic(entry, project, { exclusive: true });
				break;
			} catch (err) {
				const code = (err as NodeJS.ErrnoException).code;
				if (code === "EEXIST" && attempt < 2) {
					// A corrupt/unparseable <name>.json is invisible to
					// resolveUniqueName (readAllRegistryEntries skips it) but
					// still blocks the exclusive create. Remove it like
					// pruneDeadEntries removes dead entries so one bad file
					// can't permanently squat a name.
					try {
						const p = registryFilePath(project, name);
						const parsed = JSON.parse(fs.readFileSync(p, "utf-8"));
						if (!parsed || typeof parsed.session_id !== "string" || !isSafePathComponent(parsed.name)) {
							try { fs.unlinkSync(p); } catch { /* best-effort */ }
						}
					} catch {
						try { fs.unlinkSync(registryFilePath(project, name)); } catch { /* best-effort */ }
					}
					continue;
				}
				ctx.ui?.notify?.(`📡 coms: registry write failed — ${err instanceof Error ? err.message : String(err)}`, "error");
				try { server?.close(); } catch { /* ignore */ }
				// bindEndpoint already created the socket file, but identity isn't
				// assigned until after this try succeeds — so cleanShutdown (which
				// unlinks identity.endpoint) won't reach it. Remove the stale .sock
				// here (POSIX-only — the handler already returned on win32).
				try { fs.unlinkSync(endpoint); } catch { /* ignore */ }
				finishInit();
				return;
			}
		}

		identity = {
			session_id,
			name,
			purpose,
			color,
			project,
			explicit,
			cwd,
			model,
			endpoint,
			secret,
			registryFile: registryFile!,
			startedAt,
		};
		includeExplicit = false;
		displayProject = project;

		// 5. Audit log: boot.
		try {
			pi.appendEntry("coms-log", { event: "boot", session_id, name, project });
		} catch {
			// best-effort
		}

		// 6. Surface presence in the UI + install the live pool widget.
		try {
			ctx.ui.setStatus("coms", `📡 ${name}@${project}`);
			installPoolWidget(ctx);
			ctx.ui.notify(
				`📡 coms ready · ${name}@${project} · ${displayProject ?? project} pool`,
				"info",
			);
		} catch {
			// hasUI may be false in some contexts — non-fatal.
		}

		// 7. Start ping + keepalive cycles.
		pingTimer = setInterval(() => {
			refreshPoolGuarded().catch(() => {});
		}, PING_INTERVAL_MS);
		try { (pingTimer as any).unref?.(); } catch { /* ignore */ }
		keepaliveTimer = setInterval(() => {
			if (!identity) return;
			try {
				const ctx = currentCtx;
				// Detect missing-registry BEFORE writing so the self_heal audit only
				// fires when something actually went wrong (file unlinked under us).
				const missingBeforeWrite = !fs.existsSync(identity.registryFile);
				if (!missingBeforeWrite) {
					// Registry file exists — verify we still own it before overwriting.
					// If it was unlinked and re-claimed by another session between our
					// last heartbeat and this one, existing.session_id won't match ours;
					// writing anyway would hijack the other session's registration and
					// cause split-brain routing.
					try {
						const existing = JSON.parse(fs.readFileSync(identity.registryFile, "utf-8")) as RegistryEntry;
						// Only a *valid* foreign session_id declares a conflict. A file
						// that parses but lacks session_id (partial write flushed as
						// valid JSON, e.g. "{}") yields undefined — treating that as a
						// conflict would falsely tear down the live agent. Missing/
						// malformed session_id means the entry is not authoritative;
						// fall through and self-heal by overwriting below. (JSON null/
						// primitives throw on .session_id access → caught → self-heal.)
						if (existing && typeof existing.session_id === "string" && existing.session_id !== identity.session_id) {
							pi.appendEntry("coms-log", {
								event: "heartbeat_conflict",
								session_id: identity.session_id,
								conflicting_session_id: existing.session_id,
								name: identity.name,
							});
							// Our name was reclaimed by another session. This keepalive
							// can't recover it (we deliberately don't hijack back), and
							// merely stopping the interval would leave the socket server
							// bound: the agent could still receive messages on a stale
							// endpoint while being unregistered — a zombie. Tear coms
							// down instead. cleanShutdown clears all timers, closes the
							// server, unlinks the socket, and removes our registry entry
							// (session_id-guarded, so the reclaiming session's entry is
							// never touched); it does not exit the host process.
							try {
								currentCtx?.ui?.notify?.(
									`📡 coms: name "${identity.name}" was reclaimed by another session — coms torn down`,
									"error",
								);
							} catch { /* best-effort */ }
							void cleanShutdown();
							return;
						}
					} catch {
						// Corrupt/unreadable entry — safe to self-heal by overwriting below.
					}
				}
				const live: RegistryEntry = {
					session_id: identity.session_id,
					name: identity.name,
					purpose: identity.purpose,
					model: ctx?.model?.id ?? identity.model,
					color: identity.color,
					pid: process.pid,
					endpoint: identity.endpoint,
					cwd: identity.cwd,
					started_at: identity.startedAt,
					explicit: identity.explicit,
					version: 1,
					secret: identity.secret,
					context_used_pct: safeContextPct(ctx),
					queue_depth: inboundQueue.size,
					heartbeat_at: nowIso(),
				};
				if (missingBeforeWrite) {
					// Self-heal: the file was missing at the top of this cycle. A
					// foreign session could claim the name between that existsSync
					// and our write, so create EXCLUSIVELY — a plain rename would
					// hijack the just-registered entry. EEXIST means someone
					// claimed it; the next cycle's ownership check tears us down
					// if it isn't ours.
					try {
						writeRegistryAtomic(live, identity.project, { exclusive: true });
						pi.appendEntry("coms-log", { event: "self_heal", session_id: identity.session_id, reason: "registry file missing" });
					} catch (err) {
						if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
					}
				} else {
					// Live-status refresh: the file exists and passed the ownership
					// check above, so a plain atomic overwrite is safe (and bumps
					// mtime).
					writeRegistryAtomic(live, identity.project);
				}

				// Prune expired pending replies so long-lived sessions don't leak
				// entries whose timeout already fired (or that were resolved but
				// never cleaned up).
				const now = Date.now();
				for (const [mid, entry] of pendingReplies.entries()) {
					const limit = (entry.timeout_ms ?? TIMEOUT_MS) + 60_000;
					// Entries under a coms_await deadline measure from the await's
					// start; the default path (background timer from coms_send)
					// measures from the message's created_at.
					const base = entry.await_started_at ?? entry.created_at;
					if (now - base > limit) {
						pendingReplies.delete(mid);
					}
				}

				// Prune inbound entries whose turn never completed (session
				// abort, or sendMessage no-op after ack) — they are otherwise
				// only removed in agent_end and would live until process exit.
				// TURN_DEADLINE_MS is the receiver-side deadline (TIMEOUT_MS is
				// sender-side); stale entries also drop out of turnQueue when
				// agent_end skips msg_ids no longer in inboundQueue.
				for (const [mid, inbound] of inboundQueue.entries()) {
					if (!inbound.fulfilled && now - inbound.created_at > TURN_DEADLINE_MS) {
						inboundQueue.delete(mid);
						// Tombstone like the fulfill path does, or a replayed
						// envelope with this msg_id passes the duplicate check
						// and injects a fresh turn.
						markFulfilled(mid);
					}
				}
			} catch { /* best-effort */ }
		}, KEEPALIVE_INTERVAL_MS);
		try { (keepaliveTimer as any).unref?.(); } catch { /* ignore */ }

		// Kick one ping cycle immediately so the widget populates fast.
		// Through the same latch as the interval/coms paths so a slow first
		// refresh can't overlap the first scheduled tick.
		refreshPoolGuarded().catch(() => {});
		finishInit();
	};
	pi.on("session_start", (event, ctx) => {
		// An unexpected throw mid-init must not wedge the initializing latch —
		// every future session_start would spin forever waiting for it.
		void onSessionStart(event, ctx).catch((err) => {
			initializing = false;
			try {
				pi.appendEntry("coms-log", {
					event: "session_start_error",
					error: err instanceof Error ? err.message : String(err),
				});
			} catch { /* best-effort */ }
		});
	});

	// ━━ Helpers used by tools ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

	async function pingPeer(endpoint: string): Promise<AgentCard | null> {
		if (!identity) return null;
		const env: PingEnvelope = {
			type: "ping",
			msg_id: ulid(),
			sender_session: identity.session_id,
			sender_endpoint: identity.endpoint,
			hops: 0,
			timestamp: nowIso(),
		};
		try {
			const resp = await sendEnvelope(endpoint, env);
			if (resp && resp.type === "pong" && resp.agent_card) {
				return resp.agent_card as AgentCard;
			}
		} catch {
			// ignore — peer unreachable
		}
		return null;
	}

	// ━━ Pool widget rendering ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
	function renderPool(width: number, theme: Theme): string[] {
		// Read the ping-cycle snapshot instead of scanning the registry on every
		// frame: this runs inside the TUI render callback, where synchronous
		// directory reads + JSON.parse per redraw/resize would stutter the UI.
		const registryEntries = cachedRegistryEntries;

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
		const seenSessions = new Set<string>();

		for (const [sid, card] of peerCards.entries()) {
			if (identity && sid === identity.session_id) continue;
			seenSessions.add(sid);
			rows.push({
				name: card.name,
				model: card.model,
				color: card.color,
				purpose: card.purpose,
				pct: card.context_used_pct,
				pending: false,
				stale: (card.staleCount ?? 0) >= 3,
			});
		}

		// Registry-only entries that aren't yet in peerCards → pending
		const seenNames = new Set(rows.map((r) => r.name));
		for (const entry of registryEntries) {
			if (identity && entry.session_id === identity.session_id) continue;
			if (!includeExplicit && entry.explicit) continue;
			if (seenSessions.has(entry.session_id)) continue;
			if (seenNames.has(entry.name)) continue;
			rows.push({
				name: entry.name,
				model: entry.model,
				color: entry.color,
				purpose: entry.purpose,
				pct: null,
				pending: true,
				stale: false,
			});
		}

		// Border helpers — sandwich the body with single-line box-drawing rules
		// so the widget reads as its own block above the minimal footer. The
		// top border carries a branded ` coms ` tag so the widget reads as its
		// own block; bottom border stays a plain rule for minimalism.
		const safeWidth = Math.max(0, width);
		let topBorder: string;
		let bottomBorder: string;
		if (safeWidth < 12) {
			topBorder = theme.fg("dim", "━".repeat(safeWidth));
			bottomBorder = theme.fg("dim", "━".repeat(safeWidth));
		} else {
			const left = theme.fg("dim", "┏━") + theme.fg("border", " coms ");
			const leftFill = theme.fg("dim", "━");
			// Visible cells of the left tag "┏━ coms ━": 2 ("┏━") + 6 (" coms ") + 1 ("━").
			const LEFT_TAG_CELLS = 9;
			const nameLen = identity ? identity.name.length : 0;
			// rightTag renders " " + name + " ━" = nameLen + 3 visible cells.
			const rightTagVisLen = identity ? nameLen + 3 : 0;
			const remaining = safeWidth - LEFT_TAG_CELLS - rightTagVisLen - 1 /* "┓" */;
			if (identity && remaining >= 1) {
				const rightTag =
					theme.fg("dim", " ") +
					hexFg(identity.color, identity.name) +
					theme.fg("dim", " ━");
				const middle = theme.fg("dim", "━".repeat(remaining));
				const right = theme.fg("dim", "┓");
				topBorder = left + leftFill + middle + rightTag + right;
			} else {
				const fallbackRemaining = Math.max(0, safeWidth - LEFT_TAG_CELLS);
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
			ctx.ui.setWidget("coms-pool", (_tui, theme) => ({
				invalidate() {},
				render(width: number): string[] {
					return renderPool(width, theme);
				},
			}), { placement: "belowEditor" });
		} catch {
			// non-fatal
		}
	}

	// ━━ Ping cycle ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
	async function refreshPool(): Promise<void> {
		if (!identity) return;
		const gen = sessionGen;
		const projectFilter = displayProject ?? identity.project;
		const live = projectFilter === "*"
			? pruneDeadEntriesAllProjects()
			: pruneDeadEntries(projectFilter);
		// Snapshot for renderPool, which must not touch the filesystem inside
		// the TUI render callback.
		cachedRegistryEntries = live;

		const peers = live.filter((e) =>
			e.session_id !== identity!.session_id && (includeExplicit || !e.explicit),
		);

		const results = await Promise.allSettled(peers.map(async (peer) => {
			const pingEnv: PingEnvelope = {
				type: "ping",
				msg_id: ulid(),
				sender_session: identity!.session_id,
				sender_endpoint: identity!.endpoint,
				hops: 0,
				timestamp: nowIso(),
			};
			const reply = await sendEnvelope(peer.endpoint, pingEnv);
			return { peer, pong: reply as Pong };
		}));

		// A session switch mid-refresh cleared peerCards/cachedRegistryEntries;
		// writing these stale results now would tear the new session's state.
		if (gen !== sessionGen) return;

		const seenSessions = new Set<string>();
		let changed = false;

		for (const r of results) {
			if (r.status === "fulfilled" && r.value.pong && r.value.pong.agent_card) {
				const { peer, pong } = r.value;
				seenSessions.add(peer.session_id);
				const card = pong.agent_card as AgentCard;
				// Peer-controlled fields: a non-string name/model/purpose/color
				// would throw inside renderPool (padEnd/startsWith) and crash the
				// TUI; clamp pct so the bar math never sees NaN or out-of-range
				// values. The session stays in seenSessions either way (the peer
				// is alive), so a previous good card isn't marked stale over one
				// bad pong.
				if (
					typeof card.name !== "string" ||
					typeof card.model !== "string" ||
					typeof card.purpose !== "string" ||
					typeof card.color !== "string"
				) {
					continue;
				}
				const prev = peerCards.get(peer.session_id);
				const next = {
					...card,
					// The ping path needs no secret, so card fields are
					// unauthenticated peer input rendered raw by renderPool:
					// strip control chars (ANSI injection into the TUI) and cap
					// length. Color keeps its isValidHex gate in hexFg; pct is
					// clamped to [0,100] + rounded like safeContextPct so a
					// peer's 1e21/-50/long-decimal can't reach the widget label.
					name: sanitizePeerText(card.name, "unknown", 64),
					model: sanitizePeerText(card.model, "unknown", 64),
					purpose: sanitizePeerText(card.purpose, "", 256),
					color: sanitizePeerText(card.color, "", 32),
					context_used_pct:
						typeof card.context_used_pct === "number" && Number.isFinite(card.context_used_pct)
							? Math.max(0, Math.min(100, Math.round(card.context_used_pct)))
							: 0,
					staleCount: 0,
				};
				if (!prev || JSON.stringify({ ...prev, staleCount: 0 }) !== JSON.stringify(next)) {
					peerCards.set(peer.session_id, next);
					changed = true;
				}
			}
		}

		for (const [sid, card] of peerCards.entries()) {
			if (identity && sid === identity.session_id) continue;
			if (!seenSessions.has(sid)) {
				card.staleCount = (card.staleCount ?? 0) + 1;
				if (card.staleCount > 6) {
					peerCards.delete(sid);
				}
				changed = true;
			}
		}

		if (changed && currentCtx?.hasUI) {
			installPoolWidget(currentCtx);
		}
	}

	// Both the ping interval and the /coms command run through this latch so a
	// manual refresh can't overlap a scheduled one (duplicate pings, torn
	// peerCards updates). A latched call is simply skipped.
	async function refreshPoolGuarded(): Promise<void> {
		if (refreshInFlight) return;
		refreshInFlight = true;
		try {
			await refreshPool();
		} finally {
			refreshInFlight = false;
		}
	}

	function listProjects(): string[] {
		const root = path.join(COMS_DIR, "projects");
		try {
			return fs.readdirSync(root).filter((d) => {
				try { return fs.statSync(path.join(root, d)).isDirectory(); } catch { return false; }
			});
		} catch {
			return [];
		}
	}

	function resolveTarget(target: string): RegistryEntry | null {
		// Prefer name match within current project.
		if (identity) {
			const localEntries = pruneDeadEntries(identity.project);
			const byName = localEntries.find((e) => e.name === target);
			if (byName) return byName;
		}
		// Fall back to scanning all projects by session_id (or name as last resort).
		// One prune pass over the combined list — the previous per-project double
		// loop ran pruneDeadEntries (dir reads + process.kill signals) twice.
		const allEntries = pruneDeadEntriesAllProjects();
		const bySession = allEntries.find((e) => e.session_id === target);
		if (bySession) return bySession;
		const byNameGlobal = allEntries.find((e) => e.name === target);
		if (byNameGlobal) return byNameGlobal;
		return null;
	}

	// ━━ Tools ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

	registerToolSafe(pi, {
		name: "coms_list",
		label: "Coms List",
		description:
			"List peer agents discoverable via coms. Returns names, models, and live context-window usage. " +
			"Use project=\"*\" to scan all projects. include_explicit=true reveals agents marked --explicit.",
		parameters: Type.Object({
			project: Type.Optional(Type.String({ description: "Project name, or \"*\" for all projects. Defaults to caller's project." })),
			include_explicit: Type.Optional(Type.Boolean({ description: "Include agents launched with --explicit. Default false." })),
		}),
		async execute(_callId, params) {
			const includeExp = params.include_explicit === true;
			const projectFilter = params.project ?? identity?.project ?? "default";
			const projects = projectFilter === "*" ? listProjects() : [projectFilter];

			const collected: { entry: RegistryEntry; project: string }[] = [];
			for (const proj of projects) {
				for (const entry of pruneDeadEntries(proj)) {
					if (entry.explicit && !includeExp) continue;
					if (identity && entry.session_id === identity.session_id) continue;
					collected.push({ entry, project: proj });
				}
			}

			// Ping each peer in parallel for live context usage.
			const pongs = await Promise.allSettled(collected.map((c) => pingPeer(c.entry.endpoint)));

			const agents = collected.map((c, i) => {
				const r = pongs[i];
				const pong = r?.status === "fulfilled" ? r.value : null;
				return {
					name: c.entry.name,
					session_id: c.entry.session_id,
					purpose: c.entry.purpose,
					model: c.entry.model,
					cwd: c.entry.cwd,
					project: c.project,
					alive: pong != null,
					// Peer-controlled: clamp like refreshPool does (finite,
					// rounded, [0,100] — matching safeContextPct), or a buggy/
					// malicious peer's NaN/string/object/out-of-range pct lands
					// in the tool output fed back to the calling model.
					context_used_pct:
						pong && typeof pong.context_used_pct === "number" && Number.isFinite(pong.context_used_pct)
							? Math.max(0, Math.min(100, Math.round(pong.context_used_pct)))
							: null,
					color: c.entry.color,
				};
			});

			const lines = agents.length === 0
				? "No peer agents found."
				: agents.map((a) => {
					const ctxStr = a.context_used_pct != null ? ` ${a.context_used_pct}%` : " ?%";
					const live = a.alive ? "●" : "✗";
					return `${live} ${a.name} (${a.model})${ctxStr}${a.purpose ? ` — ${a.purpose}` : ""}`;
				}).join("\n");

			return {
				content: [{ type: "text" as const, text: `${agents.length} peer(s):\n${lines}` }],
				details: { agents, project: projectFilter },
			};
		},
		renderCall(args, theme) {
			const proj = (args as any).project;
			const filter = proj ? ` ${proj}` : "";
			return new Text(
				theme.fg("toolTitle", theme.bold("coms_list")) + theme.fg("dim", filter),
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
				const dot = a.alive ? theme.fg("success", "●") : theme.fg("error", "✗");
				const pct = a.context_used_pct != null ? `${a.context_used_pct}%` : "?%";
				return `${dot} ${theme.fg("accent", a.name)} ${theme.fg("dim", a.model)} ${theme.fg("warning", pct)}`;
			}).join("\n");
			return new Text(`${header}\n${rows}`, 0, 0);
		},
	});

	registerToolSafe(pi, {
		name: "coms_send",
		label: "Coms Send",
		description:
			"Send a prompt to a peer agent. Returns synchronously with a msg_id once the receiver acks. " +
			"Use coms_get (non-blocking) or coms_await (blocking) with the msg_id to retrieve the response. " +
			"Throws if the receiver is unreachable or rejects the envelope.",
		parameters: Type.Object({
			target: Type.String({ description: "Peer name (preferred, scoped to your project) or session_id (global)." }),
			prompt: Type.String({ description: "The prompt to send." }),
			conversation_id: Type.Optional(Type.String()),
			response_schema: Type.Optional(Type.Any({ description: "Optional JSON Schema describing the expected response shape. Parse-only: the schema is NOT shown to the receiving agent — your prompt must instruct it to reply with raw JSON matching this schema, or the response will fail with 'response not valid JSON'." })),
		}),
		async execute(_callId, params) {
			if (!identity) {
				throw new Error("coms not initialised");
			}
			const target = resolveTarget(params.target);
			if (!target) {
				throw new Error(`coms: no live agent matching "${params.target}"`);
			}
			// Self-send guard: never target our own registration. A live name
			// collision within one project is impossible (resolveUniqueName), so
			// a same-name entry from our own project can only be us; a
			// same-named agent in another project remains a legitimate target.
			if (target.session_id === identity.session_id) {
				throw new Error("coms: refusing to send to self");
			}
			if (
				target.name === identity.name &&
				pruneDeadEntries(identity.project).some((e) => e.session_id === target.session_id)
			) {
				throw new Error("coms: refusing to send to self");
			}
			// The target must carry a shared secret in its registry entry;
			// entries without one were written by pre-auth (legacy) agents we
			// can't authenticate to.
			if (typeof target.secret !== "string" || target.secret.length === 0) {
				throw new Error(`coms: target "${target.name}" has no shared secret in its registry entry (incompatible or legacy agent)`);
			}
			// A non-object response_schema (string/number/array/...) would be
			// silently coerced to null downstream — fail loudly instead.
			if (
				params.response_schema != null &&
				(typeof params.response_schema !== "object" || Array.isArray(params.response_schema))
			) {
				throw new Error("coms: response_schema must be a plain object (JSON Schema)");
			}
			const active = activeInbound();
			const hops = active ? active.hops + 1 : 0;
			if (hops >= MAX_HOPS) {
				throw new Error(`coms: hop limit reached (${hops} >= ${MAX_HOPS})`);
			}
			const msg_id = ulid();
			const env: PromptEnvelope = {
				type: "prompt",
				secret: target.secret,
				msg_id,
				sender_session: identity.session_id,
				sender_endpoint: identity.endpoint,
				sender_name: identity.name,
				sender_cwd: identity.cwd,
				hops,
				timestamp: nowIso(),
				prompt: params.prompt,
				conversation_id: params.conversation_id ?? null,
				response_schema: (params.response_schema as object | undefined) ?? null,
			};

			// Register the pending entry (with its timer armed) BEFORE sending:
			// a fast response arriving between send and registration would hit
			// handleResponse with no entry, be logged as orphan_response, and be
			// lost forever — the sender would then block the full timeout.
			let resolveFn!: (v: { response?: any; error?: string | null }) => void;
			const promise = new Promise<{ response?: any; error?: string | null }>((res) => {
				resolveFn = res;
			});
			const entry: PendingReply = {
				resolve: resolveFn,
				timer: null,
				promise,
				target_name: target.name,
				conversation_id: params.conversation_id ?? null,
				expected_secret: target.secret,
				created_at: Date.now(),
				timeout_ms: TIMEOUT_MS,
			};
			entry.timer = setTimeout(() => {
				if (entry.result) return;
				entry.result = { error: "timeout" };
				try { entry.resolve(entry.result); } catch { /* ignore */ }
			}, TIMEOUT_MS);
			// Don't keep the event loop alive solely for this timer.
			try { (entry.timer as any).unref?.(); } catch { /* ignore */ }
			pendingReplies.set(msg_id, entry);

			// Send the envelope synchronously and wait for the receiver's ack.
			// On a definitive failure (connect refused, nack), roll the pending
			// entry back so coms_get/coms_await never see a dead msg_id. On an
			// ack loss AFTER the bytes went out, keep it — the receiver may
			// have queued the prompt and the reply can still arrive inbound.
			try {
				await sendEnvelope(target.endpoint, env);
			} catch (err) {
				if ((err as any)?.bytesWritten) {
					try {
						pi.appendEntry("coms-log", {
							event: "send_ack_unconfirmed",
							msg_id,
							target: target.name,
							reason: err instanceof Error ? err.message : String(err),
						});
					} catch {
						// best-effort
					}
					return {
						content: [{ type: "text" as const, text: `coms_send → ${target.name}\nmsg_id ${msg_id}\nhops ${hops}\nack unconfirmed` }],
						details: { msg_id, target: target.name, target_session: target.session_id, hops, ack_confirmed: false },
					};
				}
				if (entry.timer) {
					try { clearTimeout(entry.timer); } catch { /* ignore */ }
					entry.timer = null;
				}
				pendingReplies.delete(msg_id);
				throw err;
			}

			try {
				pi.appendEntry("coms-log", {
					event: "outbound_prompt",
					msg_id,
					target: target.name,
					hops,
				});
			} catch {
				// best-effort
			}

			return {
				content: [{ type: "text" as const, text: `coms_send → ${target.name}\nmsg_id ${msg_id}\nhops ${hops}` }],
				details: { msg_id, target: target.name, target_session: target.session_id, hops, ack_confirmed: true },
			};
		},
		renderCall(args, theme) {
			const tgt = (args as any).target ?? "?";
			const prompt = (args as any).prompt ?? "";
			const preview = prompt.length > 60 ? `${prompt.slice(0, 57)}...` : prompt;
			return new Text(
				theme.fg("toolTitle", theme.bold("coms_send ")) +
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

	registerToolSafe(pi, {
		name: "coms_get",
		label: "Coms Get",
		description:
			"Non-blocking poll of a pending coms_send reply. Returns status pending|complete|error and (when complete) the response.",
		parameters: Type.Object({
			msg_id: Type.String({ description: "msg_id returned by coms_send." }),
		}),
		async execute(_callId, params): Promise<AgentToolResult<{ status: string; error?: string | null; response?: unknown; conversation_id?: string }>> {
			const entry = pendingReplies.get(params.msg_id);
			if (!entry) {
				return {
					content: [{ type: "text" as const, text: `coms_get: unknown msg_id ${params.msg_id}` }],
					details: { status: "error", error: "unknown msg_id" },
				};
			}
			if (entry.result) {
				const r = entry.result;
				const text = r.error
					? `coms_get: error — ${r.error}`
					: `coms_get: complete\n${typeof r.response === "string" ? r.response : (JSON.stringify(r.response, null, 2) ?? "")}`;
				return {
					content: [{ type: "text" as const, text }],
					details: {
						status: r.error ? "error" : "complete",
						response: r.response,
						error: r.error ?? null,
						...(entry.conversation_id ? { conversation_id: entry.conversation_id } : {}),
					},
				};
			}
			return {
				content: [{ type: "text" as const, text: "coms_get: pending" }],
				details: {
					status: "pending",
					...(entry.conversation_id ? { conversation_id: entry.conversation_id } : {}),
				},
			};
		},
		renderCall(args, theme) {
			const id = (args as any).msg_id ?? "?";
			return new Text(
				theme.fg("toolTitle", theme.bold("coms_get ")) + theme.fg("warning", id),
				0, 0,
			);
		},
		renderResult(result, _options, theme) {
			const d = result.details as any;
			const status = d?.status ?? "?";
			const color = status === "complete" ? "success" : status === "pending" ? "warning" : "error";
			return new Text(theme.fg(color, status), 0, 0);
		},
	});

	registerToolSafe(pi, {
		name: "coms_await",
		label: "Coms Await",
		description:
			"Block until a pending coms_send reply lands or the timeout fires. Default timeout 30 minutes (PI_COMS_TIMEOUT_MS).",
		parameters: Type.Object({
			msg_id: Type.String({ description: "msg_id returned by coms_send." }),
			timeout_ms: Type.Optional(Type.Number({ description: "Override the default timeout (ms)." })),
		}),
		async execute(_callId, params): Promise<AgentToolResult<{ error?: unknown; response?: unknown; conversation_id?: string }>> {
			const entry = pendingReplies.get(params.msg_id);
			if (!entry) {
				return {
					content: [{ type: "text" as const, text: `coms_await: unknown msg_id ${params.msg_id}` }],
					details: { error: "unknown msg_id" },
				};
			}
			// Only one await may own a msg_id's deadline/result — a second one
			// would clear the first's timer ownership and race for the result.
			if (awaitingIds.has(params.msg_id)) {
				throw new Error(`coms_await: another coms_await is already pending for msg_id ${params.msg_id}`);
			}
			awaitingIds.add(params.msg_id);
			try {
				// Match coms_net_await's clamp for behavioral parity (file header):
				// any finite positive number, floored at 1s so a near-zero value
				// can't arm an instant timer that deletes this entry and orphans
				// the late reply. Cap at 2^31-1 (Node setTimeout overflow) — NOT
				// MESSAGE_TIMEOUT_MS, because this is a LOCAL timer with no server
				// cap (coms-net delegates to a remote server with a "Server cap
				// applies" contract, hence its tighter ceiling).
				const timeoutMs = typeof params.timeout_ms === "number" && Number.isFinite(params.timeout_ms) && params.timeout_ms > 0
					? Math.min(Math.max(params.timeout_ms, 1_000), 2 ** 31 - 1)
					: TIMEOUT_MS;

				// coms_send already armed a background timer at the default TIMEOUT_MS;
				// left running, it can resolve entry.promise with a spurious timeout
				// before (or after) this call's own timeoutMs elapses. This call is
				// now the sole owner of the deadline.
				if (entry.timer) {
					clearTimeout(entry.timer);
					entry.timer = null;
				}
				// This call now owns the deadline; record the effective timeout so the
				// keepalive pruning loop honors it instead of the default TIMEOUT_MS,
				// measured from this invocation (the race timer below starts now, not
				// at coms_send time).
				entry.timeout_ms = timeoutMs;
				entry.await_started_at = Date.now();

				let timedTimer: NodeJS.Timeout | undefined;
				const timed = new Promise<{ error: string }>((resolve) => {
					timedTimer = setTimeout(() => resolve({ error: "timeout" }), timeoutMs);
					try { timedTimer.unref?.(); } catch { /* ignore */ }
				});

				const winner = await Promise.race([entry.promise, timed]);
				clearTimeout(timedTimer);
				// The reply is fully consumed by this await (success, error, or
				// timeout). Drop the entry immediately instead of leaving it for the
				// keepalive pruning loop to reclaim up to timeout_ms + 60s later.
				pendingReplies.delete(params.msg_id);
				if ((winner as any).error) {
					return {
						content: [{ type: "text" as const, text: `coms_await: error — ${(winner as any).error}` }],
						details: { error: (winner as any).error },
					};
				}
				const resp = (winner as any).response;
				return {
					content: [{ type: "text" as const, text: typeof resp === "string" ? resp : (JSON.stringify(resp, null, 2) ?? "") }],
					details: {
						response: resp,
						...(entry.conversation_id ? { conversation_id: entry.conversation_id } : {}),
					},
				};
			} finally {
				awaitingIds.delete(params.msg_id);
			}
		},
		renderCall(args, theme) {
			const id = (args as any).msg_id ?? "?";
			return new Text(
				theme.fg("toolTitle", theme.bold("coms_await ")) + theme.fg("warning", id),
				0, 0,
			);
		},
		renderResult(result, _options, theme) {
			const d = result.details as any;
			if (d?.error) return new Text(theme.fg("error", `✗ ${d.error}`), 0, 0);
			return new Text(theme.fg("success", "✓ response received"), 0, 0);
		},
	});

	// ━━ agent_end: capture turn output and dispatch response back ━━━━━━━━

	pi.on("agent_end", async (_event, ctx) => {
		// Identity check first: if a heartbeat-conflict teardown nulled it while
		// inbounds are queued, shifting here would orphan the turnQueue slot —
		// the entry would stay in inboundQueue but never be fulfillable.
		if (!identity) return;
		const branch = ctx.sessionManager?.getBranch() ?? [];
		// pi 0.55.0 stores extension-injected prompts as custom_message entries
		// with details at entry level (session-manager appendCustomMessageEntry);
		// plain message entries carry details on entry.message. Match both shapes.
		const anchorMsgId = (entry: any): string | undefined =>
			entry && (entry.type === "custom_message"
				? (entry as any).details?.msg_id
				: entry.type === "message" && entry.message
					? (entry.message as any).details?.msg_id
					: undefined);
		// Fulfill strictly FIFO, but ALL anchored entries, not just the first:
		// pi 0.55.0 runs follow-up turns inside ONE runLoop and emits a single
		// agent_end for the whole batch (pi-agent-core agent-loop), so several
		// queued prompts can all be anchored when this fires. Fulfilling only
		// the oldest would answer it with the LAST turn's text (the slice walk
		// below would run past the next inbound's anchor) and starve the rest
		// until TURN_DEADLINE_MS pruning.
		const inbounds: InboundContext[] = [];
		const kept: string[] = [];
		for (const mid of turnQueue) {
			const cand = inboundQueue.get(mid);
			if (!cand || cand.fulfilled) continue; // stale slot — drop
			// Only fulfill if a turn was actually triggered by the queued
			// prompt: the followUp entry is appended to the branch when its own
			// turn starts. A slot without an anchor is KEPT, not dropped: pi
			// 0.55.0 queues followUps in memory and persists them only at
			// message_end of their turn (pi-agent-core agent-loop), so a
			// followUp that arrives between the loop's follow-up check and the
			// single agent_end — or is left queued after an error/abort
			// agent_end — has no anchor at THIS event but will at a later one.
			// Keeping the slot costs nothing (the per-entry scan can't block),
			// and a never-anchored entry is still pruned + tombstoned by the
			// keepalive sweep (mirrors coms-net.ts).
			if (branch.some((entry: any) => anchorMsgId(entry) === mid)) {
				inbounds.push(cand);
				continue;
			}
			kept.push(mid);
		}
		turnQueue.length = 0;
		turnQueue.push(...kept);
		// Fallback (mirrors coms-net.ts) for inbounds not tracked in turnQueue
		// (e.g. injected before this extension state existed): re-anchor
		// against the session branch before giving up, or the prompt's
		// response would never be dispatched and the sender's coms_await
		// would hang until timeout.
		if (inbounds.length === 0) {
			const fallback = activeInbound(ctx);
			if (!fallback) return;
			inbounds.push(fallback);
		}

		// Walk the branch once: each inbound's reply text is the slice of
		// assistant messages between its own anchor and the NEXT inbound's
		// anchor — never beyond it, so a batched (or late) fulfillment can't
		// pick up an unrelated later turn's text. Only overwrite on non-empty
		// text — a later assistant message that's tool-calls-only (no text
		// block) must not blank out a real reply from an earlier message in
		// the same turn.
		const slices = new Map<InboundContext, { found: boolean; text: string }>();
		let cur: InboundContext | null = null;
		let curText = "";
		for (const entry of branch) {
			const mid = anchorMsgId(entry);
			if (mid !== undefined) {
				const hit = inbounds.find((i) => i.msg_id === mid);
				// Any inbound prompt anchor is a turn boundary — flush the
				// current slice, then start a new one only if this anchor is
				// one we're claiming. A fulfilled / foreign prompt's anchor
				// (no hit) must STILL close the prior slice; otherwise cur
				// stays pinned to the previous unfulfilled inbound and this
				// anchor's turn's assistant replies below get attributed to
				// it (cross-attribution).
				if (cur) {
					slices.get(cur)!.text = curText;
					cur = null;
					curText = "";
				}
				if (hit) {
					slices.set(hit, { found: true, text: "" });
					cur = hit;
				}
				continue;
			}
			if (cur && entry.type === "message" && entry.message && entry.message.role === "assistant") {
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
					curText = msgText;
				}
			}
		}
		if (cur) slices.get(cur)!.text = curText;

		// Pass 1 — synchronous: compute every reply and record EVERY
		// exit-dispatch before the first await. In pi's print mode (`-p` /
		// `--mode json`) agent event listeners are fire-and-forget
		// (pi-agent-core drops the listener promise) and main.js calls
		// process.exit(0) immediately after the final turn, so this floating
		// handler can be killed at the first await in pass 2. The 'exit'
		// handler below synchronously delivers any dispatch still pending at
		// process exit — but only dispatches pushed BEFORE that first yield,
		// so pushing one per awaited iteration would silently lose replies
		// #2..N of a batched runLoop in exactly the mode that races exit.
		const sends: {
			inbound: InboundContext;
			respEnv: ResponseEnvelope;
			dispatch: { endpoint: string; line: string; done: boolean };
			error: string | null;
		}[] = [];
		for (const inbound of inbounds) {
			const slice = slices.get(inbound) ?? { found: false, text: "" };
			const lastAssistantText = slice.text;
			let payload: any = lastAssistantText;
			let error: string | null = null;
			if (!slice.found) {
				// The injected prompt entry is gone from the branch (compaction/
				// truncation). Don't fabricate an empty success — report the loss
				// so the sender gets a clear error; the inbound is still marked
				// fulfilled + tombstoned below so it can't hang or be replayed.
				payload = null;
				error = "prompt context lost";
				try {
					pi.appendEntry("coms-log", { event: "response_context_lost", msg_id: inbound.msg_id });
				} catch {
					// best-effort
				}
			} else if (
				inbound.response_schema &&
				typeof inbound.response_schema === "object" &&
				!Array.isArray(inbound.response_schema)
			) {
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
			} else if (!lastAssistantText.trim()) {
				// Turn anchored but produced no assistant text (abort, tools-only
				// turn, model error): don't hand the sender a blank success.
				payload = null;
				error = "empty response";
			}
			// Producer-side response cap (mirrors the receiver-side check in
			// handleResponse): an oversized payload would be nacked at the
			// transport layer with no pending-entry semantics and strand the
			// caller's coms_await until its full timeout — fail cleanly here.
			let respBytes = 0;
			try {
				const s = typeof payload === "string" ? payload : JSON.stringify(payload);
				respBytes = Buffer.byteLength(s ?? "", "utf8");
			} catch {
				// Unserializable payload — treat as empty for sizing.
			}
			if (respBytes > MAX_RESPONSE_BYTES) {
				payload = null;
				error = "response too large";
			}

			const respEnv: ResponseEnvelope = {
				type: "response",
				// Echo the prompt's secret so the original sender can authenticate
				// this response against the secret it sent (see handleResponse).
				secret: inbound.secret,
				msg_id: inbound.msg_id,
				sender_session: identity.session_id,
				sender_endpoint: identity.endpoint,
				hops: 0,
				timestamp: nowIso(),
				response: payload,
				error,
				// Echo the originating prompt's conversation_id so the caller can
				// correlate threads (D2).
				conversation_id: inbound.conversation_id ?? null,
			};

			const dispatch = { endpoint: inbound.sender_endpoint, line: JSON.stringify(respEnv), done: false };
			// Cap the crash-replay set, evicting the OLDEST unsettled entry on
			// overflow. pendingExitDispatches backs ONLY the process-'exit'
			// fallback below — it retries replies whose pass-2 send was
			// pre-empted by a crash. Pass 2 sends every dispatch from `sends`
			// regardless of membership here, and its success-splice is a no-op
			// if this entry was evicted, so eviction NEVER loses a reply; it
			// only drops crash-replay coverage for one. Evicting oldest keeps
			// the replay set holding the most-recent (most-likely-live)
			// dispatches. A fill-then-stop admission policy would instead let
			// stale entries from dead/offline peers (send failed, never
			// spliced, process still alive) pin the cap and starve crash-replay
			// coverage for every subsequent turn. Parity with coms-net.ts.
			pendingExitDispatches.push(dispatch);
			while (pendingExitDispatches.length > MAX_PENDING_EXIT_DISPATCHES) {
				pendingExitDispatches.shift();
			}
			sends.push({ inbound, respEnv, dispatch, error });
		}

		// Pass 2 — the awaited sends. A print-mode exit mid-pass still delivers
		// the remaining dispatches via the 'exit' fallback (all were queued in
		// pass 1); duplicates from that race are safe (see the catch below).
		for (const { inbound, respEnv, dispatch, error } of sends) {
			try {
				await sendEnvelope(inbound.sender_endpoint, respEnv);
				dispatch.done = true;
				// Drop confirmed dispatches so the array only retains unsettled
				// ones — a long-lived session would otherwise accumulate one entry
				// per reply forever.
				const idx = pendingExitDispatches.indexOf(dispatch);
				if (idx >= 0) pendingExitDispatches.splice(idx, 1);
				try {
					pi.appendEntry("coms-log", {
						event: "outbound_response",
						msg_id: inbound.msg_id,
						error,
					});
				} catch {
					// best-effort
				}
			} catch (e: any) {
				// Leave dispatch.done = false: the 'exit' fallback retries delivery.
				// Duplicates are possible in BOTH directions — this retry path, and
				// a first send that actually succeeded but whose ack was lost. They
				// are safe, not impossible: the receiver either still holds the
				// pending entry (same payload overwrites the same result; promise
				// re-resolve is a no-op) or has already consumed it (at worst an
				// orphan_response audit log).
				try {
					pi.appendEntry("coms-log", {
						event: "outbound_response_failed",
						msg_id: inbound.msg_id,
						reason: e?.message ?? String(e),
					});
				} catch {
					// best-effort
				}
			}

			inbound.fulfilled = true;
			inboundQueue.delete(inbound.msg_id);
			// Tombstone the msg_id for 1h so a retransmitted or replayed prompt is
			// nacked as "duplicate" instead of injecting another turn.
			markFulfilled(inbound.msg_id);
		}
	});

	// ━━ /coms slash command ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
	registerCommandSafe(pi, "coms", {
		description: "Force-refresh the coms pool widget (or filter with --all / --project <name>)",
		handler: async (args, ctx) => {
			const trimmed = (args ?? "").trim();
			// Tokenize instead of substring-matching: "--allow" must not toggle
			// --all, and the project value must be validated like the CLI flag
			// path (an invalid name would otherwise silently yield an empty pool).
			const tokens = trimmed.split(/\s+/).filter((t) => t.length > 0);
			if (tokens.includes("--all")) {
				includeExplicit = !includeExplicit;
				try { ctx.ui.notify(`coms: include_explicit = ${includeExplicit}`, "info"); } catch { /* ignore */ }
			}
			const projIdx = tokens.indexOf("--project");
			if (projIdx >= 0 && projIdx + 1 < tokens.length) {
				const proj = tokens[projIdx + 1]!;
				if (!isSafePathComponent(proj)) {
					try { ctx.ui.notify(`coms: invalid project name "${proj}"`, "error"); } catch { /* ignore */ }
				} else {
					displayProject = proj;
					try { ctx.ui.notify(`coms: displaying project ${displayProject}`, "info"); } catch { /* ignore */ }
				}
			}
			try {
				await refreshPoolGuarded();
			} catch (err) {
				try { ctx.ui.notify(`coms: refresh failed — ${err instanceof Error ? err.message : String(err)}`, "error"); } catch { /* ignore */ }
			}
		},
	});

	// ━━ Clean shutdown ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
	let shuttingDown = false;
	async function cleanShutdown(): Promise<void> {
		if (shuttingDown) return;
		shuttingDown = true;
		if (pingTimer) { try { clearInterval(pingTimer); } catch { /* ignore */ } pingTimer = null; }
		if (keepaliveTimer) { try { clearInterval(keepaliveTimer); } catch { /* ignore */ } keepaliveTimer = null; }
		for (const entry of pendingReplies.values()) {
			if (entry.timer) {
				try { clearTimeout(entry.timer); } catch { /* ignore */ }
				entry.timer = null;
			}
			// Resolve (don't just drop) in-flight replies: an in-flight
			// coms_await holding entry.promise would otherwise hang with not
			// even the entry timer firing (same loop as the session-start
			// reset path).
			if (!entry.result) {
				entry.result = { error: "session shutdown" };
				try { entry.resolve(entry.result); } catch { /* ignore */ }
			}
		}
		pendingReplies.clear();
		if (server) {
			try { server.close(); } catch { /* ignore */ }
			server = null;
		}
		if (identity) {
			if (process.platform !== "win32") {
				try { fs.unlinkSync(identity.endpoint); } catch { /* ignore */ }
			}
			try { removeRegistryEntry(identity.project, identity.name, identity.session_id); } catch { /* ignore */ }
			try {
				pi.appendEntry("coms-log", { event: "shutdown", session_id: identity.session_id });
			} catch { /* best-effort */ }
		}
		if (currentCtx?.hasUI) {
			try { currentCtx.ui.setWidget("coms-pool", undefined); } catch { /* ignore */ }
		}
		// Clear identity last so a post-teardown coms_send fails fast on the
		// `!identity` check instead of sending with a dead registration.
		identity = null;
	}

	// Rely on the host's session_shutdown event for cleanup. Registering
	// process-level SIGINT/SIGTERM handlers from an extension suppresses Node's
	// default termination (once any listener attaches, Ctrl-C no longer exits)
	// and can hang the host on shutdown. The host owns process lifecycle.
	pi.on("session_shutdown", async () => {
		// Serialize with session_start on the same latch: cleanShutdown against
		// half-built state would null an identity being rebuilt and wedge every
		// later cleanup.
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
	// for responses that the print-mode exit race (see agent_end) would
	// otherwise drop: main.js's process.exit(0) kills the floating agent_end
	// handler mid-send. 'exit' handlers must be fully synchronous, so the
	// delivery runs in a child process (spawnSync); normally the async path
	// has already marked every dispatch done and this is a no-op.
	// Install at most once: process.on accumulates listeners, so an extension
	// reload / co-load would otherwise stack duplicate exit handlers. The
	// dispatch array is module-level so the single handler sees live state.
	if (!exitHandlerInstalled) {
		exitHandlerInstalled = true;
		process.on("exit", () => {
			// Total budget across all dispatches: each spawnSync blocks up to
			// ~4s (the script's own deadline), so without a cap a backlog of
			// undelivered responses could stall process exit for minutes.
			const deadline = Date.now() + EXIT_DELIVER_BUDGET_MS;
			for (const d of pendingExitDispatches) {
				if (d.done) continue;
				if (Date.now() >= deadline) break;
				try {
					spawnSync(process.execPath, ["-e", EXIT_DELIVER_SCRIPT], {
						input: d.line,
						timeout: SOCKET_OP_TIMEOUT_MS,
						env: { ...process.env, PI_COMS_EXIT_ENDPOINT: d.endpoint },
						stdio: ["pipe", "ignore", "ignore"],
					});
				} catch { /* best-effort — the process is already exiting */ }
			}
		});
	}
}
