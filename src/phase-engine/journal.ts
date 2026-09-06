/**
 * The `PhaseJournal` port and its file-backed implementation (Story DF1.1).
 *
 * The port is the only surface DF1.2 (gate-event persistence) and DF1.4 (SQLite
 * trace store) may write through. DF1.4 replaces the storage implementation
 * behind these four operations without changing their signatures or semantics.
 *
 * Two rules the implementation exists to keep honest:
 *
 *  - **Default-fail.** `writePhase` persists `status: "fail"` regardless of what
 *    the caller passes; `promotePhase` is the sole path to `success`. A record
 *    written and never promoted therefore reads `fail`, so a crash between the
 *    write and the promotion is recorded as failure rather than as absence
 *    (INV-5). An implementation that wrote an optimistic `success` and
 *    downgraded it in a `catch` would pass a naive read and fail this rule.
 *  - **Durable before the next phase.** Every operation flushes the whole
 *    journal to disk (write-temp + fsync + rename) before it returns, so no
 *    write for phase N+1 is issued before phase N's row is durable. A failed
 *    flush throws — it never silently skips.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import type {
  GateEvent,
  PhaseRecord,
  PhaseStatus,
  RunOutcome,
} from "./types.ts";
import type { ExitStatus } from "./types.ts";
import type { ResidentTelemetry } from "./steering.ts";

/**
 * The run root — the single derivation for every consumer (F056). `/run` in the
 * box: the only environment whose markers a poller reads.
 *
 * `QDS_RUN_ROOT` exists so the host-side test suite can exercise `finish()`
 * where `/run` is root-owned (Linux CI) or absent (darwin dev). Task 0.1 § Q4:
 * the box image does not set it (`oci/exedev/Dockerfile` does not, and no
 * in-box path writes it), so inside the box this is always `/run`. Since
 * DF1.10 AC7 there is no production writer EITHER: the one caller that set it
 * outside a test was the host-driven remote runner, which pointed the marker
 * and trace at `<records-dir>/<run-id>` because the engine ran on the host
 * while the phases ran on the box. The engine now runs IN the box, one box per
 * run, each with its own tmpfs `/run`, so nothing is SUPPOSED to set it outside
 * a test — which is why `harvest.ts`'s `BOX_RUN_ROOT` is a host-side literal
 * that deliberately does NOT call this function: an ambient `QDS_RUN_ROOT` in
 * an operator's shell must not redirect a box probe.
 *
 * RESIDUAL HAZARD, stated rather than papered over: "no production writer" is
 * not "not honoured in production". This still reads the ambient environment at
 * runtime — but only the IN-BOX ENGINE's environment can move anything. Every
 * host-side reader (DF3.2's poller, harvest, status) polls the `BOX_RUN_ROOT`
 * literal and never calls here, so an operator exporting `QDS_RUN_ROOT` in a
 * host shell, host unit file or host CI job relocates nothing: host readers
 * never see the value. What strands the poller is an export that reaches the
 * IN-BOX ENGINE's own environment — an env file, an `Environment=` on the
 * engine's unit, a shell that then starts the engine: the engine writes
 * `<that>/journal/final.json` while the poller still waits at
 * `/run/journal/final.json` forever. Debug a stranded poller by looking at the
 * ENGINE's environment, not the operator's shell. The branch is kept because
 * the host-side suite has no other way to exercise `finish()` where `/run` is
 * root-owned (Linux CI) or absent (darwin dev). The mitigations are external
 * to this function: every HOST-side reader uses the `BOX_RUN_ROOT` literal
 * instead of calling here, and `tests/providers/exedev/image-assets.test.ts`
 * refuses a box image that sets the variable at all (INV-IBOX-13 / DF3.7 AC4).
 *
 * An empty or whitespace-only value is not a path — it is treated as unset, so
 * `QDS_RUN_ROOT=""` cannot silently relocate the marker to the process cwd.
 * That contract is THIS function's, not the variable's: `dispatch-task.ts`
 * reads the same variable for a different root (artifact reads, cwd fallback)
 * and REFUSES on a blank value rather than falling back. Both are fail-closed;
 * they are not the same rule and neither is the other's derivation.
 * Read at call time so the value is never frozen into a module constant.
 */
