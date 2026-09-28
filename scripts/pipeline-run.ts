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
 *   --run-root <path>    root the manifest read is anchored at (default: cwd).
 *                        In the box this is the customer checkout ($HOME/src),
 *                        with the manifest pair at <root>/.qds/ — the manifest
 *                        read, the cap-witness read, the roster resolution and
 *                        every code phase's cwd then share one root (DF1.10
 *                        AC2b). It moves NOTHING onto the marker root, which
 *                        stays runMarkerRoot(runId)'s own lever (a per-run
 *                        tree under /run in the box, #217 F-D1)
 *   --engine-log <path>  tee every engine log line into this file as well as
 *                        stderr (DF1.10 AC4). journald does not ride DF2.5's
 *                        harvest tar, so an in-box run's log needs a file to be
 *                        evidence. Best-effort: an unopenable path warns and
 *                        the run proceeds — observability is a sidecar
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
 * DF1.10 AC6 adds one nuance to those three, and no fourth code: an invocation
 * that refuses because THIS run already settled exits with the marker's own
 * verdict (0 for `ok:true`, 1 for `ok:false`). Retrying a finished run is then
 * idempotent — `fleet run <id>` twice reports the same VERDICT twice, which is
 * all a marker records: it holds `ok`, so the only exit codes a mirror can ever
 * produce are the same 0/1 the original produced, and a run that exited 2 wrote
 * no marker to mirror. Every other refusal is 2, which keeps meaning "genuinely
 * could not settle": a marker that is unreadable, not a regular file,
 * illegible, verdictless, or written by ANOTHER run (the marker path is one per
 * run ROOT, and `/run` outlives the unit that wrote it), and a journal that
 * carries phase rows with no marker beside them — a run killed mid-walk, or a
 * reboot that wiped tmpfs `/run` while ext4 `$HOME` kept the evidence. The
 * `engine_refused_replay` event, not the exit code, is what distinguishes a
 * mirror from a real walk.
 *
 * Phase bodies: a `code` phase runs its manifest `command`; its exit code is
 * data, not a phase verdict (DF1.2 AC4 owns that rule), so the phase succeeds
 * whatever the command returns. A `dispatch_task` phase hands the work to a pi
 * team. Those are the only two kinds there are (DF1.10 C19): `makeBodyFactory`
 * ends in a `never` exhaustiveness check, so a kind with no executor is a
 * COMPILE error here rather than a throw a paid-for run discovers mid-walk.
 *
 * DF1.10 AC6: an invocation whose terminal marker already exists — or whose
 * DURABLE journal already carries phase rows, which is the same question asked
 * of the one filesystem a reboot does not wipe — refuses before the correlation
 * ladder, before any phase runs and before any journal row is written.
 * `writePhase` always persists `fail` and `promotePhase` is the sole path to
 * success, so re-walking a settled run would overwrite a `fail` row that was
 * recorded deliberately — and re-spend the money and re-make the commits it
 * already paid for (INV-IBOX-6). Refusing before `new FileJournal` is what also
 * keeps the crashed attempt's rows: the constructor flushes an empty journal
 * over its path, so a retry that got past the guard would destroy the only
 * record of what already spent.
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
// Straight from `journal.ts`, not the barrel: `runMarkerPath` is deliberately
// off `index.ts` (it is the on-disk marker LAYOUT, not a policy), and `phase.ts`
// already imports it this way. Reconstructing the join here instead would give
// the engine a second, drifting copy of the one path DF3.2's poller and DF2.5's
// harvest both key on.
// `writeTerminalMarker` rides the same straight import: it too lives in
// `journal.ts` and not on the barrel, and edit (i)'s arming refusal must
// settle through the SAME writer Run.finish uses — never a second copy.
import {
  runMarkerPath,
  unidentifiedRunRoot,
  writeTerminalMarker,
} from "../src/phase-engine/journal.ts";
import type { Envelope } from "../src/phase-engine/envelopes/types.ts";
import { killTree } from "./lib/kill-tree.ts";
import { parseValueFlags, tokenizeArgs } from "./lib/cli-args.ts";
import { dispatchTask } from "../src/phase-engine/phases/dispatch-task.ts";
// S1: the rig_swarm phase body — the tier-2 engine INSIDE the box. The runner
// stays the composition root: it injects the run's tracer, the money-line tee
// and the run-scoped invocation counter, exactly as it does for dispatch_task.
import { openrigSwarmPhase } from "../src/phase-engine/phases/openrig-swarm.ts";
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
// DF3.6a: the resident bound operands' engine-side load and guard. Straight
// from the module, not the barrel — steering.ts imports its type the same
// way, and this runner is the composition root where the frozen manifest, the
// resolved rate and the spawn handle are the only three things that ever meet.
import {
  BoundConfigError,
  createBoundsGuard,
  loadResidentBounds,
  type ResidentBoundsConfig,
} from "../src/phase-engine/resident-bounds.ts";
import { loadRoster } from "../src/phase-engine/roster/schema.ts";
import { ACKS_READ_CAP_BYTES, acksPath, localSteeringInbox } from "../src/fleet/attach.ts";
import {
  CgroupUnenforceableError,
  DEFAULT_RESIDENT_SLUG,
  startResident,
  type ResidentSpawn,
} from "../src/fleet/resident.ts";
import { RateError } from "../src/phase-engine/roster/validate.ts";
// INV-RUN-5: the redactor every witness echo runs through — see `witnessEcho`.
// `sanitizeForMessage` (phase-engine) escapes control characters; it does NOT
// remove credential-shaped substrings, and this file quotes its input.
import { redactSecrets } from "../src/providers/step-log.ts";
import {
  appendDispatchFailure,
  CorrelationError,
  MAX_ISSUE_ID,
  RequestIdRepoMismatchError,
  resolveRunCorrelation,
} from "../src/phase-engine/issue-correlation.ts";
// ExitStatus comes through the types.ts re-export — the single source of truth
// lives in cli-anything/src/types.ts and is never re-spelled here (DF1.8).
import type { ExitStatus, ResolvedRunCorrelation } from "../src/phase-engine/types.ts";

const HELP = [
  "Usage: bun scripts/pipeline-run.ts --manifest <path> --budget-ms <n> --journal <path>",
  "       [--run-root <path>] [--engine-log <path>] [--run-id <id>] [--request-id <id>]",
  "       [--repo-slug <owner/name> --issue <n> [--issue-url <url>]] [--no-resident]",
  "",
];

