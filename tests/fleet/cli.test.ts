/**
 * CLI tests (Story DF3.1): scripts/fleet.ts run() contract + the MANDATORY
 * e2e demo (DoD): dispatch → status → teardown against the fake driver,
 * capturing the three outputs for the Dev Agent Record.
 *
 * Also covers (DoD): --help renders from the registry (no second list),
 * bidirectional verb coverage, malformed briefs via stdin → exit 2 with
 * zero provisioning, unknown runId → exit 4 mutating nothing, the 64 KiB cap
 * on BOTH sides of its boundary, the FleetError→exit-code table (2/3/4/5, plus
 * 6 for a teardown that succeeded and could not release its lock), the
 * registry-backed flag grammar, the run-id grammar as a path-traversal guard,
 * and the shared per-run lock BOTH harvest and teardown take
 * (scripts/lib/run-lock.ts — the same one sandbox-teardown holds).
 *
 * run() is called through `runCli` so its two sinks stay apart: `err` defaults
 * to `out`, and a merged capture cannot tell an ack on stdout from a refusal
 * envelope printed onto it.
 */
import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Database } from "bun:sqlite";

import { run } from "../../scripts/fleet.ts";
import { run as sandboxTeardownRun } from "../../scripts/sandbox-teardown.ts";
import { listVerbs, renderHelp } from "../../src/fleet/verbs.ts";
import { FakeDriver } from "../../src/providers/fake-driver.ts";
import { FakeKeyApi } from "../providers/fixtures/fake-key-api.ts";
import { RunRecordStore } from "../../src/providers/run-record.ts";
import type { FleetDeps, } from "../../scripts/fleet.ts";
import type { KeyApi } from "../../src/providers/credentials.ts";
import { type LogEntry, setLogSink } from "../../src/swarmclaw/log.ts";
import { goodLedger, overBudgetLedger, type RecordingLedger } from "./helpers.ts";

const tmpRoot = mkdtempSync(join(tmpdir(), "df3-1-cli-"));
afterAll(() => rmSync(tmpRoot, { recursive: true, force: true }));

/**
 * Brief ingress cap, as a LITERAL rather than an import of the CLI's own
 * constant: importing it would make an implementation that quietly lowers the
 * cap to 8 KiB pass both sides of this boundary. The cap is 64 KiB of BYTES,
 * and `briefTooLarge` below re-asserts that the CLI names this same number.
 */
const MAX_BRIEF_BYTES = 64 * 1024;

/**
 * The verb set, pinned. Deriving it from `listVerbs()` makes every assertion
 * below shrink with the registry: delete `harvest` and a registry-derived loop
 * still passes.
 */
const EXPECTED_VERBS = ["dispatch", "status", "harvest", "teardown"] as const;

/** Exit code for `fleet <verb>` with no positional and an injected driver. */
const BARE_VERB_EXIT: Record<(typeof EXPECTED_VERBS)[number], number> = {
  dispatch: 2, // brief read, then refused as invalid JSON — never unknown-verb
  status: 0, // no runs is a state, not an error (AC4)
  harvest: 2, // missing <run-id>
  teardown: 2, // missing <run-id>
};

/**
 * The manifest path every brief here carries, RELATIVE to the containment root
 * (`deps().repoRoot`, the case's tmpdir). The schema now refuses an absolute
 * `manifestPath` outright — `resolve(repoRoot, "/etc/shadow")` discards the
 * root, so absoluteness was the containment hole — and dispatch resolves the
 * relative form against `repoRoot`, which is what makes it land on the file
 * `validBriefJson` just wrote.
 */
const MANIFEST_REL = join("manifests", "pipeline.json");

function validBriefJson(dir: string): string {
  const manifestDir = join(dir, "manifests");
  mkdirSync(manifestDir, { recursive: true });
  const manifestPath = join(manifestDir, "pipeline.json");
  writeFileSync(
    manifestPath,
    JSON.stringify({
      version: "1.0.0",
      pipelineId: "e2e-pipeline",
      runBudgetMs: 200_000,
      phases: [
        { name: "plan", kind: "engineer", description: "Draft the approach for the change", maxDurationMs: 10_000, retries: 0 },
        { name: "build", kind: "code", description: "Run the repository test suite", command: ["bun", "test"], maxDurationMs: 40_000, retries: 0 },
      ],
    }),
  );
  return JSON.stringify({
    repoSlug: "owner/repo",
    issueId: 42,
    commitSha: "b".repeat(40),
    manifestPath: MANIFEST_REL,
    repoUrl: "https://github.com/owner/repo",
  });
}

/**
 * The env the CLI's OWN defaults read when a test injects neither `--dir` nor
 * `deps.store`. Left alone, `$QDS_RUNS_DIR` and friends made this suite resolve
 * differently on a developer's shell than in CI, and pointed the "nothing was
 * provisioned" assertions at `<repo>/.sandbox/...` — a path no assertion here
 * checks. Every key is snapshotted and restored; the two directory ones are
 * REDIRECTED into the case's tmpdir rather than deleted, which is what makes
 * `expect(existsSync(<tmp>/.sandbox/runs)).toBeFalse()` a claim about the path
 * the CLI would actually build.
 */
const CLI_ENV_KEYS = [
  "QDS_RUNS_DIR",
  "QDS_FAKE_BOXES_DIR",
  "QDS_COST_LEDGER_FILE",
  "QDS_COST_CONFIG_FILE",
  // Not redirected, only snapshotted: the cases that care unset it (a host
  // that exports one would otherwise hide the refusal they assert on).
  "OPENROUTER_PROVISIONING_KEY",
] as const;

/**
 * A keyApi that refuses to be touched at all — D8's credential-free claim for
 * `harvest` as a tripwire rather than a comment. Harvest builds no key API, so
 * ANY property read of an injected one is already the regression; the throw
 * names which one was read.
 */
function keyApiTripwire(): KeyApi {
  return new Proxy({} as KeyApi, {
    get: (_target, prop) => {
      throw new Error(`harvest touched keyApi.${String(prop)} — harvest is credential-free (D8)`);
    },
  });
}

/**
 * A FakeDriver whose `exec` is shadowed for ONE argv, leaving every other
 * primitive real. Prototype delegation, not a stub: the box, the key delivery
 * and the fill all still happen, so the failure under test is the only one.
 */
function driverWith(base: FakeDriver, over: Partial<FakeDriver>): FakeDriver {
  return Object.assign(Object.create(base) as FakeDriver, over);
}

