/**
 * Pure(ish) helpers extracted from `scripts/coms-smoke-test.ts` so they can be
 * unit tested. That script is a top-level program — importing it would run the
 * whole smoke test (spawns pi, opens sockets) — so the testable surface has to
 * live outside it. Extraction only; the one deliberate behavior change is the
 * trimmed-value candidate in `collectSecretValues` (see its comment), which is
 * strictly more redaction.
 *
 * Tests: `tests/scripts/coms-smoke-helpers.test.ts`.
 */
import { type ChildProcess, spawnSync } from "node:child_process";
import * as crypto from "node:crypto";

// ── Report hygiene: ambient secrets must never leak into the JSON report. ────
// An env value is treated as a secret when its KEY contains a secret word as a
// whole SEGMENT. A segment boundary is the start/end of the key or ANY
// non-alphanumeric character — `_`, `-`, `.`, `:` and friends all separate
// segments, because every env-var naming convention in the wild uses one of
// them (`API_KEY`, `x-api-key`, `spring.datasource.password`). Matching by
// segment rather than substring is what keeps PATH/AUTHOR-style keys from
// tripping it, while *_PAT, bare *_PASS, *_CRED, *_PRIVATE etc. are covered
// (C7).
//
// Contract / known limits of this pattern:
//   - ACCEPTED LIMIT: a key with NO separator at all around the secret word is
//     not matched — `APIKEY`, `PASSWD`, `apiKey`, `githubtoken` all slip
//     through. This is the price of segment matching: the only way to catch
//     them is substring matching, which would redact PATH, AUTHOR, MONKEY and
//     turn every report into `[REDACTED]` soup. Case-boundary (camelCase)
//     detection is not possible either — the pattern is case-INsensitive by
//     design so `github_token` matches. Pinned in
//     tests/scripts/coms-smoke-helpers.test.ts.
//   - ACCEPTED LIMIT: `URL` in the alternation over-redacts — any `*_URL_*`
//     segment (e.g. `BASE_URL_PREFIX`, `API_URL`) is treated as secret-bearing
//     even when it holds a plain hostname. This is deliberate: over-redaction
//     only costs report legibility, under-redaction leaks a credential, and a
//     connection string carrying inline credentials (`DATABASE_URL`) MUST be
//     covered. The scrub fails CLOSED on purpose.
export const SECRET_ENV_KEY_RE =
	/(^|[^A-Za-z0-9])(KEY|TOKEN|SECRET|PASS|PASSWORD|PAT|CRED|CREDENTIAL|PRIVATE|JWT|AUTH|DSN|URL)($|[^A-Za-z0-9])/i;

// Values shorter than this are ignored — they are almost always noise ("true",
// "1", "dev") whose redaction would shred the report.
// ACCEPTED LIMIT: the cost is that a short real secret (e.g. a 7-char
// password) is never redacted. The floor exists because redacting short,
// common strings would turn every report into "[REDACTED]" soup.
export const MIN_SECRET_LENGTH = 8;

/**
 * Every ambient env value that must be scrubbed from captured child output,
 * deduped and sorted LONGEST-FIRST: when one secret is a substring of another,
 * replacing the shorter one first would fragment the longer one and leave its
 * tail unredacted.
 */
export function collectSecretValues(env: NodeJS.ProcessEnv = process.env): string[] {
	const out = new Set<string>();
	for (const [k, v] of Object.entries(env)) {
		if (typeof v !== "string" || !SECRET_ENV_KEY_RE.test(k)) continue;
		// Four candidate spellings of the same secret, because the text being
		// scrubbed is pi's JSON EVENT STREAM, not plain prose:
		//   - raw: the value as it sits in env.
		//   - trimmed: a token sourced from a file (`KEY=$(cat token)` in a CI
		//     runner, docker --env-file) keeps a trailing newline in env but is
		//     sent over the wire trimmed, so the raw value alone never matches.
		//   - JSON-escaped (both of the above): a secret containing `"`, `\` or
		//     a newline appears inside a JSON event as `\"`, `\\`, `\n` — the
		//     literal env value does NOT occur in that text and would survive.
		// For an ordinary alphanumeric key all four collapse to one via the Set,
		// so this costs nothing in the common case.
		for (const candidate of [v, v.trim(), jsonEscape(v), jsonEscape(v.trim())]) {
			if (candidate.length >= MIN_SECRET_LENGTH) out.add(candidate);
		}
	}
	return Array.from(out).sort((a, b) => b.length - a.length);
}

/** The value as it would appear INSIDE a JSON string literal (no surrounding quotes). */
function jsonEscape(v: string): string {
	return JSON.stringify(v).slice(1, -1);
}

