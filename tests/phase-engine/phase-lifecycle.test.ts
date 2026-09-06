/**
 * Phase lifecycle tests (Story DF1.1).
 *
 * Each test here targets one way a run could be recorded green by omission:
 * a row that was never earned, a walk that kept going past a failure, a body
 * that outlived its ceiling, or a `finish` whose journal, banner and exit code
 * disagree.
 */
import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  FileJournal,
  PhaseConstructionError,
  type PhaseSpec,
  Run,
  type RunContext,
  RunHaltedError,
  assertLegibleDescription,
  walkPhases,
} from "../../src/phase-engine/index.ts";
// Not on the public barrel (index.ts) by design — journal on-disk layout
// internals — so the suite imports it directly, the same way phase.ts does.
import { runMarkerPath } from "../../src/phase-engine/journal.ts";
import { readJournal } from "./journal-test-util.ts";

const tmpRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "df1-1-lifecycle-")));
afterAll(() => fs.rmSync(tmpRoot, { recursive: true, force: true }));

let seq = 0;
let markerRoot: string;
const savedMarkerRoot = process.env.QDS_RUN_ROOT;

beforeEach(() => {
  markerRoot = path.join(tmpRoot, `marker-${seq++}`);
  process.env.QDS_RUN_ROOT = markerRoot;
});
afterEach(() => {
  // biome-ignore lint/performance/noDelete: an assignment would set the string "undefined"; the var must be genuinely unset.
  if (savedMarkerRoot === undefined) delete process.env.QDS_RUN_ROOT;
  else process.env.QDS_RUN_ROOT = savedMarkerRoot;
});

function journalPath(): string {
  return path.join(tmpRoot, `journal-${seq++}.json`);
}

function spec(over: Partial<PhaseSpec> = {}): PhaseSpec {
  return {
    name: "plan",
    // DF1.10 C19 narrowed PhaseKind to the kinds that execute. Every case here
    // hands `Run.phase` an EXPLICIT body, so the kind is inert — one lifecycle
    // wrapper serves both kinds, which is DF1.1's own "no per-kind subclass".
    kind: "code",
    // Present although inert for the same reason retry.test.ts carries it: the
    // day Run.phase ever gains the loader's command-coherence check, this spec
    // stays valid instead of breaking loudly (round-3 A20).
    command: ["true"],
    description: "Produce the reviewed implementation plan",
    maxDurationMs: 10_000,
    retries: 0,
    ...over,
  };
}

/** A run wired to a fresh file journal; `log` is silenced so the suite stays readable. */
function newRun(runId = `run-${seq++}`): { run: Run; journal: FileJournal; file: string } {
  const file = journalPath();
  const journal = new FileJournal(file, runId);
  const run = new Run({
    ctx: { runId, pipelineId: "demo-pipeline", requestId: "req-abc" },
    journal,
    log: () => {},
  });
  return { run, journal, file };
}

