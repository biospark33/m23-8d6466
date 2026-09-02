# edge-tests-unit

## [MEDIUM] The frozen clock leaks out of the "MUST STAY LAST IN THIS FILE" test into a whole trailing describe — and this PR raised a timeout instead of fixing it
- **File:line:** `tests/providers/exedev/setup-gate.test.ts:1335`, `:1359`, `:1390`, `:1472`
- **Trigger:** `setSystemTime` is called only at `:1359` and is **never reset** (a bare `setSystemTime()` appears nowhere in the file — the only two occurrences are the import on `:11` and the freeze on `:1359`). Bun's frozen clock persists for the rest of the file, and `describe("setup gate — input contract (D9/D10/D14)")` starts at `:1390` — *after* the test whose own comment says it must be last. Every test in that trailing describe runs with `Date.now()` pinned: `budgetFree()` in `setup-gate.ts` returns the full `gateTimeoutMs` on every call and never expires, and `boot_ready_ms` is always the `Math.max(1, 0)` clamp. So D10 (`:1435`) drives `setupGate` end-to-end through a budget that *cannot* run out. A regression that broke budget expiry, or that made every gate phase run to completion regardless of remaining time, is invisible to that block — and running `bun test -t "D10"` in isolation exercises a completely different clock than running the file, so the two disagree about what was tested. The PR's own evidence points at this: the 60 s bump added at `:1469-1472` is justified as "measured failing at 5 018 ms", i.e. the gate under the frozen clock ran far enough to blow bun's 5 s default. The fix applied was to raise the timeout, not to restore the clock.
- **Evidence:**
  ```
  1335:    // MUST STAY LAST IN THIS FILE: bun's setSystemTime is FROZEN (probed:
  1359:      setSystemTime(new Date(Date.now() + FROZEN_STEP_MS));
  1390: describe("setup gate — input contract (D9/D10/D14)", () => {
  1471:    // default on a loaded host (measured failing at 5 018 ms).
  ```
- **Confirmed by:** `grep -n "setSystemTime|^describe\(" tests/providers/exedev/setup-gate.test.ts` → freeze at 1359, no restore, describe at 1390 (file is 1515 lines). Read `src/providers/exedev/setup-gate.ts:418-434` (`boot_ready_ms: aOk ? Math.max(1, Date.now() - gateStart) : 0`) and the `budgetFree()` call sites to confirm the gate's time arithmetic is all `Date.now()`-derived.

