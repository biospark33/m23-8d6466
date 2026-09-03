/**
 * T3.3 — expose/port LIVE (t3-test-plan.md §T3.3, recon/stories-port.md §4-5).
 *
 * GATING: QDS_E2E_LIVE=1 AND QDS_E2E_TIER=2. Operator approves spend OUT of
 * band first: 2 keys × capMicroUsd + 2 short-lived boxes.
 *
 * ⚠️ SECURITY SHAPE (recon-confirmed, restated as the test's operating rules):
 * a successful --port dispatch ends with the WHOLE BOX world-reachable —
 * `share port` + `share set-public`, the derived https://<vm>.exe.xyz carries
 * NO auth, and THERE IS NO UN-SHARE: teardown's destroy is the only
 * retraction. Mandatory mitigations, enforced by this test's own shape:
 *   - unguessable runId-named box (the dispatcher's own grammar),
 *   - ONE unguessable static marker file served from /tmp — nothing else,
 *   - a minutes-short ack→teardown window (asserts run immediately),
 *   - destroy-in-finally even on assertion failure,
 *   - evidence keeps identifiers only; no secrets ever served.
 *
 * TWO dispatches, deliberately:
 *   1. NEGATIVE ($~0): NO posture attestation (`.sandbox/exedev-posture.json`
 *      absent) → dispatch refuses AT setPublic, AFTER expose resolved: box
 *      ALIVE and NOT public, port claim retained, derived httpsUrl present.
 *      That refusal IS the posture-gate proof.
 *   2. POSITIVE: attestation present → dispatch --port 8123 succeeds, ack
 *      httpsUrl is the DERIVED form (no port suffix), record carries
 *      ports===[8123] + httpsUrl verbatim; an on-box `python3 -m http.server`
 *      serves the marker; a HOST curl accepts ANY response carrying the
 *      marker (share routing is [VERIFY] — no 200 hard-pin); teardown → the
 *      same curl FAILS — that failure is the only retract assertion that
 *      exists.
 *
 * NO FAKES anywhere in this file.
 */
import { expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

import { RunRecordStore } from "../../../src/providers/run-record.ts";
import {
  REPO_ROOT,
  destroyQuietly,
  fleetCleanupProblems,
  fleetLeftovers,
  keyLeakProblems,
  listedKeyHashes,
  revokeQuietly,
  liveGate,
  liveTodoOff,
  preflight,
  runFleet,
  settleRun,
  teardownQuietly,
  tmpWorkspace,
  writeEvidenceQuietly,
} from "./live-harness.ts";

const T3_CAP_MICRO_USD = 50_000;
const T3_BOX_HOUR_RATE_MICRO_USD = 230_000;
const ISSUE_KEY = "Quantum-Digital-Solutions/QDS-Factory#46";
const PORT = 8123;
const POSTURE_PATH = join(REPO_ROOT, ".sandbox", "exedev-posture.json");

/** Host curl via spawnSync — returns {exitCode, stdout, stderr}. */
function curl(url: string, timeoutSec = 10): { exitCode: number; stdout: string; stderr: string } {
  const r = Bun.spawnSync({ cmd: ["curl", "-sS", "-m", String(timeoutSec), url], stdout: "pipe", stderr: "pipe" });
  return { exitCode: r.exitCode, stdout: r.stdout.toString(), stderr: r.stderr.toString() };
}

test.todoIf(liveTodoOff())(
  "T3.3 expose/port: posture-negative refusal, then public-marker reachability, then teardown-retract",
  async () => {
    liveGate("2");
    const evidence: Record<string, unknown>[] = [];
    const ctx = await preflight("2");
    let workspace = "";
    let negRunId = "";
    let negVm = "";
    let posRunId = "";
    let posVm = "";
    let postureExisted = false;
    let postureBackup = "";
    let outcome = "pass";
    /** The body's own error, HELD so the post-finally verdicts run on the failing path too (EB3). */
    let failure: unknown;
    /** Destroys that FAILED (#189) — asserted AFTER the `finally`, never only recorded. */
    const destroyFailures: string[] = [];
    /** The final leak listing, hoisted: its verdict is asserted OUTSIDE the finally's catch. */
    let finalBoxes: string[] | undefined;
    /**
     * The key population BEFORE this run (F17). The sweep below already ran
     * `revokeQuietly` per swept box, but nothing ever compared the POPULATION:
     * a teardown that destroys the box and exits 0 without revoking left a live
     * key and this test reported clean. The delta is now a cleanup verdict.
     */
    const hashesBefore = await listedKeyHashes();
    let keyProblems: string[] = [];
    try {
      workspace = tmpWorkspace("t33");
      const recordsDir = join(workspace, "runs");
      mkdirSync(recordsDir, { recursive: true });
      writeFileSync(
        join(workspace, "cost-config.json"),
        JSON.stringify({
          defaultCapMicroUsd: T3_CAP_MICRO_USD,
          boxHourRateMicroUsd: T3_BOX_HOUR_RATE_MICRO_USD,
          perIssueOverrides: { [ISSUE_KEY]: 2 * T3_CAP_MICRO_USD },
        }),
      );
      const briefPath = join(workspace, "brief.json");
      writeFileSync(
        briefPath,
        JSON.stringify({
          repoSlug: "Quantum-Digital-Solutions/QDS-Factory",
          issueId: 46,
          commitSha: ctx.sha,
          manifestPath: "config/rosters/t2.pipeline.json",
          repoUrl: ctx.repoUrl,
        }),
      );
      // The unguessable marker filename — the ONLY thing the box ever serves.
      const markerToken = randomBytes(12).toString("hex");
      const markerFile = `t3-${markerToken}.txt`;

      // ── 1. NEGATIVE: no posture attestation → setPublic refusal ──────────
      postureExisted = existsSync(POSTURE_PATH);
      if (postureExisted) {
        postureBackup = `${POSTURE_PATH}.t33-backup`;
        rmSync(POSTURE_PATH, { force: true });
      }
      const neg = await runFleet(
        ["dispatch", "--driver", "exedev", "--brief", briefPath, "--port", String(PORT)],
        { cwd: REPO_ROOT, env: { QDS_RUNS_DIR: recordsDir }, timeoutMs: 1_800_000 },
      );
      evidence.push({ phase: "neg-dispatch", exitCode: neg.exitCode, stderrTail: neg.stderr.trim().slice(-700) });
      expect(neg.exitCode).not.toBe(0);
      expect(neg.stderr).toContain("posture-attestation-missing");
      const negRec = new RunRecordStore({ dir: recordsDir }).list().find((r) => r.ports?.length);
      expect(negRec).toBeDefined();
      negRunId = negRec?.runId ?? "";
      negVm = negRec?.vmName ?? "";
      evidence.push({ phase: "neg-record", runId: negRunId, vmName: negVm, ports: negRec?.ports, httpsUrl: negRec?.httpsUrl });
      // The port claim was retained (speculative claim, post-resolve failure
      // KEEPS it) and the box is ALIVE but NOT public — the derived URL must
      // refuse host connections.
      expect(negRec?.ports).toEqual([PORT]);
      expect(negRec?.httpsUrl ?? "").toBe(`https://${negVm}.exe.xyz`);
      expect((await ctx.driver.list()).map((b) => b.name)).toContain(negVm);
      const negCurl = curl(`https://${negVm}.exe.xyz/${markerFile}`, 8);
      evidence.push({ phase: "neg-curl", exitCode: negCurl.exitCode, bodyHead: negCurl.stdout.trim().slice(0, 300), stderrTail: negCurl.stderr.trim().slice(-200) });
      // MEASURED run2 + exe.dev docs: a private VM's proxy answers anonymous
      // requests with an exe.dev LOGIN REDIRECT — HTTP 200, curl exit 0 — and
      // the redirect ECHOES the requested path, so the marker token appears
      // in `redirect=%2Ft3-<token>.txt` even though nothing was served. "Not
      // public" is proven by the served-body prefix's absence, never by curl's
      // exit code or a bare token match.
      expect(negCurl.stdout).not.toContain(`t3-expose ${markerToken}`);
      // Box was never public — tear it down NOW (it is ours and idle).
      const negTd = await runFleet(["teardown", negRunId, "--driver", "exedev", "--dir", recordsDir, "--no-harvest"], { timeoutMs: 180_000 });
      evidence.push({ phase: "neg-teardown", exitCode: negTd.exitCode });
      expect(negTd.exitCode).toBe(0);

      // ── 2. POSITIVE: attested → expose succeeds, box PUBLIC, then retract ─
      writeFileSync(
        POSTURE_PATH,
        `${JSON.stringify({ vmSharing: "admins-only", attestedAt: new Date().toISOString() })}\n`,
      );
      // The fresh-box pi-registry race (gate B "No models available") flaked
      // repeatedly today (T3.2 12:41 ×2, T3.1 att6, T3.3 run3's e3c8b9): the
      // gate is fail-closed and the failed arm's box stays ALIVE (INV-5).
      // This test IS the operator — on exit 3, teardown that run (revokes its
      // key) and redispatch ONCE. Any other failure breaks out and fails.
      let pos: Awaited<ReturnType<typeof runFleet>> | undefined;
      for (let attempt = 1; attempt <= 2; attempt++) {
        pos = await runFleet(
          ["dispatch", "--driver", "exedev", "--brief", briefPath, "--port", String(PORT)],
          { cwd: REPO_ROOT, env: { QDS_RUNS_DIR: recordsDir }, timeoutMs: 1_800_000 },
        );
        evidence.push({ phase: "pos-dispatch", attempt, exitCode: pos.exitCode, stdout: pos.stdout.trim().slice(0, 300), stderrTail: pos.stderr.trim().slice(-300) });
        if (pos.exitCode === 0) break;
        const failedRunId = pos.stderr.trim().split("\n")
          .filter((l) => l.startsWith("{"))
          .map((l) => { try { return (JSON.parse(l) as { runId?: unknown }).runId; } catch { return undefined; } })
          .filter((r): r is string => typeof r === "string")
          .at(-1);
        if (pos.exitCode !== 3 || failedRunId === undefined || attempt === 2) break;
        evidence.push({ phase: "pos-retry", attempt, failedRunId });
        const td = await runFleet(["teardown", failedRunId, "--driver", "exedev", "--dir", recordsDir, "--no-harvest"], { timeoutMs: 180_000 });
        evidence.push({ phase: "pos-retry-teardown", runId: failedRunId, exitCode: td.exitCode });
        const destroyed = await destroyQuietly(ctx.driver, failedRunId, evidence);
        if (!destroyed.ok) destroyFailures.push(`${failedRunId}: ${destroyed.error}`);
      }
      expect(pos?.exitCode).toBe(0);
      if (pos === undefined) throw new Error("unreachable: the dispatch loop always assigns pos");
      const ack = JSON.parse(pos.stdout.trim().split("\n").filter((l) => l.startsWith("{")).at(-1) as string) as {
        runId: string;
        vmName: string;
        httpsUrl?: string;
        state: string;
      };
      posRunId = ack.runId;
      posVm = ack.vmName;
      expect(ack.state).toBe("ready");
      expect(ack.httpsUrl).toBe(`https://${posVm}.exe.xyz`); // derived form, no port suffix
      const posRec = new RunRecordStore({ dir: recordsDir }).get(posRunId);
      evidence.push({ phase: "pos-record", runId: posRunId, ports: posRec.ports, httpsUrl: posRec.httpsUrl });
      expect(posRec.ports).toEqual([PORT]);
      expect(posRec.httpsUrl).toBe(`https://${posVm}.exe.xyz`);

      // ── 3. serve ONE unguessable marker from tmp on the box ──────────────
      const serve = await ctx.driver.exec(posVm, [
        "sh", "-c",
        `d=\$(mktemp -d) && printf 't3-expose %s\\n' ${JSON.stringify(markerToken).replaceAll('"', "'")} > "\$d/${markerFile}" && cd "\$d" && nohup python3 -m http.server ${PORT} >/dev/null 2>&1 & sleep 1 && printf 'serving\\n'`,
      ]);
      evidence.push({ phase: "serve", exitCode: serve.exitCode, stdout: serve.stdout.trim() });
      expect(serve.exitCode).toBe(0);

      // ── 4. HOST reachability: ANY response carrying the marker passes ────
      const url = `https://${posVm}.exe.xyz/${markerFile}`;
      let reached: { exitCode: number; stdout: string; stderr: string } | undefined;
      for (let attempt = 1; attempt <= 6; attempt++) {
        const c = curl(url, 10);
        // The SERVED body carries `t3-expose <token>` — a bare token match
        // would false-pass on the private login redirect (run2's echo).
        if (c.exitCode === 0 && c.stdout.includes(`t3-expose ${markerToken}`)) {
          reached = c;
          break;
        }
        await new Promise((r) => setTimeout(r, 5000));
      }
      evidence.push({ phase: "public-curl", url, reached: reached !== undefined, exitCode: reached?.exitCode, body: reached?.stdout.trim().slice(0, 200), stderrTail: reached?.stderr.trim().slice(-200) });
      expect(reached).toBeDefined(); // world-reachable, no auth — the exposure proof

      // ── 5. teardown → the URL must FAIL (destroy is the only retraction) ─
      const td = await runFleet(["teardown", posRunId, "--driver", "exedev", "--dir", recordsDir, "--no-harvest"], { timeoutMs: 180_000 });
      evidence.push({ phase: "pos-teardown", exitCode: td.exitCode });
      expect(td.exitCode).toBe(0);
      let retracted = false;
      let lastCurl: { exitCode: number; stdout: string; stderr: string } | undefined;
      for (let attempt = 1; attempt <= 6; attempt++) {
        const c = curl(url, 8);
        lastCurl = c;
        // MEASURED run4 + free probe after: a DESTROYED box's hostname still
        // answers on the exe.dev edge — 307 to exe.dev/auth — so curl exits 0.
        // "Retracted" is the SERVED marker's absence, same signal class as the
        // negative leg; the box's destruction is separately proven by final-ls.
        if (!c.stdout.includes(`t3-expose ${markerToken}`)) {
          retracted = true;
          break;
        }
        await new Promise((r) => setTimeout(r, 5000));
      }
      evidence.push({ phase: "post-teardown-curl", retracted, exitCode: lastCurl?.exitCode, bodyHead: lastCurl?.stdout.trim().slice(0, 200), stderrTail: lastCurl?.stderr.trim().slice(-200) });
      expect(retracted).toBe(true);
    } catch (e) {
      outcome = "fail";
      // HELD, not thrown (EB3): the post-finally verdicts below must render on
      // the red path too — the failing run is the one most likely to leak.
      failure = e;
      evidence.push({ phase: "test-error", error: (e as Error).message });
    } finally {
      // Restore the posture file to its prior state — the attestation is the
      // operator's, not this test's, and leaving it behind would silently
      // enable setPublic for every later dispatch in this repo.
      try {
        if (postureExisted && postureBackup !== "" && existsSync(postureBackup)) {
          rmSync(POSTURE_PATH, { force: true });
          writeFileSync(POSTURE_PATH, readFileSync(postureBackup, "utf8"));
          rmSync(postureBackup, { force: true });
        } else {
          rmSync(POSTURE_PATH, { force: true });
        }
      } catch (e) {
        evidence.push({ phase: "posture-restore-error", error: (e as Error).message });
      }
      for (const [id, vm] of [[negRunId, negVm], [posRunId, posVm]] as const) {
        if (id !== "" && workspace !== "") {
          // `teardownQuietly`, not a bare `runFleet` (F2): the 180 s ceiling
          // REJECTS, and the unguarded await let it escape this `finally` —
          // skipping the second leg's teardown, the belt-and-braces sweep, the
          // evidence write and `settleRun`, with a box still billing.
          const torn = await teardownQuietly(
            ["teardown", id, "--driver", "exedev", "--dir", join(workspace, "runs"), "--no-harvest"],
            { timeoutMs: 180_000 },
            evidence,
            { at: "teardown", runId: id },
          );
          if (!torn.ok) destroyFailures.push(`${id}: ${torn.error}`);
        }
        if (vm !== "") {
          const destroyed = await destroyQuietly(ctx.driver, vm, evidence);
          if (!destroyed.ok) destroyFailures.push(`${vm}: ${destroyed.error}`);
        }
      }
      // Belt-and-braces: a dispatch that failed before its ack named it left a
      // box this run never learned the name of (run3's leak). The RECORD is the
      // ownership proof — both legs above show dispatch writes the run record
      // BEFORE the box exists (the negative leg reads its own refused run's
      // record out of this store), so a `qds-`/`e2e-` box WITH a record in THIS
      // workspace is ours and one without is not.
      //
      // GUARDED on `workspace !== ""` (was not): `join("", "runs")` is the
      // RELATIVE path "runs", so a run that died before `tmpWorkspace` returned
      // pointed this store at `$PWD/runs` — and that store is handed to
      // `revokeQuietly`, which would then revoke real keys belonging to
      // UNRELATED runs' records.
      const ownedNames = new Set([negVm, posVm, negRunId, posRunId].filter((n) => n !== ""));
      if (workspace !== "") {
        try {
          const store = new RunRecordStore({ dir: join(workspace, "runs") });
          const leftovers = (await ctx.driver.list()).map((b) => b.name).filter((n) => n.startsWith("qds-") || n.startsWith("e2e-"));
          for (const vm of leftovers) {
            // Probe the record FIRST — it decides BOTH whether the box is ours
            // and whether a revoke is owed. Passing `vm` as the runId is safe:
            // the fleet creates boxes as driver.create(runId), so a box's name
            // IS the run id its record is keyed by.
            //
            // ONLY a clean ENOENT proves absence. `readRecord` preserves the
            // TYPED errno on the error it throws (run-record.ts) precisely so
            // consumers classify off the code, never off message text — and a
            // bare `catch { hasRecord = false }` classified EVERY read failure
            // as "nothing to revoke": a permission-denied or malformed record
            // (one a half-written mint leaves behind) then skipped
            // `revokeQuietly` silently, on exactly the run most likely to have
            // a live, spendable key. Anything that is not ENOENT keeps the
            // revoke and lands its own `finally-revoke ok:false` alarm.
            //
            // `store.get` is SYNCHRONOUS (RunRecordStore.get → readRecord,
            // run-record.ts:1585 — returns `RunRecord`, not a Promise), which
            // is what makes this bare call's `catch` reachable at all. If it
            // ever becomes async this block must gain an `await`, or the errno
            // classification silently stops running and every swept box takes
            // the revoke path.
            let hasRecord = true;
            try {
              store.get(vm);
            } catch (e) {
              if ((e as NodeJS.ErrnoException).code === "ENOENT") hasRecord = false;
              else evidence.push({ phase: "sweep-record-unreadable", vm, error: (e as Error).message });
            }
            if (!hasRecord) {
              // NOT ours — warned by `fleetLeftovers` below as a stray, never
              // destroyed. Killing a concurrent round's live box is worse than
              // reporting it, and the "no concurrent round" premise this sweep
              // used to rest on is a skill-doc mandate, not a lock.
              evidence.push({ phase: "sweep-no-record", vm, note: "no run record in this workspace — not this run's box, left alone" });
              continue;
            }
            ownedNames.add(vm);
            await revokeQuietly(ctx.driver, store, vm, evidence);
            evidence.push({ phase: "finally-sweep", vm });
          }
        } catch (e) {
          evidence.push({ phase: "finally-sweep-error", error: (e as Error).message });
        }
      }
      // `fleetLeftovers` carries the same 5 × 8 s lag poll this site hand-rolled
      // (r7-T-h1's measured 25 s+ destroy lag) and destroys owned survivors
      // before rendering the verdict — so the sweep above no longer needs its
      // own destroy loop. It never throws; a try/catch here would swallow the
      // `owned: undefined` that `fleetCleanupProblems` renders as "an unmeasured
      // fleet is never a clean one".
      finalBoxes = (await fleetLeftovers(ctx.driver, [...ownedNames], evidence)).owned;
      // The KEY leak verdict (F17), converged on the harness helper so the
      // sweep's per-box `revokeQuietly` above is no longer the only key
      // discipline this file has — that one can only revoke what it can SEE.
      keyProblems = await keyLeakProblems(
        hashesBefore,
        {
          driver: ctx.driver,
          store: workspace === "" ? undefined : new RunRecordStore({ dir: join(workspace, "runs") }),
          runIds: [negRunId, posRunId],
        },
        evidence,
      );
      // `writeEvidenceQuietly` (F11): an evidence-write throw used to propagate
      // out of this `finally` and make `settleRun` below unreachable.
      writeEvidenceQuietly("T3.3", "t3-3-expose-port", { test: "T3.3", outcome, negRunId, posRunId, port: PORT, phases: evidence }, destroyFailures);
      // GUARDED: `force: true` swallows ENOENT but not EBUSY/EPERM, and this is
      // the LAST statement of the `finally` — a throw here discards the held
      // `failure` and skips `settleRun` entirely.
      try {
        if (workspace !== "") rmSync(workspace, { recursive: true, force: true });
      } catch {
        // workspace cleanup is best-effort; evidence is already written
      }
    }

    // ── the post-`finally` verdict (EB3), in ONE place: `settleRun` fails a
    // green run on a cleanup problem, and on a RED one ATTACHES the problem to
    // the body's own error instead of throwing over the top of it — the bare
    // `expect(destroyFailures)` this replaces discarded the held failure
    // whenever a leak and a real regression happened on the same run. ────────
    // `evidence` as the third arg folds `finally-revoke ok:false` entries into
    // the verdict — this file's sweep revokes boxes that are NOT in the
    // `runIds` handed to `keyLeakProblems`, so a failure there used to be
    // evidence prose nothing asserted.
    settleRun(failure, [...fleetCleanupProblems(destroyFailures, finalBoxes, evidence), ...keyProblems]);
  },
  1_800_000,
);
