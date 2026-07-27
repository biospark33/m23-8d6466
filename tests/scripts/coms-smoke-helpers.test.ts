/**
 * Unit tests for the helpers extracted from scripts/coms-smoke-test.ts.
 *
 * The bulk of these cover the SECRET REDACTION path — the one security-relevant
 * piece of that 1,400-line script. Redaction has an asymmetric failure mode:
 * over-redaction costs diagnostics, under-redaction leaks a live credential
 * into a JSON report, so the interesting tests are the ones that try to make a
 * secret SURVIVE `redact`. Each known survival path is pinned with a test.
 *
 * A pinned survival path is either an ACCEPTED LIMIT — a deliberate,
 * documented tradeoff, safe to assert as passing — or a KNOWN BUG, which must
 * NOT read as green-and-fine: those are `test.todo` (or explicitly marked
 * "KNOWN BUG (#issue)") so the gap stays visible instead of being laundered
 * into looking like intended behavior. The accepted-limit contract itself
 * lives on the helper doc comments in scripts/lib/coms-smoke-helpers.ts, not
 * only here, so callers see it without reading the tests.
 */
import { spawn } from "node:child_process";
import { describe, expect, test } from "bun:test";
import {
	collectSecretValues,
	killTree,
	MIN_SECRET_LENGTH,
	redact,
	SECRET_ENV_KEY_RE,
	ULID_ALPHABET,
	ulid,
	win32ShellArgs,
} from "../../scripts/lib/coms-smoke-helpers.ts";

describe("SECRET_ENV_KEY_RE", () => {
	test("matches a secret word at a segment boundary", () => {
		for (const k of [
			"GITHUB_TOKEN",
			"ANTHROPIC_API_KEY",
			"AWS_SECRET_ACCESS_KEY",
			"MY_PAT",
			"DB_PASS",
			"DB_PASSWORD",
			"SVC_CRED",
			"SVC_CREDENTIAL",
			"SSH_PRIVATE_KEY",
			"JWT",
			"JWT_SIGNING_KEY",
			"AUTH_HEADER",
			"SENTRY_DSN",
			"DATABASE_URL",
			"github_token", // case-insensitive
		]) {
			expect(SECRET_ENV_KEY_RE.test(k)).toBe(true);
		}
	});

	test("does NOT match a secret word that is merely a substring", () => {
		// The whole point of the segment anchoring: PATH must not be treated
		// as a PAT, or every report would be [REDACTED] soup.
		for (const k of ["PATH", "AUTHOR", "PASSAGE", "KEYBOARD", "MONKEY", "PATTERN", "URLENCODE"]) {
			expect(SECRET_ENV_KEY_RE.test(k)).toBe(false);
		}
	});

	test("FIXED (#73): any non-alphanumeric char is a segment boundary, not just `_`", () => {
		// Hyphenated env names are legal (docker --env, k8s-injected vars) and
		// process.env accepts them; header-style keys are a common shape for
		// exactly the credentials this guard exists to catch. Dotted keys show up
		// via Spring-style config. The boundary class is `[^A-Za-z0-9]` so every
		// separator anyone actually uses counts.
		for (const k of [
			"x-api-key",
			"X-AUTH-TOKEN",
			"db-password",
			"api.key",
			"spring.datasource.password",
			"svc:token",
			"MIXED-STYLE_KEY",
			"-KEY-", // separator on both sides, nothing else
		]) {
			expect(SECRET_ENV_KEY_RE.test(k)).toBe(true);
		}
	});

	test("ACCEPTED LIMIT: a separator-less key is NOT matched", () => {
		// The residual leak path after #73: with no boundary char around the
		// secret word there is nothing to anchor on, and the only alternative —
		// substring matching — would redact PATH/AUTHOR/MONKEY and shred every
		// report. camelCase can't be used as a boundary either, since the pattern
		// is deliberately case-insensitive so `github_token` matches.
		for (const k of ["APIKEY", "PASSWD", "apiKey", "githubtoken", "SECRETS"]) {
			expect(SECRET_ENV_KEY_RE.test(k)).toBe(false);
		}
	});

	test("is stateless across calls (no /g lastIndex trap)", () => {
		expect(SECRET_ENV_KEY_RE.test("GITHUB_TOKEN")).toBe(true);
		expect(SECRET_ENV_KEY_RE.test("GITHUB_TOKEN")).toBe(true);
	});
});

