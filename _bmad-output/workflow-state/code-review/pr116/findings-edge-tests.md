ER
3. Race: child.pid file may not exist when next line reads it
Correct: `sleep 100 & echo $! > ${join(tmpDir, "child.pid")}` on one line, or use `$!` in same command as the `&`.

## HIGH

**tests/phase-engine/dispatch-task.test.ts:110**: Best-effort cleanup masks `rmSync` failures
```typescript
} catch {
  // best-effort
}
```
Silent `rmSync` failures can leave temp dirs accumulating across test runs, causing disk space leaks and potential "directory not empty" failures in later tests.

**tests/phase-engine/dispatch-task.test.ts:194**: Vacuous env var deletion comment is misleading
```typescript
// biome-ignore lint/performance/noDelete: unset is the semantic — assignment would leave "undefined" in the env.
delete process.env.QDS_TEAM_RUNNER;
```
The comment claims `delete` is required to avoid "undefined" in env, but process.env accepts `undefined` values - they become the string "undefined", which is actually a valid (though weird) value. The real reason for `delete` is semantic (unset vs set-to-empty), not technical impossibility.

**tests/phase-engine/dispatch-task.test.ts:1033**: `toThrow()` without message match is vacuous
```typescript
expect(() =>
  rosterToTeamManifest(roster, {...}),
).toThrow();
```
If `rosterToTeamManifest` changes to never throw (e.g., returns error object instead), this test still passes. Pin the message: `.toThrow(/worker|too many/i)`.

**cli-anything/test/merger.test.ts:156**: Regex used without null check
```typescript
const match = out.summary.match(/\[truncated, (\d+) chars total\]/);
expect(match).toBeTruthy();
expect(match?.[1]).toBeDefined();
```
`.toBeDefined()` on a string doesn't assert non-empty - `""` is defined. Should be `expect(match?.[1]).toBeTruthy()` or better `expect(match?.[1]).toBe("2500")`.

**cli-anything/test/merger.test.ts:221**: Type-erasure test comment contradicts itself
```typescript
} as any; // dp:ok intentional type-erasure — asserting the RUNTIME invariant rejects a missing required field, which the type system prevents by design
```
Comment says "which the type system prevents by design" but the whole point of the test is to verify the RUNTIME check catches what TypeScript missed. Contradictory explanation.

**cli-anything/test/runner-integration.test.ts:436**: Loop-generated tests share failure message
```typescript
for (const bad of [0, -1, Number.NaN]) {
  it(`invalid ceiling (${bad}) falls back to the manifest cap`, async () => {
```
If any of the 3 cases fail, the test name shows the value, but the assertion inside is identical for all 3. Can't tell which value broke without inspecting error details.

**cli-anything/test/watchdog.test.ts:606-610**: Timing-dependent test with imprecise sleep
```typescript
await sleep(275); // Should get ~4-5 samples (extra headroom for load)
handle.stop();
expect(sampleCount).toBeGreaterThanOrEqual(3);
```
Under load, `sleep(275)` can complete before 4-5 polls at 50ms intervals fire. Test flakes when samples = 2-3. Should either use `await sleep(300)` or accept `>= 2`.

**cli-anything/test/fixtures/team-bin/warren:21-34**: New test case without cleanup in finally block
```bash
case "big_cost"): {
  say(coms(1, "lead", "worker-a"));
  say(cost("worker-a", "openrouter/model-a", 9.5));
  say(workerOutput("worker-a", ["src/a.ts"]));
  await sleep(60_000);
  break;
}
```
The `await sleep(60_000)` hangs warren for 60s if the test doesn't match/complete. Missing timeout protection or cleanup in `finally`.

## MEDIUM

**cli-anything/test/merger.test.ts:200**: toThrow() message regex may match spuriously
```typescript
expect(() =>
  base({ testResults: { passed: 0, failed: 0 }, testsExecuted: true }),
).toThrow(/testsExecuted/);
```
`/testsExecuted/` is too generic - matches any error containing the word. Should be more specific: `/testsExecuted.*0.*0/i` or similar.

