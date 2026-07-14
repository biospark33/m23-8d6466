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

/** Capture console.error output while `fn` runs (stderr assertions). */
async function withCapturedStderr<T>(
  fn: () => Promise<T>,
): Promise<{ value: T; stderr: string }> {
  const lines: string[] = [];
  const orig = console.error;
  console.error = (...args: unknown[]) => {
    lines.push(args.map(String).join(" "));
  };
  try {
    return { value: await fn(), stderr: lines.join("\n") };
  } finally {
    console.error = orig;
  }
}

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

  it("--timeout-ms drives a real timeout through main() → 124 (space form)", async () => {
    expect(
      await main([
        "run",
        "--manifest",
        join(FIXTURES, "test-sleep.yaml"),
        "--timeout-ms",
        "300",
      ]),
    ).toBe(124);
  });

  it("--timeout-ms=<n> form also drives a real timeout → 124", async () => {
    expect(
      await main([
        "run",
        "--manifest",
        join(FIXTURES, "test-sleep.yaml"),
        "--timeout-ms=300",
      ]),
    ).toBe(124);
  });

  it("rejects an invalid --timeout-ms value with usage (64)", async () => {
    const { value, stderr } = await withCapturedStderr(() =>
      main([
        "run",
        "--manifest",
        join(FIXTURES, "test-env.yaml"),
        "--timeout-ms",
        "abc",
      ]),
    );
    expect(value).toBe(64);
    expect(stderr).toContain("usage:");
  });

  it("rejects a missing --timeout-ms value with usage (64)", async () => {
    const { value, stderr } = await withCapturedStderr(() =>
      main(["run", "--manifest", join(FIXTURES, "test-env.yaml"), "--timeout-ms"]),
    );
    expect(value).toBe(64);
    expect(stderr).toContain("usage:");
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

  it("manifest parse errors → 65 with a real validation failure (not ENOENT)", async () => {
    const { value, stderr } = await withCapturedStderr(() =>
      main(["run", "--manifest", join(FIXTURES, "test-malformed.yaml")]),
    );
    expect(value).toBe(65);
    // Must be a genuine validation failure of the existing fixture, not a
    // vacuous pass via a missing file.
    expect(stderr).toContain("manifest validation failed");
    expect(stderr).not.toContain("ENOENT");
  });
});

describe("stderr sanitization (INV-2: no secret values on stderr)", () => {
  it("Zod-invalid secret-bearing manifest → issue paths/codes only, never the value (65)", async () => {
    const { value, stderr } = await withCapturedStderr(() =>
      main(["run", "--manifest", join(FIXTURES, "test-secret-malformed.yaml")]),
    );
    expect(value).toBe(65);
    expect(stderr).toContain("manifest validation failed");
    expect(stderr).toMatch(/name.*invalid_type/);
    expect(stderr).not.toContain("hunter2");
  });

  it("YAML-malformed secret-bearing manifest → error class only, never the value (65)", async () => {
    const { value, stderr } = await withCapturedStderr(() =>
      main(["run", "--manifest", join(FIXTURES, "test-yaml-malformed-secret.yaml")]),
    );
    expect(value).toBe(65);
    expect(stderr.length).toBeGreaterThan(0);
    expect(stderr).not.toContain("hunter2");
  });
});
