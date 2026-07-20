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
  const KEYS = [
    "result",
    "changedFiles",
    "partial",
    "exitStatus",
    "durationMs",
    "waivers",
    "agentOutputs",
    "comsLog",
    "error",
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
      ...over,
    });
  }

  it("success path: error is explicit null, partial false, agentOutputs populated", () => {
    const out = base({});
    expect(Object.keys(out).sort()).toEqual(KEYS);
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
      expect(Object.keys(out).sort()).toEqual(KEYS);
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
    expect(Object.keys(round).sort()).toEqual(KEYS);
    // error:null must survive stringify (not be dropped as undefined).
    expect("error" in round).toBe(true);
    expect(round.error).toBeNull();
  });
});
