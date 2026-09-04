/**
 * DF1.10 — the in-box phase engine's own contract.
 *
 * Three things this suite pins, none of which existed before DF1.10:
 *
 *  1. **AC6 / INV-IBOX-6 — marker-replay refusal.** An engine invoked against a
 *     run that already carries a terminal marker refuses before any phase runs
 *     and before any journal row is written. The unit is `Restart=no`, but a
 *     restart is not the only way a second engine reaches a settled run (a
 *     manual `fleet run`, an operator re-issuing the command, a supervisor
 *     someone adds later), so the engine refuses on its own account rather than
 *     trusting the substrate to never ask twice.
 *  2. **C19 — the executing kind set is exactly `code | dispatch_task`.** The
 *     two removed kinds refuse AT LOAD with a remediation, not mid-walk after
 *     spend, and `PhaseKind` no longer carries them at the type level either.
 *  3. **AC2b — run-root.** The manifest, its cap witness and every code phase's
 *     `cwd` resolve under one `--run-root`, with the manifest pair at
 *     `<root>/.qds/`; and `--run-root` moves NONE of that onto the marker root,
 *     which stays `runMarkerRoot()`'s independent lever (INV-IBOX-9).
 *
 * Plus the engine-log redirect and the Observability Contract's event set.
 *
 * DF1.1's default-fail-on-a-thrown-body demonstration also lives here. It used
 * to ride `pipeline.qds-factory.json`'s `kind: "engineer"` phase — a kind that
 * failed only because nothing implemented it. C19 removes that kind, so the
 * demonstration moves to a synthetic throwing body, which is what it was always
 * really about: the rule is "a body that throws is never promoted", not "an
 * unimplemented kind throws".
 */
import { afterAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { readJournal } from "./journal-test-util.ts";
import {
  FileJournal,
  PhaseSpecSchema,
  PipelineManifestSchema,
  Run,
  walkPhases,
  type PhaseBody,
  type PhaseSpec,
} from "../../src/phase-engine/index.ts";
import { runMarkerPath } from "../../src/phase-engine/journal.ts";
import type { PhaseKind } from "../../src/phase-engine/types.ts";

const REPO_ROOT = path.resolve(import.meta.dir, "..", "..");
const RUNNER = path.join(REPO_ROOT, "scripts", "pipeline-run.ts");

const tmpRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "df1-10-inbox-")));
afterAll(() => fs.rmSync(tmpRoot, { recursive: true, force: true }));

let seq = 0;

interface Workspace {
  dir: string;
  /** The customer checkout stand-in — what production passes as `--run-root`. */
  runRoot: string;
  /** `<runRoot>/.qds`, where dispatch fills the manifest pair (AC2b). */
  qds: string;
  manifest: string;
  journal: string;
  /** `QDS_RUN_ROOT` for the spawned engine — `/run`'s stand-in off the box. */
  markerRoot: string;
  markerFile: string;
  engineLog: string;
  /** Written by a code phase's command; its absence proves no phase body ran. */
  sentinel: string;
}

/**
 * A workspace shaped like the in-box layout: a checkout root with the manifest
 * pair beneath `.qds/`, and a marker root that is deliberately somewhere else.
 */
function workspace(): Workspace {
  const dir = path.join(tmpRoot, `ws-${seq++}`);
  const runRoot = path.join(dir, "src");
  const qds = path.join(runRoot, ".qds");
  fs.mkdirSync(qds, { recursive: true });
  const markerRoot = path.join(dir, "run");
  return {
    dir,
    runRoot,
    qds,
    manifest: path.join(qds, "pipeline.yaml"),
    journal: path.join(dir, "journal.jsonl"),
    markerRoot,
    markerFile: path.join(markerRoot, "journal", "final.json"),
    engineLog: path.join(dir, "engine.log"),
    sentinel: path.join(dir, "phase-ran"),
  };
}

/**
 * A code phase whose command touches the workspace sentinel. The whole point of
 * the AC6 assertions is that this file does NOT appear, so the command has to
 * be one that really would create it — `sh -c` rather than a no-op.
 */
function sentinelPhase(ws: Workspace, name: string, over: Partial<PhaseSpec> = {}): PhaseSpec {
  return {
    name,
    kind: "code",
    description: `Touch the run sentinel for phase ${name}`,
    maxDurationMs: 15_000,
    retries: 0,
    command: ["sh", "-c", `printf '%s\\n' "$(pwd)" >> ${JSON.stringify(ws.sentinel)}`],
    ...over,
  };
}

/** A second phase that does nothing: `MIN_PHASES` is 2 and the sentinel's line
 *  count is load-bearing, so the filler must not write to it. */
function tailPhase(): PhaseSpec {
  return {
    name: "tail",
    kind: "code",
    description: "Inert tail phase — the manifest schema requires two",
    maxDurationMs: 15_000,
    retries: 0,
    command: ["true"],
  };
}

function writeManifest(ws: Workspace, phases: unknown[], over: Record<string, unknown> = {}): void {
  fs.writeFileSync(
    ws.manifest,
    JSON.stringify({
      version: "1.0.0",
      pipelineId: "in-box-demo",
      runBudgetMs: 200_000,
      phases,
      ...over,
    }),
  );
}

/** Dispatch's cap witness, beside the manifest and freshly stamped. */
function writeWitness(ws: Workspace, body: Record<string, unknown>): void {
  fs.writeFileSync(path.join(ws.qds, "run-context.json"), JSON.stringify(body));
}

/** A settled terminal marker, exactly as `writeTerminalMarker` leaves one. */
function writeMarker(ws: Workspace, body: Record<string, unknown>): string {
  fs.mkdirSync(path.dirname(ws.markerFile), { recursive: true });
  const text = `${JSON.stringify(body)}\n`;
  fs.writeFileSync(ws.markerFile, text);
  return text;
}

function spawnEngine(ws: Workspace, args: string[], extraEnv: Record<string, string> = {}) {
  return Bun.spawn({
    // `process.execPath`, not "bun": `bun test` runs every file in one process
    // and a sibling suite that rewrote PATH must not pick this runtime.
    cmd: [process.execPath, RUNNER, ...args],
    cwd: REPO_ROOT,
    env: { ...process.env, QDS_RUN_ROOT: ws.markerRoot, ...extraEnv },
    stdout: "pipe",
    stderr: "pipe",
  });
}

