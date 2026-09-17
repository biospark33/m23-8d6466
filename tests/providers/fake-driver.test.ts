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
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createRun,
  createBudgetMs,
  fillRun,
  FillError,
  type ProviderAuditLink,
  type ProviderVm,
  ProvisionRefusedError,
  provisionAdmittedRun,
  reapRuns,
  SBX_OWNERSHIP_TAG,
} from "../../src/providers/driver.ts";
import { FakeDriver } from "../../src/providers/fake-driver.ts";
import { DEFAULT_EXEC_TIMEOUT_MS } from "../../src/providers/exedev/transport.ts";
import { RunRecordStore } from "../../src/providers/run-record.ts";
import { resolveDriver } from "../../src/providers/index.ts";
import { setLogSink } from "../../src/swarmclaw/log.ts";
import { runDriverContract } from "./driver-contract.test.ts";
// The block below drives FLEET-layer entry points (`provisionAdmittedRun`,
// `reapRuns`) against this driver, so it shares the fleet suite's fixtures.
import { rejection } from "../helpers.ts";
import { isNoSuchBox } from "../../src/providers/harvest.ts";

/**
 * `kill(pid, 0)` — the usual liveness probe — succeeds for BOTH a running
 * process and a killed-but-unreaped zombie, so it cannot prove `destroy()`
 * left nothing running: a slow/contended runner's parent (here, the test
 * harness's own PID 1) can lag on reaping the orphaned grandchild `destroy()`
 * SIGKILLed, and the probe reads that lag as "still alive". `ps -o stat=`
 * distinguishes them (a zombie reports `Z`) and a fully-reaped pid throws
 * ENOENT outright — both are the settled state `destroy()` promises; only an
 * actively scheduled process (R/S/D/T, no `ps` failure) is a real leak.
 */
function expectProcessSettled(pid: number): void {
  let stat: string;
  try {
    stat = execFileSync("ps", ["-o", "stat=", "-p", String(pid)], { encoding: "utf8" }).trim();
  } catch {
    return; // ps found nothing — fully reaped, not running
  }
  expect(stat.startsWith("Z")).toBe(true); // visible only as a zombie, not running
}

const boxesDir = mkdtempSync(join(tmpdir(), "qds-fake-boxes-"));
/**
 * Saved and RESTORED, not just overwritten. `resolveDriver("fake")` reads this
 * at construction, so an unrestored value follows the bun process into every
 * later suite in the same run: they build FakeDrivers pointed at THIS file's
 * box directory (deleted below, so nonexistent), and the failure surfaces as an
 * unrelated test in an unrelated file, order-dependently.
 */
const prevBoxesDir = process.env.QDS_FAKE_BOXES_DIR;
process.env.QDS_FAKE_BOXES_DIR = boxesDir;

