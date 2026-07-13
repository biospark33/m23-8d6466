#!/usr/bin/env bun
/**
 * coms-smoke-test — P0.2 coms viability smoke test (subprocess-RPC + socket-coms).
 *
 * Exercises BOTH Pi agent messaging substrates against pinned `pi@0.55.0`:
 *
 *   Path A — subprocess-RPC (`pi --mode json -p`): spawns two headless pi
 *            processes and parses their JSON event streams. A round-trip counts
 *            ONLY from a real `agent_end` event carrying assistant text. This is
 *            the make-or-break message path per the story's AC1 OR clause.
 *
 *   Path B — socket-coms: verifies BOTH vendored extensions load on pi 0.55.0
 *            (AC3, `pi -e ./coms.ts|coms-net.ts --list-models`), then spawns two
 *            REAL concurrent `pi -e ./coms.ts --mode json --cname …` peers from
 *            the vendor dir and waits for coms.ts's own session_start to write
 *            both registry entries into an isolated PI_COMS_DIR — no registry
 *            JSON is ever hand-written by this script. Agent A is instructed
 *            (via its -p prompt) to coms_send agent B and coms_await the reply;
 *            B's coms.ts auto-handles the inbound prompt and replies on
 *            agent_end. The round-trip counts only from real pi JSON events in
 *            A's stream (coms_send ack + coms_await reply + agent_end with
 *            assistant text).
 *
 * Emits a single structured JSON report to stdout: agents registered + messages
 * exchanged per path, plus an AC map. Exit 0 iff the make-or-break gate holds:
 * Path A produced a real agent_end round-trip AND Path B registered ≥2 real
 * peers, and every other gating check passed. The Path B live exchange is
 * reported PASS/FAIL with real evidence but is NOT gating by default
 * (PI_SMOKE_STRICT=1 makes it gating): AC1's message clause is satisfied by
 * either substrate (story OR clause), and the model-driven reply depends on
 * two live agents' turn timing.
 *
 * Model override: set PI_SMOKE_MODEL to pin the model used by every spawned
 * pi (passed through as `--model`) — e.g. when the default provider's auth is
 * expired: PI_SMOKE_MODEL=openrouter/anthropic/claude-haiku-4.5. Unset → pi's
 * configured default model.
 *
 * INV-1: no real API keys are written or logged — the live turns use whatever
 *        auth pi already holds, and captured pi output is redacted for ambient
 *        secret-looking env values before anything enters the report.
 * INV-2: Path B spawns run with PI_COMS_DIR pointed at a per-run temp dir
 *        (0700), so spawned pi registry writes are confined there and the
 *        host's ~/.pi/coms is never mutated.
 *
 * Usage:
 *   bun scripts/coms-smoke-test.ts
 *   PI_SMOKE_MODEL=openrouter/anthropic/claude-haiku-4.5 bun scripts/coms-smoke-test.ts
 */

import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";

const VENDOR_DIR = path.join(import.meta.dir, "..", "pi-vs-claude-code-vendor");
const COMS_EXT = path.join(VENDOR_DIR, "coms.ts");
const COMS_NET_EXT = path.join(VENDOR_DIR, "coms-net.ts");
const PIN = "0.55.0";

// Model override for every spawned pi — see header (PI_SMOKE_MODEL).
const SMOKE_MODEL = process.env.PI_SMOKE_MODEL?.trim() || null;
const modelArgs = (): string[] => (SMOKE_MODEL ? ["--model", SMOKE_MODEL] : []);

const SPAWN_TIMEOUT_MS = 90_000; // per `pi -p` spawn (either path)
const EXT_LOAD_TIMEOUT_MS = 60_000;
// `pi --version` also loads global extensions before printing; 10s proved
// flaky under load (ETIMEDOUT with four peers spawning), so keep 30s.
const VERSION_TIMEOUT_MS = 30_000;
const REGISTRY_POLL_TIMEOUT_MS = 30_000;
// pi's JSON event stream includes full message snapshots per delta; 1 MiB
// (spawnSync's default) is not enough for a chatty turn.
const MAX_OUTPUT_BYTES = 16 * 1024 * 1024;
const COMS_PROJECT = "smoke"; // isolated project namespace for Path B peers
const AWAIT_TIMEOUT_MS = 45_000; // coms_await budget inside agent A's prompt

// ── Report hygiene: ambient secrets must never leak into the JSON report.
//    Any process.env value whose key looks secret-bearing (≥8 chars, to skip
//    noise like "true") is redacted from captured pi output before it is
//    embedded in the report. ─────────────────────────────────────────────────
const SECRET_VALUES = Object.entries(process.env)
	.filter(
		([k, v]) =>
			/(KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|JWT|AUTH|DSN|URL)/i.test(k) &&
			typeof v === "string" &&
			v.length >= 8,
	)
	.map(([, v]) => v as string);
function redact(s: string): string {
	let out = s;
	for (const v of SECRET_VALUES) out = out.split(v).join("[REDACTED]");
	return out;
}

