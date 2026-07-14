import { describe, expect, it } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildSpawn,
  classifyExit,
  logEnvKeys,
  MAX_STDOUT_EXCERPT,
  mergeEnv,
  redactSecrets,
  runManifest,
} from "../src/runner.ts";
import type { Manifest } from "../src/types.ts";

const FIXTURES = join(import.meta.dir, "fixtures");
const SHIM_BIN = join(FIXTURES, "bin");

/** PATH with the warren shim prepended — used for real subprocess exercises. */
const shimPath = `${SHIM_BIN}:${process.env.PATH ?? ""}`;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Capture console.error lines while `fn` runs (log-line assertions). */
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

describe("mergeEnv win32 PATH handling (via the platform param)", () => {
  it("parent `Path` + manifest `PATH` → single `Path` key with append (no duplicate)", () => {
    const merged = mergeEnv({ Path: "C:\\bin" }, { PATH: "C:\\evil" }, "win32");
    expect(merged.Path).toBe("C:\\bin;C:\\evil");
    expect(Object.keys(merged).filter((k) => k.toLowerCase() === "path")).toEqual([
      "Path",
    ]);
  });

  it("empty manifest PATH leaves the parent `Path` unchanged (no duplicate)", () => {
    const merged = mergeEnv({ Path: "C:\\bin" }, { PATH: "" }, "win32");
    expect(merged.Path).toBe("C:\\bin");
    expect(Object.keys(merged).filter((k) => k.toLowerCase() === "path")).toEqual([
      "Path",
    ]);
  });

  it("matches the manifest PATH key case-insensitively", () => {
    const merged = mergeEnv({ Path: "C:\\bin" }, { path: "C:\\evil" }, "win32");
    expect(merged.Path).toBe("C:\\bin;C:\\evil");
    expect(Object.keys(merged).filter((k) => k.toLowerCase() === "path")).toEqual([
      "Path",
    ]);
  });
});

