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
 *   flood   — write ~6 MiB to stdout, exit 0 (trips the resident's 4 MiB
 *             stdout cap: the resident must kill/classify instead of buffering
 *             unboundedly).
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
import { appendFileSync, existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const recordPath = process.env.QDS_FAKE_PI_RECORD;
if (recordPath) {
  writeFileSync(
    recordPath,
    JSON.stringify({
      argv: Bun.argv.slice(2),
      env: { OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY ?? null },
      // INV-RES-3 exhibit (#219): child env KEY NAMES ONLY, sorted — never
      // values, so a dev machine's ambient credentials cannot spill into a
      // test record. Lets the second-mint exhibit assert "exactly one
      // credential-shaped name reached pi" without recording any secret.
      envKeyNames: Object.keys(process.env).sort(),
      promptPrePersisted: process.env.QDS_FAKE_PI_PROMPT_PATH
        ? existsSync(process.env.QDS_FAKE_PI_PROMPT_PATH)
        : null,
    }),
  );
}

// DF3.6b: write a `memory.events` body into the live solicitation leaf. The
// leaf exists only for the duration of this call — the resident reads it and
// removes it in the call's `finally` — so the only place that can stage one is
// inside the child. Lets the host-side suite drive the OOM VERDICT (own-limit
// kill vs a global OOM that merely happened to pick pi) without a kernel.
const eventsRoot = process.env.QDS_FAKE_PI_EVENTS_ROOT;
if (eventsRoot !== undefined) {
  const events = process.env.QDS_FAKE_PI_EVENTS;
  // `memory.peak` staged as base × the leaf's own seq, so two solicitations
  // produce DIFFERENT readings and "a fresh memory.peak per solicitation" can be
  // asserted by VALUE. Object identity cannot assert it: the resident rebuilds
  // the reading as a fresh literal every call, so `.not.toBe` holds even for an
  // implementation that re-read the previous leaf.
  const peakBase = process.env.QDS_FAKE_PI_PEAK_BASE;
  // Where to copy the live leaf's `cgroup.procs` so the test can assert that
  // EXACTLY ONE pid — pi's — was ever placed in it (AC2: the bound is rooted at
  // the resident, never at an ancestor that also holds the engine and every
  // in-box dispatch_task worker).
  const procsOut = process.env.QDS_FAKE_PI_PROCS_OUT;
  for (const entry of readdirSync(eventsRoot)) {
    if (!entry.startsWith("resident.")) continue;
    const leaf = join(eventsRoot, entry);
    if (events !== undefined) writeFileSync(join(leaf, "memory.events"), events);
    if (peakBase !== undefined) {
      const seq = Number(entry.slice(entry.lastIndexOf(".") + 1));
      writeFileSync(join(leaf, "memory.peak"), String(Number(peakBase) * (Number.isFinite(seq) ? seq : 1)));
    }
    // The leaf's ARMED STATE, captured from inside the call — the only moment
    // the leaf exists. Lets the numeric-contract test read `memory.max` back
    // deterministically instead of racing the parent's teardown with a poll.
    const leafOut = process.env.QDS_FAKE_PI_LEAF_OUT;
    if (leafOut !== undefined) {
      const readOr = (name: string): string | null =>
        existsSync(join(leaf, name)) ? readFileSync(join(leaf, name), "utf8") : null;
      writeFileSync(
        leafOut,
        JSON.stringify({ leaf: entry, max: readOr("memory.max"), oomGroup: readOr("memory.oom.group") }),
      );
    }
    if (procsOut !== undefined) {
      writeFileSync(procsOut, existsSync(join(leaf, "cgroup.procs")) ? readFileSync(join(leaf, "cgroup.procs"), "utf8") : "");
    }
  }
}

const sessionFlag = Bun.argv.slice(2).indexOf("--session");
if (sessionFlag !== -1) {
  appendFileSync(Bun.argv.slice(2)[sessionFlag + 1]!, "called\n");
}

// DF3.6b: exit with an arbitrary code, so the resident's exit-code
// classification (notably the placement wrapper's 97) can be exercised through
// a real spawned child rather than only through the shell script standalone.
const forcedExit = process.env.QDS_FAKE_PI_EXIT;
if (forcedExit !== undefined) process.exit(Number(forcedExit));

// DF3.6b: die by SIGNAL, the way a cgroup OOM kill ends a process. The
// resident's own-limit verdict requires BOTH the kernel's counters AND an
// actual signal death, so a test that stages counters on a cleanly-exiting
// child is asserting the negative control, not the kill.
if (process.env.QDS_FAKE_PI_SIGKILL !== undefined) {
  process.kill(process.pid, "SIGKILL");
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
} else if (mode === "flood") {
  // One oversized write over the resident's 4 MiB stdout ceiling — the
  // bounded collector must trip the cap rather than buffer it all.
  process.stdout.write(`${"f".repeat(6 * 1024 * 1024)}\n`);
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