// Well-formed 26-char Crockford-base32 ULID (48-bit time + 80-bit
// randomness) for shape-coverage msg_ids — no more fake "01SMOKE…" ids.
const ULID_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
function ulid(): string {
	let head = "";
	let t = Date.now();
	for (let i = 0; i < 10; i++) {
		head = (ULID_ALPHABET[t % 32] ?? "0") + head;
		t = Math.floor(t / 32);
	}
	let tail = "";
	for (const b of crypto.randomBytes(16)) tail += ULID_ALPHABET[b % 32] ?? "0";
	return head + tail;
}

type Check = { name: string; ok: boolean; skipped?: string; detail?: string };
const checks: Check[] = [];
const record = (c: Check): Check => {
	checks.push(c);
	return c;
};

// ── Spawn-result inspection (C1/C2): timeout, missing binary, and signal
//    deaths must surface as failed checks, never as empty-output silence. ────
type SyncResult = ReturnType<typeof spawnSync>;
function spawnProblem(r: SyncResult): string | null {
	if (r.error) return `spawn error: ${String(r.error)}`;
	if (r.signal) return `killed by signal ${r.signal}`;
	if (r.status === null) return "no exit status (status=null)";
	return null;
}

// ── pi presence + version pin (AC precondition) ─────────────────────────────
function checkPiVersion(): string | null {
	const r = spawnSync("pi", ["--version"], {
		encoding: "utf8",
		timeout: VERSION_TIMEOUT_MS,
		maxBuffer: MAX_OUTPUT_BYTES,
		shell: process.platform === "win32",
	});
	const problem = spawnProblem(r);
	// pi may print extension-load warnings around the version; accept ONLY a
	// line that is exactly the pinned version (after trim, optional leading v)
	// — never fuzzy-match a version string inside a warning line.
	const version =
		(r.stdout ?? "")
			.split("\n")
			.map((l) => l.trim())
			.find((l) => new RegExp(`^v?${PIN.replace(/\./g, "\\.")}$`).test(l))
			?.replace(/^v/, "") ?? "";
	record({
		name: "pi_version_pin",
		ok: !problem && version === PIN,
		detail:
			problem ??
			(version === PIN
				? `found "${PIN}"`
				: `no line exactly "${PIN}" (or "v${PIN}") on stdout — pin mismatch`),
	});
	return !problem && version === PIN ? version : null;
}

// ── AC3: a vendored extension loads on pinned pi (`-e ./ext --list-models`) ──
function checkExtensionLoads(extPath: string, checkName: string): number {
	const r = spawnSync("pi", ["-e", extPath, "--list-models"], {
		encoding: "utf8",
		cwd: VENDOR_DIR,
		timeout: EXT_LOAD_TIMEOUT_MS,
		maxBuffer: MAX_OUTPUT_BYTES,
		shell: process.platform === "win32",
	});
	const problem = spawnProblem(r);
	// Model rows are "<provider> <model> …" lines under a "provider model …"
	// header. Require BOTH the expected header AND ≥1 row matching the known
	// provider whitelist — a bare non-empty-row fallback would count noise (C6).
	const lines = (r.stdout ?? "")
		.split("\n")
		.map((l) => l.trim())
		.filter(Boolean);
	const hasHeader = lines.some((l) => /^provider\s/i.test(l));
	const modelCount = lines.filter((l) => /^(anthropic|openrouter|openai|google)\s/.test(l)).length;
	// Negative assertion: AC3 is extension-LOAD compatibility, so a load
	// failure OF THE EXTENSION UNDER TEST on stderr fails the check even when
	// exit=0. Scope to this extension's basename — unrelated global extensions
	// (e.g. a user's pi-gitnexus-plus) failing to load must not fail AC3.
	// path.basename is separator-safe (split("/") would break on win32 paths).
	const extBase = path.basename(extPath);
	const loadFailure = (r.stderr ?? "")
		.split("\n")
		.map((l) => l.trim())
		.find((l) => l.includes(extBase) && /failed to load|error/i.test(l));
	const ok = !problem && r.status === 0 && hasHeader && modelCount > 0 && !loadFailure;
	record({
		name: checkName,
		ok,
		detail:
			problem ??
			(loadFailure
				? `extension-load failure on stderr: "${redact(loadFailure)}"`
				: `exit=${r.status}, header=${hasHeader}, models_listed=${modelCount}`),
	});
	return ok ? modelCount : 0;
}

// ── Async pi spawn with timeout + output cap (C1/C2) ────────────────────────
interface SpawnOutcome {
	status: number | null;
	signal: NodeJS.Signals | null;
	stdout: string;
	stderr: string;
	// stdout or stderr hit MAX_OUTPUT_BYTES — diagnostics may be missing.
	truncated: boolean;
	// spawn failure, timeout, or output-cap kill — anything that makes the
	// outcome untrustworthy even when status happens to be 0.
	error: string | null;
}

