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
 *   FAKE_RESIDENT_HANG_AT  hang only at this 0-based invocation index (the
 *                          session-marker count above) — e.g. "2" hangs the
 *                          run_end solicitation while run_start/post_gate
 *                          reply normally.
 *   FAKE_RESIDENT_ECHO_ENV name of an env var whose VALUE is substituted for
 *                          every {{FAKE_RESIDENT_ECHO}} placeholder in the
 *                          scripted reply — the route a redaction probe takes
 *                          into the reply artifact's PRE-redaction content, so
 *                          the e2e can assert the redacted form actually
 *                          replaced something.
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
  // Real pi's argv-error path exits IMMEDIATELY: no session marker (no
  // invocation slot consumed) and no billable assistant reply — falling
  // through would over-report versus the real binary.
  process.exit(2);
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

if (process.env.FAKE_RESIDENT_HANG === "1" || process.env.FAKE_RESIDENT_HANG_AT === String(index)) {
  // Never reply — the caller's timeout (SIGKILL) is the behavior under test.
  // The timer pins the event loop the same way fake-pi-resident.ts's hang mode
  // does: a live handle guarantees the child stays hung even on a runtime that
  // would otherwise let an unsettled top-level await end the process.
  setInterval(() => {}, 1 << 30);
  await new Promise<never>(() => {});
}

const reply = replies[Math.min(index, replies.length - 1)]!;

// FAKE_RESIDENT_ECHO_ENV: substitute the named env var's VALUE into the
// scripted reply — the placeholder lands in the reply text pre-redaction, so
// the e2e redaction assertion has something real to bite on.
const echoVar = process.env.FAKE_RESIDENT_ECHO_ENV;
const echoed =
  echoVar === undefined || echoVar === ""
    ? reply
    : reply.replaceAll("{{FAKE_RESIDENT_ECHO}}", process.env[echoVar] ?? "");

const message = {
  role: "assistant",
  content: [{ type: "text", text: echoed }],
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

// The argv-error path exits above; nothing pre-sets exitCode anymore, so the
// scripted exit code is the whole story here.
process.exitCode = Number(process.env.FAKE_RESIDENT_EXIT ?? 0) || 0;
