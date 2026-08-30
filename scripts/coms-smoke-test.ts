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
 * reported PASS/FAIL with real evidence and IS gating by default (STRICT);
 * an explicit PI_SMOKE_STRICT=0 waives ONLY that check — AC1's message clause
 * is satisfied by either substrate (story OR clause), and the model-driven
 * reply depends on two live agents' turn timing. A waived failure is flagged
 * loudly in the report (`pass_with_waiver: true`).
 *
 * Model override: set PI_SMOKE_MODEL to pin the model used by every spawned
 * pi (passed through as `--model`) — e.g. when the default provider's auth is
 * expired: PI_SMOKE_MODEL=openrouter/anthropic/claude-haiku-4.5. Unset → pi's
 * configured default model.
 *
 * INV-1: no real API keys are written or logged — child pi processes receive
 *        a MINIMAL ALLOWLIST env (PATH, HOME, USER, LOGNAME, SHELL, TERM,
 *        LANG, LC_*, TMPDIR, TMP, TEMP — win32 adds SystemRoot, USERPROFILE,
 *        APPDATA, LOCALAPPDATA, PATHEXT, ComSpec, OS, PROCESSOR_ARCHITECTURE,
 *        matched case-insensitively — plus only the one provider key implied
 *        by PI_SMOKE_MODEL's provider prefix). If no provider key can be
 *        identified the run FAILS CLOSED with an `env_scope` error (F013);
 *        the full-env fallback is opt-in only, via PI_SMOKE_ALLOW_FULL_ENV=1,
 *        and the report says so (`env_scope`). Captured pi output is redacted
 *        for ambient secret-looking env values before anything enters the
 *        report (defense-in-depth).
 * INV-2: Path B spawns run with PI_COMS_DIR pointed at a per-run temp dir
 *        (0700), so spawned pi registry writes are confined there and the
 *        host's ~/.pi/coms is never mutated. Path A spawns likewise get an
 *        isolated PI_COMS_DIR so a host-global coms extension can't touch the
 *        real registry (pi has no no-global-extensions flag in 0.55.0).
 *
 * Usage:
 *   PI_SMOKE_MODEL=openrouter/anthropic/claude-haiku-4.5 bun scripts/coms-smoke-test.ts
 *   # or, to deliberately pass the FULL ambient env to the spawned pi processes:
 *   PI_SMOKE_ALLOW_FULL_ENV=1 bun scripts/coms-smoke-test.ts
 *
 *   Exit 2 = env_scope refusal (F013): the message on stderr says which
 *   provider key is missing. Nothing was spawned and no report is written.
 */

import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import {
	collectSecretValues,
	killTree,
	redact as redactSecrets,
	ulid,
	win32ShellArgs,
} from "./lib/coms-smoke-helpers.ts";

const VENDOR_DIR = path.join(import.meta.dir, "..", "pi-vs-claude-code-vendor");
const COMS_EXT = path.join(VENDOR_DIR, "coms.ts");
const COMS_NET_EXT = path.join(VENDOR_DIR, "coms-net.ts");
const PIN = "0.55.0";

// Model override for every spawned pi — see header (PI_SMOKE_MODEL).
const SMOKE_MODEL = process.env.PI_SMOKE_MODEL?.trim() || null;
const modelArgs = (): string[] => (SMOKE_MODEL ? ["--model", SMOKE_MODEL] : []);

// Per `pi -p` spawn (either path). Must outlive B's full round-trip: B's
// followUp answer only runs AFTER its sleep-60 stay-alive turn ends (pi 0.55.0
// runs followUps inside the same runLoop — verified in pi-agent-core's
// agent-loop.js), so B replies at ~70-90s after boot; A then needs its own
// boot + model + coms_await window on top. 90s killed slow-but-healthy runs.
const SPAWN_TIMEOUT_MS = 240_000;
const EXT_LOAD_TIMEOUT_MS = 60_000;
// `pi --version` also loads global extensions before printing; 10s proved
// flaky under load (ETIMEDOUT with four peers spawning), so keep 30s.
const VERSION_TIMEOUT_MS = 30_000;
// B must boot pi + load the extension + run session_start before its registry
// entry appears; a 30s poll budget ≪ the 90s spawn timeout false-failed
// slow-but-healthy boots, so poll for 2/3 of the spawn timeout (C10).
const REGISTRY_POLL_TIMEOUT_MS = Math.floor((SPAWN_TIMEOUT_MS * 2) / 3);
// pi's JSON event stream includes full message snapshots per delta; 1 MiB
// (spawnSync's default) is not enough for a chatty turn.
const MAX_OUTPUT_BYTES = 16 * 1024 * 1024;
const COMS_PROJECT = "smoke"; // isolated project namespace for Path B peers
// coms_await budget inside agent A's prompt. Must cover B's answer latency:
// B's followUp turn runs only after its sleep-60 turn ends, so the reply lands
// ~70-90s after B's boot; A's await starts ~30-40s after B's boot. 45s made
// the round-trip a model-latency coin flip (two consecutive red runs 2026-07-14).
const AWAIT_TIMEOUT_MS = 150_000;
// Mirrored from coms.ts (READ-ONLY contract) for the raw-socket negative
// probes: the per-line transport cap (connHandler) and the fixed hop cap
// (handlePrompt nacks hops >= MAX_HOPS). Keep in sync with coms.ts.
const COMS_LINE_CAP_BYTES = 16 * 1024 * 1024;
const COMS_MAX_HOPS = 5;
// Raw-socket probe STALL budget — see probeNack. The old budget was 5 s of
// TOTAL wall clock, which the oversize probe cannot satisfy by construction:
// it must deliver COMS_LINE_CAP_BYTES and then wait for a starved peer to
// parse them, so the budget scaled with machine load rather than with peer
// health. This one bounds a different quantity — "the socket moved no bytes
// at all", i.e. the peer is GONE rather than merely slow — so the value is
// re-derived for that meaning instead of inherited: it matches
// VERSION_TIMEOUT_MS, the smallest peer-liveness budget this script already
// uses, and sits ~6x above the worst stall measured under 2x-oversubscribed
// CPU (5.1 s, with all 16 MiB confirmed flushed).
const PROBE_IDLE_MS = 30_000;
// Expected reply tokens for content verification (C2): Path A's prompt says
// "Reply with exactly: ok"; Path B's relayed prompt says "reply with exactly:
// pong". Case-insensitive whole-word match against the best available text.
const RPC_REPLY_TOKEN = "ok";
const SOCKET_REPLY_TOKEN = "pong";

// ── Report hygiene: ambient secrets must never leak into the JSON report.
//    Any process.env value whose key has a secret-bearing SEGMENT (≥8 chars,
//    to skip noise like "true") is redacted from captured pi output before it
//    is embedded in the report. See scripts/lib/coms-smoke-helpers.ts for the
//    matching rules and their known limits; unit-tested in
//    tests/scripts/coms-smoke-helpers.test.ts. ─────────────────────────────
const SECRET_VALUES = collectSecretValues();
const redact = (s: string): string => redactSecrets(s, SECRET_VALUES);

// ── INV-1 (C6): child pi env is an ALLOWLIST, not a copy of process.env. ────
// Only the one provider key implied by PI_SMOKE_MODEL's provider prefix is
// forwarded. If the key can't be identified (no model override, unknown
// provider, or the key simply isn't set) we FAIL CLOSED (F013): passing the
// full ambient env to two spawned pi processes requires the operator to opt in
// with PI_SMOKE_ALLOW_FULL_ENV=1, which the report records in `env_scope`.
// Redaction above stays as defense-in-depth.
const ENV_ALLOWLIST = ["PATH", "HOME", "USER", "LOGNAME", "SHELL", "TERM", "LANG", "TMPDIR", "TMP", "TEMP"];
// win32 children additionally need SystemRoot (DNS/winsock/crypto RNG init),
// USERPROFILE (pi's config dir), Path+PATHEXT (their own tool spawns), etc.
// Windows env keys are case-INSENSITIVE — conventionally `Path`, not `PATH`,
// and Node preserves the casing — so on win32 membership is compared
// uppercased against the combined list. POSIX keeps the exact-case match
// against ENV_ALLOWLIST alone (unchanged behavior).
const ENV_ALLOWLIST_WIN32_EXTRA = [
	"SystemRoot",
	"USERPROFILE",
	"APPDATA",
	"LOCALAPPDATA",
	"PATHEXT",
	"ComSpec",
	"OS",
	"PROCESSOR_ARCHITECTURE",
];
const ENV_ALLOWLIST_WIN32_UPPER = [...ENV_ALLOWLIST, ...ENV_ALLOWLIST_WIN32_EXTRA].map((k) => k.toUpperCase());
const PROVIDER_KEYS: Record<string, string[]> = {
	anthropic: ["ANTHROPIC_API_KEY"],
	openrouter: ["OPENROUTER_API_KEY"],
	openai: ["OPENAI_API_KEY"],
	google: ["GOOGLE_API_KEY", "GEMINI_API_KEY"],
};
/** True iff `k` is a base (non-provider-key) allowlist member for this platform. */
export function isAllowlistedEnvKey(k: string, platform: NodeJS.Platform = process.platform): boolean {
	if (k.startsWith("LC_")) return true;
	return platform === "win32"
		? ENV_ALLOWLIST_WIN32_UPPER.includes(k.toUpperCase())
		: ENV_ALLOWLIST.includes(k);
}
/**
 * Build the child pi env (INV-1). FAILS CLOSED (F013): when no provider key can
 * be identified the full ambient env is NOT passed through unless the operator
 * explicitly opts in with PI_SMOKE_ALLOW_FULL_ENV=1 — otherwise this throws and
 * the run never spawns. `env` is a parameter so tests need not mutate process.env.
 */
export function smokeChildEnv(env: NodeJS.ProcessEnv = process.env): {
	env: NodeJS.ProcessEnv;
	scope: string;
} {
	const model = env.PI_SMOKE_MODEL?.trim() || null;
	const base: NodeJS.ProcessEnv = {};
	for (const [k, v] of Object.entries(env)) {
		if (v === undefined) continue;
		if (isAllowlistedEnvKey(k)) base[k] = v;
	}
	// The full-env fallback ships EVERY ambient credential to two spawned pi
	// processes, so it is opt-in only; without the opt-in we refuse to run.
	const fullEnvOptIn = env.PI_SMOKE_ALLOW_FULL_ENV === "1";
	const failClosed = (why: string): never => {
		throw new Error(
			`env_scope: refusing the full-env fallback — ${why}. Set PI_SMOKE_MODEL to a provider-prefixed model whose key is in the env (${Object.keys(PROVIDER_KEYS).join("/")}), or set PI_SMOKE_ALLOW_FULL_ENV=1 to deliberately pass the FULL ambient env (every credential) to the spawned pi processes.`,
		);
	};
	const provider = model?.split("/")[0]?.toLowerCase() ?? ""; // dp:ok "" is the no-provider sentinel: PROVIDER_KEYS[""] is undefined, which is what drives the fail-closed refusal below
	const keys = PROVIDER_KEYS[provider];
	if (!keys) {
		const why = `no provider key identifiable for model "${model ?? "pi-default"}"`;
		if (!fullEnvOptIn) failClosed(why);
		return { env: { ...env }, scope: `full-env fallback (PI_SMOKE_ALLOW_FULL_ENV=1) — ${why}` };
	}
	let forwarded = 0;
	for (const k of keys) {
		const v = env[k];
		if (v) {
			base[k] = v;
			forwarded += 1;
		}
	}
	if (forwarded === 0) {
		const why = `provider "${provider}" key(s) ${keys.join("/")} not present in env`;
		if (!fullEnvOptIn) failClosed(why);
		return { env: { ...env }, scope: `full-env fallback (PI_SMOKE_ALLOW_FULL_ENV=1) — ${why}` };
	}
	const allowlistNote =
		process.platform === "win32"
			? "PATH/SystemRoot/USERPROFILE/APPDATA/LOCALAPPDATA/PATHEXT/ComSpec/OS/PROCESSOR_ARCHITECTURE/TMP/TEMP (win32 case-insensitive)"
			: "PATH/HOME/USER/LOGNAME/SHELL/TERM/LANG/LC_*/TMPDIR/TMP/TEMP";
	return {
		env: base,
		scope: `allowlist (${keys.filter((k) => base[k]).join("+")} + ${allowlistNote})`,
	};
}
// Lazy + memoized: smokeChildEnv() can THROW (F013 fail-closed), so it must not
// run at module load — the file has to stay importable for unit tests (F014).
let _childEnv: { env: NodeJS.ProcessEnv; scope: string } | null = null;
const childEnv = (): { env: NodeJS.ProcessEnv; scope: string } => {
	_childEnv ??= smokeChildEnv();
	return _childEnv;
};

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
	const r = spawnSync("pi", win32ShellArgs(["--version"]), {
		encoding: "utf8",
		timeout: VERSION_TIMEOUT_MS,
		maxBuffer: MAX_OUTPUT_BYTES,
		env: childEnv().env,
		shell: process.platform === "win32",
	});
	const problem = spawnProblem(r);
	// pi may print extension-load warnings around the version; accept ONLY a
	// line that is exactly the pinned version (after trim, optional leading v,
	// optional trailing build suffix like " (built 2026-01-01)") — never
	// fuzzy-match a version string inside a warning line. A non-zero exit with
	// a version line is still a failure: a broken pi must not pass the pin (C13).
	const version =
		(r.stdout ?? "")
			.split("\n")
			.map((l) => l.trim())
			.find((l) => new RegExp(`^v?${PIN.replace(/\./g, "\\.")}(\\s*\\(.*\\))?$`).test(l))
			?.replace(/^v/, "")
			.replace(/\s*\(.*\)$/, "") ?? "";
	record({
		name: "pi_version_pin",
		ok: !problem && r.status === 0 && version === PIN,
		detail:
			problem ??
			(r.status !== 0
				? `pi --version exited ${r.status} (version line alone does not pass the pin)`
				: version === PIN
					? `found "${PIN}"`
					: `no line exactly "${PIN}" (or "v${PIN}", optional build suffix) on stdout — pin mismatch`),
	});
	return !problem && r.status === 0 && version === PIN ? version : null;
}

