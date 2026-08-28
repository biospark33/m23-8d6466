# R1 — DF2.1 RunRecord store + `extensions` API map (for DF3.4)

Authority: `/Users/steve/QDS-Factory/src/providers/run-record.ts` (2163 lines), read in full.
Read-only research. Nothing edited.

---

## 0. Headline for DF3.4

- `approval` **is already registered** in `EXTENSION_NAMESPACES` (run-record.ts:198-211),
  schemaVersion 1, 9 fields. DF3.4 does **not** need to add the namespace; it may need to add
  fields (e.g. an expiry deadline — there is no `expiresAt`/`deadline` field today).
- The public patch API is `store.set(runId, patch)` (run-record.ts:1211). It takes the per-record
  PID lock internally via the **private** `withLock`.
- **There is no `withRunRecordTxn` / no public lock helper.** A read-decide-write across
  `get()` + `set()` is **not** atomic. DF5.1 already hit this and built a *separate* lock file
  (`<dir>/<runId>.approval.lock`, `src/reverify/approval.ts:87-174`) precisely because taking the
  store's own lock from outside would deadlock. DF3.4's decide side must use **that same** lock, and
  `withApprovalLock` is currently module-private (not exported from `src/reverify/index.ts:21-27`).

---

## 1. `EXTENSION_NAMESPACES` — full current contents

`run-record.ts:141-221`. Shape of the map:

```ts
export const EXTENSION_NAMESPACES: Readonly<
  Record<string, { schemaVersion: number; fields: Readonly<Record<string, FieldKind>> }>
> = { ... };
```

`FieldKind = "string" | "int" | "ports"` (run-record.ts:48). `ports` is only used by the core
field `ports`; no extension declares it today.

Registered namespaces, verbatim field lists:

| ns | schemaVersion | fields | line |
|---|---|---|---|
| `pr` | 1 | `prUrl:string`, `prNumber:int`, `createdAt:string` | :162 |
| `fixLoop` | 1 | `fixContext:string`, `fixOutcome:string` | :164 |
| `fanout` | 1 | `fanoutId:string`, `arm:string` | :166 |
| `budget` | 1 | `repoSlug:string`, `issueId:string`, `capMicroUsd:int`, `spentMicroUsd:int`, `reservedMicroUsd:int`, `admittedCeilingMicroUsd:int` | :176-186 |
| `approval` | 1 | see below | :198-211 |
| `gate` | 1 | `outcome:string`, `failedItem:string`, `assertionCode:int`, `failedAt:string` | :217-220 |

### The `approval` entry, verbatim (run-record.ts:187-211)

```ts
  /**
   * DF3.4's pre-PR approval gate, registered here so DF5.1 — the single owner
   * of the `requestApproval` CALLER — can bind a green host verdict to a
   * decision. `reportId` is a `ReverifyReport.reverifyId` and `headSha` is that
   * same report's head: the approval binds to one report, not to a run in
   * general, and `supersededReportId` records the report a rebind displaced.
   *
   * States: `pausing` (created before teardown, not yet promoted),
   * `awaiting-approval`, then terminal `approved` / `rejected` / `timed-out`.
   * DF3.4 owns the decide side and may extend these fields.
   */
  approval: {
    schemaVersion: 1,
    fields: {
      state: "string",
      proposal: "string",
      reportId: "string",
      headSha: "string",
      requestedAt: "string",
      supersededReportId: "string",
      approverId: "string",
      decidedAt: "string",
      reason: "string",
    },
  },
```

State vocabulary is duplicated (as a TYPE, not imported) in `src/reverify/approval.ts:21-23`:

```ts
export type ApprovalState = "pausing" | "awaiting-approval" | "approved" | "rejected" | "timed-out";
const TERMINAL: ReadonlySet<string> = new Set(["approved", "rejected", "timed-out"]);
```

Note: the store validates `state` only as `"string"`. **Nothing in the store enforces the state
machine.** DF3.4 owns that enforcement.

### How `validateExtensions` enforces the spec (run-record.ts:600-656)

```ts
function validateExtensions(
  patch: unknown,
  existing: RunRecordExtensions | undefined,
  mode: "read" | "write" = "write",
): RunRecordExtensions
```

Write path, per namespace in the patch:
1. `const spec = Object.hasOwn(EXTENSION_NAMESPACES, ns) ? EXTENSION_NAMESPACES[ns] : undefined;`
   `if (!spec) throw new Error(\`unregistered extension namespace: extensions.${ns}\`);` (:610-611)
   — **undeclared namespace = hard throw on BOTH read and write.**