describe("default-fail promotion (AC1)", () => {
  test("a record written and never promoted reads fail", async () => {
    const { run, journal, file } = newRun();
    // The body does not return while the assertions run: what is on disk mid-flight
    // is a `fail` row, written before the body was ever entered.
    const pending = run.phase(spec(), ({ signal }) =>
      new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true })),
    );
    const rows = journal.phases();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe("fail");
    expect(readJournal(file).phases[0]?.status).toBe("fail");

    run.terminate("test teardown");
    const outcome = await pending;
    expect(outcome.status).toBe("fail");
    expect(outcome.exitStatus).toBe("transient");
    expect(readJournal(file).phases[0]?.status).toBe("fail");
  });

  test("the journal refuses to persist an optimistic success on writePhase", () => {
    const file = journalPath();
    const journal = new FileJournal(file, "run-optimistic");
    journal.writePhase({
      runId: "run-optimistic",
      requestId: "r",
      pipelineId: "p",
      phaseId: "p1",
      name: "plan",
      kind: "code",
      // Even handed `success` directly, the port persists `fail`.
      status: "success",
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    expect(journal.phases()[0]?.status).toBe("fail");
    expect(readJournal(file).phases[0]?.status).toBe("fail");

    journal.promotePhase("p1", "success", "success");
    expect(readJournal(file).phases[0]?.status).toBe("success");
  });

  test("a clean body earns success and exitStatus success", async () => {
    const { run, file } = newRun();
    const outcome = await run.phase(spec(), () => "done");
    expect(outcome.status).toBe("success");
    expect(outcome.exitStatus).toBe("success");
    expect(outcome.value).toBe("done");
    expect(readJournal(file).phases[0]?.status).toBe("success");
  });

  test("a clean body whose value declares a non-success exitStatus settles fail with that verdict", async () => {
    // dispatch_task returns refusals/classified failures as VALUES by DF1.6
    // design — the engine must honor the declared verdict, not promote the
    // clean return. Regression pin for the PR-135-round-5 finding (a refused
    // dispatch journaled success).
    const { run, file } = newRun();
    const outcome = await run.phase(spec(), () => ({
      exitStatus: "logic",
      error: { reason: "logic", message: "roster gate failed (exit 1): catalog rejected" },
    }));
    expect(outcome.status).toBe("fail");
    expect(outcome.exitStatus).toBe("logic");
    const row = readJournal(file).phases[0];
    expect(row?.status).toBe("fail");
    expect(row?.exitStatus).toBe("logic");
    expect(row?.error?.message).toBe("roster gate failed (exit 1): catalog rejected");
    expect(run.isHalted).toBe(true);
  });

  test("a clean body whose value declares exitStatus success still promotes", async () => {
    const { run, file } = newRun();
    const outcome = await run.phase(spec(), () => ({ exitStatus: "success", error: null }));
    expect(outcome.status).toBe("success");
    expect(outcome.exitStatus).toBe("success");
    expect(readJournal(file).phases[0]?.status).toBe("success");
  });

  test("a value with an unrecognized exitStatus string cannot steer the verdict", async () => {
    // Membership-validated against the EXIT_STATUSES taxonomy — a garbage or
    // forged status string is ignored (fail-safe: the phase keeps the
    // clean-return semantics it would have had with no verdict field at all).
    const { run } = newRun();
    const outcome = await run.phase(spec(), () => ({ exitStatus: "definitely-green-trust-me" }));
    expect(outcome.status).toBe("success");
    expect(outcome.exitStatus).toBe("success");
  });

  test("a non-success verdict without an error still fails with a legible record", async () => {
    const { run, file } = newRun();
    const outcome = await run.phase(spec(), () => ({ exitStatus: "transient" }));
    expect(outcome.status).toBe("fail");
    expect(outcome.exitStatus).toBe("transient");
    expect(readJournal(file).phases[0]?.error?.message).toContain("transient");
  });

  test("a thrown body leaves fail with exitStatus logic and records the error", async () => {
    const { run, file } = newRun();
    const outcome = await run.phase(spec(), () => {
      throw new Error("body exploded");
    });
    expect(outcome.status).toBe("fail");
    expect(outcome.exitStatus).toBe("logic");
    const row = readJournal(file).phases[0];
    expect(row?.status).toBe("fail");
    expect(row?.error?.message).toBe("body exploded");
    expect(row?.requestId).toBe("req-abc");
  });

  test("a rejected promise is a fail on the same terms as a throw", async () => {
    const { run } = newRun();
    const outcome = await run.phase(spec(), () => Promise.reject(new Error("nope")));
    expect(outcome.status).toBe("fail");
    expect(outcome.exitStatus).toBe("logic");
  });

  test("a promoted phase carries the required row fields", async () => {
    const { run, file } = newRun("run-fields");
    await run.phase(spec(), () => 1);
    const row = readJournal(file).phases[0];
    for (const field of ["runId", "phaseId", "name", "kind", "status", "startedAt", "updatedAt"]) {
      expect(row?.[field as keyof typeof row]).toBeDefined();
    }
    expect(row?.exitStatus).toBe("success");
    expect(row?.subTimings?.phase_body_ms).toBeGreaterThanOrEqual(0);
  });
});