/** The default flag set: everything the engine requires, nothing more. */
function baseArgs(ws: Workspace, runId: string): string[] {
  return [
    "--manifest", ws.manifest,
    "--run-root", ws.runRoot,
    "--budget-ms", "200000",
    "--journal", ws.journal,
    "--run-id", runId,
    // Every case here is deterministic; a resident would add a real pi spawn.
    "--no-resident",
  ];
}

async function run(
  ws: Workspace,
  args: string[],
  extraEnv: Record<string, string> = {},
): Promise<{ exitCode: number; stderr: string; stdout: string }> {
  const proc = spawnEngine(ws, args, extraEnv);
  const [exitCode, stderr, stdout] = await Promise.all([
    proc.exited,
    new Response(proc.stderr).text(),
    new Response(proc.stdout).text(),
  ]);
  return { exitCode, stderr, stdout };
}

/** The engine's structured observability lines, in order. */
function events(text: string): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (!t.startsWith("{")) continue;
    try {
      const row = JSON.parse(t) as Record<string, unknown>;
      if (typeof row.event === "string") out.push(row);
    } catch {
      /* relayed child output that merely starts with "{" */
    }
  }
  return out;
}

const eventNames = (text: string): unknown[] => events(text).map((e) => e.event);

// ───────────────────────────────────────────────────────────────────────────
// AC6 / INV-IBOX-6 — marker-replay refusal
// ───────────────────────────────────────────────────────────────────────────

