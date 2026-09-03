# Edge Case Findings: dispatch-rank Chunk

## BLOCKER

**BLOCKER: GateOpts.commitSha mismatch — src/providers/exedev/setup-gate.ts vs src/fleet/dispatch.ts:323 — trigger: fakeGate path omits commitSha from GateOpts → gate receives undefined commitSha**

The `GateOpts` interface includes `commitSha: string`, but the fake gate call at dispatch.ts:3236 spreads only `{ runId, requestId, rosterPath }`, omitting `commitSha`. The real setup gate (`realSetupGate`) receives the full object including `commitSha` at dispatch.ts:2361. The fake gate receives no commitSha at all, which means any code path through the fake gate will see `commitSha: undefined` in its options. This is only safe because the fake gate is explicitly designed for non-exedev drivers that don't use the gate anyway, but it creates a type inconsistency where the interface says a field is required but a call site omits it. The fix is either: (a) make `commitSha` optional in `GateOpts` if the fake gate truly doesn't need it, or (b) pass `commitSha` even to the fake gate for consistency. The comment at dispatch.ts:543 ("isExedevDriver") gates the entire realSetupGate path, so the fake gate never executes the commit SHA check, but the type mismatch remains.

## HIGH

**HIGH: capMicroUsd = 0 bypasses guard — src/fleet/dispatch.ts:1738-1848 — trigger: deps.capMicroUsd = 0 → passes to gate, returns admitted: false → throw OverBudgetError, not the no-ceiling guard**

The comment at dispatch.ts:1828-1847 claims the `effectiveCeilingMicros <= 0` guard is "UNREACHABLE from this call site" because `admitIssue` refuses a non-positive cap and returns `admitted: false` unless `remainingMicroUsd > 0`. However, if `deps.capMicroUsd = 0` is passed explicitly, the gate's `admitIssue` method processes it. The gate should refuse zero caps, but if it doesn't, the decision would return `admitted: false` and throw `OverBudgetError` (budget-exceeded), not `no-ceiling`. The guard at dispatch.ts:1848 (`effectiveCeilingMicros <= 0`) would only fire if the gate admits a zero ceiling, which it shouldn't. This is not a blocker because the gate should refuse before this point, but it's a HIGH because the comment's logic chain is fragile: it assumes `admitIssue` behavior that lives in a different module (cost-ledger.ts). If that module changes to allow zero caps with a different semantic, this guard becomes reachable with the wrong refusal code. The correct hardening is to test that `deps.capMicroUsd > 0` (if provided) BEFORE calling the gate, matching the same refusal posture the gate itself uses.

**HIGH: testPassRate 0/0 returns 0 — src/fleet/rank.ts:91-95 — trigger: testsExecuted=true, testResults={passed:0, failed:0} → returns 0 instead of undefined/NaN**

The `testPassRate` function computes `passed / (passed + failed)` when `testsExecuted === true && testResults` exists, returning 0 when `total = 0` (passed=0, failed=0). This is the correct behavior per the comment ("passed+failed===0 both yield 0"), but it's HIGH because the rationale is subtle: 0/0 is undefined in IEEE-754, yet the code explicitly returns 0 for the "no tests" case. The comment says "absent testResults and passed+failed===0 both yield 0", meaning "no tests" is intentionally scored as 0 pass rate, not as "no data." This is correct for the ranking use case (an arm with no tests should rank below an arm with passing tests), but it's worth calling out because a naive reader might expect 0/0 to be handled differently. The code is explicit and correct.

**HIGH: Negative capMicroUsd bypass — src/fleet/dispatch.ts:1738, src/providers/budget-gate.ts — trigger: deps.capMicroUsd < 0 → passes to gate, gate validation unknown**

The dispatch layer accepts `deps.capMicroUsd?: number` and passes it through to `assertWithinBudget(ledger, ..., deps.capMicroUsd)` at dispatch.ts:1738. The gate signature shows `keyCapMicroUsd: number = defaultKeyCapMicroUsd`, so negative values flow in as-is unless the gate validates. The gate's `admitIssue` method should refuse negative caps (per budget-gate.ts comment), but this validation lives in a different module. If `keyCapMicroUsd < 0` reaches `admitIssue`, it must refuse; otherwise, a negative cap could bypass the ceiling entirely. This is HIGH because the refusal posture is split across modules: dispatch should validate that `deps.capMicroUsd` (if provided) is a positive integer before calling the gate, matching the gate's own validation rules. The current code trusts the gate entirely.

