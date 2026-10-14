/**
 * DF4.2 deploy tests (AC3/AC4/INV-1/INV-2/INV-3/INV-5).
 *
 * FakeDriver spawns real child processes with the box dir as cwd (see
 * src/providers/fake-driver.ts), so `startVisualizer`'s in-box script really
 * launches the real DF4.1 server on the real host loopback — no network
 * mocking, the same integration-test style tests/providers/teardown.test.ts
 * already uses.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { FakeDriver } from "../../src/providers/fake-driver.ts";
import { RecordingDriver } from "../../tests/providers/fixtures/recording-driver.ts";
import { ExeDevDriverError } from "../../src/providers/exedev/transport.ts";
import { DEFAULT_RUNS_DIR } from "../../src/providers/run-record.ts";
import { assertEnvFileSafe, startVisualizer, stopVisualizer, TOKEN_PATH } from "../deploy.ts";
import { seedTrace } from "./fixtures/trace-fixture.ts";

const VIZ_DIR = resolve(import.meta.dir, "..");

/** A free-ish loopback port, grabbed and released immediately. */
async function freePort(): Promise<number> {
  const srv = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
  const port = srv.port;
  srv.stop(true);
  return port;
}

let dir: string;
let driver: FakeDriver;
let recording: RecordingDriver;
let seeded: ReturnType<typeof seedTrace>;
/** Per-test injected host token path (item 3) — never the developer's real ~/.qds/viz-token. */
let tokenPath: string;
/**
 * Per-test in-box env/pid/log paths. FakeDriver runs every "box" as a process
 * on THIS host, so driver.ts's default /tmp/qds-viz.{pid,env,log} are shared
 * across every vm AND across concurrent runs of this suite. Injected per test
 * they are not, so two runs no longer SIGKILL each other's server.
 */
let vizFiles: { envFile: string; pidFile: string; logFile: string };

/**
 * Is `pid` actually the visualizer process this suite spawned, not some
 * unrelated process the OS has since recycled the pid onto? FakeDriver runs
 * "boxes" as real host processes launched by driver.ts's own spawn script
 * (`nohup bun run server/index.ts & echo $! > pidfile`), so checking the
 * live command line is enough to tell the two apart before signalling.
 */
function isVizProcess(pid: number): boolean {
  try {
    const cmd = execFileSync("ps", ["-p", String(pid), "-o", "command="], { encoding: "utf8" });
    return cmd.includes("server/index.ts");
  } catch {
    return false; // no such pid — nothing to verify or kill
  }
}

/**
 * FakeDriver runs every "box" as a real process on THIS host, so the fixed
 * absolute paths driver.ts's startVisualizer/stopVisualizer use
 * (/tmp/qds-viz.{pid,env,log}) are shared across every vm in a test run —
 * unlike a real exe.dev box, where /tmp is genuinely box-local. That's a
 * testing artifact, not a production bug: it just means every test here
 * must leave the shared state clean, or the next test inherits a live
 * server on a stale port and times out chasing a listener that isn't there.
 * A stale/recycled pid in that shared file is verified against its live
 * command line (see `isVizProcess`) before it is ever signalled — a
 * leftover file naming a pid the OS has since reissued to an unrelated
 * process must never be SIGKILLed.
 */
function hardResetVizState(files: string[]): void {
  const [pidfile] = files;
  try {
    const pid = Number(readFileSync(pidfile as string, "utf8").trim());
    if (pid && isVizProcess(pid)) process.kill(pid, "SIGKILL");
  } catch {
    /* no pidfile, or pid already gone */
  }
  for (const f of files) {
    try {
      unlinkSync(f);
    } catch {
      /* absent is fine */
    }
  }
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "qds-df42-deploy-"));
  vizFiles = {
    envFile: join(dir, "qds-viz.env"),
    pidFile: join(dir, "qds-viz.pid"),
    logFile: join(dir, "qds-viz.log"),
  };
  driver = new FakeDriver(join(dir, "boxes"));
  recording = new RecordingDriver(driver);
  seeded = seedTrace();
  // Injection seam (item 3): a per-test tmp path, never the developer's real
  // $HOME/.qds/viz-token. mintOrReuseToken creates the parent dir itself.
  tokenPath = join(dir, "qds-home", "viz-token");
});

