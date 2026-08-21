/**
 * Run records — one JSON file per run on the host (DF2.1).
 *
 * The record is created BEFORE any billable infrastructure exists (INV-1), so a
 * crash anywhere afterwards leaves teardown a handle to work from. It is a
 * greppable, mode-0600 public artifact: `keyHash` is the only credential-derived
 * field and no key material is ever written into it (INV-2).
 *
 * Discipline enforced here:
 *  - INV-3 no-overwrite: `create()` opens with O_WRONLY|O_CREAT|O_EXCL (`wx`),
 *    never an existence check. Updates write a sibling temp file and `rename` it
 *    over the record — there is no in-place partial-write path.
 *  - INV-4 accountability: `list()` throws naming a malformed/unreadable record
 *    rather than skipping it. A dropped record is a key nobody revokes.
 *  - INV-5 fail-closed: if O_EXCL or mode 0600 cannot be honoured on the running
 *    platform, the constructor throws and no run starts.
 *
 * The twelve core fields are closed. The single sanctioned additive surface is
 * `extensions`, an allow-listed per-namespace map (not an open map).
 */

import { randomBytes } from "node:crypto";
import {
  chmodSync,
  closeSync,
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
import { log, newRequestId } from "../swarmclaw/log.ts";

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

/** Value shapes the core schema admits. */
export type FieldKind = "string" | "int" | "ports";

/**
 * The twelve core fields. These camelCase spellings are the only ones any
 * consumer writes or asserts against — the snake_case forms belong to DF2.8's
 * SQLite ledger columns, a different store with its own schema.
 *
 * Exported so the CLI derives its coercion/flag tables from this one table
 * instead of duplicating it.
 */
export const CORE_FIELDS: Readonly<Record<string, FieldKind>> = {
  runId: "string",
  vmName: "string",
  httpsUrl: "string",
  keyHash: "string",
  limitMicroUsd: "int",
  spendMicroUsd: "int",
  sessionId: "string",
  commitSha: "string",
  ports: "ports",
  pid: "int",
  createdAt: "string",
  closedAt: "string",
};

/** Set once at `create()`; never rewritable. */
export const IMMUTABLE_FIELDS: ReadonlySet<string> = new Set(["runId", "createdAt"]);

/**
 * Core fields a caller may write via `set()`: the twelve minus `runId`/`createdAt`
 * (immutable) and `closedAt` (`close()`'s alone). Exported so the CLI derives its
 * flag table from this one constant — the writable-field policy lives only here,
 * not half-here and half in the CLI.
 */
export const SETTABLE_FIELDS: readonly string[] = Object.keys(CORE_FIELDS).filter(
  (f) => !IMMUTABLE_FIELDS.has(f) && f !== "closedAt",
);

/** Costs are integer micro-dollars — sub-cent role splits are not float-representable (DD-9). */
export interface RunRecord {
  runId: string;
  createdAt: string;
  vmName?: string;
  httpsUrl?: string;
  keyHash?: string;
  limitMicroUsd?: number;
  spendMicroUsd?: number;
  sessionId?: string;
  commitSha?: string;
  ports?: number[];
  pid?: number;
  closedAt?: string;
  extensions?: RunRecordExtensions;
}

export interface ExtensionEntry {
  schemaVersion: number;
  [field: string]: string | number;
}

export type RunRecordExtensions = Record<string, ExtensionEntry>;

/** Extension fields as a caller supplies them — `schemaVersion` is the store's to stamp. */
export type ExtensionPatch = Record<string, Record<string, string | number>>;

/**
 * Fields a caller may write. `runId`/`createdAt` are immutable and `closedAt` is
 * `close()`'s, so none of the three appear here — and there is no index
 * signature, so `set(id, { vmNmae })` is a compile error as well as a runtime
 * one. AC2's runtime rejection stays the authority for dynamic callers (the CLI
 * builds its patch from argv).
 */
export type RunRecordPatch = Partial<Omit<RunRecord, "runId" | "createdAt" | "closedAt" | "extensions">> & {
  extensions?: ExtensionPatch;
};

/**
 * Allow-listed extension namespaces. Each owning story registers its sub-key and
 * its field shapes here; anything else is rejected exactly like an unknown core
 * key. `schemaVersion` is stamped by the store, not supplied by the caller.
 */
export const EXTENSION_NAMESPACES: Readonly<
  Record<string, { schemaVersion: number; fields: Readonly<Record<string, FieldKind>> }>
> = {
  /** DF5.2 */
  pr: { schemaVersion: 1, fields: { prUrl: "string", prNumber: "int" } },
  /** DF6.1 */
  fixLoop: { schemaVersion: 1, fields: { fixContext: "string", fixOutcome: "string" } },
  /** DF3.2 */
  fanout: { schemaVersion: 1, fields: { fanoutId: "string", arm: "string" } },
  /**
   * DF2.8: the budget gate's admission decision, written by `createRun` when the
   * dispatch carries an issue ref. `admittedCeilingMicroUsd` is the one clamped
   * ceiling handed to DF2.3's mint; `repoSlug`/`issueId` are what teardown's
   * box-hours hook reads to attribute the run's box-hours row.
   *
   * Ceiling formula: admittedCeilingMicroUsd = min(keyCap, remaining headroom)
   * where remaining headroom = capMicroUsd - spentMicroUsd - reservedMicroUsd.
   */
  budget: {
    schemaVersion: 1,
    fields: {
      repoSlug: "string",
      issueId: "string",
      capMicroUsd: "int",
      spentMicroUsd: "int",
      reservedMicroUsd: "int",
      admittedCeilingMicroUsd: "int",
    },
  },
};

// ---------------------------------------------------------------------------
// Run ids
// ---------------------------------------------------------------------------

/**
 * Hostname grammar. The id becomes the box name and the box name becomes a
 * public hostname, so anything outside this grammar is refused before a path is
 * built — `path()` is the one function every verb routes through.
 */
const RUN_ID_RE = /^[a-z0-9][a-z0-9-]*$/;
const RUN_ID_MAX = 63;

/** How long a writer waits for another process's record lock before giving up. */
const LOCK_TIMEOUT_MS = 5_000;

export function assertValidRunId(id: unknown): asserts id is string {
  if (typeof id !== "string" || id.length === 0 || id.length > RUN_ID_MAX || !RUN_ID_RE.test(id)) {
    throw new Error(
      `invalid run id: ${JSON.stringify(id)} (must match ${RUN_ID_RE.source} and be <= ${RUN_ID_MAX} chars)`,
    );
  }
}

/** `<slug>-<YYYYMMDD>-<6 hex>`. Ids are generated, never supplied. */
export function newId(slug: string, now: Date = new Date()): string {
  const day = now.toISOString().slice(0, 10).replace(/-/g, "");
  const id = `${slug}-${day}-${randomBytes(3).toString("hex")}`;
  // Validate the composed id, not the slug: a slug that is legal alone but
  // overflows 63 chars once dated must fail here rather than at create().
  assertValidRunId(id);
  return id;
}

// ---------------------------------------------------------------------------
// INV-2: no key material, anywhere in the record
// ---------------------------------------------------------------------------

const SECRET_PREFIXES = [
  "sk-",
  "sk_live_",
  "sk_test_",
  "ghp_",
  "gho_",
  "github_pat_",
  "xoxb-",
  "xoxp-",
  "AKIA",
  "ASIA",
  "-----BEGIN",
];

/**
 * ponytail: prefix list + a mixed-class long-token heuristic, not an entropy
 * model. It catches the credential shapes this factory actually mints; upgrade
 * to a real detector only if a leak gets past it.
 *
 * `shape: false` (used only for `keyHash`) skips the LENGTH heuristic, because a
 * base64 sha256 is a 44-char mixed-class token. The prefix scan still runs: no
 * digest starts with `sk-` or `-----BEGIN`, so the one field an operator can
 * fat-finger a raw key into is not the one field that accepts it.
 *
 * The mixed-class requirement is load-bearing, not decoration. A 40-char git SHA
 * is all-lowercase hex and a run id is all-lowercase hostname text, so a
 * length-only rule would reject `commitSha` and `vmName` — the very fields this
 * record exists to hold — and it would do it AFTER the box was created.
 */
function assertNoSecret(key: string, value: unknown, opts: { shape?: boolean } = {}): void {
  if (typeof value !== "string") return;
  const v = value.trim();
  // Matched at a token boundary, not just at position 0: a credential can ride
  // inside a URL query (`?token=sk-…`). Anchoring only at the start would miss
  // that, and a bare substring test would trip on `task-runner` containing `sk-`.
  for (const p of SECRET_PREFIXES) {
    if (new RegExp(`(^|[^A-Za-z0-9])${p.replace(/[.*+?^\${}()|[\]\\-]/g, "\\$&")}`).test(v)) {
      throw new Error(`refusing to write key material into the run record: ${key}`);
    }
  }
  if (opts.shape === false) return;
  // A URL is a long punctuated token by nature and `httpsUrl`/`prUrl` are
  // first-class fields here, so the shape test does not apply to one.
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(v)) return;
  // The charset must cover base64 and PEM-ish payloads (`/`, `+`, `=`, `.`) —
  // an AWS secret access key and a JWT both carry them, and a charset of only
  // `[A-Za-z0-9_-]` would wave both through while catching nothing but tokens
  // that no issuer mints.
  const mixedClass = /[a-z]/.test(v) && /[A-Z]/.test(v) && /\d/.test(v);
  if (v.length >= 40 && mixedClass && /^[A-Za-z0-9+/=_.:-]+$/.test(v)) {
    throw new Error(`refusing to write key material into the run record: ${key}`);
  }
}