describe("AC6 — an engine refuses a run that already carries a terminal marker", () => {
  test("it walks no phase, writes no journal row and leaves the marker byte-identical", async () => {
    const ws = workspace();
    writeManifest(ws, [sentinelPhase(ws, "plan"), sentinelPhase(ws, "build")]);
    const original = writeMarker(ws, {
      runId: "settled-run",
      ok: true,
      completedAt: "2026-09-01T00:00:00.000Z",
    });

    const { exitCode, stderr } = await run(ws, baseArgs(ws, "settled-run"));

    // MIRRORS the marker: it says ok:true, so this reports 0. Retrying a
    // finished run is idempotent — the same ask twice gives the same answer —
    // and exit 2 stays reserved for "genuinely could not settle". What tells a
    // mirror apart from a real walk is `engine_refused_replay`, not the code.
    expect(exitCode).toBe(0);
    // The load-bearing assertion: no phase body ran.
    expect(fs.existsSync(ws.sentinel)).toBe(false);
    // The refusal precedes `new FileJournal`, so not even a header row exists.
    expect(fs.existsSync(ws.journal)).toBe(false);
    // INV-IBOX-6: no `fail` row overwritten, and the first run's marker stands.
    expect(fs.readFileSync(ws.markerFile, "utf8")).toBe(original);

    const refusal = events(stderr).find((e) => e.event === "engine_refused_replay");
    expect(refusal).toBeDefined();
    expect(refusal?.runId).toBe("settled-run");
    expect(typeof refusal?.requestId).toBe("string");
    // No phase was reached, so the contract's `phaseId` is honestly null.
    expect(refusal?.phaseId).toBeNull();
    // `{code, message, remediation}` — the story's error envelope.
    const error = refusal?.error as { code?: string; message?: string; remediation?: string };
    expect(error?.code).toBe("ENGINE_MARKER_PRESENT");
    expect(refusal?.exitCode).toBe(0);
    // The identity the marker claimed, echoed so "whose marker was that?" is
    // answerable from the log line rather than only from a box `fleet teardown`
    // is about to destroy. It matches, which is WHY this one mirrors.
    expect(refusal?.markerRunId).toBe("settled-run");
    // A mirrored 0 is not a failure — it is the idempotent ack of a finished
    // run — so the line must not be levelled `error` and page someone.
    expect(refusal?.level).toBe("info");
    expect(error?.message).toContain(ws.markerFile);
    expect(error?.remediation).toMatch(/harvest|teardown/i);
    // The engine never started, so it must not claim it did.
    expect(eventNames(stderr)).not.toContain("engine_started");
    expect(eventNames(stderr)).not.toContain("engine_settled");
  }, 60_000);

  test("positive control — the identical invocation DOES walk when no marker exists", async () => {
    const ws = workspace();
    writeManifest(ws, [sentinelPhase(ws, "plan"), sentinelPhase(ws, "build")]);
    // Deliberately no writeMarker(): the ONLY difference from the case above.

    const { exitCode, stderr } = await run(ws, baseArgs(ws, "fresh-run"));

    expect(exitCode).toBe(0);
    // Both phase bodies really ran — so the refusal above is what stopped them,
    // not a broken fixture. Delete the marker check and this file appears there
    // too, and the assertion above fails.
    expect(fs.readFileSync(ws.sentinel, "utf8").trim().split("\n")).toHaveLength(2);
    expect(readJournal(ws.journal).phases.map((p) => [p.name, p.status])).toEqual([
      ["plan", "success"],
      ["build", "success"],
    ]);
    expect(JSON.parse(fs.readFileSync(ws.markerFile, "utf8")).ok).toBe(true);
    expect(eventNames(stderr)).not.toContain("engine_refused_replay");
  }, 60_000);

  test("a marker carrying no boolean `ok` refuses with 2 — there is no verdict to mirror", async () => {
    const ws = workspace();
    writeManifest(ws, [sentinelPhase(ws, "plan"), tailPhase()]);
    // Something settled here — the file exists — but guessing `ok` in either
    // direction would be worse than saying the verdict is unreadable.
    writeMarker(ws, { runId: "verdictless", completedAt: "2026-09-01T00:00:00.000Z" });

    const { exitCode, stderr } = await run(ws, baseArgs(ws, "verdictless"));

    expect(exitCode).toBe(2);
    expect(fs.existsSync(ws.sentinel)).toBe(false);
    expect(fs.existsSync(ws.journal)).toBe(false);
    const refusal = events(stderr).find((e) => e.event === "engine_refused_replay");
    expect((refusal?.error as { code?: string })?.code).toBe("ENGINE_MARKER_UNUSABLE");
  }, 60_000);

  test("a marker naming ANOTHER run is refused, never mirrored", async () => {
    const ws = workspace();
    writeManifest(ws, [sentinelPhase(ws, "plan"), sentinelPhase(ws, "build")]);
    // The shape that makes this reachable: `runMarkerPath()` takes no argument,
    // so ONE file serves every run executed against a root. In the box that
    // root is `/run`, which the unit declares `RuntimeDirectoryPreserve=yes` —
    // so it outlives the instance that wrote it, and `qds-engine run scratch-1`
    // followed by `qds-engine run scratch-2` (a hand invocation this engine
    // explicitly supports) lands the second run on the first's marker.
    writeMarker(ws, { runId: "scratch-1", ok: true, completedAt: "2026-09-01T00:00:00.000Z" });

    const { exitCode, stderr } = await run(ws, baseArgs(ws, "scratch-2"));

    // NOT 0. Mirroring here would report scratch-2 as a successful run that
    // never walked a phase, and a dispatcher reads that as "the work is done".
    expect(exitCode).toBe(2);
    expect(fs.existsSync(ws.sentinel)).toBe(false);
    expect(fs.existsSync(ws.journal)).toBe(false);
    const refusal = events(stderr).find((e) => e.event === "engine_refused_replay");
    expect((refusal?.error as { code?: string })?.code).toBe("ENGINE_MARKER_FOREIGN");
    expect(refusal?.markerRunId).toBe("scratch-1");
    expect(refusal?.runId).toBe("scratch-2");
    // Both ids in the message: the operator's next command names one of them.
    expect((refusal?.error as { message?: string })?.message).toContain("scratch-1");
    expect(eventNames(stderr)).not.toContain("engine_started");
  }, 60_000);

  test("an ok:FALSE marker for another run is refused too — the inversion is just as wrong", async () => {
    const ws = workspace();
    writeManifest(ws, [sentinelPhase(ws, "plan"), sentinelPhase(ws, "build")]);
    // The mirror's other direction, and the reason the runId check is not just
    // an optimisation: a stranger's `ok:false` would fail a run that never ran.
    writeMarker(ws, { runId: "scratch-1", ok: false, completedAt: "2026-09-01T00:00:00.000Z" });

    const { exitCode, stderr } = await run(ws, baseArgs(ws, "scratch-2"));

    expect(exitCode).toBe(2);
    expect((events(stderr).find((e) => e.event === "engine_refused_replay")?.error as { code?: string })?.code)
      .toBe("ENGINE_MARKER_FOREIGN");
    expect(fs.existsSync(ws.sentinel)).toBe(false);
  }, 60_000);

  const malformed: [string, string][] = [
    // Power loss mid-write to tmpfs leaves either of these. `writeTerminalMarker`
    // writes temp + fsync + rename, so neither should be REACHABLE — which is
    // exactly why the engine must not depend on that when it finds one.
    ["a zero-byte marker", ""],
    ["a truncated marker", '{"runId":"x",'],
  ];
  for (const [label, body] of malformed) {
    test(`${label} refuses with 2 — present, illegible, and never a re-walk`, async () => {
      const ws = workspace();
      writeManifest(ws, [sentinelPhase(ws, "plan"), tailPhase()]);
      fs.mkdirSync(path.dirname(ws.markerFile), { recursive: true });
      fs.writeFileSync(ws.markerFile, body);

      const { exitCode, stderr } = await run(ws, baseArgs(ws, "x"));

      expect(exitCode).toBe(2);
      expect(fs.existsSync(ws.sentinel)).toBe(false);
      expect(fs.existsSync(ws.journal)).toBe(false);
      const refusal = events(stderr).find((e) => e.event === "engine_refused_replay");
      // UNUSABLE, not FOREIGN: nothing was legible enough to name a run, and
      // telling an operator their marker belongs to someone else on the
      // strength of a file that would not parse is a claim, not an observation.
      expect((refusal?.error as { code?: string })?.code).toBe("ENGINE_MARKER_UNUSABLE");
    }, 60_000);
  }

  test("a marker that is not a regular file is refused without being read", async () => {
    const ws = workspace();
    writeManifest(ws, [sentinelPhase(ws, "plan"), tailPhase()]);
    fs.mkdirSync(path.dirname(ws.markerFile), { recursive: true });
    // A symlink to a marker of someone else's choosing: `lstat` sees the link
    // (so "nothing is there" is already false) and a plain read would FOLLOW it
    // and mirror the `ok:true` at the other end — turning the fail-closed
    // refusal into an exit 0 for a run that never walked.
    const planted = path.join(ws.dir, "planted.json");
    fs.writeFileSync(planted, JSON.stringify({ runId: "symlinked", ok: true }));
    fs.symlinkSync(planted, ws.markerFile);

    const { exitCode, stderr } = await run(ws, baseArgs(ws, "symlinked"));

    expect(exitCode).toBe(2);
    expect(fs.existsSync(ws.sentinel)).toBe(false);
    const refusal = events(stderr).find((e) => e.event === "engine_refused_replay");
    expect((refusal?.error as { code?: string })?.code).toBe("ENGINE_MARKER_UNREADABLE");
  }, 60_000);

  test("a journal with phase rows and NO marker refuses — the crash/reboot half of AC6", async () => {
    const ws = workspace();
    writeManifest(ws, [sentinelPhase(ws, "plan"), sentinelPhase(ws, "build")]);

    // Run 1 really walks: two phases spent money and made commits, and the
    // journal on ext4 `$HOME` is the only record of which.
    expect(await run(ws, baseArgs(ws, "rebooted"))).toMatchObject({ exitCode: 0 });
    const journalBefore = fs.readFileSync(ws.journal, "utf8");
    expect(readJournal(ws.journal).phases).toHaveLength(2);

    // `/run` is tmpfs (measured, story spec): a REBOOT wipes the marker and
    // nothing else. This one `rmSync` IS the reboot — the state a second
    // `fleet run` finds, and the state the marker guard's ENOENT arm used to
    // read as "nothing ever ran here, walk it".
    fs.rmSync(ws.markerFile);

    const { exitCode, stderr } = await run(ws, baseArgs(ws, "rebooted"));

    expect(exitCode).toBe(2);
    const refusal = events(stderr).find((e) => e.event === "engine_refused_replay");
    expect((refusal?.error as { code?: string })?.code).toBe("ENGINE_JOURNAL_ORPHANED");
    // INV-IBOX-6: no phase re-executed — the sentinel would carry two MORE
    // lines, and the commits and spend behind them would be real.
    expect(fs.readFileSync(ws.sentinel, "utf8").trim().split("\n")).toHaveLength(2);
    // And the evidence survived: `new FileJournal` flushes an EMPTY journal over
    // its path in its constructor, before phase 1 runs, so an invocation that
    // got past the guard would destroy the rows that are the only record of
    // what already spent. Byte-for-byte is the assertion because "the phases
    // are still listed" would pass on a rewritten file.
    expect(fs.readFileSync(ws.journal, "utf8")).toBe(journalBefore);
    expect(eventNames(stderr)).not.toContain("engine_started");
  }, 60_000);

  test("positive control — a journal with NO phase rows still walks", async () => {
    const ws = workspace();
    writeManifest(ws, [sentinelPhase(ws, "plan"), sentinelPhase(ws, "build")]);
    // What a run killed before its first phase leaves: `FileJournal`'s
    // constructor flush and nothing else. Refusing on THAT would strand every
    // run whose engine died between the journal open and phase 1, and re-walking
    // it re-spends nothing, because nothing was spent.
    fs.writeFileSync(
      ws.journal,
      `${JSON.stringify({ version: "1.0.0", runId: "header-only", ok: false, phases: [], gateEvents: [] })}\n`,
    );

    const { exitCode, stderr } = await run(ws, baseArgs(ws, "header-only"));

    expect(exitCode).toBe(0);
    expect(fs.readFileSync(ws.sentinel, "utf8").trim().split("\n")).toHaveLength(2);
    expect(eventNames(stderr)).not.toContain("engine_refused_replay");
  }, 60_000);

  test("a marker the engine cannot even stat refuses too — fail-closed, never a re-walk", async () => {
    // root ignores the mode bits, so the unreadable directory is not unreadable.
    if (process.getuid?.() === 0) return;
    const ws = workspace();
    writeManifest(ws, [sentinelPhase(ws, "plan"), sentinelPhase(ws, "build")]);
    const markerDir = path.dirname(ws.markerFile);
    fs.mkdirSync(markerDir, { recursive: true });
    fs.chmodSync(markerDir, 0o000);
    try {
      const { exitCode, stderr } = await run(ws, baseArgs(ws, "unstattable"));

      expect(exitCode).toBe(2);
      expect(fs.existsSync(ws.sentinel)).toBe(false);
      expect(fs.existsSync(ws.journal)).toBe(false);
      const refusal = events(stderr).find((e) => e.event === "engine_refused_replay");
      expect(refusal).toBeDefined();
      // A different code from a present marker: the operator is being told
      // "I could not prove this run is unstarted", not "it already ran".
      expect((refusal?.error as { code?: string })?.code).toBe("ENGINE_MARKER_UNREADABLE");
    } finally {
      fs.chmodSync(markerDir, 0o700);
    }
  }, 60_000);

  test("the refusal precedes the correlation ladder — a correlated invocation refuses on the marker too", async () => {
    const ws = workspace();
    writeManifest(ws, [sentinelPhase(ws, "plan"), sentinelPhase(ws, "build")]);
    // A correlated run adopts its resolved requestId as its runId, so a marker
    // naming THAT id is this run's own. ok:FALSE, so the mirrored code is 1 —
    // the pre-emption is visible in the event, and the verdict still comes from
    // the run that really settled.
    const requestId = crypto.randomUUID();
    writeMarker(ws, { runId: requestId, ok: false, completedAt: "2026-09-01T00:00:00.000Z" });

    // No --run-id: a correlated run derives its id from the resolved requestId,
    // which is resolved AFTER this guard runs — which is why the guard accepts
    // the requestId as an identity too, or every correlated replay would read
    // as a stranger's marker.
    const args = baseArgs(ws, "unused").filter((a, i, all) =>
      a !== "--run-id" && all[i - 1] !== "--run-id",
    );
    const { exitCode, stderr } = await run(ws, [
      ...args,
      "--repo-slug", "owner/repo",
      "--issue", "42",
      "--request-id", requestId,
    ]);

    expect(exitCode).toBe(1);
    expect(fs.existsSync(ws.sentinel)).toBe(false);
    expect(eventNames(stderr)).toContain("engine_refused_replay");
    const refusal = events(stderr).find((e) => e.event === "engine_refused_replay");
    expect((refusal?.error as { code?: string })?.code).toBe("ENGINE_MARKER_PRESENT");
    // The DF1.8 ladder is a DIFFERENT mechanism (requestId/session-keyed, and
    // correlated-only). It must not be the thing that answered here, or a bare
    // in-box invocation — which is what `qds-engine run <runId>` actually is —
    // would sail straight past.
    expect(eventNames(stderr)).not.toContain("dispatch_failed");
    expect(eventNames(stderr)).not.toContain("run_initiated");
    // Nothing correlated was recorded, so no dispatch-failure log either.
    expect(fs.existsSync(path.join(ws.markerRoot, "dispatch-failures.log"))).toBe(false);
  }, 60_000);

  test("the refusal is logged to the engine log, not only to stderr", async () => {
    const ws = workspace();
    writeManifest(ws, [sentinelPhase(ws, "plan"), sentinelPhase(ws, "build")]);
    writeMarker(ws, { runId: "settled", ok: true, completedAt: "2026-09-01T00:00:00.000Z" });

    const { exitCode } = await run(ws, [...baseArgs(ws, "settled"), "--engine-log", ws.engineLog]);

    expect(exitCode).toBe(0);
    // The tar is the harvest path: a refusal only journald can see is a refusal
    // the operator reads about nowhere.
    expect(eventNames(fs.readFileSync(ws.engineLog, "utf8"))).toContain("engine_refused_replay");
  }, 60_000);
});

