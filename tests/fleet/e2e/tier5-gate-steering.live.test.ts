/**
 * T5.1 — the DF3.4 chain, END TO END on real infrastructure, with real model
 * spend: dispatch (real setup gate, C/D on the roster models) → real in-box
 * engine work (pi on the run key) → `fleet attach` mid-run (the AC6 transport,
 * live) → harvest → real DF2.5 teardown → REAL reverify (DF5.1: quarantine
 * worktree, host-pinned plan, green verdict) → the gate REQUESTS approval →
 * `awaiting-approval` → operator approves over stdin → the record carries
 * `approved` — and attach refuses an approved run.
 *
 * T1.7 proves the gate against a hand-built record; D8 proves the shipped port
 * with the box already gone. What NEITHER can prove is the CHAIN: that a run
 * dispatched through the production verb, worked by a real model, torn down by
 * the production teardown, and re-verified by the production `reverify()`
 * lands at the same `awaiting-approval` an operator can then decide — with
 * every join key (`requestId`, `reportId`, `headSha`) flowing from the real
 * dispatch rather than from a test's hands.
 *
 * THE HONEST NO-ACK (read before "fixing" this test): the attach leg here
 * asserts `attach-not-acked` / reason `no-ack` / exit 6 as the PASS shape.
 * Production has no in-box engine — the steering consumer (`localSteeringInbox`)
 * runs only inside `pipeline-run.ts`, which cannot run in-box (no bun; the
 * in-box executor is proposed story DF1.10, `pipeline-run-remote.ts:5-19`). So
 * a real box acks nothing, and "the message IS queued" is the shipped
 * contract. The transport proof is that the line lands IN THE BOX verbatim
 * (read back through `driver.exec`), not that an engine folded it — an
 * `attach-acked` live assertion would require faking the engine leg, which the
 * no-fakes rule forbids. The acked loop stays covered by
 * `tests/fleet/attach.test.ts` (FakeDriver) until DF1.10 lands.
 *
 * THE HOST PLAN is operator-authored, on purpose: reverify never trusts the
 * harvested tree to judge itself (INV-RV-1, plan.ts "the tree supplies the
 * code to run; it never supplies the command that judges it"). This test
 * writes the operator's `.factory/pipeline.json` + a small DF1.1 manifest into
 * the host clone, pinning `bun test tests/fleet/approvers.test.ts` (94 tests,
 * ~7.5 s, no network, no credentials — measured 2026-08-30) as the judging
 * suite. That is exactly the authority an operator exercises in production;
 * the suite is small so the round buys chain-coverage, not a second full
 * `bun test`.
 *
 * SPEND (operator-approved, e2e budget protocol): 1 key capped at 50 000 µ$
 * (setup-gate C/D chat pings + the pi engine step), 1 box ≤ 1 h at
 * 230 000 µ$/h. Worst case ≈ $0.28.
 *
 * NO FAKES anywhere in this file: real ssh, real OpenRouter key API, real
 * SQLite, real `bun scripts/fleet.ts` / `bun scripts/reverify.ts`
 * subprocesses. Verbatim failures in evidence; `finally` destroys the box,
 * revokes the key, and writes evidence PASS or FAIL.
 */
import { expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, chmodSync, statSync } from "node:fs";
import { join } from "node:path";

import type { ExecResult } from "../../../src/providers/driver.ts";
import { RunRecordStore } from "../../../src/providers/run-record.ts";
import { scryptToken, SCRYPT_PARAMS } from "../../../src/fleet/approvers.ts";
import {
  REPO_ROOT,
  boxExec,
  destroyQuietly,
  fetchBoxFile,
  listedKeyHashes,
  liveGate,
  liveTodoOff,
  preflight,
  revokeQuietly,
  runFleet,
  runFleetWithToken,
  runIdFor,
  scratchClone,
  tmpWorkspace,
  writeEvidence,
} from "./live-harness.ts";

