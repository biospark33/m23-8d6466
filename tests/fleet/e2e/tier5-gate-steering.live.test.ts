/**
 * T5.1 — the DF3.4 chain, END TO END on real infrastructure, with real model
 * spend: dispatch (real setup gate, C/D on the roster models) → real in-box
 * engine work (pi on the run key) → `fleet attach` mid-run, ACKED by the
 * in-box engine (DF1.11's closed steering round trip, live) → harvest →
 * real DF2.5 teardown → REAL reverify (DF5.1: quarantine
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
 * THE ACKED ROUND TRIP (DF1.11's inverted PASS shape): the attach leg below
 * lands its line in the box, this test PROVES the line queued before any
 * engine exists, and only then starts `fleet run` — so the engine's steering
 * consumer (`localSteeringInbox`, local `node:fs` on the box, armed with the
 * dispatched run's resident) drains the queue at its FIRST solicitation
 * (run_start), folds the guidance into promptContext and appends
 * {messageId, ackedAt, point} to the box's own /run/steering/acks.ndjson.
 * The verb observes that ack inside the REAL 30 s ceiling and exits 0 /
 * `attach-acked`; the on-box proof (inbox line verbatim, ack row) is read
 * back through `driver.exec`. The ordering is deterministic by construction —
 * an engine cannot drain a queue that predates it — not a race won by luck
 * (the tier1 sibling carries the full argument for the same keystone).
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
 * (setup-gate C/D chat pings + the pi engine step + the engine run's
 * run_start/run_end solicitations — the acked steering loop's own model
 * calls; one measured in-box pi solicitation: $0.000025 / 2.17 s), 1 box
 * ≤ 1 h at 230 000 µ$/h. Worst case ≈ $0.28.
 *
 * NO FAKES anywhere in this file: real ssh, real OpenRouter key API, real
 * SQLite, real `bun scripts/fleet.ts` / `bun scripts/reverify.ts`
 * subprocesses. Verbatim failures in evidence; `finally` destroys the box,
 * revokes the key, and writes evidence PASS or FAIL.
 */
import { expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync, chmodSync, statSync } from "node:fs";
import { join } from "node:path";

