/**
 * PR #216 round 4, C4 P30 (auditor M1 / DF1.10 AC2b): the manifest pair's
 * location is spelled independently on both sides of the box boundary.
 * Dispatch builds it from fill.ts's `DEFAULT_FILL_WORKDIR` + `QDS_IN_BOX_DIR`;
 * the in-box engine re-derives it in `deriveInBoxArgv`
 * (scripts/pipeline-run.ts) from HOME — and CANNOT import fill.ts, because the
 * engine ships as unbundled source with a node_modules narrowed to `yaml`+`zod`
 * (importing fill.ts drags the provider/transport closure and forces a
 * `deriveBuildId` input — the Dockerfile — to change). Until this test,
 * nothing executable linked the two spellings: tests/fleet/dispatch.test.ts
 * pinned only dispatch's side of the string, so engine-side literal drift went
 * green, and the "one root" property rested on two comments that disagreed.
 *
 * `deriveInBoxArgv` is unexported and scripts/pipeline-run.ts is out of edit
 * scope, so the honest derivation is to EXECUTE it: the real front door
 * (`qds-engine run <id>`) runs as a subprocess with a fake absolute HOME, and
 * each derived path is captured from the engine's OWN refusal text on stderr —
 * the only place those paths become observable. No engine-side path is
 * re-typed here, so drift in EITHER pipeline-run.ts's literals OR fill.ts's
 * constants turns this suite red.
 */
import { afterAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { DEFAULT_FILL_WORKDIR, QDS_IN_BOX_DIR } from "../../src/providers/exedev/fill.ts";

const REPO_ROOT = path.resolve(import.meta.dir, "..", "..");
const ENGINE = path.join(REPO_ROOT, "scripts", "pipeline-run.ts");

/** The dispatch-side spelling under test: `<workdir>/<in-box-dir>/<file>`. */
function dispatchSide(file: string): string {
  return path.join(DEFAULT_FILL_WORKDIR, QDS_IN_BOX_DIR, file);
}

const tmpRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "df1-10-ac2b-")));
afterAll(() => fs.rmSync(tmpRoot, { recursive: true, force: true }));

let seq = 0;
/** A fresh fake HOME: the in-box layout (`$HOME/src`) anchors inside it. */
function fakeHome(): string {
  const home = path.join(tmpRoot, `home-${seq++}`);
  fs.mkdirSync(home, { recursive: true });
  return home;
}

