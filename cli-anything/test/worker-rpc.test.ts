/**
 * runRpcWorker lifecycle tests (#280 direction 4).
 *
 * The fake child is listener-registry based (no real pipes): tests drive the
 * event stream line-by-line the way pi would, with settle grace and linger
 * shrunk to milliseconds. The drain policy under test is the whole point of
 * the rpc transport: a worker that exits at the FIRST agent_settled is the
 * `-p` bug that abandons self-compact's compaction in flight (SC.2 rounds,
 * issue #280).
 */
import { describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runRpcWorker, type RpcChild, type RpcSpawnFn } from "../scripts/worker-rpc.ts";

class FakeChild {
  stdinWrites: string[] = [];
  stdinEnded = false;
  killed: (number | string)[] = [];
  private listeners = new Map<string, Array<(...args: unknown[]) => void>>();

  private addListener(event: string, cb: (...args: never[]) => void) {
    const list = this.listeners.get(event) ?? [];
    list.push(cb as (...args: unknown[]) => void);
    this.listeners.set(event, list);
  }

  stdin = {
    write: (chunk: string) => {
      this.stdinWrites.push(chunk);
      return true;
    },
    end: () => {
      this.stdinEnded = true;
      return true;
    },
  };
  stdout = {
    on: (event: string, cb: (d: Buffer) => void) => this.addListener(event, cb),
  };
  stderr = {
    on: (event: string, cb: (d: Buffer) => void) => this.addListener(event, cb),
  };
  on(event: string, cb: (...args: unknown[]) => void) {
    this.addListener(event, cb);
    return this;
  }
  kill(signal?: number | string) {
    this.killed.push(signal ?? "SIGTERM");
    return true;
  }

  emitEvent(event: string, ...args: unknown[]) {
    for (const cb of this.listeners.get(event) ?? []) cb(...args);
  }
  /** Emit one NDJSON event exactly as pi would: JSON + LF in one chunk. */
  emitLine(obj: Record<string, unknown>) {
    this.emitEvent("data", Buffer.from(`${JSON.stringify(obj)}\n`, "utf8"));
  }
  emitClose(code: number | null) {
    this.emitEvent("close", code);
  }
  responses(): Record<string, unknown>[] {
    return this.stdinWrites
      .map((w) => JSON.parse(w) as Record<string, unknown>)
      .filter((o) => typeof o.type === "string");
  }
}

/** The fake satisfies RpcChild structurally at the spawn seam. */
const fakeSpawn =
  (child: FakeChild): RpcSpawnFn =>
  () =>
    child as unknown as RpcChild;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const IDLE_STATE = {
  type: "response",
  data: { isStreaming: false, isCompacting: false, pendingMessageCount: 0 },
};

describe("runRpcWorker — prompt submission", () => {
  it("writes the prompt command once, then waits for events", async () => {
    const child = new FakeChild();
    const spawn = fakeSpawn(child);
    const done = runRpcWorker({
      argv: ["--mode", "rpc"],
      prompt: "do the thing\n\nREPLY IN JSON",
      agentId: "w1",
      timeoutMs: 5_000,
      settleGraceMs: 10,
      lingerMs: 10,
      spawn,
    });
    await sleep(5);
    const sent = child.responses();
    expect(sent).toHaveLength(1);
    expect(sent[0]?.type).toBe("prompt");
    expect(sent[0]?.message).toContain("do the thing");
    expect(sent[0]?.message).toContain("REPLY IN JSON");
    child.emitClose(0);
    await done;
  });
});

