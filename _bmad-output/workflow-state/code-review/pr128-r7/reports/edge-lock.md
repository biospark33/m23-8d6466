# Edge Case Review: Fleet Lock (src/fleet/fleet-lock.ts)

## NO FINDINGS

All branches and boundaries have been walked. The implementation is correct and fail-closed throughout.

### Verified Edge Cases

**Darwin `ps` lstart parsing (timezone handling)**
- Line 145-177: Uses LOCAL time constructor for identity comparison (`localMs`)
- `lstartUtcMs` is evidence-only, never compared (line 164-177 comment)
- Observer-self-consistent by construction - correct

**Linux /proc/stat field parsing**
- Line 132-143: Correctly handles comm with spaces using `lastIndexOf(")")`
- Field 22 (starttime) at remainder index 19 - correct
- Handles missing btime with throw - correct

**PID range validation**
- Line 142: `isAlive()` returns `true` for out-of-range (fail-closed)
- Line 779-788, 888: Range guards refuse unknown pids, never reclaim
- NaN/Infinity caught by `Number.isInteger()` - correct

**Module-level mutable state**
- Line 202-204, 252-254: `fleetHeld`/`fleetDestructive` are module-level
- Signal handlers idempotent via `fleetSignalsInstalled` latch
- Multiple FleetLock instances safely share process state
- run-lock.ts has separate state, no interference - correct

**Signal handler contract**
- Line 263-284: Proper borrow-strip-reraise dance
- Handles re-raise failure case (line 225-240) - correct

**Numeric boundary values**
- `pidStartTime`: Line 680 checks `Number.isFinite()`, line 890-891 refuses non-finite
- Empty requestId: Line 417-423 throws before any fs op - correct
- Missing optional fields: Line 738-744 conditional copy - correct

**Malformed JSON lock bodies**
- Line 672-699: Parse failure → refuse, never steal - correct fail-closed

**Lock file permissions**
- Line 410-423: Directory verified 0o700
- Line 646-656: claim() uses 0o600 mode
- Release refuses if body mismatched - best effort under POSIX

**Stale lock detection**
- Line 744-757: Two-part test (age + liveness/death) - correct

**Concurrent reclaim TOCTOU**
- Line 434-467: Reap mutex serializes verify+remove
- Line 457-462: Re-reads before unlink, compares exact bytes - correct

**Empty requestId**
- Line 417-423: Constructor throws before fs op - correct (round-6 fix)

**Recycled PID detection**
- Line 759-782: Compares `localMs` consistently (LOCAL time on both sides)
- Does NOT use `lstartUtcMs` for identity - correct

### Conclusion

No BLOCKER, HIGH, or MEDIUM issues found. All edge cases are properly handled with fail-closed semantics.
