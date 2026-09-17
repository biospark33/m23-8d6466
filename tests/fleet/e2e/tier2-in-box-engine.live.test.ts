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
 * BOX TIME: one box, WORST CASE 9 000 s (~150 min) — the runner ceiling at the
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
import { join, posix } from "node:path";

// `BOX_MARKER_PATH` and NOT `runMarkerPath()` (DF1.10): the marker path a HOST
// process ships into the box is now a host-side LITERAL built from
// `harvest.ts`'s `BOX_RUN_ROOT`, precisely so an ambient `QDS_RUN_ROOT` in an
// operator's shell cannot redirect a box probe. `fleet status` reads the same
// constant, so this file and the verb it checks address one path by
// construction rather than by both happening to read the same env var.
import { boxMarkerPath, classifyMarkerRead, DEFAULT_PER_CALL_DEADLINE_MS } from "../../../src/fleet/fanout-primitive.ts";
// The systemd instance name, from the ONE place that builds it — so the
// remediation this test prints names the unit `fleet run` actually started.
import { runUnitName } from "../../../src/fleet/run.ts";
import { runMarkerRoot } from "../../../src/phase-engine/journal.ts";
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
 * `unknown` is deliberately NOT here either: it is AC5's fail-CLOSED verdict
 * for a marker that could not be read at all — not an absent-marker state, so
 * the dead-unit probe below does not apply to it. It is tolerated SEPARATELY,
 * up to UNKNOWN_VERDICT_TOLERANCE CONSECUTIVE ticks (FX-E/2): a single cold
 * first-ssh multiplex used to land here and terminal-break the poll, killing a
 * healthy paid round on one unreadable tick — the same cold-multiplex fact the
 * E1-10 marker-read retry already absorbs one of, earlier. Past the bound the
 * poll still fails closed with `seenStates` naming every tick, so a persistent
 * transport fault stays a diagnosable red rather than a timeout with no cause.
 */
const POLLABLE_STATES: ReadonlySet<string> = new Set(["running", "not-running", "engine-failed"]);

/**
 * How many non-zero `bun scripts/fleet.ts status` exits the poll tolerates
 * before giving up (L14). A single flaky subprocess used to end the round on a
 * run that was healthy and already paid for; a persistent one still fails,
 * because the poll can never reach a terminal verdict without a readable row.
 */
const STATUS_EXIT_TOLERANCE = 3;

/**
 * How many CONSECUTIVE `unknown` verdicts the poll tolerates before giving up
 * (FX-E/2) — STATUS_EXIT_TOLERANCE's shape, applied to the one verdict that
 * means "the marker read itself did not answer". CONSECUTIVE, not total: any
 * other parseable state resets the run, because a `running` row in between
 * proves the transport answered and the next `unknown` is a fresh tick, not a
 * continuation. One cold-ssh multiplex is the common case (E1-10's own
 * measured fact); three in a row with no readable row between them is a
 * transport fault the poll cannot out-wait, and it fails closed.
 */
const UNKNOWN_VERDICT_TOLERANCE = 3;

/** Every extracted file under `dir`, as absolute paths — directories excluded. */
function extractedFiles(dir: string): string[] {
  return readdirSync(dir, { recursive: true })
    .map((rel) => join(dir, rel as string))
    .filter((p) => statSync(p).isFile());
}

/**
 * The manifest AS DISPATCHED (B28): `git show <pinned sha>:<path>` out of the
 * object database, not the operator's dirty working tree — the box received
 * the file at `ctx.sha` (the brief's `commitSha`, the same sha `scratchClone`
 * fetches), so a locally edited `t2.pipeline.json` made `manifestBudgetMs` and
 * the negative control's phase list disagree with what the engine actually
 * walked. Falls back to the working tree — loudly, on stderr, and reported via
 * the returned `source` — only when the sha is not present in the local repo.
 * The fallback keeps the round alive long enough to reach the
 * `manifestRead.source` assertion at the budget comparison (FX-E/6), which
 * reds it BY NAME: the caller never silently reasons over a dirty tree's
 * numbers while the box walked `ctx.sha`'s copy.
 */
