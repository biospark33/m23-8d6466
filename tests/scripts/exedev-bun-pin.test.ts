import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { BunPinError, dockerfileArgDefaults, readBunPin } from "../../scripts/build-exedev-image.ts";

const REPO_ROOT = join(import.meta.dir, "..", "..");
const DOCKERFILE = join(REPO_ROOT, "oci/exedev/Dockerfile");

/**
 * `readBunPin` feeds the `BUN_VERSION` build arg, which oci/exedev/Dockerfile
 * interpolates straight into a GitHub release URL
 * (`…/bun-v${BUN_VERSION}/bun-linux-x64.zip`). A capture that keeps corepack's
 * `+sha512.<hex>` integrity suffix therefore does not produce a wrong version —
 * it produces a 404 mid-build, ten QEMU-emulated minutes in.
 *
 * The rejecting paths are exercised too, which they could not be while the
 * function called `die()` — `process.exit` would have taken the runner down
 * with it rather than failing a test. It throws {@link BunPinError} and its one
 * caller does the exiting, so each refusal is now assertable.
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

  test("refuses unparseable JSON", () => {
    expect(() => readBunPin("{ not json")).toThrow(BunPinError);
    expect(() => readBunPin("{ not json")).toThrow(/not parseable/);
  });

  test("refuses a package.json with no packageManager field", () => {
    expect(() => readBunPin(JSON.stringify({ name: "qds-factory" }))).toThrow(BunPinError);
  });

  test("refuses a packageManager that is not a string", () => {
    expect(() => readBunPin(JSON.stringify({ packageManager: 1.3 }))).toThrow(BunPinError);
  });

  test("refuses a packageManager pinning something other than bun", () => {
    // AC2 is "the in-box engine runs the runtime the tests ran on". A pnpm pin
    // is not a bun version, and guessing one would install a runtime nothing
    // was tested against.
    expect(() => readBunPin(JSON.stringify({ packageManager: "pnpm@9.0.0" }))).toThrow(/must pin bun/);
  });

  test("refuses a bun pin whose version is not a version", () => {
    // The capture is anchored on a leading DIGIT: `bun@latest` in the release
    // URL is a 404 ten QEMU-emulated minutes into the build, not a version.
    expect(() => readBunPin(JSON.stringify({ packageManager: "bun@latest" }))).toThrow(BunPinError);
    expect(() => readBunPin(JSON.stringify({ packageManager: "bun@" }))).toThrow(BunPinError);
  });

  test("the repo's own package.json parses to a URL-safe SEMVER version", () => {
    const version = readBunPin(readFileSync(join(REPO_ROOT, "package.json"), "utf8"));
    // Not a charset check. `/^[0-9A-Za-z.-]+$/` is satisfied by `bun` and by a
    // bare `-`; what the release URL needs is a released bun version, and the
    // in-image `bun --version` equality check compares against this exact
    // string.
    expect(version).toMatch(/^\d+\.\d+\.\d+/);
  });

  test("the captured pin IS the Dockerfile's ARG BUN_VERSION default", () => {
    // The script always passes `--build-arg BUN_VERSION`, so the Dockerfile
    // default is dead code that nothing exercises at build time — while the
    // Dockerfile's BYTES are a buildId input. A divergence therefore moves the
    // identity without moving the substrate, and drags the hand-measured
    // `ARG BUN_SHA256` (pinned beside it, for THIS version's release archive)
    // out of step with the version actually installed. The build refuses on the
    // same comparison; this fails it in a second, without docker.
    const dockerfile = readFileSync(DOCKERFILE, "utf8");
    const version = readBunPin(readFileSync(join(REPO_ROOT, "package.json"), "utf8"));
    // EVERY declaration, so a stage that re-declares ARG BUN_VERSION with a
    // stale default cannot hide behind the one the first match happened to
    // find. DF1.10 adds exactly such a stage to this file.
    expect(dockerfileArgDefaults(dockerfile, "BUN_VERSION")).toEqual([version]);
    // The checksum is pinned in the same file and must be present to be paired.
    expect(dockerfileArgDefaults(dockerfile, "BUN_SHA256")).toEqual([expect.stringMatching(/^[0-9a-f]{64}$/)]);
  });
});