// Kill the whole process tree: POSIX spawns are detached group leaders, so
// signal the GROUP (-pid) to sweep grandchildren (pi tool calls like `sleep`);
// on win32 use taskkill /T. Best-effort — a dead process must never throw.
function killTree(proc: ChildProcess, signal: NodeJS.Signals = "SIGKILL"): void {
	const pid = proc.pid;
	if (typeof pid !== "number") return;
	try {
		if (process.platform === "win32") {
			spawnSync("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore" });
		} else {
			process.kill(-pid, signal);
		}
	} catch {
		try {
			proc.kill(signal);
		} catch {
			// already gone
		}
	}
}

// Wait for a peer's close event (bounded) so rmSync never races a live pi.
function waitForClose(proc: ChildProcess | null, ms: number): Promise<void> {
	return new Promise((resolve) => {
		if (!proc || proc.exitCode !== null || proc.signalCode !== null) {
			resolve();
			return;
		}
		const t = setTimeout(resolve, ms);
		proc.once("close", () => {
			clearTimeout(t);
			resolve();
		});
	});
}

function startPi(
	args: string[],
	opts: { timeoutMs: number; env?: NodeJS.ProcessEnv },
): { proc: ChildProcess; done: Promise<SpawnOutcome> } {
	const isWin = process.platform === "win32";
	// shell:true → Node joins args with spaces and no quoting; wrap each arg so
	// cmd.exe keeps space/quote-bearing prompts as one argv entry. POSIX path
	// unchanged.
	const finalArgs = isWin ? args.map((a) => `"${a.replace(/"/g, '""')}"`) : args;
	const proc = spawn("pi", finalArgs, {
		cwd: VENDOR_DIR,
		env: opts.env ?? process.env,
		shell: isWin,
		// Own process group on POSIX so killTree can sweep grandchildren.
		detached: !isWin,
		stdio: ["ignore", "pipe", "pipe"],
	});
	const stdoutChunks: Buffer[] = [];
	const stderrChunks: Buffer[] = [];
	let outBytes = 0;
	let errBytes = 0;
	let capped = false;
	let errCapped = false;
	let timedOut = false;
	let spawnErr: string | null = null;
	const done = new Promise<SpawnOutcome>((resolve) => {
		let forceTimer: NodeJS.Timeout | null = null;
		const timer = setTimeout(() => {
			timedOut = true;
			killTree(proc, "SIGTERM");
			// A stuck child gets 5s to honor SIGTERM before SIGKILL.
			forceTimer = setTimeout(() => {
				killTree(proc, "SIGKILL");
			}, 5_000);
		}, opts.timeoutMs);
		proc.on("error", (e) => {
			spawnErr = `spawn error: ${String(e)}`;
		});
		proc.stdout?.on("data", (c: Buffer) => {
			if (outBytes + c.length <= MAX_OUTPUT_BYTES) {
				stdoutChunks.push(c);
				outBytes += c.length;
			} else if (!capped) {
				capped = true;
				killTree(proc, "SIGTERM");
			}
		});
		proc.stderr?.on("data", (c: Buffer) => {
			if (errBytes + c.length <= MAX_OUTPUT_BYTES) {
				stderrChunks.push(c);
				errBytes += c.length;
			} else {
				// Keep capturing nothing but flag it — silently dropped stderr
				// diagnostics must be visible in the report.
				errCapped = true;
			}
		});
		proc.on("close", (status, signal) => {
			clearTimeout(timer);
			if (forceTimer) clearTimeout(forceTimer);
			resolve({
				status,
				signal,
				stdout: redact(Buffer.concat(stdoutChunks).toString("utf8")),
				stderr: redact(Buffer.concat(stderrChunks).toString("utf8")),
				truncated: capped || errCapped,
				error:
					spawnErr ??
					(timedOut
						? `timeout after ${opts.timeoutMs}ms (killed${signal === "SIGKILL" ? " with SIGKILL" : ""})`
						: capped
							? `stdout exceeded ${MAX_OUTPUT_BYTES} bytes (killed)`
							: null),
			});
		});
	});
	return { proc, done };
}

// ── pi JSON event stream parsing ────────────────────────────────────────────
interface PiEvent {
	type?: string;
	toolName?: string;
	result?: { content?: Array<{ type?: string; text?: string }>; details?: Record<string, unknown> };
	messages?: Array<Record<string, unknown>>;
	[k: string]: unknown;
}

function parseEvents(stdout: string): PiEvent[] {
	const events: PiEvent[] = [];
	for (const line of stdout.split("\n")) {
		const t = line.trim();
		if (!t.startsWith("{") || !t.endsWith("}")) continue;
		try {
			events.push(JSON.parse(t) as PiEvent);
		} catch {
			// non-JSON line — ignored, must not crash the parser
		}
	}
	return events;
}

function assistantText(msg: Record<string, unknown>): string {
	if (!msg || msg.role !== "assistant") return "";
	if (typeof msg.content === "string") return msg.content;
	if (Array.isArray(msg.content)) {
		return msg.content
			.filter((b): b is { type: string; text?: string } => Boolean(b) && (b as { type?: string }).type === "text")
			.map((b) => b.text ?? "")
			.join("\n");
	}
	return "";
}