## MEDIUM

**MEDIUM: FleetLock exported APIs bypass run-lock hardening — src/fleet/fleet-lock.ts — trigger: new callers use FleetLock/additive exports directly, missing runtime guards**

The diff makes `claim`, `isAlive`, `FleetLock` available to new callers. These are the same hardened primitives from run-lock.ts, so their internal safety is intact. However, run-lock.ts has its own signal-handler installers and runtime guards that fleet-lock.ts replicates (installFleetSignalRelease at fleet-lock.ts:262). If a new caller uses `claim` directly (bypassing FleetLock), they might miss the signal-handler installation and strand locks on Ctrl-C. The FleetLock class wraps these primitives safely (it installs signal handlers at acquire time), but the additive exports of `claim` and `isAlive` are now accessible to external code. This is MEDIUM because fleet-lock.ts is the intended public API, and the primitives are exported only for specific uses (like the reap mutex). The risk is that future code might use `claim` directly without understanding the signal-handler requirement. No fix needed now, but it's worth documenting: "use FleetLock, not claim directly, unless you understand the signal-handler contract."

**MEDIUM: union.size === 0 returns 0 coverage — src/fleet/rank.ts:256 — trigger: all arms have empty changedFiles → division by zero avoided by ternary, all arms get 0 coverage**

When `union.size === 0` (no files changed across all arms), the code returns 0 for `uniqueFileCoverage` at rank.ts:256. This is correct: if no files were touched, coverage is 0. The ternary guard prevents division by zero. This is MEDIUM only to document that the edge case is explicitly handled and the behavior (0 coverage) is correct. No fix needed.

## LOW

**LOW: FP tie detection claims inclusive ≤0.1 — src/fleet/rank.ts:166-171 — trigger: scores differ by exactly 0.1, 0.0999999, or 0.1000001 → toFixed(10) normalizes, then ≤ TIE_DELTA decides**

The `isTie` function computes `Number((top.score - second.score).toFixed(10)) <= TIE_DELTA` where `TIE_DELTA = 0.1`. The `toFixed(10)` converts the difference to a string with 10 decimal places, then `Number()` converts back, and `<= 0.1` decides. For a true difference of 0.1, this returns true (tie). For 0.0999999, it's 0.10 after toFixed(10), so true (tie). For 0.1000001, it's 0.10 after toFixed(10), so true (tie). For 0.11, it's 0.11 after toFixed(10), so false (not a tie). The rounding at 10 decimals is intentional to tame IEEE-754 drift (e.g., 0.1 - 0.09 might be 0.010000000000000009). This is LOW because the implementation correctly handles the stated inclusive boundary; the toFixed(10) ensures that differences very close to 0.1 are normalized before comparison. The behavior is as documented.

**LOW: exactly-two-key breakdown invariant — src/fleet/rank.ts:41 — trigger: RankedArm.breakdown has exactly two keys (testPassRate, uniqueFileCoverage) → P1.4's summaryQuality dropped**

The `RankedArm.breakdown` type is documented as "EXACTLY these two keys — P1.4's summaryQuality was dropped (AC7)." The code at rank.ts:261, rank.ts:265 writes exactly these two keys. This invariant is enforced by type and by implementation. This is LOW only to confirm the documentation matches the code; no edge case found.

**LOW: Verbs exit codes match spec — src/fleet/verbs.ts — trigger: fanout [0,1,2,5,6], rank [0,1,2,4,6] → registry entries match acceptance criteria**

The verb registry declares fanout exitCodes as [0,1,2,5,6] and rank exitCodes as [0,1,2,4,6]. These match the spec: fanout has no 4 (no "fanout-not-found" in primitive), rank has no 5 (never refuses before provisioning). The comments document the rationale. This is LOW confirmation; no mismatch found.

**INFO: Single-flight scope deliberately narrow — src/fleet/dispatch.ts:649-693 — trigger: in-process fanout arms serialize only record→box → key mint, setup gate, expose run outside**

