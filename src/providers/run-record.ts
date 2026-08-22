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
 * The core fields are closed. The single sanctioned additive surface is
 * `extensions`, an allow-listed per-namespace map (not an open map).
 */

import { randomBytes } from "node:crypto";
import {
  chmodSync,
  closeSync,
  fsyncSync,
  linkSync,
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
 * The core fields. These camelCase spellings are the only ones any
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
  requestId: "string",
  ports: "ports",
  pid: "int",
  createdAt: "string",
  closedAt: "string",
};

/** Set once at `create()`; never rewritable. */
export const IMMUTABLE_FIELDS: ReadonlySet<string> = new Set(["runId", "createdAt"]);

/**
 * Core fields a caller may write via `set()`: every core field minus
 * `runId`/`createdAt` (immutable) and `closedAt` (`close()`'s alone). Derived,
 * never listed twice — a core field added above is settable here by
 * construction. Exported so the CLI derives its
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
  /**
   * INV-4-bis: the correlation id the dispatch ran under — the join key that
   * ties this record to the host-side dispatch log and the ledger's
   * `request_id` column. A core field beside `sessionId`/`commitSha`, not an
   * extension namespace: it is a cross-layer attribute of the run itself, not
   * one story's payload hung off it, and `fleet status` reads it back for every
   * run regardless of which story created it.
   */
  requestId?: string;
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
  /**
   * DF3.1 AC3: the setup gate's refusal, written by the fleet dispatcher when
   * the gate fails. The record stays OPEN and the box ALIVE (INV-5) — this is
   * the record-side half of the evidence the host-side dispatch log carries.
   */
  gate: {
    schemaVersion: 1,
    fields: { outcome: "string", failedItem: "string", assertionCode: "int", failedAt: "string" },
  },
};

// ---------------------------------------------------------------------------
// Run ids
// ---------------------------------------------------------------------------

/**
 * Hostname grammar — an RFC 1123 label, in full. The id becomes the box name
 * and the box name becomes a public hostname, so anything outside this grammar
 * is refused before a path is built — `path()` is the one function every verb
 * routes through.
 *
 * BOTH ends are anchored on `[a-z0-9]`, not just the first: a label may not end
 * with a hyphen either. Enforcing only the leading character let `trailing-`
 * through here and refused it at the provider instead — after a record existed
 * and with an id no box could ever be named. A single character stays legal.
 */
export const RUN_ID_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;
export const RUN_ID_MAX = 63;

/**
 * The grammar a run id ALREADY ON DISK may carry — the pre-tightening rule,
 * which anchored only the leading character.
 *
 * `create()` takes a caller-supplied id, so `trailing-` records exist by
 * construction from any earlier build. Applying the strict grammar on the READ
 * paths made those records unreadable, unclosable and un-teardown-able: the box
 * keeps billing with no route to reclaim it, and `list()` — `fleet status`, the
 * DF2.6 reaper's record sweep — threw for the whole directory over one
 * filename. That is the unbounded-spend outage INV-4 exists to prevent, entered
 * through the filename door instead of the schema door, and it is the same
 * read/write split `validateExtensions` already makes.
 *
 * Path safety is unchanged: neither grammar admits `/`, `.` or `..`, and the
 * length bound is the same. Only CREATION is strict, so no NEW record can be
 * named outside `RUN_ID_RE`.
 */
export const LEGACY_RUN_ID_RE = /^[a-z0-9][a-z0-9-]*$/;

/**
 * How long a writer waits for another process's record lock before giving up.
 *
 * Exported for tests ONLY, so the lock-timing assertions track the real value
 * rather than a mirrored `5_000`. Shortening this narrows the fail-closed window
 * and raises the double-writer risk, so a regression here must fail a test.
 */
export const LOCK_TIMEOUT_MS = 5_000;

/**
 * How many times `withLock` retries a claim with NO sleep before it starts
 * sleeping anyway.
 *
 * The sleepless retry exists for the fast hand-off: `stealIfOwnerGone`
 * returning `null` means the path is free RIGHT NOW, and a 5ms sleep there
 * throws the hand-off away. But "free right now" is also what a contender sees
 * when `claimLock` loses the race and the winner then releases before the
 * steal probe reads — a state two writers can hand back and forth for the whole
 * LOCK_TIMEOUT_MS, spinning a core flat out on a `sleepMs` that blocks the
 * event loop anyway. Past this many, the contention is plainly not a hand-off.
 */
const LOCK_IMMEDIATE_RETRIES = 8;