2. body must be a non-array object, else `extensions.<ns> must be an object` (:612-614).
3. `schemaVersion` supplied by the caller must equal `spec.schemaVersion` exactly, else throw
   (`extensions.<ns>.schemaVersion is 1, not 2`, :631-635). Callers normally omit it — the store
   stamps it (:620-621).
4. Never downgrade: `const version = typeof stored === "number" && stored > spec.schemaVersion ? stored : spec.schemaVersion;` (:620)
5. Per field: `const kind = Object.hasOwn(spec.fields, field) ? spec.fields[field] : undefined;`
   `if (!kind) throw new Error(\`unknown key: ${extPath(ns, field)}\`);` (:647-648)
   then `assertKind(...)` then `assertNoSecret(...)` (:649-650).

Read path (`mode: "read"`, used only by `assertWellFormed` :667): unregistered NAMESPACE still
throws; unknown FIELDS and a NEWER stored `schemaVersion` inside a registered namespace are
tolerated verbatim (:638-645), and `assertKind`/`assertNoSecret` are **skipped**. Rationale at
:591-598: rejecting on read would make `list()` throw and take the whole fleet's reaper down.

**DF3.4 consequence:** adding new fields to `approval.fields` does *not* require a schemaVersion
bump for cross-version safety (older builds tolerate unfamiliar fields in a registered namespace on
read). Bumping the version *is* a compatible change too (never downgraded), but is only needed if
DF3.4 changes the MEANING of an existing field.

---

## 2. Store class, constructor, and the locked write path

### Constructor (run-record.ts:794-825)

```ts
export interface RunRecordStoreOptions {
  dir?: string;              // defaults to $QDS_RUNS_DIR or .sandbox/runs
  requestId?: string;        // rides every mutation log line
  create?: boolean;          // default true. false = READ-ONLY store
  beforeRename?: (tmpPath: string) => void;    // fault-injection seam
  beforeStealTake?: (lockPath: string) => void;
  afterLockTake?: (claimedPath: string) => void;
}

export class RunRecordStore {
  readonly dir: string;
  constructor(opts: RunRecordStoreOptions | string = {})   // a bare string = { dir }
}
```

Writable construction (`create` omitted/true) does: `mkdirSync(dir, {recursive, mode:0o700})`,
`chmodSync(dir, 0o700)`, assert mode is exactly 0700 else throw, `assertExclusiveCreateSupported()`
(probes O_EXCL + 0600 + `link(2)` + `fsync(2)`, throws naming the missing primitive), then
`cleanStaleTemps()`.

`create: false` (run-record.ts:702-721, 843-854) does **only** `assertReadable()` — a `statSync`
+ isDirectory check, errno preserved on the thrown error. No mkdir, no chmod, no probe, no sweep.
Every mutating verb then throws via `assertWritable()` (:866-871).

### Public API surface

| Method | Signature | Locked? | Line |
|---|---|---|---|
| `path` | `path(runId: string): string` → `<dir>/<runId>.json` | n/a | :1062 |
| `lockPath` | `lockPath(runId: string): string` → `<dir>/<runId>.json.lock` | n/a | :1078 |
| `create` | `create(runId: string, now: Date = new Date()): RunRecord` | **no lock** (O_EXCL + `link` publish) | :1083 |
| `get` | `get(runId: string): RunRecord` | no | :1201 |
| `set` | `set(runId: string, patch: RunRecordPatch): RunRecord` | **YES — `withLock` internally** | :1211 |
| `close` | `close(runId: string, now: Date = new Date()): RunRecord` | **YES — `withLock`** | :1250 |
| `list` | `list(): RunRecord[]` — THROWS if anything was skipped | no | :1284 |
| `listWithAnomalies` | `listWithAnomalies(): RunRecordListing` | no | :1319 |

There is **no** `load`. Reading is `get()`. There is **no** public `withLock`, no
`withRunRecordTxn`, no `update(runId, fn)`. `withLock` is `private withLock<T>(runId: string, fn: () => T): T`
(:1396) — DF3.4 cannot call it.

### The locked patch path, in full

```ts
set(runId, patch)                 // :1211  → traced(runId, "set", …)
  → setUnlogged(runId, patch)     // :1215  → this.withLock(runId, () => this.setLocked(runId, patch))
    → setLocked(runId, patch)     // :1219
        const current = this.get(runId);
        const next: RunRecord = { ...current };
        const closed = typeof current.closedAt === "string";
        for (const [key, value] of Object.entries(patch)) {
          if (value === undefined) continue;                       // :1225
          if (key === "extensions") {
            next.extensions = validateExtensions(value, current.extensions);   // :1229
            continue;
          }
          if (IMMUTABLE_FIELDS.has(key)) throw new Error(`immutable key: ${key}`);
          if (key === "closedAt") throw new Error("closedAt is written by close(), not set()");
          const kind = ...CORE_FIELDS[key]; if (!kind) throw new Error(`unknown key: ${key}`);
          if (closed) throw new Error(`record ${runId} is closed; core key not writable: ${key}`);
          assertKind(key, kind, value); assertNoSecret(key, value);
          next[key] = value;
        }
        this.atomicReplace(runId, next);
        return next;
```

