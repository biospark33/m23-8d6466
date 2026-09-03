# R1 — Bun runtime APIs for fleet fanout (DF3.2)

Track A research. Repo facts are binding (file:line); platform facts confirmed by
local probes under **Bun 1.4.0 / macOS (darwin 22.6)** or cited to docs.

---

## 1. File locking without flock — O_EXCL creation, mode 0600, atomic replace

### Repo precedent (binding — reuse these shapes, do not invent new ones)

**Exclusive create** — everywhere the repo needs "fail if exists", it is
`openSync(path, "wx", 0o600)` via node:fs, never a check-then-write:

| Site | Call |
|---|---|
| `src/providers/run-record.ts:890` (`createUnlogged`, INV-3 no-overwrite) | `fd = openSync(p, "wx", 0o600)`; retry once through `clearCreateTombstone` on EEXIST (:896-897) |
| `src/providers/run-record.ts:1188` (`claimLock`) | tmp file `"wx"` + `writeFileSync(fd, body)` + `fsyncSync(fd)` + `linkSync(tmp, lock)` — lock body COMPLETE at publish instant |
| `src/providers/run-record.ts:1474` (`atomicReplace`) | tmp `"wx"`, write, `fsyncSync(fd)`, `renameSync(tmp, p)` |
| `src/providers/reaper.ts:770` | `writeFileSync(report.reportFile, json, { mode: 0o600, flag: "wx" })` — one-shot exclusive write |
| `src/providers/harvest.ts:1055` | `fd = openSync(target, "wx", 0o600)` |
| `src/hindsight/bank-provisioner.ts:168` (`acquireLock`) | `openSync(path, "wx")`; EEXIST → stale-recovery path |
| `src/phase-engine/journal.ts:181` | flags form: `O_WRONLY \| O_CREAT \| O_EXCL \| O_NOFOLLOW` |

Confirmed semantics (probed locally + proven in-tree by
`src/providers/run-record.ts:758-789` `assertExclusiveCreateSupported`):
- `'wx'` = `O_WRONLY|O_CREAT|O_EXCL`. Second open of an existing path throws
  with `.code === "EEXIST"` (run-record.ts:771-775 asserts exactly this at store
  construction; bank-provisioner.ts:167 comment: "throws EEXIST if the file already exists").
- Mode arg works: `statSync(probe).mode & 0o777 === 0o600` asserted at
  run-record.ts:764-767 (refuses to start if umask defeats 0600).

**Atomic replace (write-temp-then-rename)** — canonical shape is
`RunRecordStore.atomicReplace` (`src/providers/run-record.ts:1470-1505`):
1. `tmp = ${p}.${process.pid}.${randomBytes(4).toString("hex")}.tmp` (pid-stamped so stale sweeps are concurrency-safe)
2. `openSync(tmp, "wx", 0o600)`
3. `writeFileSync(fd, ...)` (loops until whole buffer lands — a bare `writeSync` can short-write, :900-902)
4. `fsyncSync(fd)`
5. clear fd-open flag BEFORE `closeSync(fd)` ("a throwing close still consumes the descriptor", :1483-1486)
6. optional `beforeRename?.(tmp)` hook, then `renameSync(tmp, p)`
7. catch: guarded close + `rmQuiet(tmp)`, rethrow original error

Note `rename` does NOT persist the directory entry; `create()` additionally
calls `fsyncDir(dir)` best-effort (`src/providers/run-record.ts:1782-1796`),
while `set()` deliberately does not (ponytail note at :1489-1494).

**Lock-with-body publish**: `claimLock` (`run-record.ts:1171-1223`) prefers
tmp→`linkSync` over tmp→`renameSync` because `link` is as exclusive as O_EXCL
but the body is complete the instant the path exists (avoids the empty-body
steal window described at :1178-1182). `scripts/lib/run-lock.ts:550` (`claim`)
is the hardened version: host-tagged temp name (`hostTag()`,
run-lock.ts:120), fsynced body, EEXIST→`claimedByUs` reentrancy check,
EPERM/EOPNOTSUPP/ENOSYS fallback to `writeLockDirect`
(`openSync(lock,"wx")` + write, run-lock.ts:618).

**Stale-lock recovery** (no flock): `src/hindsight/bank-provisioner.ts:161-238`
— on EEXIST read holder pid from body + stat mtime; dead pid OR age ≥
`LOCK_STALE_MS = 300_000` (:130) → unlink + retry once; otherwise return null
(caller reports `provision_in_progress`). Non-parseable/non-positive pid →
treated STALE (:232-236).

