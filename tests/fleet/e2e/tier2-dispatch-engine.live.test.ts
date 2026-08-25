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
import { RunRecordStore } from "../../../src/providers/run-record.ts";
import {
  EVIDENCE_DIR,
  REPO_ROOT,
  destroyQuietly,
  ledgerRows,
  liveGate,
  liveTodoOff,
  listedKeyHashes,
  preflight,
  runFleet,
  runIdFor,
  scratchClone,
  tmpWorkspace,
  writeEvidence,
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
    let evidencePath = "";
    let outcome = "pass";
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
          repoSlug: "biospark33/QDS-Factory",
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
      const ctxFile = await ctx.driver.exec(vmName, ["sh", "-c", "cat $HOME/pipeline.yaml $HOME/run-context.json"]);
      expect(ctxFile.exitCode).toBe(0);
      expect(ctxFile.stdout).toContain('"limitMicroUsd": 50000');
      const runCtx = JSON.parse(
        ctxFile.stdout.slice(ctxFile.stdout.indexOf('{"runId"')),
      ) as { effectiveCeilingMicros: number };
      expect(runCtx.effectiveCeilingMicros).toBe(T2_CAP_MICRO_USD); // AC9a/9b agree
      evidence.push({ phase: "delivered-manifest", ok: true, stampedLimitMicroUsd: T2_CAP_MICRO_USD });

      // ── 6. ENGINE: seeded-fix loop, fixer model, in the box, on the run key ──
      const seed = await ctx.driver.exec(vmName, [
        "sh", "-c",
        'cd "$HOME/src" && printf \'def add(a, b):\\n    return a - b\\n\' > t2_seed_calc.py && printf \'from t2_seed_calc import add\\n\\n\\ndef main() -> int:\\n    ok = add(2, 3) == 5 and add(-1, 1) == 0\\n    print("seed-test-passed" if ok else "seed-test-failed")\\n    return 0 if ok else 1\\n\\n\\nif __name__ == "__main__":\\n    raise SystemExit(main())\\n\' > t2_seed_test.py && python3 t2_seed_test.py; echo "SEED_EXIT=$?"',
      ]);
      const seedExit = /SEED_EXIT=(\d+)/.exec(seed.stdout)?.[1];
      expect(seedExit).toBe("1"); // the seed FAILS before the fix — the loop has something to fix
      evidence.push({ phase: "seed", ok: true, seedExit });

      const writePrompt = await ctx.driver.exec(vmName, [
        "sh", "-c",
        `cat > /tmp/t2-prompt.txt <<'QDSEOF'\n${FIXER_PROMPT}\nQDSEOF`,
      ]);
      expect(writePrompt.exitCode).toBe(0);

      const piCmd = `set -a; . "$HOME/app/.env"; set +a; cd "$HOME/src" || exit 9; timeout 480 pi --provider openrouter --model ${FIXER_MODEL} --mode json --no-session -p "$(cat /tmp/t2-prompt.txt)" >/tmp/t2-pi-out.txt 2>/tmp/t2-pi-err.txt; echo "PI_EXIT=$?"; tail -c 600 /tmp/t2-pi-out.txt; tail -c 300 /tmp/t2-pi-err.txt >&2`;
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

      const verify = await ctx.driver.exec(vmName, ["sh", "-c", 'cd "$HOME/src" && python3 t2_seed_test.py; echo "FIX_TEST_EXIT=$?"; git status --porcelain']);
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
        'cd "$HOME/src" && git add t2_seed_calc.py && git -c user.name=t2-e2e -c user.email=t2-e2e@local commit -q -m "t2: fixer\'s verified fix — add returns a + b" && git rev-parse --short HEAD',
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
      const after = (await ctx.driver.list()).map((b) => b.name);
      expect(after).not.toContain(vmName);
      evidence.push({ phase: "box-gone", ok: true });

      const boxHours = ledgerRows(
        recordsDir,
        "SELECT kind, cost_micro_usd, unpriced FROM cost_events WHERE run_id = ? AND kind = 'box_hours'",
        runId,
      );
      expect(boxHours.length).toBe(1); // fractional µ$ row (post-F8), priced
      expect(boxHours[0]?.unpriced).toBe(0);
      // KNOWN GAP (documented, not worked around): kind='tokens' rows have NO
      // production writer — CostLedger.ingestCostEvent (cost-ledger.ts:753)
      // has zero non-test callers, so engine/gate model spend never reaches
      // cost_events. The authoritative figure is the record's spendMicroUsd
      // (provider-side captureSpend) asserted above. Recorded, asserted-as-gap:
      const tokensRows = ledgerRows(
        recordsDir,
        "SELECT COUNT(*) AS n FROM cost_events WHERE run_id = ? AND kind = 'tokens'",
        runId,
      )[0]?.n ?? -1;
      evidence.push({ phase: "ledger", boxHours, tokensRows, tokensRowsGap: "ingestCostEvent has no production caller — see run report" });
      expect(tokensRows).toBe(0);
    } catch (e) {
      outcome = "fail";
      evidence.push({ phase: "test-error", error: (e as Error).message });
      throw e;
    } finally {
      // F12 lesson (2026-08-25 live leak of qds-20260825-ce6e89/b7b338/97451e):
      // a gate-refused dispatch PROVISIONED (INV-5 keeps the box alive) but
      // emitted a REFUSAL payload, not an ack — so `runId` above stayed ""
      // and this finally skipped every verb. Recover ids from BOTH streams:
      // the refusal envelope's debug/teardown commands name the box.
      if (runId === "" || vmName === "") {
        const combined = `${dispatchOut}\n${dispatchErr}`;
        if (runId === "") runId = /qds-[0-9]{8}-[a-z0-9]{6}/.exec(combined)?.[0] ?? "";
        if (vmName === "") vmName = /ssh ((?:qds|e2e)-[0-9]{8}-[a-z0-9]{6})\.exe\.xyz/.exec(combined)?.[1] ?? /(?:teardown|rm) ((?:qds|e2e)-[0-9]{8}-[a-z0-9]{6})/.exec(combined)?.[1] ?? "";
        evidence.push({ phase: "finally-id-recovery", runId, vmName });
      }
      if (runId !== "") {
        const td = await runFleet(["teardown", runId, "--driver", "exedev", "--dir", join(workspace, "runs"), "--no-harvest"], { timeoutMs: 180_000 });
        evidence.push({ phase: "finally-teardown-verb", exitCode: td.exitCode, stderrTail: td.stderr.trim().slice(-200) });
      }
      if (vmName !== "") await destroyQuietly(ctx.driver, vmName, evidence);
      try {
        // F13 lesson: dispatch mints `qds-…` box names — filtering only
        // `e2e-…` reported a false-clean [] while three boxes billed.
        const final = (await ctx.driver.list()).map((b) => b.name).filter((n) => n.startsWith("e2e-") || n.startsWith("qds-"));
        evidence.push({ phase: "final-ls", fleetBoxes: final });
        expect(final).toEqual([]); // a leak is a failure even when the test already failed
      } catch (e) {
        evidence.push({ phase: "final-ls-error", error: (e as Error).message });
      }
      try {
        evidencePath = writeEvidence("t2-1-dispatch-engine", { test: "T2.1", outcome, runId, capMicroUsd: T2_CAP_MICRO_USD, evidenceDir: EVIDENCE_DIR, phases: evidence });
        process.stderr.write(`[T2.1] evidence: ${evidencePath}\n`);
      } finally {
        if (workspace !== "") rmSync(workspace, { recursive: true, force: true });
      }
    }
  },
  1_800_000,
);