## [MEDIUM] Nothing tests the `grep -xE` exact-line pass in the pi version extraction — deleting the guard keeps every new AC2/D7 test green
- **File:line:** `src/providers/exedev/assertions-in-box.sh:139` (the guard) / `tests/providers/exedev/setup-gate.test.ts:1037`, `:1176`, `:1229`-ish (the three pi doubles)
- **Trigger:** The script deliberately prefers an exact-LINE match over a token match, with a stated failure mode: a pi that prints an update banner ("A new version 0.99.0 is available") would otherwise report the *advertised* version and refuse D on every box in the fleet as a phantom pin bump. All three pi doubles in this PR print a **bare version on a line of its own** (`echo "${PI_VERSION}"`, `echo "${UNREVIEWED_PI_SERIES}.0"`) or print nothing at all (D7's `exit 0`). A refactor that deletes line 139 and keeps only the `grep -oE` fallback on line 141 passes the AC2 test, the D7 test, and the F14 tolerance test unchanged — while every real box whose pi emits a banner refuses D. No test drives multi-line `pi --version` output.
- **Evidence:**
  ```
  139: pi_full="$(pi --version 2>/dev/null | grep -xE '[0-9]+\.[0-9]+\.[0-9]+' | head -1)"
  141:   pi_full="$(pi --version 2>/dev/null | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -1)"
  ```
  vs. the only three doubles the file installs:
  ```
  1037: `#!/bin/sh\nif [ "$1" = --version ]; then echo "${PI_VERSION}"; fi\nexit 0\n`
  1176: `#!/bin/sh\nif [ "$1" = --version ]; then echo "${UNREVIEWED_PI_SERIES}.0"; fi\nexit 0\n`
  d7:   `#!/bin/sh\nexit 0\n`
  ```
- **Confirmed by:** `grep -n 'grep -xE|grep -oE|pi_full=' src/providers/exedev/assertions-in-box.sh` and `grep -n 'if \[ "\$1" = --version \]' tests/providers/exedev/setup-gate.test.ts` — exactly two version-printing shims exist in the whole file, both single-line. Read `assertions-in-box.sh:130-145` for the guard's own stated rationale.

## [MEDIUM] "every declared input has a mutation case below" does not check that a mutation case exists
- **File:line:** `tests/scripts/build-exedev-image.test.ts:96`-`117`
- **Trigger:** The test's name and its docstring claim that growing `BuildIdInputs` "refuses to compile until this literal, **and a mutation row**, are updated". The compile-time `Record<keyof BuildIdInputs, 0>` forces `allInputs` to be updated, and the runtime `Object.keys` comparison forces `baseInputs()` to be updated — but there is **no linkage of any kind** between `allInputs` and the `mutations` array declared at `:114`; the rows are keyed by free-form English strings. Add a field to `BuildIdInputs` (say `gitSha`), add it to `allInputs` and `baseInputs()` as both checks demand, and forget the mutation row: if `deriveBuildId` never folds `gitSha` into the hash, no test in this file fails. That is precisely the "an input silently dropped from the hash fails no workflow gate" scenario the describe's own docstring says these tests are the only defence against.
- **Evidence:**
  ```
   96:  test("every declared input has a mutation case below", () => {
  104:    const allInputs: Record<keyof BuildIdInputs, 0> = { baseDigests: 0, bunVersion: 0, dockerfile: 0, piVersion: 0, systemdFiles: 0 };
  117:    expect(Object.keys(baseInputs()).sort()).toEqual(Object.keys(allInputs).sort());
  114:  const mutations: [string, (i: BuildIdInputs) => BuildIdInputs][] = [ … ]   // never referenced by the test above
  ```
- **Confirmed by:** Read the whole `describe("deriveBuildId")` block — `mutations` is consumed only by the `for` loop at `:146` that generates the pair tests; nothing derives or asserts a key set from it. (The five rows currently present do cover all five fields, so this is a future-regression gap, not a present hole.)

## [LOW] `marker_assert_ms` is asserted only by `typeof`, on a field with no `>= 1` clamp — the same sentinel collision the neighbouring assertion was written to prevent
- **File:line:** `tests/providers/exedev/setup-gate.test.ts:331`
- **Trigger:** The file's own Observability Contract reading is "a field never evaluated reports 0", and `:345` asserts `boot_ready_ms >= 1` with the explicit reasoning that "the fake substrate settles A in under a millisecond, so without the >= 1 clamp a genuinely-ready box would emit the sentinel byte-for-byte". `marker_assert_ms` is emitted from `Date.now() - markerT` with **no** such clamp (`src/providers/exedev/setup-gate.ts:520`, versus the clamped `Math.max(1, …)` on `:434`), so a B0 marker read that completes inside one millisecond publishes the never-evaluated sentinel for an assertion that *did* run — and `expect(typeof …).toBe("number")` cannot tell the two apart, nor would it catch a hard-coded `marker_assert_ms: 0`.
- **Evidence:**
  ```
  test:331  expect(typeof b0[0]?.marker_assert_ms).toBe("number");
  test:345  expect(gateA[0]?.boot_ready_ms as number).toBeGreaterThanOrEqual(1);
  src:434   boot_ready_ms: aOk ? Math.max(1, Date.now() - gateStart) : 0,
  src:520   marker_assert_ms: Date.now() - markerT,
  ```
- **Confirmed by:** Read `src/providers/exedev/setup-gate.ts:418-434` and `:504-521` — `boot_ready_ms` is clamped, `marker_assert_ms` (and `gate_b0`'s own duration) are not.