// A real completed turn: agent_end carrying at least one assistant message
// with visible text (not a tool-calls-only or empty message).
function agentEndWithText(events: PiEvent[]): boolean {
	return events.some(
		(e) =>
			e.type === "agent_end" &&
			Array.isArray(e.messages) &&
			e.messages.some((m) => assistantText(m).trim().length > 0),
	);
}

// Broader auth-failure detection (C7): pi may surface expired/absent auth as
// stderr text or a structured JSON error event. Tightened to STDERR ONLY
// (never stdout — model output must not trip it) and requiring auth context:
// a 401/403 near auth wording, auth wording near a 401/403/api-key/token, or
// known pi phrasing.
const AUTH_FAIL_RES = [
	/\b(401|403)\b.*(unauthor|forbidden|denied|api.?key|token)/i,
	/\b(unauthorized|forbidden)\b.*\b(401|403|api.?key|token)\b/i,
	/invalid api key|authentication failed/i,
];
function detectAuthFailure(out: SpawnOutcome, events: PiEvent[]): boolean {
	if (AUTH_FAIL_RES.some((re) => re.test(out.stderr))) return true;
	// Structured pi error events are not model output; same tightened patterns.
	return events.some(
		(e) => e.type === "error" && AUTH_FAIL_RES.some((re) => re.test(JSON.stringify(e))),
	);
}

// ── Path A: subprocess-RPC JSON event stream ────────────────────────────────
async function pathSubprocessRpc(): Promise<{
	registered: number;
	exchanged: number;
	spawn_errors: number;
}> {
	// A "registered" agent on this path = one spawned pi subprocess whose JSON
	// stream opened (the session header is the RPC handshake) AND which did not
	// already error/time out — a dying process must not inflate the count. We
	// spawn two, concurrently.
	const cnames = ["smoke-rpc-a", "smoke-rpc-b"];
	const runs = cnames.map((cname) =>
		startPi(["--mode", "json", ...modelArgs(), "-p", `You are ${cname}. Reply with exactly: ok`], {
			timeoutMs: SPAWN_TIMEOUT_MS,
		}),
	);
	const outcomes = await Promise.all(runs.map((r) => r.done));

	let registered = 0;
	let exchanged = 0;
	let spawn_errors = 0;
	let authFailed = false;
	const problems: string[] = [];
	for (const out of outcomes) {
		const events = parseEvents(out.stdout);
		if (out.error) {
			problems.push(out.error);
			spawn_errors += 1;
		} else if (out.status !== 0)
			problems.push(`exit=${out.status}${out.signal ? ` signal=${out.signal}` : ""}`);
		if (out.truncated) problems.push("output truncated at cap — diagnostics may be missing");
		// Only a session header from a process that did NOT error/timeout/crash counts.
		if (!out.error && out.status === 0 && events.some((e) => e.type === "session")) registered += 1;
		// A completed round-trip needs a real model turn (agent_end with text).
		if (agentEndWithText(events)) exchanged += 1;
		if (detectAuthFailure(out, events)) authFailed = true;
	}

	record({
		name: "rpc_stream_parse",
		ok: registered >= 2,
		detail: `${registered}/2 subprocess JSON streams opened & parsed${problems.length ? `; problems: ${problems.join("; ")}` : ""}`,
	});

	if (exchanged >= 1) {
		record({
			name: "rpc_live_round_trip",
			ok: true,
			detail: `${exchanged} agent_end round-trip(s) with assistant text`,
		});
	} else if (authFailed) {
		record({
			name: "rpc_live_round_trip",
			ok: false,
			skipped:
				"pi auth unavailable — no agent_end observed and an auth failure was detected in pi output",
			detail:
				"transport parse verified; live turn requires pi auth (or set PI_SMOKE_MODEL to an authed provider/model)",
		});
	} else {
		record({
			name: "rpc_live_round_trip",
			ok: false,
			detail: `no agent_end with assistant text in either stream${problems.length ? `; problems: ${problems.join("; ")}` : ""}`,
		});
	}

	return { registered, exchanged, spawn_errors };
}

// ── Path B: socket-coms with two REAL concurrent pi peers (isolated PI_COMS_DIR)
// Mirrors coms.ts's RegistryEntry, INCLUDING the per-agent `secret` added by
// the envelope-auth protocol change. Entries are produced ONLY by coms.ts's
// own session_start — this script never writes registry JSON.
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
	secret?: string; // envelope auth token (post protocol change)
	context_used_pct?: number;
	queue_depth?: number;
	heartbeat_at?: string;
}

