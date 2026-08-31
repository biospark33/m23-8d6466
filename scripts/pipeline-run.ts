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
 *   --repo-slug <slug>   owner/name; opts into issue-correlated mode (DF1.8)
 *                        and requires --issue — the pair is never defaulted
 *   --issue <n>          GitHub issue number, 1..2^31-1; requires --repo-slug
 *   --issue-url <url>    optional issue link (derivable from slug+id)
 *   --no-resident        disable the resident orchestrator (DF3.3): no spawn,
 *                        no solicitation, a fully deterministic run — the
 *                        control leg of AC1a's equivalence test
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
 *
 * DF1.4: the trace store claims <QDS_RUN_ROOT>/trace (0700). The root matches
 * the terminal marker's (journal.ts): /run in the box, QDS_RUN_ROOT on dev/CI
 * hosts where /run is root-owned or absent.
 *
 * DF1.8: --repo-slug/--issue correlate the run with its GitHub issue.
 * resolveRunCorrelation settles the requestId once (a strict UUID v4 is
 * honoured, else one is generated) and the DF1.4 sessions row is created
 * through tracer.initiateSession carrying (repo_slug, issue_id, issue_url);
 * a refusal at any initiation step lands in <marker-root>/dispatch-failures.log
 * with runId: null and exits 2 — never a fabricated id.
 */
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  FileJournal,
  Run,
  commandGate,
  GateFailureError,
  gatedBody,
  loadManifest,
  readArtifactBeneathRoot,
  runMarkerRoot,
  sanitizeForMessage,
  walkPhases,
  type PhaseBody,
  type PhaseJournal,
  type PhaseSpec,
  type PhaseParams,
  type RunContext,
  looksLikeEnvelope,
} from "../src/phase-engine/index.ts";
import {
  serializeTraceError,
  Tracer,
  TracingJournal,
} from "../src/phase-engine/index.ts";
import type { Envelope } from "../src/phase-engine/envelopes/types.ts";
import { killTree } from "./lib/kill-tree.ts";
import { parseValueFlags, tokenizeArgs } from "./lib/cli-args.ts";
import { dispatchTask } from "../src/phase-engine/phases/dispatch-task.ts";
// DF3.3: the steering port (engine) and the resident agent (fleet). The runner
// is the composition root — the one place the two meet (INV-RES-1's module
// boundary is engine-must-not-import-fleet, and steering.ts honours it).
import {
  createSteering,
  type ResidentTelemetry,
  type SolicitCtx,
  type SteeringController,
  type SteeringDirective,
  type SteeringPoint,
} from "../src/phase-engine/steering.ts";
import { loadRoster } from "../src/phase-engine/roster/schema.ts";
import { localSteeringInbox } from "../src/fleet/attach.ts";
import { DEFAULT_RESIDENT_SLUG, startResident, type ResidentSpawn } from "../src/fleet/resident.ts";
import { RateError } from "../src/phase-engine/roster/validate.ts";
import {
  appendDispatchFailure,
  CorrelationError,
  MAX_ISSUE_ID,
  resolveRunCorrelation,
} from "../src/phase-engine/issue-correlation.ts";
// ExitStatus comes through the types.ts re-export — the single source of truth
// lives in cli-anything/src/types.ts and is never re-spelled here (DF1.8).
import type { ExitStatus, ResolvedRunCorrelation } from "../src/phase-engine/types.ts";

const HELP = [
  "Usage: bun scripts/pipeline-run.ts --manifest <path> --budget-ms <n> --journal <path>",
  "       [--run-root <path>] [--run-id <id>] [--request-id <id>]",
  "       [--repo-slug <owner/name> --issue <n> [--issue-url <url>]] [--no-resident]",
  "",
];

/** The value flags main() takes — shared by the tokenizer and the value parser. */
const VALUE_FLAGS = [
  "--manifest",
  "--budget-ms",
  "--journal",
  "--run-root",
  "--run-id",
  "--request-id",
  "--repo-slug",
  "--issue",
  "--issue-url",
] as const;

/**
 * The minted fleet-run-id shape (`qds-YYYYMMDD-xxxxxx`). Local copy because
 * `src/fleet/dispatch.ts` does not export its own (it is that module's AC2
 * intake check, not a public contract): if the shapes drift, the cost of the
 * drift is only a wider filter — a run id that matches HERE but not THERE is
 * impossible (this is that pattern), and one matching THERE but not HERE just
 * disables the filter, which is the safe direction (round-9 B11).
 */
const MINTED_FLEET_RUN_ID_RE = /^qds-\d{8}-[a-f0-9]{6}$/;

/**
 * The environment a manifest command runs in. Deliberately narrow: INV-4 keeps
 * credentials out of the manifest, and there is no reason to hand them to the
 * command through the inherited environment instead.
 */
function childEnv(): Record<string, string> {
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
 * DF1.2's `commandGate` gates this argv where a caller composes it (see
 * makeBodyFactory); the command itself runs with a scrubbed environment and a
 * cwd pinned to the run root.
 *
 * DF1.4: recordProcess/endProcess calls for tracer.
 */
/** PF-2: the bounded stdout tail a code phase's journal value carries. */
const STDOUT_TAIL_CHARS = 4096;

/** Bytes observability writes dropped this run (EAGAIN/full pipe, 0-progress
 *  writes). A counter, not a failure: AC5's "never fail the run" stands. */
let droppedWriteBytes = 0;

/**
 * `fs.writeSync` may write PARTIALLY (pipes, EINTR); a short write silently
 * drops the tail of the log line. Loop until every byte lands — but bounded:
 * POSIX permits a 0-byte write(2), and a no-progress write must not spin this
 * "never fail the run" helper forever, so the loop breaks on 0 and caps its
 * iterations. Write errors (EPIPE on a closed fd, EAGAIN on a full pipe
 * buffer) are swallowed — observability is a sidecar (AC5), never a reason to
 * fail the run. A dropped tail is no longer SILENT, though: it lands in
 * `droppedWriteBytes` and earns one best-effort marker line.
 */
function writeAll(fd: number, data: string | Buffer): void {
  const bytes = typeof data === "string" ? Buffer.from(data, "utf8") : data;
  let written = 0;
  try {
    for (let spins = 0; written < bytes.length && spins < 1000; spins += 1) {
      const n = fs.writeSync(fd, bytes, written, bytes.length - written);
      if (n <= 0) break;
      written += n;
    }
  } catch {
    /* drop the rest of this line rather than fail the run for a log write */
  }
  const dropped = bytes.length - written;
  if (dropped > 0) {
    droppedWriteBytes += dropped;
    // Raw writeSync, never writeAll — the marker about a dropped write must
    // not itself recurse into the dropping path.
    try {
      fs.writeSync(2, `pipeline-run: warning: observability write dropped ${dropped} byte(s) (${droppedWriteBytes} total this run)\n`);
    } catch {
      /* the marker is a sidecar too */
    }
  }
}

function runCommand(
  cmd: readonly string[],
  signal: AbortSignal,
  cwd: string,
  tracer: Tracer,
  requestId: string,
): Promise<{ exitCode: number; stdoutTail: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd[0] as string, cmd.slice(1), {
      cwd,
      env: childEnv(),
      // fd 1 stays engine-owned: the banner and the structured log are run facts,
      // and a manifest-declared command must not be able to forge either. Child
      // output is relayed to stderr instead — and, since PF-2, a bounded tail of
      // it rides the phase value so step outputs become queryable (the journal
      // used to carry {exitCode} only, which left rank scoring nothing to read).
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    });
    // The tail is last-STDOUT_TAIL_CHARS chars, so a bounded buffer + drop-oldest
    // while streaming; stderr needs no tail and only relays.
    let stdoutBuf: Buffer = Buffer.alloc(0);
    child.stdout?.on("data", (b: Buffer) => {
      stdoutBuf = stdoutBuf.length + b.length > STDOUT_TAIL_CHARS * 4
        ? Buffer.concat([stdoutBuf.subarray(stdoutBuf.length + b.length - STDOUT_TAIL_CHARS * 4), b])
        : Buffer.concat([stdoutBuf, b]);
      writeAll(2, b);
    });
    child.stderr?.on("data", (b: Buffer) => writeAll(2, b));

    // DF1.4: Record process spawn. Tracer methods are non-throwing by
    // contract (AC5); the guard is defense in depth — at this point the child
    // exists but its abort wiring and exit handlers are not yet registered, so
    // a throw here would reject the phase and orphan an owned subprocess.
    const pid = child.pid;
    if (pid !== undefined) {
      try {
        tracer.recordProcess({
          requestId,
          kind: "command",
          pid,
          command: cmd.join(" "),
        });
      } catch {
        /* tracer is a sidecar; never let it fail the phase or orphan the child */
      }
    }

    let killed = false;
    // F024: was an inline fourth copy (negative-pid only, no win32 arm). Now
    // the shared primitive — same POSIX group kill, plus the taskkill and
    // direct-child fallbacks this copy never had.
    const killChildTree = () => {
      killed = true;
      killTree(child, "SIGKILL");
    };
    if (signal.aborted) killChildTree();
    else signal.addEventListener("abort", killChildTree, { once: true });
    const done = () => {
      signal.removeEventListener("abort", killChildTree);
      // Also on a clean exit: a command that backgrounds work and returns leaves
      // the rest of its group alive, and AC4 says owned subprocess trees do not
      // outlive their phase. Skipped when the abort path already killed the
      // group, so the pgid is signalled once. `close` is delivered after the
      // child is reaped, so a recycled pgid is a residual (not closed) race —
      // narrowing it further needs a supervisor this story does not own.
      if (!killed) killChildTree();

      // DF1.4: End process
      if (pid !== undefined) {
        try {
          tracer.endProcess({
            requestId,
            pid,
            endedAt: new Date().toISOString(),
          });
        } catch {
          /* ignore */
        }
      }
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
      resolve({ exitCode: code ?? (sig ? 128 : 0), stdoutTail: stdoutBuf.toString("utf8").slice(-STDOUT_TAIL_CHARS) });
    });
  });
}

