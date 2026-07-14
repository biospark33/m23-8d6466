import { describe, expect, it } from "bun:test";
import { join } from "node:path";
import {
  buildSpawn,
  logEnvKeys,
  MAX_STDOUT_EXCERPT,
  mergeEnv,
  runManifest,
} from "../src/runner.ts";
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

  it("empty manifest PATH leaves the parent PATH unchanged (no trailing delimiter)", () => {
    const merged = mergeEnv({ PATH: "/usr/bin" }, { PATH: "" });
    expect(merged.PATH).toBe("/usr/bin");
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

  it("AC2: bare manifest → inherits parent env additively (marker + non-empty PATH)", async () => {
    const res = await runManifest(join(FIXTURES, "test-bare.yaml"), {
      env: { ...process.env, PATH: shimPath, PARENT_MARKER: "inherited-ok" },
    });
    expect(res.exit_class).toBe("ok");
    const pathLine = res.stdout_excerpt
      .split("\n")
      .find((l) => l.startsWith("PATH="));
    expect(pathLine).toBeDefined();
    expect(pathLine!.slice("PATH=".length).length).toBeGreaterThan(0);
  });

  it("AC2: parent marker variable reaches the subprocess through the bare manifest", async () => {
    const res = await runManifest(join(FIXTURES, "test-marker.yaml"), {
      env: { ...process.env, PATH: shimPath, PARENT_MARKER: "inherited-ok" },
    });
    expect(res.exit_class).toBe("ok");
    expect(res.stdout_excerpt).toContain("PARENT_MARKER=inherited-ok");
  });

  it("AC3: manifest PATH=/evil → subprocess PATH = parent + /evil appended", async () => {
    const res = await runManifest(join(FIXTURES, "test-path.yaml"), {
      env: { ...process.env, PATH: shimPath },
    });
    expect(res.exit_class).toBe("ok");
    const pathLine = res.stdout_excerpt
      .split("\n")
      .find((l) => l.startsWith("PATH="));
    expect(pathLine).toBeDefined();
    expect(pathLine!.endsWith(":/evil")).toBe(true);
    expect(pathLine!).toContain(shimPath.split(":")[0]!);
  });

  it("empty manifest PATH → child PATH equals the parent PATH exactly", async () => {
    const res = await runManifest(join(FIXTURES, "test-emptypath.yaml"), {
      env: { ...process.env, PATH: shimPath },
    });
    expect(res.exit_class).toBe("ok");
    const pathLine = res.stdout_excerpt
      .split("\n")
      .find((l) => l.startsWith("PATH="));
    expect(pathLine).toBe(`PATH=${shimPath}`);
  });

  it("timeout: short timeoutMs against a long sleep → exit_class timeout", async () => {
    const start = Date.now();
    const res = await runManifest(join(FIXTURES, "test-sleep.yaml"), {
      env: { ...process.env, PATH: shimPath },
      timeoutMs: 300,
    });
    expect(res.exit_class).toBe("timeout");
    expect(Date.now() - start).toBeLessThan(4000);
  });

  it("spawn_error: warren unresolvable on PATH → spawn_error with code", async () => {
    const res = await runManifest(join(FIXTURES, "test-badcmd.yaml"), {
      env: { PATH: "/usr/bin:/bin" },
    });
    expect(res.exit_class).toBe("spawn_error");
    expect(res.spawn_error_code).toBeDefined();
  });

  it("CRLF: strips a trailing \\r from the extracted probe value", async () => {
    const res = await runManifest(join(FIXTURES, "test-crlf.yaml"), {
      env: { ...process.env, PATH: shimPath },
    });
    expect(res.exit_class).toBe("ok");
    expect(res.env_probe_result).toBe("x7");
  });

  it("caps stdout_excerpt at MAX_STDOUT_EXCERPT and flags truncation", async () => {
    const res = await runManifest(join(FIXTURES, "test-big.yaml"), {
      env: { ...process.env, PATH: shimPath },
    });
    expect(res.exit_class).toBe("ok");
    expect(res.truncated).toBe(true);
    expect(res.stdout_excerpt.length).toBeLessThanOrEqual(MAX_STDOUT_EXCERPT);
  });

  it("does not leak a secret straddling the truncation boundary (INV-2)", async () => {
    const secretValue = "hunter2supersecret";
    const res = await runManifest(join(FIXTURES, "test-bigsecret.yaml"), {
      env: { ...process.env, PATH: shimPath, MY_SECRET_TOKEN: secretValue },
    });
    expect(res.exit_class).toBe("ok");
    expect(res.truncated).toBe(true);
    // The cap cut the echoed secret mid-value: neither the full value nor any
    // prefix of it may survive in the excerpt.
    for (let k = 1; k <= secretValue.length; k++) {
      expect(res.stdout_excerpt.includes(secretValue.slice(0, k))).toBe(false);
    }
    expect(res.stdout_excerpt).toContain("[REDACTED:MY_SECRET_TOKEN]");
  });

  it("keeps stdout_excerpt within the cap with multi-byte content at the cut", async () => {
    const res = await runManifest(join(FIXTURES, "test-euro.yaml"), {
      env: { ...process.env, PATH: shimPath },
    });
    expect(res.exit_class).toBe("ok");
    expect(res.truncated).toBe(true);
    expect(res.stdout_excerpt.length).toBeLessThanOrEqual(MAX_STDOUT_EXCERPT);
  });
});

describe("INV-2 / INV-3: no secret values in structured output or logs", () => {
  it("redacts an echoed secret-like parent env value from structured output", async () => {
    const secretValue = "hunter2supersecret";
    const res = await runManifest(join(FIXTURES, "test-secret.yaml"), {
      env: { ...process.env, PATH: shimPath, MY_SECRET_TOKEN: secretValue },
    });
    expect(res.exit_class).toBe("ok");
    // The payload echoes the secret; the harness must redact it everywhere.
    expect(res.stdout_excerpt).toContain("[REDACTED:MY_SECRET_TOKEN]");
    expect(JSON.stringify(res)).not.toContain(secretValue);
    expect(res.env_probe_result ?? "").not.toContain(secretValue);
  });

  it("does not leak the merged env map wholesale into structured output", async () => {
    const res = await runManifest(join(FIXTURES, "test-env.yaml"), {
      env: { ...process.env, PATH: shimPath, TOTALLY_SECRET: "leak-me-42" },
    });
    // The structured result must not carry the secret value anywhere.
    expect(JSON.stringify(res)).not.toContain("leak-me-42");
  });

  it("collects env key NAMES only, never values, for logging (INV-3)", () => {
    const merged = mergeEnv({ PATH: "/usr/bin", SECRET: "hunter2" }, { A: "b" });
    const keys = logEnvKeys(merged);
    expect(keys).toContain("SECRET");
    expect(keys).toContain("A");
    expect(keys.join(",")).not.toContain("hunter2");
  });
});