async function pathSocketComs(): Promise<{
	registered: number;
	exchanged: number;
	sendAcked: boolean;
	bAnswered: boolean;
}> {
	// INV-2: isolate to a per-run temp dir; spawned pi get PI_COMS_DIR=comsDir
	// so every registry write coms.ts makes is confined here.
	const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "coms-smoke-"));
	const comsDir = path.join(tmpRoot, "coms");
	const result = { registered: 0, exchanged: 0, sendAcked: false, bAnswered: false };
	let procA: ChildProcess | null = null;
	let procB: ChildProcess | null = null;
	try {
		const agentsDir = path.join(comsDir, "projects", COMS_PROJECT, "agents");
		fs.mkdirSync(agentsDir, { recursive: true });
		// Unix-only: 0o700 is meaningless on Windows and throws on restricted
		// filesystems. mkdtemp already isolates tmpRoot under the user's own tmp.
		if (process.platform !== "win32") {
			try {
				fs.chmodSync(comsDir, 0o700);
			} catch {
				// best-effort
			}
		}
		const comsEnv = { ...process.env, PI_COMS_DIR: comsDir, PI_COMS_TIMEOUT_MS: "60000" };

		const registryPath = (name: string) => path.join(agentsDir, `${name}.json`);
		const readEntry = (name: string): RegistryEntry | null => {
			try {
				const parsed = JSON.parse(fs.readFileSync(registryPath(name), "utf8")) as RegistryEntry;
				return parsed && typeof parsed.session_id === "string" ? parsed : null;
			} catch {
				return null;
			}
		};
		// Poll for coms.ts's OWN session_start to write the entry — the registry
		// is the only coordination channel between this script and the peers.
		const waitForEntry = async (name: string): Promise<RegistryEntry | null> => {
			const deadline = Date.now() + REGISTRY_POLL_TIMEOUT_MS;
			while (Date.now() < deadline) {
				const entry = readEntry(name);
				if (entry) return entry;
				await new Promise((r) => setTimeout(r, 250));
			}
			return null;
		};
		// A registry FILE is not proof the peer's socket is accepting — probe a
		// real connection to the advertised endpoint (unix socket / named pipe)
		// with bounded retries before spawning A.
		const probeEndpoint = (endpoint: string): Promise<boolean> =>
			new Promise((resolve) => {
				const sock = net.createConnection({ path: endpoint });
				const t = setTimeout(() => {
					sock.destroy();
					resolve(false);
				}, 500);
				sock.once("connect", () => {
					clearTimeout(t);
					sock.destroy();
					resolve(true);
				});
				sock.once("error", () => {
					clearTimeout(t);
					resolve(false);
				});
			});
		const waitForReady = async (entry: RegistryEntry): Promise<boolean> => {
			for (let i = 0; i < 10; i++) {
				if (await probeEndpoint(entry.endpoint)) return true;
				await new Promise((r) => setTimeout(r, 250));
			}
			return false;
		};

		// ── Spawn the two real peers. B first (A can only coms_send a registered
		// target); B's prompt keeps its turn alive via `sleep` so the inbound
		// prompt lands while the process is still running.
		const runB = startPi(
			[
				"-e",
				COMS_EXT,
				"--mode",
				"json",
				...modelArgs(),
				"--cname",
				"smoke-b",
				"--project",
				COMS_PROJECT,
				"-p",
				'You are agent smoke-b in a coms smoke test. First call the bash tool with command "sleep 25" to stay available. Then reply with exactly: done-waiting. If you receive a coms message from smoke-a, answer it briefly and directly.',
			],
			{ timeoutMs: SPAWN_TIMEOUT_MS, env: comsEnv },
		);
		procB = runB.proc;
		let bClosedAt: number | null = null;
		runB.done.then(() => {
			bClosedAt = Date.now();
		});
		const entryB = await waitForEntry("smoke-b");
		if (!entryB) {
			killTree(runB.proc, "SIGTERM");
			await runB.done;
			record({
				name: "socket_registry_two_agents",
				ok: false,
				detail: "smoke-b never wrote its registry entry (coms.ts session_start did not complete)",
			});
			record({
				name: "socket_live_round_trip",
				ok: false,
				skipped: "no registered peer — exchange not attempted",
			});
			return result;
		}
		// Readiness is a real connection to B's endpoint, not the registry file.
		if (!(await waitForReady(entryB))) {
			killTree(runB.proc, "SIGTERM");
			await runB.done;
			record({
				name: "socket_registry_two_agents",
				ok: false,
				detail:
					"smoke-b registered (registry entry written by coms.ts session_start) but smoke-a was never spawned — B's endpoint never accepted a connection",
			});
			record({
				name: "socket_peer_b_ready",
				ok: false,
				detail:
					"smoke-b's registry entry exists but its endpoint never accepted a connection after 10×250ms (readiness is not registry-file presence)",
			});
			record({
				name: "socket_live_round_trip",
				ok: false,
				skipped: "peer B never became connectable — exchange not attempted",
			});
			return result;
		}
		record({
			name: "socket_peer_b_ready",
			ok: true,
			detail: "smoke-b accepting connections on its advertised endpoint",
		});

		const runA = startPi(
			[
				"-e",
				COMS_EXT,
				"--mode",
				"json",
				...modelArgs(),
				"--cname",
				"smoke-a",
				"--project",
				COMS_PROJECT,
				"-p",
				`You are agent smoke-a in a coms smoke test. Call the coms_send tool with target "smoke-b" and prompt "ping from smoke-a — reply with exactly: pong". Then call the coms_await tool with the returned msg_id and timeout_ms ${AWAIT_TIMEOUT_MS}. Finally report, in one short sentence, the reply you received (or the error).`,
			],
			{ timeoutMs: SPAWN_TIMEOUT_MS, env: comsEnv },
		);
		procA = runA.proc;
		let aClosedAt: number | null = null;
		runA.done.then(() => {
			aClosedAt = Date.now();
		});
		const entryA = await waitForEntry("smoke-a");
		const [outA, outB] = await Promise.all([runA.done, runB.done]);

		// ── Real registrations: entries written by coms.ts's session_start,
		// captured from the live registry BEFORE the peers' cleanShutdown
		// removes them on exit. On POSIX the entry's pid must be the spawned
		// process's pid — proof the registration came from our real peer.
		const pidOk = (entry: RegistryEntry | null, proc: ChildProcess): boolean =>
			process.platform === "win32" ||
			(entry !== null && typeof proc.pid === "number" && entry.pid === proc.pid);
		const bothRegistered =
			entryA !== null &&
			entryB !== null &&
			entryA.name === "smoke-a" &&
			entryB.name === "smoke-b" &&
			entryA.session_id !== entryB.session_id &&
			pidOk(entryA, runA.proc) &&
			pidOk(entryB, runB.proc);
		result.registered = [entryA, entryB].filter((e) => e !== null).length;
		record({
			name: "socket_registry_two_agents",
			ok: bothRegistered,
			detail: bothRegistered
				? `2 peers registered by coms.ts session_start in isolated PI_COMS_DIR (smoke-a pid ${entryA?.pid}, smoke-b pid ${entryB?.pid})`
				: `registrations: smoke-a=${entryA ? "yes" : "no"}, smoke-b=${entryB ? "yes" : "no"}, pids match spawned procs: ${pidOk(entryA, runA.proc) && pidOk(entryB, runB.proc)}`,
		});

		// ── INV-2: assert the REAL dir's perms/ownership (the old tmpdir-prefix
		// check was a tautology — mkdtemp output always starts with tmpdir).
		let inv2Ok = comsDir.startsWith(tmpRoot);
		let inv2Detail = `registry confined to ${comsDir}`;
		if (process.platform !== "win32") {
			const st = fs.statSync(comsDir);
			const mode = st.mode & 0o777;
			const ownerOk = typeof process.getuid === "function" && st.uid === process.getuid();
			inv2Ok = inv2Ok && mode === 0o700 && ownerOk;
			inv2Detail += `; dir mode=${mode.toString(8)} uid=${st.uid}`;
		}
		record({ name: "inv2_per_user_isolation", ok: inv2Ok, detail: inv2Detail });

		// ── Envelope shape coverage (C5): build the REAL PromptEnvelope AND
		// ResponseEnvelope shapes from the two real registry entries — Envelope
		// base fields (sender_session, sender_endpoint, timestamp), no `target`
		// field, conversation_id surfaced for correlation, and the
		// post-protocol-change `secret` (required on BOTH prompts and responses
		// since 2026-07-13) read from the TARGET's real registry entry.
		// Round-tripped through JSON only (shape coverage — does NOT count
		// toward messages_exchanged).
		if (entryA && entryB) {
			const envelope = {
				type: "prompt" as const,
				msg_id: ulid(),
				sender_session: entryA.session_id,
				sender_endpoint: entryA.endpoint,
				sender_name: entryA.name,
				sender_cwd: entryA.cwd,
				hops: 0,
				timestamp: new Date().toISOString(),
				prompt: "ping",
				secret: entryB.secret,
				conversation_id: null,
				response_schema: null,
			};
			const response = {
				type: "response" as const,
				msg_id: ulid(),
				sender_session: entryB.session_id,
				sender_endpoint: entryB.endpoint,
				hops: 0,
				timestamp: new Date().toISOString(),
				response: "pong",
				error: null,
				// Post-2026-07-13: responses carry a required `secret` (echo of
				// the prompt's secret) — responses without it are invalid.
				secret: entryB.secret,
				conversation_id: null,
			};
			const roundTripped = JSON.parse(JSON.stringify(envelope)) as typeof envelope;
			const roundTrippedResp = JSON.parse(JSON.stringify(response)) as typeof response;
			// Comment-pinned copy of coms.ts's isValidEnvelope + PromptEnvelope /
			// ResponseEnvelope required fields, post protocol change (2026-07-13):
			// `secret` required on prompts AND responses; conversation_id surfaced
			// in await details; MAX_HOPS is a fixed constant 5. Keep in sync with
			// coms.ts's connHandler validation.
			const shapeOk =
				typeof roundTripped.type === "string" &&
				typeof roundTripped.msg_id === "string" &&
				typeof roundTripped.sender_session === "string" &&
				typeof roundTripped.sender_endpoint === "string" &&
				typeof roundTripped.sender_name === "string" &&
				typeof roundTripped.sender_cwd === "string" &&
				typeof roundTripped.timestamp === "string" &&
				typeof roundTripped.prompt === "string" &&
				typeof roundTripped.hops === "number" &&
				roundTripped.hops < 5 &&
				typeof roundTripped.secret === "string" &&
				roundTripped.secret.length > 0 &&
				// Response envelope: same base + required secret + conversation_id.
				typeof roundTrippedResp.type === "string" &&
				typeof roundTrippedResp.msg_id === "string" &&
				typeof roundTrippedResp.sender_session === "string" &&
				typeof roundTrippedResp.sender_endpoint === "string" &&
				typeof roundTrippedResp.timestamp === "string" &&
				typeof roundTrippedResp.hops === "number" &&
				roundTrippedResp.hops < 5 &&
				typeof roundTrippedResp.secret === "string" &&
				roundTrippedResp.secret.length > 0 &&
				"conversation_id" in roundTrippedResp;
			record({
				name: "socket_envelope_shape_coverage",
				ok: shapeOk,
				detail: shapeOk
					? `real Prompt+ResponseEnvelope shapes (incl. required secret from smoke-b's registry entry) round-tripped through JSON (shape coverage only — does not count toward messages_exchanged/AC1)`
					: `envelope rejected by pinned shape predicate${typeof entryB.secret !== "string" ? " — target registry entry carries no `secret` (envelope-auth protocol change not present in coms.ts)" : ""}`,
			});
		}

		// ── Live exchange evidence, counted ONLY from real pi JSON events.
		const eventsA = parseEvents(outA.stdout);
		const eventsB = parseEvents(outB.stdout);
		const sendEvent = eventsA.find(
			(e) =>
				e.type === "tool_execution_end" &&
				e.toolName === "coms_send" &&
				typeof e.result?.details?.msg_id === "string",
		);
		result.sendAcked = sendEvent !== undefined;
		const awaitEvent = eventsA.find(
			(e) =>
				e.type === "tool_execution_end" &&
				e.toolName === "coms_await" &&
				!e.result?.details?.error &&
				e.result?.details?.response !== undefined &&
				e.result?.details?.response !== null &&
				(typeof e.result?.details?.response !== "string" || e.result.details.response.trim().length > 0),
		);
		// B's own stream: an inbound coms message arrived AND B's agent_end
		// carries assistant text answering it (sub-evidence — the reply still
		// has to make it back to A's coms_await to count as a round-trip).
		result.bAnswered = eventsB.some((e) => {
			if (e.type !== "agent_end" || !Array.isArray(e.messages)) return false;
			const msgs = e.messages;
			const idx = msgs.findIndex(
				(m) => m.role === "custom" || (m as { customType?: string }).customType === "coms-inbound",
			);
			return idx >= 0 && msgs.slice(idx + 1).some((m) => assistantText(m).trim().length > 0);
		});
		const roundTrip =
			result.sendAcked && awaitEvent !== undefined && agentEndWithText(eventsA);
		result.exchanged = roundTrip ? 1 : 0;
		const problems = [outA.error, outB.error].filter((p): p is string => p !== null);
		if (outA.truncated || outB.truncated)
			problems.push("output truncated at cap — diagnostics may be missing");
		// B exiting before A's send completes (e.g. the model skipped the
		// `sleep 25` stay-alive) is a peer-lifecycle miss, not a transport
		// failure — label it as such so the evidence isn't misleading.
		const peerExitedBeforeSend =
			!roundTrip &&
			!result.sendAcked &&
			bClosedAt !== null &&
			aClosedAt !== null &&
			bClosedAt <= aClosedAt;
		const replyText =
			typeof awaitEvent?.result?.details?.response === "string"
				? awaitEvent.result.details.response.trim().slice(0, 60)
				: null;
		record({
			name: "socket_live_round_trip",
			ok: roundTrip,
			detail: roundTrip
				? `coms_send acked (msg_id ${String(sendEvent?.result?.details?.msg_id)}), coms_await returned "${replyText}", agent_end with assistant text in smoke-a's stream`
				: peerExitedBeforeSend
					? `peer_exited_before_send: smoke-b exited before smoke-a's send completed (B's stay-alive turn ended early)${problems.length ? `; spawn problems: ${problems.join("; ")}` : ""}`
					: `send_acked=${result.sendAcked}, smoke-b answered inbound=${result.bAnswered}, coms_await reply received=${awaitEvent !== undefined}${problems.length ? `; spawn problems: ${problems.join("; ")}` : ""}`,
		});

		return result;
	} catch (e) {
		// C8: an fs/spawn failure must not abort the run — record it so the
		// structured report is still emitted with a failed check.
		record({
			name: "socket_path_error",
			ok: false,
			detail: `path B aborted: ${e instanceof Error ? e.message : String(e)}`,
		});
		return result;
	} finally {
		// Belt-and-braces: peers are normally done by here, but never leave a
		// live pi behind, and always remove the per-run temp dir. Kill whole
		// process GROUPS (grandchildren included), await close (bounded) so
		// rmSync never races a live pi, and never let a cleanup failure mask
		// the run result.
		for (const p of [procA, procB]) {
			if (p) killTree(p, "SIGKILL");
		}
		await Promise.all([waitForClose(procA, 3_000), waitForClose(procB, 3_000)]);
		try {
			fs.rmSync(tmpRoot, { recursive: true, force: true });
		} catch {
			// cleanup failure must not mask the run result
		}
	}
}

