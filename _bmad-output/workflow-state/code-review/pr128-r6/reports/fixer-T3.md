# T3 Test Hardening Fix Report

## Summary
All 5 T3 findings addressed. Tests pass, biome clean.

## Changes Made

### T3a [MEDIUM] `deadPid()` hardening (helpers.ts:164)
**Issue**: `await proc.exited` doesn't guarantee pid is fully reaped on loaded hosts.
**Fix**: Import `isAlive` from `scripts/lib/run-lock.ts` and poll up to 100ms (10×10ms).
**Rationale**: Ponytail-style minimal fix - bounded poll with informative error if budget exceeded.

### T3b [LOW] `armRows()` type guard (cli.test.ts:4393)
**Issue**: Bare JSON.parse cast on stdout lines could silently accept malformed data.
**Fix**: After parse, assert required properties with `expect(row).toHaveProperty(...)`.
**Rationale**: Malformed lines now fail with clear message about which property is missing.

### T3c [MEDIUM] Wedged lock cleanup (cli.test.ts:5066)
**Issue**: `rmSync` lock cleanup in test body could leak into later tests on early failure.
**Fix**: Wrap in try/finally with unconditional cleanup in finally block.
**Rationale**: Lock cleanup guaranteed regardless of test outcome.

### T3d [LOW] Tuple destructuring order (cli.test.ts:3930)
**Issue**: Destructure before length assertion could access undefined elements.
**Status**: **NO CHANGE NEEDED** - Code already has `expect(lines).toHaveLength(3)` on line 3929, destructuring on 3930. Order is correct.

### T3e [LOW] `liveChild()` orphaning (helpers.ts:171 + consumers)
**Issue**: Failure between spawn and push could orphan sleep process.
**Status**: **NO CHANGE NEEDED** - All three consumers in fleet-lock.test.ts (lines 76, 99, 122) already use push-immediately pattern.

## Verification
```bash
$ bun test tests/fleet/cli.test.ts
135 pass, 0 fail, 28.33s

$ bun test tests/fleet/dispatch.test.ts
128 pass, 0 fail, 12.78s

$ bun test tests/fleet/fleet-lock.test.ts
3 pass, 0 fail, 224ms

$ bunx biome check tests/fleet/helpers.ts tests/fleet/cli.test.ts
Checked 2 files in 104ms. No fixes applied.
```

## Verdicts
- T3a: FIXED - deadPid now polls isAlive with 100ms budget
- T3b: FIXED - armRows validates parsed shape
- T3c: FIXED - Wedged lock cleanup in finally block
- T3d: NO-FIX - Already correct order
- T3e: NO-FIX - Already uses safe pattern

## Files Modified
- `/Users/steve/QDS-Factory/tests/fleet/helpers.ts` (T3a)
- `/Users/steve/QDS-Factory/tests/fleet/cli.test.ts` (T3b, T3c)
- dispatch.test.ts: Owned but no changes needed
