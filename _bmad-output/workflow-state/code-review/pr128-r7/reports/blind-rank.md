# Blind Review: rank+providers chunk

## [BLOCKER] cost-ledger.ts:L337 - division returns float, checked against integer, gap where unsafe float passes

**Trigger:** `rate * lifetimeMs` produces a float that happens to be within safe integer range but not exact (e.g., 50000000.7). `Number.isSafeInteger(50000000.7)` returns `false`, so the guard catches it. But if the float rounds to an exact integer (50000000.0), the guard passes, then `Math.ceil(numerator / MS_PER_HOUR)` is called on a float numerator. For large values near MAX_SAFE_INTEGER, the division can lose precision and return a value slightly off from the true integer division result. The subsequent `isSafeInteger` check on the result would catch the unsafe final value, but the intermediate float arithmetic already lost precision — a bug of principle in a module that prides itself on exact money math.

**Diff location:** L329-337

## [HIGH] rank.ts:L100 - division by zero guard inconsistent with testsExecuted semantics

**Trigger:** `testsExecuted === true` but `passed + failed === 0`. The guard `total > 0` returns 0, which is reasonable. But the comment on L93-95 says "`testsExecuted === true && testResults && passed+failed > 0) ? passed/(passed+failed) : 0` — absent testResults and passed+failed===0 both yield 0". The "absent testResults" case goes through the early return on L98, so that's fine. But if `testsExecuted === true` and `testResults` exists with `passed=0, failed=0`, the function returns 0. The inconsistency: the comment says `passed+failed > 0` is part of the condition, but the code has `total > 0` as a separate check after computing `total`. This is more of a documentation mismatch than a bug, but in a safety-critical scoring system, the comment should match the code exactly.

**Diff location:** L97-101

## [HIGH] fill.ts:L784 - size check converts NaN to number, bypasses validation

**Trigger:** `wc -c` outputs non-numeric content (e.g., "error: file not found" instead of a byte count). `Number(sizeProbe.stdout.trim())` returns `NaN`. The comparison `Number(...) !== bundleBytes.byteLength` is `NaN !== 12345`, which is always `true`, so the error is thrown. Good. But if `wc -c` somehow outputs "NaN" literally (unlikely but possible in corrupted filesystem scenarios), `Number("NaN")` returns `NaN`, same outcome. The real risk: if `wc -c` outputs "Infinity" (even more unlikely), `Number("Infinity")` returns `Infinity`, and the comparison `Infinity !== 12345` is true. These edge cases are caught. But the code should explicitly check for `isNaN` or use a regex to validate the output is purely numeric before comparison — defensive coding for external command output.

**Diff location:** L784-790

## [HIGH] fill.ts:L667 - workdir validation allows multiple consecutive slashes, silent normalization divergence

**Trigger:** User passes `workdir: "src///bundle"`. The regex `/^[A-Za-z0-9._/-]+$/` matches (slashes are allowed). `segments.split("/")` produces `["src", "", "", "bundle"]`. The check `segments.slice(1).includes("")` is `true`, so the path is rejected. Good. But what about `workdir: "//src"`? Segments: `["", "", "src"]`. `segments.slice(1).includes("")` is `true` (the second empty string after slicing), rejected. What about leading slash `/src`? Segments: `["", "src"]`. `segments.slice(1)` is `["src"]`, no empty strings, **passes validation**. But this creates an absolute path `/src`, not relative to HOME. The comment on L635-648 says "A relative default is image-agnostic: it resolves wherever HOME points. An absolute workdir override keeps working for embedders with a different layout." So absolute paths are intentional for embedders. But the validation allows paths starting with `/` without explicitly recognizing that as the absolute-path case. The code should either explicitly flag absolute paths (start with `/`) as a special allowed case, or reject them if they're not supported by the bundle path construction on L846-847 (which uses `../${bundleName}` - that breaks if workdir is absolute like `/src`).

**Diff location:** L663-677

## [MEDIUM] rank.ts:L176 - toFixed(10) rounds, may cause false positive tie

**Trigger:** Two arms have scores differing by just over `TIE_DELTA` (0.1), say 0.80000001 and 0.70000000. Difference is 0.10000001. `(0.10000001).toFixed(10)` produces "0.1000000100". `Number("0.1000000100")` is 0.10000001. `0.10000001 <= 0.1` is `false`. No tie. But what about 0.800000005 and 0.700000000? Difference is 0.100000005. `(0.100000005).toFixed(10)` produces "0.1000000050" rounded to "0.1000000050" (11 decimal places?). Actually, `toFixed(10)` rounds to 10 decimal places, so 0.100000005 rounds to 0.1000000050 → "0.1000000050" → but toFixed limits to 10 places, so "0.10000001" (the 11th digit causes rounding up). Then `Number("0.10000001")` is 0.10000001. `0.10000001 <= 0.1` is `false`. The rounding works correctly. But what if the difference is exactly 0.100000004999? `(0.100000004999).toFixed(10)` rounds to "0.1000000050" then to "0.10000001", same result. What about 0.099999995? That's less than 0.1, so it should be a tie. `(0.099999995).toFixed(10)` rounds to "0.10000000" → 0.1. `0.1 <= 0.1` is `true`, tie. That's correct because the true difference is less than 0.1. The toFixed approach seems sound for detecting if the difference is at or below 0.1, but the rounding direction could push a difference just under 0.1 to appear as exactly 0.1 (false positive tie) or just over 0.1 to appear as 0.1 (false negative tie). Given the weights and component ranges, the score granularity might be fine enough that rounding at 10 places is safe, but this is a heuristic, not exact.

