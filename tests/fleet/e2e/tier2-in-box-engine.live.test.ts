/**
 * T2.2 — the IN-BOX slice, end to end: DF1.10's whole reason for existing.
 *
 * `fleet dispatch` → `fleet run <runId>` → the in-box phase engine walks the
 * dispatched manifest under systemd → `fleet status` reads the completion
 * marker back over `readBoxFile` → `fleet harvest` carries the run's evidence
 * off a box that is about to be destroyed.
 *
 * CHARTER: `docs/superpowers/specs/2026-08-31-tier2-placement-adr.md` (ACCEPTED),
 * Consequences item 2 — "records/trace written in-box and harvested (§5.3)". Step
 * 8's tar assertions are that sentence made checkable, not incidental coverage:
 * §5.3's trace-DB harvest is third of the five mechanisms the ADR says depend on
 * in-box placement. The product argument is the ADR's own: "What host-side can
 * never deliver — runs that survive host disconnect — is the product (Dark
 * Factory = unattended autonomy)." This file is what proves the BOX did the work
 * — the host starts a unit, walks away, and later reads a marker and a tar.
 *
 * IT DELIBERATELY TOUCHES NO STEERING, and that absence is the ADR's Interim
 * clause rather than an oversight: "live tests keep asserting the honest
 * `no-ack` shipped shape until the in-box consumer lands. No interim transport
 * machinery." The in-box steering consumer is a LATER story than this engine
 * (the ADR's item 2 predates the renumbering and still says DF1.10), so nothing
 * here may assert an ack. Whoever adds a steering leg to this file inverts an
 * ADR clause and owes it the same argument.
 *
 * WHY THIS FILE EXISTS BESIDE T2.1. `tier2-dispatch-engine.live.test.ts` proves
 * the DISPATCH half and then drives an engine of its own making — it `ssh`es a
 * `pi` worker into the box by hand, because at the time it was written the
 * dispatched `pipeline.yaml` had no in-box consumer (its own header says so).
 * DF1.10 built that consumer: `qds-engine run <runId>` (scripts/pipeline-run.ts
 * :1595) under `qds-run@<runId>.service`. Nothing else in the live tree starts
 * it, so without this file every claim DF1.10 makes — AC1's start verb, AC2's
 * in-box derivation, AC4's durability split, AC5's marker-backed status — is
 * proven only by host-side unit tests against fakes.
 *
 * GATING: QDS_E2E_LIVE=1 AND QDS_E2E_TIER=2 — `liveGate("2")` throws on a tier
 * mismatch or a half-configured substrate env, exactly like its siblings.
 * Normal `bun test`/CI: todo. Spend is approved OUT of band (e2e-plan budget
 * protocol): 1 key × capMicroUsd + the setup gate's C/D pings + the resident's
 * run-end solicitation + 1 box ≤ 1h.
 *
 * WHAT COSTS MONEY, stated because a reader must be able to price this file:
 * the setup gate's assertions C and D are real chat/completions calls, and the
 * dispatched run-context arms the DF3.3 resident (it carries `requestId`,
 * `repoSlug` and `issueId`, which is `pipeline-run.ts`'s arming test at :2150),
 * whose run-end solicitation is one more real round trip. Both land on the RUN
 * KEY, twice-capped by the mint cap and by budget admission. The manifest's own
 * two phases are `echo`/`true` — deliberately free, so the money in this round
 * buys the engine PATH rather than a workload.
 *
 * NO FAKES: real ssh exec, real systemd, real OpenRouter key API, real
 * `bun scripts/fleet.ts` subprocesses, real tar off a real box.
 */
import { expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { classifyMarkerRead, DEFAULT_PER_CALL_DEADLINE_MS } from "../../../src/fleet/fanout-primitive.ts";
// The systemd instance name, from the ONE place that builds it — so the
// remediation this test prints names the unit `fleet run` actually started.
import { runUnitName } from "../../../src/fleet/run.ts";
// The in-box layout, imported rather than re-spelled. `QDS_IN_BOX_DIR` and
// `DEFAULT_FILL_WORKDIR` are the two constants `dispatch.ts:2839` builds the
// delivered manifest pair's path from; `runMarkerPath`/`runMarkerRoot` are the
// two the engine and `fleet status` build the tmpfs marker's path from.
import { runMarkerPath, runMarkerRoot } from "../../../src/phase-engine/journal.ts";
import { DEFAULT_FILL_WORKDIR, QDS_IN_BOX_DIR } from "../../../src/providers/exedev/fill.ts";
import { readBoxFile } from "../../../src/providers/exedev/transport.ts";
import { RunRecordStore } from "../../../src/providers/run-record.ts";
// The repo's own redactor, for the engine-log tail the fast-fail quotes: it is
// box-authored text on the capped run key heading for an error message and the
// evidence file. Producer-side, exactly as `src/fleet/run.ts` treats stderr.
import { redactSecrets } from "../../../src/providers/step-log.ts";
import {
  EVIDENCE_DIR,
  REPO_ROOT,
  boxHome,
  destroyQuietly,
  emittedRunId,
  fleetCleanupProblems,
  fleetLeftovers,
  keyLeakProblems,
  listedKeyHashes,
  liveGate,
  liveTodoOff,
  preflight,
  runFleet,
  scratchClone,
  settleRun,
  shellQuote,
  teardownQuietly,
  tmpWorkspace,
  writeEvidenceQuietly,
} from "./live-harness.ts";

/** Plan default (e2e-plan.md §TIER-2): 50,000 µ$ = $0.05 worst-case per key. */
const T2_CAP_MICRO_USD = 50_000;
/** Box-hour rate from the operator's TIER-1 cost config (230,000 µ$/h). */
const T2_BOX_HOUR_RATE_MICRO_USD = 230_000;

/**
 * The manifest `fleet dispatch` delivers and `qds-engine` walks — the SAME one
 * T2.1 dispatches, deliberately. Two `code` phases (`echo`, `true`), no model
 * call, `runBudgetMs` 60 000: the engine leg of this test must fail for engine
 * reasons, never because a workload was flaky or a model was slow.
 */
const T2_MANIFEST_PATH = "config/rosters/t2.pipeline.json";

/**
 * How long the run may take to settle, as `fleet status` calls × the wait
 * between them. Sized to the manifest, not guessed: two 1 s phases plus the
 * engine's own start-up plus ONE resident solicitation, which `resident.ts`
 * bounds at `SOLICIT_TIMEOUT_MS` (60 s). Ten × 15 s of waiting is ~2.5 minutes
 * of pure sleep on top of ten real status round trips — several times the
 * budget a healthy run needs, and still bounded, because a poll that never
 * gives up is a paid box that never gets torn down.
 */
const STATUS_POLL_ATTEMPTS = 10;
const STATUS_POLL_WAIT_MS = 15_000;

/** AC5's terminal in-box verdicts: the poll stops on either, and asserts after. */
const SETTLED_STATES: ReadonlySet<string> = new Set(["ok", "not-ok"]);

/**
 * INV-IBOX-8's redaction claim, as the ONE marker the harvest unit tests use
 * for it (`tests/providers/harvest.test.ts:1665`): OpenRouter mints run keys
 * with this prefix, so a single occurrence anywhere in the extracted tree is
 * the run key leaving the box inside the audit evidence.
 */
const KEY_PREFIX = "sk-or-";

/** Every extracted file under `dir`, as absolute paths — directories excluded. */
function extractedFiles(dir: string): string[] {
  return readdirSync(dir, { recursive: true })
    .map((rel) => join(dir, rel as string))
    .filter((p) => statSync(p).isFile());
}

test.todoIf(liveTodoOff())(
  "T2.2 dispatch→fleet run→in-box engine→marker read→harvest — real exe.dev box, real systemd, capped at 50,000 µ$",
  async () => {
    liveGate("2");
    // REFUSED BEFORE ANY SPEND, and this is not defensive padding — it is the
    // one host-side variable that can make every in-box assertion below green
    // about the wrong file. `runMarkerPath()` reads `QDS_RUN_ROOT` off THIS
    // process's environment (journal.ts:48) and this test uses its answer twice
    // as an IN-BOX path: for its own `test -f`/`readBoxFile` probes, and as the
    // path the `fleet status` subprocess derives for its marker read. The box
    // never sets the variable — `qds-run@.service` forbids it by name and the
    // image build scans for it — so a host export silently points both probes
    // at a path that does not exist in the box: `test -f` exits 1, which
    // `classifyMarkerRead` reads as a CLEAN MISS, and the run reports `running`
    // forever while the real marker sits unread at /run/journal/final.json.
    // That is a green-then-timeout on a paid box, so it is refused here, before
    // `preflight` has touched the substrate.
    const hostRunRoot = (process.env.QDS_RUN_ROOT ?? "").trim();
    if (hostRunRoot !== "") {
      throw new Error(
        `QDS_RUN_ROOT is exported host-side as ${JSON.stringify(hostRunRoot)}. It is a HOST-side test lever (journal.ts:39-47) and the box never sets it, but this test and the \`fleet status\` subprocess both derive the IN-BOX marker path from it — unset it and re-run, or every marker assertion in this file describes a path the box does not have`,
      );
    }
    const evidence: Record<string, unknown>[] = [];
    const ctx = await preflight("2");
    let workspace = "";
    let runId = "";
    let vmName = "";
    let dispatchOut = "";
    let dispatchErr = "";
    let outcome = "pass";
    /** The body's own error, HELD so the post-finally verdicts run on the failing path too (EB3). */
    let failure: unknown;
    /** Destroys that FAILED (#189) — asserted AFTER the `finally`, never only recorded. */
    const destroyFailures: string[] = [];
    /** The final leak listing, hoisted: its verdict is asserted OUTSIDE the finally's catch. */
    let finalBoxes: string[] | undefined;
    /**
     * The key population BEFORE this run (F17). The dispatch mints one and the
     * teardown revokes it; a teardown that destroyed the box and exited 0 while
     * SKIPPING the revoke would otherwise leave a live key behind a green round.
     */
    const hashesBefore = await listedKeyHashes();
    let keyProblems: string[] = [];
    try {
      workspace = tmpWorkspace("t22");
      const recordsDir = join(workspace, "runs");
      mkdirSync(recordsDir, { recursive: true });
      // R4: the operator's cost config sits BESIDE the records dir
      // (costLedgerOpts → dirname(recordsDir)/cost-config.json). Without it,
      // admission falls back to defaultCapMicroUsd 5,000,000 µ$ ($5!) and the
      // mint would be capped five dollars high.
      writeFileSync(
        join(workspace, "cost-config.json"),
        JSON.stringify({ defaultCapMicroUsd: T2_CAP_MICRO_USD, boxHourRateMicroUsd: T2_BOX_HOUR_RATE_MICRO_USD }),
      );
      const briefPath = join(workspace, "brief.json");
      writeFileSync(
        briefPath,
        JSON.stringify({
          repoSlug: "Quantum-Digital-Solutions/QDS-Factory",
          issueId: 46,
          commitSha: ctx.sha,
          manifestPath: T2_MANIFEST_PATH,
          repoUrl: ctx.repoUrl,
        }),
      );
      evidence.push({ phase: "setup", ok: true, capMicroUsd: T2_CAP_MICRO_USD, manifestPath: T2_MANIFEST_PATH });

      // ── 1. dispatch: box + fill + the manifest pair + the setup gate ──────
      const dispatch = await runFleet(
        ["dispatch", "--driver", "exedev", "--brief", briefPath, "--dir", recordsDir],
        { cwd: REPO_ROOT, timeoutMs: 1_200_000 },
      );
      dispatchOut = dispatch.stdout;
      dispatchErr = dispatch.stderr;
      evidence.push({
        phase: "dispatch-verb",
        exitCode: dispatch.exitCode,
        stdoutTail: dispatch.stdout.trim().slice(-400),
        stderrTail: dispatch.stderr.trim().slice(-600),
      });
      // Ownership armed BEFORE the assertion that can throw — `dispatch` names a
      // box before it can still fail, so binding ownership to the success ack
      // below would leave a failure path with a live box nobody owns.
      const emitted = emittedRunId(dispatch.stdout, dispatch.stderr);
      if (emitted !== undefined) runId = emitted;
      expect(dispatch.exitCode).toBe(0);

      const ackLine = dispatch.stdout.trim().split("\n").filter((l) => l.startsWith("{")).at(-1);
      expect(ackLine).toBeDefined();
      const ack = JSON.parse(ackLine as string) as { runId: string; vmName: string; state: string };
      runId = ack.runId;
      vmName = ack.vmName;
      expect(ack.state).toBe("ready");
      evidence.push({ phase: "ack", runId, vmName });

      // ── 2. AC2b — the manifest pair is where the ENGINE will look for it ──
      // The paths are built from the two exported constants, never re-spelled:
      // `deriveInBoxArgv` (pipeline-run.ts:1625-1632) resolves the run root as
      // `$HOME/src` and the pair as `<root>/.qds/{pipeline.yaml,
      // run-context.json}`, and REFUSES the run outright if the witness is
      // unreadable or carries no positive `budgetMs`. So this is not a cosmetic
      // check on delivery — it is the precondition for step 4 starting at all,
      // asserted here where the failure is one `cat` instead of a systemd unit
      // that exited before it logged anything useful.
      const home = await boxHome(vmName);
      // THE WHOLE IN-BOX LAYOUT, resolved once here rather than at each step
      // that needs it. Every one is a literal built from an exported constant
      // and NOT ONE is a glob — see step 7 for why that matters — and declaring
      // them together is what keeps a single spelling of each: the engine log
      // is read by the fast-fail in step 5 and asserted by step 7, and two
      // spellings of one path is exactly the drift this file exists to catch.
      const qdsDir = `${home}/${DEFAULT_FILL_WORKDIR}/${QDS_IN_BOX_DIR}`;
      const manifestBoxPath = `${qdsDir}/pipeline.yaml`;
      const witnessBoxPath = `${qdsDir}/run-context.json`;
      const journalBoxPath = `${home}/${runId}.journal.jsonl`;
      const engineLogBoxPath = `${home}/${runId}.engine.log`;
      const markerBoxPath = runMarkerPath();
      const traceBoxPath = `${runMarkerRoot()}/trace/trace.db`;
      const pair = await ctx.driver.exec(vmName, [
        "sh",
        "-c",
        `cat ${shellQuote(manifestBoxPath)} && printf '\\n---WITNESS---\\n' && cat ${shellQuote(witnessBoxPath)}`,
      ]);
      evidence.push({ phase: "manifest-pair", exitCode: pair.exitCode, manifestBoxPath, witnessBoxPath });
      expect(pair.exitCode).toBe(0);
      const witness = JSON.parse(pair.stdout.slice(pair.stdout.indexOf("---WITNESS---") + "---WITNESS---".length)) as {
        runId: string;
        effectiveCeilingMicros: number;
        budgetMs: number;
        requestId?: string;
        repoSlug?: string;
      };
      expect(witness.runId).toBe(runId);
      expect(witness.effectiveCeilingMicros).toBe(T2_CAP_MICRO_USD);
      // The engine takes NO `--budget-ms` on argv and refuses rather than
      // defaulting one (pipeline-run.ts:1644), so a witness without a positive
      // integer here is a run that cannot start — and the manifest's own
      // `runBudgetMs` must fit inside it or `loadManifest` refuses at
      // admission. Both asserted, because the engine failure they cause is a
      // unit that exits before writing a marker: `fleet status` would then poll
      // `running` to the ceiling and the round would die at step 5 with nothing
      // naming the cause.
      expect(Number.isSafeInteger(witness.budgetMs) && witness.budgetMs > 0).toBeTrue();
      // Read off the manifest rather than re-typed as a literal: the number is
      // fixture data that a future edit to `t2.pipeline.json` may move, and a
      // stale copy here would either pass vacuously or fail a healthy round.
      const manifestBudgetMs = (
        JSON.parse(readFileSync(join(REPO_ROOT, T2_MANIFEST_PATH), "utf8")) as { runBudgetMs: number }
      ).runBudgetMs;
      expect(witness.budgetMs).toBeGreaterThanOrEqual(manifestBudgetMs);
      // The resident's arming inputs (pipeline-run.ts:2150 reads exactly these):
      // recorded rather than asserted, because whether the resident arms decides
      // which artifacts step 8 can require of the tar, and this is the evidence
      // that decides it.
      evidence.push({
        phase: "witness",
        budgetMs: witness.budgetMs,
        effectiveCeilingMicros: witness.effectiveCeilingMicros,
        armsResident: (witness.requestId ?? "") !== "" || (witness.repoSlug ?? "") !== "",
      });

      // ── 3. the record carries the money identity the engine will spend on ──
      const store = new RunRecordStore({ dir: recordsDir });
      const rec = store.get(runId);
      expect(rec.vmName).toBe(vmName);
      expect(rec.keyHash ?? "").not.toBe("");
      expect(rec.limitMicroUsd).toBe(T2_CAP_MICRO_USD);
      evidence.push({ phase: "record", ok: true, keyHash: rec.keyHash, limitMicroUsd: rec.limitMicroUsd });

      // ── 3b. AC1 NEGATIVE CONTROL (leaf-1.3.1:G2) — a HOST walk cannot run ─
      // The retired shim's route, reconstructed: the host reads the manifest,
      // walks its phases and `driver.exec`s the `code` ones. It runs BEFORE
      // `fleet run`, on this run's own box, so what follows in step 5 onwards
      // is attributable to the engine and to nothing else.
      //
      // It is non-vacuous in BOTH directions, which is the only reason it is
      // worth a live slot:
      //  - the bodies really execute — the `echo` phase's own marker word comes
      //    back on stdout, off the box, so this is not a control that "failed"
      //    because the exec channel was broken;
      //  - and the run is nonetheless NOT settled by it: no marker at
      //    `runMarkerPath()`, no journal, no engine log. `fleet status` still
      //    answers `running`. A host that executes every phase body it can
      //    still cannot produce the run's verdict, because the verdict is
      //    written by the engine's journal (AC1/C1: the host runs no phase
      //    body that MATTERS, and this is the live half of that claim).
      //
      // What it does NOT prove, stated because a control that overclaims is
      // worse than none: this manifest declares only `code` phases, so the
      // `dispatch_task` half of `PhaseKind` is not exercised here. That half is
      // enforced by the COMPILER (`makeBodyFactory`'s `never` exhaustiveness,
      // leaf-1.1.1:G1) and there is no host executor to reach at all.
      //
      // 30 s per exec, not the 120 s default: these are `echo` and `true`, they
      // answer in milliseconds, and their ceilings are what the budget audit at
      // the foot of this file has to price.
      const hostWalkPhases = (
        JSON.parse(readFileSync(join(REPO_ROOT, T2_MANIFEST_PATH), "utf8")) as {
          phases: { name: string; kind: string; command: string[] }[];
        }
      ).phases.filter((p) => p.kind === "code");
      // The filter must not be what makes the control pass: a manifest whose
      // phases all failed to match would "prove" the point by walking nothing.
      expect(hostWalkPhases.length).toBeGreaterThan(0);
      const hostWalkOutput: string[] = [];
      for (const phase of hostWalkPhases) {
        const ran = await ctx.driver.execTimed(vmName, phase.command, 30_000);
        hostWalkOutput.push(`${phase.name}:${ran.exitCode}:${ran.stdout.trim()}`);
        expect(ran.exitCode).toBe(0);
      }
      // The `echo` phase's own word, from the manifest and not re-typed: the
      // host DID execute a phase body on this box.
      expect(hostWalkOutput.join("\n")).toContain("t2-e2e-engine-ran");
      // …and produced nothing the run is settled by. `test -f` per name, the
      // same shape step 7 uses, so an absent file reports MISSING rather than
      // matching nothing.
      const afterHostWalk = await ctx.driver.execTimed(
        vmName,
        [
          "sh",
          "-c",
          [markerBoxPath, journalBoxPath, engineLogBoxPath, traceBoxPath]
            .map((p) => `test -f ${shellQuote(p)} && echo PRESENT ${shellQuote(p)} || echo MISSING ${shellQuote(p)}`)
            .join("; "),
        ],
        30_000,
      );
      const hostWalkMarker = classifyMarkerRead(
        await readBoxFile(ctx.driver, vmName, markerBoxPath, DEFAULT_PER_CALL_DEADLINE_MS),
      );
      const hostWalkStatus = await runFleet(["status", runId, "--driver", "exedev", "--dir", recordsDir], {
        timeoutMs: 120_000,
      });
      const hostWalkRow = JSON.parse(hostWalkStatus.stdout.trim().split("\n").at(-1) ?? "{}") as { state?: string };
      evidence.push({
        phase: "host-walk-negative-control",
        walked: hostWalkOutput,
        probe: afterHostWalk.stdout.trim(),
        markerKind: hostWalkMarker.kind,
        statusState: hostWalkRow.state,
      });
      expect(afterHostWalk.stdout).not.toContain("PRESENT");
      expect(hostWalkMarker.kind).toBe("absent");
      expect(hostWalkRow.state).toBe("running");

      // ── 4. AC1 — `fleet run`: start the unit and RETURN ───────────────────
      // The verb's whole contract is that it does not wait: it starts
      // `qds-run@<runId>.service` and prints `started: <runId>`. Everything
      // after this line observes the run through a DIFFERENT verb, which is the
      // separation DF1.10 exists to establish.
      //
      // `startMs` is RECORDED, not asserted, and the distinction is deliberate.
      // "It returned before the engine finished" has no honest threshold from
      // out here: the engine's duration is the manifest's phases plus a real
      // model round trip, so any ceiling this test picked would be a timing
      // guess — the exact species of assertion that turns a live round red for
      // a slow evening rather than for a regression. What DOES pin the contract
      // is structural and already in the source: `startRun` issues one
      // `systemctl start` and returns its exit status (src/fleet/run.ts:253),
      // with no poll and no marker read anywhere in the module. The number
      // lands in evidence so a round that took minutes here is visible to the
      // reader who can act on it.
      const startedAt = Date.now();
      const start = await runFleet(["run", runId, "--driver", "exedev", "--dir", recordsDir], {
        cwd: REPO_ROOT,
        timeoutMs: 180_000,
      });
      const startMs = Date.now() - startedAt;
      evidence.push({
        phase: "run-verb",
        exitCode: start.exitCode,
        startMs,
        stdout: start.stdout.trim().slice(0, 300),
        stderrTail: start.stderr.trim().slice(-400),
      });
      expect(start.exitCode).toBe(0);
      expect(start.stdout).toContain(`started: ${runId}`);

      // ── 5. AC5 — the marker-backed status vocabulary, over the REAL driver ─
      // Polled, not raced: the run's four states are running → ok/not-ok, and
      // the transition happens whenever the engine finishes. `running` is
      // deliberately NOT asserted — it is a transient this poll may legitimately
      // miss on a two-phase manifest, and a live test that asserts a transient
      // is a live test that fails for timing. What IS asserted is the terminal
      // verdict, and that it is a member of AC5's vocabulary at all: a row still
      // reading `live` here would mean `markerReader` found no `execTimed` and
      // the whole marker read was skipped (status.ts:1137) — AC5 unwired, which
      // no other assertion in this file would catch.
      const seenStates: string[] = [];
      let terminal = "";
      for (let attempt = 1; attempt <= STATUS_POLL_ATTEMPTS; attempt += 1) {
        const status = await runFleet(["status", runId, "--driver", "exedev", "--dir", recordsDir], {
          timeoutMs: 120_000,
        });
        expect(status.exitCode).toBe(0);
        const row = JSON.parse(status.stdout.trim().split("\n").at(-1) ?? "{}") as { runId?: string; state?: string };
        expect(row.runId).toBe(runId);
        const state = row.state ?? "";
        seenStates.push(state);
        if (SETTLED_STATES.has(state)) {
          terminal = state;
          break;
        }
        // `running` is the only non-terminal state a healthy run passes
        // through. `unknown` is AC5's fail-CLOSED verdict (INV-IBOX-7) and is
        // NOT retried away here: it means the marker could not be read, and a
        // poll that keeps asking would only convert a diagnosable transport
        // fault into a timeout with no cause attached. It falls out of the loop
        // and fails the assertion below naming itself.
        if (state !== "running") break;

        // FAST-FAIL on a unit that has ALREADY TERMINATED, before sleeping.
        // `Type=simple` means systemd considers the unit started as soon as the
        // process is FORKED, so `fleet run` exits 0 for a run that refused a
        // millisecond later — HOME unset, an unreadable witness, a missing
        // catalog dir, AC6's replay refusal, a `qds-engine` that is not there.
        // Every one of those reads as `running` to this poll, which would then
        // burn its whole budget: ~25 minutes of paid box for a fault that was
        // knowable in the first second. A unit that has already exited non-zero
        // will never write a marker, so continuing to poll is provably
        // pointless — this is an early exit on a PROVEN-dead unit, not a
        // shorter timeout, and the ceiling and its remediation below are
        // untouched for the genuinely-still-walking case.
        //
        // `systemctl show` is a READ and needs no `sudo` (unlike the `start`
        // in `fleet run`), and it is bounded at 30 s rather than inheriting the
        // 120 s exec default: it reads three local properties and answers in
        // milliseconds, and it runs once per poll, so its ceiling is what the
        // budget audit at the foot of this file has to price.
        const unit = await ctx.driver.execTimed(
          vmName,
          ["systemctl", "show", runUnitName(runId), "-p", "ActiveState", "-p", "Result", "-p", "ExecMainStatus"],
          30_000,
        );
        const activeState = /ActiveState=(\S*)/.exec(unit.stdout)?.[1] ?? "";
        const result = /Result=(\S*)/.exec(unit.stdout)?.[1] ?? "";
        const mainStatus = /ExecMainStatus=(\S*)/.exec(unit.stdout)?.[1] ?? "";
        // Only POSITIVE failure evidence stops the loop. `inactive` + `success`
        // + 0 is emphatically NOT a failure and must not break here: the engine
        // writes the marker BEFORE it exits (pipeline-run.ts:2554, with the
        // run-end resident solicitation and `tracer.close()` after it), so a
        // poll that read the marker as absent moments before a clean exit is a
        // race the NEXT poll settles. Breaking on "the process is gone" would
        // turn that race into a red round on a run that succeeded.
        const unitDead =
          activeState === "failed" ||
          (activeState === "inactive" && (result !== "success" || mainStatus !== "0"));
        if (unitDead) {
          // The engine log is the whole diagnosis for a `Restart=no` unit that
          // refused, and it is read ONLY on this path — it costs the healthy
          // round nothing. Redacted before it reaches an error message: the
          // engine runs on the capped run key, this text lands in the test
          // output AND in the evidence file, and `writeEvidence`'s own secret
          // scrub THROWS on a hit — which would replace this diagnosis with a
          // scrub failure at the exact moment the diagnosis is the point.
          const tail = await ctx.driver.execTimed(
            vmName,
            ["sh", "-c", `tail -c 2000 ${shellQuote(engineLogBoxPath)} 2>&1`],
            30_000,
          );
          evidence.push({
            phase: "unit-dead",
            activeState,
            result,
            mainStatus,
            engineLogTail: redactSecrets(tail.stdout).slice(-2000),
          });
          throw new Error(
            [
              `${runUnitName(runId)} has already terminated after ${seenStates.length} status poll(s) and will never write a marker:`,
              `ActiveState=${activeState} Result=${result} ExecMainStatus=${mainStatus}.`,
              `Tail of ${engineLogBoxPath}: ${redactSecrets(tail.stdout).slice(-1200) || "(empty — the engine produced no log, so it refused before it opened one)"}`,
            ].join(" "),
          );
        }
        if (attempt < STATUS_POLL_ATTEMPTS) await new Promise((r) => setTimeout(r, STATUS_POLL_WAIT_MS));
      }
      evidence.push({ phase: "status-poll", seenStates, terminal, attempts: seenStates.length });
      // A throw rather than `expect(terminal).toBe("ok")`, and it is not a
      // stylistic preference: this is the assertion most likely to be the one a
      // live round dies on, and `expect` has no message argument — "expected
      // running to be ok" would say nothing about how many polls ran, which
      // verdicts they saw, or what each verdict means. The throw is HELD by the
      // catch below exactly as a failing `expect` would be, so cleanup and
      // `settleRun` are unaffected.
      if (terminal !== "ok") {
        throw new Error(
          [
            `in-box run did not settle to \`ok\` after ${seenStates.length} status poll(s) (states seen: ${seenStates.join(" → ") || "none"}).`,
            `\`running\` to the last poll means the engine is still walking or never wrote a marker — ssh the box and read \`systemctl status ${runUnitName(runId)}\` and ${home}/${runId}.engine.log.`,
            "`not-ok` means the engine settled and the run FAILED — the harvested journal names the phase.",
            "`unknown` is AC5's fail-closed verdict: the marker could not be read at all (box unreachable, or a marker present and unjudgeable).",
            "`live` means the marker was never asked for — the status driver exposed no `execTimed`, i.e. AC5 is unwired on this path.",
          ].join(" "),
        );
      }

      // ── 6. the SAME read, through the shared primitive, not the verb ──────
      // `readBoxFile` + `classifyMarkerRead` are the exact pair `fleet status`
      // and the fan-out race poller both go through (fanout-primitive.ts:807),
      // and DF1.10 AC5 requires them to SHARE the code rather than agree by
      // inspection. Calling them here against the real `ExeDevDriver` proves the
      // primitive itself reads a real marker off a real box over the real
      // transport — the verb above could have reported `ok` through any path.
      // Same deadline the verb defaults to, so this is the verb's own read.
      const verdict = classifyMarkerRead(
        await readBoxFile(ctx.driver, vmName, markerBoxPath, DEFAULT_PER_CALL_DEADLINE_MS),
      );
      evidence.push({ phase: "marker-read", markerBoxPath, kind: verdict.kind });
      expect(verdict.kind).toBe("settled");
      expect(verdict.kind === "settled" && verdict.ok).toBeTrue();

      // ── 7. AC4 — the durability split, by LITERAL name on both sides ──────
      // Every path below is a literal built from an exported constant, and NOT
      // ONE is a glob. That is the whole point of this step: AC4's claim is
      // "these named files survive a reboot and those named files do not", and
      // a `ls $HOME/*.jsonl`-shaped check that silently matches nothing would
      // report the claim as proven on a box where the engine wrote no journal
      // at all. The names come from `deriveInBoxArgv` (pipeline-run.ts:1658-59)
      // for the ext4 half and from `runMarkerPath()`/`runMarkerRoot()` for the
      // tmpfs half — the same two sources the engine and the harvest use. All
      // four were resolved once at step 2; nothing here re-spells one.
      const durablePaths = [journalBoxPath, engineLogBoxPath];
      const tmpfsPaths = [markerBoxPath, traceBoxPath];
      const probe = await ctx.driver.exec(vmName, [
        "sh",
        "-c",
        [
          `printf 'HOME_FS=%s\\n' "$(stat -f -c %T ${shellQuote(home)})"`,
          `printf 'RUN_FS=%s\\n' "$(stat -f -c %T ${shellQuote(runMarkerRoot())})"`,
          `for f in ${[...durablePaths, ...tmpfsPaths].map(shellQuote).join(" ")}; do`,
          `  if [ -f "$f" ]; then printf 'PRESENT %s\\n' "$f"; else printf 'MISSING %s\\n' "$f"; fi`,
          "done",
        ].join("\n"),
      ]);
      evidence.push({ phase: "durability-probe", exitCode: probe.exitCode, stdout: probe.stdout.trim().slice(0, 800) });
      expect(probe.exitCode).toBe(0);
      for (const p of [...durablePaths, ...tmpfsPaths]) expect(probe.stdout).toContain(`PRESENT ${p}`);
      // The durability CLAIM, not merely the placement: `$HOME` must be a
      // filesystem that survives a reboot and `/run` must be the one that does
      // not. Asserting the paths alone would still pass on an image that mounted
      // the login home on tmpfs, which is precisely the regression AC4's split
      // exists to prevent — the journal and the engine log are the audit
      // evidence INV-IBOX-8 requires to outlive the box.
      const homeFs = /HOME_FS=(\S+)/.exec(probe.stdout)?.[1] ?? "";
      const runFs = /RUN_FS=(\S+)/.exec(probe.stdout)?.[1] ?? "";
      evidence.push({ phase: "durability-fs", homeFs, runFs });
      expect(homeFs).not.toBe("tmpfs");
      expect(runFs).toBe("tmpfs");

      // ── 8. the harvest tar carries all of it off the box ─────────────────
      // `harvested: none` is the EXPECTED bundle outcome and is ASSERTED rather
      // than merely noted, because it is deterministic for this manifest and it
      // is the line that proves the bundle half RAN: the phases are `echo`/
      // `true`, so the sandbox branch gains no commits and `harvestRun` reports
      // none. Step E — the artifacts tar, which is the half this test is about
      // — runs regardless (harvest.ts:762, "not gated on commits"), and a
      // reader who later adds a committing phase to `t2.pipeline.json` should
      // be made to come back here rather than have this line quietly stop
      // meaning anything. The scratch clone is still required: the verb
      // hardcodes `gitCwd = process.cwd()` and inspects the branch from it.
      const hostRepo = await scratchClone(ctx.repoUrl, ctx.sha, workspace);
      const harvest = await runFleet(["harvest", runId, "--driver", "exedev", "--dir", recordsDir], {
        cwd: hostRepo,
        timeoutMs: 300_000,
      });
      evidence.push({
        phase: "harvest-verb",
        exitCode: harvest.exitCode,
        stdout: harvest.stdout.trim().slice(0, 300),
        stderrTail: harvest.stderr.trim().slice(-400),
      });
      expect(harvest.exitCode).toBe(0);
      expect(harvest.stdout).toContain("harvested: none");

      const artifactsDir = join(recordsDir, `${runId}-artifacts`);
      expect(existsSync(artifactsDir)).toBeTrue();
      // LITERAL entry names again, and the tar's own naming rules are why each
      // one is spelled the way it is (harvest.ts:96-154): the two `$HOME`
      // sources are stored runId-PREFIXED and flattened to their basenames, and
      // the two run-root sources keep their `journal/` and `trace/` prefixes
      // deliberately — flattening `trace/trace.db` would collide with the
      // checkout's own `trace.db` and make the host validator reject the WHOLE
      // archive. A glob here would match a differently-named entry and call the
      // collision rule proven while it was broken.
      const required = [
        join(artifactsDir, "journal", "final.json"),
        join(artifactsDir, "trace", "trace.db"),
        join(artifactsDir, `${runId}.journal.jsonl`),
        join(artifactsDir, `${runId}.engine.log`),
      ];
      const extracted = extractedFiles(artifactsDir);
      const missing = required.filter((p) => !existsSync(p));
      evidence.push({
        phase: "artifacts",
        artifactsDir,
        required,
        missing,
        extracted: extracted.map((p) => p.slice(artifactsDir.length + 1)),
      });
      expect(missing).toEqual([]);

      // The harvested journal is READ, not merely counted: its `resident` block
      // is the run's own statement about whether a resident was armed
      // (journal.ts:86-97 — the runner seeds `status: "disabled"` when none
      // was), and that statement is what makes the next assertion a fact rather
      // than a hope. An ARMED resident writes `$HOME/<runId>.resident.jsonl`
      // (resident.ts:349, sessionDir = dirname of the journal =
      // `$HOME`), so the tar must carry it; a DISABLED one writes no such file
      // and requiring it would be a live failure about a file that correctly
      // does not exist. The solicit prompt/reply pair is deliberately NOT
      // required: its name carries the resident's per-call sequence number, so
      // it is the one source in the whole inventory that harvest itself globs
      // — and a glob is what this step refuses to assert with.
      //
      // `JSON.parse` on a `.jsonl` name is correct, not a slip: `FileJournal`
      // persists ONE `JournalFile` object per run (journal.ts:79-98), and the
      // extension is a legacy of the name `deriveInBoxArgv` passes. The harvest
      // suite's own fixture writes it the same way (harvest.test.ts:1373).
      const journalFile = JSON.parse(readFileSync(join(artifactsDir, `${runId}.journal.jsonl`), "utf8")) as {
        ok?: boolean;
        resident?: { status?: string };
      };
      const residentStatus = journalFile.resident?.status ?? "(absent)";
      const residentSession = join(artifactsDir, `${runId}.resident.jsonl`);
      evidence.push({
        phase: "resident-artifacts",
        residentStatus,
        residentSessionPresent: existsSync(residentSession),
      });
      expect(journalFile.ok).toBe(true); // the same verdict the marker settled on
      // The block's PRESENCE is asserted, not tolerated. It is optional on the
      // journal type and a pipeline-runner GUARANTEE on a settled run
      // (journal.ts:86-97: the runner seeds it before the terminal marker can
      // exist, so "a settled pipeline run always carries it"), and step 5
      // already established that this run settled. Letting `(absent)` fall
      // through to a skipped branch would have been the soft assertion this
      // whole file exists to avoid — the run's own statement about the resident
      // is what makes the next line a fact instead of a hope.
      expect(residentStatus).not.toBe("(absent)");
      // An ARMED resident writes `$HOME/<runId>.resident.jsonl` (resident.ts
      // :349, sessionDir = the journal's own directory = `$HOME`), so the tar
      // must carry it. A `disabled` one writes no such file, and requiring it
      // there would be a live failure about a file that correctly does not
      // exist — which is why the run's own status decides, not this test.
      if (residentStatus !== "disabled") expect(existsSync(residentSession)).toBeTrue();

      // INV-IBOX-8's redaction half, over EVERY extracted byte rather than over
      // the files this test happened to name. The resident's own artifacts are
      // written through `redact()` and the engine log is teed from a redacting
      // stream, but the archive is the surface where a miss becomes permanent:
      // it is copied to the host and outlives the box and the key. `trace.db`
      // is scanned as bytes for the same reason — a prompt lands in a SQLite
      // row as plain text, and a text-only sweep would skip the one artifact
      // that stores the most of it.
      const leaked = extracted.filter((p) => readFileSync(p).includes(KEY_PREFIX));
      evidence.push({
        phase: "redaction-sweep",
        scanned: extracted.length,
        leaked: leaked.map((p) => p.slice(artifactsDir.length + 1)),
      });
      expect(leaked).toEqual([]);

      // ── 9. teardown: spend captured, key revoked, box gone ───────────────
      const teardown = await runFleet(["teardown", runId, "--driver", "exedev", "--dir", recordsDir], {
        cwd: hostRepo,
        timeoutMs: 300_000,
      });
      evidence.push({
        phase: "teardown-verb",
        exitCode: teardown.exitCode,
        stdout: teardown.stdout.trim().slice(0, 300),
        stderrTail: teardown.stderr.trim().slice(-400),
      });
      expect(teardown.exitCode).toBe(0);

      const closed = new RunRecordStore({ dir: recordsDir }).get(runId);
      expect(closed.closedAt ?? "").not.toBe("");
      // `toBeLessThanOrEqual` only, with no lower bound: the manifest's phases
      // spend nothing, and whether the resident's single solicitation lands a
      // priced row before capture is not this test's claim. What IS the claim is
      // that nothing outran the cap the mint imposed.
      expect(closed.spendMicroUsd ?? 0).toBeLessThanOrEqual(T2_CAP_MICRO_USD);
      evidence.push({ phase: "spend", capMicroUsd: T2_CAP_MICRO_USD, actualMicroUsd: closed.spendMicroUsd });

      expect(await listedKeyHashes()).not.toContain(closed.keyHash); // revoked + verified
      const after = (await ctx.driver.list()).map((b) => b.name);
      expect(after).not.toContain(vmName);
      evidence.push({ phase: "box-gone", ok: true });
    } catch (e) {
      outcome = "fail";
      // HELD, not thrown (EB3): the post-finally verdicts below must render on
      // the red path too — the failing run is the one most likely to leak.
      failure = e;
      evidence.push({ phase: "test-error", error: (e as Error).message });
    } finally {
      // F12: a dispatch that PROVISIONED and then refused emits a refusal
      // payload, not an ack, so `runId`/`vmName` above stay "" and this whole
      // block would skip every verb. Recover the ids from BOTH streams — the
      // refusal envelope's debug/teardown commands name the box.
      if (runId === "" || vmName === "") {
        const combined = `${dispatchOut}\n${dispatchErr}`;
        if (runId === "") runId = /qds-[0-9]{8}-[a-z0-9]{6}/.exec(combined)?.[0] ?? "";
        if (vmName === "") {
          vmName =
            /ssh ((?:qds|e2e)-[0-9]{8}-[a-z0-9]{6})\.exe\.xyz/.exec(combined)?.[1] ??
            /(?:teardown|rm) ((?:qds|e2e)-[0-9]{8}-[a-z0-9]{6})/.exec(combined)?.[1] ??
            "";
        }
        evidence.push({ phase: "finally-id-recovery", runId, vmName });
      }
      if (runId !== "" && workspace !== "") {
        // `teardownQuietly`, not a bare `runFleet` (F2): the 180 s ceiling
        // REJECTS, and an unguarded await lets that rejection escape this
        // `finally` at the await — skipping the box destroy on the very next
        // line, the leftover sweep, the evidence write and `settleRun` itself,
        // while replacing the body's held error with a teardown timeout.
        //
        // `--no-harvest`: the box may still be running an engine here (the body
        // can fail at any step, including mid-poll), and a cleanup path is not
        // where a second full harvest belongs — the body's own harvest is the
        // one this test makes claims about.
        const torn = await teardownQuietly(
          ["teardown", runId, "--driver", "exedev", "--dir", join(workspace, "runs"), "--no-harvest"],
          { timeoutMs: 180_000 },
          evidence,
          { at: "t2.2-cleanup", runId },
        );
        if (!torn.ok) destroyFailures.push(`${runId}: ${torn.error}`);
      }
      if (vmName !== "") {
        const destroyed = await destroyQuietly(ctx.driver, vmName, evidence);
        if (!destroyed.ok) destroyFailures.push(`${vmName}: ${destroyed.error}`);
      }
      // `fleetLeftovers` (P127/P128/R4): bounded-retry against the measured 25 s+
      // substrate destroy lag, a destroy of what this run owns before the
      // verdict, and another round's stray box demoted to a warning instead of a
      // red. It never throws — a failed listing comes back as `owned: undefined`,
      // which `fleetCleanupProblems` renders as the problem it is, and a local
      // catch would swallow exactly that.
      finalBoxes = (await fleetLeftovers(ctx.driver, [runId, vmName], evidence)).owned;
      // Built ABOVE the key verdict and in its own try: the write-mode
      // constructor runs `assertDirMode0700`/`chmodSync`,
      // `assertExclusiveCreateSupported()` and `cleanStaleTemps()`, and an
      // EPERM/EROFS from any of them would escape this `finally` at the
      // argument expression — discarding the box-leak verdict and skipping the
      // evidence write and `settleRun`.
      let recordStore: RunRecordStore | undefined;
      try {
        if (workspace !== "") recordStore = new RunRecordStore({ dir: join(workspace, "runs") });
      } catch (e) {
        evidence.push({ phase: "finally-store", ok: false, error: (e as Error).message });
      }
      // `hashesBefore` is ACCOUNT-WIDE, so a key minted between the two listings
      // by a CONCURRENT round lands in this run's delta and would be reported as
      // this run's leak — a false red the fallback revoke never clears, because
      // it only revokes THIS run's runIds. Attribute first: only the hash this
      // run's record names is provably ours, and the rest of the delta is folded
      // into the baseline and RECORDED as a warning.
      let keyBaseline: ReadonlySet<string> = hashesBefore;
      try {
        const ours = new Set<string>();
        try {
          const recorded = runId === "" ? undefined : recordStore?.get(runId).keyHash;
          if (recorded !== undefined && recorded !== "") ours.add(recorded);
        } catch {
          // unreadable/absent record — its hash stays unattributed, i.e. a warning
        }
        const foreign = [...(await listedKeyHashes())].filter((h) => !hashesBefore.has(h) && !ours.has(h));
        if (foreign.length > 0) {
          evidence.push({
            phase: "key-hash-delta-foreign",
            foreign,
            note: "in the account delta but NOT attributable to this run's record — WARNING only, does not fail this run",
          });
          keyBaseline = new Set([...hashesBefore, ...foreign]);
        }
      } catch (e) {
        // The attribution listing failed; fall back to the account-wide
        // baseline, which can only report MORE, never less — fail-closed.
        evidence.push({ phase: "key-hash-delta-foreign", ok: false, error: (e as Error).message });
      }
      keyProblems = await keyLeakProblems(
        keyBaseline,
        { driver: ctx.driver, store: recordStore, runIds: [runId] },
        evidence,
      );
      // `writeEvidenceQuietly` (F11): `writeEvidence` THROWS — the secret-scrub
      // refusal above all — and an uncaught throw here propagated out of this
      // `finally`, making `settleRun` below unreachable on exactly the run that
      // most needs it.
      writeEvidenceQuietly(
        "T2.2",
        "t2-2-in-box-engine",
        { test: "T2.2", outcome, runId, capMicroUsd: T2_CAP_MICRO_USD, evidenceDir: EVIDENCE_DIR, phases: evidence },
        destroyFailures,
      );
      if (workspace !== "") rmSync(workspace, { recursive: true, force: true });
    }

    // The post-`finally` verdict (EB3), in ONE place: `settleRun` fails a green
    // run on a cleanup problem, and on a RED one ATTACHES the problem to the
    // body's own error instead of throwing over the top of it.
    settleRun(failure, [...fleetCleanupProblems(destroyFailures, finalBoxes, evidence), ...keyProblems]);
  },
  // Budget audit, priced at DECLARED CEILINGS and not at typical latency — the
  // tier2-dispatch-engine shape, for its reason: a bun test-timeout abort is the
  // ONE path where the `finally` above does not execute, so it is the one path
  // that leaves a real box billing AND a minted key live.
  //
  //   dispatch verb      runFleet timeoutMs 1_200_000                  1 200 s
  //   in-box probes      3 × driver.exec at DEFAULT_EXEC_TIMEOUT_MS 120  360 s
  //                      (boxHome, manifest pair, durability probe)
  //   host-walk control  2 phase execs + 1 absence probe at 30 s each     90 s
  //                      + its readBoxFile (10) + one status verb (120)  130 s
  //                      (the G2 negative control in step 3b. Its execs are
  //                       bounded at 30 s rather than the 120 s default for
  //                       the same reason the unit probe below is: `echo` and
  //                       `true` answer in milliseconds, and the difference is
  //                       270 s on this line.)
  //   run verb           runFleet timeoutMs 180_000                      180 s
  //   status poll        10 × (runFleet 120 + unit probe 30 + 15 s wait) 1 650 s
  //                      (the unit probe is `systemctl show` at its OWN 30 s
  //                       ceiling, NOT the 120 s exec default — that choice is
  //                       what keeps this line from costing 1 200 s more. Its
  //                       engine-log tail runs only on the dead-unit path,
  //                       which throws, so it is never additive to this total.)
  //   readBoxFile        DEFAULT_PER_CALL_DEADLINE_MS 10_000              10 s
  //   scratchClone       one real clone of the pinned sha, allowance     180 s
  //   harvest verb       runFleet timeoutMs 300_000                      300 s
  //   artifacts + reads  local extraction reads and the byte sweep        10 s
  //   teardown verb      runFleet timeoutMs 300_000                      300 s
  //   post-teardown      listedKeyHashes + 1 control ls, allowance       240 s
  //                                                              body ────────
  //                                                                    4 650 s
  //   teardownQuietly    timeoutMs 180_000                               180 s
  //   destroyQuietly     1 control rm at 120                             120 s
  //   fleetLeftovers     5 × (control ls 120 + 8 s wait) + its destroy
  //                      pass + the confirming re-list                   880 s
  //   key attribution    one listedKeyHashes, allowance                  120 s
  //   keyLeakProblems    delta list + fallback revoke + recheck list     360 s
  //   evidence + rmSync  local                                            10 s
  //                                                           finally ────────
  //                                                                    1 670 s
  //                                                                   ────────
  //                                                                    6 320 s
  //
  // Hence 6 500 s. Every inner ceiling FIRING is safe — it rejects into the
  // catch and the `finally` still runs — so the fail-safe direction for this
  // number is UP: it is what a fully degraded round may consume before the one
  // abort that skips cleanup, not a target. WHOEVER RAISES AN INNER CEILING,
  // LENGTHENS THE POLL OR ADDS A CLEANUP STEP MUST RE-ADD IT HERE.
  //
  // The dead-unit fast-fail in step 5 does NOT lower this number, and the
  // arithmetic is why it had to be re-added rather than waved through: it only
  // ever shortens a run that was going to fail, while its probe adds a real
  // 30 s ceiling to each of the ten polls on the run that succeeds. Worst case
  // is what this line prices, so it went UP by 300 s.
  //
  // It went up a second time, by 200 s, when step 3b's negative control was
  // added. This is NOT the forbidden move of raising a ceiling to make a red
  // test green: no assertion here was failing on time, the file gained real
  // bounded work, and the number above is the arithmetic that work costs. The
  // per-step ceilings — which ARE what a timing shortcut would loosen — are
  // unchanged, and the control's own execs were bounded at 30 s to keep this
  // line as small as the work allows.
  6_500_000,
);
