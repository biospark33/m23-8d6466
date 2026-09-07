/**
 * T1.8 — DF3.4's `fleet attach` transport + DF1.11's in-box steering
 * consumer, the CLOSED ROUND TRIP on a REAL exe.dev box (AC6's inverted PASS
 * shape): attach → the line lands verbatim in /run/steering/inbox.ndjson →
 * the in-box engine's solicitation DRAINS the queue, FOLDS each message into
 * promptContext and appends {messageId, ackedAt, point} to the box's own
 * /run/steering/acks.ndjson → the host verb observes its ack inside the REAL
 * 30 s ceiling (ATTACH_ACK_CEILING_MS) and exits 0 / `attach-acked`.
 *
 * What only a LIVE run can prove, and why each step is here:
 *
 *  - The APPEND LEG is real infrastructure: `attachToRun` sends a fixed
 *    `sh -c` script through `driver.exec` with the payload on stdin, and the
 *    line lands in /run/steering/inbox.ndjson ON THE BOX (attach.ts:205-213).
 *    No fake can prove the script really appends, really enforces the newline
 *    guard, really lands 0600 from `umask 077`, on the substrate it runs on.
 *  - The ACK-WINDOW machinery is real: the 30 s poll (`ATTACH_ACK_CEILING_MS`),
 *    the per-tick `tail -c` read riding the exec layer's output cap
 *    (`ACKS_READ_CAP_BYTES` ≤ `EXEC_MAX_OUTPUT_BYTES`), and the CLI's exit-0
 *    `attach-acked` mapping. This file runs the REAL ceiling; the
 *    `attachOptions` test seam in scripts/fleet.ts is deliberately NOT used.
 *  - The ENGINE LEG is real (what DF1.11 inverted): a dispatched run with the
 *    DF3.3 resident armed, started with `fleet run`, whose steering consumer
 *    (`localSteeringInbox` — local `node:fs`, no driver/vm reference) drains
 *    the queue at its run_start solicitation and acks every messageId in the
 *    box's acks.ndjson. The ack is written by the ENGINE on the box; nothing
 *    host-side produces it (AC1's provenance rule).
 *  - `/run` WRITABILITY is a create-time CONTRACT: `ExeDevDriver.create`
 *    provisions the channel (`sudo -n install -d`, mode 700, exec-user owned)
 *    after the first live round measured that the box exec user is non-root
 *    and `/run` is root-owned 755. The probe below is the live tripwire for
 *    that contract: if it cannot write, create's provisioning regressed and
 *    the assertions fail LOUDLY — never a skip.
 *
 * THE INVARIANT THAT MAKES THE ROUND TRIP DETERMINISTIC (read before
 * "fixing" the ordering): the three attach verbs are fired BEFORE `fleet
 * run`, and the engine is not started until this test has POSITIVE evidence
 * — a `cat` of the inbox showing all three lines — that every message is
 * queued. An engine cannot drain a queue that predates it, so its FIRST
 * solicitation (run_start) folds and acks all three (`drain` re-reads the
 * queue in full and acks every queued message in turn, steering.ts:703-756);
 * each verb then observes its own messageId's ack well inside its own 30 s
 * ceiling. The only ordering under assertion is one this test established
 * itself — no race, no retry-on-timing.
 *
 * SPEND (the zero-spend label is retired by DF1.11, stated here because a
 * reader must be able to price this file): an ack needs a live engine with
 * steering armed (no resident ⇒ no `createSteering` ⇒ no drain ⇒ no ack), and
 * the solicitations that follow spend. This round pays the dispatch setup
 * gate's C/D chat pings, the run_start and run_end solicitations (one
 * measured in-box pi solicitation: $0.000025 / 2.17 s), and one box — worst
 * case bounded by the runner ceiling at the foot of this file, a healthy
 * round minutes. The story mandates spending it rather than engineering a
 * degradation path to keep the old label.
 *
 * Exit codes are a TABLE: `attach-acked` 0 (the PASS shape), `attach-not-
 * acked` 6 (all four reasons — a FAULT to investigate now, not the system's
 * shape; a retry mints a fresh messageId and double-delivers),
 * `run-not-attachable` 5, `message-over-ceiling` a usage refusal (exit 2,
 * thrown by the CLI's own pre-check at scripts/fleet.ts before anything is
 * queued).
 */
import { expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { ATTACH_MESSAGE_CHAR_CEILING } from "../../../src/phase-engine/steering.ts";
import { RunRecordStore } from "../../../src/providers/run-record.ts";
import {
  REPO_ROOT,
  boxExec,
  destroyQuietly,
  emittedRunId,
  fetchBoxFile,
  fleetCleanupProblems,
  fleetLeftovers,
  fleetPartialOutput,
  keyLeakProblems,
  listedKeyHashes,
  liveGate,
  liveTodoOff,
  preflight,
  recoverDispatchIds,
  revokeQuietly,
  runFleet,
  settleRun,
  spawnFleet,
  teardownQuietly,
  tmpWorkspace,
  writeEvidenceQuietly,
} from "./live-harness.ts";

/** Plan default (the siblings' figure): 50,000 µ$ = $0.05 worst-case model spend on the run key. */
const T1_CAP_MICRO_USD = 50_000;
/** Box-hour rate mirroring exe.dev's 2CPU/8GiB rate (T1.4/T2.1's figure). */
const T1_BOX_HOUR_RATE_MICRO_USD = 230_000;
/**
 * The manifest `fleet dispatch` delivers and `qds-engine` walks — T2.2's own,
 * deliberately: two `code` phases (`echo`, `true`), no model call in a phase
 * body, so the engine leg of this test fails for engine reasons, never
 * because a workload was flaky or a model was slow.
 */
const T1_MANIFEST_PATH = "config/rosters/t2.pipeline.json";
/**
 * The double-delivery pair's text — the SAME text twice is the point: the
 * dedupe key is the per-send messageId, never the message (AC6's "the retry
 * step proves double delivery with two acks").
 */
const PROBE_MESSAGE = "t1.8 steering probe one";
/** The in-box steering paths, as attach.ts resolves them with no override. */
const BOX_INBOX = "/run/steering/inbox.ndjson"; // live-mirror: inboxPath() (attach.ts) — steering channel layout
const BOX_ACKS = "/run/steering/acks.ndjson"; // live-mirror: acksPath() (attach.ts) — steering channel layout
/**
 * How many times the pre-engine inbox confirmation re-reads the inbox. Each
 * attach verb's append is the first thing it does, so 6 × 2 s is several
 * times the healthy margin — and bounded, because a poll that never gives up
 * is a paid box that never gets torn down.
 */
const INBOX_CONFIRM_ATTEMPTS = 6;
/** 1 s (self-review F2): each attach verb's 30 s ack ceiling is already open
 * while this loop runs, so the pre-engine confirmation must burn as little of
 * it as possible — the append precedes the verb's own exit, so attempt 1
 * usually confirms. */
const INBOX_CONFIRM_WAIT_MS = 1_000;
/**
 * The engine-settle poll's shape: two instant phases plus TWO real
 * solicitations (each bounded at SOLICIT_TIMEOUT_MS 60 s), so 6 × (status
 * verb + 10 s wait) spans several times a healthy run — the statusStateSettled
 * helper's own tolerance shape, sized to the manifest like T2.2's poll.
 */
const SETTLE_ATTEMPTS = 6;
const SETTLE_WAIT_MS = 10_000;

/**
 * DF1.11 self-review F1: `statusStateSettled` breaks on ANY informative state
 * — "running" included — so it cannot wait out a walking engine (tier2 keeps
 * its own POLLABLE_STATES poll for exactly this reason). This loop polls until
 * the run reaches a SETTLED verdict ("ok" / "not-ok"), tolerating the same
 * cold-ssh "unknown" streak tier2 tolerates (3 consecutive) before failing.
 */
async function waitForSettledVerdict( // dp:ok D017: every awaited fleet call sits inside the per-attempt try below; the only unguarded await is the deliberate inter-attempt sleep
  runId: string,
  recordsDir: string,
  evidence: Record<string, unknown>[],
  attempts = SETTLE_ATTEMPTS,
  waitMs = SETTLE_WAIT_MS,
): Promise<string> { // dp:ok D017: the awaited fleet call sits inside the per-attempt try below; the only unguarded await is the deliberate inter-attempt sleep
  let state = "";
  let unknownStreak = 0;
  const seen: Array<Record<string, unknown>> = [];
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const res = await runFleet(["status", runId, "--driver", "exedev", "--dir", recordsDir], { timeoutMs: 60_000 });
      state = res.exitCode === 0 ? lastJson<{ state?: string }>(res.stdout).state ?? "unknown" : "unknown";
      unknownStreak = state === "unknown" ? unknownStreak + 1 : 0;
      seen.push({ attempt, exitCode: res.exitCode, state });
      if (state === "ok" || state === "not-ok" || unknownStreak > 3) break;
    } catch (e) {
      state = "unknown";
      unknownStreak += 1;
      seen.push({ attempt, error: e instanceof Error ? e.message : String(e), state });
    }
    if (attempt < attempts) await new Promise((r) => setTimeout(r, waitMs));
  }
  evidence.push({ phase: "settle-poll", runId, state, seen });
  return state;
}

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
  "T1.8 attach transport e2e: closed in-box round trip — attach-acked (exit 0) ×3 → drained+folded+acked by the real engine → double delivery (two acks) → at-ceiling acked → over-ceiling refused",
  async () => {
    // DF1.11: this tier now SPENDS (dispatch + engine solicitations), so it
    // gates at tier 2 — the spend-go protocol's authority — rather than
    // keeping the boxes-only tier-1 label it held when nothing acked.
    liveGate("2");
    const evidence: Record<string, unknown>[] = [];
    const ctx = await preflight("2"); // same tier as the liveGate above — this tier spends now
    let workspace = "";
    let runId = "";
    let vmName = "";
    let dispatchOut = "";
    let dispatchErr = "";
    let outcome = "pass";
    /** The body's own error, held so the post-finally box-absence check runs on the failing path too. */
    let failure: unknown;
    /** Cleanup legs that FAILED — rendered AFTER the `finally`, never only recorded (#189). */
    const destroyFailures: string[] = [];
    /** The cleanup-time leak listing; `undefined` means it FAILED, which is a problem, not a pass. */
    let finalBoxes: string[] | undefined;
    /**
     * Evidence-WRITE failures, kept OUT of `destroyFailures`: a secret-scrub
     * refusal is not a box that failed to die, and `fleetCleanupProblems`
     * renders that array as "cleanup failures: …".
     */
    const writeProblems: string[] = [];
    /**
     * Key hashes present before the run (F17): dispatch mints one and the
     * teardown revokes it, so a teardown that skipped the revoke must not
     * ship green — the same verdict every dispatch-owning sibling carries.
     */
    const hashesBefore = await listedKeyHashes();
    /** The F17 key-population verdict, rendered in the finally. */
    let keyProblems: string[] = [];
    try {
      workspace = tmpWorkspace("t18");
      const recordsDir = join(workspace, "runs");
      mkdirSync(recordsDir, { recursive: true });
      // BESIDE the records dir (costLedgerOpts → dirname(recordsDir)): without
      // it admission falls back to defaultCapMicroUsd 5,000,000 µ$ ($5) and
      // the box-hour close fail-louds `box-hour-rate-unconfigured` — the
      // tier5/t2.2 shape, lifted wholesale.
      writeFileSync(
        join(workspace, "cost-config.json"),
        JSON.stringify({ defaultCapMicroUsd: T1_CAP_MICRO_USD, boxHourRateMicroUsd: T1_BOX_HOUR_RATE_MICRO_USD }),
      );
      // The frozen brief shape (R3, tier5's): repoSlug canonically matches
      // repoUrl's path; commitSha = the pinned pushed sha; manifestPath
      // repo-relative, resolved against the dispatch subprocess cwd (= REPO_ROOT).
      const briefPath = join(workspace, "brief.json");
      writeFileSync(
        briefPath,
        JSON.stringify({
          repoSlug: "Quantum-Digital-Solutions/QDS-Factory",
          issueId: 46,
          commitSha: ctx.sha,
          manifestPath: T1_MANIFEST_PATH,
          repoUrl: ctx.repoUrl,
        }),
      );
      evidence.push({ phase: "setup", ok: true, capMicroUsd: T1_CAP_MICRO_USD, manifestPath: T1_MANIFEST_PATH });

      // ── 1. the dispatch verb, as a real subprocess, production path: box +
      //    fill + the manifest pair + the setup gate (C/D = the round's first
      //    real spend) + a minted run key + the record that arms the
      //    resident — everything an ackable attach needs ────────────────────
      const dispatch = await runFleet(
        ["dispatch", "--driver", "exedev", "--brief", briefPath, "--dir", recordsDir],
        // 900 s, the T2.2-measured class for this verb (provision + fill +
        // the A–E gate, C/D being two roster-model pings).
        { cwd: REPO_ROOT, timeoutMs: 900_000 },
      ).catch((e: unknown) => {
        // The L1 fix PORTED from tier5/tier2 (round 3, E3-1): on the timeout
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
      // Ownership armed BEFORE the assertion that can throw — `dispatch` names
      // a box before it can still fail, so binding ownership to the success
      // ack below leaves a failure path with a live box nobody owns.
      const emitted = emittedRunId(dispatch.stdout, dispatch.stderr);
      if (emitted !== undefined) runId = emitted;
      expect(dispatch.exitCode).toBe(0);

      const ackLine = dispatch.stdout.trim().split("\n").filter((l) => l.startsWith("{")).at(-1);
      expect(ackLine).toBeDefined();
      const ack = JSON.parse(ackLine as string) as { runId: string; vmName: string; state: string }; // dp:ok guarded by the toBeDefined assertion directly above — a missing line throws there, never parses undefined
      runId = ack.runId;
      vmName = ack.vmName;
      expect(ack.state).toBe("ready");
      expect(runId).toMatch(/^qds-/);
      evidence.push({ phase: "ack", runId, vmName });
      // POSITIVE CONTROL for the final-ls assertion below (T1.7's shape):
      // without it "no e2e-/qds- box survives" is true for free on a driver
      // whose `list()` cannot see our boxes. The box dispatch just created is
      // the real, billable subject.
      expect((await ctx.driver.list()).some((b) => b.name === vmName)).toBeTrue();

      // ── 2. the record carries the correlation identity: requestId is the
      //    JOIN KEY — the inbox line echoes it, the completion line and the
      //    gate event carry it as `dispatchRequestId` ────────────────────────
      const store = new RunRecordStore({ dir: recordsDir });
      const rec = store.get(runId);
      expect(rec.vmName).toBe(vmName);
      expect(rec.keyHash ?? "").not.toBe(""); // dp:ok the ?? "" IS the validation — the assert demands non-blank right here
      expect(rec.limitMicroUsd).toBe(T1_CAP_MICRO_USD);
      expect(typeof rec.requestId).toBe("string");
      expect(rec.requestId ?? "").not.toBe(""); // dp:ok the ?? "" IS the validation — the assert demands non-blank right here
      const recordRequestId = rec.requestId as string;
      evidence.push({ phase: "record", ok: true, keyHash: rec.keyHash, limitMicroUsd: rec.limitMicroUsd, requestId: recordRequestId });

      // ── 3. the /run substrate probe: has the exec user write access to /run?
      //    The steering design's in-box paths live there, and the provisioning
      //    contract is what makes every later append possible — recorded either
      //    way; a failure surfaces as the append assertions below, with this
      //    line as the triage evidence ──────────────────────────────────────
      const probe = await boxExec(ctx.driver, vmName, ["sh", "-c", "mkdir -p /run/steering && test -w /run/steering && echo WRITABLE"]); // live-mirror: steeringRoot() (attach.ts) — the provisioned channel, recreated at boot by DF1.11's tmpfiles.d drop-in
      evidence.push({ phase: "run-writable-probe", exitCode: probe.exitCode, stdout: probe.stdout.trim(), stderrTail: probe.stderr.trim().slice(-300) });
      expect(probe.stdout).toContain("WRITABLE");

      // ── 4. THE ROUND TRIP. Three attach verbs fired BEFORE any engine
      //    exists, in flight concurrently (spawnFleet — the harness's
      //    act-during-the-verb shape): #1 the probe, #2 the SAME text again
      //    (the double-delivery pair — the CLI mints a fresh messageId per
      //    send, and the dedupe key is the id, never the message), #3 the
      //    AT-CEILING message, exactly ATTACH_MESSAGE_CHAR_CEILING chars —
      //    the largest message the ceiling accepts, sent for real so an
      //    off-by-one that rejects LEGAL messages is visible ────────────────
      const atCeiling = "y".repeat(ATTACH_MESSAGE_CHAR_CEILING);
      const t0 = Date.now();
      const attach1Proc = spawnFleet(["attach", runId, "--driver", "exedev", "--message", PROBE_MESSAGE, "--dir", recordsDir]);
      const attach2Proc = spawnFleet(["attach", runId, "--driver", "exedev", "--message", PROBE_MESSAGE, "--dir", recordsDir]);
      const attachAtProc = spawnFleet(["attach", runId, "--driver", "exedev", "--message", atCeiling, "--dir", recordsDir]);

      // The KEYSTONE: positive evidence every line is IN THE BOX before any
      // engine exists. The engine starts only after this loop has seen all
      // three lines, so its run_start drain provably sees the whole queue —
      // the ordering under test is established here, not hoped for. `2>/dev/null
      // || true` because the FIRST append may not have landed yet (cat of a
      // missing file is a retry, not a refusal).
      let confirmedLines = -1;
      for (let attempt = 1; attempt <= INBOX_CONFIRM_ATTEMPTS; attempt += 1) {
        const read = await boxExec(ctx.driver, vmName, ["sh", "-c", `cat ${JSON.stringify(BOX_INBOX)} 2>/dev/null || true`]);
        confirmedLines = read.stdout.split("\n").filter((l) => l.trim().length > 0).length;
        if (confirmedLines === 3) break;
        if (attempt < INBOX_CONFIRM_ATTEMPTS) await new Promise((r) => setTimeout(r, INBOX_CONFIRM_WAIT_MS));
      }
      evidence.push({ phase: "inbox-pre-engine", confirmedLines, waitedMs: Date.now() - t0 });
      expect(confirmedLines).toBe(3);

      // ── 5. NOW the engine: `fleet run` starts qds-run@<runId> and returns
      //    at the fork. The engine's FIRST solicitation (run_start) drains
      //    the proven queue, folds all three messages and acks all three
      //    messageIds — each attach verb observes its own ack inside its own
      //    REAL 30 s ceiling ────────────────────────────────────────────────
      const runProc = spawnFleet(["run", runId, "--driver", "exedev", "--dir", recordsDir], { cwd: REPO_ROOT });
      const readOut = async (p: ReturnType<typeof spawnFleet>): Promise<{ exitCode: number | null; stdout: string; stderr: string }> => {
        const [exitCode, output] = await Promise.all([p.exited, p.output]);
        return { exitCode, stdout: output.stdout, stderr: output.stderr };
      };
      const attach1 = await readOut(attach1Proc);
      const attach2 = await readOut(attach2Proc);
      const attachAt = await readOut(attachAtProc);
      const runStarted = await readOut(runProc);
      evidence.push({
        phase: "round-trip",
        wallMs: Date.now() - t0,
        attachExits: [attach1.exitCode, attach2.exitCode, attachAt.exitCode],
        runExit: runStarted.exitCode,
        runStdout: runStarted.stdout.trim().slice(0, 200),
      });
      expect(runStarted.exitCode).toBe(0);
      expect(runStarted.stdout).toContain(`started: ${runId}`);

      // The inverted PASS shape, per verb: exit 0, `attach-acked`, NO reason,
      // NO error envelope, and the gate event carrying the join key + rtt.
      expect(attach1.exitCode).toBe(0);
      const ack1 = lastJson<{ runId: string; outcome: string; messageId: string; dispatchRequestId?: string }>(attach1.stdout);
      expect(ack1.outcome).toBe("attach-acked");
      expect(ack1.runId).toBe(runId);
      expect(ack1.messageId).toMatch(/^[0-9a-f-]{36}$/);
      expect(ack1.dispatchRequestId).toBe(recordRequestId);
      const event1 = gateLine(attach1.stderr, "attach");
      expect(event1).toMatchObject({ operation: "fleet.attach", event: "attach", runId, outcome: "attach-acked", state: "attached", dispatchRequestId: recordRequestId });
      expect(Number(event1?.attach_rtt_ms)).toBeGreaterThan(0);
      // NO reason field on the acked arm — it rides only attach-not-acked
      // (fleet.ts: "attach-acked and run-not-attachable carry none").
      expect(event1?.reason).toBeUndefined();
      // NO refusal envelope: the error-envelope assertions of the old
      // no-ack shape are deleted, and their absence is asserted, not assumed.
      expect(envelope(attach1.stderr, "attach-not-acked")).toBeUndefined();

      // The RETRY half of the pair: same text, FRESH messageId — double
      // delivery is inherited by design, and it must be observable, not
      // documented.
      expect(attach2.exitCode).toBe(0);
      const ack2 = lastJson<{ outcome: string; messageId: string; dispatchRequestId?: string }>(attach2.stdout);
      expect(ack2.outcome).toBe("attach-acked");
      expect(ack2.messageId).toMatch(/^[0-9a-f-]{36}$/);
      expect(ack2.messageId).not.toBe(ack1.messageId);
      expect(ack2.dispatchRequestId).toBe(recordRequestId);
      expect(gateLine(attach2.stderr, "attach")?.reason).toBeUndefined();

      // The AT-CEILING half: the largest legal message is not merely
      // accepted by the pre-check — it is drained, folded and ACKED.
      expect(attachAt.exitCode).toBe(0);
      const ackAt = lastJson<{ outcome: string; messageId: string }>(attachAt.stdout);
      expect(ackAt.outcome).toBe("attach-acked");
      expect(ackAt.messageId).toMatch(/^[0-9a-f-]{36}$/);
      expect(gateLine(attachAt.stderr, "attach")?.reason).toBeUndefined();

      // ── 6. the ON-BOX proof. The inbox carries the three lines verbatim
      //    (concurrent appends ⇒ order not asserted, membership is); the
      //    acks file carries the three messageIds — written by the ENGINE,
      //    on the box, at fold time ─────────────────────────────────────────
      const inbox = await fetchBoxFile(ctx.driver, vmName, BOX_INBOX);
      const rows = inbox
        .split("\n")
        .filter((l) => l.trim().length > 0)
        .map((l) => JSON.parse(l) as { messageId: string; requestId?: string; runId: string; message: string; sentAt: string });
      evidence.push({ phase: "inbox-after-acks", lineCount: rows.length });
      expect(rows.length).toBe(3);
      expect(rows.map((r) => r.messageId).sort()).toEqual([ack1.messageId, ack2.messageId, ackAt.messageId].sort());
      for (const row of rows) {
        expect(row.requestId).toBe(recordRequestId);
        expect(row.runId).toBe(runId);
        expect(typeof row.sentAt).toBe("string");
      }
      // DOUBLE DELIVERY, the live PASS assertion AC6 names: the SAME text
      // twice, two messageIds, both delivered.
      expect(rows.filter((r) => r.message === PROBE_MESSAGE)).toHaveLength(2);
      // The at-ceiling line landed capped to EXACTLY the ceiling, not truncated shorter.
      const rowAt = rows.find((r) => r.messageId === ackAt.messageId);
      expect(rowAt?.message.length).toBe(ATTACH_MESSAGE_CHAR_CEILING);
      // 0600 from the append script's umask 077 — read ON the box, not assumed.
      const mode1 = await boxExec(ctx.driver, vmName, ["sh", "-c", `stat -c %a ${JSON.stringify(BOX_INBOX)}`]);
      expect(mode1.stdout.trim()).toBe("600");

      // THE ACK FILE — the engine's own words, and the assertion the old
      // decider probe pointed at: three rows, one per messageId, each
      // {messageId, ackedAt, point} at the fold-time point. By construction
      // every row is run_start (the engine started after the queue was
      // proven complete); the closed point set is asserted rather than the
      // single literal because a degraded-then-retried ack legitimately
      // lands at a later point, and the PROVENANCE of the ack — the box's
      // own file, the engine's own writer — is what this step exists for.
      const ackText = await fetchBoxFile(ctx.driver, vmName, BOX_ACKS);
      const ackRows = ackText
        .split("\n")
        .filter((l) => l.trim().length > 0)
        .map((l) => JSON.parse(l) as { messageId: string; ackedAt: string; point: string });
      evidence.push({ phase: "acks-file", rows: ackRows });
      expect(ackRows.map((r) => r.messageId).sort()).toEqual([ack1.messageId, ack2.messageId, ackAt.messageId].sort());
      for (const row of ackRows) {
        expect(typeof row.ackedAt).toBe("string");
        expect(["run_start", "post_gate_failure", "run_end"]).toContain(row.point);
      }

      // ── 7. the engine walk itself stayed healthy under the fold: the run
      //    settles `ok`, so the acked guidance steered a live run without
      //    breaking it (an ack proves consumption, never application — the
      //    settle is the independent second fact) ───────────────────────────
      const settledState = await waitForSettledVerdict(runId, recordsDir, evidence);
      evidence.push({ phase: "engine-settled", state: settledState });
      expect(settledState).toBe("ok"); // live-mirror: InBoxState settled verdict (status.ts inBoxState, "ok" : "not-ok")

      // ── 8. over-ceiling: the CLI's OWN pre-check refuses BEFORE anything is
      //    queued (scripts/fleet.ts measures sanitizeForMessage length against
      //    the SAME constant the fold caps). Exit 2 = usage/validation, and
      //    the inbox is untouched — nothing over the ceiling may ever land ──
      const overCeiling = "x".repeat(ATTACH_MESSAGE_CHAR_CEILING + 1);
      const attach3 = await runFleet(
        ["attach", runId, "--driver", "exedev", "--message", overCeiling, "--dir", recordsDir],
        { timeoutMs: 60_000 },
      );
      evidence.push({
        phase: "attach-over-ceiling",
        exitCode: attach3.exitCode,
        messageChars: ATTACH_MESSAGE_CHAR_CEILING + 1,
        stderrTail: attach3.stderr.trim().slice(-500),
      });
      expect(attach3.exitCode).toBe(2);
      expect(envelope(attach3.stderr, "usage")).toBeDefined();
      const inbox3 = await fetchBoxFile(ctx.driver, vmName, BOX_INBOX);
      expect(inbox3.split("\n").filter((l) => l.trim().length > 0).length).toBe(3);

      // ── round hygiene: nothing of OURS survives but this test's own box ──
      // This run's box is destroyed in `finally` — it is necessarily alive
      // here, so it is EXCLUDED by name; the assertion is that no OTHER
      // e2e-/qds- box lingers (presumes no concurrent live round, which the
      // skill mandates anyway). The box's own absence is asserted after the
      // finally, below.
      const finalLs = await ctx.driver.list();
      evidence.push({ phase: "final-ls", boxes: finalLs.map((b) => b.name), ownBox: vmName });
      expect(finalLs.filter((b) => /^(e2e|qds)-/.test(b.name) && b.name !== vmName).map((b) => b.name)).toEqual([]);
    } catch (e) {
      outcome = "fail";
      failure = e;
      // B31: a non-Error throw (string, plain object) has no `message` — `String(?? e)` keeps the evidence entry populated instead of `undefined`.
      evidence.push({ phase: "test-error", error: String((e as Error)?.message ?? e) });
    } finally {
      // F12 (the tier5/t2.2 shape): a dispatch that PROVISIONED and then
      // refused emits a refusal payload, not an ack — recover ids from BOTH
      // streams so the cleanup below can never skip the box that is quietly
      // billing.
      if (runId === "" || vmName === "") {
        const recovered = recoverDispatchIds(dispatchOut, dispatchErr);
        if (runId === "") runId = recovered.runId;
        if (vmName === "") vmName = recovered.vmName;
        evidence.push({ phase: "finally-id-recovery", runId, vmName });
      }
      // `teardownQuietly`, not a bare `runFleet` (F2): the ceiling REJECTS,
      // and an unguarded await lets that rejection escape this `finally` at
      // the await — skipping the box destroy, the leftover sweep, the key
      // verdict, the evidence write and `settleRun` itself. `--no-harvest`:
      // a cleanup path is not where a harvest belongs, and this test's proof
      // (the acks file) was already read in the body.
      if (runId !== "" && workspace !== "") {
        const torn = await teardownQuietly(
          ["teardown", runId, "--driver", "exedev", "--dir", join(workspace, "runs"), "--no-harvest"],
          { timeoutMs: 180_000 },
          evidence,
          { at: "t1-8-cleanup", runId },
        );
        if (!torn.ok) destroyFailures.push(`${runId}: ${torn.error}`);
      }
      if (vmName !== "") {
        // The verdict was READ (#189): a destroy that failed and was only
        // recorded shipped a green test on a box still billing.
        const destroyed = await destroyQuietly(ctx.driver, vmName, evidence);
        if (!destroyed.ok) destroyFailures.push(`${vmName}: ${destroyed.error}`);
      }
      // The absolute `e2e-|qds-` backstop, taken at CLEANUP time. Through
      // `fleetLeftovers` (P127/P128/R4): bounded-retry against the measured
      // 25 s+ destroy lag, a destroy of what this run owns before the verdict
      // is rendered, and another round's stray demoted to a warning.
      finalBoxes = (await fleetLeftovers(ctx.driver, [runId, vmName], evidence)).owned;
      // The key half of the cleanup verdict, which the hand-created-box shape
      // never owed: dispatch minted a run key, so a teardown that skipped the
      // revoke must not ship green. `revokeQuietly` never throws (#189) — the
      // guard is for the constructor/driver rejections outside that contract.
      if (runId !== "" && workspace !== "") {
        try {
          await revokeQuietly(ctx.driver, new RunRecordStore({ dir: join(workspace, "runs") }), runId, evidence);
        } catch (e) {
          const error = e instanceof Error ? e.message : String(e);
          evidence.push({ phase: "finally-revoke-error", runId, error });
          destroyFailures.push(`finally revoke threw for ${runId}: ${error}`);
        }
      }
      let keyStore: RunRecordStore | undefined;
      try {
        keyStore = workspace === "" ? undefined : new RunRecordStore({ dir: join(workspace, "runs") });
      } catch (e) {
        const error = e instanceof Error ? e.message : String(e);
        evidence.push({ phase: "finally-key-store-error", runId, error });
        destroyFailures.push(`the finally's RunRecordStore constructor threw for ${runId}: ${error}`);
      }
      try {
        keyProblems = await keyLeakProblems(
          hashesBefore,
          { driver: ctx.driver, store: keyStore, runIds: [runId] },
          evidence,
        );
      } catch (keyErr) {
        keyProblems = [
          `key-leak sweep itself failed: ${keyErr instanceof Error ? keyErr.message : String(keyErr)} — treat the run key's revocation as UNVERIFIED`,
        ];
        evidence.push({ phase: "key-leak-sweep-failed", ok: false, error: keyProblems[0] });
      }
      // `writeEvidenceQuietly` (F11) — the same never-replaces-the-real-failure
      // posture, plus the half the hand-rolled catch lacked: a write that
      // FAILED is a reported problem instead of a stderr line nothing asserts.
      writeEvidenceQuietly("T1.8", "t1-8-attach-transport", { test: "T1.8", outcome, runId, capMicroUsd: T1_CAP_MICRO_USD, phases: evidence }, writeProblems);
      if (workspace !== "") rmSync(workspace, { recursive: true, force: true });
    }

    // The box this run owned must be GENUINELY gone, checked on EVERY path —
    // through `settleRun`, which attaches the cleanup problems to the held
    // error and re-throws the ORIGINAL; on an otherwise-green run a cleanup
    // problem is still the failure (`fleetLeftovers` in the `finally` is the
    // enforcing check: it destroys a survivor and re-lists before reporting,
    // and a listing that could not be taken comes back `undefined`, which
    // `fleetCleanupProblems` renders as the problem it is).
    settleRun(failure, [...fleetCleanupProblems(destroyFailures, finalBoxes, evidence), ...keyProblems, ...writeProblems]);
  },
  // Budget audit (the tier2-dispatch-engine shape), priced at DECLARED CEILINGS
  // — not at typical latency. A bun test-timeout abort is the ONE path where
  // `finally` does not execute, so it is the one path where the box created in
  // the body is never destroyed and keeps billing.
  //
  //   preflight whoami    1 ssh control at DEFAULT_EXEC_TIMEOUT_MS 120    120 s
  //   pre-try key list    listedKeyHashes baseline (F17), allowance       240 s
  //   dispatch verb       runFleet 900_000 (provision + fill + A–E gate)  900 s
  //   box-visible list    1 control ls at 120                            120 s
  //   run-writable probe  1 driver.exec at 120                           120 s
  //   inbox confirmation  ≤6 × driver.exec at 120                        720 s
  //   attach verbs        3 × self-bounded spawnFleet: 30 s ack ceiling
  //                       each + exec overhead, priced at the 180 s the
  //                       awaited form used to declare                   540 s
  //   run verb            spawnFleet run (systemctl start + fork)        180 s
  //   engine settle       6 × (status verb 60 + 10 s wait)               420 s
  //   box file reads      inbox ×2, acks ×1, stat mode — 4 × 120         480 s
  //   attach over-ceiling 1 runFleet 60_000 (CLI pre-check refuses)       60 s
  //   round-hygiene ls    1 control ls at 120                            120 s
  //   local reads/writes  store, evidence                                 10 s
  //                                                              body ────────
  //                                                                    3 910 s
  //   teardownQuietly     fleet teardown verb at 180                     180 s
  //   destroyQuietly      CODE-WORST: 2 rm + 3 confirming list at 120    600 s
  //   fleetLeftovers      5 × (control ls 120 + 8 s wait) + its destroy
  //                      pass (code-worst 600) + the confirming re-list 1 360 s
  //   revokeQuietly       verb-class allowance                           120 s
  //   keyLeakProblems     delta list + fallback revoke + recheck list    360 s
  //   evidence + rmSync   local                                      10 s
  //                                                           finally ────────
  //                                                                    2 630 s
  //                                                                   ────────
  //                                                                    6 540 s
  //
  // Hence 7 000 s (margin over the 6 540 s serial worst case). Every inner
  // ceiling FIRING is safe — it rejects into the catch and the `finally`
  // still runs — so the fail-safe direction for this number is UP: it is what
  // a fully degraded round may consume before the one abort that skips
  // cleanup, not a target. WHOEVER RAISES AN INNER CEILING, LENGTHENS A POLL
  // OR ADDS A CLEANUP STEP MUST RE-ADD IT HERE.
  7_000_000,
);
