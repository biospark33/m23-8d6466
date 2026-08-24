/**
 * The single-operator fleet lock (DF3.2 AC8) — `.sandbox/fleet.lock`.
 *
 * Split out of src/fleet/fanout.ts under D1's sanctioned escape clause
 * (orchestrator-approved: sections 1+2 alone crossed ~600 lines). Moved
 * VERBATIM, imports adjusted only — zero behavior change.
 *
 * Composed over scripts/lib/run-lock.ts's hardened primitives (this story made
 * `claim`/`writeLockDirect`/`isAlive`/`hostTag` reachable with four additive
 * `export` keywords) rather than a second lock implementation that would replay
 * the exact bug families DF3.1 spent review rounds 3/5/6/8/9 fixing.
 */

import { randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
} from "node:fs";
import { dirname, resolve } from "node:path";

import { claim, isAlive } from "../../scripts/lib/run-lock.ts";
import { FleetError } from "./dispatch.ts";

export const FLEET_LOCK_PATH = ".sandbox/fleet.lock";

/** Past this age, staleness is CANDIDATE — identity still decides (see classify). */
export const FLEET_LOCK_STALE_MS = 3_600_000;

/** Story-mandated body — JSON, mode 0600. Distinct from run-lock's whitespace body. */
export interface FleetLockBody {
  pid: number;
  pidStartTime: number;
  createdAt: string;
  requestId: string;
  /**
   * Additive (r10 darwin TZ fix): the raw `ps -o lstart=` line exactly as this
   * host printed it — TZ/locale evidence an operator can diff against a live
   * `ps -p <pid> -o lstart=`. Never COMPARED across processes directly: each
   * `ps` renders the same instant in the READING shell's TZ.
   */
  lstartRaw?: string;
  /** Those same components converted by UTC arithmetic alone — the TZ-stable identity half `classifyHolder` compares. */
  lstartUtcMs?: number;
}

/**
 * What one platform observation of a pid's start time yields. `localMs` is the
 * legacy epoch-ms half (`pidStartTime`); the darwin observer additionally
 * records the raw line and the TZ-free conversion.
 */
interface PidIdentity {
  localMs: number;
  lstartRaw?: string;
  lstartUtcMs?: number;
}

/**
 * Linux USER_HZ. `/proc/<pid>/stat`'s starttime is in clock ticks and no
 * runtime exposes `sysconf(_SC_CLK_TCK)`; every mainstream kernel ships 100.
 * ponytail: hardcode 100 — revisit only if a kernel with a different USER_HZ
 * ever runs this code, where the symptom would be sub-second reclaim drift.
 */
const CLK_TCK = 100;

/** `ps -o lstart=` prints ctime months, locale-sensitive — manual map, never Date.parse. */
const MONTH_INDEX: Readonly<Record<string, number>> = {
  Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5,
  Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11,
};

/**
 * A process's start time as epoch ms — the identity half of the reclaim test.
 *
 * - darwin: `ps -o lstart= -p <pid>`, ctime format `%a %b %e %H:%M:%S %Y`, no
 *   TZ designator and locale-sensitive month names: parsed with a MANUAL month
 *   map and constructed in LOCAL time. `Date.parse` on this shape is
 *   implementation-defined and would silently mis-read it.
 * - linux: `/proc/<pid>/stat` field 22 (starttime, clock ticks) via the
 *   after-last-`)` split — comm may contain spaces, so field indexes are taken
 *   from the remainder — divided by CLK_TCK plus `/proc/stat`'s btime.
 *
 * THROWS when the start time cannot be observed (dead pid, missing ps, exotic
 * locale). Callers treat that as "identity unknown" and fail closed — an
 * unobservable owner is exactly the one that must not be judged.
 */
export function readOwnPidStartTime(pid: number = process.pid): number {
  return observePidStart(pid).localMs;
}

function observePidStart(pid: number = process.pid): PidIdentity {
  return process.platform === "linux" ? procStatIdentity(pid) : psLstartIdentity(pid);
}

