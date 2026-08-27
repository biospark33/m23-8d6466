#!/usr/bin/env bun
/**
 * Fake pi binary for DF3.3 tests (steering / resident / e2e cluster fixture).
 *
 * Argv-compatible with the resident's pi invocation: reads `-p <prompt>`,
 * accepts (and ignores) `--provider/--model/--mode json/--no-tools`, and
 * appends to the `--session <path>` file so successive invocations of the
 * same session can be told apart. Replies are scripted through env vars —
 * no network, no model:
 *
 *   FAKE_RESIDENT_REPLIES  JSON array of reply strings consumed in invocation
 *                          order (out-of-range repeats the last entry). A
 *                          non-JSON string simulates a malformed reply.
 *                          Default: ['{"action":"proceed"}'].
 *   FAKE_RESIDENT_USAGE    JSON {"input":n,"output":n} token counts on the
 *                          message_end usage block. Default 1000/64.
 *   FAKE_RESIDENT_EXIT     process exit code (default 0).
 *   FAKE_RESIDENT_HANG     "1" → never reply (the timeout path).
 *
 * stdout is pi `--mode json` NDJSON: message_start / message_end (assistant
 * text + usage) / agent_end — the exact event subset `harvestPiStream`
 * accumulates (usage on message_end ONLY, so no double count).
 */
import * as fs from "node:fs";

const argv = process.argv.slice(2);
const pIndex = argv.indexOf("-p");
if (pIndex < 0 || argv[pIndex + 1] === undefined) {
  process.stderr.write("fake-resident: -p <prompt> is required\n");
  process.exitCode = 2;
}

const sessionIndex = argv.indexOf("--session");
const session = sessionIndex >= 0 ? argv[sessionIndex + 1] : undefined;

/** Invocation index = markers this script already appended to the session
 *  file — deterministic across one run's synchronous solicitations. The
 *  marker append happens on EVERY invocation that reaches this function,
 *  hang-mode included: a hung attempt consumed an invocation slot, and the
 *  next (post-timeout) attempt must script the NEXT reply, not the same one
 *  again (the index would otherwise shift back one reply for every hang). */
function invocationIndex(sessionPath: string | undefined): number {
  if (sessionPath === undefined) return 0;
  let seen = 0;
  try {
    for (const line of fs.readFileSync(sessionPath, "utf8").split("\n")) {
      if (line.includes('"fake_resident_invocation"')) seen += 1;
    }
  } catch {
    // First invocation — no session file yet.
  }
  fs.appendFileSync(sessionPath, `${JSON.stringify({ type: "fake_resident_invocation", n: seen })}\n`);
  return seen;
}

const DEFAULT_REPLY = '{"action":"proceed"}';

function scriptedReplies(): string[] {
  const env = process.env.FAKE_RESIDENT_REPLIES;
  if (env === undefined || env === "") return [DEFAULT_REPLY];
  try {
    const parsed: unknown = JSON.parse(env);
    if (Array.isArray(parsed) && parsed.length > 0 && parsed.every((s) => typeof s === "string")) {
      return parsed as string[];
    }
  } catch {
    // Fall through to the default reply.
  }
  return [DEFAULT_REPLY];
}

function scriptedUsage(): { input: number; output: number } {
  const env = process.env.FAKE_RESIDENT_USAGE;
  if (env !== undefined) {
    try {
      const parsed: unknown = JSON.parse(env);
      if (
        typeof parsed === "object" &&
        parsed !== null &&
        typeof (parsed as { input?: unknown }).input === "number" &&
        typeof (parsed as { output?: unknown }).output === "number"
      ) {
        const u = parsed as { input: number; output: number };
        return { input: u.input, output: u.output };
      }
    } catch {
      // Fall through to the default usage.
    }
  }
  return { input: 1000, output: 64 };
}

// Marker BEFORE the hang check (see invocationIndex above): a hung attempt
// still consumed its invocation slot.
const replies = scriptedReplies();
const usage = scriptedUsage();
const index = invocationIndex(typeof session === "string" ? session : undefined);

if (process.env.FAKE_RESIDENT_HANG === "1") {
  // Never reply — the caller's timeout (SIGKILL) is the behavior under test.
  // The timer pins the event loop the same way fake-pi-resident.ts's hang mode
  // does: a live handle guarantees the child stays hung even on a runtime that
  // would otherwise let an unsettled top-level await end the process.
  setInterval(() => {}, 1 << 30);
  await new Promise<never>(() => {});
}

const reply = replies[Math.min(index, replies.length - 1)]!;

const message = {
  role: "assistant",
  content: [{ type: "text", text: reply }],
  usage: {
    input: usage.input,
    output: usage.output,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: usage.input + usage.output,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  },
};

console.log(JSON.stringify({ type: "message_start", message }));
console.log(JSON.stringify({ type: "message_end", message }));
console.log(JSON.stringify({ type: "agent_end", messages: [message] }));

// A usage fault already set exitCode 2 above — FAKE_RESIDENT_EXIT must not
// clobber it to 0 (the `?? 0 || 0` chain used to overwrite any earlier code).
if (process.exitCode === undefined || process.exitCode === null) {
  process.exitCode = Number(process.env.FAKE_RESIDENT_EXIT ?? 0) || 0;
}
