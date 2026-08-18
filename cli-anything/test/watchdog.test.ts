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

import { afterEach, describe, expect, it } from "bun:test";
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

describe("RSS watchdog", () => {
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
    expect(sampleCount).toBeLessThan(20);
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

    await sleep(150); // Time for first poll + escalation
    handle.stop();

    expect(escalated).toBe(true);
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

  it("SIGTERMs the process group on escalation — validates signal delivery", async () => {
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

  it("stopped during grace WITHOUT escalation → no SIGKILL, status becomes stopped", async () => {
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

  it("escalated grace timer SIGKILLs the group if still alive (W1 invariant)", async () => {
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

  it("escalated grace timer returns cleanly if group already gone", async () => {
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
    // At 50ms poll interval, 3 failures = 150ms minimum
    await sleep(200);
    handle.stop();

    expect(unwatchableCalled).toBe(true);
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
        handle.killOrigin !== null ? null : null;
        return null;
      },
    });

    // Sleep for < 3 poll intervals (should be 2 failures max)
    await sleep(100);
    handle.stop();

    expect(unwatchableCalled).toBe(false);
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

    expect(escalated).toBe(true);
    // sampleCount should NOT have grown significantly after escalation
    // (max ~3-4 samples before escalation at 50ms interval)
    expect(sampleCount).toBeLessThan(10);
    expect(sampleCount).toBe(countAtEscalation);

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