### Example call from an existing consumer

DF5.1's approval adapter, `src/reverify/approval.ts:210-226`:

```ts
store.set(runId, {
  extensions: {
    approval: {
      state: "awaiting-approval",
      proposal: req.proposal,
      reportId: req.reportId,
      headSha: req.headSha,
      requestedAt,
      // `set()` deep-merges the namespace field-by-field, so an omitted
      // key retains whatever a prior cycle left there. …explicitly clear
      // supersededReportId rather than leave a stale value…
      supersededReportId: "",
    },
  },
});
```

Fanout stamp, `src/fleet/fanout-primitive.ts:873-883` (the idempotence idiom DF3.4 should copy for
"create only if absent" — note it is *not* atomic, see §4 gotchas):

```ts
export function stampFanoutExtension(store: RunRecordStore, runId: string, fanoutId: string, arm: number): void {
  let current: RunRecord;
  try { current = store.get(runId); }
  catch (e) { if ((e as NodeJS.ErrnoException)?.code === "ENOENT") return; throw e; }
  if (current.extensions?.fanout !== undefined) return;
  store.set(runId, { extensions: { fanout: { fanoutId, arm: String(arm) } } });
}
```

Gate refusal, best-effort write, `src/fleet/dispatch.ts:2611-2621`. Budget write in
`src/providers/driver.ts:553`. PR write in `src/pr/open-pr.ts:347`.

---

## 3. `RunRecordPatch` and merge semantics

```ts
// run-record.ts:115-134
export interface ExtensionEntry {
  schemaVersion: number;
  [field: string]: string | number;
}
export type RunRecordExtensions = Record<string, ExtensionEntry>;

/** Extension fields as a caller supplies them — `schemaVersion` is the store's to stamp. */
export type ExtensionPatch = Record<string, Record<string, string | number>>;

export type RunRecordPatch =
  Partial<Omit<RunRecord, "runId" | "createdAt" | "closedAt" | "extensions">> & {
    extensions?: ExtensionPatch;
  };
```

No index signature ⇒ a misspelled *core* key is a compile error as well as a runtime one.
`ExtensionPatch` is `Record<string, Record<…>>` ⇒ a misspelled *namespace* or *field* is caught at
RUNTIME only (`unregistered extension namespace: …` / `unknown key: extensions.ns.field`).

### Merge semantics: DEEP MERGE, field-by-field, additive-only

`validateExtensions` (:608-655):
- `const merged = structuredClone(existing ?? {})` — **namespaces absent from the patch are preserved.**
- `const entry: ExtensionEntry = { ...(merged[ns] ?? {}), schemaVersion: version }` — **fields absent
  from the patched namespace body are preserved.**
- fields present in the body overwrite.

So: it is *not* a whole-namespace replace. **There is no way to DELETE a field or a namespace
through `set()`.** The established idiom for clearing is writing `""` (approval.ts:223) or `0`.

Also: `set()` skips any patch key whose value is `undefined` (:1225), so
`set(id, { extensions: undefined })` is a no-op, and inside a namespace body an `undefined` value
would fail `assertKind` (it is not `string`/`int`) — omit the key instead.

---

## 4. The PID lock

### File naming
`lockPath(runId)` = `` `${this.path(runId)}.lock` `` = `<dir>/<runId>.json.lock` (:1078-1080).
Docstring at :1067-1077 warns loudly that `<runId>.lock` (no `.json`) is a **different contract** —
`scripts/lib/run-lock.ts`'s invocation lock — living in the same directory.

DF5.1's approval lock is a **third** file: `<dir>/<runId>.approval.lock` (approval.ts:88).

### Acquisition (`withLock`, :1396-1446)

```ts
private withLock<T>(runId: string, fn: () => T): T
```
- `this.assertWritable()` first (:1399) — a `create:false` store cannot `set`/`close`.
- Deadline from `performance.now()` (MONOTONIC, deliberately — :1401-1405), budget
  `LOCK_TIMEOUT_MS = 5_000` (exported, :269).
- Body written to the lock file is `` `${process.pid} ${randomBytes(4).toString("hex")}\n` `` (:1408)
  — pid for liveness probing, nonce for release/steal generation comparison.
