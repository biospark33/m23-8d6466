import { describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  buildWorkerArgv,
  RAW_CAPTURE_TRUNCATION_MARKER,
  REPO_ROOT,
  resolveExtensionPaths,
  SCHEMA_INSTRUCTION,
  validateExtensionArgs,
  writeRawWorkerCapture,
} from "../scripts/team-lead-driver.ts";

const base = {
  agentId: "worker-a",
  provider: "openrouter",
  model: "openai/gpt-oss-20b:free",
  prompt: "do the thing",
};

/** The exact argv shipped before DF1.9 (team-lead-driver.ts:129-141). */
const TODAYS_ARGV = [
  "--provider",
  "openrouter",
  "--model",
  "openai/gpt-oss-20b:free",
  "--mode",
  "json",
  "--no-session",
  "-p",
  `do the thing\n\n${SCHEMA_INSTRUCTION}`,
];

describe("buildWorkerArgv — lean is opt-in (DF1.9)", () => {
  it("reproduces today's 9-element argv byte-for-byte when no lean key is set (AC3)", () => {
    const argv = buildWorkerArgv(base);
    expect(argv).toEqual(TODAYS_ARGV);
    expect(argv).toHaveLength(9);
  });

  it("reproduces it for lean:false and for an empty extensions list too", () => {
    expect(buildWorkerArgv({ ...base, lean: false })).toEqual(TODAYS_ARGV);
    expect(buildWorkerArgv({ ...base, lean: false, extensions: [] })).toEqual(TODAYS_ARGV);
  });

  it("adds exactly --no-extensions --no-skills under lean, before -p (AC2)", () => {
    const argv = buildWorkerArgv({ ...base, lean: true });
    expect(argv).toEqual([
      "--provider",
      "openrouter",
      "--model",
      "openai/gpt-oss-20b:free",
      "--mode",
      "json",
      "--no-session",
      "--no-extensions",
      "--no-skills",
      "-p",
      `do the thing\n\n${SCHEMA_INSTRUCTION}`,
    ]);
    // -p stays LAST and still carries prompt + schema instruction.
    expect(argv[argv.length - 2]).toBe("-p");
    expect(argv[argv.length - 1]).toContain(SCHEMA_INSTRUCTION);
  });

  it("emits one -e pair per allowlist entry, all before -p (AC2, INV-3)", () => {
    const argv = buildWorkerArgv({
      ...base,
      lean: true,
      extensions: ["cli-anything/src", "scripts/lib"],
    });
    const pIndex = argv.indexOf("-p");
    expect(argv.slice(7, pIndex)).toEqual([
      "--no-extensions",
      "--no-skills",
      "-e",
      "cli-anything/src",
      "-e",
      "scripts/lib",
    ]);
    // Explicit -e paths survive --no-extensions: it disables DISCOVERY only.
    expect(argv.filter((a) => a === "-e")).toHaveLength(2);
    expect(pIndex).toBe(argv.length - 2);
  });

  // INV-EXT-LOAD: `-e` pairs must load under discovery-on too. The lean gate
  // made extensions unreachable for non-lean workers, so a roster role asking
  // for an extension without opting into lean silently got nothing.
  it("emits -e pairs for extensions without lean", () => {
    const argv = buildWorkerArgv({
      agentId: "worker",
      provider: "openrouter",
      model: "deepseek/deepseek-v3.2",
      prompt: "p",
      extensions: ["pi-vs-claude-code-vendor/self-compact/extensions/self-compact/self-compact.ts"],
    });
    expect(argv).toContain("-e");
    expect(argv.filter((a) => a === "-e")).toHaveLength(1);
    expect(argv.join(" ")).toContain("self-compact.ts");
    // byte-identical default path preserved: no extensions key at all
    const plain = buildWorkerArgv({
      agentId: "worker",
      provider: "openrouter",
      model: "deepseek/deepseek-v3.2",
      prompt: "p",
    });
    expect(plain).not.toContain("-e");
  });

  // INV-EXT-ARGS: extensionArgs ride the argv before -p; an unknown flag or a
  // missing value is rejected fail-closed, never silently dropped.
  it("extensionArgs land on the argv before -p and reject unknown flags", () => {
    const argv = buildWorkerArgv({
      ...base,
      extensionArgs: ["--compact-soft-at", "30%", "--compact-at", "50%", "--compact-buffer", "10%"],
    });
    expect(argv.indexOf("-p")).toBeGreaterThan(argv.indexOf("--compact-buffer"));

    const bad = validateExtensionArgs(["--evil", "x"]);
    expect(bad.ok).toBe(false);
    const odd = validateExtensionArgs(["--compact-at"]);
    expect(odd.ok).toBe(false);
  });
});