// ---------------------------------------------------------------------------
// Value validation
// ---------------------------------------------------------------------------

function assertKind(key: string, kind: FieldKind, value: unknown): void {
  if (kind === "string") {
    if (typeof value !== "string") throw new Error(`${key} must be a string`);
    return;
  }
  if (kind === "int") {
    if (typeof value !== "number" || !Number.isInteger(value)) {
      throw new Error(`${key} must be an integer`);
    }
    return;
  }
  if (!Array.isArray(value) || value.some((p) => typeof p !== "number" || !Number.isInteger(p))) {
    throw new Error(`${key} must be an array of integers`);
  }
}

/**
 * Validate `extensions` against the allow-list and stamp each namespace's
 * `schemaVersion`. An unregistered namespace, an unregistered field, a bad shape
 * or a credential-shaped value is rejected with the offending key named.
 *
 * `mode` splits write from read deliberately. On WRITE the allow-list is exact:
 * this process is the one adding the data, so a typo must not land. On READ a
 * *newer* `schemaVersion` and its unfamiliar fields inside an already-registered
 * namespace are tolerated, because rejecting them would make `list()` throw and
 * INV-4 turns that into a fleet-wide outage — one newer writer (or one rollback)
 * would stop the reaper from reaping anything at all, which is the unbounded
 * spend INV-4 exists to prevent. An UNREGISTERED namespace stays a hard error on
 * both paths: that is a record nobody can account for, not a version skew.
 */
