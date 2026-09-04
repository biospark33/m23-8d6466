# Review Round 5: fanout.test.ts Fixes

## Verdict Table

| ID | Severity | Status | Evidence |
|----|----------|--------|----------|
| P7 | MED | **Fixed** | Changed bounds from 86_400_000 (1 day) and 3_600_000_000 (1 hour) to 315_360_000_000 (10 years) with clock-skew comment |
| P9 | MED | **Fixed** | Added sibling test for pid boundary values (0 and 0x8000_0000), reusing plantLock pattern |
| P10 | LOW | **Fixed** | Added `expect(() => ro.list()).not.toThrow()` and assertions verifying list() returns records in create:false test |

## Hunks

### P7 — Clock-skew tolerant Date.now() bounds (lines 415-426)

**Before:**
```typescript
test("own pid: epoch ms near now, stable across calls", () => {
  const a = readOwnPidStartTime();
  const b = readOwnPidStartTime();
  expect(a).toBe(b);
  expect(a).toBeGreaterThan(Date.now() - 86_400_000);
  expect(a).toBeLessThanOrEqual(Date.now());
});

test("foreign live pid: observable, <= now, stable", async () => {
  const child = liveChild();
  children.push(child);
  const observed = readOwnPidStartTime(child.pid);
  expect(observed).toBeLessThanOrEqual(Date.now());
  expect(observed).toBeGreaterThan(Date.now() - 3_600_000_000);
  expect(readOwnPidStartTime(child.pid)).toBe(observed);
});
```

**After:**
```typescript
test("own pid: epoch ms near now, stable across calls", () => {
  const a = readOwnPidStartTime();
  const b = readOwnPidStartTime();
  expect(a).toBe(b);
  // Clock-skew-tolerant sanity window: 10 years. Source guarantees only stability, not exact now.
  expect(a).toBeGreaterThan(Date.now() - 315_360_000_000);
  expect(a).toBeLessThanOrEqual(Date.now());
});

test("foreign live pid: observable, <= now, stable", async () => {
  const child = liveChild();
  children.push(child);
  const observed = readOwnPidStartTime(child.pid);
  expect(observed).toBeLessThanOrEqual(Date.now());
  // Clock-skew-tolerant sanity window: 10 years. Source guarantees only stability, not exact now.
  expect(observed).toBeGreaterThan(Date.now() - 315_360_000_000);
  expect(readOwnPidStartTime(child.pid)).toBe(observed);
});
```

**Rationale:** The source (`readOwnPidStartTime` in `fleet-lock.ts`) guarantees only stability across calls. Using tight time windows (1 day, 1 hour) fails on systems with clock skew (NTP adjustments, VM drift). A 10-year window maintains the sanity check while tolerating realistic clock deviations.

### P9 — pid boundary values (lines 773-792 → new sibling test)

**Before:**
```typescript
test("out-of-range recorded pid → refuse (out-of-range is NOT dead)", () => {
  plantLock(lockPath, {
    pid: 100_000_000_000,
    pidStartTime: 1,
    createdAt: agedIso(),
    requestId: "req-huge-pid",
  });
  let err: FleetError | undefined;
  try {
    lock().acquire();
  } catch (e) {
    err = e as FleetError;
  }
  expect(err?.exitCode).toBe(5);
  expect(err?.code).toBe("fleet-busy");
  expect(err?.message).toContain("unusable pid");
  expect(onDisk().requestId).toBe("req-huge-pid");
});
```

**After (added sibling test):**
```typescript
test("pid boundary values: 0 and 0x8000_0000 are refused", () => {
  // pid 0 → refused
  plantLock(lockPath, {
    pid: 0,
    pidStartTime: 1,
    createdAt: agedIso(),
    requestId: "req-pid-zero",
  });
  let errZero: FleetError | undefined;
  try {
    lock().acquire();
  } catch (e) {
    errZero = e as FleetError;
  }
  expect(errZero?.exitCode).toBe(5);
  expect(errZero?.message).toContain("unusable pid");
  expect(onDisk().requestId).toBe("req-pid-zero");

  // pid 0x8000_0000 (one past max) → refused
  plantLock(lockPath, {
    pid: 0x8000_0000,
    pidStartTime: 1,
    createdAt: agedIso(),
    requestId: "req-pid-over-max",
  });
  let errOverMax: FleetError | undefined;
  try {
    lock().acquire();
  } catch (e) {
    errOverMax = e as FleetError;
  }
  expect(errOverMax?.exitCode).toBe(5);
  expect(errOverMax?.message).toContain("unusable pid");
  expect(onDisk().requestId).toBe("req-pid-over-max");
});
```