function readManifestAtSha(sha: string): { text: string; source: "sha" | "working-tree" } {
  const shown = Bun.spawnSync({
    cmd: ["git", "-C", REPO_ROOT, "show", `${sha}:${T2_MANIFEST_PATH}`],
    stdout: "pipe",
    stderr: "pipe",
  });
  if (shown.exitCode === 0) return { text: shown.stdout.toString(), source: "sha" };
  process.stderr.write(
    `[T2.2] B28: git show ${sha}:${T2_MANIFEST_PATH} failed (exit ${String(shown.exitCode)}: ${shown.stderr.toString().trim().slice(0, 200)}) — reading the WORKING TREE instead, which may differ from what the box received\n`,
  );
  return { text: readFileSync(join(REPO_ROOT, T2_MANIFEST_PATH), "utf8"), source: "working-tree" };
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
        // B24: every verb tail is PRE-REDACTED (redactSecrets, the same helper
        // the engine-log tails below use) before it enters evidence. A tail
        // slice can CUT a credential mid-token — `sk-or-` with the rest
        // scrolled off — which `writeEvidence`'s pattern scrub cannot match
        // but its `/sk-or-/` refusal assertion DOES hit, so the write throws
        // and `writeEvidenceQuietly` swallows it: a paid round leaves NO
        // evidence file, which the runner's protocol then misreads as "never
        // ran". Same treatment on every stdoutTail/stderrTail push below.
        stdoutTail: redactSecrets(dispatch.stdout.trim().slice(-400)),
        stderrTail: redactSecrets(dispatch.stderr.trim().slice(-600)),
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
      // The two reads of the minted id must AGREE (round 3, E1-8): `emitted`
      // armed ownership from the raw streams precisely because the failure path
      // cannot trust the ack — if the ack ever names a DIFFERENT id (a retry
      // inside the verb, a second JSON line), the `finally`'s ownership and
      // every later assertion silently rebind to the ack's id. Divergence is a
      // real defect, not a choice between the two.
      expect(ack.runId).toBe(runId);
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
      const manifestBoxPath = `${qdsDir}/pipeline.yaml`; // live-mirror: qdsDir = $HOME/<DEFAULT_FILL_WORKDIR>/<QDS_IN_BOX_DIR> (fill.ts imports)
      const witnessBoxPath = `${qdsDir}/run-context.json`;
      const journalBoxPath = `${home}/${runId}.journal.jsonl`;
      const engineLogBoxPath = `${home}/${runId}.engine.log`;
      // The BOX's paths, from the host-side literals — never `runMarkerPath()`,
      // which answers "where would THIS process write a marker" and is
      // relocatable by `QDS_RUN_ROOT`. `fleet status` reads `BOX_MARKER_PATH`
      // too, so this file and the verb it checks cannot address different files.
      const markerBoxPath = boxMarkerPath(runId);
      // E1-10: one cold first ssh multiplex can cost a raw `readBoxFile` its
      // 10 s deadline — `statusStateSettled` absorbs exactly this on the verb
      // side ("`unknown` on a box created seconds ago is a cold multiplex far
      // more often than a fault"), while the two primitive reads below (3b and
      // 6) got no tolerance and could red a paid round for substrate latency.
      // ONE retry, verdict-preserving: a genuinely absent marker still reads
      // `absent` both times — a retry cannot fabricate presence, it can only
      // recover an `unreadable` the transport ate.
      const readMarkerTolerant = async (): Promise<ReturnType<typeof readBoxFile>> => {
        let read = await readBoxFile(ctx.driver, vmName, markerBoxPath, DEFAULT_PER_CALL_DEADLINE_MS);
        if (read.kind === "unreadable") {
          evidence.push({ phase: "marker-read-retry", kind: read.kind });
          read = await readBoxFile(ctx.driver, vmName, markerBoxPath, DEFAULT_PER_CALL_DEADLINE_MS);
        }
        return read;
      };
      // live-mirror: engine trace store — pipeline-run.ts claims
      // `<markerRoot>/trace` where markerRoot = runMarkerRoot(runId), so the
      // per-run re-rooting (#217 F-D1) moved the db from the DF1.4 flat
      // `/run/trace` to `/run/qds-run/<runId>/trace`. Derived from the same
      // exported runMarkerRoot the engine derives its root from — a hand
      // literal here is how the stale `/run/trace` slipped past review.
      const traceBoxPath = posix.join(runMarkerRoot(runId), "trace", "trace.db");
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
      // Read at the DISPATCHED SHA (B28), not out of the working tree — the box
      // walked `ctx.sha`'s copy, and one `manifestRead` here serves step 3b's
      // phase list too, so the two reads cannot disagree with each other either.
      const manifestRead = readManifestAtSha(ctx.sha);
      const manifestBudgetMs = (JSON.parse(manifestRead.text) as { runBudgetMs: number }).runBudgetMs;
      expect(witness.budgetMs).toBeGreaterThanOrEqual(manifestBudgetMs);
      // The resident's arming inputs (pipeline-run.ts:2150 reads exactly these):
      // recorded rather than asserted, because whether the resident arms decides
      // which artifacts step 8 can require of the tar, and this is the evidence
      // that decides it.
      evidence.push({
        phase: "witness",
        budgetMs: witness.budgetMs,
        effectiveCeilingMicros: witness.effectiveCeilingMicros,
        manifestSource: manifestRead.source,
        armsResident: (witness.requestId ?? "") !== "" || (witness.repoSlug ?? "") !== "",
      });
      // B28 (FX-E/6): the sha read must have SUCCEEDED for the comparison
      // above to mean what it claims. The working-tree fallback exists so the
      // round reaches THIS assertion with a legible name and the loud stderr
      // note `readManifestAtSha` already wrote — not so the budget comparison
      // can silently run on a dirty tree's `runBudgetMs` while the box walked
      // `ctx.sha`'s copy. Placed after the witness evidence entry so a
      // fallback round's evidence names `manifestSource` before the red; the
      // step 3b phase list below never runs on fallback text either, because
      // this line already ended the round.
      expect(manifestRead.source).toBe("sha");

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
        JSON.parse(manifestRead.text) as {
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
      const hostWalkMarker = classifyMarkerRead(await readMarkerTolerant(), runId);
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
      //
      // B32: `not-running` is the MEASURED answer (inactive unit) but not the
      // only honest one — `unitActivity` maps systemd's own `unknown` word,
      // and any probe that did not answer, to `unknown`, which `inBoxState`
      // returns verbatim (status.ts). An image whose `is-active` answers
      // `unknown` for never-loaded instances is substrate vocabulary, not a
      // host-walk verdict, and must not red a healthy paid round. `engine-
      // failed` deliberately stays a RED: a pre-failed instance on a run
      // nothing ever started is the real anomaly the vocabulary exists to name.
      expect(["not-running", "unknown"]).toContain(hostWalkStatus.state);

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
        stdout: redactSecrets(start.stdout.trim().slice(0, 300)),
        stderrTail: redactSecrets(start.stderr.trim().slice(-400)),
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
      // E1-3: consecutive `inactive/success/0` readings with no marker — the
      // first can be the marker-write/exit race, the second is a clean exit
      // that provably wrote none (see the `cleanExitNoMarker` arm below).
      let consecutiveCleanExits = 0;
      let terminal = "";
      let statusExitFailures = 0;
      // FX-E/2: consecutive `unknown` verdicts, reset by any other parseable
      // row — see UNKNOWN_VERDICT_TOLERANCE for why consecutive and not total.
      let consecutiveUnknowns = 0;
      // B34: the REAL poll count, distinct from `seenStates.length` — tolerated
      // non-zero exits push "(status exit N)" pseudo-entries (kept in
      // `seenStates` as evidence) and parse hiccups push none, so the array
      // length over- and under-counted the number of actual polls.
      let statusPolls = 0;
      for (let attempt = 1; attempt <= STATUS_POLL_ATTEMPTS; attempt += 1) {
        statusPolls += 1;
        // FX-E/3: the ceiling REJECTS (RunFleetTimeoutError), and a bare await
        // let that rejection escape the loop into the outer catch — ending the
        // round on a status-verb TIMEOUT while the identical flakiness as a
        // non-zero EXIT got the tolerance below. Same budget, same shape: the
        // partial output the killed child had written is recovered via
        // `fleetPartialOutput`, the failure counts into `statusExitFailures`,
        // and the poll sleeps and continues under the bound.
        let status: Awaited<ReturnType<typeof runFleet>>;
        try {
          status = await runFleet(["status", runId, "--driver", "exedev", "--dir", recordsDir], {
            // B29: explicit like every sibling verb call — `runFleet` already
            // defaults its cwd to REPO_ROOT; pinning it here keeps the status
            // legs from being the one unpinned pair the day that default moves.
            cwd: REPO_ROOT,
            timeoutMs: STATUS_VERB_TIMEOUT_MS,
          });
        } catch (fleetError) {
          const partial = fleetPartialOutput(fleetError);
          statusExitFailures += 1;
          seenStates.push(`(status verb threw: ${fleetError instanceof Error ? fleetError.message : String(fleetError)})`);
          evidence.push({
            phase: "status-verb-threw",
            attempt,
            tolerated: statusExitFailures <= STATUS_EXIT_TOLERANCE,
            error: fleetError instanceof Error ? fleetError.message : String(fleetError),
            stderrTail: redactSecrets(partial.stderr.trim().slice(-300)),
          });
          if (statusExitFailures > STATUS_EXIT_TOLERANCE) break;
          if (attempt < STATUS_POLL_ATTEMPTS) await new Promise((r) => setTimeout(r, STATUS_POLL_WAIT_MS));
          continue;
        }
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
            stderrTail: redactSecrets(status.stderr.trim().slice(-300)),
          });
          if (statusExitFailures > STATUS_EXIT_TOLERANCE) break;
          if (attempt < STATUS_POLL_ATTEMPTS) await new Promise((r) => setTimeout(r, STATUS_POLL_WAIT_MS));
          continue;
        }
        // E1-11: `statusStateSettled` wraps the identical parse in a try and
        // treats a malformed trailing line as a RETRYABLE attempt; this
        // hand-rolled poll threw out of the loop into the outer catch instead,
        // making a formatting hiccup indistinguishable from an engine fault.
        let row: { runId?: string; state?: string };
        try {
          row = lastJsonLine<{ runId?: string; state?: string }>(status.stdout);
        } catch (parseError) {
          evidence.push({
            phase: "status-parse-failed",
            attempt,
            note: "treated as a retryable attempt, like statusStateSettled treats the same parse",
            error: parseError instanceof Error ? parseError.message : String(parseError),
          });
          if (attempt < STATUS_POLL_ATTEMPTS) await new Promise((r) => setTimeout(r, STATUS_POLL_WAIT_MS));
          continue;
        }
        expect(row.runId).toBe(runId);
        const state = row.state ?? "";
        seenStates.push(state);
        if (SETTLED_STATES.has(state)) {
          terminal = state;
          break;
        }
        // `unknown` rides a CONSECUTIVE bound of its own (FX-E/2) before the
        // generic break below can see it: one cold-ssh tick is the E1-10 cold
        // multiplex far more often than a fault, and a single tick ending the
        // poll killed a healthy paid round. Under the bound it is a retry like
        // any other; over it the poll breaks (and the throw below fires) with
        // every tick already named in `seenStates`. It does NOT fall through to
        // the dead-unit probe — that probe diagnoses absent-marker states, and
        // `unknown` means the marker read itself did not answer.
        if (state === "unknown") {
          consecutiveUnknowns += 1;
          if (consecutiveUnknowns > UNKNOWN_VERDICT_TOLERANCE) break;
          if (attempt < STATUS_POLL_ATTEMPTS) await new Promise((r) => setTimeout(r, STATUS_POLL_WAIT_MS));
          continue;
        }
        consecutiveUnknowns = 0;
        // The three "no marker yet" readings keep the poll going; anything else
        // ends it. See POLLABLE_STATES for why `not-running` and `engine-failed`
        // are among them post-DF1.10 (a benign write/exit race, and a death the
        // probe below diagnoses far better than an early break would).
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
        // …and the CLEAN-exit half of the same argument, which the tolerance
        // above deliberately rides through ONCE (round 3, E1-3). The engine
        // writes the marker BEFORE it exits, so `inactive/success/0` with the
        // marker still absent one poll later is not a race any more — it is an
        // engine that exited cleanly WITHOUT writing one, a real defect this
        // poll used to ride to its full ~20-minute ceiling before failing the
        // generic terminal≠ok throw. Two consecutive readings settle it: the
        // first could be the write/exit race the comment above protects, the
        // second cannot. Same fast-fail shape as `unitDead` — the diagnosis
        // below (engine log) runs for this arm too, because a clean exit with
        // no marker is exactly the defect whose cause lives in that log.
        if (activeState === "inactive" && result === "success" && mainStatus === "0") {
          consecutiveCleanExits += 1;
        } else {
          consecutiveCleanExits = 0;
        }
        const cleanExitNoMarker = consecutiveCleanExits >= 2;
        if (unitDead || cleanExitNoMarker) {
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
            cleanExitNoMarker,
            engineLogTail: redactSecrets(tail.stdout).slice(-2000),
          });
          throw new Error(
            [
              `${runUnitName(runId)} has already terminated after ${statusPolls} status poll(s) and will never write a marker:`,
              `ActiveState=${activeState} Result=${result} ExecMainStatus=${mainStatus}${cleanExitNoMarker ? " — a CLEAN exit across two consecutive polls with no marker, i.e. the engine exited without writing one" : ""}.`,
              `Tail of ${engineLogBoxPath}: ${redactSecrets(tail.stdout).slice(-1200) || "(empty — the engine produced no log, so it refused before it opened one)"}`,
            ].join(" "),
          );
        }
        if (attempt < STATUS_POLL_ATTEMPTS) await new Promise((r) => setTimeout(r, STATUS_POLL_WAIT_MS));
      }
      evidence.push({ phase: "status-poll", seenStates, terminal, attempts: statusPolls, statusExitFailures });
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
            `in-box run did not settle to \`ok\` after ${statusPolls} status poll(s) (states seen: ${seenStates.join(" → ") || "none"}; ${statusExitFailures} status verb invocation(s) exited non-zero).`,
            `\`running\` to the last poll means the engine is still walking — ssh the box and read \`systemctl status ${runUnitName(runId)}\` and ${home}/${runId}.engine.log.`,
            "`not-ok` means the engine settled and the run FAILED — the harvested journal names the phase.",
            "`not-running` to the last poll means no marker AND the unit is `inactive`: the engine exited without settling, or `fleet run` never reached it. It is also the benign one-tick race between the marker write and the exit, which is why the poll rides through it.",
            "`engine-failed` means no marker and the unit is `failed` — the dead-unit probe should have thrown first with the engine-log tail; reaching this line instead means the probe itself could not answer.",
            `\`unknown\` is AC5's fail-closed verdict: neither the marker read nor the unit probe answered (box unreachable, or a marker present and unjudgeable) — up to ${String(UNKNOWN_VERDICT_TOLERANCE)} consecutive ticks are ridden through, so reaching this line means the read was PERSISTENTLY unreadable.`,
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
      // The marker path is PER-RUN since #217 F-D1 (/run/qds-run/<runId>/…),
      // and the payload carries the runId of the engine that wrote it — so a
      // marker written by ANY other run planted on this run's root still read
      // as THIS run settling ok without the check. `classifyMarkerRead`'s
      // `expectedRunId` is the check, it is
      // free, and it is exactly what DF1.10 wired into `fleet status` and into
      // the engine's own `ENGINE_MARKER_FOREIGN` refusal. A foreign marker now
      // classifies `unusable`, so the two assertions below both fail and the
      // verdict's own code names the run the marker belongs to.
      const verdict = classifyMarkerRead(await readMarkerTolerant(), runId);
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
        stdout: redactSecrets(replay.stdout.trim().slice(0, 300)),
        stderrTail: redactSecrets(replay.stderr.trim().slice(-400)),
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
        stdout: redactSecrets(harvest.stdout.trim().slice(0, 300)),
        stderrTail: redactSecrets(harvest.stderr.trim().slice(-400)),
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
      const engineLogLocal = join(artifactsDir, `${runId}.engine.log`);
      const required = [
        join(artifactsDir, "journal", "final.json"),
        join(artifactsDir, "trace", "trace.db"),
        join(artifactsDir, `${runId}.journal.jsonl`),
        engineLogLocal,
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
      // B27: present-only was vacuous — a 0-byte or corrupt trace.db passed
      // while the header claimed §5.3's trace-DB harvest was "made checkable".
      // Size plus the SQLite magic header (16 bytes, `SQLite format 3\0`) prove
      // the in-box tracer wrote a real database, not an empty file the byte
      // sweep below then read as clean.
      const traceDbBytes = readFileSync(join(artifactsDir, "trace", "trace.db"));
      const traceHeaderOk = traceDbBytes.subarray(0, 16).toString("latin1") === "SQLite format 3\0";
      evidence.push({ phase: "trace-db", bytes: traceDbBytes.length, sqliteHeader: traceHeaderOk });
      expect(traceDbBytes.length).toBeGreaterThan(0);
      expect(traceHeaderOk).toBeTrue();

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
      // WHY the resident degraded — recovered from the two places it can be.
      //
      // `steering.ts:886-888` is explicit that "the journal's resident block is
      // a closed key set, so it has no field to carry a degradation reason".
      // The reason exists only at the `[resident]` warn chokepoint, which is a
      // bare `console.error` (resident.ts) — so in-box it lands on the UNIT's
      // stderr, i.e. journald, NOT in the engine log, which is its own tee of
      // the engine's emitted events. MEASURED 2026-09-05: a `degraded` run's
      // engine log carried zero `[resident]` lines, which is what sent this
      // lookup to journald in the first place.
      //
      // journald first, the engine log second — the second is not dead code:
      // a HOST-side resident (the shape DF1.10 relocated away from, still
      // reachable by a bare runner invocation) writes to whatever stderr its
      // caller teed, and a box where `journalctl` is not readable by the exec
      // user degrades to it rather than to nothing. Best-effort throughout: a
      // diagnostic that can fail the run it is diagnosing is worse than none.
      const journaldWarn = await ctx.driver.execTimed(
        vmName,
        ["sh", "-c", `journalctl -u ${shellQuote(runUnitName(runId))} --no-pager 2>&1 | grep -F '[resident]' | tail -5`],
        30_000,
      );
      // FX-E/4: both halves are box-authored text (journald, the engine log)
      // heading for the evidence file — mapped through `redactSecrets` like
      // every other tail this file pushes, not excepted for being diagnostic.
      const residentWarnings = [
        ...journaldWarn.stdout.split("\n").filter((l) => l.includes("[resident]")).map((l) => redactSecrets(l)),
        ...(existsSync(engineLogLocal)
          ? readFileSync(engineLogLocal, "utf8")
              .split("\n")
              .filter((l) => l.includes("[resident]"))
              .map((l) => redactSecrets(l))
          : []),
      ].slice(-5);
      evidence.push({
        phase: "resident-artifacts",
        residentStatus,
        residentSessionPresent: existsSync(residentSession),
        residentWarnings,
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
      // An ACTIVE resident writes `$HOME/<runId>.resident.jsonl` (resident.ts
      // :349, sessionDir = the journal's own directory = `$HOME`), so the tar
      // must carry it. The run's own status decides, not this test.
      //
      // `active` IS the assertion. `disabled` writes no such file, and neither
      // does a resident that degraded before pi produced a session — the file
      // is pi's, not the resident's, and DF3.3 degrades OPEN (`return PROCEED`)
      // at four points: a failed prompt render, a call that threw (timeout,
      // unreachable, process death), two malformed replies, and a bounds stop.
      // MEASURED 2026-09-05: five live runs of this file, four `active` with the
      // session present and one `degraded` with no session, on an unchanged
      // build — model nondeterminism, exactly what degrading open exists to
      // absorb. Requiring the file for every non-`disabled` status therefore
      // asserted that a live model always answers, which is not a property this
      // system has or wants.
      //
      // What keeps that from becoming a soft assertion: `residentWarnings`
      // above lifts the degradation REASON out of the engine log and onto the
      // evidence — the journal's resident block is a closed key set and cannot
      // carry it (steering.ts:886-888) — so a SYSTEMATIC degradation is
      // diagnosable from the evidence file instead of costing another box.
      if (residentStatus === "active") expect(existsSync(residentSession)).toBeTrue();
      // B23: `disabled` is the NEVER-ARMS regression and it fails the round.
      // The witness arms the resident (its `armsResident` evidence above), so a
      // settled run whose journal says no resident was even attempted is an
      // arming-path defect — before this, a build whose resident NEVER armed
      // passed this file every round with only an unread evidence field to say
      // so. `degraded` stays tolerated (the measured 1-in-5 model
      // nondeterminism above) with its reason lifted into `residentWarnings`.
      expect(residentStatus).not.toBe("disabled");
      // And the status stays a closed set: an unknown value here means the
      // resident's own vocabulary moved without this file noticing, which is
      // the drift the `(absent)` assertion above exists to refuse in its own
      // dimension.
      expect(["active", "degraded", "disabled", "stopped"]).toContain(residentStatus);

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
      // paid box. The reboot leg is left to whoever owns the round. (B33: that
      // is a durable disclosure, not a TODO — this tier intentionally exercises
      // no reboot leg, and no reboot test is built here.)
      //
      // Runs AFTER the harvest deliberately: step 8's tar must carry the marker.
      // Setup failure is RECORDED AND SKIPPED, never fatal — the marker dir is
      // the engine user's and this should work, but a bonus regression detector
      // must not turn a green paid round red for a `rm`. B22 bounds the
      // skipping: each skip arm pushes a reason into `orphanSkips`, and TWO OR
      // MORE fail the round after the block — one skip is the current #226 pin
      // regime, but a round that skips every arm has proven nothing about
      // AC6's durable half and must not stay green.
      const orphanSkips: string[] = [];
      const wipe = await ctx.driver.execTimed(vmName, ["sh", "-c", `rm -f ${shellQuote(markerBoxPath)}`], 30_000);
      evidence.push({ phase: "tmpfs-wipe-simulated", exitCode: wipe.exitCode, markerBoxPath, stderrTail: redactSecrets(wipe.stderr.trim().slice(-200)) });
      if (wipe.exitCode !== 0) {
        orphanSkips.push("marker rm failed");
        evidence.push({
          phase: "orphaned-replay",
          skipped: true,
          note: "the marker could not be removed, so AC6's durable-half refusal was not exercised this round — see the operator checklist",
        });
      } else {
        // `fleet run` again. The engine now finds NO marker and a journal with
        // phase rows ⇒ `ENGINE_JOURNAL_ORPHANED`, exit 2 ⇒ `Restart=no` leaves
        // the unit `failed`. That refusal is DF1.10's; before it, this path
        // re-walked phases whose spend and commits had already happened.
        //
        // WHAT THE `fleet run` EXIT CODE CAN AND CANNOT PROVE. `qds-run@.service`
        // is `Type=simple`, so systemd calls the unit started the instant the
        // process is FORKED, and `startRun`'s post-start `systemctl is-active`
        // probe is the only thing standing between that fork and a `started`
        // report. Whether the probe sees the refusal is a RACE it cannot be
        // made to win: the engine has to boot bun and read the journal before it
        // can know it is orphaned, and `unitActivity` reads `activating` as
        // `active` deliberately (`src/fleet/run.ts:311-312`). Lose the race and
        // the verb reports `started` and exits 0; win it and the probe reads
        // `failed` ⇒ `start-failed {reason:"unit-refused"}` with no `exitCode`
        // (systemd's own start job returned 0) ⇒ the CLI maps it to
        // `engine-start-refused` and exit **5**, never 1, because the identical
        // retry produces the identical failure and "retry me" would be a lie.
        //
        // MEASURED, 2026-09-05: exit 0, `fleet run` duration 1958 ms — the
        // engine had not yet exited when the probe landed. An earlier form of
        // this leg asserted `toBe(5)` unconditionally and therefore asserted the
        // winning side of that race; it was written in review round 1 and never
        // run live, which is issue #210's shape exactly. Its sibling leg 8a
        // (`ENGINE_MARKER_PRESENT`, above) already had this right: it accepts the
        // `started`/exit-0 report and reads the refusal where the ENGINE writes
        // it. This leg now does the same, and asserts the exit-5 envelope only
        // when the probe actually won — so that coverage is kept without being
        // made load-bearing on a timing accident.
        //
        // The property that IS load-bearing, and is asserted unconditionally
        // below: no phase was re-walked (INV-IBOX-6), the engine said so in its
        // own log, and `fleet status` settles on `engine-failed` — the AC5 state
        // that exists precisely because a start verb cannot carry this verdict.
        const journalBeforeOrphan = await ctx.driver.execTimed(
          vmName,
          ["sh", "-c", `cat ${shellQuote(journalBoxPath)}`],
          30_000,
        );
        expect(journalBeforeOrphan.exitCode).toBe(0);
        // The two inputs `journalReclaimRefusal` reads, recorded as the engine
        // would see them. Round 2 lost an hour to guessing which of them was
        // false when the refusal did not fire; a phase-row count and a listing
        // of the marker root cost one exec each and answer it from evidence.
        let journalPhaseRows = -1;
        try {
          const parsed = JSON.parse(journalBeforeOrphan.stdout) as { phases?: unknown };
          journalPhaseRows = Array.isArray(parsed.phases) ? parsed.phases.length : -1;
        } catch {
          /* -1 stays, and says "the engine's JSON.parse would have thrown too" */
        }
        const markerRootLs = await ctx.driver.execTimed(
          vmName,
          ["sh", "-c", `ls -la ${shellQuote(posix.dirname(markerBoxPath))} 2>&1`],
          30_000,
        );
        // WHICH ENGINE IS ON THIS BOX — the question round 2 learned to ask.
        //
        // DF1.10 ships the engine as unbundled SOURCE inside the image (AC2a),
        // so `scripts/pipeline-run.ts` in this repo is not what the box runs
        // until the image is rebuilt and re-pinned; the checkout `dispatch`
        // clones at QDS_EXEDEV_SHA is the WORKLOAD, not the engine. Measured on
        // the shipping pin (issue #226): its `/opt/qds-factory` tree is at
        // gitSha 7ff55b55, which predates review round 1, and carries ZERO
        // occurrences of either refusal that round added. This leg therefore
        // re-walked the run — twice, on two boxes — with both of the guard's
        // inputs verifiably correct.
        //
        // Self-locating rather than hard-coded: the entry is read out of the
        // `qds-engine` wrapper the unit actually execs, so a repointed entry
        // cannot make this probe silently answer about the wrong file.
        // Round 3 (E1-2): the entry is the `exec` line's FIELD ENDING IN
        // pipeline-run.ts, found by scanning every field — `awk '{print $3}'`
        // silently answered "run" the day a flag landed between `bun` and the
        // entry (`exec bun run <entry>`), turning the whole leg into the
        // #226 skip while the guard existed. Position-independent, and an
        // `exec` line with no `.ts` field is a shape this probe cannot read,
        // which is the skip arm below — never a silently wrong answer.
        const guardProbe = await ctx.driver.execTimed(
          vmName,
          [
            "sh",
            "-c",
            'entry=$(awk \'/^exec /{for(i=2;i<=NF;i++) if ($i ~ /pipeline-run\\.ts$/) {print $i; exit}}\' /usr/local/bin/qds-engine); ' +
              'printf "entry=%s hits=%s\\n" "$entry" "$(grep -c ENGINE_JOURNAL_ORPHANED "$entry" 2>/dev/null || echo 0)"',
          ],
          30_000,
        );
        // FX-E/5: the entry and the hit count are BRANCHED, not folded. An
        // empty `entry=` (a wrapper shape change — no `.ts` field on the
        // `exec` line) makes `grep -c` answer 0 against a file that was never
        // found, and folding that into `guardHits === 0` made the probe's own
        // blindness PERMANENT: every round after a wrapper change would report
        // the #226 pin regime while the guard sat unread. An unreadable entry
        // is its own skip reason — its own evidence entry, its own B22 count;
        // only a READ entry with zero hits is the #226 arm.
        const guardEntry = /entry=(\S*)/.exec(guardProbe.stdout)?.[1] ?? "";
        const guardHits = Number(/hits=(\d+)/.exec(guardProbe.stdout)?.[1] ?? "0");
        evidence.push({
          phase: "orphaned-preconditions",
          journalBytes: journalBeforeOrphan.stdout.length,
          journalPhaseRows,
          markerRootListing: markerRootLs.stdout.trim().slice(-600),
          boxEngineProbe: guardProbe.stdout.trim(),
          boxEngineEntry: guardEntry,
          boxEngineCarriesGuard: guardEntry !== "" && guardHits > 0,
        });
        // A LOUD SKIP, not a green pass and not a red the re-pin cannot clear.
        // Asserting a refusal the substrate provably cannot make would keep this
        // file red on every branch until a re-pin lands on `dev` — and a red
        // that nobody can fix is a red people learn to ignore. The skip is
        // recorded ON the evidence with the issue that closes it, so an audit
        // filtering `skipped === true` finds it.
        if (guardEntry === "") {
          orphanSkips.push("engine wrapper entry unreadable — the guard probe cannot see which file the unit execs");
          evidence.push({
            phase: "orphaned-replay",
            skipped: true,
            note: "the qds-engine wrapper's exec line carries no field ending in pipeline-run.ts, so the guard probe is blind — NOT the #226 pin arm; a wrapper shape change needs the probe rewritten before this leg can assert anything",
          });
        } else if (guardHits === 0) {
          orphanSkips.push("box engine carries no ENGINE_JOURNAL_ORPHANED guard (#226 pin)");
          evidence.push({
            phase: "orphaned-replay",
            skipped: true,
            issue: 226,
            note: "the box's engine predates review round 1 and carries no ENGINE_JOURNAL_ORPHANED, so AC6's durable-half refusal cannot be exercised on this pin — see #226; the re-pin bundle (#217) is what makes this assertable",
          });
        } else {
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
          // FX-E/4: the envelope is verb-authored text parsed to an object, and
          // it rides the redaction discipline every other tail in this file
          // already follows. Stringify → redact → re-parse keeps the object
          // shape for evidence consumers; if a redaction marker ever broke the
          // JSON (a quoted secret), the redacted STRING form is pushed instead
          // — never the raw bytes, and never a thrown parse on a paid round.
          // The ASSERTIONS below use `orphanEnv` itself, unredacted and local.
          const orphanEnvelopeRedacted: unknown = (() => {
            const text = redactSecrets(JSON.stringify(orphanEnv ?? null));
            try {
              return JSON.parse(text);
            } catch {
              return text;
            }
          })();
          evidence.push({
            phase: "orphaned-replay",
            exitCode: orphan.exitCode,
            probeWonTheRace: orphan.exitCode === 5,
            envelope: orphanEnvelopeRedacted,
            stderrTail: redactSecrets(orphan.stderr.trim().slice(-600)),
          });
          // Both readings are honest; a third would not be. Anything other than
          // "refused at the probe" or "reported started and refused a beat later"
          // is a real defect — exit 1 in particular, which would be the CLI
          // inviting a retry of a permanently-doomed start.
          // Typed `Array<number | null>` so the RECEIVED value survives into the
          // failure message: a killed verb reports `exitCode: null`, and a bare
          // `[0, 5]` would make that a compile error instead of a legible red.
          const acceptedOrphanExits: Array<number | null> = [0, 5];
          expect(acceptedOrphanExits).toContain(orphan.exitCode);
          if (orphan.exitCode === 5) {
            expect(orphan.stdout).not.toContain(`started: ${runId}`);
            expect(orphanEnv).toMatchObject({ runId, unit: runUnitName(runId), reason: "unit-refused" });
          } else {
            expect(orphan.stdout).toContain(`started: ${runId}`);
          }
          // The engine's own words, in the log the harvest already carried once —
          // this second refusal appends to it (the log is `O_APPEND`), so a
          // re-harvest would show both. Polled for the same reason leg 8a polls:
          // `fleet run` returns at the fork, so the refusal need not be flushed
          // the instant the verb exits — and on the exit-0 arm it provably is not.
          let orphanTail = "";
          for (let attempt = 1; attempt <= REPLAY_LOG_ATTEMPTS && !orphanTail.includes("ENGINE_JOURNAL_ORPHANED"); attempt += 1) {
            const orphanLog = await ctx.driver.execTimed(
              vmName,
              ["sh", "-c", `tail -c 4000 ${shellQuote(engineLogBoxPath)} 2>&1`],
              30_000,
            );
            orphanTail = orphanLog.stdout;
            if (!orphanTail.includes("ENGINE_JOURNAL_ORPHANED") && attempt < REPLAY_LOG_ATTEMPTS) {
              await new Promise((r) => setTimeout(r, 5_000));
            }
          }
          evidence.push({ phase: "orphaned-engine-log", tail: redactSecrets(orphanTail).slice(-800) });
          expect(orphanTail).toContain("ENGINE_JOURNAL_ORPHANED");
          // INV-IBOX-6, the reason the refusal exists: the durable journal is
          // byte-identical, so nothing was re-walked and nothing was truncated by
          // a `new FileJournal` that never ran.
          const journalAfterOrphan = await ctx.driver.execTimed(
            vmName,
            ["sh", "-c", `cat ${shellQuote(journalBoxPath)}`],
            30_000,
          );
          expect(journalAfterOrphan.exitCode).toBe(0);
          expect(journalAfterOrphan.stdout).toBe(journalBeforeOrphan.stdout);
          evidence.push({ phase: "orphaned-journal-untouched", ok: true, bytes: journalAfterOrphan.stdout.length });
          // AC5's vocabulary against a genuinely dead unit: marker wiped and the
          // unit `failed` is `engine-failed`, which is the whole point of the two
          // states DF1.10 added — `absent → running` would report this run healthy
          // forever. Polled, because the exit-0 arm means the unit may still be
          // dying when the verb returns.
          let orphanState = "";
          // FX-E/3, mirrored from the main poll: the status verb's ceiling
          // REJECTS (RunFleetTimeoutError), and a bare await let that
          // rejection escape into the outer catch — ending the round on a leg
          // whose non-zero exits and parse hiccups were already tolerated
          // retries. Same budget shape (STATUS_EXIT_TOLERANCE), local counter:
          // this is a distinct leg that starts from a clean sheet, and over
          // budget it breaks with `orphanState` unset so the assertion below
          // fails closed instead of the rejection failing the round.
          let orphanStatusFailures = 0;
          for (let attempt = 1; attempt <= REPLAY_LOG_ATTEMPTS && orphanState !== "engine-failed"; attempt += 1) {
            let status: Awaited<ReturnType<typeof runFleet>>;
            try {
              status = await runFleet(["status", runId, "--driver", "exedev", "--dir", recordsDir], {
                cwd: REPO_ROOT, // B29: pinned like the main poll's status leg
                timeoutMs: STATUS_VERB_TIMEOUT_MS,
              });
            } catch (fleetError) {
              const partial = fleetPartialOutput(fleetError);
              orphanStatusFailures += 1;
              evidence.push({
                phase: "orphan-status-verb-threw",
                attempt,
                tolerated: orphanStatusFailures <= STATUS_EXIT_TOLERANCE,
                error: fleetError instanceof Error ? fleetError.message : String(fleetError),
                stderrTail: redactSecrets(partial.stderr.trim().slice(-300)),
              });
              if (orphanStatusFailures > STATUS_EXIT_TOLERANCE) break;
              if (attempt < REPLAY_LOG_ATTEMPTS) {
                await new Promise((r) => setTimeout(r, 5_000));
              }
              continue;
            }
            if (status.exitCode === 0) {
              // Same parse tolerance as the main poll (E1-11): a malformed
              // trailing line is a retried attempt here too, not a round-ender.
              try {
                orphanState = lastJsonLine<{ state?: string }>(status.stdout).state ?? "";
              } catch {
                orphanState = "";
              }
            }
            if (orphanState !== "engine-failed" && attempt < REPLAY_LOG_ATTEMPTS) {
              await new Promise((r) => setTimeout(r, 5_000));
            }
          }
          evidence.push({ phase: "orphaned-status", state: orphanState, statusVerbThrows: orphanStatusFailures });
          expect(orphanState).toBe("engine-failed"); // live-mirror: fleet status vocabulary (status.ts, AC5)
        }
      }
      // B22's threshold, evaluated after the whole block so a wipe-failure and
      // a guard-skip on the SAME round both count: ≥2 skips means AC6's durable
      // half proved nothing this round, and a permanent skip-regime can no
      // longer ride behind the #226 single-skip tolerance.
      evidence.push({ phase: "orphan-skip-count", skips: orphanSkips.length, reasons: orphanSkips });
      if (orphanSkips.length >= 2) {
        throw new Error(
          `AC6's durable half skipped ${String(orphanSkips.length)} of its legs this round (${orphanSkips.join("; ")}) — one skip is the #226 pin regime, two or more is a coverage regime this file refuses to report green. See the orphaned-replay entries above.`,
        );
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
        stdout: redactSecrets(teardown.stdout.trim().slice(0, 300)),
        stderrTail: redactSecrets(teardown.stderr.trim().slice(-400)),
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
      const gone = await awaitBoxAbsent(ctx.driver, vmName, evidence, {
        // 6, not 4 (round 3, E1-6): the measured lag floor is "25 s+" with no
        // stated ceiling — 4 × 10 s of waits leaves ~5 s of headroom over the
        // floor, less than one retry interval for the distribution's tail.
        // 6 spans 50 s+ of waits; a healthy destroy still costs seconds.
        maxAttempts: 6,
        retryDelayMs: 10_000,
      });
      // B26: NOT a body assertion (it used to be `expect(gone.absent)`). The
      // measured destroy lag has no stated ceiling, so a laggy-but-healthy
      // destroy reds the round HERE — before the `finally`'s `fleetLeftovers`,
      // which exists precisely to absorb survivors, can run — turning substrate
      // timing into a red on the most expensive test in the tree. The poll's
      // `box-gone` evidence entry plus this verdict land either way, and the
      // ENFORCING check is `fleetLeftovers` in the `finally`: it destroys an
      // owned survivor and only boxes that survive THAT reach `settleRun` as
      // "still listed after cleanup".
      evidence.push({
        phase: "teardown-box-absence",
        absent: gone.absent,
        attempts: gone.attempts,
        enforcedBy: "fleetLeftovers (finally)",
      });

      // ── 9b. `fleet run` on a run that is OVER, and on one that never was ──
      // Both are free (no box, no spend) and both are `startRun` guards that had
      // no live coverage at all. The record is now `closedAt`, so the refusal is
      // `run-not-startable {state:"closed"}` → exit 5, decided BEFORE any exec.
      const startClosed = await runFleet(["run", runId, "--driver", "exedev", "--dir", recordsDir], {
        cwd: REPO_ROOT,
        timeoutMs: 60_000,
      });
      evidence.push({ phase: "run-after-teardown", exitCode: startClosed.exitCode, stderrTail: redactSecrets(startClosed.stderr.trim().slice(-400)) });
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
      evidence.push({ phase: "run-unknown-id", exitCode: startUnknown.exitCode, stderrTail: redactSecrets(startUnknown.stderr.trim().slice(-300)) });
      expect(startUnknown.exitCode).toBe(4);
    } catch (e) {
      outcome = "fail";
      // HELD, not thrown (EB3): the post-finally verdicts below must render on
      // the red path too — the failing run is the one most likely to leak.
      failure = e;
      // B31: a non-Error throw (string, plain object) has no `message` — `String(?? e)` keeps the evidence entry populated instead of `undefined`.
      evidence.push({ phase: "test-error", error: String((e as Error)?.message ?? e) });
    } finally {
      // Built FIRST, in its own try, because everything below reads it — the
      // id-recovery arbitration immediately below AND the key verdict further
      // down. The write-mode constructor runs `assertDirMode0700`/`chmodSync`,
      // `assertExclusiveCreateSupported()` and `cleanStaleTemps()`, and an
      // EPERM/EROFS from any of them would escape this `finally` at the
      // argument expression — discarding the box-leak verdict and skipping the
      // evidence write and `settleRun`. (FX-E/1: this used to sit ~50 lines
      // BELOW the arbitration, so `recordStore?.get(runId)` read `undefined`
      // there and the E1-12 record-over-prose vmName arbitration was dead code
      // — a vmName wrongly recovered out of remediation prose reached
      // `destroyQuietly` unarbitrated. `get()` re-reads the record file on
      // every call, so constructing before the teardown verb still serves the
      // post-teardown `closedAt` here.)
      let recordStore: RunRecordStore | undefined;
      try {
        if (workspace !== "") recordStore = new RunRecordStore({ dir: join(workspace, "runs") });
      } catch (e) {
        evidence.push({ phase: "finally-store", ok: false, error: (e as Error).message });
      }
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
        // E1-12: the recovered `vmName` comes out of FREE REMEDIATION TEXT —
        // a suggestion line naming a box this round never owned (a stray-box
        // cleanup hint, an example command) would point `destroyQuietly` below
        // at a stranger's box. When the record exists it is the authority:
        // prefer its `vmName`, and if the record disagrees with the recovered
        // prose, record the disagreement and keep the RECORD's box (fail-safe:
        // the record is this round's own artifact, the prose is not).
        if (runId !== "") {
          try {
            const rec = recordStore?.get(runId) as { vmName?: string } | undefined;
            if (rec?.vmName !== undefined && rec.vmName !== "") {
              if (vmName !== "" && vmName !== rec.vmName) {
                evidence.push({ phase: "id-recovery-disagreement", fromText: vmName, fromRecord: rec.vmName });
              }
              vmName = rec.vmName;
            }
          } catch {
            // no record to arbitrate — the text recovery stands (last resort)
          }
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
      // GUARDED like every neighbouring leg (round 3, E1-5): `keyLeakProblems`
      // was the ONE finally leg with no non-throwing contract — a throw at this
      // await escaped the finally, `writeEvidenceQuietly` below never ran (a
      // paid round leaving NO evidence file), and the cleanup error replaced
      // the body's held error in `settleRun`. It renders into `keyProblems`
      // instead: the leak sweep's own failure is itself a cleanup problem.
      try {
        keyProblems = await keyLeakProblems(
          keyBaseline,
          { driver: ctx.driver, store: recordStore, runIds: [runId] },
          evidence,
        );
      } catch (keyErr) {
        keyProblems = [
          `key-leak sweep itself failed: ${keyErr instanceof Error ? keyErr.message : String(keyErr)} — treat the run key's revocation as UNVERIFIED`,
        ];
        evidence.push({ phase: "key-leak-sweep-failed", ok: false, error: keyProblems[0] });
      }
      // B25: the workspace holds the ONLY host-side copy of the harvested
      // artifacts (`<runId>-artifacts`: journal, trace.db, engine log) once
      // `destroyQuietly` above has erased the box copy. Deleting it on a RED
      // round — or on a round whose evidence write failed — destroyed the
      // forensics before `settleRun` rendered, and when the redaction sweep
      // failed (a credential found in the tar) it destroyed the very artifact
      // that shows WHERE the secret leaked. The RED-round keep is recorded
      // BEFORE the evidence write so the entry actually reaches the file; a
      // failed WRITE is already screamed onto stderr by `writeEvidenceQuietly`
      // itself, and the workspace is kept for that case too, below.
      if (workspace !== "" && failure !== undefined) {
        evidence.push({ phase: "workspace-kept", workspace, reason: "RED round — forensics kept" });
        try {
          process.stderr.write(
            `[T2.2] RED round: workspace ${workspace} KEPT for forensics (harvested artifacts under ${join(workspace, "runs")}); delete by hand once triaged\n`,
          );
        } catch {
          // dead stderr under an aborting runner — the evidence entry above still lands
        }
      }
      // `writeEvidenceQuietly` (F11): `writeEvidence` THROWS — the secret-scrub
      // refusal above all — and an uncaught throw here propagated out of this
      // `finally`, making `settleRun` below unreachable on exactly the run that
      // most needs it. B21: AWAITED like every sibling cleanup call (it is
      // synchronous today; the await is the asymmetry-proof so a future async
      // evidence write cannot race process exit and lose the file whose
      // PRESENCE is how a round is detected at all), and its return captured —
      // an empty path means the write FAILED, which the keep decision below
      // also keys on.
      const evidencePath = await writeEvidenceQuietly(
        "T2.2",
        "t2-2-in-box-engine",
        { test: "T2.2", outcome, runId, capMicroUsd: T2_CAP_MICRO_USD, evidenceDir: EVIDENCE_DIR, phases: evidence },
        destroyFailures,
      );
      if (workspace !== "" && failure === undefined && evidencePath !== "") {
        rmSync(workspace, { recursive: true, force: true });
      }
    }

    // The post-`finally` verdict (EB3), in ONE place: `settleRun` fails a green
    // run on a cleanup problem, and on a RED one ATTACHES the problem to the
    // body's own error instead of throwing over the top of it. B21: awaited
    // like its sibling cleanup calls, for the same asymmetry-proof reason.
    await settleRun(failure, [...fleetCleanupProblems(destroyFailures, finalBoxes, evidence), ...keyProblems]);
  },
  // Budget audit, priced at DECLARED CEILINGS and not at typical latency — the
  // tier2-dispatch-engine shape, for its reason: a bun test-timeout abort is the
  // ONE path where the `finally` above does not execute, so it is the one path
  // that leaves a real box billing AND a minted key live.
  //
  //   preflight          driver.whoami(), one control exec at the
  //                      DEFAULT_EXEC_TIMEOUT_MS class                 120 s
  //                      (round 6: inside the timed test, before the `try`,
  //                      and a control call of the same 120 s class the
  //                      in-box probes line prices — it gets a line too)
  //   pre-try key        listedKeyHashes BEFORE the try (F17), the same
  //                      account-wide listing the post-teardown line
  //                      allowances                               240 s
  //                      (round 6: same call, same allowance convention,
  //                      previously absent from the audit entirely)
  //   dispatch verb      T2_DISPATCH_TIMEOUT_MS 900_000 (was 1 200 s)     900 s
  //   in-box probes      3 × driver.exec at DEFAULT_EXEC_TIMEOUT_MS 120   360 s
  //                      (boxHome, manifest pair, durability probe)
  //   host-walk control  2 phase execs + 1 absence probe at 30 s each      90 s
  //                      + its readMarkerTolerant 2 × 10 (retry arm)      20 s
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
  //   readMarkerTolerant step 6's marker read, 2 ×
  //                      DEFAULT_PER_CALL_DEADLINE_MS 10_000               20 s
  //   Restart probe      systemctl show -p Restart at 30 s                 30 s
  //   replay leg (7b)    run verb 180 + 2 journal cats at 30              240 s
  //                      + REPLAY_LOG_ATTEMPTS 4 × (tail 30 + 5 wait)     135 s
  //   scratchClone       one real clone of the pinned sha, allowance      180 s
  //   harvest verb       runFleet timeoutMs 300_000                       300 s
  //   artifacts + reads  local extraction reads and the byte sweep         10 s
  //   journald read      step 8's degradation-reason probe at 30 s         30 s
  //   orphan leg (8b)    journal cat 30 + markerRoot ls 30 + guardProbe 30
  //                      + marker rm 30 + run verb 180
  //                      + REPLAY_LOG_ATTEMPTS 4 × (tail 30 + 5 wait)    135 s
  //                      + journal cat (after) 30
  //                      + orphan status poll 4 × (60 s verb + 5 wait)   255 s
  //                                                                      720 s
  //                      (round 3, E1-1: this line used to read "240 s" —
  //                      rm+verb+ONE tail — pricing a third of the leg's
  //                      declared ceilings; the sum below is the leg priced
  //                      by its own rule, at DECLARED ceilings.)
  //   teardown verb      runFleet timeoutMs 300_000                       300 s
  //   box-absence poll   awaitBoxAbsent maxAttempts 6 —
  //                      6 × control ls 120 + 5 × 10 s wait               770 s
  //   run-verb refusals  2 × runFleet timeoutMs 60_000 (closed, unknown)  120 s
  //   post-teardown      listedKeyHashes, allowance                       240 s
  //                                                              body ────────
  //                                                                     5 095 s
  //   …plus the round-3 corrections above (orphan leg +480, journald +30):
  //                                                            body ────────
  //                                                                     5 605 s
  //   …plus the round-4 corrections (B20): the box-absence poll priced at
  //   its CODE (maxAttempts 6, not 4: +260) and both readMarkerTolerant
  //   sites at their retry arm (10 → 20 each: +20):
  //                                                            body ────────
  //                                                                     5 885 s
  //   …plus the round-6 corrections: the two pre-try body legs the audit
  //   never carried (preflight whoami +120, pre-try listedKeyHashes +240):
  //                                                            body ────────
  //                                                                     6 245 s
  //   teardownQuietly    timeoutMs 180_000                                180 s
  //   destroyQuietly     CODE-WORST: 2 rm + 3 confirming list, all at
  //                      DEFAULT_EXEC_TIMEOUT_MS (driver.ts's destroy loop:
  //                      min rm+list 240, worst 2×rm+3×list)             600 s
  //                      (round 6: was priced "1 control rm at 120" — the
  //                      minimum path, not the worst case, on a leg whose
  //                      whole reason to exist is the MEASURED rm-exits-0-
  //                      box-still-listed destroy lag)
  //   fleetLeftovers     5 × (control ls 120 + 8 s wait) + its destroy
  //                      pass (another destroyQuietly at code-worst, 600,
  //                      round 6: was 120) + the confirming re-list     1 360 s
  //   key attribution    one listedKeyHashes, allowance                   120 s
  //   keyLeakProblems    delta list + fallback revoke + recheck list      360 s
  //   evidence + rmSync  local                                             10 s
  //                                                           finally ────────
  //                                                                     2 630 s
  //                                                                    ────────
  //                                                                     8 875 s
  //
  // Hence 9 000 s. Round 3 (E1-1) raised the sum 7 275 → 7 600 for an
  // under-priced orphan leg and an uncounted journald read; round 4 (B20)
  // found the audit had drifted from the code AGAIN inside this same file —
  // the box-absence line still priced 4 attempts while the call site says
  // maxAttempts 6 (round 3's own E1-6 change), and both readMarkerTolerant
  // sites were priced without their retry arm. Round 6 found the same drift
  // class in the `finally` and the pre-try legs: destroyQuietly priced at its
  // MINIMUM (one rm) instead of its code-worst (2 rm + 3 list = 600), the
  // same under-pricing riding inside fleetLeftovers' destroy pass, and the
  // audit carrying no line at all for the preflight whoami or the pre-try
  // listedKeyHashes. The corrected sum, 8 875 s, EXCEEDS the old 8 000
  // ceiling — i.e. the one abort the ceiling exists to make unreachable was
  // reachable again in the fully degraded regime — so the ceiling rises to
  // 9 000 s. The HEADER states the same figure. Every one of these ceilings
  // is a ceiling on a DEGRADED round and none is reached on a healthy one,
  // where the added legs cost seconds.
  //
  // Every inner ceiling FIRING is safe — it rejects into the catch and the
  // `finally` still runs — so the fail-safe direction for this number is UP: it
  // is what a fully degraded round may consume before the one abort that skips
  // cleanup, not a target. WHOEVER RAISES AN INNER CEILING, LENGTHENS THE POLL
  // OR ADDS A CLEANUP STEP MUST RE-ADD IT HERE, AND MUST UPDATE THE HEADER'S
  // BOX-TIME LINE WITH IT.
  9_000_000,
);
