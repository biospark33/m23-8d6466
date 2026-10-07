#!/usr/bin/env node
// Driver-owned workflow tooling for the M1.3 unlazy scope (m1-3).
// Runs a targeted bun test slice and asserts: zero failures AND at least
// --min-pass passing tests (a 0-match -t filter is a vacuous pass — this
// closes that hole). Prints a success-only marker on success.
// Usage: node scripts/dev/verify-test-slice.mjs --file <path|dir...> [--filter <text>] --min-pass <n>
import { spawnSync } from "node:child_process";

const args = process.argv.slice(2);
function flag(name) {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}
const targets = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--file") targets.push(args[i + 1]);
}
const filter = flag("--filter");
const minPass = Number(flag("--min-pass") ?? "1");
if (targets.length === 0 || !Number.isInteger(minPass) || minPass < 0) {
  console.error("usage: --file <path...> [--filter <text>] --min-pass <n>");
  process.exit(2);
}

const argv = ["test", ...targets];
if (filter !== undefined) argv.push("-t", filter);
const res = spawnSync("bun", argv, { encoding: "utf8", timeout: 900_000 });
const out = `${res.stdout ?? ""}\n${res.stderr ?? ""}`;
const passMatch = out.match(/^\s*(\d+)\s+pass\b/m);
const failMatch = out.match(/^\s*(\d+)\s+fail\b/m);
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
