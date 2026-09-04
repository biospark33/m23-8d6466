# Fixer C Report: Cluster C (scripts/fleet.ts CLI)

## Verdict Summary

| Finding | Severity | Status | Behavior Change |
|----------|----------|--------|-----------------|
| C1 | LOW | ✅ Fixed | Yes - new upper bound enforcement |
| C2 | LOW | ✅ Fixed | Yes - explicit empty refusal |
| C3 | LOW | ✅ Fixed | Yes - inconsistent combo refusal |
| C4 | LOW | ✅ Fixed | No - error extraction improvement only |
| C5 | MEDIUM | ✅ Fixed | No - logging guarantee only |
| C6 | LOW | ✅ Fixed | No - help text clarification |

## Changes Made

### C1: `--cap-micro-usd` domain upper bound
**Location:** `scripts/fleet.ts:1554-1562`

**Change:** Added upper bound of 1,000,000,000,000 (1e12) micro-dollars ($1M) to cap validation.

```typescript
const CAP_MAX_MICRO_USD = 1_000_000_000_000;
if (!Number.isSafeInteger(capMicroUsd) || capMicroUsd < 1 || capMicroUsd > CAP_MAX_MICRO_USD) {
  throw usageError(
    `--cap-micro-usd ${JSON.stringify(capRaw)} is not a micro-dollar amount`,
    `--cap-micro-usd takes a positive integer of micro-dollars (1-${CAP_MAX_MICRO_USD}, where $1 is 1000000)`,
  );
}
```

**Behavior Change:** Yes - values above $1M now refused with usage error.

### C2: `--roster` explicit empty refusal
**Location:** `scripts/fleet.ts:1576-1591`

**Change:** Changed empty-list handling from "flag-absent" to explicit refusal.

```typescript
const rosterIds = flags
  .get("--roster")
  ?.split(",")
  .map((s) => s.trim())
  .filter((s) => s !== "");
// C2: Fail-closed for explicit empty roster. `--roster ""` or `--roster ","`
// produces an empty list; flag PRESENT but resulting list EMPTY ⇒ refusal.
if (rosterIds !== undefined && rosterIds.length === 0) {
  throw usageError(
    "--roster provided but empty",
    "pass at least one roster entry, or omit --roster entirely",
  );
}
```

**Behavior Change:** Yes - `--roster ""` and `--roster ","` now fail with explicit error instead of being treated as flag-absent.

### C3: `--steps-json` shape gate inconsistency
**Location:** `scripts/fleet.ts:1927-1933`

**Change:** Added validation for inconsistent testResults/testsExecuted combo.

```typescript
// C3: Refuse inconsistent testResults/testsExecuted combo.
// testResults present while testsExecuted === false is logically inconsistent.
if (o.testResults !== undefined && o.testsExecuted === false) {
  throw bad("has testResults but testsExecuted is false — tests must have been executed to have results");
}
```

**Behavior Change:** Yes - new refusal for logically inconsistent state.

### C4: Error-message extraction helper
**Locations:**
- `scripts/fleet.ts:130-136` (helper definition)
- `scripts/fleet.ts:1465-1472` (ack-unwritable site)
- `scripts/fleet.ts:1795-1802` (loser ledger site)
- `scripts/fleet.ts:2337-2343` (cost ledger site)

**Change:** Added `errText()` helper and used it at all three sites.

```typescript
function errText(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (e === null || e === undefined) return "unknown";
  return String(e);
}
```

**Behavior Change:** No - only improves error message quality for non-Error throws.

### C5: Loser-ledger close logging
**Location:** `scripts/fleet.ts:1795-1803`

**Change:** Made log unconditional (exit-code escalation stays conditional).

```typescript
} catch (e) {
  printError(
    note,
    "ledger-close-failed",
    `could not close the loser cost ledger: ${redactSecrets(errText(e))}`,
    "the handle dies with the process; re-run to confirm it still reads",
  );
  // C5: Exit code escalation only when fanoutCode === 0 (the log is always emitted).
  if (fanoutCode === 0) fanoutCode = 6;
}
```

**Behavior Change:** No - only ensures operator always sees the log; exit semantics unchanged.

### C6: Help text for fanout/rank `--dir`
**Location:** `src/fleet/verbs.ts:140-142`

**Change:** Added clarifying comment that --dir names the FAN-OUTS directory.

```typescript
// The FAN-OUT records directory (.sandbox/fanouts), NOT the runs dir:
// fanout writes fan-*.json records; rank reads them.
{ name: "--dir", required: false, valueType: "path" },
```

**Behavior Change:** No - code comment only; help text generated from registry unchanged.

## Test Coverage

**New tests added** in `tests/fleet/cli.test.ts` (round-6 review refusals block):
- C1: `--cap-micro-usd` above $1M refused
- C1: `--cap-micro-usd` accepts exactly $1M
- C2: `--roster ""` refused (empty value caught by parseValueFlags)
- C2: `--roster ",,,"` refused (empty after split/filter)
- C3: testResults with testsExecuted=false refused
- C3: testResults with testsExecuted=true accepted
- C3: testsExecuted=true with no testResults legal (passRate 0)

**Existing test updated:**
- "roster of separators only" - updated expectation to match new C2 behavior

## Verification Results

```bash
$ bun test tests/fleet/cli.test.ts
✓ 135 pass, 0 fail [28.33s]

$ bun test tests/fleet/verbs.test.ts
✓ 77 pass, 0 fail [84.65s]

$ bunx biome check scripts/fleet.ts
✓ No errors

$ bunx tsc --noEmit
✓ No errors
```

## Notes

- gitnexus impact analysis failed with `unknown option '--target'` error, proceeded without it
- C2 implementation revealed that empty string `--roster ""` is caught by parseValueFlags before split/filter logic
- Existing test pinned lenient behavior was updated (not preserved per instructions)
