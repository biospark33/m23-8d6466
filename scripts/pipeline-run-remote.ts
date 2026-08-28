#!/usr/bin/env bun
/**
 * REMOTE pipeline runner (T3.5 small-shim — e2e-audit recon/phase-engine.md §4A).
 *
 * The honest link that is missing in production today (recon G1–G3): nothing
 * invokes the phase engine after dispatch, and the box image carries no
 * bun/node, so `scripts/pipeline-run.ts` cannot run in-box. This shim proves
 * the rest of the chain REAL: the DELIVERED, already-stamped manifest is
 * fetched OFF the box (the stamp provably rode out), the production
 * `loadManifest` + `runContextFrom` witness reconciliation run unchanged, and
 * the phases execute ON THE BOX (`sh -c <cmd>` in `$HOME/src` via
 * driver.exec) orchestrated FROM THE HOST. Journal rows and the terminal
 * marker land host-side under <records-dir>/<run-id>/.
 *
 *   bun scripts/pipeline-run-remote.ts --vm <name> --run-id <id> \
 *        --records-dir <dir> --budget-ms 60000
 *
 * HONEST LABEL: this is NOT the in-box executor (proposed story DF1.10) — it
 * is the host-driven substrate proof. `dispatch_task`/`engineer` phases have
 * no executor here either and throw exactly like the local factory's.
 *
 * PF-2 convention: a code phase's value is {exitCode, stdoutTail} — the
 * bounded (4 KiB) stdout tail, same as pipeline-run.ts since PF-2.
 */
import * as fs from "node:fs";
import * as path from "node:path";

import {
  FileJournal,
  Run,
  loadManifest,
  sanitizeForMessage,
  walkPhases,
  type PhaseBody,
  type PhaseSpec,
} from "../src/phase-engine/index.ts";
import { runContextFrom } from "./pipeline-run.ts";
import { parseValueFlags } from "./lib/cli-args.ts";
import { ExeDevDriver } from "../src/providers/exedev/driver.ts";

const HELP = [
  "Usage: bun scripts/pipeline-run-remote.ts --vm <name> --run-id <id> --records-dir <dir> --budget-ms <n>",
  "       [--request-id <id>] [--box-src <dir>] (default $HOME/src)",
  "",
];

const STDOUT_TAIL_CHARS = 4096;