function validateExtensions(
  patch: unknown,
  existing: RunRecordExtensions | undefined,
  mode: "read" | "write" = "write",
): RunRecordExtensions {
  if (typeof patch !== "object" || patch === null || Array.isArray(patch)) {
    throw new Error("extensions must be an object");
  }
  const merged: RunRecordExtensions = structuredClone(existing ?? {});
  for (const [ns, body] of Object.entries(patch as Record<string, unknown>)) {
    const spec = Object.hasOwn(EXTENSION_NAMESPACES, ns) ? EXTENSION_NAMESPACES[ns] : undefined;
    if (!spec) throw new Error(`unregistered extension namespace: extensions.${ns}`);
    if (typeof body !== "object" || body === null || Array.isArray(body)) {
      throw new Error(`extensions.${ns} must be an object`);
    }
    const stored = merged[ns]?.schemaVersion;
    // Never downgrade: the read path tolerates a newer stored schemaVersion and
    // keeps its unfamiliar fields (see the READ/WRITE split below), so an older
    // writer stamping its own lower version here would produce a record whose
    // version and retained fields disagree.
    const version = typeof stored === "number" && stored > spec.schemaVersion ? stored : spec.schemaVersion;
    const entry: ExtensionEntry = { ...(merged[ns] ?? {}), schemaVersion: version };
    for (const [field, value] of Object.entries(body as Record<string, unknown>)) {
      if (field === "schemaVersion") {
        if (mode === "read") {
          if (typeof value !== "number") {
            throw new Error(`extensions.${ns}.schemaVersion must be a number`);
          }
          entry.schemaVersion = value;
          continue;
        }
        if (value !== spec.schemaVersion) {
          throw new Error(
            `extensions.${ns}.schemaVersion is ${spec.schemaVersion}, not ${JSON.stringify(value)}`,
          );
        }
        continue;
      }
      if (mode === "read") {
        // Read tolerates any value a registered namespace already holds. The
        // guards below are write-time guards: firing them here would make one
        // record on disk throw out of `list()`, and INV-4 turns that into the
        // reaper reaping nothing at all — the outage the guard was meant to
        // prevent, entered through the other door.
        entry[field] = value as string | number;
        continue;
      }
      const kind = Object.hasOwn(spec.fields, field) ? spec.fields[field] : undefined;
      if (!kind) throw new Error(`unknown key: extensions.${ns}.${field}`);
      assertKind(`extensions.${ns}.${field}`, kind, value);
      assertNoSecret(`extensions.${ns}.${field}`, value);
      entry[field] = value as string | number;
    }
    merged[ns] = entry;
  }
  return merged;
}

