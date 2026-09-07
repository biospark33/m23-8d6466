# Edge Case Review: Fleet Lock + Fanout Store

## Method
Walked every branching path and boundary condition listed in the task, verified each against actual source at `/Users/steve/QDS-Factory`.

## Findings

NO FINDINGS

All candidate edge cases from the task are already handled by the implementation:

### Empty/absent lock body fields
- **Handled**: `classifyHolder` (fleet-lock.ts:658-683) validates body shape before any judgment
- Missing `pidStartTime`, `pid`, `createdAt`, or `requestId` → body === undefined → refused with "fleet-busy, cannot judge holder"
- NaN pid caught by range guard (line 713)
- Negative `createdAt` parses to finite timestamp, treated as "young" (fail closed)

### Boundary: lock exactly 1h old
- **Handled**: Line 728 uses `>` not `>=`: `Date.now() - at > FLEET_LOCK_STALE_MS`
- Exactly 3600000ms old is NOT considered stale

### Boundary: owner dies between check and reclaim
- **Handled**: Reap mutex serialization (lines 434-451)
- `acquireReapMutex()` takes `<path>.reap` before verify+rm
- Only one reclaimer can be in the critical section at a time
- Mismatch on re-read causes retry, not blind unlink

### Boundary: pid reused with different start time
- **Handled**: Identity comparison at line 765: `observed.localMs === body.pidStartTime`
- Recycled pid fails identity test → reclaimed ONLY if also aged > 1h

### Boundary: own-pid reentrant acquire
- **Handled**: Lines 387-394 check `fleetHeld.has(this.path)` before claim
- Throws `fleet-lock-reentrant` error

### Boundary: own-pid reentrant acquire then throw mid-critical-section
- **Handled**: Destructive mark (lines 367-374, 508-512) prevents release after teardown begins
- Signal handler `releaseHeldFleetLocks` (line 223) respects mark and refuses to release

### Clock skew / system time jump
- **Handled**: 
  - Line 726-728: Unparseable `createdAt` yields NaN → treated as "young" (fail closed)
  - Future-dated clocks acknowledged in run-lock.ts but not a steal vector here

### TOCTOU on /proc or ps liveness probe
- **Handled**: Two-part reclaim requires BOTH conditions:
  1. Age > FLEET_LOCK_STALE_MS (line 728)
  2. Owner dead OR identity mismatch (lines 740, 765)
- Liveness check is ONE part of the conjunction, not the sole gatekeeper

### Orphan parking path collision
- **Handled**: Orphan suffix is `.orphan.{pid}.{hex}` (line 301)
- Sweep predicates target `.tmp` patterns (line 297 comment)
- No collision by design

### SIGINT during release / O_EXCL create / atomic replace
- **Handled**: 
  - Signal handlers installed at line 262 (`installFleetSignalRelease`)
  - `releaseHeldFleetLocks` (line 223) processes all held locks on signal
  - `atomicReplace` in fanout.ts uses temp+rename pattern (lines 241-261) which is crash-safe

### atomicReplace edge cases
- **Handled**: Lines 241-261 in fanout.ts
  - Creates temp with O_EXCL
  - Writes, fsyncs, closes
  - Only then renames over target
  - Cleanup on any error

### Store: arm appended while lock file deleted
- **Handled**: 
  - `mutate()` (fanout.ts:178-200) takes lock before read-modify-write
  - Lock uses `acquireRunLock` from run-lock.ts
  - Lock-protected critical section prevents concurrent modification

### Store: record dir mode not enforced when pre-existing
- **Handled**: Lines 132-136 in fanout.ts
  - `chmodSync(this.dir, 0o700)` called AFTER mkdir, even if dir existed
  - Verification at lines 133-136 throws if mode !== 0o700

### Concurrent same-requestId reentrancy from two processes
- **Handled**: 
  - `fleetHeld` map is per-process (fleet-lock.ts:201)
  - Each process maintains its own held set
  - Two processes with same requestId are treated as separate contention cases
  - The lock file serialization prevents concurrent access regardless of requestId

## Verification
All paths traced through actual source code at:
- `/Users/steve/QDS-Factory/src/fleet/fleet-lock.ts`
- `/Users/steve/QDS-Factory/src/fleet/fanout.ts`
- `/Users/steve/QDS-Factory/scripts/lib/run-lock.ts`

No unhandled edge cases found.
