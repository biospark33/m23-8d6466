# Blind review — tests/fleet/dispatch.test.ts (chunk-t1.diff)

Reviewed the diff alone. Overall this is an unusually rigorous suite (positive controls, absence-proof controls, boundary loops). Findings below; nothing rose to CRITICAL — no outright tautological-green mock was found — but several coverage gaps contradict the file's own claims.

**[HIGH]** Structured refusal-line assertion missing on ~a dozen refusal families, contradicting the file's own "shared minimum" claim
- `tests/fleet/dispatch.test.ts:267` (helper doc claims "this is the shared minimum they all now make"), missing at `:400` (forged runId loop), `:748` (absolute manifestPath), `:775` (symlink escape), `:805` (cwd-default root), `:896` (`expectRosterRefusal` — all six roster refusals), `:1114` (timeout-invalid loop), `:1171` (port-invalid loop), `:1198`/`:1217` (both run-id-in-use tests), `:2321` (gate returns undefined/null), `:3952` (expose-no-url + blank-URL loop), `:4047` (setPublic failure)
- Trigger: a regression that stops filing the structured `phase:"refused"` line for any of these codes keeps every one of these tests green — the AC4 evidence trail silently loses those exits while the suite reports full coverage. The doc comment explicitly says the gap was closed for all siblings; a dozen families show otherwise.

**[MEDIUM]** No test for a provider minting EXACTLY the requested cap
- `tests/fleet/dispatch.test.ts:2128` (over-mint clamp), `:2201` (under-mint informational)
- Trigger: the classification boundary is equal⇒silent, below⇒`mint-cap-differs` ok/success, above⇒`mint-cap-over-request` error. A regression that logs `mint-cap-differs` on every equal mint (perma-alert noise) or collapses equal into the error arm passes both existing tests — only the strict inequalities are pinned.

**[MEDIUM]** Gate item B has no arm for a present, non-empty, INVALID-JSON manifest
- `tests/fleet/dispatch.test.ts:2816` (B-arm block), `:2857` (empty-file arm), `:2880` (unreadable arm)
- Trigger: a half-done fill writing partial bytes produces truncated JSON — realistic, and distinct from all three tested shapes. Whichever arm claims it (presumably "limitMicroUsd absent", sending the operator to stamping instead of fill) or a parse throw inside the probe is completely unpinned.

**[MEDIUM]** fakeGate items A and C are never driven to failure through the real probe path
- `tests/fleet/dispatch.test.ts:2257` (A only via a hand-built `setupGate` return), `:2489` (C only as a literal note string in stubs); B/D/E have real drive-through tests at `:2816`+ and `:2918`
- Trigger: a probe regression in A (HEAD check) or C (.env mode check) — wrong grep target, wrong stat — ships green; the "five-assertion gate" is effectively three real items plus two stubs. The all-pass positive control cannot catch an individual arm rotting.

**[MEDIUM]** Throw from `keyApi.createKey` (or from the fill execs) mid-provisioning is untested
- `tests/fleet/dispatch.test.ts:2031` (raw create-throw is covered; the mint/fill legs of the same try are not), cf. `:3509` (only the timeout variant of a stuck mint)
- Trigger: box exists, record already written (INV-1) with `keyHash` undefined, no credential minted — which code fires, whether the payload hands the operator a teardownCommand for a box with no key, and what the record shows are all unpinned. This is exactly the crash-between-steps orphan shape the file's other tests exist to classify.

**[MEDIUM]** Cross-runId concurrency untested: headroom list-then-create TOCTOU
- `tests/fleet/dispatch.test.ts:1310` (the only concurrency test pins TWO dispatches sharing ONE explicit runId)
- Trigger: N concurrent dispatches with distinct ids (the DF3.2 fan-out shape the file itself cites) all `driver.list` before any creates — maxVms exceeded with every individual dispatch allowed. The shared mutable fakes make this trivial to stage; nothing exercises it.

**[MEDIUM]** Four abandoned-step tests accept a >1 s stall flipping WHICH step expires
- `tests/fleet/dispatch.test.ts:3532` (mint), `:3599`–`:3611` (setPublic), `:3646` (create), `:3717`–`:3753` (clone)
- Trigger: all four spend the clock at a seam then rely on "~1 s of margin keeps the window un-raceable." On a loaded CI loop stall longer than the margin, an intermediate step's real timer fires first, the refusal names the wrong step, and the test goes red reporting a wrong-step fault (flaky). Comments acknowledge "residual risk accepted" — four independent copies of the same accepted flake.

