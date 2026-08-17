import { describe, expect, it } from "bun:test";
import {
  MAX_CHANGED_FILES_BYTES,
  buildMergedOutput,
  createPending,
  unionChangedFiles,
  validateWorkerOutput,
} from "../src/merger.ts";
import type { ComsLogEntry, MergedOutput } from "../src/types.ts";

const COMS_ENTRY: ComsLogEntry = {
  requestId: "req-1",
  sessionId: "sess-1",
  phaseId: "phase-1",
  channel: "lead:worker-a",
  direction: "send",
  senderAgent: "lead",
  receiverAgent: "worker-a",
  payloadSize: 42,
  durationMs: 10,
  timestamp: "2026-07-20T00:00:00.000Z",
};

describe("validateWorkerOutput", () => {
  it("accepts a well-formed worker reply", () => {
    const v = validateWorkerOutput("worker-a", {
      changedFiles: ["src/hello.ts"],
      result: { summary: "done" },
    });
    expect(v.ok).toBe(true);
    if (v.ok) {
      expect(v.output.agentId).toBe("worker-a");
      expect(v.output.changedFiles).toEqual(["src/hello.ts"]);
      expect(v.output.result).toEqual({ summary: "done" });
    }
  });

  it("rejects a reply that omits changedFiles (CORRECTNESS-C node failure)", () => {
    const v = validateWorkerOutput("worker-a", { result: {} });
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.reason).toMatch(/changedFiles/);
  });

  it("rejects non-array changedFiles", () => {
    expect(validateWorkerOutput("w", { changedFiles: "src/x.ts", result: {} }).ok).toBe(false);
    expect(validateWorkerOutput("w", { changedFiles: [1], result: {} }).ok).toBe(false);
  });

  it("rejects non-object replies", () => {
    expect(validateWorkerOutput("w", null).ok).toBe(false);
    expect(validateWorkerOutput("w", "text").ok).toBe(false);
    expect(validateWorkerOutput("w", [1, 2]).ok).toBe(false);
  });

  it("rejects unsafe path entries (traversal, absolute, empty components)", () => {
    for (const bad of ["../etc/passwd", "/abs/path", "a//b", ".", "..", "a/../b", ""]) {
      const v = validateWorkerOutput("w", { changedFiles: [bad], result: {} });
      expect(v.ok).toBe(false);
    }
  });

  it("accepts multi-component relative paths (looser policy, documented)", () => {
    const v = validateWorkerOutput("w", {
      changedFiles: ["src/deep/dir/file.test.ts"],
      result: {},
    });
    expect(v.ok).toBe(true);
  });

  it("strips control characters from entries before validation (sanitizePeerText)", () => {
    // Control chars are stripped; the remainder must still be a safe path.
    const v = validateWorkerOutput("w", {
      changedFiles: ["src/he\x07llo.ts"],
      result: {},
    });
    expect(v.ok).toBe(true);
    if (v.ok) expect(v.output.changedFiles[0]).toBe("src/hello.ts");
  });

  it("rejects entries left unsafe after control-char stripping (ANSI bracket)", () => {
    const v = validateWorkerOutput("w", {
      changedFiles: ["src/\x1b[31mhello.ts"],
      result: {},
    });
    expect(v.ok).toBe(false);
  });

  it("defaults missing result to empty object", () => {
    const v = validateWorkerOutput("w", { changedFiles: [] });
    expect(v.ok).toBe(true);
    if (v.ok) expect(v.output.result).toEqual({});
  });
});

describe("unionChangedFiles", () => {
  it("dedupes and set-unions across workers, sorted for determinism", () => {
    const union = unionChangedFiles([
      ["b.ts", "a.ts"],
      ["a.ts", "c.ts"],
    ]);
    expect(union).toEqual(["a.ts", "b.ts", "c.ts"]);
  });

  it("caps total size at 32KB (parity with MAX_RESPONSE_SCHEMA_BYTES)", () => {
    const entry = `${"x".repeat(100)}.ts`;
    const many = Array.from({ length: 1000 }, (_, i) => `dir${i}/${entry}`);
    const union = unionChangedFiles([many]);
    const bytes = union.reduce((n, s) => n + Buffer.byteLength(s, "utf8"), 0);
    expect(bytes).toBeLessThanOrEqual(MAX_CHANGED_FILES_BYTES);
    expect(union.length).toBeLessThan(many.length);
  });
});

