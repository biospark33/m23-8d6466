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
import { afterAll, afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
// The SABOTEUR connection only (see the setup-gate store-fault test): a second
// handle on the dispatch's own store is the only way to make `record()` throw
// on a store that is already open, which is the mid-dispatch fault this suite
// had no coverage for. Nothing here reads links through it — that is
// `openAuditStoreForWalk`'s job, and going around the production reader is how
// a test stops seeing what the walker sees.
import { Database } from "bun:sqlite";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import * as YAML from "yaml";

import {
  DEFAULT_QUOTA_LIMITS,
  loadQuotaLimits,
  QuotaLimitsError,
  type LoadedQuotaLimits,
} from "../../src/providers/quota.ts";
import { ROSTER_MAX_BYTES } from "../../src/phase-engine/roster/schema.ts";

/** Fresh limits — NEVER mutate DEFAULT_QUOTA_LIMITS (shared, unfrozen reference). */
function limitsWith(overrides: Partial<typeof DEFAULT_QUOTA_LIMITS>): LoadedQuotaLimits {
  return { limits: { ...DEFAULT_QUOTA_LIMITS, ...overrides }, source: "default" };
}
import { RunRecordStore } from "../../src/providers/run-record.ts";
import { FakeDriver } from "../../src/providers/fake-driver.ts";
import type { ProviderDriver } from "../../src/providers/driver.ts";
import type { ProviderVm } from "../../src/providers/driver.ts";
import type { SetupGateResult } from "../../src/providers/exedev/setup-gate.ts";
import { CredentialLifecycleError, defaultKeyCapMicroUsd, SBX_KEY_PREFIX } from "../../src/providers/credentials.ts";
import { type AdmissionInput, CostLedgerError } from "../../src/providers/cost-ledger.ts";
import { FakeKeyApi } from "../providers/fixtures/fake-key-api.ts";
import { type LogEntry, setLogSink } from "../../src/swarmclaw/log.ts";
import { statusRun } from "../../src/fleet/status.ts";
import { isSubstrateFailure } from "../../src/providers/fake-gate.ts";
import { DEFAULT_FILL_WORKDIR, QDS_IN_BOX_DIR } from "../../src/providers/exedev/fill.ts";
import {
  FleetError,
  assertFleetRunId,
  fakeGate,
  mintRunId,
  dispatch,
  type DispatchDeps,
  type GateOpts,
  type LedgerLike,
} from "../../src/fleet/dispatch.ts";
import {
  ADMIT_THROW_MESSAGE,
  admitThrowsLedger,
  CLOSE_THROW_MESSAGE,
  closeThrowsLedger,
  goodLedger,
  overBudgetLedger,
  useTempAuditStore,
} from "./helpers.ts";
import {
  type AuditLinkRow,
  openAuditStoreForWalk,
} from "../../src/audit/link-store.ts";

/**
 * UUID v4, spelled out here rather than imported from the implementation's own
 * `isValidUuidV4`: a predicate loosened in `src/` would otherwise loosen the
 * test that is supposed to catch it, and the two would degrade together.
 */
const UUID_V4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * DF1.10 AC2b: where dispatch delivers the manifest pair — INSIDE the checkout,
 * under `.qds/`, not beside it in the box's ssh HOME.
 *
 * DERIVED from `fill.ts`'s own two constants rather than spelled out, because
 * this is exactly the pair that must not drift: `fillExeDev` writes the
 * `/.qds/` line into the checkout's `.git/info/exclude` and refuses a repo
 * that tracks `.qds`, and both are keyed on `QDS_IN_BOX_DIR`. A rename there
 * that dispatch did not follow would deliver the manifest somewhere the
 * exclude does not cover — a dirty tree in a customer's repository, which
 * setup gate assertion A is entitled to hard-fail on. Spelled as literals
 * here, that drift would be a green suite.
 */
const IN_BOX_QDS_DIR = `${DEFAULT_FILL_WORKDIR}/${QDS_IN_BOX_DIR}`;
const IN_BOX_MANIFEST = `${IN_BOX_QDS_DIR}/pipeline.yaml`;
const IN_BOX_RUN_CONTEXT = `${IN_BOX_QDS_DIR}/run-context.json`;

/**
 * `expect.unreachable()` throws a plain Error, so a `catch` under test swallows
 * it and re-reports an unexpected SUCCESS as whatever its own failed
 * expectations produce — naming the wrong failure. Every try/catch here whose
 * try ends in the unreachable-success arm throws THIS instead, and its catch
 * rethrows on sight, so unexpected success fails loudly under its own name.
 */
class UnexpectedSuccessError extends Error {
  constructor() {
    super("dispatch unexpectedly succeeded");
    this.name = "UnexpectedSuccessError";
  }
}

/** The unreachable-success arm of a try whose catch rethrows {@link UnexpectedSuccessError}. */
function failUnreachable(): never {
  throw new UnexpectedSuccessError();
}

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
 * DF5.3 C11: `dispatch()` IS the composition root for this run's audit links —
 * it calls `openAuditStore()` itself, which resolves `QDS_AUDIT_DB ??
 * .sandbox/audit.db` relative to cwd. Registered at FILE scope so it covers
 * every describe here, including the ones that do not read `auditDb.path()`.
 */
const auditDb = useTempAuditStore();

/**
 * The links a dispatch wrote for `runId`, oldest first — read through the
 * PRODUCTION reader (`openAuditStoreForWalk`), so these assertions see exactly
 * the rows `scripts/qds-audit.ts` walks, in the order it walks them.
 */
function auditRows(runId: string): AuditLinkRow[] {
  const handle = openAuditStoreForWalk(auditDb.path());
  try {
    return handle.linksForRun(runId);
  } finally {
    handle.close();
  }
}

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
  let entries: LogEntry[] = [];
  /**
   * Subscribers on the sink, for the lines that arrive AFTER the call under
   * test has already returned (`within`'s abandoned-step handler). See
   * `awaitEntry`.
   */
  let entryWaiters: Array<{ match: (e: LogEntry) => boolean; resolve: () => void }> = [];
  let restoreLog: (() => void) | undefined;

  beforeEach(() => {
    dir = realpathSync(mkdtempSync(join(tmpRoot, "run-")));
    outsideDir = realpathSync(mkdtempSync(join(tmpRoot, "outside-")));
    store = new RunRecordStore(join(dir, "runs"));
    driver = new FakeDriver(join(dir, "boxes"));
    keyApi = new FakeKeyApi();
    entries = [];
    entryWaiters = [];
    // Capture the module's own sink (INV-4 checks). ONE array, not a parallel
    // `string[]` of the same entries: the stringified copy was a second capture
    // of the same lines that only three assertions ever read, and the two could
    // drift (a sink that pushed to one and not the other). `JSON.stringify(e)`
    // at the three call sites is the whole of what it bought.
    restoreLog = setLogSink((e) => {
      entries.push(e);
      entryWaiters = entryWaiters.filter((w) => {
        if (!w.match(e)) return true;
        w.resolve();
        return false;
      });
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
        { name: "plan", kind: "code", description: "Draft the approach for the change", command: ["true"], maxDurationMs: 10_000, retries: 0 },
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

  /**
   * Every typed refusal owes exactly ONE structured line, classified `error`,
   * carrying the fleet code — the join key and diagnosis AC4's evidence rides
   * on. This is the shared minimum, and every refusal family in this file now
   * asserts it — directly here, through {@link expectRosterRefusal}, or inline
   * in the few families that predate the helper.
   *
   * Deliberately NOT pinned here: `exitStatus` (per-path classification) and
   * `runId`/`requestId` joins (depend on how far the refusal got) — callers add
   * those where their sibling already does.
   */
  function expectSingleRefusalLine(code: string): LogEntry {
    const lines = refusalLines();
    expect(lines).toHaveLength(1);
    const line = lines[0] as LogEntry;
    expect(line.status).toBe("error");
    expect((line.error as { code?: string }).code).toBe(code);
    return line;
  }

  /**
   * Settle once a line matching `match` has reached the sink.
   *
   * For the ABANDONED-step lines, which are emitted after `dispatch` has already
   * rejected: the work promise settles on its own schedule and only `within`'s
   * handler is still subscribed to it. Drained off the SINK rather than off a
   * tick budget — "yield 50 times and then assert" is a bet on the scheduler,
   * and when it loses under load the failure surfaces at `toHaveLength(1)` as if
   * the line had been mis-emitted rather than merely not emitted yet. Unbounded
   * on purpose: the test's own timeout is the backstop, and "the line never
   * came" is then reported as a timeout on THIS await, which is what it is.
   */
  function awaitEntry(match: (e: LogEntry) => boolean): Promise<void> {
    if (entries.some(match)) return Promise.resolve();
    return new Promise<void>((resolve) => {
      entryWaiters.push({ match, resolve });
    });
  }

  /** An abandoned-step line for `step`, once `within`'s handler has filed it. */
  async function abandonedLine(step: string): Promise<LogEntry> {
    await awaitEntry((e) => e.phase === "abandoned" && e.step === step);
    // Settle BEFORE counting: the FIRST matching line resolves `awaitEntry`, but
    // a sibling step can file its own abandoned line a tick later — counting
    // immediately lets that second line slip past this helper, and the
    // assertions below then run against whichever entry happened to come first.
    // Bounded poll: yield on a short timer until the abandoned-line count has
    // held steady across two consecutive hops. The cap is 250 ms, not 50 — a
    // sibling step's line arriving MORE than 50 ms after the first used to slip
    // past this window and defeat the exactly-one assertion below. The early
    // exit keeps the common case at ~10 ms; the larger ceiling is only paid
    // when lines are genuinely still arriving.
    const abandonedCount = (): number => entries.filter((e) => e.phase === "abandoned").length;
    const settleBy = Date.now() + 250;
    let seen = abandonedCount();
    let quietHops = 0;
    while (quietHops < 2 && Date.now() < settleBy) {
      await new Promise((resolve) => setTimeout(resolve, 5));
      const next = abandonedCount();
      quietHops = next === seen ? quietHops + 1 : 0;
      seen = next;
    }
    const lines = entries.filter((e) => e.phase === "abandoned");
    // Exactly one: a second abandoned step means a different step also expired,
    // and the assertions below would then be about whichever came first.
    expect(lines).toHaveLength(1);
    return lines[0] as LogEntry;
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
      failUnreachable();
    } catch (e) {
      if (e instanceof UnexpectedSuccessError) throw e;
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

  // Ids that are ALMOST minted-shaped. `"invented-by-caller"` misses the
  // grammar by a mile, so it proved only that the first character of the check
  // works; every case here differs from a real minted id in exactly one place.
  //
  // `invalid-run-id` — `assertValidRunId`'s backstop two lines further down — is
  // NOT reachable from here, and cannot be: `RUN_ID_RE` is
  // `/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/`, which every string matching the minted
  // grammar satisfies by construction (leading `q`, trailing hex, `[a-z0-9-]`
  // throughout). The backstop earns its place only if the minted grammar is
  // ever loosened — and these cases are what would then fail, because the
  // loosening they would catch (uppercase, a wrong-width date, a trailing
  // segment) is exactly what they pin as refused today.
  for (const [label, forged] of [
    ["uppercase hex", "qds-20260101-ABCDEF"],
    ["a seven-digit date", "qds-2026010-abcdef"],
    ["a five-hex tail", "qds-20260101-abcde"],
    ["a non-hex tail", "qds-20260101-abcdeg"],
    ["a trailing segment", "qds-20260101-abcdef-2"],
    ["the wrong slug", "run-20260101-abcdef"],
    ["leading whitespace", " qds-20260101-abcdef"],
    // `$` matches before a FINAL newline in JS, so an unanchored-feeling regex
    // admits this one — the classic way a log-forging id slips a shape check.
    ["a trailing newline", "qds-20260101-abcdef\n"],
  ] as const) {
    test(`AC2: a runId with ${label} is refused as not-minted, before any admission`, async () => {
      const ledgerFactory = mock(() => goodLedger());
      try {
        await dispatch(validBrief(), deps({ ledgerFactory }), {
          // @ts-expect-error the brand refuses a forged literal at compile time;
          // this asserts the runtime guard still refuses a cast.
          runId: forged,
        });
        failUnreachable();
      } catch (e) {
        if (e instanceof UnexpectedSuccessError) throw e;
        expect(e).toBeInstanceOf(FleetError);
        const err = e as FleetError;
        expect(err.code).toBe("run-id-not-minted");
        expect(err.exitCode).toBe(2);
      }
      expectSingleRefusalLine("run-id-not-minted");
      expect(ledgerFactory).not.toHaveBeenCalled();
      expect(readdirSync(store.dir)).toHaveLength(0);
      expect(await driver.list()).toHaveLength(0);
    });
  }

  test("AC2: dispatcher-minted runId accepted via opts", async () => {
    const preMinted = mintRunId();
    const brief = validBrief();
    const result = await dispatch(brief, deps(), { runId: preMinted });
    expect(result.runId).toBe(preMinted);
  });

  test("F17: a SHAPE-PERFECT runId this process never minted is refused run-id-not-minted (runtime provenance)", async () => {
    // fix-F17's runtime half: `MINTED_RUN_ID_RE` proves shape only, and a
    // misbehaving in-process caller can cast a shape-perfect string in. The
    // registry (`mintRunIds` Set fed by every real hand-out) refuses it — the
    // message must name the registry, not the shape, so an operator reading
    // "matches the minted shape but was never returned" is not sent hunting a
    // typo that does not exist.
    const forged = "qds-20260101-abcdef";
    // Premise: the forged id PASSES the shape gate (dispatch's private
    // MINTED_RUN_ID_RE is `/^qds-\d{8}-[a-f0-9]{6}$/`), so only provenance can
    // refuse it — pinning the shape here keeps that premise honest if the
    // grammar ever loosens.
    expect(forged).toMatch(/^qds-\d{8}-[a-f0-9]{6}$/);
    const ledgerFactory = mock(() => goodLedger());
    try {
      await dispatch(validBrief(), deps({ ledgerFactory }), {
        // @ts-expect-error the brand refuses the literal at compile time; the
        // RUNTIME guard is what this test exists to pin.
        runId: forged,
      });
      failUnreachable();
    } catch (e) {
      if (e instanceof UnexpectedSuccessError) throw e;
      const err = e as FleetError;
      expect(err.exitCode).toBe(2);
      expect(err.code).toBe("run-id-not-minted");
      // The PROVENANCE arm's own words — deleting the registry check leaves
      // every shape-arm test above green, so this one line is its whole pin.
      expect(err.message).toContain("was never returned by mintRunId()");
    }
    const refused = expectSingleRefusalLine("run-id-not-minted");
    void refused;
    // Refused BEFORE admission spent anything.
    expect(ledgerFactory).not.toHaveBeenCalled();
    expect(readdirSync(store.dir)).toHaveLength(0);
  });

  test("F17 composition: a LEGITIMATE re-supply still passes — mint output re-dispatched is accepted", async () => {
    // The false-positive control for the sibling: fan-out's actual pattern is
    // mint → hand to arms → re-supply via opts.runId. Breaking the accept half
    // of the registry check would refuse exactly that.
    const first = await dispatch(validBrief(), deps()); // populates nothing shared; proves wiring alone
    const preMinted = mintRunId(); // the genuine hand-out
    const second = await dispatch(validBrief(), deps(), { runId: preMinted });
    expect(second.runId).toBe(preMinted);
    expect(first.runId).not.toBe(preMinted);
  });

  test("mintRunId() re-exports newId('qds') — dated, and RANDOM, not a counter", () => {
    // The UTC day is captured on BOTH sides of every mint below: an id carries
    // the date AT ITS OWN MINT, and a UTC-midnight flip mid-test is legitimate —
    // pinning to whichever bound was read last would flake once a day at
    // 00:00:00 UTC instead of testing anything.
    const utcDay = (): string => new Date().toISOString().slice(0, 10).replaceAll("-", "");
    const dayBefore = utcDay();
    const id = mintRunId();
    expect(id).toMatch(/^qds-\d{8}-[a-f0-9]{6}$/);
    // The DAY, not just eight digits: `newId` composes it from `toISOString()`,
    // and a shape assertion alone is satisfied by a constant.
    expect([dayBefore, utcDay()]).toContain(id.slice(4, 12));

    // INDEPENDENCE, which the collision-retry loop above assumes: a counter, a
    // pid-derived value or a second-resolution timestamp all satisfy the shape
    // and make the "re-mint on collision" loop re-mint the SAME id four times.
    //
    // NOT `toBe(256)`. 256 draws from 16^6 collide with probability
    // 256·255/(2·16^6) ≈ 0.0019 — about one CI failure in 515 runs, reported as
    // an id-generator regression. The floor below is 6 collisions clear of that,
    // which no birthday accident reaches, while a source with fewer than ~2^15
    // reachable values fails it almost surely.
    const minted = Array.from({ length: 256 }, () => mintRunId());
    const ids = new Set(minted);
    expect(ids.size).toBeGreaterThanOrEqual(250);
    // …and uniqueness alone does NOT catch a counter, which is distinct by
    // construction. A monotone source — a counter, a millisecond clock, an
    // incrementing pid — yields a strictly increasing tail; 256 independent
    // draws do so with probability 1/256!, i.e. never.
    const tails = minted.map((v) => Number.parseInt(v.slice(13), 16));
    expect(tails.every((t, i) => i === 0 || t > (tails[i - 1] as number))).toBeFalse();
    // And the randomness is in the TAIL, not smuggled into the date: every one
    // of those ids carries a day THIS TEST WINDOW covers (one, or both if the
    // UTC day flipped mid-test), so the set above is still 256 mostly-distinct
    // six-hex suffixes rather than 256 distinct date groups.
    const daysInWindow = new Set([dayBefore, utcDay()]);
    const days = [...ids].map((v) => v.slice(4, 12));
    expect(days.every((d) => daysInWindow.has(d))).toBeTrue();
    expect(new Set(days).size).toBeLessThanOrEqual(daysInWindow.size);
  });

  test("INV-4-bis: requestId is persisted on the record and surfaces on the status row", async () => {
    const requestId = "3c9f0b21-7a44-4d0e-b8b1-6f0c2e5a7d13";
    const result = await dispatch(validBrief({ requestId }), deps());

    expect(store.get(result.runId).requestId).toBe(requestId);

    // `fleet status` is the operator's only inspection surface — the join key
    // has to reach it, not just the record file.
    const row = await statusRun({ driver, store }, result.runId);
    expect(row.requestId).toBe(requestId);
    // The state corroborates that this is the JOINED row for a dispatched run,
    // and since DF1.10 AC5 that row's word is `unknown` rather than `live`: the
    // run has not been started, so its in-box completion marker is absent, and
    // a fake box has no `systemctl` to corroborate the absence with — which
    // INV-IBOX-7 fails CLOSED. That premise is now TRUE BY CONSTRUCTION rather
    // than by accident of the developer's OS — for the UNIT-PROBE half only
    // (B2-7): `FakeDriver.spawnExec` intercepts a `systemctl` argv and answers
    // 127, because before it did, this line asserted the macOS answer and CI
    // (Linux, where the binary exists and reports an unheard-of unit inactive)
    // read `not-running` and went red. The MARKER-PRESENCE probe still runs on
    // the host as `sh -c "test -f '/run/journal/final.json'"`, so a host that
    // genuinely carries that QDS-only filename would flip this to `ok`/`not-ok`
    // — near-impossible by name, but construction guarantees the systemd half,
    // not the filesystem half.
    // Still the same claim, because `unknown` is
    // reachable from one row class only (an open record whose box the substrate
    // reports); a requestId surfacing on a boxMissing or orphan row would fail
    // here exactly as it did before.
    expect(row.state).toBe("unknown");
  });

  test("AC2: a supplied requestId is REUSED across two sequential runs, not minted per run", async () => {
    // "Honoured" in the sibling above is one dispatch deep: a resolver that
    // honoured the FIRST call and re-minted on every later one would pass it.
    // The id is the operator's correlation handle — two runs the caller sent
    // under one requestId must stay joinable under it.
    const requestId = "5d4e3f2a-1b0c-4d9e-8f7a-6b5c4d3e2f10";
    const first = await dispatch(validBrief({ requestId }), deps());
    const second = await dispatch(validBrief({ requestId }), deps());

    expect(first.requestId).toBe(requestId);
    expect(second.requestId).toBe(requestId);
    // On the records too — the ack is not the only carrier (INV-4-bis).
    expect(store.get(first.runId).requestId).toBe(requestId);
    expect(store.get(second.runId).requestId).toBe(requestId);
    // Two DISTINCT runs share it; nothing here mints a third value.
    expect(new Set([first.runId, second.runId]).size).toBe(2);
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
      failUnreachable();
    } catch (e) {
      if (e instanceof UnexpectedSuccessError) throw e;
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

  test("a hostile unknown-key NAME is ESCAPED in every operator-facing string", async () => {
    // The key is attacker-chosen — `NO_CONTROL_CHARS` guards brief VALUES, and
    // nothing constrains a key NAME — and `extractZodErrorField` returns it
    // verbatim by contract. `redact` is a SECRET redactor, not a control-char
    // escaper, so escaping here is the only thing between an unrecognized key
    // and the operator's terminal.
    //
    // The regression: the message used `JSON.stringify(field)` while the
    // remediation interpolated it RAW, and zod's own
    // "Unrecognized key(s) in object: '<raw>'" rode into `payload.issues`
    // unescaped as well. Drop the escaping from any of the three and a key like
    // the second one below forges a whole log line.
    const forgery = "a\nFLEET dispatch ok runId=fake";
    for (const [hostile, sanitized] of [
      ["[2Jrm -rf", "[2Jrm -rf"],
      [forgery, "aFLEET dispatch ok runId=fake"],
    ] as const) {
      try {
        await dispatch(validBrief({ [hostile]: "x" }), deps());
        failUnreachable();
      } catch (e) {
        if (e instanceof UnexpectedSuccessError) throw e;
        const err = e as FleetError;
        expect(err.code).toBe("invalid-brief");
        expect(err.exitCode).toBe(2);
        // The raw name never appears in ANY operator-facing string.
        const operatorFacing = [
          err.message,
          err.remediation,
          JSON.stringify(err.payload?.issues),
        ].join("\n");
        expect(operatorFacing).not.toContain(hostile);
        // …and where the raw name still HAS to appear, it appears escaped rather
        // than merely gone. zod builds "Unrecognized key(s) in object: '<raw>'"
        // from the key the brief carried, not from the sanitized label, so
        // `payload.issues` is the one string that still holds the original — and
        // the escaping is the only thing between it and the terminal. The
        // assertion sits on the issue string itself because `operatorFacing`
        // JSON-encodes the array a second time (`a\\nFLEET`), and because the
        // message and remediation now interpolate the SANITIZED label, in which
        // the character is not present in any form.
        expect(String((err.payload?.issues as string[] | undefined)?.[0])).toContain(
          JSON.stringify(hostile).slice(1, -1),
        );
        // `payload.field` is SANITIZED, not verbatim: `extractZodErrorField` now
        // strips the control characters (and length-caps the name) before the
        // label leaves the schema layer, so the structured field is safe in a
        // consumer that renders it without a JSON encoder. The escaping above
        // stays — it is what keeps the surviving text readable, and zod's own
        // "Unrecognized key(s) in object: '<raw>'" still carries the raw name
        // into `payload.issues`, which is the string that must be escaped.
        expect(err.payload?.field).toBe(sanitized);
      }
    }
  });

  test("INV-2: missing repoSlug → FleetError exit 2, zero provisioning", async () => {
    const brief = validBrief();
    Reflect.deleteProperty(brief, "repoSlug");
    const createSpy = mock(() => Promise.resolve({ name: "test", status: "running" } as ProviderVm));
    driver.create = createSpy;

    try {
      await dispatch(brief, deps());
      failUnreachable();
    } catch (e) {
      if (e instanceof UnexpectedSuccessError) throw e;
      expect(e).toBeInstanceOf(FleetError);
      const err = e as FleetError;
      expect(err.exitCode).toBe(2);
      // The REASON, not just the exit code. Every refusal in this file exits 2
      // for something; a brief missing a required field that refused as
      // `manifest-rejected` or `timeout-invalid` would satisfy the code alone
      // and send the operator to fix a field that is perfectly fine.
      expect(err.code).toBe("invalid-brief");
      expect(err.payload?.field).toBe("repoSlug");

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
      failUnreachable();
    } catch (e) {
      if (e instanceof UnexpectedSuccessError) throw e;
      expect(e).toBeInstanceOf(FleetError);
      const err = e as FleetError;
      expect(err.exitCode).toBe(2);
      // Same argument as the sibling above: the exit code alone is shared with
      // every other pre-provision refusal, and the FIELD is what the operator
      // acts on.
      expect(err.code).toBe("invalid-brief");
      expect(err.payload?.field).toBe("commitSha");

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
      failUnreachable();
    } catch (e) {
      if (e instanceof UnexpectedSuccessError) throw e;
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
      failUnreachable();
    } catch (e) {
      if (e instanceof UnexpectedSuccessError) throw e;
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
    const before = Date.now();

    // A refusal from BEFORE the brief parsed, then one from after it: the two
    // together pin the documented "null, never '' and never a fabricated value"
    // shape as well as the populated one.
    try {
      await dispatch({ ...validBrief(), unknownField: "x" }, deps());
      failUnreachable();
    } catch (e) {
      if (e instanceof UnexpectedSuccessError) throw e;
      expect((e as FleetError).code).toBe("invalid-brief");
    }
    try {
      await dispatch(validBrief({ requestId }), deps({ ledgerFactory: overBudgetLedger }));
      failUnreachable();
    } catch (e) {
      if (e instanceof UnexpectedSuccessError) throw e;
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
    // The over-budget DIAGNOSIS, not a bare substring: `toContain("cap")` was
    // satisfied by "capacity"/"capabilities"/any incidental text. The message
    // is OverBudgetError's own fixed composition (budget-gate.ts) — pin its
    // discriminating head so the on-disk AC4 evidence names the real condition.
    expect(String(admitted?.message)).toMatch(/^issue over budget: spent \d+ \/ \d+ µ\$/);
    // WHEN, not merely "parseable". `Date.parse("2001")` is a number, so a
    // frozen constant, a copied timestamp or a zero epoch all satisfied the old
    // assertion — and this line is the AC4 evidence an operator sorts by. Both
    // refusals fall inside this test's own wall-clock window, and the ISO-8601
    // shape is pinned separately (`toISOString` is what writes it).
    for (const line of [early, admitted]) {
      const t = Date.parse(String(line?.timestamp));
      expect(String(line?.timestamp)).toMatch(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/);
      expect(t).toBeGreaterThanOrEqual(before);
      expect(t).toBeLessThanOrEqual(Date.now());
    }
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
      failUnreachable();
    } catch (e) {
      if (e instanceof UnexpectedSuccessError) throw e;
      expect(e).toBeInstanceOf(FleetError);
      const err = e as FleetError;
      expect(err.exitCode).toBe(2);
      expect(err.code).toBe("invalid-brief");
      // Named, not merely refused — the operator has to know which field.
      expect(err.payload?.field).toBe("manifestPath");
      expect(JSON.stringify(err.payload?.issues)).toContain("must be relative to the repo root");
    }
    expectSingleRefusalLine("invalid-brief");
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
      failUnreachable();
    } catch (e) {
      if (e instanceof UnexpectedSuccessError) throw e;
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
    expectSingleRefusalLine("manifest-rejected");
    expect(ledgerFactory).not.toHaveBeenCalled();
    expect(readdirSync(store.dir)).toHaveLength(0);
    expect(await driver.list()).toHaveLength(0);
  });

  test("INV-2: with no repoRoot supplied the containment root is process.cwd()", async () => {
    // The fallback is `process.cwd()`. Covered here so the default cannot rot
    // behind the injected root every other test uses — and asserted WITHOUT
    // mutating the process's cwd, which is shared by every other test file.
    //
    // ISOLATED from the real repo tree's contents. The manifest lives at a
    // NONCE path written ONLY beneath `dir`: the cwd resolution of that path
    // cannot exist regardless of what the working tree holds (the old
    // `manifests/pipeline.json` spelling would have started loading the real
    // repo's manifest the day one landed there), and the injected root WOULD
    // load it — so the refusal below still proves WHICH root the default is,
    // not merely that some file was missing somewhere.
    const brief = { ...validBrief(), manifestPath: manifestAt(join("manifests", "cwd-fallback-probe.json")) };
    expect(existsSync(join(process.cwd(), "manifests", "cwd-fallback-probe.json"))).toBeFalse();

    try {
      await dispatch(brief, deps({ repoRoot: undefined }));
      failUnreachable();
    } catch (e) {
      if (e instanceof UnexpectedSuccessError) throw e;
      expect((e as FleetError).exitCode).toBe(2);
      expect((e as FleetError).code).toBe("manifest-rejected");
      expect((e as FleetError).remediation).toContain(process.cwd());
      // And NOT the injected root — the fixture exists beneath `dir`, so a
      // dispatch that ignored `repoRoot: undefined` and kept the injected value
      // would have loaded it and never reached this refusal at all.
      expect((e as FleetError).remediation).not.toContain(dir);
    }
    expectSingleRefusalLine("manifest-rejected");
    expect(readdirSync(store.dir)).toHaveLength(0);
    expect(await driver.list()).toHaveLength(0);
  });

  // ─── the roster pre-checks (step 3, before an admission is spent) ───────────────────

  /**
   * `FakeDriver` carries neither `setup` nor `fill`, so `isExedevDriver` is
   * false for it and the roster pre-checks are skipped for every other test in
   * this file — which is why the whole block had no coverage at all and could
   * be deleted with the suite still green.
   *
   * BOTH capabilities, because the predicate requires both: a driver with one
   * and not the other is exactly the incoherent lifecycle `isExedevDriver`
   * exists to refuse, and stubbing only `setup` would exercise a shape dispatch
   * treats as a dir box.
   *
   * The counters are the point of the assertions below: on a roster refusal
   * NEITHER may be called, because the refusal fires before anything is
   * provisioned — which is the entire reason these checks were moved out of the
   * gate, where INV-5 would then forbid tearing the billed box down.
   */
  function makeDriverExedevCapable(): { setupCalls: number; fillCalls: number } {
    const counts = { setupCalls: 0, fillCalls: 0 };
    Object.assign(driver, {
      setup: async () => {
        counts.setupCalls += 1;
      },
      fill: async () => {
        counts.fillCalls += 1;
      },
    });
    return counts;
  }

  /**
   * The `tests/phase-engine/fixtures/dispatch-roster.yaml` shape, inline.
   *
   * COUPLING, named because no constant is exported to derive it from: the
   * `model:` value is a plain schema-valid model id (`provider: anthropic` in
   * defaults is what keeps it from needing a provider prefix — see
   * `resolveSlug` in roster/schema.ts). If the roster schema ever renames or
   * re-constrains models, THIS string must be updated by hand; nothing in the
   * import graph will flag the drift.
   */
  const VALID_ROSTER = [
    "defaults:",
    "  provider: anthropic",
    "  thinking: off",
    "  tools: null",
    "  writes: []",
    "  harness_engineering: []",
    "roles:",
    "  - name: lead",
    "    model: claude-haiku-4-5",
    "",
  ].join("\n");

  /**
   * A copy of the valid manifest at `rel`, so a case can move the manifest —
   * and therefore `dirname(manifestPath)`, where the roster is looked for —
   * without hand-authoring a second manifest body that could refuse for its own
   * reasons. Byte-identical on purpose, same argument as the symlink fixture.
   */
  function manifestAt(rel: string): string {
    const target = join(dir, rel);
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(join(dir, MANIFEST_REL), target);
    return rel;
  }

  /**
   * Every roster refusal owes the same four things: exit 2, the named code, and
   * ZERO spent — no ledger opened, no record, no box.
   */
  async function expectRosterRefusal(
    brief: unknown,
    code: string,
    rosterPath: string,
  ): Promise<FleetError> {
    const ledgerFactory = mock(() => goodLedger());
    const createSpy = mock(() => Promise.resolve({ name: "x", status: "running" } as ProviderVm));
    driver.create = createSpy;
    let err: FleetError | undefined;
    try {
      await dispatch(brief, deps({ ledgerFactory }));
    } catch (e) {
      err = e as FleetError;
    }
    // Same idiom as the `failUnreachable` arms (see the class doc): an
    // unexpected SUCCESS fails under its own name, not as "expected
    // FleetError, got undefined" out of the assertion below.
    if (err === undefined) throw new UnexpectedSuccessError();
    expect(err).toBeInstanceOf(FleetError);
    const fleetError = err as FleetError;
    expect(fleetError.exitCode).toBe(2);
    expect(fleetError.code).toBe(code);
    expect(fleetError.payload?.rosterPath).toBe(rosterPath);
    // Pre-provision, so no teardown advice for a run that does not exist.
    expect(fleetError.payload).not.toHaveProperty("teardownCommand");
    // The whole point of moving these out of the gate: nothing was billed.
    expect(ledgerFactory).not.toHaveBeenCalled();
    expect(createSpy).not.toHaveBeenCalled();
    expect(readdirSync(store.dir)).toHaveLength(0);
    // The shared minimum, so a `refuse` that stopped filing its line fails
    // every roster refusal by name rather than only where a sibling remembers.
    expectSingleRefusalLine(code);
    return fleetError;
  }

  test("INV-2: an exedev dispatch with NO roster beside the manifest → exit 2 roster-missing", async () => {
    // The counters `makeDriverExedevCapable` returns are not asserted here:
    // `setup`/`fill` both run against a box, and `expectRosterRefusal` has
    // already pinned that `driver.create` was never called — so `0` is true by
    // construction and cannot fail independently of the assertion above it.
    makeDriverExedevCapable();
    const brief = validBrief();

    const err = await expectRosterRefusal(
      brief,
      "roster-missing",
      join(dir, "manifests", "roster.yaml"),
    );
    expect(err.message).toContain("no roster beside the manifest");
  });

  /** `mkfifo` is absent on some minimal CI images; without it no FIFO fixture can exist. */
  const mkfifoMissing = Bun.which("mkfifo") === null;

  // Skip visibility: `test.skipIf` shows a skipped entry with no reason, so on
  // a host without `mkfifo` nothing in the output says WHY the anti-hang case
  // above never ran. This always-on line names the state either way.
  test(
    mkfifoMissing
      ? "FIFO anti-hang coverage is SKIPPED on this host: mkfifo is absent, so no FIFO fixture can exist"
      : "FIFO anti-hang coverage is ACTIVE on this host: mkfifo is present",
    () => {
      expect(typeof mkfifoMissing).toBe("boolean");
    },
  );

  test.skipIf(mkfifoMissing)(
    "INV-2: a roster.yaml that is a FIFO → exit 2 roster-rejected, and the dispatch does not HANG",
    async () => {
    // The roster block runs OUTSIDE `within` — it is synchronous host-side work
    // — so no timer can rescue it. Under the old `statSync(path)` then
    // `readFileSync(path)` pair a FIFO planted at this brief-steered path
    // (`manifestPath` → `dirname` → `roster.yaml`) blocked `readFileSync`
    // forever waiting for a writer, before any admission was spent: the process
    // wedges with the event loop stopped, which no assertion in this file could
    // observe and no `Promise.race` could interrupt.
    //
    // The order is what fixes it: `openSync(O_RDONLY|O_NONBLOCK)` cannot block,
    // and `fstatSync(fd)` then judges the HANDLE the read will use rather than
    // re-resolving the name (the TOCTOU half of the same defect).
    //
    // A regression here does not fail this test — it hangs the whole suite
    // until the runner's timeout kills it. That is the honest shape of the
    // failure and there is nothing lighter that detects a synchronous block.
    makeDriverExedevCapable();
    const brief = validBrief();
    const rosterPath = join(dir, "manifests", "roster.yaml");
    const mkfifo = Bun.spawnSync(["mkfifo", rosterPath]);
    // The fixture itself has to be real, or this test passes for the wrong
    // reason (a missing roster refuses too, under a different code).
    expect(mkfifo.exitCode).toBe(0);
    expect(existsSync(rosterPath)).toBeTrue();

    const err = await expectRosterRefusal(brief, "roster-rejected", rosterPath);
    // The verdict is about the FILE TYPE, not about parsing: nothing was ever
    // read out of the pipe.
    expect(err.message).toContain("not a regular file");
  });

  test("INV-2: an oversize roster.yaml → exit 2 roster-rejected before anything reads it", async () => {
    // `readFileSync` + `parseRoster` are synchronous and outside every
    // within() deadline — nothing can interrupt them — so an uncapped slurp let
    // a brief-steered multi-gigabyte roster wedge the dispatch before any
    // admission was spent: the FIFO guard's hang one sibling up, by volume
    // instead of by blocking. The verdict comes off the HANDLE fstat'd above,
    // so nothing is read out of the file either.
    makeDriverExedevCapable();
    const brief = validBrief();
    const rosterPath = join(dir, "manifests", "roster.yaml");
    // One byte over the schema's own ceiling. Content is irrelevant — the size
    // check must fire before the read, and zeros parse as nothing anyway.
    writeFileSync(rosterPath, Buffer.alloc(ROSTER_MAX_BYTES + 1));
    expect(existsSync(rosterPath)).toBeTrue();

    const err = await expectRosterRefusal(brief, "roster-rejected", rosterPath);
    // Same vocabulary as the schema's load path, so operators see one rule.
    expect(err.message).toContain(`over the ${ROSTER_MAX_BYTES}-byte`);
  });

  test("INV-2: a roster at EXACTLY the byte ceiling is ACCEPTED — the boundary is `>`", async () => {
    // The boundary control for the oversize sibling: both size checks are
    // strict (`st.size > ROSTER_MAX_BYTES`, then the re-fstat/read-length pair),
    // so a ceiling that had drifted to `>=` would refuse a legitimate
    // full-size roster and every rejection case above would stay green. The
    // fixture pads the VALID roster with a YAML comment to exactly the ceiling.
    makeDriverExedevCapable();
    const brief = validBrief();
    const rosterPath = join(dir, "manifests", "roster.yaml");
    const padding = ROSTER_MAX_BYTES - VALID_ROSTER.length;
    expect(padding).toBeGreaterThanOrEqual(4);
    const exact = `${VALID_ROSTER}# ${"x".repeat(padding - 3)}\n`;
    expect(exact.length).toBe(ROSTER_MAX_BYTES); // all-ASCII: chars == bytes
    writeFileSync(rosterPath, exact);

    // ACCEPTED means the dispatch gets PAST the roster block: `driver.create`
    // fails with a marker at the next step, which is unambiguously after it —
    // the same shape the VALID-roster positive control uses.
    driver.create = async () => {
      throw new Error("past the exact-ceiling roster pre-check");
    };
    const ledgerFactory = mock(() => goodLedger());

    try {
      await dispatch(brief, deps({ ledgerFactory }));
      failUnreachable();
    } catch (e) {
      if (e instanceof UnexpectedSuccessError) throw e;
      const err = e as FleetError;
      expect(err.code).toBe("provision-failed");
      expect(err.message).toContain("past the exact-ceiling roster pre-check");
    }
    // And the admission WAS spent — this run got all the way into provisioning.
    expect(ledgerFactory).toHaveBeenCalled();
  });

  test("INV-2: a roster path outside the gate's plain-path charset → exit 2 roster-path-unsafe", async () => {
    // `assertPathSafe` inside the gate refuses this path because it is
    // interpolated into a remote `sh` command — but the gate runs at step 9, on
    // a box that is already billing, and INV-5 then forbids tearing that box
    // down. A repo checked out under `~/My Projects/…` therefore provisioned,
    // billed and failed over a fact knowable before anything existed.
    makeDriverExedevCapable();
    validBrief(); // writes the fixture this case copies
    const manifestPath = manifestAt(join("my manifests", "pipeline.json"));
    const rosterPath = join(dir, "my manifests", "roster.yaml");
    // The roster is PRESENT and perfectly valid: the refusal must be about the
    // path, never about a file that happens to be missing too.
    writeFileSync(rosterPath, VALID_ROSTER);

    const err = await expectRosterRefusal(
      { ...validBrief(), manifestPath },
      "roster-path-unsafe",
      rosterPath,
    );
    expect(err.message).toContain("plain-path charset");
  });

  test("INV-2: an unparseable roster → exit 2 roster-rejected", async () => {
    makeDriverExedevCapable();
    const brief = validBrief();
    const rosterPath = join(dir, "manifests", "roster.yaml");
    writeFileSync(rosterPath, "roles: [ unterminated\n  - name: lead\n");

    const err = await expectRosterRefusal(brief, "roster-rejected", rosterPath);
    expect(err.message).toContain("roster rejected");
  });

  test("INV-2: a roster.yaml that is a DIRECTORY → exit 2 roster-rejected, not a bare EISDIR", async () => {
    // `existsSync` reports a directory as present, so the presence check above
    // passes it and the read is an EISDIR — untyped, that is a bare exit 1 with
    // no dispatch-log entry, on a path that is pure host-side validation.
    makeDriverExedevCapable();
    const brief = validBrief();
    const rosterPath = join(dir, "manifests", "roster.yaml");
    mkdirSync(rosterPath, { recursive: true });

    const err = await expectRosterRefusal(brief, "roster-rejected", rosterPath);
    expect(err.message).toContain("not a regular file");
  });

  test("INV-2: a roster that schema-FAILS → exit 2 roster-rejected", async () => {
    // Parseable YAML, closed-schema invalid: `roles` present but empty. The gate
    // reads this file with the same `parseRoster`, so the refusal is knowable
    // host-side and the box never needs to exist to discover it.
    makeDriverExedevCapable();
    const brief = validBrief();
    const rosterPath = join(dir, "manifests", "roster.yaml");
    writeFileSync(rosterPath, "defaults:\n  provider: anthropic\nroles: []\n");

    await expectRosterRefusal(brief, "roster-rejected", rosterPath);
  });

  test("a VALID roster beside the manifest passes the pre-check — dispatch continues to provisioning", async () => {
    // The positive control every refusal above needs. Without it a pre-check
    // that refused unconditionally satisfies all five, and the exedev path would
    // be unable to dispatch at all.
    //
    // `driver.create` is failed with a marker so the run stops at a step that
    // is unambiguously PAST the roster block: reaching `provision-failed` is
    // itself the assertion, and it needs no exedev gate to run.
    makeDriverExedevCapable();
    const brief = validBrief();
    writeFileSync(join(dir, "manifests", "roster.yaml"), VALID_ROSTER);
    driver.create = async () => {
      throw new Error("past the roster pre-check");
    };
    const ledgerFactory = mock(() => goodLedger());

    try {
      await dispatch(brief, deps({ ledgerFactory }));
      failUnreachable();
    } catch (e) {
      if (e instanceof UnexpectedSuccessError) throw e;
      const err = e as FleetError;
      expect(err.code).toBe("provision-failed");
      expect(err.message).toContain("past the roster pre-check");
    }
    // The admission WAS spent this time — which is what makes the "zero
    // admission" assertions on the five refusals above mean something.
    expect(ledgerFactory).toHaveBeenCalled();
  });

  test("a NON-exedev driver dispatches with no roster file present (no roster REFUSAL)", async () => {
    // The predicate's other half. `FakeDriver` has neither `setup` nor `fill`,
    // so a dir-box dispatch must succeed with no roster anywhere — otherwise
    // every other test in this file is running against a gate it never reaches.
    //
    // T1-13 (round 11) — the old title overclaimed "never looks for a roster
    // at all". Black-box, this test can only prove the SUCCESS path ignores a
    // MISSING roster (an implementation that existsSync'd and ignored the
    // result still passes); what it DOES refuse to let pass silently is the
    // refusal direction: a probe that errors on a missing roster. The name now
    // says exactly that much and no more.
    const brief = validBrief();
    expect(existsSync(join(dir, "manifests", "roster.yaml"))).toBeFalse();
    const result = await dispatch(brief, deps());
    expect(result.state).toBe("ready");
  });

  test("a gate-passed run's record carries the commitSha it was filled and gated against", async () => {
    // T2.1 live finding (2026-08-25): the ack carried vmName but the record
    // never stamped the pinned SHA — `fleet status`/audit could not answer
    // "which commit is this billable box running?". The stamp lands only AFTER
    // the gate passed: a refused run must not claim a provenance it never
    // reached, and the SHA written is the BRIEF's (the one fill pinned and the
    // gate prefix-checked), re-read from the record like any other consumer.
    const brief = validBrief();
    const result = await dispatch(brief, deps());
    expect(result.state).toBe("ready");
    expect(store.get(result.runId).commitSha).toBe(brief.commitSha);
  });

  /**
   * The `setTimeout` clamp is the upper bound's whole reason for existing: a
   * delay past 2^31-1 wraps to 1 ms, so a request to LENGTHEN the budget
   * inverts into the shortest one possible.
   */
  const MAX_TIMEOUT_MS = 2_147_483_647;

  // BOTH ends and the integrality rule, not just the `0` case: with only the
  // lower bound tested, deleting `> MAX_TIMEOUT_MS` or `isSafeInteger` from the
  // guard left the suite green while `timeoutMs: 1e21` armed a 1 ms deadline
  // and `timeoutMs: 1.5` reached `loadManifest`, which refuses a fractional
  // `callerBudgetMs` — reported as `manifest-rejected`, the wrong diagnosis.
  for (const [label, timeoutMs] of [
    ["zero", 0],
    ["negative", -1],
    ["fractional", 1.5],
    ["NaN", Number.NaN],
    ["Infinity", Number.POSITIVE_INFINITY],
    ["one past the setTimeout clamp", MAX_TIMEOUT_MS + 1],
    ["past 2^53", 1e21],
  ] as const) {
    test(`INV-2: a ${label} timeoutMs → exit 2 timeout-invalid, zero provisioning`, async () => {
      // A ceiling nothing can satisfy must refuse at the boundary, not mid-run.
      const ledgerFactory = mock(() => goodLedger());
      try {
        await dispatch(validBrief(), deps({ timeoutMs, ledgerFactory }));
        failUnreachable();
      } catch (e) {
        if (e instanceof UnexpectedSuccessError) throw e;
        expect((e as FleetError).exitCode).toBe(2);
        expect((e as FleetError).code).toBe("timeout-invalid");
      }
      expectSingleRefusalLine("timeout-invalid");
      expect(ledgerFactory).not.toHaveBeenCalled();
      expect(readdirSync(store.dir)).toHaveLength(0);
      expect(await driver.list()).toHaveLength(0);
    });
  }

  test("INV-2: timeoutMs AT the setTimeout clamp is accepted — armed ceiling observed via post-gate work", async () => {
    // The boundary control. Without it the guard could be `>=` — refusing the
    // largest ceiling `setTimeout` can actually honour — and every case above
    // would still pass.
    //
    // ACCEPTANCE is not the whole claim, any more than it is for the port
    // sibling (which reads the value back off the record). A guard that
    // accepted this value and then clamped the ceiling back to the 600_000
    // default would pass a bare `state: "ready"` — so the clock is advanced to
    // just under the SUPPLIED ceiling, which is nearly four hours past the
    // default. T1-14 (round 11): that observation rides on the POST-GATE
    // re-sample existing — if the re-sample were refactored away, the advance
    // past the default would go unrefused only because nothing samples there,
    // silently degrading this to acceptance-only. The renAMed title says what
    // is actually load-bearing; the mechanism itself stays, since a direct
    // arming probe would need a new seam in dispatch (disproportionate for a
    // LOW).
    const { clock, advance } = stepClock();
    const result = await dispatch(
      validBrief(),
      deps({
        timeoutMs: MAX_TIMEOUT_MS,
        clock,
        port: 8080,
        setupGate: async (drv, vm, o) => {
          const gate = await fakeGate(drv, vm, o);
          advance(MAX_TIMEOUT_MS - 1_000);
          return gate;
        },
      }),
    );
    expect(result.state).toBe("ready");
    // `toStrictEqual`, not `toEqual`: an array-like or sparse carrier satisfies
    // the loose matcher, and this is the record's port-claim contract.
    expect(store.get(result.runId).ports).toStrictEqual([8080]);
  });

  for (const [label, port] of [
    ["zero", 0],
    ["negative", -1],
    ["fractional", 8080.5],
    ["NaN", Number.NaN],
    ["one past 65535", 65_536],
  ] as const) {
    test(`INV-2: a ${label} port → exit 2 port-invalid, zero provisioning`, async () => {
      const ledgerFactory = mock(() => goodLedger());
      try {
        await dispatch(validBrief(), deps({ port, ledgerFactory }));
        failUnreachable();
      } catch (e) {
        if (e instanceof UnexpectedSuccessError) throw e;
        expect((e as FleetError).exitCode).toBe(2);
        expect((e as FleetError).code).toBe("port-invalid");
      }
      expectSingleRefusalLine("port-invalid");
      expect(ledgerFactory).not.toHaveBeenCalled();
      expect(readdirSync(store.dir)).toHaveLength(0);
      expect(await driver.list()).toHaveLength(0);
    });
  }

  test("INV-2: ports AT both ends of 1..65535 are accepted", async () => {
    // The boundary controls for the port guard, for the same reason as the
    // ceiling's: an off-by-one in either direction is invisible from the
    // rejection cases alone.
    for (const port of [1, 65_535]) {
      const result = await dispatch(validBrief(), deps({ port }));
      expect(result.state).toBe("ready");
      expect(store.get(result.runId).ports).toStrictEqual([port]);
    }
  });

  test("a re-dispatch under a run id that already has a record refuses before the admission", async () => {
    const preMinted = mintRunId();
    await dispatch(validBrief(), deps(), { runId: preMinted });

    // Booking the issue's cap a second time and then dying on EEXIST leaves the
    // reservation committed against an issue that got nothing for it.
    const ledgerFactory = mock(() => goodLedger());
    try {
      await dispatch(validBrief(), deps({ ledgerFactory }), { runId: preMinted });
      failUnreachable();
    } catch (e) {
      if (e instanceof UnexpectedSuccessError) throw e;
      expect((e as FleetError).exitCode).toBe(2);
      expect((e as FleetError).code).toBe("run-id-in-use");
    }
    expectSingleRefusalLine("run-id-in-use");
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
    //
    // F12 (round 11): a PATHLESS EEXIST is no longer classified as run-id-in-use
    // — it can equally be a provider's bare errno, and refusing that as exit-2
    // do-not-retry sent operators away from a retryable substrate condition.
    // Only an EEXIST whose `path` names THIS run's record file is the arbiter's
    // verdict, so the fixture carries the real store's own path shape (Node/Bun
    // set `.path` on every wx-open EEXIST — verified against RunRecordStore).
    const preMinted = mintRunId();
    const eexist = Object.assign(
      new Error(`EEXIST: file already exists, open '${store.path(preMinted)}'`),
      { code: "EEXIST", path: store.path(preMinted) },
    );
    store.create = () => {
      throw eexist;
    };
    const ledgerFactory = mock(() => goodLedger());

    try {
      await dispatch(validBrief(), deps({ ledgerFactory }), { runId: preMinted });
      failUnreachable();
    } catch (e) {
      if (e instanceof UnexpectedSuccessError) throw e;
      expect(e).toBeInstanceOf(FleetError);
      const err = e as FleetError;
      expect(err.exitCode).toBe(2);
      expect(err.code).toBe("run-id-in-use");
      expect(err.payload?.runId).toBe(preMinted);
      // The provider's errno stays diagnosis, never classification: an operator
      // greps the fleet code, so `EEXIST` must not have become it.
      expect(err.payload?.providerCode).toBeUndefined();
    }
    expectSingleRefusalLine("run-id-in-use");
    // This is the CONCURRENT branch, not the step-4 one: the admission was
    // already spent by the time the create refused. Asserting it is what tells
    // the two run-id-in-use sites apart — the sibling above asserts the
    // opposite, and without this pair either test could be satisfied by the
    // other's code path.
    expect(ledgerFactory).toHaveBeenCalled();
    // No box was ever created: `store.create` is the first half of the step.
    expect(await driver.list()).toHaveLength(0);
  });

  test("INV-4-bis: the EEXIST loser does not stamp its requestId onto the WINNER's record", async () => {
    // The provisioning catch used to run `stampCorrelation()` FIRST, before the
    // EEXIST classification. On the shared-runId race that stamp merged the
    // LOSER's requestId onto the WINNER's record — the store merges patches, so
    // the winner's correlation was overwritten and INV-4-bis's join key
    // inverted: each dispatch's log lines joined to the other's run.
    //
    // The fixture is the stubbed-create sibling above plus a planted winner:
    // the record exists under the id with THE WINNER'S correlation, but the
    // fast-path existence probe must report it ABSENT (or step 4 refuses before
    // the catch is ever reached), and `store.create` must still report the id
    // taken. Exactly one `store.get` lie covers both — `recordExists` treats
    // ENOENT as absent.
    const preMinted = mintRunId();
    const winnerRequestId = "9f1754e8-1c32-4bc7-8e0d-34f39bc8e5a2";
    store.create(preMinted);
    store.set(preMinted, { requestId: winnerRequestId });
    // F12 (round 11): the arbiter arm requires the EEXIST's `path` to name this
    // run's record file (see the sibling above for why the pathless shape is no
    // longer classified as run-id-in-use).
    const eexist = Object.assign(
      new Error(`EEXIST: file already exists, open '${store.path(preMinted)}'`),
      { code: "EEXIST", path: store.path(preMinted) },
    );
    const realGet = store.get.bind(store);
    let probes = 0;
    store.get = (runId: string) => {
      if (probes++ === 0) {
        throw Object.assign(new Error(`ENOENT: no such file '${runId}'`), { code: "ENOENT" });
      }
      return realGet(runId);
    };
    store.create = () => {
      throw eexist;
    };
    const ledgerFactory = mock(() => goodLedger());

    try {
      await dispatch(validBrief(), deps({ ledgerFactory }), { runId: preMinted });
      failUnreachable();
    } catch (e) {
      if (e instanceof UnexpectedSuccessError) throw e;
      const err = e as FleetError;
      expect(err.exitCode).toBe(2);
      expect(err.code).toBe("run-id-in-use");
      expect(err.payload?.runId).toBe(preMinted);
    }
    // The CONCURRENT branch (the sibling pins why that matters).
    expect(ledgerFactory).toHaveBeenCalled();
    // The winner's join key survived the loser's refusal verbatim.
    expect(realGet(preMinted)?.requestId).toBe(winnerRequestId);
  });

  test("two GENUINELY concurrent dispatches on one runId: the real store arbitrates, and the loser's reservation is stranded", async () => {
    // The sibling above stubs `store.create` to throw EEXIST, so it proves the
    // MAPPING and nothing about the window. This one runs two dispatches
    // against the real store and FORCES the overlap: the first headroom call
    // PARKS until the second dispatch has COMMITTED at its step-4 existence
    // probe. The headroom step sits strictly after that probe and strictly
    // before `store.create`, so once the gate opens, each arm has provably
    // found no record and is committed into exactly the window whose arbiter
    // is `store.create`'s O_EXCL — whichever continuation resumes first wins
    // it, the other provably loses IN the window rather than at the fast path.
    //
    // The release signal is the PROBE, not a second arrival inside headroom:
    // a barrier that parks the first headroom read until a second one arrives
    // DEADLOCKS once admission is single-flight (DF3.2's fleet-ceiling fix) —
    // the queued loser never reaches its read, so the first would hold the
    // section forever. The probe runs before the section is entered, so the
    // overlap is still forced on unfixed code and deadlock-free on fixed code.
    //
    // Without the barrier this test bet on natural interleaving: if a scheduler
    // or refactor ever serialized the arms, the loser would take the step-4
    // FAST PATH instead — same refusal code, same exit, every assertion below
    // still green, and the window silently unexercised. The `lists` count
    // asserted below is the tripwire that replaced the old park-forever one:
    // a regression that skips headroom entirely starves it and fails here,
    // naming the fixture rather than misreporting as a pass.
    const preMinted = mintRunId();
    // ONE ledger for both arms, so `admitCalls` counts across them. The default
    // `ledgerFactory` mints a fresh throwaway per call, which is precisely what
    // makes the double-admission window unobservable.
    const ledger = goodLedger();
    let probes = 0;
    let releaseBarrier: () => void = () => {};
    const bothProbed = new Promise<void>((r) => {
      releaseBarrier = r;
    });
    const realGet = store.get.bind(store);
    store.get = (runId: string) => {
      try {
        return realGet(runId);
      } finally {
        // `finally`, not the return path: `store.get` THROWS ENOENT for a
        // missing record (it is `recordExists`'s own catch arm that maps that
        // to "free"), and a probe counted only on return never fires.
        probes += 1;
        if (probes === 2) releaseBarrier();
      }
    };
    let lists = 0;
    // Same D3 path as the AC8 tests: the headroom read goes through the
    // anomaly channel on a driver that has one, so this is where both racers
    // must block for the window to be real.
    const realList = driver.listWithAnomalies.bind(driver);
    driver.listWithAnomalies = async () => {
      lists += 1;
      await bothProbed;
      return realList();
    };

    const settled = await Promise.allSettled([
      dispatch(validBrief(), deps({ ledgerFactory: () => ledger }), { runId: preMinted }),
      dispatch(validBrief(), deps({ ledgerFactory: () => ledger }), { runId: preMinted }),
    ]);

    // Both arms took the headroom read — the window really was exercised.
    expect(lists).toBe(2);

    const winners = settled.filter((s) => s.status === "fulfilled");
    const losers = settled.filter((s) => s.status === "rejected");
    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(1);
    const err = (losers[0] as PromiseRejectedResult).reason as FleetError;
    expect(err).toBeInstanceOf(FleetError);
    // The SAME refusal as the sequential re-dispatch, not `provision-failed`:
    // exit 1 would send the operator hunting a substrate fault that is not there.
    expect(err.exitCode).toBe(2);
    expect(err.code).toBe("run-id-in-use");
    expect(err.payload?.runId).toBe(preMinted);

    // Exactly one record and exactly one box — the point of the O_EXCL.
    expect(readdirSync(store.dir)).toEqual([`${preMinted}.json`]);
    expect(await driver.list()).toHaveLength(1);
    expect((winners[0] as PromiseFulfilledResult<{ runId: string }>).value.runId).toBe(preMinted);

    // ── reservation accounting. With the barrier above, the count is no longer
    // a tripwire but a SPECIFICATION: both arms passed step 4 before either
    // resumed, so each commits exactly one booking against the issue's cap
    // before arbitration — two admissions, both for THIS run, both handles
    // closed. The loser's RESERVATION itself remains KNOWN STRANDED (finding
    // A12): `admitIssue`'s orphan guard expires it only when NO record resolves
    // for the id, and the winner's record does, so it ages out with the
    // winner's run instead of being released at the refusal. Releasing it is a
    // COST-LEDGER change — `admitIssue`'s contract forbids caller-side release —
    // so this layer documents the stranding rather than pretending the leak is
    // the design. The exact counts below stay correct across that fix: retiring
    // the loser's booking changes the ledger's balance, not the number of times
    // the gate was asked.
    expect(ledger.admitCalls).toHaveLength(2);
    // Every booking is against THIS run — a stranded reservation on some other
    // id is a different, worse bug than the one being tolerated.
    expect(new Set(ledger.admitCalls.map((c) => c.input.runId))).toEqual(new Set([preMinted]));
    // Every handle opened is closed, on the winning path and the losing one —
    // the leak is the reservation, never the fd.
    expect(ledger.closeCalls).toBe(2);
  });

  test("N concurrent dispatches on DISTINCT ids racing headroom admit exactly ONE — the fleet-ceiling race, closed in-process", async () => {
    // The round-10 pin (df3-1 review, finding DF13) froze the overshoot: two
    // dispatches parked inside step 5's `driver.list()` against maxVms=1 were
    // BOTH told `allowed: true` and both provisioned, because `checkHeadroom`
    // is a bare READ (see the long comment over step 6 in src/fleet/dispatch.ts).
    // DF3.2 closes the IN-PROCESS half: the admission critical section —
    // headroom read → decision → box create — is single-flight, so the second
    // dispatch re-lists AFTER the first's box exists and takes the ordinary
    // `vm-ceiling` refusal. This is that pin flipped red-to-green per the
    // round-10 handoff; the CROSS-PROCESS half (two CLI invocations, or a
    // fan-out's aggregate list vs a concurrent plain dispatch) stays open and
    // documented in dispatch.ts.
    //
    // The barrier parks the first list until the second dispatch has COMMITTED
    // to admission — observed at its `recordExists` store.get probe, which runs
    // BEFORE the critical section. Parking until a second arrival INSIDE the
    // list (the old pin's shape) would deadlock a single-flight loser that
    // never gets to list at all; releasing on the probe keeps the interleaving
    // real for unfixed code and deadlock-free for fixed code.
    const probed = new Set<string>();
    let releaseBarrier: () => void = () => {};
    const bothCommitted = new Promise<void>((r) => {
      releaseBarrier = r;
    });
    const realGet = store.get.bind(store);
    // `finally`, not the return path: `store.get` THROWS ENOENT for a missing
    // record (it is `recordExists`'s own catch arm that maps that to "free"),
    // and a probe counted only on return never fires for either dispatch.
    store.get = (runId: string) => {
      try {
        return realGet(runId);
      } finally {
        if (!probed.has(runId)) {
          probed.add(runId);
          if (probed.size === 2) releaseBarrier();
        }
      }
    };
    const realList = driver.list.bind(driver);
    driver.list = async (name?: string) => {
      await bothCommitted;
      return realList(name);
    };

    const settled = await Promise.allSettled([
      dispatch(validBrief(), deps({ quotaLimits: limitsWith({ maxVms: 1 }) }), { runId: mintRunId() }),
      dispatch(validBrief(), deps({ quotaLimits: limitsWith({ maxVms: 1 }) }), { runId: mintRunId() }),
    ]);

    // The race really happened: both dispatches were in flight before either
    // listed — the overshoot precondition the old pin relied on.
    expect(probed.size).toBe(2);

    // Exactly ONE won. The loser is the ordinary sequential refusal, not a
    // crash and not a silent overshoot.
    const winners = settled.filter((s) => s.status === "fulfilled");
    const losers = settled.filter((s) => s.status === "rejected");
    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(1);
    const loser = (losers[0] as PromiseRejectedResult).reason as FleetError;
    expect(loser).toBeInstanceOf(FleetError);
    expect(loser.exitCode).toBe(5);
    expect(loser.code).toBe("no-headroom");
    expect(loser.payload?.reason).toBe("vm-ceiling");
    // The refusal counted the WINNER's box — the single-flight re-list saw it.
    expect(loser.payload?.liveVms).toBe(1);
    expect(loser.payload?.ceiling).toBe(1);

    // The ceiling held on every surface: one record, one box.
    expect(readdirSync(store.dir)).toHaveLength(1);
    const live = await realList();
    expect(live).toHaveLength(1);
    // AC4: the loser filed exactly one joinable refusal line, do-not-retry —
    // a full ceiling is the fleet's steady state, not a fault.
    const refused = expectSingleRefusalLine("no-headroom");
    expect(refused.exitStatus).toBe("logic");
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
    // The "taken" stand-ins carry a FULL record shape, seeded from a real record
    // in a throwaway store: `{ runId, createdAt } as RunRecord` left every other
    // field undefined, so a future existence probe branching on another field
    // silently exercised a state no real record ever has.
    const shapeSeed = new RunRecordStore(join(dir, "shape-seed")).create(mintRunId());
    store.get = (runId: string) => {
      probes += 1;
      // The first two minted ids are "already taken". Later reads — `store.set`
      // does its own read-modify-write through `get` — go to the real store.
      if (probes <= 2) {
        taken.add(runId);
        return { ...shapeSeed, runId };
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
    let probes = 0;
    // Full-record stand-ins, seeded from a real record exactly like the
    // self-minted-collision sibling: `{ runId, createdAt } as RunRecord` left
    // every other field undefined, so an existence probe branching on another
    // field silently exercised a state no real record ever has.
    const shapeSeed = new RunRecordStore(join(dir, "unmintable-seed")).create(mintRunId());
    store.get = (runId: string) => {
      probes += 1;
      return { ...shapeSeed, runId };
    };

    try {
      await dispatch(validBrief(), deps());
      failUnreachable();
    } catch (e) {
      if (e instanceof UnexpectedSuccessError) throw e;
      expect(e).toBeInstanceOf(FleetError);
      const err = e as FleetError;
      expect(err.exitCode).toBe(1);
      expect(err.code).toBe("run-id-unmintable");
      expect(err.payload?.runId).toBeNull();
      expect(err.payload).not.toHaveProperty("teardownCommand");
      expect((refusalLines()[0] as LogEntry).runId).toBeNull();
    }
    // MINT_RETRIES re-mints plus the first attempt. Pinned exactly: 1 is an
    // early `break` and anything unbounded is the spin the bound exists to stop.
    // The constant mirrors dispatch.ts's unexported `MINT_RETRIES` — if that
    // changes, THIS literal is the one to move, and the failure message below
    // says so.
    const DISPATCH_MINT_RETRIES = 4;
    expect(probes, `${probes} existence probes ≠ 1 + ${DISPATCH_MINT_RETRIES} re-mints — update DISPATCH_MINT_RETRIES if src/fleet/dispatch.ts's MINT_RETRIES changed`).toBe(
      DISPATCH_MINT_RETRIES + 1,
    );
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
      failUnreachable();
    } catch (e) {
      if (e instanceof UnexpectedSuccessError) throw e;
      expect(e).toBeInstanceOf(FleetError);
      const err = e as FleetError;
      expect(err.exitCode).toBe(1);
      expect(err.code).toBe("record-read-failed");
      expect(err.payload?.providerCode).toBe("EACCES");
      // Pre-provision: nothing to tear down.
      expect(err.payload).not.toHaveProperty("teardownCommand");
      // The comment above stakes this refusal on the dispatch-log entry and the
      // structured line every exit owes — asserted here, or an untyped escape
      // that files neither would satisfy everything above. `ctxRunId` is set
      // the moment a candidate id is chosen, so the line joins to THIS
      // dispatch's own freshly minted (never persisted) candidate — `null`
      // would be wrong here; null is the unmintable loop's answer, where the id
      // belongs to another run.
      const refused = expectSingleRefusalLine("record-read-failed");
      expect(refused.runId).toMatch(/^qds-\d{8}-[a-f0-9]{6}$/);
      expect(refused.runId).toBe(err.payload?.runId);
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
      failUnreachable();
    } catch (e) {
      if (e instanceof UnexpectedSuccessError) throw e;
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
    // AC4's evidence trail, which this arm never asserted while its siblings
    // did: a budget refusal that files no structured line leaves an exit code
    // and nothing to join it to.
    expectSingleRefusalLine("budget-exceeded");
    // The refusal path closes the handle too — a leaked SQLite handle per
    // refused dispatch is invisible until the fleet runs out of them.
    expect(ledger.closeCalls).toBe(1);
  });

  test("AC7: spent EXACTLY AT the cap refuses — the decision shape's own boundary", async () => {
    // The sibling above refuses at spent 12_000_000 / cap 10_000_000. Equality
    // is the boundary the DECISION shape owns (`assertWithinBudget` forwards
    // whatever `admitIssue` decided; the gate throws on the refused variant,
    // whose contract is "at or over cap"). A dispatch-side rewrite that compared
    // `spent > cap` — or dropped the refused arm to admit anything with a
    // status string — passes the strictly-over sibling and mints a key for an
    // issue with zero headroom.
    const cap = 10_000_000;
    let closeCalls = 0;
    const ledger: LedgerLike = {
      config: { defaultCapMicroUsd: cap, perIssueOverrides: {} },
      issueBudgetSnapshot: () => ({ ceilingMicroUsd: cap, spentMicroUsd: cap, reservedMicroUsd: 0 }),
      admitIssue() {
        return {
          admitted: false as const,
          status: "over-budget" as const,
          reason: "spend-cap-exceeded" as const,
          capMicroUsd: cap,
          spentMicroUsd: cap, // EXACTLY equal, not over
          reservedMicroUsd: 0,
          unpricedRows: 0,
        };
      },
      close() {
        closeCalls += 1;
      },
    };

    try {
      await dispatch(validBrief(), deps({ ledgerFactory: () => ledger }));
      failUnreachable();
    } catch (e) {
      if (e instanceof UnexpectedSuccessError) throw e;
      const err = e as FleetError;
      expect(err.exitCode).toBe(5);
      expect(err.code).toBe("budget-exceeded");
      // Both figures ride the payload, EQUAL — the shape the operator reads.
      expect(err.payload?.capMicroUsd).toBe(cap);
      expect(err.payload?.spentMicroUsd).toBe(cap);
    }
    expectSingleRefusalLine("budget-exceeded");
    expect(closeCalls).toBe(1);
    expect(readdirSync(store.dir)).toHaveLength(0);
    expect(await driver.list()).toHaveLength(0);
  });

  test("DF3.6a: an admitted ceiling below the resolved resident ceiling refuses BEFORE provisioning", async () => {
    // The fill stamp would deliver capMicroUsd = admittedCeilingMicroUsd, so
    // a manifest whose resident ceiling (here the 8,000 µ$ fallback — the
    // default brief declares none) exceeds what admission granted is a run
    // the IN-BOX ENGINE refuses bound-config-invalid at arm — after the box
    // billed and the key minted. The host-side guard refuses the same verdict
    // at zero spend (the roster pre-check's doctrine), with an actionable
    // remediation.
    const createSpy = mock(() => Promise.resolve({ name: "test", status: "running" } as ProviderVm));
    driver.create = createSpy;
    const ledger = goodLedger(5_000); // admitted 5,000 µ$ < the 8,000 µ$ fallback ceiling

    try {
      await dispatch(validBrief(), deps({ ledgerFactory: () => ledger }));
      failUnreachable();
    } catch (e) {
      if (e instanceof UnexpectedSuccessError) throw e;
      const err = e as FleetError;
      expect(err.exitCode).toBe(5);
      expect(err.code).toBe("resident-ceiling-unfundable");
      expect(err.payload?.admittedCeilingMicroUsd).toBe(5_000);
      expect(err.payload?.residentSpendCeilingMicros).toBe(8_000);
      expect(err.message).toContain("resident spend ceiling");
      // Zero provisioning — admission ran (the ledger was consulted), but no
      // box, no record, no key.
      expect(createSpy).not.toHaveBeenCalled();
      expect(readdirSync(store.dir)).toHaveLength(0);
    }
    expectSingleRefusalLine("resident-ceiling-unfundable");
    expect(ledger.closeCalls).toBe(1);
  });

  test("AC7: {admitted:true} still checks budget (only headroom suppressed)", async () => {
    // "ONLY headroom" is half the claim, and nothing here used to test it: with
    // an ordinary quota the headroom gate ALLOWS, so deleting the `opts.admitted`
    // short-circuit entirely left this green — the budget refusal fired either
    // way, one step later.
    //
    // A quota that would REFUSE is what tells them apart. Headroom runs BEFORE
    // the budget gate, so with the short-circuit deleted this dispatch exits 5
    // `no-headroom` and never reaches the ledger at all; with it, the ledger is
    // asked and `budget-exceeded` is the answer.
    const brief = validBrief();
    const listSpy = mock(() => Promise.resolve([] as ProviderVm[]));
    driver.list = listSpy;
    const createSpy = mock(() => Promise.resolve({ name: "test", status: "running" } as ProviderVm));
    driver.create = createSpy;
    const mintSpy = mock((_name: string, limit: number) =>
      Promise.resolve({ key: "sk-test", hash: "abc", limitUsd: limit, usageUsd: 0 }),
    );
    keyApi.createKey = mintSpy;
    const ledger = overBudgetLedger();

    try {
      await dispatch(
        brief,
        deps({ ledgerFactory: () => ledger, quotaLimits: limitsWith({ maxVms: 0 }) }),
        { admitted: true },
      );
      failUnreachable();
    } catch (e) {
      if (e instanceof UnexpectedSuccessError) throw e;
      expect(e).toBeInstanceOf(FleetError);
      const err = e as FleetError;
      expect(err.exitCode).toBe(5);
      expect(err.code).toBe("budget-exceeded");
      // Same "nothing happened" the plain over-budget sibling pins — the
      // short-circuit suppresses one GATE, not the refusal's obligations. A
      // key minted before the budget answer leaves a live, spendable
      // credential no record names; neither the box count nor the exit code
      // would see it.
      expect(createSpy).not.toHaveBeenCalled();
      expect(mintSpy).not.toHaveBeenCalled();
      expect(readdirSync(store.dir)).toHaveLength(0);
    }
    expectSingleRefusalLine("budget-exceeded");
    // The budget gate was REACHED and asked about this issue…
    expect(ledger.admitCalls).toHaveLength(1);
    expect(ledger.closeCalls).toBe(1);
    // …and the headroom gate was not: `checkHeadroom` is the only caller of
    // `driver.list` on this path.
    expect(listSpy).not.toHaveBeenCalled();
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

  test("AC7 (T2-8): an ADMISSION throw means driver.create is never called — production gate-before-provision ordering", async () => {
    // What budget-gate.test.ts's "zero creates" assertions can NOT prove: there,
    // `admitAndProvision` is the TEST'S OWN helper calling assertWithinBudget
    // before provisionAdmittedRun, so a refusal makes reaching driver.create
    // structurally impossible — the assertions verify the helper's sequencing.
    // Production ordering lives HERE, in dispatch's admission critical section:
    // assertWithinBudget and provisionAdmittedRun are two separate calls whose
    // order the dispatcher owns. A refactor that provisions before admitting (the
    // double-admission bug INV-COST-3/DF13 closed) flips them, this box gets
    // created against a ledger that never admitted it, and only THIS pin notices.
    //
    // The fault is an admitIssue that THROWS (worse than refusing — nothing in
    // the provisioning path can have run if even the gate did not return), and
    // `admitCalls` carries the one probe that shows the gate itself was reached.
    const brief = validBrief();
    const createSpy = mock(() => Promise.resolve({ name: "test", status: "running" } as ProviderVm));
    driver.create = createSpy;
    const mintSpy = mock(() => Promise.resolve({ key: "sk-test", hash: "abc", limitUsd: 50, usageUsd: 0 }));
    keyApi.createKey = mintSpy;

    let closeCalls = 0;
    let asked = false;
    const ledger: LedgerLike = {
      config: { defaultCapMicroUsd: 10_000_000, perIssueOverrides: {} },
      issueBudgetSnapshot: () => ({ ceilingMicroUsd: Number.MAX_SAFE_INTEGER, spentMicroUsd: 0, reservedMicroUsd: 0 }),
      admitIssue() {
        asked = true; // the gate WAS reached…
        throw new Error("admission exploded"); // …and blew up instead of admitting
      },
      close() {
        closeCalls += 1;
      },
    };

    try {
      await dispatch(brief, deps({ ledgerFactory: () => ledger }));
      failUnreachable();
    } catch (e) {
      if (e instanceof UnexpectedSuccessError) throw e;
      // Classified as an admission failure (exit 5), not an untyped crash —
      // this also keeps the pin honest about WHERE the ordering broke.
      const err = e as FleetError;
      expect(err.exitCode).toBe(5);
      expect(err.code).toBe("admission-failed");
      expect(err.message).toContain("admission exploded");
    }
    expect(asked).toBeTrue(); // the gate really ran, so the refusal is real
    // THE ORDERING PIN: no box, no key, no record. Any call ordering other than
    // admit-then-provision fails at least one of these three.
    expect(createSpy).not.toHaveBeenCalled();
    expect(mintSpy).not.toHaveBeenCalled();
    expect(readdirSync(store.dir)).toHaveLength(0);
    // The refused dispatch still closed its ledger handle.
    expect(closeCalls).toBe(1);
  });

  test("AC7: a perIssueOverride is what reaches admitIssue — and it is matched CANONICALLY", async () => {
    // Every fixture in this file leaves `perIssueOverrides` empty, so
    // `capForIssue`'s override branch never ran at this seam and the sibling
    // above is a round-trip through the fixture's own default: delete the
    // override lookup from the budget gate entirely and it stays green.
    //
    // The override key is deliberately spelled in a DIFFERENT CASE from the
    // brief's slug. GitHub folds owner/name, so these name one issue — and an
    // override authored as `Owner/Repo#42` that quietly fails to apply to a
    // dispatch spelling it `owner/repo` reverts the cap to the default, which is
    // the failure direction that costs money.
    const override = 3_500_000;
    // Built INLINE, not through `goodLedger`: `LedgerLike.config` is a
    // `Pick<CostLedger, …>` and therefore READ-ONLY, and the shared fixture's
    // `perIssueOverrides` is `{}` by construction — which is exactly why this
    // branch had no coverage at this seam.
    const admitCalls: Array<{ input: AdmissionInput; capMicroUsd: number }> = [];
    let closeCalls = 0;
    const ledger: LedgerLike = {
      config: {
        defaultCapMicroUsd: 99_000_000,
        perIssueOverrides: {
          "Owner/Repo#42": override,
          // A near-miss on the SAME repo, to prove the issue number is part of
          // the key rather than the slug alone.
          "owner/repo#43": 1_000,
        },
      },
      issueBudgetSnapshot: () => ({ ceilingMicroUsd: 99_000_000, spentMicroUsd: 0, reservedMicroUsd: 0 }),
      admitIssue(input, capMicroUsd) {
        admitCalls.push({ input, capMicroUsd });
        return {
          admitted: true as const,
          status: "within-budget" as const,
          admittedCeilingMicroUsd: defaultKeyCapMicroUsd,
          // The resolved cap, echoed back — so a dispatcher that ignored what it
          // was handed and re-derived one downstream is still caught.
          capMicroUsd,
          spentMicroUsd: 0,
          reservedMicroUsd: 0,
          remainingMicroUsd: defaultKeyCapMicroUsd,
          unpricedRows: 0,
        };
      },
      close() {
        closeCalls += 1;
      },
    };

    const result = await dispatch(validBrief(), deps({ ledgerFactory: () => ledger }));

    expect(admitCalls).toHaveLength(1);
    const call = admitCalls[0] as (typeof admitCalls)[number];
    expect(call.capMicroUsd).toBe(override);
    // Not the default, and not the neighbouring issue's — named explicitly, so
    // the failure message says which of the three the dispatcher picked.
    expect(call.capMicroUsd).not.toBe(99_000_000);
    expect(call.input.repoSlug).toBe("owner/repo");
    expect(call.input.issueId).toBe("42");
    // The success path closes the handle too — the inline fixture is the only
    // one in this file whose `close` was a silent no-op, so a dispatch that
    // stopped closing on the happy path failed every OTHER ledger test but
    // sailed through this one.
    expect(closeCalls).toBe(1);
    expect(result.state).toBe("ready");
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
      failUnreachable();
    } catch (e) {
      if (e instanceof UnexpectedSuccessError) throw e;
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

  test("AC7: an admitIssue that THROWS refuses (exit 5) and still closes the handle", async () => {
    // The untyped-throw sibling below injects the failure at `ledgerFactory`,
    // i.e. before a ledger object exists — so the `finally` that closes it is
    // trivially satisfied. This is the other side: the gate WAS reached, a real
    // handle is open, and the throw comes from inside `admitIssue`. That is the
    // one place a `close()` outside a `finally` gets skipped, and the real
    // ledger owns a SQLite handle, so it is one leaked fd per failed dispatch.
    const ledger = admitThrowsLedger();
    const createSpy = mock(() => Promise.resolve({ name: "test", status: "running" } as ProviderVm));
    driver.create = createSpy;

    try {
      await dispatch(validBrief(), deps({ ledgerFactory: () => ledger }));
      failUnreachable();
    } catch (e) {
      if (e instanceof UnexpectedSuccessError) throw e;
      expect(e).toBeInstanceOf(FleetError);
      const err = e as FleetError;
      expect(err.exitCode).toBe(5);
      // The FLEET code stays fixed for every untyped admission failure.
      expect(err.code).toBe("admission-failed");
      expect(err.message).toContain(ADMIT_THROW_MESSAGE);
      // A plain `Error` carries no `code`, and an absent code is named by
      // omission rather than by a fabricated fallback.
      expect(err.payload).not.toHaveProperty("providerCode");
    }
    // The gate was REACHED and blew up — distinct from never having been called,
    // which every pre-admission refusal in this file asserts instead.
    expect(ledger.admitCalls).toHaveLength(1);
    expect(ledger.closeCalls).toBe(1);
    // And it files the evidence trail every other exit owes (shared minimum).
    expectSingleRefusalLine("admission-failed");
    expect(createSpy).not.toHaveBeenCalled();
    expect(readdirSync(store.dir)).toHaveLength(0);
  });

  test("AC7: a typed CostLedgerError keeps its OWN message, remediation and code — as PAYLOAD", async () => {
    // The typed arm, distinct from `admission-failed` above: a `CostLedgerError`
    // carries a real diagnosis and the operator's actual next command, and
    // collapsing it into the untyped arm would report a ledger-schema mismatch
    // or a locked ledger file as the generic "budget admission failed" with the
    // module's own fallback advice, losing both.
    //
    // The `code` is the one thing that does NOT pass through. This CLI's
    // exit-code table is its own (F3, module header) — `providerCodePayload`'s
    // rule — so the fleet code is fixed at `ledger-failed` and the ledger's own
    // goes in the payload as `providerCode`. Passing it through made a rename in
    // `cost-ledger.ts` silently change which rows an operator's dispatch-log
    // grep returns, which is exactly the drift the rule exists to prevent; that
    // the ledger's table is first-party and closed makes it a table two modules
    // must be renamed in step, not this module's table.
    const ledger = goodLedger();
    ledger.admitIssue = () => {
      throw new CostLedgerError(
        "ledger-schema-mismatch",
        "cost ledger schema is at version 3, this build expects 4",
        "run the ledger migration, then retry",
      );
    };

    try {
      await dispatch(validBrief(), deps({ ledgerFactory: () => ledger }));
      failUnreachable();
    } catch (e) {
      if (e instanceof UnexpectedSuccessError) throw e;
      expect(e).toBeInstanceOf(FleetError);
      const err = e as FleetError;
      expect(err.exitCode).toBe(5);
      expect(err.code).toBe("ledger-failed");
      expect(err.payload?.providerCode).toBe("ledger-schema-mismatch");
      expect(err.message).toBe("cost ledger schema is at version 3, this build expects 4");
      expect(err.remediation).toBe("run the ledger migration, then retry");
    }
    expectSingleRefusalLine("ledger-failed");
    expect(ledger.closeCalls).toBe(1);
    expect(readdirSync(store.dir)).toHaveLength(0);
    expect(await driver.list()).toHaveLength(0);
  });

  test("a ledger whose close() THROWS does not fail an otherwise successful run — it is NAMED", async () => {
    // `close()` is where the reservation write is flushed, so a throw here means
    // the ledger may hold no record of the admission just granted and the next
    // dispatch for this issue overcommits the cap. Rethrowing would turn a
    // successful run into a crash after the box, the key and the gate are all
    // done; swallowing silently makes the overcommit undiagnosable. The
    // contract is "report, proceed", and neither half of it was tested.
    const ledger = closeThrowsLedger();

    const result = await dispatch(validBrief(), deps({ ledgerFactory: () => ledger }));

    // PROCEED: the run is fully provisioned and acked.
    expect(result.state).toBe("ready");
    expect(store.get(result.runId).vmName).toBe(result.vmName);
    // The attempt was made — distinguishable from never closing at all.
    expect(ledger.closeCalls).toBe(1);

    // REPORT: on the structured log, under its own code, and classified
    // `transient` — an operator retries the flush, they do not rewrite a brief.
    const closeFailures = entries.filter(
      (e) => (e.error as { code?: string } | undefined)?.code === "ledger-close-failed",
    );
    expect(closeFailures).toHaveLength(1);
    const line = closeFailures[0] as LogEntry;
    expect(line.status).toBe("error");
    expect(line.exitStatus).toBe("transient");
    expect(line.phase).toBe("admitted");
    // Joinable: the line names the run whose reservation may be unflushed.
    expect(line.runId).toBe(result.runId);
    expect(line.requestId).toBe(result.requestId);
    expect(String((line.error as { message?: unknown }).message)).toContain(CLOSE_THROW_MESSAGE);
    // …and the failure is NOT reported as the run's own outcome: the terminal
    // line is still the success one.
    expect(entries.some((e) => e.phase === "ready" && e.status === "ok")).toBeTrue();
    expect(refusalLines()).toHaveLength(0);
  });

  // ─── Admission: headroom gate (AC8) ───────────────────────────────────────────────

  test("AC8: checkHeadroom allowed:false → FleetError exit 5, zero provisioning", async () => {
    const brief = validBrief();
    // checkHeadroom reads the ANOMALY channel on a driver that has one (D3:
    // a skipped row is a possible live box and must never be undercounted) —
    // so the fleet is seeded through `listWithAnomalies`, not `list`.
    const listSpy = mock(() =>
      Promise.resolve({
        vms: [
          { name: "box1", status: "running" },
          { name: "box2", status: "running" },
          { name: "box3", status: "running" },
        ],
        skipped: [],
      } as never),
    );
    driver.listWithAnomalies = listSpy;

    const loaded = limitsWith({ maxVms: 3 }); // 3 live == ceiling → headroom 0
    const requestId = "7d2c1b0a-9f8e-4d7c-b6a5-4e3d2c1b0a9f";

    const createSpy = mock(() => Promise.resolve({ name: "test", status: "running" } as ProviderVm));
    driver.create = createSpy;
    // The mint spy its `list-unverified` sibling asserts and this one only
    // CLAIMED to share: a refusal that minted a key first leaves a live,
    // spendable credential with no record naming it, which the exit code and
    // the box count are both blind to.
    const mintSpy = mock((_name: string, limit: number) =>
      Promise.resolve({ key: "sk-test", hash: "abc", limitUsd: limit, usageUsd: 0 }),
    );
    keyApi.createKey = mintSpy;

    try {
      await dispatch(brief, deps({ quotaLimits: loaded, requestId }));
      failUnreachable();
    } catch (e) {
      if (e instanceof UnexpectedSuccessError) throw e;
      expect(e).toBeInstanceOf(FleetError);
      const err = e as FleetError;
      expect(err.exitCode).toBe(5);
      expect(err.code).toBe("no-headroom");
      expect(createSpy).not.toHaveBeenCalled();
      expect(mintSpy).not.toHaveBeenCalled();
      expect(readdirSync(store.dir)).toHaveLength(0);
    }
    // AC4's evidence trail, which neither headroom arm asserted before: a
    // refusal that files no structured line leaves the operator with an exit
    // code and nothing to join it to.
    const refused = expectSingleRefusalLine("no-headroom");
    // And the DEFAULT classification stays do-not-retry: a full ceiling is the
    // fleet's steady state, not a fault — wave 2's retry logic must NOT spin on
    // it. The `list-unverified` sibling pins the one reason that overrides this.
    expect(refused.exitStatus).toBe("logic");
    // Joinable: the line carries THIS dispatch's resolved correlation id, not
    // the unresolved sentinel an operator cannot grep back to the CLI call.
    expect(refused.requestId).toBe(requestId);
  });

  test("AC8: checkHeadroom list-unverified → FleetError exit 5", async () => {
    const brief = validBrief();
    const requestId = "2b3c4d5e-6f70-4a1b-8c9d-0e1f2a3b4c5d";
    // Same D3 path as the sibling: the enumeration refusal has to fire through
    // the anomaly channel the gate actually reads. A throwing channel — or a
    // non-empty `skipped`, pinned in quota.test.ts — is list-unverified.
    driver.listWithAnomalies = mock(() => Promise.reject(new Error("list timeout")));
    const createSpy = mock(() => Promise.resolve({ name: "test", status: "running" } as ProviderVm));
    driver.create = createSpy;
    const mintSpy = mock((_name: string, limit: number) =>
      Promise.resolve({ key: "sk-test", hash: "abc", limitUsd: limit, usageUsd: 0 }),
    );
    keyApi.createKey = mintSpy;

    try {
      await dispatch(brief, deps({ requestId }));
      failUnreachable();
    } catch (e) {
      if (e instanceof UnexpectedSuccessError) throw e;
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
    // Same evidence trail as the `allowed:false` sibling.
    const refused = expectSingleRefusalLine("no-headroom");
    // The classification is the point of this override: the substrate failed to
    // answer, so the refusal is TRANSIENT — retryable — where every other
    // exit-5 reason stays do-not-retry `logic` (the sibling pins that half).
    expect(refused.exitStatus).toBe("transient");
    // Joinable, same as the sibling: a transient refusal exists to be retried,
    // and a retry correlates through this id.
    expect(refused.requestId).toBe(requestId);
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
      // The two `sh -c` steps are told APART. Both key delivery and the manifest
      // fill ride `sh -c`, and collapsing them into one `sh-exec` label made the
      // ordering check blind to the thing it names: `indexOf` finds the FIRST
      // one, so a fill moved to AFTER the gate still satisfied
      // `… < sh-exec < gate`. `deliverScript` opens with `umask 077`
      // (credentials.ts) and `fillRun` passes the target path as its last argv
      // element (driver.ts) — neither is a shape this test invents.
      if (argv[0] === "sh") {
        const script = argv[2] ?? "";
        if (script.startsWith("umask 077")) callOrder.push("deliver");
        else if (argv.at(-1) === IN_BOX_MANIFEST) callOrder.push("fill:pipeline.yaml");
        else if (argv.at(-1) === IN_BOX_RUN_CONTEXT) callOrder.push("fill:run-context.json");
        else callOrder.push(`sh-exec:${script.slice(0, 24)}`);
      }
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

    // The WHOLE INV-1 chain, in full and exactly: record → box → key mint → key
    // delivery → manifest fill → gate. An equality rather than a subsequence,
    // now that the two `sh -c` steps are distinguishable — a subsequence over
    // labels that repeat is what let fill-after-gate through, and there is no
    // step here whose position is genuinely free.
    //
    // Truncated AT the gate: `fakeGate` runs five `sh -c` probes of its own, and
    // those belong to the gate's tests, not to this one.
    expect(callOrder).toContain("gate");
    expect(callOrder.slice(0, callOrder.indexOf("gate") + 1)).toEqual([
      "store.create",
      "driver.create",
      "mint",
      "deliver",
      "fill:pipeline.yaml",
      "fill:run-context.json",
      "gate",
    ]);
  });

  test("AC2b: the manifest pair is delivered INSIDE the checkout under .qds/, and nothing is left beside it", async () => {
    // The run-root unification is a claim about two path strings, so this
    // asserts the strings themselves rather than inferring them from a `cat`
    // that a second, stale copy of the file would also satisfy.
    const filled: string[] = [];
    const originalExec = driver.exec.bind(driver);
    // No restore needed (B2-8 checked): `beforeEach` rebuilds `driver` fresh
    // for every test in this describe, so this wrapper's lifetime is this test.
    driver.exec = async (vm: string, argv: string[], stdin?: string) => {
      // `fillRun` passes the target path as its last argv element and carries
      // the content on stdin; `deliverScript` opens with `umask 077` and is the
      // only other stdin-bearing `sh -c` before the gate (see the INV-1
      // ordering test above, which names the same two shapes).
      if (argv[0] === "sh" && stdin !== undefined && !(argv[2] ?? "").startsWith("umask 077")) {
        filled.push(argv.at(-1) as string);
      }
      return originalExec(vm, argv, stdin);
    };

    const result = await dispatch(validBrief(), deps());

    expect(filled).toEqual([IN_BOX_MANIFEST, IN_BOX_RUN_CONTEXT]);
    // The literal contract, pinned ONCE and here: the in-box engine is invoked
    // with `--run-root $HOME/src` and reads `.qds/pipeline.yaml` beneath it,
    // and harvest collects from the same two paths. Those are three leaves
    // agreeing on one string, so the string is written down where a change to
    // it fails rather than silently desyncs them.
    expect(IN_BOX_MANIFEST).toBe("src/.qds/pipeline.yaml");
    expect(IN_BOX_RUN_CONTEXT).toBe("src/.qds/run-context.json");

    // …and the witness carries `budgetMs`. `qds-engine run <runId>` derives
    // every other flag from in-box convention; this is `--budget-ms`'s ONLY
    // source, and the engine refuses to start without it rather than defaulting
    // it from the manifest it is about to check. Dropping the field is a live
    // box that will not run, so it fails here instead.
    //
    // A RANGE, not `toBe(600_000)`: the field carries the ADMISSION ceiling —
    // what was left of the dispatch clock when `loadManifest` compared the
    // manifest's `runBudgetMs` against it. Round 3 (B2-3): under this test's
    // REAL clock the lower bound used to be `DEFAULT_TIMEOUT_MS - 60_000`, i.e.
    // an assertion on how many clock reads dispatch happened to make before
    // admission — a stalled runner (>60 s of scheduler pause between start and
    // admission) failed a test whose subject was unchanged. The REAL clock's
    // job here is only "positive and at most the ceiling"; the DERIVATION
    // (nonzero elapsed, bounded away from both ends) is asserted by the
    // injected-clock test below, where elapsed is deterministic.
    const witness = JSON.parse(
      (await originalExec(result.vmName, ["cat", IN_BOX_RUN_CONTEXT])).stdout,
    ) as { budgetMs?: unknown };
    expect(witness.budgetMs).toBeLessThanOrEqual(DEFAULT_TIMEOUT_MS);
    expect(witness.budgetMs as number).toBeGreaterThan(0);

    // …and the old placement is GONE, not duplicated. A dispatch that wrote
    // both would satisfy every assertion above while still dirtying the ssh
    // HOME and leaving two manifests for the engine to disagree about.
    //
    // Swept over the WHOLE box rather than `ls`-ing the two old names in the
    // ssh HOME: the failure this guards is "the pair exists at more than one
    // path", and a stray copy at `$HOME/.qds/pipeline.yaml` or
    // `$HOME/src/pipeline.yaml` is exactly that while satisfying a root-only
    // `ls`. Asserting the full path list is also what makes "and nowhere else"
    // a claim the test can actually make. `.git/` is pruned (round 3, B2-4):
    // a fixture repo whose OWN history carries either filename is not this
    // test's subject, and an unpruned sweep reds on it.
    const sweep = await originalExec(result.vmName, [
      "sh",
      "-c",
      "find . -path ./.git -prune -o \\( -name pipeline.yaml -o -name run-context.json \\) -print | sort",
    ]);
    expect(sweep.stdout.trim().split("\n")).toEqual([
      `./${IN_BOX_MANIFEST}`,
      `./${IN_BOX_RUN_CONTEXT}`,
    ]);
  });

  test("AC2b: the witness's budgetMs is the ADMISSION ceiling derived from deps.timeoutMs, not dispatch's whole transport deadline", async () => {
    // `timeoutMs` is the ceiling for the WHOLE of THIS call — provision, clone,
    // fill and gate — sampled through `ctx.remaining()`. The engine's clock
    // starts at a SEPARATE `fleet run` invocation, so writing the raw transport
    // deadline into the witness authorised the box for more time than the
    // manifest was admitted under. What is written is the figure `loadManifest`
    // actually compared `runBudgetMs` against.
    //
    // Two assertions, because each kills a different wrong implementation:
    // `< TIMEOUT_MS` fails a dispatch that reuses `deps.timeoutMs` verbatim (the
    // shape before this change), and the lower bound fails one that invents a
    // constant or reuses the 600_000 default.
    const TIMEOUT_MS = 321_000;
    // Advances 1 ms per read, so elapsed-at-admission is nonzero and BOUNDED —
    // a frozen clock makes `remaining()` exactly `timeoutMs` and the two
    // implementations indistinguishable. Not `stepClock()`: this needs the
    // advance to happen DURING dispatch, before step 3, and there is no dep the
    // test drives between the wall-clock baseline and the manifest load.
    let t = 1_700_000_000_000;
    const clock = () => {
      t += 1;
      return t;
    };

    const result = await dispatch(validBrief(), deps({ timeoutMs: TIMEOUT_MS, clock }));

    const witness = JSON.parse(
      (await driver.exec(result.vmName, ["cat", IN_BOX_RUN_CONTEXT])).stdout,
    ) as { budgetMs?: unknown };
    expect(witness.budgetMs).toBeLessThan(TIMEOUT_MS);
    expect(witness.budgetMs).toBeGreaterThan(TIMEOUT_MS - 1_000);
  });

  test("DF5.3: the witness carries the issue correlation — the in-box engine's ONLY source for what authorized the run", async () => {
    // The dispatched shape takes `--run-id` and so never walks DF1.8's
    // correlation ladder (`--repo-slug`/`--issue` RESOLVE an identity, and
    // RUN_ID_CONFLICT refuses them beside a `--run-id`). Without this pair on
    // the witness the in-box engine falls through to its bare `startSession`
    // and the harvested trace's `sessions` row carries NULL repo_slug/issue_id
    // — which is what a live DF5.3 round measured, leaving the audit walker's
    // record-vs-trace divergence check with nothing to corroborate the
    // admission fact this dispatch wrote into the run record.
    //
    // The pair is asserted WHOLE, and against the run record's own copy: half
    // a correlation REFUSES the run in-box (issue identity is the pair,
    // INV-RUN-3), and a pair that disagrees with the record is precisely the
    // divergence the check exists to catch, so a witness agreeing with itself
    // proves nothing.
    const brief = {
      ...validBrief(),
      repoSlug: "Owner/Repo",
      issueId: 7,
      issueUrl: "https://github.com/owner/repo/issues/7",
    };
    const result = await dispatch(brief, deps());

    const witness = JSON.parse(
      (await driver.exec(result.vmName, ["cat", IN_BOX_RUN_CONTEXT])).stdout,
    ) as { repoSlug?: unknown; issueId?: unknown; issueUrl?: unknown };
    // CANONICAL (case-folded), not the brief's spelling: `resolveRunCorrelation`
    // folds the slug so the ledger key, the run record and this witness name
    // ONE repository, and the engine re-validates what it reads here through
    // that same function — a raw `Owner/Repo` on the witness would correlate
    // the trace to a second budget identity.
    expect(witness.repoSlug).toBe("owner/repo");
    // `String`, matching the ledger key and the run record. The engine
    // normalises this spelling back to an integer; a test that accepted either
    // shape would let the two carriers drift apart silently.
    expect(witness.issueId).toBe("7");
    expect(witness.issueUrl).toBe("https://github.com/owner/repo/issues/7");

    const record = store.get(result.runId);
    expect(witness.repoSlug).toBe(record.extensions?.budget?.repoSlug);
    expect(witness.issueId).toBe(record.extensions?.budget?.issueId);
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
    // …and that record is OPEN (INV-5's other half): teardown is advice, never
    // something dispatch did on the operator's behalf.
    expect(store.get(runId as string).closedAt).toBeUndefined();
    expect(e.payload?.teardownCommand).toBe(`bun scripts/fleet.ts teardown ${runId as string}`);
    // `refuse` also files the refusal log line the dispatch-log evidence needs.
    expect(refusalLines()).toHaveLength(1);
    expect(ledger.closeCalls).toBe(1);
  });

  // ─── Cap hand-off (AC9) ─────────────────────────────────────────────────────────

  test("AC9: mintRunKey receives cap === admittedCeilingMicroUsd, under THIS run's key name", async () => {
    const brief = validBrief();
    const admittedCeiling = 25_000_000; // half of the DF2.3 default
    const originalMint = keyApi.createKey.bind(keyApi);
    const mintSpy = mock((name: string, limit: number) => originalMint(name, limit));
    keyApi.createKey = mintSpy;

    const result = await dispatch(brief, deps({ ledgerFactory: () => goodLedger(admittedCeiling) }));

    expect(mintSpy).toHaveBeenCalledTimes(1);
    const [nameArg, limitArg] = mintSpy.mock.calls[0] as [string, number];
    expect(limitArg).toBe(admittedCeiling / 1_000_000); // µ$ → USD at the HTTP boundary
    // The key NAME, which only the limit argument was ever read for. It is the
    // sole handle teardown has on the provider side: `revokeRunKey` refuses to
    // delete anything whose name lacks the `sbx-` prefix, and it finds the key
    // by the run id in that name. Minted under a stale or invented run's name,
    // teardown revokes ANOTHER run's live credential and leaves this one
    // spendable — and every other assertion in this file still passes.
    expect(nameArg).toBe(`${SBX_KEY_PREFIX}${result.runId}`);
  });

  test("AC9a: manifest stamped with limitMicroUsd = admittedCeilingMicroUsd", async () => {
    const brief = validBrief();
    const admittedCeiling = 30_000_000;

    const result = await dispatch(brief, deps({ ledgerFactory: () => goodLedger(admittedCeiling) }));

    const record = store.get(result.runId);
    const filled = await driver.exec(record.vmName as string, ["cat", IN_BOX_MANIFEST]);
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
    const ctxFile = await driver.exec(record.vmName as string, ["cat", IN_BOX_RUN_CONTEXT]);
    const ctx = JSON.parse(ctxFile.stdout) as { effectiveCeilingMicros?: number };
    expect(ctx.effectiveCeilingMicros).toBe(admittedCeiling);

    // The manifest is the cap's only in-box source (AC9a) — the CEILING, not
    // the issue cap, is what the box may spend.
    const filled = await driver.exec(record.vmName as string, ["cat", IN_BOX_MANIFEST]);
    expect((JSON.parse(filled.stdout) as { limitMicroUsd?: number }).limitMicroUsd).toBe(admittedCeiling);
  });

  test("AC9/F004: a provider that mints ABOVE the request is REFUSED at the mint — dispatch never stamps a box", async () => {
    // Was: "…is CLAMPED to the request". The clamp only stopped the box from
    // being TOLD about the excess — the key itself was live at the provider's
    // larger figure, so the box could spend it regardless of what the manifest
    // said. F004 moves the enforcement upstream: `mintRunKey` now refuses an
    // over-granted echo (`mint-ceiling-mismatch`) instead of persisting it, so
    // dispatch fails closed with the key recorded and revocable. The downward
    // clamp in dispatch.ts stays as defence in depth for a record that already
    // holds a larger limit; nothing reaches it from the provider echo any more.
    const admittedCeiling = 25_000_000; // 25 USD at the HTTP boundary
    const overMintedUsd = 50; // double, and a plausible plan floor
    const requestedUsd: number[] = [];
    keyApi.createKey = async (_name: string, limitUsd: number) => {
      requestedUsd.push(limitUsd);
      return { key: "sk-or-v1-overminted", hash: "cafef00d", limitUsd: overMintedUsd, usageUsd: 0 };
    };

    try {
      await dispatch(validBrief(), deps({ ledgerFactory: () => goodLedger(admittedCeiling) }));
      failUnreachable();
    } catch (e) {
      if (e instanceof UnexpectedSuccessError) throw e;
      const err = e as FleetError;
      expect(err.code).toBe("key-delivery-failed");
      expect(err.payload?.providerCode).toBe("mint-ceiling-mismatch");
      // The REQUEST was the admitted ceiling — the refusal is about the reply.
      expect(requestedUsd).toEqual([admittedCeiling / 1_000_000]);
      // INV-5: the record is OPEN and carries the keyHash — a live over-granted
      // key must stay reachable for revoke — but NOT the over-granted ceiling.
      const runId = err.payload?.runId as string;
      const record = store.get(runId);
      expect(record.closedAt).toBeUndefined();
      expect(record.keyHash).toBe("cafef00d");
      expect(record.limitMicroUsd).toBeUndefined();
    }
  });

  test("AC9: a RECORD holding a limit LARGER than the request is clamped down (defence in depth)", async () => {
    // F004 refuses an over-granted echo at the mint, so the provider can no
    // longer put a too-large figure on the record. The downward clamp at
    // dispatch.ts:2434-2437 still guards the OTHER way in: a record written by
    // an older binary (before that refusal existed) that already holds one.
    // Nothing else pins `Math.min` any more — deleting it, or writing `max`,
    // must fail here.
    const admittedCeiling = 25_000_000;
    const staleLimit = 90_000_000; // what an older binary persisted
    const overStore: RunRecordStore = Object.assign(Object.create(store) as RunRecordStore, {
      get: (id: string) => ({ ...store.get(id), limitMicroUsd: staleLimit }),
    });

    const result = await dispatch(
      validBrief(),
      deps({ store: overStore, ledgerFactory: () => goodLedger(admittedCeiling) }),
    );

    // Both carriers name the ADMITTED figure, never the record's larger one.
    const delivered = await driver.exec(result.vmName, ["sh", "-c", `cat ${IN_BOX_MANIFEST}`]);
    expect((JSON.parse(delivered.stdout) as { limitMicroUsd: number }).limitMicroUsd).toBe(admittedCeiling);
    const ctx = await driver.exec(result.vmName, ["sh", "-c", `cat ${IN_BOX_RUN_CONTEXT}`]);
    expect((JSON.parse(ctx.stdout) as { effectiveCeilingMicros: number }).effectiveCeilingMicros).toBe(
      admittedCeiling,
    );
    expect(delivered.stdout).not.toContain(String(staleLimit));
    expect(ctx.stdout).not.toContain(String(staleLimit));

    // …and it is a MONEY event, not a diagnostic: error-classified, naming both.
    const overLines = entries.filter(
      (e) => (e.error as { code?: string } | undefined)?.code === "mint-cap-over-request",
    );
    expect(overLines).toHaveLength(1);
    const line = overLines[0] as LogEntry;
    expect(line.status).toBe("error");
    expect(String((line.error as { message?: unknown }).message)).toContain(String(staleLimit));
    expect(String((line.error as { message?: unknown }).message)).toContain(String(admittedCeiling));
  });

  test("AC9: a provider that mints BELOW the request is honoured, and logged as informational", async () => {
    // The control for the clamp above, and the direction that is NOT an
    // incident: the box gets less than it asked for and dies against a limit it
    // was told about, which is the manifest stamp doing its job. With only the
    // over-mint case, a `min` replaced by "always the request" still passes.
    const admittedCeiling = 25_000_000;
    const mintedUsd = 10;
    keyApi.createKey = async () => ({
      key: "sk-or-v1-underminted",
      hash: "beefcafe",
      limitUsd: mintedUsd,
      usageUsd: 0,
    });

    const result = await dispatch(validBrief(), deps({ ledgerFactory: () => goodLedger(admittedCeiling) }));

    const delivered = await driver.exec(result.vmName, ["sh", "-c", `cat ${IN_BOX_MANIFEST}`]);
    expect((JSON.parse(delivered.stdout) as { limitMicroUsd: number }).limitMicroUsd).toBe(mintedUsd * 1_000_000);
    // The run context too, like the over-mint sibling reads it: the clamp is
    // min(requested, persisted), so here the CLAMPED figure — the provider's
    // own smaller answer — must be what `effectiveCeilingMicros` carries. A
    // dispatcher that propagated the REQUEST instead satisfies every manifest
    // check above and hands the box a ceiling nothing will actually enforce.
    const ctx = await driver.exec(result.vmName, ["sh", "-c", `cat ${IN_BOX_RUN_CONTEXT}`]);
    expect((JSON.parse(ctx.stdout) as { effectiveCeilingMicros: number }).effectiveCeilingMicros).toBe(
      mintedUsd * 1_000_000,
    );
    const differs = entries.filter(
      (e) => (e.error as { code?: string } | undefined)?.code === "mint-cap-differs",
    );
    expect(differs).toHaveLength(1);
    expect((differs[0] as LogEntry).status).toBe("ok");
    expect((differs[0] as LogEntry).exitStatus).toBe("success");
  });

  test("AC9: a provider that mints EXACTLY the request is SILENT — no mint-cap line at all", async () => {
    // The third arm of the family, and the one whose failure mode is pure
    // noise: a `mintedCeilingMicros !== effectiveCeilingMicros` comparison
    // written as `>=`/`<=` — or the guard dropped to `if (true)` "for safety" —
    // logs an incident line on every healthy dispatch, paging nobody for real
    // over-mints because the channel cried wolf forever. Equality must produce
    // NO line in either direction.
    const admittedCeiling = 25_000_000;
    const requestedUsd: number[] = [];
    keyApi.createKey = async (_name: string, limitUsd: number) => {
      requestedUsd.push(limitUsd);
      // The provider echoes the request back EXACTLY.
      return { key: "sk-exactmint", hash: "f00dface", limitUsd, usageUsd: 0 };
    };

    const result = await dispatch(validBrief(), deps({ ledgerFactory: () => goodLedger(admittedCeiling) }));

    expect(result.state).toBe("ready");
    expect(requestedUsd).toEqual([admittedCeiling / 1_000_000]);
    // Both carriers carry the agreed figure…
    const delivered = await driver.exec(result.vmName, ["sh", "-c", `cat ${IN_BOX_MANIFEST}`]);
    expect((JSON.parse(delivered.stdout) as { limitMicroUsd: number }).limitMicroUsd).toBe(admittedCeiling);
    const ctx = await driver.exec(result.vmName, ["sh", "-c", `cat ${IN_BOX_RUN_CONTEXT}`]);
    expect((JSON.parse(ctx.stdout) as { effectiveCeilingMicros: number }).effectiveCeilingMicros).toBe(
      admittedCeiling,
    );
    // …and NEITHER diagnostic code fired — not even the informational one.
    // `phase: "minted"` is used by the mint-cap block and nothing else, so an
    // empty filter is the whole silence claim.
    expect(entries.filter((e) => e.phase === "minted")).toEqual([]);
    expect(refusalLines()).toHaveLength(0);
  });

  // ─── Gate failure (AC3, INV-5) ─────────────────────────────────────────────────────

  test("AC3: gate ready=false → FleetError exit 3, record OPEN, box alive, gate outcome recorded", async () => {
    const brief = validBrief();
    const ledger = goodLedger();
    const before = Date.now();

    try {
      await dispatch(
        brief,
        deps({
          ledgerFactory: () => ledger,
          setupGate: async () => {
            // ≥2 real ms of wall clock between `createdAt` and the failure stamp:
            // the strict `>` below has to distinguish a FRESH stamp from a copied
            // one even on a machine where this whole fake provision fits inside a
            // single clock tick.
            await Bun.sleep(2);
            return {
              ready: false,
              failedItem: "A" as const,
              assertionCode: 1 as const,
              assertions: [{ item: "A" as const, ok: false, note: "HEAD mismatch" }],
              debugCommands: ["ssh box.exe.xyz cat /tmp/provision"],
              teardownCommand: "bun scripts/fleet.ts teardown the-run",
              vm: "test-box",
            };
          },
        }),
      );
      failUnreachable();
    } catch (e) {
      if (e instanceof UnexpectedSuccessError) throw e;
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
      // WHEN the gate failed, not merely "a parseable string": `Date.parse("2001")`
      // is a number, so a frozen constant, a zero epoch or a timestamp copied
      // from `createdAt` all passed — and `failedAt` is what an operator sorts a
      // wall of open runs by when deciding which box to tear down first.
      const failedAt = String(record.extensions?.gate?.failedAt);
      expect(failedAt).toMatch(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/);
      expect(Date.parse(failedAt)).toBeGreaterThanOrEqual(before);
      expect(Date.parse(failedAt)).toBeLessThanOrEqual(Date.now());
      // …and it is not just `createdAt` under another name. STRICTLY greater —
      // an equality-satisfying `>=` also passed with `failedAt` copied verbatim
      // from `createdAt`, which is exactly the frozen-stamp regression this pair
      // pins. The gate stub's sleep guarantees the gap exists here.
      expect(Date.parse(failedAt)).toBeGreaterThan(Date.parse(record.createdAt));

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

  for (const [label, returned] of [
    ["undefined", undefined],
    ["null", null],
  ] as const) {
    test(`AC3: a gate returning ${label} → exit 3 setup-gate-invalid, box ALIVE (not exit 1)`, async () => {
      // `deps.setupGate` is an injection seam, and the "every read of the gate's
      // own result is DEFENDED" claim covered `assertions`/`debugCommands`/
      // `failedItem` while `gate.ready` itself was an unguarded property read: a
      // gate returning nothing threw a TypeError that escaped to the OUTER catch
      // and came back as exit-1 `dispatch-failed`. That names the wrong cause —
      // exit 1 is a substrate fault an operator goes hunting for, exit 3 is the
      // gate, and the classification is the whole difference between the two.
      const ledger = goodLedger();
      try {
        await dispatch(
          validBrief(),
          deps({
            ledgerFactory: () => ledger,
            setupGate: (async () => returned) as unknown as DispatchDeps["setupGate"],
          }),
        );
        failUnreachable();
      } catch (e) {
        if (e instanceof UnexpectedSuccessError) throw e;
        expect(e).toBeInstanceOf(FleetError);
        const err = e as FleetError;
        expect(err.exitCode).toBe(3);
        expect(err.code).toBe("setup-gate-invalid");
        // WHAT it returned, so the operator fixing the gate knows which of the
        // two shapes they produced. Asserted as a PROPERTY of the payload —
        // `err.payload?.returned` conflates "the field is absent" with "the
        // field holds the stringified verdict", and only the former is a
        // regression. The value is the STRING form (`typeof gateResult`): a
        // literal `undefined` would vanish from the JSON-transported payload.
        expect(err.payload).toHaveProperty("returned", label);
        expect(err.message).toContain(label);

        // INV-5, the same posture as an ordinary gate failure: the box outlives
        // the refusal and the record stays open, because the box is the evidence.
        const record = store.get(err.payload?.runId as string);
        expect(record.closedAt).toBeUndefined();
        expect(record.keyHash).toMatch(/^[0-9a-f]{64}$/);
        const boxes = await driver.list();
        expect(boxes.some((b) => b.name === record.vmName)).toBeTrue();
      }
      expectSingleRefusalLine("setup-gate-invalid");
      expect(ledger.closeCalls).toBe(1);
    });
  }

  test("AC3: a gate assertion note whose toString THROWS still refuses at exit 3", async () => {
    // `note` is DECLARED `string` (setup-gate.ts) and `deps.setupGate` is an
    // injection seam, so the declaration is a promise the seam does not keep —
    // and on an exedev box the note is whatever the BOX printed. A bare
    // `String(note)` at the refusal's call site put an unguarded coercion inside
    // the exit-3 path: a throwing `toString` escaped to the outer catch and
    // downgraded the whole thing to exit-1 `dispatch-failed`, losing the
    // classification, the assertion evidence and the gate's own teardown
    // command. `escapeText` guards both coercions in one place.
    const hostile = {
      toString() {
        throw new Error("hostile toString");
      },
    } as unknown as string;

    try {
      await dispatch(
        validBrief(),
        deps({
          setupGate: async (_drv, vm) => ({
            ready: false,
            failedItem: "A" as const,
            assertionCode: 1 as const,
            assertions: [{ item: "A" as const, ok: false, note: hostile }],
            debugCommands: [],
            teardownCommand: "bun scripts/fleet.ts teardown the-run",
            vm,
          }),
        }),
      );
      failUnreachable();
    } catch (e) {
      if (e instanceof UnexpectedSuccessError) throw e;
      expect(e).toBeInstanceOf(FleetError);
      const err = e as FleetError;
      expect(err.exitCode).toBe(3);
      expect(err.code).toBe("setup-gate-failed");
      expect(err.code).not.toBe("dispatch-failed");
      // The note is REPORTED as unprintable rather than dropped: the item and
      // the assertion list still reach the operator, which is the evidence the
      // exit-3 envelope exists to carry.
      expect(err.message).toContain("«unprintable»");
      expect(err.payload?.failedItem).toBe("A");
      expect(err.payload?.assertions).toEqual(["A:«unprintable»"]);
    }
  });

  // ─── items A and C through the REAL probe path ─────────────────────────────
  // The hand-built `ready:false` fixtures above pin dispatch's REFUSAL side.
  // These two run the default gate — no `deps.setupGate`, so `fakeGate` itself
  // probes the box — and fail the box's STATE so a specific ITEM fires, which
  // is coverage the injected-result shape cannot give: a probe order change, or
  // an item that stopped reading what it claims to read, passes every fixture
  // that never runs the probes.

  test("AC3 via the real probe path: an unreachable box fails at item A", async () => {
    // Item A is `exec ["true"]`; its nonzero exit is the box refusing to run
    // anything. Probing stops at the first failure, so B..E must not appear.
    const realExec = driver.exec.bind(driver);
    driver.exec = async (vm: string, argv: string[], stdin?: string) =>
      argv[0] === "true" ? { exitCode: 1, stdout: "", stderr: "" } : realExec(vm, argv, stdin);

    try {
      await dispatch(validBrief(), deps());
      failUnreachable();
    } catch (e) {
      if (e instanceof UnexpectedSuccessError) throw e;
      const err = e as FleetError;
      expect(err.exitCode).toBe(3);
      expect(err.code).toBe("setup-gate-failed");
      expect(err.payload?.failedItem).toBe("A");
      expect(err.payload?.assertionCode).toBe(1);
      // The executed SET stops at A — later items are absent, not merely passing.
      expect(err.payload?.assertions).toEqual(["A:box reachable (exec true) — exit 1"]);
    }
    expectSingleRefusalLine("setup-gate-failed");
  });

  test("AC3 via the real probe path: a mis-moded delivered key fails item C", async () => {
    // The delivery contract's own failure, produced on the REAL file: delivery
    // lands `.env` at mode 600 inside the fake box (a host directory), and the
    // test demotes it to 0644 before the gate reads it — so item C's stat probe
    // reports the wrong mode for exactly the reason production would see one.
    const realExec = driver.exec.bind(driver);
    driver.exec = async (vm: string, argv: string[], stdin?: string) => {
      const r = await realExec(vm, argv, stdin);
      // The key-delivery script opens with `umask 077` (credentials.ts).
      if ((argv[2] ?? "").startsWith("umask 077")) {
        chmodSync(join(driver.root, vm, ".env"), 0o644);
      }
      return r;
    };

    try {
      await dispatch(validBrief(), deps());
      failUnreachable();
    } catch (e) {
      if (e instanceof UnexpectedSuccessError) throw e;
      const err = e as FleetError;
      expect(err.exitCode).toBe(3);
      expect(err.code).toBe("setup-gate-failed");
      // A and B passed (the box ran; the manifest landed stamped); C is the
      // failing item of the full EXECUTED set the payload carries.
      expect(err.payload?.failedItem).toBe("C");
      expect(err.payload?.assertionCode).toBe(2);
      expect(err.payload?.assertions).toEqual([
        "A:ok",
        "B:ok",
        "C:delivered key env file is mode 600 (DF2.3 delivery contract) — mode 644",
      ]);
      // INV-5 posture, same as every other gate failure.
      const record = store.get(err.payload?.runId as string);
      expect(record.closedAt).toBeUndefined();
      const boxes = await driver.list();
      expect(boxes.some((b) => b.name === record.vmName)).toBeTrue();
    }
    expectSingleRefusalLine("setup-gate-failed");
  });

  test("AC3 via the real probe path: a NEVER-delivered key fails item C with the absent verdict", async () => {
    // The other delivery-contract failure the type probe names: fill never
    // landed `.env` at all. The verdict is ABSENCE — no mode digits, because a
    // mode for a missing file is exactly the misleading detail this probe was
    // rewritten to stop reporting.
    const realExec = driver.exec.bind(driver);
    driver.exec = async (vm: string, argv: string[], stdin?: string) => {
      const r = await realExec(vm, argv, stdin);
      if ((argv[2] ?? "").startsWith("umask 077")) {
        rmSync(join(driver.root, vm, ".env"));
      }
      return r;
    };

    try {
      await dispatch(validBrief(), deps());
      failUnreachable();
    } catch (e) {
      if (e instanceof UnexpectedSuccessError) throw e;
      const err = e as FleetError;
      expect(err.exitCode).toBe(3);
      expect(err.code).toBe("setup-gate-failed");
      // A and B passed; C is where the executed set stops.
      expect(err.payload?.failedItem).toBe("C");
      expect(err.payload?.assertionCode).toBe(2);
      expect(err.payload?.assertions).toEqual([
        "A:ok",
        "B:ok",
        "C:delivered key env file is mode 600 (DF2.3 delivery contract) — mode absent (.env was not delivered)",
      ]);
      const record = store.get(err.payload?.runId as string);
      expect(record.closedAt).toBeUndefined();
    }
    expectSingleRefusalLine("setup-gate-failed");
  });

  test("AC3 via the real probe path: a DIRECTORY named .env fails item C as not-a-file, never as a mode", async () => {
    // Wrong TYPE is the delivery contract failing by another road: something
    // else wrote a directory in `.env`'s place. The verdict must send the
    // operator to RE-DELIVER, and it must not carry mode digits — "mode 755"
    // for a directory is what sent operators to chmod a thing chmod cannot fix.
    const realExec = driver.exec.bind(driver);
    driver.exec = async (vm: string, argv: string[], stdin?: string) => {
      const r = await realExec(vm, argv, stdin);
      if ((argv[2] ?? "").startsWith("umask 077")) {
        const envPath = join(driver.root, vm, ".env");
        rmSync(envPath);
        mkdirSync(envPath);
      }
      return r;
    };

    try {
      await dispatch(validBrief(), deps());
      failUnreachable();
    } catch (e) {
      if (e instanceof UnexpectedSuccessError) throw e;
      const err = e as FleetError;
      expect(err.exitCode).toBe(3);
      expect(err.code).toBe("setup-gate-failed");
      expect(err.payload?.failedItem).toBe("C");
      expect(err.payload?.assertionCode).toBe(2);
      expect(err.payload?.assertions).toEqual([
        "A:ok",
        "B:ok",
        "C:delivered key env file is mode 600 (DF2.3 delivery contract) — .env exists but is not a regular file — re-run the key delivery step; do not chmod",
      ]);
      const record = store.get(err.payload?.runId as string);
      expect(record.closedAt).toBeUndefined();
    }
    expectSingleRefusalLine("setup-gate-failed");
  });

  test.each([
    ["an object", {} as unknown],
    ["a string", "x" as unknown],
  ])(
    "a gate whose assertions value is %s fails closed at exit 3 instead of throwing",
    async (_label, bogusAssertions) => {
      // DF3's seam: every collection read off the gate result (.find/.map here,
      // .some inside isSubstrateFailure) runs over the SANITIZED array, so a
      // truthy non-array takes the empty-array path — the ordinary failure
      // refusal with the explicit absence note — never a TypeError that
      // downgrades exit 3 to exit-1 dispatch-failed.
      try {
        await dispatch(
          validBrief(),
          deps({
            ledgerFactory: () => goodLedger(),
            setupGate: async () => ({
              ready: false,
              failedItem: "A" as const,
              assertionCode: 1 as const,
              assertions: bogusAssertions as never,
              debugCommands: ["bun scripts/fleet.ts status the-run"],
              teardownCommand: "bun scripts/fleet.ts teardown the-run",
              vm: "test-box",
            }),
          }),
        );
        failUnreachable();
      } catch (e) {
        if (e instanceof UnexpectedSuccessError) throw e;
        const err = e as FleetError;
        expect(err.exitCode).toBe(3);
        expect(err.code).toBe("setup-gate-failed");
        expect(err.message).toContain("the gate reported no failing assertion");
        expect(err.payload?.assertions).toEqual([]);
      }
      expectSingleRefusalLine("setup-gate-failed");
    },
  );

  test("INV-6: gate COMMAND strings and assertion ITEM LABELS are escaped like notes are", async () => {
    // The note got `escapeText` first; the debug commands, the teardown command
    // and the item labels rode through raw on the theory that only the
    // free-text fields were box-chosen. They all come off the same gate result
    // object, so a forged command (`"\nFLEET dispatch ok runId=fake"`) or an
    // ANSI-bearing label reached stderr, the CLI-printed payload and the
    // structured line unescaped.
    try {
      await dispatch(
        validBrief(),
        deps({
          // The closed `AssertionItem` union cannot TYPE a hostile label, but
          // this is an injection seam — the whole reason every read of the
          // gate result is guarded rather than trusted. Cast, same as the
          // `setup-gate-invalid` fixtures.
          setupGate: (async (_drv: ProviderDriver, vm: string) => ({
            ready: false,
            failedItem: "B" as const,
            assertionCode: 2 as const,
            assertions: [{ item: "B\u001b[2J", ok: false, note: "env file mode" }],
            debugCommands: ["bun status \u001b[2J"],
            teardownCommand: "teardown\nFLEET dispatch ok runId=fake",
            vm,
          })) as unknown as DispatchDeps["setupGate"],
        }),
      );
      failUnreachable();
    } catch (e) {
      if (e instanceof UnexpectedSuccessError) throw e;
      const err = e as FleetError;
      expect(err.exitCode).toBe(3);
      expect(err.code).toBe("setup-gate-failed");
      // Escaped means ESCAPED, everywhere: no raw control character survives in
      // any of the three sinks this refusal feeds (stderr via the dispatch log,
      // the CLI-printed payload, the structured line), and each string shows up
      // in its JSON-escaped form instead.
      expect(err.remediation).toContain("bun status \\u001b[2J");
      expect(err.remediation).not.toContain("\u001b");
      expect(err.remediation).toContain('teardown\\nFLEET dispatch ok runId=fake');
      expect(err.remediation).not.toContain("runId=fake\n");
      // Item label escaped, failing note rendered as before.
      expect(err.payload?.assertions).toEqual(["B\\u001b[2J:env file mode"]);
      expect(JSON.stringify(err.payload)).not.toContain("\u001b");
      // And the structured line is clean too.
      const refusals = refusalLines();
      expect(refusals).toHaveLength(1);
      expect(JSON.stringify(refusals[0])).not.toContain("\u001b");
    }
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
      failUnreachable();
    } catch (e) {
      if (e instanceof UnexpectedSuccessError) throw e;
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

    // The RECORD, not just the ack. `fleet status` and every reaper read the
    // record, and the ack is a one-shot line on someone's terminal — so a
    // dispatch that acks a URL for a box it then made public, and never
    // persists it, leaves a live PUBLIC box whose address exists nowhere an
    // operator can find it. Asserted on the success path because the failure
    // path (`expose-no-url`) asserts the opposite and neither implies the other.
    const record = store.get(result.runId);
    expect(record.ports).toEqual([8080]);
    expect(record.httpsUrl).toBe(result.httpsUrl);
    // Same box in both, too — `vmName` was only ever cross-checked on the
    // failure path, so an ack naming a box the record does not know sends
    // teardown at the wrong VM.
    expect(record.vmName).toBe(result.vmName);
    expect(record.closedAt).toBeUndefined();
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
    // on the record BEFORE calling it. On an ORDINARY provider failure (this
    // one) nothing is in flight and the claim is RETRACTED to `[]` — a record
    // advertising a port nothing is listening on is a port-keyed reaper's and
    // `fleet status`'s problem, and the refusal's own "ALIVE but NOT public"
    // wording contradicted it. The claim is kept only on the abandon path (an
    // expose racing the deadline can still land), which the wall-clock tests
    // cover.
    driver.expose = async () => {
      throw Object.assign(new Error("substrate refused the tunnel"), { code: "ECONNRESET" });
    };
    let setPublicCalls = 0;
    driver.setPublic = async () => {
      setPublicCalls += 1;
    };

    try {
      await dispatch(validBrief(), deps({ port: 8080 }));
      failUnreachable();
    } catch (e) {
      if (e instanceof UnexpectedSuccessError) throw e;
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

      // …the record is OPEN, claims NO port (the pre-claim was retracted, since
      // nothing was ever opened) and carries no URL…
      const record = store.get(runId);
      expect(record.closedAt).toBeUndefined();
      expect(record.ports).toEqual([]);
      expect(record.httpsUrl).toBeUndefined();
      expect(err.payload?.vmName).toBe(record.vmName);

      // …and THIS run's box is still there. A count alone passes when the run's
      // own VM is gone and an unrelated box exists.
      const boxes = await driver.list();
      expect(boxes.some((b) => b.name === record.vmName)).toBeTrue();
    }
    // The catch-all owes the same structured line every named refusal files —
    // its whole reason to exist is that an untyped escape would file none.
    expectSingleRefusalLine("dispatch-failed");
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
        //
        // `port` is load-bearing, not incidental. The post-gate re-sample bounds
        // the WORK LEFT after the gate, and with no port there is none — step 10
        // is a no-op, so a dispatch whose gate went green is already complete
        // (box alive, key delivered at the full ceiling, record written) and
        // refusing it would tell the operator to tear down a healthy run and
        // re-spend the issue's cap. Drop the port and this must SUCCEED.
        deps({
          clock,
          port: 8080,
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
      failUnreachable();
    } catch (e) {
      if (e instanceof UnexpectedSuccessError) throw e;
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

  test("600s wall clock: expiry AT exactly the ceiling (elapsed === timeoutMs) refuses", async () => {
    // The exact boundary between the two siblings: `remaining()` floors to 0
    // when elapsed EQUALS the ceiling, and both consumers refuse on `<= 0`. An
    // off-by-one to `<` would ack a run that spent its entire budget and had
    // nothing left — invisible from a strictly-past case and a just-under case
    // alone.
    const { clock, advance } = stepClock();

    const ledger = goodLedger();
    try {
      await dispatch(
        validBrief(),
        deps({
          clock,
          ledgerFactory: () => ledger,
          // `port` keeps post-gate work in scope, same as the expiry sibling.
          port: 8080,
          setupGate: async (drv, vm, o) => {
            const result = await fakeGate(drv, vm, o);
            advance(DEFAULT_TIMEOUT_MS); // EXACTLY — not one ms more
            return result;
          },
        }),
      );
      failUnreachable();
    } catch (e) {
      if (e instanceof UnexpectedSuccessError) throw e;
      const err = e as FleetError;
      expect(err.exitCode).toBe(1);
      expect(err.code).toBe("dispatch-timeout");
      expect(err.payload?.step).toBe("post-gate");
      expect(err.payload?.gateReady).toBeTrue();
      expect(err.payload?.runId).toBeString();
    }
    // T1-8 (round 11): a post-gate timeout is "a refusal like any other" —
    // pinned through the family helper (the old bare call asserted nothing: no
    // code, no status) and the ledger handle is closed like every refusal's.
    const refused = expectSingleRefusalLine("dispatch-timeout");
    expect(refused.status).toBe("error");
    expect(ledger.closeCalls).toBe(1);
  });

  test("the armed wall-clock deadline timer is CLEARED when dispatch settles — success and refusal alike", async () => {
    // `within` arms one REAL `setTimeout` per step and clears it in a finally.
    // A settle path that skips the clear leaves a live 600 s timer that fires
    // MID-SUITE — long after its dispatch is gone — rejecting into whatever
    // subscriber context is then active. Spied at the GLOBAL seam because
    // `within` takes the ambient setTimeout; injecting a clock here observes
    // elapsed time but not the arming at all.
    const realSet = globalThis.setTimeout;
    const realClear = globalThis.clearTimeout;

    /** One audit pass: install the spies, run, restore, then judge. */
    const auditSettledTimers = async (run: () => Promise<unknown>): Promise<void> => {
      const armed = new Map<unknown, number>();
      const cleared = new Set<unknown>();
      const setSpy = spyOn(globalThis, "setTimeout").mockImplementation(
        ((callback: Parameters<typeof realSet>[0], ms?: number) => {
          const t = realSet(callback, ms);
          armed.set(t, ms ?? 0);
          return t;
        }) as unknown as typeof realSet,
      );
      const clearSpy = spyOn(globalThis, "clearTimeout").mockImplementation(
        ((t?: unknown) => {
          cleared.add(t);
          return (realClear as (t?: unknown) => void)(t);
        }) as unknown as typeof realClear,
      );
      try {
        await run();
      } finally {
        setSpy.mockRestore();
        clearSpy.mockRestore();
      }
      // Positive control: the seam actually observed a deadline-sized arming,
      // or everything below passes over an empty sample.
      const deadlineSized = [...armed.entries()].filter(([, ms]) => ms > DEFAULT_TIMEOUT_MS / 2);
      expect(deadlineSized.length).toBeGreaterThan(0);
      // Every deadline-sized timer armed during the dispatch was cleared by
      // the time it settled. (Shorter timers belong to runtime internals this
      // window may also observe, so they are out of scope.)
      for (const [t] of deadlineSized) expect(cleared.has(t)).toBeTrue();
    };

    // SUCCESS: every step arms, runs to completion, and its timer is cleared.
    await auditSettledTimers(() => dispatch(validBrief(), deps()));
    // REFUSAL: the budget gate refuses after headroom already armed a
    // full-ceiling timer — the arm that most tempts a refactor to drop the
    // finally on the way out. T1-5 (round 11): the catch PINS the refusal
    // instead of swallowing everything — if a regression stopped the budget
    // gate from refusing, dispatch would resolve and this pass would silently
    // degrade to a second success-path audit, leaving the test's stated
    // subject (the refusal-path timer clear) untested while green.
    await auditSettledTimers(async () => {
      try {
        await dispatch(validBrief(), deps({ ledgerFactory: () => overBudgetLedger() }));
        failUnreachable();
      } catch (e) {
        if (e instanceof UnexpectedSuccessError) throw e;
        expect(e).toBeInstanceOf(FleetError);
        expect((e as FleetError).code).toBe("budget-exceeded");
        // exit 1 vs 2 not pinned here deliberately — the budget-arm's OWN test
        // owns that; this pass only needs "it refused" to be true.
      }
    });
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
      failUnreachable();
    } catch (e) {
      if (e instanceof UnexpectedSuccessError) throw e;
      expect(e).toBeInstanceOf(FleetError);
      const err = e as FleetError;
      expect(err.exitCode).toBe(1);
      // The untyped throw carries no `code`/`remediation`, so both fall back.
      expect(err.code).toBe("provision-failed");
      // The fallback IN FULL, like the message assertion below it. `toBeTruthy`
      // was satisfied by any non-empty string, including the wrong step's advice
      // — and this step straddles the record, so the fallback deliberately says
      // "inspect the run" rather than "the box is alive" (which half of
      // record→box failed is unknown here, and teardown is idempotent over both).
      expect(err.remediation).toBe(
        `inspect the run, then tear it down: bun scripts/fleet.ts teardown ${err.payload?.runId as string}`,
      );
      expect(err.remediation).not.toContain("the box is ALIVE");
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
    // The probe answers on stdout (`-e` pre-test, like item C): a manifest that
    // never landed says so by name. Absent stays UNMARKED — the fill step can
    // fix it, so it is the brief's own fault (do-not-retry), not the box's.
    expect(bMissing?.note).toContain("pipeline.yaml is absent");
    expect(bMissing?.note).not.toContain("substrate: ");
    expect(bMissing?.note).not.toContain("limitMicroUsd absent");

    const unstamped = await driver.create("box-probe-unstamped");
    await driver.exec(unstamped.name, ["sh", "-c", `mkdir -p ${IN_BOX_QDS_DIR} && printf '%s\\n' '{\"phases\":[]}' > ${IN_BOX_MANIFEST}`]);
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
      `mkdir -p ${IN_BOX_QDS_DIR} && printf '%s\\n' '{\"limitMicroUsd\":1,\"phases\":[]}' > ${IN_BOX_MANIFEST}`,
    ]);
    const ok = await fakeGate(driver, stamped.name, opts);
    expect(ok.assertions.find((a) => a.item === "B")?.ok).toBeTrue();

    // A manifest that landed and is EMPTY is the fill step half-done, not the
    // fill step skipped — the only arm `cat` can prove, since it is the only one
    // that exits 0.
    const empty = await driver.create("box-probe-empty");
    await driver.exec(empty.name, ["sh", "-c", `mkdir -p ${IN_BOX_QDS_DIR} && : > ${IN_BOX_MANIFEST}`]);
    const bEmpty = (await fakeGate(driver, empty.name, opts)).assertions.find((a) => a.item === "B");
    expect(bEmpty?.ok).toBeFalse();
    expect(bEmpty?.note).toContain("present but empty");
    expect(bEmpty?.note).not.toContain("missing");

    // The fourth arm: PRESENT, NON-EMPTY, and not JSON at all. It exits `cat`
    // with 0 and has length, so the missing/empty/unreadable trio above all
    // pass it through — only the parse refusal names it, and without this case
    // a B that reported any of those three instead would stay green.
    const garbage = await driver.create("box-probe-garbage");
    await driver.exec(garbage.name, [
      "sh",
      "-c",
      `mkdir -p ${IN_BOX_QDS_DIR} && printf '%s\\n' 'this is not json at all' > ${IN_BOX_MANIFEST}`,
    ]);
    const bGarbage = (await fakeGate(driver, garbage.name, opts)).assertions.find(
      (a) => a.item === "B",
    );
    expect(bGarbage?.ok).toBeFalse();
    expect(bGarbage?.note).toContain("not parseable");
    expect(bGarbage?.note).not.toContain("present but empty");
    expect(bGarbage?.note).not.toContain("pipeline.yaml is absent");
    expect(bGarbage?.note).not.toContain("could not be read");
    expect(bGarbage?.note).not.toContain("limitMicroUsd absent");

  });

  // The operational-error path: the manifest EXISTS and cannot be read (mode
  // 000, EIO, an ACL). The probe's `-e` pre-test now PROVES presence before the
  // read, so present-but-unreadable no longer shares an answer with "missing":
  // existed + empty body + nonzero exit ⇒ SUBSTRATE_MARK (the box failed; the
  // fill step cannot fix it), where genuinely-missing stays unmarked
  // do-not-retry. That separation IS K3's fix — the .env side already worked
  // this way, and an operator re-running a fill step that succeeded burned a
  // retry budget on a transient box fault classified as the brief's own fault.
  //
  // Unreadability is injected at the DRIVER, not with `chmod 000`. Root reads a
  // mode-000 file, so the chmod fixture had to carry
  // `test.skipIf(process.getuid?.() === 0)` — which skips exactly where CI runs
  // (root in Docker), so this arm could collapse back into "missing" and ship
  // green with only a skip marker to say it had never been attempted. A stubbed
  // `exec` reproduces what an EACCES actually delivers to the probe (empty
  // stdout, nonzero exit from the cat half of the compound) on every host and
  // every uid — the `-e` halves still hit the real box, so existence is proven.
  test("gate item B reports an existing-but-unreadable manifest as SUBSTRATE, not missing", async () => {
    const box = await driver.create("box-probe-unreadable");
    // The manifest is REAL and well-formed — the file exists and would pass B
    // outright. Without this the case proves nothing about "existing but
    // unreadable"; it is the fixture's whole premise.
    await driver.exec(box.name, [
      "sh",
      "-c",
      `mkdir -p ${IN_BOX_QDS_DIR} && printf '%s\\n' '{\"limitMicroUsd\":1,\"phases\":[{\"name\":\"plan\"}]}' > ${IN_BOX_MANIFEST}`,
    ]);
    const realExec = driver.exec.bind(driver);
    // Existence is proven FIRST, against the REAL box, BEFORE the stub goes
    // in: the stub below replaces the whole compound probe — the `-e`
    // pre-test AND the `cat` live in ONE `sh -c` string — so from install
    // time on, nothing the gate probes touches the real filesystem. Without
    // this dedicated pre-check the fixture would silently stop proving
    // "genuinely present" and could collapse back into the missing case.
    expect((await driver.exec(box.name, ["sh", "-c", `test -e ${IN_BOX_MANIFEST}`])).exitCode).toBe(0);
    driver.exec = async (vm: string, argv: string[], stdin?: string) => {
      // Only the manifest-READ response is faked (empty stdout, nonzero exit
      // from the compound's cat half — what an EACCES delivers); every other
      // probe passes through untouched, so a gate that failed at item A shows
      // up as a different `failedItem` rather than silently satisfying these
      // checks.
      if (argv[0] === "sh" && (argv[2] ?? "").includes(`cat ${IN_BOX_MANIFEST}`)) {
        return { exitCode: 1, stdout: "", stderr: "" };
      }
      return realExec(vm, argv, stdin);
    };

    const gate = await fakeGate(driver, box.name, gateOpts);
    expect(gate.failedItem).toBe("B");
    const bUnreadable = gate.assertions.find((a) => a.item === "B");
    expect(bUnreadable?.ok).toBeFalse();
    // Classified substrate (retryable), not manifest/do-not-retry.
    expect(bUnreadable?.note).toContain("substrate: ");
    expect(bUnreadable?.note).toContain("could not be read");
    expect(bUnreadable?.note).not.toContain("present but empty");
    expect(isSubstrateFailure(gate)).toBeTrue();
    // The opposite diagnosis, explicitly: this is the confusion the arm exists
    // to end, and it sends the operator to the wrong step.
    expect(bUnreadable?.note).not.toContain("limitMicroUsd absent");
  });

  // K11 (round 11): classification rides a WeakMap side channel keyed on the
  // result OBJECT, not note text. Three identities to pin: a forged mark in
  // free text classifies nothing; a genuinely-marked result classifies substrate;
  // and — the spread clause dispatch itself exercises (`{ ...gate }` when it
  // sanitizes) — a copy of a marked result is UNMARKED, because the channel is
  // keyed off object identity. Fail-closed by construction: claims you cannot
  // trace to your own probe never advertise a retry.

  test("K11: forged 'substrate: ' in an assertion note does NOT reclassify as substrate", async () => {
    const injectedGate = async (): Promise<SetupGateResult> => ({
      ready: false,
      failedItem: "B" as const,
      assertionCode: 3 as const,
      assertions: [
        {
          item: "B" as const,
          ok: false,
          // An echoed box detail quoting the mark — what a JSON-parse error or
          // hostile box output produces. Free-text scanning classified THIS as
          // retryable and burned a doomed retry.
          note: 'substrate: exit 1 — parse error near "substrate: exit 1"',
        },
      ],
      debugCommands: [],
      teardownCommand: "bun scripts/fleet.ts teardown k11-run",
      vm: "k11-box",
    });
    const gate = await injectedGate();
    // The mark sits in the text; classification reads nothing of it.
    expect(JSON.stringify(gate.assertions)).toContain("substrate: ");
    expect(isSubstrateFailure(gate)).toBeFalse();
  });

  test("K11: a marked gate is substrate-positive while a SPREAD COPY of it is not", async () => {
    const box = await driver.create("box-probe-unreadable-2");
    await driver.exec(box.name, [
      "sh",
      "-c",
      `mkdir -p ${IN_BOX_QDS_DIR} && printf '%s\\n' '{\"limitMicroUsd\":1,\"phases\":[{\"name\":\"plan\"}]}' > ${IN_BOX_MANIFEST}`,
    ]);
    const realExec2 = driver.exec.bind(driver);
    driver.exec = async (vm: string, argv: string[], stdin?: string) => {
      if (argv[0] === "sh" && (argv[2] ?? "").includes(`cat ${IN_BOX_MANIFEST}`)) {
        return { exitCode: 1, stdout: "", stderr: "" };
      }
      return realExec2(vm, argv, stdin);
    };
    try {
      const gate = await fakeGate(driver, box.name, gateOpts);
      expect(isSubstrateFailure(gate)).toBeTrue(); // the original carries its verdict…
      // …but a STRUCTURAL copy loses it — identity-keyed, fail-closed. A caller
      // that clones/spreads a gate (dispatch's sanitizer shape) gets "unknown
      // provenance ⇒ do not advertise retry", never the inherited claim.
      const copy = { ...gate };
      expect(copy).toEqual(gate); // same CONTENT…
      expect(isSubstrateFailure(copy)).toBeFalse(); // …different VERDICT
    } finally {
      driver.exec = realExec2;
    }
  });

  // K12 (round 11): the operator-run debug/teardown commands interpolate runId.
  // A value outside the shell-safe charset used to reach the string raw — an
  // injection-shaped hole in copy-pasteable advice. Now a non-conforming id is
  // substituted with a placeholder (the refusal payload still carries the real
  // id for correlation), and this pins BOTH arms through the exported gate.
  test("K12: fakeGate commands quote a conforming runId but SUBSTITUTE a non-conforming one", async () => {
    const box = await driver.create("box-probe-k12");
    const conforming = await fakeGate(driver, box.name, { ...gateOpts, runId: "k12-20260827-a1b2c3" });
    expect(conforming.debugCommands[0]).toBe("bun scripts/fleet.ts status k12-20260827-a1b2c3");
    expect(conforming.teardownCommand).toBe("bun scripts/fleet.ts teardown k12-20260827-a1b2c3");

    // A hostile id: metacharacters that would break out of the command string.
    const hostile = 'x; rm -rf / #';
    const substituted = await fakeGate(driver, box.name, { ...gateOpts, runId: hostile });
    expect(substituted.debugCommands[0]).toContain("<run-id>");
    expect(substituted.teardownCommand).toContain("<run-id>");
    // No fragment of the hostile value survives into either command.
    for (const cmd of [substituted.debugCommands[0], substituted.teardownCommand]) {
      expect(cmd).not.toContain("rm -rf");
      expect(cmd).not.toContain(hostile);
    }
  });

  // Round 4, P48: `workdir: ""` is NOT nullish, so `opts.workdir ?? DEFAULT`
  // keeps it and boxManifest("") derives `/.qds/pipeline.yaml` — an ABSOLUTE
  // path the startsWith("/") refusal never sees, because that check tests
  // `gateWorkdir` (the empty string passes), not the derived path. The probe
  // would then `cat` a location outside the checkout — the exact wrong-tree
  // read the workdir seam exists to stop. `assertPlainBoxPath` refuses a
  // zero-length value and runs FIRST, so this row pins that the gate's own
  // seam routes through it: a plain-path THROW (a caller bug), never an
  // item-B failure about a box.
  test("round 4 P48: fakeGate refuses an empty workdir before any probe runs", async () => {
    const box = await driver.create("box-probe-empty-workdir");
    const realExec = driver.exec.bind(driver);
    let execs = 0;
    driver.exec = async (vm: string, argv: string[], stdin?: string) => {
      execs += 1;
      return realExec(vm, argv, stdin);
    };
    try {
      let err: unknown;
      try {
        await fakeGate(driver, box.name, { ...gateOpts, workdir: "" });
      } catch (e) {
        err = e;
      }
      expect(err).toBeInstanceOf(Error);
      expect((err as Error).message).toContain("not a plain path");
      // A caller bug, not a box fact: zero probes were issued.
      expect(execs).toBe(0);
    } finally {
      driver.exec = realExec;
    }
  });

  test("gate items D and E inspect the manifest's CONTENT, not just its keys", async () => {    // D used to re-test "manifest non-empty", which item B's own first arm has
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
        `mkdir -p ${IN_BOX_QDS_DIR} && printf '%s' '${manifest}' > ${IN_BOX_MANIFEST} && : > .env && chmod 600 .env`,
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
    // Pinned to the same depth as the `zero` case above — the item alone is
    // satisfied by a D that refused for some other reason entirely (and D is the
    // item every malformed ceiling lands on), so the code and the note are what
    // say the string was judged as a NUMBER and found not to be one.
    const stringly = await gateOn("box-probe-stringly", '{"limitMicroUsd":"50","phases":[{"name":"plan"}]}');
    expect(stringly.failedItem).toBe("D");
    expect(stringly.assertionCode).toBe(3);
    const dStringly = stringly.assertions.find((a) => a.item === "D")?.note;
    expect(dStringly).toContain("not a positive integer");
    // The offending value is QUOTED back, so `"50"` and `50` are distinguishable
    // in the refusal an operator reads.
    expect(dStringly).toContain('"50"');

    const noPhases = await gateOn("box-probe-nophases", '{"limitMicroUsd":1,"phases":[]}');
    expect(noPhases.failedItem).toBe("E");
    expect(noPhases.assertionCode).toBe(4);
    // D's depth: the item alone is satisfied by an E that refused for some
    // other reason entirely — the note is what says the phases LIST was judged
    // and found empty, which is this arm's whole diagnosis.
    expect(noPhases.assertions.find((a) => a.item === "E")?.note).toContain(
      "no non-empty root-level phases list",
    );

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
    expect(entries.length).toBeGreaterThan(0);
    expect(delivered()).toContain(knownKey);
    // The VARIABLE, not a hand-copied prefix: the fixture's random-looking tail
    // is the part a partial redaction is most likely to leave behind.
    expect(entries.some((e) => JSON.stringify(e).includes(knownKey))).toBeFalse();
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
      failUnreachable();
    } catch (e) {
      if (e instanceof UnexpectedSuccessError) throw e;
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
    //
    // T1-18 (round 11): the injectable half cannot see a dispatch-side
    // mishandling of QuotaLimitsError SPECIFICALLY (vs any untyped throw from
    // the seam). The production trigger itself is pinned one layer down, at
    // `loadQuotaLimits`'s own boundary, where the typed class and its code are
    // cheap to observe through the same env var the CLI inherits — without
    // redirecting that global mid-suite or growing a second dispatch seam:
    await (async () => {
      const bad = join(outsideDir, "quota-limits-bad.json");
      writeFileSync(bad, "{not json");
      const saved = process.env.QDS_QUOTA_LIMITS_FILE;
      process.env.QDS_QUOTA_LIMITS_FILE = bad;
      try {
        let caught: unknown;
        try {
          loadQuotaLimits();
        } catch (e) {
          caught = e;
        }
        expect(caught).toBeInstanceOf(QuotaLimitsError);
        expect((caught as QuotaLimitsError).code).toBe("quota-limits-unreadable");
      } finally {
        // biome-ignore lint/performance/noDelete: unsetting env vars requires delete
        if (saved === undefined) delete process.env.QDS_QUOTA_LIMITS_FILE;
        else process.env.QDS_QUOTA_LIMITS_FILE = saved;
      }
    })();
    try {
      await dispatch(
        validBrief(),
        deps({ quotaLimits: {} as unknown as LoadedQuotaLimits }),
      );
      failUnreachable();
    } catch (e) {
      if (e instanceof UnexpectedSuccessError) throw e;
      expect(e).toBeInstanceOf(FleetError);
      const err = e as FleetError;
      expect(err.exitCode).toBe(5);
      expect(err.code).toBe("headroom-failed");
      // T1-7 (round 11): the line is pinned through the family helper, not a
      // bare count — the old toHaveLength(1) passed a line filed with the wrong
      // code or status≠error, which every sibling refusal family refuses.
      const refused = expectSingleRefusalLine("headroom-failed");
      expect(refused.runId).toBe(err.payload?.runId as string);
    }
    expect(readdirSync(store.dir)).toHaveLength(0);
    expect(await driver.list()).toHaveLength(0);
  });

  test("a mint that THROWS mid-provision refuses exit 1 key-delivery-failed with a FIXED message", async () => {
    // The sibling below covers the DELIVERY half (the exec echo). This is the
    // MINT half: `createKey` rejects after the box exists. The step-7 catch
    // exists so the provider's free text never reaches any sink — the message is
    // FIXED, the code rides the payload only when the throw carried one — and
    // that posture is what gets pinned here, alongside the INV-5 shape the
    // provisioning-failure sibling pins for its own step.
    const vaultError = new Error("vault unavailable: 503 from upstream");
    keyApi.createKey = async () => {
      throw vaultError;
    };
    const ledger = goodLedger();

    try {
      await dispatch(validBrief(), deps({ ledgerFactory: () => ledger }));
      failUnreachable();
    } catch (e) {
      if (e instanceof UnexpectedSuccessError) throw e;
      const err = e as FleetError;
      expect(err.exitCode).toBe(1);
      expect(err.code).toBe("key-delivery-failed");
      // FIXED message: the provider's free text appears nowhere in it…
      expect(err.message).toContain("key mint or delivery failed");
      expect(err.message).not.toContain("vault unavailable");
      // …and a plain Error carries no `code`, which is named by omission.
      expect(err.payload?.providerCode).toBeUndefined();
      // INV-5 posture: record OPEN, box ALIVE, operator commands name THIS run.
      const runId = err.payload?.runId as string;
      expect(store.get(runId).closedAt).toBeUndefined();
      expect(err.payload?.teardownCommand).toBe(`bun scripts/fleet.ts teardown ${runId}`);
      expect(err.payload?.debugCommands).toEqual([`bun scripts/fleet.ts status ${runId}`]);
      const boxes = await driver.list();
      expect(boxes.some((b) => b.name === store.get(runId).vmName)).toBeTrue();
    }
    // The FLEET-side sinks carry no provider free text — dispatch's own
    // structured lines and the persisted dispatch log (AC4 evidence). The
    // providers layer logs its own step line for the failed mint; that copy is
    // `redactSecrets`' jurisdiction (see the delivery sibling's two-half split),
    // not this catch's.
    const own = entries.filter((line) => line.operation === "fleet.dispatch");
    expect(own.length).toBeGreaterThan(0);
    expect(own.some((line) => JSON.stringify(line).includes("vault unavailable"))).toBeFalse();
    expect(readFileSync(join(dir, "dispatch-log.jsonl"), "utf8")).not.toContain(
      "vault unavailable",
    );
    expectSingleRefusalLine("key-delivery-failed");
    // The handle closes on this path too.
    expect(ledger.closeCalls).toBe(1);
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
      failUnreachable();
    } catch (e) {
      if (e instanceof UnexpectedSuccessError) throw e;
      expect(e).toBeInstanceOf(FleetError);
      const err = e as FleetError;
      expect(err.exitCode).toBe(1);
      expect(err.code).toBe("key-delivery-failed");
      // The whole envelope, not just the message: remediation and payload are
      // operator-facing sinks too.
      const envelope = JSON.stringify({ m: err.message, r: err.remediation, p: err.payload });
      expect(envelope).not.toContain(knownKey);
      expect(envelope).not.toContain("sk-or-v1-");
      // The record is the sink that OUTLIVES this process (INV-1 wrote it
      // before the box), and it must not become the leak's persistence layer.
      const record = store.get(err.payload?.runId as string);
      expect(JSON.stringify(record)).not.toContain(knownKey);
      expect(JSON.stringify(record)).not.toContain("sk-or-v1-");
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
      failUnreachable();
    } catch (e) {
      if (e instanceof UnexpectedSuccessError) throw e;
      expect(e).toBeInstanceOf(FleetError);
      const err = e as FleetError;
      expect(err.exitCode).toBe(1);
      expect(err.code).toBe("dispatch-timeout");
      expect(err.payload?.step).toBe("create");
      expect(err.payload).not.toHaveProperty("vmName");
      // VERBATIM, because this one is a bare literal rather than a composed
      // command: a rename sweep over `timeoutMs` inside `DispatchContext`
      // rewrote it to "raise this.timeoutMs" once (F003 review r1), and every
      // other assertion on this path passed. The operator is told to raise the
      // PARAMETER, which has no `this.`.
      expect(err.remediation).toBe("raise timeoutMs, or retry when the substrate is responsive");
    }
    // A timeout is a refusal like any other: it files the structured line the
    // operator joins on, or AC4's evidence trail silently loses every expiry.
    expectSingleRefusalLine("dispatch-timeout");
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
      failUnreachable();
    } catch (e) {
      if (e instanceof UnexpectedSuccessError) throw e;
      expect(e).toBeInstanceOf(FleetError);
      const err = e as FleetError;
      expect(err.exitCode).toBe(2);
      expect(err.code).toBe("invalid-request-id");
    }
    expect(readdirSync(store.dir)).toHaveLength(0);
    // The evidence trail every OTHER pre-provision refusal in this file asserts,
    // and this one did not: a refusal that files no structured line and no
    // dispatch-log entry is invisible to AC4's evidence, however correct its
    // exit code. The correlation id is the thing that failed to resolve, so the
    // line names it as unresolved rather than fabricating one.
    const refusals = refusalLines();
    expect(refusals).toHaveLength(1);
    expect((refusals[0] as LogEntry).requestId).toBe("unresolved");
    expect((refusals[0] as LogEntry).runId).toBeNull();
    const logged = readFileSync(join(dir, "dispatch-log.jsonl"), "utf8").trim().split("\n");
    expect(logged).toHaveLength(1);
    expect((JSON.parse(logged[0] as string) as { code: string }).code).toBe("invalid-request-id");
  });

  test("INV-6: a SHORT secret path segment is redacted from the whole refusal envelope", async () => {
    // The rule was length-based (`/\\/[^/]{16,}/`), so an 11-character token in
    // a URL path reached the dispatch log, the structured line and the
    // FleetError intact — length is not a property of a secret. `remediation`
    // was not redacted at all, only `message`.
    const token = "abc123token";
    let thrown = "";
    driver.create = async () => {
      thrown = `create failed: https://exe.xyz/vm/${token}`;
      throw Object.assign(new Error(thrown), {
        code: "ECONNRESET",
        remediation: `retry against https://exe.xyz/vm/${token}`,
      });
    };

    try {
      await dispatch(validBrief(), deps());
      failUnreachable();
    } catch (e) {
      if (e instanceof UnexpectedSuccessError) throw e;
      const err = e as FleetError;
      expect(err.code).toBe("provision-failed");
      expect(err.payload?.providerCode).toBe("ECONNRESET");
      expect(err.message).not.toContain(token);
      expect(err.remediation).not.toContain(token);
      // Same persistence half as the key-delivery sibling: the record written
      // before the box never carries the secret either.
      const record = store.get(err.payload?.runId as string);
      expect(JSON.stringify(record)).not.toContain(token);
      // The host survives — an operator has to be able to tell which substrate
      // the line is about.
      expect(err.message).toContain("https://exe.xyz");
    }
    // POSITIVE CONTROL, the same one the INV-4 siblings carry: every assertion
    // here is an absence proof, and an absence proof over a run where the token
    // never reached a sink's reach — or where no line was emitted at all — is
    // vacuous and stays green with the redaction deleted.
    expect(thrown).toContain(token);
    expect(entries.length).toBeGreaterThan(0);
    // The SAME sink set as the INV-4 sibling, not a narrower one: the structured
    // lines AND the persisted dispatch log (AC4 evidence), which is the copy
    // that outlives the process.
    expect(entries.filter((e) => JSON.stringify(e).includes(token)).map((e) => e.operation)).toEqual([]);
    expect(readFileSync(join(dir, "dispatch-log.jsonl"), "utf8")).not.toContain(token);
  });

  test("C7: an author-supplied limitMicroUsd never reaches the box — the admitted ceiling does", async () => {
    // AC9a makes the manifest the cap's ONLY in-box carrier, so a hand-authored
    // ceiling in the source manifest is an attempt to name the number the budget
    // gate is supposed to name. Stripped at dispatch's host-side read, not in
    // `loadManifest` — the runner reads the already-stamped manifest back
    // through that same loader and must keep the stamp.
    const authored = 999_000_000;
    const manifestRel = join("manifests", "authored-limit.json");
    mkdirSync(join(dir, "manifests"), { recursive: true });
    writeFileSync(
      join(dir, manifestRel),
      JSON.stringify({
        version: "1.0.0",
        pipelineId: "test-pipeline",
        runBudgetMs: 200_000,
        limitMicroUsd: authored,
        phases: [
          { name: "plan", kind: "code", description: "Draft the approach for the change", command: ["true"], maxDurationMs: 10_000, retries: 0 },
          { name: "build", kind: "code", description: "Run the repository test suite", command: ["bun", "test"], maxDurationMs: 40_000, retries: 0 },
        ],
      }),
    );

    const admittedCeiling = 250_000;
    const result = await dispatch(
      { ...validBrief(), manifestPath: manifestRel },
      deps({ ledgerFactory: () => goodLedger(admittedCeiling) }),
    );

    const delivered = await driver.exec(result.vmName, ["sh", "-c", `cat ${IN_BOX_MANIFEST}`]);
    expect(JSON.parse(delivered.stdout).limitMicroUsd).toBe(admittedCeiling);

    // The other half, and the one the assertion above cannot make: that the
    // authored number went NOWHERE. `limitMicroUsd` is the field the strip
    // targets, so a strip that only overwrote that one key — while the authored
    // figure reached the box by another carrier (`run-context.json`'s
    // `effectiveCeilingMicros`, DF1.6's spawn seam), reached the ledger's record
    // of what this run may spend, or reached a log line an operator reads as the
    // run's ceiling — passes the delivered-manifest check outright.
    const boxManifest = delivered.stdout;
    const ctx = await driver.exec(result.vmName, ["sh", "-c", `cat ${IN_BOX_RUN_CONTEXT}`]);
    expect((JSON.parse(ctx.stdout) as { effectiveCeilingMicros: number }).effectiveCeilingMicros).toBe(
      admittedCeiling,
    );
    const record = store.get(result.runId);
    expect(record.extensions?.budget?.admittedCeilingMicroUsd).toBe(admittedCeiling);
    // Every sink at once, as TEXT: a carrier this test did not think to name is
    // still caught, and the failure message shows which one held it.
    for (const [label, text] of [
      ["pipeline.yaml", boxManifest],
      ["run-context.json", ctx.stdout],
      ["the run record", JSON.stringify(record)],
      ["the structured log", JSON.stringify(entries)],
      ["the ack", JSON.stringify(result)],
    ] as const) {
      expect(`${label}: ${text}`).not.toContain(String(authored));
    }
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
    let echoedLimitUsd: number | undefined;
    keyApi.createKey = async (_name: string, limit: number) => {
      echoedLimitUsd = limit;
      return {
        key: knownKey,
        hash: "beefbeef",
        limitUsd: limit,
        usageUsd: 0,
      };
    };

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
    // GATED, not slept. A 250 ms exec racing a 30 ms remainder and then a fixed
    // 400 ms drain made this test a scheduling bet: under load the exec could
    // lose, and the failure surfaced as a REDACTION regression when it was a
    // timing one. The delivery now blocks until the test itself releases it,
    // which it does only after `dispatch` has already refused — so the race is
    // ABANDONED first by construction, at any load, and this rejection lands on
    // the abandoned handler with no other subscriber.
    let echoed = "";
    let releaseDeliver: () => void = () => {};
    const delivering = new Promise<void>((r) => {
      releaseDeliver = r;
    });
    const realExec = driver.exec.bind(driver);
    driver.exec = async (vm: string, argv: string[], stdin?: string) => {
      if (stdin === undefined) return realExec(vm, argv, stdin);
      echoed = `exec failed: ${argv.join(" ")} <<<${stdin}`;
      await delivering;
      throw new Error(echoed);
    };

    try {
      await dispatch(validBrief(), deps({ clock }));
      failUnreachable();
    } catch (e) {
      if (e instanceof UnexpectedSuccessError) throw e;
      const err = e as FleetError;
      expect(err.code).toBe("dispatch-timeout");
      expect(err.payload?.step).toBe("deliver");
    }
    // Only NOW does the abandoned call fail. The handler fires on the abandoned
    // promise, one microtask chain later; awaited off the SINK, not off a tick
    // budget — see `awaitEntry` for why 50 `setTimeout(0)` ticks were a bet the
    // test could lose under load, and lose while reporting a redaction fault.
    releaseDeliver();
    const line = await abandonedLine("deliver");

    // POSITIVE CONTROLS, both required: an absence proof over a line that was
    // never emitted, or over a message that never carried the key, is vacuous —
    // it stays green with the redaction deleted.
    expect(echoed).toContain(knownKey);
    // The stand-in ECHOES the limit dispatch asked the provider to mint; read it
    // back, or an argument swap in createKey's (name, limitUsd) call — or a µ$/m$
    // unit slip — sails through undetected. Default ledger ⇒ defaultKeyCap ceiling.
    expect(echoedLimitUsd).toBe(defaultKeyCapMicroUsd / 1_000_000);
    // The FAILURE arm of the handler, named: the abandoned call rejected, which
    // is a different line (and a different code) from an abandoned call that
    // completed — and it is the one that carries the provider's free text.
    expect((line.error as { code?: string }).code).toBe("abandoned-step-failed");
    expect(line.exitStatus).toBe("transient");

    const text = JSON.stringify(line);
    expect(text).not.toContain(knownKey);
    expect(text).not.toContain("sk-or-v1-");
    // And no other sink either — the handler is not the only line in flight.
    expect(entries.filter((e) => JSON.stringify(e).includes(knownKey)).map((e) => e.operation)).toEqual([]);
  });

  test("an ABANDONED mint names the KEY it left live — hash and cap, never the plaintext", async () => {
    // `within`'s abandoned-success handler used to duck-type on `value.vm`,
    // which only the `create` step resolves — so the two other steps whose late
    // success is expensive logged a line identifying NOTHING. A `mint` that
    // lands after the refusal is a live provider key at the full admitted
    // ceiling, and its `hash` is the only handle anyone has to revoke it; the
    // refusal has already gone out naming nothing about it, so this line is the
    // only pointer that exists until the record write catches up.
    const admittedCeiling = 12_000_000;
    const { clock, advance } = stepClock();
    // The mint step's deadline is what has to expire, and it is armed with what
    // is LEFT when the step starts — so the budget is spent inside `create`,
    // whose own timer was armed with the full ceiling before it ran. Nothing
    // races a real clock: 200 ms is the whole of the mint step's budget, by
    // construction and at any load.
    // TWO-STAGE clock spend, so no CI stall can flip WHICH step expires:
    //   - inside `create` (after the real box exists) spend all but 30 s — every
    //     timer any OTHER step arms from here holds ~30 s of REAL time, which no
    //     plausible loop stall outlives before the runner's own timeout;
    //   - at the LAST synchronous seam before `within("mint")` arms its timer
    //     (the correlation stamp — nothing is awaited between it and the arming)
    //     spend down to 900 ms, so `mint` is the ONLY step holding a short timer.
    // The old single 1 s advance left every adjacent step the same 1 s, so a
    // stalled loop could fire an earlier step's timer first.
    const EARLY_LEFT_MS = 30_000;
    const TARGET_LEFT_MS = 900;
    const realCreate = driver.create.bind(driver);
    driver.create = async (name: string, tag?: string) => {
      const vm = await realCreate(name, tag);
      advance(DEFAULT_TIMEOUT_MS - EARLY_LEFT_MS);
      return vm;
    };
    const realSet = store.set.bind(store);
    store.set = (id: string, patch: Parameters<RunRecordStore["set"]>[1]) => {
      if (Object.keys(patch).length === 1 && "requestId" in patch) {
        advance(EARLY_LEFT_MS - TARGET_LEFT_MS);
      }
      return realSet(id, patch);
    };
    const knownKey = "sk-or-v1-abandonedmintkey31337";
    let releaseMint: () => void = () => {};
    const minting = new Promise<void>((r) => {
      releaseMint = r;
    });
    let echoedLimitUsd: number | undefined;
    keyApi.createKey = async (_name: string, limitUsd: number) => {
      echoedLimitUsd = limitUsd;
      // GATED, not slept: the mint completes only once the test releases it,
      // which it does after `dispatch` has already refused — so the call is
      // ABANDONED first by construction and the handler is its only subscriber.
      await minting;
      return { key: knownKey, hash: "d00dfeed", limitUsd, usageUsd: 0 };
    };

    try {
      await dispatch(validBrief(), deps({ clock, ledgerFactory: () => goodLedger(admittedCeiling) }));
      failUnreachable();
    } catch (e) {
      if (e instanceof UnexpectedSuccessError) throw e;
      const err = e as FleetError;
      expect(err.code).toBe("dispatch-timeout");
      expect(err.payload?.step).toBe("mint");
      // The remediation is step-aware for the same reason this line is: the
      // operator has to be told a key may go live AFTER the refusal.
      expect(err.remediation).toContain("keyHash");
    }

    releaseMint();
    const line = await abandonedLine("mint");
    expect((line.error as { code?: string }).code).toBe("abandoned-step-succeeded");
    // What IDENTIFIES the key: the provider-side handle, and what it may spend.
    expect(line.keyHash).toBe("d00dfeed");
    expect(line.capMicroUsd).toBe(admittedCeiling);
    // The stand-in ECHOES what dispatch ASKED the provider to mint — read it
    // back, or an argument swap in createKey's (name, limitUsd) call, or a µ$/m$
    // unit slip, sails through: `capMicroUsd` above is stamped from the ledger
    // decision, not from this echo. 12_000_000 µ$ ⇒ 12 USD requested.
    expect(echoedLimitUsd).toBe(admittedCeiling / 1_000_000);
    // INV-4: the hash, never the plaintext — this is a log sink.
    expect(JSON.stringify(line)).not.toContain(knownKey);
    expect(JSON.stringify(line)).not.toContain("sk-or-v1-");

    // DF5.3: the abandoned mint's audit link arrives AFTER the dispatch closed
    // the store. That is a deliberate LOGGED DROP, not a throw into a closed
    // `Database` — which would turn this step's `abandoned-step-succeeded` into
    // `abandoned-step-failed` and bury the one fact the operator needs (a live
    // key exists after the refusal) under an audit-plumbing error.
    await awaitEntry((e) => e.phase === "audit-dropped" && e.step === "mint");
    const drops = entries.filter((e) => e.phase === "audit-dropped");
    expect(drops).toHaveLength(1);
    const drop = drops[0] as LogEntry;
    expect((drop.error as { code?: string }).code).toBe("audit-link-dropped-after-close");
    expect(drop.exitStatus).toBe("transient");
    expect(drop.status).toBe("error");
    // Joinable: the line names the run whose link was dropped, not `null`.
    //
    // The expected id comes off the REFUSAL LINE, not `readdirSync(store.dir)[0]`.
    // `readdirSync` order is OS-defined, `<runsDir>/<runId>.lock` and its
    // `.lktmp` reap temporaries share that directory (run-lock.ts), and
    // `?.replace(/\.json$/, "")` leaves a lock name intact — so `[0]` could
    // yield `undefined` or a lock file and the comparison would degrade into
    // `expect(x).toBe(undefined)` instead of failing loudly on the real id.
    const refusedRunId = expectSingleRefusalLine("dispatch-timeout").runId;
    expect(typeof refusedRunId).toBe("string");
    expect(drop.runId).toBe(refusedRunId);
    // Its OWN phase, never `abandoned`: `abandonedLine` above counts those and
    // asserts exactly one per expired step, and a drop is not a step expiry.
    expect(drop.phase).not.toBe("abandoned");
    expect(JSON.stringify(drop)).not.toContain(knownKey);
    // And the link genuinely did NOT reach the store.
    expect(existsSync(auditDb.path())).toBeTrue();
    expect(
      auditRows(drop.runId as string).filter((r) => r.event === "mint"),
    ).toStrictEqual([]);
  });

  test("an ABANDONED setPublic names the BOX it may have published", async () => {
    // The other duck-typed casualty: `setPublic` resolves `void`, so a late one
    // logged a line saying a step completed and nothing about WHICH box just
    // became publicly reachable — after the operator was told the dispatch
    // failed and has no reason to believe anything went public at all.
    const { clock, advance } = stepClock();
    let releasePublic: () => void = () => {};
    const publishing = new Promise<void>((r) => {
      releasePublic = r;
    });
    driver.setPublic = async () => {
      await publishing;
    };

    // TWO-STAGE clock spend, same scheme as the abandoned-mint sibling: after
    // the gate, leave 30 s so `expose`'s timer is far too long for any loop
    // stall to outlive; at the LAST synchronous seam before `within("setPublic")`
    // arms its timer — the `httpsUrl` record write, with nothing awaited between
    // it and the arming — spend down to 900 ms, so `setPublic` alone holds the
    // short timer. The old single 1 s advance gave `expose` the SAME 1 s, and a
    // stalled loop during expose could fire ITS timer first, flipping which step
    // the refusal names.
    const EARLY_LEFT_MS = 30_000;
    const TARGET_LEFT_MS = 900;
    const realSet = store.set.bind(store);
    store.set = (id: string, patch: Parameters<RunRecordStore["set"]>[1]) => {
      if (Object.keys(patch).length === 1 && "httpsUrl" in patch) {
        advance(EARLY_LEFT_MS - TARGET_LEFT_MS);
      }
      return realSet(id, patch);
    };

    let err: FleetError | undefined;
    try {
      await dispatch(
        validBrief(),
        deps({
          clock,
          port: 8080,
          setupGate: async (drv, vm, o) => {
            const gate = await fakeGate(drv, vm, o);
            advance(DEFAULT_TIMEOUT_MS - EARLY_LEFT_MS);
            return gate;
          },
        }),
      );
    } catch (e) {
      err = e as FleetError;
    }
    expect(err).toBeInstanceOf(FleetError);
    expect((err as FleetError).code).toBe("dispatch-timeout");
    expect((err as FleetError).payload?.step).toBe("setPublic");
    expect((err as FleetError).remediation).toContain("PUBLICLY REACHABLE");
    const runId = (err as FleetError).payload?.runId as string;

    // The port claim is KEPT on the abandon path — an expose that already
    // landed is real, and a record claiming no port would under-report a live
    // public box to `fleet status` and to every port-keyed reaper.
    expect(store.get(runId).ports).toEqual([8080]);

    releasePublic();
    const line = await abandonedLine("setPublic");
    expect((line.error as { code?: string }).code).toBe("abandoned-step-succeeded");
    // Shape-pinned BEFORE the equality: `undefined === undefined` satisfies
    // `toBe`, so an unnamed box on BOTH sides — a describeLate that dropped
    // vmName AND a record write that never landed — would pass vacuously.
    expect(line.vmName).toBeString();
    expect(line.vmName).toMatch(/^qds-/);
    expect(store.get(runId).vmName).toBeString();
    expect(line.vmName).toBe(store.get(runId).vmName);
    expect(line.publiclyReachable).toBeTrue();
  });

  test("a create that TIMES OUT still leaves the correlation id on the record", async () => {
    // `store.create` takes only an id, so the correlation could only be written
    // after `provisionAdmittedRun` RETURNED — and on this path it never does.
    // The record survived with a `requestId` of nothing at all: `fleet status`
    // shows an open run that joins to no log line anywhere, forever, which is
    // exactly the run (one that died mid-provisioning) whose lines an operator
    // needs. `stampCorrelation` runs from the create step's own failure path.
    const requestId = "1f2e3d4c-5b6a-4798-8899-aabbccddeeff";
    const { clock, advance } = stepClock();
    let releaseCreate: () => void = () => {};
    const creating = new Promise<void>((r) => {
      releaseCreate = r;
    });
    const realCreate = driver.create.bind(driver);
    driver.create = async (name: string, tag?: string) => {
      await creating;
      return realCreate(name, tag);
    };

    let err: FleetError | undefined;
    try {
      await dispatch(
        validBrief({ requestId }),
        deps({
          clock,
          // The last seam before the create step. NO other timer can win here:
          // the stretch between this advance and `within("create")` arming its
          // timer is fully synchronous, and every EARLIER timer (headroom) was
          // armed with the full ceiling and cleared before the advance ran — so
          // a CI stall can delay the refusal but never flip WHICH step it
          // names. The 2 s margin is insurance against a future refactor
          // inserting an awaited step between admission and provisioning.
          // `store.create` (INV-1's first half) has already written the record
          // by the time the create timer expires.
          ledgerFactory: () => {
            advance(DEFAULT_TIMEOUT_MS - 2_000);
            return goodLedger();
          },
        }),
      );
    } catch (e) {
      err = e as FleetError;
    }
    expect(err).toBeInstanceOf(FleetError);
    expect((err as FleetError).code).toBe("dispatch-timeout");
    expect((err as FleetError).payload?.step).toBe("create");
    const runId = (err as FleetError).payload?.runId as string;

    // The record exists (the create STARTED — this is not the `left <= 0`
    // pre-check path) and it is joinable.
    expect(readdirSync(store.dir)).toEqual([`${runId}.json`]);
    expect(store.get(runId).requestId).toBe(requestId);
    // The box is still in flight, so the record cannot name one yet — which is
    // precisely why the correlation had to land without waiting for it.
    expect(store.get(runId).vmName).toBeUndefined();

    // Let the abandoned create finish, so nothing is left running into the next
    // test — and the late box gets named on the record and on the line.
    releaseCreate();
    const line = await abandonedLine("create");
    // Both sides named — and pinned independently of the equality, which
    // `undefined === undefined` satisfies: a regression that names NEITHER the
    // abandoned line NOR the record passes vacuously without these shape pins.
    expect(line.vmName).toBeString();
    expect(line.vmName).toMatch(/^qds-/);
    expect(store.get(runId).vmName).toBeString();
    expect(line.vmName).toBe(store.get(runId).vmName);
    expect(store.get(runId).requestId).toBe(requestId);
  });

  test("an ABANDONED clone names the box it filled", async () => {
    // `within("clone")` was the one effectful step with no late-state handler:
    // a repo that landed in the box AFTER the deadline logged
    // `abandoned-step-succeeded` saying a step completed and nothing about
    // WHICH box just got the brief's repository — the same duck-typed casualty
    // the mint and setPublic handlers exist for.
    const { clock, advance } = stepClock();
    let releaseClone: () => void = () => {};
    const cloning = new Promise<void>((r) => {
      releaseClone = r;
    });
    makeDriverExedevCapable();
    const brief = validBrief(); // also creates the manifests dir the roster sits in
    // An EXEDEV-shaped driver delivers the key to the DEFAULT in-box path
    // (`envFileFor` → undefined → app/.env, HOME-relative), which the fake box
    // cannot materialize on the host — every other exedev-shaped fixture here
    // refuses before provisioning, so this is the first test that has to get
    // PAST delivery. Report the mode the script checks for.
    Object.assign(driver, {
      exec: async () => ({ exitCode: 0, stdout: "600\n", stderr: "" }),
    });
    // The clone calls the driver's own fill; hang exactly there.
    Object.assign(driver, {
      fill: async () => {
        await cloning;
      },
    });
    // TWO-STAGE clock spend, same scheme as the abandoned-mint sibling:
    // `ledgerFactory` (below) leaves 30 s so every timer create/mint/deliver
    // arm is far too long for a CI stall to outlive; THIS stub — key delivery,
    // the LAST awaited step before `within("clone")` arms its timer — spends
    // down to 900 ms on its first call. Deliver resolves instantly after it,
    // clearing its own 30 s timer, so `clone` alone holds the short one. The
    // old single 1 s advance gave create/mint/deliver the SAME 1 s, and a stall
    // during any of them flipped which step the refusal named.
    const EARLY_LEFT_MS = 30_000;
    const TARGET_LEFT_MS = 900;
    let execCalls = 0;
    Object.assign(driver, {
      exec: async () => {
        if (execCalls++ === 0) advance(EARLY_LEFT_MS - TARGET_LEFT_MS);
        return { exitCode: 0, stdout: "600\n", stderr: "" };
      },
    });
    writeFileSync(join(dir, "manifests", "roster.yaml"), VALID_ROSTER);

    let err: FleetError | undefined;
    try {
      await dispatch(
        brief,
        deps({
          clock,
          // Stage one of the two-stage spend (see the exec stub above): leave
          // 30 s here, so the steps between admission and clone hold long real
          // timers; the exec stub spends down to the clone timer's remainder.
          ledgerFactory: () => {
            advance(DEFAULT_TIMEOUT_MS - EARLY_LEFT_MS);
            return goodLedger();
          },
        }),
      );
    } catch (e) {
      err = e as FleetError;
    }
    expect(err).toBeInstanceOf(FleetError);
    expect((err as FleetError).code).toBe("dispatch-timeout");
    expect((err as FleetError).payload?.step).toBe("clone");

    releaseClone();
    const line = await abandonedLine("clone");
    expect((line.error as { code?: string }).code).toBe("abandoned-step-succeeded");
    // Shape-pinned before the equality, same as the setPublic sibling: an
    // unnamed box on BOTH sides would pass vacuously.
    expect(line.vmName).toBeString();
    expect(line.vmName).toMatch(/^qds-/);
    expect(line.vmName).toBe(store.get((err as FleetError).payload?.runId as string)?.vmName);
    expect(line.clonedLate).toBeTrue();
  });

  test("an ABANDONED GATE keeps the box's posture honest and names the gate-specific remediation", async () => {
    // T1-6 (round 11): the gate is "the longest await in a dispatch" and was
    // the ONE step with no hanging test — every sibling step's timeout path is
    // pinned, so `within("gate")`'s abandoned-arm (step:"gate" in the payload,
    // the gate-specific late-effect remediation naming "inspect the box
    // directly": a gate outcome reaches NO record this dispatch writes) could
    // regress untested while every sibling stayed green.
    const { clock, advance } = stepClock();
    let releaseGate: () => void = () => {};
    const gating = new Promise<void>((r) => {
      releaseGate = r;
    });
    makeDriverExedevCapable();
    const brief = validBrief(); // also creates the manifests dir the roster sits in
    Object.assign(driver, {
      exec: async () => ({ exitCode: 0, stdout: "600\n", stderr: "" }),
    });
    // The HANG rides the DEPS seam (`deps.setupGate`), not a driver method:
    // with only a driver method assigned, dispatch's default gateFn sees an
    // exedev-shaped driver and calls realSetupGate, whose `driver.boxHost` the
    // FakeDriver lacks — a TypeError, not the timeout this test exists to pin.
    const gatingGate: DispatchDeps["setupGate"] = async () => {
      await gating;
      // Shape-complete for the type; only `ready` is ever read — dispatch has
      // already refused by the time this resolves.
      return {
        ready: true,
        assertions: [],
        debugCommands: [],
        teardownCommand: "bun scripts/fleet.ts teardown never-reached",
        vm: "",
      };
    };
    // TWO-STAGE clock spend, same scheme as the clone sibling: deliver's exec
    // stub spends down to 900 ms on its FIRST call, and everything earlier
    // holds a 30 s timer no CI stall can outlive — so only `gate` holds the
    // short one when its `within` arms.
    const EARLY_LEFT_MS = 30_000;
    const TARGET_LEFT_MS = 900;
    let execCalls = 0;
    Object.assign(driver, {
      exec: async () => {
        if (execCalls++ === 0) advance(EARLY_LEFT_MS - TARGET_LEFT_MS);
        return { exitCode: 0, stdout: "600\n", stderr: "" };
      },
    });
    writeFileSync(join(dir, "manifests", "roster.yaml"), VALID_ROSTER);

    let err: FleetError | undefined;
    try {
      await dispatch(
        brief,
        deps({
          clock,
          setupGate: gatingGate,
          ledgerFactory: () => {
            advance(DEFAULT_TIMEOUT_MS - EARLY_LEFT_MS);
            return goodLedger();
          },
        }),
      );
      failUnreachable();
    } catch (e) {
      if (e instanceof UnexpectedSuccessError) throw e;
      err = e as FleetError;
    }
    expect(err).toBeInstanceOf(FleetError);
    expect(err?.code).toBe("dispatch-timeout");
    expect(err?.payload?.step).toBe("gate");
    const runId = err?.payload?.runId as string;
    expect(runId).toBeString();

    // The abandoned call resolving LATE must still file the abandoned line —
    // `within("gate")` passes no describeLate (a gate result reaches no record),
    // so the line carries no vmName; the pin is that it EMERGES at all, with
    // the success marker, after dispatch has already rejected.
    releaseGate();
    const line = await abandonedLine("gate");
    expect((line.error as { code?: string }).code).toBe("abandoned-step-succeeded");
    // The record keeps the box named even though the late line does not.
    expect(store.get(runId)?.vmName).toBeString();
    // AC4: the refusal filed exactly one joinable error line, and it names the
    // dispatch's correlation id — recovered from the record the create step
    // persisted, since `requestId` here is dispatch-generated (none injected).
    const refused = expectSingleRefusalLine("dispatch-timeout");
    // The correlation was stamped on the record during the create step; the
    // assertion fails loudly if either side lost it.
    expect(refused.requestId).toBe(store.get(runId).requestId as string);
  });

  test("INV-6: a long host label is redacted without mangling the URL, and userinfo never survives", async () => {
    // The host arm sliced the string: `/[^/]{16,}/` matched the `//host` run
    // itself, so `https://abcdefghijklmnopq` came out as `https:/«redacted»` —
    // a malformed single-slash URL, losing the stated guarantee that the scheme
    // and host survive so an operator can tell WHICH box the line is about.
    // Conversely `tok@x.io` is one short segment, so userinfo passed the 16-char
    // floor untouched — and length is not a property of a credential.
    const thrown =
      "create failed: https://abcdefghijklmnopq/vm and https://tok@short.io/vm";
    driver.create = async () => {
      throw new Error(thrown);
    };

    try {
      await dispatch(validBrief(), deps());
      failUnreachable();
    } catch (e) {
      if (e instanceof UnexpectedSuccessError) throw e;
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
      // And the record — the sink that outlives the process — carries neither.
      const record = store.get(err.payload?.runId as string);
      const recordJson = JSON.stringify(record);
      expect(recordJson).not.toContain("abcdefghijklmnopq");
      expect(recordJson).not.toContain("tok@");
    }
    // POSITIVE CONTROL + the same sink-set audit its short-token sibling runs:
    // every assertion above is an absence proof, vacuous over a message that
    // never carried the host label or over a dispatch that emitted no lines.
    expect(thrown).toContain("abcdefghijklmnopq");
    expect(thrown).toContain("tok@");
    expect(entries.length).toBeGreaterThan(0);
    for (const needle of ["abcdefghijklmnopq", "tok@"] as const) {
      expect(
        entries.filter((e) => JSON.stringify(e).includes(needle)).map((e) => e.operation),
      ).toEqual([]);
      // The persisted copy is the one that outlives the process (AC4 evidence).
      expect(readFileSync(join(dir, "dispatch-log.jsonl"), "utf8")).not.toContain(needle);
    }
  });

  // ─── assertFleetRunId: the one refusal built without `refuse` ────────────────────────

  test("INV-6: a too-long run id is echoed BOUNDED, not swallowed whole by the redactor", async () => {
    // `assertFleetRunId` is the fleet's single enforcement point for the run-id
    // grammar (`scripts/fleet.ts`'s verbs and `statusRun` both route through
    // it), and the ONE refusal in the module built directly rather than through
    // `refuse` — so `refuse`'s INV-6 pass never ran over it and the store's
    // message echoes raw argv.
    //
    // Composing `redact` over that message closes the leak and opens a
    // usability hole in the same move: `redactSecrets` eats any ≥40-char run
    // that is not a hex digest, so a fat-fingered 96-character argument came
    // back as `invalid run id: "«redacted»" (must match …)` — correct, and
    // unactionable. The bounded suffix is what makes it answerable: a short
    // HEAD (12 chars, under the redactor's 40-char floor) plus the LENGTH
    // answers "which argument did I get wrong" and reconstructs no key.
    const supplied = "Q".repeat(96);
    try {
      assertFleetRunId(supplied);
      failUnreachable();
    } catch (e) {
      if (e instanceof UnexpectedSuccessError) throw e;
      expect(e).toBeInstanceOf(FleetError);
      const err = e as FleetError;
      expect(err.exitCode).toBe(2);
      expect(err.code).toBe("invalid-run-id");
      // The WHOLE message, exactly: the store's own grammar and cap, the
      // redacted echo, and the bounded suffix appended after it. Asserted in
      // full because each half has failed on its own — an unredacted echo, then
      // a redaction that ate the entire diagnosis.
      expect(err.message).toBe(
        `invalid run id: "«redacted»" (must match ^[a-z0-9]([a-z0-9-]*[a-z0-9])?$ and be <= 63 chars) — supplied: "${"Q".repeat(12)}…" (96 chars)`,
      );
      // Bounded means bounded: no copy of the 96-character argument survives
      // anywhere in the refusal.
      expect(err.message).not.toContain(supplied);
      expect(JSON.stringify(err.payload ?? {})).not.toContain(supplied);
    }
  });

  test("INV-6: a SHORT pasted secret in the run-id position is spliced out of the store's echo", async () => {
    // The sibling above covers the ≥40-char arm, where `redactSecrets` eats the
    // store's verbatim echo at the sinks. UNDER that floor nothing ate it: a
    // 13–39-char pasted key came back INTACT in the envelope a direct call
    // observes (the returned message and payload) — with the bounded suffix
    // repeating it in safe form right next to the leak. So under the floor the
    // bounded form is spliced over the raw echo instead.
    //
    // Scope note (T1-17, round 11): these units observe the ENVELOPE only. The
    // derived sinks ARE covered downstream now, not unclaimed: cli.test.ts's
    // "a run id that fails the grammar…" pins the stderr envelope verbatim for
    // every band, and its CC-9 test ("the log's runId is redacted first, then
    // capped…") pins the log field's redact-then-cap on the same input class.
    // A sink-side regression that re-echosed unredacted payload fails THERE;
    // this file's comment previously said no such coverage existed.
    const supplied = "s3cr3t-Token-abc"; // 16 chars; uppercase fails the run-id grammar
    expect(supplied.length).toBeLessThan(40);
    try {
      assertFleetRunId(supplied);
      failUnreachable();
    } catch (e) {
      if (e instanceof UnexpectedSuccessError) throw e;
      const err = e as FleetError;
      expect(err.exitCode).toBe(2);
      expect(err.code).toBe("invalid-run-id");
      // The WHOLE message: bounded head plus length IN the grammar sentence,
      // no appended suffix to duplicate it.
      expect(err.message).toBe(
        `invalid run id: "s3cr3t-Token…" (16 chars) (must match ^[a-z0-9]([a-z0-9-]*[a-z0-9])?$ and be <= 63 chars)`,
      );
      // And no full-length copy of the argument anywhere.
      expect(err.message).not.toContain(supplied);
      expect(JSON.stringify(err.payload ?? {})).not.toContain(supplied);
    }
  });

  test("INV-6: a management URL in the run-id position is redacted, path and all", async () => {
    // The path this refusal used to bypass entirely. An operator who pastes a
    // provisioning/management URL into the run-id argument had it echoed — in
    // this envelope (the message) and, downstream of it, on the CLI's stderr
    // line and dispatch-log entry — with its path intact. Only the envelope half
    // is observable from a direct call; the composition under test here is what
    // both sinks inherit. `redactSecrets` alone does not carry the whole-segment
    // URL rule, so only composing `redact` catches it. The 32-char tail is under
    // nothing's length floor as a path segment; length is not a property of a
    // secret.
    const url = `https://mgmt.example.com/keys/${"a".repeat(32)}`;
    try {
      assertFleetRunId(url);
      failUnreachable();
    } catch (e) {
      if (e instanceof UnexpectedSuccessError) throw e;
      const err = e as FleetError;
      expect(err.exitCode).toBe(2);
      expect(err.code).toBe("invalid-run-id");
      // Scheme and host survive — an operator has to know which substrate they
      // pasted — and EVERY path segment goes, not just the long one.
      expect(err.message).toContain("https://mgmt.example.com/«redacted»/«redacted»");
      expect(err.message).not.toContain("keys");
      expect(err.message).not.toContain("a".repeat(32));
    }
  });

  test("a pre-provision refusal names NO teardown command — nothing was provisioned", async () => {
    // The remediation was gated on `ctxRunId !== null`, which is set inside the
    // mint-collision loop — before the admission gates and before store.create.
    // Every refusal from step 4 on therefore handed a tier-1 agent
    // `fleet teardown <id>` for an id with no record.
    try {
      await dispatch(validBrief(), deps({ ledgerFactory: () => overBudgetLedger() }));
      failUnreachable();
    } catch (e) {
      if (e instanceof UnexpectedSuccessError) throw e;
      const err = e as FleetError;
      expect(err.exitCode).toBe(5);
      expect(err.code).toBe("budget-exceeded");
      // The id is still reported — it is this dispatch's own, and the log line
      // joins on it. The COMMANDS are what must not be there.
      //
      // The minted SHAPE, not `toBeString()`: `""`, `"unknown"` and the last
      // COLLIDING id from the mint loop (which belongs to someone else's live
      // run) are all strings, and the structured line joins on this value.
      expect(err.payload?.runId).toMatch(/^qds-\d{8}-[a-f0-9]{6}$/);
      // The same id the structured line carries — one refusal, one id.
      expect((refusalLines()[0] as LogEntry).runId).toBe(err.payload?.runId as string);
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
      failUnreachable();
    } catch (e) {
      if (e instanceof UnexpectedSuccessError) throw e;
      const err = e as FleetError;
      expect(err.exitCode).toBe(1);
      expect(err.code).toBe("expose-no-url");
      expect(err.payload?.port).toBe(8080);
      // INV-5: the box is alive and the record open, so the refusal carries the
      // operator's commands — for THIS run. `toBeString()` was satisfied by a
      // command naming a different run's id, and a tier-1 agent runs what this
      // field says: it would tear down someone else's live box and leave this
      // one billing.
      const runId = err.payload?.runId as string;
      expect(runId).toMatch(/^qds-\d{8}-[a-f0-9]{6}$/);
      expect(err.payload?.teardownCommand).toBe(`bun scripts/fleet.ts teardown ${runId}`);
      expect(err.payload?.debugCommands).toEqual([`bun scripts/fleet.ts status ${runId}`]);
    }
    expect(setPublicCalls).toBe(0);
    // The port claim is KEPT, which is the opposite of what this test used to
    // assert. `expose` RESOLVED here — it just resolved nothing — so unlike the
    // throwing-expose case above there is every reason to think the tunnel was
    // opened; a driver returning no URL is violating a `Promise<string>`
    // signature, not reporting a no-op. Retracting on that reading is the
    // dangerous direction: the record then denies a port the box is listening
    // on, and a port-keyed reaper skips a run that is burning money. Over-claim
    // a port and the worst case is a reaper looking at a box twice.
    //
    // It contradicts nothing the refusal says: EXPOSED is not PUBLIC, and
    // `setPublicCalls === 0` above is what makes "ALIVE but NOT public" true.
    expectSingleRefusalLine("expose-no-url");
    const files = readdirSync(store.dir);
    expect(files).toHaveLength(1);
    const record = store.get((files[0] as string).replace(/\.json$/, ""));
    expect(record.ports).toEqual([8080]);
    // The URL never lands, because none was ever established — that half of the
    // claim is unchanged, and it is what the refusal is FOR.
    expect(record.httpsUrl).toBeUndefined();
  });

  for (const [label, exposedUrl] of [
    ["an EMPTY", ""],
    ["a WHITESPACE-ONLY", "   "],
  ] as const) {
    test(`expose resolving ${label} URL refuses expose-no-url — a string is not an address`, async () => {
      // driver.ts normalizes blank URLs away at ITS boundary (`address`), so a
      // blank could only reach this guard through a driver that skips that
      // helper. The guard used to admit it: `""` is a string, so the box went
      // PUBLIC with the record carrying `httpsUrl: ""` — which every reader
      // treats as absent. A publicly reachable box, locatable nowhere.
      let setPublicCalls = 0;
      driver.expose = async () => exposedUrl;
      driver.setPublic = async () => {
        setPublicCalls += 1;
      };

      try {
        await dispatch(validBrief(), deps({ port: 8080 }));
        failUnreachable();
      } catch (e) {
        if (e instanceof UnexpectedSuccessError) throw e;
        const err = e as FleetError;
        // The SAME refusal the undefined arm gives — same code, same family.
        expect(err.exitCode).toBe(1);
        expect(err.code).toBe("expose-no-url");
        expect(err.payload?.port).toBe(8080);
        expect(err.remediation).toContain("NOT public");
      }
      expectSingleRefusalLine("expose-no-url");
      // setPublic never ran: INV-5 keeps the box private until an address exists.
      expect(setPublicCalls).toBe(0);
      // The port claim is RETAINED, exactly as for the undefined arm: `expose`
      // RESOLVED, so the port is real even where the address is not.
      const files = readdirSync(store.dir);
      expect(files).toHaveLength(1);
      const record = store.get((files[0] as string).replace(/\.json$/, ""));
      expect(record.ports).toEqual([8080]);
      // And the unusable address never lands on the record either — the guard
      // throws before that write.
      expect(record.httpsUrl).toBeUndefined();
    });
  }

  test("a setPublic failure KEEPS the port claim — the port is open, whatever setPublic did", async () => {
    // The retraction's blind spot: it fired for any non-timeout error, and by
    // the time `setPublic` can fail, `expose` has already resolved a URL and the
    // record already carries it. Retracting there left `httpsUrl` set beside an
    // EMPTY `ports` on the same record — self-contradictory — while the box sat
    // listening on 8080. `fleet status` reported no port and port-keyed reapers
    // missed it entirely, which is the exact under-reporting the pre-claim two
    // steps earlier exists to prevent.
    driver.setPublic = async () => {
      throw Object.assign(new Error("substrate refused to publish"), { code: "EACCES" });
    };

    try {
      await dispatch(validBrief(), deps({ port: 8080 }));
      failUnreachable();
    } catch (e) {
      if (e instanceof UnexpectedSuccessError) throw e;
      const err = e as FleetError;
      expect(err.code).toBe("dispatch-failed");
      expect(err.payload?.providerCode).toBe("EACCES");
      const record = store.get(err.payload?.runId as string);
      // Both halves, together: the port the box really has, and the URL expose
      // really returned. Asserting `ports` alone would pass on a record that had
      // dropped the URL instead — and an https ADDRESS, not merely some string:
      // `""` or a bare hostname satisfies `toBeString` while locating nothing.
      expect(record.ports).toEqual([8080]);
      expect(record.httpsUrl).toMatch(/^https:\/\//);
    }
    expectSingleRefusalLine("dispatch-failed");
  });

  // ─── DF2.13: the derived cap is what reaches the mint ────────────────────────

  describe("DF2.13: the derived cap is what reaches the mint", () => {
    test("AC1: the admitted ceiling, not the issue cap and not the key backstop, is the limit the mint is asked for", async () => {
      // Ceiling ≠ cap on purpose (the AC9b confusion), and the ceiling is ALSO
      // below defaultKeyCapMicroUsd — so the three candidate figures are all
      // distinct and a dispatcher propagating any of the two wrong ones fails.
      // This is the AC5 pin that "the dispatch path never exercises it: the
      // `capMicroUsd` reaching `mintRunKey` from `dispatch` is always defined"
      // riding the same path: 50.0 below is the failure a fallback to the
      // default cap would produce.
      const admittedCeiling = 1_000_000;
      const cap = 5_000_000;
      const ledger = goodLedger(admittedCeiling, cap);
      const originalMint = keyApi.createKey.bind(keyApi);
      const mintSpy = mock((name: string, limit: number) => originalMint(name, limit));
      keyApi.createKey = mintSpy;

      await dispatch(validBrief(), deps({ ledgerFactory: () => ledger }));

      expect(mintSpy).toHaveBeenCalledTimes(1);
      const [, limitArg] = mintSpy.mock.calls[0] as [string, number];
      expect(limitArg).toBe(admittedCeiling / 1_000_000);
      expect(limitArg).not.toBe(5.0); // the issue cap, ÷1e6
      expect(limitArg).not.toBe(50.0); // defaultKeyCapMicroUsd, ÷1e6 — the backstop
      // The value propagated is the DECISION's own output: what the gate was
      // handed is what went out. `RecordingLedger`'s returned decision stands
      // in for the gate_admissions row at this seam — the real-row equality is
      // proven against a live SQLite ledger in budget-gate.test.ts.
      const call = ledger.admitCalls[0] as (typeof ledger.admitCalls)[number];
      expect(call.capMicroUsd).toBe(cap);
      // No deps.capMicroUsd supplied, so the gate's clamp ran against the
      // DF2.3 backstop — same figure the AC7 hand-off test pins.
      expect(call.keyCapMicroUsd).toBe(defaultKeyCapMicroUsd);
    });

    test("AC2: the remainder binds without --cap, the policy ceiling binds with one — both directions of the min", async () => {
      // (a) No --cap: the issue's remaining spend (the ceiling) is smaller than
      // the 50M key backstop, so the REMAINDER is the binding half.
      const remainderLedger = goodLedger(1_000_000, 5_000_000);
      const originalMintA = keyApi.createKey.bind(keyApi);
      const mintA = mock((name: string, limit: number) => originalMintA(name, limit));
      keyApi.createKey = mintA;
      await dispatch(validBrief(), deps({ ledgerFactory: () => remainderLedger }));

      const [, limitA] = mintA.mock.calls[0] as [string, number];
      expect(limitA).toBe(1.0);
      const callA = remainderLedger.admitCalls[0] as (typeof remainderLedger.admitCalls)[number];
      expect(callA.capMicroUsd).toBe(5_000_000);
      expect(callA.keyCapMicroUsd).toBe(defaultKeyCapMicroUsd);

      // (b) deps.capMicroUsd supplied below the issue cap: the POLICY ceiling
      // is the binding half, and the mint is asked for IT, not the 50M cap.
      const policyLedger = goodLedger(10_000_000, 50_000_000);
      const originalMintB = keyApi.createKey.bind(keyApi);
      const mintB = mock((name: string, limit: number) => originalMintB(name, limit));
      keyApi.createKey = mintB;
      await dispatch(validBrief(), deps({ ledgerFactory: () => policyLedger, capMicroUsd: 10_000_000 }));

      const [, limitB] = mintB.mock.calls[0] as [string, number];
      expect(limitB).toBe(10.0);
      expect(limitB).not.toBe(50.0);
      const callB = policyLedger.admitCalls[0] as (typeof policyLedger.admitCalls)[number];
      expect(callB.capMicroUsd).toBe(50_000_000);
      expect(callB.keyCapMicroUsd).toBe(10_000_000);
    });

    test("AC4: a per-run cap above the backstop refuses PRE-ADMISSION at the dispatch boundary — no box, no record, no admission", async () => {
      // DF2.14 retired the stranding class this test used to pin ("reaches the
      // mint and is refused there — stranding a real box"): B1 now bounds
      // `deps.capMicroUsd` at `defaultKeyCapMicroUsd` before the budget gate
      // runs, so an over-backstop cap never admits, never provisions, never
      // writes a record. The derivation is BEHAVIORAL, not textual: the bound
      // under test is the imported constant, so raising the backstop moves this
      // test's boundary instead of silently forking it — and B1 is never
      // reverted to keep an old stranding pin green.
      const overBackstop = defaultKeyCapMicroUsd + 1;
      const createSpy = mock(() => Promise.resolve({ name: "test", status: "running" } as ProviderVm));
      driver.create = createSpy;
      const originalMint = keyApi.createKey.bind(keyApi);
      const mintSpy = mock((name: string, limit: number) => originalMint(name, limit));
      keyApi.createKey = mintSpy;
      const ledger = goodLedger(overBackstop, overBackstop);
      const admitsBefore = ledger.admitCalls.length;

      try {
        await dispatch(
          validBrief(),
          deps({
            capMicroUsd: overBackstop,
            ledgerFactory: () => ledger,
          }),
        );
        failUnreachable();
      } catch (e) {
        if (e instanceof UnexpectedSuccessError) throw e;
        const err = e as FleetError;
        expect(err.exitCode).toBe(2);
        expect(err.code).toBe("invalid-cap");
        // The refusal names the knob and the code change that owes a test.
        expect(err.message).toContain("defaultKeyCapMicroUsd");
        expect(err.remediation).toContain("src/providers/credentials.ts");
        // Both figures ride the payload: the refused cap and the backstop.
        expect(err.payload?.capMicroUsd).toBe(overBackstop);
        expect(err.payload?.backstopMicroUsd).toBe(defaultKeyCapMicroUsd);
        // PRE-admission: the gate never ran, no key was asked for.
        expect(ledger.admitCalls.length).toBe(admitsBefore);
        expect(mintSpy).not.toHaveBeenCalled();
      }
      // The old test's stranding reality is exactly what must NOT happen now:
      // zero boxes provisioned, zero run records written.
      expect(createSpy).not.toHaveBeenCalled();
      expect(readdirSync(store.dir)).toHaveLength(0);
    });

    test("AC4: a cap AT the backstop passes the boundary and reaches the mint as the keyCap", async () => {
      // The inclusive boundary leg of the same derivation: defaultKeyCapMicroUsd
      // itself is legal at every layer (B1, the gate's min, the mint guard),
      // and it is the keyCap the mint is asked for when it binds.
      const originalMint = keyApi.createKey.bind(keyApi);
      const mintSpy = mock((name: string, limit: number) => originalMint(name, limit));
      keyApi.createKey = mintSpy;
      const ledger = goodLedger(defaultKeyCapMicroUsd, defaultKeyCapMicroUsd);

      await dispatch(
        validBrief(),
        deps({
          capMicroUsd: defaultKeyCapMicroUsd,
          ledgerFactory: () => ledger,
        }),
      );

      const [, limitArg] = mintSpy.mock.calls[0] as [string, number];
      expect(limitArg).toBe(defaultKeyCapMicroUsd / 1_000_000);
      const admit = ledger.admitCalls[0] as (typeof ledger.admitCalls)[number];
      expect(admit.capMicroUsd).toBe(defaultKeyCapMicroUsd);
      expect(admit.keyCapMicroUsd).toBe(defaultKeyCapMicroUsd);
    });

    test("D2: a STRUCTURED mint error (ProviderError family) keeps its message AND its composed remediation at the step-7 catch", async () => {
      // The step-7 catch used to discriminate on `instanceof FleetError`, so a
      // `CredentialLifecycleError` — the ProviderError family's `{code,
      // remediation}` shape, NOT a FleetError — was flattened to the generic
      // text plus the INV-5 line, and the diagnosis written for the refusal
      // shipped nowhere but `payload.providerCode`. Capability-based now
      // (DF2.14): the message survives (suffixed with the run context, the
      // same pattern the FleetError branch uses) and the remediation is
      // COMPOSED — structured first, INV-5 second, neither dropped.
      const structured = new CredentialLifecycleError(
        "cap-invalid",
        "capMicroUsd 90000000 exceeds the backstop defaultKeyCapMicroUsd (50000000) — refusing to mint a key above the provider ceiling",
        "lower capMicroUsd to the working ceiling, or raise defaultKeyCapMicroUsd in src/providers/credentials.ts — a code change that owes a test naming it",
      );
      keyApi.createKey = async () => {
        throw structured;
      };
      const ledger = goodLedger();

      try {
        await dispatch(validBrief(), deps({ ledgerFactory: () => ledger }));
        failUnreachable();
      } catch (e) {
        if (e instanceof UnexpectedSuccessError) throw e;
        const err = e as FleetError;
        expect(err.exitCode).toBe(1);
        // The mapping is UNCHANGED: a non-FleetError is still
        // key-delivery-failed, and the exit code stays 1.
        expect(err.code).toBe("key-delivery-failed");
        // The provider's message survives, suffixed with the run context.
        expect(err.message).toContain("exceeds the backstop defaultKeyCapMicroUsd");
        expect(err.message).toContain("during key mint or delivery for run");
        // COMPOSED remediation: the structured half first, INV-5 second.
        expect(err.remediation).toContain("lower capMicroUsd to the working ceiling");
        expect(err.remediation).toContain("raise defaultKeyCapMicroUsd in src/providers/credentials.ts");
        expect(err.remediation).toContain("run record is OPEN and the box is ALIVE");
        // The provider code still rides the payload as diagnosis.
        expect(err.payload?.providerCode).toBe("cap-invalid");
        // INV-5 posture unchanged: the box exists and the record is open.
        const runId = err.payload?.runId as string;
        expect(store.get(runId).closedAt).toBeUndefined();
      }
    });

    test("AC5: a ledgerFactory that THROWS refuses admission-failed and never mints", async () => {
      const createSpy = mock(() => Promise.resolve({ name: "test", status: "running" } as ProviderVm));
      driver.create = createSpy;
      const originalMintA = keyApi.createKey.bind(keyApi);
      const mintSpy = mock((name: string, limit: number) => originalMintA(name, limit));
      keyApi.createKey = mintSpy;

      try {
        await dispatch(
          validBrief(),
          deps({
            ledgerFactory: () => {
              throw new Error("factory exploded");
            },
          }),
        );
        failUnreachable();
      } catch (e) {
        if (e instanceof UnexpectedSuccessError) throw e;
        expect(e).toBeInstanceOf(FleetError);
        const err = e as FleetError;
        expect(err.exitCode).toBe(5);
        expect(err.code).toBe("admission-failed");
      }
      expect(createSpy).not.toHaveBeenCalled();
      // No path falls back to defaultKeyCapMicroUsd on the way out.
      expect(mintSpy).not.toHaveBeenCalled();
      expect(readdirSync(store.dir)).toHaveLength(0);
    });

    test("AC5: a typed CostLedgerError from the gate refuses ledger-failed and never mints", async () => {
      // `admitThrowsLedger()` throws a RAW Error, which lands in the
      // admission-failed arm the two tests above and AC7's own already pin;
      // the ledger-failed code is the TYPED arm, so this fixture throws the
      // typed error the way AC7's sibling does.
      const ledger = goodLedger();
      ledger.admitIssue = () => {
        throw new CostLedgerError("ledger-schema-mismatch", "schema drifted under the gate", "migrate, then retry");
      };
      const createSpy = mock(() => Promise.resolve({ name: "test", status: "running" } as ProviderVm));
      driver.create = createSpy;
      const originalMintC = keyApi.createKey.bind(keyApi);
      const mintSpy = mock((name: string, limit: number) => originalMintC(name, limit));
      keyApi.createKey = mintSpy;

      try {
        await dispatch(validBrief(), deps({ ledgerFactory: () => ledger }));
        failUnreachable();
      } catch (e) {
        if (e instanceof UnexpectedSuccessError) throw e;
        expect(e).toBeInstanceOf(FleetError);
        const err = e as FleetError;
        expect(err.exitCode).toBe(5);
        expect(err.code).toBe("ledger-failed");
        expect(err.payload?.providerCode).toBe("ledger-schema-mismatch");
      }
      expect(createSpy).not.toHaveBeenCalled();
      expect(mintSpy).not.toHaveBeenCalled();
      expect(readdirSync(store.dir)).toHaveLength(0);
    });

    test("AC5: an over-budget issue refuses budget-exceeded and never mints", async () => {
      const createSpy = mock(() => Promise.resolve({ name: "test", status: "running" } as ProviderVm));
      driver.create = createSpy;
      const originalMintD = keyApi.createKey.bind(keyApi);
      const mintSpy = mock((name: string, limit: number) => originalMintD(name, limit));
      keyApi.createKey = mintSpy;

      try {
        await dispatch(validBrief(), deps({ ledgerFactory: () => overBudgetLedger() }));
        failUnreachable();
      } catch (e) {
        if (e instanceof UnexpectedSuccessError) throw e;
        expect(e).toBeInstanceOf(FleetError);
        const err = e as FleetError;
        expect(err.exitCode).toBe(5);
        expect(err.code).toBe("budget-exceeded");
      }
      expect(createSpy).not.toHaveBeenCalled();
      expect(mintSpy).not.toHaveBeenCalled();
      expect(readdirSync(store.dir)).toHaveLength(0);
    });
  });

  // ─── DF5.3: the hop-5 links this dispatch is the composition root for ───────

  /**
   * `dispatch()` opens the audit store ITSELF — there is no `recordAuditLink`
   * seam on `DispatchDeps` to capture, which is why every one of these reads the
   * real store at `auditDb.path()`. Before this block existed, deleting any of
   * the five emits below left the whole fleet suite green and the chain would
   * have reported `unlinked` for every real run.
   */
  describe("DF5.3: audit links (hop 5)", () => {
    /** The links one successful dispatch owes, in the order it owes them. */
    const HOP5_SEQUENCE = [
      "run-box/create",
      "run-credential/mint",
      "run-credential/deliver",
      "run-box/fill",
      "run-box/setup-gate",
    ];

    /** A gate whose result shape is fixed, so `detail` is deterministic. */
    const twoAssertionGate = async (
      _d: ProviderDriver,
      vm: string,
    ): Promise<SetupGateResult> => ({
      ready: true,
      assertions: [
        { item: "A" as const, ok: true, note: "" },
        { item: "B" as const, ok: true, note: "" },
      ],
      debugCommands: [],
      teardownCommand: `td ${vm}`,
      vm,
    });

    test("a successful dispatch writes the FULL hop-5 set, in order, attributed to the run", async () => {
      const result = await dispatch(validBrief(), deps({ setupGate: twoAssertionGate }));
      const vmName = store.get(result.runId).vmName as string;

      const rows = auditRows(result.runId);
      expect(rows.map((r) => `${r.hop}/${r.event}`)).toStrictEqual(HOP5_SEQUENCE);
      // ONE attribution for the whole set (C6) and one correlation (INV-4-bis):
      // three emitters on three different call paths, and a chain that cannot
      // join them is a chain that reports `unlinked`.
      expect(new Set(rows.map((r) => r.repoSlug))).toStrictEqual(new Set(["owner/repo"]));
      expect(new Set(rows.map((r) => r.requestId))).toStrictEqual(new Set([result.requestId]));
      expect(new Set(rows.map((r) => r.runId))).toStrictEqual(new Set([result.runId]));
      // The box links name the BOX; the credential links name the key HASH —
      // a subject swap between the two hops is what makes a walk unjoinable.
      for (const r of rows.filter((r) => r.hop === "run-box")) {
        expect(r.subjectKind).toBe("box");
        expect(r.subjectId).toBe(vmName);
      }
      for (const r of rows.filter((r) => r.hop === "run-credential")) {
        expect(r.subjectKind).toBe("credential-key");
        expect(r.subjectId).toBe(store.get(result.runId).keyHash as string);
      }

      // The gate link's own payload — the summary the audit row is FOR.
      const gateRow = rows.find((r) => r.event === "setup-gate") as AuditLinkRow;
      expect(gateRow.detail).toStrictEqual({ ready: true, assertions: 2 });
      // INV-4: a link row is an operator-visible sink like any other.
      expect(JSON.stringify(rows)).not.toContain(SBX_KEY_PREFIX);
    });

    test("setup-gate detail OMITS `assertions` when the gate returned a non-array — absence, never 0", async () => {
      // `0` means "the gate ran no assertions"; absence means "the gate did not
      // report a countable list". An audit row that cannot tell the two apart
      // reads the safer of them.
      const result = await dispatch(
        validBrief(),
        deps({
          setupGate: async (_d: ProviderDriver, vm: string) =>
            ({
              ready: true,
              assertions: undefined,
              debugCommands: [],
              teardownCommand: `td ${vm}`,
              vm,
            }) as unknown as SetupGateResult,
        }),
      );
      const gateRow = auditRows(result.runId).find((r) => r.event === "setup-gate") as AuditLinkRow;
      expect(gateRow.detail).toStrictEqual({ ready: true });
      expect(Object.keys(gateRow.detail as object)).not.toContain("assertions");
    });

    test("a FAILED gate writes NO setup-gate link — the links stop at run-box/fill", async () => {
      // The other half of the success case above, and the one that matters:
      // `setup-gate` is the row the walker reads as "the gate PROVED this box".
      // Hoisting the emit above the refusal — or into a `finally` — would write
      // it for every failed gate, so an unproven box would chain as
      // linked-and-ready. The success path pins presence and the unattributed
      // path pins global absence; neither can catch that move.
      //
      // The links that PRECEDED the gate must still be there: this is "the gate
      // did not vouch", not "the run emitted nothing".
      try {
        await dispatch(
          validBrief(),
          deps({
            setupGate: async (_d: ProviderDriver, vm: string) => ({
              ready: false,
              failedItem: "A" as const,
              assertions: [{ item: "A" as const, ok: false, note: "the box said no" }],
              debugCommands: [`inspect ${vm}`],
              teardownCommand: `td ${vm}`,
              vm,
            }),
          }),
        );
        failUnreachable();
      } catch (e) {
        if (e instanceof UnexpectedSuccessError) throw e;
        expect((e as FleetError).exitCode).toBe(3);
        expect((e as FleetError).code).toBe("setup-gate-failed");
      }
      const runId = expectSingleRefusalLine("setup-gate-failed").runId as string;
      expect(typeof runId).toBe("string");
      expect(auditRows(runId).map((r) => `${r.hop}/${r.event}`)).toStrictEqual(
        HOP5_SEQUENCE.slice(0, HOP5_SEQUENCE.indexOf("run-box/setup-gate")),
      );
    });

    test("an UNATTRIBUTED run emits NO hop-5 links at all — never fill/setup-gate with no create", async () => {
      // A `fill` and a `setup-gate` with no `create` reads as "the box was
      // filled before it was created". All three sites take the SAME slug, from
      // the record, so they skip together (C6). Here the budget extension never
      // reaches the record, which is the only source `auditRepoSlug` may use.
      // No restore needed: `beforeEach` rebuilds `store` fresh.
      const realSet = store.set.bind(store);
      store.set = (id: string, patch: Parameters<RunRecordStore["set"]>[1]) =>
        // The write happens; the budget attribution just is not in it.
        realSet(id, "extensions" in patch ? {} : patch);

      const result = await dispatch(validBrief(), deps({ setupGate: twoAssertionGate }));

      expect(result.state).toBe("ready");
      // The store was opened (the dispatch ran), it just has nothing to say.
      expect(existsSync(auditDb.path())).toBeTrue();
      expect(auditRows(result.runId)).toStrictEqual([]);
    });

    test("a dispatch refused BEFORE the open creates no store file at all", async () => {
      // The open is fail-closed and sits after admission, right before the
      // create — so a brief refused at the boundary must not so much as bring
      // the store into existence. Production claims this; nothing asserted it.
      try {
        await dispatch(validBrief(), deps({ timeoutMs: 0 }));
        failUnreachable();
      } catch (e) {
        if (e instanceof UnexpectedSuccessError) throw e;
        expect((e as FleetError).code).toBe("timeout-invalid");
      }
      expect(existsSync(auditDb.path())).toBeFalse();
      expect(existsSync(dirname(auditDb.path()))).toBeTrue(); // the parent was ours all along
    });

    test("an unopenable store refuses audit-store-unavailable at exit 1 — no box, no record, no mint", async () => {
      // Fail-closed: a run whose box/credential links cannot be written is a run
      // the chain can never vouch for, so it refuses instead of provisioning an
      // unlinked box. Shipped with no test at all.
      //
      // The fault is induced by GEOMETRY, not by permissions: the store's parent
      // is an ordinary FILE, so `mkdirSync(dirname(path))` fails EEXIST/ENOTDIR
      // for every uid. `chmodSync(sealed, 0o500)` was the previous injection and
      // it is a no-op for root — DAC is bypassed, `openAuditStore` succeeds, the
      // dispatch provisions and this test fails naming the fail-closed path as
      // regressed when the only thing that changed was the uid. This repo's CI
      // is a Docker container, i.e. exactly where that happens; `skipIf(uid===0)`
      // would have skipped the test precisely where it runs. Nothing to restore
      // either, so the assertions below need no wrapper to keep `afterAll`'s
      // sweep of `tmpRoot` working.
      const notADir = join(outsideDir, "not-a-directory");
      writeFileSync(notADir, "the audit store's parent is a regular file");
      process.env.QDS_AUDIT_DB = join(notADir, "audit.db");
      const createSpy = mock(() => Promise.resolve({ name: "x", status: "running" } as ProviderVm));
      driver.create = createSpy;
      const originalMint = keyApi.createKey.bind(keyApi);
      const mintSpy = mock((name: string, limit: number) => originalMint(name, limit));
      keyApi.createKey = mintSpy;

      try {
        await dispatch(validBrief(), deps());
        failUnreachable();
      } catch (e) {
        if (e instanceof UnexpectedSuccessError) throw e;
        expect(e).toBeInstanceOf(FleetError);
        const err = e as FleetError;
        expect(err.exitCode).toBe(1);
        expect(err.code).toBe("audit-store-unavailable");
        // The typed code is NOT re-wrapped by the create→expose classifier, and
        // the remediation names the knob the operator has to turn. C-1 makes
        // this the STORE's own remediation (`openWriterStore`'s fallback arm),
        // not dispatch's generic hint — so this assertion is what keeps the two
        // texts from drifting apart into an operator-facing contradiction.
        expect(err.remediation).toContain("QDS_AUDIT_DB");
      }
      // "so nothing was provisioned" — the refusal's own claim, asserted.
      expect(createSpy).not.toHaveBeenCalled();
      expect(mintSpy).not.toHaveBeenCalled();
      expect(readdirSync(store.dir)).toHaveLength(0);
      expect(await driver.list()).toHaveLength(0);
      expectSingleRefusalLine("audit-store-unavailable");
    });

    test("REGRESSION: a store under a pre-existing directory this process does not own dispatches FINE", async () => {
      // `openAuditStore` used to chmod the store's PARENT unconditionally, so
      // `QDS_AUDIT_DB=/tmp/x.db` refused every dispatch with
      // `audit-store-unavailable: EPERM … chmod '/tmp'` — and would have
      // narrowed /tmp to 0700 for every other user on the host had it succeeded.
      // The fix chmods only a directory the store itself created. This is the
      // kind of bug that comes back, so /tmp is named literally: os.tmpdir() on
      // darwin is a per-user directory this process DOES own, which would not
      // reproduce it.
      const shared = "/tmp";
      const modeBefore = statSync(shared).mode;
      const storePath = join(shared, `qds-df53-shared-parent-${randomUUID()}.db`);
      process.env.QDS_AUDIT_DB = storePath;
      try {
        const result = await dispatch(validBrief(), deps({ setupGate: twoAssertionGate }));
        expect(result.state).toBe("ready");
        expect(existsSync(storePath)).toBeTrue();
        const handle = openAuditStoreForWalk(storePath);
        try {
          expect(handle.linksForRun(result.runId).map((r) => `${r.hop}/${r.event}`)).toStrictEqual(
            HOP5_SEQUENCE,
          );
        } finally {
          handle.close();
        }
        // The other half of the bug: the shared parent is left exactly as found.
        expect(statSync(shared).mode).toBe(modeBefore);
      } finally {
        rmSync(storePath, { force: true });
        // RESTORED, not merely asserted. If the regression comes back AND this
        // process can chmod /tmp (uid 0 in a CI container — this repo's CI),
        // the regressed chmod SUCCEEDS: /tmp is 0700 for the rest of the job and
        // every later test, subprocess and tool that touches it fails for an
        // unrelated-looking reason, burying the one assertion that named the
        // real bug. The assertion above is the diagnosis; this is the cleanup,
        // and it has to be in the `finally` because the assertion throws.
        if (statSync(shared).mode !== modeBefore) chmodSync(shared, modeBefore & 0o7777);
      }
    });

    test("a provisioning refusal still leaves a store that later opens cleanly", async () => {
      // The close-on-refusal fix itself (dispatch opens the store inside the
      // admission single-flight, whose only `finally` releases the lock) has NO
      // observable from out here: a `bun:sqlite` handle's closure is not
      // visible to another connection, and `close()` does not release the
      // descriptor in bun 1.4.0 either (probed), so an fd count cannot stand in
      // for it. What IS assertable is the store's state after the refusal:
      // opened (so this is the path under discussion), empty, and openable.
      driver.create = () => Promise.reject(new Error("provider said no"));
      try {
        await dispatch(validBrief(), deps());
        failUnreachable();
      } catch (e) {
        if (e instanceof UnexpectedSuccessError) throw e;
        expect((e as FleetError).exitCode).toBe(1);
      }
      expect(existsSync(auditDb.path())).toBeTrue();
      // The run id from the REFUSAL LINE, never `readdirSync(store.dir)[0]`:
      // that listing is OS-ordered and shares the directory with `<runId>.lock`
      // and its `.lktmp` reap temporaries, and the old `?? ""` degraded a
      // mismatch into `linksForRun("") === []` — trivially true, so the
      // assertion could not fail.
      const refusedRunId = expectSingleRefusalLine("provision-failed").runId;
      expect(typeof refusedRunId).toBe("string");
      const handle = openAuditStoreForWalk(auditDb.path());
      try {
        expect(handle.linksForRun(refusedRunId as string)).toStrictEqual([]);
      } finally {
        handle.close();
      }
    });

    test("a store fault at the setup-gate emit DROPS the link and the dispatch still succeeds — the box is not burned for audit plumbing", async () => {
      // The expensive half of the fail-closed contract, and the one that was
      // untested: the cheap PRE-provision refusal (above) and the POST-close
      // drop (the abandoned-mint test) were both covered; a `record()` throw on
      // an OPEN store, mid-dispatch, with a live box and a delivered key, was
      // not. It used to become a generic `dispatch-failed` with the box ALIVE
      // and the key DELIVERED — and the operator's natural retry re-spent the
      // issue cap. It is now a logged drop and the run continues; the chain
      // degrades to `unlinked` for that hop, which is recoverable, while an
      // abandoned billing box is not.
      //
      // The fault is induced at the STORE, from a second connection, at the one
      // moment that matters: the gate runs after create/mint/deliver/fill have
      // all emitted, so the box is up and the key is in it. `DROP TABLE` is the
      // "store replaced under the handle" fault in its smallest honest form —
      // it classifies `audit-store-schema-absent`, i.e. NOT `audit-link-invalid`,
      // which is the one code that still propagates.
      const result = await dispatch(
        validBrief(),
        deps({
          setupGate: async (d: ProviderDriver, vm: string) => {
            const saboteur = new Database(auditDb.path());
            try {
              saboteur.exec("DROP TABLE audit_links");
            } finally {
              saboteur.close();
            }
            return twoAssertionGate(d, vm);
          },
        }),
      );

      // The run landed: gate passed, box exposed, ack shaped as ever.
      expect(result.state).toBe("ready");
      expect(await driver.list(result.runId)).toHaveLength(1);
      expect(store.get(result.runId).closedAt).toBeUndefined();
      expect(refusalLines()).toHaveLength(0);

      // …and the dropped link is REPORTED, in the one shape an operator greps.
      const drops = entries.filter((e) => e.phase === "audit-dropped");
      expect(drops).toHaveLength(1);
      const drop = drops[0] as LogEntry;
      expect(drop.step).toBe("setup-gate");
      expect((drop.error as { code?: string }).code).toBe("audit-link-write-failed");
      expect(drop.status).toBe("error");
      expect(drop.exitStatus).toBe("transient");
      // Joinable to the run whose hop is now unlinked.
      expect(drop.runId).toBe(result.runId);
      // INV-4: a drop line is an operator-visible sink like any other.
      expect(JSON.stringify(drop)).not.toContain(SBX_KEY_PREFIX);
    });
  });
});