// ── AC3: a vendored extension loads on pinned pi (`-e ./ext --list-models`) ──
function checkExtensionLoads(extPath: string, checkName: string): number {
	const r = spawnSync("pi", win32ShellArgs(["-e", extPath, "--list-models"]), {
		encoding: "utf8",
		cwd: VENDOR_DIR,
		timeout: EXT_LOAD_TIMEOUT_MS,
		maxBuffer: MAX_OUTPUT_BYTES,
		env: childEnv().env,
		shell: process.platform === "win32",
	});
	const problem = spawnProblem(r);
	// Model rows are "<provider> <model> …" lines under a "provider model …"
	// header. Count ANY non-header data row (≥2 whitespace-separated tokens)
	// — a provider whitelist would false-fail AC3 for any other provider (C12).
	const lines = (r.stdout ?? "")
		.split("\n")
		.map((l) => l.trim())
		.filter(Boolean);
	const headerIdx = lines.findIndex((l) => /^provider\s/i.test(l));
	const hasHeader = headerIdx >= 0;
	const modelCount = hasHeader
		? lines.slice(headerIdx + 1).filter((l) => /^\S+\s+\S+/.test(l)).length
		: 0;
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
export interface SpawnOutcome {
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

// ── Signal cleanup (C8): Ctrl-C / SIGTERM must not leak the detached pi
//    process groups or the per-run temp dirs. startPi registers every child;
//    temp dirs are registered at creation and removed after normal cleanup.
const activeProcs = new Set<ChildProcess>();
const activeTmpDirs = new Set<string>();
{
	const cleanup = (sig: NodeJS.Signals) => {
		for (const p of activeProcs) killTree(p, "SIGKILL");
		for (const d of activeTmpDirs) {
			try {
				fs.rmSync(d, { recursive: true, force: true });
			} catch {
				// best-effort — the run is being torn down
			}
		}
		process.exit(sig === "SIGINT" ? 130 : 143);
	};
	process.once("SIGINT", () => cleanup("SIGINT"));
	process.once("SIGTERM", () => cleanup("SIGTERM"));
}

function startPi(
	args: string[],
	opts: { timeoutMs: number; env?: NodeJS.ProcessEnv },
): { proc: ChildProcess; done: Promise<SpawnOutcome> } {
	const isWin = process.platform === "win32";
	// shell:true is UNAVOIDABLE on win32 here (bare `pi` is a .cmd shim —
	// CVE-2024-27980), so args go through the shared win32ShellArgs quoting;
	// the full safety model (quote parity + `%!`/CR/LF rejection) lives there.
	const finalArgs = win32ShellArgs(args);
	const proc = spawn("pi", finalArgs, {
		cwd: VENDOR_DIR,
		// INV-1: scoped allowlist env by default (see smokeChildEnv), never a
		// blind copy of the parent's live keyring (C6).
		env: opts.env ?? childEnv().env,
		shell: isWin,
		// Own process group on POSIX so killTree can sweep grandchildren.
		detached: !isWin,
		stdio: ["ignore", "pipe", "pipe"],
	});
	activeProcs.add(proc);
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
				// Same two-phase escalation as the timeout path: a SIGTERM-
				// ignoring child gets 5s before SIGKILL instead of stalling
				// the run to the full timeout (C9).
				if (!forceTimer)
					forceTimer = setTimeout(() => {
						killTree(proc, "SIGKILL");
					}, 5_000);
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
			activeProcs.delete(proc);
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
export interface PiEvent {
	type?: string;
	toolName?: string;
	result?: { content?: Array<{ type?: string; text?: string }>; details?: Record<string, unknown> };
	messages?: Array<Record<string, unknown>>;
	[k: string]: unknown;
}

export function parseEvents(stdout: string): PiEvent[] {
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
	// Tolerate the session-branch wrapper shape (coms.ts's branch entries are
	// {type:"message", message:{role, content}}) as well as plain messages —
	// the JSON stream's agent_end `messages` shape isn't pinned by the
	// vendored code, so accept both rather than silently seeing no text.
	const m = (
		msg.role === undefined && msg.message !== null && typeof msg.message === "object"
			? msg.message
			: msg
	) as Record<string, unknown>;
	if (!m || m.role !== "assistant") return "";
	if (typeof m.content === "string") return m.content;
	if (Array.isArray(m.content)) {
		return m.content
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

// Concatenated assistant text across all agent_end snapshots — the evidence
// for reply-content verification (C2). Case-insensitive whole-word token
// match so "OK." / "ok!" / "pong" all count but "broken" doesn't.
function agentEndText(events: PiEvent[]): string {
	const texts: string[] = [];
	for (const e of events) {
		if (e.type !== "agent_end" || !Array.isArray(e.messages)) continue;
		for (const m of e.messages) {
			const t = assistantText(m).trim();
			if (t) texts.push(t);
		}
	}
	return texts.join("\n");
}
function containsToken(text: string, token: string): boolean {
	return new RegExp(`\\b${token}\\b`, "i").test(text);
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
export function detectAuthFailure(out: SpawnOutcome, events: PiEvent[]): boolean {
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
	replyContentVerified: boolean;
}> {
	// A "registered" agent on this path = one spawned pi subprocess whose JSON
	// stream opened (the session header is the RPC handshake) AND which did not
	// already error/time out — a dying process must not inflate the count. We
	// spawn two, concurrently. PI_COMS_DIR is isolated even here (no -e flag):
	// a host-global coms extension in ~/.pi must not touch the real registry
	// (C5 — pi 0.55.0 has no no-global-extensions flag).
	const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "coms-smoke-rpc-"));
	activeTmpDirs.add(tmpRoot);
	// Hoisted OUTSIDE the try and filled incrementally (not .map, whose result
	// is lost if the callback throws mid-loop) so the finally can sweep every
	// spawned child. The sweep matters on the EXCEPTION path only: startPi's
	// per-child self-kill timeout lives in THIS process, so if an exception
	// (e.g. a win32 arg rejection, an fs error) unwinds us toward process exit
	// while a detached child is still running, that timeout dies with the
	// parent and the child is orphaned. Mirror pathSocketComs's finally:
	// kill + bounded close-wait before rmSync, so rmSync never races a live
	// pi. On the happy path every child has already closed, so the kill is a
	// no-op (ESRCH-tolerant) and the wait resolves immediately.
	const runs: Array<{ proc: ChildProcess; done: Promise<SpawnOutcome> }> = [];
	try {
		const envA = { ...childEnv().env, PI_COMS_DIR: path.join(tmpRoot, "coms") };
		for (const cname of ["smoke-rpc-a", "smoke-rpc-b"]) {
			runs.push(
				startPi(["--mode", "json", ...modelArgs(), "-p", `You are ${cname}. Reply with exactly: ok`], {
					timeoutMs: SPAWN_TIMEOUT_MS,
					env: envA,
				}),
			);
		}
		const outcomes = await Promise.all(runs.map((r) => r.done));

		let registered = 0;
		let exchanged = 0;
		let spawn_errors = 0;
		let authFailed = false;
		let replyContentVerified = false;
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
			// A completed round-trip needs a real model turn (agent_end with text)
			// AND the reply must contain the expected token (C2): the prompt said
			// "Reply with exactly: ok" — any assistant text is not enough.
			if (agentEndWithText(events)) {
				if (containsToken(agentEndText(events), RPC_REPLY_TOKEN)) {
					exchanged += 1;
					replyContentVerified = true;
				} else {
					problems.push(`agent_end assistant text did not contain expected token "${RPC_REPLY_TOKEN}"`);
				}
			}
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
				detail: `${exchanged} agent_end round-trip(s) with assistant text containing "${RPC_REPLY_TOKEN}" (content verified)`,
			});
		} else if (authFailed) {
			record({
				name: "rpc_live_round_trip",
				ok: false,
				skipped:
					"pi auth unavailable — no verified agent_end observed and an auth failure was detected in pi output",
				detail:
					"transport parse verified; live turn requires pi auth (or set PI_SMOKE_MODEL to an authed provider/model)",
			});
		} else {
			record({
				name: "rpc_live_round_trip",
				ok: false,
				detail: `no agent_end with assistant text containing "${RPC_REPLY_TOKEN}" in either stream${problems.length ? `; problems: ${problems.join("; ")}` : ""}`,
			});
		}

		return { registered, exchanged, spawn_errors, replyContentVerified };
	} finally {
		// Belt-and-braces, mirroring pathSocketComs: on the exception path a
		// spawned peer can still be alive — never leave a live pi behind, and
		// await close (bounded) so the rmSync below never races one.
		for (const r of runs) killTree(r.proc, "SIGKILL");
		await Promise.all(runs.map((r) => waitForClose(r.proc, 3_000)));
		activeTmpDirs.delete(tmpRoot);
		try {
			fs.rmSync(tmpRoot, { recursive: true, force: true });
		} catch {
			// cleanup failure must not mask the run result
		}
	}
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

/** The counters pathSocketComs reports (F081: named so the extracted
 * evidence pass can take them as a parameter). */
interface SocketComsResult {
	registered: number;
	exchanged: number;
	sendAcked: boolean;
	bAnsweredObserved: boolean;
	replyContentVerified: boolean;
}

const registryPath = (agentsDir: string, name: string) => path.join(agentsDir, `${name}.json`);
function readRegistryEntry(agentsDir: string, name: string): RegistryEntry | null {
	try {
		const parsed = JSON.parse(fs.readFileSync(registryPath(agentsDir, name), "utf8")) as RegistryEntry; // dp:ok already inside this function's try/catch (a bad registry file returns null); the D020 depth walker mis-tracks this file
		return parsed && typeof parsed.session_id === "string" ? parsed : null;
	} catch {
		return null;
	}
}
// Poll for coms.ts's OWN session_start to write the entry — the registry
// is the only coordination channel between this script and the peers.
// Race the poll against the peer's exit: a dead peer will never write
// its entry, so don't burn the full poll budget on it (C5). Use 'exit'
// not 'close' — 'close' is delayed when a grandchild (e.g. the bash tool's
// `sleep 60` in smoke-b) inherits and holds the pipe stdio open after the
// pi process itself has terminated, which would hang this loop for the
// full poll budget. 'exit' fires the moment the peer dies regardless.
async function waitForRegistryEntry(
	agentsDir: string,
	name: string,
	proc: ChildProcess,
): Promise<RegistryEntry | null> { // dp:ok smoke-script helper — a rejection aborts the gate run with a stack, which is the intended failure mode
	let exited = proc.exitCode !== null || proc.signalCode !== null;
	const onExit = new Promise<void>((r) => {
		if (exited) r();
		else
			proc.once("exit", () => {
				exited = true;
				r();
			});
	});
	const deadline = Date.now() + REGISTRY_POLL_TIMEOUT_MS;
	while (Date.now() < deadline) {
		const entry = readRegistryEntry(agentsDir, name);
		if (entry) return entry;
		if (exited) break;
		await Promise.race([new Promise((r) => setTimeout(r, 250)), onExit]);
	}
	// Final UNCONDITIONAL read: an entry written during the last poll
	// window (or by a peer that registered on its way out) must not be
	// missed (C10).
	return readRegistryEntry(agentsDir, name);
}
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
async function waitForReady(entry: RegistryEntry): Promise<boolean> { // dp:ok smoke-script helper — a rejection aborts the gate run with a stack, which is the intended failure mode
	for (let i = 0; i < 10; i++) {
		if (await probeEndpoint(entry.endpoint)) return true;
		await new Promise((r) => setTimeout(r, 250));
	}
	return false;
}

// INV-2 check, extracted so the early-failure returns record the SAME
// check set as the main path (C15). Assert the REAL dir's perms/
// ownership (the old tmpdir-prefix check was a tautology — mkdtemp
// output always starts with tmpdir). Path B is POSIX-only: coms.ts
// fails fast on win32 (no named-pipe ACL equivalent of the 0700 socket
// dir), so on win32 this is a best-effort confinement note rather than
// a perms assertion — never a silent tautology (C14).
function recordInv2(comsDir: string, tmpRoot: string): void {
	let inv2Ok = comsDir.startsWith(tmpRoot);
	let inv2Detail = `registry confined to ${comsDir}`;
	if (process.platform !== "win32") {
		const st = fs.statSync(comsDir);
		const mode = st.mode & 0o777;
		const ownerOk = typeof process.getuid === "function" && st.uid === process.getuid();
		inv2Ok = inv2Ok && mode === 0o700 && ownerOk;
		inv2Detail += `; dir mode=${mode.toString(8)} uid=${st.uid}`;
	} else {
		inv2Detail += "; win32: perms assertion n/a (coms.ts is POSIX-only and fails fast there)";
	}
	record({ name: "inv2_per_user_isolation", ok: inv2Ok, detail: inv2Detail });
}

// ── Raw-socket negative probes (C4): auth-free checks against B's LIVE
//    endpoint exercising coms.ts's REAL server-side validation — no
//    model auth needed, so these gate unconditionally. Each probe opens
//    a raw net socket and asserts a single JSON-line nack (coms.ts's
//    nack framing: {"type":"nack","msg_id":…,"error":…}\n). ────────────
const probeNack = (
	endpoint: string,
	payload: string | Buffer,
	expectError: string,
): Promise<{ ok: boolean; detail: string }> =>
	new Promise((resolve) => {
		const sock = net.createConnection({ path: endpoint });
		const chunks: Buffer[] = [];
		let connected = false;
		let settled = false;
		const started = Date.now();
		const finish = (ok: boolean, detail: string) => {
			if (settled) return;
			settled = true;
			clearInterval(tick);
			sock.destroy();
			resolve({ ok, detail });
		};
		// The budget is STALL, not total wall clock. The oversize probe
		// must push a full COMS_LINE_CAP_BYTES down the socket before
		// coms.ts can see the cap exceeded and nack, so a deadline
		// measured from connect was really a bulk-transfer budget: it
		// scaled with machine load and went red under CPU contention
		// while coms.ts was behaving correctly (#72).
		//
		// Progress is SAMPLED from the socket's own counters, not driven by
		// events: a single 16 MiB write emits exactly one 'drain' — when
		// the whole userspace buffer has finally flushed — so events
		// cannot tell "streaming against a descheduled peer" apart from
		// "peer is gone". `bytesWritten` alone would not either, since it
		// counts bytes handed to write() including those still queued;
		// subtracting `writableLength` leaves the bytes the kernel has
		// actually taken, which advances only as the peer drains them.
		const flushed = () => sock.bytesWritten - sock.writableLength + sock.bytesRead;
		let lastProgressAt = Date.now();
		let lastBytes = -1;
		const tick = setInterval(() => {
			if (settled) return;
			const moved = flushed();
			if (moved !== lastBytes) {
				lastBytes = moved;
				lastProgressAt = Date.now();
				return;
			}
			if (Date.now() - lastProgressAt >= PROBE_IDLE_MS) {
				finish(
					false,
					`no nack line: the socket moved no bytes for ${Date.now() - lastProgressAt}ms against a ${PROBE_IDLE_MS}ms stall budget (observed ${Date.now() - started}ms total, ${sock.bytesWritten - sock.writableLength}/${typeof payload === "string" ? Buffer.byteLength(payload) : payload.length} bytes flushed, ${sock.bytesRead} read)`,
				);
			}
		}, 250);
		sock.on("error", (e) => {
			// After connect, write errors (e.g. EPIPE when the server ends
			// the socket right after nacking the oversized probe) are not
			// probe failures — the nack line or close decides.
			if (!connected) finish(false, `connect error: ${e.message}`);
		});
		sock.once("connect", () => {
			connected = true;
			lastProgressAt = Date.now();
			sock.write(payload);
		});
		sock.on("data", (c) => {
			chunks.push(c);
			const buf = Buffer.concat(chunks);
			const nl = buf.indexOf(0x0a);
			if (nl < 0) return;
			try {
				const parsed = JSON.parse(buf.slice(0, nl).toString("utf8")) as { // dp:ok already inside the try/catch that reports `non-JSON response`; D020 depth-walker ceiling
					type?: string;
					error?: unknown;
				};
				const got = typeof parsed?.error === "string" ? parsed.error : "";
				finish(
					parsed?.type === "nack" && got === expectError,
					`nack error="${got}" (expected "${expectError}")`,
				);
			} catch {
				finish(false, `non-JSON response: ${buf.slice(0, nl).toString("utf8").slice(0, 80)}`);
			}
		});
		sock.once("close", () => finish(false, "connection closed without a nack line"));
	});
const probeEnvelope = (overrides: Record<string, unknown>): string =>
	`${JSON.stringify({
		// isValidEnvelope (coms.ts) checks only type/msg_id/sender_session/
		// sender_endpoint; handlePrompt then gates secret → hops → fields.
		type: "prompt",
		msg_id: ulid(),
		sender_session: "smoke-probe",
		sender_endpoint: "smoke-probe",
		hops: 0,
		timestamp: new Date().toISOString(),
		secret: "smoke-probe-deliberately-wrong",
		prompt: "probe",
		sender_name: "smoke-probe",
		sender_cwd: os.tmpdir(),
		...overrides,
	})}\n`;
function recordProbesFailed(reason: string): void {
	record({ name: "socket_probe_wrong_secret_nack", ok: false, detail: reason });
	record({ name: "socket_probe_hops_exceeded_nack", ok: false, detail: reason });
	record({ name: "socket_probe_oversize_line_nack", ok: false, detail: reason });
}
async function runSocketNegativeProbes(entry: RegistryEntry): Promise<void> { // dp:ok probeNack is a `new Promise` that only ever resolves (every error path calls finish(false, …)), so there is no rejection to catch; a genuine throw aborts the gate run with a stack, as with the sibling helpers
	// (a) valid envelope + wrong secret → handlePrompt's auth gate nacks
	// "unauthorized" before any turn is triggered.
	const a = await probeNack(entry.endpoint, probeEnvelope({}), "unauthorized");
	record({ name: "socket_probe_wrong_secret_nack", ok: a.ok, detail: a.detail });
	// (b) CORRECT secret (read from B's registry entry in the local 0700
	// dir — no model auth involved) + hops >= MAX_HOPS → nack "hops
	// exceeded". The secret gate runs first in handlePrompt, so a missing
	// registry secret fails this probe honestly rather than faking a pass.
	const b =
		typeof entry.secret === "string" && entry.secret.length > 0
			? await probeNack(
					entry.endpoint,
					probeEnvelope({ secret: entry.secret, hops: COMS_MAX_HOPS }),
					"hops exceeded",
				)
			: {
					ok: false,
					detail:
						"smoke-b's registry entry carries no `secret` — hops probe cannot pass the auth gate (envelope-auth protocol change not present in coms.ts)",
				};
	record({ name: "socket_probe_hops_exceeded_nack", ok: b.ok, detail: b.detail });
	// (c) one line larger than LINE_CAP_BYTES → connHandler nacks
	// "malformed envelope" (msg_id "") as soon as the cap is exceeded.
	const c = await probeNack(
		entry.endpoint,
		Buffer.alloc(COMS_LINE_CAP_BYTES + 2, 0x41),
		"malformed envelope",
	);
	record({ name: "socket_probe_oversize_line_nack", ok: c.ok, detail: c.detail });
}

/**
 * F081: the client-side envelope-shape self-check (C5), lifted out of
 * pathSocketComs. Drift detection only — the server-side validation it does
 * NOT exercise is covered by the raw-socket negative probes.
 */
function recordEnvelopeShapeCoverage(
	entryA: RegistryEntry | null,
	entryB: RegistryEntry | null,
): void {
	// ── Envelope shape coverage (C5): this is a CLIENT-SIDE self-check only
	// — it builds the real Prompt/ResponseEnvelope shapes from the two real
	// registry entries, round-trips them through JSON, and checks a local
	// predicate. It does NOT exercise coms.ts's isValidEnvelope (which
	// checks only type/msg_id/sender_session/sender_endpoint) or
	// handlePrompt's secret check — THAT server-side validation is covered
	// by the raw-socket negative probes above. This block's value is drift
	// detection: it fails if a registry entry lacks the post-protocol-change
	// `secret`, or the pinned shape predicate below drifts from coms.ts.
	// Does NOT count toward messages_exchanged.
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
		const roundTripped = JSON.parse(JSON.stringify(envelope)) as typeof envelope; // dp:ok round-trip of our own JSON.stringify output, same expression, same process
		const roundTrippedResp = JSON.parse(JSON.stringify(response)) as typeof response; // dp:ok round-trip of our own JSON.stringify output, same expression, same process
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
				? `real Prompt+ResponseEnvelope shapes (incl. required secret from smoke-b's registry entry) round-tripped through JSON (client-side shape coverage only — does not count toward messages_exchanged/AC1)`
				: `envelope rejected by pinned shape predicate${typeof entryB.secret !== "string" ? " — target registry entry carries no `secret` (envelope-auth protocol change not present in coms.ts)" : ""}`,
		});
	} else {
		// Same check set as the early-failure returns (C15).
		record({
			name: "socket_envelope_shape_coverage",
			ok: false,
			skipped: "missing registry entries — envelope shapes not constructed",
		});
	}
}

