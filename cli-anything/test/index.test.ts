import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { exitCodeFor, main } from "../src/index.ts";
import type { HarnessResult } from "../src/types.ts";

const FIXTURES = join(import.meta.dir, "fixtures");
const SHIM_BIN = join(FIXTURES, "bin");
const ENV_FIXTURE = join(FIXTURES, "test-env.yaml");

let savedPath: string;

beforeEach(() => {
  savedPath = process.env.PATH ?? "";
  process.env.PATH = `${SHIM_BIN}${delimiter}${savedPath}`;
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

// Usage/validation tests below never reach runManifest's spawn (they exit 64/
// 65/66/70 during argv parsing or manifest load), so they are NOT gated on
// platform — only the end-to-end describe further down is POSIX-only.

describe("main() argv parsing", () => {
  it("rejects a missing subcommand with usage (64)", async () => {
    expect(await main([])).toBe(64);
  });

  it("rejects a missing --manifest value with usage (64)", async () => {
    expect(await main(["run"])).toBe(64);
    expect(await main(["run", "--manifest"])).toBe(64);
  });

  it("rejects a stray positional argument with usage (64)", async () => {
    const { value, stderr } = await withCapturedStderr(() =>
      main(["run", "--manifest", ENV_FIXTURE, "extra"]),
    );
    expect(value).toBe(64);
    expect(stderr).toContain("usage:");
    expect(stderr).toContain("extra");
  });

  it("rejects a flag-looking --manifest value with usage (64)", async () => {
    expect(await main(["run", "--manifest", "--verbose"])).toBe(64);
  });

  it("rejects an unknown flag (typo --timout-ms) with usage (64)", async () => {
    const { value, stderr } = await withCapturedStderr(() =>
      main(["run", "--manifest", ENV_FIXTURE, "--timout-ms", "500"]),
    );
    expect(value).toBe(64);
    expect(stderr).toContain("usage:");
    expect(stderr).toContain("--timout-ms");
  });

  it("rejects an unknown --flag=value form with usage (64)", async () => {
    const { value, stderr } = await withCapturedStderr(() =>
      main(["run", "--manifest", ENV_FIXTURE, "--verbose=true"]),
    );
    expect(value).toBe(64);
    expect(stderr).toContain("usage:");
  });

  it("rejects an invalid --timeout-ms value with usage (64)", async () => {
    const { value, stderr } = await withCapturedStderr(() =>
      main(["run", "--manifest", ENV_FIXTURE, "--timeout-ms", "abc"]),
    );
    expect(value).toBe(64);
    expect(stderr).toContain("usage:");
  });

  it("rejects non-decimal / out-of-range --timeout-ms values with usage (64)", async () => {
    // Number() would accept all of these; the CLI must not.
    const cases: string[][] = [
      ["--timeout-ms=abc"], // equals form, non-numeric
      ["--timeout-ms", "1e3"], // scientific notation
      ["--timeout-ms", "0x10"], // hex
      ["--timeout-ms", " 100 "], // whitespace-padded
      ["--timeout-ms", "0"], // not positive
      ["--timeout-ms", "-5"], // negative
      ["--timeout-ms", "9999999999999"], // beyond the setTimeout range (2^31-1)
    ];
    for (const args of cases) {
      const { value, stderr } = await withCapturedStderr(() =>
        main(["run", "--manifest", ENV_FIXTURE, ...args]),
      );
      expect(value).toBe(64);
      expect(stderr).toContain("usage:");
    }
  });

  it("rejects a missing --timeout-ms value with usage (64)", async () => {
    const { value, stderr } = await withCapturedStderr(() =>
      main(["run", "--manifest", ENV_FIXTURE, "--timeout-ms"]),
    );
    expect(value).toBe(64);
    expect(stderr).toContain("usage:");
  });
});

describe("main() manifest load/parse errors", () => {
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

  it("missing manifest file → 66 EX_NOINPUT with the operator-supplied path on stderr", async () => {
    const missing = join(FIXTURES, "does-not-exist-cli-anything.yaml");
    const { value, stderr } = await withCapturedStderr(() =>
      main(["run", "--manifest", missing]),
    );
    expect(value).toBe(66);
    // The path is operator argv, not manifest content — echoing it is not an
    // INV-2 violation and is what the user needs to fix their command line.
    expect(stderr).toContain(missing);
  });

  it("unexpected internal error (manifest path is a directory) → 70 EX_SOFTWARE", async () => {
    const { value, stderr } = await withCapturedStderr(() =>
      main(["run", "--manifest", FIXTURES]),
    );
    expect(value).toBe(70);
    expect(stderr).toContain("internal error");
  });

  it("manifest file larger than 1 MB → 65 EX_DATAERR", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "cli-anything-big-manifest-"));
    const bigManifest = join(tmpDir, "too-big.yaml");
    try {
      // > MAX_MANIFEST_SIZE_BYTES (1 MB) so the file is rejected before parsing.
      writeFileSync(bigManifest, "x".repeat(1024 * 1024 + 1));
      const { value, stderr } = await withCapturedStderr(() =>
        main(["run", "--manifest", bigManifest]),
      );
      expect(value).toBe(65);
      expect(stderr).toContain("manifest file too large");
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
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

  it("YAML-malformed secret-bearing manifest → 65 with line/column position, never the value", async () => {
    const { value, stderr } = await withCapturedStderr(() =>
      main(["run", "--manifest", join(FIXTURES, "test-yaml-malformed-secret.yaml")]),
    );
    expect(value).toBe(65);
    // YAML error MESSAGES embed source excerpts (including the secret value),
    // so only the issue code + line/column position may reach stderr.
    expect(stderr).toContain("YAML syntax error");
    expect(stderr).toMatch(/line \d+, column \d+/);
    expect(stderr).not.toContain("hunter2");
  });
});

describe("exitCodeFor() exit_class mapping", () => {
  const mk = (exit_class: HarnessResult["exit_class"]): HarnessResult => ({
    exit_class,
    stdout_excerpt: "",
    env_probe_result: null,
  });

  it("maps the known classes", () => {
    expect(exitCodeFor(mk("ok"))).toBe(0);
    expect(exitCodeFor(mk("nonzero"))).toBe(1);
    expect(exitCodeFor(mk("timeout"))).toBe(124);
    expect(exitCodeFor(mk("spawn_error"))).toBe(127);
  });

  it("unknown exit_class → 1 with a stderr note (never a silent exit 0)", async () => {
    const result = {
      exit_class: "totally-new-class",
      stdout_excerpt: "",
      env_probe_result: null,
    } as unknown as HarnessResult;
    const { value, stderr } = await withCapturedStderr(async () => exitCodeFor(result));
    expect(value).toBe(1);
    expect(stderr).toContain("unknown exit_class");
    expect(stderr).toContain("totally-new-class");
  });
});

// The fixtures below spawn real subprocesses: the warren shim is a bash
// script and the manifests run `sh -c ...`, so they are POSIX-only (same
// gating as e2e.test.ts). win32 behavior is covered at unit level via the
// mergeEnv platform parameter (see runner.test.ts).
describe.skipIf(process.platform === "win32")(
  "main() end-to-end (POSIX-only: sh fixtures + bash warren shim)",
  () => {
    it("accepts the --manifest=<path> form", async () => {
      expect(await main(["run", `--manifest=${ENV_FIXTURE}`])).toBe(0);
    });

    it("uses the first token after -- as the manifest path", async () => {
      const tmpDir = mkdtempSync(join(tmpdir(), "cli-anything-dash-path-"));
      const weirdPath = join(tmpDir, "--weird.yaml");
      try {
        writeFileSync(
          weirdPath,
          [
            "name: weird",
            "command: sh",
            "args:",
            '  - "-c"',
            '  - "echo ok"',
            "",
          ].join("\n"),
        );
        expect(await main(["run", "--", weirdPath])).toBe(0);
      } finally {
        rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    it("first --manifest wins when the flag is repeated", async () => {
      expect(
        await main([
          "run",
          "--manifest",
          ENV_FIXTURE,
          "--manifest",
          join(FIXTURES, "test-fail.yaml"),
        ]),
      ).toBe(0);
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

    it("ok → 0", async () => {
      expect(await main(["run", "--manifest", ENV_FIXTURE])).toBe(0);
    });

    it("nonzero → 1", async () => {
      expect(await main(["run", "--manifest", join(FIXTURES, "test-fail.yaml")])).toBe(1);
    });

    it("spawn_error → 127 (warren unresolvable on PATH)", async () => {
      // Point PATH at a freshly-created EMPTY dir so `warren` provably cannot
      // be found on ANY host (a hardcoded /usr/bin:/bin could actually
      // contain a warren binary on some machine).
      const emptyBin = mkdtempSync(join(tmpdir(), "cli-anything-empty-path-"));
      try {
        process.env.PATH = emptyBin;
        // NOTE: test-badcmd.yaml is named for its payload command, but that
        // is irrelevant here — this test exercises the warren-missing
        // spawn_error path; spawning `warren` itself fails before the
        // manifest's payload command ever matters.
        expect(await main(["run", "--manifest", join(FIXTURES, "test-badcmd.yaml")])).toBe(127);
      } finally {
        rmSync(emptyBin, { recursive: true, force: true });
      }
    });
  },
);
