# fx1-driver — fixes for m2-3 review round 1

File: `tests/fleet/e2e/memory-combined.live.test.ts` (only file touched; untracked new file in this branch). No commits.

## Findings → edits

**F-001 (BLOCKER)** — L3 `settleRun` dropped the `problems` array (probe-battery verdict + m23-revoke-verified evidence-write refusals never reached the verdict). Added `...problems` to BOTH ternary arms.

**F-002 (BLOCKER)** — L2's `[kg-recall]` stderr assertion could never fire (team-lead-driver discards worker stderr on success). Re-seamed:
- PRIMARY: opens `join(artifactsDir, "trace", "trace.db")` via `openTraceReader` (`src/phase-engine/trace/reader.ts`), pages `readEvents(round.requestId)` (rowid cursor until `hasMore` false, `finally reader.close()`), collects `type === "worker_output"` rows, parses each `payload_json` (try/catch → recorded as `unparseable-worker-output-payload`, never dropped), and asserts at least one parsed envelope (`summary`/`output` text) contains `round.marker` — `expect(markerHits.length).toBeGreaterThan(0)`. Evidence records source class, count, `markerCarried`, and a scrubbed 400-char `markerSnippet`.
  - Typing note: the tracer writes `type` as loose `string` while the reader's row type pins the narrower `TraceEventType` union that lacks `"worker_output"` — cast at the comparison with a comment naming the types.ts gap. (`bunx tsc` caught this; fixed.)
- SECONDARY: recursive `[kg-recall]` artifact scan kept byte-for-byte; its two expects (`calls.length > 0`, `refusals ≡ []`) demoted to a record-only evidence line (`stderr-channel-recall`) with the `"stderrChannel": "record-only — worker stderr is discarded by team-lead-driver on success (observability gap filed)"` marker; a refusal present in ANY channel pushes a `kg-recall-refusal-in-artifact-channel` defect line into evidence (no throw — the primary seam owns the verdict).
- Comment naming the filed observability gap added at the evidence line; header block's "worker model turn" mechanism description updated to match.

**F-003 (MED)** — after the working-tree fixture existsSync check in L1: `Bun.spawnSync(["git", "cat-file", "-e", `${ctx.sha}:${ROSTER_FIXTURE_REL}`])` pre-spend guard; non-zero exit throws with the pinned-SHA-does-not-carry-fixture message. Both checks kept (staged copy reads the tree, in-box load reads the SHA).

**F-004 (MED)** — added `LEG_CEILINGS_MS`/`LEG_TOTAL_MS`/`LEG_TOTAL_HOURS`/`BOX_WORST_MICRO_USD` constants (2.7+2.4+3.6 Mms = 8.7 Mms ≈ 2.42 h; box worst ≈ $0.56 at 230,000 µ$/h). L0 spend print and L1 pre-fire stderr print now state `1 box, worst case ≤ 2.42 h across the three legs (2.7 + 2.4 + 3.6 Mms; ≈ $0.23/h) + 1 key capped 50000 µ$ → worst case ≤ $0.61 (ceilings, not expectation)`, computed from the constants, not hardcoded.

**F-005 (MED)** — after `expect(reharvest.exitCode).toBe(0)`: `expect(reharvest.stderr.includes("divergent")).toBe(false)` with the AC7 log-only-alarm comment; `divergentInReharvestStderr` recorded into the `dedup-after-reharvest` evidence line.

**F-007 (MED)** — in-box-recall evidence line gains `"serverDurationMs": null` (with the note that no landed seam exposes gateway-side server duration; host latencyMs rides the L1 side-channel row) and `"clientMs": "absent on success — the extension emits clientMs on refusals only"` as string markers.

**F-008 (LOW)** — `envFileBytes` → `envFileChars`. L1 dispatch `.catch` phase label → `"dispatch-verb-failure"` with `timedOut: e instanceof Error && /timeout/i.test(e.message)` (verified against live-harness.ts: `RunFleetTimeoutError` message is `runFleet timeout after N ms: …`; a `live-mirror:` comment names it).

**F-009 (LOW)** — before the closed-record `not.toContain(closed.keyHash)`: `expect(closed.keyHash ?? "").not.toBe("")` with the vacuous-guard comment.

**F-010 (LOW)** — `kgRecallEvents` rawControlChars scan now excludes 13 (CR) alongside 9 (tab); comment updated: tab and CR are line framing (CRLF files CR every line), not payload.

## Focal checks (verbatim)

1. `env -u QDS_E2E_LIVE -u QDS_E2E_TIER bun test tests/fleet/e2e/memory-combined.live.test.ts`
```
bun test v1.4.0 (34cbb9a40)

 0 pass
 5 todo
 0 fail
Ran 5 tests across 1 file. [129.00ms]
exit=0
```
2. `bun test tests/fleet/e2e/live-coupling-sweep.test.ts`
```
bun test v1.4.0 (34cbb9a40)

 37 pass
 0 fail
 37 expect() calls
Ran 37 tests across 1 file. [26.00ms]
exit=0
```
3. `bunx tsc --noEmit` → exit 0 (first run caught the `TraceEventType`-vs-`"worker_output"` non-overlap at line 663; fixed by the cast, re-run clean)
4. `bunx @biomejs/biome check tests/fleet/e2e/memory-combined.live.test.ts`
```
Checked 1 file in 25ms. No fixes applied.
biome-exit=0
```

No stale `envFileBytes` / `dispatch-verb-timeout` references remain (`grep` clean). `git status` for `tests/fleet/e2e/` shows only the one file (untracked, new in this branch).