/**
 * F081: the live-exchange evidence pass, lifted out of pathSocketComs — it
 * reads only real pi JSON events and fills the result counters.
 */
function recordExchangeEvidence(
	result: SocketComsResult,
	outA: SpawnOutcome,
	outB: SpawnOutcome,
	aClosedAt: number | null,
	bClosedAt: number | null,
): void {
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
	// The discriminator mirrors coms.ts's branch matching: pi 0.55.0 stores
	// injected coms prompts as `custom_message` entries (details.msg_id /
	// customType at ENTRY level), while plain `message` entries carry them
	// on entry.message. The JSON event stream's agent_end `messages` shape
	// isn't pinned by the vendored code, so this stays BEST-EFFORT — see
	// the report note (C3).
	result.bAnsweredObserved = eventsB.some((e) => {
		if (e.type !== "agent_end" || !Array.isArray(e.messages)) return false;
		const msgs = e.messages;
		const idx = msgs.findIndex((m) => {
			const inner = (m.message !== null && typeof m.message === "object" ? m.message : {}) as {
				details?: { msg_id?: unknown };
				customType?: string;
			};
			return (
				m.role === "custom" ||
				(m as { customType?: string }).customType === "coms-inbound" ||
				typeof (m as { details?: { msg_id?: unknown } }).details?.msg_id === "string" ||
				inner.customType === "coms-inbound" ||
				typeof inner.details?.msg_id === "string"
			);
		});
		return idx >= 0 && msgs.slice(idx + 1).some((m) => assistantText(m).trim().length > 0);
	});
	// Content verification (C2): the relayed prompt said "reply with
	// exactly: pong" — the coms_await reply payload must contain the token.
	// This is the best available evidence: the actual bytes B sent back,
	// not just "some assistant text existed".
	const replyPayload =
		typeof awaitEvent?.result?.details?.response === "string"
			? awaitEvent.result.details.response
			: "";
	result.replyContentVerified =
		awaitEvent !== undefined && containsToken(replyPayload, SOCKET_REPLY_TOKEN);
	const roundTrip =
		result.sendAcked &&
		awaitEvent !== undefined &&
		agentEndWithText(eventsA) &&
		result.replyContentVerified;
	result.exchanged = roundTrip ? 1 : 0;
	const problems = [outA.error, outB.error].filter((p): p is string => p !== null);
	if (outA.truncated || outB.truncated)
		problems.push("output truncated at cap — diagnostics may be missing");
	if (awaitEvent !== undefined && !result.replyContentVerified)
		problems.push(`coms_await reply did not contain expected token "${SOCKET_REPLY_TOKEN}"`);
	// B exiting before A (e.g. the model skipped the `sleep 60` stay-alive)
	// is a peer-lifecycle miss, not a transport failure — label it as such,
	// as a CORRELATION only: close ordering alone doesn't prove the exit
	// caused the missing ack (C11).
	const peerExitedFirst =
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
			? `coms_send acked (msg_id ${String(sendEvent?.result?.details?.msg_id)}), coms_await returned "${replyText}" (contains "${SOCKET_REPLY_TOKEN}" — content verified), agent_end with assistant text in smoke-a's stream`
			: peerExitedFirst
				? `smoke-b exited before smoke-a and no coms_send ack was observed — B's stay-alive turn likely ended early (correlation, not proven causation)${problems.length ? `; spawn problems: ${problems.join("; ")}` : ""}`
				: `send_acked=${result.sendAcked}, smoke-b answered inbound (best-effort)=${result.bAnsweredObserved}, coms_await reply received=${awaitEvent !== undefined}, reply content verified=${result.replyContentVerified}${problems.length ? `; problems: ${problems.join("; ")}` : ""}`,
	});
}

