/**
 * T3.5 — the manifest's phases walked BY THE IN-BOX ENGINE (DF1.10 AC7;
 * t3-test-plan.md §T3.5, recon/phase-engine.md §4A).
 *
 * GATING: QDS_E2E_LIVE=1 AND QDS_E2E_TIER=2. Operator approves spend OUT of
 * band first: 1 key × capMicroUsd + 1 box.
 *
 * WHAT IS REAL HERE: `fleet dispatch` provisions a real box — fill delivers the
 * STAMPED manifest + witness into the checkout's `.qds/`, and the setup gates
 * run on the run key. Then `fleet run <runId>` starts `qds-run@<runId>.service`
 * and RETURNS: the host holds no run, walks no phase, and executes nothing. The
 * rest belongs to the box. systemd execs `qds-engine run <runId>`, which derives
 * run root, manifest, witness, journal and engine log from the runId plus the
 * in-box layout, and walks every `code` phase through the production
 * Run/walkPhases/FileJournal with the checkout as cwd. The host's only remaining
 * job is to OBSERVE, and it does so through production's own eyes: the marker at
 * `runMarkerPath()`, read and classified by the very `readMarkerVerdict` that
 * `fleet status` (AC5) and the fan-out race poller use, then the journal and the
 * engine log read back off the box. The third phase commits a tracked marker
 * file, and the REAL harvest bundle must carry it.
 *
 * HONEST LABEL, updated: the label used to read "phases execute ON THE BOX
 * orchestrated FROM THE HOST", because a host-side shim fetched the delivered
 * pair, ran `loadManifest`/`walkPhases` in the HOST process and `driver.exec`ed
 * only the `code` phase BODIES. That shim is retired with this story and the
 * qualifier goes with it — the engine itself now runs in the box, so there is no
 * host-side orchestrator left to name. The honest label is simply: the run
 * happens on the box, and the host starts it and watches.
 *
 * TWO artifacts moved with the engine, and the assertions below moved with them:
 *  - the journal is `$HOME/<runId>.journal.jsonl` IN THE BOX (ext4, so it
 *    survives a reboot), not a file under a host records dir.
 *  - PF-2's bounded stdout tail no longer has a host-side sink. `PhaseRecord` is
 *    metadata-only and carries no phase value, and the shim's `steps.json` was
 *    the shim's own bonus sink — it was deleted with it. What the in-box engine
 *    keeps is stronger and is AC4's own channel: a code phase's stdout is
 *    relayed to fd 2 (fd 1 stays engine-owned) and fd 2 is teed into
 *    `$HOME/<runId>.engine.log`, so the echoed marker is read back off THAT.
 *
 * NO FAKES anywhere in this file.
 */
import { expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  type MarkerReadDriver,
  type MarkerVerdict,
  markerUnusableGivesUp,
  readMarkerVerdict,
} from "../../../src/fleet/fanout-primitive.ts";
import { RUN_START_TIMEOUT_MS } from "../../../src/fleet/run.ts";
import { runMarkerPath } from "../../../src/phase-engine/journal.ts";
import { DEFAULT_FILL_WORKDIR, QDS_IN_BOX_DIR } from "../../../src/providers/exedev/fill.ts";
import { BOX_RUN_ROOT } from "../../../src/providers/harvest.ts";
import { RunRecordStore } from "../../../src/providers/run-record.ts";
import {
  REPO_ROOT,
  boxHome,
  destroyQuietly,
  emittedRunId,
  fetchBoxFile,
  fleetCleanupProblems,
  fleetLeftovers,
  keyLeakProblems,
  liveGate,
  liveTodoOff,
  listedKeyHashes,
  preflight,
  runFleet,
  scratchClone,
  settleRun,
  teardownQuietly,
  tmpWorkspace,
  writeEvidenceQuietly,
} from "./live-harness.ts";

const T3_CAP_MICRO_USD = 50_000;
const T3_BOX_HOUR_RATE_MICRO_USD = 230_000;
const ISSUE_KEY = "Quantum-Digital-Solutions/QDS-Factory#46";

