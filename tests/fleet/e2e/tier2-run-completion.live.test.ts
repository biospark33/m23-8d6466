/**
 * T2.8 — DF3.7 AC6: the run-completion chain, end to end, on a real box.
 *
 * `fleet dispatch` → `fleet run <runId>` (DF1.10's in-box engine starts under
 * systemd and the verb RETURNS) → `fleet observe <runId>` — THIS story's own
 * verb — which BLOCKS on the engine's terminal marker, then walks the chain
 * the operator runs by hand today: harvest → revoke → verify → destroy →
 * `closedAt` → `reverify()` → the gate's own `requestApproval` → the record
 * rests at `awaiting-approval`, ready for `fleet approve`.
 *
 * CHARTER: story df3-7-approval-gate-bridge.md AC6 + E2E Slice, and
 * `.unlazy/df3-7/contract.md` §Live e2e. AC6's make-or-break claim: the
 * evidence is "a real box whose marker was written by DF1.10's real in-box
 * engine — not planted by the test". Unit coverage over a recording driver is
 * legitimate for the classifier's verdicts (leaf-1.3) but MUST NOT be the
 * sole evidence for AC1/AC6 — this file is that evidence.
 *
 * WHY t3.pipeline.json AND NOT t2's: the chain's `reverify()` returns
 * `nothing-to-verify` (and observe maps that to `vetoed`, exit 6) unless the
 * sandbox carries a commit beyond base — `runner.ts:282-292`. t2's echo/true
 * manifest commits nothing; t3's `t3-marker` phase writes AND COMMITS a
 * marker file from inside the engine walk, so the harvest lands a real
 * `refs/sandbox/<runId>` tip for reverify to judge. Still a free workload —
 * the money buys the PATH, not a model-heavy phase.
 *
 * THE HOST PLAN is operator-authored here, on purpose (INV-RV-1: reverify
 * never trusts the harvested tree to judge itself). T5.1's live-proven shape:
 * `.factory/pipeline.json` keyed by the RECORD's canonical repoSlug, pinning
 * the same small hermetic judging suite (`bun test tests/fleet/approvers.ts`,
 * ~7.5 s, no network — measured 2026-08-30). The t3 marker commit cannot
 * perturb it, so a green verdict means the chain ran, not that the suite is
 * permissive. Authored into the scratch clone BEFORE `fleet run`, so a plan
 * failure costs no engine start.
 *
 * THE NEVER-PLANTED PROOF (AC6): this file writes nothing to the box's marker
 * path, ever. Before `fleet observe` is invoked, the marker is read once
 * through the SAME primitives `fleet status` and the fan-out race use —
 * `readBoxFile` + `classifyMarkerRead(read, runId)` (the sibling idiom at
 * tier2-in-box-engine.live.test.ts:921-930) — and must classify as `absent`
 * (engine still walking — the expected shape seconds after `fleet run`) or
 * `settled` with `ok:true` (a very fast engine). Either way the reading is
 * the ENGINE's, classified with `expectedRunId` through the shipped grammar:
 * a marker naming any other run classifies `unusable / marker-run-mismatch`
 * and this leg fails by name. Whatever observe then consumes was on the box
 * before the verb ran.
 *
 * GATING: QDS_E2E_LIVE=1 AND QDS_E2E_TIER=2 — `liveGate("2")` throws on a
 * tier mismatch or a half-configured substrate env. Normal `bun test`/CI:
 * todo. Execution of this round is the DF3.7 BRANCH gate (BN6), run by the
 * driver via the qds-live-e2e skill — never from this leaf.
 *
 * SPEND (operator-approved out of band, e2e budget protocol): ONE dispatch —
 * 1 key capped at 50,000 µ$ (the setup gate's C/D roster-model pings + the
 * armed resident's run_start/run_end solicitations) + ONE box for up to the
 * runner ceiling below (8,500 s ≈ 2.4 h at 230,000 µ$/h ≈ 543,000 µ$).
 * Worst case ≈ $0.60. A HEALTHY round finishes in minutes.
 *
 * LIVE-ROUND RUNNER (L16): the whole file is ONE todoIf test — a round that
 * never selected it reports one `(todo)` and a green summary. Name this path
 * EXPLICITLY and check for its evidence JSON
 * (`_bmad-output/evidence/df3-e2e/<date>-*-df3-7-run-completion-*.json`).
 *
 * NO FAKES of any kind: real ssh exec, real systemd, real OpenRouter key API,
 * real `bun scripts/fleet.ts` subprocesses, real git bundle and refs.
 */
import { expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// The marker path is derived ONCE, host-side, through the shipped
// `boxMarkerPath(runId)` (AC4) — never `runMarkerPath()`, which reads a HOST
// env var, and never an inlined literal. `fleet status` and the fan-out race
// read the same constant, so this file and the verbs address one path by
// construction.
import { boxMarkerPath, classifyMarkerRead, DEFAULT_PER_CALL_DEADLINE_MS } from "../../../src/fleet/fanout-primitive.ts";
import { readBoxFile } from "../../../src/providers/exedev/transport.ts";
import { RunRecordStore } from "../../../src/providers/run-record.ts";
// Verb tails are pre-redacted (B24: a tail slice can CUT a credential
// mid-token, which the evidence scrub cannot match but its refusal assert
// hits — a paid round would leave NO evidence file).
import { redactSecrets } from "../../../src/providers/step-log.ts";
import type { LiveCtx } from "./live-harness.ts";
import {
  EVIDENCE_DIR,
  REPO_ROOT,
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
  settleRun,
  teardownQuietly,
  tmpWorkspace,
  writeEvidenceQuietly,
} from "./live-harness.ts";

/** Plan default (e2e-plan.md §TIER-2): 50,000 µ$ = $0.05 worst-case per key. */
const T28_CAP_MICRO_USD = 50_000;
/** Box-hour rate from the operator's TIER-1 cost config (230,000 µ$/h). */
const T28_BOX_HOUR_RATE_MICRO_USD = 230_000;

/**
 * The manifest `fleet dispatch` delivers and the IN-BOX ENGINE walks. t3's,
 * not t2's: the `t3-marker` phase COMMITS a file from inside the engine walk
 * (see the header), which is what keeps the chain's `reverify()` off its
 * `nothing-to-verify` arm. Three `code` phases, no model-heavy work — a free
 * workload on purpose.
 */
const T28_MANIFEST_PATH = "config/rosters/t3.pipeline.json";

/**
 * The dispatch ceiling — T2.2's figure for the SAME verb (box provision + the
 * A–E setup gate, C/D being real roster-model pings). The single largest term
 * in the budget audit at the foot of this file.
 */
const T28_DISPATCH_TIMEOUT_MS = 900_000;

/** `fleet run` returns at the fork (T2.2's step-4 shape); 180 s is its audit price. */
const T28_RUN_VERB_TIMEOUT_MS = 180_000;

/**
 * The observation window passed to `fleet observe --window-ms` (AC5/the
 * contract's only new number). 45 minutes: several times the healthy
 * dispatch→terminal duration (minutes for this manifest — two instant phases,
 * one git commit, one resident solicitation bounded at SOLICIT_TIMEOUT_MS
 * 60 s), because the window is priced for a DEGRADED round, not a healthy
 * one — and a window that expires on a slow evening turns a good run into
 * AC3's typed `run-completion-unobserved` refusal for no diagnostic value.
 * The MODULE's default stays provisional until this test's measured
 * `observeMs`/`marker_poll_ms` (recorded in the evidence) reprices it at a
 * stated multiple before merge (story :113, contract D3).
 */
const T28_OBSERVE_WINDOW_MS = 2_700_000;

/**
 * The chain allowance ON TOP of the window, for what observe does AFTER the
 * marker settles: `teardownSandbox` (harvest→revoke→verify→destroy→close,
 * T2.2/T5.1's 300 s teardown figure) + `reverify()` (T5.1's own measured
 * 420 s ceiling for the quarantine worktree + the judging suite) + margin.
 */
const T28_OBSERVE_CHAIN_ALLOWANCE_MS = 900_000;

/** The observe verb's subprocess ceiling: the window plus the chain after it. */
const T28_OBSERVE_VERB_TIMEOUT_MS = T28_OBSERVE_WINDOW_MS + T28_OBSERVE_CHAIN_ALLOWANCE_MS;

/** The cleanup `fleet teardown` ceiling (T2.2's finally figure). */
const T28_CLEANUP_TEARDOWN_TIMEOUT_MS = 180_000;

/** Every `{…}` JSON line a fleet verb wrote on a stream, parsed defensively. */
function jsonLines(text: string): Record<string, unknown>[] {
  return text
    .split("\n")
    .filter((l) => l.startsWith("{"))
    .flatMap((l) => {
      try {
        return [JSON.parse(l) as Record<string, unknown>];
      } catch {
        return []; // a torn/interleaved line is noise, never a verdict
      }
    });
}

test.todoIf(liveTodoOff())(
  "T2.8 DF3.7 AC6: dispatch→fleet run→fleet observe (blocks)→engine marker, never planted→chain harvest/teardown/reverify→awaiting-approval — real box, real spend ≤ 50,000 µ$ + box-hours",
  async () => {
    liveGate("2");
    // REFUSED BEFORE ANY SPEND (T2.2's belt-and-braces tripwire): a stray host
    // `QDS_RUN_ROOT` export is a debugging lever the box never sets, and a
    // paid round should not run in a shell that carries one. This file and
    // `fleet observe` both address the box through the imported
    // `boxMarkerPath` constant, so the variable cannot redirect the probes —
    // the refusal is the tripwire for the shell, not a load-bearing guard.
    const hostRunRoot = (process.env.QDS_RUN_ROOT ?? "").trim();
    if (hostRunRoot !== "") {
      throw new Error(
        `QDS_RUN_ROOT is exported host-side as ${JSON.stringify(hostRunRoot)}. It is a HOST-side test lever the box never sets, and no live round should inherit one — unset it and re-run.`,
      );
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
      hashesBefore = await listedKeyHashes();
      workspace = tmpWorkspace("t28");
      const recordsDir = join(workspace, "runs");
      mkdirSync(recordsDir, { recursive: true });
      // BESIDE the records dir (costLedgerOpts → dirname(recordsDir)): without
      // it admission falls back to defaultCapMicroUsd 5,000,000 µ$ ($5!) and
      // the chain's box-hours close fail-louds `box-hour-rate-unconfigured`.
      writeFileSync(
        join(workspace, "cost-config.json"),
        JSON.stringify({ defaultCapMicroUsd: T28_CAP_MICRO_USD, boxHourRateMicroUsd: T28_BOX_HOUR_RATE_MICRO_USD }),
      );
      const briefPath = join(workspace, "brief.json");
      writeFileSync(
        briefPath,
        JSON.stringify({
          repoSlug: "Quantum-Digital-Solutions/QDS-Factory",
          issueId: 46,
          commitSha: ctx.sha,
          manifestPath: T28_MANIFEST_PATH,
          repoUrl: ctx.repoUrl,
        }),
      );
      evidence.push({ phase: "setup", ok: true, capMicroUsd: T28_CAP_MICRO_USD, manifestPath: T28_MANIFEST_PATH });

      // ── 1. dispatch: box + fill + the manifest pair + the setup gate ──────
      // The `.catch` is the L1 fix: `dispatch` creates a real box before it
      // can still fail, and a ceiling rejection left both streams "" so every
      // guarded cleanup leg skipped — a leaked box reported as a stray.
      const dispatch = await runFleet(
        ["dispatch", "--driver", "exedev", "--brief", briefPath, "--dir", recordsDir],
        { cwd: REPO_ROOT, timeoutMs: T28_DISPATCH_TIMEOUT_MS },
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
      // POSITIVE CONTROL for the final-ls verdict (T5.1's shape): prove the
      // listing CAN see this run's box before the end of the round asserts
      // no box of ours survives.
      expect((await ctx.driver.list()).some((b) => b.name === vmName)).toBeTrue();

      // ── 2. the record carries the identity every join below keys on ──────
      const store = new RunRecordStore({ dir: recordsDir });
      const rec = store.get(runId);
      expect(rec.vmName).toBe(vmName);
      expect(rec.commitSha).toBe(ctx.sha);
      expect(rec.keyHash ?? "").not.toBe("");
      expect(rec.limitMicroUsd).toBe(T28_CAP_MICRO_USD);
      // requestId is the JOIN KEY for the pause event below — `""` would make
      // that comparison pass while joining on nothing, so it is refused here
      // (T5.1's rule at its :420-425).
      expect(typeof rec.requestId).toBe("string");
      expect(rec.requestId ?? "").not.toBe("");
      recordRequestId = rec.requestId as string;
      // The slug the RECORD carries — dispatch canonicalizes case, and
      // `resolveHostPlan` matches the operator index EXACTLY by this value,
      // so the host plan below is keyed by the record, never by the brief.
      const slug = rec.extensions?.budget?.repoSlug;
      expect(typeof slug).toBe("string");
      expect(slug ?? "").not.toBe("");
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
      // clone is also observe's cwd: the verb asserts hostRoot is a git
      // worktree at start-up, teardown's harvest fetches the sandbox ref into
      // it, and reverify's quarantine worktree is cut from it.
      const hostRepo = await scratchClone(ctx.repoUrl, ctx.sha, workspace);
      const factoryDir = join(hostRepo, ".factory");
      mkdirSync(factoryDir, { recursive: true, mode: 0o700 });
      chmodSync(factoryDir, 0o700);
      writeFileSync(
        join(factoryDir, "pipeline.json"),
        JSON.stringify({
          version: 1,
          repos: {
            [recordSlug]: {
              manifest: ".factory/t28-host-plan.json",
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
        join(factoryDir, "t28-host-plan.json"),
        JSON.stringify({
          version: "1.0.0",
          pipelineId: "t28-host-plan",
          runBudgetMs: 300_000,
          phases: [
            {
              name: "t28-host-tests",
              kind: "code",
              description: "T2.8 operator-pinned judging suite: small, hermetic, no network (T5.1's measured pin).",
              command: ["true"],
              testCommand: ["bun", "test", "tests/fleet/approvers.test.ts"],
              maxDurationMs: 60_000,
              retries: 0,
            },
            {
              name: "t28-host-gate",
              kind: "code",
              description: "T2.8 operator-pinned gate leg: exit 0, no inputs.",
              command: ["true"],
              maxDurationMs: 10_000,
              retries: 0,
            },
          ],
        }),
      );
      chmodSync(join(factoryDir, "pipeline.json"), 0o600);
      chmodSync(join(factoryDir, "t28-host-plan.json"), 0o600);
      evidence.push({ phase: "host-plan", ok: true, hostRepo, keyedBy: recordSlug });

      // ── 4. AC1's precondition — `fleet run`: start the unit and RETURN ───
      // The verb's whole contract is that it does not wait; everything after
      // this line observes the run through a DIFFERENT verb, which is the
      // separation DF1.10 exists to establish and DF3.7 bridges.
      const start = await runFleet(["run", runId, "--driver", "exedev", "--dir", recordsDir], {
        cwd: REPO_ROOT,
        timeoutMs: T28_RUN_VERB_TIMEOUT_MS,
      });
      evidence.push({
        phase: "run-verb",
        exitCode: start.exitCode,
        stdout: redactSecrets(start.stdout.trim().slice(0, 300)),
        stderrTail: redactSecrets(start.stderr.trim().slice(-400)),
      });
      expect(start.exitCode).toBe(0);
      expect(start.stdout).toContain(`started: ${runId}`);

      // ── 5. AC6's NEVER-PLANTED proof, through the shared primitives ──────
      // One tolerant read (ONE retry on `unreadable` only — E1-10's cold
      // first-ssh multiplex; a retry cannot fabricate presence), classified
      // with `expectedRunId`. This file writes no marker, so whatever observe
      // is about to consume was already on the box, written by the engine:
      // `absent` (still walking — the expected shape seconds after the fork)
      // or `settled` with `ok:true` (a very fast engine). A foreign or
      // hand-planted marker classifies `unusable` and this leg names the code.
      let markerRead = await readBoxFile(ctx.driver, vmName, boxMarkerPath(runId), DEFAULT_PER_CALL_DEADLINE_MS);
      if (markerRead.kind === "unreadable") {
        evidence.push({ phase: "marker-read-retry", kind: markerRead.kind });
        markerRead = await readBoxFile(ctx.driver, vmName, boxMarkerPath(runId), DEFAULT_PER_CALL_DEADLINE_MS);
      }
      const preObserve = classifyMarkerRead(markerRead, runId);
      evidence.push({
        phase: "pre-observe-marker",
        markerPath: boxMarkerPath(runId),
        expectedRunId: runId,
        kind: preObserve.kind,
        ...(preObserve.kind === "skip" || preObserve.kind === "unusable" ? { code: preObserve.code } : {}),
      });
      expect(["absent", "settled"]).toContain(preObserve.kind);
      if (preObserve.kind === "settled") expect(preObserve.ok).toBe(true);

      // ── 6. THE STORY'S OWN VERB: `fleet observe`, blocking ────────────────
      // cwd is the host clone (hostRoot): observe asserts a git worktree at
      // start-up and the chain's teardown/reverify legs run against it. The
      // call BLOCKS until the engine settles inside the window and the chain
      // completes — exit 0 is the `driven` outcome (marker witnessed, chain
      // landed, gate registered). `--window-ms` is the operator-settable
      // observation window (AC5), passed explicitly so the round's budget
      // audit can price it.
      const observeStartedAt = Date.now();
      const observe = await runFleet(
        ["observe", runId, "--driver", "exedev", "--dir", recordsDir, "--window-ms", String(T28_OBSERVE_WINDOW_MS)],
        { cwd: hostRepo, timeoutMs: T28_OBSERVE_VERB_TIMEOUT_MS },
      ).catch((e: unknown) => {
        const partial = fleetPartialOutput(e);
        evidence.push({
          phase: "observe-verb-timeout",
          error: (e as Error).message,
          recoveredBytes: partial.stdout.length + partial.stderr.length,
          stdoutTail: redactSecrets(partial.stdout.trim().slice(-400)),
          stderrTail: redactSecrets(partial.stderr.trim().slice(-600)),
        });
        throw e;
      });
      const observeMs = Date.now() - observeStartedAt;
      // observeMs + the run-complete line's marker_poll_ms are the D3
      // repricing inputs for the module's provisional window default — the
      // reason both are recorded, not just asserted through.
      evidence.push({
        phase: "observe-verb",
        exitCode: observe.exitCode,
        observeMs,
        windowMs: T28_OBSERVE_WINDOW_MS,
        stdoutTail: redactSecrets(observe.stdout.trim().slice(-400)),
        stderrTail: redactSecrets(observe.stderr.trim().slice(-600)),
      });
      expect(observe.exitCode).toBe(0);

      // ── 7. the observer's own terminal line ──────────────────────────────
      // The CLI's structured lines stream as JSON on STDERR (scripts/fleet.ts
      // import.meta.main: "stdout = output only"), so both streams are parsed
      // and the stream that carried each line is irrelevant to the claim: the
      // verb emitted `{event: "run-complete", runId, marker_poll_ms}` when it
      // witnessed the marker (the Observability Contract's terminal line).
      const observeLines = jsonLines(`${observe.stdout}\n${observe.stderr}`);
      const runCompleteLines = observeLines.filter((l) => l.event === "run-complete" && l.runId === runId);
      evidence.push({ phase: "run-complete-line", lines: runCompleteLines });
      expect(runCompleteLines.length).toBeGreaterThanOrEqual(1);
      // STRICTLY positive, not >= 0: a poll that took no time is a timing
      // field that stopped being measured (the PauseTimings rule).
      expect(Number(runCompleteLines[0]?.marker_poll_ms)).toBeGreaterThan(0);

      // ── 8. ONE gate `pause` event, joined on the record's dispatch id ────
      // The event is the GATE's (emitPause), not the observer's — AC1's "one
      // `event: "pause"` line carrying dispatchRequestId, emitted by the gate,
      // not by this story". Exactly one: a second would be a second
      // registration. The join key is the RECORD's own correlation stamp
      // (never the invocation's mint).
      const pauseEventLines = observeLines.filter((l) => l.event === "pause");
      evidence.push({ phase: "pause-event", lines: pauseEventLines });
      expect(pauseEventLines.length).toBe(1);
      expect(pauseEventLines[0]).toMatchObject({
        operation: "fleet.pause",
        event: "pause",
        runId,
        state: "awaiting-approval",
        outcome: "requested",
        dispatchRequestId: recordRequestId,
      });

      // ── 9. the record rests at the pause, through the chain alone ────────
      const driven = new RunRecordStore({ dir: recordsDir }).get(runId);
      evidence.push({
        phase: "driven-record",
        closedAt: driven.closedAt,
        approval: driven.extensions?.approval,
        spendMicroUsd: driven.spendMicroUsd,
      });
      expect(driven.closedAt ?? "").not.toBe("");
      expect(driven.extensions?.approval?.state).toBe("awaiting-approval"); // live-mirror: ApprovalState union (src/reverify/approval.ts:28, written by approval-gate.ts — DF3.7 asserts, never writes it)
      // reverify's proposal is `open a PR for run ${runId} at ${headSha}` —
      // the runId mention is what proves the GATE built it, not this test.
      expect(String(driven.extensions?.approval?.proposal ?? "")).toContain(runId);
      expect(String(driven.extensions?.approval?.reportId ?? "")).not.toBe("");
      expect(String(driven.extensions?.approval?.headSha ?? "")).not.toBe("");
      expect(String(driven.extensions?.approval?.expiresAt ?? "")).not.toBe("");
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

      // ── 10. the bundle the approval is bound to (INV-APPROVE-6) ──────────
      const bundlePath = join(recordsDir, `${runId}.bundle`);
      const bundleBytes = existsSync(bundlePath) ? statSync(bundlePath).size : 0;
      evidence.push({ phase: "bundle", bundlePath, bundleBytes });
      expect(bundleBytes).toBeGreaterThan(0);

      // ── 11. spend captured under the cap; the key revoked and verified ───
      // TYPE first, then the ceiling (T2.2's L9): a missing spendMicroUsd is
      // a capture defect, not "the run spent nothing" — different facts.
      expect(typeof driven.spendMicroUsd).toBe("number");
      expect(driven.spendMicroUsd ?? 0).toBeLessThanOrEqual(T28_CAP_MICRO_USD);
      evidence.push({ phase: "spend", capMicroUsd: T28_CAP_MICRO_USD, actualMicroUsd: driven.spendMicroUsd });
      // The chain's own teardown revoked the key; this is the machine-checked
      // half (F17) — in-body here, and again as a population delta in the
      // finally.
      expect(await listedKeyHashes()).not.toContain(driven.keyHash);
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
          { timeoutMs: T28_CLEANUP_TEARDOWN_TIMEOUT_MS },
          evidence,
          { at: "t2.8-cleanup", runId },
        );
        if (!torn.ok) destroyFailures.push(`${runId}: ${torn.error}`);
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
      // B25: the workspace holds the only host-side copy of the bundle and
      // records once the box is gone — kept on a RED round for forensics.
      if (workspace !== "" && failure !== undefined) {
        evidence.push({ phase: "workspace-kept", workspace, reason: "RED round — forensics kept (bundle + records under runs/)" });
        try {
          process.stderr.write(
            `[T2.8] RED round: workspace ${workspace} KEPT for forensics; delete by hand once triaged\n`,
          );
        } catch {
          // dead stderr under an aborting runner — the evidence entry still lands
        }
      }
      const evidencePath = writeEvidenceQuietly(
        "T2.8",
        "df3-7-run-completion",
        { test: "T2.8", outcome, runId, capMicroUsd: T28_CAP_MICRO_USD, windowMs: T28_OBSERVE_WINDOW_MS, evidenceDir: EVIDENCE_DIR, phases: evidence },
        destroyFailures,
      );
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
  //   preflight          driver.whoami(), one control exec class          120 s
  //   pre-try keys       listedKeyHashes BEFORE the try (F17 baseline)     240 s
  //   dispatch verb      T28_DISPATCH_TIMEOUT_MS                          900 s
  //   positive control   one driver.list (the final-ls arm's proof)       120 s
  //   scratchClone       one real clone of the pinned sha                 180 s
  //   run verb           T28_RUN_VERB_TIMEOUT_MS                          180 s
  //   marker read        readMarkerTolerant shape, 2 × 10 s (retry arm)    20 s
  //   observe verb       window 2 700 s + chain allowance 900 s         3 600 s
  //                      (the chain: teardown ~300 + reverify ~420, T5.1's
  //                       measured ceilings, + margin — priced at the sum,
  //                       not the healthy minutes)
  //   post keys          listedKeyHashes (revoke verify)                  240 s
  //   local reads        record/bundle/rev-parse, local                     ~0 s
  //                                                            body ────────
  //                                                             5 600 s
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
  //                                                             8 110 s
  //
  // Hence 8 500 000 ms (390 s of margin over the audit). The observe verb's
  // 3 600 s term is the window this file CHOSE (T28_OBSERVE_WINDOW_MS): raise
  // the window and this ceiling must rise with it, and the HEADER's box-time
  // line too. WHOEVER RAISES AN INNER CEILING OR LENGTHENS A CLEANUP STEP
  // MUST RE-ADD IT HERE.
  8_500_000,
);