async function pathSocketComs(): Promise<SocketComsResult> {
	// INV-2: isolate to a per-run temp dir; spawned pi get PI_COMS_DIR=comsDir
	// so every registry write coms.ts makes is confined here.
	const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "coms-smoke-"));
	activeTmpDirs.add(tmpRoot);
	const comsDir = path.join(tmpRoot, "coms");
	const result: SocketComsResult = {
		registered: 0,
		exchanged: 0,
		sendAcked: false,
		bAnsweredObserved: false,
		replyContentVerified: false,
	};
	let procA: ChildProcess | null = null;
	let procB: ChildProcess | null = null;
	try {
		const agentsDir = path.join(comsDir, "projects", COMS_PROJECT, "agents");
		// Create comsDir itself with 0o700 FIRST so there is no world-readable
		// window between a default-perms mkdir and a later chmod (C17). The
		// chmodSync below still enforces the mode (mkdir mode is umask-masked).
		fs.mkdirSync(comsDir, { recursive: true, mode: 0o700 });
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
		const comsEnv = { ...childEnv().env, PI_COMS_DIR: comsDir, PI_COMS_TIMEOUT_MS: "60000" };




		// ── Spawn the two real peers. B first (A can only coms_send a registered
		// target); B's prompt keeps its turn alive via `sleep` so the inbound
		// prompt lands while the process is still running. The sleep-60 turn is
		// ALSO what delays B's answer: the followUp runs only after that turn
		// ends, so the reply lands ~70-90s after B's boot — AWAIT_TIMEOUT_MS and
		// SPAWN_TIMEOUT_MS are sized to that latency (C19).
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
				'You are agent smoke-b in a coms smoke test. First call the bash tool with command "sleep 60" to stay available. Then reply with exactly: done-waiting. If you receive a coms message from smoke-a, answer it briefly and directly.',
			],
			{ timeoutMs: SPAWN_TIMEOUT_MS, env: comsEnv },
		);
		procB = runB.proc;
		let bClosedAt: number | null = null;
		// Close timestamps from the close event itself — no floating promise
		// needed (C16).
		runB.proc.once("close", () => {
			bClosedAt = Date.now();
		});
		const entryB = await waitForRegistryEntry(agentsDir, "smoke-b", runB.proc);
		if (!entryB) {
			killTree(runB.proc, "SIGTERM");
			await runB.done;
			// Same check set as the main path (C15): the probes are protocol-
			// critical and need no model auth, so an unreachable endpoint is a
			// FAILED probe, never an omission (C4).
			record({
				name: "socket_registry_two_agents",
				ok: false,
				detail: "smoke-b never wrote its registry entry (coms.ts session_start did not complete)",
			});
			record({
				name: "socket_peer_b_ready",
				ok: false,
				detail: "no registry entry — smoke-b's endpoint was never advertised",
			});
			recordProbesFailed("smoke-b never registered — no endpoint to probe");
			recordInv2(comsDir, tmpRoot);
			record({
				name: "socket_envelope_shape_coverage",
				ok: false,
				skipped: "no registry entries — envelope shapes not constructed",
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
			recordProbesFailed("smoke-b's endpoint never accepted a connection — probes require a live endpoint");
			recordInv2(comsDir, tmpRoot);
			record({
				name: "socket_envelope_shape_coverage",
				ok: false,
				skipped: "smoke-a never spawned — envelope shapes not constructed",
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

		// ── Negative probes against B's live endpoint (C4). These run BEFORE A
		// spawns: they are auth-free, protocol-critical, and must gate even if
		// the model-driven exchange below never happens.
		await runSocketNegativeProbes(entryB);

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
		runA.proc.once("close", () => {
			aClosedAt = Date.now();
		});
		const entryA = await waitForRegistryEntry(agentsDir, "smoke-a", runA.proc);
		const [outA, outB] = await Promise.all([runA.done, runB.done]);

		// ── Real registrations: entries written by coms.ts's session_start,
		// captured from the live registry BEFORE the peers' cleanShutdown
		// removes them on exit. On POSIX the entry's pid must be the spawned
		// process's pid — proof the registration came from our real peer.
		// Path B is POSIX-only (coms.ts fails fast on win32 before registering),
		// so the win32 branch here is defensive dead code: on win32 no entries
		// are ever written and bothRegistered fails on entry === null anyway (C14).
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
		// Count only PID-VERIFIED entries so agents_registered can never
		// disagree with the gate (C15).
		result.registered = [
			entryA !== null && pidOk(entryA, runA.proc),
			entryB !== null && pidOk(entryB, runB.proc),
		].filter(Boolean).length;
		record({
			name: "socket_registry_two_agents",
			ok: bothRegistered,
			detail: bothRegistered
				? `2 peers registered by coms.ts session_start in isolated PI_COMS_DIR (smoke-a pid ${entryA?.pid}, smoke-b pid ${entryB?.pid})`
				: `registrations: smoke-a=${entryA ? "yes" : "no"}, smoke-b=${entryB ? "yes" : "no"}, pids match spawned procs: ${pidOk(entryA, runA.proc) && pidOk(entryB, runB.proc)}`,
		});

		// ── INV-2: assert the REAL dir's perms/ownership.
		recordInv2(comsDir, tmpRoot);

		recordEnvelopeShapeCoverage(entryA, entryB);

		recordExchangeEvidence(result, outA, outB, aClosedAt, bClosedAt);


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
		activeTmpDirs.delete(tmpRoot);
		try {
			fs.rmSync(tmpRoot, { recursive: true, force: true });
		} catch {
			// cleanup failure must not mask the run result
		}
	}
}

// ── Run ─────────────────────────────────────────────────────────────────────
// Driver runs ONLY as a script (F014): importing this file for unit tests must
// not spawn pi, resolve the child env, or emit a report.
if (import.meta.main) {
	// Resolve the child env FIRST so an F013 fail-closed refusal aborts before
	// anything is spawned. Fail closed but not loudly: the refusal is an
	// operator configuration message, not a crash, and no JSON report is owed
	// on this path — nothing ran.
	try {
		childEnv();
	} catch (err) {
		process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
		process.exit(2);
	}
	let pinnedVersion: string | null = null;
	let modelsComs = 0;
	let modelsComsNet = 0;
	const rpc = { registered: 0, exchanged: 0, spawn_errors: 0, replyContentVerified: false };
	const socket = {
		registered: 0,
		exchanged: 0,
		sendAcked: false,
		bAnsweredObserved: false,
		replyContentVerified: false,
		// C3: the JSON stream's agent_end `messages` shape isn't pinned by the
		// vendored code, so this observation is heuristic (mirrors coms.ts's
		// custom_message/message branch matching) and never gates on its own.
		bAnsweredNote:
			"best-effort: pi 0.55.0 JSON-stream agent_end message shape not pinned by vendored code",
	};

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
		rpc.replyContentVerified = rpcResult.replyContentVerified;
		socket.registered = socketResult.registered;
		socket.exchanged = socketResult.exchanged;
		socket.sendAcked = socketResult.sendAcked;
		socket.bAnsweredObserved = socketResult.bAnsweredObserved;
		socket.replyContentVerified = socketResult.replyContentVerified;
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
	// registered ≥2 real peers via coms.ts's own session_start.
	const rpcRoundTrip = checks.find((c) => c.name === "rpc_live_round_trip")?.ok === true;
	const socketRegistered = checks.find((c) => c.name === "socket_registry_two_agents")?.ok === true;
	const acMakeOrBreak = rpcRoundTrip && socketRegistered;
	// STRICT is the DEFAULT (C20): every recorded check gates, including the Path B
	// live exchange (socket_live_round_trip). An explicit PI_SMOKE_STRICT=0 waives
	// ONLY that check — AC1's message clause is satisfied by either substrate (the
	// story's OR clause) and the model-driven reply depends on two live agents'
	// timing — but a waived failure is flagged loudly via pass_with_waiver.
	const STRICT = process.env.PI_SMOKE_STRICT !== "0";
	const gatingChecks = checks.filter((c) => STRICT || c.name !== "socket_live_round_trip");
	// Gate = every gating check ok===true (a skipped check has ok:false and fails
	// the gate honestly — no skip clause can launder a failure) AND AC1
	// make-or-break holds. In waiver mode a failed socket_live_round_trip is
	// excluded from the gate but forces pass_with_waiver below.
	const gatingOk = gatingChecks.every((c) => c.ok);
	const pass = gatingOk && acMakeOrBreak;
	const socketLiveOk = checks.find((c) => c.name === "socket_live_round_trip")?.ok === true;
	const passWithWaiver = pass && !STRICT && !socketLiveOk;

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
		strict: STRICT,
		pass_with_waiver: passWithWaiver,
		gate_note: STRICT
			? "STRICT (default): socket_live_round_trip is gating — set PI_SMOKE_STRICT=0 to waive it"
			: passWithWaiver
				? "⚠ PASS WITH WAIVER: socket_live_round_trip FAILED but was waived via PI_SMOKE_STRICT=0 — the socket-coms live exchange is UNVERIFIED"
				: "PI_SMOKE_STRICT=0: socket_live_round_trip is advisory-only (waived); every other check gates",
		env_scope: childEnv().scope,
		redaction: "env-secret-values",
		pass,
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
}
