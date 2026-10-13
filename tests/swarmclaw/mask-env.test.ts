/**
 * INV-SC5 unit pins for the extracted masking primitive (src/lib/mask-env.ts,
 * z5 I2): every env value masked to `***`, key names visible, no heuristic
 * matching (key names and value shapes are irrelevant), and no mutation of
 * the caller's env object. Behavior-level INV-SC5 pins live in the routes
 * tests; these pin the function contract directly at its single home.
 */
import { describe, expect, test } from "bun:test";
import { maskEnv } from "../../src/lib/mask-env.ts";

describe("maskEnv (INV-SC5, z5 I2)", () => {
  test("undefined masks to an empty snapshot", () => {
    expect(maskEnv(undefined)).toEqual({});
  });

  test("an empty env masks to an empty snapshot", () => {
    expect(maskEnv({})).toEqual({});
  });

  test("every value is masked to ***, key names stay visible", () => {
    const env = { SWARMCLAW_AUTH_TOKEN: "hunter2", DATABASE_URL: "postgres://…", PATH: "/bin:/usr/bin" };
    const masked = maskEnv(env);
    expect(Object.keys(masked).sort()).toEqual(["DATABASE_URL", "PATH", "SWARMCLAW_AUTH_TOKEN"]);
    expect(masked.SWARMCLAW_AUTH_TOKEN).toBe("***");
    expect(masked.DATABASE_URL).toBe("***");
    expect(masked.PATH).toBe("***");
  });

  test("no heuristic matching: key names and value lengths are irrelevant", () => {
    // The docblock bans key-name heuristics (they under-cover PASS/DSN and
    // over-cover MONKEY): ALL values mask identically regardless of either.
    const masked = maskEnv({ PASS: "x", DSN: "a-very-long-secret-value", MONKEY: "y", PUBLIC_NAME: "z" });
    expect(Object.values(masked)).toEqual(["***", "***", "***", "***"]);
  });

  test("non-empty env round-trips its key set with every value masked", () => {
    const env = { A: "1", B: "2", C: "3" };
    const masked = maskEnv(env);
    expect(Object.keys(masked)).toEqual(["A", "B", "C"]);
    expect(Object.values(masked)).toEqual(["***", "***", "***"]);
  });

  test("purity: the caller's env object is not mutated", () => {
    const env = { TOKEN: "secret" };
    const before = { ...env };
    maskEnv(env);
    expect(env).toEqual(before);
    expect(env.TOKEN).toBe("secret");
    expect(maskEnv(env).TOKEN).toBe("***");
  });

  test("documented current behavior: a __proto__ key is dropped from the snapshot", () => {
    // VERBATIM-MOVE NOTE (z5 I2): maskEnv moved byte-identical from its
    // origin, so this inherited quirk is pinned as-is — `out[k] = "***"`
    // prototype-assigns instead of defining an own property, so an own
    // enumerable "__proto__" key is LOST from the output while every other
    // key masks normally. Fixing it would violate the no-improvement-while-
    // moving mandate; deferred to a successor story.
    const env: Record<string, string> = {};
    Object.defineProperty(env, "__proto__", { value: "x", enumerable: true, writable: true, configurable: true });
    env.A = "1";
    const masked = maskEnv(env);
    // The input really carries the own key; the output really loses it.
    expect(Object.keys(env).sort()).toEqual(["A", "__proto__"]);
    expect(Object.keys(masked)).toEqual(["A"]);
    expect(masked.A).toBe("***");
  });
});