**Blocking wait without flock**: `RunRecordStore.withLock` spins with
`sleepMs` (`Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)`,
run-record.ts:1667-1669 — sync-thread sleep) bounded by
`LOCK_TIMEOUT_MS = 5_000` (run-record.ts:225), stealing when the owner is gone.

**Bun.file is NOT used anywhere in `src/` or `scripts/` for writes** (grep:
zero hits for `Bun.file`/`Bun.write` in those trees). `BunFile.writer()` offers
no exclusive-create mode, so repo precedent is exclusively node:fs sync APIs.
Fanout should do the same.

### Design implication for DF3.2

Per-child-task lock files: copy `bank-provisioner.acquireLock`'s shape
(O_EXCL open + pid-in-body + mtime-age/dead-pid stale recovery) if contention
should be refused-fast, or `withLock`'s spin if it should queue. Never
check-then-create.

---

## 2. Reading another process's start time

### darwin: `ps -o lstart= -p <pid>` (verified locally)

```
$ ps -o lstart= -p $$
Sun Aug 23 11:19:13 2026
```

Format is ctime-style: `%a %b %e %H:%M:%S %Y` — day-of-month space-padded,
NO timezone field. Locale-dependent via `LC_TIME` under a non-C locale; the
repo already treats this output as an operator-facing diagnostic, not a parsed
field: `scripts/lib/run-lock.ts:452` embeds
`ps -p ${pid} -o lstart=,args=` in its refusal message and compares against
`new Date(at).toISOString()`. For machine comparison prefer parsing with a
manual month map rather than `Date.parse` (the string lacks TZ and `Date.parse`
behavior on it is implementation-defined).

There is no `/proc` on darwin; `ps -o lstart=` (or `ps -o etime=` for elapsed)
is the interface.

### Linux: `/proc/<pid>/stat` field 22

Cited: proc_pid_stat(5), https://man7.org/linux/man-pages/man5/proc_pid_stat.5.html —

> `(22) starttime %llu` … "The time the process started after system boot."
> "expressed in clock ticks (divide by sysconf(_SC_CLK_TCK))"

- Units: clock ticks since boot; USER_HZ is 100 on every supported arch
  (`sysconf(_SC_CLK_TCK)`), i.e. 10 ms resolution. Documented fields run 1..52.
- Indexing: fields 1..52 are 1-based; `comm` is field 2 and MAY contain spaces
  and parentheses (kernel truncates to TASK_COMM_LEN=16 incl. NUL). Robust
  parsers split after the LAST `)` — everything after is field 3 onward:

```ts
const after = raw.slice(raw.lastIndexOf(")") + 2).split(" "); // after[0] = state (field 3)
const starttimeTicks = Number(after[19]);                     // field N ⇒ after[N-3]
```

- Wall-clock conversion: `bootEpochSeconds` from `btime` line of `/proc/stat`,
  then `epochSecs ≈ btime + floor(starttimeTicks / CLK_TCK)`. (Standard procps
  formula; the btime source is not on the proc_pid_stat page.)

Zombie caveat: a zombie child still has `/proc/<pid>/stat` (state `Z`) and
still answers `ps -o lstart=`, so start-time evidence alone does not prove
liveness — see §3.

### Why start time at all

PID recycling: `scripts/lib/run-lock.ts:452` documents the exact failure — a
SIGKILLed holder's pid gets recycled onto an unrelated process; comparing the
recorded lock timestamp against the observed process start time distinguishes
recycled-pid from live-holder. Fanout should record `createdAt` next to the pid
in any lock/lease body and apply the same test.

---

## 3. `process.kill(pid, 0)` signal-0 liveness probe in bun

Repo implementations (three near-duplicates, all module-private):