- Claim is `claimLock` (:1461): write pid-stamped temp → `fsync` → `close` → `linkSync(tmp, lock)`.
  `link(2)`, not O_EXCL-then-write, so the lock is never observable half-written (:1448-1459).
  EEXIST ⇒ `false` (contended).
- On a failed claim: deadline check → throw
  `` `timed out waiting for the run record lock: ${lock} (${heldReason})` `` (:1421); then
  `stealIfOwnerGone`.
- `LOCK_IMMEDIATE_RETRIES = 8` sleepless retries for the fast hand-off (:283), then `sleepMs(5)`
  every iteration. `sleepMs` is `Atomics.wait` — **it blocks the thread/event loop** (:1985-1987).
- On success: `heldLocks.add(lock)` (per-THREAD module Set, :373), `try { return fn() } finally { heldLocks.delete(lock); this.releaseLock(lock, body); }`.

### Staleness / liveness rules (`stealIfOwnerGone`, :1551-1672)

Returns `null` = path free, retry now; a non-null reason string = HELD, wait.
- `readFileSync(lock)` ENOENT ⇒ `null`. **Any other errno ⇒ HELD** (`lock unreadable: <code>`),
  never "free" (:1555-1561).
- Owner pid parsed from the first whitespace token. Non-integer or `<= 0` ⇒ ownerless: HELD until
  `olderThan(lock, OWN_LOCK_GRACE_MS)` where `OWN_LOCK_GRACE_MS = 60_000` (:320, :1580-1581).
- `owner === process.pid && heldLocks.has(lock)` ⇒ `"re-entrant record write: this thread already
  holds this lock"` — checked BEFORE the age bound (:1591-1593).
- `owner === process.pid` otherwise ⇒ held iff `raw !== body && !olderThan(lock, OWN_LOCK_GRACE_MS)`
  (:1594-1597). Foreign pid ⇒ `isAlive(owner)` via `process.kill(pid, 0)` where **EPERM counts as
  alive** (:2128-2135).
- Steal is TAKE-THEN-COMPARE: `renameSync(lock, `${lock}.${pid}.${hex}.tmp`)`, read the taken bytes,
  and only `rmQuiet` them if they equal the bytes judged (`onDisk === raw`, :1634-1642). Otherwise
  `putBack` (`linkSync`, never rename, :1920-1932) and report HELD.
- If `putBack` fails (ENOSPC/EMLINK/EDQUOT/EIO — EEXIST counts as success): the lock path is now
  **empty while a live holder is inside `fn()`**. The body is `parkAside`d to
  `<path>.orphan.<pid>.<hex>` (unswept by `cleanStaleTemps` for `ORPHAN_GRACE_MS = 86_400_000`) and
  a `lock.not-restored` error line is emitted (:1666-1671). This is a known, documented,
  operator-manual-recovery hole.

### Release (`releaseLock`, :1697-1786)
Read-first (so the common case never vacates the path), then the same take-then-compare.
Rename failure retried once after `sleepMs(5)`; on persistent failure it writes a stderr note and a
`lock.release-failed` log line and **returns** — it never throws, because it runs in a `finally`
where a throw would replace the caller's committed result.

### Recorded caveats (all in-file, all deliberate)
- **`rmQuiet` guards** (:1976-1982): every cleanup unlink is swallowed, because the record write has
  already committed by the time `finally` runs and a throwing `rm` would turn a durable success into
  a thrown error — "a doubled spend delta on the money path" (:1756-1762). Same guard in
  `claimLock` (:1492-1498) and `atomicReplace`'s catch (:1817-1820).
- **`atomicReplace` catch guard** (:1813-1822): `if (fdOpen) closeSync(fd)` — guarded, not
  try/caught, because fd numbers are recycled and `beforeRename` may have opened something else.
  `fdOpen` is cleared BEFORE `closeSync` (:1801-1804) since a throwing close still consumes the fd.
- **Lock-timeout "rollback"**: there is none, and none is needed — the timeout is thrown from
  `withLock` **before** `fn()` runs (:1420-1422), so `setLocked` never executed and nothing was
  written. What DF3.4 must handle is the *caller-side* consequence: a 5 s timeout means the approval
  decision was NOT recorded, and the error message is untyped (a plain `Error` matched only by
  text). See gotcha G6.

---

## 5. `atomicReplace` / durable-write helpers

