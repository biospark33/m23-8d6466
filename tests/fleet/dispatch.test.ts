/**
 * Dispatch tests (Story DF3.1): TDD — tests written first, repaired to the
 * bun:test/DI idioms after the original agent draft (import reassignment is
 * impossible in Bun; seams go through DispatchDeps).
 *
 * Coverage per story DoD:
 * - requestId resolution: supplied strict UUID v4 honoured; malformed + absent both mint fresh
 * - Caller-invented runId rejected; dispatcher-minted runId accepted via opts (AC2)
 * - Malformed briefs → FleetError exit 2, ZERO side effects (INV-2)
 * - Admission: OverBudgetError → exit 5, checkHeadroom allowed:false → exit 5
 * - {admitted:true} suppresses headroom call ONLY (budget still checked)
 * - Admission hand-off: the issue/run/estimate admitIssue was asked, ledger closed
 * - Ordering: record → box → key → fill → gate via call-order capture
 * - Cap hand-off: mintRunKey cap === admittedCeilingMicroUsd === manifest stamp === budget ext
 * - Gate failure: ready=false → FleetError exit 3, record OPEN, box NOT destroyed,
 *   gate outcome on the record, keyHash persisted (the key stays revocable)
 * - Ack shape asserted, and asserted to carry no key material
 * - 600s wall clock: injected ADVANCING clock, expiry and just-under boundary
 * - Public exposure happens only after the gate passes
 * - INV-4: no key material in logs, records or the ack
 */
import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import * as YAML from "yaml";

import { DEFAULT_QUOTA_LIMITS, type LoadedQuotaLimits } from "../../src/providers/quota.ts";

/** Fresh limits — NEVER mutate DEFAULT_QUOTA_LIMITS (shared, unfrozen reference). */
function limitsWith(overrides: Partial<typeof DEFAULT_QUOTA_LIMITS>): LoadedQuotaLimits {
  return { limits: { ...DEFAULT_QUOTA_LIMITS, ...overrides }, source: "default" };
}
import { RunRecordStore } from "../../src/providers/run-record.ts";
import { FakeDriver } from "../../src/providers/fake-driver.ts";
import type { ProviderVm } from "../../src/providers/driver.ts";
import type { SetupGateResult } from "../../src/providers/exedev/setup-gate.ts";
import { defaultKeyCapMicroUsd } from "../../src/providers/credentials.ts";
import { FakeKeyApi } from "../providers/fixtures/fake-key-api.ts";
import { type LogEntry, setLogSink } from "../../src/swarmclaw/log.ts";
import { statusRun } from "../../src/fleet/status.ts";
import {
  FleetError,
  fakeGate,
  mintRunId,
  dispatch,
  type DispatchDeps,
  type GateOpts,
} from "../../src/fleet/dispatch.ts";
import { goodLedger, overBudgetLedger } from "./helpers.ts";

/**
 * UUID v4, spelled out here rather than imported from the implementation's own
 * `isValidUuidV4`: a predicate loosened in `src/` would otherwise loosen the
 * test that is supposed to catch it, and the two would degrade together.
 */
const UUID_V4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** The dispatch wall-clock ceiling `DispatchDeps.timeoutMs` defaults to. */
const DEFAULT_TIMEOUT_MS = 600_000;

/**
 * The manifest path every brief here carries, RELATIVE to the containment root
 * (`deps().repoRoot`, the case's tmpdir).
 *
 * The schema refuses an ABSOLUTE `manifestPath` outright, because
 * `resolve(repoRoot, "/etc/shadow")` discards the root — absoluteness, not a
 * `..` segment, was the containment hole, and relative-with-no-`..` is
 * contained beneath any root at all. Dispatch resolves this against
 * `deps.repoRoot`, which is what makes it land on the file `validBrief` wrote.
 */
const MANIFEST_REL = join("manifests", "pipeline.json");

/**
 * The escaping fixture's path, also relative — a SYMLINK beneath the root whose
 * target resolves outside it. Relative and `..`-free, so the schema admits it;
 * only `loadManifest`'s realpath + beneath-root re-assertion can refuse it,
 * which is precisely the dispatch-side INV-2 gate under test.
 */
const ESCAPE_REL = join("manifests", "escape.json");

/**
 * Fixtures stay in `os.tmpdir()` and the containment root is INJECTED
 * (`deps.repoRoot`, defaulting to `process.cwd()`): nothing here writes into the
 * repo working tree, and no test mutates a process-global every other test file
 * in the run shares. `realpathSync` because macOS resolves `/var` →
 * `/private/var` — the containment check compares resolved paths, so an
 * unresolved fixture path makes the behaviour platform-dependent.
 */
const tmpRoot = realpathSync(mkdtempSync(join(tmpdir(), "df3-1-dispatch-")));

afterAll(() => rmSync(tmpRoot, { recursive: true, force: true }));

/**
 * A clock that starts at a fixed instant and only moves when a test moves it.
 *
 * `() => Date.now() + 601_000` is inert: dispatch takes its wall-clock BASELINE
 * from the same seam, so a constant offset reads as zero elapsed. Expiry is
 * only reachable by a clock that ADVANCES between the baseline and the check.
 */
function stepClock(): { clock: () => number; advance: (ms: number) => void } {
  let t = 1_700_000_000_000;
  return {
    clock: () => t,
    advance: (ms: number) => {
      t += ms;
    },
  };
}