// ───────────────────────────────────────────────────────────────────────────
// C19 — the executing kind set
// ───────────────────────────────────────────────────────────────────────────

describe("C19 — PhaseKind is exactly the two kinds that execute", () => {
  test("the type carries exactly `code` and `dispatch_task`", () => {
    // Compile-time, not runtime: this file stops typechecking the day a third
    // member is added to `PhaseKind` without a decision about its executor.
    const executing = ["code", "dispatch_task"] as const;
    type Executing = (typeof executing)[number];
    const widened: Executing extends PhaseKind ? (PhaseKind extends Executing ? true : never) : never = true;
    expect(widened).toBe(true);
    // The runtime half, read off the SCHEMA rather than off the literal above.
    // `expect([...executing]).toEqual(["code","dispatch_task"])` compared a
    // literal to itself and proved only that `toEqual` works, while `bun test`
    // does not evaluate the assignment above at all — so a third kind added to
    // the schema was caught by `bun run typecheck` in CI and by nothing here.
    // The refusal message enumerates the closed set straight from
    // `EXECUTING_KINDS`, which makes it observable at runtime.
    const refused = PhaseSpecSchema.safeParse({ name: "x", kind: "not-a-kind", description: "d" });
    expect(refused.success).toBe(false);
    const listed = refused.success
      ? []
      : (refused.error.issues.map((i) => i.message).join("; ").match(/kind must be one of ([^;]+);/)?.[1] ?? "")
          .split(" | ")
          .map((k) => k.replaceAll("'", ""));
    expect(listed).toEqual([...executing]);
  });

  test("the manifest schema accepts both executing kinds", () => {
    expect(
      PhaseSpecSchema.safeParse({
        name: "plan", kind: "code", description: "Run the planner", command: ["true"],
      }).success,
    ).toBe(true);
    expect(
      PhaseSpecSchema.safeParse({
        name: "build", kind: "dispatch_task", description: "Hand the change to a team",
        roster: "r.yaml", task: "do it",
      }).success,
    ).toBe(true);
  });

  const removed: [string, RegExp][] = [
    // `agent`'s destination is another KIND; `engineer`'s is a host verb, so it
    // names no kind at all — the remediations are genuinely different shapes.
    ["agent", /dispatch_task/],
    ["engineer", /fleet approve\|reject|fleet attach --message/],
  ];
  for (const [kind, remediation] of removed) {
    test(`a manifest declaring kind '${kind}' is refused AT LOAD with a remediation`, () => {
      const result = PipelineManifestSchema.safeParse({
        version: "1.0.0",
        pipelineId: "removed-kind",
        runBudgetMs: 200_000,
        phases: [
          { name: "plan", kind, description: "A phase declaring a removed kind" },
          { name: "build", kind: "code", description: "Run the suite", command: ["true"] },
        ],
      });
      expect(result.success).toBe(false);
      if (result.success) return;
      const detail = result.error.issues.map((i) => i.message).join("; ");
      // A bare "invalid enum value" is not acceptable: the operator has to
      // learn what to write INSTEAD, at load, not after the run spent money.
      expect(detail).toMatch(remediation);
      expect(detail).toContain(kind);
      expect(detail).not.toMatch(/Invalid enum value/);
    });
  }

  test("a removed kind refuses through the real CLI before anything is journalled", async () => {
    const ws = workspace();
    writeManifest(ws, [
      { name: "plan", kind: "engineer", description: "A phase declaring a removed kind" },
      sentinelPhase(ws, "build"),
    ]);

    const { exitCode, stderr } = await run(ws, baseArgs(ws, "removed-kind"));

    expect(exitCode).toBe(2);
    expect(stderr).toContain("engineer");
    expect(stderr).toContain("fleet attach --message");
    // Refused at LOAD, so no phase ran, no row was written and no marker exists
    // — the operator pays nothing to learn the manifest is wrong.
    expect(fs.existsSync(ws.sentinel)).toBe(false);
    expect(fs.existsSync(ws.journal)).toBe(false);
    expect(fs.existsSync(ws.markerFile)).toBe(false);
  }, 60_000);

  test("an `engineer` phase carrying a dispatch_task field still names its remediation", () => {
    // The removed-kind refusal must not be shadowed by the field rules that
    // also fire — an operator porting an old manifest hits both at once.
    const result = PhaseSpecSchema.safeParse({
      name: "e", kind: "engineer", description: "x", roster: "r.yaml", task: "t",
    });
    expect(result.success).toBe(false);
    if (result.success) return;
    // `engineer`'s remediation names host verbs, not a kind — it is the removed
    // kind whose replacement is NOT another phase.
    expect(result.error.issues.map((i) => i.message).join("; ")).toContain("fleet approve|reject");
  });
});

