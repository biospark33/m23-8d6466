/**
 * P0 hardening tests for runRpcWorker (prompt-error settle, fail-closed
 * drain with bounded retries, compaction_end re-arm, env allowlist,
 * drainReason, extraArgv, U+2028 framing). Split from worker-rpc.test.ts
 * to keep both files under the repo's 500-line rule.
 */
import { describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runRpcWorker, rpcWorkerEnv, type RpcChild, type RpcSpawnFn } from "../scripts/worker-rpc.ts";

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

const fakeSpawn =
  (child: FakeChild): RpcSpawnFn =>
  () =>
    child as unknown as RpcChild;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const IDLE_STATE = {
  type: "response",
  data: { isStreaming: false, isCompacting: false, pendingMessageCount: 0 },
};

describe("runRpcWorker — P0 hardening", () => {
  it("P0.1: a prompt ERROR settles the worker now, not at the ceiling", async () => {
    const child = new FakeChild();
    const spawn = fakeSpawn(child);
    const done = runRpcWorker({
      argv: [], prompt: "p", agentId: "perr", timeoutMs: 5_000,
      settleGraceMs: 5_000, lingerMs: 500, spawn, // grace AND linger > test: only the error path can end this
    });
    await sleep(5);
    child.emitLine({ id: "qds-prompt:perr", type: "error", error: "model overloaded" });
    await sleep(40);
    expect(child.stdinEnded).toBe(true);            // settled NOW…
    expect(child.killed).not.toContain("SIGKILL");  // …not via ceiling or linger
    child.emitClose(0);
    const r = await done;
    expect(r.drainReason).toBe("prompt-error");
  });

  it("P0.2: a failed get_state REFUSES shutdown and retries — fail closed", async () => {
    const child = new FakeChild();
    const spawn = fakeSpawn(child);
    const done = runRpcWorker({
      argv: [], prompt: "p", agentId: "gserr", timeoutMs: 5_000,
      settleGraceMs: 10, lingerMs: 10, spawn,
    });
    await sleep(5);
    child.emitLine({ type: "agent_settled" });
    await sleep(30);
    const states = () => child.responses().filter((o) => o.type === "get_state");
    expect(states()).toHaveLength(1);
    child.emitLine({ id: "qds-drain:gserr", type: "error", error: "state unavailable" });
    expect(child.stdinEnded).toBe(false);  // NOT treated as idle (fail closed)
    await sleep(30);
    expect(states().length).toBe(2);       // …and the drain re-armed for a retry
    child.emitLine({ ...IDLE_STATE, id: states()[1]?.id });
    expect(child.stdinEnded).toBe(true);
    child.emitClose(0);
    await done;
  });

  it("P0.2: three consecutive get_state failures stop retrying; the ceiling is the backstop", async () => {
    const child = new FakeChild();
    const spawn = fakeSpawn(child);
    const done = runRpcWorker({
      argv: [], prompt: "p", agentId: "gsfail", timeoutMs: 5_000,
      settleGraceMs: 10, lingerMs: 10, spawn,
    });
    await sleep(5);
    child.emitLine({ type: "agent_settled" });
    // Deterministic: wait until the Nth get_state exists, then fail it.
    const ask = async (n: number): Promise<void> => {
      for (let i = 0; i < 100; i++) {
        const s = child.responses().filter((o) => o.type === "get_state");
        if (s.length >= n && s[n - 1] !== undefined) {
          child.emitLine({ id: (s[n - 1] as { id?: unknown }).id, type: "error", error: "down" });
          return;
        }
        await sleep(5);
      }
      throw new Error(`get_state #${n} never arrived`);
    };
    await ask(1);
    await ask(2);
    await ask(3);
    await sleep(60);                       // retries have STOPPED: no 4th ask
    const states = child.responses().filter((o) => o.type === "get_state");
    expect(states).toHaveLength(3);
    expect(child.stdinEnded).toBe(false);  // never drained fail-open
    child.emitClose(0);
    const r = await done;
    expect(r.drainReason).toBe("drain-unconfirmed");
  });

  it("P0.4: compaction_end after a FAILED compaction re-arms the drain", async () => {
    const child = new FakeChild();
    const spawn = fakeSpawn(child);
    const done = runRpcWorker({
      argv: [], prompt: "p", agentId: "cfail", timeoutMs: 5_000,
      settleGraceMs: 10, lingerMs: 10, spawn,
    });
    await sleep(5);
    child.emitLine({ type: "agent_settled" });
    // Cancel BEFORE the grace expires: compaction_start at ~5ms, grace 10ms.
    child.emitLine({ type: "compaction_start", reason: "manual" });
    await sleep(20);                       // grace would have fired here — it was canceled
    expect(child.responses().filter((o) => o.type === "get_state")).toHaveLength(0);
    child.emitLine({ type: "compaction_end", reason: "manual", error: "compaction failed" });
    await sleep(30);
    const states = child.responses().filter((o) => o.type === "get_state");
    expect(states).toHaveLength(1);        // re-armed WITHOUT a new settle/agent_start
    child.emitLine({ ...IDLE_STATE, id: states[0]?.id });
    child.emitClose(0);
    await done;
  });

  it("P0.5: the default environment is an allowlist, never process.env", () => {
    process.env.QDS_RPC_TEST_SECRET = "s3cr3t-value";
    try {
      const env = rpcWorkerEnv({ QDS_CAPTURE_EXTRA: "v1" });
      expect(env.PATH).toBeDefined();
      expect(env.HOME).toBeDefined();
      expect(env.QDS_RPC_TEST_SECRET).toBeUndefined();
      expect(env.QDS_CAPTURE_EXTRA).toBe("v1");
      const prevKey = process.env.OPENROUTER_API_KEY;
      process.env.OPENROUTER_API_KEY = "sk-or-test";
      const env2 = rpcWorkerEnv();
      expect(env2.OPENROUTER_API_KEY).toBe("sk-or-test");
      if (prevKey === undefined) {
        // biome-ignore lint/performance/noDelete: unsetting env vars requires delete
        delete process.env.OPENROUTER_API_KEY;
      } else {
        process.env.OPENROUTER_API_KEY = prevKey;
      }
    } finally {
      // biome-ignore lint/performance/noDelete: unsetting env vars requires delete
      delete process.env.QDS_RPC_TEST_SECRET;
    }
  });

  it("P0.6: extraArgv is appended to the spawn argv (opt-in session file)", () => {
    let seen: string[] | undefined;
    const child = new FakeChild();
    const spawn: RpcSpawnFn = (argv) => {
      seen = argv;
      return child as unknown as RpcChild;
    };
    const done = runRpcWorker({
      argv: ["--mode", "rpc"], prompt: "p", agentId: "argv", timeoutMs: 5_000,
      settleGraceMs: 10, lingerMs: 10, spawn,
      extraArgv: ["--session", "/tmp/resume.json"],
    });
    child.emitClose(0);
    return done.then((r) => {
      expect(r.exitCode).toBe(0);
      expect(seen).toEqual(["--mode", "rpc", "--session", "/tmp/resume.json"]);
    });
  });

  it("P0.6: the result carries a drainReason on every path", async () => {
    const child = new FakeChild();
    const spawn = fakeSpawn(child);
    const done = runRpcWorker({
      argv: [], prompt: "p", agentId: "reason", timeoutMs: 5_000,
      settleGraceMs: 10, lingerMs: 10, spawn,
    });
    await sleep(5);
    child.emitLine({ type: "agent_settled" });
    await sleep(30);
    const states = child.responses().filter((o) => o.type === "get_state");
    child.emitLine({ ...IDLE_STATE, id: states[0]?.id });
    child.emitClose(0);
    const r = await done;
    expect(r.drainReason).toBe("get-state-idle");
  });

  it("P0.7: U+2028/U+2029 inside a JSON string never split the frame", async () => {
    const child = new FakeChild();
    const spawn = fakeSpawn(child);
    const dir = mkdtempSync(join(tmpdir(), "rpc-ls-frame-"));
    const captureFile = join(dir, "ls.ndjson");
    const done = runRpcWorker({
      argv: [], prompt: "p", agentId: "ls", timeoutMs: 5_000,
      settleGraceMs: 10, lingerMs: 10, spawn,
      captureFile,
    });
    await sleep(5);
    // One LINE (single LF) whose string payload contains raw U+2028 and
    // U+2029: Node's readline splits on both (they are legal inside JSON
    // strings), so adopting it would cut this event into three bogus frames.
    // Strict LF framing must deliver it as ONE intact captured line. The
    // separators are written as ESCAPES — raw ones can be lost in transit
    // and would silently vacate this test (they did once).
    const LS = "\u2028";
    const PS = "\u2029";
    const payload = `{"note":"a${LS}b${PS}c","n":1}`;
    expect(
      [...payload].some((ch) => ch.codePointAt(0) === 0x2028) &&
        [...payload].some((ch) => ch.codePointAt(0) === 0x2029),
    ).toBe(true);
    child.emitEvent("data", Buffer.from(`${payload}\n`, "utf8"));
    await sleep(20);
    const captured = readFileSync(captureFile, "utf8");
    expect(captured.trim()).toBe(payload);  // one intact line, separators intact
    child.emitClose(0);
    await done;
    rmSync(dir, { recursive: true, force: true });
  });
});

