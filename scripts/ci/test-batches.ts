#!/usr/bin/env bun
/**
 * Runs the suite as a sequence of small `bun test` processes instead of one big
 * one, and names the files in each batch so a crash points at its candidates.
 *
 * Issue #250, measured one hypothesis at a time:
 *   1. One `bun test` over all 196 files dies at ~6.4k spawns every time —
 *      `us_create_timer: returned null: 24` (EMFILE, exit 132) on bun 1.3.13,
 *      `eventfd() failed during loop init` (exit 134) on 1.4.2 — with zero test
 *      failures before the crash.
 *   2. `ulimit -n "$(ulimit -Hn)"` (0d8b97db): a no-op. The runner reports
 *      soft=hard=65536, so raising soft TO hard changes nothing.
 *   3. `sudo prlimit --nofile=1048576` (run 35637724630): the raise took effect
 *      — the step logged `fd after: soft=1048576` — and the suite still died at
 *      spawn(6396), the same point as under 65536. A 16x budget that buys zero
 *      extra spawns rules out the fd ceiling.
 *   4. Four sequential processes in one job (run 35639471439): shard 1 clean,
 *      shard 4 SIGABRT.
 *   5. Four processes on four separate RUNNERS (run 35641333046): shards 1 and
 *      2 green, shard 4 SIGABRT again at 180s on a VM of its own — ~1.6k spawns
 *      into a fresh machine.
 *
 *   6. Batches of 8 (run 35644090068): 24 of 25 batches ran clean; batch 3
 *      SIGABRT'd at 150s. Its eight files are tests/fleet/{approvers, attach,
 *      brief-schema, cli, dispatch}.test.ts plus three tests/fleet/e2e/ files —
 *      the spawn-heaviest corner of the suite.
 *
 * (5) rules out budget, ceiling and whole-run accumulation; (6) localises what
 * is left to a handful of spawn-heavy files. So the default is now ONE file per
 * process: the smallest bound available, and the batch listing means a file
 * that still cannot survive alone names itself in the log. The extra process
 * starts are cheap — the batches of 8 that held no heavy file finished in 0.1s.
 *
 * Batches run SEQUENTIALLY: the point is bounding per-process state, and this
 * repo's tests bind ports and write fixed temp paths, so parallel batches would
 * collide for reasons unrelated to #250.
 */
import { Glob } from "bun";

const BATCH_SIZE = Number(process.env.TEST_BATCH_SIZE ?? 1);
const rootArgs = process.argv.slice(2);

if (!Number.isInteger(BATCH_SIZE) || BATCH_SIZE < 1) {
  console.error(`TEST_BATCH_SIZE must be a positive integer, got ${process.env.TEST_BATCH_SIZE}`);
  process.exit(2);
}

// Bun's own four discovery patterns, over its full extension set, minus the
// trees it never scans. Kept verbatim from the docs rather than trimmed to what
// this repo happens to contain today: a narrower list silently stops running
// the first `*_spec.ts` or `*.test.mjs` anyone adds, and a suite that quietly
// skips files is worse than one that crashes. https://bun.com/docs/test/discovery
const EXTS = "{js,jsx,ts,tsx,mjs,cjs,mts,cts}";
const PATTERNS = [`**/*.test.${EXTS}`, `**/*_test.${EXTS}`, `**/*.spec.${EXTS}`, `**/*_spec.${EXTS}`];
const SKIP = /(^|\/)(node_modules|\.git|dist|\.sandbox|coverage)(\/|$)/;

const roots = rootArgs.length > 0 ? rootArgs : ["."];
const found = new Set<string>();
for (const root of roots) {
  for (const pattern of PATTERNS) {
    for await (const hit of new Glob(pattern).scan({ cwd: root, onlyFiles: true })) {
      const rel = root === "." ? hit : `${root.replace(/\/$/, "")}/${hit}`;
      if (!SKIP.test(rel)) found.add(rel);
    }
  }
}

// The file list is globbed, never hand-written: a hand-maintained directory
// list is how a suite quietly stops running part of itself.
const files = [...found].sort();
if (files.length === 0) {
  console.error(`no test files found under ${roots.join(", ")}`);
  process.exit(2);
}

const batches: string[][] = [];
for (let i = 0; i < files.length; i += BATCH_SIZE) batches.push(files.slice(i, i + BATCH_SIZE));

const assigned = batches.reduce((n, b) => n + b.length, 0);
if (assigned !== files.length) {
  console.error(`batching lost files: ${assigned} assigned, ${files.length} discovered`);
  process.exit(2);
}

console.log(`[batches] ${files.length} test files in ${batches.length} batches of up to ${BATCH_SIZE}`);

const failed: { batch: number; files: string[]; exit: number | null; signal: string | null }[] = [];
for (const [i, batch] of batches.entries()) {
  console.log(`\n[batches] ===== batch ${i + 1}/${batches.length} =====`);
  for (const f of batch) console.log(`[batches]   ${f}`);
  const t0 = Date.now();
  // `./`-prefixed, because a bare positional is a SUBSTRING FILTER to bun, not
  // a path: `bun test tests/a/b.test.ts` runs every discovered file whose path
  // CONTAINS that string. One file could then run in several batches, which
  // defeats the point of bounding a batch. A leading `./` makes it an exact
  // path. https://bun.com/docs/test/discovery
  // `--timeout 15000`: the spawn-heavy fleet/cli e2e tests sit at 5-6s on a
  // loaded host — right at bun's 5s default, so WHICH of them fails moves run
  // to run (2026-10-08, M2.2: dev showed the same population flake). 15s never
  // breaks a green test on a fast runner; it only stops the margin deaths.
  const proc = Bun.spawnSync(["bun", "test", "--timeout", "15000", ...batch.map((f) => `./${f}`)], { stdio: ["inherit", "inherit", "inherit"] });
  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`[batches] batch ${i + 1} exit=${proc.exitCode} signal=${proc.signalCode ?? "none"} in ${secs}s`);
  // The #250 crash arrives as a signal (SIGILL/SIGABRT) with a null exit code,
  // so anything that is not a clean 0 counts as a failure.
  if (proc.exitCode !== 0) failed.push({ batch: i + 1, files: batch, exit: proc.exitCode, signal: proc.signalCode ?? null });
}

if (failed.length > 0) {
  console.log("\n[batches] FAILED batches:");
  for (const f of failed) {
    console.log(`[batches]   batch ${f.batch} exit=${f.exit} signal=${f.signal ?? "none"}`);
    for (const file of f.files) console.log(`[batches]     ${file}`);
  }
  process.exit(1);
}
console.log(`\n[batches] all ${batches.length} batches green over ${files.length} files`);
console.log("BATCHED-SUITE-OK");
