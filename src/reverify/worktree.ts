/**
 * Quarantine worktree + host toolchain probe (Story DF5.1, INV-RV-2/INV-RV-5).
 *
 * Everything the re-verify touches lives in a DETACHED worktree checked out off
 * `refs/sandbox/<run-id>` — DF2.5's quarantine ref, one step further on. The
 * operator repository's branches, tags, remote-tracking refs, index, `HEAD` and
 * working tree are neither read for the verdict nor written at any point, and
 * the worktree is pruned on EVERY exit path, the throwing one included.
 */
import { rmSync } from "node:fs";
import { join, resolve } from "node:path";

import { assertExistingRunId } from "../providers/run-record.ts";
import { EXEC_MAX_OUTPUT_BYTES, readBounded } from "../providers/bounded-exec.ts";

/** A named, remediable failure. Every one of these maps to an `error` verdict. */
export class ReverifyError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly remediation: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "ReverifyError";
  }
}

export function sandboxRef(runId: string): string {
  return `refs/sandbox/${runId}`;
}

export interface ExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  /** Either stream hit `EXEC_MAX_OUTPUT_BYTES` — `stdout`/`stderr` are a
   * PREFIX, not the whole output. A caller that parses a summary line out of
   * this text must treat a truncated result as inconclusive, never as proof
   * the line was absent. */
  truncated?: boolean;
}