```ts
// run-record.ts:1789
private atomicReplace(runId: string, rec: RunRecord): void
```
`openSync(tmp, "wx", 0o600)` where `tmp = `${p}.${process.pid}.${randomBytes(4).toString("hex")}.tmp``
→ `writeFileSync(fd, serialize(rec))` → **`fsyncSync(fd)`** → `closeSync` → `beforeRename?.(tmp)`
→ `renameSync(tmp, p)`. On throw: guarded `closeSync`, `rmQuiet(tmp)`, rethrow.

**The FILE is fsynced; the DIRECTORY ENTRY is not** — explicit ponytail note at :1807-1812: a power
loss in that window loses the rename, not the bytes, so the record reverts to its prior complete
contents. Never truncated.

`serialize` = `` `${JSON.stringify(rec, null, 2)}\n` `` (:2137-2139).

`create` uses a different path — `publishCreate` (:1142-1199): temp → `writeFileSync` → `fsyncSync`
→ `close` → **`linkSync(tmp, p)`** (single-winner publish, EEXIST retargeted to the final path so
dispatch classifies "run-id-in-use" not "provision-failed") → `rmQuiet(tmp)`. Then
`fsyncDir(this.dir)` (:1111), best-effort (:2101-2125) — guarded end to end, including the `close`.

---

## 6. "Writable after `closedAt` is set" — the enforcement

`setLocked`, run-record.ts:1219-1243. Verbatim:

```ts
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
      if (key === "closedAt") throw new Error("closedAt is written by close(), not set()");
      const kind = Object.hasOwn(CORE_FIELDS, key) ? CORE_FIELDS[key] : undefined;
      if (!kind) throw new Error(`unknown key: ${key}`);
      if (closed) throw new Error(`record ${runId} is closed; core key not writable: ${key}`);
```

The `extensions` branch `continue`s **before** the `closed` check, so:

| after close | writable? |
|---|---|
| `extensions.*` (any registered ns, incl. `approval`) | **YES** |
| every core field (`vmName`, `httpsUrl`, `keyHash`, `limitMicroUsd`, `spendMicroUsd`, `sessionId`, `commitSha`, `requestId`, `ports`, `pid`) | NO — `record <id> is closed; core key not writable: <key>` |
| `runId`, `createdAt` | NO, ever — `immutable key: <key>` (`IMMUTABLE_FIELDS`, :75) |
| `closedAt` | NO via `set()`, ever — `close()`'s alone (:1236) |

`close()` is first-close-wins: a second `close` returns the existing record unchanged (:1250-1260).
Cross-referenced by `src/providers/teardown.ts:466` ("7. close — LAST. (extensions stay writable
post-close; we write none.)") and `src/reverify/approval.ts:11-12`.

**This is exactly the property DF3.4 depends on**: the pause happens after teardown has closed the
record, and the approve/reject decision is an `extensions.approval` write on a closed record.

---

## 7. `assertNoSecret` — what it scans, and when

`run-record.ts:528-564`. Two independent tests, both only on `typeof value === "string"`:

1. **Prefix scan**, at a token boundary anywhere in the string, not just position 0:
   `new RegExp(`(^|[^A-Za-z0-9])${escaped}`).test(v)` (:534-538) over `SECRET_PREFIXES` (:428-473,
   `Object.freeze`d): `sk-`, `sk_live_`, `sk_test_`, `ghp_`, `gho_`, `ghs_`, `ghu_`, `ghr_`,
   `github_pat_`, `xoxb-`, `xoxp-`, `xapp-`, `xoxa-`, `xoxr-`, `rk_live_`, `rk_test_`, `AIza`,
   `AKIA`, `ASIA`, `-----BEGIN`.
2. **Shape heuristic**: skipped for `SHAPE_EXEMPT_PATHS` (:496-503 — `keyHash`,
   `extensions.budget.repoSlug`, `extensions.budget.issueId`; those instead get a `v.length > 201`
   bound, :550) and skipped for anything matching `/^[a-z][a-z0-9+.-]*:\/\//i` (a URL, :555).
   Otherwise throws when `v.length >= 40 && mixedClass && /^[A-Za-z0-9+/=_.:-]+$/.test(v)` where
   `mixedClass = /[a-z]/ && /[A-Z]/ && /\d/` (:560-563).

Error text: `refusing to write key material into the run record: <key>` (or
`value exceeds the field's grammar bound: <key>` for the exempt paths).

**Where it runs:**
- core field writes in `setLocked` (:1241)
- extension field writes in `validateExtensions` **write mode only** (:650)
- **NOT on reads**: the read branch (:638-645) assigns `entry[field] = value` and `continue`s
  before reaching `assertKind`/`assertNoSecret`. So `assertWellFormed` → `validateExtensions(…,
  "read")` → no secret scan. A record written by a build with a looser list stays readable.
