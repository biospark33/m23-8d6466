import { mock } from "bun:test";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// The kg-recall entry imports "typebox", which is not a repo dependency (Pi's
// own jiti loader aliases it at runtime in the box), so these tests mock it
// process-globally. A minimal shim here poisons every other bun test file in
// the same process: pi's extension loader natively loads its extension graph,
// hits the shim's missing typebox surface, falls back to jiti alias-
// transpiling, and every @earendil-works/pi-ai subpath import then dies on the
// alias prefix ("Cannot find module .../pi-ai/dist/compat.js/utils/...").
// Serving the REAL typebox from the host pi install keeps that graph healthy
// (full suite green); CI (no ~/.pi) keeps the shim, which is all these tests
// themselves need.

const SHIM = {
	Type: {
		String: (options?: Record<string, unknown>) => ({ type: "string", ...options }),
		Integer: (options?: Record<string, unknown>) => ({ type: "integer", ...options }),
		Object: (props: Record<string, unknown>, options?: Record<string, unknown>) => ({
			type: "object",
			properties: props,
			...(options ?? {}),
		}),
		Optional: (schema: unknown) => schema,
	},
};

let surface: Record<string, unknown> = SHIM;
try {
	const version = readFileSync(join(homedir(), ".pi/agent/install/current-version"), "utf8").trim();
	const real = await import(
		join(homedir(), ".pi/agent/install/releases", version, "node_modules/typebox/build/index.mjs")
	);
	surface = { ...real };
} catch {}

export function registerTypeboxMock(): void {
	mock.module("typebox", () => surface);
}