// ── Run ─────────────────────────────────────────────────────────────────────
let pinnedVersion: string | null = null;
let modelsComs = 0;
let modelsComsNet = 0;
const rpc = { registered: 0, exchanged: 0, spawn_errors: 0 };
const socket = { registered: 0, exchanged: 0, sendAcked: false, bAnswered: false };

try {
	pinnedVersion = checkPiVersion();
	if (pinnedVersion) {
		modelsComs = checkExtensionLoads(COMS_EXT, "ac3_extension_loads_coms");
		modelsComsNet = checkExtensionLoads(COMS_NET_EXT, "ac3_extension_loads_coms_net");
	} else {
		record({
			name: "ac3_extension_loads_coms",
			ok: false,
			skipped: "pi version mismatch — extension load not attempted",
		});
		record({
			name: "ac3_extension_loads_coms_net",
			ok: false,
			skipped: "pi version mismatch — extension load not attempted",
		});
	}
	const [rpcResult, socketResult] = await Promise.all([pathSubprocessRpc(), pathSocketComs()]);
	rpc.registered = rpcResult.registered;
	rpc.exchanged = rpcResult.exchanged;
	rpc.spawn_errors = rpcResult.spawn_errors;
	socket.registered = socketResult.registered;
	socket.exchanged = socketResult.exchanged;
	socket.sendAcked = socketResult.sendAcked;
	socket.bAnswered = socketResult.bAnswered;
} catch (e) {
	// C8: nothing above may prevent the structured report from being emitted.
	record({
		name: "smoke_test_internal_error",
		ok: false,
		detail: `unhandled: ${e instanceof Error ? e.message : String(e)}`,
	});
}