afterAll(() => {
  rmSync(boxesDir, { recursive: true, force: true });
  if (prevBoxesDir === undefined) {
    // biome-ignore lint/performance/noDelete: unsetting env vars requires delete
    delete process.env.QDS_FAKE_BOXES_DIR;
  } else {
    process.env.QDS_FAKE_BOXES_DIR = prevBoxesDir;
  }
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
  test("a box with no metadata is still listed, but reap REFUSES rather than silently sparing it", async () => {
    const boxes = mkdtempSync(join(tmpdir(), "qds-fake-orphan-"));
    const runs = mkdtempSync(join(tmpdir(), "qds-fake-orphan-runs-"));
    try {
      const d = new FakeDriver(boxes);
      mkdirSync(join(boxes, "half-built-box")); // crash between mkdir and writeMeta
      // LISTED is the accountability guarantee: `fleet status` names it, so an
      // operator can destroy it by hand. REAPING it is a different claim, and
      // this box cannot support it — no metadata means no ownership tag, and
      // reap destroys only what proves it is ours. Sparing stays mandatory
      // (destroying on a guess is unrecoverable), but the spare used to be
      // SILENT — the caller saw an empty destroyed list and unreaped spend was
      // invisible at exactly the moment a reaper ran. The sweep now refuses,
      // naming every unproven candidate.
      expect((await d.list()).map((v) => v.name)).toEqual(["half-built-box"]);
      const err = await rejection(reapRuns(d, new RunRecordStore({ dir: runs })));
      expect(err).toBeInstanceOf(ProvisionRefusedError);
      // Typed, so the CLI can route the operator to the box-side remediation.
      expect((err as ProvisionRefusedError).code).toBe("reap-vms-unowned");
      expect((err as Error).message).toContain("half-built-box");
      expect((err as Error).message).toContain("spared, not destroyed");
      // …and nothing was destroyed either way.
      expect((await d.list()).map((v) => v.name)).toEqual(["half-built-box"]);
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

  test("a skipped entry's name is SANITIZED: control characters ride escaped, not raw (S19)", async () => {
    // A directory name from `readdirSync` rides log lines and skipped entries
    // verbatim, and a name carrying a control character (a stray tab, newline
    // or escape — all legal on APFS/ext4) would inject them into those sinks.
    // Escaped to visible `\uXXXX` form; ordinary names pass through untouched.
    const boxes = mkdtempSync(join(tmpdir(), "qds-fake-ctrl-"));
    try {
      const d = new FakeDriver(boxes);
      mkdirSync(join(boxes, "bad\tname")); // fails the hostname grammar → skipped

      const lines: Record<string, unknown>[] = [];
      const restore = setLogSink((e) => lines.push(e as unknown as Record<string, unknown>));
      let listing: Awaited<ReturnType<FakeDriver["listWithAnomalies"]>>;
      try {
        listing = await d.listWithAnomalies();
      } finally {
        restore();
      }
      // The escaped form in the return value — the raw tab survives nowhere.
      expect(listing.skipped).toEqual(["bad\\u0009name"]);
      // The log line is sanitized by the same helper, not a second spelling.
      const messages = lines.flatMap((l) => {
        const e = l.error as { message?: string } | undefined;
        return typeof e?.message === "string" ? [e.message] : [];
      });
      expect(messages.some((m) => m.includes("bad\\u0009name"))).toBe(true);
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
      // Not a signal-0 probe — see expectProcessSettled: it cannot distinguish
      // "still running" from "killed but unreaped", which a contended runner
      // can leave sitting for longer than this assertion's own tick.
      expectProcessSettled(p1!);
      expectProcessSettled(p2!);
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
      // The spawned descendant must be dead, not reparented and running —
      // see expectProcessSettled for why this isn't a signal-0 probe.
      expectProcessSettled(Number(res.stdout.trim()));
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
      await expect(fillRun(d, "fill-escape-box", [{ path: "out/pwned.txt", content: "escaped\n" }], { recordAuditLink: () => {}, runId: "fill-escape-box", requestId: "test", repoSlug: undefined })).rejects.toThrow(
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
      await expect(fillRun(d, "fill-target-box", [{ path: "link.txt", content: "escaped\n" }], { recordAuditLink: () => {}, runId: "fill-target-box", requestId: "test", repoSlug: undefined })).rejects.toThrow(
        /fill failed|symlink/,
      );
      expect(existsSync(join(host, "pwned.txt"))).toBe(false);
    } finally {
      rmSync(boxes, { recursive: true, force: true });
      rmSync(host, { recursive: true, force: true });
    }
  });

  test("#222: fillRun's refusals are TYPED — a path escape and an exec failure are separable by code", async () => {
    // Bare `Error`s made the two arms indistinguishable to `dispatch.ts`'s
    // classifier and to any test that did not want to match message prose
    // (the #222 finding). `FillError` keeps the exact message strings; only
    // the type gained `code`/`remediation`.
    const boxes = mkdtempSync(join(tmpdir(), "qds-fake-fill-codes-"));
    try {
      const d = new FakeDriver(boxes);
      await d.create("fill-codes-box");
      // (`escape` shadows a restricted global name — named `escapeAttempt`.)
      const escapeAttempt = fillRun(d, "fill-codes-box", [{ path: "/etc/pwned", content: "x" }], { recordAuditLink: () => {}, runId: "fill-codes-box", requestId: "test", repoSlug: undefined });
      await expect(escapeAttempt).rejects.toThrow(/fill path escapes the box: \/etc\/pwned/);
      const escapeErr = (await escapeAttempt.catch((e: unknown) => e)) as { code?: string; remediation?: string };
      expect(escapeErr.code).toBe("fill-path-escape");
      expect(typeof escapeErr.remediation).toBe("string");

      // The exec-failure arm (the real driver refuses, the fake's script
      // surfaces a nonzero exit through the same wrap) stays a DIFFERENT code.
      symlinkSync(join(boxes, "elsewhere"), join(boxes, "fill-codes-box", "linked"));
      const failed = fillRun(d, "fill-codes-box", [{ path: "linked/x", content: "x" }], { recordAuditLink: () => {}, runId: "fill-codes-box", requestId: "test", repoSlug: undefined });
      await expect(failed).rejects.toThrow(/fill failed for linked\/x/);
      const failedErr = (await failed.catch((e: unknown) => e)) as { code?: string };
      expect(failedErr.code).toBe("fill-failed");
      expect(failedErr.code).not.toBe(escapeErr.code);
    } finally {
      rmSync(boxes, { recursive: true, force: true });
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
      const fillPromise = fillRun(d, "race-box", [{ path: "a/c.txt", content: "payload\n" }], { recordAuditLink: () => {}, runId: "race-box", requestId: "test", repoSlug: undefined });

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

  test("PARITY: execTimed exists, honours its ceiling, and enforces the same argv rule", async () => {
    // `src/fleet/status.ts` gates AC5's entire in-box marker read on
    // `typeof driver.execTimed === "function"`. While `FakeDriver` had none,
    // `--driver fake` and every list-only fixture reported `live` and the AC5
    // path was never exercised by a non-live test — a capability gap that made
    // an untested path look tested. Same drift class as `empty-argv`.
    const t = tmp();
    try {
      await t.driver.create("timed-run");
      expect(typeof t.driver.execTimed).toBe("function");

      // A generous ceiling does not interfere with a fast command.
      const ok = await t.driver.execTimed("timed-run", ["sh", "-c", "printf hi"], 30_000);
      expect(ok.exitCode).toBe(0);
      expect(ok.stdout).toBe("hi");

      // The ceiling KILLS rather than abandons, and the kill half is PROVEN,
      // not assumed: the child is a loop that keeps appending to a marker
      // file, so after the budget both a real kill and a silent abandon
      // return non-zero promptly — only the marker's size settling tells them
      // apart. (The loop lives IN the `sh -c` process itself, so SIGKILL to
      // the spawn takes the writer with it; a subshell would survive its
      // parent and false-fail this.) A spawn left running past its ceiling is
      // the defect this seam exists to prevent (see execTimed's docstring in
      // fake-driver.ts: `exec`'s withTimeout ABANDONS, `execTimed` kills).
      const marker = join(t.runs, "exectimed-kill.marker");
      const started = Date.now();
      const killed = await t.driver.execTimed(
        "timed-run",
        ["sh", "-c", 'while :; do echo x >> "$1"; sleep 0.05; done', "sh", marker],
        250,
      );
      expect(Date.now() - started).toBeLessThan(10_000);
      expect(killed.exitCode).not.toBe(0);
      // Grace, then two samples 400 ms apart: an orphan appends ~8 lines per
      // window, a dead child freezes the file exactly where the budget cut it.
      await new Promise((r) => setTimeout(r, 400));
      const sizeAtGrace = statSync(marker).size;
      expect(sizeAtGrace).toBeGreaterThan(0); // non-vacuous: the child really was writing
      await new Promise((r) => setTimeout(r, 400));
      expect(statSync(marker).size).toBe(sizeAtGrace); // stopped growing — actually dead

      // Same argv rule as `exec` — both route through the one guard.
      const err = await rejection(t.driver.execTimed("timed-run", ["git", ""], 1000));
      expect((err as Error & { code?: string }).code).toBe("empty-argv");

      // Round 4, P47: a NaN budget used to reach Bun.spawn as NaN
      // (`Math.max(1, NaN)` is NaN) and Bun REFUSES a NaN timeout with a
      // RangeError — a caller-side value bug surfaced as an opaque substrate
      // crash. Round 5 (BEHAVIOR-CHANGE-DRIVEN): non-finite now degrades to
      // the fake's OWN default — NO ceiling, exactly like `exec` — instead of
      // the 1 ms floor, mirroring exedev/transport.ts sshCommand's
      // fall-back-to-default. A 1 ms SIGKILL masqueraded as a box fault
      // (exit 137); ceiling-less, the call resolves with the child's real
      // outcome, never throws.
      const nanBudget = await t.driver.execTimed("timed-run", ["sh", "-c", "printf hi"], Number.NaN);
      expect(typeof nanBudget.exitCode).toBe("number");

      // The clamp's other degenerate budgets, pinned BEHAVIORALLY on the same
      // seam: 0 and a negative must not mean "no timeout" (`Math.max(1, …)`
      // floors them at 1 ms — a 5 s sleep is killed right there, promptly).
      // NON-FINITE is deliberately no longer in this loop: Infinity now takes
      // the ceiling-less default (see above), so a `sleep 5` under it runs to
      // completion and exits 0 — the no-masquerade property, not a floor.
      // Every row here resolves well inside the sleep's own duration — a
      // dropped clamp on EITHER side of the parity pair makes exactly one of
      // them hang or crash, which is the silent fake/real drift these PARITY
      // rows exist to make loud.
      for (const budget of [0, -1]) {
        const started = Date.now();
        const floored = await t.driver.execTimed("timed-run", ["sh", "-c", "sleep 5"], budget);
        expect(Date.now() - started).toBeLessThan(5_000);
        expect(floored.exitCode).not.toBe(0);
      }

      // stdin forwards through the timed seam too. `pushBundle` (exedev
      // fill.ts) is the production caller of exactly this shape — the whole
      // base64'd bundle rides one `execTimed` stdin — and a refactor dropping
      // the pass-through here would deliver an empty payload with the rest of
      // the suite green.
      const echoed = await t.driver.execTimed("timed-run", ["sh", "-c", "cat"], 5_000, "hi");
      expect(echoed.exitCode).toBe(0);
      expect(echoed.stdout).toBe("hi");
    } finally {
      clean(t);
    }
  }, 30_000);

  test("PARITY: exec's default ceiling — real 120 s by constant, fake none by design", () => {
    // The DOCUMENTED divergence, pinned at its one number. `FakeDriver.exec`
    // spawns with NO timeout at all (fake-driver.ts's spawnExec sets `timeout`
    // only when a per-call budget was asked for — its "No per-call deadline,
    // exactly like `ExeDevDriver.exec` has none beyond its constructor
    // default" docblock), while `ExeDevDriver.exec` rides sshCommand's
    // constructor default: a hung `exec` settles only at `destroy` here, but
    // at the 120 s SIGKILL on the real substrate. A unit-tier suite that
    // unknowingly awaits a hung `exec` therefore passes against the fake and
    // hangs a runner the first time the same logic runs for real. Moving the
    // real constant — or "fixing" the fake by giving `exec` a default
    // ceiling, which re-times every long-running demo/drain path in this
    // suite — now has a red line with the asymmetry named beside it.
    expect(DEFAULT_EXEC_TIMEOUT_MS).toBe(120_000);
  });

  test("PARITY: the fake refuses an empty or whitespace-only argv ELEMENT, with the real driver's code", async () => {
    // The mirror of `ExeDevDriver`'s per-element rule was added to `FakeDriver`
    // as the structural half of DF1.10's `empty-argv` post-mortem — and NOTHING
    // pinned it. Deleting the guard left the whole suite green, which is the
    // exact fake-drift class the post-mortem is about, silently re-armed: the
    // fake was weaker than the thing it stands in for, so it did not merely
    // miss the `pullArtifacts` defect, it CERTIFIED it across 5154 tests until
    // a paid tier-1 round found it.
    //
    // The CODE is asserted, not just the message: a caller discriminating on
    // `err.code === "empty-argv"` is the shape that diverges in production if
    // the fake throws a bare `Error`. (The class differs by design —
    // `FakeDriverError` — because this module must not import a substrate's.)
    const t = tmp();
    try {
      await t.driver.create("argv-parity-run");
      // DF1.10 round 3 (C2-2): the invisibly-blank shapes ride the same guard —
      // trim() cannot see SHY/ZWSP/WORD-JOINER/BOM, so these used to pass both
      // drivers as no-op elements no review could catch.
      for (const argv of [
        [""],
        ["git", ""],
        ["   "],
        ["git", "  \t  "],
        ["git", "\n"],
        ["\u200b"],
        ["git", "\u00ad\u2060\ufeff"],
      ]) {
        const err = await rejection(t.driver.exec("argv-parity-run", argv));
        expect(err.message).toContain("exec requires a non-empty argv");
        expect((err as Error & { code?: string }).code).toBe("empty-argv");
      }
      // Non-vacuity: the same box runs an ordinary argv fine, so the refusals
      // above are about the ELEMENTS and not about the fixture.
      expect((await t.driver.exec("argv-parity-run", ["true"])).exitCode).toBe(0);
      // And the outer empty-argv case, which was always checked, still is.
      const empty = await rejection(t.driver.exec("argv-parity-run", []));
      expect((empty as Error & { code?: string }).code).toBe("empty-argv");

      // The OTHER side of parity, source-pinned (DF1.10 round 3, C2-3): the
      // fake's rule is a MIRROR of ExeDevDriver's, and a mirror nothing
      // re-checks is parity with prose — rename or relax the real predicate and
      // both PARITY tests above stay green while the two drivers disagree, the
      // exact drift the post-mortem is about. The real spelling is therefore
      // asserted against the real source, including the C2-2 invisible-set
      // extension, twice: `exec` AND `execTimed` carry one guard each.
      // (Source-pin idiom as in tests/fleet/verbs.test.ts.)
      const realDriverSrc = readFileSync(new URL("../../src/providers/exedev/driver.ts", import.meta.url), "utf8");
      expect(
        (
          realDriverSrc.match(
            /argv\.some\(\(a\) => a\.replace\(INVISIBLE_BLANK_RE, ""\)\.trim\(\)\.length === 0\)/g,
          ) ?? []
        ).length,
      ).toBe(2);
    } finally {
      clean(t);
    }
  });

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
          recordAuditLink: () => {},
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
      const err = await rejection(provisionAdmittedRun(t.driver, t.store, { runId: "bad-port-run", port: 0, recordAuditLink: () => {} }));
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
            recordAuditLink: () => {},
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
      const out = await provisionAdmittedRun(quiet, t.store, { runId: "quiet-expose-run", port: 8080, recordAuditLink: () => {} });
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
        provisionAdmittedRun(hung, t.store, { runId: "hung-create-run", actionTimeoutMs: 5, recordAuditLink: () => {} }),
      );
      expect(err.message).toContain("driver.create(hung-create-run) timed out after 5ms");
      // OPEN, because a timed-out create may still have stood a box up and the
      // run id is what the box is named after (teardown's fallback handle).
      expect(t.store.get("hung-create-run").closedAt).toBeUndefined();
    } finally {
      clean(t);
    }
  });

  test("create's DEFAULT budget clears a measured cold image pull, and the create step is ROUTED through it", () => {
    // The 60 s the rest of the sequence uses was borrowed from the DF2.6
    // reaper's per-unit ops, which act on a box that already exists. `create`
    // can carry a COLD PULL of the pinned image: 86 s measured live on
    // 2026-09-03 (tier1-registry-auth.live.test.ts:28), so under the shared
    // ceiling the first create after every image re-pin timed out — and an
    // abandoned create is the orphan-box shape, not a clean refusal.
    expect(createBudgetMs()).toBe(300_000);
    // (The 86 s datum above is documentation, deliberately no longer a second
    // assertion: `toBeGreaterThan(86_000)` was subsumed by the line above and
    // could never fail while it passed. DF1.10 round 3, C2-4.)
    // An explicit ceiling governs create too: the hung-provider tests above
    // inject 5 ms and cannot afford to wait out either default.
    expect(createBudgetMs(5)).toBe(5);
    // The ROUTING, source-pinned (DF1.10 round 3, C2-5) — the selector alone
    // cannot see it. The create step's default must go THROUGH createBudgetMs
    // at its one default-path call site (driver.ts, provisionAdmittedRun);
    // reverting that line to the shared 60 s PROVISION_ACTION_TIMEOUT_MS
    // re-arms the abandoned-create orphan shape and leaves every assert above
    // green. This is the line that goes red instead. Proving the 300 s default
    // behaviorally would mean timing out a create against it; the INJECTED arm
    // is already covered behaviorally by the two hung-create tests here.
    // (Source-pin idiom as in tests/fleet/verbs.test.ts.)
    const driverSrc = readFileSync(new URL("../../src/providers/driver.ts", import.meta.url), "utf8");
    expect(driverSrc).toContain("const createTimeoutMs = createBudgetMs(opts.actionTimeoutMs);");
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
          provisionAdmittedRun(hung, t.store, { runId, port: 8080, actionTimeoutMs: 5, recordAuditLink: () => {} }),
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

  test.each([
    ["undefined", undefined as unknown as string],
    ["the empty string", ""],
    ["whitespace only", "   "],
  ])(
    "expose reporting %s — and create reporting none either — refuses BEFORE setPublic",
    async (_shape, exposed) => {
      const t = tmp();
      try {
        let madePublic = false;
        const noUrl = Object.assign(Object.create(t.driver) as FakeDriver, {
          // Neither call establishes an address. The record would then carry a
          // port and NO address (the store skips an undefined value and has no
          // way to unset one later), while setPublic still ran — leaving a
          // publicly reachable box whose address only the provider knows.
          //
          // Parameterised over all three shapes because only the FIRST is
          // caught by a `=== undefined` guard. `""` and `"   "` are what a real
          // driver returns when its provider answers with an empty field, and
          // both sailed straight past that guard into `setPublic` — the exact
          // outcome this refusal exists to prevent, reached by a shape the one
          // fixture never produced. `address()` normalising on `trim()` is what
          // the three of them pin together.
          create: async (name: string): Promise<ProviderVm> => ({ name, status: "running" }),
          expose: async (): Promise<string> => exposed,
          setPublic: async (): Promise<void> => {
            madePublic = true;
          },
        });
        const err = await rejection(
          provisionAdmittedRun(noUrl, t.store, { runId: "no-url-run", port: 8080, recordAuditLink: () => {} }),
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
    },
  );

  test("reap destroys only what proves BOTH name grammar and ownership tag", async () => {
    // The arm the shared contract suite cannot reach on this driver. Step 7
    // there asserts the RULE across both drivers, but each one only ever
    // exercises ONE branch of it: FakeDriver reports its tag so the if-branch
    // always wins, and exedev's `ls --json` carries no tag field so the else
    // always does. The untagged-but-grammatical box — created before the tag
    // existed, or a fake box that crashed between `mkdir` and its metadata
    // write — is reachable only here.
    const t = tmp();
    try {
      // RUN_ID_SHAPE, not just a legal box name: the reaper's name half is
      // `<slug>-<YYYYMMDD>-<6 hex>`, so a plainly-named box fails it and the
      // tag half would never be reached.
      const tagged = "reap-20260822-a1b2c3";
      const untagged = "reap-20260822-d4e5f6";
      await t.driver.create(tagged, SBX_OWNERSHIP_TAG);
      await t.driver.create(untagged); // grammatical name, no tag

      // The untagged box cannot PROVE it is ours. Sparing stays mandatory (a
      // stranger can name a box anything), but sparing silently hid unreaped
      // spend from the caller — the sweep now partitions BEFORE destroying
      // anything and refuses naming every unproven candidate.
      const err = await rejection(reapRuns(t.driver, t.store));
      expect(err).toBeInstanceOf(ProvisionRefusedError);
      expect((err as ProvisionRefusedError).code).toBe("reap-vms-unowned");
      expect((err as Error).message).toContain(untagged);
      // Refusal-first means even the PROVEN box survives this round untouched.
      expect((await t.driver.list()).map((v) => v.name).sort()).toEqual([tagged, untagged]);

      // The remediation is operator action; once the unproven box is gone, the
      // sweep destroys exactly what proved both halves of ownership.
      await t.driver.destroy(untagged);
      expect(await reapRuns(t.driver, t.store)).toEqual([tagged]);
    } finally {
      clean(t);
    }
  });

  test("the boxes root is created by create(), not by the constructor (AC1)", async () => {
    // "Validation completes before the first side effect": `resolveDriver`
    // runs during dispatch setup, BEFORE the brief is validated, so a mkdir in
    // the constructor left a directory behind on every brief that was about to
    // exit 2. The first side effect belongs to the first box.
    const root = join(mkdtempSync(join(tmpdir(), "qds-lazy-root-")), "boxes");
    try {
      const driver = new FakeDriver(root);
      expect(existsSync(root)).toBe(false);
      // …and reading is not a side effect either: no root ⇒ no box was ever
      // created ⇒ an empty population, not an error and not a mkdir.
      expect(await driver.list()).toEqual([]);
      expect(existsSync(root)).toBe(false);

      await driver.create("lazy-box");
      expect(existsSync(root)).toBe(true);
      expect((await driver.list()).map((v) => v.name)).toEqual(["lazy-box"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("reap refuses outright when a run record file was skipped by the listing", async () => {
    const t = tmp();
    try {
      await provisionAdmittedRun(t.driver, t.store, { runId: "claimed-run", recordAuditLink: () => {} });
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

  // ── D11 (round 11): FakeDriver errors are CONTRACT-shaped ───────────────────
  // dispatch's classifier reads `code` + `remediation` off every driver
  // rejection; a raw fs error out of the fake reached it unclassified. And the
  // MESSAGE keeps `no such box:` — harvest's isNoSuchBox and teardown's box-gone
  // skip classify on that text, so reshaping the error must not lose the marker.

  test("D11: readMeta failure carries code + remediation AND the 'no such box:' prefix", async () => {
    const t = tmp();
    try {
      // A metadata-name mismatch is the injection-free route into the contract-
      // shaped error: the directory exists but its .box.json names another box,
      // exactly what a workload overwriting .box.json produces.
      await t.driver.create("d11-box-20260827-a1b2c3");
      const meta = join(t.boxes, "d11-box-20260827-a1b2c3", ".box.json");
      writeFileSync(meta, `${JSON.stringify({ name: "someone-else", public: false, ports: [], createdAt: new Date().toISOString() }, null, 2)}\n`, {
        mode: 0o600,
      });
      const err = await rejection(t.driver.exec("d11-box-20260827-a1b2c3", ["true"]));
      expect(err).toBeInstanceOf(Error);
      expect((err as { code?: string }).code).toBe("no-such-box");
      expect(typeof (err as { remediation?: string }).remediation).toBe("string");
      expect((err as { remediation?: string }).remediation).toContain(".box.json");
      // The harvest-classifier half: this prefix must survive any reshape.
      expect(isNoSuchBox(err)).toBe(true);
    } finally {
      clean(t);
    }
  });

  test("D11: create EEXIST refuses as a typed box-exists, not a raw mkdir errno", async () => {
    const t = tmp();
    try {
      await t.driver.create("d11-dup-20260827-b2c3d4");
      const err = await rejection(t.driver.create("d11-dup-20260827-b2c3d4"));
      expect(err).toBeInstanceOf(Error);
      expect((err as { code?: string }).code).toBe("box-exists");
      expect((err as Error).message).toContain("already exists");
      // The literal next command an operator (or caller) can run.
      expect(String((err as { remediation?: string }).remediation)).toContain("destroy");
    } finally {
      clean(t);
    }
  });

  // ── D7/D8 (round 11): the reap destroy loop fails LOUD and PARTIAL-aware ────

  test("D7/D8: a mid-sweep destroy throw keeps what was destroyed and what remains on the error", async () => {
    const t = tmp();
    try {
      const store = new RunRecordStore({ dir: t.runs });
      const n0 = "reap-p1-20260827-c1d2e3";
      const n1 = "reap-p2-20260827-c1d2e4";
      const n2 = "reap-p3-20260827-c1d2e5";
      for (const n of [n0, n1, n2]) await t.driver.create(n, SBX_OWNERSHIP_TAG);
      const d = t.driver;
      const realDestroy = d.destroy.bind(d);
      let calls = 0;
      // Fail on the SECOND destroy: one success precedes it, one target follows.
      d.destroy = async (name: string) => {
        calls += 1;
        if (calls === 2) throw Object.assign(new Error("destroy exploded"), { code: "exec-failed" });
        return realDestroy(name);
      };
      let err: unknown;
      try {
        await reapRuns(d, store);
      } catch (e) {
        err = e;
      }
      expect(err).toBeInstanceOf(Error);
      const e2 = err as Error & { destroyed?: string[]; remaining?: string[] };
      // D7: everything torn down BEFORE the throw is reported — losing it
      // understates what the sweep did and hides successful work from callers.
      expect(e2.destroyed ?? []).toEqual([n0]);
      // `remaining` carries the documented contract: the FAILED call plus
      // every eligible box still unprocessed after it — exactly what callers
      // cannot assume about provider state. (The failed name alone would hide
      // n2, which no destroy was ever attempted against.)
      expect(e2.remaining ?? []).toEqual([n1, n2]);
      // First really gone; failed and not-yet-attempted boxes all still there.
      expect(await d.list(n0)).toEqual([]);
      expect((await d.list()).map((v) => v.name)).toContain(n1);
      expect((await d.list()).map((v) => v.name)).toContain(n2);
    } finally {
      clean(t);
    }
  });

  test("D7/D8: a HUNG driver.destroy aborts at the sweep budget with reap-destroy-timeout", async () => {
    const t = tmp();
    try {
      const store = new RunRecordStore({ dir: t.runs });
      const id = "reap-hang-20260827-d4e5f6";
      await t.driver.create(id, SBX_OWNERSHIP_TAG);
      const d = t.driver;
      // NEVER settles — the bare-await hazard D8 names. The budget is
      // INJECTED through reapRuns' third parameter: the production refusal
      // (not this harness's outer bound) is what the test observes, without
      // pinning the 120s constant. withTimeout clears its own timer in a
      // finally, so the abandoned race leaves nothing scheduled behind.
      d.destroy = () => new Promise(() => {});
      let err: unknown;
      const started = Date.now();
      try {
        await reapRuns(d, store, 150);
      } catch (e) {
        err = e;
      }
      expect(Date.now() - started).toBeLessThan(5_000); // the injected budget fired, not the 120s default
      // The sweep's OWN typed refusal, with the partial report attached:
      expect(err).toBeInstanceOf(ProvisionRefusedError);
      const refused = err as ProvisionRefusedError & { destroyed?: string[]; remaining?: string[] };
      expect(refused.code).toBe("reap-destroy-timeout");
      expect(refused.destroyed ?? []).toEqual([]);
      // The hung box is the failed head of `remaining` — never-confirmed-gone.
      expect(refused.remaining ?? []).toEqual([id]);
      // …and the hung call left the box listed, so no state was lost or faked.
      expect((await t.driver.list()).map((v) => v.name)).toEqual([id]);
    } finally {
      clean(t);
    }
  });
});

// ---------------------------------------------------------------------------
// DF5.3 — hop 5 (run-box), the two links driver.ts emits itself
// ---------------------------------------------------------------------------

/**
 * Both emits below were, before this suite existed, asserted by NOTHING in the
 * repository: every `provisionAdmittedRun`/`fillRun` call site in the tests
 * passed `recordAuditLink: () => {}`, and `fillRun`'s emit is additionally
 * guarded on a `repoSlug` no site supplied — so it was structurally
 * UNREACHABLE. Either emit could have been deleted, or emitted with the runId
 * in place of the box, or with `fileCount: 0`, and the whole suite stayed
 * green while hop 5's chain broke at its FIRST link in production.
 */
describe("DF5.3 — the run-box links (hop 5)", () => {
  function tmp(): { boxes: string; runs: string; driver: FakeDriver; store: RunRecordStore } {
    const boxes = mkdtempSync(join(tmpdir(), "qds-df53-boxes-"));
    const runs = mkdtempSync(join(tmpdir(), "qds-df53-runs-"));
    return { boxes, runs, driver: new FakeDriver(boxes), store: new RunRecordStore({ dir: runs }) };
  }
  function clean(t: { boxes: string; runs: string }): void {
    rmSync(t.boxes, { recursive: true, force: true });
    rmSync(t.runs, { recursive: true, force: true });
  }

  const BUDGET = {
    repoSlug: "qds/demo",
    issueId: "42",
    capMicroUsd: 5_000_000,
    spentMicroUsd: 0,
    reservedMicroUsd: 0,
    admittedCeilingMicroUsd: 5_000_000,
  };

  /**
   * A driver whose box is named DIFFERENTLY from the run. FakeDriver names the
   * box after the runId, which makes `subjectId === vm.name` and
   * `subjectId === runId` indistinguishable — an assertion that holds for the
   * correct AND the incorrect implementation proves nothing. The real box is
   * still created (so teardown/list stay honest); only the reported name
   * differs.
   */
  /**
   * The store's own typed refusal, as the emitters recognise it: `driver.ts`
   * must not import `src/audit/*`, so `isAuditStoreError` matches
   * STRUCTURALLY on `name === "AuditStoreError"`. A plain `new Error(...)` is
   * deliberately NOT classified any more — it reaches the operator as the
   * emitter bug it is instead of as "the store refused, tear the run down".
   */
  function storeRefusal(message: string): Error {
    const e = Object.assign(new Error(message), {
      code: "audit-store-unwritable",
      remediation: "check the uid, the mount and the free space on the store's device",
    });
    e.name = "AuditStoreError";
    return e;
  }

  function boxNamedApart(t: { driver: FakeDriver }): FakeDriver {
    return Object.assign(Object.create(t.driver) as FakeDriver, {
      create: async (name: string): Promise<ProviderVm> => {
        await t.driver.create(name);
        return { name: `vm-${name}`, httpsUrl: "https://box.example" };
      },
    });
  }

  test("H1: provisionAdmittedRun emits exactly one run-box.create, subject = the BOX", async () => {
    const t = tmp();
    const links: ProviderAuditLink[] = [];
    try {
      const runId = "df53-create-run";
      const before = Date.now();
      const out = await provisionAdmittedRun(boxNamedApart(t), t.store, {
        runId,
        budget: BUDGET,
        requestId: "req-create",
        recordAuditLink: (l) => links.push(l),
      });
      const after = Date.now();
      expect(links.map((l) => `${l.hop}.${l.event}`)).toEqual(["run-box.create"]);
      const link = links[0]!;
      // The BOX, not the run — the two are distinguishable in this fixture.
      expect(link.subjectId).toBe(out.record.vmName);
      expect(link.subjectId).toBe(`vm-${runId}`);
      expect(link.subjectId).not.toBe(runId);
      expect(link.subjectKind).toBe("box");
      expect(link.runId).toBe(runId);
      expect(link.repoSlug).toBe("qds/demo");
      expect(link.requestId).toBe("req-create");
      expect(link.detail).toEqual({ vmName: `vm-${runId}`, provider: "fake" });
      // INV-AUDIT-4, "never retroactive" — a BOUND check, not
      // `occurredAt === recordedAt`. The latter cannot fail for anything
      // routed through `emitAuditLink` (one local is assigned to both fields
      // when the caller passes no `occurredAt`), so it re-stated the helper's
      // implementation while reading as coverage of the invariant. The real
      // retroactivity risk is an emitter that stamps a STORED timestamp — this
      // catches that, and `tests/providers/audit-emit.test.ts` owns the helper.
      expect(Date.parse(link.occurredAt)).toBeGreaterThanOrEqual(before);
      expect(Date.parse(link.occurredAt)).toBeLessThanOrEqual(after);
    } finally {
      clean(t);
    }
  });

  test("an unattributed run emits no create link and LOGS the no-repo-slug skip (INV-AUDIT-4)", async () => {
    // Round 3 inverted the second half of this test. The `no-repo-slug` arm
    // used to return silently — the most frequent skip of the three, and the
    // one the emitters' own doc comments tell operators to grep for. An
    // unattributed run still emits nothing (the columns are NOT NULL and a
    // manufactured attribution is what INV-AUDIT-4 forbids), but the run now
    // says so once instead of leaving hop 5 `unlinked` with no local trace.
    const t = tmp();
    const links: ProviderAuditLink[] = [];
    const entries: Array<Record<string, unknown>> = [];
    const restore = setLogSink((e) => entries.push(e as unknown as Record<string, unknown>));
    try {
      await provisionAdmittedRun(t.driver, t.store, {
        runId: "df53-create-unattributed",
        requestId: "req-create",
        recordAuditLink: (l) => links.push(l),
      });
      expect(links).toEqual([]);
      const skipped = entries.filter((e) => e.operation === "providers.audit-link-skipped");
      expect(skipped).toHaveLength(1);
      expect(skipped[0]!.reason).toBe("no-repo-slug");
      expect(skipped[0]!.event).toBe("create");
      expect(skipped[0]!.runId).toBe("df53-create-unattributed");
    } finally {
      restore();
      clean(t);
    }
  });

  test("C5: an attributed run with NO requestId SKIPS the emit rather than minting a join key", async () => {
    const t = tmp();
    const links: ProviderAuditLink[] = [];
    const entries: Array<Record<string, unknown>> = [];
    const restore = setLogSink((e) => entries.push(e as unknown as Record<string, unknown>));
    try {
      // No `requestId` in the options, and `store.create` makes a FRESH record
      // that carries none either. A minted id here would be a fabricated join
      // key: the walker JOINs `sessions.request_id` on it.
      await provisionAdmittedRun(t.driver, t.store, {
        runId: "df53-create-noreq",
        budget: BUDGET,
        recordAuditLink: (l) => links.push(l),
      });
      expect(links).toEqual([]);
      const skipped = entries.filter((e) => e.operation === "providers.audit-link-skipped");
      expect(skipped).toHaveLength(1);
      expect(skipped[0]!.reason).toBe("no-request-id");
      expect(skipped[0]!.event).toBe("create");
      expect(skipped[0]!.runId).toBe("df53-create-noreq");
      // The log line's own correlation id is minted (LogEntry requires one) —
      // what must never happen is that id reaching `audit_links`, which the
      // empty `links` above is the assertion for.
      expect(typeof skipped[0]!.requestId).toBe("string");
    } finally {
      restore();
      clean(t);
    }
  });

  test("a store refusal on the create link is a ProvisionRefusedError with the TEARDOWN remediation", async () => {
    // It fires while the box is LIVE and BILLING. A bare AuditStoreError would
    // reach dispatch's classifier pointing the operator at the audit store,
    // while the only correct next action is to tear the run down.
    const t = tmp();
    try {
      const runId = "df53-create-storefail";
      const err = await rejection(
        provisionAdmittedRun(boxNamedApart(t), t.store, {
          runId,
          budget: BUDGET,
          requestId: "req-create",
          recordAuditLink: () => {
            throw storeRefusal("audit store is read-only");
          },
        }),
      );
      expect(err).toBeInstanceOf(ProvisionRefusedError);
      const refused = err as ProvisionRefusedError;
      expect(refused.code).toBe("audit-link-write-failed");
      expect(refused.message).toContain("audit store is read-only");
      expect(refused.message).toContain(`vm-${runId}`);
      expect(refused.remediation).toContain(`teardown ${runId}`);
      // The record is left OPEN naming the box — that IS the cleanup handle.
      expect(t.store.get(runId).vmName).toBe(`vm-${runId}`);
      expect(t.store.get(runId).closedAt).toBeUndefined();
      // …and the box the remediation names is REALLY still there. The whole
      // justification for choosing the teardown remediation over the audit
      // store's own is that the box is live and billing; an implementation
      // that rolled the box back on this path would make the remediation
      // misleading and passed here until now. `boxNamedApart` reports
      // `vm-<runId>` but creates the real box under the run id.
      expect(existsSync(join(t.boxes, runId))).toBeTrue();
    } finally {
      clean(t);
    }
  });

  test("a NON-store throw from the create emit propagates unwrapped — not an audit-store refusal", async () => {
    // The narrowing round 3 added. A blanket catch classified a
    // `JSON.stringify` TypeError on a BigInt/circular `detail` as an
    // audit-store write failure and told the operator to DESTROY a healthy
    // billing run over an emitter bug, with the real cause hidden behind the
    // remediation. A programming error must surface as itself.
    const t = tmp();
    try {
      const runId = "df53-create-emitbug";
      const err = await rejection(
        provisionAdmittedRun(boxNamedApart(t), t.store, {
          runId,
          budget: BUDGET,
          requestId: "req-create",
          recordAuditLink: () => {
            throw new TypeError("Do not know how to serialize a BigInt");
          },
        }),
      );
      expect(err).toBeInstanceOf(TypeError);
      expect(err).not.toBeInstanceOf(ProvisionRefusedError);
      expect((err as Error).message).toContain("BigInt");
    } finally {
      clean(t);
    }
  });

  test("H2: a happy-path fillRun emits exactly one run-box.fill, subject = the BOX, with the file count", async () => {
    const boxes = mkdtempSync(join(tmpdir(), "qds-df53-fill-"));
    const links: ProviderAuditLink[] = [];
    try {
      const d = new FakeDriver(boxes);
      // Box name DELIBERATELY unlike the runId: `fillRun` takes them as two
      // separate arguments, so emitting `audit.runId` as the subject would be
      // invisible under the usual same-name fixture.
      const vm = "vm-df53-fill";
      const runId = "df53-fill-run";
      await d.create(vm);
      const before = Date.now();
      await fillRun(
        d,
        vm,
        [
          { path: "a.txt", content: "one\n" },
          { path: "nested/b.txt", content: "two\n" },
        ],
        { recordAuditLink: (l) => links.push(l), runId, requestId: "req-fill", repoSlug: "qds/demo" },
      );
      const after = Date.now();
      expect(links).toHaveLength(1);
      const link = links[0]!;
      expect(`${link.hop}.${link.event}`).toBe("run-box.fill");
      expect(link.subjectId).toBe(vm);
      expect(link.subjectId).not.toBe(runId);
      expect(link.subjectKind).toBe("box");
      expect(link.runId).toBe(runId);
      expect(link.repoSlug).toBe("qds/demo");
      expect(link.requestId).toBe("req-fill");
      expect(link.detail).toEqual({ fileCount: 2 });
      // Bound check, not `occurredAt === recordedAt` — see H1.
      expect(Date.parse(link.occurredAt)).toBeGreaterThanOrEqual(before);
      expect(Date.parse(link.occurredAt)).toBeLessThanOrEqual(after);
      // …and the files actually landed, so `fileCount` describes real work.
      expect(readFileSync(join(boxes, vm, "nested", "b.txt"), "utf8")).toBe("two\n");
    } finally {
      rmSync(boxes, { recursive: true, force: true });
    }
  });

  test("a FAILED fill emits nothing — the link means every file landed", async () => {
    const boxes = mkdtempSync(join(tmpdir(), "qds-df53-fill-fail-"));
    const links: ProviderAuditLink[] = [];
    try {
      const d = new FakeDriver(boxes);
      await d.create("vm-df53-fill-fail");
      await expect(
        fillRun(d, "vm-df53-fill-fail", [{ path: "/etc/pwned", content: "x" }], {
          recordAuditLink: (l) => links.push(l),
          runId: "df53-fill-fail-run",
          requestId: "req-fill",
          repoSlug: "qds/demo",
        }),
      ).rejects.toThrow(/fill path escapes the box/);
      expect(links).toEqual([]);
    } finally {
      rmSync(boxes, { recursive: true, force: true });
    }
  });

  test("an EMPTY identity field skips the fill emit instead of throwing after every file landed", async () => {
    // The guard is `auditNonEmpty`, not `!== undefined`: an empty string passed
    // the weaker predicate, reached the store's own non-empty check and threw
    // `audit-link-invalid` AFTER the files were already in the box — turning a
    // successful fill into a dispatch failure. Round 3 routed ALL THREE
    // identity fields through that one predicate (C3), so all three are
    // exercised here — `requestId: ""` is type-legal (the field is
    // `string | undefined`), which is exactly why it needs a test and not just
    // a type.
    const boxes = mkdtempSync(join(tmpdir(), "qds-df53-fill-empty-"));
    const links: ProviderAuditLink[] = [];
    const entries: Array<Record<string, unknown>> = [];
    const restore = setLogSink((e) => entries.push(e as unknown as Record<string, unknown>));
    const cases: Array<{ name: string; reason: string; audit: { runId: string; requestId: string | undefined; repoSlug: string | undefined } }> = [
      { name: "slug-empty", reason: "no-repo-slug", audit: { runId: "df53-fill-empty-run", requestId: "req-fill", repoSlug: "" } },
      { name: "slug-absent", reason: "no-repo-slug", audit: { runId: "df53-fill-empty-run", requestId: "req-fill", repoSlug: undefined } },
      { name: "req-empty", reason: "no-request-id", audit: { runId: "df53-fill-empty-run", requestId: "", repoSlug: "qds/demo" } },
      { name: "req-absent", reason: "no-request-id", audit: { runId: "df53-fill-empty-run", requestId: undefined, repoSlug: "qds/demo" } },
      { name: "run-empty", reason: "no-run-id", audit: { runId: "", requestId: "req-fill", repoSlug: "qds/demo" } },
    ];
    try {
      const d = new FakeDriver(boxes);
      await d.create("vm-df53-fill-empty");
      for (const c of cases) {
        links.length = 0;
        entries.length = 0;
        await fillRun(d, "vm-df53-fill-empty", [{ path: `${c.name}.txt`, content: "x\n" }], {
          recordAuditLink: (l) => links.push(l),
          ...c.audit,
        });
        expect(links, c.name).toEqual([]);
        const skipped = entries.filter((e) => e.operation === "providers.audit-link-skipped");
        expect(skipped.map((e) => e.reason), c.name).toEqual([c.reason]);
        expect(skipped[0]!.event, c.name).toBe("fill");
        // The fill SUCCEEDED — the skip is a skip, not a refusal.
        expect(readFileSync(join(boxes, "vm-df53-fill-empty", `${c.name}.txt`), "utf8")).toBe("x\n");
      }
    } finally {
      restore();
      rmSync(boxes, { recursive: true, force: true });
    }
  });

  test("a store refusal on the FILL link is a FillError with the TEARDOWN remediation, files already landed", async () => {
    // The mirror of the create-side test above, and the half this PR fixes:
    // before it, a raw `AuditStoreError` escaped `fillRun` into dispatch's
    // classifier with an audit-store remediation, past a LIVE, BILLING box
    // whose files had all landed — the two halves of hop 5 failing with
    // different shapes. Nothing asserted it, so reverting the try/catch left
    // the suite green.
    const boxes = mkdtempSync(join(tmpdir(), "qds-df53-fill-storefail-"));
    try {
      const d = new FakeDriver(boxes);
      const vm = "vm-df53-fill-storefail";
      const runId = "df53-fill-storefail-run";
      await d.create(vm);
      const err = await rejection(
        fillRun(d, vm, [{ path: "a.txt", content: "one\n" }, { path: "nested/b.txt", content: "two\n" }], {
          recordAuditLink: () => {
            throw storeRefusal("audit store is read-only");
          },
          runId,
          requestId: "req-fill",
          repoSlug: "qds/demo",
        }),
      );
      expect(err).toBeInstanceOf(FillError);
      const failed = err as FillError;
      expect(failed.code).toBe("audit-link-write-failed");
      expect(failed.message).toContain("audit store is read-only");
      expect(failed.message).toContain(vm);
      expect(failed.remediation).toContain(`teardown ${runId}`);
      // EVERY file landed before the emit — that is what the message claims
      // and what makes teardown, not a retry, the operator's next move.
      expect(readFileSync(join(boxes, vm, "a.txt"), "utf8")).toBe("one\n");
      expect(readFileSync(join(boxes, vm, "nested", "b.txt"), "utf8")).toBe("two\n");
    } finally {
      rmSync(boxes, { recursive: true, force: true });
    }
  });

  test("a NON-store throw from the fill emit propagates unwrapped — not an audit-store refusal", async () => {
    const boxes = mkdtempSync(join(tmpdir(), "qds-df53-fill-emitbug-"));
    try {
      const d = new FakeDriver(boxes);
      await d.create("vm-df53-fill-emitbug");
      const err = await rejection(
        fillRun(d, "vm-df53-fill-emitbug", [{ path: "a.txt", content: "one\n" }], {
          recordAuditLink: () => {
            throw new TypeError("Do not know how to serialize a BigInt");
          },
          runId: "df53-fill-emitbug-run",
          requestId: "req-fill",
          repoSlug: "qds/demo",
        }),
      );
      expect(err).toBeInstanceOf(TypeError);
      expect(err).not.toBeInstanceOf(FillError);
    } finally {
      rmSync(boxes, { recursive: true, force: true });
    }
  });
});

// listingProvesTag: FakeDriver's metadata carries the ownership tag it was
// created with, so its listing PROVES tags — the contract's reap step takes the
// destroy arm here (T2-5: declared per driver, not inferred from one run).
runDriverContract({ driverName: "fake", makeDriver: () => resolveDriver("fake"), listingProvesTag: true });
