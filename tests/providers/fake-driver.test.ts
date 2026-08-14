/**
 * DF2.1 — the `fake` driver's run of the shared contract suite, plus the registry.
 *
 * The suite itself lives in driver-contract.test.ts and is imported unmodified,
 * exactly as DF2.2 and the later OCI driver story will import it.
 */

import { afterAll, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fillRun, reapRuns } from "../../src/providers/driver.ts";
import { FakeDriver } from "../../src/providers/fake-driver.ts";
import { RunRecordStore } from "../../src/providers/run-record.ts";
import { resolveDriver } from "../../src/providers/index.ts";
import { setLogSink } from "../../src/swarmclaw/mcp/stdio-transport.ts";
import { runDriverContract } from "./driver-contract.test.ts";

const boxesDir = mkdtempSync(join(tmpdir(), "qds-fake-boxes-"));
process.env.QDS_FAKE_BOXES_DIR = boxesDir;

afterAll(() => {
  rmSync(boxesDir, { recursive: true, force: true });
});

describe("registry", () => {
  test("resolveDriver('fake') resolves in-process, without a socket or an env secret", () => {
    expect(resolveDriver("fake").name).toBe("fake");
  });

  test("an unknown driver name is refused, naming what is registered", () => {
    expect(() => resolveDriver("nope")).toThrow(/unknown provider driver: nope.*fake/s);
  });
});

describe("observability contract (driver side)", () => {
  test("every primitive call logs once, ok and error alike, with the caller's requestId", async () => {
    const entries: Record<string, unknown>[] = [];
    const restore = setLogSink((e) => {
      entries.push(e as unknown as Record<string, unknown>);
    });
    try {
      const d = resolveDriver("fake", { requestId: "req-42", runId: "run-42" });
      await d.whoami();
      await expect(d.exec("no-such-box", ["true"])).rejects.toThrow();
      // Not a driver call: wrapping every callable used to emit fake lines.
      String(d);
    } finally {
      restore();
    }

    expect(entries.map((e) => e.verb)).toEqual(["whoami", "exec"]);
    expect(entries[0]).toMatchObject({
      requestId: "req-42",
      runId: "run-42",
      driver: "fake",
      verb: "whoami",
      outcome: "ok",
    });
    expect(typeof entries[0]?.timestamp).toBe("string");
    expect(typeof entries[0]?.durationMs).toBe("number");
    expect(typeof entries[0]?.driver_call_ms).toBe("number");
    expect(entries[1]).toMatchObject({ verb: "exec", outcome: "error" });
    expect((entries[1] as { error: { message: string } }).error.message).toContain("no such box");
  });

  test("exec stdin never reaches the log stream — it is DF2.3's key channel", async () => {
    const entries: unknown[] = [];
    const restore = setLogSink((e) => {
      entries.push(e);
    });
    const d = resolveDriver("fake");
    try {
      await d.create("stdin-box");
      await d.exec("stdin-box", ["sh", "-c", "cat"], "sk-super-secret-key-material");
    } finally {
      // Restore the sink first: if create/exec threw (the driver regression this
      // test exists to catch) and destroy also throws, destroy's rejection must
      // not replace the original error, and the sink must not stay installed for
      // every later test in this file.
      restore();
      try {
        await d.destroy("stdin-box");
      } catch {
        // box may not exist if create failed; original error takes precedence
      }
    }
    expect(JSON.stringify(entries)).not.toContain("super-secret");
  });
});

