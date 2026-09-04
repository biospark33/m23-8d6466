# BLIND HUNTER REVIEW: fleet-lock diff

### [HIGH] TOCTOU: directory permission validation window

**File:** `src/fleet/fleet-lock.ts`, lines 459-473

**Trigger:** Attacker with directory write access races between `mkdirSync`/`chmodSync` and `statSync` validation.

```typescript
mkdirSync(dir, { recursive: true, mode: 0o700 });
chmodSync(dir, 0o700);
const dirMode = statSync(dir).mode & 0o777;
if (dirMode !== 0o700) {
  throw new FleetError(...);
}
```

Between `chmodSync` and `statSync`, an attacker can `chmod 0755` the directory. The `statSync` reads 0755, but the code continues and uses the directory. This is the classic check-then-act race — the validation is disconnected from the usage. The throw that should prevent execution never fires because the attacker changes the mode AFTER the check.

The `mkdirSync` with `mode: 0o700` is unreliable per POSIX (mode is masked by umask and ignored when directory exists), but the follow-up `chmodSync` is correct. The problem is the validation TOCTOU.

This mirrors the DF3.1 fix in `FanoutRecordStore` but the same pattern exists here.

---

### [HIGH] Signal handler crash: incomplete listener restoration on exception

**File:** `src/fleet/fleet-lock.ts`, lines 323-328

**Trigger:** A re-added listener throws during the `process.on(sig, listener)` call.

```typescript
try {
  process.kill(process.pid, sig);
} finally {
  for (const listener of others) process.on(sig, listener as () => void);
}
```

If ANY `process.on(sig, listener)` throws (unlikely but not impossible — e.g., out of memory during listener registration), the remaining listeners are NOT restored. The signal is left with only `onSignal` removed but other listeners still stripped. Subsequent signals will have incomplete handler sets.

Fix: wrap each `process.on` in its own try-catch so one failure doesn't prevent restoration of the rest.

---

### [MEDIUM] Negative `createdAt` silently treated as ancient

**File:** `src/fleet/fleet-lock.ts`, lines 793-794

**Trigger:** Body with `createdAt: "-1"` or any negative timestamp.

```typescript
const at = Date.parse(body.createdAt);
const aged = Number.isFinite(at) && Date.now() - at > FLEET_LOCK_STALE_MS;
```

If `at = -1` (negative timestamp), then `Date.now() - (-1) = Date.now() + 1`, which is way larger than `FLEET_LOCK_STALE_MS`. The body is treated as ancient and reclamation proceeds if the pid is dead. Negative timestamps are NOT rejected — `Number.isFinite(-1)` is true, and `Date.parse("-1")` actually returns a valid negative timestamp in some JS environments.

The fix for `pidStartTime` (line 730) guards with `Number.isFinite(parsed.pidStartTime)` but doesn't explicitly reject negative values. For `createdAt`, there's no such check.

**Impact:** An attacker who can craft a lock body with a negative `createdAt` can make it appear ancient, accelerating reclamation. However, the reclamation still requires dead pid or identity mismatch, so this is MEDIUM not HIGH.

---

### [MEDIUM] Negative `pidStartTime` passes validation

**File:** `src/fleet/fleet-lock.ts`, line 730

**Trigger:** Body with negative `pidStartTime` like `-1000`.

```typescript
Number.isFinite(parsed.pidStartTime)
```

`Number.isFinite(-1000)` returns true. The value passes validation and reaches the identity comparison at line 831. A negative start time is physically impossible but not explicitly rejected.

**Impact:** The identity comparison would likely fail (real start times are positive), so this would classify as reclaimable if pid is dead. But if by some chance a real pid had that exact negative value (impossible), the comparison would pass. This is more about strictness — the validator should reject timestamps outside `[0, Date.now() + reasonable_slew]`.

---

### [LOW] `pidIsZombie` failure treated as "not zombie" (fail-open for death detection)

**File:** `src/fleet/fleet-lock.ts`, line 247

**Trigger:** `/proc/[pid]/stat` read fails (EACCES, EIO) or `ps` command fails.

```typescript
} catch {
  return false; /* dp:ok a failed probe proves nothing — fail toward "not a zombie" */
}
```

The comment says this is intentional, but this is fail-OPEN for zombie detection. A zombie that can't be observed is treated as alive, which blocks reclamation. The "fail closed" philosophy elsewhere in the code would argue: if we can't prove it's NOT a zombie, we should NOT reclaim based on liveness alone.

However, the redeeming factor is line 806: reclamation requires BOTH `!isAlive || pidIsZombie`. So if `pidIsZombie` fails but returns false (treated as "not zombie"), and `isAlive` returns false (provably dead), reclamation still proceeds. The only blocked case is when `isAlive` returns true (kill succeeds) but `pidIsZombie` fails to read the zombie status. In that case, the process IS alive (kill succeeded) but we can't tell if it's zombie. That's actually safe — if kill(pid, 0) succeeds, the process exists; whether it's zombie or not matters less for reclamation purposes.

