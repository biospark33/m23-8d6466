# Blind CLI Review — PR128 src-cli chunk

## [BLOCKER] Unbounded file read when stat fails
**File:** scripts/fleet.ts diff L826-847  
**Trigger:** `--steps-json` pointing to a file where `statSync` fails (e.g., permission denied, special file, racy symlink) but `readFileSync` still succeeds

When `statSync(stepsPath)` throws (caught and returns `undefined` at line 829-832), `stepsSize` becomes `-1`. The cap check `stepsSize > MAX_STEPS_BYTES` evaluates to `false`, so the file is read with `readFileSync(stepsPath, "utf8")` without ANY size limit. If the file is actually 100GiB, this pulls the entire contents into memory and likely OOMs the process.

## [HIGH] Zero cap silently treated as "no cap"
**File:** scripts/fleet.ts diff L525-535  
**Trigger:** User passes `--cap-micro-usd 0`

The regex `/^[1-9]\d*$/` rejects `"0"` (doesn't match), so `capMicroUsd` becomes `NaN`. The check `!Number.isSafeInteger(capMicroUsd) || capMicroUsd < 1` evaluates to `true` (NaN is not a safe integer), so a `usageError` is thrown. However, the error message `--cap-micro-usd ${JSON.stringify(capRaw)} is not a micro-dollar amount` with suggested range `1-${CAP_MAX_MICRO_USD}` could be misread as "0 is below minimum" when the real problem is "0 failed to parse". This is a minor documentation issue—BUT there's a worse case: if the validation logic were ever tweaked to allow 0 (e.g., "0 means unlimited"), it would need explicit handling. Currently it's a rejection, which is safe, but the error message could be clearer that "0 is not a valid value".

## [HIGH] Negative cap allowed through Number() coercion
**File:** scripts/fleet.ts diff L525-535  
**Trigger:** User passes `--cap-micro-usd -1` or any negative string

Wait—actually the regex `/^[1-9]\d*$/` would NOT match `"-1"`, so `capMicroUsd` becomes `NaN` and fails `Number.isSafeInteger()`. This is SAFE. The earlier concern was incorrect. Finding downgraded to LOW.

Actually, re-reading: if someone finds a way to bypass the regex (e.g., future code change adds a minus sign to the pattern), the subsequent checks `!Number.isSafeInteger(capMicroUsd) || capMicroUsd < 1` would catch negative values. The current defense in depth is good. NO FINDING.

## [MEDIUM] No duplicate detection on repeated flags
**File:** scripts/fleet.ts uses `flags.get("--flag")` throughout  
**Trigger:** User passes `--n 3 --n 5` or `--cap-micro-usd 1000 --cap-micro-usd 2000`

The `parseValueFlags` function returns the LAST value for repeated flags. This is standard CLI behavior (last one wins), but there's no warning to the user that they specified something twice. If the user intended to accumulate (e.g., `--roster a --roster b`), they'll get only `b`. The `--roster` flag DOES accept comma-separated values, so the issue is lessened there—but `--n` and `--cap-micro-usd` silently taking the last value could be surprising.

## [MEDIUM] Empty strings in comma-separated roster list
**File:** scripts/fleet.ts diff L549-553  
**Trigger:** User passes `--roster "a,,b"` or `--roster ",,"`

The split/map/filter pattern produces `["a", "", "b"]` with an empty string in the middle. The empty-string filter `s !== ""` at line 553 removes it—but `--roster ","` (single comma) produces an empty array, which is then caught by the "empty roster" check at lines 557-562. This is CORRECT behavior, but worth noting: the CLI silently collapses `a,,b` to `["a", "b"]` without warning the user about the double comma.

## [LOW] Leading space in numeric flag passes regex
**File:** scripts/fleet.ts diff L511-516, L525-527  
**Trigger:** User passes `--n " 5"` (with leading space) or `--cap-micro-usd " 1000"`

The regexes `/^[1-9][0-9]*$/` and `/^[1-9]\d*$/` do NOT match strings with leading whitespace, so `n` or `capMicroUsd` becomes `NaN`. The subsequent `Number.isInteger` and `Number.isSafeInteger` checks catch this and throw a usage error. This is SAFE—the rejection message `--n ${JSON.stringify(nRaw)} is not a fan-out width` shows the user exactly what they typed. LOW severity because it's caught early with a clear message, not a silent bug.

## [LOW] No protection against duplicate keys in JSON
**File:** scripts/fleet.ts diff L863 (JSON.parse of --steps-json)  
**Trigger:** User passes `--steps-json` file with `{ "a": 1, "a": 2 }`

ECMAScript specifies that JSON parsers accept duplicate keys and use the LAST value. The file would parse as `{ "a": 2 }` without any warning. This is standard JSON.parse behavior and not exploitable for crashes, but it IS a silent data-corruption vector: if the user made a typo and duplicated a runId, they'd get only the last score without knowing the first was ignored. This is inherent to JSON.parse—fixing it would require a custom parser or post-parse duplicate check. Probably not worth the complexity, but worth noting.

## [LOW] Brief JSON vulnerability: array passed to single-brief patterns
**File:** scripts/fleet.ts diff L605-622  
**Trigger:** User passes an array `[...]` as brief for `best-of-n` or `race` pattern

The code at lines 620-621 assigns `briefs = briefJson` (the array) directly. This array is then validated with `BriefSchema.safeParse(b)` at line 642. The Zod schema likely rejects arrays for single-brief patterns, so this would fail validation—but it's caught AFTER the brief is ingested and parsed. The rejection is correct, but the flow is: parse JSON → validate structure → reject. An attacker could theoretically craft a large array (within the 64KB cap) that passes JSON.parse but fails Zod validation, wasting CPU on validation. MINIMAL impact given the 64KB cap.

## [LOW] Potential number string coercion edge case
**File:** scripts/fleet.ts diff L875-897  
**Trigger:** `--steps-json` entry has `testResults: { "passed": "5", "failed": "2" }` (numbers as strings)

The validation checks `!Number.isInteger(tr.passed)` and `!Number.isInteger(tr.failed)`. `Number.isInteger("5")` returns `false` (it's a string), so this would correctly throw the "needs testResults with non-negative integer passed/failed counts" error. SAFE—the type guard works as intended.

## OBSERVATIONS (not findings)

1. **Path traversal**: `--steps-json` accepts any path including `../../../../etc/passwd`. This is a CLI tool running with user permissions, so this is expected behavior—the user can read whatever they have access to. No sandbox needed.

2. **Cost arithmetic overflow**: The cap is validated as a safe integer up to $1M (1e12 µ$). This is within `Number.MAX_SAFE_INTEGER` (≈9e15), so no overflow concerns. If the cap were ever raised significantly, overflow arithmetic would need consideration.

3. **Ledger double-close**: The `loserLedger.close()` is guarded with `handle !== undefined` and sets `handle = undefined` in a `finally` block at lines 298-303. Subsequent calls to `close()` are no-ops. Correct idempotent design.

4. **Error normalization pattern**: The code consistently uses patterns like `const x = (e ?? {}) as { message?: string }; x.message ?? e` (e.g., lines 733, 1029) to safely extract error messages from possibly-null thrown values. This is defensive programming—no findings here.

5. **Exit code consistency**: Every refusal path exits non-zero via `FleetError` (with its exit code) or `usageError` (which presumably creates one). Success paths exit 0. The final `finish()` call honors the collected code. Correct.

6. **Config files**: `roster.yaml` and `t2.pipeline.json` are read but the diff doesn't show the parsing code. Assuming they're parsed with proper schema validation elsewhere. The sparse YAML (only `defaults` and `roles` fields shown) suggests minimal assumptions—good.

## Summary

- **BLOCKER**: 1 (unbounded file read)
- **HIGH**: 0 (originally 2, downgraded on review)
- **MEDIUM**: 2 (duplicate flags, empty roster entries)
- **LOW**: 3 (leading spaces, duplicate JSON keys, brief array)

The BLOCKER finding is critical and should be fixed before merge. The MEDIUM findings are UX issues that could confuse users but aren't security vulnerabilities. The LOW findings are minor behavioral notes.