describe("collectSecretValues", () => {
	test("collects values of secret-named keys only", () => {
		const got = collectSecretValues({
			GITHUB_TOKEN: "ghp_realsecret1",
			HOME: "/Users/nobody",
			PATH: "/usr/bin:/bin",
			NODE_ENV: "production",
		});
		expect(got).toEqual(["ghp_realsecret1"]);
	});

	test(`drops values shorter than ${MIN_SECRET_LENGTH} chars`, () => {
		const got = collectSecretValues({
			A_TOKEN: "", // empty — would shred the whole report if it got through
			B_TOKEN: "x", // single char — ditto
			C_TOKEN: "1234567", // 7, below the floor
			D_TOKEN: "12345678", // 8, exactly at the floor
		});
		expect(got).toEqual(["12345678"]);
	});

	test("ACCEPTED LIMIT: a short real secret is therefore never redacted", () => {
		// e.g. DB_PASSWORD=hunter2 (7 chars). The floor exists to skip noise
		// ("true", "1", "dev") whose redaction would corrupt the report; the
		// price is that a short credential leaks. Documented, not fixed here.
		expect(collectSecretValues({ DB_PASSWORD: "hunter2" })).toEqual([]);
	});

	test("dedupes values shared by several keys", () => {
		const got = collectSecretValues({
			GH_TOKEN: "same-secret-value",
			GITHUB_TOKEN: "same-secret-value",
		});
		expect(got).toEqual(["same-secret-value"]);
	});

	test("sorts LONGEST-FIRST so a substring secret cannot fragment a longer one", () => {
		const got = collectSecretValues({
			A_TOKEN: "abcdefgh",
			B_TOKEN: "abcdefghijklmnop",
			C_TOKEN: "abcdefghijkl",
		});
		expect(got).toEqual(["abcdefghijklmnop", "abcdefghijkl", "abcdefgh"]);
	});

	test("also emits the TRIMMED value — a token read from a file keeps its newline in env", () => {
		// `GITHUB_TOKEN=$(cat token)` in a runner, or docker --env-file, leaves
		// "ghp_…\n" in process.env while the wire/child output carries the
		// trimmed token. Matching only the raw value would let it through.
		const got = collectSecretValues({ GITHUB_TOKEN: "ghp_abcdefgh\n" });
		expect(got).toContain("ghp_abcdefgh");
		expect(redact("saw ghp_abcdefgh here", got)).toBe("saw [REDACTED] here");
	});

	test("LEAK FIX: also emits the JSON-ESCAPED value — captured output is pi's JSON event stream", () => {
		// The text redact() scrubs is pi's `--mode json` stdout. A secret holding
		// a quote, backslash or newline is written there in ESCAPED form, so the
		// literal env value never occurs in it and the secret used to survive
		// straight into the report.
		const secret = 'p@ss"w\\ord-1234';
		const secrets = collectSecretValues({ DB_PASSWORD: secret });
		const jsonLine = JSON.stringify({ type: "tool_result", text: `psql failed for ${secret}` });
		expect(jsonLine).not.toContain(secret); // the raw value is NOT in the stream
		const scrubbed = redact(jsonLine, secrets);
		expect(scrubbed).not.toContain('p@ss\\"w\\\\ord-1234'); // escaped form gone
		expect(scrubbed).toContain("[REDACTED]");
		// and the plain form is still covered wherever it does appear verbatim
		expect(redact(`plain ${secret} here`, secrets)).toBe("plain [REDACTED] here");
	});

	test("the four candidate spellings collapse for an ordinary alphanumeric secret", () => {
		// No cost in the common case — the Set dedupes raw/trimmed/escaped.
		expect(collectSecretValues({ GITHUB_TOKEN: "ghp_abcdefgh1234" })).toEqual(["ghp_abcdefgh1234"]);
	});

	test("FIXED (#73): a hyphenated key's value is collected and scrubbed end to end", () => {
		const secrets = collectSecretValues({ "x-api-key": "sk-live-DEADBEEFCAFE" });
		expect(redact("auth failed: sk-live-DEADBEEFCAFE", secrets)).toBe("auth failed: [REDACTED]");
	});

	test("ignores non-string env slots", () => {
		expect(collectSecretValues({ A_TOKEN: undefined })).toEqual([]);
	});

	test("scrubs a real-looking key end to end", () => {
		const env = { ANTHROPIC_API_KEY: "sk-ant-api03-DEADBEEFCAFE", PATH: "/usr/bin" };
		const out = redact(
			"error: 401 from api (key sk-ant-api03-DEADBEEFCAFE) on PATH /usr/bin",
			collectSecretValues(env),
		);
		expect(out).not.toContain("sk-ant-api03-DEADBEEFCAFE");
		expect(out).toContain("/usr/bin"); // non-secret keys untouched
	});
});