// ───────────────────────────────────────────────────────────────────────────
// DF1.1's default-fail rule, moved off the removed kind
// ───────────────────────────────────────────────────────────────────────────

describe("default-fail on a thrown body (DF1.1 AC1/AC6, preserved through C19)", () => {
  test("a synthetic throwing body journals fail, is never promoted, and the run settles not-ok", async () => {
    const ws = workspace();
    const runId = "synthetic-throw";
    const journal = new FileJournal(ws.journal, runId);
    // `phaseRun`, not `run`: the module-level `run()` above is this file's
    // spawn helper, and a local shadowing it makes every later line in this
    // block read as if it could spawn an engine.
    const phaseRun = new Run({
      ctx: { runId, pipelineId: "in-box-demo", requestId: "req-synthetic" },
      journal,
      log: () => {},
    });

    // The demonstration `pipeline.qds-factory.json`'s `kind: "engineer"` phase
    // used to carry: phase 2's body THROWS, so it is never PROMOTED TO SUCCESS
    // — `phase.ts` catches the throw and settles the row through
    // `promotePhase(phaseId, "fail", …)`, which is why `phase_settled` is
    // emitted for a failed phase too. Synthetic now, because the rule was never
    // about the kind.
    const phases: PhaseSpec[] = [
      { name: "plan", kind: "code", description: "Emit the plan", maxDurationMs: 15_000, retries: 0, command: ["true"] },
      { name: "build", kind: "code", description: "Apply the planned change", maxDurationMs: 15_000, retries: 0, command: ["true"] },
    ];
    const bodies = (spec: PhaseSpec): PhaseBody<unknown> =>
      spec.name === "build"
        ? () => {
            throw new Error("body exploded");
          }
        : () => "planned";

    const savedMarkerRoot = process.env.QDS_RUN_ROOT;
    process.env.QDS_RUN_ROOT = ws.markerRoot;
    try {
      await walkPhases(phaseRun, phases, bodies);
      const result = phaseRun.finish(true);

      expect(result.exitCode).toBe(1);
      // Byte-for-byte the assertion DF1.1's e2e slice made through the fixture.
      expect(readJournal(ws.journal).phases.map((p) => [p.name, p.status])).toEqual([
        ["plan", "success"],
        ["build", "fail"],
      ]);
      expect(readJournal(ws.journal).phases[1]?.exitStatus).toBe("logic");
      expect(readJournal(ws.journal).ok).toBe(false);
      expect(JSON.parse(fs.readFileSync(runMarkerPath(), "utf8")).ok).toBe(false);
    } finally {
      // biome-ignore lint/performance/noDelete: an assignment would set the string "undefined".
      if (savedMarkerRoot === undefined) delete process.env.QDS_RUN_ROOT;
      else process.env.QDS_RUN_ROOT = savedMarkerRoot;
    }
  });
});

