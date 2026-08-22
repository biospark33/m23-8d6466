/**
 * DF3.1 Agent C: verbs + status unit tests.
 *
 * MODULE 1 (verbs.ts):
 * - listVerbs() returns exactly 4 entries with exact flag/exit-code shapes
 * - renderHelp() renders from the registry it is HANDED (proved with a
 *   synthetic registry — the real verb names must not leak through)
 * - the declared exitCodes are bound to the codes the CLI can actually return,
 *   in BOTH directions: every observed code is declared AND every declared code
 *   is observed (bar an explicit, documented allowlist for the ones only a full
 *   dispatch wiring can reach)
 * - the `required`/`valueType` columns are observed through the parser, not read
 *   back out of the same table they are asserted against
 *
 * MODULE 2 (status.ts):
 * - join logic across every state (live, boxMissing, boxUnknown, closed,
 *   orphan), including mixed fleets, ownership tags and the INV-1 crash window
 * - the list timeout: default, refusal of a non-positive one, timer cleanup
 * - statusRun validation (canonical RUN_ID_RE/RUN_ID_MAX) and ENOENT handling
 *
 * Fixtures provision through `provisionAdmittedRun` — the production sequence
 * that names the box after the run id and writes `vmName` back — so no test
 * recomputes a box-naming formula the factory does not use.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { listVerbs, renderHelp, type VerbEntry, type VerbFlag } from "../../src/fleet/verbs.ts";
import {
  FLEET_ROW_ID,
  FleetError,
  statusAll,
  statusRun,
  type StatusDeps,
  type StatusRow,
} from "../../src/fleet/status.ts";
import { FakeDriver } from "../../src/providers/fake-driver.ts";
import { provisionAdmittedRun, SBX_OWNERSHIP_TAG, type ProviderVm } from "../../src/providers/driver.ts";
import {
  RUN_ID_MAX,
  RUN_ID_RE,
  RunRecordStore,
  type RunRecord,
  type RunRecordPatch,
} from "../../src/providers/run-record.ts";
import { run, type FleetDeps } from "../../scripts/fleet.ts";

/** Await a refusal and hand back the typed error — never a bare "something threw". */
async function refusal(
  work: Promise<unknown>,
  exitCode: FleetError["exitCode"],
  code: string,
): Promise<FleetError> {
  let caught: unknown;
  let settled = false;
  try {
    await work;
    settled = true;
  } catch (e) {
    caught = e;
  }
  expect(settled).toBe(false);
  expect(caught).toBeInstanceOf(FleetError);
  const err = caught as FleetError;
  expect(err.exitCode).toBe(exitCode);
  expect(err.code).toBe(code);
  return err;
}

/**
 * Await a rejection to COMPLETION and hand back the error.
 *
 * NOT `await expect(p).rejects.toThrow(…)`: bun's `rejects` matcher returns
 * `undefined`, so that `await` yields a single microtask tick and lets the work
 * under test race whatever the test asserts next (here: reading back the record
 * the failed call was supposed to leave behind). The matcher still reports a
 * mismatch, but the sequencing it reads as is not the sequencing it has.
 */
async function rejection(work: Promise<unknown>): Promise<Error> {
  const settled = await work.then(
    () => null,
    (e: unknown) => (e instanceof Error ? e : new Error(`non-Error rejection: ${String(e)}`)),
  );
  expect(settled).toBeInstanceOf(Error); // null ⇒ it resolved, which is the bug
  return settled as Error;
}

/**
 * A driver whose `list` reports the boxes `driver` really has, under a tag of
 * the test's choosing (`null` = untagged, as exedev's `ls --json` reports).
 * The provisioning stays real; only the ownership evidence is varied.
 */
function retagged(driver: FakeDriver, tag: string | null): StatusDeps["driver"] {
  return {
    list: async (name?: string): Promise<ProviderVm[]> =>
      (await driver.list(name)).map(({ tag: _drop, ...vm }) => (tag === null ? vm : { ...vm, tag })),
  };
}

/**
 * The CLI's own exit table, verbatim from `scripts/fleet.ts`'s header: 0 success ·
 * 1 run/provider failure · 2 usage/schema · 3 setup-gate failure · 4 run-not-found ·
 * 5 refused before provisioning · 6 the verb succeeded but a cleanup after it did
 * not (the ledger would not close, or the run lock would not release).
 *
 * A numeric RANGE was the wrong shape for this: `<= 5` failed the moment 6 was
 * declared, and `<= 6` would pass an entry declaring 3 for `harvest` — a code
 * that verb has no path to. Membership in the documented set is the claim.
 */
const DOCUMENTED_EXIT_CODES = [0, 1, 2, 3, 4, 5, 6];

/**
 * The flag lines rendered for ONE verb: everything between its summary line and
 * its `Exit codes:` line. Scoped per verb deliberately — a flag name may legally
 * be required on one verb and optional on another, so a whole-string search for
 * `--dir` cannot say which entry it just read (and `--dir` is a prefix of
 * `--driver`, which a substring search cannot tell apart at all).
 */
function flagLinesFor(help: string, verb: string): string[] {
  const lines = help.split("\n");
  const start = lines.findIndex((l) => l.startsWith(`  ${verb} `));
  expect(start).toBeGreaterThanOrEqual(0);
  const end = lines.findIndex((l, i) => i > start && l.includes("Exit codes:"));
  expect(end).toBeGreaterThan(start);
  return lines.slice(start + 1, end).map((l) => l.trim());
}

/**
 * Every flag on its OWN line, paired with its OWN valueType and its OWN
 * required/optional word.
 *
 * `toContain("required")` was satisfied by the ternary INVERTED (the one
 * synthetic flag was required, so the word appeared either way) and by a
 * renderer that emitted `--brief (string, required)` / `--driver (path,
 * optional)` — the tokens landed in the string, just not on the right lines.
 * The pairing is the claim: `required` is what DF3.5 turns into a generated
 * skill's call signature, and an optional `--driver` generates a skill whose
 * every call exits 2.
 */
function expectFlagLines(help: string, entry: VerbEntry): void {
  expect(flagLinesFor(help, entry.verb)).toEqual(
    entry.flags.map((f) => `${f.name} (${f.valueType}, ${f.required ? "required" : "optional"})`),
  );
}