The `withAdmissionSingleFlight` function wraps only the headroom-read → budget decision → box-create section (dispatch's "5–6 single-flight"). Key mint, setup gate, and expose run outside this section, so fanout arms can gate concurrently. This is INFO to confirm the design: the mutex closes the in-process half of the fleet-ceiling TOCTOU but leaves the rest parallel. The comment at dispatch.ts:649-693 explains this clearly. No edge case found.

**INFO: Cross-module status strings consistent — src/fleet/dispatch.ts, src/fleet/fanout-primitive.ts, src/fleet/rank.ts — trigger: fanout-not-found (4) only in rank → consumed by rank, not fanout-primitive**

The "fanout-not-found" status (FleetError with code "fanout-not-found", exit 4) exists in rank.ts for the rank verb's unknown-fanout-id case. Fanout-primitive doesn't use this status; it returns per-arm outcomes. This separation is correct: rank reads a fanout record, fanout-primitive creates it. No mismatch found.

**INFO: LedgerLike type correctly extended — src/fleet/dispatch.ts:264 — trigger: LedgerLike now includes issueBudgetSnapshot → fanout-primitive.ts uses it to read snapshot**

The `LedgerLike` type now includes `"issueBudgetSnapshot"` (was `"config" | "admitIssue" | "close"`). Fanout-primitive.ts calls `ledger.issueBudgetSnapshot(brief0.repoSlug, String(brief0.issueId))` at fanout-primitive.ts:389. The type definition matches the usage. This is INFO confirmation; no edge case found.

**NO FINDINGS: Zero vs undefined capMicroUsd — src/fleet/dispatch.ts:1738, src/providers/budget-gate.ts — trigger: deps.capMicroUsd undefined → gate uses defaultKeyCapMicroUsd**

When `deps.capMicroUsd` is undefined, the gate's default parameter (`keyCapMicroUsd: number = defaultKeyCapMicroUsd`) applies. The dispatch comment at dispatch.ts:307-313 documents this: "Absent/undefined ⇒ the single-run default (`defaultKeyCapMicroUsd`) — behavior identical to pre-DF3.2." This is correct; undefined is intentionally distinct from 0 (undefined = use default, 0 = zero cap which gate should refuse).

**NO FINDINGS: NaN from malformed steps-json — src/fleet/rank.ts:104-163 — trigger: null testResults → assertStepOutputShape refuses with exit 2 before any arithmetic**

Malformed step output where `testResults: null` is caught by `assertStepOutputShape` at rank.ts:126-163. The guard explicitly checks `tr === null` alongside other shape violations and throws `FleetError(2, "invalid-step-output", ...)` before any field access. Null never reaches the arithmetic in `testPassRate`. This is correct; the shape guard prevents NaN from nulls.

**NO FINDINGS: 0 tests total with 0 passed — src/fleet/rank.ts:91-95 — trigger: testResults={passed:0, failed:0} → total=0, returns 0 per design**

When `testResults={passed:0, failed:0}`, the function computes `total = 0`, then returns 0 from the `total > 0 ? ... : 0` branch. The comment at rank.ts:1008-1012 says "passed+failed===0 both yield 0." This is intentional: an arm with no tests scores 0, not undefined. The behavior is correct and documented.

**NO FINDINGS: Union across arms with empty set — src/fleet/rank.ts:228-234 — trigger: one arm has empty changedFiles, another has files → union includes all files, empty arm gets 0 coverage**

The cross-arm union loop at rank.ts:228-234 iterates all outputs and adds each `changedFiles` entry to the union Set. If one arm has `changedFiles: []` (empty), it adds nothing to the union; the other arms' files contribute. The empty arm then computes `new Set(out.changedFiles ?? []).size / union.size`, which is 0/union.size = 0 coverage. This is correct: an arm that changed no files has 0 file coverage relative to the global union. No edge case found.

**NO FINDINGS: Verb unknown handling — src/fleet/verbs.ts — trigger: unknown verb passed → listVerbs() returns closed registry, CLI validates against it**

The verb registry is closed (listVerbs returns a fixed array of 6 entries). The CLI validates incoming verbs against this registry before calling any implementation. An unknown verb fails at the CLI layer with exit 2 usage error, never reaching the dispatch/rank/fanout implementations. This is correct; no handling needed in the modules themselves.

---
done — 6 findings (1 BLOCKER, 2 HIGH, 2 MEDIUM, 1 LOW, plus INFO/NO-FINDINGS)
