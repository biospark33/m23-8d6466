/**
 * Z3 crash-window gate — fixture tier: the REAL scripts/z3/fleet-gate.sh,
 * EXECUTED DIRECTLY (no `bash` prefix — a missing exec bit fails here, as it
 * would fail every fork verb), driven through the host helper
 * (scripts/z3/crash-gate.ts) against a fake "real" fleet CLI that records the
 * exact bytes that reached it.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { crashGate } from "../../scripts/z3/crash-gate.ts";

const WRAPPER = path.resolve(import.meta.dir, "../../scripts/z3/fleet-gate.sh");

let gate: string;
let argvLog: string;
let stdinLog: string;
beforeEach(() => {
  gate = mkdtempSync(path.join(tmpdir(), "z3-gate-"));
  argvLog = path.join(gate, "argv.log");
  stdinLog = path.join(gate, "stdin.bin");
  const real = path.join(gate, "real-fleet.sh");
  // `cat > file` keeps every byte (a trailing newline included) — `$(cat)` would not.
  writeFileSync(real, `#!/bin/bash\nprintf '%s\\n' "$*" >> ${JSON.stringify(argvLog)}\ncat > ${JSON.stringify(stdinLog)}\nexit 7\n`);
  chmodSync(real, 0o755);
  writeFileSync(path.join(gate, "real-cli"), `${real}\n`);
});
afterEach(() => {
  rmSync(gate, { recursive: true, force: true });
});

function run(args: string[], brief: string) {
  return Bun.spawn([WRAPPER, ...args], {
    env: { ...process.env, Z3_GATE_DIR: gate, Z3_GATE_HOLD_LIMIT_S: "30" },
    stdin: new Blob([brief]),
    stdout: "pipe",
    stderr: "pipe",
  });
}
const codeBrief = `${JSON.stringify({ requestId: "r-code", workId: "w:z3-20261019T120000Z-code" })}\n`;
const qaBrief = JSON.stringify({ requestId: "r-qa", workId: "w:qa-20261019T120000Z-correctness" });
const argv = () => (existsSync(argvLog) ? readFileSync(argvLog, "utf8") : "");
const stdin = () => (existsSync(stdinLog) ? readFileSync(stdinLog, "utf8") : null);
const until = async (pred: () => boolean) => {
  for (let i = 0; i < 300 && !pred(); i++) await Bun.sleep(10);
};

describe("fleet-gate.sh", () => {
  test("the wrapper is executable as a file (the fork execFile()s it with shell:false)", async () => {
    expect(await run(["status"], "").exited).toBe(7);
  });

  test("a non-submit verb is exec'd straight through: argv and stdin bytes intact, exit code propagated", async () => {
    crashGate(gate).arm();
    const p = run(["result", "qds-20261019-aaaaa1", "--json"], "tail\n");
    expect(await p.exited).toBe(7);
    expect(argv()).toBe("result qds-20261019-aaaaa1 --json\n");
    expect(stdin()).toBe("tail\n");
  });

  test("an armed gate never holds a QA leg's submit, and its brief reaches the CLI byte-exact", async () => {
    crashGate(gate).arm();
    const p = run(["submit", "--request-id", "r-qa", "--json"], qaBrief);
    expect(await p.exited).toBe(7);
    expect(stdin()).toBe(qaBrief);
  });

  test("a disarmed gate passes the z3 code submit through (trailing newline kept)", async () => {
    const p = run(["submit", "--request-id", "r-code", "--json"], codeBrief);
    expect(await p.exited).toBe(7);
    expect(stdin()).toBe(codeBrief);
  });

  test("an armed z3 code submit is HELD before the exec, then released through with its brief intact", async () => {
    const g = crashGate(gate);
    g.arm();
    const p = run(["submit", "--request-id", "r-code", "--json"], codeBrief);
    await until(() => g.journalFor("r-code").some((l) => l.phase === "held"));
    await Bun.sleep(150);
    expect(stdin()).toBeNull(); // nothing exec'd while held
    g.release();
    expect(await p.exited).toBe(7);
    expect(stdin()).toBe(codeBrief);
    expect(g.journalFor("r-code").map((l) => l.phase)).toEqual(["held", "released", "exec"]);
  });

  test("the requestId resolves from --request-id=<id> and, failing that, from the brief", async () => {
    const g = crashGate(gate);
    g.arm();
    g.release();
    expect(await run(["submit", "--request-id=r-code", "--json"], codeBrief).exited).toBe(7);
    expect(await run(["submit", "--json"], codeBrief).exited).toBe(7);
    expect(g.journalFor("r-code").filter((l) => l.phase === "exec")).toHaveLength(2);
  });

  test("an armed code submit whose requestId cannot be resolved is refused (99), never held blind", async () => {
    const g = crashGate(gate);
    g.arm();
    expect(await run(["submit", "--json"], JSON.stringify({ workId: "w:z3-s-code" })).exited).toBe(99);
    expect(stdin()).toBeNull();
  });

  test("abort: a held submit exits 99 having exec'd nothing", async () => {
    const g = crashGate(gate);
    g.arm();
    const p = run(["submit", "--request-id", "r-code", "--json"], codeBrief);
    await until(() => g.journalFor("r-code").some((l) => l.phase === "held"));
    g.abort();
    expect(await p.exited).toBe(99);
    expect(stdin()).toBeNull();
    expect(g.journalFor("r-code").map((l) => l.phase)).toEqual(["held", "aborted"]);
  });

  test("a TERM during the hold (the fork's own execFile timeout) exits 99 with no exec, journaled expired", async () => {
    const g = crashGate(gate);
    g.arm();
    const p = run(["submit", "--request-id", "r-code", "--json"], codeBrief);
    await until(() => g.journalFor("r-code").some((l) => l.phase === "held"));
    p.kill("SIGTERM");
    expect(await p.exited).toBe(99);
    expect(stdin()).toBeNull();
    expect(g.journalFor("r-code").map((l) => l.phase)).toEqual(["held", "expired"]);
  });

  test("every journal line carries an epoch-ms timestamp", async () => {
    const g = crashGate(gate);
    g.arm();
    g.release();
    const before = Date.now() - 2000;
    expect(await run(["submit", "--request-id", "r-code", "--json"], codeBrief).exited).toBe(7);
    for (const l of g.journalFor("r-code")) {
      expect(l.at).toBeGreaterThanOrEqual(before);
      expect(l.at).toBeLessThanOrEqual(Date.now() + 1000);
    }
  });

  test("the wrapper is committed executable in the git index (a clone without +x fails every fork verb)", () => {
    const out = Bun.spawnSync(["git", "ls-files", "-s", "scripts/z3/fleet-gate.sh"], { cwd: path.resolve(import.meta.dir, "../..") });
    expect(out.stdout.toString().split(" ")[0]).toBe("100755");
  });

  test("abort wins over everything: disarmed, released, or arriving after cleanup — a code submit exits 99", async () => {
    const g = crashGate(gate);
    g.arm();
    g.release();
    g.abort();
    expect(await run(["submit", "--request-id", "r-code", "--json"], codeBrief).exited).toBe(99);
    rmSync(path.join(gate, "armed"));
    expect(await run(["submit", "--request-id", "r-code", "--json"], codeBrief).exited).toBe(99);
    expect(stdin()).toBeNull();
    // ...while a QA submit still passes (abort guards only the code run)
    expect(await run(["submit", "--request-id", "r-qa", "--json"], qaBrief).exited).toBe(7);
  });

  test("the hold limit ends a hold the driver never released (exit 99, journaled expired)", async () => {
    const g = crashGate(gate);
    g.arm();
    const p = Bun.spawn([WRAPPER, "submit", "--request-id", "r-code"], {
      env: { ...process.env, Z3_GATE_DIR: gate, Z3_GATE_HOLD_LIMIT_S: "0" },
      stdin: new Blob([codeBrief]),
    });
    expect(await p.exited).toBe(99);
    expect(g.journalFor("r-code").map((l) => l.phase)).toEqual(["held", "expired"]);
  });

  test("an unconfigured gate (no real-cli) refuses with 98, and arm() refuses to arm it", async () => {
    rmSync(path.join(gate, "real-cli"));
    expect(await run(["status"], "").exited).toBe(98);
    expect(() => crashGate(gate).arm()).toThrow(/real-cli missing/);
  });
});
describe("z3 fleet gate — the wrapper crosses the fence with the memory env", () => {
  const WRAPPER19 = path.resolve(import.meta.dir, "../../scripts/z3/fleet-gate.sh");
  const FENCED_ENV19: Record<string, string> = {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    HOME: process.env.HOME ?? "/tmp",
    TMPDIR: process.env.TMPDIR ?? "/tmp",
    LANG: "",
    Z3_GATE_DIR: "",
  };
  const makeGate19 = (): string => mkdtempSync(path.join(tmpdir(), "z3-gate19-"));
  const runWrapper19 = (gate: string, argv: string[]): { status: number; stdout: string } => {
    const env = { ...FENCED_ENV19, Z3_GATE_DIR: gate };
    const p = Bun.spawnSync([WRAPPER19, ...argv], { env });
    return { status: p.exitCode ?? 0, stdout: p.stdout.toString() };
  };
  test("hindsight.env present: the sourced env reaches the real CLI with the argv verbatim", () => {
    const gate = makeGate19();
    try {
      const cli = path.join(gate, "capture-cli.sh");
      writeFileSync(cli, ["#!/bin/sh", `env > "${gate}/out.env"`, 'echo "CLI saw $*"', "exit 0"].join("\n"), {
        mode: 0o755,
      });
      writeFileSync(path.join(gate, "real-cli"), `${cli}\n`);
      writeFileSync(path.join(gate, "hindsight.env"), "HINDSIGHT_BASE_URL=http://in-test:8888\n");
      const r = runWrapper19(gate, ["status", "--driver", "fake"]);
      expect(r.status).toBe(0);
      const received = readFileSync(path.join(gate, "out.env"), "utf8");
      expect(received).toContain("HINDSIGHT_BASE_URL=http://in-test:8888");
      expect(r.stdout).toContain("CLI saw status --driver fake");
    } finally {
      rmSync(gate, { recursive: true, force: true });
    }
  });
  test("hindsight.env absent: no memory env crosses (the old behavior stands)", () => {
    const gate = makeGate19();
    try {
      const cli = path.join(gate, "capture-cli.sh");
      writeFileSync(cli, ["#!/bin/sh", `env > "${gate}/out.env"`, "exit 0"].join("\n"), { mode: 0o755 });
      writeFileSync(path.join(gate, "real-cli"), `${cli}\n`);
      const r = runWrapper19(gate, ["status", "--driver", "fake"]);
      expect(r.status).toBe(0);
      expect(readFileSync(path.join(gate, "out.env"), "utf8")).not.toContain("HINDSIGHT_BASE_URL=");
    } finally {
      rmSync(gate, { recursive: true, force: true });
    }
  });
});
