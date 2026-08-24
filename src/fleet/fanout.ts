/**
 * Fleet patterns as code (DF3.2) — section 1: the fan-out record store (AC9).
 *
 * One JSON record per fan-out under `.sandbox/fanouts/`, mirroring
 * RunRecordStore's O_EXCL-create / lock-guarded atomicReplace discipline
 * (run-record.ts). The single-operator fleet lock lives beside this module in
 * `./fleet-lock.ts` (split out under D1's sanctioned escape clause,
 * orchestrator-approved).
 *
 * Section 3 — the primitive, the three patterns and the race poller — lives in
 * `./fanout-primitive.ts` (split under D1's sanctioned escape clause once
 * sections 1+3 together crossed the line ceiling; orchestrator-approved for
 * wave-1b agent B). This module stays the store only; the split is acyclic
 * (primitive → store/lock, never back).
 */

import { randomBytes } from "node:crypto";
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
import { join } from "node:path";

import { acquireRunLock, releaseRunLock } from "../../scripts/lib/run-lock.ts";
import { newId } from "../providers/run-record.ts";
import { log } from "../swarmclaw/log.ts";

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
      // Mirror create()'s durability: without it a crash can resurrect the
      // pre-mutate record, and the race decision is this store's least
      // durable state.
      fsyncDir(this.dir);
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
    // The cast below lies about null: `(null as Record<…>).arm` throws a bare
    // TypeError that escapes the descriptive malformed taxonomy this gate
    // exists to provide (get() would surface "Cannot read properties of null"
    // instead of naming the record and field).
    if (typeof arm !== "object" || arm === null) {
      throw malformed(`an arms element is ${JSON.stringify(arm)}, not an object`);
    }
    const a = arm as Record<string, unknown>;
    if (!Number.isInteger(a.arm) || (a.arm as number) < 0) throw malformed(`arm index ${JSON.stringify(a.arm)}`);
    if (typeof a.runId !== "string" || a.runId === "") throw malformed("an arm is missing its runId");
    if (typeof a.briefHash !== "string" || a.briefHash === "") throw malformed("an arm is missing its briefHash");
    if (a.rosterId !== undefined && typeof a.rosterId !== "string") throw malformed("rosterId must be a string");
  }
  // winner indexes arms — an out-of-range value validates into rank/close and
  // mis-drives their teardown decisions. (arms:[] is LEGITIMATE here: create()
  // writes it before the fill-mutate attaches the minted ids, so emptiness is
  // never refused.)
  if (
    r.winner !== null &&
    (!Number.isInteger(r.winner) || (r.winner as number) < 0 || (r.winner as number) >= r.arms.length)
  ) {
    throw malformed(`winner ${JSON.stringify(r.winner)} does not index arms (length ${r.arms.length})`);
  }
  for (const key of ["rankedAt", "closedAt"] as const) {
    const v = r[key];
    if (v !== null && v !== undefined && (typeof v !== "string" || Number.isNaN(Date.parse(v)))) {
      throw malformed(`${key} must be a parseable timestamp or null`);
    }
  }
  return r as unknown as FanoutRecord; /* dp:ok validate-then-cast: every field of FanoutRecord is checked above */
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
// Section 3 (the primitive, patterns, race poller) lives in
// ./fanout-primitive.ts — D1 escape-clause split, see this file's header.
// Only its shared fs helpers remain below.
// ---------------------------------------------------------------------------

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

/**
 * `rm -f` that cannot throw — pure-hygiene cleanups only.
 *
 * Exported for ./fanout-primitive.ts, which already sits downstream of this
 * module (store → primitive, never back): one copy in the slice beats two
 * that can drift. `fsyncDir` stays module-private per file on purpose —
 * sharing it with fleet-lock.ts would couple the lock module to the store
 * module it must sit beneath.
 */
export function rmQuiet(p: string): void {
  try {
    rmSync(p, { force: true });
  } catch {
    // Inert litter; a later sweep or operator clears it.
  }
}
