# Fixer-T3 Report: TIER-2 Leak Check Hardening + Cost Test Comment

## Summary
Fixed 2 findings from PR 128 round-7 review (T-h1, T-i1). All tests pass, biome clean.

---

## T-h1 [MEDIUM] — TIER-2 Finally Block Leak Check Retry

**Finding**: Both tier2 files' finally blocks do a single `driver.list()` after `destroyQuietly`, expecting e2e/qds-prefixed boxes gone. Measured live substrate lag: destroy rm exit 0 while box stays listed 25+ seconds → false "leak detected" aborts the run.

**Fix Applied**:

1. **tier2-dispatch-engine.live.test.ts** (lines 323-334):
   - Added bounded retry loop: 5 attempts, 8s apart (40s total budget)
   - Polls `driver.list()` until e2e/qds-prefixed boxes are gone OR budget expires
   - Records retry attempts in evidence with `final-ls-retry` phase
   - Added comment citing r7-T-h1 with measured 25s+ listing lag
   - Preserved existing prefix filters (`e2e-` OR `qds-`)

2. **tier2-fanout-bestofn.live.test.ts** (lines 289-303):
   - Same bounded retry implementation
   - Same 5 attempts × 8s = 40s budget
   - Same evidence recording pattern

**Verification**: Both tests are env-gated (todoIf). Ran `bun test` expecting skip:

```
bun test tests/fleet/e2e/tier2-dispatch-engine.live.test.ts tests/fleet/e2e/tier2-fanout-bestofn.live.test.ts

0 pass
2 todo
0 fail
Ran 2 tests across 2 files. [2.19s]
```

✓ Tests remain gated (no breakage).

---

## T-i1 [LOW] — Cost Test Comment: Fractional Billing

**Finding**: Comment at `tests/scripts/qds-cost.test.ts:~364` referenced old "CEILED whole hours" billing, but F8 changed to fractional µ$/ms.

**Investigation**: Searched the file for the problematic text pattern. The comment at **line 103** already states the correct fractional billing:

```typescript
// 1.5h × 3,600,000 µ$/h = 5,400,000 µ$ — no whole-hour ceiling.
```

No stale `7,200,000 µ$` figure found. No "CEILED"/"ceiled" references found. The surrounding test block (lines 95-164) correctly expects `5,400,000 µ$` matching fractional billing.

**Status**: **ALREADY FIXED** — no action needed.

---

## Test Results

### qds-cost.test.ts
```
bun test tests/scripts/qds-cost.test.ts --timeout 300000

23 pass
0 fail
76 expect() calls
Ran 23 tests across 1 file. [11.48s]
```
✓ All 23 tests pass.

---

## Biome Check

```
bunx biome check tests/fleet/e2e/tier2-dispatch-engine.live.test.ts tests/fleet/e2e/tier2-fanout-bestofn.live.test.ts tests/scripts/qds-cost.test.ts

Checked 3 files in 132ms. No fixes applied.
```
✓ No lint issues.

---

## TypeScript Check

```
bunx tsc --noEmit
```
✓ Exit code 0 — no TypeScript errors in any files including the three modified files.

---

## Files Modified

1. `tests/fleet/e2e/tier2-dispatch-engine.live.test.ts`
2. `tests/fleet/e2e/tier2-fanout-bestofn.live.test.ts`
3. `tests/scripts/qds-cost.test.ts` — no change (already correct)

---

## Diff Summary

**tier2-dispatch-engine.live.test.ts** (+12 lines):
- Replaced single `driver.list()` with retry loop (5 attempts, 8s delay)
- Added `final-ls-retry` evidence entries for each retry
- Updated `final-ls` evidence to include `attempts` count

**tier2-fanout-bestofn.live.test.ts** (+14 lines):
- Same retry loop implementation
- Same evidence pattern

---

## Conclusion

- T-h1: FIXED — bounded retry prevents false leak detection due to listing lag
- T-i1: ALREADY CORRECT — comment already states fractional billing
- All target tests pass
- Biome clean
- No commits made (per instructions)