describe("runRpcWorker — drain policy", () => {
  it("does NOT drain at the first agent_settled until get_state confirms idle", async () => {
    const child = new FakeChild();
    const spawn = fakeSpawn(child);
    const done = runRpcWorker({
      argv: [], prompt: "p", agentId: "w1", timeoutMs: 5_000,
      settleGraceMs: 10, lingerMs: 10, spawn,
    });
    await sleep(5);
    child.emitLine({ type: "agent_start" });
    child.emitLine({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "{}" }], usage: { input: 1, output: 1, cost: { total: 0 } } } });
    child.emitLine({ type: "agent_end" });
    child.emitLine({ type: "agent_settled" });
    // Grace expires → exactly one get_state, stdin still open.
    await sleep(30);
    const states = child.responses().filter((o) => o.type === "get_state");
    expect(states).toHaveLength(1);
    expect(child.stdinEnded).toBe(false);
    // Idle confirmation → shutdown via stdin end.
    child.emitLine({ ...IDLE_STATE, id: states[0]?.id });
    expect(child.stdinEnded).toBe(true);
    child.emitClose(0);
    const result = await done;
    expect(result.exitCode).toBe(0);
    expect(result.spawnError).toBeNull();
  });

  it("keeps the worker alive through compaction + handoff continuation (#280)", async () => {
    const child = new FakeChild();
    const spawn = fakeSpawn(child);
    const done = runRpcWorker({
      argv: [], prompt: "p", agentId: "handoff", timeoutMs: 5_000,
      settleGraceMs: 10, lingerMs: 10, spawn,
    });
    await sleep(5);
    child.emitLine({ type: "agent_start" });
    child.emitLine({ type: "agent_end" });
    child.emitLine({ type: "agent_settled" });          // self-compact's trigger point
    await sleep(25);                                     // grace window elapses…
    child.emitLine({ type: "compaction_start", reason: "manual" }); // …then work appears
    expect(child.stdinEnded).toBe(false);                // NOT abandoned mid-compaction
    child.emitLine({
      type: "compaction_end",
      reason: "manual",
      result: { summary: "s", tokensBefore: 10, estimatedTokensAfter: 2 },
    });
    child.emitLine({ type: "agent_start" });             // triggerTurn re-enters the agent
    child.emitLine({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: '{"ok":true}' }] } });
    child.emitLine({ type: "agent_end" });
    child.emitLine({ type: "agent_settled" });           // second settle: nothing pending
    await sleep(30);
    const states = child.responses().filter((o) => o.type === "get_state");
    expect(states.length).toBeGreaterThanOrEqual(1);
    child.emitLine({ ...IDLE_STATE, id: states[states.length - 1]?.id });
    expect(child.stdinEnded).toBe(true);
    child.emitClose(0);
    await done;
  });

  it("re-arms the drain when get_state reports work still active", async () => {
    const child = new FakeChild();
    const spawn = fakeSpawn(child);
    const done = runRpcWorker({
      argv: [], prompt: "p", agentId: "busy", timeoutMs: 5_000,
      settleGraceMs: 10, lingerMs: 10, spawn,
    });
    await sleep(5);
    child.emitLine({ type: "agent_settled" });
    await sleep(30);
    const states = () => child.responses().filter((o) => o.type === "get_state");
    expect(states()).toHaveLength(1);
    child.emitLine({
      ...IDLE_STATE,
      id: states()[0]?.id,
      data: { isStreaming: false, isCompacting: true, pendingMessageCount: 0 },
    });
    expect(child.stdinEnded).toBe(false); // compaction in flight → keep waiting
    await sleep(30);
    expect(states().length).toBe(2);      // re-armed after the busy answer
    child.emitLine({ ...IDLE_STATE, id: states()[1]?.id });
    expect(child.stdinEnded).toBe(true);
    child.emitClose(0);
    await done;
  });

  it("cancels a pending drain when auto-retry starts", async () => {
    const child = new FakeChild();
    const spawn = fakeSpawn(child);
    const done = runRpcWorker({
      argv: [], prompt: "p", agentId: "retry", timeoutMs: 5_000,
      settleGraceMs: 500, lingerMs: 10, spawn, // grace longer than the test
    });
    await sleep(5);
    child.emitLine({ type: "agent_settled" });
    child.emitLine({ type: "auto_retry_start", attempt: 1, maxAttempts: 3, delayMs: 1 });
    await sleep(30);
    expect(child.responses().filter((o) => o.type === "get_state")).toHaveLength(0);
    expect(child.stdinEnded).toBe(false);
    child.emitClose(0);
    await done;
  });
});