describe("verbs.ts (registry)", () => {
  test("listVerbs returns exactly 4 entries", () => {
    const verbs: VerbEntry[] = listVerbs();
    expect(verbs).toHaveLength(4);
    const verbNames = verbs.map((v) => v.verb);
    expect(verbNames).toContain("dispatch");
    expect(verbNames).toContain("status");
    expect(verbNames).toContain("harvest");
    expect(verbNames).toContain("teardown");
  });

  test("each verb has exact shape with no extra keys", () => {
    for (const v of listVerbs()) {
      // Exact keys: verb, summary, flags, exitCodes
      const keys = Object.keys(v).sort();
      expect(keys).toEqual(["exitCodes", "flags", "summary", "verb"]);

      // Verb is a non-empty string
      expect(typeof v.verb).toBe("string");
      expect(v.verb.length).toBeGreaterThan(0);

      // Summary is a non-empty string
      expect(typeof v.summary).toBe("string");
      expect(v.summary.length).toBeGreaterThan(0);

      // Flags is an array
      expect(Array.isArray(v.flags)).toBe(true);

      // Each flag has exact shape: {name, required, valueType}
      for (const flag of v.flags) {
        const flagKeys = Object.keys(flag).sort();
        expect(flagKeys).toEqual(["name", "required", "valueType"]);
        expect(typeof flag.name).toBe("string");
        expect(typeof flag.required).toBe("boolean");
        expect(["string", "path", "boolean"]).toContain(flag.valueType);
      }

      // Exit codes is an array of numbers, each one FROM the documented table.
      expect(Array.isArray(v.exitCodes)).toBe(true);
      for (const code of v.exitCodes) {
        expect(typeof code).toBe("number");
        expect(DOCUMENTED_EXIT_CODES).toContain(code);
      }
      // Every verb can succeed, and every verb can be mis-invoked.
      expect(v.exitCodes).toContain(0);
      expect(v.exitCodes).toContain(2);
      // Every verb takes --help; the CLI advertises `fleet <verb> --help`.
      expect(v.flags.some((f) => f.name === "--help" && f.valueType === "boolean")).toBe(true);
    }
  });

  /**
   * The WHOLE flag table per verb, not a length plus a name probe: `--dir`
   * declared as `{required: true}` or `{valueType: "boolean"}` is a different
   * grammar, and the CLI validates argv against exactly these entries.
   */
  const EXPECTED_FLAGS: Record<string, VerbFlag[]> = {
    dispatch: [
      { name: "--brief", required: false, valueType: "path" },
      { name: "--dir", required: false, valueType: "path" },
      { name: "--driver", required: true, valueType: "string" },
      { name: "--help", required: false, valueType: "boolean" },
      { name: "--port", required: false, valueType: "string" },
    ],
    status: [
      { name: "--dir", required: false, valueType: "path" },
      { name: "--driver", required: true, valueType: "string" },
      { name: "--help", required: false, valueType: "boolean" },
    ],
    harvest: [
      { name: "--dir", required: false, valueType: "path" },
      { name: "--driver", required: true, valueType: "string" },
      { name: "--help", required: false, valueType: "boolean" },
    ],
    teardown: [
      { name: "--dir", required: false, valueType: "path" },
      { name: "--driver", required: true, valueType: "string" },
      { name: "--help", required: false, valueType: "boolean" },
      { name: "--no-harvest", required: false, valueType: "boolean" },
    ],
  };

  const EXPECTED_EXIT_CODES: Record<string, number[]> = {
    // 3 = setup gate, 5 = refused before provisioning; dispatch alone can reach them.
    dispatch: [0, 1, 2, 3, 5],
    // 2 is real for all three: a malformed id, an extra positional and a flag
    // the verb does not take are all refused as usage.
    status: [0, 1, 2, 4],
    // 6 = the verb SUCCEEDED and a cleanup after it did not (the cost ledger
    // would not close, or the run lock would not release). Deliberately not 1:
    // exit 1 means "the substrate failed, retry" and `logVerb` classifies it
    // `transient`, but the work here already landed and a retry only re-hits the
    // wedged lock. `status` cannot reach it — it takes neither lock nor ledger.
    // Demonstrated, not merely declared: see the exit-6 probes below.
    //
    // 5 = the run lock refused, so the verb never ran. Also deliberately not 1,
    // and for the mirror-image reason: `transient` tells automation to retry, and
    // for a STALE lock nothing will ever clear it. 5 is "refused before
    // provisioning", which is exactly what an acquire refusal is — the throw sits
    // between the record probe and any mutation. Demonstrated by the lock probes.
    harvest: [0, 1, 2, 4, 5, 6],
    teardown: [0, 1, 2, 4, 5, 6],
  };

  for (const verb of ["dispatch", "status", "harvest", "teardown"]) {
    test(`${verb} verb declares its exact flag table and exit codes`, () => {
      const entry = listVerbs().find((v) => v.verb === verb);
      expect(entry).toBeDefined();
      const flags: VerbFlag[] = [...entry!.flags].sort((a, b) => a.name.localeCompare(b.name));
      expect(flags).toEqual(EXPECTED_FLAGS[verb]!);
      expect(entry!.exitCodes).toEqual(EXPECTED_EXIT_CODES[verb]!);
    });
  }

  test("verbs are unique", () => {
    const verbNames = listVerbs().map((v) => v.verb);
    expect(new Set(verbNames).size).toBe(verbNames.length);
  });

  test("renderHelp renders the registry it is HANDED, not a hard-coded list", () => {
    // The doc contract is "the ONLY place --help content lives". A body that
    // ignores `registry` and prints the four real verbs passes any assertion
    // made against the real registry — so assert against a synthetic one.
    const synthetic: VerbEntry[] = [
      {
        verb: "syntheticverb",
        summary: "a verb that exists only in this test",
        // BOTH polarities, because one required flag makes `required ? … : …`
        // pass with the ternary INVERTED — and `required` is what DF3.5 generates
        // a skill's call signature from.
        flags: [
          { name: "--synthetic", required: true, valueType: "path" },
          { name: "--optional", required: false, valueType: "string" },
        ],
        exitCodes: [7],
      },
    ];
    const help = renderHelp(synthetic);
    expect(help).toContain("syntheticverb");
    expect(help).toContain("a verb that exists only in this test");
    expect(help).toContain("7");
    expectFlagLines(help, synthetic[0]!);

    // ONE rendered entry, because one was handed over — a body that ignores
    // `registry` renders four. This is the primary signal and it cannot be
    // weakened by anything the static header or footer says.
    expect(help.split("Exit codes:")).toHaveLength(2);
    // The name leak is checked against the rendered ENTRIES only (every line
    // renderHelp indents), not the whole string: a header or footer containing
    // the word "status" is not the real registry bleeding through, and forbidding
    // four such common substrings everywhere fails a correct implementation.
    const entries = help
      .split("\n")
      .filter((l) => l.startsWith("  "))
      .join("\n");
    expect(entries).toContain("syntheticverb");
    for (const real of ["dispatch", "status", "harvest", "teardown"]) {
      expect(entries).not.toContain(real);
    }
  });

  test("renderHelp generates usage from the real registry", () => {
    const registry: VerbEntry[] = listVerbs();
    const help = renderHelp(registry);
    expect(typeof help).toBe("string");
    expect(help.length).toBeGreaterThan(0);

    for (const entry of registry) {
      expect(help).toContain(entry.verb);
      expect(help).toContain(entry.summary);
      // Name AND valueType AND polarity, on the same line, for every flag —
      // the old `toContain(flag.name)` said nothing about the other two columns.
      expectFlagLines(help, entry);
      expect(help).toContain(entry.exitCodes.join(", "));
      // Both polarities really are exercised on every verb, so the pairing above
      // cannot be satisfied by an inverted ternary.
      expect(entry.flags.some((f) => f.required)).toBe(true);
      expect(entry.flags.some((f) => !f.required)).toBe(true);
    }
    // Anchored to the FIRST line. `/Usage:|usage:|FLAGS/i` was satisfied by the
    // word "usage" appearing anywhere — including inside a summary — so losing
    // the usage line entirely still passed.
    expect(help.split("\n")[0]).toMatch(/^Usage: fleet /);
    // No trailing blank line: renderHelp trimEnd()s, and the callers append
    // their own "\n".
    expect(help).not.toMatch(/\n\s*$/);
  });
});

/**
 * The registry is a CONTRACT (DF3.5's skill-contract test reads it), so the
 * declared exit codes must be bound to the ones the CLI can actually return —
 * by a test, not by hope. `[0,1,4]` declared against a demonstrable exit 2 is
 * exactly how the last divergence shipped green.
 */
