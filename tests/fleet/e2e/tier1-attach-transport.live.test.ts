/**
 * T1.8 — DF3.4's `fleet attach` transport, host leg vs a REAL exe.dev box
 * (AC6's wire half), with ZERO model spend.
 *
 * What only a LIVE run can prove, and why each step is here:
 *
 *  - The APPEND LEG is real infrastructure: `attachToRun` sends a fixed
 *    `sh -c` script through `driver.exec` with the payload on stdin, and the
 *    line lands in `/run/steering/inbox.ndjson` ON THE BOX (attach.ts:205-213).
 *    No fake can prove the script really appends, really enforces the newline
 *    guard, really lands 0600 from `umask 077`, on the substrate it runs on.
 *  - The ACK-WINDOW machinery is real: the 30 s poll (`ATTACH_ACK_CEILING_MS`),
 *    the per-tick `tail -c` read riding the exec
 *    layer's output cap (`ACKS_READ_CAP_BYTES` ≤ `EXEC_MAX_OUTPUT_BYTES` —
 *    the exact pair yesterday's dev merge touched), and the CLI's exit-6
 *    `attach-not-acked` mapping. This file runs the REAL ceiling; the
 *    `attachOptions` test seam in scripts/fleet.ts is deliberately NOT used.
 *  - `/run` WRITABILITY is now a create-time CONTRACT: `ExeDevDriver.create`
 *    provisions the channel (`sudo -n install -d`, mode 700, exec-user owned)
 *    after the first live round measured that the box exec user is non-root
 *    and `/run` is root-owned 755 — without provisioning, EVERY real attach
 *    was `send-failed` before its payload reached a wire (evidence
 *    `2026-08-30-160742-t1-8-attach-transport.json`). The probe below is the
 *    live tripwire for that contract: if it cannot write, create's
 *    provisioning regressed and the assertions fail LOUDLY — never a skip.
 *
 * THE HONEST NO-ACK (read before "fixing" this test): DF1.10 SHIPPED the
 * in-box executor — `fleet run` starts `qds-run@<runId>`, whose ExecStart is
 * `qds-engine run <runId>`, i.e. `pipeline-run.ts` on the image's own pinned
 * bun. It was never a *proposal*: it is the RESTORATION of the original D4
 * design, from which the host-side placement was a silent, unratified
 * deviation (`docs/superpowers/specs/2026-08-31-tier2-placement-adr.md`,
 * ACCEPTED). What that does not hand this test is an ACKER. The steering consumer
 * (`localSteeringInbox`) is wired in only where `pipeline-run.ts` builds a
 * `createSteering`, which happens only for a run whose RESIDENT spawned — and
 * this test starts no engine at all: it creates a box, attaches to it, and
 * spends nothing on a model. So a real box still acks NOTHING, and
 * `attach-not-acked` / reason `no-ack` / exit 6 ("the message IS queued in the
 * box") is the SHIPPED CONTRACT, asserted here as the pass shape; the steering
 * executor that would change it is DF1.11's, not this story's. An
 * `attach-acked` live assertion would require faking the engine leg on the box
 * — forbidden by the no-fakes rule.
 *
 * Exit codes are a TABLE: `attach-not-acked` 6 (all four reasons — a retry
 * mints a fresh messageId and double-delivers), `run-not-attachable` 5,
 * `message-over-ceiling` a usage refusal (exit 2, thrown by the CLI's own
 * pre-check at scripts/fleet.ts before anything is queued).
 */
import { expect, test } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";

import { ATTACH_MESSAGE_CHAR_CEILING } from "../../../src/phase-engine/steering.ts";
import { RunRecordStore } from "../../../src/providers/run-record.ts";
import {
  boxExec,
  fetchBoxFile,
  fleetCleanupProblems,
  fleetLeftovers,
  liveGate,
  liveTodoOff,
  preflight,
  destroyQuietly,
  runFleet,
  runIdFor,
  settleRun,
  tmpWorkspace,
  writeEvidenceQuietly,
} from "./live-harness.ts";