describe("dispatch.ts (DF3.1 AC1-AC9, INV-1-INV-6, C1-C10)", () => {
  let dir: string;
  /**
   * A sibling of `dir`, for fixtures that must live OUTSIDE the containment
   * root. Per-test and removed with `dir`: minted straight under `tmpRoot` they
   * accumulated all file long and were swept only by `afterAll`, so a bail or a
   * mid-suite kill leaked them and any future assertion on `tmpRoot`'s contents
   * became order-dependent.
   */
  let outsideDir: string;
  let store: RunRecordStore;
  let driver: FakeDriver;
  let keyApi: FakeKeyApi;
  let logs: string[] = [];
  let entries: LogEntry[] = [];
  let restoreLog: (() => void) | undefined;

  beforeEach(() => {
    dir = realpathSync(mkdtempSync(join(tmpRoot, "run-")));
    outsideDir = realpathSync(mkdtempSync(join(tmpRoot, "outside-")));
    store = new RunRecordStore(join(dir, "runs"));
    driver = new FakeDriver(join(dir, "boxes"));
    keyApi = new FakeKeyApi();
    logs = [];
    entries = [];
    // Capture the module's own sink (INV-4 checks)
    restoreLog = setLogSink((e) => {
      entries.push(e);
      logs.push(JSON.stringify(e));
    });
  });

  afterEach(() => {
    restoreLog?.();
    rmSync(dir, { recursive: true, force: true });
    rmSync(outsideDir, { recursive: true, force: true });
  });

  // ─── helpers ─────────────────────────────────────────────────────────────────

  function validBrief(overrides: Partial<{ requestId: string; manifestPath: string }> = {}) {
    const manifestPath = join(dir, MANIFEST_REL);
    mkdirSync(dirname(manifestPath), { recursive: true });
    const manifest = {
      version: "1.0.0",
      pipelineId: "test-pipeline",
      runBudgetMs: 200_000,
      phases: [
        { name: "plan", kind: "engineer", description: "Draft the approach for the change", maxDurationMs: 10_000, retries: 0 },
        { name: "build", kind: "code", description: "Run the repository test suite", command: ["bun", "test"], maxDurationMs: 40_000, retries: 0 },
      ],
    };
    writeFileSync(manifestPath, JSON.stringify(manifest));

    return {
      repoSlug: "owner/repo",
      issueId: 42,
      commitSha: "a".repeat(40),
      manifestPath: MANIFEST_REL,
      repoUrl: "https://github.com/owner/repo",
      ...overrides,
    };
  }

  /**
   * `repoRoot` is the test's own temp dir, so the manifest-containment check has
   * a real root to enforce without anyone touching `process.cwd()`.
   *
   * `timeoutMs` is deliberately NOT injected: the production default is what
   * every test then exercises, so a changed default fails the clock tests
   * instead of passing invisibly behind an injected 600_000.
   */
  function deps(overrides: Partial<DispatchDeps> = {}): DispatchDeps {
    return {
      driver,
      keyApi,
      store,
      ledgerFactory: () => goodLedger(),
      repoRoot: dir,
      ...overrides,
    };
  }

  /**
   * The gate options `dispatch` composes at its own call site, spelled out in
   * full and with NO cast: `{ runId } as Parameters<typeof fakeGate>[2]` left
   * every other field `undefined` — a state the real dispatch path never
   * produces — so a probe that branched on one exercised an unreachable
   * configuration, and a widened `GateOpts` would not break compilation here.
   */
  const gateOpts: GateOpts = {
    runId: "gate-probe-run",
    commitSha: "a".repeat(40),
    requestId: "9f1754e8-1c32-4bc7-8e0d-34f39bc8e5a1",
  };

  /** The refusal log lines this dispatch emitted (`refuse`'s own contract). */
  function refusalLines(): LogEntry[] {
    return entries.filter((e) => e.operation === "fleet.dispatch" && e.phase === "refused");
  }

  // ─── requestId resolution (AC2) ─────────────────────────────────────────────────────

  test("AC2: supplied strict UUID v4 is honoured", async () => {
    const requestId = "9f1754e8-1c32-4bc7-8e0d-34f39bc8e5a1";
    const brief = validBrief({ requestId });
    const result = await dispatch(brief, deps());
    expect(result.requestId).toBe(requestId);
  });

  test("AC2: malformed requestId mints fresh (never exits 2)", async () => {
    const requestId = "not-a-uuid";
    const brief = validBrief({ requestId });
    const result = await dispatch(brief, deps());
    expect(result.requestId).not.toBe(requestId);
    expect(result.requestId).toMatch(UUID_V4_RE);
  });

  test("AC2: absent requestId mints fresh", async () => {
    const brief = validBrief();
    const result = await dispatch(brief, deps());
    expect(result.requestId).toMatch(UUID_V4_RE);
  });

  test("AC2: caller-invented runId rejected (only mintRunId values accepted via opts)", async () => {
    const brief = validBrief();
    try {
      // @ts-expect-error AC2: a caller-invented id is not a MintedRunId — the brand
      // refuses it at compile time; this asserts the runtime guard still refuses a cast.
      await dispatch(brief, deps(), { runId: "invented-by-caller" });
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(FleetError);
      const err = e as FleetError;
      // Not just "a FleetError": every later refusal is one too, and this test
      // is about the provenance guard specifically.
      expect(err.code).toBe("run-id-not-minted");
      expect(err.exitCode).toBe(2);
    }
    // Nothing was provisioned under the forged id.
    expect(readdirSync(store.dir)).toHaveLength(0);
    expect(await driver.list()).toHaveLength(0);
  });

  test("AC2: dispatcher-minted runId accepted via opts", async () => {
    const preMinted = mintRunId();
    const brief = validBrief();
    const result = await dispatch(brief, deps(), { runId: preMinted });
    expect(result.runId).toBe(preMinted);
  });

  test("mintRunId() re-exports newId('qds')", () => {
    const id = mintRunId();
    expect(id).toMatch(/^qds-\d{8}-[a-f0-9]{6}$/);
  });

  test("INV-4-bis: requestId is persisted on the record and surfaces on the status row", async () => {
    const requestId = "3c9f0b21-7a44-4d0e-b8b1-6f0c2e5a7d13";
    const result = await dispatch(validBrief({ requestId }), deps());

    expect(store.get(result.runId).requestId).toBe(requestId);

    // `fleet status` is the operator's only inspection surface — the join key
    // has to reach it, not just the record file.
    const row = await statusRun({ driver, store }, result.runId);
    expect(row.requestId).toBe(requestId);
    expect(row.state).toBe("live");
  });

  // ─── INV-2: validate before any side effect ───────────────────────────────────────────

  test("INV-2: unknown field → FleetError exit 2, zero provisioning", async () => {
    const brief = { ...validBrief(), unknownField: "should-reject" };
    const createSpy = mock(() => Promise.resolve({ name: "test", status: "running" } as ProviderVm));
    driver.create = createSpy;
    const mintSpy = mock(() =>
      Promise.resolve({ key: "sk-test", hash: "abc", limitUsd: 50, usageUsd: 0 }),
    );
    keyApi.createKey = mintSpy;

    try {
      await dispatch(brief, deps());
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(FleetError);
      const err = e as FleetError;
      expect(err.exitCode).toBe(2);
      expect(err.code).toBe("invalid-brief");
      expect(String(err.payload?.field)).toBe("unknownField");

      // Zero side effects
      expect(createSpy).not.toHaveBeenCalled();
      expect(mintSpy).not.toHaveBeenCalled();
      expect(readdirSync(store.dir)).toHaveLength(0);
    }
  });

  test("INV-2: missing repoSlug → FleetError exit 2, zero provisioning", async () => {
    const brief = validBrief();
    Reflect.deleteProperty(brief, "repoSlug");
    const createSpy = mock(() => Promise.resolve({ name: "test", status: "running" } as ProviderVm));
    driver.create = createSpy;

    try {
      await dispatch(brief, deps());
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(FleetError);
      const err = e as FleetError;
      expect(err.exitCode).toBe(2);

      expect(createSpy).not.toHaveBeenCalled();
      expect(readdirSync(store.dir)).toHaveLength(0);
    }
  });

  test("INV-2: bad commitSha → FleetError exit 2, zero provisioning", async () => {
    const brief = { ...validBrief(), commitSha: "not-40-hex" };
    const mintSpy = mock(() =>
      Promise.resolve({ key: "sk-test", hash: "abc", limitUsd: 50, usageUsd: 0 }),
    );
    keyApi.createKey = mintSpy;

    try {
      await dispatch(brief, deps());
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(FleetError);
      const err = e as FleetError;
      expect(err.exitCode).toBe(2);

      expect(mintSpy).not.toHaveBeenCalled();
      expect(readdirSync(store.dir)).toHaveLength(0);
    }
  });

  test("INV-2: a rejected brief never opens the ledger — no admission is spent", async () => {
    // The money-path half of INV-2, distinct from the record/box/key assertions
    // above: an implementation that admits first and validates after books the
    // issue's cap for a brief it then refuses, and the reservation outlives the
    // refusal (only a priced cost_event retires it).
    const brief = { ...validBrief(), unknownField: "x" };
    const ledgerFactory = mock(() => goodLedger());

    try {
      await dispatch(brief, deps({ ledgerFactory }));
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(FleetError);
      expect((e as FleetError).exitCode).toBe(2);
    }
    expect(ledgerFactory).not.toHaveBeenCalled();
    expect(readdirSync(store.dir)).toHaveLength(0);
  });

  test("a refusal that fires before the run id exists logs runId: null", async () => {
    const brief = { ...validBrief(), unknownField: "x" };

    // The file's own try/catch idiom rather than `.rejects.toThrow()`:
    // bun-types declares `expect(…).rejects` as plain `Matchers`, whose members
    // return `void`, so `await` on it is a no-op the compiler flags (TS80007)
    // and the assertion reads as awaited without being it.
    try {
      await dispatch(brief, deps());
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(FleetError);
    }

    const refusals = refusalLines();
    expect(refusals).toHaveLength(1);
    const refusal = refusals[0] as LogEntry;
    // `null`, not undefined and not "" — the absence is named, never fabricated.
    expect(refusal.runId).toBeNull();
    expect(refusal.requestId).toBe("unresolved");
    expect(refusal.status).toBe("error");
    expect((refusal.error as { code: string }).code).toBe("invalid-brief");
  });

  test("AC4: the host-side dispatch log records each refusal's code and issue identity", async () => {
    // The only OTHER read of this file asserts what it does NOT contain, and
    // `appendDispatchFailure` is called inside a try/catch that swallows to
    // stderr — so it could write the wrong `code`, drop `repoSlug`/`issueId`/
    // `requestId`, or fail on every single refusal, and the whole suite stayed
    // green (`refusalLines()` reads a different, in-process sink). This is the
    // AC4 evidence itself.
    const requestId = "6b1f2a90-3d55-4f21-9c0e-7a8b1d2e3f40";

    // A refusal from BEFORE the brief parsed, then one from after it: the two
    // together pin the documented "null, never '' and never a fabricated value"
    // shape as well as the populated one.
    try {
      await dispatch({ ...validBrief(), unknownField: "x" }, deps());
      expect.unreachable();
    } catch (e) {
      expect((e as FleetError).code).toBe("invalid-brief");
    }
    try {
      await dispatch(validBrief({ requestId }), deps({ ledgerFactory: overBudgetLedger }));
      expect.unreachable();
    } catch (e) {
      expect((e as FleetError).code).toBe("budget-exceeded");
    }

    // Beside the run records, so `--dir` moves the evidence with them.
    const lines = readFileSync(join(dir, "dispatch-log.jsonl"), "utf8").trim().split("\n");
    expect(lines).toHaveLength(2);
    const [early, admitted] = lines.map((l) => JSON.parse(l) as Record<string, unknown>);

    expect(early?.code).toBe("invalid-brief");
    expect(early?.repoSlug).toBeNull();
    expect(early?.issueId).toBeNull();
    expect(early?.requestId).toBeNull();

    expect(admitted?.code).toBe("budget-exceeded");
    expect(admitted?.repoSlug).toBe("owner/repo");
    // The NUMBER, not the ledger's stringified form — this file keys on it.
    expect(admitted?.issueId).toBe(42);
    expect(admitted?.requestId).toBe(requestId);
    expect(String(admitted?.message)).toContain("cap");
    expect(Number.isNaN(Date.parse(String(admitted?.timestamp)))).toBeFalse();
  });

  // ─── Refusals that fire before an admission is spent (INV-2) ────────────────────────

  /**
   * A brief whose `manifestPath` is INSIDE the root and resolves OUTSIDE it: a
   * symlink at `<root>/manifests/escape.json` pointing at a byte-identical copy
   * of the valid fixture under `outsideDir` (a sibling of `dir`, so outside both
   * the injected `repoRoot` and `process.cwd()`).
   *
   * The escape has to be a symlink now, not an absolute path. An absolute
   * `manifestPath` is refused by the SCHEMA (see the sibling test below), which
   * is a strictly earlier gate — routing this brief through it would prove the
   * schema again and leave dispatch's own containment gate, the subject of these
   * two tests, with no coverage at all. Relative and `..`-free passes the
   * schema, so only `loadManifest`'s realpath + beneath-root re-assertion can
   * refuse it.
   *
   * Byte-identical on purpose: the refusal must be the containment check, never
   * a parse complaint that would pass for the wrong reason.
   */
  function briefWithManifestOutsideRoot() {
    const brief = validBrief();
    const escapeTarget = join(outsideDir, "pipeline.json");
    copyFileSync(join(dir, MANIFEST_REL), escapeTarget);
    symlinkSync(escapeTarget, join(dir, ESCAPE_REL));
    return { ...brief, manifestPath: ESCAPE_REL };
  }

  test("INV-2: an absolute manifestPath is refused by the schema, naming the field", async () => {
    // The FIRST of the two containment gates, and the reason the second one is
    // exercised through a symlink below. `resolve(repoRoot, "/etc/shadow")`
    // discards the root entirely, so absoluteness — not a `..` segment — was
    // the hole; a schema with no repo root cannot do resolve-then-contain, and
    // relative-with-no-`..` IS the containment property expressed at that layer.
    const brief = { ...validBrief(), manifestPath: join(dir, MANIFEST_REL) };
    const ledgerFactory = mock(() => goodLedger());

    try {
      await dispatch(brief, deps({ ledgerFactory }));
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(FleetError);
      const err = e as FleetError;
      expect(err.exitCode).toBe(2);
      expect(err.code).toBe("invalid-brief");
      // Named, not merely refused — the operator has to know which field.
      expect(err.payload?.field).toBe("manifestPath");
      expect(JSON.stringify(err.payload?.issues)).toContain("must be relative to the repo root");
    }
    expect(ledgerFactory).not.toHaveBeenCalled();
    expect(readdirSync(store.dir)).toHaveLength(0);
    expect(await driver.list()).toHaveLength(0);
  });

  test("INV-2: a manifest symlinked out of the supplied repoRoot → exit 2 manifest-rejected, zero provisioning", async () => {
    // The root is the injected one, not the manifest's own directory: a root
    // derived from the candidate path makes every path its own root and the
    // beneath-root assertion vacuous. The seam must not have widened the guard.
    const brief = briefWithManifestOutsideRoot();
    const ledgerFactory = mock(() => goodLedger());

    try {
      await dispatch(brief, deps({ ledgerFactory }));
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(FleetError);
      const err = e as FleetError;
      expect(err.exitCode).toBe(2);
      expect(err.code).toBe("manifest-rejected");
      // CONTAINMENT specifically, not "the manifest could not be read": the
      // link's own name IS beneath the root and its target is a perfectly valid
      // manifest, so a guard that stopped at `lstat` — or one that only checked
      // existence — would load it. Only the realpath re-assertion says this.
      expect(err.message).toContain("resolves outside the run root");
      // The refusal names the root it enforced — the injected one, not cwd.
      expect(err.remediation).toContain(dir);
      expect(err.remediation).not.toContain(process.cwd());
    }
    expect(ledgerFactory).not.toHaveBeenCalled();
    expect(readdirSync(store.dir)).toHaveLength(0);
    expect(await driver.list()).toHaveLength(0);
  });

  test("INV-2: with no repoRoot supplied the containment root is process.cwd()", async () => {
    // The fallback is `process.cwd()`. Covered here so the default cannot rot
    // behind the injected root every other test uses — and asserted WITHOUT
    // mutating the process's cwd, which is shared by every other test file.
    //
    // This arm proves WHICH root the default is, not the beneath-root check
    // itself: `manifestPath` is now relative, so an escaping fixture would have
    // to be a symlink planted inside the real repo working tree, and no test
    // here writes there. The symlink escape is exercised against the injected
    // root above; the two roots run through the same `loadManifest` call.
    const brief = validBrief();

    try {
      await dispatch(brief, deps({ repoRoot: undefined }));
      expect.unreachable();
    } catch (e) {
      expect((e as FleetError).exitCode).toBe(2);
      expect((e as FleetError).code).toBe("manifest-rejected");
      expect((e as FleetError).remediation).toContain(process.cwd());
      // And NOT the injected root — the fixture exists beneath `dir`, so a
      // dispatch that ignored `repoRoot: undefined` and kept the injected value
      // would have loaded it and never reached this refusal at all.
      expect((e as FleetError).remediation).not.toContain(dir);
    }
    expect(readdirSync(store.dir)).toHaveLength(0);
    expect(await driver.list()).toHaveLength(0);
  });

  test("INV-2: a non-positive timeoutMs → exit 2 timeout-invalid, zero provisioning", async () => {
    // A ceiling nothing can satisfy must refuse at the boundary, not mid-run.
    try {
      await dispatch(validBrief(), deps({ timeoutMs: 0 }));
      expect.unreachable();
    } catch (e) {
      expect((e as FleetError).exitCode).toBe(2);
      expect((e as FleetError).code).toBe("timeout-invalid");
    }
    expect(readdirSync(store.dir)).toHaveLength(0);
    expect(await driver.list()).toHaveLength(0);
  });

  test("INV-2: a port outside 1..65535 → exit 2 port-invalid, zero provisioning", async () => {
    try {
      await dispatch(validBrief(), deps({ port: 0 }));
      expect.unreachable();
    } catch (e) {
      expect((e as FleetError).exitCode).toBe(2);
      expect((e as FleetError).code).toBe("port-invalid");
    }
    expect(readdirSync(store.dir)).toHaveLength(0);
    expect(await driver.list()).toHaveLength(0);
  });

  test("a re-dispatch under a run id that already has a record refuses before the admission", async () => {
    const preMinted = mintRunId();
    await dispatch(validBrief(), deps(), { runId: preMinted });

    // Booking the issue's cap a second time and then dying on EEXIST leaves the
    // reservation committed against an issue that got nothing for it.
    const ledgerFactory = mock(() => goodLedger());
    try {
      await dispatch(validBrief(), deps({ ledgerFactory }), { runId: preMinted });
      expect.unreachable();
    } catch (e) {
      expect((e as FleetError).exitCode).toBe(2);
      expect((e as FleetError).code).toBe("run-id-in-use");
    }
    expect(ledgerFactory).not.toHaveBeenCalled();
    expect(readdirSync(store.dir)).toHaveLength(1);
  });

  test("the LOSER of a same-runId race still refuses exit 2 run-id-in-use (store.create is the arbiter)", async () => {
    // The step-4 check the sibling above covers is a FAST PATH, not the
    // guarantee: two concurrent dispatches sharing an explicit `opts.runId`
    // (DF3.2's fan-out shape) both find no record, both pass it, and both commit
    // a reservation. `store.create`'s O_EXCL is what actually arbitrates, and
    // its EEXIST has to map back to the SAME exit-2 refusal — otherwise the
    // loser gets exit 1 `provision-failed`, which names the wrong cause and
    // tells the operator to go looking for a substrate fault that is not there.
    //
    // Nothing else injects an EEXIST from `store.create`: delete that arm of the
    // provisioning catch and every other test in this file still passes.
    const preMinted = mintRunId();
    const eexist = Object.assign(new Error("EEXIST: file already exists, open 'runs/…'"), {
      code: "EEXIST",
    });
    store.create = () => {
      throw eexist;
    };
    const ledgerFactory = mock(() => goodLedger());

    try {
      await dispatch(validBrief(), deps({ ledgerFactory }), { runId: preMinted });
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(FleetError);
      const err = e as FleetError;
      expect(err.exitCode).toBe(2);
      expect(err.code).toBe("run-id-in-use");
      expect(err.payload?.runId).toBe(preMinted);
      // The provider's errno stays diagnosis, never classification: an operator
      // greps the fleet code, so `EEXIST` must not have become it.
      expect(err.payload?.providerCode).toBeUndefined();
    }
    // This is the CONCURRENT branch, not the step-4 one: the admission was
    // already spent by the time the create refused. Asserting it is what tells
    // the two run-id-in-use sites apart — the sibling above asserts the
    // opposite, and without this pair either test could be satisfied by the
    // other's code path.
    expect(ledgerFactory).toHaveBeenCalled();
    // No box was ever created: `store.create` is the first half of the step.
    expect(await driver.list()).toHaveLength(0);
  });

  test("a SELF-MINTED id that collides is re-minted, and the run lands on the free one", async () => {
    // Nobody chose a minted id, so a collision is re-minted rather than refused
    // — and the loop that does it was untested: a `break` on the first collision
    // would dispatch under an id whose record belongs to another run, which is
    // the orphaned-reservation-then-EEXIST state the guard exists to prevent.
    const taken = new Set<string>();
    let probes = 0;
    let thirdProbe = "";
    const realGet = store.get.bind(store);
    store.get = (runId: string) => {
      probes += 1;
      // The first two minted ids are "already taken". Later reads — `store.set`
      // does its own read-modify-write through `get` — go to the real store.
      if (probes <= 2) {
        taken.add(runId);
        return { runId, createdAt: new Date().toISOString() } as ReturnType<typeof realGet>;
      }
      if (probes === 3) thirdProbe = runId;
      return realGet(runId);
    };

    const result = await dispatch(validBrief(), deps());

    expect(taken.size).toBe(2); // two DISTINCT ids, i.e. a fresh mint each time
    expect(taken.has(result.runId)).toBeFalse();
    expect(result.runId).toBe(thirdProbe);
    expect(readdirSync(store.dir)).toEqual([`${result.runId}.json`]);
  });

  test("run ids that ALL collide → exit 1 run-id-unmintable, blaming no other run", async () => {
    // The other end of the same loop: bounded, so a saturated run directory
    // refuses instead of spinning — and the refusal must not report the last
    // COLLIDING id as this dispatch's own, because that id belongs to someone
    // else's live run and the payload would be telling a tier-1 agent to tear
    // THAT down.
    const realGet = store.get.bind(store);
    let probes = 0;
    store.get = (runId: string) => {
      probes += 1;
      return { runId, createdAt: new Date().toISOString() } as ReturnType<typeof realGet>;
    };

    try {
      await dispatch(validBrief(), deps());
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(FleetError);
      const err = e as FleetError;
      expect(err.exitCode).toBe(1);
      expect(err.code).toBe("run-id-unmintable");
      expect(err.payload?.runId).toBeNull();
      expect(err.payload).not.toHaveProperty("teardownCommand");
      expect((refusalLines()[0] as LogEntry).runId).toBeNull();
    }
    // MINT_RETRIES (4) re-mints plus the first attempt. Pinned exactly: 1 is an
    // early `break` and anything unbounded is the spin the bound exists to stop.
    expect(probes).toBe(5);
    expect(readdirSync(store.dir)).toHaveLength(0);
    expect(await driver.list()).toHaveLength(0);
  });

  test("a run-record directory that cannot be READ refuses (exit 1) rather than reusing the id", async () => {
    // Absence is ENOENT and nothing else. An EACCES/EIO read the same way as
    // "free to reuse" hands the id to `store.create` on a store that cannot be
    // read at all — and an untyped escape costs the operator the dispatch-log
    // entry and the structured line every other exit owes them.
    const eacces = Object.assign(new Error("EACCES: permission denied, open 'runs/x.json'"), {
      code: "EACCES",
    });
    store.get = () => {
      throw eacces;
    };
    const ledgerFactory = mock(() => goodLedger());

    try {
      await dispatch(validBrief(), deps({ ledgerFactory }));
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(FleetError);
      const err = e as FleetError;
      expect(err.exitCode).toBe(1);
      expect(err.code).toBe("record-read-failed");
      expect(err.payload?.providerCode).toBe("EACCES");
      // Pre-provision: nothing to tear down.
      expect(err.payload).not.toHaveProperty("teardownCommand");
    }
    expect(ledgerFactory).not.toHaveBeenCalled();
    expect(await driver.list()).toHaveLength(0);
  });

  // ─── Admission: budget gate (AC7) ───────────────────────────────────────────────────

  test("AC7: OverBudgetError → FleetError exit 5 with DF2.8 fields, zero provisioning", async () => {
    const brief = validBrief();
    const createSpy = mock(() => Promise.resolve({ name: "test", status: "running" } as ProviderVm));
    driver.create = createSpy;
    const mintSpy = mock(() =>
      Promise.resolve({ key: "sk-test", hash: "abc", limitUsd: 50, usageUsd: 0 }),
    );
    keyApi.createKey = mintSpy;
    const ledger = overBudgetLedger();

    try {
      await dispatch(brief, deps({ ledgerFactory: () => ledger }));
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(FleetError);
      const err = e as FleetError;
      expect(err.exitCode).toBe(5);
      expect(err.code).toBe("budget-exceeded");
      expect(err.payload?.capMicroUsd).toBe(10_000_000);
      expect(err.payload?.spentMicroUsd).toBe(12_000_000);

      // Zero provisioning
      expect(createSpy).not.toHaveBeenCalled();
      expect(mintSpy).not.toHaveBeenCalled();
      expect(readdirSync(store.dir)).toHaveLength(0);
    }
    // The refusal path closes the handle too — a leaked SQLite handle per
    // refused dispatch is invisible until the fleet runs out of them.
    expect(ledger.closeCalls).toBe(1);
  });

  test("AC7: {admitted:true} still checks budget (only headroom suppressed)", async () => {
    const brief = validBrief();
    try {
      await dispatch(brief, deps({ ledgerFactory: overBudgetLedger }), { admitted: true });
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(FleetError);
      const err = e as FleetError;
      expect(err.exitCode).toBe(5);
      expect(err.code).toBe("budget-exceeded");
    }
  });

  test("AC7: admitIssue is asked about THIS issue, run and cap, and the ledger is closed", async () => {
    const brief = validBrief();
    const cap = 12_345_678;
    const ledger = goodLedger(cap);

    const result = await dispatch(brief, deps({ ledgerFactory: () => ledger }));

    expect(ledger.admitCalls).toHaveLength(1);
    const call = ledger.admitCalls[0] as (typeof ledger.admitCalls)[number];
    expect(call.input).toEqual({
      repoSlug: "owner/repo",
      // The ledger's issue_id column is text — the brief's number is stringified
      // exactly once, here, or the same issue books two different rows.
      issueId: "42",
      runId: result.runId,
      requestId: result.requestId,
    });
    // capForIssue(config, …) with no per-issue override → the config default.
    expect(call.capMicroUsd).toBe(cap);
    // DF2.3's backstop, not a re-derived one: the clamp is min(keyCap, remaining).
    expect(call.keyCapMicroUsd).toBe(defaultKeyCapMicroUsd);
    expect(ledger.closeCalls).toBe(1);
  });

  test("AC7: an admitted ceiling of ZERO → exit 5 no-ceiling, and nothing is provisioned", async () => {
    // Every other ledger fixture here admits with a positive ceiling, so this
    // guard — the only thing between an admitted run and an unspendable one —
    // had no test at all. Remove it and the dispatcher mints a $0 key, stamps
    // `limitMicroUsd: 0` into the manifest and fails at gate item D, i.e. exit 3
    // with a LIVE billable box that INV-5 then forbids tearing down, instead of
    // refusing before anything exists.
    //
    // A POSITIVE cap with a zero ceiling, which is the shape production
    // produces: the ceiling is min(keyCap, remaining), so an issue with cap left
    // on paper and nothing remaining admits at exactly this.
    const ledger = goodLedger(0, defaultKeyCapMicroUsd);
    const createSpy = mock(() => Promise.resolve({ name: "test", status: "running" } as ProviderVm));
    driver.create = createSpy;
    const mintSpy = mock((_name: string, limit: number) =>
      Promise.resolve({ key: "sk-test", hash: "abc", limitUsd: limit, usageUsd: 0 }),
    );
    keyApi.createKey = mintSpy;

    try {
      await dispatch(validBrief(), deps({ ledgerFactory: () => ledger }));
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(FleetError);
      const err = e as FleetError;
      expect(err.exitCode).toBe(5);
      expect(err.code).toBe("no-ceiling");
      expect(err.payload?.admittedCeilingMicroUsd).toBe(0);
      expect(err.payload?.capMicroUsd).toBe(defaultKeyCapMicroUsd);
      // Pre-provision, so no teardown advice for a run that does not exist.
      expect(err.payload).not.toHaveProperty("teardownCommand");
    }
    expect(createSpy).not.toHaveBeenCalled();
    expect(mintSpy).not.toHaveBeenCalled();
    expect(readdirSync(store.dir)).toHaveLength(0);
    // The admission WAS spent — this refusal cannot precede it, because the
    // ceiling under test is the decision's own output. The handle still closes.
    expect(ledger.admitCalls).toHaveLength(1);
    expect(ledger.closeCalls).toBe(1);
  });

  // ─── Admission: headroom gate (AC8) ───────────────────────────────────────────────

  test("AC8: checkHeadroom allowed:false → FleetError exit 5, zero provisioning", async () => {
    const brief = validBrief();
    const listSpy = mock(() =>
      Promise.resolve([
        { name: "box1", status: "running" },
        { name: "box2", status: "running" },
        { name: "box3", status: "running" },
      ] as ProviderVm[]),
    );
    driver.list = listSpy;

    const loaded = limitsWith({ maxVms: 3 }); // 3 live == ceiling → headroom 0

    const createSpy = mock(() => Promise.resolve({ name: "test", status: "running" } as ProviderVm));
    driver.create = createSpy;

    try {
      await dispatch(brief, deps({ quotaLimits: loaded }));
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(FleetError);
      const err = e as FleetError;
      expect(err.exitCode).toBe(5);
      expect(err.code).toBe("no-headroom");
      expect(createSpy).not.toHaveBeenCalled();
      expect(readdirSync(store.dir)).toHaveLength(0);
    }
  });

  test("AC8: checkHeadroom list-unverified → FleetError exit 5", async () => {
    const brief = validBrief();
    // driver.list throws → checkHeadroom reports list-unverified (fail-closed)
    driver.list = mock(() => Promise.reject(new Error("list timeout")));
    const createSpy = mock(() => Promise.resolve({ name: "test", status: "running" } as ProviderVm));
    driver.create = createSpy;
    const mintSpy = mock((_name: string, limit: number) =>
      Promise.resolve({ key: "sk-test", hash: "abc", limitUsd: limit, usageUsd: 0 }),
    );
    keyApi.createKey = mintSpy;

    try {
      await dispatch(brief, deps());
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(FleetError);
      const err = e as FleetError;
      expect(err.exitCode).toBe(5);
      expect(err.code).toBe("no-headroom");
      expect(err.payload?.reason).toBe("list-unverified");
    }
    // Fail-CLOSED, not merely fail-loud: an unverifiable roster that still
    // minted a key or wrote a record before refusing satisfies the exit code
    // above and leaves both behind. Same assertions as the `allowed:false`
    // sibling — the two paths refuse for different reasons but owe the same
    // "nothing happened".
    expect(createSpy).not.toHaveBeenCalled();
    expect(mintSpy).not.toHaveBeenCalled();
    expect(readdirSync(store.dir)).toHaveLength(0);
  });

  test("AC8: {admitted:true} suppresses the headroom call (a saturated fleet still dispatches)", async () => {
    const brief = validBrief();
    // Ceiling 0 with 0 live VMs: only passable if the headroom call is SKIPPED
    const loaded = limitsWith({ maxVms: 0 });

    const listSpy = mock(() => Promise.resolve([] as ProviderVm[]));
    driver.list = listSpy;

    const result = await dispatch(brief, deps({ quotaLimits: loaded }), { admitted: true });
    // The ack's SHAPE, not merely its existence: with `toBeDefined` the positive
    // half of this test rested entirely on the spy below, so a dispatch that
    // skipped the headroom call and then acked something structurally wrong
    // passed.
    expect(result).toMatchObject({
      runId: expect.stringMatching(/^qds-/),
      requestId: expect.stringMatching(UUID_V4_RE),
      state: "ready",
    });
    // EXACTLY zero: `checkHeadroom` is the only caller of `driver.list` on this
    // path, so "at most one" would be satisfied by the regression it is meant
    // to catch (one headroom call that happened to be allowed).
    expect(listSpy).not.toHaveBeenCalled();
  });

  // ─── INV-1 ordering: record → box → key → fill → gate ─────────────────────────────────

  test("INV-1: ordering asserted via call-order capture", async () => {
    const brief = validBrief();
    const callOrder: string[] = [];

    const originalCreate = store.create.bind(store);
    store.create = (runId: string) => {
      callOrder.push("store.create");
      return originalCreate(runId);
    };

    const originalDriverCreate = driver.create.bind(driver);
    driver.create = async (name: string, tag?: string) => {
      callOrder.push("driver.create");
      return originalDriverCreate(name, tag);
    };

    const originalMint = keyApi.createKey.bind(keyApi);
    keyApi.createKey = async (name: string, limit: number) => {
      callOrder.push("mint");
      return originalMint(name, limit);
    };

    const originalExec = driver.exec.bind(driver);
    driver.exec = async (vm: string, argv: string[], stdin?: string) => {
      if (argv[0] === "sh") callOrder.push("sh-exec"); // deliver + fill both ride sh -c
      return originalExec(vm, argv, stdin);
    };

    await dispatch(
      brief,
      deps({
        setupGate: async (drv, vm, o) => {
          callOrder.push("gate");
          return fakeGate(drv, vm, o);
        },
      }),
    );

    // Subsequence: record < box < mint < first sh-exec (deliver/fill) < gate.
    // Containment asserted first — indexOf's -1 would otherwise satisfy any
    // comparison for a call that never happened.
    const expectInOrder = (calls: string[], ...names: string[]): void => {
      for (const name of names) expect(calls).toContain(name);
      for (let i = 1; i < names.length; i++) {
        expect(calls.indexOf(names[i - 1] as string)).toBeLessThan(calls.indexOf(names[i] as string));
      }
    };
    expectInOrder(callOrder, "store.create", "driver.create", "mint", "sh-exec", "gate");
  });

  test("a raw failure inside the provisioning step is typed and still names the runId", async () => {
    // The create step STRADDLES the record: `provisionAdmittedRun` writes the
    // run record first (INV-1), then the box. An untyped throw escaping from
    // the second half carries no runId, so the CLI's failure line reported
    // `runId: null` for a run an operator can see in `fleet status` — exactly
    // when they need the id to tear it down.
    driver.create = mock(() => Promise.reject(new Error("substrate refused the box")));
    const brief = validBrief();
    // Held, not minted per call: the default `ledgerFactory` returns a fresh
    // throwaway, so `closeCalls` is unobservable — and a mid-provisioning throw
    // is exactly where a `close()` outside a `finally` gets skipped, leaking one
    // SQLite handle per failed dispatch until the fleet exhausts its fds.
    const ledger = goodLedger();
    let err: FleetError | undefined;
    try {
      await dispatch(brief, deps({ ledgerFactory: () => ledger }));
    } catch (e) {
      err = e as FleetError;
    }
    expect(err).toBeInstanceOf(FleetError);
    const e = err as FleetError;
    expect(e.exitCode).toBe(1);
    expect(e.message).toContain("substrate refused the box");
    const runId = e.payload?.runId;
    expect(typeof runId).toBe("string");
    // Not merely non-null — the id must name the record that is really on disk.
    expect(readdirSync(store.dir)).toContain(`${runId as string}.json`);
    expect(e.payload?.teardownCommand).toBe(`bun scripts/fleet.ts teardown ${runId as string}`);
    // `refuse` also files the refusal log line the dispatch-log evidence needs.
    expect(refusalLines()).toHaveLength(1);
    expect(ledger.closeCalls).toBe(1);
  });

  // ─── Cap hand-off (AC9) ─────────────────────────────────────────────────────────

  test("AC9: mintRunKey receives cap === admittedCeilingMicroUsd", async () => {
    const brief = validBrief();
    const admittedCeiling = 25_000_000; // half of the DF2.3 default
    const originalMint = keyApi.createKey.bind(keyApi);
    const mintSpy = mock((name: string, limit: number) => originalMint(name, limit));
    keyApi.createKey = mintSpy;

    await dispatch(brief, deps({ ledgerFactory: () => goodLedger(admittedCeiling) }));

    expect(mintSpy).toHaveBeenCalled();
    const limitArg = mintSpy.mock.calls[0]?.[1] as number;
    expect(limitArg).toBe(admittedCeiling / 1_000_000); // µ$ → USD at the HTTP boundary
  });

  test("AC9a: manifest stamped with limitMicroUsd = admittedCeilingMicroUsd", async () => {
    const brief = validBrief();
    const admittedCeiling = 30_000_000;

    const result = await dispatch(brief, deps({ ledgerFactory: () => goodLedger(admittedCeiling) }));

    const record = store.get(result.runId);
    const filled = await driver.exec(record.vmName as string, ["cat", "pipeline.yaml"]);
    // Parsed and compared NUMERICALLY: a substring assertion on "30000000" also
    // matches 300000000 and 30000000000, so a 10×/1000× unit-conversion error
    // in the stamp would pass. `YAML.parse` reads the delivered file under
    // either encoding (serializeManifest emits JSON, a YAML subset).
    const delivered = YAML.parse(filled.stdout) as { limitMicroUsd?: unknown };
    expect(delivered.limitMicroUsd).toBe(admittedCeiling);
  });

  test("AC9b: budget extension carries effectiveCeilingMicros = admittedCeilingMicroUsd", async () => {
    const brief = validBrief();
    // Cap ≠ ceiling on purpose: with the two equal, a dispatcher that
    // propagated `capMicroUsd` wherever the ceiling belongs passes every
    // assertion below. The ceiling is min(keyCap, remaining), i.e. the smaller.
    const admittedCeiling = 20_000_000;
    const cap = 75_000_000;

    const result = await dispatch(brief, deps({ ledgerFactory: () => goodLedger(admittedCeiling, cap) }));

    const record = store.get(result.runId);
    expect(record.extensions?.budget?.admittedCeilingMicroUsd).toBe(admittedCeiling);
    expect(record.extensions?.budget?.capMicroUsd).toBe(cap);

    // The run context handed to the box carries the same computed-once value
    const ctxFile = await driver.exec(record.vmName as string, ["cat", "run-context.json"]);
    const ctx = JSON.parse(ctxFile.stdout) as { effectiveCeilingMicros?: number };
    expect(ctx.effectiveCeilingMicros).toBe(admittedCeiling);

    // The manifest is the cap's only in-box source (AC9a) — the CEILING, not
    // the issue cap, is what the box may spend.
    const filled = await driver.exec(record.vmName as string, ["cat", "pipeline.yaml"]);
    expect((JSON.parse(filled.stdout) as { limitMicroUsd?: number }).limitMicroUsd).toBe(admittedCeiling);
  });

  // ─── Gate failure (AC3, INV-5) ─────────────────────────────────────────────────────

  test("AC3: gate ready=false → FleetError exit 3, record OPEN, box alive, gate outcome recorded", async () => {
    const brief = validBrief();
    const ledger = goodLedger();

    try {
      await dispatch(
        brief,
        deps({
          ledgerFactory: () => ledger,
          setupGate: async () => ({
            ready: false,
            failedItem: "A" as const,
            assertionCode: 1 as const,
            assertions: [{ item: "A" as const, ok: false, note: "HEAD mismatch" }],
            debugCommands: ["ssh box.exe.xyz cat /tmp/provision"],
            teardownCommand: "bun scripts/fleet.ts teardown the-run",
            vm: "test-box",
          }),
        }),
      );
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(FleetError);
      const err = e as FleetError;
      expect(err.exitCode).toBe(3);
      expect(err.code).toBe("setup-gate-failed");
      expect(err.payload?.assertionCode).toBe(1);
      expect(err.payload?.failedItem).toBe("A");

      // Record OPEN (no closedAt) and the failure recorded host-side
      const record = store.get(err.payload?.runId as string);
      expect(record.closedAt).toBeUndefined();

      // AC3: the refusal is on the RUN RECORD too — `fleet status` is where an
      // operator learns why the run is open.
      expect(record.extensions?.gate?.outcome).toBe("failed");
      expect(record.extensions?.gate?.failedItem).toBe("A");
      expect(record.extensions?.gate?.assertionCode).toBe(1);
      expect(Number.isNaN(Date.parse(String(record.extensions?.gate?.failedAt)))).toBeFalse();

      // A minted key is spendable the moment it exists. If the dispatcher dies
      // at the gate without persisting `keyHash`, the credential is live and
      // NOBODY can revoke it — the record is the only handle teardown has.
      expect(record.keyHash).toMatch(/^[0-9a-f]{64}$/);

      // Box NOT destroyed (INV-5: the evidence outlives the failure)
      const boxes = await driver.list();
      expect(boxes.some((b) => b.name === record.vmName)).toBeTrue();

      // The refusal line carries the run id once one exists — the counterpart
      // of the `runId: null` refusal above.
      const refusals = refusalLines();
      expect(refusals).toHaveLength(1);
      expect((refusals[0] as LogEntry).runId).toBe(record.runId);
    }
    expect(ledger.closeCalls).toBe(1);
  });

  test("INV-5 ordering: a failed gate never makes the box public", async () => {
    const brief = validBrief();
    const callOrder: string[] = [];

    const originalExpose = driver.expose.bind(driver);
    driver.expose = async (vm: string, port: number) => {
      callOrder.push("expose");
      return originalExpose(vm, port);
    };
    const originalSetPublic = driver.setPublic.bind(driver);
    driver.setPublic = async (vm: string) => {
      callOrder.push("setPublic");
      return originalSetPublic(vm);
    };

    try {
      await dispatch(
        brief,
        deps({
          port: 8080,
          setupGate: async (_drv, vm) => {
            callOrder.push("gate");
            return {
              ready: false,
              failedItem: "C" as const,
              assertionCode: 2 as const,
              assertions: [{ item: "C" as const, ok: false, note: "env file mode" }],
              debugCommands: [],
              teardownCommand: "bun scripts/fleet.ts teardown the-run",
              vm,
            };
          },
        }),
      );
      expect.unreachable();
    } catch (e) {
      expect((e as FleetError).code).toBe("setup-gate-failed");
    }
    // A box made public before the gate proves it is reachable while unproven —
    // and INV-5 then forbids tearing it down.
    expect(callOrder).toEqual(["gate"]);
  });

  test("INV-5 ordering: the box is exposed and made public only AFTER the gate passes", async () => {
    const brief = validBrief();
    const callOrder: string[] = [];

    const originalExpose = driver.expose.bind(driver);
    driver.expose = async (vm: string, port: number) => {
      callOrder.push("expose");
      return originalExpose(vm, port);
    };
    const originalSetPublic = driver.setPublic.bind(driver);
    driver.setPublic = async (vm: string) => {
      callOrder.push("setPublic");
      return originalSetPublic(vm);
    };

    const result = await dispatch(
      brief,
      deps({
        port: 8080,
        setupGate: async (drv, vm, o) => {
          callOrder.push("gate");
          return fakeGate(drv, vm, o);
        },
      }),
    );

    expect(callOrder).toEqual(["gate", "expose", "setPublic"]);
    expect(result.httpsUrl).toMatch(/^https:\/\//);
    expect(store.get(result.runId).ports).toEqual([8080]);
  });

  test("INV-5: a post-box failure with no code of its own → exit 1 dispatch-failed, box ALIVE, record OPEN", async () => {
    // The catch-all arm of the post-provision try/catch. Every other failure
    // after the box exists has its own code — `setup-gate-failed`,
    // `key-delivery-failed`, `expose-no-url`, `dispatch-timeout` — so nothing
    // reached `dispatch-failed` at all: delete it and the suite stays green
    // while the throw escapes untyped, which is a bare CLI exit 1 with no
    // dispatch-log entry, no runId and no teardown command for a LIVE box.
    //
    // `expose` is the sharpest carrier for it: dispatch claims `ports: [port]`
    // on the record BEFORE calling it, so this failure leaves a record
    // advertising a port nothing is listening on — which is the correct,
    // deliberate posture (an abandoned expose can still land), and is exactly
    // what the operator's teardown has to be pointed at.
    driver.expose = async () => {
      throw Object.assign(new Error("substrate refused the tunnel"), { code: "ECONNRESET" });
    };
    let setPublicCalls = 0;
    driver.setPublic = async () => {
      setPublicCalls += 1;
    };

    try {
      await dispatch(validBrief(), deps({ port: 8080 }));
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(FleetError);
      const err = e as FleetError;
      expect(err.exitCode).toBe(1);
      expect(err.code).toBe("dispatch-failed");
      expect(err.message).toContain("substrate refused the tunnel");
      expect(err.payload?.providerCode).toBe("ECONNRESET");
      const runId = err.payload?.runId as string;

      // INV-5's claims, all three: the operator's commands are on the payload…
      expect(err.payload?.teardownCommand).toBe(`bun scripts/fleet.ts teardown ${runId}`);
      expect(err.payload?.debugCommands).toEqual([`bun scripts/fleet.ts status ${runId}`]);
      expect(err.remediation).toContain("the box is ALIVE");

      // …the record is OPEN and carries the pre-claimed port with no URL…
      const record = store.get(runId);
      expect(record.closedAt).toBeUndefined();
      expect(record.ports).toEqual([8080]);
      expect(record.httpsUrl).toBeUndefined();
      expect(err.payload?.vmName).toBe(record.vmName);

      // …and THIS run's box is still there. A count alone passes when the run's
      // own VM is gone and an unrelated box exists.
      const boxes = await driver.list();
      expect(boxes.some((b) => b.name === record.vmName)).toBeTrue();
    }
    // Nothing was published: the failure fired before setPublic.
    expect(setPublicCalls).toBe(0);
  });

  // ─── Ack shape (AC2) ─────────────────────────────────────────────────────────────

  test("Ack shape {runId, requestId, state: 'ready', vmName, httpsUrl?}", async () => {
    const brief = validBrief();
    const result = await dispatch(brief, deps());

    expect(result).toMatchObject({
      runId: expect.stringMatching(/^qds-/),
      requestId: expect.stringMatching(UUID_V4_RE),
      state: "ready",
      vmName: expect.stringMatching(/^qds-/),
    });
    // Unconditional, because the shape is not in doubt: `deps()` supplies no
    // port, dispatch withholds one from `provisionAdmittedRun`, and the fake
    // substrate only mints a URL for an exposed port — so the no-port ack must
    // carry NO `httpsUrl` at all. (The with-port arm is asserted by the INV-5
    // exposure-ordering test above.) The old `if` never ran, so a dispatcher
    // that acked a URL for an unexposed box passed here.
    expect(result.httpsUrl).toBeUndefined();
  });

  // ─── 600s wall clock timeout ───────────────────────────────────────────────────────

  test("600s wall clock: expiry past the default ceiling throws FleetError exit 1, box alive", async () => {
    const brief = validBrief();
    const { clock, advance } = stepClock();

    try {
      await dispatch(
        brief,
        // No timeoutMs: the PRODUCTION default is the ceiling under test.
        deps({
          clock,
          setupGate: async (drv, vm, o) => {
            // Time passes ACROSS the gate — the longest await in a dispatch —
            // so the advance lands after the real work, exactly where the
            // ceiling has to be re-sampled. Advancing before the gate promise
            // reaches `within` instead makes that step abandon an in-flight
            // gate and throw dispatch-timeout from `within` rather than from
            // the post-gate re-sample, which is a different code path.
            const result = await fakeGate(drv, vm, o);
            advance(DEFAULT_TIMEOUT_MS + 1_000);
            return result;
          },
        }),
      );
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(FleetError);
      const err = e as FleetError;
      expect(err.exitCode).toBe(1);
      expect(err.code).toBe("dispatch-timeout");
      // "post-gate", not "gate": this expiry is the re-sample AFTER the gate
      // returned ready, so blaming the step named "gate" accused a gate that
      // passed all five assertions. `gateReady` says so on the payload.
      expect(err.payload?.step).toBe("post-gate");
      expect(err.payload?.gateReady).toBeTrue();
      // The default itself, not just "some ceiling" — a changed default would
      // otherwise be invisible here.
      expect(err.message).toContain(`${DEFAULT_TIMEOUT_MS} ms`);

      // Box left alive (INV-5 posture: teardown is the operator's call), and it
      // is THIS run's box — a count alone passes when the run's own VM is gone
      // and an unrelated box exists.
      const record = store.get(err.payload?.runId as string);
      const boxes = await driver.list();
      expect(boxes.some((b) => b.name === record.vmName)).toBeTrue();
    }
  });

  test("600s wall clock: just under the ceiling does NOT expire", async () => {
    const brief = validBrief();
    const { clock, advance } = stepClock();

    // Boundary control: without it, a ceiling regressed to 60s (or raised to
    // 6000s) still passes the expiry test above.
    const result = await dispatch(
      brief,
      deps({
        clock,
        setupGate: async (drv, vm, o) => {
          const result = await fakeGate(drv, vm, o);
          advance(DEFAULT_TIMEOUT_MS - 1_000);
          return result;
        },
      }),
    );
    expect(result.state).toBe("ready");
  });

  // ─── a non-Error throw still refuses, instead of crashing the error path ─────────────

  test("a driver that throws a non-Error still produces a typed refusal", async () => {
    // `throw` takes any value, and the driver is third-party code from
    // dispatch's point of view. Reading `.message` off `null` throws a
    // TypeError from INSIDE the catch block, which replaces the refusal the
    // operator needs — exit code, remediation, dispatch-log entry and all —
    // with an unrelated crash out of the error path itself.
    driver.create = async () => {
      throw null;
    };
    const ledger = goodLedger();

    try {
      await dispatch(validBrief(), deps({ ledgerFactory: () => ledger }));
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(FleetError);
      const err = e as FleetError;
      expect(err.exitCode).toBe(1);
      // The untyped throw carries no `code`/`remediation`, so both fall back.
      expect(err.code).toBe("provision-failed");
      expect(err.remediation).toBeTruthy();
      // The thrown VALUE is what got stringified, in the position the caught
      // error's message occupies. `toContain("null")` was satisfied by text this
      // module writes anyway (refusals elsewhere carry `runId: null`), so it
      // held even for a message that had dropped the throw entirely.
      expect(err.message).toBe(`provisioning failed for run ${err.payload?.runId as string}: null`);
    }
    // The error path is the one most likely to skip the close (see the
    // provisioning-failure test above).
    expect(ledger.closeCalls).toBe(1);
  });

  // ─── fakeGate probe B: the two failure arms are told apart ───────────────────────────

  test("gate item B distinguishes a missing manifest from an unstamped one", async () => {
    // Probe B fires BEFORE item D (which owns "manifest non-empty"), so it has
    // to name both of its own failures. The arms previously shared `exit 2`
    // with `grep`'s own operational-error code, and an existing-but-unstamped
    // manifest and a manifest that never landed are opposite diagnoses: one
    // sends the operator to the stamping step, the other to the fill step.
    const opts = gateOpts;

    const missing = await driver.create("box-probe-missing");
    const noManifest = await fakeGate(driver, missing.name, opts);
    const bMissing = noManifest.assertions.find((a) => a.item === "B");
    expect(bMissing?.ok).toBeFalse();
    // `cat`'s stderr is discarded, so absent and present-but-unreadable both
    // arrive as an empty body; the nonzero exit is what separates them from a
    // manifest that is genuinely present and empty, and it rides the note.
    expect(bMissing?.note).toContain("pipeline.yaml missing or unreadable");
    expect(bMissing?.note).toMatch(/cat exit [1-9]/);
    expect(bMissing?.note).not.toContain("limitMicroUsd absent");

    const unstamped = await driver.create("box-probe-unstamped");
    await driver.exec(unstamped.name, ["sh", "-c", "printf '%s\\n' '{\"phases\":[]}' > pipeline.yaml"]);
    const noStamp = await fakeGate(driver, unstamped.name, opts);
    const bUnstamped = noStamp.assertions.find((a) => a.item === "B");
    expect(bUnstamped?.ok).toBeFalse();
    expect(bUnstamped?.note).toContain("limitMicroUsd absent");
    expect(bUnstamped?.note).not.toContain("pipeline.yaml missing");

    // And the stamped manifest still passes B — without this the assertions
    // above are satisfied by a probe that fails unconditionally.
    const stamped = await driver.create("box-probe-stamped");
    await driver.exec(stamped.name, [
      "sh",
      "-c",
      "printf '%s\\n' '{\"limitMicroUsd\":1,\"phases\":[]}' > pipeline.yaml",
    ]);
    const ok = await fakeGate(driver, stamped.name, opts);
    expect(ok.assertions.find((a) => a.item === "B")?.ok).toBeTrue();

    // A manifest that landed and is EMPTY is the fill step half-done, not the
    // fill step skipped — the only arm `cat` can prove, since it is the only one
    // that exits 0.
    const empty = await driver.create("box-probe-empty");
    await driver.exec(empty.name, ["sh", "-c", ": > pipeline.yaml"]);
    const bEmpty = (await fakeGate(driver, empty.name, opts)).assertions.find((a) => a.item === "B");
    expect(bEmpty?.ok).toBeFalse();
    expect(bEmpty?.note).toContain("present but empty");
    expect(bEmpty?.note).not.toContain("missing");

    // The operational-error path: the manifest EXISTS and cannot be read. It
    // used to be reported as missing, sending the operator back to a fill step
    // that had already succeeded. Root reads a mode-000 file, so there is no
    // fault to inject there.
    if (process.getuid?.() !== 0) {
      const unreadable = await driver.create("box-probe-unreadable");
      await driver.exec(unreadable.name, [
        "sh",
        "-c",
        "printf '%s\\n' '{\"limitMicroUsd\":1,\"phases\":[]}' > pipeline.yaml && chmod 000 pipeline.yaml",
      ]);
      const bUnreadable = (await fakeGate(driver, unreadable.name, opts)).assertions.find(
        (a) => a.item === "B",
      );
      expect(bUnreadable?.ok).toBeFalse();
      expect(bUnreadable?.note).toContain("unreadable");
      expect(bUnreadable?.note).toMatch(/cat exit [1-9]/);
    }
  });

  test("gate items D and E inspect the manifest's CONTENT, not just its keys", async () => {
    // D used to re-test "manifest non-empty", which item B's own first arm has
    // already proved by the time D runs — it could not fail, so the
    // five-assertion gate was effectively four. It now checks that the stamped
    // ceiling is spendable, and E that the phases list has phases in it.
    //
    // Every box here carries a mode-600 `.env`, because probing STOPS at the
    // first failure: without item C passing, D and E never execute and the
    // assertions below would all be about C.
    const gateOn = async (name: string, manifest: string): Promise<SetupGateResult> => {
      const box = await driver.create(name);
      await driver.exec(box.name, [
        "sh",
        "-c",
        `printf '%s' '${manifest}' > pipeline.yaml && : > .env && chmod 600 .env`,
      ]);
      return fakeGate(driver, box.name, gateOpts);
    };

    // Stamped, so B passes — and worthless, so D must not.
    const zero = await gateOn("box-probe-zero", '{"limitMicroUsd":0,"phases":[{"name":"plan"}]}');
    expect(zero.failedItem).toBe("D");
    expect(zero.assertionCode).toBe(3);
    expect(zero.assertions.find((a) => a.item === "D")?.note).toContain("not a positive integer");

    // A ceiling that is a STRING is the µ$/USD confusion in its other form: a
    // presence check passes it and the box then has no numeric ceiling at all.
    const stringly = await gateOn("box-probe-stringly", '{"limitMicroUsd":"50","phases":[{"name":"plan"}]}');
    expect(stringly.failedItem).toBe("D");

    const noPhases = await gateOn("box-probe-nophases", '{"limitMicroUsd":1,"phases":[]}');
    expect(noPhases.failedItem).toBe("E");
    expect(noPhases.assertionCode).toBe(4);

    // Positive control: without it every assertion above is satisfied by a gate
    // that fails unconditionally.
    const good = await gateOn("box-probe-good", '{"limitMicroUsd":1,"phases":[{"name":"plan"}]}');
    expect(good.ready).toBeTrue();
    expect(good.failedItem).toBeUndefined();
  });

  // ─── INV-4: no key material in logs, records or the ack ──────────────────────────────

  /**
   * The POSITIVE CONTROL every absence proof below needs: the exec invocation
   * that actually carries the plaintext key into the box.
   *
   * `deliverRunKey` keeps the key out of argv and puts it on STDIN
   * (src/providers/credentials.ts — `deliverScript(envFile)` takes only the
   * env-file path), so this echoes the WHOLE invocation, which is what a real
   * exec wrapper reports on a failure and the only shape that puts the key in
   * reach of a sink. Without it, "no sink contains the key" is satisfied by a
   * dispatch where the key never came near one — it would stay green with every
   * redaction deleted, and it would stay green if `deliverRunKey` stopped being
   * called at all. The failure-path siblings further down already do this; the
   * success-path ones did not.
   */
  function captureKeyDelivery(): () => string {
    let echoed = "";
    const realExec = driver.exec.bind(driver);
    driver.exec = async (vm: string, argv: string[], stdin?: string) => {
      // The FIRST stdin-carrying exec only. `fillRun` writes `pipeline.yaml` and
      // `run-context.json` over stdin too and runs after the key delivery, so
      // last-one-wins captured a manifest write and the control failed on a
      // dispatch that had delivered the key perfectly well. Step order is
      // mint → deliver → fill (INV-1, asserted by the ordering test above).
      if (stdin !== undefined && echoed === "") echoed = `exec: ${argv.join(" ")} <<<${stdin}`;
      return realExec(vm, argv, stdin);
    };
    return () => echoed;
  }

  test("INV-4: no key material in log lines", async () => {
    const brief = validBrief();
    // The REAL `(name, limit)` signature, even where the values are unused: a
    // zero-arg stand-in lets the dispatcher pass nothing, pass the arguments in
    // the wrong order, or hand µ$ where USD belongs, and nothing here would
    // notice — leaving the µ$→USD conversion pinned by the AC9 test alone.
    const knownKey = "sk-or-known-key-material-12345";
    keyApi.createKey = async (_name: string, limit: number) => ({
      key: knownKey,
      hash: "abc123",
      limitUsd: limit,
      usageUsd: 0,
    });
    const delivered = captureKeyDelivery();

    await dispatch(brief, deps());

    // Positive controls, BOTH required: `some(...)` on an EMPTY array is false,
    // so the absence proof means nothing unless lines were captured — and an
    // absence proof over a run where the plaintext never reached a sink's reach
    // is vacuous too (see `captureKeyDelivery`).
    expect(logs.length).toBeGreaterThan(0);
    expect(delivered()).toContain(knownKey);
    expect(logs.some((l) => l.includes("sk-or-known-key-material"))).toBeFalse();
  });

  test("INV-4: no key material in record write", async () => {
    const brief = validBrief();
    const knownKey = "sk-test-known-key-99999";
    keyApi.createKey = async (_name: string, limit: number) => ({
      key: knownKey,
      hash: "deadbeef",
      limitUsd: limit,
      usageUsd: 0,
    });
    const delivered = captureKeyDelivery();

    const result = await dispatch(brief, deps());
    const record = store.get(result.runId);

    // Control: the plaintext really was in flight during this dispatch.
    expect(delivered()).toContain(knownKey);
    // keyHash present, plaintext absent
    expect(record.keyHash).toBe("deadbeef");
    expect(JSON.stringify(record)).not.toContain(knownKey);
  });

  test("INV-4: no key material in the dispatch ack", async () => {
    const brief = validBrief();
    const knownKey = "sk-test-ack-leak-4242";
    keyApi.createKey = async (_name: string, limit: number) => ({
      key: knownKey,
      hash: "cafebabe",
      limitUsd: limit,
      usageUsd: 0,
    });
    const delivered = captureKeyDelivery();

    const result = await dispatch(brief, deps());

    // Control: the plaintext really was in flight during this dispatch.
    expect(delivered()).toContain(knownKey);
    // The ack is printed to stdout by the CLI. `toMatchObject` above ignores
    // extra keys, so a regression that hangs the plaintext off the ack would
    // leak it there undetected.
    expect(JSON.stringify(result)).not.toContain(knownKey);
    expect(result).not.toHaveProperty("key");
    expect(result).not.toHaveProperty("openrouterKey");
  });

  // ─── every exit is a refusal: no untyped throw reaches the CLI ───────────────────────

  test("an UNTYPED ledger failure refuses (exit 5) instead of escaping as a bare throw", async () => {
    // Not an OverBudgetError and not a CostLedgerError: a raw bun:sqlite
    // SQLITE_BUSY, an ENOENT/EACCES on the ledger file, a TypeError out of a
    // misconfigured ledgerFactory. These bypassed `refuse` entirely — no
    // dispatch-log entry (AC4 evidence), no structured line, no runId on the
    // payload, and a bare CLI exit 1 for what the module documents as an
    // admission refusal.
    const sqliteBusy = Object.assign(new Error("database is locked"), { code: "SQLITE_BUSY" });

    try {
      await dispatch(
        validBrief(),
        deps({
          ledgerFactory: () => {
            throw sqliteBusy;
          },
        }),
      );
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(FleetError);
      const err = e as FleetError;
      expect(err.exitCode).toBe(5);
      // The FLEET code stays fixed; the provider's errno rides the payload, so
      // `admission-failed` remains greppable across every substrate failure.
      expect(err.code).toBe("admission-failed");
      expect(err.payload?.providerCode).toBe("SQLITE_BUSY");
      // The run id this dispatch settled on in step 4, in full — `toBe(itself)`
      // was satisfied by `undefined === undefined`, so the payload carrying NO
      // id at all (the very thing this line exists to pin, since the structured
      // line joins on it) passed. The refusal fires from step 5, after the id is
      // chosen and before anything is provisioned.
      expect(err.payload?.runId).toMatch(/^qds-\d{8}-[a-f0-9]{6}$/);
      // Pre-provision, so no commands: nothing exists for the operator to tear
      // down, and `refuse` gates those on `ctxProvisionAttempted`, not on "an id
      // was chosen".
      expect(err.payload).not.toHaveProperty("teardownCommand");
      expect(err.payload).not.toHaveProperty("debugCommands");
      // The structured line joins on the same id.
      expect((refusalLines()[0] as LogEntry).runId).toBe(err.payload?.runId as string);
      expect(refusalLines()).toHaveLength(1);
    }
    // INV-2: the refusal fired before any provisioning.
    expect(readdirSync(store.dir)).toHaveLength(0);
    expect(await driver.list()).toHaveLength(0);
  });

  test("a headroom load failure refuses (exit 5) instead of escaping as a bare throw", async () => {
    // In production the trigger is `checkHeadroom`'s default parameter,
    // `limits = loadQuotaLimits()`, which throws QuotaLimitsError for malformed
    // JSON / an unknown key / a non-positive value / EACCES — and the CLI never
    // passes deps.quotaLimits. That path needs a process-global
    // ($QDS_QUOTA_LIMITS_FILE), so the same throw is provoked through the
    // injectable half: a malformed LoadedQuotaLimits. Either way the call sat
    // in no try/catch at all.
    try {
      await dispatch(
        validBrief(),
        deps({ quotaLimits: {} as unknown as LoadedQuotaLimits }),
      );
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(FleetError);
      const err = e as FleetError;
      expect(err.exitCode).toBe(5);
      expect(err.code).toBe("headroom-failed");
      expect(refusalLines()).toHaveLength(1);
    }
    expect(readdirSync(store.dir)).toHaveLength(0);
    expect(await driver.list()).toHaveLength(0);
  });

  test("INV-4: a driver that echoes the delivered key in its error never lands it in a sink", async () => {
    // The ordinary way an exec wrapper reports a failure is to include the
    // command it ran — and `deliverRunKey` hands the plaintext key to
    // `driver.exec`. That message used to be interpolated into `dispatch failed
    // after the box was created: …`, which reaches the dispatch log, the
    // structured line AND the returned FleetError; `redactUrls` only matches
    // `https?://…`, so a bare token survived every one of them.
    // The real OpenRouter shape, so the assertions below also cover the
    // `sk-or-v1-` PREFIX: a redactor that trimmed the random tail and left the
    // issuer prefix would still tell an attacker which vault to try.
    const knownKey = "sk-or-v1-leakydeliverykey31337";
    keyApi.createKey = async (_name: string, limit: number) => ({
      key: knownKey,
      hash: "beefbeef",
      limitUsd: limit,
      usageUsd: 0,
    });
    // Built from the ARGUMENTS, not hand-spelled: `deliverRunKey` deliberately
    // keeps the key out of argv and puts it on STDIN
    // (src/providers/credentials.ts:363 — `deliverScript(envFile)` takes only
    // the env-file path), so a fake that echoes argv alone carries no key at
    // all and this whole test passes with the redaction switched off. Echoing
    // the whole invocation is what a real exec wrapper does when it reports a
    // failed command, and it is the only shape that puts the key in reach of
    // the sink.
    let echoed = "";
    driver.exec = async (_vm: string, argv: string[], stdin?: string) => {
      echoed = `exec failed: ${argv.join(" ")} <<<${stdin ?? ""}`;
      throw new Error(echoed);
    };

    try {
      await dispatch(validBrief(), deps());
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(FleetError);
      const err = e as FleetError;
      expect(err.exitCode).toBe(1);
      expect(err.code).toBe("key-delivery-failed");
      // The whole envelope, not just the message: remediation and payload are
      // operator-facing sinks too.
      const envelope = JSON.stringify({ m: err.message, r: err.remediation, p: err.payload });
      expect(envelope).not.toContain(knownKey);
      expect(envelope).not.toContain("sk-or-v1-");
    }
    // POSITIVE CONTROL on the fake itself. Every assertion below is an ABSENCE
    // proof, and an absence proof over a message that never carried the key is
    // vacuous — it would stay green with the redaction deleted. This is the one
    // assertion here that fails if `deliverRunKey` stops handing the plaintext
    // to `driver.exec`, at which point these tests need rewriting rather than
    // quietly congratulating themselves.
    expect(echoed).toContain(knownKey);

    // ── the FLEET-side half, kept distinct from the providers-side half below
    // so a regression in either is attributable to one module.
    //
    // Dispatch's OWN sinks: its structured lines and the host-side dispatch log
    // (AC4 evidence). Positive control first — `some` on an empty array is
    // false, so the absence proof is worthless without lines to search.
    const own = entries.filter((e) => e.operation === "fleet.dispatch");
    expect(own.length).toBeGreaterThan(0);
    const ownText = JSON.stringify(own);
    expect(ownText).not.toContain(knownKey);
    expect(ownText).not.toContain("sk-or-v1-");
    const dispatchLog = readFileSync(join(dir, "dispatch-log.jsonl"), "utf8");
    expect(dispatchLog).not.toContain(knownKey);
    expect(dispatchLog).not.toContain("sk-or-v1-");

    // ── the PROVIDERS-side half: NO sink may carry the plaintext, whichever
    // module owns it. `deliverRunKey` logs through credentials.ts's own `timed`
    // (src/providers/credentials.ts:175), which is a different helper from
    // `step-log.ts`'s `timedLoggedStep` — both now apply `redactSecrets`, and
    // this asserts across every operation so a third logging helper cannot
    // appear without one.
    //
    // An equality on the whole leaking SET rather than a `some(...)`: the
    // failure message then names the operation that leaked, which is the one
    // thing the operator needs and a boolean throws away.
    const leaking = entries.filter((e) => JSON.stringify(e).includes(knownKey)).map((e) => e.operation);
    expect(leaking).toEqual([]);
  });

  test("an expired ceiling provisions NOTHING — the step is never started", async () => {
    // `within` used to take a PROMISE, so every call site evaluated its argument
    // eagerly: `provisionAdmittedRun(…)` was already in flight when the deadline
    // was checked, the record and the box were created and billed anyway, and
    // the refusal carried no vmName because `ctxVmName` was never assigned.
    const { clock, advance } = stepClock();

    try {
      await dispatch(
        validBrief(),
        deps({
          clock,
          // The last seam before the create step — the ceiling is exhausted
          // between admission and provisioning.
          ledgerFactory: () => {
            advance(DEFAULT_TIMEOUT_MS + 1_000);
            return goodLedger();
          },
        }),
      );
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(FleetError);
      const err = e as FleetError;
      expect(err.exitCode).toBe(1);
      expect(err.code).toBe("dispatch-timeout");
      expect(err.payload?.step).toBe("create");
      expect(err.payload).not.toHaveProperty("vmName");
    }
    // The point of the fix: an abandoned create still made a record and a box.
    expect(readdirSync(store.dir)).toHaveLength(0);
    expect(await driver.list()).toHaveLength(0);
  });

  test("INV-4-bis: a malformed deps.requestId refuses (exit 2) rather than being silently re-minted", async () => {
    // The CLI builds the run-record store and the driver with the id it
    // resolved, then hands it back here. Dropped silently, a malformed one made
    // the resolver mint a FRESH id, so the record's and the driver's log lines
    // carried a different correlation id from the ack — the exact cross-layer
    // split INV-4-bis exists to prevent, with no error anywhere.
    try {
      await dispatch(validBrief(), deps({ requestId: "not-a-uuid" }));
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(FleetError);
      const err = e as FleetError;
      expect(err.exitCode).toBe(2);
      expect(err.code).toBe("invalid-request-id");
    }
    expect(readdirSync(store.dir)).toHaveLength(0);
  });

  test("INV-6: a SHORT secret path segment is redacted from the whole refusal envelope", async () => {
    // The rule was length-based (`/\\/[^/]{16,}/`), so an 11-character token in
    // a URL path reached the dispatch log, the structured line and the
    // FleetError intact — length is not a property of a secret. `remediation`
    // was not redacted at all, only `message`.
    driver.create = async () => {
      throw Object.assign(new Error("create failed: https://exe.xyz/vm/abc123token"), {
        code: "ECONNRESET",
        remediation: "retry against https://exe.xyz/vm/abc123token",
      });
    };

    try {
      await dispatch(validBrief(), deps());
      expect.unreachable();
    } catch (e) {
      const err = e as FleetError;
      expect(err.code).toBe("provision-failed");
      expect(err.payload?.providerCode).toBe("ECONNRESET");
      expect(err.message).not.toContain("abc123token");
      expect(err.remediation).not.toContain("abc123token");
      // The host survives — an operator has to be able to tell which substrate
      // the line is about.
      expect(err.message).toContain("https://exe.xyz");
    }
    expect(logs.some((l) => l.includes("abc123token"))).toBeFalse();
  });

  test("C7: an author-supplied limitMicroUsd never reaches the box — the admitted ceiling does", async () => {
    // AC9a makes the manifest the cap's ONLY in-box carrier, so a hand-authored
    // ceiling in the source manifest is an attempt to name the number the budget
    // gate is supposed to name. Stripped at dispatch's host-side read, not in
    // `loadManifest` — the runner reads the already-stamped manifest back
    // through that same loader and must keep the stamp.
    const manifestRel = join("manifests", "authored-limit.json");
    mkdirSync(join(dir, "manifests"), { recursive: true });
    writeFileSync(
      join(dir, manifestRel),
      JSON.stringify({
        version: "1.0.0",
        pipelineId: "test-pipeline",
        runBudgetMs: 200_000,
        limitMicroUsd: 999_000_000,
        phases: [
          { name: "plan", kind: "engineer", description: "Draft the approach for the change", maxDurationMs: 10_000, retries: 0 },
          { name: "build", kind: "code", description: "Run the repository test suite", command: ["bun", "test"], maxDurationMs: 40_000, retries: 0 },
        ],
      }),
    );

    const admittedCeiling = 250_000;
    const result = await dispatch(
      { ...validBrief(), manifestPath: manifestRel },
      deps({ ledgerFactory: () => goodLedger(admittedCeiling) }),
    );

    const delivered = await driver.exec(result.vmName, ["sh", "-c", "cat pipeline.yaml"]);
    expect(JSON.parse(delivered.stdout).limitMicroUsd).toBe(admittedCeiling);
  });

  test("INV-4: an ABANDONED deliver that echoes the key never lands it on the abandoned-step line", async () => {
    // The sibling test above covers the RACE-WON path, where `deliverRunKey`'s
    // rejection reaches dispatch and the fixed-message catch swallows the text.
    // This is the other half: when the wall clock wins, the race has already
    // rejected with the timeout, so that catch never sees the provider error at
    // all — `within`'s abandoned handler does, and it logged the raw message
    // through `redactUrls`, which only matches `https?://…`. A bare token went
    // straight into the structured log.
    const knownKey = "sk-or-v1-abandonedleakykey31337";
    keyApi.createKey = async (_name: string, limit: number) => ({
      key: knownKey,
      hash: "beefbeef",
      limitUsd: limit,
      usageUsd: 0,
    });

    // Which STEP expires is pinned by the injected clock rather than by racing
    // real timers: the budget is spent inside `createKey`, i.e. during `mint`,
    // whose own timer was already armed with the full ceiling. `deliver` is then
    // the first step to compute a near-zero remainder — deterministically, and
    // without every earlier step running against a hair-trigger deadline.
    const { clock, advance } = stepClock();
    const mintKey = keyApi.createKey.bind(keyApi);
    keyApi.createKey = async (name: string, limit: number) => {
      advance(DEFAULT_TIMEOUT_MS - 30);
      return mintKey(name, limit);
    };

    // `deliverRunKey` is the ONLY exec that carries stdin (credentials.ts:371),
    // and the key rides on stdin rather than argv — so this echoes the whole
    // invocation, which is what a real exec wrapper reports on a failure and the
    // only shape that puts the key within reach of a sink.
    let echoed = "";
    const realExec = driver.exec.bind(driver);
    driver.exec = async (vm: string, argv: string[], stdin?: string) => {
      if (stdin === undefined) return realExec(vm, argv, stdin);
      echoed = `exec failed: ${argv.join(" ")} <<<${stdin}`;
      // Outlives the 30 ms remainder above, so the race is ABANDONED first and
      // this rejection lands on the abandoned handler with no other subscriber.
      await new Promise((r) => setTimeout(r, 250));
      throw new Error(echoed);
    };

    try {
      await dispatch(validBrief(), deps({ clock }));
      expect.unreachable();
    } catch (e) {
      const err = e as FleetError;
      expect(err.code).toBe("dispatch-timeout");
      expect(err.payload?.step).toBe("deliver");
    }
    // The handler fires on the abandoned promise, after dispatch has returned.
    await new Promise((r) => setTimeout(r, 400));

    // POSITIVE CONTROLS, both required: an absence proof over a line that was
    // never emitted, or over a message that never carried the key, is vacuous —
    // it stays green with the redaction deleted.
    expect(echoed).toContain(knownKey);
    const abandoned = entries.filter((e) => e.phase === "abandoned");
    expect(abandoned).toHaveLength(1);
    expect(abandoned[0]?.step).toBe("deliver");

    const text = JSON.stringify(abandoned);
    expect(text).not.toContain(knownKey);
    expect(text).not.toContain("sk-or-v1-");
    // And no other sink either — the handler is not the only line in flight.
    expect(entries.filter((e) => JSON.stringify(e).includes(knownKey)).map((e) => e.operation)).toEqual([]);
  });

  test("INV-6: a long host label is redacted without mangling the URL, and userinfo never survives", async () => {
    // The host arm sliced the string: `/[^/]{16,}/` matched the `//host` run
    // itself, so `https://abcdefghijklmnopq` came out as `https:/«redacted»` —
    // a malformed single-slash URL, losing the stated guarantee that the scheme
    // and host survive so an operator can tell WHICH box the line is about.
    // Conversely `tok@x.io` is one short segment, so userinfo passed the 16-char
    // floor untouched — and length is not a property of a credential.
    driver.create = async () => {
      throw new Error(
        "create failed: https://abcdefghijklmnopq/vm and https://tok@short.io/vm",
      );
    };

    try {
      await dispatch(validBrief(), deps());
      expect.unreachable();
    } catch (e) {
      const err = e as FleetError;
      expect(err.code).toBe("provision-failed");
      expect(err.message).not.toContain("abcdefghijklmnopq");
      expect(err.message).not.toContain("tok@");
      // Not mangled into `https:/…`: the scheme keeps both its slashes.
      expect(err.message).not.toContain("https:/«");
      expect(err.message).toContain("https://«redacted»");
      // The host an operator can act on survives; the path does not.
      expect(err.message).toContain("https://short.io");
      expect(err.message).not.toContain("short.io/vm");
    }
  });

  test("a pre-provision refusal names NO teardown command — nothing was provisioned", async () => {
    // The remediation was gated on `ctxRunId !== null`, which is set inside the
    // mint-collision loop — before the admission gates and before store.create.
    // Every refusal from step 4 on therefore handed a tier-1 agent
    // `fleet teardown <id>` for an id with no record.
    try {
      await dispatch(validBrief(), deps({ ledgerFactory: () => overBudgetLedger() }));
      expect.unreachable();
    } catch (e) {
      const err = e as FleetError;
      expect(err.exitCode).toBe(5);
      expect(err.code).toBe("budget-exceeded");
      // The id is still reported — it is this dispatch's own, and the log line
      // joins on it. The COMMANDS are what must not be there.
      expect(err.payload?.runId).toBeString();
      expect(err.payload).not.toHaveProperty("teardownCommand");
      expect(err.payload).not.toHaveProperty("debugCommands");
    }
    expect(readdirSync(store.dir)).toHaveLength(0);
    expect(await driver.list()).toHaveLength(0);
  });

  test("a box is never made public when expose established no URL", async () => {
    // The URL was written to the record AFTER setPublic, and setPublic ran
    // whatever expose returned: a driver that resolved no URL still got its box
    // published, leaving it publicly reachable with nothing on the record saying
    // where. The `ports` claim two lines above already pre-claims for exactly
    // this reason; the URL write was the one state claim still made after the
    // call it describes.
    let setPublicCalls = 0;
    driver.expose = async () => undefined as unknown as string;
    driver.setPublic = async () => {
      setPublicCalls += 1;
    };

    try {
      await dispatch(validBrief(), deps({ port: 8080 }));
      expect.unreachable();
    } catch (e) {
      const err = e as FleetError;
      expect(err.exitCode).toBe(1);
      expect(err.code).toBe("expose-no-url");
      expect(err.payload?.port).toBe(8080);
      // INV-5: the box is alive and the record open, so the refusal carries the
      // operator's commands.
      expect(err.payload?.teardownCommand).toBeString();
    }
    expect(setPublicCalls).toBe(0);
    // The port claim landed before the provider calls and stays on the record;
    // the URL never does, because none was ever established.
    const files = readdirSync(store.dir);
    expect(files).toHaveLength(1);
    const record = store.get((files[0] as string).replace(/\.json$/, ""));
    expect(record.ports).toEqual([8080]);
    expect(record.httpsUrl).toBeUndefined();
  });
});
