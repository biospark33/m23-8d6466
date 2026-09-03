# PR 128 Round 7 — Triage Ledger

17 reports (11 blind, 4 edge, 2 split auditors). Auditors: 0 FAIL — all PARTIALs were chunk-scoping
artifacts cross-covered by the sibling auditor (AC7 rank formula PASS via auditor-b; AC1/3/4/5 PASS
via auditor-a). All conflict adjudications below verified against real source by the lead.

## PATCH — Wave 1 (source clusters)

### Cluster S1 — src/fleet/fleet-lock.ts (+ fleet-lock.test.ts, fanout.test.ts lock tests)
| ID | Sev | Finding | Disposition |
|----|-----|---------|-------------|
| S1a | LOW | Negative `createdAt` parses finite → judged ancient → reclaim eligible (fleet-lock.ts:743) | Fail-closed: negative parse ⇒ unjudgeable ⇒ refuse |
| S1b | LOW | Negative `pidStartTime` passes `Number.isFinite` gate (:679, :890) | Fail-closed: negative ⇒ unjudgeable ⇒ refuse |
| S1c | LOW | Far-future `createdAt` never ages → permanently unreclaimable lock | Treat future-beyond-slew as unjudgeable ⇒ refuse (keeps busy, surfaces diagnostic) |
| S1d | LOW | Signal-listener restoration loop (:323-328): one throwing `process.on` strands the rest | Per-listener try/catch |

### Cluster S2 — src/fleet/rank.ts (+ rank.test.ts)
| ID | Sev | Finding | Disposition |
|----|-----|---------|-------------|
| S2a | MEDIUM | Library boundary accepts `testResults` present + `testsExecuted !== true` → silent 0 score (rank.ts:91-95, assertStepOutputShape) | Refuse with named `invalid-step-output` — parity with CLI C3 posture |

### Cluster S3 — scripts/fleet.ts (+ cli.test.ts, verbs.test.ts)
| ID | Sev | Finding | Disposition |
|----|-----|---------|-------------|
| S3a | LOW | `--roster "a,,b"` silently drops empty segments (only fully-empty list refused, :1577-1585) | Refuse ANY empty segment when flag present |
| S3b | LOW | `--roster "x,x"` duplicates accepted → N-arm experiment degrades silently | Refuse duplicate roster ids |
| S3c | MEDIUM | Crash between `store.create` (arms:[]) and `store.mutate` (arms fill) leaves orphaned record; rank reports "no ranked arms" instead of surfacing orphan (fanout-primitive.ts:354-377) | Rank verb: `n>0 && arms.length===0` ⇒ named refusal "orphaned fanout record" with hint. Fail-safe: detect + refuse, never auto-delete |

### Cluster S4+S5 — fanout-primitive.ts (comment) + tests/fleet/e2e/live-harness.ts + tier1-fanout-refusal.live.test.ts
| ID | Sev | Finding | Disposition |
|----|-----|---------|-------------|
| S4a | LOW | Race winner = lowest arm index in same poll iteration — undocumented tie-break (fanout-primitive.ts:573-605) | Comment the deliberate rule |
| S5a | LOW | Evidence scrub only matches `sk-or-…` (live-harness.ts:131) | Add catch-all `sk-[A-Za-z0-9_-]{20,}` pass after specific patterns |
| S5b | LOW | `runIdFor` random suffix space only 1e4 (:114) | Widen to 1e6 |
| S5c | LOW | scratchClone generic git error when pinned SHA unfetchable | Wrap with "base SHA not fetchable" context |
| T-g | LOW | tier1-fanout-refusal acquires FleetLock but never verifies lock file on disk before launching verb | Assert existsSync(lockPath) post-acquire |

## PATCH — Wave 2 (test-only clusters, after source settles)

