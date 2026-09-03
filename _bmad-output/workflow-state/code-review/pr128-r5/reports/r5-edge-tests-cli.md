# Edge Case Review: CLI Tests (PR128 Round 5)

## Findings

### [LOW] Test title misleading in rank stdout-truncation case
**File:** tests/fleet/cli.test.ts:246  
**Trigger:** Test titled "a rank whose scored table cannot print exits 6 with rankedAt stamped" actually tests rank with NO --steps-json (all scores null), not a "scored table"  
**Evidence:** The test provides no --steps-json (line 275), so rank produces unscored arms (score:null). The test verifies stdout truncation handling and rankedAt stamping, which is correct, but the title suggests a scored table. The "scored table" phrasing refers to the RankResult line itself, not the scores within it. Source: scripts/fleet.ts:1506 uses `stepOutputFor: () => null` for auto-rank; rank.ts:277-280 always stamps rankedAt regardless of scores.

### [LOW] No explicit test for --n 0 boundary
**File:** tests/fleet/cli.test.ts  
**Trigger:** While covered by the general range check (--n must be 1-8), an explicit test for `--n 0` would clarify the boundary behavior  
**Evidence:** The source rejects `n < 1` at scripts/fleet.ts:1291 with message "takes an integer 1-8". Verbs.test.ts covers the range implicitly through declared-exit-codes probes, but cli.test.ts has no explicit `--n 0` case to document this specific boundary.

### [LOW] No explicit test for empty {} as --steps-json
**File:** tests/fleet/cli.test.ts  
**Trigger:** Empty JSON object as --steps-json is valid and should list all arms unscored, but has no dedicated test  
**Evidence:** Source scripts/fleet.ts:1638 accepts `{}` as a valid object, rank.ts:240-242 produces rationale "fan-out has no ranked arms" for empty arms array (different case), but for {} with valid arms, all would be score:null. Covered implicitly by code paths but not explicitly tested.

### [LOW] Comment precision in 1 MiB cap test
**File:** tests/fleet/cli.test.ts:694  
**Trigger:** Comment says "makes the file 1 MiB + ~12 bytes" but the calculation is `JSON.stringify({ pad: "x".repeat(1024 * 1024) })`  
**Evidence:** The string "x".repeat(1048576) is exactly 1 MiB. The JSON wrapper `{"pad":"..."}` adds overhead (10 bytes for key/quotes/braces plus null terminator), making total > 1 MiB. The test correctly expects refusal; the "12 bytes" approximation is close (`{"pad":` = 8 chars, `}` = 1 char = 9 bytes UTF-8, plus parsing overhead). Functional correctness is maintained.

## Summary

- 3 LOW findings (documentation/clarity improvements, no functional bugs)
- No HIGH or MED severity issues found
- Test suite demonstrates good coverage of boundary conditions:
  - Empty roster (`--roster ","`) correctly treated as flag-absent
  - Fleet lock steal judgments properly test identity vs mtime
  - Stdout truncation (EAGAIN) correctly exits 6 with work landed
  - Size-checked flags refuse before store construction
  - Negative counts and malformed --steps-json properly rejected
