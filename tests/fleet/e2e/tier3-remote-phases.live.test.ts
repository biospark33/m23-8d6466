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
 * `BOX_MARKER_PATH`, read and classified by the very `readMarkerVerdict` that
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
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  BOX_MARKER_PATH,
  type MarkerReadDriver,
  type MarkerVerdict,
  markerUnusableGivesUp,
  readMarkerVerdict,
} from "../../../src/fleet/fanout-primitive.ts";
import { RUN_START_TIMEOUT_MS, runUnitName } from "../../../src/fleet/run.ts";
import { DEFAULT_FILL_WORKDIR, QDS_IN_BOX_DIR } from "../../../src/providers/exedev/fill.ts";
import { BOX_RUN_ROOT } from "../../../src/providers/harvest.ts";
import { RunRecordStore } from "../../../src/providers/run-record.ts";
import {
  REPO_ROOT,
  awaitBoxAbsent,
  boxHome,
  destroyQuietly,
  emittedRunId,
  fetchBoxFile,
  fleetCleanupProblems,
  fleetLeftovers,
  fleetPartialOutput,
  keyLeakProblems,
  liveGate,
  liveTodoOff,
  listedKeyHashes,
  preflight,
  recoverDispatchIds,
  runFleet,
  scratchClone,
  settleRun,
  shellQuote,
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
 * The headroom is spent on bun's startup and the record read. Round 3, E3-2:
 * `startRun`'s post-start corroboration probe now slices the REMAINING budget
 * (`run.ts`: `Math.max(1, timeoutMs - elapsed)`) instead of taking a second
 * full one, so the verb's legitimate worst case is ~ONE `RUN_START_TIMEOUT_MS`
 * plus overhead — this constant's +60 s covers exactly that overhead, and the
 * old "two full 125 s legs" wall clock no longer exists to price. Expressed as
 * arithmetic on the import, not as a literal, because that is exactly how the
 * coupling rots — this comment carried "(90 000 ms)" while `run.ts` had already
 * moved to 120 000, and a stale number in a live-gated file is invisible until
 * it is expensive.
 */
const RUN_VERB_TIMEOUT_MS = RUN_START_TIMEOUT_MS + 60_000;

/**
 * The dispatch ceiling. 900 000, cut from 1 800 000 — the figure tier4-resident
 * MEASURED for the same verb (box provision + the A–E setup gate, C/D being
 * real roster-model pings, minutes under 540 000) and prices its own budget at.
 *
 * The old value was this file's ENTIRE runner ceiling, i.e. the first verb could
 * consume the whole test budget on its own. A bun test-timeout abort is the ONE
 * path that does not execute the `finally`, so any round where dispatch ran long
 * aborted mid-body with no teardown: the exe.dev box kept billing indefinitely
 * and the run's capped OpenRouter key stayed live. The file's own budget comment
 * stated that hazard and deferred it; this is the deferral being paid.
 */
const T3_DISPATCH_TIMEOUT_MS = 900_000;

/**
 * How long the marker may take to appear — DERIVED FROM THE MANIFEST at the
 * call site, not from this literal (L22).
 *
 * The rule: the engine refuses a manifest whose `runBudgetMs` exceeds the
 * witness's `budgetMs`, so a run that respects its own budget cannot walk
 * longer than the manifest's declared figure. Double it, and the slack covers
 * what the budget does not: systemd's job dispatch, bun's startup in the box,
 * and the third phase's own 30 s `git commit` ceiling.
 *
 * That derivation used to be written in prose above a hard-coded `300_000`
 * "derived from runBudgetMs: 150 000" — while `RUN_VERB_TIMEOUT_MS` two lines
 * up is arithmetic on an import for exactly this reason. Raising
 * `config/rosters/t3.pipeline.json`'s `runBudgetMs` silently made the poll
 * UNDER-WAIT, and the only symptom is a marker that "never appeared" on a paid
 * box. `markerPollCeilingMs` below is the arithmetic; the FLOOR is what keeps a
 * fixture that shrinks its budget from shrinking the poll below systemd and bun
 * startup.
 *
 * The fail-safe direction is UP — this is a ceiling on a degraded run, not a
 * wait — but it is bounded rather than open-ended for a money reason: a run that
 * never settles is a box that keeps billing, and the poll is the only thing that
 * ends it.
 */
const MARKER_POLL_FLOOR_MS = 300_000;
/** `2 × runBudgetMs`, floored — see {@link MARKER_POLL_FLOOR_MS}. */
function markerPollCeilingMs(runBudgetMs: number): number {
  return Math.max(MARKER_POLL_FLOOR_MS, 2 * runBudgetMs);
}

/**
 * The manifest the round actually dispatches — the ONE source the runner budget
 * below prices the marker-poll term from. Read at collection so the audit and
 * the poll share an input by construction, not by a hand-copied `300 s` line
 * (round 3, E3-4): a roster editor raising `runBudgetMs` grows the poll through
 * {@link markerPollCeilingMs} and grows this ceiling with it — the "WHOEVER
 * RAISES AN INNER CEILING" contract, enforced by arithmetic instead of prose,
 * because the fixture editor never sees this file's comments.
 */
const T3_MANIFEST_RUN_BUDGET_MS = (() => {
  // `join(REPO_ROOT, …)`, the tier2 idiom (LT2): this IIFE runs at IMPORT
  // time, before `liveTodoOff()`/`liveGate` can matter, so a bare
  // CWD-relative path ENOENTs the whole file out of a plain offline
  // `bun test` run from any other working directory.
  const v = (
    JSON.parse(readFileSync(join(REPO_ROOT, "config/rosters/t3.pipeline.json"), "utf8")) as { runBudgetMs?: number }
  ).runBudgetMs;
  if (typeof v !== "number") throw new Error("config/rosters/t3.pipeline.json carries no numeric runBudgetMs");
  return v;
})();

/**
 * The runner ceiling, priced at DECLARED inner ceilings INCLUDING the finally
 * (see the full audit table at the test's timeout argument). Arithmetic on the
 * same constants the legs use, so the fixture lever (`runBudgetMs`) and every
 * named ceiling move the total — the round-3 E3-4 fix for a static `5_300_000`
 * literal that a roster bump would silently outgrow while the poll it prices
 * kept growing.
 */
const T3_RUNNER_BUDGET_MS =
  T3_DISPATCH_TIMEOUT_MS +
  5 * 120_000 + // boxHome + 4 box reads (DEFAULT_EXEC_TIMEOUT_MS)
  RUN_VERB_TIMEOUT_MS +
  markerPollCeilingMs(T3_MANIFEST_RUN_BUDGET_MS) +
  120_000 + // red-path diagnose (4 × 30 s — journal leg included, L20)
  30_000 + // Restart probe
  180_000 + // scratchClone allowance
  600_000 + // harvest + teardown (2 × runFleet 300 s)
  4 * (120_000 + 10_000) + // box-absence poll (awaitBoxAbsent: 4 × (120 s ls + 10 s wait))
  240_000 + // post-teardown listedKeyHashes allowance
  180_000 + // finally: teardownQuietly
  120_000 + // finally: destroyQuietly
  880_000 + // finally: fleetLeftovers (5 × (120 s ls + 8 s wait) + destroy pass + re-list)
  360_000 + // finally: keyLeakProblems (delta list + fallback revoke + recheck)
  10_000 + // finally: evidence + rmSync
  // MARGIN (round 4, LT3): the sum above priced two legs exactly at their
  // stated figures with zero slack — the absence poll at 4 × 130 s (it was
  // 510 s against its own arithmetic) and the marker poll at a ceiling the
  // loop only checks BEFORE each tick, so the last tick may spend
  // MARKER_READ_DEADLINE_MS + interval PAST it. An explicit term, not a
  // rounding of the others, so the next reader sees the slack is deliberate.
  300_000;
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
  runId: string,
  ceilingMs: number,
  evidence: Record<string, unknown>[],
): Promise<MarkerVerdict> {
  const until = Date.now() + ceilingMs;
  let unusable = 0;
  let ticks = 0;
  // The pre-loop value is a REFUSAL, not a placeholder: if the ceiling were
  // already spent on arrival the loop never runs, and returning anything that
  // could read as a verdict would report a marker nobody looked at.
  let last: MarkerVerdict = {
    kind: "skip",
    code: "marker-never-polled",
    error: new Error(`the ${ceilingMs} ms marker budget was gone before the first tick`),
  };
  while (Date.now() < until) {
    ticks += 1;
    // `runId` rides the read (the same `expectedRunId` `fleet status` passes):
    // the marker path is one per BOX, so a marker written by another run on
    // this box would otherwise settle this poll with someone else's verdict.
    last = await readMarkerVerdict(driver, vm, markerPath, MARKER_READ_DEADLINE_MS, runId);
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
    ceilingMs,
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
      // `BOX_MARKER_PATH`, not `runMarkerPath()`. This step used to call the
      // latter — which answers "where does THIS process write its marker" by
      // reading `QDS_RUN_ROOT` off the HOST's env — and then compare it against
      // `BOX_RUN_ROOT` to catch a host that had exported the variable. DF1.10
      // removed the need for the comparison by removing the coupling: every
      // host-side reader of a BOX marker (this file, `fleet status`, the fan-out
      // race poller) now goes through the same literal, which no environment can
      // move. The identity assertion is KEPT — it costs nothing and it pins the
      // two constants that build the path to the shape the engine writes.
      const markerPath = BOX_MARKER_PATH;
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
      // L18: the ceiling is `T3_DISPATCH_TIMEOUT_MS` (900 s), not 1 800 000 —
      // which used to equal this file's WHOLE runner budget, so the first verb
      // could consume all of it and the abort would land mid-body with the
      // `finally` unexecuted, leaving a real box billing and a capped key live.
      // The `.catch` is L1: the ceiling REJECTS, so `d` never exists on that
      // path and the ids `dispatch` already named would be lost with it —
      // `fleetPartialOutput` hands back whatever the killed child had written.
      const d = await runFleet(
        ["dispatch", "--driver", "exedev", "--brief", briefPath],
        { cwd: REPO_ROOT, env: { QDS_RUNS_DIR: recordsDir }, timeoutMs: T3_DISPATCH_TIMEOUT_MS },
      ).catch((e: unknown) => {
        const partial = fleetPartialOutput(e);
        const recovered = recoverDispatchIds(partial.stdout, partial.stderr);
        if (runId === "") runId = recovered.runId;
        if (vm === "") vm = recovered.vmName;
        evidence.push({ phase: "dispatch-verb-timeout", error: (e as Error).message, runId, vm });
        throw e;
      });
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
      const home = await boxHome(ctx.driver, vm);
      const qdsDir = `${home}/${DEFAULT_FILL_WORKDIR}/${QDS_IN_BOX_DIR}`;
      const manifestBytes = await fetchBoxFile(ctx.driver, vm, `${qdsDir}/pipeline.yaml`);
      const witnessBytes = await fetchBoxFile(ctx.driver, vm, `${qdsDir}/run-context.json`);
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

      // ── 4. the run settles IN THE BOX: the marker at BOX_MARKER_PATH ─────
      const verdict = await awaitInBoxMarker(
        ctx.driver,
        vm,
        markerPath,
        runId,
        markerPollCeilingMs(delivered.runBudgetMs as number),
        evidence,
      );
      // DIAGNOSE BEFORE THE SUBSTRATE GOES AWAY (L20). On the red path this poll
      // burned its whole ceiling and produced exactly one fact —
      // `{verdict:"absent"}` — and then the `finally` destroyed the box, taking
      // tmpfs `/run` and every remaining clue with it. The three causes that
      // reading cannot distinguish (the unit never started / the engine died /
      // the engine is still walking) look identical from out here, so a failed
      // round cost a box-hour and yielded "the marker was absent, box already
      // gone". Two bounded reads close that: the unit's own verdict, and the
      // engine log — which DF1.10 opens at the FRONT DOOR, before
      // `deriveInBoxArgv` can throw, so it now exists for start failures too.
      // Every leg is guarded: a diagnostic that throws would replace the
      // assertion below with a transport error at the worst possible moment.
      // The JOURNAL leg (round 4, LT4) is the one that names the failing
      // PHASE: `$HOME/<runId>.journal.jsonl` lives only on the box, and the
      // `finally` below destroys the box — without this leg a red round
      // burned its evidence with the substrate, leaving only the 4 KB
      // engine-log tail to diagnose a failed walk from.
      if (!(verdict.kind === "settled" && verdict.ok)) {
        for (const [phase, argv] of [
          ["diagnose-unit", ["systemctl", "show", "-p", "ActiveState", "-p", "Result", "-p", "ExecMainStatus", runUnitName(runId)]],
          ["diagnose-journalctl", ["sh", "-c", `journalctl -u ${shellQuote(runUnitName(runId))} --no-pager -n 60 2>&1 || true`]],
          ["diagnose-journal", ["sh", "-c", `tail -c 4000 ${shellQuote(`${home}/${runId}.journal.jsonl`)} 2>&1 || true`]],
          ["diagnose-engine-log", ["sh", "-c", `tail -c 4000 ${shellQuote(`${home}/${runId}.engine.log`)} 2>&1 || true`]],
        ] as Array<[string, string[]]>) {
          try {
            const out = await ctx.driver.execTimed(vm, argv, 30_000);
            evidence.push({ phase, exitCode: out.exitCode, stdout: out.stdout.trim().slice(-1200) });
          } catch (diagError) {
            evidence.push({ phase, error: diagError instanceof Error ? diagError.message : String(diagError) });
          }
        }
      }
      expect(verdict).toEqual({ kind: "settled", ok: true });

      // ── 5. the in-box journal: phases in order, every one promoted ───────
      // `$HOME/<runId>.journal.jsonl` — flat in the box's HOME on ext4, runId-
      // prefixed, so it survives a reboot and cannot collide with an entry the
      // harvest tar already carries from the checkout. `FileJournal` persists
      // ONE JournalFile object (pretty-printed JSON — the ".jsonl" suffix is the
      // engine's filename convention, not a line format; see FileJournal.flush),
      // so the whole body is parsed, never split into lines.
      const journalBody = JSON.parse(await fetchBoxFile(ctx.driver, vm, `${home}/${runId}.journal.jsonl`)) as {
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
      const engineLog = await fetchBoxFile(ctx.driver, vm, `${home}/${runId}.engine.log`);
      evidence.push({ phase: "engine-log", bytes: engineLog.length, tail: engineLog.trim().slice(-600) });
      expect(engineLog).toContain("t3-remote-engine-ran");

      // ── 6b. `Restart=no`, read off the unit (L21) ────────────────────────
      // The header's survivability claim and DF1.10's whole "an absent marker is
      // permanent" reading both rest on this one directive, and until now
      // nothing in the live tree read it. An image regression to
      // `Restart=always` would re-walk a finished run after every reboot and
      // pass every other assertion in this file. `systemctl show` is a READ and
      // needs no sudo.
      //
      // THE OTHER negative cases L21 names — a unit that fails to start, and
      // AC6's replay refusal — are deliberately NOT duplicated here: they now
      // run live in `tier2-in-box-engine.live.test.ts` (steps 7b and 8b), on a
      // box that round has already paid for, and asserting them twice would buy
      // a second box for the same fact.
      const restart = await ctx.driver.execTimed(vm, ["systemctl", "show", runUnitName(runId), "-p", "Restart"], 30_000);
      evidence.push({ phase: "unit-restart", exitCode: restart.exitCode, stdout: restart.stdout.trim() });
      expect(restart.exitCode).toBe(0);
      expect(restart.stdout.trim()).toBe("Restart=no");

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
      // POLLED (L3): the substrate's destroy lag is MEASURED at 25 s+, so a
      // single listing taken right after `teardown` returned turned a clean
      // cleanup into a failed paid round. `awaitBoxAbsent` only looks — it does
      // not destroy a survivor the way `fleetLeftovers` does, so it cannot
      // report clean for a teardown that destroyed nothing.
      const gone = await awaitBoxAbsent(ctx.driver, vm, evidence, { maxAttempts: 4, retryDelayMs: 10_000 });
      expect(gone.absent).toBeTrue();
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
  // BUDGET, and the hazard this file used to state and defer (L18) — now paid.
  //
  // A bun test-timeout abort is the ONE path where the `finally` above does not
  // execute, so it is the one path that leaves a real box billing and a minted
  // key live. This file carried a runner ceiling of 1 800 000 against a body
  // priced at 3 900 s of its own inner ceilings, and the dispatch leg ALONE was
  // 1 800 000 — the first verb could consume the entire test budget, so any
  // round where dispatch ran long aborted mid-body with no teardown at all.
  //
  // BOTH halves of the fix, because either alone leaves the sum over the
  // ceiling: the dispatch leg is cut to `T3_DISPATCH_TIMEOUT_MS` (900 s — the
  // figure tier4 MEASURED for the same verb), and the runner ceiling is sized to
  // the priced sum INCLUDING the `finally`, which this audit never counted.
  //
  //   dispatch verb      T3_DISPATCH_TIMEOUT_MS (was 1 800 s)          900 s
  //   boxHome + 4 reads  5 × DEFAULT_EXEC_TIMEOUT_MS 120               600 s
  //   fleet run verb     RUN_VERB_TIMEOUT_MS (tracks the run.ts symbol)  185 s
  //   marker poll        markerPollCeilingMs(runBudgetMs) — 2 × 150 s,
  //                      floored at 300 s (L22: derived, not a literal)  300 s
  //   red-path diagnose  4 × 30 s, only on a non-settled verdict (L20)  120 s
  //   Restart probe      systemctl show -p Restart at 30 s              30 s
  //   scratchClone       one real clone of the pinned sha, allowance    180 s
  //   harvest + teardown 2 × runFleet timeoutMs 300_000                600 s
  //   box-absence poll   awaitBoxAbsent 4 × (control ls 120 + 10 wait)  520 s
  //   post-teardown      listedKeyHashes, allowance                     240 s
  //                                                            body ────────
  //                                                                  3 675 s
  //   teardownQuietly    timeoutMs 180_000                             180 s
  //   destroyQuietly     1 control rm at 120                           120 s
  //   fleetLeftovers     5 × (control ls 120 + 8 s wait) + its destroy
  //                      pass + the confirming re-list                 880 s
  //   keyLeakProblems    delta list + fallback revoke + recheck list    360 s
  //   evidence + rmSync  local                                          10 s
  //                                                         finally ────────
  //                                                                  1 550 s
  //   margin             explicit (round 4, LT3) — see the term above   300 s
  //                                                                 ────────
  // Hence `T3_RUNNER_BUDGET_MS` (round 3, E3-4): the sum is now ARITHMETIC, not
  // a literal — the marker-poll term is `markerPollCeilingMs(T3_MANIFEST_RUN_BUDGET_MS)`,
  // the fixture's own figure — so raising `runBudgetMs` in the roster grows the
  // poll AND the runner ceiling together, and this audit line can no longer rot
  // behind a literal while the poll grows past it. Every inner ceiling FIRING is
  // safe — it rejects into the catch and the `finally` still runs — so the
  // fail-safe direction for this number is UP: it is what a fully degraded round
  // may consume before the one abort that skips cleanup, not a target. A healthy
  // round finishes in minutes.
  // WHOEVER RAISES AN INNER CEILING OR ADDS A CLEANUP STEP MUST RE-ADD IT HERE.
  T3_RUNNER_BUDGET_MS,
);
