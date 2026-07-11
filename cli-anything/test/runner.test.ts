import { describe, expect, it } from "bun:test";
import { join } from "node:path";
import { buildSpawn, mergeEnv, runManifest } from "../src/runner.ts";
import type { Manifest } from "../src/types.ts";

const FIXTURES = join(import.meta.dir, "fixtures");
const SHIM_BIN = join(FIXTURES, "bin");

/** PATH with the warren shim prepended — used for real subprocess exercises. */
const shimPath = `${SHIM_BIN}:${process.env.PATH ?? ""}`;

describe("mergeEnv (INV-1 additive merge)", () => {
  it("inherits parent env when manifest has no env block", () => {
    const parent = { PATH: "/usr/bin", SECRET: "keep" };
    const merged = mergeEnv(parent, undefined);
    expect(merged.PATH).toBe("/usr/bin");
    expect(merged.SECRET).toBe("keep");
  });

  it("adds manifest keys on top of parent env", () => {
    const merged = mergeEnv({ PATH: "/usr/bin" }, { QDS_PROBE: "x7" });
    expect(merged.QDS_PROBE).toBe("x7");
    expect(merged.PATH).toBe("/usr/bin");
  });

  it("APPENDS manifest PATH to parent PATH (merge, not replace) — AC3", () => {
    const merged = mergeEnv({ PATH: "/usr/bin" }, { PATH: "/evil" });
    expect(merged.PATH).toBe("/usr/bin:/evil");
  });

  it("non-PATH manifest keys override parent keys of the same name", () => {
    const merged = mergeEnv({ FOO: "old" }, { FOO: "new" });
    expect(merged.FOO).toBe("new");
  });
});

describe("buildSpawn", () => {
  it("prefixes the command with `warren run` and passes args", () => {
    const m: Manifest = { name: "t", command: "sh", args: ["-c", "echo hi"] };
    const { file, argv } = buildSpawn(m);
    expect(file).toBe("warren");
    expect(argv).toEqual(["run", "sh", "-c", "echo hi"]);
  });

  it("works with no args", () => {
    const m: Manifest = { name: "t", command: "warren-cmd" };
    const { argv } = buildSpawn(m);
    expect(argv).toEqual(["run", "warren-cmd"]);
  });
});

describe("runManifest (integration via warren shim)", () => {
  it("AC1: env-bearing manifest → stdout contains QDS_PROBE=x7", async () => {
    const res = await runManifest(join(FIXTURES, "test-env.yaml"), {
      env: { ...process.env, PATH: shimPath },
    });
    expect(res.exit_class).toBe("ok");
    expect(res.stdout_excerpt).toContain("QDS_PROBE=x7");
    expect(res.env_probe_result).toBe("x7");
  });

  it("AC2: bare manifest → stdout contains a non-empty PATH", async () => {
    const res = await runManifest(join(FIXTURES, "test-bare.yaml"), {
      env: { ...process.env, PATH: shimPath },
    });
    expect(res.exit_class).toBe("ok");
    const pathLine = res.stdout_excerpt
      .split("\n")
      .find((l) => l.startsWith("PATH="));
    expect(pathLine).toBeDefined();
    expect((pathLine ?? "PATH=").slice("PATH=".length).length).toBeGreaterThan(0);
  });

  it("AC3: manifest PATH=/evil → subprocess PATH = parent + /evil appended", async () => {
    const res = await runManifest(join(FIXTURES, "test-path.yaml"), {
      env: { ...process.env, PATH: shimPath },
    });
    expect(res.exit_class).toBe("ok");
    const pathLine =
      res.stdout_excerpt.split("\n").find((l) => l.startsWith("PATH=")) ?? "";
    expect(pathLine.endsWith(":/evil")).toBe(true);
    expect(pathLine).toContain(shimPath.split(":")[0] ?? "unreachable");
  });
});

describe("INV-2 / INV-3: no secret values in structured output or logs", () => {
  it("does not leak the merged env map wholesale into structured output", async () => {
    const res = await runManifest(join(FIXTURES, "test-env.yaml"), {
      env: { ...process.env, PATH: shimPath, TOTALLY_SECRET: "leak-me-42" },
    });
    // The structured result must not carry the secret value anywhere.
    expect(JSON.stringify(res)).not.toContain("leak-me-42");
  });

  it("collects env key NAMES only, never values, for logging (INV-3)", () => {
    const merged = mergeEnv({ PATH: "/usr/bin", SECRET: "hunter2" }, { A: "b" });
    const { logEnvKeys } = require("../src/runner.ts");
    const keys: string[] = logEnvKeys(merged);
    expect(keys).toContain("SECRET");
    expect(keys).toContain("A");
    expect(keys.join(",")).not.toContain("hunter2");
  });
});
