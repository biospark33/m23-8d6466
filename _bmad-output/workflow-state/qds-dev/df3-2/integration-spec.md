# DF3.2 Integration Specification

Story: `_bmad-output/sprint-artifacts/dark-factory-v5/stories/df3-2-fanout-best-of-n.md`
Authored: 2026-08-23, Wave-0 architect. Every Evidence bullet was read from source on this
host (`main @ f1aa4db` working tree) by this agent, not lifted from research reports.
Where a research report conflicts with source, SOURCE WINS and the correction is listed in
the Corrections register at the end of this document.

---

## Module Contracts

### src/fleet/fanout.ts — section 1: the fan-out record store (AC9)

```typescript
import { openSync, writeFileSync, fsyncSync, closeSync, renameSync, mkdirSync, chmodSync,
         readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

/** AC9 record schema — frozen. No field may be added without changing the AC. */
export interface FanoutRecord {
  fanoutId: string;            // mintFanoutId(): "fan-YYYYMMDD-<6hex>"
  requestId: string;           // CC-9 join key propagated into every arm
  pattern: "best-of-n" | "many-stories" | "race";
  n: number;
  pin: string | null;          // brief.commitSha for best-of-n/race; null for many-stories
  createdAt: string;
  arms: { arm: number; runId: string; rosterId?: string; briefHash: string }[];
  winner: number | null;       // race only; atomic first-writer transition
  rankedAt: string | null;
  closedAt: string | null;
}

export const FANOUT_ID_RE = /^fan-\d{8}-[a-f0-9]{6}$/;
export const DEFAULT_FANOUTS_DIR = ".sandbox/fanouts";
export function resolveFanoutsDir(dir?: string): string; // dir ?? $QDS_FANOUTS_DIR ?? ".sandbox/fanouts"
export function mintFanoutId(): string;                  // newId("fan") — see D3

/**
 * Mirrors RunRecordStore's discipline (run-record.ts):
 * - constructor mkdirs dir 0700 and verifies (run-record.ts:685-692 pattern);
 *   read-mode {create:false} refuses mutation rather than skipping the proof
 *   (:586-605, :727-741 pattern) — validation happens BEFORE construction (r6 lesson).
 * - create(record): O_EXCL `openSync(p, "wx", 0o600)` + full-body writeFileSync +
 *   fsyncSync(fd) + fsyncDir(dir) (createUnlogged shape, run-record.ts:876-922).
 *   EEXIST propagates — never overwrite.
 * - mutate(fanoutId, fn): read-modify-write under `<fanoutId>.json.lock`
 *   (acquireRunLock(join(dir), `${fanoutId}.json`) — the run-record lock, reused),
 *   persisted via the atomicReplace shape: tmp `${p}.${pid}.${randomBytes(4).hex}.tmp`,
 *   "wx" 0600, write, fsync, guarded close, renameSync (run-record.ts:1470-1505).
 *   `winner` transition is a mutate() whose fn refuses when winner !== null —
 *   the per-record lock makes first-writer atomic (see D3).
 */
export class FanoutRecordStore {
  constructor(opts: { dir?: string; requestId?: string; create?: boolean });
  create(record: FanoutRecord): FanoutRecord;              // O_EXCL
  get(fanoutId: string): FanoutRecord;                     // typed ENOENT → caller maps exit 4
  mutate(fanoutId: string, fn: (rec: FanoutRecord) => FanoutRecord): FanoutRecord;
  list(): FanoutRecord[];                                  // fail-closed: throws naming unreadable .json (INV r5/r6)
}
```

### src/fleet/fanout.ts — section 2: the fleet lock (AC8)

```typescript
export const FLEET_LOCK_PATH = ".sandbox/fleet.lock";
export const FLEET_LOCK_STALE_MS = 3_600_000;

/** Story-mandated body — JSON, mode 0600. Distinct from run-lock's whitespace body. */
export interface FleetLockBody { pid: number; pidStartTime: number; createdAt: string; requestId: string }

/**
 * pidStartTime = owner process's own start time as epoch ms, captured AT CLAIM TIME:
 * - darwin:  `ps -o lstart= -p <pid>` parsed with a MANUAL MONTH MAP (output is
 *   ctime-style `%a %b %e %H:%M:%S %Y`, no TZ; Date.parse on it is
 *   implementation-defined) — R1 §2, probed locally.
 * - linux:   `/proc/<pid>/stat` field 22 via after-last-')' split, index 19 of the
 *   remainder (= field 22), ticks/CLK_TCK + /proc/stat `btime` → epoch ms — proc_pid_stat(5).
 */
export function readOwnPidStartTime(pid?: number): number;

/**
 * Acquire. Composition over scripts/lib/run-lock.ts's EXPORTED primitives
 * (this story additively exports `claim`, `writeLockDirect`, `isAlive`, `hostTag` — see D2):
 * - SIGINT/SIGTERM handler installed BEFORE linkSync (r8 lesson: a signal in the
 *   install window stranded the lock forever); held-registration immediately after
 *   the claim primitive returns.
 * - tmp `${lock}.${hostTag()}.${pid}.${hex}.tmp` wx 0600 → write JSON body →
 *   fsync → linkSync(tmp, lock); EEXIST → classify (below); EPERM/EOPNOTSUPP/ENOSYS
 *   → writeLockDirect fallback (run-lock.ts:550-607, :618).
 * - Classification on EEXIST, in order:
 *   1. own-pid re-entrancy check FIRST (hoisted above every grace/reclaim branch — r8 HIGH),
 *      → FleetError 5 "fleet-busy"-adjacent reentrant refusal;
 *   2. body unreadable / unparseable → refuse exit 5 (never steal what cannot be judged — r5/r6);
 *   3. recorded pid fails range guard → refuse (out-of-range pid is NOT dead — r5/r6);
 *   4. TWO-PART RECLAIM, both required: age = Date.now() − Date.parse(createdAt)
 *      > FLEET_LOCK_STALE_MS   AND   (isAlive(pid) === false OR observed start time
 *      of pid ≠ recorded pidStartTime)  → log + unlink + retry claim ONCE;
 *   5. otherwise → FleetError(5, "fleet-busy", …, remediation names holder + `rm` path).
 *     Age alone NEVER reclaims (AC8 negative control); identity match + alive NEVER
 *     expires regardless of age (a first fan-out inside teardown is not preempted).
 * - Wall clock (Date.now/Date.parse) for CROSS-PROCESS age — monotonic
 *   performance.now() cannot span processes. Monotonic performance.now() for every
 *   SAME-PROCESS budget (fan-out ceiling, tick math, spin waits) — r5/r6 NTP lesson.
 *
 * Release (finally-guaranteed):
 * - read body back; matches ours → rmSync; ENOENT → no-op; ANY other content →
 *   NEVER delete — rename aside to `${lock}.orphan.${pid}.${hex}`
 *   (NO `.tmp` suffix — cleanStaleTemps/reapStaleTemps sweep dead-pid `.tmp` names;
 *   parkAside precedent run-record.ts:1630-1639 uses exactly this unswept shape).
 *   See Correction K1.
 * - destructive-mark discipline (markRunLockDestructive/clearRunLockDestructive
 *   semantics): release REFUSES while marked unless {force:true}.
 */
export class FleetLock {
  constructor(opts: { path?: string; requestId: string });
  acquire(): void;            // throws FleetError(5, "fleet-busy")
  release(opts?: { force?: boolean }): void;
}
```

### src/fleet/fanout.ts — section 3: the primitive, the patterns, the race poller (AC1–AC6)

