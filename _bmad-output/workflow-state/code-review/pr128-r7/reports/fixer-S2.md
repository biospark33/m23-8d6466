# PR-128 Round-7 Finding S2 Fix Report

## Finding S2a: rank.ts — assertStepOutputShape validates shape but not semantic consistency

**Severity**: MEDIUM
**Status**: FIXED

### Problem

`assertStepOutputShape` validated structural types (non-negative integers) but allowed the semantically inconsistent combination `{testsExecuted: false, testResults: {passed: 5, failed: 0}}` to pass through. This flowed into `testPassRate` which silently returned 0 due to its gate on `testsExecuted === true`. The CLI's `--steps-json` parser already refused this combo (round-6 C3), but embedders calling `rank()` directly got silent failure.

### Blast Radius Analysis

- **Direct callers of `assertStepOutputShape`**: only `rank()` function (rank.ts:232)
- **Producers of `ArmStepOutput` with `testResults`**: grep found no legitimate producers in src/fleet/ or scripts/ that emit testResults without testsExecuted:true
- **Test fixtures**: rank.test.ts:296 had a fixture expecting score 0 from this combo (updated)

### Fix Applied

**File**: `src/fleet/rank.ts:163-174`

Added semantic consistency guard after the existing testResults shape checks:

```typescript
// r7-S2a: Refuse semantic inconsistency — testResults present while
// testsExecuted !== true. Matches CLI refusal (scripts/fleet.ts C3) so
// embedders calling rank() directly get the named refusal, not silent
// zero scores from testPassRate's gate on testsExecuted === true.
if (tr !== undefined && out.testsExecuted !== true) {
  throw new FleetError(
    2,
    "invalid-step-output",
    `step output for run ${redactSecrets(runId)} has testResults but testsExecuted is false — tests must have been executed to have results`,
    hint,
  );
}
```

### Tests Added

**File**: `tests/fleet/rank.test.ts`

1. **testResults with testsExecuted=false → refused** (exit 2, code "invalid-step-output", message contains "testResults but testsExecuted is false")
2. **testResults with testsExecuted absent → refused** (same refusal)
3. **testResults with testsExecuted=true → scores normally** (control case, passes)
4. **Updated existing test** "guards the pass-rate divisor": removed the `notexec` case that expected score 0 from the inconsistent combo

### Test Results

```
bun test tests/fleet/rank.test.ts
27 pass
0 fail
129 expect() calls
Ran 27 tests across 1 file. [2.89s]
```

### Linting & Type Checking

```
bunx biome check src/fleet/rank.ts tests/fleet/rank.test.ts
Checked 2 files in 564ms. No fixes applied.
```

```
bunx tsc --noEmit
No errors in rank.ts files
```

### Related Tests

- `tests/fleet/patterns.test.ts`: No testResults without testsExecuted:true patterns found
- `tests/fleet/verbs.test.ts`: No testResults without testsExecuted:true patterns found
- `tests/fleet/cli.test.ts`: Already contains C3 test for this refusal (line 5173-5182)

### Behavior Changes

**Before**: `{testsExecuted: false, testResults: {passed: 5, failed: 0}}` → score 0, no error
**After**: Same input → FleetError exit 2, "invalid-step-output", message "has testResults but testsExecuted is false"

**Wave-2 impact**: Any code calling rank() directly with this inconsistent combo will now receive an error instead of a silent zero score. This is a breaking change for an already-incorrect usage pattern.

### Pushback

None — fix implemented as specified.
