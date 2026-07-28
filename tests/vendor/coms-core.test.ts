/**
 * Unit tests for the shared coms-core layer extracted from coms.ts / coms-net.ts.
 *
 * These cover every helper that was historically maintained in manual parity
 * across the two transports — the exact surface that drifted before (e.g. the
 * abbreviateModel non-string guard) and that the extraction now dedupes. A
 * regression in any of these is a regression in both transports.
 */
import { afterAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	abbreviateModel,
	envBoundedInt,
	fallbackColor,
	FALLBACK_PALETTE,
	findSystemPromptPath,
	hexFg,
	isDuplicateRegistration,
	isSafePathComponent,
	isValidHex,
	isWireRecord,
	MAX_RESPONSE_BYTES,
	MAX_RESPONSE_SCHEMA_BYTES,
	nowIso,
	parseFrontmatter,
	readFrontmatterFromArgv,
	sanitizePeerText,
	secretEqual,
	ulid,
} from "../../pi-vs-claude-code-vendor/coms-core.ts";

// Control-char strings are built at runtime from char codes so the source file
// stays pure ASCII (the char class strips C0 0x00-0x1f, DEL 0x7f, C1 0x80-0x9f).
const c = (n: number) => String.fromCharCode(n);

describe("ulid", () => {
	test("shape: 26 Crockford chars", () => {
		const id = ulid();
		expect(id).toHaveLength(26);
		expect(id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
	});

	test("128-bit-ish entropy: distinct across a batch", () => {
		const ids = new Set(Array.from({ length: 1000 }, () => ulid()));
		expect(ids.size).toBe(1000);
	});

	test("roughly time-ordered: later call sorts >= earlier within same ms window", () => {
		// The 10-char time prefix is monotonic in Date.now(); two ids minted back
		// to back must have a non-decreasing time prefix.
		const a = ulid();
		const b = ulid();
		expect(a.slice(0, 10) <= b.slice(0, 10)).toBe(true);
	});
});

describe("isValidHex", () => {
	test("accepts #RRGGBB (either case)", () => {
		expect(isValidHex("#36F9F6")).toBe(true);
		expect(isValidHex("#abcdef")).toBe(true);
	});
	test("rejects malformed", () => {
		for (const bad of ["36F9F6", "#FFF", "#GGGGGG", "#36F9F6FF", "", "#12345"]) {
			expect(isValidHex(bad)).toBe(false);
		}
	});
});

describe("hexFg", () => {
	test("wraps valid hex in a truecolor SGR sequence", () => {
		const out = hexFg("#010203", "x");
		expect(out).toBe(`${c(0x1b)}[38;2;1;2;3mx${c(0x1b)}[39m`);
	});
	test("returns the string unchanged for invalid hex", () => {
		expect(hexFg("nope", "x")).toBe("x");
	});
});

describe("fallbackColor", () => {
	test("deterministic and always in-palette", () => {
		expect(fallbackColor("session-a")).toBe(fallbackColor("session-a"));
		expect(FALLBACK_PALETTE).toContain(fallbackColor("whatever-id"));
	});
});

describe("abbreviateModel", () => {
	test("strips claude- prefix and caps at 14 chars", () => {
		expect(abbreviateModel("claude-sonnet-4-5-20250101")).toBe("sonnet-4-5-202");
		expect(abbreviateModel("claude-opus")).toBe("opus");
		expect(abbreviateModel("gpt-4o")).toBe("gpt-4o");
	});
	test("non-string guard (the historical drift) returns empty string", () => {
		expect(abbreviateModel(undefined)).toBe("");
		expect(abbreviateModel(null)).toBe("");
		expect(abbreviateModel({ toString: () => "x" })).toBe("");
	});
});

describe("parseFrontmatter", () => {
	test("valid frontmatter: keys, quote-stripping, body", () => {
		const raw = '---\nname: planner\ncolor: "#36F9F6"\ndescription: \'does stuff\'\n---\nhello body\n';
		const r = parseFrontmatter(raw);
		expect(r.name).toBe("planner");
		expect(r.color).toBe("#36F9F6");
		expect(r.description).toBe("does stuff");
		expect(r.body).toBe("hello body\n");
	});
	test("CRLF line endings", () => {
		const raw = "---\r\nname: p\r\n---\r\nbody";
		const r = parseFrontmatter(raw);
		expect(r.name).toBe("p");
		expect(r.body).toBe("body");
	});
	test("no frontmatter: whole input is body", () => {
		const r = parseFrontmatter("just text\nmore");
		expect(r.body).toBe("just text\nmore");
		expect(r.name).toBeUndefined();
	});
	test("empty string", () => {
		const r = parseFrontmatter("");
		expect(r.body).toBe("");
		expect(r.name).toBeUndefined();
	});
	test("malformed (unterminated fence) falls back to body", () => {
		const r = parseFrontmatter("---\nname: x\nno closing fence");
		expect(r.body).toBe("---\nname: x\nno closing fence");
		expect(r.name).toBeUndefined();
	});
	test("empty frontmatter block", () => {
		const r = parseFrontmatter("---\n\n---\nbody");
		expect(r.name).toBeUndefined();
		expect(r.body).toBe("body");
	});
});

describe("sanitizePeerText", () => {
	test("strips C0 control chars and ANSI escape", () => {
		const dirty = `a${c(0x1b)}[31mb${c(0x00)}${c(0x07)}c`;
		expect(sanitizePeerText(dirty)).toBe("a[31mbc");
	});
	test("strips DEL (0x7f) and C1 (0x80-0x9f)", () => {
		const dirty = `x${c(0x7f)}${c(0x80)}${c(0x9f)}y`;
		expect(sanitizePeerText(dirty)).toBe("xy");
	});
	test("keeps normal text and printable unicode above C1", () => {
		expect(sanitizePeerText("hello world")).toBe("hello world");
		expect(sanitizePeerText("café")).toBe("café");
	});
	test("non-string returns the fallback", () => {
		expect(sanitizePeerText(undefined, "?")).toBe("?");
		expect(sanitizePeerText(42)).toBe("");
	});
	test("caps at max length (default 64)", () => {
		expect(sanitizePeerText("a".repeat(100))).toHaveLength(64);
		expect(sanitizePeerText("a".repeat(100), "", 10)).toHaveLength(10);
	});
});

describe("secretEqual", () => {
	test("equal secrets", () => {
		expect(secretEqual("s3cr3t-token", "s3cr3t-token")).toBe(true);
	});
	test("unequal same-length secrets", () => {
		expect(secretEqual("abcdef", "abcdeg")).toBe(false);
	});
	test("length mismatch (short-circuits before timingSafeEqual)", () => {
		expect(secretEqual("short", "longer-value")).toBe(false);
		expect(secretEqual("", "x")).toBe(false);
	});
	test("both empty are equal", () => {
		expect(secretEqual("", "")).toBe(true);
	});
});

describe("isSafePathComponent", () => {
	test("accepts safe names", () => {
		for (const ok of ["default", "agent-1", "my_project", "a.b", "ABC123"]) {
			expect(isSafePathComponent(ok)).toBe(true);
		}
	});
	test("rejects traversal, separators, dots, ADS, null-byte, empty", () => {
		for (const bad of ["..", ".", "../etc", "a/b", "a\\b", "a:b", `a${c(0)}b`, "", "a b", "a;b"]) {
			expect(isSafePathComponent(bad)).toBe(false);
		}
	});
	test("rejects non-strings", () => {
		expect(isSafePathComponent(undefined)).toBe(false);
		expect(isSafePathComponent(123)).toBe(false);
		expect(isSafePathComponent(null)).toBe(false);
	});
});

describe("isDuplicateRegistration", () => {
	test("matches already/duplicate messages (case-insensitive)", () => {
		expect(isDuplicateRegistration(new Error("Flag already registered"))).toBe(true);
		expect(isDuplicateRegistration(new Error("DUPLICATE tool"))).toBe(true);
		expect(isDuplicateRegistration("duplicate command")).toBe(true);
	});
	test("does not match unrelated errors", () => {
		expect(isDuplicateRegistration(new Error("boom"))).toBe(false);
		expect(isDuplicateRegistration(undefined)).toBe(false);
	});
});

describe("isWireRecord", () => {
	test("accepts plain and prototype-less JSON objects", () => {
		expect(isWireRecord({})).toBe(true);
		expect(isWireRecord({ type: "prompt" })).toBe(true);
		expect(isWireRecord(JSON.parse('{"msg_id":"x"}'))).toBe(true);
		expect(isWireRecord(Object.create(null))).toBe(true);
	});
	test("rejects null, arrays and primitives", () => {
		// The pre-guard `typeof obj === "object"` admitted both null-ish
		// handling bugs and arrays; a JSON array must never be narrowed to a
		// record and then read field-by-field.
		expect(isWireRecord(null)).toBe(false);
		expect(isWireRecord(undefined)).toBe(false);
		expect(isWireRecord([])).toBe(false);
		expect(isWireRecord([{ type: "prompt" }])).toBe(false);
		expect(isWireRecord(JSON.parse("[1,2,3]"))).toBe(false);
		expect(isWireRecord("prompt")).toBe(false);
		expect(isWireRecord(0)).toBe(false);
		expect(isWireRecord(false)).toBe(false);
	});
	test("a narrowed record still yields unknown fields (checked, not trusted)", () => {
		const v: unknown = JSON.parse('{"msg_id":123,"hops":"nope"}');
		if (!isWireRecord(v)) throw new Error("expected a wire record");
		// The point of the type: these reads are `unknown`, so the runtime
		// checks below are the only thing that can make them usable.
		expect(typeof v.msg_id === "string").toBe(false);
		expect(typeof v.hops === "number").toBe(false);
		expect(v.missing).toBeUndefined();
	});
});

describe("envBoundedInt", () => {
	test("unset / garbage / negative / zero fall back to default", () => {
		expect(envBoundedInt(undefined, 100)).toBe(100);
		expect(envBoundedInt("abc", 100)).toBe(100);
		expect(envBoundedInt("-5", 100)).toBe(100);
		expect(envBoundedInt("0", 100)).toBe(100);
		expect(envBoundedInt("Infinity", 100)).toBe(100);
	});
	test("clamps into [min, max]", () => {
		expect(envBoundedInt("5", 100, { min: 10, max: 20 })).toBe(10);
		expect(envBoundedInt("999", 100, { min: 10, max: 20 })).toBe(20);
		expect(envBoundedInt("15", 100, { min: 10, max: 20 })).toBe(15);
	});
	test("integer mode rejects fractional (coms.ts timer-knob semantics)", () => {
		expect(envBoundedInt("0.5", 100, { integer: true })).toBe(100);
		expect(envBoundedInt("10.5", 100, { integer: true, max: 1000 })).toBe(100);
		expect(envBoundedInt("10", 100, { integer: true, max: 1000 })).toBe(10);
	});
	test("non-integer mode accepts and clamps fractional (coms-net semantics)", () => {
		// coms-net's original envBoundedInt accepted finite >0 including fractional.
		expect(envBoundedInt("0.5", 100, { min: 1, max: 10 })).toBe(1);
		expect(envBoundedInt("5.5", 100, { min: 1, max: 10 })).toBe(5.5);
	});
	test("overflow: without max, huge finite values pass through", () => {
		expect(envBoundedInt("3000000000", 100, { integer: true })).toBe(3_000_000_000);
	});
	test("overflow: with the coms.ts 2^31-1 cap", () => {
		const INT_MAX = 2 ** 31 - 1;
		expect(envBoundedInt("3000000000", 100, { integer: true, max: INT_MAX })).toBe(INT_MAX);
	});
});

describe("nowIso", () => {
	test("ISO-8601 UTC instant, round-trips through Date", () => {
		const s = nowIso();
		expect(s).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
		expect(new Date(s).toISOString()).toBe(s);
	});
});

describe("shared caps", () => {
	test("response + schema caps hold the documented values", () => {
		// Both transports are behavioral peers: a reply/schema accepted by one
		// must not be nacked by the other. MAX_PROMPT_BYTES is deliberately NOT
		// here — it differs per transport (see DIVERGENCE.md).
		expect(MAX_RESPONSE_BYTES).toBe(256 * 1024);
		expect(MAX_RESPONSE_SCHEMA_BYTES).toBe(32_768);
	});
});

describe("findSystemPromptPath / readFrontmatterFromArgv", () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "coms-core-test-"));
	const md = path.join(dir, "agent.md");
	fs.writeFileSync(md, '---\nname: planner\ncolor: "#36F9F6"\ndescription: plans things\n---\nbody text\n');
	const notMd = path.join(dir, "agent.txt");
	fs.writeFileSync(notMd, "nope");
	afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

	test("empty argv finds nothing", () => {
		expect(findSystemPromptPath([])).toBeNull();
		expect(readFrontmatterFromArgv([])).toEqual({});
	});
	test("accepts both `--flag path` and `--flag=path`", () => {
		expect(findSystemPromptPath(["--system-prompt", md])).toBe(md);
		expect(findSystemPromptPath([`--system-prompt=${md}`])).toBe(md);
		expect(findSystemPromptPath(["--append-system-prompt", md])).toBe(md);
		expect(findSystemPromptPath([`--append-system-prompt=${md}`])).toBe(md);
	});
	test("--system-prompt wins over --append-system-prompt regardless of argv order", () => {
		const md2 = path.join(dir, "other.md");
		fs.writeFileSync(md2, "---\nname: other\n---\nx\n");
		expect(findSystemPromptPath(["--append-system-prompt", md2, "--system-prompt", md])).toBe(md);
		expect(findSystemPromptPath(["--system-prompt", md, "--append-system-prompt", md2])).toBe(md);
	});
	test("ignores non-.md, missing files, directories and dangling trailing flags", () => {
		expect(findSystemPromptPath(["--system-prompt", notMd])).toBeNull();
		expect(findSystemPromptPath(["--system-prompt", path.join(dir, "gone.md")])).toBeNull();
		expect(findSystemPromptPath(["--system-prompt", dir])).toBeNull();
		expect(findSystemPromptPath(["--system-prompt"])).toBeNull();
		expect(findSystemPromptPath(["--system-prompt="])).toBeNull();
	});
	test("reads name/description/color out of the frontmatter", () => {
		expect(readFrontmatterFromArgv(["--system-prompt", md])).toEqual({
			name: "planner",
			description: "plans things",
			color: "#36F9F6",
		});
	});
	test("malformed frontmatter yields all-undefined, not a throw", () => {
		const bad = path.join(dir, "bad.md");
		fs.writeFileSync(bad, "no frontmatter here\n");
		expect(readFrontmatterFromArgv(["--system-prompt", bad])).toEqual({
			name: undefined,
			description: undefined,
			color: undefined,
		});
	});
	test("file that disappears after a good read degrades to {}, not a throw", () => {
		const gone = path.join(dir, "vanishes.md");
		fs.writeFileSync(gone, "---\nname: x\n---\n");
		const argv = ["--system-prompt", gone];
		expect(readFrontmatterFromArgv(argv)).toEqual({ name: "x", description: undefined, color: undefined });
		fs.rmSync(gone);
		expect(readFrontmatterFromArgv(argv)).toEqual({});
	});
});