```typescript
export type FanoutPattern = "best-of-n" | "many-stories" | "race";

export interface FanoutDeps extends Omit<DispatchDeps, "requestId"> {
  requestId: string;                 // CC-9: ONE correlation id across all arms
  fanoutsDir?: string;               // default resolveFanoutsDir()
  lockPath?: string;                 // default .sandbox/fleet.lock
  capMicroUsd?: number;              // per-arm key cap — SEE OPEN-QUESTION-1 (D10)
  concurrency?: number;              // default Math.min(n, headroom.headroom, MAX_FANOUT_CONCURRENCY)
  pollIntervalMs?: number;           // default 5_000   (AC5)
  perCallDeadlineMs?: number;        // default 10_000  (AC5)
  ceilingMs?: number;                // default 3_600_000 (AC5/INV-6)
  clock?: () => number;              // wall clock seam (test)
  monotonic?: () => number;          // performance.now seam (test)
}

export interface ArmOutcome {
  arm: number;
  runId: string | null;              // null only when refusal preceded minting
  outcome: "ready" | "setupFailed" | "armFailed" | "armUnknown" | "lostRace";
  exitCode?: number;                 // the arm dispatch's collected exit classification
  vmName?: string;
}

/**
 * fanout — the ordering IS the contract:
 *   validate (exit 2, zero side effects, BEFORE lock — r6 lesson) →
 *   FleetLock.acquire() →
 *   checkHeadroom(driver, N, limits) EXACTLY ONCE (AC1; allowed:false — any reason
 *     incl "list-unverified" — → FleetError 5, payload {reason,liveVms,ceiling,headroom},
 *     zero records/boxes/keys) →
 *   FanoutRecordStore.create (O_EXCL, before first mint — AC9) →
 *   N × mintRunId() SYNCHRONOUSLY (AC3 — dispatch.ts:319, the same minter; ids held in
 *     a plain array; NO record-reading recovery ever) →
 *   aggregate-exposure log line (N × capMicroUsd — INV-3) →
 *   semaphore(min(N, headroom, 8))-bounded Promise.allSettled over per-arm guards →
 *   classify per-arm outcomes → race pattern: poller + winner transition + loser teardown →
 *   close record (closedAt) → FleetLock.release() in FINALLY.
 *
 * Per-arm guard (preserves DF2.x teardown semantics — never allSettled-bare):
 *   try { dispatch(brief, armDeps, { admitted: true, runId }) }
 *   catch FleetError → map to ArmOutcome; setup-gate code ⇒ "setupFailed"
 *   finally { /* per-arm resource disposition, never a sibling's *\/ }
 */
export async function fanout(
  pattern: FanoutPattern,
  n: number,
  briefs: Brief | Brief[],       // single object for best-of-n/race; array for many-stories
  deps: FanoutDeps,
): Promise<{ fanoutId: string; arms: ArmOutcome[]; winner: number | null; headroom: HeadroomResult }>;

/**
 * Race poller (AC5) — HOST-SIDE COMPOSITION, no driver-port method added (port has
 * no observe; observeRun(driver.ts:860) is a copyFile wrapper — do NOT grab it, G5).
 *
 *   markerPath = runMarkerPath()   // import from src/phase-engine/journal.ts DIRECTLY
 *                                  // (barrel deliberately withholds it — phase-engine/index.ts:19)
 *   loop every deps.pollIntervalMs until winner or deps.ceilingMs (monotonic baseline):
 *     for each undecided arm, sequentially:
 *       probe = withTimeout(driver.exec(vm, ["sh","-c", `test -f ${shellQuote(markerPath)}`]),
 *                           deps.perCallDeadlineMs, "race-probe")        // timeout.ts:52
 *       probe.exitCode === 0 →
 *         read = withTimeout(driver.copyFile(vm, markerPath, hostTmp), deadline, "race-read")
 *         parse JSON: ok === true  → claimWinner(arm) atomic first-writer → WIN
 *                     ok === false → mark armFailed, race CONTINUES (G6: marker fires
 *                                    on EVERY settled run — absence ≠ pending failure)
 *         unreadable/malformed → treat as no-marker-this-tick, log non-fatal
 *       TimeoutError from either call → SKIP this arm's tick, LOGGED NON-FATAL (AC5);
 *         loop retries next tick; ExeDevDriver execs can outlive destroy
 *         (driver.ts:153-168) so the deadline is REQUIRED, not optional.
 *     ceiling exceeded with arm undecided → outcome "armUnknown":
 *         never assumed loser, never auto-destroyed, record left open for that arm.
 *
 * Winner disposal: every other arm that ENTERED the race (gate returned ready) goes
 * through DF2.5 teardownSandbox UNMODIFIED — its fixed step array is
 * ["stopVisualizer","spend","artifacts","harvest","revoke","verify","destroy","close"]
 * (teardown.ts:99-111 — harvest BEFORE destroy; verify between revoke and destroy;
 * stopVisualizer prepended). The story's shorthand "spend→artifacts→commits→revoke→
 * destroy→close" maps with deltas (a)+(b) — cite G4, expect 8 steps in logs.
 */
```

### src/fleet/rank.ts (AC7)

```typescript
export interface ArmStepOutput {
  testsExecuted?: boolean;
  testResults?: { passed: number; failed: number };
  changedFiles?: string[];
}

export interface RankedArm { arm: number; runId: string; score: number | null;
  breakdown: { testPassRate: number; uniqueFileCoverage: number } }

export interface RankResult { fanoutId: string; scores: RankedArm[]; tie: boolean; rationale: string }

export interface RankDeps {
  fanoutsDir?: string;
  store: RunRecordStore;                       // spendMicroUsd / commitSha join half
  /** Step-output source. REQUIRED injection — see OPEN-QUESTION-2. Return null ⇒ score null. */
  stepOutputFor: (runId: string) => ArmStepOutput | null;
  monotonic?: () => number;
}

/**
 * score = testPassRate*0.6 + uniqueFileCoverage*0.4   (weights sum to 1.0 — a deliberate
 * round choice, NOT renormalization of P1.4's 0.5/0.3, which would give 0.625/0.375).
 *
 * testPassRate  = (testsExecuted === true && testResults && passed+failed > 0)
 *                 ? passed/(passed+failed) : 0
 *   — `testsExecuted` is a boolean GUARD, never a divisor; absent testResults and
 *     passed+failed===0 both yield 0. No `testsPassed` field exists anywhere (DF1.6).
 *
 * uniqueFileCoverage = union.size === 0 ? 0 : new Set(changedFiles).size / union.size
 *   — union over ALL ARMS' changedFiles (P1.4 cross-arm union); Set-dedup both sides.
 *
 * breakdown carries EXACTLY the two keys above. `summaryQuality` anywhere FAILS review.
 *
 * tie = top-two delta, normalized Number(delta.toFixed(10)), <= 0.1  (boundary INCLUSIVE
 * — DOD asserts delta 0.05→true, 0.2→false, 0.1→true; P1.4 :94/:97 verbatim). The
 * normalization is load-bearing: IEEE-754 makes 0.7−0.6 = 0.09999999999999987, so an
 * unnormalized `<= 0.1` flips the DOD's boundary case on fixture choice. See Correction K6.
 * No automatic tie-break — human review is the resolution path.
 *
 * Arms: an arm with no step output is LISTED with score:null, never dropped.
 * All arms failed ⇒ scores: [] + rationale saying so. Reads/writes ONLY the fan-out
 * record (mutate → rankedAt). Emits {scores[{arm,runId,score,breakdown}],tie,rationale}.
 * Ranking authorizes NOTHING (advisory; the diff is the artifact — fan_out_n.md:136-140).
 */
export async function rank(fanoutId: string, deps: RankDeps): Promise<RankResult>;
```

### src/fleet/verbs.ts — ADDITIVE entries only (DOD: verb registration)

```typescript
// Append to listVerbs()'s array literal; update the :39 docstring
// "Exactly 4 entries" → "Exactly 6 entries: dispatch, status, harvest, teardown, fanout, rank".
// Edit NO DF3.1-owned entry.
{
  verb: "fanout",
  summary: "Run N isolated dispatch arms as one pattern (best-of-n, many-stories, race)",
  flags: [
    { name: "--driver", required: true, valueType: "string" },
    { name: "--pattern", required: true, valueType: "string" },
    { name: "--n", required: true, valueType: "string" },        // CLI range-checks int, like --port
    { name: "--pin", required: false, valueType: "string" },     // must equal brief.commitSha(s)
    { name: "--roster", required: false, valueType: "string" },  // comma-separated rosterIds
    { name: "--cap-micro-usd", required: false, valueType: "string" }, // positive-int µ$ (D10)
    { name: "--brief", required: false, valueType: "path" },
    { name: "--dir", required: false, valueType: "path" },
    { name: "--help", required: false, valueType: "boolean" },
  ],
  exitCodes: [0, 1, 2, 5, 6],
},
{
  verb: "rank",
  summary: "Score a completed best-of-N fan-out (advisory; emits scores, tie, rationale)",
  flags: [
    { name: "--dir", required: false, valueType: "path" },
    { name: "--help", required: false, valueType: "boolean" },
  ],
  // NO --driver: rank touches records and step output only; requiring a flag nothing
  // consumes trains operators to paste magic values. assertDriverChosen is skipped
  // for rank (no driver to default — the B8 hazard cannot arise).
  exitCodes: [0, 1, 2, 4],
},
```

Positional grammar (CLI-side, not registry flags — C6 discipline): `rank <fanout-id>`;
`fanout` takes no positionals. `--n` parses `/^[1-9]\d{0,1}$/` then bounds-checked
(`2..8` best-of-n/race, `1..8` many-stories — INV-6) at validation, exit 2.

### src/fleet/index.ts

```typescript
export * from "./brief-schema.ts";
export * from "./dispatch.ts";
export * from "./status.ts";
export * from "./verbs.ts";
export * from "./fanout.ts";   // DF3.2
export * from "./rank.ts";     // DF3.2
```

### scripts/fleet.ts — front-door wiring (registry-driven)

