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
}

/** argv array, never a shell string (DF1.2 INV-1's rule, applied here too). */
export async function exec(
  argv: readonly string[],
  opts: { cwd?: string; env?: Record<string, string>; signal?: AbortSignal } = {},
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
  const [exitCode, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
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

/** pid → ppid,rss(bytes) for every process visible to this user. */
async function processTable(): Promise<Map<number, { ppid: number; rss: number }>> {
  const res = await exec(["ps", "-Ao", "pid=,ppid=,rss="]);
  const table = new Map<number, { ppid: number; rss: number }>();
  if (res.exitCode !== 0) return table;
  for (const line of res.stdout.split("\n")) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\d+)\s*$/.exec(line);
    if (!m) continue;
    // ps reports RSS in KiB on both darwin and linux.
    table.set(Number(m[1]), { ppid: Number(m[2]), rss: Number(m[3]) * 1024 });
  }
  return table;
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
 */
export function withGuards(opts: { wallClockMs?: number; rssBytes?: number } = {}): Guards {
  const wallClockMs = Math.max(WALL_CLOCK_FLOOR_MS, opts.wallClockMs ?? DEFAULT_WALL_CLOCK_MS);
  const rssBytes = opts.rssBytes ?? DEFAULT_RSS_BYTES;
  const controller = new AbortController();
  let trip: { code: string; message: string } | null = null;

  const fire = (code: string, message: string): void => {
    if (trip !== null) return;
    trip = { code, message };
    // Abort first: that is the SIGTERM every spawned gate sees.
    controller.abort(new Error(message));
    // Then sweep whatever ignored it, after the grace window.
    const sweep = setTimeout(() => {
      void processTable().then((table) => {
        for (const pid of descendants(table, process.pid)) {
          try {
            process.kill(pid, "SIGKILL");
          } catch {
            // already gone — the SIGTERM did its job
          }
        }
      });
    }, KILL_GRACE_MS);
    sweep.unref?.();
  };

  const wallTimer = setTimeout(
    () => fire("wall-clock-exceeded", `re-verify exceeded its ${wallClockMs}ms wall-clock bound`),
    wallClockMs,
  );
  wallTimer.unref?.();

  const rssTimer = setInterval(() => {
    void processTable().then((table) => {
      const total = descendants(table, process.pid).reduce((sum, pid) => sum + (table.get(pid)?.rss ?? 0), 0);
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
      clearTimeout(wallTimer);
      clearInterval(rssTimer);
    },
  };
}