describe("verbs.ts ↔ scripts/fleet.ts exit codes", () => {
  let dir: string;
  let store: RunRecordStore;
  let driver: FakeDriver;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "qds-verb-exit-"));
    driver = new FakeDriver(join(dir, "boxes"));
    store = new RunRecordStore({ dir: join(dir, "runs") });
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  /**
   * One invocation with BOTH streams captured. Passing `() => {}` for each threw
   * away the only evidence that AC1's "exits 2 naming the offending field" is
   * anything more than an exit code: a refactor that returned the right code and
   * printed nothing, or printed the envelope onto stdout — poisoning the JSON
   * lines a caller pipes `fleet status` into — was indistinguishable.
   */
  async function invoke(
    argv: string[],
    deps: Partial<FleetDeps>,
  ): Promise<{ code: number; out: string; err: string }> {
    const outChunks: string[] = [];
    const errChunks: string[] = [];
    const code = await run(
      argv,
      (s) => void outChunks.push(s),
      deps,
      (s) => void errChunks.push(s),
    );
    return { code, out: outChunks.join(""), err: errChunks.join("") };
  }

  /** A store whose `list()` is unreadable — status's only route to exit 1. */
  const unlistableStore = (): RunRecordStore =>
    ({
      dir: store.dir,
      list: (): RunRecord[] => {
        throw new Error("malformed run record beta.json: unknown key: nope");
      },
    }) as unknown as RunRecordStore;

  /**
   * A store whose record read fails for a reason that is NOT absence — the
   * harvest/teardown route to exit 1. `getRecord` classifies on the errno, so a
   * plain Error is a `record-read-failed`, not a `no-record`.
   */
  const unreadableStore = (): RunRecordStore =>
    ({
      dir: store.dir,
      get: (): RunRecord => {
        throw new Error("record store on fire");
      },
    }) as unknown as RunRecordStore;

  /**
   * A store that wedges its own run lock: the SECOND `get` is fleet.ts's
   * post-lock read, so by then `<dir>/<runId>.lock` exists — rewriting its body
   * makes `releaseRunLock` refuse it as a foreign claim. That is exactly and only
   * what exit 6 reports (the verb succeeded, the cleanup after it did not), and
   * it is the lightest injection that reaches it: no ledger, no signal, no clock.
   */
  const lockWedgingStore = (): RunRecordStore => {
    let reads = 0;
    return Object.assign(Object.create(store) as RunRecordStore, {
      get(runId: string): RunRecord {
        const rec = store.get(runId);
        if (++reads === 2) writeFileSync(join(store.dir, `${runId}.lock`), "another invocation\n");
        return rec;
      },
    });
  };

  /**
   * A foreign, LIVE holder's claim at `<store.dir>/<runId>.lock`, in the body
   * layout `acquireRunLock` writes (`<pid> <host> <ISO> <nonce>`) — our own pid
   * and this host, so `refuse()` reads the holder as alive rather than stale.
   * That is the acquire refusal, and the CLI owes exit 5 for it: the throw sits
   * between the record probe and any mutation, so nothing was touched, and exit
   * 1 would stamp it `transient` and tell automation to retry a lock that (in
   * the stale case) nothing will ever clear.
   *
   * Written by hand rather than by calling `acquireRunLock`: this process would
   * then hold it, and the release inside the verb's `finally` would be a real
   * release of a lock the test still owns.
   */
  const holdRunLock = (runId: string): void => {
    const host = hostname().replace(/\s+/g, "_") || "unknown-host";
    writeFileSync(join(store.dir, `${runId}.lock`), `${process.pid} ${host} ${new Date().toISOString()} beefcafe\n`);
  };

  interface Probe {
    argv: string[];
    /**
     * What this invocation really returns. Pinned exactly, so neither direction
     * of the set check below can be satisfied vacuously by a probe that stopped
     * reaching the verb.
     */
    code: number;
    /** Deps for it. Default: the working driver + store, brief = invalid JSON. */
    deps?: () => Partial<FleetDeps>;
    /** Must appear on stderr — and, whatever it is, never on stdout. */
    stderr?: string;
    /** Must appear on stdout (the verb's own output). */
    stdout?: string;
    /** A run to provision first, so the probe has something real to act on. */
    provision?: string;
    /** Filesystem set-up run after the provisioning and before the invocation. */
    before?: () => void;
  }

  /** Invocations whose refusal (or success) each verb can really produce. */
  const PROBES: Record<string, Probe[]> = {
    dispatch: [
      { argv: ["dispatch"], code: 2, stderr: "not valid JSON" }, // the injected brief
      { argv: ["dispatch", "stray-positional"], code: 2, stderr: "no positional arguments" },
      { argv: ["dispatch", "--port", "0"], code: 2, stderr: "--port" },
      // A flag the registry does not give dispatch.
      { argv: ["dispatch", "--no-harvest"], code: 2, stderr: "does not take --no-harvest" },
      // `--driver` is required:true, and nothing is injected to stand in for it.
      { argv: ["dispatch"], code: 2, deps: () => ({ store }), stderr: "dispatch requires --driver" },
    ],
    status: [
      { argv: ["status"], code: 0 }, // empty fleet is a state, not an error
      { argv: ["status", "no-such-run"], code: 4, stderr: "no-such-run" },
      { argv: ["status", "INVALID_ID"], code: 2, stderr: "INVALID_ID" },
      { argv: ["status", "one", "two"], code: 2, stderr: "at most one" },
      { argv: ["status", "--brief", "somewhere"], code: 2, stderr: "does not take --brief" },
      { argv: ["status"], code: 2, deps: () => ({ store }), stderr: "status requires --driver" },
      {
        argv: ["status"],
        code: 1,
        deps: () => ({ driver, store: unlistableStore() }),
        stderr: "record-store-unreadable",
      },
      // The SINGLE-run path's exit 1, which `unlistableStore` cannot reach (it
      // fails `list()`, i.e. statusAll). Without it, widening statusRun's ENOENT
      // check would make `fleet status <id>` answer "No run record" / exit 4 for
      // a run whose record is merely unreadable, while its box is alive and spending.
      {
        argv: ["status", "some-run"],
        code: 1,
        deps: () => ({ driver, store: unreadableStore() }),
        stderr: "record-read-failed",
      },
    ],
    harvest: [
      { argv: ["harvest"], code: 2, stderr: "requires <run-id>" },
      { argv: ["harvest", "no-such-run"], code: 4, stderr: "no run record for no-such-run" },
      { argv: ["harvest", "INVALID_ID"], code: 2, stderr: "INVALID_ID" },
      { argv: ["harvest", "--no-harvest", "some-run"], code: 2, stderr: "does not take --no-harvest" },
      { argv: ["harvest", "some-run"], code: 2, deps: () => ({ store }), stderr: "harvest requires --driver" },
      {
        argv: ["harvest", "some-run"],
        code: 1,
        deps: () => ({ driver, store: unreadableStore() }),
        stderr: "record-read-failed",
      },
      { argv: ["harvest", "harvest-ok"], code: 0, provision: "harvest-ok", stdout: "harvested: " },
      {
        argv: ["harvest", "harvest-wedged"],
        code: 6,
        provision: "harvest-wedged",
        deps: () => ({ driver, store: lockWedgingStore() }),
        // The work landed on stdout; the wedge is a diagnostic on stderr. Both,
        // together, ARE exit 6 — either alone would be 0 or 1.
        stdout: "harvested: ",
        stderr: "lock-release-failed",
      },
      {
        argv: ["harvest", "harvest-locked"],
        code: 5,
        provision: "harvest-locked",
        before: () => holdRunLock("harvest-locked"),
        stderr: "run-locked",
      },
    ],
    teardown: [
      { argv: ["teardown"], code: 2, stderr: "requires <run-id>" },
      { argv: ["teardown", "no-such-run"], code: 4, stderr: "no run record for no-such-run" },
      { argv: ["teardown", "INVALID_ID"], code: 2, stderr: "INVALID_ID" },
      { argv: ["teardown", "one", "two"], code: 2, stderr: "exactly one" },
      { argv: ["teardown", "some-run"], code: 2, deps: () => ({ store }), stderr: "teardown requires --driver" },
      {
        argv: ["teardown", "some-run"],
        code: 1,
        deps: () => ({ driver, store: unreadableStore() }),
        stderr: "record-read-failed",
      },
      { argv: ["teardown", "teardown-ok"], code: 0, provision: "teardown-ok", stdout: "torn down: " },
      {
        argv: ["teardown", "teardown-wedged"],
        code: 6,
        provision: "teardown-wedged",
        deps: () => ({ driver, store: lockWedgingStore() }),
        stdout: "torn down: ",
        stderr: "lock-release-failed",
      },
      {
        argv: ["teardown", "teardown-locked"],
        code: 5,
        provision: "teardown-locked",
        before: () => holdRunLock("teardown-locked"),
        stderr: "run-locked",
      },
    ],
  };

  /**
   * Codes a verb declares that NO probe in this file reaches, with the reason.
   * The ⊇ direction is scoped around exactly these and nothing else: a precise
   * partial check beats a total one that a verb declaring [0,1,2,3,4,5] passes.
   */
  const ONLY_REACHABLE_ELSEWHERE: Record<string, { code: number; why: string; coveredBy: string }[]> = {
    dispatch: [
      // Every one of these needs the full dispatch wiring — keyApi, ledgerFactory,
      // setupGate, a valid brief — which is tests/fleet/cli.test.ts's subject, not
      // this file's. `coveredBy` names the test that owes the code; the check below
      // asserts each title still exists there, so the excuse cannot outlive its test.
      {
        code: 0,
        why: "needs a keyApi + ledgerFactory + valid brief — cli.test.ts",
        coveredBy: "e2e: dispatch → status → teardown against the fake driver",
      },
      {
        code: 1,
        why: "needs a provider failure mid-dispatch — cli.test.ts",
        coveredBy: "a throw that is not an Error still reports exit 1 with a message",
      },
      {
        code: 3,
        why: "needs a failing setup gate — cli.test.ts",
        coveredBy: "setup-gate failure → exit 3 with the assertion code, box ALIVE and record OPEN (INV-5)",
      },
      {
        code: 5,
        why: "needs a budget refusal before provisioning — cli.test.ts",
        coveredBy: "an over-budget issue → exit 5 refused BEFORE provisioning (AC7)",
      },
    ],
    status: [],
    harvest: [],
    teardown: [],
  };

  /**
   * The allowlist above excuses 4 of dispatch's 5 declared codes, which reduces
   * the ⊇ direction to `{2}` for that verb — honest only while the tests it
   * defers to exist. Nothing BOUND the excuse to them: deleting a cli.test.ts
   * case left this file green with `dispatch` advertising an unreachable code to
   * DF3.5's generated skill.
   *
   * The binding this file can make from the outside is the test TITLE: read the
   * sibling suite and require the named case to still be in it. Not a run of that
   * test (bun owns that) and not proof it asserts the code — but a deletion or a
   * rename now turns this red, which is the failure mode that shipped.
   */
  test("every excused exit code names a cli.test.ts case that still exists", () => {
    const cli = readFileSync(join(import.meta.dir, "cli.test.ts"), "utf8");
    const missing: string[] = [];
    for (const [verb, excuses] of Object.entries(ONLY_REACHABLE_ELSEWHERE)) {
      for (const { code, coveredBy } of excuses) {
        // The title as `test(...)` writes it, not a loose substring: a comment
        // mentioning the name must not stand in for the case itself.
        if (!cli.includes(`test(${JSON.stringify(coveredBy)}`)) {
          missing.push(`${verb} exit ${code}: no test named ${JSON.stringify(coveredBy)} in cli.test.ts`);
        }
      }
    }
    expect(missing).toEqual([]);
    // …and every excuse names one: an entry with an empty `coveredBy` would pass
    // a substring check against any file.
    for (const excuses of Object.values(ONLY_REACHABLE_ELSEWHERE)) {
      for (const e of excuses) expect(e.coveredBy.length).toBeGreaterThan(0);
    }
  });

  test("the declared exitCodes and the codes the CLI really returns are the SAME set", async () => {
    for (const entry of listVerbs()) {
      const probes = PROBES[entry.verb]!;
      const observed: number[] = [];
      for (const probe of probes) {
        if (probe.provision !== undefined) {
          await provisionAdmittedRun(driver, store, { runId: probe.provision });
        }
        probe.before?.();
        const deps = probe.deps?.() ?? { driver, store, readBrief: async () => "{not json" };
        const res = await invoke(probe.argv, deps);
        observed.push(res.code);
        if (probe.stderr !== undefined) {
          // Named on stderr, and NOT on stdout: a caller parsing `fleet status`
          // output must never have to skip an error envelope in it.
          expect(res.err).toContain(probe.stderr);
          expect(res.out).not.toContain(probe.stderr);
        }
        if (probe.stdout !== undefined) expect(res.out).toContain(probe.stdout);
        // Every non-zero exit says something. Silence is the failure mode an
        // exit-code-only assertion cannot see.
        if (res.code !== 0) expect(res.err.length).toBeGreaterThan(0);
      }
      expect(observed).toEqual(probes.map((p) => p.code));

      const declared = new Set(entry.exitCodes);
      const seen = new Set(observed);
      // ⊆ : nothing the CLI returns may be missing from the registry.
      expect(
        probes
          .filter((p) => !declared.has(p.code))
          .map((p) => `${p.argv.join(" ")} → exit ${p.code}, not in [${entry.exitCodes.join(",")}]`),
      ).toEqual([]);
      // ⊇ : nothing the registry advertises may be unreachable, bar the allowlist.
      const excused = new Set(ONLY_REACHABLE_ELSEWHERE[entry.verb]!.map((e) => e.code));
      expect([...declared].filter((c) => !seen.has(c) && !excused.has(c))).toEqual([]);
      // …and the allowlist itself stays honest: an excused code that a probe
      // now reaches must be struck from it, not left as a standing exemption.
      expect([...excused].filter((c) => seen.has(c))).toEqual([]);
    }
  });
});

