#!/usr/bin/env bun
/**
 * One-shot adopter for the exedev image pin ritual.
 *
 * The gate step of publish-exedev-image.yml fails ONCE per drift and prints the
 * constants to adopt; the ritual then hand-edits FIVE literals across FOUR
 * files (driver REF + BUILD_ID, the Dockerfile TOFU ARGs, the test's
 * measuredDefault copies, and the tracked-inputs digest). Every missed copy is
 * a red CI cycle discovered serially — #396 changed the Dockerfile ARG and
 * missed the test's second copy, and the whole drift triage of 2026-10-01
 * (hono 4.13.12 floating under @openrig/cli's caret range) took three cycles
 * to converge. This script performs the whole adoption from one gate log so
 * the next drift is: dispatch -> run this -> commit -> push.
 *
 * Usage: bun scripts/adopt-image-pin.ts <workflow-run-id>
 * Idempotent: already-correct literals are skipped; exits 1 when nothing changed.
 */
import { spawnSync } from "node:child_process";

const RUN_ID = process.argv[2];
if (!RUN_ID || !/^\d+$/.test(RUN_ID)) {
  console.error("usage: bun scripts/adopt-image-pin.ts <workflow-run-id>");
  process.exit(2);
}
const log = spawnSync("gh", ["run", "view", RUN_ID, "--log-failed"], { encoding: "utf8" });
if (log.status !== 0) {
  console.error(`cannot read run ${RUN_ID} logs: ${log.stderr.slice(0, 400)}`);
  process.exit(2);
}

