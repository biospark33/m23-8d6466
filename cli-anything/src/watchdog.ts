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
    thresholdBytes = DEFAULT_THRESHOLD_BYTES,
    pollMs = DEFAULT_POLL_MS,
    graceMs = WATCHDOG_GRACE_MS,
    onEscalate,
    onUnwatchable,
    log,
    sampleRss: externalSampler,
  } = opts;

  let running = true;
  let escalated = false;
  let unwatchable = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let samples = 0;

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
      return null; // Windows not supported
    }
    const darwin = process.platform === "darwin";
    return new Promise((resolve) => {
      execFile(
        "ps",
        darwin
          ? ["-o", "rss=", "-g", String(pgidOrGroup)]
          : ["-o", "pgid=,rss=", "-e"],
        (err, stdout) => {
          if (err) {
            return resolve(null);
          }
          let sumKb = 0;
          for (const line of stdout.split("\n")) {
            const trimmed = line.trim();
            if (trimmed === "") continue;
            const fields = trimmed.split(/\s+/);
            const rss = darwin ? fields[0] : fields[1];
            if (!darwin && fields[0] !== String(pgidOrGroup)) continue;
            const kb = Number.parseInt(rss ?? "", 10);
            if (Number.isFinite(kb)) {
              sumKb += kb;
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
      handle.status = "stopped";
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      // Clear the armed grace timer too: a stopped watchdog must not later
      // fire its SIGKILL leg (stale PGID reuse hazard).
      if (graceTimer !== null) {
        clearTimeout(graceTimer);
        graceTimer = null;
      }
    },
    status: "running",
    killOrigin: null,
  };

  const poll = async (): Promise<void> => {
    if (!running) return;

    const rssBytes = await sampler();

    if (rssBytes === null) {
      // Sampling failed — mark unwatchable and stop escalation
      log(`cli-anything: RSS watchdog unwatchable (ps failed for pgid ${pgidOrGroup})`);
      onUnwatchable(`ps -o rss= -g ${pgidOrGroup} failed`);
      unwatchable = true;
      handle.status = "unwatchable";
      // Mid-grace sampling loss: the tree is already SIGTERMed and the grace
      // timer is armed — stopping now would cancel the SIGKILL leg (#14).
      // Keep the escalation machinery; only halt future polls.
      if (!escalated) handle.stop();
      return;
    }

    samples++;
    if (rssBytes > thresholdBytes && !escalated) {
      escalated = true;
      const info = { rssBytes, samples };
      log(`cli-anything: RSS watchdog escalation at ${rssBytes} bytes (${(rssBytes / 1024 ** 3).toFixed(2)} GB)`);
      onEscalate(info);

      // SIGTERM to the process group. killOrigin is set ONLY after the signal
      // is actually delivered — a natural exit between the escalation decision
      // and a failed kill(2) must not be attributed to the watchdog
      // (precedence step 1 reads this flag as "the watchdog killed it").
      try {
        process.kill(-pgidOrGroup, "SIGTERM");
        handle.killOrigin = "watchdog";
      } catch {
        // Group already gone — nothing to kill, no watchdog attribution
        handle.stop();
        return;
      }

      // Wait grace period, then SIGKILL if still alive
      graceTimer = setTimeout(() => {
        if (!running) return;
        // Check the PROCESS GROUP (negative target), not the lead PID: the
        // SIGTERM above went to the group, and the lead commonly honors it
        // and exits before its descendants. Polling +pgid would test only the
        // (dead) leader, skip the SIGKILL, and leak the surviving tree.
        try {
          process.kill(-pgidOrGroup, 0); // Poll, don't signal
          // Group still has members — send SIGKILL to the group
          log("cli-anything: RSS watchdog SIGKILL after grace period");
          try {
            process.kill(-pgidOrGroup, "SIGKILL");
          } catch {
            // Group already gone
          }
        } catch {
          // Process group already gone — no SIGKILL needed
        }
      }, graceMs);
      graceTimer.unref(); // Don't keep process alive for grace timer
    }

    // Schedule next poll
    if (running && !escalated) {
      timer = setTimeout(poll, pollMs);
      if (timer) timer.unref();
    }
  };

  // Start polling
  timer = setTimeout(poll, pollMs);
  if (timer) timer.unref();

  return handle;
}