**Diff location:** L171-177

## [MEDIUM] rank.ts:L274-278 - sort stable by arm, but null scores are grouped together with -1 sentinel

**Trigger:** Two arms have `null` scores (no step output). The sort uses `(b.score ?? -1) - (a.score ?? -1)`, so both become -1, difference 0, then `a.arm - b.arm` breaks the tie. This sorts null-scored arms by arm number in ascending order. That's deterministic and stable. But the sentinel -1 is hardcoded — if a valid score could be negative (impossible given the clamping on L269, but what if weights change?), the sorting would be wrong. The code should use a sentinel that's guaranteed to be outside the valid score range, like `Infinity` or `-Infinity`, or explicitly handle null in the comparator.

**Diff location:** L273-278

## [MEDIUM] assertions-in-box.sh:L450 - IFS reconstruction uses printf, subtle but correct

**Trigger:** The IFS reconstruction uses `IFS="$(printf ' \t\nx')"` then `IFS="${IFS%x}"`. This correctly produces IFS containing space, tab, newline (the `x` is removed). The alternative would be `IFS=$' \t\n'` in bash, but the script uses `sh` which might not support `$'...'`. The printf approach is POSIX-compatible. The fix from `IFS=' \t\n'` (literal backslash-t-n) to the printf approach is correct and fixes the bug where model names with 'n' or 't' were being split incorrectly. No bug found here — this is a good fix.

**Diff location:** L450-451

## [LOW] rank.ts:L142-143 - negative count check, but not overflow above MAX_SAFE_INTEGER

**Trigger:** `tr.passed` is `Number.MAX_SAFE_INTEGER + 1` (2^53). This passes the `!Number.isInteger(tr.passed)` check? Actually, `Number.isInteger(Number.MAX_SAFE_INTEGER + 1)` returns `true` (it's still an integer value, just not safe). The check on L141 `!Number.isInteger(tr.passed)` would be `false`, so it passes. The next check `tr.passed < 0` is `false`. The next check `tr.passed > Number.MAX_SAFE_INTEGER` catches it: `Number.MAX_SAFE_INTEGER + 1 > Number.MAX_SAFE_INTEGER` is `true`, so the error is thrown. Good. But the error message on L154-156 says "non-negative integer passed/failed counts" — it should mention the upper bound too for clarity.

**Diff location:** L141-149

## [LOW] cost-ledger.ts:L376-404 - issueBudgetSnapshot reads ceiling from config function, but doesn't validate it's a safe integer

**Trigger:** `capForIssue(this.config, slug, issue)` returns a value that's `Number.MAX_SAFE_INTEGER + 1`. This gets returned in the snapshot object. The caller might use this ceiling in arithmetic operations. The `admitIssue` function likely validates this, but the snapshot function doesn't. If the caller doesn't re-validate, overflow could occur downstream. The snapshot should validate the ceiling is a safe integer before returning it.

**Diff location:** L364-405

## [LOW] teardown.ts:L953 - destroyTarget falls back to runId, but runId might not match actual VM name if create failed mid-flight

**Trigger:** Provisioning: driver.create succeeds, VM named `vm-abc123`, but store.set(vmName) fails (e.g., DB write error). Crash happens. Record has no vmName. Teardown falls back to `runId` as destroy target. But the actual VM is named `vm-abc123` (generated by driver), not `runId`. Destroy attempts to destroy `runId` which doesn't exist, succeeds idempotently (no-op). The actual VM `vm-abc123` stays alive, billing continues. The fix comment says "`createRun` names the box after it", but `createRun` is the CLI function — the driver.generateName might produce a different name. The fallback assumes `driver.create` used `runId` as the name, but that's only true if the driver is implemented that way. The exe.dev driver implementation would need to guarantee this invariant for the fallback to be safe.

**Diff location:** L945-964

## NO FINDINGS in: credentials.ts path change (absolute to relative, documented, safe), driver.ts retry+verify (correctly handles rm lying), shell script max_tokens bound (correct, prevents cap overrun), models.json missing file handling (correct per AC5), harvest.ts workdir order (relative-first with absolute fallback is correct for migration).