/** `qds-engine run <id>` with the in-box layout anchored at a fake HOME. */
async function runEngine(runId: string, home: string): Promise<string> {
  const proc = Bun.spawn({
    // `process.execPath`, not "bun": a sibling suite that rewrites PATH must
    // not decide which runtime this spawns (same reason as pipeline-run.test).
    cmd: [process.execPath, ENGINE, "run", runId],
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      HOME: home,
      // The replay guard and the engine claim probe the marker root; keep both
      // inside the tmp tree rather than the host's real /run.
      QDS_RUN_ROOT: path.join(home, "run"),
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const stderr = await new Response(proc.stderr).text();
  const code = await proc.exited;
  // Every refusal this test drives exits 2 with `pipeline-run: <msg>` on fd 2.
  expect(code, `stderr: ${stderr}`).toBe(2);
  return stderr;
}

/**
 * The same front door WITHOUT the exit-2 assumption: the relative-roster leg
 * below drives a run that WALKS (a code phase succeeds, a dispatch_task phase
 * refuses as data), so it settles exit 1, not a derivation refusal's 2.
 */
async function runEngineRaw(
  runId: string,
  home: string,
  extraEnv: Record<string, string> = {},
): Promise<{ stderr: string; exitCode: number }> {
  const proc = Bun.spawn({
    cmd: [process.execPath, ENGINE, "run", runId],
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      HOME: home,
      QDS_RUN_ROOT: path.join(home, "run"),
      ...extraEnv,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stderr, exitCode] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
  return { stderr, exitCode };
}

describe("AC2b inbox root agreement — engine-derived argv vs fill.ts constants", () => {
  test("the witness path the engine derives is <workdir>/<in-box-dir>/run-context.json", async () => {
    // Empty HOME: the witness read is the FIRST refusal deriveInBoxArgv raises,
    // and its message quotes the derived path verbatim.
    const home = fakeHome();
    const stderr = await runEngine("ac2b-run", home);
    const m = /(\S*run-context\.json) is unreadable/.exec(stderr);
    expect(m, `engine refusal should quote its derived witness path; stderr: ${stderr}`).not.toBeNull();
    // The expect above proves the match; `noUncheckedIndexedAccess` cannot see
    // that group 1 of this regex can never be absent, hence the assertion.
    const witness = m![1] as string;
    expect(path.relative(home, witness)).toBe(dispatchSide("run-context.json"));
  });

  test("the manifest path the engine derives is <workdir>/<in-box-dir>/pipeline.yaml, beside the witness", async () => {
    // Witness placed where DISPATCH fills it (via fill.ts's own exports), with
    // a budget the derivation accepts — so the derivation completes and the
    // missing manifest becomes the first refusal, naming the manifest path.
    const home = fakeHome();
    const inbox = path.join(home, dispatchSide(""));
    fs.mkdirSync(inbox, { recursive: true });
    fs.writeFileSync(
      path.join(inbox, "run-context.json"),
      `${JSON.stringify({ budgetMs: 60_000, requestId: "ac2b-req-1" })}\n`,
    );
    const stderr = await runEngine("ac2b-run", home);
    const m = /manifest is not resolvable: (.+)$/m.exec(stderr);
    expect(m, `engine refusal should quote its derived manifest path; stderr: ${stderr}`).not.toBeNull();
    // Same as above: group 1 is the whole path, proved present by the expect.
    const manifest = (m![1] as string).trim();
    expect(path.relative(home, manifest)).toBe(dispatchSide("pipeline.yaml"));
    // AC2b's "pair" property: the manifest and the witness sit in the SAME
    // directory — the one dispatch fills.
    expect(path.dirname(manifest)).toBe(path.join(home, dispatchSide("")));
  });

  test("a dispatch_task phase's RELATIVE roster resolves against the CHECKOUT (<checkout>/r.yaml), not $HOME, cwd, or the .qds manifest dir", async () => {
    // PR #216 round 5: the composition leg no single suite pins. The engine
    // resolves a relative `roster:` through `loadRoster(path, { cwd:
    // --run-root })`, and the front door derives --run-root from the SAME
    // $HOME/src checkout AC2b pins the manifest pair into — three independently
    // spelled anchors (HOME, cwd, <checkout>) that no other test forces to
    // DISAGREE. Driven end to end with the roster planted ONLY at
    // <checkout>/r.yaml, so the resolution anchor is the one variable that can
    // move the verdict.
    //
    // The read lands as INV-2's confinement refusal, and that is the honest
    // in-box outcome, not a workaround: loadRoster confines to the ENGINE's
    // own source tree (defaultRepoRoot — /opt/qds-factory in the box, this
    // repo on a dev host), and a customer checkout is by construction outside
    // it. The refusal MESSAGE is the observable: it names the resolved
    // absolute path. A wrong anchor (<checkout>/.qds/r.yaml, $HOME/r.yaml, a
    // cwd-relative path) names a different path or reports ENOENT — this
    // assertion is what discriminates. QDS_TEAM_RUNNER=local and a provider
    // key are set so dispatch-task's two EARLIER refusal arms (AC5, key
    // presence) do not eat the verdict before the roster read; no team ever
    // spawns, so no fake runner binary is needed either.
    const home = fakeHome();
    const checkout = path.join(home, "src");
    // The manifest pair anchors at HOME (dispatchSide is HOME-relative), which
    // is exactly the AC2b property this leg composes with: the pair INSIDE the
    // checkout at <checkout>/.qds, one level below the roster.
    const inbox = path.join(home, dispatchSide(""));
    fs.mkdirSync(inbox, { recursive: true });
    fs.writeFileSync(
      path.join(inbox, "run-context.json"),
      // No requestId: an identity field would ARM the resident and drag the
      // pi/rate machinery into a test about path resolution. budgetMs and the
      // minted ceiling are the witness's two required numbers — a present
      // witness that vouches for no ceiling refuses the run before the walk
      // (the S28/round-11 hardening), and dispatch always writes both.
      `${JSON.stringify({ budgetMs: 120_000, effectiveCeilingMicros: 250_000 })}\n`,
    );
    fs.writeFileSync(
      path.join(inbox, "pipeline.yaml"),
      `${JSON.stringify({
        version: "1.0.0",
        pipelineId: "relative-roster-demo",
        runBudgetMs: 100_000,
        phases: [
          {
            name: "plan",
            kind: "code",
            description: "Emit the plan artifact for the requested change",
            maxDurationMs: 15_000,
            retries: 0,
            command: ["echo", "planned"],
          },
          {
            name: "ship",
            kind: "dispatch_task",
            description: "Dispatch the roster-picked role to do the work",
            maxDurationMs: 15_000,
            retries: 0,
            roster: "r.yaml",
            task: "fix the seeded failing test",
          },
        ],
      })}\n`,
    );
    fs.writeFileSync(
      path.join(checkout, "r.yaml"),
      // A two-role roster, deliberately SCHEMA-INVALID (roles without a
      // `writes` declaration): the roster must RESOLVE at the checkout —
      // found, read, parsed — and then refuse deterministically on
      // validation, which proves the anchor without ever reaching the
      // dual-gate. Before the in-box roster anchoring (DF2.12 G10 live
      // finding) this refusal never got past containment, because the
      // containment root was defaultRepoRoot() — /opt/qds-factory in the
      // image — not the checkout this run root names.
      "roles:\n  - name: lead\n    model: claude-haiku-4-5\n  - name: worker\n    model: claude-haiku-4-5\n",
    );

    const { stderr, exitCode } = await runEngineRaw("ac2b-roster-run", home, {
      QDS_TEAM_RUNNER: "local",
      OPENROUTER_API_KEY: "sk-or-v1-df110-ac2b-fixture-key-000000111111",
    });
    // The dispatch phase's refusal is data: the run settles not-ok, exit 1.
    expect(exitCode, `stderr: ${stderr}`).toBe(1);
    const rosterAt = path.join(checkout, "r.yaml");
    // The arming-time closed-roster warning names the SAME checkout-anchored
    // resolution (pipeline-run.ts's closedRosterIds catch).
    expect(stderr).toContain("did not load");
    expect(stderr).toContain(rosterAt);
    expect(stderr).not.toContain("cannot read roster");

    const journal = JSON.parse(fs.readFileSync(path.join(home, "ac2b-roster-run.journal.jsonl"), "utf8")) as {
      ok: boolean;
      phases: { name: string; status: string; error?: { message?: string } }[];
    };
    expect(journal.ok).toBe(false);
    expect(journal.phases.map((p) => [p.name, p.status])).toEqual([
      ["plan", "success"],
      ["ship", "fail"],
    ]);
    // THE pin: the dispatch phase's refusal names the CHECKOUT-anchored path —
    // found and realpath'd at <checkout>/r.yaml (never an ENOENT for a
    // differently-anchored guess, never a containment refusal for a path the
    // checkout owns). The refusal body is the roster's own validation error,
    // which is the proof the roster was FOUND where the checkout says it is.
    const message = journal.phases[1]?.error?.message ?? "";
    expect(message).toContain(rosterAt);
    expect(message).not.toContain("outside the repo root");
    expect(message).toContain("writes is required");
  }, 60_000);
});