import type { ExecResult } from "../../../src/providers/driver.ts";
import type { LiveCtx, SpawnedFleet } from "./live-harness.ts";
import { RunRecordStore } from "../../../src/providers/run-record.ts";
import { scryptToken, SCRYPT_PARAMS } from "../../../src/fleet/approvers.ts";
import {
  REPO_ROOT,
  awaitBoxAbsent,
  awaitWithCeiling,
  boxExec,
  destroyQuietly,
  fetchBoxFile,
  fleetCleanupProblems,
  fleetLeftovers,
  emittedRunId,
  fleetPartialOutput,
  keyLeakProblems,
  listedKeyHashes,
  liveGate,
  liveTodoOff,
  preflight,
  recoverDispatchIds,
  revokeQuietly,
  runFleet,
  runFleetWithToken,
  runIdFor,
  scratchClone,
  settleRun,
  spawnFleet,
  tmpWorkspace,
  waitForSettledVerdict,
  writeEvidenceQuietly,
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
const BOX_INBOX = "/run/steering/inbox.ndjson"; // live-mirror: inboxPath() (attach.ts) — steering channel layout
const BOX_ACKS = "/run/steering/acks.ndjson"; // live-mirror: acksPath() (attach.ts) — steering channel layout
/**
 * How many times the pre-engine inbox confirmation re-reads the inbox
 * (tier2-attach-transport's named idiom, same numbers): the loop runs INSIDE
 * the attach verb's fixed 30 s ack window — it opens at the verb's own
 * append (attach.ts:524-525, ATTACH_ACK_CEILING_MS) — so it is priced
 * against THIRTY SECONDS, not the exec ceiling (F3): 4 × (500 ms + one ssh
 * RTT) leaves the bulk of the window for the engine's run_start drain→ack.
 * The append is the first thing the verb does, so attempt 1 usually
 * confirms; and the loop stays bounded because a poll that never gives up is
 * a paid box that never gets torn down.
 */
const INBOX_CONFIRM_ATTEMPTS = 4;
/** 500 ms (F3): burns as little of the attach verb's already-running 30 s
 * ack window as possible — attempt 1 usually confirms. */
const INBOX_CONFIRM_WAIT_MS = 500;
/** The message T5.1 steers with — asserted verbatim off the box. */
const STEER_MESSAGE = "t5.1: prefer the smallest fix that turns the seed test green";
/** Ceiling for the reverify subprocess. Unbounded before r7-T-E: an `await
 * proc.exited` with no clock sat inside a test whose leg-timeout sum already
 * left <200 s of the runner budget, and a bun timeout abort is exactly the path
 * where the `finally` box-destroy and key-revoke are not guaranteed. runBudgetMs
 * 300_000 + routing margins bound reverify's own work; 420_000 gives the
 * worktree setup and the gate request the rest. */
const REVERIFY_TIMEOUT_MS = 420_000;
/** Ceiling for the seed/prompt/verify/commit box legs (DEFAULT_EXEC_TIMEOUT_MS
 * was the only bound before — these are instant shell commands over ssh, and
 * the ceiling must be a CHOICE this file owns so the budget math below sees
 * it). 120 s is ~25× the measured per-leg reality; the earlier 180 s bought
 * nothing but budget the serial worst case could not afford (EB6). */
const BOX_LEG_TIMEOUT_MS = 120_000;
/**
 * P38: ceilings on the AWAITED collects of the two spawnFleet verbs — the one
 * leg family that carried no clock. A wedged child (or a pipe held open by a
 * grandchild) used to hang the await until the bun test timeout, which is the
 * ONE path where the `finally` box-destroy and key-revoke do not run. The
 * ceiling rejects INTO the catch (which kills the procs) → finally → teardown.
 * Attach self-bounds at its 30 s ack ceiling; 120 s is the audit's price for
 * the leg. The run verb's own bound is its per-CALL deadline
 * RUN_START_TIMEOUT_MS 125 s (run.ts) — runBudgetMs bounds the ENGINE's
 * walk, not the verb, which returns at the fork over ssh/systemctl legs —
 * and 180 s is the audit's price for the leg (F2: clears the 125 s call
 * bound; run.ts's pathological ~2× verb worst case fires the ceiling into
 * the catch, the safe direction).
 */
const ATTACH_COLLECT_CEILING_MS = 120_000;
const RUN_COLLECT_CEILING_MS = 180_000;
/**
 * EB6 budget audit — every leg's ceiling against the runner budget. The
 * r7-T-E ceilings summed to ≈4.87M serial worst case, i.e. ABOVE the bun
 * timeout: a round that stayed healthy leg-by-leg but slow everywhere would
 * have been killed by the runner mid-`finally`, which is the one path where
 * the box destroy and key revoke are not guaranteed. The ceilings are
 * rebalanced DOWN so the serial sum fits WITH margin, keeping every leg's
 * clock (no leg is unbounded, and the no-finally abort path stays closed):
 *   dispatch 540_000 + pi 420_000×2 + 30s stall-wait + attach 120_000
 *   + seed/prompt/verify/commit 4×120_000 + step-5 box reads 2×120_000
 *   + scratchClone 180_000 + harvest 240_000 + teardown 300_000
 *   + reverify 420_000 + status 120_000 + approve 120_000 + attachAfter 60_000
 *   + positive-control ls 120_000 + round-hygiene fleetLeftovers 880_000
 *   + legacy absence-poll term 40_000
 *   + box-absence poll 4 × (control ls 120_000 + 10 s wait) = 510_000 (L3 —
 *     the post-teardown `not.toContain(vmName)` was ONE listing taken inside
 *     the MEASURED 25 s+ substrate destroy lag, and step 8's reverify depends
 *     on that box really being gone)                        ≈ 5.24M
 *   — the finally is priced on top, below.
 * NOTE (round 3, E3-5 — the under-count below is now PAID, not recorded): the
 * `finally`'s `fleetLeftovers` is priced by its own declared ceilings — 5 ×
 * (control ls 120 s + 8 s wait) plus a destroy pass plus the confirming
 * re-list ≈ 880_000 — and the finally ALSO carries revokeQuietly ≈120_000,
 * destroyQuietly ≈120_000, keyLeakProblems (delta list + fallback revoke +
 * recheck) ≈360_000 and the evidence write ≈10_000, ≈1.49M against the
 * "230k of margin" this table used to claim. The runner ceiling below is the
 * honest sum with margin; the fail-safe direction is UP and a healthy round
 * never sees any of it.
 * NOTE (round 4): the BODY half was under-priced the same way. Added at their
 * declared ceilings: scratchClone 180_000, the positive-control `driver.list`
 * 120_000, the two step-5 in-box reads (BOX_INBOX fetch + acks probe)
 * 2×120_000 — and the round-hygiene `fleetLeftovers` at its DECLARED ceiling
 * 880_000 rather than the "final-ls ≈50_000" happy-path figure: a FAILED
 * listing never breaks its poll loop (`listed !== undefined` is the break
 * condition), so the worst case runs all 5 attempts. Body ≈5.24M + finally
 * ≈1.49M ≈ 6.73M; the ceiling below carries the margin.
 * NOTE (DF1.11 leaf-4d): the attach leg is now the ACKED round trip and
 * carries three new priced legs at their declared ceilings — the pre-engine
 * inbox confirmation (≤4 × driver.exec at 120 s = 480 s; F3 shrank the loop
 * to 4 × 500 ms, priced inside the verb's 30 s ack window), the `fleet run`
 * verb (180 s) and the engine-settle poll (the shared waitForSettledVerdict
 * default, 12 × (60 s status verb + 10 s wait) = 840 s); the attach verb
 * itself stays ≈120 s (self-bounded spawnFleet: the 30 s ack ceiling + exec
 * overhead — now ENFORCED by the P38 collect ceiling, same figure).
 * +1 500 s over the round-4 body figure: body ≈6.74M + finally ≈1.49M
 * ≈ 8.23M, so the ceiling below rises with it.
 * The cuts are against measured reality, not arbitrary: the pass shape
 * (2026-08-30 evidence) runs ~14 minutes total, so dispatch (box provision +
 * two roster-model pings), the four shell legs, one attach poll and harvest
 * each land minutes under their new ceilings. The engine legs keep the largest
 * share: the in-box `timeout 360` bounds pi itself, and the 420_000 exec
 * ceiling carries the ssh/drained-pipe overhead above it. The one genuinely
 * additive retry (pi attempt 2, stall shape only) is real spend the round
 * opted into, not slack.
 */

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

/**
 * The seeded JUDGE, printf-escaped, written ONCE and hashed twice — the single
 * source of truth for both the seed exec and the tamper guard below.
 *
 * Why a digest and not `git status`: NEITHER seed file is ever `git add`ed (the
 * commit-fix leg stages `t5_seed_calc.py` alone, and only AFTER the guard), so
 * both land untracked and `git status --porcelain` reports `?? t5_seed_test.py`
 * on every run, fix or no fix. Porcelain therefore cannot distinguish a judge
 * the fixer rewrote from the judge we seeded — it reports the same `??` either
 * way. The digest can, and is what actually closes the false-green hole the
 * round-4 hardening was written for.
 */
const JUDGE_PRINTF =
  'from t5_seed_calc import add\\n\\n\\ndef main() -> int:\\n    ok = add(2, 3) == 5 and add(-1, 1) == 0\\n    print("seed-test-passed" if ok else "seed-test-failed")\\n    return 0 if ok else 1\\n\\n\\nif __name__ == "__main__":\\n    raise SystemExit(main())\\n';
/** The bytes `printf` actually writes: `\n` is the only escape this body carries. */
const JUDGE_SHA256 = new Bun.CryptoHasher("sha256")
  .update(JUDGE_PRINTF.replaceAll("\\n", "\n"))
  .digest("hex");

/** The last JSON line of a verb's stdout — the verb's OUTPUT, not its prose. */
const lastJson = <T>(stdout: string): T =>
  JSON.parse(stdout.trim().split("\n").filter(Boolean).at(-1) ?? "{}") as T;

/** The stderr envelope a refusing verb printed, by `code`. */
function envelope(stderr: string, code: string): Record<string, unknown> | undefined {
  return stderr
    .split("\n")
    .filter((l) => l.startsWith("{"))
    .flatMap((l) => {
      try {
        return [JSON.parse(l) as Record<string, unknown>];
      } catch {
        // An interleaved or truncated `{`-prefixed line is noise; a parse throw
        // at the wrong site would replace the refusal assertion being checked.
        return [];
      }
    })
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
  "T5.1 gate+steering e2e: dispatch → engine → attach(acked by the in-box engine) → harvest → teardown → reverify(green) → awaiting-approval → approve over stdin",
  async () => {
    liveGate("2");
    const evidence: Record<string, unknown>[] = [];
    // A run-id that is NEVER provisioned, and deliberately unused in any
    // assertion: r7-T-E replaced this dead variable with the POSITIVE control
    // the final-ls assertion actually needed (see the dispatch leg below) —
    // the probe id is kept only as a grammar-valid witness name in evidence.
    const probe = runIdFor("t51probe");
    /**
     * P28 (F4): `preflight` itself can throw — a transient ssh whoami
     * failure, a half-configured driver env — and it sat OUTSIDE the try, so
     * that abort wrote NO evidence file and rendered no verdict. It runs
     * inside the try now; `undefined` means nothing was provisioned, and
     * every finally leg that touches `ctx.driver` guards on it and skips.
     */
    let ctx: LiveCtx | undefined;
    let workspace = "";
    let runId = "";
    let vmName = "";
    let dispatchOut = "";
    let dispatchErr = "";
    let outcome = "pass";
    /** The body's own error, held so the post-finally verdicts below run on the failing path too. */
    let failure: unknown;
    let recordRequestId = "";
    let recordSlugCaptured = "";
    /**
     * Key hashes present before the run; the delta is a cleanup problem
     * below. `let … | undefined` and snapshotted INSIDE the try (P28, F4 —
     * tier2's degradation idiom): a rejection here used to abort the test
     * before the try/finally — no evidence file, no verdict — so a failed
     * baseline now lands in the catch/finally like any other body failure,
     * with the finally degrading the delta to a named UNVERIFIED problem.
     */
    let hashesBefore: Set<string> | undefined;
    /** Destroys that FAILED (#189) — folded into the ONE verdict below, never only recorded. */
    const destroyFailures: string[] = [];
    /** P38: spawnFleet verbs still in flight if the body throws — the catch
     * kills them (`kill()` is a no-op on an exited process), so a wedged verb
     * cannot hold the round open past its own ceiling. */
    const liveSpawned: SpawnedFleet[] = [];
    /** The final leak listing, hoisted: `undefined` means the listing itself failed. */
    let finalBoxes: string[] | undefined;
    /** The F17 key-population verdict, rendered in the finally. */
    let keyProblems: string[] = [];
    try {
      ctx = await preflight("2");
      hashesBefore = await listedKeyHashes();
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
          repoSlug: "Quantum-Digital-Solutions/QDS-Factory",
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
        // 540_000 (EB6): provision + the A–E gate assertions, C/D being two
        // roster-model pings — minutes under the ceiling it replaces.
        { cwd: REPO_ROOT, timeoutMs: 540_000 },
      ).catch((e: unknown) => {
        // The L1 fix PORTED from tier2/tier3 (round 3, E3-1): on the timeout
        // path the two assignments below never ran, the `finally`'s
        // `recoverDispatchIds("", "")` recovered nothing, and every guarded
        // cleanup leg skipped — a real box left billing as "another round's
        // stray". The partial streams carry the minted id.
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
      // POSITIVE CONTROL for the final-ls assertion (:final-ls) — T1.7's shape
      // (:190). Without it "no e2e-/qds- box survives" is true for free on a
      // driver whose `list()` cannot see our boxes (a name-grammar or filter
      // regression): the leak assertion must first prove it CAN see one. The
      // box dispatch just created is the real, billable subject.
      expect((await ctx.driver.list()).some((b) => b.name === vmName)).toBeTrue();

      // ── 2. the record carries the money + correlation identity. requestId
      //    is the JOIN KEY for everything downstream: the attach line echoes
      //    it, and the approve gate event carries it as `dispatchRequestId` ──
      const store = new RunRecordStore({ dir: recordsDir });
      const rec = store.get(runId);
      expect(rec.vmName).toBe(vmName);
      expect(rec.commitSha).toBe(ctx.sha);
      expect(rec.keyHash ?? "").not.toBe("");
      expect(rec.limitMicroUsd).toBe(T5_CAP_MICRO_USD);
      // The JOIN KEY for every downstream assertion (attach echo :313, approve
      // event :423) — `""` would make those `x === ""` comparisons pass while
      // joining on nothing, so it is refused here like the slug below.
      expect(typeof rec.requestId).toBe("string");
      expect(rec.requestId ?? "").not.toBe("");
      recordRequestId = rec.requestId as string;
      // The slug the RECORD carries — dispatch canonicalizes case
      // (`canonicalRepoSlug`, issue-correlation.ts: trim + lowercase), so the
      // brief's `Quantum-Digital-Solutions/QDS-Factory` persists as
      // `quantum-digital-solutions/qds-factory` (re-measured off the
      // 2026-09-03 evidence after the org rename rewrote the INPUT half of this
      // pair and left the output half naming the old `biospark33` account).
      // `resolveHostPlan` matches the operator index EXACTLY by this value, so
      // the host plan is keyed by what the RECORD says, never by what the brief
      // said — which is why `recordSlugCaptured`, not the literal, keys the
      // `.factory/pipeline.json` written below. The mixed-case
      // `perIssueOverrides` keys elsewhere in this suite are unaffected:
      // `capForIssue` canonicalises BOTH the lookup and the config key
      // (cost-ledger.ts `canonicalOverrideKey`), so the match is case-blind.
      const recordSlug = rec.extensions?.budget?.repoSlug;
      expect(typeof recordSlug).toBe("string");
      expect(recordSlug ?? "").not.toBe("");
      recordSlugCaptured = recordSlug as string;
      evidence.push({ phase: "record", ok: true, keyHash: rec.keyHash, limitMicroUsd: rec.limitMicroUsd, requestId: recordRequestId, recordSlug });

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
      const seed = await ctx.driver.execTimed(vmName, [
        "sh", "-c",
        `cd "$HOME/src" && printf 'def add(a, b):\\n    return a - b\\n' > t5_seed_calc.py && printf '${JUDGE_PRINTF}' > t5_seed_test.py && python3 t5_seed_test.py; echo "SEED_EXIT=$?"`, // live-mirror: $HOME/src = DEFAULT_FILL_WORKDIR delivery root (fill.ts)
      ], BOX_LEG_TIMEOUT_MS);
      const seedExit = /SEED_EXIT=(\d+)/.exec(seed.stdout)?.[1];
      expect(seedExit).toBe("1"); // the seed FAILS before the fix — the loop has something to fix
      evidence.push({ phase: "seed", ok: true, seedExit });

      const writePrompt = await ctx.driver.execTimed(vmName, [
        "sh", "-c",
        `cat > /tmp/t5-prompt.txt <<'QDSEOF'\n${FIXER_PROMPT}\nQDSEOF`,
      ], BOX_LEG_TIMEOUT_MS);
      expect(writePrompt.exitCode).toBe(0);

      // `timeout 360` bounds the model call in-box (EB6: was 480, a ceiling the
      // serial budget could not afford); the exec ceiling below carries 60 s of
      // ssh connect + drained-pipe overhead above that bound.
      const piCmd = `set -a; . "$HOME/app/.env"; set +a; cd "$HOME/src" || exit 9; timeout 360 pi --provider openrouter --model ${FIXER_MODEL} --mode json --no-session -p "$(cat /tmp/t5-prompt.txt)" >/tmp/t5-pi-out.txt 2>/tmp/t5-pi-err.txt; echo "PI_EXIT=$?"; tail -c 600 /tmp/t5-pi-out.txt; tail -c 300 /tmp/t5-pi-err.txt >&2`; // live-mirror: $HOME/app/.env = unit EnvironmentFile + KEY_ENV_FILE (credentials.ts)
      // `const` snapshot for the retry closure below: narrowing on a `let`
      // (ctx, P28) does not cross a function boundary.
      const piDriver = ctx.driver;
      const runPi = (): Promise<ExecResult> => piDriver.execTimed(vmName, ["sh", "-c", piCmd], 420_000);
      let engine = await runPi();
      let attempt = 1;
      // ONE bounded retry, for the STALL SHAPE ONLY (T2.1's fresh-box warmup):
      // pi produced no exit marker at all, i.e. the `timeout 480` killed a hung
      // call. A deterministic failure (prompt/parse/exit != 0 WITH a marker)
      // will fail the same way twice, so a second full pi call is pure double
      // spend on the run key — fail loud on the first attempt's evidence.
      const stalled = (r: ExecResult): boolean => !/PI_EXIT=\d+/.test(r.stdout);
      if (stalled(engine)) {
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

      const verify = await ctx.driver.execTimed(vmName, ["sh", "-c", 'cd "$HOME/src" && python3 t5_seed_test.py; echo "FIX_TEST_EXIT=$?"; python3 -c "import hashlib; print(\'JUDGE_SHA256=\' + hashlib.sha256(open(\'t5_seed_test.py\', \'rb\').read()).hexdigest())"; git status --porcelain'], BOX_LEG_TIMEOUT_MS); // live-mirror: $HOME/src = DEFAULT_FILL_WORKDIR delivery root (fill.ts)
      evidence.push({ phase: "engine-verify", stdout: verify.stdout.trim().slice(0, 500) });
      expect(/FIX_TEST_EXIT=0/.test(verify.stdout)).toBe(true); // the seeded test now PASSES
      // TAMPER GUARD, half 1 — the JUDGE IS UNCHANGED, byte for byte. This is
      // the assertion that closes the false-green hole: a model that rewrote
      // its own judge (`t5_seed_test.py` → `exit 0` unconditionally) passes the
      // FIX_TEST_EXIT check above and rides the whole downstream chain green.
      // Digest, not porcelain, because the seed files are untracked (see
      // JUDGE_PRINTF) and git reports a rewritten judge and a seeded one
      // identically — `?? t5_seed_test.py` in both cases.
      expect(verify.stdout).toContain(`JUDGE_SHA256=${JUDGE_SHA256}`);
      // TAMPER GUARD, half 2 — NOTHING ELSE moved: the fixer was told to touch
      // one file, and the exact set catches any extra file it created or
      // modified. Both seeds are untracked and `__pycache__/` is python
      // bytecode from running the judge, so all three are the measured pass
      // shape — stated as a set, never a single-file equality.
      // Filtered on the porcelain XY SHAPE, not an allow-list of prefixes. The
      // five-prefix list this replaces (`??`, ` M`, `M `, `A `, `D `) DROPPED
      // `MM`, `AM`, `AD`, `RM`, `R `, `" D"` and `UU` — so a fixer that staged
      // and then modified a second file, deleted a tracked file, or renamed one
      // produced lines the filter never saw, and "NOTHING ELSE moved" passed on
      // a set that was silently short. `[ MADRCU?!]{2} ` is git's whole
      // two-column status alphabet; it cannot match this exec's other stdout
      // lines (`FIX_TEST_EXIT=…`, `JUDGE_SHA256=…`, `seed-test-passed`), and
      // `slice(3)` is the path in every one of those shapes — a rename's
      // `old -> new` body lands verbatim in the set and fails, which is right.
      const porcelain = verify.stdout.split("\n").filter((l) => /^[ MADRCU?!][ MADRCU?!] /.test(l) && !l.startsWith("!!"));
      // `result.json` is pi's OWN json-mode artifact and is OPTIONAL in
      // practice: three consecutive live rounds were red on exactly
      // `+ "result.json"` AFTER the spend (evidence 2026-08-30-171852,
      // 2026-09-03-193705, 2026-09-05-171427), so it was added to the set —
      // and the 2026-09-06 re-pin round then failed the OTHER way
      // (`- "result.json"`: this substrate's pi wrote no result.json at all).
      // Its presence is pi-version-dependent, not a property under test, so
      // the assertion is now CORE-SET ⊆ actual ⊆ CORE-SET ∪ {result.json}:
      // the three deterministic entries must all be there, result.json may
      // be there, and NOTHING else — a file the FIXER added still fails.
      const porcelainSet = porcelain.map((l) => l.slice(3).trim()).sort();
      const core = ["__pycache__/", "t5_seed_calc.py", "t5_seed_test.py"];
      const optional = ["result.json"];
      for (const entry of core) {
        expect(porcelainSet, `core entry ${entry} missing from the porcelain set`).toContain(entry);
      }
      expect(
        porcelainSet.filter((f) => !core.includes(f) && !optional.includes(f)),
        "files outside the core+optional set moved — this is the NOTHING-ELSE-moved guard",
      ).toEqual([]);

      // Commit the VERIFIED fix on the box: harvest counts commits on
      // sbx/<runId>, and reverify's zero-commits arm (`nothing-to-verify`)
      // would return BEFORE the gate without this (runner.ts:282-292).
      const commitFix = await ctx.driver.execTimed(vmName, [
        "sh", "-c",
        'cd "$HOME/src" && git add t5_seed_calc.py && git -c user.name=t5-e2e -c user.email=t5-e2e@local commit -q -m "t5: fixer\'s verified fix — add returns a + b" && git rev-parse --short HEAD', // live-mirror: $HOME/src = DEFAULT_FILL_WORKDIR delivery root (fill.ts)
      ], BOX_LEG_TIMEOUT_MS);
      evidence.push({ phase: "commit-fix", exitCode: commitFix.exitCode, sha: commitFix.stdout.trim() });
      expect(commitFix.exitCode).toBe(0);

      // ── 5. ATTACH + the ACKED ROUND TRIP (DF1.11's inverted PASS shape):
      //    record open, box alive, the REAL 30 s ceiling. The verb is fired
      //    FIRST (spawnFleet, in flight), the test then PROVES its line is
      //    queued in the box inbox, and only then starts the engine — so the
      //    engine's FIRST solicitation (run_start) provably drains the
      //    guidance, folds it and acks the messageId in the box's own
      //    acks.ndjson, and the still-polling verb observes the ack and
      //    exits 0 / attach-acked ───────────────────────────────────────────
      const attachProc = spawnFleet(["attach", runId, "--driver", "exedev", "--message", STEER_MESSAGE, "--dir", recordsDir]);
      liveSpawned.push(attachProc);
      // The keystone (tier1's argument, same shape): positive evidence the
      // line is IN THE BOX before any engine exists — `2>/dev/null || true`
      // because the append may not have landed on the first tick (a missing
      // file is a retry, never a refusal), bounded at 4 × 500 ms (F3: the
      // loop runs inside the verb's already-open 30 s ack window) because a
      // poll that never gives up is a paid box that never gets torn down.
      let attachLineConfirmed = false;
      for (let attempt = 1; attempt <= INBOX_CONFIRM_ATTEMPTS && !attachLineConfirmed; attempt += 1) {
        const read = await boxExec(ctx.driver, vmName, ["sh", "-c", `cat ${JSON.stringify(BOX_INBOX)} 2>/dev/null || true`]);
        attachLineConfirmed = read.stdout
          .split("\n")
          .filter((l) => l.trim().length > 0)
          .some((l) => {
            try {
              return (JSON.parse(l) as { message?: string }).message === STEER_MESSAGE; // dp:ok wrapped in the try directly above — torn lines return false, never throw
            } catch {
              return false; // a torn line is a retry, never a verdict
            }
          });
        if (!attachLineConfirmed && attempt < INBOX_CONFIRM_ATTEMPTS) await new Promise((r) => setTimeout(r, INBOX_CONFIRM_WAIT_MS));
      }
      evidence.push({ phase: "attach-inbox-confirmed", confirmed: attachLineConfirmed });
      expect(attachLineConfirmed).toBe(true);
      // NOW the engine: `fleet run` returns at the fork (T2.2's step-4
      // shape). Its run_start solicitation drains the proven line; the
      // attach verb — still inside its own 30 s ceiling — observes the ack.
      const runProc = spawnFleet(["run", runId, "--driver", "exedev", "--dir", recordsDir], { cwd: REPO_ROOT });
      liveSpawned.push(runProc);
      // TIER1'S AWAIT/ASSERT SHAPE (P37): await EVERY spawned verb first —
      // collecting output on every path — then assert the RUN verb's exit
      // BEFORE the attach asserts. The old order asserted attach first, so a
      // `fleet run` failure (unit dead, image mismatch, systemctl error)
      // surfaced as "attach no-ack" after the attach verb burned its whole
      // 30 s ceiling — and the run verb's stderr, the actual cause, existed
      // nowhere in the evidence file. Concurrency is unchanged: both verbs
      // were spawned above and run concurrently; only the await/assert
      // ORDER moves. The collects sit under P38 ceilings so a wedged verb
      // rejects into the catch (which kills it), never into the bun timeout
      // — the one path where the `finally` teardown does not run.
      const readOut = async (p: SpawnedFleet, ms: number, label: string): Promise<{ exitCode: number | null; stdout: string; stderr: string }> => {
        const [exitCode, output] = await awaitWithCeiling(Promise.all([p.exited, p.output]), ms, label);
        return { exitCode, stdout: output.stdout, stderr: output.stderr };
      };
      const attach = await readOut(attachProc, ATTACH_COLLECT_CEILING_MS, `t5.1 attach collect (${runId})`);
      const runStarted = await readOut(runProc, RUN_COLLECT_CEILING_MS, `t5.1 run collect (${runId})`);
      evidence.push({
        phase: "attach-midrun",
        exitCode: attach.exitCode,
        stdout: attach.stdout.trim().slice(0, 400),
        stderrTail: attach.stderr.trim().slice(-800),
      });
      evidence.push({ phase: "run-verb", exitCode: runStarted.exitCode, stdout: runStarted.stdout.trim().slice(0, 200), stderrTail: runStarted.stderr.trim().slice(-400) });
      // RUN verb FIRST — its failure is the cause; the attach assertions
      // below are downstream symptoms of exactly that failure.
      expect(runStarted.exitCode).toBe(0);
      expect(runStarted.stdout).toContain(`started: ${runId}`);
      expect(attach.exitCode).toBe(0);
      const ackAttach = lastJson<{ runId: string; outcome: string; messageId: string; dispatchRequestId?: string }>(attach.stdout);
      expect(ackAttach.outcome).toBe("attach-acked");
      expect(ackAttach.runId).toBe(runId);
      expect(ackAttach.dispatchRequestId).toBe(recordRequestId);
      // NO reason on the acked arm's gate event, and NO refusal envelope —
      // the old no-ack shape's assertions are deleted, and their absence is
      // asserted, not assumed.
      const attachEventLine = gateLine(attach.stderr, "attach");
      expect(attachEventLine).toMatchObject({ operation: "fleet.attach", event: "attach", runId, outcome: "attach-acked", state: "attached", dispatchRequestId: recordRequestId });
      expect(Number(attachEventLine?.attach_rtt_ms)).toBeGreaterThan(0);
      expect(attachEventLine?.reason).toBeUndefined();
      expect(envelope(attach.stderr, "attach-not-acked")).toBeUndefined();
      const inboxLine = JSON.parse((await fetchBoxFile(ctx.driver, vmName, BOX_INBOX)).split("\n").filter((l) => l.trim().length > 0).at(-1) as string) as {
        messageId: string;
        requestId?: string;
        runId: string;
        message: string;
      };
      expect(inboxLine.messageId).toBe(ackAttach.messageId);
      expect(inboxLine.requestId).toBe(recordRequestId);
      expect(inboxLine.message).toBe(STEER_MESSAGE);
      // THE ACK FILE — the assertion the old decider probe deferred to this
      // story: the ENGINE's own writer on the box acked the messageId, at
      // the fold-time point. By construction the fold happened at run_start
      // (the engine started after the line was proven queued); the closed
      // point set is asserted rather than the single literal because a
      // degraded-then-retried ack legitimately lands at a later point.
      const ackRows = (await fetchBoxFile(ctx.driver, vmName, BOX_ACKS))
        .split("\n")
        .filter((l) => l.trim().length > 0)
        .map((l) => JSON.parse(l) as { messageId: string; ackedAt: string; point: string }); // dp:ok a torn acks line must fail this test LOUDLY — that throw is the assertion
      evidence.push({ phase: "attach-ack-proof", messageId: ackAttach.messageId, ackRows });
      const ackRow = ackRows.find((r) => r.messageId === ackAttach.messageId);
      expect(ackRow).toBeDefined();
      expect(typeof ackRow?.ackedAt).toBe("string");
      expect(ackRow?.point ?? "").toMatch(/^(run_start|post_gate_failure|run_end)$/); // dp:ok the ?? "" IS the validation — the toMatch demands a member of the closed set
      // The engine walk's health under the fold: the run settles `ok` BEFORE
      // harvest reads the box — the settle is the independent second fact (an
      // ack proves consumption, never application) and keeps harvest from
      // racing a live engine's writes.
      const settledRunState = await waitForSettledVerdict({ recordsDir, evidence }, runId);
      evidence.push({ phase: "engine-settled", state: settledRunState });
      expect(settledRunState).toBe("ok"); // live-mirror: InBoxState settled verdict (status.ts inBoxState, "ok" : "not-ok")

      // ── 6. HARVEST: bundle out, verified against a host clone that owns
      //    the pinned base SHA ──────────────────────────────────────────────
      const hostRepo = await scratchClone(ctx.repoUrl, ctx.sha, workspace);
      const harvest = await runFleet(["harvest", runId, "--driver", "exedev", "--dir", recordsDir], {
        cwd: hostRepo,
        // 240_000 (EB6): one bundle fetch + refs write over ssh.
        timeoutMs: 240_000,
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
      evidence.push({ phase: "teardown-verb", exitCode: teardown.exitCode, stdout: teardown.stdout.trim().slice(0, 300), stderrTail: teardown.stderr.trim().slice(-400) });
      expect(teardown.exitCode).toBe(0);
      const closed = new RunRecordStore({ dir: recordsDir }).get(runId);
      expect(closed.closedAt ?? "").not.toBe("");
      expect(closed.spendMicroUsd ?? 0).toBeGreaterThan(0);
      expect(closed.spendMicroUsd ?? 1).toBeLessThanOrEqual(T5_CAP_MICRO_USD);
      expect(await listedKeyHashes()).not.toContain(closed.keyHash); // revoked + verified
      // POLLED (L3): the substrate's destroy lag is MEASURED at 25 s+, so a
      // single listing right after `teardown` returned turned a clean cleanup
      // into a failed paid round. `awaitBoxAbsent` only looks — unlike
      // `fleetLeftovers` it does not destroy a survivor first, so it cannot
      // report clean for a teardown that destroyed nothing. The step-8 reverify
      // below DEPENDS on the box being gone, so this must be right rather than
      // early.
      const goneTd = await awaitBoxAbsent(ctx.driver, vmName, evidence, { maxAttempts: 4, retryDelayMs: 10_000 });
      expect(goneTd.absent).toBeTrue();
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
            [recordSlugCaptured]: {
              manifest: ".factory/t5-host-plan.json",
              noTestSuite: false,
            },
          },
        }),
      );
      // `kind:"code"` REQUIRES `command` (manifest.ts:87); testCommand is the
      // additive judge. The test phase's own command is NOT re-run by
      // reverify (runner.ts plan derivation) — it only has to schema-validate.
      // loadManifest REFUSES a manifest with fewer than 2 phases
      // (`phaseCount < 2`, measured live 2026-08-30), so the plan carries a
      // second phase, which reverify runs as a REAL gate command (`true`):
      // instant, exit 0, and proof the gate leg executed.
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
              // Budget rule (manifest.ts requiredBudgetMs): 3× per-attempt
              // ceiling + margins must fit runBudgetMs 300k → 60k keeps 80k
              // headroom over the 94-test suite's measured 7.5 s.
              maxDurationMs: 60_000,
              retries: 0,
            },
            {
              name: "t5-host-gate",
              kind: "code",
              description: "T5.1 operator-pinned gate leg: exit 0, no inputs.",
              command: ["true"],
              maxDurationMs: 10_000,
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
      // EXPLICIT ceiling (r7-T-E): this was the one leg with no clock, and the
      // test's leg-timeout sum already left <200 s of headroom — an unbounded
      // hang here rode the bun test-timeout abort, which is the one path where
      // the `finally` destroy/revoke is not guaranteed. The manifest's own
      // runBudgetMs (300_000) bounds reverify's work; this gives the worktree
      // setup + the gate request the rest. On fire the child is killed first.
      let rvTimer: ReturnType<typeof setTimeout> | undefined;
      const rvDrained = Promise.all([new Response(reverify.stdout).text(), new Response(reverify.stderr).text()]);
      rvDrained.catch(() => {}); // dropped, never unhandled, when the ceiling fires
      const settled: Promise<[string, string, number | null]> = Promise.all([
        rvDrained,
        reverify.exited,
      ]).then(([[stdout, stderr], exit]) => [stdout, stderr, exit] as [string, string, number | null]);
      const [rvStdout, rvStderr, rvExit] = await Promise.race([
        settled,
        new Promise<never>((_, reject) => {
          rvTimer = setTimeout(() => {
            reverify.kill();
            reject(new Error(`reverify timed out after ${REVERIFY_TIMEOUT_MS} ms for ${runId}`));
          }, REVERIFY_TIMEOUT_MS);
        }),
      ]).finally(() => clearTimeout(rvTimer));
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
      expect(paused?.state).toBe("awaiting-approval"); // live-mirror: approval.state vocabulary (DF3.7 approval gate)
      expect(paused?.reportId).toBe(report?.reverifyId); // the gate bound the report reverify minted
      expect(paused?.headSha).toBe(headSha);

      const status = await runFleet(["status", runId, "--driver", "exedev", "--dir", recordsDir], { timeoutMs: 120_000 });
      expect(status.exitCode).toBe(0);
      const row = lastJson<{ runId?: string; state?: string; reportId?: string; expiresInMs?: number }>(status.stdout);
      evidence.push({ phase: "status", row });
      expect(row.runId).toBe(runId);
      expect(row.state).toBe("awaiting-approval"); // NOT boxMissing — the box really is gone (asserted above) // live-mirror: approval.state vocabulary (DF3.7 approval gate)
      expect(row.reportId).toBe(report?.reverifyId);
      expect(row.expiresInMs).toBeGreaterThan(0);

      // ── 10. the operator approves, token on fd 0; the allowlist root is
      //     `--dir` (DF3.4 round-9 C10 parity), NOT the cwd — same latent
      //     pre-C10 defect T1.7 hit live on 2026-09-01 (the approve below
      //     passes `--dir recordsDir`, so the allowlist must live under it) ──
      const allowlistDir = join(recordsDir, ".factory");
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

      // ── round hygiene: no box of OURS survives (skill: final-ls, with the
      //    r7-T-h1 measured lag poll — now `fleetLeftovers`, which carries the
      //    same 5 × 8 s poll and scopes the verdict to what this run owns; the
      //    hand-rolled loop failed on any `e2e-`/`qds-` box in the ACCOUNT,
      //    including a concurrent operator's live one) ──────────────────────
      const hygiene = await fleetLeftovers(ctx.driver, [vmName, runId], evidence);
      evidence.push({ phase: "round-hygiene", owned: hygiene.owned ?? null, strays: hygiene.strays, probe });
      expect(hygiene.owned).toEqual([]);
    } catch (e) {
      // P38: kill any spawnFleet verb still in flight (a collect ceiling that
      // fired, or an assert that threw while a verb was live) so nothing this
      // test spawned outlives the teardown. `kill()` is a no-op on the exited.
      for (const p of liveSpawned) p.kill();
      outcome = "fail";
      // HELD, not thrown (T1.7's shape): a `throw` here makes the post-finally
      // verdicts below unreachable on exactly the runs that need them — a red
      // run is the run whose box and key are most likely to have survived it.
      failure = e;
      // Non-Error-safe: `(e as Error).message` on a string/undefined throw is
      // `undefined`, and the evidence entry then reads as an error that never
      // rendered. `String(... ?? e)` keeps every throw shape printable.
      evidence.push({ phase: "test-error", error: String((e as Error)?.message ?? e) });
    } finally {
      // F12 lesson (T2.1): a gate-refused dispatch PROVISIONED but emitted a
      // refusal payload, not an ack — recover ids from BOTH streams so the
      // cleanup below can never skip the box that is quietly billing.
      //
      // Through `recoverDispatchIds` (L13): the inline copy here matched
      // `qds-[0-9]{8}-[a-z0-9]{6}` while `emittedRunId` matched `qds-[a-z0-9-]+`,
      // so an id satisfying one and not the other was recovered on the ACK path
      // and NOT on this one — the only path the fallback exists for.
      if (runId === "" || vmName === "") {
        const recovered = recoverDispatchIds(dispatchOut, dispatchErr);
        if (runId === "") runId = recovered.runId;
        if (vmName === "") vmName = recovered.vmName;
        evidence.push({ phase: "finally-id-recovery", runId, vmName });
      }
      if (vmName !== "" && ctx !== undefined) {
        // (ctx guard is P28: vmName non-empty implies preflight returned, but
        // the types cannot see that.)
        const destroyed = await destroyQuietly(ctx.driver, vmName, evidence);
        if (!destroyed.ok) destroyFailures.push(`${vmName}: ${destroyed.error}`);
      }
      // F5 — the absence verdict is judged against an ABSOLUTE population, not
      // a relative one. The old shape derived `sweep` from ONE un-retried
      // `list()` and then asserted `no name in sweep is still listed`: inside
      // the MEASURED 25 s+ substrate listing lag (r7-T-h1) that call returns
      // [], and `nothing in [] survives` is true for free — a clean round
      // reported while the box billed.
      //
      // R4 — but "absolute" is not "account-wide". The replacement destroyed
      // EVERY `e2e-`/`qds-` box the fleet listed, on the premise that no
      // concurrent live round exists, which is a skill-doc mandate rather than
      // a lock: two of these files running at once had each `finally`
      // destroying the other's live box mid-body, and one box stranded by a
      // previous round failed a clean paid one. So the population is the boxes
      // this run can PROVE it owns — the ack's `vmName`/`runId` (recovered from
      // both streams above when the dispatch refused before acking) plus every
      // `<id>.json` in THIS workspace, since dispatch writes the run record
      // before the box exists and the fleet creates boxes as
      // `driver.create(runId)`, making the record's file name the box's name.
      //
      // `fleetLeftovers` then carries the lag poll, destroys owned survivors
      // BEFORE rendering the verdict, and warns — never fails — on the rest. It
      // never throws, so no try/catch: a failed listing comes back as
      // `owned: undefined`, which `fleetCleanupProblems` reports as a problem
      // (the same rule D6 pinned for the key list), and a catch here would
      // swallow exactly that.
      let ownedNames: string[] = [vmName, runId].filter((n) => n !== "");
      if (workspace !== "") {
        try {
          ownedNames = [
            ...new Set([
              ...ownedNames,
              ...readdirSync(join(workspace, "runs")).filter((f) => f.endsWith(".json")).map((f) => f.slice(0, -".json".length)),
            ]),
          ];
        } catch (e) {
          // The records dir is unreadable; [vmName, runId] is still a real roster.
          evidence.push({ phase: "finally-owned-ids-error", error: String((e as Error)?.message ?? e) });
        }
      }
      if (ctx === undefined) {
        // P28 abort path: preflight never returned, so this run provisioned
        // NOTHING — there is no driver to list through and no box of ours can
        // exist. [] rather than `undefined`: the listing did not FAIL (which
        // `fleetCleanupProblems` renders as "unmeasured fleet"), it was
        // correctly skipped — a verdict about a round that created something.
        finalBoxes = [];
        evidence.push({ phase: "final-ls-skipped", ok: true, note: "preflight never returned — nothing was provisioned, so no box this run owns can exist" });
      } else {
        finalBoxes = (await fleetLeftovers(ctx.driver, ownedNames, evidence)).owned;
      }
      evidence.push({ phase: "finally-final-ls", owned: finalBoxes ?? null, vmName, ownedNames });
      // EB2 — UNCONDITIONAL on whether the teardown verb exited 0. A teardown
      // that exits 0 WITHOUT revoking is exactly the product defect this test
      // exists to catch, and gating the fallback on its exit code trusts the
      // very chain under test to have cleaned up after itself (T1.4 and D8 run
      // the same ungated fallback). `revokeQuietly` of an already-revoked key
      // answers "already-gone" (harmless); a skipped one leaves a billable key
      // behind a green-looking cleanup.
      // The `workspace !== ""` guard is not cosmetic: `join("", "runs")` is the
      // RELATIVE path "runs", so a run that died before `tmpWorkspace` returned
      // pointed this store at a directory under the process cwd.
      if (runId !== "" && workspace !== "" && ctx !== undefined) {
        // Best-effort revoke so a mid-chain failure never leaves a billable
        // key; the success path's own revoke already ran, and re-running it is
        // a harmless "already-gone". `revokeQuietly` never throws (#189) — an
        // unreadable record lands as a `finally-revoke ok:false` entry, which
        // the verdict below folds in as a problem. It stays UNCONDITIONAL on
        // the teardown's exit code (EB2) AND ahead of the population delta:
        // a key the provider has not listed yet is invisible to a delta, so
        // the record-driven revoke is the belt to the delta's braces.
        //
        // GUARDED (restored): `revokeQuietly` never throws is a contract, not a
        // proof — the `new RunRecordStore(...)` constructor and a driver
        // rejection are both outside it. A throw here escapes AHEAD of
        // `keyLeakProblems`, `writeEvidenceQuietly` and `settleRun`: held body
        // error lost, no evidence, key possibly live.
        try {
          await revokeQuietly(ctx.driver, new RunRecordStore({ dir: join(workspace, "runs") }), runId, evidence);
        } catch (e) {
          const error = e instanceof Error ? e.message : String(e);
          evidence.push({ phase: "finally-revoke-error", runId, error });
          destroyFailures.push(`finally revoke threw for ${runId}: ${error}`);
        }
      }
      // The comparison the skill requires, now the SHARED one (F17): no key
      // hash we caused may outlive us, a survivor is revoked before it is
      // reported, and "could not look" is a problem rather than a verdict that
      // was never rendered.
      //
      // The store is HOISTED into its own try (the F2 shape tier2 fixed at its
      // :464-469): as a call argument, `new RunRecordStore(...)` throwing — a
      // malformed records dir — escaped AHEAD of `writeEvidenceQuietly` and
      // `settleRun`, discarding the held body error and the whole verdict. On
      // the failure `keyLeakProblems` runs with `store: undefined` (its P132
      // wording already says no record-backed fallback was available) and the
      // constructor failure itself rides `destroyFailures` into the ONE
      // verdict below.
      let keyStore: RunRecordStore | undefined;
      try {
        keyStore = workspace === "" ? undefined : new RunRecordStore({ dir: join(workspace, "runs") });
      } catch (e) {
        const error = e instanceof Error ? e.message : String(e);
        evidence.push({ phase: "finally-key-store-error", runId, error });
        destroyFailures.push(`the finally's RunRecordStore constructor threw for ${runId}: ${error}`);
      }
      if (hashesBefore === undefined || ctx === undefined) {
        // P28 (tier2's degradation idiom): the baseline snapshot (or the
        // preflight one statement before it) rejected inside the try — no
        // delta can be rendered, and "could not look" is never "nothing
        // leaked" (D6's rule), so this is a named problem, never a silent
        // skip. The pair fails together in practice (ctx is assigned first);
        // both are checked so the arm stays fail-closed.
        keyProblems = ["the F17 baseline key listing never landed — the key-hash delta is UNVERIFIED for this round"];
        evidence.push({ phase: "key-hash-baseline-missing", ok: false });
      } else {
        keyProblems = await keyLeakProblems(
          hashesBefore,
          {
            driver: ctx.driver,
            store: keyStore,
            runIds: [runId],
          },
          evidence,
        );
      }
      // `writeEvidenceQuietly` (F11): `writeEvidence` THROWS — the secret-scrub
      // refusal above all — and an uncaught throw here propagated out of this
      // `finally`, taking the whole verdict below with it.
      writeEvidenceQuietly("T5.1", "t5-1-gate-steering", { test: "T5.1", outcome, runId, capMicroUsd: T5_CAP_MICRO_USD, phases: evidence }, destroyFailures);
      // GUARDED: `force: true` swallows ENOENT but not EBUSY/EPERM (this test
      // makes a scratch clone and a harvested bundle), and this is the LAST
      // statement of the `finally` — a throw discards the held `failure` and
      // skips `settleRun`, so the round reports an rmSync error where the
      // regression or the leak was.
      try {
        if (workspace !== "") rmSync(workspace, { recursive: true, force: true });
      } catch {
        // workspace cleanup is best-effort; evidence is already written
      }
    }

    // ── the post-`finally` verdict (EB3/F6), in ONE place. The shape this
    // replaces was a stack of bare `expect`s ending in `if (failure !== …)
    // throw failure`: correct on a green run and wrong on a red one, because
    // the FIRST failing cleanup expect threw its own AssertionError and the
    // held body error at the catch above was never re-thrown. The operator then
    // reads "box absence" where the engine regression was, and pays for another
    // live round. `settleRun` attaches every cleanup problem to the held error
    // and re-throws the ORIGINAL; on a body that passed, a cleanup problem is
    // still the failure. ──────────────────────────────────────────────────────
    // `evidence` as `fleetCleanupProblems`' third arg IS the `finally-revoke
    // ok:false` fold-in this site used to hand-roll — `revokeQuietly` never
    // throws (#189) and records `ok:false` on every failure, including an
    // unreadable record, and an unread evidence line reads as a clean run.
    // The hand-rolled filter is DELETED rather than kept beside it: both would
    // fire on the same entries and the round would double-report.
    settleRun(failure, [...fleetCleanupProblems(destroyFailures, finalBoxes, evidence), ...keyProblems]);
  },
  // body ≈5.24M (audited above: +180 scratchClone, +120 positive-control ls,
  // +240 step-5 reads, and the hygiene fleetLeftovers at its DECLARED 880 —
  // a FAILED listing never breaks its poll loop, so ≈50 k was a price only
  // the happy path pays) + finally ≈1.49M (revoke 120 + destroy 120 +
  // fleetLeftovers 880 + keyLeakProblems 360 + evidence 10) ≈ 6.73M;
  // 7_000_000 carried the margin the 5_600_000 it replaced only claimed to.
  // DF1.11 leaf-4d: +1 500 s of acked-round-trip legs (inbox confirmation
  // 480 (F3) + run verb 180 + settle poll 840, audited above) puts the serial
  // worst case at ≈8.23M — 9_000_000 carries the margin.
  9_000_000,
);