```typescript
// VALUE_FLAGS/BOOL_FLAGS derive from listVerbs() (:123-137) — new flags tokenize
// with NO second edit. Add two `if (verb === …)` blocks alongside dispatch/status:
//
// fanout: arity/flag checks → assertDriverChosen → readBrief seam (64 KiB cap, stdin/
//   --brief discrimination reused verbatim) → parse (single object, or {briefs:[…]}
//   array wrapper for many-stories — see D9) → build FanoutDeps (resolveDriver({
//   requestId }), RunRecordStore, ledgerFactory, capMicroUsd) → try fanout(...) →
//   print ONE JSON LINE PER ARM (status-row idiom, emit()) then, for best-of-n, the
//   rank summary line {scores,tie,rationale} → finish(requestId,"fanout",fanoutId,code).
// rank: positional fanout-id grammar check (FANOUT_ID_RE, else exit 2) → build
//   RankDeps → try rank(...) → emit(JSON.stringify(result)) → finish.
// Both blocks compose FleetError → report() mapping unchanged; RunLockedError → exit 5
// mapping (:1332) covers any lock refusal surfacing through these paths.
```

---

## Locked Decisions (D1–D14)

### D1. Module layout and FTM boundaries
**Verdict**: All production code lands in `src/fleet/fanout.ts` (three sections: fan-out record
store, fleet lock, primitive + patterns + poller) and `src/fleet/rank.ts`; `index.ts` gains two
export lines; `verbs.ts` gains two entries and a docstring/count fix; `scripts/fleet.ts` gains two
verb blocks. Zero edits to `src/fleet/dispatch.ts` and zero edits to any DF3.1-owned registry
entry. ONE sanctioned exception: additive `export` keywords on four already-existing
module-private functions in `scripts/lib/run-lock.ts` (see D2) — justified there, GitNexus impact
mandatory first.

**Evidence**:
- Story Files to Modify (df3-2 story :248-258) — exactly these paths; binding.
- `src/fleet/index.ts:1-8` — current barrel is C5's four-line shape; appending two lines is purely additive.
- `src/fleet/verbs.ts:39` — docstring claims "Exactly 4 entries"; it is a contract claim tests pin, must be updated with the entries.
- CLAUDE.md style rule ≤~500 lines/module: fanout.ts will run near the ceiling (~450-520 lines across three sections). Named risk in the Wave Plan: if it exceeds ~600, the orchestrator approves splitting section 2 into `src/fleet/fleet-lock.ts` THEN, not preemptively.

### D2. Fleet lock (AC8) — reuse run-lock primitives, extend with identity
**Verdict**: `.sandbox/fleet.lock`, JSON body `{pid, pidStartTime, createdAt, requestId}`, mode
0600, tmp→fsync→linkSync(2) publish; claim classified by the two-part reclaim (age >
3_600_000 ms AND (signal-0 dead OR recorded-start-time mismatch)); own-pid re-entrancy checked
FIRST; release never deletes a foreign body — parks `${lock}.orphan.<pid>.<hex>` (no `.tmp`);
signal handlers installed before linkSync; held across admission + all mints + record creation,
released in `finally`. Mechanism = composition over `scripts/lib/run-lock.ts`'s hardened
primitives, made reachable by four additive `export` keywords.

**Verdict rationale for the export exception**: minting a second lock implementation replays the
exact bug families DF3.1 spent review rounds 3/5/6/8/9 fixing (release destroying a live holder's
body, SIGINT stranding, same-pid wedges, staleness misclassification, non-retryable cleanup
exits). R3 §5 states it directly: "DF3.2's fleet.lock should live beside the hardened run-record
lock primitives and REUSE them … rather than mint a second lock implementation."

**Evidence**:
- `scripts/lib/run-lock.ts:550-607` `claim()` — hostTag-stamped tmp, `"wx"` 0600, write+fsync,
  `linkSync`, EEXIST→`claimedByUs` nonce compare, EPERM/ENOSYS/EOPNOTSUPP→fallback (currently
  module-private; the export edit exposes exactly this).
- `scripts/lib/run-lock.ts:618+` `writeLockDirect()` — O_EXCL create-then-write fallback for
  filesystems without working link(2) (currently module-private).
- `scripts/lib/run-lock.ts:138-147` `isAlive()` — THE fail-closed probe: range-guard first
  (`ERR_OUT_OF_RANGE` on huge pids is not an errno; pid 0 signals the process group), only ESRCH
  proves death. Reused verbatim — fanout never hand-rolls kill(…,0).
- `scripts/lib/run-lock.ts:53` `RunLockedError`; `scripts/fleet.ts:1332` —
  `if (e instanceof RunLockedError) throw new FleetError(5, e.code, e.message, e.remediation)` —
  exit-5 mapping already exists at the front door and covers lock refusals surfacing through
  fanout/rank blocks.
- `scripts/lib/run-lock.ts:807-880` `releaseRunLock()` — body-compare-before-delete, `.rescue`
  parking shape, destructive-mark refusal: the discipline the fleet lock's release mirrors.
- `src/providers/run-record.ts:1630-1639` `parkAside()` — orphan name
  `` `${p}.orphan.${process.pid}.${randomBytes(4).toString("hex")}` `` — NO `.tmp` suffix, chosen
  precisely because `cleanStaleTemps` (:806-845) sweeps every dead-pid `.tmp`/`.probe-` name in
  its directory. **Correction K1 applies**: the parked name must NOT end in `.tmp`.
- `src/providers/run-record.ts:806-845` `cleanStaleTemps` — verified sweep predicate: names
  ending `.tmp` or starting `.probe-`, owner pid parsed from the name, swept iff dead (own pid
  after OWN_TEMP_GRACE_MS = 60 s). Runs over the STORE dir at construction (:694); `.sandbox/`
  root is not swept today — the unswept-name discipline is defense against sweeps extending.
- darwin start time: `ps -o lstart=` ctime-format, no TZ, locale-sensitive — manual month map,
  not `Date.parse` (R1 §2, locally probed). Linux: `/proc/<pid>/stat` field 22 =
  after-last-`)` remainder index 19, ticks ÷ CLK_TCK + `btime` (proc_pid_stat(5)).
- Zombie caveat (R1 §3): an exited-unreaped child answers signal 0 — start-time identity is why
  the reclaim needs BOTH halves; signal-0 alone cannot clear a recycled pid.
- Hold window: story AC8 text ("held across admission and all N mints as one critical section")
  + Infra table ("lock taken before admission and released in a `finally`"). R5 G7 (WATCH) notes
  the residual: checkHeadroom reserves nothing (quota.ts read-only), so a concurrent SINGLE
  dispatch after our release can still overshoot by racing the provider list — that race is
  documented provider-layer behavior (dispatch.ts:1727-1740 comment), accepted here; the lock
  makes fan-out-vs-fan-out safe, which is the AC's scope.

### D3. Fan-out record (AC9) — store, id minting, arm extension
**Verdict**: `.sandbox/fanouts/<fanout-id>.json`, dir 0700 / file 0600, `FanoutRecordStore`
mirroring `RunRecordStore`'s O_EXCL-create + lock-guarded atomicReplace patch discipline.
`fanoutId` = `mintFanoutId()` = `newId("fan")` → `fan-YYYYMMDD-<6hex>` — a NEW prefix, not
`mintRunId()` reuse. Arm linkage via `store.set(runId, { extensions: { fanout: { fanoutId, arm } } })`
— caller supplies ONLY the two registered fields; the store stamps `schemaVersion`.

**Verdict — why a new prefix, not mintRunId() reuse**: (a) `MintedRunId` is branded for
dispatch's `opts.runId` seam and validated against `MINTED_RUN_ID_RE` (/^qds-\d{8}-[a-f0-9]{6}$/);
a fan-out id is never handed to dispatch, so the brand buys nothing. (b) A `qds-` token that is
NOT a run id would make every log grep / operator eyeball ambiguous between the two id spaces.
(c) `newId(slug)` accepts any slug (run-record.ts:305-312; `scripts/run-record.ts new-id <slug>`
mints any slug unbranded), so `newId("fan")` costs one argument. `FANOUT_ID_RE` mirrors the
grammar for validating the `rank` argument.

**Evidence**:
- `src/providers/run-record.ts:141-179` `EXTENSION_NAMESPACES` — `/** DF3.2 */ fanout:
  { schemaVersion: 1, fields: { fanoutId: "string", arm: "string" } }` ALREADY REGISTERED.
  Do NOT re-register; do not touch run-record.ts at all.
- `src/providers/run-record.ts:115-134` — `ExtensionPatch = Record<string, Record<string,
  string|number>>`; docstring "`schemaVersion` is the store's to stamp" (:122-123). **Correction
  K2 applies**: the caller patch is `{fanoutId, arm}` only; the DOD's "written without
  schemaVersion is rejected" clause is about the STORED namespace, which the store guarantees.
- Extensions stay writable after close (run-record.ts:949-953) — writing the arm extension after
  the arm's outcome classifies is safe even for early-closed records.
