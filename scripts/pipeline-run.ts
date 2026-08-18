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
  loadManifest,
  sanitizeForMessage,
  walkPhases,
  type PhaseBody,
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
import { parseValueFlags } from "./lib/cli-args.ts";
import { dispatchTask } from "../src/phase-engine/phases/dispatch-task.ts";
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
  "       [--repo-slug <owner/name> --issue <n> [--issue-url <url>]]",
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
 * DF1.2's `commandGate` gates this argv where a caller composes it (see
 * makeBodyFactory); the command itself runs with a scrubbed environment and a
 * cwd pinned to the run root.
 *
 * DF1.4: recordProcess/endProcess calls for tracer.
 */
function runCommand(
  cmd: readonly string[],
  signal: AbortSignal,
  cwd: string,
  tracer: Tracer,
  requestId: string,
): Promise<number> {
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
      resolve(code ?? (sig ? 128 : 0));
    });
  });
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
    fs.writeSync(
      2,
      `pipeline-run: dispatch-failure log unwritable: ${logErr instanceof Error ? logErr.message : String(logErr)}\n`,
    );
  }
  fs.writeSync(
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
      return async ({ signal }) => ({ exitCode: await runCommand(cmd, signal, cwd, tracer, requestId) });
    }
    // DF1.6 T7: dispatch_task registration — the factory closes over the
    // run's tracer + requestId so prompt events (pre-spawn) and adapted team
    // events land in the trace store (DD-8, Observability Contract). rootDir
    // pins artifact reads to the SAME --run-root the code phases use.
    if (spec.kind === "dispatch_task") {
      return dispatchTask(spec, { tracer, requestId, rootDir: cwd });
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

  parseValueFlags(argv, {
    flags: [
      "--manifest",
      "--budget-ms",
      "--journal",
      "--run-root",
      "--run-id",
      "--request-id",
      "--repo-slug",
      "--issue",
      "--issue-url",
    ],
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
        default:
          requestId = value;
      }
    },
  });

  if (!manifestPath) throw new Error("--manifest is required");
  if (budgetMs === undefined) throw new Error("--budget-ms is required");
  if (!journalPath) throw new Error("--journal is required");

  const { manifest, manifestLoadMs } = loadManifest(manifestPath, budgetMs, runRoot);

  // DF1.8: the marker root is derived before anything can refuse — a
  // correlation failure can precede the trace claim entirely, and its dispatch
  // log still needs a home (AC4: the log outlives a trace store that could not
  // even open).
  const markerRoot = process.env.QDS_RUN_ROOT ?? "/run";

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
  let tracer: Tracer;
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
        fs.writeSync(
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
      fs.writeSync(
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
    return dispatchFail(
      markerRoot,
      { repoSlug: resolved.repoSlug, issueId: resolved.issueId, requestId: resolved.requestId },
      err,
    );
  }

  // DF1.4: Wrap FileJournal with TracingJournal
  const innerJournal = new FileJournal(journalPath, runId);
  const ctx: RunContext = { runId, pipelineId: manifest.pipelineId, requestId };
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
      // DF1.4: Close tracer before exit
      try {
        tracer.processesEndAll(requestId);
        tracer.close();
      } catch {
        /* ignore */
      }
      process.exit(2);
    }
    terminated = true;
    run.terminate(sig);
  };
  process.on("SIGTERM", () => onSignal("SIGTERM"));
  process.on("SIGINT", () => onSignal("SIGINT"));

  const outcomes = await walkPhases(
    run,
    manifest.phases,
    makeBodyFactory(
      runRoot,
      tracer,
      requestId,
      resolved ? { runId, repoSlug: resolved.repoSlug, issueId: resolved.issueId } : undefined,
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

  // DF1.4: run.finish flowed through TracingJournal, which already ended all
  // processes and finished the session — close the writer. Guarded: the run
  // is already settled and its marker written, so a failing checkpoint/close
  // must not downgrade a settled run to "never settled" (exit 2).
  try {
    tracer.close();
  } catch {
    /* the terminal marker is the commitment, not the trace close */
  }

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