afterEach(() => {
  hardResetVizState([vizFiles.pidFile, vizFiles.envFile, vizFiles.logFile]);
  seeded.cleanup();
  rmSync(dir, { recursive: true, force: true });
});

async function makeVm(name: string): Promise<void> {
  await recording.create(name);
}

describe("DF4.2 startVisualizer/stopVisualizer", () => {
  test(
    "AC3: starts loopback-bound and gated, is idempotent (second call reuses, one listener)",
    async () => {
      const vm = "df42-viz-start";
      await makeVm(vm);
      const port = await freePort();

      const first = await startVisualizer(recording, { vm, dbPath: seeded.dbPath, port, cwd: VIZ_DIR, tokenPath, ...vizFiles });
      expect(first.reused).toBeFalse();
      expect(first.port).toBe(port);
      expect(first.forwardCommand).toBe(`ssh -L ${port}:127.0.0.1:${port} ${vm}`);

      const second = await startVisualizer(recording, { vm, dbPath: seeded.dbPath, port, cwd: VIZ_DIR, tokenPath, ...vizFiles });
      expect(second.reused).toBeTrue(); // AC3: reused, not a second listener

      await stopVisualizer(recording, { vm, pidFile: vizFiles.pidFile });
    },
    30_000,
  );

  test(
    "INV-3: host token minted once, byte-identical on reuse; box delivery lands mode 600",
    async () => {
      const vm = "df42-viz-token";
      await makeVm(vm);

      await startVisualizer(recording, { vm, dbPath: seeded.dbPath, port: await freePort(), cwd: VIZ_DIR, tokenPath, ...vizFiles });
      expect(existsSync(tokenPath)).toBeTrue();
      const firstBytes = readFileSync(tokenPath, "utf8");

      // Box-side delivery landed at mode 600 — confirmed the same way DF2.3's
      // own delivery test confirms it: stat via the box, never by echoing the value.
      const stat = await recording.exec(vm, [
        "python3",
        "-c",
        "import os,sys; print(oct(os.stat(sys.argv[1]).st_mode)[-3:])",
        vizFiles.envFile,
      ]);
      expect(stat.stdout.trim()).toBe("600");

      await stopVisualizer(recording, { vm, pidFile: vizFiles.pidFile });

      // A fresh spawn (pidfile now gone, so this is a real re-start, not the
      // AC3 pidfile-reuse path) still mints nothing new — the SAME host token.
      await startVisualizer(recording, { vm, dbPath: seeded.dbPath, port: await freePort(), cwd: VIZ_DIR, tokenPath, ...vizFiles });
      const secondBytes = readFileSync(tokenPath, "utf8");
      expect(secondBytes).toBe(firstBytes); // one mint, reused verbatim

      await stopVisualizer(recording, { vm, pidFile: vizFiles.pidFile });
    },
    30_000,
  );

  test(
    "Q8/F029: rotate:true discards the persisted token and mints a fresh one at mode 600",
    async () => {
      const vm = "df42-viz-token-rotate";
      await makeVm(vm);

      await startVisualizer(recording, { vm, dbPath: seeded.dbPath, port: await freePort(), cwd: VIZ_DIR, tokenPath, ...vizFiles });
      const firstBytes = readFileSync(tokenPath, "utf8");
      await stopVisualizer(recording, { vm, pidFile: vizFiles.pidFile });

      await startVisualizer(recording, {
        vm,
        dbPath: seeded.dbPath,
        port: await freePort(),
        cwd: VIZ_DIR,
        tokenPath,
        ...vizFiles,
        rotate: true,
      });
      const rotatedBytes = readFileSync(tokenPath, "utf8");
      expect(rotatedBytes).not.toBe(firstBytes);
      expect(rotatedBytes.length).toBe(firstBytes.length);
      // Rotation re-mints through the same O_EXCL|O_NOFOLLOW path, so the new
      // file must carry the same 0600 guarantee the first mint did.
      expect(statSync(tokenPath).mode & 0o777).toBe(0o600);

      await stopVisualizer(recording, { vm, pidFile: vizFiles.pidFile });
    },
    30_000,
  );

  test("INV-3: a token file failing the mode/owner check is refused, never rewritten", async () => {
    const vm = "df42-viz-token-bad";
    await makeVm(vm);
    mkdirSync(dirname(tokenPath), { recursive: true });
    writeFileSync(tokenPath, "not-a-real-token", { mode: 0o644 }); // wrong mode
    chmodSync(tokenPath, 0o644);

    await expect(
      startVisualizer(recording, { vm, dbPath: seeded.dbPath, port: await freePort(), cwd: VIZ_DIR, tokenPath, ...vizFiles }),
    ).rejects.toThrow(ExeDevDriverError);

    // Never rewritten: still exactly the bad content, still 0644.
    expect(readFileSync(tokenPath, "utf8")).toBe("not-a-real-token");
  });

  test("INV-3: a too-short token file (e.g. a crash between mint and write) is refused, never reused silently", async () => {
    const vm = "df42-viz-token-short";
    await makeVm(vm);
    mkdirSync(dirname(tokenPath), { recursive: true, mode: 0o700 });
    writeFileSync(tokenPath, "short", { mode: 0o600 }); // well under TOKEN_MIN_BYTES (32)

    let caught: ExeDevDriverError | undefined;
    try {
      await startVisualizer(recording, { vm, dbPath: seeded.dbPath, port: await freePort(), cwd: VIZ_DIR, tokenPath, ...vizFiles });
    } catch (e) {
      caught = e as ExeDevDriverError;
    }
    expect(caught).toBeInstanceOf(ExeDevDriverError);
    expect(caught?.code).toBe("viz-token-unverifiable");
    // Never rewritten: still exactly the short content.
    expect(readFileSync(tokenPath, "utf8")).toBe("short");
  });

  test("AC4: a missing trace db surfaces the server's own named failure (VIZ_TRACE_DB_OPEN), box left alive", async () => {
    const vm = "df42-viz-missing-db";
    await makeVm(vm);
    const port = await freePort();

    let caught: ExeDevDriverError | undefined;
    try {
      await startVisualizer(recording, { vm, dbPath: join(dir, "no-such-trace.db"), port, cwd: VIZ_DIR, tokenPath, ...vizFiles });
    } catch (e) {
      caught = e as ExeDevDriverError;
    }
    expect(caught).toBeInstanceOf(ExeDevDriverError);
    expect(caught?.code).toBe("VIZ_TRACE_DB_OPEN");

    // Box untouched: still listed by the driver, never destroyed.
    const boxes = await recording.list();
    expect(boxes.some((b) => b.name === vm)).toBeTrue();
  }, 30_000);

  test("INV-2: no expose/setPublic call is ever emitted for the visualizer port", async () => {
    const vm = "df42-viz-inv2";
    await makeVm(vm);
    const port = await freePort();
    let exposeCalls = 0;
    let setPublicCalls = 0;
    const spied = Object.create(recording) as RecordingDriver;
    spied.expose = (v: string, p: number) => {
      exposeCalls++;
      return recording.expose(v, p);
    };
    spied.setPublic = (v: string) => {
      setPublicCalls++;
      return recording.setPublic(v);
    };

    await startVisualizer(spied, { vm, dbPath: seeded.dbPath, port, cwd: VIZ_DIR, tokenPath, ...vizFiles });
    await stopVisualizer(spied, { vm, pidFile: vizFiles.pidFile });

    expect(exposeCalls).toBe(0);
    expect(setPublicCalls).toBe(0);
    // Also on the raw exec argv corpus, belt over suspenders.
    const corpus = recording.execCalls.map((c) => c.argv.join(" ")).join("\n");
    expect(corpus).not.toContain("share port");
    expect(corpus).not.toContain("set-public");
  }, 30_000);

  test("stopVisualizer on a vm that never started one reports stopped:false, does not throw", async () => {
    const vm = "df42-viz-never-started";
    await makeVm(vm);
    const result = await stopVisualizer(recording, { vm, pidFile: vizFiles.pidFile });
    expect(result.stopped).toBeFalse();
  });

  test("INV-3: the host token path lies outside every harvested path", () => {
    // harvest.ts's resolveRunsDir (harvest.ts:257-260, not itself exported)
    // resolves to deps.runsDir ?? process.env.QDS_RUNS_DIR ?? DEFAULT_RUNS_DIR
    // — every artifact it pulls to the host (`<runsDir>/<runId>.bundle`,
    // `<runsDir>/<runId>-artifacts[.tgz]`) lives under that ONE root.
    // DEFAULT_RUNS_DIR is run-record.ts's own exported constant, not a
    // hand-typed guess, so this fails for real if either path drifts.
    const harvestedRoots = [resolve(DEFAULT_RUNS_DIR), resolve(dir, "custom-runs")];
    const resolvedToken = resolve(TOKEN_PATH);
    for (const root of harvestedRoots) {
      expect(resolvedToken).not.toBe(root);
      expect(resolvedToken.startsWith(`${root}/`)).toBeFalse();
    }
    // Positive control: this same assertion form DOES fire on a path that
    // really is under a harvested root — proving it isn't vacuously true.
    const wouldBeHarvested = join(harvestedRoots[0] as string, "some-run-artifacts");
    expect(wouldBeHarvested.startsWith(`${harvestedRoots[0]}/`)).toBeTrue();
    // And TOKEN_PATH really is under $HOME/.qds, not just "not under runs/".
    expect(resolvedToken.startsWith(`${resolve(homedir(), ".qds")}/`)).toBeTrue();
  });

  test("INV-3: a host mint failure other than EEXIST (e.g. an unwritable token dir) is refused with viz-token-unverifiable", async () => {
    if (typeof process.getuid === "function" && process.getuid() === 0) return; // root ignores file modes
    const vm = "df42-viz-mint-eacces";
    await makeVm(vm);
    const tokenDir = dirname(tokenPath);
    mkdirSync(tokenDir, { recursive: true });
    chmodSync(tokenDir, 0o500); // read+execute, no write: O_CREAT fails EACCES, never EEXIST
    let caught: ExeDevDriverError | undefined;
    try {
      await startVisualizer(recording, { vm, dbPath: seeded.dbPath, port: await freePort(), cwd: VIZ_DIR, tokenPath, ...vizFiles });
    } catch (e) {
      caught = e as ExeDevDriverError;
    } finally {
      chmodSync(tokenDir, 0o700); // restore before rmSync in afterEach touches anything under it
    }
    expect(caught).toBeInstanceOf(ExeDevDriverError);
    expect(caught?.code).toBe("viz-token-unverifiable");
  });

  test("INV-3: an existing token path that is a symlink is refused, never followed", async () => {
    const vm = "df42-viz-token-symlink";
    await makeVm(vm);
    mkdirSync(dirname(tokenPath), { recursive: true });
    symlinkSync("/etc/hosts", tokenPath); // "exists" for O_EXCL, but O_NOFOLLOW must refuse to open it
    let caught: ExeDevDriverError | undefined;
    try {
      await startVisualizer(recording, { vm, dbPath: seeded.dbPath, port: await freePort(), cwd: VIZ_DIR, tokenPath, ...vizFiles });
    } catch (e) {
      caught = e as ExeDevDriverError;
    }
    expect(caught).toBeInstanceOf(ExeDevDriverError);
    expect(caught?.code).toBe("viz-token-unverifiable");
    expect(caught?.message).toContain("symlink");
    // Never rewritten/relaxed/followed: still a symlink, not a regular file.
    const { lstatSync } = await import("node:fs");
    expect(lstatSync(tokenPath).isSymbolicLink()).toBeTrue();
  });

  test("AC4: a wrong-mode box-side token delivery surfaces viz-token-deliver-failed, box left alive", async () => {
    const vm = "df42-viz-deliver-bad";
    await makeVm(vm);
    const spied = Object.create(recording) as RecordingDriver;
    spied.exec = (v: string, argv: string[], stdin?: string) => {
      // vizDeliverScript's only distinguishing feature: it targets VIZ_ENVFILE.
      if (argv.some((a) => a.includes("qds-viz.env"))) {
        return Promise.resolve({ stdout: "644\n", stderr: "", exitCode: 0 });
      }
      return recording.exec(v, argv, stdin);
    };
    let caught: ExeDevDriverError | undefined;
    try {
      await startVisualizer(spied, { vm, dbPath: seeded.dbPath, port: await freePort(), cwd: VIZ_DIR, tokenPath, ...vizFiles });
    } catch (e) {
      caught = e as ExeDevDriverError;
    }
    expect(caught).toBeInstanceOf(ExeDevDriverError);
    expect(caught?.code).toBe("viz-token-deliver-failed");
    const boxes = await recording.list();
    expect(boxes.some((b) => b.name === vm)).toBeTrue(); // box left alive, never destroyed
  });

  test(
    "AC4/INV-5: a health poll that never reaches 200 surfaces viz-health-timeout, box left alive, no extra retry beyond the bounded poll",
    async () => {
      const vm = "df42-viz-health-timeout";
      await makeVm(vm);
      const spied = Object.create(recording) as RecordingDriver;
      let healthCalls = 0;
      spied.exec = (v: string, argv: string[], stdin?: string) => {
        // healthScript's distinguishing feature: it reads the token off stdin
        // with this exact shell idiom.
        if (argv.some((a) => a.includes("TOKEN=$(cat)"))) {
          healthCalls++;
          return Promise.resolve({ stdout: "TIMEOUT\n", stderr: "", exitCode: 6 });
        }
        return recording.exec(v, argv, stdin);
      };
      let caught: ExeDevDriverError | undefined;
      try {
        await startVisualizer(spied, { vm, dbPath: seeded.dbPath, port: await freePort(), cwd: VIZ_DIR, tokenPath, ...vizFiles });
      } catch (e) {
        caught = e as ExeDevDriverError;
      }
      expect(caught).toBeInstanceOf(ExeDevDriverError);
      expect(caught?.code).toBe("viz-health-timeout");
      expect(healthCalls).toBe(1); // one bounded poll script, no host-level retry loop around it
      const boxes = await recording.list();
      expect(boxes.some((b) => b.name === vm)).toBeTrue();
    },
    30_000,
  );

  test(
    "recovers from a rotated/deleted host token: restarts the stale in-box process rather than deadlocking forever",
    async () => {
      const vm = "df42-viz-token-rotated";
      await makeVm(vm);
      const port = await freePort();

      const first = await startVisualizer(recording, { vm, dbPath: seeded.dbPath, port, cwd: VIZ_DIR, tokenPath, ...vizFiles });
      expect(first.reused).toBeFalse();
      const tokenA = readFileSync(tokenPath, "utf8");

      // Simulate item 1's trigger: the host token is rotated/deleted while
      // the in-box process it was delivered to is still up (pidfile alive).
      unlinkSync(tokenPath);

      // Without the fix, this mints a fresh token B, the pidfile-alive check
      // reuses the still-running process (still holding token A), and
      // pollHealth authenticates with B forever — 401 until viz-health-timeout,
      // unrecoverable on any re-run. The fix detects the 401, restarts the
      // stale process under B, and this succeeds instead.
      const second = await startVisualizer(recording, { vm, dbPath: seeded.dbPath, port, cwd: VIZ_DIR, tokenPath, ...vizFiles });
      expect(second.port).toBe(port);
      expect(second.reused).toBeFalse(); // a real restart happened, not a reuse

      const tokenB = readFileSync(tokenPath, "utf8");
      expect(tokenB).not.toBe(tokenA); // freshly minted, since A was deleted

      // The box now really is answering under B — confirmed by a fresh
      // startVisualizer call reusing it cleanly (no 401, no restart needed).
      const third = await startVisualizer(recording, { vm, dbPath: seeded.dbPath, port, cwd: VIZ_DIR, tokenPath, ...vizFiles });
      expect(third.reused).toBeTrue();

      await stopVisualizer(recording, { vm, pidFile: vizFiles.pidFile });
    },
    30_000,
  );

  test("stopVisualizer propagates a transport failure after logging its own viz-stop-failed line", async () => {
    const vm = "df42-viz-stop-throw";
    await makeVm(vm);
    const { setLogSink } = await import("../../src/lib/log.ts");
    const logs: Record<string, unknown>[] = [];
    const restore = setLogSink((entry) => logs.push(entry as unknown as Record<string, unknown>));
    const failing = Object.create(recording) as RecordingDriver;
    failing.exec = (v: string, argv: string[], stdin?: string) => {
      if (argv.some((a) => a.includes("qds-viz.pid"))) {
        return Promise.reject(new Error("box unreachable"));
      }
      return recording.exec(v, argv, stdin);
    };
    try {
      await expect(stopVisualizer(failing, { vm, pidFile: vizFiles.pidFile })).rejects.toThrow("box unreachable");
    } finally {
      restore();
    }
    const errLine = logs.find((l) => l.operation === "deploy.stopVisualizer" && l.status === "error");
    expect(errLine).toBeDefined();
    expect((errLine?.error as { code?: string } | undefined)?.code).toBe("viz-stop-failed");
  });

  test("stopVisualizer still logs viz-stop-failed and rethrows when the driver rejects with null", async () => {
    // Regression: reading .message off a null rejection throws a TypeError
    // inside the catch handler itself, so the structured error log line is
    // never written and the original null rejection is silently replaced.
    const vm = "df42-viz-stop-null-reject";
    await makeVm(vm);
    const { setLogSink } = await import("../../src/lib/log.ts");
    const logs: Record<string, unknown>[] = [];
    const restore = setLogSink((entry) => logs.push(entry as unknown as Record<string, unknown>));
    const failing = Object.create(recording) as RecordingDriver;
    failing.exec = (v: string, argv: string[], stdin?: string) => {
      if (argv.some((a) => a.includes("qds-viz.pid"))) {
        return Promise.reject(null);
      }
      return recording.exec(v, argv, stdin);
    };
    try {
      let caught: unknown;
      try {
        await stopVisualizer(failing, { vm, pidFile: vizFiles.pidFile });
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeNull(); // the original null rejection propagates untouched
    } finally {
      restore();
    }
    const errLine = logs.find((l) => l.operation === "deploy.stopVisualizer" && l.status === "error");
    expect(errLine).toBeDefined();
    expect((errLine?.error as { code?: string } | undefined)?.code).toBe("viz-stop-failed");
  });
});
describe("assertEnvFileSafe (F034: the shared grammar, this module's error)", () => {
  test('a shell-metacharacter envFile is refused as viz-token-deliver-failed', () => {
    let err: unknown;
    try {
      assertEnvFileSafe("app/$(whoami).env");
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ExeDevDriverError);
    expect((err as ExeDevDriverError).code).toBe("viz-token-deliver-failed");
    expect(() => assertEnvFileSafe("run/viz.env")).not.toThrow();
  });
});

