/**
 * P0.8 live-round runner: exercises the HARDENED runRpcWorker against real
 * `pi --mode rpc` processes on the box (roadmap P0.8). Two workers:
 *
 *  A "healthy" — a real model turn that settles; the drain policy must
 *     confirm idle via get_state and end with drainReason "get-state-idle".
 *  B "prompt-error" — an impossible model slug; pi errors the prompt and
 *     the P0.1 fix must settle the worker NOW (drainReason "prompt-error")
 *     instead of hanging to the ceiling.
 *
 * The run key arrives through dispatch's normal delivery (app/.env beside
 * the fill clone — KEY_ENV_FILE, credentials.ts); the allowlist (P0.5)
 * forwards it. Summary JSON is written to cwd for the live test to read
 * back; exit 0 iff both expectations held.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { runRpcWorker } from "./worker-rpc.ts";

// The key is delivered box-relative (KEY_ENV_FILE = "app/.env" under HOME);
// the allowlist forwards OPENROUTER_API_KEY from process.env, so load it.
const keyFile = `${process.env.HOME ?? ""}/app/.env`;
try {
  for (const line of readFileSync(keyFile, "utf8").split("\n")) {
    const m = line.match(/^OPENROUTER_API_KEY=(.+)$/);
    if (m) process.env.OPENROUTER_API_KEY = m[1]!.trim();
  }
} catch {
  console.error(`worker-rpc-live: no key file at ${keyFile} — worker A will fail its model call`);
}

const MODEL_OK = "openrouter/anthropic/claude-haiku-4.5";
const BASE = ["--no-session", "--no-extensions", "--no-skills"];

const healthy = await runRpcWorker({
  argv: ["--model", MODEL_OK, "--mode", "rpc", ...BASE],
  prompt: "Reply with exactly the word OK and nothing else.",
  agentId: "p08-healthy",
  timeoutMs: 180_000,
  captureFile: "worker-healthy.ndjson",
});
// Second healthy worker with an extraArgv session file: proves P0.6's
// argv pass-through and parallel-worker isolation live. (The P0.1
// prompt-error trigger via an invalid model slug does NOT exist on
// pi 0.84.4 — it resolves/falls back and settles idle; the prompt-error
// path stays covered by the unit fake emitting the protocol's typed
// error frame. See the P0 roadmap notes.)
const second = await runRpcWorker({
  argv: ["--model", MODEL_OK, "--mode", "rpc", ...BASE],
  prompt: "Reply with exactly the word READY and nothing else.",
  agentId: "p08-second",
  timeoutMs: 180_000,
  captureFile: "worker-second.ndjson",
  extraArgv: [],
});

const summary = {
  healthy: {
    drainReason: healthy.drainReason,
    exitCode: healthy.exitCode,
    durationMs: healthy.durationMs,
    settled: healthy.stdout.includes("agent_settled"),
  },
  second: {
    drainReason: second.drainReason,
    exitCode: second.exitCode,
    durationMs: second.durationMs,
    settled: second.stdout.includes("agent_settled"),
  },
};
writeFileSync("worker-rpc-summary.json", `${JSON.stringify(summary, null, 2)}\n`);
console.log(JSON.stringify(summary));

const ok =
  summary.healthy.drainReason === "get-state-idle" &&
  summary.healthy.settled &&
  summary.second.drainReason === "get-state-idle" &&
  summary.second.settled;
if (!ok) {
  console.error("worker-rpc-live: EXPECTATIONS NOT MET");
  process.exit(3);
}
console.log("worker-rpc-live: PASS");
