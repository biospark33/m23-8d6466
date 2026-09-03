# Edge Case Findings: patterns.test.ts Part A (lines 1-701)

## LOW

### [LOW] Missing validation coverage: many-stories n=1 valid case not tested in validation suite
- **File**: tests/fleet/patterns.test.ts:344-354
- **Trigger**: The validation test "best-of-n and race reject n=1" (line 344-354) tests rejection of n=1 for best-of-n and race, and rejection of n > FANOUT_MAX_N for all patterns. However, it does NOT test that many-stories n=1 is ACCEPTED as valid.
- **Evidence**: Source at src/fleet/fanout-primitive.ts:165 defines `minN = pattern === "many-stories" ? 1 : 2`, so many-stories n=1 is the minimum valid value. The many-stories n=1 success case is only tested later (line 1240+, outside this diff chunk in the D9/degenerate section). The validation suite (lines 337-421) should include a positive assertion that many-stories n=1 with a single brief passes validation.
- **Note**: The valid many-stories n=1 case IS tested elsewhere in the file (line 1240+, line 1353 per grep), so this is missing coverage in the validation section only, not a missing test entirely. The validation suite would be more complete with: `expect(await fanout("many-stories", 1, [brief()], deps())).resolves.toBeTruthy();` or similar.