// ───────────────────────────────────────────────────────────────────────────
// AC2b — run-root
// ───────────────────────────────────────────────────────────────────────────

describe("AC2b — manifest, witness and code-phase cwd agree on one run root", () => {
  test("`--run-root <checkout>` with the manifest pair at `<checkout>/.qds/` resolves all three", async () => {
    const ws = workspace();
    writeManifest(ws, [sentinelPhase(ws, "plan"), tailPhase()], { limitMicroUsd: 250_000 });
    // Consumer 2: read through the same beneath-root walk, anchored at the
    // SAME root the manifest came through. A witness outside the root refuses.
    writeWitness(ws, { runId: "root-run", effectiveCeilingMicros: 250_000 });

    const { exitCode, stderr } = await run(ws, baseArgs(ws, "root-run"));

    expect(exitCode).toBe(0);
    // Consumer 4: the code phase's cwd is the checkout root itself — not
    // `.qds/`, not the engine's own cwd, not `$HOME`.
    expect(fs.readFileSync(ws.sentinel, "utf8").trim()).toBe(fs.realpathSync(ws.runRoot));
    // Consumers 1 and 2 agreed on the root, asserted POSITIVELY: the engine
    // reached the walk and settled it. `expect(stderr).not.toMatch(/dispatch
    // admitted/)` on its own also passes on an engine that crashed before the
    // reconciliation ever ran, and the paired negative below hard-codes the
    // same phrase, so a reword would break that one and leave this green.
    expect(eventNames(stderr)).toContain("engine_started");
    expect(eventNames(stderr)).toContain("engine_settled");
    expect(stderr).not.toMatch(/dispatch admitted/);
  }, 60_000);

  test("the witness beneath `<checkout>/.qds/` is really READ — a mismatched ceiling refuses", async () => {
    const ws = workspace();
    writeManifest(ws, [sentinelPhase(ws, "plan"), tailPhase()], { limitMicroUsd: 250_000 });
    // Same directory, same root; only the number differs. If the witness read
    // were anchored anywhere else it would be ABSENT rather than mismatched,
    // and the run would settle green on the manifest's own word — which is the
    // uncapped-spend failure the reconciliation exists to stop.
    writeWitness(ws, { runId: "mismatch", effectiveCeilingMicros: 500_000 });

    const { exitCode, stderr } = await run(ws, baseArgs(ws, "mismatch"));

    expect(exitCode).toBe(2);
    expect(stderr).toContain("manifest declares limitMicroUsd 250000 but dispatch admitted 500000");
    expect(fs.existsSync(ws.sentinel)).toBe(false);
  }, 60_000);

  test("`--run-root` moves nothing onto the marker root — the two levers stay independent", async () => {
    const ws = workspace();
    writeManifest(ws, [sentinelPhase(ws, "plan"), tailPhase()]);

    expect(await run(ws, baseArgs(ws, "levers"))).toMatchObject({ exitCode: 0 });

    // INV-IBOX-9 / the frozen contract: the marker is `runMarkerRoot()`'s, and
    // in the box (QDS_RUN_ROOT unset) that is `/run/journal/final.json`. A
    // `--run-root` that could relocate it would move DF3.2's poll key.
    expect(fs.existsSync(ws.markerFile)).toBe(true);
    expect(fs.existsSync(path.join(ws.runRoot, "journal", "final.json"))).toBe(false);
    expect(fs.existsSync(path.join(ws.qds, "journal"))).toBe(false);
  }, 60_000);

  test("negative control — a run root ABOVE the checkout hands every code phase the wrong cwd", async () => {
    const ws = workspace();
    writeManifest(ws, [sentinelPhase(ws, "plan"), tailPhase()]);

    // `--run-root $HOME` in the story's terms: the manifest is still beneath
    // the root, so the read SUCCEEDS and nothing refuses — and then every code
    // phase runs a directory too high, where a relative roster resolves to
    // nothing. Silent, which is exactly why it needs a control.
    const args = baseArgs(ws, "too-high").map((a) => (a === ws.runRoot ? ws.dir : a));
    expect(await run(ws, args)).toMatchObject({ exitCode: 0 });

    expect(fs.readFileSync(ws.sentinel, "utf8").trim()).toBe(fs.realpathSync(ws.dir));
    expect(fs.readFileSync(ws.sentinel, "utf8").trim()).not.toBe(fs.realpathSync(ws.runRoot));
  }, 60_000);
});