function procStatIdentity(pid: number): PidIdentity {
  const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
  // After the LAST ')': state is field 3, so starttime (field 22) sits at
  // remainder index 19 (proc_pid_stat(5)).
  const rest = stat.slice(stat.lastIndexOf(")") + 1).trim().split(/\s+/);
  const ticks = Number(rest[19]);
  const btime = /^btime (\d+)/m.exec(readFileSync("/proc/stat", "utf8"))?.[1];
  if (!Number.isFinite(ticks) || btime === undefined) {
    throw new Error(`could not read start time of pid ${pid} from /proc`);
  }
  return { localMs: Number(btime) * 1000 + Math.floor((ticks / CLK_TCK) * 1000) };
}

function psLstartIdentity(pid: number): PidIdentity {
  let out: string;
  try {
    out = execFileSync("ps", ["-o", "lstart=", "-p", String(pid)], { encoding: "utf8" });
  } catch (e) {
    throw new Error(`could not observe start time of pid ${pid}: ps failed (${(e as Error).message.split("\n")[0]})`);
  }
  const m: RegExpExecArray | null = /^[A-Za-z]{3} ([A-Za-z]{3})\s+(\d{1,2}) (\d{2}):(\d{2}):(\d{2}) (\d{4})$/.exec(
    out.trim(),
  );
  if (m === null) {
    throw new Error(`could not parse \`ps -o lstart=\` output for pid ${pid}: ${JSON.stringify(out.trim())}`);
  }
  const month: number | undefined = MONTH_INDEX[m[1] as string];
  if (month === undefined) {
    throw new Error(
      `could not parse \`ps -o lstart=\` month ${JSON.stringify(m[1])} for pid ${pid}: locale not in the manual map`,
    );
  }
  // LOCAL time, no TZ designator: the legacy `pidStartTime` value is still
  // constructed in local time, never Date.UTC. The SAME components are also
  // converted by UTC arithmetic alone into `lstartUtcMs` — a local-time Date
  // bakes in the OBSERVING shell's TZ, so a lock written under TZ=UTC (cron)
  // was judged by a TZ=X reader into reclaiming its LIVE owner (r10). Pure
  // component arithmetic has no TZ in it and compares equal from any shell.
  return {
    localMs: new Date(Number(m[6]), month, Number(m[2]), Number(m[3]), Number(m[4]), Number(m[5])).getTime(),
    lstartRaw: out.trim(),
    lstartUtcMs: Date.UTC(Number(m[6]), month, Number(m[2]), Number(m[3]), Number(m[4]), Number(m[5])),
  };
}

/** Locks THIS process created and has not released yet: resolved path → body. */
const fleetHeld = new Map<string, string>();
/** Paths past the point of no return — release refuses unless forced. */
const fleetDestructive = new Set<string>();

let fleetSignalsInstalled = false;
let fleetUnwinding = false;

/** Release every fleet lock this process still holds, reporting to stderr. */
function releaseHeldFleetLocks(): void {
  for (const [path, body] of [...fleetHeld]) {
    fleetHeld.delete(path);
    if (fleetDestructive.has(path)) {
      writeStderr(
        `!! fleet-lock-held: ${path} was NOT released — interrupted after the destructive phase began\nnext: check the running arms before anything else touches them; rm ${path} only once you know their state\n`,
      );
      continue;
    }
    try {
      let before: string;
      try {
        before = readFileSync(path, "utf8");
      } catch {
        continue; // already gone — nothing left to hold
      }
      if (before === body) {
        rmSync(path, { force: true });
      } else {
        parkOrphan(path);
      }
    } catch (e) {
      writeStderr(
        `!! fleet-lock-release-failed: could not release ${path}: ${(e as Error).message}\nnext: rm ${path} by hand once no other fan-out holds it\n`,
      );
    }
  }
}

/**
 * One Ctrl-C mid-fan-out used to strand `.sandbox/fleet.lock` forever: every
 * later fan-out refused while the arms kept billing. Installed BEFORE the
 * claim primitive's linkSync — a signal landing in the install window was the
 * original stranding bug (r8). Same borrow-strip-reraise dance as
 * scripts/lib/run-lock.ts's installer: ours goes for good, everyone else's is
 * borrowed for the duration of the re-raise, because a listener-free signal
 * restores the default TERMINATE disposition and `signalCode` is what callers
 * actually read.
 */
