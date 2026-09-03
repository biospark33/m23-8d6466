# Edge Case Review: CLI + Rank Chunks

## Summary
Reviewed PR chunks for scripts/fleet.ts CLI (fanout/rank verbs, cost caps, rosters, --steps-json, loser ledger) and src/fleet/rank.ts + src/providers/*.ts. Found 1 LOW-severity issue, rest well-protected.

---

## Findings

### [LOW][RISK] --roster duplicate entries not deduplicated

**File:** scripts/fleet.ts:1576-1580

**Trigger scenario:** `fleet fanout --pattern best-of-n --n 2 --roster "model-a,model-a"`

**Evidence:**
```typescript
const rosterIds = flags
  .get("--roster")
  ?.split(",")
  .map((s) => s.trim())
  .filter((s) => s !== "");
```

**Analysis:** The split-trim-filter chain does NOT remove duplicates. Duplicate roster entries pass through to fanout(). At line 1598, the roster-count check (`rosterIds.length !== n`) would pass for `n=2` with 2 duplicate entries, causing the fanout to provision 2 arms with the same roster model. This degrades the N-arm experiment to a single-model run without error.

**Impact:** LOW - fails silently but degrades experiment quality rather than causing data loss or incorrect billing. Duplicates are statistically harmless (the model runs twice), just wasteful.

**Recommendation:** Add `.filter((v, i, a) => a.indexOf(v) === i)` after the trim chain if deduplication is desired.

---

## Verified Clean (No Action Needed)

### CLI Arg Boundaries

1. **`--cap-micro-usd` (scripts/fleet.ts:1553):**
   - Regex `/^[1-9]\d*$/` rejects "0", "-5", "1e3", " 5", "9999999999999999"
   - CAP_MAX_MICRO_USD (1e12) bounds check prevents overflow
   - Number.isSafeInteger check catches large values

2. **`--n` (scripts/fleet.ts:1542):**
   - Same `/^[1-9][0-9]*$/` regex prevents hex, exponent, zero, negative
   - FANOUT_MAX_N bounds check

3. **`--roster` empty handling (scripts/fleet.ts:1584):**
   - `--roster ""` and `--roster ","` caught: empty array triggers refusal

4. **`--steps-json` path traversal (scripts/fleet.ts:1844-1865):**
   - statSync + isFile() check prevents directory/FIFO attacks
   - 1 MiB cap enforced pre-read
   - Missing file caught by readFileSync try/catch

5. **Flag-type conflicts (scripts/fleet.ts:176-197):**
   - Startup check catches `--flag` declared both boolean and value
   - Help-token invariants enforced at module load

6. **Boolean with value (scripts/fleet.ts:569-573):**
   - `--no-harvest=true` caught before parseValueFlags

### Rank.ts Scoring

7. **Tie detection (src/fleet/rank.ts:172):**
   - `toFixed(10)` correctly handles IEEE-754 drift for 0.1 comparison

8. **Score clamping (src/fleet/rank.ts:263):**
   - Weights sum to 1.0, both terms [0,1], composite clamped to [0,1]

9. **Zero tests (src/fleet/rank.ts:93-94):**
   - `passed=0, failed=0` correctly yields passRate=0 (division by zero guarded)

10. **Null testResults (src/fleet/rank.ts:126-133):**
    - `null !== undefined` check prevents null-testResults from passing guard and crashing on `.passed` access

### Cost-Ledger

11. **Cap boundary (src/providers/cost-ledger.ts:975-988):**
    - Numerator integrality check BEFORE division prevents float drift mispricing
    - `rate * lifetimeMs` checked with Number.isSafeInteger
    - Math.ceil ensures sub-µ$ lifetimes cost at least 1 µ$
    - Final costMicroUsd also validated as safe integer

12. **Negative caps:** CostLedger.refuses negative via Number.isSafeInteger < 1 checks (implicit in numeric validation)

13. **Double close (src/providers/cost-ledger.ts:770-772):**
    - SQLite close() is idempotent; double close does not throw

### ExeDev

14. **IFS vulnerability (src/providers/exedev/assertions-in-box.sh:35-36):**
    - Fix is correct: printf emits space+tab+newline+x, then strips sentinel-x
    - Old single-quote bug (`IFS=' \t\n'`) was F11; new code handles literal backslash-t/n correctly

15. **Destroy retry (src/providers/exedev/driver.ts:335-345):**
    - Two-attempt loop with list confirmation after rm exit 0
    - Survives F7 (rm falsely claiming success) incident pattern

16. **Workdir injection (src/providers/exedev/fill.ts:98-112):**
    - assertWorkdirSafe validates charset and rejects ".." segments
    - shQuote is secondary defense (script injection via sh -c)

17. **Bundle cap (src/providers/exedev/fill.ts:747-753):**
    - 512 MiB default ceiling prevents unbounded host memory commitment
    - Checked pre-exec, throws before box mutation

---

## Conclusion

**1 LOW severity issue found:** --roster duplicates not deduplicated (silent degradation, no data loss).

All other boundaries well-protected: numeric gates reject edge cases, path traversal blocked, scoring math sound, ledger bounds safe.