- O_EXCL create + fsync + fsyncDir: run-record.ts:876-922 (`createUnlogged`). atomicReplace
  tmp/fsync/rename: :1470-1505. Dir 0700/file 0600 proof: :685-692, :764-767, :758-789.
- Stamp-skip-on-EEXIST (df3-1 constraint 2): the extension write happens AFTER the arm's
  dispatch outcome classifies; a refused/duplicate arm skips it (check
  `store.get(runId).extensions.fanout` first — idempotent re-runs don't double-stamp).
- Refused fan-outs (validation exit 2, fleet-busy exit 5, no-headroom exit 5) write NO record:
  record creation is ordered strictly AFTER the admission check passes and BEFORE the first
  mint (story AC9 + Infra table row "record O_EXCL-created before the first mint").
- Winner transition atomicity: `mutate()` runs under `<fanoutId>.json.lock` taken with
  `acquireRunLock(join(dir), `${fanoutId}.json`)` — the exported run-record lock, inheriting
  steal/refuse/signal handling. First-writer = the mutate fn that finds `winner === null`.
- Per-record locks use acquireRunLock's NATIVE body format (`<pid> <host> <ISO> <nonce>`); the
  story's mandated JSON body applies to `.sandbox/fleet.lock` only.

### D4. Admission (AC1) — one checkHeadroom(N), inside the lock, fail-closed
**Verdict**: Exactly ONE `checkHeadroom(deps.driver, n, deps.quotaLimits)` call, inside the fleet
lock, before record creation and before the first mint. `allowed: false` — any reason INCLUDING
`list-unverified` — → `FleetError(5, "no-headroom", message naming headroom + request,
remediation, payload {reason, liveVms, ceiling, headroom})`, zero records, zero boxes, zero keys,
zero mints. Every arm dispatched as `dispatch(brief, armDeps, { admitted: true, runId })`, which
suppresses ONLY dispatch's internal `checkHeadroom(1)`; the per-issue budget gate still runs per
arm and still places N reservations.

**Evidence**:
- `src/fleet/dispatch.ts:1529-1570` — verified verbatim: "AC8: skipped only under
  `{ admitted: true }` (DF3.2's single checkHeadroom(N))." `if (opts.admitted !== true)` wraps
  ONLY the headroom call.
- `src/fleet/dispatch.ts:1571-1584` — "AC7: budget admission always runs (a single dispatch is
  not exempt)" — `assertWithinBudget` executes unconditionally after the headroom block.
- N arms ⇒ N reservations structurally confirmed: reservations GROUP BY run_id, PK
  (request_id, run_id) (cost-ledger.ts:1301-1307, :1289-1290) — N distinct mintRunId() values
  insert N rows even under one shared requestId; aggregate exposure stays bounded by the
  per-issue cap (BEGIN IMMEDIATE serialization per df2-8).
- `src/providers/quota.ts:192-250` — `requested` must be a positive integer else throws;
  boundary inclusive (`liveVms + requested > maxVms` refuses); list throw OR non-array ⇒
  `{allowed:false, reason:"list-unverified", headroom:0, verified:false}` fail-closed.
- `list-unverified` transient classification: dispatch.ts:1552-1562 passes
  `listUnverified ? "transient" : undefined` as the ExitStatus override — fanout copies this
  override for its own no-headroom refusal (retryable only when the substrate failed to answer).
- Negative control (AC1) test shape: an implementation that loops `checkHeadroom(1)` per arm or
  dispatches until a provider error appears MUST fail — asserted by spying the driver.list call
  count through the instrument Proxy seam (providers/index.ts:62 wraps every resolved driver).

### D5. Mint-before-parallel (AC3)
**Verdict**: After admission passes and the record is created, N synchronous `mintRunId()` calls
(composed into an array) complete BEFORE the promise section opens. Each pre-minted branded id is
passed explicitly: `dispatch(brief, armDeps, { admitted: true, runId: ids[i] })`. Recovering an id
by reading the newest run record is FORBIDDEN (the disler `mount` bug — fan_out_n.md:26-32,
mount.just:15).

**Evidence**:
- `src/fleet/dispatch.ts:319-321` — `export function mintRunId(): MintedRunId { return
  newId("qds") as MintedRunId; }` — DF3.1 remains the sole minter; DF3.2 sequences when.
- `src/fleet/dispatch.ts:74,117` — `MINTED_RUN_ID_RE` + `MintedRunId` brand; opts.runId accepted
  only if it satisfies the brand grammar AND `assertValidRunId` (dispatch.ts:1443-1470).
- `src/fleet/dispatch.ts:1505-1512, :1844-1896` — re-dispatch under a taken id refuses exit-2
  `run-id-in-use`; the concurrent-EEXIST arm classification is dispatch-owned. Fanout's job is
  only to never need it: synchronous mints cannot collide mid-flight (newId embeds 6 hex random;
  collision loop is dispatch-internal, MINT_RETRIES=4).
- Signature correction baked into all sketches (**Correction K5** / R5 G2): dispatch takes THREE
  args `(brief: unknown, deps: DispatchDeps, opts)` — the story's shorthand
  `dispatch(brief, {admitted:true, runId})` collapses deps and opts; every arm composes its own
  `DispatchDeps` (fresh per-arm object; shared driver/keyApi/store/ledgerFactory instances are
  fine — each dispatch() call opens and closes its own ledger via the factory).

### D6. Isolation (AC2) — structural
**Verdict**: Isolation is structural: each arm is its own `dispatch()` call → its own box, its
own `sbx-<runId>` key, its own run record, its own `refs/sandbox/<run-id>` harvest namespace. No
code enforces separation because no shared object exists to share. The negative control is the
test: N agents driven through ONE box MUST fail the suite.

**Evidence**:
- Key name `sbx-<runId>` (credentials.ts:48 SBX_KEY_PREFIX, :238) — per-run by construction; the
  one-live-key-per-run guard refuses a second mint (`already-minted`, credentials.ts:222-229).
- Harvest ref namespace `refs/sandbox/<run-id>` (harvest.ts:15, :544, :550-551) — collision-free
  across arms.
- Records: O_EXCL per runId (run-record.ts:889) — two arms cannot share a record file.
- Test design: run `fanout("best-of-n", 2, brief, deps)` with a driver stub whose `create` counts
  distinct box names and whose `exec` asserts no two arms share a cwd — assert
  `new Set(outcomes.map(o => o.vmName)).size === n`, `new Set(records.map(r => r.keyHash)).size
  === n` (DOD e2e checkbox: three distinct keyHash), and that the box count equals n (an
  implementation running N agents in one box produces ONE box and MUST trip the assertion).

### D7. Arm failure (AC4) — setupFailed stops one arm, siblings complete
**Verdict**: An arm whose setup gate does not return ready is reported `setupFailed` (never
`armFailed`, never torn down, box LEFT ALIVE with evidence — DF2.2 INV-5), its exit
classification collected, and every sibling runs to completion. `fanout` exits non-zero with
per-arm outcomes when any arm did not reach `ready`-class success. Precedence is reciprocal with
AC5: setupFailed governs arms that never entered the race; race losses/armFailed/all-fail go
through DF2.5 teardown.

**Evidence**:
- `teardown.ts:408-420` — a harvest throw aborts BEFORE revoke/destroy: record open, box alive.
  Fanout never issues a second lifecycle call for such an arm — it simply doesn't tear it down.
- dispatch's own posture (R5 §3 "Dispatch-side INV-5"): post-provision failure leaves record OPEN
  + box ALIVE; `refuse()` "nothing here destroys anything".
- Collection mechanism: per-arm guard wrapping each dispatch in the allSettled fan (timeout.ts
  discipline — `void p.catch(() => {})` on losers is already inside withTimeout), winners/losers
  split off `settled.filter(s => s.status …)` (tests/fleet/dispatch.test.ts:1346-1352 idiom).
- Test design: inject `deps.setupGate` returning `{ready:false, assertionCode:…}` for arm 1 only;
  assert arms 2..n all `ready`, arm 1 `setupFailed` with box still present (FakeDriver root dir
  still exists), record open, fanout exit non-zero, and teardownSandbox NOT called for arm 1
  (spy via DI).

### D8. Race poller (AC5)
**Verdict**: Host-side composition — `driver.exec` existence probe + `driver.copyFile` read of
`runMarkerPath()`, predicate = readable `final.json` with `ok === true`; 5_000 ms tick; 10_000 ms
per-call deadline via `withTimeout`; overrun skips the tick logged non-fatal; 3_600_000 ms
ceiling → `armUnknown` (never assumed loser, never auto-destroyed); `ok:false` → `armFailed`,
race continues; winner = atomic first-writer on the record's `winner`; losers torn down through
unmodified `teardownSandbox`; all-armFailed → exit non-zero, `winner: null`, closed record, every
arm torn down (harvest preserves the failed work). No driver-port method added.

**Evidence**:
- `src/phase-engine/journal.ts:38-50` — `runMarkerRoot()` = `process.env.QDS_RUN_ROOT ?? "/run"`
  read at call time; `runMarkerPath()` = join(root, "journal", "final.json"), docstring names
  DF3.2's poller. Import DIRECTLY from `src/phase-engine/journal.ts` — the phase-engine barrel
  deliberately withholds these exports (phase-engine/index.ts:19). **Correction K7**: there is
  no `RUN_MARKER_ROOT` constant; R5 GAP-6 confirmed by direct read.
- `src/phase-engine/journal.ts:171-194` — `writeTerminalMarker` writes exactly
  `{runId, ok, completedAt}` on EVERY settled run, accepted or not (absence ⇔ never finished).
  Poller branches on the `ok` VALUE, not mere presence (R5 G6).
- `src/providers/timeout.ts:46-57` — `withTimeout(p, ms, what)` attaches `void p.catch(() => {})`
  to the loser BEFORE racing (kills late unhandled rejection) — the exact 10_000 ms mechanism.
  `within()` is a closure inside dispatch, NOT exported — do not try to reuse it.
- ExeDevDriver termination contract: "a caller awaiting an exec that can remain pending after
  destroy must bound that wait itself" (driver.ts:153-168) — the per-call deadline is REQUIRED.
- `observeRun(driver, vm, remotePath, localPath)` exists at driver.ts:860-867 as a bare copyFile
  wrapper — do NOT grab it blindly (R5 G5): the story owns the probe+read composition and the AC
  forbids adding port methods.
- Teardown step array VERIFIED: `["stopVisualizer","spend","artifacts","harvest","revoke",
  "verify","destroy","close"]` (teardown.ts:99-111); `teardownSandbox(deps, runId, opts)` at
  :284-291 wrapping everything as `TeardownError{code, remediation}`. **Correction K4/G4**: the
  story's six-step shorthand maps with stopVisualizer prepended and verify inserted.
- Test design: FakeDriver boxes are host directories (fake-driver.ts:119 mkdirs lazily) — plant
  markers at `join(fakeRoot, vmName, "journal", "final.json")`, or set
  `process.env.QDS_RUN_ROOT = boxDir` (exec passes `env: process.env` LIVE VIEW, fake-driver
  ts:296+, so runtime changes propagate). Deterministic ordering: the test writes arm 2's marker
  first. Deadline tests: Proxy-wrap the driver so `exec` returns a never-settling promise —
  assert the tick is skipped, logged, and the loop continues. Inject
  `pollIntervalMs/perCallDeadlineMs/ceilingMs` so no test sleeps real seconds. Absolute `/run` is
  unwritable on darwin dev hosts — never rely on the default root in tests.

### D9. Patterns, validation, concurrency cap
**Verdict**: One primitive, three thin compositions:
- **best-of-n**: ONE brief object; every arm gets the identical brief and identical pin
  (`brief.commitSha`); `--roster a,b,c` REQUIRED, comma-split/trimmed, count MUST equal n (else
  exit 2 `roster-count-mismatch`); rosterId recorded per arm in the fan-out record. Ranked at end.
- **race**: best-of-n's inputs and validation; first arm past the predicate wins; losers torn
  down (D8).
- **many-stories**: stdin carries `{ "briefs": [ …n Brief objects… ] }` (array length MUST equal
  n, else exit 2 `brief-count-mismatch`); per-arm pins legal (`pin: null` in the record); NO
  ranking step, no special-casing — same primitive, `n=1` legal. `--roster` forbidden (exit 2);
  `--pin` forbidden (exit 2) — per-arm pins ride each brief's commitSha.
- Validation (ALL before the lock is taken, exit 2, zero side effects — r6 lesson): pattern ∈
  {best-of-n, many-stories, race}; n integer in 2..8 for best-of-n/race, 1..8 for many-stories
  (INV-6); best-of-n/race reject n=1 ("a comparison needs two arms"); brief schema parse per arm;
  `--pin` when present MUST equal the brief commitSha(s) — all equal — else exit 2 `pin-mismatch`;
  differing pins across arms are STRUCTURALLY impossible for best-of-n/race because there is
  exactly one brief object (the pin control needs no new brief field — story Technical Notes).
- Concurrency: `Math.min(n, headroom.headroom, 8)` width via a ~15-line counting-semaphore
  (acquire/release promises) around the per-arm guards; chunking rejected (a chunk boundary would
  serialize surviving arms behind a failed one). **Correction K8**: under current bounds the
  formula degenerates to n (admission required headroom ≥ n, and n ≤ 8) — implement literally
  anyway (one line; stays honest if bounds change).
- Scope note on roster variance: within this story's FTM, `rosterId` is recorded PROVENANCE per
  arm, not a dispatch input — dispatch derives the roster from `roster.yaml` beside the
  manifestPath (dispatch.ts:1341-1436) and the brief schema has no rosterPath field (DF3.1 D2/C3
  locked). Materially varying rosters requires distinct manifests, which is many-stories'
  mechanism. This satisfies the story's observable E2E contract (three distinct records, ranking
  table) without touching dispatch.

