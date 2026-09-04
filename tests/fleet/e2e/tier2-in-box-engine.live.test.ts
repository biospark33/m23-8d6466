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
 * run-end solicitation + 1 box.
 *
 * BOX TIME: one box, WORST CASE 6 900 s (115 min) — the runner ceiling at the
 * foot of this file, which is the arithmetic sum of every inner ceiling plus the
 * whole `finally`. This line used to read "1 box ≤ 1 h" while that ceiling was
 * 6 500 s, so a degraded round could bill nearly twice the approved hour behind
 * a header that said otherwise. A HEALTHY round finishes in minutes. Two of the
 * largest terms were cut (dispatch 1 200 s → 900 s, the status verb inside the
 * ten-attempt poll 120 s → 60 s) and the three AC6/startRun refusal legs DF1.10
 * made assertable were added; the audit at the foot of the file shows both.
 * Approve this file for one box at up to the runner ceiling, not for one hour.
 *
 * LIVE-ROUND RUNNER, READ THIS (L16). The whole file is ONE `test.todoIf`, so a
 * round that never selected this path reports a single `(todo)` line and a green
 * run — indistinguishable, in the summary, from a round that proved every claim
 * below. That is the established live-tier pattern, but this file's header says
 * it is now the ONLY non-fake proof of AC1/AC2/AC4/AC5/AC6, so "it silently
 * never ran" costs more here than for its siblings. The runner must name this
 * path EXPLICITLY and must check for the ABSENCE of its evidence JSON
 * (`_bmad-output/evidence/df3-e2e/<date>-t2-2-in-box-engine.json`) rather than
 * infer the run from a green summary.
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

