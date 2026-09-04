# Review Round 5: cli.test.ts Fixes Report

## Verdict Table

| Finding | Verdict | Evidence |
|----------|----------|----------|
| P3 — misleading test title | FIXED | Changed title from "a rank whose scored table cannot print exits 6 with rankedAt stamped" to "a rank with no --steps-json whose result line cannot print exits 6 with rankedAt stamped" — title now accurately reflects that the test provides no --steps-json (all scores are null, nothing is "scored"). |
| P4 — missing explicit --n 0 boundary test | FIXED | Added test "fanout refuses --n 0 with exit 2 naming the 1-8 range" — tests --n 0 boundary case explicitly, matching the style of adjacent validation tests. Note: P4 originally suggested testing both fanout and rank, but the source shows rank does not accept --n at all (rank refuses it with "rank does not take --n"), so the test covers only fanout. |
| P5 — missing empty {} --steps-json test | FIXED | Added test "rank accepts empty {} --steps-json with all scores null and exits 0" — tests {} as valid steps-json with all arms unscored, matching adjacent test style. |
| P6 — comment arithmetic | FIXED | Changed comment from "1 MiB + ~12 bytes" to "1 MiB + 9 bytes" — verified by counting: `{"pad":"` is 8 chars + closing `}` = 1 char = 9 total. |

## Test Results

- `bun test tests/fleet/cli.test.ts`: **120 pass, 0 fail** (33.63s)
- `bunx biome check tests/fleet/cli.test.ts`: **No fixes applied**

## Hunks

1. **Line ~246** (P3): Retitled test from "a rank whose scored table cannot print exits 6 with rankedAt stamped" to "a rank with no --steps-json whose result line cannot print exits 6 with rankedAt stamped"

2. **Line ~4248** (P6): Fixed comment from "makes the file 1 MiB + ~12 bytes" to "makes the file 1 MiB + 9 bytes"

3. **Lines ~3711-3727** (P4): Added new test:
```typescript
test("fanout refuses --n 0 with exit 2 naming the 1-8 range", async () => {
  // Source rejects n < 1 with "takes an integer 1-8" (fleet.ts ~1291).
  // This test pins the --n 0 boundary case explicitly.
  reset();
  const code = await runCli(
    ["fanout", "--driver", "fake", "--pattern", "best-of-n", "--n", "0", "--roster", "a"],
    fanoutDeps(),
  );
  expect(code).toBe(2);
  expect(text()).toContain("--n takes an integer 1-8");
  expectNoBoxes();
});
```

4. **Lines ~4297-4332** (P5): Added new test:
```typescript
test("rank accepts empty {} --steps-json with all scores null and exits 0", async () => {
  // Source accepts {} as valid steps-json (all arms unscored). This proves the
  // happy path: an empty object produces a ranking line with every score null.
  const fanoutsPath = join(dir, ".sandbox", "fanouts");
  const fstore = new FanoutRecordStore({ dir: fanoutsPath });
  const id = mintFanoutId();
  fstore.create({
    fanoutId: id,
    requestId: "01234567-89ab-cdef-0123-456789abcdef",
    pattern: "best-of-n",
    n: 2,
    pin: "c".repeat(40),
    createdAt: new Date().toISOString(),
    arms: [
      { arm: 0, runId: "qds-20260101-00000a", briefHash: "a".repeat(64) },
      { arm: 1, runId: "qds-20260101-00000b", briefHash: "a".repeat(64) },
    ],
    winner: null,
    rankedAt: null,
    closedAt: new Date().toISOString(),
  });
  const stepsPath = join(dir, "steps.json");
  writeFileSync(stepsPath, "{}");
  reset();
  const code = await runCli(["rank", id, "--dir", fanoutsPath, "--steps-json", stepsPath], deps(""));
  expect(code).toBe(0);
  const result = JSON.parse(outOnly[0] as string) as {
    scores: { score: number | null }[];
    tie: boolean;
    rationale: string;
  };
  expect(result.scores).toHaveLength(2);
  expect(result.scores[0]?.score).toBeNull();
  expect(result.scores[1]?.score).toBeNull();
  expect(result.tie).toBe(false);
});
```

## Notes

- P4 test was scoped to fanout only after verifying that rank verb does not accept --n at all (source returns "rank does not take --n" error).