/** Plan default: 50,000 µ$ = $0.05 worst-case model spend on the run key. */
const T5_CAP_MICRO_USD = 50_000;
/** Box-hour rate mirroring exe.dev's 2CPU/8GiB rate (T1.4/T2.1's figure). */
const T5_BOX_HOUR_RATE_MICRO_USD = 230_000;
/** The fixer role's model — config/rosters/roster.yaml beside the manifest. */
const FIXER_MODEL = "deepseek/deepseek-v3.2";
/** Obviously-fake sentinel; only its SALTED HASH is ever written to disk. */
const APPROVER_ID = "t5-e2e-operator@example.test";
const APPROVER_TOKEN = "fake-t5-e2e-approver-token-do-not-reuse";
const APPROVER_SALT = "t5-e2e-salt";
/** The in-box steering paths, as attach.ts resolves them with no override. */
const BOX_INBOX = "/run/steering/inbox.ndjson";
const BOX_ACKS = "/run/steering/acks.ndjson";
/** The message T5.1 steers with — asserted verbatim off the box. */
const STEER_MESSAGE = "t5.1: prefer the smallest fix that turns the seed test green";

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
  "t5_seed_calc.py defines add(a, b) which WRONGLY returns a - b.",
  "Run: python3 t5_seed_test.py — it fails.",
  "Fix t5_seed_calc.py so add returns a + b. Do not modify any other file.",
  "Verify: python3 t5_seed_test.py must print seed-test-passed and exit 0.",
  "",
  SCHEMA_INSTRUCTION,
].join("\n");

/** The last JSON line of a verb's stdout — the verb's OUTPUT, not its prose. */
const lastJson = <T>(stdout: string): T =>
  JSON.parse(stdout.trim().split("\n").filter(Boolean).at(-1) ?? "{}") as T;

/** The stderr envelope a refusing verb printed, by `code`. */
function envelope(stderr: string, code: string): Record<string, unknown> | undefined {
  return stderr
    .split("\n")
    .filter((l) => l.startsWith("{"))
    .map((l) => JSON.parse(l) as Record<string, unknown>)
    .find((l) => l.code === code);
}

/** The structured gate-event line a verb wrote on stderr, by `event`. */
function gateLine(stderr: string, event: string): Record<string, unknown> | undefined {
  return stderr
    .split("\n")
    .filter((l) => l.startsWith("{"))
    .flatMap((l) => {
      try {
        return [JSON.parse(l) as Record<string, unknown>];
      } catch {
        return [];
      }
    })
    .find((l) => l.event === event);
}