- `create()` writes only `runId`/`createdAt`, so no scan there.

Path key format is always `extPath(ns, field)` = `` `extensions.${ns}.${field}` `` (:513-515). The
exempt set is keyed with the same helper on purpose (:511-512) — a hand-written literal that drifts
exempts nothing.

Live evidence this bites: `src/reverify/runner.ts:240-245` deliberately lowercases and hyphenates
`reverifyId` because it is written to `extensions.approval.reportId` and would otherwise trip the
mixed-class heuristic.

---

## 8. Record file path, records-dir resolution, and the CWD caveat

- File path: `path(runId)` = `join(this.dir, `${runId}.json`)` (:1062-1065), guarded by
  `assertExistingRunId` — the **LEGACY** grammar `LEGACY_RUN_ID_RE = /^[a-z0-9][a-z0-9-]*$/`
  (:260) with `RUN_ID_MAX = 63`. `create()` additionally applies the STRICT
  `RUN_ID_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/` (:238, applied at :1091). Both reject `/`, `.`,
  `..`. Errors are `InvalidRunIdError` (:384-389) — a real subclass so callers classify on
  `instanceof`, never on message text.
- Mode: records 0600, dir 0700 (asserted, not assumed).
- Resolution chain, the ONE copy (`resolveRunsDir`, :768-773):

```ts
export function resolveRunsDir(dir?: string): string {
  if (dir !== undefined) return dir;
  const env = process.env.QDS_RUNS_DIR?.trim();
  if (env !== undefined && env !== "") return env;
  return DEFAULT_RUNS_DIR;               // ".sandbox/runs"   (:744)
}
```
  An EMPTY `QDS_RUNS_DIR` is folded to unset (the DF3.1-era finding: `""` is not nullish, so it beat
  the default and relocated records *and both money files* to cwd and cwd's PARENT —
  `_bmad-output/workflow-state/code-review/pr123-r11/raw/r2-edge-engine.md:12`).

- **CWD caveat (DF3.1 review):** `DEFAULT_RUNS_DIR` is a **relative** path, and `resolveRunsDir`
  does not `resolve()` it. A caller-supplied relative `--dir` is likewise passed through unresolved.
  DF3.1's fix was to stop DERIVING other paths from it
  (`df3-1-dispatcher-core-verbs.md:1180-1184`: "*The ledger path depended on the caller's CWD.*
  `dir === resolve(DEFAULT_RUNS_DIR)` compared against a relative default, so the same records dir
  reached from two cwds used two ledgers"), and :1001-1004 ("*Relocating the records directory
  silently relocated — and could silently share — the money*"). The relative default itself is
  unchanged. **Any DF3.4 sidecar file (an approval lock, an expiry cursor) must be derived from
  `store.dir` and must not re-resolve the chain independently.**

- How a dir is passed in: `new RunRecordStore({ dir, requestId })`, or `new RunRecordStore(dir)`
  (string overload, :804). Read-only: `new RunRecordStore({ dir, create: false })` —
  `src/pr/push.ts:213-214` is the reference:
  ```ts
  const runsDir = resolveRunsDir(deps.runsDir);
  const store = deps.store ?? new RunRecordStore({ dir: runsDir, create: false });
  ```
  `scripts/fleet.ts:2212` is the `fleet status` pattern — **read-only exactly when `--dir` was
  given**: `new RunRecordStore({ ...storeOpts, create: dir === undefined, requestId })`, because
  a writable store re-chmods an operator's directory to 0700 (:2166, :2204; rationale in the
  `create` docstring at :702-721).
  `scripts/fleet.ts:334-349` (`assertRecordsDirUsable`) refuses a nonexistent `--dir` with a usage
  error **before** anything is constructed, since a writable store would `mkdir -p` a typo.

---

## 9. Enumeration for a scan — `list()` / `listWithAnomalies()` and quarantine

```ts
// run-record.ts:776-792
export interface RunRecordListing {
  records: RunRecord[];
  skipped: string[];         // filenames, sorted (readdir sorted first)
  skippedReasons: string[];  // same order, same length — a parallel array, not a shape change
}
```

`listUnlogged` (:1323-1379), per `readdirSync(this.dir).sort()` entry:
1. skip anything not ending `.json`.
2. stem must pass `assertExistingRunId`; else push
   `malformed run record <name>: filename is not a valid run id` and emit a `list.anomaly` log line
   with `code: "malformed_record_name"`.
