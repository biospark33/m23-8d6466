#!/usr/bin/env bun
/**
 * Pipeline runner (Story DF1.1) — the demonstrable slice.
 *
 * Reads a versioned manifest through the beneath-root walk, opens each declared
 * phase in order, and settles journal row + banner + exit code in one call.
 *
 *   bun scripts/pipeline-run.ts --manifest <path> --budget-ms 120000 --journal out.json
 *
 * Flags:
 *   --manifest <path>    manifest to load (required)
 *   --budget-ms <n>      the caller's ceiling; never assumed (required)
 *   --journal <path>     journal destination (required)
 *   --run-root <path>    root the manifest read is anchored at (default: cwd)
 *   --run-id <id>        default: a fresh uuid
 *   --request-id <id>    propagated unchanged onto every phase record and log line
 *
 * Exit: 0 run ok / 1 run settled not-ok / 2 the run could not be settled at all
 * (manifest refused, journal unwritable) — nothing was recorded, so a poller
 * sees the terminal marker absent.
 *
 * Phase bodies: a `code` phase runs its manifest `command`; its exit code is
 * data, not a phase verdict (DF1.2 AC4 owns that rule), so the phase succeeds
 * whatever the command returns. `engineer` and `agent` phases have no executor
 * until DF1.6 lands the tier-3 spawn seam, and throw — which is exactly what the
 * default-fail promotion rule exists to show.
 */
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import {
  FileJournal,
  Run,
  loadManifest,
  sanitizeForMessage,
  walkPhases,
  type PhaseBody,
  type PhaseSpec,
} from "../src/phase-engine/index.ts";
import { parseValueFlags } from "./lib/cli-args.ts";

const HELP = [
  "Usage: bun scripts/pipeline-run.ts --manifest <path> --budget-ms <n> --journal <path>",
  "       [--run-root <path>] [--run-id <id>] [--request-id <id>]",
  "",
];

/**
 * The environment a manifest command runs in. Deliberately narrow: INV-4 keeps
 * credentials out of the manifest, and there is no reason to hand them to the
 * command through the inherited environment instead.
 */
function childEnv(): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH ?? "",
    HOME: process.env.HOME ?? "",
    ...(process.env.LANG ? { LANG: process.env.LANG } : {}),
    ...(process.env.TMPDIR ? { TMPDIR: process.env.TMPDIR } : {}),
  };
}

/**
 * Runs a manifest-borne argv. `detached: true` puts the child in its own process
 * group so an abort can kill the whole tree, not just the direct child — AC4
 * requires owned subprocess trees to terminate before the phase is recorded, and
 * the promise settles only once the child is really gone.
 *
 * DF1.2's `commandGate` is the intended gate on this argv; until it lands, the
 * command runs with a scrubbed environment and a cwd pinned to the run root.
 */
function runCommand(cmd: readonly string[], signal: AbortSignal, cwd: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd[0] as string, cmd.slice(1), {
      cwd,
      env: childEnv(),
      // fd 1 stays engine-owned: the banner and the structured log are run facts,
      // and a manifest-declared command must not be able to forge either. Child
      // output is relayed to stderr instead.
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    });
    child.stdout?.on("data", (b: Buffer) => fs.writeSync(2, b));
    child.stderr?.on("data", (b: Buffer) => fs.writeSync(2, b));

    let killed = false;
    const killTree = () => {
      killed = true;
      const pid = child.pid;
      try {
        if (pid !== undefined) process.kill(-pid, "SIGKILL");
        else child.kill("SIGKILL");
      } catch {
        // The group may already be gone, or the platform may refuse the negative
        // pid; fall back to the direct child rather than leaving it running.
        child.kill("SIGKILL");
      }
    };
    if (signal.aborted) killTree();
    else signal.addEventListener("abort", killTree, { once: true });
    const done = () => {
      signal.removeEventListener("abort", killTree);
      // Also on a clean exit: a command that backgrounds work and returns leaves
      // the rest of its group alive, and AC4 says owned subprocess trees do not
      // outlive their phase. Skipped when the abort path already killed the
      // group, so the pgid is signalled once. `close` is delivered after the
      // child is reaped, so a recycled pgid is a residual (not closed) race —
      // narrowing it further needs a supervisor this story does not own.
      if (!killed) killTree();
    };
    child.on("error", (err) => {
      done();
      reject(err);
    });
    // `exit`, not `close`: `close` additionally waits for every stdio stream to
    // end, and a backgrounded grandchild holds the inherited pipe open — the
    // phase would then sit out its whole ceiling for a command that already
    // returned. Buffered output survives the group kill, because the pipe holds
    // it until this process reads it.
    child.on("exit", (code, sig) => {
      done();
      resolve(code ?? (sig ? 128 : 0));
    });
  });
}