describe("runRpcWorker — write-through capture", () => {
  it("flushes complete lines to captureFile as they arrive, env-secret-redacted", async () => {
    const child = new FakeChild();
    const spawn = fakeSpawn(child);
    const dir = mkdtempSync(join(tmpdir(), "rpc-capture-"));
    const captureFile = join(dir, "worker-a.ndjson");
    const done = runRpcWorker({
      argv: [], prompt: "p", agentId: "cap", timeoutMs: 5_000,
      settleGraceMs: 10, lingerMs: 10, spawn,
      captureFile,
      captureEnv: { OPENROUTER_API_KEY: "sk-or-secret-value-1234567890" },
    });
    await sleep(5);
    child.emitLine({ type: "agent_settled" });
    child.emitLine({ note: "key is sk-or-secret-value-1234567890 here" });
    // Written THROUGH before close — mid-flight forensics is the point.
    const midFlight = readFileSync(captureFile, "utf8");
    expect(midFlight).toContain("agent_settled");
    expect(midFlight).not.toContain("sk-or-secret-value-1234567890");
    child.emitClose(0);
    await done;
    const final = readFileSync(captureFile, "utf8");
    expect(final).toContain("agent_settled");
    expect(final).not.toContain("sk-or-secret-value-1234567890");
    rmSync(dir, { recursive: true, force: true });
  });

  it("flushes a trailing partial line on close (SIGKILL mid-line)", async () => {
    const child = new FakeChild();
    const spawn = fakeSpawn(child);
    const dir = mkdtempSync(join(tmpdir(), "rpc-capture-partial-"));
    const captureFile = join(dir, "worker-b.ndjson");
    const done = runRpcWorker({
      argv: [], prompt: "p", agentId: "cap2", timeoutMs: 5_000,
      settleGraceMs: 10, lingerMs: 10, spawn,
      captureFile,
    });
    await sleep(5);
    // A chunk ending WITHOUT a newline: no complete line yet, nothing flushed.
    child.emitEvent("data", Buffer.from('{"type":"message_end","mess', "utf8"));
    expect(existsSync(captureFile)).toBe(true);
    expect(readFileSync(captureFile, "utf8")).toBe("");
    child.emitClose(null); // hard death — finish() flushes the partial line
    await done;
    expect(readFileSync(captureFile, "utf8")).toContain("message_end");
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("runRpcWorker — headless safety", () => {
  it("auto-cancels blocking extension UI dialogs, ignores fire-and-forget", async () => {
    const child = new FakeChild();
    const spawn = fakeSpawn(child);
    const done = runRpcWorker({
      argv: [], prompt: "p", agentId: "ui", timeoutMs: 5_000,
      settleGraceMs: 10, lingerMs: 10, spawn,
    });
    await sleep(5);
    child.emitLine({ type: "extension_ui_request", id: "u1", method: "confirm", title: "Allow?" });
    child.emitLine({ type: "extension_ui_request", id: "u2", method: "notify", message: "hi" });
    const replies = child.responses().filter((o) => o.type === "extension_ui_response");
    expect(replies).toHaveLength(1);
    expect(replies[0]?.id).toBe("u1");
    expect(replies[0]?.cancelled).toBe(true);
    child.emitClose(0);
    await done;
  });

  it("SIGKILLs at timeoutMs and reports the outcome (never hangs)", async () => {
    const child = new FakeChild();
    const spawn = fakeSpawn(child);
    const done = runRpcWorker({
      argv: [], prompt: "p", agentId: "slow", timeoutMs: 20,
      settleGraceMs: 5_000, lingerMs: 5_000, spawn,
    });
    await sleep(60);
    expect(child.killed).toContain("SIGKILL");
    child.emitClose(null); // SIGKILL death surfaces as close(null)
    const result = await done;
    expect(result.exitCode).toBeNull();
  });

  it("resolves with spawnError when the binary cannot spawn", async () => {
    const spawn: RpcSpawnFn = () => {
      throw new Error("spawn pi ENOENT");
    };
    const result = await runRpcWorker({
      argv: [], prompt: "p", agentId: "missing", timeoutMs: 5_000,
      settleGraceMs: 10, lingerMs: 10, spawn,
    });
    expect(result.spawnError).toBe("spawn pi ENOENT");
    expect(result.exitCode).toBeNull();
  });

  it("SIGKILLs a wedged shutdown after the linger window", async () => {
    const child = new FakeChild();
    const spawn = fakeSpawn(child);
    const done = runRpcWorker({
      argv: [], prompt: "p", agentId: "wedged", timeoutMs: 5_000,
      settleGraceMs: 10, lingerMs: 20, spawn,
    });
    await sleep(5);
    child.emitLine({ type: "agent_settled" });
    await sleep(30);
    child.emitLine({
      id: "qds-drain:wedged",
      type: "response",
      data: { isStreaming: false, isCompacting: false, pendingMessageCount: 0 },
    });
    expect(child.stdinEnded).toBe(true);   // shutdown requested…
    await sleep(50);
    expect(child.killed).toContain("SIGKILL"); // …but pi never exited
    child.emitClose(0);
    await done;
  });
});
