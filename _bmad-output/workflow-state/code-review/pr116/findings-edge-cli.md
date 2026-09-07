server is called AFTER event parsing, not before. The real issue: observer throw doesn't affect internal loop, so this is actually LOW severity.

6. **merger.ts:94-97 — truncateWithSuffix creates invalid JSON when text.length > maxLength and suffix.length > maxLength**
   - Evidence: `if (proseBudget < 0) return suffix.substring(0, maxLength);`
   - Failing input: `maxLength === 10`, `text.length === 5000`, suffix is `"[truncated, 5000 chars total]"` (27 chars). `proseBudget === -17`, returns first 10 chars of suffix
   - Result: Summary contains `"[truncat"` — not parsable as the intended suffix format; unclear to consumers what happened
   - Fix: When `proseBudget < 0`, return a placeholder like `"[...]"` or the full suffix truncated to `maxLength`

7. **runner.ts:1091-1099 — Partial output loses trailing line when EOF at exactly cap boundary**
   - Evidence: `teamStdoutCapped` true skips `decoder.end()` call in finalize (line 1124-1130)
   - Failing input: Last line ends exactly at byte cap with no trailing newline; decoder has partial line buffered
   - Result: Line never parsed, could be `type: merged` or error message. Run misclassifies as lead_failure
   - Fix: In finalize, if `teamStdoutCapped`, still call `decoder.end()` but discard result rather than parsing; or parse only if safe

### MEDIUM

8. **runner.ts:470-471 — Exit facts incomplete when settle called from spawn error path**
   - Evidence: Settle from catch block line 895 doesn't set `lastExitCode`/`lastTermSignal` first
   - Failing input: Spawn fails, settle emits `exitCode: null, termSignal: null`
   - Result: Observer receives incomplete facts; caller may not distinguish spawn failure from child exit
   - Fix: Set dummy exit facts before spawn error settle, or accept nulls as valid for spawn-failure case

9. **runner.ts:303-307 — Watchdog stop on settle doesn't handle stop-then-settle race**
   - Evidence: `if (watchdog !== null) { watchdog.stop(); watchdog = null; }`
   - Failing input: Watchdog escalates, sends SIGTERM, then `close` arrives immediately (before grace timer fires)
   - Result: settle() stops watchdog, clearing graceTimer. This is correct behavior—no double SIGKILL. But watchdog.killOrigin already set to `"watchdog"`, which is correct
   - Actually no bug: stop() clears graceTimer, preventing SIGKILL. This is the intended race-winning behavior.

10. **watchdog.ts:655-687 — Sampler becomes permanently unwatchable on transient ps failure**
    - Evidence: `if (rssBytes === null) { unwatchable = true; ... if (!escalated) handle.stop(); }`
    - Failing input: `ps` command fails due to temporary resource exhaustion (EMFILE) or fork storm
    - Result: Watchdog stops escalating even if RSS recovers below threshold; subsequent polls never run
    - Fix: Retry on null a few times before marking unwatchable; or require consecutive failures

11. **runner.ts:1251-1253 — Watchdog not started on Windows, but no diagnostic emitted**
    - Evidence: `if (process.platform !== "win32" && child.pid !== undefined) { watchdog = startRssWatchdog(...) }`
    - Failing input: Run on Windows
    - Result: Silent noop; Windows users get no RSS protection, no explanation in logs
    - Fix: Log a warning that RSS watchdog is unsupported on Windows when `effectiveCeilingMicros` provided

12. **merger.ts:108-113 — partialOutput coercion loses empty string distinction**
    - Evidence: `opts.partialOutput !== undefined && opts.partialOutput !== null ? truncateWithSuffix(...) : null`
    - Failing input: Caller passes `partialOutput: ""` (empty failure output)
    - Result: Empty string coerced to null; caller loses distinction between "no output" and "field omitted"
    - Fix: Use truthiness check after explicit null/undefined filter: `opts.partialOutput == null ? null : truncateWithSuffix(...)`

### LOW

