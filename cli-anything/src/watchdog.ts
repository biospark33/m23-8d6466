/**
 * RSS watchdog for team-lead-driver process trees (DF1.6 T4).
 *
 * Monitors aggregate RSS of the spawned process group (lead + all descendants)
 * and escalates with SIGTERM to the group, then SIGKILL via killTree if the
 * tree survives the grace period.
 */

import type { ChildProcess } from "node:child_process";
import { execFile } from "node:child_process";

export const DEFAULT_POLL_MS = 200;
export const DEFAULT_THRESHOLD_BYTES = 4 * 1024 ** 3; // 4 GB
export const WATCHDOG_GRACE_MS = 5000;
const DEFAULT_MAX_BUFFER = 16 * 1024 * 1024; // 16MB for ps output on large systems

export interface WatchdogHandle {
  /** Stop the watchdog and release resources. */
  stop(): void;
  /** Current status of the watchdog. Updated by the poll loop. */
  status: "running" | "stopped" | "unwatchable";
  /**
   * If SIGTERM-to-group was fired, "watchdog" (precedence step 1).
   * Null if the watchdog never escalated.
   */
  killOrigin: "watchdog" | null;
}

export interface WatchdogOptions {
  /**
   * The lead child process. Kept for call-site symmetry and future
   * per-process diagnostics; liveness is tracked via the process GROUP
   * (`pgidOrGroup`), not this handle — the lead may exit before its
   * descendants during escalation.
   */
  child: ChildProcess;
  /** Process group ID (negative-pid target, equals child.pid on detached spawn). */
  pgidOrGroup: number;
  /** RSS threshold in bytes. Default 4 GB. */
  thresholdBytes?: number;
  /** Poll interval in ms. Default 200. */
  pollMs?: number;
  /** Grace period after SIGTERM before SIGKILL. Default WATCHDOG_GRACE_MS. */
  graceMs?: number;
  /** Called when RSS threshold is exceeded with sample info. */
  onEscalate: (info: { rssBytes: number; samples: number }) => void;
  /** Called when sampling becomes impossible (e.g., ps unavailable). */
  onUnwatchable: (reason: string) => void;
  /** Log callback for diagnostics. */
  log: (msg: string) => void;
  /** Inject RSS sampler for testing (default uses ps). */
  sampleRss?: () => Promise<number | null>;
}

/**
 * Start an RSS watchdog for a process tree.
 *
 * Samples aggregate RSS of the entire process group (lead + descendants)
 * every `pollMs`. When the aggregate exceeds `thresholdBytes`:
 * 1. Sends SIGTERM to the process group (process.kill(-pgid, "SIGTERM"))
 * 2. Waits `graceMs` for the tree to exit cleanly
 * 3. If still alive, sends SIGKILL to the tree via killTree
 *
 * If RSS sampling fails (ps unavailable, platform unsupported), reports
 * `unwatchable` and never kills — AC7 requires explicit logging, not silent
 * fallback to lead-only sampling.
 *
 * The child MUST be spawned with `detached: true` on POSIX to create a
 * process group; otherwise -pgid will not work as expected.
 */