describe("description legibility (AC3)", () => {
  test("the DoD examples", () => {
    expect(() => assertLegibleDescription("commit_plan", "Commit the plan")).toThrow(
      PhaseConstructionError,
    );
    expect(() =>
      assertLegibleDescription("commit_plan", "Persist the reviewed plan to the run artifact directory"),
    ).not.toThrow();
  });

  test("the AC's literal echo form, empty, and whitespace-only all throw", () => {
    expect(() => assertLegibleDescription("commit_plan", "commit plan")).toThrow();
    expect(() => assertLegibleDescription("commit_plan", "Commit Plan.")).toThrow();
    expect(() => assertLegibleDescription("plan", "")).toThrow();
    expect(() => assertLegibleDescription("plan", "   \t\n ")).toThrow();
  });

  test("descriptions that normalize away to nothing throw too", () => {
    // The trailing-dot strip and article filter must not become a way to smuggle
    // an empty description past the emptiness check.
    for (const d of ["...", "the", "a the an", "  the  "]) {
      expect(() => assertLegibleDescription("plan", d)).toThrow(PhaseConstructionError);
    }
  });

  test("construction throws before any row reaches the journal", async () => {
    const { run, journal, file } = newRun();
    await expect(run.phase(spec({ description: "  " }), () => 1)).rejects.toThrow(
      PhaseConstructionError,
    );
    expect(journal.phases()).toHaveLength(0);
    expect(readJournal(file).phases).toHaveLength(0);
  });

  test("an out-of-bounds maxDurationMs is a construction error, not a silent clamp", async () => {
    const { run, journal } = newRun();
    await expect(run.phase(spec({ maxDurationMs: 900_001 }), () => 1)).rejects.toThrow(
      PhaseConstructionError,
    );
    expect(journal.phases()).toHaveLength(0);
  });
});

describe("overflow cancellation (AC4, INV-3)", () => {
  test("the signal fires and the phase reads fail/overflow", async () => {
    const { run, file } = newRun();
    let aborted = false;

    const outcome = await run.phase(spec({ maxDurationMs: 30 }), async ({ signal }) => {
      await new Promise<void>((resolve) => {
        signal.addEventListener(
          "abort",
          () => {
            aborted = true;
            resolve();
          },
          { once: true },
        );
      });
      throw signal.reason;
    });

    expect(aborted).toBe(true);
    expect(outcome.status).toBe("fail");
    expect(outcome.exitStatus).toBe("overflow");
    const row = readJournal(file).phases[0];
    expect(row?.status).toBe("fail");
    expect(row?.exitStatus).toBe("overflow");
  });

  test("nothing a body does after the timer can reach the journal", async () => {
    const { run, file } = newRun();
    const postAbort = path.join(tmpRoot, `post-abort-${seq++}.txt`);

    const outcome = await run.phase(spec({ maxDurationMs: 30 }), async ({ signal }) => {
      await new Promise<void>((resolve) =>
        signal.addEventListener("abort", () => resolve(), { once: true }),
      );
      // A misbehaving body: it keeps working past its own cancellation. The
      // engine cannot un-write its file, but none of it may become a run fact.
      fs.writeFileSync(postAbort, "written after the timer fired");
      return "sneaky success";
    });

    expect(fs.existsSync(postAbort)).toBe(true);
    expect(outcome.status).toBe("fail");
    expect(outcome.exitStatus).toBe("overflow");
    expect(outcome.value).toBeUndefined();
    const journal = readJournal(file);
    expect(journal.phases).toHaveLength(1);
    expect(journal.phases[0]?.status).toBe("fail");
    expect(run.isHalted).toBe(true);
  });

  test("a body that ignores its signal cannot hang the run", async () => {
    const { run } = newRun();
    const started = Date.now();
    // CANCEL_GRACE_MS is 5 s; the assertion is only that the engine returns at
    // all without the body ever settling.
    const outcome = await run.phase(spec({ maxDurationMs: 20 }), () => new Promise(() => {}));
    expect(outcome.status).toBe("fail");
    expect(outcome.exitStatus).toBe("overflow");
    expect(Date.now() - started).toBeLessThan(20_000);
  }, 20_000);

  test("a body that returns after its own abort is still a fail", async () => {
    const { run } = newRun();
    const outcome = await run.phase(spec({ maxDurationMs: 20 }), async ({ signal }) => {
      await new Promise<void>((resolve) => {
        signal.addEventListener("abort", () => resolve(), { once: true });
      });
      return "sneaky success";
    });
    expect(outcome.status).toBe("fail");
    expect(outcome.exitStatus).toBe("overflow");
  });

  test("the walk halts after an overflow", async () => {
    const { run, file } = newRun();
    await run.phase(spec({ maxDurationMs: 20 }), ({ signal }) =>
      new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true })),
    );
    expect(run.isHalted).toBe(true);
    await expect(run.phase(spec({ name: "build" }), () => 1)).rejects.toThrow(RunHaltedError);
    expect(readJournal(file).phases).toHaveLength(1);
  });
});

