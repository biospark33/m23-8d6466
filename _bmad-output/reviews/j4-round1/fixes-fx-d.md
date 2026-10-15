# FX-D fixes (R1-05 / BH1-004)

- `src/fleet/observe.ts`: onTick is skipped when remaining pass budget (`budgetMs - el()`) < 2x hook deadline (hook plus one deadline of margin for the rest of the pass). Emits one `sweep-ontick-skipped` line (reason `wall-clock-budget`, `remaining_ms`). Counters/dispositions untouched; hook-absent path unchanged.
- `tests/fleet/observe-ontick.test.ts`: two tests (tiny budget plus slow hook skips and matches the hook-free run; normal budget still calls the hook).
- Verified: observe-ontick + observe tests 64 pass/0 fail, biome clean, tsc no errors in observe files. observe.test.ts untouched.
