# fx1-battery — fix report (m2-3 round 1)

Files touched (ownership scope respected):
- `scripts/e2e/memory-negative-probes.ts`
- `tests/scripts/memory-negative-probes.test.ts`

## F-006 (MED) — ttl probe clock-skew evidence

- `TTL_PROBE_SKEW_MS`: 1_500 → 5_000 (`scripts/e2e/memory-negative-probes.ts:78`).
- ttl poll-loop default `capMs`: 15_000 → 30_000 (`scripts/e2e/memory-negative-probes.ts:313`).
- `ProbeBatteryInput.ttlWait` doc comment: "contract defaults: 5000 / 30000 / 250".
- `ProbeOutcome` gained optional `ttlExpiresAtMs?: number` and `ttlFiredAtMs?: number`
  (doc comment names them gateway-clock skew evidence, F-006). Set ONLY on the ttl
  outcome (`ttlExpiresAtMs = ttlKey.expiresAtMs`, `ttlFiredAtMs = Date.now()` at fire
  time); the other four outcomes are untouched. CLI payload needed no serialization
  change — it embeds `result.outcomes` by reference, so the two fields ride the
  evidence file automatically.
- Header docblock ttl entry now states the skew rationale (gateway-clock-lag
  tolerance; evidence fields separate skew from a real expiry-ladder defect) and the
  30s cap.

## F-011 — SKIPPED (not my file; another fixer owns it)

## F-012 (LOW) — explicit test timeout on the CLI-spawn test

- `test("CLI env-refusal: ...", ..., { timeout: 30_000 })` in
  `tests/scripts/memory-negative-probes.test.ts` — the spawn's own duration now
  bounds it instead of the 5s sweep default.
- Deviation from the brief, forced by types: bun-types 1.3.14 declares the overload
  as `test(label, fn, options)` — options THIRD, not node:test's `(label, options,
  fn)`. Options in second position fails `tsc` with TS2353 ("'timeout' does not
  exist in type '(done) => ...'" — TS parses the object as the fn param). Bun
  honors the third-arg form at runtime; verified green below. (The sibling
  failure-recovery fix uses `(label, options, fn)` because that file imports
  `test` from `node:test`, whose types declare that order; this file imports from
  `bun:test`.)

## Focal checks

1. `bun test tests/scripts/memory-negative-probes.test.ts` → exit 0:

```
bun test v1.4.0 (34cbb9a40)

 6 pass
 0 fail
 30 expect() calls
Ran 6 tests across 1 file. [136.00ms]
```

2. `bunx tsc --noEmit` → RED, but NOT on my files. The single repo-wide error is in
   `tests/fleet/e2e/memory-combined.live.test.ts` (untracked, sibling fixer's
   in-flight work; the error moved from line 59 `TS6133 unused 'openTraceReader'`
   to line 663 `TS2367` between my two runs — that file is being actively edited
   right now). Grep of full tsc output for "memory-negative-probes" → 0 hits: my
   two files contribute zero tsc errors. I did not touch the sibling file
   (ownership boundary). Re-run `bunx tsc --noEmit` after all fixers land for the
   round-green.

3. `bunx @biomejs/biome check scripts/e2e/memory-negative-probes.ts tests/scripts/memory-negative-probes.test.ts` → exit 0:

```
Checked 2 files in 14ms. No fixes applied.
```