/**
 * The `fleet run` verb's own ceiling, DERIVED FROM THE SYMBOL rather than from a
 * number copied out of it. `startRun` bounds the one `systemctl start` it issues
 * at `RUN_START_TIMEOUT_MS` — the ceiling on a wedged exec, not on any engine
 * work, since the unit is `Type=simple` and the job completes as soon as the
 * process is forked. This outer ceiling must sit strictly ABOVE it: at or under
 * the verb's own, the runner abandons a start systemd is still legitimately
 * running and reports a timeout for a healthy box, on a paid path.
 *
 * The headroom is spent on bun's startup and the record read. Expressed as
 * arithmetic on the import, not as a literal, because that is exactly how the
 * coupling rots — this comment carried "(90 000 ms)" while `run.ts` had already
 * moved to 120 000, and a stale number in a live-gated file is invisible until
 * it is expensive.
 */
const RUN_VERB_TIMEOUT_MS = RUN_START_TIMEOUT_MS + 60_000;

/**
 * How long the marker may take to appear. DERIVED from the manifest, not from
 * taste: `config/rosters/t3.pipeline.json` declares `runBudgetMs: 150 000`, and
 * the engine refuses a manifest whose budget exceeds the witness's, so a run
 * that respects its own budget cannot walk longer than that. Double it, and the
 * slack covers what the budget does not: systemd's job dispatch, bun's startup
 * in the box, and the third phase's own 30 s `git commit` ceiling.
 *
 * The fail-safe direction is UP — this is a ceiling on a degraded run, not a
 * wait — but it is bounded rather than open-ended for a money reason: a run that
 * never settles is a box that keeps billing, and the poll is the only thing that
 * ends it.
 */
const MARKER_POLL_CEILING_MS = 300_000;
/** Poll spacing. The phases are trivial; the marker lands in seconds on a
 *  healthy round, and a tighter interval would only buy ssh round trips. */
const MARKER_POLL_INTERVAL_MS = 5_000;
/**
 * Per-read deadline, handed to `readBoxFile` as ONE budget for its probe/`cat`
 * pair. Well under the interval, so a box that has stopped answering costs the
 * poll its tick and not its ceiling.
 */
const MARKER_READ_DEADLINE_MS = 30_000;

/**
 * Poll the in-box completion marker until the engine settles this run.
 *
 * The READ is production's, imported rather than restated: `readMarkerVerdict`
 * is the same classified read `fleet status` (AC5) and the fan-out race poller
 * act on, so this test cannot agree with the engine by inspection while
 * disagreeing with the two things that actually observe it. Only the LOOP shape
 * is local — a status verb answers now and the race poller ticks for an hour;
 * this one waits out a single known-short run.
 *
 * The three non-settled verdicts are NOT interchangeable and are not treated as
 * such:
 *  - `absent` is a clean read of a marker that is simply not there yet — the run
 *    is still walking. It RESETS the corruption streak.
 *  - `unusable` means the marker is THERE and cannot be judged. `journal.ts`
 *    publishes it by temp+rename, so persistence means corruption rather than
 *    latency, and the give-up point is the SHARED predicate rather than a number
 *    picked here: polling a corrupt marker to the ceiling spends paid box
 *    minutes to learn nothing already known on the second tick.
 *  - `skip` is no evidence either way (the probe itself never answered), so it
 *    must not reset the corruption streak and must not count toward it. It is
 *    simply retried until the ceiling.
 */
async function awaitInBoxMarker(
  driver: MarkerReadDriver,
  vm: string,
  markerPath: string,
  evidence: Record<string, unknown>[],
): Promise<MarkerVerdict> {
  const until = Date.now() + MARKER_POLL_CEILING_MS;
  let unusable = 0;
  let ticks = 0;
  // The pre-loop value is a REFUSAL, not a placeholder: if the ceiling were
  // already spent on arrival the loop never runs, and returning anything that
  // could read as a verdict would report a marker nobody looked at.
  let last: MarkerVerdict = {
    kind: "skip",
    code: "marker-never-polled",
    error: new Error(`the ${MARKER_POLL_CEILING_MS} ms marker budget was gone before the first tick`),
  };
  while (Date.now() < until) {
    ticks += 1;
    last = await readMarkerVerdict(driver, vm, markerPath, MARKER_READ_DEADLINE_MS);
    if (last.kind === "settled") break;
    if (last.kind === "unusable") {
      unusable += 1;
      if (markerUnusableGivesUp(unusable)) break;
    } else if (last.kind === "absent") {
      unusable = 0;
    }
    await new Promise((r) => setTimeout(r, MARKER_POLL_INTERVAL_MS));
  }
  evidence.push({
    phase: "marker-poll",
    markerPath,
    ticks,
    verdict: last.kind,
    ...(last.kind === "settled" ? { ok: last.ok } : {}),
    // The cause rides the two non-decisive verdicts, in the same shape the race
    // poller logs it — a ceiling reached with nothing read is the one outcome
    // whose diagnosis is not in the assertion message.
    ...(last.kind === "skip" || last.kind === "unusable"
      ? { code: last.code, error: (last.error as Error | undefined)?.message ?? String(last.error) }
      : {}),
  });
  return last;
}