function installFleetSignalRelease(): void {
  if (fleetSignalsInstalled) return;
  fleetSignalsInstalled = true;
  for (const sig of ["SIGINT", "SIGTERM", "SIGHUP", "SIGQUIT"] as const) {
    const onSignal = (): void => {
      if (fleetUnwinding) return;
      fleetUnwinding = true;
      releaseHeldFleetLocks();
      process.removeListener(sig, onSignal);
      const others = process.listeners(sig);
      for (const listener of others) process.removeListener(sig, listener as () => void);
      try {
        process.kill(process.pid, sig);
      } finally {
        for (const listener of others) process.on(sig, listener as () => void);
      }
    };
    process.on(sig, onSignal);
  }
  // All-sync release, so the exit path cannot lose it either.
  process.on("exit", releaseHeldFleetLocks);
}

/** Best-effort full write to fd 2 — diagnostics must never wedge an exit handler. */
function writeStderr(s: string): void {
  try {
    process.stderr.write(s);
  } catch {
    // best-effort diagnostic only
  }
}

/**
 * Move a body this process found at its lock path but does not own to a unique
 * sibling orphan name. The orphan carries NO `.tmp` suffix ON PURPOSE (K1):
 * sweep predicates match dead-pid `.tmp` names, and these bytes are evidence
 * an operator restores by hand — parked so they survive every sweep cycle.
 */
function parkOrphan(path: string): void {
  const orphan = `${path}.orphan.${process.pid}.${randomBytes(4).toString("hex")}`;
  try {
    renameSync(path, orphan);
  } catch {
    writeStderr(`!! fleet-lock-park-failed: foreign body left AT ${path}\n`);
    return;
  }
  writeStderr(`fleet-lock: parked a foreign body at ${orphan} (it was NOT deleted)\n`);
}

/**
 * This process's story-mandated lock body. Observing our own start time can
 * fail (missing/broken `ps`, exotic locale); that failure used to escape
 * `acquire` as a raw Error outside the module's typed taxonomy, so it is a
 * FleetError here — a fleet lock whose identity cannot be WRITTEN must not be
 * claimed at all.
 */
function ownFleetLockBody(requestId: string): FleetLockBody {
  let identity: PidIdentity;
  try {
    identity = observePidStart();
  } catch (e) {
    throw new FleetError(
      5,
      "fleet-identity-unobservable",
      `cannot record this process's start time for the fleet lock: ${(e as Error).message}`,
      "run where the platform identity probe works (a working ps/procfs and a common locale) — the fleet lock refuses to claim without provable identity",
    );
  }
  return {
    pid: process.pid,
    pidStartTime: identity.localMs,
    createdAt: new Date().toISOString(),
    requestId,
    ...(identity.lstartRaw === undefined ? {} : { lstartRaw: identity.lstartRaw }),
    ...(identity.lstartUtcMs === undefined ? {} : { lstartUtcMs: identity.lstartUtcMs }),
  };
}

/**
 * The single-operator advisory lock across admission + all N mints (AC8).
 *
 * Composition over scripts/lib/run-lock.ts's primitives: `claim()` publishes
 * a complete, fsynced temp via link(2) and already falls back to
 * `writeLockDirect` on filesystems without working links; `isAlive()` is THE
 * fail-closed liveness probe. The body is the story-mandated JSON
 * `{pid,pidStartTime,createdAt,requestId}` at 0600 — distinct from run-lock's
 * whitespace body, which stays native for per-record locks.
 */
export class FleetLock {
  /** Resolved — `held` keys on one spelling of the path, always. */
  readonly path: string;
  private readonly requestId: string;

  constructor(opts: { path?: string; requestId: string }) {
    this.path = resolve(opts.path ?? FLEET_LOCK_PATH);
    this.requestId = opts.requestId;
  }

  /** The destructive phase began — release now refuses until cleared/forced. */
  markDestructive(): void {
    fleetDestructive.add(this.path);
  }

  /** The destructive phase completed successfully. */
  clearDestructive(): void {
    fleetDestructive.delete(this.path);
  }