describe("resolveExtensionPaths — repo-root containment (INV-2)", () => {
  const root = REPO_ROOT;

  it("is anchored to the REPO ROOT, not the invoking cwd", () => {
    // The driver is spawned with no `cwd` option, so it inherits the
    // operator's shell directory. Anchoring to cwd would make INV-2 a
    // statement about where someone happened to stand: run from $HOME and
    // `extensions: [".ssh"]` would be "inside the root".
    expect(REPO_ROOT).toBe(resolve(import.meta.dir, "..", ".."));
    expect(resolveExtensionPaths([".ssh"], process.env.HOME ?? "/tmp").ok).toBe(true);
    // …but against the real root it is refused.
    expect(resolveExtensionPaths([`${process.env.HOME ?? "/tmp"}/.ssh`], root).ok).toBe(
      false,
    );
  });

  it("accepts paths inside the repo root and returns them RESOLVED", () => {
    // The checked string must be the string that reaches pi's argv: pi
    // resolves `-e` against its own cwd, so returning the raw entry would let
    // a validated relative path load from somewhere else — or silently from
    // nowhere, which is the INV-3 capability loss.
    expect(resolveExtensionPaths(["cli-anything/src", "./scripts"], root)).toEqual({
      ok: true,
      paths: [join(root, "cli-anything/src"), join(root, "scripts")],
    });
  });

  it("rejects traversal, absolute escapes and the root's own prefix twin", () => {
    for (const bad of [
      "../outside",
      "cli-anything/../../outside",
      "/etc/passwd",
      `${root}-sibling/evil`, // string-prefix match would wrongly accept this
    ]) {
      const res = resolveExtensionPaths([bad], root);
      expect(res.ok).toBe(false);
      // The offending path is echoed for the operator…
      expect(res.ok === false && res.rejected).toBe(bad);
    }
  });

  it("rejects the whole list if any single entry escapes — never sanitizes", () => {
    const res = resolveExtensionPaths(["cli-anything/src", "../outside"], root);
    expect(res.ok).toBe(false);
    expect(res.ok === false && res.rejected).toBe("../outside");
  });

  it("rejects a SYMLINK that escapes the root — lexical containment is not enough", () => {
    const link = join(root, `df19-symlink-probe-${process.pid}`);
    try {
      symlinkSync("/etc", link);
      const rel = link.slice(root.length + 1);
      // Lexically this is `<root>/df19-symlink-probe-N` — inside the root.
      // Following it lands in /etc, which is not.
      expect(resolveExtensionPaths([rel], root).ok).toBe(false);
    } finally {
      rmSync(link, { force: true });
    }
  });

  it("accepts a path reached through a symlinked prefix (no false positive)", () => {
    // macOS: /tmp -> /private/tmp, /var -> /private/var. `root` is realpath'd,
    // so an absolute path written through the symlinked prefix resolves to the
    // same directory but does NOT match lexically. Rejecting it would break
    // real manifests on any repo or CI checkout reached via a symlink.
    const realRoot = mkdtempSync(join(tmpdir(), "df19-realroot-"));
    try {
      mkdirSync(join(realRoot, "ext"), { recursive: true });
      // tmpdir() is the symlinked form on macOS; realpathSync gives the real one.
      const symlinkedForm = join(realRoot, "ext");
      const realForm = join(realpathSync(realRoot), "ext");
      expect(resolveExtensionPaths([symlinkedForm], realpathSync(realRoot)).ok).toBe(true);
      expect(resolveExtensionPaths([realForm], realRoot).ok).toBe(true);
    } finally {
      rmSync(realRoot, { recursive: true, force: true });
    }
  });

  it("rejects empty and whitespace-only entries", () => {
    // The manifest schema blocks these, but QDS_AGENT_TEAM_CONFIG_JSON is an
    // in-scope seam and is parsed with a bare cast — `-e ""` must not reach pi.
    for (const bad of ["", "   ", "\t"]) {
      expect(resolveExtensionPaths([bad], root).ok).toBe(false);
    }
  });

  it("rejects non-string entries instead of throwing", () => {
    // path.resolve(root, 123) throws a TypeError; inside the runWorkerPi
    // promise executor that would reject Promise.all and kill the whole team
    // run rather than degrading one worker to partial.
    for (const bad of [123, null, undefined, {}, []]) {
      expect(() => resolveExtensionPaths([bad], root)).not.toThrow();
      expect(resolveExtensionPaths([bad], root).ok).toBe(false);
    }
  });

  it("treats an empty list as trivially fine", () => {
    expect(resolveExtensionPaths([], root)).toEqual({ ok: true, paths: [] });
  });

  it("accepts the repo root itself", () => {
    expect(resolveExtensionPaths(["."], root).ok).toBe(true);
  });
});

