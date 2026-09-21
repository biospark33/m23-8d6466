#!/usr/bin/env bun
/**
 * Runs the whole suite as N sequential `bun test` processes instead of one.
 *
 * Issue #250: one `bun test` over all 196 files spawns ~6.4k subprocesses and
 * dies at spawn(~6.4k) every time — `us_create_timer: returned null: 24`
 * (EMFILE, exit 132) on bun 1.3.13, `eventfd() failed during loop init (out of
 * file descriptors?)` (exit 134) on 1.4.2 — with zero test failures before the
 * crash. Raising the fd ceiling does not move it: run 35637724630 crashed at
 * the SAME spawn(6396) with soft=hard=1048576 in force (the step logs the
 * before/after), where 65536 had been the limit for every earlier crash. A
 * 16x-larger budget that buys zero extra spawns is not a budget problem — it
 * is per-process state that accumulates across the run and is never reclaimed.
 *
 * A fresh process reclaims it. Each shard here starts clean and gets ~1.6k
 * spawns, a quarter of the observed cliff.
 *
 * Shards run SEQUENTIALLY on purpose: the goal is resetting per-process state,
 * not wall-clock. Tests in this repo bind ports and write fixed temp paths, so
 * concurrent shards would collide for reasons that have nothing to do with #250.
 *
 * The file list comes from a glob, not a hand-written directory list, and the
 * script refuses to report success unless every discovered file was assigned to
 * exactly one shard — a hand-maintained list is how a suite silently stops
 * running half of itself.
 */
import { Glob } from "bun";

const SHARDS = Number(process.env.TEST_SHARDS ?? 4);
const args = process.argv.slice(2);

// `--shard i/N` runs ONLY shard i, for one-runner-per-shard in CI. Without it
// every shard runs here, sequentially, which is the local/one-machine mode.
const shardArg = args.find((a) => a.startsWith("--shard="))?.slice("--shard=".length)
  ?? (args.includes("--shard") ? args[args.indexOf("--shard") + 1] : undefined);
const rootArgs = args.filter((a) => !a.startsWith("--shard") && a !== shardArg);
let only: { index: number; total: number } | undefined;
if (shardArg !== undefined) {
  const m = /^(\d+)\/(\d+)$/.exec(shardArg);
  if (!m) {
    console.error(`--shard wants i/N, got ${shardArg}`);
    process.exit(2);
  }
  only = { index: Number(m[1]), total: Number(m[2]) };
  if (only.index < 1 || only.index > only.total) {
    console.error(`--shard ${shardArg} is out of range`);
    process.exit(2);
  }
}

if (!Number.isInteger(SHARDS) || SHARDS < 1) {
  console.error(`TEST_SHARDS must be a positive integer, got ${process.env.TEST_SHARDS}`);
  process.exit(2);
}

// Bun's own test discovery patterns, minus the vendored trees it never scans.
const PATTERNS = ["**/*.test.{ts,tsx,js,jsx,mts,cts}", "**/*.spec.{ts,tsx,js,jsx,mts,cts}", "**/*_test.{ts,tsx,js,jsx,mts,cts}"];
const SKIP = /(^|\/)(node_modules|\.git|dist|\.sandbox|coverage)(\/|$)/;

const found = new Set<string>();
const roots = rootArgs.length > 0 ? rootArgs : ["."];
for (const root of roots) {
  for (const pattern of PATTERNS) {
    for await (const hit of new Glob(pattern).scan({ cwd: root, onlyFiles: true })) {
      const rel = root === "." ? hit : `${root.replace(/\/$/, "")}/${hit}`;
      if (!SKIP.test(rel)) found.add(rel);
    }
  }
}

const files = [...found].sort();
if (files.length === 0) {
  console.error(`no test files found under ${roots.join(", ")}`);
  process.exit(2);
}

// Deal round-robin: adjacent files in one directory land in different shards,
// so no single shard inherits a whole heavy suite.
const total = only ? only.total : Math.min(SHARDS, files.length);
const shards: string[][] = Array.from({ length: total }, () => []);
files.forEach((file, i) => shards[i % shards.length]!.push(file));

const assigned = shards.reduce((n, s) => n + s.length, 0);
if (assigned !== files.length) {
  console.error(`shard assignment lost files: ${assigned} assigned, ${files.length} discovered`);
  process.exit(2);
}

// The assignment above is deterministic and depends only on the sorted file
// list and the shard count, so `--shard 3/4` here selects exactly the files
// that shard 3 of a local 4-way run would take. Every shard in CI must be run
// with the SAME total, or the union stops covering the suite.
const toRun = only ? [[only.index - 1, shards[only.index - 1]!] as const] : [...shards.entries()];
console.log(
  only
    ? `[shards] ${files.length} test files, ${total} shards, running shard ${only.index} only (${shards[only.index - 1]!.length} files)`
    : `[shards] ${files.length} test files across ${shards.length} sequential bun processes`,
);

const failed: number[] = [];
for (const [i, shard] of toRun) {
  console.log(`\n[shards] ===== shard ${i + 1}/${shards.length}: ${shard.length} files =====`);
  const t0 = Date.now();
  const proc = Bun.spawnSync(["bun", "test", ...shard], { stdio: ["inherit", "inherit", "inherit"] });
  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`[shards] shard ${i + 1} exit=${proc.exitCode} signal=${proc.signalCode ?? "none"} in ${secs}s`);
  // A signal death (the #250 crash arrives as SIGILL/SIGABRT) has a null exit
  // code, so treat anything that is not a clean 0 as a failure.
  if (proc.exitCode !== 0) failed.push(i + 1);
}

if (failed.length > 0) {
  console.log(`\n[shards] FAILED shards: ${failed.join(", ")}`);
  process.exit(1);
}
console.log(
  only
    ? `\n[shards] shard ${only.index}/${total} green over ${shards[only.index - 1]!.length} of ${files.length} files`
    : `\n[shards] all ${shards.length} shards green over ${files.length} files`,
);
console.log("SHARDED-SUITE-OK");
