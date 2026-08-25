# W2c — provider/script/visualizer test hardening (round 10, PR 123 / df3-1)

Owner scope worked: `tests/providers/**`, `tests/scripts/**`, `visualizer/test/**`, `tests/helpers.ts`
(+ the one permitted S28 boundary case in `tests/phase-engine/pipeline-run.test.ts`).
No `src/**` edits. No commits/pushes.

## Gates

- `bunx biome check` on all 8 touched files: clean.
- `bunx tsc --noEmit`: clean.
- `bun test tests/providers/ tests/scripts/ visualizer/ tests/phase-engine/pipeline-run.test.ts`: **green**
  (providers 707 pass / 2 todo / 0 fail; scripts+visualizer+pipeline-run 666 pass / 2 skip / 0 fail).
- Isolation verified: repo-root `.sandbox/cost-ledger.db` untouched by the runs (mtime predates this session).

## HIGH

1. **budget-gate ledger default-path isolation — DONE.** `admitAndProvision()` now passes an explicit
   `path` (default `join(dir, "cost-ledger.db")`) and `runsDir: join(dir, "runs")` (wave-1 orphan-guard
   seam) on every `CostLedger` construction; `freshLedger()` wires `runsDir` too. INV-COST-6 now passes
   the unopenable directory path explicitly instead of routing through `$QDS_COST_LEDGER_FILE`, so every
   construction in the file is explicit-path; no money rows can reach the shared db and refusals cannot
   pass for leftover-spend reasons.

## MEDIUM

2. **cost-ledger SQL predicate pin — DONE.** `RegExp.exec` first-match replaced with `matchAll`; pins
   count of NULL-safe `NOT (a.request_id ? AND a.run_id ?)` occurrences at exactly 1 (today's only SQL
   site is the in-transaction reservation read — the prefetch read scopes on issue columns alone, so the
   reviewer's "prefetch AND in-transaction" premise does not hold; the pin documents that) plus a
   zero-tolerance assertion that no plain-`=` variant exists anywhere in the source.
3. **Grace/close-retirement boundaries — DONE (deterministic arms).** New close-retirement test pins the
   cutoff from BOTH sides (just-inside ⇒ ceiling still held → refusal with `reservedMicroUsd === cap`;
   just-outside ⇒ retired), derived from imported constants. Tombstone mtime grace: new run-record test
   straddles `CREATE_TOMBSTONE_GRACE_MS` at ±200 ms (in-grace held / just-past cleared), replacing the
   old ~0 s vs 50 s straddle.
   *Note:* exact-equality (`<` vs `<=`) discrimination is not pinnable without a faked clock — the cutoff
   is recomputed from `Date.now()` inside the call, so an `==` fixture drifts to the outside arm under
   either operator. Documented in both tests rather than faked.
4. **cap-hit-demo leak scan breadth — DONE.** The deliver-failed test scans `JSON.stringify(logs)` (the
   whole captured stream, not one line) plus the artifact file the failed run wrote. In-process there is
   no separate stdout transcript (the sink captures every emitted entry); noted in-test.
5. **driver-contract clean-listing sweep — DONE.** New "step 7 twin" case: keeper-only listing must
   complete `reapRuns` with no refusal and destroy nothing, proving a tagless-listing driver is not
   fleet-wide-refused when nothing is unproven. Environmental strangers (shared real account) tolerated:
   a refusal naming only non-suite boxes is accepted; ours never may be.
6. **auth-static traversal encodings — DONE.** `test.each` over double-encoded `%252e%252e%252f`,
   backslash `..%5c..%5c`, and uppercase `%2E%2E%2F`; each asserts 404 JSON body and no leaked file bytes
   (all three verified against the real handler).
7. **run-record truncated-JSON quarantine — DONE.** Added to the quarantine `test.each`: valid JSON
   prefix cut mid-body → SyntaxError routed to skipped-with-reason + `list()` hard error carrying the
   reason (the real routing, pinned).

## LOW

8. **step-log perf timing — DONE (tightened discrimination, not loosened).** Input scaled 4× (~4 MB)
   against the unchanged 2 s ceiling: linear stays hundreds of ms under CI drift while the quadratic
   shape it guards against now costs ~15 s — loosening the ceiling would have let the actual regression
   class pass.
9. **5 s-sleep lock tests — DONE (upper bound only).** Both full-window waits gained
   `< 2 × LOCK_TIMEOUT_MS` upper bounds. Timeout is a module constant with no per-store override, so
   shortening via config was not available (noted in-test).
10. **Tombstone "only ONE retry" bare `.toThrow()` — DONE.** Now pins `errno.code === "EEXIST"` plus
    byte-identical snapshot.
11. **ppid foreign-live fixtures — DONE.** All three sites (release-proof, steal-proof, orphan-park)
    switched to the shared `liveForeignPid()` helper with `stop()` cleanup.
12. **Rounding straddle — DONE.** New cost-ledger test: `0.0000005 USD` → priced 1 µ$;
    `0.0000004999 USD` → sub-micro unpriced; float behavior verified before pinning.
13. **Aggregate SUM overflow neighborhood — DONE.** New test: 40 individually-valid $450M rows push the
    issue SUM past 2^53; admission must refuse `spend-cap-exceeded` with a finite spent figure > cap.
    Residual noted in-test: past 2^53 the µ$ total can drift off the exact sum (a ledger-level overflow
    guard would be a src change, out of scope).
14. **JSON-escaped single-line PEM — DONE.** New step-log test: `\n`-escaped block on one line is
    swallowed whole by the PEM arm (its `[\s\S]` matcher covers the two-char escape), including the short
    tail line.
15. **Hardcoded grace multipliers — PARTIAL/skip.** `120_000` literal at the `.orphan.` park test now
    reuses `WELL_PAST_LOCK_GRACE_MS`. Deriving from imports is blocked: `OWN_LOCK_GRACE_MS` is
    module-private in `src/providers/run-record.ts` and I do not own `src/**` — exporting it is left to
    the fixer if wanted.
16. **auth-static dist fixture teardown guard — DONE.** afterAll validates every tracked path is inside
    `dist/` before removing (a future `write()` escape fails loudly instead of deleting an operator file).
17. **"racing admission" title honesty — DONE.** Renamed to "two SEQUENTIAL admissions simulate the race",
    with a pointer to where real concurrency serialization is pinned.

## Skipped (with why)

- **Exact `<` vs `<=` equality instants** (items 3/S28): not discriminable on a moving wall clock with no
  clock-injection seam; deterministic inner-edge arms + comments instead (see note above).
- **S28 pipeline-run**: added exactly the one permitted inner-edge boundary case (witness seconds inside
  ±30 min still honoured); nothing else touched in that file.
- **qds-cost full-view fixture**: confirmed passing this round; no changes needed.
- **tests/scripts/**: no reviewer items landed here; suite green as-is.

## Counts

- Files touched: 8 (7 owned + the permitted `pipeline-run.test.ts`).
- Tests added: 11 (close-retirement boundary, tombstone mtime boundary, rounding straddle, SUM overflow,
  JSON-escaped PEM, clean-listing sweep, 3 traversal encodings via `test.each`, truncated-JSON quarantine
  row via `test.each`, S28 inner edge).
- Tests modified: 6 (predicate pin, leak-scan breadth, tombstone EEXIST pin, 2 lock upper bounds, racing
  rename; plus helper/fixture wiring inside budget-gate).