describe("driver wiring — refusal happens BEFORE spawn (DoD Security, INV-2/INV-3)", () => {
  const DRIVER = join(import.meta.dir, "..", "scripts", "team-lead-driver.ts");

  /** Runs the driver with a pi stub that records every invocation. */
  function runDriver(workers: unknown[], rawDir?: string) {
    const stub = mkdtempSync(join(tmpdir(), "df19-pi-stub-"));
    const marker = join(stub, "spawned.log");
    try {
      writeFileSync(
        join(stub, "pi"),
        [
          "#!/usr/bin/env bun",
          'import { appendFileSync } from "node:fs";',
          `appendFileSync(${JSON.stringify(marker)}, JSON.stringify(process.argv.slice(2)) + "\\n");`,
          'const m = { role: "assistant", content: [{ type: "text", text: JSON.stringify({ changedFiles: [], result: { summary: "ok" } }) }], usage: { input: 10, output: 1, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } } };',
          'console.log(JSON.stringify({ type: "message_end", message: m }));',
          "process.exit(0);",
          "",
        ].join("\n"),
        { mode: 0o755 },
      );
      const proc = spawnSync("bun", [DRIVER], {
        encoding: "utf8",
        env: {
          PATH: `${stub}:${process.env.PATH ?? ""}`,
          HOME: process.env.HOME ?? "/tmp",
          QDS_AGENT_TEAM_CONFIG_JSON: JSON.stringify({ workers }),
          ...(rawDir !== undefined ? { QDS_TEAM_RAW_WORKER_DIR: rawDir } : {}),
        },
      });
      const spawns = existsSync(marker)
        ? readFileSync(marker, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l) as string[])
        : [];
      return { stderr: proc.stderr ?? "", stdout: proc.stdout ?? "", spawns };
    } finally {
      rmSync(stub, { recursive: true, force: true });
    }
  }

  const worker = (extra: Record<string, unknown>) => ({
    agentId: "worker-a",
    provider: "openrouter",
    model: "m",
    prompt: "p",
    ...extra,
  });

  it("never execs pi for a lean worker whose extension escapes the root", () => {
    const r = runDriver([worker({ lean: true, extensions: ["../../../etc"] })]);
    // The path is echoed for the operator…
    expect(r.stderr).toContain("escapes the repo root");
    expect(r.stderr).toContain("../../../etc");
    // …and pi was never invoked at all. This is the assertion that would fail
    // if the guard were refactored away — the unit test on
    // resolveExtensionPaths alone would still pass.
    expect(r.spawns).toHaveLength(0);
  }, 30_000);

  it("execs pi with the RESOLVED extension path for a legitimate entry", () => {
    const r = runDriver([worker({ lean: true, extensions: ["cli-anything/src"] })]);
    expect(r.spawns).toHaveLength(1);
    const argv = r.spawns[0] as string[];
    expect(argv).toContain("--no-extensions");
    expect(argv).toContain("--no-skills");
    // Absolute, repo-root-anchored — not the raw relative string, which pi
    // would re-resolve against its own cwd.
    expect(argv[argv.indexOf("-e") + 1]).toBe(join(REPO_ROOT, "cli-anything/src"));
  }, 30_000);

  // INV-2 after 3f459de1 (`-e` under both profiles): extensions are no longer
  // a lean-only field, so containment must not be either — a non-lean worker's
  // `-e` pairs reach pi exactly the same way.
  it("never execs pi for a NON-lean worker whose extension escapes the root", () => {
    const r = runDriver([worker({ extensions: ["../outside-root/evil.ts"] })]);
    expect(r.stderr).toContain("escapes the repo root");
    expect(r.stderr).toContain("../outside-root/evil.ts");
    expect(r.spawns).toHaveLength(0);
    // …and the refusal resolved with empty text + exit null, which the driver
    // reports downstream instead of spawning a half-configured worker.
    expect(r.stderr).toContain("worker worker-a failed (exit null)");
  }, 30_000);

  it("execs pi with the RESOLVED extension path for a NON-lean worker", () => {
    const r = runDriver([worker({ extensions: ["cli-anything/src"] })]);
    expect(r.spawns).toHaveLength(1);
    const argv = r.spawns[0] as string[];
    // Discovery-on profile: no --no-extensions/--no-skills, but the -e pair
    // is present and carries the containment-resolved absolute path — not the
    // raw relative string pi would re-resolve against its own cwd.
    expect(argv).not.toContain("--no-extensions");
    expect(argv[argv.indexOf("-e") + 1]).toBe(join(REPO_ROOT, "cli-anything/src"));
  }, 30_000);

  it("writes no capture anywhere when QDS_TEAM_RAW_WORKER_DIR is unset (AC5, run level)", () => {
    const probe = mkdtempSync(join(tmpdir(), "df19-nocapture-"));
    try {
      const r = runDriver([worker({})]);
      expect(r.spawns).toHaveLength(1);
      // Nothing was created in the probe dir, and the driver logged no capture.
      expect(readdirSync(probe)).toEqual([]);
      expect(r.stderr).not.toContain("raw stream ->");
    } finally {
      rmSync(probe, { recursive: true, force: true });
    }
  }, 30_000);

  it("writes exactly one 0600 capture per worker when the dir IS set", () => {
    const rawDir = mkdtempSync(join(tmpdir(), "df19-capture-on-"));
    try {
      runDriver([worker({})], rawDir);
      expect(readdirSync(rawDir)).toEqual(["worker-a.ndjson"]);
      expect(statSync(join(rawDir, "worker-a.ndjson")).mode & 0o777).toBe(0o600);
    } finally {
      rmSync(rawDir, { recursive: true, force: true });
    }
  }, 30_000);
});