describe("redact", () => {
	test("replaces every occurrence, not just the first", () => {
		expect(redact("a SEKRET b SEKRET c", ["SEKRET"])).toBe("a [REDACTED] b [REDACTED] c");
	});

	test("leaves text alone when there are no secrets", () => {
		expect(redact("nothing to see", [])).toBe("nothing to see");
	});

	test("longest-first ordering fully redacts a secret that CONTAINS another secret", () => {
		const secrets = collectSecretValues({ SHORT_TOKEN: "abcdefgh", LONG_TOKEN: "abcdefghijkl" });
		expect(redact("leak=abcdefghijkl", secrets)).toBe("leak=[REDACTED]");
	});

	test("REGRESSION GUARD: shortest-first ordering leaks the tail of the longer secret", () => {
		// This is what collectSecretValues' sort exists to prevent. If that sort
		// is ever removed, the assertion above starts producing this instead.
		expect(redact("leak=abcdefghijkl", ["abcdefgh", "abcdefghijkl"])).toBe("leak=[REDACTED]ijkl");
	});

	test("an empty secret does not shred the output", () => {
		// "".split("") explodes the string per character and join() welds
		// [REDACTED] between every one of them. collectSecretValues cannot
		// produce an empty secret; redact guards anyway.
		expect(redact("hello", [""])).toBe("hello");
		expect(redact("hello", ["", "ell"])).toBe("h[REDACTED]o");
	});

	test("a single-character secret redacts literally (no explosion)", () => {
		expect(redact("banana", ["a"])).toBe("b[REDACTED]n[REDACTED]n[REDACTED]");
	});

	test("regex metacharacters are matched LITERALLY — split/join takes a string, not a pattern", () => {
		const secret = "a.*+?[](){}|^$\\b";
		// The literal secret is replaced...
		expect(redact(`x${secret}y`, [secret])).toBe("x[REDACTED]y");
		// ...and text the secret would have MATCHED as a regex is untouched.
		expect(redact("aXXXb", [secret])).toBe("aXXXb");
		expect(redact("anything", [".*"])).toBe("anything");
		// No escaping is required and no ReDoS surface exists: a catastrophic
		// backtracking pattern is just a string here.
		expect(redact("aaaaaaaaaaaaaaaaaaaa!", ["(a+)+$"])).toBe("aaaaaaaaaaaaaaaaaaaa!");
	});

	test("ACCEPTED LIMIT: adjacent overlapping secrets leak the overlap tail", () => {
		// Two DISTINCT secrets sharing a suffix/prefix, printed adjacently:
		// redacting the first consumes the shared chars, so the second no longer
		// matches and its remainder survives. Sequential non-overlapping
		// replacement cannot avoid this without a simultaneous longest-match
		// scan. Trigger requires two independent credentials to share a
		// substring AND appear adjacent — negligible for random tokens, so this
		// is pinned as documented behavior rather than rewritten.
		const secrets = collectSecretValues({ A_TOKEN: "AAAABBBB", B_TOKEN: "BBBBCCCC" });
		expect(secrets).toHaveLength(2);
		expect(redact("AAAABBBBCCCC", secrets)).toBe("[REDACTED]CCCC");
	});

	test("ACCEPTED LIMIT: matching is case-SENSITIVE", () => {
		// A child that upper-cases a token before echoing it would evade the
		// scrub. Case-insensitive matching would require a regex over
		// user-controlled values; the child processes here echo verbatim.
		expect(redact("GHP_ABCDEFGH", ["ghp_abcdefgh"])).toBe("GHP_ABCDEFGH");
	});

	test("secrets spanning a newline are still redacted (output is scanned whole, not per line)", () => {
		expect(redact("prefix\nsk-ant-\nsuffix", ["sk-ant-\nsuffix"])).toBe("prefix\n[REDACTED]");
	});

	test("a secret hidden inside a longer secret's value is covered by the longer one", () => {
		// DATABASE_URL carries the password inline; the URL itself is a secret
		// key, so the whole connection string goes.
		const secrets = collectSecretValues({ DATABASE_URL: "postgres://u:hunter2@host/db" });
		expect(redact("connecting to postgres://u:hunter2@host/db", secrets)).toBe(
			"connecting to [REDACTED]",
		);
	});
});