**Evidence**:
- Pattern axes: story Technical Notes :217-222; pin-as-control fan_out_n.md:39/:45/:132
  (verbatim-verified by R4 §3).
- N bounds + degenerate case: story AC6 + Guards/limits :229-233.
- Brief fields closed set: `src/fleet/brief-schema.ts:280-418` — repoSlug, issueId, issueUrl?,
  commitSha (/^[0-9a-f]{40}$/), requestId?, manifestPath, repoUrl. NO pin field; pin ≡ commitSha
  (R2 §4 clarifications).
- Roster validation precedent: dispatch.ts:1341-1436 (parseRoster, ROSTER_MAX_BYTES 256 KiB).

### D10. Per-arm spend cap (INV-3/DD-9) — OPEN-QUESTION-1
**Verdict (locked parts)**: Flag `--cap-micro-usd` (valueType "string", CLI range-checked as a
positive safe integer, mirroring the `--port` numeric-flag idiom fleet.ts:954-967). Default when
omitted: the single-run default `defaultKeyCapMicroUsd = 50_000_000` µ$ ($50) — behavior
identical to today. Aggregate exposure `n × capMicroUsd` is STATED IN THE LOG LINE before the
first dispatch (INV-3). Each arm's key is minted at the per-arm cap; a shared key is forbidden.

**Verdict (mechanism — RECOMMENDATION PENDING ORCHESTRATOR)**: threading a custom cap into
dispatch requires EITHER (A) one additive `DispatchDeps` field `capMicroUsd?: number` passed as
`assertWithinBudget`'s third argument at the single call site (budget-gate.ts:79 clamps
`admittedCeilingMicroUsd = min(keyCap, remaining)`, which flows to mintRunKey's capMicroUsd at
dispatch.ts:1984 through the existing path — ONE interface field + ONE argument, enforcement
lands provider-side where the ceiling already becomes the key's hard USD limit), OR (B) defer
custom caps. Option (B) leaves the flag unusable; Option (A) amends the "zero edits to
dispatch.ts" constraint for exactly this additive surface. GitNexus `context({name:"dispatch"})`
confirms ONE production caller (scripts/fleet.ts) — blast radius contained. **Recommendation:
(A)**, gated on orchestrator approval. Until approved, agents implement everything else and leave
the cap pass-through behind a single TODO-free seam: `deps.capMicroUsd` is threaded into the
aggregate log line and validation NOW, and into dispatch only if OPEN-QUESTION-1 resolves yes.

Rejected alternatives, for the record: clamping `ledger.config`'s issue cap via ledgerFactory —
wrong semantics (bounds the ISSUE pool, starves later arms; keyCap arg still defaults to 50M);
wrapping `keyApi.createKey` to clamp limitUsd — the record's `limitMicroUsd` would advertise a
different limit than the key enforces (dishonest observability, INV-3 violated in spirit).

**Evidence**:
- `src/providers/credentials.ts:45` — `defaultKeyCapMicroUsd = 50_000_000`; :229-237 —
  `capMicroUsd ?? default`, validated positive integer (`cap-invalid` refusal).
- `src/providers/budget-gate.ts:79-96` — third parameter `keyCapMicroUsd =
  defaultKeyCapMicroUsd`; docstring: admittedCeilingMicroUsd = min(keyCap, remaining); enforcement
  locus comment: the ceiling becomes the minted key's PROVIDER-SIDE hard USD limit.
- `src/fleet/dispatch.ts:1662, :1984` — `effectiveCeilingMicros = decision.admittedCeilingMicroUsd`
  → `mintRunKey({…, capMicroUsd: effectiveCeilingMicros})`.
- `src/fleet/dispatch.ts:261-302` — FULL `DispatchDeps` verified: NO cap seam exists today.
- DD-9 (derivation decisions :86): cost unit = integer micro-dollars; per-arm caps are sub-cent
  representable.