/** POSIX single-quote wrapping — mirrored from the primitive's own quoter. */
function shellQuote(s: string): string {
  return `'${s.replaceAll("'", `'\\''`)}'`;
}

/** Read one file OFF the box; a nonzero cat is a refusal, never empty bytes. */
async function fetchBoxFile(vm: string, boxPath: string): Promise<string> {
  const driver = new ExeDevDriver();
  const r = await driver.exec(vm, ["sh", "-c", `cat ${shellQuote(boxPath)}`]);
  if (r.exitCode !== 0) {
    throw new Error(`box read of ${boxPath} failed (exit ${r.exitCode}): ${r.stderr.trim().slice(0, 300)}`);
  }
  return r.stdout;
}

/**
 * The box's $HOME, resolved ON THE BOX. shellQuote'd paths are injected into
 * the remote `sh -c` VERBATIM — `cat '$HOME/pipeline.yaml'` single-quotes the
 * dollar and cats a literal "$HOME" directory that does not exist (run3's
 * refusal). Resolving once here and substituting a real absolute path keeps
 * every later shellQuote injection-safe AND expansible-free.
 */
async function boxHome(vm: string): Promise<string> {
  const driver = new ExeDevDriver();
  const r = await driver.exec(vm, ["sh", "-c", 'printf %s "$HOME"']);
  const home = r.stdout.trim();
  if (r.exitCode !== 0 || !/^[A-Za-z0-9._/-]+$/.test(home) || !home.startsWith("/")) {
    throw new Error(`could not resolve $HOME on ${vm} (exit ${r.exitCode}): ${home.slice(0, 120) || r.stderr.trim().slice(0, 120)}`);
  }
  return home;
}

interface RemoteOpts {
  vm: string;
  runId: string;
  requestId: string;
  recordsDir: string;
  budgetMs: number;
  boxSrc: string;
}

/**
 * The remote body factory: identical contract to pipeline-run.ts's
 * makeBodyFactory for `code` phases, except the command execs ON THE BOX in
 * the cloned checkout instead of a local spawn. No tracer — the shim runs no
 * trace sidecar; the journal + marker are the run's record.
 */
function makeRemoteBodyFactory(opts: RemoteOpts): (spec: PhaseSpec) => PhaseBody<unknown> {
  return (spec: PhaseSpec): PhaseBody<unknown> => {
    if (spec.kind === "code") {
      const cmd = spec.command ?? [];
      if (cmd.length === 0) {
        return () => {
          throw new Error(`phase '${sanitizeForMessage(spec.name)}': kind 'code' declares no command`);
        };
      }
      return async () => {
        const driver = new ExeDevDriver();
        // Re-quote EVERY argv element: pipeline-run.ts spawns `cmd` as a real
        // argv (no shell), but this shim rides `sh -c`, and a bare
        // `cmd.join(" ")` flattens `["sh","-c","printf 'x y' > f && …"]` into
        // `sh -c printf 'x y' > f && …` — the script stops being ONE argument,
        // the inner printf runs arg-less (dash "usage" exit 2), and the file
        // lands empty. shellQuote per element keeps the shape argv-identical.
        const r = await driver.exec(opts.vm, [
          "sh",
          "-c",
          `cd ${shellQuote(opts.boxSrc)} && ${cmd.map(shellQuote).join(" ")}`,
        ]);
        return { exitCode: r.exitCode, stdoutTail: r.stdout.slice(-STDOUT_TAIL_CHARS) };
      };
    }
    return () => {
      throw new Error(
        `phase '${sanitizeForMessage(spec.name)}': no executor is registered for kind '${spec.kind}' on the remote shim (the in-box executor is proposed story DF1.10)`,
      );
    };
  };
}

async function main(argv: readonly string[]): Promise<number> {
  let vm: string | undefined;
  let runId: string | undefined;
  let recordsDir: string | undefined;
  let budgetMs: number | undefined;
  let requestId: string | undefined;
  let boxSrc: string | undefined;

  parseValueFlags(argv, {
    flags: ["--vm", "--run-id", "--records-dir", "--budget-ms", "--request-id", "--box-src"],
    help: HELP,
    onValue: (flag, value) => {
      switch (flag) {
        case "--vm":
          vm = value;
          break;
        case "--run-id":
          runId = value;
          break;
        case "--records-dir":
          recordsDir = value;
          break;
        case "--budget-ms": {
          const n = Number(value);
          if (!Number.isSafeInteger(n) || n <= 0) {
            throw new Error(`--budget-ms must be a positive integer, got ${value}`);
          }
          budgetMs = n;
          break;
        }
        case "--request-id":
          requestId = value;
          break;
        case "--box-src":
          boxSrc = value;
          break;
        // F057, same as pipeline-run.ts: `default` was the --box-src case, so a
        // newly declared flag with no case of its own silently became the box's
        // source path.
        default:
          throw new Error(`unhandled flag ${flag}`);
      }
    },
  });
  if (!vm) throw new Error("--vm is required");
  if (!runId) throw new Error("--run-id is required");
  if (!recordsDir) throw new Error("--records-dir is required");
  if (budgetMs === undefined) throw new Error("--budget-ms is required");

  // 1. Fetch the DELIVERED stamped manifest + dispatch's witness off the box.
  //    The bytes are the box's own — the fetch proves delivery; the host-side
  //    scratch dir exists only because loadManifest reads through a path.
  //    Paths are HOME-RESOLVED (see boxHome): a literal "$HOME" survives
  //    shellQuote unexpanded and reads nothing. A custom --box-src is used
  //    VERBATIM; only the default is resolved against the box's real HOME.
  const home = await boxHome(vm);
  const opts: RemoteOpts = {
    vm,
    runId,
    requestId: requestId ?? runId,
    recordsDir,
    budgetMs,
    boxSrc: boxSrc ?? `${home}/src`,
  };
  const manifestBytes = await fetchBoxFile(vm, `${home}/pipeline.yaml`);
  const witnessBytes = await fetchBoxFile(vm, `${home}/run-context.json`);
  const markerRoot = path.join(recordsDir, runId);
  const srcDir = path.join(markerRoot, "delivered");
  fs.mkdirSync(srcDir, { recursive: true });
  const manifestPath = path.join(srcDir, "pipeline.yaml");
  fs.writeFileSync(manifestPath, manifestBytes);
  fs.writeFileSync(path.join(path.dirname(manifestPath), "run-context.json"), witnessBytes);

  // 2. Production load + witness reconciliation, unchanged. The witness copy
  //    was written moments ago → fresh inside S28's window; its BODY is
  //    dispatch's admitted effectiveCeilingMicros, fetched off the box.
  const { manifest, manifestLoadMs, resolvedPath } = loadManifest(manifestPath, budgetMs, srcDir);
  if (resolvedPath === undefined) {
    throw new Error("manifest was derived in memory and has no verified path to anchor the cap witness to");
  }
  const ctx = runContextFrom(runId, opts.requestId, manifest, { manifestPath: resolvedPath, runRoot: srcDir });

  // 3. Journal + marker land under <records-dir>/<run-id>/ — journal.ts reads
  //    QDS_RUN_ROOT at call time, so setting it here shapes finish()'s marker.
  process.env.QDS_RUN_ROOT = markerRoot;
  const journal = new FileJournal(path.join(markerRoot, "journal.jsonl"), runId);
  const run = new Run({ ctx, journal, manifestLoadMs });

  const outcomes = await walkPhases(run, manifest.phases, makeRemoteBodyFactory(opts));
  // PF-2 made the code-phase value carry a bounded stdout tail; this file is
  // the one place values would otherwise be dropped again (the journal's
  // PhaseRecord is metadata-only). Persist them host-side as steps.json —
  // queryable per phase, and the natural shape a future rank adapter reads.
  try {
    fs.writeFileSync(
      path.join(markerRoot, "steps.json"),
      `${JSON.stringify(
        outcomes.map((o) => ({
          phase: o.name,
          exitCode:
            o.value && typeof o.value === "object" && "exitCode" in o.value
              ? (o.value as { exitCode?: number }).exitCode ?? null
              : null,
          stdoutTail:
            o.value && typeof o.value === "object" && "stdoutTail" in o.value
              ? (o.value as { stdoutTail?: string }).stdoutTail ?? null
              : null,
        })),
        null,
        2,
      )}\n`,
    );
  } catch {
    /* the journal + marker are the run's record; steps.json is a bonus sink */
  }
  const result = run.finish(true);
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
    fs.writeSync(2, `pipeline-run-remote: ${err instanceof Error ? err.message : String(err)}\n`);
  }
  process.exit(code);
}
