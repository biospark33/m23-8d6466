# FX-D fixes (R2-02 / BH2-002, R2-14 / ECH2-004)

- R2-02: `driveOne` now only records `pendingTick` (arm: unsettled/live) inside the lock; `runTickHook` runs after the `finally` releases it. Still awaited, bounded by the per-call deadline, fault-isolated, logged (`sweep-ontick-failed`). Docblocks (ObserveSweepDeps.onTick, ObserveTickInfo, call site) updated.
- R2-14: `ON_TICK_PASS_BUDGET_FRACTION = 0.25` (of wallClockBudgetMs); test override `onTickPassBudgetMs`. Once spent, later residents get `sweep-ontick-skipped` with `reason: "pass-hook-budget"`. Existing per-call `wall-clock-budget` skip kept.
- Hook absent: unchanged. Counters and dispositions untouched.
- Tests (observe-ontick.test.ts): "runs inside the lock" replaced by a lock-released test (hook acquires the run lock successfully); new pass-hook-budget test. 65 pass, 0 fail (/tmp/j4-r2d.log). biome clean; tsc clean for these files. observe.test.ts untouched.
- observe.ts buildId moved; the driver re-pins.