describe("port contract", () => {
  test("a second concurrent phase is refused — writes stay strictly ordered", async () => {
    const { run, journal } = newRun();
    const first = run.phase(spec({ maxDurationMs: 200 }), ({ signal }) =>
      new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true })),
    );
    await expect(
      run.phase(spec({ name: "build", description: "Apply the reviewed change" }), () => 1),
    ).rejects.toThrow(/already in flight/);
    expect(journal.phases()).toHaveLength(1);
    run.terminate("test teardown");
    await first;
  });

  test("a failed journal write fails the run rather than skipping the row", async () => {
    const { run, file } = newRun("run-journal-throws");
    const exploding = new Run({
      ctx: { runId: "run-journal-throws", pipelineId: "p", requestId: "r" },
      journal: {
        writePhase: () => {
          throw new Error("disk full");
        },
        promotePhase: () => {},
        writeGateEvent: () => {},
        finish: () => ({ ok: false, completedAt: new Date().toISOString() }),
        phases: () => [],
      },
      log: () => {},
    });
    await expect(exploding.phase(spec(), () => 1)).rejects.toThrow(/disk full/);
    // The real run's journal is untouched, and no marker was written for the
    // run whose journal failed.
    expect(readJournal(file).phases).toHaveLength(0);
    expect(fs.existsSync(runMarkerPath("run-journal-throws"))).toBe(false);
    void run;
  });

  test("an invalid PhaseParams.agent is a construction error", async () => {
    const { run, journal } = newRun();
    await expect(
      run.phase({ ...spec(), agent: { agentId: "a", provider: "p", model: "m" } as never }, () => 1),
    ).rejects.toThrow(/invalid agent/);
    await expect(
      run.phase(
        { ...spec(), agent: { agentId: "a", provider: "p", model: "m", contextWindow: 8, extra: 1 } as never },
        () => 1,
      ),
    ).rejects.toThrow(/invalid agent/);
    expect(journal.phases()).toHaveLength(0);

    const ok = await run.phase(
      { ...spec(), agent: { agentId: "a", provider: "anthropic", model: "opus", contextWindow: 200_000 } },
      () => 1,
    );
    expect(ok.status).toBe("success");
  });

  test("a secret in a body's error text never reaches the journal (INV-4)", async () => {
    const secret = "ghp_thisisaverysecretvalue123456";
    process.env.QDS_TEST_API_TOKEN = secret;
    try {
      const { run, file } = newRun("run-redacted");
      await run.phase(spec(), () => {
        throw new Error(`upstream rejected token ${secret}`);
      });
      const raw = fs.readFileSync(file, "utf8");
      expect(raw).not.toContain(secret);
      expect(readJournal(file).phases[0]?.error?.message).toContain("REDACTED");
    } finally {
      // biome-ignore lint/performance/noDelete: an assignment would leave the string "undefined" in the env.
      delete process.env.QDS_TEST_API_TOKEN;
    }
  });

  test("a marker that cannot be written forces the journal back to not-ok", async () => {
    const { run, file } = newRun("run-marker-fails");
    await run.phase(spec(), () => 1);
    // A directory where the marker file must go: the write fails, and the run
    // must not be left claiming green with no completion signal.
    fs.mkdirSync(runMarkerPath("run-marker-fails"), { recursive: true });

    expect(() => run.finish(true)).toThrow();
    expect(readJournal(file).ok).toBe(false);
  });

  test("effectiveCeilingMicros is optional and the engine never defaults it to a number", async () => {
    // Exercises the engine itself, not just the type: a `Run` constructed with a
    // ctx that omits the field, and a body that inspects the ctx it is actually
    // handed by `Run.phase`. A regression that defaulted the field somewhere in
    // the engine (e.g. spreading ctx through a record with a numeric fallback)
    // would fail this; the previous version only asserted on two object
    // literals built in the same expression and could never fail.
    const { run } = newRun();
    let seenCtx: RunContext | undefined;
    await run.phase(spec(), ({ ctx }) => {
      seenCtx = ctx;
      return "ok";
    });
    expect(seenCtx).toBeDefined();
    expect("effectiveCeilingMicros" in (seenCtx as RunContext)).toBe(false);
  });
});

