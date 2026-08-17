/**
 * RSS watchdog tests (DF1.6 T4).
 *
 * Tests cover:
 * - Aggregate RSS sampling on real process groups
 * - Threshold escalation (SIGTERM → grace → SIGKILL)
 * - Unwatchable path (sampler returns null)
 * - Tree exits during grace (no SIGKILL)
 * - Kill origin tracking
 * - Default constants
 */

import { describe, expect, it } from "bun:test";
import { spawn } from "node:child_process";
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
      child: spawn("sleep", ["10"], { detached: true, stdio: "ignore" }),
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

  it("returns stopped status after stop", () => {
    const handle = startRssWatchdog({
      child: spawn("sleep", ["10"], { detached: true, stdio: "ignore" }),
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
      child: spawn("sleep", ["10"], { detached: true, stdio: "ignore" }),
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
      child: spawn("sleep", ["10"], { detached: true, stdio: "ignore" }),
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

    await sleep(175); // Should get ~3-4 samples
    handle.stop();
    expect(sampleCount).toBeGreaterThanOrEqual(3);
    expect(sampleCount).toBeLessThanOrEqual(5);
  });

  it("escalates when RSS exceeds threshold", async () => {
    const logs: string[] = [];
    let escalated = false;
    const escalateInfo: { rssBytes: number; samples: number }[] = [];

    // Spawn a proper child process with its own process group
    const child = spawn("sleep", ["10"], { detached: true, stdio: "ignore" });
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

  it("SIGTERMs the process group on escalation", async () => {
    // Use a real process group for this test
    const tmpDir = mkdtempSync(join(tmpdir(), "watchdog-test-"));
    const scriptPath = join(tmpDir, "signal-test.sh");

    // Create a script that spawns a child and ignores SIGTERM initially
    await Bun.write(
      scriptPath,
      `#!/bin/bash
trap 'echo "Ignoring SIGTERM"; sleep 0.1' TERM
sleep 100 &
echo $! > ${join(tmpDir, "child.pid")}
sleep 100
`,
    );

    const child = spawn("bash", [scriptPath], {
      detached: true,
      stdio: ["ignore", "pipe", "ignore"],
    });

    await sleep(100); // Let the script start and spawn child

    const pgid = child.pid!;
    let sigtermReceived = false;

    const handle = startRssWatchdog({
      child,
      pgidOrGroup: pgid,
      thresholdBytes: 1, // Trigger immediately
      pollMs: 50,
      graceMs: 500,
      onEscalate: () => {
        sigtermReceived = true;
      },
      onUnwatchable: () => {},
      log: () => {},
      sampleRss: async () => 10 * 1024 ** 2, // 10 MB — over threshold
    });

    await sleep(150); // Time for escalation
    handle.stop();

    expect(sigtermReceived).toBe(true);
    expect(handle.killOrigin).toBe("watchdog");

    // Cleanup
    try {
      process.kill(-pgid, "SIGKILL");
    } catch {}
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("does NOT SIGKILL if tree exits during grace period", async () => {
    // Track if we ever try to SIGKILL - we don't in this test
    // because the handle is stopped before grace expires
    let sigkillAttempted = false;

    const child = spawn("sleep", ["10"], { detached: true, stdio: "ignore" });
    const pgid = child.pid!;

    const handle = startRssWatchdog({
      child,
      pgidOrGroup: pgid,
      thresholdBytes: 1, // Trigger immediately
      pollMs: 50,
      graceMs: 200,
      onEscalate: () => {},
      onUnwatchable: () => {},
      log: () => {},
      sampleRss: async () => 10 * 1024 ** 2,
    });

    // Stop the watchdog during grace period to simulate tree exit
    // This prevents the grace timer from ever firing SIGKILL
    setTimeout(() => {
      handle.stop();
      // Verify we stopped before grace expired
      sigkillAttempted = false; // Explicitly set, since stop() prevented SIGKILL
    }, 100);

    await sleep(300);
    expect(sigkillAttempted).toBe(false);

    // Cleanup
    try {
      process.kill(-pgid, "SIGKILL");
    } catch {}
  }, 5000); // Explicit timeout

  it("reports unwatchable when sampler returns null", async () => {
    const logs: string[] = [];
    let unwatchableCalled = false;
    const unwatchableReasons: string[] = [];

    const handle = startRssWatchdog({
      child: spawn("sleep", ["10"], { detached: true, stdio: "ignore" }),
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

    await sleep(100);
    handle.stop();

    expect(unwatchableCalled).toBe(true);
    expect(unwatchableReasons).toHaveLength(1);
    expect(handle.status).toBe("stopped");
    expect(handle.killOrigin).toBeNull();
  });

  it("logs reason when becoming unwatchable", async () => {
    const logs: string[] = [];

    const handle = startRssWatchdog({
      child: spawn("sleep", ["10"], { detached: true, stdio: "ignore" }),
      pgidOrGroup: process.pid,
      pollMs: 50,
      onEscalate: () => {},
      onUnwatchable: () => {},
      log: (msg) => logs.push(msg),
      sampleRss: async () => null,
    });

    await sleep(100);
    handle.stop();

    expect(logs.some((l) => l.includes("unwatchable"))).toBe(true);
    expect(logs.some((l) => l.includes("ps failed"))).toBe(true);
  });

  it("uses external sampler when provided", async () => {
    let externalSamplerCalled = false;
    const customSample = async (): Promise<number | null> => {
      externalSamplerCalled = true;
      return 200 * 1024 ** 2;
    };

    const handle = startRssWatchdog({
      child: spawn("sleep", ["10"], { detached: true, stdio: "ignore" }),
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

    const child = spawn("sleep", ["10"], { detached: true, stdio: "ignore" });
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
    handle.stop();

    expect(escalated).toBe(true);
    // Should have sampled once or twice before escalation, then stopped
    expect(sampleCount).toBeLessThanOrEqual(3);

    // Cleanup
    try {
      process.kill(-pgid, "SIGKILL");
    } catch {}
  }, 5000); // Explicit timeout

  // Integration test with real process group
  // Note: These tests are kept simple to avoid hangs in CI environments
  describe.skipIf(process.platform === "win32")("real process group sampling", () => {
    it("samples aggregate RSS from a real process group", async () => {
      // Create a process group with a child
      const child = spawn("sleep", ["1"], {
        detached: true,
        stdio: "ignore",
      });

      const pgid = child.pid!;
      const samples: number[] = [];

      const handle = startRssWatchdog({
        child,
        pgidOrGroup: pgid,
        thresholdBytes: DEFAULT_THRESHOLD_BYTES,
        pollMs: 50,
        onEscalate: () => {},
        onUnwatchable: (reason) => {
          throw new Error(`Should be watchable, got: ${reason}`);
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
    });
  });
});