/** argv array, never a shell string (DF1.2 INV-1's rule, applied here too). */
export async function exec(
  argv: readonly string[],
  opts: {
    cwd?: string;
    env?: Record<string, string>;
    signal?: AbortSignal;
    /** The child is USER work (the reverified repo's test command): drain past
     * the cap instead of killing it, so a verbose but passing run still passes. */
    drainPastCap?: boolean;
  } = {},
): Promise<ExecResult> {
  let proc: Bun.Subprocess<"ignore", "pipe", "pipe">;
  try {
    proc = Bun.spawn(argv as string[], {
      ...(opts.cwd !== undefined ? { cwd: opts.cwd } : {}),
      ...(opts.env !== undefined ? { env: opts.env } : {}),
      ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
  } catch (err) {
    return { exitCode: -1, stdout: "", stderr: err instanceof Error ? err.message : String(err) };
  }
  const bounded = opts.drainPastCap
    ? { exited: proc.exited, drainPastCap: true }
    : {
        exited: proc.exited,
        kill: () => {
          proc.kill(9);
        },
      };
  const [exitCode, out, err] = await Promise.all([
    proc.exited,
    readBounded(proc.stdout, EXEC_MAX_OUTPUT_BYTES, bounded),
    readBounded(proc.stderr, EXEC_MAX_OUTPUT_BYTES, bounded),
  ]);
  return {
    exitCode,
    stdout: out.text,
    stderr: err.text,
    ...(out.truncated || err.truncated ? { truncated: true } : {}),
  };
}

export interface ToolProbe {
  name: string;
  argv: readonly string[];
}

/**
 * Probe each required tool and record its version. A tool that cannot be run is
 * a typed error, never a skipped check — a missing test runner must not be able
 * to produce a pass (INV-RV-5, AC4).
 */
export async function probeToolchain(probes: readonly ToolProbe[]): Promise<Record<string, string>> {
  const toolchain: Record<string, string> = {};
  for (const probe of probes) {
    const res = await exec(probe.argv);
    if (res.exitCode !== 0) {
      throw new ReverifyError(
        "toolchain-missing",
        `host toolchain probe for ${probe.name} failed (exit ${res.exitCode}): ${res.stderr.trim() || res.stdout.trim()}`,
        `install ${probe.name} on the host, or fix PATH, then re-run reverify — a missing tool is never a pass`,
      );
    }
    toolchain[probe.name] = (res.stdout || res.stderr).trim().split("\n")[0] ?? "";
  }
  return toolchain;
}

export interface QuarantineOptions {
  /** The host git checkout the quarantine ref lives in. */
  gitCwd: string;
  runId: string;
  /** Parent dir for the worktree. Default `.sandbox/reverify` under `gitCwd`. */
  root?: string;
  signal?: AbortSignal;
}

export interface Quarantine {
  dir: string;
  headSha: string;
}

async function refSha(gitCwd: string, ref: string): Promise<string | null> {
  const res = await exec(["git", "rev-parse", "--verify", "--quiet", `${ref}^{commit}`], { cwd: gitCwd });
  const sha = res.stdout.trim();
  return res.exitCode === 0 && sha.length > 0 ? sha : null;
}

/**
 * Run `body` against a detached checkout of the quarantine ref, then prune.
 *
 * The prune is in a `finally` and is itself best-effort-then-forceful: `git
 * worktree remove --force` followed by an unconditional `rm -rf` and a `git
 * worktree prune`, because a half-removed worktree that survives an `error`
 * exit is exactly the operator-repo contamination INV-RV-2 exists to prevent.
 */
export async function withQuarantineWorktree<T>(
  opts: QuarantineOptions,
  body: (q: Quarantine) => Promise<T>,
): Promise<T> {
  // The worktree path is `resolve(root, runId)` and the cleanup below is an
  // unconditional recursive `rmSync` of it. Validate the id BEFORE either: a
  // caller reaching this export without going through the run record store
  // must not be able to aim that remove with `../..`.
  assertExistingRunId(opts.runId);
  const ref = sandboxRef(opts.runId);
  const headSha = await refSha(opts.gitCwd, ref);
  if (headSha === null) {
    // No worktree is created on this path — the check happens before the add.
    throw new ReverifyError(
      "no-quarantine-ref",
      `${ref} does not resolve to a commit in ${opts.gitCwd}`,
      "run the DF2.5 harvest for this run first; reverify never fetches, it only reads what harvest already quarantined",
    );
  }

  const root = opts.root ?? join(opts.gitCwd, ".sandbox", "reverify");
  const dir = resolve(root, opts.runId);
  // A leftover from a killed earlier run would make `worktree add` fail on an
  // existing path; clear the registration and the directory first.
  await exec(["git", "worktree", "remove", "--force", dir], { cwd: opts.gitCwd });
  rmSync(dir, { recursive: true, force: true });

  const add = await exec(["git", "worktree", "add", "--detach", "--no-checkout", dir, headSha], {
    cwd: opts.gitCwd,
    ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
  });
  if (add.exitCode !== 0) {
    throw new ReverifyError(
      "worktree-failed",
      `git worktree add --detach ${dir} ${headSha} failed (exit ${add.exitCode}): ${add.stderr.trim()}`,
      "check disk space and that no stale worktree registration holds that path (`git worktree prune`), then re-run",
    );
  }

  try {
    // Checked out AFTER the add so a failed checkout still leaves a registered
    // worktree the `finally` below can remove.
    const checkout = await exec(["git", "checkout", "--detach", headSha], {
      cwd: dir,
      ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
    });
    if (checkout.exitCode !== 0) {
      throw new ReverifyError(
        "worktree-failed",
        `detached checkout of ${headSha} in ${dir} failed (exit ${checkout.exitCode}): ${checkout.stderr.trim()}`,
        "inspect the quarantine ref by hand (`git log refs/sandbox/<run-id>`), then re-run",
      );
    }
    return await body({ dir, headSha });
  } finally {
    await exec(["git", "worktree", "remove", "--force", dir], { cwd: opts.gitCwd });
    rmSync(dir, { recursive: true, force: true });
    await exec(["git", "worktree", "prune"], { cwd: opts.gitCwd });
  }
}

// ─── execution guards (INV-RV-3) ─────────────────────────────────────────────

/** Wall-clock ceiling for one re-verify, floor 60 s (story: Guards/limits). */
export const DEFAULT_WALL_CLOCK_MS = 30 * 60_000;
export const WALL_CLOCK_FLOOR_MS = 60_000;
/** RSS ceiling for the verify process tree. */
export const DEFAULT_RSS_BYTES = 4 * 1024 * 1024 * 1024;
/** Grace between the abort's SIGTERM and the SIGKILL sweep. */
export const KILL_GRACE_MS = 5_000;

const RSS_POLL_MS = 2_000;

export interface Guards {
  signal: AbortSignal;
  /** Set when a bound was hit; the runner maps it to an `error` verdict. */
  tripped(): { code: string; message: string } | null;
  dispose(): void;
}

const PS_ARGV = ["ps", "-Ao", "pid=,ppid=,rss="];

function parsePsTable(stdout: string): Map<number, { ppid: number; rss: number }> {
  const table = new Map<number, { ppid: number; rss: number }>();
  for (const line of stdout.split("\n")) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\d+)\s*$/.exec(line);
    if (!m) continue;
    // ps reports RSS in KiB on both darwin and linux.
    table.set(Number(m[1]), { ppid: Number(m[2]), rss: Number(m[3]) * 1024 });
  }
  return table;
}

/** pid → ppid,rss(bytes) for every process visible to this user. */
async function processTable(): Promise<Map<number, { ppid: number; rss: number }>> {
  const res = await exec(PS_ARGV);
  return res.exitCode === 0 ? parsePsTable(res.stdout) : new Map();
}

/**
 * Synchronous twin, used for exactly one thing: the baseline snapshot taken
 * INSIDE withGuards() (F064). It has to be sync — an async baseline resolves a
 * few ms after withGuards() returns, and every child the verify body spawns in
 * that window would land in the baseline and be exempted from the sweep it is
 * the whole point of. One blocking `ps` per re-verify is the price.
 */
function processTableSync(): Map<number, { ppid: number; rss: number }> {
  try {
    const res = Bun.spawnSync(PS_ARGV, { stdin: "ignore", stdout: "pipe", stderr: "ignore" });
    if (res.exitCode !== 0) return new Map();
    const table = parsePsTable(res.stdout.toString());
    // `ps` lists ITSELF, and it is dead by the time this returns. Leaving it in
    // the baseline exempts that pid from the sweep forever — and a recycled pid
    // is a live process this re-verify may well have spawned.
    table.delete(res.pid);
    return table;
  } catch {
    // No baseline is the pre-F064 behavior (sweep everything) — noisy, never
    // unsafe for this re-verify's own children.
    return new Map();
  }
}

