/**
 * Fleet patterns as code (DF3.2) — sections 1 and 2:
 *
 *   1. the fan-out record store (AC9) — one JSON record per fan-out under
 *      `.sandbox/fanouts/`, mirroring RunRecordStore's O_EXCL-create /
 *      lock-guarded atomicReplace discipline (run-record.ts);
 *   2. the single-operator fleet lock (AC8) — `.sandbox/fleet.lock`, composed
 *      over scripts/lib/run-lock.ts's hardened primitives (this story made
 *      `claim`/`writeLockDirect`/`isAlive`/`hostTag` reachable with four
 *      additive `export` keywords) rather than a second lock implementation
 *      that would replay the exact bug families DF3.1 spent review rounds
 *      3/5/6/8/9 fixing.
 *
 * Section 3 — the primitive, the three patterns and the race poller — lands
 * separately in this same module (Wave-1b agent B).
 */

import { randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";

import { acquireRunLock, claim, isAlive, releaseRunLock } from "../../scripts/lib/run-lock.ts";
import { newId } from "../providers/run-record.ts";
import { log } from "../swarmclaw/log.ts";
import { FleetError } from "./dispatch.ts";

// ---------------------------------------------------------------------------
// Section 1 — the fan-out record store (AC9)
// ---------------------------------------------------------------------------

/** One arm of a fan-out, joined back to its run record by `runId`. */
export interface FanoutArm {
  arm: number;
  runId: string;
  rosterId?: string;
  briefHash: string;
}

/** AC9 record schema — frozen. No field may be added without changing the AC. */
export interface FanoutRecord {
  fanoutId: string; // mintFanoutId(): "fan-YYYYMMDD-<6hex>"
  requestId: string; // CC-9 join key propagated into every arm
  pattern: "best-of-n" | "many-stories" | "race";
  n: number;
  pin: string | null; // brief.commitSha for best-of-n/race; null for many-stories
  createdAt: string;
  arms: FanoutArm[];
  winner: number | null; // race only; atomic first-writer transition
  rankedAt: string | null;
  closedAt: string | null;
}

/** The grammar a fan-out id may carry — mirrors `mintFanoutId()`'s output. */
export const FANOUT_ID_RE = /^fan-\d{8}-[a-f0-9]{6}$/;

export const DEFAULT_FANOUTS_DIR = ".sandbox/fanouts";

/** Same chain shape as `resolveRunsDir`: one copy, so callers cannot disagree. */
export function resolveFanoutsDir(dir?: string): string {
  return dir ?? process.env.QDS_FANOUTS_DIR ?? DEFAULT_FANOUTS_DIR;
}

/** `fan-<YYYYMMDD>-<6 hex>` — a NEW prefix, never `mintRunId()` reuse. */
export function mintFanoutId(now: Date = new Date()): string {
  return newId("fan", now);
}

export function assertValidFanoutId(id: unknown): asserts id is string {
  if (typeof id !== "string" || !FANOUT_ID_RE.test(id)) {
    throw new Error(`invalid fan-out id: ${JSON.stringify(id)} (must match ${FANOUT_ID_RE.source})`);
  }
}

const PATTERNS: readonly string[] = ["best-of-n", "many-stories", "race"];

export interface FanoutRecordStoreOptions {
  /** Records directory. Defaults to `$QDS_FANOUTS_DIR` or `.sandbox/fanouts`. */
  dir?: string;
  /** Propagated into every mutation log line. */
  requestId?: string;
  /** `false` opens the store for READING only — see RunRecordStore's rationale. */
  create?: boolean;
}

/**
 * Mirrors RunRecordStore's discipline (run-record.ts): constructor mkdirs the
 * dir 0700 and verifies; a `{create:false}` store reads but refuses every
 * mutation rather than skipping the posture proof. INV-3 no-overwrite: create
 * is O_EXCL and EEXIST propagates. INV-4 fail-closed listing: an unreadable
 * `.json` makes `list()` THROW naming the file — a dropped record is a
 * fan-out nobody can rank, close or audit.
 *
 * Validation happens BEFORE construction can commit anything: every persisted
 * body must satisfy `validateFanoutRecord`, on write and on read alike.
 */
export class FanoutRecordStore {
  readonly dir: string;
  private readonly writable: boolean;
  private readonly requestId: string;

  constructor(opts: FanoutRecordStoreOptions | string = {}) {
    const o: FanoutRecordStoreOptions = typeof opts === "string" ? { dir: opts } : opts;
    this.dir = resolveFanoutsDir(o.dir);
    this.requestId = o.requestId ?? crypto.randomUUID();
    this.writable = o.create ?? true;
    if (!this.writable) {
      let isDir: boolean;
      try {
        isDir = statSync(this.dir).isDirectory();
      } catch (e) {
        const code = (e as NodeJS.ErrnoException).code;
        const err = new Error(`fan-outs dir ${this.dir} is unreadable: ${code ?? (e as Error).message}`);
        if (code !== undefined) (err as NodeJS.ErrnoException).code = code;
        throw err;
      }
      if (!isDir) throw new Error(`fan-outs dir ${this.dir} is not a directory`);
      return;
    }
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    // mkdir's mode is ignored when the directory already exists, and masked by
    // umask when it does not — set it explicitly, then verify (INV-5).
    chmodSync(this.dir, 0o700);
    const dirMode = statSync(this.dir).mode & 0o777;
    if (dirMode !== 0o700) {
      throw new Error(`fan-outs dir ${this.dir} is mode 0${dirMode.toString(8)}, not 0700`);
    }
  }

  /** INV-3: O_EXCL, never a check-then-write. A second create rejects with EEXIST. */
  create(record: FanoutRecord): FanoutRecord {
    return this.traced("create", () => {
      this.assertWritable();
      const validated = validateFanoutRecord(`${record.fanoutId}.json`, record.fanoutId, record);
      const p = this.path(validated.fanoutId);
      // EEXIST propagates — never overwrite. Every other errno keeps its
      // identity so the CLI can map it.
      const fd = openSync(p, "wx", 0o600);
      try {
        writeFileSync(fd, serializeRecord(validated));
        fsyncSync(fd);
      } catch (e) {
        closeSync(fd);
        rmQuiet(p);
        throw e;
      }
      closeSync(fd);
      fsyncDir(this.dir);
      return validated;
    });
  }

  /** Typed ENOENT rides the error's `code` — the CLI maps it to exit 4. */
  get(fanoutId: string): FanoutRecord {
    assertValidFanoutId(fanoutId);
    const p = this.path(fanoutId);
    return readFanoutRecord(p, fanoutId);
  }

  /**
   * Read-modify-write under `<dir>/<fanoutId>.lock`, taken with run-lock's
   * exported `acquireRunLock` — the SAME hardened invocation lock the CLIs
   * use, so steal/refuse/SIGINT handling is inherited, not re-derived.
   *
   * `winner`'s first-writer transition is a `mutate()` whose fn refuses when
   * `winner !== null`; the per-id lock is what makes that transition atomic.
   * A throwing fn leaves the file byte-identical.
   */
  mutate(fanoutId: string, fn: (rec: FanoutRecord) => FanoutRecord): FanoutRecord {
    return this.traced("mutate", () => {
      this.assertWritable();
      assertValidFanoutId(fanoutId);
      // SOURCE WINS over the spec's `acquireRunLock(join(dir), "<id>.json")`
      // spelling: acquireRunLock validates its id against RUN_ID_RE, whose
      // grammar has no ".", so the ".json" suffix throws before a lock exists.
      // Passing the bare id yields `<fanoutId>.lock` — same directory, same
      // discipline. (Reported as a proposed correction.)
      const lock = acquireRunLock(this.dir, fanoutId, "fanout-record");
      try {
        const next = validateFanoutRecord(
          this.path(fanoutId),
          fanoutId,
          fn(readFanoutRecord(this.path(fanoutId), fanoutId)),
        );
        this.atomicReplace(fanoutId, next);
        return next;
      } finally {
        releaseRunLock(lock);
      }
    });
  }

  /**
   * INV-4 fail-closed: EVERY `.json` must parse and validate. An unreadable
   * or malformed sibling makes this accessor THROW naming each offending file
   * — never a quiet skip, never a partial listing.
   */
  list(): FanoutRecord[] {
    return this.traced("list", () => {
      const records: FanoutRecord[] = [];
      const bad: string[] = [];
      for (const name of readdirSync(this.dir).sort()) {
        if (!name.endsWith(".json")) continue;
        const stem = name.slice(0, -".json".length);
        try {
          records.push(readFanoutRecord(join(this.dir, name), stem));
        } catch (e) {
          bad.push(`${name}: ${(e as Error).message}`);
        }
      }
      if (bad.length > 0) {
        throw new Error(
          `refusing to return a partial fan-out listing from ${this.dir}: ${bad.length} file(s) could not be read as a fan-out record (${bad.join("; ")})`,
        );
      }
      return records;
    });
  }

  path(fanoutId: string): string {
    return join(this.dir, `${fanoutId}.json`);
  }

  private assertWritable(): void {
    if (this.writable) return;
    throw new Error(
      `fan-out record store for ${this.dir} was opened read-only (create: false); construct it without create: false to write`,
    );
  }

  /** Write-temp-then-rename. There is no in-place partial-write path (INV-3). */
  private atomicReplace(fanoutId: string, rec: FanoutRecord): void {
    const p = this.path(fanoutId);
    const tmp = `${p}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
    const fd = openSync(tmp, "wx", 0o600);
    let fdOpen = true;
    try {
      writeFileSync(fd, serializeRecord(rec));
      fsyncSync(fd);
      fdOpen = false;
      closeSync(fd);
      renameSync(tmp, p);
    } catch (e) {
      if (fdOpen) closeSync(fd);
      rmQuiet(tmp);
      throw e;
    }
  }

  private traced<T>(verb: string, fn: () => T): T {
    const started = Date.now();
    try {
      const out = fn();
      this.emit(verb, started, "ok");
      return out;
    } catch (e) {
      this.emit(verb, started, "error", {
        code: (e as NodeJS.ErrnoException).code ?? "fanout_record_error",
        message: (e as Error).message,
      });
      throw e;
    }
  }

  private emit(verb: string, started: number, status: "ok" | "error", error?: { code: string; message: string }): void {
    try {
      log({
        requestId: this.requestId,
        operation: `fanout-record.${verb}`,
        agentId: null,
        timestamp: new Date().toISOString(),
        duration: Date.now() - started,
        status,
        ...(error ? { error } : {}),
      });
    } catch {
      // A raising sink must never replace the caller's real outcome.
    }
  }
}

function serializeRecord(rec: FanoutRecord): string {
  return `${JSON.stringify(rec, null, 2)}\n`;
}

/** Structural gate for every persisted body — on write AND on read. */
function validateFanoutRecord(source: string, expectedId: string, raw: unknown): FanoutRecord {
  const malformed = (why: string): Error =>
    new Error(`malformed fan-out record ${source.split("/").pop() ?? source}: ${why}`);
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw malformed("not an object");
  const r = raw as Record<string, unknown>;
  if (r.fanoutId !== expectedId) throw malformed(`fanoutId is ${JSON.stringify(r.fanoutId)}, expected ${expectedId}`);
  if (typeof r.requestId !== "string" || r.requestId === "") throw malformed("requestId missing");
  if (typeof r.pattern !== "string" || !PATTERNS.includes(r.pattern)) throw malformed(`unknown pattern: ${String(r.pattern)}`);
  if (!Number.isInteger(r.n) || (r.n as number) < 1) throw malformed(`n is ${JSON.stringify(r.n)}`);
  if (r.pin !== null && typeof r.pin !== "string") throw malformed("pin must be a string or null");
  if (typeof r.createdAt !== "string" || Number.isNaN(Date.parse(r.createdAt))) {
    throw malformed("createdAt is not a parseable ISO timestamp");
  }
  if (!Array.isArray(r.arms)) throw malformed("arms is not an array");
  for (const arm of r.arms) {
    const a = arm as Record<string, unknown>;
    if (!Number.isInteger(a.arm) || (a.arm as number) < 0) throw malformed(`arm index ${JSON.stringify(a.arm)}`);
    if (typeof a.runId !== "string" || a.runId === "") throw malformed("an arm is missing its runId");
    if (typeof a.briefHash !== "string" || a.briefHash === "") throw malformed("an arm is missing its briefHash");
    if (a.rosterId !== undefined && typeof a.rosterId !== "string") throw malformed("rosterId must be a string");
  }
  if (r.winner !== null && !Number.isInteger(r.winner)) throw malformed("winner must be an integer or null");
  for (const key of ["rankedAt", "closedAt"] as const) {
    const v = r[key];
    if (v !== null && v !== undefined && (typeof v !== "string" || Number.isNaN(Date.parse(v)))) {
      throw malformed(`${key} must be a parseable timestamp or null`);
    }
  }
  return r as unknown as FanoutRecord;
}

function readFanoutRecord(p: string, expectedId: string): FanoutRecord {
  let raw: string;
  try {
    raw = readFileSync(p, "utf8");
  } catch (e) {
    // Preserve the errno — the CLI maps ENOENT to exit 4 off the TYPED code.
    if ((e as NodeJS.ErrnoException).code === "ENOENT") {
      const err = new Error(`no such fan-out record: ${p.split("/").pop()}`);
      (err as NodeJS.ErrnoException).code = "ENOENT";
      throw err;
    }
    throw e;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new Error(`malformed fan-out record ${p.split("/").pop()}: ${(e as Error).message}`);
  }
  return validateFanoutRecord(p, expectedId, parsed);
}

// ---------------------------------------------------------------------------
// Section 2 — the fleet lock (AC8)
// ---------------------------------------------------------------------------

export const FLEET_LOCK_PATH = ".sandbox/fleet.lock";

/** Past this age, staleness is CANDIDATE — identity still decides (see classify). */
export const FLEET_LOCK_STALE_MS = 3_600_000;

/** Story-mandated body — JSON, mode 0600. Distinct from run-lock's whitespace body. */
export interface FleetLockBody {
  pid: number;
  pidStartTime: number;
  createdAt: string;
  requestId: string;
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
  return process.platform === "linux" ? procStatStartTime(pid) : psLstartStartTime(pid);
}

function procStatStartTime(pid: number): number {
  const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
  // After the LAST ')': state is field 3, so starttime (field 22) sits at
  // remainder index 19 (proc_pid_stat(5)).
  const rest = stat.slice(stat.lastIndexOf(")") + 1).trim().split(/\s+/);
  const ticks = Number(rest[19]);
  const btime = /^btime (\d+)/m.exec(readFileSync("/proc/stat", "utf8"))?.[1];
  if (!Number.isFinite(ticks) || btime === undefined) {
    throw new Error(`could not read start time of pid ${pid} from /proc`);
  }
  return Number(btime) * 1000 + Math.floor((ticks / CLK_TCK) * 1000);
}

function psLstartStartTime(pid: number): number {
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
  // LOCAL time, no TZ designator: construct in local time, never Date.UTC.
  return new Date(Number(m[6]), month, Number(m[2]), Number(m[3]), Number(m[4]), Number(m[5])).getTime();
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
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    for (let attempt = 0; attempt < 2; attempt++) {
      const body = JSON.stringify({
        pid: process.pid,
        pidStartTime: readOwnPidStartTime(),
        createdAt: new Date().toISOString(),
        requestId: this.requestId,
      } satisfies FleetLockBody);
      if (claim(this.path, body)) {
        // Registered the instant the lock is ours — everything after this can
        // throw or be interrupted, and an unregistered lock is one nothing releases.
        fleetHeld.set(this.path, body);
        fsyncDir(dirname(this.path));
        return;
      }
      const verdict = classifyHolder(this.path);
      if (verdict === "reclaim") {
        rmSync(this.path, { force: true });
        continue; // retry claim once — a third contender taking it here is real contention
      }
      if (verdict === "vanished") continue; // holder finished between EEXIST and our read
      throw verdict;
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
   */
  release(opts: { force?: boolean } = {}): void {
    const body = fleetHeld.get(this.path);
    if (body === undefined) return; // never held (or already released): no-op
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
 * Classify the holder behind an EEXIST. Returns `"reclaim"` (unlink + retry),
 * `"vanished"` (the lock disappeared — retry), or the FleetError to throw.
 *
 * Order matters: the body must be JUDGED before anything else (never steal
 * what cannot be judged), then own-pid refusal is hoisted ABOVE every
 * grace/reclaim branch (r8 HIGH — a recycled predecessor's pid must refuse,
 * not reclaim), then the pid range guard (out-of-range is NOT dead), and only
 * then the two-part reclaim.
 */
function classifyHolder(path: string): "reclaim" | "vanished" | FleetError {
  const waitRemediation = (who: string): string =>
    `wait for that fan-out to finish — or, only if you have confirmed ${who} is gone: rm ${path}`;
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return "vanished";
    return new FleetError(
      5,
      "fleet-busy",
      `cannot judge the holder of ${path} (unreadable: ${(e as NodeJS.ErrnoException).code ?? (e as Error).message})`,
      `inspect the file by hand first — nothing is stolen unreadable; rm ${path} only once you know no fan-out is running`,
    );
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
      body = parsed as FleetLockBody;
    }
  } catch {
    body = undefined;
  }
  if (body === undefined) {
    return new FleetError(
      5,
      "fleet-busy",
      `cannot judge the holder of ${path} (body ${JSON.stringify(raw.trim().slice(0, 120))})`,
      `inspect the file by hand first — nothing is stolen unreadable; rm ${path} only once you know no fan-out is running`,
    );
  }
  // Own-pid FIRST — above every grace/reclaim branch (r8 HIGH). A body with
  // our pid but not our registration is a recycled predecessor or a wedged
  // earlier claim; the fleet lock refuses (fail-closed) rather than judging
  // itself stale, unlike the run lock which can PROVE such a corpse.
  if (body.pid === process.pid) {
    return new FleetError(
      5,
      "fleet-lock-reentrant",
      `${path} records pid ${body.pid} (this process) for request ${body.requestId}, but this process holds no such lock`,
      `a previous fan-out of this process died holding the lock — confirm no arm is still running anywhere, then rm ${path}`,
    );
  }
  // Range guard BEFORE any liveness conclusion: kill(1e11, 0) throws
  // ERR_OUT_OF_RANGE — not an errno — and kill(0, 0) signals the whole process
  // group. An out-of-range pid is UNKNOWN, never dead.
  if (!Number.isInteger(body.pid) || body.pid <= 0 || body.pid > 0x7fff_ffff) {
    return new FleetError(
      5,
      "fleet-busy",
      `${path} records an unusable pid ${body.pid} (request ${body.requestId})`,
      `check whether request ${body.requestId} is running anywhere that shares this directory; rm ${path} only once you are sure it is not`,
    );
  }
  // Wall clock (Date.now/Date.parse) for CROSS-PROCESS age — monotonic
  // performance.now() cannot span processes. An unparseable createdAt reads as
  // young: fail closed toward refusal, never toward a steal.
  const at = Date.parse(body.createdAt);
  const aged = Number.isFinite(at) && Date.now() - at > FLEET_LOCK_STALE_MS;
  if (!aged) {
    return new FleetError(
      5,
      "fleet-busy",
      `another fan-out holds ${path} (request ${body.requestId}, pid ${body.pid}, created ${body.createdAt})`,
      waitRemediation(`that fan-out (pid ${body.pid})`),
    );
  }
  if (!isAlive(body.pid)) return "reclaim"; // aged AND dead: both parts satisfied
  let observed: number;
  try {
    observed = readOwnPidStartTime(body.pid);
  } catch (e) {
    // Identity unobservable — the one holder that must not be judged.
    return new FleetError(
      5,
      "fleet-busy",
      `another fan-out holds ${path} (request ${body.requestId}, pid ${body.pid}) and its identity could not be verified: ${(e as Error).message}`,
      waitRemediation(`pid ${body.pid}`),
    );
  }
  if (observed === body.pidStartTime) {
    // Aged + alive + identity match: a first fan-out inside teardown is never
    // preempted, however old the lock looks.
    return new FleetError(
      5,
      "fleet-busy",
      `another fan-out holds ${path} (request ${body.requestId}, pid ${body.pid}, alive and still the same process despite age ${Math.round((Date.now() - at) / 1000)}s)`,
      waitRemediation(`that fan-out (pid ${body.pid})`),
    );
  }
  return "reclaim"; // aged AND recycled pid: the recorded owner is provably gone
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

/** `rm -f` that cannot throw — pure-hygiene cleanups only. */
function rmQuiet(p: string): void {
  try {
    rmSync(p, { force: true });
  } catch {
    // Inert litter; a later sweep or operator clears it.
  }
}
