#!/usr/bin/env node
// Driver-owned workflow tooling for the M1.3 unlazy scope (m1-3).
// Runs a targeted bun test slice and asserts: zero failures AND at least
// --min-pass passing tests (a 0-match -t filter is a vacuous pass — this
// closes that hole). Prints a success-only marker on success.
// Usage: node scripts/dev/verify-test-slice.mjs --file <path|dir> [--file <path|dir> ...] [--filter <text>] --min-pass <n>
// One value per --file; repeat the flag for multiple targets.
import { spawnSync } from "node:child_process";

function usage() {
  console.error("usage: --file <path|dir> [--file <path|dir> ...] [--filter <text>] --min-pass <n>");
  console.error("one value per --file — repeat the flag for each additional target");
  process.exit(2);
}

// F-024: every flag's value is bounds-checked — a missing value (end of argv
// or the next flag) is a usage error, never a silently-wrong run.
const args = process.argv.slice(2);
const targets = [];
let filter;
let minPassRaw;
for (let i = 0; i < args.length; i++) {
  const flag = args[i];
  const value = args[i + 1];
  const badValue = value === undefined || value === "" || value.startsWith("--");
  if (flag === "--file") {
    if (badValue) usage();
    targets.push(value);
    i++;
  } else if (flag === "--filter") {
    if (badValue) usage();
    filter = value;
    i++;
  } else if (flag === "--min-pass") {
    if (badValue) usage();
    minPassRaw = value;
    i++;
  } else {
    usage();
  }
}
const minPass = Number(minPassRaw ?? "1");
if (targets.length === 0 || !Number.isInteger(minPass) || minPass < 0) usage();

const argv = ["test", ...targets];
if (filter !== undefined) argv.push("-t", filter);
const res = spawnSync("bun", argv, { encoding: "utf8", timeout: 900_000 });
const out = `${res.stdout ?? ""}\n${res.stderr ?? ""}`;
// F-024: the summary tally is the LAST pass/fail match (retried/multi-block
// output ends with the final count) — never the first.
const passMatch = [...out.matchAll(/^\s*(\d+)\s+pass\b/gm)].at(-1);
const failMatch = [...out.matchAll(/^\s*(\d+)\s+fail\b/gm)].at(-1);
const pass = passMatch ? Number(passMatch[1]) : 0;
const fail = failMatch ? Number(failMatch[1]) : -1;
const ran = /Ran \d+ tests/.test(out);
if (res.status !== 0 || fail !== 0 || !ran) {
  console.error(`SLICE FAIL exit=${res.status} pass=${pass} fail=${fail} ran=${ran}`);
  const tail = out.trim().split("\n").slice(-25).join("\n");
  console.error(tail);
  process.exit(1);
}
if (pass < minPass) {
  console.error(`SLICE FAIL pass=${pass} < required ${minPass} (vacuous-pass guard)`);
  process.exit(1);
}
console.log(`SLICE OK pass=${pass} fail=0 min=${minPass}`);