// Threat model: the child pi processes and anything that seeded the
// environment may control env VALUES. Can a hostile value make a REAL secret
// survive into the report?
describe("redact under attacker-controlled env values", () => {
	test("a hostile value overlapping a real secret cannot un-redact it (longest-first wins)", () => {
		const secrets = collectSecretValues({
			ANTHROPIC_API_KEY: "sk-ant-REALSECRET",
			ATTACKER_TOKEN: "sk-ant-REALSECRE", // shorter overlap — sorted after
		});
		expect(redact("leaked sk-ant-REALSECRET here", secrets)).toBe("leaked [REDACTED] here");
	});

	test("a hostile value that CONTAINS the secret still redacts it (superset match)", () => {
		const secrets = collectSecretValues({
			ANTHROPIC_API_KEY: "sk-ant-REALSECRET",
			ATTACKER_TOKEN: "XXsk-ant-REALSECRETYY",
		});
		expect(redact("XXsk-ant-REALSECRETYY", secrets)).toBe("[REDACTED]");
		expect(redact("sk-ant-REALSECRET", secrets)).toBe("[REDACTED]");
	});

	test("residue is only reachable by an attacker who ALREADY knows the secret", () => {
		// A hostile value that is LONGER than the secret and consumes a proper
		// prefix of it is replaced first, stranding the tail. Building it requires
		// knowing the secret, so it grants the attacker nothing they lacked —
		// noted rather than defended against.
		const secrets = collectSecretValues({
			ANTHROPIC_API_KEY: "sk-ant-REALSECRET",
			ATTACKER_TOKEN: "PADsk-ant-REALSECR",
		});
		expect(redact("PADsk-ant-REALSECRET", secrets)).toBe("[REDACTED]ET");
	});

	test("a hostile value degrades report legibility but never leaks (fails closed)", () => {
		// Setting EVIL_TOKEN to a common string turns unrelated diagnostics into
		// [REDACTED]. Denial of *diagnostics*, not disclosure.
		const secrets = collectSecretValues({ EVIL_TOKEN: "https://" });
		expect(redact("GET https://example.test", secrets)).toBe("GET [REDACTED]example.test");
	});

	test("a hostile value of `[REDACTED]` is inert", () => {
		const secrets = collectSecretValues({ EVIL_TOKEN: "[REDACTED]" });
		expect(redact("already [REDACTED] text", secrets)).toBe("already [REDACTED] text");
	});
});