describe("writeRawWorkerCapture — opt-in redacted capture (INV-1, AC5)", () => {
  const secretEnv = { OPENROUTER_API_KEY: "sk-or-v1-abcdef0123456789abcdef" };

  it("writes nothing anywhere when QDS_TEAM_RAW_WORKER_DIR is unset (AC5)", () => {
    const res = writeRawWorkerCapture(undefined, "worker-a", "line\n", secretEnv);
    expect(res).toBeNull();
  });

  it("writes <agentId>.ndjson mode 0600 into the given directory", () => {
    const dir = mkdtempSync(join(tmpdir(), "df19-raw-"));
    try {
      const path = writeRawWorkerCapture(dir, "worker-a", '{"a":1}\n', secretEnv);
      expect(path).toBe(join(dir, "worker-a.ndjson"));
      // Not writeArtifactAtomic: no JSON.stringify, no forced .json suffix.
      expect(readFileSync(path as string, "utf8")).toBe('{"a":1}\n');
      expect(statSync(path as string).mode & 0o777).toBe(0o600);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("redacts parent-env secret values before they hit disk (INV-1)", () => {
    const dir = mkdtempSync(join(tmpdir(), "df19-raw-redact-"));
    try {
      const raw = `{"prompt":"key is ${secretEnv.OPENROUTER_API_KEY} ok"}\n`;
      const path = writeRawWorkerCapture(dir, "worker-a", raw, secretEnv);
      const written = readFileSync(path as string, "utf8");
      expect(written).not.toContain(secretEnv.OPENROUTER_API_KEY);
      expect(written).toContain("OPENROUTER_API_KEY");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refuses an agentId that is not a single safe path component", () => {
    const dir = mkdtempSync(join(tmpdir(), "df19-raw-unsafe-"));
    try {
      for (const bad of ["../escape", "a/b", "..", ".", ""]) {
        expect(writeRawWorkerCapture(dir, bad, "x", secretEnv)).toBeNull();
      }
      expect(() => statSync(join(dir, "escape.ndjson"))).toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("forces 0600 even when the file already exists with looser permissions", () => {
    const dir = mkdtempSync(join(tmpdir(), "df19-raw-preexist-"));
    try {
      const path = join(dir, "worker-a.ndjson");
      writeFileSync(path, "stale", { mode: 0o644 });
      // writeFileSync's `mode` applies only at CREATION — a pre-existing 0644
      // file would silently keep its mode and the INV-1 claim would be false.
      writeRawWorkerCapture(dir, "worker-a", "fresh", secretEnv);
      expect(statSync(path).mode & 0o777).toBe(0o600);
      expect(readFileSync(path, "utf8")).toBe("fresh");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("never follows a symlink planted at the capture path", () => {
    const dir = mkdtempSync(join(tmpdir(), "df19-raw-symlink-"));
    const victimDir = mkdtempSync(join(tmpdir(), "df19-victim-"));
    try {
      const victim = join(victimDir, "victim.txt");
      writeFileSync(victim, "ORIGINAL");
      symlinkSync(victim, join(dir, "worker-a.ndjson"));
      writeRawWorkerCapture(dir, "worker-a", "CAPTURE", secretEnv);
      // The worker's compiled prompt must not be redirected into the target.
      expect(readFileSync(victim, "utf8")).toBe("ORIGINAL");
      expect(readFileSync(join(dir, "worker-a.ndjson"), "utf8")).toBe("CAPTURE");
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(victimDir, { recursive: true, force: true });
    }
  });

  it("truncates at 8 MiB and records the truncation in the file", () => {
    const dir = mkdtempSync(join(tmpdir(), "df19-raw-big-"));
    try {
      const path = writeRawWorkerCapture(
        dir,
        "worker-a",
        "x".repeat(9 * 1024 * 1024),
        {},
      );
      const written = readFileSync(path as string, "utf8");
      expect(written).toContain(RAW_CAPTURE_TRUNCATION_MARKER);
      expect(Buffer.byteLength(written, "utf8")).toBeLessThan(9 * 1024 * 1024);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("keeps the TAIL past the cap — a vanished worker's last events are the evidence", () => {
    const dir = mkdtempSync(join(tmpdir(), "df19-raw-tail-"));
    try {
      const headSentinel = "HEAD_CHATTER_NEVER_SEEN";
      const tailSentinel = '{"type":"message_end","stopReason":"error"}';
      const raw = `${headSentinel}${"x".repeat(9 * 1024 * 1024)}\n${tailSentinel}`;
      const path = writeRawWorkerCapture(dir, "worker-a", raw, {});
      const written = readFileSync(path as string, "utf8");
      expect(written).toContain(RAW_CAPTURE_TRUNCATION_MARKER);
      expect(written).toContain(tailSentinel);
      expect(written).not.toContain(headSentinel);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not leave a replacement character when truncating mid-codepoint", () => {
    const dir = mkdtempSync(join(tmpdir(), "df19-raw-utf8-"));
    try {
      // "é" is 2 bytes; 9 MiB of them guarantees the cut lands mid-codepoint.
      const path = writeRawWorkerCapture(dir, "worker-a", "é".repeat(5 * 1024 * 1024), {});
      const written = readFileSync(path as string, "utf8");
      const body = written.slice(0, written.indexOf(RAW_CAPTURE_TRUNCATION_MARKER));
      expect(body).not.toContain("�");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("resolves the capture path inside the given dir, not outside it", () => {
    const dir = mkdtempSync(join(tmpdir(), "df19-raw-contain-"));
    try {
      const path = writeRawWorkerCapture(dir, "worker-a", "x", {});
      expect(resolve(path as string).startsWith(resolve(dir))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