/**
 * The run's dispatch correlation id — a strict UUID v4, the shape
 * `resolveBriefRequestId` accepts. The attach line echoes the record's
 * `requestId`; the assertion pins the join key end to end.
 */
const DISPATCH_REQUEST_ID = "7c41b2de-5a30-4f18-9c62-1e8b4d2f6a90";
/** The in-box steering paths, as attach.ts resolves them with no override. */
const BOX_INBOX = "/run/steering/inbox.ndjson";
const BOX_ACKS = "/run/steering/acks.ndjson";

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
  "T1.8 attach transport e2e: real append → inbox line verbatim in-box → honest no-ack (exit 6) → fresh messageId per send → over-ceiling refused",
  async () => {
    liveGate("1");
    const evidence: Record<string, unknown>[] = [];
    const ctx = await preflight();
    const runId = runIdFor("t18");
    let vm = "";
    let workspace = "";
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
    try {
      workspace = tmpWorkspace("t18");
      const recordsDir = join(workspace, "runs");
      mkdirSync(recordsDir, { recursive: true });

      // ── a REAL open run: record → real box. No key is minted — no model
      //    call exists on this path, so spend is $0 by construction ────────
      const store = new RunRecordStore({ dir: recordsDir });
      store.create(runId);
      vm = (await ctx.driver.create(runId)).name;
      expect(vm).toBe(runId);
      // POSITIVE control for the box-absence verdict after the finally (T1.7's
      // shape): the only other `list()` here is the post-destroy one, so
      // "our box is gone" would stay permanently, silently true for a driver
      // whose `list()` stopped matching this name grammar. The box must be
      // VISIBLE first — then its absence means something.
      expect((await ctx.driver.list(runId)).some((b) => b.name === runId)).toBeTrue();
      store.set(runId, { vmName: vm, requestId: DISPATCH_REQUEST_ID });
      evidence.push({ phase: "provision", ok: true, vm });

      // ── the /run substrate probe: has the exec user write access to /run?
      //    The steering design's in-box paths live there (attach.ts:53-55),
      //    and NO prior live round has measured this. Recorded either way;
      //    a failure surfaces as the append assertions below, with this
      //    line as the triage evidence ─────────────────────────────────────
      const probe = await boxExec(ctx.driver, vm, ["sh", "-c", "mkdir -p /run/steering && test -w /run/steering && echo WRITABLE"]);
      evidence.push({ phase: "run-writable-probe", exitCode: probe.exitCode, stdout: probe.stdout.trim(), stderrTail: probe.stderr.trim().slice(-300) });
      expect(probe.stdout).toContain("WRITABLE");

      // ── attach #1: the REAL verb, the REAL 30 s ceiling. No consumer can
      //    ack on this box — this test starts no engine on it (see THE HONEST
      //    NO-ACK above) — so the pass shape is exit 6 / reason no-ack ──────
      const t0 = Date.now();
      const attach1 = await runFleet(
        ["attach", runId, "--driver", "exedev", "--message", "t1.8 steering probe one", "--dir", recordsDir],
        { timeoutMs: 180_000 },
      );
      const attach1RttMs = Date.now() - t0;
      evidence.push({
        phase: "attach-1",
        exitCode: attach1.exitCode,
        rttMs: attach1RttMs,
        stdout: attach1.stdout.trim().slice(0, 400),
        stderrTail: attach1.stderr.trim().slice(-800),
      });
      // 6, not 1: the message may be in the box, so a retry double-delivers.
      expect(attach1.exitCode).toBe(6);
      const ack1 = lastJson<{ runId: string; outcome: string; messageId: string; dispatchRequestId?: string }>(attach1.stdout);
      expect(ack1.outcome).toBe("attach-not-acked");
      expect(ack1.runId).toBe(runId);
      expect(ack1.messageId).toMatch(/^[0-9a-f-]{36}$/);
      // The run record's DISPATCH id, echoed as the join key (not this CLI
      // invocation's own requestId).
      expect(ack1.dispatchRequestId).toBe(DISPATCH_REQUEST_ID);
      const env1 = envelope(attach1.stderr, "attach-not-acked");
      expect(env1).toMatchObject({ runId: runId, reason: "no-ack" });
      // The gate event carries WHY, and how long the poll took.
      const event1 = gateLine(attach1.stderr, "attach");
      expect(event1).toMatchObject({ operation: "fleet.attach", event: "attach", runId, outcome: "attach-not-acked", state: "attached", reason: "no-ack" });
      expect(Number(event1?.attach_rtt_ms)).toBeGreaterThan(0);

      // ── the append leg was REAL: the line is IN THE BOX, verbatim ────────
      const inbox1 = await fetchBoxFile(ctx.driver, vm, BOX_INBOX);
      const lines1 = inbox1.split("\n").filter((l) => l.trim().length > 0);
      evidence.push({ phase: "inbox-after-1", lineCount: lines1.length });
      expect(lines1.length).toBe(1);
      const row1 = JSON.parse(lines1[0] as string) as { messageId: string; requestId?: string; runId: string; message: string; sentAt: string };
      expect(row1.messageId).toBe(ack1.messageId);
      expect(row1.requestId).toBe(DISPATCH_REQUEST_ID);
      expect(row1.runId).toBe(runId);
      expect(row1.message).toBe("t1.8 steering probe one");
      expect(typeof row1.sentAt).toBe("string");
      // 0600 from the script's umask 077 — read ON the box, not assumed.
      const mode1 = await boxExec(ctx.driver, vm, ["sh", "-c", `stat -c %a ${JSON.stringify(BOX_INBOX)}`]);
      expect(mode1.stdout.trim()).toBe("600");
      // …and NO acks file: nothing in this box can fold a message. GUARANTEED
      // BY SETUP, not observed — this test starts no engine, so `ABSENT` here
      // proves only that. Same shape as the tier-5 sibling's probe (L25),
      // converted in round 3 (E2-4) so the two files agree about what the same
      // probe proves: a `throw` with the DF1.11 pointer, not a bare matcher on
      // a tautology whose "(DF1.10)" parenthetical read as if DF1.10 were still
      // pending when it shipped.
      const acksProbe = await boxExec(ctx.driver, vm, ["sh", "-c", `test -e ${JSON.stringify(BOX_ACKS)} && echo PRESENT || echo ABSENT`]);
      evidence.push({
        phase: "acks-file",
        state: acksProbe.stdout.trim(),
        note: "ABSENT is guaranteed by this test starting no engine — see DF1.11",
      });
      if (!acksProbe.stdout.includes("ABSENT")) {
        throw new Error(
          `${BOX_ACKS} exists on this box, but this test never ran \`fleet run\`, so nothing here should be folding steering messages. Either something started an engine on this box, or DF1.11's in-box steering consumer has landed — in which case this check is no longer the tautology it is today and this file must decide whether to start a run and assert a real ack (probe said: ${JSON.stringify(acksProbe.stdout.trim().slice(0, 120))})`,
        );
      }

      // ── attach #2: a RETRY of the SAME text — the header's double-delivery
      //    claim, made a fact. The dedupe key is the per-send messageId, never
      //    the message, so a retry after `attach-not-acked` appends the text a
      //    SECOND time under a FRESH id: that is exactly the cost of retrying
      //    an exit 6, and it must be observable, not documented ─────────────
      const attach2 = await runFleet(
        ["attach", runId, "--driver", "exedev", "--message", "t1.8 steering probe one", "--dir", recordsDir],
        { timeoutMs: 180_000 },
      );
      evidence.push({ phase: "attach-2-retry", exitCode: attach2.exitCode, stdout: attach2.stdout.trim().slice(0, 400) });
      expect(attach2.exitCode).toBe(6);
      const ack2 = lastJson<{ outcome: string; messageId: string }>(attach2.stdout);
      expect(ack2.outcome).toBe("attach-not-acked");
      expect(ack2.messageId).toMatch(/^[0-9a-f-]{36}$/);
      expect(ack2.messageId).not.toBe(ack1.messageId);
      const inbox2 = await fetchBoxFile(ctx.driver, vm, BOX_INBOX);
      const rows2 = inbox2
        .split("\n")
        .filter((l) => l.trim().length > 0)
        .map((l) => JSON.parse(l) as { messageId: string; message: string });
      expect(rows2.length).toBe(2);
      expect(rows2.map((r) => r.messageId)).toEqual([ack1.messageId, ack2.messageId]);
      // The text is IN THE BOX TWICE — the retry double-delivered.
      expect(rows2.filter((r) => r.message === "t1.8 steering probe one")).toHaveLength(2);
      evidence.push({ phase: "inbox-after-2", lineCount: rows2.length });

      // ── AT-ceiling (the allowed side of the same branch): an off-by-one that
      //    rejects LEGAL messages is invisible to the +1 leg above, so the
      //    largest message the ceiling accepts is sent for real. It lands in
      //    the box like any other no-ack (exit 6), and the appended line is
      //    capped to exactly the ceiling, not truncated shorter ─────────────
      const atCeiling = "y".repeat(ATTACH_MESSAGE_CHAR_CEILING);
      const attachAt = await runFleet(
        ["attach", runId, "--driver", "exedev", "--message", atCeiling, "--dir", recordsDir],
        { timeoutMs: 180_000 },
      );
      evidence.push({ phase: "attach-at-ceiling", exitCode: attachAt.exitCode, messageChars: ATTACH_MESSAGE_CHAR_CEILING });
      expect(attachAt.exitCode).toBe(6);
      const ackAt = lastJson<{ messageId: string }>(attachAt.stdout);
      const rowAt = JSON.parse(
        (await fetchBoxFile(ctx.driver, vm, BOX_INBOX)).split("\n").filter((l) => l.trim().length > 0).at(-1) as string,
      ) as { messageId: string; message: string };
      expect(rowAt.messageId).toBe(ackAt.messageId);
      expect(rowAt.message.length).toBe(ATTACH_MESSAGE_CHAR_CEILING);

      // ── over-ceiling: the CLI's OWN pre-check refuses BEFORE anything is
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
      const inbox3 = await fetchBoxFile(ctx.driver, vm, BOX_INBOX);
      expect(inbox3.split("\n").filter((l) => l.trim().length > 0).length).toBe(3);

      // ── round hygiene: nothing of OURS survives but this test's own box ──
      // This run's box is destroyed in `finally` — it is necessarily alive
      // here, so it is EXCLUDED by name; the assertion is that no OTHER
      // e2e-/qds- box lingers (presumes no concurrent live round, which the
      // skill mandates anyway). The box's own absence is asserted after the
      // finally, below.
      const finalLs = await ctx.driver.list();
      evidence.push({ phase: "final-ls", boxes: finalLs.map((b) => b.name), ownBox: vm });
      expect(finalLs.filter((b) => /^(e2e|qds)-/.test(b.name) && b.name !== vm).map((b) => b.name)).toEqual([]);
    } catch (e) {
      outcome = "fail";
      failure = e;
      evidence.push({ phase: "test-error", error: (e as Error).message });
    } finally {
      try {
        // Keyed on the RUN ID, not the `vm` variable: the driver names the box
        // after the run id (`expect(vm).toBe(runId)`), so a create that THROWS
        // after creating the box — leaving `vm === ""` — still reaches cleanup
        // by name match. T1.7 and D8 sweep by the same shape.
        const own = await ctx.driver.list(runId);
        const leftover = own.find((b) => b.name === runId);
        if (leftover !== undefined) {
          // The verdict was DISCARDED: `destroyQuietly` returns `{ok:false}`
          // on a destroy that failed and nothing read it, so a box still
          // billing rode out inside a green test (#189).
          const destroyed = await destroyQuietly(ctx.driver, leftover.name, evidence);
          if (!destroyed.ok) destroyFailures.push(`${leftover.name}: ${destroyed.error}`);
        }
      } catch (e) {
        evidence.push({ phase: "finally-destroy", ok: false, error: (e as Error).message });
        destroyFailures.push(`${runId}: list-before-destroy failed: ${(e as Error).message}`);
      }
      // The absolute `e2e-|qds-` backstop, taken at CLEANUP time. The body's
      // own "round hygiene" final-ls is a BODY assertion — it is skipped on
      // exactly the runs that leak, because a body that threw never reaches it.
      //
      // Through `fleetLeftovers` (P127/P128/R4): bounded-retry against the
      // measured 25 s+ destroy lag, a destroy of what this run owns before the
      // verdict is rendered, and another round's stray demoted to a warning.
      // `runId` IS the box name (the body asserts `vm === runId`), so this one
      // call also subsumes the post-`finally` own-box re-list that used to sit
      // below — which reported the same leaked box twice and paid for a second
      // `driver.list` round-trip to do it.
      finalBoxes = (await fleetLeftovers(ctx.driver, [runId], evidence)).owned;
      // `writeEvidenceQuietly` (F11) — the same never-replaces-the-real-failure
      // posture the hand-rolled catch had, plus the half it lacked: a write
      // that FAILED (ENOSPC, or the secret-scrub refusal) is now a reported
      // problem instead of a stderr line nothing asserts on.
      writeEvidenceQuietly("T1.8", "t1-8-attach-transport", { test: "T1.8", outcome, runId, phases: evidence }, writeProblems);
      if (workspace !== "") rmSync(workspace, { recursive: true, force: true });
    }

    // The box this run owned must be GENUINELY gone — destroyQuietly's
    // evidence alone would satisfy a leaking destroy the way an unmeasured key
    // list does — and it is checked on EVERY path: the failing run is the run
    // that can actually leak. `fleetLeftovers` in the `finally` above IS that
    // check now: `runId` is its ownership set, it destroys a survivor and
    // re-lists before reporting, and a listing that could not be taken comes
    // back `undefined`, which `fleetCleanupProblems` renders as "the final
    // fleet listing FAILED — an unmeasured fleet is never a clean one". The
    // separate own-box re-list that used to live here produced a SECOND problem
    // line for the same box (and a second `driver.list` round-trip), and
    // inherited the no-retry lag flake the poll now absorbs.
    //
    // Through `settleRun`, NOT the `expect(absenceError); expect(ownBoxAbsent);
    // if (failure) throw failure;` this replaces. That shape is the F4/F6
    // defect verbatim: on a run that hit BOTH an attach-transport regression
    // AND a leaked box, the first `expect` threw its OWN AssertionError and
    // the held body error was discarded — the operator read "box still listed"
    // where the transport regression was, and paid for another live round to
    // rediscover it. `settleRun` attaches the cleanup problems to the held
    // error and re-throws the ORIGINAL; on an otherwise-green run a cleanup
    // problem is still the failure.
    //
    // No key half: this run mints NOTHING (the header's "$0 by construction" —
    // `attach` delivers a steering line, it never touches a KeyApi), so there
    // is no key population for `keyLeakProblems` to diff.
    settleRun(failure, [...fleetCleanupProblems(destroyFailures, finalBoxes), ...writeProblems]);
  },
  // 900 s, not 600 s: the three attach legs each hold the REAL 30 s ack ceiling
  // open (90 s of pure polling before any transport work), plus provision, the
  // in-box reads and the stat/mode probes, plus a destroy. A runner kill at
  // 600 s aborts the `finally` — the one path where the box destroy is not
  // guaranteed — and the measured pass shape sits far enough under 900 s that
  // the ceiling stays a fail-loud, not a schedule.
  900_000,
);