describe("redaction scope: the URL alternation", () => {
	test("DATABASE_URL is redacted — intended, connection strings carry credentials", () => {
		const secrets = collectSecretValues({ DATABASE_URL: "postgres://u:p@host/db" });
		expect(secrets).toEqual(["postgres://u:p@host/db"]);
	});

	test("OVER-REDACTION: innocuous *_URL_* keys are redacted too, and that is the safe default", () => {
		// `URL` in the alternation makes BASE_URL_PREFIX / API_URL / any _URL_
		// segment secret-bearing. Over-redaction only costs report legibility
		// (a diagnostic host name becomes [REDACTED]); under-redaction leaks a
		// credential. The scrub fails CLOSED, which is the correct direction for
		// a security control. Not a bug.
		const secrets = collectSecretValues({ BASE_URL_PREFIX: "https://example.test" });
		expect(secrets).toEqual(["https://example.test"]);
		expect(redact("GET https://example.test/health -> 200", secrets)).toBe(
			"GET [REDACTED]/health -> 200",
		);
	});

	test("the cost of that default: a common URL value redacts unrelated report text", () => {
		const secrets = collectSecretValues({ PI_URL: "http://localhost:3000" });
		expect(redact("listening on http://localhost:3000", secrets)).toBe("listening on [REDACTED]");
	});
});