/** Structural validation of a record read back off disk (INV-4). */
function assertWellFormed(rec: unknown, id: string): asserts rec is RunRecord {
  if (typeof rec !== "object" || rec === null || Array.isArray(rec)) {
    throw new Error(`malformed run record ${id}.json: not a JSON object`);
  }
  const r = rec as Record<string, unknown>;
  for (const [key, value] of Object.entries(r)) {
    if (key === "extensions") {
      try {
        validateExtensions(value, undefined, "read");
      } catch (e) {
        throw new Error(`malformed run record ${id}.json: ${(e as Error).message}`);
      }
      continue;
    }
    const kind = Object.hasOwn(CORE_FIELDS, key) ? CORE_FIELDS[key] : undefined;
    if (!kind) throw new Error(`malformed run record ${id}.json: unknown key: ${key}`);
    try {
      assertKind(key, kind, value);
    } catch (e) {
      throw new Error(`malformed run record ${id}.json: ${(e as Error).message}`);
    }
  }
  if (r.runId !== id) {
    throw new Error(`malformed run record ${id}.json: runId is ${JSON.stringify(r.runId)}`);
  }
  if (typeof r.createdAt !== "string") {
    throw new Error(`malformed run record ${id}.json: createdAt missing`);
  }
  // DF2.6's reaper uses Date.parse() on createdAt; an unparseable value produces NaN,
  // which makes the record appear permanently young (never reaped, silent leak).
  if (Number.isNaN(Date.parse(r.createdAt))) {
    throw new Error(`malformed run record ${id}.json: createdAt is not a parseable ISO timestamp`);
  }
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export interface RunRecordStoreOptions {
  /** Records directory. Defaults to `$QDS_RUNS_DIR` or `.sandbox/runs`. */
  dir?: string;
  /** Propagated into every mutation log line. */
  requestId?: string;
  /**
   * Fault-injection seam: called after the temp file is written and before the
   * `rename`. Throwing here must leave the prior record byte-identical (AC2).
   */
  beforeRename?: (tmpPath: string) => void;
}

export const DEFAULT_RUNS_DIR = ".sandbox/runs";

export class RunRecordStore {
  readonly dir: string;
  private readonly requestId: string;
  private readonly beforeRename?: (tmpPath: string) => void;

  constructor(opts: RunRecordStoreOptions | string = {}) {
    const o: RunRecordStoreOptions = typeof opts === "string" ? { dir: opts } : opts;
    this.dir = o.dir ?? process.env.QDS_RUNS_DIR ?? DEFAULT_RUNS_DIR;
    this.requestId = o.requestId ?? newRequestId();
    this.beforeRename = o.beforeRename;
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    // mkdir's mode is ignored when the directory already exists, and masked by
    // umask when it does not — set it explicitly, then verify (INV-5).
    chmodSync(this.dir, 0o700);
    const dirMode = statSync(this.dir).mode & 0o777;
    if (dirMode !== 0o700) {
      throw new Error(`run records dir ${this.dir} is mode 0${dirMode.toString(8)}, not 0700`);
    }
    this.assertExclusiveCreateSupported();
    this.cleanStaleTemps();
  }

  /** INV-5: prove O_EXCL and mode 0600 before any run starts. Never degrade. */
  private assertExclusiveCreateSupported(): void {
    // Deliberately NOT `.tmp`-suffixed: the stale-temp sweep must never see a
    // concurrently-constructing store's probe file.
    const probe = join(this.dir, `.probe-${process.pid}-${randomBytes(4).toString("hex")}`);
    try {
      closeSync(openSync(probe, "wx", 0o600));
      const mode = statSync(probe).mode & 0o777;
      if (mode !== 0o600) {
        throw new Error(`file mode 0600 not honoured (got 0${mode.toString(8)})`);
      }
      let sawEexist = false;
      try {
        closeSync(openSync(probe, "wx", 0o600));
      } catch (e) {
        sawEexist = (e as NodeJS.ErrnoException).code === "EEXIST";
      }
      if (!sawEexist) throw new Error("O_EXCL creation not honoured");
    } catch (e) {
      throw new Error(`run record store cannot start in ${this.dir}: ${(e as Error).message}`);
    } finally {
      rmSync(probe, { force: true });
    }
  }

  /**
   * A SIGKILL between temp-write and `rename` leaves a `.tmp` behind; clear it
   * before any run starts so the directory only ever holds real records.
   *
   * Locks are not swept here — a lock is stolen on contention by the writer that
   * finds its owner gone, which is the only moment it matters.
   *
   * Only temps whose owning process is GONE are swept. Every store is
   * constructed per CLI invocation, so an unconditional sweep would delete a
   * concurrent `set`'s in-flight temp and lose that mutation — the owner pid is
   * encoded in the temp name precisely so this stays safe under concurrency.
   * ponytail: pid reuse could spare a stale temp; it is swept by the next
   * construction that sees the pid gone, and a stray temp is inert either way.
   */
  private cleanStaleTemps(): void {
    for (const name of readdirSync(this.dir)) {
      // `<runId>.json.<pid>.<hex>.tmp` and `.probe-<pid>-<hex>` — the two shapes
      // an unclean death can leave behind, both carrying their owner's pid.
      const isTemp = name.endsWith(".tmp");
      const isProbe = name.startsWith(".probe-");
      if (!isTemp && !isProbe) continue;
      const owner = Number(isTemp ? name.split(".").at(-3) : name.split("-")[1]);
      // `owner > 0`, not just `Number.isInteger`: `process.kill(0, 0)` signals the
      // caller's own process group and succeeds, so an owner that parsed as `0`
      // would read as permanently alive and the temp would never be swept.
      if (Number.isInteger(owner) && owner > 0 && owner !== process.pid && isAlive(owner)) continue;
      rmSync(join(this.dir, name), { force: true });
    }
  }

  /** The one function every verb routes through to turn an id into a filename. */
  path(runId: string): string {
    assertValidRunId(runId);
    return join(this.dir, `${runId}.json`);
  }

  /** INV-3: O_EXCL, not a check-then-write. A second create rejects with EEXIST. */
  create(runId: string, now: Date = new Date()): RunRecord {
    return this.traced(runId, "create", () => this.createUnlogged(runId, now));
  }

  private createUnlogged(runId: string, now: Date): RunRecord {
    const p = this.path(runId);
    const rec: RunRecord = { runId, createdAt: now.toISOString() };
    const fd = openSync(p, "wx", 0o600);
    try {
      // writeFileSync loops until the whole buffer lands; a bare writeSync can
      // short-write and leave a truncated record reported as a success.
      writeFileSync(fd, serialize(rec));
    } catch (e) {
      closeSync(fd);
      rmSync(p, { force: true });
      throw e;
    }
    closeSync(fd);
    return rec;
  }

  get(runId: string): RunRecord {
    const p = this.path(runId);
    return readRecord(p, runId);
  }

  /**
   * Merge `patch` into the record and atomically replace it. Unknown core keys,
   * immutable fields and unregistered extension namespaces are all rejected with
   * the offending key named, and the file is byte-identical afterwards.
   */
  set(runId: string, patch: RunRecordPatch): RunRecord {
    return this.traced(runId, "set", () => this.setUnlogged(runId, patch));
  }

  private setUnlogged(runId: string, patch: RunRecordPatch): RunRecord {
    return this.withLock(this.path(runId), () => this.setLocked(runId, patch));
  }

  private setLocked(runId: string, patch: RunRecordPatch): RunRecord {
    const current = this.get(runId);
    const next: RunRecord = { ...current };
    const closed = typeof current.closedAt === "string";

    for (const [key, value] of Object.entries(patch)) {
      if (value === undefined) continue;
      if (key === "extensions") {
        // `extensions` stays writable after close: closure freezes the run's own
        // lifecycle facts, not the cross-cutting state hung off them.
        next.extensions = validateExtensions(value, current.extensions);
        continue;
      }
      if (IMMUTABLE_FIELDS.has(key)) throw new Error(`immutable key: ${key}`);
      // `closedAt` is close()'s alone. Letting set() stamp it would bypass
      // first-close-wins, admit a non-timestamp value, and hide a live box from
      // the reaper (a closed record is an unclaimed box by definition).
      if (key === "closedAt") throw new Error("closedAt is written by close(), not set()");
      const kind = Object.hasOwn(CORE_FIELDS, key) ? CORE_FIELDS[key] : undefined;
      if (!kind) throw new Error(`unknown key: ${key}`);
      if (closed) throw new Error(`record ${runId} is closed; core key not writable: ${key}`);
      assertKind(key, kind, value);
      assertNoSecret(key, value, { shape: key !== "keyHash" });
      (next as unknown as Record<string, unknown>)[key] = value;
    }

    this.atomicReplace(runId, next);
    return next;
  }

  /** First-close-wins: a second close succeeds and keeps the original `closedAt`. */
  close(runId: string, now: Date = new Date()): RunRecord {
    return this.traced(runId, "close", () =>
      this.withLock(this.path(runId), () => {
        const current = this.get(runId);
        if (typeof current.closedAt === "string") return current;
        const next: RunRecord = { ...current, closedAt: now.toISOString() };
        this.atomicReplace(runId, next);
        return next;
      }),
    );
  }

  /**
   * INV-4: every `.json` in the directory must parse and validate. A malformed or
   * unreadable record throws naming the file — it is never skipped, because a
   * record quietly dropped is a key that quietly keeps spending.
   */
  list(): RunRecord[] {
    return this.traced(null, "list", () => this.listUnlogged());
  }

  private listUnlogged(): RunRecord[] {
    const out: RunRecord[] = [];
    for (const name of readdirSync(this.dir).sort()) {
      if (!name.endsWith(".json")) continue;
      const id = name.slice(0, -".json".length);
      try {
        assertValidRunId(id);
      } catch {
        throw new Error(`malformed run record ${name}: filename is not a valid run id`);
      }
      out.push(readRecord(join(this.dir, name), id));
    }
    return out;
  }

  /**
   * Hold an exclusive per-record lock across a read-modify-write.
   *
   * `rename` makes each write atomic, but `set()` reads, merges in memory, then
   * replaces — so without this, two processes writing different fields (DF2.3
   * minting `keyHash` while the dispatcher writes `vmName`) lose one of them
   * wholesale. A dropped `keyHash` is INV-4's failure mode exactly: a key that
   * keeps spending with nobody able to revoke it.
   *
   * The lock is itself O_EXCL, and it names its owner so a lock left by an
   * unclean death is stolen rather than deadlocking the fleet.
   */
  private withLock<T>(p: string, fn: () => T): T {
    const lock = `${p}.lock`;
    const deadline = Date.now() + LOCK_TIMEOUT_MS;
    for (;;) {
      try {
        const fd = openSync(lock, "wx", 0o600);
        writeFileSync(fd, `${process.pid}\n`);
        closeSync(fd);
        break;
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
        if (this.stealIfOwnerGone(lock)) continue;
        if (Date.now() >= deadline) {
          throw new Error(`timed out waiting for the run record lock: ${lock}`);
        }
        sleepMs(5);
      }
    }
    try {
      return fn();
    } finally {
      rmSync(lock, { force: true });
    }
  }

  /** True if a stale lock was removed and the caller should retry immediately. */
  private stealIfOwnerGone(lock: string): boolean {
    let owner: number;
    try {
      owner = Number(readFileSync(lock, "utf8").trim());
    } catch {
      return true; // the holder released it between our open and this read
    }
    // See cleanStaleTemps: an owner that parsed as `0` must not read as alive.
    if (Number.isInteger(owner) && owner > 0 && owner !== process.pid && isAlive(owner)) return false;
    rmSync(lock, { force: true });
    return true;
  }

  /** Write-temp-then-rename. There is no in-place partial-write path (INV-3). */
  private atomicReplace(runId: string, rec: RunRecord): void {
    const p = this.path(runId);
    const tmp = `${p}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
    const fd = openSync(tmp, "wx", 0o600);
    let fdOpen = true;
    try {
      writeFileSync(fd, serialize(rec));
      closeSync(fd);
      fdOpen = false;
      this.beforeRename?.(tmp);
      renameSync(tmp, p);
    } catch (e) {
      // Guarded, not try/catch'd: fd numbers are recycled, and `beforeRename`
      // may have opened something else by the time we land here.
      if (fdOpen) closeSync(fd);
      rmSync(tmp, { force: true });
      throw e;
    }
  }

  /**
   * Run one record operation and log its outcome exactly once — success AND
   * failure. A failed mutation is the case an operator actually has to diagnose,
   * so it is the one that must not be silent.
   */
  private traced<T>(runId: string | null, verb: string, fn: () => T): T {
    const started = Date.now();
    try {
      const out = fn();
      this.emit(runId, verb, started, "ok");
      return out;
    } catch (e) {
      this.emit(runId, verb, started, "error", {
        code: (e as NodeJS.ErrnoException).code ?? "record_error",
        message: (e as Error).message,
      });
      throw e;
    }
  }

  /** Observability contract: one line per record mutation, never the keyHash value. */
  private emit(
    runId: string | null,
    verb: string,
    started: number,
    outcome: "ok" | "error",
    error?: { code: string; message: string },
  ): void {
    const durationMs = Date.now() - started;
    log({
      requestId: this.requestId,
      operation: `run-record.${verb}`,
      agentId: null,
      timestamp: new Date().toISOString(),
      duration: durationMs,
      status: outcome,
      ...(error ? { error } : {}),
      runId,
      driver: null,
      verb,
      durationMs,
      outcome,
      record_write_ms: durationMs,
    });
  }
}

/** Block this thread briefly. The lock wait is short and the callers are sync. */
function sleepMs(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** Is `pid` still around? Used only to tell a live writer's temp from a corpse. */
function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

function serialize(rec: RunRecord): string {
  return `${JSON.stringify(rec, null, 2)}\n`;
}

function readRecord(p: string, id: string): RunRecord {
  let raw: string;
  try {
    raw = readFileSync(p, "utf8");
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    const err = new Error(`unreadable run record ${id}.json: ${code ?? (e as Error).message}`);
    // Preserve the errno on the wrapped error: consumers classify absence
    // (ENOENT) vs other read failures off the TYPED code, never off message
    // text — a malformed record's own error message echoes caller-controlled
    // key names ("unknown key: ENOENT") that a substring match would trip on.
    if (code !== undefined) (err as NodeJS.ErrnoException).code = code;
    throw err;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new Error(`malformed run record ${id}.json: ${(e as Error).message}`);
  }
  assertWellFormed(parsed, id);
  return parsed;
}