function descendants(table: Map<number, { ppid: number; rss: number }>, root: number): number[] {
  const children = new Map<number, number[]>();
  for (const [pid, { ppid }] of table) {
    const list = children.get(ppid);
    if (list) list.push(pid);
    else children.set(ppid, [pid]);
  }
  const out: number[] = [];
  const stack = [...(children.get(root) ?? [])];
  while (stack.length > 0) {
    const pid = stack.pop()!;
    out.push(pid);
    stack.push(...(children.get(pid) ?? []));
  }
  return out;
}

/**
 * Wall-clock and RSS bounds enforced BY THE HOST, not by the code under test
 * (INV-RV-3). Both map to an `error` verdict — never to a pass.
 *
 * ponytail: RSS is sampled every 2 s from `ps` over this process's descendant
 * tree rather than measured with cgroups. It catches a runaway allocator, not a
 * 1.9 s spike; the upgrade path is the disposable host-side verify box the
 * story already names as the follow-up for the whole exposure.
 *
 * F064: both the RSS accounting and the SIGKILL sweep are scoped to processes
 * that appeared UNDER this process AFTER the guard was installed. In a
 * long-lived host (the fleet daemon, a spawned MCP transport, a re-verify
 * already running) `descendants(process.pid)` is full of children that have
 * nothing to do with this run; charging their RSS to this bound tripped it
 * spuriously, and the sweep then SIGKILLed them.
 */
export function withGuards(opts: { wallClockMs?: number; rssBytes?: number } = {}): Guards {
  const wallClockMs = Math.max(WALL_CLOCK_FLOOR_MS, opts.wallClockMs ?? DEFAULT_WALL_CLOCK_MS);
  const rssBytes = opts.rssBytes ?? DEFAULT_RSS_BYTES;
  const controller = new AbortController();
  let trip: { code: string; message: string } | null = null;
  let disposed = false;
  let sweepTimer: ReturnType<typeof setTimeout> | null = null;
  /** Descendants that predate this guard: never ours to charge for or kill. */
  const preexisting = new Set(descendants(processTableSync(), process.pid));
  const ours = (table: Map<number, { ppid: number; rss: number }>): number[] =>
    descendants(table, process.pid).filter((pid) => !preexisting.has(pid));

  const fire = (code: string, message: string): void => {
    if (trip !== null) return;
    trip = { code, message };
    // Abort first: that is the SIGTERM every spawned gate sees.
    controller.abort(new Error(message));
    // Then sweep whatever ignored it, after the grace window — but only the
    // pids that are descendants AT FIRE TIME and were NOT already descendants
    // when the guard was installed. Re-reading the process table inside the
    // timer would SIGKILL whatever a long-lived host process happens to have
    // spawned by then, which is nothing to do with this re-verify; the
    // baseline subtraction (F064) rules out its pre-existing children too.
    //
    // ponytail: a pid recycled inside the 5 s grace is killed wrongly, and a
    // SECOND re-verify that starts after this guard's baseline still lands in
    // the sweep. Both close the same way: the process group / disposable
    // verify box the story already names.
    void processTable().then((table) => {
      const doomed = ours(table);
      if (disposed) return; // re-verify finished before the snapshot came back
      sweepTimer = setTimeout(() => {
        sweepTimer = null;
        for (const pid of doomed) {
          try {
            process.kill(pid, "SIGKILL");
          } catch {
            // already gone — the SIGTERM did its job
          }
        }
      }, KILL_GRACE_MS);
      sweepTimer.unref?.();
    });
  };

  const wallTimer = setTimeout(
    () => fire("wall-clock-exceeded", `re-verify exceeded its ${wallClockMs}ms wall-clock bound`),
    wallClockMs,
  );
  wallTimer.unref?.();

  const rssTimer = setInterval(() => {
    if (trip !== null) return; // already fired; the snapshot is taken
    void processTable().then((table) => {
      const total = ours(table).reduce((sum, pid) => sum + (table.get(pid)?.rss ?? 0), 0);
      if (total > rssBytes) {
        fire("rss-exceeded", `re-verify process tree reached ${total} bytes RSS, over the ${rssBytes}-byte bound`);
      }
    });
  }, RSS_POLL_MS);
  rssTimer.unref?.();

  return {
    signal: controller.signal,
    tripped: () => trip,
    dispose: () => {
      disposed = true;
      clearTimeout(wallTimer);
      clearInterval(rssTimer);
      // Cancel a pending SIGKILL sweep too: without this, a guard trip that
      // races the disposal (fire()'s processTable() resolves and arms the
      // timer after dispose() already ran) leaves an unref'd timeout alive
      // in a long-lived host process. It would fire minutes later and SIGKILL
      // whatever pid the sweep's snapshot named — even a since-recycled pid
      // now used by an unrelated descendant the host spawned afterward.
      if (sweepTimer !== null) clearTimeout(sweepTimer);
    },
  };
}
