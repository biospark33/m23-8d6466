# Edge Case Review: fanout-primitive.ts

## NO FINDINGS

After exhaustive analysis of the fanout-primitive.ts primitive against the specified boundary conditions, no exploitable edge cases were found. The code demonstrates robust handling of:

### Boundaries Verified
- **n boundaries**: n=1 (many-stories), n=2..8 (best-of-n/race), n=8 (max) - all properly validated at :165-179. Briefs count validated (:178-179 for many-stories, :184-186 for best-of-n/race). Zero briefs or extra briefs rejected.
- **Headroom TOCTOU**: checkHeadroom at :269 runs INSIDE lock.acquire() (:263) with all mints at :371-377 also inside the same try block - no exposure window.
- **Mint ordering**: All N ids minted synchronously (:365-377) BEFORE runArms (:403) dispatches - no fallback path exists.
- **Semaphore**: semaphore(width) with Math.max(1, ...) guard at :402 prevents semaphore(0). finally block at :515-517 guarantees release even on throw.
- **Per-arm failure fan-in**: Promise.allSettled at :464 with uniform try-catch at :488-497 ensures sync/async errors collected identically.
- **Race poller**: probeArm uses atomic read-check-mutate pattern with store.mutate first-writer transition at :674-687. TimeoutError caught non-fatally at :691-695.
- **finally-release**: Lock release in finally at :423 executes even if store.create throws at :357 or checkHeadroom throws at :269.
- **Per-arm cap (capMicroUsd)**: undefined resolves to defaultKeyCapMicroUsd at :314. Validation at :219-225 rejects <= 0. F15 reconciliation at :308-344 ensures n×cap fits issue budget before any mint.
- **Signal mid-fanout**: FleetLock signal handlers (:262-283 in fleet-lock.ts) with releaseHeldFleetLocks (:223-250) handle destructive-phase preservation correctly. Record state preserved with closedAt=null.

### Design Strengths
- F15 budget reconciliation (:308-344) provides early, config-named refusal before any boxes are provisioned
- MARKER_UNUSABLE_TICKS_LIMIT (:70) with abandon logic at :585-594 prevents corruption-induced polling to ceiling
- LOSER_TEARDOWN_TIMEOUT_MS (:87, default 300s) bounds teardown duration while lock held
- Semaphore permit handoff at :446-450 prevents drift (decrement AND wake, not decrement then wake)
- disposeLosers filters armUnknown at :735, never tears down unknown-state boxes

### Theoretical (Non-Exploitable) Observations
- Integer overflow in need = n * cap at :334 requires cap ≈ $2B USD per arm, exceeds any practical budget
- Poller ceiling check at :583 has microsecond window where tick may begin near ceiling but operations complete slightly over - bounded by single probe duration (<< 1h ceiling), no lock held after release
- No bound on waiters queue growth in semaphore, but n ≤ FANOUT_MAX_N = 8 makes this self-limiting

---

Reviewed: 2026-08-25
Reviewer: Edge Case Hunter (blind-src-prim)
Scope: /Users/steve/QDS-Factory/src/fleet/fanout-primitive.ts (lines 1-830)