**tests/phase-engine/dispatch-task.test.ts:624**: `validateArtifacts` test assumes mkdtempSync behavior not guaranteed on all platforms
```typescript
const outside = mkdtempSync(join(tmpdir(), "qds-outside-"));
```
On some platforms, `mkdtempSync` relative to cwd may behave differently. Better to explicitly use `join(os.tmpdir(), "qds-outside-XXXXXX")` to guarantee cross-platform isolation.

**cli-anything/test/watchdog.test.ts:871**: Platform-skipped test leaves invisible gap in coverage
```typescript
describe.skipIf(process.platform === "win32")("real process group sampling", () => {
```
Windows gets zero coverage on process group sampling. Should have at least one Windows-specific alternative test or document why it's acceptable to not test this on Windows.

**cli-anything/test/runner-integration.test.ts:447-470**: `process.env.QDS_TEAM_RUNNER` snapshot relies on ambient environment
```typescript
const ambientRunner = process.env.QDS_TEAM_RUNNER;
...
expect(process.env.QDS_TEAM_RUNNER).toBe(ambientRunner);
```
If another test or process mutates `process.env` during execution (between the snapshot and assertion), this test fails spuriously. Should use beforeEach/afterEach to save/restore full env.

**tests/phase-engine/roster-adapter.test.ts:791-800**: afterEach cleanup assumes tmpRoot always exists
```typescript
afterEach(() => {
  if (fs.existsSync(tmpRoot)) {
    const entries = fs.readdirSync(tmpRoot);
```
Good check for existence, but `fs.readdirSync` can throw if directory is deleted mid-test (race with external process). Wrap in try/catch.

## LOW

**cli-anything/test/merger.test.ts:162**: JSON.stringify used to verify deep equality
```typescript
expect(JSON.stringify(out.result)).toBe(JSON.stringify(resultObj));
```
Redundant - `toEqual` already does deep equality. JSON.stringify could fail on circular structures (though not an issue here).

**cli-anything/test/merger.test.ts:278**: Assertion on behavior that's implementation detail, not contract
```typescript
expect(out.partialOutput).toBeNull();
```
Test name says "contract enforced here" but this behavior (partialOutput forced to null on success) is an implementation choice of buildMergedOutput, not a documented contract.

**tests/phase-engine/team-event-adapter.test.ts:1209**: Hardcoded fixture line count is fragile
```typescript
expect(results).toHaveLength(12);
```
If fixture file changes, test breaks. Consider reading fixture once in `beforeAll` and using length dynamically, or documenting why 12 is invariant.

**cli-anything/test/watchdog.test.ts:549**: Test name doesn't match assertion
```typescript
it("returns running status immediately after start", async () => {
  expect(handle.status).toBe("running");
  handle.stop();
```
"immediately after" implies timing guarantee, but test doesn't assert on timing - it just checks status is running whenever the check runs. Test name over-specifies.
# Edge Case Review Findings

## BLOCKER

**cli-anything/test/watchdog.test.ts:655-666** - Bash variable order-of-operations bug - Background `&` runs AFTER redirect, so `$!` captures wrong PID (subshell itself, not sleep process). Child may exit before PID written, creating race. Fix: `sleep 100 & echo $! > "$path"` on one line.

## HIGH

**tests/phase-engine/dispatch-task.test.ts:110** - Silent cleanup masks `rmSync` failures - Accumulating temp dirs cause disk leaks and "directory not empty" failures across runs. Fail test on cleanup error or log explicitly.

**tests/phase-engine/dispatch-task.test.ts:194** - Misleading delete comment - Claims `delete` required to avoid "undefined" string, but `process.env.KEY = undefined` is valid (becomes "undefined"). Real reason is semantic, not technical impossibility.

**tests/phase-engine/roster-adapter.test.ts:1060** - Vacuous toThrow without message match - If implementation changes to return error object vs throw, test passes silently. Pin: `.toThrow(/worker|too many/i)`.

**cli-anything/test/merger.test.ts:156-157** - Weak assertion on regex capture group - `.toBeDefined()` passes on empty string. Should be `expect(match?.[1]).toBeTruthy()` or `expect(match?.[1]).toBe("2500")`.

