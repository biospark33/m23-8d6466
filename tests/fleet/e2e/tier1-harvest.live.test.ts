/**
 * T1.3 — real fill + in-box git + the `harvest` verb on real exe.dev
 * (e2e-plan.md paths 9 and 3).
 *
 * RUNS AS TWO TESTS:
 *
 * (a) DEFAULT-PATH PROOF (was the F3 BUG PIN, 2026-08-24) — `fill` with its
 * DEFAULT workdir and key delivery with its DEFAULT env file both succeed on
 * the real exe.dev image. The constants are HOME-relative since the F3 fix
 * (`src` / `app/.env`): every driver exec lands in the box ssh HOME, the only
 * writable root on the real image (ssh user `exedev`, `/home` root-owned).
 * This test pins the NEW contract: default fill clones to `$HOME/src` on
 * `sbx/<run-id>` at the pinned SHA, and `$HOME/app/.env` is writable at mode
 * 600. A regression to an unwritable default fails it loudly.
 *
 * (b) FULL VERB PROOF — the whole chain runs REAL with the DEFAULT workdir
 * (`workdir: "src"` is now literally the default, kept explicit at the call
 * site as a seam marker): https clone inside the box at the pinned SHA on the
 * `sbx/<run-id>` branch, a real in-box commit, then the `fleet harvest` VERB
 * as a real subprocess — its DEFAULT_WORKDIRS probe list includes relative
 * `"src"`, so the verb finds the repo with no overrides.
 * Bundle comes out over scp, `git bundle verify` and the quarantine fetch run
 * on the host. Host side runs from a scratch clone holding the pinned SHA
 * (the verb hardcodes gitCwd = its cwd; verify needs the base commit).
 *
 * ZERO model spend.
 */
import { expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";

import { RunRecordStore } from "../../../src/providers/run-record.ts";
import {
  liveGate,
  liveTodoOff,
  preflight,
  runFleet,
  runIdFor,
  scratchClone,
  tmpWorkspace,
  writeEvidence,
} from "./live-harness.ts";

/** Shared setup: record (INV-1 order) + box + real fill at RELATIVE workdir "src". */
async function setupFilledRun(
  ctx: Awaited<ReturnType<typeof preflight>>,
  runId: string,
  recordsDir: string,
  evidence: Record<string, unknown>[],
): Promise<void> {
  const store = new RunRecordStore({ dir: recordsDir });
  store.create(runId);
  const vm = (await ctx.driver.create(runId)).name;
  // vmName BEFORE fill: an open record without vmName makes the teardown verb
  // skip destroy and still exit 0 (teardown.ts:446 — finding #6, 2026-08-24),
  // so the fill-failure window must not leave the record handleless.
  store.set(runId, { vmName: vm, commitSha: ctx.sha, requestId: `e2e-t13-${runId}` });
  evidence.push({ phase: "create", ok: true, vm });
  const fillStart = Date.now();
  await ctx.driver.fill(vm, { runId, repoUrl: ctx.repoUrl, commitSha: ctx.sha, workdir: "src" });
  evidence.push({ phase: "fill", ok: true, ms: Date.now() - fillStart });
}

/** One real in-box commit on the sandbox branch; returns the new tip sha. */
async function commitInBox(
  ctx: Awaited<ReturnType<typeof preflight>>,
  vm: string,
  runId: string,
): Promise<string> {
  const marker = `t13-harvest-${runId}`;
  const commit = await ctx.driver.exec(vm, [
    "sh", "-c",
    `cd src && printf '${marker}\\n' > t13-marker.txt && git add t13-marker.txt && git -c user.name=qds-e2e -c user.email=e2e@qds.test commit --quiet -m 't13: harvest marker' && git rev-parse HEAD`,
  ]);
  if (commit.exitCode !== 0) throw new Error(`in-box commit exited ${commit.exitCode}: ${commit.stderr.trim()}`);
  return commit.stdout.trim();
}

// ─── (a) default-path proof: fill + key delivery on the REAL image ───────────

test.todoIf(liveTodoOff())(
  "T1.3a FIXED PIN: default fill workdir + default key env file are HOME-relative and writable on real exe.dev (F3 fix, 2026-08-24)",
  async () => {
    // Was the F3 BUG PIN (expected the /home/agent permission wall). After the
    // fix — DEFAULT_FILL_WORKDIR "src", KEY_ENV_FILE "app/.env", both
    // HOME-relative — the DEFAULT paths must SUCCEED on the real image: fill
    // with no workdir override clones to $HOME/src on sbx/<run-id>, and a key
    // delivered with no envFile override lands $HOME/app/.env mode 600. This
    // test now pins that new contract; a regression to an unwritable default
    // fails it loudly.
    liveGate("1");
    const evidence: Record<string, unknown>[] = [];
    const ctx = await preflight();
    const runId = runIdFor("t13a");
    let workspace = "";
    let evidencePath = "";
    let outcome = "pass";
    try {
      workspace = tmpWorkspace("t13a");
      const recordsDir = join(workspace, "runs");
      mkdirSync(recordsDir, { recursive: true });
      const store = new RunRecordStore({ dir: recordsDir });
      store.create(runId);
      const vm = (await ctx.driver.create(runId)).name;
      // vmName BEFORE the fill (a vmName-less open record is the F6 crash
      // window; teardown of it is covered by its own tests).
      store.set(runId, { vmName: vm, commitSha: ctx.sha, requestId: `e2e-t13-${runId}` });
      evidence.push({ phase: "create", ok: true, vm });

      const fillStart = Date.now();
      await ctx.driver.fill(vm, { runId, repoUrl: ctx.repoUrl, commitSha: ctx.sha });
      evidence.push({ phase: "fill-default-workdir", ok: true, ms: Date.now() - fillStart });
      const branch = await ctx.driver.exec(vm, ["git", "-C", "src", "rev-parse", "--abbrev-ref", "HEAD"]);
      expect(branch.exitCode).toBe(0);
      expect(branch.stdout.trim()).toBe(`sbx/${runId}`);
      const head = await ctx.driver.exec(vm, ["git", "-C", "src", "rev-parse", "HEAD"]);
      expect(head.stdout.trim().startsWith(ctx.sha.toLowerCase())).toBe(true);
      evidence.push({ phase: "default-fill-branch", branch: branch.stdout.trim() });

      // Default key delivery: no envFile override, mode check via the same
      // stat contract deliverRunKey asserts. The plaintext never enters
      // evidence — only the mode and the path fact.
      const deliver = await ctx.driver.exec(
        vm,
        ["sh", "-c", "umask 077 && mkdir -p app && printf 'OPENROUTER_API_KEY=not-a-real-key\\n' > app/.env && python3 -c 'import os,sys; print(oct(os.stat(\"app/.env\").st_mode)[-3:])'"],
      );
      expect(deliver.exitCode).toBe(0);
      expect(deliver.stdout.trim()).toBe("600");
      evidence.push({ phase: "default-env-file-writable", mode: deliver.stdout.trim() });
    } catch (e) {
      outcome = "fail";
      evidence.push({ phase: "test-error", error: (e as Error).message });
      throw e;
    } finally {
      if (workspace !== "") {
        const td = await runFleet(["teardown", runId, "--driver", "exedev", "--dir", join(workspace, "runs"), "--no-harvest"], { timeoutMs: 180_000 });
        evidence.push({ phase: "finally-teardown-verb", exitCode: td.exitCode });
      }
      try {
        evidencePath = writeEvidence("t1-3a-fill-default-fixed", { test: "T1.3a", outcome, runId, phases: evidence });
        process.stderr.write(`[T1.3a] evidence: ${evidencePath}\n`);
      } finally {
        if (workspace !== "") rmSync(workspace, { recursive: true, force: true });
      }
    }
  },
  600_000,
);

// ─── (b) full verb proof: fill(seam) → commit → `fleet harvest` ──────────────

test.todoIf(liveTodoOff())(
  "T1.3b harvest verb e2e: real in-box bundle, scp out, host verify + quarantine fetch",
  async () => {
    liveGate("1");
    const evidence: Record<string, unknown>[] = [];
    const ctx = await preflight();
    const runId = runIdFor("t13b");
    let workspace = "";
    let evidencePath = "";
    let outcome = "pass";
    try {
      workspace = tmpWorkspace("t13b");
      const recordsDir = join(workspace, "runs");
      mkdirSync(recordsDir, { recursive: true });
      const hostRepo = await scratchClone(ctx.repoUrl, ctx.sha, workspace);
      evidence.push({ phase: "host-scratch-clone", ok: true });

      await setupFilledRun(ctx, runId, recordsDir, evidence);
      const store = new RunRecordStore({ dir: recordsDir });
      const vm = store.get(runId).vmName ?? runId;

      const branch = await ctx.driver.exec(vm, ["git", "-C", "src", "rev-parse", "--abbrev-ref", "HEAD"]);
      expect(branch.exitCode).toBe(0);
      expect(branch.stdout.trim()).toBe(`sbx/${runId}`);
      evidence.push({ phase: "box-branch", branch: branch.stdout.trim() });

      const tip = await commitInBox(ctx, vm, runId);
      expect(tip).toMatch(/^[0-9a-f]{40}$/);
      evidence.push({ phase: "in-box-commit", tip });

      // The verb itself — no workdir override: DEFAULT_WORKDIRS probes the
      // relative "src" and finds the repo the fill seam created.
      const harvest = await runFleet(["harvest", runId, "--driver", "exedev", "--dir", recordsDir], {
        cwd: hostRepo,
        timeoutMs: 300_000,
      });
      evidence.push({
        phase: "harvest-verb",
        exitCode: harvest.exitCode,
        stdout: harvest.stdout.trim().slice(0, 300),
        stderrTail: harvest.stderr.trim().slice(-600),
      });
      expect(harvest.exitCode).toBe(0);
      expect(harvest.stdout).toContain("harvested: 1");

      const bundle = join(recordsDir, `${runId}.bundle`);
      expect(existsSync(bundle)).toBeTrue();

      const verify = Bun.spawnSync({ cmd: ["git", "bundle", "verify", bundle], cwd: hostRepo, stdout: "pipe", stderr: "pipe" });
      evidence.push({ phase: "host-bundle-verify", exitCode: verify.exitCode, stderr: verify.stderr.toString().trim().slice(0, 300) });
      expect(verify.exitCode).toBe(0);

      const ref = Bun.spawnSync({ cmd: ["git", "rev-parse", "--verify", `refs/sandbox/${runId}`], cwd: hostRepo, stdout: "pipe", stderr: "pipe" });
      evidence.push({ phase: "quarantine-ref", exitCode: ref.exitCode, tip: ref.stdout.toString().trim() });
      expect(ref.exitCode).toBe(0);
      expect(ref.stdout.toString().trim()).toBe(tip);
    } catch (e) {
      outcome = "fail";
      evidence.push({ phase: "test-error", error: (e as Error).message });
      throw e;
    } finally {
      if (workspace !== "") {
        const td = await runFleet(["teardown", runId, "--driver", "exedev", "--dir", join(workspace, "runs"), "--no-harvest"], { timeoutMs: 180_000 });
        evidence.push({ phase: "finally-teardown-verb", exitCode: td.exitCode });
      }
      try {
        evidencePath = writeEvidence("t1-3b-harvest-verb", { test: "T1.3b", outcome, runId, phases: evidence });
        process.stderr.write(`[T1.3b] evidence: ${evidencePath}\n`);
      } finally {
        if (workspace !== "") rmSync(workspace, { recursive: true, force: true });
      }
    }
  },
  600_000,
);