So this is LOW — the design is defensive enough that this fail-open doesn't create a BLOCKER.

---

### [LOW] No upper bound on `createdAt` timestamp

**File:** `src/fleet/fleet-lock.ts`, line 793

**Trigger:** Body with `createdAt: "9999999999999"` (far future timestamp).

```typescript
const at = Date.parse(body.createdAt);
const aged = Number.isFinite(at) && Date.now() - at > FLEET_LOCK_STALE_MS;
```

A far-future `createdAt` makes `Date.now() - at` negative, which is NOT greater than `FLEET_LOCK_STALE_MS`. The body is treated as fresh and refuses reclamation. An attacker can create a lock that appears fresh forever by using a far-future timestamp.

**Impact:** A malicious or buggy actor can create a lock that never ages out, permanently blocking reclamation. The body would still refuse with "fleet-busy" but would never become reclaimable. However, this requires the attacker to write a file, which they'd need permissions for. If they have file write permissions, they can DoS the system in many ways. So this is LOW not HIGH.

The `pidStartTime` has the same issue but is mitigated by identity comparison.

---

### [LOW] Regex accepts invalid day-of-month values

**File:** `src/fleet/fleet-lock.ts`, lines 202-204

**Trigger:** `ps -o lstart=` output like "Feb 99 12:34:56 2026" (day 99).

```typescript
/^[A-Za-z]{3} ([A-Za-z]{3})\s+(\d{1,2}) (\d{2}):(\d{2}):(\d{2}) (\d{4})$/
```

`\d{1,2}` accepts 00-99, but valid day-of-month is 1-31. The values are passed to `new Date(year, month, day, ...)` which may normalize invalid values or produce garbage.

**Impact:** If `ps` outputs malformed data (due to exotic locale or system bug), the code produces an invalid `localMs` for identity comparison. This would cause identity mismatch and spuriously reclaim a live lock. However, this requires `ps` to be broken or locale to be exotic, which is an environment issue not an attacker-controlled scenario. Still, the regex should constrain to valid ranges.

---

### [LOW] `fsyncDir` errors silently ignored

**File:** `src/fleet/fleet-lock.ts`, lines 847-858

**Trigger:** Directory fsync fails for any reason.

```typescript
function fsyncDir(dir: string): void {
  let dfd: number | undefined;
  try {
    dfd = openSync(dir, "r");
    fsyncSync(dfd);
  } catch {
    // Not every platform/filesystem permits fsync on a directory handle
  } finally {
    if (dfd !== undefined) closeSync(dfd);
  }
}
```

All errors are swallowed, including legitimate ones like ENOSPC (disk full) or EIO (I/O error). The comment says this is intentional because not all platforms allow directory fsync. But this means real durability failures are silent.

**Impact:** If fsync fails for a real reason (not just platform incompatibility), the lock may not be durable across crashes. The claim succeeds but the lock file might not be on stable storage. However, the `claim()` primitive from `run-lock.ts` already fsyncs the temp file before linking, so the directory fsync is an extra safety measure. And if the filesystem doesn't support it, there's nothing better to do. So this is LOW — the code documents the tradeoff and the underlying claim is still safe.

---

### [LOW] Potential leak in `fsyncDir` on `openSync` failure

**File:** `src/fleet/fleet-lock.ts`, lines 847-858

**Trigger:** `openSync(dir, "r")` succeeds but a subsequent throw occurs before `closeSync`.

In the current code, `openSync` is the first statement in the try block. If it succeeded, `dfd` is set. The only subsequent operation is `fsyncSync(dfd)`. If `fsyncSync` throws, the finally block closes `dfd`. So there's no leak.

BUT: if a future edit adds code between `openSync` and `fsyncSync`, and that code throws, the leak is introduced. This is fragile. The code would be more robust with:

```typescript
try {
  dfd = openSync(dir, "r");
} catch {
  return;
}
try {
  fsyncSync(dfd);
} finally {
  closeSync(dfd);
}
```

This is LOW because the current code is correct, but it's fragile to future edits.

---

## NO FINDINGS on:

- **Integer overflow in pid comparisons**: The code checks `> 0x7fff_ffff` which is correct for signed 32-bit pid limits.
- **Off-by-one in loop bounds**: The retry loop `attempt < 2` is intentional (2 attempts max).
- **Signal handler reentrancy**: The `fleetUnwinding` guard prevents recursive releases.
- **Zombie detection TOCTOU**: Between `isAlive` and `pidIsZombie`, the process could exit and be reaped, but the code handles this correctly (reclaim if EITHER condition true).
- **Empty requestId**: Lines 417-424 explicitly check for and reject empty string.
- **Null/undefined requestId**: The `typeof` check plus `=== ""` covers string type; null/undefined become `"object"`/`"undefined"` and fail the first check.
- **Race between `claim()` and `classifyHolder()`**: The verdict system and retry loop handle this correctly.
- **Race between reclamation and new claim**: The reap mutex serializes this, and the `removeIfUnchanged` guard deletes only the judged bytes.
