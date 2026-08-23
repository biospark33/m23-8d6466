/**
 * DF4.2 unit tests for src/lib/models.ts (AC1).
 */
import { describe, expect, test } from "bun:test";
import { modelIcon, modelName } from "../../src/lib/models.ts";

describe("modelIcon", () => {
  test("null/undefined/empty → no icon", () => {
    expect(modelIcon(null)).toBeNull();
    expect(modelIcon(undefined)).toBeNull();
    expect(modelIcon("")).toBeNull();
  });

  test("matches by needle, case-insensitively", () => {
    expect(modelIcon("Claude Opus 5")).toBe("/models/claude.png");
    expect(modelIcon("gemini-2.5-pro")).toBe("/models/gemini.png");
    expect(modelIcon("moonshotai/kimi-k2")).toBe("/models/kimi.png");
    expect(modelIcon("gpt-4o")).toBe("/models/openai.png");
    expect(modelIcon("GLM-4.6")).toBe("/models/zai.png");
  });

  test("first matching entry wins over a later one", () => {
    // "claude-opus" hits the claude needle list before any other row could.
    expect(modelIcon("anthropic/claude-opus-4")).toBe("/models/claude.png");
  });

  test("unknown model → no icon", () => {
    expect(modelIcon("some-unlisted-model")).toBeNull();
  });
});

describe("modelName", () => {
  test("null/undefined → empty string", () => {
    expect(modelName(null)).toBe("");
    expect(modelName(undefined)).toBe("");
  });

  test("provider-qualified ID keeps only the last segment", () => {
    expect(modelName("anthropic/claude-opus-5")).toBe("claude-opus-5");
  });

  test("unqualified ID passes through unchanged", () => {
    expect(modelName("claude-opus-5")).toBe("claude-opus-5");
  });

  test("trailing slash does not produce an empty tail", () => {
    expect(modelName("anthropic/claude-opus-5/")).toBe("claude-opus-5");
  });
});