| ID | Sev | File(s) | Finding | Disposition |
|----|-----|---------|---------|-------------|
| T-a1 | MEDIUM | patterns.test.ts | `toBeGreaterThanOrEqual` where forced interleaving makes counts exact (:1004, :1228, :1295, :1301, :1322) | Tighten to exact where provably deterministic |
| T-a2 | MEDIUM | patterns.test.ts | Wall-clock `TICK_MS` sleep at :612 | Verify construction; make deterministic if wall-clock dependent |
| T-b1 | LOW | cli.test.ts | No negative `--cap-micro-usd` refusal test | Add `-1` refusal test |
| T-b2 | LOW | cli.test.ts | `1024*1024` magic number vs production constant | Use exported/imported constant if available, else comment link |
| T-b3 | LOW | cli.test.ts | New mkdtemp dirs (:1152,:1163,:1173) leak on failure | rmSync in finally |
| T-c1 | LOW | helpers.ts | deadPid 100ms budget → false infra-bug failures on loaded hosts (:170-186) | Extend budget to ~2s |
| T-d1 | LOW | fanout.test.ts | Malformed `createdAt` planted-body refusal untested | Add test (planted "invalid-timestamp" ⇒ fleet-busy) |
| T-d2 | LOW | fanout.test.ts | Old `.tmp` orphan sweep untested | Add planted-orphan sweep test |
| T-e1 | MEDIUM | tier1-harvest.live.test.ts (:137, :215) | Finally-teardown exitCode recorded to evidence, never asserted → VM leak passes green | Assert exit 0 when test body succeeded |
| T-f1 | MEDIUM | tier1-lock.live.test.ts (:56-58) | Barrier throws false-negative when first teardown finishes before 5s poll sights lock | Don't throw on unseen lock; fall through to exactly-one-5 assertion with distinct message |
| T-h1 | MEDIUM | tier2-dispatch + tier2-fanout | Final leak-check single `driver.list()`, no retry — measured 25s substrate lag → false "leak detected" | Retry listing with backoff out to ~40s |
| T-i1 | LOW | qds-cost.test.ts (:364) | Comment still says "ceiled whole hours" — F8 made billing fractional | Fix comment |

## DISMISS — verified false-positives / accepted design (count: 28)