/**
 * Lock paths this JS thread is currently inside.
 *
 * Module state, so it is per-THREAD by construction — a `node:worker_threads` /
 * `Bun.Worker` sibling gets its own module instance and its own set. That is
 * exactly the granularity `stealIfOwnerGone` cannot get from the pid: both a
 * sibling thread and a re-entrant `set()` from the `beforeRename` seam present
 * as "our pid, not our body", and only one of them is the caller deadlocking
 * against itself. Diagnostic only — the wait stays fail-closed either way.
 */
const heldLocks = new Set<string>();

export function assertValidRunId(id: unknown): asserts id is string {
  if (typeof id !== "string" || id.length === 0 || id.length > RUN_ID_MAX || !RUN_ID_RE.test(id)) {
    throw new Error(
      `invalid run id: ${JSON.stringify(id)} (must match ${RUN_ID_RE.source} and be <= ${RUN_ID_MAX} chars)`,
    );
  }
}

/** The read/write-path admission rule: `assertValidRunId` plus the legacy tail. */
export function assertExistingRunId(id: unknown): asserts id is string {
  if (typeof id !== "string" || id.length === 0 || id.length > RUN_ID_MAX || !LEGACY_RUN_ID_RE.test(id)) {
    throw new Error(
      `invalid run id: ${JSON.stringify(id)} (must match ${LEGACY_RUN_ID_RE.source} and be <= ${RUN_ID_MAX} chars)`,
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

/**
 * The credential shapes this factory actually mints or handles. Exported so a
 * redactor (`src/providers/step-log.ts`) matches exactly what `assertNoSecret`
 * refuses — a second copy is a list that drifts, and the half that drifts is
 * the half that leaks.
 */
export const SECRET_PREFIXES: readonly string[] = Object.freeze([
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
  // Frozen, not just `readonly`: this is INV-2's guard list, and `readonly` is
  // a compile-time claim an importer erases with one `as string[]`. A `splice()`
  // here empties the prefix scan for the rest of the process.
]);

/**
 * Field paths the LENGTH+mixed-class heuristic below does not apply to, because
 * what they hold is structurally known and structurally not key material.
 *
 * Keyed on the PATH, never on the value — that is the whole point. The
 * heuristic cannot tell a long mixed-class token from a long mixed-class
 * identifier, so for the fields whose grammar is already pinned down elsewhere
 * the answer is to stop asking it. `extensions.budget.repoSlug` is the case
 * that bit: `BiosparkHealth/QDS-Factory-Pipeline-Engine2` is 43 chars, mixed
 * class, and every character a repo slug may legally carry
 * (`[A-Za-z0-9._-]+/[A-Za-z0-9._-]+`, src/fleet/brief-schema.ts) is inside the
 * heuristic's charset. It was refused as "key material" AFTER `store.create`
 * had already made the record — so the run resolved without an
 * `extensions.budget` for teardown to price, the ledger's orphan guard never
 * expired the reservation, and every retry burned another one until the
 * issue's cap was gone.
 *
 * The PREFIX scan still runs on every path including these, so the one field an
 * operator can fat-finger a raw key into is not the field that accepts it: no
 * repo slug, issue id or sha256 digest starts with `sk-` or `-----BEGIN`.
 */
const SHAPE_EXEMPT_PATHS: ReadonlySet<string> = new Set([
  // A base64 sha256 is a 44-char mixed-class token by construction.
  "keyHash",
  // Both are validated against their own grammar by BriefSchema before they
  // ever reach the record, and both are written AFTER the box exists.
  extPath("budget", "repoSlug"),
  extPath("budget", "issueId"),
]);

/**
 * The ONE spelling of an extension field's path. `validateExtensions` builds
 * `assertNoSecret`'s key with it and `SHAPE_EXEMPT_PATHS` is keyed with it, so
 * the exempt set cannot drift out of the format the caller actually produces —
 * a set written as literal `extensions.budget.repoSlug` while the caller passed
 * `budget.repoSlug` looks correct and exempts nothing, which is the production
 * incident above still live.
 */
function extPath(ns: string, field: string): string {
  return `extensions.${ns}.${field}`;
}

/**
 * ponytail: prefix list + a mixed-class long-token heuristic, not an entropy
 * model. It catches the credential shapes this factory actually mints; upgrade
 * to a real detector only if a leak gets past it.
 *
 * The mixed-class requirement is load-bearing, not decoration. A 40-char git SHA
 * is all-lowercase hex and a run id is all-lowercase hostname text, so a
 * length-only rule would reject `commitSha` and `vmName` — the very fields this
 * record exists to hold — and it would do it AFTER the box was created. Mixed
 * class is not enough on its own, though: see `SHAPE_EXEMPT_PATHS`.
 */
function assertNoSecret(key: string, value: unknown): void {
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
  if (SHAPE_EXEMPT_PATHS.has(key)) return;
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
      if (!kind) throw new Error(`unknown key: ${extPath(ns, field)}`);
      assertKind(extPath(ns, field), kind, value);
      assertNoSecret(extPath(ns, field), value);
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
  /**
   * Fault-injection seam: called once a lock has been JUDGED stale and before
   * `stealIfOwnerGone` takes the path. The window this opens — corpse cleared,
   * new writer claims the free path — is the one the take-then-compare protocol
   * exists to survive, and it is not otherwise reachable from a test.
   */
  beforeStealTake?: (lockPath: string) => void;
  /**
   * Fault-injection seam: called with the held-aside path once a lock has been
   * TAKEN (by `stealIfOwnerGone` or by `releaseLock`) and before its body is
   * read back. A read that fails there — EIO, EACCES — is what makes the taken
   * generation unprovable, and no other test control makes `readFileSync` fail
   * on a file this module has just renamed itself.
   */
  afterLockTake?: (claimedPath: string) => void;
}

export const DEFAULT_RUNS_DIR = ".sandbox/runs";

/** What a directory sweep read, and what it refused to read (see `listWithAnomalies`). */
export interface RunRecordListing {
  records: RunRecord[];
  /** Filenames skipped because the stem is not a run id, sorted (`readdir` is sorted first). */
  skipped: string[];
}

export class RunRecordStore {
  readonly dir: string;
  private readonly requestId: string;
  private readonly beforeRename?: (tmpPath: string) => void;
  private readonly beforeStealTake?: (lockPath: string) => void;
  private readonly afterLockTake?: (claimedPath: string) => void;

  constructor(opts: RunRecordStoreOptions | string = {}) {
    const o: RunRecordStoreOptions = typeof opts === "string" ? { dir: opts } : opts;
    this.dir = o.dir ?? process.env.QDS_RUNS_DIR ?? DEFAULT_RUNS_DIR;
    this.requestId = o.requestId ?? newRequestId();
    this.beforeRename = o.beforeRename;
    this.beforeStealTake = o.beforeStealTake;
    this.afterLockTake = o.afterLockTake;
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

  /**
   * INV-5: prove O_EXCL, mode 0600 and `link(2)` before any run starts. Never
   * degrade.
   *
   * `link` is probed because `claimLock` is built on it, not on O_EXCL. On a
   * filesystem that refuses hard links (SMB/CIFS, some FUSE and overlay bind
   * mounts return EPERM or EOPNOTSUPP, not EEXIST) the store used to construct
   * cleanly and every run started — then the first `set()`/`close()` died with
   * a bare `EPERM: operation not permitted, link …`, mid-lifecycle, after
   * `driver.create` had stood billable infrastructure up, with no remediation
   * string. Probing here is the honest fix rather than falling back to
   * `openSync(lock, "wx")`: the fallback re-opens the empty-body window
   * `claimLock`'s comment describes, and it hides an unsupported platform
   * instead of naming it.
   */
  private assertExclusiveCreateSupported(): void {
    // Deliberately NOT `.tmp`-suffixed: the stale-temp sweep must never see a
    // concurrently-constructing store's probe file.
    const probe = join(this.dir, `.probe-${process.pid}-${randomBytes(4).toString("hex")}`);
    const probeLink = `${probe}-link`;
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
      try {
        linkSync(probe, probeLink);
      } catch (e) {
        throw new Error(
          `hard links are not supported here (${(e as NodeJS.ErrnoException).code ?? (e as Error).message}); the record lock needs link(2)`,
        );
      }
    } catch (e) {
      throw new Error(`run record store cannot start in ${this.dir}: ${(e as Error).message}`);
    } finally {
      rmSync(probe, { force: true });
      rmSync(probeLink, { force: true });
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
   * ponytail: pid reuse — and our own pid — can spare a stale temp; it is swept
   * by the next construction whose pid differs and sees the owner gone, and a
   * stray temp is inert either way.
   */
  private cleanStaleTemps(): void {
    for (const name of readdirSync(this.dir)) {
      // `<runId>.json[.lock].<pid>.<hex>.tmp` and `.probe-<pid>-<hex>` — the
      // shapes an unclean death leaves behind, each carrying its owner's pid.
      // A lock taken aside mid-steal or mid-release rides the same sweep — it
      // is pid-stamped like the rest — which is what keeps a death between the
      // `rename` and the `rm` from stranding a lock generation.
      const isTemp = name.endsWith(".tmp");
      const isProbe = name.startsWith(".probe-");
      if (!isTemp && !isProbe) continue;
      const owner = Number(isTemp ? name.split(".").at(-3) : name.split("-")[1]);
      // `owner > 0`, not just `Number.isInteger`: `process.kill(0, 0)` signals the
      // caller's own process group and succeeds, so an owner that parsed as `0`
      // would read as permanently alive and the temp would never be swept.
      //
      // OUR OWN pid is spared, not swept. Two JS threads
      // (`node:worker_threads` / `Bun.Worker`) share `process.pid` — the exact
      // configuration `stealIfOwnerGone`'s docstring reasons about — so a
      // same-pid temp can be a sibling thread's in-flight `set()` temp, or a
      // lock body it is holding aside mid-steal. Deleting either destroys a
      // live claim: the temp loses that mutation, the held-aside body destroys
      // a lock a live holder is still inside, which is the lost update
      // `putBack` promises never to cause.
      if (Number.isInteger(owner) && owner > 0 && (owner === process.pid || isAlive(owner))) continue;
      rmSync(join(this.dir, name), { force: true });
    }
  }

  /**
   * The one function every verb routes through to turn an id into a filename.
   *
   * The LEGACY grammar, deliberately: this is the read/write path, and a record
   * an earlier build created must stay readable, closable and tearable-down.
   * `create()` applies the strict `RUN_ID_RE` on top (see `createUnlogged`), so
   * the tightening still holds where it can act — before a record exists.
   */
  path(runId: string): string {
    assertExistingRunId(runId);
    return join(this.dir, `${runId}.json`);
  }

  /**
   * The write lock guarding `path(runId)` — the one spelling, exported so no
   * caller has to know it.
   *
   * It is `<runId>.json.lock`, NOT `<runId>.lock`: `path()` appends `.json` and
   * the lock hangs off that. Re-deriving it by hand is how a test asserts on a
   * file the lock code never touches and passes vacuously, and `<runId>.lock`
   * is a live path in the same directory — `scripts/lib/run-lock.ts`'s
   * invocation lock — so the wrong spelling names a REAL file belonging to a
   * different mutual-exclusion contract rather than failing loudly.
   */
  lockPath(runId: string): string {
    return `${this.path(runId)}.lock`;
  }

  /** INV-3: O_EXCL, not a check-then-write. A second create rejects with EEXIST. */
  create(runId: string, now: Date = new Date()): RunRecord {
    return this.traced(runId, "create", () => this.createUnlogged(runId, now));
  }

  private createUnlogged(runId: string, now: Date): RunRecord {
    // Creation is the one moment the strict grammar can act without stranding
    // anything: no record exists yet, so refusing costs nothing.
    assertValidRunId(runId);
    const p = this.path(runId);
    const rec: RunRecord = { runId, createdAt: now.toISOString() };
    const fd = openSync(p, "wx", 0o600);
    try {
      // writeFileSync loops until the whole buffer lands; a bare writeSync can
      // short-write and leave a truncated record reported as a success.
      writeFileSync(fd, serialize(rec));
      // INV-1's whole point is that this record reaches disk BEFORE any
      // billable infrastructure exists. Unsynced, a power loss here loses the
      // handle while the provider-side box survives — an orphan nobody reaps.
      fsyncSync(fd);
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
    return this.withLock(runId, () => this.setLocked(runId, patch));
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
      assertNoSecret(key, value);
      (next as unknown as Record<string, unknown>)[key] = value;
    }

    this.atomicReplace(runId, next);
    return next;
  }

  /** First-close-wins: a second close succeeds and keeps the original `closedAt`. */
  close(runId: string, now: Date = new Date()): RunRecord {
    return this.traced(runId, "close", () =>
      this.withLock(runId, () => {
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
   *
   * A filename outside even the LEGACY id grammar is the one file this store
   * can neither read nor act on. It is not thrown from the SWEEP — that took
   * the whole directory down over one file — but it is thrown from HERE, at the
   * accessor that returns records with no channel to report the anomaly on. A
   * caller holding a bare `RunRecord[]` cannot tell "no such box" from "a box
   * behind a file I refused to read", and `reapRuns` destroys every box not in
   * that set. So the plain array is only ever handed back when it is COMPLETE.
   *
   * A caller that can act on the anomaly calls `listWithAnomalies()` and gets
   * both halves; a caller that cannot gets an error naming the files. Neither
   * one silently drops a live box. The skip is also on the log line, but a log
   * line cannot make a caller fail safe.
   */
  list(): RunRecord[] {
    const { records, skipped } = this.listWithAnomalies();
    if (skipped.length > 0) {
      throw new Error(
        `refusing to return a partial run record listing from ${this.dir}: ${skipped.length} file(s) could not be read as a record (${skipped.join(", ")}) — use listWithAnomalies() to handle them, or repair/remove the files named`,
      );
    }
    return records;
  }

  /**
   * `list()`, plus what it refused to read.
   *
   * A skipped file is not an absence, and a caller that cannot tell the two
   * apart fails OPEN. `reapRuns` builds its claim set from the records this
   * returns and destroys every box not in it — so a `.json` skipped for a bad
   * filename, whose contents are a perfectly valid OPEN record with a `vmName`,
   * silently drops that box out of the claim set and the reaper destroys a live
   * box belonging to an open run. A log line cannot prevent that; a value in
   * the return can. `fleet status` has the same problem in the reporting
   * direction: "3 runs" and "3 runs and one record I refused to read" must not
   * render identically.
   *
   * This is the only accessor that hands back a partial listing, and it hands
   * back the reason it is partial in the same value. `list()` throws instead —
   * safety is the DEFAULT, and reading the anomaly is what a caller opts INTO.
   * The other way round, every caller written before this pair existed keeps
   * its old `RunRecord[]` call site and silently inherits fail-open.
   */
  listWithAnomalies(): RunRecordListing {
    return this.traced(null, "list", () => this.listUnlogged());
  }

  private listUnlogged(): RunRecordListing {
    const records: RunRecord[] = [];
    const skipped: string[] = [];
    for (const name of readdirSync(this.dir).sort()) {
      if (!name.endsWith(".json")) continue;
      const id = name.slice(0, -".json".length);
      try {
        assertExistingRunId(id);
      } catch {
        skipped.push(name);
        this.emit(null, "list.anomaly", Date.now(), "error", {
          code: "malformed_record_name",
          message: `malformed run record ${name}: filename is not a valid run id`,
        });
        continue;
      }
      records.push(readRecord(join(this.dir, name), id));
    }
    return { records, skipped };
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
   * The lock is exclusive by `link(2)`, and it names its owner so a lock left by
   * an unclean death is stolen rather than deadlocking the fleet. Every step is
   * ownership-proving: a lock is never observable half-written, never unlinked
   * by a process that cannot show it still holds it, and never stolen from an
   * owner that is not provably dead.
   */
  private withLock<T>(runId: string, fn: () => T): T {
    const lock = this.lockPath(runId);
    const deadline = Date.now() + LOCK_TIMEOUT_MS;
    // `<pid> <nonce>`: the pid is what a contender probes for liveness, the
    // nonce is what release compares back before it unlinks anything.
    const body = `${process.pid} ${randomBytes(4).toString("hex")}\n`;
    // Why the last attempt did not get the lock. Carried into the timeout so an
    // EACCES/EIO lock (a permissions or mount problem) is not reported as
    // contention, which is what sent an operator looking for a phantom writer.
    let heldReason = "contended";
    // Monotonic, never reset: a handful of immediate retries keeps the fast
    // hand-off, and after that every retry sleeps for the rest of this wait.
    let sleepless = 0;
    for (;;) {
      if (this.claimLock(lock, body)) break;
      // Checked on every failed claim, including the ones a steal follows, so
      // the loop is bounded by LOCK_TIMEOUT_MS however the contention resolves.
      if (Date.now() >= deadline) {
        throw new Error(`timed out waiting for the run record lock: ${lock} (${heldReason})`);
      }
      // A successful steal means the path is free now — retry without sleeping.
      const why = this.stealIfOwnerGone(lock, body);
      if (why !== null) {
        heldReason = why;
        sleepMs(5);
      } else if (++sleepless > LOCK_IMMEDIATE_RETRIES) {
        sleepMs(5);
      }
    }
    heldLocks.add(lock);
    try {
      return fn();
    } finally {
      heldLocks.delete(lock);
      this.releaseLock(lock, body);
    }
  }

  /**
   * Claim `lock`, or report it already held.
   *
   * The body is written, fsynced and `link`ed into place rather than created
   * with O_EXCL and written afterwards — `atomicReplace`'s write-then-publish
   * shape, and what `scripts/lib/run-lock.ts` gives its own lock. `link` is
   * exactly as exclusive as O_EXCL, but the lock is COMPLETE the instant the
   * path exists. With the two-step version a contender landing between the
   * create and the write read an empty body, scored the owner as `0`, judged
   * the lock junk and stole it from a live holder — two `setLocked`
   * read-modify-writes then dropped a field, which is the lost update this lock
   * exists to prevent.
   */
  private claimLock(lock: string, body: string): boolean {
    const tmp = `${lock}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
    let fd: number;
    try {
      fd = openSync(tmp, "wx", 0o600);
    } catch (e) {
      // An EEXIST here is a TEMP-name collision — a 4-byte nonce landing on a
      // temp left by a crashed process that had our pid (cleanStaleTemps only
      // runs at store construction). Reporting contention lets withLock retry
      // with a fresh nonce; letting it escape aborted a lifecycle write with a
      // raw `EEXIST … .tmp` that reads as a duplicate RECORD.
      if ((e as NodeJS.ErrnoException).code === "EEXIST") return false;
      throw e;
    }
    let fdOpen = true;
    try {
      writeFileSync(fd, body);
      fsyncSync(fd);
      // Cleared BEFORE the call: `close(2)` consumes the descriptor whether it
      // returns or fails, so a throwing close still frees the number for reuse.
      // Clearing after left `fdOpen` true on that path and closed it twice.
      fdOpen = false;
      closeSync(fd);
      linkSync(tmp, lock);
    } catch (e) {
      // Guarded, not try/catch'd: fd numbers are recycled (see atomicReplace).
      if (fdOpen) closeSync(fd);
      rmQuiet(tmp);
      if ((e as NodeJS.ErrnoException).code === "EEXIST") return false;
      throw e;
    }
    // The lock is CLAIMED by the time we get here, so nothing this cleanup does
    // may escape: a throw from the `rm` (EACCES/EPERM/EBUSY on the temp) leaves
    // before `withLock` enters the `try/finally` that releases the lock, so the
    // lock stays on disk with this process alive and every contender waits the
    // full LOCK_TIMEOUT_MS. The temp is pid-stamped, so leaving it costs a
    // sweep at the next construction — nothing more.
    rmQuiet(tmp);
    return true;
  }

  /**
   * `null` if the path is free and the caller should retry immediately; a short
   * reason string means the lock counts as HELD and the caller waits (the reason
   * rides the eventual timeout message).
   *
   * Anything that does not read as a live-or-dead pid is HELD, never junk —
   * stealing on an unreadable body is how a live holder's lock gets taken out
   * from under it, and a dropped `keyHash` is worse than a 5s timeout. That
   * covers an unreadable PATH too: only ENOENT proves the holder released it.
   * Any other errno (EACCES on a lock written by another user, EIO on a failing
   * mount, EISDIR) used to report "free", and `withLock` then retried with NO
   * sleep — a tight busy loop pegging a core for the full LOCK_TIMEOUT_MS on a
   * `sleepMs` that blocks the event loop anyway.
   *
   * A lock owned by THIS pid is not automatically a corpse either. Two JS
   * threads (`node:worker_threads` / `Bun.Worker`) share `process.pid`, and the
   * `beforeRename` seam runs INSIDE the lock and can re-enter `set()`. Only our
   * OWN body is stealable under our own pid; any other body belongs to a live
   * sibling holder, and taking it lets two `setLocked` read-modify-writes
   * overlap and drop a field — INV-4's named failure mode.
   *
   * TAKE, THEN COMPARE — `releaseLock`'s protocol exactly, and for the same
   * reason. Judging the body and unlinking the path as two calls is a TOCTOU:
   * between them the corpse can be cleared (by an operator, by another store's
   * `cleanStaleTemps`, by the owner's pid coming back) and a NEW writer can
   * legitimately claim the free path — and the `rm` would then delete that live
   * writer's lock, letting two `setLocked` read-modify-writes overlap and drop
   * a field. That is the lost update this lock exists to prevent, entered
   * through the steal door instead of the release door.
   *
   * So the corpse is `rename`d aside in one step and only removed once the
   * bytes held aside are provably the bytes that were judged dead. `rename`
   * also makes the steal single-winner without a separate witness link: two
   * contenders that both find the same corpse cannot both take it, because the
   * loser's rename either finds nothing or takes a body it must put back.
   *
   * Comparing the BODY, not the inode: an unlinked corpse's inode number is
   * free for the kernel to hand straight back to the new writer's lock file, so
   * inode equality does not prove generation. The body carries a random nonce
   * (see `withLock`), which does.
   */
  private stealIfOwnerGone(lock: string, body: string): string | null {
    let raw: string;
    try {
      raw = readFileSync(lock, "utf8");
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      // ENOENT alone proves the path is free: the holder released it between
      // our claim and this read.
      if (code === "ENOENT") return null;
      return `lock unreadable: ${code ?? (e as Error).message}`;
    }
    const owner = Number(raw.trim().split(/\s+/)[0]);
    // See cleanStaleTemps: an owner that parsed as `0` must not read as alive.
    // Unparseable, empty or non-positive ⇒ held, wait — never stolen.
    if (!Number.isInteger(owner) || owner <= 0) return "lock body names no pid";
    if (owner === process.pid ? raw !== body : isAlive(owner)) {
      // Our pid, not our body, and THIS thread already holds the path: the
      // caller is waiting on itself — a re-entrant `set()` from the
      // `beforeRename` seam. Fail-closed is still right (there is no safe way
      // to hand a live holder its own lock), but reporting it as a sibling
      // writer sent an operator looking for a second process that never
      // existed. A sibling thread sharing our pid is NOT in this set.
      if (owner === process.pid && heldLocks.has(lock)) {
        return "re-entrant record write: this thread already holds this lock";
      }
      return "held by a live owner";
    }
    this.beforeStealTake?.(lock);
    // `.tmp`-suffixed and pid-stamped so a death between the take and the
    // unlink cannot strand the generation: cleanStaleTemps sweeps it at the
    // next store construction once this pid is gone.
    const claimed = `${lock}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
    try {
      renameSync(lock, claimed);
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      // ENOENT alone proves the path is free — the corpse was cleared between
      // the judgement and the take, so the claim can be retried immediately.
      // EACCES/EROFS/EIO prove nothing of the sort: reporting "free" made
      // `withLock` retry with NO sleep and never update `heldReason`, so the
      // eventual timeout said `(contended)` and sent the operator hunting a
      // phantom writer. Same hardening as the `readFileSync` arm above.
      if (code === "ENOENT") return null;
      return `lock untakeable: ${code ?? (e as Error).message}`;
    }
    this.afterLockTake?.(claimed);
    let onDisk: string | undefined;
    try {
      onDisk = readFileSync(claimed, "utf8");
    } catch {
      // UNREADABLE is not "gone", and it was removed here as if it were. A read
      // that fails (EIO on a failing mount, EACCES on a body written by another
      // user) proves nothing about WHICH generation was taken — and the take
      // races exactly the same window the foreign-body arm below exists for:
      // the corpse cleared, a live writer's claim landing at the free path,
      // this rename taking THAT. Deleting it there unlocks a holder still
      // inside its `fn()`, which is the lost update the protocol exists to
      // prevent. Fall through to the put-back instead: `undefined` matches no
      // body, so the unprovable take is restored and reported HELD.
      onDisk = undefined;
    }
    if (onDisk === raw) {
      rmSync(claimed, { force: true });
      return null; // provably the corpse that was judged
    }
    // A different — or unreadable — body: the corpse was cleared and a NEW
    // writer claimed the path between the judgement and the take. Put it back —
    // `link`, never `rename`, so a claim made at the path while this one was
    // held aside is not overwritten (EEXIST ⇒ that newer claim supersedes this
    // body anyway).
    if (putBack(claimed, lock)) {
      rmSync(claimed, { force: true });
      return "held by a live owner"; // a live lock is HELD — wait, never steal
    }
    // Put-back FAILED (ENOSPC, EMLINK, EDQUOT, EIO — never EEXIST, which
    // `putBack` reports as success). The lock path is now EMPTY while a live
    // holder is still inside its `fn()`, and the next contender's `claimLock`
    // will succeed: two `setLocked` read-modify-writes overlap and drop a
    // field. Nothing here can restore it, so it must not be silent. Reporting
    // HELD keeps THIS writer fail-closed — it waits out the timeout with the
    // reason attached rather than joining the overlap — and the log line is
    // what tells an operator the lock needs putting back by hand.
    this.emit(null, "lock.not-restored", Date.now(), "error", {
      code: "lock_not_restored",
      message: `run record lock left vacated after a steal attempt: ${lock} (body held aside at ${claimed})`,
    });
    return "lock could not be restored after a steal attempt";
  }

  /**
   * Release, but only if the lock on disk is still this process's own claim.
   *
   * An unconditional `rm` unlinks whatever sits at the path — including the
   * lock a later writer legitimately holds after ours was stolen or cleared by
   * hand — which is the same lost update entered through the other door. A
   * foreign body is left alone rather than thrown on: this runs in a `finally`,
   * where a throw would replace the caller's real error with this one.
   *
   * LOOK BEFORE TAKING, then take-then-compare. The `rename` is what makes the
   * bytes compared provably the bytes removed — reading and unlinking as two
   * calls is a TOCTOU, since `stealIfOwnerGone` can retire this lock and a new
   * writer claim the path in between, and the `rm` would then delete that live
   * writer's lock. But the rename must not be the FIRST thing this does. It
   * vacates the path for as long as the compare and the put-back take, and if
   * `putBack` cannot restore it (ENOSPC, EMLINK, EDQUOT, EIO) it stays vacated:
   * the next contender claims a lock a live holder is still inside, which is
   * the lost update this whole protocol exists to prevent — arrived at through
   * a `finally` that swallows everything. A foreign body is not ours to move at
   * all, so the cheap read below means the common case never vacates anything.
   * Same reasoning, and the same runtime limits, as `releaseRunLock` in
   * scripts/lib/run-lock.ts, which also reads first.
   */
  private releaseLock(lock: string, body: string): void {
    try {
      // Not ours (stolen, cleared by hand, already replaced) — or unreadable,
      // which is not a body we can prove anything about. Either way: hands off.
      if (readFileSync(lock, "utf8") !== body) return;
    } catch (e) {
      // ENOENT alone is "already gone". Treating EVERY read failure as gone
      // left a lock on disk naming THIS process's live pid, which
      // `stealIfOwnerGone` scores `owner === process.pid && raw !== body` ⇒
      // "held by a live owner" — unstealable by us, unstealable by anyone, for
      // the rest of the process lifetime. The record is then unwritable and
      // unclosable while the box bills. Any other errno proves nothing about
      // the body, so fall through to the take-then-compare below, which puts
      // back whatever it cannot prove is ours. Same hardening as
      // `stealIfOwnerGone`'s `readFileSync` arm.
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return;
    }
    const claimed = `${lock}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
    try {
      renameSync(lock, claimed);
    } catch {
      return; // already gone
    }
    this.afterLockTake?.(claimed);
    let onDisk: string | undefined;
    try {
      onDisk = readFileSync(claimed, "utf8");
    } catch {
      // Unreadable ≠ ours. Same reasoning as `stealIfOwnerGone`'s take: a failed
      // read cannot prove the generation taken is the one this invocation
      // claimed, and `stealIfOwnerGone` can retire our lock and a new writer
      // claim the path between the read above and the rename. `undefined`
      // matches no body, so the take falls through to the put-back below.
      onDisk = undefined;
    }
    if (onDisk === body) {
      rmSync(claimed, { force: true });
      return;
    }
    // Foreign — or unreadable — body: the lock was replaced between the read
    // above and the rename. Put it back — `link`, never `rename`, which would
    // overwrite a lock claimed at the path while this one was held aside.
    if (putBack(claimed, lock)) {
      rmSync(claimed, { force: true });
      return;
    }
    // Put-back failed, so the path is EMPTY and a live holder is inside its
    // `fn()`. Throwing is not available here — this runs in a `finally`, where
    // it would replace the caller's real error — but silence is what let the
    // next contender claim a lock somebody else still holds. Log it: only an
    // operator can restore the path from `claimed`.
    this.emit(null, "lock.not-restored", Date.now(), "error", {
      code: "lock_not_restored",
      message: `run record lock left vacated on release: ${lock} (body held aside at ${claimed})`,
    });
  }

  /** Write-temp-then-rename. There is no in-place partial-write path (INV-3). */
  private atomicReplace(runId: string, rec: RunRecord): void {
    const p = this.path(runId);
    const tmp = `${p}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
    const fd = openSync(tmp, "wx", 0o600);
    let fdOpen = true;
    try {
      writeFileSync(fd, serialize(rec));
      // The RECORD is the durable artifact — it is the one file carrying
      // `keyHash` and `vmName`, and a truncated one makes `readRecord` throw
      // for that run forever, which is a key nobody can revoke. The ephemeral
      // lock was fsynced (`claimLock`) and this was not: exactly inverted.
      fsyncSync(fd);
      // Cleared BEFORE the call — see claimLock: a throwing close still
      // consumes the descriptor, so the catch must not close it again.
      fdOpen = false;
      closeSync(fd);
      this.beforeRename?.(tmp);
      renameSync(tmp, p);
      // ponytail: the FILE is fsynced, the directory entry is not. A power loss
      // in this window loses the rename, not the bytes — the record reverts to
      // its prior complete contents, never a truncated one, which is the
      // failure INV-3 actually cares about. An `opendir`+`fsync` here costs a
      // second synchronous flush on every `set()`/`close()`; add it if a crash
      // is ever observed losing a mutation that was reported committed.
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

/**
 * Re-link a lock body held aside at `claimed` back to `lock`. True when the
 * caller may unlink `claimed`.
 *
 * The return value is the whole point. `link` succeeding puts the body back;
 * EEXIST means the path already carries a NEWER claim, which supersedes this
 * body anyway — both leave the live lock reachable, so `claimed` is redundant.
 * Any OTHER errno (ENOSPC, EMLINK, EDQUOT, EPERM on a mount without hardlink
 * support, EIO) means the put-back did NOT happen, and `claimed` is then the
 * ONLY remaining link to that body: unlinking it destroys a lock a live holder
 * is still inside, letting two `setLocked` read-modify-writes overlap and drop
 * a field. Leave it on disk instead — it is pid-stamped, so `cleanStaleTemps`
 * really does sweep it once this process is gone.
 *
 * Same shape as `scripts/lib/run-lock.ts`'s release, for the same reason.
 */
function putBack(claimed: string, lock: string): boolean {
  try {
    linkSync(claimed, lock);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EEXIST";
  }
}

/**
 * `rm -f` that cannot throw. Used where the removal is pure hygiene and the
 * caller is past the point where failing is safe — a leftover is pid-stamped,
 * so `cleanStaleTemps` really does sweep it once this process is gone.
 */
function rmQuiet(p: string): void {
  try {
    rmSync(p, { force: true });
  } catch {
    // Nothing to do and nothing at risk: the file is inert and pid-stamped.
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