**cli-anything/test/merger.test.ts:221** - Contradictory type-erasure comment - Says "type system prevents by design" but test verifies RUNTIME catches what TypeScript missed. Comment contradicts test purpose.

**cli-anything/test/runner-integration.test.ts:435** - Loop tests share failure context - Three cases `(0, -1, NaN)` share identical assertion - can't tell which value broke without inspecting error details. Split into separate `it()`.

**cli-anything/test/watchdog.test.ts:606-609** - Timing-dependent test with sloppy tolerance - `sleep(275)` expects 4-5 samples at 50ms but accepts 3-6. Under load, samples=2-3 fail. Use `sleep(300)` or accept `>= 2`.

**cli-anything/test/fixtures/team-bin/warren:28-34** - New case hangs for 60s on mismatch - `big_cost` case awaits 60s unconditionally if test flow doesn't match. Needs timeout/finally cleanup.

**tests/phase-engine/dispatch-task.test.ts:239-251** - Fixture cleanup outside afterEach/finally - `.tmp-five-worker-roster.yaml` cleanup in `finally` block inside test, not `afterEach`. If test throws before `finally`, file leaks. Move to `afterEach`.

**tests/phase-engine/dispatch-task.test.ts:291-319** - Same cleanup issue - `.tmp-one-role.yaml` written in test, cleaned in `finally`. Same leak path if test throws early.

## MEDIUM

**cli-anything/test/merger.test.ts:199** - Overly permissive error regex - `/testsExecuted/` matches any error containing the word. Should pin to invariant message: `/testsExecuted.*sum.*0/i`.

**tests/phase-engine/dispatch-task.test.ts:604** - Platform-sensitive mkdtempSync assumption - Comment explains OS tmpdir needed, but test relies on `mkdtempSync(join(tmpdir(), ...))` behavior that may differ across platforms. Use explicit `join(os.tmpdir(), "...")`.

**cli-anything/test/watchdog.test.ts:871** - Invisible Windows coverage gap - `skipIf("win32")` gives Windows zero process-group coverage. Either add Windows-specific alternative or document acceptable gap.

**cli-anything/test/runner-integration.test.ts:459-468** - Ambient env assumption without isolation - `ambientRunner = process.env.QDS_TEAM_RUNNER` snapshot assumes no concurrent mutation. Use `beforeEach/afterEach` save/restore full env or use `delete` without snapshot check.

**tests/phase-engine/roster-adapter.test.ts:791-799** - Race in cleanup check - `existsSync` guard doesn't prevent race between check and `readdirSync` if external process deletes directory mid-test. Wrap `readdirSync` in try/catch.

**tests/phase-engine/test-results.test.ts:2009-2026** - Env mutation without `delete` - Restores via assignment, not `delete`. Leaves `"undefined"` string in env if original was undefined. Use `delete` for proper unset semantics.

## LOW

**cli-anything/test/merger.test.ts:146** - Redundant deep equality check - `JSON.stringify` comparison unnecessary; `toEqual` already covers it. Harmless but verbose.

**cli-anything/test/merger.test.ts:278** - Tests implementation detail not contract - `partialOutput` forced null on success is implementation choice, not documented API contract. Test over-constrains future refactors.

**tests/phase-engine/team-event-adapter.test.ts:1207** - Brittle fixture length assertion - Hardcoded `toHaveLength(12)` breaks on fixture edits. Use `beforeAll` to read actual length or document why 12 is invariant.

**cli-anything/test/watchdog.test.ts:545-549** - Test name over-specifies - "immediately after start" implies timing but test only checks status, not latency. Name suggests stronger guarantee than asserted.

**cli-anything/test/runner-integration.test.ts:408-410** - Duplicate key assertion - `expect("error" in round).toBe(true)` redundant with `expect(round.error).toBeNull()`. `null` is defined, so `in` check adds nothing.

**cli-anything/test/merger.test.ts:109** - Unsorted array assertion assumes sort - `expect(Object.keys(out).sort()).toEqual(EXTENDED_KEYS)` relies on `EXTENDED_KEYS` being pre-sorted but doesn't assert it. If keys unsorted, test misleadingly passes.
