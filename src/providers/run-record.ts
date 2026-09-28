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
  closeSync,
  fsyncSync,
  linkSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
// Named import, not the global: the wait budget below must be MONOTONIC, and
// spelling the source makes that impossible to satisfy accidentally.
import { performance } from "node:perf_hooks";
import { log, newRequestId } from "../swarmclaw/log.ts";
import { assertDirMode0700, atomicReplaceFile, fsyncDir, rmQuiet } from "./fs-atomic.ts";

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

/**
 * Value shapes the core schema admits.
 *
 * `strings` is an array of TEXT, and it is deliberately a separate kind from
 * `ports` (an array of integers) rather than a shared "array" kind: integers
 * cannot be credentials, text can, so the two take different paths through
 * `assertNoSecret`. Collapsing them is how the scan gets skipped.
 */
export type FieldKind = "string" | "int" | "ports" | "strings" | "numbers";

/**
 * How many elements a `strings` field may hold, and how long each may be.
 *
 * The field this exists for is `extensions.approval.supersededReportIds`,
 * which gains one element on every df3-4 AC1(a2) rebind with nothing else
 * capping it — and the record is re-read in full by `fleet status` and by
 * every `list()` sweep, so unbounded growth is a fleet-wide read cost
 * discovered long after the writes that caused it. The story bounds
 * `proposal` at 8_000 chars and `reason` at 1_000 and is silent here, so the
 * bound is set at the store instead: a named schema rejection at the WRITE,
 * like every other bound in this file, never a disk problem later.
 *
 * 200 chars per element is the file's usual LOOSER backstop, not a tight fit:
 * a `reverifyId` is `rv-<runId>-<iso>-<6>` (src/reverify/runner.ts) and tops
 * out near 98 chars with a maximum-length run id, so nothing legal is close.
 *
 * The COUNT bound sheds rather than throws (`shedStrings`); the per-element
 * LENGTH bound still throws. The asymmetry is deliberate: an over-long element
 * is one bad value the caller can fix and resend, while an over-count array is
 * the append-only history simply having run — there is nothing for a caller to
 * fix, and a throw there bricks every later write for that run.
 */
const STRINGS_MAX_ELEMENTS = 256;
/** Exported so producers of the scalar fields this length-bounds (approval-gate.ts's
 *  `MAX_REPORT_ID_CHARS`) reference ONE number instead of hardcoding a second
 *  copy that can drift (round-5 BE-9). */
export const STRINGS_MAX_ELEMENT_LEN = 200;

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

/**
 * What an extension field may hold. `string[]` is the `strings` kind — see
 * `FieldKind`. Widening this is what lets `supersededReportIds` carry its
 * ordered rebind history instead of one displaced id.
 */
export type ExtensionValue = string | number | string[] | number[];

export interface ExtensionEntry {
  schemaVersion: number;
  [field: string]: ExtensionValue;
}

export type RunRecordExtensions = Record<string, ExtensionEntry>;

/** Extension fields as a caller supplies them — `schemaVersion` is the store's to stamp. */
export type ExtensionPatch = Record<string, Record<string, ExtensionValue>>;

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
 *
 * `retired` maps a field this namespace NO LONGER accepts to the field that
 * replaced it. Removing a name from `fields` only stops new writes — records
 * written by the older build still carry the old key, and the per-namespace
 * deep merge re-persists it verbatim on every later write, forever. A retired
 * name is therefore declared, not deleted, so `validateExtensions` can fold its
 * value into the successor and drop it (see the migration there).
 */
export const EXTENSION_NAMESPACES: Readonly<
  Record<
    string,
    {
      schemaVersion: number;
      fields: Readonly<Record<string, FieldKind>>;
      retired?: Readonly<Record<string, string>>;
    }
  >