function makeBodyFactory(cwd: string) {
  return (spec: PhaseSpec): PhaseBody<unknown> => {
    if (spec.kind === "code") {
      const cmd = spec.command ?? [];
      // The manifest schema requires a non-empty `command` for a 'code' phase, so
      // this is unreachable through `loadManifest` — but `PhaseSpec` itself does
      // not encode that at the type level, and this factory is reusable by any
      // caller that constructs a spec directly (tests, future callers). Fail the
      // phase rather than let `spawn(undefined, ...)` throw a raw TypeError.
      if (cmd.length === 0) {
        return () => {
          throw new Error(`phase '${sanitizeForMessage(spec.name)}': kind 'code' declares no command`);
        };
      }
      return async ({ signal }) => ({ exitCode: await runCommand(cmd, signal, cwd) });
    }
    return () => {
      throw new Error(
        `phase '${sanitizeForMessage(spec.name)}': no executor is registered for kind '${spec.kind}' (DF1.6 lands the tier-3 spawn seam)`,
      );
    };
  };
}

async function main(argv: readonly string[]): Promise<number> {
  let manifestPath: string | undefined;
  let budgetMs: number | undefined;
  let journalPath: string | undefined;
  let runRoot: string = process.cwd();
  let runId: string = crypto.randomUUID();
  let requestId: string = crypto.randomUUID();

  parseValueFlags(argv, {
    flags: ["--manifest", "--budget-ms", "--journal", "--run-root", "--run-id", "--request-id"],
    help: HELP,
    onValue: (flag, value) => {
      switch (flag) {
        case "--manifest":
          manifestPath = value;
          break;
        case "--budget-ms": {
          const n = Number(value);
          if (!Number.isSafeInteger(n) || n <= 0) {
            throw new Error(`--budget-ms must be a positive integer, got ${value}`);
          }
          budgetMs = n;
          break;
        }
        case "--journal":
          journalPath = value;
          break;
        case "--run-root":
          runRoot = value;
          break;
        case "--run-id":
          runId = value;
          break;
        default:
          requestId = value;
      }
    },
  });

  if (!manifestPath) throw new Error("--manifest is required");
  if (budgetMs === undefined) throw new Error("--budget-ms is required");
  if (!journalPath) throw new Error("--journal is required");

  const { manifest, manifestLoadMs } = loadManifest(manifestPath, budgetMs, runRoot);
  const journal = new FileJournal(journalPath, runId);
  const run = new Run({
    ctx: { runId, pipelineId: manifest.pipelineId, requestId },
    journal,
    manifestLoadMs,
  });

  // A signal becomes a terminating exception so the run closes and its rows
  // settle, rather than leaving the journal claiming work that is already dead.
  let terminated = false;
  const onSignal = (sig: string) => {
    if (terminated) {
      // The handlers removed the default disposition, so a second Ctrl-C must
      // not be swallowed while a body sits out its cancellation grace.
      fs.writeSync(2, `pipeline-run: ${sig} again — exiting immediately\n`);
      // 2, not 1: the run never reached `finish`, so no marker was written and
      // the exit code must not claim the run settled.
      process.exit(2);
    }
    terminated = true;
    run.terminate(sig);
  };
  process.on("SIGTERM", () => onSignal("SIGTERM"));
  process.on("SIGINT", () => onSignal("SIGINT"));

  await walkPhases(run, manifest.phases, makeBodyFactory(runRoot));
  const result = run.finish(!terminated);
  // Written straight to fd 1 so the banner is on disk before the exit below, and
  // non-fatally: the run is already settled and its marker written, so an EPIPE
  // on stdout must not downgrade a settled run to "never settled".
  try {
    fs.writeSync(1, `${result.banner}\n`);
  } catch {
    /* the marker is the commitment, not stdout */
  }
  return result.exitCode;
}

if (import.meta.main) {
  let code = 2;
  try {
    code = await main(Bun.argv.slice(2));
  } catch (err) {
    fs.writeSync(2, `pipeline-run: ${err instanceof Error ? err.message : String(err)}\n`);
  }
  // Explicit exit: a phase body that ignored its abort may still be alive after
  // the cancellation grace, and nothing it does may outlive the terminal marker.
  process.exit(code);
}