13. **types.ts:505-513 — EXIT_STATUSES array exists but never used for runtime validation**
    - Evidence: Array defined with comment "every runtime membership check derive from this array"
    - Failing input: Code manually assigns invalid status string, no guard checks against EXIT_STATUSES
    - Result: Type system allows it at runtime (type assertion), no invariant enforced
    - Fix: Add helper `isValidExitStatus(s: string): s is ExitStatus` and use at assign sites

14. **merger.ts:128-131 — Artifact name/path not validated as strings before redact**
    - Evidence: `artifacts: opts.artifacts.map((a) => ({ name: redact(a.name), path: redact(a.path) }))`
    - Failing input: Artifact entry has `name: 123` (number)
    - Result: `redact()` receives non-string, could throw if it expects string
    - Fix: Filter/validate artifacts array or coerce to string before redact

15. **pipeline-run.ts:51-53 — dispatchTask spec check doesn't guard against result.summary being undefined**
    - Evidence: `typeof mergedResult?.summary === "string" ? (mergedResult as { summary: string }).summary : ""`
    - Failing input: `mergedResult.summary` is `undefined`
    - Result: Defaults to empty string, which is correct. But the double-check is redundant—the ternary already handles it
    - Actually no bug: The `?? ""` fallback handles undefined correctly. LOW for redundancy.

16. **runner.ts:246-253 — effectiveCeilingMicros infinity/NaN bypassed but Infinity from division still possible**
    - Evidence: `if (opts.effectiveCeilingMicros !== undefined && Number.isFinite(opts.effectiveCeilingMicros) && opts.effectiveCeilingMicros > 0)` then `ceilingUsd = opts.effectiveCeilingMicros / 1e6`
    - Failing input: `effectiveCeilingMicros` is finite but `Number.MAX_SAFE_INTEGER`, division produces `Infinity`
    - Result: `Math.min(Infinity, 10)` === 10, so capped correctly. But wasted computation.
    - Fix: Check after division or clamp result to finite range

17. **watchdog.ts:730-731 — Escalation path with null rssBytes impossible but not statically prevented**
    - Evidence: Check `if (rssBytes === null)` returns early (line 722-732), so line 736 `rssBytes > thresholdBytes` never sees null
    - Failing input: N/A - early return prevents this
    - Result: No bug, but could be clearer by narrowing type in the `else` branch
    - Fix: Use type narrowing or assertion to make impossible path explicit to readers

18. **runner.ts:309-320 — onRunFacts callback throw logged but doesn't prevent settle completion**
    - Evidence: `try { opts.onRunFacts?.(...) } catch (err) { console.error(...); }`
    - Failing input: Observer throws
    - Result: Error logged, settle continues, resolve still happens. Correct behavior.
    - Fix: None needed; LOW for documentation that observer throws are intentionally non-fatal

## Summary

**BLOCKER (3)**: Abort signal race, RSS escalation false positive, partial output line-split loss

**HIGH (4)**: PGID reuse hazard, truncation format corruption, cap-boundary trailing loss

**MEDIUM (5)**: Incomplete exit facts on spawn failure, transient ps failure permanent unwatchable, Windows silent noop, empty string coercion loss

**LOW (6)**: EXIT_STATUSES unused, artifact validation missing, effectiveCeiling infinity edge case, type narrowing clarity, observer throw documentation
## Edge Case Findings

### BLOCKER

1. **runner.ts:382-394 — Abort signal race: signal can fire between `aborted` check and `addEventListener`**
   - Failing input: External code calls `abortController.abort()` during the 1-instruction gap between the truthiness check and listener registration
   - Result: Abort fires, `abortTeam` never runs, child process continues until its own wall-clock cap

2. **watchdog.ts:736-752 — RSS escalation false positive: killOrigin set before signal delivery fails**
   - Failing input: Process group exits between lines 740 and 747, `kill(2)` throws `errno.ESCH`
   - Result: `onEscalate` callback fired, `handle.killOrigin === "watchdog"`, but no SIGTERM sent; graceful exit misattributed to watchdog kill

