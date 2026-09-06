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
});