export function startRssWatchdog(opts: WatchdogOptions): WatchdogHandle {
  const {
    // `opts.child` stays in the interface for callers/tests; the poll loop
    // keys off liveness via the process group, not the lead's exit state.
    pgidOrGroup,
    thresholdBytes,
    pollMs,
    graceMs,
    onEscalate,
    onUnwatchable,
    log,
    sampleRss: externalSampler,
  } = opts;

  // Validate numeric options: 0, negative, and NaN are rejected with a fallback
  // to the default. Destructuring defaults only handle undefined.
  const safeThresholdBytes =
    Number.isFinite(thresholdBytes) && thresholdBytes! > 0
      ? thresholdBytes!
      : DEFAULT_THRESHOLD_BYTES;
  const safePollMs =
    Number.isFinite(pollMs) && pollMs! > 0 ? pollMs! : DEFAULT_POLL_MS;
  const safeGraceMs =
    Number.isFinite(graceMs) && graceMs! > 0 ? graceMs! : WATCHDOG_GRACE_MS;

  // Warn when a bad value was supplied (undefined took the default silently)
  if (
    thresholdBytes !== undefined &&
    (!Number.isFinite(thresholdBytes) || thresholdBytes <= 0)
  ) {
    log(`cli-anything: invalid thresholdBytes ${thresholdBytes}, using default ${DEFAULT_THRESHOLD_BYTES}`);
  }
  if (pollMs !== undefined && (!Number.isFinite(pollMs) || pollMs <= 0)) {
    log(`cli-anything: invalid pollMs ${pollMs}, using default ${DEFAULT_POLL_MS}`);
  }
  if (graceMs !== undefined && (!Number.isFinite(graceMs) || graceMs <= 0)) {
    log(`cli-anything: invalid graceMs ${graceMs}, using default ${WATCHDOG_GRACE_MS}`);
  }

  let running = true;
  let escalated = false;
  let unwatchable = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let samples = 0;
  let consecutiveSampleFailures = 0; // Track consecutive failures for unwatchable
  const CONSECUTIVE_FAILURES_THRESHOLD = 3; // Require 3 failures before unwatchable
  let externalSamplerFailures = 0; // Consecutive failures for external sampler

  /**
   * Default RSS sampler. Platform-specific process-group selection:
   * - darwin (BSD ps): `ps -o rss= -g <pgid>` — `-g` selects by process
   *   group ID.
   * - linux (procps): `ps -g` selects by SESSION leader, not pgid — there is
   *   no pgid selector, so enumerate `ps -o pgid=,rss= -e` and filter lines
   *   by the requested pgid. Unrelated processes in the child's session are
   *   thereby excluded.
   * Returns aggregate RSS in bytes, or null if sampling fails.
   */
  const defaultSampler = async (): Promise<number | null> => {
    if (process.platform === "win32") {
      // ponytail: Windows not supported — ps process-group selection unavailable.
      // Upgrade path: use Windows-specific counter APIs (GetProcessMemoryInfo)
      // or WMI queries. Current ceiling: RSS watchdog inactive on Windows.
      console.error("cli-anything: RSS watchdog not supported on Windows (ps -o rss= -g unavailable)");
      return null;
    }
    const darwin = process.platform === "darwin";
    // ponytail: Linux uses `ps -o pgid=,rss=,pcpu= -e` (enumerates every process, O(N)),
    // then filters by pgid. Darwin uses `-g` for direct pgid selection.
    // Upgrade path: pgrep-based pre-filter (`pgrep -g <pgid>`) to reduce
    // enumeration. Current ceiling: full process table scan on Linux.
    // PR4: CPU% is advisory only — sampled and logged, never a kill reason.
    return new Promise((resolve) => {
      execFile(
        "ps",
        darwin
          ? ["-o", "rss=,%cpu=", "-g", String(pgidOrGroup)]
          : ["-o", "pgid=,rss=,pcpu=", "-e"],
        {
          maxBuffer: DEFAULT_MAX_BUFFER,
        },
        (err, stdout, stderr) => {
          if (err) {
            // Distinguish "group gone" from real sampling failure
            const stderrStr = stderr ?? "";
            const groupGonePatterns = darwin
              ? [/process group too large/i, /no such process/i, /invalid process group/i]
              : [/no such process/i];

            // If stderr indicates the group is gone, resolve 0 (nothing to watch)
            if (groupGonePatterns.some((pat) => pat.test(stderrStr))) {
              resolve(0);
              return;
            }
            return resolve(null);
          }
          let sumKb = 0;
          for (const line of stdout.split("\n")) {
            const trimmed = line.trim();
            if (trimmed === "") continue;
            const fields = trimmed.split(/\s+/);
            const rss = darwin ? fields[0] : fields[1];
            const cpuStr = darwin ? fields[1] : fields[2];
            if (!darwin && fields[0] !== String(pgidOrGroup)) continue;
            const kb = Number.parseInt(rss ?? "", 10);
            const cpu = Number.parseFloat(cpuStr ?? "");
            if (Number.isFinite(kb)) {
              sumKb += kb;
            }
            if (Number.isFinite(cpu)) {
              cpuSamples++;
              totalCpuPercent += cpu;
            }
          }
          // Convert KB to bytes
          resolve(sumKb * 1024);
        },
      );
    });
  };

  const sampler = externalSampler ?? defaultSampler;

  // Live state: the returned handle exposes these as PROPERTIES the poll
  // loop mutates in place — never a snapshot taken at creation time.
  let graceTimer: ReturnType<typeof setTimeout> | null = null;
  const handle: WatchdogHandle = {
    stop: (): void => {
      // Idempotent no-op if already stopped — but NOT if the child already
      // exited: a dead child must not leave `running` true and the poll timer
      // armed, spinning samples against a dead pgid forever (leaked timer).
      if (!running) return;
      running = false;
      // Log CPU stats (PR4: advisory only, sampled and logged, never a kill reason)
      if (cpuSamples > 0) {
        const avgCpu = totalCpuPercent / cpuSamples;
        log(`cli-anything: RSS watchdog CPU stats (advisory): ${cpuSamples} samples, avg ${avgCpu.toFixed(2)}%`);
      }
      // Preserve ONLY the terminal "unwatchable" state. An escalated stop is
      // still a stop — reporting "running" after the SIGKILL leg has been
      // armed misleads callers polling status (escalation is observable via
      // killOrigin, not via status).
      if (handle.status !== "unwatchable") {
        handle.status = "stopped";
      }
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      // Clear the grace timer ONLY if NOT escalated: once escalated,
      // the SIGKILL leg must run even after stop() — the runner may have
      // settled while the lead honored SIGTERM and exited within grace,
      // leaving surviving descendants that need the SIGKILL.
      if (graceTimer !== null && !escalated) {
        clearTimeout(graceTimer);
        graceTimer = null;
      }
    },
    status: "running",
    killOrigin: null,
  };

  // CPU sampling state (PR4: advisory only, sampled and logged, never a kill reason)
  let cpuSamples = 0;
  let totalCpuPercent = 0;

  const poll = async (): Promise<void> => {
    if (!running) return;

    let rssBytes: number | null = null;

    try {
      rssBytes = await sampler();
      // Recheck running after await — poll in flight when stop() runs must bail
      if (!running) return;
    } catch {
      // Stopped mid-sample: failure accounting here could still trip the
      // unwatchable threshold and overwrite the terminal "stopped" status —
      // bail exactly like the success path does.
      if (!running) return;
      // External sampler rejected (W5): treat as a sampling failure
      rssBytes = null;
    }

    if (rssBytes === null) {
      // Sampling failed — require consecutive failures before marking unwatchable
      // Built-in sampler: tracks consecutive failures with CONSECUTIVE_FAILURES_THRESHOLD
      // External sampler: also tracks consecutive failures (W4, W5)
      const isExternal = externalSampler !== undefined;
      const failureCount = isExternal ? ++externalSamplerFailures : ++consecutiveSampleFailures;
      const threshold = CONSECUTIVE_FAILURES_THRESHOLD;

      if (failureCount >= threshold) {
        const which = isExternal ? "external sampler" : "ps";
        log(`cli-anything: RSS watchdog unwatchable (${failureCount} consecutive ${which} failures for pgid ${pgidOrGroup})`);
        // Set state synchronously BEFORE invoking the callback, matching the
        // onEscalate ordering so classification reads the flag atomically.
        unwatchable = true;
        handle.status = "unwatchable";
        // Non-throwing guard: a throwing onUnwatchable callback must not abort
        // the poll — the unwatchable state and stop() flow run regardless.
        try {
          onUnwatchable(`${which} failed ${failureCount} times consecutively`);
        } catch (err) {
          console.error("cli-anything: RSS watchdog onUnwatchable callback threw", err);
        }
        // Mid-grace sampling loss: the tree is already SIGTERMed and the grace
        // timer is armed — stopping now would cancel the SIGKILL leg.
        // Keep the escalation machinery; only halt future polls.
        if (!escalated) handle.stop();
        return;
      }
      // Below threshold — log and continue polling
      const which = isExternal ? "external sampler" : "ps";
      log(`cli-anything: RSS watchdog sample failed (${failureCount}/${threshold}, retrying...)`);
      // Schedule next poll even on failure — will retry until threshold
      if (running && !escalated) {
        timer = setTimeout(poll, safePollMs);
        if (timer) timer.unref();
      }
      return;
    }
    // Reset both failure counters on success
    consecutiveSampleFailures = 0;
    externalSamplerFailures = 0;

    samples++;
    if (rssBytes > safeThresholdBytes && !escalated) {
      escalated = true;
      const info = { rssBytes, samples };
      const thresholdGigabytes = (safeThresholdBytes / 1024 ** 3).toFixed(2);
      // Non-throwing guards: a throwing log or onEscalate callback must not
      // abort the poll and leave the tree alive — the SIGTERM/SIGKILL flow
      // below runs regardless.
      try {
        log(`cli-anything: RSS watchdog escalation at ${rssBytes} bytes (${(rssBytes / 1024 ** 3).toFixed(2)} GB, threshold ${thresholdGigabytes} GB)`);
      } catch (err) {
        console.error("cli-anything: RSS watchdog log callback threw", err);
      }
      // Set escalation state synchronously BEFORE invoking the callback,
      // so classification reads the flag atomically at decision time.
      handle.killOrigin = "watchdog";
      try {
        onEscalate(info);
      } catch (err) {
        console.error("cli-anything: RSS watchdog onEscalate callback threw", err);
      }

      // SIGTERM to the process group. killOrigin was already set synchronously
      // when escalation began (above). This delivery only fails if the group
      // is already gone — in that case, clear attribution since the watchdog
      // did not actually kill it.
      try {
        process.kill(-pgidOrGroup, "SIGTERM");
      } catch {
        // Group already gone — nothing to kill, clear watchdog attribution
        handle.killOrigin = null;
        handle.stop();
        return;
      }

      // Wait grace period, then SIGKILL if still alive
      graceTimer = setTimeout(() => {
        // W1: stop() only clears the grace timer when NOT escalated.
        // Once escalated, the SIGKILL leg survives stop() — only stop the
        // SIGKILL if the group is already gone (clean return).
        if (!running && !escalated) return;
        // Check the PROCESS GROUP (negative target), not the lead PID: the
        // SIGTERM above went to the group, and the lead commonly honors it
        // and exits before its descendants. Polling +pgid would test only the
        // (dead) leader, skip the SIGKILL, and leak the surviving tree.
        // If the group is gone (ESRCH), nothing to kill — return cleanly.
        try {
          process.kill(-pgidOrGroup, 0); // Poll group, don't signal
        } catch {
          // Process group already gone — no SIGKILL needed
          return;
        }
        // Group still has members — send SIGKILL to the group
        log("cli-anything: RSS watchdog SIGKILL after grace period");
        try {
          process.kill(-pgidOrGroup, "SIGKILL");
        } catch {
          // Group already gone
        }
      }, safeGraceMs);
      graceTimer.unref(); // Don't keep process alive for grace timer
    }

    // Schedule next poll
    if (running && !escalated) {
      timer = setTimeout(poll, safePollMs);
      if (timer) timer.unref();
    }
  };

  // Start polling
  timer = setTimeout(poll, safePollMs);
  if (timer) timer.unref();

  return handle;
}
