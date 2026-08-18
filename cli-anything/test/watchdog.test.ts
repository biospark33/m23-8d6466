/**
 * RSS watchdog tests (DF1.6 T4).
 *
 * Tests cover:
 * - Aggregate RSS sampling on real process groups
 * - Threshold escalation (SIGTERM → grace → SIGKILL)
 * - Unwatchable path (sampler returns null 3x consecutively — W4)
 * - Tree exits during grace (no SIGKILL)
 * - Escalated grace period behavior (W1: SIGKILL leg survives stop())
 * - Kill origin tracking
 * - Default constants
 */

import { afterEach, beforeAll, describe, expect, it } from "bun:test";
import { spawn, type ChildProcess } from "node:child_process";
import { join } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import {
  DEFAULT_POLL_MS,
  DEFAULT_THRESHOLD_BYTES,
  WATCHDOG_GRACE_MS,
  startRssWatchdog,
} from "../src/watchdog.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Every detached child the suite spawns, killed group-wide in afterEach.
 * Without this, any test that stops the watchdog before escalation leaves a
 * `sleep 10` (and its group) running for the rest of the suite's lifetime.
 */
const spawned: ChildProcess[] = [];
function trackChild(child: ChildProcess): ChildProcess {
  spawned.push(child);
  return child;
}
afterEach(() => {
  for (const child of spawned) {
    if (child.pid !== undefined) {
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        try {
          process.kill(child.pid, "SIGKILL");
        } catch {
          // already gone
        }
      }
    }
  }
  spawned.length = 0;
});

describe("watchdog constants", () => {
  it("exports default poll interval of 200ms", () => {
    expect(DEFAULT_POLL_MS).toBe(200);
  });

  it("exports default threshold of 4 GB", () => {
    expect(DEFAULT_THRESHOLD_BYTES).toBe(4 * 1024 ** 3);
  });

  it("exports grace period of 5000ms", () => {
    expect(WATCHDOG_GRACE_MS).toBe(5000);
  });
});

describe("watchdog validation guards (wave-1)", () => {
  it("thresholdBytes=0 warns and uses default", () => {
    const logs: string[] = [];
    const handle = startRssWatchdog({
      child: trackChild(spawn("sleep", ["10"], { detached: true, stdio: "ignore" })),
      pgidOrGroup: process.pid,
      thresholdBytes: 0,
      onEscalate: () => {},
      onUnwatchable: () => {},
      log: (msg) => logs.push(msg),
      sampleRss: async () => 100 * 1024 ** 2,
    });

    expect(logs.some((l) => l.includes("invalid thresholdBytes") && l.includes("0"))).toBe(true);
    handle.stop();
  });

  it("thresholdBytes=-1 warns and uses default", () => {
    const logs: string[] = [];
    const handle = startRssWatchdog({
      child: trackChild(spawn("sleep", ["10"], { detached: true, stdio: "ignore" })),
      pgidOrGroup: process.pid,
      thresholdBytes: -1,
      onEscalate: () => {},
      onUnwatchable: () => {},
      log: (msg) => logs.push(msg),
      sampleRss: async () => 100 * 1024 ** 2,
    });

    expect(logs.some((l) => l.includes("invalid thresholdBytes") && l.includes("-1"))).toBe(true);
    handle.stop();
  });

  it("thresholdBytes=NaN warns and uses default", () => {
    const logs: string[] = [];
    const handle = startRssWatchdog({
      child: trackChild(spawn("sleep", ["10"], { detached: true, stdio: "ignore" })),
      pgidOrGroup: process.pid,
      thresholdBytes: Number.NaN,
      onEscalate: () => {},
      onUnwatchable: () => {},
      log: (msg) => logs.push(msg),
      sampleRss: async () => 100 * 1024 ** 2,
    });

    expect(logs.some((l) => l.includes("invalid thresholdBytes") && l.includes("NaN"))).toBe(true);
    handle.stop();
  });

  it("pollMs=0 warns and uses default", () => {
    const logs: string[] = [];
    const handle = startRssWatchdog({
      child: trackChild(spawn("sleep", ["10"], { detached: true, stdio: "ignore" })),
      pgidOrGroup: process.pid,
      pollMs: 0,
      onEscalate: () => {},
      onUnwatchable: () => {},
      log: (msg) => logs.push(msg),
      sampleRss: async () => 100 * 1024 ** 2,
    });

    expect(logs.some((l) => l.includes("invalid pollMs") && l.includes("0"))).toBe(true);
    handle.stop();
  });

  it("pollMs=-1 warns and uses default", () => {
    const logs: string[] = [];
    const handle = startRssWatchdog({
      child: trackChild(spawn("sleep", ["10"], { detached: true, stdio: "ignore" })),
      pgidOrGroup: process.pid,
      pollMs: -1,
      onEscalate: () => {},
      onUnwatchable: () => {},
      log: (msg) => logs.push(msg),
      sampleRss: async () => 100 * 1024 ** 2,
    });

    expect(logs.some((l) => l.includes("invalid pollMs") && l.includes("-1"))).toBe(true);
    handle.stop();
  });

  it("graceMs=NaN warns and uses default", () => {
    const logs: string[] = [];
    const handle = startRssWatchdog({
      child: trackChild(spawn("sleep", ["10"], { detached: true, stdio: "ignore" })),
      pgidOrGroup: process.pid,
      graceMs: Number.NaN,
      onEscalate: () => {},
      onUnwatchable: () => {},
      log: (msg) => logs.push(msg),
      sampleRss: async () => 100 * 1024 ** 2,
    });

    expect(logs.some((l) => l.includes("invalid graceMs") && l.includes("NaN"))).toBe(true);
    handle.stop();
  });

  it("undefined values use defaults silently (no warning)", () => {
    const logs: string[] = [];
    const handle = startRssWatchdog({
      child: trackChild(spawn("sleep", ["10"], { detached: true, stdio: "ignore" })),
      pgidOrGroup: process.pid,
      onEscalate: () => {},
      onUnwatchable: () => {},
      log: (msg) => logs.push(msg),
      sampleRss: async () => 100 * 1024 ** 2,
    });

    // No warnings for undefined (they take the default via destructuring)
    expect(logs.filter((l) => l.includes("invalid")).length).toBe(0);
    handle.stop();
  });
});