- `src/providers/run-record.ts:1799-1806` `isAlive(pid)` — try kill(pid,0) → true; catch → `code !== undefined && code === "EPERM"` treated as alive (i.e. returns `code === "EPERM"`).
- `src/hindsight/bank-provisioner.ts:141-148` `isPidAlive(pid)` — returns `code !== "ESRCH"` (any throw that isn't ESRCH → alive).
- `scripts/lib/run-lock.ts:138-147` `isAlive(pid)` — THE FAIL-CLOSED ONE: rejects `!Number.isInteger || pid <= 0 || pid > 0x7fff_ffff` up front (returns alive/unprovable), then `code !== "ESRCH"`. Its docstring: "`process.kill(1e11, 0)` throws `ERR_OUT_OF_RANGE` — not an errno at all — and pid 0 signals the whole process group… ESRCH is the only proof of death there is."

Local probes under Bun 1.4.0 confirm and extend this:

| Call | Result | Meaning |
|---|---|---|
| own live child (`Bun.spawn(["sleep","30"])`) | ok | exists, ours |
| `process.kill(1, 0)` | throws `EPERM` | exists, not ours → ALIVE |
| `process.kill(999999, 0)` | throws `ESRCH` | no such process → DEAD |
| `process.kill(1e11, 0)` | throws `ERR_INVALID_ARG_TYPE` (**not** an errno; node names it `ERR_OUT_OF_RANGE` per run-lock.ts:141) | runtime validation error — must be classified "alive" or the probe crashes |
| `process.kill(0, 0)` | ok | signals caller's OWN PROCESS GROUP (hazard documented at run-record.ts:818-820 — never feed an unparsed pid) |

**Zombie finding (changes design):** immediately after `proc.kill()` on our own
child, `process.kill(proc.pid, 0)` still returned **ok** — the exited-but-
unreaped child answers signal 0 until its parent reaps it (or the runtime
reaps on `exited`). A fanout liveness check must consult the spawn object's
exit promise FIRST (`Bun.spawn().exited` / `proc.exitCode`) and only fall back
to signal-0 for pids we did not spawn ourselves. This is why
`src/providers/fake-driver.ts:409-443` gates group SIGKILL behind an ESRCH-only
proof and never signals `-pid` unless the number is provably unowned.

Design rule (matches all three repo copies): **only ESRCH proves death;
everything else — EPERM, range/validation errors, unknown errnos — is
"cannot prove dead" ⇒ treat as alive.**

---

## 4. Concurrent child-task execution primitives in the repo

### What exists today

**No fanout executor exists yet** — current `fleet dispatch` runs its steps
sequentially. The building blocks:

1. **Shared budget helper — `src/providers/timeout.ts` (whole file, 57 lines).**
   Exports:
   - `export const LIST_TIMEOUT_MS = 15_000;` (:10) — shared per-call enumeration budget.
   - `export class TimeoutError extends Error` (:25-37) — ctor `(what: string, ms: number)`; readonly `what`, `ms`. Deliberately NO `code` property (:21-24) because reaper reads `err.code ?? "<unit>-failed"`.
   - `export async function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T>` (:46-57) — attaches `void p.catch(() => {})` to the losing promise BEFORE racing (kills late unhandled rejection), `Promise.race([p, timer])`, clears timer in `finally`.
   - Importers: `src/providers/reaper.ts:52` (`LIST_TIMEOUT_MS, withTimeout` — sweep + per-unit ops), `src/providers/driver.ts:22` (`TimeoutError, withTimeout`).

2. **Fleet's own budget-aware race** — `within(step, work, describeLate?)`
   closure inside `fleetDispatch` (`src/fleet/dispatch.ts`, signature block
   ending :940, body :1000-1071). Differences vs `withTimeout`: takes a THUNK
   not a promise (expired ⇒ never started), computes remaining budget via
   `remaining()`, marks `abandoned`, logs BOTH late settlements
   (`abandoned-step-succeeded` / `abandoned-step-failed`, :1038-1054) with
   free-text thunks evaluated inside the guard. Docstring rationale at
   :940-1009 ("race-and-abandon… no AbortSignal on the provider seam").

3. **Status verb's simpler version** — `listWithTimeout(driver, timeoutMs, name?)`
   (`src/fleet/status.ts:186-201`): plain race against a cleared-on-finally
   timer; default 30 s enforced by `resolveTimeoutMs` (:168-180, refuses
   non-positive).

4. **Tests' concurrency idiom** — two dispatches raced with
   `Promise.allSettled([...])` behind a barrier promise
   (`tests/fleet/dispatch.test.ts:1346-1352`), winners/losers split off
   `settled.filter(s => s.status ...)`. Also `Promise.all([proc.exited, readCapped(stdout), ...])`
   for child-process teardown ordering (`tests/fleet/cli.test.ts:1223,1240,...`)
   and `Promise.race([pending, tick])` for deadline assertions
   (`tests/fleet/cli.test.ts:285`).

### Pattern for DF3.2 fanout

Nothing to import gives parallel-until-deadline over heterogeneous tasks; the
compose is: `tasks.map(t => withTimeout(t.run(), perTaskMs, t.what))` →
`Promise.allSettled` → classify settled results (fulfilled / rejected +
`TimeoutError` vs other). If per-task results must not leak unhandled
rejections past their own settlement, keep `withTimeout`'s pre-race
`void p.catch(() => {})` discipline (it is load-bearing, see timeout.ts:41-44).

---

## Source index

Repo: paths/lines inline above. Platform:
- proc_pid_stat(5) starttime/units: https://man7.org/linux/man-pages/man5/proc_pid_stat.5.html
- `ps -o lstart=` format + `process.kill(pid,0)` errno table + zombie behavior: probed locally on this machine (bun 1.4.0, commands in conversation transcript, 2026-08-23).