describe("redactSecrets (extended SECRET_KEY_RE heuristic)", () => {
  it("redacts values under DATABASE_URL / DSN / CRED / CERT / PASS / PRIVATE keys", () => {
    const parent = {
      DATABASE_URL: "postgres://fake-host/db",
      APP_DSN: "hunter2-dsn-value",
      GH_CREDS: "sk-test-creds-1234",
      CLIENT_CERT: "hunter2-cert-pem-material",
      DB_PASSPHRASE: "hunter2-passphrase",
      PRIVATE_KEY: "hunter2-privatekey-material",
    };
    const out = redactSecrets(Object.values(parent).join(" "), parent);
    for (const [key, value] of Object.entries(parent)) {
      expect(out).not.toContain(value);
      expect(out).toContain(`[REDACTED:${key}]`);
    }
  });

  it("leaves short values (< 8 chars) and non-secret keys alone", () => {
    const out = redactSecrets("short7! visible-text", {
      MY_SECRET: "short7!",
      EDITOR: "visible-text",
    });
    expect(out).toBe("short7! visible-text");
  });

  it("processes overlapping secret values longest-first so no tail leaks", () => {
    const parent = {
      MY_PASS: "hunter2",
      MY_TOKEN: "hunter2-abc123",
    };
    const out = redactSecrets("value: hunter2-abc123", parent);
    expect(out).not.toContain("hunter2-abc123");
    expect(out).not.toContain("hunter2");
    expect(out).toContain("[REDACTED:MY_TOKEN]");
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

describe("classifyExit", () => {
  it("natural exit at the timeout instant is not classified as timeout", () => {
    expect(classifyExit(true, 0, null)).toEqual({
      exit_class: "ok",
      signal: null,
      exit_code: 0,
    });
  });

  it("signal kill after timeout attempt is classified as timeout with the real signal", () => {
    expect(classifyExit(true, null, "SIGTERM")).toEqual({
      exit_class: "timeout",
      signal: "SIGTERM",
      exit_code: null,
    });
  });

  it("forced timeout fallback reports SIGKILL when no signal is known", () => {
    expect(classifyExit(true, null, null)).toEqual({
      exit_class: "timeout",
      signal: "SIGKILL",
      exit_code: null,
    });
  });

  it("classifies natural ok and nonzero exits", () => {
    expect(classifyExit(false, 0, null)).toEqual({
      exit_class: "ok",
      signal: null,
      exit_code: 0,
    });
    expect(classifyExit(false, 3, null)).toEqual({
      exit_class: "nonzero",
      signal: null,
      exit_code: 3,
    });
  });

  it("classifies a signal-killed child that did not time out as nonzero", () => {
    expect(classifyExit(false, null, "SIGKILL")).toEqual({
      exit_class: "nonzero",
      signal: "SIGKILL",
      exit_code: null,
    });
  });
});

describe.skipIf(process.platform === "win32")("runManifest (integration via warren shim)", () => {
  it("AC1: env-bearing manifest → stdout contains QDS_PROBE=x7", async () => {
    const res = await runManifest(join(FIXTURES, "test-env.yaml"), {
      env: { ...process.env, PATH: shimPath },
    });
    expect(res.exit_class).toBe("ok");
    expect(res.exit_code).toBe(0);
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

  it("nonzero exit → real exit code preserved in exit_code", async () => {
    const res = await runManifest(join(FIXTURES, "test-fail.yaml"), {
      env: { ...process.env, PATH: shimPath },
    });
    expect(res.exit_class).toBe("nonzero");
    expect(res.exit_code).toBe(3);
  });

  it("timeout: short timeoutMs against a long sleep → exit_class timeout", async () => {
    const start = Date.now();
    const res = await runManifest(join(FIXTURES, "test-sleep.yaml"), {
      env: { ...process.env, PATH: shimPath },
      timeoutMs: 300,
    });
    expect(res.exit_class).toBe("timeout");
    // Killed by signal, so there is no real exit code.
    expect(res.exit_code).toBeNull();
    expect(res.signal).toBe("SIGKILL");
    expect(Date.now() - start).toBeLessThan(4000);
  });

  it("a child that exits naturally before the timeout is NOT classified as timeout", async () => {
    // Fast-exiting command with a short timeout: the timer must not override
    // the real exit classification.
    const res = await runManifest(join(FIXTURES, "test-env.yaml"), {
      env: { ...process.env, PATH: shimPath },
      timeoutMs: 2000,
    });
    expect(res.exit_class).toBe("ok");
    expect(res.exit_code).toBe(0);
    expect(res.env_probe_result).toBe("x7");
  });

  it("does not leak SIGHUP listeners after settle", async () => {
    if (process.platform === "win32") return;
    const before = process.listenerCount("SIGHUP");
    await runManifest(join(FIXTURES, "test-env.yaml"), {
      env: { ...process.env, PATH: shimPath },
    });
    expect(process.listenerCount("SIGHUP")).toBe(before);
  });

  it("timeout kills the whole process tree, including grandchildren", async () => {
    const tmpDir = join(
      tmpdir(),
      `qds-gchild-${process.pid}-${Date.now()}`,
    );
    const pidFile = join(tmpDir, "gchild.pid");
    const manifestPath = join(tmpDir, "manifest.yaml");
    await mkdir(tmpDir, { recursive: true });
    let gchildPid: number | undefined;
    try {
      await Bun.write(
        manifestPath,
        [
          "name: grandchild-spawner",
          "command: sh",
          "args:",
          '  - "-c"',
          "  - >-",
          '    sleep 30 & echo $! > "$PIDFILE";',
          "    exec sleep 30",
          "env:",
          `  PIDFILE: ${pidFile}`,
          "",
        ].join("\n"),
      );
      // Generous timeout so child-startup variance can never race the kill;
      // poll for the grandchild's pid file while the run is in flight.
      const resPromise = runManifest(manifestPath, {
        env: { ...process.env, PATH: shimPath },
        timeoutMs: 1500,
      });
      for (let i = 0; i < 100 && !existsSync(pidFile); i++) await sleep(25);
      const res = await resPromise;
      expect(res.exit_class).toBe("timeout");
      expect(existsSync(pidFile)).toBe(true);
      gchildPid = Number(readFileSync(pidFile, "utf8").trim());
      expect(Number.isInteger(gchildPid)).toBe(true);

      // The grandchild must be dead (SIGKILL to the whole process group).
      // Poll briefly: a just-killed process can linger as a zombie until reaped.
      let alive = true;
      for (let i = 0; i < 40; i++) {
        try {
          process.kill(gchildPid, 0);
          await sleep(50);
        } catch {
          alive = false;
          break;
        }
      }
      expect(alive).toBe(false);
    } finally {
      if (gchildPid !== undefined) {
        try {
          process.kill(gchildPid, "SIGKILL");
        } catch {
          // Already dead — nothing to clean up.
        }
      }
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  it(
    "force-settles via watchdog when a descendant holds the stdout pipe open after timeout",
    async () => {
    // Deterministic simulation: spawn a grandchild in a new session (setsid)
    // that inherits and holds the stdout pipe open. The direct child is killed
    // by the timeout group-kill, but `close` cannot fire until the escaped
    // grandchild releases the pipe. The 5s watchdog must force-settle.
    const tmpDir = join(
      tmpdir(),
      `qds-watchdog-${process.pid}-${Date.now()}`,
    );
    const pidFile = join(tmpDir, "gchild.pid");
    const manifestPath = join(tmpDir, "manifest.yaml");
    await mkdir(tmpDir, { recursive: true });
    let gchildPid: number | undefined;
    try {
      await Bun.write(
        manifestPath,
        [
          "name: watchdog-grandchild",
          "command: sh",
          "args:",
          '  - "-c"',
          "  - >-",
          `    perl -e 'use POSIX qw(setsid); setsid(); exec("sleep","1000") or die $!;' & echo $! > "$PIDFILE";`,
          "    exec sleep 30",
          "env:",
          `  PIDFILE: ${pidFile}`,
          "",
        ].join("\n"),
      );
      const start = Date.now();
      const resPromise = runManifest(manifestPath, {
        env: { ...process.env, PATH: shimPath },
        // Give the grandchild enough time to call setsid() before the timeout
        // kill, otherwise it is still in the parent's group and dies normally.
        timeoutMs: 1500,
      });
      for (let i = 0; i < 100 && !existsSync(pidFile); i++) await sleep(25);
      gchildPid = Number(readFileSync(pidFile, "utf8").trim());
      const res = await resPromise;
      const elapsed = Date.now() - start;

      expect(res.exit_class).toBe("timeout");
      expect(res.exit_code).toBeNull();
      expect(res.signal).toBe("SIGKILL");
      // The watchdog only fires after the timeout plus its 5s grace.
      expect(elapsed).toBeGreaterThan(4800);
      expect(elapsed).toBeLessThan(9000);

      // Confirm the grandchild really escaped the group kill and held the pipe.
      let aliveAfter = false;
      try {
        process.kill(gchildPid, 0);
        aliveAfter = true;
      } catch {
        aliveAfter = false;
      }
      expect(aliveAfter).toBe(true);

      // Clean up the orphaned grandchild that held the pipe open.
      if (Number.isInteger(gchildPid)) {
        try {
          process.kill(gchildPid, "SIGKILL");
        } catch {
          // Already dead.
        }
      }
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  }, { timeout: 15_000 });

  it("spawn_error: warren unresolvable on PATH → spawn_error with ENOENT", async () => {
    const start = Date.now();
    const res = await runManifest(join(FIXTURES, "test-badcmd.yaml"), {
      env: { PATH: "/usr/bin:/bin" },
    });
    expect(res.exit_class).toBe("spawn_error");
    expect(res.spawn_error_code).toBe("ENOENT");
    expect(res.exit_code).toBeNull();
    expect(Date.now() - start).toBeLessThan(4000);
  });

  it("CRLF: strips a trailing \\r from the extracted probe value", async () => {
    const res = await runManifest(join(FIXTURES, "test-crlf.yaml"), {
      env: { ...process.env, PATH: shimPath },
    });
    expect(res.exit_class).toBe("ok");
    expect(res.env_probe_result).toBe("x7");
  });

  it("caps stdout_excerpt at MAX_STDOUT_EXCERPT, flags truncation, and nulls the probe", async () => {
    const res = await runManifest(join(FIXTURES, "test-big.yaml"), {
      env: { ...process.env, PATH: shimPath },
    });
    expect(res.exit_class).toBe("ok");
    expect(res.truncated).toBe(true);
    expect(res.stdout_excerpt.length).toBeLessThanOrEqual(MAX_STDOUT_EXCERPT);
    // A truncated excerpt may have cut the QDS_PROBE line mid-value: the
    // probe must be null, never a silently partial value.
    expect(res.env_probe_result).toBeNull();
  });

  it("reports a probe emitted before a truncation flood", async () => {
    const res = await runManifest(join(FIXTURES, "test-probe-flood.yaml"), {
      env: { ...process.env, PATH: shimPath },
    });
    expect(res.exit_class).toBe("ok");
    expect(res.truncated).toBe(true);
    expect(res.env_probe_result).toBe("x7");
  });

  it("nulls the probe when the probe line itself is cut mid-value", async () => {
    const res = await runManifest(join(FIXTURES, "test-probe-cut.yaml"), {
      env: { ...process.env, PATH: shimPath },
    });
    expect(res.exit_class).toBe("ok");
    expect(res.truncated).toBe(true);
    expect(res.env_probe_result).toBeNull();
  });

  it("caps an oversized QDS_PROBE value at MAX_PROBE_RESULT_LEN", async () => {
    const res = await runManifest(join(FIXTURES, "test-oversized-probe.yaml"), {
      env: { ...process.env, PATH: shimPath },
    });
    expect(res.exit_class).toBe("ok");
    expect(res.env_probe_result).not.toBeNull();
    expect(res.env_probe_result!.length).toBeLessThanOrEqual(1024);
    // It should be the leading portion of the probe value, not truncated mid-surrogate.
    expect(res.env_probe_result).toBe("B".repeat(1024));
  });

  it("does not leak a secret straddling the truncation boundary (INV-2)", async () => {
    const secretValue = "hunter2-super-secret-boundary-value";
    const res = await runManifest(join(FIXTURES, "test-bigsecret.yaml"), {
      env: { ...process.env, PATH: shimPath, MY_SECRET_TOKEN: secretValue },
    });
    expect(res.exit_class).toBe("ok");
    expect(res.truncated).toBe(true);
    // The cap cut the echoed secret mid-value with 30 chars surviving (>= the
    // 8-char minimum prefix): every prefix of 8+ chars must be redacted.
    for (let k = 8; k <= secretValue.length; k++) {
      expect(res.stdout_excerpt.includes(secretValue.slice(0, k))).toBe(false);
    }
    // The excerpt must not end with any prefix of the secret, and the marker
    // at the tail must be complete (not a fragment like "[REDACTE").
    for (let k = 1; k <= secretValue.length; k++) {
      expect(res.stdout_excerpt.endsWith(secretValue.slice(0, k))).toBe(false);
    }
    expect(res.stdout_excerpt).toContain("[REDACTED:MY_SECRET_TOKEN]");
    expect(res.stdout_excerpt.endsWith("[REDACTED")).toBe(false);
    expect(res.stdout_excerpt.length).toBeLessThanOrEqual(MAX_STDOUT_EXCERPT);
    // Benign output ahead of the cut is untouched (no mangling).
    expect(res.stdout_excerpt.startsWith("A".repeat(100))).toBe(true);
  });

  it("strips a short (< 8 chars) trailing secret prefix at the boundary without leaking it", async () => {
    const secretValue = "hunter2supersecret";
    const res = await runManifest(join(FIXTURES, "test-bigsecret-short.yaml"), {
      env: { ...process.env, PATH: shimPath, MY_SECRET_TOKEN: secretValue },
    });
    expect(res.exit_class).toBe("ok");
    expect(res.truncated).toBe(true);
    // The short fragment is stripped entirely: no secret characters leak and
    // no [REDACTED:...] marker is sprayed into benign output.
    expect(res.stdout_excerpt).not.toContain("[REDACTED:");
    for (let k = 1; k <= secretValue.length; k++) {
      expect(res.stdout_excerpt.endsWith(secretValue.slice(0, k))).toBe(false);
    }
    expect(res.stdout_excerpt.length).toBeLessThanOrEqual(MAX_STDOUT_EXCERPT);
  });

  it("re-applies the cap after redaction grows the excerpt past it", async () => {
    const secretValue = "hunter2supersecret";
    const res = await runManifest(join(FIXTURES, "test-redact-cap.yaml"), {
      env: { ...process.env, PATH: shimPath, MY_SECRET_TOKEN: secretValue },
    });
    expect(res.exit_class).toBe("ok");
    expect(res.truncated).toBe(false);
    // The full redaction marker is present (not a truncated fragment), the
    // secret value is gone, and the excerpt stays within the cap.
    expect(res.stdout_excerpt).toContain("[REDACTED:MY_SECRET_TOKEN]");
    expect(res.stdout_excerpt).not.toContain(secretValue);
    expect(res.stdout_excerpt.length).toBeLessThanOrEqual(MAX_STDOUT_EXCERPT);
    // No partial marker bleeds at the tail.
    expect(res.stdout_excerpt.endsWith("[REDACTED")).toBe(false);
  });

  it("keeps stdout_excerpt within the cap with multi-byte content at the cut", async () => {
    const res = await runManifest(join(FIXTURES, "test-euro.yaml"), {
      env: { ...process.env, PATH: shimPath },
    });
    expect(res.exit_class).toBe("ok");
    expect(res.truncated).toBe(true);
    expect(res.stdout_excerpt.length).toBeLessThanOrEqual(MAX_STDOUT_EXCERPT);
  });

  it("caps the env-keys log line at 50 keys + ellipsis (INV-3)", async () => {
    const env: NodeJS.ProcessEnv = { ...process.env, PATH: shimPath };
    for (let i = 0; i < 60; i++) {
      env[`QDS_PAD_${String(i).padStart(2, "0")}`] = `pad-value-${i}`;
    }
    const { stderr } = await withCapturedStderr(() =>
      runManifest(join(FIXTURES, "test-env.yaml"), { env }),
    );
    const logLine = stderr.split("\n").find((l) => l.includes("env keys ->"));
    expect(logLine).toBeDefined();
    const shown = logLine!.split("-> ")[1]!.split(",");
    expect(shown).toHaveLength(51);
    expect(shown[50]).toBe("...");
    const listed = shown.slice(0, 50);
    expect([...listed].sort()).toEqual(listed);
    // Key NAMES only: no value may appear in the log line.
    expect(logLine!).not.toContain("pad-value-");
  });

  it("filters undefined-valued env entries (cleanEnv) before merging and logging", async () => {
    const { stderr } = await withCapturedStderr(() =>
      runManifest(join(FIXTURES, "test-env.yaml"), {
        env: { ...process.env, PATH: shimPath, QDS_UNDEFINED_KEY: undefined },
      }),
    );
    const logLine = stderr.split("\n").find((l) => l.includes("env keys ->"));
    expect(logLine).toBeDefined();
    expect(logLine!).not.toContain("QDS_UNDEFINED_KEY");
  });

  it("sanitizes control characters in env key names for logging (INV-3)", async () => {
    const badKey = "BAD\r\nKEY\x01";
    const { stderr } = await withCapturedStderr(() =>
      runManifest(join(FIXTURES, "test-env.yaml"), {
        env: { ...process.env, PATH: shimPath, [badKey]: "value" },
      }),
    );
    const logLine = stderr.split("\n").find((l) => l.includes("env keys ->"));
    expect(logLine).toBeDefined();
    // The raw multi-line key name must not appear in the log line.
    expect(logLine!).not.toContain(badKey);
    // Control chars are replaced with '?' so the log stays single-line.
    expect(logLine!).toContain("BAD??KEY?");
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
