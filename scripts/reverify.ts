#!/usr/bin/env bun
/**
 * `bun scripts/reverify.ts <run-id>` — host-side out-of-box re-verification
 * (Story DF5.1).
 *
 * The operator surface for `reverify(runId)`: re-runs a harvested run's tests
 * and the DF1.2 gate library on the host, off a detached worktree of
 * `refs/sandbox/<run-id>`, judged by the host-pinned plan. Writes a
 * `ReverifyReport` to `.sandbox/reverify/<run-id>.jsonl` and, on a green
 * verdict, requests DF3.4's approval. It never opens a PR — that is DF5.2's.
 *
 * Exit codes: 0 green, 1 red, 2 error. An `error` is never reported as a pass
 * (AC4, INV-RV-5).
 *
 * `fleet reverify` is DF3.1's, out of scope here.
 */
import { reverify } from "../src/reverify/index.ts";

const EXIT_BY_VERDICT = { green: 0, red: 1, error: 2 } as const;

async function main(): Promise<number> {
  const runId = process.argv[2];
  if (runId === undefined || runId.startsWith("-")) {
    process.stderr.write("usage: bun scripts/reverify.ts <run-id>\n");
    return 2;
  }

  const { report, approval } = await reverify(runId);

  // stdout carries the report; the step log is on stderr (observability
  // contract), so a caller can pipe one without swallowing the other.
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (approval !== null) {
    process.stderr.write(`approval: ${JSON.stringify(approval)}\n`);
  }
  if (report.failure !== undefined) {
    process.stderr.write(`error: ${report.failure.message}\n  remediation: ${report.failure.remediation}\n`);
  }
  return EXIT_BY_VERDICT[report.verdict];
}

process.exit(await main());