  /**
   * Acquire, refusing with `FleetError(5, …)` when another fan-out holds the
   * lock. Reclamation is a TWO-PART test, both required: age >
   * FLEET_LOCK_STALE_MS AND (owner dead OR observed start time ≠ recorded).
   * Age alone NEVER reclaims; alive-with-matching-identity NEVER expires.
   */
  acquire(): void {
    // BEFORE any link can land: a signal in the install window used to strand
    // the lock forever (r8). Installing early is free — releasing an empty map
    // is a no-op.
    installFleetSignalRelease();
    if (fleetHeld.has(this.path)) {
      throw new FleetError(
        5,
        "fleet-lock-reentrant",
        `this process already holds ${this.path}`,
        "release the lock before acquiring again — the fleet lock is not reentrant",
      );
    }
    const dir = dirname(this.path);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    // mkdir's mode is ignored when the directory already exists, and masked by
    // umask when it does not — set it explicitly, then verify (the same
    // discipline as FanoutRecordStore's constructor).
    chmodSync(dir, 0o700);
    const dirMode = statSync(dir).mode & 0o777;
    if (dirMode !== 0o700) {
      throw new Error(`fleet-lock dir ${dir} is mode 0${dirMode.toString(8)}, not 0700`);
    }
    for (let attempt = 0; attempt < 2; attempt++) {
      const body = JSON.stringify(ownFleetLockBody(this.requestId));
      if (claim(this.path, body)) {
        // Registered the instant the lock is ours — everything after this can
        // throw or be interrupted, and an unregistered lock is one nothing releases.
        fleetHeld.set(this.path, body);
        fsyncDir(dir);
        return;
      }
      const verdict = classifyHolder(this.path);
      if (verdict.verdict === "reclaim") {
        // Re-read immediately before the unlink and delete only the EXACT bytes
        // we judged (r10 HIGH): two contenders judging the same stale lock used
        // to both blind-rm — B's unlink deleted A's freshly claimed LIVE lock
        // and both walked away holding it. A mismatch means the path changed
        // under us; the next iteration re-classifies whatever is there now.
        let now: string;
        try {
          now = readFileSync(this.path, "utf8");
        } catch {
          continue; /* dp:ok vanished between judgment and unlink — the retry re-claims or re-classifies */
        }
        if (now === verdict.body) rmSync(this.path, { force: true });
        continue;
      }
      if (verdict.verdict === "vanished") continue; // holder finished between EEXIST and our read
      throw verdict.error;
    }
    throw new FleetError(
      5,
      "fleet-busy",
      `another fan-out holds ${this.path} (taken and released repeatedly while we waited)`,
      `wait for the other fan-out to finish — or, only if you have confirmed none is running: rm ${this.path}`,
    );
  }

  /**
   * Finally-guaranteed release. Our body → rmSync; gone already → no-op; ANY
   * other content → NEVER deleted, parked aside under a NON-.tmp orphan (K1).
   * Refuses while marked destructive unless `{force:true}`.
   *
   * `{force:true}` also covers the r10 signal-path shape: `releaseHeldFleetLocks`
   * deletes the registration but KEEPS the destructive mark, and an explicit
   * release then found no body to compare and silently no-op'd — stranding the
   * file undiagnosed forever. Forced cleanup without the registration falls
   * back to field-matching what is on disk: bytes that still name THIS
   * process/request are removed; anything else is parked, never deleted.
   */
  release(opts: { force?: boolean } = {}): void {
    const body = fleetHeld.get(this.path);
    if (body === undefined) {
      // Never held, already released, or unmarked: a plain no-op either way.
      // Only the signal-path combination (marker set, registration gone) with
      // an explicit force gets the best-effort cleanup below.
      if (!fleetDestructive.has(this.path) || opts.force !== true) return;
      fleetDestructive.delete(this.path);
      try {
        const onDisk = JSON.parse(readFileSync(this.path, "utf8")) as Partial<FleetLockBody> | null;
        let sameIdentity = false;
        try {
          sameIdentity =
            onDisk?.pid === process.pid &&
            onDisk.requestId === this.requestId &&
            onDisk.pidStartTime === observePidStart().localMs; /* dp:ok identity probe failure lands in the outer catch and parks, never rms */
        } catch {
          sameIdentity = false; /* dp:ok unobservable own identity cannot prove ownership — park below */
        }
        if (sameIdentity) {
          rmSync(this.path, { force: true });
        } else {
          parkOrphan(this.path);
        }
      } catch (e) {
        /* dp:ok ENOENT means nothing was stranded; any other read/parse failure parks via parkOrphan's own guards */
        if ((e as NodeJS.ErrnoException).code === "ENOENT") return; // already gone — done
        parkOrphan(this.path); // present but unreadable/unparseable: evidence, not ours to rm
      }
      return;
    }
    if (fleetDestructive.has(this.path) && opts.force !== true) {
      throw new Error(
        `refusing to release ${this.path}: the destructive phase began (arms being torn down) and their state is uncertain — clear it only once you know what happened, or pass {force:true} to accept that judgment yourself`,
      );
    }
    // Dropped first: a failed release must not be retried by the signal handler.
    fleetHeld.delete(this.path);
    fleetDestructive.delete(this.path);

    let before: string;
    try {
      before = readFileSync(this.path, "utf8");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return; // gone — done
      throw e;
    }
    if (before === body) {
      rmSync(this.path, { force: true });
      return;
    }
    parkOrphan(this.path);
  }
}