1. blind-lock dir-mode chmod→stat TOCTOU — no privilege boundary (0700 own dir); POSIX no-CAS precedent (r6 dismiss #1 family)
2. blind-lock pidIsZombie fail-open — documented intentional; reclaim double-gated (aged + dead/zombie)
3. blind-lock day-99 lstart regex — parser observer-self-consistent on both sides of identity compare
4. blind-lock fsyncDir swallows errors — documented platform-compat tradeoff; claim() fsyncs file pre-link
5. blind-lock fsyncDir future-edit fragility — speculative, current code correct
6. blind-cli steps-json unbounded-read BLOCKER — no privilege boundary (r6 #14 precedent); FIFO/dir refused pre-read via isFile; stat-fail fall-through deliberate (message shape comment, scripts/fleet.ts:1852-1855)
7. blind-cli zero-cap message clarity — behavior correct; reviewer self-struck to NO FINDING
8. blind-cli negative cap — reviewer self-struck (regex + isSafeInteger both catch)
9. blind-cli repeated flags last-wins — standard CLI convention
10. blind-cli leading-space numeric — rejected cleanly with echoed input
11. blind-cli duplicate JSON keys — JSON.parse spec behavior
12. blind-cli brief-as-array — Zod rejects downstream
13. blind-rank cost-ledger float BLOCKER — contradicted by verified edge-cli #11 (numerator integrality before division, ceil, final safe-int check)
14. blind-rank rank comment/code mismatch — comment matches code exactly (verified :88-93; `total > 0` IS `passed+failed > 0`)
15. blind-rank wc -c NaN/Infinity — reviewer's own analysis shows all paths throw; self-struck
16. blind-rank fill.ts absolute workdir — intentional embedder support (documented); `../bundle` join consistent on both sides
17. blind-rank toFixed(10) tie heuristic — verified correct (edge-cli #7); r6 adjudicated
18. blind-rank sort sentinel -1 — clamp guarantees [0,1] range; sentinel safe while clamp invariants hold
19. blind-rank assertions-in-box IFS — reviewer confirmed fix correct, no bug
20. blind-rank error-message upper-bound wording — NIT
21. blind-rank issueBudgetSnapshot ceiling unvalidated — inputs canonicality-asserted; consumption sites validate
22. blind-rank teardown runId-name fallback — driver names box after runId; F6 tests cover both paths
23. blind-tcli settle-loop `toBeDefined` false pass — reviewer error: toBeDefined() FAILS on undefined
24. blind-tcli env-var rollback — try/finally restores on all exception paths
25. blind-tcli missing-roster-flag sibling — absent roster is legal (undefined ≠ present-empty)
26. blind-tcli liveChild BLOCKER — sleep self-expires in 30s; call-site kills on teardown; bounded
27. blind-tcli readonly DB visibility — WAL committed writes visible to readonly connections
28. blind-tfanout barrier-forced race "sequential" — in-process barrier legitimately forces acquire overlap in single-threaded JS; r6 T1d adjudicated adjacent construction
29. blind-tfanout allSettled scheduler-dependence — in-process race documented; subprocess cost unjustified
30. blind-tpatterns mock divergence / shared sink / constant pins / ingestCalls — inherent, serial, INV-6-intentional, already-exact respectively
31. blind-tpatterns 20s/30s test timeouts — tests spawn real host git; slack is for CI, not hiding SUT bugs
32. blind-te2ea runFleet backpressure deadlock — Promise.all drains both pipes concurrently with exited-race (verified :194-206); no deadlock, no floating rejections
33. blind-te2ea spawn-failure TypeError — Bun.spawn precedes try; throw propagates before finally exists
34. blind-te2ea evidence-write masking — already try/finally chained (evidence → cleanup, t1-1 :97-103)
35. blind-te2eb statSync mode bit — reviewer self-struck mid-analysis
36. auditor BLOCKER "AC7 not in chunk" — split-audit scoping artifact; auditor-b verified rank formula exact-match PASS

## DEFER — none.
## decision_needed — none. S3c orphan handling resolved fail-safe (detect + refuse, no auto-delete); S1c far-future resolved fail-closed (refuse reclamation, surface diagnostic).

## Lead close-out additions (post-wave, applied directly by lead)

- T-b1/T-b2/T-b3 (cli.test) — initially unassigned in wave spawn; lead applied: negative `--cap-micro-usd -1` refusal test; `MAX_STEPS_BYTES` exported from scripts/fleet.ts and imported by the over-cap test (r7-T-b2); `afterEach` sweep for per-test `fleet-test-*` scratch dirs (r7-T-b3).
- fixer-S3 leftover: S3-control test's unused `code` now asserted `toBe(0)` (matches C1-accepts fixture shape).
- tsc closure: fixer-S1's stealJudgedReapMutex guard narrowed with `typeof parsed.pidStartTime !== "number"` (TS18048).
- Flake closure: "run() leaves the process's signal handlers exactly as it found them" timed out at bun's 5s default under back-to-back load (8 in-process CLI round-trips); timeout raised to 20s with comment — timeout also wedged the lock for the following test (exit 6 cascade), so one flake became two failures. 2×140/140 green after.
- Pre-existing (NOT this PR): `marked` write-only var scripts/fleet.ts:2262 exists on origin/main (stash-verified); editor hint only, tsc exit 0. Left alone.
- Final gate: 484 pass / 0 fail across 8 focal files; biome clean on all 17 touched files; `bunx tsc --noEmit` exit 0; gitnexus detect_changes scope = PR's own fleet/CLI/test modules (run, runRace, installFleetSignalRelease, onSignal, classifyHolder, FanoutRecordView, assertStepOutputShape, rank, runIdFor, scrubText, scratchClone, tmpRoot, deadPid, harness).