describe("FakeDriver accountability and boundaries", () => {
  test("a box with no metadata is still listed, and reap can destroy it", async () => {
    const boxes = mkdtempSync(join(tmpdir(), "qds-fake-orphan-"));
    const runs = mkdtempSync(join(tmpdir(), "qds-fake-orphan-runs-"));
    try {
      const d = new FakeDriver(boxes);
      mkdirSync(join(boxes, "half-built-box")); // crash between mkdir and writeMeta
      expect((await d.list()).map((v) => v.name)).toEqual(["half-built-box"]);
      expect(await reapRuns(d, new RunRecordStore({ dir: runs }))).toEqual(["half-built-box"]);
      expect(await d.list()).toEqual([]);
    } finally {
      rmSync(boxes, { recursive: true, force: true });
      rmSync(runs, { recursive: true, force: true });
    }
  });

  test("a directory that cannot be a box is skipped, so one stray dir cannot stop reap", async () => {
    const boxes = mkdtempSync(join(tmpdir(), "qds-fake-junk-"));
    const runs = mkdtempSync(join(tmpdir(), "qds-fake-junk-runs-"));
    try {
      const d = new FakeDriver(boxes);
      mkdirSync(join(boxes, "Junk_Dir")); // fails the hostname grammar
      await d.create("good-box");
      expect((await d.list()).map((v) => v.name)).toEqual(["good-box"]);
      // destroy() re-validates the name, so reporting the junk dir would throw
      // here and the reaper would reap nothing at all.
      expect(await reapRuns(d, new RunRecordStore({ dir: runs }))).toEqual(["good-box"]);
    } finally {
      rmSync(boxes, { recursive: true, force: true });
      rmSync(runs, { recursive: true, force: true });
    }
  });

  test("copyFile refuses a symlink pointing out of the box", async () => {
    const boxes = mkdtempSync(join(tmpdir(), "qds-fake-symlink-"));
    const host = mkdtempSync(join(tmpdir(), "qds-fake-symlink-host-"));
    try {
      const d = new FakeDriver(boxes);
      await d.create("escape-box");
      writeFileSync(join(host, "secret.txt"), "host secret\n");
      // The workload runs inside the box and can plant this itself.
      symlinkSync(join(host, "secret.txt"), join(boxes, "escape-box", "link.txt"));
      await expect(d.copyFile("escape-box", "link.txt", join(host, "stolen.txt"))).rejects.toThrow(
        /escapes the box/,
      );
    } finally {
      rmSync(boxes, { recursive: true, force: true });
      rmSync(host, { recursive: true, force: true });
    }
  });
  test("fillRun refuses to write through a symlinked directory component", async () => {
    const boxes = mkdtempSync(join(tmpdir(), "qds-fake-fill-symlink-"));
    const host = mkdtempSync(join(tmpdir(), "qds-fake-fill-symlink-host-"));
    try {
      const d = new FakeDriver(boxes);
      await d.create("fill-escape-box");
      // The workload can plant this itself before a later fillRun call runs.
      symlinkSync(host, join(boxes, "fill-escape-box", "out"));
      await expect(fillRun(d, "fill-escape-box", [{ path: "out/pwned.txt", content: "escaped\n" }])).rejects.toThrow(
        /fill failed|symlink/,
      );
      expect(existsSync(join(host, "pwned.txt"))).toBe(false);
    } finally {
      rmSync(boxes, { recursive: true, force: true });
      rmSync(host, { recursive: true, force: true });
    }
  });

  test("fillRun refuses to write through a symlinked final target, including a dangling one", async () => {
    const boxes = mkdtempSync(join(tmpdir(), "qds-fake-fill-target-symlink-"));
    const host = mkdtempSync(join(tmpdir(), "qds-fake-fill-target-symlink-host-"));
    try {
      const d = new FakeDriver(boxes);
      await d.create("fill-target-box");
      // Dangling symlink: the target does not exist yet, which is exactly the
      // case a textual/existence-based check would miss.
      symlinkSync(join(host, "pwned.txt"), join(boxes, "fill-target-box", "link.txt"));
      await expect(fillRun(d, "fill-target-box", [{ path: "link.txt", content: "escaped\n" }])).rejects.toThrow(
        /fill failed|symlink/,
      );
      expect(existsSync(join(host, "pwned.txt"))).toBe(false);
    } finally {
      rmSync(boxes, { recursive: true, force: true });
      rmSync(host, { recursive: true, force: true });
    }
  });

  // Round 3's check-then-open shell script verified every directory component,
  // then separately re-walked the whole path text to open the final target — a
  // gap a concurrent workload process can win by swapping an *already-checked*
  // component for a symlink in between. `set -C` only makes the last path
  // component's open atomic; it does nothing for the parent components the
  // kernel re-resolves to get there. This test forces that exact interleaving
  // deterministically (no timing luck) using FILL_PY's `QDS_FILL_TEST_SYNC`
  // rendezvous: it pauses the traversal immediately after it has opened and is
  // holding the fd for directory component "a", swaps what the box root's "a"
  // entry points to (renamed to "a-real", "a" now a symlink to a directory
  // outside the box), then releases the traversal to finish creating "b/c.txt".
  //
  // A vulnerable implementation resolves "a/b/c.txt" fresh at the final write
  // and follows the swapped symlink, landing the file in the outside
  // directory. The fix holds a directory fd across the swap — fds reference
  // an inode, not the parent's name for it — so the write must land under
  // "a-real" and must never appear in the swap target.
  test("fillRun resists a check-then-replace race on an already-traversed directory component", async () => {
    // The default 5s bun:test timeout is too tight for the sync-point poll below.
    const boxes = mkdtempSync(join(tmpdir(), "qds-fake-fill-race-"));
    const outside = mkdtempSync(join(tmpdir(), "qds-fake-fill-race-outside-"));
    const sync = mkdtempSync(join(tmpdir(), "qds-fake-fill-race-sync-"));
    const prevSync = process.env.QDS_FILL_TEST_SYNC;
    try {
      const d = new FakeDriver(boxes);
      await d.create("race-box");
      const boxRoot = join(boxes, "race-box");

      process.env.QDS_FILL_TEST_SYNC = sync;
      // Single directory level: the sync hook fires once, right after the
      // traversal opens and holds the fd for "a" and before it opens the
      // final target "c.txt" relative to that fd — exactly the window
      // CodeRabbit named ("between the component check and `cat > "$p"`").
      const fillPromise = fillRun(d, "race-box", [{ path: "a/c.txt", content: "payload\n" }]);

      const readyMarker = join(sync, "ready.a");
      const deadline = Date.now() + 10_000;
      while (!existsSync(readyMarker)) {
        if (Date.now() > deadline) throw new Error("timed out waiting for fill to hold directory 'a'");
        await Bun.sleep(5);
      }

      // The traversal now holds an open fd for the real "a". Swap what the
      // name "a" resolves to without touching that fd's target.
      renameSync(join(boxRoot, "a"), join(boxRoot, "a-real"));
      symlinkSync(outside, join(boxRoot, "a"));
      writeFileSync(join(sync, "go.a"), "1");

      await fillPromise;

      expect(existsSync(join(outside, "c.txt"))).toBe(false);
      expect(readFileSync(join(boxRoot, "a-real", "c.txt"), "utf8")).toBe("payload\n");
    } finally {
      if (prevSync === undefined) {
        // An env-var assignment of `undefined` stringifies to "undefined"
        // rather than unsetting it — delete is the only correct way to
        // restore "not set" here.
        // biome-ignore lint/performance/noDelete: see above
        delete process.env.QDS_FILL_TEST_SYNC;
      } else {
        process.env.QDS_FILL_TEST_SYNC = prevSync;
      }
      rmSync(boxes, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
      rmSync(sync, { recursive: true, force: true });
    }
  }, 15_000);
});

runDriverContract({ driverName: "fake", makeDriver: () => resolveDriver("fake") });