test.todoIf(liveTodoOff())(
  "T5.1 gate+steering e2e: dispatch → engine → attach(transport, honest no-ack) → harvest → teardown → reverify(green) → awaiting-approval → approve over stdin",
  async () => {
    liveGate("2");
    const evidence: Record<string, unknown>[] = [];
    const ctx = await preflight("2");
    const probe = runIdFor("t51probe"); // never provisioned; ls baseline anchor
    let workspace = "";
    let runId = "";
    let vmName = "";
    let dispatchOut = "";
    let dispatchErr = "";
    let evidencePath = "";
    let outcome = "pass";
    let teardownSucceeded = false;
    let recordRequestId = "";
    /** Key hashes present before the run; the delta is asserted below the finally. */
    const hashesBefore = await listedKeyHashes();
    let leaked: string[] = [];
    let deltaError: string | undefined;
    try {
      workspace = tmpWorkspace("t51");
      const recordsDir = join(workspace, "runs");
      mkdirSync(recordsDir, { recursive: true });
      // BESIDE the records dir (costLedgerOpts → dirname(recordsDir)): without
      // it admission falls back to defaultCapMicroUsd 5,000,000 µ$ ($5) and
      // the box-hour close fail-louds `box-hour-rate-unconfigured`.
      writeFileSync(
        join(workspace, "cost-config.json"),
        JSON.stringify({ defaultCapMicroUsd: T5_CAP_MICRO_USD, boxHourRateMicroUsd: T5_BOX_HOUR_RATE_MICRO_USD }),
      );
      // The frozen brief shape (R3): repoSlug canonically matches repoUrl's
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
      evidence.push({ phase: "setup", ok: true, capMicroUsd: T5_CAP_MICRO_USD });

      // ── 1. the dispatch verb, as a real subprocess, production path. The
      //    setup gate's C/D assertions chat with the roster models on the
      //    minted run key — that is the round's first real spend ────────────
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

      // ── 2. the record carries the money + correlation identity. requestId
      //    is the JOIN KEY for everything downstream: the attach line echoes
      //    it, and the approve gate event carries it as `dispatchRequestId` ──
      const store = new RunRecordStore({ dir: recordsDir });
      const rec = store.get(runId);
      expect(rec.vmName).toBe(vmName);
      expect(rec.commitSha).toBe(ctx.sha);
      expect(rec.keyHash ?? "").not.toBe("");
      expect(rec.limitMicroUsd).toBe(T5_CAP_MICRO_USD);
      expect(typeof rec.requestId).toBe("string");
      recordRequestId = rec.requestId as string;
      evidence.push({ phase: "record", ok: true, keyHash: rec.keyHash, limitMicroUsd: rec.limitMicroUsd, requestId: recordRequestId });

      // ── 3. the setup gate PASSED — all five assertions, C/D on real money ─
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
      expect(items.every((a) => a.ok)).toBe(true); // C + D = the roster models answered on the run key

      // ── 4. ENGINE: seeded-fix loop, fixer model, in the box, on the run key.
      //    T2.1's proven shape (fresh-box pi stalls get ONE bounded retry) ───
      const seed = await ctx.driver.exec(vmName, [
        "sh", "-c",
        'cd "$HOME/src" && printf \'def add(a, b):\\n    return a - b\\n\' > t5_seed_calc.py && printf \'from t5_seed_calc import add\\n\\n\\ndef main() -> int:\\n    ok = add(2, 3) == 5 and add(-1, 1) == 0\\n    print("seed-test-passed" if ok else "seed-test-failed")\\n    return 0 if ok else 1\\n\\n\\nif __name__ == "__main__":\\n    raise SystemExit(main())\\n\' > t5_seed_test.py && python3 t5_seed_test.py; echo "SEED_EXIT=$?"',
      ]);
      const seedExit = /SEED_EXIT=(\d+)/.exec(seed.stdout)?.[1];
      expect(seedExit).toBe("1"); // the seed FAILS before the fix — the loop has something to fix
      evidence.push({ phase: "seed", ok: true, seedExit });

      const writePrompt = await ctx.driver.exec(vmName, [
        "sh", "-c",
        `cat > /tmp/t5-prompt.txt <<'QDSEOF'\n${FIXER_PROMPT}\nQDSEOF`,
      ]);
      expect(writePrompt.exitCode).toBe(0);

      const piCmd = `set -a; . "$HOME/app/.env"; set +a; cd "$HOME/src" || exit 9; timeout 480 pi --provider openrouter --model ${FIXER_MODEL} --mode json --no-session -p "$(cat /tmp/t5-prompt.txt)" >/tmp/t5-pi-out.txt 2>/tmp/t5-pi-err.txt; echo "PI_EXIT=$?"; tail -c 600 /tmp/t5-pi-out.txt; tail -c 300 /tmp/t5-pi-err.txt >&2`;
      const runPi = (): Promise<ExecResult> => ctx.driver.execTimed(vmName, ["sh", "-c", piCmd], 540_000);
      let engine = await runPi();
      let attempt = 1;
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

      const verify = await ctx.driver.exec(vmName, ["sh", "-c", 'cd "$HOME/src" && python3 t5_seed_test.py; echo "FIX_TEST_EXIT=$?"; git status --porcelain']);
      evidence.push({ phase: "engine-verify", stdout: verify.stdout.trim().slice(0, 500) });
      expect(/FIX_TEST_EXIT=0/.test(verify.stdout)).toBe(true); // the seeded test now PASSES
      expect(verify.stdout).toContain("t5_seed_calc.py"); // and git sees the fixer's edit

      // Commit the VERIFIED fix on the box: harvest counts commits on
      // sbx/<runId>, and reverify's zero-commits arm (`nothing-to-verify`)
      // would return BEFORE the gate without this (runner.ts:282-292).
      const commitFix = await ctx.driver.exec(vmName, [
        "sh", "-c",
        'cd "$HOME/src" && git add t5_seed_calc.py && git -c user.name=t5-e2e -c user.email=t5-e2e@local commit -q -m "t5: fixer\'s verified fix — add returns a + b" && git rev-parse --short HEAD',
      ]);
      evidence.push({ phase: "commit-fix", exitCode: commitFix.exitCode, sha: commitFix.stdout.trim() });
      expect(commitFix.exitCode).toBe(0);

      // ── 5. ATTACH, MID-RUN: record open, box alive, the REAL 30 s ceiling.
      //    The pass shape is exit 6 / no-ack (no in-box consumer — DF1.10);
      //    the transport proof is the line landing IN THE BOX verbatim ──────
      const attach = await runFleet(
        ["attach", runId, "--driver", "exedev", "--message", STEER_MESSAGE, "--dir", recordsDir],
        { timeoutMs: 180_000 },
      );
      evidence.push({
        phase: "attach-midrun",
        exitCode: attach.exitCode,
        stdout: attach.stdout.trim().slice(0, 400),
        stderrTail: attach.stderr.trim().slice(-800),
      });
      expect(attach.exitCode).toBe(6);
      const ackAttach = lastJson<{ runId: string; outcome: string; messageId: string; dispatchRequestId?: string }>(attach.stdout);
      expect(ackAttach.outcome).toBe("attach-not-acked");
      expect(ackAttach.runId).toBe(runId);
      expect(ackAttach.dispatchRequestId).toBe(recordRequestId);
      expect(envelope(attach.stderr, "attach-not-acked")).toMatchObject({ runId: runId, reason: "no-ack" });
      const inboxLine = JSON.parse((await fetchBoxFile(vmName, BOX_INBOX)).split("\n").filter((l) => l.trim().length > 0).at(-1) as string) as {
        messageId: string;
        requestId?: string;
        runId: string;
        message: string;
      };
      expect(inboxLine.messageId).toBe(ackAttach.messageId);
      expect(inboxLine.requestId).toBe(recordRequestId);
      expect(inboxLine.message).toBe(STEER_MESSAGE);
      // No acks file can exist: nothing in this box folds messages (DF1.10).
      const acksProbe = await boxExec(vmName, ["sh", "-c", `test -e ${JSON.stringify(BOX_ACKS)} && echo PRESENT || echo ABSENT`]);
      evidence.push({ phase: "attach-inbox-proof", messageId: ackAttach.messageId, acksFile: acksProbe.stdout.trim() });
      expect(acksProbe.stdout).toContain("ABSENT");

      // ── 6. HARVEST: bundle out, verified against a host clone that owns
      //    the pinned base SHA ──────────────────────────────────────────────
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
      const headSha = tip.stdout.toString().trim();
      const fixed = Bun.spawnSync({ cmd: ["git", "show", `refs/sandbox/${runId}:t5_seed_calc.py`], cwd: hostRepo, stdout: "pipe", stderr: "pipe" });
      expect(fixed.stdout.toString()).toContain("a + b"); // the FIX rode the bundle out
      evidence.push({ phase: "harvest-verified", ok: true, headSha });

      // ── 7. TEARDOWN: the real DF2.5 chain — spend capture, revoke AND
      //    verify, destroy, priced close. The shipped order: teardown is
      //    BEFORE reverify, whose gate port has no teardown seam and refuses
      //    an open record that still owns a vmName (D8's finding) ───────────
      const teardown = await runFleet(["teardown", runId, "--driver", "exedev", "--dir", recordsDir], {
        cwd: hostRepo,
        timeoutMs: 300_000,
      });
      teardownSucceeded = teardown.exitCode === 0;
      evidence.push({ phase: "teardown-verb", exitCode: teardown.exitCode, stdout: teardown.stdout.trim().slice(0, 300), stderrTail: teardown.stderr.trim().slice(-400) });
      expect(teardown.exitCode).toBe(0);
      const closed = new RunRecordStore({ dir: recordsDir }).get(runId);
      expect(closed.closedAt ?? "").not.toBe("");
      expect(closed.spendMicroUsd ?? 0).toBeGreaterThan(0);
      expect(closed.spendMicroUsd ?? 1).toBeLessThanOrEqual(T5_CAP_MICRO_USD);
      expect(await listedKeyHashes()).not.toContain(closed.keyHash); // revoked + verified
      const afterTd = (await ctx.driver.list()).map((b) => b.name);
      expect(afterTd).not.toContain(vmName);
      evidence.push({ phase: "spend", capMicroUsd: T5_CAP_MICRO_USD, actualMicroUsd: closed.spendMicroUsd, boxGone: true });

      // ── 8. REVERIFY, for real: the production script, cwd = the host clone
      //    (hostRoot default = process.cwd(), the repo AND where .factory
      //    lives), runsDir delivered by QDS_RUNS_DIR. The OPERATOR PLAN is
      //    authored here, exactly as an operator's checkout would carry it ──
      const factoryDir = join(hostRepo, ".factory");
      mkdirSync(factoryDir, { recursive: true, mode: 0o700 });
      chmodSync(factoryDir, 0o700);
      writeFileSync(
        join(factoryDir, "pipeline.json"),
        JSON.stringify({
          version: 1,
          repos: {
            "biospark33/QDS-Factory": {
              manifest: ".factory/t5-host-plan.json",
              noTestSuite: false,
            },
          },
        }),
      );
      // `kind:"code"` REQUIRES `command` (manifest.ts:87); testCommand is the
      // additive judge. The test phase's own command is NOT re-run by
      // reverify (runner.ts plan derivation) — it only has to schema-validate.
      writeFileSync(
        join(factoryDir, "t5-host-plan.json"),
        JSON.stringify({
          version: "1.0.0",
          pipelineId: "t5-host-plan",
          runBudgetMs: 300_000,
          phases: [
            {
              name: "t5-host-tests",
              kind: "code",
              description: "T5.1 operator-pinned judging suite: small, hermetic, no network.",
              command: ["true"],
              testCommand: ["bun", "test", "tests/fleet/approvers.test.ts"],
              maxDurationMs: 120_000,
              retries: 0,
            },
          ],
        }),
      );
      chmodSync(join(factoryDir, "pipeline.json"), 0o600);
      chmodSync(join(factoryDir, "t5-host-plan.json"), 0o600);

      const reverify = Bun.spawn({
        cmd: ["bun", join(REPO_ROOT, "scripts/reverify.ts"), runId],
        cwd: hostRepo,
        env: { ...process.env as Record<string, string>, QDS_RUNS_DIR: recordsDir },
        stdout: "pipe",
        stderr: "pipe",
      });
      const [rvStdout, rvStderr, rvExit] = await Promise.all([
        new Response(reverify.stdout).text(),
        new Response(reverify.stderr).text(),
        reverify.exited,
      ]);
      let report: { verdict?: string; reverifyId?: string; completedAt?: string; headSha?: string; reason?: string; checks?: Array<{ item: string; ok: boolean }> } | undefined;
      try {
        report = JSON.parse(rvStdout) as typeof report;
      } catch {
        // leave undefined — the assertions below render the raw streams
      }
      evidence.push({
        phase: "reverify",
        exitCode: rvExit,
        verdict: report?.verdict,
        reason: report?.reason,
        checksTail: report?.checks?.slice(-3),
        stdoutHead: rvStdout.trim().slice(0, 400),
        stderrTail: rvStderr.trim().slice(-800),
      });
      expect(rvExit).toBe(0); // green — 1 is red, 2 is host error, never confused
      expect(report?.verdict).toBe("green");
      expect(report?.headSha).toBe(headSha); // judged at the harvested tip
      // The gate REQUEST is reverify's LAST step, and it prints its outcome:
      const approvalLine = rvStderr.split("\n").find((l) => l.startsWith("approval: "));
      expect(approvalLine).toBeDefined();
      const approvalOutcome = JSON.parse((approvalLine as string).slice("approval: ".length)) as { outcome: string };
      expect(approvalOutcome.outcome).toBe("requested");

      // ── 9. the record is PAUSED at the gate, from the REAL chain ────────
      const paused = new RunRecordStore({ dir: recordsDir }).get(runId).extensions?.approval;
      evidence.push({ phase: "approval-extension", approval: paused });
      expect(paused?.state).toBe("awaiting-approval");
      expect(paused?.reportId).toBe(report?.reverifyId); // the gate bound the report reverify minted
      expect(paused?.headSha).toBe(headSha);

      const status = await runFleet(["status", runId, "--driver", "exedev", "--dir", recordsDir], { timeoutMs: 120_000 });
      expect(status.exitCode).toBe(0);
      const row = lastJson<{ runId?: string; state?: string; reportId?: string; expiresInMs?: number }>(status.stdout);
      evidence.push({ phase: "status", row });
      expect(row.runId).toBe(runId);
      expect(row.state).toBe("awaiting-approval"); // NOT boxMissing — the box really is gone (asserted above)
      expect(row.reportId).toBe(report?.reverifyId);
      expect(row.expiresInMs).toBeGreaterThan(0);

      // ── 10. the operator approves, token on fd 0, cwd = the workspace root
      //     holding .factory/approvers.json ─────────────────────────────────
      const allowlistDir = join(workspace, ".factory");
      mkdirSync(allowlistDir, { recursive: true, mode: 0o700 });
      chmodSync(allowlistDir, 0o700);
      const allowlistPath = join(allowlistDir, "approvers.json");
      writeFileSync(
        allowlistPath,
        JSON.stringify({
          version: 1,
          approvers: {
            [APPROVER_ID]: {
              v: 2,
              salt: APPROVER_SALT,
              hash: scryptToken(APPROVER_SALT, APPROVER_TOKEN),
              ...SCRYPT_PARAMS,
            },
          },
        }),
      );
      // writeFileSync's mode option is umask-masked; chmod after is the only
      // form that lands 0600, and the allowlist reader refuses anything wider.
      chmodSync(allowlistPath, 0o600);
      expect(statSync(allowlistPath).mode & 0o777).toBe(0o600);
      const tokenPath = join(workspace, "approver.token");
      writeFileSync(tokenPath, `${APPROVER_TOKEN}\n`);
      chmodSync(tokenPath, 0o600);

      const approve = await runFleetWithToken(
        ["approve", runId, "--approver", APPROVER_ID, "--reason", "t5.1 e2e chain approval", "--dir", recordsDir],
        tokenPath,
        { cwd: workspace, timeoutMs: 120_000 },
      );
      const approveEvent = gateLine(approve.stderr, "approve");
      evidence.push({ phase: "approve", exitCode: approve.exitCode, approveEvent, stderrTail: approve.stderr.trim().slice(-600) });
      expect(approve.exitCode).toBe(0);
      expect(approve.stdout + approve.stderr).not.toContain(APPROVER_TOKEN);
      // D1's join, across the dispatch/reverify/approve process boundary: the
      // approval decision carries the RUN's dispatch id.
      expect(approveEvent).toMatchObject({ event: "approve", runId, outcome: "decided", state: "approved", dispatchRequestId: recordRequestId });
      const decided = new RunRecordStore({ dir: recordsDir }).get(runId).extensions?.approval;
      evidence.push({ phase: "decided-record", approval: decided });
      expect(decided?.state).toBe("approved");
      expect(decided?.approverId).toBe(APPROVER_ID);
      expect(typeof decided?.decidedAt).toBe("string");
      // DF5.2 refuses `approval-precedes-report` when the decision predates
      // the report it authorizes (push.ts order check) — both host clocks.
      expect(Date.parse(String(decided?.decidedAt))).toBeGreaterThanOrEqual(Date.parse(String(report?.completedAt)));

      // ── 11. post-approval attach REFUSES: EVERY approval state is
      //     unattachable, `approved` included (attach.ts:360-368) ───────────
      const attachAfter = await runFleet(
        ["attach", runId, "--driver", "exedev", "--message", "too late", "--dir", recordsDir],
        { timeoutMs: 60_000 },
      );
      evidence.push({ phase: "attach-post-approval", exitCode: attachAfter.exitCode, stderrTail: attachAfter.stderr.trim().slice(-500) });
      expect(attachAfter.exitCode).toBe(5);
      expect(envelope(attachAfter.stderr, "run-not-attachable")).toMatchObject({ state: "approved" });

      // ── round hygiene: no box of ours survives (skill: final-ls, with the
      //    r7-T-h1 measured lag poll) ───────────────────────────────────────
      const maxAttempts = 5;
      let final: string[] = [];
      for (let i = 1; i <= maxAttempts; i++) {
        final = (await ctx.driver.list()).map((b) => b.name).filter((n) => n.startsWith("e2e-") || n.startsWith("qds-"));
        if (final.length === 0) break;
        if (i < maxAttempts) {
          evidence.push({ phase: "final-ls-retry", attempt: i, remaining: final });
          await new Promise((r) => setTimeout(r, 8000));
        }
      }
      evidence.push({ phase: "final-ls", fleetBoxes: final, probe });
      expect(final).toEqual([]);
    } catch (e) {
      outcome = "fail";
      evidence.push({ phase: "test-error", error: (e as Error).message });
      throw e;
    } finally {
      // F12 lesson (T2.1): a gate-refused dispatch PROVISIONED but emitted a
      // refusal payload, not an ack — recover ids from BOTH streams so the
      // cleanup below can never skip the box that is quietly billing.
      if (runId === "" || vmName === "") {
        const combined = `${dispatchOut}\n${dispatchErr}`;
        if (runId === "") runId = /qds-[0-9]{8}-[a-z0-9]{6}/.exec(combined)?.[0] ?? "";
        if (vmName === "") vmName = /ssh ((?:qds|e2e)-[0-9]{8}-[a-z0-9]{6})\.exe\.xyz/.exec(combined)?.[1] ?? /(?:teardown|rm) ((?:qds|e2e)-[0-9]{8}-[a-z0-9]{6})/.exec(combined)?.[1] ?? "";
        evidence.push({ phase: "finally-id-recovery", runId, vmName });
      }
      if (vmName !== "") await destroyQuietly(ctx.driver, vmName, evidence);
      if (!teardownSucceeded && runId !== "") {
        // Best-effort revoke so a mid-chain failure never leaves a billable
        // key; a teardown that already succeeded owns the revoke+verify.
        try {
          await revokeQuietly(ctx.driver, new RunRecordStore({ dir: join(workspace, "runs") }), runId, evidence);
        } catch (re) {
          evidence.push({ phase: "finally-revoke-error", error: (re as Error).message });
        }
      }
      // The comparison the skill requires: no key hash we caused may outlive
      // us. The "could not look" arm is a verdict that was never rendered.
      try {
        const after = await listedKeyHashes();
        leaked = [...after].filter((h) => !hashesBefore.has(h));
        evidence.push({ phase: "key-hash-delta", leaked });
      } catch (de) {
        deltaError = (de as Error).message;
        evidence.push({ phase: "key-hash-delta", ok: false, error: deltaError });
      }
      try {
        evidencePath = writeEvidence("t5-1-gate-steering", { test: "T5.1", outcome, runId, capMicroUsd: T5_CAP_MICRO_USD, phases: evidence });
        process.stderr.write(`[T5.1] evidence: ${evidencePath}\n`);
      } finally {
        if (workspace !== "") rmSync(workspace, { recursive: true, force: true });
      }
    }

    // Outside the finally (biome/noUnsafeFinally), reached only when the body
    // passed — a failing run already fails, and its evidence carries the leak.
    expect(deltaError).toBeUndefined();
    expect(leaked).toEqual([]);
  },
  3_600_000,
);
