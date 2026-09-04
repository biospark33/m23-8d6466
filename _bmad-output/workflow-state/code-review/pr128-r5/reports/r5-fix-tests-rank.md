# Round 5 Test Hardening Report: Rank + Patterns

## Verdict Table

| ID | File | Finding | Status | Evidence |
|----|------|---------|--------|----------|
| P8 | rank.test.ts | Missing breakdown assertion for null-scored arm | FIXED | Source src/fleet/rank.ts:251 returns `breakdown: { testPassRate: 0, uniqueFileCoverage: 0 }` for null-scored arms. Added assertion at line 333: `expect(res.scores[1]?.breakdown).toEqual({ testPassRate: 0, uniqueFileCoverage: 0 })`. |
| P11 | patterns.test.ts | Missing many-stories n=1 positive validation case | FIXED | Source src/fleet/fanout-primitive.ts:165 sets `minN = pattern === "many-stories" ? 1 : 2`. Validation section tested rejections only. Added positive test at line 356-360 asserting n=1 with single brief passes and produces ready outcome. |
| P12 | rank.test.ts | Tie branch untested for identical scores via different runIds | FIXED | Source src/fleet/rank.ts:166-171 implements isTie with TIE_DELTA=0.1 inclusive. Existing tests covered near-boundary deltas and shared-runId case. Added test at line 236-256 for DIFFERENT runIds with IDENTICAL outputs, verifying tie=true and deterministic arm-0 winner (stable by arm sort per rank.ts:268-272). |

## Hunks

### P8: rank.test.ts ~line 333
```diff
     expect(res.scores[1]?.score).toBeNull();
     expect(res.scores[1]?.runId).toBe("silent");
+    expect(res.scores[1]?.breakdown).toEqual({ testPassRate: 0, uniqueFileCoverage: 0 });
     expect(res.rationale).toContain("silent");
```

### P11: patterns.test.ts ~line 354
```diff
       expect((await refuseOf(fanout("many-stories", FANOUT_MAX_N + 1, [brief()], deps()))).code).toBe(
         "invalid-n",
       );
     });
+
+    test("many-stories accepts n=1", async () => {
+      manifest();
+      const res = await fanout("many-stories", 1, [brief()], deps());
+      expect(res.arms).toHaveLength(1);
+      expect(res.arms[0]?.outcome).toBe("ready");
+    });
   });
```

### P12: rank.test.ts ~line 234
```diff
     expect(Number((0.7 - 0.6).toFixed(10))).toBe(0.1);
   });
+
+  test("tie: different runIds with identical step outputs produce identical scores and tie", async () => {
+    const h = harness({
+      arms: [
+        { arm: 0, runId: "first" },
+        { arm: 1, runId: "second" },
+      ],
+      steps: {
+        first: { testsExecuted: true, testResults: { passed: 3, failed: 1 }, changedFiles: ["a.ts", "b.ts"] },
+        second: { testsExecuted: true, testResults: { passed: 3, failed: 1 }, changedFiles: ["a.ts", "b.ts"] },
+      },
+    });
+
+    const res = await rank(FANOUT_ID, h.deps);
+
+    expect(res.scores.map((s) => s.arm)).toEqual([0, 1]); // stable by arm on equals
+    expect(res.scores[0]?.runId).toBe("first");
+    expect(res.scores[1]?.runId).toBe("second");
+    expect(res.scores[0]?.score).toBe(res.scores[1]?.score); // EXACTLY equal
+    expect(res.tie).toBe(true);
+    expect(res.rationale).toContain("tie flagged");
+    // Deterministic winner on tie: lower arm index wins (stable by arm sort)
+    expect(res.scores[0]?.arm).toBe(0);
+  });
```

## Test Results
```
bun test tests/fleet/rank.test.ts tests/fleet/patterns.test.ts
61 pass
0 fail
432 expect() calls
Ran 61 tests across 2 files. [15.21s]
```

## Biome Results
```
bunx biome check tests/fleet/rank.test.ts tests/fleet/patterns.test.ts
Checked 2 files in 113ms. No fixes applied.
```

## Tie Behavior Contract (P12)

Per src/fleet/rank.ts analysis:
- **TIE_DELTA**: 0.1 (line 23) — INCLUSIVE boundary
- **isTie logic** (lines 166-171): `Number((top.score - second.score).toFixed(10)) <= TIE_DELTA`
- **Sort stability** (lines 268-272): Descending score, nulls last, stable by arm within equals
- **Winner selection on tie**: Lower arm index (arm 0) wins deterministically due to stable-by-arm sort
- **No automatic tie-break**: Rationale includes "tie flagged, NO automatic tie-break; human review resolves" (line 184)