describe("scripts/fleet.ts (DF3.1 CLI)", () => {
  let dir: string;
  let boxesDir: string;
  let runsDir: string;
  /** Both streams, interleaved — what a terminal shows. */
  let captured: string[];
  /** stdout only, and stderr only: `run()`'s two sinks, kept apart. */
  let outOnly: string[];
  let errCaptured: string[];
  let savedEnv: Record<string, string | undefined>;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpRoot, "cli-"));
    boxesDir = join(dir, "boxes");
    runsDir = join(dir, "runs");
    captured = [];
    outOnly = [];
    errCaptured = [];
    savedEnv = Object.fromEntries(CLI_ENV_KEYS.map((k) => [k, process.env[k]]));
    // An explicit ledger/config file would follow the CLI's env tier and defeat
    // the --dir scoping case; the two directories are redirected, not deleted,
    // so the CLI's cwd-relative defaults land inside the case's tmpdir.
    // biome-ignore lint/performance/noDelete: unsetting env vars requires delete
    delete process.env.QDS_COST_LEDGER_FILE;
    // biome-ignore lint/performance/noDelete: unsetting env vars requires delete
    delete process.env.QDS_COST_CONFIG_FILE;
    process.env.QDS_RUNS_DIR = join(dir, ".sandbox", "runs");
    process.env.QDS_FAKE_BOXES_DIR = join(dir, ".sandbox", "fake-boxes");
    mkdirSync(join(dir, ".sandbox"), { recursive: true });
    // Two locations because there are two resolution paths, and the teardown
    // e2e below proves which one is live: `--dir <dir>/runs` resolves the cost
    // config one level up from the store (`<dir>/cost-config.json`), while a
    // cwd-relative default would find `.sandbox/cost-config.json`. Writing both
    // keeps the fixture honest either way; the `--dir` scoping test asserts the
    // ledger lands beside the runs dir and nowhere else.
    writeFileSync(join(dir, ".sandbox", "cost-config.json"), '{"boxHourRateMicroUsd": 3600000}');
    writeFileSync(join(dir, "cost-config.json"), '{"boxHourRateMicroUsd": 3600000}');
  });

  afterEach(() => {
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    rmSync(dir, { recursive: true, force: true });
  });

  function deps(briefJson: string): Partial<FleetDeps> {
    return {
      driver: new FakeDriver(boxesDir),
      keyApi: new FakeKeyApi(),
      store: new RunRecordStore(runsDir),
      ledgerFactory: () => goodLedger(),
      readBrief: async () => briefJson,
      // INV-1's containment root, injected rather than inherited from the
      // process cwd. Before this seam existed every case with a tmpdir manifest
      // had to chdir, mutating a global shared with every other test file.
      repoRoot: dir,
    };
  }

  const out = (s: string): void => {
    outOnly.push(s);
    captured.push(s);
  };

  /**
   * run()'s 4th sink. It exists because `err` DEFAULTS to `out`: every call
   * that passed three arguments merged the two streams, so every assertion on a
   * refusal envelope held just as well if `printError` wrote it to stdout —
   * while `import.meta.main` binds `err` to fd 2 precisely so `fleet status |
   * jq` never has to parse one. Diagnostics are pushed to BOTH arrays so
   * `text()` still reads as a terminal does (interleaved, in order); the split
   * is what `errCaptured` and `outOnly` are asserted on.
   */
  const errOut = (s: string): void => {
    errCaptured.push(s);
    captured.push(s);
  };

  /** Every invocation in this file, with the two sinks kept apart. */
  const runCli = (argv: readonly string[], d?: Partial<FleetDeps>): Promise<number> => run(argv, out, d, errOut);

  const reset = (): void => {
    captured.length = 0;
    outOnly.length = 0;
    errCaptured.length = 0;
  };

  const text = (): string => captured.join("");

  // ─── --help renders from the registry (AC6) ────────────────────────────────

  test("--help renders the registry's four verbs and their declared flags", async () => {
    const code = await runCli(["--help"], deps(""));
    expect(code).toBe(0);
    const helpText = text();
    // The registry is the contract; pinning it to a literal is what makes the
    // assertions below fail when a verb is dropped instead of shrinking with it.
    expect(listVerbs().map((v) => v.verb)).toEqual([...EXPECTED_VERBS]);
    expect(helpText.startsWith("Usage: fleet <verb> [options]")).toBeTrue();
    expect(helpText.endsWith("\n")).toBeTrue();
    for (const verb of EXPECTED_VERBS) expect(helpText).toContain(verb);
    for (const flag of ["--driver", "--brief", "--dir", "--port", "--no-harvest", "--help"]) {
      expect(helpText).toContain(flag);
    }
    expect(helpText).toContain("Exit codes:");
    // No second list: the text IS the registry rendering, byte for byte.
    expect(helpText).toBe(`${renderHelp(listVerbs())}\n`);
  });

  test("every documented help path exits 0 and prints usage", async () => {
    for (const argv of [["--help"], ["-h"], ["help"], ["dispatch", "--help"], ["status", "-h"], ["teardown", "--help"]]) {
      reset();
      const code = await runCli(argv, deps(""));
      expect(code).toBe(0);
      expect(text()).toContain("Usage: fleet <verb> [options]");
    }
  });

  test("with no repoRoot injected the containment root defaults to the process cwd", async () => {
    // Every other case injects `repoRoot`, so without this one a default that
    // regressed to "the brief's own directory" would keep the whole file green
    // while shipping the traversal INV-1 exists to stop. The manifest this
    // brief names exists ONLY under the case's tmpdir, so resolved against the
    // repo the CLI is actually run from it must not be found — and the refusal
    // names that root, which is what pins WHICH root the default is.
    const { repoRoot: _omitted, ...noRoot } = deps(validBriefJson(dir));
    const code = await runCli(["dispatch", "--driver", "fake"], noRoot);
    expect(code).toBe(2);
    expect(text()).toContain("manifest-rejected");
    // The remediation names the containment root the manifest was resolved
    // against: the process cwd, never the tmpdir the brief was written in.
    expect(text()).toContain(process.cwd());
    expect(text()).not.toContain(dir);
    expect(readdirSync(runsDir)).toHaveLength(0);
    // `boxesDir` itself is created by FakeDriver's constructor, so its
    // existence proves nothing — its emptiness is the assertion that matters.
    expect(readdirSync(boxesDir)).toHaveLength(0);
  });

  test("no verb → exit 2 usage (a bare `fleet` is a mistyped invocation, not a help request)", async () => {
    const code = await runCli([], deps(""));
    expect(code).toBe(2);
    const refusal = text();
    expect(refusal).toContain("no verb given");
    // The remediation is the usage text — an operator who typed nothing needs
    // the verb list, not just the refusal.
    for (const verb of EXPECTED_VERBS) expect(refusal).toContain(verb);
  });

  // ─── bidirectional verb coverage (AC6) ─────────────────────────────────────

  test("every registry verb is dispatchable, with the exact exit its bare form owes", async () => {
    expect(listVerbs().map((v) => v.verb)).toEqual([...EXPECTED_VERBS]);
    for (const verb of EXPECTED_VERBS) {
      reset();
      const code = await runCli([verb], deps(""));
      expect(text()).not.toContain("unknown-verb");
      // `expect([0,2]).toContain(code)` was satisfied by a verb that had
      // stopped working — each verb owes ONE code here.
      expect({ verb, code }).toEqual({ verb, code: BARE_VERB_EXIT[verb] });
    }
  });

  test("a non-registry verb is refused with unknown-verb (exit 2) and provisions nothing", async () => {
    // Words a drifting dispatch switch would plausibly grow — each must be
    // refused by the registry check BEFORE any verb body runs.
    for (const word of ["warp", "reap", "list", "destroy", "provision", "Dispatch", "dispatch-all"]) {
      reset();
      const d = deps("");
      const code = await runCli([word], d);
      expect({ word, code }).toEqual({ word, code: 2 });
      const envelope = JSON.parse(captured[0] as string) as { code: string; message: string };
      expect(envelope.code).toBe("unknown-verb");
      expect(envelope.message).toBe(`unknown verb ${JSON.stringify(word)}`);
      expect(readdirSync(runsDir)).toHaveLength(0);
      expect(readdirSync(boxesDir)).toHaveLength(0);
    }
  });

  test("every dispatched arm has a registry entry, fall-through arms included", async () => {
    // The other direction of AC6 parity, and the only way to see it: the
    // registry check runs BEFORE the switch, so an unregistered arm is
    // unreachable at runtime and no black-box probe can find it. Read the arms.
    //
    // The scan used to be `verb === "([a-z-]+)"` alone, which promised a
    // guarantee the regex could not give: `teardown` is dispatched as the `else`
    // fall-through and never appeared in the match set at all, so the assertion
    // ran over 3 of the 4 shipped arms — and a new verb written as a second
    // fall-through or as a `switch`/`case` was invisible to it. Both explicit
    // forms are matched now, the fall-through set is NAMED rather than assumed,
    // and the arm COUNT is pinned, so an arm this scan cannot see fails loudly
    // here instead of going unread.
    const source = readFileSync(join(import.meta.dir, "../../scripts/fleet.ts"), "utf8");
    const armed = [...source.matchAll(/verb === "([a-z-]+)"|case "([a-z-]+)"/g)].map((m) => (m[1] ?? m[2]) as string);
    expect(armed.length).toBeGreaterThan(0);
    const registry = listVerbs().map((v) => v.verb);
    for (const verb of armed) expect(registry).toContain(verb);

    // Everything the registry declares that the scan did NOT see is dispatched
    // by fall-through. Naming the set is what makes a SECOND one fail.
    const fallThrough = registry.filter((v) => !armed.includes(v));
    expect(fallThrough).toEqual(["teardown"]);
    // …and "dispatched by fall-through" is only true if it reaches a verb body:
    // each must answer with its own grammar, never the unknown-verb refusal.
    for (const verb of fallThrough) {
      reset();
      expect({ verb, code: await runCli([verb, "--driver", "fake"], deps("")) }).toEqual({ verb, code: 2 });
      expect(text()).toContain(`${verb} requires <run-id>`);
      expect(text()).not.toContain("unknown-verb");
    }
    // Every arm accounted for exactly once: explicit + fall-through = registry.
    expect(new Set(armed).size + fallThrough.length).toBe(registry.length);
  });

  test("the registry owns the per-verb flag grammar: `status --brief x` is refused, not ignored", async () => {
    const code = await runCli(["status", "--driver", "fake", "--brief", "x"], deps(""));
    expect(code).toBe(2);
    expect(text()).toContain("status does not take --brief");
    // The remediation lists what status DOES take.
    expect(text()).toContain("--driver");
    expect(readdirSync(runsDir)).toHaveLength(0);
  });

  test("--no-harvest is a teardown flag only", async () => {
    const code = await runCli(["dispatch", "--driver", "fake", "--no-harvest"], deps(""));
    expect(code).toBe(2);
    expect(text()).toContain("dispatch does not take --no-harvest");
  });

  test("a flag no verb declares is refused by the tokenizer, not swallowed", async () => {
    // `status --brief x` above is a flag the REGISTRY knows on the wrong verb —
    // a different check. This one nothing declares, so it must die in
    // parseValueFlags before any verb body runs.
    const code = await runCli(["status", "--verbose"], deps(""));
    expect(code).toBe(2);
    expect(text()).toContain("unknown flag: --verbose");
    expect(readdirSync(runsDir)).toHaveLength(0);
  });

  test("--flag=value is the same flag as --flag <value>, and its VALUE is consumed", async () => {
    // Fully supported, and therefore routed through the duplicate check below
    // and the per-verb allowed-flag check above; untested, `--driver=fake` could
    // regress to "unknown flag" and every operator who types it is stuck.
    //
    // Paired with a flag whose value actually changes the outcome. On its own
    // `status --driver=fake` proved only "not rejected as an unknown flag":
    // `--driver` is inert wherever `deps.driver` is injected and `status` on an
    // empty store prints nothing, so a splitter yielding `"=fake"` or `"fak"`
    // passed identically. `--port` is the one flag whose parsed value reaches
    // the ack, so a mis-split value cannot survive it.
    const shared = deps(validBriefJson(dir));
    const code = await runCli(["dispatch", "--driver=fake", "--port=8080"], shared);
    expect(code).toBe(0);
    expect(text()).not.toContain("unknown flag");
    const ack = JSON.parse(outOnly.find((l) => l.includes("runId")) as string) as {
      runId: string;
      vmName: string;
      httpsUrl?: string;
    };
    expect(ack.httpsUrl).toBe(`https://${ack.vmName}-8080.fake.local`);
    expect((shared.store as RunRecordStore).get(ack.runId).ports).toEqual([8080]);
  });

  test("a repeated flag is refused, never last-win", async () => {
    // Silent last-win here means `fleet teardown --dir /safe --dir /prod <id>`
    // destroys against /prod while the operator reads /safe off their own
    // command line.
    const code = await runCli(["teardown", "--driver", "fake", "--dir", join(dir, "a"), "--dir", join(dir, "b"), "qds-20260101-abcdef"], deps(""));
    expect(code).toBe(2);
    expect(text()).toContain("--dir given more than once");
    expect(existsSync(join(dir, "a"))).toBeFalse();
    expect(existsSync(join(dir, "b"))).toBeFalse();
  });

  test("a value flag with a flag-looking or missing value is refused, never given the next token", async () => {
    // Without the `startsWith("--")` clause `--dir` swallows `--driver` and the
    // CLI acts on a runs directory literally named "--driver": a fresh empty
    // store, so teardown exits 4 while the real box keeps billing.
    for (const argv of [
      ["teardown", "--dir", "--driver", "fake", "qds-20260101-abcdef"],
      ["status", "--driver"], // trailing, with no value at all
    ]) {
      reset();
      const code = await runCli(argv, deps(""));
      expect({ argv, code }).toEqual({ argv, code: 2 });
      expect(text()).toContain("requires a non-empty value");
      expect(existsSync(join(dir, "--driver"))).toBeFalse();
    }
  });

  test("an extra positional is refused on every verb that owes exactly one", async () => {
    // `fleet dispatch brief.json` silently ignoring the path blocks on stdin in
    // a TTY-less CI job; `fleet teardown id1 id2` tears down only id1 while the
    // operator believes both are gone.
    const cases: [string[], string][] = [
      [["dispatch", "--driver", "fake", "somefile.json"], "dispatch takes no positional arguments"],
      [["status", "--driver", "fake", "qds-20260101-abcdef", "qds-20260101-abcdee"], "status takes at most one <run-id>"],
      [["teardown", "--driver", "fake", "qds-20260101-abcdef", "qds-20260101-abcdee"], "teardown takes exactly one <run-id>"],
      [["harvest", "--driver", "fake", "qds-20260101-abcdef", "qds-20260101-abcdee"], "harvest takes exactly one <run-id>"],
    ];
    for (const [argv, message] of cases) {
      reset();
      const code = await runCli(argv, deps(validBriefJson(dir)));
      expect({ argv, code }).toEqual({ argv, code: 2 });
      expect(text()).toContain(message);
      expect(readdirSync(runsDir)).toHaveLength(0);
    }
  });

  test("--help in a value position is the typo it is, not a help request", async () => {
    // Resolved from the PARSED bools, so a --help that a value flag swallowed
    // never reaches the help branch: `--dir --help` used to print usage and exit
    // 0, and a CI script doing `fleet teardown … || alert` recorded success
    // while the box stayed live.
    for (const argv of [
      ["dispatch", "--brief", "--help"],
      ["teardown", "--driver", "fake", "--dir", "--help", "qds-20260101-abcdef"],
    ]) {
      reset();
      const code = await runCli(argv, {});
      expect({ argv, code }).toEqual({ argv, code: 2 });
      expect(text()).toContain("requires a non-empty value");
      // Usage as a REMEDIATION inside the refusal envelope is fine; usage
      // printed to stdout is what a help request looks like, and this is not one.
      expect(outOnly).toHaveLength(0);
    }
    // An unknown verb with a genuine --help IS a help request: the help branch
    // runs before the registry lookup, so the operator who mistyped the verb
    // gets the verb list rather than a refusal that does not list them.
    reset();
    expect(await runCli(["not-a-verb", "--help"], {})).toBe(0);
    expect(outOnly.join("")).toBe(`${renderHelp(listVerbs())}\n`);
    expect(errCaptured).toHaveLength(0);
  });

  // ─── --driver is required on every verb (no silent fake) ───────────────────

  test("every verb refuses without --driver (exit 2), before reading a brief or a record", async () => {
    for (const argv of [["dispatch"], ["status"], ["harvest", "qds-20260101-abcdef"], ["teardown", "qds-20260101-abcdef"]]) {
      reset();
      const code = await runCli(argv, {});
      expect({ argv, code }).toEqual({ argv, code: 2 });
      expect(text()).toContain(`${argv[0] as string} requires --driver <name>`);
      // Refused before provisioning: no default runs dir, no default boxes dir.
      // These are the paths the CLI itself would build — $QDS_RUNS_DIR and
      // $QDS_FAKE_BOXES_DIR are redirected into this case's tmpdir by
      // `beforeEach`. Without that redirection the CLI resolved both relative to
      // the process cwd (the repo), so moving `assertDriverChosen` after
      // `new RunRecordStore(...)` littered the repo and both lines still passed.
      expect(existsSync(join(dir, ".sandbox", "runs"))).toBeFalse();
      expect(existsSync(join(dir, ".sandbox", "fake-boxes"))).toBeFalse();
    }
  });

  test("an unknown --driver refuses — it never falls back to the fake driver", async () => {
    // The flag is inert in every test that injects `deps.driver`; this is the
    // one path where the CLI actually resolves it.
    const code = await runCli(["status", "--driver", "no-such-driver"], {});
    // 2, not 1: a driver name that is not in the registry is a permanent
    // operator error, and exit 1 is stamped `exitStatus: "transient"` — so
    // automation reading that field retried a typo forever. `asUsage` reclassifies
    // it while preserving resolveDriver's own message and remediation verbatim.
    expect(code).toBe(2);
    expect(text()).toContain("unknown provider driver: no-such-driver");
    expect(text()).toContain("registered:");
    expect(existsSync(join(dir, ".sandbox", "fake-boxes"))).toBeFalse();
    // Refusals are diagnostics: they belong on the err sink, never on the stdout
    // an operator pipes into jq.
    expect(errCaptured.join("")).toContain("unknown provider driver");
    expect(outOnly).toHaveLength(0);
  });

  // ─── malformed brief → exit 2, zero provisioning (INV-2) ───────────────────

  test("unknown brief field → exit 2 naming the field, zero records, zero boxes", async () => {
    const bad = JSON.stringify({ ...JSON.parse(validBriefJson(dir)), extraField: 1 });
    const code = await runCli(["dispatch", "--driver", "fake"], deps(bad));
    expect(code).toBe(2);
    expect(text()).toContain("extraField");
    expect(readdirSync(runsDir)).toHaveLength(0);
    expect(readdirSync(boxesDir)).toHaveLength(0);
  });

  test("brief over 64 KiB → exit 2 brief-too-large naming the cap", async () => {
    const big = validBriefJson(dir).replace("owner/repo", `owner/${"x".repeat(70_000)}`);
    expect(Buffer.byteLength(big, "utf8")).toBeGreaterThan(MAX_BRIEF_BYTES);
    const code = await runCli(["dispatch", "--driver", "fake"], deps(big));
    expect(code).toBe(2);
    expect(text()).toContain("brief-too-large");
    expect(text()).toContain(String(MAX_BRIEF_BYTES));
    expect(readdirSync(runsDir)).toHaveLength(0);
  });

  test("a brief of EXACTLY 64 KiB is accepted (the cap is the limit, not one byte below it)", async () => {
    // Only the reject side was tested, so a `>=`/`>` flip — or a cap quietly
    // lowered to 8 KiB — refused every real brief and still passed.
    const brief = validBriefJson(dir);
    const padded = brief + " ".repeat(MAX_BRIEF_BYTES - Buffer.byteLength(brief, "utf8"));
    expect(Buffer.byteLength(padded, "utf8")).toBe(MAX_BRIEF_BYTES);
    const code = await runCli(["dispatch", "--driver", "fake"], deps(padded));
    expect(text()).not.toContain("brief-too-large");
    expect(code).toBe(0);
  });

  test("the cap counts BYTES, not UTF-16 code units", async () => {
    // 40 000 two-byte characters: 80 000 bytes, but `.length` sees ~40 000 and
    // would wave the brief through.
    const big = validBriefJson(dir).replace("owner/repo", `owner/${"é".repeat(40_000)}`);
    expect(big.length).toBeLessThan(MAX_BRIEF_BYTES);
    expect(Buffer.byteLength(big, "utf8")).toBeGreaterThan(MAX_BRIEF_BYTES);
    const code = await runCli(["dispatch", "--driver", "fake"], deps(big));
    expect(code).toBe(2);
    expect(text()).toContain("brief-too-large");
    expect(readdirSync(runsDir)).toHaveLength(0);
  });

  test("--brief <path> over 64 KiB → exit 2 brief-too-large, never invalid-brief", async () => {
    // Path-sourced oversize is refused by readBrief's stat BEFORE any JSON
    // parse — the catch must re-emit the FleetError, not relabel it.
    const bigPath = join(dir, "big-brief.json");
    writeFileSync(bigPath, "x".repeat(MAX_BRIEF_BYTES + 1));
    const code = await runCli(["dispatch", "--driver", "fake", "--brief", bigPath], {});
    expect(code).toBe(2);
    expect(text()).toContain("brief-too-large");
    expect(text()).not.toContain("invalid-brief");
  });

  test("--brief /dev/zero is refused as not a regular file, never read unbounded", async () => {
    // A character device reports size 0: the cap would be vacuous and the read
    // would never end.
    const code = await runCli(["dispatch", "--driver", "fake", "--brief", "/dev/zero"], {});
    expect(code).toBe(2);
    expect(text()).toContain("brief-unreadable");
    expect(text()).toContain("not a regular file");
  });

  test("--brief <missing path> names the errno, not a JSON error", async () => {
    const code = await runCli(["dispatch", "--driver", "fake", "--brief", join(dir, "nope.json")], {});
    expect(code).toBe(2);
    expect(text()).toContain("brief-unreadable");
    expect(text()).toContain("ENOENT");
    expect(text()).not.toContain("invalid-brief");
  });

  test("invalid JSON brief → exit 2", async () => {
    const code = await runCli(["dispatch", "--driver", "fake"], deps("{not json"));
    expect(code).toBe(2);
    expect(text()).toContain("invalid-brief");
  });

  test("`yes | fleet dispatch` hits brief-too-large immediately instead of buffering to OOM", async () => {
    // The one path that must refuse AS IT STREAMS; an in-process test cannot
    // see it, because `deps.readBrief` replaces the stdin reader entirely.
    const proc = Bun.spawn(
      ["sh", "-c", `yes | bun ${JSON.stringify(join(import.meta.dir, "../../scripts/fleet.ts"))} dispatch --driver fake`],
      { cwd: dir, stdout: "pipe", stderr: "pipe" },
    );
    try {
      const [code, stdout, stderr] = await Promise.all([
        proc.exited,
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
      ]);
      expect(code).toBe(2);
      expect(stderr).toContain("brief-too-large");
      expect(stdout).toBe(""); // stdout carries output only
      // Refused before provisioning: nothing was created under the cwd.
      expect(existsSync(join(dir, ".sandbox", "runs"))).toBeFalse();
    } finally {
      proc.kill("SIGKILL");
      await proc.exited;
    }
  });

  // ─── --port grammar and the ack's httpsUrl ─────────────────────────────────

  test("--port must be a TCP port → exit 2, nothing provisioned", async () => {
    // The last four are Number()'s own vocabulary, not the operator's: `0x1f4`,
    // `1e3`, `" 8080 "` and `08080` are each an integer in 1-65535 by the time
    // Number() is done with them, and none is the port that was typed. The
    // `/^[1-9]\d{0,4}$/` pre-check is what refuses them.
    for (const bad of ["abc", "0", "65536", "8080.5", "-1", "0x1f4", "1e3", " 8080 ", "08080"]) {
      reset();
      const code = await runCli(["dispatch", "--driver", "fake", "--port", bad], deps(validBriefJson(dir)));
      expect({ bad, code }).toEqual({ bad, code: 2 });
      expect(text()).toContain("is not a TCP port");
      expect(readdirSync(runsDir)).toHaveLength(0);
      expect(readdirSync(boxesDir)).toHaveLength(0);
    }
    // An empty value is refused by the flag parser, one step earlier — same
    // exit, different (and more accurate) message.
    reset();
    expect(await runCli(["dispatch", "--driver", "fake", "--port", ""], deps(validBriefJson(dir)))).toBe(2);
    expect(text()).toContain("--port requires a non-empty value");
  });

  test("both ends of the port range are ACCEPTED (1 and 65535 are legal ports)", async () => {
    // Only the reject side was covered, so tightening the guard to `<= 1 ||
    // >= 65_535` refused two legal ports with nothing failing — the mirror of
    // the exact-limit accept case the 64 KiB cap already has.
    for (const port of ["1", "65535"]) {
      reset();
      const shared = deps(validBriefJson(dir));
      const code = await runCli(["dispatch", "--driver", "fake", "--port", port], shared);
      expect({ port, code }).toEqual({ port, code: 0 });
      const ack = JSON.parse(outOnly.find((l) => l.includes("runId")) as string) as { vmName: string; httpsUrl?: string };
      expect(ack.httpsUrl).toBe(`https://${ack.vmName}-${port}.fake.local`);
    }
  });

  test("--port <n> exposes the box and the ack carries its httpsUrl", async () => {
    const shared = deps(validBriefJson(dir));
    const code = await runCli(["dispatch", "--driver", "fake", "--port", "8080"], shared);
    expect(code).toBe(0);
    const ack = JSON.parse(captured.find((l) => l.includes("runId")) as string) as {
      runId: string;
      vmName: string;
      httpsUrl?: string;
    };
    expect(ack.httpsUrl).toBe(`https://${ack.vmName}-8080.fake.local`);
    // The exposure is on the record too — `fleet status` is the only surface an
    // operator has for it.
    const record = (shared.store as RunRecordStore).get(ack.runId);
    expect(record.httpsUrl).toBe(ack.httpsUrl);
    expect(record.ports).toEqual([8080]);
  });

  // ─── the exit-code table (F3): 3 gate, 4 not-found, 5 refused ──────────────

  test("setup-gate failure → exit 3 with the assertion code, box ALIVE and record OPEN (INV-5)", async () => {
    const base = new FakeDriver(boxesDir);
    const shared: Partial<FleetDeps> = {
      ...deps(validBriefJson(dir)),
      // Item A of the gate is `exec true`; failing it fails the gate without
      // touching the mint, the delivery or the fill.
      driver: driverWith(base, {
        exec: async (vm: string, argv: string[], stdin?: string) =>
          argv[0] === "true"
            ? { exitCode: 1, stdout: "", stderr: "box unreachable" }
            : base.exec(vm, argv, stdin),
      }),
    };
    const code = await runCli(["dispatch", "--driver", "fake"], shared);
    expect(code).toBe(3);
    const envelope = JSON.parse(captured.find((l) => l.includes("setup-gate-failed")) as string) as {
      code: string;
      assertionCode: number;
      failedItem: string;
      runId: string;
      vmName: string;
      teardownCommand: string;
    };
    expect(envelope.code).toBe("setup-gate-failed");
    expect(envelope.failedItem).toBe("A");
    expect(envelope.assertionCode).toBe(1);
    expect(envelope.teardownCommand).toContain(envelope.runId);
    // INV-5: the evidence survives the refusal.
    expect((await base.list()).map((vm) => vm.name)).toContain(envelope.vmName);
    expect((shared.store as RunRecordStore).get(envelope.runId).closedAt).toBeUndefined();
  });

  test("an over-budget issue → exit 5 refused BEFORE provisioning (AC7)", async () => {
    // The RECORDING ledger from ./helpers.ts, not a local look-alike: the real
    // one owns a SQLite handle, and a refusal that returns without closing it
    // leaks one per invocation — invisible to every assertion below.
    const ledger = overBudgetLedger();
    const shared: Partial<FleetDeps> = { ...deps(validBriefJson(dir)), ledgerFactory: () => ledger };
    const code = await runCli(["dispatch", "--driver", "fake"], shared);
    expect(code).toBe(5);
    expect(ledger.admitCalls).toHaveLength(1);
    expect(ledger.closeCalls).toBe(1);
    const envelope = JSON.parse(captured.find((l) => l.includes("budget-exceeded")) as string) as {
      code: string;
      capMicroUsd: number;
      spentMicroUsd: number;
    };
    expect(envelope.code).toBe("budget-exceeded");
    expect(envelope.capMicroUsd).toBe(10_000_000);
    expect(envelope.spentMicroUsd).toBe(12_000_000);
    expect(readdirSync(runsDir)).toHaveLength(0);
    expect(readdirSync(boxesDir)).toHaveLength(0);
  });

  // ─── the run-id grammar: exit 2 before any path is built ───────────────────

  test("a run id that fails the grammar is refused with invalid-run-id, on every verb that takes one", async () => {
    // `assertFleetRunId` is the single fleet-side enforcement point (its own
    // docstring says so) and the ONLY thing between an operator-supplied
    // positional and `<store.dir>/<runId>.json` / `.lock`. Every other id in
    // this file is well-formed and reaches the store as exit 4, so deleting
    // either call site left the suite green while `fleet teardown ../../secrets`
    // became a path-traversal read and unlink.
    const badIds = ["../evil", "a/b", "", "Q".repeat(300), "qds-x/../y", "qds-20260101-ABCDEF"];
    for (const verb of ["status", "harvest", "teardown"]) {
      for (const runId of badIds) {
        reset();
        const code = await runCli([verb, "--driver", "fake", "--dir", runsDir, runId], deps(validBriefJson(dir)));
        expect({ verb, runId, code }).toEqual({ verb, runId, code: 2 });
        const envelope = JSON.parse(errCaptured[0] as string) as { code: string; message: string };
        expect(envelope.code).toBe("invalid-run-id");
        expect(envelope.message).toContain(JSON.stringify(runId));
        // Refused before the store, the lock and the driver: nothing on disk.
        expect(readdirSync(runsDir)).toHaveLength(0);
        expect(existsSync(join(dir, "evil"))).toBeFalse();
      }
    }
  });

  // ─── status unknown run → exit 4, mutates nothing (AC4) ────────────────────

  test("status <unknown-runId> → exit 4 run-not-found, driver consulted but nothing mutated", async () => {
    const driver = new FakeDriver(boxesDir);
    // Bind BEFORE overwriting: reading driver.list inside the mock after the
    // reassignment would recurse into the mock itself.
    const originalList = driver.list.bind(driver);
    const listSpy = mock(() => originalList());
    driver.list = listSpy;
    const d = deps(validBriefJson(dir));
    (d as { driver?: FakeDriver }).driver = driver;
    const code = await runCli(["status", "qds-19990101-000000"], d);
    expect(code).toBe(4);
    expect(text()).toContain("run-not-found");
    // A missing record is NOT proof the box is gone (statusAll would call the
    // same box `orphan`), so statusRun probes the driver before refusing —
    // exactly once, and only then does exit 4 mean "no record AND no box".
    expect(listSpy).toHaveBeenCalledTimes(1);
    expect(readdirSync(runsDir)).toHaveLength(0);
  });

  test("status on a live box whose record is gone → exit 0 orphan, never exit 4", async () => {
    // The other half of the probe above, and the reason it exists: record and
    // box are separately losable. Exiting 4 here denies the existence of a box
    // that is alive and spending — the one query an operator types when they
    // already know the run id.
    const shared = deps(validBriefJson(dir));
    expect(await runCli(["dispatch", "--driver", "fake"], shared)).toBe(0);
    const { runId, vmName } = JSON.parse(captured.find((l) => l.includes("runId")) as string) as {
      runId: string;
      vmName: string;
    };
    rmSync(join(runsDir, `${runId}.json`));

    reset();
    expect(await runCli(["status", "--driver", "fake", runId], shared)).toBe(0);
    const row = JSON.parse(captured[0] as string) as { runId: string; state: string; vmName: string };
    expect(row).toMatchObject({ runId, state: "orphan", vmName });
  });

  test("teardown <unknown-runId> → exit 4 run-not-found, refused BEFORE the lock", async () => {
    // The records directory is removed after the store is built, which makes
    // the ORDERING visible instead of merely plausible. A post-hoc "no .lock
    // file remains" scan cannot tell the two orders apart: it is satisfied by
    // the probe-then-lock order the source comment mandates AND by the
    // lock-discover-release order it exists to forbid — the one that strands a
    // phantom `<runId>.lock` for a run that never existed when a crash lands in
    // between. With the directory gone, `store.get` is still ENOENT → exit 4,
    // but `acquireRunLock` cannot create its temp there: a lock-first order
    // throws ENOENT out of `claim` and reports a retryable exit 1.
    const gone = join(dir, "vanished-runs");
    const shared: Partial<FleetDeps> = { ...deps(validBriefJson(dir)), store: new RunRecordStore(gone) };
    rmSync(gone, { recursive: true, force: true });

    const code = await runCli(["teardown", "--driver", "fake", "qds-19990101-000000"], shared);
    expect(code).toBe(4);
    const envelope = JSON.parse(errCaptured[0] as string) as { code: string };
    expect(envelope.code).toBe("run-not-found");
    // Nothing was created for a run that does not exist: not the directory, not
    // a lock, not a temp.
    expect(existsSync(gone)).toBeFalse();
  });

  // ─── harvest: the fourth verb, and the only credential-free one (D8) ───────

  test("e2e: dispatch → harvest → teardown, with harvest taking and releasing the run lock", async () => {
    // `harvest` had no functional test at all: it appeared only in the verb
    // list, the bare-verb exit table and the --driver loop. Inverting the
    // `outcome === "harvested"` ternary, printing the wrong count, or dropping
    // the lock release all shipped green.
    const shared = deps(validBriefJson(dir));
    expect(await runCli(["dispatch", "--driver", "fake"], shared)).toBe(0);
    const { runId } = JSON.parse(captured.find((l) => l.includes("runId")) as string) as { runId: string };

    reset();
    const code = await runCli(["harvest", "--driver", "fake", "--dir", runsDir, runId], {
      ...shared,
      // D8: harvest builds no keyApi. `deps.keyApi` is deliberately consulted
      // only by teardown, so a harvest that starts reaching for credentials —
      // openRouterKeyApi() included — must fail loudly rather than quietly grow
      // a provisioning-key requirement the verb does not have.
      keyApi: keyApiTripwire(),
    });

    expect(code).toBe(0);
    // The fake box holds no git repo, so the bundle protocol answers NOREPO and
    // the outcome is the "none" arm. Pinned exactly: a count printed through the
    // wrong arm reads `harvested: undefined`.
    expect(outOnly.join("")).toBe("harvested: none\n");
    expect(errCaptured).toHaveLength(0);
    // The same per-run lock the teardown cases prove, released on the way out —
    // a harvest that leaks it locks the run against its own teardown.
    expect(existsSync(join(runsDir, `${runId}.lock`))).toBeFalse();
    // Harvest is non-destructive: the record stays open and the box stays alive,
    // which is what makes the teardown below the proof that harvest left the run
    // operable rather than merely quiet.
    expect((shared.store as RunRecordStore).get(runId).closedAt).toBeUndefined();

    reset();
    expect(await runCli(["teardown", "--driver", "fake", "--dir", runsDir, runId], shared)).toBe(0);
    expect(text()).toContain(`torn down: ${runId}`);
  });

  // ─── the shared per-run lock (scripts/lib/run-lock.ts) on the teardown verb ─

  test("teardown takes the shared run lock: a held lock refuses and mutates nothing", async () => {
    const shared = deps(validBriefJson(dir));
    const store = shared.store as RunRecordStore;
    const driver = shared.driver as FakeDriver;
    const dispatchCode = await runCli(["dispatch", "--driver", "fake"], shared);
    expect(dispatchCode).toBe(0);
    const { runId, vmName } = JSON.parse(captured.find((l) => l.includes("runId")) as string) as {
      runId: string;
      vmName: string;
    };

    // A concurrent teardown's lock. If `fleet teardown` stopped acquiring it,
    // two invocations would double-destroy the box and double-write the spend.
    const lock = join(runsDir, `${runId}.lock`);
    const holder = process.pid + 1;
    writeFileSync(lock, `${holder} ${new Date(Date.now() - 4_000).toISOString()} feedface\n`, { flag: "wx" });

    reset();
    const code = await runCli(["teardown", "--driver", "fake", "--dir", runsDir, runId], shared);

    // 5 ("refused before provisioning"), NOT 1. Exit 1 is `exitStatus:
    // "transient"` — "retry me" — and the STALE case below proves why that is
    // wrong: nothing will ever clear a dead holder's lock, so automation
    // retries forever. The refusal is thrown between the record probe and any
    // mutation, which is exactly what 5 means.
    expect(code).toBe(5);
    expect(text()).toContain("run-locked");
    // fleet's holder wording: `acquireRunLock`'s default is the bare
    // "invocation", and the CLI passes "fleet invocation" so the refusal names
    // WHICH tool holds the run — `sandbox-teardown` takes the same lock.
    expect(text()).toContain("another fleet invocation holds");
    expect(text()).toContain(`pid ${holder}`);
    // The refused invocation neither tore down nor stole the holder's lock.
    expect(readFileSync(lock, "utf8")).toContain("feedface");
    expect(store.get(runId).closedAt).toBeUndefined();
    expect((await driver.list()).map((vm) => vm.name)).toContain(vmName);
    rmSync(lock);
  });

  test("a STALE lock refuses with the same non-retryable code as a live holder", async () => {
    // The case that makes exit 1 indefensible for a lock refusal: the holder is
    // gone, so NOTHING will ever release this lock — `refuse()` knows it (the
    // remediation prints the `rm` that clears it). Exit 1 is stamped
    // `transient`, so automation reading `exitStatus` retried a lock that can
    // only ever answer `run-locked`, forever.
    const shared = deps(validBriefJson(dir));
    expect(await runCli(["dispatch", "--driver", "fake"], shared)).toBe(0);
    const { runId } = JSON.parse(captured.find((l) => l.includes("runId")) as string) as { runId: string };

    // A pid above every platform's pid_max, so `kill(pid, 0)` is ESRCH and the
    // lock reads stale rather than merely foreign. Pre-host body layout (the
    // one run-lock.ts still parses), because a foreign HOST is deliberately
    // never marked stale.
    const lock = join(runsDir, `${runId}.lock`);
    writeFileSync(lock, `9999999 ${new Date(Date.now() - 90_000).toISOString()} deadbeef\n`, { flag: "wx" });

    reset();
    const code = await runCli(["teardown", "--driver", "fake", "--dir", runsDir, runId], shared);

    expect(code).toBe(5);
    const envelope = JSON.parse(errCaptured.find((l) => l.includes("run-locked")) as string) as {
      code: string;
      remediation: string;
    };
    expect(envelope.code).toBe("run-locked");
    // The operator's only way out, and the reason a retry is futile.
    expect(envelope.remediation).toContain("stale lock");
    expect(envelope.remediation).toContain(`rm ${lock}`);
    // Refused before any mutation: the holder's file is intact and the run is
    // untouched.
    expect(readFileSync(lock, "utf8")).toContain("deadbeef");
    expect((shared.store as RunRecordStore).get(runId).closedAt).toBeUndefined();
    rmSync(lock);
  });

  test("harvest takes the SAME lock: a held lock refuses it, and nothing is harvested", async () => {
    // The e2e above asserts only that no lock file remains AFTER a harvest —
    // which a harvest that never acquired one satisfies identically, and the
    // only `run-locked` case in this file was teardown's. `acquireRunLock` sits
    // ABOVE the `if (verb === "harvest")` split while every other
    // teardown-only dependency (keyApi, CostLedger) already lives in the `else`
    // arm, so "harvest is read-only, why lock it" is a one-line refactor that
    // ships green — and then `fleet harvest` runs concurrently with a teardown
    // destroying the box mid-bundle. This is the case that fails when it does.
    const shared = deps(validBriefJson(dir));
    expect(await runCli(["dispatch", "--driver", "fake"], shared)).toBe(0);
    const { runId } = JSON.parse(captured.find((l) => l.includes("runId")) as string) as { runId: string };

    const lock = join(runsDir, `${runId}.lock`);
    const holder = process.pid + 1;
    writeFileSync(lock, `${holder} ${new Date(Date.now() - 4_000).toISOString()} feedface\n`, { flag: "wx" });

    reset();
    const code = await runCli(["harvest", "--driver", "fake", "--dir", runsDir, runId], {
      ...shared,
      // D8 still holds on the refusal path: a harvest refused at the lock must
      // not have reached for credentials on its way there either.
      keyApi: keyApiTripwire(),
    });

    // 5, the same non-retryable refusal teardown gives — not a 0 with
    // "harvested: none", which is what a lockless harvest of this box prints.
    expect(code).toBe(5);
    expect(text()).toContain("run-locked");
    expect(text()).toContain("another fleet invocation holds");
    expect(text()).toContain(`pid ${holder}`);
    // Nothing on stdout at all: a refusal is a diagnostic, and `harvested:`
    // would be a claim about a bundle this invocation never fetched.
    expect(outOnly).toHaveLength(0);
    // The holder's claim is intact — a refused invocation never steals it.
    expect(readFileSync(lock, "utf8")).toContain("feedface");
    expect((shared.store as RunRecordStore).get(runId).closedAt).toBeUndefined();
    rmSync(lock);
  });

  test("a lock that vanishes between the claim and the read refuses terminally, and does not spin", async () => {
    // `acquireRunLock`'s two-attempt loop had no coverage anywhere in the repo:
    // every held lock in this file is a plain file this process wrote, so
    // `refuse()` always answers on attempt 0 and the retry path is never
    // entered. A DANGLING SYMLINK at the lock path is that window made
    // deterministic — `link(2)`/`O_EXCL` see the entry and answer EEXIST (so
    // `claim` returns false), while `readFileSync` follows it and answers
    // ENOENT (so `refuse` returns undefined: "the holder finished, try again").
    //
    // Two mutations die here. Making the loop `while (true)` hangs the CLI, so
    // this test never returns. Dropping `refuse`'s ENOENT → undefined branch
    // turns a benign hand-off into `holder unknown, lock body ""` plus a
    // remediation telling the operator to rm a path with nothing behind it.
    //
    // ponytail: it cannot distinguish two attempts from one — both exhaust the
    // loop against a lock that never becomes claimable. The attempt that
    // SUCCEEDS after a refusal needs the entry to disappear between two
    // synchronous fs calls in one process, which no fs primitive affords.
    const shared = deps(validBriefJson(dir));
    expect(await runCli(["dispatch", "--driver", "fake"], shared)).toBe(0);
    const { runId } = JSON.parse(captured.find((l) => l.includes("runId")) as string) as { runId: string };

    const lock = join(runsDir, `${runId}.lock`);
    symlinkSync(join(dir, "no-such-lock-target"), lock);

    reset();
    const code = await runCli(["teardown", "--driver", "fake", "--dir", runsDir, runId], shared);

    expect(code).toBe(5);
    const envelope = JSON.parse(errCaptured.find((l) => l.includes("run-locked")) as string) as {
      code: string;
      message: string;
    };
    expect(envelope.code).toBe("run-locked");
    expect(envelope.message).toContain("the lock is being taken and released repeatedly");
    // NOT the fail-closed wording: an empty body is what a reader sees mid-write,
    // and this lock was never written by anyone.
    expect(envelope.message).not.toContain("holder unknown");
    // Refused before any mutation, and the entry at the lock path is untouched:
    // the CLI released nothing it never held.
    expect(lstatSync(lock).isSymbolicLink()).toBeTrue();
    expect((shared.store as RunRecordStore).get(runId).closedAt).toBeUndefined();
    rmSync(lock);
  });

  test("teardown releases the run lock when the teardown itself fails", async () => {
    const base = new FakeDriver(boxesDir);
    const shared: Partial<FleetDeps> = { ...deps(validBriefJson(dir)), driver: base };
    const store = shared.store as RunRecordStore;
    expect(await runCli(["dispatch", "--driver", "fake"], shared)).toBe(0);
    const { runId, vmName } = JSON.parse(captured.find((l) => l.includes("runId")) as string) as {
      runId: string;
      vmName: string;
    };

    reset();
    const code = await runCli(["teardown", "--driver", "fake", "--dir", runsDir, runId], {
      ...shared,
      driver: driverWith(base, {
        destroy: async () => {
          throw new Error("substrate refused the destroy");
        },
      }),
    });

    expect(code).toBe(1);
    expect(text()).toContain("destroy-unconfirmed");
    // A lock left on disk here makes the run permanently un-teardownable while
    // its box keeps billing.
    expect(existsSync(join(runsDir, `${runId}.lock`))).toBeFalse();
    expect(store.get(runId).closedAt).toBeUndefined();
    expect((await base.list()).map((vm) => vm.name)).toContain(vmName);
  });

  test("a teardown that succeeds but cannot release its lock exits 6, not 0", async () => {
    // The `finally`'s downgrade — the whole reason `code` is a mutable `let`
    // rather than an early `return 0`. Without it `fleet teardown` exits 0 on a
    // run that is now permanently un-teardownable: the lock outlives the
    // invocation, so every later harvest/teardown of that id refuses forever.
    const base = new FakeDriver(boxesDir);
    const shared: Partial<FleetDeps> = { ...deps(validBriefJson(dir)), driver: base };
    expect(await runCli(["dispatch", "--driver", "fake"], shared)).toBe(0);
    const { runId } = JSON.parse(captured.find((l) => l.includes("runId")) as string) as { runId: string };
    const lock = join(runsDir, `${runId}.lock`);

    reset();
    const code = await runCli(["teardown", "--driver", "fake", "--dir", runsDir, "--no-harvest", runId], {
      ...shared,
      // The teardown itself must SUCCEED — the release is what fails. Rewriting
      // the lock body after the destroy is the cheapest true failure:
      // releaseRunLock proves the body is still its own claim before unlinking,
      // and a foreign body is exactly the one it must refuse to delete.
      driver: driverWith(base, {
        destroy: async (vm: string) => {
          await base.destroy(vm);
          writeFileSync(lock, "99999 someone-else 2026-01-01T00:00:00.000Z deadbeef\n");
        },
      }),
    });

    expect(code).toBe(6);
    // The work DID happen — 6 says "done, but cleanup is wedged", which is why
    // it is not 1: exit 1 is `exitStatus: "transient"`, and retrying a wedged
    // lock only re-hits `run-locked` forever.
    expect(outOnly.join("")).toContain(`torn down: ${runId}`);
    expect((await base.list()).map((vm) => vm.name)).not.toContain(runId);
    const envelope = JSON.parse(errCaptured.find((l) => l.includes("lock-release-failed")) as string) as {
      code: string;
      remediation: string;
    };
    expect(envelope.code).toBe("lock-release-failed");
    // The remediation is the operator's only way out, so it must name the exact rm.
    expect(envelope.remediation).toContain(`rm ${lock}`);
    // 6 is declared for the verb, so `fleet --help` tells the operator what it means.
    expect(listVerbs().find((v) => v.verb === "teardown")?.exitCodes).toContain(6);
    // The lock really is still on disk: that wedge IS what the exit code reports.
    expect(existsSync(lock)).toBeTrue();
  });

  // ─── --dir moves the whole .sandbox set, ledger included ───────────────────

  test("--dir scopes the cost ledger to the records dir, never the ambient cwd", async () => {
    // No chdir anywhere in this case — that IS the property. Both halves of the
    // run's money must land beside the records the operator named: the ledger
    // read from the cwd meant a run reserved its budget in one file at dispatch
    // and settled its box hours in another at teardown.
    const sandbox = join(dir, "sbx");
    const runs = join(sandbox, "runs");
    mkdirSync(sandbox, { recursive: true });
    // The box-hour rate lives ONLY here. The repo cwd has no cost-config.json,
    // so a cwd-resolved config falls back to the built-in defaults, which carry
    // no rate — and the teardown's box-hours ingest would refuse rather than
    // price at 0. The exit 0 below is what proves the config followed --dir too.
    writeFileSync(join(sandbox, "cost-config.json"), '{"boxHourRateMicroUsd": 3600000}');
    // The manifest lives in the case's own tmpdir, resolved against an INJECTED
    // containment root. It used to be a committed repo path with `repoRoot`
    // deliberately omitted, which made this the one case whose INV-1 resolution
    // ran against `process.cwd()`: any test in the run that chdir'd turned it
    // into `manifest-rejected` exit 2, and the only guard was a bare toBe(0).
    // `repoRoot` is not the subject here — the money is — so the dependency is
    // removed rather than documented.
    const brief = validBriefJson(dir);
    const shared: Partial<FleetDeps> = {
      driver: new FakeDriver(boxesDir),
      keyApi: new FakeKeyApi(),
      readBrief: async () => brief,
      repoRoot: dir,
      // store and ledgerFactory are deliberately NOT injected: --dir has to
      // build both, and injecting either would hide the thing under test.
    };
    // A SENTINEL at the ambient path, not a `existsSync(...) ? mtime : null`
    // read of it: that form compared `null` to `null` on any machine without a
    // pre-existing ledger — i.e. on every clean checkout and in CI, exactly
    // where the regression is supposed to be caught. The ambient path is where
    // `$QDS_RUNS_DIR`'s parent puts it (beforeEach redirects that into this
    // case's tmpdir), so an implementation that ignored --dir would open THIS
    // file, and opening it as a SQLite db is a write.
    const ambientLedger = join(dir, ".sandbox", "cost-ledger.db");
    const sentinel = "not-a-sqlite-file — the --dir ledger must never be this one\n";
    writeFileSync(ambientLedger, sentinel);

    expect(await runCli(["dispatch", "--driver", "fake", "--dir", runs], shared)).toBe(0);
    const { runId } = JSON.parse(captured.find((l) => l.includes("runId")) as string) as { runId: string };
    expect(existsSync(join(sandbox, "cost-ledger.db"))).toBeTrue();
    expect(existsSync(join(runs, `${runId}.json`))).toBeTrue();

    reset();
    expect(await runCli(["teardown", "--driver", "fake", "--dir", runs, runId], shared)).toBe(0);
    expect(text()).toContain(`torn down: ${runId}`);
    // Box hours priced into the --dir ledger, and the ambient one untouched —
    // byte for byte, and with no -wal/-shm beside it, which is what a SQLite
    // handle opened on it would have left.
    expect(existsSync(join(sandbox, "cost-ledger.db"))).toBeTrue();
    expect(readFileSync(ambientLedger, "utf8")).toBe(sentinel);
    expect(readdirSync(join(dir, ".sandbox")).filter((f) => f.startsWith("cost-ledger.db"))).toEqual([
      "cost-ledger.db",
    ]);
  });

  test("sandbox-teardown settles into the SAME ledger fleet dispatch reserved from", async () => {
    // The two CLIs share a run: `fleet dispatch --dir X` reserves budget and
    // `sandbox-teardown --dir X` settles the box hours. sandbox-teardown built
    // its CostLedger with NO path at all, so it fell back to the cwd-relative
    // `.sandbox/cost-ledger.db` while the reservation sat beside X — and that
    // reservation then stays open forever, counting against the budget cap, in
    // a file nothing settles. Both now resolve through
    // scripts/lib/cost-ledger-opts.ts.
    const sandbox = join(dir, "shared-money");
    const runs = join(sandbox, "runs");
    mkdirSync(sandbox, { recursive: true });
    // Box hours are only priced when the CONFIG resolves beside the records
    // too, so this file is also the proof the second half of the pair followed.
    writeFileSync(join(sandbox, "cost-config.json"), '{"boxHourRateMicroUsd": 3600000}');
    // Manifest in the case's tmpdir against an injected `repoRoot` (see the
    // --dir case above): a committed repo path here resolved INV-1 against
    // `process.cwd()`, so any chdir elsewhere in the run turned this money
    // regression test into a `manifest-rejected` exit 2 behind a bare toBe(0).
    const brief = validBriefJson(dir);
    // NEITHER driver nor store nor ledger injected: both CLIs must resolve the
    // fake boxes (via $QDS_FAKE_BOXES_DIR) and the money from --dir themselves,
    // which is the whole subject.
    const ambientLedger = join(dir, ".sandbox", "cost-ledger.db");
    const sentinel = "not-a-sqlite-file — neither CLI may settle into this one\n";
    writeFileSync(ambientLedger, sentinel);

    expect(
      await runCli(["dispatch", "--driver", "fake", "--dir", runs], {
        keyApi: new FakeKeyApi(),
        readBrief: async () => brief,
        repoRoot: dir,
      }),
    ).toBe(0);
    const { runId } = JSON.parse(captured.find((l) => l.includes("runId")) as string) as { runId: string };
    const ledgerPath = join(sandbox, "cost-ledger.db");
    expect(existsSync(ledgerPath)).toBeTrue();

    // Make the run KEYLESS before the second CLI touches it. `sandboxTeardownRun`
    // takes no deps seam, so a record carrying a `keyHash` makes it build a real
    // `openRouterKeyApi()` — which reads $OPENROUTER_PROVISIONING_KEY and, when
    // one is present, revokes over the network. That is a second silent ambient
    // dependency behind this case's bare `toBe(0)`: with the repo's own `.env`
    // loaded it passed, and from any other cwd the same money assertions failed
    // as `provisioning-key-missing`. The credential path is not what this case
    // is about — where the box hours LAND is — so it is removed rather than
    // depended on. Written through the file because `set()` skips `undefined`
    // and there is no other way to drop the field.
    const recordPath = join(runs, `${runId}.json`);
    const { keyHash: _dropped, ...keyless } = JSON.parse(readFileSync(recordPath, "utf8")) as Record<string, unknown>;
    expect(_dropped).toBeString(); // the field really was there to drop
    writeFileSync(recordPath, JSON.stringify(keyless), { mode: 0o600 });

    reset();
    // DF2.5's own CLI, not fleet's teardown verb — the one that was settling
    // somewhere else.
    expect(await sandboxTeardownRun([runId, "--dir", runs, "--driver", "fake"], out)).toBe(0);
    expect(outOnly.join("")).toContain(`torn down: ${runId}`);

    // The box hours are IN the --dir ledger, under this run…
    const db = new Database(ledgerPath, { readonly: true });
    try {
      const rows = db.query("SELECT kind FROM cost_events WHERE run_id = ?").all(runId) as { kind: string }[];
      expect(rows.map((r) => r.kind)).toContain("box_hours");
    } finally {
      db.close();
    }
    // …and the cwd-relative default was never opened: byte-identical, with no
    // -wal/-shm beside it, which a SQLite handle on it would have left.
    expect(readFileSync(ambientLedger, "utf8")).toBe(sentinel);
    expect(readdirSync(join(dir, ".sandbox")).filter((f) => f.startsWith("cost-ledger.db"))).toEqual([
      "cost-ledger.db",
    ]);
  });

  test("a second teardown of the same run exits 0 and bills its box hours exactly once", async () => {
    // `teardownSandbox` short-circuits a CLOSED record (first-close-wins) and
    // re-runs the box-hours ingest, so `fleet teardown <id>` on an
    // already-torn-down run skips every step, prints `torn down: <id>` and
    // exits 0 — telling an operator it just destroyed a box that has been gone
    // for hours. No case invoked teardown twice on one id, so nothing pinned
    // either half of that: not the exit code, and not the claim that makes it
    // defensible. The ingest re-run is DF2.8's crash-window fix (close landed,
    // the process died before the row did), and it is idempotent by event id —
    // without that idempotence a re-run bills the same hours again, against the
    // budget cap, and only a REAL ledger can show it. So no `ledgerFactory` and
    // no `store` here: both are the CLI's own, beside the records.
    const sandbox = join(dir, "twice");
    const runs = join(sandbox, "runs");
    mkdirSync(sandbox, { recursive: true });
    writeFileSync(join(sandbox, "cost-config.json"), '{"boxHourRateMicroUsd": 3600000}');
    const brief = validBriefJson(dir);
    const shared: Partial<FleetDeps> = {
      driver: new FakeDriver(boxesDir),
      keyApi: new FakeKeyApi(),
      readBrief: async () => brief,
      repoRoot: dir,
    };

    expect(await runCli(["dispatch", "--driver", "fake", "--dir", runs], shared)).toBe(0);
    const { runId } = JSON.parse(captured.find((l) => l.includes("runId")) as string) as { runId: string };

    reset();
    expect(await runCli(["teardown", "--driver", "fake", "--dir", runs, runId], shared)).toBe(0);
    const store = new RunRecordStore(runs);
    const closedAt = store.get(runId).closedAt as string;
    expect(closedAt).toBeDefined();

    reset();
    expect(await runCli(["teardown", "--driver", "fake", "--dir", runs, runId], shared)).toBe(0);
    expect(outOnly.join("")).toContain(`torn down: ${runId}`);
    // first-close-wins: the record still reports the FIRST teardown's instant,
    // so the second pass re-closed nothing.
    expect(store.get(runId).closedAt).toBe(closedAt);
    // …and the money was settled once, not twice.
    const db = new Database(join(sandbox, "cost-ledger.db"), { readonly: true });
    try {
      const rows = db.query("SELECT event_id FROM cost_events WHERE run_id = ? AND kind = 'box_hours'").all(runId);
      expect(rows).toHaveLength(1);
    } finally {
      db.close();
    }
    // The second invocation took the lock like any other and gave it back.
    expect(existsSync(join(runs, `${runId}.lock`))).toBeFalse();
  });

  test("--dir reaches the status verb too, not just dispatch and teardown", async () => {
    // Every other status case injects `deps.store`, so the CLI never resolved
    // --dir for this verb: `fleet status --dir /elsewhere` could regress to
    // listing the default runs dir and report "no runs" for a live fleet.
    const shared = deps(validBriefJson(dir));
    expect(await runCli(["dispatch", "--driver", "fake", "--dir", runsDir], shared)).toBe(0);
    const { runId } = JSON.parse(captured.find((l) => l.includes("runId")) as string) as { runId: string };

    // Driver injected (the fake boxes live in this case's tmpdir); store NOT —
    // that is the thing under test.
    const { store: _omitted, ...noStore } = shared;
    reset();
    expect(await runCli(["status", "--driver", "fake", "--dir", runsDir], noStore)).toBe(0);
    expect(JSON.parse(outOnly[0] as string)).toMatchObject({ runId, state: "live" });

    // …and pointed elsewhere the SAME box has no record to claim it, so it
    // reports as unattributed spend. A --dir the status verb silently ignored
    // would still find the record and call it `live`.
    reset();
    expect(await runCli(["status", "--driver", "fake", "--dir", join(dir, "other-runs")], noStore)).toBe(0);
    expect(JSON.parse(outOnly[0] as string)).toMatchObject({ runId, state: "orphan" });
  });

  test("a completed teardown still exits 0 when stdout is a closed pipe", async () => {
    // `fleet teardown <id> | head -1` closes the pipe as soon as head has its
    // line, and the success message then throws EPIPE. That throw landed in the
    // verb's catch as exit 1 = `transient`, so automation RETRIED a destructive
    // verb that had already destroyed the box and closed the record.
    const base = new FakeDriver(boxesDir);
    const shared: Partial<FleetDeps> = { ...deps(validBriefJson(dir)), driver: base };
    expect(await runCli(["dispatch", "--driver", "fake"], shared)).toBe(0);
    const { runId, vmName } = JSON.parse(captured.find((l) => l.includes("runId")) as string) as {
      runId: string;
      vmName: string;
    };

    reset();
    const closedPipe = (): never => {
      const e = new Error("write EPIPE") as NodeJS.ErrnoException;
      e.code = "EPIPE";
      throw e;
    };
    const code = await run(["teardown", "--driver", "fake", "--dir", runsDir, runId], closedPipe, shared, errOut);

    expect(code).toBe(0);
    // The work really happened — that is why reporting a failure was so wrong.
    expect((await base.list()).map((vm) => vm.name)).not.toContain(vmName);
    expect((shared.store as RunRecordStore).get(runId).closedAt).toBeDefined();
    // And the lock still came off: the finally runs on this path too.
    expect(existsSync(join(runsDir, `${runId}.lock`))).toBeFalse();
  });

  test("status still exits 0 when stdout is a closed pipe", async () => {
    // The other verb an operator pipes: `fleet status | head -1` closes the pipe
    // after the first row, and every later row's write throws EPIPE. Reported as
    // the verb's outcome it makes a read-only query indistinguishable from a
    // substrate failure — the exit code `status` reserves for "the provider
    // could not be listed", which is the one thing that did NOT happen here.
    const shared = deps(validBriefJson(dir));
    expect(await runCli(["dispatch", "--driver", "fake"], shared)).toBe(0);

    reset();
    const closedPipe = (): never => {
      const e = new Error("write EPIPE") as NodeJS.ErrnoException;
      e.code = "EPIPE";
      throw e;
    };
    expect(await run(["status", "--driver", "fake"], closedPipe, shared, errOut)).toBe(0);
    // A broken pipe is not a listing failure, so nothing is claimed on the
    // diagnostics sink either.
    expect(errCaptured).toHaveLength(0);
  });

  test("a write failure that is NOT a broken pipe is still a failure", async () => {
    // The other half of the EPIPE tolerance: ENOSPC means the output was lost
    // to a full disk with a reader still there, and swallowing that would make
    // every unwritten ack a silent success.
    const shared = deps(validBriefJson(dir));
    const enospc = (): never => {
      const e = new Error("write ENOSPC") as NodeJS.ErrnoException;
      e.code = "ENOSPC";
      throw e;
    };
    const code = await run(["dispatch", "--driver", "fake"], enospc, shared, errOut);
    expect(code).toBe(1);
    expect(errCaptured.join("")).toContain("ENOSPC");
  });

  test("a repeated boolean flag is refused, exactly as a repeated value flag is", async () => {
    // `bools` is a Set, so `--no-harvest --no-harvest` silently collapsed —
    // and --no-harvest is the flag that WAIVES artifact capture, so a doubled
    // one is precisely the invocation an operator must be sure they typed.
    const shared = deps(validBriefJson(dir));
    expect(await runCli(["dispatch", "--driver", "fake"], shared)).toBe(0);
    const { runId } = JSON.parse(captured.find((l) => l.includes("runId")) as string) as { runId: string };

    reset();
    const code = await runCli(
      ["teardown", "--driver", "fake", "--dir", runsDir, "--no-harvest", "--no-harvest", runId],
      shared,
    );
    expect(code).toBe(2);
    expect(text()).toContain("--no-harvest given more than once");
    // Refused as a usage error: nothing was torn down.
    expect((shared.store as RunRecordStore).get(runId).closedAt).toBeUndefined();
  });

  test("a --dir that cannot BE a records dir exits 2, not a retryable 1", async () => {
    // `new RunRecordStore` throws bare Errors (ENOTDIR here) with no `code`, so
    // it fell through `report`'s generic branch as exit 1 = `transient`:
    // automation retried a `--dir` pointing at a regular file forever.
    const notADir = join(dir, "definitely-a-file");
    writeFileSync(notADir, "not a directory\n");
    const code = await runCli(["status", "--driver", "fake", "--dir", notADir], {
      driver: new FakeDriver(boxesDir),
    });
    expect(code).toBe(2);
    // The store's own message survives the reclassification.
    expect(errCaptured.join("")).toContain(notADir);
  });

  test("a --dir the store cannot even create exits 2 as well, whatever the errno", async () => {
    // The ENOTDIR case above is one of THREE bare-Error shapes `new
    // RunRecordStore` throws, and they share one classification (`asUsage`) —
    // so this pins the second reachable one, from a different call site: the
    // `mkdirSync` rather than the mode check. `--dir` at a self-referential
    // symlink is ELOOP, deterministic and permission-free.
    //
    // The mode branch (`… is mode 0755, not 0700`) is NOT reachable from a
    // test: the constructor chmods the directory to 0700 itself and only then
    // verifies, so a loose directory is repaired rather than refused, and the
    // throw needs a filesystem or an owner where that chmod cannot stick.
    const loop = join(dir, "self-link");
    symlinkSync(loop, loop);
    const code = await runCli(["status", "--driver", "fake", "--dir", loop], {
      driver: new FakeDriver(boxesDir),
    });
    expect(code).toBe(2);
    // The store's own message survives the reclassification here too.
    expect(errCaptured.join("")).toContain(loop);
  });

  test("an invalid brief names the FIELD even on a host with no provisioning key", async () => {
    // AC1. `openRouterKeyApi()` reads $OPENROUTER_PROVISIONING_KEY at
    // construction, and building it before dispatch validated meant a
    // malformed brief exited 2 with `provisioning-key-missing` and no field —
    // the operator set the env var and re-hit the very same brief.
    // biome-ignore lint/performance/noDelete: unsetting env vars requires delete
    delete process.env.OPENROUTER_PROVISIONING_KEY;
    const code = await runCli(["dispatch", "--driver", "fake"], {
      driver: new FakeDriver(boxesDir),
      store: new RunRecordStore(runsDir),
      ledgerFactory: () => goodLedger(),
      readBrief: async () => '{"repoSlug":"nope"}',
      repoRoot: dir,
    });
    expect(code).toBe(2);
    const envelope = JSON.parse(errCaptured[0] as string) as { code: string; field?: string };
    expect(envelope.code).toBe("invalid-brief");
    expect(envelope.field).toBeString();
    expect(errCaptured.join("")).not.toContain("provisioning-key-missing");
    // INV-2 either way: an invalid brief provisions nothing.
    expect(readdirSync(runsDir)).toHaveLength(0);
  });

  test("status exits non-zero and says so when the provider cannot be listed", async () => {
    // With zero open records a total listing failure used to be an exit 0 and
    // a clean stdout — byte-identical to a healthy empty fleet, while every box
    // in it kept billing. `statusAll` now emits a `listUnavailable` row; the
    // CLI must not print it and call the invocation a success.
    const base = new FakeDriver(boxesDir);
    const code = await runCli(["status", "--driver", "fake"], {
      ...deps(validBriefJson(dir)),
      driver: driverWith(base, {
        list: async () => {
          throw new Error("substrate unreachable");
        },
      }),
    });
    expect(code).toBe(1); // the substrate failed — retrying IS the right move
    expect(JSON.parse(outOnly[0] as string)).toMatchObject({ state: "listUnavailable" });
    // …and the reason is on the diagnostics sink, where `fleet status | jq`
    // does not have to parse around it.
    expect(errCaptured.join("")).toContain("list-unavailable");
  });

  test("…and it exits 1 on a listing failure when every record is CLOSED too", async () => {
    // The zero-records case above is one half of the hole. This is the other:
    // `boxUnknown` only ever attaches to an OPEN record, so with every record
    // closed a total listing failure produced rows that all read as settled and
    // an exit 0 — and a closed record whose destroy never landed is precisely
    // the box that is still billing behind it.
    const base = new FakeDriver(boxesDir);
    const shared: Partial<FleetDeps> = { ...deps(validBriefJson(dir)), driver: base };
    expect(await runCli(["dispatch", "--driver", "fake"], shared)).toBe(0);
    const { runId } = JSON.parse(captured.find((l) => l.includes("runId")) as string) as { runId: string };
    expect(await runCli(["teardown", "--driver", "fake", "--dir", runsDir, runId], shared)).toBe(0);

    reset();
    const code = await runCli(["status", "--driver", "fake"], {
      ...shared,
      driver: driverWith(base, {
        list: async () => {
          throw new Error("substrate unreachable");
        },
      }),
    });

    expect(code).toBe(1);
    const rows = outOnly.map((l) => JSON.parse(l) as { runId: string; state: string; boxAlive?: boolean });
    expect(rows.map((r) => r.state)).toContain("listUnavailable");
    const closed = rows.find((r) => r.runId === runId) as { state: string; boxAlive?: boolean };
    expect(closed.state).toBe("closed");
    // ABSENT, not `false`: the substrate never answered, so "the box is gone" is
    // not a thing this row is entitled to claim.
    expect(closed.boxAlive).toBeUndefined();
    expect(errCaptured.join("")).toContain("list-unavailable");
  });

  test("a throw that is not an Error still reports exit 1 with a message", async () => {
    // report()'s `x.code ?? "error"` / `x.message ?? String(e)` normalisation.
    // A rejected string has no `.message`, and a printer that assumed one turned
    // a failure into `undefined` — or threw while reporting it.
    const code = await runCli(["dispatch", "--driver", "fake"], {
      ...deps(validBriefJson(dir)),
      readBrief: () => Promise.reject("substrate said no"),
    });
    expect(code).toBe(1);
    const envelope = JSON.parse(errCaptured[0] as string) as { code: string; message: string; stack?: string };
    expect(envelope.code).toBe("error");
    expect(envelope.message).toBe("substrate said no");
    expect(readdirSync(runsDir)).toHaveLength(0);
  });

  test("dispatch at an interactive terminal refuses instead of waiting forever", async () => {
    // The one guard `deps.readBrief` hides: injecting the reader replaces the
    // isTTY check with it. Without the guard `fleet dispatch` typed by hand
    // blocks on a pipe that never arrives — no error, no timeout, no log line.
    const own = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
    Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
    try {
      const code = await runCli(["dispatch", "--driver", "fake"], {});
      expect(code).toBe(2);
      expect(text()).toContain("no brief on stdin");
      expect(text()).toContain("--brief");
    } finally {
      if (own === undefined) Reflect.deleteProperty(process.stdin, "isTTY");
      else Object.defineProperty(process.stdin, "isTTY", own);
    }
  });

  // ─── THE E2E DEMO (DoD, mandatory): dispatch → status → teardown ──────────

  test("e2e: dispatch → status → teardown against the fake driver", async () => {
    const brief = validBriefJson(dir);
    // ONE shared fleet across all three verbs: the teardown verb's
    // captureSpend reads the key dispatch minted, so the FakeKeyApi and store
    // must be the same instances (a fresh keyApi sees no such key and the
    // spend stays unwritten). The key starts with $0.25 of simulated in-box
    // usage so the captured spend is a NUMBER worth asserting.
    const driver = new FakeDriver(boxesDir);
    const keyApi = new FakeKeyApi({ usageOnCreateUsd: 0.25 });
    const store = new RunRecordStore(runsDir);
    // Held, not created per call, so `closeCalls` is readable below: the real
    // ledger owns a SQLite handle and dispatch must close it on every path.
    const ledger: RecordingLedger = goodLedger();
    const shared: Partial<FleetDeps> = {
      driver,
      keyApi,
      store,
      ledgerFactory: () => ledger,
      readBrief: async () => brief,
      repoRoot: dir,
    };

    // 1. dispatch — prints the ack, exits 0
    const dispatchCode = await runCli(["dispatch", "--driver", "fake"], shared);
    expect(dispatchCode).toBe(0);
    const ackLine = captured.find((l) => l.startsWith("{") && l.includes("runId")) as string;
    expect(ackLine).toBeDefined();
    const ack = JSON.parse(ackLine) as {
      runId: string;
      requestId: string;
      state: string;
      vmName: string;
      httpsUrl?: string;
    };
    expect(ack.runId).toMatch(/^qds-\d{8}-[a-f0-9]{6}$/);
    expect(ack.requestId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
    expect(ack.state).toBe("ready");
    expect(ack.vmName).toBe(ack.runId);
    expect((await driver.list()).map((vm) => vm.name)).toContain(ack.vmName);
    // The ack is OUTPUT: stdout, and nothing on the diagnostics sink at all.
    // `import.meta.main` binds that sink to fd 2 so `fleet dispatch | jq` reads
    // clean JSON, and every other case in this file used to merge the two.
    expect(outOnly).toContain(ackLine);
    expect(errCaptured).toHaveLength(0);
    // One admission, one close: the handle the ledger owns does not leak per run.
    expect(ledger.admitCalls).toHaveLength(1);
    expect(ledger.closeCalls).toBe(1);

    // 2. status — lists the run live
    reset();
    const statusCode = await runCli(["status", "--driver", "fake"], shared);
    expect(statusCode).toBe(0);
    expect(errCaptured).toHaveLength(0);
    const rowLine = captured.find((l) => l.includes(ack.runId)) as string;
    expect(rowLine).toBeDefined();
    const row = JSON.parse(rowLine) as { runId: string; state: string };
    expect(row.runId).toBe(ack.runId);
    expect(row.state).toBe("live");

    // 3. teardown — destroys the box and closes the record with the spend
    reset();
    const teardownCode = await runCli(["teardown", "--driver", "fake", "--dir", runsDir, ack.runId], shared);
    expect(teardownCode).toBe(0);
    expect(text()).toContain(`torn down: ${ack.runId}`);
    const record = store.get(ack.runId);
    expect(record.closedAt).toBeDefined();
    // The key's $0.25 of usage, captured BEFORE the revoke (INV-4) — `typeof
    // === "number"` was satisfied by NaN, 0 and -1 alike.
    expect(record.spendMicroUsd).toBe(250_000);
    // A teardown that closes the record but never calls driver.destroy leaks
    // the VM forever, and every assertion above still passes.
    expect((await driver.list()).map((vm) => vm.name)).not.toContain(ack.vmName);
    // The lock it took is released, so the run stays operable.
    expect(existsSync(join(runsDir, `${ack.runId}.lock`))).toBeFalse();

    // 4. post-teardown status reports closed
    reset();
    const afterCode = await runCli(["status", "--driver", "fake", ack.runId], shared);
    expect(afterCode).toBe(0);
    const closedRow = JSON.parse(captured[0] as string) as { state: string; boxAlive?: boolean };
    expect(closedRow.state).toBe("closed");
    // `false`, not absent: a successful list is EVIDENCE the box is gone, and
    // the closed row now carries it either way (absent means the substrate
    // could not be listed, i.e. no evidence — see statusAll's boxes === null).
    expect(closedRow.boxAlive).toBe(false);
  });

  test("e2e: --no-harvest prints the waiver only after the teardown succeeds", async () => {
    const shared = deps(validBriefJson(dir));
    expect(await runCli(["dispatch", "--driver", "fake"], shared)).toBe(0);
    const { runId } = JSON.parse(captured.find((l) => l.includes("runId")) as string) as { runId: string };

    reset();
    expect(await runCli(["teardown", "--driver", "fake", "--dir", runsDir, "--no-harvest", runId], shared)).toBe(0);
    const waiver = captured.findIndex((l) => l.includes("teardown.harvest_waived"));
    const done = captured.findIndex((l) => l.includes(`torn down: ${runId}`));
    expect(waiver).toBeGreaterThanOrEqual(0);
    // Printed first, the waiver claims a waiver for a teardown that may never
    // have happened.
    expect(waiver).toBeLessThan(done);
  
  });

  test("a failed teardown prints no harvest waiver at all", async () => {
    const base = new FakeDriver(boxesDir);
    const shared: Partial<FleetDeps> = { ...deps(validBriefJson(dir)), driver: base };
    expect(await runCli(["dispatch", "--driver", "fake"], shared)).toBe(0);
    const { runId } = JSON.parse(captured.find((l) => l.includes("runId")) as string) as { runId: string };

    reset();
    const code = await runCli(["teardown", "--driver", "fake", "--dir", runsDir, "--no-harvest", runId], {
      ...shared,
      driver: driverWith(base, {
        destroy: async () => {
          throw new Error("substrate refused the destroy");
        },
      }),
    });
    expect(code).toBe(1);
    expect(text()).toContain("destroy-unconfirmed");
    expect(text()).not.toContain("teardown.harvest_waived");
    expect(text()).not.toContain("torn down:");

  });

  // ─── CC-9: one structured line per verb, dispatch included ─────────────────

  describe("the CC-9 observability line", () => {
    let restoreLog: () => void;
    let entries: LogEntry[];

    beforeEach(() => {
      entries = [];
      restoreLog = setLogSink((e) => {
        entries.push(e);
      });
    });

    afterEach(() => {
      restoreLog();
    });

    /** The invocation's own line — `phase: "complete"`, one per run() call. */
    const verbLines = (): LogEntry[] =>
      entries.filter((e) => (e as unknown as { phase?: string }).phase === "complete");

    test("dispatch logs its verb line on success, carrying the ack's runId", async () => {
      const code = await runCli(["dispatch", "--driver", "fake"], deps(validBriefJson(dir)));
      expect(code).toBe(0);
      const { runId, requestId } = JSON.parse(captured.find((l) => l.includes("runId")) as string) as {
        runId: string;
        requestId: string;
      };

      const lines = verbLines();
      expect(lines).toHaveLength(1);
      const line = lines[0] as unknown as Record<string, unknown>;
      expect(line.verb).toBe("dispatch");
      expect(line.operation).toBe("fleet.dispatch");
      expect(line.exitCode).toBe(0);
      expect(line.exitStatus).toBe("success");
      // The brief owns the correlation id (INV-4-bis), so the CLI's line joins
      // the ack and the run's own lines rather than minting a third id.
      expect(line.requestId).toBe(requestId);
      expect(line.runId).toBe(runId);
    });

    test("dispatch logs its verb line on refusal too, with no runId to report", async () => {
      // Refused at the schema, before an id exists: the line is still owed, and
      // the runId is `null` rather than a fabricated one.
      const code = await runCli(["dispatch", "--driver", "fake"], deps('{"repoSlug":"nope"}'));
      expect(code).toBe(2);

      const lines = verbLines();
      expect(lines).toHaveLength(1);
      const line = lines[0] as unknown as Record<string, unknown>;
      expect(line.verb).toBe("dispatch");
      expect(line.exitCode).toBe(2);
      expect(line.exitStatus).toBe("logic");
      expect(line.runId).toBeNull();
      expect(typeof line.requestId).toBe("string");
    });

    test("a parse failure logs the attempted VERB, never a flag's value", async () => {
      // The line exists to be counted, and dashboards key on `verb`. Scanning
      // raw argv for the first token without a leading dash returned
      // `/srv/runs` here — the value `--dir` consumed — so a filesystem path
      // landed in the verb field and the failures this line counts went
      // missing from every per-verb rollup.
      const code = await runCli(["--dir", runsDir, "status", "--brief", "x"], deps(""));
      expect(code).toBe(2);

      const line = verbLines()[0] as unknown as Record<string, unknown>;
      expect(line.verb).toBe("status");
      expect(line.operation).toBe("fleet.status");
      expect(line.exitStatus).toBe("logic");
    });

    test("exit 1 is transient (retryable substrate), 2-6 are logic", async () => {
      const base = new FakeDriver(boxesDir);
      const shared: Partial<FleetDeps> = { ...deps(validBriefJson(dir)), driver: base };
      expect(await runCli(["dispatch", "--driver", "fake"], shared)).toBe(0);
      const { runId } = JSON.parse(captured.find((l) => l.includes("runId")) as string) as { runId: string };
      entries.length = 0;

      // exit 1: the substrate refused, not the operator — worth a retry.
      expect(
        await runCli(["teardown", "--driver", "fake", "--dir", runsDir, runId], {
          ...shared,
          driver: driverWith(base, {
            destroy: async () => {
              throw new Error("substrate refused the destroy");
            },
          }),
        }),
      ).toBe(1);
      expect((verbLines()[0] as unknown as Record<string, unknown>).exitStatus).toBe("transient");

      // exit 4: the id is wrong, and it will be wrong on every retry.
      entries.length = 0;
      expect(await runCli(["teardown", "--driver", "fake", "--dir", runsDir, "no-such-run"], shared)).toBe(4);
      expect((verbLines()[0] as unknown as Record<string, unknown>).exitStatus).toBe("logic");

      // exit 6: the teardown SUCCEEDED and the cleanup wedged. Classified with
      // the operator errors and not with exit 1 on purpose — a retry cannot
      // clear a lock nothing will release, it can only refuse `run-locked`.
      entries.length = 0;
      reset(); // the first dispatch's ack is still in `captured`, and `find` takes the first
      expect(await runCli(["dispatch", "--driver", "fake"], shared)).toBe(0);
      const wedged = (JSON.parse(captured.find((l) => l.includes("runId")) as string) as { runId: string }).runId;
      const lock = join(runsDir, `${wedged}.lock`);
      entries.length = 0;
      expect(
        await runCli(["teardown", "--driver", "fake", "--dir", runsDir, "--no-harvest", wedged], {
          ...shared,
          driver: driverWith(base, {
            destroy: async (vm: string) => {
              await base.destroy(vm);
              writeFileSync(lock, "99999 someone-else 2026-01-01T00:00:00.000Z deadbeef\n");
            },
          }),
        }),
      ).toBe(6);
      const line = verbLines()[0] as unknown as Record<string, unknown>;
      expect(line.exitCode).toBe(6);
      expect(line.exitStatus).toBe("logic");
    });
  });
});