describe("walk termination on throw (AC6)", () => {
  test("a 3-phase manifest whose phase 2 throws journals exactly two rows", async () => {
    const { run, file } = newRun("run-walk");
    const phases: PhaseSpec[] = [
      spec({ name: "plan" }),
      spec({ name: "build", description: "Apply the reviewed change" }),
      spec({ name: "verify", description: "Re-run the suite against the applied change" }),
    ];
    const constructed: string[] = [];
    const outcomes = await walkPhases(run, phases, (s) => {
      constructed.push(s.name);
      return s.name === "build"
        ? () => {
            throw new Error("build failed");
          }
        : () => "ok";
    });

    // The constructor spy: phase 3's body was never built.
    expect(constructed).toEqual(["plan", "build"]);
    expect(outcomes.map((o) => o.status)).toEqual(["success", "fail"]);

    const rows = readJournal(file).phases;
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => [r.name, r.status])).toEqual([
      ["plan", "success"],
      ["build", "fail"],
    ]);
    // Absence, not a `fail` or `skipped` row.
    expect(rows.some((r) => r.name === "verify")).toBe(false);

    const settled = run.finish(true);
    expect(settled.ok).toBe(false);
    expect(settled.exitCode).toBe(1);
  });
});

describe("Run.finish — one settle for journal, banner, exit code (AC7)", () => {
  test("an accepted green run is ok, exits 0, and writes the terminal marker", async () => {
    const { run, file } = newRun("run-green");
    await run.phase(spec(), () => 1);
    await run.phase(spec({ name: "build", description: "Apply the reviewed change" }), () => 2);
    const settled = run.finish(true);

    expect(settled.ok).toBe(true);
    expect(settled.exitCode).toBe(0);
    expect(settled.banner).toContain("ok=true");
    expect(readJournal(file).ok).toBe(true);

    const marker = JSON.parse(fs.readFileSync(runMarkerPath("run-green"), "utf8"));
    expect(marker).toEqual({ runId: "run-green", ok: true, completedAt: settled.completedAt });
    expect(Object.keys(marker).sort()).toEqual(["completedAt", "ok", "runId"]);
    expect(new Date(marker.completedAt).toISOString()).toBe(marker.completedAt);
  });

  test("a red run writes the marker with ok:false and exits 1", async () => {
    const { run } = newRun("run-red");
    await run.phase(spec(), () => {
      throw new Error("boom");
    });
    const settled = run.finish(true);
    expect(settled.ok).toBe(false);
    expect(settled.exitCode).toBe(1);
    expect(JSON.parse(fs.readFileSync(runMarkerPath("run-red"), "utf8")).ok).toBe(false);
  });

  test("accepted=false makes an all-green run not-ok", async () => {
    const { run } = newRun("run-rejected");
    await run.phase(spec(), () => 1);
    expect(run.finish(false).ok).toBe(false);
  });

  test("a run terminated between phases is not ok, even with every row green", async () => {
    const { run, file } = newRun("run-terminated-between");
    await run.phase(spec(), () => 1);
    await run.phase(spec({ name: "build", description: "Apply the reviewed change" }), () => 2);
    // The signal lands after the last phase settled: no row is failed, so only
    // the engine's own terminated⇒not-ok rule can stop this being recorded green.
    run.terminate("SIGTERM");

    const settled = run.finish(true);
    expect(settled.ok).toBe(false);
    expect(settled.exitCode).toBe(1);
    expect(readJournal(file).ok).toBe(false);
    expect(JSON.parse(fs.readFileSync(runMarkerPath("run-terminated-between"), "utf8")).ok).toBe(false);
  });

  test("a journal that also fails during marker recovery still reports the marker failure", async () => {
    let finishes = 0;
    const rows: { status: string }[] = [];
    const run = new Run({
      ctx: { runId: "run-double-failure", pipelineId: "p", requestId: "r" },
      journal: {
        writePhase: () => {
          rows.length = 0;
          rows.push({ status: "fail" });
        },
        promotePhase: () => {
          rows[0] = { status: "success" };
        },
        writeGateEvent: () => {},
        finish: () => {
          finishes += 1;
          if (finishes > 1) throw new Error("disk full during recovery");
          return { ok: true, completedAt: new Date().toISOString() };
        },
        phases: () => [],
      },
      log: () => {},
    });
    await run.phase(spec(), () => 1);
    // Marker path is a directory, so the marker write fails; the recovery
    // `finish` then throws too and must not mask the original failure.
    fs.mkdirSync(runMarkerPath("run-double-failure"), { recursive: true });

    expect(() => run.finish(true)).toThrow(/EISDIR|illegal operation|directory/i);
    expect(finishes).toBe(2);
  });

  test("a run with no phases is never ok", () => {
    const { run } = newRun("run-empty");
    expect(run.finish(true).ok).toBe(false);
  });

  test("a run that never reaches finish leaves the marker absent", async () => {
    const { run } = newRun("run-unfinished");
    await run.phase(spec(), () => 1);
    expect(fs.existsSync(runMarkerPath("run-empty"))).toBe(false);
  });

  test("finish is not repeatable and closes the run to further phases", async () => {
    const { run } = newRun("run-once");
    await run.phase(spec(), () => 1);
    run.finish(true);
    expect(() => run.finish(true)).toThrow(RunHaltedError);
    await expect(run.phase(spec({ name: "build" }), () => 1)).rejects.toThrow(RunHaltedError);
  });

  test("with QDS_RUN_ROOT unset the marker path is exactly /run/qds-run/<runId>/journal/final.json", () => {
    // biome-ignore lint/performance/noDelete: unsetting the variable is exactly what this asserts.
    delete process.env.QDS_RUN_ROOT;
    expect(runMarkerPath("run-once")).toBe("/run/qds-run/run-once/journal/final.json");
    process.env.QDS_RUN_ROOT = markerRoot;
  });
});
