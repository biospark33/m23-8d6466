/**
 * Regression tests for three wire-boundary misclassifications in the vendored
 * coms transports (PR #100 review).
 *
 * The handlers involved — `handleSseEvent`, `coms_await`, `coms_net_await`,
 * `coms_get`, `coms_net_get` — are closures created inside the extension
 * factories in `coms.ts` / `coms-net.ts`; nothing exports them and constructing
 * the factory needs a live `pi` host plus a socket/SSE transport. Exporting them
 * purely to test them would be a bigger divergence from upstream than the fixes
 * themselves, so this file covers what IS reachable:
 *
 *   1. the semantics of each guard, asserted on the same expression shape the
 *      handler now uses (these fail if the predicate is reverted to truthiness);
 *   2. the vendored source, asserted to still contain the guard — the only
 *      check that catches a revert inside the closure.
 *
 * `isWireRecord` (the gate every one of these paths runs behind) is covered in
 * coms-core.test.ts.
 */
import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";

const VENDOR = path.join(import.meta.dir, "..", "..", "pi-vs-claude-code-vendor");
const comsNetSrc = fs.readFileSync(path.join(VENDOR, "coms-net.ts"), "utf8");
const comsSrc = fs.readFileSync(path.join(VENDOR, "coms.ts"), "utf8");

// Assert on a boolean, not the string: a failing toContain on a 3k-line file
// dumps the whole file into the test output.
const has = (src: string, needle: string) => src.includes(needle);

// ---------------------------------------------------------------------------
// pool_snapshot: a malformed frame must not clear the pool
// ---------------------------------------------------------------------------

describe("coms-net pool_snapshot — malformed frames leave the pool intact", () => {
	// The handler body, reduced to the two lines under test.
	function applySnapshot(peerCards: Map<string, unknown>, data: { agents?: unknown }): void {
		if (!Array.isArray(data.agents)) return;
		peerCards.clear();
		for (const a of data.agents) {
			if (typeof a === "string") peerCards.set(a, a);
		}
	}

	test("non-array `agents` returns before clear (the reported bug)", () => {
		for (const agents of [undefined, null, "nope", 7, {}, { length: 2 }]) {
			const pool = new Map<string, unknown>([["peer-a", "peer-a"]]);
			applySnapshot(pool, { agents });
			expect(pool.size).toBe(1);
		}
	});

	test("an empty array is a legitimate snapshot and does clear the pool", () => {
		const pool = new Map<string, unknown>([["peer-a", "peer-a"]]);
		applySnapshot(pool, { agents: [] });
		expect(pool.size).toBe(0);
	});

	test("a valid snapshot replaces the pool", () => {
		const pool = new Map<string, unknown>([["peer-a", "peer-a"]]);
		applySnapshot(pool, { agents: ["peer-b", "peer-c"] });
		expect([...pool.keys()]).toEqual(["peer-b", "peer-c"]);
	});

	test("source still guards before mutating", () => {
		expect(has(comsNetSrc, "if (!Array.isArray(data.agents)) return;\n\t\t\t\tpeerCards.clear();")).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// error: "" is a failure, not a blank success
// ---------------------------------------------------------------------------

describe("empty peer error string is treated as an error", () => {
	// Both transports classify a settled reply with this predicate.
	const failed = (r: { error?: string | null }) => r.error != null;

	test('error: "" classifies as an error (truthiness would not)', () => {
		expect(failed({ error: "" })).toBe(true);
	});

	test("null/undefined/absent still classify as success", () => {
		expect(failed({ error: null })).toBe(false);
		expect(failed({ error: undefined })).toBe(false);
		expect(failed({})).toBe(false);
	});

	test("a non-empty error still classifies as an error", () => {
		expect(failed({ error: "timeout" })).toBe(true);
	});

	// `error: ""` is genuinely reachable: neither transport rejects or
	// normalizes it. coms.ts `isValidEnvelope` checks only type/msg_id/sender
	// fields, and both settle paths coerce with `typeof x === "string" ? x : null`,
	// which preserves "".
	test("coms.ts handleResponse preserves an empty error string", () => {
		expect(has(comsSrc, 'error: typeof env.error === "string" ? env.error : null')).toBe(true);
	});

	test("coms-net.ts handleInboundResponse preserves an empty error string", () => {
		expect(has(comsNetSrc, 'const errVal: string | null = typeof data.error === "string" ? data.error : null;')).toBe(true);
	});

	test("no settle path in either transport still tests the error truthily", () => {
		for (const src of [comsSrc, comsNetSrc]) {
			// Positive assertion first: the blacklist below only rules out the
			// truthiness spellings we happen to have thought of, so on its own it
			// would also pass for an inverted check or a renamed local. Requiring
			// the nullish classification to be PRESENT is what actually pins the
			// contract; the blacklist then catches a partial revert.
			expect(/\b(?:winner|r)\.error\s*!={1,2}\s*null/.test(src)).toBe(true);
			expect(has(src, "if (winner.error) {")).toBe(false);
			expect(has(src, "if (r.error) {")).toBe(false);
			expect(/\br\.error\s*\n?\s*\?\s*`coms/.test(src)).toBe(false);
		}
	});
});
