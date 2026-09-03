# Blind Lock Review — Round 5

## HIGH Severity

### [HIGH] Signal handler TOCTOU on fleetUnwinding flag
**File: src/fleet/fleet-lock.ts:317-319**

**Trigger:** Two signals (e.g., rapid SIGINT, SIGINT) arrive between the check on line 317 and the set on line 318.

**Evidence:**
```typescript
if (fleetUnwinding) return;
fleetUnwinding = true;
```

This is a classic check-then-act race. JavaScript signal handlers are NOT serialized, and the flag check/set is NOT atomic. Two SIGINTs arriving < 1ms apart can BOTH see `fleetUnwinding === false` before either sets it to true, causing `releaseHeldFleetLocks()` to execute concurrently on the same `fleetHeld` map. The map iteration/deletion on line 274-275 (`[...fleetHeld]` then `delete`) has no mutual exclusion, so deletions can race and the map can be left in an inconsistent state.

**Concrete scenario:**
1. Process runs fanout, holds lock at `.sandbox/fleet.lock`
2. User hits Ctrl-C twice rapidly (< 1ms between keystrokes)
3. First SIGINT handler enters, checks `fleetUnwinding` (false), is interrupted by scheduler
4. Second SIGINT handler enters, checks `fleetUnwinding` (still false), both proceed
5. Both call `releaseHeldFleetLocks()` concurrently, iterating over same map
6. Map corruption / lock not released / orphan left on disk

**Fix:** The flag check/set needs atomic test-and-set. JavaScript has no atomic flag primitive. Options:
- Use Atomics on a SharedArrayBuffer (but this may not work in all JS environments)
- Or more simply: make `fleetUnwinding` an incrementing counter and check `if (fleetUnwinding++ !== 0) return;` — still racy but reduces the window
- Best: use a single signal handler that debounces (Node's `signal` API with `once: true`) rather than manual flagging

### [HIGH] Signal handler re-adds concurrently executing listeners
**File: src/fleet/fleet-lock.ts:320-326**

**Trigger:** A signal handler (SIGTERM) is running its onSignal function concurrently with a SIGINT handler that hits line 322's `removeListener`.

**Evidence:**
```typescript
const others = process.listeners(sig);
for (const listener of others) process.removeListener(sig, listener as () => void);
```

The code removes ALL listeners for the signal type SIGINT from the list. If a SIGTERM handler is concurrently executing its own re-raise sequence at that exact moment, its own `onSignal` will be in `others` and will be removed mid-execution. When line 326 re-adds all listeners from `others`, the SIGTERM handler is restored, but the removal of a live handler can cause state corruption.

**Concrete scenario:**
1. SIGTERM arrives, its onSignal starts executing
2. Before SIGTERM hits its own line 322, SIGINT arrives
3. SIGINT's onSignal calls `process.listeners("SIGINT")`, which includes a borrowed SIGTERM listener if it was added earlier
4. SIGINT removes all listeners including the one SIGTERM borrowed
5. SIGTERM's onSignal is now running as a removed listener — its state is corrupt
6. When SIGTERM tries to re-add listeners, it may re-add an already-added listener or fail to add its own

**Fix:** Each signal type should have its own dedicated handler that does not touch other signal types' listeners. The borrow-strip-reraise pattern is fundamentally unsafe when multiple signals can interleave.

## MEDIUM Severity

### [MEDIUM] Dead code: lstartUtcMs is never used but calculated on every identity probe
**File: src/fleet/fleet-lock.ts:224**

**Trigger:** Every psLstartIdentity call (line 197-226) calculates `lstartUtcMs` but it's only recorded, never compared in identity checks.

**Evidence:**
```typescript
lstartUtcMs: Date.UTC(Number(m[6]), month, Number(m[2]), Number(m[3]), Number(m[4]), Number(m[5]))
```

The comment on line 127 says "RECORDED ONLY, never an identity input" and line 813's comment says "Evidence only; see FleetLockBody.lstartUtcMs." The comment at 218-220 explains why comparing it would be wrong (TZ shift with observer). But it's calculated on every Darwin process start observation, stored in the lock body, and carried through the system. This is dead code that wastes CPU cycles and memory. If the comment says it's never compared, don't calculate it at all.

**Fix:** Remove `lstartUtcMs` from the `PidIdentity` interface, from `psLstartIdentity`, and from `ownFleetLockBody`. The field exists only for human debugging; operators who need it can run `ps -p <pid> -o lstart=` themselves.

### [MEDIUM] Reap mutex steal can spin forever if mutex keeps changing hands
**File: src/fleet/fleet-lock.ts:597-619**

**Trigger:** Multiple processes are racing for the reap mutex, and each successful claim immediately vanishes (holder releases) before we can observe it.

**Evidence:**
```typescript
for (;;) {
  if (claim(this.reapPath, body)) {
    fleetHeld.set(this.reapPath, body);
    return true;
  }
  if (this.stealAbandonedReapMutex()) {
    if (Date.now() >= deadline) return false;
    continue;
  }
  if (Date.now() >= deadline) return false;
  sleepSync(REAP_MUTEX_TICK_MS);
}
```

The loop retries forever until deadline. Line 611-615 calls `stealAbandonedReapMutex()`, and if successful, retries the claim at once WITHOUT sleeping. If the mutex keeps changing hands (process A claims, releases; process B claims, releases; we observe each as abandoned and steal; then claim and immediately release ourselves), we can spin CPU at line 611-616 without ever hitting the sleep on line 618. The deadline bounds this, but at 250ms you can burn a lot of CPU.

**Concrete scenario:**
1. We're trying to reclaim a stale lock, need the reap mutex
2. Process A holds the mutex, we observe and judge it abandoned (dead pid)
3. We steal it (line 611 returns true), immediately try to claim again (line 603)
4. Before our claim(), another process C steals it from us
5. Loop repeats — we're spinning at near-100% CPU until deadline
6. In a fanout with 10+ processes, this can happen repeatedly

**Fix:** After a successful steal and failed claim, ALWAYS sleep at least one tick before retrying. Change line 615's continue to:
```typescript
if (Date.now() >= deadline) return false;
sleepSync(REAP_MUTEX_TICK_MS);
continue; // moved the sleep here
```

## LOW Severity

### [LOW] CLK_TCK hardcoded 100 with comment "revisit only if symptom"
**File: src/fleet/fleet-lock.ts:147-150**

**Trigger:** Code runs on a kernel with USER_HZ != 100 (e.g., some ARM kernels, some containerized environments).

**Evidence:**
```typescript
/**
 * Linux USER_HZ. `/proc/<pid>/stat`'s starttime is in clock ticks and no
 * runtime exposes `sysconf(_SC_CLK_TCK)`; every mainstream kernel ships 100.
 * ponytail: hardcode 100 — revisit only if a kernel with a different USER_HZ
 * ever runs this code, where the symptom would be sub-second reclaim drift.
 */
const CLK_TCK = 100;
```

The ponytail comment says "revisit only if symptom" but this is a silent correctness bug. If CLK_TCK is actually 1000 on some system, `Math.floor((ticks / 100) * 1000)` on line 191 converts wrong units — you'll read start times ~10x off and mis-identify live processes as recycled. The "sub-second reclaim drift" symptom is vague; the actual failure is "steal locks from live holders."

**Fix:** Read `/proc/sys/kernel/user_hzhelper` or expose CLK_TCK via a configurable override. Or at minimum, log a warning on first use if the calculated start time looks suspicious (e.g., > current time).

## Summary

- 2 HIGH: signal handler race conditions
- 2 MEDIUM: dead code, CPU spin
- 1 LOW: hardcoded constant
