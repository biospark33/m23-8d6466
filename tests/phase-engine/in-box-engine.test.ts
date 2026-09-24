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
  markerFile: (runId: string) => string;
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
    markerFile: (runId: string) => path.join(markerRoot, "qds-run", runId, "journal", "final.json"),
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
      // DF3.6a: the four resident bound operands — this suite's witnesses arm
      // residents, and the arm-scoped loadResidentBounds refuses an operand-less
      // manifest before startResident (AC2a fail-closed). At the default test
      // rates the 8,000 µ$ ceiling is structurally unreachable, so no bound ever
      // fires here and every leg's pre-bounds semantics is unchanged.
      residentSpendCeilingMicros: 8_000,
      capMicroUsd: 50_000_000,
      defaultKeyCapMicroUsd: 50_000_000,
      residentRssBytes: 536_870_912,
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
function writeMarker(ws: Workspace, body: Record<string, unknown>, atRunId?: string): string {
  // Per-run root (#217 F-D1): the planted marker goes where the run named
  // atRunId (default: the body's own runId) will look — the FOREIGN tests
  // plant a stranger-stamped marker on the INVOKED run's root, the only
  // shape that can still reach the engine now that roots are per-run.
  const markerFile = ws.markerFile(atRunId ?? String(body.runId));
  fs.mkdirSync(path.dirname(markerFile), { recursive: true });
  const text = `${JSON.stringify(body)}\n`;
  fs.writeFileSync(markerFile, text);
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
    expect(fs.readFileSync(ws.markerFile("settled-run"), "utf8")).toBe(original);

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
    expect(error?.message).toContain(ws.markerFile("settled-run"));
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
    expect(JSON.parse(fs.readFileSync(ws.markerFile("fresh-run"), "utf8")).ok).toBe(true);
    // Paired positive: a negative event assert only means something on a
    // channel that carried events at all — an engine that crashed before
    // emitting any would make the negative below pass vacuously.
    expect(eventNames(stderr)).toContain("engine_settled");
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
    // #217 F-D1: roots are PER-RUN, so scratch-2 can no longer land on
    // scratch-1's marker by construction. The reachable residual is a foreign
    // STAMP on scratch-2's own root — a shared QDS_RUN_ROOT base, a hand-copied
    // marker, anything that writes a stranger's verdict into this run's tree —
    // and the body check still refuses it (defence in depth, per the guard's
    // docblock).
    writeMarker(ws, { runId: "scratch-1", ok: true, completedAt: "2026-09-01T00:00:00.000Z" }, "scratch-2");

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
    writeMarker(ws, { runId: "scratch-1", ok: false, completedAt: "2026-09-01T00:00:00.000Z" }, "scratch-2");

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
      fs.mkdirSync(path.dirname(ws.markerFile("x")), { recursive: true });
      fs.writeFileSync(ws.markerFile("x"), body);

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
    fs.mkdirSync(path.dirname(ws.markerFile("symlinked")), { recursive: true });
    // A symlink to a marker of someone else's choosing: `lstat` sees the link
    // (so "nothing is there" is already false) and a plain read would FOLLOW it
    // and mirror the `ok:true` at the other end — turning the fail-closed
    // refusal into an exit 0 for a run that never walked.
    const planted = path.join(ws.dir, "planted.json");
    fs.writeFileSync(planted, JSON.stringify({ runId: "symlinked", ok: true }));
    fs.symlinkSync(planted, ws.markerFile("symlinked"));

    const { exitCode, stderr } = await run(ws, baseArgs(ws, "symlinked"));

    expect(exitCode).toBe(2);
    expect(fs.existsSync(ws.sentinel)).toBe(false);
    // The refusal precedes `new FileJournal`, so not even a header row exists.
    expect(fs.existsSync(ws.journal)).toBe(false);
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
    fs.rmSync(ws.markerFile("rebooted"));

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
    // constructor flush and nothing else. Produced by the REAL constructor
    // rather than hand-written JSON, so the fixture cannot drift from what
    // the writer actually leaves (key set, ordering, pretty-printing) — this
    // test's whole premise is "the bytes a killed engine leaves do not
    // refuse". Refusing on THAT would strand every run whose engine died
    // between the journal open and phase 1, and re-walking it re-spends
    // nothing, because nothing was spent.
    new FileJournal(ws.journal, "header-only");

    const { exitCode, stderr } = await run(ws, baseArgs(ws, "header-only"));

    expect(exitCode).toBe(0);
    expect(fs.readFileSync(ws.sentinel, "utf8").trim().split("\n")).toHaveLength(2);
    expect(eventNames(stderr)).toContain("engine_settled");
    expect(eventNames(stderr)).not.toContain("engine_refused_replay");
  }, 60_000);

  // Round-5 re-pin (behavior change): `journalReclaimRefusal` is now
  // FAIL-CLOSED. A present, non-empty journal the guard cannot read as the
  // single JSON document every flush writes whole REFUSES with
  // ENGINE_JOURNAL_UNUSABLE — the old arm proceeded on unparseable bytes and
  // handed `new FileJournal` a truncating flush over the only copy.
  const garbage: [string, string][] = [
    ["an unparseable journal", "this is not json and never was\n"],
    // Over the guard's 1 MiB read ceiling: never a truncated read that could
    // parse as something it is not — straight to the unparseable arm.
    ["an over-cap journal", `${"x".repeat(1024 * 1024 + 1)}\n`],
  ];
  for (const [label, body] of garbage) {
    test(`${label} refuses fail-closed (ENGINE_JOURNAL_UNUSABLE) — never a truncating proceed`, async () => {
      const ws = workspace();
      writeManifest(ws, [sentinelPhase(ws, "plan"), tailPhase()]);
      fs.writeFileSync(ws.journal, body);

      const { exitCode, stderr } = await run(ws, baseArgs(ws, "garbage"));

      expect(exitCode).toBe(2);
      expect(fs.existsSync(ws.sentinel)).toBe(false);
      const refusal = events(stderr).find((e) => e.event === "engine_refused_replay");
      expect((refusal?.error as { code?: string })?.code).toBe("ENGINE_JOURNAL_UNUSABLE");
      // The bytes survive: refusing is only better than proceeding if the
      // evidence the operator reads next was not destroyed on the way out.
      expect(fs.readFileSync(ws.journal, "utf8")).toBe(body);
    }, 60_000);
  }

  test("a journal stamped for ANOTHER run refuses — a dirty --journal path, not a crash", async () => {
    const ws = workspace();
    writeManifest(ws, [sentinelPhase(ws, "plan"), tailPhase()]);
    // Real `FileJournal` rows under a foreign runId, so the fixture cannot
    // drift from what a flush actually writes. The ORPHANED remediation
    // ("read the journal for what settled") would point this operator at a
    // spend that was never theirs, so the diagnosis is its own code.
    const foreign = new FileJournal(ws.journal, "someone-else");
    foreign.writePhase({
      runId: "someone-else",
      requestId: "req-foreign",
      pipelineId: "in-box-demo",
      phaseId: "p1",
      name: "plan",
      kind: "code",
      status: "fail",
      startedAt: "2026-09-01T00:00:00.000Z",
      updatedAt: "2026-09-01T00:00:01.000Z",
    });
    const before = fs.readFileSync(ws.journal, "utf8");

    const { exitCode, stderr } = await run(ws, baseArgs(ws, "mine"));

    expect(exitCode).toBe(2);
    expect(fs.existsSync(ws.sentinel)).toBe(false);
    const refusal = events(stderr).find((e) => e.event === "engine_refused_replay");
    expect((refusal?.error as { code?: string })?.code).toBe("ENGINE_JOURNAL_FOREIGN");
    expect((refusal?.error as { message?: string })?.message).toContain("someone-else");
    // The foreign rows survive the refusal byte-for-byte — the constructor's
    // truncating flush is exactly what this guard exists to keep away from them.
    expect(fs.readFileSync(ws.journal, "utf8")).toBe(before);
  }, 60_000);

  // ANY-uid shape (round-5 #1): the marker's PARENT is a regular file, so
  // `lstat` of the marker answers ENOTDIR — the same non-ENOENT stat-failure
  // catch arm the old 0o000-directory shape exercised via EACCES, but one no
  // CI lane can bypass (root ignores mode bits, not directory entries), so
  // the arm keeps its coverage where root CI runs it too.
  test("a marker the engine cannot even stat refuses too — fail-closed, never a re-walk", async () => {
    const ws = workspace();
    writeManifest(ws, [sentinelPhase(ws, "plan"), sentinelPhase(ws, "build")]);
    fs.mkdirSync(path.dirname(path.dirname(ws.markerFile("unstattable"))), { recursive: true });
    fs.writeFileSync(
      path.dirname(ws.markerFile("unstattable")),
      "a regular file where the journal directory belongs",
    );

    const { exitCode, stderr } = await run(ws, baseArgs(ws, "unstattable"));

    expect(exitCode).toBe(2);
    expect(fs.existsSync(ws.sentinel)).toBe(false);
    expect(fs.existsSync(ws.journal)).toBe(false);
    const refusal = events(stderr).find((e) => e.event === "engine_refused_replay");
    expect(refusal).toBeDefined();
    // A different code from a present marker: the operator is being told
    // "I could not prove this run is unstarted", not "it already ran".
    expect((refusal?.error as { code?: string })?.code).toBe("ENGINE_MARKER_UNREADABLE");
    expect((refusal?.error as { message?: string })?.message).toContain("could not be examined (ENOTDIR)");
  }, 60_000);

  // Same skipIf(root) rule as its ENOTDIR sibling above — root ignores the mode
  // bits, so the "locked" file is readable and the arm never fires.
  //
  // GENUINELY IMPOSSIBLE to make any-uid (round-5 #1, feasibility verdict):
  // this arm needs an OPEN fault on a file `lstat` already proved regular, and
  // the only portable producer of that is a mode bit — which root ignores.
  // The other any-uid errno shapes all route ELSEWHERE: ENOTDIR/EACCES on the
  // stat → the sibling above's arm, a symlink/FIFO/directory at the path → the
  // not-a-regular-file arm. CI LAN REQUIREMENT: a root lane must also run this
  // suite as a non-root user, or this arm ships uncovered there.
  test.skipIf(process.getuid?.() === 0)(
    "a marker the engine can stat but not READ is a permissions fault, never a content fault",
    async () => {
      const ws = workspace();
      writeManifest(ws, [sentinelPhase(ws, "plan"), tailPhase()]);
      // The FILE unreadable, the directory fine: `lstat` succeeds and says
      // regular file, and it is the OPEN that fails EACCES. Pinned as its own
      // arm because a read fault used to collapse into the parse-fault
      // diagnosis ("not one line of JSON"), sending the operator digging
      // through the file's bytes for what is wrong with its mode bits.
      writeMarker(ws, { runId: "locked", ok: true, completedAt: "2026-09-01T00:00:00.000Z" });
      fs.chmodSync(ws.markerFile("locked"), 0o000);
      try {
        const { exitCode, stderr } = await run(ws, baseArgs(ws, "locked"));

        expect(exitCode).toBe(2);
        expect(fs.existsSync(ws.sentinel)).toBe(false);
        const refusal = events(stderr).find((e) => e.event === "engine_refused_replay");
        expect((refusal?.error as { code?: string })?.code).toBe("ENGINE_MARKER_UNREADABLE");
        const message = (refusal?.error as { message?: string })?.message ?? "";
        // The DIAGNOSIS is the discriminator: the read fault names the open,
        // and is never phrased as the content fault — while the truncated and
        // zero-byte rows above pin that side as ENGINE_MARKER_UNUSABLE, so a
        // regression swapping the two arms fails one of the two rows.
        expect(message).toContain("could not open or read");
        expect(message).not.toContain("one line of JSON");
      } finally {
        fs.chmodSync(ws.markerFile("locked"), 0o600);
      }
    },
    60_000,
  );

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
    // Journal-absence pin: this guard runs before `new FileJournal` on the flag
    // path too, so the refusal must not have left even a header row behind.
    expect(fs.existsSync(ws.journal)).toBe(false);
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

  test("an invocation naming BOTH ids claims no marker through the one it did not settle under", async () => {
    const ws = workspace();
    writeManifest(ws, [sentinelPhase(ws, "plan"), sentinelPhase(ws, "build")]);
    // The dual-identity mirror this refusal closes: run Y passes
    // `--request-id X` beside its own `--run-id`, and a marker naming X (X
    // settled ok) used to mirror X's verdict onto a Y that never walked — a
    // dispatcher polling on Y read a success that belonged to X. The
    // requestId counts as identity only when the invocation named no --run-id
    // of its own (the correlated shape above); with both doors' ids present,
    // X's marker is a stranger's.
    writeMarker(ws, { runId: "req-x", ok: true, completedAt: "2026-09-01T00:00:00.000Z" }, "y-run");

    const { exitCode, stderr } = await run(ws, [...baseArgs(ws, "y-run"), "--request-id", "req-x"]);

    expect(exitCode).toBe(2);
    expect(fs.existsSync(ws.sentinel)).toBe(false);
    expect(fs.existsSync(ws.journal)).toBe(false);
    const refusal = events(stderr).find((e) => e.event === "engine_refused_replay");
    expect((refusal?.error as { code?: string })?.code).toBe("ENGINE_MARKER_FOREIGN");
    expect(refusal?.markerRunId).toBe("req-x");
    expect(refusal?.runId).toBe("y-run");
    expect(eventNames(stderr)).not.toContain("engine_started");
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
// #217 F-D1 (TS half) — the concurrent-engine root claim
// ───────────────────────────────────────────────────────────────────────────

describe("#217 F-D1 — one engine per run root at a time (concurrent-claim guard)", () => {
  /** The claim file `acquireEngineClaim` creates — one per ROOT, like the marker. */
  const claimFile = (ws: Workspace, runId: string): string => path.join(ws.markerRoot, "qds-run", runId, "journal", "engine.claim");

  /** A sentinel phase that HOLDS the claim ~2 s: the loser (spawned at the same
   *  instant, same binary, same startup cost) reaches the claim while it is
   *  still held rather than after the winner already settled. */
  function holdingPhase(ws: Workspace): PhaseSpec {
    return {
      name: "hold",
      kind: "code",
      description: "Touch the sentinel slowly, so a concurrent engine hits the claim",
      maxDurationMs: 15_000,
      retries: 0,
      command: ["sh", "-c", `sleep 2; printf '%s\\n' "$(pwd)" >> ${JSON.stringify(ws.sentinel)}`],
    };
  }

  test("two engines on one root: exactly one refuses before any journal exists; exactly one phase body runs; the claim is gone when both exit", async () => {
    const ws = workspace();
    writeManifest(ws, [holdingPhase(ws), tailPhase()]);
    const journalB = path.join(ws.dir, "journal-b.jsonl");

    // BOTH spawned before either is awaited: this is the check-then-act window
    // the claim exists for. Since #217 F-D1 the root is PER-RUN, so the race
    // the claim closes is the SAME runId started twice — the retry shape (a
    // re-dispatch, an operator doubling a hand-built argv). B uses its own
    // journal; both carry "claim-race", so both derive the same root.
    const runEngine = (args: string[]): Promise<{ exitCode: number; stderr: string }> => {
      const proc = spawnEngine(ws, args);
      return Promise.all([proc.exited, new Response(proc.stderr).text()]).then(
        ([exitCode, stderr]) => ({ exitCode, stderr }),
      );
    };
    const bArgs = baseArgs(ws, "claim-race").map((arg, i, all) =>
      arg === ws.journal && all[i - 1] === "--journal" ? journalB : arg,
    );
    const [a, b] = await Promise.all([runEngine(baseArgs(ws, "claim-race")), runEngine(bArgs)]);

    // Classified off PARSED refusal events, not a bare substring: remediation
    // texts NAME these codes too (the stale-claim one spells ENGINE_RUN_
    // CLAIMED), so an includes() can misread a settling engine's stderr.
    const refusalOf = (r: { stderr: string }) =>
      events(r.stderr)
        .map((e) => ({ event: e.event, code: (e.error as { code?: string } | undefined)?.code }))
        .find((e) => e.event === "engine_refused_claim" || e.event === "engine_refused_replay");
    const aRefusal = refusalOf(a);
    const bRefusal = refusalOf(b);

    // TWO valid loser shapes, and both are the guard working. Which one fires
    // depends on whether the loser's bun boot beat the winner's `sleep 2` — a
    // machine-load fact this test must not be flaky on:
    //  - ENGINE_RUN_CLAIMED: the loser's O_EXCL create hit a held claim — the
    //    primary, guard-ordering half. Exit 2.
    //  - MIRROR: the loser booted so slowly the winner had already settled;
    //    the marker names "claim-race" — the loser's OWN id under a per-run
    //    root (#217 F-D1) — so the replay guard mirrors it: exit 0, no phase
    //    re-walked, `engine_refused_replay` the tell. Idempotence, the
    //    designed answer to a double dispatch.
    // Both engines walked + both refusal-free is the one genuinely broken
    // shape, and it fails the sentinel-count assert below.
    const refusal = aRefusal ?? bRefusal;
    expect(["ENGINE_RUN_CLAIMED", "MIRROR"]).toContain(refusal?.code ?? "MIRROR");

    const loser = aRefusal !== undefined ? a : b;
    const winner = aRefusal !== undefined ? b : a;
    expect([a.exitCode, b.exitCode].sort()).toEqual([0, refusal?.code === "ENGINE_RUN_CLAIMED" ? 2 : 0]);
    if (refusal?.code === "ENGINE_RUN_CLAIMED") {
      // The refusal names the claim path, and is level error (exit 2), same
      // rule as a non-mirror replay.
      const refusalEvent = events(loser.stderr).find((e) => e.event === "engine_refused_claim");
      expect(refusalEvent?.error).toMatchObject({ code: "ENGINE_RUN_CLAIMED" });
      expect(refusalEvent?.claimPath).toBe(claimFile(ws, "claim-race"));
      expect(refusalEvent?.level).toBe("error");
    }

    // The loser never constructed a FileJournal — its journal file was never
    // created (the ordering requirement; a MIRROR also precedes the journal).
    const winnerJournal = winner === a ? ws.journal : journalB;
    const loserJournal = winner === a ? journalB : ws.journal;
    expect(fs.existsSync(loserJournal)).toBe(false);
    // The winner walked: exit 0 (both phases green), and EXACTLY ONE phase
    // body ran on the root — the sentinel holds one line, not two. This is
    // the double-spend assert: whatever shape the loser took, it did not walk.
    expect(winner.exitCode).toBe(0);
    expect(fs.readFileSync(ws.sentinel, "utf8").trim().split("\n")).toHaveLength(1);
    expect(fs.existsSync(winnerJournal)).toBe(true);

    // Claim cleaned on the success exit: nothing lingers to refuse run C.
    expect(fs.existsSync(claimFile(ws, "claim-race"))).toBe(false);
  }, 60_000);

  test("claim cleanup on a FAILURE exit: a not-ok settle still releases the root", async () => {
    const ws = workspace();
    writeManifest(ws, [
      // A body that THROWS (ENOENT on an impossible absolute path — the
      // red-run idiom) is what fails a code phase: a bare command's nonzero
      // exit is the gate's input, not the verdict, and this phase declares no
      // testCommand.
      sentinelPhase(ws, "doom", { command: ["/qds-no-such-directory-df1-10/spawn-enoent-df1-10"] }),
      tailPhase(),
    ]);
    const { exitCode } = await run(ws, baseArgs(ws, "claim-fail"));
    expect(exitCode).toBe(1);
    // The marker proves the run settled not-ok; the claim must NOT outlive it.
    expect(fs.existsSync(ws.markerFile("claim-fail"))).toBe(true);
    expect(fs.existsSync(claimFile(ws, "claim-fail"))).toBe(false);
  }, 60_000);

  test("the terminal marker is committed BEFORE the root claim is released (sidecar poller)", async () => {
    const ws = workspace();
    writeManifest(ws, [sentinelPhase(ws, "plan"), tailPhase()]);

    // A poller in THIS process samples both files every ~2 ms for the whole
    // run. The ordering rule under test: once the claim has been OBSERVED
    // held, it is never observed gone while the marker is still absent — the
    // claim is the concurrency lock, the marker is the verdict, and any window
    // where the lock is free but the verdict unwritten is exactly where a
    // second engine starts walking (and double-spending). The marker, once
    // present, stays present, so only the bug shape can trip the violation.
    let claimSeen = false;
    let violation: string | null = null;
    let stop = false;
    const poller = (async () => {
      while (!stop) {
        if (fs.existsSync(claimFile(ws, "ordering"))) claimSeen = true;
        else if (claimSeen && !fs.existsSync(ws.markerFile("ordering"))) {
          violation = "claim observed released while the marker was still absent";
          stop = true;
        }
        await Bun.sleep(2);
      }
    })();

    const { exitCode } = await run(ws, baseArgs(ws, "ordering"));
    stop = true;
    await poller;

    expect(exitCode).toBe(0);
    expect(violation).toBeNull();
    // The poller really watched the held claim — a poller that sampled nothing
    // would make the ordering assert above vacuous.
    expect(claimSeen).toBe(true);
    expect(fs.existsSync(ws.markerFile("ordering"))).toBe(true);
    expect(fs.existsSync(claimFile(ws, "ordering"))).toBe(false);
  }, 60_000);

  test("a stale claim (SIGKILLed engine) refuses loudly, names the holder and the removal remediation", async () => {
    const ws = workspace();
    writeManifest(ws, [sentinelPhase(ws, "plan"), sentinelPhase(ws, "build")]);
    // The claim a SIGKILLed engine leaves behind — no finally ran.
    fs.mkdirSync(path.dirname(claimFile(ws, "after-kill")), { recursive: true });
    fs.writeFileSync(
      claimFile(ws, "after-kill"),
      `${JSON.stringify({ runId: "killed-run", pid: 999999, startedAt: "2026-09-05T00:00:00.000Z" })}\n`,
    );

    const { exitCode, stderr } = await run(ws, baseArgs(ws, "after-kill"));

    expect(exitCode).toBe(2);
    const refusalEvent = events(stderr).find((e) => e.event === "engine_refused_claim");
    expect(refusalEvent?.error).toMatchObject({ code: "ENGINE_RUN_CLAIMED" });
    // The holder line makes "who holds it" legible from the log alone.
    expect(refusalEvent?.holder).toMatchObject({ runId: "killed-run" });
    expect(String((refusalEvent?.error as { remediation?: string } | undefined)?.remediation ?? "")).toContain(claimFile(ws, "after-kill"));
    // No phase ran, no journal row was written, and the marker is still absent.
    expect(fs.existsSync(ws.sentinel)).toBe(false);
    expect(fs.existsSync(ws.journal)).toBe(false);
    expect(fs.existsSync(ws.markerFile("after-kill"))).toBe(false);
    // The refusal did not consume the claim it found: it is not the holder.
    expect(fs.existsSync(claimFile(ws, "after-kill"))).toBe(true);
  }, 60_000);

  // skipIf(root), same rule as the marker-read sibling above: root ignores the
  // mode bits, so the "unwritable" directory is writable and the EACCES arm
  // this pins never fires where root CI runs it.
  //
  // GENUINELY IMPOSSIBLE to make any-uid (round-5 #1, feasibility verdict):
  // ENGINE_CLAIM_UNWRITABLE needs a create/write errno on the claim open
  // (EACCES, ENOSPC, EIO) — root bypasses the first, the others need failing
  // hardware, and every any-uid "something already at the claim path" shape
  // answers EEXIST, which routes to the ENGINE_RUN_CLAIMED arm below instead.
  // CI LAN REQUIREMENT: a root lane must also run this suite as a non-root
  // user, or this arm ships uncovered there.
  test.skipIf(process.getuid?.() === 0)(
    "an unwritable claim directory refuses fail-closed BEFORE the walk (ENGINE_CLAIM_UNWRITABLE)",
    async () => {
      const ws = workspace();
      writeManifest(ws, [sentinelPhase(ws, "plan"), sentinelPhase(ws, "build")]);
      // Pre-create the journal dir read-only: mkdirSync succeeds (it exists),
      // the O_EXCL create inside fails EACCES. A root that cannot carry the
      // claim cannot carry the terminal marker either — refuse before paying.
      fs.mkdirSync(path.dirname(claimFile(ws, "no-write")), { recursive: true });
      fs.chmodSync(path.dirname(claimFile(ws, "no-write")), 0o500);
      try {
        const { exitCode, stderr } = await run(ws, baseArgs(ws, "no-write"));
        expect(exitCode).toBe(2);
        const refusalEvent = events(stderr).find((e) => e.event === "engine_refused_claim");
        expect(refusalEvent?.error).toMatchObject({ code: "ENGINE_CLAIM_UNWRITABLE" });
        expect(fs.existsSync(ws.sentinel)).toBe(false);
        expect(fs.existsSync(ws.journal)).toBe(false);
      } finally {
        fs.chmodSync(path.dirname(claimFile(ws, "no-write")), 0o700);
      }
    },
    60_000,
  );
});

// ───────────────────────────────────────────────────────────────────────────
// C19 — the executing kind set
// ───────────────────────────────────────────────────────────────────────────

describe("C19 — PhaseKind is exactly the kinds the closed schema admits", () => {
  test("the closed kind set is exactly `code`, `dispatch_task` and `rig_swarm` (the type half is `bunx tsc`'s to fail, not this runner's)", () => {
    // Compile-time, not runtime: this file stops TYPECHECKING the day a new
    // member is added to `PhaseKind` without a decision about its executor.
    // `bun test` transpiles without typechecking, so this runner cannot fail
    // on the assignment below — the gate for that half is the `bunx tsc` /
    // typecheck job in CI, and this test's job is to keep the file honest for
    // that job while pinning the SET at runtime below. S1 note: `rig_swarm`
    // is that decision — schema-side here (Task 1), executor in
    // makeBodyFactory (Task 4), which also resolved the never-residue.
    const executing = ["code", "dispatch_task", "rig_swarm"] as const;
    type Executing = (typeof executing)[number];
    // The annotation IS the check, for tsc. Deliberately no runtime `expect`
    // on it: the value would be the literal `true` and could never fail.
    const widened: Executing extends PhaseKind ? (PhaseKind extends Executing ? true : never) : never = true;
    void widened;
    // The runtime half this runner CAN fail, read off the SCHEMA's refusal
    // message rather than off the literal above (comparing the literal to
    // itself proves only that `toEqual` works). The refusal message enumerates
    // the closed set straight from `EXECUTING_KINDS`, which makes it
    // observable at runtime.
    const refused = PhaseSpecSchema.safeParse({ name: "x", kind: "not-a-kind", description: "d" });
    expect(refused.success).toBe(false);
    // The kinds are extracted from the clause tolerant of BOTH quoted and
    // unquoted enumerations (round-5 #5): split on the `|` separator, then
    // strip any quotes — so a zod message reword that drops the quoting (or
    // changes the join spacing) keeps this green while a changed SET still
    // fails it. The clause's position among the issues is likewise a cosmetic
    // (`[^;]*` stops at the issue separator). No trailing `;` in the pattern:
    // the kind list is not guaranteed to be the message's last issue.
    const clause = refused.success
      ? ""
      : (refused.error.issues.map((i) => i.message).join("; ").match(/kind must be one of ([^;]*)/)?.[1] ?? "");
    const listed = clause
      .split("|")
      .map((token) => token.replace(/['"]/g, "").trim())
      .filter((token) => token.length > 0)
      .sort();
    expect(listed).toEqual([...executing].sort());
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
    expect(fs.existsSync(ws.markerFile("removed-kind"))).toBe(false);
  }, 60_000);

  test("an `engineer` phase carrying a dispatch_task field still names its remediation", () => {
    // zod runs `.superRefine` (where the roster/task field rules live) only
    // after the base object parse SUCCEEDS, so a failed `kind` enum never
    // reaches them — there is no shadowing to exercise on this input. What the
    // case actually pins: the enum's own message names the "write instead"
    // remediation with the inert extra keys PRESENT, which is the shape an
    // operator porting an old manifest arrives with (roster/task and a removed
    // kind, both wrong at once).
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

    // HAZARD: the one place this suite mutates process.env mid-run —
    // `runMarkerPath()` below reads it, and `bun test` runs every file in one
    // process (sequentially today). The save/restore dance below keeps sibling
    // FILES safe, but any future concurrent/parallel test execution would need
    // this behind an env-parametrised seam instead; do not add a second
    // mutation site.
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
      expect(JSON.parse(fs.readFileSync(runMarkerPath("synthetic-throw"), "utf8")).ok).toBe(false);
    } finally {
      // biome-ignore lint/performance/noDelete: an assignment would set the string "undefined".
      if (savedMarkerRoot === undefined) delete process.env.QDS_RUN_ROOT;
      else process.env.QDS_RUN_ROOT = savedMarkerRoot;
    }
    // Env-mutation canary (round-5 #6): the restore above is load-bearing for
    // every sibling file in this one process — assert it actually took, or a
    // future edit that moves/loses it strands QDS_RUN_ROOT silently.
    expect(process.env.QDS_RUN_ROOT).toBe(savedMarkerRoot);
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
    // The two DISCRIMINATING numbers, pinned separately (round-5 #7): a
    // connector reword ("but" → anything) must not fail this row, while a
    // mismatch either side still does.
    expect(stderr).toContain("manifest declares limitMicroUsd 250000");
    expect(stderr).toContain("dispatch admitted 500000");
    expect(fs.existsSync(ws.sentinel)).toBe(false);
  }, 60_000);

  test("`--run-root` moves nothing onto the marker root — the two levers stay independent", async () => {
    const ws = workspace();
    writeManifest(ws, [sentinelPhase(ws, "plan"), tailPhase()]);

    expect(await run(ws, baseArgs(ws, "levers"))).toMatchObject({ exitCode: 0 });

    // INV-IBOX-9 / the frozen contract: the marker is `runMarkerRoot()`'s, and
    // in the box (QDS_RUN_ROOT unset) that is `/run/qds-run/<runId>/journal/final.json`. A
    // `--run-root` that could relocate it would move DF3.2's poll key.
    expect(fs.existsSync(ws.markerFile("levers"))).toBe(true);
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

  /** `$HOME` plus a nowhere `QDS_PI_CATALOG_DIR`. The `run` front door cannot
   *  pass `--no-resident` (its only argument is the run id) and a witness
   *  carrying a requestId ARMS the resident — so on any host that can resolve
   *  the slug (ambient catalog dir, or pi installed in a checkout layout) a
   *  front-door test would spawn a real pi with key passthrough inside a plain
   *  `bun test`. A set-but-missing catalog override makes
   *  `findBundledCatalogDir` return null with NO fallback to the PATH search,
   *  forcing the RateError → `resident_disabled` path deterministically
   *  (round-3 A19) while leaving the requestId-propagation asserts intact. */
  function inBoxHomeDeterministic(ws: Workspace): Record<string, string> {
    return { ...inBoxHome(ws), QDS_PI_CATALOG_DIR: path.join(ws.dir, "no-such-pi-catalog-df1-10") };
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

    const { exitCode, stderr } = await run(ws, ["run", "qds-20260903-abc123"], inBoxHomeDeterministic(ws));

    expect(exitCode).toBe(0);
    // Journal and engine log land on ext4 `$HOME`, runId-prefixed (INV-IBOX-8;
    // the names are the harvest tar's `-C "$HOME" <name>` pairs).
    expect(fs.existsSync(path.join(ws.dir, "qds-20260903-abc123.journal.jsonl"))).toBe(true);
    expect(fs.existsSync(path.join(ws.dir, "qds-20260903-abc123.engine.log"))).toBe(true);
    // The marker stays on the marker root, untouched by the derivation.
    expect(JSON.parse(fs.readFileSync(ws.markerFile("qds-20260903-abc123"), "utf8")).ok).toBe(true);
    // Run-root resolved to the checkout, so the code phase ran there.
    expect(fs.readFileSync(ws.sentinel, "utf8").trim()).toBe(fs.realpathSync(ws.runRoot));
    // requestId propagated from the witness onto every event, not regenerated.
    const logged = events(fs.readFileSync(path.join(ws.dir, "qds-20260903-abc123.engine.log"), "utf8"));
    expect(logged.length).toBeGreaterThan(0);
    for (const e of logged) expect(e.requestId).toBe("req-derived");
    expect(eventNames(stderr)).toContain("engine_started");
  }, 60_000);

  test("a settled run whose own phases deleted the witness still mirrors (round-3 A1)", async () => {
    const ws = workspace();
    writeManifest(ws, [sentinelPhase(ws, "plan"), tailPhase()]);
    writeWitness(ws, {
      runId: "qds-20260903-mirror",
      requestId: "req-mirror",
      budgetMs: 200_000,
      effectiveCeilingMicros: 250_000,
    });

    // Run 1 settles for real, through the front door like the unit does.
    expect(await run(ws, ["run", "qds-20260903-mirror"], inBoxHomeDeterministic(ws)))
      .toMatchObject({ exitCode: 0 });

    // The run's code phases share the checkout root with the manifest pair,
    // so nothing stops one from `git clean -fdx`-ing `.qds/` away — simulate
    // exactly that: the settled run deleted its own invocation evidence.
    fs.rmSync(path.join(ws.qds, "run-context.json"));

    const { exitCode, stderr } = await run(ws, ["run", "qds-20260903-mirror"], inBoxHomeDeterministic(ws));

    // The guard runs BEFORE the witness read (front door) and before the
    // manifest read (flag path), because both live in the tree the run's own
    // phases may rewrite while the marker on the run-marker root does not. The
    // retry MIRRORS — exit 0 plus the event — instead of dying in the witness
    // read as an exit-2 "could not settle" over work that already settled.
    expect(exitCode).toBe(0);
    expect(eventNames(stderr)).toContain("engine_refused_replay");
    const refusal = events(stderr).find((e) => e.event === "engine_refused_replay");
    expect((refusal?.error as { code?: string })?.code).toBe("ENGINE_MARKER_PRESENT");
    expect(refusal?.runId).toBe("qds-20260903-mirror");
    // No phase re-ran: the sentinel still carries run 1's single line.
    expect(fs.readFileSync(ws.sentinel, "utf8").trim().split("\n")).toHaveLength(1);
    // AC4: the front-door refusal is in the harvested engine log, not only in
    // journald — the log this test's shape is the only evidence channel for.
    expect(eventNames(fs.readFileSync(path.join(ws.dir, "qds-20260903-mirror.engine.log"), "utf8")))
      .toContain("engine_refused_replay");
  }, 60_000);

  test("a witness with no budgetMs refuses rather than defaulting a ceiling", async () => {
    const ws = workspace();
    writeManifest(ws, [sentinelPhase(ws, "plan"), tailPhase()]);
    // requestId-carrying witness + front door = the resident-arming shape, so
    // this runs on the deterministic home (nowhere QDS_PI_CATALOG_DIR), not
    // plain inBoxHome: it passes today only because budgetMs validation
    // precedes the resident, and a refusal test must not depend on that
    // ordering to stay offline.
    writeWitness(ws, { runId: "no-budget", requestId: "req-x", effectiveCeilingMicros: 250_000 });

    const { exitCode, stderr } = await run(ws, ["run", "no-budget"], inBoxHomeDeterministic(ws));

    // AC5: the engine never assumes an upstream ceiling. The unit passes no
    // --budget-ms, so an unstamped witness has to be a refusal — a defaulted
    // ceiling is not a ceiling. Pinned to the refusal's own phrase, not a bare
    // "budgetMs" substring (the flag NAME appears in unrelated lines too).
    expect(exitCode).toBe(2);
    expect(stderr).toContain("carries no positive integer budgetMs");
    expect(fs.existsSync(ws.sentinel)).toBe(false);
    // AC4, and the reason the engine log opens in the `run` front door rather
    // than where `--engine-log` is parsed: EVERY derivation refusal happens
    // before the derived argv exists, so with the open deferred they landed in
    // journald only — and journald does not ride DF2.5's harvest tar. This is
    // the one invocation shape the unit ever uses, so that was every derivation
    // failure on the box invisible to the operator harvesting it.
    expect(fs.readFileSync(path.join(ws.dir, "no-budget.engine.log"), "utf8"))
      .toContain("carries no positive integer budgetMs");
  }, 60_000);

  test("an unusable HOME refuses before anything is derived or written (round-5 #4)", async () => {
    const ws = workspace();
    writeManifest(ws, [sentinelPhase(ws, "plan"), tailPhase()]);
    writeWitness(ws, { runId: "any", budgetMs: 200_000, effectiveCeilingMicros: 250_000 });

    // Spawned with cwd = the throwaway workspace, NOT REPO_ROOT: a relative
    // HOME makes the RUNTIME (bun) resolve its own caches against the cwd, and
    // this test must not litter the repo with the engine's innocence.
    const spawnAt = (homeEnv: Record<string, string>) =>
      Bun.spawn({
        cmd: [process.execPath, RUNNER, "run", "homeless"],
        cwd: ws.dir,
        env: { ...process.env, QDS_RUN_ROOT: ws.markerRoot, ...homeEnv },
        stdout: "pipe",
        stderr: "pipe",
      });

    // HOME deleted outright: the layout has no anchor at all.
    const noHomeEnv: Record<string, string | undefined> = { ...process.env, QDS_RUN_ROOT: ws.markerRoot };
    // biome-ignore lint/performance/noDelete: an assignment would set the string "undefined".
    delete noHomeEnv.HOME;
    const a = Bun.spawn({
      cmd: [process.execPath, RUNNER, "run", "homeless"],
      cwd: ws.dir,
      env: noHomeEnv as Record<string, string>,
      stdout: "pipe",
      stderr: "pipe",
    });
    const [aExit, aErr] = await Promise.all([a.exited, new Response(a.stderr).text()]);
    expect(aExit).toBe(2);
    expect(aErr).toContain("HOME is unset, so the in-box layout has no anchor");

    // HOME relative: every derived path would resolve against the engine's
    // cwd — the same invocation from two directories reads two trees.
    const b = spawnAt({ HOME: "df1-10-relative-home" });
    const [bExit, bErr] = await Promise.all([b.exited, new Response(b.stderr).text()]);
    expect(bExit).toBe(2);
    expect(bErr).toContain("HOME is not an absolute path");

    // Refused before any artefact: no marker on the run root (the engine's
    // file; bun's own cache litter under the relative HOME is not), no phase
    // body, and no derived journal at the workspace's top level — where
    // `<relative HOME>/homeless.journal.jsonl` would have landed had the
    // derivation ever run.
    expect(fs.existsSync(ws.markerFile("gone"))).toBe(false);
    expect(fs.existsSync(ws.sentinel)).toBe(false);
    expect(fs.readdirSync(ws.dir).some((f) => f.endsWith(".journal.jsonl"))).toBe(false);
  }, 60_000);

  test("negative witness budgetMs rows — 0, negative, and a numeric STRING — all refuse on the same phrase (round-5 #8)", async () => {
    for (const [label, budgetMs] of [["zero", 0], ["negative", -1], ["string", "200000"]] as const) {
      const ws = workspace();
      writeManifest(ws, [sentinelPhase(ws, "plan"), tailPhase()]);
      // No requestId in the witness, so plain inBoxHome: nothing arms a
      // resident and the refusal cannot depend on validation ordering.
      writeWitness(ws, { runId: label, budgetMs, effectiveCeilingMicros: 250_000 });

      const { exitCode, stderr } = await run(ws, ["run", label], inBoxHome(ws));

      // AC5, all three shapes: a defaulted ceiling is not a ceiling — and the
      // STRING is included because `Number.isSafeInteger` is a TYPE test, not
      // a coercion: "200000" is not admitted as a quiet 200000.
      expect(exitCode).toBe(2);
      expect(stderr).toContain("carries no positive integer budgetMs");
      expect(fs.existsSync(ws.sentinel)).toBe(false);
    }
  }, 60_000);

  test("a deleted manifest on a fresh marker-less front-door run refuses exit 2 (round-5 #8)", async () => {
    const ws = workspace();
    writeManifest(ws, [sentinelPhase(ws, "plan"), tailPhase()]);
    writeWitness(ws, { runId: "gone", budgetMs: 200_000, effectiveCeilingMicros: 250_000 });
    // The settled run's phases may `git clean -fdx` the pair away; a RETRY
    // mirrors on its marker, but a run whose manifest is gone before it ever
    // settled has nothing to read and nothing to mirror.
    fs.rmSync(ws.manifest);

    const { exitCode, stderr } = await run(ws, ["run", "gone"], inBoxHome(ws));

    expect(exitCode).toBe(2);
    expect(stderr).toContain("manifest is not resolvable");
    expect(fs.existsSync(ws.sentinel)).toBe(false);
    expect(fs.existsSync(ws.markerFile("homeless"))).toBe(false);
  }, 60_000);

  test("`run \"\"` refuses on the run-id grammar, not on argc (round-5 #8)", async () => {
    const ws = workspace();
    writeManifest(ws, [sentinelPhase(ws, "plan"), tailPhase()]);

    // The empty id passes the exactly-one-argument check and dies on the
    // CHARSET half instead — the front door's own grammar, before HOME is
    // even consulted.
    const { exitCode, stderr } = await run(ws, ["run", ""], inBoxHome(ws));

    expect(exitCode).toBe(2);
    expect(stderr).toContain("is not a safe path component");
    expect(fs.existsSync(ws.sentinel)).toBe(false);
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

    // Deterministic home for the same reason as the no-budget row above: the
    // witness carries a requestId, which is the resident-arming shape.
    const { exitCode, stderr } = await run(ws, ["run", "bad-req"], inBoxHomeDeterministic(ws));

    expect(exitCode).toBe(2);
    expect(stderr).toContain("requestId that is not a safe identifier");
    expect(fs.existsSync(ws.sentinel)).toBe(false);
    // The forged line is not a line: the message is sanitized on its way out.
    // RAW stderr is the load-bearing assert: events() silently drops "{"
    // lines that fail JSON.parse, and a raw newline interpolated into a
    // structured line breaks the enclosing JSON so BOTH halves vanish from
    // the parsed channel — exactly the shape a parsed-only assert cannot see
    // (and this refusal is a plain throw, so the structured channel here is
    // empty by design). The quote-anchored form matches only the unescaped
    // forged JSON, never a correctly-sanitized echo of the id.
    expect(stderr).not.toContain('"event":"forged"');
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

  test("the FLAG door enforces the front door's run-id grammar — refused at parse, before anything is opened", async () => {
    const ws = workspace();
    writeManifest(ws, [sentinelPhase(ws, "plan"), tailPhase()]);

    // `../x` passes any length check and fails only the CHARSET half of
    // IN_BOX_RUN_ID_RE — the arm that used to be accepted at the flag door
    // and die ~400 lines later in startResident, after the claim, the
    // manifest load and the witness reconciliation had all run.
    const { exitCode, stderr } = await run(ws, baseArgs(ws, "../x"));

    expect(exitCode).toBe(2);
    expect(stderr).toContain("--run-id must be a safe identifier");
    // Relaxed to the discriminating fragment (round-5 #7): the cross-reference
    // sentence's exact backtick spelling of `run` is prose, the FACT that both
    // doors share one grammar is the contract.
    expect(stderr).toMatch(/front door enforces the same grammar/);
    // Refused AT PARSE: no journal, no marker, no phase body — the bad input
    // costs nothing to reject, which is the point of refusing it this early.
    expect(fs.existsSync(ws.journal)).toBe(false);
    // #217 F-D1 note: the refusal is AT PARSE, before any root derivation —
    // so nothing at all exists under the marker root, per-run or otherwise.
    expect(fs.existsSync(path.join(ws.markerRoot, "qds-run"))).toBe(false);
    expect(fs.existsSync(ws.sentinel)).toBe(false);
  }, 60_000);

  test("`run` takes exactly one argument — the missing AND the surplus arm", async () => {
    const ws = workspace();
    writeManifest(ws, [sentinelPhase(ws, "plan"), tailPhase()]);
    const missing = await run(ws, ["run"], inBoxHome(ws));
    expect(missing.exitCode).toBe(2);
    expect(missing.stderr).toContain("qds-engine run <run-id>");
    // The surplus arm is the likelier operator footgun (a pasted command with a
    // trailing word), and the one an engine that silently ignored extra
    // positionals would slip past a zero-argument-only test.
    const surplus = await run(ws, ["run", "one", "two"], inBoxHome(ws));
    expect(surplus.exitCode).toBe(2);
    expect(surplus.stderr).toContain("qds-engine run <run-id>");
    expect(fs.existsSync(ws.sentinel)).toBe(false);
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
    const rawLog = fs.readFileSync(ws.engineLog, "utf8");
    // RAW-shape pin (round-5 #3): every line that starts with "{" is a
    // complete structured event — a torn or interleaved write would leave a
    // "{"-line that does not parse (or parses without a string `event`), and
    // `events()` would silently drop it rather than fail.
    for (const line of rawLog.split("\n")) {
      const t = line.trim();
      if (!t.startsWith("{")) continue;
      const row = JSON.parse(t) as Record<string, unknown>; // throws on a torn line
      expect(typeof row.event).toBe("string");
    }
    const logged = events(rawLog);
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
        // Null on the `emitEngineEvent` shapes; ABSENT is tolerated for the raw
        // writeAll shapes (trace_store_error, resident warns) that legitimately
        // omit the field — `expect(undefined).toBeNull()` would misread a
        // sidecar event as a contract violation.
        expect(e.phaseId === null || e.phaseId === undefined).toBe(true);
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
    // Round-5 behavior-change pin: `level` follows the VERDICT — a settled-ok
    // run reads info; the not-ok row below pins the other arm as error.
    expect(settled?.level).toBe("info");
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
      // ABSOLUTE path under an impossible directory — the same standard the
      // pipeline.qds-factory.json fixture holds itself to — so no PATH entry
      // (hostile or polluted CI image) can make this spawn succeed.
      sentinelPhase(ws, "build", { command: ["/qds-no-such-directory-df1-10/spawn-enoent-df1-10"] }),
    ]);

    const { exitCode } = await run(ws, [...baseArgs(ws, "red-run"), "--engine-log", ws.engineLog]);
    expect(exitCode).toBe(1);

    const logged = events(fs.readFileSync(ws.engineLog, "utf8"));
    const settledPhases = logged.filter((e) => e.event === "phase_settled");
    expect(settledPhases.map((e) => [e.phase, e.status])).toEqual([
      ["plan", "success"],
      ["build", "fail"],
    ]);
    const settled = logged.find((e) => e.event === "engine_settled");
    expect(settled?.ok).toBe(false);
    // Round-5 behavior-change pin: a run that genuinely settled not-ok is a
    // real failure and is LEVELLED error — alerting keyed on `level:"error"`
    // must fire here, not only on refusals.
    expect(settled?.level).toBe("error");
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
    // Round-5 #10: there is no structured warn EVENT for this (the emitter's
    // event set is closed), so pin the warn line's exact template instead of
    // the old loose /engine log/i — path, the EISDIR errno (libuv's stable
    // errno-name prefix; only the prose after it is platform-flavoured), and
    // the degraded-mode tail. This is what an operator greps a harvested log for.
    expect(stderr).toContain(asDir);
    expect(stderr).toContain("could not be opened (EISDIR");
    expect(stderr).toContain("continuing with stderr only");
    expect(readJournal(ws.journal).ok).toBe(true);
  }, 60_000);

  test("an --engine-log aliasing the journal or the marker is refused before either file is opened", async () => {
    const ws = workspace();
    writeManifest(ws, [sentinelPhase(ws, "plan"), tailPhase()]);

    // The journal is REWRITTEN IN FULL on every phase while the log APPENDS:
    // one path as both is silent mutual corruption (each flush truncates the
    // log, each tee'd line corrupts the journal JSON), and the journal
    // reclaim guard deliberately PROCEEDS on an unparseable journal — so
    // nothing downstream would ever report it. The derived in-box argv
    // always names them distinctly; only a hand-built argv can alias them.
    const aliasedJournal = await run(ws, [...baseArgs(ws, "alias-journal"), "--engine-log", ws.journal]);
    expect(aliasedJournal.exitCode).toBe(2);
    expect(aliasedJournal.stderr).toContain("resolves to the same file as --journal");

    const aliasedMarker = await run(ws, [...baseArgs(ws, "alias-marker"), "--engine-log", ws.markerFile("alias-marker")]);
    expect(aliasedMarker.exitCode).toBe(2);
    expect(aliasedMarker.stderr).toContain("resolves to the same file as the terminal marker path");

    // Round-5 behavior-change pin: the alias check now covers the CLAIM path
    // too (#217 F-D1). The log APPENDS while the claim is created-and-removed
    // O_EXCL — one path as both is the same silent mutual corruption, and the
    // claim is removed on every exit path, taking the log's bytes with it.
    const aliasedClaim = await run(ws, [
      ...baseArgs(ws, "alias-claim"),
      "--engine-log", path.join(ws.markerRoot, "qds-run", "alias-claim", "journal", "engine.claim"),
    ]);
    expect(aliasedClaim.exitCode).toBe(2);
    expect(aliasedClaim.stderr).toContain("resolves to the same file as the engine claim path");

    // Refused at parse, before EITHER file was opened: no journal rows, no
    // log bytes, no marker — the corruption the guard exists for never began.
    expect(fs.existsSync(ws.journal)).toBe(false);
    expect(fs.existsSync(ws.engineLog)).toBe(false);
    expect(fs.existsSync(ws.markerFile("alias-claim"))).toBe(false);
    expect(fs.existsSync(ws.sentinel)).toBe(false);
  }, 60_000);

  test("the host-side gate verbs are not engine verbs — `approve`/`attach` refuse at parse (round-5 #11)", async () => {
    const ws = workspace();
    writeManifest(ws, [sentinelPhase(ws, "plan"), tailPhase()]);

    // C19 moved `fleet approve|reject` and `fleet attach --message` to the
    // HOST verb set: a human approves, the box never gates itself. The
    // engine's flag parser has positional tolerance (bare tokens are
    // ignored), so the verb is not reported "unknown" — it is simply not an
    // engine subcommand, and with no flags at all the required-flag check is
    // what refuses. What is pinned: neither verb DOES anything in-box, and
    // no run state appears.
    for (const verb of ["approve", "attach"]) {
      const { exitCode, stderr } = await run(ws, [verb, "x"]);
      expect(exitCode).toBe(2);
      expect(stderr).toContain("--manifest is required");
    }
    expect(fs.existsSync(ws.sentinel)).toBe(false);
    expect(fs.existsSync(ws.markerFile("alias-claim"))).toBe(false);
    expect(fs.existsSync(ws.journal)).toBe(false);
  }, 60_000);
});

// ─── DF3.6b AC3 — the in-box front door is the enforcement context ───────────

describe("DF3.6b AC3/INV-MEM-2 — `run <runId>` supplies the memory bound; an unenforceable box refuses the RESIDENT, never the run", () => {
  const FIXTURES = path.join(REPO_ROOT, "tests", "phase-engine", "fixtures");
  // Not a skip gate (review round 2, finding 3): the earlier version skipped on
  // Linux, which is where CI runs, so the only end-to-end coverage of edits
  // (iii) and (vi) ran nowhere in CI. The branch is selected by what the RUN
  // actually reported — `rss_unenforceable` on stderr — not by a host probe,
  // and both sides assert something the wiring can fail.

  test(
    "the front door applies the bound: unenforceable ⇒ resident_disabled/rss_unenforceable and the run still settles ok",
    async () => {
      const ws = workspace();
      writeManifest(ws, [sentinelPhase(ws, "plan"), tailPhase()]);
      writeWitness(ws, {
        runId: "qds-20260918-rssgate",
        requestId: "req-rssgate",
        budgetMs: 200_000,
        effectiveCeilingMicros: 250_000,
      });
      // The rate MUST resolve, or `rate_unresolved` preempts the gate this test
      // is about and it would pass for the wrong reason. The fixture catalog
      // resolves the resident slug; the key is present and fake. No model is
      // ever reached: the cgroup arming check runs BEFORE the first
      // solicitation, and `QDS_PI_BIN` is the fake resident either way.
      const { exitCode, stderr } = await run(ws, ["run", "qds-20260918-rssgate"], {
        HOME: ws.dir,
        QDS_PI_CATALOG_DIR: path.join(FIXTURES, "pi-catalog"),
        QDS_PI_BIN: path.join(FIXTURES, "fake-resident.ts"),
        OPENROUTER_API_KEY: "sk-or-v1-df36b-inbox-fixture-key-00000011111",
      });

      // INV-MEM-2 degrades toward DETERMINISM on BOTH branches: whatever the
      // box can enforce, the RUN settles. A refusal that failed the run would be
      // the opposite of the invariant.
      expect(exitCode).toBe(0);
      // NOT the rate arm, on either branch — that would mean the fixture catalog
      // failed to resolve and this test proved nothing about the memory gate.
      expect(stderr).not.toContain("rate_unresolved");
      const journal = readJournal(path.join(ws.dir, "qds-20260918-rssgate.journal.jsonl"));

      if (stderr.includes("rss_unenforceable")) {
        // The unenforceable branch — the darwin operator host, and any Linux box
        // whose engine cgroup carries no `Delegate=memory`. This is the AC3
        // shape end to end: DF3.3's closed status set, no fourth value, and no
        // tripwire row (the cause union has no member for an arming refusal and
        // no agent ran).
        expect(stderr).toContain("resident_disabled");
        expect(journal.resident?.status).toBe("disabled");
        expect(journal.resident?.tripwires).toEqual([]);
        expect(journal.resident?.spendMicros).toBe(0);
      } else {
        // The enforceable branch: the bound was applied and the resident armed.
        // "Not disabled" alone is NOT enough — it also holds when edit (iii) is
        // deleted and the resident runs with no cgroup at all, which is the one
        // regression this branch exists to catch. Assert the BOUND-SPECIFIC side
        // effect instead: the per-solicitation `resident_cgroup` line, which is
        // emitted only when the cgroup machinery ran, carrying the manifest's
        // own `residentRssBytes` value.
        expect(journal.resident?.status).not.toBe("disabled");
        expect(stderr).not.toContain("resident_disabled");
        expect(stderr).toContain("resident_cgroup");
        expect(stderr).toContain('"residentRssBytes":536870912');
      }
    },
    60_000,
  );
});
