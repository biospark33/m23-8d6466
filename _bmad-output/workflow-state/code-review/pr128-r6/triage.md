# PR 128 Round 6 — Triage Ledger

14/14 reviewers completed (6 blind, 7 edge, 1 auditor). Auditor: 9/9 ACs PASS, rank formula exact match.
All conflicts adjudicated against real source by lead. Reviewer line numbers were frequently diff-relative
or hallucinated — all findings located by content before classification.

## PATCH — Wave 1 (source clusters)

### Cluster A — src/fleet/{fleet-lock,fanout,fanout-primitive}.ts (fixer-A)
| ID | Sev | Finding | Disposition |
|----|-----|---------|-------------|
| A1 | LOW | `classifyHolder` + `stealJudgedReapMutex` accept `pidStartTime` that is NaN/Infinity (typeof check only). NaN !== localMs → live owner can be judged recycled once aged >1h. | Add `Number.isFinite` gate; non-finite ⇒ unjudgeable ⇒ refuse/wait (fail-closed) |
| A2 | LOW | `lstartUtcMs` copied when `typeof number` without isFinite | Add isFinite to the additive-copy condition (fleet-lock.ts:678) |
| A3 | LOW | `requestId` empty string passes shape gate | Empty string ⇒ body unjudgeable ⇒ refuse (fail-closed). New-file-this-PR field; no back-compat risk |
| A4 | LOW | reap mutex file mode unverified | Verify `claim()` writes 0600; if explicit mode absent, add |
| A5 | LOW | fanout-primitive.ts:757 redundant spread of already-ArmOutcome object | Simplify |
| A6 | LOW | FleetLock additive exports (`claim`, `isAlive`) usable without signal-handler contract | One-line doc comment: "use FleetLock, not claim directly" |

### Cluster B — src/fleet/dispatch.ts + verbs.ts (fixer-B)
| ID | Sev | Finding | Disposition |
|----|-----|---------|-------------|
| B1 | MEDIUM | `deps.capMicroUsd` unvalidated at dispatch boundary (comment says validated elsewhere; gate module could change) | Guard at consumption site: positive safe integer else FleetError(2) |

### Cluster C — scripts/fleet.ts (fixer-C)
| ID | Sev | Finding | Disposition |
|----|-----|---------|-------------|
| C1 | LOW | `--cap-micro-usd` no domain upper bound (values to 9e15 µ$ accepted) | Refuse > 1e12 µ$ with usage error |
| C2 | LOW | `--roster ""` / `","` silently ≡ absent | Flag present but empty list ⇒ usage refusal |
| C3 | LOW | steps-json accepts `testResults` present + `testsExecuted:false` (inconsistent) | Refuse inconsistent combo at CLI parse |
| C4 | LOW | `(e ?? {}).message` catch pattern yields "undefined" on thrown non-Errors (ack write :1459, ledger closes :1784/:2319) | Robust message extraction helper |
| C5 | MEDIUM | loser-ledger close failure only escalates exit when code==0; when arm already failed, close failure may go unlogged | Verify :1776-1784; ensure failure ALWAYS logged |
| C6 | LOW | help text does not state `--dir` = fanouts dir for fanout/rank | Clarify help string |

## PATCH — Wave 2 (test clusters, after source settles)

### Cluster T1 — tests/fleet/patterns.test.ts (fixer-T1)
| ID | Sev | Finding | Disposition |
|----|-----|---------|-------------|
| T1a | LOW | redundant `toBeLessThanOrEqual(2)` after `toBe(2)` | Delete redundant line |
| T1b | LOW | n-boundary only rejection side tested | Add accept-side test at n=FANOUT_MAX_N |
| T1c | LOW | unknown-pattern refusal doesn't pin message | Add `toContain(<pattern>)` |
| T1d | MEDIUM | "deterministic race test" + AC8 concurrent test flagged flaky-by-construction | Verify barrier determinism; if wall-clock-dependent, make deterministic |

### Cluster T2 — tests/fleet/{fanout,rank}.test.ts (fixer-T2)
| ID | Sev | Finding | Disposition |
|----|-----|---------|-------------|
| T2a | LOW | misleading `dp:ok test-authored output` comment on onDisk() | Fix comment |
| T2b | LOW | weak errno cast before `.code` check | Add `instanceof Error` guard |
| T2c | LOW | union-of-empty (all arms `changedFiles: []`) not explicit | Add explicit test |
| T2d | LOW | lock-guarded-mutate test doesn't prove lock held | Assert lock file exists during mutation callback |