/**
 * The registry's `required` and `valueType` columns, observed through the CLI
 * rather than read back out of the same table they are asserted against
 * (`EXPECTED_FLAGS` cannot fail when the parser disagrees with the registry).
 */
describe("verbs.ts ↔ scripts/fleet.ts flag grammar", () => {
  let dir: string;
  let store: RunRecordStore;
  let driver: FakeDriver;
  const sink = (): void => {};

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "qds-verb-flags-"));
    driver = new FakeDriver(join(dir, "boxes"));
    store = new RunRecordStore({ dir: join(dir, "runs") });
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("--driver is required:true on EVERY verb — omitting it is refused as usage", async () => {
    // No injected driver, so nothing stands in for the flag. Every verb declares
    // `{name: "--driver", required: true}`; declaring it optional is how DF3.5
    // would generate a skill whose every call exits 2.
    for (const entry of listVerbs()) {
      expect(entry.flags.find((f) => f.name === "--driver")?.required).toBe(true);
      const argv = entry.verb === "dispatch" || entry.verb === "status" ? [entry.verb] : [entry.verb, "some-run"];
      const err: string[] = [];
      expect(await run(argv, sink, { store }, (s) => void err.push(s))).toBe(2);
      expect(err.join("")).toContain(`${entry.verb} requires --driver <name>`);
    }
  });

  test("a value-taking flag with no value is refused; a boolean flag never eats the next token", async () => {
    const deps: Partial<FleetDeps> = { driver, store, readBrief: async () => "{not json" };
    // valueType "path"/"string" ⇒ the flag consumes a value, and a missing one is
    // the operator's typo, not an empty string to act on.
    expect(await run(["status", "--dir"], sink, deps, sink)).toBe(2);
    expect(await run(["dispatch", "--port"], sink, deps, sink)).toBe(2);

    // valueType "boolean" ⇒ it consumes NOTHING. If `--no-harvest` took a value
    // it would swallow the run id and teardown would refuse as "requires
    // <run-id>" (exit 2); reaching run-not-found (4) proves the id survived.
    expect(await run(["teardown", "--no-harvest", "no-such-run"], sink, deps, sink)).toBe(4);

    // The OUTPUT, not the code: both hypotheses exit 0 here. A value-taking
    // `--help` would swallow "no-such-run", leaving `status` with no positionals
    // over an empty store — which prints nothing and exits 0, exactly like the
    // help path. Only the usage text tells them apart.
    const out: string[] = [];
    expect(await run(["status", "--help", "no-such-run"], (s) => void out.push(s), deps, sink)).toBe(0);
    expect(out.join("")).toContain("Usage: fleet ");
    expect(out.join("")).toContain("status");
  });

  test("a flag the registry does not give a verb is refused, per verb", async () => {
    const deps: Partial<FleetDeps> = { driver, store, readBrief: async () => "{not json" };
    for (const entry of listVerbs()) {
      const declared = new Set(entry.flags.map((f) => f.name));
      // Every flag ANY verb declares, tried against a verb that does not declare
      // it: `--brief`/`--port` (dispatch only) and `--no-harvest` (teardown only).
      for (const flag of ["--brief", "--port", "--no-harvest"]) {
        if (declared.has(flag)) continue;
        const err: string[] = [];
        const argv = flag === "--no-harvest" ? [entry.verb, flag] : [entry.verb, flag, "x"];
        expect(await run(argv, sink, deps, (s) => void err.push(s))).toBe(2);
        expect(err.join("")).toContain(`${entry.verb} does not take ${flag}`);
      }
    }
  });
});