test.todoIf(liveTodoOff())(
  "T3.5 in-box phases: dispatch → fleet run starts the engine in the box → marker+journal+engine log → harvest carries marker → teardown",
  async () => {
    liveGate("2");
    const evidence: Record<string, unknown>[] = [];
    const ctx = await preflight("2");
    let workspace = "";
    let runId = "";
    let vm = "";
    let hostRepo = "";
    let outcome = "pass";
    /** The body's own error, HELD so the post-finally verdicts run on the failing path too (EB3). */
    let failure: unknown;
    /** Destroys that FAILED (#189) — asserted AFTER the `finally`, never only recorded. */
    const destroyFailures: string[] = [];
    /** The final leak listing, hoisted: its verdict is asserted OUTSIDE the finally's catch. */
    let finalBoxes: string[] | undefined;
    /** The key population BEFORE this run — the F17 delta, rendered in the finally. */
    const hashesBefore = await listedKeyHashes();
    let keyProblems: string[] = [];
    try {
      // ── 0. the marker path this round will read, settled BEFORE a box exists ─
      // `runMarkerPath()` answers "where does THIS process write its marker" by
      // reading `QDS_RUN_ROOT` off the HOST's env (journal.ts), and the question
      // here is "where did the ENGINE write it, in the box". The two agree only
      // while this host leaves `QDS_RUN_ROOT` unset — and a host that exports it
      // (a stray from a `pipeline-run.ts` debugging session is the realistic
      // way) would silently point every read below at a path no engine ever
      // wrote, so the poll would time out and the round would be spent
      // diagnosing a box that did nothing wrong.
      //
      // So the two independent derivations are compared, HERE, before anything
      // is provisioned: `harvest.ts` keeps `BOX_RUN_ROOT` as the in-box literal
      // precisely because it must not be redirected by a host env var, and it is
      // the second opinion this checks against. Importing the helper (rather
      // than re-spelling `/run/journal/final.json` as a literal) is what keeps
      // this test reading the same path production does.
      const markerPath = runMarkerPath();
      expect(markerPath).toBe(join(BOX_RUN_ROOT, "journal", "final.json"));

      workspace = tmpWorkspace("t35");
      const recordsDir = join(workspace, "runs");
      mkdirSync(recordsDir, { recursive: true });
      writeFileSync(
        join(workspace, "cost-config.json"),
        JSON.stringify({
          defaultCapMicroUsd: T3_CAP_MICRO_USD,
          boxHourRateMicroUsd: T3_BOX_HOUR_RATE_MICRO_USD,
          perIssueOverrides: { [ISSUE_KEY]: T3_CAP_MICRO_USD },
        }),
      );
      const briefPath = join(workspace, "brief.json");
      writeFileSync(
        briefPath,
        JSON.stringify({
          repoSlug: "Quantum-Digital-Solutions/QDS-Factory",
          issueId: 46,
          commitSha: ctx.sha,
          manifestPath: "config/rosters/t3.pipeline.json",
          repoUrl: ctx.repoUrl,
        }),
      );
      evidence.push({ phase: "setup", ok: true, capMicroUsd: T3_CAP_MICRO_USD, markerPath });

      // ── 1. dispatch: box + key + delivered stamped manifest + gates ──────
      const d = await runFleet(
        ["dispatch", "--driver", "exedev", "--brief", briefPath],
        { cwd: REPO_ROOT, env: { QDS_RUNS_DIR: recordsDir }, timeoutMs: 1_800_000 },
      );
      evidence.push({ phase: "dispatch-verb", exitCode: d.exitCode, stdout: d.stdout.trim().slice(0, 400), stderrTail: d.stderr.trim().slice(-400) });
      // OWNERSHIP IS ARMED HERE — BEFORE the exit-code assertion, not from the
      // `ack` below it. Same shape as the F1 BLOCKER fixed in AC4 this round
      // (`posCreated` set after `create()` returned): `dispatch` reaches the
      // substrate and NAMES A BOX well before it can still fail, so binding
      // ownership to the success path leaves every failure path with a live box
      // nobody owns. Observed on 2026-09-03: dispatch died on a 60 s
      // `driver.create` timeout, `runId` stayed "", the `finally`'s teardown
      // fallback is guarded on `runId !== ""` so it never ran, and
      // `fleetLeftovers([vm, ""])` could not match the box — so a REAL leak was
      // downgraded to the non-failing "not this run's" stray warning and the
      // box was left billing. The stray split is right; what was wrong is that
      // this run never claimed what it created.
      //
      // Both the success ack and the failure envelopes carry the id, so it is
      // read from the raw output rather than from parsed JSON that only exists
      // on the happy path. `runId` is reassigned from `ack` below — same value,
      // kept so the ack stays the authority when there IS one.
      const emitted = emittedRunId(d.stdout, d.stderr);
      if (emitted !== undefined) runId = emitted;
      expect(d.exitCode).toBe(0);
      const ack = JSON.parse(d.stdout.trim().split("\n").filter((l) => l.startsWith("{")).at(-1) as string) as {
        runId: string;
        vmName: string;
        httpsUrl?: string;
        state: string;
      };
      expect(ack.state).toBe("ready");
      runId = ack.runId;
      vm = ack.vmName;
      evidence.push({ phase: "dispatch-ack", ack });

      // ── 2. the DELIVERED pair, read OFF the box at its AC2b placement ────
      // `$HOME/src/.qds/`, INSIDE the checkout — not the ssh HOME the retired
      // host-side runner read. Both segments come from the exported constants
      // (`DEFAULT_FILL_WORKDIR`, `QDS_IN_BOX_DIR`) that `src/fleet/dispatch.ts`
      // builds the write path from; a literal here would be a second place for
      // that placement to drift, and this file is live-gated, so the drift would
      // surface first on a paid box.
      const home = await boxHome(vm);
      const qdsDir = `${home}/${DEFAULT_FILL_WORKDIR}/${QDS_IN_BOX_DIR}`;
      const manifestBytes = await fetchBoxFile(vm, `${qdsDir}/pipeline.yaml`);
      const witnessBytes = await fetchBoxFile(vm, `${qdsDir}/run-context.json`);
      const delivered = JSON.parse(manifestBytes) as { limitMicroUsd?: number; runBudgetMs?: number };
      const witness = JSON.parse(witnessBytes) as { effectiveCeilingMicros?: number; budgetMs?: number };
      const rec = new RunRecordStore({ dir: recordsDir }).get(runId);
      evidence.push({
        phase: "delivered-pair",
        qdsDir,
        deliveredLimit: delivered.limitMicroUsd,
        deliveredRunBudgetMs: delivered.runBudgetMs,
        witnessCeiling: witness.effectiveCeilingMicros,
        witnessBudgetMs: witness.budgetMs,
        recordLimit: rec.limitMicroUsd,
      });
      // Money identity: the stamp rode OUT, the reconciliation input agrees, and
      // the record's ceiling is the same one number (AC9a/9b).
      expect(delivered.limitMicroUsd).toBe(T3_CAP_MICRO_USD);
      expect(witness.effectiveCeilingMicros).toBe(delivered.limitMicroUsd);
      expect(rec.limitMicroUsd).toBe(delivered.limitMicroUsd);
      // TIME identity, asserted HERE and not after the walk, because it decides
      // whether the walk can happen at all. The in-box engine takes no
      // `--budget-ms` on argv — the unit passes only the runId — so it reads the
      // caller's ceiling out of this witness and hands it to `loadManifest` as
      // callerBudgetMs. A witness whose `budgetMs` sits under the manifest's
      // declared `runBudgetMs` makes every start refuse "runBudgetMs exceeds
      // callerBudgetMs", and the ONLY downstream symptom is a marker that never
      // appears: a five-minute poll and a box-hour spent to learn what these two
      // integers already say. Both are checked for integerhood first, so a
      // missing field cannot make the comparison vacuously true.
      expect(Number.isSafeInteger(witness.budgetMs)).toBe(true);
      expect(Number.isSafeInteger(delivered.runBudgetMs)).toBe(true);
      expect(witness.budgetMs as number).toBeGreaterThanOrEqual(delivered.runBudgetMs as number);

      // ── 3. `fleet run`: start the in-box engine and RETURN ───────────────
      // This is the whole host-side act. The verb starts `qds-run@<runId>`,
      // prints one line and exits; it holds nothing, waits for nothing, and
      // executes no phase body. Everything asserted below happened in the box.
      const r = await runFleet(
        ["run", runId, "--driver", "exedev", "--dir", recordsDir],
        { cwd: REPO_ROOT, timeoutMs: RUN_VERB_TIMEOUT_MS },
      );
      evidence.push({ phase: "run-verb", exitCode: r.exitCode, stdout: r.stdout.trim().slice(0, 400), stderrTail: r.stderr.trim().slice(-400) });
      expect(r.exitCode).toBe(0);
      // The verb's completion line, exactly (`fleet.ts`: `started: <runId>`).
      // Exit 0 alone would also be satisfied by a build whose completion line
      // was lost — that case is exit 6 by design, and asserting the line is what
      // keeps this test able to tell the two apart.
      expect(r.stdout).toContain(`started: ${runId}`);

      // ── 4. the run settles IN THE BOX: the marker at runMarkerPath() ─────
      const verdict = await awaitInBoxMarker(ctx.driver, vm, markerPath, evidence);
      expect(verdict).toEqual({ kind: "settled", ok: true });

      // ── 5. the in-box journal: phases in order, every one promoted ───────
      // `$HOME/<runId>.journal.jsonl` — flat in the box's HOME on ext4, runId-
      // prefixed, so it survives a reboot and cannot collide with an entry the
      // harvest tar already carries from the checkout. `FileJournal` persists
      // ONE JournalFile object (pretty-printed JSON — the ".jsonl" suffix is the
      // engine's filename convention, not a line format; see FileJournal.flush),
      // so the whole body is parsed, never split into lines.
      const journalBody = JSON.parse(await fetchBoxFile(vm, `${home}/${runId}.journal.jsonl`)) as {
        ok?: boolean;
        runId?: string;
        phases?: Array<{ name?: string; status?: string }>;
      };
      const phaseRows = journalBody.phases ?? [];
      evidence.push({ phase: "journal", ok: journalBody.ok, journalRunId: journalBody.runId, rows: phaseRows.length, phases: phaseRows.map((p) => [p.name, p.status]) });
      // The journal is THIS run's: the unit's `%i` is the instance name and the
      // engine derives every path from it, so a journal carrying another runId
      // would mean the start addressed a different instance than the verb named.
      expect(journalBody.runId).toBe(runId);
      expect(journalBody.ok).toBe(true);
      expect(phaseRows.map((r) => r.name)).toEqual(["t3-probe", "t3-verify", "t3-marker"]);
      // `success` is reachable ONLY through `promotePhase` — `writePhase`
      // persists `fail` whatever the caller passes (INV-5) — so this is the
      // engine's own promotion, not an optimistic write.
      expect(phaseRows.every((r) => r.status === "success")).toBe(true);

      // ── 6. PF-2's fact, on the in-box channel: the echoed marker ─────────
      // fd 1 stays engine-owned (a manifest-declared command must not be able to
      // forge the banner or the structured log), so a code phase's stdout is
      // relayed to fd 2 — and AC4 tees fd 2 into `$HOME/<runId>.engine.log` so
      // the harvest carries what journald would otherwise keep. That file is
      // therefore where phase 1's echo lands, and reading it back proves the
      // same thing the retired shim's `steps.json` tail did: the phase really
      // ran, and its output is recoverable rather than discarded.
      //
      // The echo is the ONLY thing asserted out of this file, deliberately. The
      // obvious companion — `engine_settled` — would be a RACE against the very
      // signal that got us here: `run.finish()` writes the terminal marker and
      // the `engine_settled` line is emitted on the line AFTER it
      // (`pipeline-run.ts`, "immediately after `finish`"). So the marker this
      // poll waits on is published BEFORE that line exists, and a test that
      // asserted both would be relying on one ssh round trip being slower than
      // one `writeSync` — a flake that costs a paid round to see. The marker
      // verdict above already IS the settlement proof, and it is production's
      // own; the log is only asked for the one fact the marker cannot carry.
      const engineLog = await fetchBoxFile(vm, `${home}/${runId}.engine.log`);
      evidence.push({ phase: "engine-log", bytes: engineLog.length, tail: engineLog.trim().slice(-600) });
      expect(engineLog).toContain("t3-remote-engine-ran");

      // ── 7. the REAL harvest bundle carries the on-box committed marker ──
      hostRepo = await scratchClone(ctx.repoUrl, ctx.sha, workspace);
      const h = await runFleet(["harvest", runId, "--driver", "exedev", "--dir", recordsDir], { cwd: hostRepo, timeoutMs: 300_000 });
      evidence.push({ phase: "harvest", exitCode: h.exitCode, stdout: h.stdout.trim().slice(0, 200) });
      expect(h.exitCode).toBe(0);
      const show = Bun.spawnSync({ cmd: ["git", "show", `refs/sandbox/${runId}:t3_phase_marker.txt`], cwd: hostRepo, stdout: "pipe", stderr: "pipe" });
      evidence.push({ phase: "marker-in-bundle", exitCode: show.exitCode, body: show.stdout.toString().trim() });
      expect(show.exitCode).toBe(0);
      expect(show.stdout.toString()).toContain("t3 phase marker");

      // ── 8. teardown: spend ≤ cap, key revoked, box gone ──────────────────
      const td = await runFleet(["teardown", runId, "--driver", "exedev", "--dir", recordsDir], { cwd: hostRepo, timeoutMs: 300_000 });
      evidence.push({ phase: "teardown", exitCode: td.exitCode, stderrTail: td.stderr.trim().slice(-300) });
      expect(td.exitCode).toBe(0);
      const closed = new RunRecordStore({ dir: recordsDir }).get(runId);
      expect(closed.closedAt ?? "").not.toBe("");
      expect(closed.spendMicroUsd ?? 0).toBeLessThanOrEqual(T3_CAP_MICRO_USD);
      expect(await listedKeyHashes()).not.toContain(closed.keyHash);
      expect((await ctx.driver.list()).map((b) => b.name)).not.toContain(vm);
    } catch (e) {
      outcome = "fail";
      // HELD, not thrown (EB3): the post-finally verdicts below must render on
      // the red path too — the failing run is the one most likely to leak.
      failure = e;
      evidence.push({ phase: "test-error", error: (e as Error).message });
    } finally {
      if (runId !== "" && workspace !== "") {
        // `teardownQuietly`, not a bare `runFleet`: the 180 s ceiling firing
        // used to throw straight OUT of this finally, skipping the box destroy
        // and the evidence write below it (leaking a billing box) and replacing
        // the held body error with a teardown timeout. A non-zero exit was
        // recorded and never asserted, so a teardown that failed to revoke the
        // key shipped green. Both are now verdicts in `destroyFailures`.
        //
        // It is also what STOPS a still-walking engine: `fleet run` returned
        // long ago and the box may still be mid-phase on a red path, so this
        // destroys the substrate the engine runs on rather than leaving it to
        // burn the manifest's whole budget with nobody reading the result.
        const torn = await teardownQuietly(
          ["teardown", runId, "--driver", "exedev", "--dir", join(workspace, "runs"), "--no-harvest"],
          { timeoutMs: 180_000 },
          evidence,
        );
        if (!torn.ok) destroyFailures.push(`${runId}: ${torn.error}`);
      }
      if (vm !== "") {
        const destroyed = await destroyQuietly(ctx.driver, vm, evidence);
        if (!destroyed.ok) destroyFailures.push(`${vm}: ${destroyed.error}`);
      }
      // `fleetLeftovers`, not a single-shot `list()`: the substrate's destroy
      // lag is MEASURED at 25 s+ (r7-T-h1), so listing once milliseconds after
      // the destroy turned a correct cleanup into a failed real-money round.
      // It carries the 5×8 s poll, destroys owned survivors before rendering a
      // verdict, and warns (never fails) on boxes this run cannot prove it
      // owns. It NEVER throws, so no try/catch — one here would swallow the
      // `owned: undefined` that `fleetCleanupProblems` renders as "unmeasured".
      finalBoxes = (await fleetLeftovers(ctx.driver, [vm, runId], evidence)).owned;
      // The KEY leak verdict, beside the box one (F17): the teardown above can
      // exit 0 having destroyed the box and skipped the revoke, and only the
      // happy path's `not.toContain` would ever have noticed.
      keyProblems = await keyLeakProblems(
        hashesBefore,
        {
          driver: ctx.driver,
          store: workspace === "" ? undefined : new RunRecordStore({ dir: join(workspace, "runs") }),
          runIds: [runId],
        },
        evidence,
      );
      // `writeEvidenceQuietly` (F11): an evidence-write throw used to propagate
      // out of this `finally` and make `settleRun` below unreachable.
      writeEvidenceQuietly("T3.5", "t3-5-remote-phases", { test: "T3.5", outcome, runId, capMicroUsd: T3_CAP_MICRO_USD, phases: evidence }, destroyFailures);
      // Keep the workspace on failure — journal/marker forensics beat
      // re-spending a box to reproduce. Cleaned up on the next green run.
      // GUARDED: `force: true` swallows ENOENT but not EBUSY/EPERM (an open
      // handle on a harvested bundle), and this is the LAST statement of the
      // `finally` — a throw here discards the held `failure` and skips
      // `settleRun`, reporting an rmSync error where the regression was.
      try {
        if (workspace !== "" && outcome === "pass") rmSync(workspace, { recursive: true, force: true });
        else if (workspace !== "") process.stderr.write(`[T3.5] workspace kept for forensics: ${workspace}\n`);
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
    // the verdict — the fold-in T5.1 was doing by hand and every other tier
    // was missing, so a fallback revoke that failed was evidence prose only.
    settleRun(failure, [...fleetCleanupProblems(destroyFailures, finalBoxes, evidence), ...keyProblems]);
  },
  // BUDGET, and a STATED hazard this story did not create and did not fix.
  //
  // A bun test-timeout abort is the ONE path where the `finally` above does not
  // execute, so it is the one path that leaves a real box billing and a minted
  // key live — which is why the sibling tiers carry a ceiling priced at the sum
  // of their inner ones (tier2-dispatch-engine 6 000 s, tier4-resident 4 200 s,
  // both with the arithmetic written out). This file has never had one. Priced
  // at DECLARED ceilings its body alone is:
  //
  //   dispatch verb      runFleet timeoutMs 1_800_000                1 800 s
  //   boxHome + 4 reads  5 × DEFAULT_EXEC_TIMEOUT_MS 120               600 s
  //   fleet run verb     RUN_VERB_TIMEOUT_MS (tracks the run.ts symbol)  180 s
  //   marker poll        MARKER_POLL_CEILING_MS                        300 s
  //   scratchClone       one real clone of the pinned sha, allowance    180 s
  //   harvest + teardown 2 × runFleet timeoutMs 300_000                600 s
  //   post-teardown      listedKeyHashes + 1 control ls, allowance     240 s
  //                                                              ────────────
  //                                                                  3 900 s
  //
  // i.e. the DISPATCH ceiling alone already equals this whole number, so a
  // degraded round can be aborted mid-body with the cleanup unexecuted. What
  // DF1.10 changed here is strictly in the safe direction: the leg it replaced
  // was an unbounded `await proc.exited` on the retired host-side shim with no
  // ceiling at all, and the two constants above are the first bounds this file
  // has ever had on that leg. Sizing the runner ceiling to the sum, and cutting
  // the dispatch ceiling to the 900 s tier4 measured for the same verb, is a
  // change to numbers this leaf did not measure and is left to whoever owns the
  // round — RECORDED here rather than quietly inherited, because an unstated
  // over-subscription reads as a budget that was checked.
  1_800_000,
);
