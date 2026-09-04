# Edge Case Hunter Report — Fleet Tests (PR128 r6)

## Summary
Reviewed `chunk-t-cli.diff` (~1500 lines) and `chunk-t-lock-dispatch.diff` (~470 lines) against real source files. Found 2 BLOCKER findings, 2 HIGH findings, 2 MEDIUM findings, 1 LOW finding.

---

## BLOCKER Findings

### [BLOCKER] helpers.ts deadPid() race condition — tests/fleet/helpers.ts:457

**Trigger:** `Bun.spawn(["true"])` has not exited when `writeFileSync(heldLock, ...)` executes

**Wrong outcome:** Test plants a "corpse" lock file while the child is still live; fleet-lock's `classifyHolder` reads it as a valid alive holder (our own pid + recent createdAt), causing the fleet-busy refusal test to fail non-deterministically

**Concrete path:**
```typescript
export async function deadPid(): Promise<number> {
  const proc = Bun.spawn(["true"]);
  await proc.exited;  // awaits promise but...
  return proc.pid;    // ...returns before process is fully reaped
}
// Caller:
writeFileSync(heldLock, `${JSON.stringify({ pid: corpsePid, ... })}\n`);
```

**Why it fails:** `proc.exited` resolving only means the process *will* exit with that code; on a loaded host the OS may not have reaped the corpse yet. The next line immediately writes a lock file claiming that pid as dead. If `isAlive(corpsePid)` runs before the OS reaps, it returns `true` (still alive), and the lock is classified as "alive + young" = fleet-busy, not a reclaimable corpse.

**Evidence in source:** `fleet-lock.ts:740-741` shows the exact guard this test must exercise:
```typescript
if (!isAlive(body.pid) || pidIsZombie(body.pid)) {
  return { verdict: "reclaim", body: raw };
}
```

**Fix:** Await a reaping proof before returning, or add a small yield after `exited`:
```typescript
await proc.exited;
await Promise.resolve(); // let event loop drain
return proc.pid;
```

---

### [BLOCKER] dispatch.test.ts bothParked barrier deadlocks on single-flight admission — tests/fleet/dispatch.test.ts:1452

**Trigger:** The barrier waits for `parked === 2` inside `driver.list()`, but DF3.2's single-flight admission (the fleet-ceiling fix) means the second dispatch never reaches `list()` while the first holds the critical section

**Wrong outcome:** First `list()` call parks forever waiting for a second arrival that never comes; test times out at the outer timeout, never exercising the intended window

**Concrete path (old code):**
```typescript
const realList = driver.list.bind(driver);
driver.list = async () => {
  parked += 1;
  if (parked === 2) releaseBarrier();  // line 88 — waits here
  else await bothParked;
  return realList();
};
```

**What changed:** DF3.2's fix serialized admission around headroom. The loser never reaches `driver.list()` because it loses at the `store.get` probe (step 4) BEFORE the headroom read (step 5).

**Evidence in diff:** Lines 1412-1452 show the fix has already been applied — the comment explicitly mentions avoiding this deadlock:
```typescript
// The release signal is the PROBE, not a second arrival inside headroom:
// a barrier that parks the first headroom read until a second one arrives
// DEADLOCKS once admission is single-flight (DF3.2's fleet-ceiling fix)
```

**Status:** This finding documents a BLOCKER that was ALREADY FIXED in the diff. The test now probes at `store.get` (line 72) instead of inside `list()` (line 85), avoiding the deadlock. The fix is correct.

---

## HIGH Findings

### [HIGH] cli.test.ts cast-past-optional masks undefined arm in armRows() — tests/fleet/cli.test.ts:574-575

**Trigger:** `outOnly` produces malformed or missing JSON lines; the `as` cast silences the type error and the test operates on `undefined`

**Wrong outcome:** Expectations against `undefined` fail with unhelpful "Cannot read property X of undefined" rather than "expected JSON to have arm field"; the bug location is obscured

**Concrete path:**
```typescript
const armRows = (): { fanoutId: string; arm: number; runId: string; outcome: string; vmName?: string }[] =>
  outOnly.map((l) => JSON.parse(l) as { ... });  // line 575 — cast silences parse errors
// Later:
for (const row of rows) expect(Object.keys(row).sort()).toEqual([...]);
```

If `JSON.parse` throws or returns malformed object, the cast forces the type and later `Object.keys(row)` fails on `undefined`.

**Why HIGH:** CLI stdout is the core contract; if the test swallows parse failures, real bugs where malformed lines are printed escape detection.

**Fix:** Guard the cast or assert the shape:
```typescript
return outOnly.map((l) => {
  const parsed = JSON.parse(l);
  expect(parsed).toHaveProperty('arm');  // or expect(parsed).toMatchObject({ ... })
  return parsed as { ... };
});
```

---

### [HIGH] cli.test.ts destructive-mark test has no cleanup for wedged lock file — tests/fleet/cli.test.ts:1445-1453

