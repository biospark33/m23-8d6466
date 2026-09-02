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
  fleetCleanupProblems,
  liveGate,
  liveTodoOff,
  preflight,
  runIdFor,
  settleRun,
  tmpWorkspace,
  writeEvidenceQuietly,
} from "./live-harness.ts";

test.todoIf(liveTodoOff())(
  "T1.1 driver lifecycle: whoami → create → list → exec → copyFile → destroy on real exe.dev",
  async () => {
    liveGate("1");
    const evidence: Record<string, unknown>[] = [];
    const ctx = await preflight();
    let vm = "";
    let workspace = "";
    let outcome = "pass";
    /** The body's own error, HELD so the post-`finally` verdict renders on the red path too. */
    let failure: unknown;
    /** Destroys that FAILED — rendered AFTER the `finally`, never only recorded (#189). */
    const destroyFailures: string[] = [];
    /** The cleanup-time leak listing; `undefined` means it FAILED, which is a problem, not a pass. */
    let finalBoxes: string[] | undefined;
    try {
      expect(ctx.whoami.length).toBeGreaterThan(0);
      // The whoami answer is operator IDENTITY (email, ssh public key,
      // region) — proof goes into evidence as the FACT it answered, never the
      // blob itself; evidence files are quoted in reports and PR comments.
      // Security review 2026-08-24: SENSITIVE-TO-OBSERVABILITY.
      evidence.push({ phase: "whoami", ok: true, answered: true, length: ctx.whoami.length });

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
      // HELD, not re-thrown: a `throw` here makes the post-`finally` verdict
      // unreachable on exactly the runs that leak — the red ones.
      failure = e;
      evidence.push({ phase: "test-error", error: (e as Error).message });
    } finally {
      if (vm !== "") {
        // The verdict was DISCARDED here: `destroyQuietly` returns `{ok:false}`
        // and pushes an evidence entry, and nothing read either — so a box
        // still billing shipped this test green, the exact #189 shape every
        // sibling file has already had removed.
        const destroyed = await destroyQuietly(ctx.driver, vm, evidence);
        if (!destroyed.ok) destroyFailures.push(`${vm}: ${destroyed.error}`);
      }
      // The absolute backstop: a box this run created but never named (a
      // `create` that stood the box up and then threw leaves `vm === ""`) is
      // invisible to the destroy above, and this file's only other listings
      // are BODY assertions that a red run never reaches.
      try {
        const final = (await ctx.driver.list()).map((b) => b.name).filter((n) => n.startsWith("e2e-") || n.startsWith("qds-"));
        evidence.push({ phase: "final-ls", fleetBoxes: final });
        finalBoxes = final;
      } catch (e) {
        evidence.push({ phase: "final-ls", ok: false, error: (e as Error).message });
      }
      // `writeEvidenceQuietly` (F11): `writeEvidence` throws on ENOSPC and on
      // the secret-scrub REFUSAL, and that throw used to escape this `finally`
      // and REPLACE the body's real failure with an I/O error.
      writeEvidenceQuietly("T1.1", "t1-1-driver-lifecycle", {
        test: "T1.1",
        outcome,
        vm: vm || undefined,
        phases: evidence,
      }, destroyFailures);
      if (workspace !== "") rmSync(workspace, { recursive: true, force: true });
    }

    // No key half here: this test mints NOTHING (no `mintCappedKey`, no
    // dispatch, no `fleet` verb at all — only `driver` calls and shell no-ops),
    // so there is no key population for `keyLeakProblems` to diff.
    settleRun(failure, fleetCleanupProblems(destroyFailures, finalBoxes));
  },
  600_000,
);
