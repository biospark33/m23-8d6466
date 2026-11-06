// check:coverage's --parallel coverage fold unions function hits across
// workers only from bun 1.4 (the MergedReport union redesign, oven-sh/bun#39930,
// reshaped the fold; 1.3.13's aggregate took the max per-worker hit count
// instead, under-counting a file covered by different workers and red-firing
// the 0.60 per-file floor). CI pins 1.4.2; local packageManager still declares
// 1.3.13 — this guard refuses the gate on anything older than 1.4.
const [maj = 0, min = 0] = process.versions.bun.split(".").map(Number);
if (maj < 1 || (maj === 1 && min < 4)) {
  console.error(
    `check:coverage needs bun >= 1.4 for the --parallel coverage fold (issue #503); got ${process.versions.bun}`,
  );
  process.exit(1);
}
