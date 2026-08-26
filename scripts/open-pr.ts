#!/usr/bin/env bun
/**
 * `bun scripts/open-pr.ts <run-id>` — host-side PR creation (Story DF5.2).
 *
 * The operator surface for `openPullRequest(runId)`: the last step of a run.
 * It refuses unless DF5.1's report is green at the sha it is about to publish,
 * DF3.4's approval is `approved` on a decision taken after that verdict, and
 * the target repo is registered in `.factory/repos.json`.
 *
 * The token is read from the host keychain, or from a piped stdin:
 *
 *   bun scripts/open-pr.ts <run-id>
 *   printf %s "$TOKEN" | bun scripts/open-pr.ts <run-id>
 *
 * NEVER from argv — it would show in `ps` (INV-PR-2).
 *
 * Exit codes: 0 opened (or already open), 1 refused, 2 usage/unexpected.
 *
 * `fleet pr <run-id>` is DF3.1's, out of scope here.
 */
import { assertExistingRunId } from "../src/providers/run-record.ts";
import { openPullRequest } from "../src/pr/index.ts";

async function main(): Promise<number> {
  const runId = process.argv[2];
  if (runId === undefined || runId.startsWith("-")) {
    process.stderr.write("usage: bun scripts/open-pr.ts <run-id>\n");
    return 2;
  }
  // The id is caller-controlled and reaches a git ref and a refusal-file path.
  // `openPullRequest` asserts it too — that is the guard, and it covers every
  // library caller. This call is the same grammar IMPORTED, never a second
  // regex spelled out here, so the argument surface reports a usage error
  // instead of an unhandled throw.
  try {
    assertExistingRunId(runId);
  } catch (e) {
    process.stderr.write(`${e instanceof Error ? e.message : String(e)}\nusage: bun scripts/open-pr.ts <run-id>\n`);
    return 2;
  }

  const outcome = await openPullRequest(runId);

  // stdout carries the result; the step log is on stderr (observability
  // contract), so a caller can pipe one without swallowing the other.
  if (!outcome.ok) {
    process.stdout.write(`${JSON.stringify(outcome.refusal, null, 2)}\n`);
    process.stderr.write(
      `refused: ${outcome.refusal.failedPrecondition} — ${outcome.refusal.message}\n  nothing was pushed and no PR was opened; the refusal is recorded under .sandbox/pr/\n`,
    );
    return 1;
  }
  process.stdout.write(
    `${JSON.stringify({ prUrl: outcome.prUrl, prNumber: outcome.prNumber, createdAt: outcome.createdAt, reused: outcome.reused }, null, 2)}\n`,
  );
  return 0;
}

// A throw is exit 2, never exit 1: "refused" is a decision this command made
// with the records in hand, and a crash is not that.
process.exit(
  await main().catch((e: unknown) => {
    process.stderr.write(`open-pr failed: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}\n`);
    return 2;
  }),
);