describe("RSS watchdog", () => {
  // Detect perl availability for SIGTERM-ignore tests
  let perlAvailable = false;
  beforeAll(async () => {
    const result = await new Promise<{ exitCode: number | null }>((resolve) => {
      const proc = spawn("perl", ["--version"], { stdio: "ignore" });
      proc.on("exit", (code) => resolve({ exitCode: code }));
      proc.on("error", () => resolve({ exitCode: -1 }));
    });
    perlAvailable = result.exitCode === 0;
  });
  it("returns running status immediately after start", async () => {
    const logs: string[] = [];
    const handle = startRssWatchdog({
      child: trackChild(spawn("sleep", ["10"], { detached: true, stdio: "ignore" })),
      pgidOrGroup: process.pid,
      thresholdBytes: DEFAULT_THRESHOLD_BYTES,
      pollMs: 50,
      onEscalate: () => {},
      onUnwatchable: () => {},
      log: (msg) => logs.push(msg),
      // Override sampler to never exceed threshold
      sampleRss: async () => 100 * 1024 ** 2, // 100 MB
    });

    expect(handle.status).toBe("running");
    handle.stop();
  });

  it("returns stopped status after stop (no escalation)", () => {
    const handle = startRssWatchdog({
      child: trackChild(spawn("sleep", ["10"], { detached: true, stdio: "ignore" })),
      pgidOrGroup: process.pid,
      onEscalate: () => {},
      onUnwatchable: () => {},
      log: () => {},
      sampleRss: async () => 100 * 1024 ** 2,
    });

    handle.stop();
    expect(handle.status).toBe("stopped");
  });

  it("R9: stop() after escalation reports stopped (not running); killOrigin preserved", async () => {
    const child = trackChild(spawn("sleep", ["10"], { detached: true, stdio: "ignore" }));
    let escalated = false;
    const handle = startRssWatchdog({
      child,
      pgidOrGroup: child.pid!, // escalation SIGTERMs the sleep's group, not ours
      thresholdBytes: DEFAULT_THRESHOLD_BYTES,
      pollMs: 20,
      graceMs: 60_000, // keep the SIGKILL leg far away; only the status matters here
      onEscalate: () => { escalated = true; },
      onUnwatchable: () => {},
      log: () => {},
      sampleRss: async () => DEFAULT_THRESHOLD_BYTES + 1, // always over
    });
    // P6a: poll bounded (2s cap) for escalation evidence before proceeding
    const startedAt = Date.now();
    while (!escalated && Date.now() - startedAt < 2000) {
      await sleep(10);
    }
    expect(escalated).toBe(true); // prove escalation fired
    handle.stop();
    expect(handle.status).toBe("stopped"); // was left "running" before R9
    expect(handle.killOrigin).toBe("watchdog");
  });

  it("R9: sampler rejection landing after stop() does not count toward unwatchable", async () => {
    let calls = 0;
    let rejectThird: ((err: Error) => void) | undefined;
    let unwatchableReported = false;
    // Deterministic handshake: resolved inside the third sampler invocation,
    // synchronously after rejectThird is assigned. A fixed sleep could let
    // handle.stop() run before the third invocation even happened, leaving
    // rejectThird undefined — the late rejection would never fire and the
    // test would pass without exercising the post-stop path at all.
    let signalThirdInvoked!: () => void;
    const thirdInvoked = new Promise<void>((resolve) => { signalThirdInvoked = resolve; });
    const handle = startRssWatchdog({
      child: trackChild(spawn("sleep", ["10"], { detached: true, stdio: "ignore" })),
      pgidOrGroup: process.pid,
      pollMs: 20,
      onEscalate: () => {},
      onUnwatchable: () => { unwatchableReported = true; },
      log: () => {},
      sampleRss: () => {
        calls++;
        if (calls <= 2) return Promise.reject(new Error("fail"));
        const pending = new Promise<number | null>((_resolve, reject) => {
          rejectThird = reject;
        });
        signalThirdInvoked();
        return pending;
      },
    });
    // Two consecutive rejections land (failures 1/2 — the poll loop awaits
    // each sample before scheduling the next, so the third invocation cannot
    // start before both are counted), then the third sampler call stays
    // pending while we stop the watchdog, and ONLY THEN rejects — without
    // the catch-path running-guard this would be failure 3/3: onUnwatchable
    // fires and "unwatchable" overwrites the terminal status.
    await thirdInvoked; // third sampler invocation has assigned rejectThird
    expect(calls).toBe(3);
    handle.stop();
    // Ensure stop() processed (microtask flush) before rejection
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(handle.status).toBe("stopped");
    expect(rejectThird).toBeDefined();
    rejectThird!(new Error("late boom"));
    // Flush macrotasks to ensure any late handlers ran
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(handle.status).toBe("stopped");
    expect(unwatchableReported).toBe(false);
  });

  it("R9: throwing log/onEscalate callbacks do not abort the SIGTERM escalation flow", async () => {
    const child = trackChild(spawn("sleep", ["10"], { detached: true, stdio: "ignore" }));
    const exited = new Promise<void>((resolve) => {
      child.on("exit", () => resolve());
    });
    const handle = startRssWatchdog({
      child,
      pgidOrGroup: child.pid!, // escalation signals THIS group
      thresholdBytes: 1,
      pollMs: 20,
      graceMs: 60_000,
      onEscalate: () => { throw new Error("callback boom"); },
      onUnwatchable: () => {},
      log: () => { throw new Error("log boom"); },
      sampleRss: async () => 1024 ** 3,
    });
    const exitedWithin = await Promise.race([
      exited.then(() => true),
      sleep(3_000).then(() => false),
    ]);
    expect(exitedWithin).toBe(true); // group SIGTERM still delivered
    expect(handle.killOrigin).toBe("watchdog");
  });

  it("returns null killOrigin when never escalated", () => {
    const handle = startRssWatchdog({
      child: trackChild(spawn("sleep", ["10"], { detached: true, stdio: "ignore" })),
      pgidOrGroup: process.pid,
      onEscalate: () => {},
      onUnwatchable: () => {},
      log: () => {},
      sampleRss: async () => 100 * 1024 ** 2,
    });

    expect(handle.killOrigin).toBeNull();
    handle.stop();
  });

  it("samples RSS at the configured poll interval", async () => {
    let sampleCount = 0;
    const handle = startRssWatchdog({
      child: trackChild(spawn("sleep", ["10"], { detached: true, stdio: "ignore" })),
      pgidOrGroup: process.pid,
      pollMs: 50,
      onEscalate: () => {},
      onUnwatchable: () => {},
      log: () => {},
      sampleRss: async () => {
        sampleCount++;
        return 100 * 1024 ** 2;
      },
    });

    await sleep(350); // Order-of-magnitude bounds, not exact (CI load variance)
    handle.stop();
    expect(sampleCount).toBeGreaterThanOrEqual(1);
    // Defensible ceiling: 350ms / 50ms poll = 7 polls max, CI load adds ~1-2
    expect(sampleCount).toBeLessThan(10);
  });

  it("does NOT escalate when RSS exactly equals thresholdBytes (source uses `>` not `>=`)", async () => {
    let escalated = false;
    const handle = startRssWatchdog({
      child: trackChild(spawn("sleep", ["10"], { detached: true, stdio: "ignore" })),
      pgidOrGroup: process.pid,
      thresholdBytes: 500 * 1024 ** 2, // 500 MB
      pollMs: 50,
      onEscalate: () => { escalated = true; },
      onUnwatchable: () => {},
      log: () => {},
      // Sample returns exactly the threshold — should NOT escalate
      sampleRss: async () => 500 * 1024 ** 2,
    });

    await sleep(150); // Multiple polls
    handle.stop();

    expect(escalated).toBe(false);
    expect(handle.killOrigin).toBeNull();
  });

  it("escalates when RSS exceeds threshold", async () => {
    const logs: string[] = [];
    let escalated = false;
    const escalateInfo: { rssBytes: number; samples: number }[] = [];

    // Spawn a proper child process with its own process group
    const child = trackChild(spawn("sleep", ["10"], { detached: true, stdio: "ignore" }));
    const pgid = child.pid!; // With detached:true, child.pid is the PGID

    const handle = startRssWatchdog({
      child,
      pgidOrGroup: pgid,
      thresholdBytes: 500 * 1024 ** 2, // 500 MB
      pollMs: 50,
      graceMs: 100,
      onEscalate: (info) => {
        escalated = true;
        escalateInfo.push(info);
      },
      onUnwatchable: () => {},
      log: (msg) => logs.push(msg),
      sampleRss: async () => 600 * 1024 ** 2, // 600 MB — over threshold
    });

    // P7: poll bounded (2s cap) for escalation evidence before asserting
    const startedAt = Date.now();
    while (!escalated && Date.now() - startedAt < 2000) {
      await sleep(10);
    }
    expect(escalated).toBe(true); // prove escalation fired
    // Note: regular `sleep` dies to SIGTERM immediately, so we don't assert "alive within grace"
    // (unlike the SIGTERM-ignoring perl tests). The escalation evidence above is sufficient.
    handle.stop();

    expect(escalateInfo).toHaveLength(1);
    expect(escalateInfo[0]!.rssBytes).toBe(600 * 1024 ** 2);
    expect(escalateInfo[0]!.samples).toBeGreaterThanOrEqual(1);
    expect(handle.killOrigin).toBe("watchdog");
    expect(logs.some((l) => l.includes("RSS watchdog escalation"))).toBe(true);

    // Cleanup
    try {
      process.kill(-pgid, "SIGKILL");
    } catch {}
  }, 5000); // Explicit 5s timeout

  it.skipIf(!perlAvailable)("SIGTERMs the process group on escalation — validates signal delivery", async () => {
    // Use a perl process that ignores SIGTERM to verify escalation
    // Perl sets SIGTERM to IGNORE, so the process survives the SIGTERM
    const child = trackChild(spawn("perl", ["-e", '$SIG{TERM}="IGNORE"; sleep 100'], {
      detached: true,
      stdio: "ignore",
    }));
    const pgid = child.pid!;

    await sleep(300); // Let perl boot and install the handler

    let escalated = false;
    let escalatedInfo: { rssBytes: number; samples: number } | null = null;

    const handle = startRssWatchdog({
      child,
      pgidOrGroup: pgid,
      thresholdBytes: 1,
      pollMs: 50,
      graceMs: 500,
      onEscalate: (info) => {
        escalated = true;
        escalatedInfo = info;
      },
      onUnwatchable: () => {},
      log: () => {},
      sampleRss: async () => 10 * 1024 ** 2,
    });

    await sleep(150); // Time for escalation
    handle.stop();

    // Assert escalation callback fired
    expect(escalated).toBe(true);
    expect(handle.killOrigin).toBe("watchdog");
    expect(escalatedInfo).not.toBeNull();

    // Verify the process is still alive (proving SIGTERM was delivered but ignored)
    let alive = false;
    try {
      process.kill(-pgid, 0);
      alive = true;
    } catch {
      alive = false;
    }
    // Process should still be alive because SIGTERM was ignored
    expect(alive).toBe(true);

    // Cleanup
    try {
      process.kill(-pgid, "SIGKILL");
    } catch {}
  });

  it.skipIf(!perlAvailable)("stopped during grace WITHOUT escalation → no SIGKILL, status becomes stopped", async () => {
    // Stop the watchdog before it ever escalates — it should cleanly
    // stop and the group should survive.
    const child = trackChild(spawn("perl", ["-e", '$SIG{TERM}="IGNORE"; sleep 100'], {
      detached: true,
      stdio: "ignore",
    }));
    const pgid = child.pid!;

    await sleep(300); // Let perl boot and install the TERM handler

    const handle = startRssWatchdog({
      child,
      pgidOrGroup: pgid,
      thresholdBytes: 10 * 1024 ** 3, // 10 GB — high threshold to avoid escalation
      pollMs: 50,
      graceMs: 200,
      onEscalate: () => {},
      onUnwatchable: () => {},
      log: () => {},
      // Start below threshold, never escalate (100 MB << 10 GB)
      sampleRss: async () => 100 * 1024 ** 2,
    });

    await sleep(100); // Some polling happened, but no escalation yet
    handle.stop(); // Stop BEFORE any escalation
    expect(handle.status).toBe("stopped");
    expect(handle.killOrigin).toBeNull();

    await sleep(100); // Group should still be alive (no SIGTERM sent)
    let alive = false;
    try {
      process.kill(-pgid, 0);
      alive = true;
    } catch {
      alive = false;
    }
    expect(alive).toBe(true);

    // Cleanup
    try {
      process.kill(-pgid, "SIGKILL");
    } catch {}
  }, 5000);

  it.skipIf(!perlAvailable)("escalated grace timer SIGKILLs the group if still alive (W1 invariant)", async () => {
    // W1: After escalation, the grace timer checks PROCESS GROUP liveness.
    // If group is alive after grace → SIGKILL. If group is gone → clean return.
    // This test verifies the SIGKILL actually fires when the group survives.
    const child = trackChild(spawn("perl", ["-e", '$SIG{TERM}="IGNORE"; sleep 100'], {
      detached: true,
      stdio: "ignore",
    }));
    const pgid = child.pid!;

    await sleep(300); // Let perl boot and install the TERM handler

    const handle = startRssWatchdog({
      child,
      pgidOrGroup: pgid,
      thresholdBytes: 1, // Trigger immediately
      pollMs: 50,
      graceMs: 100, // Short grace for fast test
      onEscalate: () => {},
      onUnwatchable: () => {},
      log: (msg) => {
        if (msg.includes("SIGKILL")) {
          console.log("[TEST] SIGKILL logged");
        }
      },
      sampleRss: async () => 10 * 1024 ** 2, // 10 MB — over threshold
    });

    // Wait for escalation + SIGTERM + grace expiry + SIGKILL
    await sleep(300);

    // The leader ignores SIGTERM, but SIGKILL cannot be ignored
    let alive = false;
    try {
      process.kill(-pgid, 0);
      alive = true;
    } catch {
      alive = false;
    }
    expect(alive).toBe(false); // SIGKILL fired and killed the group
    expect(handle.killOrigin).toBe("watchdog");

    // Cleanup (idempotent)
    try {
      process.kill(-pgid, "SIGKILL");
    } catch {}
  }, 5000);

  it.skipIf(!perlAvailable)("escalated grace timer returns cleanly if group already gone", async () => {
    // W1: If the process group exits during grace (e.g., lead honored SIGTERM),
    // the grace timer checks group liveness and returns without SIGKILL.
    const child = trackChild(spawn("perl", ["-e", '$SIG{TERM}="IGNORE"; exec("sleep 0.01")'], {
      // perl ignores SIGTERM but the exec'd sleep inherits the default disposition
      // and exits immediately on SIGTERM, taking the group with it.
      detached: true,
      stdio: "ignore",
    }));
    const pgid = child.pid!;

    await sleep(200); // Let perl boot and exec

    const handle = startRssWatchdog({
      child,
      pgidOrGroup: pgid,
      thresholdBytes: 1,
      pollMs: 50,
      graceMs: 100,
      onEscalate: () => {},
      onUnwatchable: () => {},
      log: (msg) => {
        if (msg.includes("SIGKILL")) {
          console.log("[TEST] Unexpected SIGKILL logged");
        }
      },
      sampleRss: async () => 10 * 1024 ** 2,
    });

    // Wait for escalation, SIGTERM, group exit, grace expiry
    await sleep(300);

    // Group should be gone (cleanly exited via SIGTERM)
    let alive = false;
    try {
      process.kill(-pgid, 0);
      alive = true;
    } catch {
      alive = false;
    }
    expect(alive).toBe(false); // Group gone (clean exit, not SIGKILL)
    // Note: killOrigin may be "watchdog" if SIGTERM was delivered before group exited,
    // or null if group exited before SIGTERM delivery. Either is acceptable here.
    expect(handle.killOrigin === null || handle.killOrigin === "watchdog").toBe(true);

    // Cleanup (idempotent)
    try {
      process.kill(-pgid, "SIGKILL");
    } catch {}
  }, 5000);

  it("reports unwatchable after 3 consecutive sampler failures (W4)", async () => {
    const logs: string[] = [];
    let unwatchableCalled = false;
    const unwatchableReasons: string[] = [];

    const handle = startRssWatchdog({
      child: trackChild(spawn("sleep", ["10"], { detached: true, stdio: "ignore" })),
      pgidOrGroup: process.pid,
      pollMs: 50,
      onEscalate: () => {},
      onUnwatchable: (reason) => {
        unwatchableCalled = true;
        unwatchableReasons.push(reason);
      },
      log: (msg) => logs.push(msg),
      sampleRss: async () => null, // Simulate ps failure
    });

    // W4: External sampler needs 3 consecutive failures for unwatchable
    // BC12: bounded poll-until-flag loop (~2s cap) instead of blind sleep
    const startedAt = Date.now();
    while (!unwatchableCalled && Date.now() - startedAt < 2000) {
      await sleep(10);
    }
    expect(unwatchableCalled).toBe(true); // prove unwatchable was reported
    handle.stop();

    expect(unwatchableReasons).toHaveLength(1);
    expect(unwatchableReasons[0]).toMatch(/3.*consecutive/i);
    expect(handle.status).toBe("unwatchable");
    expect(handle.killOrigin).toBeNull();
  });

  it("logs reason when becoming unwatchable after 3 consecutive failures", async () => {
    const logs: string[] = [];

    const handle = startRssWatchdog({
      child: trackChild(spawn("sleep", ["10"], { detached: true, stdio: "ignore" })),
      pgidOrGroup: process.pid,
      pollMs: 50,
      onEscalate: () => {},
      onUnwatchable: () => {},
      log: (msg) => logs.push(msg),
      sampleRss: async () => null,
    });

    await sleep(200); // 3+ failures at 50ms interval
    handle.stop();

    expect(logs.some((l) => l.includes("unwatchable"))).toBe(true);
    expect(logs.some((l) => l.includes("3 consecutive"))).toBe(true);
  });

  it("does NOT report unwatchable after 1-2 failures (W4)", async () => {
    let unwatchableCalled = false;
    let sampleCount = 0;

    const handle = startRssWatchdog({
      child: trackChild(spawn("sleep", ["10"], { detached: true, stdio: "ignore" })),
      pgidOrGroup: process.pid,
      pollMs: 50,
      onEscalate: () => {},
      onUnwatchable: () => {
        unwatchableCalled = true;
      },
      log: () => {},
      // Fail twice, then succeed
      sampleRss: async () => {
        sampleCount++;
        // First 2 calls fail (null), then succeed
        if (sampleCount < 3) return null;
        return 100 * 1024 ** 2;
      },
    });

    // Sleep for < 3 poll intervals (should be 2 failures max)
    await sleep(100);
    handle.stop();

    expect(unwatchableCalled).toBe(false);
  });

  it("sampler returns null twice then breach value → escalation wins (W4)", async () => {
    // Two null returns (below unwatchable threshold) followed by a breach:
    // escalation should fire because the nulls were just temporary failures,
    // not the 3-consecutive threshold that triggers unwatchable.
    let escalated = false;
    let sampleCount = 0;

    const child = trackChild(spawn("sleep", ["10"], { detached: true, stdio: "ignore" }));
    const pgid = child.pid!;

    const handle = startRssWatchdog({
      child,
      pgidOrGroup: pgid,
      thresholdBytes: 500 * 1024 ** 2, // 500 MB
      pollMs: 50,
      graceMs: 100,
      onEscalate: () => { escalated = true; },
      onUnwatchable: () => {},
      log: () => {},
      sampleRss: async () => {
        sampleCount++;
        if (sampleCount < 3) return null; // Two nulls (not enough for unwatchable)
        return 600 * 1024 ** 2; // Then breach
      },
    });

    await sleep(200); // Time for 3+ polls
    handle.stop();

    expect(escalated).toBe(true);
    expect(handle.killOrigin).toBe("watchdog");

    // Cleanup
    try {
      process.kill(-pgid, "SIGKILL");
    } catch {}
  }, 5000);

  it("stop() called DURING grace window → SIGKILL leg still fires (W1)", async () => {
    // Verify that once escalated, the SIGKILL leg survives stop() — the
    // watchdog must clean up even if the runner calls stop() during grace.
    const child = trackChild(spawn("sleep", ["10"], { detached: true, stdio: "ignore" }));
    const pgid = child.pid!;
    let escalated = false;

    const handle = startRssWatchdog({
      child,
      pgidOrGroup: pgid,
      thresholdBytes: 1,
      pollMs: 50,
      graceMs: 200,
      onEscalate: () => { escalated = true; },
      onUnwatchable: () => {},
      log: () => {},
      sampleRss: async () => 10 * 1024 ** 2,
    });

    // Wait for escalation
    await sleep(100);
    expect(escalated).toBe(true);

    // Call stop() DURING grace window — SIGKILL should still fire
    handle.stop();

    // Wait past grace period — SIGKILL should have fired
    await sleep(150);

    let alive = false;
    try {
      process.kill(-pgid, 0);
      alive = true;
    } catch {
      alive = false;
    }
    // Process should be dead (SIGKILL fired despite stop())
    expect(alive).toBe(false);
    expect(handle.killOrigin).toBe("watchdog");

    // Cleanup (idempotent)
    try {
      process.kill(-pgid, "SIGKILL");
    } catch {}
  }, 5000);

  it("after stop(), polling actually stops — sample count frozen", async () => {
    let sampleCount = 0;
    const handle = startRssWatchdog({
      child: trackChild(spawn("sleep", ["10"], { detached: true, stdio: "ignore" })),
      pgidOrGroup: process.pid,
      pollMs: 50,
      onEscalate: () => {},
      onUnwatchable: () => {},
      log: () => {},
      sampleRss: async () => {
        sampleCount++;
        return 100 * 1024 ** 2;
      },
    });

    await sleep(150); // Some polling happens
    handle.stop();
    const countAtStop = sampleCount;

    // BC8: frozen window check — wait ≥ 2× pollMs, assert count did not increase
    await sleep(100); // 2× 50ms = 100ms
    expect(sampleCount).toBe(countAtStop);
  });

  it("uses external sampler when provided", async () => {
    let externalSamplerCalled = false;
    const customSample = async (): Promise<number | null> => {
      externalSamplerCalled = true;
      return 200 * 1024 ** 2;
    };

    const handle = startRssWatchdog({
      child: trackChild(spawn("sleep", ["10"], { detached: true, stdio: "ignore" })),
      pgidOrGroup: process.pid,
      pollMs: 50,
      onEscalate: () => {},
      onUnwatchable: () => {},
      log: () => {},
      sampleRss: customSample,
    });

    await sleep(75);
    handle.stop();

    expect(externalSamplerCalled).toBe(true);
  });

  it("T8: external sampler failure counter resets on VALID sample (3 consecutive required)", async () => {
    // Source resets both consecutiveSampleFailures and externalSamplerFailures
    // on success (the counter-reset block at the top of poll()'s success path
    // in watchdog.ts). Inject pattern: fail, fail, VALID,
    // then stop before 3 consecutive failures accumulate. Unwatchable NEVER fires
    // because the VALID sample reset the counter.
    let sampleCount = 0;
    let unwatchableCalled = false;

    const handle = startRssWatchdog({
      child: trackChild(spawn("sleep", ["10"], { detached: true, stdio: "ignore" })),
      pgidOrGroup: process.pid,
      pollMs: 50, // Slower polls for cleaner timing (less variance in sample count)
      onEscalate: () => {},
      onUnwatchable: () => { unwatchableCalled = true; },
      log: () => {},
      sampleRss: async () => {
        sampleCount++;
        // Pattern: fail, fail, VALID (under threshold), then stop
        // After VALID resets counter, we stop BEFORE 3 consecutive failures can accumulate
        if (sampleCount <= 2) return null; // First 2 failures
        if (sampleCount === 3) return 100 * 1024 ** 2; // VALID (100 MB << 4 GB threshold)
        // After reset, return valid values to avoid ever hitting 3 consecutive failures
        return 100 * 1024 ** 2;
      },
    });

    // Sleep for exactly 3 samples: fail, fail, VALID at 50ms intervals = 150ms minimum
    // Use 200ms for headroom — we should have exactly 3 samples (variance: 4 max)
    await sleep(200);
    handle.stop();

    // Should have sampled 3-4 times (fail, fail, VALID, maybe one more)
    expect(sampleCount).toBeGreaterThanOrEqual(3);
    expect(sampleCount).toBeLessThan(6);
    // Unwatchable NEVER fired — the VALID sample reset the counter
    expect(unwatchableCalled).toBe(false);
    expect(handle.status).toBe("stopped");
    expect(handle.killOrigin).toBeNull();
  });

  it("stops polling after escalation", async () => {
    let sampleCount = 0;
    let escalated = false;

    const child = trackChild(spawn("sleep", ["10"], { detached: true, stdio: "ignore" }));
    const pgid = child.pid!;

    const handle = startRssWatchdog({
      child,
      pgidOrGroup: pgid,
      thresholdBytes: 1,
      pollMs: 50,
      graceMs: 100,
      onEscalate: () => {
        escalated = true;
      },
      onUnwatchable: () => {},
      log: () => {},
      sampleRss: async () => {
        sampleCount++;
        return 10 * 1024 ** 2;
      },
    });

    await sleep(150);
    const countAtEscalation = sampleCount;
    // Sleep well past the escalation point
    await sleep(300);
    handle.stop();
    const countAtStop = sampleCount;

    expect(escalated).toBe(true);
    // sampleCount should NOT have grown significantly after escalation
    // (max ~3-4 samples before escalation at 50ms interval)
    expect(sampleCount).toBeLessThan(10);
    expect(sampleCount).toBe(countAtEscalation);

    // BC9: follow-up window after stop — assert sampling stopped (post-escalation behavior)
    await sleep(100); // 2× pollMs = 100ms
    expect(sampleCount).toBe(countAtStop); // frozen after stop

    // Cleanup
    try {
      process.kill(-pgid, "SIGKILL");
    } catch {}
  }, 5000);

  // Integration test with real process group
  // Note: These tests are kept simple to avoid hangs in CI environments
  describe.skipIf(process.platform === "win32")("real process group sampling", () => {
    it("samples aggregate RSS from a real process group", async () => {
      // Create a process group with a child
      const child = trackChild(spawn("sleep", ["1"], {
        detached: true,
        stdio: "ignore",
      }));

      const pgid = child.pid!;
      const samples: number[] = [];
      const errors: string[] = [];

      const handle = startRssWatchdog({
        child,
        pgidOrGroup: pgid,
        thresholdBytes: DEFAULT_THRESHOLD_BYTES,
        pollMs: 50,
        onEscalate: () => {},
        // Record-and-assert instead of throw (BT9)
        onUnwatchable: (reason) => {
          errors.push(reason);
        },
        log: () => {},
        // Collect samples to verify they're positive
        sampleRss: async () => {
          const result = await new Promise<number | null>((resolve) => {
            const { execFile } = require("node:child_process");
            execFile("ps", ["-o", "rss=", "-g", String(pgid)], (err: Error | null, stdout: Buffer) => {
              if (err) return resolve(null);
              const lines = stdout.toString().trim().split(/\s+/);
              let sumKb = 0;
              for (const line of lines) {
                const kb = Number.parseInt(line, 10);
                if (Number.isFinite(kb)) sumKb += kb;
              }
              resolve(sumKb * 1024);
            });
          });
          if (result !== null) samples.push(result);
          return result;
        },
      });

      await sleep(150);
      handle.stop();

      // Should have at least one successful sample
      expect(samples.length).toBeGreaterThan(0);
      // All samples should be positive
      for (const s of samples) {
        expect(s).toBeGreaterThan(0);
      }
      // No unwatchable errors (platform note: Linux ps -g selects by session, not pgid;
      // this test passes on darwin where -g means process group)
      expect(errors).toHaveLength(0);
    });
  });
});
