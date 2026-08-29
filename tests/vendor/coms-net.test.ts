/**
 * Tool-argument trust boundary (F080 / issue #60 follow-up).
 *
 * Issue #60 typed the *wire* boundary (`WireRecord` / `isWireRecord` /
 * `sanitizeCard`) and left the *tool-argument* boundary casting to `any`.
 * `renderCall(args, ...)` receives raw model output — reachable by prompt
 * injection through an inbound peer prompt — so its args are now typed
 * `WireRecord`, which makes every field read as `unknown` and forces it
 * through `sanitizePeerText`. `execute(..., params)` keeps its TypeBox-derived
 * `Static<TParams>` type (the host validates against the schema); its casts
 * were pure cruft and are gone.
 *
 * Like `coms-wire-guards.test.ts`, the handlers are unexported closures inside
 * the extension factories, so this covers (1) the compile-time force, (2) the
 * runtime behaviour of the expression shape the fixed handler now uses, and
 * (3) the vendored source, which is the only thing that catches a revert
 * inside the closure.
 */
import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { sanitizePeerText, type WireRecord } from "../../pi-vs-claude-code-vendor/coms-core.ts";

const VENDOR = path.join(import.meta.dir, "..", "..", "pi-vs-claude-code-vendor");
const comsNetSrc = fs.readFileSync(path.join(VENDOR, "coms-net.ts"), "utf8");
const comsSrc = fs.readFileSync(path.join(VENDOR, "coms.ts"), "utf8");

// A hostile peer prompt steering the model into an ANSI escape + C0/C1 control
// characters in a tool argument — the terminal-injection channel
// sanitizePeerText closes. Built from escapes so this file stays plain ASCII.
const ESC = String.fromCharCode(0x1b);
const BEL = String.fromCharCode(0x07);
const NUL = String.fromCharCode(0x00);
const HOSTILE = `peer${ESC}[31m${BEL}evilx${NUL}`;
const CLEAN = "peer[31mevilx";

describe("tool-argument boundary is typed WireRecord", () => {
	test("a tool argument that skips sanitizePeerText is refused by the type-forced check", () => {
		const args: WireRecord = { target: HOSTILE };
		// What this pins: `WireRecord`'s fields are `unknown`, so reading one
		// into a string position is a compile error — i.e. the narrowing does
		// force sanitizePeerText wherever it is applied. It does NOT pin the
		// production signatures: this declares its own local `args` and never
		// imports the handlers (they are unexported closures inside the
		// extension factories). The `args: WireRecord` regex assertion below is
		// what catches a handler signature widening back to `any`.
		// @ts-expect-error — args.target is `unknown`; it must go through sanitizePeerText
		const unsanitized: string = args.target;
		void unsanitized;
		// The sanitized read is what the handler actually does, and it compiles.
		const sanitized: string = sanitizePeerText(args.target, "?");
		expect(sanitized).toBe(CLEAN);
	});

	test("the previously unsanitized coms_send renderCall path now sanitizes", () => {
		// coms.ts's coms_send renderCall, reduced to the lines under test. It
		// used to read `(args as any).target ?? "?"` / `(args as any).prompt ?? ""`
		// and render them straight into the TUI.
		const renderCall = (args: WireRecord) => {
			const tgt = sanitizePeerText(args.target, "?");
			const prompt = sanitizePeerText(args.prompt);
			const preview = prompt.length > 60 ? `${prompt.slice(0, 57)}...` : prompt;
			return `${tgt} - ${preview}`;
		};
		const out = renderCall({ target: HOSTILE, prompt: HOSTILE });
		expect(out).not.toContain(ESC);
		expect(out).not.toContain(BEL);
		expect(out).not.toContain(NUL);
		expect(out).toBe(`${CLEAN} - ${CLEAN}`);
	});

	test("renderResult sanitizes the hub-supplied error and status", () => {
		// coms_net_await / coms_await renderResult, and coms_net_get's status,
		// reduced to the lines under test. All three rendered the peer/hub
		// string raw before this change.
		const renderError = (d: { error?: unknown }) => `x ${sanitizePeerText(d.error, "?", 256)}`;
		expect(renderError({ error: HOSTILE })).toBe(`x ${CLEAN}`);
		expect(renderError({ error: { not: "a string" } })).toBe("x ?");
		// 256, not the 64-char default — a whole error message must survive.
		const long = "e".repeat(200);
		expect(renderError({ error: long })).toBe(`x ${long}`);

		const renderStatus = (d: { status?: unknown }) => sanitizePeerText(d?.status, "?", 32);
		expect(renderStatus({ status: HOSTILE })).toBe(CLEAN);
		expect(renderStatus({})).toBe("?");
		// The status still drives the colour branch, so the enum must survive.
		expect(renderStatus({ status: "complete" })).toBe("complete");
	});

	test("non-string and missing tool arguments fall back instead of throwing", () => {
		for (const bad of [undefined, null, 7, {}, []]) {
			expect(sanitizePeerText(bad, "?")).toBe("?");
		}
	});
});

describe("vendored source keeps the narrowed boundary", () => {
	test("no tool handler still casts its params/args to any", () => {
		for (const src of [comsSrc, comsNetSrc]) {
			expect(/\((?:params|args) as any\)/.test(src)).toBe(false);
		}
	});

	test("every renderCall in both transports declares args as WireRecord", () => {
		for (const src of [comsSrc, comsNetSrc]) {
			const sigs = src.match(/^\t\trenderCall\(.*$/gm) ?? [];
			expect(sigs.length).toBeGreaterThan(0);
			for (const sig of sigs) expect(sig).toContain("args: WireRecord");
		}
	});

	test("coms.ts coms_send renderCall sanitizes both target and prompt", () => {
		expect(comsSrc.includes('const tgt = sanitizePeerText(args.target, "?");')).toBe(true);
		expect(comsSrc.includes("const prompt = sanitizePeerText(args.prompt);")).toBe(true);
	});

	test("no renderResult still renders a peer-controlled string raw", () => {
		for (const src of [comsSrc, comsNetSrc]) {
			expect(src.includes("`\u2717 ${d.error}`")).toBe(false);
			expect(src.includes('sanitizePeerText(d.error, "?", 256)')).toBe(true);
		}
		expect(comsNetSrc.includes('const status = sanitizePeerText(d?.status, "?", 32);')).toBe(true);
	});

	test("response_schema is Unknown, not Any, so its guard is load-bearing", () => {
		expect(comsNetSrc.includes("response_schema: Type.Optional(Type.Unknown(")).toBe(true);
		expect(/response_schema: Type\.Optional\(Type\.Any\(/.test(comsNetSrc)).toBe(false);
	});
});
