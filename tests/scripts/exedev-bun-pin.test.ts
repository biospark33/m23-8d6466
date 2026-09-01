import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { readBunPin } from "../../scripts/build-exedev-image.ts";

const REPO_ROOT = join(import.meta.dir, "..", "..");

/**
 * `readBunPin` feeds the `BUN_VERSION` build arg, which oci/exedev/Dockerfile
 * interpolates straight into a GitHub release URL
 * (`…/bun-v${BUN_VERSION}/bun-linux-x64.zip`). A capture that keeps corepack's
 * `+sha512.<hex>` integrity suffix therefore does not produce a wrong version —
 * it produces a 404 mid-build, ten QEMU-emulated minutes in.
 *
 * Only the accepting paths are exercised: every rejecting path in this module
 * calls `die()`, which is `process.exit`, and a test that tripped one would
 * take the runner down with it rather than fail.
 */
describe("readBunPin", () => {
  test("captures a plain version", () => {
    expect(readBunPin(JSON.stringify({ packageManager: "bun@1.3.13" }))).toBe("1.3.13");
  });

  test("discards corepack's +hash suffix rather than capturing it", () => {
    const pm = `bun@1.3.13+sha512.${"a1b2c3d4".repeat(8)}`;
    expect(readBunPin(JSON.stringify({ packageManager: pm }))).toBe("1.3.13");
  });

  test("keeps prerelease and build-metadata-free suffixes that are part of the version", () => {
    expect(readBunPin(JSON.stringify({ packageManager: "bun@1.3.13-canary.1" }))).toBe("1.3.13-canary.1");
  });

  test("the repo's own package.json parses to a URL-safe version", () => {
    const version = readBunPin(readFileSync(join(REPO_ROOT, "package.json"), "utf8"));
    // Anything outside this set breaks the release URL the Dockerfile builds.
    expect(version).toMatch(/^[0-9A-Za-z.-]+$/);
  });
});