/**
 * What `classifyHolder` decided about the holder behind an EEXIST. A
 * `"reclaim"` verdict carries the EXACT bytes it judged: `acquire` re-reads the
 * path immediately before unlinking and removes nothing else, so a contender
 * that claimed the path in between can never be deleted out from under (r10).
 */
type HolderVerdict =
  | { verdict: "reclaim"; body: string }
  | { verdict: "vanished" }
  | { verdict: "refuse"; error: FleetError };

/**
 * Classify the holder behind an EEXIST. Returns `"reclaim"` (unlink + retry),
 * `"vanished"` (the lock disappeared — retry), or `"refuse"` with the
 * FleetError to throw.
 *
 * Order matters: the body must be JUDGED before anything else (never steal
 * what cannot be judged), then own-pid refusal is hoisted ABOVE every
 * grace/reclaim branch (r8 HIGH — a recycled predecessor's pid must refuse,
 * not reclaim), then the pid range guard (out-of-range is NOT dead), and only
 * then the two-part reclaim.
 */
function classifyHolder(path: string): HolderVerdict {
  const waitRemediation = (who: string): string =>
    `wait for that fan-out to finish — or, only if you have confirmed ${who} is gone: rm ${path}`;
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return { verdict: "vanished" };
    return {
      verdict: "refuse",
      error: new FleetError(
        5,
        "fleet-busy",
        `cannot judge the holder of ${path} (unreadable: ${(e as NodeJS.ErrnoException).code ?? (e as Error).message})`,
        `inspect the file by hand first — nothing is stolen unreadable; rm ${path} only once you know no fan-out is running`,
      ),
    };
  }
  let body: FleetLockBody | undefined;
  try {
    const parsed = JSON.parse(raw) as Partial<FleetLockBody> | null;
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      typeof parsed.pid === "number" &&
      typeof parsed.pidStartTime === "number" &&
      typeof parsed.createdAt === "string" &&
      typeof parsed.requestId === "string"
    ) {
      // The additive keys are copied ONLY when well-typed: a wrong-shaped value
      // must not reach the identity comparison as junk that always mismatches
      // and reads a live owner as recycled (r10).
      body = {
        pid: parsed.pid,
        pidStartTime: parsed.pidStartTime,
        createdAt: parsed.createdAt,
        requestId: parsed.requestId,
        ...(typeof parsed.lstartRaw === "string" ? { lstartRaw: parsed.lstartRaw } : {}),
        ...(typeof parsed.lstartUtcMs === "number" ? { lstartUtcMs: parsed.lstartUtcMs } : {}),
      };
    }
  } catch {
    body = undefined; /* dp:ok unparseable JSON is classified below as fleet-busy, never stolen */
  }
  if (body === undefined) {
    return {
      verdict: "refuse",
      error: new FleetError(
        5,
        "fleet-busy",
        `cannot judge the holder of ${path} (body ${JSON.stringify(raw.trim().slice(0, 120))})`,
        `inspect the file by hand first — nothing is stolen unreadable; rm ${path} only once you know no fan-out is running`,
      ),
    };
  }
  // Own-pid FIRST — above every grace/reclaim branch (r8 HIGH). A body with
  // our pid but not our registration is a recycled predecessor or a wedged
  // earlier claim; the fleet lock refuses (fail-closed) rather than judging
  // itself stale, unlike the run lock which can PROVE such a corpse.
  if (body.pid === process.pid) {
    return {
      verdict: "refuse",
      error: new FleetError(
        5,
        "fleet-lock-reentrant",
        `${path} records pid ${body.pid} (this process) for request ${body.requestId}, but this process holds no such lock`,
        `a previous fan-out of this process died holding the lock — confirm no arm is still running anywhere, then rm ${path}`,
      ),
    };
  }
  // Range guard BEFORE any liveness conclusion: kill(1e11, 0) throws
  // ERR_OUT_OF_RANGE — not an errno — and kill(0, 0) signals the whole process
  // group. An out-of-range pid is UNKNOWN, never dead.
  if (!Number.isInteger(body.pid) || body.pid <= 0 || body.pid > 0x7fff_ffff) {
    return {
      verdict: "refuse",
      error: new FleetError(
        5,
        "fleet-busy",
        `${path} records an unusable pid ${body.pid} (request ${body.requestId})`,
        `check whether request ${body.requestId} is running anywhere that shares this directory; rm ${path} only once you are sure it is not`,
      ),
    };
  }
  // Wall clock (Date.now/Date.parse) for CROSS-PROCESS age — monotonic
  // performance.now() cannot span processes. An unparseable createdAt reads as
  // young: fail closed toward refusal, never toward a steal.
  const at = Date.parse(body.createdAt);
  const aged = Number.isFinite(at) && Date.now() - at > FLEET_LOCK_STALE_MS;
  if (!aged) {
    return {
      verdict: "refuse",
      error: new FleetError(
        5,
        "fleet-busy",
        `another fan-out holds ${path} (request ${body.requestId}, pid ${body.pid}, created ${body.createdAt})`,
        waitRemediation(`that fan-out (pid ${body.pid})`),
      ),
    };
  }
  if (!isAlive(body.pid)) return { verdict: "reclaim", body: raw }; // aged AND dead: both parts satisfied
  let observed: PidIdentity;
  try {
    observed = observePidStart(body.pid);
  } catch (e) {
    // Identity unobservable — the one holder that must not be judged.
    return {
      verdict: "refuse",
      error: new FleetError(
        5,
        "fleet-busy",
        `another fan-out holds ${path} (request ${body.requestId}, pid ${body.pid}) and its identity could not be verified: ${(e as Error).message}`,
        waitRemediation(`pid ${body.pid}`),
      ),
    };
  }
  // Identity, TZ-proof when both sides recorded it (r10): the UTC-converted
  // components are compared instead of the legacy local-time epochs, whose
  // values shift with each observer's TZ. Bodies without the additive keys
  // (older builds, planted fixtures) keep the numeric comparison.
  const sameProcess =
    body.lstartUtcMs !== undefined && observed.lstartUtcMs !== undefined
      ? observed.lstartUtcMs === body.lstartUtcMs
      : observed.localMs === body.pidStartTime;
  if (!sameProcess) return { verdict: "reclaim", body: raw }; // aged AND recycled pid: the recorded owner is provably gone
  // Aged + alive + identity match: a first fan-out inside teardown is never
  // preempted, however old the lock looks.
  return {
    verdict: "refuse",
    error: new FleetError(
      5,
      "fleet-busy",
      `another fan-out holds ${path} (request ${body.requestId}, pid ${body.pid}, alive and still the same process despite age ${Math.round((Date.now() - at) / 1000)}s)`,
      waitRemediation(`that fan-out (pid ${body.pid})`),
    ),
  };
}

/** Best-effort durability for the directory entry the link created. */
function fsyncDir(dir: string): void {
  let dfd: number | undefined;
  try {
    dfd = openSync(dir, "r");
    fsyncSync(dfd);
  } catch {
    // Not every platform/filesystem permits fsync on a directory handle; the
    // link is the mutual-exclusion boundary, the fsync only its durability.
  } finally {
    if (dfd !== undefined) closeSync(dfd);
  }
}