// ───────────────────────────────────────────────────────────────────────────
// AC2a — `qds-engine run <runId>`, the unit's entire ExecStart
// ───────────────────────────────────────────────────────────────────────────

describe("AC2a — `run <runId>` derives the whole in-box layout from the run id", () => {
  /** `$HOME` for a spawned engine: the layout is anchored there, not at cwd. */
  function inBoxHome(ws: Workspace): Record<string, string> {
    return { HOME: ws.dir };
  }

  test("the run id is the only argument, and everything else is derived", async () => {
    const ws = workspace();
    writeManifest(ws, [sentinelPhase(ws, "plan"), tailPhase()]);
    // Dispatch's single statement about this run: BOTH ceilings. The money one
    // (`effectiveCeilingMicros`) is DF3.1's and a present witness must carry
    // it; `budgetMs` is the time one the unit cannot pass on argv.
    writeWitness(ws, {
      runId: "qds-20260903-abc123",
      requestId: "req-derived",
      budgetMs: 200_000,
      effectiveCeilingMicros: 250_000,
    });

    const { exitCode, stderr } = await run(ws, ["run", "qds-20260903-abc123"], inBoxHome(ws));

    expect(exitCode).toBe(0);
    // Journal and engine log land on ext4 `$HOME`, runId-prefixed (INV-IBOX-8;
    // the names are the harvest tar's `-C "$HOME" <name>` pairs).
    expect(fs.existsSync(path.join(ws.dir, "qds-20260903-abc123.journal.jsonl"))).toBe(true);
    expect(fs.existsSync(path.join(ws.dir, "qds-20260903-abc123.engine.log"))).toBe(true);
    // The marker stays on the marker root, untouched by the derivation.
    expect(JSON.parse(fs.readFileSync(ws.markerFile, "utf8")).ok).toBe(true);
    // Run-root resolved to the checkout, so the code phase ran there.
    expect(fs.readFileSync(ws.sentinel, "utf8").trim()).toBe(fs.realpathSync(ws.runRoot));
    // requestId propagated from the witness onto every event, not regenerated.
    const logged = events(fs.readFileSync(path.join(ws.dir, "qds-20260903-abc123.engine.log"), "utf8"));
    expect(logged.length).toBeGreaterThan(0);
    for (const e of logged) expect(e.requestId).toBe("req-derived");
    expect(eventNames(stderr)).toContain("engine_started");
  }, 60_000);

  test("a witness with no budgetMs refuses rather than defaulting a ceiling", async () => {
    const ws = workspace();
    writeManifest(ws, [sentinelPhase(ws, "plan"), tailPhase()]);
    writeWitness(ws, { runId: "no-budget", requestId: "req-x", effectiveCeilingMicros: 250_000 });

    const { exitCode, stderr } = await run(ws, ["run", "no-budget"], inBoxHome(ws));

    // AC5: the engine never assumes an upstream ceiling. The unit passes no
    // --budget-ms, so an unstamped witness has to be a refusal — a defaulted
    // ceiling is not a ceiling.
    expect(exitCode).toBe(2);
    expect(stderr).toContain("budgetMs");
    expect(fs.existsSync(ws.sentinel)).toBe(false);
    // AC4, and the reason the engine log opens in the `run` front door rather
    // than where `--engine-log` is parsed: EVERY derivation refusal happens
    // before the derived argv exists, so with the open deferred they landed in
    // journald only — and journald does not ride DF2.5's harvest tar. This is
    // the one invocation shape the unit ever uses, so that was every derivation
    // failure on the box invisible to the operator harvesting it.
    expect(fs.readFileSync(path.join(ws.dir, "no-budget.engine.log"), "utf8")).toContain("budgetMs");
  }, 60_000);

  test("a witness requestId that is not a safe identifier refuses rather than propagating", async () => {
    const ws = workspace();
    writeManifest(ws, [sentinelPhase(ws, "plan"), tailPhase()]);
    // It is not a path component, so nothing escapes a directory through it —
    // but it becomes `--request-id` and rides every engine event and every
    // DF1.4 trace row, where a newline forges a log line. Every other id on
    // this path is bounded (the runId here, `assertFleetRunId` host-side);
    // this one was taken on trust. Refused rather than dropped: falling back to
    // a fresh uuid would break the correlation join with nothing saying so.
    writeWitness(ws, {
      runId: "bad-req",
      requestId: 'req-1"\n{"event":"forged"}',
      budgetMs: 200_000,
      effectiveCeilingMicros: 250_000,
    });

    const { exitCode, stderr } = await run(ws, ["run", "bad-req"], inBoxHome(ws));

    expect(exitCode).toBe(2);
    expect(stderr).toContain("requestId");
    expect(fs.existsSync(ws.sentinel)).toBe(false);
    // The forged line is not a line: the message is sanitized on its way out.
    expect(events(stderr).map((e) => e.event)).not.toContain("forged");
  }, 60_000);

  test("a run id that is not a safe path component is refused before anything is read", async () => {
    const ws = workspace();
    writeManifest(ws, [sentinelPhase(ws, "plan"), tailPhase()]);
    writeWitness(ws, { runId: "x", budgetMs: 200_000, effectiveCeilingMicros: 250_000 });

    // The id becomes `$HOME/<runId>.journal.jsonl` and a systemd instance name.
    for (const bad of ["../escape", "a/b", ".."]) {
      const { exitCode, stderr } = await run(ws, ["run", bad], inBoxHome(ws));
      expect(exitCode).toBe(2);
      expect(stderr).toContain("not a safe path component");
    }
    expect(fs.existsSync(ws.sentinel)).toBe(false);
  }, 60_000);

  test("`run` takes exactly one argument", async () => {
    const ws = workspace();
    writeManifest(ws, [sentinelPhase(ws, "plan"), tailPhase()]);
    const { exitCode, stderr } = await run(ws, ["run"], inBoxHome(ws));
    expect(exitCode).toBe(2);
    expect(stderr).toContain("qds-engine run <run-id>");
  }, 60_000);
});

// ───────────────────────────────────────────────────────────────────────────
// The engine log + the Observability Contract's event set
// ───────────────────────────────────────────────────────────────────────────