3. otherwise `readRecord(join(dir, name), id)` inside a try; **the BODY is quarantined per file
   too** — any throw pushes the file + `(e as Error).message` and emits `list.anomaly` with
   `code: (e as NodeJS.ErrnoException).code ?? "unreadable_record"`. Rationale at :1343-1365:
   one unparseable file used to take the whole sweep down, so `reapRuns` reaped nothing and
   `fleet status` rendered nothing while every live box kept billing.
4. `readRecord` (:2141-2163) → `readFileSync` (errno preserved on the wrapped error, :2146-2153)
   → `JSON.parse` → `assertWellFormed` (:659-692: unknown core key, wrong kind, `runId` mismatch,
   missing/unparseable `createdAt`, and `extensions` through `validateExtensions(…, "read")`).

`list()` (:1284-1298) calls `listWithAnomalies()` and **throws** if `skipped.length > 0`, with the
reasons interpolated:
```
refusing to return a partial run record listing from <dir>: N file(s) could not be read as a record (<name>: <reason>; …) — use listWithAnomalies() to handle them, or repair/remove the files named
```

### The consumers DF3.4 must reuse, not re-implement

- **`fleet status`** — `src/fleet/status.ts:602` calls `deps.store.listWithAnomalies()` and then
  **re-validates the returned shape inside the same try** (:618-638) because `RunRecordStore` is a
  structural interface a test double can satisfy while returning junk; any failure becomes
  `FleetError(1, "record-store-unreadable", …)` (:641-648). A non-empty `skipped` becomes a
  synthetic `recordsSkippedRow` (:518-524, `state: "recordsSkipped"`, filenames through `safeName`).
  Orphan classification is then explicitly *unprovable* (:661-665) — a skipped file may be the
  record that claims the box. `statusRun`'s not-found path uses `skippedRecordNames(store)`
  (:544-548) which swallows a store failure and returns `null` rather than converting a clean exit-4
  into a stack.
- **`reapRuns`** — `src/providers/driver.ts:1320` calls `store.listWithAnomalies()` directly so it
  can raise its own refusal (:1296-1310), and `src/providers/reaper.ts:341` uses plain `store.list()`
  where the phase has nothing to do with the anomaly.
- `StatusRow.state` is a closed union (`status.ts:32`) — DF3.4's `fleet status` join for approval
  state will need to extend that union or add a field, not squeeze into an existing state.

---

## Gotchas that would make a naive DF3.4 implementation wrong

