/**
 * T2.1 — dispatch verb + engine + seeded-fix loop with REAL model spend
 * (e2e-plan.md §TIER-2, paths 3+4).
 *
 * GATING: QDS_E2E_LIVE=1 AND QDS_E2E_TIER=2 — liveGate("2") throws on a tier
 * mismatch or a half-configured substrate env. Normal `bun test`/CI: todo.
 * The OPERATOR approves spend OUT of band before this runs (e2e-plan budget
 * protocol): 1 key × capMicroUsd + gate C/D pings + 1 box ≤ 1h.
 *
 * ENGINE START PATH (R1, decided from source — not assumed):
 * The dispatch verb provably ends at fill → setup gate → expose → ack
 * (src/fleet/dispatch.ts:634 step list); it starts NO engine. The in-repo
 * engine drivers are host-side TypeScript (`runTeamManifest`
 * cli-anything/src/runner.ts:632 → `bun cli-anything/scripts/team-lead-driver.ts`
 * via buildTeamSpawn, cli-anything/src/team-events.ts:36) and CANNOT run in
 * the box image (no node/bun — TIER-1 finding F1). What the box DOES have is
 * `pi` plus the run key delivered at $HOME/app/.env — and the setup gate's
 * C/D assertions already drive `pi` in-box on that key. So the real in-box
 * engine invocation this test drives is the pi WORKER argv the host driver
 * owns — `buildWorkerArgv` (cli-anything/scripts/team-lead-driver.ts:377):
 * `pi --provider <p> --model <m> --mode json --no-session -p <prompt +
 * SCHEMA_INSTRUCTION>` — executed via driver.exec in the fill workdir with
 * the key sourced from the delivered env file. That is the only path where
 * engine spend lands on the RUN KEY (twice-capped: mint cap + budget
 * admission), engine edits land in the box repo (harvest-provable), and
 * teardown's captureSpend records the actual µ$.
 *
 * SEEDED-FIX SCENARIO (df1-6 run-1 shape): the manifest supports only code
 * phases, and no in-box consumer of the delivered pipeline.yaml exists today
 * (documented gap) — so the loop is the manifest's own workload equivalent:
 * a deliberately broken seed file + failing test are committed into the box
 * repo, the roster's fixer model is prompted to fix them, and the fix is
 * verified by content (test passes) + git state (file modified). Same shape
 * as _bmad-output/evidence/df1-6/e2e-live-evidence.json run 1, in the box.
 *
 * NO FAKES: real ssh exec, real OpenRouter key API, real SQLite reads, real
 * `bun scripts/fleet.ts` subprocesses. Verbatim failures in evidence.
 */
import { expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { ExecResult } from "../../../src/providers/driver.ts";
// The in-box layout, imported rather than re-spelled — see the `cat` at step 5.
import { DEFAULT_FILL_WORKDIR, QDS_IN_BOX_DIR } from "../../../src/providers/exedev/fill.ts";
import { RunRecordStore } from "../../../src/providers/run-record.ts";
// The divergence tolerance the close step itself reports against — the live
// token cross-check below compares at the SAME threshold, one source of truth.
import { SPEND_DIVERGENCE_TOLERANCE_MICRO_USD } from "../../../src/providers/teardown.ts";
import {
  EVIDENCE_DIR,
  REPO_ROOT,
  awaitBoxAbsent,
  boxHome,
  destroyQuietly,
  fleetCleanupProblems,
  fleetLeftovers,
  fleetPartialOutput,
  emittedRunId,
  keyLeakProblems,
  lastJsonLine,
  ledgerRows,
  liveGate,
  liveTodoOff,
  listedKeyHashes,
  preflight,
  recoverDispatchIds,
  runFleet,
  runIdFor,
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
/** The fixer role's model — config/rosters/roster.yaml beside the manifest. */
const FIXER_MODEL = "deepseek/deepseek-v3.2";
/**
 * The df1-6 worker reply contract, replicated from team-lead-driver.ts
 * SCHEMA_INSTRUCTION (cli-anything/scripts/team-lead-driver.ts:365). The
 * assertion below does NOT trust the reply — git state and the seeded test
 * are the ground truth — but the worker is held to the same contract the
 * host engine holds it to.
 */
const SCHEMA_INSTRUCTION =
  'Reply with ONLY a JSON object of the shape {"changedFiles": string[], "result": {"summary": string}} — changedFiles is MANDATORY (use [] when no files changed). No prose outside the JSON.';

const FIXER_PROMPT = [
  "You are the fixer worker for a live e2e run. In the current directory:",
  "t2_seed_calc.py defines add(a, b) which WRONGLY returns a - b.",
  "Run: python3 t2_seed_test.py — it fails.",
  "Fix t2_seed_calc.py so add returns a + b. Do not modify any other file.",
  "Verify: python3 t2_seed_test.py must print seed-test-passed and exit 0.",
  "",
  SCHEMA_INSTRUCTION,
].join("\n");

test.todoIf(liveTodoOff())(
  "T2.1 dispatch→engine(seeded-fix)→harvest→teardown — real exe.dev box, real model spend, capped at 50,000 µ$",
  async () => {
    liveGate("2");
    const evidence: Record<string, unknown>[] = [];
    const ctx = await preflight("2");
    const probe = runIdFor("t21probe"); // never provisioned; ls baseline anchor
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
     * The key population BEFORE this run (F17). The body's `not.toContain`
     * assertion only fires on the happy path; a teardown that destroys the box
     * and exits 0 while SKIPPING the revoke left a live key behind a green
     * round. The delta is rendered in the `finally` and folded into the same
     * verdict the box leak is.
     */
    const hashesBefore = await listedKeyHashes();
    let keyProblems: string[] = [];
    try {
      workspace = tmpWorkspace("t21");
      const recordsDir = join(workspace, "runs");
      mkdirSync(recordsDir, { recursive: true });
      // R4: the operator's cost config sits BESIDE the records dir
      // (costLedgerOpts → dirname(recordsDir)/cost-config.json). Without it,
      // admission falls back to defaultCapMicroUsd 5,000,000 µ$ ($5!) and the
      // mint would be capped five dollars high, not fifty cents of a cent.
      writeFileSync(
        join(workspace, "cost-config.json"),
        JSON.stringify({ defaultCapMicroUsd: T2_CAP_MICRO_USD, boxHourRateMicroUsd: T2_BOX_HOUR_RATE_MICRO_USD }),
      );
      // R3: the frozen brief shape. repoSlug canonically matches repoUrl's
      // path; commitSha = the pinned pushed sha; manifestPath repo-relative,
      // resolved against the dispatch subprocess cwd (= REPO_ROOT).
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
      evidence.push({ phase: "setup", ok: true, capMicroUsd: T2_CAP_MICRO_USD, boxHourRateMicroUsd: T2_BOX_HOUR_RATE_MICRO_USD });

      const before = (await ctx.driver.list()).map((b) => b.name);
      evidence.push({ phase: "ls-before", boxes: before.filter((n) => n.startsWith("e2e-")), probe });

      // ── 1. the dispatch verb, as a real subprocess, production path ──────
      // The `.catch` is the L1 fix: `runFleet`'s ceiling REJECTS, so the two
      // assignments below never ran on that path — and `dispatch` is precisely
      // the verb that creates a real box before it can still fail. Both streams
      // stayed `""`, the `finally`'s id recovery scanned an empty string, every
      // guarded cleanup leg was skipped, and `fleetLeftovers` reported a genuine
      // leak as another round's stray. `fleetPartialOutput` hands back whatever
      // the killed child had already written, which is where the box's name is.
      const dispatch = await runFleet(
        ["dispatch", "--driver", "exedev", "--brief", briefPath, "--dir", recordsDir],
        // 1_200_000, deliberately ABOVE the 900_000 tier3/tier4 use for the
        // same verb (round 3, E2-6, named because the divergence reads as an
        // inconsistency otherwise): those two files CUT to tier4's MEASURED
        // figure to make their own budget sums fit; this file's audit (foot of
        // file) prices the leg at 1 200 s and keeps the ~4/3 margin over the
        // measurement. Same verb, same substrate — different margin policies,
        // both stated. An abort at EITHER ceiling still recovers through the
        // `.catch` below.
        { cwd: REPO_ROOT, timeoutMs: 1_200_000 },
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
      // below leaves a failure path with a live box nobody owns. See
      // `emittedRunId`.
      const emitted = emittedRunId(dispatch.stdout, dispatch.stderr);
      if (emitted !== undefined) runId = emitted;
      expect(dispatch.exitCode).toBe(0);

      const ackLine = dispatch.stdout.trim().split("\n").filter((l) => l.startsWith("{")).at(-1);
      expect(ackLine).toBeDefined();
      const ack = JSON.parse(ackLine as string) as { runId: string; vmName: string; httpsUrl?: string; state: string };
      runId = ack.runId;
      vmName = ack.vmName;
      expect(ack.state).toBe("ready");
      expect(runId).toMatch(/^qds-/);
      evidence.push({ phase: "ack", runId, vmName, httpsUrl: ack.httpsUrl ?? null });

      // ── 2. the box is LIVE on the real provider ──────────────────────────
      const live = (await ctx.driver.list()).map((b) => b.name);
      expect(live).toContain(vmName);
      evidence.push({ phase: "box-live", ok: true, vmName });

      // ── 3. the run record carries the money identity ─────────────────────
      const store = new RunRecordStore({ dir: recordsDir });
      const rec = store.get(runId);
      expect(rec.vmName).toBe(vmName);
      expect(rec.commitSha).toBe(ctx.sha);
      expect(rec.keyHash ?? "").not.toBe("");
      expect(rec.limitMicroUsd).toBe(T2_CAP_MICRO_USD);
      evidence.push({ phase: "record", ok: true, keyHash: rec.keyHash, limitMicroUsd: rec.limitMicroUsd });

      // ── 4. the setup gate PASSED — all five assertions, C/D on real money ─
      const gatePath = join(REPO_ROOT, ".sandbox", "setup-gate", `${runId}.json`);
      expect(existsSync(gatePath)).toBeTrue();
      const gate = JSON.parse(readFileSync(gatePath, "utf8")) as {
        ready: boolean;
        assertions?: Array<{ item: string; ok: boolean; note: string }>;
      };
      evidence.push({ phase: "gate-evidence", gate });
      expect(gate.ready).toBe(true);
      const items = gate.assertions ?? [];
      expect(items.map((a) => a.item)).toEqual(["A", "B", "C", "D", "E"]);
      expect(items.every((a) => a.ok)).toBe(true); // C + D = the roster models answered chat/completions

      // ── 5. the dispatched manifest landed in the box with the ONE ceiling ─
      // AC2b: the manifest PAIR lives under `.qds/` INSIDE the checkout —
      // `$HOME/src/.qds/{pipeline.yaml,run-context.json}` — not beside it in the
      // ssh HOME, which is where dispatch used to put it. Spelled from the two
      // EXPORTED constants (`fill.ts`) rather than typed out, because this is a
      // live-gated body: neither `tsc` nor `bun test` nor CI executes it, so a
      // rename on either constant would leave this `cat` reading a path that no
      // longer exists and the round would die HERE, on a paid box, after the
      // dispatch and the setup gate's real model pings had already been spent.
      // The stale `$HOME/pipeline.yaml $HOME/run-context.json` spelling this
      // replaces was exactly that: `cat` exits 1 and the assertion below fails
      // on a run that was otherwise healthy.
      //
      // `$HOME` is resolved ON THE BOX first (L26), not interpolated as a
      // literal `"$HOME"` into the remote `sh -c`. Its two siblings (tier3, tier4)
      // already go through `boxHome()`, and this was the last site with a second
      // convention — safe today only because nothing here is `shellQuote`d, which
      // is the arrangement that stops being safe the moment someone quotes it
      // (a `shellQuote`d path single-quotes the dollar and `cat`s a literal
      // `$HOME` directory that does not exist). One convention: resolve, then
      // quote, so every remote path is both injection-safe and expansion-free.
      const home = await boxHome(ctx.driver, vmName);
      const qdsDir = `${home}/${DEFAULT_FILL_WORKDIR}/${QDS_IN_BOX_DIR}`;
      const ctxFile = await ctx.driver.exec(vmName, [
        "sh",
        "-c",
        `cat ${shellQuote(`${qdsDir}/pipeline.yaml`)} ${shellQuote(`${qdsDir}/run-context.json`)}`, // live-mirror: qdsDir = $HOME/<DEFAULT_FILL_WORKDIR>/<QDS_IN_BOX_DIR> (fill.ts imports)
      ]);
      expect(ctxFile.exitCode).toBe(0);
      // LM4: the cap is asserted via the CONSTANT (interpolated, so a change to
      // T2_CAP_MICRO_USD moves the assertion with it) and the run-context is
      // located by LINE BOUNDARY (the last `{`-prefixed line of the `cat`ed
      // pair — `run-context.json` is written by one `JSON.stringify`, i.e. one
      // line), not by an `{"runId"` substring. The substring form pinned the
      // writers' key ORDER as well as their spacing, so a reordered
      // run-context object failed this step — after dispatch, the gate's two
      // real model pings and a minted capped key had all been spent — on a run
      // that was otherwise healthy.
      expect(ctxFile.stdout).toContain(`"limitMicroUsd": ${T2_CAP_MICRO_USD}`);
      // Diagnosability (#210 class): record the EXACT bytes the line-boundary
      // locate is about to parse, BEFORE parsing — a parse failure here used to
      // leave no trace of whether the run-context line was absent, partial, or
      // shadowed by a later `{`-prefixed line, after dispatch had already
      // spent the gate's model pings and a minted key.
      evidence.push({
        phase: "delivered-manifest-bytes",
        stdoutTail: ctxFile.stdout.slice(-2000),
      });
      const runCtx = lastJsonLine<{ effectiveCeilingMicros: number }>(ctxFile.stdout);
      expect(runCtx.effectiveCeilingMicros).toBe(T2_CAP_MICRO_USD); // AC9a/9b agree
      evidence.push({ phase: "delivered-manifest", ok: true, stampedLimitMicroUsd: T2_CAP_MICRO_USD });

      // ── 6. ENGINE: seeded-fix loop, fixer model, in the box, on the run key ──
      const seed = await ctx.driver.exec(vmName, [
        "sh", "-c",
        'cd "$HOME/src" && printf \'def add(a, b):\\n    return a - b\\n\' > t2_seed_calc.py && printf \'from t2_seed_calc import add\\n\\n\\ndef main() -> int:\\n    ok = add(2, 3) == 5 and add(-1, 1) == 0\\n    print("seed-test-passed" if ok else "seed-test-failed")\\n    return 0 if ok else 1\\n\\n\\nif __name__ == "__main__":\\n    raise SystemExit(main())\\n\' > t2_seed_test.py && python3 t2_seed_test.py; echo "SEED_EXIT=$?"', // live-mirror: $HOME/src = DEFAULT_FILL_WORKDIR delivery root (fill.ts)
      ]);
      const seedExit = /SEED_EXIT=(\d+)/.exec(seed.stdout)?.[1];
      expect(seedExit).toBe("1"); // the seed FAILS before the fix — the loop has something to fix
      evidence.push({ phase: "seed", ok: true, seedExit });

      const writePrompt = await ctx.driver.exec(vmName, [
        "sh", "-c",
        `cat > /tmp/t2-prompt.txt <<'QDSEOF'\n${FIXER_PROMPT}\nQDSEOF`,
      ]);
      expect(writePrompt.exitCode).toBe(0);

      const piCmd = `set -a; . "$HOME/app/.env"; set +a; cd "$HOME/src" || exit 9; timeout 480 pi --provider openrouter --model ${FIXER_MODEL} --mode json --no-session -p "$(cat /tmp/t2-prompt.txt)" >/tmp/t2-pi-out.txt 2>/tmp/t2-pi-err.txt; echo "PI_EXIT=$?"; tail -c 600 /tmp/t2-pi-out.txt; tail -c 300 /tmp/t2-pi-err.txt >&2`; // live-mirror: $HOME/app/.env = unit EnvironmentFile + KEY_ENV_FILE (credentials.ts); $HOME/src = DEFAULT_FILL_WORKDIR (fill.ts)
      const runPi = (): Promise<ExecResult> => ctx.driver.execTimed(vmName, ["sh", "-c", piCmd], 540_000);
      let engine = await runPi();
      let attempt = 1;
      // Fresh-box pi stalls are a measured substrate fact (cap-hit-demo runs
      // 9-16, 2026-08-19): one bounded retry, exactly like the demo's warmup.
      if (!/PI_EXIT=0/.test(engine.stdout)) {
        await new Promise((r) => setTimeout(r, 30_000));
        engine = await runPi();
        attempt = 2;
      }
      evidence.push({
        phase: "engine-pi",
        attempt,
        exitCode: engine.exitCode,
        stdoutTail: engine.stdout.trim().slice(-700),
        stderrTail: engine.stderr.trim().slice(-300),
      });
      expect(/PI_EXIT=0/.test(engine.stdout)).toBe(true);

      const verify = await ctx.driver.exec(vmName, ["sh", "-c", 'cd "$HOME/src" && python3 t2_seed_test.py; echo "FIX_TEST_EXIT=$?"; git status --porcelain']); // live-mirror: $HOME/src = DEFAULT_FILL_WORKDIR delivery root (fill.ts)
      evidence.push({ phase: "engine-verify", stdout: verify.stdout.trim().slice(0, 500) });
      expect(/FIX_TEST_EXIT=0/.test(verify.stdout)).toBe(true); // the seeded test now PASSES
      expect(verify.stdout).toContain("t2_seed_calc.py"); // and git sees the fixer's edit

      // Commit the VERIFIED fix on the box: harvest counts commits on
      // sbx/<runId> (NOCOMMITS ⇒ outcome "none"), and the fixer's edit was
      // left as an untracked working-tree change. The MODEL made and proved
      // the fix above; this is the harness plumbing that hands verified work
      // to the harvest verb — first live T2.1 run died exactly here
      // ("harvested: none", bundle never written).
      const commitFix = await ctx.driver.exec(vmName, [
        "sh", "-c",
        'cd "$HOME/src" && git add t2_seed_calc.py && git -c user.name=t2-e2e -c user.email=t2-e2e@local commit -q -m "t2: fixer\'s verified fix — add returns a + b" && git rev-parse --short HEAD', // live-mirror: $HOME/src = DEFAULT_FILL_WORKDIR delivery root (fill.ts)
      ]);
      evidence.push({ phase: "commit-fix", exitCode: commitFix.exitCode, sha: commitFix.stdout.trim() });
      expect(commitFix.exitCode).toBe(0);

      // ── 7. harvest the fixed tree out (bundle → host verify → quarantine) ─
      const hostRepo = await scratchClone(ctx.repoUrl, ctx.sha, workspace);
      const harvest = await runFleet(["harvest", runId, "--driver", "exedev", "--dir", recordsDir], {
        cwd: hostRepo,
        timeoutMs: 300_000,
      });
      evidence.push({ phase: "harvest-verb", exitCode: harvest.exitCode, stdout: harvest.stdout.trim().slice(0, 300), stderrTail: harvest.stderr.trim().slice(-400) });
      expect(harvest.exitCode).toBe(0);
      const bundle = join(recordsDir, `${runId}.bundle`);
      expect(existsSync(bundle)).toBeTrue();
      const v = Bun.spawnSync({ cmd: ["git", "bundle", "verify", bundle], cwd: hostRepo, stdout: "pipe", stderr: "pipe" });
      expect(v.exitCode).toBe(0);
      const tip = Bun.spawnSync({ cmd: ["git", "rev-parse", "--verify", `refs/sandbox/${runId}`], cwd: hostRepo, stdout: "pipe", stderr: "pipe" });
      expect(tip.exitCode).toBe(0);
      const fixed = Bun.spawnSync({ cmd: ["git", "show", `refs/sandbox/${runId}:t2_seed_calc.py`], cwd: hostRepo, stdout: "pipe", stderr: "pipe" });
      expect(fixed.stdout.toString()).toContain("a + b"); // the FIX rode the bundle out
      evidence.push({ phase: "harvest-verified", ok: true, tip: tip.stdout.toString().trim(), fixInBundle: true });

      // ── 8. teardown: full chain, spend captured, key revoked, box gone ───
      const teardown = await runFleet(["teardown", runId, "--driver", "exedev", "--dir", recordsDir], {
        cwd: hostRepo,
        timeoutMs: 300_000,
      });
      evidence.push({ phase: "teardown-verb", exitCode: teardown.exitCode, stdout: teardown.stdout.trim().slice(0, 300), stderrTail: teardown.stderr.trim().slice(-400) });
      expect(teardown.exitCode).toBe(0);

      const closed = new RunRecordStore({ dir: recordsDir }).get(runId);
      expect(closed.closedAt ?? "").not.toBe("");
      expect(closed.spendMicroUsd ?? 0).toBeGreaterThan(0);
      expect(closed.spendMicroUsd ?? 1).toBeLessThanOrEqual(T2_CAP_MICRO_USD);
      evidence.push({ phase: "spend", capMicroUsd: T2_CAP_MICRO_USD, actualMicroUsd: closed.spendMicroUsd });

      expect(await listedKeyHashes()).not.toContain(closed.keyHash); // revoked + verified
      // POLLED (L3): exe.dev's destroy lag is MEASURED at 25 s+ — `rm` exits 0
      // while the box stays listed — which is why `fleetLeftovers` polls at all.
      // A single `driver.list()` taken milliseconds after `teardown` returned
      // turned substrate lag into a red round on a paid test. `awaitBoxAbsent`
      // only LOOKS; unlike `fleetLeftovers` it does not destroy a survivor
      // first, so it cannot report clean for a teardown that destroyed nothing.
      const gone = await awaitBoxAbsent(ctx.driver, vmName, evidence, { maxAttempts: 4, retryDelayMs: 10_000 });
      expect(gone.absent).toBeTrue();

      const boxHours = ledgerRows(
        recordsDir,
        "SELECT kind, cost_micro_usd, unpriced FROM cost_events WHERE run_id = ? AND kind = 'box_hours'",
        runId,
      );
      expect(boxHours.length).toBe(1); // fractional µ$ row (post-F8), priced
      expect(boxHours[0]?.unpriced).toBe(0);
      // WIRED (DF2.12): kind='tokens' rows land through the host bridge —
      // `CostLedger.ingestCostEvent` in `src/providers/cost-ledger.ts` (cited
      // by symbol, not line: the old `:753` pointed at a blank line between
      // `AdmissionInput` and `AdmissionDecision`, having drifted ~200 lines),
      // driven by `src/providers/cost-ledger-bridge.ts` from the harvested
      // engine log at teardown's close step. A priced engine run therefore
      // leaves token rows, asserted below; the record's spendMicroUsd
      // (provider-side captureSpend) stays the authoritative figure.
      //
      // W2-2 (PR #253 review): a row COUNT alone passes a partial harvest —
      // rows present but every one unpriced while the provider charged. So
      // the PRICED token sum is cross-checked against the record's
      // authoritative spend figure, like for like (tokens only, unpriced
      // excluded) at the same tolerance reportSpendDivergence runs at close.
      const tokens = ledgerRows(
        recordsDir,
        "SELECT COUNT(*) AS n, COALESCE(SUM(CASE WHEN unpriced = 0 THEN cost_micro_usd ELSE 0 END), 0) AS pricedMicroUsd FROM cost_events WHERE run_id = ? AND kind = 'tokens'",
        runId,
      )[0] as { n: number; pricedMicroUsd: number } | undefined;
      const tokenRows = tokens?.n ?? -1;
      const pricedTokenMicroUsd = Number(tokens?.pricedMicroUsd ?? -1);
      evidence.push({
        phase: "ledger",
        boxHours,
        tokenRows,
        pricedTokenMicroUsd,
        spendMicroUsd: closed.spendMicroUsd,
        crossCheck: "SUM(cost_micro_usd WHERE unpriced = 0) vs the record's captureSpend figure, tolerance from teardown's SPEND_DIVERGENCE_TOLERANCE_MICRO_USD",
      });
      expect(tokenRows).toBeGreaterThan(0);
      expect(Math.abs((closed.spendMicroUsd ?? 0) - pricedTokenMicroUsd)).toBeLessThanOrEqual(
        SPEND_DIVERGENCE_TOLERANCE_MICRO_USD,
      );
    } catch (e) {
      outcome = "fail";
      // HELD, not thrown (EB3): the post-finally verdicts below must render on
      // the red path too — the failing run is the one most likely to leak.
      failure = e;
      // B31: a non-Error throw (string, plain object) has no `message` — `String(?? e)` keeps the evidence entry populated instead of `undefined`.
      evidence.push({ phase: "test-error", error: String((e as Error)?.message ?? e) });
    } finally {
      // F12 lesson (2026-08-25 live leak of qds-20260825-ce6e89/b7b338/97451e):
      // a gate-refused dispatch PROVISIONED (INV-5 keeps the box alive) but
      // emitted a REFUSAL payload, not an ack — so `runId` above stayed ""
      // and this finally skipped every verb. Recover ids from BOTH streams:
      // the refusal envelope's debug/teardown commands name the box.
      //
      // Through `recoverDispatchIds` (L13): the inline copy here matched
      // `qds-[0-9]{8}-[a-z0-9]{6}` while `emittedRunId` matched `qds-[a-z0-9-]+`,
      // so an id satisfying one and not the other was recovered on the ACK path
      // and NOT on this one — the only path the fallback exists for. One
      // exported grammar, both callers.
      if (runId === "" || vmName === "") {
        const recovered = recoverDispatchIds(dispatchOut, dispatchErr);
        if (runId === "") runId = recovered.runId;
        if (vmName === "") vmName = recovered.vmName;
        evidence.push({ phase: "finally-id-recovery", runId, vmName });
      }
      if (runId !== "") {
        // `teardownQuietly`, not a bare `runFleet` (F2): the 180 s ceiling
        // REJECTS, and an unguarded await let that rejection escape this
        // `finally` at the await — skipping the box destroy on the very next
        // line, the leftover sweep, the evidence write and `settleRun` itself,
        // while replacing the body's held error with a teardown timeout.
        const torn = await teardownQuietly(
          ["teardown", runId, "--driver", "exedev", "--dir", join(workspace, "runs"), "--no-harvest"],
          { timeoutMs: 180_000 },
          evidence,
          { at: "teardown-verb", runId },
        );
        if (!torn.ok) destroyFailures.push(`${runId}: ${torn.error}`);
      }
      if (vmName !== "") {
        const destroyed = await destroyQuietly(ctx.driver, vmName, evidence);
        if (!destroyed.ok) destroyFailures.push(`${vmName}: ${destroyed.error}`);
      }
      // The hand-rolled 5 × 8 s poll that used to live here is now
      // `fleetLeftovers` — SAME numbers, same `final-ls-retry` phase (the
      // r7-T-h1 measurement: destroy `rm` exits 0 while the box stays listed
      // 25 s+, and the F13 lesson that dispatch mints `qds-…` names, are both
      // inside the helper now). It additionally DESTROYS what this run owns
      // before reporting it, and demotes every other `e2e-`/`qds-` box in the
      // account to a warning it has already surfaced — `strays` must NOT be
      // folded into the verdict, or one box stranded by a previous round fails
      // every test in this one. It never throws, so no try/catch: a failed
      // listing comes back as `owned: undefined`, which `fleetCleanupProblems`
      // renders as a problem, and a local catch would swallow exactly that.
      finalBoxes = (await fleetLeftovers(ctx.driver, [runId, vmName], evidence)).owned;
      // The store the key verdict needs, built ABOVE the call and in its own
      // try. As an argument expression it was the one throw-capable call left
      // unguarded in this `finally`: the write-mode constructor runs
      // `assertDirMode0700` → `chmodSync`, `assertExclusiveCreateSupported()`
      // and `cleanStaleTemps()` (run-record.ts), and an EPERM/EROFS from any of
      // them escaped the `finally` at that line — discarding the accumulated
      // box-leak verdict and skipping the evidence write and `settleRun`, which
      // is the exact F2/F11 shape the rest of this file removes. `undefined` on
      // throw is the truthful fallback: `keyLeakProblems` then reports the delta
      // without a record-backed fallback revoke, and says so.
      let recordStore: RunRecordStore | undefined;
      try {
        if (workspace !== "") recordStore = new RunRecordStore({ dir: join(workspace, "runs") });
      } catch (e) {
        evidence.push({ phase: "finally-store", ok: false, error: (e as Error).message });
      }
      // `hashesBefore` is ACCOUNT-WIDE, so a key minted between the two listings
      // by a CONCURRENT round (a second operator, a parallel tier) lands in this
      // run's delta and is reported as this run's leak — a false red on a clean
      // paid round, which the fallback revoke never clears because it only
      // revokes THIS run's runIds. So: attribute first. Only the hash this run's
      // record names is provably ours; the rest of the delta is folded into the
      // baseline and RECORDED as a warning, the same report-wide/act-narrow
      // split `fleetLeftovers` applies to stray boxes. Stated cost: a key the
      // dispatch subprocess minted whose hash never reached the record now warns
      // instead of failing — `mintRunKey` persists `keyHash` before its own
      // later refusals can throw, so that window is the record write itself.
      let keyBaseline: ReadonlySet<string> = hashesBefore;
      try {
        const ours = new Set<string>();
        // E2-5: three attribution states, not two. `runId === ""` or an
        // unreadable record means the question was never ANSWERED (keep the
        // L2 fail-closed gate below); a READABLE record with no `keyHash` is
        // an ANSWER — the setup gate refused before any mint (the F12 lesson
        // path, INV-5 keeps the record open) — and on that path folding
        // `foreign` into the baseline is sound, exactly like the
        // report-wide/act-narrow split `fleetLeftovers` applies. Without the
        // split, a concurrent round's mint in the window was reported as THIS
        // run's leak: a false red on a clean paid round the fallback revoke
        // never clears.
        let attributionAnswered = false;
        try {
          if (runId !== "") {
            const rec = recordStore?.get(runId) as { keyHash?: string } | undefined;
            if (rec !== undefined) {
              attributionAnswered = true;
              if (rec.keyHash !== undefined && rec.keyHash !== "") ours.add(rec.keyHash);
            }
          }
        } catch {
          // unreadable/absent record — its hash stays unattributed, i.e. a warning
        }
        const foreign = [...(await listedKeyHashes())].filter((h) => !hashesBefore.has(h) && !ours.has(h));
        // GATED ON THE ATTRIBUTION SUCCEEDING (L2). Widening the baseline is
        // only sound while this run's OWN hash has been identified and excluded.
        // With `runId === ""` (the L1 path) or an unreadable record, `ours` is
        // EMPTY — so this run's freshly-minted, still-live capped key lands in
        // `foreign`, is folded into the baseline, and `keyLeakProblems` reports
        // nothing, while `runIds: [""]` gives the fallback revoke nothing to
        // revoke. F17's purpose is INVERTED on exactly the path where the revoke
        // is most likely to have been skipped. Unattributed ⇒ the account-wide
        // baseline stands, which can only report MORE: fail closed.
        if (foreign.length > 0 && (ours.size > 0 || attributionAnswered)) {
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
            note: "this run's own key hash could NOT be attributed (no runId, or an unreadable record), so the delta is NOT folded — the account-wide comparison stands and fails closed",
          });
        }
      } catch (e) {
        // The attribution listing failed; fall back to the account-wide
        // baseline, which can only report MORE, never less — the fail-closed
        // direction.
        evidence.push({ phase: "key-hash-delta-foreign", ok: false, error: (e as Error).message });
      }
      // The KEY leak verdict, beside the box one (F17): revoke-first, then
      // report — a round that needed the fallback is not a clean round.
      keyProblems = await keyLeakProblems(
        keyBaseline,
        { driver: ctx.driver, store: recordStore, runIds: [runId] },
        evidence,
      );
      // `writeEvidenceQuietly` (F11): `writeEvidence` THROWS — the secret-scrub
      // refusal above all — and an uncaught throw here propagated out of this
      // `finally`, making `settleRun` below unreachable on exactly the run that
      // most needs it. Now it is a problem the verdict renders.
      writeEvidenceQuietly("T2.1", "t2-1-dispatch-engine", { test: "T2.1", outcome, runId, capMicroUsd: T2_CAP_MICRO_USD, evidenceDir: EVIDENCE_DIR, phases: evidence }, destroyFailures);
      if (workspace !== "") rmSync(workspace, { recursive: true, force: true });
    }

    // ── the post-`finally` verdict (EB3), in ONE place: `settleRun` fails a
    // green run on a cleanup problem, and on a RED one ATTACHES the problem to
    // the body's own error instead of throwing over the top of it — the bare
    // `expect(destroyFailures)` this replaces discarded the held failure
    // whenever a leak and a real regression happened on the same run.
    //
    // `evidence` as the third argument folds every `finally-revoke ok:false`
    // entry into the verdict — a `revokeQuietly` that could not prove the key
    // was dead used to be evidence prose nothing asserted.  ──────────────────
    settleRun(failure, [...fleetCleanupProblems(destroyFailures, finalBoxes, evidence), ...keyProblems]);
  },
  // Budget audit (the tier2-image-contract shape), priced at DECLARED CEILINGS
  // — not at typical latency. A bun test-timeout abort is the ONE path where
  // the `finally` above does not execute, so it is the one path that leaves a
  // real box billing AND a minted key live. This file used to be budgeted at
  // 1 800 000 ms against `dispatch` 1 200 + `harvest` 300 + `teardown` 300 =
  // exactly 1 800 s of its own inner ceilings, leaving zero seconds for the
  // engine leg, the clone, the ledger reads or ANY of the cleanup below.
  //
  //   ls-before          1 control ls at 120                             120 s
  //   dispatch verb      runFleet timeoutMs 1_200_000                  1 200 s
  //   box-live ls        1 control ls at 120                             120 s
  //   in-box probes      5 × driver.exec at DEFAULT_EXEC_TIMEOUT_MS 120  600 s
  //                      (boxHome, delivered manifest, seed, prompt write,
  //                       verify — boxHome is new: step 5 resolves `$HOME` on
  //                       the box instead of interpolating a literal "$HOME"
  //                       into the remote sh -c, which is the one convention
  //                       its two siblings already used, L26)
  //   engine (pi)        2 × execTimed 540 + the 30 s inter-attempt wait 1110 s
  //   commit-fix exec    1 × 120                                         120 s
  //   scratchClone       one real clone of the pinned sha, allowance     180 s
  //   harvest verb       runFleet timeoutMs 300_000                      300 s
  //   teardown verb      runFleet timeoutMs 300_000                      300 s
  //   box-absence poll   awaitBoxAbsent 4 × (control ls 120 + 10 wait)   510 s
  //                      (was ONE `driver.list()` taken inside the MEASURED
  //                       25 s+ substrate destroy lag — L3)
  //   post-teardown      listedKeyHashes, allowance                      240 s
  //   ledger + records   local SQLite/JSON reads                          10 s
  //                                                              body ────────
  //                                                                    4 810 s
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
  //                                                                    6 480 s
  //
  // Hence 6 600 s. Every inner ceiling FIRING is safe — it rejects into the
  // catch and the `finally` still runs — so the fail-safe direction for this
  // number is UP: it is what a fully degraded round may consume before the one
  // abort that skips cleanup, not a target. A healthy round finishes far inside
  // it. WHOEVER RAISES AN INNER CEILING OR ADDS A CLEANUP STEP MUST RE-ADD IT
  // HERE.
  6_600_000,
);
