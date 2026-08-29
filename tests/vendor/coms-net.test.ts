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
		// The compile-time half of this test: reading a WireRecord field
		// straight into a string position is an error. If someone widens a
		// renderCall signature back to `any`, this @ts-expect-error goes unused
		// and `bunx tsc --noEmit` fails.
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
});
