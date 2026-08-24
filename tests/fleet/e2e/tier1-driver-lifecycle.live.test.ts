/**
 * T1.1 — ExeDevDriver lifecycle on REAL exe.dev (e2e-plan.md path 1).
 *
 * Proves, against the live SSH substrate (`ssh exe.dev new/rm/ls`,
 * `ssh <vm>.exe.xyz`, `scp`): whoami answers; create stands a box that appears
 * in `list()`; exec runs a real command and returns real stdout; copyFile
 * (scp box→host) round-trips content written via exec stdin; destroy removes
 * the box and `list()` no longer names it.
 *
 * ZERO model spend: no key is minted, no engine runs, no gate runs — only
 * shell no-ops (`node --version`, `uname -a`). Cost = one box for minutes.
 */
import { expect, test } from "bun:test";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

import {
  destroyQuietly,
  liveGate,
  liveTodoOff,
  preflight,
  runIdFor,
  tmpWorkspace,
  writeEvidence,
} from "./live-harness.ts";

test.todoIf(liveTodoOff())(
  "T1.1 driver lifecycle: whoami → create → list → exec → copyFile → destroy on real exe.dev",
  async () => {
    liveGate("1");
    const evidence: Record<string, unknown>[] = [];
    const ctx = await preflight();
    let vm = "";
    let workspace = "";
    let evidencePath = "";
    let outcome = "pass";
    try {
      expect(ctx.whoami.length).toBeGreaterThan(0);
      evidence.push({ phase: "whoami", ok: true, account: ctx.whoami });

      // ── create → present in list() ────────────────────────────────────────
      vm = runIdFor("t11");
      const created = await ctx.driver.create(vm);
      evidence.push({ phase: "create", ok: true, vm, providerName: created.name });
      expect(created.name).toBe(vm);

      const listed = await ctx.driver.list(vm);
      evidence.push({ phase: "list-after-create", vm, count: listed.length });
      expect(listed.some((b) => b.name === vm)).toBeTrue();

      // ── exec: real commands, real stdout ──────────────────────────────────
      // Image contract (setup-gate deps + fill): python3, curl, pi, git. NOT
      // node — probed live 2026-08-24: `node --version` exits 127 on the box.
      const pyVer = await ctx.driver.exec(vm, ["python3", "--version"]);
      evidence.push({ phase: "exec-python3-version", exitCode: pyVer.exitCode, stdout: pyVer.stdout.trim() });
      expect(pyVer.exitCode).toBe(0);
      expect(pyVer.stdout.trim()).toMatch(/^Python 3\.\d+/);

      const uname = await ctx.driver.exec(vm, ["uname", "-a"]);
      expect(uname.exitCode).toBe(0);
      expect(uname.stdout.trim().length).toBeGreaterThan(0);
      evidence.push({ phase: "exec-uname", exitCode: uname.exitCode, stdout: uname.stdout.trim() });

      const gitVer = await ctx.driver.exec(vm, ["git", "--version"]);
      evidence.push({ phase: "exec-git-version", exitCode: gitVer.exitCode, stdout: gitVer.stdout.trim() });
      expect(gitVer.exitCode).toBe(0);

      // ── exec stdin → file, then copyFile (scp) box→host, content match ────
      workspace = tmpWorkspace("t11");
      const payload = `t11-roundtrip-${vm}-${Date.now()}\n`;
      const writeRes = await ctx.driver.exec(vm, ["sh", "-c", "cat > t11-note.txt"], payload);
      expect(writeRes.exitCode).toBe(0);
      const localPath = join(workspace, "t11-note.txt");
      await ctx.driver.copyFile(vm, "t11-note.txt", localPath);
      const roundTripped = readFileSync(localPath, "utf8");
      expect(roundTripped).toBe(payload);
      evidence.push({ phase: "copyFile-roundtrip", ok: true, bytes: payload.length });

      // ── destroy → absent from list() ──────────────────────────────────────
      await ctx.driver.destroy(vm);
      const afterDestroy = await ctx.driver.list(vm);
      evidence.push({ phase: "list-after-destroy", vm, count: afterDestroy.length });
      expect(afterDestroy.some((b) => b.name === vm)).toBeFalse();
      vm = ""; // destroyed — finally must not try again
    } catch (e) {
      outcome = "fail";
      evidence.push({ phase: "test-error", error: (e as Error).message });
      throw e;
    } finally {
      if (vm !== "") {
        await destroyQuietly(ctx.driver, vm, evidence);
      }
      try {
        evidencePath = writeEvidence("t1-1-driver-lifecycle", {
          test: "T1.1",
          outcome,
          vm: vm || undefined,
          phases: evidence,
        });
        // Surface the evidence path for the run report even on failure paths.
        process.stderr.write(`[T1.1] evidence: ${evidencePath}\n`);
      } finally {
        if (workspace !== "") rmSync(workspace, { recursive: true, force: true });
      }
    }
  },
  600_000,
);