/**
 * The run context the phase engine is handed, built from the loaded manifest.
 *
 * DF3.1 AC9b: the run's money ceiling reaches the spawn harness through this
 * context — `dispatch-task.ts` forwards `ctx.effectiveCeilingMicros` to
 * `_runTeamManifest`, and DF1.6 raises the harness cap from it. Nothing read it:
 * the context was built from three fields, so the field was `undefined` on every
 * real run and every run spawned at the $0.50 harness default no matter what the
 * dispatcher admitted. Dispatch's `run-context.json` was read by nothing at all.
 *
 * The MANIFEST is the CARRIER, because AC9a already makes it the cap's only
 * in-box one: dispatch stamps `limitMicroUsd` with the same
 * `effectiveCeilingMicros` it writes to `run-context.json`, `loadManifest` has
 * already validated it as a positive safe integer, and the setup gate refuses
 * the box if it is absent or unspendable. It is not the cap's AUTHORITY, which
 * is why `run-context.json` is read here rather than ignored — see the
 * reconciliation note below. Two copies of one number that must agree is the
 * point: they disagree exactly when one of them was authored.
 *
 * Conditional spread, not `?? undefined`: an unstamped manifest must leave the
 * field ABSENT rather than present-and-undefined — the engine never defaults it
 * to a number, and `"effectiveCeilingMicros" in ctx` is the shape that says so.
 *
 * A declared cap is RECONCILED, never trusted on the manifest's word.
 * `stampManifestLimit`'s stamp and a hand-authored `limitMicroUsd` are
 * byte-identical in the file, so `loadManifest` cannot tell them apart (and
 * `manifest.ts` says so). This is the read that promotes the field into a
 * spend ceiling, so it is the read that must ask for a witness: dispatch writes
 * `run-context.json` beside `pipeline.yaml` carrying the SAME admitted
 * `effectiveCeilingMicros`, and the two must agree. No witness, an unreadable
 * one, or a disagreement is a refusal — an authored manifest cannot raise
 * DF1.6's harness cap by naming a number.
 *
 * The witness is consulted whenever one is PRESENT, not only when the manifest
 * declares a cap. Reconciling only on a declared limit meant an unstamped
 * manifest discarded a perfectly good admitted ceiling and ran at the harness
 * default — higher than what was reserved. So: witness + declared limit → they
 * must agree; witness alone → the witness IS the ceiling; declared limit alone
 * → refusal; neither → the field stays ABSENT, never defaulted to a number.
 *
 * Round 11 removed the last fallback on the witness-alone path: a STALE
 * witness on an unstamped manifest used to warn and downgrade to the harness
 * default, on the theory that the default is "never higher than what was
 * reserved" — false for any admission below DF1.6's $0.50 (a witnessed
 * 250_000 µ$ ran at TWICE its ceiling, the very spawn the reconciliation was
 * built to stop). An undeclared limit has nothing of its own to fall back to,
 * so the witness-only path now goes through the same refusing reader the
 * declared path uses: whatever verdict the reader reaches is the verdict.
 *
 * KNOWN ASSUMPTION, and the whole reconciliation rests on it: THE WITNESS IS
 * NOT AUTHOR-WRITABLE. It is looked for beside the manifest
 * (`admittedCeilingBeside` joins `run-context.json` onto the manifest's own
 * dirname), so "they disagree exactly when one of them was authored" holds only
 * while the manifest's directory is dispatch's to fill. A repo that ships BOTH
 * `pipeline.yaml` with `limitMicroUsd: 10_000_000` and a sibling
 * `run-context.json` carrying the matching `effectiveCeilingMicros` reconciles
 * cleanly and raises the harness cap by naming a number twice. Nothing here
 * binds the witness to dispatch: it is not signed, it is not compared against
 * the run record's `limitMicroUsd`, and there is no proof dispatch's fill wrote
 * it last. The upgrade path is to stop deriving the witness from the manifest's
 * neighbourhood — read the admitted ceiling from a dispatch-owned location (the
 * run record, or a path under the marker root that the author's tree cannot
 * reach) — or to sign it. Until then the guarantee is "an authored manifest
 * alone cannot raise the cap", not "an authored REPO cannot".
 *
 * S28 narrows that residual with a TEMPORAL binding, since a cryptographic one
 * does not exist yet: a witness is only trusted while it is FRESH relative to
 * this invocation (`witnessStaleBecause`, ±30 min around now). The two ways a
 * wrong ceiling got in were a leftover `run-context.json` from an earlier,
 * larger dispatch sharing the directory, and one committed next to the manifest
 * in the repo — the first is always old, and the second is old unless the run
 * starts inside the checkout window. Dispatch's own handoff is unaffected: it
 * writes the witness moments before the box runs, well inside the window.
 * Fully closing the second vector still needs a dispatch-owned location or a
 * signature; a fresh planted file still reconciles.
 *
 * Exported for its test: the field appears in no journal row and no terminal
 * marker, so a spawned end-to-end run has nothing to assert on.
 */
export function runContextFrom(
  runId: string,
  requestId: string,
  manifest: { pipelineId: string; limitMicroUsd?: number },
  witness: { manifestPath: string; runRoot: string },
): RunContext {
  const ctx: RunContext = { runId, pipelineId: manifest.pipelineId, requestId };
  if (manifest.limitMicroUsd === undefined) {
    // A WITNESS PRESENT IS DISPATCH'S STATEMENT ABOUT THIS RUN, and it reaches
    // the context whether or not the manifest says anything. This used to
    // `return ctx` before it ever looked, which is fail-open in the direction
    // the bug shipped: a valid witness admitting 250_000 µ$ sat unread beside an
    // unstamped manifest and the run spawned at DF1.6's $0.50 default — TWICE
    // the ceiling the ledger reserved against the issue cap. Nothing in the
    // eight reconciliation cases could see it, because every one of them
    // declares a limit first. If `stampManifestLimit` ever regresses, or
    // `stripAuthoredLimit` is applied on the runner side, this is the door the
    // admitted ceiling walks out of.
    if (!witnessPresent(witness.manifestPath)) return ctx;
    // No undeclared-limit fallback remains. The stale downgrade below used to
    // be a warn + harness-default on the theory that "the DF1.6 harness
    // default is never higher than what was reserved" — false for any
    // admission BELOW $0.50 (a witnessed 250_000 µ$ ran at twice its ceiling),
    // so it has been deleted: a present witness now goes through the same
    // refusing reader the declared path uses (`admittedCeilingBeside`, whose
    // staleness check throws). An unreadable lstat also refuses there instead
    // of masquerading as "vanished → stale → uncapped". ABSENCE is still the
    // only thing that leaves the field unset.
    return {
      ...ctx,
      effectiveCeilingMicros: admittedCeilingBeside(witness.manifestPath, witness.runRoot, false),
    };
  }
  const admitted = admittedCeilingBeside(witness.manifestPath, witness.runRoot, true);
  if (admitted !== manifest.limitMicroUsd) {
    throw new Error(
      `manifest declares limitMicroUsd ${manifest.limitMicroUsd} but dispatch admitted ${admitted}`,
    );
  }
  return { ...ctx, effectiveCeilingMicros: manifest.limitMicroUsd };
}

/**
 * The admitted ceiling dispatch recorded beside the manifest it stamped.
 *
 * Read through `readArtifactBeneathRoot` — the same hardened four-step walk the
 * manifest itself came through (realpath → beneath-root re-assert → `O_NOFOLLOW`
 * open + fd-path verification → read through the descriptor), with the same size
 * ceiling. A second, weaker reader for the file that vouches for the cap would
 * be the one worth attacking.
 */
const witnessPathBeside = (manifestPath: string): string =>
  path.join(path.dirname(manifestPath), "run-context.json");

/**
 * Is there anything at all where the witness belongs?
 *
 * The ONLY question this answers is whether the no-declared-cap path should
 * consult the witness — a directory with no witness leaves the field absent
 * (never defaulted to a number), and anything else goes to the hardened reader
 * below, which refuses whatever it cannot verify. It is deliberately not a
 * readability check: an unreadable, non-JSON or unspendable witness must
 * REFUSE, not read as "no cap".
 *
 * `lstatSync`, not `existsSync`. `existsSync` follows symlinks and reports a
 * DANGLING one as absent, which would let an author hide a witness that LOWERS
 * their ceiling by planting a broken link beside the manifest. `lstat` sees the
 * link itself. Any errno that is not ENOENT (an EACCES on the directory, say)
 * is a witness we cannot rule out, so it counts as present and fails closed.
 */
function witnessPresent(manifestPath: string): boolean {
  try {
    fs.lstatSync(witnessPathBeside(manifestPath));
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code !== "ENOENT";
  }
}

/**
 * S28: the freshness half of binding the witness to THIS run. `null` when the
 * witness is fresh enough to trust, else a reason naming the violation.
 *
 * The window is SYMMETRIC around now, and `Math.abs` is the whole point: a
 * future-dated mtime (clock skew between fill host and box, or a forged one)
 * is exactly as untrustworthy as an old one. 30 min is three DF1.6 default
 * step timeouts (600_000 ms) — room for box boot and the setup gate between
 * dispatch's fill and the runner's first read, without letting last week's
 * dispatch speak for this run. A checked-in witness only passes if the run
 * starts within the checkout window; killing that residual needs the
 * dispatch-owned location or signature noted in `runContextFrom`.
 *
 * `lstatSync`, matching `witnessPresent`: the link itself is what was seen
 * there, so the link's mtime is what is judged.
 *
 * Only ENOENT reads as "vanished" here (round 11): every other errno is an
 * UNREADABLE witness, and mapping it onto staleness — which the callers then
 * treat as a downgrade to the harness default — turned a permissions fault
 * into an uncapped run. That was fail-open where `witnessPresent`'s own
 * contract promises fail-closed ("an unreadable witness must REFUSE, not read
 * as 'no cap'"). `witnessStaleBecause` now rethrows any non-ENOENT errno; the
 * calling paths refuse with it verbatim. Nothing can interleave a removal
 * AND swap in a different file under this name between the presence check and
 * the read without touching the directory itself, so a true ENOENT remains the
 * only disappearance worth labelling.
 */
const WITNESS_FRESH_WINDOW_MS = 30 * 60_000;

/** The reason an out-of-window witness stops speaking for this run. */
const WITNESS_STALE_MESSAGE = (ageMs: number): string => {
  const skew = ageMs < 0;
  return `its mtime is ${Math.round(Math.abs(ageMs) / 1000)}s ${skew ? "in the future" : "old"}, outside the ±${Math.round(WITNESS_FRESH_WINDOW_MS / 60_000)}min freshness window this run binds it to`;
};

function witnessStaleBecause(manifestPath: string): string | null {
  let mtimeMs: number;
  try {
    mtimeMs = fs.lstatSync(witnessPathBeside(manifestPath)).mtimeMs;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      return "it vanished between the presence check and this read";
    }
    throw err;
  }
  const ageMs = Date.now() - mtimeMs;
  if (Math.abs(ageMs) <= WITNESS_FRESH_WINDOW_MS) return null;
  return WITNESS_STALE_MESSAGE(ageMs);
}

/**
 * `declared` is the CALLER'S state, not a behaviour switch: both refusals read
 * identically either way, and only the lead-in changes. The witness-only path
 * reaches this function precisely BECAUSE the manifest declared nothing, so the
 * old unconditional "manifest declares limitMicroUsd but …" told the operator
 * the opposite of what happened — sending them to grep a `limitMicroUsd` that
 * is not in their manifest, when the thing to fix is the witness beside it.
 */