### D11. Rank (AC7)
**Verdict**: Formula, guards, union denominator, breakdown keys, tie rule, null-score listing,
empty-scores rationale, and record ownership exactly as specified in the rank.ts contract above.
Tie comparator: normalized-delta ≤ 0.1, boundary INCLUSIVE. `rank` reads and writes ONLY the
fan-out record (plus the injected step-output source); it authorizes nothing.

**Evidence**:
- Weights: story AC7 :121-141 + DOD; P1.4 :92 formula with 0.5/0.3/0.2 — renormalization over
  0.8 gives 0.625/0.375, the story's 0.6/0.4 is a deliberate round choice (arithmetic verified
  exact, R4 §4).
- Tie rule: P1.4 :94/:97 "within 0.1 … tie: true … No automatic tie-breaking" — boundary
  inclusive per R4 §4 ("boundary-inclusive `within 0.1 ⇒ tie:true` all match P1.4 verbatim") and
  per the DOD's explicit `0.1 asserts tie: true`. **Correction K6**: FP normalization required
  (0.7−0.6 = 0.09999999999999987 in IEEE-754 would flip the boundary case unnormalized).
- Field names: DF1.6 producer contract — `testResults {passed, failed}`, `testsExecuted`
  boolean-required-and-false when sum is 0 (`src/phase-engine/phases/test-results.ts:140-146`,
  `ZERO_TEST_RESULTS` :454); no `testsPassed` exists anywhere.
- Join halves: record side `spendMicroUsd`/`commitSha` are CORE_FIELDS (run-record.ts:58-72);
  step-output side is NOT in the record — it flows through engine envelopes
  (`envelopes/types.ts:49` changedFiles; envelope-parse.ts:42 zod shape). **OPEN-QUESTION-2**
  covers the production accessor; tests inject fixtures (the DOD's three-arm fixture requires
  nothing more).
- Advisory-only: fan_out_n.md:136-140 (disler refuses numeric ranking; the code is the artifact)
  — DF3.2 departs deliberately because machine-picking needs a scalar (R6 counter-philosophy
  flag); the departure is the story's, cited here so reviewers don't re-litigate it.

### D12. CLI surface
**Verdict**: Flags per the registry sketch (D1). Brief ingestion reuses the dispatch front door's
machinery verbatim: `--brief <path>` else stdin, 64 KiB cap enforced AS READ, `assertOneBriefSource`,
TTY-stdin refusal. Output: stdout carries OUTPUT ONLY — one JSON line per arm outcome
({fanoutId, arm, runId, outcome, vmName?}) via `emit()`, then for best-of-n one JSON line
{scores, tie, rationale}; diagnostics/error envelopes on stderr. Exit codes: **fanout**
[0,1,2,5,6] — 1 any-arm/provision failure collected (incl. all-setupFailed, all-armFailed),
2 validation, 5 refused before anything provisioned (fleet-busy, no-headroom, budget-exceeded),
6 landed-but-unreportable (ack/completion line unwritable — finish()'s outputIncomplete fold);
**rank** [0,1,2,4] — 4 unknown/unparseable fanout-id, 1 record read/write failure, 2 usage.
No `fleet reap` verb EVER (R4 FLAG 2 — DF2.6's scripts/sandbox-reap.ts is the whole sweep
surface). No `fleet attach` (DF3.4).

**Evidence**:
- `scripts/fleet.ts:123-137` — VALUE_FLAGS/BOOL_FLAGS derive from `listVerbs()`; new flags
  tokenize with no second edit; `parseArgv` refuses undeclared flags per entry.
- `scripts/fleet.ts:973-1019, :514-533` — readBrief/readCappedStdin/readBriefFile +
  MAX_BRIEF_BYTES; :634 assertOneBriefSource; :1187 status-row emit idiom for JSON-lines stdout.
- `scripts/fleet.ts:792-794` — `finish` folds `outputIncomplete` into 6; :346 `report` maps
  FleetError.exitCode (clamped, off-table→2) and untyped throws→1 with redacted stack.
- Exit-table classes: scripts/fleet.ts:9-13 header (F3 taxonomy) — 5 = refused before
  provisioning, 6 = landed-but-unreportable/non-retryable (constraint 3: cleanup failures are
  exit 6, never transient-retried).
- Bidirectional coverage: `tests/fleet/verbs.test.ts` ~:870-930 — every returned code must be
  declared and vice versa (bar allowlist); PROBES must cover each declared code for both new
  verbs. **Correction K4**: the pinned verb-order arrays live at FOUR sites — verbs.test.ts:314,
  :366, :875 (`expect(listVerbs().map(v=>v.verb)).toEqual([…4…] )`) — plus
  `tests/fleet/cli.test.ts:317` `EXPECTED_VERBS`; ALL FOUR need the additive update, assigned to
  agent D post-merge.

### D13. Observability + redaction
**Verdict**: Fan-out line `{requestId, fanoutId, pattern, n, headroom, timestamp, durationMs,
outcome}` via `log()` (operation `fleet.fanout`); per-arm line `{requestId, fanoutId, runId, arm,
exitStatus, durationMs}` (operation `fleet.fanout.arm`); rank line with `rank_ms`. Sub-timings
`admission_ms`, `mint_all_ms`, `arm_dispatch_ms` (per arm), `rank_ms` carried NESTED in the
structured line's `timings` object (nested, never spread — dispatch.ts:806-808 idiom); an arm
that cannot be decomposed reports 0 and its `durationMs` is authoritative. Errors carry
`{code, message, remediation}`, never key material (keyHash only). Redaction: ONE chokepoint —
`redactSecrets` from `src/providers/step-log.ts:225` — applied to EVERY string leaving the
process (messages, remediations, payload leaves, refusal echoes, operator stdout, log lines,
error stacks) and ALWAYS BEFORE bounded()/slice (redact-BEFORE-bound, r8 CC-9). requestId is the
CC-9 join key across all N traces; fanoutId groups them.

**Evidence**:
- **Correction K3 (SOURCE WINS)**: the story's INV-4 cites regex `[0-9a-zA-Z%-]{16,}` for
  management URLs. The SHIPPED mechanism is `redactSecrets` composing
  `redactKeyManagementUrls` with `KEY_MANAGEMENT_URL_RE =
  /https:\/\/openrouter\.ai\/[^\s"'}]*\/keys\/[0-9a-zA-Z%_-]{8,}/g` (cap-rejection.ts:233,
  composed at step-log.ts:225-236). Implement the CHOKEPOINT, not a second regex — a parallel
  16-char variant is exactly the duplicate-helper trap from DF3.1 rounds 3-9 (~15 leaks).
  Sub-floor-length secrets (13-39 chars) are covered by the chokepoint's existing arms; bounded
  echo forms (`bounded()`, fleet.ts:706+) redact first.
- Box-chosen strings (gate debugCommands, teardownCommand, arm rosterIds) escape like sibling
  fields — through the same chokepoint (r9 trap).
- Log sink: `setLogSink` from src/swarmclaw/log.ts; structured-line shape per logVerb
  (fleet.ts:659-687) — operation `fleet.<verb>`, phase "complete", exitCode, exitStatus.
- Timings closure idiom: dispatch.ts:659-662 `timings: Record<string,number>` + `phase(name, ms)`.

### D14. Tests
**Verdict**: Three new files per story FTM — `tests/fleet/fanout.test.ts` (record store + fleet
lock + primitive ordering), `tests/fleet/patterns.test.ts` (one E2E per pattern + AC2 negative
control + AC8 concurrent-race), `tests/fleet/rank.test.ts` (formula/tie/null/all-failed
contracts). Shared fakes extend `tests/fleet/helpers.ts` (goodLedger family — additive only).
Local `deps(overrides)` closures per the dispatch.test.ts:238-247 template; NO exported
cross-file builder exists and none is introduced. Concurrency-overlap tests FORCE interleaving
through SEAM barriers (the ledgerFactory/setupGate seams are synchronous — put the barrier at the
only await before the O_EXCL/create step), never natural timing (r9: natural interleaving made a
lost-race test pass vacuously). Every new assertion mutation-verified RED against pre-fix source;
import constants (FLEET_LOCK_STALE_MS, thresholds) rather than mirroring literals.

**Mandatory test inventory (pins the review-history constraints)**:
- AC1: driver.list spy asserts checkHeadroom consulted EXACTLY once for n=3; refusal → zero
  records/boxes/keys/mints; `list-unverified` refuses fail-closed.
- AC2 negative control: N arms through one box MUST fail (distinct-box/keyHash assertions).
- AC3: all mints precede the parallel section (ordering spy); no record-read id recovery (grep-
  level ban enforced by review).
- AC4: setupFailed arm left alive + siblings complete + teardown NOT called for it.
- AC5: planted-marker race (arm 2 first) → winner transition + losers torn down in the 8-step
  order; `ok:false` → armFailed + race continues; all-fail → winner null + every arm harvested-
  before-destroyed; never-appearing marker at ceiling → armUnknown, untouched; hung exec Proxy →
  tick skipped, logged, loop continues.
- AC6: many-stories n=1 same code path; best-of-n/race n=1 → exit 2; n=9 → exit 2.
- AC7: three-arm fixture asserting score to 6 decimals against 0.6/0.4; cross-arm union
  denominator; breakdown EXACTLY two keys (summaryQuality anywhere fails); tie deltas 0.05→true,
  0.2→false, **0.1→true** (boundary, via FP-normalized comparator); no-step-output arm listed
  score:null; all-failed → empty scores + rationale.
- AC8: two fanout invocations race the lock → one admits, other exits 5 `fleet-busy` with zero
  records/mints (seam barrier at the admission await); reclaim young+live → refuse; aged+dead →
  reclaim; aged+alive-identity-match → refuse (age alone MUST NOT reclaim); recycled pid
  (start-time mismatch) → reclaim; SIGINT mid-hold releases (drive a real child through the
  signal-install seam); orphan-parked body survives a sweep cycle.
- AC9: successful fanout leaves exactly one record matching schema, arms.length===n, each run
  record carries extensions.fanout={schemaVersion:1,fanoutId,arm}; refused fanout writes no file.
- Constraint pins: EEXIST stamp-skip (duplicate arm extension not double-written); exit-6
  non-retryable on completion-unwritable; fail-open-list refusal (store.list throwing names the
  file).
- E2E demo (MANDATORY, DOD): best-of-N N=3 on the fake driver → three CLOSED records, three
  distinct keyHash values, three bundles under `.sandbox/runs/`, one ranking table with
  rationale — captured verbatim in the Dev Agent Record.

**Evidence**:
- `tests/fleet/helpers.ts:66-133` — goodLedger(ceilingMicroUsd?, capMicroUsd?),
  overBudgetLedger(), admitThrowsLedger(), closeThrowsLedger(), RecordingLedger — extend, don't
  fork.
- `tests/fleet/dispatch.test.ts:132-202, :238-247` — tmpRoot lifecycle + deps(overrides) template.
- `tests/fleet/cli.test.ts:285, :1223-1240` — `Promise.race([pending, tick])` deadline idiom;
  child-process teardown ordering.
- Forced-interleaving lesson: R3 §4.3 (r9 HIGH) — barrier at the only await before O_EXCL.

---

## Executive Summary

DF3.2 turns disler's bash cookbook into two modules: `src/fleet/fanout.ts` (fan-out record store
mirroring RunRecordStore's O_EXCL/atomicReplace discipline under `.sandbox/fanouts/` 0700/0600; a
`.sandbox/fleet.lock` advisory lock composed over scripts/lib/run-lock.ts's exported hardened
primitives with story-mandated JSON bodies `{pid,pidStartTime,createdAt,requestId}`, two-part
age+identity reclaim at 3_600_000 ms, signal-handler-before-linkSync, and orphan parking under a
non-`.tmp` name; the fan-out primitive whose ordering is the contract — validate → lock → ONE
fail-closed `checkHeadroom(N)` → record O_EXCL → N synchronous `mintRunId()` → semaphore-bounded
`dispatch(brief, armDeps, {admitted:true, runId})` arms → per-arm outcome collection → release in
finally; and the AC5 race poller composing driver.exec probe + driver.copyFile read of
`runMarkerPath()` at a 5 s tick with 10 s per-call `withTimeout` deadlines and a 1 h ceiling) and
`src/fleet/rank.ts` (score = testPassRate×0.6 + uniqueFileCoverage×0.4 over the cross-arm union,
guarded divisors, exactly-two-key breakdown, FP-normalized inclusive ≤0.1 tie, null scores listed,
advisory only). Patterns are validations and compositions, not code paths: best-of-n/race take one
brief + roster list and reject N=1; many-stories takes N briefs and ranks nothing; isolation is
structural (N boxes/keys/records/namespaces) with a failing negative control. Arms carry
`extensions.fanout` through DF2.1's PRE-REGISTERED namespace (store stamps schemaVersion); setup
failures leave boxes alive as `setupFailed` while siblings complete; race losers and all-fail arms
go through unmodified DF2.5 teardown whose verified eight-step order harvests before destroying.
Per-arm caps default to the $50 single-run cap with aggregate exposure logged pre-dispatch;
threading a custom value needs one additive DispatchDeps field (OPEN-QUESTION-1). Verbs fanout
[0,1,2,5,6] and rank [0,1,2,4] join the registry (docstring and four pinned-order test sites
updated); stdout is JSON-lines; redaction is the single existing chokepoint applied before any
bound; seven corrections (K1-K8 minus none) supersede story/research shorthand where source
differs.

