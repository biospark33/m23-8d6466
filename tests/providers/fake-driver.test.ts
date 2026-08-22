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
import {
  createRun,
  fillRun,
  type ProviderVm,
  ProvisionRefusedError,
  provisionAdmittedRun,
  reapRuns,
} from "../../src/providers/driver.ts";
import { FakeDriver } from "../../src/providers/fake-driver.ts";
import { RunRecordStore } from "../../src/providers/run-record.ts";
import { resolveDriver } from "../../src/providers/index.ts";
import { setLogSink } from "../../src/swarmclaw/mcp/stdio-transport.ts";
import { runDriverContract } from "./driver-contract.test.ts";
// The block below drives FLEET-layer entry points (`provisionAdmittedRun`,
// `reapRuns`) against this driver, so it shares the fleet suite's fixtures.
import { rejection } from "../fleet/helpers.ts";

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

  test("listWithAnomalies is an observed primitive, not a pass-through", async () => {
    // It is what the reaper enumerates through — `list()` is only its wrapper —
    // so leaving it out of PRIMITIVES made the ONE listing that gates a
    // destructive fleet-wide sweep the only unobserved driver call. Functionally
    // it still worked (Reflect.get forwards it), which is exactly why nothing
    // would have noticed.
    const entries: Record<string, unknown>[] = [];
    const restore = setLogSink((e) => entries.push(e as unknown as Record<string, unknown>));
    try {
      const d = resolveDriver("fake", { requestId: "req-anom" });
      await d.listWithAnomalies?.();
    } finally {
      restore();
    }
    expect(entries.map((e) => e.verb)).toEqual(["listWithAnomalies"]);
    expect(entries[0]).toMatchObject({
      requestId: "req-anom",
      operation: "provider.listWithAnomalies",
      driver: "fake",
      outcome: "ok",
    });
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

  test("a directory that cannot be a box is skipped by list(), and reap REFUSES on it", async () => {
    const boxes = mkdtempSync(join(tmpdir(), "qds-fake-junk-"));
    const runs = mkdtempSync(join(tmpdir(), "qds-fake-junk-runs-"));
    try {
      const d = new FakeDriver(boxes);
      mkdirSync(join(boxes, "Junk_Dir")); // fails the hostname grammar
      await d.create("good-box");
      // `list()` still filters it: `destroy()` re-validates the name, so
      // REPORTING the junk dir as a box would throw mid-reap.
      expect((await d.list()).map((v) => v.name)).toEqual(["good-box"]);
      // But a directory this driver cannot name can still be a LIVE box, and
      // reap destroys every box it cannot match to an open record. A population
      // that cannot be proven complete is never reaped from — otherwise the
      // stray dir is a box no verb can reach, spending against nobody's cap,
      // and the operator is never told at the moment it matters.
      const err = await reapRuns(d, new RunRecordStore({ dir: runs })).then(
        (v) => new Error(`expected a refusal, got ${JSON.stringify(v)}`),
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(ProvisionRefusedError);
      expect((err as ProvisionRefusedError).code).toBe("reap-vms-unverified");
      expect((err as Error).message).toContain("Junk_Dir");
      // and it reaped nothing: the good box is untouched.
      expect((await d.list()).map((v) => v.name)).toEqual(["good-box"]);
    } finally {
      rmSync(boxes, { recursive: true, force: true });
      rmSync(runs, { recursive: true, force: true });
    }
  });

  test("an unstat-able entry does not take the whole listing down: ENOENT drops, other errno rides out as an anomaly", async () => {
    const boxes = mkdtempSync(join(tmpdir(), "qds-fake-stat-"));
    try {
      const d = new FakeDriver(boxes);
      await d.create("good-box");
      // A dangling symlink: `statSync` FOLLOWS links, so this is the ENOENT an
      // entry unlinked between `readdir` and `stat` produces. Nothing is there
      // to reach, so it is not a box and not an anomaly — but an unguarded
      // `statSync` threw it out of the whole call, and one stray link then hid
      // every box in the fleet from `status` and from `reapRuns` alike.
      symlinkSync(join(boxes, "nowhere"), join(boxes, "dangling"));
      // A self-referential symlink: ELOOP, not ENOENT. Nothing proves this is
      // NOT a live box, so it must ride out as an anomaly for `reapRuns` to
      // refuse on rather than being silently dropped.
      symlinkSync(join(boxes, "loop"), join(boxes, "loop"));

      const listing = await d.listWithAnomalies();
      expect(listing.vms.map((v) => v.name)).toEqual(["good-box"]);
      expect(listing.skipped).toEqual(["loop"]);
    } finally {
      rmSync(boxes, { recursive: true, force: true });
    }
  });

  test("destroy kills an exec's whole process tree and settles its pending exec", async () => {
    const boxes = mkdtempSync(join(tmpdir(), "qds-fake-tree-"));
    try {
      const d = new FakeDriver(boxes);
      await d.create("tree-box");
      // Two descendants: if destroy killed only the direct sh, they would be
      // reparented and keep running — and the one holding the stdout pipe
      // would keep the exec's Promise.all unsettled past the destroy.
      const pending = d.exec("tree-box", [
        "sh",
        "-c",
        'sleep 30 & p1=$!; sleep 30 & p2=$!; echo "$p1 $p2"; wait',
      ]);
      await new Promise((r) => setTimeout(r, 400)); // let the descendants spawn
      await d.destroy("tree-box");
      const res = await pending; // settles at the destroy, not 30s later
      expect(res.exitCode).toBe(137); // group SIGKILL — the demo's kill signature
      const [p1, p2] = res.stdout.trim().split(/\s+/).map(Number);
      // Signal 0 is a liveness probe only; a throw means no such process.
      expect(() => process.kill(p1!, 0)).toThrow();
      expect(() => process.kill(p2!, 0)).toThrow();
    } finally {
      rmSync(boxes, { recursive: true, force: true });
    }
  });

  test("destroy never signals a process group a completed exec no longer owns", async () => {
    const boxes = mkdtempSync(join(tmpdir(), "qds-fake-stale-"));
    // Record every negative-pid (whole-group) signal request the driver makes.
    const origKill = process.kill;
    const groupSignals: Array<{ pid: number; signal: string | number }> = [];
    (process as { kill: typeof process.kill }).kill = (pid, signal?) => {
      if (pid < 0) groupSignals.push({ pid, signal: signal ?? 0 });
      return origKill(pid, signal);
    };
    try {
      const d = new FakeDriver(boxes);
      // A completed exec's group is gone; after any pid rollover its old pgid
      // could name an unrelated process group — destroy must not signal it.
      await d.create("stale-box");
      await d.exec("stale-box", ["sh", "-c", "printf done"]);
      await d.destroy("stale-box");

      // The live-leader counterpart: a pending exec's destroy DOES signal its
      // group — the kernel guarantees the leader's pid is still this exec's
      // while the child is unreaped — and only that group.
      await d.create("live-box");
      const pending = d.exec("live-box", ["sh", "-c", "sleep 30 & sleep 30 & wait"]);
      await new Promise((r) => setTimeout(r, 400)); // let the descendants spawn
      await d.destroy("live-box");
      await pending;

      const groupKills = groupSignals.filter((s) => s.signal === "SIGKILL");
      expect(groupKills.length).toBe(1); // live-box's group; stale-box signaled nothing
    } finally {
      (process as { kill: typeof process.kill }).kill = origKill;
      rmSync(boxes, { recursive: true, force: true });
    }
  });

  test("destroy kills a surviving descendant after the leader exits and settles its pending exec", async () => {
    const boxes = mkdtempSync(join(tmpdir(), "qds-fake-orphan-"));
    try {
      const d = new FakeDriver(boxes);
      await d.create("orphan-box");
      // The direct sh exits on its own; the background sleep it spawned stays
      // in the detached process group holding the stdout pipe, so the exec is
      // pending over a leader that is already reaped. The identity gate must
      // not blind destroy() to the group: the descendant is still ours to kill
      // (the orphaned group keeps its pgid reserved), and killing it is what
      // settles the exec.
      const pending = d.exec("orphan-box", ["sh", "-c", "sleep 10 & echo $!"]);
      await new Promise((r) => setTimeout(r, 400)); // let sh exit, sleep spawn
      await d.destroy("orphan-box");
      // Bounded wait: a destroy that cannot reach the descendant leaves the
      // exec pending forever, and an unguarded await would hang the suite.
      const res = await Promise.race([
        pending,
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("exec still pending 2s after destroy")), 2000),
        ),
      ]);
      expect(res.exitCode).toBe(0); // the leader exited cleanly before the kill
      // The spawned descendant must be dead, not reparented and running.
      expect(() => process.kill(Number(res.stdout.trim()), 0)).toThrow();
    } finally {
      rmSync(boxes, { recursive: true, force: true });
    }
  });

  test("a positive-pid probe answering EPERM never authorizes a group signal", async () => {
    const boxes = mkdtempSync(join(tmpdir(), "qds-fake-eperm-"));
    const origKill = process.kill;
    const groupSignals: Array<{ pid: number; signal: string | number }> = [];
    (process as { kill: typeof process.kill }).kill = (pid, signal?) => {
      if (pid > 0 && signal === 0) {
        // The dead-leader identity probe: pretend the recycled pid belongs to
        // a process this caller may not signal. EPERM is "owned by someone
        // else", the same verdict as a successful probe — not ESRCH.
        throw Object.assign(new Error("kill() failed: EPERM: Operation not permitted"), { code: "EPERM" });
      }
      if (pid < 0) groupSignals.push({ pid, signal: signal ?? 0 });
      return origKill(pid, signal);
    };
    let sleeper: number | undefined;
    try {
      const d = new FakeDriver(boxes);
      await d.create("eperm-box");
      // Leader exits, descendant redirects its output: the exec settles on
      // its own, the eager prune keeps the entry (the group is still alive),
      // and destroy's closure reaches the dead-leader branch under the mock.
      // The echo hands back the descendant's pid — the redirected sleep holds
      // no pipe, so stdout settles with it — for the finally-block cleanup
      // this deliberately-blinded destroy cannot do itself.
      const res = await d.exec("eperm-box", ["sh", "-c", "sleep 30 >/dev/null 2>&1 & echo $!"]);
      sleeper = Number(res.stdout.trim());
      // The eager prune's own group probe (signal 0) is exec-settle logic
      // and expected here; snapshot so only destroy's calls are asserted.
      const before = groupSignals.length;
      await d.destroy("eperm-box");
      // EPERM must short-circuit the closure before ANY -pid call — not even
      // a probe — or a mixed-privilege recycled group could lose signalable
      // members to the SIGKILL that follows a successful group probe.
      expect(groupSignals.length).toBe(before);
      expect(groupSignals.every((s) => s.signal === 0)).toBe(true);
    } finally {
      (process as { kill: typeof process.kill }).kill = origKill;
      // destroy was a no-op for this entry on purpose; the real kill (never
      // the mock) terminates the survivor now rather than at sleep's expiry.
      // Reaping needs no help: sh is dead, so the sleeper is reparented to
      // init and reaped there once the SIGKILL lands.
      if (sleeper !== undefined) {
        try {
          process.kill(sleeper, "SIGKILL");
        } catch {
          // already gone
        }
      }
      rmSync(boxes, { recursive: true, force: true });
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

/**
 * DF3.1 review round 4 — the provisioning sequence's refusals and the reaper's
 * fail-safe. Driver-agnostic in intent, but they live here rather than in the
 * shared contract suite: each one drives a failure the seam cannot produce on a
 * real substrate on demand (a hung create, a store write that throws), so the
 * suite DF2.2 and the OCI story import stays substrate-honest.
 */
describe("provisioning refusals and fail-safe reap", () => {
  function tmp(): { boxes: string; runs: string; driver: FakeDriver; store: RunRecordStore } {
    const boxes = mkdtempSync(join(tmpdir(), "qds-df31-boxes-"));
    const runs = mkdtempSync(join(tmpdir(), "qds-df31-runs-"));
    return { boxes, runs, driver: new FakeDriver(boxes), store: new RunRecordStore({ dir: runs }) };
  }

  function clean(t: { boxes: string; runs: string }): void {
    rmSync(t.boxes, { recursive: true, force: true });
    rmSync(t.runs, { recursive: true, force: true });
  }

  test("createRun refuses opts.issue: admission has exactly one production caller (AC7)", async () => {
    const t = tmp();
    try {
      // Dormant double admission made loud. A caller that had already admitted
      // (as the dispatcher does) and then passed `issue` here would book the
      // same issue against the same cap twice, silently.
      const err = await rejection(
        createRun(t.driver, t.store, {
          runId: "admit-elsewhere-run",
          issue: { repoSlug: "qds/demo", issueId: "42" },
        }),
      );
      expect(err).toBeInstanceOf(ProvisionRefusedError);
      expect((err as ProvisionRefusedError).code).toBe("admission-not-here");
      expect((err as ProvisionRefusedError).remediation).toContain("provisionAdmittedRun");
      // Refused before the headroom read, the record and the box.
      expect(await t.driver.list()).toEqual([]);
      expect(existsSync(join(t.runs, "admit-elsewhere-run.json"))).toBe(false);
    } finally {
      clean(t);
    }
  });

  test("an invalid port refuses with a typed code, before the record exists", async () => {
    const t = tmp();
    try {
      const err = await rejection(provisionAdmittedRun(t.driver, t.store, { runId: "bad-port-run", port: 0 }));
      // Typed, not a bare Error: the fleet CLI classifies on `code` and prints
      // `remediation`, and `port: 0` used to be accepted (persisted as ports:[0]).
      expect(err).toBeInstanceOf(ProvisionRefusedError);
      expect((err as ProvisionRefusedError).code).toBe("invalid-port");
      expect(existsSync(join(t.runs, "bad-port-run.json"))).toBe(false);
    } finally {
      clean(t);
    }
  });

  test("a failed budget write REMOVES the record, so the admission's reservation can expire", async () => {
    const t = tmp();
    try {
      const runId = "budget-write-fails-run";
      const failing = Object.assign(Object.create(t.driver) as FakeDriver, {
        create: async (): Promise<ProviderVm> => {
          throw new Error("driver.create must never be reached");
        },
      });
      const realSet = t.store.set.bind(t.store);
      t.store.set = (() => {
        throw new Error("record write failed");
      }) as typeof t.store.set;

      let err: Error;
      try {
        err = await rejection(
          provisionAdmittedRun(failing, t.store, {
            runId,
            budget: {
              repoSlug: "qds/demo",
              issueId: "42",
              capMicroUsd: 5_000_000,
              spentMicroUsd: 0,
              reservedMicroUsd: 0,
              admittedCeilingMicroUsd: 5_000_000,
            },
          }),
        );
      } finally {
        t.store.set = realSet;
      }
      // The write failure is what the caller sees — never masked by the cleanup.
      expect(err.message).toContain("record write failed");
      // A record that RESOLVES with no `extensions.budget` is the one shape
      // nothing retires: the ledger's orphan guard expires only an admission
      // whose record does not resolve, and only a priced cost_event (written by
      // teardown FROM that extension) retires a reservation. Leaving it — open
      // or closed — erodes the issue's cap permanently.
      expect(existsSync(join(t.runs, `${runId}.json`))).toBe(false);
      expect(await failing.list(runId)).toEqual([]);
    } finally {
      clean(t);
    }
  });

  test("expose resolving no URL leaves the returned and the persisted httpsUrl agreeing", async () => {
    const t = tmp();
    try {
      const created = "https://created.example";
      const quiet = Object.assign(Object.create(t.driver) as FakeDriver, {
        create: async (name: string): Promise<ProviderVm> => ({ name, httpsUrl: created }),
        expose: async (): Promise<string> => undefined as unknown as string,
        setPublic: async (): Promise<void> => {},
      });
      const out = await provisionAdmittedRun(quiet, t.store, { runId: "quiet-expose-run", port: 8080 });
      // The store cannot unset a field, so "clear both" is unavailable — both
      // keep the create-time URL rather than the return dropping one the record
      // still carries.
      expect(out.httpsUrl).toBe(created);
      expect(out.record.httpsUrl).toBe(created);
    } finally {
      clean(t);
    }
  });

  test("a hung provider call is bounded, and the record survives as the handle", async () => {
    const t = tmp();
    try {
      const hung = Object.assign(Object.create(t.driver) as FakeDriver, {
        create: (): Promise<ProviderVm> => new Promise<ProviderVm>(() => {}),
      });
      const err = await rejection(
        provisionAdmittedRun(hung, t.store, { runId: "hung-create-run", actionTimeoutMs: 5 }),
      );
      expect(err.message).toContain("driver.create(hung-create-run) timed out after 5ms");
      // OPEN, because a timed-out create may still have stood a box up and the
      // run id is what the box is named after (teardown's fallback handle).
      expect(t.store.get("hung-create-run").closedAt).toBeUndefined();
    } finally {
      clean(t);
    }
  });

  test("each hung step of the provisioning sequence refuses with its OWN typed code", async () => {
    // A bare `Error` from withTimeout is the exact unclassified shape
    // ProvisionRefusedError exists to prevent: the fleet CLI reads `code` and
    // `remediation` off the thrown value, so a timeout reached an operator as
    // exit-1 "provisioning failed" naming no cause — while a box may be LIVE,
    // the record is open and the issue's reservation is still burning cap. One
    // code per step, because the remediation differs: after `create` you do not
    // yet know a box exists, after `expose` you know it does.
    const hang = <T>(): Promise<T> => new Promise<T>(() => {});
    const steps: [string, Partial<FakeDriver>, string][] = [
      ["create", { create: hang<ProviderVm> }, "provider-timeout-create"],
      ["expose", { expose: hang<string> }, "provider-timeout-expose"],
      ["setPublic", { setPublic: hang<void> }, "provider-timeout-set-public"],
    ];
    for (const [step, override, code] of steps) {
      const t = tmp();
      try {
        const hung = Object.assign(Object.create(t.driver) as FakeDriver, override);
        const runId = `hung-${step.toLowerCase()}-run`;
        const err = await rejection(
          provisionAdmittedRun(hung, t.store, { runId, port: 8080, actionTimeoutMs: 5 }),
        );
        expect(err).toBeInstanceOf(ProvisionRefusedError);
        expect((err as ProvisionRefusedError).code).toBe(code);
        // ABANDONED, not cancelled — the provider may still have acted on it,
        // which is the whole reason the remediation is a teardown and not a retry.
        expect(err.message).toContain("ABANDONED");
        expect((err as ProvisionRefusedError).remediation).toContain(`teardown ${runId}`);
        // The record is the only handle left to whatever the provider did.
        expect(t.store.get(runId).closedAt).toBeUndefined();
      } finally {
        clean(t);
      }
    }
  });

  test("expose reporting no URL — and create reporting none either — refuses BEFORE setPublic", async () => {
    const t = tmp();
    try {
      let madePublic = false;
      const noUrl = Object.assign(Object.create(t.driver) as FakeDriver, {
        // Neither call establishes an address. The record would then carry a
        // port and NO address (the store skips an undefined value and has no
        // way to unset one later), while setPublic still ran — leaving a
        // publicly reachable box whose address only the provider knows.
        create: async (name: string): Promise<ProviderVm> => ({ name, status: "running" }),
        expose: async (): Promise<string> => undefined as unknown as string,
        setPublic: async (): Promise<void> => {
          madePublic = true;
        },
      });
      const err = await rejection(
        provisionAdmittedRun(noUrl, t.store, { runId: "no-url-run", port: 8080 }),
      );
      expect(err).toBeInstanceOf(ProvisionRefusedError);
      expect((err as ProvisionRefusedError).code).toBe("expose-no-url");
      expect(madePublic).toBe(false);
      // Exposed but NOT public, with an OPEN record naming the box — the state
      // teardown can actually reach.
      const rec = t.store.get("no-url-run");
      expect(rec.closedAt).toBeUndefined();
      expect(rec.vmName).toBe("no-url-run");
      expect(rec.httpsUrl).toBeUndefined();
    } finally {
      clean(t);
    }
  });

  test("reap refuses outright when a run record file was skipped by the listing", async () => {
    const t = tmp();
    try {
      await provisionAdmittedRun(t.driver, t.store, { runId: "claimed-run" });
      await t.driver.create("orphan-box");
      // The record listing skips a `.json` whose stem fails the id grammar
      // (INV-4's one exception). A skipped file can hold an OPEN record naming a
      // live box, so the claim set is no longer provably complete — and every
      // name missing from it is a box this function would destroy.
      writeFileSync(join(t.runs, "Not_A_Run_Id.json"), "{}\n");
      // The filename is in the refusal: it is what an operator has to go rename.
      const err = await rejection(reapRuns(t.driver, t.store));
      expect(err).toBeInstanceOf(ProvisionRefusedError);
      // Typed, and distinct from the box-side twin (`reap-vms-unverified`): the
      // fleet CLI classifies on `code`, and the two need different remediations.
      expect((err as ProvisionRefusedError).code).toBe("reap-records-unverified");
      expect(err.message).toMatch(/refusing to reap.*Not_A_Run_Id\.json/);
      // Fail-safe: the orphan lives, rather than the claimed box dying.
      expect((await t.driver.list()).map((v) => v.name).sort()).toEqual(["claimed-run", "orphan-box"]);
    } finally {
      clean(t);
    }
  });
});

runDriverContract({ driverName: "fake", makeDriver: () => resolveDriver("fake") });