**G1 — `get()` + `set()` is NOT atomic; the store's lock is unreachable.** `withLock` is private
(:1396) and `set()` takes it *per call*. A decide flow that reads `state === "awaiting-approval"`
and then writes `approved` can interleave with a concurrent `fleet reject` and with DF5.1's
`requestApproval` rebind. DF5.1 documented this and built a separate advisory lock
(`src/reverify/approval.ts:43-56`: "*The store's own lock is private and taken inside `set`, so this
is a separate file — taking the store's would deadlock.*"). DF3.4 must use the **same**
`<dir>/<runId>.approval.lock`, or the two mutual-exclusion domains do not intersect and the guard is
vacuous. `withApprovalLock` is currently **module-private** and NOT re-exported from
`src/reverify/index.ts:21-27` (only `recordApprovalPort` and the types are).

**G2 — no field/namespace deletion, ever.** Deep-merge is additive-only (§3). Promoting `pausing` →
`awaiting-approval` → `approved` cannot clear `supersededReportId`, `reason`, etc.; the established
idiom is writing `""` (approval.ts:218-223 has the comment spelling this out). Any DF3.4 code that
assumes an absent field means "not set this cycle" is wrong — it means "not set *ever*, by anyone".

**G3 — `assertNoSecret` fires on operator free text.** `approval.proposal` and `approval.reason` are
`"string"` fields that will carry human/agent-authored text. The **prefix scan matches anywhere at a
token boundary**, so a reason containing ` sk-`, `AKIA`, `AIza`, `-----BEGIN`, `ghs_`… throws and
fails the whole `set()` — including on the *reject* path, where the operator is least expecting it.
The shape heuristic additionally rejects any ≥40-char all-`[A-Za-z0-9+/=_.:-]` mixed-class token
(a whole-string match, so multi-word prose is safe from it, but a single long token is not).
`extensions.approval.*` is **not** in `SHAPE_EXEMPT_PATHS`. DF3.4 should bound/sanitize
`proposal`/`reason` at its own boundary and produce a typed refusal, rather than letting the store's
`refusing to write key material into the run record: extensions.approval.reason` surface as an
approval failure. Precedent: `runner.ts:240-245` pre-shapes `reverifyId` for exactly this reason.

**G4 — `state` is validated only as `"string"`.** The store enforces no transitions and no
enumeration. `pausing`/`awaiting-approval`/terminal is caller-side contract only
(`src/reverify/approval.ts:21-23`). DF3.4 owns the whole state machine, and `src/pr/push.ts:258-299`
is the *downstream* enforcer that will reject anything malformed at PR time (codes
`approval-missing`, `approval-not-approved`, `approval-incomplete`, `approval-report-mismatch`,
`approval-sha-mismatch`, `approval-precedes-report`).

**G5 — a `create: false` store cannot decide.** `assertWritable()` is inside `withLock` (:1399) and
`createUnlogged` (:1088). `fleet status` builds a read-only store whenever `--dir` is given
(`scripts/fleet.ts:2212`). DF3.4's `fleet approve`/`fleet reject` must construct a **writable**
store — and that store will `mkdir -p` + `chmod 0700` the directory, which is precisely why
`scripts/fleet.ts:334-349` refuses a nonexistent `--dir` first. Copy that guard.

**G6 — the lock timeout is a plain untyped `Error`.** `timed out waiting for the run record lock:
<path> (<reason>)` (:1421). Nothing was written (the throw precedes `fn()`), but there is no typed
class to match on — DF3.4 must not text-match it into a "rejected" outcome. Budget: 5 s
(`LOCK_TIMEOUT_MS`, exported for tests only). The wait **blocks the event loop** (`Atomics.wait`,
:1985-1987), so an async approval intake still stalls its whole runtime for up to 5 s per contended
write.

**G7 — `list()` throws on any anomaly.** The expiry sweep and the `fleet status` join must use
`listWithAnomalies()` and carry `skipped`/`skippedReasons` forward (as `status.ts:665` and
`driver.ts:1320` do). A sweep that calls `list()` dies wholesale on one unrelated bad `.json`; a
sweep that silently drops skipped files can time out an approval whose record it could not read.

**G8 — timing out an approval is a WRITE, and it needs the same guards.** There is no existing
`timed-out` writer anywhere in the tree (only the type and the `TERMINAL` set). The expiry sweep
must (a) hold the approval lock, (b) re-read state under it, (c) refuse to overwrite a terminal
state, and (d) tolerate ENOENT (`get()` preserves errno, :2146-2153 — the `stampFanoutExtension`
idiom at `fanout-primitive.ts:876-879` is the reference).

**G9 — `approval` has no deadline field today.** `EXTENSION_NAMESPACES.approval.fields` (:200-210)
has no `expiresAt`/`timeoutAt`/`deadline`. DF3.4 must add one (a `"string"` ISO stamp is consistent
with `requestedAt`/`decidedAt`) — an additive field change needing **no** schemaVersion bump, since
the read path tolerates unfamiliar fields in a registered namespace (:638-645). Alternatively derive
expiry from `requestedAt` + a policy constant and store nothing, which is the smaller diff.

**G10 — blast radius of touching `set`.** `impact({target:"set", direction:"upstream", repo:"QDS-Factory"})`
reports **CRITICAL**, 12 impacted symbols, 5 direct, 7 processes: `runCapHitDemo`
(scripts/cap-hit-demo.ts), `run` (scripts/run-record.ts), `fanout` (src/fleet/fanout-primitive.ts),
`run` (scripts/fleet.ts), `provisionAdmittedRun` (src/providers/driver.ts), `dispatch`
(src/fleet/dispatch.ts), `requestApproval` (src/reverify/approval.ts); modules Providers/Scripts/
Fleet/Reverify. **DF3.4 should add to `EXTENSION_NAMESPACES` and call `set()` — never change
`set`/`setLocked`/`validateExtensions` semantics.**

**G11 — the CLI already has a generic ext writer.** `scripts/run-record.ts:95-114` (`applyExt`)
parses `--ext <ns>.<field>=<value>`, coerces `int` off `EXTENSION_NAMESPACES[ns].fields[field]`, and
lets the store be the authority on the allow-list. Its regex is `^([A-Za-z0-9]+)\.([A-Za-z0-9]+)=(.*)$`
— note it accepts arbitrary values including free text. If DF3.4 wants a CLI escape hatch it exists;
if DF3.4 wants approval writes to be *only* via the guarded verb, note that this hatch is already
open.

**G12 — known, accepted holes to not re-litigate.** `atomicReplace` does not fsync the dir entry
(:1807-1812); `putBack` failure can leave the lock path vacated with the body parked at
`.orphan.<pid>.<hex>` and a `lock.not-restored` log line, recoverable only by hand (:1652-1671,
:1774-1785); `cleanStaleTemps` sweeps only names matching `RUN_RECORD_TEMP_RE` (:361) and never
`.lock` files; pid reuse can spare a stale temp (:962-964).