---

# CORRECTIONS — orchestrator-verified (placeholder)

> Appended post-verification by the orchestrator. Where any sketch or D-item above conflicts,
> THESE WIN. Corrections found during authoring are pre-registered below as K1-K8 so the
> verification pass confirms rather than discovers them.

## Orchestrator rulings — 2026-08-23 (THESE WIN)

- **C1 (resolves OQ-1 — APPROVED, already landed).** `DispatchDeps.capMicroUsd?: number`
  (dispatch.ts:301-310, JSDoc-carrying) and the third argument at the single
  `assertWithinBudget` call site (:1592-1599, `deps.capMicroUsd`) were applied BY THE
  ORCHESTRATOR before wave 1 launched, after `impact({target:"assertWithinBudget",
  direction:"upstream"})` returned LOW risk / 1 direct caller / processes {dispatch, run}.
  Verified post-edit: `tsc --noEmit` exit 0, `bun test tests/fleet/dispatch.test.ts`
  113 pass / 0 fail. Consequences: (a) agents code against REAL merged exports for the cap
  seam — no spec-guessing; (b) agent D owns NO dispatch.ts edit; (c) `FanoutDeps.capMicroUsd`
  threads through `armDeps` as a plain field — it compiles today.
- **C2 (resolves OQ-2 — option (b-plus)).** `stepOutputFor` stays injected (D11 contract
  unchanged). CLI surface addition: `rank --steps-json <path>` (optional, valueType "path")
  reads a JSON object mapping runId → `{testsExecuted?, testResults?, changedFiles?}`;
  absent flag ⇒ the accessor returns null for every arm ⇒ every arm listed `score:null`,
  `tie:false`, rationale stating "no step-output source provided". NOT an error — rank is
  advisory and remains structurally useful. Basis (verified this session): no canonical
  trace-db path resolution exists (Tracer dataDir is caller-chosen; only pipeline-run.ts
  constructs it); TraceReader exposes NO envelope read (editing DF1.4-owned reader.ts is
  outside FTM); the mandatory E2E runs on the fake driver where no engine executes and no
  trace.db ever exists, so a production accessor is untestable within this story. The story's
  wiring-closed enumeration names dispatch/headroom/record-store/journal — conspicuously no
  step-output store. Documented in Dev Agent Record as a deliberate deviation note.
  Agent D adds `--steps-json` to the rank registry entry (amends the D12 sketch).
- **C3 (wave-plan sequencing — supersedes the concurrent-A+B table above).** A and B write
  ADJACENT SECTIONS OF ONE FILE; concurrent unisolated edits guarantee conflicts, and B
  coding against not-yet-existing exports repeats the df3-1 B-death failure mode (spec-only
  code that never compiled until merge). Locked order:
  **Wave 1a (parallel)**: A (worktree-isolated: fanout.ts sections 1+2, fanout.test.ts,
  run-lock export keywords) ∥ C (main tree: rank.ts, rank.test.ts — fully disjoint files).
  **Wave 1b**: B (fanout.ts section 3 + patterns.test.ts) against A's REAL merged exports.
  **Wave 2**: D (verbs/index/scripts/test-pins/e2e demo) last, as planned.
  Test-fake ownership tightened: A keeps its fakes LOCAL to fanout.test.ts; B keeps its
  fakes LOCAL to patterns.test.ts; nobody touches tests/fleet/helpers.ts in wave 1 (D
  consolidates afterward only if real duplication emerged). This amends D14's "extend
  helpers.ts" guidance for wave 1 only.
