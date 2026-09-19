/**
 * T3.8 — DF3.8 AC7: the detached completion → pause chain, on a real box.
 *
 * The DELTA over T2.8 (DF3.7's tier2-run-completion) is the whole story:
 * there, ONE invocation of `fleet observe <runId>` blocked in the foreground
 * on the engine's marker and drove the chain itself. Here, the host process
 * that started the run is GONE before the engine finishes, and a SEPARATE
 * `fleet observe --all` sweep — this story's own surface, invoked exactly the
 * way the documented cron line invokes it — is what finds the finished run
 * after the fact and drives DF3.7's chain for it:
 *
 *   `fleet dispatch` → `fleet run <runId>` (starts `qds-run@<runId>.service`
 *   and the verb RETURNS — AC7's real detachment, produced by DF1.10's verb,
 *   never by backgrounding a host process) → the engine walks its phases with
 *   NO host process attached → the marker settles → a separate
 *   `fleet observe --all` enumerates the open record, reads the settled
 *   marker through `readMarkerVerdict`'s one-tick shape, takes the run lock,
 *   and calls DF3.7's `observeAndDriveChain` — harvest → teardown →
 *   `reverify()` → the gate's `requestApproval` → the record rests at
 *   `awaiting-approval`, ready for `fleet approve`.
 *
 * CHARTER: story df3-8-host-completion-watcher.md AC7 + E2E Slice + the DoD
 * "e2e demo — MANDATORY" box. AC7's make-or-break claims, both honored here:
 * the host process exits BEFORE DF1.10's engine writes the marker (the exit
 * is `fleet run`'s own return, not a backgrounded host process, which would
 * leave a host process to fail and prove nothing), and a planted marker is
 * not evidence — this file writes nothing to the box's marker path, ever.
 * Unit coverage over a FakeDriver is legitimate for candidate selection, the
 * lock discipline and the uptime arithmetic, but MUST NOT be the sole
 * evidence for AC1/AC7 (DF3.4 AC6's no-doubles rule) — this file is that
 * evidence.
 *
 * WHY THE TEST POLLS THE MARKER ITSELF between `fleet run` and the sweep: a
 * sweep is not a wait (maxTicks 1, ONE marker read per candidate — the story
 * is explicit that inheriting DF3.7's window would park the pass behind an
 * unfinished run). So the test hands the sweep an ALREADY-SETTLED run: it
 * polls through the same shipped read/classify primitives (`readBoxFile` +
 * `classifyMarkerRead` — read-only, never a fleet verb, never the chain) so
 * the sequencing "engine wrote the marker, THEN a separate invocation read
 * it" is deterministic, exactly the E2E Slice's given/when/then. Between the
 * `fleet run` return and the sweep, NO fleet verb observes the run — the
 * detachment window contains only the test's own reads.
 *
 * WHY t3.pipeline.json AND NOT t2's: same as T2.8 — the chain's `reverify()`
 * returns `nothing-to-verify` (and observe maps that to `vetoed`, exit 6)
 * unless the sandbox carries a commit beyond base. t3's `t3-marker` phase
 * writes AND COMMITS a marker file from inside the engine walk, so the
 * harvest lands a real `refs/sandbox/<runId>` tip for reverify to judge.
 * Still a free workload — the money buys the PATH, not a model-heavy phase.
 *
 * THE HOST PLAN is operator-authored here, on purpose (INV-RV-1: reverify
 * never trusts the harvested tree to judge itself). T5.1's live-proven shape,
 * same pin as T2.8: `.factory/pipeline.json` keyed by the RECORD's canonical
 * repoSlug, pinning the same small hermetic judging suite
 * (`bun test tests/fleet/approvers.test.ts`, ~7.5 s, no network — measured
 * 2026-08-30). Authored into the scratch clone BEFORE `fleet run`, so a plan
 * failure costs no engine start.
 *
 * THE NEVER-PLANTED PROOF (AC7): after `fleet run` returns and the unit is
 * armed, the marker is read once through the SAME primitives `fleet status`
 * and the fan-out race use — `readBoxFile` + `classifyMarkerRead(read,
 * runId)` — and must classify `absent` (engine still walking — the expected
 * shape seconds after the fork, and the reading that proves the verb exited
 * BEFORE the engine finished) or `settled` with `ok:true` (a very fast
 * engine). Either way the reading is the ENGINE's, classified with
 * `expectedRunId` through the shipped grammar: a marker naming any other run
 * classifies `unusable / marker-run-mismatch` and this leg fails by name.
 *
 * GATING: QDS_E2E_LIVE=1 AND QDS_E2E_TIER=2 — `liveGate("2")` throws on a
 * tier mismatch or a half-configured substrate env. The "tier3" FILENAME is
 * the audit-wave label (the host-orchestration shape tier3-race/tier3-reaper
 * hold: two host invocations with a real detachment between them plus a
 * fleet-wide enumeration), NOT an env value — `liveGate` takes only "1"|"2".
 * Normal `bun test`/CI: todo. Execution of this round is the DF3.8 branch
 * gate, run by the driver via the qds-live-e2e skill — never from this leaf.
 *
 * SPEND (operator-approved out of band, e2e budget protocol): ONE dispatch —
 * 1 key capped at 50,000 µ$ (the setup gate's C/D roster-model pings + the
 * armed resident's run_start/run_end solicitations) + ONE box for up to the
 * runner ceiling below (8,500 s ≈ 2.4 h at 230,000 µ$/h ≈ 543,000 µ$).
 * Worst case ≈ $0.60. A HEALTHY round finishes in minutes. The machine-checked
 * box-hours ceiling in step 13 is TIGHTER than that approval on purpose
 * (T38_BOX_HOURS_CEILING_MICRO_USD — the PLANNED window, ≈ 499,000 µ$), so a
 * box that out-bills the plan fails the audit while the round's assertions
 * still run, not only on the abort path where no assertion runs at all.
 *
 * LIVE-ROUND RUNNER (L16): the whole file is ONE todoIf test — a round that
 * never selected it reports one `(todo)` and a green summary. Name this path
 * EXPLICITLY and check for its evidence JSON
 * (`_bmad-output/evidence/df3-e2e/<date>-*-df3-8-observe-detached-*.json`).
 * This file does NOT write `_bmad-output/evidence/df3-8/` — the sweep's own
 * evidence (the reboot counters, INV-IBOX-19) is the driver's concern at the
 * live round; the FULL parsed `sweep-complete` line rides THIS file's
 * evidence payload so the counters can be extracted from it.
 *
 * NO FAKES of any kind: real ssh exec, real systemd, real OpenRouter key API,
 * real `bun scripts/fleet.ts` subprocesses, real git bundle and refs.
 */
import { expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// The marker path is derived ONCE, host-side, through the shipped
// `boxMarkerPath(runId)` (AC4) — never `runMarkerPath()`, which reads a HOST
// env var, and never an inlined literal. `fleet status`, the fan-out race and
// the sweep's own reads address the same constant, so this file and the verbs
// speak one path by construction.
import { boxMarkerPath, classifyMarkerRead, DEFAULT_PER_CALL_DEADLINE_MS } from "../../../src/fleet/fanout-primitive.ts";
import { runUnitName } from "../../../src/fleet/run.ts";
import { readBoxFile } from "../../../src/providers/exedev/transport.ts";
import type { BoxFileRead } from "../../../src/providers/exedev/transport.ts";
import { RunRecordStore } from "../../../src/providers/run-record.ts";
// Verb tails are pre-redacted (B24: a tail slice can CUT a credential
// mid-token, which the evidence scrub cannot match but its refusal assert
// hits — a paid round would leave NO evidence file).
import { redactSecrets } from "../../../src/providers/step-log.ts";
import type { LiveCtx } from "./live-harness.ts";
import {
  EVIDENCE_DIR,
  REPO_ROOT,
  awaitWithCeiling,
  destroyQuietly,
  emittedRunId,
  fleetCleanupProblems,
  fleetLeftovers,
  fleetPartialOutput,
  keyLeakProblems,
  lastJsonLine,
  ledgerRows,
  listedKeyHashes,
  liveGate,
  liveTodoOff,
  preflight,
  recoverDispatchIds,
  runFleet,
  scratchClone,
  settleRun,
  teardownQuietly,
  tmpWorkspace,
  writeEvidenceQuietly,
} from "./live-harness.ts";

/** Plan default (e2e-plan.md §TIER-2): 50,000 µ$ = $0.05 worst-case per key. */
const T38_CAP_MICRO_USD = 50_000;
/** Box-hour rate from the operator's TIER-1 cost config (230,000 µ$/h). */
const T38_BOX_HOUR_RATE_MICRO_USD = 230_000;

/**
 * The bun runner ceiling for this whole test — the budget audit at the foot of
 * the file prices every inner ceiling up to this total plus margin. Same
 * figure as T2.8's: this round REDISTRIBUTES T2.8's 3,600 s observe term
 * (window 2,700 + chain 900) as engine poll 2,700 + sweep 900 — the audit's
 * sum is unchanged, and the derivation is stated in the footer. (The box-hours
 * ASSERTION no longer derives from this figure — see
 * T38_BOX_HOURS_CEILING_MICRO_USD below for why the runner-derived bound was
 * circular.)
 */
const T38_RUNNER_TIMEOUT_MS = 8_500_000;

/**
 * The scratchClone ceiling, named so the budget audit's scratchClone row names
 * it too. CURRENTLY DECORATIVE, said plainly (T30): scratchClone runs its git
 * steps synchronously (`spawnSync`), so the whole clone completes — or wedges
 * with the event loop blocked — before `awaitWithCeiling` ever receives the
 * promise, and a ceiling cannot fire on an already-settled value. The guards
 * that actually bound this leg are (1) the PRE-DISPATCH http(s)-origin scheme
 * refusal in the body (an ssh:// fetch ignores git's stall switch and would
 * be bounded by nothing but this test's refusal) and (2) scratchClone's own
 * in-git `http.lowSpeedLimit/lowSpeedTime` stall switch (a fetch moving
 * < 1 B/s for 180 s aborts) — which is why the audit row still prices 180 s.
 * The named ceiling bounds any FUTURE async shape of the helper and keeps the
 * audit arithmetic honest.
 */
const T38_CLONE_TIMEOUT_MS = 180_000;

/**
 * The manifest `fleet dispatch` delivers and the IN-BOX ENGINE walks. t3's,
 * not t2's, for the same reason as T2.8: the `t3-marker` phase COMMITS a file
 * from inside the engine walk, which is what keeps the chain's `reverify()`
 * off its `nothing-to-verify` arm. Three `code` phases, no model-heavy work —
 * a free workload on purpose.
 */
const T38_MANIFEST_PATH = "config/rosters/t3.pipeline.json";

/**
 * The dispatch ceiling — T2.2's figure for the SAME verb (box provision + the
 * A–E setup gate, C/D being real roster-model pings). The single largest term
 * in the budget audit at the foot of this file.
 */
const T38_DISPATCH_TIMEOUT_MS = 900_000;

/** `fleet run` returns at the fork (T2.2's step-4 shape); 180 s is its audit price. */
const T38_RUN_VERB_TIMEOUT_MS = 180_000;

/**
 * How long the test polls the engine's marker before handing the run to the
 * sweep. T2.8's observe-window class (45 min), priced for a DEGRADED round —
 * a healthy t3 manifest settles in minutes. The poll is the test's own
 * read-only bridge (see the header): the sweep gets ONE marker read per
 * candidate, so it must be handed a run that has already settled. A window
 * that expires means the engine never finished, and the leg fails by name
 * rather than handing the sweep an unsettled candidate it would correctly
 * count `runs_unsettled` and leave behind.
 */
const T38_ENGINE_WINDOW_MS = 2_700_000;

/** The poll tick — each cycle is one bounded `readBoxFile` (10 s class). */
const T38_ENGINE_POLL_INTERVAL_MS = 5_000;

/**
 * The sweep verb's subprocess ceiling. NO window term: the sweep does not
 * wait (maxTicks 1, one marker read per candidate). What it can spend is
 * enumeration (two bounded reads per candidate — one candidate here) plus ONE
 * chain: `teardownSandbox` (T2.2/T5.1's 300 s teardown figure) + `reverify()`
 * (T5.1's own measured 420 s ceiling for the quarantine worktree + the
 * judging suite) + margin — the same chain allowance T2.8 priced behind its
 * observe window.
 */
const T38_SWEEP_VERB_TIMEOUT_MS = 900_000;

/** The cleanup `fleet teardown` ceiling (T2.2's finally figure). */
const T38_CLEANUP_TEARDOWN_TIMEOUT_MS = 180_000;

/**
 * The PLANNED box-billing window (T31): the span from the box's creation
 * inside the dispatch verb to its destruction in the finally, priced at the
 * audit rows' DECLARED ceilings — every term below is a line in the footer's
 * audit, none is latency. The preflight and baseline-key rows are deliberately
 * absent (they run before the box exists and bill nothing); the post-destroy
 * cleanup tail (leftovers/keyLeak/evidence) is deliberately INCLUDED as
 * headroom: the substrate's destroy lag means billing realistically stops
 * somewhere inside `fleetLeftovers`' poll, and a ceiling must sit at or above
 * every legitimate billing shape.
 *
 *   dispatch 900 + list 120 + clone 180 + run 180 + liveness 60 + marker 20
 *   + engine window 2 700 + sweep 900 + post keys 240 + teardown 180
 *   + destroy 600 + leftovers 1 360 + keyLeak 360 + evidence 10 = 7 810 s
 */
const T38_BOX_PLANNED_WINDOW_MS =
  T38_DISPATCH_TIMEOUT_MS +
  120_000 +
  T38_CLONE_TIMEOUT_MS +
  T38_RUN_VERB_TIMEOUT_MS +
  60_000 +
  20_000 +
  T38_ENGINE_WINDOW_MS +
  T38_SWEEP_VERB_TIMEOUT_MS +
  240_000 +
  T38_CLEANUP_TEARDOWN_TIMEOUT_MS +
  600_000 +
  1_360_000 +
  360_000 +
  10_000;

/**
 * The box-hours ceiling (T31): the PLANNED window above at the configured
 * rate — 7 810 000 ms ≈ 2.17 h × 230 000 µ$/h ≈ 498 973 µ$. The PREVIOUS
 * derivation (the whole T38_RUNNER_TIMEOUT_MS ≈ 543 056 µ$) was circular: a
 * box can only out-bill the RUNNER ceiling on the timeout abort that skips
 * the finally — the one path where no assertion runs — so the old bound could
 * never fire on a round that reaches its own audit. This one can: a round
 * that COMPLETES with a box-hours total over the plan fails here while every
 * other assertion still ran. Headroom check against reality: the observed
 * green round billed ~175 s ≈ 11 000 µ$, 45× under this ceiling, so a
 * healthy-but-slow round does not flake on it.
 */
const T38_BOX_HOURS_CEILING_MICRO_USD = Math.ceil((T38_BOX_PLANNED_WINDOW_MS / 3_600_000) * T38_BOX_HOUR_RATE_MICRO_USD);

/**
 * The post-dispatch positive-control `driver.list()` ceiling (T26) — the
 * audit's 120 s "positive control" row, now NAMED because the await it bounds
 * is a raw driver call with no self-bound of its own. An unbounded one is
 * exactly the runner-timeout-abort path whose finally-skip leaks the billing
 * box this very control proved listed.
 */
const T38_LIST_CEILING_MS = 120_000;

/**
 * The F17 key-listing ceiling (T26) — the audit's 240 s "post keys" row, now
 * NAMED. The post-chain `listedKeyHashes()` is a raw HTTP walk with pages; a
 * wedged listing hangs the await with the box still owned, which is the same
 * abort path. (The PRE-TRY baseline listing at the top of the try owns
 * nothing — no box, no key — so a hang there costs a dead round, never a
 * leak; it stays unwrapped by scope, not by oversight.)
 */
const T38_KEY_LIST_CEILING_MS = 240_000;

/**
 * The engine-settled poll's consecutive-unreadable fast-fail bound (T32).
 * `unusable` markers already break the poll immediately; what could spin the
 * whole 45-min window was the COUNTABLE-but-non-settled tick class — reads
 * that REJECT (transport throws, T27) and `skip` verdicts (probe exit 255:
 * the box never answered). Ten consecutive such ticks (≤ ~2.5 min at the 5 s
 * tick + 10 s read deadline) means the marker is persistently UNREADABLE, not
 * absent and not slow — fail then, before the window bills the rest of itself.
 */
const T38_POLL_UNREADABLE_LIMIT = 10;

/**
 * Every `{…}` JSON line a fleet verb wrote on a stream, parsed defensively and
 * REDACTED at parse (the file's B24 rule applied to structured lines: a
 * secret-like field inside a parsed line reaches the evidence write raw, and
 * `writeEvidence`'s scrub REFUSAL on it would leave a paid round with no
 * evidence file at all). Lines starting with `{` that do not parse are
 * counted, never dropped silently: the count and the first failing raw text
 * (redacted, capped) ride the evidence entry that consumes them.
 */
function jsonLines(text: string): { lines: Record<string, unknown>[]; dropped: { count: number; first: string } } {
  const lines: Record<string, unknown>[] = [];
  let droppedCount = 0;
  let firstDropped = "";
  for (const l of text.split("\n")) {
    if (!l.startsWith("{")) continue;
    try {
      lines.push(JSON.parse(redactSecrets(l)) as Record<string, unknown>); // dp:ok guarded by this try/catch — dp020_guarded itself returns "guarded" here; the finding is its early-exit pipeline taking SIGPIPE under `set -o pipefail` (exit 141 read as unguarded — tier2-run-completion.live.test.ts:201, the identical shape, exits 141 the same way)
    } catch {
      droppedCount += 1;
      if (firstDropped === "") firstDropped = redactSecrets(l.trim().slice(0, 300));
    }
  }
  return { lines, dropped: { count: droppedCount, first: firstDropped } };
}

/**
 * A REJECTED `readBoxFile` rendered as the transport's own fail-closed
 * `unreadable` shape (T27): `readBoxFile` can THROW (driver exec failure, a
 * `withTimeout` fire), and the transport's contract is "EVERY caller handles
 * a rejection" — this file's three direct call sites used not to. `exitCode
 * -1` is the transport's "no process ever ran" sentinel, so the classifier
 * reads it as present-or-unknown and unjudgeable — never a fabricated
 * absence — and the rejection's own text rides `stderr` where every
 * diagnostic below looks.
 */
function rejectedBoxRead(e: unknown): BoxFileRead {
  return {
    kind: "unreadable",
    exitCode: -1,
    stderr: `readBoxFile rejected (transport throw): ${e instanceof Error ? e.message : String(e)}`,
  };
}

test.todoIf(liveTodoOff())(
  "T3.8 DF3.8 AC7: dispatch→fleet run (verb EXITS, engine detached)→marker settles unobserved, never planted→separate `fleet observe --all` sweep drives the chain→awaiting-approval — real box, real spend ≤ 50,000 µ$ + box-hours",
  async () => {
    liveGate("2");
    // REFUSED BEFORE ANY SPEND (T2.2's belt-and-braces tripwire): a stray host
    // `QDS_RUN_ROOT` export is a debugging lever the box never sets, and a
    // paid round should not run in a shell that carries one. This file, the
    // single-run observer AND the sweep all address the box through the
    // imported `boxMarkerPath` constant, so the variable cannot redirect the
    // probes — the refusal is the tripwire for the shell, not a load-bearing
    // guard.
    const hostRunRoot = (process.env.QDS_RUN_ROOT ?? "").trim(); // dp:ok optional env — blank IS "unset", and a non-empty value is REFUSED by name in the throw below; tier2-run-completion.live.test.ts:220 verbatim
    if (hostRunRoot !== "") {
      throw new Error(
        `QDS_RUN_ROOT is exported host-side as ${JSON.stringify(hostRunRoot)}. It is a HOST-side test lever the box never sets, and no live round should inherit one — unset it and re-run.`,
      );
    }
    // Same tripwire class, two more levers: a stray QDS_COST_CONFIG_FILE /
    // QDS_COST_LEDGER_FILE export wins over the cost config this file writes
    // into its own workspace below, so dispatch would admit under a FOREIGN
    // cap and the chain's box-hours close would settle into an OUTSIDE ledger
    // — both silently defeating the 50,000 µ$ / 230,000 µ$/h figures this
    // round is approved for.
    for (const name of ["QDS_COST_CONFIG_FILE", "QDS_COST_LEDGER_FILE"]) {
      const value = (process.env[name] ?? "").trim(); // dp:ok optional env — blank IS "unset", and a non-empty value is REFUSED by name in the throw below; tier2-run-completion.live.test.ts:233 verbatim
      if (value !== "") {
        throw new Error(
          `${name} is exported host-side as ${JSON.stringify(value)}. This round must admit under the cost config it writes into its own workspace and settle box-hours into the ledger beside its records — unset it and re-run.`,
        );
      }
    }
    const evidence: Record<string, unknown>[] = [];
    let ctx: LiveCtx | undefined;
    let workspace = "";
    let runId = "";
    let vmName = "";
    let dispatchOut = "";
    let dispatchErr = "";
    let outcome = "pass";
    /** The body's own error, HELD so the post-finally verdicts run on the failing path too (EB3). */
    let failure: unknown;
    /** The record's own dispatch correlation stamp — the pause event's join key. */
    let recordRequestId = "";
    /** The sweep's terminal line, captured WHOLE for the driver's counter extraction (INV-IBOX-19). */
    let sweepCompleteLine: Record<string, unknown> | undefined;
    /**
     * The out-of-band reaper's handle (P11): created BEFORE dispatch, filled
     * at the ack, kept on failure, gone only on a fully green round — which is
     * the workspace rmSync below, because the file lives inside the workspace.
     */
    let orphanRecoveryPath = "";
    /** Destroys that FAILED (#189) — asserted AFTER the finally, never only recorded. */
    const destroyFailures: string[] = [];
    /** The final leak listing, hoisted: its verdict is asserted OUTSIDE the finally's catch. */
    let finalBoxes: string[] | undefined;
    /** The F17 key-population verdict, rendered in the finally. */
    let keyProblems: string[] = [];
    /** Key hashes before the run (F17) — snapshotted INSIDE the try (P28). */
    let hashesBefore: Set<string> | undefined;
    try {
      ctx = await preflight("2");
      // REFUSED BEFORE DISPATCH (P1): a box is already owned by clone time,
      // and scratchClone's transfer-stall switch is git's HTTP-transport
      // config — an ssh:// (or any non-http(s)) origin IGNORES it, so a wedged
      // fetch there is bounded only by the runner timeout: the one abort that
      // skips the finally and leaks the box + the minted key. scratchClone
      // itself only NOTES the caveat (an ssh pin is legitimate elsewhere);
      // this round does not need one badly enough to buy that leak path, so it
      // refuses while nothing is owned yet.
      if (!/^https?:\/\//i.test(ctx.repoUrl)) {
        const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(ctx.repoUrl)?.[1] ?? "(no scheme)";
        throw new Error(
          `QDS_EXEDEV_REPO_URL origin scheme is ${JSON.stringify(scheme)} — this test refuses a non-http(s) origin BEFORE dispatch, because a box is already owned by clone time and scratchClone's http.lowSpeed* stall switch does not apply to that transport. Pin an http(s) origin and re-run.`,
        );
      }
      hashesBefore = await listedKeyHashes();
      workspace = tmpWorkspace("t38");
      const recordsDir = join(workspace, "runs");
      mkdirSync(recordsDir, { recursive: true });
      // P11: the reaper's well-known scratch file, created BEFORE dispatch so
      // a process death mid-dispatch still marks a round in flight. It is
      // rewritten with {runId, vmName, keyHash} the moment the dispatch ack
      // lands (keyHash added at the record read — all before any spend-heavy
      // leg), so an out-of-band reaper / post-mortem can destroy the orphan
      // box and revoke the key from these three fields if THIS process dies
      // owning them. It is KEPT on failure (it IS the recovery artifact, and
      // the workspace is kept on every non-green posture) and removed only on
      // a fully green round, riding the workspace rmSync at the foot of the
      // finally.
      orphanRecoveryPath = join(workspace, "orphan-recovery.json");
      writeFileSync(orphanRecoveryPath, `${JSON.stringify({ phase: "pre-dispatch" })}\n`);
      evidence.push({
        phase: "orphan-recovery-file",
        path: orphanRecoveryPath,
        note: "{runId, vmName, keyHash} for an out-of-band reaper if this process dies owning a box or key — kept on failure, removed only on full green success",
      });
      // BESIDE the records dir (costLedgerOpts → dirname(recordsDir)): without
      // it admission falls back to defaultCapMicroUsd 5,000,000 µ$ ($5!) and
      // the chain's box-hours close fail-louds `box-hour-rate-unconfigured`.
      writeFileSync(
        join(workspace, "cost-config.json"),
        JSON.stringify({ defaultCapMicroUsd: T38_CAP_MICRO_USD, boxHourRateMicroUsd: T38_BOX_HOUR_RATE_MICRO_USD }),
      );
      const briefPath = join(workspace, "brief.json");
      writeFileSync(
        briefPath,
        JSON.stringify({
          repoSlug: "Quantum-Digital-Solutions/QDS-Factory",
          issueId: 46,
          commitSha: ctx.sha,
          manifestPath: T38_MANIFEST_PATH,
          repoUrl: ctx.repoUrl,
        }),
      );
      evidence.push({ phase: "setup", ok: true, capMicroUsd: T38_CAP_MICRO_USD, manifestPath: T38_MANIFEST_PATH });

      // ── 1. dispatch: box + fill + the manifest pair + the setup gate ──────
      // The `.catch` is the L1 fix: `dispatch` creates a real box before it
      // can still fail, and a ceiling rejection left both streams "" so every
      // guarded cleanup leg skipped — a leaked box reported as a stray.
      const dispatch = await runFleet(
        ["dispatch", "--driver", "exedev", "--brief", briefPath, "--dir", recordsDir],
        { cwd: REPO_ROOT, timeoutMs: T38_DISPATCH_TIMEOUT_MS },
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
        stdoutTail: redactSecrets(dispatch.stdout.trim().slice(-400)),
        stderrTail: redactSecrets(dispatch.stderr.trim().slice(-600)),
      });
      // Ownership armed BEFORE the assertion that can throw — `dispatch` names
      // a box before it can still fail (emittedRunId's whole rationale).
      const emitted = emittedRunId(dispatch.stdout, dispatch.stderr);
      if (emitted !== undefined) runId = emitted;
      expect(dispatch.exitCode).toBe(0);
      const ack = lastJsonLine<{ runId: string; vmName: string; state: string }>(dispatch.stdout);
      // The two reads of the minted id must AGREE (T2.2's E1-8): a divergence
      // is a real defect, not a choice between the two.
      expect(ack.runId).toBe(runId);
      runId = ack.runId;
      vmName = ack.vmName;
      expect(ack.state).toBe("ready");
      evidence.push({ phase: "ack", runId, vmName });
      // The ack landed and a real box now exists — arm the reaper's file
      // IMMEDIATELY (P11), before any spend-heavy leg can begin.
      writeFileSync(orphanRecoveryPath, `${JSON.stringify({ runId, vmName, keyHash: null })}\n`);
      // POSITIVE CONTROL for the final-ls verdict (T5.1's shape): prove the
      // listing CAN see this run's box before the end of the round asserts
      // no box of ours survives. CEILED (T26): a raw `driver.list()` await
      // has no self-bound, and a wedged listing here is exactly the
      // runner-timeout abort whose finally-skip leaks the box + the minted
      // key — the audit's own thesis. The ceiling is the audit's 120 s row,
      // now named (T38_LIST_CEILING_MS).
      const listedBoxes = await awaitWithCeiling(ctx.driver.list(), T38_LIST_CEILING_MS, "t3.8-positive-control-list");
      expect(listedBoxes.some((b) => b.name === vmName)).toBeTrue();

      // ── 2. the record carries the identity every join below keys on ──────
      const store = new RunRecordStore({ dir: recordsDir });
      const rec = store.get(runId);
      expect(rec.vmName).toBe(vmName);
      expect(rec.commitSha).toBe(ctx.sha);
      expect(rec.keyHash ?? "").not.toBe(""); // dp:ok the coalescing IS the validation — undefined coerces to the very sentinel this assert rejects (dropping it would let undefined PASS .not.toBe("")); tier2-run-completion.live.test.ts:375 verbatim
      expect(rec.limitMicroUsd).toBe(T38_CAP_MICRO_USD);
      // requestId is the JOIN KEY for the pause event below — `""` would make
      // that comparison pass while joining on nothing, so it is refused here
      // (T5.1's rule at its :420-425).
      expect(typeof rec.requestId).toBe("string");
      expect(rec.requestId ?? "").not.toBe(""); // dp:ok coaxes undefined into the sentinel this assert rejects — the join key must be non-empty (T5.1's rule); tier2-run-completion.live.test.ts:381 verbatim
      recordRequestId = rec.requestId as string;
      // The minted key's hash completes the reaper's triple — still before any
      // spend-heavy leg (the clone, the run, the sweep all come later).
      writeFileSync(orphanRecoveryPath, `${JSON.stringify({ runId, vmName, keyHash: rec.keyHash })}\n`);
      // The slug the RECORD carries — dispatch canonicalizes case, and
      // `resolveHostPlan` matches the operator index EXACTLY by this value,
      // so the host plan below is keyed by the record, never by the brief.
      const slug = rec.extensions?.budget?.repoSlug;
      expect(typeof slug).toBe("string");
      expect(slug ?? "").not.toBe(""); // dp:ok coaxes undefined into the sentinel this assert rejects — the host plan's join key must be non-empty; tier2-run-completion.live.test.ts:391 verbatim
      const recordSlug = typeof slug === "string" ? slug : "";
      evidence.push({
        phase: "record",
        ok: true,
        keyHash: rec.keyHash,
        limitMicroUsd: rec.limitMicroUsd,
        requestId: recordRequestId,
        recordSlug,
      });

      // ── 3. the host clone + the OPERATOR host plan reverify will judge by ─
      // BEFORE `fleet run`, so a plan failure costs no engine start. The
      // clone is also THE SWEEP's cwd: the sweep asserts hostRoot is a git
      // worktree at start-up (AC6 — a cron run from $HOME must refuse BEFORE
      // any candidate is driven), teardown's harvest fetches the sandbox ref
      // into it, and reverify's quarantine worktree is cut from it.
      // The named ceiling (P1): see T38_CLONE_TIMEOUT_MS — belt-and-braces on
      // the http(s) transports scratchClone's own http.lowSpeed* switch
      // already bounds, and the audit row's honest named ceiling.
      const hostRepo = await awaitWithCeiling(
        scratchClone(ctx.repoUrl, ctx.sha, workspace),
        T38_CLONE_TIMEOUT_MS,
        "t3.8-scratch-clone",
      );
      const factoryDir = join(hostRepo, ".factory");
      mkdirSync(factoryDir, { recursive: true, mode: 0o700 });
      chmodSync(factoryDir, 0o700);
      writeFileSync(
        join(factoryDir, "pipeline.json"),
        JSON.stringify({
          version: 1,
          repos: {
            [recordSlug]: {
              manifest: ".factory/t38-host-plan.json",
              noTestSuite: false,
            },
          },
        }),
      );
      // T5.1's live-proven plan, renamed: loadManifest REFUSES <2 phases, the
      // `testCommand` is the judging suite reverify actually runs, and the
      // second phase is the real gate leg. The budget rule (3× per-attempt
      // ceiling + margins ≤ runBudgetMs) is why 60k/10k under 300k.
      writeFileSync(
        join(factoryDir, "t38-host-plan.json"),
        JSON.stringify({
          version: "1.0.0",
          pipelineId: "t38-host-plan",
          runBudgetMs: 300_000,
          phases: [
            {
              name: "t38-host-tests",
              kind: "code",
              description: "T3.8 operator-pinned judging suite: small, hermetic, no network (T5.1's measured pin).",
              command: ["true"],
              testCommand: ["bun", "test", "tests/fleet/approvers.test.ts"],
              maxDurationMs: 60_000,
              retries: 0,
            },
            {
              name: "t38-host-gate",
              kind: "code",
              description: "T3.8 operator-pinned gate leg: exit 0, no inputs.",
              command: ["true"],
              maxDurationMs: 10_000,
              retries: 0,
            },
          ],
        }),
      );
      chmodSync(join(factoryDir, "pipeline.json"), 0o600);
      chmodSync(join(factoryDir, "t38-host-plan.json"), 0o600);
      evidence.push({ phase: "host-plan", ok: true, hostRepo, keyedBy: recordSlug });

      // ── 4. AC7's REAL DETACHMENT — `fleet run`: start the unit and RETURN ─
      // DF1.10's verb starts `qds-run@<runId>.service` over real ssh and
      // EXITS at the fork; `runFleet` resolves only when the child process is
      // GONE (`proc.exited`), so reaching the assertions below at all IS the
      // proof the dispatching host process is gone while the engine keeps
      // walking in the box. Backgrounding a host process here would prove
      // nothing AC7 claims — the story is explicit about that — and this file
      // never invokes the single-run foreground observer to bridge the gap:
      // the NEXT fleet verb to touch the run is the sweep at step 8.
      const runStartedAt = Date.now();
      const start = await runFleet(["run", runId, "--driver", "exedev", "--dir", recordsDir], {
        cwd: REPO_ROOT,
        timeoutMs: T38_RUN_VERB_TIMEOUT_MS,
      });
      const runVerbMs = Date.now() - runStartedAt;
      evidence.push({
        phase: "run-verb",
        exitCode: start.exitCode,
        runVerbMs,
        note: "runFleet resolves on proc.exited — the dispatching host process is GONE from here on; the engine walks under systemd with no host process attached",
        stdout: redactSecrets(start.stdout.trim().slice(0, 300)),
        stderrTail: redactSecrets(start.stderr.trim().slice(-400)),
      });
      expect(start.exitCode).toBe(0);
      expect(start.stdout).toContain(`started: ${runId}`);

      // ── 5. POSITIVE LIVENESS CONTROL — the unit at least armed ───────────
      // The `absent` reading at step 6 is legitimate (engine still walking)
      // but it cannot by itself tell "walking" from "never armed": a `fleet
      // run` that exited 0 with a unit that never started would otherwise
      // burn the whole engine window before failing generically. One cheap
      // `systemctl show` through the sibling idiom (tier2-in-box-engine's
      // unit probe) proves the unit armed — and that the ENGINE, not the
      // departed host process, is what is running: ACTIVE states are
      // armed-and-running, and inactive/success/0 is armed-and-already-done
      // (the engine writes its marker BEFORE it exits, so a very fast engine
      // can already be finished here). `deactivating` is that same fast exit
      // caught mid-cleanup. `inactive` on any other result — or `failed` —
      // never armed, and this leg fails by name.
      //
      // T28 closes the one posture those states could not discriminate: a
      // unit that sat IDLE its whole life also reports
      // ActiveState=inactive / Result=success / ExecMainStatus=0 — systemd's
      // defaults for a unit whose start job never ran a main process. The
      // `ExecMainPID` property is the discriminator: systemd assigns it at
      // fork and RETAINS the last main PID after the process exits (only
      // `MainPID` zeroes), so > 0 proves an engine process actually exec'd
      // under this unit — live OR already-finished — while an idle stand-in
      // reads 0 and fails by name below.
      const { driver } = ctx; // narrowed here; the closure below cannot keep the outer `let` narrowed
      const unitShow = (): Promise<string> =>
        driver
          .execTimed(
            vmName,
            [
              "systemctl",
              "show",
              runUnitName(runId),
              "-p",
              "ActiveState",
              "-p",
              "Result",
              "-p",
              "ExecMainStatus",
              "-p",
              "ExecMainPID",
            ],
            30_000,
          )
          .then((r) => r.stdout);
      let unitStdout = "";
      try {
        unitStdout = await unitShow();
      } catch {
        // ONE retry for the cold first-ssh multiplex (the marker read's own
        // idiom below): a probe that cannot answer once is not a dead unit.
        evidence.push({ phase: "unit-liveness-retry", note: "first probe did not answer — one retry before failing" });
        try {
          unitStdout = await unitShow();
        } catch (retryErr) {
          throw new Error(
            `unit-liveness control could not probe ${runUnitName(runId)} on ${vmName} after one retry: ${retryErr instanceof Error ? retryErr.message : String(retryErr)}`,
          );
        }
      }
      const activeState = /ActiveState=(\S*)/.exec(unitStdout)?.[1] ?? ""; // dp:ok an unmatched capture reads "" and fails the armed check below BY NAME, with this raw value in the message; tier2-run-completion.live.test.ts:520 verbatim
      const probeResult = /Result=(\S*)/.exec(unitStdout)?.[1] ?? ""; // dp:ok an unmatched capture reads "" and fails the armed check below BY NAME, with this raw value in the message; tier2-run-completion.live.test.ts:521 verbatim
      const mainStatus = /ExecMainStatus=(\S*)/.exec(unitStdout)?.[1] ?? ""; // dp:ok an unmatched capture reads "" and fails the armed check below BY NAME, with this raw value in the message; tier2-run-completion.live.test.ts:522 verbatim
      const mainPid = Number(/ExecMainPID=(\S*)/.exec(unitStdout)?.[1] ?? ""); // dp:ok an unmatched/missing property reads NaN and fails the > 0 term of the armed check below BY NAME, with this raw value in the message (T28)
      const armed =
        mainPid > 0 &&
        (["activating", "active", "reloading", "deactivating"].includes(activeState) ||
          (activeState === "inactive" && probeResult === "success" && mainStatus === "0"));
      evidence.push({
        phase: "unit-liveness",
        runId,
        unit: runUnitName(runId), // live-mirror: runUnitName (src/fleet/run.ts:264) — the per-run systemd unit name DF1.10's `fleet run` starts
        activeState,
        result: probeResult,
        mainStatus,
        mainPid,
        armed,
      });
      if (!armed) {
        throw new Error(
          `unit-liveness control failed: ${runUnitName(runId)} never armed (ActiveState=${activeState} Result=${probeResult} ExecMainStatus=${mainStatus} ExecMainPID=${/ExecMainPID=(\S*)/.exec(unitStdout)?.[1] ?? "(missing)"}) — fleet run exited 0 without an engine process having run under the unit (T28: an idle unit cannot stand in for the engine)`,
        );
      }

      // ── 6. AC7's NEVER-PLANTED proof, through the shared primitives ──────
      // One tolerant read (ONE retry on `unreadable` only — E1-10's cold
      // first-ssh multiplex; a retry cannot fabricate presence), classified
      // with `expectedRunId`. This file writes no marker, so whatever the
      // sweep is about to consume was already on the box, written by the
      // engine: `absent` (still walking — the expected shape seconds after
      // the fork, and the reading that proves the verb exited BEFORE the
      // engine finished) or `settled` with `ok:true` (a very fast engine). A
      // foreign or hand-planted marker classifies `unusable` and this leg
      // names the code.
      //
      // T27: a REJECTED read folds into that same one-retry arm — the
      // rejection is rendered as the transport's fail-closed `unreadable`
      // sentinel (`rejectedBoxRead`), so it consumes the retry, and a
      // rejection on the retry TOO classifies `unusable` and fails BY NAME
      // through the expect below, never as an unhandled rejection escaping
      // the leg.
      let markerRead = await readBoxFile(driver, vmName, boxMarkerPath(runId), DEFAULT_PER_CALL_DEADLINE_MS).catch(rejectedBoxRead);
      if (markerRead.kind === "unreadable") {
        evidence.push({
          phase: "marker-read-retry",
          kind: markerRead.kind,
          stderr: redactSecrets(markerRead.stderr.trim().slice(0, 200)),
        });
        markerRead = await readBoxFile(driver, vmName, boxMarkerPath(runId), DEFAULT_PER_CALL_DEADLINE_MS).catch(rejectedBoxRead);
      }
      const preSweep = classifyMarkerRead(markerRead, runId);
      evidence.push({
        phase: "pre-sweep-marker",
        // live-mirror: boxMarkerPath(runId) (src/fleet/fanout-primitive.ts:749) — the shipped per-run marker path the sweep also reads
        markerPath: boxMarkerPath(runId),
        expectedRunId: runId,
        kind: preSweep.kind,
        ...(preSweep.kind === "skip" || preSweep.kind === "unusable" ? { code: preSweep.code } : {}),
      });
      // live-mirror: MarkerVerdict kinds (src/fleet/fanout-primitive.ts:785) — the shipped classifier's vocabulary, never a local re-spelling
      expect(["absent", "settled"]).toContain(preSweep.kind);
      if (preSweep.kind === "settled") expect(preSweep.ok).toBe(true);

      // ── 7. the engine settles — observed by NO fleet verb ────────────────
      // The sweep gets ONE marker read per candidate (maxTicks 1 — a sweep is
      // not a wait), so it must be handed a run that already finished. The
      // poll is the test's own read-only bridge: bounded by the same 45-min
      // degraded-round window class T2.8 priced, one shipped `readBoxFile`
      // per tick, each classified with `expectedRunId`. `unusable` breaks the
      // poll immediately — the marker is THERE and cannot be judged, and no
      // number of retries heals corruption (journal.ts publishes by
      // temp+rename, so persistence means corruption). A window expiry fails
      // the leg BY NAME rather than handing the sweep an unsettled candidate
      // it would correctly count `runs_unsettled` and leave behind.
      //
      // T27 + T32 on the tick itself: a REJECTED read (transport throw) is a
      // COUNTABLE non-settled tick — one blip must not fail the round — but a
      // PERSISTENT streak of rejections (and `skip` verdicts: probe exit 255,
      // the box never answered) is the marker being UNREADABLE, not absent,
      // and burns 45 min of billing before a misleading "never settled"
      // expiry. The consecutive counter fast-fails that streak at
      // T38_POLL_UNREADABLE_LIMIT ticks, naming the actual condition; a clean
      // `absent` (engine still walking) resets it.
      const pollStartedAt = Date.now();
      const kindCounts: Record<string, number> = {};
      let settledOk: boolean | undefined;
      let unreadableStreak = 0;
      let lastUnreadableWhy = "";
      for (;;) {
        // The discriminated tick: `read === undefined` ⇔ the read REJECTED —
        // TS narrows on it, and the two arms below never disagree.
        const tick = await readBoxFile(driver, vmName, boxMarkerPath(runId), DEFAULT_PER_CALL_DEADLINE_MS).then(
          (read): { read: BoxFileRead; rejection?: undefined } => ({ read }), // live-mirror: boxMarkerPath(runId) (fanout-primitive.ts) — same shipped path the sweep's one-tick read uses
          (e: unknown): { read: undefined; rejection: string } => ({
            read: undefined,
            rejection: e instanceof Error ? e.message : String(e),
          }),
        );
        if (tick.read === undefined) {
          kindCounts["(read-rejected)"] = (kindCounts["(read-rejected)"] ?? 0) + 1;
          unreadableStreak += 1;
          lastUnreadableWhy = `readBoxFile rejected: ${tick.rejection}`;
        } else {
          const verdict = classifyMarkerRead(tick.read, runId);
          kindCounts[verdict.kind] = (kindCounts[verdict.kind] ?? 0) + 1;
          if (verdict.kind === "settled") {
            settledOk = verdict.ok;
            break;
          }
          if (verdict.kind === "unusable") {
            evidence.push({ phase: "engine-settled-poll", ok: false, kindCounts, code: verdict.code, pollMs: Date.now() - pollStartedAt });
            throw new Error(
              `engine-settled poll read an unusable marker (code ${verdict.code}) — present but unjudgeable; the sweep would refuse it identically`,
            );
          }
          if (verdict.kind === "skip") {
            unreadableStreak += 1;
            lastUnreadableWhy = `${verdict.code}: ${verdict.error instanceof Error ? verdict.error.message : String(verdict.error)}`;
          } else {
            unreadableStreak = 0;
          }
        }
        if (unreadableStreak >= T38_POLL_UNREADABLE_LIMIT) {
          evidence.push({
            phase: "engine-settled-poll",
            ok: false,
            kindCounts,
            unreadableStreak,
            lastUnreadableWhy: redactSecrets(lastUnreadableWhy.slice(0, 300)),
            pollMs: Date.now() - pollStartedAt,
          });
          throw new Error(
            `engine-settled poll: the marker was UNREADABLE for ${unreadableStreak} consecutive ticks (${redactSecrets(lastUnreadableWhy.slice(0, 300))}) — NOT absent and not a slow engine: the reads rejected or the presence probe never answered, so the box is unreachable-or-wedged while it may still be billing. Failing now instead of burning the rest of the window on a misleading "never settled" expiry.`,
          );
        }
        if (Date.now() - pollStartedAt > T38_ENGINE_WINDOW_MS) break;
        await new Promise((r) => setTimeout(r, T38_ENGINE_POLL_INTERVAL_MS));
      }
      const pollMs = Date.now() - pollStartedAt;
      evidence.push({
        phase: "engine-settled-poll",
        ok: settledOk === true,
        kindCounts,
        settledOk: settledOk ?? null,
        pollMs,
        windowMs: T38_ENGINE_WINDOW_MS,
        note: "read-only test bridge — no fleet verb observed this run between `fleet run` returning and the sweep below",
      });
      if (settledOk === undefined) {
        throw new Error(
          `the engine's marker never settled within T38_ENGINE_WINDOW_MS (${T38_ENGINE_WINDOW_MS} ms) — the sweep would correctly count this run runs_unsettled and leave it behind, so the chain demo cannot proceed`,
        );
      }
      expect(settledOk).toBe(true);

      // ── 8. THE STORY'S OWN SURFACE: `fleet observe --all`, a SEPARATE
      // invocation — the exact shape of the documented cron line's verb. cwd
      // is the host clone (hostRoot): the sweep asserts a git worktree at
      // start-up (AC6) and the chain's teardown/reverify legs run against
      // it. The pass is bounded and EXITING (AC5: a verb, never a process);
      // exit 0 is the pass-completed outcome — a driven run's per-run
      // refusals are counted skips inside a pass that still exits 0 (AC6).
      const sweepStartedAt = Date.now();
      const sweep = await runFleet(["observe", "--all", "--driver", "exedev", "--dir", recordsDir], {
        cwd: hostRepo,
        timeoutMs: T38_SWEEP_VERB_TIMEOUT_MS,
      }).catch((e: unknown) => {
        const partial = fleetPartialOutput(e);
        evidence.push({
          phase: "sweep-verb-timeout",
          error: (e as Error).message,
          recoveredBytes: partial.stdout.length + partial.stderr.length,
          stdoutTail: redactSecrets(partial.stdout.trim().slice(-400)),
          stderrTail: redactSecrets(partial.stderr.trim().slice(-600)),
        });
        throw e;
      });
      const sweepMs = Date.now() - sweepStartedAt;
      evidence.push({
        phase: "sweep-verb",
        exitCode: sweep.exitCode,
        sweepMs,
        stdoutTail: redactSecrets(sweep.stdout.trim().slice(-400)),
        stderrTail: redactSecrets(sweep.stderr.trim().slice(-600)),
      });
      expect(sweep.exitCode).toBe(0);

      // ── 9. the sweep's own structured lines ──────────────────────────────
      // The CLI's structured lines stream as JSON on STDERR (scripts/fleet.ts
      // import.meta.main: "stdout = output only"), so both streams are parsed
      // and the stream that carried each line is irrelevant to the claim.
      // THREE lines are this story's Observability Contract, asserted here:
      // one `run-observed` line for THIS run (the per-driven-run line —
      // proof the sweep drove it, not merely saw it), one `sweep-complete`
      // line whose counters name the pass (candidates_enumerated ≥ 1 — the
      // enumeration FOUND the open record; runs_observed ≥ 1 — the sweep, not
      // this test, drove the chain). The FULL parsed sweep-complete line also
      // rides the evidence payload top-level: the reboot counters
      // (box_reboot_after_dispatch, uptime_unknown — INV-IBOX-19) are the
      // driver's extraction concern at the live round, and this file does not
      // write `_bmad-output/evidence/df3-8/` itself.
      const { lines: sweepLines, dropped: sweepDropped } = jsonLines(`${sweep.stdout}\n${sweep.stderr}`);
      const runObservedLines = sweepLines.filter((l) => l.event === "run-observed" && l.runId === runId);
      const sweepCompleteLines = sweepLines.filter((l) => l.event === "sweep-complete");
      if (sweepCompleteLines.length > 0) sweepCompleteLine = sweepCompleteLines.at(-1);
      evidence.push({
        phase: "sweep-lines",
        runObservedLines,
        // P5: a `{`-prefixed line that did not parse is counted, never dropped
        // silently — the count and the first failing raw text (already
        // redacted and capped by jsonLines) ride here for forensics.
        ...(sweepDropped.count > 0 ? { unparseableLines: sweepDropped } : {}),
      });
      expect(runObservedLines.length).toBeGreaterThanOrEqual(1);
      // STRICTLY positive, not >= 0: a sweep that took no time is a timing
      // field that stopped being measured (the PauseTimings rule, T2.8's own
      // marker_poll_ms discipline applied to the contract's sweep_ms).
      expect(Number(runObservedLines[0]?.sweep_ms)).toBeGreaterThan(0);
      expect(sweepCompleteLines.length).toBeGreaterThanOrEqual(1);
      expect(Number(sweepCompleteLine?.candidates_enumerated)).toBeGreaterThanOrEqual(1);
      expect(Number(sweepCompleteLine?.runs_observed)).toBeGreaterThanOrEqual(1);
      // T37: the ZERO side, without which the ≥ asserts above were one-sided
      // — a pass that drove its one candidate AND ALSO left it unsettled,
      // refused its lock, lost it to a reboot count, or skipped it, still
      // satisfied every bound above. This round hands the sweep exactly ONE
      // already-settled candidate and must see it driven: every disposition
      // EXCEPT runs_observed (asserted > 0 above) has to be 0. `Number()`
      // maps a DROPPED field to NaN, which fails too — a counter that left
      // the summary is not a zero we verified. Field set checked against
      // SweepSummary (src/fleet/observe.ts).
      expect(Number(sweepCompleteLine?.runs_unsettled)).toBe(0);
      expect(Number(sweepCompleteLine?.lock_refused)).toBe(0);
      expect(Number(sweepCompleteLine?.runs_lost_to_reboot)).toBe(0);
      expect(Number(sweepCompleteLine?.runs_engine_dead)).toBe(0);
      expect(Number(sweepCompleteLine?.runs_box_unreachable)).toBe(0);
      expect(Number(sweepCompleteLine?.runs_chain_failed)).toBe(0);
      expect(Number(sweepCompleteLine?.candidates_skipped)).toBe(0);
      expect(Number(sweepCompleteLine?.completion_unwitnessed)).toBe(0);

      // ── 10. ONE gate `pause` event, joined on the record's dispatch id ───
      // The event is the GATE's (emitPause), riding the sweep invocation's
      // own channel unchanged — DF3.7's module emits it, the sweep mints no
      // second vocabulary for it. Exactly one: a second would be a second
      // registration. The join key is the RECORD's own correlation stamp —
      // the sweep did not dispatch the run and cannot mint that id.
      const pauseEventLines = sweepLines.filter((l) => l.event === "pause");
      evidence.push({ phase: "pause-event", lines: pauseEventLines });
      expect(pauseEventLines.length).toBe(1);
      // live-mirror: emitPause vocabulary (src/reverify/approval-gate.ts) — the gate's pause-event shape, written by the gate alone
      expect(pauseEventLines[0]).toMatchObject({
        operation: "fleet.pause",
        event: "pause",
        runId,
        state: "awaiting-approval",
        outcome: "requested",
        dispatchRequestId: recordRequestId,
      });

      // ── 11. the record rests at the pause, through the sweep's chain ─────
      const driven = new RunRecordStore({ dir: recordsDir }).get(runId);
      evidence.push({
        phase: "driven-record",
        closedAt: driven.closedAt,
        // Redacted BEFORE the push (the same B24 rule jsonLines applies to the
        // verb lines): a secret-shaped field anywhere in the gate's approval
        // object would refuse the evidence write — a paid round left with no
        // evidence. A redacted JSON string, not the raw object.
        approvalJson: redactSecrets(JSON.stringify(driven.extensions?.approval ?? null)),
        spendMicroUsd: driven.spendMicroUsd,
      });
      expect(driven.closedAt ?? "").not.toBe(""); // dp:ok coaxes undefined into the sentinel this assert rejects — the chain must have closed the record; tier2-run-completion.live.test.ts:653 verbatim
      expect(driven.extensions?.approval?.state).toBe("awaiting-approval"); // live-mirror: ApprovalState union (src/reverify/approval.ts:28, written by approval-gate.ts — DF3.8 asserts, never writes it)
      // reverify's proposal is `open a PR for run ${runId} at ${headSha}` —
      // the runId mention is what proves the GATE built it, not this test.
      expect(String(driven.extensions?.approval?.proposal ?? "")).toContain(runId); // dp:ok a missing proposal reads "" and FAILS this toContain — the gate must have built it; tier2-run-completion.live.test.ts:657 verbatim
      expect(String(driven.extensions?.approval?.reportId ?? "")).not.toBe(""); // dp:ok coaxes undefined into the sentinel this assert rejects; tier2-run-completion.live.test.ts:658 verbatim
      expect(String(driven.extensions?.approval?.headSha ?? "")).not.toBe(""); // dp:ok coaxes undefined into the sentinel this assert rejects — headSha joins to refs/sandbox below; tier2-run-completion.live.test.ts:659 verbatim
      expect(String(driven.extensions?.approval?.expiresAt ?? "")).not.toBe(""); // dp:ok coaxes undefined into the sentinel this assert rejects; tier2-run-completion.live.test.ts:660 verbatim
      // headSha JOINS to the harvested tip the chain's teardown fetched into
      // the host clone — the approval is bound to real bytes, not to a claim.
      const tip = Bun.spawnSync({
        cmd: ["git", "-C", hostRepo, "rev-parse", "--verify", `refs/sandbox/${runId}`],
        stdout: "pipe",
        stderr: "pipe",
      });
      evidence.push({ phase: "sandbox-tip", exitCode: tip.exitCode, sha: tip.stdout.toString().trim() });
      expect(tip.exitCode).toBe(0);
      expect(String(driven.extensions?.approval?.headSha)).toBe(tip.stdout.toString().trim());

      // ── 12. the bundle the approval is bound to (INV-APPROVE-6) ──────────
      const bundlePath = join(recordsDir, `${runId}.bundle`);
      const bundleBytes = existsSync(bundlePath) ? statSync(bundlePath).size : 0;
      evidence.push({ phase: "bundle", bundlePath, bundleBytes });
      expect(bundleBytes).toBeGreaterThan(0);

      // ── 13. spend captured under the cap; the key revoked and verified ───
      // TYPE first, then the ceiling (T2.2's L9): a missing spendMicroUsd is
      // a capture defect, not "the run spent nothing" — different facts.
      // LEDGER (P4): `spendMicroUsd` is the provider-authoritative KEY usage
      // captureSpend wrote at close — TOKENS, and nothing else. So this
      // ceiling is the 50,000 µ$ KEY cap, and the box-hours bound the title's
      // "+ box-hours" names is asserted separately below, against the row the
      // close step ingested at the rate in this round's own cost-config.json.
      expect(typeof driven.spendMicroUsd).toBe("number");
      expect(driven.spendMicroUsd ?? 0).toBeLessThanOrEqual(T38_CAP_MICRO_USD);
      evidence.push({ phase: "spend", capMicroUsd: T38_CAP_MICRO_USD, actualMicroUsd: driven.spendMicroUsd });
      // The box-hours half, machine-checked: the close step ingests ONE
      // box_hours row (its digest dedups a re-ingest), priced at
      // T38_BOX_HOUR_RATE_MICRO_USD, whose total cannot exceed the round's
      // PLANNED window at that rate (T38_BOX_HOURS_CEILING_MICRO_USD — see
      // its derivation comment; a box that out-bills the plan fails HERE,
      // while the round's assertions still run, not only on the runner-abort
      // path where no assertion executes).
      // T33 on the sum: `Number(null) === 0`, so a NULL-cost row used to ride
      // the total as costless. A non-finite cost on an INGESTED row is an
      // audit defect this leg fails BY NAME — never a zero the ceiling then
      // passes.
      const boxHourRows = ledgerRows<{ cost_micro_usd: number | null }>(
        recordsDir,
        "SELECT cost_micro_usd FROM cost_events WHERE run_id = ? AND kind = 'box_hours'",
        runId,
      );
      const nonFiniteCostRows = boxHourRows.filter((r) => !Number.isFinite(r.cost_micro_usd));
      if (nonFiniteCostRows.length > 0) {
        throw new Error(
          `box_hours ledger rows with non-finite cost_micro_usd for ${runId} (${nonFiniteCostRows.length} of ${boxHourRows.length} rows; first: ${JSON.stringify(nonFiniteCostRows[0])}) — a NULL/invalid cost on an ingested row is an audit defect, not a costless box`,
        );
      }
      const boxHoursMicroUsd = boxHourRows.reduce((sum, r) => sum + (r.cost_micro_usd ?? 0), 0);
      evidence.push({
        phase: "box-hours",
        rows: boxHourRows.length,
        rateMicroUsdPerHour: T38_BOX_HOUR_RATE_MICRO_USD,
        actualMicroUsd: boxHoursMicroUsd,
        ceilingMicroUsd: T38_BOX_HOURS_CEILING_MICRO_USD,
        ceilingDerivedFrom:
          "T38_BOX_PLANNED_WINDOW_MS (dispatch→destroy at the audit rows' declared ceilings, post-destroy tail included as headroom) at the configured rate",
      });
      expect(boxHourRows.length).toBeGreaterThanOrEqual(1);
      expect(boxHoursMicroUsd).toBeLessThanOrEqual(T38_BOX_HOURS_CEILING_MICRO_USD);
      // The chain's own teardown revoked the key; this is the machine-checked
      // half (F17) — in-body here, and again as a population delta in the
      // finally.
      // TYPE the hash first (P7): a chain defect that nulled keyHash would
      // otherwise make the `not.toContain` below pass vacuously.
      expect(typeof driven.keyHash).toBe("string");
      // CEILED (T26): a raw `listedKeyHashes()` await is an unbounded HTTP
      // walk, and a wedged listing here — box still owned, key revocation
      // unverified — is the runner-timeout abort whose finally-skip leaks
      // both. The ceiling is the audit's 240 s "post keys" row, named as
      // T38_KEY_LIST_CEILING_MS. (A listing that comes back TRUNCATED throws
      // by contract — D6 — which lands in the catch as a held failure, the
      // correct fail-closed posture, not a spurious green.)
      const postChainKeyHashes = await awaitWithCeiling(listedKeyHashes(), T38_KEY_LIST_CEILING_MS, "t3.8-post-chain-key-list");
      expect(postChainKeyHashes).not.toContain(driven.keyHash);
    } catch (e) {
      outcome = "fail";
      // HELD, not thrown (EB3): the post-finally verdicts below must render
      // on the red path too — the failing run is the one most likely to leak.
      failure = e;
      evidence.push({ phase: "test-error", error: String((e as Error)?.message ?? e) });
    } finally {
      // Built FIRST, in its own try (FX-E/1): everything below reads it, and
      // the write-mode constructor's refusal must not escape this finally.
      let recordStore: RunRecordStore | undefined;
      try {
        if (workspace !== "") recordStore = new RunRecordStore({ dir: join(workspace, "runs") });
      } catch (e) {
        evidence.push({ phase: "finally-store", ok: false, error: (e as Error).message });
      }
      // F12: a dispatch that PROVISIONED and then refused emits a refusal
      // payload, not an ack — recover the ids from BOTH streams so cleanup
      // can never skip the box that is quietly billing. When the record
      // exists it arbitrates the recovered vmName (E1-12: remediation prose
      // is not this round's artifact; the record is).
      if (runId === "" || vmName === "") {
        const recovered = recoverDispatchIds(dispatchOut, dispatchErr);
        if (runId === "") runId = recovered.runId;
        if (vmName === "") vmName = recovered.vmName;
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
        // `teardownQuietly`, not a bare runFleet (F2): a ceiling rejection
        // here would escape the finally and replace the body's held error.
        // `--no-harvest`: the chain already harvested on the success path,
        // and a cleanup path is not where a second harvest belongs. A
        // teardown of the already-closed record is idempotent (T2.2's finally
        // runs the same second teardown every green round).
        const torn = await teardownQuietly(
          ["teardown", runId, "--driver", "exedev", "--dir", join(workspace, "runs"), "--no-harvest"],
          { timeoutMs: T38_CLEANUP_TEARDOWN_TIMEOUT_MS },
          evidence,
          { at: "t3.8-cleanup", runId },
        );
        if (!torn.ok) {
          // The chain-failed posture (P10) DELIBERATELY leaves the run lock on
          // disk, so this cleanup teardown hits the preserved lock and refuses
          // — a spurious cleanup failure on a round whose real failure is the
          // chain step. Detect that exact posture (record still open + the
          // lock file present) and record the refusal as expected instead of a
          // destroyFailures entry; the box itself is still destroyed below.
          let recordStillOpen = false;
          try {
            recordStillOpen = (recordStore?.get(runId) as { closedAt?: string } | undefined)?.closedAt === undefined;
          } catch {
            // unreadable record — the posture cannot be proven, keep the failure
          }
          if (recordStillOpen && existsSync(join(workspace, "runs", `${runId}.lock`))) {
            evidence.push({
              phase: "finally-teardown",
              ok: true,
              at: "t3.8-cleanup",
              runId,
              expected: "lock left by the chain-failed posture",
              // T29: the refusal's OWN error text (already scrubbed by
              // teardownQuietly) rides the demoted entry, so the round record
              // shows WHAT refused — a genuine teardown defect (EACCES, a bad
              // flag, a dead store) arriving in this posture is visible as a
              // non-lock cause instead of laundering through "expected
              // posture"; an actual lock refusal reads `run-locked` here.
              refusal: torn.error,
              note: "the cleanup teardown's refusal is DEMOTED to expected by posture (record open + lock present) — the refusal text above is what actually refused; the box destroy below is unaffected",
            });
          } else {
            destroyFailures.push(`${runId}: ${torn.error}`);
          }
        }
      }
      if (vmName !== "" && ctx !== undefined) {
        const destroyed = await destroyQuietly(ctx.driver, vmName, evidence);
        if (!destroyed.ok) destroyFailures.push(`${vmName}: ${destroyed.error}`);
      }
      // `fleetLeftovers` (P127/P128/R4): bounded-retry against the measured
      // 25 s+ substrate destroy lag, a destroy of what this run owns before
      // the verdict, and another round's strays demoted to a warning. Never
      // throws — a failed listing is `owned: undefined`, which
      // fleetCleanupProblems renders as the problem it is.
      if (ctx === undefined) {
        // P28 abort path: preflight never returned — nothing was provisioned,
        // so no box this run owns can exist. [] rather than undefined: the
        // listing was correctly skipped, not failed.
        finalBoxes = [];
        evidence.push({ phase: "final-ls-skipped", ok: true, note: "preflight never returned — nothing was provisioned" });
      } else {
        finalBoxes = (await fleetLeftovers(ctx.driver, [runId, vmName], evidence)).owned;
      }
      // GUARDED (E1-5): keyLeakProblems is the one finally leg whose own
      // failure must still be a VERDICT, not an escape from the finally.
      if (hashesBefore === undefined || ctx === undefined) {
        keyProblems = ["the F17 baseline key listing never landed — the key-hash delta is UNVERIFIED for this round"];
        evidence.push({ phase: "key-hash-baseline-missing", ok: false });
      } else {
        try {
          keyProblems = await keyLeakProblems(hashesBefore, { driver: ctx.driver, store: recordStore, runIds: [runId] }, evidence);
        } catch (keyErr) {
          keyProblems = [
            `key-leak sweep itself failed: ${keyErr instanceof Error ? keyErr.message : String(keyErr)} — treat the run key's revocation as UNVERIFIED`,
          ];
          evidence.push({ phase: "key-leak-sweep-failed", ok: false, error: keyProblems[0] });
        }
      }
      // T36: INVALIDATE the reaper's file when THIS finally actually finished
      // the recovery the file exists to trigger — box destroyed (the final
      // listing found nothing this run owns) AND the key revocation verified
      // (keyProblems empty). The file still naming {runId, vmName, keyHash}
      // on a round whose cleanup SUCCEEDED would send an out-of-band reaper
      // after a box and key that no longer exist. On a FULL-green round this
      // is moot (the workspace rmSync below deletes the file outright); the
      // tombstone is for the RED-round-with-clean-cleanup posture, where the
      // workspace is kept for forensics and the file would otherwise live on
      // armed. An UNMEASURED fleet (finalBoxes undefined) does not earn the
      // tombstone — no verdict, no claim.
      if (orphanRecoveryPath !== "" && finalBoxes !== undefined && finalBoxes.length === 0 && keyProblems.length === 0) {
        try {
          writeFileSync(
            orphanRecoveryPath,
            `${JSON.stringify({ phase: "handled", runId, vmName, note: "box destroyed and key revocation verified by this round's finally — nothing left to reap" })}\n`,
          );
          evidence.push({ phase: "orphan-recovery-tombstoned", ok: true, path: orphanRecoveryPath, runId, vmName });
        } catch (e) {
          // best-effort by design: a reaper chasing an already-destroyed box
          // wastes a call, it does not lose resources — recorded, not thrown.
          evidence.push({
            phase: "orphan-recovery-tombstoned",
            ok: false,
            path: orphanRecoveryPath,
            error: e instanceof Error ? e.message : String(e),
          });
        }
      }
      // T24: the RED-arm workspace-keep entry is pushed BEFORE the evidence
      // write so it RIDES the serialized payload — the old order pushed it
      // after `writeEvidenceQuietly` had already stringified, so the entry
      // never landed in any JSON the round left behind. The refused-write arm
      // is decided only BY the write itself, and when it fires there IS no
      // JSON to land in (the write failed); its entry still lands in the
      // array and on stderr below.
      if (workspace !== "" && failure !== undefined) {
        evidence.push({
          phase: "workspace-kept",
          workspace,
          reason: "RED round — forensics kept (bundle + records under runs/)",
        });
      }
      const evidencePath = writeEvidenceQuietly(
        "T3.8",
        "df3-8-observe-detached",
        {
          test: "T3.8",
          outcome,
          runId,
          capMicroUsd: T38_CAP_MICRO_USD,
          engineWindowMs: T38_ENGINE_WINDOW_MS,
          // The FULL parsed sweep-complete line, top-level for the driver's
          // counter extraction (INV-IBOX-19's box_reboot_after_dispatch /
          // uptime_unknown ride it) — this file writes no df3-8 evidence of
          // its own.
          ...(sweepCompleteLine === undefined ? {} : { sweepComplete: sweepCompleteLine }),
          evidenceDir: EVIDENCE_DIR,
          phases: evidence,
        },
        destroyFailures,
      );
      // B25: the workspace holds the only host-side copy of the bundle and
      // records once the box is gone — kept on a RED round for forensics.
      // ALSO loud when the evidence write was refused on an otherwise green
      // round (P6): the rmSync below then skips and the workspace — clone,
      // bundle, records, reaper file included — survives silently, so the
      // note fires whenever the workspace is kept, whatever the posture.
      if (workspace !== "" && failure === undefined && evidencePath === "") {
        evidence.push({
          phase: "workspace-kept",
          workspace,
          reason: "GREEN round but the evidence write was refused — workspace kept (bundle + records under runs/); delete by hand once triaged",
        });
      }
      if (workspace !== "" && (failure !== undefined || evidencePath === "")) {
        try {
          process.stderr.write(
            failure !== undefined
              ? `[T3.8] RED round: workspace ${workspace} KEPT for forensics; delete by hand once triaged\n`
              : `[T3.8] EVIDENCE WRITE REFUSED: workspace ${workspace} KEPT (bundle + records under runs/); delete by hand once triaged\n`,
          );
        } catch {
          // dead stderr under an aborting runner — the evidence entry still lands
        }
      }
      if (workspace !== "" && failure === undefined && evidencePath !== "") {
        try {
          rmSync(workspace, { recursive: true, force: true });
        } catch {
          // best-effort; evidence is already written
        }
      }
    }

    // The post-finally verdict (EB3), in ONE place: a cleanup problem fails a
    // green run, and on a RED one attaches to the body's own error instead of
    // throwing over the top of it.
    settleRun(failure, [...fleetCleanupProblems(destroyFailures, finalBoxes, evidence), ...keyProblems]);
  },
  // Budget audit, priced at DECLARED CEILINGS, not typical latency (T2.2's
  // rule): a bun test-timeout abort is the ONE path where the finally above
  // does not execute — the one path that leaves a real box billing and a
  // minted key live. Every inner ceiling FIRING is safe (it rejects into the
  // catch and the finally still runs), so the fail-safe direction is UP.
  //
  // The DERIVATION vs T2.8's audit: same round with the observe term
  // REDISTRIBUTED, not grown. T2.8 priced one blocking observe verb at
  // window 2 700 s + chain allowance 900 s = 3 600 s; this round prices the
  // same 3 600 s as the engine-settled poll (2 700 s — the same degraded-
  // round window class, now spent by the TEST's read-only bridge because the
  // sweep does not wait) + the sweep verb (900 s — the same chain allowance:
  // enumeration's two bounded reads per candidate + ONE teardown ~300 s +
  // reverify ~420 s, T5.1's measured ceilings, + margin). Body and finally
  // therefore sum identically to T2.8's figures:
  //
  //   preflight          driver.whoami(), one control exec class          120 s
  //   baseline keys      listedKeyHashes INSIDE the try, first await after
  //                      preflight (P28's placement; the F17 baseline — the
  //                      row's old "BEFORE the try" text was wrong, T35).
  //                      Unwrapped by scope, not oversight: at this point
  //                      the round owns no box and no key, so a hang costs
  //                      a dead round, never a leak                   240 s
  //   dispatch verb      T38_DISPATCH_TIMEOUT_MS                          900 s
  //   positive control   one driver.list, CEILED by awaitWithCeiling at
  //                      T38_LIST_CEILING_MS (T26: a raw driver await has
  //                      no self-bound; the abort it prevents is the one
  //                      whose finally-skip leaks the box)              120 s
  //   scratchClone       180 s PRICED, but not by T38_CLONE_TIMEOUT_MS —
  //                      that ceiling is DECORATIVE (T30): scratchClone
  //                      runs its git steps spawnSync, so the promise is
  //                      already settled when awaitWithCeiling wraps it.
  //                      What actually bounds this leg: the PRE-DISPATCH
  //                      http(s)-scheme refusal (an ssh:// fetch ignores
  //                      git's stall switch) + scratchClone's in-git
  //                      http.lowSpeed* switch on http transports      180 s
  //   run verb           T38_RUN_VERB_TIMEOUT_MS — the verb EXITS here    180 s
  //   unit liveness      one systemctl show (execTimed 30 s), 1 retry      60 s
  //   marker read        readMarkerTolerant shape, 2 × 10 s (retry arm)    20 s
  //   engine poll        T38_ENGINE_WINDOW_MS — the DEGRADED-round bound
  //                      (a healthy t3 manifest settles in minutes); each
  //                      tick is one bounded readBoxFile (10 s class);
  //                      rejected reads and skip verdicts are countable
  //                      non-settled ticks (T27), fast-failed at
  //                      T38_POLL_UNREADABLE_LIMIT consecutive (T32)  2 700 s
  //   sweep verb         T38_SWEEP_VERB_TIMEOUT_MS: enumeration (2 × 10 s
  //                      reads per candidate, one candidate) + ONE chain
  //                      — teardown ~300 s + reverify ~420 s (T5.1's own
  //                      measured ceilings) + margin; NO window term, the
  //                      sweep does not wait (maxTicks 1)                900 s
  //   post keys          listedKeyHashes (revoke verify), CEILED at
  //                      T38_KEY_LIST_CEILING_MS (T26)                   240 s
  //   local reads        record/bundle/rev-parse, local                     ~0 s
  //                                                            body ────────
  //                                                             5 660 s
  //   teardownQuietly    timeoutMs 180_000                               180 s
  //   destroyQuietly     CODE-WORST: 2 rm + 3 confirming list at the
  //                      DEFAULT_EXEC_TIMEOUT_MS class (driver.ts's
  //                      destroy loop)                                   600 s
  //   fleetLeftovers     5 × (control ls 120 + 8 s wait) + its destroy
  //                      pass (another destroyQuietly at code-worst, 600)
  //                      + the confirming re-list                     1 360 s
  //   keyLeakProblems    delta list + fallback revoke + recheck list       360 s
  //   evidence + rmSync  local                                            10 s
  //                                                           finally ────────
  //                                                             2 510 s
  //                                                                    ────────
  //                                                             8 170 s
  //
  // Hence T38_RUNNER_TIMEOUT_MS (8 500 000 ms — 330 s of margin over the
  // audit). Whoever raises an inner ceiling (the engine window, the sweep
  // verb, a cleanup step) must re-add it HERE, in T38_BOX_PLANNED_WINDOW_MS
  // (the box-hours ceiling derives from these rows, T31), and the HEADER's
  // box-time line
  // with it.
  T38_RUNNER_TIMEOUT_MS,
);
