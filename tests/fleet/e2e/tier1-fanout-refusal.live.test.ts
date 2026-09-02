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
import {
  liveGate,
  liveTodoOff,
  preflight,
  runFleet,
  runIdFor,
  settleRun,
  tmpWorkspace,
  writeEvidenceQuietly,
} from "./live-harness.ts";

test.todoIf(liveTodoOff())(
  "T1.5 held fleet lock ⇒ fanout refuses exit 5 and mutates nothing (no boxes, no records)",
  async () => {
    liveGate("1");
    const evidence: Record<string, unknown>[] = [];
    const ctx = await preflight();
    const probe = runIdFor("t15probe"); // never created; list baseline anchor
    let workspace = "";
    let lock: FleetLock | undefined;
    let outcome = "pass";
    /** The body's own error, HELD so the cleanup verdict below renders on the red path too. */
    let failure: unknown;
    /** Cleanup problems (the evidence write is the only one this test can have). */
    const cleanupProblems: string[] = [];
    try {
      workspace = tmpWorkspace("t15");
      const fanoutsDir = join(workspace, "fanouts");
      mkdirSync(fanoutsDir, { recursive: true });

      // A schema-valid brief: repoSlug is DERIVED from ctx.repoUrl's path so the
      // DF3.1 cross-refine (repoSlugOfUrl(repoUrl) === canonicalRepoSlug, fb0334a)
      // holds for whatever substrate repo the operator pinned — the refusal under
      // test must come from the LOCK, never from brief ingress.
      const slugFromUrl = ctx.repoUrl.replace(/^https:\/\//i, "").replace(/^[^/]+\//, "").replace(/\.git$/, "");
      const briefPath = join(workspace, "brief.json");
      writeFileSync(briefPath, JSON.stringify({
        repoSlug: slugFromUrl,
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
      // HELD, not re-thrown, so the evidence-write verdict below is reachable
      // on the red path instead of the throw racing past it.
      failure = e;
      evidence.push({ phase: "test-error", error: (e as Error).message });
    } finally {
      try {
        lock?.release({ force: true });
      } catch (e) {
        // The workspace is deleted below regardless, so the lock FILE is gone
        // either way — but a release that threw is still a fact about the real
        // FleetLock under test, and a swallowed one read as a clean run.
        cleanupProblems.push(`the fleet lock release FAILED: ${(e as Error).message}`);
      }
      // `writeEvidenceQuietly` (F11): `writeEvidence` throws on ENOSPC and on
      // the secret-scrub REFUSAL, and a throw here — inside the `finally` —
      // used to REPLACE the body's own refusal assertion with an I/O error.
      writeEvidenceQuietly("T1.5", "t1-5-fanout-refusal", { test: "T1.5", outcome, phases: evidence }, cleanupProblems);
      if (workspace !== "") rmSync(workspace, { recursive: true, force: true });
    }

    // No box half and no key half, and both by PROOF rather than by assumption:
    // the verb refuses exit 5 at the fleet lock BEFORE it provisions or mints
    // anything, and the body asserts that directly against the live provider
    // (`after.length === before.length`, no `fan-` record, no run records). The
    // probe run id is never created. So there is nothing for `destroyQuietly`
    // or `keyLeakProblems` to diff — the only cleanup this test owns is its own
    // lock release and its evidence file.
    settleRun(failure, cleanupProblems);
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