**[LOW]** `abandonedLine` settle window is a 50 ms real-time bet the file elsewhere rejects
- `tests/fleet/dispatch.test.ts:315`–`:329`
- Trigger: the helper's own `toHaveLength(1)` guard can be defeated by a second abandoned line arriving >50 ms after the first — a multi-abandon regression passes. The file's stated philosophy ("yield N times is a bet on the scheduler") is violated by its own helper's backstop window.

**[LOW]** FIFO anti-hang test silently skips wherever `mkfifo` is absent
- `tests/fleet/dispatch.test.ts:941`–`:943`
- Trigger: on a minimal CI image the whole hang-regression test vanishes with only a skip marker — the exact skip-hides-green shape the file itself condemns for the chmod fixture at `:2876`.

**[LOW]** `repoRoot: undefined` test reads the real repository tree via `process.cwd()`
- `tests/fleet/dispatch.test.ts:805`–`:832`
- Trigger: the refusal depends on `manifests/pipeline.json` NOT existing at the repo root. If the working tree ever grows that file (plausible — this project writes manifests), loadManifest succeeds and the dispatch proceeds past the asserted point, spending a real ledger admission inside a unit test. Behavior coupled to unrelated repo contents.

**[LOW]** Record posture (open vs closed) unpinned on provision-failure
- `tests/fleet/dispatch.test.ts:2031`–`:2062`
- Trigger: the gate-failure sibling pins `closedAt` undefined (`:2278`); the create-throw path asserts the record exists but never whether it stayed open. A regression closing the record on provision-failure (or leaving contradictory state) passes.

**[LOW]** Missing exit-code assertions on two error paths
- `tests/fleet/dispatch.test.ts:3897`–`:3921` (management-URL run-id test asserts code but not exitCode), `:512`–`:565` (hostile-key-name test likewise)
- Trigger: an envelope change reclassifying either refusal to exit 1 passes; every sibling pins the exit code.

**[LOW]** Exactly-at-limit roster case untested (only MAX_BYTES+1 refused)
- `tests/fleet/dispatch.test.ts:976`–`:994`
- Trigger: a `>` vs `>=` flip rejecting a legal exactly-maximal roster ships green — the positive-control roster is tiny, so the upper boundary is invisible from the accept side.

**[LOW]** Exact clock-expiry boundary untested (advance is ±1000 ms around the ceiling, never exactly at it)
- `tests/fleet/dispatch.test.ts:2637` (expiry at +1000), `:2693` (just-under at −1000)
- Trigger: a `left <= 0` vs `< 0` off-by-one at exactly-elapsed-equals-ceiling is unobserved.

**[LOW]** requestId reuse across sequential runs untested
- `tests/fleet/dispatch.test.ts:334`–`:481` (AC2 block covers supplied/malformed/absent, never a SECOND dispatch reusing the same id)
- Trigger: the file's own no-headroom test says "a retry correlates through this id" (`:1929`) — the documented retry flow reusing a requestId has no pinned behavior; join-collision or silent re-mint regressions are invisible.

**[LOW]** `expectRosterRefusal` omits the file's `UnexpectedSuccessError` guard
- `tests/fleet/dispatch.test.ts:894`–`:911` (contrast the idiom and its stated rationale at `:89`–`:99`)
- Trigger: unexpected success still fails, but via `expect(undefined).toBeInstanceOf(FleetError)` — right verdict, wrong diagnosis; inconsistent with the reason the guard class exists.

**[LOW]** Budget boundary spent == cap untested
- `tests/fleet/dispatch.test.ts:1511` (fixture pins 10M cap / 12M spent only)
- Trigger: the exactly-at-cap admit/refuse flip lives in the ledger, and the dispatch-side mapping of that outcome is pinned only for the strictly-over case.

**[LOW]** Fixture couplings that rot quietly
- `tests/fleet/dispatch.test.ts:875` (`VALID_ROSTER` hardcodes model alias `claude-haiku-4-5` — a schema-side rename kills the positive control for the whole roster family), `:1456` (`probes === 5` encodes MINT_RETRIES+1 as a bare literal — deliberate pinning, but the failure message names nothing)
- Trigger: upstream constant/alias churn surfaces as opaque fixture failures rather than named regressions.