describe("status.ts (statusAll join logic)", () => {
  let dir: string;
  let store: RunRecordStore;
  let driver: FakeDriver;

  beforeEach(() => {
    // Store and driver get their OWN directories: sharing one passes today
    // only because record filenames end in `.json` and box names do not.
    dir = mkdtempSync(join(tmpdir(), "qds-status-"));
    driver = new FakeDriver(join(dir, "boxes"));
    store = new RunRecordStore({ dir: join(dir, "runs") });
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  /**
   * The REAL provisioning sequence: record → box named after the run id →
   * `vmName` written back. Nothing here re-derives a box name.
   */
  async function provision(runId: string, patch?: RunRecordPatch, port?: number): Promise<RunRecord> {
    const { record } = await provisionAdmittedRun(driver, store, {
      runId,
      ...(port === undefined ? {} : { port }),
    });
    return patch === undefined ? record : store.set(runId, patch);
  }

  test("closedAt → state 'closed', and the driver is still consulted", async () => {
    const runId = "test-closed-run";
    const rec = await provision(runId);
    store.close(runId);

    const listSpy = mock((name?: string) => driver.list(name));
    const rows: StatusRow[] = await statusAll({ driver: { list: listSpy }, store, listTimeoutMs: 1000 });

    expect(rows).toHaveLength(1);
    expect(rows[0]!.state).toBe("closed");
    expect(rows[0]!.runId).toBe(runId);
    // A PARSEABLE instant, not merely a present key: `closedAt: "not a date"`
    // satisfies toBeDefined() and breaks the newest-first sort and every
    // age-based reaper downstream of it.
    expect(Date.parse(rows[0]!.closedAt as string)).not.toBeNaN();
    // A closed record over a live box is a box that is still billing.
    expect(rows[0]!.boxAlive).toBe(true);
    expect(rows[0]!.vmName).toBe(rec.vmName);
    expect(listSpy).toHaveBeenCalled();
  });

  test("closed + destroyed box → 'closed' with boxAlive FALSE (confirmed gone, not unknown)", async () => {
    // `false`, not absent: the driver answered. Absence is reserved for "the
    // substrate could not be reached", which the boxUnknown case below pins —
    // conflating the two reported every list failure as confirmed-destroyed.
    const runId = "test-closed-gone";
    const rec = await provision(runId);
    await driver.destroy(rec.vmName!);
    store.close(runId);

    const rows = await statusAll({ driver, store, listTimeoutMs: 1000 });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.state).toBe("closed");
    expect(rows[0]!.boxAlive).toBe(false);
  });

  test("closed + list FAILS → 'closed' with boxAlive ABSENT (the box may still be billing)", async () => {
    const runId = "test-closed-unknown";
    const rec = await provision(runId);
    await driver.destroy(rec.vmName!);
    store.close(runId);

    const rows = await statusAll({
      driver: {
        list: async (): Promise<ProviderVm[]> => {
          throw new Error("list down");
        },
      },
      store,
      listTimeoutMs: 1000,
    });
    const closed = rows.find((r) => r.runId === runId)!;
    expect(closed.state).toBe("closed");
    expect(closed).not.toHaveProperty("boxAlive");
    // The other zero-`boxUnknown` fleet: every record CLOSED. No open record
    // means no boxUnknown row, so without the fleet-level row the outage is
    // invisible again — a clean-looking exit 0 over an unlistable substrate.
    expect(rows).toHaveLength(2);
    expect(rows.find((r) => r.runId === FLEET_ROW_ID)!.state).toBe("listUnavailable");
  });

  test("open + vmName unset + no box → boxMissing", async () => {
    const runId = "test-no-vm";
    store.create(runId); // record only: no box was ever created
    const rows = await statusAll({ driver, store, listTimeoutMs: 1000 });

    expect(rows).toHaveLength(1);
    expect(rows[0]!.state).toBe("boxMissing");
    expect(rows[0]!.runId).toBe(runId);
  });

  test("open + listOk + vm in set → live", async () => {
    const runId = "test-live-run";
    const rec = await provision(runId);

    const rows = await statusAll({ driver, store, listTimeoutMs: 1000 });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.state).toBe("live");
    expect(rows[0]!.runId).toBe(runId);
    expect(rows[0]!.vmName).toBe(rec.vmName);
  });

  test("open + listOk + vm NOT in set → boxMissing", async () => {
    const runId = "test-missing-box";
    const rec = await provision(runId);
    await driver.destroy(rec.vmName!);

    const rows = await statusAll({ driver, store, listTimeoutMs: 1000 });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.state).toBe("boxMissing");
    expect(rows[0]!.runId).toBe(runId);
    expect(rows[0]!.vmName).toBe(rec.vmName);
  });

  test("open + list hangs past listTimeoutMs → boxUnknown", async () => {
    const runId = "test-unknown";
    await provision(runId);

    // A promise that never settles — no test-owned timer to leak.
    const hangingDriver = { list: () => new Promise<ProviderVm[]>(() => {}) };
    const rows = await statusAll({ driver: hangingDriver, store, listTimeoutMs: 5 });

    // The record row PLUS the unconditional listUnavailable row (see below).
    expect(rows).toHaveLength(2);
    expect(rows.find((r) => r.runId === runId)!.state).toBe("boxUnknown");
    expect(rows.find((r) => r.runId === FLEET_ROW_ID)!.state).toBe("listUnavailable");
  });

  test("open + list throws → boxUnknown", async () => {
    const runId = "test-throw";
    await provision(runId);

    const throwingDriver = {
      list: async (): Promise<ProviderVm[]> => {
        throw new Error("driver list failed");
      },
    };
    const rows = await statusAll({ driver: throwingDriver, store, listTimeoutMs: 1000 });

    expect(rows).toHaveLength(2);
    expect(rows.find((r) => r.runId === runId)!.state).toBe("boxUnknown");
    expect(rows.find((r) => r.runId === FLEET_ROW_ID)!.state).toBe("listUnavailable");
  });

  test("non-array driver reply degrades to boxUnknown, never a TypeError", async () => {
    const runId = "test-nonarray";
    await provision(runId);

    const nonArrayDriver = { list: async (): Promise<ProviderVm[]> => ({}) as unknown as ProviderVm[] };
    const rows = await statusAll({ driver: nonArrayDriver, store, listTimeoutMs: 1000 });

    expect(rows).toHaveLength(2);
    expect(rows.find((r) => r.runId === runId)!.state).toBe("boxUnknown");
    expect(rows.find((r) => r.runId === FLEET_ROW_ID)!.state).toBe("listUnavailable");
  });

  test("a list failure is VISIBLE with zero records — an empty fleet and an unreachable one differ", async () => {
    // The whole reason the row exists. `boxUnknown` only ever attaches to an
    // OPEN record, so with nothing on disk (or with every record closed) a total
    // listing failure produced `[]` — byte-identical to a healthy empty fleet,
    // and an exit 0 telling the operator the fleet is clean while every box in
    // it kept billing.
    const downDriver = {
      list: async (): Promise<ProviderVm[]> => {
        throw new Error("substrate unreachable");
      },
    };
    expect(await statusAll({ driver, store, listTimeoutMs: 1000 })).toEqual([]);

    const rows = await statusAll({ driver: downDriver, store, listTimeoutMs: 1000 });
    expect(rows).toEqual([{ runId: FLEET_ROW_ID, state: "listUnavailable" }]);
  });

  test("the listUnavailable row's id can never collide with a real run id", async () => {
    // It is the row's identity in a stream keyed by runId, so a collision would
    // let a run masquerade as the fleet-level failure (and vice versa).
    expect(RUN_ID_RE.test(FLEET_ROW_ID)).toBe(false);
  });

  test("a healthy list emits NO listUnavailable row", async () => {
    // Without this the row could be unconditional and every case above still
    // passes by name lookup.
    await provision("test-no-false-alarm");
    const rows = await statusAll({ driver, store, listTimeoutMs: 1000 });
    expect(rows.some((r) => r.state === "listUnavailable")).toBe(false);
  });

  test("store.list() failure surfaces as a typed FleetError, not a bare throw", async () => {
    const brokenStore = {
      list: (): RunRecord[] => {
        throw new Error("malformed run record beta.json: unknown key: nope");
      },
    } as unknown as RunRecordStore;

    const err = await refusal(
      statusAll({ driver, store: brokenStore, listTimeoutMs: 1000 }),
      1,
      "record-store-unreadable",
    );
    expect(err.message).toContain("malformed run record beta.json");
    expect(err.remediation).toContain("fleet status");
  });

  test("newest-first by createdAt, numeric across mixed ISO shapes, runId breaking ties", async () => {
    // Fed in an order `store.list()` never produces, so deleting the sort fails.
    // Neither lexicographic order nor runId order is the expected answer:
    //   "…T01:00:00+01:00" sorts LAST lexicographically-desc but ties at t=0,
    //   "…T00:00:00.500Z" sorts BEFORE "…T00:00:00Z" as text yet is 500ms later.
    const rows2: RunRecord[] = [
      { runId: "b-oldest", createdAt: "2026-01-01T00:00:00Z" },
      { runId: "a-tied", createdAt: "2026-01-01T01:00:00+01:00" },
      { runId: "c-newest", createdAt: "2026-01-01T00:00:00.500Z" },
    ];
    const stubStore = { list: () => rows2 } as unknown as RunRecordStore;

    const rows = await statusAll({ driver, store: stubStore, listTimeoutMs: 1000 });
    expect(rows.map((r) => r.runId)).toEqual(["c-newest", "a-tied", "b-oldest"]);
  });

  test("empty fleet → empty array", async () => {
    // toEqual([]), not toHaveLength(0): `""` has length 0, and a statusAll that
    // returned one on the empty path would be `.map()`ed over by the CLI.
    expect(await statusAll({ driver, store, listTimeoutMs: 1000 })).toEqual([]);
  });

  test("row carries the record's optional fields", async () => {
    const runId = "test-optional";
    // The real expose path writes httpsUrl onto the record. Asserted by SHAPE:
    // the literal string "undefined" is defined, and is what a template that
    // interpolated a missing value produces.
    const rec = await provision(runId, undefined, 8080);
    expect(rec.httpsUrl).toMatch(/^https:\/\//);

    const rows = await statusAll({ driver, store, listTimeoutMs: 1000 });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.vmName).toBe(rec.vmName);
    expect(rows[0]!.httpsUrl).toBe(rec.httpsUrl);
  });

  test("spend/limit/requestId ride EVERY record-backed state, not just live", async () => {
    const costs: RunRecordPatch = {
      spendMicroUsd: 123456,
      limitMicroUsd: 500000,
      requestId: "req-costs",
    };
    // live
    await provision("cost-live", costs);
    // boxMissing
    const missing = await provision("cost-missing", costs);
    await driver.destroy(missing.vmName!);
    // closed (core fields must be written before close)
    await provision("cost-closed", costs);
    store.close("cost-closed");

    const rows = await statusAll({ driver, store, listTimeoutMs: 1000 });
    const byId = new Map(rows.map((r) => [r.runId, r]));
    expect(byId.get("cost-live")!.state).toBe("live");
    expect(byId.get("cost-missing")!.state).toBe("boxMissing");
    expect(byId.get("cost-closed")!.state).toBe("closed");
    for (const id of ["cost-live", "cost-missing", "cost-closed"]) {
      const row = byId.get(id)!;
      expect(row.spendMicroUsd).toBe(123456);
      expect(row.limitMicroUsd).toBe(500000);
      expect(row.requestId).toBe("req-costs");
    }

    // boxUnknown builds its own row literal too. (A closed record still reads
    // `closed` with no list — closedAt is decided before the box evidence is.)
    const unknownRows = await statusAll({
      driver: {
        list: async (): Promise<ProviderVm[]> => {
          throw new Error("list down");
        },
      },
      store,
      listTimeoutMs: 1000,
    });
    // 3 record rows + the fleet-level listUnavailable row.
    expect(unknownRows).toHaveLength(4);
    for (const row of unknownRows.filter((r) => r.runId !== FLEET_ROW_ID)) {
      expect(row.state).toBe(row.runId === "cost-closed" ? "closed" : "boxUnknown");
      expect(row.spendMicroUsd).toBe(123456);
      expect(row.limitMicroUsd).toBe(500000);
      expect(row.requestId).toBe("req-costs");
    }
  });

  test("mixed fleet: closed + live + boxMissing + orphan in ONE call", async () => {
    // Every other test asserts toHaveLength(1), which a per-record branch that
    // leaks across iterations satisfies perfectly.
    await provision("mix-live", { requestId: "req-live" });
    const missing = await provision("mix-missing", { requestId: "req-missing" });
    await driver.destroy(missing.vmName!);
    await provision("mix-closed", { requestId: "req-closed" }); // box left alive
    store.close("mix-closed");
    // An owned box no record claims: unattributed spend.
    await driver.create("mix-orphan", SBX_OWNERSHIP_TAG);

    const rows = await statusAll({ driver, store, listTimeoutMs: 1000 });
    expect(rows).toHaveLength(4);
    const byId = new Map(rows.map((r) => [r.runId, r]));
    expect(byId.get("mix-live")!.state).toBe("live");
    expect(byId.get("mix-missing")!.state).toBe("boxMissing");
    expect(byId.get("mix-closed")!.state).toBe("closed");
    expect(byId.get("mix-closed")!.boxAlive).toBe(true);
    expect(byId.get("mix-orphan")!.state).toBe("orphan");
    // requestId on every state that HAS a record, and only there.
    expect(byId.get("mix-live")!.requestId).toBe("req-live");
    expect(byId.get("mix-missing")!.requestId).toBe("req-missing");
    expect(byId.get("mix-closed")!.requestId).toBe("req-closed");
    expect(byId.get("mix-orphan")!).not.toHaveProperty("requestId");
    // The closed record's live box is reported on its own row — never twice.
    expect(rows.filter((r) => r.state === "orphan")).toHaveLength(1);
  });

  test("orphan rows: no record, no requestId, sorted first and deterministically", async () => {
    await provision("claimed-run");
    await driver.create("orphan-b", SBX_OWNERSHIP_TAG);
    await driver.create("orphan-a", SBX_OWNERSHIP_TAG);

    const rows = await statusAll({ driver, store, listTimeoutMs: 1000 });
    expect(rows.map((r) => r.runId)).toEqual(["orphan-a", "orphan-b", "claimed-run"]);
    for (const name of ["orphan-a", "orphan-b"]) {
      const row = rows.find((r) => r.runId === name)!;
      expect(row.state).toBe("orphan");
      expect(row.vmName).toBe(name);
      // ABSENT, not "": a required-but-empty instant makes every renderer's
      // `new Date(row.createdAt)` produce Invalid Date on the one row class the
      // sort floats to the top. (Two such rows also tie at +Infinity here, so
      // the deterministic order above is the comparator's NaN fallthrough.)
      expect(row).not.toHaveProperty("createdAt");
      expect(row).not.toHaveProperty("requestId");
    }
  });

  test("nameless driver entries are dropped, never keyed as an undefined runId", async () => {
    // `StatusDeps.driver` is structural, so an injected or third-party driver
    // can answer with entries that are not VMs. A nameless one used to key the
    // Map under `undefined` and reach the output as an orphan row with no
    // runId, which the comparator then dereferenced (TypeError) as soon as a
    // second such row existed.
    const junkDriver = {
      list: async (): Promise<ProviderVm[]> =>
        [
          { name: undefined },
          { name: "" },
          null,
          { name: "real-orphan", tag: SBX_OWNERSHIP_TAG },
          { name: undefined },
        ] as unknown as ProviderVm[],
    };
    const rows = await statusAll({ driver: junkDriver, store, listTimeoutMs: 1000 });
    expect(rows.map((r) => r.runId)).toEqual(["real-orphan"]);
    expect(rows[0]!.state).toBe("orphan");
  });

  test("a box carrying a FOREIGN tag never makes a run report live", async () => {
    const runId = "tagged-foreign";
    await provision(runId);

    const rows = await statusAll({ driver: retagged(driver, "someone-elses-fleet"), store, listTimeoutMs: 1000 });
    expect(rows).toHaveLength(1); // filtered out entirely — not even an orphan
    expect(rows[0]!.state).toBe("boxMissing");
  });

  test("an UNTAGGED box is still ours (exedev ls reports no tag)", async () => {
    const runId = "tagged-absent";
    await provision(runId);

    const rows = await statusAll({ driver: retagged(driver, null), store, listTimeoutMs: 1000 });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.state).toBe("live");
  });

  test("a box named differently from its run: claimed by vmName, live, never ALSO an orphan", async () => {
    // Nothing else in this file produces `vmName !== runId` — provisioning names
    // the box after the run — so three branches in status.ts were dead in test:
    // the two-name join, the `claimed.add(rec.vmName)` sweep, and (in statusRun)
    // the list filter. A renamed box is exactly the one that keeps billing while
    // every row claims boxMissing.
    const runId = "renamed-box-run";
    const rec = await provision(runId);
    await driver.destroy(rec.vmName!); // nothing answers to the run id any more
    await driver.create("box-under-another-name", SBX_OWNERSHIP_TAG);
    store.set(runId, { vmName: "box-under-another-name" });

    const rows = await statusAll({ driver, store, listTimeoutMs: 1000 });
    // ONE row. Dropping `rec.vmName` from the join names reports boxMissing for a
    // box that is alive; dropping `claimed.add(rec.vmName)` reports that same box
    // a second time as an orphan, so the fleet appears to hold two of them.
    expect(rows).toHaveLength(1);
    expect(rows[0]!.state).toBe("live");
    expect(rows[0]!.vmName).toBe("box-under-another-name");
    expect(rows.filter((r) => r.state === "orphan")).toHaveLength(0);
  });

  test("vmName names a box that is gone while one lives under the run id → live", async () => {
    // The other half of the `[vmName, runId]` join: dropping `runId` from it is
    // invisible while every fixture has the two equal.
    const runId = "vmname-elsewhere";
    await provision(runId); // the box IS named after the run
    store.set(runId, { vmName: "a-box-that-was-renamed-away" });

    const rows = await statusAll({ driver, store, listTimeoutMs: 1000 });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.state).toBe("live");
    // The record's own name still identifies the box — it is what the record says.
    expect(rows[0]!.vmName).toBe("a-box-that-was-renamed-away");
  });

  test("crash window: open record with no vmName but a live box under the run id → live", async () => {
    // INV-1's window: `driver.create` returned, the `set({vmName})` never landed.
    const runId = "crash-window-run";
    store.create(runId);
    await driver.create(runId, SBX_OWNERSHIP_TAG);

    const rows = await statusAll({ driver, store, listTimeoutMs: 1000 });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.state).toBe("live");
    // The box name teardown would target, taken from the box itself.
    expect(rows[0]!.vmName).toBe(runId);
    expect(rows.filter((r) => r.state === "orphan")).toHaveLength(0);
  });
});