const totalRegistered = rpc.registered + socket.registered;
const totalExchanged = rpc.exchanged + socket.exchanged;
// Make-or-break (AC1): Path A produced a real agent_end round-trip AND Path B
// registered ≥2 real peers via coms.ts's own session_start. The Path B live
// exchange (socket_live_round_trip) is reported with real evidence but is NOT
// gating by default (PI_SMOKE_STRICT=1 makes it gating) — AC1's message
// clause is satisfied by either substrate (the story's OR clause) and the
// model-driven reply depends on two live agents' timing.
const rpcRoundTrip = checks.find((c) => c.name === "rpc_live_round_trip")?.ok === true;
const socketRegistered = checks.find((c) => c.name === "socket_registry_two_agents")?.ok === true;
const acMakeOrBreak = rpcRoundTrip && socketRegistered;
// socket_live_round_trip is advisory-only by default (AC1's message clause is
// satisfied by either substrate and the model-driven reply depends on two
// live agents' timing); PI_SMOKE_STRICT=1 makes it gating. SKIPPABLE is the
// ONLY check name whose skip may satisfy the gate — an arbitrary skipped
// check can no longer launder a failure.
const STRICT = process.env.PI_SMOKE_STRICT === "1";
const SKIPPABLE = new Set(["socket_live_round_trip"]);
const gatingChecks = checks.filter((c) => STRICT || c.name !== "socket_live_round_trip");