### Cluster T3 — tests/fleet/{helpers,cli,dispatch}.test.ts (fixer-T3)
| ID | Sev | Finding | Disposition |
|----|-----|---------|-------------|
| T3a | MEDIUM | deadPid() may return before OS-level reap visible to isAlive | Harden: verify not-alive (retry loop) before returning |
| T3b | LOW | armRows() cast hides malformed JSON lines | Guard parse with expect |
| T3c | MEDIUM | wedged-lock cleanup inside test body, not finally/afterEach | Move to guaranteed cleanup |
| T3d | LOW | tuple destructure before length assert | Reorder |
| T3e | LOW | liveChild() orphans on pre-push failure | try/finally around usage |

### Cluster T4 — tests/fleet/e2e/{tier1-lock,tier1-teardown}.live.test.ts (fixer-T4)
| ID | Sev | Finding | Disposition |
|----|-----|---------|-------------|
| T4a | HIGH | tier1-lock concurrent teardown may both win if first completes before second claims | Verify; if no start-barrier, add one |
| T4b | MEDIUM | tier1-teardown finally lacks key-revoke fallback when verb fails mid-chain | Add best-effort revoke if harness exposes it |

## DISMISS — verified false-positives / accepted design (count: 26)

1. blind TOCTOU `releaseReapMutex`/`removeIfUnchanged` — serialized under `.reap` mutex; residual compare-to-unlink window documented as accepted POSIX no-CAS limit (fleet-lock.ts:828-830, r10)
2. blind signal-handler-deletes-wrong-file — release() restores registration+mark on read failure (:527-528); signal handler is synchronous same-thread
3. blind fleetHeld.delete-before-read strand — ENOENT ⇒ nothing to strand; other errors restore marks
4. blind signal listeners stripped — `others` captured at SIGNAL time (:271), restored in finally (:276)
5. blind reap-mutex fleetHeld lifetime — intended, documented (:553-558)
6. blind claim() throw pre-install — installFleetSignalRelease() at :386 precedes claim; empty map release is no-op
7. blind fanout `winner >= arms.length` — `>=` is correct (rejects index==length); reviewer inverted own claim
8. blind fanout createdAt empty-string — reviewer self-struck
9. blind dir-fsync-after-rename — correct POSIX order (file fsync pre-rename, dir fsync post)
10. blind temp-file close→rename orphan — accepted crash window; `.tmp` swept
11. blind LedgerLike callers unverified — tsc green; single in-repo implementer updated
12. blind admission-tail kill -9 — dead process has no future dispatches
13. blind stampCorrelation cross-process lost update — distinct runIds (O_EXCL), no shared write
14. blind-cli --steps-json path traversal BLOCKER — no privilege boundary (operator reads own fs); isFile + 1 MiB cap + parse guards present
15. blind-cli MAX_ECHO undefined — defined scripts/fleet.ts:1016
16. blind-cli 1e20 cap passes — exceeds MAX_SAFE_INTEGER, already refused (C1 adds domain bound for the intermediate range)
17. blind-cli auto-rank silent degrade — `auto-rank-failed` stderr sentinel exists (:1747); stdout purity by design
18. edge fakeGate omits commitSha — receives full `o` incl commitSha (dispatch.ts:2368-2371); tsc enforces
19. blind rank rationale overlap — branches disjoint (tie requires two non-null scores)
20. edge rank 0/0, union-zero — documented design, guarded
21. edge-prov .git suffix / auth taxonomy / bundle-on-box — intentional design, git accepts both forms
22. edge-tests bothParked deadlock — already fixed in this diff (probe-based release, comment documents)
23. edge-e2e tier2 recovery regex BLOCKER — format verified: `newId("qds")` = `qds-YYYYMMDD-6hex`, regex matches exactly; vmName fallback covers box recovery
24. blind-t mutable closure state / fixture-assumes-impl — standard probe-interception pattern, deterministic by construction
25. blind-src-prim TRIVIAL comment nits ×3 — style
26. blind comment-drift items (round-4 ref, "ONE exception", "still no 5") — accurate history/registry references

## DEFER — none (all pre-existing-looking items verified as intentional design)

## decision_needed — none. C1 bound (1e12 µ$) chosen conservatively; surfaced in final report.