describe("provisionAdmittedRun (INV-1) — failure leaves the run reclaimable", () => {
  let dir: string;
  let store: RunRecordStore;
  let driver: FakeDriver;

  const budget = {
    repoSlug: "acme/widgets",
    issueId: "42",
    capMicroUsd: 50_000_000,
    spentMicroUsd: 0,
    reservedMicroUsd: 0,
    admittedCeilingMicroUsd: 20_000_000,
  };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "qds-provision-"));
    driver = new FakeDriver(join(dir, "boxes"));
    store = new RunRecordStore({ dir: join(dir, "runs") });
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("a failed driver.create leaves the record OPEN with its budget attribution", async () => {
    // Closing it here looked tidy and was wrong twice over: the ledger retires
    // a reservation only when a PRICED cost_event lands, which only teardown
    // writes from `extensions.budget` — and the reaper routes an aged OPEN
    // record through teardownSandbox while skipping a closed one outright
    // (`closed ⇒ nothing to claim`). A closed record therefore pinned the
    // issue's cap forever, and stranded any box the failing create did stand up.
    const runId = "create-fails-run";
    const failing = Object.assign(Object.create(driver) as FakeDriver, {
      create: async () => {
        throw new Error("substrate refused the create");
      },
    });

    const err = await rejection(provisionAdmittedRun(failing, store, { runId, budget }));
    expect(err.message).toContain("substrate refused the create");

    const rec = store.get(runId);
    expect(rec.closedAt).toBeUndefined();
    expect(rec.extensions?.budget?.admittedCeilingMicroUsd).toBe(budget.admittedCeilingMicroUsd);
    expect(rec.extensions?.budget?.repoSlug).toBe(budget.repoSlug);
    // No box name to claim, which is exactly what makes the record the handle.
    expect(rec.vmName).toBeUndefined();
  });

  test("a failed budget-extension write REMOVES the record so the reservation can expire", async () => {
    // The OPPOSITE call from the sibling above, and for the same money reason.
    // `store.create`'s O_EXCL has only won the id: `driver.create` has not run,
    // so nothing billable exists and there is no box to keep the record as a
    // handle for. What the record WOULD do is resolve with no `extensions.budget`
    // — and that pins the issue's cap forever (see below).
    const runId = "budget-write-fails";
    const failing = Object.assign(Object.create(driver) as FakeDriver, {
      create: async (): Promise<ProviderVm> => {
        throw new Error("driver.create must never be reached");
      },
    });
    const realSet = store.set.bind(store);
    let calls = 0;
    store.set = ((id: string, patch: Parameters<typeof realSet>[1]) => {
      calls += 1;
      if (calls === 1) throw new Error("record write failed");
      return realSet(id, patch);
    }) as typeof store.set;

    // finally, not "after the assertion": a failed assertion left `store.set`
    // patched for the rest of the body, and would leak past this test entirely
    // the moment `store` stops being rebuilt in beforeEach.
    let err: Error;
    try {
      err = await rejection(provisionAdmittedRun(failing, store, { runId, budget }));
    } finally {
      store.set = realSet;
    }
    expect(err.message).toContain("record write failed");

    // REMOVED, not left open: a record that resolves with no extensions.budget
    // pins the issue's cap forever (the orphan guard expires only an admission
    // whose record does not resolve; only a priced cost_event retires one).
    expect(() => store.get(runId)).toThrow(/ENOENT/);
    expect(await driver.list(runId)).toEqual([]);
  });
});

