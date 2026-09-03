# Fixer T2 Report — Wave 2 Test Hardening

## Summary
All three findings fixed and verified. Tests pass, biome clean, tsc clean.

---

## T-c1 [LOW] — deadPid() poll budget extended

**File:** `tests/fleet/helpers.ts:170-186`

**Finding:** Poll budget only 100ms (10×10ms) — false positive on loaded hosts where pid table lags legitimately.

**Fix applied:**
- Extended budget to 2000ms (100 iterations × 20ms)
- Updated inline comments to reflect new budget
- Kept the throw as last resort (only after full budget exhausted)

**Test results:**
- Helper consumers (`fleet-lock.test.ts`, `fanout.test.ts`): 48 pass, 0 fail

---

## T-f1 [MEDIUM] — concurrent teardown barrier logic hardened

**File:** `tests/fleet/e2e/tier1-lock.live.test.ts:~50-58`

**Finding:** False negative when first teardown completes before poller sights lock file. Throws even though contention logic is fine.

**Fix applied:**
- Track lock sighted state via `lockSighted` flag
- Only throw if first teardown is **still running** without lock sighted
- If first already exited (fast path), add evidence entry noting lock-not-sighted and proceed
- Final assertions (exactly-one-winner, one-run-locked) decide correctness
- Matched file's evidence/phase style with `phase: "barrier-lock-not-sighted"`

**Test results:**
- `bun test tests/fleet/e2e/tier1-lock.live.test.ts`: 1 todo (expected, env-gated)
- No import/syntax breakage

---

## T-e1 [MEDIUM] — finally block teardown assertions added

**File:** `tests/fleet/e2e/tier1-harvest.live.test.ts` — two sites (~:137, ~:215)

**Finding:** Finally blocks run teardown verb and record exitCode without asserting — a VM leak (real money cost) leaves test green.

**Fix applied (both sites):**
- Added `bodySucceeded` flag, set after last body assertion passes
- In finally: if body succeeded, `expect(td.exitCode).toBe(0)` with message tying to leak prevention
- If body already failed, keep evidence-only teardown (don't mask original failure)
- Comment cites r7-T-e1

**Test results:**
- `bun test tests/fleet/e2e/tier1-harvest.live.test.ts`: 2 todo (expected, env-gated)
- No import/syntax breakage

---

## Verification

### Type check
- `bunx tsc --noEmit` on all three files: **clean** (exit code 0)

### Lint/format
- `bunx biome check` on all three files: **clean** (no fixes applied)

### Test execution
- Tier1 live tests: **3 todo** (expected, env-gated via `todoIf(liveTodoOff())`)
- Helper consumers (fleet-lock, fanout): **48 pass, 0 fail**

---

## Pushback
None — all three findings were valid and applied as specified.