describe("engine log redirect and the observability event set", () => {
  test("--engine-log persists the full event set with runId, requestId and phaseId", async () => {
    const ws = workspace();
    writeManifest(ws, [sentinelPhase(ws, "plan"), sentinelPhase(ws, "build")]);

    const { exitCode, stderr } = await run(ws, [
      ...baseArgs(ws, "logged-run"),
      "--request-id", "req-logged",
      "--engine-log", ws.engineLog,
    ]);
    expect(exitCode).toBe(0);

    // The file is the harvest path (AC4): journald does not ride the tar.
    const logged = events(fs.readFileSync(ws.engineLog, "utf8"));
    expect(logged.map((e) => e.event)).toContain("engine_started");
    expect(logged.map((e) => e.event)).toContain("engine_settled");
    // Every phase is observable individually, bare runs included — `phase_state`
    // is DF1.8's correlated-only TRACE row and is not a substitute.
    expect(logged.filter((e) => e.event === "phase_started")).toHaveLength(2);
    expect(logged.filter((e) => e.event === "phase_settled")).toHaveLength(2);

    for (const e of logged) {
      expect(e.runId).toBe("logged-run");
      expect(e.requestId).toBe("req-logged");
      // Present on every line, and its VALUE is the contract — `"phaseId" in e`
      // alone accepted `""`, `0` and the string "undefined". A phase-scoped
      // event names its phase; a run-scoped one is honestly null, never absent.
      if (e.event === "phase_started" || e.event === "phase_settled") {
        expect(typeof e.phaseId).toBe("string");
        expect(e.phaseId).not.toBe("");
      } else {
        expect(e.phaseId).toBeNull();
      }
    }
    for (const e of logged.filter((x) => x.event === "phase_started" || x.event === "phase_settled")) {
      // `toContain`, not a boolean collapse: `expect(a || b).toBe(true)` fails
      // as "expected false to be true" with the offending value invisible.
      expect(["plan", "build"]).toContain(e.phase as string);
    }
    const settled = logged.find((e) => e.event === "engine_settled");
    expect(settled?.ok).toBe(true);
    expect(settled?.exitCode).toBe(0);
    // Sub-timings: whole ms, and a path never evaluated reports 0.
    expect(Number.isInteger(logged.find((e) => e.event === "engine_started")?.engine_start_ms)).toBe(true);
    expect(Number.isInteger(settled?.phase_walk_ms)).toBe(true);

    // Teed, not swallowed: `journalctl` stays the operator's first reflex.
    expect(eventNames(stderr)).toContain("engine_settled");
  }, 60_000);

  test("phase_settled carries the phase's verdict, including a failed one", async () => {
    const ws = workspace();
    writeManifest(ws, [
      sentinelPhase(ws, "plan"),
      // A binary that cannot be spawned: the body THROWS, so the row stays fail.
      sentinelPhase(ws, "build", { command: ["qds-no-such-executable-df1-10"] }),
    ]);

    const { exitCode } = await run(ws, [...baseArgs(ws, "red-run"), "--engine-log", ws.engineLog]);
    expect(exitCode).toBe(1);

    const logged = events(fs.readFileSync(ws.engineLog, "utf8"));
    const settledPhases = logged.filter((e) => e.event === "phase_settled");
    expect(settledPhases.map((e) => [e.phase, e.status])).toEqual([
      ["plan", "success"],
      ["build", "fail"],
    ]);
    expect(logged.find((e) => e.event === "engine_settled")?.ok).toBe(false);
  }, 60_000);

  test("no capped-key material reaches any field, even with the key in the engine's environment", async () => {
    const ws = workspace();
    // The probe phase OBSERVES its own environment rather than its cwd. The
    // default sentinel command prints `$(pwd)`, which is true whatever
    // `childEnv` does — so an assertion that the sentinel lacks the key held
    // even with `childEnv` deleted and every child handed the full
    // OPENROUTER_API_KEY. This writes the variable's value, or the literal
    // `<unset>` when it is absent, which makes the assertion a POSITIVE control
    // on INV-IBOX-4 instead of an absence that cannot fail.
    writeManifest(ws, [
      sentinelPhase(ws, "plan", {
        command: [
          "sh",
          "-c",
          `printf '%s\\n' "\${OPENROUTER_API_KEY-<unset>}" >> ${JSON.stringify(ws.sentinel)}`,
        ],
      }),
      tailPhase(),
    ]);
    const key = "sk-or-v1-0123456789abcdef0123456789abcdef0123456789abcdef0123456789ab";

    const { exitCode, stderr, stdout } = await run(
      ws,
      [...baseArgs(ws, "keyed-run"), "--engine-log", ws.engineLog],
      { OPENROUTER_API_KEY: key, ANTHROPIC_API_KEY: key },
    );

    expect(exitCode).toBe(0);
    // INV-IBOX-4: the engine log is harvested, so a key here leaves the box.
    const log = fs.readFileSync(ws.engineLog, "utf8");
    for (const text of [log, stderr, stdout, fs.readFileSync(ws.journal, "utf8")]) {
      expect(text).not.toContain(key);
      expect(text).not.toContain("sk-or-");
    }
    // `childEnv` is why: a code phase's child never inherits the key at all —
    // and the child SAW that, rather than never having looked.
    expect(fs.readFileSync(ws.sentinel, "utf8").trim()).toBe("<unset>");
  }, 60_000);

  test("an unopenable engine log warns and never fails the run — observability is a sidecar", async () => {
    const ws = workspace();
    writeManifest(ws, [sentinelPhase(ws, "plan"), tailPhase()]);
    // A directory where a file belongs: EISDIR on open.
    const asDir = path.join(ws.dir, "engine-log-dir");
    fs.mkdirSync(asDir, { recursive: true });

    const { exitCode, stderr } = await run(ws, [...baseArgs(ws, "bad-log"), "--engine-log", asDir]);

    // AC5's rule, inherited: a broken sink never downgrades a settled run.
    expect(exitCode).toBe(0);
    expect(stderr).toMatch(/engine log/i);
    expect(readJournal(ws.journal).ok).toBe(true);
  }, 60_000);
});