function admittedCeilingBeside(manifestPath: string, runRoot: string, declared: boolean): number {
  const witnessPath = witnessPathBeside(manifestPath);
  // The witness is consulted for opposite reasons on the two paths — to CHECK a
  // declared limit, or to SUPPLY an undeclared one — and the refusal has to name
  // the one that actually applies.
  const because = declared
    ? "manifest declares limitMicroUsd but its dispatch witness"
    : "manifest declares no limitMicroUsd and the dispatch witness beside it";
  // ABSENCE is its own diagnosis and keeps its historical refusal: an ENOENT
  // from the read below says there is nothing there at all, not that a
  // statement has gone stale. Only a PRESENT witness reaches the checks.
  let bytes: Buffer;
  try {
    ({ bytes } = readArtifactBeneathRoot(witnessPath, runRoot));
  } catch (err) {
    throw new Error(
      `${because} ${witnessPath} is unreadable: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  // S28: FRESHNESS before CONTENT, on BOTH paths. This used to parse and
  // validate the body first, so a stale witness was diagnosed by whatever its
  // content happened to be — "carries no positive integer effectiveCeiling-
  // Micros" or a ceiling mismatch — when the truth is that it is a PREVIOUS
  // run's statement and speaks for nothing. Both paths reach here ordered
  // this way now (round 11 removed the witness-only fallback).
  const stale = witnessStaleBecause(manifestPath);
  if (stale !== null) {
    // The refusal stands (money-safe), but the operator needs the two facts
    // that make it actionable instead of a dead end: what the window IS, and
    // that the remedy is free — re-dispatching re-reserves and re-stamps the
    // witness moments before the box runs. The existing reservation is not
    // orphaned by this refusal: `sandbox-teardown` closes the run record, and
    // the ledger retires a closed run's reservation regardless of spend.
    throw new Error(
      `${because} ${witnessPath} is stale: ${stale}. This refuses rather than trust a previous run's ceiling statement (window: WITNESS_FRESH_WINDOW_MS = ±${Math.round(WITNESS_FRESH_WINDOW_MS / 60_000)}min in scripts/pipeline-run.ts). Re-dispatch to re-reserve and re-stamp the witness; the current reservation stays open only until teardown closes this run's record`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString("utf8"));
  } catch (err) {
    throw new Error(
      `${because} ${witnessPath} is unreadable: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  const admitted = (parsed as { effectiveCeilingMicros?: unknown } | null)?.effectiveCeilingMicros;
  if (!Number.isSafeInteger(admitted) || (admitted as number) <= 0) {
    throw new Error(`${because} ${witnessPath} carries no positive integer effectiveCeilingMicros`);
  }
  // A stale witness refuses on BOTH paths since round 11: there is nothing to
  // fall back to on the declared path (the manifest asserts a ceiling nothing
  // current vouches for), and the undeclared path's old harness-default
  // fallback admitted over reserved ceilings — see `runContextFrom`.
  return admitted as number;
}

/**
 * DF3.3: the resident's brief source — the SAME run-context.json the cap
 * reconciliation above reads as its witness (dirname of the resolved
 * manifest; dispatch's in-box brief carrier). Deliberately guarded: the cap
 * path has already refused a present-but-invalid witness, so a failure here
 * means "no resident", never a second run refusal (INV-RES-5).
 */
function readResidentBriefSource(
  manifestPath: string,
  runRoot: string,
): Record<string, unknown> | undefined {
  try {
    const { bytes } = readArtifactBeneathRoot(witnessPathBeside(manifestPath), runRoot);
    // Any parse/read failure means "no brief" — the AC4 non-error path.
    const parsed: unknown = JSON.parse(bytes.toString("utf8")); // dp:ok guarded by this try/catch (AC4 non-error path)
    return parsed !== null && typeof parsed === "object"
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch (err) {
    // ABSENT (ENOENT — dispatch shipped no brief) is AC4's quiet non-error
    // path. Every OTHER failure is an env fault wearing absent's clothes: say
    // so, or a permissions problem silently reads as a deliberately disabled
    // resident. The hardened reader wraps the raw errno in a ManifestError
    // `cause`, so the absence test walks that chain one level.
    const code = (e: unknown): string | undefined =>
      e instanceof Error && "cause" in e ? code(e.cause) : (e as NodeJS.ErrnoException | undefined)?.code;
    if (code(err) !== "ENOENT") {
      writeAll(
        2,
        `pipeline-run: warning: resident brief source ${witnessPathBeside(manifestPath)} is unreadable (${err instanceof Error ? err.message : String(err)}) — continuing without a resident\n`,
      );
    }
    return undefined;
  }
}

/**
 * DOD-Security / INV-RES-3: the brief's own credential refusal, at the
 * resident boundary. The manifest carries the same scan (manifest.ts INV-4),
 * but the witness/brief is a different carrier read by a different path, and
 * its content reaches a third party's prompt. Field names NEVER echo values.
 */
const RESIDENT_CREDENTIAL_FIELD = /(^|[-_])(api)?(key|token|secret|password|passwd|credential)s?([-_]|$)/i;
const RESIDENT_CREDENTIAL_VALUE = [
  /\bsk-[A-Za-z0-9_-]{8,}/i,
  /\bghp_[A-Za-z0-9]{8,}/i,
  /\bbearer\s+\S/i,
  /-----BEGIN [A-Z ]+/,
];

/** Nesting cap for the scan: two stack frames per level with no bound turned
 *  a pathological-but-small brief (~10⁴ nested arrays in 20 KB) into a bare
 *  RangeError — a refusal indistinguishable from a harness bug. 32 levels is
 *  far past any real dispatch brief. */
const RESIDENT_BRIEF_MAX_DEPTH = 32;

function assertNoResidentCredentials(brief: Record<string, unknown>, where = "brief", depth = 0): void {
  // The depth guard lives in the value walk below, not here: a guard at this
  // entry never fires for a PURE nested-array chain (arrays recurse through
  // assertNoResidentCredentialValue only), which was exactly the documented
  // ~10⁴-array RangeError case the cap exists to refuse cleanly.
  for (const [k, v] of Object.entries(brief)) {
    // Field-name checks stay scoped to meaningful object field names — an
    // array INDEX ("0", "1") is never a credential-shaped name.
    if (RESIDENT_CREDENTIAL_FIELD.test(k)) {
      throw new Error(`resident brief refused: credential-named field '${sanitizeForMessage(k)}' in ${where}`);
    }
    assertNoResidentCredentialValue(v, `${where}.${sanitizeForMessage(k)}`, depth);
  }
}

/** The value half of the scan, shared by object properties and array elements:
 *  a credential-shaped string refuses anywhere it appears, and objects nest.
 *  Arrays are traversed element-wise — `[\"sk-…\"]` must not slip past a
 *  properties-only walk.
 *
 *  The nesting guard lives HERE, charged once per container — array OR
 *  object — on entry, so RESIDENT_BRIEF_MAX_DEPTH counts real nesting levels.
 *  The earlier split charged the array branch and then the object branch
 *  again (~2 per level for alternating nesting, an effective cap of ~16
 *  against the documented 32) and, worse, never fired at all on a pure
 *  nested-array chain — see assertNoResidentCredentials. */
function assertNoResidentCredentialValue(v: unknown, where: string, depth: number): void {
  if (typeof v === "string" && RESIDENT_CREDENTIAL_VALUE.some((re) => re.test(v))) {
    throw new Error(`resident brief refused: credential-shaped value at ${where}`);
  }
  if (v === null || typeof v !== "object") return;
  const nested = depth + 1;
  if (nested > RESIDENT_BRIEF_MAX_DEPTH) {
    throw new Error(`resident brief refused: nesting deeper than ${RESIDENT_BRIEF_MAX_DEPTH} levels at ${where}`);
  }
  if (Array.isArray(v)) {
    v.forEach((el, i) => assertNoResidentCredentialValue(el, `${where}[${i}]`, nested));
    return;
  }
  assertNoResidentCredentials(v as Record<string, unknown>, where, nested);
}

/**
 * DF3.3: what makeBodyFactory needs at the gate-retry seam. `steering` is
 * undefined on the --no-resident / no-brief / failed-spawn legs — the gated
 * retry loop still runs identically there (identical journals are AC1a's
 * whole point); only the solicitation between authorization and attempt N+1
 * is skipped.
 */
interface ResidentHooks {
  steering?: SteeringController;
  runId: string;
  requestId: string;
  /** The resident's prompt context — accepted retry guidance is appended here,
   *  and its ONLY consumer is the resident's own subsequent solicitation
   *  prompts (steering.ts's renderPrompt): the guidance steers what the
   *  resident says next, never what the engine runs. The engine-authorized
   *  retry it followed re-executes the byte-identical command. */
  promptContext: string[];
  /** An accepted run_start select_roster pick, applied to the dispatch_task
   *  phase whose name matches the directive's `phase` (a pick for another
   *  phase is traced as skipped and left pending for its own phase). */
  rosterChoice: { pending?: { rosterId: string; phase: string } };
  /** DF1.5's closed id set — advertised ONLY on the run_start solicitation
   *  (AC2). Every other point omits it, so a select_roster there hits
   *  steering.ts's fail-closed empty-set rejection and is tripwire-recorded. */
  rosterIds: readonly string[];
  /** The manifest's DISPATCH_TASK phase names — the only phases a roster pick
   *  can ever apply to — wired into every SolicitCtx so steering.ts can
   *  validate a select_roster directive's `phase` against the closed set (the
   *  port-side check is S1-5's). Advertising every manifest phase name counted
   *  a pick naming a code phase as accepted yet structurally unconsumable
   *  (S3-2). */
  phaseIds: readonly string[];
  /** The armed slug — the resident_solicit line's `model` field (Observability
   *  Contract; D4's spend-per-model eval). */
  model: string;
}

/**
 * DF3.5's closed roster id set for THIS manifest (AC2 at the wiring level):
 * the role names of every roster its dispatch_task phases reference, resolved
 * exactly as dispatch_task resolves them (loadRoster anchored at the same run
 * root). The directive field is SPELLED `rosterId`, but a roster file carries
 * no roster-level identifier (roster/schema.ts's closed top level is exactly
 * `{defaults, roles}` — the file is named by its PATH, `spec.roster`), so the
 * pickable unit is a role NAME within a dispatch_task roster. No dispatch_task
 * phases — or a roster that will not load, which that phase will refuse with
 * the real error — leaves an EMPTY set: every select_roster is then rejected.
 * An agent can never widen its own choice surface by the manifest's silence.
 */
function closedRosterIds(phases: readonly PhaseSpec[], runRoot: string): string[] {
  const ids = new Set<string>();
  for (const spec of phases) {
    if (spec.kind !== "dispatch_task" || spec.roster === undefined) continue;
    try {
      for (const role of loadRoster(spec.roster, { cwd: runRoot }).roles) ids.add(role.name);
    } catch (err) {
      // A roster that will not load is an OPERATOR fault, but the effect is
      // "every select_roster rejected as gate_bypass_attempt" — an agent is
      // then blamed for a shut set they could not have widened. Say so here;
      // the dispatch_task phase still refuses with the real error later.
      writeAll(
        2,
        `pipeline-run: warning: roster '${sanitizeForMessage(spec.roster)}' for phase '${sanitizeForMessage(spec.name)}' did not load: ${err instanceof Error ? err.message : String(err)} — select_roster will reject everything\n`,
      );
    }
  }
  return [...ids];
}

/**
 * The resident's opening context: the run's own facts, the dispatch brief's
 * meaningful fields, and the manifest's essence. Values are sanitized —
 * witness-borne strings reach the resident's prompt the way manifest-borne
 * strings reach log messages (types.ts's one-shared-implementation rule); a
 * newline in a hand-forged witness value must not forge instruction lines.
 * Bounded by construction; steering.ts enforces the 16,000-char prompt
 * ceiling at render, head-truncated with the directive instruction reserved.
 */
function residentContextLines(
  runId: string,
  manifest: { pipelineId: string; phases: readonly PhaseSpec[] },
  brief: Record<string, unknown>,
): string[] {
  const lines = [
    `pipeline ${sanitizeForMessage(manifest.pipelineId)} run ${sanitizeForMessage(runId)}`,
  ];
  for (const key of ["requestId", "repoSlug", "issueId", "issueUrl", "effectiveCeilingMicros"]) {
    const v = brief[key];
    if (v !== undefined && v !== null && `${v}`.length > 0) {
      lines.push(`${key}: ${sanitizeForMessage(String(v))}`);
    }
  }
  lines.push(
    `phases: ${manifest.phases
      .map(
        (p) =>
          `${sanitizeForMessage(p.name)}(${sanitizeForMessage(p.kind)}${p.retries > 0 ? `,${p.retries}r` : ""})`,
      )
      .join(", ")}`,
  );
  return lines;
}

/**
 * The runner's SolicitCtx plus the run's closed DISPATCH_TASK phase-name set.
 * `phaseIds` rides every solicitation so steering.ts can fail-close a
 * select_roster whose `phase` names no dispatch_task phase (the port-side
 * validation is S1-5's; only dispatch_task phases ever consume a pick, so
 * those are the only names advertised — S3-2). Kept as an intersection so
 * this wiring stays excess-property-free even against a port build that
 * pre-dates the field.
 */
type RunnerSolicitCtx = SolicitCtx & { phaseIds?: readonly string[] };

/** DF3.3: one solicitation plus its observability line (Observability Contract). */
async function solicitResident(
  steering: SteeringController,
  point: SteeringPoint,
  ctx: RunnerSolicitCtx,
  model: string,
): Promise<SteeringDirective> {
  const started = performance.now();
  const directivesBefore = steering.telemetry.directives;
  // The solicitation and its observability line fail SEPARATELY: the port's
  // contract is never-throws, but if it ever does the deterministic default is
  // the only safe landing (INV-RES-5) — and a dead-stderr EPIPE must never
  // discard an already-parsed directive.
  let directive: SteeringDirective;
  try {
    directive = await steering.solicit(point, ctx);
  } catch (err) {
    // The port's never-throws contract failed, so the deterministic default
    // below is the only safe landing (INV-RES-5) — but any spend the attempt
    // accrued still sits in telemetry, and skipping the observability line
    // would leave that spend with no solicitation to account for. Emit the
    // line with accepted:false and the error before defaulting.
    try {
      writeAll(
        2,
        `${JSON.stringify({
          level: "warn",
          event: "resident_solicit",
          runId: ctx.runId,
          requestId: ctx.requestId ?? null,
          phase: ctx.phase ?? null,
          point,
          directiveAction: "proceed",
          model,
          accepted: false,
          // CUMULATIVE running total — see the success line below.
          spendMicros: steering.telemetry.spendMicros,
          durationMs: Math.round(performance.now() - started),
          error: sanitizeForMessage(err instanceof Error ? err.message : String(err)),
        })}\n`,
      );
    } catch {
      /* observability is a sidecar; the deterministic default is the payload */
    }
    return { action: "proceed" };
  }
  try {
    writeAll(
      2,
      `${JSON.stringify({
        level: "info",
        event: "resident_solicit",
        runId: ctx.runId,
        requestId: ctx.requestId ?? null,
        phase: ctx.phase ?? null,
        point,
        directiveAction: directive.action,
        // D4's month-1 spend-per-model eval keys on this slug.
        model,
        // Accepted := the accepted-directive COUNT moved — a schema-rejected
        // reply also changes telemetry, but it was never accepted.
        accepted: steering.telemetry.directives > directivesBefore,
        // CUMULATIVE running total of the run's steering spend (steering's
        // telemetry is a live accumulator), NOT this solicitation's delta:
        // consumers diff successive lines — summing them double-counts. The
        // field keeps its name; renaming it would break every existing
        // consumer (S3-6).
        spendMicros: steering.telemetry.spendMicros,
        durationMs: Math.round(performance.now() - started),
      })}\n`,
    );
  } catch {
    /* observability is a sidecar; the parsed directive is the payload */
  }
  return directive;
}

/**
 * DF1.8: the correlated dispatch-failure sink (AC4). Appends the refusal to
 * the host-side dispatch log, writes the structured stderr line, and returns
 * the exit code — the caller never continues, and no runId is ever fabricated
 * (INV-RUN-4). A failure to write the log is itself reported but never masks
 * the original refusal.
 */
function dispatchFail(
  markerRoot: string,
  ctx: { repoSlug: string | null; issueId: number | null; requestId: string | null },
  err: unknown,
): number {
  const rawCode = err instanceof Error ? (err as Error & { code?: unknown }).code : undefined;
  const code = typeof rawCode === "string" && rawCode.length > 0 ? rawCode : "RUN_INIT_FAILED";
  const message = err instanceof Error ? err.message : String(err);
  try {
    appendDispatchFailure(path.join(markerRoot, "dispatch-failures.log"), {
      // An unknown half of the pair is recorded as null — never ""/0, which
      // would read as a fabricated (empty) correlation.
      repoSlug: ctx.repoSlug,
      issueId: ctx.issueId,
      requestId: ctx.requestId,
      code,
      message,
    });
  } catch (logErr) {
    writeAll(
      2,
      `pipeline-run: dispatch-failure log unwritable: ${logErr instanceof Error ? logErr.message : String(logErr)}\n`,
    );
  }
  writeAll(
    2,
    `${JSON.stringify({
      level: "error",
      event: "dispatch_failed",
      runId: null,
      requestId: ctx.requestId,
      repoSlug: ctx.repoSlug,
      issueId: ctx.issueId,
      error: { code, message },
    })}\n`,
  );
  return 2;
}

function makeBodyFactory(
  cwd: string,
  tracer: Tracer,
  requestId: string,
  correlation?: { runId: string; repoSlug: string; issueId: number },
  journal?: PhaseJournal,
  resident?: ResidentHooks,
) {
  const makeBody = (spec: PhaseSpec): PhaseBody<unknown> => {
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
      // No blanket gate here: DF1.2 AC4 — a command's exit code is data, not a
      // phase verdict — so gates are composed by the caller that wants them
      // (gatedBody over this factory's bodies); the tracer then sees their
      // events through the journal port this run already decorates.
      // PF-2: the value is {exitCode, stdoutTail} — the bounded tail makes the
      // step's output queryable downstream without unseating fd 1's engine
      // ownership (the full stream still relays to stderr).
      const base: PhaseBody<unknown> = ({ signal }) => runCommand(cmd, signal, cwd, tracer, requestId);
      // DF3.3 closes the R2 gap: a code phase DECLARING a testCommand composes
      // DF1.2's commandGate over the body via gatedBody, under DF1.3's retry
      // discipline — attempt N+1 is authorized by the retries bound alone, and
      // the resident's post-gate-failure solicitation sits strictly AFTER that
      // authorization (the directive supplies guidance text, never the retry
      // decision). No journal (a caller that wanted no gates) = no composition.
      const test = spec.testCommand ?? [];
      if (test.length === 0 || journal === undefined) {
        return base;
      }
      const gate = commandGate([...test], { cwd, env: childEnv(), label: `testCommand:${spec.name}` });
      // The loop body's try/catch IS the retry contract — GateFailureError
      // within the retries bound continues, everything else propagates; the only
      // awaits outside it are solicitResident (never throws, see its dp:ok).
      const gated: PhaseBody<unknown> = async (bodyCtx) => { // dp:ok loop-level try/catch is the DF1.3 retry contract; other awaits never throw
        for (let attempt = 1; ; attempt += 1) {
          try {
            return await gatedBody(
              journal,
              { runRoot: cwd, signal: bodyCtx.signal },
              [gate],
              { attempt },
            )(base)(bodyCtx);
          } catch (err) {
            // An aborted body belongs to a TERMINATED run: run.terminate has
            // flipped the engine's halted state and aborted this signal (the
            // terminal marker itself is written only by Run.finish, at the end
            // of the unwind this throw feeds), so no post-termination zombie
            // may re-run the command, re-solicit the resident, or write
            // journal rows past the abort.
            if (bodyCtx.signal.aborted) throw err;
            if (!(err instanceof GateFailureError) || attempt > spec.retries) throw err;
            // DF1.3 authorized attempt N+1 (the branch at
            // src/phase-engine/agents/retry.ts:284-287, re-spelled here for
            // code phases). KNOWN DRIFT from DF1.3, deliberate and fail-closed:
            // retry.ts's loop gets a FRESH per-attempt maxDurationMs timer
            // (phase.ts:245-251 arms one per runAgentPhase invocation), while
            // every attempt of this loop — command + gate + each solicitation —
            // shares the ONE phase timer. A slow attempt can therefore overflow
            // a retry DF1.3 would have granted its own budget; the run can
            // never exceed the manifest's per-phase ceiling, and the admitted
            // budget reservation ((retries+1) × … × maxDurationMs,
            // manifest.ts:606) is the looser outer bound.
            // DF3.3 solicitation point 2 of 3: AFTER the verdict AND after
            // the authorization.
            if (resident?.steering === undefined) continue;
            const directive = await solicitResident(resident.steering, "post_gate_failure", {
              runId: resident.runId,
              requestId: resident.requestId,
              phase: spec.name,
              // rosterIds deliberately ABSENT: select_roster is run_start-only,
              // so a roster pick here hits steering.ts's fail-closed empty-set
              // rejection (tripwire-recorded) instead of being silently dropped.
              phaseIds: resident.phaseIds,
              promptContext: resident.promptContext,
            }, resident.model);
            // The solicitation is an await: a signal landing mid-solicit
            // aborts bodyCtx.signal UNDER us (run.terminate), the stopped
            // resident degrades the reply to a resolved PROCEED, and
            // runCommand's exit path RESOLVES on a kill ({exitCode: 128}) —
            // without this re-check the loop would respawn the command on an
            // already-terminated run and the gate would write a phantom
            // gate_fail row for attempt N+1. Unwind through the same path as
            // the catch-entry guard above; nothing is journaled on it.
            if (bodyCtx.signal.aborted) throw err;
            if (directive.action === "abort") {
              // The engine's own fail transition: the authorized retry is
              // declined and the caught GateFailureError settles the phase.
              // The agent's reason is a run fact — a trace row records it
              // before the rethrow (DF1.4's closed event union is untouched;
              // residentTripwire's precedent).
              try {
                tracer.trace({
                  type: "log",
                  name: "resident_directive",
                  requestId: resident.requestId,
                  phaseId: bodyCtx.phaseId,
                  payloadJson: JSON.stringify({
                    runId: resident.runId,
                    phase: spec.name,
                    action: "abort",
                    reason: directive.reason,
                    attempt: attempt + 1,
                  }),
                });
              } catch {
                /* the trace store is a sidecar; the phase verdict owns the run */
              }
              throw err;
            }
            if (directive.action === "retry") {
              resident.promptContext.push(
                `resident guidance for ${spec.name} (attempt ${attempt + 1}): ${sanitizeForMessage(directive.guidance)}`,
              );
              // Directive rows ride type:"log" + a name, NOT writeGateEvent:
              // the bridge maps every gate event to a gate_results row, so a
              // directive there fabricated a passed=0 verdict and an event
              // type outside DF1.4's closed TraceEventType union.
              try {
                tracer.trace({
                  type: "log",
                  name: "resident_directive",
                  requestId: resident.requestId,
                  phaseId: bodyCtx.phaseId,
                  payloadJson: JSON.stringify({
                    runId: resident.runId,
                    phase: spec.name,
                    action: "retry",
                    guidance: directive.guidance,
                    attempt: attempt + 1,
                  }),
                });
              } catch {
                /* the trace store is a sidecar; the retry itself is the effect */
              }
            }
            // proceed (the deterministic default): the engine-authorized
            // retry runs unguided.
          }
        }
      };
      return gated;
    }
    // DF1.6 T7: dispatch_task registration — the factory closes over the
    // run's tracer + requestId so prompt events (pre-spawn) and adapted team
    // events land in the trace store (DD-8, Observability Contract). rootDir
    // pins artifact reads to the SAME --run-root the code phases use.
    if (spec.kind === "dispatch_task") {
      const body = dispatchTask(spec, { tracer, requestId, rootDir: cwd });
      // DF3.3: an accepted run_start select_roster pick applies to the
      // dispatch_task phase the directive NAMED (`directive.phase` —
      // validated against the run's closed DISPATCH_TASK phase set by
      // steering.ts, S3-2), never blindly to the next one: closedRosterIds
      // unions role names across ALL dispatch_task rosters, so a pick naming
      // a role from phase 2's roster must not "apply" to phase 1 running a
      // different roster.
      // A mismatching phase leaves the pick pending for its own phase and
      // traces the skip. DRIFT (SOURCE-vs-spec): dispatchTask (DF1.6) exposes
      // no roster override on its deps, so the application here is the
      // recorded pick on the trace — the spawn-side switch lands when DF1.6
      // grows that surface. Ids outside DF1.5's closed set were already
      // rejected in steering.ts before this ran.
      if (resident === undefined) return body;
      const hooks = resident;
      return async (bodyCtx) => {
        const choice = hooks.rosterChoice.pending;
        if (choice !== undefined) {
          if (choice.phase === spec.name) {
            hooks.rosterChoice.pending = undefined;
            try {
              tracer.trace({
                type: "log",
                name: "residentRosterChoice",
                requestId,
                // The engine's phaseId domain, matching phase_state and the
                // resident_directive rows — never the manifest name, which
                // rides the payload's own `phase` field.
                phaseId: bodyCtx.phaseId,
                payloadJson: JSON.stringify({ runId: hooks.runId, rosterId: choice.rosterId, phase: spec.name, applied: true }),
              });
            } catch {
              /* the trace store is a sidecar; the run owns the verdict */
            }
          } else {
            try {
              tracer.trace({
                type: "log",
                name: "residentRosterChoice",
                requestId,
                phaseId: bodyCtx.phaseId,
                payloadJson: JSON.stringify({
                  runId: hooks.runId,
                  rosterId: choice.rosterId,
                  phase: spec.name,
                  applied: false,
                  reason: `pick names phase '${choice.phase}', not this phase — left pending`,
                }),
              });
            } catch {
              /* the trace store is a sidecar; the run owns the verdict */
            }
          }
        }
        return body(bodyCtx);
      };
    }
    return () => {
      throw new Error(
        `phase '${sanitizeForMessage(spec.name)}': no executor is registered for kind '${spec.kind}' (DF1.6 lands the tier-3 spawn seam)`,
      );
    };
  };
  if (!correlation) return makeBody;
  // DF1.8: correlated runs also emit phase_state transitions (Observability
  // Contract; the p1-8:34 surviving field set). The wrapper is observability
  // only — the wrapped body's result/error passes through untouched, and a
  // trace failure never fails the phase (tracer.trace is non-throwing by AC5;
  // the guard is the same defense-in-depth as runCommand's).
  return (spec: PhaseSpec): PhaseBody<unknown> => {
    const inner = makeBody(spec);
    return async (bodyCtx) => {
      const state = (
        phaseId: string,
        status: "start" | "end",
        durationMs: number,
        exitStatus: ExitStatus | null,
      ) => {
        try {
          tracer.trace({
            type: "log",
            name: "phase_state",
            requestId,
            phaseId,
            payloadJson: JSON.stringify({
              runId: correlation.runId,
              repoSlug: correlation.repoSlug,
              issueId: correlation.issueId,
              requestId,
              phase: spec.name,
              status,
              timestamp: new Date().toISOString(),
              durationMs,
              exitStatus,
            }),
          });
        } catch {
          /* observability is a sidecar; the phase owns the run's verdict */
        }
      };
      state(bodyCtx.phaseId, "start", 0, null);
      const startedAt = performance.now();
      let settled: unknown;
      try {
        settled = await inner(bodyCtx);
        return settled;
      } catch (err) {
        settled = err;
        throw err;
      } finally {
        // The settled value's exitStatus when it carries one (an envelope or
        // report), else null — absent (no outcome) never reads as a verdict.
        const exitStatus =
          settled && typeof settled === "object" && "exitStatus" in settled
            ? ((settled as { exitStatus?: ExitStatus }).exitStatus ?? null)
            : null;
        state(bodyCtx.phaseId, "end", Math.round(performance.now() - startedAt), exitStatus);
      }
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
  // DF1.8: the correlation brief as it arrives on the flags — validated (and
  // possibly refused) only once the pair is together, never defaulted.
  let repoSlug: string | undefined;
  let issue: string | undefined;
  let issueUrl: string | undefined;
  let runIdGiven = false;

  // DF3.3: --no-resident is a BOOLEAN flag. tokenizeArgs owns that grammar,
  // parseValueFlags owns the value-flag one — the split is lib/cli-args.ts's
  // own design (its tokenize spec carries the boolFlags channel).
  const { flagTokens, bools } = tokenizeArgs(argv, {
    valueFlags: VALUE_FLAGS,
    boolFlags: ["--no-resident"],
  });
  const noResident = bools.has("--no-resident");

  parseValueFlags(flagTokens, {
    flags: [...VALUE_FLAGS],
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
          runIdGiven = true;
          break;
        case "--repo-slug":
          repoSlug = value;
          break;
        case "--issue":
          issue = value;
          break;
        case "--issue-url":
          issueUrl = value;
          break;
        case "--request-id":
          requestId = value;
          break;
        // F057: `default` used to BE the --request-id case. Nine flags were
        // declared and eight had a case, so the tenth flag anyone added landed
        // on `requestId` — silently overwriting the correlation key the whole
        // DF1.8 ladder joins on, with no failure to notice. The list above and
        // the cases must agree; this is what says so out loud.
        default:
          throw new Error(`unhandled flag ${flag}`);
      }
    },
  });

  if (!manifestPath) throw new Error("--manifest is required");
  if (budgetMs === undefined) throw new Error("--budget-ms is required");
  if (!journalPath) throw new Error("--journal is required");

  const { manifest, manifestLoadMs, resolvedPath } = loadManifest(manifestPath, budgetMs, runRoot);

  // DF1.8: the marker root is derived before anything can refuse — a
  // correlation failure can precede the trace claim entirely, and its dispatch
  // log still needs a home (AC4: the log outlives a trace store that could not
  // even open).
  const markerRoot = runMarkerRoot();

  // DF1.8: correlated mode. Any of the three correlation flags opts in; the
  // (repoSlug, issueId) pair must arrive whole (issue identity is never
  // defaulted, AC2) and --run-id must not ride along (the resolved requestId
  // is the run's one identifier). Every refusal below is a dispatch failure —
  // logged host-side, reported on stderr with runId: null, exit 2 — all
  // before any session row, box or key exists.
  const correlated = repoSlug !== undefined || issue !== undefined || issueUrl !== undefined;
  let resolved: ResolvedRunCorrelation | undefined;
  let correlationResolveMs = 0;
  if (correlated) {
    try {
      if (repoSlug === undefined || issue === undefined) {
        throw new CorrelationError(
          "CORRELATION_PAIR_REQUIRED",
          "--repo-slug and --issue must arrive together: issue identity is (repoSlug, issueId), never defaulted",
        );
      }
      if (runIdGiven) {
        throw new CorrelationError(
          "RUN_ID_CONFLICT",
          "--run-id cannot be combined with --repo-slug: a correlated run is identified by its resolved requestId alone",
        );
      }
      // Strict integer parse (the parseTimeoutMs pattern): decimal digits
      // only, then 1..2^31-1 — resolveRunCorrelation re-validates the bounds.
      if (!/^\d+$/.test(issue)) {
        throw new CorrelationError("INVALID_ISSUE_ID", `--issue must be a positive integer, got ${issue}`);
      }
      const issueId = Number(issue);
      if (!Number.isInteger(issueId) || issueId < 1 || issueId > MAX_ISSUE_ID) {
        throw new CorrelationError("INVALID_ISSUE_ID", `--issue must be in 1..${MAX_ISSUE_ID}, got ${issue}`);
      }
      const resolveStart = performance.now();
      resolved = resolveRunCorrelation({
        repoSlug,
        issueId,
        ...(issueUrl !== undefined ? { issueUrl } : {}),
        requestId,
      });
      correlationResolveMs = Math.round(performance.now() - resolveStart);
      // One identifier: the run's id IS the resolved requestId, never a second.
      runId = requestId = resolved.requestId;
    } catch (err) {
      return dispatchFail(
        markerRoot,
        {
          repoSlug: repoSlug ?? null,
          // Digits alone are not a settled id: --issue 0 parses as 0, and a
          // fabricated 0 would read as a real correlation (INV-RUN-4). Only an
          // in-bounds value the ladder itself would have accepted is echoed —
          // both bounds, so an over-MAX_ISSUE_ID value logs null too.
          issueId:
            issue !== undefined &&
            /^\d+$/.test(issue) &&
            Number(issue) >= 1 &&
            Number(issue) <= MAX_ISSUE_ID
              ? Number(issue)
              : null,
          requestId: null, // resolve threw: nothing was settled (INV-RUN-4)
        },
        err,
      );
    }
  }

  // DF1.8: in correlated mode every initiation step below the session row is
  // ladder-shaped — a refusal lands in the dispatch log with runId: null and
  // exits 2 (AC4). Bare mode keeps DF1.4's plain throws, unchanged.
  // `undefined` until the Tracer constructor succeeds: the catch below must
  // be able to tell "never opened" from "opened, then a ladder step threw"
  // (e.g. a RequestIdRepoMismatch from initiateSession) and close only the
  // latter. Every catch path exits, so past this statement the type is
  // definitely Tracer again.
  let tracer: Tracer | undefined;
  try {
    // DF1.4: Claim trace data dir under marker root (QDS_RUN_ROOT) with 0700
    // Default marker root is /run when QDS_RUN_ROOT not set
    const traceDir = path.join(markerRoot, "trace");
    fs.mkdirSync(traceDir, { recursive: true, mode: 0o700 });
    fs.chmodSync(traceDir, 0o700);
    const dirMode = fs.statSync(traceDir).mode & 0o777;
    if (dirMode !== 0o700) {
      throw new Error(`trace dir is mode 0o${dirMode.toString(8)}, not 0700`);
    }

    // DF1.4: Open Tracer (applies schema+migrations at construction).
    // AC5: per-write SQLite failures are reported through this sink and never break
    // the run; open-time integrity failures (boundary violation, dir/db file mode,
    // WAL refusal, migration failure) throw from the constructor and are fatal by
    // design (INV-1 hard open refusal, INV-5 fail-closed). Structured record to
    // stderr, run context included, never throws (a broken sink must not fail the
    // run either).
    tracer = new Tracer({
      dataDir: traceDir,
      requestId,
      pipelineName: manifest.pipelineId,
      onTraceError: (err) => {
        writeAll(
          2,
          `${JSON.stringify({
            level: "error",
            event: "trace_store_error",
            requestId,
            runId,
            pipelineId: manifest.pipelineId,
            code: err.code,
            message: err.message,
            // Shared field names/defaults come from serializeTraceError so
            // this sink cannot drift from journal-bridge's stderr sink.
            ...serializeTraceError(err),
          })}\n`,
        );
      },
    });

    if (resolved) {
      // DF1.8: initiateSession is the initiation gate — unlike every tracer
      // write it throws by design (a RequestIdRepoMismatch must stop the run
      // before a box or key is minted), so it sits in the ladder and replaces
      // DF1.4's startSession for correlated runs.
      const sessionStart = performance.now();
      const initiated = tracer.initiateSession({
        correlation: resolved,
        request: manifest.pipelineId,
        pipelineName: manifest.pipelineId,
      });
      const sessionUpsertMs = Math.round(performance.now() - sessionStart);
      // The dispatcher reads the run back from this line; sub-timings are
      // whole-ms (Observability Contract: absent a breakdown, report 0).
      writeAll(
        2,
        `${JSON.stringify({
          level: "info",
          event: "run_initiated",
          runId,
          requestId,
          repoSlug: resolved.repoSlug,
          issueId: resolved.issueId,
          replayed: initiated.replayed,
          correlation_resolve_ms: correlationResolveMs,
          session_upsert_ms: sessionUpsertMs,
        })}\n`,
      );
      if (initiated.replayed) {
        // INV-RUN-1 (first-close-wins): the run already exists, so a replay
        // acks the existing runId and MUST NOT walk the phases again — the
        // upserts and finishSession below would rewrite the historical record
        // the first run closed (INV-RUN-2 append-only). Nothing to settle, so
        // close the store and exit 0. Guarded like every other close: a
        // failing checkpoint must not turn an acked replay into exit 2.
        try {
          tracer.close();
        } catch {
          /* the replay ack is already on stderr; no run was settled here */
        }
        return 0;
      }
    }
  } catch (err) {
    if (!resolved) throw err;
    // The failure may postdate the Tracer's construction (initiateSession
    // sits inside this try): close before the exit so an open WAL store is
    // not leaked across dispatchFail. Guarded — a failing checkpoint must
    // not mask the initiation error the ladder is about to record.
    try {
      tracer?.close();
    } catch {
      /* the initiation error outranks a close failure */
    }
    return dispatchFail(
      markerRoot,
      { repoSlug: resolved.repoSlug, issueId: resolved.issueId, requestId: resolved.requestId },
      err,
    );
  }

  // DF1.4: Wrap FileJournal with TracingJournal
  const innerJournal = new FileJournal(journalPath, runId);
  // The witness is looked for beside the manifest we actually READ — the
  // verified realpath, not the argv string, so a symlinked `--manifest` cannot
  // point the cap check at a different directory's run-context.json.
  //
  // A THROW, not `?? manifestPath`. `resolvedPath` is optional on
  // `LoadedManifest` (`stampManifestLimit` and `stripAuthoredLimit` both drop
  // it deliberately — their bytes match no file), so the fallback was live type
  // surface, and it substituted the argv string for the verified path: the
  // exact redirect the paragraph above forbids. `loadManifest` always sets it,
  // so this cannot fire today; it fires the day someone routes `main` through
  // one of the deriving helpers, which is when the silent re-enable would
  // otherwise happen.
  //
  // Inside a guarded region because the Tracer is already open by here: a
  // refusal from `runContextFrom` (missing witness, mismatched ceiling) used to
  // escape to the top-level catch, which writes stderr and exits — leaking an
  // open SQLite/WAL handle and, worse, an unfinished session row that makes a
  // later `initiateSession` throw RequestIdRepoMismatch for that requestId.
  let ctx: RunContext;
  try {
    if (resolvedPath === undefined) {
      throw new Error("manifest was derived in memory and has no verified path to anchor the cap witness to");
    }
    ctx = runContextFrom(runId, requestId, manifest, { manifestPath: resolvedPath, runRoot });
  } catch (err) {
    try {
      tracer.close();
    } catch {
      /* the cap-reconciliation refusal outranks a close failure */
    }
    // `innerJournal` deliberately gets NO symmetric close here: FileJournal
    // holds no descriptor between calls — every flush opens, fsyncs, renames,
    // closes — so there is no handle to leak on this exit (the tracer's WAL
    // handle above is the one that needs releasing). Its constructor's header
    // flush stays on disk showing ok:false and no phases, which is the true
    // state: a run that never started. Unlinking it from this catch cannot
    // prove the file still belongs to THIS invocation (a concurrent writer on
    // the same --journal path may have already replaced it), so the honest
    // residue is the header itself.
    throw err;
  }
  const journal = new TracingJournal(innerJournal, tracer, ctx);

  const run = new Run({
    ctx,
    journal,
    manifestLoadMs,
  });

  // DF1.4: Start session at run start — bare mode only; a correlated run
  // initiated its session through the DF1.8 ladder above instead.
  if (!resolved) {
    tracer.startSession({ requestId, request: manifest.pipelineId });
  }

  // Declared BEFORE the signal handlers so they can stop it: the resident is
  // an owned subprocess, and neither signal exit may orphan an in-flight pi
  // call past this process's own death.
  let residentSpawn: ResidentSpawn | undefined;
  // A signal becomes a terminating exception so the run closes and its rows
  // settle, rather than leaving the journal claiming work that is already dead.
  let terminated = false;
  // Flipped once Run.finish settles the run. Past that point run.terminate has
  // no phase body left to abort (`Run.current` is gone and the exit code is
  // already computed), and the only long await left in main is the run-end
  // solicitation's in-flight pi call — reachable ONLY through
  // residentSpawn.stop(). Without this branch, a first signal during that
  // solicitation waits out the pi timeout (or a second Ctrl-C) before the
  // owned subprocess dies.
  let runSettled = false;
  // finish's exit code, captured beside runSettled so a second signal in the
  // post-settlement window can leave with it: the terminal marker is already
  // on disk, and exiting 2 would tell a poller "never settled" over a settled
  // journal.
  let settledExitCode: number | undefined;
  const onSignal = async (sig: string): Promise<void> => {
    if (terminated) {
      // The handlers removed the default disposition, so a second Ctrl-C must
      // not be swallowed while a body sits out its cancellation grace.
      writeAll(2, `pipeline-run: ${sig} again — exiting immediately\n`);
      // 2, not 1, PRE-settlement: the run never reached `finish`, so no marker
      // was written and the exit code must not claim the run settled.
      // Post-settlement the marker IS on disk, so finish's own code leaves
      // instead (defaulting to 1, never 2's "never settled").
      // DF1.4: Close tracer before exit. Optional chaining because this
      // closure captures the `Tracer | undefined` declaration above (it is
      // always assigned by the time the handler is registered).
      try {
        tracer?.processesEndAll(requestId);
        tracer?.close();
      } catch {
        /* ignore */
      }
      // The owned resident dies with the run: stop() SIGKILLs the in-flight
      // call (if any) and awaits its exit, so no pi child outlives process.exit.
      try {
        await residentSpawn?.stop();
      } catch {
        /* the exit outranks teardown noise */
      }
      process.exit(runSettled ? (settledExitCode ?? 1) : 2);
    }
    terminated = true;
    if (runSettled) {
      // Post-finish signal: kill the owned resident NOW so the hung run-end
      // call unwinds. solicitResident's never-throws contract lands the kill
      // as a degraded PROCEED, and the normal cleanup path below takes over
      // (exitStatus, the idempotent re-stop, the resident block refresh, the
      // tracer close). run.terminate is skipped deliberately — the run is
      // settled, so there is no abort target and no verdict left to flip.
      try {
        await residentSpawn?.stop();
      } catch {
        /* the normal cleanup path's own stop attempt outranks teardown noise */
      }
      return;
    }
    // run.terminate only FLIPS engine state (no awaits, no I/O), but the
    // handler is `void`-ed at registration, so a throw here would be an
    // unhandled rejection inside a signal handler — guard it regardless.
    try {
      run.terminate(sig);
    } catch {
      /* the terminating flag above is already set; the run unwinds halted */
    }
    // The resident is an owned subprocess at EVERY hook point, not just
    // post-finish: a first signal during the run_start or a post_gate_failure
    // solicitation must kill the in-flight pi call too, or the process waits
    // out the pi timeout despite the kill request. stop() is a one-way latch,
    // so any solicitation after this degrades to PROCEED (INV-RES-5).
    try {
      await residentSpawn?.stop();
    } catch {
      /* the run's own termination path outranks resident teardown noise */
    }
  };
  process.on("SIGTERM", (sig) => void onSignal(sig));
  process.on("SIGINT", (sig) => void onSignal(sig));

  // DF3.3: the resident orchestrator. Source = the run-context.json witness
  // beside the resolved manifest (dispatch's in-box brief carrier): a NON-EMPTY
  // brief there AND no --no-resident arms the resident — arming reads the
  // brief's CONTENT (rendered into the prompt context below), not a requestId
  // alone; anything else leaves status "disabled" and a fully deterministic
  // run (AC4). A RateError out of startResident REFUSES the run before spawn
  // (DF1.5's rule, as that docstring pins) — with the tracer closed, exactly
  // like the cap-reconciliation refusal above.
  const residentBrief =
    !noResident && resolvedPath !== undefined
      ? readResidentBriefSource(resolvedPath, runRoot)
      : undefined;
  // Arming reads BRIEF content — any of the dispatch brief's identity fields —
  // never requestId alone. `effectiveCeilingMicros` is deliberately excluded:
  // it is the CAP witness's own field, present on every capped run, and must
  // not conjure a resident out of a ceiling statement.
  const residentArmed =
    residentBrief !== undefined &&
    ["requestId", "repoSlug", "issueId", "issueUrl"].some((key) => {
      const v = residentBrief?.[key];
      return v !== undefined && v !== null && `${v}`.length > 0;
    });
  // DOD-Security / INV-RES-3: a brief whose values or field names match a
  // credential shape refuses the run BEFORE any spawn — a manifest is already
  // scanned for exactly this (manifest.ts's INV-4 walk), and the brief reaches
  // a THIRD party's prompt, which is worse. The refusal names the field, never
  // the value. Fail-safe: the scan runs on any brief this run actually READS
  // (--no-resident never reads one, so there is nothing to scan), armed or
  // not — gating the refusal on arming let a poisoned brief slide
  // through exactly the run where nobody was listening. Guarded like the
  // cap-reconciliation refusal: the tracer's session is already open, so
  // throwing without the close leaks the WAL handle and leaves an unfinished
  // session row that breaks a later initiateSession for this requestId.
  if (residentBrief !== undefined) {
    try {
      assertNoResidentCredentials(residentBrief);
    } catch (err) {
      try {
        tracer.close();
      } catch {
        /* the arming refusal outranks a close failure */
      }
      throw err;
    }
  }
  const residentPromptContext: string[] = residentContextLines(
    runId,
    manifest,
    residentBrief ?? {},
  );
  // The closed set steering.ts validates a select_roster directive's `phase`
  // against — DISPATCH_TASK names only: a code/engineer/agent phase can never
  // consume a pick, so advertising its name counted an impossible pick as
  // accepted and left it pending until the never-consumed trace (S3-2).
  const dispatchPhaseNames = manifest.phases
    .filter((p) => p.kind === "dispatch_task")
    .map((p) => p.name);
  // S3-7: the manifest schema has no dup-name check, and duplicate
  // dispatch_task phase names make roster-pick routing first-match AMBIGUOUS
  // (the runner applies a pick to the FIRST phase of that name). Fail-safe in
  // INV-RES-5's direction: refuse to arm ROSTER steering — the advertised id
  // and phase sets below go EMPTY, so every select_roster hits steering.ts's
  // fail-closed rejection — while the resident still arms for retry/abort
  // guidance. The cause lands on stderr next to the arming step.
  const duplicateDispatchPhaseNames = [
    ...new Set(dispatchPhaseNames.filter((n, i) => dispatchPhaseNames.indexOf(n) !== i)),
  ];
  const rosterSteeringEnabled = duplicateDispatchPhaseNames.length === 0;
  // DF1.5's closed id set for select_roster, computed ONCE and advertised only
  // on the run_start solicitation (AC2 at the wiring level; steering.ts
  // rejects outside it — an absent set elsewhere is the fail-closed empty set).
  const rosterIds = rosterSteeringEnabled ? closedRosterIds(manifest.phases, runRoot) : [];
  const phaseIds = rosterSteeringEnabled ? dispatchPhaseNames : [];
  const rosterChoice: { pending?: { rosterId: string; phase: string } } = {};
  // The slug startResident arms with (main passes no override). The
  // resident_solicit observability line carries it as `model` — D4's
  // month-1 spend-per-model eval keys on it.
  const residentModel = DEFAULT_RESIDENT_SLUG;
  if (residentArmed && !rosterSteeringEnabled) {
    // The S3-7 refusal is visible, not silent — same sidecar discipline as the
    // RateError path below: the run proceeds deterministically for everything
    // except roster picks, and the operator gets the offending names (never
    // roster content) to fix the manifest.
    writeAll(
      2,
      `${JSON.stringify({
        level: "error",
        event: "resident_roster_steering_disabled",
        runId,
        requestId,
        model: residentModel,
        reason: "duplicate_dispatch_phase_names",
        detail: `duplicate dispatch_task phase names make roster-pick routing first-match ambiguous: ${duplicateDispatchPhaseNames.map((n) => sanitizeForMessage(n)).join(", ")}`,
      })}\n`,
    );
  }
  let steering: SteeringController | undefined;
  if (residentArmed && residentBrief !== undefined) {
    let spawned: ReturnType<typeof startResident> | undefined;
    try {
      spawned = startResident({
        brief: residentBrief,
        runId,
        sessionDir: path.dirname(path.resolve(journalPath)),
        // §5.2 / DOD-Security: every prompt and raw reply persists
        // PRE-EXECUTION, redacted, beside the journal.
        persistDir: path.dirname(path.resolve(journalPath)),
      });
    } catch (err) {
      if (!(err instanceof RateError)) {
        try {
          tracer.close();
        } catch {
          /* the arming refusal outranks a close failure */
        }
        throw err;
      }
      // Spec (Infra Prerequisites): a slug with no resolvable rate refuses
      // the RESIDENT, never the run — INV-RES-5 degrades toward
      // determinism. steering is never constructed, so the journal's
      // resident block stays the explicit "disabled" shape, and the run
      // proceeds deterministically with the cause on stderr.
      // startResident's own throw contract is unchanged; this is the
      // runner's arming policy.
      writeAll(
        2,
        `${JSON.stringify({
          level: "warn",
          event: "resident_disabled",
          runId,
          requestId,
          model: residentModel,
          reason: "rate_unresolved",
          detail: err.message,
        })}\n`,
      );
    }
    if (spawned !== undefined && !("disabled" in spawned)) {
      residentSpawn = spawned;
      steering = createSteering({
        caller: spawned.caller,
        rate: spawned.rate,
        // DF3.4 AC6: `fleet attach`'s queued messages are folded into the next
        // of DF3.3's three solicitation points. The engine addresses the in-box
        // steering paths as local paths, exactly as journal.ts addresses
        // runMarkerPath() — so no driver reference is needed here (and none is
        // in scope: this runner has no vm).
        // ownRunId: only THIS run's queued messages fold as its intent — a
        // line addressed to another run sharing the host inbox is counted and
        // skipped, never consumed here (round 7 finding 20).
        //
        // ID-SPACE GUARD (round-9 B11): the filter is only sound when `runId`
        // names the SAME id-space the `fleet attach` lines are stamped with —
        // the minted fleet ids (`qds-…`). This runner's default `--run-id` is
        // a bare uuid (and a correlated run's resolved requestId is one too),
        // and against that value the filter starves EVERY real line: each
        // carries a fleet id, nothing ever matches, and the resident silently
        // never folds its guidance. Fail-safe toward DELIVERY: a run id that
        // is not in the fleet shape disables the filter (all lines are treated
        // as this run's own) and says so once on stderr — the id-space
        // mismatch is the operator's fact to fix (pass the same `--run-id` the
        // attach targets), not a message to swallow.
        inbox: localSteeringInbox(
          MINTED_FLEET_RUN_ID_RE.test(runId)
            ? { ownRunId: runId }
            : (() => {
                writeAll(
                  2,
                  `${JSON.stringify({
                    level: "warn",
                    event: "steering_ownrun_filter_disabled",
                    runId,
                    requestId,
                    reason: "id_space_mismatch",
                    detail: `this run id (${sanitizeForMessage(runId)}) is not a fleet run id, so inbox lines stamped with fleet ids would all be filtered out as foreign — the own-run filter is DISABLED and every queued line is treated as this run's; run with the same --run-id the \`fleet attach\` targeted to scope the inbox`,
                  })}\n`,
                );
                return {};
              })(),
        ),
        // An unreadable steering channel is an operational fault the operator
        // has to be able to see: `fleet attach` keeps reporting the message
        // "stays queued" while no later drain will ever deliver it. Same sink
        // and same sidecar guard as the tripwire below.
        onInboxError: (e) => {
          try {
            tracer.trace({
              type: "log",
              name: "steeringInboxError",
              requestId,
              // The channel's fault PAYLOAD, never the container object: a bare
              // `JSON.stringify(error)` renders `{}` (message/stack are
              // non-enumerable own properties) and the trace row would record
              // THAT something happened and nothing about what. `e.detail` is
              // the sanitized fault text steering already built for the
              // operator; `runId`/`requestId` are the join keys.
              payloadJson: JSON.stringify({ runId: e.runId, requestId: e.requestId, detail: e.detail }),
            });
          } catch {
            /* the trace store is a sidecar; the journal row is the record */
          }
        },
        onTripwire: (t) => {
          // Tripwires ride type:"log" + a name — DF1.4's closed event union
          // is untouched (R2 §4.1's recommendation, phase_state's precedent).
          try {
            tracer.trace({
              type: "log",
              name: "residentTripwire",
              requestId,
              payloadJson: JSON.stringify(t),
            });
          } catch {
            /* the trace store is a sidecar; the journal row is the record */
          }
        },
      });
    }
  }

  // The resident telemetry snapshot: steering's live counts on resident legs,
  // the explicit "disabled" shape otherwise (AC4/AC5 — status is never absent
  // on a settled run). Seeded BEFORE the walk, refreshed once right after
  // run.finish (the terminal marker makes the journal readable as settled, so
  // the seed's zeros must not cover the run_end window — S3-3), and refreshed
  // a final time in the finally after the resident is stopped.
  const residentTelemetryOf = (): ResidentTelemetry =>
    steering === undefined
      ? {
          status: "disabled",
          directives: 0,
          directivesRejected: 0,
          steeringIterations: {},
          spendMicros: 0,
          exitStatus: null,
          tripwires: [],
        }
      : // Snapshot, not shallow copy: a seeded journal block must not keep
        // aliasing steering's live tripwires/steeringIterations and mutate
        // when the run_end solicitation appends after it.
        {
          ...steering.telemetry,
          steeringIterations: { ...steering.telemetry.steeringIterations },
          tripwires: steering.telemetry.tripwires.map((t) => ({ ...t })),
        };

  // One guarded writer for the DF3.3 directive rows (the residentTripwire
  // precedent: type:"log" + a name, DF1.4's closed event union untouched).
  // Rows written outside any live phase omit phaseId, as the tripwire rows do;
  // rows from inside a phase carry the ENGINE's phaseId (phase_state's
  // precedent), never the manifest name.
  const traceResidentDirective = (payload: Record<string, unknown>): void => {
    try {
      tracer.trace({
        type: "log",
        name: "resident_directive",
        requestId,
        payloadJson: JSON.stringify(payload),
      });
    } catch {
      /* the trace store is a sidecar; the journal row is the record */
    }
  };

  // DF3.3 solicitation point 1 of 3: run start — after the manifest is
  // validated, frozen and read, before any phase is constructed. `abort` is
  // the engine's own fail transition: no phase opens and finish settles the
  // empty run not-ok. `select_roster` records the pick for the dispatch_task
  // phase the directive NAMED (its `phase` field).
  let residentAborted = false;
  // Everything from the resident-block seed to the run's return is wrapped so
  // a throw out of this region — a phase body's non-gate error (the gated
  // loop rethrows anything that is not a GateFailureError), a journal refusal
  // out of the seed — can never orphan the pi child or leave the journal
  // without a resident block: the finally stops the resident and refreshes
  // the block (both best-effort) before the module-level catch owns the exit
  // code. It also keeps an orphaned in-flight solicitation from overlapping
  // the run_end call over resident.ts's single-slot `current`.
  try {
    // The terminal marker is emitted INSIDE Run.finish — and a mid-walk
    // maxDurationMs overflow or run.terminate can write it EARLIER still — so
    // the resident block is seeded before the walk, not just before finish: a
    // poller that reads the marker must never find a settled journal with no
    // resident block at all. FileJournal keeps the block as instance state,
    // so finish's own flush carries it through (journal.ts:126-153). This
    // write may still throw through — nothing is settled yet, so a refusal
    // here is honest, and the finally still stops the resident.
    innerJournal.writeResident(residentTelemetryOf());

    if (steering !== undefined) {
      const directive = await solicitResident(steering, "run_start", {
        runId,
        requestId,
        rosterIds,
        phaseIds,
        promptContext: residentPromptContext,
      }, residentModel);
      if (directive.action === "abort") {
        residentAborted = true;
      } else if (directive.action === "select_roster") {
        // Wiring-layer recheck (S3-2): steering.ts already validated the
        // pick's phase against the advertised dispatch_task set, but this
        // runner is the composition root and must not bank a pick no
        // dispatch_task phase can consume — an engine that skipped validation
        // would otherwise count it accepted and leave it pending until the
        // never-consumed trace. Reject BEFORE pending is set, traced like the
        // never-consumed path below.
        if (phaseIds.includes(directive.phase)) {
          rosterChoice.pending = { rosterId: directive.rosterId, phase: directive.phase };
        } else {
          try {
            tracer.trace({
              type: "log",
              name: "residentRosterChoice",
              requestId,
              payloadJson: JSON.stringify({
                runId,
                rosterId: directive.rosterId,
                phase: directive.phase,
                applied: false,
                reason: "rejected at the wiring layer — phase is not a dispatch_task phase this run advertises",
              }),
            });
          } catch {
            /* the trace store is a sidecar; the run owns the verdict */
          }
        }
      }
      // An accepted run_start directive is counted in telemetry; record WHAT
      // was accepted, as the post-gate abort/retry rows do (a bare proceed
      // stays quiet — it is the common case and changes nothing).
      if (directive.action !== "proceed") {
        traceResidentDirective({ runId, point: "run_start", ...directive });
      }
    }

    const outcomes = residentAborted
      ? []
      : await walkPhases(
          run,
          manifest.phases,
          makeBodyFactory(
            runRoot,
            tracer,
            requestId,
            resolved ? { runId, repoSlug: resolved.repoSlug, issueId: resolved.issueId } : undefined,
            journal,
            {
              steering,
              runId,
              requestId,
              promptContext: residentPromptContext,
              rosterChoice,
              rosterIds,
              phaseIds,
              model: residentModel,
            },
          ),
        );

    // DF1.4: Record envelopes after each phase settles. Guarded like every
    // other tracer call — and the JSON.stringify sits inside the guard too: a
    // circular structure in an agent-produced envelope must not abort the loop
    // before run.finish writes the terminal marker (a fully executed run would
    // then read as never settled).
    for (const outcome of outcomes) {
      if (!looksLikeEnvelope(outcome.value)) continue;
      try {
        const envelope = outcome.value as Envelope;
        const phaseSpec = manifest.phases.find((p) => p.name === outcome.name);
        const phaseParams = phaseSpec as PhaseParams | undefined;
        tracer.recordEnvelope({
          requestId,
          phaseId: outcome.phaseId,
          agent: phaseParams?.agent?.agentId ?? "engine",
          outputType: envelope.kind,
          payloadJson: JSON.stringify(envelope),
          valid: envelope.status === "success",
          attempt: 1,
        });
      } catch {
        /* tracer is a sidecar; run settlement belongs to the journal */
      }
    }

    const result = run.finish(!terminated);
    // OnSignal's cancellation lever changes here: the run's phase bodies are
    // done, so from the run-end solicitation on, a signal's only meaningful
    // target is the owned resident (see the runSettled branch there). The exit
    // code is captured BEFORE the flag so the second-signal branch can never
    // observe runSettled without it.
    settledExitCode = result.exitCode;
    runSettled = true;

    // S3-3: the resident block on disk is still the pre-walk seed, and
    // run.finish just wrote the terminal marker — a marker-time reader would
    // see a SETTLED journal with zeroed resident telemetry for the whole
    // run_end window below. Refresh it here, guarded exactly like the finally
    // refresh (a failing write must not downgrade a settled run), which still
    // writes the final block with run_end's directive and the resident's own
    // exitStatus.
    try {
      innerJournal.writeResident(residentTelemetryOf());
    } catch (err) {
      writeAll(
        2,
        `pipeline-run: resident telemetry write failed: ${err instanceof Error ? err.message : String(err)}\n`,
      );
    }

    // DF3.3 solicitation point 3 of 3: run end — after finish(accepted), report
    // text only. Skipped when a directive aborted the run (abort stops the
    // resident conversation too) and when the run was TERMINATED: the operator
    // already killed it and the exit code is committed, so a fresh pi call
    // would only spend up to QDS_RESIDENT_TIMEOUT_MS on a dead run.
    if (steering !== undefined && !residentAborted && !terminated) {
      const directive = await solicitResident(steering, "run_end", {
        runId,
        requestId,
        phase: outcomes.length > 0 ? outcomes[outcomes.length - 1]?.name : undefined,
        // rosterIds deliberately ABSENT — select_roster is run_start-only; a
        // roster pick here is fail-closed rejected (tripwire-recorded).
        phaseIds,
        promptContext: residentPromptContext,
      }, residentModel);
      // The run_end directive has no engine effect left to apply, but it was
      // counted in telemetry — record what was accepted rather than dropping
      // it silently (the post-gate resident_directive precedent).
      if (directive.action !== "proceed") {
        traceResidentDirective({
          runId,
          point: "run_end",
          phase: outcomes.length > 0 ? outcomes[outcomes.length - 1]?.name : undefined,
          ...directive,
        });
      }
    }

    // A roster pick no dispatch_task phase consumed (none declared, or the
    // named phase was never reached) was counted accepted yet had no effect —
    // record the unconsumed pick instead of dropping it silently.
    if (rosterChoice.pending !== undefined) {
      try {
        tracer.trace({
          type: "log",
          name: "residentRosterChoice",
          requestId,
          payloadJson: JSON.stringify({
            runId,
            rosterId: rosterChoice.pending.rosterId,
            phase: rosterChoice.pending.phase,
            applied: false,
            reason: "never consumed — no matching dispatch_task phase ran",
          }),
        });
      } catch {
        /* the trace store is a sidecar; the run owns the verdict */
      }
    }

    // DF1.4: run.finish flowed through TracingJournal, which already ended all
    // processes and finished the session — close the writer. Guarded: the run
    // is already settled and its marker written, so a failing checkpoint/close
    // must not downgrade a settled run to "never settled" (exit 2).
    try {
      tracer.close();
    } catch {
      /* the terminal marker is the commitment, not the trace close */
    }

    // Written straight to fd 1 so the banner is on disk before the exit below.
    // No guard needed: writeAll swallows write errors itself (a dropped tail
    // lands in droppedWriteBytes, never a throw), so an EPIPE on stdout cannot
    // downgrade the settled run to "never settled" — the marker is the
    // commitment, not stdout.
    writeAll(1, `${result.banner}\n`);
    return result.exitCode;
  } finally {
    // Ownership: the runner spawned the resident, so the runner stops it —
    // FIRST, before the status probe: stop() SIGKILLs anything still in
    // flight and awaits the process's exit, so the settled run's cleanup never
    // blocks on a wedged pi child and the probe reads how the resident
    // actually ENDED rather than racing a live call. Both halves are
    // best-effort: on a throw path nothing here may mask the original error,
    // and on the settled path the marker is the commitment.
    if (residentSpawn !== undefined) {
      try {
        await residentSpawn.stop();
      } catch {
        /* the settled marker is the commitment, not the resident's teardown */
      }
    }
    const residentBlock = residentTelemetryOf();
    if (residentSpawn !== undefined) {
      try {
        residentBlock.exitStatus = await residentSpawn.exitStatus();
      } catch {
        /* keep null — the process's word is telemetry */
      }
    }
    // Final refresh (run_end's directive + the resident process's own exit
    // status), guarded exactly like the tracer close: past finish a failing
    // write must not downgrade a settled run to "never settled" — the refusal
    // is reported, not thrown.
    try {
      innerJournal.writeResident(residentBlock);
    } catch (err) {
      writeAll(
        2,
        `pipeline-run: resident telemetry write failed: ${err instanceof Error ? err.message : String(err)}\n`,
      );
    }
  }
}

if (import.meta.main) {
  let code = 2;
  try {
    code = await main(Bun.argv.slice(2));
  } catch (err) {
    writeAll(2, `pipeline-run: ${err instanceof Error ? err.message : String(err)}\n`);
  }
  // Explicit exit: a phase body that ignored its abort may still be alive after
  // the cancellation grace, and nothing it does may outlive the terminal marker.
  process.exit(code);
}
