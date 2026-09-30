/**
 * DF6.1b — the story's MANDATORY live demo (story DoD "Test (e2e demo —
 * MANDATORY)"): the three-invocation SHA-bound poll observes the required
 * check turn green on the appended attemptSha, the run reaches terminal
 * success with `attempts: 1`, `outcome: "green"`, and
 * `extensions.fixLoop.fixOutcome.runIds` on the parent record — evidenced by
 * the run records this test reads back.
 *
 * NO BOX AND NO LLM KEY ARE PROVISIONED (DoD verbatim): the demo drives the
 * POLL-RECOVERY arm — the DF6.1a append round (tests/fleet/e2e/
 * tier3-fix-loop-append.live.test.ts, its demo environment reused, never
 * provisioned twice) left the PR's fix run pushed with `fixContext` carrying a
 * real sha, so this invocation resumes the poll against the persisted window
 * anchor instead of dispatching. The three-invocation composition is real
 * `gh` against the real disposable repository; the required-check
 * configuration is the one the DF6.1a environment verified pre-spend.
 *
 * GATING: `liveGate("2")` under `test.todoIf(liveTodoOff())` — normal
 * `bun test`/CI pays nothing (the filename is not the gate). Environment:
 *   QDS_E2E_FIX_PR=<n>    the disposable repo's factory PR the DF6.1a round appended to
 *   QDS_E2E_RUNS_DIR=<dir> the records directory holding that round's parent + fix run
 *
 * PAIRING: run back-to-back AFTER the DF6.1a append round while the PR's
 * required checks are settling or freshly green — inside the 15-minute window
 * the poll resumes with its remaining time; after it, the anchor reads expired
 * and the round classifies `ci-verdict-unavailable` (a charged failure, also a
 * named terminal — run the pair promptly).
 */
import { describe, expect, test } from "bun:test";

import { RunRecordStore } from "../../../src/providers/run-record.ts";
import { parseFixOutcome } from "../../../src/fixloop/escalation.ts";
import { parseFixContext } from "../../../src/fixloop/index.ts";
import { liveGate, liveTodoOff } from "./live-harness.ts";

const REPO_ROOT = process.cwd();
const todo = test.todoIf(liveTodoOff());

describe("DF6.1b live — the SHA-bound poll lands green; fixOutcome lands on the parent", () => {
  todo("the poll-recovery invocation settles green with attempts:1 and the parent carries fixOutcome.runIds", async () => {
    liveGate("2");

    const prNumber = Number((process.env.QDS_E2E_FIX_PR ?? "").trim());
    if (!Number.isInteger(prNumber) || prNumber <= 0) {
      throw new Error(
        "set QDS_E2E_FIX_PR=<n> — the disposable repo's factory PR the DF6.1a append round appended to (run that round first; this demo reuses its environment)",
      );
    }
    const recordsDir = (process.env.QDS_E2E_RUNS_DIR ?? "").trim();
    if (recordsDir === "") {
      throw new Error("set QDS_E2E_RUNS_DIR=<dir> — the records directory holding the DF6.1a round's parent + fix run records");
    }

    // The verdict round: the latest attempt carries fixContext with a real sha
    // (the push happened), so this invocation takes the poll-recovery arm —
    // zero dispatch, zero box, zero key.
    const proc = Bun.spawnSync(
      ["bun", "scripts/fix-run.ts", "--pr", String(prNumber), "--dir", recordsDir],
      { cwd: REPO_ROOT, stdout: "pipe", stderr: "pipe" },
    );
    const stdout = new TextDecoder().decode(proc.stdout);
    const lines = stdout.split("\n").filter((l) => l.trim() !== "");
    const resultLine = JSON.parse(lines.at(-1) ?? "{}") as Record<string, unknown>;
    expect(proc.exitCode).toBe(0);
    expect(resultLine.state).toBe("green");
    expect(resultLine.attempts).toBe(1);
    expect(typeof resultLine.polls).toBe("number");

    // The parent record — DF5.3's hop-1 anchor — carries the loop-terminal
    // marker naming the parent plus every fix runId in attempt order.
    const store = new RunRecordStore({ dir: recordsDir, create: false });
    let parentRunId: string | undefined;
    let fixRunId: string | undefined;
    for (const rec of store.listWithAnomalies().records) {
      const fixContext = (rec.extensions?.fixLoop as Record<string, unknown> | undefined)?.fixContext;
      if (typeof fixContext === "string") {
        try {
          const payload = parseFixContext(fixContext);
          if (payload.prNumber === prNumber && payload.attemptSha !== "0000000000000000000000000000000000000000") {
            fixRunId = rec.runId;
            parentRunId = payload.prBranch.startsWith("qds/") ? payload.prBranch.slice("qds/".length) : undefined;
          }
        } catch {
          // not this story's record
        }
      }
    }
    expect(fixRunId).toBeDefined();
    expect(parentRunId).toBeDefined();
    const parentRaw = (store.get(parentRunId!).extensions?.fixLoop as Record<string, unknown> | undefined)?.fixOutcome;
    const outcome = parseFixOutcome(parentRaw);
    expect(outcome).toMatchObject({
      schemaVersion: 1,
      prNumber,
      attempts: 1,
      outcome: "green",
      runIds: [parentRunId, fixRunId],
    });
    // the fix run's own record names the terminal class
    expect((store.get(fixRunId!).extensions?.fixLoop as Record<string, unknown> | undefined)?.fixOutcomeClass).toBe("green");
  });
});
