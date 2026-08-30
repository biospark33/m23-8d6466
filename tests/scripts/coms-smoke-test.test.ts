/**
 * F013/F014 — the smoke test's child-env allowlist must FAIL CLOSED, and the
 * script must be importable (no spawns, no report) so this file can exist at all.
 */
import { describe, expect, test } from "bun:test";
import {
	type SpawnOutcome,
	detectAuthFailure,
	isAllowlistedEnvKey,
	parseEvents,
	smokeChildEnv,
} from "../../scripts/coms-smoke-test.ts";

describe("smokeChildEnv (F013)", () => {
	test("fails closed when no provider can be identified", () => {
		expect(() => smokeChildEnv({ PI_SMOKE_MODEL: undefined })).toThrow(/env_scope/);
	});

	test("fails closed when the provider is known but its key is absent", () => {
		expect(() => smokeChildEnv({ PI_SMOKE_MODEL: "anthropic/claude-haiku-4.5" })).toThrow(
			/env_scope/,
		);
	});

	test("does not leak ambient secrets on the fail-closed path", () => {
		expect(() => smokeChildEnv({ SOME_AMBIENT_SECRET: "sk-live-abc" })).toThrow(/env_scope/);
		expect(() => smokeChildEnv({ SOME_AMBIENT_SECRET: "sk-live-abc" })).toThrow(
			/^(?!.*sk-live-abc)/s,
		);
	});

	test("passes the full env only behind the explicit opt-in", () => {
		const { env, scope } = smokeChildEnv({
			PI_SMOKE_ALLOW_FULL_ENV: "1",
			SOME_AMBIENT_SECRET: "sk-live-abc",
		});
		expect(env.SOME_AMBIENT_SECRET).toBe("sk-live-abc");
		expect(scope).toMatch(/PI_SMOKE_ALLOW_FULL_ENV=1/);
	});

	test("forwards only the provider key implied by the model, plus the allowlist", () => {
		const { env, scope } = smokeChildEnv({
			PI_SMOKE_MODEL: "openrouter/anthropic/claude-haiku-4.5",
			OPENROUTER_API_KEY: "or-key",
			ANTHROPIC_API_KEY: "ant-key",
			SOME_AMBIENT_SECRET: "sk-live-abc",
			PATH: "/usr/bin",
			LC_ALL: "C",
		});
		expect(env.OPENROUTER_API_KEY).toBe("or-key");
		expect(env.ANTHROPIC_API_KEY).toBeUndefined();
		expect(env.SOME_AMBIENT_SECRET).toBeUndefined();
		expect(env.PATH).toBe("/usr/bin");
		expect(env.LC_ALL).toBe("C");
		expect(scope).toMatch(/^allowlist \(OPENROUTER_API_KEY/);
	});

	test("does not mutate process.env", () => {
		const snapshot = { ...process.env };
		const { env } = smokeChildEnv({ PI_SMOKE_ALLOW_FULL_ENV: "1", PATH: "/usr/bin" });
		env.INJECTED_BY_TEST = "1";
		expect({ ...process.env }).toEqual(snapshot);
	});
});

describe("isAllowlistedEnvKey", () => {
	test("POSIX matches exact case only; LC_* always passes", () => {
		expect(isAllowlistedEnvKey("PATH", "linux")).toBe(true);
		expect(isAllowlistedEnvKey("Path", "linux")).toBe(false);
		expect(isAllowlistedEnvKey("LC_CTYPE", "linux")).toBe(true);
		expect(isAllowlistedEnvKey("ANTHROPIC_API_KEY", "linux")).toBe(false);
	});

	test("win32 matches case-insensitively and adds the win32 extras", () => {
		expect(isAllowlistedEnvKey("Path", "win32")).toBe(true);
		expect(isAllowlistedEnvKey("SystemRoot", "win32")).toBe(true);
		expect(isAllowlistedEnvKey("SystemRoot", "linux")).toBe(false);
	});
});

// Importability (F014): these two were untestable while the file self-executed.
describe("importable pure helpers (F014)", () => {
	test("parseEvents keeps well-formed JSON lines and drops the rest", () => {
		expect(parseEvents('{"type":"agent_end"}\nnot json\n\n{"type":"x"}')).toEqual([
			{ type: "agent_end" },
			{ type: "x" },
		]);
	});

	test("detectAuthFailure spots an auth error in captured output", () => {
		const out: SpawnOutcome = {
			status: 1,
			signal: null,
			stdout: "",
			stderr: "401 Unauthorized",
			truncated: false,
			error: null,
		};
		expect(detectAuthFailure(out, [])).toBe(true);
		expect(detectAuthFailure({ ...out, stderr: "boom" }, [])).toBe(false);
	});
});