describe("status.ts (list timeout)", () => {
  let dir: string;
  let store: RunRecordStore;
  let driver: FakeDriver;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "qds-status-timeout-"));
    driver = new FakeDriver(join(dir, "boxes"));
    store = new RunRecordStore({ dir: join(dir, "runs") });
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("omitted listTimeoutMs arms the 30s default and the timer is always cleared", async () => {
    // Every other test injects a timeout, so `?? 30_000` → `?? 0` (or `?? 1`)
    // stays green while production reports boxUnknown for every run. Observe
    // the delay the race actually arms, and that the losing timer is cleared.
    // Provision BEFORE the patch: the store's lock retry and the driver both
    // arm timers of their own, and any one of them landing in `armed` would
    // make the single-30s-timer assertion below pass or fail for reasons that
    // have nothing to do with the status timeout under test.
    await provisionAdmittedRun(driver, store, { runId: "default-timeout-run" });

    const realSetTimeout = globalThis.setTimeout;
    const realClearTimeout = globalThis.clearTimeout;
    const armed: { ms: unknown; handle: unknown }[] = [];
    const cleared: unknown[] = [];
    globalThis.setTimeout = ((fn: () => void, ms?: number, ...rest: unknown[]) => {
      const handle = (realSetTimeout as (...a: unknown[]) => unknown)(fn, ms, ...rest);
      armed.push({ ms, handle });
      return handle;
    }) as unknown as typeof globalThis.setTimeout;
    globalThis.clearTimeout = ((handle: unknown) => {
      cleared.push(handle);
      (realClearTimeout as (...a: unknown[]) => void)(handle);
    }) as unknown as typeof globalThis.clearTimeout;

    let rows: StatusRow[];
    try {
      rows = await statusAll({ driver, store });
    } finally {
      globalThis.setTimeout = realSetTimeout;
      globalThis.clearTimeout = realClearTimeout;
    }

    expect(rows).toHaveLength(1);
    expect(rows[0]!.state).toBe("live");
    // FILTERED, not exhaustive. The patch is global and unfiltered for the whole
    // await, so `armed` also records whatever the driver's I/O, the record
    // store's lock retry and Bun's internals happen to arm in that window, and
    // `cleared` can carry handles armed before the patch went in. Asserting the
    // exact array made this red intermittently on correct code — and a test that
    // gets rerun until green gates nothing at all.
    const armedDefault = armed.filter((a) => a.ms === 30_000);
    expect(armedDefault).toHaveLength(1);
    expect(cleared).toContain(armedDefault[0]!.handle);
  });

  test("a non-positive or non-finite listTimeoutMs is refused, never handed to setTimeout", async () => {
    for (const ms of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      const err = await refusal(
        statusAll({ driver, store, listTimeoutMs: ms }),
        2,
        "invalid-list-timeout",
      );
      expect(err.message).toContain("positive finite number");
      await refusal(
        statusRun({ driver, store, listTimeoutMs: ms }, "some-run"),
        2,
        "invalid-list-timeout",
      );
    }
  });
});