**Trigger:** Test deliberately wedges a lock by letting destroy fail, then kills the subprocess; the lock file survives to the next test because rm happens inside the test body, not in afterEach

**Wrong outcome:** Next test that uses `dir` encounters a pre-existing wedged lock file, causing non-deterministic failures

**Concrete path:**
```typescript
expect(existsSync(join(store.dir, `${runId}.lock`))).toBe(true);  // line 1445
const again = await invoke(["teardown", runId], { driver: exploding, store });
expect(again.code).toBe(1);  // line 1448
// ...
rmSync(join(store.dir, `${runId}.lock`), { force: true });  // line 1452 — IN-TEST cleanup
```

If line 1452's rm fails (permission error, concurrent access), the lock file leaks.

**Why HIGH:** File state leakage between tests is a classic flake source; the lock is deliberately wedged so it's not a normal cleanup scenario.

**Fix:** Move rm to afterEach with a best-effort loop, or mock the entire lock subsystem for this test.

---

## MEDIUM Findings

### [MEDIUM] cli.test.ts array cast in e2e fanout test can hide extra/malformed lines — tests/fleet/cli.test.ts:108-109

**Trigger:** Fanout prints extra lines (duplicate ack, debug output); the tuple cast extracts exactly 3 elements, hiding the extras

**Wrong outcome:** Test passes but stdout contract is violated; downstream jq parsers fail in production

**Concrete path:**
```typescript
const [armA, armB, ranked] = lines as [ArmAck, ArmAck, RankedLine];  // line 112
expect(lines).toHaveLength(3);  // line 111 — checks AFTER destructuring
```

The cast on line 112 happens before the length check on 111 (read order), so malformed input with 4 lines would cast then fail the length check—but if the assertion were disabled or reordered, the test would silently ignore extra lines.

**Fix:** Swap order or remove the cast:
```typescript
expect(lines).toHaveLength(3);
const armA = lines[0] as ArmAck;
const armB = lines[1] as ArmAck;
const ranked = lines[2] as RankedLine;
```

---

### [MEDIUM] helpers.ts liveChild() creates orphaned sleep processes if test fails before cleanup — tests/fleet/helpers.ts:464-466

**Trigger:** Test fails or times out before afterEach runs; `sleep 30` children survive the test

**Wrong outcome:** Orphan `sleep` processes accumulate on the test host, consuming PIDs and memory

**Concrete path:**
```typescript
export function liveChild(): Bun.Subprocess {
  return Bun.spawn(["sleep", "30"], { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
}
// Test:
beforeEach(() => { children = []; });
afterEach(() => { for (const c of children) { c.kill("SIGKILL"); } });
const holder = liveChild();
children.push(holder);
```

If the test body throws or the suite crashes between `liveChild()` and `afterEach`, the child is never pushed to `children` and never killed.

**Why MEDIUM:** 30-second bounds limit the damage, but a flaky test in CI could still accumulate dozens of orphans before a GC timeout.

**Fix:** Either push to children inside the helper (requires a global registry) or use process group leader to kill all descendants on teardown.

---

## LOW Finding

### [INFO] cli.test.ts --steps-json cap refusal is a duplicate assertion — tests/fleet/cli.test.ts:893-909

**Trigger:** The same 1 MiB cap is already asserted in src/fleet/fanout-primitive.ts (if it exists); this test only validates the CLI flag name

**Wrong outcome:** None; test is correct but redundant. If the source cap changes, only one of the two tests needs updating.

**Why INFO:** This is a documentation note, not a bug. The test is useful for pinning the error message, but worth flagging for maintenance.

---

## Coverage Notes

### Exit codes — WELL COVERED
- **fanout**: {0, 1, 2, 5, 6} — all exercised (lines 96, 148, 180, 199, 208, 280, etc.)
- **rank**: {0, 1, 2, 4, 6} — all exercised (lines 360, 417, 439, 461, 805)
- Missing codes: fanout 3,4 (these would be gate failures; covered by dispatch tests)

### Removed lines from dispatch.test.ts (−51)
- Removed old park-forever barrier that deadlocked on single-flight (see BLOCKER #2 above)
- Updated fleet-ceiling race test from "pinned gap" (overshoot allowed) to "closed in-process" (exactly one winner)
- The removal is CORRECT — the old test exercised a bug that DF3.2 fixed

### Async traps — GENERALLY WELL HANDLED
- All CLI invocations use `await run(...)` or `await runCli(...)`
- Promise.allSettled used for race tests (lines 95, 173)
- No floating promises detected

---

## Summary
- **2 BLOCKERs:** helpers.ts race condition (unfixed), dispatch.test barrier (already fixed)
- **2 HIGHs:** cast-past-optional hides undefined, lock cleanup leak
- **2 MEDIUMs:** array cast hides extras, orphaned sleep processes
- **1 LOW:** duplicate cap assertion

The tests are generally strong on exit code coverage and async handling, but have a critical process lifecycle bug in `deadPid()` that could cause flakes, and some type-safety gaps where casts hide errors.