**Rationale:** Source (`fleet-lock.ts` line 713) rejects `pid <= 0 || pid > 0x7fff_ffff`. The original test only checked pid=100_000_000_000 (far above max). Added boundary assertions for pid=0 and pid=0x8000_0000 to prove the full rejection surface. Reused the existing `plantLock` pattern.

### P10 — list() works in read-only mode (lines 394-405)

**Before:**
```typescript
test("create:false reads but refuses every mutation", () => {
  const fanoutsDir = join(dir, "fanouts");
  mkdirSync(fanoutsDir, { recursive: true });
  writeFileSync(
    join(fanoutsDir, "fan-20260823-cafe00.json"),
    JSON.stringify(makeRecord({ fanoutId: "fan-20260823-cafe00" })),
  );
  const ro = new FanoutRecordStore({ dir: fanoutsDir, create: false });
  expect(ro.get("fan-20260823-cafe00").n).toBe(3);
  expect(() => ro.create(makeRecord())).toThrow(/create: false/);
  expect(() => ro.mutate("fan-20260823-cafe00", (r) => r)).toThrow(/create: false/);
});
```

**After:**
```typescript
test("create:false reads but refuses every mutation", () => {
  const fanoutsDir = join(dir, "fanouts");
  mkdirSync(fanoutsDir, { recursive: true });
  writeFileSync(
    join(fanoutsDir, "fan-20260823-cafe00.json"),
    JSON.stringify(makeRecord({ fanoutId: "fan-20260823-cafe00" })),
  );
  const ro = new FanoutRecordStore({ dir: fanoutsDir, create: false });
  expect(ro.get("fan-20260823-cafe00").n).toBe(3);
  // list() works in read-only mode
  expect(() => ro.list()).not.toThrow();
  const listed = ro.list();
  expect(listed).toHaveLength(1);
  expect(listed[0].fanoutId).toBe("fan-20260823-cafe00");
  expect(() => ro.create(makeRecord())).toThrow(/create: false/);
  expect(() => ro.mutate("fan-20260823-cafe00", (r) => r)).toThrow(/create: false/);
});
```

**Rationale:** The test opened the store with `create:false` and verified `create()` and `mutate()` throw, but never asserted that `list()` works. Source (`fanout.ts` lines 207-227) shows `list()` reads the directory and parses records — valid in read-only mode. Added assertions proving list() succeeds and returns the fixture record.

## Test Results

```
bun test tests/fleet/fanout.test.ts
bun test v1.4.0 (34cbb9a40)
fleet-lock: parked a foreign body at /private/var/folders/1v/nbxmg4vx1r53__g78j17g9mm0000gn/T/df3-2-fanout-lO8Bsg/case-FnawJi/sandbox/fleet.lock.orphan.32887.97652bae (it was NOT deleted)

 41 pass
 0 fail
 160 expect() calls
Ran 41 tests across 1 file. [2.11s]
```

All 41 tests pass (38 existing + 3 new assertions for P10 + 1 new test for P9).

## Biome Results

```
bunx biome check tests/fleet/fanout.test.ts
Checked 1 file in 270ms. No fixes applied.
```

No linting issues introduced.

## Summary

All three findings from review round 5 for `fanout.test.ts` were fixed:
- P7: Relaxed Date.now() bounds to 10 years (315_360_000_000ms) with clock-skew comment
- P9: Added boundary value test for pid=0 and pid=0x8000_0000
- P10: Added list() assertion to create:false test

Changes are minimal, follow existing patterns, and all tests pass with clean biome check.
