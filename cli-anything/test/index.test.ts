import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { join } from "node:path";
import { main } from "../src/index.ts";

const FIXTURES = join(import.meta.dir, "fixtures");
const SHIM_BIN = join(FIXTURES, "bin");

let savedPath: string;

beforeEach(() => {
  savedPath = process.env.PATH ?? "";
  process.env.PATH = `${SHIM_BIN}:${savedPath}`;
});

afterEach(() => {
  process.env.PATH = savedPath;
});

describe("main() argv parsing", () => {
  it("rejects a missing subcommand with usage (64)", async () => {
    expect(await main([])).toBe(64);
  });

  it("rejects a missing --manifest value with usage (64)", async () => {
    expect(await main(["run"])).toBe(64);
    expect(await main(["run", "--manifest"])).toBe(64);
  });

  it("rejects a flag-looking --manifest value with usage (64)", async () => {
    expect(await main(["run", "--manifest", "--verbose"])).toBe(64);
  });

  it("accepts the --manifest=<path> form", async () => {
    expect(await main(["run", `--manifest=${join(FIXTURES, "test-env.yaml")}`])).toBe(0);
  });
});

describe("main() exit code mapping", () => {
  it("ok → 0", async () => {
    expect(await main(["run", "--manifest", join(FIXTURES, "test-env.yaml")])).toBe(0);
  });

  it("nonzero → 1", async () => {
    expect(await main(["run", "--manifest", join(FIXTURES, "test-fail.yaml")])).toBe(1);
  });

  it("spawn_error → 127 (warren unresolvable on PATH)", async () => {
    process.env.PATH = "/usr/bin:/bin";
    expect(await main(["run", "--manifest", join(FIXTURES, "test-badcmd.yaml")])).toBe(127);
  });

  it("manifest parse errors → 65", async () => {
    expect(await main(["run", "--manifest", join(FIXTURES, "test-malformed.yaml")])).toBe(65);
  });
});
