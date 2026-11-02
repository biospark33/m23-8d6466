// Round-19 priming fix: the SC2.5 fence strips HINDSIGHT_* from the fork's
// fleet-CLI child (protocol-factory-exec.ts buildFleetEnv allows only
// PATH/HOME/TMPDIR/LANG), so the code run's dispatch could never prime — the
// recall row stayed absent and priming-recall red'd ("dispatch recall
// directive absent", measured live in round 18 and all four round-19
// attempts). The wrapper's own philosophy is "config rides FILES, not env":
// the fix sources the operator's gate-dir hindsight.env (0600, untracked)
// before EVERY exec path (non-submit verbs exec'd straight through, held
// submits released here, plain submits). These tests prove the FILE is the
// mechanism: the env reaches the real CLI, the argv arrives intact, and an
// absent file keeps the old no-sourcing behavior.
import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const WRAPPER = join(import.meta.dir, "..", "..", "scripts", "z3", "fleet-gate.sh");

const FENCED_ENV = {
  PATH: process.env.PATH ?? "/usr/bin:/bin",
  HOME: process.env.HOME ?? "/tmp",
  TMPDIR: process.env.TMPDIR ?? "/tmp",
  LANG: process.env.LANG ?? "",
  Z3_GATE_DIR: "", // filled per test
} as Record<string, string>;

function makeGate(): string {
  return mkdtempSync(join(tmpdir(), "z3-gate-"));
}

function runWrapper(gate: string, argv: string[]): { status: number; stdout: string } {
  const env = { ...FENCED_ENV, Z3_GATE_DIR: gate };
  const p = Bun.spawnSync(["bash", WRAPPER, ...argv], { env });
  return { status: p.exitCode ?? 0, stdout: p.stdout.toString() };
}

describe("z3 fleet gate — the wrapper crosses the fence with the memory env", () => {
  test("hindsight.env present: the sourced env reaches the real CLI with the argv verbatim", () => {
    const gate = makeGate();
    try {
      // real-cli names the real CLI's absolute path (the wrapper execs
      // `$(head -n1 real-cli)`); the CLI itself captures its env + argv.
      const cli = join(gate, "capture-cli.sh");
      writeFileSync(
        cli,
        ["#!/bin/sh", `env > "${gate}/out.env"`, 'echo "CLI saw $*"', "exit 0"].join("\n"),
        { mode: 0o755 },
      );
      writeFileSync(join(gate, "real-cli"), `${cli}\n`);
      writeFileSync(join(gate, "hindsight.env"), "HINDSIGHT_BASE_URL=http://in-test:8888\n");
      const r = runWrapper(gate, ["status", "--driver", "fake"]);
      expect(r.status).toBe(0);
      const received = readFileSync(join(gate, "out.env"), "utf8");
      expect(received).toContain("HINDSIGHT_BASE_URL=http://in-test:8888");
      // The argv crossed untouched (non-submit verbs exec straight through).
      expect(r.stdout).toContain("CLI saw status --driver fake");
    } finally {
      rmSync(gate, { recursive: true, force: true });
    }
  });

  test("hindsight.env absent: no memory env crosses (the old behavior stands)", () => {
    const gate = makeGate();
    try {
      const cli = join(gate, "capture-cli.sh");
      writeFileSync(cli, ["#!/bin/sh", `env > "${gate}/out.env"`, "exit 0"].join("\n"), { mode: 0o755 });
      writeFileSync(join(gate, "real-cli"), `${cli}\n`);
      const r = runWrapper(gate, ["status", "--driver", "fake"]);
      expect(r.status).toBe(0);
      expect(readFileSync(join(gate, "out.env"), "utf8")).not.toContain("HINDSIGHT_BASE_URL=");
    } finally {
      rmSync(gate, { recursive: true, force: true });
    }
  });
});