export function runMarkerRoot(): string {
  const fromEnv = process.env.QDS_RUN_ROOT;
  return fromEnv === undefined || fromEnv.trim() === "" ? "/run" : fromEnv;
}

/** The fixed in-box completion signal DF3.2's host-side poller keys on (AC7). */
export function runMarkerPath(): string {
  return path.join(runMarkerRoot(), "journal", "final.json");
}

export interface PhaseJournal {
  /** Upsert by `phaseId`. Always persists `fail` — promotion is a separate call. */
  writePhase(record: PhaseRecord): void;
  /** The sole path to `success`. */
  promotePhase(phaseId: string, status: PhaseStatus, exitStatus?: ExitStatus): void;
  /** DF1.2-owned event shape, append-only. */
  writeGateEvent(event: GateEvent): void;
  /** Settles the run row: `ok = phases.length > 0 && all success && accepted`. */
  finish(runId: string, accepted: boolean): RunOutcome;
  /** Rows in declaration order — used by the banner and by tests. */
  phases(): readonly PhaseRecord[];
}

/** Raised when the journal cannot be persisted; always fails the run. */
export class JournalWriteError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "JournalWriteError";
  }
}

/**
 * Temp names unique per writer (PR #216 round 4, P29). The old shared
 * `<target>.tmp` let two concurrent writers interleave — A opens tmp (inode1),
 * B truncates/recreates tmp (inode2), A's `renameSync` then publishes B's
 * half-written inode while B is still mid-write, so the marker is briefly
 * observable at the target torn. `pid` separates processes, a monotonic nonce
 * separates calls within one, so no two writers ever share a temp inode.
 * `O_EXCL` (marker) stays the symlink defense on the now-unpredictable name;
 * the rename target is unchanged. A crashed writer strands its own
 * uniquely-named temp instead of one the next writer would have truncated —
 * litter, not risk: nothing reads temp names, and /run is tmpfs in-box.
 */
let tmpNonce = 0;
function uniqueTmp(target: string): string {
  return `${target}.tmp.${process.pid}.${++tmpNonce}`;
}

export interface JournalFile {
  version: string;
  runId: string;
  ok: boolean;
  completedAt?: string;
  phases: PhaseRecord[];
  gateEvents: GateEvent[];
  /**
   * DF3.3: the resident orchestrator's telemetry block. Optional on the file
   * by design: the PhaseJournal port knows nothing about the resident, so
   * presence is a pipeline-runner guarantee, not a journal one — the runner
   * seeds the block (`status: "disabled"` when no resident was armed) before
   * the terminal marker can exist and refreshes it after the run-end
   * solicitation, so a settled pipeline run always carries it. Not part of
   * the PhaseJournal port: it is journal-file content, not a phase operation,
   * and its trace mirror (tripwires) already rides the runner's own tracer
   * rows.
   */
  resident?: ResidentTelemetry;
}

export class FileJournal implements PhaseJournal {
  private readonly rows: PhaseRecord[] = [];
  private readonly events: GateEvent[] = [];
  private ok = false;
  private completedAt: string | undefined;
  private resident: ResidentTelemetry | undefined;

  constructor(
    private readonly filePath: string,
    private readonly runId: string,
  ) {
    fs.mkdirSync(path.dirname(path.resolve(filePath)), { recursive: true });
    this.flush();
  }

  writePhase(record: PhaseRecord): void {
    // Default-fail at the journal boundary as well as at the record model, so
    // neither layer alone can let an optimistic `success` through.
    const row: PhaseRecord = { ...record, status: "fail" };
    const at = this.rows.findIndex((r) => r.phaseId === row.phaseId);
    if (at >= 0) this.rows[at] = row;
    else this.rows.push(row);
    this.flush();
  }