/**
 * Replace every occurrence of every secret with `[REDACTED]`. Uses
 * `split`/`join` (literal string separator), NOT a regex — so a secret
 * containing regex metacharacters is matched literally with no escaping needed
 * and no ReDoS surface. Feed it `collectSecretValues()` output (longest-first)
 * or the substring case under-redacts.
 *
 * Accepted limits of this replacement strategy (documented, not defects):
 *   - Matching is case-SENSITIVE. A child process that upper-cases a token
 *     before echoing it evades the scrub. Case-insensitive matching would
 *     require building a regex over attacker/user-influenced values.
 *   - Two DISTINCT secrets that share a suffix/prefix and appear ADJACENT in
 *     the text leak the overlap tail: redacting the first consumes the shared
 *     characters, so the second no longer matches at that position. Avoiding
 *     this needs a simultaneous longest-match scan instead of sequential
 *     replacement; the trigger (two independent credentials sharing a
 *     substring AND printed back-to-back) is negligible for random tokens.
 */
export function redact(s: string, secrets: readonly string[]): string {
	let out = s;
	// An empty separator makes split() explode the string into characters and
	// join() weld "[REDACTED]" between every one of them — total corruption, so
	// skip it. collectSecretValues can't produce one; a direct caller can.
	for (const v of secrets) {
		if (v === "") continue;
		out = out.split(v).join("[REDACTED]");
	}
	return out;
}

// ── win32 shell-arg quoting (C3/C18), shared by startPi and the spawnSync
//    probes so a repo path containing spaces survives cmd.exe. ──────────────
// shell:true is UNAVOIDABLE on win32 for `pi`: bare `pi` resolves to a .cmd
// shim, CreateProcess cannot execute a batch file without cmd.exe, and modern
// Node refuses shell:false on batch files outright (EINVAL, CVE-2024-27980) —
// so "resolve pi.cmd and spawn with shell:false" is not a real option. With
// shell:true Node joins args with spaces and NO quoting, so wrap each arg
// ourselves. Safety model against cmd.exe's quote-state machine (each `"`
// toggles quoted state):
//   - `"` → `""`: parity-PRESERVING (a pair toggles state twice), so an
//     embedded quote cannot break out of the wrapper — `& | < > ^ ( )`
//     stay quoted and inert. Caveat: the child CRT collapses the pair, so
//     a literal `"` does not survive win32 argv — cosmetic for these
//     prompts, and no escaping satisfies both cmd and the CRT anyway.
//   - reject `%`: cmd.exe expands %VAR% even inside double quotes (C18).
//   - reject `!`: expands inside quotes when delayed expansion is enabled
//     (non-default, and not escapable from outside a batch file).
//   - reject CR/LF: line terminators end the command regardless of quote
//     state — the one genuine breakout from a quoted wrapper.
// POSIX path unchanged (no shell, argv passed verbatim).
export function win32ShellArgs(args: string[], platform: NodeJS.Platform = process.platform): string[] {
	if (platform !== "win32") return args;
	return args.map((a) => {
		const bad = /[%!\r\n]/.exec(a);
		if (bad)
			throw new Error(
				`win32 spawn: argument contains ${JSON.stringify(bad[0])} which cmd.exe interprets even inside quotes: ${a.slice(0, 60)}`,
			);
		return `"${a.replace(/"/g, '""')}"`;
	});
}

// Kill the whole process tree: POSIX spawns are detached group leaders, so
// signal the GROUP (-pid) to sweep grandchildren (pi tool calls like `sleep`);
// on win32 use taskkill /T. Best-effort — a dead process must never throw.
export function killTree(proc: ChildProcess, signal: NodeJS.Signals = "SIGKILL"): void {
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

// Well-formed 26-char Crockford-base32 ULID (48-bit time + 80-bit
// randomness) for shape-coverage msg_ids — no more fake "01SMOKE…" ids.
// Mirrors the vendored generator (coms-core.ts `ulid`) so probe envelopes carry
// ids indistinguishable from real coms traffic: 10 bytes of randomness
// bit-packed 5 bits per char — drawing 16 bytes and masking each with % 32
// would consume 128 bits to emit the same 80.
// DUPLICATE of pi-vs-claude-code-vendor/coms-core.ts:75 — deduping it is
// tracked separately (issue #59); coms-core.ts is vendored under a 3-way-merge
// rule, so this copy stays for now.
export const ULID_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
export function ulid(): string {
	const time = Date.now();
	const rand = crypto.randomBytes(10);
	let timeStr = "";
	let t = time;
	for (let i = 9; i >= 0; i--) {
		timeStr = (ULID_ALPHABET[t % 32] ?? "0") + timeStr;
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
			randStr += ULID_ALPHABET[(value >> bits) & 31] ?? "0";
		}
	}
	return (timeStr + randStr).slice(0, 26);
}