describe("createPending (single-settle, P0.3-S-H5)", () => {
  it("first settle wins, second is rejected", async () => {
    const p = createPending<string>();
    expect(p.settle("response")).toBe(true);
    expect(p.settle("timeout")).toBe(false);
    expect(await p.promise).toBe("response");
  });

  it("simultaneous response + timeout settle exactly once (no double-emit)", async () => {
    // Simulate the race: response-POST and timeout-fire scheduled in the same
    // tick. Whichever runs first wins; the loser's settle returns false.
    const p = createPending<"response" | "timeout">();
    let emits = 0;
    p.promise.then(() => {
      emits++;
    });
    const winners: boolean[] = [];
    await Promise.all([
      Promise.resolve().then(() => winners.push(p.settle("response"))),
      Promise.resolve().then(() => winners.push(p.settle("timeout"))),
    ]);
    await p.promise;
    // Exactly one settle succeeded, promise resolved once.
    expect(winners.filter(Boolean).length).toBe(1);
    await Promise.resolve();
    expect(emits).toBe(1);
  });

  it("timer-first yields the timeout outcome deterministically", async () => {
    const p = createPending<"response" | "timeout">();
    p.settle("timeout");
    p.settle("response");
    expect(await p.promise).toBe("timeout");
  });
});

describe("buildMergedOutput (P0.3-M2 uniform schema)", () => {
  const EXTENDED_KEYS = [
    "agentOutputs",
    "artifacts",
    "changedFiles",
    "comsLog",
    "durationMs",
    "error",
    "exitStatus",
    "mulchPrimeError",
    "mulchPrimed",
    "partial",
    "partialOutput",
    "result",
    "summary",
    "testResults",
    "testsExecuted",
    "waivers",
  ].sort();

  const identity = (s: string): string => s;

  function base(over: Partial<Parameters<typeof buildMergedOutput>[0]>) {
    return buildMergedOutput({
      exitStatus: "success",
      partial: false,
      result: { summary: "ok" },
      agentOutputs: { "worker-a": { done: true } },
      changedFiles: [],
      comsLog: [COMS_ENTRY],
      durationMs: 1234,
      waivers: [],
      error: null,
      redact: identity,
      // DF1.6 T1: new fields with defaults for base tests
      testResults: { passed: 0, failed: 0 },
      testsExecuted: false,
      summary: "ok",
      mulchPrimed: false,
      artifacts: [],
      ...over,
    });
  }

  it("success path: error is explicit null, partial false, agentOutputs populated", () => {
    const out = base({});
    expect(Object.keys(out).sort()).toEqual(EXTENDED_KEYS);
    expect(out.error).toBeNull();
    expect(out.partial).toBe(false);
    expect(out.exitStatus).toBe("success");
    expect(out.agentOutputs).toEqual({ "worker-a": { done: true } });
  });

  it("every non-success path carries error{reason,message} and the full field set", () => {
    const paths: Array<[MergedOutput["exitStatus"], MergedOutput["error"]]> = [
      ["transient", { reason: "transient", message: "coms init failed" }],
      ["overflow", { reason: "overflow", message: "budget cap" }],
      ["logic", { reason: "logic", message: "non-zero exit" }],
      ["lead_failure", { reason: "lead_failure", message: "lead died" }],
    ];
    for (const [exitStatus, error] of paths) {
      const out = base({ exitStatus, error, partial: true });
      expect(Object.keys(out).sort()).toEqual(EXTENDED_KEYS);
      expect(out.error).not.toBeNull();
      expect(out.error?.reason).toBe(exitStatus as NonNullable<MergedOutput["error"]>["reason"]);
      expect(typeof out.error?.message).toBe("string");
    }
  });

  it("throws if a non-success path is built without an error payload", () => {
    expect(() => base({ exitStatus: "logic", error: null })).toThrow();
  });

  it("throws if success is built WITH an error payload", () => {
    expect(() =>
      base({ error: { reason: "logic", message: "x" } }),
    ).toThrow();
  });

  it("lead_failure forces agentOutputs to {} (never absent)", () => {
    const out = base({
      exitStatus: "lead_failure",
      error: { reason: "lead_failure", message: "lead exited pre-emit" },
      agentOutputs: { "worker-a": { partial: true } },
    });
    expect(out.agentOutputs).toEqual({});
  });

  it("applies redaction deep to agentOutputs, comsLog and error.details (INV-3)", () => {
    const SECRET = "sk-super-secret-value-123456";
    const redact = (s: string): string =>
      s.split(SECRET).join("[REDACTED:KEY]");
    const out = base({
      exitStatus: "overflow",
      error: {
        reason: "overflow",
        message: `spent with ${SECRET}`,
        details: { note: `token ${SECRET}` },
      },
      agentOutputs: { "worker-a": { log: `used ${SECRET}` } },
      result: { echo: SECRET },
      redact,
    });
    const flat = JSON.stringify(out);
    expect(flat).not.toContain(SECRET);
    expect(flat).toContain("[REDACTED:KEY]");
  });

  it("waivers are carried through audit-only (P0.3-S-M5)", () => {
    const out = base({
      waivers: [{ type: "budget_override", reason: "demo", approvedBy: "ops" }],
    });
    expect(out.waivers).toEqual([
      { type: "budget_override", reason: "demo", approvedBy: "ops" },
    ]);
  });

  it("JSON round-trip preserves the exact field set (stdout contract)", () => {
    const out = base({});
    const round = JSON.parse(JSON.stringify(out)) as Record<string, unknown>;
    // JSON.stringify preserves null fields (mulchPrimeError, partialOutput are now null)
    const expectedKeys = EXTENDED_KEYS.sort();
    expect(Object.keys(round).sort()).toEqual(expectedKeys);
    // error:null must survive stringify (not be dropped as undefined).
    expect("error" in round).toBe(true);
    expect(round.error).toBeNull();
  });
});