describe("status.ts (statusRun)", () => {
  let dir: string;
  let store: RunRecordStore;
  let driver: FakeDriver;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "qds-status-run-"));
    driver = new FakeDriver(join(dir, "boxes"));
    store = new RunRecordStore({ dir: join(dir, "runs") });
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  async function provision(runId: string, patch?: RunRecordPatch): Promise<RunRecord> {
    const { record } = await provisionAdmittedRun(driver, store, { runId });
    return patch === undefined ? record : store.set(runId, patch);
  }

  test("valid runId returns a single live row carrying the record's join key", async () => {
    const runId = "test-single-run";
    const rec = await provision(runId, { requestId: "req-single" });

    const row: StatusRow = await statusRun({ driver, store, listTimeoutMs: 1000 }, runId);
    expect(row.runId).toBe(runId);
    expect(row.state).toBe("live");
    expect(row.vmName).toBe(rec.vmName);
    expect(row.requestId).toBe("req-single");
  });

  test("a hyphenated id at the 63-char cap is accepted", async () => {
    // The one literal in the file. Every other reference to the boundary is
    // RUN_ID_MAX itself, so widening the constant to 253 kept this test green
    // while it still claimed to pin 63 — and the id becomes the box name, which
    // becomes a public hostname, where an RFC 1123 label caps at 63. A wider cap
    // mints unresolvable hostnames.
    expect(RUN_ID_MAX).toBe(63);
    const runId = `max-${"a".repeat(RUN_ID_MAX - 4)}`;
    expect(runId).toHaveLength(RUN_ID_MAX);
    await provision(runId);

    const row = await statusRun({ driver, store, listTimeoutMs: 1000 }, runId);
    expect(row.runId).toBe(runId);
    expect(row.state).toBe("live");
  });

  test("runId validation refuses as typed exit 2, on the canonical grammar and cap", async () => {
    const deps: StatusDeps = { driver, store, listTimeoutMs: 1000 };
    // Grammar: uppercase, whitespace, path traversal, a leading hyphen, empty.
    for (const bad of ["INVALID_ID", "with spaces", "../escape", "-leading", "", "under_score"]) {
      await refusal(statusRun(deps, bad), 2, "invalid-run-id");
    }
    // The cap now comes from run-record.ts, not a private copy that allowed
    // any length: 63 passes (above), 64 must refuse as usage, not as a store error.
    const err = await refusal(statusRun(deps, "a".repeat(RUN_ID_MAX + 1)), 2, "invalid-run-id");
    expect(err.message).toContain(String(RUN_ID_MAX));
  });

  test("a non-string runId is refused by the typeof guard, not by the regex", async () => {
    const deps: StatusDeps = { driver, store, listTimeoutMs: 1000 };
    // Every one of these COERCES to a string the grammar accepts ("null",
    // "undefined", "123"), so only the typeof guard can refuse them.
    for (const bad of [null, undefined, 123]) {
      await refusal(statusRun(deps, bad as unknown as string), 2, "invalid-run-id");
    }
  });

  test("an id that ends in a hyphen is refused as usage, never passed to the store", async () => {
    // RUN_ID_RE is `^[a-z0-9]([a-z0-9-]*[a-z0-9])?$` — an RFC 1123 label, since
    // the id becomes the box name and the box name becomes a public hostname.
    // A stale private copy (`^[a-z0-9][a-z0-9-]*$`) accepts all of these and
    // reaches the store as run-not-found (4); the canonical grammar refuses at 2.
    const deps: StatusDeps = { driver, store, listTimeoutMs: 1000 };
    for (const bad of ["trailing-", "a--", "-", "--"]) {
      await refusal(statusRun(deps, bad), 2, "invalid-run-id");
    }
  });

  test("interior hyphens stay legal — the minted id shape still resolves", async () => {
    // The tightening must not over-reject: `qds-<YYYYMMDD>-<6 hex>` is what
    // mintRunId() produces for every real run.
    const runId = "qds-20260821-a1b2c3";
    await provision(runId);
    const row = await statusRun({ driver, store, listTimeoutMs: 1000 }, runId);
    expect(row.state).toBe("live");
  });

  test("ENOENT → exit 4 with operator-facing content, mutating nothing", async () => {
    await provision("bystander-run");
    const before = store.list();
    const listSpy = mock((name?: string) => driver.list(name));

    const err = await refusal(
      statusRun({ driver: { list: listSpy }, store, listTimeoutMs: 1000 }, "nonexistent-run"),
      4,
      "run-not-found",
    );
    // Content, not key presence: toHaveProperty("message") passes for "".
    expect(err.message).toContain("nonexistent-run");
    expect(err.remediation).toContain("run ID");
    // Mutates NOTHING when not found: the record store is untouched. The driver
    // IS consulted — reading the substrate is not a mutation, and it is the
    // only way to tell "no such run" from "a box nobody has a record for".
    expect(store.list()).toEqual(before);
    expect(listSpy).toHaveBeenCalledWith("nonexistent-run");
  });

  test("no record but a LIVE box under the run id → orphan, never exit 4", async () => {
    // The record and the box are separately losable (operator record cleanup, a
    // --dir mismatch between dispatch and this query, the INV-1 crash window).
    // `statusAll` already calls this box `orphan`; the id-specific query denying
    // it exists is the operator being told a box that is alive and SPENDING is
    // not there — the unattributed spend this verb exists to surface.
    const runId = "recordless-but-billing";
    await driver.create(runId, SBX_OWNERSHIP_TAG);

    const row = await statusRun({ driver, store, listTimeoutMs: 1000 }, runId);
    expect(row.state).toBe("orphan");
    expect(row.runId).toBe(runId);
    expect(row.vmName).toBe(runId);
    expect(row).not.toHaveProperty("createdAt");
    expect(row).not.toHaveProperty("requestId");
    // And the same id through the fleet-wide verb agrees.
    const rows = await statusAll({ driver, store, listTimeoutMs: 1000 });
    expect(rows.map((r) => [r.runId, r.state])).toEqual([[runId, "orphan"]]);
  });

  test("a list failure on the ENOENT path still refuses as 4, never invents a box", async () => {
    // boxUnknown needs a record to hang off. With neither a record nor a usable
    // list there is nothing to report, and a timeout must not be read as a hit.
    for (const failing of [
      { list: async (): Promise<ProviderVm[]> => { throw new Error("list down"); } },
      { list: (): Promise<ProviderVm[]> => new Promise<ProviderVm[]>(() => {}) },
    ]) {
      await refusal(statusRun({ driver: failing, store, listTimeoutMs: 5 }, "gone-run"), 4, "run-not-found");
    }
  });

  test("no record and a FOREIGN box under the run id → still exit 4", async () => {
    // The ownership filter runs on this path too: somebody else's box named
    // after our run id is not our spend and must not be reported as our orphan.
    const runId = "foreign-collision";
    await driver.create(runId, SBX_OWNERSHIP_TAG);
    await refusal(
      statusRun({ driver: retagged(driver, "someone-elses-fleet"), store, listTimeoutMs: 1000 }, runId),
      4,
      "run-not-found",
    );
  });

  test("found record uses the same join logic (no vmName, no box → boxMissing)", async () => {
    const runId = "test-join-logic";
    store.create(runId);

    const row = await statusRun({ driver, store, listTimeoutMs: 1000 }, runId);
    expect(row.runId).toBe(runId);
    expect(row.state).toBe("boxMissing");
  });

  test("vmName set but the box is gone → boxMissing", async () => {
    const runId = "single-missing-box";
    const rec = await provision(runId);
    await driver.destroy(rec.vmName!);

    const row = await statusRun({ driver, store, listTimeoutMs: 1000 }, runId);
    expect(row.state).toBe("boxMissing");
    expect(row.vmName).toBe(rec.vmName);
  });

  test("list throws → boxUnknown for the single run too", async () => {
    const runId = "single-unknown-throw";
    await provision(runId);

    const row = await statusRun(
      {
        driver: {
          list: async (): Promise<ProviderVm[]> => {
            throw new Error("list unavailable");
          },
        },
        store,
        listTimeoutMs: 1000,
      },
      runId,
    );
    expect(row.state).toBe("boxUnknown");
  });

  test("list hangs past the timeout → boxUnknown for the single run too", async () => {
    const runId = "single-unknown-timeout";
    await provision(runId);

    const row = await statusRun(
      { driver: { list: () => new Promise<ProviderVm[]>(() => {}) }, store, listTimeoutMs: 5 },
      runId,
    );
    expect(row.state).toBe("boxUnknown");
  });

  test("a record whose box carries another name is listed UNFILTERED, and reads live", async () => {
    // The filter branch: `list(runId)` cannot see a box that is not named after
    // the run, so hardcoding `rec.runId` there reports boxMissing while the box
    // bills on — and no test constructed the join, because provisioning always
    // names the box after the run.
    const runId = "single-renamed-box";
    const rec = await provision(runId);
    await driver.destroy(rec.vmName!);
    await driver.create("some-other-box-name", SBX_OWNERSHIP_TAG);
    store.set(runId, { vmName: "some-other-box-name" });

    const listSpy = mock((name?: string) => driver.list(name));
    const row = await statusRun({ driver: { list: listSpy }, store, listTimeoutMs: 1000 }, runId);

    expect(listSpy).toHaveBeenCalledWith(undefined); // the whole fleet, not one name
    expect(row.state).toBe("live");
    expect(row.vmName).toBe("some-other-box-name");
  });

  test("crash window: no vmName but a live box under the run id → live", async () => {
    const runId = "single-crash-window";
    store.create(runId);
    await driver.create(runId, SBX_OWNERSHIP_TAG);

    const row = await statusRun({ driver, store, listTimeoutMs: 1000 }, runId);
    expect(row.state).toBe("live");
    expect(row.vmName).toBe(runId);
  });

  test("closed record over a LIVE box → closed + boxAlive, driver consulted", async () => {
    // A closed record no longer short-circuits the driver: teardown destroys
    // before it closes, so a live box here is one that never got destroyed.
    const runId = "test-closed-single";
    await provision(runId);
    store.close(runId);

    const listSpy = mock((name?: string) => driver.list(name));
    const row = await statusRun({ driver: { list: listSpy }, store, listTimeoutMs: 1000 }, runId);

    expect(row.state).toBe("closed");
    expect(row.runId).toBe(runId);
    expect(row.boxAlive).toBe(true);
    // WITH the run id: when the two candidate names agree, the driver's own name
    // filter is used rather than paging the whole fleet. `toHaveBeenCalled()`
    // alone could not tell that apart from an unfiltered list.
    expect(listSpy).toHaveBeenCalledWith(runId);
  });

  test("closed record whose box is gone → closed with boxAlive FALSE (the driver answered)", async () => {
    const runId = "test-closed-destroyed";
    const rec = await provision(runId);
    await driver.destroy(rec.vmName!);
    store.close(runId);

    const row = await statusRun({ driver, store, listTimeoutMs: 1000 }, runId);
    expect(row.state).toBe("closed");
    expect(row.boxAlive).toBe(false);
  });

  test("closed record + list failure → closed with boxAlive ABSENT (nothing is known)", async () => {
    const runId = "test-closed-listdown";
    const rec = await provision(runId);
    await driver.destroy(rec.vmName!);
    store.close(runId);

    const row = await statusRun(
      {
        driver: {
          list: async (): Promise<ProviderVm[]> => {
            throw new Error("list down");
          },
        },
        store,
        listTimeoutMs: 1000,
      },
      runId,
    );
    expect(row.state).toBe("closed");
    expect(row).not.toHaveProperty("boxAlive");
  });

  test("a CORRUPT record refuses as a typed exit-1, never a raw rethrow", async () => {
    // `readRecord` throws a bare `Error("malformed run record …")` with no
    // `code`, so the old `throw e` escaped untyped and `report()` printed a
    // stack dump. Every sibling path types this: statusAll's
    // record-store-unreadable, harvest/teardown's record-read-failed.
    const runId = "test-corrupt-record";
    store.create(runId); // record only — no box, so the driver has nothing to add
    writeFileSync(join(dir, "runs", `${runId}.json`), "{ not json");

    const err = await refusal(statusRun({ driver, store, listTimeoutMs: 1000 }, runId), 1, "record-read-failed");
    expect(err.message).toContain(runId);
    // NOT `orphan`: a record exists, so the box is claimed and an orphan row
    // would report exit 0 while denying the corruption the operator must fix.
    expect(err.remediation).not.toMatch(/STILL LIVE/);
  });

  test("a corrupt record over a LIVE box says so — the box is billing and undiscoverable otherwise", async () => {
    // The second loss the raw rethrow caused: the driver was never consulted, so
    // the box that record owns stayed invisible on the one query an operator
    // types when they already know the run id.
    const runId = "test-corrupt-live";
    await provision(runId); // a REAL box, named after the run id
    writeFileSync(join(dir, "runs", `${runId}.json`), "{ not json");

    const err = await refusal(statusRun({ driver, store, listTimeoutMs: 1000 }, runId), 1, "record-read-failed");
    expect(err.remediation).toContain(runId);
    expect(err.remediation).toMatch(/STILL LIVE/);
  });
});