- **C5 (wave-1a outcomes — THESE WIN for wave 1b).**
  - **K9 (source wins, agent A discrepancy #1):** `acquireRunLock` validates its id against
    `RUN_ID_RE` (no `.` admissible), so the D3 sketch's `acquireRunLock(join(dir),
    "<fanoutId>.json")` throws before any lock exists. Implemented form:
    `acquireRunLock(this.dir, fanoutId)` producing `<fanoutId>.lock` inside the fanouts dir —
    same hardened steal/refuse/signal discipline. FanoutRecordStore.mutate uses this lock.
  - **K10 (module split executed per D1 escape clause):** sections 1+2 landed at 779 lines,
    crossing the 600 threshold. Section 2 (FleetLock, FleetLockBody, readOwnPidStartTime,
    FLEET_LOCK_PATH/FLEET_LOCK_STALE_MS) now lives in NEW `src/fleet/fleet-lock.ts`;
    `src/fleet/fanout.ts` holds section 1 (FanoutRecordStore et al.) and is where B APPENDS
    section 3 at the marked point. Agent B imports: `{ FanoutRecordStore, mintFanoutId,
    FANOUT_ID_RE, resolveFansDir… }` from `./fanout.ts` and `{ FleetLock, FleetLockBody,
    FLEET_LOCK_PATH, FLEET_LOCK_STALE_MS }` from `./fleet-lock.ts`. Story-FTM deviation
    documented in Dev Agent Record as spec-authorized (D1 named risk, threshold crossed).
  - **K11 (rank deviation approved):** RankDeps carries `recordReader`/`recordWriter`
    (injected; structural `FanoutRecordView` defined locally in rank.ts) — NOT
    `store: RunRecordStore`/`fanoutsDir`. Score formula consumes only step outputs; spend/
    commit join fields are not in AC7's output shape, so dead deps were dropped (agent C).
    Agent D wires FanoutRecordStore.get/mutate into those seams at the CLI layer.
  - Wave-1a gate evidence: A 33/33 + full suite 3252 pass / 0 fail; C 14/14 + suite 3233
    pre-A / 0 fail; all four run-lock export keywords LOW blast radius (impact run before edit).
- **C4 (verification attestation).** Every load-bearing anchor in D1-D14 was re-read from
  source by the orchestrator this session and confirmed: EXTENSION_NAMESPACES.fanout
  pre-registration (run-record.ts:141-150), ExtensionPatch schemaVersion-stamping
  docstring (:124), parkAside orphan naming (:1630-1639), mintRunId (:319),
  {admitted:true} headroom-only skip (:1530-1533), budget-gate-always-runs (:1580-1592),
  no-cap-seam-before-edit (verified by grep), run-lock privates claim/writeLockDirect/
  isAlive/hostTag all module-private (:120/:138/:550/:618) with RunLockedError exported
  (:53), phase-engine barrel withholding journal markers (index.ts:18-24),
  runMarkerPath DF3.2 docstring (journal.ts:46-50), teardown 8-step array (teardown.ts:99-111),
  assertWithinBudget third-param default (budget-gate.ts:79-82), verbs.ts:39 "Exactly 4
  entries", cli.test.ts:317 EXPECTED_VERBS, redactSecrets chokepoint (step-log.ts:225),
  KEY_MANAGEMENT_URL_RE (cap-rejection.ts:233), TestCommandResult semantics
  (test-results.ts:140-146). K1-K8 confirmed accurate; no additional corrections arose.

- **K1** — Orphan-park suffix is `${lock}.orphan.<pid>.<hex}` with NO `.tmp` (parkAside,
  run-record.ts:1630-1639; sweep predicates verified at run-record.ts:806-845 and
  run-lock.ts:465-500). A `.tmp`-suffixed park would be garbage-collected by the next sweep.
- **K2** — The `extensions.fanout` CALLER patch omits `schemaVersion` (ExtensionPatch docstring,
  run-record.ts:121-123: "schemaVersion is the store's to stamp"). The DOD's rejection clause
  concerns the stored namespace, which the store guarantees.
- **K3** — Management-URL redaction ships as `KEY_MANAGEMENT_URL_RE`
  (`[0-9a-zA-Z%_-]{8,}`, openrouter-keys-scoped) composed INSIDE `redactSecrets`
  (cap-rejection.ts:233, step-log.ts:225-236). The story's `[0-9a-zA-Z%-]{16,}` is doctrine
  prose, not a second regex to implement.
- **K4** — The four-verb pinned-order assertions live at verbs.test.ts:314, :366, :875 AND
  cli.test.ts:317 (`EXPECTED_VERBS`); all four plus the verbs.ts:39 docstring need the additive
  six-verb update. cli.test.ts is not in the story FTM — assigned to agent D with an explicit
  note.
- **K5** — dispatch signature is `(brief: unknown, deps: DispatchDeps, opts)` (three args,
  dispatch.ts:633-637); the story's two-arg shorthand is collapsed. opts.runId must satisfy
  MINTED_RUN_ID_RE + assertValidRunId.
- **K6** — The tie boundary comparator requires FP normalization (`Number(delta.toFixed(10)) <=
  0.1`): IEEE-754 renders common fixture deltas (e.g. 0.7−0.6) just BELOW 0.1, flipping the
  DOD's boundary assertion unnormalized.
- **K7** — No `RUN_MARKER_ROOT` constant exists: the mechanisms are `runMarkerRoot()` /
  `runMarkerPath()` (journal.ts:38-50), withheld from the phase-engine barrel — import directly.
- **K8** — `min(N, headroom, 8)` degenerates to N under current admission semantics (allowed ⇒
  headroom ≥ N; N ≤ 8). Implemented literally (one line) for forward honesty.

## OPEN-QUESTIONS for the orchestrator

- **OQ-1 (D10)**: Approve the additive `DispatchDeps.capMicroUsd?: number` field + single
  call-site argument (`assertWithinBudget(ledger, input, deps.capMicroUsd)`) in
  `src/fleet/dispatch.ts` so DD-9's per-arm cap is threadable — or rule that v5.0 ships
  default-cap-only and `--cap-micro-usd` is refused at validation until a follow-up. Recommendation:
  approve (A); blast radius is one production caller (GitNexus-confirmed).
- **OQ-2 (D11/D14)**: `rank`'s PRODUCTION step-output accessor. No host-side "given runId return
  {testResults, testsExecuted, changedFiles}" reader exists today (envelope data persists in
  trace-store `payload_json` rows, tracer.ts:666-689). The locked contract makes `stepOutputFor`
  injected, so all tests and the e2e demo proceed; the orchestrator should rule whether the
  production default is (a) a trace-store envelope decode helper (new small read module) or
  (b) deferred with rank refusing exit 4-style when no source is wired. Tests are unblocked
  either way.

---

## Wave Plan (to become C-last)

Acyclic, disjoint file ownership. Each agent: TDD pre-check, test-first, `bun test` scoped to its
OWN files, biome + tsc clean, GitNexus `impact()` before any symbol edit and `detect_changes()`
before commit.

| Agent | Owns (FTM-disjoint) | Against | Notes |
|---|---|---|---|
| **A** | `src/fleet/fanout.ts` SECTION 1 (FanoutRecordStore, mintFanoutId, FANOUT_ID_RE) + SECTION 2 (FleetLock) + the four additive `export` keywords in `scripts/lib/run-lock.ts` + ALL of `tests/fleet/fanout.test.ts` | SPEC only | MUST run `impact({target:"claim"|"writeLockDirect"|"isAlive"|"hostTag", direction:"upstream"})` before the run-lock export edit and report blast radius. Lock tests drive real signal children through the install seam (zero-coverage handlers were deletable-green in df3-1). |
| **B** | `src/fleet/fanout.ts` SECTION 3 (primitive + patterns + poller) + ALL of `tests/fleet/patterns.test.ts` | SPEC ONLY (A's locked exports per this document — never compiled siblings; the df3-1 B-death lesson) | Codes against the signatures in this spec; imports compile once A merges. Owns the poller (deviation from the original C-owns-poller sketch: the poller is inseparable from the race composition, and disjoint-file ownership outranks it). Injects pollIntervalMs/deadline/ceiling seams so no test sleeps real seconds. |
| **C** | `src/fleet/rank.ts` + ALL of `tests/fleet/rank.test.ts` | SPEC only | Fixture-driven via injected `stepOutputFor`; boundary-tie fixtures constructed FP-aware (K6); asserts breakdown key exactness (summaryQuality fails). |
| **D** (after A+B+C merge) | `src/fleet/verbs.ts` (two entries + docstring) + `src/fleet/index.ts` (two export lines) + `scripts/fleet.ts` (two verb blocks) + additive updates to `tests/fleet/verbs.test.ts` (:314, :366, :875 + new PROBES for both verbs' declared exit sets) and `tests/fleet/cli.test.ts` (:317 EXPECTED_VERBS) + green-up + the MANDATORY e2e best-of-N N=3 fake-driver demo captured in the Dev Agent Record | Real merged exports | Only agent permitted to touch DF3.1-owned test files, and only at the four pinned-order sites + additive probes. Resolves OQ-1/OQ-2 as ruled before starting. |

Relaunch protocol (df3-1 playbook §1): if any wave-1 agent dies, relaunch NARROWER — its
remaining scope split into a smaller post-merge agent reading REAL merged exports, never a
whole-wave retry, never the original prompt re-sent. Dead agents' spec-only test files are
disposable by design; survivors keep shipping.

Named risks for reviewer attention: fanout.ts approaching the 500-line ceiling (split section 2
into `src/fleet/fleet-lock.ts` only if it exceeds ~600, orchestrator-approved); OQ-1 gating the
cap pass-through; OQ-2 gating rank's production accessor (tests unblocked either way).