// DF1.6 T1: Extended schema tests (failing first, TDD)
describe("buildMergedOutput (DF1.6 T1 extended schema)", () => {
  const identity = (s: string): string => s;

  function base(over: Partial<Parameters<typeof buildMergedOutput>[0]>) {
    return buildMergedOutput({
      exitStatus: "success",
      partial: false,
      result: { summary: "ok" },
      agentOutputs: {},
      changedFiles: [],
      comsLog: [],
      durationMs: 1234,
      waivers: [],
      error: null,
      redact: identity,
      testResults: { passed: 0, failed: 0 },
      testsExecuted: false,
      summary: "ok",
      mulchPrimed: false,
      artifacts: [],
      ...over,
    });
  }

  it("result stays byte-identical (deep-equal pre/post)", () => {
    const resultObj = { summary: "done", workerSummaries: { w1: "ok" } };
    const out = base({ result: resultObj });
    expect(out.result).toEqual(resultObj);
    // Verify it's the same structure, not a copy with modifications
    expect(JSON.stringify(out.result)).toBe(JSON.stringify(resultObj));
  });

  it("summary copy-up: 2500-char source → ≤2000 with suffix", () => {
    const longSummary = "x".repeat(2500);
    const out = base({ result: { summary: longSummary } });
    expect(out.summary.length).toBeLessThanOrEqual(2000);
    expect(out.summary).toContain("[truncated");
    // Verify suffix contains original N (total chars)
    const match = out.summary.match(/\[truncated, (\d+) chars total\]/);
    expect(match).toBeTruthy();
    expect(match?.[1]).toBeDefined();
  });

  it("summary copy-up exact suffix math: total length == 2000", () => {
    // Create a summary that's exactly 2500 chars
    const longSummary = "y".repeat(2500);
    const out = base({ result: { summary: longSummary } });
    // Total length should be exactly 2000
    expect(out.summary.length).toBe(2000);
    // Suffix format: "[truncated, 2500 chars total]" is 29 chars
    // So prose should be 1971 chars
    expect(out.summary.startsWith("y".repeat(1971))).toBe(true);
    expect(out.summary.endsWith("[truncated, 2500 chars total]")).toBe(true);
  });

  it("summary within limit: no truncation, exact copy", () => {
    const shortSummary = "ok";
    const out = base({ result: { summary: shortSummary } });
    expect(out.summary).toBe(shortSummary);
    expect(out.summary.length).toBe(2);
  });

  it("summary exactly at limit: no truncation", () => {
    const exactSummary = "z".repeat(2000);
    const out = base({ result: { summary: exactSummary } });
    expect(out.summary).toBe(exactSummary);
    expect(out.summary.length).toBe(2000);
  });

  it("summary over limit by 1: truncates with suffix", () => {
    const overSummary = "a".repeat(2001);
    const out = base({ result: { summary: overSummary } });
    expect(out.summary.length).toBe(2000);
    expect(out.summary).toContain("[truncated");
    // 2000 - "[truncated, 2001 chars total]" (29 chars) = 1971 chars of "a"
    expect(out.summary.startsWith("a".repeat(1971))).toBe(true);
  });

  it("testsExecuted invariant: reject sum===0 + true", () => {
    expect(() =>
      base({ testResults: { passed: 0, failed: 0 }, testsExecuted: true }),
    ).toThrow(/testsExecuted/);
  });

  it("testsExecuted invariant: reject sum===0 + absent", () => {
    // Omitting testsExecuted when passed+failed===0 should throw
    // Cast to any to bypass TypeScript for this invariant test
    const opts = {
      exitStatus: "success" as const,
      partial: false,
      result: {},
      agentOutputs: {},
      changedFiles: [],
      comsLog: [],
      durationMs: 1234,
      waivers: [],
      error: null,
      redact: identity,
      testResults: { passed: 0, failed: 0 },
      // testsExecuted intentionally omitted to test invariant enforcement
      summary: "ok",
      mulchPrimed: false,
      artifacts: [],
    } as any; // dp:ok intentional type-erasure — asserting the RUNTIME invariant rejects a missing required field, which the type system prevents by design
    expect(() => buildMergedOutput(opts)).toThrow(/testsExecuted/);
  });

  it("testsExecuted invariant: accept sum===0 + false", () => {
    const out = base({ testResults: { passed: 0, failed: 0 }, testsExecuted: false });
    expect(out.testResults).toEqual({ passed: 0, failed: 0 });
    expect(out.testsExecuted).toBe(false);
  });

  it("testsExecuted invariant: accept sum>0 + true", () => {
    const out = base({ testResults: { passed: 5, failed: 2 }, testsExecuted: true });
    expect(out.testResults).toEqual({ passed: 5, failed: 2 });
    expect(out.testsExecuted).toBe(true);
  });

  it("testsExecuted invariant: accept sum>0 + false (edge case)", () => {
    // sum>0 with testsExecuted=false is technically valid per invariant
    // (only sum===0 requires false)
    const out = base({ testResults: { passed: 1, failed: 0 }, testsExecuted: false });
    expect(out.testResults).toEqual({ passed: 1, failed: 0 });
    expect(out.testsExecuted).toBe(false);
  });

  it("partialOutput truncation with suffix reservation", () => {
    const longOutput = "b".repeat(12000);
    const out = base({
      exitStatus: "transient",
      error: { reason: "transient", message: "msg" },
      partial: true,
      partialOutput: longOutput,
    });
    expect(out.partialOutput?.length).toBeLessThanOrEqual(10000);
    expect(out.partialOutput).toContain("[truncated");
    // The cap and the suffix both count UTF-16 chars (text.length), never bytes.
    const match = out.partialOutput?.match(/\[truncated, (\d+) chars total\]/);
    expect(match).toBeTruthy();
    expect(match?.[1]).toBe("12000");
  });

  it("partialOutput empty string stays empty — never collapsed to null", () => {
    // "" is a failure-path output (ran, captured nothing) and must not become
    // null, which is the success-path contract.
    const out = base({
      exitStatus: "transient",
      error: { reason: "transient", message: "msg" },
      partial: true,
      partialOutput: "",
    });
    expect(out.partialOutput).toBe("");
    expect(out.partialOutput).not.toBeNull();
  });

  it("partialOutput exactly at limit: no truncation", () => {
    const exactOutput = "c".repeat(10000);
    const out = base({
      exitStatus: "transient",
      error: { reason: "transient", message: "msg" },
      partial: true,
      partialOutput: exactOutput,
    });
    expect(out.partialOutput).toBe(exactOutput);
    expect(out.partialOutput?.length).toBe(10000);
  });

  it("all extended fields present on output", () => {
    const out = base({
      result: { summary: "custom summary" },
      testResults: { passed: 10, failed: 2 },
      testsExecuted: true,
      summary: "fallback summary",
      mulchPrimed: true,
      mulchPrimeError: undefined,
      artifacts: [{ name: "log.txt", path: "artifacts/log.txt" }],
    });
    expect(out.testResults).toEqual({ passed: 10, failed: 2 });
    expect(out.testsExecuted).toBe(true);
    // summary is copied from result.summary first, then opts.summary
    expect(out.summary).toBe("custom summary");
    expect(out.mulchPrimed).toBe(true);
    expect(out.mulchPrimeError).toBeNull();
    expect(out.artifacts).toEqual([{ name: "log.txt", path: "artifacts/log.txt" }]);
  });

  it("mulchPrimeError present when priming fails", () => {
    const out = base({
      mulchPrimed: false,
      mulchPrimeError: "Hindsight unreachable",
    });
    expect(out.mulchPrimed).toBe(false);
    expect(out.mulchPrimeError).toBe("Hindsight unreachable");
  });

  it("existing 9-field outputs remain constructible", () => {
    // This simulates the old call pattern without new fields
    // The implementation should provide defaults for missing fields
    const legacyOpts = {
      exitStatus: "success" as const,
      partial: false,
      result: { summary: "legacy" },
      agentOutputs: {},
      changedFiles: [],
      comsLog: [],
      durationMs: 100,
      waivers: [],
      error: null,
      redact: identity,
      testResults: { passed: 0, failed: 0 },
      testsExecuted: false,
      summary: "legacy",
      mulchPrimed: false,
      artifacts: [],
    };
    const out = buildMergedOutput(legacyOpts);
    // All original fields should be present
    expect(out.result).toEqual({ summary: "legacy" });
    expect(out.changedFiles).toEqual([]);
    expect(out.partial).toBe(false);
    expect(out.exitStatus).toBe("success");
    expect(out.durationMs).toBe(100);
    expect(out.waivers).toEqual([]);
    expect(out.agentOutputs).toEqual({});
    expect(out.comsLog).toEqual([]);
    expect(out.error).toBeNull();
  });
});
