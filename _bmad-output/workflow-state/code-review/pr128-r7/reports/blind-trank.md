# Blind Review: rank.test.ts + verbs.test.ts

## NO FINDINGS

The test files demonstrate strong adversarial coverage:

### rank.test.ts strengths:
- **Float comparisons**: Uses `toBeCloseTo()` appropriately for score formula (L99-101), then deliberately tests IEEE-754 edge cases with BOTH `toBeGreaterThan(0.1)` (L232) and `toBeLessThan(0.1)` (L287) to prove the normalization straddle exists before asserting it's handled
- **Null vs missing distinction**: Explicitly tests `testResults: null` (L355-374) as a named refusal (invalid-step-output exit 2), not a TypeError
- **Boundary coverage**: 0 arms (L417-425), 1 arm (L541-567), empty union (L322-353), and all-zero scores (L293-320) are all exercised
- **Tie determinism**: Tests both float straddle directions (L210-240, L266-291), exact-equal scores (L259), and stable-by-arm ordering (L256-264)
- **Refusal paths**: Every bad input shape (negative counts, non-array changedFiles, non-object step output, MAX_SAFE_INTEGER overflow) asserts exitCode AND code AND message

### verbs.test.ts strengths:
- **Refusal coverage**: Both `fanout` and `rank` test argument refusals (missing required flags, malformed IDs, absent records) with stderr verification
- **Exit code exhaustiveness**: PROBES tables cover {0,1,2,4,5,6} with explicit excuses for the stdout-sink cases (exit 6) delegated to cli.test.ts
- **Integration realism**: fanout probes wire the full depot/ledger/record-store stack under tmpdir redirects (L805-840), never mocked away
- **Happy path with teeth**: fanout happy case (L887-892) validates BOTH ack lines AND the auto-rank summary appears in stdout

Minor observations:
- L1089 comment calls rank "driver-less by design" and asserts it's the ONE such verb — this is a barrier to re-introducing required flags, not a test gap

**Assessment**: The tests are genuinely adversarial. They refuse to assert exact equality on computed floats (use fuzzy `toBeCloseTo`), prove bugs exist before testing fixes, and validate both exit codes AND messages on all refusal paths.