const report = {
	story: "p0-2-coms-vendor-decision",
	pi_version: pinnedVersion ?? "MISMATCH",
	pinned: pinnedVersion === PIN,
	smoke_model: SMOKE_MODEL ?? "pi-default",
	models_listed: modelsComs,
	models_listed_coms_net: modelsComsNet,
	paths: {
		subprocess_rpc: rpc,
		socket_coms: socket,
	},
	agents_registered: totalRegistered,
	messages_exchanged: totalExchanged,
	ac_map: {
		"AC1_make_or_break_rpc_roundtrip_+_>=2socket_peers": acMakeOrBreak,
		AC3_extension_loads_coms: checks.find((c) => c.name === "ac3_extension_loads_coms")?.ok ?? false,
		AC3_extension_loads_coms_net:
			checks.find((c) => c.name === "ac3_extension_loads_coms_net")?.ok ?? false,
	},
	checks,
	gate_note: STRICT
		? "PI_SMOKE_STRICT=1: socket_live_round_trip is gating"
		: "socket_live_round_trip is advisory-only (excluded from the gate) unless PI_SMOKE_STRICT=1",
	redaction: "env-secret-values",
	// Gate = every gating check passed (skipped ≠ passed except for SKIPPABLE
	// names; rpc_live_round_trip must be ok===true, so an auth skip fails the
	// gate honestly) AND AC1 make-or-break holds. Exit 0 only when AC1 is
	// backed by a real message exchange — no waivers.
	pass:
		gatingChecks.every((c) => c.ok || (!STRICT && c.skipped !== undefined && SKIPPABLE.has(c.name))) &&
		acMakeOrBreak,
};

// Synchronous write + natural exit: process.exit() right after a large
// console.log can truncate the piped JSON report.
try {
	fs.writeSync(1, `${JSON.stringify(report, null, 2)}\n`);
} catch {
	// Consumer closed the pipe early (EPIPE/EBADF) — the run already
	// completed; exit code still reflects report.pass.
}
process.exitCode = report.pass ? 0 : 1;