// `BOX_MARKER_PATH` and NOT `runMarkerPath()` (DF1.10): the marker path a HOST
// process ships into the box is now a host-side LITERAL built from
// `harvest.ts`'s `BOX_RUN_ROOT`, precisely so an ambient `QDS_RUN_ROOT` in an
// operator's shell cannot redirect a box probe. `fleet status` reads the same
// constant, so this file and the verb it checks address one path by
// construction rather than by both happening to read the same env var.
import { BOX_MARKER_PATH, classifyMarkerRead, DEFAULT_PER_CALL_DEADLINE_MS } from "../../../src/fleet/fanout-primitive.ts";
// The systemd instance name, from the ONE place that builds it — so the
// remediation this test prints names the unit `fleet run` actually started.
import { runUnitName } from "../../../src/fleet/run.ts";
// The in-box layout, imported rather than re-spelled. `QDS_IN_BOX_DIR` and
// `DEFAULT_FILL_WORKDIR` are the two constants `dispatch.ts:2839` builds the
// delivered manifest pair's path from; `BOX_RUN_ROOT` is the in-box tmpfs root
// the engine, `fleet status` and the harvest all address.
import { DEFAULT_FILL_WORKDIR, QDS_IN_BOX_DIR } from "../../../src/providers/exedev/fill.ts";
import { readBoxFile } from "../../../src/providers/exedev/transport.ts";
import { BOX_RUN_ROOT } from "../../../src/providers/harvest.ts";
import { RunRecordStore } from "../../../src/providers/run-record.ts";
// The repo's own redactor, for the engine-log tail the fast-fail quotes: it is
// box-authored text on the capped run key heading for an error message and the
// evidence file. Producer-side, exactly as `src/fleet/run.ts` treats stderr.
import { redactSecrets } from "../../../src/providers/step-log.ts";
import {
  EVIDENCE_DIR,
  REPO_ROOT,
  awaitBoxAbsent,
  boxHome,
  destroyQuietly,
  emittedRunId,
  fleetCleanupProblems,
  fleetLeftovers,
  fleetPartialOutput,
  keyLeakProblems,
  lastJsonLine,
  listedKeyHashes,
  liveGate,
  liveTodoOff,
  preflight,
  recoverDispatchIds,
  runFleet,
  scratchClone,
  secretHitsIn,
  settleRun,
  shellQuote,
  statusStateSettled,
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

/**
 * The `status` verb's own ceiling inside the poll (L12). 60 s, down from
 * 120 s: one `status <runId>` is one substrate listing plus a marker read
 * bounded at `DEFAULT_PER_CALL_DEADLINE_MS` (10 s) plus a unit probe sharing
 * that same deadline — several times over on a healthy box. Cut because it is
 * multiplied by ten in the budget audit at the foot of this file, and that
 * audit is what decides whether a degraded round can reach the ONE abort path
 * that skips the `finally` and leaks a box.
 */
const STATUS_VERB_TIMEOUT_MS = 60_000;

/**
 * The dispatch ceiling. 900 000, down from 1 200 000 — the figure
 * tier4-resident measured for the SAME verb (box provision + the A–E setup
 * gate, C/D being real roster-model pings) and priced its own budget at. Same
 * reason as above: this is the single largest term in the audit.
 */
const T2_DISPATCH_TIMEOUT_MS = 900_000;

/**
 * How many times step 7b re-reads the engine log for the replay refusal.
 * `fleet run` returns at the FORK, so the refusal line may not be flushed the
 * instant the verb exits; 4 × 5 s of spacing is a wide margin on a refusal that
 * happens before `loadManifest`'s successor even constructs a journal, and it
 * is bounded because every attempt is a 30 s ssh ceiling in the budget audit.
 */
const REPLAY_LOG_ATTEMPTS = 4;

/** AC5's terminal in-box verdicts: the poll stops on either, and asserts after. */
const SETTLED_STATES: ReadonlySet<string> = new Set(["ok", "not-ok"]);

/**
 * The AC5 states that mean "no marker yet", post-DF1.10 — the ONLY ones the
 * poll may keep going on.
 *
 * `absent` used to collapse to `running`; it is now corroborated by
 * `systemctl is-active` on the run's unit and maps to `running` (active),
 * `engine-failed` (failed) or `not-running` (inactive). All three are absent
 * markers, and none of them may end the poll on its own:
 *
 *  - `not-running` is a BENIGN RACE on a healthy run. The engine writes the
 *    marker and then exits, so a poll whose marker read landed microseconds
 *    before the write sees an absent marker and an already-inactive unit. The
 *    next tick settles it, and the dead-unit probe below is what tells that
 *    apart from a real death (it demands POSITIVE failure evidence).
 *  - `engine-failed` is a real death, and the probe below diagnoses it far
 *    better than an early `break` would — it reads the engine log and throws
 *    with the tail attached, so the loop must reach it.
 *
 * `unknown` is deliberately NOT here: it is AC5's fail-CLOSED verdict for a
 * marker that could not be read at all, and retrying it would convert a
 * diagnosable transport fault into a timeout with no cause attached.
 */
const POLLABLE_STATES: ReadonlySet<string> = new Set(["running", "not-running", "engine-failed"]);

/**
 * How many non-zero `bun scripts/fleet.ts status` exits the poll tolerates
 * before giving up (L14). A single flaky subprocess used to end the round on a
 * run that was healthy and already paid for; a persistent one still fails,
 * because the poll can never reach a terminal verdict without a readable row.
 */
const STATUS_EXIT_TOLERANCE = 3;

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
    // REFUSED BEFORE ANY SPEND. This guard used to be load-bearing — every
    // in-box marker path in this file, and the one `fleet status` derived, came
    // from `runMarkerPath()`, which reads `QDS_RUN_ROOT` off THIS process's
    // environment (journal.ts) — so a stray host export pointed both probes at a
    // path the box does not have, `test -f` exited 1, `classifyMarkerRead` read
    // that as a CLEAN MISS, and the run polled `running` to its ceiling on a
    // paid box while the real marker sat unread.
    //
    // DF1.10 removed that coupling at the source: the host side now addresses
    // the box through the `BOX_MARKER_PATH`/`BOX_RUN_ROOT` LITERALS (imported
    // above), which no environment variable can move, and this file uses them
    // too. The refusal is kept as a belt-and-braces tripwire rather than deleted
    // — the variable is still honoured by `runMarkerRoot()` at runtime, the box
    // image is scanned to make sure it never sets it, and a live round that
    // inherited one from a `pipeline-run.ts` debugging session is a shell this
    // suite should not be paid to run in. It costs nothing: it fires before
    // `preflight` has touched the substrate.
    const hostRunRoot = (process.env.QDS_RUN_ROOT ?? "").trim();
    if (hostRunRoot !== "") {
      throw new Error(
        `QDS_RUN_ROOT is exported host-side as ${JSON.stringify(hostRunRoot)}. It is a HOST-side test lever (journal.ts) that the box never sets, and no live round should inherit one — unset it and re-run. (Since DF1.10 this file and \`fleet status\` both address the box through the BOX_MARKER_PATH literal, so the variable can no longer redirect a probe; this refusal is the tripwire for a shell that should not be running a paid round.)`,
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
      // The `.catch` is the L1 fix and it is the whole reason this verb is not
      // a bare `await`. `runFleet`'s ceiling REJECTS, so the two assignments
      // below never ran on that path — and `dispatch` is precisely the verb
      // that creates a real box before it can still fail. Both streams stayed
      // `""`, the `finally`'s id recovery scanned an empty string, `runId` and
      // `vmName` stayed `""`, every guarded teardown/destroy leg was skipped,
      // and `fleetLeftovers` could not match a box it had not been told this
      // run owned — so a genuine leak was reported as another round's stray and
      // left billing. `fleetPartialOutput` hands back whatever the killed child
      // had already written, which is where the box's name is.
      const dispatch = await runFleet(
        ["dispatch", "--driver", "exedev", "--brief", briefPath, "--dir", recordsDir],
        { cwd: REPO_ROOT, timeoutMs: T2_DISPATCH_TIMEOUT_MS },
      ).catch((e: unknown) => {
        const partial = fleetPartialOutput(e);
        dispatchOut = partial.stdout;
        dispatchErr = partial.stderr;
        evidence.push({
          phase: "dispatch-verb-timeout",
          error: (e as Error).message,
          recoveredBytes: partial.stdout.length + partial.stderr.length,
        });
        throw e;
      });
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
      const home = await boxHome(ctx.driver, vmName);
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
      // The BOX's paths, from the host-side literals — never `runMarkerPath()`,
      // which answers "where would THIS process write a marker" and is
      // relocatable by `QDS_RUN_ROOT`. `fleet status` reads `BOX_MARKER_PATH`
      // too, so this file and the verb it checks cannot address different files.
      const markerBoxPath = BOX_MARKER_PATH;
      const traceBoxPath = `${BOX_RUN_ROOT}/trace/trace.db`;
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
      // The runId rides the classification (L5): `classifyMarkerRead`'s
      // `expectedRunId` is what makes an absence THIS run's absence rather than
      // any absence — see step 6, where the same argument does the heavier work.
      const hostWalkMarker = classifyMarkerRead(
        await readBoxFile(ctx.driver, vmName, markerBoxPath, DEFAULT_PER_CALL_DEADLINE_MS),
        runId,
      );
      const hostWalkStatus = await statusStateSettled(runId, recordsDir, evidence, {
        attempts: 3,
        timeoutMs: STATUS_VERB_TIMEOUT_MS,
      });
      evidence.push({
        phase: "host-walk-negative-control",
        walked: hostWalkOutput,
        probe: afterHostWalk.stdout.trim(),
        markerKind: hostWalkMarker.kind,
        statusState: hostWalkStatus.state,
      });
      // PER PATH (L15), not one blanket `not.toContain("PRESENT")`. That form
      // failed identically whichever of marker/journal/engine-log/trace.db
      // existed, so its message named nothing — and it is the assertion most
      // exposed to an image or `fill` change that pre-creates `/run/trace/`.
      for (const p of [markerBoxPath, journalBoxPath, engineLogBoxPath, traceBoxPath]) {
        expect(afterHostWalk.stdout).not.toContain(`PRESENT ${p}`);
      }
      expect(hostWalkMarker.kind).toBe("absent");
      // `not-running`, NOT `running` — DF1.10 changed this answer and the
      // change makes the control STRONGER. An absent marker is now corroborated
      // by `systemctl is-active qds-run@<runId>.service`, and `fleet run` has
      // not been invoked yet, so systemd has never loaded the instance and
      // answers `inactive` ⇒ `not-running`. The claim this step makes is
      // therefore now explicit rather than inferred: the host executed every
      // phase body it could, and the box has NO ENGINE RUNNING — a host that
      // walks a manifest still cannot produce the run's verdict.
      expect(hostWalkStatus.state).toBe("not-running");

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
      let statusExitFailures = 0;
      for (let attempt = 1; attempt <= STATUS_POLL_ATTEMPTS; attempt += 1) {
        const status = await runFleet(["status", runId, "--driver", "exedev", "--dir", recordsDir], {
          timeoutMs: STATUS_VERB_TIMEOUT_MS,
        });
        // TOLERATED, up to a bound (L14). `expect(status.exitCode).toBe(0)`
        // inside the poll body ended the round on ONE flaky `bun
        // scripts/fleet.ts status` against a run that was healthy and already
        // paid for. A persistent failure still fails — the poll cannot reach a
        // terminal verdict without a readable row — but it fails at the
        // assertion below, which names what it saw.
        if (status.exitCode !== 0) {
          statusExitFailures += 1;
          seenStates.push(`(status exit ${String(status.exitCode)})`);
          evidence.push({
            phase: "status-verb-failed",
            attempt,
            exitCode: status.exitCode,
            tolerated: statusExitFailures <= STATUS_EXIT_TOLERANCE,
            stderrTail: status.stderr.trim().slice(-300),
          });
          if (statusExitFailures > STATUS_EXIT_TOLERANCE) break;
          if (attempt < STATUS_POLL_ATTEMPTS) await new Promise((r) => setTimeout(r, STATUS_POLL_WAIT_MS));
          continue;
        }
        const row = lastJsonLine<{ runId?: string; state?: string }>(status.stdout);
        expect(row.runId).toBe(runId);
        const state = row.state ?? "";
        seenStates.push(state);
        if (SETTLED_STATES.has(state)) {
          terminal = state;
          break;
        }
        // The three "no marker yet" readings keep the poll going; anything else
        // ends it. See POLLABLE_STATES for why `not-running` and `engine-failed`
        // are among them post-DF1.10 (a benign write/exit race, and a death the
        // probe below diagnoses far better than an early break would) and why
        // `unknown` is not (AC5's fail-CLOSED verdict, which retrying would turn
        // into a timeout with no cause attached).
        if (!POLLABLE_STATES.has(state)) break;

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
        //
        // GUARDED (L4). This is a DIAGNOSTIC whose only job is to shorten an
        // already-doomed run, and it was an unguarded `await` inside the poll:
        // one transient ssh failure or a 30 s overrun rejected out of the loop
        // into the outer catch and failed the whole paid round. A probe that
        // cannot answer is no evidence of failure — recorded, and the poll
        // continues to its own ceiling exactly as it would without it.
        let unitStdout = "";
        try {
          unitStdout = (
            await ctx.driver.execTimed(
              vmName,
              ["systemctl", "show", runUnitName(runId), "-p", "ActiveState", "-p", "Result", "-p", "ExecMainStatus"],
              30_000,
            )
          ).stdout;
        } catch (probeError) {
          evidence.push({
            phase: "unit-probe-failed",
            attempt,
            note: "diagnostic only — the poll continues; a probe that did not answer is not evidence of a dead unit",
            error: probeError instanceof Error ? probeError.message : String(probeError),
          });
        }
        const activeState = /ActiveState=(\S*)/.exec(unitStdout)?.[1] ?? "";
        const result = /Result=(\S*)/.exec(unitStdout)?.[1] ?? "";
        const mainStatus = /ExecMainStatus=(\S*)/.exec(unitStdout)?.[1] ?? "";
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
          // Guarded like the probe above and for the same reason: an exec that
          // throws here would REPLACE the diagnosis with a transport error at
          // the exact moment the diagnosis is the whole point.
          let tailText = "";
          try {
            tailText = (
              await ctx.driver.execTimed(
                vmName,
                ["sh", "-c", `tail -c 2000 ${shellQuote(engineLogBoxPath)} 2>&1`],
                30_000,
              )
            ).stdout;
          } catch (tailError) {
            tailText = `(engine-log read failed: ${tailError instanceof Error ? tailError.message : String(tailError)})`;
          }
          const tail = { stdout: tailText };
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
      evidence.push({ phase: "status-poll", seenStates, terminal, attempts: seenStates.length, statusExitFailures });
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
            `in-box run did not settle to \`ok\` after ${seenStates.length} status poll(s) (states seen: ${seenStates.join(" → ") || "none"}; ${statusExitFailures} status verb invocation(s) exited non-zero).`,
            `\`running\` to the last poll means the engine is still walking — ssh the box and read \`systemctl status ${runUnitName(runId)}\` and ${home}/${runId}.engine.log.`,
            "`not-ok` means the engine settled and the run FAILED — the harvested journal names the phase.",
            "`not-running` to the last poll means no marker AND the unit is `inactive`: the engine exited without settling, or `fleet run` never reached it. It is also the benign one-tick race between the marker write and the exit, which is why the poll rides through it.",
            "`engine-failed` means no marker and the unit is `failed` — the dead-unit probe should have thrown first with the engine-log tail; reaching this line instead means the probe itself could not answer.",
            "`unknown` is AC5's fail-closed verdict: neither the marker read nor the unit probe answered (box unreachable, or a marker present and unjudgeable).",
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
      //
      // `runId` IS PASSED (L5), and it is the assertion this step was missing.
      // The marker path is one per box, not one per run (`/run/journal/
      // final.json` for every runId), and the payload carries the runId of the
      // engine that wrote it — so a marker written by ANY other run on this box
      // read as THIS run settling ok, and nothing here would have said
      // otherwise. `classifyMarkerRead`'s `expectedRunId` is the check, it is
      // free, and it is exactly what DF1.10 wired into `fleet status` and into
      // the engine's own `ENGINE_MARKER_FOREIGN` refusal. A foreign marker now
      // classifies `unusable`, so the two assertions below both fail and the
      // verdict's own code names the run the marker belongs to.
      const verdict = classifyMarkerRead(
        await readBoxFile(ctx.driver, vmName, markerBoxPath, DEFAULT_PER_CALL_DEADLINE_MS),
        runId,
      );
      evidence.push({
        phase: "marker-read",
        markerBoxPath,
        expectedRunId: runId,
        kind: verdict.kind,
        ...(verdict.kind === "unusable" || verdict.kind === "skip" ? { code: verdict.code } : {}),
      });
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
          `printf 'RUN_FS=%s\\n' "$(stat -f -c %T ${shellQuote(BOX_RUN_ROOT)})"`,
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
      // AC4's OTHER half, read off the unit rather than assumed (L6). The whole
      // durability argument — "a reboot wipes /run, and with `Restart=no` and no
      // `[Install]` the engine does not come back, so an absent marker is
      // permanent and the journal on ext4 is the only surviving record" — rests
      // on this one directive, and until now nothing in the live tree read it.
      // An image regression to `Restart=always` would silently re-walk a
      // finished run after every reboot and pass every other assertion here.
      // `systemctl show` is a READ and needs no sudo.
      const restart = await ctx.driver.execTimed(vmName, ["systemctl", "show", runUnitName(runId), "-p", "Restart"], 30_000);
      evidence.push({ phase: "unit-restart", stdout: restart.stdout.trim(), exitCode: restart.exitCode });
      expect(restart.exitCode).toBe(0);
      expect(restart.stdout.trim()).toBe("Restart=no");

      // ── 7b. AC6 — the REPLAY refusal, live (L7) ──────────────────────────
      // The file's own header calls it "the only non-fake proof of AC1", and
      // AC6's replay guard was proven by fakes alone: the negative half of the
      // `run` verb existed only in the comments at step 5. It costs no box and
      // no spend — the run is settled, the box is up, and the engine refuses
      // before `new FileJournal` can touch anything.
      //
      // The SHAPE, worked out from source rather than guessed:
      //  - `startRun` finds no approval state, no `closedAt`, no failed gate and
      //    a `vmName`, so it issues a second `systemctl start`. The unit is
      //    `inactive`/`success` after the first run, so systemd re-execs it and
      //    the post-start `is-active` probe sees nothing `failed` — `fleet run`
      //    exits 0 and prints `started:` again. That is CORRECT and is the point
      //    of the next assertion: idempotence lives in the ENGINE, not the verb.
      //  - the second engine reaches `markerReplayRefusal` before the correlation
      //    ladder and before any journal is constructed. This run's marker is
      //    present and names this run with `ok: true`, so it MIRRORS it:
      //    `ENGINE_MARKER_PRESENT`, exit 0, one `engine_refused_replay` event.
      //    `ENGINE_MARKER_FOREIGN` is the sibling arm and is not what fires here
      //    — the marker is ours, which step 6 just proved by runId.
      //  - the engine log is opened `O_APPEND`, so the refusal is APPENDED to
      //    the first run's log and rides the harvest tar below.
      //
      // The journal is re-read afterwards to pin the property that matters:
      // nothing was re-walked and no phase row was overwritten (INV-IBOX-6).
      const journalBeforeReplay = await ctx.driver.execTimed(
        vmName,
        ["sh", "-c", `cat ${shellQuote(journalBoxPath)}`],
        30_000,
      );
      expect(journalBeforeReplay.exitCode).toBe(0);
      const replay = await runFleet(["run", runId, "--driver", "exedev", "--dir", recordsDir], {
        cwd: REPO_ROOT,
        timeoutMs: 180_000,
      });
      evidence.push({
        phase: "replay-run-verb",
        exitCode: replay.exitCode,
        stdout: replay.stdout.trim().slice(0, 300),
        stderrTail: replay.stderr.trim().slice(-400),
      });
      expect(replay.exitCode).toBe(0);
      expect(replay.stdout).toContain(`started: ${runId}`);
      // The refusal is the ENGINE's, so it is read where the engine writes it.
      // Polled, briefly: `fleet run` returns at the fork, so the refusal line
      // may not be flushed the instant the verb exits.
      let replayLine = "";
      for (let attempt = 1; attempt <= REPLAY_LOG_ATTEMPTS && replayLine === ""; attempt += 1) {
        const logTail = await ctx.driver.execTimed(
          vmName,
          ["sh", "-c", `tail -c 4000 ${shellQuote(engineLogBoxPath)} 2>&1`],
          30_000,
        );
        replayLine =
          logTail.stdout
            .split("\n")
            .filter((l) => l.includes('"engine_refused_replay"'))
            .at(-1) ?? "";
        if (replayLine === "" && attempt < REPLAY_LOG_ATTEMPTS) await new Promise((r) => setTimeout(r, 5_000));
      }
      // Guarded parse: `tail -c` cuts from the START, so the LAST match is
      // whole — but a log whose only match happens to sit at the cut would
      // otherwise throw a SyntaxError here and hide the real assertion.
      let replayEvent: { event?: string; runId?: string; exitCode?: number; error?: { code?: string } } = {};
      try {
        if (replayLine !== "") replayEvent = JSON.parse(replayLine) as typeof replayEvent;
      } catch (parseError) {
        evidence.push({
          phase: "replay-refusal-unparseable",
          line: replayLine.slice(-300),
          error: parseError instanceof Error ? parseError.message : String(parseError),
        });
      }
      evidence.push({
        phase: "replay-refusal",
        found: replayLine !== "",
        event: replayEvent.event,
        code: replayEvent.error?.code,
        exitCode: replayEvent.exitCode,
      });
      expect(replayEvent.event).toBe("engine_refused_replay");
      expect(replayEvent.runId).toBe(runId);
      // `ENGINE_MARKER_PRESENT` mirroring an `ok:true` marker — exit 0, because
      // "the work you asked for is already done, and it succeeded" is not a
      // failure and exit 2 has to keep meaning "genuinely could not settle".
      expect(replayEvent.error?.code).toBe("ENGINE_MARKER_PRESENT");
      expect(replayEvent.exitCode).toBe(0);
      // INV-IBOX-6: the refusal precedes `new FileJournal`, so not one byte of
      // the first run's phase rows moved.
      const journalAfterReplay = await ctx.driver.execTimed(
        vmName,
        ["sh", "-c", `cat ${shellQuote(journalBoxPath)}`],
        30_000,
      );
      expect(journalAfterReplay.exitCode).toBe(0);
      expect(journalAfterReplay.stdout).toBe(journalBeforeReplay.stdout);
      evidence.push({ phase: "replay-journal-untouched", ok: true, bytes: journalAfterReplay.stdout.length });

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
      const relative = extracted.map((p) => p.slice(artifactsDir.length + 1));
      evidence.push({ phase: "artifacts", artifactsDir, required, missing, extracted: relative });
      expect(missing).toEqual([]);
      // `trace/trace.db-shm` is ABSENT, and its absence is load-bearing rather
      // than incidental (harvest.ts): the box runs a best-effort
      // `wal_checkpoint(TRUNCATE)` before tarring and the `-shm` is a shared-
      // memory index that is meaningless off its own machine — carrying it makes
      // a host-side reader open a database against a foreign index. `-wal` IS
      // still carried (the marker does not imply a checkpointed DB), so it is
      // deliberately not asserted either way. Asserted here so the day someone
      // re-adds `-shm` to the source list, a live round says so.
      expect(relative).not.toContain(join("trace", "trace.db-shm"));

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
      //
      // ALL of the harness's credential shapes (L10), not just `sk-or-`. The
      // sweep used to know exactly one, while `writeEvidence`'s own scrub
      // already covered three — and the gap is not theoretical: a git token in
      // `QDS_EXEDEV_REPO_URL` (`ghp_…`, `github_pat_…`, or a
      // `https://user:pass@…` userinfo) reaches the box on the fill, can land in
      // the engine log, and rides off in this tar past both checks.
      // `secretHitsIn` returns pattern NAMES, never matched bytes, so the
      // failure message cannot compound the leak it is reporting.
      const leaked = extracted
        .map((p) => ({ path: p.slice(artifactsDir.length + 1), hits: secretHitsIn(readFileSync(p)) }))
        .filter((e) => e.hits.length > 0);
      evidence.push({ phase: "redaction-sweep", scanned: extracted.length, leaked });
      expect(leaked).toEqual([]);

      // ── 8b. AC6's DURABLE half: the orphaned journal refusal (L6) ────────
      // AC4's claim is "`/run` is wiped and `$HOME` survives", and step 7 proves
      // only the filesystem TYPES. This proves the BEHAVIOUR the split exists
      // for: with the tmpfs marker gone and the ext4 journal still carrying its
      // phase rows, a re-run must refuse rather than re-walk phases whose spend
      // and commits already happened (INV-IBOX-6).
      //
      // The wipe is SIMULATED by removing the marker, not caused by a reboot,
      // and the difference is stated rather than glossed: a reboot would also
      // prove `$HOME` survives one, which this does not. It is what a reboot
      // leaves BEHIND that AC6's guard reads, and that state is reproducible
      // without spending the round on an unbounded ssh reconnect window on a
      // paid box. The reboot leg is left to whoever owns the round.
      //
      // Runs AFTER the harvest deliberately: step 8's tar must carry the marker.
      // Setup failure is RECORDED AND SKIPPED, never fatal — the marker dir is
      // the engine user's and this should work, but a bonus regression detector
      // must not turn a green paid round red for a `rm`.
      const wipe = await ctx.driver.execTimed(vmName, ["sh", "-c", `rm -f ${shellQuote(markerBoxPath)}`], 30_000);
      evidence.push({ phase: "tmpfs-wipe-simulated", exitCode: wipe.exitCode, markerBoxPath, stderrTail: wipe.stderr.trim().slice(-200) });
      if (wipe.exitCode !== 0) {
        evidence.push({
          phase: "orphaned-replay",
          skipped: true,
          note: "the marker could not be removed, so AC6's durable-half refusal was not exercised this round — see the operator checklist",
        });
      } else {
        // `fleet run` again. The engine now finds NO marker and a journal with
        // phase rows ⇒ `ENGINE_JOURNAL_ORPHANED`, exit 2 ⇒ `Restart=no` leaves
        // the unit `failed` ⇒ `startRun`'s post-start `is-active` probe reads
        // `failed` ⇒ `start-failed {reason:"unit-refused"}` with NO `exitCode`
        // (systemd's own start job returned 0) ⇒ the CLI maps it to
        // `engine-start-refused` and exit 5, NOT 1: the identical retry produces
        // the identical failure, so "retry me" would be a lie. That probe and
        // that refusal are both DF1.10; before it, this path printed `started`
        // and exited 0 while nothing ran.
        const orphan = await runFleet(["run", runId, "--driver", "exedev", "--dir", recordsDir], {
          cwd: REPO_ROOT,
          timeoutMs: 180_000,
        });
        const orphanEnv = orphan.stderr
          .split("\n")
          .filter((l) => l.startsWith("{"))
          .flatMap((l) => {
            try {
              return [JSON.parse(l) as Record<string, unknown>];
            } catch {
              return [];
            }
          })
          .find((l) => l.code === "engine-start-refused");
        evidence.push({
          phase: "orphaned-replay",
          exitCode: orphan.exitCode,
          envelope: orphanEnv ?? null,
          stderrTail: orphan.stderr.trim().slice(-600),
        });
        expect(orphan.exitCode).toBe(5);
        expect(orphan.stdout).not.toContain(`started: ${runId}`);
        expect(orphanEnv).toMatchObject({ runId, unit: runUnitName(runId), reason: "unit-refused" });
        // The engine's own words, in the log the harvest already carried once —
        // this second refusal appends to it, so a re-harvest would show both.
        const orphanLog = await ctx.driver.execTimed(
          vmName,
          ["sh", "-c", `tail -c 4000 ${shellQuote(engineLogBoxPath)} 2>&1`],
          30_000,
        );
        evidence.push({ phase: "orphaned-engine-log", tail: redactSecrets(orphanLog.stdout).slice(-800) });
        expect(orphanLog.stdout).toContain("ENGINE_JOURNAL_ORPHANED");
      }

      // ── 9. teardown: spend captured, key revoked, box gone ───────────────
      // `--no-harvest` (L11): step 8's harvest is the one this test makes claims
      // about, and it already extracted into `${runId}-artifacts`. Without this
      // flag, `expect(teardown.exitCode).toBe(0)` silently required a SECOND
      // extraction into an already-populated directory to be idempotent — a
      // property nothing states and nothing tests. The cleanup teardown in the
      // `finally` passes it for its own (different) reason and says so there.
      const teardown = await runFleet(["teardown", runId, "--driver", "exedev", "--dir", recordsDir, "--no-harvest"], {
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
      // TYPE FIRST, then the ceiling (L9). `closed.spendMicroUsd ?? 0` folds
      // "capture is broken and wrote nothing" into "the run spent nothing", and
      // those are opposite facts: the second is this manifest's expected outcome
      // and the first is a defect in the one number the money verdict rests on.
      expect(typeof closed.spendMicroUsd).toBe("number");
      // `toBeLessThanOrEqual` only, with no lower bound: the manifest's phases
      // spend nothing, and whether the resident's single solicitation lands a
      // priced row before capture is not this test's claim. What IS the claim is
      // that nothing outran the cap the mint imposed.
      expect(closed.spendMicroUsd ?? 0).toBeLessThanOrEqual(T2_CAP_MICRO_USD);
      evidence.push({ phase: "spend", capMicroUsd: T2_CAP_MICRO_USD, actualMicroUsd: closed.spendMicroUsd });

      expect(await listedKeyHashes()).not.toContain(closed.keyHash); // revoked + verified
      // POLLED, not a single `driver.list()` (L3). exe.dev's destroy lag is
      // MEASURED at 25 s+ — `rm` exits 0 while the box stays listed — which is
      // the entire reason `fleetLeftovers` polls. Listing once, milliseconds
      // after `teardown` returned, turned substrate lag into a red round on the
      // most expensive test in the tree. `awaitBoxAbsent` only LOOKS; unlike
      // `fleetLeftovers` it does not destroy a survivor first, so it cannot
      // report clean for a teardown that never destroyed anything.
      const gone = await awaitBoxAbsent(ctx.driver, vmName, evidence, { maxAttempts: 4, retryDelayMs: 10_000 });
      expect(gone.absent).toBeTrue();

      // ── 9b. `fleet run` on a run that is OVER, and on one that never was ──
      // Both are free (no box, no spend) and both are `startRun` guards that had
      // no live coverage at all. The record is now `closedAt`, so the refusal is
      // `run-not-startable {state:"closed"}` → exit 5, decided BEFORE any exec.
      const startClosed = await runFleet(["run", runId, "--driver", "exedev", "--dir", recordsDir], {
        cwd: REPO_ROOT,
        timeoutMs: 60_000,
      });
      evidence.push({ phase: "run-after-teardown", exitCode: startClosed.exitCode, stderrTail: startClosed.stderr.trim().slice(-400) });
      expect(startClosed.exitCode).toBe(5);
      expect(startClosed.stderr).toContain("run-not-startable");
      // An id this records dir has never heard of: `assertRunExists` refuses
      // with exit 4 ("no such run"), which is a DIFFERENT code from 5 on
      // purpose — an operator retrying a typo must not read the same word as an
      // operator retrying a torn-down run.
      const unknownRunId = `${runId}-nope`;
      const startUnknown = await runFleet(["run", unknownRunId, "--driver", "exedev", "--dir", recordsDir], {
        cwd: REPO_ROOT,
        timeoutMs: 60_000,
      });
      evidence.push({ phase: "run-unknown-id", exitCode: startUnknown.exitCode, stderrTail: startUnknown.stderr.trim().slice(-300) });
      expect(startUnknown.exitCode).toBe(4);
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
      //
      // Through `recoverDispatchIds` (L13): the inline copy here used
      // `qds-[0-9]{8}-[a-z0-9]{6}` while `emittedRunId` matched
      // `qds-[a-z0-9-]+`, so an id satisfying one and not the other was
      // recovered on the ACK path and not on this one — the only path the
      // fallback exists for. One exported grammar, both callers.
      if (runId === "" || vmName === "") {
        const recovered = recoverDispatchIds(dispatchOut, dispatchErr);
        if (runId === "") runId = recovered.runId;
        if (vmName === "") vmName = recovered.vmName;
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
      //
      // …AND THE FOLD IS GATED ON THE ATTRIBUTION SUCCEEDING (L2). The widening
      // is only sound while this run's OWN hash has been identified and
      // excluded. When `runId` is `""` (the L1 path — a dispatch that made a box
      // and then timed out) or the record is unreadable, `ours` is EMPTY, so
      // this run's freshly-minted, still-live capped key lands in `foreign`, is
      // folded into the baseline, and `keyLeakProblems` reports nothing — while
      // `runIds: [""]` gives the fallback revoke nothing to revoke. F17's whole
      // purpose ("a teardown that skipped the revoke must not ship green") was
      // INVERTED on exactly the path where the revoke is most likely to have
      // been skipped. With no attribution the baseline stays account-wide, which
      // can only ever report MORE — the fail-closed direction.
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
        if (foreign.length > 0 && ours.size > 0) {
          evidence.push({
            phase: "key-hash-delta-foreign",
            foreign,
            note: "in the account delta but NOT attributable to this run's record — WARNING only, does not fail this run",
          });
          keyBaseline = new Set([...hashesBefore, ...foreign]);
        } else if (foreign.length > 0) {
          evidence.push({
            phase: "key-hash-delta-foreign",
            foreign,
            attributed: false,
            note: "this run's own key hash could NOT be attributed (no runId, or an unreadable record), so the delta is NOT folded into the baseline — the account-wide comparison stands and fails closed",
          });
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
  //   dispatch verb      T2_DISPATCH_TIMEOUT_MS 900_000 (was 1 200 s)     900 s
  //   in-box probes      3 × driver.exec at DEFAULT_EXEC_TIMEOUT_MS 120   360 s
  //                      (boxHome, manifest pair, durability probe)
  //   host-walk control  2 phase execs + 1 absence probe at 30 s each      90 s
  //                      + its readBoxFile (10)                            10 s
  //                      + statusStateSettled 3 × (60 + 5 s wait)         190 s
  //                      (the G2 negative control in step 3b. Its execs are
  //                       bounded at 30 s rather than the 120 s default for
  //                       the same reason the unit probe below is: `echo` and
  //                       `true` answer in milliseconds.)
  //   run verb           runFleet timeoutMs 180_000                       180 s
  //   status poll        10 × (status verb 60 + unit probe 30 + 15 wait) 1 050 s
  //                      (STATUS_VERB_TIMEOUT_MS is 60 s, not the 120 s this
  //                       used to pass: one status row is a listing plus two
  //                       probes each bounded at DEFAULT_PER_CALL_DEADLINE_MS,
  //                       so 60 is already several times reality — and this is
  //                       the line the poll multiplies by ten. The unit probe
  //                       keeps its OWN 30 s ceiling. Its engine-log tail runs
  //                       only on the dead-unit path, which throws, so it is
  //                       never additive.)
  //   readBoxFile        DEFAULT_PER_CALL_DEADLINE_MS 10_000               10 s
  //   Restart probe      systemctl show -p Restart at 30 s                 30 s
  //   replay leg (7b)    run verb 180 + 2 journal cats at 30              240 s
  //                      + REPLAY_LOG_ATTEMPTS 4 × (tail 30 + 5 wait)     135 s
  //   scratchClone       one real clone of the pinned sha, allowance      180 s
  //   harvest verb       runFleet timeoutMs 300_000                       300 s
  //   artifacts + reads  local extraction reads and the byte sweep         10 s
  //   orphan leg (8b)    marker rm 30 + run verb 180 + log tail 30        240 s
  //   teardown verb      runFleet timeoutMs 300_000                       300 s
  //   box-absence poll   awaitBoxAbsent 4 × (control ls 120 + 10 wait)    510 s
  //   run-verb refusals  2 × runFleet timeoutMs 60_000 (closed, unknown)  120 s
  //   post-teardown      listedKeyHashes, allowance                       240 s
  //                                                              body ────────
  //                                                                     5 095 s
  //   teardownQuietly    timeoutMs 180_000                                180 s
  //   destroyQuietly     1 control rm at 120                              120 s
  //   fleetLeftovers     5 × (control ls 120 + 8 s wait) + its destroy
  //                      pass + the confirming re-list                    880 s
  //   key attribution    one listedKeyHashes, allowance                   120 s
  //   keyLeakProblems    delta list + fallback revoke + recheck list      360 s
  //   evidence + rmSync  local                                             10 s
  //                                                           finally ────────
  //                                                                     1 670 s
  //                                                                    ────────
  //                                                                     6 765 s
  //
  // Hence 6 900 s, and the HEADER now states that figure instead of "1 box
  // ≤ 1 h" — which is the honest half of the reconciliation. The other half was
  // real cuts: the dispatch verb lost 300 s (to tier4's measured 900 s for the
  // same verb) and the status verb inside the poll lost 60 s × 10 = 600 s. Those
  // 960 s were then more than spent by the three legs DF1.10 made assertable and
  // this file was missing — AC6's replay refusal, AC6's orphaned-journal
  // refusal, and the two `startRun` guard refusals — plus the polled box-absence
  // check that replaces a single-shot listing taken inside a MEASURED 25 s+
  // destroy lag. That trade is deliberate: every one of those ceilings is a
  // ceiling on a DEGRADED round and none of them is reached on a healthy one,
  // where the added legs cost seconds.
  //
  // Every inner ceiling FIRING is safe — it rejects into the catch and the
  // `finally` still runs — so the fail-safe direction for this number is UP: it
  // is what a fully degraded round may consume before the one abort that skips
  // cleanup, not a target. WHOEVER RAISES AN INNER CEILING, LENGTHENS THE POLL
  // OR ADDS A CLEANUP STEP MUST RE-ADD IT HERE, AND MUST UPDATE THE HEADER'S
  // BOX-TIME LINE WITH IT.
  6_900_000,
);