  promotePhase(phaseId: string, status: PhaseStatus, exitStatus?: ExitStatus): void {
    const row = this.rows.find((r) => r.phaseId === phaseId);
    if (!row) throw new JournalWriteError(`promotePhase: no row for phaseId ${phaseId}`);
    row.status = status;
    if (exitStatus !== undefined) row.exitStatus = exitStatus;
    row.updatedAt = new Date().toISOString();
    this.flush();
  }

  writeGateEvent(event: GateEvent): void {
    this.events.push(event);
    this.flush();
  }

  /** DF3.3: sets the resident telemetry block; flushed like every other op.
   *  Deliberately twice-callable — the runner seeds pre-finish and refreshes
   *  post-finish; the later call replaces the earlier block. The intermediate
   *  flush is the same synchronous full-rewrite every op performs, so the
   *  seed is durable before `finish()` emits the terminal marker. */
  writeResident(telemetry: ResidentTelemetry): void {
    this.resident = telemetry;
    this.flush();
  }

  finish(runId: string, accepted: boolean): RunOutcome {
    if (runId !== this.runId) {
      throw new JournalWriteError(`finish: runId ${runId} does not match journal run ${this.runId}`);
    }
    this.ok = this.rows.length > 0 && this.rows.every((r) => r.status === "success") && accepted;
    this.completedAt = new Date().toISOString();
    this.flush();
    return { ok: this.ok, completedAt: this.completedAt };
  }

  phases(): readonly PhaseRecord[] {
    return this.rows;
  }

  private flush(): void {
    const body: JournalFile = {
      version: "1.0.0",
      runId: this.runId,
      ok: this.ok,
      ...(this.completedAt ? { completedAt: this.completedAt } : {}),
      ...(this.resident !== undefined ? { resident: this.resident } : {}),
      phases: this.rows,
      gateEvents: this.events,
    };
    const resolved = path.resolve(this.filePath);
    const tmp = uniqueTmp(resolved);
    let fd: number | undefined;
    try {
      // O_NOFOLLOW: a symlink planted at the temp path must not redirect the write.
      fd = fs.openSync(
        tmp,
        fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_TRUNC | fs.constants.O_NOFOLLOW,
        0o600,
      );
      fs.writeFileSync(fd, `${JSON.stringify(body, null, 2)}\n`);
      fs.fsyncSync(fd);
      fs.closeSync(fd);
      fd = undefined;
      fs.renameSync(tmp, resolved);
    } catch (err) {
      if (fd !== undefined) {
        try {
          fs.closeSync(fd);
        } catch {
          /* the original failure is the one worth reporting */
        }
      }
      throw new JournalWriteError(`journal write failed: ${resolved}`, { cause: err });
    }
  }
}

/**
 * AC7's terminal marker. Written on every settled run, accepted or not; a run
 * that never reaches `finish` leaves it absent, which is what makes absence
 * meaningful to the poller.
 */
export function writeTerminalMarker(runId: string, outcome: RunOutcome): void {
  const target = runMarkerPath();
  fs.mkdirSync(path.dirname(target), { recursive: true });
  // The marker is read by a poller in another process, so its presence must be a
  // commitment: write to a temp file and rename, never in place. The temp name
  // is UNIQUE per writer (`uniqueTmp`, PR #216 round 4 P29) so concurrent
  // writers never share an inode; `O_EXCL | O_NOFOLLOW` stays as the symlink
  // defense, and the pre-open `rmSync` the shared name needed is gone with it.
  const tmp = uniqueTmp(target);
  const fd = fs.openSync(
    tmp,
    fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW,
    0o600,
  );
  try {
    fs.writeFileSync(
      fd,
      `${JSON.stringify({ runId, ok: outcome.ok, completedAt: outcome.completedAt })}\n`,
    );
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, target);
}