3. **runner.ts:1074-1077 — Partial output collection under-reports when line splits mid-cap**
   - Failing input: `partialOutputBuffer.length === 9999`, `decoded` is `"AB\n"` (3 chars). `remaining === 1`, only `"A"` added, `"B\n"` lost
   - Result: Last line before cap partially lost, could drop critical error message or `type: merged` event

### HIGH

4. **watchdog.ts:756-774 — PGID reuse hazard: grace timer can SIGKILL unrelated process**
   - Failing input: Original process tree exits cleanly after SIGTERM, OS reuses the PGID for an unrelated process group before grace timer fires
   - Result: SIGKILL sent to innocent process, potential data corruption or crash

5. **merger.ts:42-44 — truncateWithSuffix creates invalid JSON when suffix length exceeds maxLength**
   - Failing input: `maxLength === 10`, `text.length === 5000`, suffix is `"[truncated, 5000 chars total]"` (27 chars). `proseBudget === -17`
   - Result: Summary contains `"[truncat"` — not parsable as intended suffix format; unclear to consumers what happened

6. **runner.ts:1124-1130 — Partial output loses trailing line when EOF at exactly cap boundary**
   - Failing input: Last line ends exactly at byte cap with no trailing newline; decoder has partial line buffered
   - Result: Line never parsed, could be `type: merged` or error message. Run misclassifies as lead_failure

7. **merger.ts:108-113 — partialOutput coercion loses empty string distinction**
   - Failing input: Caller passes `partialOutput: ""` (empty failure output)
   - Result: Empty string coerced to null; caller loses distinction between "no output" and "field omitted"

### MEDIUM

8. **runner.ts:895 — Exit facts incomplete when settle called from spawn error path**
   - Failing input: Spawn fails, settle emits `exitCode: null, termSignal: null`
   - Result: Observer receives incomplete facts; caller may not distinguish spawn failure from child exit

9. **watchdog.ts:722-732 — Sampler becomes permanently unwatchable on transient ps failure**
   - Failing input: `ps` command fails due to temporary resource exhaustion (EMFILE) or fork storm
   - Result: Watchdog stops escalating even if RSS recovers below threshold; subsequent polls never run

10. **runner.ts:1251-1253 — Watchdog silent on Windows with no diagnostic**
    - Failing input: Run on Windows with `effectiveCeilingMicros` provided
    - Result: Silent noop; Windows users get no RSS protection, no explanation in logs

11. **runner.ts:303-307 — Watchdog stop on settle doesn't prevent escalation mid-grace**
    - Failing input: Watchdog escalates, sends SIGTERM, then `close` arrives immediately (before grace timer fires)
    - Result: Actually correct—stop() clears graceTimer preventing SIGKILL. No finding.

11. **types.ts:128-131 — Artifact name/path not validated as strings before redact**
    - Failing input: Artifact entry has `name: 123` (number)
    - Result: `redact()` receives non-string, could throw if it expects string

### LOW

12. **types.ts:505-513 — EXIT_STATUSES array defined but never used for runtime validation**
    - Failing input: Code manually assigns invalid status string, no guard checks against EXIT_STATUSES
    - Result: Type system allows it at runtime (type assertion), no invariant enforced

13. **runner.ts:246-253 — effectiveCeilingMicros finite check bypasses division overflow**
    - Failing input: `effectiveCeilingMicros` is finite but `Number.MAX_SAFE_INTEGER`, division produces `Infinity`
    - Result: `Math.min(Infinity, 10) === 10` caps correctly, but wastes computation on impossible case

14. **watchdog.ts:730-731 — Escalation path with null rssBytes not statically prevented**
    - Failing input: N/A — early return prevents this
    - Result: No bug, but could use type narrowing for clarity to readers

15. **runner.ts:309-320 — onRunFacts callback throw logged but doesn't prevent settle**
    - Failing input: Observer throws
    - Result: Error logged, settle continues. Correct behavior—LOW for documentation