describe("win32ShellArgs", () => {
	test("POSIX: passes argv through verbatim", () => {
		const args = ["-e", "/path with spaces/coms.ts", "--list-models", "50% off!"];
		expect(win32ShellArgs(args, "linux")).toEqual(args);
		expect(win32ShellArgs(args, "darwin")).toEqual(args);
	});

	test("win32: wraps every arg in double quotes", () => {
		expect(win32ShellArgs(["-e", "C:\\Program Files\\repo\\coms.ts"], "win32")).toEqual([
			'"-e"',
			'"C:\\Program Files\\repo\\coms.ts"',
		]);
	});

	test("win32: doubles embedded quotes, preserving cmd.exe quote parity", () => {
		const [out] = win32ShellArgs(['say "hi"'], "win32");
		expect(out).toBe('"say ""hi"""');
		// Parity is what keeps the arg inert: an even number of `"` returns
		// cmd.exe to the same quote state it started in.
		expect((out?.match(/"/g)?.length ?? 0) % 2).toBe(0);
	});

	test("win32: shell metacharacters stay quoted and inert", () => {
		for (const meta of ["&", "|", "<", ">", "^", "(", ")", "&& calc.exe"]) {
			expect(win32ShellArgs([`x${meta}y`], "win32")).toEqual([`"x${meta}y"`]);
		}
	});

	test("win32: REJECTS the characters cmd.exe expands or acts on inside quotes", () => {
		// % expands %VAR% even quoted; ! expands under delayed expansion;
		// CR/LF terminate the command outright — the real breakout.
		for (const bad of ["%PATH%", "hi!", "a\rb", "a\nb"]) {
			expect(() => win32ShellArgs([bad], "win32")).toThrow(/cmd\.exe interprets/);
		}
		// ...and on POSIX the very same args are fine.
		expect(win32ShellArgs(["%PATH%"], "darwin")).toEqual(["%PATH%"]);
	});

	test("win32: the rejection message names the offending character and truncates the arg", () => {
		expect(() => win32ShellArgs([`${"z".repeat(200)}%`], "win32")).toThrow(/contains "%"/);
		try {
			win32ShellArgs([`${"z".repeat(200)}%`], "win32");
		} catch (e) {
			// arg is truncated to 60 chars so a long prompt can't flood the error.
			expect((e as Error).message).toContain("z".repeat(60));
			expect((e as Error).message).not.toContain("z".repeat(61));
		}
	});

	test("win32: rejection is per-arg — one bad arg fails the whole spawn", () => {
		expect(() => win32ShellArgs(["--ok", "fine", "bad%arg"], "win32")).toThrow();
	});

	test("empty arg list is a no-op on both platforms", () => {
		expect(win32ShellArgs([], "win32")).toEqual([]);
		expect(win32ShellArgs([], "darwin")).toEqual([]);
	});
});

// killTree signals the process GROUP on POSIX; these exercise the real thing
// against real detached children.
describe.skipIf(process.platform === "win32")("killTree", () => {
	const waitExit = (proc: { exitCode: number | null; signalCode: string | null }) =>
		new Promise<void>((resolve, reject) => {
			const deadline = Date.now() + 5000;
			const poll = () => {
				if (proc.exitCode !== null || proc.signalCode !== null) return resolve();
				if (Date.now() > deadline) return reject(new Error("child never exited"));
				setTimeout(poll, 25);
			};
			poll();
		});

	test("kills a detached child", async () => {
		const proc = spawn("sh", ["-c", "sleep 30"], { detached: true, stdio: "ignore" });
		killTree(proc, "SIGKILL");
		await waitExit(proc);
		expect(proc.signalCode ?? proc.exitCode).not.toBeNull();
	});

	test("sweeps GRANDCHILDREN — the whole reason it signals -pid", async () => {
		// A bare proc.kill() would leave the inner `sleep` orphaned and running.
		// The duration doubles as a run-unique marker (it is the grandchild's
		// whole argv) so a leaked sleep from an earlier run can never be
		// mistaken for this run's survivor.
		const marker = `sleep 30000.${process.pid}${Math.floor(Math.random() * 1e6)}`;
		const proc = spawn("sh", ["-c", `${marker} & wait`], { detached: true, stdio: "ignore" });
		await new Promise((r) => setTimeout(r, 300)); // let the grandchild start
		killTree(proc, "SIGKILL");
		await waitExit(proc);
		await new Promise((r) => setTimeout(r, 200));
		const survivors = spawn("pgrep", ["-f", marker], { stdio: ["ignore", "pipe", "ignore"] });
		let out = "";
		survivors.stdout.on("data", (c) => {
			out += String(c);
		});
		await new Promise((r) => survivors.on("close", r));
		expect(out.trim()).toBe("");
	});

	test("is a no-op on a process with no pid", () => {
		expect(() => killTree({ pid: undefined } as never, "SIGKILL")).not.toThrow();
	});

	test("does not throw on an already-dead process", async () => {
		const proc = spawn("sh", ["-c", "exit 0"], { detached: true, stdio: "ignore" });
		await waitExit(proc);
		expect(() => killTree(proc, "SIGKILL")).not.toThrow();
		expect(() => killTree(proc, "SIGTERM")).not.toThrow();
	});

	test("honors a non-default signal", async () => {
		const proc = spawn("sh", ["-c", "sleep 30"], { detached: true, stdio: "ignore" });
		killTree(proc, "SIGTERM");
		await waitExit(proc);
		expect(proc.signalCode).toBe("SIGTERM");
	});
});

// FIXED (#59): there is no longer a copy here — `ulid` is re-exported from the
// canonical generator in pi-vs-claude-code-vendor/coms-core.ts (also covered by
// tests/vendor/coms-core.test.ts). These tests are kept as a contract check on
// the RE-EXPORT: they fail if the helper stops surfacing `ulid`/`ULID_ALPHABET`
// or starts surfacing something that is not the canonical generator.
describe("ulid", () => {
	test("shape: 26 Crockford-base32 chars", () => {
		const id = ulid();
		expect(id).toHaveLength(26);
		expect(id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
		for (const ch of id) expect(ULID_ALPHABET).toContain(ch);
	});

	test("distinct across a batch", () => {
		const ids = new Set(Array.from({ length: 1000 }, () => ulid()));
		expect(ids.size).toBe(1000);
	});

	test("time prefix is non-decreasing between back-to-back calls", () => {
		const a = ulid();
		const b = ulid();
		expect(a.slice(0, 10) <= b.slice(0, 10)).toBe(true);
	});

	test("randomness is 16 chars and varies while the time prefix holds", () => {
		const ids = Array.from({ length: 50 }, () => ulid());
		expect(new Set(ids.map((i) => i.slice(10))).size).toBe(50);
		expect(ids[0]?.slice(10)).toHaveLength(16);
	});
});