> = {
  /**
   * DF5.2's PR correlation. Exactly three fields, written when the host first
   * holds the PR and never retroactively: `prUrl`/`prNumber` are DF5.3's first
   * hop, and `createdAt` is an ISO-8601 stamp from the HOST clock — never
   * GitHub's `created_at`, whose server clock is not comparable with the host
   * clocks that stamp `ReverifyReport.completedAt` and the approval's
   * `decidedAt`. DF5.4-C6 orders re-verify-precedes-PR by comparing host
   * clocks only.
   *
   * On the path that opens the PR, `createdAt` is the stamp taken immediately
   * before `POST /pulls` — the creation instant under the host clock. On the
   * two paths that adopt an EXISTING PR instead of posting (a lost `POST
   * /pulls` response recovered by the reuse probe, and a 422 "already exists"
   * from a concurrent caller), no host stamp for the true creation is
   * recoverable, and `createdAt` is the host's FIRST-OBSERVATION time. It is
   * then later than the true creation — conservative for C6's ordering, and
   * not a claim about when GitHub made the PR.
   */
  pr: { schemaVersion: 1, fields: { prUrl: "string", prNumber: "int", createdAt: "string" } },
  /**
   * DF6.1's PR-feedback fix loop. `fixContext`/`fixOutcome` are JSON-encoded
   * payloads (there is no object kind, and none is owed — see DF6.1a Contracts/
   * Schema). DF6.1a adds three fields, adds-only: `fixAttemptRunIds` is the
   * parent record's attempt-time ledger (one minted fix-run id appended per
   * attempt), `fixRun` is the mint-time marker (`"true"`) on each fix run's own
   * record, and `fixOutcomeClass` is the per-attempt terminal-outcome
   * classification carrier DF6.1b writes under the parent lock.
   */
  fixLoop: {
    schemaVersion: 1,
    fields: {
      fixContext: "string",
      fixOutcome: "string",
      fixAttemptRunIds: "strings",
      fixRun: "string",
      fixOutcomeClass: "string",
    },
  },
  /** DF3.2 */
  fanout: { schemaVersion: 1, fields: { fanoutId: "string", arm: "string" } },
  /**
   * Q1.4: the cancel mark. Written by `fleet cancel` BEFORE the teardown runs
   * (so a cancelled-then-closed record reads `cancelled` in the result payload,
   * not `completed`), and anchored for idempotency on the RECORD CLOSE the
   * teardown performs — a mark without a close is the crash-recovery case and
   * re-runs the teardown, never a no-op that strands a live box.
   */
  cancel: { schemaVersion: 1, fields: { state: "string", at: "string" } },
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
   * DF3.4's pre-PR approval gate, registered here so DF5.1 — the single owner
   * of the `requestApproval` CALLER — can bind a green host verdict to a
   * decision. `reportId` is a `ReverifyReport.reverifyId` and `headSha` is that
   * same report's head: the approval binds to one report, not to a run in
   * general.
   *
   * `supersededReportIds` is the FULL rebind history, ordered oldest-first —
   * each AC1(a2) rebind appends the id it displaced. It replaces the singular
   * `supersededReportId` this namespace carried while DF5.1 was the only
   * writer: two fields would be two sources of truth for the same fact in the
   * one place a disagreement is worst, an approval audit trail, and the
   * per-field deep merge in `validateExtensions` makes keeping them consistent
   * a trap (a write that omits one silently retains the previous cycle's
   * value). DF5.1's published `ApprovalOutcome.supersededReportId` is
   * unaffected: "the id THIS call displaced" is a per-call fact, derived at
   * that seam rather than stored here.
   *
   * The scalar is RETIRED, not merely unregistered (see `retired` below):
   * dropping it from `fields` alone left every pre-DF3.4 record carrying a
   * `supersededReportId` that could no longer be read as a field, no longer be
   * written, and no longer be cleared (writing `""` is now `unknown key`) —
   * while the merge re-persisted it beside `supersededReportIds` on every
   * write. That is precisely the two-disagreeing-sources-of-truth state the
   * paragraph above says an approval audit trail must never reach. The
   * `schemaVersion` bump to 2 marks the records the migration has passed
   * through, so a future repair has a hook to find the ones it has not.
   *
   * There is deliberately NO `bundlePath` field. DF2.5 already decided this
   * and in the other direction — "Harvest writes NOTHING to the run record:
   * the bundle's presence at `<runsDir>/<run-id>.bundle` is the record, and
   * DF2.1's schema stays closed" (harvest.ts:18-19) — and registering it here
   * would reverse a stated invariant of a story this one does not own. It
   * would also buy nothing: the path is `join(runsDir, runId + ".bundle")`
   * (harvest.ts:435-436), a pure function of the run id, so AC1(a2)'s
   * "refuse a rebind whose bundlePath differs" can never fire on a real
   * mismatch — and the one case where it COULD fire is a false positive: move
   * `QDS_RUNS_DIR` between the two calls and a legitimately relocated bundle
   * is refused, so storing the path makes the gate more fragile, not less. A
   * rebind re-validates by EXISTENCE instead, which is strictly stronger — it
   * proves the bundle is there now, rather than that two
   * equal-by-construction strings are equal. Do not "fix" this omission.
   *
   * `requestId` is the dispatch correlation id, and `expiresAt` is what the
   * lazy timeout sweep reads.
   *
   * The dispatch id reaches gate events under the key `dispatchRequestId`, NOT
   * `requestId` — this line used to say "carried onto every gate event", which
   * read as a claim about the `requestId` field and is the opposite of what the
   * emitters do. `requestId` on a gate event is the EMITTING context's own id
   * (the CLI's per-invocation one; the gate's, which is the run's because the
   * gate is a library call), so the two keys can hold different values in one
   * stream. `dispatchRequestId` is the cross-process join, and DF5.3 joins on
   * it. See `emitPause` in `src/fleet/approval-gate.ts` and `gateEvent` in
   * `scripts/fleet.ts`.
   *
   * States: `pausing` (created before teardown, not yet promoted),
   * `awaiting-approval`, then terminal `approved` / `rejected` / `timed-out`.
   * DF3.4 owns the decide side and may extend these fields.
   */
  approval: {
    schemaVersion: 2,
    fields: {
      state: "string",
      proposal: "string",
      reportId: "string",
      headSha: "string",
      requestId: "string",
      expiresAt: "string",
      requestedAt: "string",
      supersededReportIds: "strings",
      approverId: "string",
      decidedAt: "string",
      reason: "string",
    },
    retired: { supersededReportId: "supersededReportIds" },
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
  /**
   * DF1.10 review round 3 (discharging #221, user-authorized): teardown's
   * artifacts step is deliberately NON-FATAL so revoke+destroy always run —
   * an undestroyable box is money without bound. Before this namespace the
   * loss of the run's artifact bundle lived only in the host log stream, and
   * `fleet status` could not show it. `artifactsCode`/`artifactsMessage` are
   * the typed failure as `runArtifactsStep` logged it; `artifactsFailedAt`
   * is the HOST clock stamp of the failed pull. `extensions` stays writable
   * after close (see `set`), which is what makes this writeable from the
   * teardown path — closure freezes lifecycle facts, not cross-cutting state.
   */
  teardown: {
    schemaVersion: 1,
    fields: {
      artifactsCode: "string",
      artifactsMessage: "string",
      artifactsFailedAt: "string",
    },
  },
  /**
   * S1 rig_swarm: per-seat provider keys. `seats`, `keyHashes` and
   * `limitMicroUsd` are index-aligned (seat[i]'s hash is keyHashes[i], its
   * granted cap limitMicroUsd[i] — the cost ledger's INV-COST-5 attribution
   * for a swarm token row resolves through this trio). The single-key core
   * fields (`keyHash`/`limitMicroUsd`) stay untouched: a swarm run carries NO
   * core keyHash, and teardown branches on this namespace's presence.
   * `limitMicroUsd` is optional by era: records written before the stamp
   * predate it, and the ledger refuses those rows rather than guessing a cap.
   */
  swarmSeats: {
    schemaVersion: 1,
    fields: { seats: "strings", keyHashes: "strings", limitMicroUsd: "numbers" },
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
 * `create()` accepts a caller-supplied id (the store API does not force
 * `newId`; `scripts/run-record.ts create <id>` passes argv straight through),
 * so `trailing-` records exist by construction from any earlier build. Applying
 * the strict grammar on the READ
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
 * How long a temp stamped with OUR OWN pid must sit untouched before
 * `cleanStaleTemps` treats it as leftover rather than a sibling thread's
 * in-flight write. See the sweep for why our pid cannot simply be spared.
 */
const OWN_TEMP_GRACE_MS = 60_000;

/**
 * How far into the FUTURE a temp's mtime may sit before the sweep calls it
 * clock disagreement rather than write-time jitter. `mtimeMs` is sub-millisecond,
 * `Date.now()` is not, so a just-written file legitimately reads ~−1ms; an NTP
 * step forward — the case this bound exists for — moves a clock by whole
 * seconds. Anything whose age reads below minus-tolerance is unprovable from
 * here and never swept.
 */
const FUTURE_MTIME_TOLERANCE_MS = 2_000;

/**
 * How long a lock stamped with OUR OWN pid but carrying a foreign body must sit
 * untouched before `stealIfOwnerGone` treats it as a dead sibling's leftover
 * instead of a sibling thread's live claim.
 *
 * The pid alone cannot make this call: two JS threads share `process.pid`, so a
 * same-pid body is either a live sibling holder — stealing it lets two
 * `setLocked` read-modify-writes overlap — or a sibling thread that DIED
 * holding its claim, which used to wedge the id for the rest of the process
 * lifetime (`isAlive(pid)` stays true forever, and no sweep touches locks). No
 * portable API separates the two: a module-init nonce differs per thread by
 * construction (which would make LIVE siblings stealable), and process start
 * time is not exposed without shelling out. Age is the separator, mirroring
 * OWN_TEMP_GRACE_MS. The bound is looser than a temp's — the claim spans a
 * whole read-modify-write, not one write-and-rename — but an operation still
 * inside its lock after a full minute is wedged by some other means anyway,
 * and waiting for it was the outage.
 */
const OWN_LOCK_GRACE_MS = 60_000;

/**
 * How long a zero-byte `<runId>.json` must sit untouched before `create()`
 * treats it as an interrupted create's tombstone rather than a sibling's
 * in-flight one. See `clearCreateTombstone`.
 */
const CREATE_TOMBSTONE_GRACE_MS = 5_000;

/**
 * How long a `.orphan.` file (a held-aside lock body or restored tombstone
 * window that `parkAside` moved out of the sweep's reach as EVIDENCE) must sit
 * before the sweep reaps it.
 *
 * These bytes exist because some window could not be proven disposable, and
 * `lock.not-restored` told an operator where they are. Unbounded accumulation
 * is the alternative — repeated `putBack` failures in an ENOSPC loop park one
 * per failure — so they age out on a LONG grace instead of living forever:
 * 24h of wall time is ample for an operator to inspect and restore, and past
 * it the evidence is worth less than the disk. ponytail: wall-clock age only;
 * lease renewal if orphan volume ever matters.
 */
const ORPHAN_GRACE_MS = 86_400_000;

/**
 * The STRICT grammar of a temp file this module itself creates. See
 * `cleanStaleTemps` for why the sweep admit-lists this shape instead of
 * sweeping every `.tmp` it finds.
 *
 * Three spellings, sharing one tail — `<id>.json[.lock|.tomb].<pid>.<8hex>.tmp`:
 * the record temp (`atomicReplace`), the lock claim/steal temp
 * (`claimLock`/`stealIfOwnerGone`/`releaseLock`), and the tombstone-removal
 * temp (`clearCreateTombstone`). The `.json` segment is the discriminator: the
 * run-lock module (`scripts/lib/run-lock.ts`) writes ITS claim temps into this
 * same directory as `<id>.lock.<hostTag>.<pid>.<hex>.tmp` — no `.json` — and
 * its host tag folds arbitrarily characters in, so parsing a pid out of an
 * arbitrary `.tmp` name lands on ANOTHER CONTRACT'S in-flight claim. That was
 * a deletion of a remote invocation's live claim temp (its `linkSync` then
 * died on ENOENT, classified nowhere). Host-blind deletions require an exact
 * home-grammar match; anything else is never ours to reap.
 */
const RUN_RECORD_TEMP_RE = /^[a-z0-9][a-z0-9-]*\.json(?:\.(?:lock|tomb))?\.[0-9]+\.[0-9a-f]{8}\.tmp$/;

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

/**
 * The typed verdict both run-id asserts throw. A dedicated subclass, not a
 * message prefix: `assertFleetRunId` (src/fleet/dispatch.ts) has to separate
 * "the operator's id failed the shape check" (exit 2) from a bug inside the
 * check itself (exit 1), and matching `"invalid run id:"` text breaks the
 * moment the message is reworded — or misclassifies any other error that
 * happens to start with those bytes. `instanceof Error` still holds, so every
 * consumer that only cares that it IS an error is unchanged.
 */
export class InvalidRunIdError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidRunIdError";
  }
}

/**
 * The machine-readable verdicts the store attaches to its refusals.
 *
 * A refusal that carries only prose forces its callers to match message text,
 * and `driver.ts` had to do exactly that for the lock timeout — a routing
 * decision whose non-match arm is DESTRUCTIVE (`rmSync` of a record another
 * writer still holds the lock on). A `code` makes the discriminator explicit
 * and, being a union, makes a typo a type error on both sides. Not a subclass:
 * these are three unrelated refusals with nothing to share but the tag, and
 * `instanceof Error` plus the existing message text are unchanged for every
 * consumer that only cares that it IS an error.
 */
export type RunRecordErrorCode = "lock-timeout" | "schema-rejected" | "listing-partial";

function runRecordError(code: RunRecordErrorCode, message: string): Error {
  return Object.assign(new Error(message), { code });
}

export function assertValidRunId(id: unknown): asserts id is string {
  if (typeof id !== "string" || id.length === 0 || id.length > RUN_ID_MAX || !RUN_ID_RE.test(id)) {
    throw new InvalidRunIdError(
      `invalid run id: ${JSON.stringify(id)} (must match ${RUN_ID_RE.source} and be <= ${RUN_ID_MAX} chars)`,
    );
  }
}

/** The read/write-path admission rule: `assertValidRunId` plus the legacy tail. */
export function assertExistingRunId(id: unknown): asserts id is string {
  if (typeof id !== "string" || id.length === 0 || id.length > RUN_ID_MAX || !LEGACY_RUN_ID_RE.test(id)) {
    throw new InvalidRunIdError(
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
  // `ghs_` is the one a real clone URL carries: an App-authenticated remote is
  // `https://x-access-token:ghs_…@github.com/org/repo`, which is exactly the
  // string a caller writes to `httpsUrl` or `extensions.pr.prUrl`. The shape
  // heuristic cannot catch it either — anything matching `scheme://` returns
  // early below — so a missing prefix here is a token persisted forever.
  // `ghu_`/`ghr_` are the same family (user-to-server, refresh).
  "ghs_",
  "ghu_",
  "ghr_",
  "github_pat_",
  "xoxb-",
  "xoxp-",
  // Same Slack family as `xoxb-`/`xoxp-`: app-level, app-config and refresh.
  "xapp-",
  "xoxa-",
  "xoxr-",
  // Stripe's RESTRICTED keys, the pair to `sk_live_`/`sk_test_` above. Both
  // modes, for the same reason the `sk_` pair carries both.
  "rk_live_",
  "rk_test_",
  // A Google API key is 39 characters — one short of `LONG_TOKEN_RE`'s 40-char
  // floor in `step-log.ts`, and that floor is load-bearing at 40 because a git
  // SHA sits there. So the shape heuristic cannot reach this issuer at any
  // charset, and the prefix is the only thing that catches it. Beware the
  // false comfort of `GOOGLE_API_KEY=AIza…`, which DOES redact today only
  // because `=` is inside the token charset and glues the name onto the key
  // past the floor; delimited by a space, quote or colon it survives intact.
  //
  // The one entry here not followed by a separator, so it is also the one most
  // exposed to a false positive on some future capitalised identifier starting
  // `AIza`. Nothing in the tree hits that today; if one ever does, the answer is
  // a longer prefix (`AIzaSy`), not dropping the entry.
  "AIza",
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
  // No `extensions.approval` path is exempt. `supersededReportIds` in
  // particular stays subject to the heuristic: a reverify id is short and
  // lowercase by construction (src/reverify/runner.ts builds it that way for
  // exactly this reason), so the check costs it nothing and must keep running
  // on the approval field a caller could put arbitrary text into.
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
 * What a retired (`spec.retired`) scalar folds into when it trips the secret
 * scan: the migration cannot throw on it (the fold re-runs from disk on every
 * write, so a throw bricks the record — see the fold), and it may not store the
 * scanned value either, so the audit trail keeps the SHAPE of "a value stood
 * here" without the value. Not step-log's `«redacted»` marker: that module
 * imports `SECRET_PREFIXES` from this one, so the edge may not run the other
 * way.
 */
const REDACTED_PLACEHOLDER = "[redacted]";

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
  // ARRAYS ARE WALKED, not waved through. The early return below is correct
  // for `ports` — an integer cannot be a token — and it was the whole function
  // for as long as `ports` was the only array in the schema. The moment an
  // array of TEXT became writable (`strings`, for
  // `extensions.approval.supersededReportIds`) that same line became a hole:
  // every element skipped the prefix scan AND the shape heuristic and landed
  // on disk unread, which is INV-2 silently not running on the newest field.
  //
  // Recursion, not `.filter(isString)`: a mixed array must still have its
  // strings scanned, and its non-strings hit the early return one level down.
  // The element is reported under the FIELD's path — an index would not help a
  // caller who supplied the array whole, and `SHAPE_EXEMPT_PATHS` is keyed on
  // that path, so the exemption stays consistent across every element.
  if (Array.isArray(value)) {
    for (const el of value) assertNoSecret(key, el);
    return;
  }
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
  if (SHAPE_EXEMPT_PATHS.has(key)) {
    // The exemption stops the HEURISTIC, not validation: these paths are
    // exempt precisely because their grammar is pinned elsewhere
    // (`REPO_SLUG_PATTERN`'s two `[A-Za-z0-9._-]{1,100}` segments,
    // issue-correlation's MAX_ISSUE_ID), and an exemption with no ceiling is a
    // persist-forever door — a >40-char mixed-class blob pasted into `repoSlug`
    // passes the slug grammar and skips the one test that could catch it. The
    // length half of that grammar is mirrored here as the write-time backstop;
    // the upstream schema remains the authority, and if it ever tightens the
    // mirror is deliberately the LOOSER bound, so this never rejects a value
    // the owning schema accepts.
    if (v.length > 201) throw new Error(`value exceeds the field's grammar bound: ${key}`);
    return;
  }
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
    if (typeof value !== "string") throw runRecordError("schema-rejected", `${key} must be a string`);
    return;
  }
  if (kind === "int") {
    if (typeof value !== "number" || !Number.isInteger(value)) {
      throw runRecordError("schema-rejected", `${key} must be an integer`);
    }
    return;
  }
  // EXPLICIT, not the trailing else it used to be. `ports` was the implicit
  // fallthrough while it was the only array kind, and the moment a second one
  // (`strings`) exists that shape silently routes every string array into the
  // array-of-INTEGERS check below — a kind that can never accept a legal
  // value, failing at the write with a message naming the wrong type.
  if (kind === "ports") {
    if (!Array.isArray(value) || value.some((p) => typeof p !== "number" || !Number.isInteger(p))) {
      throw runRecordError("schema-rejected", `${key} must be an array of integers`);
    }
    return;
  }
  // S1: an index-aligned array of µ$ figures (swarmSeats.limitMicroUsd) —
  // integers like `int`, plural like `ports`/`strings`, but WITHOUT ports'
  // 1..65535 range: a 500_000 µ$ seat cap is a legal, ordinary value here.
  if (kind === "numbers") {
    if (!Array.isArray(value) || value.some((n) => typeof n !== "number" || !Number.isSafeInteger(n))) {
      throw runRecordError("schema-rejected", `${key} must be an array of safe integers`);
    }
    return;
  }
  // Also explicit. Making `ports` explicit while leaving `strings` as the new
  // trailing else would hand kind #5 the identical bug one branch later, and
  // silently — the `never` assignment below is what makes the compiler, not a
  // future reviewer, be the one that notices.
  if (kind === "strings") {
    if (!Array.isArray(value) || value.some((s) => typeof s !== "string")) {
      throw runRecordError("schema-rejected", `${key} must be an array of strings`);
    }
    // Empty elements are named, not waved through. A `strings` field is an
    // append-only audit history (`supersededReportIds`); an empty entry in one
    // is a lost write masquerading as a stored id — every reader that joins or
    // displays the history sees a hole no caller ever meant to write. The
    // index is in the message so the caller can find the element in the array
    // it supplied whole.
    const empty = value.findIndex((s) => (s as string).length === 0);
    if (empty !== -1) {
      throw runRecordError("schema-rejected", `${key}[${empty}] must be a non-empty string`);
    }
    // Bounds are part of the KIND, not of one field's own validation, so every
    // future `strings` field inherits them instead of re-deriving them (or not).
    // The counts are named in the message: "too long" without the numbers sends
    // an operator to read the source to find out what the limit was.
    //
    // The COUNT throw is a backstop, not the live policy: every extension write
    // routes the value through `shedStrings` first, which drops the oldest
    // elements instead of failing the write (see there for why an append-only
    // history cannot be bounded by a throw). It stays because a future `strings`
    // CORE field would reach this check without passing that one.
    if (value.length > STRINGS_MAX_ELEMENTS) {
      throw runRecordError("schema-rejected", `${key} has ${value.length} elements, over the ${STRINGS_MAX_ELEMENTS} bound`);
    }
    const over = value.findIndex((s) => s.length > STRINGS_MAX_ELEMENT_LEN);
    if (over !== -1) {
      throw runRecordError(
        "schema-rejected",
        `${key}[${over}] is ${(value[over] as string).length} chars, over the ${STRINGS_MAX_ELEMENT_LEN} bound`,
      );
    }
    return;
  }
  // Unreachable while `FieldKind` has four members; a fifth added without a
  // branch here is a COMPILE error rather than a value that validates nothing.
  const unhandled: never = kind;
  throw runRecordError("schema-rejected", `${key} has an unhandled field kind: ${String(unhandled)}`);
}

/**
 * Drop-oldest shedding for a `strings` value, applied at the WRITE.
 *
 * `STRINGS_MAX_ELEMENTS` bounds a field whose producer only ever APPENDS —
 * `supersededReportIds` gains one element per df3-4 AC1(a2) rebind and nothing
 * caps the rebinds — and a bound with no shedding policy on a growing field is
 * not a bound, it is a brick: the write that crosses it throws out of
 * `store.set` as an unnamed store exception, every LATER write for that run
 * fails identically because no caller can shrink the field, and the run is
 * stuck mid-approval with no route forward. Shedding keeps the property the
 * bound exists for (the record is re-read in full by `fleet status` and every
 * `list()` sweep) while leaving the run writable.
 *
 * The HEAD is what goes: the history is ordered oldest-first, so the freshest
 * ids — the ones a decision could still be checked against — survive. This is
 * bounded data loss in an audit trail, so it is announced on stderr rather than
 * done quietly, and the note NAMES the dropped ids: "the N oldest" without
 * them is a loss nobody can attribute. `noteOnStderr` because this is a free
 * function with no request context to log under, and a diagnostic must never
 * fail the write.
 */
function shedStrings(key: string, value: unknown): unknown {
  if (!Array.isArray(value) || value.length <= STRINGS_MAX_ELEMENTS) return value;
  const dropped = value.length - STRINGS_MAX_ELEMENTS;
  noteOnStderr(
    // LENGTHS, not values. `strings` elements are caller text — the same field
    // is subject to `assertNoSecret` — so echoing the dropped ids verbatim
    // here would put unscanned payload on stderr ahead of the scan this note
    // itself is announcing. A length plus the surviving count is everything a
    // caller needs to recognise the shed.
    `run-record: ${key} reached the ${STRINGS_MAX_ELEMENTS}-element bound; dropping the ${dropped} oldest (element lengths ${value
      .slice(0, dropped)
      .map((s) => (typeof s === "string" ? s.length : "?"))
      .join(", ")}); ${STRINGS_MAX_ELEMENTS} survive\n`,
  );
  return value.slice(dropped);
}

/**
 * Copy an array value in, so the stored entry never ALIASES the caller's array.
 *
 * `merged` is a `structuredClone` of what was already on the record, so the
 * existing side was never shared — but the INCOMING value was stored by
 * reference. Every extension value was a primitive until `strings` existed, so
 * nothing could observe it; now `set()` would hand back a record sharing
 * caller-owned mutable state, and a later push to that array silently
 * desynchronizes the in-memory record from the bytes on disk. In an approval
 * audit trail that divergence IS the defect.
 *
 * A SHALLOW copy is complete on the WRITE path, not a shortcut: `assertKind`
 * has already proven a `strings` value is a flat array of strings, and strings
 * are immutable — there is no deeper structure for `structuredClone` to reach,
 * so it would buy nothing and cost a serialization round trip on every write.
 * If a future `FieldKind` ever admits a nested value, this is the one place
 * that has to change.
 *
 * The READ path reaches here through a `continue` that skips both `assertKind`
 * and `assertNoSecret`, so that precondition does NOT hold there and a nested
 * value stays aliased into the entry. Harmless by construction, and stated
 * rather than left implied: read mode exists only to VALIDATE (`assertWellFormed`
 * discards the returned object and `readRecord` returns the parsed record
 * itself), so the aliasing entry is unreachable and collected. A caller that
 * ever starts using read mode's RESULT has to deep-copy here first.
 */
function detached(value: ExtensionValue): ExtensionValue {
  // The cast is the union-widening talking: spreading `string[] | number[]`
  // infers `(string | number)[]`, which is neither member. Runtime is the
  // same shallow copy it always was.
  return Array.isArray(value) ? ([...value] as ExtensionValue) : value;
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
        entry[field] = detached(value as ExtensionValue);
        continue;
      }
      const kind = Object.hasOwn(spec.fields, field) ? spec.fields[field] : undefined;
      if (!kind) throw new Error(`unknown key: ${extPath(ns, field)}`);
      // Shed BEFORE the assertions: the count bound is a shedding policy on
      // this path, and a value that sheds must still be type- and
      // secret-checked in the shape it will actually be stored in.
      const bounded = kind === "strings" ? shedStrings(extPath(ns, field), value) : value;
      assertKind(extPath(ns, field), kind, bounded);
      assertNoSecret(extPath(ns, field), bounded);
      entry[field] = detached(bounded as ExtensionValue);
    }
    // Retired-field migration — WRITE only, and only toward the surviving
    // field. `merged` is a clone of what was on disk, so a record written by a
    // build that still had the scalar carries it into `entry` and the store
    // re-persists it beside its successor on every write for the rest of the
    // run's life. Deleting it is not enough on its own: the id it holds may be
    // absent from the array (the older writer never appended), so FOLD FIRST
    // and drop second — a migration in an audit trail may not lose an id. The
    // legacy key stays `unknown key` for a caller: this is the only route that
    // may touch it.
    if (mode === "write") {
      for (const [legacyField, into] of Object.entries(spec.retired ?? {})) {
        if (!Object.hasOwn(entry, legacyField)) continue;
        const legacy = entry[legacyField];
        delete entry[legacyField];
        if (typeof legacy !== "string" || legacy === "") continue;
        // The fold CROSSES KINDS, and only one side of it is bounded. The
        // legacy value was a `string`, a kind with no length check at all; it
        // is becoming an ELEMENT of a `strings`, a kind whose elements are
        // capped at STRINGS_MAX_ELEMENT_LEN. Nothing downstream re-checks it —
        // `shedStrings` bounds the COUNT only, and the result is assigned
        // straight to `entry[into]`, past the `assertKind`/`assertNoSecret`
        // pair the normal write path runs. So an over-length scalar written by
        // the older build lands as an element no `strings` value may legally
        // hold, and the damage is DEFERRED: the next AC1(a2) rebind appends to
        // this array and DOES route the whole thing through `assertKind`, which
        // throws out of `store.set` — and every later write for that run fails
        // identically, because no caller can reach in and shorten the element.
        // That is the same brick `shedStrings` exists to prevent, entered
        // through the migration door.
        //
        // DROPPED, loudly, rather than truncated: a truncated report id is a
        // WRONG id in an audit trail, and silently binding a decision to one is
        // worse than a recorded absence. Announced on stderr for the same
        // reason `shedStrings` announces its own bounded loss.
        if (legacy.length > STRINGS_MAX_ELEMENT_LEN) {
          noteOnStderr(
            `run-record: ${extPath(ns, legacyField)} is ${legacy.length} chars, over the ${STRINGS_MAX_ELEMENT_LEN}-char bound on ${extPath(ns, into)} elements; dropping it rather than storing a value that would fail the next write\n`,
          );
          continue;
        }
        // The fold is a WRITE of an element, so it goes through the SAME door
        // the field door uses for one — `assertNoSecret` under the successor
        // path, exactly as the element would be scanned had it arrived as
        // `supersededReportIds: [legacy]`. Without this, a credential-shaped
        // legacy scalar (short enough to pass the length guard above) landed in
        // the array UNSCANNED — INV-2 bypassed through the migration door — and
        // the damage surfaced on the NEXT rebind, whose write threw out of
        // `store.set` naming an array the caller never supplied. Keyed on
        // `into`, not `legacyField`: that is the path the value will live
        // under, and the one `SHAPE_EXEMPT_PATHS` is keyed by.
        //
        // But the door CLOSES rather than THROWS here. This fold re-runs on
        // every write that sees the scalar — `merged` is a clone of disk, and
        // the `delete` above only reaches disk once the write persists — so a
        // throw fires BEFORE the fold lands, the scalar survives on disk, and
        // every later `store.set` for that run re-folds the same value and
        // throws the same way. Nothing can reach in and remove a retired key,
        // so the record would be bricked for good. A pre-DF3.4 scalar is data
        // written under rules this build does not use, and the migration's
        // whole purpose is to retire it — so it is retired SANITIZED: the
        // placeholder records that a value stood here and is no longer
        // readable, and the write goes through. The non-legacy door above
        // (`assertNoSecret` at the field entry loop) still throws.
        let folded = legacy;
        try {
          assertNoSecret(extPath(ns, into), legacy);
        } catch {
          noteOnStderr(
            `run-record: ${extPath(ns, legacyField)} tripped the secret scan folding into ${extPath(ns, into)}; retiring the value (${legacy.length} chars) as ${JSON.stringify(REDACTED_PLACEHOLDER)} rather than throwing\n`,
          );
          folded = REDACTED_PLACEHOLDER;
        }
        const history = Array.isArray(entry[into]) ? (entry[into] as string[]) : [];
        if (history.includes(folded)) continue;
        // Position is decided by what the DISK state can prove. A record whose
        // stored schemaVersion already reached this namespace's version has
        // passed through a writer that runs this migration, so a scalar that
        // is present anyway was RE-WRITTEN afterwards by an older build mid
        // rolling upgrade — it postdates the migration, and folding it at the
        // head would invert the history the array's ordering exists to record.
        // Append at the tail instead: truthful relative to the migration, and
        // the best the bytes allow — the scalar's exact position among appends
        // made since the migration is recorded nowhere, so that interleave is
        // UNRECOVERABLE and the note says so rather than implying otherwise.
        if (typeof stored === "number" && stored >= spec.schemaVersion) {
          noteOnStderr(
            `run-record: ${extPath(ns, legacyField)} reappeared on a record already at schemaVersion ${spec.schemaVersion} — an older build re-wrote it after the migration ran; appending it to the tail of ${extPath(ns, into)} (its position among appends made since is unrecoverable)\n`,
          );
          // shedStrings drops from the head, so the migrated id at the TAIL
          // can never be the element shed.
          entry[into] = shedStrings(extPath(ns, into), [...history, folded]) as string[];
          continue;
        }
        // HEAD: the scalar predates every element the array writer appended.
        // At the count bound, shed the oldest HISTORY entries and keep the
        // migrated id — `[legacy, ...history]` through shedStrings would drop
        // from the head of the combined array, where the folded id sits, so
        // the migration would shed the very id it exists to preserve.
        const shed = Math.max(0, history.length + 1 - STRINGS_MAX_ELEMENTS);
        if (shed > 0) {
          noteOnStderr(
            // Same redaction discipline as `shedStrings`: lengths only, never
            // the dropped element content.
            `run-record: ${extPath(ns, into)} reached the ${STRINGS_MAX_ELEMENTS}-element bound folding retired ${extPath(ns, legacyField)}; dropping the ${shed} oldest (element lengths ${history
              .slice(0, shed)
              .map((s) => s.length)
              .join(", ")}); ${history.length - shed} history entries survive\n`,
          );
        }
        entry[into] = [folded, ...history.slice(shed)];
      }
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
   * Whether constructing the store may TOUCH the directory. Default `true` —
   * every existing caller keeps today's behaviour by omission.
   *
   * `false` opens the store for READING only, and the point is what it does
   * NOT do: no `mkdir`, no `chmod`, no O_EXCL/link probe file, no stale-temp
   * sweep. Pointed at an existing directory the write path re-permissions it to
   * 0700, so `fleet teardown qds-nosuchrun --dir /srv/existing` exited 4 as
   * promised while silently re-permissioning an operator's directory — the
   * "mutates nothing" clause of df3-1-dispatcher-core-verbs.md:88-90 broken by
   * the probe, not by the verb.
   *
   * It is a READ mode, not a lax write mode: the mutating verbs refuse on a
   * store built this way (see `assertWritable`). INV-5's guarantee is that no
   * record is ever written to a directory whose 0700 posture and O_EXCL support
   * were not proven, and skipping the proof to write anyway is exactly the
   * degradation the constructor throws to prevent.
   */
  create?: boolean;
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

/**
 * The records directory a store WOULD use, as a plain string. The constructor
 * resolves through this, so there is one copy of the chain.
 *
 * An EMPTY `QDS_RUNS_DIR` is treated as unset, not as a path: `""` is not
 * nullish, so it used to beat DEFAULT_RUNS_DIR and resolve records (and,
 * through costLedgerOpts, both money files) to cwd and cwd's PARENT — an
 * exported-unset variable (`export QDS_RUNS_DIR=$UNSET`) silently moved the
 * ledger out of `.sandbox/`. Same doctrine scripts/lib/cost-ledger-opts.ts's
 * `envPath` applies to the two override vars; folding happens here, at the ONE
 * place every caller routes through, rather than per call site. (Whitespace is
 * left alone here — unlike an env override path, this value also carries
 * explicit CLI roots whose spaces are legal.)
 *
 * Exported because the CLI needs the resolved path for a directory that may not
 * exist yet — that is the whole case it needs it for, since the read verbs
 * refuse a nonexistent `--dir` rather than creating it. A `create: false` store
 * cannot answer: it throws ENOENT on exactly that input. A second copy of the
 * chain resolves to a DIFFERENT directory the moment either end moves, and on
 * this path a different directory is a different ledger and a different record
 * set — the two stores then disagree about which runs exist.
 */
export function resolveRunsDir(dir?: string): string {
  if (dir !== undefined) return dir;
  const env = process.env.QDS_RUNS_DIR?.trim();
  if (env !== undefined && env !== "") return env;
  return DEFAULT_RUNS_DIR;
}

/** What a directory sweep read, and what it refused to read (see `listWithAnomalies`). */
export interface RunRecordListing {
  records: RunRecord[];
  /**
   * Filenames the sweep could not turn into a record, sorted (`readdir` is
   * sorted first). Either the stem is not a run id, or the BODY was unreadable,
   * unparseable or schema-rejected — from a caller's side both are the same
   * thing: a `.json` that may hold a live box and cannot be proven not to.
   */
  skipped: string[];
  /**
   * Why each `skipped[i]` was skipped — same order, same length. A parallel
   * array rather than a shape change, so every existing `skipped` call site
   * (`src/fleet/status.ts`, `reapOrphans`) keeps working unchanged while
   * `list()`'s refusal can still name the actual failure and not just the file.
   */
  skippedReasons: string[];
}

export class RunRecordStore {
  readonly dir: string;
  /** False on a `create: false` store — see `assertWritable`. */
  private readonly writable: boolean;
  private readonly requestId: string;
  private readonly beforeRename?: (tmpPath: string) => void;
  private readonly beforeStealTake?: (lockPath: string) => void;
  private readonly afterLockTake?: (claimedPath: string) => void;

  constructor(opts: RunRecordStoreOptions | string = {}) {
    const o: RunRecordStoreOptions = typeof opts === "string" ? { dir: opts } : opts;
    this.dir = resolveRunsDir(o.dir);
    this.requestId = o.requestId ?? newRequestId();
    this.beforeRename = o.beforeRename;
    this.beforeStealTake = o.beforeStealTake;
    this.afterLockTake = o.afterLockTake;
    this.writable = o.create ?? true;
    if (!this.writable) {
      this.assertReadable();
      return;
    }
    assertDirMode0700(this.dir, (mode) => new Error(`run records dir ${this.dir} is mode 0${mode}, not 0700`));
    this.assertExclusiveCreateSupported();
    this.cleanStaleTemps();
  }

  /**
   * The read-mode constructor's ONLY check: the directory is there and is a
   * directory. It reads; it never creates and never re-permissions.
   *
   * Deliberately NOT the 0700 assertion. A read-mode store is pointed at a
   * directory the caller does not own the posture of — an operator's
   * `--dir /srv/existing` — and refusing to LIST a 0755 directory helps nobody
   * while breaking the exit code the verb promised. The 0700 posture is a
   * guarantee about directories this store WRITES to, and it stays exactly as
   * strict there.
   *
   * The errno rides the thrown error for the same reason `readRecord` preserves
   * it: the CLI maps a missing `--dir` to its own exit code off the TYPED code,
   * never off message text, and what it must not get is a bare ENOENT stack out
   * of the first `readdirSync`.
   */
  private assertReadable(): void {
    let isDir: boolean;
    try {
      isDir = statSync(this.dir).isDirectory();
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      const err = new Error(`run records dir ${this.dir} is unreadable: ${code ?? (e as Error).message}`);
      if (code !== undefined) (err as NodeJS.ErrnoException).code = code;
      throw err;
    }
    if (!isDir) throw new Error(`run records dir ${this.dir} is not a directory`);
  }

  /**
   * Refuse a mutation on a store built with `create: false`.
   *
   * A read-mode store skipped the `chmod` to 0700, the mode assertion and the
   * O_EXCL/`link(2)` probe. Letting it write anyway would put records into a
   * directory whose posture and platform support were never proven — INV-5's
   * "never degrade" clause reached by omitting the proof rather than by failing
   * it. A caller that needs to write constructs a writable store; that is one
   * line at the call site and it re-runs every check.
   */
  private assertWritable(): void {
    if (this.writable) return;
    throw new Error(
      `run record store for ${this.dir} was opened read-only (create: false); construct it without create: false to write`,
    );
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
    let probeFd = -1;
    try {
      probeFd = openSync(probe, "wx", 0o600);
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
      // fsync is probed for the same reason link is: `create` fsyncs the record
      // before publishing it (INV-1's durable-handle guarantee), and on a
      // filesystem that refuses fsync on a regular file (some FUSE/network
      // mounts return EINVAL) the store used to construct cleanly and then die
      // mid-lifecycle — after the box existed — with a bare errno. Same
      // fail-closed doctrine: refuse at startup, name the primitive, never
      // degrade. If such a platform ever needs support, the answer is an
      // explicit opt-out, not a silent skip.
      //
      // Probed through the SAME exclusive-writable fd the record write path
      // holds (`openSync(p, "wx", 0o600)` then fsync): the fd is held from
      // creation above rather than re-opened read-only, so what is proven is
      // the fsync the writer actually performs — not a weaker variant that
      // happens to succeed on mounts the write path would still refuse.
      try {
        fsyncSync(probeFd);
      } catch (e) {
        throw new Error(
          `fsync is not supported here (${(e as NodeJS.ErrnoException).code ?? (e as Error).message}); the record write needs fsync(2)`,
        );
      }
    } catch (e) {
      throw new Error(`run record store cannot start in ${this.dir}: ${(e as Error).message}`);
    } finally {
      // Guarded — this function's own contract is to leave no surprises.
      if (probeFd !== -1) {
        try {
          closeSync(probeFd);
        } catch {
          // best effort; the rm below is what matters
        }
      }
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
   * ponytail: pid reuse can spare a stale temp; it is swept by the next
   * construction whose pid differs and sees the owner gone, and a stray temp is
   * inert either way.
   */
  private cleanStaleTemps(): void {
    for (const name of readdirSync(this.dir)) {
      // `.probe-<pid>-<hex>` — this module's probe file, always ours to judge.
      if (name.startsWith(".probe-")) {
        const full = join(this.dir, name);
        const owner = Number(name.split("-")[1]);
        // Same `owner > 0` rule as below: an unparsable probe carries no proof,
        // and kill(0,0)-style owners would read as permanently alive.
        if (Number.isInteger(owner) && owner > 0 && (owner === process.pid || isAlive(owner))) continue;
        rmQuiet(full);
        continue;
      }
      if (!name.endsWith(".tmp") && !name.includes(".orphan.")) continue;
      const full = join(this.dir, name);
      // `.orphan.` files are EVIDENCE (`parkAside`), moved out of every other
      // sweep's reach precisely so an operator could restore them. Unbounded is
      // not an option either, so they age out on ORPHAN_GRACE_MS — judged BEFORE
      // the home-grammar test below, since an orphan name carries no `.tmp`
      // tail by design. Being operator-addressable evidence rather than
      // in-flight state, their age is not clamped against clock steps either
      // (a stepped-forward clock merely reaps them sooner than 24h).
      if (name.includes(".orphan.")) {
        if (!olderThan(full, ORPHAN_GRACE_MS)) continue;
        rmQuiet(full);
        noteOnStderr(`run-record: reaped a long-unrestored held-aside body ${name}\n`);
        continue;
      }
      // ADMIT-LIST, not deny-list. A `.tmp` in THIS directory may belong to another
      // contract entirely: scripts/lib/run-lock.ts writes ITS invocation-lock claim
      // temps here as `<runId>.lock.<hostTag>.<pid>.<hex>.tmp` (and `.rescue`
      // files on release), with a host tag folding arbitrary characters in. This
      // module has no host identity, so a host-blind parse of such a name lands on
      // ANOTHER CONTRACT'S in-flight claim — deleting it made the remote writer's
      // next linkSync die on ENOENT, an errno nothing classified. So deletion is
      // reserved for names matching run-record's OWN grammar exactly; anything else
      // stays on disk (its own module reaps it — run-lock's reapStaleTemps matches
      // its shape WITH a host check).
      if (!RUN_RECORD_TEMP_RE.test(name)) continue;
      // Third-from-last segment for BOTH grammar tails above: `…json.<pid>.<hex>.tmp`
      // and `…json.lock.<pid>.<hex>.tmp` — `.tmp` is last, hex second-to-last.
      const owner = Number(name.split(".").at(-3));
      // `owner > 0`, not just `Number.isInteger`: `process.kill(0, 0)` signals the
      // caller's own process group and succeeds, so an owner that parsed as `0`
      // would read as permanently alive and the temp would never be swept.
      //
      // OUR OWN pid is judged by AGE, not spared outright. Two JS threads
      // (`node:worker_threads` / `Bun.Worker`) share `process.pid` — the exact
      // configuration `stealIfOwnerGone`'s docstring reasons about — so a
      // same-pid temp can be a sibling thread's in-flight `set()` temp, or a
      // lock body it is holding aside mid-steal. Deleting either destroys a
      // live claim: the temp loses that mutation, the held-aside body destroys
      // a lock a live holder is still inside, which is the lost update
      // `putBack` promises never to cause.
      //
      // But sparing our pid unconditionally made the docstring's "swept by the
      // next construction" true only for a DIFFERENT pid. A long-lived
      // dispatcher constructs one store at startup, and every temp orphaned
      // afterwards (an `rmQuiet` swallowing EACCES, a `beforeRename` abort, a
      // failed `putBack`) carries our LIVE pid and is skipped by every sweep
      // this process ever runs — unbounded accumulation for the process
      // lifetime. OWN_TEMP_GRACE_MS is the bound: both live windows above are
      // a write-and-rename wide (microseconds), so a same-pid temp untouched
      // for a full minute is leftover, not in flight.
      //
      // The FUTURE-mtime guard is the wall-clock half of that judgement: mtime
      // is stamped from the wall clock, so an NTP step FORWARD makes a live
      // sibling's fresh temp read as older-than-the-grace and gets it swept —
      // the lost mutation the pid+age scheme exists to prevent. Only a MATERIAL
      // negative age counts: `mtimeMs` carries sub-millisecond precision while
      // `Date.now()` is whole milliseconds, so a temp written this instant reads
      // ≈ −1ms — jitter, not skew. FUTURE_MTIME_TOLERANCE_MS bounds what is
      /// treated as clock disagreement; anything inside it ages normally.
      if (Number.isInteger(owner) && owner > 0) {
        let st: { mtimeMs: number };
        try {
          st = statSync(full);
        } catch {
          continue;
        }
        const ageMs = Date.now() - st.mtimeMs;
        if (ageMs < -FUTURE_MTIME_TOLERANCE_MS) continue; // future-dated ⇒ skew ⇒ never sweep
        const live = owner === process.pid ? ageMs < OWN_TEMP_GRACE_MS : isAlive(owner);
        if (live) continue;
      }
      rmQuiet(full);
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
    this.assertWritable();
    // Creation is the one moment the strict grammar can act without stranding
    // anything: no record exists yet, so refusing costs nothing.
    assertValidRunId(runId);
    const p = this.path(runId);
    const rec: RunRecord = { runId, createdAt: now.toISOString() };
    try {
      this.publishCreate(p, rec);
    } catch (e) {
      // A tombstone is not a record, and it must not make the id permanently
      // uncreatable — see `clearCreateTombstone`. One retry only: a second
      // EEXIST means a real record (or another writer's freshly published
      // create) is at the path, and INV-3's no-overwrite is absolute for those.
      if ((e as NodeJS.ErrnoException).code !== "EEXIST" || !clearCreateTombstone(p)) throw e;
      this.publishCreate(p, rec);
    }
    // …and the DIRECTORY ENTRY, which makes the new link durable. This is the
    // one place the record has no prior version to fall back to: unlike
    // `atomicReplace`, where a lost rename reverts to the previous complete
    // record, a lost create leaves NO handle at all while the provider-side box
    // survives — precisely the orphan the comment above claims to prevent. Best
    // effort by design (see `fsyncDir`): a platform that cannot sync a
    // directory must not fail the create.
    fsyncDir(this.dir);
    return rec;
  }

  /**
   * One exclusive-create attempt: write the record to a pid-stamped temp,
   * fsync it, and PUBLISH it at the final path with `link(2)`.
   *
   * The old shape wrote straight into the final path through an O_EXCL fd, and
   * that had two failure modes no amount of caller discipline could close:
   *
   *  - A kill or power loss MID-WRITE left a torn, non-zero `<runId>.json` —
   *    permanently unparseable (bricking `list()` for the directory) and
   *    permanently EEXIST (an id nothing could ever reclaim).
   *  - Two creators raced the open-then-write window itself: a creator stalled
   *    between its O_EXCL open and its write watched another dispatcher's
   *    tombstone recovery take its zero-byte file aside and win, then resumed
   *    writing through its still-open fd into what was now a foreign record —
   *    two dispatchers each believing they owned the id, one minting keys
   *    against a box the record could no longer name.
   *
   * Publishing with `link` closes both at once, the same way `claimLock`
   * claims a lock: the path appears COMPLETE or not at all — kernel-arbitrated,
   * single-winner, no in-between byte state observable at the final name. The
   * stalled creator above now loses the LINK instead of corrupting the record:
   * its EEXIST is definitive (the winner's bytes are whole at the path), so
   * ownership is granted exactly once by construction rather than reconstructed
   * afterwards with read-backs. Any torn state lives at the temp, which is
   * swept at the next construction; the final path only ever holds a record
   * whose bytes were fully written AND fsynced before they got their name.
   */
  private publishCreate(p: string, rec: RunRecord): void {
    const tmp = `${p}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
    // An EEXIST at this open is a TEMP-name collision — a 4-byte nonce landing
    // on a temp left by a crashed process that had our pid (the same reasoning
    // `claimLock` applies). Letting it propagate is the contention signal: the
    // create arm treats any throw as "this attempt failed"; the publish link
    // never ran, so the final path was not touched either way.
    const fd = openSync(tmp, "wx", 0o600);
    let fdOpen = true;
    // Set only once the fd is closed and the publish link is the next syscall:
    // distinguishes "the final name is taken" (link EEXIST, path retargeted
    // below) from "our private temp collided" (open EEXIST, path left alone).
    let reachedLink = false;
    try {
      // writeFileSync loops until the whole buffer lands; a bare writeSync can
      // short-write and leave a truncated record reported as a success.
      writeFileSync(fd, serialize(rec));
      // Sync BEFORE the link: whatever lands at the final path must already be
      // durable bytes, or the durability guarantee INV-1 sells is written in
      // the wrong order.
      fsyncSync(fd);
      // Cleared BEFORE the call — see claimLock: a throwing close still
      // consumes the descriptor, so the catch must not close it again.
      fdOpen = false;
      closeSync(fd);
      // Deliberately NOT the `beforeRename` seam: that hook is the set()-path's
      // fault injector ("must leave the PRIOR record byte-identical", AC2) — a
      // create has no prior record, and consumers keyed their fixtures to its
      // firing mid-update only. Firing it here would run their callbacks while
      // no lock yet exists, with different filesystem facts than they modelled.
      reachedLink = true;
      linkSync(tmp, p);
    } catch (e) {
      // Guarded, not try/catch'd: fd numbers are recycled, and the fault-injection
      // seam may have opened something else by the time we land here.
      if (fdOpen) closeSync(fd);
      // Quiet, same doctrine as every lock cleanup: this temp is inert litter
      // (grammar-matched and pid-stamped, so the construction sweep takes it),
      // and a throwing rm here would replace the REAL error — the EEXIST that
      // says another creator won, or the link errno that names the platform.
      rmQuiet(tmp);
      // An EEXIST from the PUBLISH LINK means the final name is taken — the
      // race loser's signal. The fs error carries the staging temp in `path`
      // (link(2) reporting the source), but every downstream classifier
      // (dispatch's run-id-in-use arm) compares against the RECORD file.
      // Retarget `path` to the final name so the loser is classified
      // run-id-in-use, not provision-failed. An EEXIST from the temp `open`
      // above (nonce collision) keeps its own path: that arm treats any throw
      // as "attempt failed" with no path semantics.
      if (reachedLink && (e as NodeJS.ErrnoException).code === "EEXIST") {
        (e as NodeJS.ErrnoException).path = p;
      }
      throw e;
    }
    // The link is the commit point. The second link is hygiene now, not the
    // body — unlinking it cannot lose bytes.
    rmQuiet(tmp);
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
   * INV-4: every `.json` in the directory must parse and validate. A malformed
   * or unreadable record is never quietly dropped — a record dropped is a key
   * that quietly keeps spending — so this accessor THROWS naming the file and
   * the reason.
   *
   * The throw is raised HERE, not from the sweep. A file this store cannot turn
   * into a record — a filename outside even the LEGACY id grammar, or a body
   * that is unreadable, unparseable or schema-rejected — took the whole
   * directory down when it propagated out of the sweep, which is a fleet-wide
   * outage over one file (see `listUnlogged`). But it cannot be silently
   * skipped either: a caller holding a bare `RunRecord[]` cannot tell "no such
   * box" from "a box behind a file I refused to read", and `reapRuns` destroys
   * every box not in that set. So the plain array is only ever handed back when
   * it is COMPLETE, and the anomaly is a value the sweep returns rather than an
   * exception the sweep raises.
   *
   * A caller that can act on the anomaly calls `listWithAnomalies()` and gets
   * both halves; a caller that cannot gets an error naming the files. Neither
   * one silently drops a live box. The skip is also on the log line, but a log
   * line cannot make a caller fail safe.
   */
  list(): RunRecord[] {
    const { records, skipped, skippedReasons } = this.listWithAnomalies();
    if (skipped.length > 0) {
      // The REASONS ride the message, not just the filenames. This is the only
      // error an operator sees for a body-level rejection now that the sweep
      // quarantines instead of propagating `readRecord`'s throw, and
      // "run-odd.json could not be read" without "unknown key: nope" is a file
      // to go and stare at rather than a diagnosis.
      const detail = skipped.map((name, i) => `${name}: ${skippedReasons[i]}`).join("; ");
      throw runRecordError(
        "listing-partial",
        `refusing to return a partial run record listing from ${this.dir}: ${skipped.length} file(s) could not be read as a record (${detail}) — use listWithAnomalies() to handle them, or repair/remove the files named`,
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
   * filename or an unreadable body, whose contents are a perfectly valid OPEN
   * record with a `vmName`, silently drops that box out of the claim set and
   * the reaper destroys a live box belonging to an open run. A log line cannot
   * prevent that; a value in the return can. `fleet status` has the same
   * problem in the reporting direction: "3 runs" and "3 runs and one record I
   * refused to read" must not render identically.
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
    const skippedReasons: string[] = [];
    for (const name of readdirSync(this.dir).sort()) {
      if (!name.endsWith(".json")) continue;
      const id = name.slice(0, -".json".length);
      let nameOk = true;
      try {
        assertExistingRunId(id);
      } catch {
        nameOk = false;
      }
      if (!nameOk) {
        const message = `malformed run record ${name}: filename is not a valid run id`;
        skipped.push(name);
        skippedReasons.push(message);
        this.emit(null, "list.anomaly", Date.now(), "error", { code: "malformed_record_name", message });
        continue;
      }
      // The BODY is quarantined per file too, not just the filename.
      //
      // One unreadable, unparseable or schema-rejected record used to throw the
      // whole sweep, and that is a fleet-wide outage rather than one bad file:
      // `listWithAnomalies()` dies, `list()` dies with it, so `reapRuns` reaps
      // NOTHING and `fleet status` renders NOTHING until an operator deletes
      // the file by hand — while every live box keeps billing. Three ordinary
      // events reach it: an interrupted `create()`'s zero-byte tombstone
      // (`JSON.parse("")`), a record written by a NEWER build carrying a core
      // field or an extension namespace this one has not registered (a rollback
      // after a bad deploy, a second checkout, a separately-deployed reaper),
      // and a transient EIO/EACCES on one file. `assertWellFormed`'s own
      // docstring names that exact outage as the thing to avoid, and the
      // read/write split it built only covers unknown FIELDS inside an
      // already-registered namespace.
      //
      // So the ANOMALY is reported rather than the listing dropped: this is
      // still not a silent skip. `list()` refuses outright on a non-empty
      // `skipped`, so `reapRuns` stays fail-closed on an unproven population —
      // it just fails closed with the file NAMED instead of taking the process
      // down. `get()`/`readRecord()` are untouched: a caller asking for ONE
      // record by id still gets the hard error, because there the caller knows
      // which record it wanted and an error is actionable.
      try {
        records.push(readRecord(join(this.dir, name), id));
      } catch (e) {
        const message = (e as Error).message;
        skipped.push(name);
        skippedReasons.push(message);
        this.emit(null, "list.anomaly", Date.now(), "error", {
          code: (e as NodeJS.ErrnoException).code ?? "unreadable_record",
          message,
        });
      }
    }
    return { records, skipped, skippedReasons };
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
    // The one gate covering `set()` and `close()` — both route through here, and
    // the lock file itself is a write into the unproven directory.
    this.assertWritable();
    const lock = this.lockPath(runId);
    // Monotonic on purpose: this budget bounds WAITING, and a wall-clock step
    // (NTP correction, VM pause/resume) would silently shorten or extend it.
    // The persisted-mtime comparisons (`olderThan`) keep wall time
    // deliberately — mtimes are wall-clock stamps, so the comparison must be.
    const deadline = performance.now() + LOCK_TIMEOUT_MS;
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
      if (performance.now() >= deadline) {
        throw runRecordError("lock-timeout", `timed out waiting for the run record lock: ${lock} (${heldReason})`);
      }
      // A successful steal means the path is free now — retry without sleeping.
      const why = this.stealIfOwnerGone(lock, body);
      if (why !== null) {
        heldReason = why;
        sleepMs(5);
      } else {
        // `null` means the path was FREE at the probe and the claim simply lost
        // the race. Whatever the last iteration blamed no longer describes
        // anything — leaving it set reported a long-gone `lock unreadable: EIO`
        // (or a stale `held by a live owner`) on the eventual timeout and sent
        // an operator hunting a phantom writer, which is the same failure the
        // reason string exists to close.
        heldReason = "contended";
        if (++sleepless > LOCK_IMMEDIATE_RETRIES) sleepMs(5);
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
   * OWN body is stealable under our own pid outright; any other same-pid body
   * is either a live sibling holder or a sibling thread that DIED holding its
   * claim, and the pid cannot tell them apart (see `OWN_LOCK_GRACE_MS` for why
   * no portable identity token can). Inside the grace it is HELD — taking a
   * live sibling's lets two `setLocked` read-modify-writes overlap and drop a
   * field, INV-4's named failure mode; past the grace it is a wedge, and
   * waiting on it forever was the outage this bound closes.
   *
   * Same-thread re-entrancy outranks that grace: `heldLocks` is per-thread
   * module state, so when it names this path the caller is provably waiting on
   * its own enclosing operation, whatever the mtime says.
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
    // Unparseable, empty or non-positive names NO owner, and inside the grace
    // that means WAIT — an O_EXCL-era lock body caught mid-write, or a body a
    // build we cannot model wrote; stealing on an unprovable read is how a live
    // holder's claim gets taken (INV-4's lost update). But an ownerless body is
    // also the exact artifact of a pre-link-format crash: nothing in the file
    // can EVER come back to prove liveness, `stealIfOwnerGone`'s dead-pid proof
    // has nothing to probe, no sweep matches `.lock`, and release only handles
    // bodies this process wrote itself — so it wedged the id for the process
    // lifetime. Age is the bound, as for own-pid bodies: an ownerless body past
    // OWN_LOCK_GRACE_MS is a corpse with no possible mourner and falls through
    // to the same take-then-compare protocol below, bypassing the pid liveness
    // checks by construction (there is no pid to probe; the compare against
    // `raw` still protects any writer that claimed between judgement and take).
    // Returning `null` here — "path free" — was the round-11 residual: the
    // corpse still sits at the path, so every retry's claim EEXISTs and the
    // wait spins to its own timeout, the very wedge the age bound closes.
    if (!Number.isInteger(owner) || owner <= 0) {
      if (!olderThan(lock, OWN_LOCK_GRACE_MS)) return "lock body names no pid";
    } else {
      // Our pid, not our body, and THIS thread already holds the path: the
      // caller is waiting on itself — a re-entrant `set()` from the
      // `beforeRename` seam. Fail-closed is still right (there is no safe way
      // to hand a live holder its own lock), but reporting it as a sibling
      // writer sent an operator looking for a second process that never
      // existed. Checked BEFORE the age bound below so a long-running enclosing
      // write cannot age past the grace and let the re-entrant call steal its
      // own outer claim. A sibling thread sharing our pid is NOT in this set.
      if (owner === process.pid && heldLocks.has(lock)) {
        return "re-entrant record write: this thread already holds this lock";
      }
      const held =
        owner === process.pid
          ? raw !== body && !olderThan(lock, OWN_LOCK_GRACE_MS)
          : isAlive(owner);
      if (held) return "held by a live owner";
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
      // rmQuiet, not a bare rmSync: the corpse is proven and judged, but this
      // still runs under `withLock`, and an EIO/EACCES escaping here aborts the
      // claim attempt AFTER the take succeeded. Nothing this cleanup does may
      // escape (see claimLock); a leftover is pid-stamped, so cleanStaleTemps
      // sweeps it once this process is gone.
      rmQuiet(claimed);
      return null; // provably the corpse that was judged
    }
    // A different — or unreadable — body: the corpse was cleared and a NEW
    // writer claimed the path between the judgement and the take. Put it back —
    // `link`, never `rename`, so a claim made at the path while this one was
    // held aside is not overwritten. `putBack` disposes of `claimed` on every
    // true return (unlink on restore, park-orphan on EEXIST), so nothing here
    // deletes bytes it has not proven disposable.
    if (putBack(claimed, lock)) {
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
    //
    // The evidence is parked under a name `cleanStaleTemps` does not match:
    // these bytes are exactly what that log line tells an operator to restore,
    // and a `.tmp` name would let the next sweep destroy them within one cycle
    // of this pid dying or its grace elapsing. `parkAside` reports wherever the
    // bytes actually are — the move can fail too — so the line names the truth.
    const heldAside = parkAside(claimed);
    this.emit(null, "lock.not-restored", Date.now(), "error", {
      code: "lock_not_restored",
      message: `run record lock left vacated after a steal attempt: ${lock} (body held aside at ${heldAside})`,
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
      try {
        renameSync(lock, claimed);
      } catch (e) {
        // ENOENT alone means another writer stole/released it between our read
        // and the take — genuinely gone, and the put-back contract below no
        // longer applies because there is nothing of ours to restore. EVERY
        // other errno used to be swallowed the same way, which stranded OUR
        // live-pid body at the path: unstealable ("held by a live owner"),
        // unwritable and unclosable for the rest of the process lifetime while
        // the box billed. Retry once (a transient EIO/EACCES settles), then
        // report — loudly, since throwing from this `finally` would replace
        // the caller's committed result with an fs error.
        if ((e as NodeJS.ErrnoException).code === "ENOENT") return;
        sleepMs(5);
        renameSync(lock, claimed);
      }
    } catch (e) {
      const detail = (e as NodeJS.ErrnoException).code ?? (e as Error).message;
      noteOnStderr(
        `run-record: could not release ${lock} (${detail}) — THIS process still holds it; later writes to this run will time out until it is released\n`,
      );
      this.emit(null, "lock.release-failed", Date.now(), "error", {
        code: "lock_release_failed",
        message: `run record lock release failed: ${lock} (${detail})`,
      });
      return;
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
      // rmQuiet, not a bare rmSync: the record write has ALREADY COMMITTED by
      // the time this finally runs, and a throwing rm (EIO/EACCES/EPERM —
      // `force` suppresses only ENOENT) would replace the caller's success with
      // an error, sending a retry back through a read of the pre-commit record
      // — a doubled spend delta on the money path. Nothing this cleanup does
      // may escape (see claimLock); a leftover is pid-stamped, so
      // cleanStaleTemps sweeps it once this process is gone.
      rmQuiet(claimed);
      return;
    }
    // Foreign — or unreadable — body: the lock was replaced between the read
    // above and the rename. Put it back — `link`, never `rename`, which would
    // overwrite a lock claimed at the path while this one was held aside.
    // `putBack` disposes of `claimed` on every true return (see the steal-side
    // call), so nothing here deletes bytes it has not proven disposable.
    if (putBack(claimed, lock)) {
      return;
    }
    // Put-back failed, so the path is EMPTY and a live holder is inside its
    // `fn()`. Throwing is not available here — this runs in a `finally`, where
    // it would replace the caller's real error — but silence is what let the
    // next contender claim a lock somebody else still holds. Log it: only an
    // operator can restore the path from where `parkAside` reports the body —
    // parked under a name `cleanStaleTemps` does not sweep, so the evidence
    // outlives this process instead of being destroyed within one sweep cycle.
    const held = parkAside(claimed);
    this.emit(null, "lock.not-restored", Date.now(), "error", {
      code: "lock_not_restored",
      message: `run record lock left vacated on release: ${lock} (body held aside at ${held})`,
    });
  }

  /**
   * Write-temp-then-rename. There is no in-place partial-write path (INV-3).
   *
   * The `ponytail:` marker that used to sit here — the FILE was fsynced, the
   * directory entry was not — is CLOSED by F033: `atomicReplaceFile` fsyncs the
   * parent directory after the rename, as fanout's copy of this code already
   * did. It costs a second synchronous flush per `set()`/`close()`; the
   * mutation reported committed no longer vanishes on a power loss.
   */
  private atomicReplace(runId: string, rec: RunRecord): void {
    // Wrapped, not passed bare: `beforeRename` was invoked as `this.beforeRename?.(tmp)`
    // and a caller that wrote it as a `function` would lose its receiver otherwise.
    atomicReplaceFile(this.path(runId), serialize(rec), (tmp) => this.beforeRename?.(tmp));
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

  /**
   * Observability contract: one line per record mutation, never the keyHash value.
   *
   * Guarded like cost-ledger's emit, for the same reason: every caller is PAST
   * its outcome by the time it emits — `traced`'s error arm included, where a
   * raising sink would REPLACE the real error — so a throwing custom sink must
   * not turn a durable result into a thrown one. Swallow with a stderr note
   * naming the verb; never echo the payload, which is not redacted on stderr.
   * The stderr write itself is best-effort too: a diagnostic that throws is
   * worse than silence.
   */
  private emit(
    runId: string | null,
    verb: string,
    started: number,
    outcome: "ok" | "error",
    error?: { code: string; message: string },
  ): void {
    const durationMs = Date.now() - started;
    try {
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
    } catch (e) {
      noteOnStderr(
        `run-record: log sink threw for run-record.${verb} (${(e as Error).message}) — the record outcome stands\n`,
      );
    }
  }
}

/**
 * Re-link a lock body held aside at `claimed` back to `lock`. True when the
 * lock path ends up correctly served AND `claimed` has been disposed of here —
 * callers must not unlink it afterwards. False means the put-back did NOT
 * happen and `claimed` is the ONLY remaining link to the body; the callers park
 * it aside (`parkAside`) under a name `cleanStaleTemps` does not sweep — it is
 * evidence an operator has been told to restore by hand, not litter for the
 * next construction to destroy.
 *
 * The return value is the whole point. `link` succeeding puts the body back,
 * and the second link at `claimed` is then redundant, so it is unlinked here —
 * quietly, because the lock is served and a leftover `.tmp` is pure hygiene.
 *
 * EEXIST used to read as "a newer claim supersedes this body" with the CALLER
 * unlinking `claimed` — but EEXIST proves only that the PATH carries a newer
 * link, nothing about whose bytes sit at `claimed`. The take races exactly the
 * corpse-cleared window, so those bytes can be a LIVE holder's generation, and
 * unlinking them left that holder unlocked under a contender's exclusive lock:
 * two read-modify-writes overlapping, INV-4's named failure mode. They are
 * parked under a sibling orphan name instead (`parkAside`) — never deleted,
 * because a body we could not prove disposable is evidence, not litter — and
 * named on stderr, since a silent park would strand an operator's diagnosis.
 *
 * Any OTHER errno (ENOSPC, EMLINK, EDQUOT, EPERM on a mount without hardlink
 * support, EIO) means the put-back did NOT happen, and `claimed` is then the
 * ONLY remaining link to that body: unlinking it destroys a lock a live holder
 * is still inside, letting two `setLocked` read-modify-writes overlap and drop
 * a field. Leave it on disk instead — parked under an unswept sibling name by
 * the caller, which is what keeps manual restoration possible.
 *
 * Same shape as `scripts/lib/run-lock.ts`'s release, for the same reason.
 */
function putBack(claimed: string, lock: string): boolean {
  try {
    linkSync(claimed, lock);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EEXIST") return false;
    // A newer claim supersedes whatever we hold aside — supersede, not delete:
    // whose bytes these may turn out to be is exactly what EEXIST cannot say.
    parkAside(claimed);
    return true;
  }
  rmQuiet(claimed);
  return true;
}

/**
 * Move a held-aside body that must not be deleted — an unrestorable lock
 * generation, a tombstone window's non-tombstone — to a unique sibling orphan
 * name, say so on stderr, and report WHERE THE BYTES ARE: the orphan name on
 * success, `p` itself when the move failed, so every caller names the truth.
 *
 * The orphan carries NO `.tmp` suffix ON PURPOSE. These bytes are evidence an
 * operator has been told to restore by hand (`lock.not-restored`), and a `.tmp`
 * name sits inside `cleanStaleTemps`' reach — swept within one cycle of this
 * pid dying or OWN_TEMP_GRACE_MS elapsing, exactly when nobody has restored
 * them yet. Inert either way: no shape the store reads as record, lock or
 * probe. A failed move leaves the body at its original `.tmp` name — degraded
 * back to sweepable, but the stderr note already said where it was.
 */
function parkAside(p: string): string {
  const orphan = `${p}.orphan.${process.pid}.${randomBytes(4).toString("hex")}`;
  try {
    renameSync(p, orphan);
  } catch {
    return p;
  }
  noteOnStderr(`run-record: parked an unrestorable held-aside lock body at ${orphan}\n`);
  return orphan;
}

/**
 * Best-effort diagnostic write: never throws, never delays the caller. A
 * failing stderr is itself unreportable, so the second layer is silence.
 */
function noteOnStderr(line: string): void {
  try {
    process.stderr.write(line);
  } catch {
    // best-effort diagnostic only
  }
}

/** Block this thread briefly. The lock wait is short and the callers are sync. */
function sleepMs(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Clear a ZERO-BYTE `<runId>.json` so the id is creatable again. True when the
 * path is now free and the caller may retry its exclusive create.
 *
 * A SIGKILL or power loss between `openSync(p, "wx")` and the `writeFileSync`
 * inside `createUnlogged` leaves an empty file. It is not `.tmp` and not
 * `.probe-`, so `cleanStaleTemps` never sweeps it, and its stem is a perfectly
 * valid run id, so nothing else refuses it either — the id became a permanent
 * `EEXIST` tombstone that only an operator could clear by hand.
 *
 * Removing it loses NOTHING, which is what makes this compatible with INV-3's
 * no-overwrite rule: zero bytes carry no `keyHash`, no `vmName`, no
 * `createdAt`. There is no run behind an empty file, so there is no key nobody
 * revokes and no box nobody reaps.
 *
 * SIZE ALONE IS NOT ENOUGH. A concurrent `create()` of the same id is
 * zero-byte too, for the microseconds between its open and its write, and
 * deleting THAT would let two creates both believe they own the id.
 * CREATE_TOMBSTONE_GRACE_MS is the separator: an empty file untouched for
 * seconds is a corpse, an empty file written to this instant is a live writer.
 *
 * And JUDGING THEN REMOVING is not enough either — stat→rm is a TOCTOU. Two
 * creators can pass the aged-zero-byte check on the same tombstone; B then rms
 * it and completes its exclusive create; A's unconditional `rm` lands on B's
 * LIVE record and deletes it — two dispatchers now own one id, each minting
 * keys against a box the other believes is theirs. So the removal takes the
 * tombstone ASIDE first (`rename` to a unique name) and only the taken-aside
 * bytes are verified and unlinked. The `rename` makes the decision
 * single-winner — the loser's rename finds nothing — and a creator racing for
 * the path sees either the tombstone (EEXIST) or a free path, never a record
 * being deleted underneath it.
 *
 * ponytail: an mtime grace, not a lock — `create()` runs before any lock
 * exists, and the window it has to separate is microseconds wide.
 */
function clearCreateTombstone(p: string): boolean {
  let size: number;
  try {
    const st = statSync(p);
    size = st.size;
  } catch {
    return false;
  }
  if (size !== 0 || !olderThan(p, CREATE_TOMBSTONE_GRACE_MS)) return false;
  // `.tmp`-suffixed and pid-stamped like every other held-aside name: a death
  // between this take and the unlink leaves an inert file the next store
  // construction sweeps (the pid parses from the third-from-last segment).
  const claimed = `${p}.tomb.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  try {
    renameSync(p, claimed);
  } catch (e) {
    // ENOENT alone means another sweeper won the race and the path is free —
    // done, exactly as the old force-rm counted a competitor's cleanup. Any
    // other errno proves nothing about what sits at `p`; report failure so the
    // caller surfaces the original EEXIST rather than a stranger's errno.
    return (e as NodeJS.ErrnoException).code === "ENOENT";
  }
  // The bytes taken aside must still be the zero-byte corpse that was judged.
  // Nothing in-tree replaces a tombstone in place (every write at the path
  // needs the path free first), but nothing here deletes on faith either:
  // an unreadable or non-empty take is restored or parked, never removed.
  let taken = -1;
  try {
    taken = statSync(claimed).size;
  } catch {
    // Unprovable ⇒ restore-or-park below, never unlink.
  }
  if (taken !== 0) {
    try {
      linkSync(claimed, p);
      // Restored: the second link is hygiene now, not the body itself.
      rmQuiet(claimed);
    } catch (e) {
      // ANY failed restore here — EEXIST because a create won the freed path,
      // EACCES/EIO on the link — leaves bytes this branch just conceded may be
      // a LIVE record sitting at a `.tomb.…tmp` name: home-grammar-matched and
      // pid-stamped, so the construction sweep destroys them once the pid dies
      // or the grace elapses. That is exactly what the park doctrine forbids:
      // move every unproven take to an unswept `.orphan.` name and say where
      // the bytes are.
      parkAside(claimed);
    }
    return false;
  }
  rmQuiet(claimed);
  return true;
}

/**
 * Has `p` sat untouched for at least `ms`? A stat that fails answers NO — an
 * unstat-able file is one we can prove nothing about, and every caller here
 * uses the answer to decide whether to DELETE.
 */
function olderThan(p: string, ms: number): boolean {
  try {
    return Date.now() - statSync(p).mtimeMs >= ms;
  } catch {
    return false;
  }
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