// normalize: each GH log line is `<job>\t<step>\t<timestamp> <content>` —
// strip everything through the timestamp, then ANSI colouring (GH logs carry
// ESC as the LITERAL two chars `^[`), then stray CRs, so multi-line patterns
// can match.
const clean = log.stdout
  .split("\n")
  .map((l) =>
    l
      .replace(/^.*?\d{4}-\d{2}-\d{2}T[\d:.]+Z ?/, "")
      .replace(/\^\[[0-9;]*[a-zA-Z]/g, "")
      .replace(/\r/g, ""),
  )
  .join("\n");

// ── 1. the gate's own adoption block: the two driver constants ──────────────
// The log echoes the DRIVER FILE's own text too (comment placeholders name
// DEFAULT_IMAGE_REF), so take the LAST full block — the gate prints it once,
// at the verdict.
const adoptBlock = /export const DEFAULT_IMAGE_REF = \\?"(ghcr\.io[^"\\]+)\\?";\s*\n\s*export const DEFAULT_IMAGE_BUILD_ID = \\?"([0-9a-f]{16})\\?";/g;
let adopt: RegExpExecArray | null = null;
for (let m = adoptBlock.exec(clean); m !== null; m = adoptBlock.exec(clean)) adopt = m;
// A build-time TOFU failure (drift inside a Dockerfile RUN) kills "Build and
// push" before the pin-gate step runs, so the log carries no driver block but
// MAY carry measured TOFU literals. Adopt what the log proves; refuse only a
// log with neither (publish run 40317122238 is the first TOFU-shape drift).
const tofuLines = [...clean.matchAll(/R3-a TOFU: [^"]*? hashes to ([0-9a-f]{64}), not (NODE_SHA256|OPENRIG_TREE_SHA256)=/g)];
if (!adopt && tofuLines.length === 0) {
  console.error("gate log carries no adoption block and no TOFU drift — was this actually a pin failure?");
  process.exit(2);
}
const [newRef, newBuildId] = [adopt?.[1], adopt?.[2]];

if (newRef && newBuildId) {
  const driver = "src/providers/exedev/driver.ts";
  let driverSrc = await Bun.file(driver).text();
  let driverChanged = false;
  driverSrc = driverSrc.replace(
    /(export const DEFAULT_IMAGE_REF =\s*\n\s*")([^"]+)(")/,
    (whole, a, old, c) => {
      if (old === newRef) return whole;
      driverChanged = true;
      return a + newRef + c;
    },
  );
  driverSrc = driverSrc.replace(
    /(export const DEFAULT_IMAGE_BUILD_ID = ")([0-9a-f]{16})(")/,
    (whole, a, old, c) => {
      if (old === newBuildId) return whole;
      driverChanged = true;
      return a + newBuildId + c;
    },
  );
  if (driverChanged) await Bun.write(driver, driverSrc);
  console.log(`driver.ts: ${driverChanged ? "REF/BUILD_ID adopted" : "already current"}`);
} else {
  console.log("driver.ts: skipped — no gate block in this log (build-time TOFU shape); the gate-verdict run after re-dispatch carries it");
}

// ── 2. TOFU tree ARGs: measured-hash lines -> Dockerfile ARG + test copy ────
const measured = new Map<string, string>();
for (const m of tofuLines) {
  if (m[1] === undefined || m[2] === undefined) continue;
  measured.set(m[2], m[1]);
}

const dockerfile = "oci/exedev/Dockerfile";
let dfSrc = await Bun.file(dockerfile).text();
const test = "tests/scripts/build-exedev-image.test.ts";
let testSrc = await Bun.file(test).text();
let dfChanged = 0;
let testCopyChanged = 0;
for (const [name, hex] of measured) {
    if (name === undefined || hex === undefined) continue;
  dfSrc = dfSrc.replace(new RegExp(`(ARG ${name}=)([0-9a-f]{64})`), (whole, a, old) => {
    if (old === hex) return whole;
    dfChanged++;
    return a + hex;
  });
  testSrc = testSrc.replace(
    // the case arm may carry comments between `case` and `return` (the
    // 2026-10-16 re-pin note sits there; run 40317122238's adoption first
    // missed the copy for exactly this reason)
    new RegExp(`(case "${name}":\\s*\\n(?:\\s*//[^\\n]*\\n)*\\s*return ")([0-9a-f]{64})(")`),
    (whole, a, old, c) => {
      if (old === hex) return whole;
      testCopyChanged++;
      return a + hex + c;
    },
  );
}
if (dfChanged) await Bun.write(dockerfile, dfSrc);
if (testCopyChanged) await Bun.write(test, testSrc);
const tofuSites: string[] = [];
for (const [name, hex] of measured) {
  if (!dfSrc.includes(`ARG ${name}=${hex}`) && dfSrc.includes(`ARG ${name}=`)) tofuSites.push(`Dockerfile ARG ${name}`);
  if (!testSrc.includes(hex)) tofuSites.push(`measuredDefault ${name}`);
}
if (tofuSites.length) {
  console.log(`TOFU: WARNING sites not adopted — ${tofuSites.join(", ")} (pattern missed — triage by hand)`);
}
console.log(`TOFU ARGs + measuredDefault: ${dfChanged + testCopyChanged ? `adopted (${dfChanged} ARG + ${testCopyChanged} test copy)` : measured.size ? "already current" : "no TOFU drift in this run"}`);

// ── 3. tracked-inputs digest: not in the gate log — measure by running the test ──
const run = spawnSync("bun", ["test", "tests/scripts/build-exedev-image.test.ts"], { encoding: "utf8" });
const out = run.stdout + run.stderr;
const received = [...out.matchAll(/Received: "([0-9a-f]{64})"/g)].map((m) => m[1]);
if (received.length === 0) {
  console.log("tracked-inputs digest: test green or no Received to adopt — skipped");
} else {
  // Several assertions can fail with their own Received values (the CHECKSUM
  // fixture reports the openrig tree hex, not the tracked-inputs digest).
  // Anchor to THIS assertion's failure block: the first Received after the
  // assertion's own message text.
  const anchorIdx = out.indexOf("a tracked buildId input moved");
  const scoped = anchorIdx >= 0 ? out.slice(anchorIdx) : out;
  const scopedReceived = [...scoped.matchAll(/Received: "([0-9a-f]{64})"/g)].map((m) => m[1]);
  const digest = scopedReceived[0] ?? received[received.length - 1];
  let testSrc2 = await Bun.file(test).text();
  // the literal sits on its own indented line as the .toBe argument of the
  // "tracked buildId input moved" assertion
  const before = testSrc2;
  testSrc2 = testSrc2.replace(
    /(a tracked buildId input moved[\s\S]*?\.toBe\(\n[\s\S]*?^(\s*))(?:")?([0-9a-f]{64})(?:",?)?$/m,
    (_whole, a, indent, _old) => `${a}${indent}"${digest}",`,
  );
  if (testSrc2 !== before) {
    await Bun.write(test, testSrc2);
    console.log(`tracked-inputs digest -> ${digest}`);
  } else {
    console.log("tracked-inputs digest: assertion already carries the measured value");
  }
}
// ── 3a. the image-contract marker fixture (sixth + seventh sites) ───────────
// tests/providers/exedev/image-contract.test.ts asserts marker.buildId AND
// DEFAULT_IMAGE_BUILD_ID against a literal that must move with every pin
// (adoption 1cc01c55 missed them once before; #397's thirty-first adoption
// missed them again). Adopt from the same gate block.
if (newBuildId) {
  let icSrc = await Bun.file("tests/providers/exedev/image-contract.test.ts").text();
  let icChanged = false;
  icSrc = icSrc.replace(/(expect\(marker\.buildId\)\.toBe\(")([0-9a-f]{16})("\))/g, (whole, a, old, c) => {
    if (old === newBuildId) return whole;
    icChanged = true;
    return a + newBuildId + c;
  });
  icSrc = icSrc.replace(/(expect\(DEFAULT_IMAGE_BUILD_ID\)\.toBe\(")([0-9a-f]{16})("\))/g, (whole, a, old, c) => {
    if (old === newBuildId) return whole;
    icChanged = true;
    return a + newBuildId + c;
  });
  if (icChanged) {
    await Bun.write("tests/providers/exedev/image-contract.test.ts", icSrc);
    console.log("image-contract marker fixture: adopted");
  } else console.log("image-contract marker fixture: already current");
}

// ── 3b. the per-file PINNED map (Dockerfile + systemd bytes) ────────────────
// A Dockerfile/asset edit moves its sha256 in the PINNED map at the
// "tracked buildId inputs are the ones the current pin was derived from"
// test. The failing run's diff prints the Received pairs — adopt them.
const mapAnchor = out.indexOf("the ones the current pin was derived from");
if (mapAnchor >= 0) {
  const block = out.slice(mapAnchor);
  // bun's diff does not prefix Received lines with `+` — match the pairs
  // wherever they appear inside the failure block (run 40317122238: the
  // prefixed form matched nothing and the section stayed silent)
  const receivedPairs = [...block.matchAll(/"(oci\/[^"]+)": "([0-9a-f]{64})"/g)];
  if (receivedPairs.length > 0) {
    let mapSrc = await Bun.file(test).text();
    let changed = false;
    for (const [, file, hex] of receivedPairs) {
      if (file === undefined || hex === undefined) continue;
      const esc = file.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      mapSrc = mapSrc.replace(
        new RegExp(`("${esc}": ")([0-9a-f]{64})(")`),
        (whole, a, old, c) => {
          if (old === hex) return whole;
          changed = true;
          return a + hex + c;
        },
      );
    }
    if (changed) {
      await Bun.write(test, mapSrc);
      console.log(`PINNED map: ${receivedPairs.length} entr(ies) adopted`);
    } else console.log("PINNED map: already current");
  }
}

// ── 4. re-measure: report every failure the tree still carries ──────────────
const after = spawnSync("bun", ["test", "tests/scripts/build-exedev-image.test.ts", "tests/providers/exedev/image-contract.test.ts"], { encoding: "utf8" });
const afterOut = after.stdout + after.stderr;
const fails = [...afterOut.matchAll(/\(fail\) (.+)/g)].map((m) => m[1]);
if (fails.length === 0) {
  console.log("post-adoption: pin suites green");
} else {
  console.log(`post-adoption: ${fails.length} failure(s) remain — adopter has no oracle for these, triage by hand:`);
  for (const f of fails) console.log(`  (fail) ${f}`);
}
console.log("done — commit every changed file together (the ritual is one commit), then push to dev.");
if (!adopt) console.log("next: push, let publish re-dispatch; its gate-verdict run carries the driver block — run this script on THAT run id.");
