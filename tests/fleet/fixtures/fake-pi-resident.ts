#!/usr/bin/env bun
/**
 * DF3.3 C2 test fixture — a pi-emulating binary for tests/fleet/resident.test.ts.
 * argv-compatible with the resident's spawn contract: it is spawned AS the bin
 * (shebang + exec bit), so Bun.argv.slice(2) is exactly the argv after the bin.
 *
 * On start it records { argv, env.OPENROUTER_API_KEY, promptPrePersisted } to
 * QDS_FAKE_PI_RECORD (promptPrePersisted proves §5.2 pre-execution persistence:
 * the redacted prompt artifact must already exist when the process starts),
 * then behaves per QDS_FAKE_PI_MODE:
 *   ok      — emit decoy events (message_start/message_update/toolResult with
 *             usage 9999) then ONE message_end carrying QDS_FAKE_PI_TEXT and
 *             usage QDS_FAKE_PI_INPUT/QDS_FAKE_PI_OUTPUT. The decoys prove the
 *             harvest reads message_end only (INV-COST-3).
 *   hang    — stay alive until SIGKILLed (timeout/stop path).
 *   fail    — exit 3 (nonzero → exitStatus "logic").
 *   garbage — print non-NDJSON, exit 0 (malformed reply, caller must resolve).
 *   stderr-secret — write a >400-char stderr whose secret (env
 *             QDS_FAKE_PI_STDERR_SECRET) straddles the resident's -400 cut
 *             boundary (the cut lands at the secret's midpoint), exit 3.
 *             Proves the nonzero-exit error path redacts BEFORE slicing:
 *             slice-then-redact would leak the secret's second half.
 *
 * Session continuity (B14): when the argv carries `--session <path>`, the
 * fixture appends one line per invocation, so a test can watch the file grow
 * across calls on one resident.
 */
import { appendFileSync, existsSync, writeFileSync } from "node:fs";

const recordPath = process.env.QDS_FAKE_PI_RECORD;
if (recordPath) {
  writeFileSync(
    recordPath,
    JSON.stringify({
      argv: Bun.argv.slice(2),
      env: { OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY ?? null },
      promptPrePersisted: process.env.QDS_FAKE_PI_PROMPT_PATH
        ? existsSync(process.env.QDS_FAKE_PI_PROMPT_PATH)
        : null,
    }),
  );
}

const sessionFlag = Bun.argv.slice(2).indexOf("--session");
if (sessionFlag !== -1) {
  appendFileSync(Bun.argv.slice(2)[sessionFlag + 1]!, "called\n");
}

const mode = process.env.QDS_FAKE_PI_MODE ?? "ok";
if (mode === "hang") {
  // A bare pending promise does not keep a Bun process alive; a timer does.
  setInterval(() => {}, 1 << 30);
} else if (mode === "fail") {
  process.exit(3);
} else if (mode === "stderr-secret") {
  const secret = process.env.QDS_FAKE_PI_STDERR_SECRET ?? "fake-pi-fixed-stderr-secret-marker";
  // Geometry: total = 100 + |secret| + right; right = 400 - ceil(|secret|/2)
  // puts the -400 cut at exactly 100 + floor(|secret|/2) — the secret's
  // midpoint. No trailing newline: it would shift the cut off the midpoint.
  const right = 400 - Math.ceil(secret.length / 2);
  process.stderr.write(`${"L".repeat(100)}${secret}${"R".repeat(right)}`);
  process.exit(3);
} else if (mode === "garbage") {
  console.log("this is not NDJSON");
} else {
  const toCount = (raw: string | undefined, fallback: number, label: string): number => {
    const n = Number(raw ?? fallback);
    if (!Number.isInteger(n) || n < 0) {
      throw new Error(`fake-pi: ${label}=${JSON.stringify(raw)} is not a non-negative integer`);
    }
    return n;
  };
  const input = toCount(process.env.QDS_FAKE_PI_INPUT, 7, "QDS_FAKE_PI_INPUT");
  const output = toCount(process.env.QDS_FAKE_PI_OUTPUT, 11, "QDS_FAKE_PI_OUTPUT");
  const text = process.env.QDS_FAKE_PI_TEXT ?? '{"action":"proceed"}';
  // Decoy usage — must never reach the caller's usage totals.
  const decoyUsage = { input: 9999, output: 9999, cacheRead: 0, cacheWrite: 0, cost: { total: 9.99 } };
  const decoy = (type: string) =>
    JSON.stringify({
      type,
      message: {
        role: "assistant",
        content: [{ type: "text", text: `decoy-${type}` }],
        usage: decoyUsage,
      },
    });
  console.log(decoy("message_start"));
  console.log(decoy("message_update"));
  console.log(
    JSON.stringify({
      type: "toolResult",
      message: { role: "tool", content: [{ type: "text", text: "tool" }] },
      usage: decoyUsage,
    }),
  );
  console.log(
    JSON.stringify({
      type: "message_end",
      message: {
        role: "assistant",
        content: [{ type: "text", text }],
        usage: { input, output, cacheRead: 0, cacheWrite: 0, cost: { total: 0.001 } },
      },
    }),
  );
}
