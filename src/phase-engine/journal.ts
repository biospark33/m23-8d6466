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

/**
 * Terminal-marker root. `/run` in the box — the only environment whose markers a
 * poller reads. `QDS_RUN_ROOT` exists solely so the host-side test suite can
 * exercise `finish()` where `/run` is root-owned (Linux CI) or absent (darwin
 * dev); it is never set on a real run and no production path writes it.
 * Read at call time so the value is never frozen into a module constant.
 */
export function runMarkerRoot(): string {
  return process.env.QDS_RUN_ROOT ?? "/run";
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

export interface JournalFile {
  version: string;
  runId: string;
  ok: boolean;
  completedAt?: string;
  phases: PhaseRecord[];
  gateEvents: GateEvent[];
}

export class FileJournal implements PhaseJournal {
  private readonly rows: PhaseRecord[] = [];
  private readonly events: GateEvent[] = [];
  private ok = false;
  private completedAt: string | undefined;

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
      phases: this.rows,
      gateEvents: this.events,
    };
    const resolved = path.resolve(this.filePath);
    const tmp = `${resolved}.tmp`;
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
  // commitment: write to a temp file and rename, never in place. `O_EXCL |
  // O_NOFOLLOW` so a symlink planted at the temp path cannot redirect the write.
  const tmp = `${target}.tmp`;
  fs.rmSync(tmp, { force: true });
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
