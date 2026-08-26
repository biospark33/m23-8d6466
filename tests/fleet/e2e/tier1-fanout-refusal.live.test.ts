/**
 * T1.5 — the fleet-wide fanout lock on real substrate (e2e-plan.md path 11,
 * INV-2 slice).
 *
 * The FULL fanout verb cannot run in TIER-1: every fanout arm is a dispatch,
 * and exedev dispatch ALWAYS runs the setup gate, whose C/D assertions are
 * real chat/completions calls (real model spend). That proof is TIER-2 (T2.2).
 *
 * What IS zero-spend and real here: with the real FleetLock held at the exact
 * path the verb resolves (cwd-relative `.sandbox/fleet.lock`), a fully-valid
 * `fleet fanout` invocation (schema-valid brief, matching pin, valid roster
 * ids, real `--driver exedev`) must refuse exit 5 BEFORE provisioning
 * anything — no boxes appear in the provider list, no fanout record is
 * written, no run records exist. That is INV-2's "a refused fan-out mutates
 * nothing", proven against the live provider listing.
 */
import { expect, test } from "bun:test";
import { mkdirSync, readdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";

import { FleetLock } from "../../../src/fleet/fleet-lock.ts";
import { liveGate, liveTodoOff, preflight, runFleet, runIdFor, tmpWorkspace, writeEvidence } from "./live-harness.ts";

test.todoIf(liveTodoOff())(
  "T1.5 held fleet lock ⇒ fanout refuses exit 5 and mutates nothing (no boxes, no records)",
  async () => {
    liveGate("1");
    const evidence: Record<string, unknown>[] = [];
    const ctx = await preflight();
    const probe = runIdFor("t15probe"); // never created; list baseline anchor
    let workspace = "";
    let lock: FleetLock | undefined;
    let evidencePath = "";
    let outcome = "pass";
    try {
      workspace = tmpWorkspace("t15");
      const fanoutsDir = join(workspace, "fanouts");
      mkdirSync(fanoutsDir, { recursive: true });

      // A schema-valid brief (repoSlug matches repoUrl's path, pin = commitSha).
      const briefPath = join(workspace, "brief.json");
      writeFileSync(briefPath, JSON.stringify({
        repoSlug: "octocat/Hello-World",
        issueId: 1,
        commitSha: ctx.sha,
        manifestPath: "cfg/pi.json",
        repoUrl: ctx.repoUrl,
      }));

      // Hold the real fleet lock at the path the SUBPROCESS will resolve
      // (FLEET_LOCK_PATH is cwd-relative; the verb runs with cwd=workspace).
      mkdirSync(join(workspace, ".sandbox"), { recursive: true });
      lock = new FleetLock({ path: join(workspace, ".sandbox/fleet.lock"), requestId: `e2e-t15-${probe}` });
      lock.acquire();
      // Prove the lock is on disk (acquire could succeed in-memory while the file write failed silently).
      expect(existsSync(lock.path), `fleet lock file exists at ${lock.path}`).toBe(true);
      evidence.push({ phase: "fleet-lock-held", ok: true, path: lock.path });

      const before = (await ctx.driver.list()).map((b) => b.name);

      const fan = await runFleet(
        [
          "fanout", "--pattern", "best-of-n", "--n", "2",
          "--roster", "lead,fixer", "--pin", ctx.sha,
          "--brief", briefPath, "--driver", "exedev", "--dir", fanoutsDir,
        ],
        { cwd: workspace, timeoutMs: 120_000 },
      );
      evidence.push({
        phase: "fanout-verb",
        exitCode: fan.exitCode,
        stdout: fan.stdout.trim().slice(0, 300),
        stderrTail: fan.stderr.trim().slice(-600),
      });
      expect(fan.exitCode).toBe(5);

      // INV-2: refused ⇒ mutated nothing, checked against the live provider.
      const after = (await ctx.driver.list()).map((b) => b.name);
      expect(after.length).toBe(before.length);
      expect(after.filter((n) => !before.includes(n))).toEqual([]);
      expect(readdirSync(fanoutsDir).filter((f) => f.startsWith("fan-"))).toEqual([]);
      const runsDir = join(workspace, ".sandbox", "runs");
      const runRecords = runsDirExists(runsDir) ? readdirSync(runsDir) : [];
      expect(runRecords).toEqual([]);
      evidence.push({ phase: "nothing-mutated", ok: true });
    } catch (e) {
      outcome = "fail";
      evidence.push({ phase: "test-error", error: (e as Error).message });
      throw e;
    } finally {
      try {
        lock?.release({ force: true });
      } catch {
        // the workspace is deleted below regardless
      }
      try {
        evidencePath = writeEvidence("t1-5-fanout-refusal", { test: "T1.5", outcome, phases: evidence });
        process.stderr.write(`[T1.5] evidence: ${evidencePath}\n`);
      } finally {
        if (workspace !== "") rmSync(workspace, { recursive: true, force: true });
      }
    }
  },
  600_000,
);

function runsDirExists(p: string): boolean {
  try {
    readdirSync(p);
    return true;
  } catch {
    return false;
  }
}