/** The value flags main() takes — shared by the tokenizer and the value parser. */
const VALUE_FLAGS = [
  "--manifest",
  "--budget-ms",
  "--journal",
  "--run-root",
  "--engine-log",
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
 * impossible (this is that pattern), and one matching THERE but not HERE
 * filters out every fleet-id line as foreign, which is a DELIVERY loss the
 * `steering_ownrun_id_space_mismatch` warn names (round-10 S1: the filter is
 * never disabled, because disabling it turned the shared host inbox into
 * cross-run message theft).
 */
const MINTED_FLEET_RUN_ID_RE = /^qds-\d{8}-[a-f0-9]{6}$/;

/**
 * Ids the steering ack log already records as acked — the durable half of the
 * inbox dedupe (round-10 S2), supplied by the runner because the engine's port
 * makes `ackedIds` optional: a transport that cannot read its ack log stays on
 * the in-process dedupe alone, and this runner is the only production wiring of
 * that transport.
 *
 * The log is append-only and PER-BOX (`acksPath()` names the one channel this
 * box's steering root owns, and production runs one run per box, so in
 * practice it is this run's own log — only hand-run engines sharing a box's
 * root ever share it), so this is a bounded TAIL read on attach's own
 * discipline (`ACKS_READ_CAP_BYTES`): a full read re-parses an ever-growing
 * file on every solicitation, and the newest acks are the ones a still-queued
 * message can collide with. The window may open mid-line; the parse loop skips
 * that first partial line exactly as a torn one. Ids, not run ids: an id acked
 * by anyone means that message was consumed — there is no second consumer —
 * and the engine's own-run filter has already scoped `drain` to this run.
 *
 * Throws on a non-ENOENT read fault so the engine can report it through
 * `onInboxError` and drain on with the in-process dedupe alone: re-folding
 * text an earlier prompt carried is bounded by the fold budget, while
 * withholding delivery is bounded by nothing.
 */
async function readSteeringAckedIds(): Promise<readonly string[]> {
  let text = "";
  try {
    const fd = fs.openSync(acksPath(), "r");
    try {
      const size = fs.fstatSync(fd).size;
      const from = Math.max(0, size - ACKS_READ_CAP_BYTES);
      const buf = Buffer.alloc(Math.min(size, ACKS_READ_CAP_BYTES));
      let read = 0;
      // Loop the read: a single `readSync` may return fewer bytes than asked,
      // and the unfilled tail would parse as garbage. `n <= 0` means EOF (or a
      // vanished file) — stop, never spin.
      while (read < buf.length) {
        const n = fs.readSync(fd, buf, read, buf.length - read, from + read);
        if (n <= 0) break;
        read += n;
      }
      text = buf.subarray(0, read).toString("utf8");
    } finally {
      fs.closeSync(fd);
    }
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw e;
  }
  const out: string[] = [];
  for (const line of text.split("\n")) {
    if (line.trim().length === 0) continue;
    try {
      const row = JSON.parse(line) as { messageId?: unknown };
      if (typeof row.messageId === "string") out.push(row.messageId);
    } catch {
      /* torn or partial line — skip it, exactly as the inbox leg does */
    }
  }
  return out;
}

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
 * DF1.10 AC4 — the engine log (`--engine-log`).
 *
 * In the box the engine's stderr is journald's, and journald does not ride
 * DF2.5's harvest tar: the log would be evidence that dies with the box. So
 * every line written to fd 2 is TEE'd into this descriptor as well.
 *
 * Tee'd rather than redirected. The story asks for a file "rather than left in
 * journald", and the file is what harvest needs — but `journalctl -u
 * qds-run@<runId>` is the operator's first reflex when a unit misbehaves, and
 * starving it to satisfy the letter of a sentence would cost more than the
 * duplicate bytes save. `undefined` until `--engine-log` opens one, which is
 * why every existing invocation behaves exactly as it did.
 */
let engineLogFd: number | undefined;

/**
 * Open the engine log, or warn and continue.
 *
 * Append + `O_NOFOLLOW` at 0600: it lands on ext4 `$HOME` beside the journal
 * and the resident's redacted artifacts (INV-IBOX-8), at the mode those
 * artifacts already use, and a symlink planted at the path must not redirect
 * the run's own log somewhere else. Append because a `Restart=no` unit still
 * gets re-invoked by hand, and a truncating open would erase the log of the
 * run being investigated.
 *
 * The directory is NOT created. Every production path lands this file in `$HOME`
 * beside the journal, which exists by the time the engine runs; a `--engine-log`
 * pointing somewhere else is an operator's flag, and silently materialising a
 * directory tree anywhere writable is more than "best-effort sidecar" licenses.
 * An absent directory warns like any other unopenable path.
 *
 * Never throws: a log sink that can fail the run is a worse sink than no sink
 * (AC5, and the same rule `writeAll` already keeps).
 */
export function openEngineLog(target: string): void {
  // `main` is re-entrant through the `run` front door, which opens the derived
  // log BEFORE deriving the rest of the argv (so a derivation throw is
  // harvestable) and then hands `--engine-log` to the inner `main`, which opens
  // it again. Open the replacement FIRST and close the earlier descriptor only
  // once the new one exists: a close-then-reopen whose second open fails (perms
  // changed, directory removed between the two `main`s) would discard a working
  // evidence channel for the whole run. Two briefly overlapping descriptors on
  // one O_APPEND file are harmless — both append.
  let next: number;
  try {
    next = fs.openSync(
      target,
      fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_APPEND | fs.constants.O_NOFOLLOW,
      0o600,
    );
  } catch (err) {
    // The OS error message echoes the path verbatim, so it is sanitized like
    // the target a few tokens earlier.
    const warning = `pipeline-run: warning: engine log ${sanitizeForMessage(target)} could not be opened (${sanitizeForMessage(err instanceof Error ? err.message : String(err))}) — ${engineLogFd === undefined ? "continuing with stderr only" : "continuing with the already-open engine log descriptor"}\n`;
    if (engineLogFd === undefined) {
      // Raw writeSync: there is no descriptor left to tee into, and writeAll
      // would try exactly that.
      try {
        fs.writeSync(2, warning);
      } catch {
        /* the warning about a broken sink is itself a sidecar */
      }
    } else {
      // The OLD descriptor is still open — writeAll tees fd 2 into it, so the
      // one line that explains the degraded sink lands in the sink itself
      // (and so in the harvested log) instead of existing only on stderr.
      writeAll(2, warning);
    }
    return;
  }
  if (engineLogFd !== undefined) {
    try {
      fs.closeSync(engineLogFd);
    } catch {
      /* a descriptor that will not close is still not one to keep a name for */
    }
  }
  engineLogFd = next;
}

/**
 * DF1.11 AC4b — the boot anchor: exactly one
 * `{event:"engine_boot_anchor", boot_id, uptime_s}` line per engine startup,
 * emitted BEFORE any resident/steering arming so it exists even on a fully
 * deterministic unarmed run.
 *
 * The row exists to make "a reboot happened under this run" attributable at
 * harvest (the anchored boot_id against the box's live one), so its SURFACE
 * must survive the event it records: fd 2, which `writeAll` tees into the
 * ext4 engine log, never the tracer — the trace sidecar lives on the tmpfs
 * `/run` a reboot wipes, i.e. dies on the very event this row witnesses (the
 * AC's negative control names exactly that). No counter, no poller, no
 * daemon backs it: the anchored boot_id is the whole signal, and nothing here
 * widens `ResidentTelemetry`, the journal `resident` block or DF2.1's run
 * record — all closed key sets.
 *
 * Best-effort like every sink in this file: a `/proc` that cannot be read
 * (or does not exist — dev machines are not Linux) degrades that field to
 * null rather than throwing. The row still anchors the startup; a fabricated
 * boot_id would be worse than none.
 *
 * `runId`/`requestId` ride the row because they ride EVERY engine-log line
 * (`emitEngineEvent`'s discipline, pinned by in-box-engine.test.ts's
 * full-event-set walk) — the log is the per-run harvest artifact, and a row
 * a consumer cannot join to its run is evidence about nobody. `phaseId`
 * rides as an explicit `null`: the anchor is run-scoped, and the same
 * discipline keeps "no phase" distinguishable from "field not emitted by
 * this build" on exactly such rows. `event`,
 * `boot_id` and `uptime_s` are the contract fields; the identity keys are
 * the log's own, not a widening of the AC.
 */
function writeBootAnchorRow(runId: string, requestId: string): void {
  let bootId: string | null = null;
  let uptimeS: number | null = null;
  try {
    bootId = fs.readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim() || null;
  } catch {
    /* no /proc (non-Linux) or unreadable — null is the honest value */
  }
  try {
    const first = Number.parseFloat(fs.readFileSync("/proc/uptime", "utf8"));
    if (Number.isFinite(first)) uptimeS = first;
  } catch {
    /* same degrade: null uptime, never a thrown startup */
  }
  writeAll(
    2,
    `${JSON.stringify({ event: "engine_boot_anchor", runId, requestId, phaseId: null, boot_id: bootId, uptime_s: uptimeS })}\n`,
  );
}

/**
 * The engine's observability event set (DF1.10 Observability Contract).
 *
 * DEVIATION, recorded here rather than in a report nobody greps: the contract
 * spells the solicitation event `resident_solicited`. The line the engine
 * actually emits is DF3.3's `resident_solicit`, asserted by name in four
 * host suites and in `tests/fleet/e2e/tier4-resident.live.test.ts`. Renaming it
 * buys a past-tense suffix and breaks five files, so the existing spelling IS
 * this slot and the union says so out loud.
 */
type EngineEvent =
  | "engine_started"
  | "phase_started"
  | "phase_settled"
  | "resident_solicit"
  | "engine_settled"
  | "engine_refused_replay"
  | "engine_refused_claim";

/**
 * One engine event line. `runId`, `requestId` and `phaseId` ride EVERY line —
 * `phaseId` as an explicit `null` on run-scoped events rather than omitted, so
 * a consumer joining a status row to a trace row never has to tell "no phase"
 * apart from "field not emitted by this build".
 */
function emitEngineEvent(
  event: EngineEvent,
  ids: { runId: string | null; requestId: string | null; phaseId?: string | null },
  extra: Record<string, unknown> = {},
): void {
  try {
    writeAll(
      2,
      `${JSON.stringify({
        // `extra` FIRST so the canonical keys below win: a caller's stray
        // `event`/`runId` in extra must not be able to overwrite the line's
        // identity — the identity keys are this emitter's contract, not a
        // default the payload may shadow.
        ...extra,
        // A refusal's level follows its EXIT CODE, not the event name. The
        // refusal that mirrors an `ok:true` marker exits 0 on purpose — a
        // second `fleet run <id>` against a finished run is idempotent, not a
        // failure — and alerting keyed on `level:"error"` firing on exactly the
        // path the mirror exists to make safe would train operators to ignore
        // it. The event name still distinguishes a mirror from a real walk.
        // `engine_refused_claim` always exits 2 and is an error by the same
        // rule. `engine_settled` follows its VERDICT by that rule too: a run
        // that genuinely settled not-ok is a real failure and reads as one,
        // while the mirrored ok:true replay above stays info — idempotence,
        // not failure.
        level:
          (event === "engine_refused_replay" || event === "engine_refused_claim") &&
          extra.exitCode !== 0
            ? "error"
            : event === "engine_settled" && extra.ok === false
              ? "error"
              : "info",
        event,
        runId: ids.runId,
        requestId: ids.requestId,
        phaseId: ids.phaseId ?? null,
      })}\n`,
    );
  } catch {
    /* observability is a sidecar; the marker is the commitment */
  }
}

/**
 * `phase_started` / `phase_settled`, emitted off the JOURNAL PORT rather than
 * off a body wrapper (DF1.10 Observability Contract).
 *
 * The port is where the verdict actually is. A wrapper around the phase body
 * sees "the body threw" or "the body returned", which is not the same question:
 * `Run.phase` also fails a phase whose returned VALUE declares a non-success
 * `exitStatus` (phase.ts's verdict-honesty branch), so a wrapper would have to
 * re-implement that classification and would drift from it. `promotePhase` is
 * the single call every settled phase goes through — fail and success alike —
 * carrying the status and exitStatus already decided.
 *
 * "Fail and success alike" is worth stating because the PORT's doc reads the
 * other way at a glance: `promotePhase` is "the sole path to `success`", which
 * is a rule about which STATUS may be written where, not about who calls it.
 * `phase.ts` settles every phase through it — `promotePhase(id,"success",…)` on
 * the clean branch and `promotePhase(id,"fail",exitStatus)` on the other — so
 * hanging `phase_settled` here emits it for failed phases too. Hanging it off
 * the second `writePhase` instead would emit it twice for a success.
 *
 * It also keeps the events REAL-TIME. An in-box run's log is the only window
 * onto it while it is running, so emitting the whole set after `walkPhases`
 * returns would report a two-hour walk in one burst at the end.
 *
 * Every method delegates FIRST: a journal write that throws must not have
 * already announced a row that is not on disk.
 *
 * Deliberately NOT the tracer: DF1.8's `phase_state` trace rows exist only for
 * correlated runs, and the in-box invocation (`qds-engine run <runId>`) is
 * bare. These are log lines, so a bare run is observable too — and the suites
 * asserting "a bare run writes no phase_state events" stay true.
 */
class ObservedJournal implements PhaseJournal {
  /** phaseId → manifest name; `promotePhase` is given only the id. */
  private readonly names = new Map<string, string>();

  constructor(
    private readonly inner: PhaseJournal,
    private readonly ids: { runId: string; requestId: string },
  ) {}

  writePhase(record: Parameters<PhaseJournal["writePhase"]>[0]): void {
    this.inner.writePhase(record);
    // phase.ts writes each phase TWICE (open, then the settled record), so the
    // second write is a row update and must not re-announce a start.
    if (this.names.has(record.phaseId)) return;
    this.names.set(record.phaseId, record.name);
    emitEngineEvent("phase_started", { ...this.ids, phaseId: record.phaseId }, {
      phase: sanitizeForMessage(record.name),
      kind: record.kind,
    });
  }

  promotePhase(
    phaseId: Parameters<PhaseJournal["promotePhase"]>[0],
    status: Parameters<PhaseJournal["promotePhase"]>[1],
    exitStatus?: Parameters<PhaseJournal["promotePhase"]>[2],
  ): void {
    this.inner.promotePhase(phaseId, status, exitStatus);
    const name = this.names.get(phaseId);
    emitEngineEvent("phase_settled", { ...this.ids, phaseId }, {
      // `null`, not `""`, for a phase this journal never saw opened: a manifest
      // may legitimately name a phase "" and a consumer must be able to tell
      // that apart from "this wrapper has no name for it".
      phase: name === undefined ? null : sanitizeForMessage(name),
      status,
      exitStatus: exitStatus ?? null,
    });
  }

  writeGateEvent(event: Parameters<PhaseJournal["writeGateEvent"]>[0]): void {
    this.inner.writeGateEvent(event);
  }

  finish(
    runId: Parameters<PhaseJournal["finish"]>[0],
    accepted: Parameters<PhaseJournal["finish"]>[1],
  ): ReturnType<PhaseJournal["finish"]> {
    return this.inner.finish(runId, accepted);
  }

  phases(): ReturnType<PhaseJournal["phases"]> {
    return this.inner.phases();
  }
}

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
  // DF1.10 AC4: tee fd 2 into the engine log so the harvest tar carries what
  // journald would otherwise keep. Deliberately AFTER the stderr write and in
  // its own guard — a full or vanished log file must not cost stderr its line.
  // LOOPED like the write above, and for a sharper reason: the harvested file
  // is parsed line by line, so a short write does not lose a tail, it leaves
  // half a JSON object that reads as a corrupt event. It still earns no
  // dropped-bytes counter — the file is the copy, stderr above is the original,
  // and a counter for the copy would make the two disagree about one line.
  if (fd === 2 && engineLogFd !== undefined) {
    try {
      // `spins` bounds PROGRESS, not patience: every iteration advances ≥1 byte
      // (a 0-progress write breaks), so `bytes.length` iterations is the hard
      // bound and the loop can never spin forever. A fixed cap below a line's
      // size (the old 1000) could exit mid-line on a 1-byte-at-a-time sink —
      // leaving exactly the half-JSON the loop exists to prevent — and child
      // output relayed through here arrives in arbitrarily large chunks.
      for (let off = 0, spins = 0; off < bytes.length && spins <= bytes.length; spins += 1) {
        const n = fs.writeSync(engineLogFd, bytes, off, bytes.length - off);
        if (n <= 0) break;
        off += n;
      }
    } catch {
      /* the tee is a sidecar of a sidecar */
    }
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

/**
 * DF2.12 INV-COST-10: the production money-line writer, injected at BOTH
 * emission sites (`dispatchTask`'s `emitMoneyLine`, steering's
 * `emitAttribution`). It MUST go through `writeAll`: the fd-2 tee is
 * caller-level, not an OS-level dup, so a plain `process.stderr.write` would
 * land on journald only under the in-box systemd unit (no `StandardError=`
 * override, bare `ExecStart`) — never on the ext4 engine log the artifacts
 * harvest pulls, leaving token spend invisible to every per-issue cap: the
 * exact disarmed-tripwire state DF2.12 exists to close. Durability is asserted:
 * `tests/phase-engine/pipeline-run-money-line.test.ts` pins the tee capture
 * (real subprocess, real `--engine-log` file) and this file's two injection
 * sites; the TIER-2 live round is the end-to-end proof.
 */
export function moneyLineTee(): (line: Record<string, unknown>) => void {
  return (line) => writeAll(2, `${JSON.stringify(line)}\n`);
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
 * The single treatment every witness echo gets (INV-RUN-5, review round 3).
 *
 * A witness refusal quotes its input — `resolveRunCorrelation`'s message ends
 * `(got "…")`, and a JSON parse error quotes the offending fragment — and this
 * message rides the engine log into DF2.5's harvest tar. Three properties, in
 * this order, because the order is load-bearing:
 *
 *   1. `redactSecrets` removes credential-shaped substrings. A token-shaped
 *      `repoSlug` shorter than the bound was measured surviving verbatim.
 *   2. `sanitizeForMessage` escapes control characters, so a newline-bearing
 *      witness cannot forge a log line the harness would parse as an event.
 *   3. the bound caps an unbounded junk witness.
 *
 * Redaction must come FIRST: sanitizing first escapes the very bytes the
 * redactor pattern-matches on, and the token then rides through in its escaped
 * spelling.
 */
const witnessEcho = (value: unknown, bound = 200): string =>
  sanitizeForMessage(redactSecrets(value)).slice(0, bound);

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
  //
  // INV-RUN-5: both `is unreadable` refusals below SANITIZE and truncate their
  // echo. This is the reader that actually fires on a malformed witness — it
  // runs a step before `witnessCorrelationBeside` and refuses first — and a
  // JSON.parse failure quotes a fragment of its input, so `{"x": sk-or-v1-…}`
  // sent that fragment into the engine log DF2.5's harvest carries home.
  // Measured, not theorised.
  //
  // What this BOUNDS (review round 3 — this comment used to end by accepting the
  // credential residual as deliberate; INV-RUN-5 is a claim this story makes, so
  // the residual is now closed rather than documented): every witness echo goes
  // through `witnessEcho`, which is `redactSecrets` THEN `sanitizeForMessage`
  // THEN the bound. `redactSecrets` removes the credential-shaped substring —
  // `resolveRunCorrelation`'s `(got "sk-or-v1-…")` quote was measured riding into
  // the engine log verbatim, and DF2.5's harvest carries that log home.
  // `sanitizeForMessage` escapes control characters, so a newline-bearing witness
  // cannot forge a log line, and the bound caps an unbounded junk witness. Order
  // matters: redact first, because sanitizing first would escape the very bytes
  // the redactor pattern-matches on. The operator still gets the WHERE.
  let bytes: Buffer;
  try {
    ({ bytes } = readArtifactBeneathRoot(witnessPath, runRoot));
  } catch (err) {
    throw new Error(
      `${because} ${witnessPath} is unreadable: ${witnessEcho(err instanceof Error ? err.message : String(err))}`,
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
      `${because} ${witnessPath} is unreadable: ${witnessEcho(err instanceof Error ? err.message : String(err))}`,
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
 * The errno at the bottom of a hardened-reader failure.
 *
 * `readArtifactBeneathRoot` wraps the raw fs error in a ManifestError `cause`,
 * so every caller that must tell ABSENCE (ENOENT) from an env fault has to walk
 * that chain rather than read `err.code` off the top. Hoisted out of
 * `readResidentBriefSource` when `witnessCorrelationBeside` needed the same
 * distinction: two copies of this walk is two places for the "absent" test to
 * rot, and both of them decide whether a failure is a refusal or a shrug.
 *
 * NEAREST code first, THEN the chain. Walking the chain exclusively discarded a
 * perfectly good code on the wrapper whenever the wrapper had a cause at all —
 * and `new Error(msg, { cause: undefined })` installs the own property, so
 * `"cause" in e` was true even for an absent cause and the walk recursed into
 * `undefined`. That was survivable while the only consumer wrote a warning; it
 * now gates a REFUSAL (`witnessCorrelationBeside`), where one mis-walked ENOENT
 * turns the documented bare-session fallback into a hard run refusal.
 * `ManifestError` — the wrapper this actually unwraps — carries no `code` of its
 * own, so the nearest-first order still reaches the raw errno underneath it.
 */
const errnoOf = (e: unknown): string | undefined => {
  const own = (e as NodeJS.ErrnoException | undefined)?.code;
  if (own !== undefined) return own;
  return e instanceof Error && e.cause != null ? errnoOf(e.cause) : undefined;
};

/**
 * DF5.3 N1: the witness could not be READ — an environment fault (EACCES, EIO,
 * a full disk, the hardened reader's symlink refusal), not a statement about
 * the correlation. Distinguished by CLASS rather than by errno because the
 * symlink refusal arrives as a `ManifestError` carrying no errno at all, so an
 * `errnoOf(err) !== "ENOENT"` test at the call site would mis-read it.
 *
 * The split it carries: this code runs IN THE BOX, after provisioning, fill
 * and key delivery, so a disk or permissions problem must not kill a run that
 * has already spent — the call site degrades to the bare session and the
 * `run_correlated` `recorded: false` line, exactly as the `initiateSession`
 * catch does for a trace-store fault and as `readResidentBriefSource` does for
 * the identical errno. A witness that is PRESENT and structurally wrong keeps
 * the hard refusal (a plain `Error` from every branch below): a forged or
 * half-written correlation must never silently become a session row.
 */
class WitnessUnreadableError extends Error {
  name = "WitnessUnreadableError";
}

/**
 * DF5.3: the issue correlation dispatch stamped into the witness, as a
 * `ResolvedRunCorrelation` — or `undefined` when the witness carries none.
 *
 * WHY A THIRD READER OF ONE FILE. A DISPATCHED run arrives with a host-minted
 * runId on `--run-id`, so it never walks DF1.8's correlation ladder:
 * `--repo-slug`/`--issue` RESOLVE an identity through that ladder, and
 * RUN_ID_CONFLICT refuses them beside a `--run-id` precisely because a run
 * cannot be identified twice. But RESOLVING an identity and RECORDING which
 * issue authorized a run are two concerns that were riding one pair of flags,
 * and the dispatched shape needs the second without the first — so it fell
 * through to the bare `startSession`, which writes NULL `repo_slug`/`issue_id`.
 * The harvested trace then had nothing to say about the issue the host record
 * admitted the run against, so the audit walker's record-vs-trace divergence
 * check had no corroboration to compare and tampering with the host record was
 * undetectable. The correlation therefore travels on the WITNESS, never on the
 * identity flags, and RUN_ID_CONFLICT keeps its current meaning.
 *
 * THE PAIR PREDATES THIS CHANGE. `src/fleet/dispatch.ts` has been writing
 * `repoSlug`/`issueId` (and `issueUrl`) into `run-context.json` since DF3.1 —
 * verify with `git show main:src/fleet/dispatch.ts`. What DF5.3 adds is the
 * READER, so the real behaviour change is that every witness already on disk
 * (live boxes, checked-in fixtures, `_bmad-output/evidence/`) now routes the
 * engine down `initiateSession` rather than `startSession`, and the refusals
 * below apply to files nobody wrote with them in mind. That is deliberate — a
 * dispatched witness has carried a whole, `resolveRunCorrelation`-validated
 * pair all along, so the refusals only fire on one that was hand-edited or
 * truncated.
 *
 * The ABSENT branch is therefore NOT a "pre-DF5.3 witness" path: it is the
 * flag-driven and library path (tests, `--repo-slug`/`--issue` runs, any run
 * with no witness beside its manifest), which leaves the caller on the bare
 * `startSession` exactly as before — never a refusal, never a fabricated pair.
 * A PRESENT but malformed pair refuses the run: a half-correlated run is
 * the ambiguity this reader exists to remove, and INV-RUN-3 makes issue
 * identity the (repoSlug, issueId) PAIR — `#1` exists in every repo the
 * factory touches — so neither half is ever defaulted from the other.
 *
 * Validation is `resolveRunCorrelation`'s, not a second opinion: the same
 * function the flag ladder calls, so the slug charset, the 1..MAX_ISSUE_ID
 * bounds and the canonical (case-folded) slug the ledger keys on cannot drift
 * between the two carriers. Its minted requestId is DISCARDED and the
 * caller's substituted — this run's requestId is already settled (dispatch
 * stamped it into this same witness and `deriveInBoxArgv` passed it as
 * `--request-id`), and feeding it in would impose strict UUID v4 on an
 * identifier the flag layer validates by `IN_BOX_RUN_ID_RE` instead, refusing
 * runs the engine otherwise accepts.
 *
 * Unlike `readResidentBriefSource` above this reader REFUSES what it cannot
 * verify. The reason is NOT that the cap path leaves gaps in the READ — it
 * does not: `runContextFrom` sends every present witness through
 * `admittedCeilingBeside` on both the declared and the undeclared path, and
 * `witnessPresent` counts every non-ENOENT lstat errno as present, so an
 * unreadable or unparseable witness is already refused before this function is
 * called (measured, not assumed — a mode-000 witness on an uncapped manifest
 * dies at the cap reader). The gap is in WHAT is checked: the cap reader
 * validates `effectiveCeilingMicros` and nothing else, so a witness with a
 * perfectly good ceiling can still carry half a correlation, a non-string
 * repoSlug or a requestId naming a different run. Those are this reader's to
 * refuse, and they are refusals rather than shrugs because a half-correlated
 * run is the ambiguity this reader exists to remove.
 *
 * An ENVIRONMENT fault reading the file is the one thing that does NOT refuse
 * here (DF5.3 N1): it raises `WitnessUnreadableError` and the call site
 * degrades to the bare session plus a `recorded: false` line. Live only on the
 * `witnessPresent`→read race today, for the reason above.
 *
 * It inherits `runContextFrom`'s KNOWN ASSUMPTION unchanged — the witness is
 * found beside the manifest, so it is dispatch's to write only while the
 * manifest's directory is dispatch's to fill, and a repo that commits its own
 * `run-context.json` can name any issue it likes. That buys nothing here: the
 * HOST run record is the authority on what admitted a run and this row is only
 * its corroboration, so a planted pair does not become an admission fact — it
 * becomes a record-vs-trace DIVERGENCE, which is the signal the audit walker
 * is looking for. Closing it properly is the same upgrade the cap wants: a
 * dispatch-owned location the author's tree cannot reach, or a signature.
 */
function witnessCorrelationBeside(
  manifestPath: string,
  runRoot: string,
  requestId: string,
): ResolvedRunCorrelation | undefined {
  const witnessPath = witnessPathBeside(manifestPath);
  let bytes: Buffer;
  try {
    ({ bytes } = readArtifactBeneathRoot(witnessPath, runRoot));
  } catch (err) {
    // ENOENT is the ONLY absence: a run driven by flags alone (tests, library
    // callers) has no witness beside its manifest and must still start a bare
    // session, silently.
    if (errnoOf(err) === "ENOENT") return undefined;
    // Every OTHER read failure is an ENVIRONMENT fault, not a statement about
    // the correlation, and it is raised as `WitnessUnreadableError` so the call
    // site can DEGRADE rather than abort (DF5.3 N1 — see the class above). It
    // is still fail-closed about the pair: no correlation is fabricated, the
    // session stays bare with honest NULL columns, and the degradation is
    // logged `recorded: false` so it is visible in the harvested engine log.
    //
    // SANITIZED and truncated like the parse refusal below, and for the same
    // reason: the hardened reader's refusals interpolate paths and the wrapped
    // errno, this message rides the engine log into the harvest tar, and
    // nothing here is worth an unbounded echo (INV-RUN-5).
    throw new WitnessUnreadableError(
      `the dispatch witness ${witnessPath} is unreadable, so the issue that authorized this run cannot be recorded: ${witnessEcho(err instanceof Error ? err.message : String(err))}`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString("utf8"));
  } catch (err) {
    // SHADOWED TODAY. `runContextFrom` runs one line before this reader at the
    // only call site and sends every PRESENT witness through
    // `admittedCeilingBeside`, which parses the same bytes and refuses a
    // non-JSON one first — so in `main` this branch and the unreadable one
    // above cannot fire, and the INV-RUN-5 mitigation that actually protects
    // the malformed-witness path is the one on THAT reader, not this one
    // (pinned: a `"{not json"` witness asserts `is unreadable`, never
    // `is not JSON`). BOTH manifest shapes, not just the capped one: the
    // pinned test's manifest declares no `limitMicroUsd`, and the undeclared
    // path consults the witness too whenever `witnessPresent` sees anything at
    // all there — the header's correlation-vs-ceiling note above says which
    // gap is actually left. The residue is the same lstat→read race the
    // unreadable branch keeps. Kept as a CONTRACT GUARD, not as live
    // protection: this
    // function refuses what it cannot verify, and must keep doing so if the
    // read order changes or a second caller appears. Deleting the try instead
    // would let a raw SyntaxError quoting witness bytes reach stderr
    // unsanitized — the failure the branch exists to prevent.
    //
    // SANITIZED and truncated on the same rule as everywhere else here: a
    // JSON.parse failure quotes a fragment of its input, and this message rides
    // the engine log into the harvest tar (INV-RUN-5: never prompt or
    // credential content, not even by accident).
    throw new Error(
      `the dispatch witness ${witnessPath} is not JSON (${witnessEcho(err instanceof Error ? err.message : String(err))})`,
    );
  }
  // A witness that parses but is not an OBJECT (`null`, `[]`, `42`, `"qds"`) is
  // a witness we cannot read — a truncated-then-flushed write, a stray shell
  // redirect — and gets the same fail-closed reading as an unreadable one.
  // Substituting `{}` instead read it as "no correlation" and started the bare
  // session with the NULL columns this change exists to close, indistinguishably
  // from a legitimately witness-less run. No bytes are echoed: the SHAPE is the
  // whole diagnosis.
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(
      `the dispatch witness ${witnessPath} is JSON but not an object (${parsed === null ? "null" : Array.isArray(parsed) ? "array" : typeof parsed}), so the issue that authorized this run cannot be read from it`,
    );
  }
  const w = parsed as {
    repoSlug?: unknown;
    issueId?: unknown;
    issueUrl?: unknown;
    requestId?: unknown;
  };
  // `null` is ABSENT, not a violation — JSON producers routinely emit an
  // explicit null for an omitted field (`deriveInBoxArgv` reads `requestId`
  // off this same file the same way).
  const absent = (v: unknown): boolean => v === undefined || v === null;
  // ABSENCE is all THREE correlation fields absent. `issueUrl` counts: a
  // witness carrying only the URL is half a correlation too — the shape a
  // truncated-then-flushed write or a partial hand edit leaves — and returning
  // before it was ever examined started the bare session with NULL columns and
  // no diagnostic, indistinguishable from a legitimately witness-less run,
  // while a witness missing only one of the PAIR refused loudly. If any of the
  // three is present, the full pair is required.
  if (absent(w.repoSlug) && absent(w.issueId) && absent(w.issueUrl)) return undefined;
  if (absent(w.repoSlug) || absent(w.issueId)) {
    throw new Error(
      `the dispatch witness ${witnessPath} carries half a correlation (repoSlug ${absent(w.repoSlug) ? "absent" : "present"}, issueId ${absent(w.issueId) ? "absent" : "present"})${absent(w.issueUrl) ? "" : " beside an issueUrl that names an issue neither half identifies"}: issue identity is the (repoSlug, issueId) pair and neither half is ever defaulted from the other (INV-RUN-3)`,
    );
  }
  if (typeof w.repoSlug !== "string") {
    throw new Error(`the dispatch witness ${witnessPath} carries a non-string repoSlug`);
  }
  if (!absent(w.issueUrl) && typeof w.issueUrl !== "string") {
    throw new Error(`the dispatch witness ${witnessPath} carries a non-string issueUrl`);
  }
  // The witness names the requestId it was written FOR (dispatch stamps it into
  // this same object, and `deriveInBoxArgv` passes it straight to `--request-id`
  // — so on the dispatched path these two are the same value by construction).
  // A difference means the witness and this invocation are not talking about the
  // same run: a hand re-run, a harness that rebuilt argv. Recording the pair
  // under THIS requestId would then file the corroboration under a key the audit
  // walker's record→trace join never reaches — it finds no sessions row, reports
  // `corroboration: "unavailable"` and STILL returns `resolved`, so the run
  // looks correlated while delivering nothing. Refuse, like the half pair.
  //
  // A PRESENT non-string requestId is refused FIRST. The mismatch test below is
  // `typeof === "string" && !==`, so every other present shape — a JSON number
  // (`12345`, the other honest spelling a hand-repaired witness carries, exactly
  // as `issueId` accepts), a bool, an object, an array — fell straight through
  // it and was read as "no requestId to disagree with". The run then recorded
  // its correlation under THIS invocation's id with a witness that names a
  // different one, which is precisely the silent mis-join the string check
  // exists to refuse. `repoSlug`, `issueUrl` and `issueId` all reject their
  // non-string shapes here; `requestId` was the one field that did not.
  if (!absent(w.requestId) && typeof w.requestId !== "string") {
    throw new Error(
      `the dispatch witness ${witnessPath} carries a ${Array.isArray(w.requestId) ? "array" : typeof w.requestId} requestId: requestId must be a string, and a witness whose correlation key cannot be compared to this invocation's cannot be shown to describe this run`,
    );
  }
  if (typeof w.requestId === "string" && w.requestId !== requestId) {
    throw new Error(
      `the dispatch witness ${witnessPath} was written for requestId ${witnessEcho(w.requestId)} but this invocation carries ${witnessEcho(requestId)}: the correlation would be recorded under a key the audit walker cannot join back to the run record`,
    );
  }
  // Dispatch writes `issueId` as a STRING — deliberately, so the witness, the
  // ledger key and the run record all spell the identity one way (see the
  // `String` note at the write in src/fleet/dispatch.ts). A JSON number is the
  // other honest spelling of the same field, and a hand-repaired witness will
  // carry it, so BOTH normalise here and nowhere else.
  //
  // A GATE, not a conversion condition. The digits-only test is the flag path's
  // own (`--issue`), character for character — but there it REFUSES, and using
  // it as a ternary condition here merely declined to convert: `" 1"`, `"+1"`,
  // `"1.0"`, `"0x10"` and `""` fell through as STRINGS and were handed to
  // `resolveRunCorrelation` through an `as number` cast that no check backed.
  // (That validator does test `Number.isInteger` before its bounds, so nothing
  // was actually admitted — but the cast was a type lie, and a bounds check that
  // ever moved ahead of the integer test would have coerced `" 1"` and `true`
  // into fabricated correlations.) Refusing here makes the two carriers accept
  // and refuse exactly the same strings, which is what the flag-parity claim
  // above is worth.
  //
  // BOTH SPELLINGS ARE GATED, and by the same rule. The string arm had the
  // digits-only test and the number arm had NOTHING — `issueId = w.issueId`,
  // delegating entirely to `resolveRunCorrelation` — so the parity claim was
  // half-enforced and the comment's own worry ("a bounds check that ever moved
  // ahead of the integer test would have coerced…") applied to the unguarded
  // side. The JSON-number spelling of "decimal digits alone" is a NON-NEGATIVE
  // INTEGER: `-1`, `7.5` and `1e21` are refused here exactly as `"-1"`, `"7.5"`
  // and `"1e21"` are. BOUNDS stay `resolveRunCorrelation`'s on both arms and
  // are deliberately NOT restated: `0` and `2**31` pass this gate in either
  // spelling and are refused downstream as "invalid correlation", which is what
  // keeps the two carriers from drifting apart from the flag path.
  const malformedIssueId = (): Error =>
    new Error(
      `the dispatch witness ${witnessPath} carries a malformed issueId: issueId must be a positive integer written in decimal digits alone, the same test \`--issue\` applies (got ${witnessEcho(JSON.stringify(w.issueId), 80)})`,
    );
  let issueId: number;
  if (typeof w.issueId === "string") {
    if (!/^\d+$/.test(w.issueId)) throw malformedIssueId();
    issueId = Number(w.issueId);
  } else if (typeof w.issueId === "number") {
    if (!Number.isInteger(w.issueId) || w.issueId < 0) throw malformedIssueId();
    issueId = w.issueId;
  } else {
    throw new Error(
      `the dispatch witness ${witnessPath} carries a ${Array.isArray(w.issueId) ? "array" : typeof w.issueId} issueId: issueId must be a positive integer <= ${MAX_ISSUE_ID}, as a JSON number or a digits-only string`,
    );
  }
  try {
    const correlation = resolveRunCorrelation({
      repoSlug: w.repoSlug,
      // No cast: the gate above is what makes this a number, so the compiler
      // enforces the check rather than documenting it. Integerness and the
      // 1..MAX_ISSUE_ID bounds stay `resolveRunCorrelation`'s, not a second
      // opinion that can drift from the flag path's.
      issueId,
      // A zero-length `issueUrl` is ABSENT, not a link. `parseValueFlags`
      // refuses an empty value for `--issue-url`, so the flag carrier cannot
      // express it; forwarding it wrote `sessions.issue_url = ""`, which is
      // neither a link nor an honest NULL.
      ...(typeof w.issueUrl === "string" && w.issueUrl.length > 0
        ? { issueUrl: w.issueUrl }
        : {}),
    });
    return { ...correlation, requestId };
  } catch (err) {
    // SANITIZED and truncated like the branches above: `resolveRunCorrelation`
    // quotes the offending value (`INVALID_REPO_SLUG` ends `(got ${JSON.
    // stringify(brief.repoSlug)})`), so a token-shaped slug in a witness would
    // otherwise ride the engine log home verbatim (INV-RUN-5).
    throw new Error(
      `the dispatch witness ${witnessPath} carries an invalid correlation: ${witnessEcho(err instanceof Error ? err.message : String(err))}`,
    );
  }
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
    // `cause`, so the absence test walks that chain (`errnoOf`, shared with
    // the correlation reader above — one walk, one definition of "absent").
    if (errnoOf(err) !== "ENOENT") {
      // SANITIZED and truncated on the same rule as every branch of
      // `witnessCorrelationBeside` (INV-RUN-5): same witness, same stderr sink,
      // same harvest tar — and this is the one path that CONTINUES rather than
      // refusing, so it is the one that always reaches the harvest. An
      // unbounded echo also lets a junk witness flood the engine log through
      // the wrapped reader's message.
      writeAll(
        2,
        `pipeline-run: warning: resident brief source ${witnessPathBeside(manifestPath)} is unreadable (${witnessEcho(err instanceof Error ? err.message : String(err))}) — continuing without a resident\n`,
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
      // repoRoot: runRoot — the SAME anchor dispatch_task resolves its roster
      // with (this set must agree with the phase's own resolution, or the
      // closed set is computed from a roster the phase will refuse, or vice
      // versa). defaultRepoRoot() names /opt/qds-factory in the image, not the
      // run's checkout; see dispatch-task's call site for the live finding.
      for (const role of loadRoster(spec.roster, { cwd: runRoot, repoRoot: runRoot }).roles) ids.add(role.name);
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
type RunnerSolicitCtx = SolicitCtx & {
  phaseIds?: readonly string[];
  /** DF1.10: the ENGINE's phaseId (not the manifest name `phase` carries), so
   *  a solicitation line joins the phase_started/phase_settled pair around it.
   *  Absent on the run_start/run_end points, which are outside every phase. */
  phaseId?: string;
};

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
          phaseId: ctx.phaseId ?? null,
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
        phaseId: ctx.phaseId ?? null,
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
  ctx: { repoSlug: string | null; issueId: number | string | null; requestId: string | null },
  err: unknown,
): number {
  const rawCode = err instanceof Error ? (err as Error & { code?: unknown }).code : undefined;
  const code = typeof rawCode === "string" && rawCode.length > 0 ? rawCode : "RUN_INIT_FAILED";
  const message = err instanceof Error ? err.message : String(err);
  try {
    // BASE root, not the per-run tree (#217 F-D1): this is the operator's
    // one place to look when a dispatch refuses — burying it inside
    // qds-run/<id>/ would move it per invocation, and a refusal here can fire
    // before any per-run identity is even resolved.
    appendDispatchFailure(path.join(unidentifiedRunRoot(), "dispatch-failures.log"), {
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

/** The terminal marker is one line of `{runId, ok, completedAt}`. Anything
 *  larger is not a marker this engine wrote, and is read as carrying no
 *  verdict rather than parsed. */
const MARKER_MAX_BYTES = 4096;

/** `journalReclaimRefusal`'s read ceiling. A journal is rewritten whole every
 *  phase and a healthy one stays kilobytes-small; anything past a MiB is not
 *  read, and lands in that guard's unparseable arm — the fail-closed one. */
const JOURNAL_RECLAIM_MAX_BYTES = 1024 * 1024;

/** What a refusal reports. `markerRunId` is the identity the marker claimed —
 *  `null` when it named none — so a foreign marker is diagnosable from the
 *  event alone, without the operator having to go read `/run` on a box the
 *  next command may tear down. */
interface ReplayRefusal {
  exitCode: number;
  code: string;
  message: string;
  remediation: string;
  markerRunId?: string | null;
}

/**
 * The marker, read bounded and without following a symlink.
 *
 * `lstat` has already proved the path is a regular file of a sane size, but
 * the two syscalls are not atomic and this is the one file on this path that
 * something outside the engine can swap. `O_NOFOLLOW` refuses a symlink put
 * there in between; `O_NONBLOCK` closes the same window for a FIFO — an
 * `O_RDONLY` open of a FIFO with no writer would park the engine on a syscall
 * that never returns, and the fail-closed posture this guard keeps is a
 * refusal, never a hang. A no-op for regular files; a FIFO that slipped in
 * reads empty or EAGAIN, both of which land in the no-verdict refusal below.
 * The fixed buffer means a file grown between the stat and the read costs a
 * page, not a heap.
 */
function readMarkerBytes(markerPath: string, max: number): string {
  const fd = fs.openSync(
    markerPath,
    fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK,
  );
  try {
    const buf = Buffer.alloc(max);
    const n = fs.readSync(fd, buf, 0, max, 0);
    return buf.subarray(0, n).toString("utf8");
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * DF1.10 AC6: why this invocation must not walk, or `null` to proceed.
 *
 * `lstat`, not `stat` and not `existsSync`, for one reason each:
 *  - not `existsSync`, because it collapses EACCES/ENOTDIR into `false` — a
 *    marker the engine cannot reach would read as "no marker" and the run would
 *    be re-walked, which is the exact double-spend the check exists to stop;
 *  - not `stat`, because it follows symlinks, so a DANGLING symlink planted at
 *    the marker path would answer ENOENT while something is plainly there.
 *
 * The body IS read, for two decisions the marker's PRESENCE alone cannot make:
 *
 *  - **`runId`, as defence in depth on a path that is now per-run (#217
 *    F-D1).** `runMarkerPath(runId)` is
 *    `<QDS_RUN_ROOT ?? /run>/qds-run/<runId>/journal/final.json`, so two
 *    DIFFERENT runs no longer share a marker by construction: the unit's
 *    per-instance `RuntimeDirectory=qds-run/%i/…` creates a private root per
 *    runId, and the serial `qds-run@A`-then-`qds-run@B` overlap that used to
 *    carry A's marker into B's tmpfs is gone image-side. The body check stays
 *    because the layout is a DERIVATION, not an enforcement: a hand-built
 *    invocation, a `QDS_RUN_ROOT` base that relocates every run under one
 *    tree, or a box where something wrote into another run's root all put a
 *    stranger's verdict on THIS run's path — and mirroring it would report
 *    this run as settled, exit 0, without walking a single phase, while a
 *    dispatcher reads that as success. A marker naming another run is
 *    therefore refused with its own code and a NON-zero exit: a foreign
 *    statement sitting on the path this run is about to write to is an unsafe
 *    state, not a verdict.
 *  - **`ok`, to mirror the verdict of a marker that IS this run's.** The path
 *    here is not systemd — `Restart=no` never re-runs the unit. It is an
 *    operator or a dispatcher invoking `fleet run <id>` a second time after the
 *    unit went inactive, which starts a fresh engine that lands on this check.
 *    Reporting FAILURE for "the work you asked for is already done, and it
 *    succeeded" is wrong: idempotence is what makes an unattended factory safe
 *    to retry, and exit 2 has to keep meaning "genuinely could not settle" or it
 *    stops being an actionable signal. It also narrows DF1.8's shipped INV-RUN-1
 *    ack far less: for a settled-ok run the OUTCOME is exactly what DF1.8
 *    promised — exit 0, no re-walk. Only the event differs, and
 *    `engine_refused_replay` says more there than `run_initiated{replayed:true}`.
 *
 * Two identities count as "this run's marker", because the engine has two ways
 * of being named and only one of them is known here. A bare invocation carries
 * its `--run-id` (the in-box shape: the unit passes `%i` and `deriveInBoxArgv`
 * turns it into the flag). A CORRELATED invocation has no `--run-id` at all —
 * it adopts the resolved `requestId` as its runId, and that resolution happens
 * 150 lines below this check, deliberately: the refusal must precede the
 * correlation ladder. So the requestId is accepted as an identity too; without
 * it every correlated replay would read as foreign, which is the false positive
 * that would cost DF1.8's ack. The `run` front door's pre-witness check passes
 * the runId alone (`requestId` absent, never matched): the requestId rides the
 * witness that check exists to precede, and a front-door run always settles
 * under its `--run-id` — it is the only identity that front door ever passes.
 *
 * The requestId identity is gated on `requestIdIsIdentity` — the invocation
 * did NOT name its own `--run-id` — because the correlated shape the carve-out
 * exists for never carries one (RUN_ID_CONFLICT refuses `--run-id` with
 * `--repo-slug` outright), while an invocation passing BOTH `--run-id Y` and
 * `--request-id X` names two DIFFERENT runs at once: accepting X's marker for
 * it mirrored X's verdict onto a Y that never existed and never spent (a
 * dispatcher polling on Y read a success that belonged to X). The journal's
 * twin check below carries the same gate, for the same reason.
 *
 * Everything the marker cannot answer is a refusal, never a proceed: an
 * unparseable, oversized, non-regular or verdictless marker still proves a
 * previous engine got as far as writing one.
 */
function markerReplayRefusal(
  markerPath: string,
  ids: { runId: string; requestId?: string; requestIdIsIdentity?: boolean },
  journalPath: string,
): ReplayRefusal | null {
  const reclaim =
    "this run is over: `fleet harvest <run-id>` pulls its evidence and `fleet teardown <run-id>` reclaims the box. To run again, dispatch a NEW run — the journal has no attempt column and this engine adds none, so re-walking would overwrite a `fail` row that was recorded deliberately (INV-IBOX-6)";
  // `lstat` FIRST and separately from the read: it is the one probe that
  // distinguishes "nothing is there" from "something is there I cannot use",
  // and only the former may proceed.
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(markerPath);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    // The only positive answer that nothing is there — and the arm where the
    // DURABLE half of the same question still has to be asked, because `/run`
    // is tmpfs and its answer does not survive a reboot.
    if (code === "ENOENT") return journalReclaimRefusal(journalPath, reclaim, ids);
    return {
      // 2 — the honest "could not settle": this invocation settled nothing AND
      // could not read what the previous one settled, so it has no verdict to
      // mirror. The mirror branch below DOES have one.
      exitCode: 2,
      code: "ENGINE_MARKER_UNREADABLE",
      message: `the terminal marker ${markerPath} could not be examined (${sanitizeForMessage(code ?? "unknown error")}), so this run cannot be shown to be unstarted`,
      remediation: `refusing rather than re-walking a run whose phases may already have spent money and made commits. Fix the marker root's permissions (in the box it is the per-run /run/qds-run/<runId> tree, 0700, owned by the engine's user) and re-check, or treat the run as finished: ${reclaim}`,
    };
  }
  if (!stat.isFile()) {
    // A symlink, FIFO or directory at the marker path. `lstat` proved something
    // is there, so this cannot proceed — and it must not be READ either: a
    // symlink would be followed to a `{"ok":true}` of someone else's choosing,
    // and a FIFO would block the engine forever on a read that never returns.
    return {
      exitCode: 2,
      code: "ENGINE_MARKER_UNREADABLE",
      message: `the terminal marker ${markerPath} is not a regular file, so it is not a marker any engine wrote and its contents are not read`,
      remediation: `refusing rather than re-walking a run whose phases may already have spent money and made commits. Remove whatever is at that path only if you are certain the run never settled; otherwise ${reclaim}`,
    };
  }

  let body: { runId?: unknown; ok?: unknown } | undefined;
  let readFault: string | null = null;
  if (stat.size <= MARKER_MAX_BYTES) {
    let text: string | undefined;
    try {
      text = readMarkerBytes(markerPath, MARKER_MAX_BYTES);
    } catch (err) {
      // An open/read fault (EACCES, or ELOOP from a symlink swapped into the
      // lstat→read window hitting O_NOFOLLOW) is a PERMISSIONS fault, not a
      // content fault — diagnosing it as "not one line of JSON" sends the
      // operator digging through the file's bytes for what is wrong with its
      // mode bits.
      readFault = sanitizeForMessage((err as NodeJS.ErrnoException).code ?? "unknown error");
    }
    if (text !== undefined) {
      try {
        const parsed: unknown = JSON.parse(text);
        if (parsed !== null && typeof parsed === "object") body = parsed;
      } catch {
        /* unparseable — the no-verdict branch below */
      }
    }
  }
  if (body === undefined) {
    if (readFault !== null) {
      return {
        // `lstat` could examine it but the open could not read it: same honest
        // 2 as the unstattable case, with the diagnosis pointed at the
        // permissions/symlink fault instead of the marker's content.
        exitCode: 2,
        code: "ENGINE_MARKER_UNREADABLE",
        message: `the terminal marker ${markerPath} is a regular file this engine could not open or read (${readFault}) — a permissions or symlink fault, not a content fault`,
        remediation: `refusing rather than re-walking a run whose phases may already have spent money and made commits. Fix the marker root's permissions (in the box it is the per-run /run/qds-run/<runId> tree, 0700, owned by the engine's user) and re-check, or treat the run as finished: ${reclaim}`,
      };
    }
    return {
      // Present but illegible: a zero-byte or half-written marker is what a
      // power loss mid-write to tmpfs leaves, and an oversized one is not a
      // marker this engine wrote. Same honest 2 as the unstattable case.
      exitCode: 2,
      code: "ENGINE_MARKER_UNUSABLE",
      message: `the terminal marker ${markerPath} exists but could not be read as one line of JSON within ${MARKER_MAX_BYTES} bytes, so a previous engine settled this run with a verdict this one cannot read`,
      remediation: `the run is still over and must not be re-walked. ${reclaim}`,
    };
  }
  // A no-flag replay of a CORRELATED run reaches this arm by design: its
  // requestId resolves through the correlation ladder 150 lines below this
  // guard, so unless the resolved id arrives on --request-id the comparison
  // runs against ids minted moments ago. Correlated no-flag replays are
  // excluded from mirror semantics on purpose — moving the guard after the
  // ladder would put a trace-store read ahead of the replay check — and the
  // refusal below says so instead of presenting the fresh uuid as a run that
  // ever existed.
  if (
    body.runId !== ids.runId &&
    (!ids.requestIdIsIdentity || ids.requestId === undefined || body.runId !== ids.requestId)
  ) {
    const claimed = typeof body.runId === "string" ? body.runId : null;
    const correlatedNote = ids.requestIdIsIdentity
      ? " This invocation named no --run-id, so the id it was compared under is not a settled run's identity: a correlated retry's requestId resolution happens after this guard, and a replay that reaches it without carrying the resolved id is excluded from mirror semantics by design"
      : "";
    return {
      exitCode: 2,
      code: "ENGINE_MARKER_FOREIGN",
      markerRunId: claimed,
      message: `the terminal marker ${markerPath} was written by run ${claimed === null ? "(unnamed)" : sanitizeForMessage(claimed)}, not by ${sanitizeForMessage(ids.runId)}: it is not this run's verdict and is not mirrored.${correlatedNote}`,
      remediation: `the marker path (${markerPath}) is one per run ROOT. In the box /run outlives the unit that wrote it, so a second run on the same box lands on the first one's marker; outside the box, an exported QDS_RUN_ROOT shared across runs does the same — the engine honours the variable (journal.ts's documented residual hazard) and cannot tell a reused box from a reused root. Harvest and tear down the run named in the marker before starting another on this box, or give this run its own box (one box per run is the DF1.10 shape); on a deliberately shared dev/CI root, removing ${markerPath} by hand after harvesting is what re-arms it. ${reclaim}`,
    };
  }
  if (typeof body.ok !== "boolean") {
    return {
      // This run's marker, carrying no verdict. Refusing is not in question —
      // something settled here — but there is nothing to mirror, and guessing
      // `ok` in either direction would be worse than saying so.
      exitCode: 2,
      code: "ENGINE_MARKER_UNUSABLE",
      markerRunId: typeof body.runId === "string" ? body.runId : null,
      message: `the terminal marker ${markerPath} exists but carries no boolean 'ok', so a previous engine settled this run with a verdict this one cannot read`,
      remediation: `the run is still over and must not be re-walked. ${reclaim}`,
    };
  }
  const ok = body.ok;
  return {
    // The previous engine's own verdict, re-reported. INV-IBOX-7 is untouched:
    // this mirrors a marker, it does not vouch for one.
    exitCode: ok ? 0 : 1,
    code: "ENGINE_MARKER_PRESENT",
    markerRunId: body.runId as string,
    message: `run already settled ${ok ? "ok" : "not-ok"}: the terminal marker ${markerPath} exists, so a previous engine walked this run to completion`,
    remediation: reclaim,
  };
}

/**
 * DF1.10 AC6, the DURABLE half — asked only when the marker is absent.
 *
 * The marker lives on `/run`, which is tmpfs: a REBOOT wipes it while `$HOME`
 * (ext4) keeps `<runId>.journal.jsonl`. Marker-absence therefore proves "no
 * engine settled this run" only for as long as the box stays up, and the
 * journal is the one artefact that can still tell "nothing ever ran" apart from
 * "an engine ran, spent money and made commits, and was killed or rebooted
 * before it could settle". Both are AC6's case — INV-IBOX-6 says no path
 * re-executes a phase already paid for, and it does not except the crash.
 *
 * It is also what stops the retry DESTROYING that evidence. `new FileJournal`
 * flushes an empty journal over its path in its constructor, before phase 1
 * runs, so an invocation that got past here would overwrite the crashed
 * attempt's phase rows — the only record of what already spent. The sibling
 * `--engine-log` opens `O_APPEND` for exactly this reason; this is the same
 * argument for the file that carries the verdicts rather than the log.
 *
 * NOT a mirror, deliberately: a run with no marker has no verdict to mirror
 * (that is what the missing marker MEANS), so exit 2 — "genuinely could not
 * settle" — is the only honest code, and the rows themselves are the evidence
 * the operator reads next.
 *
 * An empty journal proceeds: a header-only file is what a run that died before
 * its first phase leaves, and re-walking that re-spends nothing. Everything
 * else about a PRESENT journal refuses — the same fail-closed posture the
 * marker keeps: an unreadable one (ENGINE_JOURNAL_UNREADABLE), or a non-empty
 * one that will not read as the single JSON document every flush writes whole
 * (ENGINE_JOURNAL_UNUSABLE, which is also where an over-cap read lands — the
 * read is bounded at JOURNAL_RECLAIM_MAX_BYTES), cannot show the run UNSTARTED,
 * and proceeding would hand `new FileJournal` a truncating flush over the only
 * copy. The old proceed-on-unparseable arm was fail-open in exactly the
 * double-spend direction this guard exists for; an unwritable journal path
 * still refuses at the FileJournal constructor a moment later, so nothing is
 * stranded that was not already broken.
 *
 * The journal's OWN `runId` (stamped on every flush, journal.ts) is compared
 * before diagnosing ORPHANED: a file carrying rows stamped for ANOTHER run is
 * a dirty `--journal` path, not evidence this run was walked and killed, and
 * the ORPHANED remediation ("read the journal for what settled" — of a run
 * this invocation never was) would point the operator at the wrong spend. The
 * refusal stands either way — the constructor's truncating flush would destroy
 * the foreign rows — but the diagnosis and the remediation are its own. The
 * same two identities the marker accepts (runId, requestId) count as "this
 * run's journal", for the same reason: a correlated retry's id is not resolved
 * yet at the point this runs — and under the same `requestIdIsIdentity` gate
 * as the marker's check (see there).
 */
/**
 * #217 F-D1 — the identity a per-run marker/claim root is keyed on.
 *
 * An invocation with `--run-id` is keyed on it. A CORRELATED invocation (no
 * `--run-id`) is keyed on its `--request-id`: the id it will adopt as its
 * runId once the correlation ladder resolves (which happens AFTER the replay
 * guard, by design), and the id a dispatch retry re-passes — so both attempts
 * of one correlated run derive the SAME root and the guard still sees the
 * first attempt's marker. A fully UNNAMED invocation (neither flag) returns
 * `undefined` and keeps the legacy shared root, where a second unnamed
 * attempt finds the first's marker and refuses `ENGINE_MARKER_FOREIGN` — the
 * fail-closed arm the per-run layout would otherwise have silently deleted.
 */
function rootIdentityKey(ids: {
  runId: string;
  requestId?: string;
  requestIdIsIdentity?: boolean;
}): string | undefined {
  if (ids.requestIdIsIdentity === true) return ids.requestId;
  return ids.runId;
}

/** The marker/claim root for the identity above — shared legacy root when unnamed. */
function markerRootFor(id: string | undefined): string {
  return id === undefined ? unidentifiedRunRoot() : runMarkerRoot(id);
}

/** The marker path for the identity above — `<base>/journal/final.json` when unnamed. */
function runMarkerPathFor(id: string | undefined): string {
  return id === undefined ? path.join(unidentifiedRunRoot(), "journal", "final.json") : runMarkerPath(id);
}

function journalReclaimRefusal(
  journalPath: string,
  reclaim: string,
  ids: { runId: string; requestId?: string; requestIdIsIdentity?: boolean },
): ReplayRefusal | null {
  // Fail-closed split, mirroring the marker's own conventions: ENOENT (and an
  // empty file) is the never-started run and proceeds; a journal that is
  // present but cannot be examined or parsed REFUSES.
  const unreadable = (fault: string): ReplayRefusal => ({
    exitCode: 2,
    code: "ENGINE_JOURNAL_UNREADABLE",
    message: `the journal ${journalPath} exists but could not be examined (${fault}), so this run cannot be shown to be unstarted`,
    remediation: `refusing rather than re-walking a run whose phases may already have spent money and made commits. Fix the journal path's permissions and re-check, or give this invocation a --journal path of its own`,
  });
  const unusable = (why: string): ReplayRefusal => ({
    exitCode: 2,
    code: "ENGINE_JOURNAL_UNUSABLE",
    message: `the journal ${journalPath} is non-empty but ${why}, so whether a previous engine already walked and spent here cannot be read from it`,
    remediation: `refusing rather than re-walking phases whose spend may already have happened, and rather than letting the FileJournal constructor truncate the only copy before anyone read it (INV-IBOX-6). Inspect the file by hand: debris from a run that never started can be removed, or point --journal elsewhere; if it carries real rows, ${reclaim}`,
  });
  let stat: fs.Stats;
  try {
    stat = fs.statSync(journalPath);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    // The only positive answer that nothing is there — the never-started run.
    if (code === "ENOENT") return null;
    return unreadable(sanitizeForMessage(code ?? "unknown error"));
  }
  // Over-cap is treated as the unparseable arm — fail-closed, and never a
  // truncated read that could parse as something it is not.
  if (stat.size > JOURNAL_RECLAIM_MAX_BYTES) {
    return unusable(`is ${stat.size} bytes, above the ${JOURNAL_RECLAIM_MAX_BYTES}-byte ceiling this guard reads`);
  }
  let text: string;
  try {
    text = readMarkerBytes(journalPath, JOURNAL_RECLAIM_MAX_BYTES);
  } catch (err) {
    return unreadable(sanitizeForMessage((err as NodeJS.ErrnoException).code ?? "unknown error"));
  }
  // Empty or whitespace-only: what a run that died before its first phase
  // (plus the constructor's header flush) leaves — the never-started shape.
  if (text.trim().length === 0) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return unusable("could not be parsed as JSON");
  }
  if (parsed === null || typeof parsed !== "object") {
    return unusable("is not a JSON object");
  }
  const file = parsed as { phases?: unknown; runId?: unknown };
  const phases = file.phases;
  if (!Array.isArray(phases) || phases.length === 0) return null;
  const journalRunId = typeof file.runId === "string" ? file.runId : null;
  if (
    journalRunId !== null &&
    journalRunId !== ids.runId &&
    (!ids.requestIdIsIdentity || ids.requestId === undefined || journalRunId !== ids.requestId)
  ) {
    return {
      exitCode: 2,
      code: "ENGINE_JOURNAL_FOREIGN",
      message: `the journal ${journalPath} already carries ${phases.length} phase row(s) stamped for run ${sanitizeForMessage(journalRunId)}, not for this invocation (${sanitizeForMessage(ids.runId)}): another run's journal occupies this --journal path`,
      remediation: `refusing rather than truncating another run's evidence (new FileJournal rewrites this path in full, destroying the only record of what that run spent). Give this invocation a --journal path of its own; ${journalPath} belongs to the run named above and is what to read for what settled there`,
    };
  }
  // Rows + no marker reads as "crashed", but this guard runs BEFORE claim
  // acquisition: a LIVE engine A mid-walk on this root (claim held, marker not
  // yet written, its rows already on disk) and a retried invocation land here
  // TOGETHER, and the harvest/teardown remediation below would destroy a box
  // whose run is still spending and committing. Probe the claim the crash
  // diagnosis never consulted; `kill -0` decides liveness (EPERM counts as
  // alive: the process exists even when this user cannot signal it).
  let holder: ReturnType<typeof readEngineClaimHolder> | null = null;
  const claimPath = engineClaimPath(markerRootFor(rootIdentityKey(ids)));
  try {
    fs.lstatSync(claimPath);
    holder = readEngineClaimHolder(claimPath);
  } catch {
    /* no claim (or an unreadable one): the rows-alone diagnosis below stands */
  }
  if (holder !== null && holder.runId !== null) {
    let alive = false;
    if (holder.pid !== null) {
      try {
        process.kill(holder.pid, 0);
        alive = true;
      } catch (err) {
        alive = (err as NodeJS.ErrnoException).code === "EPERM";
      }
    }
    if (alive) {
      return {
        exitCode: 2,
        code: "ENGINE_JOURNAL_ORPHANED",
        message: `the journal ${journalPath} already carries ${phases.length} phase row(s), no terminal marker exists, and a claim on this root is held RIGHT NOW by run ${holder.runId} (pid ${holder.pid}, since ${holder.startedAt ?? "(unreadable)"}): an engine is LIVE on this root and these rows are most likely its, mid-walk — this is not a crash`,
        remediation: `do NOT harvest or tear the box down — that would destroy a run that is still spending and committing. Wait for the holding engine to settle or release its claim (it is removed on every exit path), then re-run: a settled run mirrors its marker instead of reaching this refusal. If no engine is visibly running yet this refusal persists, suspect pid REUSE: the claim records the holder's pid, and \`kill -0 <pid>\` (or \`ps -p <pid>\`) exiting 0 does not prove that pid is still the ENGINE — a dead engine's pid can name an unrelated process now. Confirm the engine process is really gone, then remove ${claimPath} by hand (the claim, never the journal) and retry`,
      };
    }
    // Not alive (or no pid to ask): a stale claim beside orphaned rows is the
    // SIGKILLed-engine shape — the note below names it so the operator is not
    // left wondering why a claim file survives the crash they are reading.
  }
  // A journal with rows but NO runId stamp cannot say WHOSE rows they are —
  // asserting "this run" would send this invocation's operator to read a spend
  // that may belong to a run they never started.
  const owner =
    journalRunId === null
      ? "a previous engine walked here — the journal stamps no runId, so whether that was THIS invocation's run is unknowable — and settled no marker (killed mid-walk, or the box rebooted, wiping tmpfs /run)"
      : "a previous engine walked this run and was killed (or the box rebooted, wiping tmpfs /run) before it could settle";
  return {
    exitCode: 2,
    code: "ENGINE_JOURNAL_ORPHANED",
    message: `the journal ${journalPath} already carries ${phases.length} phase row(s) but no terminal marker exists: ${owner}`,
    remediation: `refusing rather than re-walking phases whose spend and commits already happened, and rather than truncating the rows that are the only record of them (INV-IBOX-6). Read the journal for what settled, then ${reclaim}`,
  };
}

/**
 * DF1.10 AC6, the guard as a callable: run `markerReplayRefusal`, emit its
 * event, and hand back the exit code to leave with — `null` when nothing
 * refused and the caller may proceed.
 *
 * Two doorways need it (AC6 round 3 / edge M1): the flag path runs it BEFORE
 * `loadManifest`, and the `run` front door runs it BEFORE the witness read
 * `deriveInBoxArgv` performs — both reads live in the customer checkout, the
 * one tree the run's own code phases are free to rewrite, so a settled run
 * must mirror on its marker (the run-marker root, which a phase cannot reach)
 * even when its own phases have since deleted the manifest pair. Sharing one
 * helper keeps the two doorways on the same event and the same refusal codes.
 */
function replayRefusalExit(
  markerPath: string,
  ids: { runId: string; requestId?: string; requestIdIsIdentity?: boolean },
  journalPath: string,
): number | null {
  const replay = markerReplayRefusal(markerPath, ids, journalPath);
  if (replay === null) return null;
  // The exit code MIRRORS the marker (0/1) where the marker is this run's and
  // has a verdict, and is 2 everywhere else — see `markerReplayRefusal`. The
  // event fires either way: a mirrored 0 must still be distinguishable from a
  // run this invocation actually walked.
  const { exitCode, markerRunId, ...error } = replay;
  emitEngineEvent(
    "engine_refused_replay",
    { runId: ids.runId, requestId: ids.requestId ?? null, phaseId: null },
    {
      markerPath,
      // The identity the marker claimed, so "someone else's marker" is legible
      // from the log line rather than only from a box that may be torn down.
      markerRunId: markerRunId ?? null,
      exitCode,
      error,
    },
  );
  return exitCode;
}

/**
 * DF1.10 AC6 / #217 F-D1 — the TypeScript half of the concurrent-engine
 * guard. The replay check above is check-then-act: two engines against one
 * run ROOT can both pass `markerReplayRefusal` in the window before either
 * writes the terminal marker, both walk, and the last marker write wins —
 * on a shared root (`RuntimeDirectory` literals in the pinned image, an
 * exported `QDS_RUN_ROOT` outside it) that is concurrent double spend, the
 * exact exposure F-D1 names.
 *
 * The claim is PER ROOT, matching the marker's granularity —
 * `runMarkerPath(runId)` is `<root>/journal/final.json` with `<root>`
 * itself derived from the runId (#217 F-D1), so per-root IS per-run for
 * every invocation that reaches this code with the same id: the race that
 * remains is a RETRY (the same runId started twice — a lost marker plus a
 * re-dispatch, or an operator doubling a hand-built argv), and both racers
 * derive the same root and the same claim. It is acquired O_EXCL immediately after the replay
 * guard passes and before `loadManifest`/`new FileJournal`, so a losing
 * engine refuses before reading the checkout or constructing a journal;
 * it is removed on every exit path (the settle `finally` plus the
 * process-`exit` hook `main`'s only caller guarantees runs — `main` is
 * unexported and the bootstrap always exits). Only an unhandled kill escapes
 * both — SIGKILL itself, plus the default-disposition kills no handler here
 * covers (SIGHUP, SIGQUIT, an unconfigured SIGUSR1/SIGUSR2) — and the claim
 * any of them leaves behind refuses LOUDLY with the removal remediation
 * below — fail-closed, never silently re-armed.
 *
 * Sequential last-write-wins on a deliberately shared root is unchanged
 * pre-existing semantics (see `markerReplayRefusal`'s remediation): the
 * claim closes the CONCURRENT window, it does not police root reuse.
 * The image-side half — per-instance `RuntimeDirectory` so two units
 * never share the root at all — rides the re-pin bundle (#217).
 */
function engineClaimPath(markerRoot: string): string {
  return path.join(markerRoot, "journal", "engine.claim");
}

/** Bounded best-effort read of a surviving claim, for the refusal's holder line. */
function readEngineClaimHolder(claimPath: string): {
  runId: string | null;
  pid: number | null;
  startedAt: string | null;
} {
  try {
    const parsed: unknown = JSON.parse(readMarkerBytes(claimPath, 512));
    if (parsed === null || typeof parsed !== "object") return { runId: null, pid: null, startedAt: null };
    const c = parsed as Record<string, unknown>;
    return {
      runId: typeof c.runId === "string" ? sanitizeForMessage(c.runId) : null,
      pid: typeof c.pid === "number" && Number.isInteger(c.pid) ? c.pid : null,
      startedAt: typeof c.startedAt === "string" ? sanitizeForMessage(c.startedAt) : null,
    };
  } catch {
    return { runId: null, pid: null, startedAt: null };
  }
}

/**
 * Acquire the root claim, or emit the refusal and hand back its exit code.
 * `ENGINE_CLAIM_UNWRITABLE` is fail-closed on purpose: a root whose journal
 * dir cannot carry a 0600 file cannot carry the terminal marker either, and
 * a run that paid for its phases only to die at the marker write is the
 * double-spend shape this guard exists to prevent — refuse BEFORE the walk.
 */
function acquireEngineClaim(
  markerRoot: string,
  ids: { runId: string; requestId?: string },
  journalPath: string,
): { ok: true; claimPath: string; claimBody: string } | { ok: false; exitCode: number } {
  const claimPath = engineClaimPath(markerRoot);
  // True the moment O_EXCL succeeds: from there the file EXISTS on disk, and a
  // later failure in this block (write, fsync, close) must not leave it behind
  // ownerless — the exit hook that would remove it registers only on ok:true.
  let opened = false;
  const claimDir = path.dirname(claimPath);
  try {
    fs.mkdirSync(claimDir, { recursive: true, mode: 0o700 });
    // mkdir's `mode` applies only at CREATION — a journal dir pre-existing at a
    // looser mode (an older engine's mode-less mkdir) keeps its group/other
    // bits, while the ENGINE_MARKER_UNREADABLE remediation tells the operator
    // it is 0700. Strip the group/other bits explicitly, mirroring the traceDir
    // block in `main` — but never GRANT owner bits: a deliberately read-locked
    // dir (0500) stays read-locked and fails the open below, rather than being
    // quietly re-opened for writing.
    fs.chmodSync(claimDir, fs.statSync(claimDir).mode & 0o700);
    const fd = fs.openSync(
      claimPath,
      fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW,
      0o600,
    );
    opened = true;
    // The exact bytes come back to the caller: the release must be
    // OWNERSHIP-CHECKED (see the release comment at the call site), so the
    // comparison needs the body as written — not a reconstruction.
    const claimBody = `${JSON.stringify({ runId: ids.runId, pid: process.pid, startedAt: new Date().toISOString() })}\n`;
    try {
      fs.writeFileSync(fd, claimBody);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    return { ok: true, claimPath, claimBody };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code !== "EEXIST") {
      // Post-open failure (ENOSPC/EIO on the write or fsync, a throwing close):
      // the claim file was created by the openSync and nothing is wired to
      // remove it — the exit hook below registers only on ok:true. Remove it
      // before refusing, or every later engine on this root refuses
      // ENGINE_RUN_CLAIMED ("not a readable claim") until a human does this rm.
      if (opened) {
        try {
          fs.rmSync(claimPath, { force: true });
        } catch {
          /* best-effort: a surviving claim refuses the next engine loudly */
        }
      }
      emitEngineEvent(
        "engine_refused_claim",
        { runId: ids.runId, requestId: ids.requestId ?? null, phaseId: null },
        {
          claimPath,
          journalPath,
          exitCode: 2,
          error: {
            code: "ENGINE_CLAIM_UNWRITABLE",
            message: `the engine claim ${claimPath} could not be created or made durable (${sanitizeForMessage(code ?? "unknown error")}): the terminal marker needs the same directory at settle, so a run started now could pay for its phases and die unable to commit its verdict`,
            remediation: `fix the permissions on ${path.dirname(claimPath)} (0700, writable by the engine user) and retry — this refusal precedes the manifest read and the journal, so nothing was spent`,
          },
        },
      );
      return { ok: false, exitCode: 2 };
    }
    const holder = readEngineClaimHolder(claimPath);
    const holderLine =
      holder.runId === null
        ? "its contents are not a readable claim"
        : `held by run ${holder.runId}, pid ${holder.pid ?? "(unreadable)"}, since ${holder.startedAt ?? "(unreadable)"}`;
    emitEngineEvent(
      "engine_refused_claim",
      { runId: ids.runId, requestId: ids.requestId ?? null, phaseId: null },
      {
        claimPath,
        journalPath,
        holder,
        exitCode: 2,
        error: {
          code: "ENGINE_RUN_CLAIMED",
          message: `another engine holds this run root's claim (${claimPath} — ${holderLine}), so this invocation refuses rather than race the terminal marker write`,
          remediation: `wait for the holding engine to settle or fail — the claim is removed on every exit path. Before removing anything by hand, CHECK the holder is really gone: the claim records the holder's pid, and \`kill -0 <pid>\` (or \`ps -p <pid>\`) exiting 0 means a live process still holds it — wait, do not remove. A pid that answers nothing (a SIGKILLed engine cannot clean up after itself) is stale: remove ${claimPath} by hand and retry. The claim is per run ROOT, matching the marker's granularity; per-instance isolation (RuntimeDirectory) is the image-side half that rides the re-pin (#217 F-D1)`,
        },
      },
    );
    return { ok: false, exitCode: 2 };
  }
}

/**
 * DF3.3's gate-retry composition, extracted verbatim from the `code` branch
 * (S1) so `rig_swarm` composes the identical loop — the engine keeps gate
 * authority via testCommand, the same commandGate discipline code phases
 * ride. The CALLER owns the gate's construction (its cwd/env/label come from
 * the run's own seams); this function owns only the retry loop around
 * `gatedBody`. `requestId` rides the seam for parity with the factory's
 * inputs; the loop itself traces under `resident.requestId`, as it always
 * has.
 */
function composeGatedBody(args: {
  journal: PhaseJournal;
  gate: ReturnType<typeof commandGate>;
  base: PhaseBody<unknown>;
  spec: PhaseSpec;
  cwd: string;
  resident?: ResidentHooks;
  tracer: Tracer;
  requestId: string;
}): PhaseBody<unknown> {
  const { journal, gate, base, spec, cwd, resident, tracer } = args;
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
        // S1 (F-017): rig_swarm is NOT retryable — a gate failure ends the
        // phase on the first attempt, fail closed. An authorized attempt N+1
        // would re-boot the entire swarm (second daemon/import/queue cycle, a
        // second full OpenRouter spend) and run the seats over attempt 1's
        // already-mutated worktree. Deferred until the engine can
        // snapshot/restore swarm state between attempts; `code` and
        // `dispatch_task` phases keep the exact retry semantics below.
        if (spec.kind === "rig_swarm") throw err;
        if (!(err instanceof GateFailureError) || attempt > spec.retries) throw err;
        // DF1.3 authorized attempt N+1 (that dual-loop discipline lived in
        // src/phase-engine/agents/retry.ts, deleted with the unreachable
        // `agent` kind — #211; the branch is re-spelled here for code
        // phases). HISTORICAL DRIFT NOTE, kept for the budget semantics:
        // retry.ts's loop armed a FRESH per-attempt maxDurationMs timer,
        // while every attempt of this loop — command + gate + each
        // solicitation — shares the ONE phase timer. A slow attempt can
        // therefore overflow a retry DF1.3 would have granted its own
        // budget; the run can never exceed the manifest's per-phase
        // ceiling, and the admitted budget reservation ((retries+1) × … ×
        // maxDurationMs, manifest.ts:606) is the looser outer bound.
        // DF3.3 solicitation point 2 of 3: AFTER the verdict AND after
        // the authorization.
        if (resident?.steering === undefined) continue;
        const directive = await solicitResident(resident.steering, "post_gate_failure", {
          runId: resident.runId,
          requestId: resident.requestId,
          phase: spec.name,
          // The engine's phaseId domain, matching the phase_started /
          // phase_settled pair this solicitation sits between.
          phaseId: bodyCtx.phaseId,
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

// Exported for the factory-shape tests (tests/phase-engine/pipeline-run.test.ts)
// the same way `moneyLineTee` is for the money-line suite: the runner's `main`
// remains the only production caller.
export function makeBodyFactory(
  cwd: string,
  tracer: Tracer,
  requestId: string,
  correlation?: { runId: string; repoSlug: string; issueId: number | string | undefined },
  journal?: PhaseJournal,
  resident?: ResidentHooks,
) {
  // DF2.12 INV-COST-8 (PR #253 review): ONE per-agent ordinal counter per RUN,
  // injected into every dispatch_task body this factory builds. A per-body map
  // restarted the ordinal at 0 in each dispatch_task phase, breaking the
  // story's monotonic per-(runId, agentId) contract whenever two phases'
  // agentId domains overlap. Factory (per-run) scope is the point: this
  // function is constructed once per engine run.
  const invocationSeqByAgent = new Map<string, number>();
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
      return composeGatedBody({ journal, gate, base, spec, cwd, resident, tracer, requestId });
    }
    // DF1.6 T7: dispatch_task registration — the factory closes over the
    // run's tracer + requestId so prompt events (pre-spawn) and adapted team
    // events land in the trace store (DD-8, Observability Contract). rootDir
    // pins artifact reads to the SAME --run-root the code phases use.
    if (spec.kind === "dispatch_task") {
      const body = dispatchTask(spec, {
        tracer,
        requestId,
        rootDir: cwd,
        emitMoneyLine: moneyLineTee(),
        invocationSeqByAgent,
      });
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
    // S1 rig_swarm: the OpenRig swarm is the tier-2 engine INSIDE the box
    // (research doc §4.1 rule 2). The engine keeps gate authority via
    // testCommand — the same commandGate loop code phases compose.
    if (spec.kind === "rig_swarm") {
      const body = openrigSwarmPhase(spec, {
        requestId,
        tracer,
        emitMoneyLine: moneyLineTee(),
        invocationSeqByAgent,
      });
      const test = spec.testCommand ?? [];
      if (test.length === 0 || journal === undefined) {
        return body;
      }
      const gate = commandGate([...test], { cwd, env: childEnv(), label: `testCommand:${spec.name}` });
      return composeGatedBody({ journal, gate, base: body, spec, cwd, resident, tracer, requestId });
    }
    // DF1.10 AC1/C19: the COMPILER owns the completeness of this dispatch.
    //
    // This used to be a runtime throw for the two kinds nothing implemented, so
    // "every phase kind executes" was a promise the type system could not see —
    // a manifest could declare `engineer`, load cleanly, dispatch a box, mint a
    // key, run phase 1, and only then discover phase 2 had no executor. With
    // `PhaseKind` narrowed to the kinds that execute, `spec.kind` is `never` by
    // the time control reaches here, and adding a member without a case fails
    // `bunx tsc --noEmit` instead.
    //
    // The runtime throw stays as the residue: a caller constructing a PhaseSpec
    // outside the schema (a JS consumer, a hand-built object cast through
    // `unknown`) can still reach this line, and it must fail the phase rather
    // than return `undefined` as a body.
    const unreachableKind: never = spec.kind;
    return () => {
      throw new Error(
        `phase '${sanitizeForMessage(spec.name)}': no executor for kind '${sanitizeForMessage(String(unreachableKind))}' — PhaseKind carries only 'code', 'dispatch_task' and 'rig_swarm' (DF1.10 C19), so this spec did not come through loadManifest`,
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

/**
 * The PATH-COMPONENT guarantee, and only that: a runId becomes
 * `$HOME/<runId>.journal.jsonl`, so `..`, a separator or a NUL would move the
 * journal out of `$HOME`, and a leading `.` would hide it. Deliberately a
 * charset allowlist rather than `MINTED_FLEET_RUN_ID_RE` — an operator
 * debugging in-box must be able to run `qds-engine run scratch-1` by hand, and
 * the property that matters here is "cannot escape a directory", not "was
 * minted by dispatch".
 *
 * It is NOT a statement about systemd instance names, which is the other thing
 * a runId becomes (`qds-run@<runId>.service`). systemd ESCAPES `.` and `-` in
 * an instance name, so `a.b-c` round-trips through `%i` as something that is
 * not `a.b-c`; this regex admits both characters and always will, because ids
 * already in flight carry them. The narrower authority is HOST-side —
 * `assertFleetRunId` in `scripts/fleet.ts` holds the id to an RFC 1123 label
 * before any unit is ever named after it. This end only refuses what would
 * escape a directory.
 *
 * The witness's `requestId` is held to the same grammar (`deriveInBoxArgv`).
 * It is not a path component, but it rides every engine event and every trace
 * row, and one bounded charset for both identifiers is one thing to remember.
 */
const IN_BOX_RUN_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

/** `$HOME/<runId>.engine.log`. Derived in two places — the `run` front door
 *  opens it before `deriveInBoxArgv` can throw, and the derived argv passes it
 *  to `main` — so the formula lives in one. */
function inBoxEngineLogPath(home: string, runId: string): string {
  return path.join(home, `${runId}.engine.log`);
}

/**
 * DF1.10 AC2a — `qds-engine run <runId>`, the systemd unit's whole ExecStart
 * (`qds-run@.service:88-98`, which contracts exactly one line and passes `%i`
 * as the only argument).
 *
 * Path knowledge lives HERE rather than in the unit file for the same reason
 * `runMarkerRoot(runId)` does: the unit can only be changed by the image story, so
 * splitting derivation between the binary and the unit is how the two halves
 * drift. It also means an operator debugging in-box gets the unit's exact paths
 * by hand. The two halves AGREE by construction since #217 F-D1: the unit's
 * `RuntimeDirectory=qds-run/%i/{journal,trace}` and this file's
 * `runMarkerRoot(runId)` derive the same tree from the same runId.
 *
 * Everything is derived from the runId plus the in-box layout, and returned as
 * the ordinary flag argv `main` already takes — so this adds a front door, not
 * a second code path, and the derived argv is printable when something is off.
 */
function deriveInBoxArgv(runId: string): string[] {
  if (!IN_BOX_RUN_ID_RE.test(runId)) {
    throw new Error(
      `run id '${sanitizeForMessage(runId)}' is not a safe path component: expected ${IN_BOX_RUN_ID_RE}`,
    );
  }
  const home = process.env.HOME;
  if (home === undefined || home.trim() === "") {
    throw new Error(
      "HOME is unset, so the in-box layout has no anchor. The unit sets it from User=exedev; a bare invocation must run as the engine's own user",
    );
  }
  // ABSOLUTE, not merely set: every derived path below (run root, manifest
  // pair, journal, engine log) joins onto HOME, so a relative HOME resolves
  // them against the engine's cwd — the same invocation run from two
  // directories silently reads two different trees' `.qds/pipeline.yaml` and
  // writes its evidence in whichever directory it happened to start in. The
  // deleted remote shim's `boxHome` enforced `startsWith("/")` for exactly
  // this class; the front door's log open and pre-derivation guard are gated
  // on the same test.
  if (!home.startsWith("/")) {
    throw new Error(
      `HOME is not an absolute path (${sanitizeForMessage(home)}), so every derived in-box path would resolve against the engine's cwd instead of a stable anchor. The unit sets an absolute HOME from User=exedev`,
    );
  }
  // AC2b: the customer checkout is the one root the manifest read, the witness
  // read, the roster resolution and every code phase's cwd share. The manifest
  // PAIR sits under `.qds/` INSIDE it, which is what lets `--run-root` be the
  // checkout rather than its parent.
  //
  // SPELLED TWICE, DELIBERATELY. The other spelling is dispatch's:
  // `DEFAULT_FILL_WORKDIR` ("src") + `QDS_IN_BOX_DIR` (".qds") in
  // `src/providers/exedev/fill.ts`, which is what actually PUTS the pair here.
  // The two literals below must move together with those constants — a change
  // to either alone leaves the engine reading a directory dispatch did not fill.
  //
  // The engine cannot import them. It ships as UNBUNDLED SOURCE at
  // /opt/qds-factory with a `node_modules` narrowed to exactly `yaml` and `zod`
  // by an in-Dockerfile probe that FAILS THE BUILD on a third specifier, so
  // pulling `fill.ts` in would drag the provider/transport closure behind it and
  // force a Dockerfile change — and the Dockerfile is a `deriveBuildId` input,
  // so editing it invalidates the live-proven image pin. Nor can the resolved
  // path be stamped into `run-context.json`: this derivation is what FINDS that
  // file, so a value inside it cannot bootstrap its own lookup.
  const runRoot = path.join(home, "src");
  const manifestPath = path.join(runRoot, ".qds", "pipeline.yaml");

  // The caller's ceiling, from dispatch's own statement about this run. NOT
  // from the manifest: `loadManifest` compares `runBudgetMs` against this, so
  // feeding it the manifest's own number makes the comparison vacuous and the
  // engine would be assuming the ceiling AC5 says it never assumes.
  const witnessPath = path.join(runRoot, ".qds", "run-context.json");
  let witness: { budgetMs?: unknown; requestId?: unknown };
  try {
    witness = JSON.parse(
      readArtifactBeneathRoot(witnessPath, runRoot).bytes.toString("utf8"),
    ) as typeof witness;
  } catch (err) {
    // The message is SANITIZED and truncated, unlike most `err.message` echoes:
    // a JSON.parse failure quotes a fragment of its input, and `run-context.json`
    // is dispatch-written — it carries the requestId and whatever correlation
    // data dispatch stamped. This message goes to fd 2 and (since the front door
    // opens the engine log first) into the harvested tar, so the fragment would
    // leave the box.
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(
      `${witnessPath} is unreadable (${sanitizeForMessage(detail).slice(0, 200)}); dispatch fills it beside the manifest and the engine cannot derive a run without it`,
    );
  }
  const budgetMs = witness.budgetMs;
  if (!Number.isSafeInteger(budgetMs) || (budgetMs as number) <= 0) {
    throw new Error(
      `${witnessPath} carries no positive integer budgetMs. The in-box engine takes no --budget-ms on argv (the unit passes only the run id), so dispatch must stamp the caller's ceiling into the witness — refusing rather than defaulting one, because a defaulted ceiling is not a ceiling`,
    );
  }
  // The one identifier on this path that used to be taken on trust. It is not a
  // path component, so nothing escapes a directory through it — but it becomes
  // `--request-id` and rides every engine event and every DF1.4 trace row, where
  // a control character forges a log line and an unbounded string is a join key
  // nothing else agrees with. The runId beside it is bounded and so is the
  // host's (`assertFleetRunId`); this was the gap. REFUSED rather than dropped:
  // a witness dispatch wrote wrongly is a dispatch bug, and discovering it here
  // costs nothing (no phase has run, no money is spent), whereas silently
  // falling back to a fresh uuid would break the correlation join without a
  // single line saying so.
  if (
    witness.requestId !== undefined &&
    // `null` is ABSENT, not a violation: JSON producers routinely emit an
    // explicit null for an omitted field, and the argv spread below already
    // propagates nothing for a non-string. Only a PRESENT non-null value that
    // is not a safe identifier refuses.
    witness.requestId !== null &&
    (typeof witness.requestId !== "string" || !IN_BOX_RUN_ID_RE.test(witness.requestId))
  ) {
    throw new Error(
      `${witnessPath} carries a requestId that is not a safe identifier: expected ${IN_BOX_RUN_ID_RE}`,
    );
  }
  return [
    "--manifest", manifestPath,
    "--run-root", runRoot,
    "--budget-ms", String(budgetMs),
    // Both on ext4 `$HOME`, not tmpfs `/run`: a reboot wipes `/run` and these
    // are audit evidence that must survive to the harvest (INV-IBOX-8). runId
    // -prefixed so neither can collide with an entry the harvest tar already
    // carries from the checkout — a duplicate path makes the host-side
    // validator reject the whole archive.
    "--journal", path.join(home, `${runId}.journal.jsonl`),
    "--engine-log", inBoxEngineLogPath(home, runId),
    "--run-id", runId,
    // Correlation flags are deliberately absent: the in-box invocation is bare.
    // `requestId` still propagates — dispatch stamps it into the witness, and
    // every engine event carries it (Observability Contract). No `length > 0`
    // arm: any string here passed the IN_BOX_RUN_ID_RE check above, which
    // already rejects "" — re-testing it guarded nothing.
    ...(typeof witness.requestId === "string"
      ? ["--request-id", witness.requestId]
      : []),
  ];
}

/**
 * DF3.6b — the ENFORCEMENT CONTEXT latch, and it is the story's INV-MEM-2 Scope
 * made structural rather than probed.
 *
 * INV-MEM-2 governs the in-box enforcement context: the path reached when the
 * caller supplies a bound. `residentRssBytes` is OPTIONAL on `ResidentSpawnOpts`
 * exactly so the two contexts can be told apart BY THE CALLER — absent means no
 * cgroup machinery runs at all, present-but-unenforceable means the resident is
 * not started. This flag is how THIS caller tells them apart, and it is set by
 * the invocation SHAPE, never by a platform probe and never by an env var:
 *
 *   `qds-engine run <runId>`  — the unit's front door, the one shape
 *                               `ExecStart=` ever uses, so this is the in-box
 *                               engine under `qds-run@.service` with
 *                               `Delegate=memory`. Bound supplied; INV-MEM-2
 *                               applies in full, and an unenforceable box
 *                               refuses to start the resident (AC3).
 *   `pipeline-run --manifest …` — the host-side shape (the unit-test context and
 *                               the darwin operator host). No cgroups exist to
 *                               root a bound in, so the bound is ABSENT and no
 *                               cgroup machinery runs. That is the pre-DF3.6b
 *                               posture, unchanged: host-side RSS is DF5.1's
 *                               open, ps-sampled ceiling, which ADR Appendix B's
 *                               same-day correction explicitly leaves untouched
 *                               because this mechanism does not generalise to a
 *                               possibly-darwin host.
 *
 * Why not simply pass the bound on every shape: on darwin the arming check then
 * refuses EVERY host-side run's resident, which silently disarms DF3.3's and
 * DF3.6a's entire host-side behavioural coverage — the same "a memory story must
 * not silently disarm a shipped control" hazard INV-MEM-2's Scope paragraph
 * exists to prevent one layer down, arriving one layer up.
 *
 * Why not an env var: INV-MEM-1 forbids any env var, directive or in-box file
 * from raising, disabling or resetting the bound. An argv shape the unit fixes
 * in `ExecStart=` is not reachable from the resident's tier; an env var is.
 *
 * Why a PARAMETER and not a module-level `let`: it was the latter until review
 * round 14, set `true` before the re-entry and never reset. One process per
 * invocation made that safe in the shipped CLI — and invisible, since every test
 * reaches this file through `Bun.spawn`. But a latch that only unsets on process
 * exit is a landmine for any in-process reuse of `main()` (a batch runner, a
 * worker, a harness that imports it): the first in-box run would pin it `true`
 * for the process's life, and a LATER host-side `--manifest` call would then
 * pass a real bound, hit `ensureDelegatedSubtree()` on a box with no delegated
 * cgroup, and refuse the resident on precisely the shape this flag exists to
 * keep unarmed. A parameter cannot leak across calls, so the hazard is removed
 * rather than documented.
 */
/**
 * The engine's resident-arming decision, as one pure predicate.
 *
 * Program invariant 2 (one tier-2 brain per box): a manifest carrying a
 * `rig_swarm` phase puts the OpenRig lead seat in charge and the resident
 * agent is OFF — the manifest, not argv, is what the engine can see at arm
 * time, and the seat keys replace the single run key, so an armed resident
 * would die in INV-RES-3's key assertion anyway (R0.7 round 10,
 * engine-start-refused: "pipeline-run: resident refused" on a box whose
 * app/.env carried only QDS_SWARM_KEYS_FILE). `noResident` stays the
 * operator's manual override on every manifest shape; the brief's identity
 * fields decide arming exactly as before on non-swarm runs.
 */
export function residentArmedFor(
  brief: Record<string, unknown> | undefined,
  phases: ReadonlyArray<{ kind: string }>,
  noResident: boolean,
): boolean {
  if (noResident) return false;
  if (phases.some((p) => p.kind === "rig_swarm")) return false;
  return (
    brief !== undefined &&
    ["requestId", "repoSlug", "issueId", "issueUrl"].some((key) => {
      const v = brief?.[key];
      return v !== undefined && v !== null && `${v}`.length > 0;
    })
  );
}

async function main(argv: readonly string[], inBoxFrontDoor = false): Promise<number> {
  // The unit's front door. One level of re-entry, never more: the derived argv
  // is all flags, so it cannot come back through this branch.
  if (argv[0] === "run") {
    if (argv.length !== 2) {
      throw new Error("usage: qds-engine run <run-id> — the run id is the only argument");
    }
    // The length check above already proves argv[1] exists at runtime;
    // noUncheckedIndexedAccess cannot see that relation, hence the assertion.
    const inBoxRunId = argv[1] as string;
    // AC4: open the engine log HERE, not 90 lines down where `--engine-log` is
    // parsed. Every refusal `deriveInBoxArgv` can raise — an unreadable witness,
    // a witness with no budgetMs, a bad requestId — happens BEFORE the derived
    // argv exists, so with the open deferred they land in journald only, and
    // journald does not ride DF2.5's harvest tar. `ExecStart=/usr/local/bin/
    // qds-engine run "%i"` is the one invocation shape the unit ever uses, so
    // that was every derivation failure on the box: the exact evidence AC4
    // exists to keep. The id is validated first (it is a path component and
    // the log is named after it) and `openEngineLog` never throws, so this can
    // only ADD evidence; the inner `main` re-opens the same path harmlessly.
    //
    // An unset or non-absolute `$HOME` still logs nowhere: the layout has no
    // anchor (or no absolute one) then, so there is no path worth opening —
    // opening a RELATIVE one would create evidence under whatever cwd the
    // engine happened to start in. Those refusals remain journald's.
    const home = process.env.HOME;
    if (IN_BOX_RUN_ID_RE.test(inBoxRunId) && home !== undefined && home.trim() !== "" && home.startsWith("/")) {
      openEngineLog(inBoxEngineLogPath(home, inBoxRunId));
      // DF1.10 AC6, the front-door half of the replay guard: the witness the
      // derivation below is about to read lives in the checkout, the one tree
      // the run's own code phases may have rewritten (`git clean -fdx` in a
      // code phase deletes `.qds/` wholesale), while the marker on the
      // run-marker root is the one thing they cannot reach. A settled run
      // therefore mirrors HERE — before the witness read — instead of dying in
      // the derivation as an exit-2 "could not settle" over work that already
      // settled. `ids` carries the runId alone: the requestId rides the
      // witness this check precedes, and a front-door run always settles under
      // its runId. The journal path is the same `$HOME/<runId>.journal.jsonl`
      // the derived argv will carry, and the inner `main` re-runs the guard
      // after the derivation — idempotent on the same marker.
      const replayExit = replayRefusalExit(
        runMarkerPath(inBoxRunId),
        { runId: inBoxRunId },
        path.join(home, `${inBoxRunId}.journal.jsonl`),
      );
      if (replayExit !== null) return replayExit;
    }
    // DF3.6b: latch the enforcement context before the re-entry. The derived
    // argv is all flags, so the inner `main` cannot otherwise tell that it is
    // the in-box engine — and the memory bound is applied on exactly that shape.
    return main(deriveInBoxArgv(inBoxRunId), true);
  }

  let manifestPath: string | undefined;
  let budgetMs: number | undefined;
  let journalPath: string | undefined;
  let runRoot: string = process.cwd();
  let engineLogPath: string | undefined;
  let runId: string = crypto.randomUUID();
  let requestId: string = crypto.randomUUID();
  // DF1.8: the correlation brief as it arrives on the flags — validated (and
  // possibly refused) only once the pair is together, never defaulted.
  let repoSlug: string | undefined;
  let issue: string | undefined;
  let issueUrl: string | undefined;
  let runIdGiven = false;
  // #217 F-D1: whether requestId was NAMED. The default above is a fresh uuid
  // per invocation — a DIFFERENT key every time — so it must never key the
  // marker root: only an explicitly-passed --request-id (the correlated
  // retry shape) identifies a run pre-resolution. A defaulted requestId
  // leaves the invocation UNNAMED, which keeps the legacy shared root and
  // its fail-closed second-invocation refusal.
  // The requestId AS IDENTITY (#217 F-D1): a DEFAULTED uuid (fresh per
  // invocation, see the declaration above) is not an identity — only an
  // explicitly passed --request-id keys the root, the claim or the marker.
  let invocationRequestId: string | undefined = undefined;

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
        case "--engine-log":
          engineLogPath = value;
          break;
        case "--run-id":
          // The SAME grammar as the `run` front door (IN_BOX_RUN_ID_RE — which
          // also carries the 1 + 127 length bound), so both doors of one
          // binary enforce one identifier domain. The charset half is not
          // cosmetic: `startResident` builds `${runId}.resident.jsonl` from it
          // under the same regex, and an id that only the flag door accepted
          // died ~400 lines later — after the claim, manifest load, witness
          // reconciliation and an open Tracer session — costing an exit-2 run
          // and a session row for an input the front door rejects instantly.
          // The length half keeps the writer and the rereader agreeing:
          // `writeTerminalMarker` imposes no size cap, so an unbounded host id
          // would settle fine and then grow the marker past MARKER_MAX_BYTES —
          // every replay refuses ENGINE_MARKER_UNUSABLE and the run's verdict
          // is permanently unmirrorable. Refused here, before anything is
          // spent, where it costs nothing.
          if (!IN_BOX_RUN_ID_RE.test(value)) {
            throw new Error(
              `--run-id must be a safe identifier matching ${IN_BOX_RUN_ID_RE} (1..128 chars: alphanumeric first, then [A-Za-z0-9._-]), got '${sanitizeForMessage(value)}': the \`run\` front door enforces the same grammar, and a bad id would also grow the terminal marker past the ${MARKER_MAX_BYTES}-byte cap every replay enforces`,
            );
          }
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
          invocationRequestId = value;
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

  // One path cannot be BOTH the journal and the engine log (or the marker, or
  // the engine claim): the journal is REWRITTEN IN FULL on every phase while
  // the log APPENDS, so an alias destroys both silently — each flush truncates
  // the log, each tee'd line corrupts the journal JSON. The corruption is no
  // longer entirely unreported (`journalReclaimRefusal` now refuses an
  // unparseable journal as ENGINE_JOURNAL_UNUSABLE), but that refusal names a
  // journal fault and never the alias that caused it. The derived in-box argv
  // always names them distinctly; only a hand-built argv can alias them.
  // Refused here, before either file is opened.
  const resolvedMarker = path.resolve(runMarkerPathFor(rootIdentityKey({ runId, requestId: invocationRequestId, requestIdIsIdentity: !runIdGiven })));
  const resolvedClaim = engineClaimPath(markerRootFor(rootIdentityKey({ runId, requestId: invocationRequestId, requestIdIsIdentity: !runIdGiven })));
  if (engineLogPath !== undefined) {
    const resolvedLog = path.resolve(engineLogPath);
    const aliasOf: string[] = [];
    if (journalPath !== undefined && path.resolve(journalPath) === resolvedLog) {
      aliasOf.push("--journal");
    }
    if (resolvedLog === resolvedMarker) {
      aliasOf.push("the terminal marker path");
    }
    if (resolvedLog === resolvedClaim) {
      aliasOf.push("the engine claim path");
    }
    if (aliasOf.length > 0) {
      throw new Error(
        `--engine-log (${engineLogPath}) resolves to the same file as ${aliasOf.join(" and ")}: the journal is rewritten in full on every phase and the marker is written temp+rename — one path cannot be both, and the corruption would be silent`,
      );
    }
  }
  // The journal's own legs, checked STANDALONE: `--journal` naming the marker
  // or the claim needs no --engine-log to alias (the guard above only ran with
  // one). A journal flushed onto the marker path plants a multi-line JSON body
  // where the poller reads one verdict line; onto the claim path it overwrites
  // the live 0600 claim (and the settle release then deletes the journal
  // itself). Same hand-built-argv class, same refusal, before any file opens.
  if (journalPath !== undefined) {
    const resolvedJournal = path.resolve(journalPath);
    const aliasOf: string[] = [];
    if (resolvedJournal === resolvedMarker) {
      aliasOf.push("the terminal marker path");
    }
    if (resolvedJournal === resolvedClaim) {
      aliasOf.push("the engine claim path");
    }
    if (aliasOf.length > 0) {
      throw new Error(
        `--journal (${journalPath}) resolves to the same file as ${aliasOf.join(" and ")}: the journal is rewritten in full on every phase while the marker and the claim are single-commit files — one path cannot be both, and the corruption would be silent`,
      );
    }
  }

  // Opened before the required-flag checks, not just before the manifest read:
  // in the box this file is the ONLY channel out (journald does not ride the
  // harvest tar), and a wrapper that built the argv wrongly is exactly the
  // failure an operator has nothing else to debug from. The module-level catch
  // writes its message to fd 2, which tees here.
  if (engineLogPath !== undefined) openEngineLog(engineLogPath);

  if (!manifestPath) throw new Error("--manifest is required");
  if (budgetMs === undefined) throw new Error("--budget-ms is required");
  if (!journalPath) throw new Error("--journal is required");

  // DF1.8: the marker root is derived before anything can refuse — a
  // correlation failure can precede the trace claim entirely, and its dispatch
  // log still needs a home (AC4: the log outlives a trace store that could not
  // even open).
  const markerRoot = markerRootFor(rootIdentityKey({ runId, requestId: invocationRequestId, requestIdIsIdentity: !runIdGiven }));

  // DF1.10 AC6 / INV-IBOX-6: this run has already terminally settled — refuse.
  //
  // HERE, and not folded into DF1.8's replay guard 150 lines down, for two
  // reasons. That guard is keyed on `initiateSession`'s requestId dedupe in the
  // SQLite trace store and lives INSIDE the `correlated` branch, so it never
  // fires for the invocation this check exists for: `qds-engine run <runId>`
  // passes no correlation flags at all. And it answers a different question —
  // "has this requestId's session been recorded" rather than "has this run
  // already settled" — which gives the wrong answer in both directions.
  //
  // This position is load-bearing: BEFORE `loadManifest` (and, on the `run`
  // front door, before the witness read — see `replayRefusalExit`), because
  // both reads live in the customer checkout, the one tree the run's own code
  // phases are free to rewrite: a settled run whose phases ran `git clean -fdx`
  // still mirrors its marker instead of dying as an exit-2 "could not settle"
  // in a manifest/witness read of a tree the settled run itself emptied. A
  // malformed manifest keeps its own clearer refusal exactly when NO marker
  // exists — the only state where the manifest is the next fact worth
  // reporting. Still before the correlation ladder (so it applies to bare and
  // correlated invocations alike), and far before `new FileJournal` — so
  // nothing is journalled, no `fail` row is overwritten, and no phase whose
  // spend and commits already happened is re-executed.
  //
  // Fail-CLOSED on an unusable marker — see `markerReplayRefusal` for why the
  // probe is `lstat` rather than `existsSync` or `stat`, why the body is read
  // rather than trusted for its presence alone, and why a marker naming ANOTHER
  // run is refused instead of mirrored. Only a marker that is absent (and a
  // journal that carries no phase row — `journalReclaimRefusal`, the durable
  // half a tmpfs `/run` cannot answer) proceeds.
  const markerPath = runMarkerPathFor(rootIdentityKey({ runId, requestId: invocationRequestId, requestIdIsIdentity: !runIdGiven }));
  const replayExit = replayRefusalExit(
    markerPath,
    // requestIdIsIdentity: the requestId counts as this invocation's identity
    // only when it named no `--run-id` of its own — the correlated shape (see
    // `markerReplayRefusal`). An invocation passing BOTH doors' ids cannot
    // claim a marker through the one it did not settle under.
    { runId, requestId, requestIdIsIdentity: !runIdGiven },
    journalPath,
  );
  if (replayExit !== null) return replayExit;

  // #217 F-D1 (TS half): serialize engines on this root from HERE — after the
  // replay guard passes, before `loadManifest` and `new FileJournal` — so the
  // check-then-act window between guard and marker write cannot double-spend.
  // Release: the settle `finally` below (deterministic, before process exit)
  // and a process-`exit` hook covering every other exit (throws, refusals,
  // signals; `main` is unexported and its bootstrap always exits — no in-
  // process caller can outlive the hook). Only an unhandled kill escapes
  // both — SIGKILL, and the default-disposition kills no handler covers
  // (SIGHUP, SIGQUIT, unconfigured SIGUSR1/SIGUSR2) — and the claim any of
  // them leaves behind refuses loudly with a removal remediation.
  const claim = acquireEngineClaim(markerRoot, { runId, requestId }, journalPath);
  if (!claim.ok) return claim.exitCode;
  const releaseEngineClaim = (): void => {
    try {
      // OWNERSHIP-CHECKED, not unconditional: the settle `finally` releases
      // first, then AWAITS (resident stop, exit probe, the final writeResident)
      // before the bootstrap's process.exit fires this hook a SECOND time. In
      // that window a successor engine on this root — a failed walk leaves no
      // marker, so its own reclaim/claim guards pass — can legitimately hold
      // the claim. An unconditional rm here would delete THAT engine's claim
      // and silently re-arm the concurrent-walk window this guard exists to
      // close. Only the bytes THIS engine wrote are ours to remove.
      if (fs.readFileSync(claim.claimPath, "utf8") === claim.claimBody) {
        fs.rmSync(claim.claimPath, { force: true });
      }
    } catch {
      /* absent, unreadable, or no longer ours: best-effort either way — a
         claim that cannot be removed refuses the next engine loudly
         (ENGINE_RUN_CLAIMED); it never silently re-arms the root */
    }
  };
  process.on("exit", releaseEngineClaim);
  // The `exit` hook above does NOT run under a default-disposition
  // SIGTERM/SIGINT (verified: Node runs exit hooks on process.exit and normal
  // return, not on a signal that kills the process), and the rich `onSignal`
  // handler is registered hundreds of lines down — past loadManifest, the
  // correlation ladder, the Tracer's SQLite open and the journal. A `systemctl
  // stop` (SIGTERM) or a stray Ctrl-C inside that window killed the process
  // with the claim still on disk, wedging the root for every later engine
  // (ENGINE_RUN_CLAIMED until a manual rm) — contradicting "only an
  // unhandled kill escapes both". These MINIMAL handlers close the window:
  // release the claim,
  // exit 2 — nothing has been walked (no phase, no marker), so 2's "genuinely
  // could not settle" is exact. Registering them at all also removes the
  // signals' default disposition from this point on, so an arrival can no
  // longer kill silently mid-block. The rich handler's registration below
  // REMOVES these and takes over the signal contract from there.
  const claimReleaseOnSignal = (): void => {
    releaseEngineClaim();
    process.exit(2);
  };
  process.on("SIGTERM", claimReleaseOnSignal);
  process.on("SIGINT", claimReleaseOnSignal);

  const { manifest, manifestLoadMs, resolvedPath } = loadManifest(manifestPath, budgetMs, runRoot);

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
      boundaryRoot: markerRoot,
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
      { repoSlug: resolved.repoSlug, issueId: resolved.issueId ?? resolved.workId ?? null, requestId: resolved.requestId },
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
  // DF5.3: the dispatched run's correlation, read from the witness (see
  // `witnessCorrelationBeside`). Read HERE, inside the guarded region, for the
  // two things this block already owns: `resolvedPath` is narrowed to the
  // VERIFIED realpath (a symlinked `--manifest` must not point the correlation
  // read at another directory's run-context.json, exactly as for the cap), and
  // a refusal must close the Tracer rather than leak its WAL handle. Absent on
  // the ladder path, which is not read at all — a run that resolved through
  // DF1.8's flags behaves precisely as before, down to the reads it makes.
  let witnessedCorrelation: ResolvedRunCorrelation | undefined;
  // DF5.3 N1: the witness could not be READ (EACCES, EIO, the hardened
  // reader's symlink refusal) — an environment fault, kept to report the
  // degradation below rather than to abort. A present-but-malformed witness is
  // NOT this: it throws a plain Error out of the same call and keeps the hard
  // refusal.
  let witnessReadFault: WitnessUnreadableError | undefined;
  try {
    if (resolvedPath === undefined) {
      throw new Error("manifest was derived in memory and has no verified path to anchor the cap witness to");
    }
    ctx = runContextFrom(runId, requestId, manifest, { manifestPath: resolvedPath, runRoot });
    if (!resolved) {
      try {
        witnessedCorrelation = witnessCorrelationBeside(resolvedPath, runRoot, requestId);
      } catch (err) {
        // Only the ENVIRONMENT fault degrades, and it degrades for the same
        // reason the `initiateSession` catch below does: this code runs in the
        // box, after provisioning, fill and key delivery, so a disk or
        // permissions problem must not kill a run that has already spent —
        // while the sibling `readResidentBriefSource` already shrugs at this
        // very errno on this very file. A witness that is PRESENT and
        // structurally wrong (half a pair, bad field types, a requestId that
        // disagrees with --request-id) still aborts: a forged correlation must
        // not silently become a session row.
        //
        // SHADOWED IN `main` TODAY, and measured, not assumed: `runContextFrom`
        // one line above sends every PRESENT witness — capped manifest or not —
        // through `admittedCeilingBeside`, and `witnessPresent` counts every
        // non-ENOENT lstat errno as present, so an EACCES/EIO/symlinked witness
        // is refused THERE (`… the dispatch witness … is unreadable`, exit 2)
        // before this reader opens anything. Verified by running the engine
        // against a mode-000 witness on an uncapped manifest. That refusal is
        // deliberate and stays: the witness is also the CAP witness, and a
        // ceiling that cannot be reconciled must stop the run rather than let
        // it spawn at the DF1.6 default above what the ledger reserved.
        //
        // What is left live here is the lstat→read RACE (a witness that appears
        // unreadable between `witnessPresent` and this open) — and, like the
        // JSON.parse guard inside the reader, the CONTRACT: the day the read
        // order changes or a second caller appears, an environment fault must
        // not be the thing that kills a paid run.
        if (!(err instanceof WitnessUnreadableError)) throw err;
        witnessReadFault = err;
      }
    }
    // #217 F-D1: the marker is keyed on the invocation's IDENTITY, which for
    // a correlated run is the requestId it will adopt post-resolution, and for
    // a fully unnamed invocation is NOTHING (the legacy shared root). The
    // guard and the claim above already used this key; the marker write now
    // does too, so all three can never disagree.
    ctx.markerRunKey = rootIdentityKey({ runId, requestId: invocationRequestId, requestIdIsIdentity: !runIdGiven }) ?? null;
  } catch (err) {
    try {
      tracer.close();
    } catch {
      /* the cap-reconciliation (or correlation) refusal outranks a close failure */
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
  // ObservedJournal on the OUTSIDE: it emits `phase_started`/`phase_settled`
  // after the write it is reporting has been delegated all the way down and
  // returned, so no event ever describes a row that failed to reach disk.
  const journal = new ObservedJournal(new TracingJournal(innerJournal, tracer, ctx), {
    runId,
    requestId,
  });

  const run = new Run({
    ctx,
    journal,
    manifestLoadMs,
  });

  // DF1.4: Start session at run start — bare mode only; a correlated run
  // initiated its session through the DF1.8 ladder above instead.
  if (!resolved) {
    // ONE spelling of the degradation line, for the two paths that reach it:
    // the witness could not be READ (DF5.3 N1) and the initiation itself
    // faulted. Both continue on the bare row, and both must SAY so in the
    // engine log the harvest carries home — a run whose corroboration is
    // missing is otherwise indistinguishable from one that never had any until
    // somebody opens the db. `repoSlug`/`issueId` are null on the read-fault
    // path: nothing was read, so there is no pair to name.
    const reportUncorrelated = (
      err: unknown,
      pair: { repoSlug: string | null; issueId: number | string | null },
      // The FALLBACK's own failure, when even the bare session could not be
      // written. Reported beside the first error rather than folded into it, so
      // the primary cause keeps its field and a consumer can tell "no
      // correlation" from "no session row at all".
      sessionErr?: unknown,
    ): void => {
      writeAll(
        2,
        `${JSON.stringify({
          level: "error",
          event: "run_correlated",
          source: "witness",
          recorded: false,
          runId,
          requestId,
          repoSlug: pair.repoSlug,
          issueId: pair.issueId,
          error: sanitizeForMessage(err instanceof Error ? err.message : String(err)).slice(0, 200),
          ...(sessionErr === undefined
            ? {}
            : {
                sessionError: sanitizeForMessage(
                  sessionErr instanceof Error ? sessionErr.message : String(sessionErr),
                ).slice(0, 200),
              }),
        })}\n`,
      );
    };
    if (witnessedCorrelation === undefined) {
      // No correlation on the witness (absent file, one written before the
      // field existed, or — DF5.3 N1 — one this run could not read): the
      // historical bare row, unchanged. Its NULL repo_slug/issue_id is honest
      // here — nothing told this run which issue, if any, authorized it.
      tracer.startSession({ requestId, request: manifest.pipelineId });
      // An unreadable witness is the one sub-case that is not silent: absence
      // is normal (flag-driven runs, library callers), an environment fault is
      // not, and the run continues either way.
      if (witnessReadFault !== undefined) {
        reportUncorrelated(witnessReadFault, { repoSlug: null, issueId: null });
      }
    } else {
      // DF5.3: the dispatched shape records the pair through the SAME
      // initiation gate the ladder uses — including its
      // RequestIdRepoMismatchError, which is the point rather than a hazard: a
      // requestId re-pointed at a second (repo, issue) must stop the run, not
      // silently overwrite what the host record already admitted (INV-RUN-1,
      // INV-RUN-2 write-once). Against a bare row carrying NULL repo_slug —
      // the row an older engine on this same box left — it performs the one
      // permitted fill of the correlation columns.
      //
      // Guarded like the cap-reconciliation refusal above: the Tracer is open,
      // and an unclosed handle leaks the WAL and leaves an unfinished session
      // row that wedges this requestId for every later initiateSession.
      //
      // NOT `dispatchFail`: that ladder records to the HOST-side dispatch log,
      // and this code runs in the box, where the path does not exist. The
      // throw reaches the top-level catch (stderr + exit 2), and stderr here
      // is the engine log, which DF2.5's harvest carries home.
      //
      // ONLY `RequestIdRepoMismatchError` aborts (see the catch). `initiateSession`
      // documents its throwing as an initiation GATE that "must stop the run
      // before a box or key is minted" — but that rationale is about the HOST
      // ladder, and this code runs IN THE BOX, after provisioning, fill and key
      // delivery. A transient sqlite fault here (SQLITE_FULL on a box that
      // filled its disk, SQLITE_IOERR, SQLITE_BUSY, the "row vanished
      // mid-initiation" TracerError) would kill a run that has already spent,
      // while the bare `startSession` branch two lines up degrades — DF1.4's
      // per-write AC5 contract. The mismatch is the one that genuinely must
      // abort: it means this box is running against the wrong identity.
      try {
        const initiated = tracer.initiateSession({
          correlation: witnessedCorrelation,
          request: manifest.pipelineId,
          pipelineName: manifest.pipelineId,
        });
        // A distinct event from the ladder's `run_initiated`, deliberately:
        // that line is the HOST dispatcher's read-back of a correlated CLI
        // run, and this one is in-box evidence that the trace's corroboration
        // of the host record was actually written. Without it a successful
        // recording is invisible until someone opens the harvested db — which
        // is exactly how the NULL columns this change closes went unnoticed.
        //
        // `replayed` is REPORTED, never acted on: the ladder returns 0 on a
        // replay because the requestId IS the run's identity there, whereas a
        // dispatched run's identity is its host-minted runId and its replay
        // defence is the terminal marker (`replayRefusalExit`, DF1.10 AC6).
        // Exiting 0 here would let a pre-existing session row — the bare one
        // just filled, say — cancel a run the marker says never happened.
        writeAll(
          2,
          `${JSON.stringify({
            level: "info",
            event: "run_correlated",
            source: "witness",
            recorded: true,
            runId,
            requestId,
            repoSlug: witnessedCorrelation.repoSlug,
            issueId: witnessedCorrelation.issueId,
            replayed: initiated.replayed,
          })}\n`,
        );
      } catch (err) {
        if (err instanceof RequestIdRepoMismatchError) {
          try {
            tracer.close();
          } catch {
            /* the initiation refusal outranks a close failure */
          }
          throw err;
        }
        // Everything else is a trace-store fault, not an identity refusal. The
        // run has already been paid for, so it continues on the same bare row
        // the no-correlation branch writes — and the degradation is LOGGED,
        // `recorded: false`, so a run whose corroboration is missing says so in
        // the engine log the harvest carries home rather than being discovered
        // when someone opens the db.
        //
        // THE FALLBACK IS ITSELF GUARDED. `startSession` swallows its own
        // SQLITE_WRITE into the trace-error sink today, and `emitTraceError`
        // swallows a throwing sink — but that is the STORE's contract, not this
        // file's, and the whole point of this branch is that a run which has
        // already provisioned, filled and spent must not die for a trace write.
        // A second throw here would escape unlogged and do exactly that, so it
        // falls through to no session at all and reports both errors.
        //
        // No "did the initiation already write a row" test is needed, for two
        // independent reasons: `initiateSession` does its whole SELECT/INSERT/
        // UPDATE inside one `db.transaction(...).immediate()`, so a throw rolls
        // it back, and `sessions.request_id` is the PRIMARY KEY, so a duplicate
        // INSERT could only raise a constraint error into the trace-error sink
        // — never a SECOND row that leaves the harvested trace ambiguous about
        // which one is this run's.
        let sessionErr: unknown;
        try {
          tracer.startSession({ requestId, request: manifest.pipelineId });
        } catch (fallbackErr) {
          sessionErr = fallbackErr;
        }
        reportUncorrelated(
          err,
          { repoSlug: witnessedCorrelation.repoSlug, issueId: witnessedCorrelation.issueId ?? witnessedCorrelation.workId ?? null },
          sessionErr,
        );
      }
    }
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
  // REPLACE the minimal claim-release handlers registered at acquisition, do
  // not accumulate beside them: `process.on` adds listeners, and the minimal
  // pair's process.exit(2) would preempt this graceful path's terminate /
  // resident-stop / tracer-close unwind. The rich pair registers FIRST and the
  // minimal pair is removed after — every instant of this synchronous block
  // keeps at least one listener registered, so no signal arrival can fall back
  // to the default disposition (which kills without running the exit hook).
  process.on("SIGTERM", (sig) => void onSignal(sig));
  process.on("SIGINT", (sig) => void onSignal(sig));
  process.removeListener("SIGTERM", claimReleaseOnSignal);
  process.removeListener("SIGINT", claimReleaseOnSignal);

  // DF1.11 AC4b: the boot anchor, before any resident/steering arming so the
  // row exists on every startup — armed, unarmed, --no-resident alike.
  writeBootAnchorRow(runId, requestId);

  // DF1.11 AC3 / INV-IBOX-11: the id-space mismatch warn, hoisted to engine
  // STARTUP rather than steering construction. A non-minted --run-id rejects
  // every attach line for the WHOLE run, so the warn belongs to the run, not
  // to the resident: a --no-resident (or rate-degraded) run with a bare-uuid
  // id is refused silently forever otherwise, invisible from the host while
  // every attach line for it queues unread. Emitted exactly once per startup
  // here; the steering arming below no longer emits it, so an armed run still
  // warns exactly once.
  if (!MINTED_FLEET_RUN_ID_RE.test(runId)) {
    const detail = `this run id (${sanitizeForMessage(runId)}) is not a fleet run id, so every inbox line stamped with a fleet id is treated as foreign and SKIPPED — this run will not fold guidance queued under a fleet id; run with the same --run-id the \`fleet attach\` targeted to receive it`;
    writeAll(
      2,
      `${JSON.stringify({
        level: "warn",
        event: "steering_ownrun_id_space_mismatch",
        runId,
        requestId,
        reason: "id_space_mismatch",
        detail,
      })}\n`,
    );
    // The warn must also ride the HARVESTED trace sidecar. In-box stderr is
    // journald's, and journald is where nobody is looking — a non-minted id
    // rejects every attach line while the run reports healthy, invisible from
    // the host. Same sink and same sidecar guard as the onInboxError trace
    // below.
    //
    // Sidecar row name `steeringOwnrunIdSpaceMismatch` (camelCase, the
    // tracer's name convention) IS the stderr event literal
    // `steering_ownrun_id_space_mismatch` above — one fact, two spellings;
    // harvest-side greppers need both.
    try {
      tracer.trace({
        type: "log",
        name: "steeringOwnrunIdSpaceMismatch",
        requestId,
        payloadJson: JSON.stringify({ runId, requestId, reason: "id_space_mismatch", detail }),
      });
    } catch {
      /* the trace store is a sidecar; the stderr warn already landed */
    }
  }

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
  // not conjure a resident out of a ceiling statement. A rig_swarm manifest
  // disarms regardless of brief (invariant 2 — see residentArmedFor).
  const residentArmed = residentArmedFor(
    residentBrief,
    manifest.phases,
    noResident,
  );
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
  // DF3.6a edit (i): the bound set loads at the ARM site — a --no-resident
  // invocation and an empty-brief invocation never enter this block, so a
  // resident bound can never fail a run that arms no resident (INV-BND-5's
  // own first clause).
  let loadedBounds: ResidentBoundsConfig | undefined;
  if (residentArmed && residentBrief !== undefined) {
    // BEFORE startResident and before the first solicitation: AC2a's refusal
    // refuses the whole run while no resident exists. The typed
    // {code, message, remediation} triple rides the engine's fd-2 diagnostic
    // line, never the marker — the marker keeps its shipped {runId, ok,
    // completedAt} shape (writeTerminalMarker's payload vocabulary is closed,
    // and a full remediation risks MARKER_MAX_BYTES' oversized arm, which a
    // poller reads as "no verdict" = unknown, not not-ok).
    try {
      loadedBounds = loadResidentBounds(manifest);
    } catch (err) {
      writeAll(
        2,
        `${JSON.stringify({
          level: "error",
          event: "resident_bounds_invalid",
          runId,
          requestId,
          code: err instanceof BoundConfigError ? err.code : "bound-config-invalid",
          message: err instanceof Error ? err.message : String(err),
          remediation:
            err instanceof BoundConfigError
              ? err.remediation
              : "inspect the manifest's resident bound operands",
        })}\n`,
      );
      // DF3.3's settled-journal guarantee: a settled run always carries a
      // resident block — seed the explicit disabled shape before the marker
      // can exist. This is residentTelemetryOf()'s disabled arm, inlined
      // because that const is declared below the arm block (calling it here
      // would hit its temporal dead zone) and steering is undefined here by
      // construction: the refusal precedes startResident, so nothing armed.
      // residentTelemetryOf (below) is CANONICAL — this inline copy must
      // track any change to its disabled arm (P23).
      try {
        innerJournal.writeResident({
          status: "disabled",
          directives: 0,
          directivesRejected: 0,
          steeringIterations: {},
          spendMicros: 0,
          exitStatus: null,
          tripwires: [],
        });
      } catch {
        /* the marker is the commitment */
      }
      try {
        tracer.close();
      } catch {
        /* the refusal outranks a close failure */
      }
      // The SAME identity-keyed path Run.finish settles through (ctx.markerRunKey
      // comes from this run's own rootIdentityKey derivation; `markerPath` above
      // is its #217 F-D1 resolved form, named and unnamed alike) — the poller
      // watches that path and no other.
      // P6: the marker write is guarded like every sibling step in this catch
      // (writeResident, tracer.close). If IT throws (ENOSPC/EACCES/EROFS —
      // likely on the degraded box this refusal path implies), the throw would
      // escape past `return 1` to the module-level handler → exit 2 with NO
      // marker → the poller reads "unknown" forever instead of settled
      // not-ok. On failure, the fd-2 diagnostic + the seeded resident block
      // above ARE the record; the run still settles not-ok via exit 1.
      try {
        writeTerminalMarker(runId, { ok: false, completedAt: new Date().toISOString() }, markerPath);
      } catch (markerErr) {
        writeAll(
          2,
          `${JSON.stringify({
            level: "error",
            event: "marker_write_failed",
            runId,
            requestId,
            message: markerErr instanceof Error ? markerErr.message : String(markerErr),
          })}\n`,
        );
      }
      // 1, not 2: the marker is on disk, so "settled not-ok" — Run.finish's own
      // exitCode mapping. This return sits OUTSIDE the walk's try/finally (that
      // try opens at the resident-block seed, below), so the finally's claim
      // release does not run on this path — the process-`exit` hook registered
      // at claim acquisition does (the "refusals" arm of the claim's coverage
      // comment), no resident exists to stop, and the resident block above is
      // already seeded.
      return 1;
    }
    // AC2b's clamp row — the engine's trace/log stream (fd-2), never the
    // journal's resident block (its key set is DF3.3-closed). Emitted exactly
    // once, here at load: the only place configured and effective ceilings
    // differ.
    if (loadedBounds.clampRow !== undefined) {
      writeAll(
        2,
        `${JSON.stringify({
          // P11: the row spreads FIRST — a trailing spread would re-set the
          // join keys (an undefined runId inside the row gets dropped by
          // JSON.stringify and the line loses correlation).
          ...loadedBounds.clampRow,
          level: "info",
          event: "resident_bounds_clamped",
          runId,
          requestId,
        })}\n`,
      );
    }
    let spawned: ReturnType<typeof startResident> | undefined;
    try {
      spawned = startResident({
        brief: residentBrief,
        runId,
        sessionDir: path.dirname(path.resolve(journalPath)),
        // §5.2 / DOD-Security: every prompt and raw reply persists
        // PRE-EXECUTION, redacted, beside the journal.
        persistDir: path.dirname(path.resolve(journalPath)),
        // DF3.6b edit (iii): the engine-owned bound, validated by DF3.6a,
        // handed to the layer that applies it as `memory.max` on the
        // per-solicitation cgroup. Read from `loadedBounds` and NEVER
        // defaulted here — fleet is mechanism, this is the one place the
        // policy value crosses (INV-MEM-1). `loadedBounds` is never undefined
        // here — the AC2a catch above returns before this line on every path
        // that leaves the bound set unloaded — so on the in-box shape an armed
        // resident can never spawn without its bound (INV-MEM-2). On the
        // host-side shape the bound is deliberately ABSENT: see the
        // `inBoxFrontDoor` header for why that is INV-MEM-2's own Scope clause
        // and not a bypass of it.
        residentRssBytes: inBoxFrontDoor ? loadedBounds.residentRssBytes : undefined,
      });
    } catch (err) {
      // DF3.6b edit (vi) / AC3: the memory bound is UNENFORCEABLE on this box
      // — no `Delegate=memory`, no `memory` controller, not cgroup v2, an
      // unwritable `memory.max`. Classified HERE, beside the rate refusal, and
      // deliberately NOT inside the `onBoundBreach` handler: that region lives
      // inside `createSteering`, which on this path is never constructed (the
      // guard two statements down gates it on `!("disabled" in spawned)`), so
      // an unclassified rethrow would close the tracer and leave a
      // marker-absent box — `fleet status: engine-failed` — exactly the
      // outcome DF3.6a's AC2b negative control forbids. Also deliberately NOT
      // a bounds-check line: `checkBounds` lives inside `createSteering` too,
      // so on this path it is structurally unavailable.
      const reason =
        err instanceof RateError
          ? "rate_unresolved"
          : err instanceof CgroupUnenforceableError
            ? "rss_unenforceable"
            : null;
      if (reason === null) {
        try {
          tracer.close();
        } catch {
          /* the arming refusal outranks a close failure */
        }
        throw err;
      }
      // Spec (Infra Prerequisites): a slug with no resolvable rate — or, for
      // DF3.6b, a bound the kernel cannot enforce — refuses the RESIDENT,
      // never the run: INV-RES-5 and INV-MEM-2 both degrade toward
      // determinism. steering is never constructed, so the journal's
      // resident block stays the explicit "disabled" shape, and the run
      // proceeds deterministically with the cause on stderr. No tripwire row
      // is emitted: DF3.3's cause union has no member for an arming refusal,
      // and the run never ran an unbounded agent.
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
          reason,
          detail: err instanceof Error ? err.message : String(err),
        })}\n`,
      );
    }
    if (spawned !== undefined && !("disabled" in spawned)) {
      residentSpawn = spawned;
      // DF3.6a edit (ii): arm the guard now that the rate exists (resolveRate
      // ran inside startResident — this is the one place ceiling and rate
      // meet, AC6). Construction emits the reachability row exactly once;
      // every later bounds line rides writeAll's fd-2 tee — trace/log stream,
      // never the journal's resident block.
      // P13: the undefined arm was structurally dead — the AC2a catch above is
      // the only way loadedBounds stays undefined on an armed path, and it
      // returns 1 before reaching here. Fail loud anyway: if a future refactor
      // makes this reachable, steering would construct with bounds:undefined
      // and an ARMED resident would run unguarded, silently (INV-BND-5). The
      // typed BoundConfigError rides the module-level handler → exit 2. No
      // hook stops the resident on that throw path (the exit hook releases
      // only the claim; the resident-stopping signal handlers need a signal)
      // — the spawn's own native timeout + SIGKILL bounds the orphan, and a
      // loud exit-2 beats an armed resident spending unguarded.
      if (loadedBounds === undefined) {
        throw new BoundConfigError(
          "resident armed without bounds — invariant violated (DF3.6a)",
          "this is a runner bug, not a manifest fault — report it",
        );
      }
      let boundsGuard: ReturnType<typeof createBoundsGuard>;
      try {
        boundsGuard = createBoundsGuard(
          loadedBounds,
          spawned.rate,
          manifest.phases.length,
          (line) => {
            // P11: the row spreads FIRST — a trailing spread would re-set the
            // join keys (an undefined runId inside the row gets dropped by
            // JSON.stringify and the line loses correlation).
            writeAll(2, `${JSON.stringify({ ...line, level: "info", event: "resident_bounds", runId, requestId })}\n`);
          },
          runId,
        );
      } catch (err) {
        // PR #263 review: construction can itself refuse — resolveRate
        // accepts a ZERO bundled rate term (validate.ts rejects only < 0;
        // value > 0 gates the plausibility band, so 0 slips under it),
        // startResident copies the terms unchanged, and createBoundsGuard
        // fail-closes on any term that is not finite > 0 (INV-BND-3, P2).
        // That throw used to escape to the module-level handler → exit 2
        // with NO terminal marker — a config fault left the poller reading
        // "unknown" forever. Settle not-ok instead, the SAME path the
        // loadResidentBounds refusal above takes (its catch is the
        // reference; this inline copy must track it, the P23 idiom).
        if (!(err instanceof BoundConfigError)) {
          // An unforeseen non-config throw keeps its fail-loud module-level
          // path — the RateError arm above draws exactly this line.
          throw err;
        }
        writeAll(
          2,
          `${JSON.stringify({
            level: "error",
            event: "resident_bounds_invalid",
            runId,
            requestId,
            code: err.code,
            message: err.message,
            remediation: err.remediation,
          })}\n`,
        );
        // The resident EXISTS here (unlike the load refusal, which precedes
        // startResident) and the signal handlers are the only automatic stop
        // — a normal `return 1` fires none of them. Stop it explicitly,
        // best-effort, with the resident_stop_failed record (P7's shape).
        try {
          await spawned.stop();
        } catch (stopErr) {
          writeAll(
            2,
            `${JSON.stringify({
              level: "warn",
              event: "resident_stop_failed",
              runId,
              requestId,
              message: stopErr instanceof Error ? stopErr.message : String(stopErr),
            })}\n`,
          );
        }
        // DF3.3's settled-journal guarantee — seed the resident block before
        // the marker can exist. The DISABLED arm is canonical for
        // steering === undefined (steering was never constructed; no
        // solicitation ever issued, so spend/directives are honestly 0);
        // residentTelemetryOf (below) is canonical — this inline copy must
        // track its disabled arm (P23).
        try {
          innerJournal.writeResident({
            status: "disabled",
            directives: 0,
            directivesRejected: 0,
            steeringIterations: {},
            spendMicros: 0,
            exitStatus: null,
            tripwires: [],
          });
        } catch {
          /* the marker is the commitment */
        }
        try {
          tracer.close();
        } catch {
          /* the refusal outranks a close failure */
        }
        // Same identity-keyed marker path Run.finish settles through; guarded
        // like every sibling step (P6): a throw here would escape past
        // `return 1` to the module-level handler → exit 2 with NO marker. On
        // failure the fd-2 diagnostic + the seeded resident block above ARE
        // the record; the run still settles not-ok via exit 1.
        try {
          writeTerminalMarker(runId, { ok: false, completedAt: new Date().toISOString() }, markerPath);
        } catch (markerErr) {
          writeAll(
            2,
            `${JSON.stringify({
              level: "error",
              event: "marker_write_failed",
              runId,
              requestId,
              message: markerErr instanceof Error ? markerErr.message : String(markerErr),
            })}\n`,
          );
        }
        // 1, not 2: the marker is on disk, so "settled not-ok". Like the
        // load-refusal return, this sits OUTSIDE the walk's try/finally —
        // the claim-release process-exit hook owns the claim, no phase ever
        // opened, and the resident block above is already seeded.
        return 1;
      }
      steering = createSteering({
        caller: spawned.caller,
        rate: spawned.rate,
        // DF2.12 INV-COST-10: money rides the tee, never raw stderr — a plain
        // process.stderr.write bypasses writeAll's engine-log tee and the line
        // would reach journald only (see moneyLineTee).
        emitAttribution: moneyLineTee(),
        // DF3.6a: the resident bounds guard (edit (ii)'s other half). Absent
        // only when the load refused-and-returned above — which never reaches
        // this line — so on every path that constructs steering, bounds exist.
        bounds: boundsGuard,
        // DF3.6b edit (iv): the kernel's account of the last solicitation —
        // `memory.peak`, the bound it was taken against, and whether the leaf
        // was OOM-killed by ITS OWN limit (fleet applies ruling 8's full rule;
        // this side just carries the verdict). A structural
        // callback, never a fleet import: the engine learns WHETHER the kernel
        // killed, never how to. It is what discriminates an OOM (a signal
        // death at the process level) from a timeout or an external kill.
        lastMemory: spawned.lastMemory,
        // DF3.6a: fired when the engine's bounds enforcement stops the resident
        // (the spend breach; DF3.6b adds the rss arms). The engine has already
        // latched telemetry.status="stopped"; the runner — which holds the
        // spawn handle — performs the stop, records the cause on the trace
        // sidecar, and the deterministic walk continues (INV-BND-5).
        onBoundBreach: (e) => {
          // `...e` FIRST: steering always constructs the event with
          // requestId/phase keys present (undefined when absent from the
          // solicit ctx), so a trailing spread would clobber the join keys
          // with undefined and JSON.stringify would DROP them from the line.
          // P12: ALL FOUR fixed keys sit after the spread — `...e` is the
          // engine's own breach event and could equally clobber level/event.
          writeAll(
            2,
            `${JSON.stringify({ ...e, level: "warn", event: "resident_bound_breach", runId, requestId })}\n`,
          );
          try {
            tracer.trace({
              type: "log",
              name: "residentBoundBreach",
              requestId,
              payloadJson: JSON.stringify(e),
            });
          } catch {
            /* the trace store is a sidecar; the warn line is the record */
          }
          // `spawned` is a `let` this closure cannot keep narrowed, so read the
          // spawn through `residentSpawn` — assigned to exactly this spawn two
          // statements above, and the only binding typed `ResidentSpawn` here.
          // Best-effort — the walk continues regardless (INV-BND-5); the
          // run-down finally's idempotent re-stop is already this file's own
          // pattern. P7: the stop is still swallowed (control flow unchanged)
          // but a rejection now leaves a record — else telemetry latches
          // "stopped" while the process may still spend, and nothing
          // distinguishes stop-failed from stopped. No local deadline: this
          // file has no timeout helper, and the engine's withDeadline over
          // its await of this observer bounds the wedge.
          const spawn = residentSpawn;
          if (spawn !== undefined) {
            return spawn.stop().then(undefined, (stopErr: unknown) => {
              writeAll(
                2,
                `${JSON.stringify({
                  level: "warn",
                  event: "resident_stop_failed",
                  runId,
                  requestId,
                  message: stopErr instanceof Error ? stopErr.message : String(stopErr),
                })}\n`,
              );
            });
          }
        },
        // DF3.4 AC6: `fleet attach`'s queued messages are folded into the next
        // of DF3.3's three solicitation points. The engine addresses the in-box
        // steering paths as local paths, exactly as journal.ts addresses
        // runMarkerPath() — so no driver reference is needed here (and none is
        // in scope: this runner has no vm).
        // ownRunId: only THIS run's queued messages fold as its intent — a
        // line addressed to another run sharing the host inbox is counted and
        // skipped, never consumed here (round 7 finding 20).
        //
        // ALWAYS ENABLED (round-10 S1). The earlier guard disabled the filter
        // whenever `runId` was not in the minted fleet shape (`qds-…`), on the
        // theory that failing toward delivery was safer than starving this
        // run's own guidance. It was not: this runner's DEFAULT `--run-id` is a
        // bare uuid (and a correlated run's resolved requestId is one too), so
        // the disabled filter is the default configuration, and with the filter
        // off every line queued for OTHER runs on this shared host inbox folded
        // into THIS run's prompt AND was acked — consumed, so the run it was
        // addressed to never saw it. That is cross-run message theft, not
        // delivery. The filter is harmless when no foreign lines exist and it
        // is the only thing preventing the theft, so it never turns off; the
        // cost lands on the id-space mismatch, which is the operator's fact to
        // fix (pass the same `--run-id` the `fleet attach` targeted) and is
        // warned once at engine STARTUP (the hoisted
        // `steering_ownrun_id_space_mismatch` emission above the resident
        // arming) — so the warn also covers unarmed runs, where the filter
        // still refuses every attach line.
        // S2 (round-10): the queue is persistent and the engine's dedupe is
        // not, so the engine is handed the ack log it can then treat as the
        // persistence — ids this process (or a previous one) already acked are
        // settled, neither re-folded nor re-acked after a crash-retry.
        inbox: {
          ...localSteeringInbox({ ownRunId: runId }),
          ackedIds: readSteeringAckedIds,
        },
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

    // DF1.10 Observability Contract. Emitted HERE — after the manifest, the
    // marker check, the trace claim, the cap reconciliation and the resident
    // arming, with the walk one statement away — because "the engine started"
    // should mean the engine is about to do the thing it exists for. Every
    // refusal above precedes it, so a run that never got going never claims it
    // did, and `engine_refused_replay` and `engine_started` are mutually
    // exclusive by construction.
    //
    // `engine_start_ms` is process uptime, not time-since-main: in the box the
    // interesting number includes bun's own start and the module graph's load,
    // which is exactly the cost the compiled-vs-checkout delivery route (AC2a)
    // is chosen between on. Its snake_case spelling is the Observability
    // Contract's own (see `engine_settled` below) — pinned, not an oversight.
    const engineStartMs = Math.round(process.uptime() * 1000);
    emitEngineEvent("engine_started", { runId, requestId, phaseId: null }, {
      pipelineId: manifest.pipelineId,
      phaseCount: manifest.phases.length,
      runRoot,
      markerPath,
      engine_start_ms: engineStartMs,
    });

    const walkStartedAt = performance.now();
    const outcomes = residentAborted
      ? []
      : await walkPhases(
          run,
          manifest.phases,
          makeBodyFactory(
            runRoot,
            tracer,
            requestId,
            resolved ? { runId, repoSlug: resolved.repoSlug, issueId: resolved.issueId ?? resolved.workId } : undefined,
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

    const phaseWalkMs = Math.round(performance.now() - walkStartedAt);

    const result = run.finish(!terminated);
    // DF1.10 Observability Contract. Immediately after `finish` — which is
    // where the terminal marker is written — so the log line and the marker
    // agree, and a harvested log answers "did it settle, and how" without the
    // reader needing the marker too. The run-end solicitation and the tracer
    // close still follow; both are sidecars and neither can change this verdict.
    // A walk that never ran (a resident abort) reports 0, per the contract's
    // "a path never evaluated reports 0".
    //
    // `ok` is read off the SAME value the marker carries — `finish` returns the
    // RunOutcome it wrote — rather than re-derived from the exit code. The two
    // agree today (`exitCode = ok ? 0 : 1`), which is precisely why deriving it
    // would be a comment that stops being true silently if that mapping ever
    // grows a case.
    //
    // `engine_start_ms` and `phase_walk_ms` are snake_case in an otherwise
    // camelCase payload because the story's Observability Contract names them
    // that way, verbatim, alongside `marker_read_ms` and `harvest_pull_ms`. They
    // are CONTRACT-PINNED — a consumer greps these exact keys. Do not "fix" the
    // casing; the inconsistency is cheaper than the rename.
    emitEngineEvent("engine_settled", { runId, requestId, phaseId: null }, {
      ok: result.ok,
      exitCode: result.exitCode,
      terminated,
      phasesSettled: outcomes.length,
      engine_start_ms: engineStartMs,
      phase_walk_ms: phaseWalkMs,
    });
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
    // #217 F-D1 (TS half): the terminal marker is committed (or the run has
    // failed its walk) — release the root claim FIRST, deterministically,
    // before the process exits, so the next engine on this root contends with
    // the marker rather than with a lingering claim. Idempotent with the
    // process-`exit` hook registered at acquisition.
    releaseEngineClaim();
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
    // DF3.6b edit (vii) — REFRESH PRECEDENCE. The engine's word outranks the
    // process probe's whenever the engine wrote one. On a kernel OOM-kill the
    // engine has already written `exitStatus:"overflow"` (AC1's make-or-break
    // journal observable), while the probe can only ever report a signal death
    // as "transient": an unconditional refresh here would overwrite the one
    // field AC1 is proven by. The probe still fills the field on every path
    // where the engine wrote none, which is every pre-DF3.6b path.
    if (residentSpawn !== undefined && residentBlock.exitStatus === null) {
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
